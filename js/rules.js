/* ==========================================================================
   FORGE Atelier — js/rules.js
   CB.rules : configuration validation, street legality and option compatibility.

   Public API
   ----------
   CB.rules.validate(build, metrics?, opts?) -> Issue[]
       Issue = { id, rule, severity: 'error'|'warning'|'info', section: <panel id>, path?, title, message,
                 fix?: { label, patch: <partial build> } }
       * `metrics` (CB.physics.compute output) is optional; when absent CB.physics is used if loaded, otherwise
         the built-in estimator (CB.rules.estimate) supplies power / torque / mass / economy figures.
       * Every fix offered is VERIFIED: the patch is applied exactly as CB.state.patch() would apply it
         (deepMerge + CB.state.normalize with the patch's leaf paths) and the rule is re-run on the result.
         Only patches that make the issue disappear are attached. Errors are designed to always have one.
       * opts: { verifyFixes: true, physics: true, severity: 'error'|'warning'|'info' (minimum), section }
   CB.rules.legality(build, metrics?) -> { streetLegal, reasons: string[], details: [{id, path, section, message}],
                                           classification: 'road'|'track', summary }
   CB.rules.compatibleOptions(build, key) -> Set of compatible option ids for a choice path ('engine.layout')
       or catalog collection key ('engineLayouts', 'aero.wings'). The returned Set ALSO carries one own
       enumerable property per option: set[id] === true (compatible) or a string reason (incompatible), so
       consumers that iterate Object.keys() (panels-powertrain.js) get per-option reasons. Argument order
       (key, build) is accepted too.
   CB.rules.optionStatus(build, key) -> [{ id, name, ok, reason }]
   CB.rules.applyFix(build, issueOrPatch) -> new normalized build (same semantics as CB.state.patch)
   CB.rules.estimate(build, metrics?) -> { hp, kw, torque_nm, gearboxTorque_nm, weight_kg, mpg, l100, ... }
   CB.rules.list() -> [{ id, section, severity, title }]  (rule catalogue, > 100 rules)
   CB.rules.count -> number of registered rules

   Sections are panel ids: body, engine, transmission, drivetrain, suspension, brakes, wheels (incl. tyres),
   aero, weight, exterior, interior, tech.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  /* ======================================================================
     SMALL HELPERS (self-contained fallbacks so the module never hard-fails)
     ====================================================================== */
  function D() { return CB.data; }
  function U() { return CB.util || {}; }
  function isObj(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
  function clone(o) {
    if (U().deepClone) return U().deepClone(o);
    return o == null ? o : JSON.parse(JSON.stringify(o));
  }
  function merge(a, b) {
    if (U().deepMerge) return U().deepMerge(a, b);
    var out = isObj(a) ? clone(a) : {};
    Object.keys(b || {}).forEach(function (k) {
      if (b[k] === undefined) return;
      out[k] = isObj(b[k]) && isObj(out[k]) ? merge(out[k], b[k]) : clone(b[k]);
    });
    return out;
  }
  function get(o, path, fb) {
    var ks = String(path).split('.'), cur = o;
    for (var i = 0; i < ks.length; i++) { if (cur == null) return fb; cur = cur[ks[i]]; }
    return cur === undefined ? fb : cur;
  }
  /** Build a nested partial object from a dotted path: patchOf('engine.fuel', 'e85') -> {engine:{fuel:'e85'}} */
  function patchOf(path, value) {
    var ks = String(path).split('.'), root = {}, cur = root;
    for (var i = 0; i < ks.length - 1; i++) { cur[ks[i]] = {}; cur = cur[ks[i]]; }
    cur[ks[ks.length - 1]] = value;
    return root;
  }
  function P() { // merge many path/value pairs into one patch: P('a.b', 1, 'c.d', 2)
    var out = {};
    for (var i = 0; i + 1 < arguments.length; i += 2) out = merge(out, patchOf(arguments[i], arguments[i + 1]));
    return out;
  }
  function leafPaths(obj, prefix, out) {
    out = out || []; prefix = prefix || '';
    if (!isObj(obj)) { if (prefix) out.push(prefix); return out; }
    Object.keys(obj).forEach(function (k) {
      var p = prefix ? prefix + '.' + k : k;
      if (isObj(obj[k])) leafPaths(obj[k], p, out); else out.push(p);
    });
    return out;
  }
  function num(v, fb) { var n = Number(v); return isFinite(n) ? n : (fb === undefined ? 0 : fb); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function r1(n) { return Math.round(n * 10) / 10; }
  function r2(n) { return Math.round(n * 100) / 100; }
  function fmt(n, d) {
    if (U().fmtNum) return U().fmtNum(n, d || 0);
    return Number(n).toFixed(d || 0);
  }
  function oneOf(v, list) { return list.indexOf(v) >= 0; }
  function sameId(a, b) { return a === b || (a != null && b != null && String(a) === String(b)); }
  function find(coll, id) { var d = D(); return d && d.find ? d.find(coll, id) : undefined; }
  function listOf(coll) { var d = D(); return (d && d.list && d.list(coll)) || []; }
  function nameOf(coll, id) { var o = find(coll, id); return o ? o.name : String(id); }
  function hexDist(a, b) {
    var h = U().hexToRgb;
    if (!h) return String(a).toLowerCase() === String(b).toLowerCase() ? 0 : 999;
    var x = h(a), y = h(b);
    if (!x || !y) return 999;
    return Math.sqrt(Math.pow(x.r - y.r, 2) + Math.pow(x.g - y.g, 2) + Math.pow(x.b - y.b, 2));
  }
  function contrastOf(hex) { return U().contrastText ? U().contrastText(hex) : '#ffffff'; }
  function sectionOf(path) {
    var s = String(path || '').split('.')[0];
    if (s === 'tires') return 'wheels';
    if (s === 'meta' || !s) return 'body';
    return s;
  }

  var TEMPLATE = null;
  function template() {
    if (!TEMPLATE && D() && D().defaultBuild) {
      TEMPLATE = D().defaultBuild();
      TEMPLATE.meta = { name: 'Untitled Build', id: 'b_template', created: 0, modified: 0, presetId: null };
    }
    return TEMPLATE || {};
  }

  /** Apply a fix patch exactly like CB.state.patch: deepMerge then normalize with the patch's leaf paths. */
  function applyPatch(build, patch) {
    var raw = merge(build || {}, patch || {});
    var S = CB.state;
    if (S && typeof S.normalize === 'function') {
      try { return S.normalize(raw, { paths: leafPaths(patch || {}), prev: build }); } catch (e) { return raw; }
    }
    return raw;
  }
  function applyFix(build, issueOrPatch) {
    var p = issueOrPatch && issueOrPatch.fix ? issueOrPatch.fix.patch : (issueOrPatch && issueOrPatch.patch ? issueOrPatch.patch : issueOrPatch);
    return applyPatch(build, p || {});
  }

  /* ======================================================================
     ESTIMATOR — physically-motivated quick figures used when CB.physics
     metrics are not provided. Deterministic and cheap (< 0.05 ms).
     ====================================================================== */
  var KW_PER_HP = 0.745699872;
  var MOTOR_BASE_RPM = 4500;          // e-motor base speed: constant torque below, constant power above
  var EV_PEAK_C_MULT = 2.5;           // traction packs may burst ~2.5x their continuous C-rate
  var HYBRID_PEAK_C_MULT = 15;        // hybrid buffer packs use high-power cells (~40-75C bursts)

  function tireDiameter_mm(rim_in, width_mm, profile) {
    return num(rim_in, 19) * 25.4 + 2 * num(width_mm, 255) * num(profile, 35) / 100;
  }
  function aeroSplit(b) {
    var sp = find('aero.splitters', get(b, 'aero.splitter')) || { downforce_kg_at_200: 0, dragDelta: 0 };
    var wg = find('aero.wings', get(b, 'aero.wing')) || { downforce_kg_at_200: 0, dragDelta: 0 };
    var df = find('aero.diffusers', get(b, 'aero.diffuser')) || { downforce_kg_at_200: 0, dragDelta: 0 };
    var angle = num(get(b, 'aero.wingAngle_deg'), 6);
    var angleF = wg.adjustable ? 0.5 + angle / 12 : 1;
    var canards = get(b, 'aero.canards') ? 20 : 0;
    var front = num(sp.downforce_kg_at_200) + canards + num(df.downforce_kg_at_200) * 0.4;
    var rear = num(wg.downforce_kg_at_200) * angleF + num(df.downforce_kg_at_200) * 0.6;
    var drag = num(sp.dragDelta) + num(wg.dragDelta) * (wg.adjustable ? 0.4 + angle / 10 : 1) + num(df.dragDelta) + (canards ? 0.003 : 0);
    return { front: front, rear: rear, total: front + rear, dragDelta: drag, wing: wg, splitter: sp, diffuser: df };
  }

  function estimate(build, metrics) {
    var d = D();
    var b = build || {};
    var m = metrics || null;
    var e = b.engine || {};
    var type = e.type === 'ev' || e.type === 'hybrid' ? e.type : 'ice';
    var style = find('bodyStyles', get(b, 'body.style')) || d.bodyStyles[0];
    var chassis = find('chassisMaterials', get(b, 'body.chassisMaterial')) || d.chassisMaterials[0];
    var layout = find('engineLayouts', e.layout) || d.engineLayouts[0];
    var asp = find('aspirations', e.aspiration) || d.aspirations[0];
    var fuel = find('fuels', e.fuel) || d.fuels[0];
    var tune = find('tunes', e.tune) || { powerMult: 1, efficiencyMult: 1 };
    var exh = find('exhausts', e.exhaust) || { powerMult: 1, weight_kg: 0 };
    var cool = find('coolings', e.cooling) || { weight_kg: 0 };
    var chem = find('batteryChemistries', e.chemistry) || d.batteryChemistries[0];
    var trans = find('transmissions', get(b, 'transmission.type')) || d.transmissions[0];

    var out = { type: type };
    /* --- combustion engine */
    var hpICE = 0, tqICE = 0, iceRpmPeak = 0;
    if (type !== 'ev') {
      var disp = num(e.displacement_l, 4);
      var units = layout.rotors || layout.cylinders || 4;
      var perCyl = disp / units;
      var sizeF = layout.config === 'rotary' ? 1 : clamp(Math.pow(perCyl / 0.5, -0.3), 0.78, 1.12);
      var redline = num(e.redline_rpm, 7000);
      var rpmF = clamp(Math.pow(redline / (layout.typicalRedline || 7000), 0.6), 0.7, 1.25);
      var boost = asp.id === 'na' ? 0 : Math.max(0.05, num(e.boost_bar, asp.typicalBoost_bar));
      var boostF = asp.id === 'na' ? 1 : 1 + (num(asp.powerMult, 1) - 1) * Math.pow(boost / Math.max(0.1, asp.typicalBoost_bar || 1), 0.75);
      var compF = fuel.id === 'diesel' ? 1 : 1 + (num(e.compression, 10) - 10) * 0.012;
      hpICE = disp * num(layout.specificOutputNA_hpPerL, 100) * sizeF * rpmF * boostF *
        num(tune.powerMult, 1) * num(exh.powerMult, 1) * num(fuel.powerPotential, 1) * compF;
      var frac = fuel.id === 'diesel' ? 0.75 : asp.id === 'na' ? 0.93 : asp.id === 'supercharged' ? 0.9 : 0.85;
      var shape = fuel.id === 'diesel' ? 1.55 : asp.id === 'na' ? 1.08 : asp.id === 'supercharged' ? 1.06 : 1.15 + num(asp.lag) * 0.1;
      iceRpmPeak = redline * frac;
      tqICE = hpICE * KW_PER_HP * 1000 / (iceRpmPeak * 2 * Math.PI / 60) * shape;
    }
    /* --- electric machines */
    var motors = Math.max(0, Math.round(num(e.motors, 0)));
    var kwEach = num(e.motorPower_kw, 0);
    var kwh = num(e.battery_kwh, 0);
    var motorKw = 0, motorTq = 0, peakBattKw = 0;
    if (type !== 'ice') {
      peakBattKw = kwh * num(chem.cRate, 4) * (type === 'ev' ? EV_PEAK_C_MULT : HYBRID_PEAK_C_MULT);
      motorKw = motors * kwEach;
      motorTq = kwEach * 1000 / (MOTOR_BASE_RPM * 2 * Math.PI / 60);
    }
    var deliveredKw = type === 'ice' ? 0 : Math.min(motorKw, peakBattKw);
    var hp;
    if (type === 'ev') hp = deliveredKw / KW_PER_HP;
    else if (type === 'hybrid') hp = hpICE + deliveredKw / KW_PER_HP * 0.85;
    else hp = hpICE;
    // Hybrid layout: on AWD cars the motor(s) form a front e-axle (bypass the gearbox); otherwise one P2 motor
    // sits between engine and gearbox and its torque adds to the gearbox input.
    var dlay = get(b, 'drivetrain.layout');
    var gearboxTq = type === 'ev' ? motorTq : type === 'hybrid' ? tqICE + (dlay === 'awd' ? 0 : motorTq) : tqICE;
    var torque = type === 'ev' ? motorTq * motors : type === 'hybrid' ? tqICE + motorTq * motors * 0.8 : tqICE;

    /* --- mass */
    var w = num(style.baseWeight_kg, 1500) * num(chassis.weightFactor, 1);
    if (type !== 'ev') {
      var mid = (layout.displacementRange[0] + layout.displacementRange[1]) / 2;
      w += num(layout.baseWeight_kg, 150) * Math.pow(num(e.displacement_l, mid) / mid, 0.25) + num(asp.weight_kg) + num(exh.weight_kg) + num(cool.weight_kg);
    } else {
      w += num(cool.weight_kg) - 25; // no fuel system, no exhaust
    }
    if (type !== 'ice') w += kwh * 1000 / num(chem.whPerKg, 160) + motors * (type === 'ev' ? 45 : 32) + 18;
    w += num(trans.weight_kg, 70);
    var dl = find('drivetrainLayouts', dlay); if (dl) w += num(dl.weight_kg);
    ['frontDiff', 'rearDiff', 'centerDiff'].forEach(function (k) { var df = find('differentials', get(b, 'drivetrain.' + k)); if (df) w += num(df.weight_kg); });
    if (get(b, 'drivetrain.torqueVectoring')) w += num(get(d, 'optionWeights.torqueVectoring'), 8);
    var st = find('suspensionTypes', get(b, 'suspension.type')); if (st) w += num(st.weight_kg);
    var bm = find('brakeMaterials', get(b, 'brakes.material')) || d.brakeMaterials[0];
    w += 2 * num(bm.weightPerRotor_kg, 10) * (Math.pow(num(get(b, 'brakes.frontRotor_mm'), 360) / 360, 2) + Math.pow(num(get(b, 'brakes.rearRotor_mm'), 330) / 360, 2)) - 4 * 10;
    var wm = find('wheelMaterials', get(b, 'wheels.material')) || { weightFactor: 1 };
    var dia = num(get(b, 'wheels.diameter_in'), 19);
    var rimW = (num(get(b, 'wheels.widthFront_in'), 9) + num(get(b, 'wheels.widthRear_in'), 9)) / 2;
    w += 4 * 11.5 * num(wm.weightFactor, 1) * Math.pow(dia / 19, 1.6) * Math.pow(rimW / 9, 0.5) - 4 * 11.5;
    var aero = aeroSplit(b);
    w += num(aero.splitter.weight_kg) + num(aero.wing.weight_kg) + num(aero.diffuser.weight_kg);
    var ow = d.optionWeights || {};
    if (get(b, 'aero.canards')) w += num(ow.canards, 1.5);
    if (get(b, 'aero.sideSkirts')) w += num(ow.sideSkirts, 4);
    if (get(b, 'aero.activeAero') && !aero.wing.active) w += num(ow.activeAero, 12);
    if (get(b, 'weight.spareTire')) w += num(ow.spareTire, 18);
    if (get(b, 'weight.soundDeadening') === false) w -= num(ow.soundDeadening, 22);
    if (get(b, 'weight.rearSeats') === false && (style.seatOptions || []).some(function (s) { return s > 2; })) w -= num(ow.rearSeats, 28);
    [['weight.glass', 'glassTypes'], ['weight.battery', 'batteryTypes'], ['weight.rollCage', 'rollCages'], ['exterior.roof', 'roofTypes'],
      ['exterior.lights', 'lightTypes'], ['exterior.mirrors', 'mirrorTypes'], ['interior.upholstery', 'upholsteries'], ['interior.trim', 'trims'],
      ['tech.screen_in', 'screenSizes'], ['tech.audio', 'audioSystems'], ['tech.adas', 'adasLevels']].forEach(function (pc) {
      var o = find(pc[1], get(b, pc[0])); if (o) w += num(o.weight_kg);
    });
    var seat = find('seatTypes', get(b, 'interior.seatType')); if (seat) w += num(seat.weight_kg);
    w += num(get(b, 'weight.ballast_kg'));
    ['harness', 'ambientLighting'].forEach(function (k) { if (get(b, 'interior.' + k)) w += num(ow[k]); });
    ['hud', 'telemetry', 'liftSystem', 'nightVision'].forEach(function (k) { if (get(b, 'tech.' + k)) w += num(ow[k]); });
    w += Math.max(0, num(get(b, 'tech.climateZones'), 2) - 1) * num(ow.perClimateZone, 2);
    w = Math.max(600, w);

    /* --- economy (ICE / hybrid) */
    var l100 = null, mpg = null;
    if (type !== 'ev') {
      var effMult = num(tune.efficiencyMult, 1);
      var cdF = Math.pow((num(style.cd, 0.3) + aero.dragDelta) / 0.30, 0.4);
      l100 = (3.0 + num(e.displacement_l, 2) * 1.0 + hpICE / 150) * Math.pow(w / 1500, 0.6) * cdF / effMult / num(fuel.energyFactor, 1);
      if (type === 'hybrid') l100 *= 0.62;
      mpg = 235.215 / l100;
    }

    /* --- top speed by drag (bisection on P = ½ρCdA v³ + Crr m g v) */
    var cd = num(style.cd, 0.3) + aero.dragDelta + num(get(find('wheelDesigns', get(b, 'wheels.design')) || {}, 'dragDelta'), 0);
    var area = num(style.frontalArea_m2, 2.1) + Math.max(0, num(get(b, 'tires.widthRear_mm'), 255) - 255) * 0.0008;
    var comp = find('tireCompounds', get(b, 'tires.compound')) || { rollingResistance: 0.01 };
    var pWheel = hp * KW_PER_HP * 1000 * (type === 'ev' ? 0.92 : num(trans.efficiency, 0.92) * (dlay === 'awd' ? 0.95 : 1));
    var lo = 0, hi = 160;
    for (var it = 0; it < 40; it++) {
      var v = (lo + hi) / 2;
      var need = 0.5 * 1.225 * cd * area * v * v * v + num(comp.rollingResistance, 0.01) * w * 9.81 * v;
      if (need > pWheel) hi = v; else lo = v;
    }
    var dragTop = lo * 3.6;

    /* --- gearing-limited top speed */
    var ratios = get(b, 'transmission.ratios') || [];
    var fd = num(get(b, 'transmission.finalDrive'), 3.42);
    var drivenRear = dlay !== 'fwd';
    var tDia = tireDiameter_mm(dia, drivenRear ? get(b, 'tires.widthRear_mm') : get(b, 'tires.widthFront_mm'),
      drivenRear ? get(b, 'tires.profileRear') : get(b, 'tires.profileFront'));
    var topRatio = type === 'ev' ? num(ratios[0], 2.65) : num(ratios[ratios.length - 1], 0.8);
    var maxRpm = type === 'ev' ? num(get(d, 'constants.evMaxRpm'), 16000) : num(e.redline_rpm, 7000);
    if (trans.id === 'cvt' && trans.ratioSpan) topRatio = trans.ratioSpan[1];
    var gearTop = maxRpm / 60 / Math.max(0.1, topRatio * fd) * Math.PI * tDia / 1000 * 3.6;

    out.hpICE = hpICE; out.torqueICE_nm = tqICE; out.motorKw = motorKw; out.batteryPeakKw = peakBattKw; out.motorTorqueEach_nm = motorTq;
    out.hp = m && isFinite(m.power_hp) ? m.power_hp : hp;
    out.kw = out.hp * KW_PER_HP;
    out.torque_nm = m && isFinite(m.torque_nm) ? m.torque_nm : torque;
    out.gearboxTorque_nm = type === 'ice' && m && isFinite(m.torque_nm) ? m.torque_nm : gearboxTq;
    out.weight_kg = m && isFinite(m.weight_kg) ? m.weight_kg : w;
    out.hpPerTon = out.hp / (out.weight_kg / 1000);
    out.l100 = m && isFinite(m.fuelEconomy_l100) && type !== 'ev' ? m.fuelEconomy_l100 : l100;
    out.mpg = m && isFinite(m.fuelEconomy_mpg) && type !== 'ev' ? m.fuelEconomy_mpg : mpg;
    out.dragTop_kph = dragTop;
    out.gearTop_kph = gearTop;
    out.topSpeed_kph = m && isFinite(m.topSpeed_kph) ? m.topSpeed_kph : Math.min(dragTop, gearTop);
    out.downforce = aero;
    out.tireDiameterFront_mm = tireDiameter_mm(dia, get(b, 'tires.widthFront_mm'), get(b, 'tires.profileFront'));
    out.tireDiameterRear_mm = tireDiameter_mm(dia, get(b, 'tires.widthRear_mm'), get(b, 'tires.profileRear'));
    out.source = m ? 'metrics' : 'estimate';
    return out;
  }

  /* ======================================================================
     CONTEXT
     ====================================================================== */
  function physicsMetrics(build) {
    if (CB.physics && typeof CB.physics.compute === 'function') {
      try { return CB.physics.compute(build); } catch (e) { return null; }
    }
    return null;
  }

  function context(raw, metrics, usePhysics) {
    var d = D();
    var tpl = template();
    var b = merge(tpl, isObj(raw) ? raw : {});
    // Garbage-tolerance: a section replaced by null / scalar / array falls back to the template section.
    Object.keys(tpl).forEach(function (k) { if (isObj(tpl[k]) && !isObj(b[k])) b[k] = clone(tpl[k]); });
    var m = metrics || (usePhysics ? physicsMetrics(b) : null);
    var c = { raw: raw, b: b, d: d, m: m, usePhysics: usePhysics };
    c.style = find('bodyStyles', b.body.style) || d.bodyStyles[0];
    c.chassis = find('chassisMaterials', b.body.chassisMaterial) || d.chassisMaterials[0];
    c.type = b.engine.type === 'ev' || b.engine.type === 'hybrid' ? b.engine.type : 'ice';
    c.isEV = c.type === 'ev'; c.isHybrid = c.type === 'hybrid'; c.hasICE = !c.isEV;
    c.layout = find('engineLayouts', b.engine.layout) || d.engineLayouts[0];
    c.asp = find('aspirations', b.engine.aspiration) || d.aspirations[0];
    c.fuel = find('fuels', b.engine.fuel) || d.fuels[0];
    c.tune = find('tunes', b.engine.tune) || d.tunes[1];
    c.exhaust = find('exhausts', b.engine.exhaust) || d.exhausts[0];
    c.cooling = find('coolings', b.engine.cooling) || d.coolings[0];
    c.chem = find('batteryChemistries', b.engine.chemistry) || d.batteryChemistries[0];
    c.trans = find('transmissions', b.transmission.type) || d.transmissions[0];
    c.susp = find('suspensionTypes', b.suspension.type) || d.suspensionTypes[0];
    c.brake = find('brakeMaterials', b.brakes.material) || d.brakeMaterials[0];
    c.compound = find('tireCompounds', b.tires.compound) || d.tireCompounds[0];
    c.wheelMat = find('wheelMaterials', b.wheels.material) || d.wheelMaterials[0];
    c.wheelDesign = find('wheelDesigns', b.wheels.design) || d.wheelDesigns[0];
    c.seat = find('seatTypes', b.interior.seatType) || d.seatTypes[0];
    c.uph = find('upholsteries', b.interior.upholstery) || d.upholsteries[0];
    c.est = estimate(b, m);
    c.hp = c.est.hp;
    c.dl = b.drivetrain.layout;
    c.frontDriven = c.dl === 'fwd' || c.dl === 'awd';
    c.rearDriven = c.dl === 'rwd' || c.dl === 'awd';
    c.utility = oneOf(c.style.id, ['suv', 'pickup', 'van']);
    c.offroad = oneOf(c.style.id, ['suv', 'pickup']);
    c.effCR = c.hasICE ? num(b.engine.compression, 10) * Math.sqrt(1 + Math.max(0, c.asp.id === 'na' ? 0 : num(b.engine.boost_bar))) : 0;
    c.wheelMm = num(b.wheels.diameter_in, 19) * 25.4;
    return c;
  }

  /* ======================================================================
     RULE REGISTRY
     ====================================================================== */
  var RULES = [];
  /**
   * rule(id, section, severity, path, title, check)
   * check(c) -> null | result | result[]   where result = { message, fixes?: [[label, patch], ...], severity?, path?, id? }
   */
  function rule(id, section, severity, path, title, check) {
    RULES.push({ id: id, section: section, severity: severity, path: path, title: title, check: check });
  }
  function F(label, patch) { return [label, patch]; }

  /* Tyre/rim fitment: rim width (in) suitable for a tyre section width (mm). */
  function rimRange(tire_mm) { var s = num(tire_mm) / 25.4; return [s * 0.75, s * 1.02]; }
  function tireForRim(rim_in) {
    var w = num(rim_in) * 25.4 / 0.88;
    var t = Math.round((w - 5) / 10) * 10 + 5;
    return clamp(t, 175, 355);
  }
  function rimForTire(tire_mm) { return clamp(Math.round(num(tire_mm) / 25.4 * 0.88 * 2) / 2, 6, 13); }

  /* Maximum overall tyre diameter (mm) each body's wheel arches accept (calibrated to the preset library). */
  var ARCH_MAX_MM = { coupe: 745, sedan: 745, hatchback: 700, wagon: 760, suv: 860, roadster: 730, pickup: 905, hypercar: 750, 'shooting-brake': 745, van: 800 };

  /* ---------------------------------------------------------------- catalog integrity */
  rule('catalog.unknown-option', 'body', 'error', null, 'Every choice must exist in the catalog', function (c) {
    var pcs = c.d.pathCollections || {}, out = [];
    Object.keys(pcs).forEach(function (path) {
      var v = get(c.raw, path);
      if (v === undefined) return;
      if (!find(pcs[path], v)) {
        var def = get(template(), path);
        out.push({ id: 'catalog.unknown-option:' + path, path: path, section: sectionOf(path),
          message: 'Unknown ' + path.split('.').pop() + ' “' + v + '” — it is not in the Redline catalog.',
          fixes: [F('Use ' + nameOf(pcs[path], def), patchOf(path, def))] });
      }
    });
    return out;
  });

  /* ---------------------------------------------------------------- body */
  rule('body.doors', 'body', 'error', 'body.doors', 'Door count must suit the body style', function (c) {
    var opts = c.style.doorOptions || [2];
    if (oneOf(num(c.b.body.doors), opts)) return null;
    return { message: 'A ' + c.style.name + ' is built with ' + opts.join(' or ') + ' doors, not ' + c.b.body.doors + '.',
      fixes: [F(opts[0] + ' doors', P('body.doors', opts[0]))] };
  });
  rule('body.seats', 'body', 'error', 'body.seats', 'Seat count must suit the body style', function (c) {
    var opts = c.style.seatOptions || [2];
    if (oneOf(num(c.b.body.seats), opts)) return null;
    var best = opts.reduce(function (a, s) { return Math.abs(s - c.b.body.seats) < Math.abs(a - c.b.body.seats) ? s : a; }, opts[0]);
    return { message: 'The ' + c.style.name + ' cabin is offered with ' + opts.join(' / ') + ' seats, not ' + c.b.body.seats + '.',
      fixes: [F(best + ' seats', P('body.seats', best))] };
  });
  rule('body.wheelbase-range', 'body', 'error', 'body.wheelbase_mm', 'Wheelbase within the platform range', function (c) {
    var r = c.style.wheelbaseRange, wb = num(c.b.body.wheelbase_mm);
    if (wb >= r[0] && wb <= r[1]) return null;
    var to = clamp(wb, r[0], r[1]);
    return { message: 'Wheelbase ' + fmt(wb) + ' mm is outside the ' + c.style.name + ' platform range (' + r[0] + '–' + r[1] + ' mm).',
      fixes: [F('Set wheelbase to ' + to + ' mm', P('body.wheelbase_mm', to))] };
  });
  rule('body.engine-position', 'body', 'error', 'engine.position', 'Engine position must be packageable in the body', function (c) {
    if (c.isEV) return null;
    var allowed = c.style.allowedEnginePositions || ['front'];
    var pos = c.b.engine.position;
    if (oneOf(pos, allowed)) return null;
    var msg = pos === 'mid' && oneOf(c.style.id, ['pickup', 'van', 'wagon'])
      ? 'Mid-engine packaging is impossible in a ' + c.style.name + ': the ' + (c.style.id === 'pickup' ? 'cab and bed occupy' : 'cabin and load floor occupy') + ' the space ahead of the rear axle.'
      : 'The ' + c.style.name + ' platform only accepts a ' + allowed.join(' or ') + '-mounted engine.';
    return { message: msg, fixes: [F(allowed[0].charAt(0).toUpperCase() + allowed[0].slice(1) + '-mounted engine', P('engine.position', allowed[0]))] };
  });
  rule('body.w16-chassis', 'body', 'error', 'body.style', 'The W16 needs a hypercar or coupé', function (c) {
    if (!c.hasICE || c.layout.id !== 'W16' || oneOf(c.style.id, ['hypercar', 'coupe'])) return null;
    return { message: 'The W16 (' + fmt(c.layout.length_mm) + ' mm long, four turbos, ten radiators) only packages in the hypercar or coupé platform.',
      fixes: [F('Switch to the hypercar platform', P('body.style', 'hypercar', 'engine.position', 'mid')),
        F('Use a V12 instead', P('engine.layout', 'V12', 'engine.displacement_l', 6.5))] };
  });
  rule('engine.w16-position', 'engine', 'error', 'engine.position', 'The W16 must be mid-mounted', function (c) {
    if (!c.hasICE || c.layout.id !== 'W16' || c.b.engine.position === 'mid') return null;
    if (!oneOf('mid', c.style.allowedEnginePositions || [])) return null; // body.w16-chassis covers it
    return { message: 'The W16 is only engineered as a mid-mounted stressed member — its cooling and four turbos cannot live in the ' + c.b.engine.position + '.',
      fixes: [F('Mid-mount the engine', P('engine.position', 'mid'))] };
  });
  rule('body.hatch-big-engine', 'body', 'error', 'engine.layout', 'V10 / V12 will not fit a hatchback', function (c) {
    if (!c.hasICE || c.style.id !== 'hatchback' || !oneOf(c.layout.id, ['V10', 'V12'])) return null;
    return { message: 'A ' + c.layout.name + ' is ' + c.layout.length_mm + ' mm long — the hatchback engine bay accepts at most ~650 mm.',
      fixes: [F('Use a 3.0 L V6', P('engine.layout', 'V6', 'engine.displacement_l', 3.0)), F('Use a 2.5 L inline-5', P('engine.layout', 'I5', 'engine.displacement_l', 2.5))] };
  });
  rule('body.hypercar-chassis', 'body', 'warning', 'body.chassisMaterial', 'Hypercars need a stiff, light chassis', function (c) {
    if (c.style.id !== 'hypercar' || !oneOf(c.chassis.id, ['steel', 'high-strength-steel'])) return null;
    return { message: 'A ' + c.chassis.name + ' hypercar gives away ~' + fmt(c.style.baseWeight_kg * (c.chassis.weightFactor - 0.7)) + ' kg and much torsional stiffness to a carbon tub.',
      fixes: [F('Carbon passenger tub', P('body.chassisMaterial', 'carbon-tub'))] };
  });
  rule('body.rollover-track', 'body', 'warning', 'body.trackWidth_mm', 'Tall bodies need a wide track', function (c) {
    if (!c.utility || num(c.b.body.trackWidth_mm) >= 1550) return null;
    return { message: 'A ' + fmt(c.b.body.trackWidth_mm) + ' mm track on a tall ' + c.style.name + ' (CG ' + c.style.cgHeight_mm + ' mm) lowers the static stability factor — rollover risk in emergency manoeuvres.',
      fixes: [F('Widen track to 1,650 mm', P('body.trackWidth_mm', 1650))] };
  });
  rule('body.short-wheelbase-mid', 'body', 'info', 'body.wheelbase_mm', 'Short wheelbase + rear-biased mass', function (c) {
    if (!c.hasICE || !oneOf(c.b.engine.position, ['mid', 'rear']) || num(c.b.body.wheelbase_mm) >= 2450) return null;
    var to = Math.min(c.style.wheelbaseRange[1], 2500);
    return { message: 'A ' + fmt(c.b.body.wheelbase_mm) + ' mm wheelbase with a ' + c.b.engine.position + '-mounted engine makes snap oversteer arrive with little warning.',
      fixes: [F('Stretch wheelbase to ' + fmt(to) + ' mm', P('body.wheelbase_mm', to))] };
  });
  rule('body.monocoque-cage', 'weight', 'info', 'weight.rollCage', 'A carbon monocoque already is a safety cell', function (c) {
    if (c.chassis.id !== 'carbon-monocoque' || c.b.weight.rollCage !== 'full') return null;
    return { message: 'The full carbon monocoque has an integrated roll structure — the welded cage adds 45 kg for little extra stiffness.',
      fixes: [F('Remove the cage', P('weight.rollCage', 'none'))] };
  });

  /* ---------------------------------------------------------------- engine (combustion) */
  rule('engine.displacement-range', 'engine', 'error', 'engine.displacement_l', 'Displacement within the engine family range', function (c) {
    if (!c.hasICE) return null;
    var r = c.layout.displacementRange, v = num(c.b.engine.displacement_l);
    if (v >= r[0] - 1e-9 && v <= r[1] + 1e-9) return null;
    var to = r1(clamp(v, r[0], r[1]));
    return { message: 'The ' + c.layout.name + ' is offered from ' + r[0] + ' to ' + r[1] + ' L; ' + v + ' L is not possible.',
      fixes: [F('Set ' + to + ' L', P('engine.displacement_l', to))] };
  });
  rule('engine.boost-na', 'engine', 'error', 'engine.boost_bar', 'No boost without forced induction', function (c) {
    if (!c.hasICE || c.asp.id !== 'na' || num(c.b.engine.boost_bar) <= 0) return null;
    return { message: 'A naturally aspirated engine cannot run ' + c.b.engine.boost_bar + ' bar of boost.',
      fixes: [F('Set boost to 0', P('engine.boost_bar', 0)), F('Fit a single turbo', P('engine.aspiration', 'turbo'))] };
  });
  rule('engine.boost-max', 'engine', 'error', 'engine.boost_bar', 'Boost within the charger capability', function (c) {
    if (!c.hasICE || c.asp.id === 'na' || num(c.b.engine.boost_bar) <= num(c.asp.maxBoost_bar) + 1e-9) return null;
    return { message: 'The ' + c.asp.name + ' tops out at ' + c.asp.maxBoost_bar + ' bar — ' + c.b.engine.boost_bar + ' bar would overspeed the compressor.',
      fixes: [F('Limit boost to ' + c.asp.maxBoost_bar + ' bar', P('engine.boost_bar', c.asp.maxBoost_bar))] };
  });
  rule('engine.diesel-redline', 'engine', 'error', 'engine.redline_rpm', 'Diesel redline cap', function (c) {
    var cap = c.fuel.redlineCap_rpm;
    if (!c.hasICE || !cap || num(c.b.engine.redline_rpm) <= cap) return null;
    return { message: 'Diesel combustion is too slow for ' + fmt(c.b.engine.redline_rpm) + ' rpm — compression-ignition engines are capped at ' + fmt(cap) + ' rpm.',
      fixes: [F('Redline ' + fmt(cap - 200) + ' rpm', P('engine.redline_rpm', cap - 200))] };
  });
  rule('engine.rotary-diesel', 'engine', 'error', 'engine.fuel', 'Wankel rotaries cannot burn diesel', function (c) {
    if (!c.hasICE || c.layout.config !== 'rotary' || c.fuel.id !== 'diesel') return null;
    return { message: 'The Wankel’s long, moving combustion chamber cannot reach diesel auto-ignition compression.',
      fixes: [F('Premium 98 RON', P('engine.fuel', 'premium'))] };
  });
  rule('engine.diesel-compression', 'engine', 'error', 'engine.compression', 'Diesel needs high compression', function (c) {
    if (!c.hasICE || c.fuel.id !== 'diesel' || num(c.b.engine.compression) >= 13) return null;
    return { message: 'At ' + c.b.engine.compression + ':1 diesel will not self-ignite — compression ignition needs at least 13:1.',
      fixes: [F('Raise compression to 14:1', P('engine.compression', 14))] };
  });
  rule('engine.knock', 'engine', 'error', 'engine.compression', 'Effective compression within the fuel knock limit', function (c) {
    if (!c.hasICE || c.fuel.id === 'diesel') return null;
    var limit = num(c.fuel.knockLimit, 15), eff = c.effCR;
    if (eff <= limit) return null;
    var boost = c.asp.id === 'na' ? 0 : num(c.b.engine.boost_bar);
    var fixes = [];
    c.d.fuels.filter(function (f) { return f.id !== 'diesel' && f.id !== c.fuel.id && num(f.knockLimit) >= eff; })
      .sort(function (a, b) { return a.knockLimit - b.knockLimit; })
      .forEach(function (f) { fixes.push(F('Switch to ' + f.name + ' (limit ' + f.knockLimit + ')', P('engine.fuel', f.id))); });
    var cr = Math.floor((limit - 0.2) / Math.sqrt(1 + boost) * 10) / 10;
    if (cr >= 8) fixes.push(F('Lower compression to ' + cr + ':1', P('engine.compression', cr)));
    if (boost > 0) {
      var bb = Math.floor((Math.pow((limit - 0.2) / num(c.b.engine.compression), 2) - 1) * 20) / 20;
      if (bb >= 0.2) fixes.push(F('Reduce boost to ' + bb + ' bar', P('engine.boost_bar', bb)));
    }
    fixes.push(F('Race fuel + 9.0:1 compression', P('engine.fuel', 'race', 'engine.compression', 9)));
    return { message: 'Effective compression ' + r1(eff) + ':1 (' + c.b.engine.compression + ':1' + (boost ? ' at ' + boost + ' bar' : '') + ') exceeds the ' +
      c.fuel.name + ' knock limit of ' + limit + ':1 — detonation will destroy the pistons.', fixes: fixes };
  });
  rule('engine.knock-margin', 'engine', 'warning', 'engine.compression', 'Running close to the knock limit', function (c) {
    if (!c.hasICE || c.fuel.id === 'diesel') return null;
    var limit = num(c.fuel.knockLimit, 15), margin = limit - c.effCR;
    if (margin < 0 || margin >= 0.25) return null;
    var boost = c.asp.id === 'na' ? 0 : num(c.b.engine.boost_bar);
    var cr = Math.floor((limit - 0.6) / Math.sqrt(1 + boost) * 10) / 10;
    var fixes = [];
    if (cr >= 8) fixes.push(F('Lower compression to ' + cr + ':1', P('engine.compression', cr)));
    var better = c.d.fuels.filter(function (f) { return f.id !== 'diesel' && num(f.knockLimit) >= c.effCR + 0.25 && num(f.knockLimit) > limit; })
      .sort(function (a, b) { return a.knockLimit - b.knockLimit; })[0];
    if (better) fixes.push(F('Switch to ' + better.name, P('engine.fuel', better.id)));
    return { message: 'Only ' + r2(margin) + ' points of knock margin on ' + c.fuel.name + ' — hot days or poor fuel will pull timing.', fixes: fixes };
  });
  rule('engine.e85-low-compression', 'engine', 'info', 'engine.compression', 'E85 rewards compression', function (c) {
    if (!c.hasICE || c.fuel.id !== 'e85' || c.asp.id !== 'na' || num(c.b.engine.compression) >= 12) return null;
    return { message: 'E85 on a naturally aspirated ' + c.b.engine.compression + ':1 engine wastes its 105-octane knock resistance — raise compression to exploit it.',
      fixes: [F('Raise compression to 12.5:1', P('engine.compression', 12.5))] };
  });
  rule('engine.redline-valvetrain', 'engine', 'warning', 'engine.redline_rpm', 'Redline far above the engine design speed', function (c) {
    if (!c.hasICE) return null;
    var typ = num(c.layout.typicalRedline, 7000), rl = num(c.b.engine.redline_rpm);
    if (rl <= typ + 2000) return null;
    return { message: fmt(rl) + ' rpm is ' + fmt(rl - typ) + ' rpm beyond the ' + c.layout.name + ' design speed — valve float and piston speed of ' +
      r1(rl / 60 * 2 * 0.086) + ' m/s risk a dropped valve.', fixes: [F('Redline ' + fmt(typ + 1000) + ' rpm', P('engine.redline_rpm', typ + 1000))] };
  });
  rule('engine.supercharger-rpm', 'engine', 'warning', 'engine.redline_rpm', 'Supercharger tip-speed limit', function (c) {
    if (!c.hasICE || c.asp.id !== 'supercharged' || num(c.b.engine.redline_rpm) <= 8000) return null;
    return { message: 'A crank-driven blower spun to ' + fmt(c.b.engine.redline_rpm) + ' rpm exceeds its rotor tip-speed limit; parasitic loss soars.',
      fixes: [F('Redline 7,500 rpm', P('engine.redline_rpm', 7500)), F('Twincharged instead', P('engine.aspiration', 'twincharged'))] };
  });
  rule('engine.tune-fuel', 'engine', 'warning', 'engine.fuel', 'Aggressive maps need premium fuel', function (c) {
    if (!c.hasICE || !oneOf(c.tune.id, ['stage2', 'stage3', 'time-attack']) || c.fuel.id !== 'regular') return null;
    return { message: c.tune.name + ' calibrations assume 98 RON or better — on regular the ECU will retard timing and the gains vanish.',
      fixes: [F('Premium 98 RON', P('engine.fuel', 'premium'))] };
  });
  rule('engine.tune-cooling', 'engine', 'warning', 'engine.cooling', 'High-strung tunes need more cooling', function (c) {
    if (!c.hasICE) return null;
    if (c.tune.id === 'time-attack' && c.cooling.id !== 'race') {
      return { message: 'The Time Attack map with anti-lag dumps enormous heat — only endurance race cooling keeps it alive.', fixes: [F('Endurance race cooling', P('engine.cooling', 'race'))] };
    }
    if (c.tune.id === 'stage3' && c.cooling.id === 'standard') {
      return { message: 'Stage 3 (+40%) on the standard radiator will heat-soak after one hard lap.', fixes: [F('Uprated cooling', P('engine.cooling', 'uprated')), F('Endurance race cooling', P('engine.cooling', 'race'))] };
    }
    return null;
  });
  rule('engine.power-cooling', 'engine', 'warning', 'engine.cooling', 'Very high output needs uprated cooling', function (c) {
    var lim = c.isEV ? 1000 : 900;
    if (c.hp <= lim || c.cooling.id !== 'standard') return null;
    return { message: fmt(c.hp) + ' hp produces roughly ' + fmt(c.est.kw * (c.isEV ? 0.08 : 0.6)) + ' kW of waste heat at full load — the standard ' +
      (c.isEV ? 'battery/inverter loop' : 'radiator') + ' is overwhelmed.', fixes: [F('Uprated cooling', P('engine.cooling', 'uprated')), F('Endurance race cooling', P('engine.cooling', 'race'))] };
  });
  rule('engine.tune-na', 'engine', 'info', 'engine.tune', 'ECU tunes yield less on atmospheric engines', function (c) {
    if (!c.hasICE || c.asp.id !== 'na' || !oneOf(c.tune.id, ['stage2', 'stage3'])) return null;
    return { message: c.tune.name + ' quotes gains for forced-induction engines; without boost to raise, expect roughly half of the advertised uplift.' };
  });
  rule('engine.straight-pipe', 'engine', 'warning', 'engine.exhaust', 'Straight-pipe exhaust is not road legal', function (c) {
    if (!c.hasICE || c.exhaust.id !== 'straight-pipe') return null;
    return { message: 'The catless straight pipe produces ' + c.exhaust.loudness_db + ' dB — far beyond drive-by noise limits and emissions rules.',
      fixes: [F('Valvetronic active exhaust', P('engine.exhaust', 'valvetronic')), F('Titanium race exhaust', P('engine.exhaust', 'titanium'))] };
  });
  rule('engine.diesel-tune', 'engine', 'warning', 'engine.tune', 'Diesel time-attack map', function (c) {
    if (!c.hasICE || c.fuel.id !== 'diesel' || c.tune.id !== 'time-attack') return null;
    return { message: 'A time-attack map on a diesel means black smoke, EGTs past 900 °C and melted pistons.', fixes: [F('Stage 2 calibration', P('engine.tune', 'stage2'))] };
  });
  rule('engine.w16-aspiration', 'engine', 'info', 'engine.aspiration', 'The W16 was designed around four turbos', function (c) {
    if (!c.hasICE || c.layout.id !== 'W16' || c.asp.id === 'quad-turbo') return null;
    return { message: 'The W16 was engineered around four sequential turbochargers — ' + c.asp.name.toLowerCase() + ' leaves it breathless.',
      fixes: [F('Quad turbo at 1.8 bar', P('engine.aspiration', 'quad-turbo', 'engine.boost_bar', 1.8))] };
  });

  /* ---------------------------------------------------------------- engine (electric) */
  rule('engine.ev-exhaust', 'engine', 'info', 'engine.exhaust', 'Electric cars ignore the exhaust', function (c) {
    if (!c.isEV || c.exhaust.id === 'stock') return null;
    return { message: 'An electric drivetrain has no exhaust — the ' + c.exhaust.name + ' selection is ignored (and not charged).',
      fixes: [F('Reset to factory exhaust', P('engine.exhaust', 'stock'))] };
  });
  rule('engine.battery-power', 'engine', 'error', 'engine.battery_kwh', 'Battery must be able to feed the motors', function (c) {
    if (c.hasICE && !c.isHybrid) return null;
    var e = c.b.engine, mult = c.isEV ? EV_PEAK_C_MULT : HYBRID_PEAK_C_MULT;
    var need = num(e.motors) * num(e.motorPower_kw), kwh = num(e.battery_kwh), cr = num(c.chem.cRate, 4);
    var peak = kwh * cr * mult;
    if (need <= peak + 1e-6) return null;
    var maxKwh = c.isEV ? 200 : 30;
    var fixes = [];
    var needKwh = Math.ceil(need / (cr * mult) * 10) / 10;
    if (c.isEV) needKwh = Math.ceil(needKwh);
    if (needKwh <= maxKwh) fixes.push(F('Enlarge battery to ' + needKwh + ' kWh', P('engine.battery_kwh', needKwh)));
    c.d.batteryChemistries.filter(function (ch) { return ch.cRate * kwh * mult >= need && ch.id !== c.chem.id; })
      .sort(function (a, b) { return a.pricePerKwh - b.pricePerKwh; })
      .forEach(function (ch) { fixes.push(F('Use ' + ch.name + ' cells', P('engine.chemistry', ch.id))); });
    var kwEach = Math.floor(peak / Math.max(1, num(e.motors)) / 5) * 5;
    if (kwEach >= 50) fixes.push(F('Limit motors to ' + kwEach + ' kW each', P('engine.motorPower_kw', kwEach)));
    var ss = find('batteryChemistries', 'solid-state');
    if (ss) { var k2 = Math.min(maxKwh, Math.ceil(need / (ss.cRate * mult))); fixes.push(F('Solid-state ' + k2 + ' kWh pack', P('engine.chemistry', 'solid-state', 'engine.battery_kwh', k2))); }
    return { message: 'The ' + kwh + ' kWh ' + c.chem.name.split(' (')[0] + ' pack can burst ~' + fmt(peak) + ' kW, but ' + e.motors + ' × ' + e.motorPower_kw + ' kW motors demand ' + fmt(need) + ' kW.', fixes: fixes };
  });
  rule('engine.battery-peak', 'engine', 'info', 'engine.battery_kwh', 'Battery near its discharge limit', function (c) {
    if (!c.isEV) return null;
    var e = c.b.engine, need = num(e.motors) * num(e.motorPower_kw), peak = num(e.battery_kwh) * num(c.chem.cRate) * EV_PEAK_C_MULT;
    if (need > peak || need < peak * 0.8) return null;
    return { message: 'Full power draws ' + fmt(need / peak * 100) + '% of the pack’s burst capability — expect power to taper as the cells heat up on track.' };
  });
  rule('engine.ev-voltage', 'engine', 'warning', 'engine.voltage', 'High power needs 800 V', function (c) {
    if (c.hasICE && !c.isHybrid) return null;
    var kw = num(c.b.engine.motors) * num(c.b.engine.motorPower_kw);
    if (kw <= 600 || num(c.b.engine.voltage) >= 800) return null;
    return { message: fmt(kw) + ' kW at 400 V means ' + fmt(kw * 1000 / 400) + ' A — cabling and inverters overheat. Use the 800 V architecture.',
      fixes: [F('800 V architecture', P('engine.voltage', 800))] };
  });
  rule('engine.battery-range', 'engine', 'error', 'engine.battery_kwh', 'Battery capacity within the drivetrain range', function (c) {
    if (c.type === 'ice') return null;
    var r = c.d.batteryRanges[c.type], v = num(c.b.engine.battery_kwh);
    if (v >= r[0] && v <= r[1]) return null;
    var to = clamp(v, r[0], r[1]);
    return { message: (c.isEV ? 'Electric' : 'Hybrid') + ' packs range from ' + r[0] + ' to ' + r[1] + ' kWh; ' + v + ' kWh is not offered.',
      fixes: [F('Set ' + to + ' kWh', P('engine.battery_kwh', to))] };
  });
  rule('engine.motors-range', 'engine', 'error', 'engine.motors', 'Motor count within the drivetrain range', function (c) {
    if (c.type === 'ice') return null;
    var r = c.d.motorRanges[c.type], v = num(c.b.engine.motors);
    if (v >= r[0] && v <= r[1]) return null;
    var to = clamp(Math.round(v), r[0], r[1]);
    return { message: (c.isEV ? 'Electric cars carry ' : 'Hybrids carry ') + r[0] + '–' + r[1] + ' motors; ' + v + ' is not possible.', fixes: [F(to + ' motor' + (to > 1 ? 's' : ''), P('engine.motors', to))] };
  });
  rule('engine.ev-small-pack', 'engine', 'info', 'engine.battery_kwh', 'Small pack in a heavy EV', function (c) {
    if (!c.isEV || num(c.b.engine.battery_kwh) >= 50 || c.est.weight_kg <= 2000) return null;
    return { message: 'A ' + c.b.engine.battery_kwh + ' kWh pack in a ' + fmt(c.est.weight_kg) + ' kg car gives well under 250 km of real range.',
      fixes: [F('85 kWh pack', P('engine.battery_kwh', 85))] };
  });

  /* ---------------------------------------------------------------- transmission */
  rule('transmission.single-speed-ice', 'transmission', 'error', 'transmission.type', 'Single-speed reduction is for electric drives', function (c) {
    if (!c.hasICE || c.trans.id !== 'single-speed') return null;
    return { message: 'A combustion engine needs multiple ratios — a single-speed reduction box cannot pull away and reach speed with a ' + fmt(c.b.engine.redline_rpm) + ' rpm engine.',
      fixes: [F('Dual-clutch gearbox', P('transmission.type', 'dct')), F('Torque-converter automatic', P('transmission.type', 'auto'))] };
  });
  rule('transmission.gears-range', 'transmission', 'error', 'transmission.gears', 'Gear count within the gearbox range', function (c) {
    var r = c.trans.gearRange, g = num(c.b.transmission.gears);
    if (g >= r[0] && g <= r[1]) return null;
    var to = clamp(Math.round(g), r[0], r[1]);
    return { message: 'The ' + c.trans.name + ' is offered with ' + (r[0] === r[1] ? r[0] : r[0] + '–' + r[1]) + ' ratios, not ' + g + '.',
      fixes: [F(to + ' gears', { transmission: { gears: to, ratios: c.trans.defaultRatios(to) } })] };
  });
  rule('transmission.ratios', 'transmission', 'error', 'transmission.ratios', 'Gear ratios must be complete and descending', function (c) {
    var t = c.b.transmission, rs = t.ratios;
    var bad = !Array.isArray(rs) || rs.length !== num(t.gears) || rs.some(function (r) { return !isFinite(Number(r)) || Number(r) <= 0; });
    if (!bad) for (var i = 1; i < rs.length; i++) if (Number(rs[i]) >= Number(rs[i - 1])) { bad = true; break; }
    if (!bad) return null;
    var g = clamp(Math.round(num(t.gears, c.trans.gearRange[0])), c.trans.gearRange[0], c.trans.gearRange[1]);
    return { message: 'The ratio set must contain exactly ' + t.gears + ' strictly descending ratios.',
      fixes: [F('Restore factory ratios', { transmission: { gears: g, ratios: c.trans.defaultRatios(g) } })] };
  });
  function gearboxFixes(c, tq, factor) {
    var fixes = [];
    c.d.transmissions.filter(function (t) {
      if (t.id === c.trans.id || num(t.torqueLimit_nm) * factor < tq) return false;
      if (c.hasICE && t.id === 'single-speed') return false;
      return !(c.isEV && t.id !== 'single-speed');
    }).sort(function (a, b) { return a.torqueLimit_nm - b.torqueLimit_nm; })
      .forEach(function (t) { fixes.push(F(t.name + ' (' + fmt(t.torqueLimit_nm) + ' Nm)', P('transmission.type', t.id))); });
    if (c.hasICE) {
      if (c.tune.id !== 'stock' && c.tune.id !== 'eco') fixes.push(F('Factory calibration', P('engine.tune', 'stock')));
      fixes.push(F('Eco map', P('engine.tune', 'eco')));
      if (c.asp.id !== 'na') {
        fixes.push(F('Automatic + eco map + ' + Math.max(0.2, r1(c.asp.typicalBoost_bar * 0.5)) + ' bar', P('transmission.type', 'auto', 'engine.tune', 'eco', 'engine.boost_bar', Math.max(0.2, r1(c.asp.typicalBoost_bar * 0.5)))));
        fixes.push(F('Automatic + naturally aspirated', P('transmission.type', 'auto', 'engine.aspiration', 'na', 'engine.tune', 'stock')));
      }
    }
    return fixes;
  }
  rule('transmission.torque-limit', 'transmission', 'warning', 'transmission.type', 'Gearbox torque rating', function (c) {
    var tq = c.est.gearboxTorque_nm, lim = num(c.trans.torqueLimit_nm, 1000);
    if (tq <= lim || tq > lim * 1.5) return null; // > 1.5x is transmission.torque-overload
    return { message: 'About ' + fmt(tq) + ' Nm reaches the ' + c.trans.name + ', rated for ' + fmt(lim) + ' Nm — expect clutch slip and a short service life.',
      fixes: gearboxFixes(c, tq, 1) };
  });
  rule('transmission.torque-overload', 'transmission', 'error', 'transmission.type', 'Gearbox torque overload', function (c) {
    var tq = c.est.gearboxTorque_nm, lim = num(c.trans.torqueLimit_nm, 1000);
    if (tq <= lim * 1.5) return null;
    return { message: 'About ' + fmt(tq) + ' Nm is ' + r1(tq / lim) + '× the ' + c.trans.name + ' rating of ' + fmt(lim) + ' Nm — it will shear on the first full-throttle launch.',
      fixes: gearboxFixes(c, tq, 1.5) };
  });
  rule('transmission.ev-gearbox', 'transmission', 'info', 'transmission.type', 'Electric motors rarely need gears', function (c) {
    if (!c.isEV || c.trans.id === 'single-speed') return null;
    return { message: 'With ' + fmt(c.est.motorTorqueEach_nm) + ' Nm per motor from 0 rpm, the ' + c.trans.name + ' adds ' + c.trans.weight_kg + ' kg and shift interruptions for little gain.',
      fixes: [F('Single-speed reduction', P('transmission.type', 'single-speed'))] };
  });
  rule('transmission.tall-first', 'transmission', 'warning', 'transmission.finalDrive', 'First gear too tall to launch', function (c) {
    if (!c.hasICE || num(c.b.transmission.gears) <= 1 || oneOf(c.trans.id, ['cvt', 'single-speed'])) return null;
    var r0 = num((c.b.transmission.ratios || [])[0], 3), fd = num(c.b.transmission.finalDrive, 3.42), overall = r0 * fd;
    if (overall >= 7.5) return null;
    var fixes = [];
    var nfd = Math.ceil(8.5 / r0 * 100) / 100;
    if (nfd <= 5.5) fixes.push(F('Final drive ' + nfd.toFixed(2) + ':1', P('transmission.finalDrive', nfd)));
    var dr = c.trans.defaultRatios(num(c.b.transmission.gears));
    if (dr[0] * fd >= 7.5) fixes.push(F('Restore factory ratios', { transmission: { ratios: dr } }));
    fixes.push(F('Factory ratios + 4.10 final drive', { transmission: { ratios: dr, finalDrive: 4.1 } }));
    return { message: 'Overall first-gear ratio is only ' + r2(overall) + ':1 — the clutch will slip and smoke on every hill start.', fixes: fixes };
  });
  rule('transmission.gearing-top-speed', 'transmission', 'info', 'transmission.finalDrive', 'Top speed limited by gearing', function (c) {
    var gt = c.est.gearTop_kph, dt = c.est.dragTop_kph;
    if (c.trans.id === 'cvt' || gt >= dt * 0.9 || dt < 150) return null;
    var fd = num(c.b.transmission.finalDrive, 3.42);
    var nfd = Math.max(2.5, Math.floor(fd * gt / (dt * 0.97) * 100) / 100);
    return { message: 'Gearing runs out at ' + fmt(gt) + ' km/h ' + (c.isEV ? '(motor speed limit)' : '(redline in top gear)') + ' — the power could reach ~' + fmt(dt) + ' km/h.',
      fixes: nfd < fd ? [F('Final drive ' + nfd.toFixed(2) + ':1', P('transmission.finalDrive', nfd))] : [] };
  });
  rule('transmission.manual-autonomy', 'tech', 'error', 'tech.adas', 'Hands-free driving needs an automated gearbox', function (c) {
    if (c.trans.id !== 'manual' || !oneOf(c.b.tech.adas, ['pilot', 'autonomous-l3'])) return null;
    return { message: nameOf('adasLevels', c.b.tech.adas) + ' cannot change gear for you — hands-free systems require an automated transmission.',
      fixes: [F('Assist Plus (L2)', P('tech.adas', 'plus')), F('Dual-clutch gearbox', P('transmission.type', 'dct'))] };
  });
  rule('transmission.sequential-comfort', 'transmission', 'info', 'transmission.type', 'Dog-box in a comfort car', function (c) {
    if (c.trans.id !== 'sequential' || !oneOf(c.seat.id, ['comfort', 'lounge'])) return null;
    return { message: 'The straight-cut sequential dog box whines and clunks at parking speeds — at odds with ' + c.seat.name.toLowerCase() + '.' };
  });
  rule('transmission.launch-manual', 'transmission', 'info', 'transmission.launchControl', 'Launch control with a manual', function (c) {
    if (c.trans.id !== 'manual' || !c.b.transmission.launchControl) return null;
    return { message: 'With a manual gearbox launch control is a launch rev-limiter and flat-shift only — clutch release is still up to you.' };
  });

  /* ---------------------------------------------------------------- drivetrain */
  rule('drivetrain.fwd-engine-position', 'drivetrain', 'error', 'drivetrain.layout', 'Front-wheel drive needs a front engine', function (c) {
    if (!c.hasICE || c.dl !== 'fwd' || c.b.engine.position === 'front') return null;
    return { message: 'A ' + c.b.engine.position + '-mounted engine cannot drive the front wheels without a prop-shaft back through the cabin.',
      fixes: [F('Rear-wheel drive', P('drivetrain.layout', 'rwd')), F('All-wheel drive', P('drivetrain.layout', 'awd'))] };
  });
  rule('drivetrain.fwd-torque-steer', 'drivetrain', 'warning', 'drivetrain.layout', 'Torque steer above 400 hp', function (c) {
    if (c.dl !== 'fwd' || c.hp <= 400) return null;
    return { message: fmt(c.hp) + ' hp through the front wheels alone means violent torque steer and axle tramp — the steering will wrench in your hands.',
      fixes: [F('All-wheel drive', P('drivetrain.layout', 'awd'))] };
  });
  rule('drivetrain.ev-single-motor-awd', 'drivetrain', 'error', 'engine.motors', 'One motor cannot drive two axles', function (c) {
    if (!c.isEV || c.dl !== 'awd' || num(c.b.engine.motors) >= 2) return null;
    return { message: 'A single e-motor drives one axle; all-wheel drive needs at least one motor per axle.',
      fixes: [F('Add a second motor', P('engine.motors', 2)), F('Rear-wheel drive', P('drivetrain.layout', 'rwd'))] };
  });
  rule('drivetrain.ev-multi-motor-2wd', 'drivetrain', 'warning', 'drivetrain.layout', 'Three or four motors on two wheels', function (c) {
    if (!c.isEV || num(c.b.engine.motors) < 3 || c.dl === 'awd') return null;
    return { message: c.b.engine.motors + ' motors on a ' + c.dl.toUpperCase() + ' layout means two motors per wheel — the tyres cannot use it. Fit motors to both axles.',
      fixes: [F('All-wheel drive', P('drivetrain.layout', 'awd'))] };
  });
  rule('drivetrain.torque-vectoring', 'drivetrain', 'warning', 'drivetrain.torqueVectoring', 'Torque vectoring needs actuators', function (c) {
    if (!c.b.drivetrain.torqueVectoring) return null;
    var dt = c.b.drivetrain;
    var ok = (c.frontDriven && dt.frontDiff === 'e-diff') || (c.rearDriven && dt.rearDiff === 'e-diff') || (c.isEV && num(c.b.engine.motors) >= 3);
    if (ok) return null;
    var axle = c.dl === 'fwd' ? 'frontDiff' : 'rearDiff';
    return { message: 'Torque vectoring needs an electronically controlled e-diff (or one motor per wheel) to shuffle torque side to side; open or passive diffs cannot.',
      fixes: [F('Electronic e-Diff (' + (axle === 'frontDiff' ? 'front' : 'rear') + ')', P('drivetrain.' + axle, 'e-diff')), F('Disable torque vectoring', P('drivetrain.torqueVectoring', false))] };
  });
  rule('drivetrain.driven-axle-diff', 'drivetrain', 'error', 'drivetrain.rearDiff', 'Driven axles need a differential', function (c) {
    var dt = c.b.drivetrain, out = [];
    if (c.frontDriven && dt.frontDiff === 'none') out.push({ id: 'drivetrain.driven-axle-diff:front', path: 'drivetrain.frontDiff', message: 'The driven front axle has no differential.', fixes: [F('Open front differential', P('drivetrain.frontDiff', 'open'))] });
    if (c.rearDriven && dt.rearDiff === 'none') out.push({ id: 'drivetrain.driven-axle-diff:rear', path: 'drivetrain.rearDiff', message: 'The driven rear axle has no differential.', fixes: [F('Open rear differential', P('drivetrain.rearDiff', 'open'))] });
    if (c.dl === 'awd' && dt.centerDiff === 'none') out.push({ id: 'drivetrain.driven-axle-diff:center', path: 'drivetrain.centerDiff', message: 'All-wheel drive without a centre coupling will bind in every corner.', fixes: [F('Torsen centre differential', P('drivetrain.centerDiff', 'lsd-torsen'))] });
    return out;
  });
  rule('drivetrain.split-range', 'drivetrain', 'error', 'drivetrain.torqueSplitFront_pct', 'Torque split must match the layout', function (c) {
    var s = num(c.b.drivetrain.torqueSplitFront_pct);
    var want = c.dl === 'fwd' ? [100, 100] : c.dl === 'rwd' ? [0, 0] : [10, 90];
    if (s >= want[0] && s <= want[1]) return null;
    var to = clamp(s, want[0], want[1]);
    return { message: 'A ' + c.dl.toUpperCase() + ' layout sends ' + (want[0] === want[1] ? want[0] + '%' : want[0] + '–' + want[1] + '%') + ' of torque forward, not ' + s + '%.',
      fixes: [F('Set ' + to + '% front', P('drivetrain.torqueSplitFront_pct', to))] };
  });
  rule('drivetrain.locking-road', 'drivetrain', 'warning', 'drivetrain.rearDiff', 'Locking diffs on a road car', function (c) {
    if (c.offroad) return null;
    var out = [], dt = c.b.drivetrain;
    [['frontDiff', 'front'], ['rearDiff', 'rear'], ['centerDiff', 'centre']].forEach(function (a) {
      if (dt[a[0]] !== 'locking') return;
      out.push({ id: 'drivetrain.locking-road:' + a[0], path: 'drivetrain.' + a[0],
        message: 'A locked ' + a[1] + ' differential on a ' + c.style.name.toLowerCase() + ' scrubs the tyres and causes axle wind-up on tarmac.',
        fixes: [F('Clutch-pack LSD (' + a[1] + ')', P('drivetrain.' + a[0], 'lsd-clutch'))] });
    });
    return out;
  });
  rule('drivetrain.open-diff-power', 'drivetrain', 'info', 'drivetrain.rearDiff', 'Open diff on a powerful axle', function (c) {
    var dt = c.b.drivetrain, out = [];
    var split = num(dt.torqueSplitFront_pct) / 100;
    if (c.frontDriven && dt.frontDiff === 'open' && c.hp * split > 450) out.push({ id: 'drivetrain.open-diff-power:front', path: 'drivetrain.frontDiff', message: 'About ' + fmt(c.hp * split) + ' hp through an open front diff will spin the inside wheel out of every corner.', fixes: [F('Clutch-pack LSD (front)', P('drivetrain.frontDiff', 'lsd-clutch'))] });
    if (c.rearDriven && dt.rearDiff === 'open' && c.hp * (1 - split) > 450) out.push({ id: 'drivetrain.open-diff-power:rear', path: 'drivetrain.rearDiff', message: 'About ' + fmt(c.hp * (1 - split)) + ' hp through an open rear diff means one-wheel burnouts on corner exit.', fixes: [F('Clutch-pack LSD (rear)', P('drivetrain.rearDiff', 'lsd-clutch'))] });
    return out;
  });
  rule('drivetrain.tc-off', 'drivetrain', 'warning', 'drivetrain.tractionControl', 'Traction control off on a very powerful car', function (c) {
    if (num(c.b.drivetrain.tractionControl) > 0 || c.est.hpPerTon <= 400) return null;
    return { message: fmt(c.est.hpPerTon) + ' hp/tonne with traction control fully off — wheelspin up to third gear is guaranteed.',
      fixes: [F('Traction control level 1', P('drivetrain.tractionControl', 1))] };
  });
  rule('drivetrain.rwd-power', 'drivetrain', 'info', 'drivetrain.tractionControl', 'Very high power through the rear axle', function (c) {
    if (c.dl !== 'rwd' || c.hp <= 750 || num(c.b.drivetrain.tractionControl) >= 2) return null;
    return { message: fmt(c.hp) + ' hp RWD with minimal traction control — launch and corner exits will be traction-limited.',
      fixes: [F('Traction control level 2', P('drivetrain.tractionControl', 2))] };
  });
  rule('drivetrain.awd-bias', 'drivetrain', 'info', 'drivetrain.torqueSplitFront_pct', 'Front-biased split on a rear-heavy car', function (c) {
    if (!c.hasICE || c.dl !== 'awd' || num(c.b.drivetrain.torqueSplitFront_pct) <= 50 || c.b.engine.position === 'front') return null;
    return { message: 'Sending ' + c.b.drivetrain.torqueSplitFront_pct + '% forward on a ' + c.b.engine.position + '-engined car fights its rear weight bias and induces power understeer.',
      fixes: [F('35% front split', P('drivetrain.torqueSplitFront_pct', 35))] };
  });

  /* ---------------------------------------------------------------- suspension */
  rule('suspension.macpherson-ride-height', 'suspension', 'error', 'suspension.rideHeight_mm', 'MacPherson struts below 70 mm', function (c) {
    if (c.susp.id !== 'macpherson' || num(c.b.suspension.rideHeight_mm) >= 70) return null;
    return { message: 'At ' + c.b.suspension.rideHeight_mm + ' mm the MacPherson strut runs out of bump travel and the lower arm hits the bump stop — struts need ≥ 70 mm (≥ ' + c.susp.rideHeightRange[0] + ' mm as engineered).',
      fixes: [F('Ride height ' + c.susp.rideHeightRange[0] + ' mm', P('suspension.rideHeight_mm', c.susp.rideHeightRange[0])), F('Inboard pushrod suspension', P('suspension.type', 'pushrod'))] };
  });
  rule('suspension.ride-height-range', 'suspension', 'error', 'suspension.rideHeight_mm', 'Ride height within the suspension range', function (c) {
    var r = c.susp.rideHeightRange, h = num(c.b.suspension.rideHeight_mm);
    if (h >= r[0] && h <= r[1]) return null;
    if (c.susp.id === 'macpherson' && h < 70) return null; // covered by the dedicated rule
    var to = clamp(h, r[0], r[1]);
    return { message: c.susp.name + ' adjusts between ' + r[0] + ' and ' + r[1] + ' mm; ' + h + ' mm is out of range.', fixes: [F('Ride height ' + to + ' mm', P('suspension.rideHeight_mm', to))] };
  });
  rule('suspension.offroad-clearance', 'suspension', 'warning', 'suspension.rideHeight_mm', 'Ground clearance for an off-roader', function (c) {
    if (!c.offroad || num(c.b.suspension.rideHeight_mm) >= 140) return null;
    var max = c.susp.rideHeightRange[1];
    var fixes = max >= 140 ? [F('Ride height ' + Math.min(180, max) + ' mm', P('suspension.rideHeight_mm', Math.min(180, max)))] : [];
    fixes.push(F('Adaptive air at 180 mm', P('suspension.type', 'air', 'suspension.rideHeight_mm', 180)));
    return { message: 'Only ' + c.b.suspension.rideHeight_mm + ' mm of clearance on a ' + c.style.name + ' — kerbs, ruts and tracks will tear off the underbody.', fixes: fixes };
  });
  rule('suspension.low-ride', 'suspension', 'info', 'suspension.rideHeight_mm', 'Very low ride height', function (c) {
    var h = num(c.b.suspension.rideHeight_mm);
    if (h >= 80 || c.offroad) return null;
    var to = Math.min(90, c.susp.rideHeightRange[1]);
    return { message: 'At ' + h + ' mm the splitter will strike speed bumps and driveway ramps — fine for the track, painful on the road.' + (c.b.tech.liftSystem ? ' The front-axle lift system helps.' : ''),
      fixes: to >= 80 ? [F('Ride height ' + to + ' mm', P('suspension.rideHeight_mm', to))] : [] };
  });
  rule('suspension.camber-extreme', 'suspension', 'warning', 'suspension.camberFront_deg', 'Extreme negative camber', function (c) {
    var s = c.b.suspension, out = [];
    if (num(s.camberFront_deg) < -3.5) out.push({ id: 'suspension.camber-extreme:front', path: 'suspension.camberFront_deg', message: 'Front camber of ' + s.camberFront_deg + '° wears the inner tread edge in a few thousand road km and hurts braking stability.', fixes: [F('Front camber −2.5°', P('suspension.camberFront_deg', -2.5))] });
    if (num(s.camberRear_deg) < -3.5) out.push({ id: 'suspension.camber-extreme:rear', path: 'suspension.camberRear_deg', message: 'Rear camber of ' + s.camberRear_deg + '° costs traction under acceleration and eats tyres.', fixes: [F('Rear camber −2.0°', P('suspension.camberRear_deg', -2))] });
    return out;
  });
  rule('suspension.positive-camber', 'suspension', 'warning', 'suspension.camberFront_deg', 'Positive camber', function (c) {
    var s = c.b.suspension, out = [];
    if (num(s.camberFront_deg) > 0) out.push({ id: 'suspension.positive-camber:front', path: 'suspension.camberFront_deg', message: 'Positive front camber rolls the tyre onto its outer shoulder in corners — less grip, more wear.', fixes: [F('Front camber −0.5°', P('suspension.camberFront_deg', -0.5))] });
    if (num(s.camberRear_deg) > 0) out.push({ id: 'suspension.positive-camber:rear', path: 'suspension.camberRear_deg', message: 'Positive rear camber makes the rear axle loose at the limit.', fixes: [F('Rear camber −0.5°', P('suspension.camberRear_deg', -0.5))] });
    return out;
  });
  rule('suspension.rear-toe-out', 'suspension', 'warning', 'suspension.toeRear_deg', 'Rear toe-out', function (c) {
    if (num(c.b.suspension.toeRear_deg) >= 0) return null;
    return { message: 'Rear toe-out (' + c.b.suspension.toeRear_deg + '°) makes the car twitchy and unstable under braking and at speed.', fixes: [F('Rear toe-in 0.1°', P('suspension.toeRear_deg', 0.1))] };
  });
  rule('suspension.toe-wear', 'suspension', 'info', 'suspension.toeFront_deg', 'Large front toe', function (c) {
    if (Math.abs(num(c.b.suspension.toeFront_deg)) <= 0.3) return null;
    return { message: c.b.suspension.toeFront_deg + '° of front toe scrubs the tyres and adds rolling resistance.', fixes: [F('Zero front toe', P('suspension.toeFront_deg', 0))] };
  });
  rule('suspension.soft-heavy', 'suspension', 'warning', 'suspension.springFront_nmm', 'Soft springs on a heavy car', function (c) {
    var s = c.b.suspension, avg = (num(s.springFront_nmm) + num(s.springRear_nmm)) / 2;
    if (avg >= 45 || c.est.weight_kg <= 2000 || c.susp.id === 'air') return null;
    return { message: avg + ' N/mm springs under ' + fmt(c.est.weight_kg) + ' kg will wallow and bottom out over crests.',
      fixes: [F('Springs 70 / 80 N/mm', P('suspension.springFront_nmm', 70, 'suspension.springRear_nmm', 80))] };
  });
  rule('suspension.underdamped', 'suspension', 'warning', 'suspension.damping', 'Stiff springs, soft dampers', function (c) {
    var s = c.b.suspension;
    if (num(s.damping) > 2 || Math.max(num(s.springFront_nmm), num(s.springRear_nmm)) <= 140) return null;
    return { message: 'Damping ' + s.damping + '/10 cannot control ' + Math.max(s.springFront_nmm, s.springRear_nmm) + ' N/mm springs — the car will pogo over bumps.',
      fixes: [F('Damping 6', P('suspension.damping', 6))] };
  });
  rule('suspension.lift-air', 'tech', 'info', 'tech.liftSystem', 'Air suspension already lifts', function (c) {
    if (!c.b.tech.liftSystem || c.susp.id !== 'air') return null;
    return { message: 'Adaptive air suspension already raises the body by 40 mm on demand — the separate nose-lift system is redundant.', fixes: [F('Remove nose-lift', P('tech.liftSystem', false))] };
  });
  rule('suspension.track-offroad', 'suspension', 'info', 'suspension.type', 'Track suspension on an off-roader', function (c) {
    if (!c.offroad || !oneOf(c.susp.id, ['pushrod', 'coilover-track'])) return null;
    return { message: c.susp.name + ' on a ' + c.style.name + ' trades away wheel articulation and ground clearance (max ' + c.susp.rideHeightRange[1] + ' mm).' };
  });
  rule('suspension.spring-balance', 'suspension', 'info', 'suspension.springFront_nmm', 'Spring balance', function (c) {
    var s = c.b.suspension, ratio = num(s.springFront_nmm) / Math.max(1, num(s.springRear_nmm));
    if (ratio <= 1.8 && ratio >= 0.55) return null;
    return { message: ratio > 1.8 ? 'Front springs ' + r1(ratio) + '× stiffer than the rear — heavy understeer.' : 'Rear springs ' + r1(1 / ratio) + '× stiffer than the front — snap oversteer on turn-in.' };
  });
  rule('suspension.aero-springs', 'suspension', 'warning', 'suspension.springFront_nmm', 'Aero load on soft springs', function (c) {
    var s = c.b.suspension, avg = (num(s.springFront_nmm) + num(s.springRear_nmm)) / 2, df = c.est.downforce.total;
    if (df <= 250 || avg >= 50) return null;
    return { message: fmt(df) + ' kg of downforce at 200 km/h will compress ' + avg + ' N/mm springs by ~' + fmt(df * 9.81 / 4 / avg) + ' mm — the floor will hit the track.',
      fixes: [F('Springs 100 / 110 N/mm', P('suspension.springFront_nmm', 100, 'suspension.springRear_nmm', 110))] };
  });

  /* ---------------------------------------------------------------- brakes */
  rule('brakes.material-wheel', 'brakes', 'error', 'brakes.material', 'Brake package needs a minimum wheel size', function (c) {
    var minIn = num(c.brake.minWheel_in, 15), d = num(c.b.wheels.diameter_in);
    if (d >= minIn) return null;
    var fit = c.d.brakeMaterials.filter(function (m) { return num(m.minWheel_in, 15) <= d; }).pop();
    var fixes = [F(minIn + '" wheels', P('wheels.diameter_in', minIn))];
    if (fit) fixes.push(F(fit.name + ' brakes', P('brakes.material', fit.id)));
    return { message: c.brake.name + ' brakes need at least ' + minIn + '" wheels to clear the calipers — these are ' + d + '".', fixes: fixes };
  });
  function rotorFit(c, axle) {
    var key = axle === 'front' ? 'frontRotor_mm' : 'rearRotor_mm';
    var rotor = num(c.b.brakes[key]), maxRotor = c.wheelMm - 60;
    if (rotor <= maxRotor) return null;
    var fixes = [], shrink = Math.floor(maxRotor / 2) * 2;
    if (shrink >= 280) fixes.push(F(cap(axle) + ' rotor ' + shrink + ' mm', P('brakes.' + key, shrink)));
    var needIn = Math.ceil((rotor + 60) / 25.4);
    if (needIn <= 23) fixes.push(F(needIn + '" wheels', P('wheels.diameter_in', needIn)));
    return { message: 'A ' + rotor + ' mm ' + axle + ' rotor plus caliper needs ' + (rotor + 60) + ' mm inside the rim, but a ' + c.b.wheels.diameter_in + '" wheel offers ' + fmt(c.wheelMm) + ' mm.', fixes: fixes };
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  rule('brakes.front-rotor-fit', 'brakes', 'error', 'brakes.frontRotor_mm', 'Front rotor must fit inside the wheel', function (c) { return rotorFit(c, 'front'); });
  rule('brakes.rear-rotor-fit', 'brakes', 'error', 'brakes.rearRotor_mm', 'Rear rotor must fit inside the wheel', function (c) { return rotorFit(c, 'rear'); });
  rule('brakes.rear-bias', 'brakes', 'warning', 'brakes.rearRotor_mm', 'Rear rotors larger than the fronts', function (c) {
    var f = num(c.b.brakes.frontRotor_mm), r = num(c.b.brakes.rearRotor_mm);
    if (r <= f) return null;
    var to = Math.max(280, f - 20);
    return { message: 'Rear rotors (' + r + ' mm) larger than the fronts (' + f + ' mm) bias braking rearward — the rear locks first and the car spins under heavy braking.',
      fixes: [F('Rear rotor ' + to + ' mm', P('brakes.rearRotor_mm', to))] };
  });
  rule('brakes.piston-bias', 'brakes', 'info', 'brakes.rearPistons', 'More pistons at the rear', function (c) {
    if (num(c.b.brakes.rearPistons) <= num(c.b.brakes.frontPistons)) return null;
    return { message: c.b.brakes.rearPistons + '-piston rear calipers vs ' + c.b.brakes.frontPistons + '-piston fronts push the brake balance rearward.',
      fixes: [F(c.b.brakes.frontPistons + '-piston rear calipers', P('brakes.rearPistons', c.b.brakes.frontPistons))] };
  });
  rule('brakes.undersized', 'brakes', 'warning', 'brakes.frontRotor_mm', 'Front brakes undersized for the power', function (c) {
    if (c.hp <= 500 || num(c.b.brakes.frontRotor_mm) >= 340) return null;
    var fixes = [];
    if (c.wheelMm - 60 >= 380) fixes.push(F('380 mm front rotors', P('brakes.frontRotor_mm', 380)));
    else fixes.push(F('380 mm rotors on 18" wheels', P('brakes.frontRotor_mm', 380, 'wheels.diameter_in', Math.max(18, num(c.b.wheels.diameter_in)))));
    return { message: c.b.brakes.frontRotor_mm + ' mm front rotors on a ' + fmt(c.hp) + ' hp car will overheat within two hard stops from 200 km/h.', fixes: fixes };
  });
  rule('brakes.fade', 'brakes', 'warning', 'brakes.material', 'Cast-iron brakes will fade', function (c) {
    if (c.brake.id !== 'iron') return null;
    var track = oneOf(c.compound.id, ['track', 'slick']);
    if (c.hp <= 700 && !track) return null;
    var d = num(c.b.wheels.diameter_in);
    var fixes = [];
    if (d >= 17) fixes.push(F('Two-piece floating rotors', P('brakes.material', 'two-piece')));
    if (d >= 19) fixes.push(F('Carbon-ceramic rotors', P('brakes.material', 'carbon-ceramic')));
    if (d >= 16) fixes.push(F('Drilled & slotted rotors', P('brakes.material', 'drilled-slotted')));
    return { message: 'Plain cast-iron rotors ' + (track ? 'on ' + c.compound.name.toLowerCase() + ' tyres' : 'with ' + fmt(c.hp) + ' hp') + ' will fade after a few laps (fade resistance ' + c.brake.fadeResistance + ').', fixes: fixes };
  });
  rule('brakes.abs-off', 'brakes', 'warning', 'brakes.abs', 'ABS disabled', function (c) {
    if (c.b.brakes.abs !== 'off') return null;
    return { message: 'Anti-lock braking is mandatory for road registration in most markets; without it a panic stop locks the wheels and steering is lost.',
      fixes: [F('Sport ABS', P('brakes.abs', 'sport')), F('Race ABS', P('brakes.abs', 'race'))] };
  });
  rule('brakes.ceramic-winter', 'brakes', 'info', 'brakes.material', 'Carbon-ceramics in winter', function (c) {
    if (c.brake.id !== 'carbon-ceramic' || c.compound.id !== 'winter') return null;
    return { message: 'Carbon-ceramic rotors bite poorly when cold and wet — on a winter car the first stop of the morning will feel wooden.' };
  });

  /* ---------------------------------------------------------------- wheels & tyres */
  function tireRim(c, axle) {
    var A = axle === 'front' ? 'Front' : 'Rear';
    var tire = num(c.b.tires['width' + A + '_mm']), rim = num(c.b.wheels['width' + A + '_in']);
    var rr = rimRange(tire);
    if (rim >= rr[0] - 1e-9 && rim <= rr[1] + 1e-9) return null;
    var staggered = c.b.wheels.staggered !== false;
    var t2 = tireForRim(rim), rim2 = rimForTire(tire);
    var tirePatch = staggered ? P('tires.width' + A + '_mm', t2) : P('tires.widthFront_mm', t2, 'tires.widthRear_mm', t2);
    var rimPatch = staggered ? P('wheels.width' + A + '_in', rim2) : P('wheels.widthFront_in', rim2, 'wheels.widthRear_in', rim2);
    return { message: 'A ' + tire + ' mm ' + axle + ' tyre needs a ' + r1(rr[0]) + '–' + r1(rr[1]) + '" rim; on ' + rim + '" it is ' +
      (rim < rr[0] ? 'ballooned — vague steering and the bead can roll off.' : 'stretched — the bead may unseat and the rim is unprotected.'),
      fixes: [F(t2 + ' mm ' + axle + ' tyres', tirePatch), F(rim2 + '" ' + axle + ' rims', rimPatch)] };
  }
  rule('wheels.tire-rim-front', 'wheels', 'error', 'tires.widthFront_mm', 'Front tyre width must suit the rim', function (c) { return tireRim(c, 'front'); });
  rule('wheels.tire-rim-rear', 'wheels', 'error', 'tires.widthRear_mm', 'Rear tyre width must suit the rim', function (c) { return tireRim(c, 'rear'); });
  rule('wheels.arch-clearance', 'wheels', 'error', 'tires.profileFront', 'Wheels and tyres must fit the arches', function (c) {
    var maxD = ARCH_MAX_MM[c.style.id] || 760;
    var df = c.est.tireDiameterFront_mm, dr = c.est.tireDiameterRear_mm, big = Math.max(df, dr);
    if (big <= maxD) return null;
    var d = num(c.b.wheels.diameter_in), t = c.b.tires;
    function fitProfile(width) {
      for (var p = 70; p >= 25; p -= 5) if (tireDiameter_mm(d, width, p) <= maxD) return p;
      return null;
    }
    var pf = fitProfile(t.widthFront_mm), pr = fitProfile(t.widthRear_mm), fixes = [];
    if (pf != null && pr != null) {
      var patch = c.b.wheels.staggered === false ? P('tires.profileFront', Math.min(pf, pr), 'tires.profileRear', Math.min(pf, pr))
        : P('tires.profileFront', Math.min(pf, num(t.profileFront)), 'tires.profileRear', Math.min(pr, num(t.profileRear)));
      fixes.push(F('Lower-profile tyres', patch));
    }
    for (var dd = d - 1; dd >= 15; dd--) {
      if (tireDiameter_mm(dd, t.widthFront_mm, t.profileFront) <= maxD && tireDiameter_mm(dd, t.widthRear_mm, t.profileRear) <= maxD) { fixes.push(F(dd + '" wheels', P('wheels.diameter_in', dd))); break; }
    }
    if (!fixes.length) {
      // Combined fallback: smaller rims AND the tallest profile that fits at that size (keeps ride comfort).
      var fitAt = function (dia, width, cur) {
        for (var p = Math.min(70, num(cur, 70)); p >= 25; p -= 5) if (tireDiameter_mm(dia, width, p) <= maxD) return p;
        return null;
      };
      for (var d2 = d - 1; d2 >= 15 && !fixes.length; d2--) {
        var qf = fitAt(d2, t.widthFront_mm, t.profileFront), qr = fitAt(d2, t.widthRear_mm, t.profileRear);
        if (qf == null || qr == null) continue;
        if (c.b.wheels.staggered === false) { qf = qr = Math.min(qf, qr); }
        fixes.push(F(d2 + '" wheels with ' + qf + (qr !== qf ? '/' + qr : '') + '-profile tyres',
          P('wheels.diameter_in', d2, 'tires.profileFront', qf, 'tires.profileRear', qr)));
      }
      if (!fixes.length) {
        // Last resort: the catalogue's narrowest/lowest legal package for this arch.
        fixes.push(F('17" wheels, 245/35 tyres', P('wheels.diameter_in', 17, 'tires.widthFront_mm', 245, 'tires.widthRear_mm', 245,
          'tires.profileFront', 35, 'tires.profileRear', 35, 'wheels.widthFront_in', 8.5, 'wheels.widthRear_in', 8.5)));
      }
    }
    return { message: 'Overall tyre diameter of ' + fmt(big) + ' mm exceeds the ' + c.style.name + ' wheel-arch limit of ' + maxD + ' mm — the tyres will foul the arches on full lock and bump.', fixes: fixes };
  });
  rule('wheels.rolling-diameter-awd', 'wheels', 'warning', 'tires.profileRear', 'AWD rolling diameters must match', function (c) {
    if (c.dl !== 'awd') return null;
    var df = c.est.tireDiameterFront_mm, dr = c.est.tireDiameterRear_mm, diff = Math.abs(df - dr) / ((df + dr) / 2);
    if (diff <= 0.03) return null;
    var d = num(c.b.wheels.diameter_in), best = null, bestErr = 1e9;
    for (var p = 25; p <= 70; p += 5) {
      var e = Math.abs(tireDiameter_mm(d, c.b.tires.widthRear_mm, p) - df);
      if (e < bestErr) { bestErr = e; best = p; }
    }
    return { message: 'Front and rear tyres differ by ' + r1(diff * 100) + '% in rolling diameter — on AWD the centre coupling will overheat fighting the mismatch.',
      fixes: [F('Rear profile ' + best, P('tires.profileRear', best)), F('Square wheel & tyre set-up', P('wheels.staggered', false))] };
  });
  rule('tires.slicks', 'wheels', 'warning', 'tires.compound', 'Slicks are track-only', function (c) {
    if (c.compound.id !== 'slick') return null;
    return { message: 'Racing slicks are not street legal and aquaplane in standing water (wet μ ' + c.compound.wetMu + ').',
      fixes: [F('Semi-slick Cup tyres (DOT legal)', P('tires.compound', 'track'))] };
  });
  rule('tires.hyper-rating', 'wheels', 'warning', 'tires.speedRating', 'Hypercar speed rating needs a hypercar compound', function (c) {
    if (c.b.tires.speedRating !== 'hyper' || oneOf(c.compound.id, ['super-sport', 'track', 'slick'])) return null;
    return { message: 'The 450 km/h hypercar construction is only made in Super Sport and Cup compounds — not as ' + c.compound.name + ' tyres.',
      fixes: [F('Super Sport tyres', P('tires.compound', 'super-sport')), F('(Y) 360 km/h rating', P('tires.speedRating', 'Y+'))] };
  });
  rule('tires.grip-power', 'wheels', 'warning', 'tires.compound', 'Low-grip tyres on a powerful car', function (c) {
    if (!oneOf(c.compound.id, ['eco', 'all-season', 'touring', 'winter']) || c.hp <= 550) return null;
    return { message: c.compound.name + ' tyres (μ ' + c.compound.mu + ') cannot transmit ' + fmt(c.hp) + ' hp — and many carry a speed rating below this car’s top speed.',
      fixes: [F('Max Performance tyres', P('tires.compound', 'performance')), F('Super Sport tyres', P('tires.compound', 'super-sport'))] };
  });
  rule('wheels.fwd-stagger', 'wheels', 'info', 'tires.widthRear_mm', 'Wide rears on a front-driver', function (c) {
    if (c.dl !== 'fwd' || num(c.b.tires.widthRear_mm) <= num(c.b.tires.widthFront_mm)) return null;
    return { message: 'Wider rear tyres on a front-wheel-drive car add understeer and rotating mass where there is no torque to use them.',
      fixes: [F('Square set-up', P('wheels.staggered', false))] };
  });
  rule('wheels.steel-size', 'wheels', 'error', 'wheels.material', 'Pressed-steel wheels top out at 18"', function (c) {
    if (c.wheelMat.id !== 'steel' || num(c.b.wheels.diameter_in) <= 18) return null;
    return { message: 'Pressed-steel wheels are only manufactured up to 18"; a ' + c.b.wheels.diameter_in + '" steel wheel does not exist.',
      fixes: [F('Cast aluminium', P('wheels.material', 'cast')), F('18" steel wheels', P('wheels.diameter_in', 18))] };
  });
  rule('wheels.beadlock', 'wheels', 'warning', 'wheels.design', 'Beadlocks are off-road equipment', function (c) {
    if (c.wheelDesign.id !== 'beadlock') return null;
    return { message: 'True beadlock rings are not DOT/ECE approved for highway use in many markets and need re-torquing every outing.',
      fixes: [F('Sei Monoblock rally wheel', P('wheels.design', 'monoblock-6'))] };
  });
  rule('wheels.centerlock-material', 'wheels', 'warning', 'wheels.material', 'Centre-lock needs forged wheels', function (c) {
    if (c.wheelDesign.style !== 'centerlock' || !oneOf(c.wheelMat.id, ['steel', 'cast'])) return null;
    return { message: 'The centre-lock hub clamps with 600 Nm on a single nut — only forged hubs survive it, ' + c.wheelMat.name.toLowerCase() + ' will crack.',
      fixes: [F('Forged aluminium', P('wheels.material', 'forged')), F('Forged magnesium', P('wheels.material', 'magnesium'))] };
  });
  rule('wheels.rubber-band', 'wheels', 'info', 'tires.profileFront', 'Very low tyre profile', function (c) {
    if (num(c.b.wheels.diameter_in) < 22 || Math.min(num(c.b.tires.profileFront), num(c.b.tires.profileRear)) > 30) return null;
    return { message: c.b.wheels.diameter_in + '" rims with ' + Math.min(c.b.tires.profileFront, c.b.tires.profileRear) + '-profile tyres leave little sidewall — expect a firm ride and kerbed, bent rims on potholes.' };
  });
  rule('wheels.aero-cooling', 'wheels', 'info', 'wheels.design', 'Closed wheels restrict brake cooling', function (c) {
    if (c.wheelDesign.style !== 'aero-disc' || !oneOf(c.compound.id, ['track', 'slick'])) return null;
    return { message: 'Closed aero wheel faces trap brake heat — on track tyres expect fade sooner. Open-spoke designs breathe better.' };
  });

  /* ---------------------------------------------------------------- aero */
  rule('aero.wing-no-splitter', 'aero', 'warning', 'aero.splitter', 'Big wing without front aero', function (c) {
    var wg = c.est.downforce.wing;
    if (num(wg.downforce_kg_at_200) < 150 || c.b.aero.splitter !== 'none') return null;
    return { message: 'The ' + wg.name + ' adds ' + wg.downforce_kg_at_200 + ' kg at the rear with nothing at the front — high-speed understeer and a light nose.',
      fixes: [F('Carbon splitter', P('aero.splitter', 'carbon')), F('Race splitter', P('aero.splitter', 'race'))] };
  });
  rule('aero.balance', 'aero', 'warning', 'aero.splitter', 'Aerodynamic balance', function (c) {
    var a = c.est.downforce;
    if (c.b.aero.splitter === 'none' || a.rear < 150 || a.rear <= a.front * 4) return null;
    return { message: 'Aero balance is ' + fmt(a.front / a.total * 100) + '% front (' + fmt(a.front) + ' / ' + fmt(a.rear) + ' kg) — the car will understeer more the faster you go.',
      fixes: [F('Race splitter + canards', P('aero.splitter', 'race', 'aero.canards', true)), F('Reduce wing angle to 4°', P('aero.wingAngle_deg', 4))] };
  });
  rule('aero.wing-angle', 'aero', 'warning', 'aero.wingAngle_deg', 'Wing angle near stall', function (c) {
    if (!c.est.downforce.wing.adjustable || num(c.b.aero.wingAngle_deg) <= 16) return null;
    return { message: c.b.aero.wingAngle_deg + '° of wing angle is close to stall — drag rises steeply while downforce flattens off.', fixes: [F('Wing angle 12°', P('aero.wingAngle_deg', 12))] };
  });
  rule('aero.canards-no-splitter', 'aero', 'info', 'aero.canards', 'Canards work with a splitter', function (c) {
    if (!c.b.aero.canards || c.b.aero.splitter !== 'none') return null;
    return { message: 'Dive planes generate vortices that seal a splitter — without one they mostly add drag.', fixes: [F('Front lip splitter', P('aero.splitter', 'lip'))] };
  });
  rule('aero.active-without-wing', 'aero', 'info', 'aero.activeAero', 'Active aero without a moving wing', function (c) {
    if (!c.b.aero.activeAero || c.est.downforce.wing.adjustable) return null;
    return { message: 'Without an adjustable wing, active aero only operates the underbody flaps — most of its benefit is lost.', fixes: [F('Active aero wing', P('aero.wing', 'active')), F('Disable active aero', P('aero.activeAero', false))] };
  });
  rule('aero.ev-drag', 'aero', 'info', 'aero.wing', 'High-drag wing on an EV', function (c) {
    if (!c.isEV || num(c.est.downforce.wing.dragDelta) < 0.03) return null;
    return { message: 'The ' + c.est.downforce.wing.name + ' adds ' + r2(c.est.downforce.wing.dragDelta) + ' Cd — roughly ' + fmt(c.est.downforce.wing.dragDelta / 0.3 * 60) + '% less motorway range than without it.' };
  });
  rule('aero.utility-wing', 'aero', 'info', 'aero.wing', 'Race wing on a utility body', function (c) {
    if (!c.utility || !oneOf(c.b.aero.wing, ['swan-neck', 'gt-wing', 'biplane'])) return null;
    return { message: 'A ' + nameOf('aero.wings', c.b.aero.wing) + ' on a ' + c.style.name + ' sits in turbulent air off the roof — mostly drag, little downforce.', fixes: [F('Remove the wing', P('aero.wing', 'none'))] };
  });

  /* ---------------------------------------------------------------- weight */
  rule('weight.cage-rear-seats', 'weight', 'error', 'weight.rollCage', 'A full cage removes the rear seats', function (c) {
    var w = c.b.weight;
    if (w.rollCage !== 'full' || !(w.rearSeats || num(c.b.body.seats) > 2)) return null;
    var two = (c.style.seatOptions || []).filter(function (s) { return s <= 2; }).pop();
    var fixes = [];
    if (two) fixes.push(F('Two seats, rear bench deleted', P('body.seats', two, 'weight.rearSeats', false)));
    fixes.push(F('Bolt-in half cage', P('weight.rollCage', 'half')));
    return { message: 'The FIA welded cage’s rear stays and diagonals run through the rear-seat space — it cannot be fitted with ' + c.b.body.seats + ' seats.', fixes: fixes };
  });
  rule('weight.cage-harness', 'interior', 'warning', 'interior.harness', 'Cage without harness', function (c) {
    if (c.b.weight.rollCage !== 'full' || c.b.interior.harness) return null;
    return { message: 'With a full cage and only inertia-reel belts your helmet can reach the cage tubes in a crash. Fit a harness.', fixes: [F('Six-point harness', P('interior.harness', true))] };
  });
  rule('weight.ballast-front', 'weight', 'info', 'weight.ballastPosition', 'Ballast in the nose of a front-engined car', function (c) {
    if (!c.hasICE || num(c.b.weight.ballast_kg) < 40 || c.b.weight.ballastPosition !== 'front' || c.b.engine.position !== 'front') return null;
    return { message: c.b.weight.ballast_kg + ' kg of ballast ahead of the front axle on a front-engined car makes it nose-heavy.', fixes: [F('Centre ballast', P('weight.ballastPosition', 'center'))] };
  });
  rule('weight.lithium-diesel', 'weight', 'warning', 'weight.battery', 'Lithium starter on a diesel', function (c) {
    if (!c.hasICE || c.fuel.id !== 'diesel' || c.b.weight.battery !== 'lithium') return null;
    return { message: 'The small lithium starter battery lacks the cold-cranking amps to turn a ' + c.b.engine.compression + ':1 diesel on a frosty morning.', fixes: [F('Lead-acid 12V battery', P('weight.battery', 'lead'))] };
  });
  rule('weight.gross-mass', 'weight', 'warning', null, 'Over 3.5 tonnes', function (c) {
    if (c.est.weight_kg <= 3500) return null;
    return { message: 'At about ' + fmt(c.est.weight_kg) + ' kg this exceeds 3,500 kg — a standard car licence (EU category B) no longer covers it.' };
  });
  rule('weight.polycarbonate-tint', 'weight', 'info', 'exterior.windowTint_pct', 'Dark tint on polycarbonate', function (c) {
    if (c.b.weight.glass !== 'polycarbonate' || num(c.b.exterior.windowTint_pct) <= 50) return null;
    return { message: 'Polycarbonate windows cannot take film tint — dark tints must be moulded in and scratch easily.', fixes: [F('Tint 35%', P('exterior.windowTint_pct', 35))] };
  });
  rule('weight.deadening-luxury', 'weight', 'info', 'weight.soundDeadening', 'Luxury cabin without sound deadening', function (c) {
    if (c.b.weight.soundDeadening !== false || !(num(c.uph.luxury) >= 0.8 || c.seat.id === 'lounge')) return null;
    return { message: 'Deleting sound deadening saves 22 kg but turns a ' + c.uph.name + ' cabin into a drum at motorway speed.', fixes: [F('Restore sound deadening', P('weight.soundDeadening', true))] };
  });

  /* ---------------------------------------------------------------- exterior */
  rule('exterior.tint', 'exterior', 'warning', 'exterior.windowTint_pct', 'Window tint legal limit', function (c) {
    if (num(c.b.exterior.windowTint_pct) <= 50) return null;
    return { message: c.b.exterior.windowTint_pct + '% tint leaves only ' + (100 - c.b.exterior.windowTint_pct) + '% light transmission — below the legal minimum for front side glass.',
      fixes: [F('Tint 35%', P('exterior.windowTint_pct', 35))] };
  });
  rule('exterior.contrast-roof-same', 'exterior', 'info', 'exterior.roofColor', 'Contrast roof matches the body', function (c) {
    if (c.b.exterior.roof !== 'contrast' || hexDist(c.b.exterior.roofColor, c.b.exterior.paint) > 24) return null;
    return { message: 'The contrast roof colour is virtually the body colour — you are paying for a two-tone that nobody will see.', fixes: [F('Body-colour roof', P('exterior.roof', 'body')), F('Gloss black roof', P('exterior.roof', 'black'))] };
  });
  rule('exterior.stripe-invisible', 'exterior', 'info', 'exterior.stripeColor', 'Stripe colour matches the paint', function (c) {
    if (c.b.exterior.stripe === 'none' || hexDist(c.b.exterior.stripeColor, c.b.exterior.paint) > 24) return null;
    var to = contrastOf(c.b.exterior.paint);
    return { message: 'The ' + nameOf('stripes', c.b.exterior.stripe).toLowerCase() + ' is the same colour as the paint and will be invisible.', fixes: [F('Contrasting stripe', P('exterior.stripeColor', to))] };
  });
  rule('exterior.chrome-glare', 'exterior', 'info', 'exterior.finish', 'Mirror-chrome paint', function (c) {
    if (c.b.exterior.finish !== 'chrome') return null;
    return { message: 'Liquid chrome reflects sunlight into other drivers’ eyes; several markets restrict mirror-finish wraps and paints.' };
  });
  rule('exterior.open-top-roof', 'exterior', 'info', 'exterior.roof', 'Roof option on a roadster', function (c) {
    if (c.style.id !== 'roadster' || c.b.exterior.roof === 'body') return null;
    return { message: 'On the roadster the ' + nameOf('roofTypes', c.b.exterior.roof).toLowerCase() + ' option applies to the removable hard-top.' };
  });
  rule('exterior.livery-number', 'exterior', 'info', 'exterior.livery_number', 'Race number without a roundel', function (c) {
    if (!c.b.exterior.livery_number || oneOf(c.b.exterior.stripe, ['le-mans', 'racing-dual', 'gradient'])) return null;
    return { message: 'Race number #' + c.b.exterior.livery_number + ' looks best on a livery with a roundel.', fixes: [F('Le Mans livery', P('exterior.stripe', 'le-mans'))] };
  });
  rule('exterior.halogen-power', 'exterior', 'info', 'exterior.lights', 'Halogen lamps on a fast car', function (c) {
    if (c.b.exterior.lights !== 'halogen' || c.est.topSpeed_kph < 250) return null;
    return { message: 'Halogen low beams reach ~60 m — less than three seconds of warning at ' + fmt(c.est.topSpeed_kph) + ' km/h.', fixes: [F('Full LED', P('exterior.lights', 'led')), F('Matrix LED', P('exterior.lights', 'matrix'))] };
  });
  rule('exterior.caliper-hidden', 'exterior', 'info', 'exterior.caliperColor', 'Calipers hidden behind closed wheels', function (c) {
    if (c.wheelDesign.style !== 'aero-disc' || !U().luminance || U().luminance(c.b.exterior.caliperColor) < 0.25) return null;
    return { message: 'The closed ' + c.wheelDesign.name + ' face hides the calipers — your custom caliper colour will barely be visible.' };
  });

  /* ---------------------------------------------------------------- interior */
  rule('interior.harness-seats', 'interior', 'warning', 'interior.seatType', 'Harness needs bucket seats', function (c) {
    if (!c.b.interior.harness || !oneOf(c.seat.id, ['comfort', 'lounge', 'sport'])) return null;
    return { message: c.seat.name + ' have no harness slots — the shoulder straps would run over a reclining backrest and submarine you in a crash.',
      fixes: [F('Sport buckets', P('interior.seatType', 'bucket')), F('Carbon buckets', P('interior.seatType', 'carbon-bucket'))] };
  });
  rule('interior.race-shell-harness', 'interior', 'warning', 'interior.harness', 'Race shells need a harness', function (c) {
    if (c.seat.id !== 'race-shell' || c.b.interior.harness) return null;
    return { message: 'FIA race shells are homologated with a multi-point harness — a three-point belt does not hold you in them.', fixes: [F('Six-point harness', P('interior.harness', true))] };
  });
  rule('interior.lounge-fit', 'interior', 'error', 'interior.seatType', 'Lounge seats need a big cabin', function (c) {
    if (c.seat.id !== 'lounge' || !oneOf(c.style.id, ['hypercar', 'roadster', 'coupe', 'hatchback'])) return null;
    return { message: 'Reclining lounge thrones need ~300 mm more legroom than the ' + c.style.name + ' cabin offers.', fixes: [F('Comfort seats', P('interior.seatType', 'comfort')), F('Sport seats', P('interior.seatType', 'sport'))] };
  });
  rule('interior.quick-release-airbag', 'interior', 'warning', 'interior.steering', 'Race wheel has no airbag', function (c) {
    if (c.b.interior.steering !== 'race-quick-release') return null;
    return { message: 'The quick-release race wheel has no driver airbag — not road legal in most markets.', fixes: [F('Flat-bottom wheel', P('interior.steering', 'flat-bottom'))] };
  });
  rule('interior.yoke-manual', 'interior', 'warning', 'interior.steering', 'Yoke with a manual gearbox', function (c) {
    if (c.b.interior.steering !== 'yoke' || c.trans.id !== 'manual') return null;
    return { message: 'A yoke with a manual gearbox means hand-over-hand parking while working the clutch — the variable-ratio rack cannot fully compensate.', fixes: [F('Round wheel', P('interior.steering', 'round'))] };
  });
  rule('interior.open-top-headliner', 'interior', 'info', 'interior.headliner', 'Headliner on a roadster', function (c) {
    if (c.style.id !== 'roadster' || c.b.interior.headliner === 'cloth') return null;
    return { message: 'The roadster’s soft top has only a thin acoustic lining — the ' + nameOf('headliners', c.b.interior.headliner).toLowerCase() + ' headliner only covers the hard-top.', fixes: [F('Cloth headliner', P('interior.headliner', 'cloth'))] };
  });

  /* ---------------------------------------------------------------- tech */
  rule('tech.screen-delete-adas', 'tech', 'error', 'tech.screen_in', 'Assisted driving needs a display', function (c) {
    if (num(c.b.tech.screen_in) !== 0 || !oneOf(c.b.tech.adas, ['plus', 'pilot', 'autonomous-l3'])) return null;
    return { message: nameOf('adasLevels', c.b.tech.adas) + ' needs a centre display for camera views and take-over requests.',
      fixes: [F('10" touchscreen', P('tech.screen_in', 10)), F('Driver Assist only', P('tech.adas', 'assist'))] };
  });
  rule('tech.adas-abs', 'tech', 'error', 'brakes.abs', 'Driver assistance needs ABS', function (c) {
    if (c.b.brakes.abs !== 'off' || c.b.tech.adas === 'none') return null;
    return { message: 'Emergency braking and adaptive cruise modulate the brakes through the ABS unit — ' + nameOf('adasLevels', c.b.tech.adas) + ' cannot work with ABS off.',
      fixes: [F('Standard ABS', P('brakes.abs', 'standard')), F('No assistance', P('tech.adas', 'none'))] };
  });
  rule('tech.climate-zones', 'tech', 'error', 'tech.climateZones', 'Climate zones vs seats', function (c) {
    var z = num(c.b.tech.climateZones), maxZ = Math.max(1, Math.min(4, num(c.b.body.seats, 2)));
    if (z >= 1 && z <= maxZ) return null;
    var to = clamp(Math.round(z), 1, maxZ);
    return { message: z + ' climate zones in a ' + c.b.body.seats + '-seat cabin is not possible (max ' + maxZ + ').', fixes: [F(to + ' zone' + (to > 1 ? 's' : ''), P('tech.climateZones', to))] };
  });
  rule('tech.lift-unnecessary', 'tech', 'info', 'tech.liftSystem', 'Nose-lift on a tall car', function (c) {
    if (!c.b.tech.liftSystem || num(c.b.suspension.rideHeight_mm) < 150) return null;
    return { message: 'With ' + c.b.suspension.rideHeight_mm + ' mm of ride height the nose-lift system is unnecessary weight.', fixes: [F('Remove nose-lift', P('tech.liftSystem', false))] };
  });
  rule('tech.telemetry-suggest', 'tech', 'info', 'tech.telemetry', 'Track tyres without telemetry', function (c) {
    if (c.b.tech.telemetry || !oneOf(c.compound.id, ['track', 'slick'])) return null;
    return { message: 'You have specified ' + c.compound.name.toLowerCase() + ' tyres — the telemetry logger records lap times, tyre temperatures and G-traces.', fixes: [F('Add track telemetry', P('tech.telemetry', true))] };
  });
  rule('tech.night-vision-halogen', 'tech', 'info', 'tech.nightVision', 'Night vision with halogen lamps', function (c) {
    if (!c.b.tech.nightVision || c.b.exterior.lights !== 'halogen') return null;
    return { message: 'Night vision highlights pedestrians the halogen lamps cannot reach — matrix LED would light them for you.', fixes: [F('Matrix LED', P('exterior.lights', 'matrix'))] };
  });
  rule('tech.l3-open-top', 'tech', 'warning', 'tech.adas', 'L3 autonomy on an open car', function (c) {
    if (c.b.tech.adas !== 'autonomous-l3' || c.style.id !== 'roadster') return null;
    return { message: 'Autonomous L3 needs the roof-mounted lidar and rain sensor — the roadster has no fixed roof to carry them.', fixes: [F('Highway Pilot (L2+)', P('tech.adas', 'pilot'))] };
  });
  rule('tech.audio-straight-pipe', 'tech', 'info', 'tech.audio', 'Concert hall vs straight pipe', function (c) {
    if (!c.hasICE || c.exhaust.id !== 'straight-pipe' || !oneOf(c.b.tech.audio, ['reference', 'concert'])) return null;
    return { message: 'At ' + c.exhaust.loudness_db + ' dB of straight-pipe the ' + nameOf('audioSystems', c.b.tech.audio) + ' system will be inaudible above 3,000 rpm.' };
  });
  rule('tech.ev-no-display', 'tech', 'warning', 'tech.digitalCluster', 'EV without any display', function (c) {
    if (!c.isEV || num(c.b.tech.screen_in) !== 0 || c.b.tech.digitalCluster || c.b.tech.hud) return null;
    return { message: 'An electric car without a screen, digital cluster or HUD cannot show state of charge, range or charging status.', fixes: [F('Digital instrument cluster', P('tech.digitalCluster', true))] };
  });

  /* ======================================================================
     VALIDATE
     ====================================================================== */
  var SEV_RANK = { error: 0, warning: 1, info: 2 };

  function runRule(r, c) {
    var res;
    try { res = r.check(c); } catch (e) { return []; }
    if (!res) return [];
    var list = Array.isArray(res) ? res : [res];
    return list.filter(Boolean).map(function (x) {
      return {
        id: x.id || r.id, rule: r.id, severity: x.severity || r.severity, section: x.section || r.section,
        path: x.path !== undefined ? x.path : r.path, title: r.title, message: x.message, _fixes: x.fixes || []
      };
    });
  }

  function verifyFix(r, issueId, raw, patch, usePhysics) {
    var next = applyPatch(raw, patch);
    var nc = context(next, null, usePhysics);
    var again = runRule(r, nc);
    for (var i = 0; i < again.length; i++) if (again[i].id === issueId) return false;
    return true;
  }

  function validate(build, metrics, opts) {
    opts = opts || {};
    if (!D()) return [];
    var usePhysics = opts.physics !== false;
    var verify = opts.verifyFixes !== false;
    var raw = isObj(build) ? build : {};
    var c = context(raw, metrics || null, usePhysics);
    var minRank = opts.severity ? SEV_RANK[opts.severity] : 9;
    var out = [];
    RULES.forEach(function (r) {
      if (opts.section && r.section !== opts.section) return;
      runRule(r, c).forEach(function (iss) {
        if (SEV_RANK[iss.severity] > minRank) return;
        var fixes = iss._fixes;
        delete iss._fixes;
        for (var i = 0; i < fixes.length; i++) {
          var f = fixes[i];
          if (!f || !f[1]) continue;
          if (!verify || verifyFix(r, iss.id, raw, f[1], usePhysics)) { iss.fix = { label: f[0], patch: f[1] }; break; }
        }
        out.push(iss);
      });
    });
    out.sort(function (a, b) { return SEV_RANK[a.severity] - SEV_RANK[b.severity]; });
    return out;
  }

  /* ======================================================================
     LEGALITY
     ====================================================================== */
  function legality(build, metrics) {
    if (!D()) return { streetLegal: true, reasons: [], details: [], classification: 'road', summary: 'Unknown' };
    var c = context(isObj(build) ? build : {}, metrics || null, false);
    var b = c.b, det = [];
    function add(id, path, message) { det.push({ id: id, path: path, section: sectionOf(path), message: message }); }
    if (c.compound.streetLegal === false) add('legal.tyres', 'tires.compound', c.compound.name + ' tyres are not DOT/ECE approved for public roads.');
    if (c.hasICE && num(c.exhaust.loudness_db) > 100) add('legal.noise', 'engine.exhaust', c.exhaust.name + ' (' + c.exhaust.loudness_db + ' dB) exceeds the drive-by noise limit and removes the catalysts.');
    if (c.hasICE && c.tune.id === 'time-attack') add('legal.emissions', 'engine.tune', 'The Time Attack map runs anti-lag and disables emissions controls.');
    if (b.brakes.abs === 'off') add('legal.abs', 'brakes.abs', 'Anti-lock braking is mandatory on new road cars.');
    if (b.interior.steering === 'race-quick-release') add('legal.airbag', 'interior.steering', 'The quick-release race wheel has no driver airbag.');
    if (num(b.exterior.windowTint_pct) > 50) add('legal.tint', 'exterior.windowTint_pct', 'Window tint of ' + b.exterior.windowTint_pct + '% is darker than the legal limit (50%).');
    if (c.chassis && b.weight.rollCage === 'full' && !b.interior.harness) add('legal.cage', 'weight.rollCage', 'An unpadded full roll cage without harnesses fails the road-car head-impact test.');
    if (num(b.suspension.rideHeight_mm) < 60) add('legal.clearance', 'suspension.rideHeight_mm', 'Ride height below 60 mm fails minimum ground-clearance rules.');
    if (b.exterior.lights === 'laser' && b.tech.adas === 'none') add('legal.laser', 'exterior.lights', 'Laser high beams require the camera-based auto-dipping of an assistance package.');
    var reasons = det.map(function (x) { return x.message; });
    var trackOnly = det.some(function (x) { return oneOf(x.id, ['legal.tyres', 'legal.noise', 'legal.emissions']); });
    return {
      streetLegal: det.length === 0,
      reasons: reasons,
      details: det,
      classification: det.length === 0 ? 'road' : 'track',
      trackOnly: trackOnly,
      summary: det.length === 0 ? 'Road legal as configured' : (trackOnly ? 'Track use only' : 'Not road legal — ' + det.length + ' item' + (det.length > 1 ? 's' : '') + ' to resolve')
    };
  }

  /* ======================================================================
     COMPATIBLE OPTIONS
     ====================================================================== */
  function pathForKey(key) {
    var pcs = (D() && D().pathCollections) || {};
    if (pcs[key]) return key;
    var special = { differentials: 'drivetrain.rearDiff', doorOptions: 'body.doors', seatOptions: 'body.seats', pistonOptions: 'brakes.frontPistons' };
    if (special[key]) return special[key];
    var hit = null;
    Object.keys(pcs).forEach(function (p) { if (!hit && pcs[p] === key) hit = p; });
    return hit || key;
  }
  function optionsFor(build, path) {
    var d = D(), pcs = d.pathCollections || {};
    if (pcs[path]) return listOf(pcs[path]).map(function (o) { return { id: o.id, name: o.name }; });
    var style = find('bodyStyles', get(build, 'body.style')) || d.bodyStyles[0];
    var tr = find('transmissions', get(build, 'transmission.type')) || d.transmissions[0];
    var prim = null;
    if (path === 'body.doors') prim = style.doorOptions;
    else if (path === 'body.seats') prim = style.seatOptions;
    else if (path === 'brakes.frontPistons' || path === 'brakes.rearPistons') prim = d.pistonOptions;
    else if (path === 'transmission.gears') { prim = []; for (var g = tr.gearRange[0]; g <= tr.gearRange[1]; g++) prim.push(g); }
    else if (path === 'wheels.diameter_in') { prim = []; for (var w = 15; w <= 23; w++) prim.push(w); }
    else if (path === 'tech.climateZones') prim = [1, 2, 3, 4];
    else if (path === 'engine.motors') prim = [1, 2, 3, 4];
    return (prim || []).map(function (v) { return { id: v, name: String(v) }; });
  }

  function optionStatus(build, key) {
    if (typeof build === 'string' && isObj(key)) { var t = build; build = key; key = t; }
    if (!D() || !key) return [];
    var base = isObj(build) ? build : (CB.state && CB.state.get ? CB.state.get() : template());
    var path = pathForKey(String(key));
    var current = get(base, path);
    var baseErr = {};
    validate(base, null, { verifyFixes: false, physics: false, severity: 'error' }).forEach(function (i) { baseErr[i.id] = true; });
    return optionsFor(base, path).map(function (o) {
      if (sameId(o.id, current)) return { id: o.id, name: o.name, ok: true, reason: null };
      var cand = applyPatch(base, patchOf(path, o.id));
      if (!sameId(get(cand, path), o.id)) {
        var rawCand = merge(base, patchOf(path, o.id));
        var rawErr = validate(rawCand, null, { verifyFixes: false, physics: false, severity: 'error' }).filter(function (i) { return !baseErr[i.id]; });
        return { id: o.id, name: o.name, ok: false, reason: rawErr.length ? rawErr[0].message : 'Not available with the current configuration.' };
      }
      var errs = validate(cand, null, { verifyFixes: false, physics: false, severity: 'error' }).filter(function (i) { return !baseErr[i.id]; });
      return { id: o.id, name: o.name, ok: errs.length === 0, reason: errs.length ? errs[0].message : null };
    });
  }

  function compatibleOptions(build, key) {
    var st = optionStatus(build, key);
    var set = new Set();
    st.forEach(function (s) {
      if (s.ok) set.add(s.id);
      try { set[String(s.id)] = s.ok ? true : (s.reason || 'Not compatible with the current build'); } catch (e) { /* frozen */ }
    });
    return set;
  }

  /* ======================================================================
     EXPORT
     ====================================================================== */
  CB.rules = {
    validate: validate,
    legality: legality,
    compatibleOptions: compatibleOptions,
    optionStatus: optionStatus,
    applyFix: applyFix,
    estimate: function (build, metrics) { return estimate(merge(template(), isObj(build) ? build : {}), metrics || null); },
    tireDiameter_mm: tireDiameter_mm,
    rimRange: rimRange,
    list: function () { return RULES.map(function (r) { return { id: r.id, section: r.section, severity: r.severity, path: r.path, title: r.title }; }); },
    get count() { return RULES.length; },
    constants: { archMax_mm: ARCH_MAX_MM, evPeakCMult: EV_PEAK_C_MULT, hybridPeakCMult: HYBRID_PEAK_C_MULT }
  };
})();

if (typeof module !== 'undefined') module.exports = CB.rules;

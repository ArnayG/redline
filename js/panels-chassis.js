/* ==========================================================================
   FORGE Atelier — js/panels-chassis.js
   Registers the five "Chassis" panels: suspension, brakes, wheels (wheels + tyres), aero, weight.

   Architecture (mirrors js/panels-powertrain.js)
   ------------
   * A pure calculation layer, CB.chassisCalc (also module.exports in Node), derives everything these panels
     show that CB.physics does not publish: tyre geometry & size strings, speedometer error, rim/tyre fit,
     unsprung mass, wheel/ride rates, natural frequencies, roll-stiffness distribution, handling balance,
     brake torque / bias / thermal capacity / rotor-in-wheel clearance, per-element aero downforce and
     balance, and the weight-reduction ledger. It is deterministic and DOM-free (tests/panels-chassis.test.js).
   * Every panel is created through makePanel(), which gives it a runtime object P:
       P.root      panel root element;   P.build  latest build;   P.metrics  physics metrics merged over a
                   local estimate (so the panels stay useful even when CB.physics is unavailable)
       P.watch(node, fn(build, metrics, change), dispose?)  metric-driven widgets; re-run on every update()
                   and pruned automatically when their node leaves P.root.
   * Controls built with CB.ui follow the ui-kit sync strategy (data-cb-path + .sync(build)). update()
     calls CB.ui.syncAll(P.root, build) + P.refresh() and never rebuilds DOM, so slider drags are never
     interrupted. Diagrams are built once and then mutated in place (attributes / transforms / text).
   * Defensive: CB.physics, CB.rules, CB.pricing and CB.charts are optional.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  /* ======================================================================
     PURE HELPERS (no DOM; CB.data / CB.util resolved lazily)
     ====================================================================== */
  var G = 9.81, RHO = 1.225;
  function D() { return CB.data || {}; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, fb) { v = Number(v); return isFinite(v) ? v : fb; }
  function round(n, d) { var k = Math.pow(10, d || 0); return Math.round(n * k) / k; }
  function getp(obj, path, fb) {
    var parts = String(path).split('.'), cur = obj;
    for (var i = 0; i < parts.length; i++) { if (cur == null) return fb; cur = cur[parts[i]]; }
    return cur === undefined || cur === null ? fb : cur;
  }
  function find(coll, id) { try { return D().find ? D().find(coll, id) : undefined; } catch (e) { return undefined; } }
  function list(coll) { try { return (D().list && D().list(coll)) || []; } catch (e) { return []; } }
  function optPrice(key, fb) { var o = D().options; return o && o[key] != null ? o[key] : fb; }
  function optWeight(key, fb) { var o = D().optionWeights; return o && o[key] != null ? o[key] : fb; }
  function axleKey(axle) { return axle === 'rear' ? 'Rear' : 'Front'; }

  var defaultCache = null;
  function defaults() {
    if (!defaultCache) { try { defaultCache = D().defaultBuild(); } catch (e) { defaultCache = {}; } }
    return defaultCache;
  }

  /* ---------------------------------------------------------------- tyres */
  var SPEED_RATING = { eco: 'H', 'all-season': 'V', winter: 'T', touring: 'V', performance: 'Y', 'super-sport': '(Y)', track: 'Y', slick: '—' };
  var SPEED_RATING_KPH = { T: 190, H: 210, V: 240, W: 270, Y: 300, '(Y)': 330, '—': null };

  /** Ideal / approved rim widths (inches) for a tyre section width. ETRTO-flavoured rule of thumb. */
  function rimRange(tireWidth_mm) {
    var wIn = tireWidth_mm / 25.4;
    var min = Math.round(wIn * 0.74 * 2) / 2, max = Math.round(wIn * 0.97 * 2) / 2, ideal = Math.round(wIn * 0.86 * 2) / 2;
    return { min: min, max: max, ideal: ideal };
  }

  /** Fit of a rim/tyre pairing: 'ok' | 'stretched' (rim too wide) | 'ballooned' (rim too narrow). */
  function rimFit(rimWidth_in, tireWidth_mm) {
    var r = rimRange(tireWidth_mm);
    var status = rimWidth_in > r.max ? 'stretched' : rimWidth_in < r.min ? 'ballooned' : 'ok';
    var span = Math.max(0.5, r.max - r.min);
    return { status: status, min: r.min, max: r.max, ideal: r.ideal, frac: clamp((rimWidth_in - r.min) / span, -0.4, 1.4), off_in: status === 'stretched' ? rimWidth_in - r.max : status === 'ballooned' ? r.min - rimWidth_in : 0 };
  }

  /**
   * tireGeom(build, axle) → full geometry of one axle's wheel + tyre.
   * { width_mm, profile, rim_in, rimWidth_in, sidewall_mm, diameter_mm, diameter_in, circumference_mm, revsPerKm,
   *   size ('255/35 ZR19 94Y XL'), short ('255/35 R19'), loadIndex, speedRating, speedRatingKph, xl, fit }
   */
  function tireGeom(b, axle) {
    var A = axleKey(axle);
    var w = num(getp(b, 'tires.width' + A + '_mm'), 255);
    var p = num(getp(b, 'tires.profile' + A), 35);
    var rim = num(getp(b, 'wheels.diameter_in'), 19);
    var rimW = num(getp(b, 'wheels.width' + A + '_in'), 9);
    var comp = String(getp(b, 'tires.compound', 'performance'));
    var side = w * p / 100;
    var dia = rim * 25.4 + 2 * side;
    var circ = Math.PI * dia;
    var sr = SPEED_RATING[comp] || 'V';
    var li = clamp(Math.round(83 + (w - 185) * 0.105 + (side - 70) * 0.16 + (rim - 16) * 0.6), 75, 116);
    var xl = p <= 35 && comp !== 'slick';
    var zr = SPEED_RATING_KPH[sr] != null && SPEED_RATING_KPH[sr] > 240;
    var short = w + '/' + p + ' R' + rim;
    var size = comp === 'slick' ? w + '/' + Math.round(dia) + '-' + rim + ' Slick' : w + '/' + p + ' ' + (zr ? 'ZR' : 'R') + rim + ' ' + li + sr + (xl ? ' XL' : '');
    return {
      axle: axle === 'rear' ? 'rear' : 'front', width_mm: w, profile: p, rim_in: rim, rimWidth_in: rimW, compound: comp,
      sidewall_mm: side, diameter_mm: dia, diameter_in: dia / 25.4, circumference_mm: circ, revsPerKm: 1e6 / circ,
      size: size, short: short, loadIndex: li, loadKg: Math.round(45 * Math.pow(1.0292, li - 60)), speedRating: sr,
      speedRatingKph: SPEED_RATING_KPH[sr], xl: xl, fit: rimFit(rimW, w)
    };
  }

  function drivenAxle(b) {
    var l = getp(b, 'drivetrain.layout', 'rwd');
    return l === 'fwd' ? 'front' : l === 'awd' ? 'both' : 'rear';
  }

  /**
   * speedo(build) → speedometer calibration versus the factory (default-build) rolling diameter on the driven axle.
   * error_pct > 0: tyres are taller → the car travels faster than indicated (speedo under-reads).
   */
  function speedo(b) {
    var ref = defaults();
    var ax = drivenAxle(b);
    function dia(build, a) { return tireGeom(build, a).diameter_mm; }
    var actual = ax === 'both' ? (dia(b, 'front') + dia(b, 'rear')) / 2 : dia(b, ax);
    var base = ax === 'both' ? (dia(ref, 'front') + dia(ref, 'rear')) / 2 : dia(ref, ax);
    var err = (actual / base - 1) * 100;
    var fD = dia(b, 'front'), rD = dia(b, 'rear');
    var awdMismatch = ax === 'both' ? Math.abs(fD / rD - 1) * 100 : 0;
    return {
      axle: ax, refDiameter_mm: base, diameter_mm: actual, error_pct: err,
      actualAt100: 100 * actual / base, indicatedAt100True: 100 * base / actual,
      revsPerKm: 1e6 / (Math.PI * actual), awdMismatch_pct: awdMismatch,
      status: Math.abs(err) <= 1.5 ? 'ok' : Math.abs(err) <= 3.5 ? 'warn' : 'bad'
    };
  }

  /* ---------------------------------------------------------------- masses */
  var DESIGN_MASS = { y: 1.0, split: 0.98, mesh: 1.05, turbine: 1.02, monoblock: 1.0, dish: 1.08, centerlock: 0.96, 'aero-disc': 1.06 };
  var COMPOUND_MASS = { eco: 0.97, 'all-season': 1.04, winter: 1.06, touring: 1.0, performance: 1.0, 'super-sport': 0.98, track: 0.95, slick: 0.86 };

  function wheelMass(b, axle) {
    var A = axleKey(axle);
    var d = num(getp(b, 'wheels.diameter_in'), 19), w = num(getp(b, 'wheels.width' + A + '_in'), 9);
    var mat = find('wheelMaterials', getp(b, 'wheels.material')) || { weightFactor: 1 };
    var des = find('wheelDesigns', getp(b, 'wheels.design')) || { style: 'y' };
    var base = 6.6 + (d - 15) * 0.95 + (w - 6) * 0.82;
    var m = base * num(mat.weightFactor, 1) * (DESIGN_MASS[des.style] || 1);
    if (des.id === 'beadlock') m += 1.8;
    if (des.id === 'centerlock-race') m -= 0.4;
    return m;
  }
  function tireMass(b, axle) {
    var g = tireGeom(b, axle);
    return (3.6 + (g.width_mm - 175) * 0.032 + g.rim_in * 0.2 + g.sidewall_mm * 0.026) * (COMPOUND_MASS[g.compound] || 1);
  }

  var PISTON_DIA = { 1: 54, 2: 44, 4: 38, 6: 32, 8: 28, 10: 25 };
  function caliperMass(pistons, material) {
    var m = 1.9 + num(pistons, 4) * 0.42;
    if (material === 'carbon-ceramic' || material === 'two-piece') m *= 0.92;
    return m;
  }
  function rotorMass(b, axle) {
    var mat = find('brakeMaterials', getp(b, 'brakes.material')) || { weightPerRotor_kg: 11 };
    var r = num(getp(b, 'brakes.' + (axle === 'rear' ? 'rear' : 'front') + 'Rotor_mm'), axle === 'rear' ? 330 : 360);
    var k = axle === 'rear' ? 0.82 : 1;
    return num(mat.weightPerRotor_kg, 11) * Math.pow(r / 360, 2.2) * k;
  }

  var MOTION_RATIO = { macpherson: 0.97, 'double-wishbone': 0.85, multilink: 0.88, pushrod: 1.0, air: 0.9, magnetic: 0.88, 'coilover-track': 0.92 };
  /** Suspension hardware share per corner (kg) that is unsprung. */
  function suspUnsprung(b) {
    var t = find('suspensionTypes', getp(b, 'suspension.type')) || { weight_kg: 0 };
    return 9 + num(t.weight_kg, 0) / 4 * 0.5;
  }

  /** Unsprung mass per corner for an axle with a breakdown. */
  function unsprung(b, axle) {
    var A = axle === 'rear' ? 'rear' : 'front';
    var parts = {
      wheel: wheelMass(b, axle), tire: tireMass(b, axle), rotor: rotorMass(b, axle),
      caliper: caliperMass(getp(b, 'brakes.' + A + 'Pistons', 4), getp(b, 'brakes.material')), hardware: suspUnsprung(b)
    };
    var t = 0; Object.keys(parts).forEach(function (k) { t += parts[k]; });
    parts.total = t;
    return parts;
  }

  /** Approximate polar moment of inertia of one wheel + tyre (kg·m²). */
  function wheelInertia(b, axle) {
    var g = tireGeom(b, axle);
    var rr = g.rim_in * 0.0254 / 2, rt = g.diameter_mm / 2000;
    return wheelMass(b, axle) * Math.pow(rr * 0.78, 2) + tireMass(b, axle) * Math.pow((rr + rt) / 2 * 1.04, 2);
  }

  /* ---------------------------------------------------------------- weight (local estimate) */
  function weightLedger(b) {
    var w = (b && b.weight) || {};
    var rows = [];
    function row(id, label, kg, price, on) { rows.push({ id: id, label: label, kg: kg, price: price, active: !!on }); }
    row('soundDeadening', 'Sound deadening delete', -optWeight('soundDeadening', 22), optPrice('soundDeadeningDelete', -200), w.soundDeadening === false);
    row('rearSeats', 'Rear seat delete', -optWeight('rearSeats', 28), optPrice('rearSeatDelete', -500), w.rearSeats === false);
    row('spareTire', 'Spare wheel & jack', optWeight('spareTire', 18), optPrice('spareTire', 250), !!w.spareTire);
    var gl = find('glassTypes', w.glass) || { weight_kg: 0, price: 0, name: 'Glass' };
    row('glass', gl.name, num(gl.weight_kg, 0), num(gl.price, 0), w.glass && w.glass !== 'standard');
    var bt = find('batteryTypes', w.battery) || { weight_kg: 0, price: 0, name: 'Battery' };
    row('battery', bt.name, num(bt.weight_kg, 0), num(bt.price, 0), w.battery && w.battery !== 'lead');
    var cg = find('rollCages', w.rollCage) || { weight_kg: 0, price: 0, name: 'Cage' };
    row('rollCage', cg.name, num(cg.weight_kg, 0), num(cg.price, 0), w.rollCage && w.rollCage !== 'none');
    var bal = num(w.ballast_kg, 0);
    row('ballast', 'Ballast (' + (w.ballastPosition || 'center') + ')', bal, bal * optPrice('ballastPerKg', 6), bal > 0);
    var saved = 0, added = 0, cost = 0;
    rows.forEach(function (r) { if (!r.active) return; if (r.kg < 0) saved -= r.kg; else added += r.kg; cost += r.price; });
    var reductionCost = 0;
    rows.forEach(function (r) { if (r.active && r.kg < 0) reductionCost += Math.max(0, r.price); });
    return { rows: rows, saved_kg: saved, added_kg: added, net_kg: added - saved, cost: cost, costPerKgSaved: saved > 0 ? reductionCost / saved : 0 };
  }

  /** Chassis-side mass deltas relative to "nothing fitted" (kg, whole car). */
  function chassisMass(b) {
    var st = find('suspensionTypes', getp(b, 'suspension.type')) || { weight_kg: 0 };
    var m = num(st.weight_kg, 0);
    m += 2 * (unsprung(b, 'front').total + unsprung(b, 'rear').total) - 4 * suspUnsprung(b);
    ['splitter:aero.splitters', 'wing:aero.wings', 'diffuser:aero.diffusers'].forEach(function (pair) {
      var kv = pair.split(':'); var o = find(kv[1], getp(b, 'aero.' + kv[0])); if (o) m += num(o.weight_kg, 0);
    });
    if (getp(b, 'aero.canards')) m += optWeight('canards', 1.5);
    if (getp(b, 'aero.sideSkirts')) m += optWeight('sideSkirts', 4);
    if (getp(b, 'aero.activeAero')) m += optWeight('activeAero', 12);
    m += weightLedger(b).net_kg;
    return m;
  }

  /* ---------------------------------------------------------------- suspension */
  function tireVerticalRate(b, axle) {
    var g = tireGeom(b, axle);
    // N/mm — low profiles and wide sections are stiffer; slicks run lower pressures.
    var k = 175 + (70 - g.profile) * 3.2 + (g.width_mm - 225) * 0.35;
    if (g.compound === 'slick') k *= 0.9;
    return k;
  }

  /**
   * suspension(build, metrics) → derived suspension figures (front & rear):
   * motionRatio, wheelRate_nmm, rideRate_nmm, freq_hz, sprungCorner_kg, unsprung_kg, rollStiffness (Nm/deg; springs + ARB),
   * tlltd_pct (front roll-stiffness share), rollGradient_degPerG, dampingRatio, travelToBump_mm, bottoming, comfort, grip.
   */
  function suspension(b, m) {
    var s = (b && b.suspension) || {};
    var type = find('suspensionTypes', s.type) || { gripMult: 1, comfortMult: 0.9, id: s.type, rideHeightRange: [80, 200], adjustable: false };
    var mass = num(m && m.weight_kg, 1500), wf = num(m && m.weightFront_pct, 52) / 100;
    var cgh = num(m && m.cgHeight_mm, 500) / 1000;
    var track = num(getp(b, 'body.trackWidth_mm'), 1600) / 1000;
    var mr = MOTION_RATIO[type.id] || 0.8;
    function axleCalc(axle) {
      var A = axleKey(axle), isF = axle !== 'rear';
      var spring = num(s['spring' + A + '_nmm'], isF ? 60 : 70);
      var wheelRate = spring * mr * mr;
      var kt = tireVerticalRate(b, axle);
      var ride = wheelRate * kt / (wheelRate + kt);
      var us = unsprung(b, axle);
      var sprung = Math.max(120, mass * (isF ? wf : 1 - wf) / 2 - us.total);
      var freq = Math.sqrt(ride * 1000 / sprung) / (2 * Math.PI);
      var arb = num(s['arb' + A], isF ? 5 : 4);
      var kSpring = wheelRate * 1000 * track * track / 2 * Math.PI / 180;  // Nm/deg
      var kArb = arb * 230 * (isF ? 1 : 0.9);
      return { axle: axle, spring_nmm: spring, motionRatio: mr, wheelRate_nmm: wheelRate, tireRate_nmm: kt, rideRate_nmm: ride, sprungCorner_kg: sprung, unsprung_kg: us.total, unsprung: us, freq_hz: freq, arb: arb, kSpring: kSpring, kArb: kArb, rollStiffness: kSpring + kArb };
    }
    var F = axleCalc('front'), R = axleCalc('rear');
    var kTot = F.rollStiffness + R.rollStiffness;
    var sprungMass = 2 * (F.sprungCorner_kg + R.sprungCorner_kg);
    var rollArm = Math.max(0.12, cgh - 0.09);
    var rollGrad = sprungMass * G * rollArm / kTot;
    var damping = num(s.damping, 5);
    var zeta = 0.12 + (damping - 1) * 0.07;
    var rh = num(s.rideHeight_mm, 120);
    // half-g bump event on the softer axle (static deflection is already inside the ride height)
    var soft = Math.min(F.rideRate_nmm, R.rideRate_nmm);
    var softCorner = F.rideRate_nmm <= R.rideRate_nmm ? F : R;
    var travel = softCorner.sprungCorner_kg * G * 0.5 / Math.max(5, soft);
    var clearance = rh - travel;
    var bottoming = clearance < 25 ? 'high' : clearance < 45 ? 'moderate' : 'low';
    // camber / toe effects
    var cf = num(s.camberFront_deg, -1.5), cr = num(s.camberRear_deg, -1.0);
    var tf = num(s.toeFront_deg, 0), tr = num(s.toeRear_deg, 0.1);
    function camberGrip(c, opt) { return 1 - 0.011 * Math.pow(c - opt, 2); }
    var latGrip = (camberGrip(cf, -2.6) + camberGrip(cr, -1.9)) / 2;
    var straightGrip = 1 - 0.008 * Math.pow(Math.abs(cf) + Math.abs(cr), 1.4) / 2;
    var wearCamber = clamp((Math.abs(cf) + Math.abs(cr) - 2) / 6, 0, 1);
    var wearToe = clamp((Math.abs(tf) + Math.abs(tr)) / 0.7, 0, 1);
    var wear = clamp(wearCamber * 0.6 + wearToe * 0.6, 0, 1);
    var turnIn = clamp(0.5 - tf * 1.2 + (Math.abs(cf) - 1.5) * 0.06 + (F.freq_hz - 1.6) * 0.15, 0, 1);
    var stability = clamp(0.5 + tr * 1.3 - Math.max(0, -tr) * 1.5 + (damping - 5) * 0.03, 0, 1);
    // comfort / grip indices
    var fAvg = (F.freq_hz + R.freq_hz) / 2;
    var freqComfort = clamp(1 - (fAvg - 1.0) / 2.0, 0, 1);
    var dampComfort = 1 - clamp(Math.abs(zeta - 0.3) / 0.5, 0, 1) * 0.6;
    var profComfort = clamp((num(getp(b, 'tires.profileFront'), 35) + num(getp(b, 'tires.profileRear'), 30)) / 2 / 55, 0.3, 1.1);
    var comfort = clamp(100 * (0.55 * freqComfort + 0.2 * dampComfort + 0.25 * profComfort) * num(type.comfortMult, 0.9) * (rh < 80 ? 0.9 : 1), 0, 100);
    var dampGrip = 1 - Math.abs(zeta - 0.45) * 0.25;
    var heightGrip = 1 + clamp((130 - rh) / 1000, -0.08, 0.06);
    var grip = clamp(100 * 0.78 * num(type.gripMult, 1) * latGrip * dampGrip * heightGrip / 0.84 * (fAvg > 3.2 ? 0.95 : 1), 0, 100);
    var adaptive = type.id === 'magnetic' || type.id === 'air';
    return {
      type: type, front: F, rear: R, rollStiffness: kTot, tlltd_pct: F.rollStiffness / kTot * 100, rollGradient_degPerG: rollGrad,
      dampingRatio: zeta, dampingRange: adaptive ? [Math.max(0.1, zeta - 0.15), Math.min(0.9, zeta + 0.2)] : null,
      freqSplit_pct: (R.freq_hz / F.freq_hz - 1) * 100, travelToBump_mm: travel, clearance_mm: clearance, bottoming: bottoming,
      latGrip: latGrip, straightGrip: straightGrip, tireWear: wear, turnIn: turnIn, stability: stability,
      comfort: comfort, grip: grip, rideHeight_mm: rh, weightFront_pct: wf * 100
    };
  }

  /* ---------------------------------------------------------------- aero */
  var FRONT_SHARE = { splitter: 1, canards: 1, diffuser: 0.35, sideSkirts: 0.5, wing: -0.08 };
  function wingAngleFactor(wing, angle) {
    if (!wing || !wing.adjustable) return { df: 1, drag: 1 };
    var a = num(angle, 6);
    return { df: 0.35 + 0.065 * a, drag: 0.3 + 0.07 * a };
  }

  /**
   * aero(build, metrics) → per-element downforce @200 km/h (kg), drag deltas, totals, front/rear split, aero balance.
   * When physics publishes downforce_kg_200 the local total is scaled to match it (split ratios preserved).
   */
  function aero(b, m) {
    var a = (b && b.aero) || {};
    var st = find('bodyStyles', getp(b, 'body.style')) || { cd: 0.32, frontalArea_m2: 2.1, id: 'coupe' };
    var rh = num(getp(b, 'suspension.rideHeight_mm'), 120);
    var ground = clamp(1 + (120 - rh) / 220, 0.65, 1.3);
    var sp = find('aero.splitters', a.splitter) || { downforce_kg_at_200: 0, dragDelta: 0, name: 'None' };
    var wg = find('aero.wings', a.wing) || { downforce_kg_at_200: 0, dragDelta: 0, name: 'None' };
    var df = find('aero.diffusers', a.diffuser) || { downforce_kg_at_200: 0, dragDelta: 0, name: 'None' };
    var waf = wingAngleFactor(wg, a.wingAngle_deg);
    var els = [];
    function add(id, label, kg, drag, frontShare) {
      els.push({ id: id, label: label, kg: kg, front_kg: kg * frontShare, rear_kg: kg * (1 - frontShare), dragDelta: drag });
    }
    var bodyLift = st.id === 'hypercar' ? 25 : st.id === 'suv' || st.id === 'van' || st.id === 'pickup' ? -40 : -22;
    add('body', 'Body & underfloor', bodyLift, 0, 0.42);
    if (sp.downforce_kg_at_200) add('splitter', sp.name, sp.downforce_kg_at_200 * ground, num(sp.dragDelta, 0), FRONT_SHARE.splitter);
    if (a.canards) add('canards', 'Dive planes', 12, 0.004, FRONT_SHARE.canards);
    if (a.sideSkirts) add('sideSkirts', 'Side skirts', 8 * ground, -0.002, FRONT_SHARE.sideSkirts);
    if (df.downforce_kg_at_200) add('diffuser', df.name, df.downforce_kg_at_200 * ground, num(df.dragDelta, 0), FRONT_SHARE.diffuser);
    if (wg.downforce_kg_at_200) add('wing', wg.name + (wg.adjustable ? ' @ ' + num(a.wingAngle_deg, 6) + '°' : ''), wg.downforce_kg_at_200 * waf.df, num(wg.dragDelta, 0) * waf.drag, FRONT_SHARE.wing);
    var des = find('wheelDesigns', getp(b, 'wheels.design'));
    if (des && des.dragDelta) add('wheels', des.name + ' wheels', 0, num(des.dragDelta, 0), 0.5);
    var total = 0, front = 0, dragD = 0;
    els.forEach(function (e) { total += e.kg; front += e.front_kg; dragD += e.dragDelta; });
    var scale = 1;
    if (m && isFinite(Number(m.downforce_kg_200)) && total > 1 && Number(m.downforce_kg_200) > 0) scale = Number(m.downforce_kg_200) / total;
    if (scale !== 1) { els.forEach(function (e) { e.kg *= scale; e.front_kg *= scale; e.rear_kg *= scale; }); total *= scale; front *= scale; }
    var cd = m && isFinite(Number(m.cd)) ? Number(m.cd) : num(st.cd, 0.32) + dragD;
    var area = m && isFinite(Number(m.frontalArea_m2)) ? Number(m.frontalArea_m2) : num(st.frontalArea_m2, 2.1);
    var cda = cd * area;
    var balance = total > 0.5 ? clamp(front / total * 100, -50, 150) : null;
    function dfAt(kph) { return total * Math.pow(kph / 200, 2); }
    function dragKgAt(kph) { var v = kph / 3.6; return 0.5 * RHO * cda * v * v / G; }
    var v200 = 200 / 3.6;
    var activeMode = !!a.activeAero;
    return {
      elements: els, total_kg_200: total, front_kg_200: front, rear_kg_200: total - front, balance_front_pct: balance,
      cd: cd, frontalArea_m2: area, cda: cda, dragDelta: dragD, groundFactor: ground,
      drag_kg_200: dragKgAt(200), dragPower_kw_200: 0.5 * RHO * cda * Math.pow(v200, 3) / 1000,
      liftToDrag: total > 0 ? total / dragKgAt(200) : 0,
      dfAt: dfAt, dragKgAt: dragKgAt, active: activeMode, wingAdjustable: !!wg.adjustable, wingAngleFactor: waf,
      curve: (function () { var c = []; for (var k = 0; k <= 340; k += 20) c.push({ kph: k, kg: Math.max(0, dfAt(k)) }); return c; })()
    };
  }

  /* ---------------------------------------------------------------- brakes */
  var ABS_EFF = { standard: 0.94, sport: 0.965, race: 0.985, off: 0.9 };
  var PAD_MU = 0.42, LINE_PRESSURE = 100e5; // Pa (100 bar reference)
  var SPECIFIC_HEAT = { iron: 460, 'drilled-slotted': 460, 'two-piece': 470, 'carbon-ceramic': 800 };
  var MAX_DT = { iron: 520, 'drilled-slotted': 560, 'two-piece': 600, 'carbon-ceramic': 900 };

  function pistonArea_m2(pistons) {
    var n = num(pistons, 4), d = (PISTON_DIA[n] || 34) / 1000;
    var area = n * Math.PI * d * d / 4;
    if (n <= 2) area *= 2; // floating calipers: reaction side clamps too
    return area;
  }

  /**
   * brakes(build, metrics) → per-axle torque, bias, thermal capacity, rotor-in-wheel fit, stopping estimates.
   */
  function brakes(b, m) {
    var br = (b && b.brakes) || {};
    var mat = find('brakeMaterials', br.material) || { id: 'iron', frictionMult: 1, fadeResistance: 0.45, weightPerRotor_kg: 11, minWheel_in: 15 };
    var mass = num(m && m.weight_kg, 1500), wf = num(m && m.weightFront_pct, 52) / 100;
    var cgh = num(m && m.cgHeight_mm, 500), wb = num(getp(b, 'body.wheelbase_mm'), 2650);
    var wheel_mm = num(getp(b, 'wheels.diameter_in'), 19) * 25.4;
    function axle(a) {
      var isF = a !== 'rear', key = isF ? 'front' : 'rear';
      var rotor = num(br[key + 'Rotor_mm'], isF ? 360 : 330), pistons = num(br[key + 'Pistons'], isF ? 6 : 4);
      var rEff = (rotor / 2 - 22) / 1000;
      var clamp_N = LINE_PRESSURE * pistonArea_m2(pistons) * (isF ? 1 : 0.5); // rear proportioning valve
      var torque = PAD_MU * num(mat.frictionMult, 1) * clamp_N * rEff;
      var rmass = rotorMass(b, a);
      var cap = rmass * (SPECIFIC_HEAT[mat.id] || 460) * (MAX_DT[mat.id] || 520) / 1000; // kJ per rotor
      var required = rotor + 60;
      return {
        axle: key, rotor_mm: rotor, pistons: pistons, effRadius_m: rEff, torque_nm: torque, rotorMass_kg: rmass,
        caliperMass_kg: caliperMass(pistons, mat.id), capacity_kj: cap, requiredWheel_mm: required,
        wheel_mm: wheel_mm, clearance_mm: wheel_mm - required, fits: wheel_mm - required >= 0,
        minWheel_in: Math.ceil(required / 25.4)
      };
    }
    var F = axle('front'), R = axle('rear');
    var bias = F.torque_nm / (F.torque_nm + R.torque_nm) * 100;
    var mu = num(m && (m.gripFront != null ? (Number(m.gripFront) + Number(m.gripRear)) / 2 : null), NaN);
    if (!isFinite(mu)) { var tc = find('tireCompounds', getp(b, 'tires.compound')) || { mu: 1 }; mu = num(tc.mu, 1); }
    var decelG = clamp(mu, 0.4, 2.2);
    var ideal = (wf + decelG * cgh / wb) * 100;
    var r1 = (F.torque_nm + R.torque_nm) * 2 / (tireGeom(b, 'front').diameter_mm / 2000); // N total brake force @100 bar
    var torqueG = r1 / (mass * G);
    var absEff = ABS_EFF[br.abs] || 0.95;
    var biasPenalty = 1 - Math.min(0.12, Math.abs(bias - ideal) / 100 * 0.6);
    var achievedG = Math.min(decelG, torqueG * 1.6) * absEff * biasPenalty;
    var v = 100 / 3.6;
    var dist = m && isFinite(Number(m.brakingDist_100_0_m)) ? Number(m.brakingDist_100_0_m) : v * v / (2 * achievedG * G);
    var ke200 = 0.5 * mass * Math.pow(200 / 3.6, 2) / 1000; // kJ
    var capTotal = 2 * F.capacity_kj + 2 * R.capacity_kj;
    var hotStops = capTotal * (0.6 + 0.6 * num(mat.fadeResistance, 0.5)) / ke200;
    var fadeRisk = clamp(1 - num(mat.fadeResistance, 0.5) - (hotStops - 1.5) * 0.12 + (mass - 1500) / 6000, 0, 1);
    var pedalFeel = clamp(0.45 + (br.abs === 'race' ? 0.15 : br.abs === 'off' ? 0.25 : br.abs === 'sport' ? 0.08 : 0) + (F.pistons - 4) * 0.03 + (mat.id === 'carbon-ceramic' ? 0.1 : mat.id === 'two-piece' ? 0.06 : 0), 0, 1);
    return {
      material: mat, front: F, rear: R, bias_front_pct: bias, idealBias_front_pct: ideal, biasDelta: bias - ideal,
      decelG: achievedG, torqueLimitedG: torqueG, dist_100_0_m: dist, dist_60_0_ft: dist * 3.28084 * Math.pow(96.56 / 100, 2),
      capacity_kj: capTotal, ke200_kj: ke200, hotStops200: hotStops, fadeRisk: fadeRisk, pedalFeel: pedalFeel,
      unsprungBrake_kg: 2 * (F.rotorMass_kg + F.caliperMass_kg + R.rotorMass_kg + R.caliperMass_kg), absEff: absEff
    };
  }

  /* ---------------------------------------------------------------- handling balance */
  /**
   * balance(build, metrics) → { score (-1 oversteer … +1 understeer), label, kind, contributions:[{id,label,value,note}] }
   */
  function balance(b, m) {
    var s = suspension(b, m);
    var c = [];
    function add(id, label, v, note) { if (Math.abs(v) >= 0.004) c.push({ id: id, label: label, value: v, note: note }); }
    add('roll', 'Roll-stiffness distribution', (s.tlltd_pct - s.weightFront_pct) * 0.035,
      'Front carries ' + round(s.tlltd_pct, 0) + '% of roll stiffness vs ' + round(s.weightFront_pct, 0) + '% of the weight');
    var cf = Math.abs(num(getp(b, 'suspension.camberFront_deg'), -1.5)), cr = Math.abs(num(getp(b, 'suspension.camberRear_deg'), -1));
    add('camber', 'Camber split', (cr - cf) * 0.07, cf > cr ? 'More front camber keeps the front tyres flatter in roll' : 'More rear camber adds rear grip');
    add('toeF', 'Front toe', num(getp(b, 'suspension.toeFront_deg'), 0) * 0.55, num(getp(b, 'suspension.toeFront_deg'), 0) < 0 ? 'Toe-out sharpens turn-in' : 'Toe-in calms the front end');
    add('toeR', 'Rear toe', num(getp(b, 'suspension.toeRear_deg'), 0.1) * 0.8, num(getp(b, 'suspension.toeRear_deg'), 0.1) < 0 ? 'Rear toe-out makes the tail nervous' : 'Rear toe-in stabilises the rear');
    var fw = num(getp(b, 'tires.widthFront_mm'), 255), rw = num(getp(b, 'tires.widthRear_mm'), 295);
    add('stagger', 'Tyre stagger', (rw - fw) / fw * 0.75, rw > fw ? 'Wider rear tyres add rear grip' : rw < fw ? 'Narrower rears reduce rear grip' : 'Square set-up');
    var lay = getp(b, 'drivetrain.layout', 'rwd');
    var hp = num(m && m.power_hp, 400);
    var dl = lay === 'fwd' ? 0.12 + Math.min(0.12, hp / 3000) : lay === 'rwd' ? -0.03 - Math.min(0.18, hp / 3500) : (num(getp(b, 'drivetrain.torqueSplitFront_pct'), 40) - 40) / 100 * 0.35;
    add('drive', 'Driven wheels (' + lay.toUpperCase() + ')', dl, lay === 'rwd' ? 'Power on the rear axle rotates the car on exit' : lay === 'fwd' ? 'Driven fronts saturate first on exit' : 'AWD torque split');
    if (getp(b, 'drivetrain.torqueVectoring')) add('tv', 'Torque vectoring', -0.08, 'Over-driving the outside wheel helps rotation');
    var ae = aero(b, m);
    if (ae.balance_front_pct != null && ae.total_kg_200 > 5) {
      var dfShare = clamp(ae.total_kg_200 / Math.max(800, num(m && m.weight_kg, 1500)), 0, 0.5);
      add('aero', 'Aero balance @ 200 km/h', (s.weightFront_pct - ae.balance_front_pct) / 100 * dfShare * 2.2,
        'Aero ' + round(ae.balance_front_pct, 0) + '% front vs ' + round(s.weightFront_pct, 0) + '% weight');
    }
    var score = 0; c.forEach(function (x) { score += x.value; });
    score = clamp(score, -1, 1);
    var label = score < -0.35 ? 'Pronounced oversteer' : score < -0.12 ? 'Mild oversteer' : score <= 0.12 ? 'Neutral' : score < 0.35 ? 'Mild understeer' : 'Pronounced understeer';
    var kind = Math.abs(score) <= 0.12 ? 'good' : Math.abs(score) < 0.35 ? 'warn' : 'bad';
    c.sort(function (x, y) { return Math.abs(y.value) - Math.abs(x.value); });
    return { score: score, label: label, kind: kind, contributions: c };
  }

  /* ---------------------------------------------------------------- suspension presets */
  var SUSPENSION_PRESETS = [
    { id: 'comfort', name: 'Comfort', desc: 'Soft springs, gentle damping and mild alignment for broken roads and long days.',
      values: { springFront_nmm: 34, springRear_nmm: 38, damping: 3, rideHeight_mm: 145, camberFront_deg: -0.6, camberRear_deg: -0.5, toeFront_deg: 0.05, toeRear_deg: 0.15, arbFront: 3, arbRear: 2 } },
    { id: 'sport', name: 'Sport', desc: 'Firmer springs and a little more camber — the fast-road sweet spot.',
      values: { springFront_nmm: 72, springRear_nmm: 82, damping: 6, rideHeight_mm: 115, camberFront_deg: -1.8, camberRear_deg: -1.4, toeFront_deg: 0, toeRear_deg: 0.15, arbFront: 6, arbRear: 5 } },
    { id: 'track', name: 'Track', desc: 'Race-car rates, aggressive negative camber and a slammed ride height. Kerbs only.',
      values: { springFront_nmm: 150, springRear_nmm: 160, damping: 8, rideHeight_mm: 85, camberFront_deg: -3.2, camberRear_deg: -2.2, toeFront_deg: -0.1, toeRear_deg: 0.2, arbFront: 8, arbRear: 6 } },
    { id: 'drift', name: 'Drift', desc: 'Huge front camber for steering lock grip, flat rear camber and a stiff rear bar to break traction on cue.',
      values: { springFront_nmm: 110, springRear_nmm: 90, damping: 7, rideHeight_mm: 105, camberFront_deg: -4.0, camberRear_deg: -0.5, toeFront_deg: -0.2, toeRear_deg: 0, arbFront: 4, arbRear: 9 } },
    { id: 'stance', name: 'Stance', desc: 'Slammed and cambered for the show floor. Expect scraping and inner-edge tyre wear.',
      values: { springFront_nmm: 95, springRear_nmm: 95, damping: 6, rideHeight_mm: 60, camberFront_deg: -5, camberRear_deg: -5, toeFront_deg: 0, toeRear_deg: 0, arbFront: 5, arbRear: 5 } }
  ];
  var PRESET_TOL = { springFront_nmm: 3, springRear_nmm: 3, damping: 0.5, rideHeight_mm: 4, camberFront_deg: 0.15, camberRear_deg: 0.15, toeFront_deg: 0.03, toeRear_deg: 0.03, arbFront: 0.5, arbRear: 0.5 };

  /** Which preset (if any) the build's suspension matches; ride height compared after clamping to the type range. */
  function matchPreset(b) {
    var s = (b && b.suspension) || {};
    var t = find('suspensionTypes', s.type);
    var rr = t && t.rideHeightRange ? t.rideHeightRange : [50, 300];
    for (var i = 0; i < SUSPENSION_PRESETS.length; i++) {
      var p = SUSPENSION_PRESETS[i], ok = true;
      Object.keys(p.values).forEach(function (k) {
        var target = k === 'rideHeight_mm' ? clamp(p.values[k], rr[0], rr[1]) : p.values[k];
        if (Math.abs(num(s[k], NaN) - target) > PRESET_TOL[k] || !isFinite(num(s[k], NaN))) ok = false;
      });
      if (ok) return p.id;
    }
    return null;
  }

  /* ---------------------------------------------------------------- local metric estimate */
  function estimateMetrics(b) {
    var base = null;
    if (CB.panelsPowertrain && typeof CB.panelsPowertrain.estimate === 'function') {
      try { base = CB.panelsPowertrain.estimate(b); } catch (e) { base = null; }
    }
    if (!base) {
      var st = find('bodyStyles', getp(b, 'body.style')) || {};
      base = { weight_kg: num(st.baseWeight_kg, 1500), weightFront_pct: 53, cgHeight_mm: num(st.cgHeight_mm, 500), cd: num(st.cd, 0.32), frontalArea_m2: num(st.frontalArea_m2, 2.1) };
    }
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    var w = num(out.weight_kg, 1500) + 150 + chassisMass(b); // +150: interior, glass, wiring, fluids not in the powertrain estimate
    var wfKg = w * num(out.weightFront_pct, 53) / 100;
    var bal = num(getp(b, 'weight.ballast_kg'), 0), pos = getp(b, 'weight.ballastPosition', 'center');
    wfKg += bal * (pos === 'front' ? 0.85 : pos === 'rear' ? 0.08 : 0.5) - bal * 0.5;
    if (getp(b, 'weight.rearSeats') === false) wfKg += optWeight('rearSeats', 28) * 0.2;
    out.weight_kg = w;
    out.weightFront_pct = wfKg / w * 100;
    var rh = num(getp(b, 'suspension.rideHeight_mm'), 120);
    out.cgHeight_mm = num(out.cgHeight_mm, 500) + (rh - 120) * 0.85 + (getp(b, 'weight.rollCage') === 'full' ? 6 : 0);
    var ae = aero(b, null);
    out.cd = ae.cd; out.cda = ae.cda; out.frontalArea_m2 = ae.frontalArea_m2;
    out.downforce_kg_200 = Math.max(0, ae.total_kg_200);
    out.downforceCurve = ae.curve;
    var tc = find('tireCompounds', getp(b, 'tires.compound')) || { mu: 1 };
    var s = suspension(b, out);
    out.gripFront = num(tc.mu, 1) * s.latGrip * num(s.type.gripMult, 1);
    out.gripRear = out.gripFront * (1 + (num(getp(b, 'tires.widthRear_mm'), 295) / num(getp(b, 'tires.widthFront_mm'), 255) - 1) * 0.25);
    out.comfortIndex = s.comfort;
    return out;
  }

  var calc = {
    rimRange: rimRange, rimFit: rimFit, tireGeom: tireGeom, speedo: speedo, drivenAxle: drivenAxle,
    wheelMass: wheelMass, tireMass: tireMass, rotorMass: rotorMass, caliperMass: caliperMass, unsprung: unsprung,
    wheelInertia: wheelInertia, tireVerticalRate: tireVerticalRate, suspension: suspension, aero: aero, brakes: brakes,
    balance: balance, weightLedger: weightLedger, chassisMass: chassisMass, estimateMetrics: estimateMetrics,
    matchPreset: matchPreset, wingAngleFactor: wingAngleFactor, pistonArea_m2: pistonArea_m2,
    presets: SUSPENSION_PRESETS, motionRatios: MOTION_RATIO
  };
  CB.chassisCalc = calc;
  if (typeof module !== 'undefined' && module.exports) module.exports = calc;

  /* ======================================================================
     DOM LAYER — everything below requires CB.util / CB.ui / CB.registerPanel
     ====================================================================== */
  var U = CB.util, ui = CB.ui;
  if (!U || !CB.data || !ui || typeof CB.registerPanel !== 'function') {
    if (typeof console !== 'undefined' && typeof document !== 'undefined') console.error('[panels-chassis] CB.util / CB.data / CB.ui must load first.');
    return;
  }
  var Dt = CB.data;
  var el = U.el;
  var hasDOM = typeof document !== 'undefined';
  var hasRAF = typeof requestAnimationFrame === 'function';
  var raf = hasRAF ? function (f) { return requestAnimationFrame(f); } : function (f) { return setTimeout(f, 16); };
  var caf = hasRAF ? function (h) { cancelAnimationFrame(h); } : clearTimeout;

  function get(b, p, fb) { return getp(b, p, fb); }
  function R(path, fb) { return (Dt.ranges && Dt.ranges[path]) || fb || { min: 0, max: 100, step: 1 }; }
  function fmt(n, d) { return n == null || !isFinite(Number(n)) ? '—' : U.fmtNum(Number(n), d || 0); }
  function signed(n, d) { if (n == null || !isFinite(Number(n))) return '—'; n = Number(n); return (n > 0 ? '+' : n < 0 ? '−' : '±') + U.fmtNum(Math.abs(n), d || 0); }
  function money(n) { return U.fmtMoney(n); }
  function setState(path, v, label) { return CB.state.set(path, v, { label: label }); }
  function patchState(p, label) { return CB.state.patch(p, { label: label }); }
  function cur() { return CB.state.get(); }
  function toast(msg, kind) { if (ui.toast) ui.toast(msg, kind || 'info'); }
  function hint(text) { return el('div', { class: 'cb-hint' }, text); }
  function note(text, kind) { return el('div', { class: 'pc-note is-' + (kind || 'info') }, text); }
  function svgWrap(vb, w, h, body, cls) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb + '" width="' + w + '" height="' + h +
      '" class="pc-svg ' + (cls || '') + '" aria-hidden="true" focusable="false">' + body + '</svg>';
  }
  function f1(n) { return (Math.round(n * 10) / 10).toString(); }
  function esc(s) { return U.escapeHtml ? U.escapeHtml(s) : String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ======================================================================
     SCOPED STYLES
     ====================================================================== */
  function injectStyles() {
    if (!hasDOM || document.getElementById('pc-styles')) return;
    var css = [
      '.pc-panel{display:flex;flex-direction:column;gap:18px}',
      '.pc-stack{display:flex;flex-direction:column;gap:14px}',
      '.pc-slot{display:flex;flex-direction:column;gap:14px}',
      '.pc-slot:empty{display:none}',
      '.pc-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(122px,1fr));gap:8px}',
      '.pc-stats .cb-stat{min-width:0}',
      '.pc-two{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
      '.pc-three{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}',
      '@media (max-width:760px){.pc-two,.pc-three{grid-template-columns:1fr}}',
      '.pc-svg{display:block;max-width:100%}',
      '.cb-card-icon .pc-svg{width:100%;height:auto;max-height:64px}',
      '.pc-diagram{border:1px solid var(--line);border-radius:var(--radius);background:var(--bg-2);padding:10px;overflow:hidden;position:relative}',
      '.pc-diagram svg{width:100%;height:auto;display:block}',
      '.pc-diagram text{font-family:var(--mono);font-size:var(--fs-2xs);fill:var(--text-dim)}',
      '.pc-diagram .pc-strong{fill:var(--text);font-weight:600}',
      '.pc-diagram .pc-accent{fill:var(--accent)}',
      '.pc-diagram .pc-ok{fill:var(--good)}.pc-diagram .pc-bad{fill:var(--bad)}.pc-diagram .pc-warn{fill:var(--warn)}',
      '.pc-diagram .pc-anim{transition:transform .35s cubic-bezier(.2,.8,.2,1)}',
      '.pc-diagram .pc-tween{transition:r .3s ease,cx .3s ease,cy .3s ease,width .3s ease,height .3s ease,x .3s ease,y .3s ease}',
      '.pc-diagram-cap{display:flex;justify-content:space-between;gap:10px;font-size:var(--fs-xs);letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim);margin-bottom:6px}',
      '.pc-note{font-size:var(--fs-sm);line-height:1.45;padding:9px 12px;border-radius:var(--radius-sm);border:1px solid var(--line);background:var(--panel-2);color:var(--text-dim)}',
      '.pc-note.is-warning,.pc-note.is-warn{border-color:color-mix(in srgb,var(--warn) 55%,transparent);color:var(--text)}',
      '.pc-note.is-error,.pc-note.is-bad{border-color:color-mix(in srgb,var(--bad) 60%,transparent);color:var(--text)}',
      '.pc-note.is-good{border-color:color-mix(in srgb,var(--good) 55%,transparent)}',
      '.pc-meter{position:relative;height:8px;border-radius:var(--radius-xs);background:var(--panel-2);overflow:hidden;margin:6px 0 4px}',
      '.pc-meter>i{position:absolute;left:0;top:0;bottom:0;border-radius:var(--radius-xs);background:var(--accent);transition:width .25s ease,background-color .25s}',
      '.pc-meter>b{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--text);opacity:.7;transition:left .25s ease}',
      '.pc-meter.is-good>i{background:var(--good)}.pc-meter.is-warn>i{background:var(--warn)}.pc-meter.is-bad>i{background:var(--bad)}',
      '.pc-readout{display:flex;justify-content:space-between;gap:10px;font-size:var(--fs-sm);color:var(--text-dim);font-variant-numeric:tabular-nums}',
      '.pc-readout strong{color:var(--text);font-weight:600}',
      '.pc-widget{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel-2);min-width:0}',
      '.pc-widget .pc-title{font-size:var(--fs-xs);letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim)}',
      '.pc-widget .pc-big{font-family:var(--mono);font-size:var(--fs-xl);font-weight:600;color:var(--text);font-variant-numeric:tabular-nums;letter-spacing:-.01em}',
      '.pc-widget .pc-big small{font-size:var(--fs-sm);color:var(--text-dim);font-weight:500;margin-left:3px}',
      '.pc-btnrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.pc-presets{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}',
      '.pc-preset{display:flex;flex-direction:column;align-items:flex-start;gap:4px;text-align:left;padding:10px 12px;border-radius:var(--radius);border:1px solid var(--line);background:var(--panel-2);color:var(--text);cursor:pointer;font:inherit;transition:border-color .2s,background .2s,transform .15s}',
      '.pc-preset:hover{border-color:color-mix(in srgb,var(--accent) 60%,var(--line))}',
      '.pc-preset:active{transform:translateY(1px)}',
      '.pc-preset.is-active{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,var(--panel-2))}',
      '.pc-preset-name{font-weight:600;font-size:var(--fs-sm);display:flex;align-items:center;gap:6px}',
      '.pc-preset-desc{font-size:var(--fs-xs);line-height:1.35;color:var(--text-dim)}',
      '.pc-preset-spark{width:100%;height:22px;color:var(--accent)}',
      '.pc-balance{display:flex;flex-direction:column;gap:8px}',
      '.pc-balance-scale{position:relative;height:30px;border-radius:var(--radius-lg);background:linear-gradient(90deg,color-mix(in srgb,var(--bad) 55%,transparent),color-mix(in srgb,var(--warn) 35%,transparent) 30%,color-mix(in srgb,var(--good) 45%,transparent) 50%,color-mix(in srgb,var(--warn) 35%,transparent) 70%,color-mix(in srgb,var(--accent-2) 55%,transparent));border:1px solid var(--line)}',
      '.pc-balance-needle{position:absolute;top:-5px;bottom:-5px;width:4px;margin-left:-2px;border-radius:2px;background:var(--text);box-shadow:0 0 0 3px color-mix(in srgb,var(--bg) 60%,transparent);transition:left .4s cubic-bezier(.2,.8,.2,1)}',
      '.pc-balance-ends{display:flex;justify-content:space-between;font-size:var(--fs-2xs);letter-spacing:.07em;text-transform:uppercase;color:var(--text-dim)}',
      '.pc-balance-label{font-size:var(--fs-lg);font-weight:600}',
      '.pc-balance-label.is-good{color:var(--good)}.pc-balance-label.is-warn{color:var(--warn)}.pc-balance-label.is-bad{color:var(--bad)}',
      '.pc-contrib{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}',
      '.pc-contrib li{display:grid;grid-template-columns:minmax(0,1fr) 120px 52px;gap:10px;align-items:center;font-size:var(--fs-sm);color:var(--text-dim)}',
      '.pc-contrib li span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pc-contrib .pc-cbar{position:relative;height:6px;background:var(--panel-2);border-radius:3px}',
      '.pc-contrib .pc-cbar i{position:absolute;top:0;bottom:0;border-radius:3px}',
      '.pc-contrib .pc-cbar::after{content:"";position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--line)}',
      '.pc-contrib .pc-cval{font-family:var(--mono);text-align:right;font-variant-numeric:tabular-nums}',
      '.pc-bars{display:flex;flex-direction:column;gap:5px;font-size:var(--fs-xs)}',
      '.pc-bar{display:grid;grid-template-columns:76px minmax(0,1fr) 54px;gap:8px;align-items:center;color:var(--text-dim)}',
      '.pc-bar .pc-meter{margin:0}',
      '.pc-bar span:last-child{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--text)}',
      '.pc-sizes{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '@media (max-width:560px){.pc-sizes{grid-template-columns:1fr}}',
      '.pc-size{font-family:var(--mono);font-size:var(--fs-xl);font-weight:600;letter-spacing:.02em;color:var(--text)}',
      '.pc-fit{display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-xs);padding:2px 8px;border-radius:var(--pill);border:1px solid var(--line);width:max-content}',
      '.pc-fit.is-ok{color:var(--good);border-color:color-mix(in srgb,var(--good) 50%,transparent)}',
      '.pc-fit.is-warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 50%,transparent)}',
      '.pc-fit.is-bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 50%,transparent)}',
      '.pc-table-wrap{overflow-x:auto}',
      '.pc-table{width:100%;border-collapse:collapse;font-size:var(--fs-sm);font-variant-numeric:tabular-nums}',
      '.pc-table th{font-weight:600;text-align:right;color:var(--text-dim);font-size:var(--fs-2xs);letter-spacing:.06em;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid var(--line)}',
      '.pc-table td{text-align:right;padding:6px 8px;border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent);font-family:var(--mono)}',
      '.pc-table th:first-child,.pc-table td:first-child{text-align:left;font-family:inherit}',
      '.pc-table tr.is-off td{opacity:.45}',
      '.pc-table tr.is-total td{font-weight:700;color:var(--text);border-bottom:0}',
      '.pc-table td.is-good{color:var(--good)}.pc-table td.is-bad{color:var(--bad)}',
      '.pc-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:var(--pill);font-size:var(--fs-xs);border:1px solid var(--line);color:var(--text-dim)}',
      '.pc-chip.is-on{border-color:var(--accent);color:var(--text)}',
      '.pc-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.pc-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:var(--fs-xs);color:var(--text-dim)}',
      '.pc-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}',
      '.pc-estimated{font-size:var(--fs-xs);color:var(--warn)}',
      '.pc-wheel-stage{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:14px;align-items:center}',
      '@media (max-width:760px){.pc-wheel-stage{grid-template-columns:1fr}}',
      '.pc-wheel-preview svg{max-height:260px;margin:0 auto}',
      '.pc-fallback-chart{width:100%;height:100%;display:block}'
    ].join('\n');
    var s = document.createElement('style');
    s.id = 'pc-styles';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ======================================================================
     METRICS: physics output merged over the local estimate
     ====================================================================== */
  var physCache = { build: null, m: null };
  var mergeCache = { build: null, src: null, out: null };
  function physicsFor(build) {
    if (physCache.build === build) return physCache.m;
    var m = null;
    if (CB.physics && typeof CB.physics.compute === 'function') {
      try { m = CB.physics.compute(build); } catch (e) { if (typeof console !== 'undefined') console.error('[panels-chassis] physics.compute failed', e); }
    }
    physCache = { build: build, m: m };
    return m;
  }
  function metricsFor(build, metrics) {
    var src = metrics && typeof metrics === 'object' ? metrics : physicsFor(build);
    if (mergeCache.build === build && mergeCache.src === src) return mergeCache.out;
    var est = estimateMetrics(build);
    var out;
    if (!src) { out = est; out._estimated = true; }
    else {
      out = {};
      Object.keys(est).forEach(function (k) { out[k] = est[k]; });
      Object.keys(src).forEach(function (k) { if (src[k] !== undefined && src[k] !== null) out[k] = src[k]; });
      if (!Array.isArray(src.downforceCurve) || src.downforceCurve.length < 2) out.downforceCurve = est.downforceCurve;
      out._estimated = false;
    }
    mergeCache = { build: build, src: src, out: out };
    return out;
  }

  /** Derived chassis figures for a build, memoised per (build, metrics). */
  var derivedCache = { build: null, m: null, d: null };
  function derived(build, m) {
    if (derivedCache.build === build && derivedCache.m === m) return derivedCache.d;
    var d = {
      susp: suspension(build, m), balance: balance(build, m), brakes: brakes(build, m), aero: aero(build, m),
      tf: tireGeom(build, 'front'), tr: tireGeom(build, 'rear'), speedo: speedo(build), ledger: weightLedger(build),
      usF: unsprung(build, 'front'), usR: unsprung(build, 'rear')
    };
    derivedCache = { build: build, m: m, d: d };
    return d;
  }

  /** Section subtotal: CB.pricing lines when available, else catalog-based estimate. */
  function sectionCost(build, sections, fallbackFn) {
    if (CB.pricing && typeof CB.pricing.compute === 'function') {
      try {
        var p = CB.pricing.compute(build, physicsFor(build));
        if (p && Array.isArray(p.lines)) {
          var t = 0, any = false;
          p.lines.forEach(function (l) { if (sections.indexOf(l.section) >= 0) { t += Number(l.amount) || 0; any = true; } });
          if (any) return { amount: t, estimated: false };
        }
      } catch (e) { /* fall through */ }
    }
    return { amount: fallbackFn(build), estimated: true };
  }
  function fp(coll, id) { var o = find(coll, id); return o ? num(o.price, 0) : 0; }

  /* ======================================================================
     WIDGET HELPERS
     ====================================================================== */
  /** A container that rebuilds its own contents only when keyFn(build) changes. */
  function slot(keyFn, renderFn, cls) {
    var host = el('div', { class: 'pc-slot' + (cls ? ' ' + cls : '') });
    var key = {};
    return ui.bind(host, '*', function (build) {
      var k = keyFn(build);
      if (k === key) return;
      key = k;
      U.clear(host);
      var content = renderFn(build);
      (Array.isArray(content) ? content : [content]).forEach(function (n) { if (n) host.appendChild(n); });
    });
  }

  function meter() {
    var bar = el('i'), mark = el('b', { hidden: true });
    var m = el('div', { class: 'pc-meter' }, bar, mark);
    m.set = function (frac, kind, markerFrac) {
      bar.style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';
      m.className = 'pc-meter' + (kind ? ' is-' + kind : '');
      if (markerFrac != null) { mark.hidden = false; mark.style.left = (clamp(markerFrac, 0, 1) * 100).toFixed(1) + '%'; }
      else mark.hidden = true;
      return m;
    };
    return m;
  }

  /** Labelled horizontal bars: rows [{key,label}] → el with .set(key, frac, text, kind) */
  function bars(rows) {
    var wrap = el('div', { class: 'pc-bars' });
    wrap.items = {};
    rows.forEach(function (r) {
      var mt = meter(), val = el('span');
      wrap.items[r.key] = { meter: mt, val: val };
      wrap.appendChild(el('div', { class: 'pc-bar', title: r.title || '' }, el('span', null, r.label), mt, val));
    });
    wrap.set = function (key, frac, text, kind, marker) {
      var it = wrap.items[key]; if (!it) return;
      it.meter.set(frac, kind, marker); it.val.textContent = text;
    };
    return wrap;
  }

  function statGrid(defs) {
    var g = el('div', { class: 'pc-stats' });
    g.tiles = {}; g.units = {};
    defs.forEach(function (d) {
      g.units[d.key] = d.unit || '';
      var t = ui.stat(d.label, null, d.unit || '', { decimals: d.decimals, kind: d.kind });
      if (d.title) t.title = d.title;
      g.tiles[d.key] = t;
      g.appendChild(t);
    });
    g.setAll = function (vals) {
      Object.keys(vals).forEach(function (k) {
        var v = vals[k];
        if (!g.tiles[k]) return;
        if (v && typeof v === 'object' && !Array.isArray(v)) g.tiles[k].set(v.value, v.unit != null ? v.unit : g.units[k], v.delta);
        else g.tiles[k].set(v == null || (typeof v === 'number' && !isFinite(v)) ? null : v, g.units[k]);
      });
    };
    return g;
  }

  /** Simple table whose body is replaced on .set(rows) — rows: [{cells:[...], cls, cellCls:[...]}] */
  function table(headers) {
    var tb = el('tbody');
    var t = el('table', { class: 'pc-table' }, el('thead', null, el('tr', null, headers.map(function (h) { return el('th', null, h); }))), tb);
    var wrap = el('div', { class: 'pc-table-wrap' }, t);
    var lastKey = null;
    wrap.set = function (rows) {
      var key = JSON.stringify(rows);
      if (key === lastKey) return wrap;
      lastKey = key;
      U.clear(tb);
      rows.forEach(function (r) {
        tb.appendChild(el('tr', { class: r.cls || null }, r.cells.map(function (c, i) { return el('td', { class: r.cellCls && r.cellCls[i] ? r.cellCls[i] : null }, c); })));
      });
      return wrap;
    };
    return wrap;
  }

  function widget(title, body) {
    return el('div', { class: 'pc-widget' }, el('div', { class: 'pc-title' }, title), body);
  }

  /** Diagram host: builds an SVG once from markup, exposes q(role) lookups for in-place mutation. */
  function diagram(caption, svgMarkup, extraCaption) {
    var host = el('div', { class: 'pc-diagram' });
    if (caption) host.appendChild(el('div', { class: 'pc-diagram-cap' }, el('span', null, caption), extraCaption || null));
    var svg = U.htmlToNode(svgMarkup);
    host.appendChild(svg);
    host.svg = svg;
    var cache = {};
    host.q = function (role) {
      if (!cache[role]) cache[role] = svg.querySelector('[data-r="' + role + '"]');
      return cache[role];
    };
    host.qa = function (role) { return svg.querySelectorAll('[data-r="' + role + '"]'); };
    host.attr = function (role, attrs) {
      var n = host.q(role); if (!n) return;
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    };
    host.text = function (role, t) { var n = host.q(role); if (n && n.textContent !== String(t)) n.textContent = t; };
    host.cls = function (role, c) { var n = host.q(role); if (n) n.setAttribute('class', c); };
    return host;
  }

  /* ---------------- fallback canvas plotter (only when CB.charts is missing) */
  function cssVar(name, fb) {
    try { var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fb; } catch (e) { return fb; }
  }
  function fallbackChart(kind, canvas, m) {
    var wrap = canvas.parentNode;
    var w = Math.max(200, (wrap && wrap.clientWidth) || 400), h = Math.max(120, ((wrap && wrap.clientHeight) || 220) - 18);
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var acc = cssVar('--accent', '#c8a46a'), acc2 = cssVar('--accent-2', '#6aa8c8'), dim = cssVar('--text-dim', '#999'), line = cssVar('--line', '#2a2a2a');
    ctx.font = '10px ' + cssVar('--mono', 'monospace');
    if (kind === 'downforce') {
      var c = Array.isArray(m.downforceCurve) ? m.downforceCurve : [];
      if (c.length < 2) return;
      var x1 = c[c.length - 1].kph, y1 = 1;
      c.forEach(function (p) { y1 = Math.max(y1, p.kg); });
      y1 *= 1.15;
      var pl = 36, pr = 10, pt = 10, pb = 22;
      function px(x) { return pl + x / x1 * (w - pl - pr); }
      function py(y) { return h - pb - y / y1 * (h - pt - pb); }
      ctx.strokeStyle = line; ctx.fillStyle = dim;
      for (var i = 0; i <= 4; i++) { var yy = pt + i * (h - pt - pb) / 4; ctx.beginPath(); ctx.moveTo(pl, yy); ctx.lineTo(w - pr, yy); ctx.stroke(); ctx.fillText(Math.round(y1 * (1 - i / 4)), 4, yy + 3); }
      ctx.fillText('0', pl, h - 6); ctx.fillText(Math.round(x1) + ' km/h', w - pr - 52, h - 6);
      ctx.strokeStyle = acc; ctx.lineWidth = 2; ctx.beginPath();
      c.forEach(function (p, k) { if (k) ctx.lineTo(px(p.kph), py(p.kg)); else ctx.moveTo(px(p.kph), py(p.kg)); });
      ctx.stroke();
      var cda = num(m.cda, 0.7);
      ctx.strokeStyle = acc2; ctx.setLineDash([4, 3]); ctx.beginPath();
      c.forEach(function (p, k) { var v = p.kph / 3.6, kg = 0.5 * RHO * cda * v * v / G; if (k) ctx.lineTo(px(p.kph), py(Math.min(kg, y1))); else ctx.moveTo(px(p.kph), py(kg)); });
      ctx.stroke(); ctx.setLineDash([]);
    } else if (kind === 'weight') {
      var fpct = num(m.weightFront_pct, 50), tot = num(m.weightFront_pct != null ? m.weight_kg : 0, 0);
      var bw = w - 20, by = h / 2 - 14;
      ctx.fillStyle = acc2; ctx.fillRect(10, by, bw * fpct / 100, 28);
      ctx.fillStyle = acc; ctx.fillRect(10 + bw * fpct / 100, by, bw * (1 - fpct / 100), 28);
      ctx.fillStyle = cssVar('--text', '#eee'); ctx.font = '12px ' + cssVar('--mono', 'monospace');
      ctx.fillText('F ' + fpct.toFixed(1) + '%', 16, by + 18);
      ctx.fillText('R ' + (100 - fpct).toFixed(1) + '%', w - 90, by + 18);
      ctx.fillStyle = dim; ctx.fillText(Math.round(tot) + ' kg', w / 2 - 24, by + 48);
    }
  }

  /** Chart that redraws (rAF-coalesced) whenever metrics change. */
  function liveChart(P, kind, opts) {
    opts = opts || {};
    var wrap = ui.chart({ height: opts.height || 230, title: opts.title, label: opts.label || opts.title });
    var inst = null, lastM = null, frame = 0;
    function draw() {
      frame = 0;
      var m = P.metrics;
      if (!m || !wrap.isConnected) return;
      if (CB.charts && typeof CB.charts[kind] === 'function') {
        try {
          if (inst && typeof inst.update === 'function') { inst.update(m); return; }
          if (inst && inst.destroy) inst.destroy();
          inst = kind === 'weight' ? CB.charts.weight(wrap.canvas, m, opts.chartOpts || {}) : CB.charts[kind](wrap.canvas, m, null, opts.chartOpts || {});
          return;
        } catch (e) { if (typeof console !== 'undefined') console.error('[panels-chassis] chart ' + kind + ' failed', e); inst = null; }
      }
      try { fallbackChart(kind, wrap.canvas, m); } catch (e2) { /* ignore */ }
    }
    P.watch(wrap, function (b, m) {
      if (m === lastM) return;
      lastM = m;
      if (!frame) frame = raf(draw);
    }, function () {
      if (frame) caf(frame);
      if (inst && inst.destroy) { try { inst.destroy(); } catch (e) { /* ignore */ } }
      inst = null;
    });
    return wrap;
  }

  /* ======================================================================
     PANEL FACTORY
     ====================================================================== */
  function makePanel(def) {
    var P = { root: null, mounted: false, build: null, metrics: null, watchers: [], id: def.id };
    P.d = function () { return derived(P.build || cur(), P.metrics); };
    P.watch = function (node, fn, dispose) {
      var w = { node: node, fn: fn, dispose: dispose };
      P.watchers.push(w);
      if (P.mounted) { try { fn(P.build || cur(), P.metrics, { path: '*' }); } catch (e) { if (typeof console !== 'undefined') console.error('[panels-chassis] watcher', e); } }
      return node;
    };
    P.disposeAll = function () {
      P.watchers.forEach(function (w) { if (w.dispose) { try { w.dispose(); } catch (e) { /* ignore */ } } });
      P.watchers = [];
    };
    P.refresh = function (change) {
      if (!P.root) return;
      var keep = [];
      P.watchers.forEach(function (w) {
        if (!P.root.contains(w.node)) { if (w.dispose) { try { w.dispose(); } catch (e) { /* ignore */ } } return; }
        keep.push(w);
        try { w.fn(P.build, P.metrics, change || { path: '*' }); } catch (e) { if (typeof console !== 'undefined') console.error('[panels-chassis] watcher', e); }
      });
      P.watchers = keep;
    };
    CB.registerPanel({
      id: def.id, title: def.title, subtitle: def.subtitle, icon: (ui.icons && ui.icons[def.id]) || undefined,
      group: 'Chassis', order: def.order,
      render: function (container, build, metrics) {
        injectStyles();
        P.disposeAll();
        if (P.root && P.root.parentNode === container) container.removeChild(P.root);
        P.mounted = false;
        P.build = build || cur();
        P.metrics = metricsFor(P.build, metrics);
        var root = el('div', { class: 'pc-panel pc-panel-' + def.id, dataset: { panel: def.id } });
        P.root = root;
        try { def.build(root, P, P.build); }
        catch (e) {
          if (typeof console !== 'undefined') console.error('[panels-chassis] render failed for ' + def.id, e);
          root.appendChild(note('This panel failed to render: ' + (e && e.message), 'error'));
        }
        container.appendChild(root);
        P.mounted = true;
        ui.syncAll(root, P.build);
        P.refresh({ path: '*' });
        return root;
      },
      update: function (build, metrics, change) {
        if (!P.root) return;
        P.build = build || cur();
        P.metrics = metricsFor(P.build, metrics);
        ui.syncAll(P.root, P.build);
        P.refresh(change);
      }
    });
    return P;
  }

  /* ======================================================================
     SVG ICON GENERATORS (card art; drawn in currentColor)
     ====================================================================== */
  function coil(x, y1, y2, w, turns, extra) {
    var d = 'M' + x + ' ' + y1, step = (y2 - y1) / (turns * 2);
    for (var i = 0; i < turns * 2; i++) d += ' L' + (x + (i % 2 ? -w : w)) + ' ' + f1(y1 + step * (i + 0.5));
    d += ' L' + x + ' ' + y2;
    return '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" ' + (extra || '') + '/>';
  }
  function hubWheel(cx, cy, r) {
    return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="currentColor" fill-opacity=".14" stroke="currentColor" stroke-width="1.6"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r * 0.55) + '" fill="none" stroke="currentColor" stroke-opacity=".5"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="2" fill="currentColor"/>';
  }
  function suspensionIcon(t) {
    var out = '<line x1="2" y1="44" x2="94" y2="44" stroke="currentColor" stroke-opacity=".2"/>' + hubWheel(74, 28, 15);
    var bodyRect = '<path d="M2 6 h30 v8 h-30" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-opacity=".45"/>';
    switch (t.id) {
      case 'macpherson':
        out += bodyRect + '<path d="M58 8 L66 26" stroke="currentColor" stroke-width="5" stroke-opacity=".35" stroke-linecap="round"/>' + coil(60, 8, 22, 4, 4) +
          '<path d="M10 34 L66 33" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="34" r="2.3" fill="currentColor"/>'; break;
      case 'double-wishbone':
        out += bodyRect + '<path d="M14 16 L62 18 M14 40 L64 38" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
          '<circle cx="14" cy="16" r="2.3" fill="currentColor"/><circle cx="14" cy="40" r="2.3" fill="currentColor"/>' + coil(42, 6, 36, 4, 4) +
          '<path d="M62 18 L64 38" stroke="currentColor" stroke-width="3"/>'; break;
      case 'multilink':
        out += bodyRect + '<path d="M12 16 L62 19 M12 24 L60 26 M12 34 L62 34 M12 40 L64 38 M20 44 L62 37" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
          [16, 24, 34, 40].map(function (y) { return '<circle cx="12" cy="' + y + '" r="1.8" fill="currentColor"/>'; }).join('') + coil(40, 4, 30, 3.5, 4); break;
      case 'pushrod':
        out += '<path d="M2 8 h40 v8 h-40" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-opacity=".45"/>' +
          '<path d="M14 18 L62 19 M14 40 L64 38" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
          '<path d="M62 37 L36 14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
          '<path d="M30 10 L40 10 L36 18 Z" fill="currentColor" fill-opacity=".6"/>' +
          '<path d="M8 12 h22" stroke="currentColor" stroke-width="4" stroke-opacity=".5"/>' + coil(19, 6, 18, 3, 3, 'transform="rotate(90 19 12)"'); break;
      case 'air':
        out += bodyRect + '<path d="M14 18 L62 19 M14 40 L64 38" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
          '<rect x="34" y="6" width="16" height="7" rx="3.5" fill="currentColor" fill-opacity=".35" stroke="currentColor"/>' +
          '<ellipse cx="42" cy="18" rx="9" ry="5" fill="currentColor" fill-opacity=".25" stroke="currentColor"/><ellipse cx="42" cy="26" rx="9" ry="5" fill="currentColor" fill-opacity=".25" stroke="currentColor"/>' +
          '<path d="M42 31 v6" stroke="currentColor" stroke-width="2"/><path d="M6 26 q4 -4 8 0 t8 0" fill="none" stroke="currentColor" stroke-opacity=".6"/>'; break;
      case 'magnetic':
        out += bodyRect + '<path d="M14 18 L62 19 M14 40 L64 38" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' + coil(42, 4, 34, 4.5, 4, 'stroke-opacity=".5"') +
          '<rect x="38" y="12" width="8" height="18" rx="2" fill="currentColor" fill-opacity=".45"/>' +
          [15, 20, 25].map(function (y) { return '<circle cx="' + (40 + (y % 2) * 2) + '" cy="' + y + '" r="1" fill="var(--panel,#111)"/>'; }).join('') +
          '<path d="M50 9 l-4 6 h3 l-2 5 l5 -7 h-3 l2 -4z" fill="currentColor"/>'; break;
      case 'coilover-track':
        out += bodyRect + '<path d="M14 18 L62 19 M14 40 L64 38" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' + coil(42, 6, 30, 5, 5) +
          '<rect x="37" y="28" width="10" height="4" fill="currentColor"/><rect x="37" y="24" width="10" height="2" fill="currentColor" fill-opacity=".6"/>' +
          '<circle cx="42" cy="4" r="2.4" fill="none" stroke="currentColor"/><path d="M48 3 h6 M48 7 h6 M48 11 h6" stroke="currentColor" stroke-opacity=".6"/>'; break;
      default: out += coil(42, 6, 34, 4, 4);
    }
    return svgWrap('0 0 96 48', 96, 48, out, 'pc-susp-icon');
  }

  function rotorArt(cx, cy, r, mat, opts) {
    opts = opts || {};
    var id = mat && mat.id || 'iron';
    var face = id === 'carbon-ceramic' ? 'fill="currentColor" fill-opacity=".42"' : 'fill="currentColor" fill-opacity=".22"';
    var out = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" ' + face + ' stroke="currentColor" stroke-width="1.3"/>';
    var hatR = r * 0.45;
    if (id === 'two-piece' || id === 'carbon-ceramic') {
      out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + f1(hatR) + '" fill="var(--panel,#111)" stroke="currentColor" stroke-width="1.2"/>';
      for (var k = 0; k < 10; k++) {
        var a = k / 10 * Math.PI * 2;
        out += '<circle cx="' + f1(cx + Math.cos(a) * (hatR + r * 0.06)) + '" cy="' + f1(cy + Math.sin(a) * (hatR + r * 0.06)) + '" r="' + f1(r * 0.035) + '" fill="currentColor"/>';
      }
    } else {
      out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + f1(hatR) + '" fill="currentColor" fill-opacity=".35" stroke="currentColor"/>';
    }
    if (id === 'drilled-slotted') {
      for (var i = 0; i < 24; i++) {
        var aa = i / 24 * Math.PI * 2, rr = r * (0.62 + (i % 3) * 0.1);
        out += '<circle cx="' + f1(cx + Math.cos(aa) * rr) + '" cy="' + f1(cy + Math.sin(aa) * rr) + '" r="' + f1(r * 0.035) + '" fill="var(--panel,#111)"/>';
      }
      for (var j = 0; j < 6; j++) {
        var a2 = (j / 6 + 0.04) * Math.PI * 2;
        out += '<path d="M' + f1(cx + Math.cos(a2) * r * 0.55) + ' ' + f1(cy + Math.sin(a2) * r * 0.55) + ' L' + f1(cx + Math.cos(a2 + 0.35) * r * 0.95) + ' ' + f1(cy + Math.sin(a2 + 0.35) * r * 0.95) + '" stroke="var(--panel,#111)" stroke-width="1.2"/>';
      }
    }
    if (id === 'carbon-ceramic') {
      for (var c = 0; c < 18; c++) {
        var a3 = c / 18 * Math.PI * 2;
        out += '<line x1="' + f1(cx + Math.cos(a3) * r * 0.58) + '" y1="' + f1(cy + Math.sin(a3) * r * 0.58) + '" x2="' + f1(cx + Math.cos(a3 + 0.2) * r * 0.97) + '" y2="' + f1(cy + Math.sin(a3 + 0.2) * r * 0.97) + '" stroke="currentColor" stroke-opacity=".35" stroke-width=".8"/>';
      }
    }
    if (opts.caliper !== false) {
      var ca0 = -Math.PI * 0.62, ca1 = -Math.PI * 0.18, ro = r + r * 0.06, ri = r * 0.68;
      out += '<path d="M' + f1(cx + Math.cos(ca0) * ro) + ' ' + f1(cy + Math.sin(ca0) * ro) + ' A' + f1(ro) + ' ' + f1(ro) + ' 0 0 1 ' + f1(cx + Math.cos(ca1) * ro) + ' ' + f1(cy + Math.sin(ca1) * ro) +
        ' L' + f1(cx + Math.cos(ca1) * ri) + ' ' + f1(cy + Math.sin(ca1) * ri) + ' A' + f1(ri) + ' ' + f1(ri) + ' 0 0 0 ' + f1(cx + Math.cos(ca0) * ri) + ' ' + f1(cy + Math.sin(ca0) * ri) + ' Z" fill="' + (opts.caliperColor || 'currentColor') + '" fill-opacity="' + (opts.caliperColor ? 1 : 0.75) + '"/>';
    }
    return out;
  }
  function brakeIcon(mat) {
    var fade = num(mat.fadeResistance, 0.5), out = rotorArt(26, 24, 20, mat);
    out += '<text x="54" y="13" font-size="7" fill="currentColor" fill-opacity=".7">FADE</text>';
    for (var i = 0; i < 8; i++) out += '<rect x="' + (54 + i * 5) + '" y="16" width="3.6" height="7" rx="1" fill="currentColor" fill-opacity="' + (i < Math.round(fade * 8) ? 0.85 : 0.15) + '"/>';
    out += '<text x="54" y="34" font-size="7" fill="currentColor" fill-opacity=".7">MASS</text>';
    out += '<rect x="54" y="37" width="' + f1(38 * num(mat.weightPerRotor_kg, 10) / 12) + '" height="4" rx="2" fill="currentColor" fill-opacity=".55"/>';
    return svgWrap('0 0 96 48', 96, 48, out, 'pc-brake-icon');
  }

  /* ---------------- wheel faces */
  function spokePath(cx, cy, a, r0, r1, w0, w1) {
    var ca = Math.cos(a), sa = Math.sin(a), px = -sa, py = ca;
    return 'M' + f1(cx + ca * r0 + px * w0) + ' ' + f1(cy + sa * r0 + py * w0) +
      ' L' + f1(cx + ca * r1 + px * w1) + ' ' + f1(cy + sa * r1 + py * w1) +
      ' L' + f1(cx + ca * r1 - px * w1) + ' ' + f1(cy + sa * r1 - py * w1) +
      ' L' + f1(cx + ca * r0 - px * w0) + ' ' + f1(cy + sa * r0 - py * w0) + ' Z';
  }
  /**
   * wheelFace(design, cx, cy, R, opts) — SVG markup of a wheel face of radius R (rim edge).
   * opts: { color, lip, hub, rotor:{r, mat, caliper}, detail }
   */
  function wheelFace(des, cx, cy, R, opts) {
    opts = opts || {};
    var col = opts.color || 'currentColor';
    var style = des && des.style || 'y', n = Math.max(0, des && des.spokes || 5);
    var face = R * 0.9, hub = R * (style === 'centerlock' ? 0.2 : 0.24);
    var out = '';
    // barrel (dark) & rotor/caliper behind spokes
    out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="' + (opts.barrel || 'var(--bg-2,#0b0b0d)') + '"/>';
    if (opts.rotor) out += rotorArt(cx, cy, opts.rotor.r, opts.rotor.mat, { caliperColor: opts.rotor.caliper });
    var sp = 'fill="' + col + '"';
    var i, a;
    switch (style) {
      case 'y':
        for (i = 0; i < n; i++) {
          a = i / n * Math.PI * 2 - Math.PI / 2;
          out += '<path d="' + spokePath(cx, cy, a, hub * 0.8, face * 0.5, R * 0.07, R * 0.05) + '" ' + sp + '/>';
          out += '<path d="' + spokePath(cx, cy, a - 0.2, face * 0.48, face, R * 0.045, R * 0.04) + '" ' + sp + '/>';
          out += '<path d="' + spokePath(cx, cy, a + 0.2, face * 0.48, face, R * 0.045, R * 0.04) + '" ' + sp + '/>';
        }
        break;
      case 'split':
        for (i = 0; i < n; i++) {
          a = i / n * Math.PI * 2 - Math.PI / 2;
          var sep = n > 7 ? 0.09 : 0.12;
          out += '<path d="' + spokePath(cx, cy, a - sep * 0.4, hub, face, R * 0.035, R * 0.03) + '" ' + sp + '/>';
          out += '<path d="' + spokePath(cx, cy, a + sep * 0.4, hub, face, R * 0.035, R * 0.03) + '" ' + sp + '/>';
          if (n <= 7) out += '<path d="' + spokePath(cx, cy, a, hub, face * 0.55, R * 0.06, R * 0.02) + '" ' + sp + '/>';
        }
        break;
      case 'mesh':
        var m2 = Math.max(10, n);
        for (i = 0; i < m2; i++) {
          a = i / m2 * Math.PI * 2;
          out += '<path d="M' + f1(cx + Math.cos(a) * hub) + ' ' + f1(cy + Math.sin(a) * hub) + ' L' + f1(cx + Math.cos(a + 0.55) * face) + ' ' + f1(cy + Math.sin(a + 0.55) * face) + '" stroke="' + col + '" stroke-width="' + f1(R * 0.035) + '" stroke-linecap="round"/>';
          out += '<path d="M' + f1(cx + Math.cos(a) * hub) + ' ' + f1(cy + Math.sin(a) * hub) + ' L' + f1(cx + Math.cos(a - 0.55) * face) + ' ' + f1(cy + Math.sin(a - 0.55) * face) + '" stroke="' + col + '" stroke-width="' + f1(R * 0.035) + '" stroke-linecap="round"/>';
        }
        out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + f1(face * 0.98) + '" fill="none" stroke="' + col + '" stroke-width="' + f1(R * 0.04) + '"/>';
        break;
      case 'turbine':
        for (i = 0; i < n; i++) {
          a = i / n * Math.PI * 2;
          var a1 = a + 0.5, a0 = a;
          out += '<path d="M' + f1(cx + Math.cos(a0) * hub) + ' ' + f1(cy + Math.sin(a0) * hub) +
            ' Q' + f1(cx + Math.cos(a0 + 0.35) * face * 0.7) + ' ' + f1(cy + Math.sin(a0 + 0.35) * face * 0.7) + ' ' + f1(cx + Math.cos(a1) * face) + ' ' + f1(cy + Math.sin(a1) * face) +
            ' L' + f1(cx + Math.cos(a1 + 0.22) * face) + ' ' + f1(cy + Math.sin(a1 + 0.22) * face) +
            ' Q' + f1(cx + Math.cos(a0 + 0.58) * face * 0.62) + ' ' + f1(cy + Math.sin(a0 + 0.58) * face * 0.62) + ' ' + f1(cx + Math.cos(a0 + 0.3) * hub) + ' ' + f1(cy + Math.sin(a0 + 0.3) * hub) + ' Z" ' + sp + '/>';
        }
        break;
      case 'monoblock':
        for (i = 0; i < n; i++) {
          a = i / n * Math.PI * 2 - Math.PI / 2;
          var star = des.id === 'classic-5';
          out += '<path d="' + spokePath(cx, cy, a, hub * 0.9, face, R * (star ? 0.16 : 0.13), R * (star ? 0.04 : 0.1)) + '" ' + sp + '/>';
        }
        break;
      case 'dish':
        out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + f1(face) + '" fill="none" stroke="' + col + '" stroke-width="' + f1(R * 0.12) + '" stroke-opacity=".9"/>';
        for (i = 0; i < n; i++) {
          a = i / n * Math.PI * 2 - Math.PI / 2;
          out += '<path d="' + spokePath(cx, cy, a, hub, face * 0.62, R * 0.07, R * 0.06) + '" ' + sp + '/>';
        }
        out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + f1(face * 0.62) + '" fill="none" stroke="' + col + '" stroke-width="' + f1(R * 0.06) + '"/>';
        if (des.id === 'beadlock') {
          for (i = 0; i < 24; i++) {
            a = i / 24 * Math.PI * 2;
            out += '<circle cx="' + f1(cx + Math.cos(a) * face) + '" cy="' + f1(cy + Math.sin(a) * face) + '" r="' + f1(R * 0.02) + '" fill="var(--bg-2,#0b0b0d)"/>';
          }
        }
        break;
      case 'centerlock':
        for (i = 0; i < n; i++) {
          a = i / n * Math.PI * 2 - Math.PI / 2;
          out += '<path d="' + spokePath(cx, cy, a, hub * 0.8, face, R * 0.055, R * 0.035) + '" ' + sp + '/>';
        }
        break;
      case 'aero-disc':
        if (n === 0) {
          out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + f1(face) + '" ' + sp + ' fill-opacity=".92"/>';
          for (i = 0; i < 3; i++) out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + f1(face * (0.4 + i * 0.2)) + '" fill="none" stroke="var(--bg-2,#000)" stroke-opacity=".25"/>';
        } else {
          for (i = 0; i < n; i++) {
            a = i / n * Math.PI * 2 - Math.PI / 2;
            out += '<path d="M' + f1(cx + Math.cos(a) * hub) + ' ' + f1(cy + Math.sin(a) * hub) + ' A' + f1(face) + ' ' + f1(face) + ' 0 0 1 ' + f1(cx + Math.cos(a + 1.05) * face) + ' ' + f1(cy + Math.sin(a + 1.05) * face) +
              ' L' + f1(cx + Math.cos(a + 1.18) * face) + ' ' + f1(cy + Math.sin(a + 1.18) * face) + ' A' + f1(face * 0.8) + ' ' + f1(face * 0.8) + ' 0 0 0 ' + f1(cx + Math.cos(a + 0.2) * hub) + ' ' + f1(cy + Math.sin(a + 0.2) * hub) + ' Z" ' + sp + '/>';
          }
        }
        break;
    }
    // lip & hub
    out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + f1(R * 0.95) + '" fill="none" stroke="' + (opts.lip || col) + '" stroke-width="' + f1(R * 0.1) + '"/>';
    out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + f1(hub) + '" ' + sp + '/>';
    if (style === 'centerlock') {
      var nut = '';
      for (i = 0; i < 6; i++) { a = i / 6 * Math.PI * 2; nut += (i ? ' L' : 'M') + f1(cx + Math.cos(a) * hub * 0.75) + ' ' + f1(cy + Math.sin(a) * hub * 0.75); }
      out += '<path d="' + nut + ' Z" fill="var(--bg-2,#0b0b0d)" fill-opacity=".55" stroke="' + col + '"/>';
      out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + f1(hub * 0.3) + '" fill="#d23"/>';
    } else {
      var lugs = n === 6 ? 6 : 5;
      for (i = 0; i < lugs; i++) {
        a = i / lugs * Math.PI * 2 - Math.PI / 2;
        out += '<circle cx="' + f1(cx + Math.cos(a) * hub * 0.6) + '" cy="' + f1(cy + Math.sin(a) * hub * 0.6) + '" r="' + f1(Math.max(0.6, hub * 0.12)) + '" fill="var(--bg-2,#0b0b0d)" fill-opacity=".8"/>';
      }
      out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + f1(hub * 0.28) + '" fill="var(--bg-2,#0b0b0d)" fill-opacity=".5"/>';
    }
    return out;
  }
  function wheelIcon(des) {
    var out = '<circle cx="48" cy="30" r="27" fill="currentColor" fill-opacity=".85"/>' + wheelFace(des, 48, 30, 21, { color: 'currentColor', barrel: 'var(--panel,#111)' });
    return svgWrap('0 0 96 60', 96, 60, out, 'pc-wheel-icon');
  }
  function wheelMaterialIcon(m) {
    var wf = num(m.weightFactor, 1), out = '';
    var pat = { steel: 'M8 8 h80', cast: '', 'flow-formed': '', forged: '', magnesium: '', carbon: '' };
    out += '<rect x="6" y="8" width="56" height="26" rx="5" fill="currentColor" fill-opacity="' + (m.id === 'carbon' ? 0.4 : 0.18) + '" stroke="currentColor" stroke-width="1.2"/>';
    if (m.id === 'carbon') for (var i = 0; i < 9; i++) out += '<path d="M' + (8 + i * 6) + ' 10 l6 6 l-6 6 l6 6" fill="none" stroke="currentColor" stroke-opacity=".45"/>';
    else if (m.id === 'forged' || m.id === 'magnesium') for (var j = 0; j < 6; j++) out += '<path d="M10 ' + (12 + j * 4) + ' h48" stroke="currentColor" stroke-opacity=".35"/>';
    else if (m.id === 'flow-formed') for (var k = 0; k < 5; k++) out += '<path d="M' + (12 + k * 10) + ' 10 q4 11 0 22" fill="none" stroke="currentColor" stroke-opacity=".4"/>';
    else if (m.id === 'steel') out += '<circle cx="20" cy="21" r="3" fill="none" stroke="currentColor"/><circle cx="34" cy="21" r="3" fill="none" stroke="currentColor"/><circle cx="48" cy="21" r="3" fill="none" stroke="currentColor"/>';
    else out += '<path d="M12 28 q10 -14 22 -4 t22 -8" fill="none" stroke="currentColor" stroke-opacity=".5"/>';
    void pat;
    // weight scale bar
    out += '<text x="68" y="14" font-size="7" fill="currentColor" fill-opacity=".7">MASS</text>';
    out += '<rect x="68" y="18" width="24" height="16" rx="2" fill="none" stroke="currentColor" stroke-opacity=".4"/>';
    out += '<rect x="68" y="' + f1(34 - 16 * clamp(wf / 1.35, 0.1, 1)) + '" width="24" height="' + f1(16 * clamp(wf / 1.35, 0.1, 1)) + '" rx="2" fill="currentColor" fill-opacity=".6"/>';
    return svgWrap('0 0 96 40', 96, 40, out, 'pc-mat-icon');
  }
  function compoundIcon(c) {
    var mu = clamp((num(c.mu, 1) - 0.7) / (1.6 - 0.7), 0.04, 1);
    var tw = clamp(num(c.treadwear, 300) / 700, 0.04, 1);
    var noise = clamp((num(c.noise, 70) - 62) / 18, 0.04, 1);
    var wet = clamp((num(c.wetMu, 0.8) - 0.2) / 0.7, 0.04, 1);
    var out = '';
    // tread block
    out += '<rect x="4" y="4" width="26" height="44" rx="5" fill="currentColor" fill-opacity=".2" stroke="currentColor" stroke-width="1.2"/>';
    var id = c.id;
    if (id === 'slick') { /* smooth */ }
    else if (id === 'track') out += '<path d="M12 6 v40 M22 6 v40" stroke="var(--panel,#111)" stroke-width="2"/>';
    else if (id === 'winter') for (var i = 0; i < 9; i++) out += '<path d="M6 ' + (8 + i * 4.5) + ' l6 -2 l5 3 l5 -3 l6 2" fill="none" stroke="var(--panel,#111)" stroke-width="1.2"/>';
    else if (id === 'all-season') for (var j = 0; j < 6; j++) out += '<path d="M6 ' + (9 + j * 7) + ' l10 3 l10 -3" fill="none" stroke="var(--panel,#111)" stroke-width="1.8"/>';
    else {
      out += '<path d="M11 6 v40 M23 6 v40" stroke="var(--panel,#111)" stroke-width="1.8"/>';
      var gap = id === 'eco' || id === 'touring' ? 5 : 8;
      for (var k = 0; k < 40 / gap; k++) out += '<path d="M23 ' + (8 + k * gap) + ' l6 3" stroke="var(--panel,#111)" stroke-width="1.3"/><path d="M5 ' + (10 + k * gap) + ' l6 -2" stroke="var(--panel,#111)" stroke-width="1.3"/>';
    }
    function bar(y, label, v) {
      return '<text x="36" y="' + (y + 5) + '" font-size="6.6" letter-spacing=".5" fill="currentColor" fill-opacity=".72">' + label + '</text>' +
        '<rect x="62" y="' + y + '" width="30" height="5.5" rx="2.75" fill="currentColor" fill-opacity=".15"/>' +
        '<rect x="62" y="' + y + '" width="' + f1(30 * v) + '" height="5.5" rx="2.75" fill="currentColor" fill-opacity=".85"/>';
    }
    out += bar(6, 'GRIP', mu) + bar(17, 'WET', wet) + bar(28, 'WEAR', tw) + bar(39, 'NOISE', noise);
    return svgWrap('0 0 96 52', 96, 52, out, 'pc-compound-icon');
  }

  /* ---------------- aero card art */
  function dfArrows(x0, n, len, gap) {
    var out = '';
    for (var i = 0; i < n; i++) {
      var x = x0 + i * (gap || 7);
      out += '<path d="M' + x + ' 1 v' + f1(len) + ' m-2.5 -3 l2.5 3 l2.5 -3" fill="none" stroke="currentColor" stroke-opacity=".75" stroke-width="1.1"/>';
    }
    return out;
  }
  function splitterIcon(o) {
    // car faces left; nose at x=22
    var out = '<path d="M22 40 L22 30 Q24 25 38 23 L70 19 Q84 17 96 12 L96 40 Z" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-opacity=".55" stroke-width="1.1"/>' +
      '<circle cx="74" cy="40" r="9" fill="var(--panel,#111)" stroke="currentColor" stroke-width="1.3"/>';
    var len = { none: 0, lip: 5, carbon: 10, race: 17 }[o.id] || 0;
    if (len) {
      out += '<path d="M' + (22 - len) + ' 39 L46 39 L46 41.5 L' + (22 - len) + ' 41.5 Z" fill="currentColor"/>';
      if (o.id !== 'lip') out += '<path d="M' + (22 - len) + ' 39 v-3" stroke="currentColor" stroke-width="1.4"/>';
      if (o.id === 'race') out += '<path d="M' + (24 - len) + ' 39 L22 31" stroke="currentColor" stroke-width="1"/>';
    }
    var df = num(o.downforce_kg_at_200, 0);
    if (df) out += dfArrows(22 - len + 3, Math.min(4, Math.ceil(df / 18)), 8 + df / 10, 6);
    return svgWrap('0 0 96 48', 96, 48, out, 'pc-aero-icon');
  }
  function wingIcon(o) {
    // car faces right; tail at x=4
    var id = o.id;
    var out = '<path d="M4 46 L4 30 Q6 26 12 26 L42 24 Q66 20 94 14 L94 46 Z" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-opacity=".55" stroke-width="1.1"/>' +
      '<circle cx="28" cy="46" r="9" fill="var(--panel,#111)" stroke="currentColor" stroke-width="1.3"/>';
    function element(y) { return '<path d="M4 ' + y + ' q15 -5 32 -1 l-1 2.6 q-15 -2 -31 1 z" fill="currentColor"/>'; }
    if (id === 'ducktail') out += '<path d="M4 27 Q3 19 16 21 L16 25.6 Z" fill="currentColor"/>';
    else if (id === 'lip-spoiler') out += '<path d="M5 26 L14 21.5 L14 25.8 Z" fill="currentColor"/>';
    else if (id === 'gt-wing' || id === 'active' || id === 'biplane') {
      out += '<path d="M14 25.5 v-11 M28 24.5 v-10" stroke="currentColor" stroke-width="1.6"/>' + element(14);
      if (id === 'biplane') out += element(7);
      if (id === 'active') out += '<path d="M44 12 a6 6 0 1 1 -2 -4.5" fill="none" stroke="currentColor" stroke-opacity=".75"/><path d="M41 5 l1.5 2.5 l2.6 -1.4" fill="none" stroke="currentColor" stroke-opacity=".75"/>';
    } else if (id === 'swan-neck') {
      out += '<path d="M16 25.5 q0 -9 3 -14 M30 24.5 q0 -9 3 -14" fill="none" stroke="currentColor" stroke-width="1.5"/>' + element(10);
    }
    var df = num(o.downforce_kg_at_200, 0);
    if (df) out += dfArrows(52, Math.min(6, Math.ceil(df / 45)), 4 + Math.min(12, df / 22), 7);
    return svgWrap('0 0 96 48', 96, 48, out, 'pc-aero-icon');
  }
  function diffuserIcon(o) {
    var out = '<path d="M2 18 L70 18 Q84 18 94 6" fill="none" stroke="currentColor" stroke-opacity=".55" stroke-width="1.2"/>';
    out += '<path d="M2 18 L70 18 Q84 18 94 6 L94 2 L2 2 Z" fill="currentColor" fill-opacity=".1"/>';
    var strakes = { none: 0, mild: 3, carbon: 5, race: 7 }[o.id] || 0;
    for (var i = 0; i < strakes; i++) {
      var x = 64 + i * 4;
      out += '<path d="M' + x + ' 18 L' + (x + 8) + ' ' + (20 + i * 0.6 + (o.id === 'race' ? 6 : 3)) + '" stroke="currentColor" stroke-width="1.2"/>';
    }
    if (o.id === 'race') out += '<path d="M2 26 Q50 30 94 18" fill="none" stroke="currentColor" stroke-dasharray="3 2" stroke-opacity=".7"/>';
    // airflow streaks
    out += '<path d="M4 24 h' + (40 + strakes * 4) + (strakes ? ' q10 0 18 -' + (2 + strakes) : '') + '" fill="none" stroke="currentColor" stroke-opacity=".35"/>';
    out += '<path d="M4 30 h' + (50 + strakes * 3) + '" fill="none" stroke="currentColor" stroke-opacity=".22"/>';
    return svgWrap('0 0 96 36', 96, 36, out, 'pc-aero-icon');
  }

  /* ---------------- weight card art */
  function cageIcon(o) {
    var out = '<path d="M6 36 L18 12 Q22 6 34 6 L60 6 Q72 6 78 14 L90 36" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="1.2"/>';
    if (o.id === 'half' || o.id === 'full') out += '<path d="M44 36 L46 8 L62 8 L66 36" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M62 8 L84 34" stroke="currentColor" stroke-width="1.8"/>';
    if (o.id === 'full') out += '<path d="M46 8 L22 12 L12 34 M22 12 L30 36 M46 12 L66 30 M24 12 L44 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';
    if (o.id === 'none') out += '<path d="M30 22 h36" stroke="currentColor" stroke-opacity=".3" stroke-dasharray="3 3"/>';
    return svgWrap('0 0 96 40', 96, 40, out, 'pc-cage-icon');
  }
  function glassIcon(o) {
    var t = o.id === 'polycarbonate' ? 0.3 : o.id === 'thin' ? 0.6 : 1;
    var out = '<path d="M10 34 L24 8 L70 8 L86 34 Z" fill="currentColor" fill-opacity="' + (0.12 + 0.18 * t) + '" stroke="currentColor" stroke-width="' + f1(1 + t * 2.2) + '" stroke-linejoin="round"/>';
    out += '<path d="M30 14 L40 14 L32 28" fill="none" stroke="currentColor" stroke-opacity=".55"/>';
    if (o.id === 'polycarbonate') out += '<rect x="56" y="18" width="10" height="5" rx="1" fill="currentColor" fill-opacity=".6"/>';
    return svgWrap('0 0 96 40', 96, 40, out, 'pc-glass-icon');
  }
  function batteryIcon(o) {
    var li = o.id === 'lithium';
    var out = '<rect x="' + (li ? 30 : 18) + '" y="' + (li ? 12 : 6) + '" width="' + (li ? 36 : 60) + '" height="' + (li ? 22 : 28) + '" rx="3" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width="1.3"/>';
    var x0 = li ? 34 : 24, x1 = li ? 58 : 68;
    out += '<rect x="' + x0 + '" y="' + (li ? 8 : 2) + '" width="5" height="4" fill="currentColor"/><rect x="' + x1 + '" y="' + (li ? 8 : 2) + '" width="5" height="4" fill="currentColor"/>';
    out += li ? '<path d="M50 15 l-5 8 h4 l-2 7 l7 -9 h-4 l2 -6z" fill="currentColor"/>' : '<text x="48" y="25" font-size="9" text-anchor="middle" fill="currentColor" fill-opacity=".7">Pb</text>';
    return svgWrap('0 0 96 40', 96, 40, out, 'pc-batt-icon');
  }

  /* ======================================================================
     PANEL: SUSPENSION
     ====================================================================== */
  function suspTypeOf(b) { return find('suspensionTypes', get(b, 'suspension.type')) || Dt.suspensionTypes[0]; }

  function presetSpark(p) {
    var v = p.values;
    var stiff = clamp((v.springFront_nmm + v.springRear_nmm) / 2 / 160, 0.05, 1);
    var camber = clamp((Math.abs(v.camberFront_deg) + Math.abs(v.camberRear_deg)) / 10, 0.05, 1);
    var low = clamp((160 - v.rideHeight_mm) / 110, 0.05, 1);
    var damp = clamp(v.damping / 10, 0.05, 1);
    var out = '';
    [['K', stiff], ['C', camber], ['L', low], ['D', damp]].forEach(function (x, i) {
      var bx = i * 26;
      out += '<rect x="' + bx + '" y="2" width="20" height="16" rx="2" fill="currentColor" fill-opacity=".12"/>';
      out += '<rect x="' + bx + '" y="' + f1(18 - 16 * x[1]) + '" width="20" height="' + f1(16 * x[1]) + '" rx="2" fill="currentColor" fill-opacity=".8"/>';
      out += '<text x="' + (bx + 10) + '" y="13" font-size="7" text-anchor="middle" fill="var(--text,#eee)" fill-opacity=".9">' + x[0] + '</text>';
    });
    return svgWrap('0 0 100 20', 100, 20, out, 'pc-preset-spark');
  }

  function presetPicker() {
    var wrap = el('div', { class: 'pc-presets', role: 'group', 'aria-label': 'Suspension presets' });
    var btns = calc.presets.map(function (p) {
      var b = el('button', { type: 'button', class: 'pc-preset', title: p.desc, 'aria-pressed': 'false' },
        el('span', { class: 'pc-preset-name' }, p.name),
        el('span', { html: presetSpark(p) }),
        el('span', { class: 'pc-preset-desc' }, p.desc));
      b._preset = p;
      b.addEventListener('click', function () {
        var build = cur(), t = suspTypeOf(build), rr = t.rideHeightRange || [50, 300];
        var vals = {}; Object.keys(p.values).forEach(function (k) { vals[k] = p.values[k]; });
        var clamped = vals.rideHeight_mm < rr[0] || vals.rideHeight_mm > rr[1];
        vals.rideHeight_mm = clamp(vals.rideHeight_mm, rr[0], rr[1]);
        patchState({ suspension: vals }, 'Suspension preset: ' + p.name);
        if (clamped) {
          var better = Dt.suspensionTypes.filter(function (s) { return s.rideHeightRange[0] <= p.values.rideHeight_mm && s.rideHeightRange[1] >= p.values.rideHeight_mm; }).map(function (s) { return s.name; });
          toast(p.name + ': ride height limited to ' + vals.rideHeight_mm + ' mm by ' + t.name + (better.length ? '. ' + better.slice(0, 2).join(' or ') + ' can reach ' + p.values.rideHeight_mm + ' mm.' : '.'), 'warning');
        } else toast('Applied the ' + p.name + ' suspension preset', 'success');
      });
      wrap.appendChild(b);
      return b;
    });
    return ui.bind(wrap, 'suspension', function (build) {
      var id = calc.matchPreset(build);
      btns.forEach(function (b) {
        var on = b._preset.id === id;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    });
  }

  /** Front-view camber (both axles) + top-view toe diagram. Built once, mutated in place. */
  function alignmentDiagram() {
    var W = 600, H = 230, ground = 192;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Wheel alignment diagram">';
    svg += '<defs><pattern id="pc-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-opacity=".18" stroke-width="2"/></pattern></defs>';
    function axleView(x0, label, role) {
      var s = '<g data-r="' + role + '-group">';
      s += '<text x="' + (x0 + 95) + '" y="16" text-anchor="middle" class="pc-strong">' + label + '</text>';
      s += '<text x="' + (x0 + 95) + '" y="30" text-anchor="middle">front view · camber ×4</text>';
      s += '<line x1="' + (x0 + 5) + '" y1="' + ground + '" x2="' + (x0 + 185) + '" y2="' + ground + '" stroke="currentColor" stroke-opacity=".5"/>';
      s += '<rect x="' + (x0 + 5) + '" y="' + ground + '" width="180" height="8" fill="url(#pc-hatch)"/>';
      // body
      s += '<rect data-r="' + role + '-body" class="pc-tween" x="' + (x0 + 38) + '" y="100" width="114" height="36" rx="10" fill="currentColor" fill-opacity=".1" stroke="currentColor" stroke-opacity=".45"/>';
      s += '<line data-r="' + role + '-rh" x1="' + (x0 + 95) + '" y1="' + ground + '" x2="' + (x0 + 95) + '" y2="136" stroke="var(--accent,#c8a46a)" stroke-dasharray="3 2"/>';
      s += '<text data-r="' + role + '-rht" x="' + (x0 + 99) + '" y="' + (ground - 6) + '" class="pc-accent">120 mm</text>';
      [[x0 + 40, 'l'], [x0 + 150, 'r']].forEach(function (w) {
        var cx = w[0], tw = 26, th = 84;
        s += '<line x1="' + cx + '" y1="' + (ground - th - 14) + '" x2="' + cx + '" y2="' + ground + '" stroke="currentColor" stroke-opacity=".3" stroke-dasharray="2 3"/>';
        s += '<g data-r="' + role + '-' + w[1] + '" class="pc-anim" style="transform-origin:' + cx + 'px ' + ground + 'px">';
        s += '<rect x="' + (cx - tw / 2) + '" y="' + (ground - th) + '" width="' + tw + '" height="' + th + '" rx="7" fill="currentColor" fill-opacity=".8"/>';
        s += '<rect x="' + (cx - tw / 2 + 5) + '" y="' + (ground - th / 2 - 22) + '" width="' + (tw - 10) + '" height="44" rx="2" fill="var(--bg-2,#0e0e10)" fill-opacity=".85"/>';
        s += '<line x1="' + cx + '" y1="' + (ground - th - 12) + '" x2="' + cx + '" y2="' + ground + '" stroke="var(--accent,#c8a46a)" stroke-width="1.4"/>';
        s += '</g>';
        // upper/lower arms (static anchor on body, end follows the hub roughly)
        s += '<line data-r="' + role + '-' + w[1] + '-arm" x1="' + (cx + (w[1] === 'l' ? 14 : -14)) + '" y1="' + (ground - 42) + '" x2="' + (w[1] === 'l' ? x0 + 60 : x0 + 130) + '" y2="128" stroke="currentColor" stroke-opacity=".5" stroke-width="2"/>';
      });
      s += '<text data-r="' + role + '-cam" x="' + (x0 + 95) + '" y="' + (ground + 26) + '" text-anchor="middle" class="pc-strong">−1.5°</text>';
      s += '</g>';
      return s;
    }
    svg += axleView(0, 'FRONT AXLE', 'fa');
    svg += axleView(200, 'REAR AXLE', 'ra');
    // top view
    var tx = 410;
    svg += '<text x="' + (tx + 95) + '" y="16" text-anchor="middle" class="pc-strong">TOE</text>';
    svg += '<text x="' + (tx + 95) + '" y="30" text-anchor="middle">top view · ×25</text>';
    svg += '<path d="M' + (tx + 60) + ' 52 Q' + (tx + 95) + ' 34 ' + (tx + 130) + ' 52 L' + (tx + 134) + ' 206 Q' + (tx + 95) + ' 214 ' + (tx + 56) + ' 206 Z" fill="currentColor" fill-opacity=".1" stroke="currentColor" stroke-opacity=".45"/>';
    svg += '<path d="M' + (tx + 95) + ' 40 v-6 m-4 5 l4 -5 l4 5" stroke="currentColor" stroke-opacity=".6" fill="none"/>';
    [[72, 'tf'], [180, 'tr']].forEach(function (row) {
      var y = row[0];
      svg += '<line x1="' + (tx + 54) + '" y1="' + y + '" x2="' + (tx + 136) + '" y2="' + y + '" stroke="currentColor" stroke-opacity=".35" stroke-width="2"/>';
      [[tx + 40, 'l'], [tx + 150, 'r']].forEach(function (w) {
        svg += '<line x1="' + w[0] + '" y1="' + (y - 34) + '" x2="' + w[0] + '" y2="' + (y + 34) + '" stroke="currentColor" stroke-opacity=".3" stroke-dasharray="2 3"/>';
        svg += '<g data-r="' + row[1] + '-' + w[1] + '" class="pc-anim" style="transform-origin:' + w[0] + 'px ' + y + 'px">';
        svg += '<rect x="' + (w[0] - 9) + '" y="' + (y - 24) + '" width="18" height="48" rx="5" fill="currentColor" fill-opacity=".8"/>';
        svg += '<line x1="' + w[0] + '" y1="' + (y - 30) + '" x2="' + w[0] + '" y2="' + (y + 30) + '" stroke="var(--accent,#c8a46a)" stroke-width="1.4"/>';
        svg += '</g>';
      });
      svg += '<text data-r="' + row[1] + '-t" x="' + (tx + 95) + '" y="' + (y + 4) + '" text-anchor="middle" class="pc-strong">0.00°</text>';
      svg += '<text data-r="' + row[1] + '-k" x="' + (tx + 95) + '" y="' + (y + 16) + '" text-anchor="middle">neutral</text>';
    });
    svg += '</svg>';
    var d = diagram('Alignment', svg, el('span', { class: 'pc-legend' }, el('span', null, el('i', { style: { background: 'var(--accent,#c8a46a)' } }), 'wheel plane')));
    return ui.bind(d, 'suspension', function (b) {
      var s = b.suspension || {};
      function rot(role, deg) { var n = d.q(role); if (n) n.style.transform = 'rotate(' + deg.toFixed(2) + 'deg)'; }
      var cf = num(s.camberFront_deg, 0), cr = num(s.camberRear_deg, 0), tf = num(s.toeFront_deg, 0), tr = num(s.toeRear_deg, 0);
      rot('fa-l', -cf * 4); rot('fa-r', cf * 4); rot('ra-l', -cr * 4); rot('ra-r', cr * 4);
      rot('tf-l', tf * 25); rot('tf-r', -tf * 25); rot('tr-l', tr * 25); rot('tr-r', -tr * 25);
      d.text('fa-cam', signed(cf, 1) + '°'); d.text('ra-cam', signed(cr, 1) + '°');
      d.text('tf-t', signed(tf, 2) + '°'); d.text('tr-t', signed(tr, 2) + '°');
      function toeWord(t) { return Math.abs(t) < 0.02 ? 'neutral' : t > 0 ? 'toe-in' : 'toe-out'; }
      d.text('tf-k', toeWord(tf)); d.text('tr-k', toeWord(tr));
      d.cls('tr-t', tr < -0.02 ? 'pc-bad' : 'pc-strong');
      var rh = num(s.rideHeight_mm, 120);
      var bodyY = 192 - 56 - clamp(rh, 40, 300) * 0.22;
      ['fa', 'ra'].forEach(function (ax) {
        d.attr(ax + '-body', { y: f1(bodyY) });
        d.attr(ax + '-rh', { y2: f1(bodyY + 36) });
        d.text(ax + '-rht', fmt(rh) + ' mm');
      });
      d.cls('fa-cam', cf < -3.5 || cf > 0.2 ? 'pc-warn' : 'pc-strong');
      d.cls('ra-cam', cr < -3.5 || cr > 0.2 ? 'pc-warn' : 'pc-strong');
    });
  }

  /** Handling balance indicator: oversteer ←→ understeer scale + contributions list. */
  function balanceWidget(P) {
    var needle = el('div', { class: 'pc-balance-needle' });
    var scale = el('div', { class: 'pc-balance-scale', role: 'meter', 'aria-valuemin': '-100', 'aria-valuemax': '100', 'aria-label': 'Handling balance' }, needle);
    var label = el('span', { class: 'pc-balance-label' }, '—');
    var score = el('span', { class: 'pc-readout' });
    var listEl = el('ul', { class: 'pc-contrib' });
    var adv = el('div', { class: 'cb-hint' });
    var box = el('div', { class: 'pc-balance' },
      el('div', { class: 'pc-readout' }, label, score),
      scale,
      el('div', { class: 'pc-balance-ends' }, el('span', null, '◀ Oversteer (loose)'), el('span', null, 'Neutral'), el('span', null, 'Understeer (push) ▶')),
      listEl, adv);
    var lastKey = '';
    P.watch(box, function (b, m) {
      var bal = P.d().balance;
      needle.style.left = (50 + bal.score * 50).toFixed(1) + '%';
      scale.setAttribute('aria-valuenow', String(Math.round(bal.score * 100)));
      scale.setAttribute('aria-valuetext', bal.label);
      label.textContent = bal.label;
      label.className = 'pc-balance-label is-' + bal.kind;
      score.textContent = 'Balance index ' + signed(bal.score * 100, 0);
      var key = JSON.stringify(bal.contributions.map(function (c) { return [c.id, round(c.value, 3)]; }));
      if (key !== lastKey) {
        lastKey = key;
        U.clear(listEl);
        var maxV = 0.35;
        bal.contributions.slice(0, 7).forEach(function (c) {
          var w = clamp(Math.abs(c.value) / maxV, 0, 1) * 50;
          var bar = el('i', { style: { left: c.value < 0 ? (50 - w) + '%' : '50%', width: w + '%', background: c.value < 0 ? 'var(--bad,#e5484d)' : 'var(--accent-2,#4c8dff)' } });
          listEl.appendChild(el('li', { title: c.note || '' }, el('span', null, c.label), el('span', { class: 'pc-cbar' }, bar), el('span', { class: 'pc-cval' }, signed(c.value * 100, 0))));
        });
      }
      var top = bal.contributions[0];
      if (bal.kind === 'good') adv.textContent = 'Well balanced: the car will rotate on entry without snapping on exit. Fine-tune with anti-roll bars.';
      else if (bal.score > 0) adv.textContent = 'To reduce understeer: soften the front anti-roll bar or stiffen the rear, add front negative camber, or move aero balance forward.' + (top ? ' Biggest factor: ' + top.label.toLowerCase() + '.' : '');
      else adv.textContent = 'To calm oversteer: stiffen the front anti-roll bar or soften the rear, add rear toe-in, or run wider rear tyres.' + (top ? ' Biggest factor: ' + top.label.toLowerCase() + '.' : '');
    });
    return box;
  }

  function freqWidget(P, axle) {
    var A = axle === 'rear' ? 'rear' : 'front';
    var big = el('div', { class: 'pc-big' }, '—');
    var mt = meter();
    var info = el('div', { class: 'pc-readout' });
    var w = widget((A === 'front' ? 'Front' : 'Rear') + ' natural frequency', el('div', null, big, mt, info));
    P.watch(w, function () {
      var s = P.d().susp, x = s[A];
      big.innerHTML = fmt(x.freq_hz, 2) + '<small>Hz</small>';
      // 0.8 Hz (limo) … 3.5 Hz (race car)
      var frac = (x.freq_hz - 0.8) / 2.7;
      mt.set(frac, x.freq_hz < 1.1 ? 'warn' : x.freq_hz > 3.2 ? 'bad' : x.freq_hz > 2.4 ? 'warn' : 'good');
      var cls = x.freq_hz < 1.25 ? 'Luxury' : x.freq_hz < 1.6 ? 'Comfort' : x.freq_hz < 2.0 ? 'Sport' : x.freq_hz < 2.6 ? 'Track' : x.freq_hz < 3.2 ? 'Race' : 'Aero race';
      info.innerHTML = '<span>' + cls + '</span><strong>' + fmt(x.wheelRate_nmm, 1) + ' N/mm wheel</strong>';
    });
    return w;
  }

  function buildSuspension(root, P) {
    root.appendChild(ui.issues('suspension'));

    /* ---- live stats */
    var stats = statGrid([
      { key: 'ff', label: 'Front freq.', unit: 'Hz', decimals: 2, title: 'Undamped heave natural frequency, front corner' },
      { key: 'fr', label: 'Rear freq.', unit: 'Hz', decimals: 2 },
      { key: 'tlltd', label: 'Front roll share', unit: '%', decimals: 1, title: 'Total lateral load transfer distribution — front share of roll stiffness' },
      { key: 'roll', label: 'Roll gradient', unit: '°/g', decimals: 2 },
      { key: 'zeta', label: 'Damping ratio ζ', decimals: 2 },
      { key: 'usF', label: 'Unsprung front', unit: 'kg', decimals: 1, title: 'Per corner: wheel, tyre, rotor, caliper and hardware' },
      { key: 'usR', label: 'Unsprung rear', unit: 'kg', decimals: 1 },
      { key: 'comfort', label: 'Ride comfort', unit: '/100', decimals: 0 },
      { key: 'grip', label: 'Mechanical grip', unit: '/100', decimals: 0 },
      { key: 'lat', label: 'Lateral grip', unit: 'g', decimals: 2 }
    ]);
    var estFlag = el('div', { class: 'pc-estimated', hidden: true }, 'Estimated — physics engine not loaded; figures derive from the local chassis model.');
    P.watch(stats, function (b, m) {
      var s = P.d().susp;
      stats.setAll({
        ff: s.front.freq_hz, fr: s.rear.freq_hz, tlltd: s.tlltd_pct, roll: s.rollGradient_degPerG, zeta: s.dampingRatio,
        usF: s.front.unsprung_kg, usR: s.rear.unsprung_kg,
        comfort: m.comfortIndex != null && !m._estimated ? m.comfortIndex : s.comfort, grip: s.grip,
        lat: m.lateralG != null ? m.lateralG : (num(m.gripFront, 1) + num(m.gripRear, 1)) / 2
      });
      estFlag.hidden = !m._estimated;
    });
    root.appendChild(ui.section('Chassis dynamics', 'Live kinematic and ride figures for the current set-up.', stats, estFlag));

    /* ---- type */
    var typeCards = ui.cards({
      path: 'suspension.type', label: 'Suspension architecture', columns: 3,
      hint: 'Architecture sets the kinematic envelope: grip multiplier, ride comfort and the ride-height range available.',
      options: Dt.suspensionTypes.map(function (t) {
        return {
          id: t.id, name: t.name, desc: t.desc, price: t.price, icon: suspensionIcon(t),
          badge: t.adjustable ? 'Adjustable' : null,
          specs: [['Grip', '×' + fmt(t.gripMult, 2)], ['Comfort', '×' + fmt(t.comfortMult, 2)], ['Height', t.rideHeightRange[0] + '–' + t.rideHeightRange[1] + ' mm'], ['Mass', signed(t.weight_kg, 0) + ' kg']]
        };
      })
    });
    var typeNote = note('', 'info'); ui.bind(typeNote, 'suspension.type', function (b) {
      var t = suspTypeOf(b);
      var lines = {
        macpherson: 'Strut geometry gains little camber in roll — compensate with more static negative camber. Not suitable for very low ride heights.',
        'double-wishbone': 'Unequal-length arms give camber gain in bump; the benchmark for road and track.',
        multilink: 'Elastokinematic bushings separate comfort and precision. Great all-rounder.',
        pushrod: 'Rocker-actuated inboard dampers: the lowest unsprung mass and a rising-rate motion ratio. Needs a smooth surface.',
        air: 'Air springs self-level at any load and allow lift/kneel. Spring rate rises with ride height reduction.',
        magnetic: 'Magnetorheological dampers widen the effective damping range — firm when cornering, supple over bumps.',
        'coilover-track': 'Three-way adjustable: high/low-speed bump and rebound. Height adjusts on the threaded body.'
      };
      typeNote.textContent = (lines[t.id] || t.desc) + ' Motion ratio ≈ ' + fmt(calc.motionRatios[t.id] || 0.8, 2) + ' (wheel rate = spring × MR²).';
    });
    root.appendChild(ui.section('Architecture', null, typeCards, typeNote));

    /* ---- presets */
    root.appendChild(ui.section('Set-up presets', 'One click to a coherent baseline — then fine-tune below. K stiffness · C camber · L lowness · D damping.', presetPicker()));

    /* ---- springs & damping */
    var sfR = R('suspension.springFront_nmm'), srR = R('suspension.springRear_nmm');
    var springTicks = [{ value: 20, label: '20' }, { value: 60, label: 'Road' }, { value: 120, label: 'Track' }, { value: 200, label: 'Race' }, { value: 250, label: '250' }];
    var springF = ui.slider({ path: 'suspension.springFront_nmm', label: 'Front spring rate', min: sfR.min, max: sfR.max, step: sfR.step, unit: 'N/mm', ticks: springTicks, hint: 'Coil rate at the spring. Stiffer = less roll and pitch, harsher ride.' });
    var springR = ui.slider({ path: 'suspension.springRear_nmm', label: 'Rear spring rate', min: srR.min, max: srR.max, step: srR.step, unit: 'N/mm', ticks: springTicks, hint: 'Rear frequency ~10–20% above the front cancels pitch over bumps ("flat ride").' });
    var dR = R('suspension.damping');
    var damping = ui.slider({
      path: 'suspension.damping', label: 'Damping', min: dR.min, max: dR.max, step: 1,
      format: function (v) { return v + ' / 10 · ζ ' + fmt(0.12 + (v - 1) * 0.07, 2); },
      ticks: [{ value: 1, label: 'Soft' }, { value: 4, label: 'Road' }, { value: 7, label: 'Sport' }, { value: 10, label: 'Race' }],
      hint: 'Damper stiffness (bump + rebound). ζ ≈ 0.3 rides best; ζ ≈ 0.6–0.7 controls body motion on track.'
    });
    var rhR = R('suspension.rideHeight_mm');
    var rideHeight = ui.slider({
      path: 'suspension.rideHeight_mm', label: 'Ride height', min: rhR.min, max: rhR.max, step: 1, unit: 'mm',
      range: function (b) { var t = suspTypeOf(b); return t.rideHeightRange || [rhR.min, rhR.max]; },
      hint: 'Static ground clearance at the sill. Lower drops the centre of gravity and boosts underbody aero; the range depends on the architecture.'
    });
    var flatRide = note('', 'info');
    P.watch(flatRide, function () {
      var s = P.d().susp;
      var split = s.freqSplit_pct;
      var msg = split >= 5 && split <= 25 ? 'Flat ride: rear frequency is ' + fmt(split, 0) + '% above the front — the body stays level over bumps.' :
        split < 5 ? 'Rear frequency only ' + signed(split, 0) + '% vs the front — expect pitching over undulations; stiffen the rear springs a touch.' :
        'Rear frequency is ' + fmt(split, 0) + '% above the front — the rear will feel skittish over bumps.';
      flatRide.textContent = msg;
      flatRide.className = 'pc-note is-' + (split >= 5 && split <= 25 ? 'good' : 'warning');
    });
    var bottomNote = note('', 'info');
    P.watch(bottomNote, function () {
      var s = P.d().susp;
      bottomNote.hidden = s.bottoming === 'low';
      bottomNote.className = 'pc-note is-' + (s.bottoming === 'high' ? 'error' : 'warning');
      bottomNote.textContent = (s.bottoming === 'high' ? 'Bottoming likely: ' : 'Limited travel: ') + 'a sharp half-g bump compresses the softer axle ≈' + fmt(s.travelToBump_mm) +
        ' mm, leaving ' + fmt(Math.max(0, s.clearance_mm)) + ' mm of clearance. Raise the car or stiffen the springs.';
    });
    root.appendChild(ui.section('Springs, damping & ride height', null,
      el('div', { class: 'pc-two' }, freqWidget(P, 'front'), freqWidget(P, 'rear')),
      ui.grid(2, springF, springR), ui.grid(2, damping, rideHeight), flatRide, bottomNote));

    /* ---- alignment */
    var cR = R('suspension.camberFront_deg'), tR = R('suspension.toeFront_deg');
    var camberTicks = [{ value: -5, label: '−5°' }, { value: -3, label: 'Track' }, { value: -1.5, label: 'Road' }, { value: 0, label: '0' }, { value: 1, label: '+1°' }];
    var toeTicks = [{ value: -0.5, label: 'Out' }, { value: 0, label: '0' }, { value: 0.5, label: 'In' }];
    var align = ui.grid(2,
      ui.slider({ path: 'suspension.camberFront_deg', label: 'Front camber', min: cR.min, max: cR.max, step: 0.1, unit: '°', ticks: camberTicks, format: function (v) { return signed(v, 1) + '°'; }, hint: 'Negative camber tilts the top of the tyre inward — flatter contact patch in a corner.' }),
      ui.slider({ path: 'suspension.camberRear_deg', label: 'Rear camber', min: cR.min, max: cR.max, step: 0.1, unit: '°', ticks: camberTicks, format: function (v) { return signed(v, 1) + '°'; }, hint: 'Rear camber trades straight-line traction for cornering grip.' }),
      ui.slider({ path: 'suspension.toeFront_deg', label: 'Front toe', min: tR.min, max: tR.max, step: 0.05, unit: '°', ticks: toeTicks, format: function (v) { return signed(v, 2) + '° ' + (Math.abs(v) < 0.02 ? '' : v > 0 ? 'in' : 'out'); }, hint: 'Toe-out sharpens turn-in; toe-in adds straight-line stability.' }),
      ui.slider({ path: 'suspension.toeRear_deg', label: 'Rear toe', min: tR.min, max: tR.max, step: 0.05, unit: '°', ticks: toeTicks, format: function (v) { return signed(v, 2) + '° ' + (Math.abs(v) < 0.02 ? '' : v > 0 ? 'in' : 'out'); }, hint: 'Rear toe-in is a stability aid; rear toe-out makes the car very nervous.' }));
    var effects = bars([
      { key: 'turn', label: 'Turn-in', title: 'Initial steering response' },
      { key: 'stab', label: 'Stability', title: 'High-speed straight-line and braking stability' },
      { key: 'lat', label: 'Corner grip', title: 'Camber contribution to lateral grip' },
      { key: 'str', label: 'Traction', title: 'Straight-line braking / traction contact patch' },
      { key: 'wear', label: 'Tyre wear', title: 'Inner-edge and scrub wear from alignment' }
    ]);
    P.watch(effects, function () {
      var s = P.d().susp;
      effects.set('turn', s.turnIn, fmt(s.turnIn * 100) + '%', s.turnIn > 0.8 ? 'warn' : 'good');
      effects.set('stab', s.stability, fmt(s.stability * 100) + '%', s.stability < 0.3 ? 'bad' : s.stability < 0.45 ? 'warn' : 'good');
      effects.set('lat', (s.latGrip - 0.85) / 0.15, signed((s.latGrip - 1) * 100, 1) + '%', s.latGrip > 0.97 ? 'good' : 'warn');
      effects.set('str', (s.straightGrip - 0.9) / 0.1, signed((s.straightGrip - 1) * 100, 1) + '%', s.straightGrip > 0.97 ? 'good' : 'warn');
      effects.set('wear', s.tireWear, s.tireWear < 0.25 ? 'Low' : s.tireWear < 0.55 ? 'Medium' : 'High', s.tireWear < 0.25 ? 'good' : s.tireWear < 0.55 ? 'warn' : 'bad');
    });
    var alignBtns = el('div', { class: 'pc-btnrow' },
      ui.button('Factory alignment', { kind: 'ghost', onClick: function () {
        var d0 = defaults().suspension || {};
        patchState({ suspension: { camberFront_deg: d0.camberFront_deg, camberRear_deg: d0.camberRear_deg, toeFront_deg: d0.toeFront_deg, toeRear_deg: d0.toeRear_deg } }, 'Alignment → factory');
      } }),
      ui.button('Zero toe', { kind: 'ghost', onClick: function () { patchState({ suspension: { toeFront_deg: 0, toeRear_deg: 0 } }, 'Alignment → zero toe'); } }),
      ui.button('Track alignment', { kind: 'ghost', onClick: function () { patchState({ suspension: { camberFront_deg: -3.0, camberRear_deg: -2.0, toeFront_deg: -0.05, toeRear_deg: 0.15 } }, 'Alignment → track'); } }));
    root.appendChild(ui.section('Wheel alignment', 'Diagram angles are exaggerated so small changes are visible.', alignmentDiagram(), align, el('div', { class: 'pc-two' }, widget('Alignment effects', effects), widget('Quick alignments', el('div', { class: 'pc-stack' }, alignBtns, hint('Factory resets camber and toe only; springs and bars are untouched.'))))));

    /* ---- anti-roll bars */
    var aR = R('suspension.arbFront');
    var arbTicks = [{ value: 1, label: 'Soft' }, { value: 5, label: '5' }, { value: 10, label: 'Stiff' }];
    var arbF = ui.slider({ path: 'suspension.arbFront', label: 'Front anti-roll bar', min: aR.min, max: aR.max, step: 1, ticks: arbTicks, format: function (v) { return 'Step ' + v + ' · ' + fmt(v * 230) + ' Nm/°'; }, hint: 'Stiffer front bar → more understeer, sharper response.' });
    var arbR = ui.slider({ path: 'suspension.arbRear', label: 'Rear anti-roll bar', min: aR.min, max: aR.max, step: 1, ticks: arbTicks, format: function (v) { return 'Step ' + v + ' · ' + fmt(v * 207) + ' Nm/°'; }, hint: 'Stiffer rear bar → more rotation / oversteer.' });
    var rollMeter = meter();
    var rollRead = el('div', { class: 'pc-readout' });
    var rollBox = widget('Roll stiffness distribution', el('div', null, rollRead, rollMeter, hint('Marker shows the static front weight share; a front roll share a few % above it is the classic safe, neutral road-car balance.')));
    P.watch(rollBox, function () {
      var s = P.d().susp;
      var diff = s.tlltd_pct - s.weightFront_pct;
      rollMeter.set(s.tlltd_pct / 100, Math.abs(diff - 4) < 6 ? 'good' : Math.abs(diff - 4) < 12 ? 'warn' : 'bad', s.weightFront_pct / 100);
      rollRead.innerHTML = '<span>Front <strong>' + fmt(s.tlltd_pct, 1) + '%</strong> · Rear <strong>' + fmt(100 - s.tlltd_pct, 1) + '%</strong></span><span>Total <strong>' + fmt(s.rollStiffness) + ' Nm/°</strong></span>';
    });
    root.appendChild(ui.section('Anti-roll bars', null, ui.grid(2, arbF, arbR), rollBox));

    /* ---- balance */
    root.appendChild(ui.section('Handling balance', 'Steady-state balance from roll distribution, alignment, tyres, drivetrain and aero.', balanceWidget(P)));

    /* ---- kinematics table */
    var kin = table(['Per corner', 'Front', 'Rear']);
    P.watch(kin, function () {
      var s = P.d().susp, F = s.front, Rr = s.rear;
      kin.set([
        { cells: ['Spring rate', fmt(F.spring_nmm) + ' N/mm', fmt(Rr.spring_nmm) + ' N/mm'] },
        { cells: ['Motion ratio', fmt(F.motionRatio, 2), fmt(Rr.motionRatio, 2)] },
        { cells: ['Wheel rate', fmt(F.wheelRate_nmm, 1) + ' N/mm', fmt(Rr.wheelRate_nmm, 1) + ' N/mm'] },
        { cells: ['Tyre vertical rate', fmt(F.tireRate_nmm) + ' N/mm', fmt(Rr.tireRate_nmm) + ' N/mm'] },
        { cells: ['Ride rate', fmt(F.rideRate_nmm, 1) + ' N/mm', fmt(Rr.rideRate_nmm, 1) + ' N/mm'] },
        { cells: ['Sprung mass', fmt(F.sprungCorner_kg) + ' kg', fmt(Rr.sprungCorner_kg) + ' kg'] },
        { cells: ['Unsprung mass', fmt(F.unsprung_kg, 1) + ' kg', fmt(Rr.unsprung_kg, 1) + ' kg'] },
        { cells: ['Natural frequency', fmt(F.freq_hz, 2) + ' Hz', fmt(Rr.freq_hz, 2) + ' Hz'] },
        { cells: ['Roll stiffness (springs)', fmt(F.kSpring) + ' Nm/°', fmt(Rr.kSpring) + ' Nm/°'] },
        { cells: ['Roll stiffness (bar)', fmt(F.kArb) + ' Nm/°', fmt(Rr.kArb) + ' Nm/°'] }
      ]);
    });
    root.appendChild(ui.section('Kinematics sheet', 'Engineering data per corner (both sides identical).', kin));
  }

  /* ======================================================================
     PANEL: BRAKES
     ====================================================================== */
  function brakeMatOf(b) { return find('brakeMaterials', get(b, 'brakes.material')) || Dt.brakeMaterials[0]; }

  function brakeCompat(o, b) {
    var d = num(get(b, 'wheels.diameter_in'), 19);
    if (o.minWheel_in && d < o.minWheel_in) return o.name + ' needs at least ' + o.minWheel_in + '" wheels (currently ' + d + '")';
    if (CB.rules && typeof CB.rules.compatibleOptions === 'function') {
      try {
        var r = CB.rules.compatibleOptions(b, 'brakes.material');
        if (r && typeof r === 'object' && !Array.isArray(r) && r[o.id] != null && r[o.id] !== true) return typeof r[o.id] === 'string' ? r[o.id] : (r[o.id].reason || 'Not compatible with the current build');
      } catch (e) { /* ignore */ }
    }
    return false;
  }

  /** Arc band path between radii r0 < r1 from angle a0 to a1 (radians). */
  function arcBand(cx, cy, r0, r1, a0, a1) {
    var large = a1 - a0 > Math.PI ? 1 : 0;
    function p(r, a) { return f1(cx + Math.cos(a) * r) + ' ' + f1(cy + Math.sin(a) * r); }
    return 'M' + p(r1, a0) + ' A' + f1(r1) + ' ' + f1(r1) + ' 0 ' + large + ' 1 ' + p(r1, a1) + ' L' + p(r0, a1) + ' A' + f1(r0) + ' ' + f1(r0) + ' 0 ' + large + ' 0 ' + p(r0, a0) + ' Z';
  }

  /** Rotor-in-wheel fit visual for both axles. */
  function brakeFitDiagram() {
    var W = 640, H = 330, k = 150 / 292;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Rotor and caliper fit inside the wheel">';
    [[160, 'f', 'FRONT'], [480, 'r', 'REAR']].forEach(function (ax) {
      var cx = ax[0], cy = 160, a = ax[1];
      svg += '<text x="' + cx + '" y="14" text-anchor="middle" class="pc-strong">' + ax[2] + '</text>';
      svg += '<circle data-r="' + a + '-tyre" class="pc-tween" cx="' + cx + '" cy="' + cy + '" r="150" fill="currentColor" fill-opacity=".1" stroke="currentColor" stroke-opacity=".25"/>';
      svg += '<circle data-r="' + a + '-wheel" class="pc-tween" cx="' + cx + '" cy="' + cy + '" r="125" fill="var(--bg-2,#0e0e10)" stroke="currentColor" stroke-width="5" stroke-opacity=".8"/>';
      svg += '<circle data-r="' + a + '-barrel" class="pc-tween" cx="' + cx + '" cy="' + cy + '" r="118" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="4 3"/>';
      svg += '<circle data-r="' + a + '-env" class="pc-tween" cx="' + cx + '" cy="' + cy + '" r="100" fill="none" stroke="var(--good,#3fb950)" stroke-width="1.5" stroke-dasharray="6 4"/>';
      svg += '<g data-r="' + a + '-rotorg"></g>';
      svg += '<path data-r="' + a + '-cal" d="" fill="#f2c200" stroke="rgba(0,0,0,.35)"/>';
      svg += '<g data-r="' + a + '-pist"></g>';
      svg += '<circle cx="' + cx + '" cy="' + cy + '" r="18" fill="currentColor" fill-opacity=".5"/>';
      svg += '<text data-r="' + a + '-t1" x="' + cx + '" y="' + (H - 18) + '" text-anchor="middle" class="pc-strong">—</text>';
      svg += '<text data-r="' + a + '-t2" x="' + cx + '" y="' + (H - 4) + '" text-anchor="middle">—</text>';
    });
    svg += '</svg>';
    var d = diagram('Rotor-in-wheel fit', svg, el('span', { class: 'pc-legend' },
      el('span', null, el('i', { style: { background: 'var(--good,#3fb950)' } }), 'caliper envelope (rotor + 60 mm)'),
      el('span', null, el('i', { style: { background: 'currentColor', opacity: '.35' } }), 'inner barrel')));
    var lastKey = {};
    return ui.bind(d, 'brakes', function (b) {
      var bd = calc.brakes(b, null), mat = brakeMatOf(b);
      var wheel_mm = num(get(b, 'wheels.diameter_in'), 19) * 25.4;
      var caliperCol = U.isHex && U.isHex(get(b, 'exterior.caliperColor')) ? get(b, 'exterior.caliperColor') : '#f2c200';
      [['f', bd.front, 'front'], ['r', bd.rear, 'rear']].forEach(function (x) {
        var a = x[0], A = x[1], cx = a === 'f' ? 160 : 480, cy = 160;
        var tg = calc.tireGeom(b, x[2]);
        d.attr(a + '-tyre', { r: f1(tg.diameter_mm / 2 * k) });
        d.attr(a + '-wheel', { r: f1(wheel_mm / 2 * k) });
        d.attr(a + '-barrel', { r: f1((wheel_mm / 2 - 12) * k) });
        d.attr(a + '-env', { r: f1(A.requiredWheel_mm / 2 * k), stroke: A.fits ? 'var(--good,#3fb950)' : 'var(--bad,#e5484d)' });
        var rr = A.rotor_mm / 2 * k;
        var key = [A.rotor_mm, mat.id, A.pistons, caliperCol, wheel_mm].join('|');
        if (lastKey[a] !== key) {
          lastKey[a] = key;
          var g = d.q(a + '-rotorg');
          if (g) g.innerHTML = rotorArt(cx, cy, rr, mat, { caliper: false });
          var a0 = -Math.PI * 0.5 - 0.5 - A.pistons * 0.02, a1 = -Math.PI * 0.5 + 0.5 + A.pistons * 0.02;
          var ro = rr + 14 * k, ri = Math.max(24, rr - 46 * k);
          d.attr(a + '-cal', { d: arcBand(cx, cy, ri, ro, a0, a1), fill: caliperCol });
          var pg = d.q(a + '-pist'), per = Math.max(1, Math.ceil(A.pistons / 2)), s = '';
          for (var i = 0; i < per; i++) {
            var t = per === 1 ? 0.5 : i / (per - 1), ang = a0 + 0.12 + (a1 - a0 - 0.24) * t;
            var pr = (ri + ro) / 2;
            s += '<circle cx="' + f1(cx + Math.cos(ang) * pr) + '" cy="' + f1(cy + Math.sin(ang) * pr) + '" r="' + f1(Math.max(2.5, (PISTON_DIA[A.pistons] || 34) * k * 0.28)) + '" fill="rgba(0,0,0,.35)" stroke="rgba(255,255,255,.35)"/>';
          }
          if (pg) pg.innerHTML = s;
        }
        d.text(a + '-t1', fmt(wheel_mm / 25.4) + '" wheel · ' + A.rotor_mm + ' mm rotor · ' + A.pistons + '-pot');
        d.text(a + '-t2', A.fits ? 'clearance +' + fmt(A.clearance_mm) + ' mm' : 'interference ' + fmt(-A.clearance_mm) + ' mm — needs ' + A.minWheel_in + '" wheel');
        d.cls(a + '-t2', A.fits ? (A.clearance_mm < 12 ? 'pc-warn' : 'pc-ok') : 'pc-bad');
      });
    });
  }

  function biasWidget(P) {
    var mt = meter(), read = el('div', { class: 'pc-readout' }), adv = el('div', { class: 'cb-hint' });
    var w = widget('Brake bias', el('div', null, read, mt, adv));
    P.watch(w, function () {
      var bd = P.d().brakes, dlt = bd.biasDelta;
      mt.set((bd.bias_front_pct - 40) / 45, Math.abs(dlt) < 4 ? 'good' : Math.abs(dlt) < 9 ? 'warn' : 'bad', (bd.idealBias_front_pct - 40) / 45);
      read.innerHTML = '<span>Hydraulic <strong>' + fmt(bd.bias_front_pct, 1) + '% F</strong></span><span>Ideal @ ' + fmt(bd.decelG, 2) + ' g <strong>' + fmt(bd.idealBias_front_pct, 1) + '% F</strong></span>';
      adv.textContent = Math.abs(dlt) < 4 ? 'Bias is matched to the dynamic weight transfer — all four tyres reach the limit together.' :
        dlt > 0 ? 'Front-biased by ' + fmt(dlt, 1) + '%: stable but the fronts lock first. Larger rear rotors or more rear pistons rebalance it.' :
          'Rear-biased by ' + fmt(-dlt, 1) + '%: the rear can lock and step out under braking. Upsize the front package.';
    });
    return w;
  }

  function thermalWidget(P) {
    var bs = bars([
      { key: 'cap', label: 'Heat soak', title: 'Total rotor heat capacity before fade threshold' },
      { key: 'stops', label: '200→0 stops', title: 'Consecutive hard stops from 200 km/h before fade' },
      { key: 'fade', label: 'Fade risk' },
      { key: 'feel', label: 'Pedal feel' }
    ]);
    var w = widget('Thermal & feel', bs);
    P.watch(w, function () {
      var bd = P.d().brakes;
      bs.set('cap', bd.capacity_kj / 9000, fmt(bd.capacity_kj / 1000, 1) + ' MJ', bd.capacity_kj > 4500 ? 'good' : 'warn');
      bs.set('stops', bd.hotStops200 / 4, fmt(bd.hotStops200, 1) + '×', bd.hotStops200 >= 2 ? 'good' : bd.hotStops200 >= 1.2 ? 'warn' : 'bad');
      bs.set('fade', bd.fadeRisk, bd.fadeRisk < 0.3 ? 'Low' : bd.fadeRisk < 0.6 ? 'Medium' : 'High', bd.fadeRisk < 0.3 ? 'good' : bd.fadeRisk < 0.6 ? 'warn' : 'bad');
      bs.set('feel', bd.pedalFeel, fmt(bd.pedalFeel * 100) + '%', 'good');
    });
    return w;
  }

  function buildBrakes(root, P) {
    root.appendChild(ui.issues('brakes'));

    var stats = statGrid([
      { key: 'd100', label: '100–0 km/h', unit: 'm', decimals: 1 },
      { key: 'd60', label: '60–0 mph', unit: 'ft', decimals: 0 },
      { key: 'g', label: 'Peak decel.', unit: 'g', decimals: 2 },
      { key: 'bias', label: 'Front bias', unit: '%', decimals: 1 },
      { key: 'tq', label: 'Front torque', unit: 'Nm', decimals: 0, title: 'Per wheel at 100 bar line pressure' },
      { key: 'cap', label: 'Heat capacity', unit: 'MJ', decimals: 2 },
      { key: 'us', label: 'Brake mass', unit: 'kg', decimals: 1, title: 'Rotors + calipers, all four corners (unsprung)' },
      { key: 'cost', label: 'Package', unit: '', decimals: 0 }
    ]);
    var estFlag = el('div', { class: 'pc-estimated', hidden: true }, 'Stopping distances estimated locally — physics engine not loaded.');
    P.watch(stats, function (b, m) {
      var bd = P.d().brakes;
      var cost = sectionCost(b, ['brakes'], function (bb) {
        var br = bb.brakes || {};
        return fp('brakeMaterials', br.material) + fp('absModes', br.abs) + (num(br.frontRotor_mm, 360) - 360 + num(br.rearRotor_mm, 330) - 330) * calc_opt('perRotorMm', 18) * 2 +
          ((num(br.frontPistons, 6) - 6) + (num(br.rearPistons, 4) - 4)) * calc_opt('perPiston', 220) * 2;
      });
      stats.setAll({
        d100: m.brakingDist_100_0_m != null ? m.brakingDist_100_0_m : bd.dist_100_0_m,
        d60: m.brakingDist_60_0_ft != null ? m.brakingDist_60_0_ft : bd.dist_60_0_ft,
        g: bd.decelG, bias: bd.bias_front_pct, tq: bd.front.torque_nm, cap: bd.capacity_kj / 1000, us: bd.unsprungBrake_kg,
        cost: { value: money(cost.amount) + (cost.estimated ? '*' : ''), unit: '' }
      });
      estFlag.hidden = !m._estimated;
    });
    root.appendChild(ui.section('Stopping power', 'Torque figures assume 100 bar line pressure and a 0.42 µ pad.', stats, estFlag));

    var matCards = ui.cards({
      path: 'brakes.material', label: 'Rotor material', columns: 2,
      optionDisabled: brakeCompat,
      hint: 'Material governs fade resistance, bite and unsprung mass. Carbon-ceramic rotors need a large wheel to clear the calipers.',
      options: Dt.brakeMaterials.map(function (m) {
        return {
          id: m.id, name: m.name, desc: m.desc, price: m.price, icon: brakeIcon(m),
          badge: m.id === 'carbon-ceramic' ? 'Motorsport' : null,
          specs: [['Fade resist.', fmt(m.fadeResistance * 100) + '%'], ['Friction', '×' + fmt(m.frictionMult, 2)], ['Rotor', fmt(m.weightPerRotor_kg, 1) + ' kg'], ['Min wheel', m.minWheel_in + '"']]
        };
      })
    });
    root.appendChild(ui.section('Rotors', null, matCards));

    var rR = R('brakes.frontRotor_mm');
    function rotorFmt(v) { return v + ' mm · ' + fmt(v / 25.4, 1) + '"'; }
    var rotorTicks = [{ value: 280, label: '280' }, { value: 330, label: '330' }, { value: 380, label: '380' }, { value: 440, label: '440' }];
    var fRotor = ui.slider({ path: 'brakes.frontRotor_mm', label: 'Front rotor diameter', min: rR.min, max: rR.max, step: rR.step, unit: 'mm', format: rotorFmt, ticks: rotorTicks, hint: 'Bigger rotors add leverage (torque) and thermal mass.' });
    var rRotor = ui.slider({ path: 'brakes.rearRotor_mm', label: 'Rear rotor diameter', min: rR.min, max: rR.max, step: rR.step, unit: 'mm', format: rotorFmt, ticks: rotorTicks, hint: 'Rear rotors are usually 20–40 mm smaller than the fronts.' });
    var pistonOpts = (Dt.pistonOptions || [1, 2, 4, 6, 8, 10]).map(function (n) { return { id: n, name: n + '-pot', desc: n <= 2 ? 'Sliding (floating) caliper' : 'Fixed opposed-piston monoblock caliper' }; });
    var fPist = ui.segmented({ path: 'brakes.frontPistons', label: 'Front caliper pistons', options: pistonOpts, hint: 'More, smaller pistons spread pad pressure evenly and improve feel.' });
    var rPist = ui.segmented({ path: 'brakes.rearPistons', label: 'Rear caliper pistons', options: pistonOpts });
    var sizeBtns = el('div', { class: 'pc-btnrow' },
      ui.button('Max rotors for this wheel', { kind: 'ghost', onClick: function () {
        var b = cur(), wheel = num(get(b, 'wheels.diameter_in'), 19) * 25.4;
        var maxR = Math.min(rR.max, Math.floor((wheel - 60) / rR.step) * rR.step);
        patchState({ brakes: { frontRotor_mm: maxR, rearRotor_mm: Math.max(rR.min, maxR - 30) } }, 'Rotors sized to wheel');
        toast('Front ' + maxR + ' mm / rear ' + Math.max(rR.min, maxR - 30) + ' mm — the largest that clear a ' + fmt(wheel / 25.4) + '" wheel', 'success');
      } }),
      ui.button('Balance bias', { kind: 'ghost', onClick: function () {
        var b = cur(), best = null;
        (Dt.pistonOptions || [1, 2, 4, 6, 8, 10]).forEach(function (rp) {
          for (var rr = rR.min; rr <= num(get(b, 'brakes.frontRotor_mm'), 360); rr += 10) {
            var tb = U.deepClone(b); tb.brakes.rearPistons = rp; tb.brakes.rearRotor_mm = rr;
            var bd = calc.brakes(tb, P.metrics), err = Math.abs(bd.biasDelta) + Math.abs(rr - (num(get(b, 'brakes.frontRotor_mm'), 360) - 30)) * 0.02;
            if (!best || err < best.err) best = { err: err, rp: rp, rr: rr };
          }
        });
        if (best) { patchState({ brakes: { rearPistons: best.rp, rearRotor_mm: best.rr } }, 'Brake bias balanced'); toast('Rear package set to ' + best.rr + ' mm / ' + best.rp + '-pot for an ideal bias', 'success'); }
      } }));
    root.appendChild(ui.section('Rotor size & calipers', null, brakeFitDiagram(), ui.grid(2, fRotor, rRotor), ui.grid(2, fPist, rPist), sizeBtns,
      el('div', { class: 'pc-two' }, biasWidget(P), thermalWidget(P))));

    var absCards = ui.cards({
      path: 'brakes.abs', label: 'Anti-lock calibration', columns: 4, compact: true,
      options: (Dt.absModes || []).map(function (a) { return { id: a.id, name: a.name, desc: a.desc, price: a.price, badge: a.id === 'off' ? 'Not road legal' : a.id === 'race' ? '12 maps' : null }; })
    });
    var absNote = note('', 'info'); ui.bind(absNote, 'brakes.abs', function (b) {
      var eff = calc.brakes(b, null).absEff;
      var a = get(b, 'brakes.abs');
      absNote.textContent = 'Achieves ≈' + fmt(eff * 100) + '% of the theoretical tyre limit. ' +
        (a === 'off' ? 'Without ABS a locked wheel loses steering — threshold braking is entirely down to the driver.' : a === 'race' ? 'Race calibration lets the tyre run close to peak slip, ideal for trail-braking.' : a === 'sport' ? 'Sport calibration permits more slip and yaw on corner entry.' : 'Standard calibration intervenes early for maximum stability in the wet.');
      absNote.className = 'pc-note cb-bound is-' + (a === 'off' ? 'warning' : 'info');
    });
    root.appendChild(ui.section('ABS', null, absCards, absNote));

    var tbl = table(['Per corner', 'Front', 'Rear']);
    P.watch(tbl, function () {
      var bd = P.d().brakes, F = bd.front, Rr = bd.rear;
      tbl.set([
        { cells: ['Rotor diameter', F.rotor_mm + ' mm', Rr.rotor_mm + ' mm'] },
        { cells: ['Effective radius', fmt(F.effRadius_m * 1000) + ' mm', fmt(Rr.effRadius_m * 1000) + ' mm'] },
        { cells: ['Pistons', F.pistons + ' × Ø' + (PISTON_DIA[F.pistons] || '—') + ' mm', Rr.pistons + ' × Ø' + (PISTON_DIA[Rr.pistons] || '—') + ' mm'] },
        { cells: ['Piston area', fmt(calc.pistonArea_m2(F.pistons) * 1e4, 1) + ' cm²', fmt(calc.pistonArea_m2(Rr.pistons) * 1e4, 1) + ' cm²'] },
        { cells: ['Torque @ 100 bar', fmt(F.torque_nm) + ' Nm', fmt(Rr.torque_nm) + ' Nm'] },
        { cells: ['Rotor mass', fmt(F.rotorMass_kg, 1) + ' kg', fmt(Rr.rotorMass_kg, 1) + ' kg'] },
        { cells: ['Caliper mass', fmt(F.caliperMass_kg, 1) + ' kg', fmt(Rr.caliperMass_kg, 1) + ' kg'] },
        { cells: ['Heat capacity', fmt(F.capacity_kj) + ' kJ', fmt(Rr.capacity_kj) + ' kJ'] },
        { cells: ['Min. wheel to clear', F.minWheel_in + '"', Rr.minWheel_in + '"'], cellCls: [null, F.fits ? 'is-good' : 'is-bad', Rr.fits ? 'is-good' : 'is-bad'] }
      ]);
    });
    root.appendChild(ui.section('Brake data sheet', null, tbl));
  }
  function calc_opt(key, fb) { return optPrice(key, fb); }

  /* ======================================================================
     PANEL: WHEELS & TYRES
     ====================================================================== */
  var WHEEL_SWATCHES = [
    { name: 'Gloss Black', hex: '#111111' }, { name: 'Satin Graphite', hex: '#2b2b2b' }, { name: 'Gunmetal', hex: '#4a4d52' },
    { name: 'Hyper Silver', hex: '#b9bcc2' }, { name: 'Brushed Titanium', hex: '#8a8780' }, { name: 'Polished Chrome', hex: '#e6e8eb' },
    { name: 'Satin Bronze', hex: '#8c6a3f' }, { name: 'Gold Leaf', hex: '#c9a54a' }, { name: 'Gloss White', hex: '#f2f2f0' },
    { name: 'Rosso Corsa', hex: '#b3121f' }, { name: 'Racing Blue', hex: '#1f4fa8' }, { name: 'Copper', hex: '#a2562e' }
  ];

  function wheelDesignOf(b) { return find('wheelDesigns', get(b, 'wheels.design')) || Dt.wheelDesigns[0]; }

  /** Large wheel + tyre preview with sidewall lettering, rotor & caliper. Rebuilt only when its inputs change. */
  function wheelPreview() {
    var host = el('div', { class: 'pc-diagram pc-wheel-preview' });
    var pathId = U.uid ? U.uid('pcsw') : 'pcsw' + Math.round(Math.random() * 1e6);
    var lastKey = null;
    return ui.bind(host, 'wheels', function (b) {
      var des = wheelDesignOf(b), tg = calc.tireGeom(b, 'front');
      var finish = U.isHex && U.isHex(get(b, 'wheels.finish')) ? get(b, 'wheels.finish') : '#2b2b2b';
      var cal = U.isHex && U.isHex(get(b, 'exterior.caliperColor')) ? get(b, 'exterior.caliperColor') : '#f2c200';
      var key = [des.id, finish, tg.rim_in, tg.profile, tg.width_mm, get(b, 'brakes.frontRotor_mm'), get(b, 'brakes.material'), cal, get(b, 'wheels.material'), tg.compound].join('|');
      if (key === lastKey) return;
      lastKey = key;
      var k = 128 / 540, cx = 150, cy = 150;
      var Rt = tg.diameter_mm / 2 * k, Rw = tg.rim_in * 25.4 / 2 * k;
      var mat = find('brakeMaterials', get(b, 'brakes.material'));
      var rotorR = Math.min(Rw * 0.92, num(get(b, 'brakes.frontRotor_mm'), 360) / 2 * k);
      var lum = U.luminance ? U.luminance(finish) : 0.2;
      var lip = U.shade ? U.shade(finish, lum > 0.5 ? -18 : 22) : finish;
      var out = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" role="img" aria-label="' + esc(des.name + ' wheel with ' + tg.size + ' tyre') + '">';
      out += '<defs><radialGradient id="' + pathId + 'g" cx="40%" cy="35%" r="75%"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></radialGradient>';
      out += '<path id="' + pathId + '" d="M' + f1(cx - (Rt + Rw) / 2) + ' ' + cy + ' A' + f1((Rt + Rw) / 2) + ' ' + f1((Rt + Rw) / 2) + ' 0 0 1 ' + f1(cx + (Rt + Rw) / 2) + ' ' + cy + '"/></defs>';
      out += '<ellipse cx="' + cx + '" cy="' + f1(cy + Rt + 6) + '" rx="' + f1(Rt * 0.9) + '" ry="6" fill="#000" fill-opacity=".35"/>';
      out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + f1(Rt) + '" fill="#141416"/>';
      // tread blocks peeking at the edge
      var blocks = tg.compound === 'slick' ? 0 : 48;
      for (var i = 0; i < blocks; i++) {
        var a = i / blocks * Math.PI * 2;
        out += '<line x1="' + f1(cx + Math.cos(a) * (Rt - 1.5)) + '" y1="' + f1(cy + Math.sin(a) * (Rt - 1.5)) + '" x2="' + f1(cx + Math.cos(a) * (Rt - 5)) + '" y2="' + f1(cy + Math.sin(a) * (Rt - 5)) + '" stroke="#000" stroke-opacity=".6" stroke-width="2"/>';
      }
      out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + f1(Rt - 6) + '" fill="none" stroke="#2a2a2e" stroke-width="1"/>';
      out += '<text font-size="' + f1(clamp((Rt - Rw) * 0.32, 6, 11)) + '" letter-spacing="1.2" fill="#d8d8d8" fill-opacity=".8" font-weight="700"><textPath href="#' + pathId + '" startOffset="50%" text-anchor="middle">' + esc(tg.size.toUpperCase()) + '</textPath></text>';
      out += '<g color="' + finish + '">' + wheelFace(des, cx, cy, Rw, { color: finish, lip: lip, rotor: { r: rotorR, mat: mat, caliper: cal } }) + '</g>';
      out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + f1(Rw) + '" fill="url(#' + pathId + 'g)" pointer-events="none"/>';
      out += '</svg>';
      U.clear(host);
      host.appendChild(U.htmlToNode(out));
      host.appendChild(el('div', { class: 'pc-readout' }, el('span', null, des.name), el('strong', null, tg.rim_in + '" · ' + (find('wheelMaterials', get(b, 'wheels.material')) || { name: '' }).name)));
    });
  }

  /** Cross-section of rim + tyre for both axles (stretch / bulge visual). */
  function crossSection() {
    var W = 600, H = 210, k = 0.42, base = 186;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Tyre cross-section on rim">';
    [[150, 'f', 'FRONT'], [450, 'r', 'REAR']].forEach(function (x) {
      var cx = x[0], a = x[1];
      svg += '<text x="' + cx + '" y="14" text-anchor="middle" class="pc-strong">' + x[2] + '</text>';
      svg += '<path data-r="' + a + '-tyre" d="" fill="currentColor" fill-opacity=".72" stroke="currentColor" stroke-width="1"/>';
      svg += '<path data-r="' + a + '-tread" d="" fill="none" stroke="var(--bg-2,#000)" stroke-opacity=".5" stroke-width="2"/>';
      svg += '<path data-r="' + a + '-rim" d="" fill="var(--accent,#c8a46a)" fill-opacity=".85"/>';
      svg += '<line data-r="' + a + '-w1" x1="0" y1="0" x2="0" y2="0" stroke="var(--accent-2,#4c8dff)" stroke-dasharray="3 2"/>';
      svg += '<text data-r="' + a + '-tw" x="' + cx + '" y="30" text-anchor="middle">—</text>';
      svg += '<text data-r="' + a + '-rw" x="' + cx + '" y="' + (H - 2) + '" text-anchor="middle">—</text>';
      svg += '<text data-r="' + a + '-sw" x="' + (cx + 4) + '" y="110">—</text>';
    });
    svg += '</svg>';
    var d = diagram('Section on rim', svg, el('span', { class: 'pc-legend' },
      el('span', null, el('i', { style: { background: 'var(--accent,#c8a46a)' } }), 'rim'),
      el('span', null, el('i', { style: { background: 'currentColor' } }), 'tyre')));
    return ui.bind(d, 'tires', function (b) {
      [['f', 'front', 150], ['r', 'rear', 450]].forEach(function (x) {
        var a = x[0], tg = calc.tireGeom(b, x[1]), cx = x[2];
        var rimW = tg.rimWidth_in * 25.4 * k, tw = tg.width_mm * k, side = tg.sidewall_mm * k;
        var tread = tw * (tg.compound === 'slick' ? 0.94 : 0.84);
        var bulge = Math.max(tw, rimW + 4);
        var top = base - side - 8;
        var fl = cx - rimW / 2, fr = cx + rimW / 2;
        var dpath = 'M' + f1(fl) + ' ' + f1(base - 8) +
          ' C' + f1(fl - (bulge - rimW) * 0.65) + ' ' + f1(base - 8 - side * 0.25) + ' ' + f1(cx - bulge / 2) + ' ' + f1(base - 8 - side * 0.62) + ' ' + f1(cx - tread / 2) + ' ' + f1(top) +
          ' L' + f1(cx + tread / 2) + ' ' + f1(top) +
          ' C' + f1(cx + bulge / 2) + ' ' + f1(base - 8 - side * 0.62) + ' ' + f1(fr + (bulge - rimW) * 0.65) + ' ' + f1(base - 8 - side * 0.25) + ' ' + f1(fr) + ' ' + f1(base - 8) +
          ' L' + f1(fr - 4) + ' ' + f1(base - 4) + ' L' + f1(fl + 4) + ' ' + f1(base - 4) + ' Z';
        d.attr(a + '-tyre', { d: dpath });
        var gro = tg.compound === 'slick' ? '' : [-0.3, 0, 0.3].map(function (t) { return 'M' + f1(cx + tread * t) + ' ' + f1(top) + ' v6'; }).join(' ');
        d.attr(a + '-tread', { d: gro });
        var rim = 'M' + f1(fl - 5) + ' ' + f1(base - 14) + ' h5 v10 h' + f1(rimW) + ' v-10 h5 v14 h-' + f1(rimW + 10) + ' Z';
        d.attr(a + '-rim', { d: rim });
        d.attr(a + '-w1', { x1: f1(cx - tw / 2), x2: f1(cx + tw / 2), y1: f1(top - 6), y2: f1(top - 6) });
        d.text(a + '-tw', tg.width_mm + ' mm section · ' + tg.profile + '% profile');
        d.text(a + '-rw', fmt(tg.rimWidth_in, 1) + 'J rim · ideal ' + fmt(tg.fit.ideal, 1) + 'J (' + fmt(tg.fit.min, 1) + '–' + fmt(tg.fit.max, 1) + ')');
        d.cls(a + '-rw', tg.fit.status === 'ok' ? 'pc-ok' : 'pc-bad');
        d.text(a + '-sw', fmt(tg.sidewall_mm) + ' mm wall');
        d.attr(a + '-sw', { x: f1(cx + bulge / 2 + 6), y: f1(base - 8 - side * 0.55) });
      });
    });
  }

  function sizeWidget(P, axle) {
    var size = el('div', { class: 'pc-size' }, '—');
    var fit = el('span', { class: 'pc-fit' }, '—');
    var kvEl = ui.kv([]);
    var w = widget((axle === 'rear' ? 'Rear' : 'Front') + ' tyre', el('div', { class: 'pc-stack' }, size, fit, kvEl));
    P.watch(w, function () {
      var d = P.d(), tg = axle === 'rear' ? d.tr : d.tf;
      size.textContent = tg.size;
      var st = tg.fit.status;
      fit.className = 'pc-fit is-' + (st === 'ok' ? 'ok' : Math.abs(tg.fit.off_in) <= 0.5 ? 'warn' : 'bad');
      fit.textContent = st === 'ok' ? 'Approved rim fit ' + fmt(tg.fit.min, 1) + '–' + fmt(tg.fit.max, 1) + 'J' : st === 'stretched' ? 'Stretched: rim ' + fmt(tg.fit.off_in, 1) + '" too wide' : 'Ballooned: rim ' + fmt(tg.fit.off_in, 1) + '" too narrow';
      kvEl.set([
        ['Overall diameter', fmt(tg.diameter_mm) + ' mm (' + fmt(tg.diameter_in, 1) + '")'],
        ['Sidewall', fmt(tg.sidewall_mm) + ' mm'],
        ['Circumference', fmt(tg.circumference_mm) + ' mm'],
        ['Revolutions / km', fmt(tg.revsPerKm)],
        ['Load index', tg.loadIndex + ' (' + fmt(tg.loadKg) + ' kg)' + (tg.xl ? ' XL' : '')],
        ['Speed rating', tg.speedRating + (tg.speedRatingKph ? ' — ' + tg.speedRatingKph + (tg.speedRating === '(Y)' ? '+' : '') + ' km/h' : ' — unrated')],
        ['Wheel + tyre', fmt(calc.wheelMass(P.build, axle) + calc.tireMass(P.build, axle), 1) + ' kg']
      ]);
    });
    return w;
  }

  function speedoWidget(P) {
    var big = el('div', { class: 'pc-big' }, '—');
    var mt = meter(), read = el('div', { class: 'pc-readout' }), extra = el('div', { class: 'cb-hint' });
    var fix = ui.button('Restore factory rolling diameter', { kind: 'ghost', onClick: function () {
      var b = cur(), ref = defaults(), patch = { tires: {} };
      ['front', 'rear'].forEach(function (ax) {
        var A = axleKey(ax), refD = calc.tireGeom(ref, ax).diameter_mm, best = null;
        var w = num(get(b, 'tires.width' + A + '_mm'), 255), rim = num(get(b, 'wheels.diameter_in'), 19) * 25.4;
        for (var p = 25; p <= 70; p += 5) { var dd = Math.abs(rim + 2 * w * p / 100 - refD); if (!best || dd < best.dd) best = { p: p, dd: dd }; }
        patch.tires['profile' + A] = best.p;
      });
      patchState(patch, 'Tyre profiles → factory rolling diameter');
      toast('Aspect ratios set to ' + patch.tires.profileFront + ' / ' + patch.tires.profileRear + ' to keep the speedometer honest', 'success');
    } });
    var w = widget('Speedometer error', el('div', { class: 'pc-stack' }, big, mt, read, extra, fix));
    P.watch(w, function () {
      var sp = P.d().speedo;
      big.innerHTML = signed(sp.error_pct, 1) + '<small>%</small>';
      mt.set(0.5 + sp.error_pct / 10, sp.status === 'ok' ? 'good' : sp.status, 0.5);
      read.innerHTML = '<span>Indicated 100 km/h</span><strong>actual ' + fmt(sp.actualAt100, 1) + ' km/h</strong>';
      var txt = Math.abs(sp.error_pct) < 0.25 ? 'Matches the factory calibration.' :
        sp.error_pct > 0 ? 'Taller than factory: the speedometer under-reads — you are going faster than shown (a legal problem in most markets).' :
          'Smaller than factory: the speedometer over-reads and effective gearing gets shorter.';
      if (sp.axle === 'both' && sp.awdMismatch_pct > 1) txt += ' AWD axle diameter mismatch ' + fmt(sp.awdMismatch_pct, 1) + '% — the centre differential will work constantly.';
      extra.textContent = txt;
      fix.hidden = Math.abs(sp.error_pct) < 1;
    });
    return w;
  }

  function buildWheels(root, P) {
    root.appendChild(ui.issues('wheels'));
    var tIss = ui.issues('tires', { compact: true });
    tIss.classList.add('pc-sub-issues');
    root.appendChild(tIss);
    if (hasDOM && !document.getElementById('pc-sub-issues-style')) {
      var st = document.createElement('style'); st.id = 'pc-sub-issues-style';
      st.textContent = '.pc-sub-issues.is-empty{display:none}';
      (document.head || document.documentElement).appendChild(st);
    }

    var stats = statGrid([
      { key: 'fs', label: 'Front tyre', unit: '' },
      { key: 'rs', label: 'Rear tyre', unit: '' },
      { key: 'od', label: 'Rolling dia.', unit: 'mm', decimals: 0 },
      { key: 'spd', label: 'Speedo error', unit: '%', decimals: 1 },
      { key: 'mf', label: 'Wheel+tyre F', unit: 'kg', decimals: 1 },
      { key: 'mr', label: 'Wheel+tyre R', unit: 'kg', decimals: 1 },
      { key: 'inertia', label: 'Rot. inertia', unit: 'kg·m²', decimals: 2, title: 'Polar moment of one rear wheel + tyre' },
      { key: 'mu', label: 'Peak grip µ', decimals: 2 },
      { key: 'cost', label: 'Package', unit: '' }
    ]);
    P.watch(stats, function (b) {
      var d = P.d(), tc = find('tireCompounds', get(b, 'tires.compound')) || {};
      var cost = sectionCost(b, ['wheels', 'tires'], function (bb) {
        var w = bb.wheels || {}, t = bb.tires || {};
        return fp('wheelDesigns', w.design) + fp('wheelMaterials', w.material) + (num(w.diameter_in, 19) - 19) * optPrice('perInchDiameter', 350) * 4 +
          (w.staggered ? optPrice('staggeredWheels', 400) : 0) + 4 * fp('tireCompounds', t.compound);
      });
      stats.setAll({
        fs: { value: d.tf.short, unit: '' }, rs: { value: d.tr.short, unit: '' }, od: d.tr.diameter_mm, spd: d.speedo.error_pct,
        mf: calc.wheelMass(b, 'front') + calc.tireMass(b, 'front'), mr: calc.wheelMass(b, 'rear') + calc.tireMass(b, 'rear'),
        inertia: calc.wheelInertia(b, 'rear'), mu: tc.mu, cost: { value: money(cost.amount) + (cost.estimated ? '*' : ''), unit: '' }
      });
    });
    root.appendChild(ui.section('Rolling stock', 'Wheels, tyres and what they do to the unsprung mass and gearing.', stats));

    /* ---- wheel design */
    var designCards = ui.cards({
      path: 'wheels.design', label: 'Wheel design', columns: 4,
      options: Dt.wheelDesigns.map(function (w) {
        return {
          id: w.id, name: w.name, desc: w.desc, price: w.price, icon: wheelIcon(w),
          badge: w.style === 'aero-disc' ? 'Low drag' : w.id === 'beadlock' ? 'Off-road' : w.style === 'centerlock' ? 'Race' : null,
          specs: [['Spokes', w.spokes ? String(w.spokes) : 'Disc'], ['Concavity', fmt(num(w.concavity, 0) * 100) + '%']]
        };
      })
    });
    var detailKv = ui.kv([]);
    P.watch(detailKv, function (b) {
      var des = wheelDesignOf(b), mat = find('wheelMaterials', get(b, 'wheels.material')) || {};
      detailKv.set([
        ['Design', des.name], ['Construction', mat.name || '—'],
        ['Front', fmt(get(b, 'wheels.diameter_in')) + ' × ' + fmt(get(b, 'wheels.widthFront_in'), 1) + 'J · ' + fmt(calc.wheelMass(b, 'front'), 1) + ' kg'],
        ['Rear', fmt(get(b, 'wheels.diameter_in')) + ' × ' + fmt(get(b, 'wheels.widthRear_in'), 1) + 'J · ' + fmt(calc.wheelMass(b, 'rear'), 1) + ' kg'],
        ['Fitment', get(b, 'wheels.staggered') ? 'Staggered' : 'Square'],
        ['Finish', (Dt.swatchName && Dt.swatchName(get(b, 'wheels.finish'))) || (WHEEL_SWATCHES.filter(function (s) { return s.hex.toLowerCase() === String(get(b, 'wheels.finish')).toLowerCase(); })[0] || { name: String(get(b, 'wheels.finish')).toUpperCase() }).name],
        ['Aero', des.dragDelta ? 'ΔCd ' + fmt(des.dragDelta, 3) : 'Open face'],
        ['Unsprung / corner', fmt(P.d().usF.total, 1) + ' kg F · ' + fmt(P.d().usR.total, 1) + ' kg R']
      ]);
    });
    root.appendChild(ui.section('Wheel design', null, el('div', { class: 'pc-wheel-stage' }, wheelPreview(), detailKv), designCards));

    /* ---- material & finish */
    var matCards = ui.cards({
      path: 'wheels.material', label: 'Construction', columns: 3,
      options: Dt.wheelMaterials.map(function (m) {
        return { id: m.id, name: m.name, desc: m.desc, price: m.price, icon: wheelMaterialIcon(m), badge: m.id === 'carbon' ? 'Lightest' : null, specs: [['Mass', '×' + fmt(m.weightFactor, 2)]] };
      })
    });
    var finish = ui.color({ path: 'wheels.finish', label: 'Wheel finish', swatches: WHEEL_SWATCHES, allowCustom: true, columns: 6 });
    root.appendChild(ui.section('Construction & finish', 'Lighter wheels cut unsprung and rotating mass — the suspension reacts faster and the car accelerates harder.', matCards, finish));

    /* ---- size */
    var dR = R('wheels.diameter_in'), wR = R('wheels.widthFront_in');
    var dia = ui.slider({
      path: 'wheels.diameter_in', label: 'Wheel diameter', min: dR.min, max: dR.max, step: 1, unit: 'in', format: function (v) { return v + '"'; },
      ticks: [15, 17, 19, 21, 23].map(function (v) { return { value: v, label: v + '"' }; }),
      hint: 'Larger wheels clear bigger brakes and sharpen response; smaller wheels with taller sidewalls ride better.'
    });
    var stag = ui.toggle({ path: 'wheels.staggered', label: 'Staggered fitment', price: optPrice('staggeredWheels', 400), hint: 'Wider rear rims and tyres than the front. Off = square set-up (rear follows front, rotation possible).' });
    var widthFmt = function (v) { return fmt(v, 1) + 'J · ' + fmt(v * 25.4) + ' mm'; };
    var wTicks = [{ value: 6, label: '6J' }, { value: 9, label: '9J' }, { value: 13, label: '13J' }];
    var wf = ui.slider({ path: 'wheels.widthFront_in', label: 'Front rim width', min: wR.min, max: wR.max, step: wR.step, format: widthFmt, ticks: wTicks });
    var wr = ui.slider({ path: 'wheels.widthRear_in', label: 'Rear rim width', min: wR.min, max: wR.max, step: wR.step, format: widthFmt, ticks: wTicks,
      disabled: function (b) { return get(b, 'wheels.staggered') ? false : 'Square fitment — rear matches front. Enable staggered to set it independently.'; } });
    root.appendChild(ui.section('Wheel size', null, dia, stag, ui.grid(2, wf, wr)));

    /* ---- tyres */
    var compCards = ui.cards({
      path: 'tires.compound', label: 'Tyre compound', columns: 4,
      options: Dt.tireCompounds.map(function (c) {
        return {
          id: c.id, name: c.name, desc: c.desc, price: c.price * 4, icon: compoundIcon(c),
          badge: c.streetLegal === false ? 'Track only' : c.id === 'winter' ? '3PMSF' : c.id === 'track' ? 'Needs heat' : null,
          specs: [['Dry µ', fmt(c.mu, 2)], ['Wet µ', fmt(c.wetMu, 2)], ['Treadwear', String(c.treadwear)], ['Noise', c.noise + ' dB']]
        };
      }),
      hint: 'Price shown for a set of four. Bars: dry grip, wet grip, tread life and noise.'
    });
    var twR = R('tires.widthFront_mm'), pR = R('tires.profileFront');
    var tWidthFmt = function (v) { return v + ' mm'; };
    var tTicks = [{ value: 175, label: '175' }, { value: 265, label: '265' }, { value: 355, label: '355' }];
    var pTicks = [{ value: 25, label: '25' }, { value: 45, label: '45' }, { value: 70, label: '70' }];
    var rearOff = function (b) { return get(b, 'wheels.staggered') ? false : 'Square fitment — rear tyres match the fronts.'; };
    var tf = ui.slider({ path: 'tires.widthFront_mm', label: 'Front section width', min: twR.min, max: twR.max, step: twR.step, format: tWidthFmt, ticks: tTicks });
    var tr = ui.slider({ path: 'tires.widthRear_mm', label: 'Rear section width', min: twR.min, max: twR.max, step: twR.step, format: tWidthFmt, ticks: tTicks, disabled: rearOff });
    var pf = ui.slider({ path: 'tires.profileFront', label: 'Front aspect ratio', min: pR.min, max: pR.max, step: pR.step, format: function (v) { return v + '%'; }, ticks: pTicks, hint: 'Sidewall height as a % of the width.' });
    var pr = ui.slider({ path: 'tires.profileRear', label: 'Rear aspect ratio', min: pR.min, max: pR.max, step: pR.step, format: function (v) { return v + '%'; }, ticks: pTicks, disabled: rearOff });
    var matchBtn = ui.button('Match tyres to rims', { kind: 'ghost', onClick: function () {
      var b = cur(), patch = { tires: {} };
      ['front', 'rear'].forEach(function (ax) {
        var A = axleKey(ax), rimW = num(get(b, 'wheels.width' + A + '_in'), 9), best = null;
        for (var w = twR.min; w <= twR.max; w += twR.step) { var r = calc.rimRange(w), dd = Math.abs(r.ideal - rimW); if (!best || dd < best.dd) best = { w: w, dd: dd }; }
        patch.tires['width' + A + '_mm'] = best.w;
      });
      patchState(patch, 'Tyre widths matched to rims');
      toast('Tyre widths set to ' + patch.tires.widthFront_mm + ' / ' + patch.tires.widthRear_mm + ' mm for an ideal rim fit', 'success');
    } });
    var ratingSel = ui.select({
      path: 'tires.speedRating', label: 'Speed rating',
      options: (Dt.tireSpeedRatings || []).map(function (r) { return { id: r.id, name: r.name, price: r.price }; }),
      hint: 'The tyres’ certified top speed caps the car’s. “Compound default”: Eco / All-Season 210, Winter 240, Touring 270, Max Performance & Cup 300, Super Sport 360, Slick 420 km/h. Hypercars need the 450 km/h construction.'
    });
    root.appendChild(ui.section('Tyres', null, compCards, ratingSel, ui.grid(2, tf, tr), ui.grid(2, pf, pr), el('div', { class: 'pc-btnrow' }, matchBtn)));

    /* ---- size, fit and calibration */
    root.appendChild(ui.section('Size, fit & calibration', 'Tyre size strings, ETRTO-style rim approval and speedometer calibration versus the factory fitment.',
      el('div', { class: 'pc-sizes' }, sizeWidget(P, 'front'), sizeWidget(P, 'rear')),
      crossSection(),
      speedoWidget(P)));

    /* ---- compound comparison table */
    var cmp = table(['Compound', 'Dry µ', 'Wet µ', 'Snow µ', 'Rolling res.', 'Treadwear', 'Noise', 'Set of 4']);
    P.watch(cmp, function (b) {
      var sel = get(b, 'tires.compound');
      cmp.set(Dt.tireCompounds.map(function (c) {
        return {
          cls: c.id === sel ? 'is-total' : null,
          cells: [c.name + (c.id === sel ? '  ✓' : ''), fmt(c.mu, 2), fmt(c.wetMu, 2), fmt(c.snowMu, 2), fmt(c.rollingResistance * 1000, 1) + '‰', String(c.treadwear), c.noise + ' dB', money(c.price * 4)]
        };
      }));
    });
    root.appendChild(ui.section('Compound comparison', null, cmp));
  }

  /* ======================================================================
     PANEL: AERO
     ====================================================================== */
  function wingOf(b) { return find('aero.wings', get(b, 'aero.wing')) || Dt.aero.wings[0]; }

  /** Side silhouette with front / rear downforce arrows scaled to the load at 200 km/h. */
  function aeroBalanceDiagram(P) {
    var W = 600, H = 200, gy = 160;
    var shape = null;
    try { if (CB.panelsPowertrain && CB.panelsPowertrain.bodyShape) shape = CB.panelsPowertrain.bodyShape(find('bodyStyles', get(cur(), 'body.style')) || Dt.bodyStyles[0], get(cur(), 'body.wheelbase_mm')); } catch (e) { shape = null; }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Aerodynamic load distribution">';
    svg += '<defs><marker id="pc-arr" viewBox="0 0 10 10" refX="5" refY="9" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L5 10 L10 0 z" fill="var(--accent,#c8a46a)"/></marker>' +
      '<marker id="pc-arr2" viewBox="0 0 10 10" refX="5" refY="9" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L5 10 L10 0 z" fill="var(--bad,#e5484d)"/></marker></defs>';
    svg += '<line x1="20" y1="' + gy + '" x2="580" y2="' + gy + '" stroke="currentColor" stroke-opacity=".4"/>';
    svg += '<path data-r="body" d="" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-opacity=".55"/>';
    svg += '<circle data-r="wf" cx="0" cy="0" r="0" fill="var(--bg-2,#0e0e10)" stroke="currentColor" stroke-width="2"/>';
    svg += '<circle data-r="wr" cx="0" cy="0" r="0" fill="var(--bg-2,#0e0e10)" stroke="currentColor" stroke-width="2"/>';
    svg += '<line data-r="af" x1="0" y1="0" x2="0" y2="0" stroke="var(--accent,#c8a46a)" stroke-width="5" marker-end="url(#pc-arr)"/>';
    svg += '<line data-r="ar" x1="0" y1="0" x2="0" y2="0" stroke="var(--accent,#c8a46a)" stroke-width="5" marker-end="url(#pc-arr)"/>';
    svg += '<line data-r="drag" x1="0" y1="0" x2="0" y2="0" stroke="var(--accent-2,#4c8dff)" stroke-width="3" marker-end="url(#pc-arr)"/>';
    svg += '<text data-r="tf" x="0" y="20" text-anchor="middle" class="pc-strong">—</text>';
    svg += '<text data-r="tr" x="0" y="20" text-anchor="middle" class="pc-strong">—</text>';
    svg += '<text data-r="td" x="590" y="0" text-anchor="end">—</text>';
    svg += '<line data-r="cp" x1="0" y1="34" x2="0" y2="' + gy + '" stroke="var(--good,#3fb950)" stroke-dasharray="4 3"/>';
    svg += '<text data-r="cpt" x="0" y="' + (gy + 16) + '" text-anchor="middle" class="pc-ok">centre of pressure</text>';
    svg += '<line data-r="cg" x1="0" y1="34" x2="0" y2="' + gy + '" stroke="currentColor" stroke-opacity=".55" stroke-dasharray="2 3"/>';
    svg += '<text data-r="cgt" x="0" y="' + (gy + 30) + '" text-anchor="middle">weight centre</text>';
    svg += '</svg>';
    var d = diagram('Aero load @ 200 km/h', svg);
    var lastShapeKey = null;
    P.watch(d, function (b, m) {
      var ae = P.d().aero;
      var st = find('bodyStyles', get(b, 'body.style')) || Dt.bodyStyles[0];
      var sk = st.id + '|' + get(b, 'body.wheelbase_mm') + '|' + get(b, 'suspension.rideHeight_mm');
      var sh = null;
      try { sh = CB.panelsPowertrain && CB.panelsPowertrain.bodyShape ? CB.panelsPowertrain.bodyShape(st, get(b, 'body.wheelbase_mm')) : null; } catch (e) { sh = null; }
      var L = sh ? sh.L : 4600, kx = 500 / Math.max(4000, L), x0 = 50 + (500 - L * kx) / 2;
      var wfX, wrX;
      if (sh) { wfX = x0 + sh.wheels[0][0] * kx; wrX = x0 + sh.wheels[1][0] * kx; }
      else { wfX = x0 + 900 * kx; wrX = x0 + (900 + num(get(b, 'body.wheelbase_mm'), 2650)) * kx; }
      if (sk !== lastShapeKey) {
        lastShapeKey = sk;
        var lift = (num(get(b, 'suspension.rideHeight_mm'), 120) - 120) * kx;
        var wr = sh ? sh.wheelR * kx : 335 * kx;
        if (sh) {
          var dd = sh.body.map(function (p, i) { return (i ? 'L' : 'M') + f1(x0 + p[0] * kx) + ' ' + f1(gy - p[1] * kx - lift); }).join(' ') + ' Z';
          d.attr('body', { d: dd });
        } else {
          d.attr('body', { d: 'M' + f1(x0) + ' ' + f1(gy - 30) + ' L' + f1(x0 + 20) + ' ' + f1(gy - 70) + ' L' + f1(x0 + 220) + ' ' + f1(gy - 110) + ' L' + f1(x0 + 420) + ' ' + f1(gy - 100) + ' L' + f1(x0 + L * kx) + ' ' + f1(gy - 60) + ' L' + f1(x0 + L * kx) + ' ' + f1(gy - 25) + ' Z' });
        }
        d.attr('wf', { cx: f1(wfX), cy: f1(gy - wr), r: f1(wr) });
        d.attr('wr', { cx: f1(wrX), cy: f1(gy - wr), r: f1(wr) });
      }
      var fk = ae.front_kg_200, rk = ae.rear_kg_200;
      function arrow(role, x, kg) {
        var len = clamp(Math.abs(kg) / 3, 4, 95);
        var down = kg >= 0;
        var y0 = down ? 34 : 34 + len, y1 = down ? 34 + len : 34;
        d.attr(role, { x1: f1(x), x2: f1(x), y1: f1(y0), y2: f1(y1), stroke: down ? 'var(--accent,#c8a46a)' : 'var(--bad,#e5484d)', 'marker-end': down ? 'url(#pc-arr)' : 'url(#pc-arr2)' });
      }
      arrow('af', wfX, fk); arrow('ar', wrX, rk);
      d.attr('tf', { x: f1(wfX) }); d.attr('tr', { x: f1(wrX) });
      d.text('tf', (fk >= 0 ? '' : 'lift ') + fmt(Math.abs(fk)) + ' kg');
      d.text('tr', (rk >= 0 ? '' : 'lift ') + fmt(Math.abs(rk)) + ' kg');
      d.cls('tf', fk >= 0 ? 'pc-strong' : 'pc-bad'); d.cls('tr', rk >= 0 ? 'pc-strong' : 'pc-bad');
      var dragLen = clamp(ae.drag_kg_200 / 2.2, 10, 80);
      d.attr('drag', { x1: f1(x0 + L * kx + 6), x2: f1(x0 + L * kx + 6 + dragLen), y1: f1(gy - 60), y2: f1(gy - 60), stroke: 'var(--accent-2,#4c8dff)', 'marker-end': 'url(#pc-arr)' });
      d.attr('td', { y: f1(gy - 68) });
      d.text('td', 'drag ' + fmt(ae.drag_kg_200) + ' kgf');
      var wfp = num(m.weightFront_pct, 52) / 100;
      var cgX = wfX + (wrX - wfX) * (1 - wfp);
      d.attr('cg', { x1: f1(cgX), x2: f1(cgX) }); d.attr('cgt', { x: f1(cgX) });
      var cpVisible = ae.total_kg_200 > 5 && ae.balance_front_pct != null;
      var cpX = cpVisible ? wfX + (wrX - wfX) * (1 - clamp(ae.balance_front_pct, -20, 120) / 100) : cgX;
      d.attr('cp', { x1: f1(cpX), x2: f1(cpX), 'stroke-opacity': cpVisible ? 1 : 0 });
      d.attr('cpt', { x: f1(cpX), 'fill-opacity': cpVisible ? 1 : 0 });
    });
    return d;
  }

  function buildAero(root, P) {
    root.appendChild(ui.issues('aero'));

    var stats = statGrid([
      { key: 'df', label: 'Downforce @200', unit: 'kg', decimals: 0 },
      { key: 'bal', label: 'Aero balance', unit: '% F', decimals: 1 },
      { key: 'cd', label: 'Drag coeff. Cd', decimals: 3 },
      { key: 'cda', label: 'CdA', unit: 'm²', decimals: 3 },
      { key: 'drag', label: 'Drag @200', unit: 'kgf', decimals: 0 },
      { key: 'ld', label: 'L/D', decimals: 2, title: 'Downforce-to-drag ratio at 200 km/h' },
      { key: 'pw', label: 'Drag power @200', unit: 'kW', decimals: 0 },
      { key: 'vmax', label: 'Top speed', unit: 'km/h', decimals: 0 },
      { key: 'dfv', label: 'Downforce @Vmax', unit: 'kg', decimals: 0 }
    ]);
    var estFlag = el('div', { class: 'pc-estimated', hidden: true }, 'Estimated — physics engine not loaded.');
    P.watch(stats, function (b, m) {
      var ae = P.d().aero;
      var vmax = m.topSpeed_kph != null ? m.topSpeed_kph : null;
      stats.setAll({
        df: m.downforce_kg_200 != null ? m.downforce_kg_200 : Math.max(0, ae.total_kg_200), bal: ae.balance_front_pct,
        cd: ae.cd, cda: ae.cda, drag: ae.drag_kg_200, ld: ae.liftToDrag, pw: ae.dragPower_kw_200, vmax: vmax,
        dfv: vmax != null ? Math.max(0, ae.dfAt(vmax)) : null
      });
      estFlag.hidden = !m._estimated;
    });
    root.appendChild(ui.section('Aerodynamics', 'Downforce rises with the square of speed; so does drag. Balance is front share of total downforce.', stats, estFlag));

    /* balance widget */
    var balMeter = meter(), balRead = el('div', { class: 'pc-readout' }), balAdv = el('div', { class: 'cb-hint' });
    var balBox = widget('Aero balance vs weight distribution', el('div', null, balRead, balMeter, balAdv));
    P.watch(balBox, function (b, m) {
      var ae = P.d().aero, wf = num(m.weightFront_pct, 52);
      if (ae.balance_front_pct == null || ae.total_kg_200 < 5) {
        balMeter.set(0, null, wf / 100);
        balRead.innerHTML = '<span>Net lift — no aero balance</span><strong>' + fmt(ae.total_kg_200) + ' kg @200</strong>';
        balAdv.textContent = 'The body generates lift at speed. Add a splitter and diffuser to convert it into downforce.';
        return;
      }
      var dlt = ae.balance_front_pct - wf;
      balMeter.set(clamp(ae.balance_front_pct, 0, 100) / 100, Math.abs(dlt) < 6 ? 'good' : Math.abs(dlt) < 14 ? 'warn' : 'bad', wf / 100);
      balRead.innerHTML = '<span>Aero <strong>' + fmt(ae.balance_front_pct, 1) + '% F</strong></span><span>Weight <strong>' + fmt(wf, 1) + '% F</strong></span>';
      balAdv.textContent = Math.abs(dlt) < 6 ? 'Aero balance tracks the weight distribution — the handling stays consistent from low to high speed.' :
        dlt < 0 ? 'Rear-biased aero by ' + fmt(-dlt, 0) + '%: stable at speed but the car will push in fast corners. Add front downforce (splitter, dive planes) or flatten the wing.' :
          'Front-biased aero by ' + fmt(dlt, 0) + '%: the rear goes light in fast corners. Add wing angle or a bigger diffuser.';
    });
    root.appendChild(ui.section('Load distribution', null, aeroBalanceDiagram(P), balBox));

    /* elements */
    var spCards = ui.cards({
      path: 'aero.splitter', label: 'Front splitter', columns: 4, compact: true,
      options: Dt.aero.splitters.map(function (o) { return { id: o.id, name: o.name, desc: o.desc, price: o.price, icon: splitterIcon(o), specs: [['@200', '+' + o.downforce_kg_at_200 + ' kg'], ['ΔCd', signed(o.dragDelta, 3)]] }; })
    });
    var wgCards = ui.cards({
      path: 'aero.wing', label: 'Rear wing', columns: 4, compact: true,
      options: Dt.aero.wings.map(function (o) {
        return { id: o.id, name: o.name, desc: o.desc, price: o.price, icon: wingIcon(o), badge: o.active ? 'Active' : o.adjustable ? 'Adjustable' : null,
          specs: [['@200', '+' + o.downforce_kg_at_200 + ' kg'], ['ΔCd', signed(o.dragDelta, 3)], ['Mass', o.weight_kg + ' kg']] };
      })
    });
    var dfCards = ui.cards({
      path: 'aero.diffuser', label: 'Rear diffuser', columns: 4, compact: true,
      options: Dt.aero.diffusers.map(function (o) { return { id: o.id, name: o.name, desc: o.desc, price: o.price, icon: diffuserIcon(o), specs: [['@200', '+' + o.downforce_kg_at_200 + ' kg'], ['ΔCd', signed(o.dragDelta, 3)]] }; })
    });
    var waR = R('aero.wingAngle_deg');
    var angle = ui.slider({
      path: 'aero.wingAngle_deg', label: 'Wing angle of attack', min: waR.min, max: waR.max, step: 1, unit: '°',
      format: function (v) { var f = calc.wingAngleFactor({ adjustable: true }, v); return v + '° · ×' + fmt(f.df, 2) + ' downforce'; },
      ticks: [{ value: 0, label: 'Low drag' }, { value: 6, label: '6°' }, { value: 12, label: '12°' }, { value: 20, label: 'Max' }],
      marks: [{ value: 14, label: 'Stall risk above ~14°', kind: 'warning' }],
      disabled: function (b) { var w = wingOf(b); return w.adjustable ? false : (w.id === 'none' ? 'Fit an adjustable wing to set its angle' : w.name + ' has a fixed profile'); },
      hint: 'Steeper angles multiply wing downforce (and drag). Past ~14° the flow begins to separate — diminishing returns.'
    });
    var angleRead = el('div', { class: 'pc-readout' });
    P.watch(angleRead, function (b) {
      var ae = P.d().aero, wing = wingOf(b);
      var el_ = ae.elements.filter(function (e) { return e.id === 'wing'; })[0];
      angleRead.innerHTML = wing.adjustable && el_ ? '<span>Wing @200 <strong>' + fmt(el_.kg) + ' kg</strong></span><span>wing ΔCd <strong>' + fmt(el_.dragDelta, 3) + '</strong></span>' : '<span>' + (wing.id === 'none' ? 'No wing fitted' : wing.name + ' — fixed') + '</span>';
    });
    var canards = ui.toggle({ path: 'aero.canards', label: 'Dive planes (canards)', price: optPrice('canards', 1800), hint: '+12 kg front downforce @200, adds a little drag.' });
    var skirts = ui.toggle({ path: 'aero.sideSkirts', label: 'Side skirts', price: optPrice('sideSkirts', 1400), hint: 'Seal the underfloor — helps the diffuser work and trims drag.' });
    var active = ui.toggle({
      path: 'aero.activeAero', label: 'Active aero control', price: optPrice('activeAero', 8500),
      disabled: function (b) { return wingOf(b).active ? 'Included with the Active Aero Wing' : false; },
      hint: 'Shutters and flaps trim drag on straights and deploy downforce in corners and under braking.'
    });
    root.appendChild(ui.section('Aero elements', null, spCards, wgCards, el('div', { class: 'pc-stack' }, angle, angleRead), dfCards, ui.grid(3, canards, skirts, active)));

    /* chart + breakdown */
    var chart = liveChart(P, 'downforce', { height: 240, title: 'Downforce & drag vs speed', label: 'Downforce versus speed chart' });
    var brk = table(['Element', 'Front kg', 'Rear kg', 'Total @200', 'ΔCd']);
    P.watch(brk, function () {
      var ae = P.d().aero;
      var rows = ae.elements.map(function (e) {
        return { cells: [e.label, fmt(e.front_kg), fmt(e.rear_kg), fmt(e.kg), e.dragDelta ? signed(e.dragDelta, 3) : '—'], cellCls: [null, null, null, e.kg < 0 ? 'is-bad' : null, null] };
      });
      rows.push({ cls: 'is-total', cells: ['Total', fmt(ae.front_kg_200), fmt(ae.rear_kg_200), fmt(ae.total_kg_200), signed(ae.dragDelta, 3)] });
      brk.set(rows);
    });
    var spd = table(['Speed', 'Downforce', 'Drag', 'Grip gain', 'Drag power']);
    P.watch(spd, function (b, m) {
      var ae = P.d().aero, mass = num(m.weight_kg, 1500);
      spd.set([100, 150, 200, 250, 300].map(function (v) {
        var df = ae.dfAt(v), dr = ae.dragKgAt(v);
        return { cells: [v + ' km/h', fmt(df) + ' kg', fmt(dr) + ' kgf', signed(Math.max(-100, df / mass * 100), 1) + '%', fmt(dr * G * v / 3.6 / 1000) + ' kW'] };
      }));
    });
    root.appendChild(ui.section('Aero map', 'The breakdown scales to the physics engine total when available; front/rear shares come from the element model.', chart, el('div', { class: 'pc-two' }, brk, spd)));
  }

  /* ======================================================================
     PANEL: WEIGHT
     ====================================================================== */
  function buildWeight(root, P) {
    root.appendChild(ui.issues('weight'));

    var stats = statGrid([
      { key: 'w', label: 'Curb weight', unit: 'kg', decimals: 0 },
      { key: 'fp', label: 'Front axle', unit: '%', decimals: 1 },
      { key: 'p2w', label: 'Power / weight', unit: 'hp/t', decimals: 0 },
      { key: 'saved', label: 'Weight saved', unit: 'kg', decimals: 0, kind: 'good' },
      { key: 'added', label: 'Weight added', unit: 'kg', decimals: 0 },
      { key: 'cpk', label: 'Cost / kg saved', unit: '', decimals: 0 },
      { key: 'cg', label: 'CG height', unit: 'mm', decimals: 0 },
      { key: 'cf', label: 'Front corner', unit: 'kg', decimals: 0 },
      { key: 'cr', label: 'Rear corner', unit: 'kg', decimals: 0 }
    ]);
    var estFlag = el('div', { class: 'pc-estimated', hidden: true }, 'Estimated — physics engine not loaded; mass model is approximate.');
    P.watch(stats, function (b, m) {
      var lg = P.d().ledger, w = num(m.weight_kg, NaN), fpct = num(m.weightFront_pct, NaN);
      stats.setAll({
        w: w, fp: fpct, p2w: m.powerToWeight_hpPerTon != null ? m.powerToWeight_hpPerTon : (m.power_hp && w ? m.power_hp / w * 1000 : null),
        saved: lg.saved_kg, added: lg.added_kg, cpk: { value: lg.saved_kg > 0 ? money(lg.costPerKgSaved) : '—', unit: lg.saved_kg > 0 ? '/kg' : '' },
        cg: m.cgHeight_mm, cf: w * fpct / 200, cr: w * (100 - fpct) / 200
      });
      estFlag.hidden = !m._estimated;
    });
    var chart = liveChart(P, 'weight', { height: 300, title: 'Mass distribution', label: 'Weight distribution chart' });
    root.appendChild(ui.section('Mass & distribution', 'Every kilogram removed improves acceleration, braking and cornering at once.', stats, estFlag, chart));

    /* reductions */
    var deaden = ui.toggle({
      path: 'weight.soundDeadening', label: 'Delete sound deadening', price: optPrice('soundDeadeningDelete', -200),
      get: function (b) { return get(b, 'weight.soundDeadening') === false; },
      set: function (v) { setState('weight.soundDeadening', !v, v ? 'Sound deadening deleted' : 'Sound deadening restored'); },
      hint: '−' + optWeight('soundDeadening', 22) + ' kg. Bitumen pads and acoustic foam removed; cabin gets ~6 dB louder.'
    });
    var seats = ui.toggle({
      path: 'weight.rearSeats', label: 'Delete rear seats', price: optPrice('rearSeatDelete', -500),
      get: function (b) { return get(b, 'weight.rearSeats') === false; },
      set: function (v) { setState('weight.rearSeats', !v, v ? 'Rear seats deleted' : 'Rear seats restored'); },
      hint: '−' + optWeight('rearSeats', 28) + ' kg. Replaced by a carpeted parcel shelf — required with a full cage.'
    });
    var spare = ui.toggle({ path: 'weight.spareTire', label: 'Spare wheel & jack', price: optPrice('spareTire', 250), hint: '+' + optWeight('spareTire', 18) + ' kg. Without it you get a tyre-repair kit.' });
    var lightBtn = ui.button('Apply lightweight package', { kind: 'ghost', onClick: function () {
      patchState({ weight: { soundDeadening: false, rearSeats: false, spareTire: false, glass: 'polycarbonate', battery: 'lithium' } }, 'Lightweight package');
      toast('Lightweight package applied — sound deadening, rear seats and spare deleted; polycarbonate glass and lithium battery fitted', 'success');
    } });
    var comfortBtn = ui.button('Restore road comfort', { kind: 'ghost', onClick: function () {
      patchState({ weight: { soundDeadening: true, rearSeats: true, glass: 'standard', battery: 'lead' } }, 'Restore road comfort');
    } });
    root.appendChild(ui.section('Weight reduction', null, ui.grid(3, deaden, seats, spare), el('div', { class: 'pc-btnrow' }, lightBtn, comfortBtn)));

    var glass = ui.cards({
      path: 'weight.glass', label: 'Glazing', columns: 3,
      options: (Dt.glassTypes || []).map(function (o) { return { id: o.id, name: o.name, desc: o.desc, price: o.price, icon: glassIcon(o), specs: [['Mass', signed(o.weight_kg, 0) + ' kg']], badge: o.id === 'polycarbonate' ? 'Race' : null }; })
    });
    var batt = ui.cards({
      path: 'weight.battery', label: '12 V battery', columns: 2,
      options: (Dt.batteryTypes || []).map(function (o) { return { id: o.id, name: o.name, desc: o.desc, price: o.price, icon: batteryIcon(o), specs: [['Mass', signed(o.weight_kg, 0) + ' kg']] }; })
    });
    root.appendChild(ui.section('Glass & electrics', null, glass, batt));

    var cage = ui.cards({
      path: 'weight.rollCage', label: 'Roll cage', columns: 3,
      options: (Dt.rollCages || []).map(function (o) {
        return { id: o.id, name: o.name, desc: o.desc, price: o.price, icon: cageIcon(o), badge: o.id === 'full' ? 'FIA' : null,
          specs: [['Mass', signed(o.weight_kg, 0) + ' kg'], ['Rigidity', '+' + fmt(num(o.stiffnessGain, 0) * 100) + '%']] };
      })
    });
    var cageNote = note('', 'info'); ui.bind(cageNote, 'weight.rollCage', function (b) {
      var c = get(b, 'weight.rollCage');
      cageNote.hidden = c === 'none';
      cageNote.textContent = c === 'full' ? 'A welded cage adds torsional rigidity and occupant protection, raises the CG slightly and is incompatible with rear seats.' :
        'A bolt-in half cage is removable and club-legal; pair it with harnesses for track days.';
    });
    root.appendChild(ui.section('Safety structure', null, cage, cageNote));

    var bR = R('weight.ballast_kg');
    var ballast = ui.slider({ path: 'weight.ballast_kg', label: 'Ballast', min: bR.min, max: bR.max, step: bR.step, unit: 'kg', ticks: [0, 25, 50, 75, 100],
      hint: 'Tungsten ballast for class weight limits — or to tune the balance. Placed low, it barely moves the CG.' });
    var pos = ui.segmented({
      path: 'weight.ballastPosition', label: 'Ballast position',
      options: (Dt.ballastPositions || []).map(function (o) { return { id: o.id, name: o.name, desc: o.desc }; }),
      disabled: function (b) { return num(get(b, 'weight.ballast_kg'), 0) > 0 ? false : 'Add ballast first'; }
    });
    var balRead = el('div', { class: 'pc-readout' });
    P.watch(balRead, function (b, m) {
      var kg = num(get(b, 'weight.ballast_kg'), 0), p = get(b, 'weight.ballastPosition', 'center');
      var w = num(m.weight_kg, 1500);
      var share = p === 'front' ? 0.85 : p === 'rear' ? 0.08 : 0.5;
      var shift = w > 0 ? (kg * share - kg * num(m.weightFront_pct, 50) / 100) / w * 100 : 0;
      balRead.innerHTML = kg > 0 ? '<span>Moves front share by <strong>' + signed(shift, 2) + '%</strong></span><span>Cost <strong>' + money(kg * optPrice('ballastPerKg', 6)) + '</strong></span>' : '<span>No ballast fitted</span>';
    });
    root.appendChild(ui.section('Ballast', null, ui.grid(2, ballast, pos), balRead));

    var ledger = table(['Item', 'Mass', 'Price', 'Status']);
    P.watch(ledger, function () {
      var lg = P.d().ledger;
      var rows = lg.rows.map(function (r) {
        return { cls: r.active ? null : 'is-off', cells: [r.label, signed(r.kg, 0) + ' kg', r.price ? money(r.price) : '—', r.active ? 'Fitted' : '—'], cellCls: [null, r.active ? (r.kg < 0 ? 'is-good' : r.kg > 0 ? 'is-bad' : null) : null, null, null] };
      });
      rows.push({ cls: 'is-total', cells: ['Net change', signed(lg.net_kg, 0) + ' kg', money(lg.cost), lg.saved_kg ? fmt(lg.saved_kg) + ' kg saved' : ''] });
      ledger.set(rows);
    });
    root.appendChild(ui.section('Weight ledger', 'Options on this page relative to the factory specification.', ledger));
  }

  /* ======================================================================
     REGISTRATION
     ====================================================================== */
  makePanel({ id: 'suspension', title: 'Suspension', subtitle: 'Springs, dampers, alignment and balance', order: 50, build: buildSuspension });
  makePanel({ id: 'brakes', title: 'Brakes', subtitle: 'Rotors, calipers and ABS', order: 60, build: buildBrakes });
  makePanel({ id: 'wheels', title: 'Wheels & Tyres', subtitle: 'Design, sizing, compounds and fitment', order: 70, build: buildWheels });
  makePanel({ id: 'aero', title: 'Aerodynamics', subtitle: 'Downforce, drag and aero balance', order: 80, build: buildAero });
  makePanel({ id: 'weight', title: 'Weight', subtitle: 'Mass reduction, safety and ballast', order: 90, build: buildWeight });

  // Pure SVG helpers exposed for other modules (renderer / garage cards may reuse the wheel faces).
  calc.svg = { wheelFace: wheelFace, wheelIcon: wheelIcon, suspensionIcon: suspensionIcon, brakeIcon: brakeIcon, compoundIcon: compoundIcon, rotorArt: rotorArt };
})();

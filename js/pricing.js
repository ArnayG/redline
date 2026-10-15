/* ==========================================================================
   FORGE Atelier — js/pricing.js
   CB.pricing : itemized MSRP, taxes & credits, finance / lease maths, build slot & insurance group.

   CB.pricing.compute(build, metrics?) -> {
     currency: 'USD',
     lines: [{ section, label, amount, path?, kind }],   // one line for EVERY selected option (0 = "Included")
     sections: { <section>: total },                     // section subtotals (sum of that section's lines)
     base,                // body-style base price (the 'base' section)
     options,             // subtotal - base
     subtotal,            // === sum(lines.amount)  (vehicle as configured, before fees/taxes/credits)
     destination,         // destination & delivery (enclosed transport for very expensive cars)
     gasGuzzlerTax,       // US-style gas-guzzler schedule by combined mpg (cars only; light trucks exempt)
     luxuryTax,           // 10% of the taxable value above $120,000
     evCredit,            // POSITIVE number subtracted from the total (clean-vehicle credit, MSRP-capped)
     msrp,                // subtotal + destination
     total,               // subtotal + destination + gasGuzzlerTax + luxuryTax - evCredit
     buildTime_weeks, buildTimeBreakdown: [{label, weeks}],
     insuranceGroup (1..50), insuranceFactors: [{label, points}],
     fuelEconomy_mpg, notes: [string]
   }
   Line sections are panel ids: base, body, engine, transmission, drivetrain, suspension, brakes, wheels
   (tyres included), aero, weight, exterior, interior, tech.

   CB.pricing.finance(total, { apr (% e.g. 6.9), months, down, tradeIn, taxRate (% e.g. 7.25), fees }) -> {
     monthly, principal, taxes, totalInterest, totalPaid, totalCost, apr, months,
     schedule: [{ month, payment, principal, interest, balance, cumulativeInterest, cumulativePrincipal }] }
       principal = total × (1 + taxRate%) + fees − down − tradeIn ; standard annuity; final payment absorbs rounding
       so the closing balance is exactly 0. totalCost = totalPaid + down + tradeIn.
   CB.pricing.lease(total, { months, residual_pct, moneyFactor, down, tradeIn, acquisitionFee, taxRate }) -> {
     monthly, residual, capCost, depreciation, financeCharge, tax, totalCost, dueAtSigning, apr, months, schedule }
   CB.pricing.optionDelta(build, path, value, metrics?) -> total(after) - total(before)
   CB.pricing.diff(buildA, buildB) -> [{ section, label, a, b, delta }]
   CB.pricing.constants
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  function D() { return CB.data; }
  function U() { return CB.util || {}; }
  function isObj(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
  function num(v, fb) { var n = Number(v); return isFinite(n) ? n : (fb === undefined ? 0 : fb); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function round(n) { return Math.round(n); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function get(o, path, fb) {
    var ks = String(path).split('.'), cur = o;
    for (var i = 0; i < ks.length; i++) { if (cur == null) return fb; cur = cur[ks[i]]; }
    return cur === undefined ? fb : cur;
  }
  function merge(a, b) {
    if (U().deepMerge) return U().deepMerge(a, b);
    var out = isObj(a) ? JSON.parse(JSON.stringify(a)) : {};
    Object.keys(b || {}).forEach(function (k) { out[k] = isObj(b[k]) && isObj(out[k]) ? merge(out[k], b[k]) : b[k]; });
    return out;
  }
  function find(coll, id) { var d = D(); return d && d.find ? d.find(coll, id) : undefined; }
  function money(n) { return U().fmtMoney ? U().fmtMoney(n) : '$' + Math.round(n); }
  function fmtN(n, d) { return U().fmtNum ? U().fmtNum(n, d || 0) : Number(n).toFixed(d || 0); }

  var TEMPLATE = null;
  function template() {
    if (!TEMPLATE && D() && D().defaultBuild) {
      TEMPLATE = D().defaultBuild();
      TEMPLATE.meta = { name: 'Untitled Build', id: 'b_template', created: 0, modified: 0, presetId: null };
    }
    return TEMPLATE || {};
  }

  var C = {
    destinationFee: 1995,
    enclosedTransport: 3500,          // added when the vehicle subtotal exceeds the threshold below
    enclosedThreshold: 250000,
    luxuryThreshold: 120000,
    luxuryRate: 0.10,
    evCredit: 7500,
    phevCredit: 3750,
    phevMinKwh: 7,
    creditCapCar: 55000,
    creditCapTruck: 80000,            // SUVs, vans, pickups
    gasGuzzlerExempt: ['suv', 'pickup', 'van'],
    // [min combined mpg, tax] — US IRS Form 6197 schedule
    gasGuzzler: [[22.5, 0], [21.5, 1000], [20.5, 1300], [19.5, 1700], [18.5, 2100], [17.5, 2600], [16.5, 3000],
      [15.5, 3700], [14.5, 4500], [13.5, 5400], [12.5, 6400], [0, 7700]],
    caliperStandard: ['#f2c200', '#111111', '#1a1a1a', '#2b2b2b', '#c0c0c0', '#b3121f', '#d40000'],
    customWheelbasePerMm: 12,
    wideTrackPerMm: 15,
    extraSeat: 0,                     // additional seat rows are included; deleting them earns a credit (weight panel)
    perLitre: 2500,
    boostPerBar: 2200,
    highCompression: 1400,
    redlinePer100: 350,
    gearPer: 350,
    customRatios: 1500,
    customFinalDrive: 450,
    geometrySetup: 650,
    raceSprings: 900,
    perHalfInchOver8: 120,
    tireSizeRef: { width: 245, diameter: 18 },
    tyreAllowance: 220               // per tyre, included in every base price
  };

  /* ======================================================================
     GAS-GUZZLER / ESTIMATES
     ====================================================================== */
  function gasGuzzlerFor(mpg) {
    if (mpg == null || !isFinite(mpg)) return 0;
    for (var i = 0; i < C.gasGuzzler.length; i++) if (mpg >= C.gasGuzzler[i][0]) return C.gasGuzzler[i][1];
    return C.gasGuzzler[C.gasGuzzler.length - 1][1];
  }
  function localEstimate(b) {
    // Minimal fallback when CB.rules is not loaded: rough hp & mpg.
    var e = b.engine || {}, layout = find('engineLayouts', e.layout) || { specificOutputNA_hpPerL: 100 };
    var asp = find('aspirations', e.aspiration) || { powerMult: 1 };
    var hp = e.type === 'ev' ? num(e.motors) * num(e.motorPower_kw) * 1.341 : num(e.displacement_l, 3) * num(layout.specificOutputNA_hpPerL, 100) * num(asp.powerMult, 1);
    if (e.type === 'hybrid') hp += num(e.motors) * num(e.motorPower_kw) * 1.14;
    var l100 = e.type === 'ev' ? null : (3 + num(e.displacement_l, 3) + hp / 150) * (e.type === 'hybrid' ? 0.62 : 1);
    return { hp: hp, mpg: l100 ? 235.215 / l100 : null, weight_kg: 1600, topSpeed_kph: 250 };
  }
  function estimate(b, metrics) {
    if (CB.rules && typeof CB.rules.estimate === 'function') {
      try { return CB.rules.estimate(b, metrics); } catch (e) { /* fall through */ }
    }
    var est = localEstimate(b);
    if (metrics) {
      if (isFinite(metrics.power_hp)) est.hp = metrics.power_hp;
      if (isFinite(metrics.fuelEconomy_mpg)) est.mpg = metrics.fuelEconomy_mpg;
      if (isFinite(metrics.weight_kg)) est.weight_kg = metrics.weight_kg;
      if (isFinite(metrics.topSpeed_kph)) est.topSpeed_kph = metrics.topSpeed_kph;
    }
    return est;
  }
  function metricsFor(b, metrics) {
    if (metrics) return metrics;
    if (CB.physics && typeof CB.physics.compute === 'function') {
      try { return CB.physics.compute(b); } catch (e) { return null; }
    }
    return null;
  }

  /* ======================================================================
     COMPUTE
     ====================================================================== */
  function compute(build, metrics) {
    var d = D();
    if (!d) return null;
    var b = merge(template(), isObj(build) ? build : {});
    var m = metricsFor(b, metrics || null);
    var est = estimate(b, m);
    var opts = d.options || {};
    var lines = [];
    var notes = [];
    function add(section, label, amount, path, kind) {
      lines.push({ section: section, label: label, amount: round(num(amount)), path: path || null, kind: kind || 'option' });
    }
    function opt(section, path, coll, label, scale) {
      var o = find(coll, get(b, path));
      if (!o) return null;
      add(section, (label ? label + ': ' : '') + o.name, num(o.price) * (scale == null ? 1 : scale), path);
      return o;
    }
    function flag(section, path, label, price) {
      if (get(b, path) === true) add(section, label, price, path, 'option');
    }

    var e = b.engine, type = e.type === 'ev' || e.type === 'hybrid' ? e.type : 'ice';
    var hasICE = type !== 'ev';
    var style = find('bodyStyles', b.body.style) || d.bodyStyles[0];

    /* ---- base & body */
    add('base', style.name + ' — base vehicle', num(style.basePrice), 'body.style', 'base');
    opt('body', 'body.chassisMaterial', 'chassisMaterials', 'Chassis');
    opt('body', 'body.construction', 'constructions', 'Construction');
    var wbDelta = Math.abs(num(b.body.wheelbase_mm, style.defaultWheelbase) - num(style.defaultWheelbase));
    add('body', wbDelta ? 'Bespoke wheelbase (' + fmtN(b.body.wheelbase_mm) + ' mm, ' + (b.body.wheelbase_mm > style.defaultWheelbase ? '+' : '−') + fmtN(wbDelta) + ' mm)' : 'Wheelbase ' + fmtN(b.body.wheelbase_mm) + ' mm (standard)',
      wbDelta * C.customWheelbasePerMm, 'body.wheelbase_mm', 'size');
    var twDelta = Math.max(0, num(b.body.trackWidth_mm, 1600) - 1600);
    add('body', twDelta ? 'Widened track (' + fmtN(b.body.trackWidth_mm) + ' mm)' : 'Track width ' + fmtN(b.body.trackWidth_mm) + ' mm', twDelta * C.wideTrackPerMm, 'body.trackWidth_mm', 'size');
    add('body', b.body.doors + '-door body', 0, 'body.doors');
    var minSeats = (style.seatOptions || [2])[0];
    var extraSeats = Math.max(0, num(b.body.seats, minSeats) - minSeats);
    add('body', b.body.seats + '-seat cabin' + (extraSeats ? ' (' + minSeats + '+' + extraSeats + ' seating)' : ''), extraSeats * C.extraSeat, 'body.seats');

    /* ---- engine */
    var et = find('engineTypes', type);
    if (et) add('engine', 'Drivetrain: ' + et.name, num(et.price), 'engine.type');
    if (hasICE) {
      var layout = find('engineLayouts', e.layout) || d.engineLayouts[0];
      add('engine', 'Engine: ' + layout.name, num(layout.basePrice != null ? layout.basePrice : layout.price), 'engine.layout');
      var extraL = Math.max(0, num(e.displacement_l) - layout.displacementRange[0]);
      add('engine', 'Displacement ' + fmtN(e.displacement_l, 1) + ' L' + (extraL > 0.001 ? ' (+' + fmtN(extraL, 1) + ' L over base)' : ''), extraL * C.perLitre, 'engine.displacement_l', 'size');
      var asp = find('aspirations', e.aspiration) || d.aspirations[0];
      add('engine', 'Induction: ' + asp.name, num(asp.price), 'engine.aspiration');
      if (asp.id !== 'na') {
        var extraBoost = Math.max(0, num(e.boost_bar) - num(asp.typicalBoost_bar));
        add('engine', 'Boost ' + fmtN(e.boost_bar, 2) + ' bar' + (extraBoost > 0.001 ? ' (uprated wastegate & intercooler)' : ''), extraBoost * C.boostPerBar, 'engine.boost_bar', 'size');
      }
      var hc = num(e.compression) >= 12.5 && (find('fuels', e.fuel) || {}).id !== 'diesel';
      add('engine', 'Compression ' + fmtN(e.compression, 1) + ':1' + (hc ? ' (high-compression forged pistons)' : ''), hc ? C.highCompression : 0, 'engine.compression');
      opt('engine', 'engine.fuel', 'fuels', 'Fuel calibration');
      var typRed = num(layout.typicalRedline, 7000);
      var extraRpm = Math.max(0, num(e.redline_rpm) - typRed);
      add('engine', 'Redline ' + fmtN(e.redline_rpm) + ' rpm' + (extraRpm ? ' (titanium valvetrain)' : ''), Math.ceil(extraRpm / 100) * C.redlinePer100, 'engine.redline_rpm', 'size');
      var pos = find('enginePositions', e.position);
      if (pos) add('engine', 'Engine position: ' + pos.name, num(pos.price), 'engine.position');
      opt('engine', 'engine.tune', 'tunes', 'Calibration');
      opt('engine', 'engine.exhaust', 'exhausts', 'Exhaust');
    } else {
      var pos2 = find('enginePositions', e.position);
      add('engine', 'Motor packaging: ' + (pos2 ? pos2.name : 'Integrated'), 0, 'engine.position');
      notes.push('Electric drivetrain: exhaust and fuel selections are ignored and not charged.');
    }
    opt('engine', 'engine.cooling', 'coolings', type === 'ev' ? 'Thermal management' : 'Cooling');
    if (num(e.speedLimiter_kph) > 0) opt('engine', 'engine.speedLimiter_kph', 'speedLimiters', 'Electronic speed limiter');
    if (type !== 'ice') {
      var motors = Math.max(1, Math.round(num(e.motors, 1)));
      var kw = num(e.motorPower_kw);
      add('engine', motors + ' × e-motor', motors * num(opts.perMotor, 4500), 'engine.motors');
      add('engine', 'Motor rating ' + fmtN(kw) + ' kW each (' + fmtN(motors * kw) + ' kW total)', motors * kw * num(opts.perMotorKw, 22), 'engine.motorPower_kw', 'size');
      var chem = find('batteryChemistries', e.chemistry) || d.batteryChemistries[0];
      add('engine', 'Battery ' + fmtN(e.battery_kwh, e.battery_kwh % 1 ? 1 : 0) + ' kWh ' + chem.name.split(' (')[0] + ' (' + money(chem.pricePerKwh) + '/kWh)', num(e.battery_kwh) * num(chem.pricePerKwh), 'engine.battery_kwh', 'size');
      add('engine', (num(e.voltage) >= 800 ? '800 V' : '400 V') + ' architecture', num(e.voltage) >= 800 ? num(opts.voltage800, 3500) : 0, 'engine.voltage');
      add('engine', 'Regeneration level ' + num(e.regen), 0, 'engine.regen');
    }

    /* ---- transmission */
    var tr = find('transmissions', b.transmission.type) || d.transmissions[0];
    add('transmission', 'Gearbox: ' + tr.name, num(tr.price), 'transmission.type');
    var gears = num(b.transmission.gears, tr.gearRange[0]);
    var refGears = tr.defaultRatios ? tr.defaultRatios().length : tr.gearRange[0];
    var extraGears = Math.max(0, gears - refGears);
    add('transmission', gears + (gears === 1 ? ' fixed ratio' : '-speed') + (extraGears ? ' (+' + extraGears + ' ratio' + (extraGears > 1 ? 's' : '') + ' over the ' + refGears + '-speed standard)' : ''), extraGears * C.gearPer, 'transmission.gears');
    var rs = b.transmission.ratios || [];
    function sameRatios(ref) { return ref.length === rs.length && rs.every(function (r, i) { return Math.abs(num(r) - num(ref[i])) <= 0.005; }); }
    var tplT = template().transmission || {};
    var custom = rs.length > 1 && !sameRatios(tr.defaultRatios ? tr.defaultRatios(gears) : []) &&
      !(tplT.type === tr.id && sameRatios(tplT.ratios || []));
    add('transmission', custom ? 'Bespoke gear ratio set' : 'Factory gear ratios', custom ? C.customRatios : 0, 'transmission.ratios');
    var fdCustom = Math.abs(num(b.transmission.finalDrive) - 3.42) > 0.005;
    add('transmission', 'Final drive ' + fmtN(b.transmission.finalDrive, 2) + ':1' + (fdCustom ? ' (alternative crown wheel)' : ''), fdCustom ? C.customFinalDrive : 0, 'transmission.finalDrive');
    flag('transmission', 'transmission.launchControl', 'Launch control', num(opts.launchControl, 900));

    /* ---- drivetrain */
    var dl = find('drivetrainLayouts', b.drivetrain.layout) || d.drivetrainLayouts[0];
    add('drivetrain', 'Layout: ' + dl.name, num(dl.price), 'drivetrain.layout');
    var frontDriven = dl.id === 'fwd' || dl.id === 'awd', rearDriven = dl.id === 'rwd' || dl.id === 'awd';
    if (frontDriven) opt('drivetrain', 'drivetrain.frontDiff', 'differentials', 'Front differential');
    if (rearDriven) opt('drivetrain', 'drivetrain.rearDiff', 'differentials', 'Rear differential');
    if (dl.id === 'awd') {
      var cdiff = find('differentials', b.drivetrain.centerDiff);
      if (cdiff) add('drivetrain', 'Centre coupling: ' + cdiff.name, num(cdiff.price) + (oneOf(cdiff.id, ['lsd-clutch', 'e-diff', 'locking']) ? num(opts.centerDiffUpgrade, 1200) : 0), 'drivetrain.centerDiff');
    }
    flag('drivetrain', 'drivetrain.torqueVectoring', 'Torque vectoring', num(opts.torqueVectoring, 2800));
    add('drivetrain', 'Traction control map ' + num(b.drivetrain.tractionControl) + '/3', 0, 'drivetrain.tractionControl');

    /* ---- suspension */
    var st = opt('suspension', 'suspension.type', 'suspensionTypes', 'Suspension');
    var s = b.suspension;
    var raceSprings = Math.max(num(s.springFront_nmm), num(s.springRear_nmm)) > 150;
    add('suspension', 'Springs ' + fmtN(s.springFront_nmm) + ' / ' + fmtN(s.springRear_nmm) + ' N/mm' + (raceSprings ? ' (race-rate springs)' : ''), raceSprings ? C.raceSprings : 0, 'suspension.springFront_nmm');
    var geom = Math.abs(num(s.camberFront_deg) + 1.5) > 0.05 || Math.abs(num(s.camberRear_deg) + 1.0) > 0.05 || Math.abs(num(s.toeFront_deg)) > 0.001 || Math.abs(num(s.toeRear_deg) - 0.1) > 0.001 ||
      num(s.arbFront) !== 5 || num(s.arbRear) !== 4 || num(s.damping) !== 5;
    add('suspension', geom ? 'Bespoke geometry, damping & anti-roll set-up' : 'Factory alignment', geom ? C.geometrySetup * (st && st.adjustable ? 0.5 : 1) : 0, 'suspension.camberFront_deg');

    /* ---- brakes */
    opt('brakes', 'brakes.material', 'brakeMaterials', 'Brakes');
    var br = b.brakes;
    var rotorExtra = Math.max(0, num(br.frontRotor_mm) - 330) + Math.max(0, num(br.rearRotor_mm) - 300) * 0.6;
    add('brakes', 'Rotors ' + fmtN(br.frontRotor_mm) + ' / ' + fmtN(br.rearRotor_mm) + ' mm', rotorExtra * num(opts.perRotorMm, 18), 'brakes.frontRotor_mm', 'size');
    var pistonExtra = (Math.max(0, num(br.frontPistons) - 4) + Math.max(0, num(br.rearPistons) - 2)) * 2;
    add('brakes', 'Calipers ' + br.frontPistons + '-piston front / ' + br.rearPistons + '-piston rear', pistonExtra * num(opts.perPiston, 220), 'brakes.frontPistons');
    var abs = find('absModes', br.abs);
    if (abs) add('brakes', abs.name, num(abs.price), 'brakes.abs');
    var cal = String(b.exterior.caliperColor || '').toLowerCase();
    var calCustom = C.caliperStandard.indexOf(cal) < 0;
    add('brakes', 'Caliper paint ' + cal + (calCustom ? ' (custom colour)' : ''), calCustom ? num(opts.customCaliper, 650) : 0, 'exterior.caliperColor');

    /* ---- wheels & tyres */
    var w = b.wheels, t = b.tires;
    var dia = num(w.diameter_in, 19);
    var sizeScale = Math.pow(dia / 19, 1.3);
    opt('wheels', 'wheels.design', 'wheelDesigns', 'Wheel design', sizeScale);
    var wm = find('wheelMaterials', w.material);
    if (wm) add('wheels', 'Wheel construction: ' + wm.name + ' (set of 4)', num(wm.price) * (num(wm.price) > 0 ? sizeScale : 1), 'wheels.material');
    add('wheels', dia + '" diameter', Math.max(0, dia - 17) * num(opts.perInchDiameter, 350), 'wheels.diameter_in', 'size');
    var halfInches = (Math.max(0, num(w.widthFront_in) - 8) + Math.max(0, num(w.widthRear_in) - 8)) * 2 * 2; // both wheels per axle, per 0.5"
    add('wheels', 'Rim widths ' + fmtN(w.widthFront_in, 1) + '" / ' + fmtN(w.widthRear_in, 1) + '"', halfInches * num(opts.perHalfInchWidth, 120) / 2, 'wheels.widthFront_in', 'size');
    if (w.staggered && num(w.widthRear_in) !== num(w.widthFront_in)) add('wheels', 'Staggered fitment', num(opts.staggeredWheels, 400), 'wheels.staggered');
    add('wheels', 'Wheel finish ' + String(w.finish || '').toLowerCase(), 0, 'wheels.finish');
    var comp = find('tireCompounds', t.compound) || d.tireCompounds[0];
    var tf = Math.pow(num(t.widthFront_mm) / C.tireSizeRef.width, 1.1) * Math.pow(dia / C.tireSizeRef.diameter, 1.2);
    var trr = Math.pow(num(t.widthRear_mm) / C.tireSizeRef.width, 1.1) * Math.pow(dia / C.tireSizeRef.diameter, 1.2);
    // The base price includes a set of Grand Touring tyres (4 x $220 at 245/18); tyre lines are the delta.
    var ref = C.tyreAllowance;
    var tyreLine = function (axle, width, profile, factor) {
      var amt = 2 * (num(comp.price) * factor - ref);
      add('wheels', 'Tyres (' + axle + '): ' + comp.name + ' ' + width + '/' + profile + ' R' + dia + ' ×2' + (amt < 0 ? ' — credit vs standard' : amt > 0 ? ' — upgrade' : ''), amt, axle === 'front' ? 'tires.widthFront_mm' : 'tires.widthRear_mm', amt < 0 ? 'credit' : 'size');
    };
    tyreLine('front', t.widthFront_mm, t.profileFront, tf);
    tyreLine('rear', t.widthRear_mm, t.profileRear, trr);
    opt('wheels', 'tires.speedRating', 'tireSpeedRatings', 'Tyre speed rating');

    /* ---- aero */
    opt('aero', 'aero.splitter', 'aero.splitters', 'Splitter');
    var wing = opt('aero', 'aero.wing', 'aero.wings', 'Wing');
    opt('aero', 'aero.diffuser', 'aero.diffusers', 'Diffuser');
    flag('aero', 'aero.canards', 'Carbon canards', num(opts.canards, 1800));
    flag('aero', 'aero.sideSkirts', 'Side skirts', num(opts.sideSkirts, 1400));
    if (b.aero.activeAero) add('aero', wing && wing.active ? 'Active aero control (included with active wing)' : 'Active aero flaps', wing && wing.active ? 0 : num(opts.activeAero, 8500), 'aero.activeAero');

    /* ---- weight */
    var wt = b.weight;
    if (wt.soundDeadening === false) add('weight', 'Sound-deadening delete', num(opts.soundDeadeningDelete, -200), 'weight.soundDeadening', 'credit');
    var hasRearBench = (style.seatOptions || []).some(function (x) { return x > 2; });
    if (wt.rearSeats === false && hasRearBench) add('weight', 'Rear-seat delete', num(opts.rearSeatDelete, -500), 'weight.rearSeats', 'credit');
    flag('weight', 'weight.spareTire', 'Space-saver spare wheel', num(opts.spareTire, 250));
    opt('weight', 'weight.glass', 'glassTypes', 'Glazing');
    opt('weight', 'weight.battery', 'batteryTypes', '12V battery');
    opt('weight', 'weight.rollCage', 'rollCages', 'Roll cage');
    if (num(wt.ballast_kg) > 0) add('weight', 'Tungsten ballast ' + fmtN(wt.ballast_kg) + ' kg (' + wt.ballastPosition + ')', num(wt.ballast_kg) * num(opts.ballastPerKg, 6), 'weight.ballast_kg', 'size');

    /* ---- exterior */
    var x = b.exterior;
    var swatch = d.swatchName ? d.swatchName(x.paint) : null;
    add('exterior', 'Paint: ' + (swatch || 'Paint-to-sample ' + String(x.paint).toLowerCase()), swatch ? 0 : num(opts.customPaint, 2500), 'exterior.paint');
    opt('exterior', 'exterior.finish', 'paintFinishes', 'Finish');
    opt('exterior', 'exterior.roof', 'roofTypes', 'Roof');
    var stripe = opt('exterior', 'exterior.stripe', 'stripes', 'Stripe');
    if (stripe && stripe.id !== 'none' && !(d.swatchName && d.swatchName(x.stripeColor)) && String(x.stripeColor).toLowerCase() !== '#ffffff' && String(x.stripeColor).toLowerCase() !== '#111111') {
      add('exterior', 'Custom stripe colour', 450, 'exterior.stripeColor');
    }
    add('exterior', 'Window tint ' + num(x.windowTint_pct) + '%', num(x.windowTint_pct) * num(opts.windowTintPerPct, 8), 'exterior.windowTint_pct', 'size');
    opt('exterior', 'exterior.lights', 'lightTypes', 'Headlamps');
    opt('exterior', 'exterior.mirrors', 'mirrorTypes', 'Mirror caps');
    opt('exterior', 'exterior.badge', 'badgeTypes', 'Badging');
    if (x.livery_number) add('exterior', 'Race number #' + x.livery_number + ' livery', num(opts.liveryNumber, 600), 'exterior.livery_number');

    /* ---- interior */
    var n = b.interior;
    var seatScale = Math.max(1, num(b.body.seats, 2) / 4);
    opt('interior', 'interior.seatType', 'seatTypes', 'Seats', seatScale);
    opt('interior', 'interior.upholstery', 'upholsteries', 'Upholstery', seatScale);
    opt('interior', 'interior.trim', 'trims', 'Trim');
    opt('interior', 'interior.steering', 'steeringTypes', 'Steering wheel');
    opt('interior', 'interior.headliner', 'headliners', 'Headliner');
    add('interior', 'Colours: primary ' + String(n.primaryColor).toLowerCase() + ', accent ' + String(n.accentColor).toLowerCase() + ', stitching ' + String(n.stitchColor).toLowerCase(), 0, 'interior.primaryColor');
    flag('interior', 'interior.ambientLighting', 'Ambient lighting', num(opts.ambientLighting, 500));
    flag('interior', 'interior.harness', 'Six-point harnesses', num(opts.harness, 1200));

    /* ---- tech */
    var tc = b.tech;
    opt('tech', 'tech.screen_in', 'screenSizes', 'Centre screen');
    flag('tech', 'tech.digitalCluster', 'Digital instrument cluster', num(opts.digitalCluster, 900));
    flag('tech', 'tech.hud', 'Head-up display', num(opts.hud, 1400));
    opt('tech', 'tech.audio', 'audioSystems', 'Audio');
    opt('tech', 'tech.adas', 'adasLevels', 'Driver assistance');
    var zones = Math.max(1, Math.round(num(tc.climateZones, 1)));
    add('tech', zones + '-zone climate control', (zones - 1) * num(opts.perClimateZone, 650), 'tech.climateZones');
    flag('tech', 'tech.telemetry', 'Track telemetry logger', num(opts.telemetry, 2400));
    flag('tech', 'tech.liftSystem', 'Front-axle lift system', num(opts.liftSystem, 3200));
    flag('tech', 'tech.nightVision', 'Night vision', num(opts.nightVision, 2600));

    /* ---- totals */
    var sections = {};
    var subtotal = 0;
    lines.forEach(function (l) { subtotal += l.amount; sections[l.section] = (sections[l.section] || 0) + l.amount; });
    var base = sections.base || 0;
    var destination = num(get(d, 'constants.destinationFee'), C.destinationFee) + (subtotal > C.enclosedThreshold ? C.enclosedTransport : 0);
    if (subtotal > C.enclosedThreshold) notes.push('Enclosed single-car transport and white-glove handover included in destination.');
    var mpg = hasICE ? est.mpg : null;
    var gas = 0;
    if (hasICE && C.gasGuzzlerExempt.indexOf(style.id) < 0) {
      gas = gasGuzzlerFor(mpg);
      if (gas) notes.push('Gas-guzzler tax: combined ' + fmtN(mpg, 1) + ' mpg is below 22.5 mpg.');
    } else if (hasICE) notes.push('Light-truck body (' + style.name + ') is exempt from the gas-guzzler tax.');
    var msrp = subtotal + destination;
    var luxury = Math.max(0, msrp - C.luxuryThreshold) * C.luxuryRate;
    if (luxury) notes.push('Luxury tax: ' + Math.round(C.luxuryRate * 100) + '% of ' + money(msrp - C.luxuryThreshold) + ' above ' + money(C.luxuryThreshold) + '.');
    var credit = 0;
    var capLimit = C.gasGuzzlerExempt.indexOf(style.id) >= 0 ? C.creditCapTruck : C.creditCapCar;
    var eligibleType = type === 'ev' || (type === 'hybrid' && num(e.battery_kwh) >= C.phevMinKwh);
    if (eligibleType) {
      if (msrp <= capLimit) {
        credit = type === 'ev' ? C.evCredit : C.phevCredit;
        notes.push((type === 'ev' ? 'Clean-vehicle credit' : 'Plug-in hybrid credit') + ' of ' + money(credit) + ' applied (MSRP within the ' + money(capLimit) + ' cap).');
      } else {
        notes.push('No clean-vehicle credit: MSRP ' + money(msrp) + ' exceeds the ' + money(capLimit) + ' cap.');
      }
    }
    var total = subtotal + destination + gas + luxury - credit;

    var bt = buildTime(b, style);
    var ins = insurance(b, est, total, style);

    return {
      currency: 'USD',
      lines: lines,
      sections: sections,
      base: base,
      options: subtotal - base,
      subtotal: subtotal,
      destination: destination,
      gasGuzzlerTax: gas,
      luxuryTax: round(luxury),
      evCredit: credit,
      msrp: msrp,
      total: round(total),
      buildTime_weeks: bt.weeks,
      buildTimeBreakdown: bt.breakdown,
      insuranceGroup: ins.group,
      insuranceFactors: ins.factors,
      fuelEconomy_mpg: mpg != null ? round2(mpg) : null,
      notes: notes
    };
  }
  function oneOf(v, list) { return list.indexOf(v) >= 0; }

  /* ======================================================================
     BUILD SLOT
     ====================================================================== */
  function buildTime(b, style) {
    var parts = [];
    function w(label, weeks) { if (weeks) parts.push({ label: label, weeks: weeks }); }
    w('Production slot & assembly', 6);
    w('Hypercar hand assembly', style.id === 'hypercar' ? 10 : 0);
    w('Coachbuilt body', style.id === 'shooting-brake' ? 3 : 0);
    w('Chassis', { aluminum: 2, 'carbon-tub': 6, 'carbon-monocoque': 12 }[b.body.chassisMaterial] || 0);
    if (b.engine.type !== 'ev') {
      w('Engine build', { V10: 3, V12: 5, W16: 14, 'rotary-2': 2, 'flat-6': 1 }[b.engine.layout] || 0);
      w('Forced induction', { 'quad-turbo': 3, twincharged: 2, 'electric-turbo': 2 }[b.engine.aspiration] || 0);
      w('Calibration & dyno', { stage3: 2, 'time-attack': 4, stage2: 1 }[b.engine.tune] || 0);
    }
    if (b.engine.type !== 'ice') w('Battery pack', b.engine.chemistry === 'solid-state' ? 6 : (num(b.engine.battery_kwh) > 120 ? 2 : 1));
    w('Sequential gearbox', b.transmission.type === 'sequential' ? 2 : 0);
    w('Suspension', { pushrod: 3, magnetic: 1, air: 1 }[b.suspension.type] || 0);
    w('Carbon-ceramic brakes', b.brakes.material === 'carbon-ceramic' ? 1 : 0);
    w('Wheels', { magnesium: 3, carbon: 4, forged: 1 }[b.wheels.material] || 0);
    w('Roll cage', { half: 1, full: 3 }[b.weight.rollCage] || 0);
    w('Paint', { pearl: 1, matte: 2, satin: 1, chrome: 6, candy: 3, chameleon: 5 }[b.exterior.finish] || 0);
    var d = D();
    w('Paint-to-sample colour', d.swatchName && !d.swatchName(b.exterior.paint) ? 2 : 0);
    w('Hand-applied livery', { pinstripe: 2, gradient: 2, 'le-mans': 1 }[b.exterior.stripe] || 0);
    w('Leatherwork', { 'semi-aniline': 6, nappa: 2, 'carbon-weave': 2 }[b.interior.upholstery] || 0);
    w('Interior trim', { 'gloss-walnut': 2, 'open-pore-wood': 1, 'forged-carbon': 2, 'brushed-titanium': 3 }[b.interior.trim] || 0);
    w('Autonomy validation', b.tech.adas === 'autonomous-l3' ? 2 : 0);
    w('Concert Hall acoustic tuning', b.tech.audio === 'concert' ? 1 : 0);
    var total = parts.reduce(function (a, p) { return a + p.weeks; }, 0);
    return { weeks: clamp(Math.round(total), 4, 60), breakdown: parts };
  }

  /* ======================================================================
     INSURANCE GROUP (1..50)
     ====================================================================== */
  function insurance(b, est, price, style) {
    var f = [];
    function p(label, pts) { if (pts) f.push({ label: label, points: Math.round(pts * 10) / 10 }); }
    p('Base', 2);
    p('Power (' + fmtN(est.hp) + ' hp)', Math.min(22, num(est.hp) / 1000 * 20));
    var pw = num(est.hp) / Math.max(0.6, num(est.weight_kg, 1600) / 1000);
    p('Power-to-weight', clamp((pw - 150) / 60, 0, 6));
    p('Vehicle value', clamp(Math.log(Math.max(1, price) / 30000) / Math.LN2 * 3.2, 0, 16));
    p('Body style', { hypercar: 3, roadster: 1.5, coupe: 1, 'shooting-brake': 0.5, suv: -1, wagon: -1, van: -2, sedan: -0.5 }[style.id] || 0);
    p('Exotic structure repair', { 'carbon-tub': 2, 'carbon-monocoque': 3, aluminum: 1 }[b.body.chassisMaterial] || 0);
    var tune = find('tunes', b.engine.tune);
    if (b.engine.type !== 'ev' && tune) p('Engine modifications', num(tune.reliabilityHit) * 12);
    p('Track equipment', (b.tires.compound === 'slick' ? 2 : 0) + (b.engine.exhaust === 'straight-pipe' && b.engine.type !== 'ev' ? 1.5 : 0) + (b.brakes.abs === 'off' ? 2.5 : 0) + (num(b.drivetrain.tractionControl) === 0 ? 1 : 0));
    p('Driver assistance', { none: 1, assist: -1, plus: -2, pilot: -2.5, 'autonomous-l3': -3 }[b.tech.adas] || 0);
    p('Expensive components', (b.brakes.material === 'carbon-ceramic' ? 1 : 0) + (oneOf(b.wheels.material, ['carbon', 'magnesium']) ? 1 : 0) + (oneOf(b.exterior.finish, ['chrome', 'chameleon']) ? 1 : 0));
    p('Visibility & lighting', b.exterior.lights === 'halogen' ? 0.5 : 0);
    p('Theft risk (badge delete sleeper)', b.exterior.badge === 'delete' ? -0.5 : 0);
    var total = f.reduce(function (a, x) { return a + x.points; }, 0);
    return { group: clamp(Math.round(total), 1, 50), factors: f };
  }

  /* ======================================================================
     FINANCE (amortizing loan)
     ====================================================================== */
  function finance(total, o) {
    o = o || {};
    var price = Math.max(0, num(total));
    var taxRate = Math.max(0, num(o.taxRate, 0)) / 100;
    var down = Math.max(0, num(o.down, 0)), trade = Math.max(0, num(o.tradeIn, 0)), fees = Math.max(0, num(o.fees, 0));
    var taxes = price * taxRate;
    var principal = Math.max(0, price + taxes + fees - down - trade);
    var n = Math.max(1, Math.round(num(o.months, 60)));
    var apr = Math.max(0, num(o.apr, 0));
    var r = apr / 100 / 12;
    var monthly = principal === 0 ? 0 : r === 0 ? principal / n : principal * r / (1 - Math.pow(1 + r, -n));
    var schedule = [], bal = principal, cumI = 0, cumP = 0, paid = 0;
    for (var i = 1; i <= n; i++) {
      var interest = bal * r;
      var pay = monthly, prin = pay - interest;
      if (i === n) { prin = bal; pay = prin + interest; } // final payment closes the loan exactly
      bal = Math.max(0, bal - prin);
      if (bal < 1e-7) bal = 0;
      cumI += interest; cumP += prin; paid += pay;
      schedule.push({ month: i, payment: pay, principal: prin, interest: interest, balance: bal, cumulativeInterest: cumI, cumulativePrincipal: cumP });
    }
    return {
      monthly: monthly, principal: principal, taxes: taxes, fees: fees, down: down, tradeIn: trade,
      totalInterest: cumI, totalPaid: paid, totalCost: paid + down + trade,
      apr: apr, months: n, schedule: schedule
    };
  }

  /* ======================================================================
     LEASE
     ====================================================================== */
  function lease(total, o) {
    o = o || {};
    var price = Math.max(0, num(total));
    var n = Math.max(1, Math.round(num(o.months, 36)));
    var residualPct = clamp(num(o.residual_pct, 55), 0, 100);
    var mf = Math.max(0, num(o.moneyFactor, 0.0025));
    var down = Math.max(0, num(o.down, 0)), trade = Math.max(0, num(o.tradeIn, 0)), fee = Math.max(0, num(o.acquisitionFee, 0));
    var taxRate = Math.max(0, num(o.taxRate, 0)) / 100;
    var residual = price * residualPct / 100;
    var capCost = Math.max(0, price + fee - down - trade);
    var depreciation = Math.max(0, (capCost - residual) / n);
    var financeCharge = (capCost + residual) * mf;
    var pre = depreciation + financeCharge;
    var tax = pre * taxRate;
    var monthly = pre + tax;
    var schedule = [], value = capCost;
    for (var i = 1; i <= n; i++) {
      value = Math.max(residual, value - depreciation);
      schedule.push({ month: i, payment: monthly, depreciation: depreciation, financeCharge: financeCharge, tax: tax, bookValue: value });
    }
    return {
      monthly: monthly, residual: residual, residual_pct: residualPct, capCost: capCost, depreciation: depreciation,
      financeCharge: financeCharge, tax: tax, moneyFactor: mf, apr: mf * 2400, months: n,
      dueAtSigning: down + monthly, totalCost: monthly * n + down + trade, buyout: residual, schedule: schedule
    };
  }

  /* ======================================================================
     HELPERS
     ====================================================================== */
  function setPath(o, path, v) {
    if (U().set) return U().set(o, path, v);
    var c = JSON.parse(JSON.stringify(o)), ks = path.split('.'), cur = c;
    for (var i = 0; i < ks.length - 1; i++) cur = cur[ks[i]];
    cur[ks[ks.length - 1]] = v; return c;
  }
  function optionDelta(build, path, value, metrics) {
    var before = compute(build, metrics);
    var nb = setPath(build, path, value);
    if (CB.state && CB.state.normalize) { try { nb = CB.state.normalize(nb, { paths: [path], prev: build }); } catch (e) { /* raw */ } }
    var after = compute(nb, null);
    return before && after ? after.total - before.total : 0;
  }
  function diff(a, b) {
    var pa = compute(a), pb = compute(b);
    if (!pa || !pb) return [];
    function key(l) { return l.section + '|' + (l.path || l.label); }
    var map = {}, order = [];
    pa.lines.forEach(function (l) { var k = key(l); if (!map[k]) { map[k] = { section: l.section, label: l.label, a: 0, b: 0 }; order.push(k); } map[k].a += l.amount; });
    pb.lines.forEach(function (l) { var k = key(l); if (!map[k]) { map[k] = { section: l.section, label: l.label, a: 0, b: 0 }; order.push(k); } map[k].b += l.amount; map[k].labelB = l.label; });
    return order.map(function (k) { var x = map[k]; x.delta = x.b - x.a; return x; })
      .filter(function (x) { return x.delta !== 0 || (x.labelB != null && x.labelB !== x.label); });
  }

  CB.pricing = {
    compute: compute,
    finance: finance,
    lease: lease,
    optionDelta: optionDelta,
    diff: diff,
    gasGuzzlerFor: gasGuzzlerFor,
    constants: C
  };
})();

if (typeof module !== 'undefined') module.exports = CB.pricing;

/* ==========================================================================
   REDLINE Garage — js/tune.js
   CB.tune : the Simple Garage's "few choices per subsystem" model. Pure (no DOM): runs in the browser and in Node.

   Every simple choice (a LEVEL of a SYSTEM, e.g. engine: Stock / Street / Sport / Race / Max) maps onto the ordinary
   build schema (CB.state), so physics, rules, pricing, career costs, share links, saved builds, AI copies, presets
   and Auto-config keep working unchanged. Levels are relative to the car's BASELINE: the factory (stock) build of
   the real model the build shows (CB.stock), or the default build at that model's real dimensions.

   A system OWNS a set of build paths; a level is a function (build, baseline) -> patch over (a subset of) those
   paths. Applying a level = deep-merge + CB.state.normalize (ctx = the patched paths) + an error-only auto-fix that
   prefers fixes outside the owned paths (so the build is always rule-legal). Detection compares the owned paths of
   a build against what each level would produce for that same build: the first match is the level, otherwise
   'custom' with the nearest level.

   API
     CATEGORIES                          [{ id, title, short, desc, icon, sections:[advanced panel ids], systems:[ids] }]
     SYSTEMS / system(id)                { id, title, desc, owns:[paths], levels:[{id,name,desc}] , kind:'levels'|'choices'|'slider' }
     categoryOf(panelId)                 simple category id holding an advanced panel
     baseline(build)                     the factory build the levels are relative to
     levels(sysId, build)                levels available for this build (+ factory flag)
     available(sysId, build)             true | 'reason'
     patch(sysId, levelId, build)        partial build for that level (null if unknown)
     target(sysId, levelId, build)       normalized build with the patch (no auto-fix)
     apply(sysId, levelId, build, opts)  { build, fixes:[labels], errors:[issues], achieved, legal, streetLegal }
     detect(sysId, build)                { id: levelId|'custom', nearest, matches:[ids], exact }
     options(sysId, build, opts)         UI rows: level + apply result + preview deltas + lock + price delta (cached)
     preview(from, to)                   { power_hp, zeroTo100_s, topSpeed_kph, lateralG, handling, weight_kg, price } deltas
     metricsOf(build)                    { metrics, price, legal } (cached)
     choose(sysId, levelId, opts)        apply to CB.state as ONE undo step; returns the apply() result
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  function U() { return CB.util; }
  function D() { return CB.data; }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d === undefined ? 0 : d); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function r(v, step) { step = step || 1; return Math.round(v / step) * step; }
  function round2(v) { return Math.round(v * 100) / 100; }
  function get(o, p) { return p.split('.').reduce(function (c, k) { return c == null ? undefined : c[k]; }, o); }
  function put(o, p, v) {
    var k = p.split('.'), c = o;
    for (var i = 0; i < k.length - 1; i++) { if (!c[k[i]] || typeof c[k[i]] !== 'object') c[k[i]] = {}; c = c[k[i]]; }
    c[k[k.length - 1]] = v;
    return o;
  }
  function find(coll, id) { var d = D(); return d && d.find ? d.find(coll, id) : null; }
  function clone(o) { return U().deepClone(o); }
  function range(path) { var d = D(); return (d && d.ranges && d.ranges[path]) || null; }
  function inRange(path, v) { var rg = range(path); return rg ? clamp(v, rg.min, rg.max) : v; }
  function normalize(b, ctx) { return CB.state && CB.state.normalize ? CB.state.normalize(b, ctx) : b; }
  function leafPaths(o) {
    if (CB.state && CB.state.leafPaths) return CB.state.leafPaths(o);
    var out = [];
    (function walk(x, pre) { Object.keys(x).forEach(function (k) { var p = pre ? pre + '.' + k : k; if (U().isPlainObject(x[k])) walk(x[k], p); else out.push(p); }); })(o, '');
    return out;
  }
  function eqVal(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
    return U().equal(a, b);
  }

  /* ---------------------------------------------------------------- baseline (factory build of the model) */
  var baseCache = {};
  function modelId(build) {
    var m = CB.state && CB.state.modelOf ? (function () { try { return CB.state.modelOf(build); } catch (e) { return null; } })() : null;
    return m ? m.id : null;
  }
  function baseline(build) {
    var id = modelId(build);
    var key = id || ('style:' + get(build, 'body.style'));
    if (baseCache[key]) return baseCache[key];
    var b = null;
    if (id && CB.stock && typeof CB.stock.spec === 'function' && CB.stock.spec(id)) {
      try { var res = CB.stock.build(id); b = res && res.build; } catch (e) { b = null; }
    }
    if (!b) {
      var def = clone(D().defaultBuild());
      def.body.style = get(build, 'body.style') || def.body.style;
      def.body.model = id;
      var dims = CB.state && CB.state.realDims ? CB.state.realDims(def) : null;
      b = normalize(dims ? U().deepMerge(def, dims) : def);
    }
    baseCache[key] = b;
    return b;
  }

  /* ---------------------------------------------------------------- helpers per system */
  var COOL_ORDER = ['standard', 'uprated', 'race'];
  function atLeastCooling(cur, min) { return COOL_ORDER.indexOf(cur) >= COOL_ORDER.indexOf(min) ? cur : min; }
  function isEV(b) { return get(b, 'engine.type') === 'ev'; }
  function maxRotorFor(b) { return Math.floor((num(get(b, 'wheels.diameter_in'), 19) * 25.4 - 60) / 2) * 2; }

  /** Fit boost / fuel / compression under the fuel's knock limit (keeps a 0.3-point margin). */
  function fitKnock(e, allowRaceFuel) {
    var fuel = find('fuels', e.fuel);
    if (!fuel || fuel.id === 'diesel') return e;
    var boost = e.aspiration === 'na' ? 0 : num(e.boost_bar);
    function eff() { return num(e.compression) * Math.sqrt(1 + boost); }
    var lim = num(fuel.knockLimit, 15) - 0.3;
    if (eff() <= lim) return e;
    if (allowRaceFuel && e.fuel !== 'race') { e.fuel = 'race'; lim = num(find('fuels', 'race').knockLimit, 20) - 0.3; if (eff() <= lim) return e; }
    if (boost > 0) {
      var nb = Math.floor((Math.pow(lim / num(e.compression), 2) - 1) * 20) / 20;
      if (nb >= 0.2) { e.boost_bar = nb; return e; }
      e.boost_bar = boost = Math.max(0.2, boost);
    }
    e.compression = Math.floor(lim / Math.sqrt(1 + boost) * 10) / 10;
    return e;
  }

  var ENGINE_MULT = [1, 1, 1.1, 1.2, 1.3];        // boost multipliers per engine level
  var MOTOR_MULT = [1, 1.1, 1.25, 1.4, 1.6];      // EV / hybrid motor power multipliers
  function enginePatch(i, x, B) {
    var e = clone(B.engine);
    var diesel = e.fuel === 'diesel';
    if (e.type !== 'ev') {
      e.tune = [B.engine.tune, 'stage1', 'stage2', 'stage3', diesel ? 'stage3' : 'time-attack'][i];
      if (i === 1 || i === 2) e.exhaust = B.engine.exhaust === 'stock' ? 'sport' : B.engine.exhaust;
      if (i === 3) e.exhaust = 'titanium';
      if (i === 4) e.exhaust = 'straight-pipe';
      e.cooling = [B.engine.cooling, B.engine.cooling, atLeastCooling(B.engine.cooling, 'uprated'), atLeastCooling(B.engine.cooling, 'uprated'), 'race'][i];
      var asp = find('aspirations', e.aspiration);
      if (e.aspiration !== 'na' && asp) e.boost_bar = Math.min(num(asp.maxBoost_bar, 2), r(num(e.boost_bar) * ENGINE_MULT[i], 0.05));
      else if (i === 4 && !diesel) { e.aspiration = 'supercharged'; e.boost_bar = 0.6; e.compression = Math.min(num(e.compression), 10.5); }
      if (i >= 2 && e.fuel === 'regular') e.fuel = 'premium';
      if (i >= 1) fitKnock(e, i >= 3);
      e.boost_bar = round2(e.boost_bar);
    } else {
      e.cooling = [B.engine.cooling, B.engine.cooling, atLeastCooling(B.engine.cooling, 'uprated'), atLeastCooling(B.engine.cooling, 'uprated'), 'race'][i];
    }
    if (e.type !== 'ice') e.motorPower_kw = inRange('engine.motorPower_kw', r(num(B.engine.motorPower_kw) * MOTOR_MULT[i], 5));
    if (i >= 2) e.speedLimiter_kph = 0;
    return { engine: e };
  }

  var GEARBOX_FAMILY = { manual: ['manual'], auto: ['auto', 'cvt'], dct: ['dct'], sequential: ['sequential'] };
  function familyOf(type) { for (var f in GEARBOX_FAMILY) if (GEARBOX_FAMILY[f].indexOf(type) >= 0) return f; return null; }
  function gearboxPatch(fam, x, B) {
    if (familyOf(B.transmission.type) === fam && B.engine.type === x.engine.type) {
      return { transmission: { type: B.transmission.type, gears: B.transmission.gears, ratios: B.transmission.ratios.slice() } };
    }
    var t = find('transmissions', fam);
    var ratios = t.defaultRatios();
    return { transmission: { type: fam, gears: ratios.length, ratios: ratios } };
  }

  var GEARING = [1.16, 1.08, 1, 0.93, 0.86];
  function gearingPatch(i, x, B) {
    return { transmission: { finalDrive: round2(inRange('transmission.finalDrive', num(B.transmission.finalDrive, 3.42) * GEARING[i])) } };
  }

  function drivePatch(layout, x, B) {
    if (B.drivetrain.layout === layout) {
      var d = B.drivetrain;
      return { drivetrain: { layout: d.layout, frontDiff: d.frontDiff, rearDiff: d.rearDiff, centerDiff: d.centerDiff, torqueSplitFront_pct: d.torqueSplitFront_pct } };
    }
    if (layout === 'fwd') return { drivetrain: { layout: 'fwd', frontDiff: 'lsd-torsen', rearDiff: 'none', centerDiff: 'none', torqueSplitFront_pct: 100 } };
    if (layout === 'rwd') return { drivetrain: { layout: 'rwd', frontDiff: 'none', rearDiff: 'lsd-clutch', centerDiff: 'none', torqueSplitFront_pct: 0 } };
    return { drivetrain: { layout: 'awd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'lsd-torsen', torqueSplitFront_pct: get(x, 'engine.position') === 'front' ? 40 : 30 } };
  }

  var SUSP = {
    comfort: { spring: 0.72, damping: -2, ride: 15, arb: -1.5, camberF: -0.6, camberR: -0.5, toeF: 0.05, toeR: 0.15 },
    sport: { spring: 1.3, damping: 1.5, ride: -12, arb: 1.5, camberF: -1.8, camberR: -1.4, toeF: 0, toeR: 0.15 },
    track: { spring: 2.0, damping: 3, ride: -28, arb: 3, camberF: -3.0, camberR: -2.2, toeF: -0.1, toeR: 0.2 }
  };
  var TRACK_TYPES = ['coilover-track', 'pushrod'];
  function suspensionPatch(id, x, B) {
    var s = clone(B.suspension);
    if (id === 'factory') return { suspension: s };
    var p = SUSP[id];
    if (id === 'comfort' && TRACK_TYPES.indexOf(s.type) >= 0) s.type = 'magnetic';
    if (id === 'track' && TRACK_TYPES.indexOf(s.type) < 0) s.type = 'coilover-track';
    var st = find('suspensionTypes', s.type), rr = (st && st.rideHeightRange) || [50, 300];
    s.springFront_nmm = r(inRange('suspension.springFront_nmm', num(B.suspension.springFront_nmm) * p.spring), 1);
    s.springRear_nmm = r(inRange('suspension.springRear_nmm', num(B.suspension.springRear_nmm) * p.spring), 1);
    s.damping = inRange('suspension.damping', r(num(B.suspension.damping) + p.damping, 1));
    s.rideHeight_mm = clamp(r(num(B.suspension.rideHeight_mm) + p.ride, 1), rr[0], rr[1]);
    s.arbFront = inRange('suspension.arbFront', r(num(B.suspension.arbFront) + p.arb, 1));
    s.arbRear = inRange('suspension.arbRear', r(num(B.suspension.arbRear) + p.arb, 1));
    s.camberFront_deg = p.camberF; s.camberRear_deg = p.camberR; s.toeFront_deg = p.toeF; s.toeRear_deg = p.toeR;
    return { suspension: s };
  }

  var TYRES = [
    { id: 'comfort', compound: 'touring', family: ['eco', 'all-season', 'winter', 'touring'] },
    { id: 'street', compound: 'performance', family: ['performance'] },
    { id: 'sport', compound: 'super-sport', family: ['super-sport'] },
    { id: 'semi', compound: 'track', family: ['track'] },
    { id: 'slick', compound: 'slick', family: ['slick'] }
  ];
  function tyresPatch(id, x, B) {
    var t = TYRES.filter(function (y) { return y.id === id; })[0];
    var c = t.family.indexOf(B.tires.compound) >= 0 ? B.tires.compound : t.compound;
    return { tires: { compound: c } };
  }

  var BRAKES = {
    sport: { material: 'drilled-slotted', front: 350, rear: 330, fp: 6, rp: 4, abs: 'sport' },
    race: { material: 'two-piece', front: 380, rear: 350, fp: 6, rp: 4, abs: 'race' },
    carbon: { material: 'carbon-ceramic', front: 400, rear: 380, fp: 10, rp: 4, abs: 'race' }
  };
  var BRAKE_ORDER = ['iron', 'drilled-slotted', 'two-piece', 'carbon-ceramic'];
  function brakesPatch(id, x, B) {
    var b = clone(B.brakes);
    if (id === 'factory') return { brakes: b };
    var p = BRAKES[id], max = maxRotorFor(x);
    if (BRAKE_ORDER.indexOf(b.material) < BRAKE_ORDER.indexOf(p.material)) b.material = p.material;
    b.frontRotor_mm = Math.max(num(B.brakes.frontRotor_mm), Math.min(p.front, max));
    b.rearRotor_mm = Math.max(num(B.brakes.rearRotor_mm), Math.min(p.rear, max));
    b.frontPistons = Math.max(num(B.brakes.frontPistons), p.fp);
    b.rearPistons = Math.max(num(B.brakes.rearPistons), p.rp);
    b.abs = p.abs;
    return { brakes: b };
  }

  function downforceOf(a) {
    var d = 0;
    [['aero.splitters', a.splitter], ['aero.wings', a.wing], ['aero.diffusers', a.diffuser]].forEach(function (p) { var o = find(p[0], p[1]); if (o) d += num(o.downforce_kg_at_200); });
    return d;
  }
  var AERO_IDS = ['off', 'low', 'medium', 'high'];
  function aeroFamily(a) { var d = downforceOf(a); return d < 25 ? 'off' : d < 90 ? 'low' : d < 200 ? 'medium' : 'high'; }
  var AERO = {
    off: { splitter: 'none', wing: 'none', wingAngle_deg: 6, diffuser: 'none', canards: false, sideSkirts: false, activeAero: false },
    low: { splitter: 'lip', wing: 'lip-spoiler', wingAngle_deg: 6, diffuser: 'mild', canards: false, sideSkirts: false, activeAero: false },
    medium: { splitter: 'carbon', wing: 'swan-neck', wingAngle_deg: 6, diffuser: 'carbon', canards: false, sideSkirts: true, activeAero: false },
    high: { splitter: 'race', wing: 'gt-wing', wingAngle_deg: 10, diffuser: 'race', canards: true, sideSkirts: true, activeAero: false }
  };
  function aeroPatch(id, x, B) {
    if (aeroFamily(B.aero) === id) return { aero: clone(B.aero) };
    return { aero: clone(AERO[id]) };
  }

  var LIGHTER_CHASSIS = { steel: 'aluminum', 'high-strength-steel': 'aluminum', aluminum: 'carbon-tub' };
  function weightPatch(id, x, B) {
    var w = clone(B.weight);
    delete w.rearSeats;     // follows the seat count (CB.state.normalize)
    var out = { weight: w, body: { construction: B.body.construction, chassisMaterial: B.body.chassisMaterial } };
    if (id === 'stock') return out;
    w.soundDeadening = false; w.spareTire = false; w.battery = 'lithium'; w.ballast_kg = 0;
    w.glass = id === 'feather' ? 'polycarbonate' : (w.glass === 'standard' ? 'thin' : w.glass);
    var c = B.body.construction;
    if (c === 'standard' || c === 'reinforced' || c === 'armoured') out.body.construction = 'lightweight';
    if (id === 'feather' && LIGHTER_CHASSIS[B.body.chassisMaterial]) out.body.chassisMaterial = LIGHTER_CHASSIS[B.body.chassisMaterial];
    return out;
  }

  var CABIN = {
    sport: { seatType: 'sport', upholstery: 'alcantara', trim: 'carbon', steering: 'flat-bottom', headliner: 'alcantara', harness: false, audio: 'premium' },
    luxury: { seatType: 'comfort', upholstery: 'nappa', trim: 'open-pore-wood', steering: 'round', headliner: 'leather', harness: false, audio: 'concert', adas: 'plus' },
    race: { seatType: 'race-shell', upholstery: 'alcantara', trim: 'carbon', steering: 'race-quick-release', headliner: 'alcantara', harness: true, audio: 'delete', adas: 'none' }
  };
  function cabinPatch(id, x, B) {
    var n = B.interior, t = B.tech;
    var out = { interior: { seatType: n.seatType, upholstery: n.upholstery, trim: n.trim, steering: n.steering, headliner: n.headliner, harness: n.harness },
      tech: { audio: t.audio, adas: t.adas } };
    if (id === 'factory') return out;
    var p = CABIN[id];
    ['seatType', 'upholstery', 'trim', 'steering', 'headliner', 'harness'].forEach(function (k) { out.interior[k] = p[k]; });
    out.tech.audio = p.audio;
    if (p.adas) out.tech.adas = p.adas;
    return out;
  }

  /* ---------------------------------------------------------------- systems */
  function ladder(ids, fn) { return function (id, x, B) { var i = ids.indexOf(id); return i < 0 ? null : fn(i, x, B); }; }
  var ENGINE_IDS = ['stock', 'street', 'sport', 'race', 'max'];
  var GEARING_IDS = ['accel2', 'accel1', 'standard', 'speed1', 'speed2'];

  var SYSTEMS = [
    { id: 'engine', title: 'Engine tune', desc: 'How hard the engine is tuned. Each step adds power (and cost).',
      owns: ['engine'],
      levels: [
        { id: 'stock', name: 'Stock', desc: 'As the factory built it.' },
        { id: 'street', name: 'Street', desc: 'ECU remap and a sport exhaust. Still a daily driver.' },
        { id: 'sport', name: 'Sport', desc: 'More boost, bigger cooling, speed limiter removed.' },
        { id: 'race', name: 'Race', desc: 'Forged internals, race exhaust. Loud and fast.' },
        { id: 'max', name: 'Max', desc: 'Everything turned up: time-attack map, race cooling, straight pipe. Track only.' }
      ],
      evLevels: { street: 'Motor software unlock.', sport: 'More motor power, better cooling.', race: 'Race inverters and cooling.', max: 'Everything the motors can take.' },
      patch: ladder(ENGINE_IDS, enginePatch) },
    { id: 'gearbox', title: 'Gearbox', desc: 'How you change gear.', kind: 'choices',
      owns: ['transmission.type', 'transmission.gears', 'transmission.ratios'],
      levels: [
        { id: 'manual', name: 'Manual', desc: 'Three pedals, you shift. Most involving, slowest shifts.' },
        { id: 'auto', name: 'Automatic', desc: 'Smooth and easy, a little slower.' },
        { id: 'dct', name: 'Dual-clutch', desc: 'Lightning-fast paddle shifts.' },
        { id: 'sequential', name: 'Sequential', desc: 'Race gearbox: the quickest shifts, close ratios, loud.' }
      ],
      available: function (b) { return isEV(b) ? 'Electric cars use a single-speed gear.' : true; },
      patch: function (id, x, B) { return GEARBOX_FAMILY[id] ? gearboxPatch(id, x, B) : null; } },
    { id: 'gearing', title: 'Gearing', desc: 'Short gears launch harder; long gears go faster flat out.', kind: 'slider',
      owns: ['transmission.finalDrive'],
      levels: [
        { id: 'accel2', name: 'Max acceleration', short: 'Accel ++', desc: 'Very short gears: fastest launches, lowest top speed.' },
        { id: 'accel1', name: 'Acceleration', short: 'Accel +', desc: 'Shorter gears for quicker sprints.' },
        { id: 'standard', name: 'Standard', short: 'Standard', desc: 'The factory gearing.' },
        { id: 'speed1', name: 'Top speed', short: 'Speed +', desc: 'Longer gears for more top speed.' },
        { id: 'speed2', name: 'Max top speed', short: 'Speed ++', desc: 'Very long gears: highest top speed, lazier launches.' }
      ],
      patch: ladder(GEARING_IDS, gearingPatch) },
    { id: 'drive', title: 'Driven wheels', desc: 'Which wheels push the car.', kind: 'choices',
      owns: ['drivetrain.layout', 'drivetrain.frontDiff', 'drivetrain.rearDiff', 'drivetrain.centerDiff', 'drivetrain.torqueSplitFront_pct'],
      levels: [
        { id: 'fwd', name: 'Front (FWD)', short: 'FWD', desc: 'Front wheels pull. Light and safe, less traction on launch.' },
        { id: 'rwd', name: 'Rear (RWD)', short: 'RWD', desc: 'Rear wheels push. Pure steering, can slide.' },
        { id: 'awd', name: 'All (AWD)', short: 'AWD', desc: 'All four wheels. Best launches and grip in any weather, a little heavier.' }
      ],
      patch: function (id, x, B) { return ['fwd', 'rwd', 'awd'].indexOf(id) >= 0 ? drivePatch(id, x, B) : null; } },
    { id: 'suspension', title: 'Suspension', desc: 'Soft and comfy, or stiff and sharp.',
      owns: ['suspension'],
      levels: [
        { id: 'factory', name: 'Factory', desc: 'The car as delivered.' },
        { id: 'comfort', name: 'Comfort', desc: 'Softer and a bit higher. Smooth over bumps.' },
        { id: 'sport', name: 'Sport', desc: 'Firmer and lower. Sharper turn-in.' },
        { id: 'track', name: 'Track', desc: 'Stiff race coilovers, slammed. Kerbs only.' }
      ],
      patch: function (id, x, B) { return id === 'factory' || SUSP[id] ? suspensionPatch(id, x, B) : null; } },
    { id: 'tyres', title: 'Tyres', desc: 'More grip wears faster and hates the rain.',
      owns: ['tires.compound'],
      levels: [
        { id: 'comfort', name: 'Comfort', desc: 'Quiet, long-lasting, good in the wet.' },
        { id: 'street', name: 'Street', desc: 'Summer performance tyres.' },
        { id: 'sport', name: 'Sport', desc: 'Supercar tyres, track capable.' },
        { id: 'semi', name: 'Semi-slick', desc: 'Road-legal track tyres. Need heat.' },
        { id: 'slick', name: 'Slick', desc: 'Racing slicks: huge dry grip. Track only.' }
      ],
      patch: function (id, x, B) { return TYRES.some(function (t) { return t.id === id; }) ? tyresPatch(id, x, B) : null; } },
    { id: 'brakes', title: 'Brakes', desc: 'Bigger brakes stop shorter and fade less.',
      owns: ['brakes'],
      levels: [
        { id: 'factory', name: 'Factory', desc: 'The car as delivered.' },
        { id: 'sport', name: 'Sport', desc: 'Drilled discs and sport ABS.' },
        { id: 'race', name: 'Race', desc: 'Big two-piece discs, race ABS.' },
        { id: 'carbon', name: 'Carbon', desc: 'Carbon-ceramic: no fade, lighter. Needs 19-inch wheels.' }
      ],
      patch: function (id, x, B) { return id === 'factory' || BRAKES[id] ? brakesPatch(id, x, B) : null; } },
    { id: 'aero', title: 'Downforce', desc: 'Wings push the car into the road: more grip in fast corners, less top speed.',
      owns: ['aero'],
      levels: [
        { id: 'off', name: 'Off', desc: 'Clean body, lowest drag.' },
        { id: 'low', name: 'Low', desc: 'Lip splitter and spoiler.' },
        { id: 'medium', name: 'Medium', desc: 'Carbon splitter, swan-neck wing, diffuser.' },
        { id: 'high', name: 'High', desc: 'Full race aero: GT wing, canards, venturi diffuser.' }
      ],
      patch: function (id, x, B) { return AERO[id] ? aeroPatch(id, x, B) : null; } },
    { id: 'weight', title: 'Weight', desc: 'Lighter cars accelerate, brake and turn better.',
      owns: ['weight.soundDeadening', 'weight.spareTire', 'weight.glass', 'weight.battery', 'weight.rollCage', 'weight.ballast_kg', 'weight.ballastPosition', 'body.construction', 'body.chassisMaterial'],
      levels: [
        { id: 'stock', name: 'Stock', desc: 'Full trim and insulation.' },
        { id: 'light', name: 'Light', desc: 'Lighter glass and battery, no sound deadening or spare.' },
        { id: 'feather', name: 'Featherweight', desc: 'Plastic windows and a lighter chassis. Noisy, expensive, fast.' }
      ],
      patch: function (id, x, B) { return ['stock', 'light', 'feather'].indexOf(id) >= 0 ? weightPatch(id, x, B) : null; } },
    { id: 'finish', title: 'Paint finish', desc: 'How the paint catches the light.', kind: 'choices',
      owns: ['exterior.finish'], extra: { path: 'exterior.finish', coll: 'paintFinishes' },
      levels: [
        { id: 'solid', name: 'Gloss', desc: 'Classic solid colour.' },
        { id: 'metallic', name: 'Metallic', desc: 'Sparkling metal flake.' },
        { id: 'pearl', name: 'Pearl', desc: 'Shifting pearlescent glow.' },
        { id: 'matte', name: 'Matte', desc: 'Flat, stealthy, no shine.' }
      ],
      patch: function (id) { return find('paintFinishes', id) ? { exterior: { finish: id } } : null; } },
    { id: 'wheelStyle', title: 'Wheel style', desc: 'Looks only: size and weight stay the same.', kind: 'choices',
      owns: ['wheels.design'], extra: { path: 'wheels.design', coll: 'wheelDesigns' },
      levels: [
        { id: 'y-spoke', name: 'Y-spoke', desc: 'Five twisted Y-spokes.' },
        { id: 'split-10', name: 'Split 10', desc: 'Ten split spokes, deep face.' },
        { id: 'mesh-bbs', name: 'Mesh', desc: '90s touring-car cross-spoke.' },
        { id: 'monoblock-5', name: '5-spoke', desc: 'Chunky and timeless.' },
        { id: 'turbine', name: 'Turbine', desc: 'Curved fan blades.' },
        { id: 'centerlock-race', name: 'Race', desc: 'Centre-lock race wheel.' }
      ],
      patch: function (id) { return find('wheelDesigns', id) ? { wheels: { design: id } } : null; } },
    { id: 'cabin', title: 'Cabin', desc: 'Seats, materials and gadgets.',
      owns: ['interior.seatType', 'interior.upholstery', 'interior.trim', 'interior.steering', 'interior.headliner', 'interior.harness', 'tech.audio', 'tech.adas'],
      levels: [
        { id: 'factory', name: 'Factory', desc: 'The cabin as delivered.' },
        { id: 'sport', name: 'Sport', desc: 'Alcantara, carbon and a flat-bottom wheel.' },
        { id: 'luxury', name: 'Luxury', desc: 'Soft nappa seats, wood, concert audio, driver assists.' },
        { id: 'race', name: 'Race', desc: 'Bucket shells, harness, no stereo.' }
      ],
      patch: function (id, x, B) { return id === 'factory' || CABIN[id] ? cabinPatch(id, x, B) : null; } }
  ];
  var BY_ID = {};
  SYSTEMS.forEach(function (s) { BY_ID[s.id] = s; });

  var CATEGORIES = [
    { id: 'car', title: 'Car', short: 'Car', icon: 'body', desc: 'Pick a real car to start from.', sections: ['body'], systems: [] },
    { id: 'power', title: 'Engine & Power', short: 'Engine', icon: 'engine', desc: 'One choice: how hard the engine is tuned.', sections: ['engine'], systems: ['engine'] },
    { id: 'drive', title: 'Gearbox & Drive', short: 'Drive', icon: 'transmission', desc: 'Gearbox, gearing and which wheels drive.', sections: ['transmission', 'drivetrain'], systems: ['gearbox', 'gearing', 'drive'] },
    { id: 'handling', title: 'Handling', short: 'Handling', icon: 'suspension', desc: 'Suspension, tyres and brakes.', sections: ['suspension', 'brakes', 'wheels'], systems: ['suspension', 'tyres', 'brakes'] },
    { id: 'aero-weight', title: 'Aero & Weight', short: 'Aero', icon: 'aero', desc: 'Downforce and weight saving.', sections: ['aero', 'weight'], systems: ['aero', 'weight'] },
    { id: 'style', title: 'Style', short: 'Style', icon: 'exterior', desc: 'Colour, wheels and cabin.', sections: ['exterior', 'interior', 'tech'], systems: ['finish', 'wheelStyle', 'cabin'] }
  ];
  function categoryOf(panelId) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === panelId || CATEGORIES[i].sections.indexOf(panelId) >= 0) return CATEGORIES[i].id;
    for (var j = 0; j < CATEGORIES.length; j++) if (CATEGORIES[j].systems.indexOf(panelId) >= 0) return CATEGORIES[j].id;
    return null;
  }
  function system(id) { return BY_ID[id] || null; }

  /* ---------------------------------------------------------------- core */
  function owned(sys, b) {
    var out = [];
    sys.owns.forEach(function (p) {
      var v = get(b, p);
      if (U().isPlainObject(v)) leafPaths(v).forEach(function (q) { out.push(p + '.' + q); });
      else out.push(p);
    });
    return out.filter(function (p) { return p !== 'weight.rearSeats'; });
  }
  /** The system's levels plus, for pick-lists, the factory and current values when they are not in the short list. */
  function levelList(s, build, B) {
    var list = s.levels.slice();
    if (s.extra && build) {
      [B, build].forEach(function (src) {
        var v = src && get(src, s.extra.path);
        if (v == null || list.some(function (l) { return l.id === v; })) return;
        var o = find(s.extra.coll, v);
        if (o) list.push({ id: v, name: o.name, desc: o.desc || '', extra: true });
      });
    }
    return list;
  }
  function available(sysId, build) {
    var s = system(sysId);
    if (!s) return 'Unknown setting';
    return s.available ? s.available(build) : true;
  }
  function levels(sysId, build) {
    var s = system(sysId);
    if (!s) return [];
    var B = build ? baseline(build) : null;
    var ev = build && isEV(build);
    return levelList(s, build, B).map(function (l) {
      var o = Object.assign({}, l);
      if (s.id === 'engine' && ev && s.evLevels[l.id]) o.desc = s.evLevels[l.id];
      if (B) {
        var bt = target(sysId, l.id, B, B);
        o.factory = !!bt && owned(s, B).every(function (p) { return eqVal(get(bt, p), get(B, p)); });
      }
      return o;
    });
  }
  function patch(sysId, levelId, build) {
    var s = system(sysId);
    if (!s || !build) return null;
    var B = baseline(build);
    var p = s.patch(levelId, build, B);
    return p ? clone(p) : null;
  }
  /** Normalized build with the level's patch (no auto-fix). B optional (baseline override). */
  function target(sysId, levelId, build, B) {
    var s = system(sysId);
    if (!s) return null;
    var p = s.patch(levelId, build, B || baseline(build));
    if (!p) return null;
    var paths = leafPaths(p);
    // two passes: the first lets normalize react to switches (engine type -> gearbox, ...), the second re-asserts the
    // level's own values that such a switch reset (e.g. a hybrid's motor count after an EV -> hybrid change)
    var t1 = normalize(U().deepMerge(build, p), { paths: paths, prev: build });
    var t2 = normalize(U().deepMerge(t1, p), { paths: paths, prev: t1 });
    return t2;
  }

  function issuesOf(b, metrics) {
    if (!CB.rules || !CB.rules.validate) return [];
    try { return CB.rules.validate(b, metrics || physics(b)) || []; } catch (e) { return []; }
  }
  function physics(b) {
    if (!CB.physics || !CB.physics.compute) return null;
    try { return CB.physics.compute(b); } catch (e) { return null; }
  }
  function touches(patchObj, paths) {
    return leafPaths(patchObj).some(function (p) { return paths.some(function (o) { return p === o || p.indexOf(o + '.') === 0 || o.indexOf(p + '.') === 0; }); });
  }
  /** Error-only auto-fix: per error take the first verified fix that leaves `keep` paths alone (else the first fix). */
  function resolve(b, keep) {
    var fixes = [], errors = [];
    for (var pass = 0; pass < 6; pass++) {
      errors = issuesOf(b).filter(function (i) { return i && i.severity === 'error'; });
      var fixable = errors.filter(function (i) { return i.fix && i.fix.patch; });
      if (!fixable.length) break;
      var merged = {};
      fixable.forEach(function (i) {
        var alts = (i.fixes && i.fixes.length ? i.fixes : [i.fix]).filter(function (f) { return f && f.patch; });
        var pick = alts.filter(function (f) { return !touches(f.patch, keep); })[0] || alts[0];
        merged = U().deepMerge(merged, pick.patch);
        fixes.push(pick.label || i.title || i.id);
      });
      var next = normalize(U().deepMerge(b, merged), { paths: leafPaths(merged), prev: b });
      if (U().equal(next, b)) break;
      b = next;
    }
    return { build: b, fixes: fixes, errors: errors };
  }

  function apply(sysId, levelId, build, opts) {
    opts = opts || {};
    var s = system(sysId);
    if (!s || !build) return null;
    var t = target(sysId, levelId, build);
    if (!t) return null;
    var keep = s.owns.slice();
    var res = resolve(t, keep);
    if (res.fixes.length) res.errors = issuesOf(res.build).filter(function (i) { return i.severity === 'error'; });
    var det = detect(sysId, res.build);
    var out = { build: res.build, fixes: res.fixes, errors: res.errors, legal: !res.errors.length,
      achieved: det.matches.indexOf(levelId) >= 0, system: sysId, level: levelId };
    return out;
  }

  /** Distance between two builds over a system's owned paths (0 = identical). */
  function distance(sys, a, b) {
    var d = 0;
    owned(sys, a).forEach(function (p) {
      var x = get(a, p), y = get(b, p);
      if (eqVal(x, y)) return;
      if (typeof x === 'number' && typeof y === 'number') {
        var rg = range(p), span = rg ? Math.max(1e-6, rg.max - rg.min) : Math.max(1, Math.abs(x), Math.abs(y));
        d += Math.min(1, Math.abs(x - y) / span) * 2;
      } else d += 1;
    });
    return d;
  }
  function detect(sysId, build) {
    var s = system(sysId);
    if (!s || !build) return { id: 'custom', nearest: null, matches: [], exact: false };
    var B = baseline(build), best = null, bestD = Infinity, matches = [];
    levelList(s, build, B).forEach(function (l) {
      var t = target(sysId, l.id, build, B);
      if (!t) return;
      var dd = distance(s, build, t);
      if (dd === 0) matches.push(l.id);
      if (dd < bestD) { bestD = dd; best = l.id; }
    });
    // several levels can coincide (e.g. gearing clamped at the final-drive limit): the factory one wins
    if (matches.length > 1) {
      var fac = matches.filter(function (id) { return id === 'factory' || id === 'stock' || id === 'standard'; })[0] ||
        matches.filter(function (id) { var t = target(sysId, id, B, B); return t && distance(s, B, t) === 0; })[0];
      if (fac) matches = [fac].concat(matches.filter(function (id) { return id !== fac; }));
    }
    return { id: matches[0] || 'custom', nearest: matches[0] || best, matches: matches, exact: matches.length > 0 };
  }

  /* ---------------------------------------------------------------- metrics / previews (cached by build object) */
  var mCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function metricsOf(b) {
    if (mCache && mCache.has(b)) return mCache.get(b);
    var m = physics(b), price = null, legal = null;
    if (CB.pricing && CB.pricing.compute) { try { price = CB.pricing.compute(b, m).total; } catch (e) { price = null; } }
    if (CB.rules && CB.rules.legality) { try { legal = CB.rules.legality(b, m); } catch (e) { legal = null; } }
    var out = { metrics: m, price: price, streetLegal: legal ? !!legal.streetLegal : null };
    if (mCache) mCache.set(b, out);
    return out;
  }
  function preview(from, to) {
    var a = metricsOf(from), b = metricsOf(to), ma = a.metrics || {}, mb = b.metrics || {};
    function d(k) { return isFinite(mb[k]) && isFinite(ma[k]) ? mb[k] - ma[k] : null; }
    return {
      power_hp: d('power_hp'), zeroTo100_s: d('zeroTo100_s'), topSpeed_kph: d('topSpeed_kph'), lateralG: d('lateralG'),
      weight_kg: d('weight_kg'), braking_m: d('brakingDist_100_0_m'),
      handling: ma.ratings && mb.ratings ? num(mb.ratings.handling) - num(ma.ratings.handling) : null,
      price: a.price != null && b.price != null ? b.price - a.price : null,
      after: { power_hp: mb.power_hp, zeroTo100_s: mb.zeroTo100_s, topSpeed_kph: mb.topSpeed_kph, lateralG: mb.lateralG, weight_kg: mb.weight_kg, braking_m: mb.brakingDist_100_0_m,
        handling: mb.ratings ? mb.ratings.handling : null, price: b.price, streetLegal: b.streetLegal }
    };
  }

  /** Career lock for a level: any owned value the level changes that CB.ui.lockOption (or opts.lockOption) rejects. */
  function lockOf(sys, from, to, lockFn) {
    if (typeof lockFn !== 'function') return null;
    var worst = null;
    owned(sys, to).forEach(function (p) {
      var v = get(to, p);
      if (eqVal(v, get(from, p))) return;
      if (typeof v === 'boolean' && !v) return;
      var l = null;
      try { l = lockFn(p, v, to); } catch (e) { l = null; }
      if (!l) return;
      if (typeof l === 'string') l = { reason: l };
      if (!worst || num(l.level, 0) > num(worst.level, 0)) worst = l;
    });
    return worst;
  }

  var oCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function options(sysId, build, opts) {
    opts = opts || {};
    var s = system(sysId);
    if (!s || !build) return [];
    var lockFn = opts.lockOption !== undefined ? opts.lockOption : (CB.ui && CB.ui.lockOption) || null;
    var key = sysId + '|' + (lockFn ? 'L' : '');
    var per = oCache && oCache.get(build);
    if (per && per[key]) return per[key];
    var det = detect(sysId, build);
    var rows = levels(sysId, build).map(function (l) {
      var res = apply(sysId, l.id, build);
      var selected = det.matches.indexOf(l.id) >= 0;
      var pv = res ? preview(build, res.build) : null;
      var lock = res && !selected ? lockOf(s, build, res.build, lockFn) : null;
      return Object.assign({}, l, {
        selected: selected, primary: det.id === l.id, nearest: det.nearest === l.id && !det.exact,
        result: res, achieved: !!(res && res.achieved), fixes: res ? res.fixes : [], legal: !!(res && res.legal),
        preview: pv, streetLegal: pv ? pv.after.streetLegal : null, lock: lock,
        reason: !res ? 'Not available' : (!res.achieved && !selected ? 'Not possible on this car' + (res.fixes.length ? ' (' + res.fixes[0] + ')' : '') : null)
      });
    });
    if (oCache) { per = per || {}; per[key] = rows; oCache.set(build, per); }
    return rows;
  }

  function labelFor(sysId, levelId) {
    var s = system(sysId), l = s && s.levels.filter(function (x) { return x.id === levelId; })[0];
    var o = !l && s && s.extra ? find(s.extra.coll, levelId) : null;
    return (s ? s.title : sysId) + ': ' + (l ? l.name : o ? o.name : levelId);
  }
  /** Apply a level to CB.state as one undo step. opts.coalesce merges rapid repeats (slider drags). */
  function choose(sysId, levelId, opts) {
    opts = opts || {};
    var St = CB.state;
    if (!St) return null;
    var cur = St.get();
    var res = apply(sysId, levelId, cur);
    if (!res) return null;
    var changed = St.replace(res.build, { label: labelFor(sysId, levelId), coalesceKey: opts.coalesce ? 'tune:' + sysId : undefined });
    return Object.assign({}, res, { changed: changed !== false, label: labelFor(sysId, levelId) });
  }

  CB.tune = {
    CATEGORIES: CATEGORIES, SYSTEMS: SYSTEMS, system: system, categoryOf: categoryOf,
    baseline: baseline, levels: levels, available: available, patch: patch, target: target, apply: apply,
    detect: detect, options: options, preview: preview, metricsOf: metricsOf, choose: choose, labelFor: labelFor,
    owned: function (sysId, b) { var s = system(sysId); return s ? owned(s, b || (CB.state && CB.state.get())) : []; },
    clearCache: function () { baseCache = {}; },
    _test: { fitKnock: fitKnock, aeroFamily: aeroFamily, familyOf: familyOf, resolve: resolve, lockOf: function (sysId, a, b, f) { return lockOf(system(sysId), a, b, f); } }
  };
})();

if (typeof module !== 'undefined') module.exports = CB.tune;

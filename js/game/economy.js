/* ==========================================================================
   FORGE Atelier — js/game/economy.js
   CB.game.economy : credits, part/track/body unlock progression, car pricing in
   career credits, upgrades, repairs, resale, race purses and sponsor contracts.

   Pure module (no DOM). Runs in the browser (classic script) and in Node.
   Every dependency is feature-detected:
     CB.data      catalog (falls back to "unknown part" heuristics when absent)
     CB.pricing   MSRP (falls back to an own catalog-based estimate)
     CB.state     normalize() used after clamping a build to unlocks (optional)
     CB.race.tracks  track difficulty / length for purses & unlock levels (optional)

   ---------------------------------------------------------------- API
   Constants
     CAREER_PRICE_FACTOR (0.35), PART_REFUND_RATE (0.5), START_CREDITS (150000),
     DIFFICULTY_MULT, UNLOCK_TABLE, FEATURE_UNLOCKS, TRACK_UNLOCKS, MAX_LEVEL
   Unlocks
     partUnlockLevel(collectionOrPath, id)      -> level (1..MAX_LEVEL)
     featureUnlockLevel(path)                   -> level for boolean features (activeAero …)
     trackUnlockLevel(trackId, trackDef?)       -> level
     bodyStyleUnlockLevel(id)                   -> level
     isUnlocked(profile, collectionOrPath, id)  -> bool (level OR explicit profile.unlocks grant)
     isFeatureUnlocked(profile, path)           -> bool
     isTrackUnlocked(profile, trackId)          -> bool
     lockedOptions(profile)                     -> { [collection]: Set(ids) }
     lockedPaths(profile)                       -> { [buildPath]: Set(ids) }   (same data keyed by build path)
     lockedFeatures(profile)                    -> { [buildPath]: level }
     lockedTracks(profile)                      -> Set(trackIds)
     unlocksAtLevel(level)                      -> [{kind, collection, path?, id, name, level}]
     nextUnlocks(profile, n?)                   -> upcoming unlocks sorted by level
     unlockProgress(profile)                    -> {unlocked, total, pct, byCollection}
     buildLockViolations(profile, build)        -> [{path, collection, id, name, level, kind}]
     clampBuildToUnlocks(profile, build)        -> new build with every locked choice downgraded
     levelRewards(level)                        -> {credits, unlocks:[…]}
   Pricing
     estimateMsrp(build)                        -> number (catalog-based fallback)
     msrp(build)                                -> {total, subtotal, source:'pricing'|'estimate'}
     carCost(build)                             -> credits (MSRP × 0.35, rounded to 100)
     carQuote(build)                            -> {msrp, factor, credits, source}
     partCost(collectionOrPath, id)             -> credits for that part alone
     upgradeQuote(oldBuild, newBuild, opts?)    -> {lines, parts, refunds, labor, adjustments, total, changes}  (opts.car: entry car → no refunds)
     upgradeCost(oldBuild, newBuild)            -> number (positive = charge, negative = net refund)
     repairQuote(car, targetCondition?)         -> {credits, lines, from, to}
     repairCost(car, targetCondition?)          -> number
     sellQuote(car)                             -> {credits, basis, factors:{…}, lines}
     sellValue(car)                             -> number
     carValue(car)                              -> current market value (pre-dealer margin)
     entryFee({tier, difficulty, eventType})    -> number
     pitServiceCost(request, build)             -> {credits, lines}
     canAfford(profile, n)                      -> bool
     formatCredits(n)                           -> 'CR 12,500'
   Races
     raceRewards({position, fieldSize, difficulty, laps, trackId, cleanRace, fastestLap, pole,
                  overtakes?, lapsLed?, gridPosition?, penalties_s?, dnf?, mode?, multiplier?,
                  multiplierLabel?, trackLength_m?, collisions?})
       -> {credits, xp, breakdown:[{label, credits, xp, kind}], summary:{…}}
     outcomeFromResults(results, opts?)         -> normalized raceRewards() input from session results
     rewardsFromResults(results, opts?)         -> raceRewards(outcomeFromResults(...))
   Sponsors
     SPONSORS (catalog), getSponsor(id)
     maxActiveContracts(level)                  -> 1..3
     getSponsorOffers(profile, opts?)           -> deterministic offers (refresh every 3 races)
     createContract(offer, now?)                -> active contract state
     evaluateSponsor(contract, results)         -> {contract, credits, xp, breakdown, met, missed,
                                                    eligible, completed, status, events}
     evaluateSponsors(contracts, results)       -> {contracts, credits, xp, breakdown, events}
     activeContracts(profile)                   -> array (profile.sponsors.active || profile.career.sponsors …)
     contractSummary(contract)                  -> human readable progress list
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.game = CB.game || {};

CB.game.economy = (function () {
  'use strict';

  /* ------------------------------------------------------------------ constants */
  var CAREER_PRICE_FACTOR = 0.35;
  var PART_REFUND_RATE = 0.5;
  var START_CREDITS = 150000;
  var MAX_LEVEL = 50;
  var LABOR_PER_PART = 150;
  var LABOR_PER_TUNE = 40;

  var DIFFICULTY_MULT = { rookie: 0.75, amateur: 1.0, pro: 1.35, alien: 1.8 };
  var DIFFICULTY_XP_MULT = { rookie: 0.8, amateur: 1.0, pro: 1.25, alien: 1.6 };
  var DIFFICULTY_ORDER = ['rookie', 'amateur', 'pro', 'alien'];
  var DIFFICULTY_LABEL = { rookie: 'Rookie', amateur: 'Amateur', pro: 'Pro', alien: 'Alien' };

  /* ------------------------------------------------------------------ deps */
  function D() { return CB.data || null; }
  function U() { return CB.util || null; }

  /* Fallback mapping build path -> collection (mirrors CB.data.pathCollections). */
  var DEFAULT_PATH_COLLECTIONS = {
    'body.style': 'bodyStyles', 'body.chassisMaterial': 'chassisMaterials', 'body.construction': 'constructions',
    'engine.speedLimiter_kph': 'speedLimiters', 'tires.speedRating': 'tireSpeedRatings',
    'engine.type': 'engineTypes', 'engine.layout': 'engineLayouts', 'engine.aspiration': 'aspirations',
    'engine.fuel': 'fuels', 'engine.position': 'enginePositions', 'engine.tune': 'tunes',
    'engine.exhaust': 'exhausts', 'engine.cooling': 'coolings', 'engine.chemistry': 'batteryChemistries',
    'engine.voltage': 'voltages', 'transmission.type': 'transmissions', 'drivetrain.layout': 'drivetrainLayouts',
    'drivetrain.frontDiff': 'differentials', 'drivetrain.rearDiff': 'differentials', 'drivetrain.centerDiff': 'differentials',
    'suspension.type': 'suspensionTypes', 'brakes.material': 'brakeMaterials', 'brakes.abs': 'absModes',
    'wheels.design': 'wheelDesigns', 'wheels.material': 'wheelMaterials', 'tires.compound': 'tireCompounds',
    'aero.splitter': 'aero.splitters', 'aero.wing': 'aero.wings', 'aero.diffuser': 'aero.diffusers',
    'weight.glass': 'glassTypes', 'weight.battery': 'batteryTypes', 'weight.rollCage': 'rollCages',
    'weight.ballastPosition': 'ballastPositions', 'exterior.finish': 'paintFinishes', 'exterior.roof': 'roofTypes',
    'exterior.stripe': 'stripes', 'exterior.lights': 'lightTypes', 'exterior.mirrors': 'mirrorTypes',
    'exterior.badge': 'badgeTypes', 'interior.seatType': 'seatTypes', 'interior.upholstery': 'upholsteries',
    'interior.trim': 'trims', 'interior.steering': 'steeringTypes', 'interior.headliner': 'headliners',
    'tech.screen_in': 'screenSizes', 'tech.audio': 'audioSystems', 'tech.adas': 'adasLevels'
  };

  function pathCollections() {
    var d = D();
    return (d && d.pathCollections) || DEFAULT_PATH_COLLECTIONS;
  }

  /* collection -> [paths] reverse index (computed lazily, data may load later) */
  function pathsForCollection(coll) {
    var pc = pathCollections(), out = [];
    for (var p in pc) if (pc[p] === coll) out.push(p);
    return out;
  }

  /* Accept either a collection name ('engineLayouts', 'aero.wings') or a build path ('engine.layout'). */
  function resolveCollection(collOrPath) {
    var s = String(collOrPath || '');
    var pc = pathCollections();
    if (Object.prototype.hasOwnProperty.call(pc, s)) return pc[s];
    return s;
  }

  function catalogList(coll) {
    var d = D();
    if (!d) return null;
    if (typeof d.list === 'function') { try { var l = d.list(coll); if (l) return l; } catch (e) { /* ignore */ } }
    var parts = String(coll).split('.'), cur = d;
    for (var i = 0; i < parts.length; i++) { if (cur == null) return null; cur = cur[parts[i]]; }
    return Array.isArray(cur) ? cur : null;
  }

  function findPart(coll, id) {
    var d = D();
    if (d && typeof d.find === 'function') { try { var f = d.find(coll, id); if (f) return f; } catch (e) { /* ignore */ } }
    var list = catalogList(coll);
    if (!list) return null;
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  }

  function partPrice(coll, id) {
    var p = findPart(coll, id);
    if (!p) return 0;
    var v = (typeof p.price === 'number') ? p.price : (typeof p.basePrice === 'number' ? p.basePrice : 0);
    return isFinite(v) ? v : 0;
  }

  function partName(coll, id) {
    var p = findPart(coll, id);
    return (p && p.name) || String(id);
  }

  /* ------------------------------------------------------------------ small utils */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { v = Number(v); return isFinite(v) ? v : (d === undefined ? 0 : d); }
  function round(n, step) { step = step || 1; return Math.round(n / step) * step; }
  function getPath(obj, path) {
    var parts = String(path).split('.'), cur = obj;
    for (var i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
    return cur;
  }
  function setPathMut(obj, path, val) {
    var parts = String(path).split('.'), cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = val;
  }
  function clone(o) {
    var u = U();
    if (u && typeof u.deepClone === 'function') return u.deepClone(o);
    return o == null ? o : JSON.parse(JSON.stringify(o));
  }
  function hashStr(s) {
    s = String(s); var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function fmtInt(n) {
    n = Math.round(num(n));
    var s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + s;
  }
  function formatCredits(n) { return 'CR ' + fmtInt(n); }

  function normDifficulty(d) {
    if (typeof d === 'number' && isFinite(d)) return DIFFICULTY_ORDER[clamp(Math.round(d), 0, 3)];
    d = String(d || '').toLowerCase();
    if (DIFFICULTY_MULT[d]) return d;
    if (d === 'easy') return 'rookie';
    if (d === 'medium' || d === 'normal') return 'amateur';
    if (d === 'hard') return 'pro';
    if (d === 'expert' || d === 'extreme' || d === 'insane') return 'alien';
    return 'amateur';
  }

  function profileLevel(profile) {
    if (!profile) return 1;
    var l = num(profile.level, NaN);
    if (!isFinite(l) || l < 1) {
      // derive from xp using the profile's cumulative curve (see levelForXp)
      l = levelForXp(num(profile.xp, 0));
    }
    return clamp(Math.floor(l), 1, MAX_LEVEL);
  }

  function xpForLevel(l) {
    var P = CB.game.profile;
    if (P && typeof P.xpForLevel === 'function') { try { return P.xpForLevel(l); } catch (e) { /* ignore */ } }
    return Math.round(1000 * Math.pow(Math.max(0, l), 1.6));
  }
  /* Cumulative curve, identical to CB.game.profile.levelForXp: xpForLevel(l) is the
     XP needed to go from l to l+1, so level L needs sum(xpForLevel(1..L-1)) total XP.
     Delegates to the profile module when present; clamped to economy's MAX_LEVEL. */
  function levelForXp(xp) {
    xp = Math.max(0, num(xp, 0));
    var P = CB.game.profile;
    if (P && typeof P.levelForXp === 'function') {
      try {
        var pl = num(P.levelForXp(xp), NaN);
        if (isFinite(pl)) return clamp(Math.floor(pl), 1, MAX_LEVEL);
      } catch (e) { /* fall through to the local curve */ }
    }
    var l = 1, acc = 0;
    while (l < MAX_LEVEL && xp >= acc + xpForLevel(l)) { acc += xpForLevel(l); l++; }
    return l;
  }

  /* ==================================================================
     UNLOCK TABLE — every catalog collection & id in docs/SPEC.md / CB.data.
     Progression philosophy:
       L1      road-car basics: everything a sensible hatch / sedan / coupe needs
       L2-5    hot-hatch & sports-car upgrades (turbo, LSDs, AWD, sticky tyres)
       L6-10   supercar territory (V8, twin-turbo, DCT, carbon trim, slicks L8)
       L11-15  race hardware (quad-turbo L12, carbon-monocoque L15, sequential)
       L16-20  exotica (V12 L17, chrome paint L18, W16 L20, hypercar body L16)
     ================================================================== */
  var UNLOCK_TABLE = {
    bodyStyles: {
      coupe: 1, sedan: 1, hatchback: 1, wagon: 3, roadster: 4, suv: 5, pickup: 6, van: 7,
      'shooting-brake': 9, hypercar: 16
    },
    chassisMaterials: {
      steel: 1, 'high-strength-steel': 3, aluminum: 7, 'carbon-tub': 11, 'carbon-monocoque': 15
    },
    constructions: { classic: 1, standard: 1, lightweight: 2, reinforced: 2, armoured: 6 },
    engineTypes: { ice: 1, ev: 4, hybrid: 6 },
    enginePositions: { front: 1, rear: 5, mid: 8 },
    engineLayouts: {
      I3: 1, I4: 1, I5: 3, I6: 4, V6: 4, 'flat-4': 5, V8: 6, 'rotary-2': 7, 'flat-6': 9,
      V10: 13, V12: 17, W16: 20
    },
    aspirations: {
      na: 1, turbo: 2, supercharged: 4, 'twin-turbo': 6, twincharged: 9, 'electric-turbo': 11, 'quad-turbo': 12
    },
    fuels: { regular: 1, premium: 1, diesel: 2, e85: 5, race: 8 },
    tunes: { eco: 1, stock: 1, stage1: 3, stage2: 6, stage3: 10, 'time-attack': 14 },
    exhausts: { stock: 1, sport: 2, 'straight-pipe': 4, valvetronic: 6, titanium: 9 },
    coolings: { standard: 1, uprated: 4, race: 8 },
    batteryChemistries: { lfp: 1, nmc: 3, nca: 7, 'solid-state': 14 },
    voltages: { '400': 1, '800': 8 },
    speedLimiters: { '0': 1, '150': 1, '160': 1, '170': 1, '180': 1, '190': 1, '200': 1, '210': 1, '230': 1, '240': 1, '250': 1, '260': 1, '270': 1, '280': 1, '290': 1, '305': 1, '320': 1, '350': 1, '420': 1 },
    transmissions: { manual: 1, auto: 1, cvt: 1, 'single-speed': 1, dct: 5, sequential: 11 },
    differentials: {
      none: 1, open: 1, 'lsd-viscous': 2, locking: 3, 'lsd-torsen': 4, 'lsd-clutch': 5, 'e-diff': 9
    },
    drivetrainLayouts: { fwd: 1, rwd: 1, awd: 5 },
    suspensionTypes: {
      macpherson: 1, multilink: 2, 'double-wishbone': 3, air: 6, 'coilover-track': 7, magnetic: 9, pushrod: 13
    },
    brakeMaterials: { iron: 1, 'drilled-slotted': 3, 'two-piece': 7, 'carbon-ceramic': 12 },
    absModes: { standard: 1, off: 1, sport: 2, race: 7 },
    wheelDesigns: {
      'y-spoke': 1, 'monoblock-5': 1, 'monoblock-6': 2, 'classic-5': 2, 'split-10': 3, 'aero-blade': 3,
      'twin-7': 4, 'fan-blade': 4, 'multi-spoke': 5, 'mesh-bbs': 6, turbine: 7, 'deep-dish': 8,
      beadlock: 9, 'aero-disc': 11, 'centerlock-race': 13
    },
    wheelMaterials: { steel: 1, cast: 1, 'flow-formed': 4, forged: 8, magnesium: 12, carbon: 16 },
    tireCompounds: {
      eco: 1, 'all-season': 1, touring: 1, winter: 2, performance: 3, 'super-sport': 5, track: 6, slick: 8
    },
    tireSpeedRatings: { compound: 1, H: 1, V: 1, W: 1, Y: 1, 'Y+': 6, hyper: 14 },
    'aero.splitters': { none: 1, lip: 2, carbon: 7, race: 11 },
    'aero.wings': { none: 1, 'lip-spoiler': 2, ducktail: 3, 'gt-wing': 7, 'swan-neck': 10, biplane: 13, active: 15 },
    'aero.diffusers': { none: 1, mild: 2, carbon: 7, race: 11 },
    glassTypes: { standard: 1, thin: 5, polycarbonate: 10 },
    batteryTypes: { lead: 1, lithium: 4 },
    rollCages: { none: 1, half: 5, full: 9 },
    ballastPositions: { front: 1, center: 1, rear: 1 },
    paintFinishes: {
      solid: 1, metallic: 1, pearl: 3, satin: 5, matte: 6, candy: 9, chameleon: 13, chrome: 18
    },
    stripes: {
      none: 1, hood: 1, center: 2, 'side-skirt': 2, pinstripe: 3, 'racing-dual': 4, gradient: 6, 'le-mans': 8
    },
    roofTypes: { body: 1, black: 1, contrast: 2, glass: 4, carbon: 8 },
    lightTypes: { halogen: 1, led: 1, matrix: 5, laser: 10 },
    mirrorTypes: { body: 1, black: 1, carbon: 7 },
    badgeTypes: { chrome: 1, black: 1, delete: 3 },
    seatTypes: { comfort: 1, sport: 1, bucket: 5, lounge: 7, 'race-shell': 9, 'carbon-bucket': 11 },
    upholsteries: {
      cloth: 1, leather: 1, vegan: 1, tartan: 3, alcantara: 4, nappa: 6, 'carbon-weave': 8, 'semi-aniline': 10
    },
    trims: {
      aluminum: 1, 'piano-black': 1, 'open-pore-wood': 3, 'gloss-walnut': 4, carbon: 6,
      'brushed-titanium': 8, 'forged-carbon': 10
    },
    steeringTypes: { round: 1, 'flat-bottom': 2, 'race-quick-release': 6, yoke: 8 },
    headliners: { cloth: 1, leather: 2, alcantara: 4 },
    screenSizes: { '0': 1, '8': 1, '10': 1, '12': 2, '15': 5, '17': 8 },
    audioSystems: { delete: 1, track: 1, standard: 1, premium: 3, reference: 7, concert: 11 },
    adasLevels: { none: 1, assist: 1, plus: 3, pilot: 7, 'autonomous-l3': 12 }
  };

  /* Boolean / numeric build features gated by level (path -> level, value that is gated). */
  var FEATURE_UNLOCKS = {
    'transmission.launchControl': { level: 3, gated: true, name: 'Launch Control' },
    'tech.hud': { level: 4, gated: true, name: 'Head-up Display' },
    'tech.liftSystem': { level: 5, gated: true, name: 'Front Axle Lift' },
    'aero.canards': { level: 6, gated: true, name: 'Canards' },
    'tech.telemetry': { level: 6, gated: true, name: 'Track Telemetry' },
    'tech.nightVision': { level: 8, gated: true, name: 'Night Vision' },
    'drivetrain.torqueVectoring': { level: 9, gated: true, name: 'Torque Vectoring' },
    'interior.harness': { level: 5, gated: true, name: 'Race Harness' },
    'aero.activeAero': { level: 15, gated: true, name: 'Active Aerodynamics' }
  };

  /* Numeric caps per level band (career only, informational for configurator sliders). */
  var NUMERIC_CAPS = [
    { level: 1, 'engine.boost_bar': 1.0, 'engine.motorPower_kw': 150, 'engine.motors': 2, 'engine.battery_kwh': 80 },
    { level: 5, 'engine.boost_bar': 1.6, 'engine.motorPower_kw': 250, 'engine.motors': 2, 'engine.battery_kwh': 110 },
    { level: 10, 'engine.boost_bar': 2.2, 'engine.motorPower_kw': 350, 'engine.motors': 3, 'engine.battery_kwh': 150 },
    { level: 15, 'engine.boost_bar': 3.0, 'engine.motorPower_kw': 500, 'engine.motors': 4, 'engine.battery_kwh': 200 }
  ];

  var TRACK_UNLOCKS = {
    'forge-speedway': 1, 'little-anvil': 1, 'ouroboros': 3, 'forge-ring': 4,
    'porto-vecchio': 6, 'neon-harbour': 9, 'akagane-pass': 11
  };
  var TRACK_LEVEL_BY_DIFFICULTY = { 1: 1, 2: 2, 3: 4, 4: 7, 5: 10 };

  /* Heuristic level for an unknown part from its price (log curve). */
  function levelFromPrice(price) {
    price = num(price, 0);
    if (price <= 1000) return 1;
    // 1k -> 1, 5k -> ~4, 20k -> ~9, 100k -> ~15, 420k -> 20
    return clamp(Math.round(1 + 4.3 * Math.log(price / 1000) / Math.LN2 * 0.72), 1, 20);
  }

  function partUnlockLevel(collOrPath, id) {
    var coll = resolveCollection(collOrPath);
    var t = UNLOCK_TABLE[coll];
    var key = String(id);
    if (t && Object.prototype.hasOwnProperty.call(t, key)) return t[key];
    var p = findPart(coll, id);
    if (p) {
      if (typeof p.unlockLevel === 'number') return clamp(p.unlockLevel, 1, MAX_LEVEL);
      return levelFromPrice(typeof p.price === 'number' ? p.price : p.basePrice);
    }
    return 1;
  }

  function bodyStyleUnlockLevel(id) { return partUnlockLevel('bodyStyles', id); }

  function featureUnlockLevel(path) {
    var f = FEATURE_UNLOCKS[path];
    return f ? f.level : 1;
  }

  function trackDefFor(trackId) {
    var T = CB.race && CB.race.tracks;
    if (!T) return null;
    if (typeof T.get === 'function') { try { var g = T.get(trackId); if (g) return g; } catch (e) { /* ignore */ } }
    var list = T.list || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === trackId) return list[i];
    return null;
  }

  function trackUnlockLevel(trackId, trackDef) {
    if (Object.prototype.hasOwnProperty.call(TRACK_UNLOCKS, trackId)) return TRACK_UNLOCKS[trackId];
    var def = trackDef || trackDefFor(trackId);
    if (def && typeof def.unlockLevel === 'number') return def.unlockLevel;
    if (def && def.difficulty) return TRACK_LEVEL_BY_DIFFICULTY[clamp(Math.round(def.difficulty), 1, 5)] || 1;
    return 1;
  }

  function grants(profile) {
    var u = (profile && profile.unlocks) || {};
    return { parts: u.parts || [], tracks: u.tracks || [], bodyStyles: u.bodyStyles || [] };
  }

  function hasGrant(profile, coll, id) {
    var g = grants(profile);
    var key = String(id);
    if (coll === 'bodyStyles' && g.bodyStyles.map(String).indexOf(key) >= 0) return true;
    var keys = [coll + ':' + key];
    var paths = pathsForCollection(coll);
    for (var i = 0; i < paths.length; i++) keys.push(paths[i] + ':' + key);
    for (var j = 0; j < g.parts.length; j++) if (keys.indexOf(String(g.parts[j])) >= 0) return true;
    return false;
  }

  function isUnlocked(profile, collOrPath, id) {
    var coll = resolveCollection(collOrPath);
    if (profileLevel(profile) >= partUnlockLevel(coll, id)) return true;
    return hasGrant(profile, coll, id);
  }

  function isFeatureUnlocked(profile, path) {
    if (profileLevel(profile) >= featureUnlockLevel(path)) return true;
    var g = grants(profile).parts;
    return g.indexOf('feature:' + path) >= 0 || g.indexOf(path + ':true') >= 0;
  }

  function isTrackUnlocked(profile, trackId) {
    if (profileLevel(profile) >= trackUnlockLevel(trackId)) return true;
    return grants(profile).tracks.indexOf(trackId) >= 0;
  }

  /* All known collections: table keys ∪ catalog collections referenced by pathCollections. */
  function allCollections() {
    var seen = {}, out = [];
    function add(c) { if (!seen[c]) { seen[c] = 1; out.push(c); } }
    Object.keys(UNLOCK_TABLE).forEach(add);
    var pc = pathCollections();
    for (var p in pc) add(pc[p]);
    return out;
  }

  /* ids of a collection: catalog when present, otherwise the table keys. */
  function collectionIds(coll) {
    var list = catalogList(coll);
    if (list && list.length) return list.map(function (x) { return x.id; });
    return Object.keys(UNLOCK_TABLE[coll] || {});
  }

  function lockedOptions(profile) {
    var out = {};
    allCollections().forEach(function (coll) {
      var set = new Set();
      collectionIds(coll).forEach(function (id) {
        if (!isUnlocked(profile, coll, id)) set.add(id);
      });
      out[coll] = set;
    });
    return out;
  }

  function lockedPaths(profile) {
    var byColl = lockedOptions(profile), out = {}, pc = pathCollections();
    for (var p in pc) out[p] = byColl[pc[p]] || new Set();
    return out;
  }

  function lockedFeatures(profile) {
    var out = {};
    for (var p in FEATURE_UNLOCKS) if (!isFeatureUnlocked(profile, p)) out[p] = FEATURE_UNLOCKS[p].level;
    return out;
  }

  function knownTrackIds() {
    var T = CB.race && CB.race.tracks, ids = [];
    if (T && Array.isArray(T.ids)) ids = T.ids.slice();
    else if (T && Array.isArray(T.list)) ids = T.list.map(function (t) { return t.id; });
    Object.keys(TRACK_UNLOCKS).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
    return ids;
  }

  function lockedTracks(profile) {
    var s = new Set();
    knownTrackIds().forEach(function (id) { if (!isTrackUnlocked(profile, id)) s.add(id); });
    return s;
  }

  function numericCaps(profile) {
    var lvl = profileLevel(profile), cap = NUMERIC_CAPS[0];
    for (var i = 0; i < NUMERIC_CAPS.length; i++) if (lvl >= NUMERIC_CAPS[i].level) cap = NUMERIC_CAPS[i];
    var out = {};
    for (var k in cap) if (k !== 'level') out[k] = cap[k];
    return out;
  }

  var COLLECTION_LABELS = {
    bodyStyles: 'Body style', chassisMaterials: 'Chassis', constructions: 'Body construction', engineTypes: 'Powertrain', enginePositions: 'Engine position',
    engineLayouts: 'Engine', aspirations: 'Induction', fuels: 'Fuel', tunes: 'ECU tune', exhausts: 'Exhaust',
    coolings: 'Cooling', batteryChemistries: 'Battery chemistry', voltages: 'Voltage', speedLimiters: 'Speed limiter', transmissions: 'Gearbox',
    differentials: 'Differential', drivetrainLayouts: 'Drivetrain', suspensionTypes: 'Suspension',
    brakeMaterials: 'Brakes', absModes: 'ABS', wheelDesigns: 'Wheel design', wheelMaterials: 'Wheel material',
    tireCompounds: 'Tyres', tireSpeedRatings: 'Tyre speed rating', 'aero.splitters': 'Splitter', 'aero.wings': 'Wing', 'aero.diffusers': 'Diffuser',
    glassTypes: 'Glazing', batteryTypes: '12V battery', rollCages: 'Roll cage', ballastPositions: 'Ballast',
    paintFinishes: 'Paint finish', stripes: 'Stripes', roofTypes: 'Roof', lightTypes: 'Lights', mirrorTypes: 'Mirrors',
    badgeTypes: 'Badges', seatTypes: 'Seats', upholsteries: 'Upholstery', trims: 'Trim', steeringTypes: 'Steering wheel',
    headliners: 'Headliner', screenSizes: 'Screen', audioSystems: 'Audio', adasLevels: 'Driver assistance'
  };
  function collectionLabel(c) { return COLLECTION_LABELS[c] || c; }

  function allUnlockEntries() {
    var out = [];
    allCollections().forEach(function (coll) {
      collectionIds(coll).forEach(function (id) {
        out.push({ kind: coll === 'bodyStyles' ? 'body' : 'part', collection: coll, category: collectionLabel(coll),
          path: pathsForCollection(coll)[0] || null, id: id, name: partName(coll, id),
          level: partUnlockLevel(coll, id), price: partPrice(coll, id) });
      });
    });
    for (var f in FEATURE_UNLOCKS) {
      out.push({ kind: 'feature', collection: null, category: 'Feature', path: f, id: f,
        name: FEATURE_UNLOCKS[f].name, level: FEATURE_UNLOCKS[f].level, price: 0 });
    }
    knownTrackIds().forEach(function (tid) {
      var def = trackDefFor(tid);
      out.push({ kind: 'track', collection: null, category: 'Track', path: null, id: tid,
        name: (def && def.name) || tid, level: trackUnlockLevel(tid, def), price: 0 });
    });
    return out;
  }

  function unlocksAtLevel(level) {
    level = Math.floor(num(level, 1));
    return allUnlockEntries().filter(function (e) { return e.level === level; });
  }

  function nextUnlocks(profile, n) {
    var lvl = profileLevel(profile);
    var list = allUnlockEntries().filter(function (e) {
      if (e.level <= lvl) return false;
      if (e.kind === 'track') return !isTrackUnlocked(profile, e.id);
      if (e.kind === 'feature') return !isFeatureUnlocked(profile, e.id);
      return !hasGrant(profile, e.collection, e.id);
    });
    list.sort(function (a, b) { return a.level - b.level || b.price - a.price; });
    return n ? list.slice(0, n) : list;
  }

  function unlockProgress(profile) {
    var entries = allUnlockEntries(), unlocked = 0, by = {};
    entries.forEach(function (e) {
      var ok = e.kind === 'track' ? isTrackUnlocked(profile, e.id)
        : e.kind === 'feature' ? isFeatureUnlocked(profile, e.id)
        : isUnlocked(profile, e.collection, e.id);
      var k = e.collection || e.kind;
      by[k] = by[k] || { unlocked: 0, total: 0, label: e.collection ? collectionLabel(e.collection) : e.category };
      by[k].total++;
      if (ok) { by[k].unlocked++; unlocked++; }
    });
    return { unlocked: unlocked, total: entries.length, pct: entries.length ? unlocked / entries.length : 1, byCollection: by };
  }

  function levelRewards(level) {
    level = Math.floor(num(level, 1));
    var credits = level <= 1 ? 0 : round(2000 + 1500 * level + (level % 5 === 0 ? 10000 * (level / 5) : 0), 100);
    return { level: level, credits: credits, unlocks: unlocksAtLevel(level), milestone: level % 5 === 0 };
  }

  /* Paths of the build that use a locked part / feature. */
  function buildLockViolations(profile, build) {
    var out = [];
    if (!build) return out;
    var pc = pathCollections();
    var evNoIce = getPath(build, 'engine.type') === 'ev';
    var isEv = function (p) { return evNoIce && (p === 'engine.layout' || p === 'engine.aspiration' || p === 'engine.fuel' || p === 'engine.exhaust'); };
    var iceOnly = getPath(build, 'engine.type') === 'ice';
    for (var p in pc) {
      var v = getPath(build, p);
      if (v === undefined || v === null) continue;
      if (isEv(p)) continue; // irrelevant on EVs
      if (iceOnly && (p === 'engine.chemistry' || p === 'engine.voltage')) continue;
      if (p === 'drivetrain.centerDiff' && getPath(build, 'drivetrain.layout') !== 'awd') continue;
      if (!isUnlocked(profile, pc[p], v)) {
        out.push({ kind: 'part', path: p, collection: pc[p], id: v, name: partName(pc[p], v),
          level: partUnlockLevel(pc[p], v), category: collectionLabel(pc[p]) });
      }
    }
    for (var f in FEATURE_UNLOCKS) {
      if (getPath(build, f) === true && !isFeatureUnlocked(profile, f)) {
        out.push({ kind: 'feature', path: f, collection: null, id: true, name: FEATURE_UNLOCKS[f].name,
          level: FEATURE_UNLOCKS[f].level, category: 'Feature' });
      }
    }
    out.sort(function (a, b) { return b.level - a.level; });
    return out;
  }

  /* Best unlocked substitute: prefer the most expensive unlocked option not above the current price
     (closest downgrade), else the cheapest unlocked. */
  function substitute(profile, coll, currentId, build, path) {
    var list = catalogList(coll);
    var ids = list ? list.map(function (x) { return x.id; }) : Object.keys(UNLOCK_TABLE[coll] || {});
    var curPrice = partPrice(coll, currentId);
    var bodyStyle = getPath(build, 'body.style');
    var bs = findPart('bodyStyles', bodyStyle);
    var cands = ids.filter(function (id) {
      if (!isUnlocked(profile, coll, id)) return false;
      if (path === 'engine.position' && bs && Array.isArray(bs.allowedEnginePositions)) return bs.allowedEnginePositions.indexOf(id) >= 0;
      if (path === 'transmission.type' && getPath(build, 'engine.type') !== 'ev' && id === 'single-speed') return false;
      if (path === 'transmission.type' && getPath(build, 'engine.type') === 'ev') return id === 'single-speed';
      return true;
    });
    if (!cands.length) return currentId;
    var below = cands.filter(function (id) { return partPrice(coll, id) <= curPrice; });
    var pick = below.length ? below : cands;
    pick.sort(function (a, b) { return below.length ? partPrice(coll, b) - partPrice(coll, a) : partPrice(coll, a) - partPrice(coll, b); });
    return pick[0];
  }

  function clampBuildToUnlocks(profile, build) {
    var b = clone(build || (D() && D().defaultBuild ? D().defaultBuild() : {}));
    var changes = [];
    var order = ['body.style', 'engine.type', 'engine.position'];
    var pc = pathCollections();
    var paths = order.concat(Object.keys(pc).filter(function (p) { return order.indexOf(p) < 0; }));
    paths.forEach(function (p) {
      var coll = pc[p];
      if (!coll) return;
      var v = getPath(b, p);
      if (v === undefined || v === null) return;
      if (!isUnlocked(profile, coll, v)) {
        var nv = substitute(profile, coll, v, b, p);
        if (nv !== v) { setPathMut(b, p, nv); changes.push({ path: p, from: v, to: nv }); }
      }
    });
    for (var f in FEATURE_UNLOCKS) {
      if (getPath(b, f) === true && !isFeatureUnlocked(profile, f)) { setPathMut(b, f, false); changes.push({ path: f, from: true, to: false }); }
    }
    // numeric consistency after layout / gearbox swaps
    var layout = findPart('engineLayouts', getPath(b, 'engine.layout'));
    if (layout && Array.isArray(layout.displacementRange) && b.engine) {
      b.engine.displacement_l = Math.round(clamp(num(b.engine.displacement_l, layout.displacementRange[0]), layout.displacementRange[0], layout.displacementRange[1]) * 10) / 10;
    }
    if (getPath(b, 'engine.aspiration') === 'na' && b.engine) b.engine.boost_bar = 0;
    var caps = numericCaps(profile);
    for (var cp in caps) {
      var cv = getPath(b, cp);
      if (typeof cv === 'number' && cv > caps[cp]) { setPathMut(b, cp, caps[cp]); changes.push({ path: cp, from: cv, to: caps[cp] }); }
    }
    var tr = findPart('transmissions', getPath(b, 'transmission.type'));
    if (tr && Array.isArray(tr.gearRange) && b.transmission) {
      var g = clamp(Math.round(num(b.transmission.gears, tr.gearRange[0])), tr.gearRange[0], tr.gearRange[1]);
      if (g !== b.transmission.gears || !Array.isArray(b.transmission.ratios) || b.transmission.ratios.length !== g) {
        b.transmission.gears = g;
        var first = 3.6, last = g > 1 ? 0.8 : 1;
        var r = [];
        for (var i = 0; i < g; i++) r.push(g === 1 ? 1 : Math.round(first * Math.pow(last / first, i / (g - 1)) * 100) / 100);
        b.transmission.ratios = r;
      }
    }
    if (CB.state && typeof CB.state.normalize === 'function') {
      try { b = CB.state.normalize(b); } catch (e) { /* keep our version */ }
    }
    return { build: b, changes: changes };
  }

  /* ------------------------------------------------------------------ pricing */
  function estimateMsrp(build) {
    if (!build) return 0;
    var pc = pathCollections();
    var bs = findPart('bodyStyles', getPath(build, 'body.style'));
    var total = bs && typeof bs.basePrice === 'number' ? bs.basePrice : 45000;
    var type = getPath(build, 'engine.type') || 'ice';
    for (var p in pc) {
      if (p === 'body.style') continue;
      if (type === 'ev' && (p === 'engine.layout' || p === 'engine.aspiration' || p === 'engine.fuel' || p === 'engine.exhaust')) continue;
      if (type === 'ice' && (p === 'engine.chemistry' || p === 'engine.voltage')) continue;
      if (p === 'drivetrain.centerDiff' && getPath(build, 'drivetrain.layout') !== 'awd') continue;
      var v = getPath(build, p);
      if (v === undefined || v === null) continue;
      total += partPrice(pc[p], v);
    }
    var e = build.engine || {};
    if (type !== 'ev') {
      var layout = findPart('engineLayouts', e.layout);
      var base = layout && layout.displacementRange ? layout.displacementRange[0] : 2;
      total += Math.max(0, num(e.displacement_l, base) - base) * 4500;
      total += Math.max(0, num(e.boost_bar, 0)) * 1800;
    }
    if (type !== 'ice') {
      var motors = num(e.motors, 1), kw = num(e.motorPower_kw, 150), kwh = num(e.battery_kwh, 60);
      var chem = findPart('batteryChemistries', e.chemistry);
      var perKwh = chem && typeof chem.pricePerKwh === 'number' ? chem.pricePerKwh : 140;
      total += motors * 4500 + motors * kw * 22 + kwh * perKwh;
    }
    var opts = (D() && D().options) || {};
    var flags = { 'transmission.launchControl': 'launchControl', 'drivetrain.torqueVectoring': 'torqueVectoring', 'tech.hud': 'hud',
      'tech.telemetry': 'telemetry', 'tech.liftSystem': 'liftSystem', 'tech.nightVision': 'nightVision',
      'interior.ambientLighting': 'ambientLighting', 'interior.harness': 'harness', 'tech.digitalCluster': 'digitalCluster',
      'aero.canards': 'canards', 'aero.sideSkirts': 'sideSkirts', 'aero.activeAero': 'activeAero' };
    for (var fp in flags) if (getPath(build, fp) === true) total += num(opts[flags[fp]], 1000);
    var br = build.brakes || {};
    total += Math.max(0, num(br.frontRotor_mm, 330) - 300) * num(opts.perRotorMm, 18);
    total += (num(br.frontPistons, 4) + num(br.rearPistons, 2)) * num(opts.perPiston, 220);
    total += Math.max(0, num(getPath(build, 'wheels.diameter_in'), 18) - 17) * num(opts.perInchDiameter, 350);
    total += num(getPath(build, 'tech.climateZones'), 2) * num(opts.perClimateZone, 650);
    total += num(getPath(build, 'weight.ballast_kg'), 0) * num(opts.ballastPerKg, 6);
    var dest = D() && D().constants && D().constants.destinationFee;
    total += num(dest, 1995);
    return Math.max(5000, Math.round(total));
  }

  function msrp(build) {
    var P = CB.pricing;
    if (P && typeof P.compute === 'function' && build) {
      try {
        var r = P.compute(build);
        if (r && isFinite(r.total) && r.total > 0) {
          return { total: r.total, subtotal: isFinite(r.subtotal) ? r.subtotal : r.total, source: 'pricing', detail: r };
        }
      } catch (e) { /* fall through */ }
    }
    var est = estimateMsrp(build);
    return { total: est, subtotal: est, source: 'estimate', detail: null };
  }

  function carQuote(build) {
    var m = msrp(build);
    return { msrp: m.total, factor: CAREER_PRICE_FACTOR, credits: Math.max(100, round(m.total * CAREER_PRICE_FACTOR, 100)), source: m.source };
  }
  function carCost(build) { return carQuote(build).credits; }

  function partCost(collOrPath, id) {
    var coll = resolveCollection(collOrPath);
    return Math.max(0, Math.round(partPrice(coll, id) * CAREER_PRICE_FACTOR));
  }

  function leafDiff(a, b, prefix, out) {
    out = out || [];
    var keys = {};
    var k;
    if (a && typeof a === 'object' && !Array.isArray(a)) for (k in a) keys[k] = 1;
    if (b && typeof b === 'object' && !Array.isArray(b)) for (k in b) keys[k] = 1;
    for (k in keys) {
      if (!prefix && k === 'meta') continue;
      var pa = a ? a[k] : undefined, pb = b ? b[k] : undefined, path = prefix ? prefix + '.' + k : k;
      var objA = pa && typeof pa === 'object' && !Array.isArray(pa), objB = pb && typeof pb === 'object' && !Array.isArray(pb);
      if (objA || objB) leafDiff(pa, pb, path, out);
      else if (JSON.stringify(pa) !== JSON.stringify(pb)) out.push({ path: path, from: pa, to: pb });
    }
    return out;
  }

  /** A car that was never paid for (the free career entry car: purchasedFor <= 1 / car.entryCar) earns no part refunds. */
  function refundsBlocked(opts) {
    if (!opts || typeof opts !== 'object') return false;
    if (opts.noRefunds === true) return true;
    var car = opts.car;
    return !!(car && typeof car === 'object' && (car.entryCar === true || (isFinite(car.purchasedFor) && car.purchasedFor > 0 && car.purchasedFor <= 1)));
  }
  /** upgradeQuote(oldBuild, newBuild, opts? {car, noRefunds}) — opts.car = the owned car being upgraded (refund rules). */
  function upgradeQuote(oldBuild, newBuild, opts) {
    var f = CAREER_PRICE_FACTOR;
    var noRefund = refundsBlocked(opts);
    var pc = pathCollections();
    var lines = [], partsTotal = 0, refunds = 0, labor = 0, catalogMsrpDelta = 0, changedParts = 0;
    var diffs = leafDiff(oldBuild || {}, newBuild || {}, '', []);
    var tuneChanges = 0;
    diffs.forEach(function (d) {
      var coll = pc[d.path];
      if (coll) {
        var fromP = partPrice(coll, d.from), toP = partPrice(coll, d.to);
        var cost = Math.round(Math.max(0, toP) * f);
        var refund = noRefund ? 0 : Math.round(Math.max(0, fromP) * f * PART_REFUND_RATE);
        catalogMsrpDelta += toP - fromP;
        partsTotal += cost; refunds += refund; labor += LABOR_PER_PART; changedParts++;
        lines.push({ kind: 'part', path: d.path, category: collectionLabel(coll), from: d.from, to: d.to,
          fromName: partName(coll, d.from), toName: partName(coll, d.to),
          label: collectionLabel(coll) + ': ' + partName(coll, d.from) + ' → ' + partName(coll, d.to),
          cost: cost, refund: refund, net: cost - refund });
      } else if (FEATURE_UNLOCKS[d.path] || typeof d.from === 'boolean' || typeof d.to === 'boolean') {
        labor += LABOR_PER_TUNE; tuneChanges++;
        lines.push({ kind: 'option', path: d.path, from: d.from, to: d.to,
          label: (FEATURE_UNLOCKS[d.path] ? FEATURE_UNLOCKS[d.path].name : d.path) + (d.to ? ' fitted' : ' removed'), cost: 0, refund: 0, net: 0 });
      } else {
        labor += LABOR_PER_TUNE; tuneChanges++;
      }
    });
    if (!diffs.length) {
      return { lines: [], parts: 0, refunds: 0, labor: 0, adjustments: 0, total: 0, changes: 0, partChanges: 0, tuneChanges: 0 };
    }
    // Residual (displacement, rotor sizes, options, paint …) priced from the MSRP delta not explained by catalog parts.
    var mOld = msrp(oldBuild), mNew = msrp(newBuild);
    var residual = (mNew.subtotal - mOld.subtotal) - catalogMsrpDelta;
    var adjustments = residual >= 0 ? Math.round(residual * f) : noRefund ? 0 : Math.round(residual * f * PART_REFUND_RATE);
    if (Math.abs(adjustments) >= 1) {
      lines.push({ kind: 'adjustment', path: null, label: residual >= 0 ? 'Spec, options & tuning changes' : 'Spec downgrades (50% refund)',
        cost: Math.max(0, adjustments), refund: Math.max(0, -adjustments), net: adjustments });
    }
    if (tuneChanges) lines.push({ kind: 'labor', label: 'Setup & tuning labour (' + tuneChanges + (tuneChanges === 1 ? ' adjustment)' : ' adjustments)'), cost: tuneChanges * LABOR_PER_TUNE, refund: 0, net: tuneChanges * LABOR_PER_TUNE });
    if (changedParts) lines.push({ kind: 'labor', label: 'Fitting labour (' + changedParts + (changedParts === 1 ? ' component)' : ' components)'), cost: changedParts * LABOR_PER_PART, refund: 0, net: changedParts * LABOR_PER_PART });
    var total = partsTotal - refunds + adjustments + labor;
    return { lines: lines, parts: partsTotal, refunds: refunds, labor: labor, adjustments: adjustments,
      total: round(total, 10), changes: diffs.length, partChanges: changedParts, tuneChanges: tuneChanges,
      msrpBefore: mOld.total, msrpAfter: mNew.total };
  }
  function upgradeCost(oldBuild, newBuild, opts) { return upgradeQuote(oldBuild, newBuild, opts).total; }

  function carBasis(car) {
    if (!car) return 0;
    if (isFinite(car.purchasedFor) && car.purchasedFor > 0) return car.purchasedFor;
    return car.build ? carCost(car.build) : 0;
  }

  function carValue(car) {
    var basis = carBasis(car);
    var km = Math.max(0, num(car && car.odometer_km, 0));
    var cond = clamp(num(car && car.condition, 1), 0, 1);
    var mileage = 0.4 + 0.6 * Math.exp(-km / 25000);
    var condition = 0.45 + 0.55 * cond;
    var wins = Math.max(0, num(car && car.wins, 0));
    var pedigree = 1 + Math.min(0.15, wins * 0.01);
    return { basis: basis, mileage: mileage, condition: condition, pedigree: pedigree, value: basis * mileage * condition * pedigree };
  }

  function sellQuote(car) {
    var v = carValue(car);
    var dealer = 0.72;
    var credits = Math.max(0, round(v.value * dealer, 100));
    return {
      credits: credits, basis: v.basis,
      factors: { dealerMargin: dealer, mileage: v.mileage, condition: v.condition, pedigree: v.pedigree },
      lines: [
        { label: 'Purchase basis', credits: Math.round(v.basis) },
        { label: 'Mileage (' + fmtInt(num(car && car.odometer_km, 0)) + ' km) ×' + v.mileage.toFixed(2), credits: Math.round(v.basis * (v.mileage - 1)) },
        { label: 'Condition ' + Math.round(clamp(num(car && car.condition, 1), 0, 1) * 100) + '% ×' + v.condition.toFixed(2), credits: Math.round(v.basis * v.mileage * (v.condition - 1)) },
        { label: 'Race pedigree (' + num(car && car.wins, 0) + ' wins) ×' + v.pedigree.toFixed(2), credits: Math.round(v.basis * v.mileage * v.condition * (v.pedigree - 1)) },
        { label: 'Dealer margin ×' + dealer, credits: Math.round(v.value * (dealer - 1)) }
      ]
    };
  }
  function sellValue(car) { return sellQuote(car).credits; }

  function repairQuote(car, target) {
    var to = clamp(num(target, 1), 0, 1);
    var from = clamp(num(car && car.condition, 1), 0, 1);
    if (to <= from + 1e-6) return { credits: 0, lines: [], from: from, to: Math.max(from, to) };
    var basis = carBasis(car);
    var wearCost = (Math.pow(1 - from, 1.25) - Math.pow(1 - to, 1.25)) * basis * 0.18;
    var lines = [{ label: 'Bodywork & mechanical (' + Math.round(from * 100) + '% → ' + Math.round(to * 100) + '%)', credits: Math.round(wearCost) }];
    var dmg = car && car.damage;
    if (dmg && typeof dmg === 'object') {
      var DMG_COST = { front: 0.012, rear: 0.010, left: 0.008, right: 0.008, engine: 0.03, aero: 0.015 };
      for (var k in DMG_COST) {
        var d = clamp(num(dmg[k], 0), 0, 1);
        if (d > 0.01) lines.push({ label: 'Damage: ' + k, credits: Math.round(d * basis * DMG_COST[k]) });
      }
    }
    lines.push({ label: 'Workshop call-out', credits: 250 });
    var total = 0;
    lines.forEach(function (l) { total += l.credits; });
    return { credits: round(total, 10), lines: lines, from: from, to: to };
  }
  function repairCost(car, target) { return repairQuote(car, target).credits; }

  var ENTRY_FEE_BY_TIER = [0, 1500, 5000, 12000, 30000];
  function entryFee(opts) {
    opts = opts || {};
    var tier = clamp(Math.round(num(opts.tier, 0)), 0, ENTRY_FEE_BY_TIER.length - 1);
    var base = ENTRY_FEE_BY_TIER[tier];
    var dm = { rookie: 0.8, amateur: 1, pro: 1.15, alien: 1.3 }[normDifficulty(opts.difficulty)];
    var ev = { endurance: 1.5, rivals: 0.6, 'time-attack': 0.5, drag: 0.4, drift: 0.5, eliminator: 0.9, manufacturer: 1.0 }[opts.eventType] || 1;
    return round(base * dm * ev, 50);
  }

  function pitServiceCost(req, build) {
    req = req || {};
    var lines = [];
    if (req.tires) {
      var comp = req.compound || getPath(build, 'tires.compound') || 'performance';
      var per = partPrice('tireCompounds', comp) || 300;
      lines.push({ label: 'Tyres: 4× ' + partName('tireCompounds', comp), credits: Math.round(per * 4 * CAREER_PRICE_FACTOR) });
    }
    if (num(req.fuel_l, 0) > 0) {
      var fuel = getPath(build, 'engine.fuel');
      var perL = { regular: 1.6, premium: 1.9, e85: 1.4, race: 4.5, diesel: 1.7 }[fuel] || 1.8;
      if (getPath(build, 'engine.type') === 'ev') { perL = 0.35; }
      lines.push({ label: (getPath(build, 'engine.type') === 'ev' ? 'Charge ' : 'Fuel ') + Math.round(req.fuel_l) + (getPath(build, 'engine.type') === 'ev' ? ' kWh' : ' L'), credits: Math.round(req.fuel_l * perL) });
    }
    if (req.repair) lines.push({ label: 'Pit repairs', credits: 600 });
    var total = 0;
    lines.forEach(function (l) { total += l.credits; });
    return { credits: total, lines: lines };
  }

  function canAfford(profile, n) { return num(profile && profile.credits, 0) >= num(n, 0); }

  /* ------------------------------------------------------------------ race rewards */
  var BASE_PURSE = 4000;

  function positionShare(position, fieldSize) {
    if (fieldSize <= 1) return 0.45; // solo run (time trial / challenge)
    var p = clamp(Math.round(position), 1, fieldSize);
    var top = [1.0, 0.72, 0.55];
    if (p <= 3 && p <= fieldSize) {
      if (p === fieldSize && fieldSize <= 3) return Math.min(top[p - 1], fieldSize === 2 ? 0.5 : 0.4);
      return top[p - 1];
    }
    var rest = fieldSize - 3; // positions 4..fieldSize spread 0.45 -> 0.12
    var t = rest <= 1 ? 0 : (p - 4) / (rest - 1);
    return 0.45 - (0.45 - 0.12) * t;
  }

  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function raceRewards(o) {
    o = o || {};
    var fieldSize = Math.max(1, Math.round(num(o.fieldSize, 1)));
    var position = clamp(Math.round(num(o.position, fieldSize)), 1, fieldSize);
    var diff = normDifficulty(o.difficulty);
    var dm = DIFFICULTY_MULT[diff], dxm = DIFFICULTY_XP_MULT[diff];
    var laps = Math.max(1, Math.round(num(o.laps, 3)));
    var def = o.trackId ? trackDefFor(o.trackId) : null;
    var trackDiff = clamp(num(o.trackDifficulty, def && def.difficulty ? def.difficulty : 3), 1, 5);
    var lenM = num(o.trackLength_m, def && def.length_m ? def.length_m : 0);
    var distanceKm = lenM > 0 ? laps * lenM / 1000 : laps * 3.5;
    var distFactor = clamp(0.6 + 0.07 * distanceKm, 0.6, 3.5);
    var trackFactor = 0.85 + 0.15 * trackDiff;
    var fieldFactor = clamp(0.7 + 0.05 * (fieldSize - 1), 0.7, 1.25);
    var userMult = num(o.multiplier, 1) > 0 ? num(o.multiplier, 1) : 1;
    var purse = BASE_PURSE * distFactor * trackFactor * fieldFactor;
    var dnf = !!o.dnf;
    var mode = o.mode || 'race';
    var breakdown = [];
    function line(label, credits, xp, kind) { breakdown.push({ label: label, credits: Math.round(credits), xp: Math.round(xp), kind: kind || 'bonus' }); }

    var share = dnf ? 0 : positionShare(position, fieldSize);
    if (dnf) {
      line('Starting money (DNF)', purse * 0.1, 40 * dxm, 'base');
    } else if (fieldSize <= 1) {
      line(mode === 'time-trial' ? 'Time trial completed' : 'Session completed', purse * share, (120 + 80 * distFactor) * dxm, 'base');
    } else {
      line('Finished ' + ordinal(position) + ' of ' + fieldSize, purse * share, (120 + 380 * share) * distFactor * dxm, 'base');
    }
    var base = breakdown[0].credits;
    if (Math.abs(dm - 1) > 1e-6 && base > 0) line('Difficulty: ' + DIFFICULTY_LABEL[diff] + ' ×' + dm.toFixed(2), base * (dm - 1), 0, 'multiplier');

    if (!dnf && fieldSize > 1) {
      if (position === 1) line('Victory bonus', purse * 0.15 * dm, 150 * dxm, 'bonus');
      else if (position <= 3) line('Podium bonus', purse * 0.05 * dm, 60 * dxm, 'bonus');
      if (o.cleanRace) line('Clean race', Math.max(500, purse * 0.1) * dm, 50 * dxm, 'bonus');
      if (o.fastestLap) line('Fastest lap', 1500 * dm, 75 * dxm, 'bonus');
      if (o.pole) line('Pole position', 1000 * dm, 50 * dxm, 'bonus');
      var ov = clamp(Math.round(num(o.overtakes, 0)), 0, 40);
      if (ov > 0) line('Overtakes ×' + ov, Math.min(ov, 20) * 150 * dm, ov * 10 * dxm, 'bonus');
      var led = clamp(Math.round(num(o.lapsLed, 0)), 0, laps);
      if (led > 0) line('Laps led ×' + led, led * 200 * dm, led * 15 * dxm, 'bonus');
      if (led >= laps && laps > 1 && position === 1) line('Led every lap', 2000 * dm, 100 * dxm, 'bonus');
      var grid = Math.round(num(o.gridPosition, 0));
      if (grid > 0) {
        var gained = grid - position;
        if (gained > 0) line('Positions gained ×' + gained, gained * 250 * dm, gained * 12 * dxm, 'bonus');
        if (grid === fieldSize && position === 1 && fieldSize >= 4) line('Comeback: last to first', 5000 * dm, 250 * dxm, 'bonus');
      }
    } else if (!dnf && fieldSize <= 1) {
      if (o.cleanRace) line('Clean run', 400 * dm, 30 * dxm, 'bonus');
    }
    var pen = num(o.penalties_s, 0);
    if (pen > 0) line('Penalties (' + pen.toFixed(1) + ' s)', -Math.min(pen * 100, 5000), -Math.min(pen * 5, 100), 'penalty');

    var subtotal = 0, xpSub = 0;
    breakdown.forEach(function (l) { subtotal += l.credits; xpSub += l.xp; });
    if (userMult !== 1) {
      breakdown.push({ label: (o.multiplierLabel || 'Event multiplier') + ' ×' + userMult.toFixed(2),
        credits: Math.round(subtotal * (userMult - 1)), xp: Math.round(xpSub * (userMult - 1)), kind: 'multiplier' });
    }
    var credits = 0, xp = 0;
    breakdown.forEach(function (l) { credits += l.credits; xp += l.xp; });
    var rawCredits = credits;
    credits = Math.max(0, round(credits, 10));
    xp = Math.max(0, Math.round(xp));
    // the payout is rounded to 10 CR: fold that rounding into the base line so the shown lines add up to the total
    if (credits > 0 && credits !== rawCredits && breakdown.length) breakdown[0].credits += credits - rawCredits;
    return {
      credits: credits, xp: xp, breakdown: breakdown,
      summary: { position: position, fieldSize: fieldSize, difficulty: diff, difficultyMult: dm, share: share, purse: Math.round(purse),
        distance_km: Math.round(distanceKm * 10) / 10, trackDifficulty: trackDiff, dnf: dnf, mode: mode, multiplier: userMult }
    };
  }

  /* Extract the player's row and derive reward inputs from a session results() payload.
     Accepts: array of rows | {cars|order|classification|standings|results: rows, fastestLap, config, laps}. */
  function resultRows(results) {
    if (!results) return [];
    if (Array.isArray(results)) return results;
    var keys = ['cars', 'classification', 'order', 'standings', 'results', 'rows', 'finishers'];
    for (var i = 0; i < keys.length; i++) if (Array.isArray(results[keys[i]])) return results[keys[i]];
    return [];
  }

  function outcomeFromResults(results, opts) {
    opts = opts || {};
    results = results || {};
    var rows = resultRows(results);
    var cfg = results.config || opts.config || {};
    var playerId = opts.playerId != null ? opts.playerId : (results.playerId != null ? results.playerId : null);
    var me = null, idx = -1;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r) continue;
      if ((playerId != null && r.id === playerId) || (playerId == null && (r.isPlayer || r.player))) { me = r; idx = i; break; }
    }
    if (!me && !Array.isArray(results) && results.player && typeof results.player === 'object') {
      me = results.player;
      for (var pi = 0; pi < rows.length; pi++) if (rows[pi] && rows[pi].id === me.id) { idx = pi; break; }
    }
    if (!me && !Array.isArray(results) && (results.position != null)) me = results; // already a player result object
    me = me || {};
    var lapPos = Array.isArray(me.positionsByLap) ? me.positionsByLap.filter(function (x) { return isFinite(x) && x > 0; }) : [];
    var fieldSize = num(opts.fieldSize, num(results.fieldSize, rows.length || 1));
    var position = num(me.position, idx >= 0 ? idx + 1 : fieldSize);
    var fl = results.fastestLap;
    var fastest = me.fastestLap === true || (fl && me.id != null && fl.carId === me.id);
    if (!fastest && fl == null && rows.length > 1 && isFinite(me.bestLap_s) && me.bestLap_s > 0) {
      fastest = rows.every(function (r) { return !r || r === me || !(isFinite(r.bestLap_s) && r.bestLap_s > 0) || r.bestLap_s >= me.bestLap_s; });
    }
    var grid = num(me.gridPosition, num(me.grid, num(me.startPosition, 0)));
    // derive laps led / overtakes from the per-lap position trace when the engine does not count them directly
    var lapsLed = me.lapsLed != null ? num(me.lapsLed, 0) : lapPos.filter(function (x) { return x === 1; }).length;
    var overtakes = num(me.overtakes, NaN);
    if (!isFinite(overtakes)) {
      overtakes = 0;
      var prevPos = grid > 0 ? grid : (lapPos.length ? lapPos[0] : 0);
      lapPos.forEach(function (x) { if (prevPos > 0 && x < prevPos) overtakes += prevPos - x; prevPos = x; });
    }
    var outMode = opts.mode || cfg.mode || results.mode || 'race';
    // a race session closed before the flag (player retired / quit) leaves the player 'running': that is a DNF,
    // exactly as CB.game.profile.recordRaceStats and CB.game.career classify it
    var isDnf = !!me.dnf || !!me.dsq || !!me.retired || me.status === 'dnf' || me.status === 'dsq' ||
      (!Array.isArray(results) && results.complete === false && me.status === 'running' && outMode === 'race' && opts.countUnfinishedAsDnf !== false);
    var collisions = me.collisions != null ? num(me.collisions, 0) : (me.contacts != null ? num(me.contacts, 0) : null);
    var wallHits = num(me.wallHits, 0);
    var penalties = num(me.penalties_s, 0);
    var clean = me.cleanRace != null ? !!me.cleanRace
      : (collisions == null ? penalties <= 0 && wallHits === 0 : collisions === 0 && wallHits === 0 && penalties <= 0);
    return {
      position: position, fieldSize: fieldSize,
      difficulty: opts.difficulty || cfg.difficulty || results.difficulty || 'amateur',
      laps: num(opts.laps, num(cfg.laps, num(results.lapsTotal, num(results.laps, 3)))),
      trackId: opts.trackId || cfg.trackId || results.trackId || null,
      trackLength_m: num(opts.trackLength_m, num(results.trackLength_m, 0)) || undefined,
      trackDifficulty: opts.trackDifficulty,
      cleanRace: clean, fastestLap: !!fastest,
      pole: me.pole === true || grid === 1,
      overtakes: overtakes, lapsLed: lapsLed,
      gridPosition: grid || undefined, penalties_s: penalties,
      dnf: isDnf, mode: outMode,
      multiplier: opts.multiplier, multiplierLabel: opts.multiplierLabel,
      collisions: collisions == null ? 0 : collisions,
      engineType: opts.engineType || getPath(me.build || opts.build || cfg.playerBuild, 'engine.type') || null,
      build: me.build || opts.build || cfg.playerBuild || null,
      topSpeed_kph: num(me.topSpeed_kph, 0),
      bestLap_s: num(me.bestLap_s, 0)
    };
  }

  function rewardsFromResults(results, opts) { return raceRewards(outcomeFromResults(results, opts)); }

  /* ------------------------------------------------------------------ sponsors */
  function logo(shape, c1, c2, letter) {
    var inner = {
      drop: '<path d="M32 8 C44 26 50 34 50 42 a18 18 0 0 1 -36 0 C14 34 20 26 32 8 Z" fill="' + c1 + '"/>',
      ring: '<circle cx="32" cy="32" r="20" fill="none" stroke="' + c1 + '" stroke-width="7"/><circle cx="32" cy="32" r="7" fill="' + c2 + '"/>',
      bolt: '<path d="M36 6 L16 36 H30 L26 58 L48 26 H34 Z" fill="' + c1 + '"/>',
      crown: '<path d="M10 44 L14 20 L24 32 L32 14 L40 32 L50 20 L54 44 Z" fill="' + c1 + '"/><rect x="10" y="46" width="44" height="6" fill="' + c2 + '"/>',
      wave: '<path d="M6 38 Q18 22 30 38 T54 38" fill="none" stroke="' + c1 + '" stroke-width="6" stroke-linecap="round"/><circle cx="46" cy="18" r="6" fill="' + c2 + '"/>'
    }[shape] || '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect x="1" y="1" width="62" height="62" rx="14" fill="#0e0f12" stroke="' + c2 + '" stroke-width="2"/>' + inner +
      (letter ? '<text x="32" y="60" font-family="sans-serif" font-size="9" font-weight="700" text-anchor="middle" fill="' + c2 + '">' + letter + '</text>' : '') + '</svg>';
  }

  /* Objective templates. per-race objectives pay each race they are met; cumulative ones pay once when reached. */
  var OBJECTIVE_TYPES = {
    'finish':           { scope: 'race', desc: function () { return 'Finish the race (no DNF)'; }, test: function (o) { return !o.dnf; } },
    'finish-top':       { scope: 'race', desc: function (t) { return 'Finish in the top ' + t; }, test: function (o, t) { return !o.dnf && o.position <= t; } },
    'podium':           { scope: 'race', desc: function () { return 'Finish on the podium'; }, test: function (o) { return !o.dnf && o.position <= 3 && o.fieldSize > 1; } },
    'win':              { scope: 'race', desc: function () { return 'Win the race'; }, test: function (o) { return !o.dnf && o.position === 1 && o.fieldSize > 1; } },
    'clean-race':       { scope: 'race', desc: function () { return 'Race clean — no contact or penalties'; }, test: function (o) { return !o.dnf && !!o.cleanRace; } },
    'fastest-lap':      { scope: 'race', desc: function () { return 'Set the fastest lap'; }, test: function (o) { return !!o.fastestLap; } },
    'pole':             { scope: 'race', desc: function () { return 'Start from pole position'; }, test: function (o) { return !!o.pole; } },
    'overtakes':        { scope: 'race', desc: function (t) { return 'Make ' + t + '+ overtakes in a race'; }, test: function (o, t) { return o.overtakes >= t; } },
    'laps-led':         { scope: 'race', desc: function (t) { return 'Lead ' + t + '+ laps in a race'; }, test: function (o, t) { return o.lapsLed >= t; } },
    'positions-gained': { scope: 'race', desc: function (t) { return 'Gain ' + t + '+ places from the grid'; }, test: function (o, t) { return o.gridPosition > 0 && !o.dnf && (o.gridPosition - o.position) >= t; } },
    'total-overtakes':  { scope: 'total', desc: function (t) { return 'Make ' + t + ' overtakes over the contract'; }, value: function (o) { return o.overtakes; } },
    'total-wins':       { scope: 'total', desc: function (t) { return 'Win ' + t + ' races over the contract'; }, value: function (o) { return !o.dnf && o.position === 1 && o.fieldSize > 1 ? 1 : 0; } },
    'total-podiums':    { scope: 'total', desc: function (t) { return 'Score ' + t + ' podiums over the contract'; }, value: function (o) { return !o.dnf && o.position <= 3 && o.fieldSize > 1 ? 1 : 0; } },
    'total-laps-led':   { scope: 'total', desc: function (t) { return 'Lead ' + t + ' laps over the contract'; }, value: function (o) { return o.lapsLed; } },
    'total-clean':      { scope: 'total', desc: function (t) { return 'Complete ' + t + ' clean races'; }, value: function (o) { return !o.dnf && o.cleanRace ? 1 : 0; } }
  };

  var SPONSORS = [
    {
      id: 'vantor', name: 'Vantor Lubricants', tagline: 'Every drop engineered.', colors: ['#f2b705', '#ffffff'],
      icon: logo('drop', '#f2b705', '#ffffff', 'VANTOR'), minLevel: 1, prestige: 1,
      requirements: {}, maxDnfs: 2,
      pool: [['finish', 0, 600, 20], ['finish-top', 5, 1200, 40], ['clean-race', 0, 1000, 40], ['total-clean', 2, 3000, 120], ['total-podiums', 1, 3500, 150]],
      retainer: 800, signing: 3000, completion: 6000, races: [3, 4]
    },
    {
      id: 'helix', name: 'Helix Tyres', tagline: 'Grip is a science.', colors: ['#e63946', '#f1f1f1'],
      icon: logo('ring', '#e63946', '#f1f1f1', 'HELIX'), minLevel: 3, prestige: 2,
      requirements: {}, maxDnfs: 2,
      pool: [['fastest-lap', 0, 2500, 80], ['overtakes', 3, 1500, 50], ['podium', 0, 2200, 70], ['total-overtakes', 12, 5000, 200], ['clean-race', 0, 1200, 40]],
      retainer: 1200, signing: 6000, completion: 12000, races: [3, 5]
    },
    {
      id: 'aurora', name: 'Aurora Grid Energy', tagline: 'Charged with tomorrow.', colors: ['#2ec4b6', '#cbf3f0'],
      icon: logo('bolt', '#2ec4b6', '#cbf3f0', 'AURORA'), minLevel: 4, prestige: 2,
      requirements: { engineTypes: ['ev', 'hybrid'] }, maxDnfs: 2,
      pool: [['finish-top', 3, 2400, 80], ['clean-race', 0, 1500, 50], ['laps-led', 1, 1800, 60], ['total-podiums', 2, 7000, 250], ['finish', 0, 900, 30]],
      retainer: 1600, signing: 8000, completion: 15000, races: [3, 5],
      hybridPenalty: 0.6 /* hybrids earn 60% */
    },
    {
      id: 'nimbus', name: 'Nimbus Telecom', tagline: 'Live from the apex.', colors: ['#7b2ff7', '#f107a3'],
      icon: logo('wave', '#7b2ff7', '#f107a3', 'NIMBUS'), minLevel: 6, prestige: 3,
      requirements: { minFieldSize: 6 }, maxDnfs: 2,
      pool: [['positions-gained', 3, 2500, 90], ['overtakes', 5, 2200, 80], ['laps-led', 2, 2600, 90], ['total-overtakes', 20, 9000, 320], ['total-laps-led', 8, 9000, 320]],
      retainer: 2200, signing: 12000, completion: 22000, races: [4, 6]
    },
    {
      id: 'kestrel', name: 'Kestrel Chronographs', tagline: 'Precision, at any speed.', colors: ['#c9a227', '#1d1d1f'],
      icon: logo('crown', '#c9a227', '#f5e6b3', 'KESTREL'), minLevel: 9, prestige: 4,
      requirements: { minDifficulty: 'pro' }, maxDnfs: 1,
      pool: [['pole', 0, 4000, 120], ['win', 0, 6000, 200], ['fastest-lap', 0, 3500, 110], ['total-wins', 2, 18000, 600], ['clean-race', 0, 2500, 80]],
      retainer: 3500, signing: 25000, completion: 45000, races: [3, 5]
    }
  ];

  function getSponsor(id) {
    for (var i = 0; i < SPONSORS.length; i++) if (SPONSORS[i].id === id) return SPONSORS[i];
    return null;
  }

  function maxActiveContracts(level) { level = num(level, 1); return level >= 12 ? 3 : level >= 6 ? 2 : 1; }

  function activeContracts(profile) {
    if (!profile) return [];
    var s = profile.sponsors || (profile.career && profile.career.sponsors) || null;
    if (!s) return [];
    if (Array.isArray(s)) return s.filter(function (c) { return c && (c.status || 'active') === 'active'; });
    return (s.active || []).filter(function (c) { return c && (c.status || 'active') === 'active'; });
  }

  function contractTierFor(level, prestige) {
    var over = level - (prestige * 3 - 2);
    if (over >= 10) return { id: 'gold', label: 'Gold', mult: 1.6 };
    if (over >= 4) return { id: 'silver', label: 'Silver', mult: 1.25 };
    return { id: 'bronze', label: 'Bronze', mult: 1.0 };
  }

  function buildObjective(tpl, scale, idx) {
    var type = tpl[0], target = tpl[1], T = OBJECTIVE_TYPES[type];
    return { id: 'o' + idx + '-' + type, type: type, target: target, scope: T.scope, desc: T.desc(target),
      reward: { credits: round(tpl[2] * scale, 50), xp: Math.round(tpl[3] * Math.sqrt(scale)) } };
  }

  function getSponsorOffers(profile, opts) {
    opts = opts || {};
    var level = profileLevel(profile);
    var races = num(profile && profile.stats && profile.stats.races, 0);
    var epoch = Math.floor(races / 3);
    var active = activeContracts(profile).map(function (c) { return c.sponsorId; });
    var seed = hashStr((profile && (profile.driverName || profile.createdAt)) || 'forge') ^ hashStr('epoch' + epoch + ':' + (opts.seed || 0));
    var R = rng(seed);
    var count = num(opts.count, 3);
    var slotsFree = Math.max(0, maxActiveContracts(level) - active.length);
    var elig = SPONSORS.filter(function (s) { return s.minLevel <= level && active.indexOf(s.id) < 0; });
    // shuffle (deterministic) then sort by prestige desc so the best sponsors bubble up but rotate
    var shuffled = elig.map(function (s) { return { s: s, k: R() + s.prestige * 0.15 }; })
      .sort(function (a, b) { return b.k - a.k; }).map(function (x) { return x.s; });
    var offers = shuffled.slice(0, count).map(function (s) {
      var tier = contractTierFor(level, s.prestige);
      var scale = tier.mult * (1 + 0.06 * (level - 1));
      var pool = s.pool.slice();
      // pick 3 objectives: always one per-race + one cumulative where available
      var picks = [];
      var raceObjs = pool.filter(function (p) { return OBJECTIVE_TYPES[p[0]].scope === 'race'; });
      var totObjs = pool.filter(function (p) { return OBJECTIVE_TYPES[p[0]].scope === 'total'; });
      while (picks.length < 2 && raceObjs.length) picks.push(raceObjs.splice(Math.floor(R() * raceObjs.length), 1)[0]);
      if (totObjs.length) picks.push(totObjs[Math.floor(R() * totObjs.length)]);
      var span = s.races[1] - s.races[0];
      var nRaces = s.races[0] + Math.floor(R() * (span + 1));
      var objectives = picks.map(function (p, i) { return buildObjective(p, scale, i); });
      var offerId = s.id + '-' + epoch + '-' + tier.id;
      return {
        id: offerId, sponsorId: s.id, sponsor: s.name, tagline: s.tagline, colors: s.colors.slice(), icon: s.icon,
        tier: tier.id, tierLabel: tier.label, races: nRaces,
        signingBonus: round(s.signing * scale, 100), retainerPerRace: round(s.retainer * scale, 50),
        completionBonus: { credits: round(s.completion * scale, 100), xp: Math.round(300 * s.prestige * Math.sqrt(scale)),
          requires: 'Complete every cumulative objective by the end of the contract' },
        objectives: objectives,
        requirements: clone(s.requirements), maxDnfs: s.maxDnfs,
        requirementText: requirementText(s.requirements),
        available: slotsFree > 0,
        reason: slotsFree > 0 ? null : 'Contract slots full (' + maxActiveContracts(level) + ' max at level ' + level + ')',
        estimatedValue: 0
      };
    });
    offers.forEach(function (o) {
      var perRace = o.retainerPerRace;
      o.objectives.forEach(function (ob) { if (ob.scope === 'race') perRace += ob.reward.credits * 0.5; });
      var once = 0;
      o.objectives.forEach(function (ob) { if (ob.scope === 'total') once += ob.reward.credits; });
      o.estimatedValue = round(o.signingBonus + perRace * o.races + (once + o.completionBonus.credits) * 0.6, 100);
    });
    return offers;
  }

  function requirementText(req) {
    var out = [];
    if (!req) return out;
    if (req.engineTypes) out.push('Powertrain: ' + req.engineTypes.map(function (t) { return t.toUpperCase(); }).join(' / '));
    if (req.minDifficulty) out.push('AI difficulty ' + DIFFICULTY_LABEL[req.minDifficulty] + ' or harder');
    if (req.minFieldSize) out.push('Fields of ' + req.minFieldSize + '+ cars');
    return out;
  }

  function createContract(offer, now) {
    var c = clone(offer);
    c.contractId = 'sc_' + (offer.id || 'x') + '_' + (now || Date.now()).toString(36);
    c.signedAt = now || Date.now();
    c.status = 'active';
    c.racesCompleted = 0;
    c.racesCounted = 0;
    c.dnfs = 0;
    c.progress = {};
    c.objectives.forEach(function (o) { c.progress[o.id] = { cur: 0, met: 0, done: false }; });
    c.earned = { credits: 0, xp: 0 };
    c.history = [];
    return c;
  }

  function checkSponsorRequirements(contract, o) {
    var req = contract.requirements || {}, reasons = [];
    if (req.engineTypes && req.engineTypes.length) {
      if (!o.engineType || req.engineTypes.indexOf(o.engineType) < 0) reasons.push('Requires ' + req.engineTypes.join('/').toUpperCase() + ' powertrain');
    }
    if (req.minDifficulty && DIFFICULTY_ORDER.indexOf(normDifficulty(o.difficulty)) < DIFFICULTY_ORDER.indexOf(req.minDifficulty)) {
      reasons.push('Requires ' + DIFFICULTY_LABEL[req.minDifficulty] + ' AI or harder');
    }
    if (req.minFieldSize && o.fieldSize < req.minFieldSize) reasons.push('Requires a field of ' + req.minFieldSize + '+ cars');
    return reasons;
  }

  function looksNormalized(r) {
    return r && !Array.isArray(r) && typeof r.position === 'number' && typeof r.fieldSize === 'number' && !resultRows(r).length;
  }

  function evaluateSponsor(contract, results, opts) {
    var c = clone(contract);
    var empty = { contract: c, credits: 0, xp: 0, breakdown: [], met: [], missed: [], eligible: false, completed: false, status: c ? c.status : 'invalid', events: [] };
    if (!c || c.status !== 'active') return empty;
    var o = looksNormalized(results) ? results : outcomeFromResults(results, opts);
    if (!o.engineType && o.build) o.engineType = getPath(o.build, 'engine.type');
    var breakdown = [], met = [], missed = [], events = [];
    var sponsor = getSponsor(c.sponsorId);
    var reasons = checkSponsorRequirements(c, o);
    c.racesCompleted = (c.racesCompleted || 0) + 1;
    var eligible = reasons.length === 0;
    var payMult = 1;
    if (sponsor && sponsor.hybridPenalty && o.engineType === 'hybrid') payMult = sponsor.hybridPenalty;
    if (eligible) {
      c.racesCounted = (c.racesCounted || 0) + 1;
      breakdown.push({ label: c.sponsor + ' retainer', credits: Math.round(c.retainerPerRace * payMult), xp: 0, kind: 'retainer' });
      c.objectives.forEach(function (ob) {
        var T = OBJECTIVE_TYPES[ob.type], pr = c.progress[ob.id] || (c.progress[ob.id] = { cur: 0, met: 0, done: false });
        if (!T) return;
        if (T.scope === 'race') {
          if (T.test(o, ob.target)) {
            pr.met++; pr.cur = pr.met; met.push(ob.id);
            breakdown.push({ label: c.sponsor + ': ' + ob.desc, credits: Math.round(ob.reward.credits * payMult), xp: ob.reward.xp, kind: 'objective' });
          } else missed.push(ob.id);
        } else {
          if (pr.done) return;
          pr.cur += num(T.value(o), 0);
          if (pr.cur >= ob.target) {
            pr.done = true; met.push(ob.id);
            breakdown.push({ label: c.sponsor + ': ' + ob.desc + ' ✔', credits: Math.round(ob.reward.credits * payMult), xp: ob.reward.xp, kind: 'objective' });
            events.push({ type: 'sponsor-goal', sponsorId: c.sponsorId, objective: ob.id, text: ob.desc });
          }
        }
      });
    } else {
      breakdown.push({ label: c.sponsor + ': race not eligible (' + reasons.join('; ') + ')', credits: 0, xp: 0, kind: 'info' });
    }
    if (o.dnf) {
      c.dnfs = (c.dnfs || 0) + 1;
      if (c.maxDnfs != null && c.dnfs > c.maxDnfs) {
        c.status = 'terminated';
        breakdown.push({ label: c.sponsor + ' terminated the contract (too many DNFs)', credits: 0, xp: 0, kind: 'penalty' });
        events.push({ type: 'sponsor-terminated', sponsorId: c.sponsorId });
      }
    }
    if (c.status === 'active' && c.racesCompleted >= c.races) {
      var allTotals = c.objectives.every(function (ob) { return ob.scope !== 'total' || (c.progress[ob.id] && c.progress[ob.id].done); });
      if (allTotals) {
        c.status = 'completed';
        breakdown.push({ label: c.sponsor + ' contract completed', credits: Math.round(c.completionBonus.credits * payMult), xp: c.completionBonus.xp, kind: 'completion' });
        events.push({ type: 'sponsor-completed', sponsorId: c.sponsorId });
      } else {
        c.status = 'expired';
        breakdown.push({ label: c.sponsor + ' contract expired (goals unmet)', credits: 0, xp: 0, kind: 'info' });
        events.push({ type: 'sponsor-expired', sponsorId: c.sponsorId });
      }
    }
    var credits = 0, xp = 0;
    breakdown.forEach(function (l) { credits += l.credits; xp += l.xp; });
    c.earned = { credits: num(c.earned && c.earned.credits, 0) + credits, xp: num(c.earned && c.earned.xp, 0) + xp };
    c.history = (c.history || []).concat([{ race: c.racesCompleted, eligible: eligible, position: o.position, credits: credits, xp: xp, met: met.slice() }]).slice(-20);
    return { contract: c, credits: credits, xp: xp, breakdown: breakdown, met: met, missed: missed, eligible: eligible,
      completed: c.status === 'completed', status: c.status, events: events, reasons: reasons };
  }

  function evaluateSponsors(contracts, results, opts) {
    var o = looksNormalized(results) ? results : outcomeFromResults(results, opts);
    var out = { contracts: [], credits: 0, xp: 0, breakdown: [], events: [] };
    (contracts || []).forEach(function (c) {
      var r = evaluateSponsor(c, o);
      out.contracts.push(r.contract);
      out.credits += r.credits; out.xp += r.xp;
      out.breakdown = out.breakdown.concat(r.breakdown);
      out.events = out.events.concat(r.events);
    });
    return out;
  }

  function contractSummary(c) {
    if (!c) return null;
    return {
      sponsor: c.sponsor, status: c.status, racesLeft: Math.max(0, c.races - (c.racesCompleted || 0)),
      earned: c.earned || { credits: 0, xp: 0 },
      objectives: c.objectives.map(function (ob) {
        var pr = (c.progress && c.progress[ob.id]) || { cur: 0, met: 0, done: false };
        return ob.scope === 'race'
          ? { id: ob.id, desc: ob.desc, text: 'Met ' + pr.met + '×', cur: pr.met, max: c.races, done: false, reward: ob.reward }
          : { id: ob.id, desc: ob.desc, text: Math.min(pr.cur, ob.target) + ' / ' + ob.target, cur: Math.min(pr.cur, ob.target), max: ob.target, done: pr.done, reward: ob.reward };
      })
    };
  }

  /* ------------------------------------------------------------------ export */
  return {
    CAREER_PRICE_FACTOR: CAREER_PRICE_FACTOR, PART_REFUND_RATE: PART_REFUND_RATE, START_CREDITS: START_CREDITS,
    MAX_LEVEL: MAX_LEVEL, DIFFICULTY_MULT: DIFFICULTY_MULT, DIFFICULTY_XP_MULT: DIFFICULTY_XP_MULT,
    UNLOCK_TABLE: UNLOCK_TABLE, FEATURE_UNLOCKS: FEATURE_UNLOCKS, TRACK_UNLOCKS: TRACK_UNLOCKS, NUMERIC_CAPS: NUMERIC_CAPS,
    SPONSORS: SPONSORS, OBJECTIVE_TYPES: OBJECTIVE_TYPES, ENTRY_FEE_BY_TIER: ENTRY_FEE_BY_TIER,
    // unlocks
    partUnlockLevel: partUnlockLevel, featureUnlockLevel: featureUnlockLevel, trackUnlockLevel: trackUnlockLevel,
    bodyStyleUnlockLevel: bodyStyleUnlockLevel, isUnlocked: isUnlocked, isFeatureUnlocked: isFeatureUnlocked,
    isTrackUnlocked: isTrackUnlocked, lockedOptions: lockedOptions, lockedPaths: lockedPaths, lockedFeatures: lockedFeatures,
    lockedTracks: lockedTracks, numericCaps: numericCaps, unlocksAtLevel: unlocksAtLevel, nextUnlocks: nextUnlocks,
    unlockProgress: unlockProgress, buildLockViolations: buildLockViolations, clampBuildToUnlocks: clampBuildToUnlocks,
    levelRewards: levelRewards, collectionLabel: collectionLabel, levelForXp: levelForXp, profileLevel: profileLevel,
    // pricing
    estimateMsrp: estimateMsrp, msrp: msrp, carCost: carCost, carQuote: carQuote, partCost: partCost,
    upgradeQuote: upgradeQuote, upgradeCost: upgradeCost, repairQuote: repairQuote, repairCost: repairCost,
    sellQuote: sellQuote, sellValue: sellValue, carValue: function (car) { return Math.round(carValue(car).value); },
    entryFee: entryFee, pitServiceCost: pitServiceCost, canAfford: canAfford, formatCredits: formatCredits,
    // races
    raceRewards: raceRewards, positionShare: positionShare, outcomeFromResults: outcomeFromResults, rewardsFromResults: rewardsFromResults,
    normDifficulty: normDifficulty,
    // sponsors
    getSponsor: getSponsor, maxActiveContracts: maxActiveContracts, activeContracts: activeContracts,
    getSponsorOffers: getSponsorOffers, createContract: createContract, evaluateSponsor: evaluateSponsor,
    evaluateSponsors: evaluateSponsors, contractSummary: contractSummary
  };
})();

if (typeof module !== 'undefined') module.exports = CB.game.economy;

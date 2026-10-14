/* ==========================================================================
   FORGE Atelier — js/race/ai.js
   CB.race.ai : AI opponents for Race Mode.

     createGrid(playerBuild, opts)          -> opponent[]   (fictional drivers, teams, liveries, builds)
     createDriver(opponent, geom, params)   -> controller   ({ control(vehicleState, raceContext, dt) -> input })

   Pure logic (no DOM). Loads in browsers (classic <script>) and in Node (require).
   Soft dependencies, all feature-detected with internal fallbacks:
     CB.data (presets/defaultBuild/catalog), CB.physics.compute, CB.state.normalize,
     CB.race.tracks.project / speedProfile, CB.race.vehicle params.

   ---------------------------------------------------------------------------
   raceContext (passed by the engine to control(); every field optional):
     {
       t, phase: 'grid'|'countdown'|'racing'|'finished',
       countdown: { lightsOut },
       selfId,                                   // id of the car being driven (defaults to opponent.id)
       cars: [{ id, isPlayer, x, y, heading, speed, vx, vy, s, lap, length_m, width_m, finished, dnf }],
       weather: 'dry'|'damp'|'wet', gripMult,    // or env: { gripMult, wet }
       rubberBand: bool,                         // overrides the driver option
       lapsTotal
     }
   input returned:
     { throttle 0..1, brake 0..1, steer -1..1 (+ = left), handbrake, shiftUp, shiftDown,
       reverse (bool: AI wants reverse gear; vehicles may also treat brake-at-standstill as reverse),
       requestReset (bool: stuck for a long time, engine may teleport the car back to track) }

   Traffic model (per driver, per neighbour):
     - side latch: when a neighbour enters the overlap zone its side (sign of the lateral offset) is latched,
       so both cars of a pair hold mirror sides and never cross through each other;
     - lateral corridor: cars alongside / ahead bound the reference laterally (smoothed bounds, no steps);
       a car still behind does not push the car ahead off its line (it is responsible for avoiding);
     - squeeze: if the corridor does not fit between the track edges, the car that is behind yields;
     - overtaking: side choice weighs room, the next corner, third cars in the target lane, and keeps the
       passed car as the target while beside its lane (no hunting); off-line lanes are speed-capped by the
       tighter path curvature (inside of a hairpin), and lane changes respect the friction circle.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};

(function () {
  'use strict';

  var TAU = Math.PI * 2;
  var G = 9.81;
  var RHO = 1.225;

  /* ======================================================================
     Small math / utility helpers (self-contained; CB.util is optional)
     ====================================================================== */

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function num(v) { return typeof v === 'number' && isFinite(v); }
  function first() {
    for (var i = 0; i < arguments.length; i++) if (num(arguments[i])) return arguments[i];
    return undefined;
  }
  function wrapAngle(a) {
    if (!isFinite(a)) return 0;
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  }
  function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  function smoothstep(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  function approach(cur, target, maxDelta) {
    if (target > cur) return Math.min(target, cur + maxDelta);
    return Math.max(target, cur - maxDelta);
  }

  function isObj(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
  function deepClone(o) {
    if (CB.util && typeof CB.util.deepClone === 'function') { try { return CB.util.deepClone(o); } catch (e) { /* fall through */ } }
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(deepClone);
    var out = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = deepClone(o[k]);
    return out;
  }
  function deepMerge(base, patch) {
    var out = deepClone(base) || {};
    if (!isObj(patch)) return out;
    Object.keys(patch).forEach(function (k) {
      var pv = patch[k];
      if (isObj(pv) && isObj(out[k])) out[k] = deepMerge(out[k], pv);
      else out[k] = deepClone(pv);
    });
    return out;
  }

  /** FNV-1a 32-bit string hash. */
  function hashStr(s) {
    s = String(s == null ? '' : s);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }

  /** Seeded PRNG (mulberry32) with convenience helpers. */
  function makeRng(seed) {
    var a = (num(seed) ? seed : hashStr(seed)) >>> 0;
    if (!a) a = 0x9e3779b9;
    function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    var spare = null;
    return {
      next: next,
      range: function (lo, hi) { return lo + (hi - lo) * next(); },
      int: function (lo, hi) { return lo + Math.floor(next() * (hi - lo + 1)); },
      chance: function (p) { return next() < p; },
      pick: function (arr) { return arr[Math.floor(next() * arr.length)]; },
      gauss: function () {
        if (spare !== null) { var s = spare; spare = null; return s; }
        var u = 0, v = 0;
        while (u === 0) u = next();
        v = next();
        var r = Math.sqrt(-2 * Math.log(u));
        spare = r * Math.sin(TAU * v);
        return r * Math.cos(TAU * v);
      },
      shuffle: function (arr) {
        var c = arr.slice();
        for (var i = c.length - 1; i > 0; i--) { var j = Math.floor(next() * (i + 1)); var t = c[i]; c[i] = c[j]; c[j] = t; }
        return c;
      },
    };
  }

  /* ======================================================================
     Fictional drivers, teams & liveries
     ====================================================================== */

  var TEAMS = [
    { id: 'vantor',    name: 'Vantor Racing',          short: 'VAN', color: '#0b3d91', accent: '#f5c400', country: 'GB', stripe: 'racing-dual' },
    { id: 'kestrel',   name: 'Kestrel Motorsport',     short: 'KES', color: '#e8e8e8', accent: '#d0102b', country: 'DE', stripe: 'le-mans' },
    { id: 'aurelio',   name: 'Scuderia Aurelio',       short: 'AUR', color: '#c1121f', accent: '#ffd23f', country: 'IT', stripe: 'center' },
    { id: 'nordlys',   name: 'Nordlys Works',          short: 'NOR', color: '#0f7b6c', accent: '#e9f5f2', country: 'NO', stripe: 'side-skirt' },
    { id: 'hanzo',     name: 'Hanzo Speed Lab',        short: 'HAN', color: '#111111', accent: '#ff3d00', country: 'JP', stripe: 'gradient' },
    { id: 'marlowe',   name: 'Marlowe & Pike',         short: 'M&P', color: '#1f4d2b', accent: '#d9b44a', country: 'GB', stripe: 'pinstripe' },
    { id: 'solenne',   name: 'Équipe Solenne',         short: 'SOL', color: '#2340d8', accent: '#ffffff', country: 'FR', stripe: 'racing-dual' },
    { id: 'quattrino', name: 'Quattrino Corse',        short: 'QUA', color: '#ff7a00', accent: '#1b1b1b', country: 'IT', stripe: 'hood' },
    { id: 'helix',     name: 'Helix Dynamics',         short: 'HLX', color: '#7a1fd1', accent: '#41e2ff', country: 'US', stripe: 'gradient' },
    { id: 'dunmore',   name: 'Dunmore Engineering',    short: 'DUN', color: '#5b6770', accent: '#ff2e63', country: 'IE', stripe: 'le-mans' },
    { id: 'saguaro',   name: 'Saguaro Desert Racing',  short: 'SAG', color: '#c2702d', accent: '#2b2118', country: 'US', stripe: 'center' },
    { id: 'kairos',    name: 'Kairos Performance',     short: 'KAI', color: '#00a6a6', accent: '#101820', country: 'GR', stripe: 'side-skirt' },
    { id: 'brumby',    name: 'Brumby Motorworks',      short: 'BRU', color: '#ffd400', accent: '#00843d', country: 'AU', stripe: 'racing-dual' },
    { id: 'valquiria', name: 'Valquiria Competición',  short: 'VAL', color: '#8b0a50', accent: '#f4d35e', country: 'ES', stripe: 'hood' },
    { id: 'ostrava',   name: 'Ostrava Technik',        short: 'OST', color: '#e5e5e5', accent: '#0057b8', country: 'CZ', stripe: 'pinstripe' },
    { id: 'mirage',    name: 'Mirage Autosport',       short: 'MIR', color: '#2b2d42', accent: '#8d99ae', country: 'AE', stripe: 'center' },
  ];

  // Entirely invented names (no real-world racing drivers).
  var DRIVERS = [
    ['Lukas', 'Brandvold', 'NO'], ['Aiko', 'Tanabe', 'JP'], ['Mateus', 'Corvalho', 'BR'], ['Isolde', 'Varga', 'HU'],
    ['Ravi', 'Kundapur', 'IN'], ['Elodie', 'Fontanel', 'FR'], ['Tobias', 'Wetterling', 'DE'], ['Sienna', 'Marchetti', 'IT'],
    ['Kofi', 'Asantewaa', 'GH'], ['Freya', 'Lindqvist', 'SE'], ['Dmitri', 'Volkonin', 'LV'], ['Camila', 'Ortaz', 'AR'],
    ['Hugo', 'Ravensworth', 'GB'], ['Mei', 'Shirozawa', 'JP'], ['Joaquín', 'Ibarrola', 'ES'], ['Annika', 'Dvořáková', 'CZ'],
    ['Callum', 'Ferriday', 'AU'], ['Noor', 'Al-Haddani', 'AE'], ['Oskar', 'Penttinen', 'FI'], ['Priya', 'Venkatram', 'IN'],
    ['Teodor', 'Albescu', 'RO'], ['Yara', 'Okonkwo-Lisle', 'NG'], ['Bastien', 'Garrigou', 'FR'], ['Ines', 'Malheiro', 'PT'],
    ['Jonah', 'Whitlock', 'US'], ['Saskia', 'van Dorsten', 'NL'], ['Emil', 'Kragstrup', 'DK'], ['Leilani', 'Kahaleo', 'US'],
    ['Marco', 'Tessaroli', 'IT'], ['Hana', 'Jelinek', 'AT'], ['Diego', 'Santurce', 'MX'], ['Zofia', 'Wierzbicka', 'PL'],
    ['Rory', 'McAllister-Quinn', 'IE'], ['Kaito', 'Morikane', 'JP'], ['Valentina', 'Rocafuerte', 'CL'], ['Anders', 'Holmfrid', 'SE'],
    ['Thandi', 'Mabuza', 'ZA'], ['Felix', 'Oberhauser', 'CH'], ['Nadia', 'Petrosyan', 'AM'], ['Silas', 'Thornbury', 'NZ'],
    ['Ximena', 'Valderrama', 'CO'], ['Arjun', 'Sethuraman', 'SG'], ['Clémence', 'Aubertin', 'BE'], ['Mikkel', 'Sandvær', 'NO'],
    ['Juno', 'Park-Halloway', 'KR'], ['Stellan', 'Brisk', 'SE'], ['Orla', 'Fennimore', 'GB'], ['Takeshi', 'Ubukata', 'JP'],
    ['Paolo', 'Ventimiglia', 'IT'], ['Ezra', 'Calloway', 'CA'], ['Linnea', 'Sjöberg', 'SE'], ['Bruno', 'Esteves-Lacerda', 'BR'],
  ].map(function (d) {
    var last = d[1];
    var code = last.replace(/^(van |de |von )/i, '').replace(/[^A-Za-zÀ-ž]/g, '').slice(0, 3).toUpperCase();
    return { first: d[0], last: last, nat: d[2], code: code, name: d[0] + ' ' + last };
  });

  var DIFFICULTIES = {
    rookie:  { id: 'rookie',  label: 'Rookie',  skill: [0.48, 0.64], consistency: [0.50, 0.70], aggression: [0.10, 0.35], perf: -0.08, spread: 0.07, reaction: [0.38, 0.65], mistakeMult: 1.6 },
    amateur: { id: 'amateur', label: 'Amateur', skill: [0.64, 0.79], consistency: [0.66, 0.82], aggression: [0.25, 0.55], perf: -0.035, spread: 0.06, reaction: [0.26, 0.46], mistakeMult: 1.15 },
    pro:     { id: 'pro',     label: 'Pro',     skill: [0.80, 0.92], consistency: [0.80, 0.93], aggression: [0.40, 0.75], perf: 0.0, spread: 0.045, reaction: [0.18, 0.32], mistakeMult: 0.8 },
    alien:   { id: 'alien',   label: 'Alien',   skill: [0.93, 1.00], consistency: [0.92, 0.99], aggression: [0.55, 0.92], perf: 0.03, spread: 0.03, reaction: [0.12, 0.22], mistakeMult: 0.45 },
  };

  var PERSONALITIES = [
    { id: 'late-braker',  brakeBias: 1.06, lineBias: 0.0,  defend: 0.6, overtake: 1.15, desc: 'Brakes impossibly late' },
    { id: 'smooth',       brakeBias: 0.98, lineBias: 0.0,  defend: 0.4, overtake: 0.85, desc: 'Silky, metronomic lines' },
    { id: 'wall-of-defence', brakeBias: 1.0, lineBias: 0.0, defend: 1.0, overtake: 0.9, desc: 'Impossible to pass' },
    { id: 'opportunist',  brakeBias: 1.02, lineBias: 0.0,  defend: 0.5, overtake: 1.25, desc: 'Dives into every gap' },
    { id: 'tyre-whisperer', brakeBias: 0.99, lineBias: 0.0, defend: 0.5, overtake: 1.0, desc: 'Gentle on the throttle' },
    { id: 'hothead',      brakeBias: 1.04, lineBias: 0.0,  defend: 0.85, overtake: 1.3, desc: 'Fast, erratic, fearless' },
  ];

  /* ======================================================================
     Catalog access (CB.data optional) & build helpers
     ====================================================================== */

  var FALLBACK = {
    tunes: ['eco', 'stock', 'stage1', 'stage2', 'stage3', 'time-attack'],
    tuneMult: { eco: 0.9, stock: 1, stage1: 1.1, stage2: 1.2, stage3: 1.32, 'time-attack': 1.45 },
    compounds: ['eco', 'all-season', 'winter', 'touring', 'performance', 'super-sport', 'track', 'slick'],
    compoundMu: { eco: 0.78, 'all-season': 0.85, winter: 0.8, touring: 0.92, performance: 1.02, 'super-sport': 1.1, track: 1.22, slick: 1.38 },
    wings: ['none', 'ducktail', 'lip-spoiler', 'swan-neck', 'gt-wing', 'biplane'],
    wingDf: { none: 0, ducktail: 25, 'lip-spoiler': 35, 'swan-neck': 140, 'gt-wing': 180, active: 160, biplane: 260 },
    splitters: ['none', 'lip', 'carbon', 'race'],
    splitterDf: { none: 0, lip: 15, carbon: 40, race: 80 },
    diffuserDf: { none: 0, mild: 15, carbon: 45, race: 90 },
    aspMult: { na: 1, turbo: 1.35, 'twin-turbo': 1.45, 'quad-turbo': 1.6, supercharged: 1.35, twincharged: 1.5, 'electric-turbo': 1.42 },
    styleWeight: { coupe: 1420, sedan: 1520, hatchback: 1250, wagon: 1580, suv: 1950, roadster: 1250, pickup: 2100, hypercar: 1250, 'shooting-brake': 1550, van: 2200 },
    exhausts: ['stock', 'sport', 'titanium', 'straight-pipe'],
  };

  function data() { return CB.data || null; }
  function catalog(path) {
    var d = data();
    if (!d) return null;
    var parts = path.split('.'), o = d;
    for (var i = 0; i < parts.length; i++) { if (!o) return null; o = o[parts[i]]; }
    return Array.isArray(o) ? o : null;
  }
  function findOpt(path, id) {
    var arr = catalog(path);
    if (!arr) return null;
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i];
    return null;
  }
  /** Ordered id list from the catalog (sorted by a numeric key) or fallback. */
  function orderedIds(path, key, fallback, exclude) {
    var arr = catalog(path);
    if (!arr || !arr.length) return fallback.slice();
    var list = arr.filter(function (o) { return o && o.id && (!exclude || exclude.indexOf(o.id) < 0); });
    if (key) list = list.slice().sort(function (a, b) { return (Number(a[key]) || 0) - (Number(b[key]) || 0); });
    return list.map(function (o) { return o.id; });
  }

  var FALLBACK_BUILD = {
    version: 1,
    meta: { name: 'Untitled Build', id: 'b_ai', created: 0, modified: 0, presetId: null },
    body: { style: 'coupe', chassisMaterial: 'steel', wheelbase_mm: 2650, trackWidth_mm: 1600, doors: 2, seats: 4 },
    engine: { type: 'ice', layout: 'V8', displacement_l: 4.0, aspiration: 'twin-turbo', boost_bar: 1.2, compression: 10.0, fuel: 'premium',
      redline_rpm: 7500, position: 'front', tune: 'stock', exhaust: 'sport', cooling: 'standard',
      motors: 2, motorPower_kw: 200, battery_kwh: 85, chemistry: 'nmc', voltage: 800, regen: 2 },
    transmission: { type: 'dct', gears: 7, ratios: [3.80, 2.60, 1.90, 1.45, 1.15, 0.95, 0.78], finalDrive: 3.42, launchControl: true },
    drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: false, tractionControl: 2 },
    suspension: { type: 'double-wishbone', springFront_nmm: 60, springRear_nmm: 70, damping: 5, rideHeight_mm: 120,
      camberFront_deg: -1.5, camberRear_deg: -1.0, toeFront_deg: 0.0, toeRear_deg: 0.1, arbFront: 5, arbRear: 4 },
    brakes: { material: 'iron', frontRotor_mm: 360, rearRotor_mm: 330, frontPistons: 6, rearPistons: 4, abs: 'sport' },
    wheels: { design: 'y-spoke', material: 'cast', diameter_in: 19, widthFront_in: 9.0, widthRear_in: 10.5, finish: '#2b2b2b', staggered: true },
    tires: { compound: 'performance', widthFront_mm: 255, widthRear_mm: 295, profileFront: 35, profileRear: 30 },
    aero: { splitter: 'lip', wing: 'none', wingAngle_deg: 6, diffuser: 'mild', canards: false, sideSkirts: true, activeAero: false },
    weight: { soundDeadening: true, rearSeats: true, spareTire: false, glass: 'standard', battery: 'lead', rollCage: 'none', ballast_kg: 0, ballastPosition: 'center' },
    exterior: { paint: '#b3121f', finish: 'metallic', roof: 'body', roofColor: '#111111', stripe: 'none', stripeColor: '#ffffff',
      caliperColor: '#f2c200', windowTint_pct: 20, lights: 'led', mirrors: 'body', badge: 'chrome', livery_number: '' },
    interior: { seatType: 'sport', upholstery: 'leather', primaryColor: '#1a1a1a', accentColor: '#b3121f', stitchColor: '#b3121f',
      trim: 'aluminum', steering: 'round', headliner: 'alcantara', ambientLighting: true, ambientColor: '#ff3344', harness: false },
    tech: { screen_in: 12, digitalCluster: true, hud: false, audio: 'premium', adas: 'assist', climateZones: 2, telemetry: false, liftSystem: false, nightVision: false },
  };

  function defaultBuild() {
    var d = data();
    if (d && typeof d.defaultBuild === 'function') {
      try { var b = d.defaultBuild(); if (isObj(b)) return b; } catch (e) { /* fallback */ }
    }
    return deepClone(FALLBACK_BUILD);
  }

  function normalizeBuild(b) {
    if (CB.state && typeof CB.state.normalize === 'function') {
      try { var n = CB.state.normalize(b); if (isObj(n)) return n; } catch (e) { /* fallback */ }
    }
    return internalNormalize(b);
  }

  /** Light invariant enforcement used when CB.state.normalize is unavailable. */
  function internalNormalize(b) {
    b = deepMerge(FALLBACK_BUILD, b);
    var e = b.engine;
    e.displacement_l = Math.round(clamp(Number(e.displacement_l) || 2, 0.6, 8.4) * 10) / 10;
    var layout = findOpt('engineLayouts', e.layout);
    if (layout && layout.displacementRange) e.displacement_l = Math.round(clamp(e.displacement_l, layout.displacementRange[0], layout.displacementRange[1]) * 10) / 10;
    var asp = findOpt('aspirations', e.aspiration);
    var maxBoost = asp && num(asp.maxBoost_bar) ? asp.maxBoost_bar : 3.0;
    e.boost_bar = e.aspiration === 'na' ? 0 : Math.round(clamp(Number(e.boost_bar) || 0, 0, maxBoost) * 100) / 100;
    e.redline_rpm = Math.round(clamp(Number(e.redline_rpm) || 7000, 5000, e.fuel === 'diesel' ? 5200 : 9500));
    e.motors = Math.round(clamp(e.motors || 1, 1, e.type === 'hybrid' ? 2 : 4));
    e.motorPower_kw = Math.round(clamp(Number(e.motorPower_kw) || 150, 50, 500));
    var t = b.transmission;
    if (!Array.isArray(t.ratios) || t.ratios.length !== t.gears) {
      var tr = findOpt('transmissions', t.type);
      if (tr && typeof tr.defaultRatios === 'function') { try { t.ratios = tr.defaultRatios(t.gears); } catch (er) { /* keep */ } }
      if (!Array.isArray(t.ratios) || t.ratios.length !== t.gears) {
        t.ratios = [];
        for (var g = 0; g < t.gears; g++) t.ratios.push(Math.round(3.6 * Math.pow(0.78 / 3.6, t.gears > 1 ? g / (t.gears - 1) : 0) * 100) / 100);
      }
    }
    t.finalDrive = Math.round(clamp(Number(t.finalDrive) || 3.4, 2.5, 5.5) * 100) / 100;
    var d = b.drivetrain;
    if (d.layout === 'fwd') d.torqueSplitFront_pct = 100;
    else if (d.layout === 'rwd') d.torqueSplitFront_pct = 0;
    else d.torqueSplitFront_pct = clamp(d.torqueSplitFront_pct || 40, 10, 90);
    var ti = b.tires;
    ti.widthFront_mm = clamp(Math.round(((ti.widthFront_mm || 245) - 5) / 10) * 10 + 5, 175, 355);
    ti.widthRear_mm = clamp(Math.round(((ti.widthRear_mm || 245) - 5) / 10) * 10 + 5, 175, 355);
    b.aero.wingAngle_deg = clamp(Number(b.aero.wingAngle_deg) || 0, 0, 20);
    b.weight.ballast_kg = Math.round(clamp(Number(b.weight.ballast_kg) || 0, 0, 100));
    return b;
  }

  /* ======================================================================
     Performance index (used to performance-match opponent builds)
     ====================================================================== */

  function computeMetrics(build) {
    if (CB.physics && typeof CB.physics.compute === 'function') {
      try { var m = CB.physics.compute(build); if (m && typeof m === 'object') return m; } catch (e) { /* heuristic */ }
    }
    return null;
  }

  /** Heuristic metrics straight from the build (no physics.js). */
  function heuristicMetrics(b) {
    b = b || FALLBACK_BUILD;
    var e = b.engine || {}, hp = 0;
    var tuneOpt = findOpt('tunes', e.tune);
    var tuneMult = tuneOpt && num(tuneOpt.powerMult) ? tuneOpt.powerMult : (FALLBACK.tuneMult[e.tune] || 1);
    var exOpt = findOpt('exhausts', e.exhaust);
    var exMult = exOpt && num(exOpt.powerMult) ? exOpt.powerMult : 1;
    if (e.type !== 'ev') {
      var aspOpt = findOpt('aspirations', e.aspiration);
      var aspMult = aspOpt && num(aspOpt.powerMult) ? aspOpt.powerMult : (FALLBACK.aspMult[e.aspiration] || 1);
      var boostMult = e.aspiration === 'na' ? 1 : 1 + Math.max(0, (Number(e.boost_bar) || 0) - 1) * 0.28;
      var revMult = Math.pow((Number(e.redline_rpm) || 7000) / 7000, 0.6);
      hp = (Number(e.displacement_l) || 2) * 92 * aspMult * boostMult * revMult * tuneMult * exMult;
      if (e.fuel === 'diesel') hp *= 0.78;
      if (e.fuel === 'race' || e.fuel === 'e85') hp *= 1.05;
    }
    if (e.type === 'ev' || e.type === 'hybrid') {
      hp += (Number(e.motors) || 1) * (Number(e.motorPower_kw) || 150) * 1.341 * (e.type === 'ev' ? 0.92 : 0.75) * (e.type === 'ev' ? tuneMult : 1);
    }
    var style = (b.body && b.body.style) || 'coupe';
    var bs = findOpt('bodyStyles', style);
    var w = bs && num(bs.baseWeight_kg) ? bs.baseWeight_kg : (FALLBACK.styleWeight[style] || 1450);
    var ch = findOpt('chassisMaterials', b.body && b.body.chassisMaterial);
    if (ch && num(ch.weightFactor)) w *= ch.weightFactor;
    if (e.type === 'ev') w += (Number(e.battery_kwh) || 80) * 5.5;
    if (e.type === 'hybrid') w += 120;
    var wt = b.weight || {};
    w += (Number(wt.ballast_kg) || 0) + (wt.rollCage === 'full' ? 45 : wt.rollCage === 'half' ? 22 : 0);
    if (wt.soundDeadening === false) w -= 25;
    if (wt.rearSeats === false) w -= 30;
    var tires = b.tires || {};
    var cOpt = findOpt('tireCompounds', tires.compound);
    var mu = cOpt && num(cOpt.mu) ? cOpt.mu : (FALLBACK.compoundMu[tires.compound] || 1.0);
    mu *= 1 + (((Number(tires.widthFront_mm) || 245) + (Number(tires.widthRear_mm) || 245)) / 2 - 245) / 1400;
    var a = b.aero || {};
    function df(path, id, fb) { var o = findOpt(path, id); return o && num(o.downforce_kg_at_200) ? o.downforce_kg_at_200 : (fb[id] || 0); }
    var dfKg = df('aero.wings', a.wing, FALLBACK.wingDf) * (0.6 + (Number(a.wingAngle_deg) || 0) / 25) +
      df('aero.splitters', a.splitter, FALLBACK.splitterDf) + df('aero.diffusers', a.diffuser, FALLBACK.diffuserDf);
    return { power_hp: hp, power_kw: hp / 1.341, weight_kg: w, gripFront: mu, gripRear: mu, downforce_kg_200: dfKg, heuristic: true };
  }

  /** Higher = faster. ~100 for a 450 hp performance coupe. */
  function perfIndex(build, metricsIn) {
    var m = metricsIn || computeMetrics(build);
    if (m && num(m.lapTime_s) && m.lapTime_s > 20) return 100 * 150 / m.lapTime_s;
    if (!m || !num(m.power_hp)) m = heuristicMetrics(build);
    var pw = (m.power_hp || 300) / Math.max(600, m.weight_kg || 1450) * 1000;
    var mu = ((m.gripFront || 1) + (m.gripRear || 1)) / 2;
    var df = m.downforce_kg_200 || 0;
    return 100 * Math.pow(pw / 300, 0.36) * Math.pow(mu, 0.72) * (1 + df / 3000);
  }

  /* ---------------------------------------------------------- build variation */

  function stepIn(list, id, delta) {
    var i = list.indexOf(id);
    if (i < 0) i = Math.floor(list.length / 2);
    return list[clamp(i + delta, 0, list.length - 1)];
  }

  /** Scale engine output by roughly factor f, staying within catalog limits. */
  function scalePower(b, f) {
    var e = b.engine;
    if (e.type === 'ev' || e.type === 'hybrid') {
      e.motorPower_kw = Math.round(clamp((Number(e.motorPower_kw) || 150) * f, 50, 500));
      if (e.type === 'ev') return;
    }
    if (e.aspiration && e.aspiration !== 'na') {
      var asp = findOpt('aspirations', e.aspiration);
      var maxB = asp && num(asp.maxBoost_bar) ? asp.maxBoost_bar : 3.0;
      var nb = (Number(e.boost_bar) || 0.8) + (f - 1) * 3.2;
      e.boost_bar = Math.round(clamp(nb, 0.3, maxB) * 100) / 100;
      if (nb === e.boost_bar) return;
    }
    var lay = findOpt('engineLayouts', e.layout);
    var range = lay && lay.displacementRange ? lay.displacementRange : [1.0, 8.0];
    e.displacement_l = Math.round(clamp((Number(e.displacement_l) || 2) * f, range[0], range[1]) * 10) / 10;
  }

  function randomMods(b, rng, intensity) {
    var e = b.engine, tunes = orderedIds('tunes', 'powerMult', FALLBACK.tunes);
    // Power
    if (rng.chance(0.5)) e.tune = stepIn(tunes, e.tune, rng.chance(0.5) ? 1 : -1);
    scalePower(b, 1 + rng.range(-0.12, 0.12) * intensity);
    if (e.type !== 'ev' && rng.chance(0.3)) e.exhaust = rng.pick(orderedIds('exhausts', 'powerMult', FALLBACK.exhausts, ['valvetronic']));
    // Tires
    var comps = orderedIds('tireCompounds', 'mu', FALLBACK.compounds, ['winter']);
    if (rng.chance(0.45 * intensity + 0.1)) b.tires.compound = stepIn(comps, b.tires.compound, rng.chance(0.5) ? 1 : -1);
    if (rng.chance(0.5)) {
      var dw = rng.pick([-20, -10, 10, 20]);
      b.tires.widthFront_mm = clamp((b.tires.widthFront_mm || 245) + dw, 175, 355);
      b.tires.widthRear_mm = clamp((b.tires.widthRear_mm || 245) + dw, 175, 355);
    }
    // Aero
    var wings = orderedIds('aero.wings', 'downforce_kg_at_200', FALLBACK.wings, ['active']);
    if (rng.chance(0.4 * intensity + 0.1)) b.aero.wing = stepIn(wings, b.aero.wing, rng.chance(0.55) ? 1 : -1);
    if (rng.chance(0.4)) b.aero.wingAngle_deg = Math.round(clamp((b.aero.wingAngle_deg || 6) + rng.range(-5, 5), 0, 20));
    if (rng.chance(0.3)) b.aero.splitter = stepIn(orderedIds('aero.splitters', 'downforce_kg_at_200', FALLBACK.splitters), b.aero.splitter, rng.chance(0.5) ? 1 : -1);
    balanceAero(b);
    // Weight & chassis
    if (rng.chance(0.35)) b.weight.ballast_kg = Math.round(clamp(rng.range(0, 60) * intensity, 0, 100));
    if (rng.chance(0.25)) b.weight.soundDeadening = !b.weight.soundDeadening;
    if (b.suspension && rng.chance(0.5)) {
      var sf = 1 + rng.range(-0.15, 0.2);
      b.suspension.springFront_nmm = Math.round(clamp((b.suspension.springFront_nmm || 60) * sf, 20, 250));
      b.suspension.springRear_nmm = Math.round(clamp((b.suspension.springRear_nmm || 70) * sf, 20, 250));
      b.suspension.arbFront = Math.round(clamp((b.suspension.arbFront || 5) + rng.int(-1, 1), 1, 10));
      b.suspension.arbRear = Math.round(clamp((b.suspension.arbRear || 4) + rng.int(-1, 1), 1, 10));
    }
    if (b.transmission && rng.chance(0.4)) b.transmission.finalDrive = Math.round(clamp((b.transmission.finalDrive || 3.4) + rng.range(-0.25, 0.25), 2.5, 5.5) * 100) / 100;
    return b;
  }

  /** Race-engineer sanity pass: a big splitter with no rear wing is a high-speed oversteer machine (the aero
   *  balance moves forward as speed rises). Step the splitter down until the front no longer out-pulls the rear. */
  function balanceAero(b) {
    if (!b.aero) return b;
    function dfOf(path, id, fb) { var o = findOpt(path, id); return o && num(o.downforce_kg_at_200) ? o.downforce_kg_at_200 : (fb[id] || 0); }
    var splitters = orderedIds('aero.splitters', 'downforce_kg_at_200', FALLBACK.splitters);
    var fbS = { none: 0, lip: 15, carbon: 35, race: 70 }, fbW = { none: 0, 'lip-spoiler': 12, ducktail: 20, 'swan-neck': 150, 'gt-wing': 180, active: 120, biplane: 260 };
    var fbD = { none: 0, mild: 15, carbon: 40, race: 85 };
    for (var guard = 0; guard < 4; guard++) {
      var front = dfOf('aero.splitters', b.aero.splitter, fbS);
      var rear = dfOf('aero.wings', b.aero.wing, fbW) + 0.5 * dfOf('aero.diffusers', b.aero.diffuser, fbD);
      if (front <= rear + 12 || splitters.indexOf(b.aero.splitter) <= 0) break;
      b.aero.splitter = stepIn(splitters, b.aero.splitter, -1);
    }
    return b;
  }

  /** Iteratively nudge a build until its perf index is near `target`. */
  function matchPerformance(build, target, rng, maxIter, tolerance) {
    var b = normalizeBuild(build), idx = perfIndex(b);
    tolerance = tolerance || 0.025;
    for (var it = 0; it < (maxIter || 8); it++) {
      var ratio = target / idx;
      if (Math.abs(ratio - 1) < tolerance) break;
      var nb = deepClone(b);
      // Power carries most of the correction; tires/aero nudge when far off.
      scalePower(nb, Math.pow(ratio, 1.6));
      if (Math.abs(ratio - 1) > 0.08) {
        var comps = orderedIds('tireCompounds', 'mu', FALLBACK.compounds, ['winter']);
        nb.tires.compound = stepIn(comps, nb.tires.compound, ratio > 1 ? 1 : -1);
      }
      if (ratio < 0.97) nb.weight.ballast_kg = Math.round(clamp((nb.weight.ballast_kg || 0) + (1 - ratio) * 400, 0, 100));
      else if (ratio > 1.03) nb.weight.ballast_kg = Math.round(clamp((nb.weight.ballast_kg || 0) - (ratio - 1) * 400, 0, 100));
      nb = normalizeBuild(nb);
      var ni = perfIndex(nb);
      if (Math.abs(ni - target) > Math.abs(idx - target) && it > 2) break;   // no longer improving
      b = nb; idx = ni;
    }
    return { build: b, index: idx };
  }

  function applyLivery(b, team, number, driver, rng) {
    b.exterior = b.exterior || {};
    b.exterior.paint = team.color;
    b.exterior.stripe = team.stripe || 'racing-dual';
    b.exterior.stripeColor = team.accent;
    b.exterior.caliperColor = team.accent;
    b.exterior.livery_number = String(number).slice(0, 3);
    b.exterior.roof = rng.chance(0.4) ? 'contrast' : (b.exterior.roof || 'body');
    b.exterior.roofColor = team.accent;
    if (b.wheels) b.wheels.finish = rng.pick(['#1b1b1b', '#c9c9c9', '#2b2b2b', team.accent]);
    b.meta = b.meta || {};
    b.meta.name = team.name + ' #' + number;
    b.meta.id = 'ai_' + team.id + '_' + number;
    b.meta.driver = driver.name;
    return b;
  }

  function presetBuilds() {
    var arr = catalog('presets');
    if (!arr || !arr.length) return [];
    var base = defaultBuild();
    return arr.map(function (p) {
      var b = deepMerge(base, p.build || {});
      b.meta = b.meta || {};
      b.meta.presetId = p.id;
      return { id: p.id, name: p.name, build: normalizeBuild(b) };
    });
  }

  /* ---------------------------------------------------------- real-car models (js/shapes) */

  /** Registered CB.shapes models of a body style ([] when CB.shapes is not loaded). */
  function shapeModels(style) {
    var S = CB.shapes;
    if (!S || typeof S.modelsByStyle !== 'function') return [];
    try { return (S.modelsByStyle(style) || []).filter(function (m) { return m && m.id; }); } catch (e) { return []; }
  }
  /** The model a build actually shows: its explicit body.model (same style) or the style default. */
  function shownModelId(b) {
    var style = (b && b.body && b.body.style) || 'coupe', list = shapeModels(style), id = b && b.body && b.body.model;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return id;
    var S = CB.shapes, dm = null;
    try { dm = S && typeof S.defaultModel === 'function' ? S.defaultModel(style) : null; } catch (e) { dm = null; }
    return dm && dm.id ? dm.id : (list[0] ? list[0].id : null);
  }
  /**
   * Deterministic seeded real model for an opponent: the least-used model of its style in this field (the player's
   * car counts as one use), ties broken by a per-style seeded rotation; a preset keeps its own model the first time.
   * Without CB.shapes (or models for the style) body.model is left unset (null = renderer fallback).
   */
  function assignModel(b, mrng, use, keepId) {
    b.body = b.body || {};
    var style = b.body.style || 'coupe', list = shapeModels(style);
    if (!list.length) { b.body.model = null; return null; }
    var u = use[style] || (use[style] = { count: {}, start: mrng.int(0, list.length - 1) });
    var pick = null;
    if (keepId && !u.count[keepId]) {
      for (var k = 0; k < list.length; k++) if (list[k].id === keepId) { pick = list[k]; break; }
    }
    if (!pick) {
      var best = Infinity;
      for (var j = 0; j < list.length; j++) {
        var m = list[(u.start + j) % list.length], c = u.count[m.id] || 0;
        if (c < best) { best = c; pick = m; }
      }
    }
    u.count[pick.id] = (u.count[pick.id] || 0) + 1;
    b.body.model = pick.id;
    return pick;
  }

  /* ======================================================================
     createGrid
     ====================================================================== */

  function createGrid(playerBuild, opts) {
    opts = opts || {};
    var count = Math.round(clamp(num(opts.count) ? opts.count : 7, 1, 11));
    var diff = DIFFICULTIES[opts.difficulty] || DIFFICULTIES.amateur;
    var field = opts.field === 'presets' || opts.field === 'mixed' ? opts.field : 'similar';
    var player = isObj(playerBuild) ? normalizeBuild(playerBuild) : normalizeBuild(defaultBuild());
    var seed = opts.seed != null ? opts.seed : hashStr(JSON.stringify(player.engine || {}) + '|' + diff.id + '|' + field + '|' + count);
    var rng = makeRng(seed);
    var playerIdx = perfIndex(player);
    var presets = field === 'similar' ? [] : presetBuilds();
    if (!presets.length) field = 'similar';

    var drivers = rng.shuffle(DRIVERS);
    var teams = rng.shuffle(TEAMS);
    var playerNum = player.exterior && parseInt(player.exterior.livery_number, 10);
    var usedNums = {};
    if (playerNum) usedNums[playerNum] = 1;

    // Presets sorted by closeness to the player's performance (best matches first).
    // Real-car models: a separate seeded stream so adding models never changes drivers, numbers or builds.
    var mrng = makeRng((seed ^ 0x5f3759df) >>> 0), modelUse = {};
    var playerModel = shownModelId(player);
    if (playerModel) { var pst = (player.body && player.body.style) || 'coupe', pl = shapeModels(pst); modelUse[pst] = { count: {}, start: mrng.int(0, Math.max(0, pl.length - 1)) }; modelUse[pst].count[playerModel] = 1; }

    var presetOrder = presets.map(function (p) { return { p: p, idx: perfIndex(p.build) }; })
      .sort(function (a, b) { return Math.abs(Math.log(a.idx / playerIdx)) - Math.abs(Math.log(b.idx / playerIdx)); });

    var out = [];
    for (var i = 0; i < count; i++) {
      var driver = drivers[i % drivers.length];
      var team = teams[i % teams.length];
      var number;
      do { number = rng.int(2, 99); } while (usedNums[number]);
      usedNums[number] = 1;

      var skill = rng.range(diff.skill[0], diff.skill[1]);
      var consistency = rng.range(diff.consistency[0], diff.consistency[1]);
      var aggression = rng.range(diff.aggression[0], diff.aggression[1]);
      var personality = rng.pick(PERSONALITIES);
      // Grid strength gradient: the field fans out from slightly weaker to slightly stronger.
      var grad = count > 1 ? (i / (count - 1) - 0.5) : 0;
      var targetRatio = 1 + diff.perf + grad * diff.spread * 2 + rng.range(-0.5, 0.5) * diff.spread * 0.6;
      var target = playerIdx * targetRatio;

      var useMine = field === 'similar' || (field === 'mixed' && i % 2 === 0);
      var built, origin;
      if (useMine) {
        var bestB = null, bestErr = Infinity;
        for (var c = 0; c < 6; c++) {
          var cand = normalizeBuild(randomMods(deepClone(player), rng, 1));
          var ci = perfIndex(cand), err = Math.abs(Math.log(ci / target));
          if (err < bestErr) { bestErr = err; bestB = cand; }
        }
        built = matchPerformance(bestB, target, rng, 8, 0.02);
        origin = 'variation';
      } else {
        var k = field === 'mixed' ? Math.floor(i / 2) : i;
        var pr = presetOrder[k % presetOrder.length].p;
        var pb = deepClone(pr.build);
        if (k >= presetOrder.length) pb = randomMods(pb, rng, 0.6);
        // Balance presets partially toward the target so races stay competitive but machinery stays varied.
        var pIdx = perfIndex(pb);
        var balTarget = Math.exp(lerp(Math.log(pIdx), Math.log(target), opts.balance === false ? 0 : 0.75));
        built = matchPerformance(pb, balTarget, rng, 8, 0.03);
        origin = 'preset:' + pr.id;
      }
      var b = applyLivery(built.build, team, number, driver, rng);
      b = normalizeBuild(b);
      // normalize may strip custom meta — re-apply livery metadata defensively
      b.exterior.paint = team.color; b.exterior.livery_number = String(number);
      var carModel = assignModel(b, mrng, modelUse, origin !== 'variation' ? built.build.body && built.build.body.model : null);

      out.push({
        id: 'ai-' + (i + 1),
        name: driver.name,
        firstName: driver.first,
        lastName: driver.last,
        code: driver.code,
        nationality: driver.nat,
        team: team.name,
        teamId: team.id,
        teamShort: team.short,
        number: number,
        color: team.color,
        accent: team.accent,
        livery: { color: team.color, accent: team.accent, stripe: team.stripe, number: number },
        build: b,
        bodyStyle: (b.body && b.body.style) || 'coupe',
        model: carModel ? carModel.id : null,
        carName: carModel ? ((carModel.make ? carModel.make + ' ' : '') + (carModel.name || carModel.id)) : null,
        origin: origin,
        skill: Math.round(skill * 1000) / 1000,
        aggression: Math.round(aggression * 1000) / 1000,
        consistency: Math.round(consistency * 1000) / 1000,
        reaction_s: Math.round(rng.range(diff.reaction[0], diff.reaction[1]) * 1000) / 1000,
        mistakeMult: diff.mistakeMult,
        personality: personality.id,
        personalityDesc: personality.desc,
        difficulty: diff.id,
        perfIndex: Math.round(built.index * 10) / 10,
        perfRatio: Math.round(built.index / playerIdx * 1000) / 1000,
        seed: (seed + i * 7919) >>> 0,
        rubberBand: !!opts.rubberBand,
      });
    }
    return out;
  }

  /* ======================================================================
     Geometry adapter (tolerant of naming differences in tracks.build output)
     ====================================================================== */

  var geomCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function sampleArray(geom) {
    var cands = [geom.samples, geom.centerline, geom.center, geom.points, geom.pts, geom.nodes];
    for (var i = 0; i < cands.length; i++) if (cands[i] && cands[i].length > 3) return cands[i];
    if (Array.isArray(geom) && geom.length > 3) return geom;
    return null;
  }

  function adaptGeom(geom) {
    if (!geom) throw new Error('CB.race.ai: geometry required');
    if (geomCache && geomCache.has(geom)) return geomCache.get(geom);
    var arr = sampleArray(geom);
    if (!arr) throw new Error('CB.race.ai: geometry has no centerline samples');
    var n = arr.length;
    function px(p) { return num(p.x) ? p.x : p[0]; }
    function py(p) { return num(p.y) ? p.y : p[1]; }
    if (n > 3 && Math.hypot(px(arr[n - 1]) - px(arr[0]), py(arr[n - 1]) - py(arr[0])) < 0.05) n--;
    var xs = new Float64Array(n), ys = new Float64Array(n), hs = new Float64Array(n), ss = new Float64Array(n);
    var hw = new Float64Array(n), kerbL = new Float64Array(n), kerbR = new Float64Array(n), ck = new Float64Array(n);
    var defW = first(geom.width, geom.width_m, geom.trackWidth, geom.def && geom.def.width_m, 12);
    var i;
    for (i = 0; i < n; i++) { xs[i] = px(arr[i]); ys[i] = py(arr[i]); }
    var acc = 0;
    for (i = 0; i < n; i++) {
      var p = arr[i];
      var j = (i + 1) % n, k = (i - 1 + n) % n;
      // heading from the sample positions (central difference): smooth by construction, whereas authored /
      // spline-evaluated headings can carry mrad-level jitter that would shake the racing-line normals
      hs[i] = Math.atan2(ys[j] - ys[k], xs[j] - xs[k]);
      if (!isFinite(hs[i]) || (xs[j] === xs[k] && ys[j] === ys[k])) hs[i] = num(p.heading) ? p.heading : 0;
      ss[i] = num(p.s) ? p.s : acc;
      acc += Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
      var w = first(p.width, p.width_m, num(p.halfWidth) ? p.halfWidth * 2 : undefined, defW);
      hw[i] = w / 2;
      kerbL[i] = num(p.leftKerb) ? p.leftKerb : (p.leftKerb ? 1.0 : 0);
      kerbR[i] = num(p.rightKerb) ? p.rightKerb : (p.rightKerb ? 1.0 : 0);
      ck[i] = num(p.curvature) ? p.curvature : NaN;
    }
    var length = first(geom.length, geom.length_m, geom.totalLength, geom.total, acc);
    if (!(length > 0)) length = acc;
    var hasWalls = !!(geom.walls === true || geom.hasWalls || (geom.def && geom.def.walls) || geom.surfaceOutside === 'wall');
    var A = {
      src: geom, n: n, xs: xs, ys: ys, hs: hs, ss: ss, hw: hw, kerbL: kerbL, kerbR: kerbR, ck: ck,
      length: length, ds: length / n, hasWalls: hasWalls,
      grip: first(geom.surface && geom.surface.grip, geom.grip, geom.def && geom.def.surface && geom.def.surface.grip, 1),
    };
    A.lineOff = racingLineOffsets(A, geom);
    buildLine(A);
    if (geomCache) geomCache.set(geom, A);
    return A;
  }

  function racingLineOffsets(A, geom) {
    var n = A.n, rl = geom.racingLine, off = new Float64Array(n), i;
    // Prefer full-precision racing-line points (tracks.js rounds the scalar offsets to 1 cm, which turns into
    // curvature noise of ~0.4e-3 1/m on straights — enough to make a 250 km/h car weave).
    var src = (geom.racingLineXY && geom.racingLineXY.length >= n && geom.racingLineXY) ||
      (rl && (rl.xy || rl.points || rl.offsets || rl.offset || rl.lateral || rl));
    if (src && src.length >= n) {
      var ok = true;
      for (i = 0; i < n; i++) {
        var v = src[i];
        if (num(v)) off[i] = v;
        else if (v && num(v.offset)) off[i] = v.offset;
        else if (v && num(v.lateral)) off[i] = v.lateral;
        else if (v && (num(v.x) || num(v[0]))) {
          var vx = num(v.x) ? v.x : v[0], vy = num(v.y) ? v.y : v[1];
          off[i] = (vx - A.xs[i]) * -Math.sin(A.hs[i]) + (vy - A.ys[i]) * Math.cos(A.hs[i]);
        } else { ok = false; break; }
      }
      if (ok) {
        // light low-pass to remove any residual quantisation (keeps the shape: 3-tap binomial, 2 passes)
        var tmp = new Float64Array(n);
        for (var pass = 0; pass < 2; pass++) {
          for (i = 0; i < n; i++) tmp[i] = 0.25 * off[(i - 1 + n) % n] + 0.5 * off[i] + 0.25 * off[(i + 1) % n];
          off.set(tmp);
        }
        // Edge margin: tracks.js lines touch hw - 0.8 (outer wheels on the paint), which leaves no room at all for
        // a tracking error at 250 km/h on an 11 m ribbon. Compress the outermost metre softly (a hard clamp
        // after the low-pass would put curvature kinks into the line) so the centre keeps >= ~1.1 m.
        var EM = 1.15;
        for (i = 0; i < n; i++) {
          var limE = A.hw[i] - EM, knee = limE - 0.8, ao = Math.abs(off[i]);
          if (ao > knee) off[i] = sign(off[i]) * (knee + 0.8 * Math.tanh((ao - knee) / 0.8));
          off[i] = clamp(off[i], -A.hw[i] + 0.8, A.hw[i] - 0.8);
        }
        return off;
      }
    }
    return computeRacingLine(A);
  }

  /** Fallback racing line: iterative curvature minimisation (Laplacian smoothing projected on normals). */
  function computeRacingLine(A, iterations, margin) {
    var n = A.n, off = new Float64Array(n), i;
    margin = margin == null ? 1.6 : margin;
    var nx = new Float64Array(n), ny = new Float64Array(n);
    for (i = 0; i < n; i++) { nx[i] = -Math.sin(A.hs[i]); ny[i] = Math.cos(A.hs[i]); }
    var strides = [12, 6, 3, 1].map(function (st) { return Math.max(1, Math.round(st * 2 / Math.max(0.5, A.ds))); });
    iterations = iterations || 70;
    var px = new Float64Array(n), py = new Float64Array(n);
    strides.forEach(function (k) {
      for (var it = 0; it < iterations; it++) {
        for (i = 0; i < n; i++) { px[i] = A.xs[i] + nx[i] * off[i]; py[i] = A.ys[i] + ny[i] * off[i]; }
        for (i = 0; i < n; i++) {
          var a = (i - k + n) % n, b = (i + k) % n;
          var mx = (px[a] + px[b]) * 0.5 - px[i], my = (py[a] + py[b]) * 0.5 - py[i];
          var lim = Math.max(0, A.hw[i] - margin);
          off[i] = clamp(off[i] + (mx * nx[i] + my * ny[i]) * 0.55, -lim, lim);
        }
      }
    });
    return off;
  }

  /** Racing-line points, segment lengths and signed curvature. */
  function buildLine(A) {
    var n = A.n, i;
    var lx = new Float64Array(n), ly = new Float64Array(n), seg = new Float64Array(n), lk = new Float64Array(n);
    for (i = 0; i < n; i++) {
      lx[i] = A.xs[i] - Math.sin(A.hs[i]) * A.lineOff[i];
      ly[i] = A.ys[i] + Math.cos(A.hs[i]) * A.lineOff[i];
    }
    for (i = 0; i < n; i++) { var j = (i + 1) % n; seg[i] = Math.max(0.05, Math.hypot(lx[j] - lx[i], ly[j] - ly[i])); }
    var k = Math.max(1, Math.round(6 / Math.max(0.5, A.ds)));
    var raw = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var a = (i - k + n) % n, c = (i + k) % n;
      var abx = lx[i] - lx[a], aby = ly[i] - ly[a], bcx = lx[c] - lx[i], bcy = ly[c] - ly[i], acx = lx[c] - lx[a], acy = ly[c] - ly[a];
      var den = Math.hypot(abx, aby) * Math.hypot(bcx, bcy) * Math.hypot(acx, acy);
      raw[i] = den > 1e-9 ? 2 * (abx * bcy - aby * bcx) / den : 0;
    }
    // smooth (moving average +-4 m) first, then bias toward the local peak of the *smoothed* signal so apexes
    // are respected without amplifying sample noise on straights
    var win = Math.max(1, Math.round(4 / Math.max(0.5, A.ds)));
    var sm = new Float64Array(n), d;
    for (i = 0; i < n; i++) {
      var sum = 0, cnt = 0;
      for (d = -win; d <= win; d++) { sum += raw[(i + d + n) % n]; cnt++; }
      sm[i] = sum / cnt;
    }
    var pw = Math.max(1, Math.round(3 / Math.max(0.5, A.ds)));
    for (i = 0; i < n; i++) {
      var mx = 0;
      for (d = -pw; d <= pw; d++) { var v = sm[(i + d + n) % n]; if (Math.abs(v) > Math.abs(mx)) mx = v; }
      lk[i] = 0.65 * sm[i] + 0.35 * mx;
    }
    var lh = new Float64Array(n);
    for (i = 0; i < n; i++) { var nx1 = (i + 1) % n, pv1 = (i - 1 + n) % n; lh[i] = Math.atan2(ly[nx1] - ly[pv1], lx[nx1] - lx[pv1]); }
    A.lx = lx; A.ly = ly; A.lineSeg = seg; A.lineK = lk; A.lineH = lh;
  }

  /** Internal projection (local search around a hint). */
  function projectLocal(A, x, y, hint) {
    var n = A.n, best = 0, bd = Infinity, i;
    if (!(hint >= 0 && hint < n)) {
      for (i = 0; i < n; i++) { var d0 = (A.xs[i] - x) * (A.xs[i] - x) + (A.ys[i] - y) * (A.ys[i] - y); if (d0 < bd) { bd = d0; best = i; } }
    } else {
      var center = hint | 0, W = 40;
      for (var pass = 0; pass < 6; pass++) {
        var edge = false;
        for (var d = -W; d <= W; d++) {
          i = (center + d + n) % n;
          var dd = (A.xs[i] - x) * (A.xs[i] - x) + (A.ys[i] - y) * (A.ys[i] - y);
          if (dd < bd) { bd = dd; best = i; edge = Math.abs(d) === W; }
        }
        if (!edge) break;
        center = best;
      }
    }
    var h = A.hs[best], tx = Math.cos(h), ty = Math.sin(h);
    var dx = x - A.xs[best], dy = y - A.ys[best];
    var along = dx * tx + dy * ty, lat = -dx * ty + dy * tx;
    var s = A.ss[best] + along;
    if (s < 0) s += A.length; else if (s >= A.length) s -= A.length;
    var hw = A.hw[best];
    var kerb = lat > 0 ? A.kerbL[best] : A.kerbR[best];
    var surface = Math.abs(lat) <= hw ? 'asphalt' : Math.abs(lat) <= hw + kerb ? 'kerb' : (A.hasWalls ? 'wall' : 'grass');
    return { index: best, s: s, lateral: lat, onTrack: Math.abs(lat) <= hw + kerb, surface: surface };
  }

  function project(A, x, y, hint) {
    var T = CB.race.tracks;
    // Delegate only for geometries produced by tracks.build (they carry per-sample half widths & a spatial
    // grid); foreign/stub geometries use the internal local search, which understands any sample shape.
    if (A.nativeProject === undefined) {
      var s0 = A.src && A.src.samples && A.src.samples[0];
      A.nativeProject = !!(T && typeof T.project === 'function' && s0 && num(s0.hw) && A.src._grid);
    }
    if (A.nativeProject) {
      try {
        var r = T.project(A.src, x, y, hint);
        if (r && num(r.index) && num(r.lateral)) {
          if (!num(r.s)) r.s = A.ss[r.index % A.n];
          if (typeof r.onTrack !== 'boolean') r.onTrack = Math.abs(r.lateral) <= A.hw[r.index % A.n] + 0.5;
          r.index = ((r.index % A.n) + A.n) % A.n;
          return r;
        }
      } catch (e) { /* fall back */ }
    }
    return projectLocal(A, x, y, hint);
  }

  /* ======================================================================
     Vehicle capability estimation (tolerant of vehicle.js param naming)
     ====================================================================== */

  function scanMu(params, wet) {
    var vals = [];
    function visit(o, depth) {
      if (!o || typeof o !== 'object' || depth > 2) return;
      Object.keys(o).forEach(function (key) {
        var v = o[key];
        if (num(v)) {
          var lk = key.toLowerCase();
          var isMu = lk === 'mu' || lk.indexOf('mu') === 0 || /mu$/.test(lk) || lk.indexOf('_mu') >= 0 ||
            /mu[A-Z_]/.test(key) || /[a-z]Mu/.test(key) || lk.indexOf('friction') >= 0;
          if (!isMu || /mult|multiplier|mutable|num/.test(lk)) return;
          if (/wet/.test(lk) !== !!wet) return;
          if (/mult|scale|factor|load|sens/.test(lk)) return;
          if (v >= 0.3 && v <= 2.6) vals.push(v);
        } else if (isObj(v) || Array.isArray(v)) visit(v, depth + 1);
      });
    }
    visit(params, 0);
    if (!vals.length) return undefined;
    return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  }

  function estimateLimits(params, build, metrics) {
    params = params || {};
    var m = metrics || params.metrics || null;
    var hm = build ? heuristicMetrics(build) : null;
    var L = {};
    L.mass = first(params.mass, params.mass_kg, params.m, m && m.weight_kg, hm && hm.weight_kg, 1450);
    L.mu = first(params.maxLatG, params.latG, scanMu(params, false), m && (m.gripFront + m.gripRear) / 2, hm && hm.gripFront, 1.0);
    L.muWet = first(scanMu(params, true), L.mu * 0.72);
    var dfK = first(params.downforceK, params.dfK, params.liftK,
      num(params.clA) ? 0.5 * RHO * params.clA : undefined,
      num(params.ClA) ? 0.5 * RHO * params.ClA : undefined,
      num(params.downforceCoef) ? params.downforceCoef : undefined);
    var df200 = first(params.downforce_kg_200, params.downforceKg200, m && m.downforce_kg_200, hm && hm.downforce_kg_200);
    if (!num(dfK)) dfK = num(df200) ? df200 * G / (55.556 * 55.556) : 0;
    L.dfK = Math.max(0, dfK);
    var dragK = first(params.dragK, num(params.cdA) ? 0.5 * RHO * params.cdA : undefined,
      num(params.cda) ? 0.5 * RHO * params.cda : undefined, num(params.CdA) ? 0.5 * RHO * params.CdA : undefined,
      m && num(m.cda) ? 0.5 * RHO * m.cda : undefined);
    L.dragK = num(dragK) ? dragK : 0.5 * RHO * 0.7;
    var pw = first(params.maxPower_w, params.power_w, params.peakPower_w,
      num(params.power_kw) ? params.power_kw * 1000 : undefined, num(params.maxPower_kw) ? params.maxPower_kw * 1000 : undefined,
      num(params.peakPower_kw) ? params.peakPower_kw * 1000 : undefined, num(params.power_hp) ? params.power_hp * 745.7 : undefined);
    if (!num(pw)) {
      var curve = params.torqueCurve || params.curve;
      if (Array.isArray(curve) && curve.length) {
        var best = 0;
        curve.forEach(function (c) {
          if (c && num(c.hp)) best = Math.max(best, c.hp * 745.7);
          else if (c && num(c.nm) && num(c.rpm)) best = Math.max(best, c.nm * c.rpm * TAU / 60);
        });
        if (best > 0) pw = best;
      }
    }
    if (!num(pw)) pw = (m && num(m.power_kw) ? m.power_kw * 1000 : (hm ? hm.power_kw * 1000 : 220000));
    L.power = pw * 0.88;
    var layout = params.layout || params.drivetrain || (build && build.drivetrain && build.drivetrain.layout) || 'rwd';
    if (typeof layout !== 'string') layout = layout.layout || 'rwd';
    L.driveFrac = layout === 'awd' ? 0.98 : layout === 'fwd' ? 0.58 : 0.6;
    var bd = m && num(m.brakingDist_100_0_m) && m.brakingDist_100_0_m > 15 ? (27.78 * 27.78) / (2 * m.brakingDist_100_0_m) / G : undefined;
    L.brakeG = first(params.maxBrakeG, params.brakeG, bd, L.mu * 0.96);
    L.vTop = first(params.topSpeed_ms, params.vmax, num(params.topSpeed_kph) ? params.topSpeed_kph / 3.6 : undefined,
      m && num(m.topSpeed_kph) ? m.topSpeed_kph / 3.6 : undefined, Math.pow(L.power / Math.max(0.05, L.dragK), 1 / 3) * 0.97);
    L.vTop = clamp(L.vTop, 25, 125);
    L.rr = first(params.rollingResistance, params.crr, 0.013);
    L.wheelbase = first(params.wheelbase, params.wheelbase_m, params.L, build && build.body && build.body.wheelbase_mm / 1000, 2.65);
    L.width = first(params.width, params.width_m, build && build.body && build.body.trackWidth_mm / 1000 + 0.3, 1.9);
    L.length = first(params.length, params.length_m, L.wheelbase * 1.68, 4.5);
    L.maxSteer = first(params.maxSteer, params.maxSteer_rad, params.maxSteerAngle, params.steerMax, params.steerLock, 0.55);
    if (L.maxSteer > 1.6) L.maxSteer = L.maxSteer * Math.PI / 180;   // given in degrees
    L.hasABS = !!(params.abs || params.absLevel || params.ABS || (build && build.brakes && build.brakes.abs && build.brakes.abs !== 'off'));
    L.hasTC = !!(params.tc || params.tcLevel || params.tractionControl || (build && build.drivetrain && build.drivetrain.tractionControl > 0));
    L.autoShift = params.autoShift !== false;
    L.redline = first(params.redline, params.redline_rpm, params.redlineRpm, 7000);
    L.isEV = !!(params.ev || params.isEV || params.EV);
    L.aFront = clamp(first(params.a, params.cgToFront, L.wheelbase * 0.48), 0.5, 3);   // CG -> front axle (m)
    L.alphaPkF = clamp(first(params.tanAlphaPeakF, params.alphaPeakF, params.tanAlphaPeakR, params.slipPeak, 0.15), 0.06, 0.3);
    L.alphaPk = clamp(first(params.tanAlphaPeakR, params.alphaPeakR, params.slipPeak, 0.14), 0.06, 0.3);   // rear peak slip (rad)
    // hardware brake ceiling (vehicle.js brakeForceMax, N), as a deceleration; ABS / bias losses ~8 %
    L.brakeHW = num(params.brakeForceMax) && params.brakeForceMax > 0 ? params.brakeForceMax / L.mass * 0.92 : Infinity;
    L.weightFront = clamp(first(params.weightFront, num(params.weightFront_pct) ? params.weightFront_pct / 100 : undefined,
      m && num(m.weightFront_pct) ? m.weightFront_pct / 100 : undefined, 0.52), 0.25, 0.75);
    L.rearDrive = layout === 'fwd' ? 0 : layout === 'awd' ? clamp(1 - first(params.splitF, 0.4), 0, 1) : 1;
    L.balTable = axleBalanceTable(params, L);
    L.usK = understeerGradient(params, L);
    if (params.handling === 'arcade' && isObj(params.arcade)) {
      // ARCADE-SPEC: kinematic grip model — neutral balance, steering maps straight to path curvature, the
      // brakes / traction are the arcade caps and downforce only adds its (smaller) arcade share of grip.
      L.arcade = true;
      L.mu = first(params.arcade.latG, L.mu);
      L.muWet = L.mu * 0.94;
      L.brakeG = first(params.arcade.brakeG, L.brakeG);
      L.brakeHW = Infinity;
      L.dfK *= first(params.arcade.dfGain, 0.35);
      L.driveFrac = first(params.arcade.tracG, 1.1) / L.mu;
      L.power *= first(params.arcade.punch, 1.1);
      L.balTable = null; L.usK = null;
    }
    return L;
  }

  /**
   * Linear understeer gradient K (rad of steer per m/s^2 of lateral acceleration) per 5 m/s speed row, from
   * the axle cornering stiffnesses (vehicle.js tyres: C = kAlpha * Fz, kAlpha = mu*C*B / tanAlphaPeak) with
   * the aero load split: delta = L*k + K*ay. A rear-biased aero map (prototypes, dfFrontFrac ~0.26) makes a car
   * strongly understeer at 250 km/h — with the kinematic map alone the AI asked for half the lock it needed,
   * ran wide, braked mid-corner and unsettled the car. null without tyre data (stubs: kinematic).
   */
  function understeerGradient(p, L) {
    if (!p || !(num(p.muF) && num(p.muR) && num(p.tanAlphaPeakF) && num(p.tanAlphaPeakR) && num(p.weightFront))) return null;
    var CBf = num(p.shapeC) && num(p.shapeB) ? p.shapeC * p.shapeB : 2.84;
    var kF = p.muF * CBf / p.tanAlphaPeakF, kR = p.muR * CBf / p.tanAlphaPeakR;
    var wb = first(p.wheelbase, L.wheelbase), wf = p.weightFront, a = first(p.a, wb * (1 - wf)), b = first(p.b, wb * wf);
    var mg = L.mass * G, clA = num(p.clA) ? p.clA : L.dfK / (0.5 * RHO), dfFF = first(p.dfFrontFrac, 0.45), rows = [];
    for (var v = 0; v <= 125; v += 5) {
      var df = 0.5 * RHO * clA * v * v;
      var CF = kF * (mg * wf + df * dfFF), CR = kR * (mg * (1 - wf) + df * (1 - dfFF));
      rows.push(L.mass / wb * (b / CF - a / CR));
    }
    return rows;
  }
  /** Steady-state yaw gain relative to the kinematic (Ackermann) map at speed v. */
  function yawGainAt(L, v) {
    var t = L.usK;
    if (!t) return 1;
    var f = clamp(v / 5, 0, t.length - 1.001), i = Math.floor(f), K = lerp(t[i], t[i + 1], f - i);
    return clamp(L.wheelbase / Math.max(0.3, L.wheelbase + K * v * v), 0.3, 1.25);
  }

  /**
   * Axle-by-axle lateral capacity (vehicle.js params: muF/muR, weightFront, a/b, cgHeight, track, rsdF,
   * dfFrontFrac, clA, load sensitivity). A single "maxLatG" hides the car's balance: a rear-engined 911 has
   * 65 % of its weight on the rear tyres, front-biased aero and a driven rear axle that also has to carry the
   * drag-holding drive force, so the REAR saturates first (limit oversteer) — and an oversteering car at the
   * limit diverges instead of running gently wide. Returns per-speed rows { bal, ay } every 5 m/s, where
   * bal = rear-limited ay / front-limited ay (<1: rear lets go first) and ay = the lower of the two (m/s^2).
   * null when the params do not describe the axles (stub vehicles: treated as neutral).
   */
  function axleBalanceTable(p, L) {
    if (!p || !(num(p.muF) && num(p.muR) && num(p.weightFront) && num(p.cgHeight) && num(p.track))) return null;
    var wb = first(p.wheelbase, L.wheelbase), wf = clamp(p.weightFront, 0.2, 0.8);
    var a = first(p.a, wb * (1 - wf)), b = first(p.b, wb * wf);
    var m = L.mass, mg = m * G, rsdF = clamp(first(p.rsdF, 0.5), 0.2, 0.8), dfFF = clamp(first(p.dfFrontFrac, 0.45), 0, 1);
    var clA = num(p.clA) ? p.clA : L.dfK / (0.5 * RHO), ks = first(p.loadSens, 0.11), fz0 = mg / 4;
    var refF = first(p.fzRefF, fz0), refR = first(p.fzRefR, fz0), z0F = first(p.fz0F, fz0), z0R = first(p.fz0R, fz0);
    function wheel(Fz, mu, ref, z0) { return Fz <= 0 ? 0 : mu * clamp(1 - ks * (Fz - ref) / z0, 0.72, 1.18) * Fz; }
    function cap(axle, dLat, mu, ref, z0) { return wheel(axle / 2 - dLat, mu, ref, z0) + wheel(axle / 2 + dLat, mu, ref, z0); }
    var rows = [];
    for (var v = 0; v <= 125; v += 5) {
      var df = 0.5 * RHO * clA * v * v, FzF = mg * wf + df * dfFF, FzR = mg * (1 - wf) + df * (1 - dfFF);
      // drive force the rear has to make just to hold speed (drag + rolling): spent from the friction circle
      var fxR = (L.dragK * v * v + L.rr * (mg + df)) * L.rearDrive;
      var lo = [0, 0], hi = [4 * G, 4 * G];
      for (var it = 0; it < 26; it++) {
        for (var ax = 0; ax < 2; ax++) {
          var ay = 0.5 * (lo[ax] + hi[ax]), latT = m * ay * p.cgHeight / p.track, ok;
          if (ax === 0) ok = m * ay * b / wb <= cap(FzF, latT * rsdF, p.muF, refF, z0F);
          else { var cR = cap(FzR, latT * (1 - rsdF), p.muR, refR, z0R); ok = m * ay * a / wb <= Math.sqrt(Math.max(0, cR * cR - fxR * fxR)); }
          if (ok) lo[ax] = ay; else hi[ax] = ay;
        }
      }
      rows.push({ bal: lo[1] / Math.max(0.1, lo[0]), ay: Math.min(lo[0], lo[1]), ayF: lo[0], ayR: lo[1], fxR: fxR });
    }
    return rows;
  }
  function balanceAt(L, v) {
    var t = L.balTable;
    if (!t) return 1;
    var f = clamp(v / 5, 0, t.length - 1.001), i = Math.floor(f);
    return lerp(t[i].bal, t[i + 1].bal, f - i);
  }
  /** Rear-axle-limited lateral acceleration at speed v (m/s^2; Infinity without axle data). */
  function rearLatAt(L, v) {
    var t = L.balTable;
    if (!t) return Infinity;
    var f = clamp(v / 5, 0, t.length - 1.001), i = Math.floor(f);
    return lerp(t[i].ayR, t[i + 1].ayR, f - i);
  }
  /** 0..1: how oversteer-limited the car is at speed v (0 = front saturates first, 1 = rear lets go >= 4 % first). */
  function oversteerFactor(L, v) { return clamp((1.005 - balanceAt(L, v)) / 0.04, 0, 1); }

  function latAccel(L, v, gripScale) {
    var a = L.mu * gripScale * G * (1 + L.dfK * v * v / (L.mass * G));
    // The lumped estimate spreads all downforce over an average mu; the axle that saturates first decides.
    // A prototype with 72 % of its downforce on the rear axle is front-limited at 250 km/h well below the
    // lumped figure (it ran wide on the speedway banking at the planned speed).
    if (L.balTable) {
      var t = L.balTable, f = clamp(v / 5, 0, t.length - 1.001), i = Math.floor(f);
      a = Math.min(a, lerp(t[i].ay, t[i + 1].ay, f - i) * 0.93 * gripScale);
    }
    return a;
  }
  function brakeAccel(L, v, gripScale) {
    // Tyre-limited deceleration grows with downforce, but the brakes themselves have a torque ceiling: a
    // high-downforce car at 300 km/h cannot turn 2.4 g of tyre grip into deceleration if its calipers stop at
    // 1.7 g (planning the tyre figure had prototypes arrive at the hairpin 40 km/h hot).
    var tyre = Math.min(L.brakeG, L.mu * 1.05) * gripScale * G * (1 + L.dfK * v * v / (L.mass * G));
    return Math.min(tyre, L.brakeHW) + (L.dragK * v * v) / L.mass;
  }
  function driveAccel(L, v, gripScale) {
    var trac = L.mu * gripScale * G * L.driveFrac * (1 + L.dfK * v * v / (L.mass * G) * 0.8);
    var pw = L.power / (L.mass * Math.max(v, 4));
    return Math.min(trac, pw) - (L.dragK * v * v) / L.mass - L.rr * G;
  }

  /** Planning margin on the grip estimate. Long fast sweepers get extra margin (a line error at 150+ km/h costs
   *  metres before it can be corrected). An oversteer-limited car gets more, growing with speed: once the rear
   *  saturates first its yaw damping collapses (a car beyond its critical speed), so the plan must keep the
   *  rear out of the flat top of its tyre curve instead of relying on a catch. */
  function highSpeedMargin(v, L) {
    if (L && L.arcade) return 1 - 0.06 * smoothstep(25, 55, v);   // no snap at the limit: only a tracking margin (2.2 g arcade grip)
    var ov = L ? oversteerFactor(L, v) : 0;
    return 1 - (0.07 + 0.06 * ov) * smoothstep(30, 52, v) - 0.03 * ov;
  }

  /** Forward/backward-pass speed profile along the AI's racing line (downforce aware). */
  function internalProfile(A, L, gripScale, latUse) {
    var n = A.n, v = new Float64Array(n), i, pass;
    // Long fast sweepers are taken with a little extra margin: at 150+ km/h a small line error costs metres of
    // lateral drift before it can be corrected, and there is no braking reserve while the tyres are loaded up.
    // The margin depends on the (unknown) apex speed, so solve the fixed point by iteration.
    for (i = 0; i < n; i++) {
      var k = Math.abs(A.lineK[i]), vi = L.vTop;
      // narrow road: less room to absorb a tracking error at speed (Nordschleife-style 11 m ribbon)
      var narrow = clamp((7.2 - A.hw[i]) / 2, 0, 1);
      for (var it = 0; it < 4; it++) {
        var muE = L.mu * gripScale * latUse * highSpeedMargin(vi, L) * (1 - 0.06 * narrow * smoothstep(28, 50, vi));
        var denom = k - muE * L.dfK / L.mass;
        vi = denom <= 1e-7 ? L.vTop : Math.min(L.vTop, Math.sqrt(muE * G / denom));
      }
      v[i] = vi;
    }
    var aLatMax, aLat, circ, j;
    for (pass = 0; pass < 3; pass++) {
      // backward (braking)
      for (var c = 0; c < n; c++) {
        i = (n - 1 - c + n) % n; j = (i + 1) % n;
        aLatMax = latAccel(L, v[j], gripScale) * latUse; aLat = v[j] * v[j] * Math.abs(A.lineK[j]);
        // Trail-braking allowance shrinks with speed: at high speed, combined braking + cornering is where cars
        // let go (rear unloads under brake), so fast corners are planned with straight-line braking.
        // An oversteer-limited car (rear saturates first) gets even less: braking unloads exactly that axle.
        var hs = smoothstep(28, 48, v[j]), ovj = oversteerFactor(L, v[j]);
        circ = Math.sqrt(Math.max(0.12 * (1 - hs) * (1 - 0.5 * ovj), 1 - Math.pow(aLat / Math.max(0.1, aLatMax * (1 - (0.42 + 0.15 * ovj) * hs - 0.12 * ovj)), 2)));
        var vb = Math.sqrt(v[j] * v[j] + 2 * brakeAccel(L, v[j], gripScale) * latUse * circ * A.lineSeg[i]);
        if (v[i] > vb) v[i] = vb;
      }
      // forward (acceleration)
      for (i = 0; i < n; i++) {
        j = (i + 1) % n;
        aLatMax = latAccel(L, v[i], gripScale) * latUse; aLat = v[i] * v[i] * Math.abs(A.lineK[i]);
        circ = Math.sqrt(Math.max(0.15, 1 - Math.pow(aLat / Math.max(0.1, aLatMax), 2)));
        var a = Math.max(0.2, driveAccel(L, v[i], gripScale)) * circ;
        var vf = Math.sqrt(v[i] * v[i] + 2 * a * A.lineSeg[i]);
        if (v[j] > vf) v[j] = vf;
      }
    }
    return v;
  }

  /** Track helper profile, if tracks.js provides it (contract: speedProfile(maxLatG, maxBrakeG, accelFn)). */
  function trackProfile(A, L, gripScale) {
    var geom = A.src, accelFn = function (v) { return Math.max(0, driveAccel(L, v, gripScale)); };
    var refV = 45;   // evaluate downforce-assisted grip at a typical corner speed (~160 km/h)
    var latG = latAccel(L, refV, gripScale) / G, brakeG = (brakeAccel(L, refV, gripScale) - L.dragK * refV * refV / L.mass) / G;
    var res = null;
    try {
      if (typeof geom.speedProfile === 'function') res = geom.speedProfile(latG, brakeG, accelFn);
      else if (CB.race.tracks && typeof CB.race.tracks.speedProfile === 'function') res = CB.race.tracks.speedProfile(geom, latG, brakeG, accelFn);
    } catch (e) { res = null; }
    if (res && !res.length && (res.speeds || res.v)) res = res.speeds || res.v;
    if (!res || res.length < A.n) return null;
    var out = new Float64Array(A.n);
    for (var i = 0; i < A.n; i++) { var s = res[i]; if (!num(s) || s <= 0) return null; out[i] = s; }
    return out;
  }

  /* ======================================================================
     createDriver
     ====================================================================== */

  var MISTAKES = [
    { type: 'lateBrake', weight: 3, dur: [2.5, 4.0] },
    { type: 'runWide', weight: 3, dur: [1.6, 2.8] },
    { type: 'lockup', weight: 1.5, dur: [0.25, 0.5] },
    { type: 'wheelspin', weight: 1.5, dur: [0.4, 0.8] },
    { type: 'hesitation', weight: 1.5, dur: [0.3, 0.7] },
    { type: 'missedApex', weight: 2, dur: [1.5, 2.5] },
  ];

  function createDriver(opponent, geom, params, opts) {
    opponent = opponent || {};
    opts = opts || {};
    var A = adaptGeom(geom);
    var build = opponent.build || null;
    var L = estimateLimits(params || {}, build, opts.metrics || opponent.metrics);
    if (opts.limits) Object.keys(opts.limits).forEach(function (k) { if (num(opts.limits[k])) L[k] = opts.limits[k]; });

    var skill = clamp(first(opponent.skill, 0.75), 0, 1);
    var consistency = clamp(first(opponent.consistency, 0.8), 0, 1);
    var aggression = clamp(first(opponent.aggression, 0.5), 0, 1);
    var reaction = first(opponent.reaction_s, lerp(0.5, 0.14, skill));
    var mistakeMult = first(opts.mistakeMult, opponent.mistakeMult, 1);
    var pers = PERSONALITIES.filter(function (p) { return p.id === opponent.personality; })[0] || PERSONALITIES[1];
    var rng = makeRng(first(opponent.seed, hashStr(opponent.id || opponent.name || 'ai')));
    var selfId = opts.id != null ? opts.id : (opponent.id != null ? opponent.id : null);
    var rubberBandOpt = !!(opts.rubberBand != null ? opts.rubberBand : opponent.rubberBand);

    // Grip usage & braking confidence scale with skill.
    var latUse = lerp(0.8, 0.93, skill);
    var brakeUse = lerp(0.7, 0.9, skill) * pers.brakeBias;
    // arcade cars cannot spin: drivers lean harder on the grip and brake later
    var arcadeK = null;
    if (L.arcade) {
      latUse = lerp(0.84, 0.94, skill); brakeUse = lerp(0.8, 0.95, skill) * pers.brakeBias;
      var VM = CB.race && CB.race.vehicle;
      if (VM && typeof VM.arcadeCurvatureLimit === 'function') arcadeK = function (v, g) { return VM.arcadeCurvatureLimit(params, v, g); };
    }
    var steerSmooth = L.arcade ? lerp(9, 15, skill) : lerp(5, 11, skill);   // steer input slew (1/s; arcade cars turn snappier)
    var pedalRate = lerp(4, 9, skill);          // pedal slew (1/s)
    var halfCarW = L.width / 2, halfCarL = L.length / 2;

    // Smooth per-driver pace noise along the lap (corner-to-corner variation), amplitude by inconsistency.
    var noisePh = [rng.range(0, TAU), rng.range(0, TAU), rng.range(0, TAU)];
    var noiseAmp = (1 - consistency) * 0.035;
    function paceNoise(s) {
      var u = s / A.length * TAU;
      return 1 + noiseAmp * (0.5 * Math.sin(3 * u + noisePh[0]) + 0.3 * Math.sin(7 * u + noisePh[1]) + 0.2 * Math.sin(13 * u + noisePh[2]));
    }

    var profileCache = {};
    function profileFor(gripScale) {
      var key = Math.round(gripScale * 50) / 50;
      if (profileCache[key]) return profileCache[key];
      var inner = internalProfile(A, L, key, latUse);
      var tp = trackProfile(A, L, key);
      var prof = new Float64Array(A.n);
      for (var i = 0; i < A.n; i++) {
        // track helper (contract) used as a sanity cap on the downforce-aware internal profile
        var t = tp ? tp[i] * Math.sqrt(latUse) * 1.04 : Infinity;
        prof[i] = Math.max(4, Math.min(inner[i], t));
      }
      profileCache[key] = prof;
      return prof;
    }

    var S;   // mutable driver state
    function reset() {
      S = {
        t: 0, hint: -1, hints: {}, mode: 'grid', modeT: 0, steer: 0, throttle: 0, brake: 0,
        steerRatio: L.maxSteer, tacLat: 0, tacW: 0, tacMode: 'line', tacSide: 0, tacT: 0, tacTarget: null,
        defendT: 0, defendCooldown: 0, mistake: null, mistakeCooldown: rng.range(6, 14),
        lightsOutAt: null, stuckT: 0, offT: 0, reverseT: 0, lastProgressS: null, progressT: 0, lapForm: 1, lastLap: -1,
        tcCap: 1, absCap: 1, latTarget: null, dev: 0, prevIdx: -1, wantsReset: false, resetCooldown: 0,
        dbg: {},
      };
    }
    reset();

    // Velocity frame detection. The vehicle contract reports BODY-frame (vx forward, vy left), but foreign
    // states / engine snapshots may carry world-frame velocities. The two hypotheses are indistinguishable
    // when heading ~ 0, and "world, reversing" ties with "body, forward" when heading ~ pi, so: forward
    // hypotheses win ties, body is the default, and a confident verdict is latched per car (frames never
    // change at runtime).
    var frameLatch = {}, frameVotes = {};
    function frameTest(vs, speed, key) {
      if (!num(vs.vx) || !num(vs.vy)) return null;
      var h = vs.heading || 0, sp = num(speed) ? Math.abs(speed) : Math.hypot(vs.vx, vs.vy);
      var c = Math.cos(h), s = Math.sin(h);
      var isWorld = key != null ? frameLatch[key] : undefined;
      // A CB.race.vehicle state (it carries tyre slip angles) is body-frame by contract: never guess for it.
      if (isWorld === undefined && key === 'self' && num(vs.slipAngleR) && num(vs.yawRate)) isWorld = frameLatch[key] = false;
      if (isWorld === undefined) {
        isWorld = false;
        if (sp > 0.5) {
          var worldErr = Math.abs(vs.vx - sp * c) + Math.abs(vs.vy - sp * s);
          var bodyErr = Math.abs(vs.vx - sp) + Math.abs(vs.vy);
          var worldErrRev = Math.abs(vs.vx + sp * c) + Math.abs(vs.vy + sp * s);
          var bodyErrRev = Math.abs(vs.vx + sp) + Math.abs(vs.vy);
          var tol = 0.08 * sp + 0.2;
          var bodyBest = Math.min(bodyErr, bodyErrRev + tol), worldBest = Math.min(worldErr, worldErrRev + tol);
          isWorld = worldBest < bodyBest - tol;
          // Latch on accumulated evidence, never on a single frame: in a slide (body vy ~ speed) at a heading
          // near +-90 deg the world hypothesis fits one frame perfectly by coincidence, and a wrong latch would
          // leave the driver steering against a phantom slip for the rest of the race.
          if (key != null && sp > 3 && Math.abs(worldBest - bodyBest) > 0.6 * sp) {
            var vote = frameVotes[key] || (frameVotes[key] = { body: 0, world: 0, n: 0 });
            vote.body += bodyBest / sp; vote.world += worldBest / sp; vote.n++;
            if (vote.n >= 45) {
              if (vote.world < vote.body * 0.35) frameLatch[key] = true;
              else if (vote.body < vote.world * 0.35) frameLatch[key] = false;
              else { vote.body *= 0.5; vote.world *= 0.5; vote.n = 22; }   // ambiguous: keep gathering
            }
          }
        }
      }
      if (isWorld) return { vxW: vs.vx, vyW: vs.vy, vLong: vs.vx * c + vs.vy * s, vLat: -vs.vx * s + vs.vy * c };
      return { vxW: vs.vx * c - vs.vy * s, vyW: vs.vx * s + vs.vy * c, vLong: vs.vx, vLat: vs.vy };
    }

    function carVel(c) {
      var sp = num(c.speed) ? c.speed : 0, h = c.heading || 0;
      if (num(c.vx) && num(c.vy)) { var f = frameTest(c, sp, c.id != null ? 'car:' + c.id : null); if (f) return [f.vxW, f.vyW]; }
      return [Math.cos(h) * sp, Math.sin(h) * sp];
    }

    function wrapDs(d) { var Lh = A.length / 2; while (d > Lh) d -= A.length; while (d < -Lh) d += A.length; return d; }

    function idxAhead(idx, dist) {
      // walk forward along line segments
      var i = idx, acc = 0, guard = A.n;
      if (dist <= 0) return i;
      while (acc < dist && guard-- > 0) { acc += A.lineSeg[i]; i = (i + 1) % A.n; }
      return i;
    }

    function usableHalf(i, side) {
      var kerb = side > 0 ? A.kerbL[i] : A.kerbR[i];
      var margin = (A.hasWalls ? 0.75 : 0.35) + (L.arcade ? 0.4 : 0);   // arcade cars change lanes faster: keep a bigger edge margin
      return Math.max(0.3, A.hw[i] + (A.hasWalls ? 0 : kerb * 0.5) - halfCarW - margin);
    }

    function cornerDirAhead(idx, from, to) {
      // signed curvature integral of the line ahead (positive = left-hander)
      var i = idxAhead(idx, from), end = idxAhead(idx, to), sum = 0, g = A.n;
      while (i !== end && g-- > 0) { sum += A.lineK[i] * A.lineSeg[i]; i = (i + 1) % A.n; }
      return sum;
    }

    function startMistake(type, pressure) {
      var def = MISTAKES.filter(function (m) { return m.type === type; })[0];
      S.mistake = { type: type, t: 0, dur: rng.range(def.dur[0], def.dur[1]), mag: rng.range(0.4, 1) * (0.6 + 0.4 * (1 - consistency)) * (1 + pressure * 0.3) };
    }

    function maybeMistake(dt, pressure, wet, braking) {
      if (S.mistake) {
        S.mistake.t += dt;
        if (S.mistake.t >= S.mistake.dur) { S.mistake = null; S.mistakeCooldown = rng.range(5, 12); }
        return;
      }
      S.mistakeCooldown -= dt;
      if (S.mistakeCooldown > 0 || opts.mistakes === false) return;
      var rate = 0.03 * Math.pow(1 - consistency, 1.3) * mistakeMult * (1 + pressure * 1.2 + (wet ? 0.8 : 0));
      if (rng.next() < rate * dt) {
        var pool = MISTAKES.filter(function (m) {
          if (m.type === 'lockup' || m.type === 'lateBrake') return braking || m.type === 'lateBrake';
          return true;
        });
        var tot = pool.reduce(function (a, m) { return a + m.weight; }, 0), r = rng.next() * tot;
        for (var i = 0; i < pool.length; i++) { r -= pool[i].weight; if (r <= 0) { startMistake(pool[i].type, pressure); break; } }
      }
    }

    function mistakeIs(type) { return S.mistake && S.mistake.type === type; }

    /* ------------------------------------------------------------------ control */

    function control(vs, ctx, dt) {
      vs = vs || {};
      ctx = ctx || {};
      dt = dt > 0 && dt < 0.5 ? dt : 1 / 120;
      S.t += dt; S.modeT += dt;
      var input = { throttle: 0, brake: 0, steer: 0, handbrake: false, shiftUp: false, shiftDown: false, reverse: false, requestReset: false };

      var x = first(vs.x, 0), y = first(vs.y, 0), heading = first(vs.heading, 0);
      var speed = first(vs.speed, num(vs.vx) ? Math.hypot(vs.vx, vs.vy || 0) : 0);
      var fr = frameTest(vs, speed, 'self');
      var vLong = fr ? fr.vLong : speed, vLat = fr ? fr.vLat : 0;
      var vxW = fr ? fr.vxW : Math.cos(heading) * speed, vyW = fr ? fr.vyW : Math.sin(heading) * speed;
      var vAbs = Math.max(Math.abs(vLong), 0);
      S.vAbs = vAbs; S.gear = vs.gear;

      var pr = project(A, x, y, S.hint);
      S.hint = pr.index;
      var idx = pr.index, lat = pr.lateral;
      var trackH = A.hs[idx];
      var headErr = wrapAngle(heading - trackH);   // + = pointing left of track direction

      // ---- environment
      var env = ctx.env || {};
      var wet = !!(env.wet || ctx.weather === 'wet' || ctx.weather === 'damp');
      var gripMult = first(env.gripMult, ctx.gripMult, ctx.weather === 'wet' ? 0.72 : ctx.weather === 'damp' ? 0.86 : 1);
      var gripScale = clamp(gripMult * A.grip, 0.3, 1.5);
      if (wet && L.muWet < L.mu) gripScale = clamp(gripScale * Math.max(0.85, (L.muWet / L.mu) / 0.72), 0.3, 1.5);
      // Online grip learning: the planned grip is corrected by what the tyres actually tolerate
      // (robust to any vehicle model / setup / surface). See tyre-saturation monitor below.
      if (S.gripLearn == null) S.gripLearn = 1;
      var profile = profileFor(gripScale * S.gripLearn);

      // ---- identify self & context cars
      var cars = Array.isArray(ctx.cars) ? ctx.cars : [];
      var myId = ctx.selfId != null ? ctx.selfId : selfId;
      var me = null, player = null;
      for (var ci = 0; ci < cars.length; ci++) {
        var cc = cars[ci];
        if (!cc) continue;
        if (myId != null && cc.id === myId) me = cc;
        else if (myId == null && Math.abs((cc.x || 0) - x) < 1e-3 && Math.abs((cc.y || 0) - y) < 1e-3) me = cc;
        if (cc.isPlayer) player = cc;
      }
      if (me && me.isPlayer) player = null;

      // ---- phases: grid / countdown / launch
      var phase = ctx.phase || 'racing';
      var lightsOut = phase === 'racing' || phase === 'finished' || !!(ctx.countdown && ctx.countdown.lightsOut);
      if (!lightsOut) {
        S.mode = 'grid'; S.lightsOutAt = null;
        input.brake = 1; input.throttle = 0;
        input.steer = clamp(-headErr * 2, -1, 1) * 0.2;
        return finish(input, dt);
      }
      if (S.lightsOutAt === null) { S.lightsOutAt = S.t; S.launchLat = lat; }
      if (S.t - S.lightsOutAt < reaction && vAbs < 1) {
        input.brake = 1; return finish(input, dt);
      }
      var finished = phase === 'finished' || (me && (me.finished || me.dnf));

      // ---- lap form
      var myLap = me && num(me.lap) ? me.lap : 0;
      if (myLap !== S.lastLap) { S.lastLap = myLap; S.lapForm = 1 + rng.gauss() * (1 - consistency) * 0.006; }

      // ---- speed scale (skill/pace noise/form/rubber band/cool-down)
      var speedScale = paceNoise(pr.s) * S.lapForm;
      var rubber = ctx.rubberBand != null ? !!ctx.rubberBand : rubberBandOpt;
      if (rubber && player && me && num(player.s) && num(me.s)) {
        var gapM = ((player.lap || 0) - (me.lap || 0)) * A.length + (player.s - me.s);  // + = player ahead
        speedScale *= 1 + clamp(gapM / 350, -1, 1) * 0.045;
      }
      if (finished) speedScale *= 0.62;

      // ---- recovery state machine
      var surface = pr.surface || (pr.onTrack ? 'asphalt' : 'grass');
      var offTrack = !pr.onTrack || surface === 'grass' || surface === 'sand' || surface === 'wall';
      S.offT = offTrack ? S.offT + dt : Math.max(0, S.offT - dt * 2);

      // progress monitor
      if (S.lastProgressS === null) { S.lastProgressS = pr.s; S.progressT = 0; }
      S.progressT += dt;
      if (S.progressT > 1.0) {
        var prog = wrapDs(pr.s - S.lastProgressS);
        // edging round an obstacle at a crawl is progress, not being stuck
        if (prog < (S.crawling ? 0.7 : 1.5) && S.mode !== 'reverse' && S.mode !== 'grid') S.stuckT += S.progressT; else S.stuckT = Math.max(0, S.stuckT - S.progressT * 2);
        S.lastProgressS = pr.s; S.progressT = 0;
      }
      S.resetCooldown = Math.max(0, S.resetCooldown - dt);
      if (S.stuckT > 9 && S.resetCooldown <= 0) { input.requestReset = true; S.wantsReset = true; S.resetCooldown = 4; S.stuckT = 5; }

      var spun = Math.abs(headErr) > 1.75;
      if (S.mode === 'reverse') {
        S.reverseT -= dt;
        // Backing away from a car parked across our nose is done when the timer runs out — being aligned with
        // the track says nothing there (that is exactly how a car queues behind a stalled one forever).
        var reverseDone = S.reverseT <= 0 || (!S.reverseSide && Math.abs(headErr) < 0.5 && Math.abs(lat) < A.hw[idx] - 1);
        if (!reverseDone) {
          input.reverse = true;
          input.throttle = 0;
          input.brake = 1;          // brake-at-standstill → reverse convention; `reverse` flag for explicit support
          // while reversing, steering yaw is inverted: steer toward +headErr to rotate nose back to track direction
          // (or, backing out from behind a blocking car, to angle the nose toward the side with room)
          var noseAim = S.reverseSide ? S.reverseSide * 0.3 : 0;
          var wantNoseIn = clamp((headErr - noseAim) * 1.5 + (S.reverseSide ? 0 : (lat / Math.max(2, A.hw[idx])) * -0.6), -1, 1);
          input.steer = clamp(wantNoseIn, -1, 1);
          S.dbg.mode = 'reverse';
          return finish(input, dt, true);
        }
        S.mode = 'race'; S.modeT = 0; S.stuckT = 0; S.reverseSide = 0;
      }
      if (S.stuckT > 2.2 && vAbs < 2.5 && S.mode !== 'reverse') {
        S.mode = 'reverse'; S.modeT = 0; S.reverseT = rng.range(1.2, 2.0) + (spun ? 0.6 : 0); S.stuckT = 0;
        // Is a car parked right across our nose? Then back off properly and angle out toward the free side.
        S.reverseSide = 0;
        var chB = Math.cos(heading), shB = Math.sin(heading);
        for (var bi = 0; bi < cars.length; bi++) {
          var bc = cars[bi];
          if (!bc || bc === me || (myId != null && bc.id === myId) || !num(bc.x) || !num(bc.y)) continue;
          var bdx = bc.x - x, bdy = bc.y - y, bfx = bdx * chB + bdy * shB, bfy = -bdx * shB + bdy * chB;
          if (bfx > 0 && bfx < L.length + 3.5 && Math.abs(bfy) < L.width + 1.0) {
            var bpr = projectLocal(A, bc.x, bc.y, idx);
            var roomL = usableHalf(idx, 1) - bpr.lateral, roomR = bpr.lateral + usableHalf(idx, -1);
            S.reverseSide = roomL >= roomR ? 1 : -1;
            S.reverseT = Math.max(S.reverseT, 1.8);
            break;
          }
        }
        // Boxed in from behind as well: backing up only rams the car behind — keep it short and let the
        // forward crawl (wheels turned out) or, failing that, the marshals sort it out.
        if (S.reverseSide) {
          for (var bj = 0; bj < cars.length; bj++) {
            var bk = cars[bj];
            if (!bk || bk === me || (myId != null && bk.id === myId) || !num(bk.x) || !num(bk.y)) continue;
            var kdx = bk.x - x, kdy = bk.y - y, kfx = kdx * chB + kdy * shB, kfy = -kdx * shB + kdy * chB;
            if (kfx < 0 && kfx > -(L.length + 2.0) && Math.abs(kfy) < L.width + 0.4) { S.reverseT = 0.25; break; }
          }
        }
        S.stuckCycles = (S.stuckCycles || 0) + 1;
        // repeated cycles without getting going: ask the marshals (engine) to put us back on track
        if (S.stuckCycles >= 4 && S.resetCooldown <= 0) { input.requestReset = true; S.wantsReset = true; S.resetCooldown = 4; S.stuckCycles = 0; }
        input.brake = 1; return finish(input, dt);
      }
      if (vAbs > 8) S.stuckCycles = 0;
      var recovering = false;
      if (spun && vAbs < 9) {
        // Turn around: brake to a crawl, then full lock toward track direction (forward U-turn).
        S.mode = 'spun'; recovering = true;
        if (vLong > 3) { input.brake = 1; input.steer = 0; return finish(input, dt); }
        input.steer = headErr > 0 ? -1 : 1;
        input.throttle = surface === 'sand' || surface === 'gravel' ? 0.7 : surface === 'grass' ? 0.55 : 0.42;
        input.brake = 0;
        // prefer turning toward the wide side of the track
        if (Math.abs(lat) > A.hw[idx] * 0.4) {
          var turnRight = headErr > 0;   // turning right reduces positive headErr
          var noseMovesLeft = Math.abs(headErr) > Math.PI / 2 ? !turnRight : turnRight;
          if ((lat > 0 && noseMovesLeft) || (lat < 0 && !noseMovesLeft)) { /* would push to edge — accept, reverse logic will catch if stuck */ }
        }
        return finish(input, dt);
      } else if (spun) {
        // moving fast but pointing the wrong way (spinning): brake hard, steer into slide
        S.mode = 'spin'; input.brake = 1; input.steer = 0; input.handbrake = false;
        return finish(input, dt);
      }
      if (offTrack && S.offT > 0.15) { S.mode = 'offtrack'; recovering = true; }
      else if (S.mode === 'offtrack' || S.mode === 'spun' || S.mode === 'spin') { S.mode = 'rejoin'; S.modeT = 0; }
      if (S.mode === 'rejoin' && S.modeT > 1.5) S.mode = 'race';
      if (S.mode === 'grid') S.mode = 'race';

      // ---- mistakes
      var pressure = 0;
      maybeMistake(dt, pressure, wet, S.brake > 0.3);

      /* ------------------------------------------------ traffic awareness */
      var ahead = null, behind = null, sideBySide = [], nearby = [], avoidPush = 0, avoidBrake = 0, avoidRef = Infinity, minTTC = Infinity;
      var myS = pr.s;
      var laneHalf = halfCarW * 2 + 0.6;
      // Lateral corridor: hard bounds from cars alongside. The side each neighbour is on is latched when it
      // enters the overlap zone, so two cars that end up nose-to-tail in the same lane never "swap" sides
      // through each other (a push computed from the instantaneous offset flips sign at zero and dithers).
      if (!S.sideLatch) S.sideLatch = {};
      var corrLo = -Infinity, corrHi = Infinity, corrLoBy = null, corrHiBy = null, latchSeen = {};
      for (ci = 0; ci < cars.length; ci++) {
        var o = cars[ci];
        if (!o || o === me || o.dnf || !num(o.x) || !num(o.y)) continue;
        if (myId != null && o.id === myId) continue;
        var dxw = o.x - x, dyw = o.y - y, dist = Math.hypot(dxw, dyw);
        if (dist > 120) continue;
        var key = o.id != null ? o.id : ci;
        var op = projectLocal(A, o.x, o.y, S.hints[key]);
        S.hints[key] = op.index;
        var ds = wrapDs(op.s - myS), dl = op.lateral - lat;
        var ov = carVel(o);
        var oSpeed = num(o.speed) ? o.speed : Math.hypot(ov[0], ov[1]);
        var oW = first(o.width_m, o.width, L.width) / 2, oL = first(o.length_m, o.length, L.length) / 2;
        // longitudinal acceleration of the other car (finite difference, low-passed): lets a follower react to
        // the leader's braking before the gap has already collapsed
        if (!S.oSpd) { S.oSpd = {}; S.oAcc = {}; }
        var oAcc = 0;
        if (num(S.oSpd[key])) {
          var aRaw = clamp((oSpeed - S.oSpd[key]) / dt, -30, 30);
          oAcc = S.oAcc[key] = (S.oAcc[key] || 0) + (aRaw - (S.oAcc[key] || 0)) * clamp(dt / 0.12, 0, 1);
        }
        S.oSpd[key] = oSpeed;
        var info = { car: o, ds: ds, dl: dl, lat: op.lateral, speed: oSpeed, acc: oAcc, dist: dist, oW: oW, oL: oL, side: 0 };
        nearby.push(info);

        // overlap zone (longer when closing, so the side is chosen before the noses overlap)
        var closingRel = ds > 0 ? vAbs - oSpeed : oSpeed - vAbs;
        var zone = halfCarL + oL + 1.2 + clamp(closingRel * 0.4, 0, 5);
        if (Math.abs(ds) < zone && Math.abs(dl) < 9) {
          var latch = S.sideLatch[key];
          if (!latch) {
            // Purely geometric (sign of the lateral offset), so both cars of a pair latch *mirror* sides: any
            // intent-based choice (my overtaking side, where I have room) can disagree with the neighbour's own
            // latch, and two cars that each decide to stay left of the other meet in the middle.
            var sd = dl > 0 ? 1 : dl < 0 ? -1 : (String(key) < String(myId != null ? myId : '') ? 1 : -1);
            latch = S.sideLatch[key] = { side: sd, t: S.t };
          } else if (latch.side !== sign(dl) && Math.abs(dl) > halfCarW + oW + 0.2) {
            // already clear of each other on the other side (no lateral overlap): the latch is stale
            latch.side = sign(dl); latch.t = S.t;
          }
          latchSeen[key] = 1;
          info.side = latch.side;
          var sep = halfCarW + oW + 0.55;
          // Etiquette: a car still behind me (no overlap yet) is responsible for avoiding me — it is latched,
          // so the side is known the moment it gets alongside, but it does not push me off my line.
          var constrains = ds > -(halfCarL + oL + 1.0);
          if (!constrains) { /* latched only */ }
          else if (latch.side > 0) { var hiC = op.lateral - sep; if (hiC < corrHi) { corrHi = hiC; corrHiBy = info; } }
          else { var loC = op.lateral + sep; if (loC > corrLo) { corrLo = loC; corrLoBy = info; } }
        }

        info.key = key;
        // Hysteresis: the car we are already passing stays the target while we are beside its lane (otherwise
        // stepping out of its lane "loses" it, the AI returns to the racing line — straight back behind it —
        // and the move hunts back and forth down the straight).
        var aheadWin = laneHalf + 1.2 + (S.tacTarget === key && (S.tacMode === 'overtake' || S.tacMode === 'follow') ? 3.5 : 0);
        if (ds > 0 && ds < 90 && Math.abs(dl) < aheadWin) { if (!ahead || ds < ahead.ds) ahead = info; }
        if (ds < 0 && ds > -40 && (!behind || ds > behind.ds)) behind = info;
        if (Math.abs(ds) < halfCarL + oL + 1.5) sideBySide.push(info);

        // Time-to-collision in world space, tested in my body frame with box extents.
        var rvx = ov[0] - vxW, rvy = ov[1] - vyW, rv2 = rvx * rvx + rvy * rvy;
        var tc = rv2 > 1e-4 ? clamp(-(dxw * rvx + dyw * rvy) / rv2, 0, 2.0) : 0;
        var cxw = dxw + rvx * tc, cyw = dyw + rvy * tc;
        var ch = Math.cos(heading), sh = Math.sin(heading);
        var clx = cxw * ch + cyw * sh, cly = -cxw * sh + cyw * ch;
        var hitX = halfCarL + oL + 0.6, hitY = halfCarW + oW + 0.45;
        if (Math.abs(clx) < hitX && Math.abs(cly) < hitY && dist < 45) {
          var urgency = 1 - tc / 2.0;
          if (tc < minTTC) minTTC = tc;
          if (clx > 0 && ds > 0) {
            // they are ahead along our path: brake proportional to urgency, and steer away
            var abT = urgency * clamp((vAbs - oSpeed) / 6, 0, 1);
            if (abT > 0) { avoidBrake = Math.max(avoidBrake, abT); avoidRef = Math.min(avoidRef, oSpeed); }
          }
          var away = cly >= 0 ? -1 : 1;     // lateral (+left) push away from the predicted contact point
          if (Math.abs(cly) < 0.25) away = lat > op.lateral ? 1 : -1;
          if (info.side) away = -info.side;
          avoidPush += away * urgency * (hitY - Math.abs(cly)) * 0.9;
        }
        // Proximity bubble (current positions, my body frame): the predictive test above assumes straight-line
        // motion, which is poor in hairpins where both cars turn — this catches the close-quarters squeeze.
        if (dist < halfCarL + oL + 3) {
          var ch2 = Math.cos(heading), sh2 = Math.sin(heading);
          var bx = dxw * ch2 + dyw * sh2, by = -dxw * sh2 + dyw * ch2;
          var bubX = halfCarL + oL + 0.9, bubY = halfCarW + oW + 0.9;
          if (Math.abs(bx) < bubX && Math.abs(by) < bubY) {
            var depthY = bubY - Math.abs(by), wX = 1 - smoothstep(bubX * 0.6, bubX, Math.abs(bx));
            avoidPush += (info.side ? -info.side : (by >= 0 ? -1 : 1)) * depthY * 1.6 * wX;
            // closing on a car that is ahead of us and overlapping laterally: back off
            if (bx > 0 && Math.abs(by) < halfCarW + oW + 0.3) { avoidBrake = Math.max(avoidBrake, clamp((bubX - bx) / bubX, 0, 1) * 0.8); avoidRef = Math.min(avoidRef, oSpeed); }
            if (bx < 0 && Math.abs(by) < halfCarW + oW + 0.3) minTTC = Math.min(minTTC, 0);
          }
        }
      }
      for (var lk in S.sideLatch) if (!latchSeen[lk]) delete S.sideLatch[lk];
      // Smoothed corridor bounds: a neighbour entering the zone must not snap the reference across the lane
      // (a step of a few metres at 160 km/h whips the car into a slide). A new bound starts where the
      // reference already is and closes at a finite lateral rate; releasing a bound is immediate.
      var rawLo = corrLo, rawHi = corrHi;
      var cRate = (3 + vAbs * 0.03) * dt, refPrev = S.refPrev != null ? S.refPrev : lat;
      if (corrHi === Infinity) S.cHi = Infinity;
      else {
        if (S.cHi == null || S.cHi === Infinity) S.cHi = Math.max(corrHi, refPrev);
        S.cHi = corrHi >= S.cHi ? corrHi : approach(S.cHi, corrHi, cRate);
        corrHi = S.cHi;
      }
      if (corrLo === -Infinity) S.cLo = -Infinity;
      else {
        if (S.cLo == null || S.cLo === -Infinity) S.cLo = Math.min(corrLo, refPrev);
        S.cLo = corrLo <= S.cLo ? corrLo : approach(S.cLo, corrLo, cRate);
        corrLo = S.cLo;
      }
      // Squeezed: the corridor left by the cars alongside does not fit between the track edges (or between
      // two cars). Whoever is behind yields — lift and brake to drop in behind instead of forcing the gap.
      var corrLoTrk = Math.max(rawLo, -usableHalf(idx, -1) - 0.6), corrHiTrk = Math.min(rawHi, usableHalf(idx, 1) + 0.6);
      if (corrLoTrk > corrHiTrk) {
        var by1 = rawLo > -usableHalf(idx, -1) - 0.6 ? corrLoBy : null, by2 = rawHi < usableHalf(idx, 1) + 0.6 ? corrHiBy : null;
        var nose = Math.max(by1 ? by1.ds : -99, by2 ? by2.ds : -99);
        if (nose > -1.0) {
          avoidBrake = Math.max(avoidBrake, clamp(0.35 + (corrLoTrk - corrHiTrk) * 0.3 + nose * 0.08, 0.35, 1));
          avoidRef = Math.min(avoidRef, Math.min(by1 ? by1.speed : Infinity, by2 ? by2.speed : Infinity));
        }
      }
      if (behind && behind.speed > vAbs + 0.5 && behind.ds > -15) pressure = clamp(1 + behind.ds / 15, 0, 1);

      /* ------------------------------------------------ tactics: overtake / follow / defend */
      var lineNow = A.lineOff[idx];
      var tacticalCap = Infinity;
      S.tacT += dt;
      S.defendCooldown = Math.max(0, S.defendCooldown - dt);
      var targetLat = null, tacWeightTarget = 0, obstacleCrawl = 0;
      var myTargetHere = profile[idx] * speedScale;

      S.tacTarget = ahead ? ahead.key : null;
      if (ahead && !recovering) {
        var gap = ahead.ds - halfCarL - ahead.oL;
        var closing = vAbs - ahead.speed;
        var faster = closing > 0.4 || myTargetHere > ahead.speed * 1.03;
        var attackRange = 18 + vAbs * 0.7 + aggression * 10;
        // A (nearly) stationary car ahead — stalled on the grid, spun, beached — is an obstacle, not a rival:
        // every driver goes round it, braking or not, however timid.
        var obstacle = ahead.speed < 3 && gap < 30 && !finished;
        var willing = aggression * pers.overtake > 0.12 || closing > 3 || obstacle;
        // A new move is only started off the brakes and outside tight corners: a lane change while braking
        // at the limit is how the AI used to put itself in the gravel. A committed move carries on.
        var canStartMove = S.tacMode === 'overtake' || (S.brake < 0.4 && Math.abs(A.lineK[idx]) < 0.008) || closing > 8 || obstacle;
        if (faster && willing && gap < attackRange && canStartMove) {
          // choose a side
          var cornerDir = cornerDirAhead(idx, 10, 140);
          var left = ahead.lat + (ahead.oW + halfCarW + 0.9), right = ahead.lat - (ahead.oW + halfCarW + 0.9);
          var jIdx = idxAhead(idx, Math.min(gap, 40));
          var limL = usableHalf(jIdx, 1), limR = usableHalf(jIdx, -1);
          var spaceL = limL - left, spaceR = right + limR;   // >0 means room
          // A third car in (or rejoining into) the lane we would use closes that door: never pick a side that
          // drives into someone else to pass the car ahead.
          for (var nb = 0; nb < nearby.length; nb++) {
            var nbi = nearby[nb];
            if (nbi === ahead || nbi.ds < -(halfCarL + nbi.oL + 2) || nbi.ds > ahead.ds + 20) continue;
            var laneL = (left + Math.min(left + 2 * halfCarW, limL + halfCarW)) / 2, laneR = (right + Math.max(right - 2 * halfCarW, -limR - halfCarW)) / 2;
            var clr = halfCarW + nbi.oW + 0.8;
            if (Math.abs(nbi.lat - laneL) < clr + halfCarW || (nbi.lat > ahead.lat && nbi.lat < laneL + clr)) spaceL -= 4;
            if (Math.abs(nbi.lat - laneR) < clr + halfCarW || (nbi.lat < ahead.lat && nbi.lat > laneR - clr)) spaceR -= 4;
          }
          var scoreL = spaceL + (cornerDir > 0.15 ? 1.2 : 0) + (S.tacSide > 0 ? 1.0 : 0) + (lat > ahead.lat ? 0.6 : 0);
          var scoreR = spaceR + (cornerDir < -0.15 ? 1.2 : 0) + (S.tacSide < 0 ? 1.0 : 0) + (lat < ahead.lat ? 0.6 : 0);
          var side = 0;
          if (S.tacMode === 'overtake' && S.tacT < 1.6 && S.tacSide) side = S.tacSide;   // commitment / hysteresis
          else if (spaceL > 0 || spaceR > 0) side = scoreL >= scoreR ? (spaceL > 0 ? 1 : -1) : (spaceR > 0 ? -1 : 1);
          var sideRoom = side > 0 ? spaceL : side < 0 ? spaceR : -1;
          if (side !== 0 && sideRoom > -0.3) {
            if (S.tacMode !== 'overtake' || S.tacSide !== side) { S.tacT = 0; }
            S.tacMode = 'overtake'; S.tacSide = side;
            // Going round an obstacle that we are still behind (no overlap yet): its side latch came from the
            // raw lateral offset and may pin us to the narrow side — re-latch it to match the side we pass on.
            if (obstacle && S.sideLatch[ahead.key] && ahead.ds > halfCarL + ahead.oL - 0.3) S.sideLatch[ahead.key].side = -side;
            targetLat = side > 0 ? Math.min(left, limL) : Math.max(right, -limR);
            tacWeightTarget = smoothstep(attackRange, attackRange * 0.35, gap) * 0.95 + 0.05;
            // slipstream bonus on straights
            if (Math.abs(A.lineK[idx]) < 0.004 && gap < 25) speedScale *= 1.012;
          } else {
            S.tacMode = 'follow'; S.tacSide = 0;
          }
        } else if (gap < 50) {
          S.tacMode = 'follow';
        }
        if (S.tacMode === 'follow' || (S.tacMode === 'overtake' && Math.abs(lat - ahead.lat) < laneHalf * 0.9)) {
          // keep a time gap when stuck behind (less for aggressive drivers)
          var desiredGap = 2.5 + vAbs * lerp(0.42, 0.16, aggression);
          // the leader's speed a moment from now (only braking is anticipated)
          var vaEff = Math.max(0, ahead.speed + Math.min(0, ahead.acc || 0) * 0.45);
          tacticalCap = vaEff + (gap - desiredGap) * 0.6;
          // and never close faster than we could still brake down to the leader's speed within the gap
          var aFollow = brakeAccel(L, vAbs, gripScale) * brakeUse * 0.6;
          tacticalCap = Math.min(tacticalCap, Math.sqrt(vaEff * vaEff + 2 * aFollow * Math.max(0, gap - desiredGap * 0.45)));
          if (S.tacMode === 'overtake') tacticalCap += 2.5 * aggression;
          tacticalCap = Math.max(tacticalCap, Math.min(ahead.speed * 0.9, myTargetHere));
          if (gap < 1.0) tacticalCap = Math.min(tacticalCap, ahead.speed * 0.92);
          // pulling out from behind an obstacle: creep forward so the steering can carry the car sideways
          // (a stopped car cannot change lanes), slower the closer the bumper
          if (obstacle && S.tacMode === 'overtake') {
            tacticalCap = Math.max(tacticalCap, clamp((gap - 0.8) * 1.5, 0, 8));
            obstacleCrawl = clamp((gap - 1.0) * 0.8, 0, 3);
            // already half beside it (nose overlapping only a corner): turning out and edging forward clears it
            if (obstacleCrawl < 2 && Math.abs(ahead.dl) > halfCarW * 0.75) obstacleCrawl = 2;
          }
        }
      } else if (S.tacMode === 'overtake' || S.tacMode === 'follow') {
        S.tacMode = 'line'; S.tacSide = 0;
      }

      // Defend: one decisive move toward the inside of the next corner when attacked.
      if (!targetLat && behind && !recovering && behind.ds > -18 && behind.speed > vAbs - 0.5 && S.defendCooldown <= 0 &&
          aggression * pers.defend > 0.18 && !finished) {
        if (S.tacMode !== 'defend') {
          var cd = cornerDirAhead(idx, 20, 160);
          var defSide = Math.abs(cd) > 0.2 ? sign(cd) : sign(behind.lat - lat || 1);
          S.tacMode = 'defend'; S.tacT = 0; S.tacSide = defSide;
        }
        // Racing etiquette: one move only, and never into a car that already has a wheel alongside.
        var overlapped = behind.ds > -(halfCarL + behind.oL + 0.8);
        var attackerOnSide = sign(behind.lat - lat) === S.tacSide && Math.abs(behind.lat - lat) > 0.8;
        // ...nor across the nose of an attacker who is about to arrive: if the closing car will be alongside
        // within ~1.6 s, the door is already shut — moving now only closes it on top of him.
        var closingB = behind.speed - vAbs;
        var tArrive = closingB > 0.3 ? Math.max(0, -behind.ds - halfCarL - behind.oL) / closingB : Infinity;
        if (tArrive < 1.6) overlapped = true;
        if (overlapped && attackerOnSide) { S.tacMode = 'line'; S.tacT = 3.1; S.defendCooldown = rng.range(3, 6); }
        else if (S.tacT < 3.0) {
          var limD = usableHalf(idx, S.tacSide);
          targetLat = S.tacSide * Math.min(limD, Math.max(Math.abs(lineNow), limD * lerp(0.35, 0.7, aggression)));
          tacWeightTarget = 0.7;
        } else { S.tacMode = 'line'; S.defendCooldown = rng.range(4, 8); }
      } else if (S.tacMode === 'defend' && (!behind || behind.ds < -22)) {
        S.tacMode = 'line'; S.defendCooldown = rng.range(3, 6);
      }

      // Launch: hold the grid lane for the first seconds (everyone diving for the racing line at once is a
      // pile-up), then blend onto the line.
      var sinceStart = S.t - S.lightsOutAt;
      if (S.launchLat != null && sinceStart < 4.5 && !recovering && S.tacMode !== 'overtake') {
        targetLat = S.launchLat;
        tacWeightTarget = Math.max(tacWeightTarget, 1 - smoothstep(2.5, 4.5, sinceStart));
        if (sinceStart < 0.1) S.tacW = 1;
      }
      if (targetLat !== null) S.tacLat = targetLat;
      S.tacW = approach(S.tacW, tacWeightTarget, dt * (tacWeightTarget > S.tacW ? 1.6 : 0.7));

      // Side-by-side: hold lateral separation (no squeezing into another car).
      for (var sb = 0; sb < sideBySide.length; sb++) {
        var sbi = sideBySide[sb];
        var need = halfCarW + sbi.oW + 0.5 - Math.abs(sbi.dl);
        if (need > 0) avoidPush += (sbi.side ? -sbi.side : (sbi.dl > 0 ? -1 : 1)) * need * 0.8;
      }
      avoidPush = clamp(avoidPush, -3.5, 3.5);

      /* ------------------------------------------------ lateral target & steering (pure pursuit) */
      var Ld = clamp(lerp(5.5, 4.5, skill) + vAbs * lerp(0.62, 0.5, skill), 6, 48);
      if (recovering) Ld = clamp(Ld * 1.4, 10, 40);
      var jt = idxAhead(idx, Ld);
      var lineAt = A.lineOff[jt];
      // Tactical deviation from the racing line (overtake lane / defence / avoidance / mistakes). Only the
      // deviation is slew-limited, so the racing line itself is followed exactly through fast direction changes.
      var dev = S.tacW * (S.tacLat - lineAt);

      // mistakes that alter the line
      var outside = -sign(A.lineK[jt] || A.lineK[idx]);
      if (mistakeIs('runWide')) dev += outside * S.mistake.mag * 2.2 * smoothstep(0, 0.4, S.mistake.t);
      if (mistakeIs('missedApex')) dev += outside * S.mistake.mag * 1.3;

      var limLeft = usableHalf(jt, 1), limRight = usableHalf(jt, -1);
      if (S.dev == null) S.dev = 0;
      // Second-order lane slew: the deviation has its own lateral velocity with an acceleration limit, so lane
      // changes are smooth S-curves the car can actually follow (a rate-limited step asks for an instant
      // heading change at both ends — at speed that saturates the tyres and the car overshoots the lane).
      if (S.devV == null) S.devV = 0;
      var urgentAvoid = smoothstep(0.4, 2.0, Math.abs(avoidPush));
      var devVMax = Math.min(lerp(2.5, 4.0, aggression) + vAbs * 0.02, 1.0 + vAbs * 0.06) + urgentAvoid * 2.5;
      // The lateral acceleration a lane change may use is whatever the corner leaves spare: mid-corner at the
      // limit there is almost none, so lane changes there become slow drifts (or wait for the exit).
      var aLatHere = latAccel(L, vAbs, gripScale);
      var kLineNear = Math.max(Math.abs(A.lineK[idx]), Math.abs(A.lineK[jt]));
      // ... and under braking the friction circle is mostly spent longitudinally (a lane change while braking
      // hard from high speed is how the rear steps out)
      var brkFracNow = clamp(S.brake * 0.95, 0, 0.95);
      var aSpare = Math.max(0, aLatHere * 0.95 * Math.sqrt(1 - brkFracNow * brkFracNow) - vAbs * vAbs * kLineNear);
      var devAMax = clamp(Math.min(aLatHere * lerp(0.22, 0.32, aggression), aSpare * 0.55), 0.25, 4.5) * (1 + urgentAvoid);
      devVMax = Math.min(devVMax, 0.6 + Math.sqrt(aSpare) * 1.6 + urgentAvoid * 2.5);
      // Drifting back to the racing line has no urgency: mid-corner, do it gently (the line itself is already
      // moving across the track there, and the stop at the end of a fast lateral move costs grip we lack).
      if (tacWeightTarget < 0.05 && urgentAvoid < 0.05) {
        var calm = smoothstep(0.001, 0.0045, kLineNear);
        devVMax *= 1 - 0.5 * calm; devAMax *= 1 - 0.35 * calm;
      }
      var devErr = clamp(dev, -2 * A.hw[jt], 2 * A.hw[jt]) - S.dev;
      var devVDes = sign(devErr) * Math.min(devVMax, Math.sqrt(2 * devAMax * Math.abs(devErr)) * 0.92, Math.abs(devErr) * 6);
      S.devV = approach(S.devV, devVDes, devAMax * dt);
      S.dev += S.devV * dt;
      // Collision avoidance rides on top with its own, much faster first-order response (it must not wait for
      // a smooth S-curve when a car is moving into us).
      if (S.avoidF == null) { S.avoidF = 0; S.avoidV = 0; }
      // fast to react, slow to let go (a released push must not fling the car back across the track)
      var growing = Math.abs(avoidPush) > Math.abs(S.avoidF) || sign(avoidPush) !== sign(S.avoidF);
      var avRate = growing ? 2.5 + vAbs * 0.05 + urgentAvoid * 3 : 0.8 + vAbs * 0.015;
      var avPrev = S.avoidF;
      S.avoidF = approach(S.avoidF, avoidPush, avRate * dt);
      S.avoidV = (S.avoidF - avPrev) / dt;
      // corridor bounds (track edges first, then the cars alongside; if they conflict, stay where we are
      // laterally — the squeeze brake above is what resolves it)
      function corrClamp(v, i) {
        var lo = Math.max(-usableHalf(i, -1), corrLo), hi = Math.min(usableHalf(i, 1), corrHi);
        if (lo > hi) { lo = Math.max(-usableHalf(i, -1), Math.min(corrLo, lat)); hi = Math.min(usableHalf(i, 1), Math.max(corrHi, lat)); if (lo > hi) return clamp(lat, -usableHalf(i, -1), usableHalf(i, 1)); }
        return clamp(v, lo, hi);
      }
      var hasCorr = corrLo > -Infinity || corrHi < Infinity;
      if (hasCorr && !recovering) {
        // anti-windup: the lane deviation itself lives inside the corridor, so the car does not snap back
        // across the track the moment the neighbour drops away
        var devC = corrClamp(A.lineOff[idx] + S.dev + S.avoidF, idx) - A.lineOff[idx] - S.avoidF;
        if (devC !== S.dev) { if (sign(S.devV) === sign(S.dev - devC)) S.devV = 0; S.dev = devC; }
      }
      var devTot = S.dev + S.avoidF;
      if (recovering) {
        // rejoin gently toward the inner part of the track (absolute target, pursuit steering)
        S.latTarget = approach(S.latTarget === null ? lat : S.latTarget, clamp(lat * 0.35, -A.hw[jt] * 0.5, A.hw[jt] * 0.5), 6 * dt);
        if (hasCorr) S.latTarget = corrClamp(S.latTarget, jt);
        S.dev = S.latTarget - lineAt; S.avoidF = 0; devTot = S.dev;
      } else {
        S.latTarget = clamp(lineAt + devTot, -limRight, limLeft);
        if (hasCorr) S.latTarget = corrClamp(S.latTarget, jt);
      }

      var tgx = A.xs[jt] - Math.sin(A.hs[jt]) * S.latTarget, tgy = A.ys[jt] + Math.cos(A.hs[jt]) * S.latTarget;
      // Steer along the course (velocity direction), not the nose: at speed the car carries a natural sideslip
      // and a heading-based controller would read it as "already pointing in" and run wide.
      var course = vLong > 3 ? heading + Math.atan2(vLat, vLong) : heading;
      var dxl = tgx - x, dyl = tgy - y, chh = Math.cos(course), shh = Math.sin(course);
      var lx = dxl * chh + dyl * shh, ly = -dxl * shh + dyl * chh;
      var ld2 = Math.max(1, lx * lx + ly * ly);
      var kappa = 2 * ly / ld2;   // pure-pursuit curvature
      if (vLong < -0.5) kappa = -kappa;

      // Path tracker: curvature feed-forward (previewed by the steering lag) + 2nd-order lateral/heading feedback.
      // Pure pursuit alone cuts apexes at curvature transitions; the tracker does not, but it is fragile far
      // from the line — so blend: tracker when close & aligned, pursuit when recovering or far off.
      var kFF = A.lineK[idxAhead(idx, Math.max(2, vAbs * lerp(0.26, 0.18, skill)))];
      var latRef = hasCorr ? corrClamp(A.lineOff[idx] + devTot, idx) : clamp(A.lineOff[idx] + devTot, -usableHalf(idx, -1), usableHalf(idx, 1));
      S.refPrev = latRef;
      var eLat = lat - latRef;                                     // + = we are left of where we want to be
      // Reference heading from the actual (clamped) reference path a few metres ahead: the racing line's own
      // slope, the deviation's rate (lane changes lead instead of lag) and the track-edge clamp all included —
      // when an overtaking lane is pinned against the edge, the reference runs parallel to the edge, not to
      // wherever the unclamped racing line happens to be heading.
      var vFb = Math.max(6, vAbs);
      if (recovering) { S.devV = 0; S.avoidV = 0; }
      var kq = Math.max(1, Math.round(3 / Math.max(0.5, A.ds))), iq = (idx + kq) % A.n, dsq = kq * A.ds;
      var devAhead = devTot + clamp((S.devV + 0.5 * S.avoidV) / vFb, -0.15, 0.15) * dsq;
      var latRefQ = hasCorr ? corrClamp(A.lineOff[iq] + devAhead, iq) : clamp(A.lineOff[iq] + devAhead, -usableHalf(iq, -1), usableHalf(iq, 1));
      // Bound preview: a reference sweeping across the track toward a hard bound (track edge, or the corridor
      // left by a car alongside) goes flat the instant it reaches the clamp — at speed the car cannot stop its
      // sideways motion that abruptly and overshoots into the bound. Ease the reference's lateral rate so the
      // remaining distance to the bound is enough to stop at a comfortable lateral deceleration.
      // (the racing line itself is planned smooth and edge-to-edge on purpose: only deviations are governed)
      if (!recovering && vAbs > 8 && (hasCorr || Math.abs(devTot) > 0.5)) {
        var refRate = (latRefQ - latRef) / dsq * vFb;
        var aStop = clamp(aSpare * 0.6 + 1.2, 1.2, 4);
        if (refRate > 0.3) {
          var hiB = Math.min(usableHalf(idx, 1), hasCorr ? corrHi : Infinity);
          var vMaxR = Math.sqrt(2 * aStop * Math.max(0, hiB - Math.max(lat, latRef)));
          if (refRate > vMaxR) latRefQ = latRef + Math.max(0, vMaxR) * dsq / vFb;
        } else if (refRate < -0.3) {
          var loB = Math.max(-usableHalf(idx, -1), hasCorr ? corrLo : -Infinity);
          var vMaxL = Math.sqrt(2 * aStop * Math.max(0, Math.min(lat, latRef) - loB));
          if (-refRate > vMaxL) latRefQ = latRef - Math.max(0, vMaxL) * dsq / vFb;
        }
      }
      var hMid = A.hs[idx] + 0.5 * wrapAngle(A.hs[iq] - A.hs[idx]);
      var kc = num(A.ck[idx]) ? A.ck[idx] : wrapAngle(A.hs[iq] - A.hs[idx]) / dsq;
      var refH = hMid + Math.atan2(latRefQ - latRef, dsq * Math.max(0.3, 1 - kc * latRef));
      var psiE = wrapAngle(course - refH);                         // + = moving left of the reference path
      // Bandwidth is scheduled down with speed: the car's yaw response lags more (and every rad/s of yaw
      // correction costs v·r of lateral grip), so at 200 km/h a 2 rad/s loop slaloms down the straight.
      var omega = lerp(1.5, 2.3, skill) * clamp(28 / vFb, 0.55, 1), zeta = 0.9 + 0.45 * smoothstep(32, 55, vFb);
      // Cascaded tracker: the lateral error asks for a closing heading, saturated so the car never approaches
      // the reference faster than ~3.5 m/s sideways (a linear 2nd-order law winds up against the friction
      // limit on big errors and turns into a lane-wide slalom). Small errors: identical to the linear law.
      var psiMax = clamp(3.5 / vFb, 0.05, 0.35);
      var psiDes = -psiMax * Math.tanh((omega * eLat) / (2 * zeta * vFb * psiMax));
      var kTrack = kFF - (2 * zeta * omega * (Math.sin(psiE) - Math.sin(psiDes))) / vFb;
      kTrack = clamp(kTrack, kFF - 0.25, kFF + 0.25);
      var wPP = Math.max(0.05, smoothstep(4, 8, Math.abs(eLat)), smoothstep(0.5, 0.9, Math.abs(psiE)), recovering || vLong < 1 ? 1 : 0);
      if (vLong >= -0.5) kappa = lerp(kTrack, kappa, wPP);
      // friction-circle steering limit: never ask for more lateral g than the tyres have left after braking
      var kMax = Infinity;
      if (vAbs > 8 && !recovering) {
        // The speed profile only plans for `latUse` of the grip, so steering may use the full circle (and a
        // floor above the line curvature) — that reserve is what lets the driver correct line errors mid-corner.
        var brakeShare = clamp(S.brake * 0.85, 0, 0.9);
        kMax = latAccel(L, vAbs, gripScale) * 1.02 * Math.sqrt(Math.max(0.12, 1 - brakeShare * brakeShare)) / (vAbs * vAbs);
        var kLineMax = Math.max(Math.abs(kFF), Math.abs(A.lineK[idx]), Math.abs(A.lineK[jt]));
        kMax = Math.max(kMax, kLineMax * 1.25 + 0.0015);
        if (Math.abs(avoidPush) > 0.5) kMax *= 1.15;   // emergency avoidance may use the full circle
        // The grip estimate is only an estimate: while the tyres report plenty of slip reserve (previous frame's
        // saturation), let the tracker ask for more — running wide with the tyres at half their peak slip is
        // the estimate being wrong, not the car being at the limit.
        if (num(S.tyreSat) && S.tyreSat > 0.05) kMax *= 1 + 0.6 * (1 - smoothstep(0.5, 0.85, S.tyreSat));
        kappa = clamp(kappa, -kMax, kMax);
      }

      var delta = Math.atan(kappa * L.wheelbase) / yawGainAt(L, vAbs);
      // yaw-rate feedback (damps oscillation, catches oversteer early). Gain is normalised by the car's
      // yaw-rate-per-steer (≈ v / wheelbase) so it behaves the same at 50 and 250 km/h.
      var yawExcess = 0;
      if (num(vs.yawRate) && vAbs > 4) {
        var rDes = vAbs * kappa;
        var yawErr = rDes - vs.yawRate;
        // >0: rotating more than wanted in the wanted direction (oversteer); <0: rotating less (understeer)
        var rA = Math.abs(vs.yawRate), rD = Math.abs(rDes);
        yawExcess = (sign(vs.yawRate) === sign(rDes) || rD < 0.02) ? rA - rD : -rD;
        // authority grows while the rear is stepping out (previous frame's evidence): a weak, rate-limited
        // trim cannot hold a rear-engined car that has started to rotate at 200 km/h
        var fbLim = clamp(0.5 * L.wheelbase / vAbs, 0.02, 0.12) * (1 + 1 * (S.oversteer || 0));
        // low-passed (~0.1 s): stable even against plants whose yaw responds instantly to steering
        var fbT = clamp(yawErr * lerp(0.9, 1.6, skill) * L.wheelbase / vAbs, -fbLim, fbLim);
        S.yawFb = (S.yawFb || 0) + (fbT - (S.yawFb || 0)) * clamp(dt / 0.1, 0, 1);
        delta += S.yawFb;
        // Integral trim against *excess* rotation only (car yawing more than asked, or the wrong way): a
        // high-speed slow oversteer drift — aero balance shifted forward, both axles near the limit — needs
        // more opposite steering than the kinematic map predicts, and a proportional term alone settles with a
        // standing yaw error while the car slides across the track. Never integrates toward more lock
        // (understeer), so it cannot wind up in corners taken at the limit.
        var excessRot = (yawErr < 0 && vs.yawRate > rDes && vs.yawRate > 0) || (yawErr > 0 && vs.yawRate < rDes && vs.yawRate < 0);
        var hiV = smoothstep(18, 40, vAbs);
        if (excessRot && Math.abs(yawErr) > 0.03 && hiV > 0 && !recovering) {
          S.yawI = clamp((S.yawI || 0) + yawErr * dt * 0.35 * hiV, -0.06, 0.06);
        } else S.yawI = (S.yawI || 0) * (1 - clamp(dt * 1.5, 0, 1));
        delta += S.yawI;
      } else { S.yawFb = 0; S.yawI = 0; }
      if (isFinite(kMax)) { var dMax = Math.atan(kMax * L.wheelbase) * 1.5 / yawGainAt(L, vAbs) + 0.004; delta = clamp(delta, -dMax, dMax); }
      // counter-steer into slides: steer toward the velocity vector (opposite lock)
      var beta = vAbs > 4 ? Math.atan2(vLat, Math.max(1, Math.abs(vLong))) : 0;
      // Steady-state cornering carries a natural sideslip (the rear tyres run a slip angle), so only the
      // excess beyond what the current lateral load explains is a slide worth catching.
      // Lateral load from the measured lateral acceleration when the vehicle reports it: yaw rate x speed
      // overstates it exactly when the car over-rotates, which used to widen the dead band and mask the slide.
      var ayMeas = num(vs.gLat) && (vs.gLat !== 0 || !num(vs.yawRate)) ? vs.gLat * G : num(vs.ay) && vs.ay !== 0 ? vs.ay : NaN;
      var latLoad = num(ayMeas) ? clamp(Math.abs(ayMeas) / Math.max(0.5, latAccel(L, vAbs, gripScale)), 0, 1.2)
        : num(vs.yawRate) ? clamp(Math.abs(vs.yawRate * vAbs) / Math.max(0.5, latAccel(L, vAbs, gripScale)), 0, 1.2) : 0;
      var betaDead = 0.03 + L.alphaPk * 0.6 * Math.min(1, latLoad);
      if (Math.abs(beta) > betaDead) delta += (beta - sign(beta) * betaDead) * lerp(0.8, 1.5, skill);
      // oversteer detection: rear slip clearly exceeds front slip while rotating too fast
      var slipF = Math.abs(first(vs.slipAngleF, 0)), slipR = Math.abs(first(vs.slipAngleR, 0));
      // tyre saturation vs the vehicle's peak slip angles (both axles near peak = neutral 4-wheel slide)
      var satF = Math.abs(first(vs.slipAngleF, 0)) / L.alphaPkF, satR = Math.abs(first(vs.slipAngleR, 0)) / L.alphaPk;
      var tyreSat = vAbs > 12 && !recovering ? Math.max(satF, satR) : 0;
      if (tyreSat > 0.78) S.gripLearn = Math.max(0.75, S.gripLearn - dt * 0.06 * clamp((tyreSat - 0.78) / 0.12, 0, 3));
      else if (tyreSat > 0.25 && tyreSat < 0.6) S.gripLearn = Math.min(1, S.gripLearn + dt * 0.003);
      S.tyreSat = tyreSat;
      // Oversteer evidence must not depend on our own counter-steer (front slip drops the moment we catch,
      // which would read as "even more oversteer" and latch full opposite lock): rear saturation vs its peak,
      // yaw-rate excess and excess body slip only. Low-passed (~70 ms) so the catch is smooth, not bang-bang.
      var rearLead = slipR - slipF * 1.15;
      // Yaw excess alone is not evidence: when the tracker deliberately unwinds the command (converging onto
      // the line) the car is still rotating at the corner's natural rate. Require the rear to be working hard.
      var rearWork = smoothstep(0.55, 0.85, satR) * (rearLead > -0.01 ? 1 : 0.5);
      // Axle balance (ESC-style): the rear running clearly further up its slip curve than the front while it
      // is past the knee (the tyre curve is flat beyond ~half the peak slip: 90 % of the force is already
      // there) is limit oversteer in the making — even before any yaw error shows. Rotation building: the
      // body slip growing nose-in (rear stepping out) faster than the lateral load explains.
      var balEv = smoothstep(0.45, 0.75, satR) * clamp((satR - satF - 0.1) * 4, 0, 1);
      if (S.prevBeta == null) S.prevBeta = beta;
      var betaDot = (beta - S.prevBeta) / dt;
      S.prevBeta = beta;
      S.betaDot = (S.betaDot || 0) + (clamp(betaDot, -3, 3) - (S.betaDot || 0)) * clamp(dt / 0.08, 0, 1);
      var noseIn = num(vs.yawRate) && beta * vs.yawRate < 0 && Math.abs(beta) > 0.02;
      var rotEv = noseIn && sign(S.betaDot) === sign(beta) ? clamp((Math.abs(S.betaDot) - 0.06) * 3, 0, 1) * smoothstep(0.4, 0.7, satR) : 0;
      var ovRaw = clamp(Math.max((satR - 0.9) * 5 * (rearLead > 0 ? 1 : 0.4), (yawExcess - 0.05) * 4 * rearWork,
        (Math.abs(beta) - betaDead - 0.03) * 5, balEv * 0.7, rotEv), 0, 1);
      S.rearLed = vAbs > 10 && !recovering ? Math.max(balEv, rotEv) : 0;
      S.ovRaw = S.ovRaw == null ? 0 : S.ovRaw + (ovRaw - S.ovRaw) * clamp(dt / 0.07, 0, 1);
      S.oversteer = vAbs > 8 ? S.ovRaw : 0;
      // Catch the slide: steer the front wheels toward the front axle's velocity direction so the fronts stop
      // adding yaw (opposite lock), weighted by how sure we are that the rear has let go.
      if (S.oversteer > 0.05 && num(vs.yawRate) && vLong > 8) {
        var phiF = Math.atan2(vLat + L.aFront * vs.yawRate, vLong);
        // keep the fronts loaded toward the corner (they still have to hold the line); only a full slide gets
        // the wheels pointed straight down the front-axle velocity vector
        var catchW = clamp(S.oversteer * lerp(0.55, 0.85, skill), 0, 0.85) * (1 - 0.45 * smoothstep(30, 55, vAbs));
        delta = lerp(delta, phiF + sign(kappa || vs.yawRate) * L.alphaPkF * 0.55 * (1 - S.oversteer), catchW);
      }

      // learn the effective steer ratio per speed band (vehicles use speed-sensitive steering, so the lock
      // per unit of input shrinks with speed). Compare the wheel angle against the command it is settling to.
      var band = clamp(Math.floor(vAbs / 5), 0, 30);
      if (!S.ratioBands) S.ratioBands = [];
      if (num(vs.steerAngle) && Math.abs(S.steer) > 0.012 && Math.abs(S.steer - (S.prevSteerCmd || 0)) < 0.004) {
        var est = vs.steerAngle / S.steer;
        if (est > 0.02 && est < 1.6) {
          var cur = S.ratioBands[band] || S.steerRatio;
          S.ratioBands[band] = lerp(cur, est, clamp(dt * 4, 0, 1));
          S.steerRatio = lerp(S.steerRatio, est, clamp(dt * 3, 0, 1));
        }
      }
      S.prevSteerCmd = S.steer;
      var ratioNow = S.ratioBands[band] || (S.ratioBands[band - 1] || S.ratioBands[band + 1]) || S.steerRatio;
      var steerCmd = arcadeK ? clamp(Math.tan(clamp(delta, -1.2, 1.2)) / L.wheelbase / Math.max(1e-4, arcadeK(Math.abs(vLong), gripScale)), -1, 1)
        : clamp(delta / Math.max(0.03, ratioNow), -1, 1);
      input.steer = steerCmd;

      /* ------------------------------------------------ speed target with brake-point anticipation */
      var aBrakeNow = brakeAccel(L, vAbs, gripScale) * brakeUse;
      if (mistakeIs('lateBrake')) aBrakeNow *= 1 + 0.32 * S.mistake.mag;
      var horizon = clamp(vAbs * vAbs / (2 * Math.max(2, aBrakeNow * 0.8)) + 25, 30, 450);
      var vAllowed = Infinity, ffDecel = 0, j = idx, distAcc = 0, guard = A.n;
      var devPlan = !recovering && Math.abs(devTot) > 0.5;
      var step = Math.max(1, Math.round(2 / Math.max(0.5, A.ds)));
      while (distAcc < horizon && guard > 0) {
        var vt = profile[j] * speedScale * (mistakeIs('runWide') ? 1.04 : 1) * (mistakeIs('missedApex') ? 0.97 : 1);
        if (devPlan) {
          // Off the racing line (overtaking lane, defending, alongside someone): the planned profile assumes the
          // line's radius, but the inside lane of a hairpin is much tighter. Cap by the curvature of a path at
          // the current offset from the centreline.
          var kcj = A.ck[j];
          if (num(kcj) && kcj !== 0) {
            var latP = clamp(A.lineOff[j] + devTot, -A.hw[j], A.hw[j]);
            var kOff = Math.abs(kcj / Math.max(0.25, 1 - kcj * latP)), kLn = Math.abs(A.lineK[j]);
            if (kOff > kLn * 1.04 + 0.0005) {
              var vOff = Math.sqrt(latAccel(L, vt, gripScale) * latUse * highSpeedMargin(vt, L) / kOff);
              vOff = Math.sqrt(latAccel(L, vOff, gripScale) * latUse * highSpeedMargin(vOff, L) / kOff);
              // fade in with the deviation (a few decimetres off line is within the profile's margin)
              var wDev = smoothstep(0.5, 1.6, Math.abs(latP - A.lineOff[j]));
              if (vOff < vt) vt = lerp(vt, vOff, wDev);
            }
          }
        }
        var va = Math.sqrt(vt * vt + 2 * aBrakeNow * Math.max(0, distAcc - 1.0));
        if (va < vAllowed) {
          vAllowed = va;
          if (vAbs > vt && distAcc > 0.5) ffDecel = Math.max(ffDecel, (vAbs * vAbs - vt * vt) / (2 * distAcc));
        }
        for (var st = 0; st < step; st++) { distAcc += A.lineSeg[j]; j = (j + 1) % A.n; }
        guard -= step;
      }
      var vCmd = Math.min(vAllowed, tacticalCap);
      if (recovering) vCmd = Math.min(vCmd, surface === 'sand' ? 9 : 14 + skill * 6);
      if (S.mode === 'rejoin') {
        vCmd = Math.min(vCmd, 22 + S.modeT * 12);
        // traffic check: if a car is coming from behind near our line, wait
        // (only while still off the asphalt: standing on the brakes on the racing surface in front of a faster
        // car is the worst thing to do — once back on, hold the lane and the pace instead)
        if (behind && behind.ds > -35 && behind.speed > vAbs + 3 && Math.abs(behind.lat - lat) < laneHalf + 1 &&
            Math.abs(lat) > A.hw[idx] - halfCarW) vCmd = Math.min(vCmd, Math.max(10, Math.min(vAbs, behind.speed) - 4));
      }
      // Running wide: lift (and eventually brake) in proportion to how far we drift to the outside of the
      // corner beyond the intended line, harder as the outside edge approaches.
      var wideAmt = 0, limCut = Infinity;
      if (!recovering && vAbs > 6) {
        var kHere = A.lineK[idx], outSign = -sign(kHere);
        if (Math.abs(kHere) > 0.0015) {
          var outward = (lat - latRef) * outSign;
          var edgeRoom = (outSign > 0 ? A.hw[idx] - lat : A.hw[idx] + lat) - halfCarW;   // room to the outside edge
          var wide = Math.max(0, outward - 0.5) * 0.9 + (outward > 0.2 ? Math.max(0, 0.6 - edgeRoom) * 2.5 : 0);
          // relative to the current speed (so it bites immediately) but floored against the plan: running
          // a little wide is cured by lifting, not by parking the car mid-corner
          if (wide > 0) {
            var vWide = Math.max(vAbs - wide * lerp(1.2, 2.2, skill), myTargetHere * lerp(0.62, 0.72, skill));
            vCmd = Math.min(vCmd, vWide); limCut = Math.min(limCut, vWide);
          }
          S.dbg.wide = wide; wideAmt = wide;
        }
      }
      if (S.tyreSat > 0.72) limCut = Math.min(limCut, vAbs - (S.tyreSat - 0.72) * lerp(6, 10, skill));   // at the limit: ease off
      // rear stepping out: plan a gentle speed reduction (the pedal logic below makes it a lift, not a stab)
      if (S.rearLed > 0.1) limCut = Math.min(limCut, vAbs - S.rearLed * 3);
      // Limit cuts (running wide, tyres saturated, rear stepping out) release progressively: snapping the target
      // back to the plan the instant the symptom clears means a stab of full throttle on a car that is still
      // loaded up and carrying a set — power understeer or a snap the other way.
      var riseA = 2.5;
      if (limCut < Infinity && !recovering) S.limCap = Math.min(limCut, S.limCap != null && S.limCap < Infinity ? Math.max(S.limCap, limCut) : limCut);
      else if (S.limCap != null && S.limCap < Infinity) {
        // release rate: slow while the car is still loaded up, quick once the lateral load has gone
        var ayNowF = num(ayMeas) ? Math.abs(ayMeas) / Math.max(0.5, latAccel(L, vAbs, gripScale)) : 0;
        var planF = vAbs * vAbs * kLineNear / Math.max(0.5, latAccel(L, vAbs, gripScale));
        var relaxed = Math.min(smoothstep(0.6, 0.3, ayNowF), smoothstep(0.5, 0.25, planF));
        S.limCap += (riseA + 30 * relaxed) * dt;
        if (S.limCap > vAbs + 6 || recovering) S.limCap = Infinity;
      }
      if (S.limCap != null && S.limCap < Infinity) vCmd = Math.min(vCmd, S.limCap);
      else if (limCut < Infinity) vCmd = Math.min(vCmd, limCut);
      // Yield to the car we are about to hit: shed speed relative to ours, but never below the speed of the
      // car being avoided (a cut relative to our own speed alone, held for a while, parks the car mid-corner).
      var avoidActive = avoidBrake > 0 && vAbs > avoidRef * 0.97 - 0.3;
      if (avoidActive) vCmd = Math.min(vCmd, Math.max(vAbs * (1 - 0.35 * avoidBrake), avoidRef * 0.97 - 0.3));
      // ...except that yielding to a car that is not moving at all is a deadlock (a stopped car cannot steer
      // round anything): while pulling out round an obstacle, crawl on with the wheels turned away.
      S.crawling = obstacleCrawl > 0;
      if (obstacleCrawl > 0 && vCmd < obstacleCrawl) { vCmd = Math.min(Math.max(vCmd, obstacleCrawl), myTargetHere); if (vAbs < obstacleCrawl) avoidActive = false; }
      if (finished && vAbs < 3 && S.modeT > 0) vCmd = Math.min(vCmd, 12);

      // ---- pedals
      var err = vCmd - vLong;
      var thr = 0, brk = 0;
      var hold = clamp(((L.dragK * vAbs * vAbs) / L.mass + L.rr * G) / Math.max(1, driveAccel(L, vAbs, 1) + (L.dragK * vAbs * vAbs) / L.mass + L.rr * G), 0, 1);
      if (err > 0) {
        thr = clamp(hold + err * lerp(0.35, 0.6, skill), 0, 1);
      } else {
        thr = clamp(hold + err * 0.8, 0, 1);
        var brakeErr = -err - 0.35;
        if (brakeErr > 0) brk = clamp(brakeErr * 0.32, 0, 1);
      }
      if (ffDecel > 0 && vAllowed < vLong + 0.5) {
        var aMaxB = brakeAccel(L, vAbs, gripScale);
        brk = Math.max(brk, clamp((ffDecel - (L.dragK * vAbs * vAbs) / L.mass) / Math.max(1, aMaxB), 0, 1));
        thr = 0;
      }
      if (brk > 0.02) thr = 0;

      // friction-circle aware corner exit: limit throttle while lateral demand is high
      var aLatDemand = vAbs * vAbs * Math.abs(kappa);
      var aLatAvail = latAccel(L, vAbs, gripScale);
      var latUseNow = aLatDemand / Math.max(0.5, aLatAvail);
      if (latUseNow > 0.65) thr *= clamp(1.55 - latUseNow, 0.25, 1);
      // ...and against the *measured* lateral load: the tracker's curvature can momentarily read low while the
      // car is still pulling 2 g, and flooring it there transfers load off the (light) front axle of a mid/
      // rear-engined car — power understeer, the car runs wide, the correction then over-rotates it.
      var latUseMeas = num(ayMeas) ? Math.abs(ayMeas) / Math.max(0.5, aLatAvail) : 0;
      if (latUseMeas > 0.7 && !recovering) thr = Math.min(thr, Math.max(hold, clamp(1.7 - latUseMeas, 0.3, 1)));
      // squeeze the throttle in progressively while the tyres are loaded (finish() slew)
      S.thrSqueeze = clamp(1.3 - latUseMeas, 0.25, 1);
      var overspeed = vLong - vAllowed;
      if (latUseNow > 0.75 && overspeed < 1.0) brk *= clamp(1.6 - latUseNow, 0.3, 1);   // trail-brake: release brake as steering loads up
      if (overspeed > 2.5) { brk = Math.max(brk, clamp(overspeed / 6, 0.5, 1)); thr = 0; }   // way too hot: stand on it
      // Friction circle on the brake pedal: use measured cornering load (yaw rate × speed) as well as the
      // commanded one, and leave the tyres enough for the lateral force they are already making.
      // Measured load: the vehicle's lateral acceleration when reported (yaw rate × speed overstates it while
      // the car is rotating into a corner or sliding). Demand: the *planned* line curvature — the tracker's
      // extra correction curvature is negotiable, and when we are too fast, shedding speed wins over it
      // (otherwise the brake is starved exactly when the car arrives hot, and it arrives even hotter).
      var aLatMeas = num(vs.gLat) && (vs.gLat !== 0 || !num(vs.yawRate)) ? Math.abs(vs.gLat) * G
        : num(vs.ay) && vs.ay !== 0 ? Math.abs(vs.ay) : num(vs.yawRate) ? Math.abs(vs.yawRate * vAbs) : 0;
      var aLatPlan = vAbs * vAbs * Math.abs(kappa) * (1 - 0.5 * smoothstep(0.5, 3, overspeed));
      var latFrac = clamp(Math.max(aLatMeas, aLatPlan) / Math.max(0.5, aLatAvail), 0, 1);
      var brkCircle = Math.sqrt(Math.max(0, 1 - latFrac * latFrac));
      var brkLimit = clamp(0.12 + brkCircle * 1.05, 0.12, 1);
      if (overspeed > 6) brkLimit = Math.max(brkLimit, 0.55);       // emergency: scrub speed regardless
      // Off the road and still fast: the friction-circle budget is meaningless on grass (the car is sliding
      // anyway) — get the speed off so it can turn back in, instead of skating ever wider on a trailing brake.
      // Running out of road on the exit side while too fast for the line we are on: a trailing 12 % brake
      // cannot shed the speed; load the fronts (they are the axle that is out of grip) with a firmer press.
      if (!recovering && wideAmt > 0.8 && vLong > vCmd + 1) brkLimit = Math.max(brkLimit, clamp(0.25 + wideAmt * 0.08, 0.25, 0.55));
      if (recovering && vLong > vCmd + 3) brkLimit = Math.max(brkLimit, clamp(0.4 + (vLong - vCmd) * 0.03, 0.4, 0.8));
      // understeer (rotating less than asked) and too fast: braking is the cure, the fronts need the load
      if (yawExcess < -0.04 && overspeed > 0.5 && S.oversteer < 0.2) brkLimit = Math.max(brkLimit, clamp(0.35 + overspeed * 0.12, 0.35, 0.85));
      brk = Math.min(brk, brkLimit);
      // Oversteer: release brakes (rear unloading) and come off the throttle (power oversteer).
      // Maintenance throttle while loaded up mid-corner: a full lift means engine braking on the driven
      // wheels (lift-off oversteer on RWD), so hold roughly the drag-neutral throttle unless far too fast.
      if (brk < 0.05 && latFrac > 0.45 && overspeed < 3 && vAbs > 12) thr = Math.max(thr, hold * smoothstep(0.45, 0.8, latFrac) * (L.driveFrac < 0.9 ? 1 : 0.6));
      // Rear-led at the limit (oversteer-limited car, rear past the knee): shed speed with a drag-neutral lift,
      // never with the brakes (they unload the very axle that is out of grip) unless far too fast; and
      // throttle-on-exit only up to what the rear's friction circle leaves after the lateral force it carries.
      if (S.rearLed > 0.05 && overspeed < 4) {
        brk *= 1 - clamp(S.rearLed * 1.5, 0, 0.9);
        if (brk < 0.05) thr = Math.max(thr, hold * 0.85 * clamp(S.rearLed * 2, 0, 1));
      }
      if (L.rearDrive > 0.3 && num(ayMeas) && vAbs > 6 && !recovering) {
        var ayR = rearLatAt(L, vAbs) * gripScale * (S.gripLearn || 1);
        if (isFinite(ayR) && ayR > 1) {
          var latFracR = clamp(Math.abs(ayMeas) / ayR, 0, 1);
          // Deliberately conservative: static rear share (no credit for the load the acceleration itself
          // transfers rearwards) and the planning mu. Crediting either was ~3 % faster solo but put 4x more cars
          // off in 6-car packs (exits taken at the rear's limit leave nothing for a car alongside).
          var rearShare = 1 - L.weightFront;
          var fxBudget = Math.sqrt(Math.max(0, 1 - latFracR * latFracR)) * L.mu * gripScale * G * rearShare;   // per kg
          var fFull = Math.max(0.5, Math.min(L.power / (L.mass * Math.max(vAbs, 5)), L.mu * gripScale * G * L.driveFrac * 1.2)) * L.rearDrive;
          // the oversteer-limited car keeps a bigger reserve on the axle that lets go first
          var margin = lerp(0.95, 0.8, oversteerFactor(L, vAbs));
          var thrCapR = clamp(fxBudget * margin / fFull, hold * 0.9, 1);
          thr = Math.min(thr, thrCapR);
        }
      }
      if (S.oversteer > 0) {
        // Slide: release the brakes (rear unloading) and go to neutral throttle — neither power nor engine braking.
        brk *= 1 - 0.75 * S.oversteer;
        thr = lerp(thr, Math.min(thr, hold * 0.9), clamp(S.oversteer * 1.5, 0, 1));
      }

      // throttle modulation via slip (driver-side traction control)
      var spin = first(vs.wheelspin, 0), skid = first(vs.skidding, 0);
      if (spin > 0.12 && !mistakeIs('wheelspin')) S.tcCap = Math.max(0.2, S.tcCap - dt * (2 + spin * 6) * lerp(0.6, 1.4, skill));
      else S.tcCap = Math.min(1, S.tcCap + dt * lerp(0.8, 1.6, skill));
      thr = Math.min(thr, S.tcCap);
      if (Math.abs(beta) > 0.1) thr *= clamp(1 - (Math.abs(beta) - 0.1) * 4 * skill, 0.1, 1);   // lift in oversteer
      if (skid > 0.25 && brk > 0.3 && !L.hasABS && !mistakeIs('lockup')) S.absCap = Math.max(0.35, S.absCap - dt * 4);
      else S.absCap = Math.min(1, S.absCap + dt * 2);
      brk = Math.min(brk, S.absCap);

      // mistakes affecting pedals
      if (mistakeIs('lockup') && brk > 0.2) brk = 1;
      if (mistakeIs('wheelspin') && vAbs < 30 && thr > 0.3) thr = 1;
      if (mistakeIs('hesitation')) thr *= 0.4;

      // launch: modulate wheelspin from the line
      if (S.t - S.lightsOutAt < 3 && vAbs < 15) thr = Math.min(thr, lerp(0.75, 1, skill) * S.tcCap + 0.05);
      if (recovering && surface !== 'asphalt') thr = Math.min(thr, 0.55);

      input.throttle = thr;
      input.brake = clamp(Math.max(brk, avoidActive && avoidBrake > 0.6 ? avoidBrake : 0), 0, 1);
      if (input.brake > 0.05) input.throttle = 0;

      // ---- manual gearbox support (only when the vehicle expects the driver to shift)
      if (!L.autoShift && num(vs.rpm) && num(vs.gear)) {
        var rl = num(vs.redline) ? vs.redline : L.redline;
        if (vs.rpm > rl * 0.965 && input.throttle > 0.5) input.shiftUp = true;
        else if (vs.rpm < rl * 0.45 && vs.gear > 1) input.shiftDown = true;
        else if (vs.gear === 0 || vs.gear < 0) input.shiftUp = true;
      }

      S.dbg = {
        mode: S.mode, tactic: S.tacMode, side: S.tacSide, targetSpeed: vCmd, profileSpeed: profile[idx] * speedScale,
        lateral: lat, latTarget: S.latTarget, mistake: S.mistake ? S.mistake.type : null, index: idx, s: pr.s,
        offTrack: offTrack, avoid: avoidPush, ttc: minTTC, steerRatio: S.steerRatio,
        eLat: eLat, psiE: psiE, sat: S.tyreSat, rearLed: S.rearLed, betaDot: S.betaDot, gl: S.gripLearn, ovs: S.oversteer, brkLimit: brkLimit, yawExcess: yawExcess, wPP: wPP, kTrack: kTrack, kappa: kappa, kFF: kFF, latRef: latRef, dev: S.dev, wide: S.dbg.wide || 0, crawl: obstacleCrawl, stuckT: S.stuckT, stuckCycles: S.stuckCycles || 0, aheadId: ahead ? ahead.key : null, aheadSpd: ahead ? ahead.speed : null,
      };
      return finish(input, dt);
    }

    /** Pedal/steer slew limiting, NaN guards. */
    function finish(input, dt, noSlew) {
      var sRate = steerSmooth * dt * (S.mode === 'spun' || S.mode === 'reverse' ? 1.6 : 1);
      var steerT = clamp(num(input.steer) ? input.steer : 0, -1, 1);
      S.steer = noSlew ? approach(S.steer, steerT, sRate * 2) : approach(S.steer, steerT, sRate);
      var thrT = clamp(num(input.throttle) ? input.throttle : 0, 0, 1);
      var brkT = clamp(num(input.brake) ? input.brake : 0, 0, 1);
      // brakes go on fast, come off progressively; throttle is squeezed
      S.brake = brkT > S.brake ? approach(S.brake, brkT, pedalRate * dt * 2.2) : approach(S.brake, brkT, pedalRate * dt * 1.2);
      S.throttle = thrT > S.throttle ? approach(S.throttle, thrT, pedalRate * dt * (S.thrSqueeze || 1)) : approach(S.throttle, thrT, pedalRate * dt * 2.5);
      input.steer = S.steer;
      input.throttle = S.throttle;
      input.brake = S.brake;
      if (input.brake > 0.05 && !input.reverse) input.throttle = Math.min(input.throttle, 0.05);
      if (!input.reverse) {
        if (num(S.gear) && S.gear < 0 && S.mode !== 'reverse') {
          // vehicle sits in reverse (brake-at-standstill convention) but we want to go forward:
          // throttle re-selects 1st (and brakes while rolling backwards); brake would drive us backwards.
          input.brake = 0; input.throttle = Math.max(input.throttle, 0.35); S.brake = 0;
        } else if (S.vAbs < 0.8 && input.brake > 0.25) {
          // hold still with the handbrake so the vehicle doesn't auto-select reverse
          input.brake = 0.25; input.handbrake = true;
        }
      }
      return input;
    }

    return {
      opponent: opponent,
      id: selfId,
      limits: L,
      control: control,
      reset: function () { reset(); frameLatch = {}; frameVotes = {}; },
      setRubberBand: function (on) { rubberBandOpt = !!on; },
      setSkill: function (v) {
        skill = clamp(v, 0, 1);
        latUse = L.arcade ? lerp(0.84, 0.94, skill) : lerp(0.8, 0.93, skill);
        brakeUse = (L.arcade ? lerp(0.8, 0.95, skill) : lerp(0.7, 0.9, skill)) * pers.brakeBias; profileCache = {};
      },
      profile: function (gripScale) { return profileFor(gripScale == null ? 1 : gripScale); },
      debug: function () { return S.dbg; },
      get mode() { return S.mode; },
      get wantsReset() { var w = S.wantsReset; S.wantsReset = false; return w; },
    };
  }

  /* ======================================================================
     Exports
     ====================================================================== */

  CB.race.ai = {
    createGrid: createGrid,
    createDriver: createDriver,
    DIFFICULTIES: DIFFICULTIES,
    DRIVERS: DRIVERS,
    TEAMS: TEAMS,
    PERSONALITIES: PERSONALITIES,
    perfIndex: perfIndex,
    estimateLimits: estimateLimits,
    heuristicMetrics: heuristicMetrics,
    _internal: {
      adaptGeom: adaptGeom, projectLocal: projectLocal, computeRacingLine: computeRacingLine, internalProfile: internalProfile,
      makeRng: makeRng, hashStr: hashStr, wrapAngle: wrapAngle, assignModel: assignModel, shapeModels: shapeModels, matchPerformance: matchPerformance, normalizeBuild: normalizeBuild,
    },
  };
})();

if (typeof module !== 'undefined') module.exports = CB.race.ai;

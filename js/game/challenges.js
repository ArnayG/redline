/* ==========================================================================
   FORGE Atelier — js/game/challenges.js
   CB.game.challenges : skill challenges + Driving School licences (pure logic + canvas overlay).

   Contract: GAME-SPEC.md § Challenges / Driving school.

   Catalog
     list                     main challenges [{ id, name, desc, kind, trackDef, rules, scoreFn, medals, ... }]
     licenses                 [{ id:'B'|'A'|'S', name, desc, tests:[challenge ids], reward, requires }]
     licenseTests             the 9 licence test challenges (same descriptor shape as `list`)
     all() / get(id) / byId   every challenge (main + licence tests)
     kinds                    rule-set implementations: launch, braking, slalom, elk, drift, topspeed, hotlap

   Special tracks (shape identical to CB.race.tracks.list entries, built with tracks.makeTrack)
     trackDefs()              -> [def]  ('challenge-strip', 'challenge-proving-ground', 'challenge-top-speed', 'challenge-drift')
     registerTracks()         push them into CB.race.tracks.list / byId / ids (CB.race.tracks.register(def) if it exists).
                              Called automatically in the browser at load and lazily by createChallengeSession().
     unregisterTracks()       remove them again (tests)

   Sessions
     createChallengeSession(id, build, opts?) -> session
       session.cfg            CB.race.engine.createSession cfg (mode 'time-trial', solo, extras.challenge, hooks)
       session.evaluate(snap) -> { score, medal, done, failed, reason, phase, progress, elapsed_s, text, live }
       session.drawOverlay(ctx, snap, opts?)   HUD widgets + world objects (cones, boxes, gates) + drift widget
       session.drawWorld(ctx, opts?)           world objects only, ctx already in world-metre transform
       session.result() / session.reset() / session.commit() / session.medals / session.course / session.hooks
     drawOverlay(ctx, snapshot, state)       module-level entry (state = a session or session.state)
     createDriftScorer(opts)  stand-alone drift scoring (angle × speed × duration, combo chains, multiplier
                              decay, crash resets) usable in any race

   Medals are scaled to the car: every target is derived from the build's own vehicle model
   (CB.race.vehicle: launch simulation, straight-line trace, grip/braking envelopes, track speed profile)
   and the performance class (D … X, same PI formula as the hub) — a 140 hp hatchback and a 1,200 hp
   hypercar both have to drive well for gold.

   Launching (UNIFY-SPEC): launchSpec(id, build?, opts?) -> {route, params, session}; launch(id, opts?) -> CB.router.go
     ('race' | 'drift' for drift challenges), records the result and returns to the originating screen.

   Progress
     recordResult(profile, id, result) -> { improved, prevMedal, medal, rewards, licenseEarned }
     bestFor(profile, id), licenseStatus(profile), isUnlocked(profile, id), rewardsFor(id, medal, prevMedal)

   Zero dependencies; every sibling (tracks, vehicle, ai, engine, profile, achievements) is feature-detected.
   Loads in Node (no DOM access at load time).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.game = CB.game || {};

(function () {
  'use strict';

  /* ======================================================================
     Helpers
     ====================================================================== */
  var PI = Math.PI, TAU = PI * 2, DEG = PI / 180, G = 9.81, KPH = 3.6;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  function mod(a, n) { return ((a % n) + n) % n; }
  function round(v, d) { var f = Math.pow(10, d || 0); return Math.round(v * f) / f; }
  function wrapAngle(a) {
    if (!isFinite(a)) return 0;
    a = (a + PI) % TAU;
    if (a < 0) a += TAU;
    return a - PI;
  }
  function assign(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
    }
    return t;
  }
  function deepMerge(a, b) {
    var out = assign({}, a);
    if (b) for (var k in b) {
      if (isObj(b[k]) && isObj(out[k])) out[k] = deepMerge(out[k], b[k]);
      else if (b[k] !== undefined) out[k] = b[k];
    }
    return out;
  }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function safe(fn, fb) { try { return fn(); } catch (e) { return fb; } }
  function hashStr(str) {
    var h = 2166136261 >>> 0;
    str = String(str);
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function buildHash(b) { return b ? hashStr(safe(function () { return JSON.stringify(b); }, 'x')).toString(36) : 'none'; }
  function makeRng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    var r = function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    r.range = function (lo, hi) { return lo + (hi - lo) * r(); };
    return r;
  }
  function getPath(o, p) {
    var parts = p.split('.');
    for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
    return o;
  }
  function fmtInt(n) {
    n = Math.round(num(n, 0));
    var s = String(Math.abs(n)), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }
  function fmtTime(s, dec) {
    if (!isNum(s)) return '—';
    dec = dec == null ? 3 : dec;
    var neg = s < 0; s = Math.abs(s);
    var m = Math.floor(s / 60), r = s - m * 60;
    var rs = r.toFixed(dec);
    if (m && r < 10) rs = '0' + rs;
    return (neg ? '-' : '') + (m ? m + ':' : '') + rs;
  }
  function fmtSpeed(kph, units, dec) {
    if (!isNum(kph)) return '—';
    var mph = units === 'mph';
    return (mph ? kph / 1.609344 : kph).toFixed(dec == null ? 1 : dec) + (mph ? ' mph' : ' km/h');
  }
  function fmtDist(m) { return isNum(m) ? (Math.abs(m) < 10 ? m.toFixed(2) : m.toFixed(1)) + ' m' : '—'; }

  function tracksMod() { return (CB.race && CB.race.tracks && typeof CB.race.tracks.build === 'function') ? CB.race.tracks : null; }
  function vehicleMod() { return (CB.race && CB.race.vehicle && typeof CB.race.vehicle.fromBuild === 'function') ? CB.race.vehicle : null; }
  function aiMod() { return (CB.race && CB.race.ai) || null; }
  function profileMod() { return (CB.game && CB.game.profile && typeof CB.game.profile.update === 'function') ? CB.game.profile : null; }
  function achievementsMod() { return (CB.game && CB.game.achievements && typeof CB.game.achievements.check === 'function') ? CB.game.achievements : null; }

  /* ======================================================================
     Medals & performance classes
     ====================================================================== */
  var MEDALS = ['platinum', 'gold', 'silver', 'bronze'];
  var MEDAL_RANK = { none: 0, bronze: 1, silver: 2, gold: 3, platinum: 4 };
  var MEDAL_INFO = {
    platinum: { id: 'platinum', label: 'Platinum', short: 'P', color: '#9fe8ff', dark: '#2b6f80', glow: 'rgba(159,232,255,0.65)' },
    gold: { id: 'gold', label: 'Gold', short: 'G', color: '#f0c246', dark: '#8a6510', glow: 'rgba(240,194,70,0.6)' },
    silver: { id: 'silver', label: 'Silver', short: 'S', color: '#c6ccd4', dark: '#5d646d', glow: 'rgba(198,204,212,0.5)' },
    bronze: { id: 'bronze', label: 'Bronze', short: 'B', color: '#c27a43', dark: '#5f3418', glow: 'rgba(194,122,67,0.5)' }
  };
  // Same thresholds & colours as the hub's PI badge (js/game/hub.js performanceIndex/piClass).
  var CLASSES = [
    { id: 'D', min: 0, color: '#57a8ff', label: 'D · Road' },
    { id: 'C', min: 400, color: '#4cd18a', label: 'C · Sport' },
    { id: 'B', min: 500, color: '#f3c246', label: 'B · Performance' },
    { id: 'A', min: 600, color: '#ff7a3d', label: 'A · Super' },
    { id: 'S1', min: 700, color: '#ff5a8a', label: 'S1 · Track' },
    { id: 'S2', min: 800, color: '#c17bff', label: 'S2 · Hyper' },
    { id: 'X', min: 900, color: '#8fe9ff', label: 'X · Unlimited' }
  ];
  /* Human-skill allowance per class: faster cars are harder to drive at their limit, so the gap between the
     theoretical reference and each medal widens slightly as the class rises (multiplies the medal margins). */
  var CLASS_MARGIN = { D: 0.9, C: 0.95, B: 1.0, A: 1.05, S1: 1.1, S2: 1.16, X: 1.22 };

  function classFor(pi) {
    var c = CLASSES[0];
    for (var i = 0; i < CLASSES.length; i++) if (pi >= CLASSES[i].min) c = CLASSES[i];
    return c;
  }
  function medalRank(m) { return MEDAL_RANK[m] || 0; }
  function betterMedal(a, b) { return medalRank(a) >= medalRank(b) ? (a || null) : (b || null); }

  /** medals: { platinum, gold, silver, bronze, higherIsBetter } → medal id | null */
  function medalFor(score, medals) {
    if (!isNum(score) || !medals) return null;
    var hib = medals.higherIsBetter !== false;
    for (var i = 0; i < MEDALS.length; i++) {
      var th = medals[MEDALS[i]];
      if (!isNum(th)) continue;
      if (hib ? score >= th : score <= th) return MEDALS[i];
    }
    return null;
  }
  /** Next medal above the current score and how far away it is. */
  function nextMedal(score, medals) {
    if (!medals) return null;
    var hib = medals.higherIsBetter !== false, cur = medalFor(score, medals);
    for (var i = MEDALS.length - 1; i >= 0; i--) {
      var m = MEDALS[i];
      if (medalRank(m) <= medalRank(cur)) continue;
      var th = medals[m];
      if (!isNum(th)) continue;
      return { medal: m, target: th, gap: isNum(score) ? (hib ? th - score : score - th) : null };
    }
    return null;
  }

  /* ======================================================================
     Special tracks
     Authored as tracks.turtle layouts (straights + constant-radius arcs). Every layout ends with a fixed
     200 m run-up straight collinear with the main straight, because time-trial sessions place the player
     min(140 m, 8 % of the lap) behind the line.
     ====================================================================== */
  var THEMES = {
    proving: { grass: '#6f7f52', asphalt: '#4b4e53', kerbA: '#e0492a', kerbB: '#f2f2f2', sand: '#c9b48a', sky: '#a9c8e8',
      line: '#f4f4ee', wall: '#d6d6d6', barrier: '#8e969e', tree: '#3f6431', ground: '#6f7f52', accent: '#ff7a1a', night: false },
    concrete: { grass: '#7b8458', asphalt: '#5a5d61', kerbA: '#f2c200', kerbB: '#1d1d1d', sand: '#c8b98f', sky: '#b4cbe0',
      line: '#ffffff', wall: '#e3e3e3', barrier: '#a0a6ad', tree: '#4a6b39', ground: '#7b8458', accent: '#f2c200', night: false },
    salt: { grass: '#ebe5d4', asphalt: '#5c5e62', kerbA: '#1fb6ff', kerbB: '#f7f7f7', sand: '#e3d9c2', sky: '#bcd8f2',
      line: '#ffffff', wall: '#f0ece2', barrier: '#c7c0ad', tree: '#a99f86', ground: '#ebe5d4', accent: '#1fb6ff', night: false },
    drift: { grass: '#3c4a39', asphalt: '#2e3034', kerbA: '#ff2d6f', kerbB: '#f4f4f4', sand: '#a99a78', sky: '#7f9cc0',
      line: '#ffe14d', wall: '#c9c9c9', barrier: '#6c737b', tree: '#2c4a28', ground: '#3c4a39', accent: '#ff2d6f', night: false }
  };

  var TRACK_SPECS = [
    {
      id: 'challenge-strip', name: 'Redline Proving Strip', short: 'Proving Strip', country: 'Germany', city: 'Redline Test Centre',
      desc: 'A 2.4 km dead-straight concrete runway with a return road: the home of Launch Control and the Braking Zone.',
      difficulty: 1, surface: { grip: 1.0, type: 'concrete' }, width_m: 24, theme: THEMES.concrete, timeOfDay: 'day',
      mainStraight_m: 2400, wallType: 'armco', gravel: false, kerbs: { width: 1.0, radius: 200, outside: false },
      runoff: { left: 'tarmac', right: 'tarmac' }, barrier: { left: 14, right: 14 }, tags: ['challenge', 'straight'],
      layout: [
        ['S', 2400, { auto: true, name: 'Runway' }], ['L', 75, 90, { name: 'North Loop' }], ['S', 170, { auto: true }],
        ['L', 75, 90], ['S', 2600, { auto: true, name: 'Return Road' }], ['L', 75, 90, { name: 'South Loop' }], ['S', 170],
        ['L', 75, 90], ['S', 200, { fixed: true, name: 'Staging' }]
      ],
      scenery: function (c) {
        c.add('tower', 60, -1, 10, { l: 14, w: 14, h: 26, text: 'TIMING', variant: 'control-tower', color: '#d8dde3', accent: '#f2c200' });
        c.add('grandstand', 300, -1, 6, { l: 90, w: 16, h: 9, seats: 800, color: '#c6ccd3', accent: '#f2c200' });
        c.row('lamp', 0, 2400, 1, 120, 3, { r: 0.4, lit: true });
        c.row('lamp', 60, 2400, -1, 120, 3, { r: 0.4, lit: true });
        for (var k = 0; k < 6; k++) c.add('building', 900 + k * 220, -1, 34, { l: 50, w: 28, h: 12 + (k % 3) * 4, color: '#9aa3ac', variant: 'hangar' });
        c.row('billboard', 400, 2300, 1, 400, 2, { l: 12, w: 1, h: 5, text: 'REDLINE PROVING' });
        c.trees(2600, 2600 + 2600, 1, { spacing: 30, off: 10, depth: 2, density: 0.55, variants: ['pine', 'oak'] });
      }
    },
    {
      id: 'challenge-proving-ground', name: 'Redline Dynamics Pad', short: 'Dynamics Pad', country: 'Sweden', city: 'Arjeplog',
      desc: 'A wide handling straight lined with cones: slalom, ISO 3888-2 lane change and precision exercises.',
      difficulty: 2, surface: { grip: 1.0, type: 'asphalt' }, width_m: 26, theme: THEMES.proving, timeOfDay: 'day',
      mainStraight_m: 1300, wallType: 'tyres', gravel: false, kerbs: { width: 1.1, radius: 200, outside: true },
      runoff: { left: 'tarmac', right: 'tarmac' }, barrier: { left: 12, right: 12 }, tags: ['challenge', 'handling'],
      layout: [
        ['S', 1300, { auto: true, name: 'Dynamics Straight' }], ['L', 58, 90, { name: 'Turnaround' }], ['S', 130, { auto: true }],
        ['L', 58, 90], ['S', 1500, { auto: true, name: 'Service Road' }], ['L', 58, 90], ['S', 130],
        ['L', 58, 90], ['S', 200, { fixed: true, name: 'Staging' }]
      ],
      scenery: function (c) {
        c.add('pits', 40, -1, 6, { l: 70, w: 14, h: 7, text: 'DYNAMICS', color: '#e9ecef', accent: '#ff7a1a' });
        c.add('tower', 130, 1, 8, { l: 10, w: 10, h: 18, text: 'CONTROL', color: '#e2e6ea', accent: '#ff7a1a' });
        c.row('tyres', 1360, 1700, 1, 70, 0.5, { l: 30, w: 1.4, h: 1 });
        c.trees(200, 1300, 1, { spacing: 18, off: 12, depth: 3, rowGap: 9, density: 0.75, variants: ['pine', 'birch'] });
        c.trees(200, 1300, -1, { spacing: 18, off: 14, depth: 2, rowGap: 9, density: 0.7, variants: ['pine', 'birch'] });
        c.row('lamp', 0, 1300, -1, 100, 3, { r: 0.4, lit: true });
      }
    },
    {
      id: 'challenge-top-speed', name: 'Mirage Flats V-max Course', short: 'Mirage Flats', country: 'USA', city: 'Bonneville, UT',
      desc: 'Six kilometres of graded salt-flat straight between two gentle 420 m turnarounds. Nothing to hit, nowhere to hide.',
      difficulty: 1, surface: { grip: 0.97, type: 'salt' }, width_m: 30, theme: THEMES.salt, timeOfDay: 'day',
      mainStraight_m: 6000, wallType: 'none', gravel: false, kerbs: { width: 0.9, radius: 500, outside: false },
      runoff: { left: 'tarmac', right: 'tarmac' }, barrier: { left: 40, right: 40 }, tags: ['challenge', 'high-speed'],
      layout: [
        ['S', 6000, { auto: true, name: 'Measured Mile' }], ['L', 420, 90, { name: 'East Turnaround' }], ['S', 220, { auto: true }],
        ['L', 420, 90], ['S', 6200, { auto: true, name: 'Return Run' }], ['L', 420, 90, { name: 'West Turnaround' }], ['S', 220],
        ['L', 420, 90], ['S', 200, { fixed: true, name: 'Staging' }]
      ],
      scenery: function (c) {
        c.add('tent', 20, -1, 8, { l: 18, w: 12, h: 5, color: '#ffffff' });
        c.add('tent', 45, -1, 8, { l: 18, w: 12, h: 5, color: '#1fb6ff' });
        c.add('tower', 5000, -1, 12, { l: 8, w: 8, h: 14, text: 'TRAP', variant: 'timing' });
        c.add('tower', 6000, -1, 12, { l: 8, w: 8, h: 14, text: 'TRAP', variant: 'timing' });
        for (var s = 500; s <= 6000; s += 500) c.add('billboard', s, 1, 3, { l: 1.6, w: 0.4, h: 2, text: String(s / 1000) + ' km', variant: 'distance' });
        c.row('rock', 300, 6000, 1, 260, 40, { r: 2.5 }, 60);
        c.row('rock', 300, 6000, -1, 310, 46, { r: 3 }, 60);
      }
    },
    {
      id: 'challenge-drift', name: 'Kurenai Drift Park', short: 'Drift Park', country: 'Japan', city: 'Ebisu',
      desc: 'A 1.2 km ribbon of linked hairpins and S-bends with tarmac run-off and concrete walls close enough to touch.',
      difficulty: 3, surface: { grip: 0.96, type: 'asphalt' }, width_m: 16, theme: THEMES.drift, timeOfDay: 'dusk',
      mainStraight_m: 190, wallType: 'concrete', gravel: false, scale: 1.6, kerbs: { width: 1.3, radius: 120, outside: true },
      runoff: { left: 'tarmac', right: 'tarmac' }, barrier: { left: 5, right: 5 }, style: { drift: true }, tags: ['challenge', 'drift'],
      layout: [
        ['S', 120, { auto: true, name: 'Main Straight' }], ['L', 35, 90, { name: 'Ichi', noSand: true }], ['R', 25, 90, { name: 'Ni', noSand: true }],
        ['L', 30, 180, { name: 'Big Hairpin', noSand: true }], ['S', 60], ['R', 25, 90, { name: 'Kink', noSand: true }],
        ['L', 40, 180, { name: 'Mountain', noSand: true }], ['S', 40, { auto: true }], ['R', 30, 90, { name: 'Shichi', noSand: true }],
        ['L', 40, 90, { name: 'Hachi', noSand: true }], ['L', 35, 90, { name: 'Last', noSand: true }], ['S', 20]
      ],
      scenery: function (c) {
        c.add('grandstand', 40, -1, 3, { l: 70, w: 14, h: 10, seats: 1200, color: '#2c2f36', accent: '#ff2d6f' });
        c.add('tower', 110, 1, 4, { l: 9, w: 9, h: 16, text: 'JUDGES', color: '#30343b', accent: '#ff2d6f' });
        c.cornerFurniture({ tyreR: 70, boardR: 60, countdownBoards: false, brands: ['KURENAI', 'REDLINE', 'NOVA TYRES', 'APEX FUEL'] });
        c.corners.forEach(function (cn) { c.row('lamp', cn.s0, cn.s1, cn.outside, 24, 2, { r: 0.4, lit: true }); });
        c.buildings(600, 1000, 1, { off: 8, lMin: 20, lMax: 36, hMin: 8, hMax: 22, colors: ['#3a3f47', '#444a54', '#2d3138'], lit: true });
      }
    }
  ];

  /* Tiny turtle used only when CB.race.tracks is absent: produces the same control-point shape. */
  function miniTurtle(layout) {
    var x = 0, y = 0, h = 0, pts = [];
    layout.forEach(function (g) {
      if (g[0] === 'S') {
        var n = Math.max(1, Math.ceil(g[1] / 34));
        for (var k = 0; k < n; k++) pts.push([round(x + Math.cos(h) * g[1] * k / n, 2), round(y + Math.sin(h) * g[1] * k / n, 2)]);
        x += Math.cos(h) * g[1]; y += Math.sin(h) * g[1];
      } else {
        var sg = g[0] === 'L' ? 1 : -1, r = g[1], deg = g[2];
        var cx = x - Math.sin(h) * r * sg, cy = y + Math.cos(h) * r * sg, m = Math.max(2, Math.ceil(deg / 11));
        for (var j = 0; j < m; j++) {
          var hh = h + sg * deg * DEG * j / m;
          pts.push([round(cx + Math.sin(hh) * r * sg, 2), round(cy - Math.cos(hh) * r * sg, 2)]);
        }
        h += sg * deg * DEG; x = cx + Math.sin(h) * r * sg; y = cy - Math.cos(h) * r * sg;
      }
    });
    return pts;
  }

  var trackDefCache = null;
  function makeDef(spec) {
    var T = tracksMod(), def = null;
    if (T && typeof T.makeTrack === 'function') {
      def = safe(function () {
        return T.makeTrack({
          id: spec.id, name: spec.name, short: spec.short, country: spec.country, city: spec.city, desc: spec.desc,
          difficulty: spec.difficulty, surface: spec.surface, theme: spec.theme, width_m: spec.width_m, layout: spec.layout,
          scale: spec.scale, style: spec.style, kerbs: spec.kerbs, runoff: spec.runoff, barrier: spec.barrier, gravel: spec.gravel,
          wallType: spec.wallType, defaultLaps: 1, timeOfDay: spec.timeOfDay, tags: spec.tags, scenery: spec.scenery
        });
      }, null);
    }
    if (!def) {
      var layout = spec.scale ? spec.layout.map(function (g) { var c = g.slice(); c[1] = g[1] * spec.scale; return c; }) : spec.layout;
      def = {
        id: spec.id, name: spec.name, short: spec.short, country: spec.country, city: spec.city, desc: spec.desc,
        difficulty: spec.difficulty, surface: spec.surface, theme: spec.theme, width_m: spec.width_m, points: miniTurtle(layout),
        pitStraight: 0, length_m: 0, style: spec.style || {}, kerbs: spec.kerbs, runoff: spec.runoff, barrier: spec.barrier,
        gravel: spec.gravel, wallType: spec.wallType, defaultLaps: 1, timeOfDay: spec.timeOfDay, tags: spec.tags || [], scenery: []
      };
      var L = 0;
      for (var i = 0; i < def.points.length; i++) {
        var a = def.points[i], b = def.points[(i + 1) % def.points.length];
        L += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      def.length_m = Math.round(L);
    }
    def.challenge = true;
    def.isChallenge = true;
    def.hidden = true;
    def.kind = 'challenge';
    def.mainStraight_m = spec.mainStraight_m * (spec.scale || 1);
    return def;
  }
  function trackDefs() {
    if (!trackDefCache) trackDefCache = TRACK_SPECS.map(makeDef);
    return trackDefCache;
  }
  function challengeTrack(id) {
    var defs = trackDefs();
    for (var i = 0; i < defs.length; i++) if (defs[i].id === id) return defs[i];
    return null;
  }
  /** Resolve any track id: challenge layouts first, then the main catalog. */
  function resolveTrackDef(id) {
    var d = challengeTrack(id);
    if (d) return d;
    var T = CB.race && CB.race.tracks;
    if (T && typeof T.get === 'function') { d = safe(function () { return T.get(id); }, null); if (d) return d; }
    var l = T && (typeof T.list === 'function' ? safe(function () { return T.list(); }, null) : T.list);
    if (Array.isArray(l)) for (var i = 0; i < l.length; i++) if (l[i] && l[i].id === id) return l[i];
    return null;
  }

  var registered = false;
  function registerTracks() {
    var T = CB.race && CB.race.tracks;
    if (!T) return false;
    var defs = trackDefs();
    defs.forEach(function (def) {
      if (typeof T.register === 'function') { safe(function () { T.register(def); }); return; }
      var list = Array.isArray(T.list) ? T.list : null;
      if (list && !list.some(function (d) { return d && d.id === def.id; })) list.push(def);
      if (isObj(T.byId) && !T.byId[def.id]) T.byId[def.id] = def;
      if (Array.isArray(T.ids) && T.ids.indexOf(def.id) < 0) T.ids.push(def.id);
      if (typeof T.build === 'function') safe(function () { T.build(def); });   // warm the geometry cache
    });
    registered = true;
    return true;
  }
  function unregisterTracks() {
    var T = CB.race && CB.race.tracks;
    if (!T) return false;
    trackDefs().forEach(function (def) {
      if (typeof T.unregister === 'function') { safe(function () { T.unregister(def.id); }); return; }
      if (Array.isArray(T.list)) for (var i = T.list.length - 1; i >= 0; i--) if (T.list[i] && T.list[i].id === def.id) T.list.splice(i, 1);
      if (isObj(T.byId) && T.byId[def.id] === def) delete T.byId[def.id];
      if (Array.isArray(T.ids)) { var k = T.ids.indexOf(def.id); if (k >= 0) T.ids.splice(k, 1); }
    });
    registered = false;
    return true;
  }

  var geomCache = {};
  function geometryFor(def) {
    if (!def) return null;
    var T = tracksMod();
    if (!T) return null;
    if (geomCache[def.id] && geomCache[def.id].def === def) return geomCache[def.id].geom;
    var g = safe(function () { return T.build(def); }, null);
    if (g) geomCache[def.id] = { def: def, geom: g };
    return g;
  }
  /** Lap distance where the main straight ends (first real bend after the line). */
  function straightEnd(def, geom) {
    var nominal = num(def && def.mainStraight_m, null);
    if (!geom || !geom.samples) return nominal;
    var S = geom.samples, N = S.length;
    for (var i = 0; i < N; i++) {
      if (Math.abs(S[i].curvature) > 1 / 900) return nominal != null ? Math.min(nominal + 40, S[i].s) : S[i].s;
    }
    return nominal;
  }
  /** Where the engine stages the player in time-trial mode (s, may be negative = before the line). */
  function stagingS(geom) { var L = geom ? geom.length : 1000; return -Math.min(140, L * 0.08); }

  /* ======================================================================
     Performance analysis of a build (drives every medal target)
     ====================================================================== */
  var analysisCache = {}, analysisKeys = [];

  function fallbackParams(build) {
    var A = aiMod(), hm = A && typeof A.heuristicMetrics === 'function' ? safe(function () { return A.heuristicMetrics(build); }, null) : null;
    var hp = num(hm && hm.power_hp, 300), mass = num(hm && hm.weight_kg, 1450), mu = num(hm && hm.gripFront, 1.0);
    var layout = getPath(build, 'drivetrain.layout') || 'rwd';
    var drive = layout === 'awd' ? 0.98 : layout === 'fwd' ? 0.6 : 0.62;
    var cdA = 0.7, P = hp * 745.7 * 0.88;
    return {
      fallback: true, mass: mass, power_hp: hp, layout: layout, width_m: 1.9, length_m: 4.5,
      accel: function (v) { v = Math.max(0.5, v); return Math.min(mu * G * drive, P / (mass * v)) - (0.5 * 1.2 * cdA * v * v) / mass - 0.13; },
      lat: function () { return mu * G * 0.93; },
      brake: function (v) { return mu * G * 0.97 + (0.5 * 1.2 * cdA * v * v) / mass; }
    };
  }

  /** Straight-line full-throttle trace {t, v, d} every 1/30 s using the real vehicle model when available. */
  function straightTrace(V, p, fb, maxDist, maxT) {
    var out = [{ t: 0, v: 0, d: 0 }], dt = 1 / 120, t = 0, d = 0, k = 0;
    if (V && p && !fb) {
      var st = safe(function () { return V.createState(p, { x: 0, y: 0, heading: 0, speed: 0 }, { autoShift: true }); }, null);
      if (st) {
        var inp = { throttle: 1, brake: 0, steer: 0, handbrake: false };
        while (d < maxDist && t < maxT) {
          V.step(p, st, inp, dt, { gripMult: 1, wet: false });
          var v = Math.max(0, num(st.vx, num(st.speed, 0)));
          d += v * dt; t += dt;
          if (++k % 4 === 0) out.push({ t: t, v: v, d: d });
        }
        return out;
      }
    }
    var v2 = 0;
    while (d < maxDist && t < maxT) {
      var a = fb.accel(v2);
      v2 = Math.max(0, v2 + a * dt); d += v2 * dt; t += dt;
      if (++k % 4 === 0) out.push({ t: t, v: v2, d: d });
    }
    return out;
  }

  function analyze(build, opts) {
    opts = opts || {};
    var key = buildHash(build) + (opts.metrics ? ':m' : '');
    if (analysisCache[key]) return analysisCache[key];
    var V = vehicleMod(), p = null, fb = null, caps = null;
    if (V) {
      p = safe(function () { return V.fromBuild(build, opts.metrics || null); }, null);
      if (p) caps = safe(function () { return V.capabilities(p); }, p.capabilities || null);
    }
    if (!p) fb = fallbackParams(build);
    var accel = p ? function (v) { return V.accelAt(p, v, 1); } : fb.accel;
    var lat = p ? function (v) { return V.latAccelAt(p, v, 1); } : fb.lat;
    var brake = p ? function (v) { return V.brakeAccelAt(p, v, 1); } : fb.brake;
    var mass = p ? p.mass : fb.mass;
    var hp = p ? num(p.power_hp, num(p.powerKw, 200) * 1.341) : fb.power_hp;
    var trace = straightTrace(V, p, fb, 9000, 150);
    var vTop = 0;
    trace.forEach(function (q) { if (q.v > vTop) vTop = q.v; });
    if (caps && isNum(caps.topSpeed_mps)) vTop = Math.max(Math.min(vTop * 1.02, caps.topSpeed_mps), Math.min(vTop, caps.topSpeed_mps));
    var latG = lat(0) / G;
    var topKph = vTop * KPH;
    var ptw = hp / (mass / 1000);
    var pi = Math.round(clamp(100 + ptw * 1.15 + latG * 180 + (topKph - 200) * 0.6, 100, 999));
    var cls = classFor(pi);
    var width = p ? num(p.width_m, 1.9) : fb.width_m, length = p ? num(p.length_m, 4.5) : fb.length_m;

    function traceAt(field, value) {          // first trace point where trace[field] >= value (interpolated)
      for (var i = 1; i < trace.length; i++) {
        if (trace[i][field] >= value) {
          var a = trace[i - 1], b = trace[i], f = (value - a[field]) / Math.max(1e-9, b[field] - a[field]);
          return { t: lerp(a.t, b.t, f), v: lerp(a.v, b.v, f), d: lerp(a.d, b.d, f) };
        }
      }
      return null;
    }
    var launchCache = {};
    var an = {
      hash: key, build: build, params: p, fallback: !p, mass: mass, power_hp: hp, latG: latG, vTop: vTop, topSpeed_kph: topKph,
      brakeG: brake(0) / G, pi: pi, cls: cls, classId: cls.id, margin: CLASS_MARGIN[cls.id] || 1, width_m: width, length_m: length,
      layout: p ? p.layout : fb.layout, accel: accel, lat: lat, brake: brake, trace: trace,
      /** time from standstill to v (m/s): the vehicle's own launch simulation when possible */
      timeTo: function (v) {
        var kk = Math.round(v * 100);
        if (kk in launchCache) return launchCache[kk];
        var r = null;
        if (V && p && typeof V.simulateLaunch === 'function') r = safe(function () { var s = V.simulateLaunch(p, v * KPH, { tMax: 90 }); return s && isNum(s.t) ? s.t : null; }, null);
        if (r === null) { var q = traceAt('v', v); r = q ? q.t : null; }
        launchCache[kk] = r;
        return r;
      },
      distTo: function (v) { var q = traceAt('v', v); return q ? q.d : null; },
      speedAt: function (dist) { var q = traceAt('d', dist); return q ? q.v : trace[trace.length - 1].v; },
      timeAtDist: function (dist) { var q = traceAt('d', dist); return q ? q.t : null; },
      /** braking distance from v0 to 0 (m) at the tyre/brake limit */
      stopDist: function (v0) {
        var d = 0, v = v0, h = 0.25;
        while (v > 0) { var vn = Math.max(0, v - h); var vm = (v + vn) / 2; d += vm * (v - vn) / Math.max(0.5, brake(vm)); v = vn; }
        return d;
      },
      /** reference lap time on a track def (forward/backward speed profile on the racing line) */
      lapTime: function (def) {
        var T = tracksMod(), geom = geometryFor(def);
        if (!T || !geom) return null;
        return safe(function () {
          var prof = T.speedProfile(geom, function (v) { return lat(v) / G; }, function (v) { return brake(v) / G; },
            function (v) { return accel(v); }, { vMax: Math.max(20, vTop) });
          return T.lapTime(geom, prof);
        }, null);
      }
    };
    analysisCache[key] = an;
    analysisKeys.push(key);
    if (analysisKeys.length > 24) delete analysisCache[analysisKeys.shift()];
    return an;
  }

  function performanceClass(build) {
    var a = analyze(build);
    return { pi: a.pi, id: a.cls.id, label: a.cls.label, color: a.cls.color, margin: a.margin, topSpeed_kph: round(a.topSpeed_kph, 1), latG: round(a.latG, 3), power_hp: Math.round(a.power_hp), mass_kg: Math.round(a.mass) };
  }

  /* Medal ladders from a reference value. factors: { platinum, gold, silver, bronze } multipliers (time-like:
     ref × f, f ≥ 1) or fractions (speed/score-like: ref × f, f ≤ 1). `margin` widens the gap from 1 by class. */
  function ladder(ref, factors, higherIsBetter, margin, decimals, offsets) {
    var m = {}, mg = num(margin, 1);
    MEDALS.forEach(function (k) {
      var f = factors[k];
      if (!isNum(f)) return;
      var ff = 1 + (f - 1) * mg;
      var v = ref * ff + (offsets && isNum(offsets[k]) ? offsets[k] * mg : 0);
      m[k] = round(v, decimals == null ? 3 : decimals);
    });
    m.higherIsBetter = !!higherIsBetter;
    m.reference = round(ref, 4);
    return m;
  }

  /* ======================================================================
     Drift scoring
     points/s = BASE × angleFactor(β) × speedFactor(v) × bonuses, accumulated into a *chain* (unbanked).
     The chain multiplier (×1 … ×10) climbs as the combo meter fills while drifting and from transitions; when
     the car straightens the chain window opens — drift again inside it and the chain continues, otherwise the
     chain is banked (raw × multiplier). Idle time then decays the multiplier one step at a time. Crashes
     (walls, contact, cones, spins, leaving the asphalt) throw the unbanked chain away and reset the multiplier.
     ====================================================================== */
  var DRIFT_DEFAULTS = {
    basePoints: 110,            // points per second at angle factor 1 and 72 km/h
    refSpeed: 20,               // m/s where speedFactor = 1
    speedExponent: 1.25,
    minSpeed_kph: 28,
    minAngle_deg: 11,
    peakAngle_deg: 42,
    plateauEnd_deg: 78,
    maxAngle_deg: 105,
    spinAngle_deg: 125,
    graceTime_s: 0.45,          // below-threshold time tolerated inside one drift
    chainWindow_s: 2.2,         // time after a drift ends during which a new drift continues the chain
    multiplierMax: 10,
    meterPerLevel: 380,         // raw points needed to fill the combo meter at ×1 (grows with the level)
    meterGrowth: 0.3,
    meterDecay_per_s: 0.45,
    multiplierDecay_s: 1.6,     // idle seconds per multiplier step lost once the chain is banked
    transitionWindow_s: 0.9,
    transitionBonus: 160,
    transitionMeter: 0.22,
    proximity_m: 1.6,
    proximityMult: 1.5,
    highSpeed_kph: 120,
    highSpeedMult: 1.25,
    longDrift: [[3, 300, 'LONG DRIFT'], [6, 900, 'MARATHON'], [10, 2000, 'ENDLESS']],
    crashIntensity: 0.18,
    offTrackBreaks: true,
    coneBreaks: true
  };
  var DRIFT_GRADES = [[0, 'Nice'], [1200, 'Great'], [3500, 'Awesome'], [9000, 'Insane'], [22000, 'Legendary'], [50000, 'Godlike']];

  function driftAngleFactor(betaDeg, o) {
    var b = Math.abs(betaDeg);
    if (b < o.minAngle_deg || b > o.maxAngle_deg) return 0;
    if (b <= o.peakAngle_deg) return 0.15 + 0.85 * smoothstep((b - o.minAngle_deg) / (o.peakAngle_deg - o.minAngle_deg));
    if (b <= o.plateauEnd_deg) return 1 + 0.12 * (b - o.peakAngle_deg) / (o.plateauEnd_deg - o.peakAngle_deg);
    return 1.12 - 0.55 * (b - o.plateauEnd_deg) / (o.maxAngle_deg - o.plateauEnd_deg);
  }
  function driftSpeedFactor(v, o) { return Math.pow(Math.max(0, v) / o.refSpeed, o.speedExponent); }
  function driftGrade(points) {
    var g = DRIFT_GRADES[0][1];
    for (var i = 0; i < DRIFT_GRADES.length; i++) if (points >= DRIFT_GRADES[i][0]) g = DRIFT_GRADES[i][1];
    return g;
  }
  /** slip angle between the heading and the velocity vector (rad, + = velocity left of the nose) */
  function slipAngleOf(car) {
    var vx = num(car.vx, null), vy = num(car.vy, null);
    if (vx === null || vy === null) {
      var sr = num(car.slipR, 0);
      return Math.abs(sr) > 0.001 ? -sr : 0;
    }
    if (Math.hypot(vx, vy) < 0.5) return 0;
    return wrapAngle(Math.atan2(vy, vx) - num(car.heading, 0));
  }

  function createDriftScorer(opts) {
    var o = assign({}, DRIFT_DEFAULTS, opts || {});
    var S;
    function reset() {
      S = {
        score: 0, chainRaw: 0, chainPoints: 0, multiplier: 1, meter: 0, drifting: false, inChain: false,
        angle_deg: 0, angleFactor: 0, speedFactor: 0, rate: 0, dir: 0, lastDir: 0, lastDriftT: -99, below: 0,
        driftTime: 0, chainTime: 0, idle: 0, decayAcc: 0, t: 0, totalDriftTime: 0, longestDrift_s: 0, maxAngle_deg: 0,
        bestChain: 0, bestCombo: 1, chains: 0, transitions: 0, crashes: 0, lastCrash: null, flags: {}, popups: [],
        grade: null, lastBank: null, history: []
      };
      return S;
    }
    reset();
    function popup(text, value, color, big) {
      S.popups.push({ text: text, value: value == null ? null : Math.round(value), color: color || '#ffffff', t: S.t, big: !!big });
      if (S.popups.length > 14) S.popups.shift();
    }
    function bank(reason) {
      if (S.chainRaw <= 0) { S.inChain = false; return 0; }
      var pts = Math.round(S.chainRaw * S.multiplier);
      S.score += pts;
      S.chains++;
      if (pts > S.bestChain) S.bestChain = pts;
      S.grade = driftGrade(pts);
      S.lastBank = { points: pts, multiplier: S.multiplier, grade: S.grade, t: S.t, duration: S.chainTime, reason: reason || 'banked' };
      S.history.push(S.lastBank);
      if (S.history.length > 40) S.history.shift();
      popup(S.grade.toUpperCase() + '!', pts, '#7dffb0', true);
      S.chainRaw = 0; S.chainPoints = 0; S.chainTime = 0; S.inChain = false; S.flags = {};
      return pts;
    }
    function crash(reason) {
      var lost = Math.round(S.chainRaw * S.multiplier);
      S.crashes++;
      S.lastCrash = { reason: reason || 'crash', lost: lost, t: S.t };
      if (lost > 0 || S.multiplier > 1) popup((reason || 'CRASH').toUpperCase() + ' — CHAIN LOST', -lost, '#ff5a5a', true);
      S.chainRaw = 0; S.chainPoints = 0; S.chainTime = 0; S.inChain = false; S.drifting = false; S.driftTime = 0;
      S.multiplier = 1; S.meter = 0; S.flags = {}; S.below = 0; S.idle = 0; S.decayAcc = 0;
      return lost;
    }
    function levelUp() {
      if (S.multiplier >= o.multiplierMax) { S.meter = 1; return; }
      S.multiplier++;
      S.meter = 0;
      if (S.multiplier > S.bestCombo) S.bestCombo = S.multiplier;
      popup('×' + S.multiplier + ' COMBO', null, '#ffd84d');
    }
    /**
     * car: snapshot car (x, y, heading, vx, vy, speed, surface …) — ctx: { crash: reason|null, offTrack, wallDist_m }
     */
    function update(car, dt, ctx) {
      ctx = ctx || {};
      dt = clamp(num(dt, 0), 0, 0.25);
      S.t += dt;
      var v = Math.abs(num(car && car.speed, 0));
      var beta = car ? slipAngleOf(car) : 0, bd = Math.abs(beta) / DEG;
      S.angle_deg = bd;
      if (ctx.crash) { crash(ctx.crash); S.rate = 0; return S; }     // the impact frame scores nothing
      var fast = v * KPH >= o.minSpeed_kph;
      if (fast && bd > o.spinAngle_deg && v > 4) { crash('Spin'); S.angle_deg = bd; return S; }
      if (o.offTrackBreaks && ctx.offTrack && (S.drifting || S.chainRaw > 0) && fast) { crash('Off track'); return S; }
      var af = fast ? driftAngleFactor(bd, o) : 0;
      var sf = driftSpeedFactor(v, o);
      S.angleFactor = af; S.speedFactor = sf;
      var active = af > 0;
      if (active) {
        var dir = sign(beta);
        if (!S.drifting) {
          // a new drift: transition if the previous one went the other way and ended moments ago
          if (S.inChain && S.lastDir && dir !== S.lastDir && S.t - S.lastDriftT <= o.transitionWindow_s) {
            S.transitions++;
            S.chainRaw += o.transitionBonus * Math.max(0.5, sf);
            S.meter += o.transitionMeter;
            popup('TRANSITION', o.transitionBonus * Math.max(0.5, sf) * S.multiplier, '#8fd3ff');
          }
          S.drifting = true; S.inChain = true; S.driftTime = 0; S.dir = dir;
        } else if (dir !== S.dir && dir !== 0) {                    // direct flick without straightening
          S.transitions++;
          S.chainRaw += o.transitionBonus * Math.max(0.5, sf);
          S.meter += o.transitionMeter;
          popup('TRANSITION', o.transitionBonus * Math.max(0.5, sf) * S.multiplier, '#8fd3ff');
          S.dir = dir; S.driftTime = 0;
        }
        S.below = 0; S.idle = 0; S.decayAcc = 0;
        var mult = 1;
        if (isNum(ctx.wallDist_m) && ctx.wallDist_m < o.proximity_m) {
          mult *= o.proximityMult;
          if (!S.flags.proximity) { S.flags.proximity = true; popup('PROXIMITY', null, '#ff9df0'); }
        }
        if (v * KPH >= o.highSpeed_kph) {
          mult *= o.highSpeedMult;
          if (!S.flags.highSpeed) { S.flags.highSpeed = true; popup('HIGH SPEED', null, '#ffb86b'); }
        }
        var pts = o.basePoints * af * sf * mult * dt;
        S.rate = o.basePoints * af * sf * mult * S.multiplier;
        S.chainRaw += pts;
        S.meter += pts / (o.meterPerLevel * (1 + (S.multiplier - 1) * o.meterGrowth));
        while (S.meter >= 1 && S.multiplier < o.multiplierMax) levelUp();
        if (S.multiplier >= o.multiplierMax) S.meter = Math.min(S.meter, 1);
        S.driftTime += dt; S.chainTime += dt; S.totalDriftTime += dt;
        if (S.driftTime > S.longestDrift_s) S.longestDrift_s = S.driftTime;
        if (bd > S.maxAngle_deg) S.maxAngle_deg = bd;
        for (var i = 0; i < o.longDrift.length; i++) {
          var ld = o.longDrift[i], fk = 'long' + i;
          if (S.driftTime >= ld[0] && !S.flags[fk]) { S.flags[fk] = true; S.chainRaw += ld[1]; popup(ld[2], ld[1] * S.multiplier, '#c9a7ff'); }
        }
        S.lastDir = S.dir; S.lastDriftT = S.t;
      } else {
        S.rate = 0;
        if (S.drifting) {
          S.below += dt;
          if (S.below >= o.graceTime_s) { S.drifting = false; S.driftTime = 0; }
          else S.chainTime += dt;
        }
        if (!S.drifting) {
          S.idle += dt;
          S.meter = Math.max(0, S.meter - o.meterDecay_per_s * dt);
          if (S.inChain && S.t - S.lastDriftT > o.chainWindow_s) bank('window');
          if (!S.inChain && S.multiplier > 1) {
            S.decayAcc += dt;
            if (S.decayAcc >= o.multiplierDecay_s) { S.decayAcc = 0; S.multiplier--; S.meter = 0.5; popup('×' + S.multiplier, null, '#9aa3ad'); }
          }
        }
      }
      S.chainPoints = Math.round(S.chainRaw * S.multiplier);
      // expire popups (2.2 s)
      while (S.popups.length && S.t - S.popups[0].t > 2.2) S.popups.shift();
      return S;
    }
    /** End of session: bank the open chain (if not crashed) and return the total. */
    function finish() { if (S.inChain || S.chainRaw > 0) bank('finish'); S.drifting = false; return S.score; }
    function total() { return S.score + S.chainPoints; }
    return {
      options: o, update: update, crash: crash, bank: bank, finish: finish, reset: reset, total: total,
      get state() { return S; }
    };
  }

  /* ======================================================================
     Course objects (cones, zones, gates, lines, boards) — authored in track coordinates (s, lateral)
     and resolved to world metres through the track geometry.
     ====================================================================== */
  function worldAt(geom, s, lat) {
    if (geom && typeof geom.pointAt === 'function') {
      var p = geom.pointAt(s, lat);
      if (p && isNum(p.x)) return { x: p.x, y: p.y, heading: num(p.heading, 0) };
    }
    return { x: s, y: lat, heading: 0 };
  }
  function newCourse() { return { cones: [], zones: [], gates: [], lines: [], boards: [], arrows: [] }; }
  function addCone(course, geom, s, lat, props) {
    var w = worldAt(geom, s, lat);
    var c = assign({ id: 'c' + course.cones.length, kind: 'cone', role: 'course', s: s, lat: lat, x: w.x, y: w.y, heading: w.heading, r: 0.22,
      x0: w.x, y0: w.y, hit: false, knocked: false, vx: 0, vy: 0, rot: 0, spin: 0, tip: 0, hitT: null, penalised: false }, props || {});
    course.cones.push(c);
    return c;
  }
  function resetCone(c) {
    c.x = c.x0; c.y = c.y0; c.hit = false; c.knocked = false; c.vx = 0; c.vy = 0; c.rot = 0; c.spin = 0; c.tip = 0; c.hitT = null; c.penalised = false;
  }
  function addLine(course, s, lat0, lat1, props) { var l = assign({ s: s, lat0: lat0, lat1: lat1, color: '#ffffff', width: 0.5, dash: null, label: null }, props || {}); course.lines.push(l); return l; }
  function addZone(course, s0, s1, lat0, lat1, props) { var z = assign({ type: 'box', s0: s0, s1: s1, lat0: lat0, lat1: lat1, color: '#38e08c', fill: 'rgba(56,224,140,0.16)', label: null }, props || {}); course.zones.push(z); return z; }
  function addGate(course, s, lat0, lat1, props) { var g = assign({ s: s, lat0: lat0, lat1: lat1, type: 'start', label: null, color: '#ffffff' }, props || {}); course.gates.push(g); return g; }
  function addBoard(course, s, lat, text, props) { var b = assign({ s: s, lat: lat, text: text, color: '#ffffff', bg: 'rgba(10,12,16,0.82)' }, props || {}); course.boards.push(b); return b; }

  /* Crossing helpers on the continuous course distance d (m from the line, negative before it). */
  function crossFrac(prev, cur, target) {
    if (!isNum(prev) || !isNum(cur) || prev === cur) return -1;
    if (prev < target && cur >= target) return (target - prev) / (cur - prev);
    return -1;
  }
  function crossTime(f, target) {
    var k = crossFrac(f.dPrev, f.d, target);
    return k < 0 ? null : f.t - f.dt * (1 - k);
  }
  function crossValue(f, target, a, b) {
    var k = crossFrac(f.dPrev, f.d, target);
    return k < 0 ? null : lerp(a, b, k);
  }

  /* ======================================================================
     Challenge kinds — rules + scoring implementations
       prepare(ctx) -> { rules, medals, course, info }        ctx = { an, geom, def, rules, startS, endS, challenge }
       init(S), step(S, f), finish(S) ; score(S) is the descriptor's scoreFn
     Frame f = { snap, car, t, dt, d, dPrev, s, lat, latPrev, speed, speedPrev, kph, running, goTime, events, pr, offTrack, crash }
     ====================================================================== */
  var KINDS = {};

  /* ---------------------------------------------------------------- launch */
  KINDS.launch = {
    id: 'launch', label: 'Launch Control', unit: 's', higherIsBetter: false, icon: 'bolt',
    defaults: { targetKph: 200, autoTarget: true, minTargetKph: 80, timeLimit_s: 60, abortOnWall: true, splitsKph: [60, 100, 160, 200, 250, 300],
      splitsDist: [[18.288, '60 ft'], [201.168, '1/8 mile'], [402.336, '1/4 mile'], [1000, '1 km']],
      factors: { platinum: 1.0, gold: 1.045, silver: 1.11, bronze: 1.24 }, offsets: { platinum: 0.12, gold: 0.24, silver: 0.38, bronze: 0.6 } },
    prepare: function (ctx) {
      var r = ctx.rules, an = ctx.an;
      var room = Math.max(300, ctx.endS - ctx.startS - 120);
      var reach = an.speedAt(room) * KPH;
      var target = r.targetKph;
      if (r.autoTarget && target > reach * 0.94) target = Math.max(r.minTargetKph, Math.floor(reach * 0.9 / 10) * 10);
      r.resolvedTargetKph = target;
      var ref = an.timeTo(target / KPH);
      if (!isNum(ref)) ref = num(an.timeAtDist(room), 30);
      var medals = ladder(ref, r.factors, false, an.margin, 3, r.offsets);
      var course = newCourse(), hw = 9;
      addGate(course, ctx.startS + 3.2, -hw, hw, { type: 'start', label: 'STAGE', color: '#ffd84d' });
      var refD = an.distTo(target / KPH);
      if (isNum(refD)) addLine(course, ctx.startS + refD, -hw, hw, { color: '#38e08c', dash: [2, 2], label: target + ' KM/H (REF)' });
      r.splitsDist.forEach(function (sd) { if (ctx.startS + sd[0] < ctx.endS) addLine(course, ctx.startS + sd[0], -hw, hw, { color: 'rgba(255,255,255,0.55)', width: 0.3, label: sd[1].toUpperCase() }); });
      addLine(course, ctx.endS - 60, -hw, hw, { color: '#ff4d4d', width: 1.2, label: 'END OF STRIP' });
      return { rules: r, medals: medals, course: course, info: { targetKph: target, reference_s: ref, referenceDist_m: refD, reachableKph: round(reach, 1) } };
    },
    init: function (S) { S.k = { splits: {}, distSplits: {}, wheelspin: 0, samples: 0, maxG: 0, launchRpm: null, reaction: null, startD: null }; },
    step: function (S, f) {
      var k = S.k, r = S.rules;
      if (!f.running) { k.launchRpm = num(f.car.rpm, null); return; }
      if (k.startD === null) k.startD = f.dPrev;
      var el = f.t - f.goTime;
      S.elapsed = el;
      k.samples++; k.wheelspin += num(f.car.wheelspin, 0);
      if (f.dt > 0) k.maxG = Math.max(k.maxG, (f.speed - f.speedPrev) / f.dt / G);
      if (k.reaction === null && isNum(f.car.reaction_s)) k.reaction = f.car.reaction_s;
      r.splitsKph.forEach(function (sp) {
        if (sp > r.resolvedTargetKph || k.splits[sp] != null) return;
        if (f.kph >= sp) {
          var a = f.speedPrev * KPH, fr = f.kph > a ? (sp - a) / (f.kph - a) : 1;
          k.splits[sp] = round(Math.max(0, el - f.dt * (1 - clamp01(fr))), 3);
        }
      });
      r.splitsDist.forEach(function (sd) {
        if (k.distSplits[sd[1]]) return;
        var tc = crossTime(f, k.startD + sd[0]);
        if (tc !== null) k.distSplits[sd[1]] = { t: round(tc - f.goTime, 3), kph: round(crossValue(f, k.startD + sd[0], f.speedPrev, f.speed) * KPH, 1) };
      });
      if (f.kph >= r.resolvedTargetKph) {
        var a2 = f.speedPrev * KPH, fr2 = f.kph > a2 ? (r.resolvedTargetKph - a2) / (f.kph - a2) : 1;
        S.score = round(Math.max(0, el - f.dt * (1 - clamp01(fr2))), 3);
        return S.complete('Target reached');
      }
      S.live = el;
      if (r.abortOnWall && f.crash) return S.fail('Hit the barrier');
      if (f.offTrack) return S.fail('Left the strip');
      if (f.d > S.endS - 30) return S.fail('Ran out of road');
      if (el > r.timeLimit_s) return S.fail('Time limit');
    },
    stats: function (S) {
      var k = S.k;
      return { targetKph: S.rules.resolvedTargetKph, splits: k.splits, distanceSplits: k.distSplits, reaction_s: k.reaction,
        avgWheelspin: k.samples ? round(k.wheelspin / k.samples, 3) : 0, peakG: round(k.maxG, 2), launchRpm: k.launchRpm };
    }
  };

  /* ---------------------------------------------------------------- braking */
  KINDS.braking = {
    id: 'braking', label: 'Braking Zone', unit: 'pts', higherIsBetter: true, icon: 'target',
    defaults: { entryKph: null, autoEntry: 0.6, minEntryKph: 80, maxEntryKph: 230, boxLength_m: 10, boxWidth_m: 6, laneWidth_m: 9, laneLat: 0,
      marginFactor: 1.12, errScale_m: 4, minEntryRatio: 0.9, maxSpeedBonus: 1.12, conePenalty: 80, stopSpeed: 0.45, stopHold_s: 0.35,
      overshoot_m: 70, timeLimit_s: 120, medals: { platinum: 1060, gold: 900, silver: 700, bronze: 450 } },
    prepare: function (ctx) {
      var r = ctx.rules, an = ctx.an, room = ctx.endS - ctx.startS;
      var v = isNum(r.entryKph) ? r.entryKph : clamp(Math.round(an.topSpeed_kph * r.autoEntry / 10) * 10, r.minEntryKph, r.maxEntryKph);
      function need(kph) { var dv = num(an.distTo(kph * 1.04 / KPH), 1e9); return dv * 1.15 + 60 + an.stopDist(kph / KPH) * r.marginFactor + r.overshoot_m + 60; }
      while (v > 50 && need(v) > room) v -= 10;
      r.resolvedEntryKph = v;
      var sd = an.stopDist(v / KPH);
      var reachD = num(an.distTo(v * 1.04 / KPH), room * 0.5);
      var boardS = Math.min(ctx.startS + reachD * 1.15 + 60, ctx.endS - sd * r.marginFactor - r.overshoot_m - 40);
      boardS = Math.max(ctx.startS + 150, boardS);
      var targetS = boardS + sd * r.marginFactor;
      var bl = r.boxLength_m / 2, bw = r.boxWidth_m / 2, lane = r.laneLat, lw = r.laneWidth_m / 2;
      var course = newCourse();
      addZone(course, targetS - bl, targetS + bl, lane - bw, lane + bw, { type: 'box', label: 'STOP BOX' });
      addLine(course, targetS, lane - bw, lane + bw, { color: '#38e08c', width: 0.25, label: 'TARGET' });
      addLine(course, boardS, lane - lw, lane + lw, { color: '#ff4d4d', width: 1.6, label: 'BRAKE  ' + v + ' KM/H' });
      [[-150, '150'], [-100, '100'], [-50, '50']].forEach(function (b) { addBoard(course, boardS + b[0], lane + lw + 2.2, b[1], { color: '#111', bg: '#ffffff' }); });
      addBoard(course, boardS, lane + lw + 2.2, 'BRAKE', { color: '#fff', bg: '#d42a2a' });
      [[-bl, -bw], [-bl, bw], [bl, -bw], [bl, bw]].forEach(function (q) { addCone(course, ctx.geom, targetS + q[0], lane + q[1], { role: 'box', color: '#38e08c' }); });
      for (var s = boardS - 120; s <= targetS + bl + 12; s += 20) {
        addCone(course, ctx.geom, s, lane - lw, { role: 'lane' });
        addCone(course, ctx.geom, s, lane + lw, { role: 'lane' });
      }
      var medals = assign({ higherIsBetter: true, reference: 1000 }, r.medals);
      return { rules: r, medals: medals, course: course, info: { entryKph: v, boardS: boardS, targetS: targetS, stopDist_m: round(sd, 2) } };
    },
    init: function (S) { S.k = { phase: 'approach', entryKph: null, hold: 0, stopD: null, err: null, latErr: null, peakDecelG: 0, lock: 0 }; },
    onCone: function (S) { S.popup('CONE −' + S.rules.conePenalty, '#ff8a3d'); },
    step: function (S, f) {
      var k = S.k, r = S.rules, info = S.info;
      if (!f.running) return;
      S.elapsed = f.t - f.goTime;
      if (k.phase === 'approach') {
        var ve = crossValue(f, info.boardS, f.speedPrev, f.speed);
        if (ve !== null) {
          k.entryKph = round(ve * KPH, 1);
          k.phase = 'braking';
          var ratio = k.entryKph / r.resolvedEntryKph;
          S.popup('BOARD ' + Math.round(k.entryKph) + ' KM/H', ratio >= 1 ? '#7dffb0' : ratio >= r.minEntryRatio ? '#ffd84d' : '#ff5a5a');
        } else if (f.speed < 0.3 && f.d > info.boardS - 200 && S.elapsed > 8) return S.fail('Stopped before the board');
      } else if (k.phase === 'braking') {
        if (f.dt > 0) k.peakDecelG = Math.max(k.peakDecelG, (f.speedPrev - f.speed) / f.dt / G);
        if (f.speed < r.stopSpeed) k.hold += f.dt; else k.hold = 0;
        if (k.hold >= r.stopHold_s) {
          k.stopD = f.d; k.err = f.d - info.targetS; k.latErr = Math.abs(f.lat - r.laneLat);
          k.phase = 'stopped';
          S.score = KINDS.braking.score(S);
          if (k.entryKph / r.resolvedEntryKph < r.minEntryRatio) return S.fail('Too slow at the board (' + Math.round(k.entryKph) + ' of ' + r.resolvedEntryKph + ' km/h)');
          return S.complete(Math.abs(k.err) <= r.boxLength_m / 2 && k.latErr <= r.boxWidth_m / 2 ? 'In the box' : (k.err > 0 ? 'Overshot by ' : 'Short by ') + fmtDist(Math.abs(k.err)));
        }
        if (f.d > info.targetS + r.overshoot_m) { k.err = f.d - info.targetS; S.score = 0; return S.fail('Overshot the box'); }
      }
      if (f.crash) return S.fail('Hit the barrier');
      if (S.elapsed > r.timeLimit_s) return S.fail('Time limit');
      S.live = k.phase === 'braking' ? Math.max(0, info.targetS - f.d) : null;
    },
    score: function (S) {
      var k = S.k, r = S.rules;
      if (!isNum(k.err) || !isNum(k.entryKph)) return 0;
      var acc = Math.exp(-Math.abs(k.err) / r.errScale_m);
      if (k.latErr > r.boxWidth_m / 2) acc *= 0.5;
      var sp = clamp(k.entryKph / r.resolvedEntryKph, 0, r.maxSpeedBonus);
      return Math.max(0, Math.round(1000 * acc * sp - r.conePenalty * S.coneHits));
    },
    stats: function (S) {
      var k = S.k;
      return { entryKph: k.entryKph, requiredKph: S.rules.resolvedEntryKph, stopError_m: isNum(k.err) ? round(k.err, 2) : null, lateralError_m: isNum(k.latErr) ? round(k.latErr, 2) : null,
        peakDecelG: round(k.peakDecelG, 2), refStopDist_m: S.info.stopDist_m };
    }
  };

  /* ---------------------------------------------------------------- slalom */
  KINDS.slalom = {
    id: 'slalom', label: 'Slalom', unit: 's', higherIsBetter: false, icon: 'cone',
    defaults: { cones: 10, spacing_m: 24, firstCone_m: 170, laneLat: 0, gateWidth_m: 14, conePenalty_s: 2, missPenalty_s: 3, timeLimit_s: 120,
      transientGrip: 0.8, factors: { platinum: 1.0, gold: 1.07, silver: 1.16, bronze: 1.32 } },
    prepare: function (ctx) {
      var r = ctx.rules, an = ctx.an, course = newCourse();
      var first = ctx.startS + 140 + r.firstCone_m * 0.25 + 80;
      first = Math.max(first, r.firstCone_m);
      var startG = first - 45, last = first + (r.cones - 1) * r.spacing_m, finishG = last + 45, hw = r.gateWidth_m / 2;
      addGate(course, startG, r.laneLat - hw, r.laneLat + hw, { type: 'start', label: 'START' });
      addGate(course, finishG, r.laneLat - hw, r.laneLat + hw, { type: 'finish', label: 'FINISH' });
      addCone(course, ctx.geom, startG, r.laneLat - hw, { role: 'gate', kind: 'pylon', color: '#ffffff' });
      addCone(course, ctx.geom, startG, r.laneLat + hw, { role: 'gate', kind: 'pylon', color: '#ffffff' });
      addCone(course, ctx.geom, finishG, r.laneLat - hw, { role: 'gate', kind: 'pylon', color: '#ffffff' });
      addCone(course, ctx.geom, finishG, r.laneLat + hw, { role: 'gate', kind: 'pylon', color: '#ffffff' });
      for (var i = 0; i < r.cones; i++) {
        var side = i % 2 === 0 ? 1 : -1;
        addCone(course, ctx.geom, first + i * r.spacing_m, r.laneLat, { role: 'slalom', index: i, passSide: side, kind: 'pylon' });
        course.arrows.push({ s: first + i * r.spacing_m, lat: r.laneLat + side * 2.6, side: side });
      }
      // reference: sinusoidal weave of amplitude half car width + clearance at the transient grip limit
      var A = an.width_m / 2 + 0.9, d = r.spacing_m, v = 15;
      for (var it = 0; it < 6; it++) v = Math.sqrt(an.lat(v) * r.transientGrip * d * d / (A * PI * PI));
      var vIn = an.speedAt(Math.max(30, startG - ctx.startS));
      var vRun = Math.min(v, vIn * 1.08, an.vTop);
      var ref = (finishG - startG) / Math.max(4, vRun);
      var medals = ladder(ref, r.factors, false, an.margin, 3);
      return { rules: r, medals: medals, course: course, info: { startS: startG, finishS: finishG, firstS: first, refSpeedKph: round(vRun * KPH, 1), reference_s: ref } };
    },
    init: function (S) { S.k = { tStart: null, tFinish: null, misses: 0, gates: 0, minKph: null, maxKph: 0 }; },
    onCone: function (S) { S.popup('CONE +' + S.rules.conePenalty_s.toFixed(1) + ' s', '#ff8a3d'); },
    step: function (S, f) {
      var k = S.k, r = S.rules, info = S.info;
      if (!f.running) return;
      if (k.tStart === null) {
        var ts = crossTime(f, info.startS);
        if (ts !== null) { k.tStart = ts; S.popup('GO GO GO', '#7dffb0'); }
      }
      if (k.tStart !== null && k.tFinish === null) {
        k.maxKph = Math.max(k.maxKph, f.kph);
        k.minKph = k.minKph === null ? f.kph : Math.min(k.minKph, f.kph);
        S.course.cones.forEach(function (c) {
          if (c.role !== 'slalom' || c.judged) return;
          var latC = crossValue(f, c.s, f.latPrev, f.lat);
          if (latC === null) return;
          c.judged = true; k.gates++;
          var side = sign(latC - c.lat);
          if (side !== c.passSide) { k.misses++; c.missed = true; S.popup('MISSED GATE +' + r.missPenalty_s.toFixed(1) + ' s', '#ff5a5a'); }
          else c.passed = true;
        });
        var tf = crossTime(f, info.finishS);
        if (tf !== null) {
          k.tFinish = tf;
          S.score = KINDS.slalom.score(S);
          return S.complete(k.misses || S.coneHits ? 'Finished with penalties' : 'Clean run');
        }
        S.elapsed = f.t - k.tStart;
        S.live = S.elapsed + S.coneHits * r.conePenalty_s + k.misses * r.missPenalty_s;
      } else S.elapsed = 0;
      if (f.crash && f.crashIntensity > 0.5) return S.fail('Hit the barrier');
      if (f.t - f.goTime > r.timeLimit_s) return S.fail('Time limit');
      if (f.d > info.finishS + 300) return S.fail('Missed the finish gate');
    },
    score: function (S) {
      var k = S.k, r = S.rules;
      if (k.tStart === null || k.tFinish === null) return null;
      return round(k.tFinish - k.tStart + S.coneHits * r.conePenalty_s + k.misses * r.missPenalty_s, 3);
    },
    stats: function (S) {
      var k = S.k;
      return { rawTime_s: k.tStart !== null && k.tFinish !== null ? round(k.tFinish - k.tStart, 3) : null, missedGates: k.misses, gates: k.gates,
        minKph: k.minKph !== null ? round(k.minKph, 1) : null, maxKph: round(k.maxKph, 1), refSpeedKph: S.info.refSpeedKph };
    }
  };

  /* ---------------------------------------------------------------- elk test (ISO 3888-2 obstacle avoidance) */
  KINDS.elk = {
    id: 'elk', label: 'Elk Test', unit: 'km/h', higherIsBetter: true, icon: 'cone',
    defaults: { entry_m: 420, laneLat: -3, attempts: 3, coast: true, throttleVoid: 0.3, minEntryKph: 45, timeLimit_s: 330, coneSpacing_m: 3,
      factors: { platinum: 1.0, gold: 0.94, silver: 0.86, bronze: 0.75 }, transient: 0.93 },
    /* ISO 3888-2 lane geometry for a car of width W: section 1 (12 m, 1.1W+0.25), gap 13.5 m, section 2 (11 m, W+1, shifted left,
       1 m between lane edges), gap 12.5 m, section 3 (12 m, min(1.3W+0.25, 3), right edge aligned with section 1). */
    lanes: function (W, entry, base) {
      var w1 = 1.1 * W + 0.25, w2 = W + 1, w3 = Math.min(1.3 * W + 0.25, 3);
      var c1 = base, c2 = c1 + w1 / 2 + 1 + w2 / 2, c3 = (c1 - w1 / 2) + w3 / 2;
      var s1 = entry, e1 = s1 + 12, s2 = e1 + 13.5, e2 = s2 + 11, s3 = e2 + 12.5, e3 = s3 + 12;
      return [{ s0: s1, s1: e1, c: c1, w: w1, name: 'Entry lane' }, { s0: s2, s1: e2, c: c2, w: w2, name: 'Avoidance lane' }, { s0: s3, s1: e3, c: c3, w: w3, name: 'Return lane' }];
    },
    prepare: function (ctx) {
      var r = ctx.rules, an = ctx.an, course = newCourse();
      var entry = Math.max(r.entry_m, ctx.startS + 360);
      var lanes = KINDS.elk.lanes(an.width_m, entry, r.laneLat);
      lanes.forEach(function (ln, li) {
        addZone(course, ln.s0, ln.s1, ln.c - ln.w / 2, ln.c + ln.w / 2, { type: 'lane', label: li === 0 ? 'ENTRY' : null, color: 'rgba(255,255,255,0.65)', fill: 'rgba(255,255,255,0.05)' });
        var n = Math.max(2, Math.round((ln.s1 - ln.s0) / r.coneSpacing_m));
        for (var i = 0; i <= n; i++) {
          var s = ln.s0 + (ln.s1 - ln.s0) * i / n;
          addCone(course, ctx.geom, s, ln.c - ln.w / 2 - 0.15, { role: 'elk', lane: li });
          addCone(course, ctx.geom, s, ln.c + ln.w / 2 + 0.15, { role: 'elk', lane: li });
        }
      });
      addGate(course, lanes[0].s0, lanes[0].c - lanes[0].w / 2, lanes[0].c + lanes[0].w / 2, { type: 'start', label: 'ENTRY · LIFT OFF', color: '#ffd84d' });
      addGate(course, lanes[2].s1, lanes[2].c - lanes[2].w / 2, lanes[2].c + lanes[2].w / 2, { type: 'finish', label: 'EXIT' });
      course.arrows.push({ s: lanes[1].s0 - 6, lat: lanes[1].c, side: 1 }, { s: lanes[2].s0 - 6, lat: lanes[2].c, side: -1 });
      // reference: two cosine lane changes at the transient grip limit, path may use the lane width slack
      function vChange(dLat, len) {
        var v = 18;
        for (var it = 0; it < 6; it++) { var kmax = Math.max(1e-4, dLat * PI * PI / (2 * len * len)); v = Math.sqrt(an.lat(v) * r.transient / kmax); }
        return v;
      }
      var W = an.width_m;
      var d1 = Math.max(0.5, (lanes[1].c - lanes[0].c) - (lanes[0].w - W) / 2 - (lanes[1].w - W) / 2);
      var d2 = Math.max(0.5, (lanes[1].c - lanes[2].c) - (lanes[1].w - W) / 2 - (lanes[2].w - W) / 2);
      var l1 = 13.5 + (12 + 11) / 2, l2 = 12.5 + (11 + 12) / 2;
      var vRef = Math.min(vChange(d1, l1), vChange(d2, l2), an.vTop) * KPH;
      var medals = ladder(vRef, r.factors, true, an.margin, 1);
      return { rules: r, medals: medals, course: course, info: { lanes: lanes, entryS: lanes[0].s0, exitS: lanes[2].s1, reference_kph: round(vRef, 1) } };
    },
    init: function (S) { S.k = { attempt: null, attempts: [], best: null, used: 0 }; },
    onCone: function (S, cone) {
      var a = S.k.attempt;
      if (a && !a.void) { a.void = true; a.reason = 'Hit a cone'; S.popup('CONE — ATTEMPT VOID', '#ff5a5a'); }
    },
    coastActive: function (S) { return !!(S.k.attempt && S.rules.coast); },
    step: function (S, f) {
      var k = S.k, r = S.rules, info = S.info, L = S.L;
      if (!f.running) return;
      S.elapsed = f.t - f.goTime;
      var sl = f.lapS, slp = f.lapSPrev;
      var near = isNum(slp) && Math.abs(sl - slp) < 60;
      if (!k.attempt && near && slp < info.entryS && sl >= info.entryS && k.used < r.attempts) {
        var fr = (info.entryS - slp) / Math.max(1e-6, sl - slp);
        var vIn = lerp(f.speedPrev, f.speed, fr) * KPH;
        k.used++;
        k.attempt = { n: k.used, entryKph: round(vIn, 1), void: false, reason: null, throttle: 0, maxLatErr: 0 };
        S.course.cones.forEach(function (c) { if (c.role === 'elk' && c.knocked && !c.hit) resetCone(c); });
        if (vIn < r.minEntryKph) { k.attempt.void = true; k.attempt.reason = 'Below ' + r.minEntryKph + ' km/h'; }
        S.popup('ATTEMPT ' + k.used + ' · ' + Math.round(vIn) + ' KM/H', '#ffd84d');
      }
      var a = k.attempt;
      if (a) {
        if (!S.hooksActive && num(f.car.throttle, 0) > r.throttleVoid) {
          a.throttle += f.dt;
          if (a.throttle > 0.25 && !a.void) { a.void = true; a.reason = 'Throttle applied'; S.popup('LIFT OFF! ATTEMPT VOID', '#ff5a5a'); }
        }
        info.lanes.forEach(function (ln) {
          if (sl >= ln.s0 && sl <= ln.s1) {
            var e = Math.abs(f.lat - ln.c) - ln.w / 2;
            if (e > a.maxLatErr) a.maxLatErr = e;
            if (e > 0.35 && !a.void) { a.void = true; a.reason = 'Left the ' + ln.name.toLowerCase(); S.popup('OUT OF LANE', '#ff5a5a'); }
          }
        });
        var finished = near && slp < info.exitS && sl >= info.exitS;
        var abandoned = !near || sl > info.exitS + 40 || sl < info.entryS - 5;
        if (finished || abandoned) {
          if (!finished && !a.void) { a.void = true; a.reason = 'Did not exit'; }
          a.clean = !a.void;
          k.attempts.push(a);
          if (a.clean) {
            if (k.best === null || a.entryKph > k.best) k.best = a.entryKph;
            S.popup('CLEAN · ' + Math.round(a.entryKph) + ' KM/H', '#7dffb0');
          }
          k.attempt = null;
          S.score = k.best;
          if (k.used >= r.attempts) return k.best !== null ? S.complete('Best clean pass ' + Math.round(k.best) + ' km/h') : S.fail('No clean pass');
          if (L) S.popup('LOOP AROUND FOR ATTEMPT ' + (k.used + 1), '#ffffff');
        }
      }
      S.live = a ? a.entryKph : k.best;
      if (S.elapsed > r.timeLimit_s) return k.best !== null ? S.complete('Time up') : S.fail('Time limit');
    },
    score: function (S) { return S.k.best; },
    stats: function (S) {
      return { attempts: S.k.attempts.map(function (a) { return { n: a.n, entryKph: a.entryKph, clean: a.clean, reason: a.reason }; }),
        lanes: S.info.lanes.map(function (l) { return { name: l.name, width_m: round(l.w, 2), offset_m: round(l.c, 2) }; }), reference_kph: S.info.reference_kph };
    }
  };

  /* ---------------------------------------------------------------- drift trial */
  KINDS.drift = {
    id: 'drift', label: 'Drift Trial', unit: 'pts', higherIsBetter: true, icon: 'drift',
    defaults: { timeLimit_s: 90, refRadius_m: 45, scorer: {}, assists: { tc: false },
      medals: { platinum: 90000, gold: 52000, silver: 26000, bronze: 10000 } },
    prepare: function (ctx) {
      var r = ctx.rules, an = ctx.an;
      var o = assign({}, DRIFT_DEFAULTS, r.scorer || {});
      function cornerSpeed(latFn) { var v = 15; for (var i = 0; i < 6; i++) v = Math.sqrt(latFn(v) * r.refRadius_m); return v; }
      var vCar = cornerSpeed(an.lat), vRef = cornerSpeed(function () { return 0.95 * G * 0.93; });
      var powerTerm = Math.pow(clamp(an.power_hp / Math.max(600, an.mass) / 0.25, 0.5, 2.5), 0.25);
      var scale = clamp(driftSpeedFactor(vCar, o) / driftSpeedFactor(vRef, o) * powerTerm, 0.55, 1.9) * (r.timeLimit_s / 90);
      var medals = { higherIsBetter: true, reference: round(scale, 4) };
      MEDALS.forEach(function (m) { if (isNum(r.medals[m])) medals[m] = Math.round(r.medals[m] * scale / 100) * 100; });
      return { rules: r, medals: medals, course: newCourse(), info: { scale: round(scale, 3), cornerSpeedKph: round(vCar * KPH, 1) } };
    },
    init: function (S) { S.k = { scorer: createDriftScorer(S.rules.scorer) }; },
    onCone: function (S) { if (S.k.scorer.options.coneBreaks) S.k.scorer.crash('Cone'); },
    step: function (S, f) {
      var k = S.k, r = S.rules;
      if (!f.running) return;
      S.elapsed = f.t - f.goTime;
      var crash = f.crash && f.crashIntensity >= k.scorer.options.crashIntensity ? (f.crashType === 'collision' ? 'Contact' : 'Wall') : null;
      k.scorer.update(f.car, f.dt, { crash: crash, offTrack: f.offTrack, wallDist_m: f.wallDist });
      S.live = k.scorer.total();
      S.score = S.live;
      if (S.elapsed >= r.timeLimit_s) {
        S.score = k.scorer.finish();
        return S.complete('Time');
      }
    },
    finish: function (S) { if (S.k.scorer) S.score = S.k.scorer.finish(); },
    score: function (S) { return S.k.scorer ? S.k.scorer.total() : 0; },
    stats: function (S) {
      var d = S.k.scorer.state;
      return { banked: d.score, bestChain: d.bestChain, bestCombo: d.bestCombo, chains: d.chains, transitions: d.transitions, crashes: d.crashes,
        totalDriftTime_s: round(d.totalDriftTime, 2), longestDrift_s: round(d.longestDrift_s, 2), maxAngle_deg: round(d.maxAngle_deg, 1) };
    }
  };

  /* ---------------------------------------------------------------- top speed run */
  KINDS.topspeed = {
    id: 'topspeed', label: 'Top Speed Run', unit: 'km/h', higherIsBetter: true, icon: 'gauge',
    defaults: { trap_m: 1000, timeLimit_s: 200, factors: { platinum: 0.997, gold: 0.982, silver: 0.958, bronze: 0.91 } },
    prepare: function (ctx) {
      var r = ctx.rules, an = ctx.an, course = newCourse();
      var endS = ctx.endS - 20, trap0 = Math.max(ctx.startS + 200, endS - r.trap_m);
      var ref = Math.min(an.vTop, an.speedAt(endS - ctx.startS)) * KPH;
      addLine(course, trap0, -14, 14, { color: '#1fb6ff', width: 0.8, label: 'SPEED TRAP' });
      addLine(course, endS, -14, 14, { color: '#ff4d4d', width: 1.2, label: 'END OF MEASURED RUN' });
      addZone(course, trap0, endS, -14, 14, { type: 'trap', color: 'rgba(31,182,255,0.55)', fill: 'rgba(31,182,255,0.06)' });
      for (var s = 1000; s < endS; s += 1000) addBoard(course, s, 16.5, (s / 1000) + ' KM', { color: '#111', bg: '#f4f4f4' });
      var medals = ladder(ref, r.factors, true, an.margin, 1);
      return { rules: r, medals: medals, course: course, info: { trapS: trap0, endS: endS, reference_kph: round(ref, 1), vTop_kph: round(an.topSpeed_kph, 1) } };
    },
    init: function (S) { S.k = { vmax: 0, trapT: 0, trapD: 0, vmaxAt: null }; },
    step: function (S, f) {
      var k = S.k, info = S.info;
      if (!f.running) return;
      S.elapsed = f.t - f.goTime;
      if (f.d <= info.endS) {
        if (f.kph > k.vmax) { k.vmax = f.kph; k.vmaxAt = f.d; }
        if (f.d >= info.trapS) { k.trapT += f.dt; k.trapD += Math.max(0, f.d - Math.max(f.dPrev, info.trapS)); }
      }
      S.live = round(k.vmax, 1);
      if (crossFrac(f.dPrev, f.d, info.endS) >= 0) { S.score = round(k.vmax, 1); return S.complete('Run complete'); }
      if (f.crash && f.crashIntensity > 0.3) return S.fail('Crashed at ' + Math.round(f.kph) + ' km/h');
      if (S.elapsed > S.rules.timeLimit_s) return S.fail('Time limit');
    },
    score: function (S) { return S.k.vmax > 0 ? round(S.k.vmax, 1) : null; },
    stats: function (S) {
      var k = S.k;
      return { vmax_kph: round(k.vmax, 1), vmaxAt_m: isNum(k.vmaxAt) ? Math.round(k.vmaxAt) : null, trapAvg_kph: k.trapT > 0 ? round(k.trapD / k.trapT * KPH, 1) : null,
        reference_kph: S.info.reference_kph, theoretical_kph: S.info.vTop_kph };
    }
  };

  /* ---------------------------------------------------------------- hot lap */
  KINDS.hotlap = {
    id: 'hotlap', label: 'Hot Lap', unit: 's', higherIsBetter: false, icon: 'flag',
    defaults: { trackId: 'forge-ring', laps: 3, timeLimit_s: 900, factors: { platinum: 1.03, gold: 1.08, silver: 1.15, bronze: 1.27 } },
    prepare: function (ctx) {
      var r = ctx.rules, an = ctx.an;
      var ref = an.lapTime(ctx.def);
      if (!isNum(ref)) ref = num(ctx.def && ctx.def.length_m, 4000) / Math.max(18, 22 + an.pi * 0.025);
      var medals = ladder(ref, r.factors, false, an.margin, 3);
      return { rules: r, medals: medals, course: newCourse(), info: { reference_s: round(ref, 3), trackName: ctx.def ? ctx.def.name : r.trackId } };
    },
    init: function (S) { S.k = { laps: [], best: null, lastSeen: null, usedEvents: false, prevValid: true }; },
    step: function (S, f) {
      var k = S.k, r = S.rules;
      if (!f.running) return;
      S.elapsed = f.t - f.goTime;
      var got = false;
      f.events.forEach(function (e) {
        if (e.type !== 'lap' || !isNum(e.value)) return;
        k.usedEvents = true; got = true;
        k.laps.push({ time: e.value, valid: e.valid !== false });
      });
      if (!k.usedEvents && isNum(f.car.lastLap_s) && f.car.lastLap_s !== k.lastSeen) {
        k.laps.push({ time: f.car.lastLap_s, valid: k.prevValid !== false && (!isNum(f.car.bestLap_s) || f.car.bestLap_s <= f.car.lastLap_s + 1e-6 || true) });
        got = true;
      }
      k.lastSeen = f.car.lastLap_s;
      k.prevValid = f.car.lapValid;
      if (got) {
        var lap = k.laps[k.laps.length - 1];
        if (lap.valid && (k.best === null || lap.time < k.best)) {
          k.best = lap.time;
          var md = medalFor(lap.time, S.medals);
          S.popup('LAP ' + fmtTime(lap.time) + (md ? ' · ' + MEDAL_INFO[md].label.toUpperCase() : ''), md ? MEDAL_INFO[md].color : '#ffffff');
        } else if (!lap.valid) S.popup('LAP INVALID', '#ff5a5a');
        S.score = k.best;
      }
      S.live = num(f.car.currentLap_s, null);
      if (k.laps.length >= r.laps || f.car.finished || f.snap.phase === 'finished') {
        return k.best !== null ? S.complete(k.laps.length + ' laps') : S.fail('No valid lap');
      }
      if (S.elapsed > r.timeLimit_s) return k.best !== null ? S.complete('Time up') : S.fail('Time limit');
    },
    score: function (S) { return S.k.best; },
    stats: function (S) {
      return { laps: S.k.laps.map(function (l) { return { time: round(l.time, 3), valid: l.valid }; }), reference_s: S.info.reference_s, track: S.info.trackName };
    }
  };

  /* ======================================================================
     Catalog
     ====================================================================== */
  var REWARDS = {   // credits / xp per medal tier (only the improvement over a previous best is paid out)
    bronze: { credits: 2500, xp: 150 }, silver: { credits: 5500, xp: 320 }, gold: { credits: 11000, xp: 650 }, platinum: { credits: 18000, xp: 1100 }
  };

  var SPECS = [
    { id: 'launch-control', kind: 'launch', name: 'Launch Control', track: 'challenge-strip', difficulty: 1, order: 1,
      desc: 'Standing start on the Proving Strip: lights out to 200 km/h as fast as the tyres allow. Slower cars run to the highest speed they can reach on the strip.',
      tips: ['Hold some revs on the lights — the car is held on the brakes until GO.', 'Watch the wheelspin bar: a smooth launch beats a smoky one.', 'Manual gearbox? Shift on the light, not the limiter.'],
      rules: {} },
    { id: 'braking-zone', kind: 'braking', name: 'Braking Zone', track: 'challenge-strip', difficulty: 2, order: 2,
      desc: 'Hit the brake board at the required speed, then stop with the car inside the 10 m box. Distance to the target line and entry speed make the score.',
      tips: ['Arrive at or above the board speed — extra speed is rewarded, too little fails the run.', 'Threshold braking: ABS helps, but release a little before the stop to land on the line.'],
      rules: {} },
    { id: 'slalom', kind: 'slalom', name: 'Slalom', track: 'challenge-proving-ground', difficulty: 2, order: 3,
      desc: 'Ten pylons 24 m apart. Weave through, passing each on the marked side. +2 s per cone hit, +3 s per missed gate.',
      tips: ['Turn in before the cone, not at it — look two cones ahead.', 'Rhythm over aggression: a car that is still settling misses the next gate.'],
      rules: {} },
    { id: 'elk-test', kind: 'elk', name: 'Elk Test', track: 'challenge-proving-ground', difficulty: 3, order: 4,
      desc: 'The ISO 3888-2 obstacle-avoidance lane change sized to your car. Enter, lift off, swerve left and back without touching a cone. Best clean entry speed of three attempts counts.',
      tips: ['The throttle is cut once you pass the entry gate — carry speed in.', 'Steer early and smoothly into the avoidance lane; the return is where cars spin.'],
      rules: {} },
    { id: 'drift-trial', kind: 'drift', name: 'Drift Trial', track: 'challenge-drift', difficulty: 3, order: 5,
      desc: '90 seconds at Kurenai Drift Park. Points from slip angle × speed × duration; chain drifts for combo multipliers up to ×10. Walls, spins and contact lose the open chain.',
      tips: ['Traction control is switched off for this event.', 'Link corners with transitions to build the multiplier — straightening up for too long banks the chain and lets the combo decay.', 'Drift close to the walls for the proximity bonus.'],
      rules: {} },
    { id: 'top-speed-run', kind: 'topspeed', name: 'Top Speed Run', track: 'challenge-top-speed', difficulty: 1, order: 6,
      desc: 'Six kilometres of Mirage Flats salt. Flat out from a standing start; the highest speed before the end of the measured run is your score.',
      tips: ['Stay in the middle: the salt is slippery near the edges.', 'Taller gearing and less drag pay off here.'],
      rules: {} },
    { id: 'hot-lap-forge-ring', kind: 'hotlap', name: 'Hot Lap · Redline Ring', track: 'forge-ring', difficulty: 3, order: 7,
      desc: 'Three timed laps of the 5.8 km Redline Ring Grand Prix circuit. Beat the targets set from your own car\'s potential.',
      tips: ['Track limits invalidate the lap.', 'The first lap starts from the run-up — the flying laps are where gold lives.'],
      rules: { trackId: 'forge-ring', laps: 3 } },
    { id: 'hot-lap-porto-vecchio', kind: 'hotlap', name: 'Hot Lap · Porto Vecchio', track: 'porto-vecchio', difficulty: 4, order: 8,
      desc: 'Three laps between the walls of the Porto Vecchio street circuit. No run-off, no excuses.',
      tips: ['Brake in a straight line — the walls do not forgive a locked front.'],
      rules: { trackId: 'porto-vecchio', laps: 3, factors: { platinum: 1.035, gold: 1.09, silver: 1.17, bronze: 1.3 } } },
    { id: 'hot-lap-little-anvil', kind: 'hotlap', name: 'Hot Lap · Little Anvil', track: 'little-anvil', difficulty: 2, order: 9,
      desc: 'Five laps of the tight Little Anvil kartodromo. Rhythm and minimum-speed precision.',
      tips: ['Short-shift out of the hairpins to stay off the traction limit.'],
      rules: { trackId: 'little-anvil', laps: 5 } }
  ];

  var LICENSE_SPECS = [
    { id: 'B', name: 'B Licence', color: '#4cd18a', reward: { credits: 12000, xp: 800 }, requires: null,
      desc: 'The fundamentals: launch, stop, steer. Required for National events.',
      tests: [
        { id: 'license-b1', kind: 'launch', name: 'B-1 · Standing Start', track: 'challenge-strip',
          desc: 'Launch from the lights to 100 km/h.', rules: { targetKph: 100, autoTarget: false, factors: { platinum: 1.0, gold: 1.06, silver: 1.15, bronze: 1.32 } } },
        { id: 'license-b2', kind: 'braking', name: 'B-2 · Stop in the Box', track: 'challenge-strip',
          desc: 'Brake from 80 km/h and stop inside a 12 m box.', rules: { entryKph: 80, boxLength_m: 12, medals: { platinum: 1000, gold: 850, silver: 650, bronze: 380 } } },
        { id: 'license-b3', kind: 'slalom', name: 'B-3 · Cone Weave', track: 'challenge-proving-ground',
          desc: 'Six wide-spaced cones. Smooth hands.', rules: { cones: 6, spacing_m: 30, factors: { platinum: 1.0, gold: 1.1, silver: 1.22, bronze: 1.42 } } }
      ] },
    { id: 'A', name: 'A Licence', color: '#ff7a3d', reward: { credits: 30000, xp: 1800 }, requires: 'B',
      desc: 'Car control at the limit. Required for Continental events.',
      tests: [
        { id: 'license-a1', kind: 'elk', name: 'A-1 · Lane Change', track: 'challenge-proving-ground',
          desc: 'The elk test: one clean pass, three tries.', rules: { attempts: 3, factors: { platinum: 1.0, gold: 0.93, silver: 0.84, bronze: 0.72 } } },
        { id: 'license-a2', kind: 'drift', name: 'A-2 · Drift Initiation', track: 'challenge-drift',
          desc: '45 seconds to show you can hold a slide.', rules: { timeLimit_s: 45, medals: { platinum: 80000, gold: 45000, silver: 22000, bronze: 8000 } } },
        { id: 'license-a3', kind: 'hotlap', name: 'A-3 · Kart Track Lap', track: 'little-anvil',
          desc: 'Two laps of Little Anvil inside the target.', rules: { trackId: 'little-anvil', laps: 2, factors: { platinum: 1.035, gold: 1.09, silver: 1.17, bronze: 1.3 } } }
      ] },
    { id: 'S', name: 'S Licence', color: '#c17bff', reward: { credits: 75000, xp: 4000 }, requires: 'A',
      desc: 'Redline\'s highest grade. Required for the Hypercar Masters.',
      tests: [
        { id: 'license-s1', kind: 'launch', name: 'S-1 · Full Launch', track: 'challenge-strip',
          desc: 'Lights to 200 km/h (or your car\'s strip maximum) inside a tight target.', rules: { targetKph: 200, factors: { platinum: 1.0, gold: 1.03, silver: 1.08, bronze: 1.16 } } },
        { id: 'license-s2', kind: 'slalom', name: 'S-2 · Precision Slalom', track: 'challenge-proving-ground',
          desc: 'Twelve cones, 18 m apart. Penalties doubled.', rules: { cones: 12, spacing_m: 18, conePenalty_s: 4, missPenalty_s: 6, factors: { platinum: 1.0, gold: 1.05, silver: 1.12, bronze: 1.24 } } },
        { id: 'license-s3', kind: 'hotlap', name: 'S-3 · Redline Ring Qualifier', track: 'forge-ring',
          desc: 'Two laps of the Redline Ring at a qualifying pace.', rules: { trackId: 'forge-ring', laps: 2, factors: { platinum: 1.02, gold: 1.06, silver: 1.11, bronze: 1.2 } } }
      ] }
  ];

  function referenceBuild() {
    if (CB.data && typeof CB.data.defaultBuild === 'function') { var b = safe(function () { return CB.data.defaultBuild(); }, null); if (b) return b; }
    var A = aiMod();
    return (A && A._internal && A._internal.FALLBACK_BUILD) || { body: { style: 'coupe' }, engine: { type: 'ice', displacement_l: 3, aspiration: 'turbo' }, drivetrain: { layout: 'rwd' }, tires: { compound: 'performance' } };
  }

  function makeChallenge(spec, extra) {
    var kind = KINDS[spec.kind];
    var rules = deepMerge(kind.defaults, spec.rules || {});
    if (spec.kind === 'hotlap' && !rules.trackId) rules.trackId = spec.track;
    var ch = {
      id: spec.id, name: spec.name, desc: spec.desc, kind: spec.kind, kindLabel: kind.label, category: spec.kind === 'hotlap' ? 'hotlap' : 'skill',
      icon: kind.icon, unit: kind.unit, higherIsBetter: kind.higherIsBetter, trackId: spec.track, difficulty: spec.difficulty || 2,
      order: spec.order || 0, tips: spec.tips || [], rules: rules, license: null, passMedal: null, requires: spec.requires || null,
      scoreFn: function (state) { return kind.score ? kind.score(state && state.k ? state : (state && state.state) || state) : (state ? state.score : null); },
      medalsFor: function (build, opts) { return challengeMedals(ch, build, opts); },
      format: function (score, units) { return formatScore(ch, score, units); }
    };
    assign(ch, extra || {});
    Object.defineProperty(ch, 'trackDef', { enumerable: true, configurable: true, get: function () { return resolveTrackDef(ch.trackId); } });
    var baseline = null;
    Object.defineProperty(ch, 'medals', {
      enumerable: true, configurable: true,
      get: function () { if (!baseline) baseline = safe(function () { return challengeMedals(ch, referenceBuild()); }, null); return baseline; }
    });
    return ch;
  }

  var LIST = SPECS.map(function (s) { return makeChallenge(s); });
  var LICENSES = LICENSE_SPECS.map(function (L) {
    return { id: L.id, name: L.name, desc: L.desc, color: L.color, reward: L.reward, requires: L.requires, passMedal: 'bronze',
      tests: L.tests.map(function (t) { return t.id; }) };
  });
  var LICENSE_TESTS = [];
  LICENSE_SPECS.forEach(function (L) {
    L.tests.forEach(function (t, i) {
      LICENSE_TESTS.push(makeChallenge(assign({ difficulty: { B: 1, A: 3, S: 4 }[L.id], order: 100 + LICENSE_TESTS.length, requires: L.requires ? { license: L.requires } : null }, t),
        { category: 'license', license: L.id, licenseName: L.name, testIndex: i, passMedal: 'bronze' }));
    });
  });
  // gated main challenges
  LIST.forEach(function (c) {
    if (c.id === 'elk-test' || c.id === 'drift-trial') c.requires = { license: 'B' };
    if (c.id === 'hot-lap-porto-vecchio' || c.id === 'top-speed-run') c.requires = { license: 'A' };
  });
  var BY_ID = {};
  LIST.concat(LICENSE_TESTS).forEach(function (c) { BY_ID[c.id] = c; });

  function get(id) { return BY_ID[id] || null; }
  function all() { return LIST.concat(LICENSE_TESTS); }

  function contextFor(ch, build, opts) {
    opts = opts || {};
    var an = analyze(build, opts);
    var def = resolveTrackDef(ch.trackId);
    var geom = geometryFor(def);
    var rules = deepMerge(ch.rules, opts.rules || {});
    var startS = stagingS(geom);
    var endS = def && def.challenge ? straightEnd(def, geom) : (geom ? geom.length : 1000);
    return { an: an, def: def, geom: geom, rules: rules, startS: startS, endS: num(endS, 1000), challenge: ch };
  }
  /** Medal ladder for a specific build. */
  function challengeMedals(ch, build, opts) {
    if (typeof ch === 'string') ch = get(ch);
    if (!ch) return null;
    var ctx = contextFor(ch, build, opts);
    var prep = KINDS[ch.kind].prepare(ctx);
    return assign({ unit: ch.unit, classId: ctx.an.cls.id, pi: ctx.an.pi }, prep.medals);
  }

  function formatScore(ch, score, units) {
    if (typeof ch === 'string') ch = get(ch);
    if (!isNum(score)) return '—';
    var u = ch ? ch.unit : '';
    if (u === 's') return score >= 60 ? fmtTime(score, 3) : score.toFixed(3) + ' s';
    if (u === 'km/h') return fmtSpeed(score, units, 1);
    if (u === 'pts') return fmtInt(score) + ' pts';
    return String(round(score, 3));
  }

  /* ======================================================================
     Sessions
     ====================================================================== */
  var OFF_SURFACES = { grass: 1, sand: 1, gravel: 1, dirt: 1, wall: 1 };
  var NEUTRAL_MODS = { gripMult: [1, 1], powerMult: 1, dragMult: 1, downforceMult: 1, steerPull: 0 };

  function playerOf(snap) {
    if (!snap || !Array.isArray(snap.cars)) return null;
    var pid = snap.playerId || 'player';
    for (var i = 0; i < snap.cars.length; i++) if (snap.cars[i] && (snap.cars[i].isPlayer || snap.cars[i].id === pid)) return snap.cars[i];
    return null;
  }

  function createChallengeSession(id, build, opts) {
    opts = opts || {};
    var ch = isObj(id) && id.kind ? id : get(id);
    if (!ch) throw new Error('challenges.createChallengeSession: unknown challenge "' + id + '"');
    registerTracks();
    build = build || referenceBuild();
    var kind = KINDS[ch.kind];
    var ctx = contextFor(ch, build, opts);
    var prep = kind.prepare(ctx);
    var rules = prep.rules;
    var medals = assign({ unit: ch.unit, classId: ctx.an.cls.id, pi: ctx.an.pi }, prep.medals);
    var course = prep.course, info = prep.info || {};
    var geom = ctx.geom, def = ctx.def, an = ctx.an;
    var L = geom ? geom.length : 0;
    var seed = isNum(opts.seed) ? (opts.seed >>> 0) : hashStr(ch.id + ':' + an.hash);
    var rng = makeRng(seed ^ 0x51ed27);
    var listeners = [];
    if (typeof opts.onEvent === 'function') listeners.push(opts.onEvent);
    var camera = opts.camera || null, renderer = opts.renderer || null;
    var units = opts.units === 'mph' ? 'mph' : 'kph';
    var extEvents = [], seenKeys = [], seenSet = {};
    var S;

    function emit(type, data) {
      var e = assign({ type: type, challengeId: ch.id, t: S ? S.lastT : 0 }, data || {});
      for (var i = 0; i < listeners.length; i++) safe(function () { listeners[i](e); });
      return e;
    }

    function freshState() {
      course.cones.forEach(function (c) { resetCone(c); c.judged = false; c.missed = false; c.passed = false; });
      var st = {
        id: ch.id, kind: ch.kind, name: ch.name, rules: rules, info: info, medals: medals, course: course, L: L, endS: ctx.endS, startS: ctx.startS,
        phase: 'staged', score: null, live: null, medal: null, done: false, failed: false, reason: null, elapsed: 0,
        coneHits: 0, crashes: 0, popups: [], lastT: null, goTime: null, d: null, dPrev: null, lapS: null, lapSPrev: null, lat: 0, latPrev: 0,
        speedPrev: 0, prevX: null, prevY: null, prevH: null, hint: 0, hooksActive: false, pendingSlow: 0, result: null, units: units,
        doneT: null, frames: 0, maxKph: 0, k: null, carLen: an.length_m, carWid: an.width_m
      };
      st.popup = function (text, color) {
        st.popups.push({ text: text, color: color || '#ffffff', t: num(st.lastT, 0) });
        if (st.popups.length > 8) st.popups.shift();
        emit('popup', { text: text });
      };
      st.complete = function (reason) { finalize(false, reason); };
      st.fail = function (reason) { finalize(true, reason); };
      kind.init(st);
      return st;
    }

    function finalize(failed, reason) {
      if (S.done) return;
      if (kind.finish) kind.finish(S);
      if (!failed && !isNum(S.score) && kind.score) S.score = kind.score(S);
      S.done = true; S.phase = 'done'; S.failed = !!failed; S.reason = reason || null; S.doneT = S.lastT;
      S.medal = failed ? null : medalFor(S.score, medals);
      if (failed && ch.kind !== 'drift') S.score = isNum(S.score) && ch.kind === 'elk' ? S.score : (ch.kind === 'braking' ? 0 : null);
      S.result = buildResult();
      emit(failed ? 'fail' : 'done', { result: S.result });
    }

    function buildResult() {
      var stats = kind.stats ? safe(function () { return kind.stats(S); }, {}) : {};
      var passMedal = ch.passMedal || 'bronze';
      var r = {
        id: ch.id, name: ch.name, kind: ch.kind, category: ch.category, license: ch.license, trackId: def ? def.id : ch.trackId,
        score: isNum(S.score) ? S.score : null, scoreText: formatScore(ch, S.score, units), unit: ch.unit, higherIsBetter: ch.higherIsBetter,
        medal: S.medal, medalLabel: S.medal ? MEDAL_INFO[S.medal].label : 'No medal',
        passed: !S.failed && medalRank(S.medal) >= medalRank(passMedal), failed: S.failed, reason: S.reason,
        medals: clone(medals), elapsed_s: round(S.elapsed, 3), coneHits: S.coneHits, crashes: S.crashes, stats: stats,
        classId: an.cls.id, pi: an.pi, buildHash: an.hash, seed: seed, at: Date.now(), hooks: S.hooksActive
      };
      if (ch.kind === 'drift') r.drift = { score: r.score || 0, combo: stats.bestCombo || 1, bestChain: stats.bestChain || 0, duration_s: stats.totalDriftTime_s || 0 };
      return r;
    }

    /* ----- engine hook contract (GAME-SPEC § Engine hook contract) ----- */
    var hooks = {
      carCreated: function (car) { if (car && car.isPlayer) S.hooksActive = true; },
      preStep: function (car, input) {
        if (!car || !car.isPlayer) return;
        S.hooksActive = true;
        if (input && !S.done && kind.coastActive && kind.coastActive(S)) input.throttle = 0;
      },
      postStep: function (car) {
        if (!car || !car.isPlayer || !(S.pendingSlow > 0)) return;
        var st = car.state || car, f = 1 - Math.min(0.06, S.pendingSlow);
        ['vx', 'vy', 'speed'].forEach(function (k) { if (isNum(st[k])) st[k] *= f; });
        S.pendingSlow = 0;
      },
      modifiers: function () { return NEUTRAL_MODS; }
    };
    function onEngineEvent(e) { if (e && e.type) { extEvents.push(e); if (extEvents.length > 256) extEvents.shift(); } }

    function eventKey(e) { return e.type + '|' + e.carId + '|' + e.t + '|' + (e.value != null ? e.value : ''); }
    function collectEvents(snap, pid) {
      var out = [], src = extEvents.concat(Array.isArray(snap.events) ? snap.events : []);
      extEvents = [];
      for (var i = 0; i < src.length; i++) {
        var e = src[i];
        if (!e || (e.carId != null && e.carId !== pid && !(e.type === 'collision' && (e.otherId === pid || e.other === pid)))) continue;
        var key = eventKey(e);
        if (seenSet[key]) continue;
        seenSet[key] = 1; seenKeys.push(key);
        if (seenKeys.length > 400) delete seenSet[seenKeys.shift()];
        out.push(e);
      }
      return out;
    }

    function project(x, y) {
      var T = tracksMod();
      if (!T || !geom) return null;
      var pr = safe(function () { return T.project(geom, x, y, S.hint); }, null);
      if (pr && isNum(pr.index)) S.hint = pr.index;
      return pr;
    }

    /* ----- cones: swept OBB-vs-circle hits + knock-over animation ----- */
    function stepCones(f) {
      var cones = course.cones;
      if (!cones.length) return;
      var car = f.car, hl = num(car.length_m, S.carLen) / 2, hw = num(car.width_m, S.carWid) / 2;
      var px = S.prevX === null ? car.x : S.prevX, py = S.prevY === null ? car.y : S.prevY, ph = S.prevH === null ? car.heading : S.prevH;
      var travel = Math.hypot(car.x - px, car.y - py);
      var n = clamp(Math.ceil(travel / 0.35), 1, 40), reach = hl + 2 + travel;
      var dh = wrapAngle(num(car.heading, 0) - num(ph, 0));
      for (var i = 0; i < cones.length; i++) {
        var c = cones[i];
        if (c.knocked) continue;
        var dx0 = c.x - car.x, dy0 = c.y - car.y;
        if (dx0 * dx0 + dy0 * dy0 > reach * reach) continue;
        for (var j = 1; j <= n; j++) {
          var u = j / n, x = lerp(px, car.x, u), y = lerp(py, car.y, u), h = num(ph, 0) + dh * u;
          var ch2 = Math.cos(h), sh = Math.sin(h), dx = c.x - x, dy = c.y - y;
          var lx = dx * ch2 + dy * sh, ly = -dx * sh + dy * ch2;
          var qx = clamp(lx, -hl, hl), qy = clamp(ly, -hw, hw);
          if ((lx - qx) * (lx - qx) + (ly - qy) * (ly - qy) <= c.r * c.r) { knock(c, f, Math.atan2(dy, dx)); break; }
        }
      }
    }
    function knock(c, f, dirAng) {
      var vx = num(f.car.vx, Math.cos(f.car.heading) * f.speed), vy = num(f.car.vy, Math.sin(f.car.heading) * f.speed);
      c.knocked = true; c.hit = true; c.hitT = f.t;
      c.vx = vx * 0.8 + Math.cos(dirAng) * 2.5 + rng.range(-1.2, 1.2);
      c.vy = vy * 0.8 + Math.sin(dirAng) * 2.5 + rng.range(-1.2, 1.2);
      c.spin = rng.range(-14, 14); c.tip = 1;
      if (S.done || c.role === 'deco' || f.running === false) return;
      c.penalised = true;
      S.coneHits++;
      S.pendingSlow += 0.012;
      if (kind.onCone) kind.onCone(S, c, f);
      emit('cone', { cone: c.id, role: c.role, x: c.x, y: c.y, hits: S.coneHits });
    }
    function animateCones(dt) {
      if (!(dt > 0)) return;
      course.cones.forEach(function (c) {
        if (!c.knocked) return;
        var sp = Math.hypot(c.vx, c.vy);
        if (sp > 0.01) {
          var ns = Math.max(0, sp - 7.5 * dt), k = ns / sp;
          c.vx *= k; c.vy *= k;
          c.x += c.vx * dt; c.y += c.vy * dt;
        } else { c.vx = 0; c.vy = 0; }
        c.rot += c.spin * dt;
        c.spin *= Math.exp(-2.4 * dt);
      });
    }

    function progressOf() {
      var r = rules, k = S.k;
      if (S.done) return 1;
      switch (ch.kind) {
        case 'launch': return clamp01(S.maxKph / Math.max(1, r.resolvedTargetKph));
        case 'braking': return k.phase === 'approach' ? clamp01((num(S.d, 0) - ctx.startS) / Math.max(1, info.boardS - ctx.startS)) * 0.7 : 0.7 + 0.3 * clamp01(1 - Math.abs(info.targetS - num(S.d, 0)) / Math.max(1, info.targetS - info.boardS));
        case 'slalom': return clamp01((num(S.d, 0) - info.startS) / Math.max(1, info.finishS - info.startS));
        case 'elk': return clamp01(k.used / Math.max(1, r.attempts));
        case 'drift': return clamp01(S.elapsed / Math.max(1, r.timeLimit_s));
        case 'topspeed': return clamp01((num(S.d, 0) - ctx.startS) / Math.max(1, info.endS - ctx.startS));
        case 'hotlap': return clamp01(k.laps.length / Math.max(1, r.laps));
      }
      return 0;
    }
    function liveMedal() {
      if (S.done) return S.medal;
      if (ch.kind === 'drift' || ch.kind === 'topspeed' || ch.kind === 'elk') return medalFor(S.score, medals);
      if (ch.kind === 'hotlap') return medalFor(S.k.best, medals);
      return null;
    }
    function output() {
      return {
        score: isNum(S.score) ? S.score : null, medal: liveMedal(), done: S.done, failed: S.failed, reason: S.reason, phase: S.phase,
        progress: progressOf(), elapsed_s: S.elapsed, live: S.live, text: formatScore(ch, isNum(S.score) ? S.score : S.live, units),
        next: nextMedal(isNum(S.score) ? S.score : S.live, medals), coneHits: S.coneHits, result: S.result
      };
    }

    function evaluate(snap) {
      var car = playerOf(snap);
      if (!car) return output();
      var t = num(snap.t, num(S.lastT, 0) + 1 / 60);
      if (S.lastT !== null && t < S.lastT - 0.25) S = freshState();       // the engine session was restarted
      var dt = S.lastT === null ? 0 : clamp(t - S.lastT, 0, 0.25);
      S.lastT = t;
      S.frames++;
      animateCones(dt);
      while (S.popups.length && t - S.popups[0].t > 2.6) S.popups.shift();
      if (S.done) return output();
      var cd = snap.countdown || {};
      if (S.goTime === null) {
        if (isNum(cd.goTime)) S.goTime = cd.goTime;
        else if (snap.phase === 'racing' && (cd.lightsOut || cd.goTime === undefined)) S.goTime = t;
      }
      var running = S.goTime !== null && t >= S.goTime && snap.phase !== 'grid' && snap.phase !== 'countdown';
      if (running && S.phase === 'staged') { S.phase = 'running'; emit('start', { goTime: S.goTime }); }
      var pr = project(car.x, car.y);
      var s = pr && isNum(pr.s) ? pr.s : num(car.s, 0), lat = pr && isNum(pr.lateral) ? pr.lateral : num(car.lateral, 0);
      var speed = Math.abs(num(car.speed, Math.hypot(num(car.vx, 0), num(car.vy, 0))));
      if (S.d === null) {
        S.d = L && s > L / 2 ? s - L : s; S.dPrev = S.d; S.lapS = s; S.lapSPrev = s; S.lat = lat; S.latPrev = lat; S.speedPrev = speed;
      } else {
        S.dPrev = S.d;
        var ds = geom && typeof geom.deltaS === 'function' ? geom.deltaS(S.lapS, s) : s - S.lapS;
        S.d += ds;
        S.lapSPrev = S.lapS; S.lapS = s; S.latPrev = S.lat; S.lat = lat;
      }
      var evs = collectEvents(snap, car.id);
      var crash = false, crashI = 0, crashType = null;
      evs.forEach(function (e) {
        if (e.type === 'wall' || e.type === 'collision') {
          var it = num(e.intensity, 0.5);
          if (it > crashI) { crashI = it; crashType = e.type; }
          crash = true;
        }
      });
      if (crash && crashI > 0.15) S.crashes++;
      var surface = (pr && pr.surface) || car.surface || 'asphalt';
      var offTrack = !!OFF_SURFACES[surface] || (car.offTrack === true && surface !== 'kerb' && surface !== 'asphalt');
      var wallDist = null;
      if (pr && geom && geom.samples && geom.samples[pr.index]) {
        var sm = geom.samples[pr.index];
        wallDist = (lat >= 0 ? num(sm.wallL, 30) - lat : num(sm.wallR, 30) + lat) - num(car.width_m, S.carWid) / 2;
      }
      var f = {
        snap: snap, car: car, t: t, dt: dt, d: S.d, dPrev: S.dPrev, s: s, lapS: S.lapS, lapSPrev: S.lapSPrev, lat: lat, latPrev: S.latPrev,
        speed: speed, speedPrev: S.speedPrev, kph: speed * KPH, running: running, goTime: S.goTime, events: evs, pr: pr,
        offTrack: offTrack, surface: surface, crash: crash, crashIntensity: crashI, crashType: crashType, wallDist: wallDist
      };
      if (running) S.maxKph = Math.max(S.maxKph, f.kph);
      stepCones(f);
      safe(function () { kind.step(S, f); });
      S.prevX = car.x; S.prevY = car.y; S.prevH = car.heading; S.speedPrev = speed;
      return output();
    }

    function abort(reason) { if (!S.done) finalize(true, reason || 'Abandoned'); return S.result; }
    function reset() { S = freshState(); extEvents = []; return api; }

    /** Persist the result into the player profile (+ rewards, achievements). */
    function commit(o) {
      o = o || {};
      if (!S.result) return null;
      var res = S.result, P = o.profileModule || profileMod(), out = null;
      if (o.profile) {
        out = recordResult(o.profile, ch.id, res);
        if (out && o.applyRewards !== false) applyRewardsTo(o.profile, out.rewards);
      }
      else if (P) out = safe(function () { return P.update(function (p) { return recordResult(p, ch.id, res); }, { reason: 'challenge' }); }, null);
      if (out && P && !o.profile && (out.rewards.credits || out.rewards.xp)) {
        safe(function () {
          if (typeof P.award === 'function') P.award({ credits: out.rewards.credits, xp: out.rewards.xp, reason: 'Challenge · ' + ch.name, category: 'challenge' });
          else { if (P.addCredits) P.addCredits(out.rewards.credits, 'Challenge · ' + ch.name); if (P.addXp) P.addXp(out.rewards.xp); }
        });
      }
      var A = achievementsMod(), unlocked = [];
      var achProfile = o.profile || (P && typeof P.get === 'function' ? safe(function () { return P.get(); }, null) : null);
      if (A && o.achievements !== false) {
        unlocked = unlocked.concat(safe(function () { return A.check(achProfile, { type: 'challenge', id: ch.id, medal: res.medal, score: res.score, passed: res.passed }); }, []) || []);
        if (res.drift) unlocked = unlocked.concat(safe(function () { return A.check(achProfile, { type: 'drift', score: res.drift.score, combo: res.drift.combo, duration_s: res.drift.duration_s }); }, []) || []);
      }
      if (out) out.achievements = unlocked;
      return out;
    }

    function setCamera(c) { camera = c || null; }
    function setRenderer(r) { renderer = r || null; }
    function setUnits(u) { units = u === 'mph' ? 'mph' : 'kph'; S.units = units; }
    function on(fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    }
    function describe() {
      return {
        id: ch.id, name: ch.name, desc: ch.desc, kind: ch.kind, kindLabel: ch.kindLabel, license: ch.license, unit: ch.unit, tips: ch.tips,
        track: def ? { id: def.id, name: def.name, length_m: def.length_m } : null, class: { id: an.cls.id, pi: an.pi, color: an.cls.color, label: an.cls.label },
        medals: MEDALS.filter(function (m) { return isNum(medals[m]); }).map(function (m) { return { medal: m, label: MEDAL_INFO[m].label, color: MEDAL_INFO[m].color, value: medals[m], text: formatScore(ch, medals[m], units) }; }),
        rules: clone(rules), info: clone(info)
      };
    }

    var runtime = {
      id: ch.id, kind: ch.kind, name: ch.name, challenge: ch, rules: rules, medals: medals, course: course, info: info, hooks: hooks,
      evaluate: function (snap) { return evaluate(snap); },
      drawOverlay: function (c2d, snap, o) { return drawSessionOverlay(c2d, snap, api, o || {}); },
      drawWorld: function (c2d, o) { return drawWorldObjects(c2d, api, identityProjector(), o || {}); },
      toJSON: function () { return { id: ch.id, kind: ch.kind, rules: rules, medals: medals }; }
    };
    S = freshState();
    var cfg = {
      trackId: def ? def.id : ch.trackId, track: def || undefined, mode: 'time-trial', laps: ch.kind === 'hotlap' ? rules.laps : 999,
      opponents: 0, opponentCount: 0, playerBuild: build, playerName: opts.playerName, weather: opts.weather || rules.weather || 'dry',
      timeOfDay: opts.timeOfDay || rules.timeOfDay || (def && def.timeOfDay) || 'day',
      assists: assign({ abs: true, tc: true, autoShift: true, racingLine: false, steeringAssist: false }, opts.assists || {}, rules.assists || {}),
      seed: seed, persistGhost: ch.kind === 'hotlap' && opts.persistGhost === true, startPosition: 'front',
      maxTime_s: num(rules.timeLimit_s, 300) + 25, challengeId: ch.id,
      extras: { endurance: false, fuel: false, damage: false, pitStops: false, challenge: runtime, onEvent: onEngineEvent },
      hooks: hooks
    };
    if (isObj(opts.cfg)) assign(cfg, opts.cfg);

    var api = assign({}, runtime, {
      cfg: cfg, config: cfg, build: build, analysis: an, trackDef: def, geom: geom, seed: seed,
      result: function () { return S.result; },
      abort: abort, reset: reset, commit: commit, describe: describe, on: on,
      setCamera: setCamera, setRenderer: setRenderer, setUnits: setUnits,
      getCamera: function () { return camera || rendererCamera(renderer); },
      formatScore: function (v) { return formatScore(ch, v, units); },
      /** Convenience: create the engine session (CB.race.engine) with this cfg. */
      createEngineSession: function (extraCfg) {
        var E = CB.race && CB.race.engine;
        if (!E || typeof E.createSession !== 'function') return null;
        return E.createSession(assign({}, cfg, extraCfg || {}));
      }
    });
    Object.defineProperty(api, 'state', { enumerable: false, get: function () { return S; } });
    api.evaluateProgress = function () { return progressOf(); };
    api.liveMedal = function () { return liveMedal(); };
    runtime.session = function () { return api; };
    runtime.getState = function () { return S; };
    liveSessions.push(api);
    if (liveSessions.length > 6) liveSessions.shift();
    return api;
  }

  /* ======================================================================
     Overlay drawing
     drawOverlay(ctx, snapshot, state, opts) draws, in CSS-pixel space on top of the race canvas:
       • world objects (cones, stop box, lanes, gates, target lines, slalom arrows, distance boards) when a camera
         is known — opts.camera | session.setCamera(cam) | renderer.getCamera(). Camera format (any of):
           { worldToScreen(x, y) -> [sx, sy] | {x, y}, scale? }   or
           { x, y, scale|ppm|zoom (px per metre), up|heading|rotation (world heading pointing up, default π/2 = north),
             screenX|anchorX, screenY|anchorY (px, or fractions ≤ 1 of the canvas; default centre) }
         otherwise a car-up radar inset shows nearby objects;
       • the challenge panel (live score, timer, medal ladder, progress), status line, staging hints;
       • the drift HUD widget (chain points, ×multiplier ring with combo meter, slip-angle gauge, popups);
       • the result banner (medal, score, licence pass/fail).
     ====================================================================== */
  var FONT = '"Inter","SF Pro Display",system-ui,-apple-system,"Segoe UI",sans-serif';
  var MONO = '"JetBrains Mono","SF Mono",ui-monospace,Menlo,Consolas,monospace';
  var CONE = { body: '#ff6a13', dark: '#a8410a', stripe: '#ffffff', knocked: '#b8561f' };

  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }
  function setDash(ctx, d) { if (typeof ctx.setLineDash === 'function') ctx.setLineDash(d || []); }
  function alpha(ctx, a) { ctx.globalAlpha = clamp01(a); }
  function text(ctx, str, x, y, font, color, align, base) {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align || 'left'; ctx.textBaseline = base || 'alphabetic';
    ctx.fillText(str, x, y);
  }
  function hexA(hex, a) {
    var h = String(hex || '#ffffff').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) return 'rgba(255,255,255,' + a + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function canvasSize(ctx, o) {
    var cv = (ctx && ctx.canvas) || {};
    return { W: num(o.width, cv.clientWidth || cv.width || 1280), H: num(o.height, cv.clientHeight || cv.height || 720) };
  }

  /* ---------------- projectors ---------------- */
  /** Camera usable by cameraProjector from a CB.race.renderer instance. renderer.getCamera() returns the camera
      MODE name ('chase', 'tv', ...), so the projection comes from worldToScreen / getView instead. */
  function rendererCamera(r) {
    if (!r) return null;
    if (typeof r.worldToScreen === 'function') {
      var v = typeof r.getView === 'function' ? safe(function () { return r.getView(); }, null) : null;
      return { worldToScreen: function (x, y) { return r.worldToScreen(x, y); }, scale: v && isNum(v.zoom) ? v.zoom : 4 };
    }
    if (typeof r.getView === 'function') {
      var vw = safe(function () { return r.getView(); }, null);
      if (vw && isNum(vw.x) && isNum(vw.y)) return { x: vw.x, y: vw.y, zoom: vw.zoom, up: PI / 2 - num(vw.rot, 0) };
    }
    var c = typeof r.getCamera === 'function' ? safe(function () { return r.getCamera(); }, null) : null;
    return c && typeof c === 'object' ? c : null;
  }
  function identityProjector() { return { pt: function (x, y) { return [x, y]; }, scale: 1, world: true }; }
  function cameraProjector(cam, W, H) {
    if (!cam) return null;
    if (typeof cam.worldToScreen === 'function') {
      return {
        pt: function (x, y) { var p = cam.worldToScreen(x, y); return Array.isArray(p) ? p : [num(p && p.x, 0), num(p && p.y, 0)]; },
        scale: num(cam.scale, num(cam.ppm, num(cam.zoom, 4)))
      };
    }
    var cx = num(cam.x, num(cam.cx, null)), cy = num(cam.y, num(cam.cy, null));
    if (cx === null || cy === null) return null;
    var sc = num(cam.scale, num(cam.ppm, num(cam.zoom, 4)));
    var up = num(cam.up, num(cam.heading, num(cam.rotation, PI / 2)));
    var ax = num(cam.screenX, num(cam.anchorX, 0.5)), ay = num(cam.screenY, num(cam.anchorY, 0.5));
    if (ax <= 1) ax *= W;
    if (ay <= 1) ay *= H;
    var a = PI / 2 - up, ca = Math.cos(a), sa = Math.sin(a);
    return {
      scale: sc,
      pt: function (x, y) {
        var dx = x - cx, dy = y - cy;
        return [ax + (dx * ca - dy * sa) * sc, ay - (dx * sa + dy * ca) * sc];
      }
    };
  }
  function radarProjector(car, cx, cy, scale) {
    var up = num(car.heading, 0), a = PI / 2 - up, ca = Math.cos(a), sa = Math.sin(a);
    return {
      scale: scale, mini: true,
      pt: function (x, y) { var dx = x - car.x, dy = y - car.y; return [cx + (dx * ca - dy * sa) * scale, cy - (dx * sa + dy * ca) * scale]; }
    };
  }
  function screenAngle(P, x, y, ang) {
    var a = P.pt(x, y), b = P.pt(x + Math.cos(ang), y + Math.sin(ang));
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  }

  /* ---------------- world objects ---------------- */
  function zonePoly(z, geom) {
    if (z._w) return z._w;
    var n = Math.max(2, Math.ceil((z.s1 - z.s0) / 4)), L = [], R = [];
    for (var i = 0; i <= n; i++) {
      var s = z.s0 + (z.s1 - z.s0) * i / n;
      L.push(worldAt(geom, s, z.lat1)); R.push(worldAt(geom, s, z.lat0));
    }
    z._w = L.concat(R.reverse());
    return z._w;
  }
  function lineEnds(l, geom) {
    if (!l._w) l._w = [worldAt(geom, l.s, l.lat0), worldAt(geom, l.s, l.lat1)];
    return l._w;
  }

  function drawWorldObjects(ctx, sess, P, o) {
    if (!ctx || !P) return;
    o = o || {};
    var course = sess.course, geom = sess.geom, S = sess.state, sc = P.scale, mini = !!P.mini || !!o.mini, world = !!P.world;
    var px = function (m) { return world ? m : m * sc; };
    ctx.save();
    // zones
    course.zones.forEach(function (z) {
      var poly = zonePoly(z, geom);
      ctx.beginPath();
      poly.forEach(function (w, i) { var p = P.pt(w.x, w.y); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
      ctx.closePath();
      ctx.fillStyle = z.fill; ctx.fill();
      ctx.strokeStyle = z.color; ctx.lineWidth = world ? 0.25 : Math.max(1, 0.25 * sc);
      if (z.type === 'trap') setDash(ctx, world ? [3, 3] : [Math.max(4, 3 * sc), Math.max(4, 3 * sc)]);
      ctx.stroke(); setDash(ctx, []);
      if (z.type === 'box' && !mini) {
        // hatch the stop box
        var w0 = worldAt(geom, z.s0, (z.lat0 + z.lat1) / 2), w1 = worldAt(geom, z.s1, (z.lat0 + z.lat1) / 2);
        var a0 = P.pt(w0.x, w0.y), a1 = P.pt(w1.x, w1.y);
        ctx.save(); ctx.clip();
        ctx.strokeStyle = hexA('#38e08c', 0.22); ctx.lineWidth = world ? 0.3 : Math.max(1, 0.3 * sc);
        var len = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) + px(12), ang = Math.atan2(a1[1] - a0[1], a1[0] - a0[0]);
        ctx.translate((a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2); ctx.rotate(ang + PI / 4);
        for (var q = -len; q <= len; q += px(1.4)) { ctx.beginPath(); ctx.moveTo(q, -len); ctx.lineTo(q, len); ctx.stroke(); }
        ctx.restore();
      }
    });
    // lines
    course.lines.forEach(function (l) {
      var e = lineEnds(l, geom), a = P.pt(e[0].x, e[0].y), b = P.pt(e[1].x, e[1].y);
      ctx.strokeStyle = l.color; ctx.lineWidth = world ? l.width : Math.max(mini ? 1 : 1.5, l.width * sc);
      if (l.dash) setDash(ctx, l.dash.map(px));
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      setDash(ctx, []);
      if (l.label && !mini && !world && sc > 1.1) {
        ctx.save();
        text(ctx, l.label, b[0] + 6, b[1] - 4, '800 10px ' + FONT, l.color, 'left');
        ctx.restore();
      }
    });
    // gates
    course.gates.forEach(function (g) {
      var e = lineEnds(g, geom), a = P.pt(e[0].x, e[0].y), b = P.pt(e[1].x, e[1].y);
      if (g.type === 'finish') {
        var n = 14, w = world ? 0.9 : Math.max(2, 0.9 * sc);
        for (var i = 0; i < n; i++) {
          var u0 = i / n, u1 = (i + 1) / n;
          ctx.strokeStyle = i % 2 ? '#111111' : '#ffffff'; ctx.lineWidth = w;
          ctx.beginPath(); ctx.moveTo(lerp(a[0], b[0], u0), lerp(a[1], b[1], u0)); ctx.lineTo(lerp(a[0], b[0], u1), lerp(a[1], b[1], u1)); ctx.stroke();
        }
      } else {
        ctx.strokeStyle = g.color; ctx.lineWidth = world ? 0.5 : Math.max(1.5, 0.5 * sc);
        setDash(ctx, world ? [1, 1] : [Math.max(3, sc), Math.max(3, sc)]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); setDash(ctx, []);
      }
      if (g.label && !mini && !world) text(ctx, g.label, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 8, '800 10px ' + FONT, g.type === 'finish' ? '#ffffff' : g.color, 'center');
    });
    // slalom / lane-change arrows
    course.arrows.forEach(function (ar) {
      var c = worldAt(geom, ar.s, ar.lat), h = c.heading;
      var tipX = c.x + Math.cos(h) * 1.7, tipY = c.y + Math.sin(h) * 1.7;
      var nx = -Math.sin(h), ny = Math.cos(h);
      var b1x = c.x - Math.cos(h) * 0.6 + nx * 1.1, b1y = c.y - Math.sin(h) * 0.6 + ny * 1.1;
      var b2x = c.x - Math.cos(h) * 0.6 - nx * 1.1, b2y = c.y - Math.sin(h) * 0.6 - ny * 1.1;
      var col = ar.side > 0 ? '#4cd1ff' : '#ffb020';
      var cone = null;
      for (var i = 0; i < course.cones.length; i++) if (course.cones[i].role === 'slalom' && Math.abs(course.cones[i].s - ar.s) < 0.01) { cone = course.cones[i]; break; }
      if (cone && cone.passed) col = '#38e08c';
      if (cone && cone.missed) col = '#ff4d4d';
      var p0 = P.pt(tipX, tipY), p1 = P.pt(b1x, b1y), p2 = P.pt(b2x, b2y);
      ctx.fillStyle = hexA(col, mini ? 0.9 : 0.75);
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.closePath(); ctx.fill();
    });
    // distance / brake boards
    if (!mini && !world) course.boards.forEach(function (b) {
      var w = worldAt(geom, b.s, b.lat), p = P.pt(w.x, w.y);
      ctx.font = '800 10px ' + FONT;
      var tw = (ctx.measureText ? ctx.measureText(b.text).width : b.text.length * 6) + 10;
      ctx.fillStyle = b.bg; rr(ctx, p[0] - tw / 2, p[1] - 8, tw, 16, 3); ctx.fill();
      text(ctx, b.text, p[0], p[1] + 4, '800 10px ' + FONT, b.color, 'center');
    });
    // cones
    course.cones.forEach(function (c) {
      var p = P.pt(c.x, c.y);
      var pylon = c.kind === 'pylon';
      var r = world ? c.r * (pylon ? 1.9 : 1.6) : Math.max(mini ? 1.6 : 2.4, c.r * (pylon ? 1.9 : 1.6) * sc);
      var body = c.color && c.role !== 'slalom' ? c.color : CONE.body;
      if (c.knocked) {
        var ang = screenAngle(P, c.x, c.y, c.rot);
        ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(ang);
        alpha(ctx, 0.85);
        ctx.fillStyle = CONE.knocked; ctx.beginPath();
        if (ctx.ellipse) ctx.ellipse(0, 0, r * 1.6, r * 0.7, 0, 0, TAU); else ctx.arc(0, 0, r, 0, TAU);
        ctx.fill();
        ctx.fillStyle = CONE.stripe; ctx.fillRect(-r * 0.2, -r * 0.55, r * 0.35, r * 1.1);
        ctx.restore();
        return;
      }
      if (!mini) {   // drop shadow + square base
        ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.beginPath(); ctx.arc(p[0] + r * 0.35, p[1] + r * 0.35, r * 1.15, 0, TAU); ctx.fill();
        ctx.fillStyle = hexA(body, 0.55); ctx.fillRect(p[0] - r * 1.15, p[1] - r * 1.15, r * 2.3, r * 2.3);
      }
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, TAU); ctx.fill();
      if (!mini && r > 2.2) {
        ctx.strokeStyle = CONE.stripe; ctx.lineWidth = Math.max(0.8, r * 0.28);
        ctx.beginPath(); ctx.arc(p[0], p[1], r * 0.58, 0, TAU); ctx.stroke();
        ctx.fillStyle = hexA('#000000', 0.25); ctx.beginPath(); ctx.arc(p[0], p[1], r * 0.18, 0, TAU); ctx.fill();
      }
      if (c.role === 'slalom' && (c.passed || c.missed) && !world) {
        ctx.strokeStyle = c.passed ? '#38e08c' : '#ff4d4d'; ctx.lineWidth = mini ? 1 : 2;
        ctx.beginPath(); ctx.arc(p[0], p[1], r + (mini ? 2 : 4), 0, TAU); ctx.stroke();
      }
    });
    ctx.restore();
  }

  /* ---------------- radar inset (no camera available) ---------------- */
  function drawRadar(ctx, sess, car, W, H, o) {
    if (!car) return;
    var R = o.radarRadius || 86, cx = W - R - 22, cy = clamp(H * 0.5, R + 90, H - R - 120), range = o.radarRange_m || 60;
    var P = radarProjector(car, cx, cy, R / range);
    ctx.save();
    ctx.fillStyle = 'rgba(8,10,14,0.72)'; ctx.beginPath(); ctx.arc(cx, cy, R + 6, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R / 2, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
    // track edges
    var geom = sess.geom, S = sess.state;
    if (geom && geom.samples && isNum(S.hint)) {
      var N = geom.samples.length, step = Math.max(1, Math.round(4 / num(geom.ds, 2))), span = Math.ceil(range * 1.2 / num(geom.ds, 2));
      [1, -1].forEach(function (side) {
        ctx.beginPath();
        for (var k = -span; k <= span; k += step) {
          var sm = geom.samples[mod(S.hint + k, N)], hw = sm.hw * side;
          var p = P.pt(sm.x + sm.nx * hw, sm.y + sm.ny * hw);
          if (k === -span) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.2; ctx.stroke();
      });
    }
    drawWorldObjects(ctx, sess, P, { mini: true });
    // the car
    var cl = num(car.length_m, 4.5) * P.scale, cw = num(car.width_m, 1.9) * P.scale;
    ctx.fillStyle = car.color || '#ffffff'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
    rr(ctx, cx - cw / 2, cy - cl / 2, cw, cl, 1.5); ctx.fill(); ctx.stroke();
    ctx.restore();
    text(ctx, 'COURSE · ' + range + ' M', cx, cy + R + 18, '700 9px ' + FONT, 'rgba(255,255,255,0.55)', 'center');
  }

  /* ---------------- medals ---------------- */
  function drawMedal(ctx, x, y, r, medal, lit, t) {
    var M = MEDAL_INFO[medal] || { color: '#555', dark: '#222', short: '?' };
    ctx.save();
    alpha(ctx, lit ? 1 : 0.28);
    if (lit && M.glow) { ctx.shadowColor = M.glow; ctx.shadowBlur = r * 1.2; }
    var g = ctx.createRadialGradient ? ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r) : null;
    if (g) { g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, M.color); g.addColorStop(1, M.dark); ctx.fillStyle = g; } else ctx.fillStyle = M.color;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = hexA('#ffffff', 0.55); ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.beginPath(); ctx.arc(x, y, r * 0.78, 0, TAU); ctx.stroke();
    if (lit && isNum(t) && r > 14) {      // rotating glint
      var a = (t * 1.6) % TAU;
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = r * 0.12;
      ctx.beginPath(); ctx.arc(x, y, r * 0.9, a, a + 0.5); ctx.stroke();
    }
    text(ctx, M.short, x, y + 0.5, '900 ' + Math.round(r * 0.95) + 'px ' + FONT, '#111111', 'center', 'middle');
    ctx.restore();
  }

  /* ---------------- panel ---------------- */
  function liveLines(sess) {
    var S = sess.state, ch = sess.challenge, k = S.k, info = sess.info, r = sess.rules, u = S.units;
    var big = formatScore(ch, isNum(S.score) ? S.score : S.live, u), sub = '', right = S.phase === 'running' || S.done ? fmtTime(S.elapsed, 2) : 'READY';
    switch (ch.kind) {
      case 'launch':
        big = S.phase === 'staged' ? '0.000 s' : formatScore(ch, isNum(S.score) ? S.score : S.elapsed, u);
        sub = 'Target ' + fmtSpeed(r.resolvedTargetKph, u, 0) + (k.splits && k.splits[100] != null && r.resolvedTargetKph > 100 ? ' · 0–100 ' + k.splits[100].toFixed(2) + ' s' : '');
        break;
      case 'braking':
        big = k.phase === 'stopped' ? fmtInt(S.score || 0) + ' pts' : k.phase === 'braking' ? fmtDist(Math.max(0, info.targetS - num(S.d, 0))) : fmtSpeed(S.maxKph ? S.speedPrev * KPH : 0, u, 0);
        sub = 'Board ' + fmtSpeed(r.resolvedEntryKph, u, 0) + (isNum(k.entryKph) ? ' · in at ' + fmtSpeed(k.entryKph, u, 0) : '') + (isNum(k.err) ? ' · ' + (k.err >= 0 ? '+' : '') + k.err.toFixed(2) + ' m' : '');
        break;
      case 'slalom':
        var pen = S.coneHits * r.conePenalty_s + k.misses * r.missPenalty_s;
        big = k.tStart === null ? '—' : formatScore(ch, isNum(S.score) ? S.score : S.live, u);
        sub = (k.gates || 0) + '/' + r.cones + ' gates' + (pen ? ' · +' + pen.toFixed(1) + ' s penalties' : ' · clean');
        break;
      case 'elk':
        big = isNum(k.best) ? fmtSpeed(k.best, u, 1) : k.attempt ? fmtSpeed(k.attempt.entryKph, u, 1) : '—';
        sub = 'Attempt ' + Math.min(r.attempts, k.used + (k.attempt ? 0 : 1)) + '/' + r.attempts + (k.attempt ? (k.attempt.void ? ' · VOID' : ' · lift off!') : ' · best clean pass counts');
        break;
      case 'drift':
        big = fmtInt(isNum(S.score) ? S.score : 0) + ' pts';
        right = fmtTime(Math.max(0, r.timeLimit_s - S.elapsed), 1);
        sub = 'Banked ' + fmtInt(k.scorer.state.score) + ' · best combo ×' + k.scorer.state.bestCombo;
        break;
      case 'topspeed':
        big = fmtSpeed(isNum(S.score) ? S.score : S.maxKph, u, 1);
        sub = 'Now ' + fmtSpeed(S.speedPrev * KPH, u, 0) + ' · ' + (Math.max(0, info.endS - num(S.d, 0)) / 1000).toFixed(2) + ' km to go';
        break;
      case 'hotlap':
        big = isNum(S.live) && !S.done ? fmtTime(S.live, 3) : formatScore(ch, k.best, u);
        sub = 'Lap ' + Math.min(r.laps, k.laps.length + 1) + '/' + r.laps + (isNum(k.best) ? ' · best ' + fmtTime(k.best, 3) : '');
        break;
    }
    return { big: big, sub: sub, right: right };
  }

  function drawPanel(ctx, sess, W, H, t, o) {
    var S = sess.state, ch = sess.challenge, M = sess.medals;
    var w = Math.min(o.panelWidth || 380, W - 24), x = Math.round(W / 2 - w / 2), y = num(o.top, 12), h = 112;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 18;
    var g = ctx.createLinearGradient ? ctx.createLinearGradient(0, y, 0, y + h) : null;
    if (g) { g.addColorStop(0, 'rgba(18,20,26,0.9)'); g.addColorStop(1, 'rgba(10,11,15,0.86)'); ctx.fillStyle = g; } else ctx.fillStyle = 'rgba(12,13,17,0.88)';
    rr(ctx, x, y, w, h, 10); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.lineWidth = 1; rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 10); ctx.stroke();
    // kicker + class badge
    var kick = (ch.license ? ch.licenseName + ' · TEST ' + (ch.testIndex + 1) : ch.kindLabel).toUpperCase();
    text(ctx, kick, x + 14, y + 18, '800 9.5px ' + FONT, '#ff9a3d', 'left');
    var cls = sess.analysis.cls, bw = 58;
    ctx.fillStyle = cls.color; rr(ctx, x + w - bw - 12, y + 8, 24, 15, 2); ctx.fill();
    text(ctx, cls.id, x + w - bw - 12 + 12, y + 19, '900 9.5px ' + MONO, '#0b0b0b', 'center');
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; rr(ctx, x + w - bw + 12, y + 8, bw - 24 + 2, 15, 2); ctx.fill();
    text(ctx, String(sess.analysis.pi), x + w - bw + 12 + (bw - 22) / 2, y + 19, '800 9.5px ' + MONO, '#ffffff', 'center');
    text(ctx, ch.name, x + 14, y + 36, '700 14px ' + FONT, '#ffffff', 'left');
    // live value
    var ll = liveLines(sess);
    text(ctx, ll.big, x + 14, y + 66, '800 25px ' + MONO, S.failed ? '#ff6b6b' : '#ffffff', 'left');
    text(ctx, ll.right, x + w - 14, y + 66, '700 14px ' + MONO, 'rgba(255,255,255,0.75)', 'right');
    text(ctx, ll.sub, x + 14, y + 82, '600 10.5px ' + FONT, 'rgba(255,255,255,0.6)', 'left');
    // medal ladder
    var live = S.done ? S.medal : (ch.kind === 'drift' || ch.kind === 'topspeed' || ch.kind === 'elk' ? medalFor(S.score, M) : ch.kind === 'hotlap' ? medalFor(S.k.best, M) : null);
    var cur = isNum(S.score) ? S.score : S.live, nm = nextMedal(cur, M);
    var tiers = ['bronze', 'silver', 'gold', 'platinum'].filter(function (m) { return isNum(M[m]); });
    var cw = (w - 28) / Math.max(1, tiers.length);
    tiers.forEach(function (m, i) {
      var cx = x + 14 + i * cw, lit = medalRank(live) >= medalRank(m), isNext = nm && nm.medal === m;
      drawMedal(ctx, cx + 7, y + 98, 6.5, m, lit, null);
      var str = formatScore(ch, M[m], S.units).replace(' pts', '');
      text(ctx, str, cx + 17, y + 101.5, (isNext ? '800 ' : '600 ') + '9.5px ' + MONO, lit ? MEDAL_INFO[m].color : isNext ? '#ffffff' : 'rgba(255,255,255,0.4)', 'left');
    });
    // progress bar
    var prog = clamp01(sess.evaluateProgress ? sess.evaluateProgress() : 0);
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x + 10, y + h - 3, w - 20, 2);
    ctx.fillStyle = live ? MEDAL_INFO[live].color : '#ff7a1a'; ctx.fillRect(x + 10, y + h - 3, (w - 20) * prog, 2);
    ctx.restore();
    // status line
    var status = S.done ? (S.failed ? 'FAILED — ' + (S.reason || '') : (S.reason || 'Complete')) : S.phase === 'staged' ? 'Get ready…' : nm && isNum(nm.gap) && nm.gap > 0 && ch.kind !== 'hotlap' ? MEDAL_INFO[nm.medal].label + ' in ' + gapText(ch, nm.gap, S.units) : '';
    if (S.coneHits && !S.done) status += (status ? '   ·   ' : '') + S.coneHits + ' cone' + (S.coneHits > 1 ? 's' : '');
    if (status) text(ctx, status, W / 2, y + h + 16, '700 11px ' + FONT, S.failed ? '#ff8080' : 'rgba(255,255,255,0.82)', 'center');
    return y + h;
  }
  function gapText(ch, gap, units) {
    if (ch.unit === 's') return gap.toFixed(2) + ' s';
    if (ch.unit === 'km/h') return fmtSpeed(gap, units, 1);
    return fmtInt(gap) + ' pts';
  }

  /* ---------------- drift widget ---------------- */
  function drawDriftWidget(ctx, D, sess, W, H, t, top) {
    var cx = W / 2, cy = top + 92, o = sess.state.k.scorer.options;
    ctx.save();
    var crashFlash = D.lastCrash && D.t - D.lastCrash.t < 0.7 ? 1 - (D.t - D.lastCrash.t) / 0.7 : 0;
    // chain readout
    if (D.inChain || D.chainPoints > 0) {
      var pulse = D.drifting ? 1 + 0.04 * Math.sin(t * 14) : 1;
      ctx.save(); ctx.translate(cx - 30, cy); ctx.scale(pulse, pulse);
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 8;
      text(ctx, fmtInt(D.chainPoints), 0, 0, '900 34px ' + MONO, D.drifting ? '#ffffff' : 'rgba(255,255,255,0.7)', 'right', 'middle');
      ctx.restore();
      text(ctx, D.drifting ? 'DRIFTING' : 'CHAIN · ' + Math.max(0, o.chainWindow_s - (D.t - D.lastDriftT)).toFixed(1) + ' s', cx - 30, cy + 24, '800 9.5px ' + FONT, D.drifting ? '#7dffb0' : '#ffd84d', 'right');
    }
    // multiplier ring
    var mx = cx + 6, rad = 22;
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.arc(mx + rad, cy, rad, 0, TAU); ctx.stroke();
    var hot = D.multiplier >= 7 ? '#ff4d8d' : D.multiplier >= 4 ? '#ffb020' : '#ffd84d';
    ctx.strokeStyle = hot; ctx.beginPath(); ctx.arc(mx + rad, cy, rad, -PI / 2, -PI / 2 + TAU * clamp01(D.meter)); ctx.stroke();
    text(ctx, '×' + D.multiplier, mx + rad, cy + 1, '900 17px ' + MONO, '#ffffff', 'center', 'middle');
    // slip-angle gauge
    var gx = cx + 96, gy = cy + 12, gr = 30, a0 = PI, span = PI;
    function angA(deg) { return a0 + span * clamp01(deg / 120); }
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath(); ctx.arc(gx, gy, gr, a0, a0 + span); ctx.stroke();
    ctx.strokeStyle = 'rgba(125,255,176,0.55)'; ctx.beginPath(); ctx.arc(gx, gy, gr, angA(o.minAngle_deg), angA(o.plateauEnd_deg)); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,77,77,0.55)'; ctx.beginPath(); ctx.arc(gx, gy, gr, angA(o.maxAngle_deg), a0 + span); ctx.stroke();
    var na = angA(D.angle_deg);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + Math.cos(na) * (gr + 4), gy + Math.sin(na) * (gr + 4)); ctx.stroke();
    text(ctx, Math.round(D.angle_deg) + '°', gx, gy + 12, '800 10px ' + MONO, D.angleFactor > 0 ? '#7dffb0' : 'rgba(255,255,255,0.6)', 'center');
    // last grade
    if (D.lastBank && D.t - D.lastBank.t < 2.4) {
      var fa = 1 - (D.t - D.lastBank.t) / 2.4;
      alpha(ctx, fa);
      text(ctx, D.lastBank.grade.toUpperCase() + '  +' + fmtInt(D.lastBank.points), cx, cy + 50, '900 15px ' + FONT, '#7dffb0', 'center');
      alpha(ctx, 1);
    }
    // popups rise and fade
    var py = cy + 74;
    for (var i = D.popups.length - 1, n = 0; i >= 0 && n < 5; i--, n++) {
      var p = D.popups[i], age = D.t - p.t, fa2 = clamp01(1 - age / 2.2);
      if (fa2 <= 0) continue;
      alpha(ctx, fa2);
      var label = p.text + (p.value != null && p.value !== 0 ? '  ' + (p.value > 0 ? '+' : '') + fmtInt(p.value) : '');
      text(ctx, label, cx, py - age * 10, (p.big ? '900 13px ' : '800 11px ') + FONT, p.color, 'center');
      py += 16;
    }
    alpha(ctx, 1);
    if (crashFlash > 0) {
      ctx.strokeStyle = 'rgba(255,60,60,' + (0.55 * crashFlash) + ')'; ctx.lineWidth = 14;
      ctx.strokeRect(7, 7, W - 14, H - 14);
    }
    ctx.restore();
  }

  function drawPopups(ctx, S, W, H, t) {
    var y = H * 0.34;
    ctx.save();
    for (var i = S.popups.length - 1, n = 0; i >= 0 && n < 4; i--, n++) {
      var p = S.popups[i], age = t - p.t, a = clamp01(1 - age / 2.6) * clamp01(age / 0.12 + 0.2);
      if (a <= 0) continue;
      alpha(ctx, a);
      ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 6;
      text(ctx, p.text, W / 2, y - age * 12, '900 ' + (n === 0 ? 17 : 13) + 'px ' + FONT, p.color, 'center');
      y += n === 0 ? 24 : 18;
    }
    ctx.restore();
  }

  function drawStaging(ctx, sess, W, H, t) {
    var ch = sess.challenge, tip = (ch.tips && ch.tips[0]) || ch.desc;
    var w = Math.min(560, W - 40), x = W / 2 - w / 2, y = H - 150;
    ctx.save();
    alpha(ctx, 0.85 + 0.15 * Math.sin(t * 3));
    ctx.fillStyle = 'rgba(10,11,15,0.78)'; rr(ctx, x, y, w, 46, 8); ctx.fill();
    text(ctx, 'TIP', x + 14, y + 19, '900 9.5px ' + FONT, '#ff9a3d', 'left');
    text(ctx, tip.length > 92 ? tip.slice(0, 90) + '…' : tip, x + 14, y + 35, '600 11.5px ' + FONT, '#ffffff', 'left');
    ctx.restore();
  }

  function drawBanner(ctx, sess, W, H, t) {
    var S = sess.state, ch = sess.challenge, res = S.result || {};
    var age = Math.max(0, t - num(S.doneT, t)), k = smoothstep(age / 0.35);
    var w = Math.min(460, W - 40), h = 150, x = W / 2 - w / 2, y = H * 0.5 - h / 2;
    ctx.save();
    alpha(ctx, k);
    ctx.translate(W / 2, y + h / 2); ctx.scale(0.92 + 0.08 * k, 0.92 + 0.08 * k); ctx.translate(-W / 2, -(y + h / 2));
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 30;
    ctx.fillStyle = 'rgba(12,13,18,0.94)'; rr(ctx, x, y, w, h, 14); ctx.fill();
    ctx.shadowBlur = 0;
    var M = S.medal ? MEDAL_INFO[S.medal] : null;
    ctx.strokeStyle = M ? hexA(M.color, 0.7) : S.failed ? 'rgba(255,90,90,0.6)' : 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1.5;
    rr(ctx, x + 0.75, y + 0.75, w - 1.5, h - 1.5, 14); ctx.stroke();
    var mx = x + 70, my = y + h / 2;
    if (M) drawMedal(ctx, mx, my, 38, S.medal, true, t);
    else {
      ctx.strokeStyle = S.failed ? '#ff5a5a' : 'rgba(255,255,255,0.4)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(mx, my, 34, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mx - 13, my - 13); ctx.lineTo(mx + 13, my + 13); ctx.moveTo(mx + 13, my - 13); ctx.lineTo(mx - 13, my + 13); ctx.stroke();
    }
    var tx = x + 132;
    var title = S.failed ? 'FAILED' : M ? M.label.toUpperCase() : 'NO MEDAL';
    if (ch.license) title += res.passed ? ' · TEST PASSED' : ' · TEST FAILED';
    text(ctx, ch.name.toUpperCase(), tx, y + 34, '800 10px ' + FONT, 'rgba(255,255,255,0.55)', 'left');
    text(ctx, title, tx, y + 62, '900 22px ' + FONT, M ? M.color : S.failed ? '#ff6b6b' : '#ffffff', 'left');
    text(ctx, formatScore(ch, S.score, S.units), tx, y + 92, '800 20px ' + MONO, '#ffffff', 'left');
    text(ctx, (S.reason || '') + (S.coneHits ? ' · ' + S.coneHits + ' cone' + (S.coneHits > 1 ? 's' : '') : ''), tx, y + 114, '600 11px ' + FONT, 'rgba(255,255,255,0.65)', 'left');
    var nm = nextMedal(S.score, sess.medals);
    if (nm && !S.failed) text(ctx, 'Next: ' + MEDAL_INFO[nm.medal].label + ' at ' + formatScore(ch, nm.target, S.units), tx, y + 132, '600 10.5px ' + FONT, 'rgba(255,255,255,0.45)', 'left');
    ctx.restore();
  }

  function drawSessionOverlay(ctx, snap, sess, o) {
    if (!ctx || !sess || !sess.state) return;
    var S = sess.state, sz = canvasSize(ctx, o), W = sz.W, H = sz.H, t = num(S.lastT, 0);
    var car = playerOf(snap);
    ctx.save();
    try {
      var cam = o.camera || sess.getCamera();
      var P = cameraProjector(cam, W, H);
      var hasWorld = sess.course.cones.length || sess.course.zones.length || sess.course.lines.length || sess.course.gates.length;
      if (P && hasWorld && o.world !== false) drawWorldObjects(ctx, sess, P, o);
      else if (hasWorld && o.radar !== false && car) drawRadar(ctx, sess, car, W, H, o);
      var bottom = o.panel === false ? num(o.top, 12) : drawPanel(ctx, sess, W, H, t, o);
      if (sess.challenge.kind === 'drift' && S.k && S.k.scorer) drawDriftWidget(ctx, S.k.scorer.state, sess, W, H, t, bottom);
      else drawPopups(ctx, S, W, H, t);
      if (S.phase === 'staged' && o.tips !== false) drawStaging(ctx, sess, W, H, t);
      if (S.done && o.banner !== false) drawBanner(ctx, sess, W, H, t);
    } finally { ctx.restore(); }
  }

  /** Module-level entry: drawOverlay(ctx, snapshot, state, opts) — state is a challenge session (or its .state). */
  var liveSessions = [];
  function drawOverlay(ctx, snapshot, state, opts) {
    var sess = null;
    if (state && typeof state.evaluate === 'function' && state.course) sess = state.session ? state.session() : state;
    else if (state && state.id) for (var i = 0; i < liveSessions.length; i++) if (liveSessions[i].state === state) { sess = liveSessions[i]; break; }
    if (!sess && liveSessions.length && !state) sess = liveSessions[liveSessions.length - 1];
    if (!sess) {   // stand-alone drift widget for a bare drift scorer state
      if (state && isNum(state.multiplier) && isNum(state.chainRaw)) {
        var sz = canvasSize(ctx, opts || {});
        drawDriftWidget(ctx, state, { state: { k: { scorer: { options: DRIFT_DEFAULTS } } } }, sz.W, sz.H, num(state.t, 0), num(opts && opts.top, 12));
      }
      return;
    }
    return drawSessionOverlay(ctx, snapshot, sess, opts || {});
  }

  /* ======================================================================
     Progress, rewards & licences
     profile.challenges[id] = { best, medal, attempts, passes, lastScore, lastMedal, classId, pi, at, firstAt, history:[…≤10] }
     profile.licenses[id]   = { earnedAt, medals:{testId: medal} }
     ====================================================================== */
  function isBetterScore(ch, a, b) {           // is a better than b?
    if (!isNum(a)) return false;
    if (!isNum(b)) return true;
    return ch && ch.higherIsBetter === false ? a < b : a > b;
  }
  function records(profile) {
    if (!profile) return {};
    if (!isObj(profile.challenges)) profile.challenges = {};
    return profile.challenges;
  }
  function bestFor(profile, id) {
    var r = profile && isObj(profile.challenges) ? profile.challenges[id] : null;
    return r ? { score: r.best, medal: r.medal || null, attempts: r.attempts || 0, passes: r.passes || 0, lastScore: r.lastScore, classId: r.classId || null, at: r.at || null } : null;
  }
  /** Credits/xp for going from prevMedal to medal: every newly reached tier pays out once. */
  function rewardsFor(id, medal, prevMedal) {
    var ch = typeof id === 'string' ? get(id) : id;
    var from = medalRank(prevMedal), to = medalRank(medal), out = { credits: 0, xp: 0, breakdown: [] };
    var mult = ch && ch.category === 'license' ? 0.6 : 1 + (num(ch && ch.difficulty, 2) - 2) * 0.12;
    ['bronze', 'silver', 'gold', 'platinum'].forEach(function (m) {
      var rk = medalRank(m);
      if (rk <= from || rk > to) return;
      var c = Math.round(REWARDS[m].credits * mult / 50) * 50, x = Math.round(REWARDS[m].xp * mult);
      out.credits += c; out.xp += x;
      out.breakdown.push({ label: MEDAL_INFO[m].label + ' medal', medal: m, credits: c, xp: x });
    });
    if (to === 0) { out.xp += 25; out.breakdown.push({ label: 'Attempt', credits: 0, xp: 25 }); }
    return out;
  }
  function licenseDef(id) { for (var i = 0; i < LICENSES.length; i++) if (LICENSES[i].id === id) return LICENSES[i]; return null; }
  function hasLicense(profile, id) {
    if (!id) return true;
    if (profile && isObj(profile.licenses) && profile.licenses[id]) return true;
    var L = licenseDef(id);
    if (!L) return false;
    var recs = profile && isObj(profile.challenges) ? profile.challenges : {};
    return L.tests.every(function (t) { return medalRank(recs[t] && recs[t].medal) >= medalRank(L.passMedal); }) && hasLicense(profile, L.requires);
  }
  /** [{ id, name, color, earned, available, tests:[{id, name, medal, passed, best}], passed, total, reward, requires }] */
  function licenseStatus(profile) {
    return LICENSES.map(function (L) {
      var tests = L.tests.map(function (tid) {
        var ch = get(tid), b = bestFor(profile, tid);
        return { id: tid, name: ch.name, desc: ch.desc, kind: ch.kind, medal: b ? b.medal : null, best: b ? b.score : null,
          bestText: b ? formatScore(ch, b.score) : '—', passed: !!b && medalRank(b.medal) >= medalRank(L.passMedal) };
      });
      var passed = tests.filter(function (t) { return t.passed; }).length;
      var golds = tests.filter(function (t) { return medalRank(t.medal) >= 3; }).length;
      return { id: L.id, name: L.name, desc: L.desc, color: L.color, reward: clone(L.reward), requires: L.requires,
        earned: hasLicense(profile, L.id), available: hasLicense(profile, L.requires), tests: tests, passed: passed, total: tests.length,
        golds: golds, allGold: golds === tests.length,
        earnedAt: profile && isObj(profile.licenses) && profile.licenses[L.id] ? profile.licenses[L.id].earnedAt : null };
    });
  }
  function isUnlocked(profile, id) {
    var ch = typeof id === 'string' ? get(id) : id;
    if (!ch) return false;
    var req = ch.requires;
    if (!req) return true;
    if (typeof req === 'string') return hasLicense(profile, req);
    if (req.license && !hasLicense(profile, req.license)) return false;
    if (isNum(req.level) && num(profile && profile.level, 1) < req.level) return false;
    return true;
  }
  function lockReason(profile, id) {
    var ch = typeof id === 'string' ? get(id) : id;
    if (!ch || isUnlocked(profile, ch)) return null;
    var req = ch.requires, lic = typeof req === 'string' ? req : req && req.license;
    if (lic && !hasLicense(profile, lic)) return 'Requires the ' + (licenseDef(lic) ? licenseDef(lic).name : lic + ' licence');
    if (req && isNum(req.level)) return 'Requires level ' + req.level;
    return 'Locked';
  }

  /** Store a session result into a (mutable) profile object. Does not move credits — see applyRewardsTo / session.commit. */
  function recordResult(profile, id, result) {
    var ch = typeof id === 'string' ? get(id) : id;
    if (!ch || !profile || !result) return null;
    var recs = records(profile), prev = recs[ch.id] || null;
    var prevMedal = prev ? prev.medal || null : null, prevBest = prev ? prev.best : null;
    var score = isNum(result.score) && !result.failed ? result.score : (ch.kind === 'drift' && isNum(result.score) ? result.score : null);
    var medal = result.failed ? null : (result.medal || null);
    var improved = isBetterScore(ch, score, prevBest);
    // 'completed' = any non-failed result ever recorded; legacy records lack the flag, so infer it.
    var prevCompleted = !!(prev && (prev.completed || prev.medal || num(prev.passes, 0) > 0 ||
      (Array.isArray(prev.history) && prev.history.some(function (h) { return h && !h.failed; }))));
    var rec = prev ? prev : { best: null, medal: null, attempts: 0, passes: 0, history: [], firstAt: Date.now() };
    rec.attempts = num(rec.attempts, 0) + 1;
    if (result.passed) rec.passes = num(rec.passes, 0) + 1;
    if (!result.failed || prevCompleted) rec.completed = true;
    rec.lastScore = score; rec.lastMedal = medal; rec.at = Date.now();
    if (improved) { rec.best = score; rec.classId = result.classId || null; rec.pi = result.pi || null; }
    rec.medal = betterMedal(medal, prevMedal);
    if (!Array.isArray(rec.history)) rec.history = [];
    rec.history.push({ score: score, medal: medal, failed: !!result.failed, classId: result.classId || null, at: rec.at });
    if (rec.history.length > 10) rec.history.splice(0, rec.history.length - 10);
    recs[ch.id] = rec;

    var rewards = rewardsFor(ch, rec.medal, prevMedal);
    // stats
    if (!isObj(profile.stats)) profile.stats = {};
    var st = profile.stats;
    if (!prevCompleted && !result.failed) st.challengesCompleted = num(st.challengesCompleted, 0) + 1;
    if (ch.kind === 'drift' && isNum(score)) st.driftScoreBest = Math.max(num(st.driftScoreBest, 0), score);
    if (ch.kind === 'topspeed' && isNum(score)) st.topSpeed_kph = Math.max(num(st.topSpeed_kph, 0), score);
    // licence
    var licenseEarned = null;
    if (ch.license) {
      if (!isObj(profile.licenses)) profile.licenses = {};
      var already = !!profile.licenses[ch.license];
      if (!already && hasLicense(profile, ch.license)) {
        var L = licenseDef(ch.license), medals = {};
        L.tests.forEach(function (t) { medals[t] = recs[t] ? recs[t].medal : null; });
        profile.licenses[ch.license] = { earnedAt: Date.now(), medals: medals };
        licenseEarned = { id: L.id, name: L.name, reward: clone(L.reward) };
        rewards.credits += L.reward.credits; rewards.xp += L.reward.xp;
        rewards.breakdown.push({ label: L.name + ' earned', credits: L.reward.credits, xp: L.reward.xp });
      }
    }
    return { id: ch.id, improved: improved, prevBest: prevBest, best: rec.best, prevMedal: prevMedal, medal: rec.medal,
      newMedal: medalRank(rec.medal) > medalRank(prevMedal), rewards: rewards, licenseEarned: licenseEarned, record: clone(rec) };
  }
  function applyRewardsTo(profile, rewards) {
    if (!profile || !rewards) return profile;
    profile.credits = num(profile.credits, 0) + num(rewards.credits, 0);
    profile.xp = num(profile.xp, 0) + num(rewards.xp, 0);
    if (isObj(profile.stats) && rewards.credits) profile.stats.creditsEarned = num(profile.stats.creditsEarned, 0) + rewards.credits;
    return profile;
  }
  /** Overview for menus: every challenge with best, medal ladder (optionally for a build), lock state. */
  function overview(profile, build) {
    return all().map(function (ch) {
      var b = bestFor(profile, ch.id), m = build ? safe(function () { return challengeMedals(ch, build); }, null) : null;
      return { id: ch.id, name: ch.name, desc: ch.desc, kind: ch.kind, category: ch.category, license: ch.license, unit: ch.unit,
        difficulty: ch.difficulty, unlocked: isUnlocked(profile, ch), lockReason: lockReason(profile, ch), best: b ? b.score : null,
        bestText: b ? formatScore(ch, b.score) : '—', medal: b ? b.medal : null, attempts: b ? b.attempts : 0, medals: m };
    });
  }

  /* ======================================================================
     Launching through the unified router (UNIFY-SPEC)
       launchSpec(id, build?, opts?) -> {route:'race'|'drift', params, session}   (pure: builds the challenge session)
       launch(id, opts?)            -> bool   CB.router.go(route, params) — drift challenges run as CB.race.drift
                                              'trial' sessions on #/drift; results are recorded (unless opts.onResult /
                                              opts.record === false) and the player returns to the originating screen.
       resultFromSession(session, results) -> challenge result (session.result(), results.challenge*, or drift scorer total)
     ====================================================================== */
  var ASSIST_LEVELS = ['off', 'light', 'medium', 'heavy', 'auto'];
  function stateBuild() {
    var S = CB.state;
    if (S && typeof S.get === 'function') { var b = safe(function () { return S.get(); }, null); if (isObj(b)) return b; }
    return null;
  }
  function launchSpec(id, build, opts) {
    opts = opts || {};
    var ch = isObj(id) && id.kind ? id : get(id);
    if (!ch) return null;
    build = build || opts.build || stateBuild() || referenceBuild();   // UNIFY-SPEC: the configurator's current build
    var sess = createChallengeSession(ch, build, opts.session || {});
    var cfg = assign({}, sess.cfg, { challenge: sess });
    var drift = ch.kind === 'drift';
    var route = drift ? 'drift' : 'race';
    var assist = typeof opts.assist === 'string' && ASSIST_LEVELS.indexOf(opts.assist) >= 0 ? opts.assist : null;
    var settings = { discipline: route, graphics: '3d', mode: cfg.mode, trackId: cfg.trackId, laps: cfg.laps, opponents: 0,
      weather: cfg.weather, timeOfDay: cfg.timeOfDay };
    if (assist) settings.steerAssist = assist;
    var ctxObj = { kind: 'challenge', challengeId: ch.id, label: ch.name, session: sess };
    var params = {
      kind: 'challenge', source: 'challenges', challengeId: ch.id, label: ch.name, cfg: cfg, build: build, session: sess, challenge: sess,
      context: ctxObj, settings: settings, trackId: cfg.trackId, discipline: route, mode: drift ? 'trial' : cfg.mode, assist: assist,
      returnTo: opts.returnTo || null, returnParams: opts.returnParams || { challengeId: ch.id }
    };
    if (drift) {
      var dur = num(sess.rules && sess.rules.timeLimit_s, 90);
      params.drift = { trackId: cfg.trackId, mode: 'trial', build: build, playerBuild: build, duration_s: dur, timeOfDay: cfg.timeOfDay,
        weather: cfg.weather, seed: cfg.seed, tune: opts.tune || 'street', medals: clone(sess.medals), challengeId: ch.id };
      if (assist) params.drift.assist = assist;
      settings.driftMode = 'trial'; settings.driftTrackId = cfg.trackId; settings.driftDuration = dur;
    }
    return { route: route, params: params, session: sess };
  }

  /** Challenge result for a finished race / drift session. */
  function resultFromSession(sess, results) {
    results = results || {};
    if (isObj(results.challengeResult)) return results.challengeResult;
    var own = sess && typeof sess.result === 'function' ? sess.result() : null;
    var ch = sess && sess.challenge;
    var d = isObj(results.drift) ? results.drift : null;
    if (ch && ch.kind === 'drift' && d && isNum(d.total) && !(own && isNum(own.score) && own.score > 0)) {
      // CB.race.drift session (#/drift): the drift scorer's total, judged against this challenge's car-scaled ladder
      var score = Math.max(0, Math.round(d.total)), medal = medalFor(score, sess.medals);
      var an = sess.analysis || {};
      return { id: ch.id, name: ch.name, kind: 'drift', category: ch.category, license: ch.license, trackId: results.trackId || sess.cfg.trackId,
        score: score, scoreText: formatScore(ch, score), unit: ch.unit, higherIsBetter: true, medal: medal,
        medalLabel: medal ? MEDAL_INFO[medal].label : 'No medal', passed: medalRank(medal) >= medalRank(ch.passMedal || 'bronze'), failed: false,
        medals: clone(sess.medals), elapsed_s: num(results.elapsed_s, num(d.duration_s, 0)), crashes: num(d.crashes, 0),
        classId: an.cls ? an.cls.id : null, pi: an.pi || null, at: Date.now(),
        drift: { score: score, combo: num(d.maxCombo, 1), bestChain: num(d.bestDrift, 0), duration_s: num(d.longestDrift_s, 0) } };
    }
    if (own) return own;
    if (isObj(results.challenge) && isNum(results.challenge.score)) return results.challenge;
    if (sess && typeof sess.evaluate === 'function') {
      var ev = safe(function () { return sess.evaluate(results.snapshot || results.lastSnapshot || results); }, null);
      if (ev && (ev.done || ev.failed)) return sess.result() || ev;
      if (typeof sess.abort === 'function') return safe(function () { return sess.abort('Session ended'); }, ev);
      return ev;
    }
    return null;
  }

  /** Persist a challenge result into the shared profile (records, licences, medal-upgrade rewards, achievements). */
  function commitResult(id, res) {
    var ch = typeof id === 'string' ? get(id) : id;
    if (!ch || !res) return null;
    var P = profileMod(), out = null;
    if (P) out = safe(function () { return P.update(function (p) { return recordResult(p, ch.id, res); }, { reason: 'challenge' }); }, null);
    if (out && P && (out.rewards.credits || out.rewards.xp)) {
      safe(function () {
        if (typeof P.award === 'function') P.award({ credits: out.rewards.credits, xp: out.rewards.xp, reason: 'Challenge · ' + ch.name, category: 'challenge' });
        else { if (P.addCredits) P.addCredits(out.rewards.credits, 'Challenge · ' + ch.name); if (P.addXp) P.addXp(out.rewards.xp); }
      });
    }
    var A = achievementsMod(), unlocked = [];
    if (A) {
      unlocked = unlocked.concat(safe(function () { return A.check(null, { type: 'challenge', id: ch.id, medal: res.medal, score: res.score, passed: res.passed }); }, []) || []);
      if (res.drift) unlocked = unlocked.concat(safe(function () { return A.check(null, { type: 'drift', score: res.drift.score, combo: res.drift.combo, duration_s: res.drift.duration_s }); }, []) || []);
    }
    if (out) { out.achievements = unlocked; out.result = res; }
    return out;
  }

  /** launch(id, opts {build, assist, returnTo, returnParams, onResult, record, onFinish, onClose}) -> bool */
  function launch(id, opts) {
    opts = opts || {};
    var spec = safe(function () { return launchSpec(id, opts.build, opts); }, null);
    if (!spec) return false;
    var p = spec.params, sess = spec.session;
    if (typeof opts.onFinish === 'function') p.onFinish = opts.onFinish;
    if (typeof opts.onClose === 'function') p.onClose = opts.onClose;
    var onResult = typeof opts.onResult === 'function' ? opts.onResult : opts.record === false ? null : function (results) {
      var res = resultFromSession(sess, results);
      var out = res ? commitResult(p.challengeId, res) : null;
      if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
        safe(function () { document.dispatchEvent(new CustomEvent('cb:challenge-result', { detail: { challengeId: p.challengeId, result: res, outcome: out } })); });
      }
      return out;
    };
    var L = CB.game && CB.game.career && CB.game.career.launcher;
    if (L && typeof L.dispatch === 'function') return L.dispatch(spec.route, p, { onResult: onResult, once: true });
    // career module absent: plain router hand-off (results still flow through params.onFinish)
    var R = CB.router;
    if (!R || typeof R.go !== 'function') return false;
    var userFinish = p.onFinish, done = false;
    p.onFinish = function (results) {
      if (done) return; done = true;
      var out = onResult ? safe(function () { return onResult(results); }, null) : null;
      if (typeof userFinish === 'function') safe(function () { userFinish(results, out); });
    };
    p.returnTo = p.returnTo || 'challenges';
    return safe(function () { R.go(spec.route, p); return true; }, false);
  }

  /* ======================================================================
     Exports
     ====================================================================== */
  var api = {
    list: LIST, catalog: LIST, licenses: LICENSES, licenseTests: LICENSE_TESTS, byId: BY_ID, kinds: KINDS,
    all: all, get: get, MEDALS: MEDALS.slice(), MEDAL_INFO: MEDAL_INFO, CLASSES: CLASSES, REWARDS: REWARDS, DRIFT_DEFAULTS: DRIFT_DEFAULTS,
    trackDefs: trackDefs, challengeTrack: challengeTrack, resolveTrackDef: resolveTrackDef,
    registerTracks: registerTracks, unregisterTracks: unregisterTracks, isRegistered: function () { return registered; },
    analyze: analyze, performanceClass: performanceClass, medalsFor: challengeMedals, medalFor: medalFor, nextMedal: nextMedal,
    medalRank: medalRank, formatScore: formatScore,
    createChallengeSession: createChallengeSession, createSession: createChallengeSession,
    createDriftScorer: createDriftScorer, drawOverlay: drawOverlay,
    recordResult: recordResult, applyRewards: applyRewardsTo, bestFor: bestFor, best: bestFor, getBest: bestFor,
    rewardsFor: rewardsFor, licenseStatus: licenseStatus, hasLicense: hasLicense, isUnlocked: isUnlocked, lockReason: lockReason,
    overview: overview, launchSpec: launchSpec, launch: launch, resultFromSession: resultFromSession, commitResult: commitResult,
    _internal: { driftAngleFactor: driftAngleFactor, driftSpeedFactor: driftSpeedFactor, driftGrade: driftGrade, slipAngleOf: slipAngleOf,
      ladder: ladder, classFor: classFor, crossFrac: crossFrac, miniTurtle: miniTurtle, TRACK_SPECS: TRACK_SPECS, liveSessions: liveSessions,
      cameraProjector: cameraProjector, stagingS: stagingS, straightEnd: straightEnd }
  };
  CB.game.challenges = api;

  // In the browser the special layouts register themselves (the race menu / hub can then select them).
  if (typeof window !== 'undefined' && typeof document !== 'undefined') safe(function () { registerTracks(); });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.game.challenges;

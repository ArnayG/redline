/* ==========================================================================
   FORGE Atelier — js/game/career.js
   CB.game.career : the career mode. Five tiers of championships, special events,
   named rivals with storylines, persistent AI standings, points & tiebreakers,
   trophies and progression unlocks.

   Pure module (no DOM). Loads in the browser (classic script) and in Node.
   Every dependency is feature-detected with an internal fallback:
     CB.game.profile   persistence / award()          (else: the passed profile object is mutated)
     CB.game.economy   raceRewards / entryFee / carCost (else: own reward + price estimate)
     CB.race.tracks    track list / build / speedProfile (else: placeholder track ids)
     CB.race.ai        DRIVERS / TEAMS / createGrid     (else: built-in roster + plain opponents)
     CB.physics        compute(build) metrics           (else: CB.race.ai.heuristicMetrics, else own estimate)
     CB.game.achievements.check                         (only when opts.achievements === true)

   ---------------------------------------------------------------- API
   Data
     catalog                       { tiers, championships (flat, incl. special events), events, rivals,
                                     pointsSystems, eventTypes, trackAliases, byId }
     getTier(id|index), getChampionship(id), getRival(id), listChampionships(filter?)
     POINTS_SYSTEMS, EVENT_TYPES, RIVALS, TIERS
   State
     defaultState(seed?)           fresh career state (stored in profile.career)
     state(profile)                computed view: tiers / championships with status, eligibility, standings,
                                   trophies, rivals, totals, nextGoal
     isUnlocked(profile, id)       championship / event / tier unlock check -> {ok, reasons[]}
     checkEligibility(build, champ, opts?) -> {ok, reasons[], checks[], metrics}
     enter(profile, champId, opts?)        -> {ok, reason?, fee, profile}
     withdraw(profile, champId, opts?)     -> {ok}
     restart(profile, champId, opts?)      -> {ok, season}
     nextRound(profile, champId)           -> {champId, roundIdx, round, season, isFinal, ...} | null
     calendar(profile, champId)            -> rounds with date labels, status and results
     briefing(profile, champId, roundIdx?) -> pre-race briefing (text, rival line, stakes, standings)
     standings(profile, champId)           -> sorted standings rows
     trophies(profile)                     -> trophy cabinet
   Racing
     raceConfigFor(profile, champId, roundIdx?, opts?) -> CB.race.engine.createSession cfg (+ extras, career meta)
     launchSpec(profile, champId, roundIdx?, opts?) -> {route:'race'|'drift', params} for CB.router.go (drift rounds -> #/drift)
     launch(champId, roundIdx?, opts?)     -> bool: CB.router.go(route, params); records the result, returns to the origin screen
     openAtelier(mode, opts?)              -> bool: CB.router.go('atelier', {mode:'career-buy'|'career-upgrade', onConfirm, ...})
     launcher {dispatch, career, race, drift, atelier, current}   unified launch helpers (quick race / quick drift too)
     recordResult(profile, champId, roundIdx, results, opts?)
        -> {pointsTable, standings, rewards, championshipComplete, trophy, position, roundPosition,
            rival, unlocked, nextRound, events, profile, career, levelUp}
     skipRound(profile, champId, opts?)    -> recordResult with a DNS for the player (AI simulated)
   Simulation (pure, deterministic)
     simulateRound(champ, roundIdx, field, seed, opts?) -> order rows
     simulateSeason(champId, seed, opts?)  -> full AI-only season (preview / testing)
     pointsFor(system, position, flags)    -> number
     sortStandings(rows)                   -> rows sorted with tiebreakers
     estimateLapTime(trackId, perf)        -> seconds (track speedProfile or heuristic)
     rivalLine(rivalId, situation, ctx?)   -> dialog string
     resolveTrackId(id)                    -> id present in CB.race.tracks.list (alias / fallback)

   Track ids are the CB.race.tracks.list ids (forge-speedway, porto-vecchio, forge-ring, akagane-pass,
   little-anvil, neon-harbour, ouroboros). Placeholder aliases ('speedway', 'street', 'touge', 'kart',
   'night-city', 'figure-8', 'drag-strip' ...) are resolved at runtime if the race module is absent or
   registers different tracks (challenge layouts registered later, e.g. a drag strip, are preferred).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.game = CB.game || {};

CB.game.career = (function () {
  'use strict';

  /* ======================================================================
     Small utilities
     ====================================================================== */
  var VERSION = 1;
  var hasOwn = Object.prototype.hasOwnProperty;
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { var n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return isNum(n) ? n : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return clamp(v, 0, 1); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function round(v, step) { step = step || 1; return Math.round(v / step) * step; }
  function clone(o) {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(clone);
    var out = {};
    for (var k in o) if (hasOwn.call(o, k) && typeof o[k] !== 'function') out[k] = clone(o[k]);
    return out;
  }
  function get(o, path, d) {
    var parts = String(path).split('.');
    for (var i = 0; i < parts.length; i++) { if (o == null) return d; o = o[parts[i]]; }
    return o === undefined ? d : o;
  }
  function slug(s) {
    return String(s || '').toLowerCase().normalize ? String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      : String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }
  function hashStr(s) {
    s = String(s);
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function makeRng(seed) {
    var a = (typeof seed === 'number' ? seed : hashStr(seed)) >>> 0;
    function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return {
      next: next,
      range: function (lo, hi) { return lo + (hi - lo) * next(); },
      int: function (lo, hi) { return lo + Math.floor(next() * (hi - lo + 1)); },
      pick: function (arr) { return arr[Math.floor(next() * arr.length)]; },
      chance: function (p) { return next() < p; },
      gauss: function () { var u = Math.max(1e-9, next()), v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); },
      shuffle: function (arr) {
        var c = arr.slice();
        for (var i = c.length - 1; i > 0; i--) { var j = Math.floor(next() * (i + 1)); var t = c[i]; c[i] = c[j]; c[j] = t; }
        return c;
      }
    };
  }
  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function fmtTime(t) {
    if (!isNum(t)) return '--:--.---';
    var m = Math.floor(t / 60), s = t - m * 60;
    return (m > 0 ? m + ':' + (s < 10 ? '0' : '') : '') + s.toFixed(3);
  }
  function fmtCredits(n) {
    var E = economy();
    if (E && typeof E.formatCredits === 'function') { try { return E.formatCredits(n); } catch (e) { /* fall through */ } }
    return 'CR ' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fill(tpl, ctx) {
    return String(tpl).replace(/\{(\w+)\}/g, function (m, k) { return ctx && ctx[k] != null ? String(ctx[k]) : m; });
  }
  function now() { return Date.now(); }

  /* ======================================================================
     Soft dependencies
     ====================================================================== */
  function profileMod() { return CB.game && CB.game.profile && typeof CB.game.profile.update === 'function' ? CB.game.profile : null; }
  function economy() { return CB.game && CB.game.economy ? CB.game.economy : null; }
  function tracksMod() { return CB.race && CB.race.tracks ? CB.race.tracks : null; }
  function aiMod() { return CB.race && CB.race.ai ? CB.race.ai : null; }

  function xpForLevel(l) { return Math.round(1000 * Math.pow(l, 1.6)); }
  function levelForXp(xp) {
    var P = profileMod();
    if (P && typeof P.levelForXp === 'function') { try { return P.levelForXp(xp); } catch (e) { /* fall through */ } }
    var E = economy();
    if (E && typeof E.levelForXp === 'function') { try { return E.levelForXp(xp); } catch (e2) { /* fall through */ } }
    // cumulative curve: reaching level l+1 costs xpForLevel(l) on top of everything before it
    var l = 1, acc = 0;
    while (l < 100 && acc + xpForLevel(l) <= xp) { acc += xpForLevel(l); l++; }
    return l;
  }
  function profileLevel(p) { return Math.max(1, Math.round(num(p && p.level, p && isNum(p.xp) ? levelForXp(p.xp) : 1))); }

  /* ----------------------------------------------------------- metrics */
  var STYLE_WEIGHT = { coupe: 1420, sedan: 1520, hatchback: 1250, wagon: 1580, suv: 1950, roadster: 1250, pickup: 2100, hypercar: 1250, 'shooting-brake': 1550, van: 2200 };
  var ASP_MULT = { na: 1, turbo: 1.35, 'twin-turbo': 1.45, 'quad-turbo': 1.6, supercharged: 1.35, twincharged: 1.5, 'electric-turbo': 1.42 };
  var COMPOUND_MU = { eco: 0.78, 'all-season': 0.85, winter: 0.8, touring: 0.92, performance: 1.02, 'super-sport': 1.1, track: 1.22, slick: 1.38 };

  function ownMetrics(b) {
    b = b || {};
    var e = b.engine || {}, hp = 0;
    if (e.type !== 'ev') {
      var asp = ASP_MULT[e.aspiration] || 1;
      hp = num(e.displacement_l, 2) * 92 * asp * Math.pow(num(e.redline_rpm, 7000) / 7000, 0.6);
      hp *= { eco: 0.9, stock: 1, stage1: 1.1, stage2: 1.2, stage3: 1.32, 'time-attack': 1.45 }[e.tune] || 1;
      if (e.fuel === 'diesel') hp *= 0.78;
    }
    if (e.type === 'ev' || e.type === 'hybrid') hp += num(e.motors, 1) * num(e.motorPower_kw, 150) * 1.341 * (e.type === 'ev' ? 0.92 : 0.75);
    var style = get(b, 'body.style', 'coupe');
    var w = STYLE_WEIGHT[style] || 1450;
    if (e.type === 'ev') w += num(e.battery_kwh, 80) * 5.5;
    if (e.type === 'hybrid') w += 120;
    w += num(get(b, 'weight.ballast_kg'), 0);
    return { power_hp: hp, weight_kg: w, source: 'career-estimate' };
  }

  /** Metrics for a build: CB.physics -> CB.race.ai.heuristicMetrics -> own estimate. Never throws. */
  function metricsFor(build, given) {
    if (isObj(given) && isNum(given.power_hp) && isNum(given.weight_kg)) return given;
    if (!isObj(build)) return { power_hp: 0, weight_kg: 0, source: 'none' };
    var m = null;
    if (CB.physics && typeof CB.physics.compute === 'function') { try { m = CB.physics.compute(build); } catch (e) { m = null; } }
    if (!(m && isNum(m.power_hp) && isNum(m.weight_kg))) {
      var A = aiMod();
      if (A && typeof A.heuristicMetrics === 'function') { try { m = A.heuristicMetrics(build); } catch (e2) { m = null; } }
    }
    if (!(m && isNum(m.power_hp) && isNum(m.weight_kg))) m = ownMetrics(build);
    return m;
  }

  /** Price of a build in career credits (economy.carCost, else MSRP-ish estimate × 0.35). */
  function careerPrice(build) {
    var E = economy();
    if (E && typeof E.carCost === 'function') { try { var c = E.carCost(build); if (isNum(c)) return c; } catch (e) { /* fall through */ } }
    if (CB.pricing && typeof CB.pricing.compute === 'function') {
      try { var pr = CB.pricing.compute(build); if (pr && isNum(pr.total)) return round(pr.total * 0.35, 100); } catch (e2) { /* fall through */ }
    }
    var m = metricsFor(build);
    return round((25000 + m.power_hp * 180) * 0.35, 100);
  }

  /* ======================================================================
     Tracks
     ====================================================================== */
  var TRACK_ALIASES = {
    'speedway': ['forge-speedway'], 'oval': ['forge-speedway'],
    'street': ['porto-vecchio', 'neon-harbour'], 'porto': ['porto-vecchio'],
    'gp': ['forge-ring'], 'forge-ring': ['forge-ring'],
    'touge': ['akagane-pass'], 'mountain': ['akagane-pass'],
    'kart': ['little-anvil'], 'karting': ['little-anvil'],
    'night-city': ['neon-harbour'], 'night': ['neon-harbour'],
    'figure-8': ['ouroboros'], 'figure8': ['ouroboros'],
    // Drag strip: prefer the 2.4 km Proving Strip runway (challenges module), else the speedway front stretch.
    // The run itself is cut to extras.drag.distance_m by the career session hooks (see careerHooks).
    'drag-strip': ['drag-strip', 'quarter-mile', 'challenge-strip', 'challenge-top-speed', 'forge-speedway'],
    'skidpad': ['drift-arena', 'challenge-drift', 'akagane-pass']
  };
  // Profile of each known track (used when CB.race.tracks is unavailable, and for the lap estimator fallback).
  var TRACK_INFO = {
    'forge-speedway': { name: 'Redline Motor Speedway', length_m: 3007, difficulty: 1, avg: 54, timeOfDay: 'day', tags: ['high-speed'] },
    'porto-vecchio': { name: 'Porto Vecchio Street Circuit', length_m: 2629, difficulty: 4, avg: 31, timeOfDay: 'day', tags: ['street', 'walls'] },
    'forge-ring': { name: 'Redline Ring Grand Prix Circuit', length_m: 5791, difficulty: 3, avg: 41, timeOfDay: 'day', tags: ['grand-prix'] },
    'akagane-pass': { name: 'Akagane Pass', length_m: 2903, difficulty: 5, avg: 27, timeOfDay: 'day', tags: ['touge'] },
    'little-anvil': { name: 'Little Anvil Kartodromo', length_m: 768, difficulty: 2, avg: 22, timeOfDay: 'day', tags: ['kart'] },
    'neon-harbour': { name: 'Neon Harbour Night Circuit', length_m: 3422, difficulty: 4, avg: 34, timeOfDay: 'night', tags: ['street', 'night'] },
    'ouroboros': { name: 'Ouroboros Figure-8', length_m: 2164, difficulty: 2, avg: 36, timeOfDay: 'day', tags: ['figure-8'] }
  };

  function trackList() {
    var T = tracksMod();
    if (!T) return [];
    var l = T.list;
    if (typeof l === 'function') { try { l = l(); } catch (e) { l = null; } }
    if (!Array.isArray(l) && Array.isArray(T.tracks)) l = T.tracks;
    return Array.isArray(l) ? l.filter(function (t) { return t && t.id; }) : [];
  }
  function trackDef(id) {
    var list = trackList();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  /** Resolve a career track id to one present in CB.race.tracks.list (or the id itself when absent). */
  function resolveTrackId(id) {
    var list = trackList();
    if (!list.length) {
      if (TRACK_INFO[id]) return id;
      var al = TRACK_ALIASES[id];
      return al ? al[al.length - 1] : id;
    }
    var ids = list.map(function (t) { return t.id; });
    if (ids.indexOf(id) >= 0) return id;
    var cands = TRACK_ALIASES[id] || [];
    for (var i = 0; i < cands.length; i++) if (ids.indexOf(cands[i]) >= 0) return cands[i];
    // fuzzy: alias key that contains the id or vice versa
    for (var k = 0; k < ids.length; k++) if (ids[k].indexOf(id) >= 0 || id.indexOf(ids[k]) >= 0) return ids[k];
    return ids[0];
  }
  function trackInfo(id) {
    var rid = resolveTrackId(id), def = trackDef(rid), base = TRACK_INFO[rid] || {};
    return {
      id: rid, requested: id, name: (def && def.name) || base.name || rid,
      short: (def && def.short) || (base.name ? base.name.split(' ')[0] : rid),
      country: def ? def.country : null, length_m: num(def && def.length_m, num(base.length_m, 3000)),
      difficulty: num(def && def.difficulty, num(base.difficulty, 3)),
      timeOfDay: (def && def.timeOfDay) || base.timeOfDay || 'day', tags: (def && def.tags) || base.tags || [],
      desc: def ? def.desc : '', available: !!def || !trackList().length
    };
  }

  /* ---------------------------------------------------------- lap time estimator */
  var geomCache = {};
  var lapCache = {};
  function geometry(id) {
    if (hasOwn.call(geomCache, id)) return geomCache[id];
    var T = tracksMod(), def = trackDef(id), g = null;
    if (T && def && typeof T.build === 'function') { try { g = T.build(def); } catch (e) { g = null; } }
    geomCache[id] = g;
    return g;
  }

  /**
   * estimateLapTime(trackId, perf {power_hp, weight_kg, mu?, downforce_kg_200?, cdA?}, opts {wet})
   * Uses the track's speedProfile (forward/backward pass) with a point-mass car model; otherwise a
   * heuristic from track average speed × power-to-weight. Ideal-driver time (no mistakes).
   */
  function estimateLapTime(trackId, perf, opts) {
    perf = perf || {};
    opts = opts || {};
    var id = resolveTrackId(trackId);
    var hp = clamp(num(perf.power_hp, 300), 40, 3000), kg = clamp(num(perf.weight_kg, 1400), 500, 4000);
    var mu = clamp(num(perf.mu, 1.0), 0.5, 1.8) * (opts.wet ? 0.78 : 1);
    var df = clamp(num(perf.downforce_kg_200, 0), 0, 2500), cdA = clamp(num(perf.cdA, 0.7), 0.3, 2);
    var key = [id, Math.round(hp / 10), Math.round(kg / 20), Math.round(mu * 50), Math.round(df / 20), Math.round(cdA * 20)].join('|');
    if (hasOwn.call(lapCache, key)) return lapCache[key];
    var g = geometry(id), t = null;
    if (g && typeof g.speedProfile === 'function') {
      try {
        var G = 9.81, P = hp * 745.7 * 0.86;
        var latFn = function (v) { return mu * (1 + df * Math.pow(v / 55.6, 2) / kg); };
        var accFn = function (v) {
          var traction = mu * G * 0.55 * (1 + df * Math.pow(v / 55.6, 2) / kg);
          var drive = P / (kg * Math.max(v, 4));
          var drag = 0.5 * 1.2 * cdA * v * v / kg + 0.012 * G;
          return Math.min(traction, drive) - drag;
        };
        var prof = g.speedProfile(latFn, function (v) { return latFn(v) * 1.05; }, accFn, { vMax: 115 });
        t = typeof g.lapTime === 'function' ? g.lapTime(prof) : null;
        if (!isNum(t)) {
          t = 0;
          for (var i = 0; i < prof.length; i++) t += (g.ds || 2) / Math.max(0.5, (prof[i] + prof[(i + 1) % prof.length]) / 2);
        }
      } catch (e) { t = null; }
    }
    if (!isNum(t) || t <= 0) {
      var info = trackInfo(id), base = TRACK_INFO[id] ? TRACK_INFO[id].avg : 40 - info.difficulty * 3;
      var p2w = hp / (kg / 1000);
      var avg = base * Math.pow(p2w / 250, 0.22) * Math.pow(mu, 0.35);
      t = info.length_m / Math.max(8, avg);
    }
    lapCache[key] = t;
    return t;
  }

  /** Quarter-mile ET (Hale formula) and trap speed from power/weight. */
  function estimateDragTime(perf, distance_m) {
    var lb = num(perf && perf.weight_kg, 1400) * 2.2046 + 180, hp = Math.max(40, num(perf && perf.power_hp, 300));
    var et = 5.825 * Math.pow(lb / hp, 1 / 3);
    var trap = 234 * Math.pow(hp / lb, 1 / 3) * 1.609;
    var d = num(distance_m, 402.336);
    if (Math.abs(d - 402.336) > 1) et *= Math.pow(d / 402.336, 0.72);
    var traction = { fwd: 1.04, rwd: 1.0, awd: 0.96 }[perf && perf.drivetrain] || 1;
    return { et_s: et * traction, trap_kph: trap };
  }

  /* ======================================================================
     Points systems & tiebreakers
     ====================================================================== */
  var POINTS_SYSTEMS = {
    f1: { id: 'f1', name: 'Grand Prix (25-18-15)', table: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], fastestLap: 1, fastestLapTopN: 10, pole: 0,
      desc: 'Top ten score 25-18-15-12-10-8-6-4-2-1. One bonus point for the fastest lap if you finish in the top ten.' },
    rookie: { id: 'rookie', name: 'Rookie Cup (20-15-12)', table: [20, 15, 12, 10, 8, 6, 4, 3, 2, 1], fastestLap: 1, fastestLapTopN: 10, pole: 0, finishPoint: 1,
      desc: 'Generous scoring for newcomers: 20-15-12-10-8-6-4-3-2-1, plus 1 point for finishing and 1 for the fastest lap.' },
    classic: { id: 'classic', name: 'Classic (10-8-6)', table: [10, 8, 6, 5, 4, 3, 2, 1], fastestLap: 0, pole: 0,
      desc: 'Old-school 10-8-6-5-4-3-2-1. No bonus points, no mercy.' },
    endurance: { id: 'endurance', name: 'Endurance (38-27-23)', table: [38, 27, 23, 18, 15, 12, 9, 6, 3, 2], fastestLap: 1, fastestLapTopN: 10, pole: 1,
      desc: 'Endurance scoring is 50% higher than Grand Prix: 38-27-23-18-15-12-9-6-3-2, 1 point for pole and 1 for the fastest lap.' },
    masters: { id: 'masters', name: 'Masters (25-18-15, double finale)', table: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], fastestLap: 1, fastestLapTopN: 10, pole: 1,
      finalRoundMultiplier: 2, desc: 'Grand Prix scoring with pole and fastest-lap bonuses. The season finale pays double points.' },
    drift: { id: 'drift', name: 'Drift Series (30-24-20)', table: [30, 24, 20, 16, 13, 10, 8, 6, 4, 2], fastestLap: 0, pole: 0, bestScoreBonus: 2,
      desc: 'Judged on drift score: 30-24-20-16-13-10-8-6-4-2, plus 2 points for the round\'s highest single-run score.' },
    attack: { id: 'attack', name: 'Time Attack (20-17-15)', table: [20, 17, 15, 13, 11, 9, 7, 5, 3, 1], fastestLap: 0, pole: 0,
      desc: 'Ranked on the best single lap of the session: 20-17-15-13-11-9-7-5-3-1.' },
    duel: { id: 'duel', name: 'Duel (win = 1)', table: [1, 0], fastestLap: 0, pole: 0, desc: 'One-on-one. Win the round, take the point. First to the majority wins the series.' },
    ladder: { id: 'ladder', name: 'Knockout ladder', table: [], fastestLap: 0, pole: 0, desc: 'Win your heat to advance. Lose once and you are out.' }
  };

  function systemOf(champ) {
    var s = champ && champ.pointsSystem;
    if (isObj(s)) return s;
    return POINTS_SYSTEMS[s] || POINTS_SYSTEMS.f1;
  }

  /** pointsFor(system, position, {fastestLap, pole, finished, dnf, isFinal, multiplier, bestScore}) */
  function pointsFor(system, position, flags) {
    var sys = isObj(system) ? system : (POINTS_SYSTEMS[system] || POINTS_SYSTEMS.f1);
    flags = flags || {};
    if (flags.dns) return 0;
    var pos = Math.round(num(position, 99)), pts = 0;
    if (!flags.dnf && pos >= 1 && pos <= sys.table.length) pts += sys.table[pos - 1];
    if (!flags.dnf && sys.finishPoint) pts += sys.finishPoint;
    if (!flags.dnf && flags.fastestLap && sys.fastestLap && pos <= (sys.fastestLapTopN || 99)) pts += sys.fastestLap;
    if (flags.pole && sys.pole) pts += sys.pole;
    if (!flags.dnf && flags.bestScore && sys.bestScoreBonus) pts += sys.bestScoreBonus;
    var mult = num(flags.multiplier, 1);
    if (flags.isFinal && sys.finalRoundMultiplier) mult *= sys.finalRoundMultiplier;
    return Math.round(pts * mult);
  }

  /**
   * Tiebreakers (FIA-style countback):
   *   1. points  2. wins  3. countback of 2nds, 3rds, ... 4. best finish in the most recent round
   *   5. fewer DNFs  6. lower average finish  7. id (stable, deterministic)
   */
  function compareStandings(a, b) {
    if (b.points !== a.points) return b.points - a.points;
    var fa = a.finishes || [], fb = b.finishes || [];
    // nobody has raced yet (new season / preview grid): a neutral order with the player on top, never a fake ranking
    if (!fa.length && !fb.length && !num(a.starts, 0) && !num(b.starts, 0) && (a.id === 'player') !== (b.id === 'player')) return a.id === 'player' ? -1 : 1;
    for (var p = 1; p <= 12; p++) {
      var ca = countPos(fa, p), cb = countPos(fb, p);
      if (ca !== cb) return cb - ca;
    }
    for (var i = Math.max(fa.length, fb.length) - 1; i >= 0; i--) {
      var xa = num(fa[i], 99), xb = num(fb[i], 99);
      if (xa !== xb) return xa - xb;
    }
    if ((a.dnfs || 0) !== (b.dnfs || 0)) return (a.dnfs || 0) - (b.dnfs || 0);
    var aa = avgFinish(fa), ab = avgFinish(fb);
    if (aa !== ab) return aa - ab;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  }
  function countPos(arr, p) { var c = 0; for (var i = 0; i < arr.length; i++) if (arr[i] === p) c++; return c; }
  function avgFinish(arr) {
    var s = 0, n = 0;
    for (var i = 0; i < arr.length; i++) if (isNum(arr[i])) { s += arr[i]; n++; }
    return n ? s / n : 99;
  }
  function tiebreakReason(a, b) {
    if (!a || !b || a.points !== b.points) return null;
    var fa = a.finishes || [], fb = b.finishes || [];
    for (var p = 1; p <= 12; p++) {
      var ca = countPos(fa, p), cb = countPos(fb, p);
      if (ca !== cb) return p === 1 ? 'more wins' : 'more ' + ordinal(p) + ' places';
    }
    return 'most recent result';
  }
  function sortStandings(rows) {
    var out = rows.slice().sort(compareStandings);
    // a fresh season (no starts, no points): everybody is level — views show '—', not a fake 1st / 2nd
    var level = out.length > 0 && out.every(function (r) { return !num(r.points, 0) && !num(r.starts, 0) && !(r.finishes || []).length; });
    out.forEach(function (r, i) {
      r.unranked = level;
      r.position = i + 1;
      r.gapToLeader = out[0].points - r.points;
      r.tiebreak = i > 0 ? tiebreakReason(out[i - 1], r) : null;
    });
    return out;
  }

  /* ======================================================================
     Event types
     ====================================================================== */
  var EVENT_TYPES = {
    race: { id: 'race', name: 'Circuit Race', short: 'Race', icon: 'flag', mode: 'race', scoring: 'position',
      desc: 'Wheel-to-wheel racing over a set number of laps. First across the line takes the win.' },
    'time-attack': { id: 'time-attack', name: 'Time Attack', short: 'Time Attack', icon: 'stopwatch', mode: 'time-trial', scoring: 'time', solo: true,
      desc: 'A clear track and the clock. Your best single lap is compared against the field\'s banker laps.' },
    drag: { id: 'drag', name: 'Drag Race', short: 'Drag', icon: 'bolt', mode: 'race', scoring: 'time', heads: true,
      desc: 'Standing-start quarter mile, heads-up. Launch, shift, pray. Elapsed time decides it.' },
    drift: { id: 'drift', name: 'Drift Trial', short: 'Drift', icon: 'drift', mode: 'time-trial', scoring: 'score', solo: true,
      desc: 'Points for angle, speed and duration. Link corners to build the combo multiplier; touching walls resets it.' },
    eliminator: { id: 'eliminator', name: 'Eliminator', short: 'Eliminator', icon: 'shield', mode: 'race', scoring: 'position',
      desc: 'At the end of every lap the last-placed car is eliminated. Be the last one standing.' },
    endurance: { id: 'endurance', name: 'Endurance', short: 'Endurance', icon: 'hourglass', mode: 'race', scoring: 'position',
      desc: 'Long-distance racing with tyre wear, fuel consumption, damage and pit stops. Strategy wins as much as speed.' },
    manufacturer: { id: 'manufacturer', name: 'Manufacturer Challenge', short: 'One-Make', icon: 'wrench', mode: 'race', scoring: 'position',
      desc: 'A works-backed one-make race. Your car must be built to the manufacturer\'s exact brief.' },
    rivals: { id: 'rivals', name: 'Rivals Duel', short: 'Rivals', icon: 'target', mode: 'race', scoring: 'position', heads: true,
      desc: 'One-on-one against a named rival. Pride, a purse and the last word are on the line.' }
  };
  function eventTypeOf(champ, round) {
    var id = (round && round.eventType) || (champ && champ.eventType) || 'race';
    return EVENT_TYPES[id] ? id : 'race';
  }

  /* ======================================================================
     Difficulty curve
     ====================================================================== */
  var DIFF_LEVELS = ['rookie', 'amateur', 'pro', 'alien'];
  var PLAYER_DIFF_OFFSET = { rookie: -0.16, easy: -0.16, amateur: 0, normal: 0, medium: 0, pro: 0.1, hard: 0.1, alien: 0.2 };
  function levelForRating(r) { return r < 0.3 ? 'rookie' : r < 0.55 ? 'amateur' : r < 0.8 ? 'pro' : 'alien'; }

  /** difficultyFor(champ, roundIdx, profile|settingString) -> {rating 0..1, level, label, skill:[lo,hi]} */
  function difficultyFor(champ, roundIdx, prof) {
    var tier = tierOf(champ);
    var base = num(champ.difficulty && champ.difficulty.base, tier ? tier.difficulty.base : 0.3);
    var ramp = num(champ.difficulty && champ.difficulty.ramp, tier ? tier.difficulty.ramp : 0.02);
    var setting = typeof prof === 'string' ? prof : get(prof, 'settings.difficulty', 'amateur');
    var off = num(PLAYER_DIFF_OFFSET[String(setting).toLowerCase()], 0);
    var r = clamp01(base + ramp * Math.max(0, num(roundIdx, 0)) + off + num(get(champ, 'rounds.' + roundIdx + '.difficultyBump'), 0));
    var level = levelForRating(r);
    return { rating: Math.round(r * 1000) / 1000, level: level, label: level.charAt(0).toUpperCase() + level.slice(1), setting: setting,
      skill: [clamp01(lerp(0.46, 0.93, r) - 0.04), clamp01(lerp(0.46, 0.93, r) + 0.06)] };
  }

  /* ======================================================================
     Driver roster — consistent AI identities across the whole career
     ====================================================================== */
  // Fallback roster (only used when CB.race.ai is not loaded). Same shape as CB.race.ai.DRIVERS / TEAMS.
  var FALLBACK_TEAMS = [
    { id: 'vantor', name: 'Vantor Racing', short: 'VAN', color: '#0b3d91', accent: '#f5c400', country: 'GB' },
    { id: 'kestrel', name: 'Kestrel Motorsport', short: 'KES', color: '#e8e8e8', accent: '#d0102b', country: 'DE' },
    { id: 'aurelio', name: 'Scuderia Aurelio', short: 'AUR', color: '#c1121f', accent: '#ffd23f', country: 'IT' },
    { id: 'nordlys', name: 'Nordlys Works', short: 'NOR', color: '#0f7b6c', accent: '#e9f5f2', country: 'NO' },
    { id: 'hanzo', name: 'Hanzo Speed Lab', short: 'HAN', color: '#111111', accent: '#ff3d00', country: 'JP' },
    { id: 'marlowe', name: 'Marlowe & Pike', short: 'M&P', color: '#1f4d2b', accent: '#d9b44a', country: 'GB' },
    { id: 'solenne', name: 'Équipe Solenne', short: 'SOL', color: '#2340d8', accent: '#ffffff', country: 'FR' },
    { id: 'quattrino', name: 'Quattrino Corse', short: 'QUA', color: '#ff7a00', accent: '#1b1b1b', country: 'IT' },
    { id: 'helix', name: 'Helix Dynamics', short: 'HLX', color: '#7a1fd1', accent: '#41e2ff', country: 'US' },
    { id: 'dunmore', name: 'Dunmore Engineering', short: 'DUN', color: '#5b6770', accent: '#ff2e63', country: 'IE' },
    { id: 'saguaro', name: 'Saguaro Desert Racing', short: 'SAG', color: '#c2702d', accent: '#2b2118', country: 'US' },
    { id: 'kairos', name: 'Kairos Performance', short: 'KAI', color: '#00a6a6', accent: '#101820', country: 'GR' }
  ];
  var FALLBACK_DRIVERS = [
    ['Lukas', 'Brandvold', 'NO'], ['Aiko', 'Tanabe', 'JP'], ['Mateus', 'Corvalho', 'BR'], ['Isolde', 'Varga', 'HU'],
    ['Ravi', 'Kundapur', 'IN'], ['Elodie', 'Fontanel', 'FR'], ['Tobias', 'Wetterling', 'DE'], ['Sienna', 'Marchetti', 'IT'],
    ['Kofi', 'Asantewaa', 'GH'], ['Freya', 'Lindqvist', 'SE'], ['Dmitri', 'Volkonin', 'LV'], ['Camila', 'Ortaz', 'AR'],
    ['Hugo', 'Ravensworth', 'GB'], ['Mei', 'Shirozawa', 'JP'], ['Joaquín', 'Ibarrola', 'ES'], ['Annika', 'Dvořáková', 'CZ'],
    ['Callum', 'Ferriday', 'AU'], ['Noor', 'Al-Haddani', 'AE'], ['Oskar', 'Penttinen', 'FI'], ['Priya', 'Venkatram', 'IN'],
    ['Teodor', 'Albescu', 'RO'], ['Yara', 'Okonkwo-Lisle', 'NG'], ['Bastien', 'Garrigou', 'FR'], ['Ines', 'Malheiro', 'PT'],
    ['Jonah', 'Whitlock', 'US'], ['Saskia', 'van Dorsten', 'NL'], ['Emil', 'Kragstrup', 'DK'], ['Leilani', 'Kahaleo', 'US'],
    ['Marco', 'Tessaroli', 'IT'], ['Hana', 'Jelinek', 'AT'], ['Diego', 'Santurce', 'MX'], ['Zofia', 'Wierzbicka', 'PL']
  ].map(function (d) {
    return { first: d[0], last: d[1], nat: d[2], name: d[0] + ' ' + d[1],
      code: d[1].replace(/^(van |de |von )/i, '').replace(/[^A-Za-zÀ-ž]/g, '').slice(0, 3).toUpperCase() };
  });
  var SPECIALTIES = ['allrounder', 'wet', 'street', 'oval', 'technical', 'endurance', 'drift', 'drag', 'qualifier', 'racecraft'];
  var SPECIALTY_DESC = {
    allrounder: 'Quick everywhere, spectacular nowhere.', wet: 'Comes alive when it rains.', street: 'Kisses the walls on street circuits.',
    oval: 'Lives in the slipstream on high-speed tracks.', technical: 'Precise on twisty, technical layouts.',
    endurance: 'Metronomic over long distances — tyres last forever.', drift: 'Sideways is the only way.', drag: 'Reaction times measured in heartbeats.',
    qualifier: 'Blistering over one lap; fades in races.', racecraft: 'Elbows out. Gains places at the start.'
  };
  var roster = null;

  function driverId(d) { return 'drv-' + slug(d.first + '-' + d.last); }
  /** The persistent AI roster: every driver has a fixed talent / style that never changes between saves. */
  function getRoster() {
    if (roster) return roster;
    var A = aiMod();
    var drivers = A && Array.isArray(A.DRIVERS) && A.DRIVERS.length >= 12 ? A.DRIVERS : FALLBACK_DRIVERS;
    var teams = A && Array.isArray(A.TEAMS) && A.TEAMS.length >= 6 ? A.TEAMS : FALLBACK_TEAMS;
    var rng = makeRng('forge-career-roster-v1');
    var used = {};
    var list = drivers.map(function (d, i) {
      var team = teams[(i * 7 + 3) % teams.length];
      var number;
      do { number = rng.int(2, 99); } while (used[number]);
      used[number] = 1;
      // talent: a gently skewed distribution so each tier has stars and journeymen
      var talent = clamp01(0.5 + rng.gauss() * 0.17);
      var spec = SPECIALTIES[(hashStr(d.name) >>> 3) % SPECIALTIES.length];
      return {
        id: driverId(d), name: d.name, first: d.first, last: d.last, code: d.code || d.last.slice(0, 3).toUpperCase(),
        nationality: d.nat, teamId: team.id, team: team.name, teamShort: team.short, color: team.color, accent: team.accent,
        number: number, talent: Math.round(talent * 1000) / 1000,
        consistency: Math.round(clamp01(0.55 + rng.next() * 0.4) * 1000) / 1000,
        aggression: Math.round(clamp01(0.2 + rng.next() * 0.65) * 1000) / 1000,
        specialty: spec, specialtyDesc: SPECIALTY_DESC[spec], age: rng.int(18, 41), isRival: false
      };
    });
    RIVALS.forEach(function (r) { list.push(rivalDriver(r)); });
    roster = { list: list, byId: {}, teams: teams };
    list.forEach(function (d) { roster.byId[d.id] = d; });
    return roster;
  }
  function getDriver(id) { var r = getRoster(); return r.byId[id] || null; }

  /* ======================================================================
     Rivals & storylines
     ====================================================================== */
  /*
   * Situations used by rivalLine():
   *   intro, preRace, preFinale, playerLeads, rivalLeads, playerWon, rivalWon, playerBeatRival, rivalBeatPlayer,
   *   playerDnf, rivalDnf, titlePlayer, titleRival, duelChallenge, duelWin, duelLoss, rain, comeback, respect, farewell
   * Lines may use {player}, {track}, {champ}, {gap}, {points}, {round}, {rival}.
   */
  var RIVALS = [
    {
      id: 'rival-kade', name: 'Kade Ashworth', first: 'Kade', last: 'Ashworth', code: 'ASH', nationality: 'GB', number: 1,
      team: 'Ashworth Heritage', teamId: 'ashworth', color: '#0e1a40', accent: '#d4af37', age: 19,
      title: 'The Heir', tierIds: ['rookie', 'national'], talent: 0.74, consistency: 0.78, aggression: 0.7, specialty: 'qualifier',
      bio: 'Third-generation racer with a family fortune and a trophy cabinet he did not fill himself. Fast, entitled, and terrified of losing to a nobody.',
      car: 'Factory-fresh hot hatch with a carbon bonnet his father had couriered from Turin.',
      personality: 'arrogant', arc: 'From sneering heir to grudging friend.',
      lines: {
        intro: ['So you\'re the garage kid everyone keeps mentioning. Cute car. Did you build it out of a kit?', 'Ashworths have won this cup four times, {player}. Try not to get lapped.'],
        preRace: ['{track}? I could drive it blindfolded. Maybe I will, to make it fair.', 'Pole is mine, {player}. Fight over second with the others.', 'Daddy\'s mechanics found another tenth. What did you find — loose change?'],
        preFinale: ['One race left. Every Ashworth has a trophy from this cup. I\'m not breaking the streak for you.', 'Final round, {player}. Don\'t do anything stupid. Actually — do. It\'ll be funnier.'],
        playerLeads: ['Enjoy the view from the top of the table. Leases are short.', '{gap} points? That\'s one bad weekend. And you have plenty of those in you.'],
        rivalLeads: ['Look at the standings, {player}. That\'s what the natural order looks like.', '{gap} points clear. You can stop trying now.'],
        playerWon: ['Luck. Pure, dumb luck. It won\'t happen at {track} next time.', 'Fine. You won one. Frame it.'],
        rivalWon: ['Another one for the cabinet. Did you see me wave in the mirror?', 'That\'s how an Ashworth does it. Take notes.'],
        playerBeatRival: ['My tyres went off. Obviously.', 'You got a tow. Everyone saw it.'],
        rivalBeatPlayer: ['Ahead of you again. Starting to feel personal?', 'I almost felt bad passing you. Almost.'],
        playerDnf: ['Bins are that way, {player}. The car park, I mean.'],
        rivalDnf: ['Mechanical. Not that it\'s any of your business.'],
        titlePlayer: ['...Congratulations. Don\'t tell anyone I said that.', 'You beat me fair. My father is going to be unbearable. See you in the next class — I\'ll be waiting.'],
        titleRival: ['Five for the family. Better luck next year, garage kid.'],
        duelChallenge: ['You and me. One race. Loser washes the winner\'s car — in public.', 'Tired of hiding in the pack? Meet me on track. Just us.'],
        duelWin: ['You actually did it. I\'ll... wash the car. Don\'t film it.'],
        duelLoss: ['Bring a sponge, {player}. And the good wax.'],
        rain: ['Rain. Great. Daddy\'s team forgot the wet setup again.'],
        comeback: ['From the back? Show-off.'],
        respect: ['You know what — you\'re alright. Don\'t let it go to your head.', 'Saw your onboard from last round. That move into the hairpin? Mine now.'],
        farewell: ['Go on, the big leagues are waiting. Try not to embarrass British motorsport.']
      }
    },
    {
      id: 'rival-yuki', name: 'Yuki Saranome', first: 'Yuki', last: 'Saranome', code: 'SAR', nationality: 'JP', number: 86,
      team: 'Akagane Night Club', teamId: 'akagane-nc', color: '#f2f2f2', accent: '#111111', age: 24,
      title: 'Ghost of Akagane', tierIds: ['rookie', 'national', 'continental'], talent: 0.8, consistency: 0.86, aggression: 0.35, specialty: 'drift',
      bio: 'Learned to drive delivering tofu down the Akagane Pass before dawn. Speaks rarely; when Yuki does, it is usually about tyre smoke.',
      car: 'Hand-tuned rear-drive coupe, older than its owner, perfectly balanced.',
      personality: 'stoic', arc: 'A silent master who decides you are worth teaching — then worth beating.',
      lines: {
        intro: ['...You drive with your hands. Drive with your hips.', 'The mountain does not care who you are. Neither do I. Yet.'],
        preRace: ['Listen to the tyres at {track}. They will tell you everything.', 'Calm hands. Late apex. Breathe.', '...'],
        preFinale: ['Tonight the mountain decides.', 'Whatever happens, drive your line, {player}. Not mine.'],
        playerLeads: ['Good. Now carry it.', 'Leading is heavy. Don\'t drop it.'],
        rivalLeads: ['Your angle is still too shallow.', 'Again.'],
        playerWon: ['...Hm. Your exit was clean.', 'You found the rhythm. Keep it.'],
        rivalWon: ['The pass was mine tonight.', 'Smoke clears. Results stay.'],
        playerBeatRival: ['You were braver at the second hairpin. I noticed.'],
        rivalBeatPlayer: ['You lift too early. The car wanted more.'],
        playerDnf: ['The wall is a teacher too. A harsh one.'],
        rivalDnf: ['Even ghosts crash.'],
        titlePlayer: ['The mountain chose you. Respect it.', 'I have nothing left to teach you. Go.'],
        titleRival: ['Come back next season. Come back better.'],
        duelChallenge: ['Akagane. Midnight. Bring nothing but your car.', 'Tandem. Lead, then chase. Show me.'],
        duelWin: ['...You are the ghost now.'],
        duelLoss: ['Close. Not close enough. Again next moon.'],
        rain: ['Wet roads reward soft hands.'],
        comeback: ['From the back of the field. Patient. Good.'],
        respect: ['You drive like someone who listens.', 'Call me if you want to run the pass. Before dawn.'],
        farewell: ['Different mountains now. Same rules.']
      }
    },
    {
      id: 'rival-tomas', name: 'Tomás Ruiz-Delgado', first: 'Tomás', last: 'Ruiz-Delgado', code: 'RUI', nationality: 'MX', number: 13,
      team: 'Calle Trece', teamId: 'calle-13', color: '#ff2e88', accent: '#2ef2ff', age: 27,
      title: 'Midnight King', tierIds: ['national', 'continental'], talent: 0.72, consistency: 0.62, aggression: 0.9, specialty: 'drag',
      bio: 'Street-racing legend of the Neon Harbour docks who went legit when the sponsors came calling. Loud, generous, allergic to lifting off.',
      car: 'Supercharged V8 brute with neon underglow and a parachute he insists is decorative.',
      personality: 'showman', arc: 'A loudmouth who becomes your biggest fan — until the money is on the line.',
      lines: {
        intro: ['¡Oye! New blood! You got a light foot or a heavy one, {player}?', 'Welcome to the night shift, amigo. Nobody here sleeps.'],
        preRace: ['Green means GO, {player}. Not "think about it".', 'I put a little extra boost in tonight. Just a little. Okay, a lot.', 'Hope your clutch is insured.'],
        preFinale: ['Last one, {player}. Winner buys tacos for the whole pit lane.', 'This is the one they\'ll talk about at the docks.'],
        playerLeads: ['Look at you, top of the board! The docks are talking, amigo.', '{gap} points? I\'ve come back from worse. Ask my mechanic.'],
        rivalLeads: ['Midnight King, baby! {gap} up and climbing!', 'You hear that? That\'s my engine laughing.'],
        playerWon: ['Okay okay okay — that launch was dirty. I love it.', '¡Qué bárbaro! Next time I\'m not lifting.'],
        rivalWon: ['Did you see the wheelie? Tell me you saw the wheelie.', 'King of the night, {player}. Say it with me.'],
        playerBeatRival: ['Bah! I missed second gear. Rematch. Now.'],
        rivalBeatPlayer: ['You were quick! I was quicker. That\'s just science, amigo.'],
        playerDnf: ['Ay, your car sounded like a blender full of bolts. You okay?'],
        rivalDnf: ['I may have over-done the boost. Slightly. The engine is in three pieces.'],
        titlePlayer: ['The crown is yours, amigo. Wear it loud!', 'You earned it. Tacos are on me — this time.'],
        titleRival: ['Midnight King keeps the crown! Come try again, {player}.'],
        duelChallenge: ['Quarter mile. Pink slips — kidding! Cash. Mostly kidding.', 'You and me, amigo. Lights, smoke, glory.'],
        duelWin: ['Ugh! Fine! You\'re the king tonight. Only tonight.'],
        duelLoss: ['Better luck next light, amigo!'],
        rain: ['Wet drag strip? That\'s just a slip-and-slide with timing gear.'],
        comeback: ['From the back! That\'s some street-racer energy, amigo.'],
        respect: ['You\'re alright, {player}. You race like you mean it.', 'Anyone gives you trouble at the docks, you say my name.'],
        farewell: ['Go show the fancy series how the night shift drives!']
      }
    },
    {
      id: 'rival-bronn', name: 'Bronn Halvorsen', first: 'Bronn', last: 'Halvorsen', code: 'HAL', nationality: 'NO', number: 0,
      team: 'Fjordvolt Racing', teamId: 'fjordvolt', color: '#00c2a8', accent: '#0b1d26', age: 33,
      title: 'The Engineer', tierIds: ['continental', 'world-endurance'], talent: 0.82, consistency: 0.9, aggression: 0.4, specialty: 'technical',
      bio: 'Former battery engineer turned works driver, who treats racing as an optimisation problem and every rival as a data set.',
      car: 'Quad-motor electric coupé with torque vectoring he designed on a napkin.',
      personality: 'analytical', arc: 'A cold technician who learns that racing is more than numbers.',
      lines: {
        intro: ['Interesting. Your power-to-weight is 6% below the field median. You must be compensating with something.', 'I have studied your telemetry, {player}. You brake 4 metres too early into turn one.'],
        preRace: ['Track temperature at {track} favours my thermal model. Statistically, you will finish behind me.', 'Instant torque. Zero shift time. Your gearbox is a museum piece.', 'Probability of you leading lap one: 22%. Prove me wrong.'],
        preFinale: ['The championship maths is simple. I have done it three times. You will not like the answer.', 'A finale is just another data point. A very important one.'],
        playerLeads: ['An outlier. Outliers regress to the mean.', 'Your lead is {gap} points. My model says that is not enough.'],
        rivalLeads: ['As predicted.', 'The data does not lie, {player}. Neither does the table.'],
        playerWon: ['Unexpected. I will need to update my model.', 'Your sector two was... optimal. How?'],
        rivalWon: ['Efficiency wins championships.', 'Exactly as simulated.'],
        playerBeatRival: ['My energy deployment was suboptimal. It will not happen again.'],
        rivalBeatPlayer: ['You defended the inside line too early. Predictable.'],
        playerDnf: ['A mechanical failure is just an unscheduled data collection.'],
        rivalDnf: ['Thermal runaway. I would rather not discuss it.'],
        titlePlayer: ['My model was wrong. I find I do not mind.', 'Congratulations. Your driving does not fit my equations. That is... inspiring.'],
        titleRival: ['The simulation holds. See you next season.'],
        duelChallenge: ['A controlled experiment: you, me, identical conditions. Accept?', 'Let us settle the variable. One race.'],
        duelWin: ['Result accepted. Hypothesis rejected.'],
        duelLoss: ['Repeatable result. Thank you for participating.'],
        rain: ['Rain introduces noise. I dislike noise.'],
        comeback: ['A comeback from the back of the grid. Statistically absurd. Well driven.'],
        respect: ['I ran your lap through my model. It should not be possible. I want to learn it.', 'You are the most interesting data set on the grid, {player}.'],
        farewell: ['I will be watching your telemetry, {player}. For science.']
      }
    },
    {
      id: 'rival-ines', name: 'Inès Duvalier', first: 'Inès', last: 'Duvalier', code: 'DUV', nationality: 'FR', number: 24,
      team: 'Équipe Duvalier', teamId: 'duvalier', color: '#1b3a8c', accent: '#ffffff', age: 41,
      title: 'La Patronne', tierIds: ['world-endurance', 'hypercar'], talent: 0.86, consistency: 0.95, aggression: 0.45, specialty: 'endurance',
      bio: 'Three-time 24-hour winner who owns her own team. Mentored half the paddock — and beat the other half.',
      car: 'Long-tail prototype, battle-scarred and immaculate, running the same chassis for five seasons.',
      personality: 'mentor', arc: 'Your mentor becomes your toughest opponent — and finally passes you the torch.',
      lines: {
        intro: ['Bienvenue, {player}. Endurance is not a sprint repeated. It is patience, repeated.', 'I have watched you climb. Now we find out if you can last.'],
        preRace: ['Look after your tyres at {track}. Everybody remembers the last hour, nobody the first.', 'Fuel is a promise to your future self. Keep it.', 'Box when the car tells you, not when your pride does.'],
        preFinale: ['The last race of the year is the longest one. I have waited for it all season.', 'Whatever happens tonight, {player} — you belong here.'],
        playerLeads: ['You lead. Good. Now learn how heavy it is.', 'Leading by {gap} points... I remember that feeling. I also remember losing it.'],
        rivalLeads: ['Experience is a quiet weapon, chéri.', 'The table is long. So is the season.'],
        playerWon: ['Bravo. You managed the race, not just the lap.', 'That stint at night — that was a professional stint.'],
        rivalWon: ['Patience, {player}. It always pays the bills.', 'I took the strategy gamble. Today it was right.'],
        playerBeatRival: ['You out-thought me in the pit window. I am proud — and furious.'],
        rivalBeatPlayer: ['You pushed too hard in the second stint. Your tyres paid for it.'],
        playerDnf: ['It happens to all of us. It happened to me at {track}, years ago. Come back.'],
        rivalDnf: ['Even old chassis have their limits. Merde.'],
        titlePlayer: ['The torch is yours, {player}. Carry it better than I did.', 'Champion. You will find it is quieter up here than you expect.'],
        titleRival: ['One more for the old lady. Next year is yours, I think.'],
        duelChallenge: ['A private wager between teacher and student. A long race. Just us.', 'Show me what you learned. Twelve laps. No mercy.'],
        duelWin: ['The student has graduated.'],
        duelLoss: ['Not yet, {player}. Not yet.'],
        rain: ['Rain is where races are won by the patient and lost by the brave.'],
        comeback: ['From the back, without damage. That is how endurance is won.'],
        respect: ['My mechanics ask about you. I tell them to watch and learn.', 'If you ever want a seat at Équipe Duvalier... the door is open.'],
        farewell: ['Go chase the hypercars, {player}. I will be watching from the pit wall.']
      }
    },
    {
      id: 'rival-sable', name: 'Seraphine "Sable" Kord', first: 'Seraphine', last: 'Kord', code: 'KOR', nationality: 'CH', number: 99,
      team: 'Kord Hyperwerk', teamId: 'kord-hyperwerk', color: '#0a0a0a', accent: '#c8a96a', age: 29,
      title: 'The Phantom', tierIds: ['hypercar'], talent: 0.95, consistency: 0.96, aggression: 0.62, specialty: 'allrounder',
      bio: 'Reigning Hypercar Masters champion, undefeated in two seasons. Nobody knows who funds Kord Hyperwerk. Nobody asks twice.',
      car: 'A matte-black hypercar that has never been photographed with its engine cover off.',
      personality: 'enigmatic', arc: 'The final boss: untouchable, until you touch her.',
      lines: {
        intro: ['So this is Redline\'s little project. I expected more chrome.', 'Everyone wants to be the one who beats me, {player}. Get in line.'],
        preRace: ['{track} has seventeen corners. I own all of them.', 'Don\'t look in your mirrors. It only makes it worse.', 'You will see me twice today: on the grid, and on the podium above you.'],
        preFinale: ['Two seasons undefeated. Do you know how boring that is? Make it interesting.', 'Double points tonight, {player}. Double the disappointment.'],
        playerLeads: ['A lead. How quaint. Hold on to it.', '{gap} points. I have overturned more in a single stint.'],
        rivalLeads: ['As it should be.', 'The table is just a list of people I have beaten.'],
        playerWon: ['...Enjoy it. That will not happen twice.', 'Well. Someone finally brought a car.'],
        rivalWon: ['Predictable. Like gravity.', 'Was that your best? Truly?'],
        playerBeatRival: ['A setup gamble that failed. Nothing more.'],
        rivalBeatPlayer: ['You were close enough to read my number plate. That\'s something.'],
        playerDnf: ['The wall wins again. It usually does for people who chase me.'],
        rivalDnf: ['A rare failure. My engineers will not sleep tonight.'],
        titlePlayer: ['...I lost. Hm. It feels less terrible than I imagined. Well driven, champion.', 'The crown is heavy, {player}. I will be back for it.'],
        titleRival: ['Three in a row. You were the closest. That should comfort you.'],
        duelChallenge: ['No grid, no field, no excuses. Just the two fastest cars on earth.', 'Shall we find out, once and for all?'],
        duelWin: ['...Remarkable. Truly. Do not expect a rematch to go the same way.'],
        duelLoss: ['Did you think it would be different with fewer cars in the way?'],
        rain: ['Rain is just a reason for other people to be slow.'],
        comeback: ['From the back? You almost made me look.'],
        respect: ['You are the first driver in two years I have had to think about.', 'When I lose, I want it to be to you. Not that I plan to lose.'],
        farewell: ['There is nothing above this, {player}. Only the next lap.']
      }
    }
  ];
  var RIVAL_BY_ID = {};
  RIVALS.forEach(function (r) { RIVAL_BY_ID[r.id] = r; });
  function getRival(id) { return RIVAL_BY_ID[id] || null; }
  function rivalDriver(r) {
    return {
      id: r.id, name: r.name, first: r.first, last: r.last, code: r.code, nationality: r.nationality, teamId: r.teamId, team: r.team,
      teamShort: r.code, color: r.color, accent: r.accent, number: r.number, talent: r.talent, consistency: r.consistency,
      aggression: r.aggression, specialty: r.specialty, specialtyDesc: SPECIALTY_DESC[r.specialty], age: r.age, isRival: true, title: r.title
    };
  }

  /**
   * Storyline beats: shown once each when their trigger matches (evaluated after every recorded round).
   * trigger: {on: 'first-meet'|'round'|'title'|'duel'|'tier-unlock'|'respect', ...conditions}
   */
  var STORY_BEATS = [
    { id: 'kade-1', rival: 'rival-kade', on: 'first-meet', title: 'A Silver Spoon', text: 'Kade Ashworth arrives with three trucks, six mechanics and a photographer. He has already decided who wins the Rookie Cup.' },
    { id: 'kade-2', rival: 'rival-kade', on: 'beat-rival', count: 2, title: 'Cracks in the Chrome', text: 'Twice now you have finished ahead of Ashworth. The photographer has stopped following him around.' },
    { id: 'kade-3', rival: 'rival-kade', on: 'duel-win', title: 'Soap and Sponge', text: 'Kade washes your car in the paddock, in front of everyone. He is surprisingly thorough. Afterwards he asks how you take hairpin three.' },
    { id: 'kade-4', rival: 'rival-kade', on: 'respect', min: 60, title: 'Unlikely Allies', text: 'Kade sends you his father\'s old setup notes for the National GT circuits. Scrawled on the front: "Don\'t make me regret this."' },
    { id: 'yuki-1', rival: 'rival-yuki', on: 'first-meet', title: 'The Ghost', text: 'A white coupe passes you on the mountain without a sound. By the time you reach the summit, Yuki Saranome is already drinking a can of coffee.' },
    { id: 'yuki-2', rival: 'rival-yuki', on: 'beat-rival', count: 1, title: 'Noticed', text: 'Yuki nods at you in the paddock. Just once. The other drivers stare.' },
    { id: 'yuki-3', rival: 'rival-yuki', on: 'duel-win', title: 'The New Ghost', text: 'Word spreads through the night club: someone beat the Ghost of Akagane. Yuki leaves a hand-written note on your windscreen — a racing line, sketched in pencil.' },
    { id: 'tomas-1', rival: 'rival-tomas', on: 'first-meet', title: 'Night Shift', text: 'Tomás Ruiz-Delgado introduces himself by doing a burnout around your car. Then he offers you a taco.' },
    { id: 'tomas-2', rival: 'rival-tomas', on: 'rival-dnf', title: 'Three Pieces', text: 'Tomás\'s engine leaves the chassis in at least three directions. He is laughing as the marshals push it away.' },
    { id: 'tomas-3', rival: 'rival-tomas', on: 'duel-win', title: 'Crown of the Docks', text: 'The docks crown a new Midnight King. Tomás leads the applause, loudly, and then demands a rematch.' },
    { id: 'bronn-1', rival: 'rival-bronn', on: 'first-meet', title: 'The Data Set', text: 'Bronn Halvorsen hands you a printout of your own telemetry, annotated in red. "Improvements," he says, and walks away.' },
    { id: 'bronn-2', rival: 'rival-bronn', on: 'beat-rival', count: 3, title: 'Model Error', text: 'Halvorsen\'s engineers have been seen re-running their simulations at 3 a.m. Your name keeps appearing as an "unexplained variance".' },
    { id: 'bronn-3', rival: 'rival-bronn', on: 'respect', min: 70, title: 'Shared Telemetry', text: 'Bronn proposes something unprecedented: a data-sharing pact. "For science," he insists. You suspect it is for friendship.' },
    { id: 'ines-1', rival: 'rival-ines', on: 'first-meet', title: 'La Patronne', text: 'Inès Duvalier invites you into her motorhome and pours two espressos. "Endurance," she says, "is mostly about not losing."' },
    { id: 'ines-2', rival: 'rival-ines', on: 'title-player', title: 'Passing the Torch', text: 'Inès hands you the tattered helmet bag she carried to her first 24-hour win. "It brought me luck. I think you will need less of it."' },
    { id: 'ines-3', rival: 'rival-ines', on: 'duel-win', title: 'Graduation', text: 'The student beats the teacher. Inès toasts you in front of the entire paddock — then books the rematch on the spot.' },
    { id: 'sable-1', rival: 'rival-sable', on: 'first-meet', title: 'The Phantom', text: 'Two seasons undefeated. The black car rolls onto the grid and the paddock goes quiet. Seraphine Kord does not even look your way.' },
    { id: 'sable-2', rival: 'rival-sable', on: 'beat-rival', count: 1, title: 'First Blood', text: 'For the first time in two years, Kord Hyperwerk files a technical protest. It is dismissed. You are officially a problem.' },
    { id: 'sable-3', rival: 'rival-sable', on: 'title-player', title: 'Dethroned', text: 'Sable climbs onto the podium beneath you, removes her helmet, and — for the first time anyone has seen — smiles.' },
    { id: 'sable-4', rival: 'rival-sable', on: 'duel-win', title: 'The Fastest on Earth', text: 'Two hypercars, one road, no excuses. You won. The phantom has a name now, and it is yours.' }
  ];

  /* ======================================================================
     Catalog: tiers, championships & special events
     ====================================================================== */
  /*
   * Round def: { trackId, laps, weather 'dry'|'damp'|'wet'|'variable'|'random', timeOfDay 'day'|'dusk'|'night',
   *              eventType?, name?, desc?, opponents?, difficultyBump?, prizeMult?, special?, rules? }
   * 'variable' / 'random' weather is resolved deterministically per season from the career seed.
   */
  function R(trackId, laps, o) {
    var r = { trackId: trackId, laps: laps, weather: 'dry', timeOfDay: 'day' };
    if (o) for (var k in o) if (hasOwn.call(o, k)) r[k] = o[k];
    return r;
  }

  var TIERS = [
    {
      id: 'rookie', index: 0, name: 'Rookie Cup', short: 'Rookie', color: '#57a8ff', icon: 'helmet', minLevel: 1,
      tagline: 'Club racing, borrowed helmets, big dreams.',
      desc: 'Low-power club championships on short circuits. Learn racecraft, earn your first trophies, and get noticed by the national teams.',
      difficulty: { base: 0.16, ramp: 0.03 }, aiLevel: 'rookie', opponents: [5, 7], purse: 20000, xpBonus: 2500,
      unlock: null, entryFeeTier: 0, rivalIds: ['rival-kade', 'rival-yuki'],
      trophyMaterial: 'pewter', reward: { credits: 15000, xp: 2000, title: 'Club Racer' }
    },
    {
      id: 'national', index: 1, name: 'National GT', short: 'National', color: '#4cd18a', icon: 'flag', minLevel: 3,
      tagline: 'Proper grids, proper cars, proper consequences.',
      desc: 'National-level GT, touring and drag championships. More power, longer races, and opponents who do not leave the door open.',
      difficulty: { base: 0.34, ramp: 0.03 }, aiLevel: 'amateur', opponents: [7, 9], purse: 55000, xpBonus: 6000,
      unlock: { tier: 'rookie', trophies: 1, maxPosition: 3 }, entryFeeTier: 1, rivalIds: ['rival-kade', 'rival-tomas', 'rival-yuki'],
      trophyMaterial: 'bronze', reward: { credits: 40000, xp: 5000, title: 'National Contender' }
    },
    {
      id: 'continental', index: 2, name: 'Continental Series', short: 'Continental', color: '#f3c246', icon: 'globe', minLevel: 5,
      tagline: 'Across borders, against the best of a continent.',
      desc: 'GT3-class machinery, electric championships, eliminators and works-backed one-make cups on every circuit in the calendar.',
      difficulty: { base: 0.5, ramp: 0.025 }, aiLevel: 'pro', opponents: [8, 10], purse: 130000, xpBonus: 14000,
      unlock: { tier: 'national', trophies: 2, maxPosition: 3 }, entryFeeTier: 2, rivalIds: ['rival-bronn', 'rival-tomas', 'rival-yuki'],
      trophyMaterial: 'silver', reward: { credits: 90000, xp: 12000, title: 'Continental Star' }
    },
    {
      id: 'world-endurance', index: 3, name: 'World Endurance', short: 'Endurance', color: '#ff7a3d', icon: 'hourglass', minLevel: 7,
      tagline: 'Fuel, tyres, night stints and nerve.',
      desc: 'Long-distance world championships with tyre wear, fuel strategy, damage and mandatory pit stops. Pace is nothing without patience.',
      difficulty: { base: 0.64, ramp: 0.02 }, aiLevel: 'pro', opponents: [9, 11], purse: 250000, xpBonus: 30000,
      unlock: { tier: 'continental', trophies: 2, maxPosition: 3 }, entryFeeTier: 3, rivalIds: ['rival-ines', 'rival-bronn'],
      trophyMaterial: 'gold', reward: { credits: 200000, xp: 25000, title: 'Endurance Legend' }
    },
    {
      id: 'hypercar', index: 4, name: 'Hypercar Masters', short: 'Masters', color: '#c17bff', icon: 'crown', minLevel: 9,
      tagline: 'The fastest cars on earth. One crown.',
      desc: 'Invitation-only championships for 1000-horsepower hypercars, electric monsters and the unlimited Redline Grand Prix. The final summit.',
      difficulty: { base: 0.78, ramp: 0.025 }, aiLevel: 'alien', opponents: [9, 11], purse: 480000, xpBonus: 60000,
      unlock: { tier: 'world-endurance', trophies: 2, maxPosition: 3 }, entryFeeTier: 4, rivalIds: ['rival-sable', 'rival-ines'],
      trophyMaterial: 'platinum', reward: { credits: 500000, xp: 60000, title: 'Hypercar Master' }
    }
  ];

  var CHAMPIONSHIPS = [
    /* ------------------------------------------------------------ Tier 1: Rookie Cup */
    {
      id: 'rookie-sunday-cup', tier: 'rookie', name: 'Sunday Club Cup', short: 'Club Cup', eventType: 'race', pointsSystem: 'rookie',
      desc: 'Where every career starts: a friendly club series on the shortest circuits, for cars under 250 hp. Friendly, until the lights go out.',
      requirements: { maxPower_hp: 250, maxPrice: 40000 }, opponents: 6, field: 'mixed', rivals: ['rival-kade'], minLevel: 1, purseMult: 0.8,
      sponsor: 'Corner Garage Tyres', trophy: { name: 'The Sunday Shield' },
      rewards: { unlocks: { tracks: ['ouroboros'] } },
      rounds: [
        R('little-anvil', 6, { name: 'Opening Day', desc: 'Short, tight and full of rookies. Survive turn one and you are already ahead of half the field.' }),
        R('ouroboros', 4, { name: 'Crossroads', desc: 'A figure-of-eight where the crossover rewards timing as much as speed.' }),
        R('forge-speedway', 3, { name: 'The Long Draft', desc: 'Low power means slipstreaming is everything on the speedway banking.' }),
        R('porto-vecchio', 3, { name: 'Harbour Finale', weather: 'variable', desc: 'Walls, cobbles and a sea breeze — the club cup finale on the streets of Porto Vecchio.' })
      ]
    },
    {
      id: 'rookie-hot-hatch', tier: 'rookie', name: 'Hot Hatch Trophy', short: 'Hot Hatch', eventType: 'race', pointsSystem: 'rookie',
      desc: 'Front-wheel-drive hatchbacks, bumper to bumper. Torque steer, lift-off oversteer and the occasional door handle in the mirror.',
      requirements: { bodyStyles: ['hatchback'], drivetrain: ['fwd'], maxPower_hp: 340 }, opponents: 7, field: 'similar', rivals: ['rival-kade'],
      minLevel: 1, purseMult: 1, sponsor: 'Pocket Rocket Energy', trophy: { name: 'The Pocket Rocket Cup' },
      rewards: { unlocks: { parts: ['tunes:stage1'] } },
      rounds: [
        R('little-anvil', 8, { name: 'Kart Track Brawl' }),
        R('porto-vecchio', 3, { name: 'Vecchio Sprint', desc: 'Hatchbacks were made for these streets. So were walls.' }),
        R('ouroboros', 5, { name: 'Figure-8 Frenzy', eventType: 'eliminator', desc: 'Special round: last car at the end of each lap is eliminated.' }),
        R('forge-ring', 2, { name: 'Ring Debut', desc: 'Your first taste of the Redline Ring — 5.8 km of everything.' }),
        R('neon-harbour', 3, { name: 'Neon Nights', timeOfDay: 'night', desc: 'Under the lights of Neon Harbour, headlights and nerves both shine.' })
      ]
    },
    {
      id: 'rookie-volt-academy', tier: 'rookie', name: 'Volt Academy', short: 'Volt Academy', eventType: 'race', pointsSystem: 'rookie',
      desc: 'An electric-only junior cup. Instant torque, silent grids and regenerative braking strategy from the very first lap.',
      requirements: { engineTypes: ['ev'], maxPower_hp: 400 }, opponents: 6, field: 'similar', rivals: [], minLevel: 2, purseMult: 1.05,
      sponsor: 'Fjordvolt Energy', trophy: { name: 'The Spark Plate' },
      rewards: { unlocks: { parts: ['batteryChemistries:nca'] } },
      rounds: [
        R('ouroboros', 5, { name: 'Silent Start' }),
        R('neon-harbour', 3, { name: 'Volt After Dark', timeOfDay: 'dusk' }),
        R('forge-ring', 2, { name: 'Range Anxiety', desc: 'A full Redline Ring distance. Manage your energy or coast home.' })
      ]
    },
    {
      id: 'rookie-drift-initiation', tier: 'rookie', name: 'Akagane Drift Initiation', short: 'Drift Initiation', eventType: 'drift', pointsSystem: 'drift',
      desc: 'Judged drift runs on the mountain. Rear-wheel drive only. Angle, speed and commitment — the clock does not matter here.',
      requirements: { drivetrain: ['rwd'], maxPower_hp: 420 }, opponents: 7, field: 'mixed', rivals: ['rival-yuki'], minLevel: 2, purseMult: 0.9,
      sponsor: 'Midnight Coffee Co.', trophy: { name: 'The Smoke Lantern' },
      rewards: { unlocks: { parts: ['drivetrain.rearDiff:lsd-clutch'] } },
      rounds: [
        R('akagane-pass', 1, { name: 'Lower Switchbacks', timeOfDay: 'dusk', desc: 'Three judged runs through the lower hairpins. Link them for the combo multiplier.' }),
        R('ouroboros', 2, { name: 'Figure-8 Tandem', desc: 'The crossover is a judged zone — hold the slide through it.' }),
        R('akagane-pass', 1, { name: 'Summit by Night', timeOfDay: 'night', desc: 'The full pass, at night, with Yuki watching.' })
      ]
    },

    /* ------------------------------------------------------------ Tier 2: National GT */
    {
      id: 'national-gt4', tier: 'national', name: 'National GT4 Championship', short: 'GT4', eventType: 'race', pointsSystem: 'f1',
      desc: 'The heart of national sports-car racing: production-based GT cars under 480 hp, five rounds, no quarter given.',
      requirements: { maxPower_hp: 480, minWeight_kg: 1150, bodyStyles: ['coupe', 'roadster', 'shooting-brake'], tireCompounds: ['performance', 'super-sport', 'track'] },
      opponents: 9, field: 'mixed', rivals: ['rival-kade'], minLevel: 3, purseMult: 1.1, sponsor: 'Vantor Lubricants', trophy: { name: 'The GT4 Crown' },
      rewards: { unlocks: { parts: ['tireCompounds:track'] } },
      rounds: [
        R('forge-ring', 3, { name: 'Ring Opener' }),
        R('porto-vecchio', 5, { name: 'Vecchio 50', weather: 'variable' }),
        R('forge-speedway', 6, { name: 'Speedway 100', desc: 'Drafting trains and three-wide braking into turn one.' }),
        R('neon-harbour', 5, { name: 'Harbour Lights', timeOfDay: 'night' }),
        R('forge-ring', 4, { name: 'Ring Decider', weather: 'random', desc: 'The title decider. The forecast is a coin toss.' })
      ]
    },
    {
      id: 'national-touring', tier: 'national', name: 'Touring Car Masters', short: 'Touring', eventType: 'race', pointsSystem: 'f1',
      desc: 'Saloons, estates and hatchbacks trading paint for five rounds. Contact is not encouraged. It is expected.',
      requirements: { bodyStyles: ['sedan', 'wagon', 'hatchback'], maxPower_hp: 420, minWeight_kg: 1200 },
      opponents: 9, field: 'similar', rivals: ['rival-kade'], minLevel: 3, purseMult: 1, sponsor: 'Marlowe & Pike Insurance', trophy: { name: 'The Doorhandle Trophy' },
      rules: { contact: 'tolerant' },
      rounds: [
        R('porto-vecchio', 4, { name: 'Street Fight' }),
        R('little-anvil', 10, { name: 'Anvil Sprint', desc: 'Ten laps on a kart track in saloon cars. Absolute carnage, expected.' }),
        R('forge-ring', 3, { name: 'Ring Feature Race', weather: 'variable' }),
        R('ouroboros', 6, { name: 'Crossover Elimination', eventType: 'eliminator' }),
        R('neon-harbour', 5, { name: 'Midnight Masters', timeOfDay: 'night' })
      ]
    },
    {
      id: 'national-midnight-drag', tier: 'national', name: 'Midnight Quarter-Mile Series', short: 'Midnight Drag', eventType: 'drag', pointsSystem: 'f1',
      desc: 'Heads-up quarter-mile drag racing at the Neon Harbour docks. Reaction time, launch control and a lot of horsepower.',
      requirements: { minPower_hp: 300 }, opponents: 7, field: 'mixed', rivals: ['rival-tomas'], minLevel: 3, purseMult: 0.9,
      sponsor: 'Calle Trece Nitrous', trophy: { name: 'The Christmas Tree' },
      rules: { distance_m: 402.336, heads: 1 },
      rewards: { unlocks: { parts: ['engine.aspiration:supercharged'] } },
      rounds: [
        R('drag-strip', 1, { name: 'Dock Strip Qualifier', timeOfDay: 'night' }),
        R('drag-strip', 1, { name: 'Wet Docks', timeOfDay: 'night', weather: 'damp', desc: 'A damp strip. Traction is a rumour.' }),
        R('drag-strip', 1, { name: 'Neon Eighth', timeOfDay: 'night', rules: { distance_m: 201.168 }, desc: 'Eighth-mile sprint: pure launch.' }),
        R('drag-strip', 1, { name: 'King of the Night', timeOfDay: 'night', desc: 'Finals night. Tomás has been waiting all season.' })
      ]
    },
    {
      id: 'national-time-attack', tier: 'national', name: 'Time Attack Nationals', short: 'Time Attack', eventType: 'time-attack', pointsSystem: 'attack',
      desc: 'One clean lap. That is all that matters. Shared track sessions — the best single lap of the session takes the round.',
      requirements: { maxPower_hp: 550, tireCompounds: ['performance', 'super-sport', 'track'] }, opponents: 8, field: 'mixed', rivals: [],
      minLevel: 4, purseMult: 0.95, sponsor: 'Hanzo Speed Lab', trophy: { name: 'The Golden Stopwatch' },
      rewards: { unlocks: { parts: ['aero.wings:swan-neck'] } },
      rounds: [
        R('akagane-pass', 3, { name: 'Hillclimb Attack', desc: 'Uphill time attack on the Akagane Pass.' }),
        R('forge-ring', 3, { name: 'Ring Hot Lap' }),
        R('porto-vecchio', 4, { name: 'Wall Kisser', desc: 'The fastest lap here is the one that brushes every wall.' })
      ]
    },
    {
      id: 'national-heritage-muscle', tier: 'national', name: 'Heritage Muscle Cup', short: 'Muscle', eventType: 'race', pointsSystem: 'classic',
      desc: 'V8, rear-wheel drive, no apologies. Old-school scoring, old-school machinery, very modern lap times.',
      requirements: { engineLayouts: ['V8'], drivetrain: ['rwd'], engineTypes: ['ice'] }, opponents: 8, field: 'similar', rivals: ['rival-tomas'],
      minLevel: 4, purseMult: 1.05, sponsor: 'Saguaro Steel', trophy: { name: 'The Iron Horse' },
      rewards: { unlocks: { parts: ['engine.exhaust:straight-pipe'] } },
      rounds: [
        R('forge-speedway', 8, { name: 'Thunder Oval' }),
        R('ouroboros', 6, { name: 'Smoke Show' }),
        R('drag-strip', 1, { name: 'Muscle Drags', eventType: 'drag', desc: 'Special round: heads-up quarter-mile.' }),
        R('forge-ring', 3, { name: 'Iron Ring', weather: 'variable' })
      ]
    },

    /* ------------------------------------------------------------ Tier 3: Continental Series */
    {
      id: 'continental-gt3', tier: 'continental', name: 'Continental GT3', short: 'GT3', eventType: 'race', pointsSystem: 'f1',
      desc: 'The continent\'s premier sprint series. GT3-spec machinery under 650 hp, balanced with ballast, across six iconic rounds.',
      requirements: { maxPower_hp: 650, minWeight_kg: 1150, bodyStyles: ['coupe', 'roadster', 'hypercar', 'shooting-brake'] },
      opponents: 10, field: 'mixed', rivals: ['rival-bronn'], minLevel: 5, purseMult: 1.15, sponsor: 'Kestrel Motorsport', trophy: { name: 'The Continental Cup' },
      rewards: { unlocks: { parts: ['aero.wings:gt-wing', 'body.chassisMaterial:carbon-tub'] } },
      rounds: [
        R('forge-ring', 4, { name: 'Eisenwald GP' }),
        R('porto-vecchio', 6, { name: 'Vecchio Grand Prix', weather: 'variable' }),
        R('akagane-pass', 3, { name: 'Mountain Sprint' }),
        R('neon-harbour', 6, { name: 'Marina Night Race', timeOfDay: 'night' }),
        R('forge-speedway', 10, { name: 'Speedway 300' }),
        R('forge-ring', 5, { name: 'Continental Finale', weather: 'random', difficultyBump: 0.04 })
      ]
    },
    {
      id: 'continental-e-series', tier: 'continental', name: 'E-Series Continental', short: 'E-Series', eventType: 'race', pointsSystem: 'f1',
      desc: 'Electric racing goes continental: 300 kW-plus EVs, attack-mode overtakes and energy management that decides the last lap.',
      requirements: { engineTypes: ['ev'], minPower_hp: 400, maxPower_hp: 900 }, opponents: 9, field: 'similar', rivals: ['rival-bronn'],
      minLevel: 5, purseMult: 1.1, sponsor: 'Fjordvolt Energy', trophy: { name: 'The Lightning Rod' },
      rewards: { unlocks: { parts: ['batteryChemistries:solid-state'] } },
      rounds: [
        R('neon-harbour', 5, { name: 'Neon E-Prix', timeOfDay: 'night' }),
        R('porto-vecchio', 6, { name: 'Vecchio E-Prix' }),
        R('ouroboros', 8, { name: 'Figure-8 Energy Trial', desc: 'Long race, short track — your battery will hate you.' }),
        R('forge-ring', 4, { name: 'Ring E-Prix', weather: 'variable' }),
        R('little-anvil', 14, { name: 'Anvil Attack', desc: 'Season finale on the kart circuit: full attack mode.' })
      ]
    },
    {
      id: 'continental-last-car', tier: 'continental', name: 'Last Car Standing Tour', short: 'Eliminator', eventType: 'eliminator', pointsSystem: 'f1',
      desc: 'Every round is an eliminator: at the end of each lap the last car is out. No points for second-best lap.',
      requirements: { maxPower_hp: 700 }, opponents: 8, field: 'mixed', rivals: ['rival-tomas'], minLevel: 6, purseMult: 1,
      sponsor: 'Dunmore Engineering', trophy: { name: 'The Last One Standing' },
      rounds: [
        R('ouroboros', 8, { name: 'Crossfire' }),
        R('little-anvil', 8, { name: 'Anvil Knockout' }),
        R('porto-vecchio', 8, { name: 'Street Survival', weather: 'variable' }),
        R('neon-harbour', 8, { name: 'Lights Out, One by One', timeOfDay: 'night' })
      ]
    },
    {
      id: 'continental-drift-masters', tier: 'continental', name: 'Continental Drift Masters', short: 'Drift Masters', eventType: 'drift', pointsSystem: 'drift',
      desc: 'The continent\'s best drifters on the most demanding layouts. Bigger angle, bigger speed, bigger smoke.',
      requirements: { drivetrain: ['rwd', 'awd'], minPower_hp: 350 }, opponents: 8, field: 'mixed', rivals: ['rival-yuki'], minLevel: 5, purseMult: 1,
      sponsor: 'Midnight Coffee Co.', trophy: { name: 'The Smoke Crown' },
      rewards: { unlocks: { parts: ['tireCompounds:super-sport'] } },
      rounds: [
        R('akagane-pass', 1, { name: 'Akagane Downhill', timeOfDay: 'night' }),
        R('porto-vecchio', 1, { name: 'Harbour Smoke' }),
        R('ouroboros', 2, { name: 'Infinity Loop' }),
        R('akagane-pass', 1, { name: 'Ghost Run', timeOfDay: 'night', weather: 'damp', desc: 'Damp mountain road, midnight, Yuki in front. Legends are made here.' })
      ]
    },
    {
      id: 'continental-works-cup', tier: 'continental', name: 'Redline Works Cup', short: 'Works Cup', eventType: 'manufacturer', pointsSystem: 'f1',
      desc: 'A manufacturer one-make championship: mid-engined, naturally aspirated six-cylinder coupés built to the Redline works brief.',
      requirements: { bodyStyles: ['coupe'], enginePositions: ['mid'], engineLayouts: ['flat-6', 'I6', 'V6'], aspirations: ['na'], maxPower_hp: 560, minWeight_kg: 1100 },
      brief: { manufacturer: 'Redline Works', text: 'Mid-engined coupé. Naturally aspirated six-cylinder. Under 560 hp. Minimum 1100 kg. Built to be driven on the limit.' },
      opponents: 9, field: 'similar', rivals: ['rival-bronn'], minLevel: 6, purseMult: 1.2, sponsor: 'Redline Works', trophy: { name: 'The Works Anvil' },
      rewards: { unlocks: { parts: ['engine.layout:flat-6'] }, credits: 30000 },
      rounds: [
        R('forge-ring', 3, { name: 'Works Debut' }),
        R('akagane-pass', 3, { name: 'Mountain Works' }),
        R('neon-harbour', 4, { name: 'Works by Night', timeOfDay: 'night' }),
        R('forge-ring', 4, { name: 'Works Final', weather: 'variable' })
      ]
    },

    /* ------------------------------------------------------------ Tier 4: World Endurance */
    {
      id: 'wec-gt', tier: 'world-endurance', name: 'World Endurance — GT Class', short: 'WEC GT', eventType: 'endurance', pointsSystem: 'endurance',
      desc: 'GT-class endurance racing around the world: tyre wear, fuel strategy, damage and mandatory pit stops in every round.',
      requirements: { maxPower_hp: 700, minWeight_kg: 1200 }, opponents: 10, field: 'mixed', rivals: ['rival-ines'], minLevel: 7, purseMult: 1.1,
      sponsor: 'Équipe Duvalier', trophy: { name: 'The Long Road Trophy' },
      rules: { wear: 1.4, fuel: 1.2, damage: true, mandatoryPitStops: 1 },
      rewards: { unlocks: { parts: ['brakes.material:carbon-ceramic'] } },
      rounds: [
        R('forge-ring', 10, { name: '4 Hours of Eisenwald', rules: { mandatoryPitStops: 1 } }),
        R('porto-vecchio', 16, { name: 'Vecchio 6 Hours', weather: 'variable', timeOfDay: 'dusk' }),
        R('forge-speedway', 24, { name: 'Speedway Enduro', rules: { mandatoryPitStops: 2 } }),
        R('forge-ring', 14, { name: '8 Hours of the Ring', weather: 'random', timeOfDay: 'night', rules: { mandatoryPitStops: 2 } })
      ]
    },
    {
      id: 'wec-prototype', tier: 'world-endurance', name: 'World Endurance — Prototype Class', short: 'WEC Proto', eventType: 'endurance', pointsSystem: 'endurance',
      desc: 'The fastest endurance class: purpose-built prototypes with up to 950 hp, enormous downforce and two-stop strategies.',
      requirements: { maxPower_hp: 950, minWeight_kg: 1000, bodyStyles: ['hypercar', 'coupe', 'roadster'] }, opponents: 10, field: 'mixed',
      rivals: ['rival-ines', 'rival-bronn'], minLevel: 8, purseMult: 1.3, sponsor: 'Kestrel Motorsport', trophy: { name: 'The Endurance Globe' },
      rules: { wear: 1.5, fuel: 1.3, damage: true, mandatoryPitStops: 2 },
      rewards: { unlocks: { parts: ['aero.wings:biplane'] } },
      rounds: [
        R('forge-ring', 12, { name: 'Prologue of Eisenwald' }),
        R('neon-harbour', 18, { name: 'Marina 6 Hours', timeOfDay: 'night' }),
        R('akagane-pass', 12, { name: 'Akagane Endurance', weather: 'variable' }),
        R('forge-speedway', 30, { name: 'Speedway 1000', desc: 'One thousand kilometres of flat-out speedway. Fuel saving wins.' }),
        R('forge-ring', 18, { name: '24 Hours of Eisenwald', weather: 'random', timeOfDay: 'night', difficultyBump: 0.05, rules: { mandatoryPitStops: 3 },
          desc: 'The big one. Day into night, dry into wet, three mandatory stops.' })
      ]
    },
    {
      id: 'wec-night-trilogy', tier: 'world-endurance', name: 'Night Endurance Trilogy', short: 'Night Trilogy', eventType: 'endurance', pointsSystem: 'endurance',
      desc: 'Three endurance races that run entirely after sunset. Headlights, tired eyes and a pit lane lit like a runway.',
      requirements: { maxPower_hp: 800 }, opponents: 9, field: 'mixed', rivals: ['rival-ines'], minLevel: 7, purseMult: 1,
      sponsor: 'Mirage Autosport', trophy: { name: 'The Midnight Sun' },
      rules: { wear: 1.25, fuel: 1.1, damage: true, mandatoryPitStops: 1 },
      rewards: { unlocks: { parts: ['exterior.lights:laser'] } },
      rounds: [
        R('neon-harbour', 14, { name: 'Neon Midnight 3h', timeOfDay: 'night' }),
        R('porto-vecchio', 14, { name: 'Vecchio by Lamplight', timeOfDay: 'night', weather: 'variable' }),
        R('forge-ring', 10, { name: 'Darkness at Eisenwald', timeOfDay: 'night', weather: 'random' })
      ]
    },
    {
      id: 'wec-hybrid-efficiency', tier: 'world-endurance', name: 'Hybrid Efficiency Challenge', short: 'Hybrid', eventType: 'endurance', pointsSystem: 'endurance',
      desc: 'Hybrid-only endurance with a strict fuel allowance. The fastest car is the one that uses the least.',
      requirements: { engineTypes: ['hybrid'] }, opponents: 9, field: 'similar', rivals: ['rival-bronn'], minLevel: 8, purseMult: 1.05,
      sponsor: 'Nordlys Works', trophy: { name: 'The Green Flag' },
      rules: { wear: 1.2, fuel: 1.5, fuelAllowance: 0.85, damage: true, mandatoryPitStops: 1 },
      rewards: { unlocks: { parts: ['engine.aspiration:electric-turbo'] } },
      rounds: [
        R('forge-ring', 10, { name: 'Efficiency Prologue' }),
        R('ouroboros', 22, { name: 'Figure-8 Fuel Run' }),
        R('neon-harbour', 14, { name: 'Neon Economy Run', timeOfDay: 'dusk' })
      ]
    },

    /* ------------------------------------------------------------ Tier 5: Hypercar Masters */
    {
      id: 'hyper-masters', tier: 'hypercar', name: 'Hypercar Masters World Championship', short: 'Masters', eventType: 'race', pointsSystem: 'masters',
      desc: 'The crown jewel. Hypercars over 900 hp on six of the world\'s great circuits. The finale pays double. Seraphine Kord has not lost in two years.',
      requirements: { bodyStyles: ['hypercar'], minPower_hp: 900 }, opponents: 11, field: 'mixed', rivals: ['rival-sable'], minLevel: 9, purseMult: 1.4,
      sponsor: 'Kord Hyperwerk', trophy: { name: 'The Masters Crown' },
      rewards: { unlocks: { parts: ['engine.layout:W16'] }, credits: 250000 },
      rounds: [
        R('forge-ring', 5, { name: 'Masters Opener' }),
        R('porto-vecchio', 8, { name: 'Vecchio Masters', weather: 'variable' }),
        R('akagane-pass', 4, { name: 'Mountain Masters' }),
        R('forge-speedway', 12, { name: 'Speedway Masters', desc: 'Four hundred km/h on the banking. Slipstream at your own risk.' }),
        R('neon-harbour', 8, { name: 'Masters Night', timeOfDay: 'night' }),
        R('forge-ring', 6, { name: 'Grand Finale', weather: 'random', difficultyBump: 0.05, desc: 'Double points. Everything on the line.' })
      ]
    },
    {
      id: 'hyper-e-invitational', tier: 'hypercar', name: 'Hyper-E Invitational', short: 'Hyper-E', eventType: 'race', pointsSystem: 'f1',
      desc: 'Electric hypercars with more than 1200 hp. Zero emissions, zero mercy, three-second zero-to-hundred starts every time.',
      requirements: { engineTypes: ['ev'], minPower_hp: 1200 }, opponents: 9, field: 'similar', rivals: ['rival-bronn'], minLevel: 9, purseMult: 1.2,
      sponsor: 'Fjordvolt Energy', trophy: { name: 'The Thunderbolt' },
      rounds: [
        R('neon-harbour', 6, { name: 'Hyper-E Night', timeOfDay: 'night' }),
        R('forge-ring', 4, { name: 'Hyper-E Ring' }),
        R('drag-strip', 1, { name: 'Hyper-E Drag', eventType: 'drag', desc: 'Special round: heads-up quarter-mile — instant torque vs instant torque.' }),
        R('porto-vecchio', 7, { name: 'Hyper-E Finale', weather: 'variable' })
      ]
    },
    {
      id: 'hyper-velocity-kings', tier: 'hypercar', name: 'Velocity Kings', short: 'Velocity', eventType: 'time-attack', pointsSystem: 'attack',
      desc: 'Top speed, quarter-miles and flying laps. Pure velocity — no wheel-to-wheel racing, only the numbers.',
      requirements: { minPower_hp: 1000 }, opponents: 8, field: 'mixed', rivals: ['rival-sable'], minLevel: 10, purseMult: 1.1,
      sponsor: 'Helix Dynamics', trophy: { name: 'The Velocity Shield' },
      rounds: [
        R('forge-speedway', 3, { name: 'Banking Blast', desc: 'Flying laps on the speedway. Low drag, high nerve.' }),
        R('drag-strip', 1, { name: 'Kilometre Sprint', eventType: 'drag', rules: { distance_m: 1000 }, desc: 'Standing kilometre, heads-up.' }),
        R('forge-ring', 3, { name: 'Ring Record Attempt' })
      ]
    },
    {
      id: 'hyper-unlimited', tier: 'hypercar', name: 'Redline Unlimited Grand Prix', short: 'Unlimited', eventType: 'race', pointsSystem: 'f1',
      desc: 'No rules. No balance of performance. Build the fastest car the Garage can make and race it against the best drivers alive.',
      requirements: {}, opponents: 11, field: 'presets', rivals: ['rival-sable', 'rival-ines'], minLevel: 11, purseMult: 1.5,
      sponsor: 'Redline', trophy: { name: 'The Unlimited Anvil' }, requires: [{ champ: 'hyper-masters', complete: true }],
      rewards: { credits: 500000 },
      rounds: [
        R('forge-ring', 6, { name: 'Unlimited Eisenwald' }),
        R('akagane-pass', 5, { name: 'Unlimited Akagane', timeOfDay: 'dusk' }),
        R('neon-harbour', 8, { name: 'Unlimited Neon', timeOfDay: 'night', weather: 'variable' }),
        R('porto-vecchio', 9, { name: 'Unlimited Vecchio' }),
        R('forge-ring', 8, { name: 'The Last Grand Prix', weather: 'random', difficultyBump: 0.06 })
      ]
    }
  ];

  /* Special events: one-off invitationals, rivals duels and manufacturer challenges (listed in catalog.events). */
  var EVENTS = [
    /* Rivals duels — best-of series, 1v1 */
    { id: 'duel-kade', tier: 'rookie', kind: 'event', eventType: 'rivals', rival: 'rival-kade', pointsSystem: 'duel', name: 'Duel: The Heir',
      desc: 'Kade Ashworth wants a private best-of-three. Loser washes the winner\'s car — in front of the whole paddock.',
      requirements: { maxPower_hp: 360 }, requires: [{ champ: 'rookie-sunday-cup', roundsDone: 2 }], minLevel: 1, purse: 12000, xp: 1500,
      rounds: [R('little-anvil', 5, { name: 'Leg 1 · Little Anvil' }), R('porto-vecchio', 2, { name: 'Leg 2 · Porto Vecchio' }), R('ouroboros', 3, { name: 'Leg 3 · Ouroboros' })] },
    { id: 'duel-yuki', tier: 'national', kind: 'event', eventType: 'rivals', rival: 'rival-yuki', pointsSystem: 'duel', name: 'Duel: Ghost of Akagane',
      desc: 'Midnight on the pass. A touge battle against Yuki Saranome — best of three runs.',
      requirements: { drivetrain: ['rwd', 'awd'] }, requires: [{ champ: 'rookie-drift-initiation', complete: true }], minLevel: 3, purse: 30000, xp: 4000,
      rounds: [R('akagane-pass', 1, { name: 'Downhill', timeOfDay: 'night' }), R('akagane-pass', 1, { name: 'Uphill', timeOfDay: 'night' }), R('akagane-pass', 1, { name: 'Decider', timeOfDay: 'night', weather: 'damp' })] },
    { id: 'duel-tomas', tier: 'national', kind: 'event', eventType: 'rivals', rival: 'rival-tomas', pointsSystem: 'duel', name: 'Duel: Midnight King',
      desc: 'Tomás Ruiz-Delgado puts the docks\' crown on the line. Three runs — drag, street, drag.',
      requirements: { minPower_hp: 350 }, requires: [{ champ: 'national-midnight-drag', roundsDone: 2 }], minLevel: 3, purse: 35000, xp: 4000,
      rounds: [R('drag-strip', 1, { name: 'Strip Run', eventType: 'drag', timeOfDay: 'night' }), R('neon-harbour', 2, { name: 'Harbour Chase', timeOfDay: 'night' }), R('drag-strip', 1, { name: 'Crown Run', eventType: 'drag', timeOfDay: 'night' })] },
    { id: 'duel-bronn', tier: 'continental', kind: 'event', eventType: 'rivals', rival: 'rival-bronn', pointsSystem: 'duel', name: 'Duel: The Controlled Experiment',
      desc: 'Bronn Halvorsen proposes a controlled experiment: you, him, five races, identical conditions. The data will decide.',
      requirements: {}, requires: [{ champ: 'continental-gt3', roundsDone: 3 }], minLevel: 5, purse: 70000, xp: 9000,
      rounds: [R('forge-ring', 2, { name: 'Trial 1' }), R('porto-vecchio', 3, { name: 'Trial 2' }), R('akagane-pass', 2, { name: 'Trial 3' }), R('neon-harbour', 3, { name: 'Trial 4', timeOfDay: 'night' }), R('forge-ring', 2, { name: 'Trial 5', weather: 'random' })] },
    { id: 'duel-ines', tier: 'world-endurance', kind: 'event', eventType: 'rivals', rival: 'rival-ines', pointsSystem: 'duel', name: 'Duel: Teacher and Student',
      desc: 'Inès Duvalier challenges her protégé to three long races. Tyres, fuel and patience — just the two of you.',
      requirements: {}, requires: [{ champ: 'wec-gt', roundsDone: 2 }], minLevel: 7, purse: 140000, xp: 18000, rules: { wear: 1.3, fuel: 1.2, damage: true, mandatoryPitStops: 1 },
      rounds: [R('forge-ring', 8, { name: 'First Lesson', eventType: 'endurance' }), R('porto-vecchio', 12, { name: 'Second Lesson', eventType: 'endurance', timeOfDay: 'dusk' }), R('forge-ring', 10, { name: 'Final Exam', eventType: 'endurance', timeOfDay: 'night' })] },
    { id: 'duel-sable', tier: 'hypercar', kind: 'event', eventType: 'rivals', rival: 'rival-sable', pointsSystem: 'duel', name: 'Duel: The Fastest on Earth',
      desc: 'No grid, no field, no excuses. Seraphine "Sable" Kord, best of five, the two fastest cars on earth.',
      requirements: { minPower_hp: 900 }, requires: [{ champ: 'hyper-masters', roundsDone: 3 }], minLevel: 9, purse: 300000, xp: 40000,
      rounds: [R('forge-ring', 3, { name: 'Act I' }), R('forge-speedway', 5, { name: 'Act II' }), R('akagane-pass', 2, { name: 'Act III', timeOfDay: 'night' }), R('porto-vecchio', 4, { name: 'Act IV', weather: 'variable' }), R('forge-ring', 4, { name: 'Act V', weather: 'random' })] },

    /* Manufacturer challenges — build to a brief */
    { id: 'mfr-kestrel-featherweight', tier: 'rookie', kind: 'event', eventType: 'manufacturer', pointsSystem: 'f1', name: 'Kestrel Featherweight Brief',
      desc: 'Kestrel Motorsport wants a featherweight roadster: four cylinders, natural aspiration, under 1100 kg. Win their invitational and they will remember you.',
      brief: { manufacturer: 'Kestrel Motorsport', text: 'Roadster. Inline-four, naturally aspirated. Under 1100 kg. Under 260 hp.' },
      requirements: { bodyStyles: ['roadster'], engineLayouts: ['I4', 'flat-4'], aspirations: ['na'], maxWeight_kg: 1100, maxPower_hp: 260 },
      minLevel: 2, opponents: 6, field: 'similar', purse: 18000, xp: 2500,
      rounds: [R('akagane-pass', 2, { name: 'Featherweight Climb' }), R('little-anvil', 8, { name: 'Featherweight Sprint' })] },
    { id: 'mfr-hanzo-rotary', tier: 'national', kind: 'event', eventType: 'manufacturer', pointsSystem: 'f1', name: 'Hanzo Rotary Heritage',
      desc: 'Hanzo Speed Lab celebrates fifty years of the rotary. Twin-rotor engines only, rear-wheel drive, revs to the moon.',
      brief: { manufacturer: 'Hanzo Speed Lab', text: 'Rotary-2 engine. Rear-wheel drive. Coupé or roadster.' },
      requirements: { engineLayouts: ['rotary-2'], drivetrain: ['rwd'], bodyStyles: ['coupe', 'roadster'] },
      minLevel: 4, opponents: 7, field: 'similar', purse: 40000, xp: 5000, rewards: { unlocks: { parts: ['engine.layout:rotary-2'] } },
      rounds: [R('akagane-pass', 3, { name: 'Rotary Run', timeOfDay: 'night' }), R('neon-harbour', 4, { name: 'Rotary Night', timeOfDay: 'night' }), R('forge-ring', 3, { name: 'Rotary Ring' })] },
    { id: 'mfr-nordlys-wagon', tier: 'continental', kind: 'event', eventType: 'manufacturer', pointsSystem: 'f1', name: 'Nordlys Wagon Wars',
      desc: 'Nordlys Works challenges you to build the fastest family car in Europe: an all-wheel-drive estate with real seats in the back.',
      brief: { manufacturer: 'Nordlys Works', text: 'Wagon or shooting brake. All-wheel drive. Five seats. Anything goes under the bonnet.' },
      requirements: { bodyStyles: ['wagon', 'shooting-brake'], drivetrain: ['awd'], minSeats: 4 },
      minLevel: 5, opponents: 8, field: 'similar', purse: 80000, xp: 9000,
      rounds: [R('forge-ring', 3, { name: 'School Run', weather: 'wet' }), R('porto-vecchio', 4, { name: 'Grocery Dash' }), R('akagane-pass', 2, { name: 'Holiday Pass', weather: 'variable' })] },
    { id: 'mfr-aurelio-v12', tier: 'world-endurance', kind: 'event', eventType: 'manufacturer', pointsSystem: 'f1', name: 'Aurelio V12 Gran Turismo',
      desc: 'Scuderia Aurelio\'s centenary: front-engined V12 grand tourers, racing from Porto Vecchio to Eisenwald.',
      brief: { manufacturer: 'Scuderia Aurelio', text: 'Coupé. V12 engine mounted at the front. Rear-wheel drive. At least 1400 kg — a proper GT.' },
      requirements: { bodyStyles: ['coupe'], engineLayouts: ['V12'], enginePositions: ['front'], drivetrain: ['rwd'], minWeight_kg: 1400 },
      minLevel: 7, opponents: 9, field: 'similar', purse: 160000, xp: 18000, rewards: { unlocks: { parts: ['engine.layout:V12'] } },
      rounds: [R('porto-vecchio', 6, { name: 'Centenario', timeOfDay: 'dusk' }), R('forge-speedway', 10, { name: 'Gran Turismo 500' }), R('forge-ring', 5, { name: 'Aurelio Cup', weather: 'variable' })] },

    /* One-off specials of every remaining type */
    { id: 'special-anvil-knockout', tier: 'rookie', kind: 'event', eventType: 'eliminator', pointsSystem: 'f1', name: 'Little Anvil Knockout',
      desc: 'A single eliminator on the kart circuit. Eight cars, seven laps, one survivor.',
      requirements: { maxPower_hp: 300 }, minLevel: 1, opponents: 7, field: 'mixed', purse: 9000, xp: 1200,
      rounds: [R('little-anvil', 7, { name: 'Knockout' })] },
    { id: 'special-akagane-hillclimb', tier: 'national', kind: 'event', eventType: 'time-attack', pointsSystem: 'attack', name: 'Akagane Hillclimb',
      desc: 'The legendary hillclimb time attack. Three flying laps, one shot at the board.',
      requirements: {}, minLevel: 3, opponents: 8, field: 'mixed', purse: 22000, xp: 3000,
      rounds: [R('akagane-pass', 3, { name: 'Hillclimb', timeOfDay: 'dusk' })] },
    { id: 'special-quarter-mile-shootout', tier: 'national', kind: 'event', eventType: 'drag', pointsSystem: 'f1', name: 'Quarter-Mile Shootout',
      desc: 'Open-class quarter-mile shootout. Two heats and a final, all heads-up.',
      requirements: { minPower_hp: 250 }, minLevel: 3, opponents: 7, field: 'mixed', purse: 20000, xp: 2500,
      rounds: [R('drag-strip', 1, { name: 'Heat', timeOfDay: 'dusk' }), R('drag-strip', 1, { name: 'Final', timeOfDay: 'night' })] },
    { id: 'special-neon-drift-night', tier: 'continental', kind: 'event', eventType: 'drift', pointsSystem: 'drift', name: 'Neon Drift Night',
      desc: 'Drift exhibition under the Neon Harbour skyline. The crowd judges style; the judges judge everything else.',
      requirements: { drivetrain: ['rwd', 'awd'] }, minLevel: 5, opponents: 8, field: 'mixed', purse: 50000, xp: 7000,
      rounds: [R('neon-harbour', 1, { name: 'Exhibition', timeOfDay: 'night' }), R('neon-harbour', 1, { name: 'Battle Final', timeOfDay: 'night', weather: 'damp' })] },
    { id: 'special-eisenwald-6h', tier: 'world-endurance', kind: 'event', eventType: 'endurance', pointsSystem: 'endurance', name: '6 Hours of Eisenwald',
      desc: 'An invitational six-hour on the Redline Ring, compressed for television. Two mandatory stops, unpredictable weather.',
      requirements: {}, minLevel: 7, opponents: 10, field: 'mixed', purse: 150000, xp: 16000, rules: { wear: 1.6, fuel: 1.3, damage: true, mandatoryPitStops: 2 },
      rounds: [R('forge-ring', 16, { name: 'The Six Hours', weather: 'random', timeOfDay: 'dusk' })] },
    { id: 'special-forge-invitational', tier: 'hypercar', kind: 'event', eventType: 'race', pointsSystem: 'masters', name: 'Redline Invitational',
      desc: 'Redline\'s own end-of-season showcase. Every rival you have ever faced, one grid, one race, double points.',
      requirements: {}, minLevel: 10, opponents: 11, field: 'presets', purse: 400000, xp: 50000, allRivals: true,
      requires: [{ champ: 'hyper-masters', complete: true }],
      rounds: [R('forge-ring', 6, { name: 'The Invitational', timeOfDay: 'dusk', weather: 'variable', difficultyBump: 0.06 })] }
  ];

  /* ---------------------------------------------------------- catalog assembly */
  var TIER_BY_ID = {};
  TIERS.forEach(function (t) { TIER_BY_ID[t.id] = t; });
  // Reference car per tier: used by the deterministic simulation for lap / ET / score scales.
  var TIER_REF_PERF = [
    { power_hp: 210, weight_kg: 1250, mu: 0.98, downforce_kg_200: 20, cdA: 0.72 },
    { power_hp: 420, weight_kg: 1380, mu: 1.06, downforce_kg_200: 70, cdA: 0.7 },
    { power_hp: 600, weight_kg: 1320, mu: 1.16, downforce_kg_200: 220, cdA: 0.72 },
    { power_hp: 760, weight_kg: 1250, mu: 1.25, downforce_kg_200: 420, cdA: 0.74 },
    { power_hp: 1250, weight_kg: 1400, mu: 1.3, downforce_kg_200: 500, cdA: 0.7 }
  ];
  var PRIZE_SPLIT = [1, 0.6, 0.4, 0.22, 0.15, 0.1, 0.07, 0.05];
  var XP_SPLIT = [1, 0.65, 0.45, 0.3, 0.22, 0.16, 0.12, 0.1, 0.08, 0.06, 0.05, 0.04];
  var TROPHY_MEDALS = ['gold', 'silver', 'bronze'];

  function tierOf(champ) {
    if (!champ) return null;
    if (isObj(champ.tierDef)) return champ.tierDef;
    return TIER_BY_ID[champ.tier] || (isNum(champ.tier) ? TIERS[champ.tier] : null);
  }

  function seasonFee(champ, tier) {
    if (isNum(champ.entryFee)) return champ.entryFee;
    var E = economy(), per = null, et = champ.eventType || 'race';
    if (E && typeof E.entryFee === 'function') {
      try { per = E.entryFee({ tier: tier.index, difficulty: tier.aiLevel, eventType: et }); } catch (e) { per = null; }
    }
    if (!isNum(per)) per = [0, 1500, 5000, 12000, 30000][tier.index] * ({ endurance: 1.5, rivals: 0.6, 'time-attack': 0.5, drag: 0.4, drift: 0.5, eliminator: 0.9 }[et] || 1);
    // season ticket: every round prepaid at a 20% discount (single events pay full price)
    var n = champ.rounds.length;
    return round(per * n * (champ.kind === 'event' ? 1 : 0.8), 50);
  }

  function finalizeChampionship(c, kind) {
    var tier = TIER_BY_ID[c.tier] || TIERS[0];
    c.kind = kind || c.kind || 'championship';
    c.tierId = tier.id;
    c.tierIndex = tier.index;
    c.tierName = tier.name;
    c.color = c.color || tier.color;
    c.eventType = EVENT_TYPES[c.eventType] ? c.eventType : 'race';
    c.eventTypeName = EVENT_TYPES[c.eventType].name;
    c.pointsSystem = POINTS_SYSTEMS[c.pointsSystem] ? c.pointsSystem : (c.eventType === 'rivals' ? 'duel' : 'f1');
    c.pointsSystemName = POINTS_SYSTEMS[c.pointsSystem].name;
    c.requirements = c.requirements || {};
    c.rules = c.rules || {};
    c.minLevel = Math.max(num(c.minLevel, tier.minLevel), tier.minLevel);
    c.requires = c.requires || [];
    if (c.eventType === 'rivals') {
      c.rivals = [c.rival];
      c.opponents = 1;
      c.field = 'similar';
    } else {
      c.rivals = c.allRivals ? RIVALS.map(function (r) { return r.id; }) : (c.rivals || []);
      c.opponents = clamp(Math.round(num(c.opponents, tier.opponents[1])), 1, 11);
    }
    c.field = c.field || 'mixed';
    c.difficulty = { base: num(c.difficulty && c.difficulty.base, tier.difficulty.base + (c.kind === 'event' ? 0.04 : 0)),
      ramp: num(c.difficulty && c.difficulty.ramp, tier.difficulty.ramp) };
    c.trophy = c.trophy || { name: c.name + ' Trophy' };
    c.trophy.material = c.trophy.material || tier.trophyMaterial;
    c.sponsor = c.sponsor || null;
    c.rounds = c.rounds.map(function (r, i) {
      var et = r.eventType && EVENT_TYPES[r.eventType] ? r.eventType : c.eventType;
      var info = TRACK_INFO[r.trackId] || TRACK_INFO[(TRACK_ALIASES[r.trackId] || [])[0]] || null;
      return {
        index: i, id: c.id + '-r' + (i + 1), name: r.name || ('Round ' + (i + 1)), desc: r.desc || '', trackId: r.trackId,
        trackName: info ? info.name : (r.trackId === 'drag-strip' ? 'Drag Strip' : r.trackId), laps: Math.max(1, Math.round(num(r.laps, 3))),
        weather: r.weather || 'dry', timeOfDay: r.timeOfDay || (info && info.timeOfDay) || 'day', eventType: et, eventTypeName: EVENT_TYPES[et].name,
        opponents: isNum(r.opponents) ? clamp(Math.round(r.opponents), 1, 11) : null, difficultyBump: num(r.difficultyBump, 0),
        prizeMult: num(r.prizeMult, 1) * (i === c.rounds.length - 1 && c.kind !== 'event' ? 1.25 : 1),
        rules: Object.assign({}, c.rules, r.rules || {}), isFinal: i === c.rounds.length - 1, special: et !== c.eventType
      };
    });
    var purse = isNum(c.purse) ? c.purse : round(tier.purse * num(c.purseMult, 1), 500);
    var xp = isNum(c.xp) ? c.xp : round(tier.xpBonus * num(c.purseMult, 1), 50);
    c.prize = {
      purse: purse, xp: xp, roundMult: round((0.85 + tier.index * 0.12) * num(c.purseMult, 1), 0.01),
      positions: PRIZE_SPLIT.map(function (f) { return round(purse * f, 100); }),
      xpPositions: XP_SPLIT.map(function (f) { return round(xp * f, 10); }),
      bonusCredits: num(c.rewards && c.rewards.credits, 0)
    };
    c.entryFee = seasonFee(c, tier);
    c.rewards = c.rewards || {};
    c.rewards.unlocks = c.rewards.unlocks || {};
    c.totalLaps = c.rounds.reduce(function (s, r) { return s + r.laps; }, 0);
    c.trackIds = c.rounds.map(function (r) { return r.trackId; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    c.eventTypes = c.rounds.map(function (r) { return r.eventType; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    c.hasSpecialRounds = c.rounds.some(function (r) { return r.special; });
    c.duelTarget = c.eventType === 'rivals' ? Math.floor(c.rounds.length / 2) + 1 : null;
    c.refPerf = TIER_REF_PERF[tier.index];
    c.tagline = c.tagline || c.desc.split('. ')[0] + (c.desc.indexOf('. ') >= 0 ? '.' : '');
    return c;
  }

  var catalog = (function () {
    var champs = CHAMPIONSHIPS.map(function (c) { return finalizeChampionship(c, 'championship'); });
    var events = EVENTS.map(function (e) { return finalizeChampionship(e, 'event'); });
    var byId = {};
    champs.concat(events).forEach(function (c) { byId[c.id] = c; });
    var tiers = TIERS.map(function (t) {
      var list = champs.filter(function (c) { return c.tier === t.id; });
      t.championships = list;
      t.championshipIds = list.map(function (c) { return c.id; });
      t.events = events.filter(function (e) { return e.tier === t.id; }).map(function (e) { return e.id; });
      t.roundCount = list.reduce(function (s, c) { return s + c.rounds.length; }, 0);
      return t;
    });
    return {
      version: VERSION, tiers: tiers, championships: champs.concat(events), events: events, rivals: RIVALS,
      pointsSystems: POINTS_SYSTEMS, eventTypes: EVENT_TYPES, trackAliases: TRACK_ALIASES, storyBeats: STORY_BEATS, byId: byId,
      trackPlaceholderNote: 'Track ids are CB.race.tracks.list ids; "drag-strip" / "skidpad" are aliases resolved at runtime (resolveTrackId).'
    };
  })();

  function getTier(idOrIndex) { return isNum(idOrIndex) ? TIERS[idOrIndex] || null : TIER_BY_ID[idOrIndex] || null; }
  function getChampionship(id) { return isObj(id) && id.id ? (catalog.byId[id.id] || id) : catalog.byId[id] || null; }
  /** listChampionships({tier, eventType, kind, rival, track}) */
  function listChampionships(f) {
    f = f || {};
    return catalog.championships.filter(function (c) {
      if (f.tier != null && c.tier !== f.tier && c.tierIndex !== f.tier) return false;
      if (f.kind && c.kind !== f.kind) return false;
      if (f.eventType && c.eventTypes.indexOf(f.eventType) < 0) return false;
      if (f.rival && c.rivals.indexOf(f.rival) < 0) return false;
      if (f.track && c.trackIds.indexOf(f.track) < 0) return false;
      return true;
    });
  }

  /* ======================================================================
     Eligibility
     ====================================================================== */
  function listify(v) { return v == null ? null : Array.isArray(v) ? v : [v]; }
  function titleCase(s) { return String(s).replace(/[-_]/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function labelList(l, upper) { return l.map(function (x) { return upper ? String(x).toUpperCase() : titleCase(x); }).join(' / '); }
  function fmtInt(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  var REQ_DEFS = [
    { key: 'maxPower_hp', label: 'Max power', test: function (v, ctx) { return ctx.m.power_hp <= v + 0.5; },
      value: function (ctx) { return Math.round(ctx.m.power_hp) + ' hp'; }, limit: function (v) { return '≤ ' + fmtInt(v) + ' hp'; },
      reason: function (v, ctx) { return 'Power ' + fmtInt(ctx.m.power_hp) + ' hp exceeds the ' + fmtInt(v) + ' hp limit (−' + fmtInt(ctx.m.power_hp - v) + ' hp needed)'; },
      fix: 'Detune the engine, change aspiration or reduce displacement.' },
    { key: 'minPower_hp', label: 'Min power', test: function (v, ctx) { return ctx.m.power_hp >= v - 0.5; },
      value: function (ctx) { return Math.round(ctx.m.power_hp) + ' hp'; }, limit: function (v) { return '≥ ' + fmtInt(v) + ' hp'; },
      reason: function (v, ctx) { return 'Needs at least ' + fmtInt(v) + ' hp (you have ' + fmtInt(ctx.m.power_hp) + ' hp)'; }, fix: 'Add power: tune, boost or a bigger engine.' },
    { key: 'minWeight_kg', label: 'Min weight', test: function (v, ctx) { return ctx.m.weight_kg >= v - 0.5; },
      value: function (ctx) { return Math.round(ctx.m.weight_kg) + ' kg'; }, limit: function (v) { return '≥ ' + fmtInt(v) + ' kg'; },
      reason: function (v, ctx) { return 'Weight ' + fmtInt(ctx.m.weight_kg) + ' kg is below the ' + fmtInt(v) + ' kg minimum (add ' + fmtInt(v - ctx.m.weight_kg) + ' kg ballast)'; },
      fix: 'Add ballast in the Weight panel.' },
    { key: 'maxWeight_kg', label: 'Max weight', test: function (v, ctx) { return ctx.m.weight_kg <= v + 0.5; },
      value: function (ctx) { return Math.round(ctx.m.weight_kg) + ' kg'; }, limit: function (v) { return '≤ ' + fmtInt(v) + ' kg'; },
      reason: function (v, ctx) { return 'Weight ' + fmtInt(ctx.m.weight_kg) + ' kg exceeds the ' + fmtInt(v) + ' kg maximum (shed ' + fmtInt(ctx.m.weight_kg - v) + ' kg)'; },
      fix: 'Lighter chassis material, delete rear seats, thin glass.' },
    { key: 'maxPowerToWeight', label: 'Power-to-weight', test: function (v, ctx) { return ctx.m.power_hp / (ctx.m.weight_kg / 1000) <= v; },
      value: function (ctx) { return Math.round(ctx.m.power_hp / (ctx.m.weight_kg / 1000)) + ' hp/t'; }, limit: function (v) { return '≤ ' + v + ' hp/t'; },
      reason: function (v, ctx) { return 'Power-to-weight ' + Math.round(ctx.m.power_hp / (ctx.m.weight_kg / 1000)) + ' hp/t exceeds ' + v + ' hp/t'; }, fix: 'Less power or more ballast.' },
    { key: 'bodyStyles', label: 'Body style', list: true, path: 'body.style', reasonPrefix: 'Body style must be ', fix: 'Change the body style in the Body panel.' },
    { key: 'drivetrain', label: 'Drivetrain', list: true, path: 'drivetrain.layout', upper: true, reasonPrefix: 'Drivetrain must be ', fix: 'Change drivetrain layout.' },
    { key: 'engineTypes', label: 'Powertrain', list: true, path: 'engine.type', reasonPrefix: 'Powertrain must be ', fix: 'Switch engine type (ICE / hybrid / EV).',
      names: { ice: 'Combustion', ev: 'Electric', hybrid: 'Hybrid' } },
    { key: 'engineLayouts', label: 'Engine', list: true, path: 'engine.layout', upper: false, reasonPrefix: 'Engine must be ', fix: 'Pick an allowed engine layout.', skipIfEv: true },
    { key: 'aspirations', label: 'Aspiration', list: true, path: 'engine.aspiration', reasonPrefix: 'Aspiration must be ', fix: 'Change aspiration.', skipIfEv: true,
      names: { na: 'Naturally aspirated' } },
    { key: 'enginePositions', label: 'Engine position', list: true, path: 'engine.position', reasonPrefix: 'Engine must be mounted ', fix: 'Move the engine.' },
    { key: 'tireCompounds', label: 'Tyres', list: true, path: 'tires.compound', reasonPrefix: 'Tyres must be ', fix: 'Change tyre compound.' },
    { key: 'transmissions', label: 'Gearbox', list: true, path: 'transmission.type', reasonPrefix: 'Gearbox must be ', fix: 'Change transmission.' },
    { key: 'chassisMaterials', label: 'Chassis', list: true, path: 'body.chassisMaterial', reasonPrefix: 'Chassis must be ', fix: 'Change chassis material.' },
    { key: 'fuels', label: 'Fuel', list: true, path: 'engine.fuel', reasonPrefix: 'Fuel must be ', fix: 'Change fuel.', skipIfEv: true },
    { key: 'wings', label: 'Rear wing', list: true, path: 'aero.wing', reasonPrefix: 'Rear wing must be ', fix: 'Change the wing in the Aero panel.' },
    { key: 'maxDisplacement_l', label: 'Displacement', test: function (v, ctx) { return get(ctx.b, 'engine.type') === 'ev' || num(get(ctx.b, 'engine.displacement_l'), 0) <= v + 1e-6; },
      value: function (ctx) { return num(get(ctx.b, 'engine.displacement_l'), 0).toFixed(1) + ' L'; }, limit: function (v) { return '≤ ' + v.toFixed(1) + ' L'; },
      reason: function (v, ctx) { return 'Displacement ' + num(get(ctx.b, 'engine.displacement_l'), 0).toFixed(1) + ' L exceeds ' + v.toFixed(1) + ' L'; }, fix: 'Reduce displacement.' },
    { key: 'minSeats', label: 'Seats', test: function (v, ctx) { return num(get(ctx.b, 'body.seats'), 2) >= v && get(ctx.b, 'weight.rearSeats') !== false; },
      value: function (ctx) { return num(get(ctx.b, 'body.seats'), 2) + ' seats'; }, limit: function (v) { return '≥ ' + v + ' seats'; },
      reason: function (v) { return 'Needs at least ' + v + ' usable seats (rear seats fitted)'; }, fix: 'Choose more seats and keep the rear seats.' },
    { key: 'maxBattery_kwh', label: 'Battery', test: function (v, ctx) { return get(ctx.b, 'engine.type') === 'ice' || num(get(ctx.b, 'engine.battery_kwh'), 0) <= v; },
      value: function (ctx) { return num(get(ctx.b, 'engine.battery_kwh'), 0) + ' kWh'; }, limit: function (v) { return '≤ ' + v + ' kWh'; },
      reason: function (v) { return 'Battery larger than ' + v + ' kWh'; }, fix: 'Reduce battery capacity.' },
    { key: 'maxTopSpeed_kph', label: 'Top speed', test: function (v, ctx) { return !isNum(ctx.m.topSpeed_kph) || ctx.m.topSpeed_kph <= v; },
      value: function (ctx) { return isNum(ctx.m.topSpeed_kph) ? Math.round(ctx.m.topSpeed_kph) + ' km/h' : '—'; }, limit: function (v) { return '≤ ' + v + ' km/h'; },
      reason: function (v, ctx) { return 'Top speed ' + Math.round(ctx.m.topSpeed_kph) + ' km/h exceeds ' + v + ' km/h'; }, fix: 'Add drag or shorten the gearing.' },
    { key: 'maxPrice', label: 'Car value', test: function (v, ctx) { return ctx.price() <= v; },
      value: function (ctx) { return fmtCredits(ctx.price()); }, limit: function (v) { return '≤ ' + fmtCredits(v); },
      reason: function (v, ctx) { return 'Car value ' + fmtCredits(ctx.price()) + ' exceeds the ' + fmtCredits(v) + ' cap'; }, fix: 'Remove expensive options.' },
    { key: 'streetLegal', label: 'Street legal', test: function (v, ctx) {
      if (!v || !CB.rules || typeof CB.rules.legality !== 'function') return true;
      try { return !!CB.rules.legality(ctx.b).streetLegal; } catch (e) { return true; }
    }, value: function () { return ''; }, limit: function () { return 'Required'; }, reason: function () { return 'Car must be street legal'; }, fix: 'Resolve the legality issues in the summary.' }
  ];

  /**
   * checkEligibility(build, championship|id, opts {metrics, profile}) ->
   *   {ok, reasons[], checks:[{key, label, ok, value, limit, reason?, fix?}], metrics, summary}
   */
  function checkEligibility(build, champ, opts) {
    opts = opts || {};
    champ = getChampionship(champ) || champ;
    var req = (champ && (champ.requirements || champ.entry)) || {};
    if (!isObj(build)) return { ok: false, reasons: ['No car selected — buy or select a car in My Cars'], checks: [], metrics: null, summary: 'No car' };
    var m = metricsFor(build, opts.metrics);
    var priceCache = null;
    var ctx = { b: build, m: m, price: function () { if (priceCache === null) priceCache = careerPrice(build); return priceCache; } };
    var isEv = get(build, 'engine.type') === 'ev';
    var checks = [], reasons = [];
    REQ_DEFS.forEach(function (d) {
      if (!hasOwn.call(req, d.key) || req[d.key] == null) return;
      var v = req[d.key], ok, chk;
      if (d.list) {
        var allowed = listify(v);
        if (!allowed.length) return;
        var cur = get(build, d.path);
        // EVs have no cylinders, aspiration or fuel: layout / aspiration briefs exclude them, fuel rules do not apply
        if (d.skipIfEv && isEv) { ok = d.key === 'fuels'; cur = d.key === 'fuels' ? cur : 'electric'; }
        else ok = allowed.indexOf(cur) >= 0;
        var nm = function (x) { return (d.names && d.names[x]) || (d.upper ? String(x).toUpperCase() : titleCase(x)); };
        chk = { key: d.key, label: d.label, ok: ok, value: cur == null ? '—' : nm(cur), limit: allowed.map(nm).join(' / ') };
        if (!ok) { chk.reason = d.reasonPrefix + allowed.map(nm).join(' or ') + (cur != null ? ' (yours: ' + nm(cur) + ')' : ''); chk.fix = d.fix; }
      } else {
        try { ok = !!d.test(v, ctx); } catch (e) { ok = true; }
        chk = { key: d.key, label: d.label, ok: ok, value: d.value(ctx), limit: d.limit(v) };
        if (!ok) { chk.reason = d.reason(v, ctx); chk.fix = d.fix; }
      }
      checks.push(chk);
      if (!ok) reasons.push(chk.reason);
    });
    return { ok: reasons.length === 0, reasons: reasons, checks: checks, metrics: m,
      summary: reasons.length ? reasons.length + ' requirement' + (reasons.length > 1 ? 's' : '') + ' not met' : 'Eligible' };
  }

  /** Human-readable requirement chips for a championship. */
  function requirementLabels(champ) {
    champ = getChampionship(champ) || champ;
    var req = (champ && champ.requirements) || {}, out = [];
    REQ_DEFS.forEach(function (d) {
      if (req[d.key] == null) return;
      if (d.list) {
        var l = listify(req[d.key]);
        if (l.length) out.push(d.label + ': ' + l.map(function (x) { return (d.names && d.names[x]) || (d.upper ? String(x).toUpperCase() : titleCase(x)); }).join(' / '));
      } else if (d.key !== 'streetLegal' || req[d.key]) out.push(d.label + ' ' + d.limit(req[d.key]));
    });
    if (!out.length) out.push('Open regulations');
    return out;
  }

  /* ======================================================================
     Career state (stored in profile.career)
     ====================================================================== */
  var LOG_MAX = 80;
  var STATS_KEYS = ['rounds', 'wins', 'podiums', 'poles', 'fastestLaps', 'points', 'titles', 'runnerUps', 'seasons', 'eventsWon',
    'dnfs', 'dns', 'earnings', 'xpEarned', 'feesPaid', 'rivalWins', 'rivalLosses', 'duelsWon', 'duelsLost', 'comebacks', 'cleanRaces'];

  function defaultState(seed) {
    var st = {
      version: VERSION, seed: (isNum(seed) ? seed : hashStr('forge-career-' + now() + '-' + Math.random())) >>> 0,
      createdAt: now(), updatedAt: now(),
      championships: {}, trophies: [], rivals: {}, story: [], stats: {}, log: [],
      unlocked: { tiers: ['rookie'], champs: [] }, tierRewards: {}, titles: []
    };
    STATS_KEYS.forEach(function (k) { st.stats[k] = 0; });
    return st;
  }

  /** Repair / migrate a stored career state in place (tolerant of partial or foreign data). */
  function normalizeState(st) {
    if (!isObj(st)) st = {};
    var d = defaultState(isNum(st.seed) ? st.seed : hashStr(JSON.stringify(st).slice(0, 200) || 'forge'));
    if (!isNum(st.seed)) st.seed = d.seed;
    st.version = VERSION;
    if (!isNum(st.createdAt)) st.createdAt = d.createdAt;
    if (!isObj(st.championships)) st.championships = {};
    if (!Array.isArray(st.trophies)) st.trophies = [];
    if (!isObj(st.rivals)) st.rivals = {};
    if (!Array.isArray(st.story)) st.story = [];
    if (!isObj(st.stats)) st.stats = {};
    STATS_KEYS.forEach(function (k) { if (!isNum(st.stats[k])) st.stats[k] = 0; });
    if (!Array.isArray(st.log)) st.log = [];
    if (!isObj(st.unlocked)) st.unlocked = { tiers: ['rookie'], champs: [] };
    if (!Array.isArray(st.unlocked.tiers)) st.unlocked.tiers = ['rookie'];
    if (!Array.isArray(st.unlocked.champs)) st.unlocked.champs = [];
    if (!isObj(st.tierRewards)) st.tierRewards = {};
    if (!Array.isArray(st.titles)) st.titles = [];
    Object.keys(st.championships).forEach(function (id) {
      var cs = st.championships[id];
      if (!isObj(cs)) { delete st.championships[id]; return; }
      if (!isObj(cs.standings)) cs.standings = {};
      if (!Array.isArray(cs.results)) cs.results = [];
      if (!Array.isArray(cs.history)) cs.history = [];
      if (!isNum(cs.roundsCompleted)) cs.roundsCompleted = cs.results.length;
      if (!isNum(cs.season)) cs.season = 1;
    });
    return st;
  }

  /** Career state for a profile (created on demand — mutates profile.career when missing). */
  function careerOf(profile) {
    if (!isObj(profile)) return normalizeState(defaultState(1));
    if (!isObj(profile.career) || !isNum(profile.career.seed) || !isObj(profile.career.championships)) {
      var seedBase = hashStr(String(profile.createdAt || '') + '|' + String(profile.driverName || 'driver'));
      profile.career = normalizeState(Object.assign(defaultState(seedBase), isObj(profile.career) ? profile.career : {}));
    } else normalizeState(profile.career);
    return profile.career;
  }
  function peekCareer(profile) {
    // read-only access for view functions: never writes into the profile
    if (isObj(profile) && isObj(profile.career) && isNum(profile.career.seed) && isObj(profile.career.championships)) return profile.career;
    var tmp = clone(isObj(profile) ? profile : {});
    return careerOf(tmp);
  }
  function addLog(st, type, text, extra) {
    var e = { t: now(), type: type, text: text };
    if (extra) for (var k in extra) if (hasOwn.call(extra, k)) e[k] = extra[k];
    st.log.push(e);
    if (st.log.length > LOG_MAX) st.log.splice(0, st.log.length - LOG_MAX);
    return e;
  }

  /* ---------------------------------------------------------- profile helpers */
  function playerName(profile) { return (profile && profile.driverName) || 'You'; }
  function activeBuild(profile) {
    if (isObj(profile) && Array.isArray(profile.ownedCars)) {
      var car = null;
      for (var i = 0; i < profile.ownedCars.length; i++) if (profile.ownedCars[i] && profile.ownedCars[i].id === profile.activeCarId) car = profile.ownedCars[i];
      if (!car && profile.ownedCars.length) car = profile.ownedCars[0];
      if (car && isObj(car.build)) return car.build;
    }
    if (CB.state && typeof CB.state.get === 'function') { try { var b = CB.state.get(); if (isObj(b)) return b; } catch (e) { /* none */ } }
    if (CB.data && typeof CB.data.defaultBuild === 'function') { try { return CB.data.defaultBuild(); } catch (e2) { /* none */ } }
    return null;
  }
  function activeCar(profile) {
    if (!isObj(profile) || !Array.isArray(profile.ownedCars)) return null;
    for (var i = 0; i < profile.ownedCars.length; i++) if (profile.ownedCars[i] && profile.ownedCars[i].id === profile.activeCarId) return profile.ownedCars[i];
    return profile.ownedCars[0] || null;
  }

  /* ---------------------------------------------------------- entry car
     Race and Drift drive the current Atelier build. So that the career gives the same answer to
     "what am I driving", a profile with an empty garage gets that build registered as its entry car
     (free, once per career, clamped to the player's part unlocks, no resale value). */
  function liveProfile() {
    var P = profileMod(); if (!P) return null;
    try { return typeof P.peek === 'function' ? P.peek() : P.get(); } catch (e) { return null; }
  }
  function atelierBuild() {
    if (!CB.state || typeof CB.state.get !== 'function') return null;
    try { var b = CB.state.get(); return isObj(b) && isObj(b.body) ? clone(b) : null; } catch (e) { return null; }
  }
  function entryCarName(b) {
    if (CB.shapes && typeof CB.shapes.getModel === 'function') {
      try { var m = CB.shapes.getModel(b, { strict: true }); if (m && (m.name || m.id)) return String((m.make ? m.make + ' ' : '') + (m.name || m.id)).slice(0, 40); } catch (e) { /* fall through */ }
    }
    return (b && typeof b.name === 'string' && b.name.trim()) ? b.name.trim().slice(0, 40) : 'Garage build';
  }
  /** true when the profile has ever owned a car (bought / sold stats, or a purchase in the ledger). */
  function hasOwnedCar(profile) {
    var s = isObj(profile.stats) ? profile.stats : {};
    if (num(s.carsBought, 0) > 0 || num(s.carsSold, 0) > 0) return true;
    var led = Array.isArray(profile.ledger) ? profile.ledger : [];
    for (var i = 0; i < led.length; i++) {
      var e = led[i];
      if (isObj(e) && (e.category === 'car' || e.category === 'car-sale' || /^(Purchase|Sold) \u00b7/.test(String(e.reason || '')))) return true;
    }
    return false;
  }
  /** entryCarOffer(profile?) -> {build, name, changes} when the garage is empty and the entry car is still available, else null. */
  function entryCarOffer(profile) {
    profile = isObj(profile) ? profile : liveProfile();
    if (!isObj(profile)) return null;
    if (Array.isArray(profile.ownedCars) && profile.ownedCars.length) return null;
    if (isObj(profile.career) && profile.career.entryCar) return null;
    // the free entry car is a first-garage welcome only: anybody who has ever bought (or sold) a car has to buy the next one
    if (hasOwnedCar(profile)) return null;
    var b = atelierBuild(); if (!b) return null;
    var changes = [], E = economy();
    if (E && typeof E.clampBuildToUnlocks === 'function') {
      try {
        var r = E.clampBuildToUnlocks(profile, b);
        if (isObj(r) && isObj(r.build)) { b = r.build; changes = Array.isArray(r.changes) ? r.changes : []; }
        else if (isObj(r) && isObj(r.body)) b = r;
      } catch (e) { /* keep the raw build */ }
    }
    var nm = entryCarName(b);
    // the build's own name came from the Garage ("Porsche 911 Carrera S"); once it is clamped to the player's unlocks it is
    // no longer that spec, so every screen (race setup "Your machine", My Cars) names it like the career car
    if (isObj(b.meta)) { b = clone(b); b.meta.name = nm; }
    return { build: b, name: nm, changes: changes };
  }
  /** registerAtelierBuild(): add the entry car to the live profile's garage. -> {ok, car?, reason?} */
  function registerAtelierBuild() {
    var P = profileMod();
    if (!P || typeof P.addCar !== 'function') return { ok: false, reason: 'Profile unavailable' };
    var offer = entryCarOffer(liveProfile());
    if (!offer) return { ok: false, reason: 'Nothing to register' };
    var car = null;
    P.update(function (p) {
      if (Array.isArray(p.ownedCars) && p.ownedCars.length) return;
      // purchasedFor 1 → resale basis ~0: the free entry car can't be flipped for credits
      car = P.addCar(offer.build, { name: offer.name, purchasedFor: 1, setActive: true });
      if (!car) return;
      var st = careerOf(p);
      st.entryCar = { carId: car.id, name: offer.name, at: now() };
      addLog(st, 'garage', 'Registered your Garage build — ' + offer.name + ' — as your entry car.');
    }, { reason: 'career-entry-car' });
    return car ? { ok: true, car: car, changes: offer.changes } : { ok: false, reason: 'My Cars unavailable' };
  }
  /** Championships the player is currently contesting (status 'active', not complete). -> [champ] */
  function activeSeasons(profile) {
    var st = isObj(profile) && isObj(profile.career) && isObj(profile.career.championships) ? profile.career.championships : {};
    return Object.keys(st).filter(function (id) { var cs = st[id]; return isObj(cs) && cs.status === 'active' && !cs.complete; })
      .map(function (id) { return getChampionship(id); }).filter(Boolean);
  }
  /**
   * canSellCar(profile, carId) -> {ok, reason?, championships?}
   * Selling the only car in the garage mid-season is blocked: the season can't carry on without a car, and the
   * free entry car is a first-garage welcome only (it is never re-granted after a sale).
   */
  function canSellCar(profile, carId) {
    profile = isObj(profile) ? profile : liveProfile();
    if (!isObj(profile)) return { ok: true };
    var cars = Array.isArray(profile.ownedCars) ? profile.ownedCars.filter(Boolean) : [];
    if (cars.length > 1 || (carId != null && !cars.some(function (c) { return c.id === carId; }))) return { ok: true };
    var live = activeSeasons(profile);
    if (!live.length) return { ok: true };
    var names = live.map(function (c) { return c.name; });
    return { ok: false, championships: live.map(function (c) { return c.id; }),
      reason: 'This is your only car and you are mid-season in ' + names.join(', ') + '. Buy another car first, or withdraw from the championship' + (names.length > 1 ? 's' : '') + '.' };
  }
  /** Garage emptied after the player has owned a car (sold it): career rounds need a car — no free replacement. */
  function needsCar(profile) {
    return isObj(profile) && Array.isArray(profile.ownedCars) && !profile.ownedCars.length && hasOwnedCar(profile) && !entryCarOffer(profile);
  }
  var entryPending = false;
  /** Called from state(): views stay read-only, the registration runs on the next tick (browser only). */
  function scheduleEntryCar(profile) {
    if (entryPending || typeof window === 'undefined' || typeof document === 'undefined' || typeof setTimeout !== 'function') return;
    // only while the player is looking at the career (the garage keeps a snapshot, so take it as late as possible)
    try { if (!/career/i.test(String(window.location && window.location.hash || ''))) return; } catch (e) { return; }
    if (!isObj(profile) || (Array.isArray(profile.ownedCars) && profile.ownedCars.length)) return;
    var live = liveProfile();
    if (!live || (profile !== live && profile.id !== live.id) || !entryCarOffer(live)) return;
    entryPending = true;
    setTimeout(function () { entryPending = false; try { registerAtelierBuild(); } catch (e) { /* non-fatal */ } }, 0);
  }

  /** Apply credits / xp directly to a (mutable) profile object. Mirrors CB.game.profile semantics. */
  function applyAward(profile, credits, xp, reason, category) {
    var out = { credits: 0, xp: 0, levelUp: false, oldLevel: profileLevel(profile), newLevel: profileLevel(profile) };
    if (!isObj(profile)) return out;
    credits = Math.round(num(credits, 0));
    xp = Math.max(0, Math.round(num(xp, 0)));
    if (credits) {
      var before = num(profile.credits, 0);
      profile.credits = Math.max(0, before + credits);
      out.credits = profile.credits - before;
      if (!isObj(profile.stats)) profile.stats = {};
      if (out.credits > 0) profile.stats.creditsEarned = num(profile.stats.creditsEarned, 0) + out.credits;
      else profile.stats.creditsSpent = num(profile.stats.creditsSpent, 0) - out.credits;
      if (Array.isArray(profile.ledger)) {
        profile.ledger.push({ id: 'tx_c' + hashStr(reason + now() + profile.ledger.length).toString(36), t: now(), amount: out.credits, reason: String(reason || 'career').slice(0, 120),
          balance: profile.credits, kind: out.credits >= 0 ? 'credit' : 'debit', category: category || 'career' });
        if (profile.ledger.length > 200) profile.ledger.splice(0, profile.ledger.length - 200);
      }
    }
    if (xp) {
      profile.xp = num(profile.xp, 0) + xp;
      if (isObj(profile.stats)) profile.stats.xpEarned = num(profile.stats.xpEarned, 0) + xp;
      profile.level = Math.max(num(profile.level, 1), levelForXp(profile.xp));
      out.xp = xp;
    }
    out.newLevel = profileLevel(profile);
    out.levelUp = out.newLevel > out.oldLevel;
    return out;
  }
  function grantUnlocks(profile, unlocks) {
    var granted = [];
    if (!isObj(profile) || !isObj(unlocks)) return granted;
    if (!isObj(profile.unlocks)) profile.unlocks = { parts: [], tracks: [], bodyStyles: [] };
    ['parts', 'tracks', 'bodyStyles'].forEach(function (k) {
      if (!Array.isArray(profile.unlocks[k])) profile.unlocks[k] = [];
      (unlocks[k] || []).forEach(function (id) {
        if (profile.unlocks[k].indexOf(id) < 0) { profile.unlocks[k].push(id); granted.push({ kind: k, id: id, name: unlockName(k, id) }); }
      });
    });
    return granted;
  }
  function unlockName(kind, id) {
    if (kind === 'tracks') return trackInfo(id).name;
    var parts = String(id).split(':'), coll = parts[0], oid = parts[1] || parts[0];
    if (CB.data && typeof CB.data.find === 'function' && parts.length > 1) {
      var collName = coll;
      var E = economy();
      if (E && typeof E.resolveCollection === 'function') { try { collName = E.resolveCollection(coll); } catch (e) { /* keep */ } }
      try { var o = CB.data.find(collName, oid); if (o && o.name) return o.name; } catch (e2) { /* fall back */ }
    }
    return titleCase(oid);
  }

  /* ======================================================================
     Unlocks
     ====================================================================== */
  function tierTrophyCount(st, tierId, maxPos) {
    var seen = {};
    st.trophies.forEach(function (t) { if (t.tierId === tierId && t.position <= maxPos && t.kind !== 'event') seen[t.champId] = 1; });
    Object.keys(st.championships).forEach(function (id) {
      var cs = st.championships[id], c = catalog.byId[id];
      if (!c || c.tier !== tierId || c.kind === 'event') return;
      if (isNum(cs.bestFinish) && cs.bestFinish <= maxPos) seen[id] = 1;
    });
    return Object.keys(seen).length;
  }

  /** Tier unlock -> {ok, reasons[], progress:{trophies, need, level, minLevel}} */
  function tierUnlock(profile, tierId, st) {
    var t = getTier(tierId);
    if (!t) return { ok: false, reasons: ['Unknown tier'] };
    st = st || peekCareer(profile);
    var lvl = profileLevel(profile), reasons = [];
    var forced = st.unlocked.tiers.indexOf(t.id) >= 0 && t.index > 0 && st.unlocked.forced && st.unlocked.forced.indexOf(t.id) >= 0;
    var prog = { level: lvl, minLevel: t.minLevel, trophies: 0, need: 0 };
    if (forced || !t.unlock) return { ok: true, reasons: [], progress: prog };
    if (lvl < t.minLevel) reasons.push('Reach driver level ' + t.minLevel + ' (you are level ' + lvl + ')');
    var prev = getTier(t.unlock.tier);
    prog.trophies = tierTrophyCount(st, t.unlock.tier, t.unlock.maxPosition || 3);
    prog.need = t.unlock.trophies;
    if (prog.trophies < t.unlock.trophies) {
      reasons.push('Finish top ' + (t.unlock.maxPosition || 3) + ' in ' + t.unlock.trophies + ' ' + (prev ? prev.name : '') + ' championship' +
        (t.unlock.trophies > 1 ? 's' : '') + ' (' + prog.trophies + '/' + t.unlock.trophies + ')');
    }
    return { ok: reasons.length === 0, reasons: reasons, progress: prog };
  }
  function isTierUnlocked(profile, tierId) { return tierUnlock(profile, tierId).ok; }

  function requirementMet(st, r) {
    var cs = st.championships[r.champ], c = catalog.byId[r.champ];
    var name = c ? c.name : r.champ;
    if (r.complete) {
      var done = cs && (cs.titles > 0 || cs.history.length > 0 || cs.status === 'complete');
      if (!done) return { ok: false, reason: 'Complete ' + name };
    }
    if (isNum(r.roundsDone)) {
      var n = cs ? Math.max(cs.roundsCompleted, cs.history.length ? 99 : 0) : 0;
      if (n < r.roundsDone) return { ok: false, reason: 'Race ' + r.roundsDone + ' round' + (r.roundsDone > 1 ? 's' : '') + ' of ' + name + ' (' + Math.min(n, r.roundsDone) + '/' + r.roundsDone + ')' };
    }
    if (isNum(r.position)) {
      if (!(cs && isNum(cs.bestFinish) && cs.bestFinish <= r.position)) return { ok: false, reason: 'Finish ' + ordinal(r.position) + ' or better in ' + name };
    }
    return { ok: true };
  }

  /** isUnlocked(profile, id) for a championship, event or tier -> {ok, reasons[]} */
  function isUnlocked(profile, id, st) {
    st = st || peekCareer(profile);
    if (TIER_BY_ID[id]) return tierUnlock(profile, id, st);
    var c = getChampionship(id);
    if (!c) return { ok: false, reasons: ['Unknown championship'] };
    var t = tierUnlock(profile, c.tier, st);
    var reasons = t.ok ? [] : ['Unlock the ' + c.tierName + ' tier: ' + t.reasons.join('; ')];
    var lvl = profileLevel(profile);
    if (lvl < c.minLevel && t.ok) reasons.push('Reach driver level ' + c.minLevel + ' (you are level ' + lvl + ')');
    c.requires.forEach(function (r) { var m = requirementMet(st, r); if (!m.ok) reasons.push(m.reason); });
    return { ok: reasons.length === 0, reasons: reasons };
  }

  /* ======================================================================
     Season setup: field, weather, per-driver form
     ====================================================================== */
  function seasonSeed(st, champ, season) { return hashStr(st.seed + '|' + champ.id + '|s' + season) >>> 0; }

  /** Deterministic grid for a championship season: rivals first, then roster drivers suited to the tier. */
  function fieldFor(champ, careerSeed, season) {
    champ = getChampionship(champ);
    var ros = getRoster();
    var count = champ.opponents;
    var ids = [];
    champ.rivals.forEach(function (rid) { if (ids.length < count && ros.byId[rid]) ids.push(rid); });
    if (ids.length >= count) return ids;
    var pool = ros.list.filter(function (d) { return !d.isRival; }).slice().sort(function (a, b) { return a.talent - b.talent || (a.id < b.id ? -1 : 1); });
    // tier window over the talent ranking: rookies get the bottom of the roster, masters the top
    var n = pool.length, ti = champ.tierIndex;
    var centre = clamp((ti + 0.5) / TIERS.length, 0.1, 0.92) * n, width = n * 0.34;
    var rng = makeRng(hashStr(champ.id + '|field') ^ Math.imul(season || 1, 2654435761) ^ (careerSeed >>> 0));
    var stableRng = makeRng(hashStr(champ.id + '|core'));
    var scored = pool.map(function (d, i) {
      var dist = Math.abs(i - centre) / width;
      // core drivers (stable across seasons) + a seasonal shuffle of the rest
      var w = Math.exp(-dist * dist * 2.2) * (0.55 + stableRng.next() * 0.45) * (0.75 + rng.next() * 0.5);
      if (champ.eventType === 'drift' && d.specialty === 'drift') w *= 1.8;
      if (champ.eventType === 'drag' && d.specialty === 'drag') w *= 1.8;
      if (champ.eventType === 'endurance' && d.specialty === 'endurance') w *= 1.6;
      return { id: d.id, w: w };
    }).sort(function (a, b) { return b.w - a.w || (a.id < b.id ? -1 : 1); });
    for (var i = 0; i < scored.length && ids.length < count; i++) ids.push(scored[i].id);
    return ids;
  }

  var WEATHER_ODDS = { variable: [0.55, 0.3, 0.15], random: [0.4, 0.3, 0.3] };
  function resolveWeather(round, rng) {
    var w = round.weather;
    if (w === 'dry' || w === 'damp' || w === 'wet') return w;
    var odds = WEATHER_ODDS[w] || WEATHER_ODDS.variable, x = rng.next();
    return x < odds[0] ? 'dry' : x < odds[0] + odds[1] ? 'damp' : 'wet';
  }

  function newSeason(st, champ, opts) {
    opts = opts || {};
    var prev = st.championships[champ.id];
    var season = prev ? prev.season + (prev.status === 'idle' && !prev.roundsCompleted ? 0 : 1) : 1;
    if (opts.season) season = opts.season;
    var seed = seasonSeed(st, champ, season);
    var wrng = makeRng(seed ^ 0x5eed);
    var cs = {
      id: champ.id, season: season, status: 'active', enteredAt: now(), feePaid: 0, seed: seed,
      field: fieldFor(champ, st.seed, season), weather: champ.rounds.map(function (r) { return resolveWeather(r, wrng); }),
      roundsCompleted: 0, results: [], standings: {}, complete: false, finalPosition: null, trophy: null,
      bestFinish: prev ? prev.bestFinish : null, titles: prev ? num(prev.titles, 0) : 0, history: prev ? prev.history || [] : [],
      difficultySetting: opts.difficulty || null
    };
    cs.field.forEach(function (id) { cs.standings[id] = emptyRow(id); });
    cs.standings.player = emptyRow('player');
    st.championships[champ.id] = cs;
    return cs;
  }
  function emptyRow(id) {
    return { id: id, points: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, dnfs: 0, starts: 0, finishes: [], pointsByRound: [], best: null };
  }
  /** Active season state (created lazily without charging anything). */
  function seasonOf(st, champ, create) {
    var cs = st.championships[champ.id];
    if (cs && cs.status !== 'complete') return cs;
    if (!create) return cs || null;
    return newSeason(st, champ);
  }
  function viewSeason(st, champ) {
    var cs = st.championships[champ.id];
    if (cs) return cs;
    // a preview season that is never stored (deterministic: same as the one newSeason() will create)
    var tmp = { championships: {}, seed: st.seed };
    return newSeason(tmp, champ);
  }
  /** Season state for a round that is about to be raced: the active season, else a preview of the next one (never stored). */
  function previewSeason(st, champ) {
    var cs = st.championships[champ.id];
    if (cs && cs.status === 'active') return cs;
    var tmp = { championships: {}, seed: st.seed };
    if (cs) tmp.championships[champ.id] = cs;
    return newSeason(tmp, champ, { difficulty: cs && cs.difficultySetting });
  }
  /** The stored, active season (a fresh one is created when there is none / the last one is complete or idle). */
  function activeSeason(st, champ, opts) {
    var cs = st.championships[champ.id];
    if (cs && cs.status === 'active') return cs;
    return newSeason(st, champ, opts);
  }

  /* ======================================================================
     Per-driver form & performance helpers
     ====================================================================== */
  var TRACK_SPECIALTY = {
    'forge-speedway': 'oval', 'porto-vecchio': 'street', 'neon-harbour': 'street',
    'akagane-pass': 'technical', 'forge-ring': 'technical', 'little-anvil': 'street', 'ouroboros': 'oval'
  };
  // Calibration of the ideal-driver lap estimator against real (engine) laps for AI banker laps in time attacks.
  var TA_CALIBRATION = 1.035;

  function seasonForm(driverId, seed) {
    var r = makeRng((hashStr(String(driverId) + '|form') ^ (seed >>> 0)) >>> 0);
    return clamp(r.gauss() * 0.03, -0.075, 0.075);
  }

  /** Effective skill of a driver for one round (talent + specialty + weather + seasonal form). */
  function effectiveSkill(d, rd, weather, seed) {
    var s = num(d.talent, 0.5), et = rd.eventType, spec = d.specialty, cons = num(d.consistency, 0.7);
    var tid = resolveTrackId(rd.trackId);
    if (spec === 'wet' && weather !== 'dry') s += weather === 'wet' ? 0.08 : 0.04;
    if (spec && spec === TRACK_SPECIALTY[tid] && (et === 'race' || et === 'endurance' || et === 'eliminator' || et === 'manufacturer' || et === 'rivals')) s += 0.035;
    if (spec === 'endurance' && et === 'endurance') s += 0.05;
    if (spec === 'drift' && et === 'drift') s += 0.09;
    if (spec === 'drag' && et === 'drag') s += 0.09;
    if (spec === 'qualifier' && et === 'time-attack') s += 0.05;
    if (spec === 'allrounder') s += 0.015;
    if (weather !== 'dry') s -= (1 - cons) * (weather === 'wet' ? 0.08 : 0.035);
    if (d.isRival) s += 0.02;
    return s + seasonForm(d.id, seed);
  }

  /** Performance object for the estimators from a build (+ metrics). */
  function perfOf(build, given) {
    var m = metricsFor(build, given) || {};
    var compound = get(build, 'tires.compound', 'performance');
    return {
      power_hp: num(m.power_hp, 300), weight_kg: num(m.weight_kg, 1400),
      mu: num(m.mu, num(m.grip, COMPOUND_MU[compound] || 1)),
      downforce_kg_200: num(m.downforce_kg_200, num(m.downforce_kg, 0)),
      cdA: num(m.cdA, num(m.cd_A, num(m.dragArea_m2, 0.7))),
      drivetrain: get(build, 'drivetrain.layout', 'rwd'),
      quarterMile_s: num(m.quarterMile_s, num(m.quarter_mile_s, num(m.qm_s, null))),
      topSpeed_kph: num(m.topSpeed_kph, null)
    };
  }
  /** AI machinery relative to the player's car: 'similar' fields match it, 'presets' use the tier reference, 'mixed' blend. */
  function blendPerf(playerPerf, ref, field) {
    if (!playerPerf || field === 'presets') return ref;
    if (field === 'similar') return playerPerf;
    return {
      power_hp: Math.sqrt(playerPerf.power_hp * ref.power_hp), weight_kg: Math.sqrt(playerPerf.weight_kg * ref.weight_kg),
      mu: (playerPerf.mu + ref.mu) / 2, downforce_kg_200: (num(playerPerf.downforce_kg_200, 0) + ref.downforce_kg_200) / 2,
      cdA: (num(playerPerf.cdA, 0.7) + ref.cdA) / 2, drivetrain: playerPerf.drivetrain
    };
  }
  function entrantOf(e) {
    if (isObj(e)) return e;
    if (e === 'player') return { id: 'player', talent: 0.6, consistency: 0.75, aggression: 0.5, specialty: 'allrounder', isPlayer: true };
    return getDriver(e) || { id: String(e), talent: 0.5, consistency: 0.7, aggression: 0.5, specialty: 'allrounder' };
  }

  /* ======================================================================
     Deterministic round simulation
     ====================================================================== */
  /**
   * simulateRound(champ, roundIdx, field, seed, opts) -> order rows (best first)
   *   field: driver ids or entrant objects {id, talent, consistency, aggression, specialty, paceMult?}
   *   opts: {weather, perf (AI car perf), calibrate (time attack banker laps), dnfMult}
   * Row: {id, position, status 'finished'|'dnf', time_s, bestLap_s, gridPosition, pole, fastestLap, lapsCompleted,
   *       score, bestRun, et_s, reaction_s, trap_kph, gap_s, gapText, eliminatedLap, metric}
   * Same inputs -> same output, always.
   */
  function simulateRound(champ, roundIdx, field, seed, opts) {
    champ = getChampionship(champ);
    opts = opts || {};
    var rd = champ && champ.rounds[roundIdx];
    if (!rd || !Array.isArray(field)) return [];
    seed = (num(seed, 1) >>> 0);
    var weather = opts.weather || (rd.weather === 'dry' || rd.weather === 'damp' || rd.weather === 'wet' ? rd.weather : resolveWeather(rd, makeRng(seed ^ 0x5eed)));
    var et = rd.eventType, rules = rd.rules || {};
    var rng = makeRng((hashStr(champ.id + '|r' + roundIdx) ^ seed) >>> 0);
    var perf = opts.perf || champ.refPerf;
    var wet = weather === 'wet';
    var L0 = estimateLapTime(rd.trackId, perf, { wet: wet }) * (weather === 'damp' ? 1.04 : 1) * (opts.calibrate ? TA_CALIBRATION : 1);
    var laps = rd.laps;
    var entrants = field.map(entrantOf);
    var rows = entrants.map(function (d) {
      var eff = effectiveSkill(d, rd, weather, seed);
      var cons = num(d.consistency, 0.7), aggr = num(d.aggression, 0.5), pm = num(d.paceMult, 1);
      var drng = makeRng((hashStr(String(d.id) + '|' + champ.id + '|' + roundIdx) ^ seed) >>> 0);
      return { d: d, id: d.id, eff: eff, cons: cons, aggr: aggr, pm: pm, rng: drng, status: 'finished' };
    });

    if (et === 'drag') {
      var dist = num(rules.distance_m, 402.336);
      rows.forEach(function (r) {
        var base = estimateDragTime(perf, dist);
        var etv = base.et_s * r.pm * (1 + (0.78 - r.eff) * 0.03) * (wet ? 1.08 : weather === 'damp' ? 1.035 : 1) + r.rng.gauss() * 0.025 * (1.2 - r.cons);
        var react = clamp(0.3 - r.eff * 0.18 + Math.abs(r.rng.gauss()) * 0.04, 0.04, 0.7);
        r.et_s = Math.round(etv * 1000) / 1000;
        r.reaction_s = Math.round(react * 1000) / 1000;
        r.trap_kph = Math.round(base.trap_kph / Math.max(0.85, r.pm) * 10) / 10;
        r.time_s = Math.round((etv + react) * 1000) / 1000;
        if (r.rng.chance(0.012 + 0.02 * r.aggr)) { r.status = 'dnf'; r.foul = true; }
        r.metric = r.status === 'dnf' ? Infinity : r.time_s;
      });
    } else if (et === 'drift') {
      var runs = Math.max(2, laps * 2);
      var lenKm = trackInfo(rd.trackId).length_m / 1000;
      rows.forEach(function (r) {
        var total = 0, best = 0;
        for (var i = 0; i < runs; i++) {
          var sc = 4200 * lenKm * Math.pow(0.35 + r.eff, 2) * (1 + r.rng.gauss() * 0.09 * (1.2 - r.cons)) / r.pm;
          if (r.rng.chance(0.07 * (1.25 - r.cons) * (wet ? 1.6 : 1))) sc *= 0.35 + r.rng.next() * 0.3;   // spin / wall
          sc = Math.max(0, Math.round(sc));
          total += sc; if (sc > best) best = sc;
        }
        r.score = total; r.bestRun = best; r.runs = runs;
        r.metric = -total;
      });
    } else if (et === 'time-attack') {
      rows.forEach(function (r) {
        var best = null;
        for (var i = 0; i < Math.max(1, laps); i++) {
          var lap = L0 * r.pm * (1 + (0.78 - r.eff - (r.d.specialty === 'qualifier' ? 0.02 : 0)) * 0.06) * (1 + Math.abs(r.rng.gauss()) * 0.005 * (1.3 - r.cons));
          if (i === 0) lap *= 1.012;  // out-lap tyres
          if (r.rng.chance(0.08 * (1.2 - r.cons) * (wet ? 1.5 : 1))) continue;   // track limits: lap deleted
          if (best === null || lap < best) best = lap;
        }
        r.bestLap_s = best === null ? null : Math.round(best * 1000) / 1000;
        r.lapsCompleted = laps;
        if (best === null) r.status = 'dnf';
        r.metric = best === null ? Infinity : best;
      });
    } else {
      // race-like: race / eliminator / endurance / manufacturer / rivals
      rows.forEach(function (r) {
        var q = L0 * r.pm * (1 + (0.78 - r.eff - (r.d.specialty === 'qualifier' ? 0.04 : 0)) * 0.07) + r.rng.gauss() * 0.004 * L0 * (1.3 - r.cons);
        r.quali = q;
      });
      rows.slice().sort(function (a, b) { return a.quali - b.quali || (a.id < b.id ? -1 : 1); }).forEach(function (r, i) { r.gridPosition = i + 1; });
      var stops = et === 'endurance' ? Math.max(num(rules.mandatoryPitStops, 1), Math.floor(laps / 9)) : 0;
      var wearK = et === 'endurance' ? num(rules.wear, 1) * 0.0016 : 0.0004;
      var dnfBase = et === 'endurance' ? 2.2 : et === 'eliminator' ? 0.6 : 1;
      rows.forEach(function (r) {
        var total = 0, best = Infinity, stintLap = 0, lapsDone = 0;
        var pDnf = (0.01 + 0.028 * r.aggr * (1.2 - r.cons)) * dnfBase * (wet ? 1.5 : 1) * (rules.damage ? 1.15 : 1) * num(opts.dnfMult, 1);
        var dnfLap = r.rng.chance(pDnf) ? r.rng.int(0, Math.max(0, laps - 1)) : -1;
        var stopEvery = stops ? Math.ceil(laps / (stops + 1)) : 0;
        for (var i = 0; i < laps; i++) {
          if (i === dnfLap) { r.status = 'dnf'; r.dnfReason = r.rng.pick(['mechanical', 'accident', 'gearbox', 'puncture', 'electrical']); break; }
          var lap = L0 * r.pm * (1 + (0.78 - r.eff) * 0.07) * (1 + r.rng.gauss() * 0.006 * (1.3 - r.cons)) * (1 + wearK * stintLap * (1.15 - r.cons * 0.3));
          if (i === 0) lap += 1.6 + (r.gridPosition - 1) * 0.32 - (r.d.specialty === 'racecraft' ? 0.9 : 0);
          if (r.rng.chance(0.025 * (1.2 - r.cons) * (wet ? 1.8 : 1))) lap += 1.5 + r.rng.next() * 3.5;
          if (stopEvery && i > 0 && i % stopEvery === 0 && i < laps - 1) {
            lap += 21 + r.rng.next() * 4 * (1.2 - r.cons) + (stintLap > 6 ? 0 : 1);
            stintLap = 0;
          }
          stintLap++;
          total += lap; lapsDone++;
          if (i > 0 && lap < best) best = lap;
          if (i === 0 && laps === 1) best = lap;
        }
        r.time_s = r.status === 'dnf' ? null : Math.round(total * 1000) / 1000;
        r.bestLap_s = isFinite(best) ? Math.round(best * 1000) / 1000 : null;
        r.lapsCompleted = lapsDone;
        r.pitStops = stops;
        r.metric = r.status === 'dnf' ? 1e9 - lapsDone * 1e5 + total / 1000 : total;
      });
    }

    rows.sort(function (a, b) { return (a.metric - b.metric) || (a.id < b.id ? -1 : 1); });
    var leader = rows[0], fastest = null;
    rows.forEach(function (r, i) {
      r.position = i + 1;
      if (r.status === 'finished' && isNum(r.bestLap_s) && (!fastest || r.bestLap_s < fastest.bestLap_s)) fastest = r;
      if (et === 'drift') { r.gap_s = null; r.gapText = i === 0 ? fmtInt(r.score) + ' pts' : '−' + fmtInt(leader.score - r.score) + ' pts'; }
      else if (et === 'drag') { r.gap_s = r.status === 'dnf' ? null : Math.round((r.time_s - leader.time_s) * 1000) / 1000; r.gapText = r.status === 'dnf' ? 'Red light' : i === 0 ? r.et_s.toFixed(3) + ' s' : '+' + r.gap_s.toFixed(3); }
      else if (et === 'time-attack') { r.gap_s = r.status === 'dnf' || !isNum(leader.bestLap_s) ? null : Math.round((r.bestLap_s - leader.bestLap_s) * 1000) / 1000; r.gapText = r.status === 'dnf' ? 'No time' : i === 0 ? fmtTime(r.bestLap_s) : '+' + fmtTime(r.gap_s); }
      else {
        r.gap_s = r.status === 'dnf' || !isNum(leader.time_s) ? null : Math.round((r.time_s - leader.time_s) * 1000) / 1000;
        r.gapText = r.status === 'dnf' ? 'DNF' : i === 0 ? fmtTime(r.time_s) : '+' + fmtTime(r.gap_s);
      }
      r.pole = r.gridPosition === 1;
    });
    if (fastest) fastest.fastestLap = true;
    if (et === 'eliminator') {
      // the last car of each lap is shown out: elimination lap in reverse finishing order
      var n = rows.length;
      rows.forEach(function (r, i) { r.eliminatedLap = i === 0 ? null : Math.max(1, Math.round(laps - (i - 1) * (laps / Math.max(1, n - 1)))); });
    }
    return rows.map(function (r) {
      var o = { id: r.id, position: r.position, status: r.status, gridPosition: r.gridPosition || null, pole: !!r.pole, fastestLap: !!r.fastestLap,
        time_s: isNum(r.time_s) ? r.time_s : null, bestLap_s: isNum(r.bestLap_s) ? r.bestLap_s : null, lapsCompleted: num(r.lapsCompleted, laps),
        gap_s: r.gap_s, gapText: r.gapText, weather: weather, simulated: true };
      if (et === 'drift') { o.score = r.score; o.bestRun = r.bestRun; o.runs = r.runs; }
      if (et === 'drag') { o.et_s = r.et_s; o.reaction_s = r.reaction_s; o.trap_kph = r.trap_kph; if (r.foul) o.foul = true; }
      if (r.dnfReason) o.dnfReason = r.dnfReason;
      if (r.eliminatedLap != null) o.eliminatedLap = r.eliminatedLap;
      if (r.pitStops) o.pitStops = r.pitStops;
      return o;
    });
  }

  /** simulateSeason(champId, seed, opts {season, field}) -> full AI-only season (preview / testing). */
  function simulateSeason(champId, seed, opts) {
    opts = opts || {};
    var champ = getChampionship(champId);
    if (!champ) return null;
    seed = num(seed, 1) >>> 0;
    var season = num(opts.season, 1);
    var field = opts.field || fieldFor(champ, seed, season);
    var sseed = hashStr(seed + '|' + champ.id + '|s' + season) >>> 0;
    var wrng = makeRng(sseed ^ 0x5eed);
    var weather = champ.rounds.map(function (r) { return resolveWeather(r, wrng); });
    var table = {};
    field.forEach(function (id) { table[id] = emptyRow(id); });
    var sys = systemOf(champ), roundsOut = [];
    champ.rounds.forEach(function (rd, i) {
      var order = simulateRound(champ, i, field, sseed, { weather: weather[i] });
      var pts = scoreOrder(champ, rd, order);
      pts.forEach(function (p) { addToRow(table[p.id], p, i); });
      roundsOut.push({ index: i, name: rd.name, trackId: rd.trackId, weather: weather[i], order: pts, winner: pts[0] && pts[0].id });
    });
    var standings = sortStandings(Object.keys(table).map(function (k) { return table[k]; })).map(function (r) { return decorateRow(r, null); });
    return { champId: champ.id, season: season, seed: seed, field: field, weather: weather, rounds: roundsOut, standings: standings,
      champion: standings[0] || null, pointsSystem: sys.id };
  }

  /* ======================================================================
     Scoring a round
     ====================================================================== */
  /** Apply the points system to an ordered round classification. */
  function scoreOrder(champ, rd, order) {
    var sys = systemOf(champ);
    var bestRunId = null, bestRun = -1;
    if (rd.eventType === 'drift') order.forEach(function (r) { if (num(r.bestRun, -1) > bestRun) { bestRun = r.bestRun; bestRunId = r.id; } });
    return order.map(function (r, i) {
      var pos = i + 1;
      var flags = { dnf: r.status === 'dnf', dns: r.status === 'dns', fastestLap: !!r.fastestLap, pole: !!r.pole, isFinal: rd.isFinal,
        bestScore: rd.eventType === 'drift' && r.id === bestRunId };
      var o = {};
      for (var k in r) if (hasOwn.call(r, k)) o[k] = r[k];
      o.position = pos;
      o.points = pointsFor(sys, pos, flags);
      o.flags = { pole: flags.pole && !!sys.pole, fastestLap: flags.fastestLap && !!sys.fastestLap && pos <= (sys.fastestLapTopN || 99) && !flags.dnf,
        bestScore: flags.bestScore && !!sys.bestScoreBonus, doublePoints: !!(rd.isFinal && sys.finalRoundMultiplier) };
      return o;
    });
  }
  function addToRow(row, p, roundIdx) {
    if (!row) return;
    var finished = p.status !== 'dnf' && p.status !== 'dns';
    row.points += p.points;
    if (p.status !== 'dns') row.starts++;
    if (finished && p.position === 1) row.wins++;
    if (finished && p.position <= 3) row.podiums++;
    if (p.pole) row.poles++;
    if (p.fastestLap) row.fastestLaps++;
    if (p.status === 'dnf') row.dnfs++;
    row.finishes[roundIdx] = finished ? p.position : null;
    row.pointsByRound[roundIdx] = p.points;
    if (finished && (row.best == null || p.position < row.best)) row.best = p.position;
  }
  function driverInfo(id, profile) {
    if (id === 'player') {
      var car = activeCar(profile);
      return { id: 'player', name: playerName(profile), team: get(profile, 'teamName', 'Redline Garage'), code: 'YOU', isPlayer: true, isRival: false,
        color: get(car, 'build.exterior.paint', get(profile, 'avatarColor', '#c8a96a')), accent: '#ffffff', number: get(car, 'build.exterior.livery_number', null), nationality: get(profile, 'nationality', null) };
    }
    var d = getDriver(id);
    if (!d) return { id: id, name: titleCase(String(id).replace(/^drv-/, '')), team: '', isPlayer: false, isRival: false, color: '#888888' };
    return { id: d.id, name: d.name, team: d.team, code: d.code, isPlayer: false, isRival: !!d.isRival, color: d.color, accent: d.accent, number: d.number,
      nationality: d.nationality, title: d.title || null, specialty: d.specialty };
  }
  function decorateRow(r, profile, prevPositions) {
    var info = driverInfo(r.id, profile), o = {};
    for (var k in r) if (hasOwn.call(r, k)) o[k] = Array.isArray(r[k]) ? r[k].slice() : r[k];
    for (var j in info) if (hasOwn.call(info, j)) o[j] = info[j];
    o.results = o.finishes;
    if (prevPositions && isNum(prevPositions[r.id])) { o.lastPosition = prevPositions[r.id]; o.change = prevPositions[r.id] - r.position; }
    else { o.lastPosition = null; o.change = 0; }
    return o;
  }
  function standingsRows(cs, profile) {
    if (!cs || !isObj(cs.standings)) return [];
    var rows = Object.keys(cs.standings).map(function (k) { return Object.assign({}, cs.standings[k]); });
    return sortStandings(rows).map(function (r) { return decorateRow(r, profile, cs.lastPositions); });
  }

  /* ======================================================================
     Parsing real race results
     ====================================================================== */
  function resultRowsOf(results) {
    if (!results) return [];
    if (Array.isArray(results)) return results.filter(isObj);
    var keys = ['classification', 'cars', 'order', 'results', 'standings', 'rows', 'entries'];
    for (var i = 0; i < keys.length; i++) if (Array.isArray(results[keys[i]])) return results[keys[i]].filter(isObj);
    if (isObj(results.player)) return [results.player];
    return [];
  }
  function playerRowOf(rows, results) {
    var pid = isObj(results) && results.playerId != null ? results.playerId : 'player';
    for (var i = 0; i < rows.length; i++) if (rows[i].isPlayer || rows[i].player === true) return rows[i];
    for (var j = 0; j < rows.length; j++) if (rows[j].id === pid || rows[j].carId === pid) return rows[j];
    if (rows.length === 1) return rows[0];
    return null;
  }
  function rowStatus(row, results, mode, asAi) {
    if (!row) return 'dns';
    if (row.dns || row.status === 'dns') return 'dns';
    if (row.dnf || row.dsq || row.retired || row.status === 'dnf' || row.status === 'dsq') return 'dnf';
    // A session that closed early (the player retired / quit): the player is out, but AI cars that were still circulating
    // are classified on their running order, as a real race would carry on to the flag without the retiree.
    if (mode === 'race' && isObj(results) && results.complete === false && row.status === 'running') return asAi ? 'finished' : 'dnf';
    return 'finished';
  }
  function bestLapOf(row) { var v = num(row && row.bestLap_s, num(row && row.bestLap, null)); return isNum(v) && v > 0 ? v : null; }
  function rowTime(row) { return num(row && row.totalTime_s, num(row && row.finishTime_s, num(row && row.raceTime_s, num(row && row.time_s, null)))); }

  /**
   * Turn engine results into a full classification of the championship field (best first).
   * Drivers of the field that did not take part in the real session are slotted in from the deterministic simulation.
   */
  function classifyRound(champ, cs, roundIdx, results, ctx) {
    var rd = champ.rounds[roundIdx], et = rd.eventType, type = EVENT_TYPES[et];
    var weather = cs.weather[roundIdx] || 'dry';
    var playerPerf = ctx.perf;
    var aiPerf = blendPerf(playerPerf, champ.refPerf, champ.field);
    var paceField = cs.field.map(function (id) { return id; });
    var rows = resultRowsOf(results);
    var me = ctx.dns ? null : playerRowOf(rows, results);
    if (!me && !ctx.dns && isObj(results) && isObj(results.drift) && isNum(results.drift.total)) {
      // a CB.race.drift session (practice engine, no classification row): the scorer total is the player's mark
      me = { id: 'player', isPlayer: true, status: 'finished', driftScore: results.drift.total, collisions: num(results.drift.crashes, 0) };
    }
    var mode = (isObj(results) && results.mode) || type.mode;
    var status = ctx.dns ? 'dns' : rowStatus(me, results, mode);
    var simOrder;

    if (type.scoring !== 'position' || et === 'drag') {
      // Time / score events: the field's marks come from the simulation (same machinery as the player), the player's from the session.
      simOrder = simulateRound(champ, roundIdx, paceField, cs.seed, { weather: weather, perf: aiPerf, calibrate: et === 'time-attack' });
      var pr = { id: 'player', status: status === 'dns' ? 'dns' : 'finished', gridPosition: null, pole: false, fastestLap: false, simulated: !!ctx.simulated };
      if (et === 'time-attack') {
        pr.bestLap_s = status === 'dns' ? null : bestLapOf(me);
        if (pr.bestLap_s === null && pr.status !== 'dns') pr.status = 'dnf';
        pr.metric = pr.bestLap_s === null ? Infinity : pr.bestLap_s;
        pr.lapsCompleted = num(me && (me.laps || me.lapsCompleted), rd.laps);
      } else if (et === 'drift') {
        var dres = isObj(results) && isObj(results.drift) ? results.drift : null;   // CB.race.drift session results (#/drift)
        var sc = me ? num(me.driftScore, num(me.score, num(me.driftScoreBest, num(results && results.driftScore, num(dres && dres.total, null))))) : null;
        if (!isNum(sc) && status !== 'dns') {
          // no drift scorer in the session: estimate from the car's balance + how clean the run was
          var m = playerPerf || champ.refPerf;
          var rwdBonus = m.drivetrain === 'rwd' ? 0.06 : m.drivetrain === 'awd' ? 0 : -0.15;
          var effP = 0.55 + rwdBonus + clamp((m.power_hp / (m.weight_kg / 1000) - 180) / 1500, -0.08, 0.12) - Math.min(3, num(me && me.trackLimits, 0)) * 0.03 - Math.min(4, num(me && me.collisions, 0)) * 0.02;
          var lenKm = trackInfo(rd.trackId).length_m / 1000, runs = Math.max(2, rd.laps * 2);
          sc = Math.round(4200 * lenKm * Math.pow(0.35 + effP, 2) * runs);
          pr.estimated = true;
        }
        pr.score = status === 'dns' ? 0 : Math.max(0, Math.round(num(sc, 0)));
        pr.bestRun = me && isNum(me.bestRun) ? me.bestRun : dres && isNum(dres.bestDrift) && dres.bestDrift > 0 ? Math.round(dres.bestDrift) : Math.round(pr.score / Math.max(2, rd.laps * 2) * 1.25);
        if (status === 'dnf' && !pr.score) pr.status = 'dnf';
        pr.metric = pr.status === 'dns' ? Infinity : -pr.score;
        // Calibrate the simulated field to the drift scorer that judged the player's run: the round winner's mark lands on the
        // session's gold target (same track, run length and assist scale), so a gold run beats the field and bronze sits mid-pack.
        var tg = dres && isObj(dres.targets) ? dres.targets : null;
        if (tg && isNum(tg.gold) && tg.gold > 0 && !pr.estimated && simOrder.length) {
          var simTop = 0;
          simOrder.forEach(function (s) { if (num(s.score, 0) > simTop) simTop = num(s.score, 0); });
          if (simTop > 0) {
            var kf = tg.gold / simTop;
            simOrder.forEach(function (s) {
              if (isNum(s.score)) s.score = Math.round(s.score * kf);
              if (isNum(s.bestRun)) s.bestRun = Math.round(s.bestRun * kf);
            });
          }
        }
      } else { // drag
        var dist = num(rd.rules && rd.rules.distance_m, 402.336);
        var dt = estimateDragTime(playerPerf || champ.refPerf, dist);
        // a real heads-up run (career drag hooks cut the session at distance_m): elapsed time minus the launch reaction
        var runEt = me && !me.simulated && !(results && results.simulated) && isNum(me.raceTime_s) && me.raceTime_s > 0 && rowStatus(me, results, 'race') === 'finished'
          ? me.raceTime_s - Math.max(0, num(me.reaction_s, 0)) : null;
        var etv = isNum(me && me.et_s) ? me.et_s : isNum(runEt) && runEt > 0 ? runEt : (playerPerf && isNum(playerPerf.quarterMile_s) && Math.abs(dist - 402.336) < 1 ? playerPerf.quarterMile_s : dt.et_s);
        var react = clamp(num(me && me.reaction_s, 0.24), 0.02, 1.5);
        // heads-up result from the real session decides who of the pair was quicker
        var opp = null;
        rows.forEach(function (r) { if (r !== me && !opp) opp = r; });
        var oppId = opp ? mapAiId(opp, cs, {}, ctx.raced || []) : null;
        pr.et_s = Math.round(etv * 1000) / 1000;
        pr.reaction_s = Math.round(react * 1000) / 1000;
        pr.trap_kph = Math.round(num(me && me.topSpeed_kph, dt.trap_kph) * 10) / 10;
        pr.time_s = Math.round((etv + react) * 1000) / 1000;
        if (me && me.jumpStart) { pr.status = 'dnf'; pr.foul = true; }
        if (status === 'dnf') pr.status = 'dnf';
        if (oppId && me && pr.status === 'finished') {
          var oppSim = simOrder.filter(function (s) { return s.id === oppId; })[0];
          var won = num(me.position, 2) < num(opp.position, 1);
          if (oppSim && isNum(oppSim.time_s)) {
            if (won && pr.time_s >= oppSim.time_s) pr.time_s = Math.round((oppSim.time_s - 0.004) * 1000) / 1000;
            if (!won && pr.time_s <= oppSim.time_s) pr.time_s = Math.round((oppSim.time_s + 0.004) * 1000) / 1000;
          }
          pr.headsUp = { opponent: oppId, won: won };
        }
        pr.metric = pr.status === 'finished' ? pr.time_s : Infinity;
      }
      if (pr.status === 'dns') pr.metric = Infinity;
      var all = simOrder.map(function (s) {
        var o = {}; for (var k in s) if (hasOwn.call(s, k)) o[k] = s[k];
        o.metric = et === 'drift' ? -num(s.score, 0) : s.status === 'dnf' ? Infinity : et === 'time-attack' ? s.bestLap_s : s.time_s;
        return o;
      });
      all.push(pr);
      all.sort(function (a, b) {
        var sa = a.status === 'dns' ? 2 : a.status === 'dnf' ? 1 : 0, sb = b.status === 'dns' ? 2 : b.status === 'dnf' ? 1 : 0;
        return (sa - sb) || (a.metric - b.metric) || (a.id === 'player' ? -1 : b.id === 'player' ? 1 : 0);
      });
      var lead = all[0];
      all.forEach(function (r, i) {
        r.position = i + 1;
        if (et === 'drift') r.gapText = i === 0 ? fmtInt(r.score) + ' pts' : '−' + fmtInt(num(lead.score, 0) - num(r.score, 0)) + ' pts';
        else if (et === 'time-attack') r.gapText = r.status !== 'finished' ? 'No time' : i === 0 ? fmtTime(r.bestLap_s) : '+' + fmtTime(r.bestLap_s - lead.bestLap_s);
        else r.gapText = r.status === 'dnf' ? 'Red light' : r.status === 'dns' ? 'DNS' : i === 0 ? r.et_s.toFixed(3) + ' s' : '+' + (r.time_s - lead.time_s).toFixed(3);
        r.fastestLap = false;
        delete r.metric;
      });
      if (et === 'time-attack' && all[0] && all[0].status === 'finished') all[0].fastestLap = true;
      return all;
    }

    // Position-scored: the real session is authoritative for everybody who took part.
    simOrder = simulateRound(champ, roundIdx, paceField, cs.seed, { weather: weather, perf: aiPerf });
    var sorted = rows.slice().sort(function (a, b) { return num(a.position, 99) - num(b.position, 99); });
    var used = {}, real = [];
    var fl = isObj(results) && results.fastestLap;
    var fastestRow = null;
    sorted.forEach(function (r) {
      var id = r === me ? 'player' : mapAiId(r, cs, used, ctx.raced || []);
      if (!id || used[id]) return;
      used[id] = 1;
      var st2 = r === me ? status : rowStatus(r, results, 'race', true);
      // eliminator: knocked-out cars are classified in elimination order (behind the survivors), not retired
      if (et === 'eliminator' && r.dnfReason === 'eliminated' && st2 === 'dnf') st2 = 'finished';
      var o = { id: id, status: st2 === 'dns' ? 'dnf' : st2, gridPosition: num(r.gridPosition, num(r.grid, null)), time_s: rowTime(r), bestLap_s: bestLapOf(r),
        lapsCompleted: num(r.laps, num(r.lapsCompleted, null)), gapText: r.gapText || null, gap_s: num(r.gap_s, null), simulated: r === me ? !!ctx.simulated : !!(results && results.simulated),
        collisions: num(r.collisions, 0), penalties_s: num(r.penalties_s, 0), topSpeed_kph: num(r.topSpeed_kph, null) };
      if (r === me && status === 'dns') o.status = 'dns';
      o.pole = o.gridPosition === 1 || r.pole === true;
      if (isObj(fl) && fl.carId != null && (fl.carId === r.id || fl.carId === r.carId)) fastestRow = o;
      real.push(o);
    });
    if (!me) real.push({ id: 'player', status: 'dns', gridPosition: null, time_s: null, bestLap_s: null, pole: false, gapText: 'DNS' });
    if (!fastestRow) {
      real.forEach(function (o) { if (o.status === 'finished' && isNum(o.bestLap_s) && (!fastestRow || o.bestLap_s < fastestRow.bestLap_s)) fastestRow = o; });
    }
    // finishers first, then DNFs (engine order), DNS last
    var fin = real.filter(function (o) { return o.status === 'finished'; });
    var dnf = real.filter(function (o) { return o.status === 'dnf'; });
    var dns = real.filter(function (o) { return o.status === 'dns'; });
    var merged = fin.concat(dnf);
    // absent field drivers are inserted at their simulated position (they "raced" in a parallel heat)
    simOrder.forEach(function (s) {
      if (used[s.id]) return;
      var o = { id: s.id, status: s.status, gridPosition: s.gridPosition, time_s: s.time_s, bestLap_s: s.bestLap_s, lapsCompleted: s.lapsCompleted, gapText: s.gapText, simulated: true, pole: false };
      if (s.status === 'dnf') merged.push(o);
      else {
        var at = Math.min(Math.max(0, s.position - 1), fin.length);
        merged.splice(at, 0, o); fin.splice(at, 0, o);
      }
    });
    merged = merged.concat(dns);
    var poleTaken = false;
    merged.forEach(function (o, i) {
      o.position = i + 1;
      o.fastestLap = o === fastestRow;
      if (o.pole && !poleTaken) poleTaken = true; else o.pole = false;
    });
    return merged;
  }
  /** Map an AI result row to a field driver id (id -> name -> next unused raced driver -> next unused field driver). */
  function mapAiId(r, cs, used, raced) {
    var ids = cs.field;
    if (r.id != null && ids.indexOf(r.id) >= 0) return r.id;
    if (r.driverId != null && ids.indexOf(r.driverId) >= 0) return r.driverId;
    var nm = String(r.name || '').toLowerCase();
    if (nm) for (var i = 0; i < ids.length; i++) { var d = getDriver(ids[i]); if (d && d.name.toLowerCase() === nm && !used[ids[i]]) return ids[i]; }
    for (var j = 0; j < raced.length; j++) if (!used[raced[j]]) return raced[j];
    for (var k = 0; k < ids.length; k++) if (!used[ids[k]]) return ids[k];
    return null;
  }

  /* ======================================================================
     Rivals: dialog, relationship, storyline beats
     ====================================================================== */
  var SITUATION_FALLBACK = {
    preFinale: 'preRace', playerLeads: 'preRace', rivalLeads: 'preRace', playerBeatRival: 'playerWon', rivalBeatPlayer: 'rivalWon',
    comeback: 'playerWon', rain: 'preRace', respect: 'playerWon', farewell: 'respect', duelWin: 'titlePlayer', duelLoss: 'titleRival',
    duelChallenge: 'intro', titlePlayer: 'playerWon', titleRival: 'rivalWon', playerDnf: 'rivalWon', rivalDnf: 'playerWon'
  };
  /** rivalLine(rivalId, situation, ctx {player, track, champ, gap, points, round, seed}) -> string ('' when unknown) */
  function rivalLine(rivalId, situation, ctx) {
    var r = getRival(rivalId);
    if (!r) return '';
    ctx = ctx || {};
    var sit = situation, guard = 0;
    while (sit && !(r.lines[sit] && r.lines[sit].length) && guard++ < 4) sit = SITUATION_FALLBACK[sit];
    var list = (sit && r.lines[sit]) || r.lines.intro;
    var rng = makeRng(hashStr(r.id + '|' + situation + '|' + (ctx.seed != null ? ctx.seed : '') + '|' + (ctx.round != null ? ctx.round : '')));
    var c = { player: ctx.player || 'rookie', track: ctx.track || 'this track', champ: ctx.champ || 'the championship', gap: ctx.gap != null ? ctx.gap : 0,
      points: ctx.points != null ? ctx.points : 0, round: ctx.round != null ? ctx.round : '', rival: r.first };
    return fill(rng.pick(list), c);
  }
  function rivalState(st, id) {
    if (!isObj(st.rivals[id])) st.rivals[id] = { id: id, met: false, metAt: null, respect: 20, ahead: 0, behind: 0, races: 0, duelsWon: 0, duelsLost: 0, titlesVs: 0, lastLine: null, lastSituation: null };
    return st.rivals[id];
  }
  function moodOf(rs) {
    var r = num(rs && rs.respect, 20);
    return r >= 80 ? 'friend' : r >= 60 ? 'respect' : r >= 40 ? 'wary' : r >= 20 ? 'dismissive' : 'hostile';
  }
  function triggerBeats(st, rivalId, on, extra) {
    var out = [];
    var rs = rivalState(st, rivalId);
    STORY_BEATS.forEach(function (b) {
      if (b.rival !== rivalId || b.on !== on) return;
      if (st.story.some(function (s) { return s.id === b.id; })) return;
      if (on === 'beat-rival' && rs.ahead < num(b.count, 1)) return;
      if (on === 'respect' && rs.respect < num(b.min, 50)) return;
      var e = { id: b.id, rival: rivalId, title: b.title, text: b.text, t: now(), champId: extra && extra.champId || null };
      st.story.push(e);
      out.push(e);
    });
    return out;
  }

  /* ======================================================================
     Rewards
     ====================================================================== */
  function roundRewards(champ, rd, diff, playerRow, fieldSize, results, profile) {
    var E = economy();
    var mult = champ.prize.roundMult * num(rd.prizeMult, 1);
    var label = champ.short + (rd.isFinal ? ' finale' : '') + ' purse';
    var dnf = playerRow.status !== 'finished';
    if (playerRow.status === 'dns') return { credits: 0, xp: 0, breakdown: [{ label: 'Did not start', credits: 0, xp: 0, kind: 'base' }] };
    var outcome = null;
    if (E && typeof E.outcomeFromResults === 'function' && results) {
      try { outcome = E.outcomeFromResults(results, { difficulty: diff.level, laps: rd.laps, trackId: resolveTrackId(rd.trackId) }); } catch (e) { outcome = null; }
    }
    outcome = outcome || {};
    var o = {
      position: playerRow.position, fieldSize: fieldSize, difficulty: diff.level, laps: rd.laps, trackId: resolveTrackId(rd.trackId),
      cleanRace: !dnf && (outcome.cleanRace != null ? !!outcome.cleanRace : num(playerRow.collisions, 0) === 0 && num(playerRow.penalties_s, 0) === 0),
      fastestLap: !!playerRow.fastestLap, pole: !!playerRow.pole, overtakes: num(outcome.overtakes, 0), lapsLed: num(outcome.lapsLed, 0),
      gridPosition: playerRow.gridPosition || undefined, penalties_s: num(outcome.penalties_s, num(playerRow.penalties_s, 0)), dnf: dnf,
      mode: EVENT_TYPES[rd.eventType].mode, multiplier: mult, multiplierLabel: label
    };
    if (EVENT_TYPES[rd.eventType].scoring !== 'position') { o.overtakes = 0; o.lapsLed = 0; o.gridPosition = undefined; o.pole = false; }
    var res = null;
    if (E && typeof E.raceRewards === 'function') { try { res = E.raceRewards(o); } catch (e2) { res = null; } }
    if (!res || !isNum(res.credits)) {
      var share = dnf ? 0.1 : Math.max(0.08, 1 - (o.position - 1) / Math.max(1, fieldSize));
      var purse = 2500 * (1 + champ.tierIndex * 1.4) * Math.max(1, rd.laps / 3) * mult;
      var bd = [{ label: dnf ? 'Starting money (DNF)' : 'Finished ' + ordinal(o.position) + ' of ' + fieldSize, credits: Math.round(purse * share), xp: Math.round((dnf ? 40 : 120 + 380 * share) * (1 + champ.tierIndex * 0.5)), kind: 'base' }];
      if (!dnf && o.position === 1) bd.push({ label: 'Victory bonus', credits: Math.round(purse * 0.15), xp: 150, kind: 'bonus' });
      if (o.fastestLap) bd.push({ label: 'Fastest lap', credits: 1500, xp: 75, kind: 'bonus' });
      if (o.pole) bd.push({ label: 'Pole position', credits: 1000, xp: 50, kind: 'bonus' });
      if (o.cleanRace) bd.push({ label: 'Clean race', credits: Math.round(Math.max(500, purse * 0.1)), xp: 50, kind: 'bonus' });
      res = { credits: 0, xp: 0, breakdown: bd };
      bd.forEach(function (l) { res.credits += l.credits; res.xp += l.xp; });
      res.credits = round(res.credits, 10);
    }
    return { credits: res.credits, xp: res.xp, breakdown: (res.breakdown || []).slice() };
  }

  /* ======================================================================
     Career view: state(profile)
     ====================================================================== */
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function dateLabel(champ, roundIdx, season) {
    // fictional calendar: seasons open in March, a round every two weeks, tiers staggered by a few days
    var day = 66 + champ.tierIndex * 3 + (hashStr(champ.id) % 5) + roundIdx * Math.max(10, Math.floor(196 / Math.max(1, champ.rounds.length)));
    var m = 0;
    while (day >= MONTH_DAYS[m]) { day -= MONTH_DAYS[m]; m = (m + 1) % 12; }
    return { day: day + 1, month: MONTHS[m], label: (day + 1) + ' ' + MONTHS[m], season: season, year: 'Season ' + season };
  }

  function champStatus(profile, st, champ, cs, unlock) {
    if (cs && cs.status === 'active') return 'active';
    if (!unlock.ok) return 'locked';
    if (cs && (cs.status === 'complete' || cs.history.length)) return 'complete';
    return 'available';
  }

  function champView(profile, st, champ, build, opts) {
    opts = opts || {};
    var cs = st.championships[champ.id] || null;
    var unlock = isUnlocked(profile, champ.id, st);
    var status = champStatus(profile, st, champ, cs, unlock);
    var elig = opts.eligibility === false ? null : checkEligibility(build, champ, { metrics: opts.metrics });
    var shown = cs || viewSeason(st, champ);
    var table = cs ? standingsRows(cs, profile) : [];
    var me = table.filter(function (r) { return r.isPlayer; })[0] || null;
    var done = cs && cs.status === 'active' ? cs.roundsCompleted : cs && cs.status === 'complete' ? champ.rounds.length : 0;
    return {
      id: champ.id, name: champ.name, short: champ.short, kind: champ.kind, tier: champ.tier, tierId: champ.tierId, tierIndex: champ.tierIndex, tierName: champ.tierName,
      color: champ.color, desc: champ.desc, tagline: champ.tagline, eventType: champ.eventType, eventTypeName: champ.eventTypeName, eventTypes: champ.eventTypes,
      pointsSystem: champ.pointsSystem, pointsSystemName: champ.pointsSystemName, sponsor: champ.sponsor, brief: champ.brief || null,
      rounds: champ.rounds.map(function (r) { return { index: r.index, name: r.name, trackId: r.trackId, trackName: r.trackName, laps: r.laps, eventType: r.eventType, weather: (shown.weather || [])[r.index] || r.weather, timeOfDay: r.timeOfDay, isFinal: r.isFinal, special: r.special }; }),
      requirements: champ.requirements, requirementLabels: requirementLabels(champ), entryFee: champ.entryFee, prize: champ.prize, trophy: cs && cs.trophy || null,
      trophyDef: champ.trophy, rivals: champ.rivals.map(function (id) { var r = getRival(id); return r ? { id: r.id, name: r.name, title: r.title, color: r.color, mood: moodOf(st.rivals[id]) } : null; }).filter(Boolean),
      status: status, unlocked: unlock.ok, lockReasons: unlock.reasons, locked: !unlock.ok, lockReason: unlock.reasons[0] || '',
      eligibility: elig, eligible: elig ? elig.ok : null, minLevel: champ.minLevel,
      season: cs ? cs.season : 0, roundsCompleted: done, roundsTotal: champ.rounds.length, nextRoundIdx: cs && cs.status === 'active' ? cs.roundsCompleted : 0,
      complete: status === 'complete', active: status === 'active', entered: status === 'active',
      standings: table, playerPosition: me ? me.position : null, playerPoints: me ? me.points : 0, leader: table[0] || null,
      finalPosition: cs ? cs.finalPosition : null, bestFinish: cs ? cs.bestFinish : null, bestPosition: cs ? cs.bestFinish : null, titles: cs ? num(cs.titles, 0) : 0,
      history: cs ? cs.history.slice() : [], results: cs && cs.status === 'active' ? cs.results.slice() : [],
      duelTarget: champ.duelTarget, rival: champ.rival || null, totalLaps: champ.totalLaps
    };
  }

  /** state(profile) -> computed career view (read-only: never mutates the profile). */
  function state(profile, opts) {
    opts = opts || {};
    var st = peekCareer(profile);
    if (opts.build === undefined) scheduleEntryCar(profile);
    var build = opts.build !== undefined ? opts.build : activeBuild(profile);
    var metrics = build ? metricsFor(build) : null;
    var champs = {}, list = [];
    catalog.championships.forEach(function (c) {
      var v = champView(profile, st, c, build, { metrics: metrics, eligibility: opts.eligibility });
      champs[c.id] = v; list.push(v);
    });
    var tiers = TIERS.map(function (t) {
      var u = tierUnlock(profile, t.id, st);
      var cl = t.championshipIds.map(function (id) { return champs[id]; });
      var completeN = cl.filter(function (c) { return c.complete || c.titles > 0 || c.history.length; }).length;
      return {
        id: t.id, index: t.index, name: t.name, short: t.short, color: t.color, icon: t.icon, tagline: t.tagline, desc: t.desc, minLevel: t.minLevel,
        unlocked: u.ok, lockReasons: u.reasons, lockReason: u.reasons[0] || '', progress: u.progress, reward: t.reward,
        rewardClaimed: !!st.tierRewards[t.id], championships: cl, events: t.events.map(function (id) { return champs[id]; }),
        completed: completeN, total: cl.length, complete: cl.length > 0 && completeN === cl.length,
        trophies: st.trophies.filter(function (x) { return x.tierId === t.id; }).length, rivals: t.rivalIds
      };
    });
    var events = catalog.events.map(function (e) { return champs[e.id]; });
    var rivals = RIVALS.map(function (r) {
      var rs = st.rivals[r.id] || { met: false, respect: 20, ahead: 0, behind: 0, races: 0, duelsWon: 0, duelsLost: 0 };
      return { id: r.id, name: r.name, title: r.title, team: r.team, color: r.color, accent: r.accent, number: r.number, nationality: r.nationality,
        bio: r.bio, car: r.car, arc: r.arc, personality: r.personality, met: !!rs.met, respect: rs.respect, mood: moodOf(rs),
        headToHead: { ahead: rs.ahead, behind: rs.behind, races: rs.races }, duels: { won: rs.duelsWon, lost: rs.duelsLost },
        lastLine: rs.lastLine || null, tiers: r.tierIds, story: st.story.filter(function (s) { return s.rival === r.id; }) };
    });
    var active = list.filter(function (c) { return c.active; });
    var totalChamps = catalog.championships.length;
    var completedN = list.filter(function (c) { return c.complete || c.titles > 0; }).length;
    return {
      version: VERSION, seed: st.seed, tiers: tiers, championships: champs, list: list, events: events, active: active,
      trophies: st.trophies.slice(), rivals: rivals, story: st.story.slice(), stats: clone(st.stats), titles: st.titles.slice(), log: st.log.slice(-30),
      unlockedTiers: tiers.filter(function (t) { return t.unlocked; }).map(function (t) { return t.id; }),
      totals: {
        championships: totalChamps, completed: completedN, completion: totalChamps ? Math.round(completedN / totalChamps * 1000) / 10 : 0,
        trophies: st.trophies.length, gold: st.trophies.filter(function (t) { return t.medal === 'gold'; }).length,
        titles: st.stats.titles, wins: st.stats.wins, podiums: st.stats.podiums, rounds: st.stats.rounds, points: st.stats.points, earnings: st.stats.earnings
      },
      nextGoal: nextGoal(profile, st, tiers, list)
    };
  }

  function nextGoal(profile, st, tiers, list) {
    var act = list.filter(function (c) { return c.active; })[0];
    if (act) return { kind: 'continue', champId: act.id, text: 'Continue ' + act.name + ': round ' + (act.roundsCompleted + 1) + ' of ' + act.roundsTotal };
    for (var i = tiers.length - 1; i >= 0; i--) {
      var t = tiers[i];
      if (!t.unlocked) continue;
      var avail = t.championships.filter(function (c) { return !c.complete && !c.locked; });
      if (avail.length) {
        var c = avail.slice().sort(function (a, b) { return (b.eligible ? 1 : 0) - (a.eligible ? 1 : 0) || a.minLevel - b.minLevel; })[0];
        var nt = tiers[i + 1];
        return { kind: 'enter', champId: c.id, tierId: t.id, text: 'Enter the ' + c.name + (nt && !nt.unlocked ? ' — ' + (nt.lockReasons[0] || 'progress to unlock ' + nt.name) : '') };
      }
      var next = tiers[i + 1];
      if (next && !next.unlocked) return { kind: 'unlock', tierId: next.id, text: 'Unlock ' + next.name + ': ' + next.lockReasons.join('; ') };
    }
    return { kind: 'done', text: 'Every championship conquered. Defend your titles — or chase a perfect season.' };
  }

  /* ======================================================================
     Season management
     ====================================================================== */
  /** enter(profile, champId, opts {build, force, free, difficulty}) -> {ok, reason?, reasons?, fee, profile, season} */
  function enter(profile, champId, opts) {
    opts = opts || {};
    var champ = getChampionship(champId);
    if (!champ) return { ok: false, reason: 'Unknown championship', reasons: ['Unknown championship'], fee: 0, profile: profile };
    var st = careerOf(profile);
    var cs = st.championships[champ.id];
    if (cs && cs.status === 'active') return { ok: true, already: true, fee: 0, profile: profile, season: cs.season };
    if (!opts.force) {
      var u = isUnlocked(profile, champ.id, st);
      if (!u.ok) return { ok: false, reason: u.reasons[0], reasons: u.reasons, fee: champ.entryFee, profile: profile };
      var build = opts.build || activeBuild(profile);
      var el = checkEligibility(build, champ, { metrics: opts.metrics });
      if (!el.ok) return { ok: false, reason: el.reasons[0], reasons: el.reasons, eligibility: el, fee: champ.entryFee, profile: profile };
    }
    var fee = opts.free ? 0 : champ.entryFee;
    if (fee > 0 && num(profile && profile.credits, 0) < fee) {
      return { ok: false, reason: 'Entry fee ' + fmtCredits(fee) + ' — you have ' + fmtCredits(num(profile && profile.credits, 0)), reasons: ['Not enough credits'], fee: fee, profile: profile };
    }
    if (fee > 0) applyAward(profile, -fee, 0, 'Entry fee · ' + champ.name, 'career');
    cs = newSeason(st, champ, { difficulty: opts.difficulty });
    cs.feePaid = fee;
    st.stats.feesPaid += fee;
    st.updatedAt = now();
    var events = [];
    champ.rivals.forEach(function (rid) {
      var rs = rivalState(st, rid);
      if (!rs.met) {
        rs.met = true; rs.metAt = now();
        var line = rivalLine(rid, 'intro', { player: playerName(profile), champ: champ.name, seed: cs.seed });
        rs.lastLine = line; rs.lastSituation = 'intro';
        events.push({ type: 'rival', rival: rid, situation: 'intro', text: line });
        triggerBeats(st, rid, 'first-meet', { champId: champ.id }).forEach(function (b) { events.push({ type: 'story', beat: b, text: b.title + ' — ' + b.text }); });
      }
    });
    if (champ.eventType === 'rivals') {
      var dl = rivalLine(champ.rival, 'duelChallenge', { player: playerName(profile), seed: cs.seed });
      events.push({ type: 'rival', rival: champ.rival, situation: 'duelChallenge', text: dl });
    }
    addLog(st, 'enter', 'Entered ' + champ.name + ' (season ' + cs.season + ')' + (fee ? ' — fee ' + fmtCredits(fee) : ''), { champId: champ.id });
    return { ok: true, fee: fee, profile: profile, season: cs.season, events: events, career: st };
  }

  /** withdraw(profile, champId, opts) -> {ok, refund}. Unraced seasons refund half the fee. */
  function withdraw(profile, champId, opts) {
    opts = opts || {};
    var champ = getChampionship(champId);
    if (!champ) return { ok: false, reason: 'Unknown championship' };
    var st = careerOf(profile);
    var cs = st.championships[champ.id];
    if (!cs || cs.status !== 'active') return { ok: false, reason: 'Not entered' };
    var refund = cs.roundsCompleted === 0 && !opts.noRefund ? round(num(cs.feePaid, 0) * 0.5, 10) : 0;
    if (refund > 0) applyAward(profile, refund, 0, 'Entry refund · ' + champ.name, 'career');
    st.championships[champ.id] = {
      id: champ.id, season: cs.season, status: 'idle', roundsCompleted: 0, results: [], standings: {}, complete: false,
      bestFinish: cs.bestFinish, titles: num(cs.titles, 0), history: cs.history || [], withdrawnAt: now(), trophy: null, finalPosition: null,
      field: cs.field, weather: cs.weather, seed: cs.seed
    };
    addLog(st, 'withdraw', 'Withdrew from ' + champ.name + (refund ? ' — refund ' + fmtCredits(refund) : ''), { champId: champ.id });
    return { ok: true, refund: refund, profile: profile };
  }

  /** restart(profile, champId, opts) -> {ok, season}: wipe the current season's results (same season, no extra fee). */
  function restart(profile, champId, opts) {
    opts = opts || {};
    var champ = getChampionship(champId);
    if (!champ) return { ok: false, reason: 'Unknown championship' };
    var st = careerOf(profile);
    var cs = st.championships[champ.id];
    if (!cs || cs.status !== 'active') return enter(profile, champId, opts);
    var fee = cs.feePaid;
    var fresh = newSeason(st, champ, { season: cs.season, difficulty: opts.difficulty || cs.difficultySetting });
    fresh.feePaid = fee;
    fresh.restarts = num(cs.restarts, 0) + 1;
    addLog(st, 'restart', 'Restarted ' + champ.name + ' season ' + fresh.season, { champId: champ.id });
    return { ok: true, season: fresh.season, profile: profile };
  }

  /** nextRound(profile, champId) -> round descriptor or null when the season is complete. */
  function nextRound(profile, champId) {
    var champ = getChampionship(champId);
    if (!champ) return null;
    var st = peekCareer(profile);
    var cs = st.championships[champ.id];
    // season over: the next round is round 1 of the next season, which only exists once entered again
    if (cs && cs.status === 'complete') return null;
    var view = previewSeason(st, champ);
    var idx = view.roundsCompleted;
    if (idx >= champ.rounds.length) return null;
    var rd = champ.rounds[idx];
    var ti = trackInfo(rd.trackId);
    var diff = difficultyFor(champ, idx, view.difficultySetting || profile);
    return {
      champId: champ.id, champName: champ.name, roundIdx: idx, roundNumber: idx + 1, roundsTotal: champ.rounds.length, round: rd, name: rd.name,
      season: view.season, isFinal: rd.isFinal, entered: !!(cs && cs.status === 'active'), eventType: rd.eventType, eventTypeName: rd.eventTypeName,
      trackId: ti.id, trackName: ti.name, track: ti, laps: rd.laps, weather: view.weather[idx], timeOfDay: rd.timeOfDay, difficulty: diff,
      date: dateLabel(champ, idx, view.season), opponents: opponentsFor(champ, view, idx).length
    };
  }

  /** calendar(profile, champId) -> rounds with date labels, status and results */
  function calendar(profile, champId) {
    var champ = getChampionship(champId);
    if (!champ) return [];
    var st = peekCareer(profile);
    var cs = st.championships[champ.id];
    var view = cs && cs.status === 'active' ? cs : previewSeason(st, champ);
    var done = view.roundsCompleted;
    return champ.rounds.map(function (rd, i) {
      var res = cs && cs.status === 'active' ? cs.results[i] : null;
      var ti = trackInfo(rd.trackId);
      return {
        index: i, roundNumber: i + 1, name: rd.name, desc: rd.desc, trackId: ti.id, trackName: ti.name, length_m: ti.length_m, laps: rd.laps,
        distance_km: Math.round(ti.length_m * rd.laps / 100) / 10, eventType: rd.eventType, eventTypeName: rd.eventTypeName, special: rd.special,
        weather: view.weather[i], forecast: rd.weather, timeOfDay: rd.timeOfDay, isFinal: rd.isFinal, date: dateLabel(champ, i, view.season),
        status: i < done ? 'done' : i === done ? 'next' : 'upcoming', difficulty: difficultyFor(champ, i, view.difficultySetting || profile),
        result: res ? { position: res.playerPosition, points: res.playerPoints, winner: res.winner, winnerName: driverInfo(res.winner, profile).name, status: res.playerStatus, simulated: !!res.simulated } : null,
        doublePoints: !!(rd.isFinal && systemOf(champ).finalRoundMultiplier), rules: rd.rules
      };
    });
  }

  /** standings(profile, champId) -> sorted standings rows (preview grid at zero points when not entered) */
  function standings(profile, champId) {
    var champ = getChampionship(champId);
    if (!champ) return [];
    var st = peekCareer(profile);
    var cs = st.championships[champ.id];
    if (cs && (cs.status === 'active' || cs.status === 'complete')) return standingsRows(cs, profile);
    return standingsRows(previewSeason(st, champ), profile);
  }

  /** Points still available to the player after `doneRounds` rounds. */
  function pointsRemaining(champ, doneRounds) {
    var sys = systemOf(champ), maxPer = (sys.table[0] || 0) + (sys.fastestLap || 0) + (sys.pole || 0) + (sys.bestScoreBonus || 0) + (sys.finishPoint || 0), total = 0;
    for (var i = doneRounds; i < champ.rounds.length; i++) total += maxPer * (champ.rounds[i].isFinal && sys.finalRoundMultiplier ? sys.finalRoundMultiplier : 1);
    return total;
  }

  /** briefing(profile, champId, roundIdx?) -> pre-race briefing */
  function briefing(profile, champId, roundIdx) {
    var champ = getChampionship(champId);
    if (!champ) return null;
    var st = peekCareer(profile);
    var cs = previewSeason(st, champ);
    var idx = isNum(roundIdx) ? clamp(Math.round(roundIdx), 0, champ.rounds.length - 1) : Math.min(cs.roundsCompleted, champ.rounds.length - 1);
    var rd = champ.rounds[idx], ti = trackInfo(rd.trackId);
    var diff = difficultyFor(champ, idx, cs.difficultySetting || profile);
    var table = standingsRows(cs, profile);
    var me = table.filter(function (r) { return r.isPlayer; })[0];
    var leader = table[0];
    var remaining = pointsRemaining(champ, idx);
    var weather = cs.weather[idx];
    var pname = playerName(profile);
    var sys = systemOf(champ);
    var stakes = [];
    if (me && leader && cs.roundsCompleted > 0) {
      if (me.position === 1) {
        var second = table[1];
        var lead = second ? me.points - second.points : me.points;
        var after = remaining - (sys.table[0] || 0) * (rd.isFinal && sys.finalRoundMultiplier ? sys.finalRoundMultiplier : 1);
        stakes.push('You lead by ' + lead + ' point' + (lead === 1 ? '' : 's') + '.');
        if (second && lead > after && after >= 0) stakes.push('Win here and the title is yours.');
      } else {
        var gap = leader.points - me.points;
        stakes.push('You are ' + ordinal(me.position) + ', ' + gap + ' point' + (gap === 1 ? '' : 's') + ' behind ' + leader.name + '.');
        if (gap > remaining) stakes.push('The title is out of reach — fight for ' + ordinal(Math.max(2, me.position - 1)) + '.');
        else if (gap > remaining - (sys.table[0] || 0)) stakes.push('Anything less than a win and ' + leader.name + ' can wrap it up.');
      }
    } else stakes.push(idx === 0 ? 'Season opener — every point counts from here.' : 'Round ' + (idx + 1) + ' of ' + champ.rounds.length + '.');
    if (rd.isFinal && sys.finalRoundMultiplier) stakes.push('Double points in the finale.');
    if (champ.eventType === 'rivals') stakes.push('First to ' + champ.duelTarget + ' wins takes the duel.');
    var rivalLines = [];
    var oppIds = opponentsFor(champ, cs, idx);
    champ.rivals.forEach(function (rid) {
      if (cs.field.indexOf(rid) < 0) return;
      var rs = st.rivals[rid];
      var rrow = table.filter(function (r) { return r.id === rid; })[0];
      var sit = !rs || !rs.met ? 'intro' : rd.isFinal ? 'preFinale' : weather === 'wet' ? 'rain' : 'preRace';
      if (sit === 'preRace' && me && rrow && cs.roundsCompleted > 0 && (cs.roundsCompleted % 2 === 1)) sit = me.points > rrow.points ? 'playerLeads' : rrow.points > me.points ? 'rivalLeads' : 'preRace';
      if (champ.eventType === 'rivals' && idx === 0) sit = 'duelChallenge';
      if (rs && rs.respect >= 70 && sit === 'preRace') sit = 'respect';
      rivalLines.push({ rival: rid, name: getRival(rid).name, title: getRival(rid).title, color: getRival(rid).color, situation: sit, mood: moodOf(rs),
        text: rivalLine(rid, sit, { player: pname, track: ti.name, champ: champ.name, gap: me && rrow ? Math.abs(me.points - rrow.points) : 0, seed: cs.seed, round: idx + 1 }) });
    });
    var et = EVENT_TYPES[rd.eventType];
    var objectives = [];
    if (et.scoring === 'position') objectives.push('Finish as high as possible: ' + sys.table.slice(0, 3).join('-') + ' points for the podium');
    if (et.id === 'time-attack') objectives.push('Set your best single lap in ' + rd.laps + ' flying laps; deleted laps do not count');
    if (et.id === 'drift') objectives.push('Score drift points across ' + Math.max(2, rd.laps * 2) + ' judged runs — link corners for the multiplier');
    if (et.id === 'drag') objectives.push('Heads-up standing start over ' + Math.round(num(rd.rules.distance_m, 402.336)) + ' m — reaction time counts');
    if (et.id === 'eliminator') objectives.push('Last car at the end of every lap is eliminated');
    if (et.id === 'endurance') objectives.push(num(rd.rules.mandatoryPitStops, 1) + ' mandatory pit stop' + (num(rd.rules.mandatoryPitStops, 1) > 1 ? 's' : '') + ' — manage tyres and fuel');
    if (sys.fastestLap) objectives.push('+' + sys.fastestLap + ' point for the fastest lap (top ' + (sys.fastestLapTopN || 10) + ')');
    if (sys.pole) objectives.push('+' + sys.pole + ' point for pole position');
    var build = activeBuild(profile);
    return {
      champId: champ.id, champName: champ.name, roundIdx: idx, roundNumber: idx + 1, roundsTotal: champ.rounds.length, season: cs.season,
      title: champ.short + ' · Round ' + (idx + 1) + ': ' + rd.name, name: rd.name, desc: rd.desc || ti.desc || '', isFinal: rd.isFinal,
      track: ti, trackId: ti.id, laps: rd.laps, distance_km: Math.round(ti.length_m * rd.laps / 100) / 10, weather: weather, forecast: rd.weather,
      timeOfDay: rd.timeOfDay, eventType: rd.eventType, eventTypeName: rd.eventTypeName, eventDesc: et.desc, special: rd.special,
      difficulty: diff, date: dateLabel(champ, idx, cs.season), opponents: oppIds.length, field: cs.field.length + 1,
      opponentList: oppIds.map(function (id) { return driverInfo(id, profile); }),
      stakes: stakes, stakesText: stakes.join(' '), rivals: rivalLines, rivalLine: rivalLines[0] ? rivalLines[0].text : '', objectives: objectives,
      standings: table.slice(0, 10), playerPosition: me ? me.position : null, playerPositionText: me ? (me.unranked ? '\u2014' : ordinal(me.position)) : '\u2014', playerPoints: me ? me.points : 0, pointsRemaining: remaining,
      eligibility: checkEligibility(build, champ), rules: rd.rules, sponsor: champ.sponsor,
      text: (rd.desc ? rd.desc + ' ' : '') + ti.name + ', ' + rd.laps + ' lap' + (rd.laps > 1 ? 's' : '') + ' · ' + titleCase(weather) + ' · ' + titleCase(rd.timeOfDay) + '. ' + stakes.join(' ')
    };
  }

  /** trophies(profile) -> trophy cabinet: won trophies + empty plinths for every championship */
  function trophies(profile) {
    var st = peekCareer(profile);
    var won = st.trophies.slice().sort(function (a, b) { return b.t - a.t; });
    var slots = catalog.championships.map(function (c) {
      var mine = st.trophies.filter(function (t) { return t.champId === c.id; });
      var best = mine.slice().sort(function (a, b) { return a.position - b.position; })[0] || null;
      return { champId: c.id, name: c.trophy.name, champName: c.name, tierId: c.tierId, tierIndex: c.tierIndex, kind: c.kind, material: c.trophy.material,
        won: !!best, best: best, count: mine.length, golds: mine.filter(function (t) { return t.medal === 'gold'; }).length };
    });
    return { trophies: won, slots: slots, count: won.length, golds: won.filter(function (t) { return t.medal === 'gold'; }).length,
      byTier: TIERS.map(function (t) { return { tierId: t.id, name: t.name, count: won.filter(function (x) { return x.tierId === t.id; }).length }; }) };
  }

  /* ======================================================================
     Racing: session config for CB.race.engine
     ====================================================================== */
  /** Opponent driver ids of the field that take part in round `idx` (heads-up / solo formats use subsets). */
  function opponentsFor(champ, cs, idx) {
    var rd = champ.rounds[idx];
    if (!rd) return [];
    if (champ.eventType === 'rivals') return [champ.rival];
    var et = EVENT_TYPES[rd.eventType];
    if (et.solo) return [];
    var field = cs.field.slice();
    if (rd.eventType === 'drag') {
      // heads-up: the rival when present, else the driver directly ahead in the standings (the leader races P2)
      var rv = champ.rivals.filter(function (r) { return field.indexOf(r) >= 0; });
      if (rv.length && (idx % 2 === 1 || rd.isFinal || idx === 0)) return [rv[0]];
      var rows = Object.keys(cs.standings || {}).length ? sortStandings(Object.keys(cs.standings).map(function (k) { return Object.assign({}, cs.standings[k]); })) : [];
      var pi = -1;
      rows.forEach(function (r, i) { if (r.id === 'player') pi = i; });
      var opp = pi > 0 ? rows[pi - 1] : rows[1];
      return [opp && opp.id !== 'player' ? opp.id : field[idx % field.length]];
    }
    var n = rd.opponents || champ.opponents;
    return field.slice(0, clamp(n, 1, 11));
  }

  function aiSkillFor(d, diff, fieldTalents) {
    var lo = Math.min.apply(null, fieldTalents), hi = Math.max.apply(null, fieldTalents);
    var rel = hi - lo > 1e-6 ? (num(d.talent, 0.5) - lo) / (hi - lo) : 0.5;
    var s = lerp(diff.skill[0], diff.skill[1], rel) + (d.isRival ? 0.03 : 0);
    return Math.round(clamp(s, 0.2, 0.99) * 1000) / 1000;
  }

  /**
   * careerHooks(extras, laps) -> CB.race.engine cfg.hooks object enforcing the career's special-event rules, or null.
   * Uses the engine hook contract (carCreated / postStep run for every car, every fixed step):
   *   - eliminator {everyLaps, startAfterLap}: each time the leader completes a counted lap (before the final one), the
   *     last-placed car still running is retired (dnf, dnfReason 'eliminated'); the engine then parks it and ranks it
   *     behind the survivors in elimination order.
   *   - drag {distance_m}: each car is flagged once it has covered distance_m from its own start (so a staggered grid is
   *     fair); the session ends when every car has run. raceTime_s on the row is the elapsed time incl. reaction.
   *   - fuelAllowance (fraction of the tank): the total fuel a car may load over the race — the starting fill plus every
   *     refuel — is capped at tank * fuelAllowance (needs the endurance hooks' car.endurance state).
   * State lives on the engine's car objects, so a restarted session (fresh cars) starts clean.
   */
  function careerHooks(extras, laps) {
    extras = extras || {};
    var elim = isObj(extras.eliminator) ? extras.eliminator : null;
    var drag = isObj(extras.drag) && num(extras.drag.distance_m, 0) > 0 ? extras.drag : null;
    var allowance = isNum(extras.fuelAllowance) && extras.fuelAllowance > 0 && extras.fuelAllowance < 1 ? extras.fuelAllowance : null;
    if (!elim && !drag && !allowance) return null;
    var cars = [], eliminated = 0, totalLaps = Math.max(1, Math.round(num(laps, 1)));
    var every = elim ? Math.max(1, Math.round(num(elim.everyLaps, 1))) : 1, after = elim ? Math.max(1, Math.round(num(elim.startAfterLap, 1))) : 1;
    function lapsOf(c) { return c.finished ? num(c.finishLaps, 0) : num(c.tracker && c.tracker.lap, 0); }
    function eliminatorStep() {
      var lead = 0, running = [];
      for (var i = 0; i < cars.length; i++) {
        var c = cars[i];
        lead = Math.max(lead, lapsOf(c));
        if (!c.finished && !c.dnf) running.push(c);
      }
      // laps that eliminate: after, after+every, ... strictly before the final lap (the flag decides the last one)
      var upTo = Math.min(lead, totalLaps - 1), due = upTo >= after ? Math.floor((upTo - after) / every) + 1 : 0;
      while (eliminated < due && running.length > 1) {
        var last = running[0];
        for (var k = 1; k < running.length; k++) if (num(running[k].position, 0) > num(last.position, 0)) last = running[k];
        last.dnf = true; last.dnfReason = 'eliminated'; last.dnfT = last._cbClock;
        last.eliminatedLap = upTo;
        running.splice(running.indexOf(last), 1);
        eliminated++;
      }
      if (eliminated < due && running.length <= 1) eliminated = due;
    }
    function dragStep(c, dt) {
      if (c.finished || c.dnf) return;
      if (c._cbGo == null) {
        if (!(num(c.lapStartT, 0) > 0)) return;          // lights not out yet
        c._cbGo = c.lapStartT; c._cbD0 = num(c.raceDist, 0);
        return;
      }
      var target = c._cbD0 + num(drag.distance_m, 402.336), d1 = num(c.raceDist, 0);
      if (d1 < target) return;
      // raceDist was last updated at the previous step (clock - dt); interpolate the crossing inside that step
      var d0 = num(c.prevDist, d1), frac = d1 > d0 ? clamp((target - d0) / (d1 - d0), 0, 1) : 1;
      var tc = c._cbClock - 2 * dt + frac * dt;
      c.finished = true; c.finishT = tc; c.finishRaceT = Math.max(0, tc - c._cbGo);
      c.finishDist = c.raceDist; c.finishLaps = num(c.tracker && c.tracker.lap, 0);
      c.dragFinish = { distance_m: num(drag.distance_m, 402.336), et_s: c.finishRaceT - num(c.reaction, 0), trap_kph: Math.abs(num(c.state && c.state.speed, 0)) * 3.6 };
    }
    function fuelStep(c) {
      var cs = c.endurance;
      if (!isObj(cs) || cs.isEV || !(num(cs.tankCapacity_l, 0) > 0) || !isNum(cs.fuel_l)) return;
      var budget = cs.tankCapacity_l * allowance;
      if (c._cbFuel == null) {
        if (cs.fuel_l > budget) cs.fuel_l = budget;
        c._cbFuel = { loaded: cs.fuel_l, last: cs.fuel_l };
        return;
      }
      var f = c._cbFuel;
      if (cs.fuel_l > f.last + 1e-6) {                      // refuelled in the pits: count it against the allowance
        var add = cs.fuel_l - f.last, room = Math.max(0, budget - f.loaded);
        if (add > room) { cs.fuel_l = f.last + room; add = room; }
        f.loaded += add;
      }
      f.last = cs.fuel_l;
    }
    return {
      careerRules: { eliminator: elim, drag: drag, fuelAllowance: allowance },
      carCreated: function (car) {
        if (!car) return null;
        // a new session (restart) creates new car objects: start over
        for (var i = 0; i < cars.length; i++) if (cars[i].id === car.id) { cars = []; eliminated = 0; break; }
        car._cbClock = 0;
        cars.push(car);
        return null;
      },
      postStep: function (car, dt) {
        if (!car) return;
        dt = num(dt, 1 / 120);
        car._cbClock = num(car._cbClock, 0) + dt;
        if (drag) dragStep(car, dt);
        if (allowance) fuelStep(car);
        if (elim && car === cars[cars.length - 1]) eliminatorStep();   // once per step, after every car has moved
      }
    };
  }

  /* ---------------------------------------------------------- AI field eligibility (championship rules) */
  // List requirements an AI build can be conformed to by switching the option (build path per requirement key).
  var AI_LIST_FIX = { bodyStyles: 'body.style', drivetrain: 'drivetrain.layout', engineTypes: 'engine.type', engineLayouts: 'engine.layout',
    aspirations: 'engine.aspiration', enginePositions: 'engine.position', tireCompounds: 'tires.compound', transmissions: 'transmission.type',
    chassisMaterials: 'body.chassisMaterial', fuels: 'engine.fuel', wings: 'aero.wing' };
  function setPath(o, path, v) {
    var p = path.split('.'), cur = o;
    for (var i = 0; i < p.length - 1; i++) { if (!isObj(cur[p[i]])) cur[p[i]] = {}; cur = cur[p[i]]; }
    cur[p[p.length - 1]] = v;
  }
  function layoutRange(id) {
    var o = null;
    if (CB.data && typeof CB.data.find === 'function') { try { o = CB.data.find('engineLayouts', id); } catch (e) { o = null; } }
    return o && Array.isArray(o.displacementRange) ? o.displacementRange : [1.0, 8.0];
  }
  /** Power window (hp) an AI car of this championship should sit in: the tier reference, inside the regulations. */
  function aiPowerWindow(champ) {
    var req = champ.requirements || {}, ref = (champ.refPerf || TIER_REF_PERF[0]).power_hp;
    var lo = ref * 0.6, hi = ref * 1.45;
    if (isNum(req.minPower_hp)) lo = Math.max(lo, req.minPower_hp * 1.03);
    if (isNum(req.maxPower_hp)) hi = Math.min(hi, req.maxPower_hp * 0.97);
    if (lo > hi) { if (isNum(req.maxPower_hp) && lo > req.maxPower_hp * 0.97) lo = Math.min(req.maxPower_hp * 0.9, hi); else hi = lo * 1.1; }
    return { lo: lo, hi: Math.max(lo, hi) };
  }
  /** Scale an AI build's engine towards targetHp (motor power / boost / displacement; stock tune when it must shrink). */
  function setAiPower(b, targetHp) {
    var e = b.engine = isObj(b.engine) ? b.engine : {};
    for (var it = 0; it < 14; it++) {
      var hp = num(metricsFor(b).power_hp, 0);
      if (!(hp > 0)) return;
      var f = targetHp / hp;
      if (Math.abs(f - 1) < 0.025) return;
      var type = e.type || 'ice', moved = false;
      if (type === 'ev' || type === 'hybrid') {
        var kw = num(e.motorPower_kw, 150), nkw = Math.round(clamp(kw * (type === 'ev' ? f : Math.pow(f, 1.4)), 50, 500));
        if (nkw !== kw) { e.motorPower_kw = nkw; moved = true; }
      }
      if (type !== 'ev') {
        if (f < 1 && e.tune && e.tune !== 'stock' && it > 2) { e.tune = 'stock'; moved = true; continue; }
        if (e.aspiration && e.aspiration !== 'na' && isNum(e.boost_bar)) {
          var nb = Math.round(clamp(e.boost_bar + (f - 1) * 2.5, 0.3, 2.8) * 100) / 100;
          if (nb !== e.boost_bar) { e.boost_bar = nb; moved = true; }
        }
        var r = layoutRange(e.layout), d = num(e.displacement_l, 2), nd = Math.round(clamp(d * Math.pow(f, 0.9), r[0], r[1]) * 10) / 10;
        if (nd !== d) { e.displacement_l = nd; moved = true; }
      }
      if (!moved) return;
    }
  }
  /** Conform a (cloned) AI build to the championship regulations and the tier's performance window. */
  function conformAiBuild(b, champ) {
    var req = champ.requirements || {};
    Object.keys(AI_LIST_FIX).forEach(function (k) {
      var allowed = listify(req[k]);
      if (!allowed || !allowed.length) return;
      var path = AI_LIST_FIX[k], cur = get(b, path);
      if (allowed.indexOf(cur) >= 0) return;
      if (get(b, 'engine.type') === 'ev' && (k === 'engineLayouts' || k === 'aspirations' || k === 'fuels')) return;
      setPath(b, path, allowed[0]);
      if (k === 'bodyStyles') setPath(b, 'body.model', null);
      if (k === 'engineTypes') {
        var e = b.engine;
        if (allowed[0] !== 'ice') { if (!isNum(e.motorPower_kw)) e.motorPower_kw = allowed[0] === 'ev' ? 200 : 90; if (!isNum(e.motors)) e.motors = allowed[0] === 'ev' ? 2 : 1; if (!isNum(e.battery_kwh)) e.battery_kwh = allowed[0] === 'ev' ? 80 : 8; }
        if (allowed[0] !== 'ev') { if (!e.layout) e.layout = 'I4'; if (!isNum(e.displacement_l)) e.displacement_l = 2.0; if (!e.aspiration) e.aspiration = 'turbo'; if (!e.fuel) e.fuel = 'premium'; }
      }
      if (k === 'engineLayouts') { var rr = layoutRange(allowed[0]); b.engine.displacement_l = Math.round(clamp(num(b.engine.displacement_l, 2), rr[0], rr[1]) * 10) / 10; }
    });
    if (isNum(req.maxDisplacement_l) && get(b, 'engine.type') !== 'ev' && num(get(b, 'engine.displacement_l'), 0) > req.maxDisplacement_l) b.engine.displacement_l = req.maxDisplacement_l;
    if (isNum(req.minSeats)) { setPath(b, 'body.seats', Math.max(num(get(b, 'body.seats'), 2), req.minSeats)); if (b.weight) b.weight.rearSeats = true; }
    if (isNum(req.maxBattery_kwh) && get(b, 'engine.type') !== 'ice' && num(get(b, 'engine.battery_kwh'), 0) > req.maxBattery_kwh) b.engine.battery_kwh = req.maxBattery_kwh;
    var w = aiPowerWindow(champ), hp = num(metricsFor(b).power_hp, 0);
    if (hp < w.lo || hp > w.hi) setAiPower(b, clamp(hp, w.lo, w.hi));
    // weight / power-to-weight: ballast or shed ballast
    if (!isObj(b.weight)) b.weight = {};
    if (isNum(req.maxWeight_kg)) {
      // lightweight build steps, in order, until the car makes the weight limit
      var mats = listify(req.chassisMaterials), lighter = ['aluminum', 'carbon-tub', 'carbon-monocoque'];
      var steps = [
        function () { b.weight.ballast_kg = 0; b.weight.soundDeadening = false; b.weight.spareTire = false; },
        function () { b.weight.glass = 'polycarbonate'; b.weight.battery = 'lithium'; if (!isNum(req.minSeats)) { b.weight.rearSeats = false; setPath(b, 'body.seats', 2); } },
        function () { var ok = lighter.filter(function (x) { return !mats || mats.indexOf(x) >= 0; }); if (ok.length) b.body.chassisMaterial = ok[ok.length - 1]; },
        function () {
          setPath(b, 'body.wheelbase_mm', Math.min(num(get(b, 'body.wheelbase_mm'), 2500), 2300)); setPath(b, 'body.trackWidth_mm', Math.min(num(get(b, 'body.trackWidth_mm'), 1500), 1450));
          if (get(b, 'engine.type') !== 'ev') { var r0 = layoutRange(b.engine.layout); b.engine.displacement_l = Math.max(r0[0], Math.min(num(b.engine.displacement_l, 2), 1.8)); }
        },
        function () { if (!isObj(b.wheels)) b.wheels = {}; b.wheels.material = 'magnesium'; b.wheels.diameter_in = Math.min(num(b.wheels.diameter_in, 17), 15); if (!isObj(b.interior)) b.interior = {}; b.interior.seatType = 'bucket'; }
      ];
      for (var si = 0; si < steps.length && num(metricsFor(b).weight_kg, 0) > req.maxWeight_kg - 5; si++) steps[si]();
      var w2 = aiPowerWindow(champ), hp2 = num(metricsFor(b).power_hp, 0);
      if (hp2 < w2.lo || hp2 > w2.hi) setAiPower(b, clamp(hp2, w2.lo, w2.hi));
    }
    for (var g = 0; g < 4; g++) {
      var m = metricsFor(b), kg = num(m.weight_kg, 1400), bal = num(b.weight.ballast_kg, 0);
      if (isNum(req.minWeight_kg) && kg < req.minWeight_kg + 5) b.weight.ballast_kg = Math.round(bal + req.minWeight_kg + 10 - kg);
      else if (isNum(req.maxWeight_kg) && kg > req.maxWeight_kg - 5 && bal > 0) b.weight.ballast_kg = Math.max(0, Math.round(bal - (kg - req.maxWeight_kg + 10)));
      else if (isNum(req.maxPowerToWeight) && m.power_hp / (kg / 1000) > req.maxPowerToWeight * 0.98) setAiPower(b, req.maxPowerToWeight * 0.95 * kg / 1000);
      else break;
    }
    return b;
  }
  /** Candidate AI base builds for a championship (presets + the player's car), conformed and eligibility-checked. */
  function aiEligiblePool(champ, playerBuild) {
    var bases = [];
    if (CB.data && typeof CB.data.list === 'function' && typeof CB.data.presetBuild === 'function') {
      try { (CB.data.list('presets') || []).forEach(function (p) { var pb = CB.data.presetBuild(p.id); if (pb) bases.push(pb); }); } catch (e) { /* none */ }
    }
    if (isObj(playerBuild)) bases.push(clone(playerBuild));
    var out = [];
    bases.forEach(function (b0) {
      var b = clone(b0);
      if (!checkEligibility(b, champ).ok) b = conformAiBuild(b, champ);
      if (checkEligibility(b, champ).ok) out.push(b);
    });
    // regulation-first preference: bases that needed the fewest changes come first (stable)
    return out;
  }
  /** Real model metadata (CB.shapes) compatible with the regulations (and, preferably, with the build itself). */
  function aiModelFits(m, champ, b, strict) {
    var req = champ.requirements || {};
    var dl = listify(req.drivetrain), et = listify(req.engineTypes), ep = listify(req.enginePositions), bs = listify(req.bodyStyles);
    if (bs && bs.length && m.style && bs.indexOf(m.style) < 0) return false;
    if (dl && dl.length && m.drivetrain && dl.indexOf(m.drivetrain) < 0) return false;
    if (et && et.length && m.powertrain && et.indexOf(m.powertrain) < 0) return false;
    if (ep && ep.length && m.enginePosition && ep.indexOf(m.enginePosition) < 0) return false;
    if (strict) {
      if (m.drivetrain && m.drivetrain !== get(b, 'drivetrain.layout')) return false;
      if (m.powertrain && m.powertrain !== get(b, 'engine.type')) return false;
      if (m.enginePosition && get(b, 'engine.position') && m.enginePosition !== get(b, 'engine.position')) return false;
    }
    return true;
  }
  function aiShapeModels(style) {
    var A = aiMod();
    if (A && A._internal && typeof A._internal.shapeModels === 'function') { try { return A._internal.shapeModels(style) || []; } catch (e) { /* none */ } }
    if (CB.shapes && typeof CB.shapes.modelsByStyle === 'function') { try { return CB.shapes.modelsByStyle(style) || []; } catch (e2) { /* none */ } }
    return [];
  }
  /**
   * eligibleAiCar(g, champ, ctx) -> grid entry whose build passes checkEligibility(champ) and whose real model fits the
   * regulations: ineligible builds are conformed (or replaced by an eligible preset / the player's car, rescaled to the
   * tier's power window). ctx {pool, use, i}: shared per grid (lazy pool, model usage counts).
   */
  function eligibleAiCar(g, champ, ctx) {
    var b = isObj(g.build) ? clone(g.build) : null, req = champ.requirements || {};
    var changed = false;
    if (b) {
      var w = aiPowerWindow(champ), hp = num(metricsFor(b).power_hp, 0);
      if (!checkEligibility(b, champ).ok || hp < w.lo * 0.85 || hp > w.hi * 1.15) { b = conformAiBuild(b, champ); changed = true; }
    }
    if (!b || !checkEligibility(b, champ).ok) {
      if (!ctx.pool) ctx.pool = aiEligiblePool(champ, ctx.playerBuild);
      if (ctx.pool.length) {
        var keep = b ? b.exterior : get(g, 'build.exterior', null), found = null;
        // spread the field around the tier power window (deterministic per grid slot)
        var win = aiPowerWindow(champ), n = Math.max(2, ctx.count || 2), t = (ctx.i % n) / (n - 1);
        for (var pi = 0; pi < ctx.pool.length && !found; pi++) {
          var base = ctx.pool[(ctx.i + pi) % ctx.pool.length];
          for (var tryPow = 1; tryPow >= 0 && !found; tryPow--) {
            var cb = clone(base);
            if (keep) cb.exterior = Object.assign({}, cb.exterior || {}, keep);
            if (tryPow) setAiPower(cb, win.lo + (win.hi - win.lo) * (0.35 + 0.4 * t));
            if (checkEligibility(cb, champ).ok) found = cb;
          }
        }
        b = found || clone(ctx.pool[ctx.i % ctx.pool.length]);
        if (b.meta && g.build && g.build.meta) b.meta = Object.assign({}, b.meta, { name: g.build.meta.name, id: g.build.meta.id, driver: g.build.meta.driver });
        changed = true;
      }
    }
    ctx.i++;
    if (!b) return g;
    // real model: must fit the regulations; prefer one matching the build's drivetrain & powertrain, least used in the field
    var style = get(b, 'body.style', 'coupe'), list = aiShapeModels(style), curId = get(b, 'body.model', null);
    var cur = null;
    list.forEach(function (m) { if (m.id === curId) cur = m; });
    var model = cur;
    if (list.length && (!cur || !aiModelFits(cur, champ, b, false) || (changed && !aiModelFits(cur, champ, b, true)))) {
      var alignTo = function (m) {
        var ab = clone(b);
        if (m.drivetrain) setPath(ab, 'drivetrain.layout', m.drivetrain === '4wd' ? 'awd' : m.drivetrain);
        if (m.enginePosition) setPath(ab, 'engine.position', m.enginePosition);
        setPath(ab, 'body.model', m.id);
        return ab;
      };
      var pick = function (strict) {
        var best = null, bc = Infinity;
        list.forEach(function (m) {
          if (!aiModelFits(m, champ, b, strict === true)) return;
          if (strict === 'align' && !checkEligibility(alignTo(m), champ).ok) return;
          var c = ctx.use[m.id] || 0;
          if (c < bc) { bc = c; best = m; }
        });
        return best;
      };
      model = pick(true) || pick('align') || pick(false);
      if (!model) {
        // no real model of this style fits the regulations: move to an allowed style that has one (if the car stays legal)
        var styles = listify(req.bodyStyles) || ['coupe', 'sedan', 'hatchback', 'hypercar', 'roadster', 'wagon', 'shooting-brake', 'suv', 'pickup', 'van'];
        for (var sx = 0; sx < styles.length && !model; sx++) {
          if (styles[sx] === style) continue;
          var l2 = aiShapeModels(styles[sx]);
          if (!l2.length) continue;
          var tb = clone(b); setPath(tb, 'body.style', styles[sx]); setPath(tb, 'body.model', null);
          var saveList = list, saveB = b;
          list = l2; b = tb;
          var mm = pick(true) || pick(false);
          if (mm && checkEligibility(tb, champ).ok) { model = mm; style = styles[sx]; }
          else { list = saveList; b = saveB; }
        }
      }
      if (!model) model = cur;
      // a real model brings its real layout along when the regulations allow it (no FWD 918 Spyder)
      if (model && !aiModelFits(model, champ, b, true)) {
        var ab = alignTo(model);
        if (checkEligibility(ab, champ).ok) b = ab;
      }
      if (model && model !== cur) { if (cur && ctx.use[cur.id]) ctx.use[cur.id]--; ctx.use[model.id] = (ctx.use[model.id] || 0) + 1; changed = true; }
    }
    if (!changed) return g;
    if (model) {
      var prevModel = get(b, 'body.model', null);
      setPath(b, 'body.model', model.id);
      if (!checkEligibility(b, champ).ok) { setPath(b, 'body.model', prevModel); if (!checkEligibility(b, champ).ok) setPath(b, 'body.model', model.id); }
    }
    var o = {};
    for (var k in g) if (hasOwn.call(g, k)) o[k] = g[k];
    o.build = b; o.bodyStyle = style;
    o.model = model ? model.id : null;
    o.carName = model ? ((model.make ? model.make + ' ' : '') + (model.name || model.id)) : null;
    o.origin = (g.origin || 'variation') + '+rules';
    var A = aiMod();
    if (A && typeof A.perfIndex === 'function') { try { o.perfIndex = Math.round(A.perfIndex(b) * 10) / 10; } catch (e) { /* keep */ } }
    return o;
  }
  /** Make every AI car of a championship grid legal for its regulations (no-op for open championships with tier-fit cars). */
  function eligibleGrid(grid, champ, playerBuild) {
    if (!Array.isArray(grid) || !champ) return grid;
    var ctx = { pool: null, use: {}, i: 0, count: grid.length, playerBuild: playerBuild };
    grid.forEach(function (g) { var id = get(g, 'build.body.model', null); if (id) ctx.use[id] = (ctx.use[id] || 0) + 1; });
    return grid.map(function (g) { return isObj(g) ? eligibleAiCar(g, champ, ctx) : g; });
  }

  /**
   * raceConfigFor(profile, champId, roundIdx?, opts {build, assists, seed}) -> CB.race.engine.createSession cfg
   *   + extras {eventType, wear, fuel, damage, pitStops, fuelAllowance, endurance, eliminator, drag, drift, headsUp}
   *   + career {champId, roundIdx, season, ...} + settings (hub/race-ui setup mirror) + context (hub launch context)
   */
  function raceConfigFor(profile, champId, roundIdx, opts) {
    opts = opts || {};
    var champ = getChampionship(champId);
    if (!champ) return null;
    var st = peekCareer(profile);
    var cs = previewSeason(st, champ);
    var idx = isNum(roundIdx) ? clamp(Math.round(roundIdx), 0, champ.rounds.length - 1) : Math.min(cs.roundsCompleted, champ.rounds.length - 1);
    var rd = champ.rounds[idx];
    var et = EVENT_TYPES[rd.eventType];
    var diff = difficultyFor(champ, idx, opts.difficulty || cs.difficultySetting || profile);
    var build = opts.build || activeBuild(profile);
    var ids = opponentsFor(champ, cs, idx);
    var seed = (hashStr(cs.seed + '|race|' + idx) >>> 0);
    var drivers = ids.map(function (id) { return getDriver(id) || entrantOf(id); });
    var talents = cs.field.map(function (id) { var d = getDriver(id); return d ? d.talent : 0.5; });
    var A = aiMod(), grid = null;
    if (drivers.length && A && typeof A.createGrid === 'function') {
      try { grid = A.createGrid(build, { count: drivers.length, difficulty: diff.level, field: champ.field, seed: seed }); } catch (e) { grid = null; }
    }
    // AI machinery must obey the championship's regulations (style, drivetrain, powertrain, power caps, ...) and suit the tier
    if (drivers.length) {
      if (!grid) grid = drivers.map(function () { return { build: build ? clone(build) : null }; });
      // the driver's paint goes on first: it is part of the car's value (price caps)
      grid.forEach(function (g, gi) { if (g && isObj(g.build) && drivers[gi]) { g.build.exterior = isObj(g.build.exterior) ? g.build.exterior : {}; g.build.exterior.paint = drivers[gi].color; } });
      try { grid = eligibleGrid(grid, champ, build); } catch (e3) { /* keep the raw grid */ }
    }
    // race numbers must be unique on the grid: the player's livery number wins, a clashing entrant runs a spare number
    var usedNums = {}, playerNum = parseInt(get(build, 'exterior.livery_number', '') || '1', 10);  // CB.race.engine shows an unnumbered player as #1
    if (isNum(playerNum)) usedNums[playerNum] = true;
    var numberFor = function (d) {
      var n = parseInt(d.number, 10);
      if (!isNum(n)) n = 2;
      if (usedNums[n]) {
        var base = n;
        for (var step = 1; step < 200 && usedNums[n]; step++) n = (base + step * 10 + Math.floor(step / 10)) % 100;
      }
      usedNums[n] = true;
      return n;
    };
    var opponents = drivers.map(function (d0, i) {
      var d = d0, raceNo = numberFor(d0);
      if (raceNo !== d0.number) { d = Object.assign({}, d0, { number: raceNo, regularNumber: d0.number }); }
      var g = grid && grid[i] ? grid[i] : {};
      var b = g.build ? g.build : (build ? clone(build) : null);
      if (b) {
        b.exterior = isObj(b.exterior) ? b.exterior : {};
        b.exterior.paint = d.color; b.exterior.livery_number = String(d.number);
        if (b.meta) b.meta.name = d.team;
      }
      var o = {};
      for (var k in g) if (hasOwn.call(g, k)) o[k] = g[k];
      o.id = d.id; o.driverId = d.id; o.name = d.name; o.firstName = d.first; o.lastName = d.last; o.code = d.code; o.nationality = d.nationality;
      o.team = d.team; o.teamId = d.teamId; o.teamShort = d.teamShort; o.number = d.number; o.color = d.color; o.accent = d.accent;
      o.livery = { color: d.color, accent: d.accent, stripe: g.livery && g.livery.stripe, number: d.number };
      o.build = b; o.bodyStyle = get(b, 'body.style', 'coupe');
      o.skill = aiSkillFor(d, diff, talents);
      o.consistency = d.consistency; o.aggression = d.aggression;
      o.difficulty = diff.level; o.isRival = !!d.isRival; o.specialty = d.specialty;
      o.seed = (seed + i * 7919) >>> 0;
      return o;
    });
    var rules = rd.rules || {};
    var isEndu = rd.eventType === 'endurance';
    var extras = {
      eventType: rd.eventType, scoring: et.scoring, endurance: isEndu,
      wear: isEndu ? num(rules.wear, 1) : false, fuel: isEndu ? num(rules.fuel, 1) : false, damage: isEndu ? rules.damage !== false : !!rules.damage,
      pitStops: isEndu ? num(rules.mandatoryPitStops, 1) : 0, mandatoryPitStops: isEndu ? num(rules.mandatoryPitStops, 1) : 0,
      fuelAllowance: isNum(rules.fuelAllowance) ? rules.fuelAllowance : null, contact: rules.contact || 'normal'
    };
    if (rd.eventType === 'eliminator') extras.eliminator = { everyLaps: 1, startAfterLap: 1 };
    if (rd.eventType === 'drag') extras.drag = { distance_m: num(rules.distance_m, 402.336), headsUp: true, christmasTree: true };
    if (rd.eventType === 'drift') extras.drift = { runs: Math.max(2, rd.laps * 2), judged: true, comboWindow_s: 1.6 };
    if (rd.eventType === 'time-attack') extras.timeAttack = { flyingLaps: rd.laps, deleteInvalid: true };
    if (champ.eventType === 'rivals') extras.headsUp = { rival: champ.rival, best: champ.rounds.length, target: champ.duelTarget };
    var startPosition = 'random';
    if (et.scoring === 'position' && opponents.length) {
      // deterministic "qualifying": simulate the grid and drop the player in according to the car's pace
      var q = makeRng(seed ^ 0x9e3779b9);
      var behind = clamp(Math.round(opponents.length * (0.75 - champ.tierIndex * 0.08) * (0.6 + q.next() * 0.8)), 0, opponents.length);
      startPosition = clamp(behind + 1, 1, opponents.length + 1);
      if (champ.eventType === 'rivals') startPosition = idx % 2 === 0 ? 2 : 1;
    }
    var settingsAssists = get(profile, 'settings.assists', null);
    var cfg = {
      trackId: resolveTrackId(rd.trackId), laps: rd.laps, opponents: opponents, opponentCount: opponents.length, playerBuild: build,
      weather: cs.weather[idx] || 'dry', timeOfDay: rd.timeOfDay, mode: et.mode, difficulty: diff.level, field: champ.field,
      seed: seed, playerName: playerName(profile), playerTeam: get(profile, 'teamName', 'Redline Garage'), startPosition: startPosition,
      rubberBanding: false, extras: extras,
      career: {
        champId: champ.id, roundIdx: idx, season: cs.season, champName: champ.name, roundName: rd.name, tierId: champ.tierId, kind: champ.kind,
        eventType: rd.eventType, pointsSystem: champ.pointsSystem, isFinal: rd.isFinal, rivals: champ.rivals.slice(), fieldSize: cs.field.length + 1,
        difficulty: diff, label: champ.short + ' R' + (idx + 1) + ' · ' + rd.name
      },
      context: { kind: champ.kind === 'event' ? 'event' : 'career', champId: champ.id, roundIdx: idx, eventType: rd.eventType, label: champ.short + ' R' + (idx + 1) + ' · ' + rd.name },
      settings: { trackId: resolveTrackId(rd.trackId), laps: rd.laps, mode: et.mode, opponents: opponents.length, difficulty: diff.level, field: champ.field,
        weather: cs.weather[idx] || 'dry', timeOfDay: rd.timeOfDay }
    };
    if (opts.assists || settingsAssists) cfg.assists = opts.assists || settingsAssists;
    var rulesHooks = careerHooks(extras, rd.laps);
    if (rulesHooks) cfg.hooks = [rulesHooks];
    return cfg;
  }

  /* ======================================================================
     Recording results
     ====================================================================== */
  /**
   * Engine-like results for a simulated session including the player (hub "simulate session", testing).
   * opts: {build, playerSkill 0..1, seed}
   */
  function simulateSession(profile, champId, roundIdx, opts) {
    opts = opts || {};
    var champ = getChampionship(champId);
    if (!champ) return null;
    var st = peekCareer(profile);
    var cs = previewSeason(st, champ);
    var idx = isNum(roundIdx) ? roundIdx : cs.roundsCompleted;
    var rd = champ.rounds[idx];
    if (!rd) return null;
    var build = opts.build || activeBuild(profile);
    var pp = build ? perfOf(build) : champ.refPerf;
    var aiPerf = blendPerf(pp, champ.refPerf, champ.field);
    var paceMult = estimateLapTime(rd.trackId, pp) / Math.max(1, estimateLapTime(rd.trackId, aiPerf));
    var skill = num(opts.playerSkill, clamp(0.55 + profileLevel(profile) * 0.012, 0.5, 0.85));
    var et = rd.eventType;
    var ids = EVENT_TYPES[et].solo ? [] : opponentsFor(champ, cs, idx);
    var field = ids.map(function (id) { return id; });
    field.push({ id: 'player', talent: skill, consistency: 0.78, aggression: 0.45, specialty: 'allrounder', isPlayer: true, paceMult: et === 'drift' ? 1 : paceMult });
    var seed = num(opts.seed, cs.seed);
    var order = simulateRound(champ, idx, field, seed, { weather: cs.weather[idx], perf: aiPerf, calibrate: et === 'time-attack' });
    var fast = order.filter(function (r) { return r.fastestLap; })[0];
    return {
      simulated: true, mode: EVENT_TYPES[et].mode, trackId: resolveTrackId(rd.trackId), lapsTotal: rd.laps, laps: rd.laps, playerId: 'player',
      weather: cs.weather[idx], complete: true, fieldSize: order.length, fastestLap: fast ? { carId: fast.id, time: fast.bestLap_s } : null,
      classification: order.map(function (r) {
        var o = {}; for (var k in r) if (hasOwn.call(r, k)) o[k] = r[k];
        o.isPlayer = r.id === 'player';
        o.name = r.id === 'player' ? playerName(profile) : driverInfo(r.id, profile).name;
        o.totalTime_s = r.time_s; o.laps = r.lapsCompleted;
        if (r.score != null) o.driftScore = r.score;
        return o;
      })
    };
  }

  /**
   * recordResult(profile, champId, roundIdx, results, opts {build, metrics, dns, simulate, achievements, difficulty})
   * Mutates the profile (credits / xp / unlocks / career) and returns the round outcome.
   */
  function recordResult(profile, champId, roundIdx, results, opts) {
    opts = opts || {};
    var champ = getChampionship(champId);
    if (!champ) return { ok: false, reason: 'Unknown championship' };
    if (!isObj(profile)) profile = {};
    var st = careerOf(profile);
    var prevCs = st.championships[champ.id];
    if (prevCs && prevCs.status === 'complete' && !opts.newSeason && isNum(roundIdx) &&
        (roundIdx > 0 || now() - num(prevCs.completedAt, 0) < 5000) && prevCs.results[roundIdx]) {
      // late duplicate of a round of a season that has just finished: nothing is applied twice
      return { ok: true, duplicate: true, pointsTable: prevCs.results[roundIdx].pointsTable, standings: standingsRows(prevCs, profile),
        rewards: { credits: 0, xp: 0, breakdown: [] }, championshipComplete: false, trophy: null, position: prevCs.finalPosition,
        roundPosition: prevCs.results[roundIdx].playerPosition, profile: profile, career: st, events: [] };
    }
    var cs = activeSeason(st, champ, { difficulty: opts.difficulty });
    var idx = cs.roundsCompleted;
    if (isNum(roundIdx) && roundIdx < cs.roundsCompleted && cs.results[roundIdx]) {
      // already recorded (double-callback guard): return the stored outcome without applying anything twice
      var stored = cs.results[roundIdx];
      return { ok: true, duplicate: true, pointsTable: stored.pointsTable, standings: standingsRows(cs, profile), rewards: { credits: 0, xp: 0, breakdown: [] },
        championshipComplete: false, trophy: null, position: null, roundPosition: stored.playerPosition, profile: profile, career: st, events: [] };
    }
    if (idx >= champ.rounds.length) return { ok: false, reason: 'Season already complete' };
    var rd = champ.rounds[idx];
    var simulated = false;
    if (!results && opts.simulate) { results = simulateSession(profile, champ.id, idx, opts); simulated = true; }
    var build = opts.build || (isObj(results) && isObj(results.config) && results.config.playerBuild) || activeBuild(profile);
    var perf = build ? perfOf(build, opts.metrics) : null;
    var diff = difficultyFor(champ, idx, cs.difficultySetting || profile);
    var raced = opponentsFor(champ, cs, idx);
    var order = classifyRound(champ, cs, idx, results, { perf: perf, dns: !!opts.dns || !results, raced: raced, simulated: simulated || !!(results && results.simulated) });
    // duels only score the two protagonists
    if (champ.eventType === 'rivals') {
      order = order.filter(function (r) { return r.id === 'player' || r.id === champ.rival; });
      order.forEach(function (r, i) { r.position = i + 1; });
    }
    var table = scoreOrder(champ, rd, order);
    var prevPositions = {};
    sortStandings(Object.keys(cs.standings).map(function (k) { return Object.assign({}, cs.standings[k]); })).forEach(function (r) { prevPositions[r.id] = r.position; });
    table.forEach(function (p) {
      if (!cs.standings[p.id]) cs.standings[p.id] = emptyRow(p.id);
      addToRow(cs.standings[p.id], p, idx);
    });
    cs.lastPositions = prevPositions;
    var me = table.filter(function (p) { return p.id === 'player'; })[0];
    var winner = table[0];
    var pointsTable = table.map(function (p) {
      var info = driverInfo(p.id, profile), o = {};
      for (var k in p) if (hasOwn.call(p, k)) o[k] = p[k];
      o.name = info.name; o.team = info.team; o.color = info.color; o.number = info.number; o.code = info.code; o.isPlayer = p.id === 'player'; o.isRival = !!info.isRival;
      return o;
    });
    cs.results[idx] = {
      roundIdx: idx, name: rd.name, trackId: resolveTrackId(rd.trackId), weather: cs.weather[idx], t: now(), playerPosition: me.position, playerPoints: me.points,
      playerStatus: me.status, winner: winner.id, simulated: simulated || !!(results && results.simulated), pointsTable: pointsTable.map(function (p) {
        return { id: p.id, position: p.position, points: p.points, status: p.status, gapText: p.gapText, flags: p.flags, bestLap_s: p.bestLap_s, score: p.score, et_s: p.et_s };
      })
    };
    cs.roundsCompleted = idx + 1;

    /* ---- stats */
    var S = st.stats;
    var finished = me.status === 'finished';
    if (me.status !== 'dns') S.rounds++; else S.dns++;
    if (finished && me.position === 1) S.wins++;
    if (finished && me.position <= 3) S.podiums++;
    if (me.pole) S.poles++;
    if (me.fastestLap) S.fastestLaps++;
    if (me.status === 'dnf') S.dnfs++;
    S.points += me.points;
    if (finished && me.position === 1 && isNum(me.gridPosition) && me.gridPosition >= Math.max(4, table.length)) S.comebacks++;
    if (finished && num(me.collisions, 0) === 0 && num(me.penalties_s, 0) === 0) S.cleanRaces++;

    /* ---- round rewards */
    var events = [];
    var rewards = roundRewards(champ, rd, diff, me, champ.eventType === 'rivals' ? 2 : table.length, results, profile);
    var aw = applyAward(profile, rewards.credits, rewards.xp, 'Career · ' + champ.short + ' R' + (idx + 1), 'race');
    S.earnings += Math.max(0, aw.credits); S.xpEarned += aw.xp;
    var levelUp = aw.levelUp ? { from: aw.oldLevel, to: aw.newLevel } : null;

    /* ---- rivals */
    var rivalOut = [];
    var pname = playerName(profile), tname = trackInfo(rd.trackId).name;
    champ.rivals.forEach(function (rid) {
      var rrow = table.filter(function (p) { return p.id === rid; })[0];
      if (!rrow) return;
      var rs = rivalState(st, rid);
      if (!rs.met) {
        rs.met = true; rs.metAt = now();
        triggerBeats(st, rid, 'first-meet', { champId: champ.id }).forEach(function (b) { events.push({ type: 'story', beat: b, text: b.title + ' — ' + b.text }); });
      }
      rs.races++;
      var sit;
      var playerAhead = me.position < rrow.position && me.status !== 'dns';
      if (playerAhead) { rs.ahead++; rs.respect = clamp(rs.respect + (me.position === 1 ? 9 : 5), 0, 100); S.rivalWins++; }
      else { rs.behind++; rs.respect = clamp(rs.respect - 2, 0, 100); S.rivalLosses++; }
      if (me.status === 'dnf') sit = 'playerDnf';
      else if (rrow.status === 'dnf') sit = 'rivalDnf';
      else if (finished && me.position === 1 && isNum(me.gridPosition) && me.gridPosition >= Math.max(4, table.length - 1)) sit = 'comeback';
      else if (finished && me.position === 1) sit = 'playerWon';
      else if (rrow.position === 1) sit = 'rivalWon';
      else sit = playerAhead ? 'playerBeatRival' : 'rivalBeatPlayer';
      if (rs.respect >= 70 && playerAhead && makeRng(cs.seed + idx).chance(0.35)) sit = 'respect';
      var line = rivalLine(rid, sit, { player: pname, track: tname, champ: champ.name, seed: cs.seed, round: idx + 1, gap: Math.abs(me.points - rrow.points) });
      rs.lastLine = line; rs.lastSituation = sit;
      var ro = { id: rid, name: getRival(rid).name, title: getRival(rid).title, situation: sit, text: line, position: rrow.position, playerAhead: playerAhead, respect: rs.respect, mood: moodOf(rs) };
      rivalOut.push(ro);
      events.push({ type: 'rival', rival: rid, situation: sit, text: line });
      if (rrow.status === 'dnf') triggerBeats(st, rid, 'rival-dnf', { champId: champ.id }).forEach(function (b) { events.push({ type: 'story', beat: b, text: b.title + ' — ' + b.text }); });
      if (playerAhead) triggerBeats(st, rid, 'beat-rival', { champId: champ.id }).forEach(function (b) { events.push({ type: 'story', beat: b, text: b.title + ' — ' + b.text }); });
      triggerBeats(st, rid, 'respect', { champId: champ.id }).forEach(function (b) { events.push({ type: 'story', beat: b, text: b.title + ' — ' + b.text }); });
    });

    /* ---- completion */
    var complete = cs.roundsCompleted >= champ.rounds.length;
    if (champ.eventType === 'rivals') {
      var pRow = cs.standings.player, rRow = cs.standings[champ.rival];
      if (pRow && rRow && (pRow.points >= champ.duelTarget || rRow.points >= champ.duelTarget)) complete = true;
    }
    var finalStandings = standingsRows(cs, profile);
    var result = {
      ok: true, champId: champ.id, roundIdx: idx, round: rd, season: cs.season, pointsTable: pointsTable, standings: finalStandings, rewards: rewards,
      championshipComplete: false, trophy: null, position: null, roundPosition: me.position, roundStatus: me.status, roundPoints: me.points,
      rival: rivalOut[0] || null, rivals: rivalOut, unlocked: [], nextRound: null, events: events, profile: profile, career: st, levelUp: levelUp,
      winner: driverInfo(winner.id, profile), simulated: simulated, difficulty: diff
    };
    if (complete) finishSeason(profile, st, champ, cs, result);
    else result.nextRound = nextRound(profile, champ.id);
    var nameR = me.status === 'dns' ? 'DNS' : me.status === 'dnf' ? 'DNF' : 'P' + me.position;
    addLog(st, 'round', champ.short + ' R' + (idx + 1) + ' ' + rd.name + ': ' + nameR + ' (+' + me.points + ' pts)', { champId: champ.id, roundIdx: idx, position: me.position });
    st.updatedAt = now();
    if (opts.achievements === true && CB.game.achievements && typeof CB.game.achievements.check === 'function') {
      try {
        result.achievements = CB.game.achievements.check(profile, { type: 'career', action: result.championshipComplete ? 'championship-complete' : 'round-complete',
          champId: champ.id, tierId: champ.tierId, tierIndex: champ.tierIndex, position: result.championshipComplete ? result.position : me.position, roundPosition: me.position,
          eventType: champ.eventType, standings: finalStandings, trophy: result.trophy, pointsTable: pointsTable, perfect: !!result.perfect });
      } catch (e) { result.achievements = []; }
    }
    return result;
  }

  /** Season finale: final standings, trophy, prize money, unlocks, tier rewards, rival titles. */
  function finishSeason(profile, st, champ, cs, result) {
    var table = standingsRows(cs, profile);
    var me = table.filter(function (r) { return r.isPlayer; })[0];
    var pos = me ? me.position : table.length;
    var S = st.stats;
    cs.status = 'complete'; cs.complete = true; cs.finalPosition = pos; cs.completedAt = now();
    cs.bestFinish = isNum(cs.bestFinish) ? Math.min(cs.bestFinish, pos) : pos;
    S.seasons++;
    if (champ.kind === 'event' && pos === 1) S.eventsWon++;
    var rewardsBd = result.rewards.breakdown;
    var credits = 0, xp = 0;
    var pc = pos <= champ.prize.positions.length ? champ.prize.positions[pos - 1] : 0;
    var px = pos <= champ.prize.xpPositions.length ? champ.prize.xpPositions[pos - 1] : 0;
    if (pc || px) { credits += pc; xp += px; rewardsBd.push({ label: 'Championship prize — ' + ordinal(pos), credits: pc, xp: px, kind: 'championship' }); }
    if (pos === 1 && champ.prize.bonusCredits) { credits += champ.prize.bonusCredits; rewardsBd.push({ label: 'Title bonus (' + (champ.sponsor || 'organisers') + ')', credits: champ.prize.bonusCredits, xp: 0, kind: 'championship' }); }
    var trophy = null;
    if (pos <= 3) {
      trophy = { id: 'tr-' + champ.id + '-s' + cs.season, champId: champ.id, champName: champ.name, name: champ.trophy.name, material: champ.trophy.material,
        medal: TROPHY_MEDALS[pos - 1], position: pos, season: cs.season, tierId: champ.tierId, tierIndex: champ.tierIndex, kind: champ.kind,
        points: me ? me.points : 0, wins: me ? me.wins : 0, t: now(), date: dateLabel(champ, champ.rounds.length - 1, cs.season).label,
        perfect: !!(me && me.wins === champ.rounds.length), color: champ.color };
      st.trophies.push(trophy);
      cs.trophy = trophy;
    }
    if (pos === 1) { cs.titles = num(cs.titles, 0) + 1; S.titles++; }
    if (pos === 2) S.runnerUps++;
    // unlocks for a podium
    var unlocked = [];
    if (pos <= 3) unlocked = unlocked.concat(grantUnlocks(profile, champ.rewards.unlocks));
    // tier reward: first title in the tier
    var tier = getTier(champ.tierId);
    if (pos === 1 && champ.kind !== 'event' && !st.tierRewards[tier.id]) {
      st.tierRewards[tier.id] = { t: now(), champId: champ.id };
      credits += tier.reward.credits; xp += tier.reward.xp;
      rewardsBd.push({ label: tier.name + ' champion: "' + tier.reward.title + '"', credits: tier.reward.credits, xp: tier.reward.xp, kind: 'tier' });
      if (st.titles.indexOf(tier.reward.title) < 0) st.titles.push(tier.reward.title);
      result.events.push({ type: 'title', text: 'New title earned: ' + tier.reward.title, title: tier.reward.title });
    }
    var aw = applyAward(profile, credits, xp, 'Championship · ' + champ.name, 'career');
    S.earnings += Math.max(0, aw.credits); S.xpEarned += aw.xp;
    result.rewards.credits += credits; result.rewards.xp += xp;
    if (aw.levelUp) result.levelUp = { from: result.levelUp ? result.levelUp.from : aw.oldLevel, to: aw.newLevel };
    // rivals: title lines, duel outcomes, story beats
    var pname = playerName(profile);
    champ.rivals.forEach(function (rid) {
      var rrow = table.filter(function (r) { return r.id === rid; })[0];
      if (!rrow) return;
      var rs = rivalState(st, rid), sit = null;
      if (champ.eventType === 'rivals') {
        if (pos === 1) { rs.duelsWon++; S.duelsWon++; rs.respect = clamp(rs.respect + 15, 0, 100); sit = 'duelWin'; }
        else { rs.duelsLost++; S.duelsLost++; sit = 'duelLoss'; }
        if (pos === 1) triggerBeats(st, rid, 'duel-win', { champId: champ.id }).forEach(function (b) { result.events.push({ type: 'story', beat: b, text: b.title + ' — ' + b.text }); });
        result.events.push({ type: pos === 1 ? 'rival-defeated' : 'rival-lost', rival: rid, text: (pos === 1 ? 'You beat ' : 'You lost to ') + getRival(rid).name });
      } else if (pos === 1) { rs.titlesVs++; rs.respect = clamp(rs.respect + 8, 0, 100); sit = 'titlePlayer'; triggerBeats(st, rid, 'title-player', { champId: champ.id }).forEach(function (b) { result.events.push({ type: 'story', beat: b, text: b.title + ' — ' + b.text }); }); }
      else if (rrow.position === 1) sit = 'titleRival';
      if (sit) {
        var line = rivalLine(rid, sit, { player: pname, champ: champ.name, seed: cs.seed, round: 'final' });
        rs.lastLine = line; rs.lastSituation = sit;
        result.events.push({ type: 'rival', rival: rid, situation: sit, text: line });
        if (!result.rival || result.rival.id === rid) result.rival = { id: rid, name: getRival(rid).name, title: getRival(rid).title, situation: sit, text: line, position: rrow.position, playerAhead: pos < rrow.position, respect: rs.respect, mood: moodOf(rs) };
      }
      triggerBeats(st, rid, 'respect', { champId: champ.id }).forEach(function (b) { result.events.push({ type: 'story', beat: b, text: b.title + ' — ' + b.text }); });
    });
    // newly unlocked tiers & championships
    TIERS.forEach(function (t) {
      if (st.unlocked.tiers.indexOf(t.id) >= 0) return;
      if (tierUnlock(profile, t.id, st).ok) {
        st.unlocked.tiers.push(t.id);
        unlocked.push({ kind: 'tier', id: t.id, name: t.name });
        result.events.push({ type: 'unlock', kind: 'tier', id: t.id, text: t.name + ' unlocked' });
      }
    });
    catalog.championships.forEach(function (c) {
      if (!c.requires.length || st.unlocked.champs.indexOf(c.id) >= 0) return;
      if (c.requires.some(function (r) { return r.champ === champ.id; }) && isUnlocked(profile, c.id, st).ok) {
        st.unlocked.champs.push(c.id);
        unlocked.push({ kind: c.kind, id: c.id, name: c.name });
        result.events.push({ type: 'unlock', kind: c.kind, id: c.id, text: c.name + ' is now open' });
      }
    });
    unlocked.forEach(function (u) { if (u.kind === 'parts' || u.kind === 'tracks' || u.kind === 'bodyStyles') result.events.push({ type: 'unlock', kind: u.kind, id: u.id, text: u.name + ' unlocked' }); });
    cs.history.push({ season: cs.season, position: pos, points: me ? me.points : 0, wins: me ? me.wins : 0, champion: table[0] && table[0].id, t: now(), trophy: trophy ? trophy.medal : null });
    if (cs.history.length > 20) cs.history.splice(0, cs.history.length - 20);
    addLog(st, 'season', champ.name + ' season ' + cs.season + ' complete: ' + ordinal(pos) + (trophy ? ' — ' + trophy.name : ''), { champId: champ.id, position: pos });
    result.championshipComplete = true;
    result.position = pos;
    result.trophy = trophy;
    result.unlocked = unlocked;
    result.standings = table;
    result.champion = table[0] ? { id: table[0].id, name: table[0].name, points: table[0].points } : null;
    result.perfect = !!(me && me.wins === champ.rounds.length);
    result.nextRound = null;
  }

  /** skipRound(profile, champId, opts) -> recordResult with a DNS for the player (the field is simulated). */
  function skipRound(profile, champId, opts) {
    return recordResult(profile, champId, null, null, Object.assign({}, opts || {}, { dns: true, simulate: false }));
  }

  /**
   * commit(method, ...args): run a mutating career call inside CB.game.profile.update() so it is saved.
   * Falls back to a plain call on an in-memory profile when the profile module is absent.
   */
  function commit(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    var fn = api[method];
    if (typeof fn !== 'function') throw new Error('career.commit: unknown method ' + method);
    var P = profileMod();
    if (!P) return fn.apply(null, [{}].concat(args));
    var out;
    P.update(function (p) { out = fn.apply(null, [p].concat(args)); }, { reason: 'career-' + method });
    if (out && out.profile) delete out.profile;
    return out;
  }

  /** Reset the career (keeps credits/xp; wipes championships, trophies and rival history). */
  function resetCareer(profile, seed) {
    if (!isObj(profile)) return null;
    profile.career = defaultState(isNum(seed) ? seed : undefined);
    return profile.career;
  }

  /* ======================================================================
     Launching through the unified router (UNIFY-SPEC § Router / Flow)
     Every career round, special event, quick race / quick drift and career Atelier session goes through
     CB.router.go(route, params). Results come back through params.onFinish (and the cb:race-finished /
     cb:drift-finished DOM events as a safety net); when the session closes the player is returned to the
     screen the launch came from (params.returnTo, default: the route that was current at launch).
       launchSpec(profile, champId, roundIdx?, opts?) -> {route:'race'|'drift', params} | null      (pure)
       launcher.career(champId, roundIdx?, opts?)   -> bool   records the result (commit) unless opts.onResult / opts.record === false
       launcher.race(opts?) / launcher.drift(opts?) -> bool   quick sessions with the configurator's current build (CB.state)
       launcher.atelier(mode, opts?)                -> bool   'career-buy' | 'career-upgrade' | 'free'
       launcher.dispatch(route, params, hooks?)     -> bool   generic: hooks {onResult(results) -> outcome, onClose(results, outcome), once}
     ====================================================================== */
  var ASSIST_LEVELS = ['off', 'light', 'medium', 'heavy', 'auto'];
  var DRIVE_ROUTES = { race: 1, drift: 1 };

  /** Explicit steering-assist level (opts.assist), or null: the session then uses the player's own level for the
      discipline (race-ui: Race light / Drift heavy by default; older shared profile levels are migrated there). */
  function assistLevelOf(profile, opts) {
    var cands = [opts && opts.assist, opts && opts.assistLevel];
    for (var i = 0; i < cands.length; i++) if (typeof cands[i] === 'string' && ASSIST_LEVELS.indexOf(cands[i]) >= 0) return cands[i];
    return null;
  }
  function currentBuild(profile, opts) {
    if (opts && isObj(opts.build)) return opts.build;
    // UNIFY-SPEC: the active car is always the configurator's current build
    var S = CB.state;
    if (S && typeof S.get === 'function') { try { var b = S.get(); if (isObj(b)) return b; } catch (e) { /* fall through */ } }
    return activeBuild(profile);
  }
  /* Drift-judged rounds run on the drift team's purpose-built layouts (CB.race.drift.tracks, with judged zones) when loaded. */
  var DRIFT_VENUES = { 'akagane-pass': 'kurogane-pass', 'neon-harbour': 'dockyard-sliders', 'porto-vecchio': 'dockyard-sliders', 'ouroboros': 'circle-lab', 'challenge-drift': 'circle-lab' };
  function driftVenueFor(trackId) {
    var DT = CB.race && CB.race.drift && CB.race.drift.tracks, v = DRIFT_VENUES[trackId];
    if (!v || !DT) return trackId;
    try { if (typeof DT.get === 'function' ? DT.get(v) : (DT.ids || []).indexOf(v) >= 0) return v; } catch (e) { /* ignore */ }
    return trackId;
  }
  /** Drift session mode for a drift-judged round: an explicit extras.drift.mode / round driftMode, else 'tandem' for
      tandem rounds (e.g. 'Figure-8 Tandem': chase an AI lead car), else 'trial' (solo score attack). */
  function driftModeFor(cfg) {
    var m = get(cfg, 'extras.drift.mode', null) || get(cfg, 'career.driftMode', null);
    if (m === 'trial' || m === 'tandem' || m === 'free') return m;
    var name = String(get(cfg, 'career.roundName', '') || get(cfg, 'context.label', '') || '');
    return /tandem/i.test(name) ? 'tandem' : 'trial';
  }
  /** 'drift' for drift-judged rounds / configs, else 'race'. Accepts an event-type id, a round, a championship or a cfg. */
  function routeFor(x) {
    if (typeof x === 'string') return x === 'drift' ? 'drift' : 'race';
    if (!isObj(x)) return 'race';
    if (x.discipline === 'drift' || x.eventType === 'drift') return 'drift';
    if (isObj(x.extras) && (x.extras.eventType === 'drift' || isObj(x.extras.drift))) return 'drift';
    if (isObj(x.settings) && x.settings.discipline === 'drift') return 'drift';
    return 'race';
  }

  /**
   * launchSpec(profile, champId, roundIdx?, opts {build, assist, tune, returnTo, returnParams}) -> {route, params}
   * params: { kind, source:'career', cfg (raceConfigFor), build, context, career, settings (race-ui mirror, 3D),
   *           trackId, discipline, mode, assist, drift (CB.race.drift.createSession cfg for drift rounds), returnTo, returnParams }
   */
  function launchSpec(profile, champId, roundIdx, opts) {
    opts = opts || {};
    var build = currentBuild(profile, opts);
    var cfg = raceConfigFor(profile, champId, roundIdx, Object.assign({}, opts, { build: build }));
    if (!cfg) return null;
    var route = routeFor(cfg);
    var assist = assistLevelOf(profile, opts);
    var settings = cfg.settings = Object.assign({}, cfg.settings, { discipline: route, graphics: '3d' });
    if (assist) { settings.steerAssist = assist; cfg.assistLevel = assist; }
    var drift = null;
    if (route === 'drift') {
      var runs = num(get(cfg, 'extras.drift.runs', 2), 2);
      // the round's own circuit (AI marks are estimated for it); opts.driftVenue === true prefers a CB.race.drift.tracks layout
      var venue = opts.driftVenue === true ? driftVenueFor(cfg.trackId) : cfg.trackId;
      if (venue !== cfg.trackId) { cfg.trackId = venue; settings.trackId = venue; }
      var dmode = driftModeFor(cfg);
      drift = {
        trackId: venue, mode: dmode, build: build, playerBuild: build, tune: opts.tune || 'street',
        duration_s: clamp(45 * runs, 90, 240), timeOfDay: cfg.timeOfDay, weather: cfg.weather, seed: cfg.seed, difficulty: cfg.difficulty
      };
      if (assist) drift.assist = assist;
      settings.driftMode = dmode; settings.driftTrackId = venue; settings.driftDuration = drift.duration_s; settings.driftTune = drift.tune;
    }
    return {
      route: route,
      params: {
        kind: cfg.context.kind, source: 'career', champId: cfg.career.champId, roundIdx: cfg.career.roundIdx, label: cfg.context.label,
        cfg: cfg, build: build, context: cfg.context, career: cfg.career, settings: settings, trackId: cfg.trackId, discipline: route,
        mode: route === 'drift' ? drift.mode : cfg.mode, assist: assist, drift: drift,
        returnTo: opts.returnTo || null, returnParams: opts.returnParams || { champId: cfg.career.champId }
      }
    };
  }

  var launcher = (function () {
    var hasDOM = typeof document !== 'undefined' && typeof document.addEventListener === 'function';
    var active = null;   // the one live launch (a new launch supersedes it)

    function routerMod() { var R = CB.router; return R && typeof R.go === 'function' ? R : null; }
    function routeName(r) { return typeof r === 'string' ? r.replace(/^#?\/?/, '').split(/[/?&]/)[0] || null : null; }
    function current() {
      var R = routerMod(), c = null;
      if (R && typeof R.current === 'function') { try { c = R.current(); } catch (e) { c = null; } }
      if (typeof c === 'string') return { route: routeName(c), params: null };
      if (isObj(c)) return { route: routeName(c.route || c.name || c.id || c.path || ''), params: isObj(c.params) ? c.params : null };
      if (typeof location !== 'undefined' && /^#\//.test(location.hash || '')) return { route: routeName(location.hash), params: null };
      return null;
    }
    function later(fn, ms) { if (typeof setTimeout === 'function') setTimeout(fn, ms || 0); else fn(); }
    function emit(name, detail) {
      if (!hasDOM || typeof CustomEvent !== 'function') return;
      try { document.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (e) { /* ignore */ }
    }

    /** dispatch(route, params, hooks {onResult, onClose, once(default true)}) */
    function dispatch(route, params, hooks) {
      params = Object.assign({}, params || {});
      hooks = hooks || {};
      var R = routerMod();
      var origin = current();
      var returnTo = params.returnTo || (origin && origin.route && !DRIVE_ROUTES[origin.route] ? origin.route : null) || 'menu';
      var returnParams = params.returnParams || (origin && origin.route === returnTo ? origin.params : null) || {};
      var userFinish = params.onFinish, userClose = params.onClose;
      if (active) active.cancel();
      var L = { route: route, finished: null, outcome: null, closed: false, seen: [] };
      active = L;

      function onResults(results) {
        if (L.closed || !results || L.seen.indexOf(results) >= 0) return;
        L.seen.push(results);
        if (hooks.once !== false && L.finished) return;   // career rounds count the first result only
        L.finished = results;
        if (typeof hooks.onResult === 'function') {
          try { L.outcome = hooks.onResult(results, params); } catch (e) { if (typeof console !== 'undefined') console.error('[career.launcher] result', e); }
        }
        if (typeof userFinish === 'function') { try { userFinish(results, L.outcome); } catch (e2) { /* ignore */ } }
      }
      function cleanup() {
        if (!hasDOM) return;
        document.removeEventListener('cb:race-finished', evFinish);
        document.removeEventListener('cb:drift-finished', evFinish);
        document.removeEventListener('cb:race-closed', evClose);
      }
      function onClosed() {
        if (L.closed) return;
        L.closed = true; cleanup();
        if (active === L) active = null;
        if (typeof hooks.onClose === 'function') { try { hooks.onClose(L.finished, L.outcome); } catch (e) { /* ignore */ } }
        if (typeof userClose === 'function') { try { userClose(L.finished, L.outcome); } catch (e2) { /* ignore */ } }
        // Return to the originating screen — unless the player already navigated somewhere else (nav bar, back button).
        later(function () {
          var R2 = routerMod(), cur = current();
          if (!R2 || (cur && cur.route && cur.route !== route)) return;
          // '_' keys stay out of the URL (CB.router only serialises plain, non-underscore params)
          var rp = Object.assign({}, returnParams, { _from: route, _kind: params.kind || null, _results: L.finished, _outcome: L.outcome });
          try { R2.go(returnTo, rp); } catch (e3) { /* ignore */ }
        }, 0);
      }
      var evFinish = function (e) { var d = e && e.detail; if (!d) return; var cur = current(); if (cur && cur.route && cur.route !== route) return; onResults(d.results || d); };
      var evClose = function () { var cur = current(); if (!cur || !cur.route || cur.route === route) onClosed(); else { L.closed = true; cleanup(); if (active === L) active = null; } };
      L.cancel = function () { L.closed = true; cleanup(); if (active === L) active = null; };
      if (hasDOM) {
        document.addEventListener('cb:race-finished', evFinish);
        document.addEventListener('cb:drift-finished', evFinish);
        document.addEventListener('cb:race-closed', evClose);
      }
      params.returnTo = returnTo;
      params.returnParams = returnParams;
      params.onFinish = onResults;
      params.onClose = onClosed;
      params.launchId = 'L' + now().toString(36);

      // The race UI owns #/race and #/drift: CB.race.ui.open() routes there itself (CB.router.go) carrying the launch
      // (build, cfg, settings, context, callbacks); on a page without a router it falls back to its overlay.
      var UI = CB.race && CB.race.ui;
      if (DRIVE_ROUTES[route] && UI && typeof UI.open === 'function') {
        try {
          var cfg = Object.assign({}, params.cfg || {}, {
            settings: Object.assign({}, get(params, 'cfg.settings', {}), params.settings || {}, { discipline: route }),
            context: params.context || { kind: params.kind || 'quick' }, discipline: route, returnTo: returnTo,
            launch: { route: route, kind: params.kind || null, challengeId: params.challengeId || null, champId: params.champId || null, drift: params.drift || null }
          });
          if (params.challenge) cfg.challenge = params.challenge;
          if (params.autoStart) cfg.autoStart = true;
          UI.open(params.build || null, cfg, { onFinish: onResults, onClose: onClosed });
          emit('cb:launch', { route: route, params: params });
          return true;
        } catch (e4) { if (typeof console !== 'undefined') console.error('[career.launcher] race.ui.open', e4); }
      }
      if (R) {
        try { R.go(route, params); emit('cb:launch', { route: route, params: params }); return true; }
        catch (e) { if (typeof console !== 'undefined') console.error('[career.launcher] router.go', e); }
      }
      L.cancel();
      return false;
    }

    function profileNow() {
      var P = profileMod();
      if (!P) return {};
      try { return typeof P.peek === 'function' ? P.peek() : P.get(); } catch (e) { return {}; }
    }
    function statsCount(p) { return num(get(p, 'stats.races', 0), 0) + num(get(p, 'stats.timeTrials', 0), 0) + num(get(p, 'stats.practiceSessions', 0), 0); }

    /** Career round / special event. opts: {build, assist, returnTo, returnParams, onResult (replaces recording), record, onFinish, onClose} */
    function careerLaunch(champId, roundIdx, opts) {
      opts = opts || {};
      var prof0 = profileNow();
      if (!isObj(opts.build) && needsCar(prof0)) {
        var cname = (getChampionship(champId) || {}).name || 'the championship';
        emit('cb:career-blocked', { champId: champId, roundIdx: roundIdx, reason: 'no-car',
          message: 'You have no career cars. Buy a car to race in ' + cname + ', or withdraw from it.' });
        return false;
      }
      var spec = launchSpec(prof0, champId, roundIdx, opts);
      if (!spec) return false;
      var p = spec.params;
      if (typeof opts.onFinish === 'function') p.onFinish = opts.onFinish;
      if (typeof opts.onClose === 'function') p.onClose = opts.onClose;
      var onResult = typeof opts.onResult === 'function' ? opts.onResult : opts.record === false ? null : function (results) {
        var P = profileMod(), before = statsCount(profileNow());
        var out = commit('recordResult', p.champId, p.roundIdx, results, { build: p.build, achievements: true });
        if (P && typeof P.recordRaceStats === 'function' && statsCount(profileNow()) === before) {
          try { P.recordRaceStats(results, { mode: p.mode, trackId: p.trackId, laps: p.cfg.laps, difficulty: p.cfg.difficulty, eventType: p.career.eventType }); } catch (e) { /* ignore */ }
        }
        var A = CB.game && CB.game.achievements;
        if (A && typeof A.check === 'function') { try { A.check(null, { type: 'race-finished', results: results, config: { mode: p.mode, trackId: p.trackId, career: true, eventType: p.career.eventType } }); } catch (e2) { /* ignore */ } }
        emit('cb:career-result', { champId: p.champId, roundIdx: p.roundIdx, outcome: out, results: results });
        return out;
      };
      return dispatch(spec.route, p, { onResult: onResult, once: true });
    }

    function quick(route, opts) {
      opts = opts || {};
      var prof = profileNow(), build = currentBuild(prof, opts), assist = assistLevelOf(prof, opts);
      var settings = Object.assign({ discipline: route, graphics: '3d' }, opts.settings || {});
      if (assist) settings.steerAssist = assist;
      if (opts.trackId) { settings.trackId = opts.trackId; if (route === 'drift') settings.driftTrackId = opts.trackId; }
      if (route === 'drift' && opts.mode) settings.driftMode = opts.mode;
      var params = Object.assign({}, opts, {
        kind: opts.kind || 'quick', source: opts.source || 'quick', build: build, settings: settings, discipline: route,
        assist: assist, context: Object.assign({ kind: opts.kind || 'quick' }, opts.context || {})
      });
      if (route === 'drift') params.drift = Object.assign({ mode: opts.mode || 'free', build: build, playerBuild: build }, opts.trackId ? { trackId: opts.trackId } : {}, assist ? { assist: assist } : {}, opts.drift || {});
      return dispatch(route, params, { onResult: opts.onResult, once: opts.once === true });
    }

    /** Career Atelier session: CB.router.go('atelier', {mode, carId?, build?, onConfirm, onCancel, returnTo}). */
    function atelier(mode, opts) {
      opts = Object.assign({}, opts || {});
      mode = mode === 'career-buy' || mode === 'career-upgrade' ? mode : 'free';
      var R = routerMod(), origin = current();
      var returnTo = opts.returnTo || (origin && origin.route && origin.route !== 'atelier' && !DRIVE_ROUTES[origin.route] ? origin.route : null) || (mode === 'free' ? null : 'career');
      var back = function (extra) {
        later(function () {
          var R2 = routerMod(), cur = current();
          if (!R2 || !returnTo || (cur && cur.route && cur.route !== 'atelier')) return;
          try { R2.go(returnTo, Object.assign({}, opts.returnParams || {}, { _from: 'atelier', _mode: mode }, extra || {})); } catch (e) { /* ignore */ }
        }, 0);
      };
      var uc = opts.onConfirm, ux = opts.onCancel, done = false;
      opts.mode = mode;
      opts.returnTo = returnTo;
      opts.onConfirm = function (build, quote) { if (done) return; done = true; if (typeof uc === 'function') { try { uc(build, quote); } catch (e) { /* ignore */ } } back({ _confirmed: true }); };
      opts.onCancel = function () { if (done) return; done = true; if (typeof ux === 'function') { try { ux(); } catch (e) { /* ignore */ } } back({ _cancelled: true }); };
      var app = CB.app, ok = false;
      if (R) { try { R.go('atelier', { mode: mode, _returnTo: returnTo || undefined }); ok = true; } catch (e) { ok = false; } }
      // CB.app.openAtelier puts the configurator into the career session (banner, live quote, lock gating)
      if (app && typeof app.openAtelier === 'function') { try { app.openAtelier(opts); ok = true; } catch (e2) { /* ignore */ } }
      return ok;
    }

    return {
      dispatch: dispatch, career: careerLaunch, atelier: atelier, current: current,
      race: function (opts) { return quick('race', opts); },
      drift: function (opts) { return quick('drift', opts); },
      active: function () { return active; }
    };
  })();

  var api = {
    VERSION: VERSION,
    // data
    catalog: catalog, TIERS: TIERS, POINTS_SYSTEMS: POINTS_SYSTEMS, EVENT_TYPES: EVENT_TYPES, RIVALS: RIVALS, STORY_BEATS: STORY_BEATS,
    TRACK_ALIASES: TRACK_ALIASES, getTier: getTier, getChampionship: getChampionship, getRival: getRival, listChampionships: listChampionships,
    getRoster: getRoster, getDriver: getDriver, requirementLabels: requirementLabels,
    // state
    defaultState: defaultState, normalizeState: normalizeState, careerOf: careerOf, state: state, isUnlocked: isUnlocked, isTierUnlocked: isTierUnlocked,
    tierUnlock: tierUnlock, checkEligibility: checkEligibility, enter: enter, withdraw: withdraw, restart: restart, nextRound: nextRound,
    calendar: calendar, briefing: briefing, standings: standings, trophies: trophies, resetCareer: resetCareer,
    entryCarOffer: entryCarOffer, registerAtelierBuild: registerAtelierBuild, canSellCar: canSellCar, needsCar: needsCar,
    // racing
    raceConfigFor: raceConfigFor, launchSpec: launchSpec, routeFor: routeFor, launcher: launcher, launch: launcher.career,
    openAtelier: launcher.atelier, recordResult: recordResult, skipRound: skipRound, simulateSession: simulateSession, opponentsFor: function (profile, champId, roundIdx) {
      var c = getChampionship(champId); if (!c) return [];
      var cs = previewSeason(peekCareer(profile), c);
      return opponentsFor(c, cs, isNum(roundIdx) ? roundIdx : cs.roundsCompleted);
    },
    commit: commit,
    // simulation & helpers (pure)
    simulateRound: simulateRound, simulateSeason: simulateSeason, fieldFor: fieldFor, pointsFor: pointsFor, sortStandings: sortStandings,
    compareStandings: compareStandings, estimateLapTime: estimateLapTime, estimateDragTime: estimateDragTime, rivalLine: rivalLine,
    resolveTrackId: resolveTrackId, trackInfo: trackInfo, difficultyFor: difficultyFor, metricsFor: metricsFor, careerPrice: careerPrice,
    pointsRemaining: pointsRemaining, dateLabel: dateLabel, _makeRng: makeRng, _hash: hashStr
  };
  return api;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.game.career;

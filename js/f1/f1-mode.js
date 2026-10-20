/* ==========================================================================
   Redline — js/f1/f1-mode.js
   CB.f1.mode : turns an F1 session choice into CB.race.ui launch options (docs/F1-SPEC.md §6). Pure, Node-loadable.

     CB.f1.mode.SESSIONS / FORMATS / DIFFICULTIES / WEATHERS / COMPOUNDS / DEFAULTS
     sanitize(settings) -> F1 setup settings (team, circuit, format, length, difficulty, assists, weather ...)
     circuits() -> [def]            CB.f1.circuits.list (real F1 layouts); falls back to the Race circuits until it loads
     circuit(id) -> def | null
     info(def) -> { id, name, short, country, length_m, realLength_m, realLaps, pole_s, raceLap_s, night }
     raceLaps(def, length { kind 'laps'|'pct', laps, pct }) -> laps
     entrants({ playerTeam, playerSeat, difficulty, seed }) -> 21 AI entrants (race engine opponents) with f1 blocks
     playerBuild(teamId, opts) -> the player's F1 build (CB.f1.teams.buildFor)
     sessionConfig({ circuitId, session 'practice'|'qualifying'|'race', laps, playerTeam, playerSeat, difficulty,
                     weather, timeOfDay, assists, gridOrder [ids, P1 first], seed, startCompound, playerName })
       -> { build, launch } where launch = CB.race.ui.open opts (settings, opponents, maxOpponents 21, hooks, extras,
          seed, gridOrder, startPosition, maxTime_s, context { kind:'f1' }, f1 { ... session meta })
     sessionLength_s(def, session) -> sim seconds of a timed session (practice / qualifying)
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.f1 = CB.f1 || {};

(function () {
  'use strict';

  var SESSIONS = [
    { id: 'practice', name: 'Practice', short: 'FP', desc: 'Free running: learn the circuit, try the tyres' },
    { id: 'qualifying', name: 'Qualifying', short: 'Q', desc: 'A short timed session: your best lap sets your grid slot' },
    { id: 'race', name: 'Race', short: 'R', desc: 'Standing start, pit stops, DRS and points' }
  ];
  var FORMATS = [
    { id: 'quick', name: 'Quick race', desc: 'Straight to the grid' },
    { id: 'weekend', name: 'Race weekend', desc: 'Practice → Qualifying → Race' },
    { id: 'season', name: 'Championship', desc: 'A season of rounds with points and standings' }
  ];
  var DIFFICULTIES = [
    { id: 'rookie', name: 'Rookie', desc: 'Forgiving rivals' },
    { id: 'amateur', name: 'Amateur', desc: 'Midfield pace' },
    { id: 'pro', name: 'Pro', desc: 'Competitive with a good driver on assists' },
    { id: 'alien', name: 'Legend', desc: 'Pole-position pace, every lap' }
  ];
  var WEATHERS = [{ id: 'dry', name: 'Dry' }, { id: 'damp', name: 'Damp' }, { id: 'wet', name: 'Wet' }];
  var TIMES = [{ id: 'day', name: 'Day' }, { id: 'dusk', name: 'Dusk' }, { id: 'night', name: 'Night' }];
  var COMPOUNDS = [
    { id: 'soft', name: 'Soft', letter: 'S', color: '#ff2e3d' },
    { id: 'medium', name: 'Medium', letter: 'M', color: '#ffd23f' },
    { id: 'hard', name: 'Hard', letter: 'H', color: '#f4f5f7' },
    { id: 'inter', name: 'Intermediate', letter: 'I', color: '#22d36b' },
    { id: 'wet', name: 'Wet', letter: 'W', color: '#2f8bff' }
  ];
  var DEFAULTS = {
    team: 'mclaren', seat: 0, circuitId: null, format: 'quick', lengthKind: 'laps', laps: 5, pct: 10,
    difficulty: 'amateur', weather: 'dry', timeOfDay: 'auto', startCompound: 'medium', fastestLapPoint: true,
    assists: { brakingLine: true, abs: true, tc: true, autoShift: true, autoDrs: false, steering: 'light' },
    rounds: 4, seasonCircuits: null
  };

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function num(v, d) { if (v === null || v === undefined || v === '') return d; var n = Number(v); return isFinite(n) ? n : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function ids(l) { return l.map(function (o) { return o.id; }); }
  function teams() { return CB.f1.teams || null; }
  function hashStr(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rngOf(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------------------------------------------- circuits */
  function circuits() {
    var C = CB.f1.circuits;
    if (C && Array.isArray(C.list) && C.list.length) return C.list.slice();
    var T = CB.race && CB.race.tracks;   // fallback until js/f1/f1-circuits.js loads: the classic circuits
    var l = T && Array.isArray(T.list) ? T.list : [];
    return l.filter(function (d) { return d && d.id && !d.hidden && !d.challenge && !d.drift && !(Array.isArray(d.tags) && d.tags.indexOf('drift') >= 0); });
  }
  function circuit(id) {
    var C = CB.f1.circuits;
    if (C && typeof C.get === 'function') { var d = C.get(id); if (d) return d; }
    var l = circuits();
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    var T = CB.race && CB.race.tracks;
    return T && typeof T.get === 'function' ? T.get(id) : null;
  }
  function info(def) {
    if (!def) return null;
    var f = def.f1 || {}, real = f.real || {};
    var len = num(def.length_m, NaN);
    if (!isFinite(len)) { try { len = CB.race.tracks.build(def).length; } catch (e) { len = NaN; } }
    var realLen = num(real.length_m, len);
    return {
      id: def.id, name: real.name || def.name, short: def.short || def.name, country: real.country || def.country || '', city: def.city || '',
      length_m: isFinite(len) ? len : realLen, realLength_m: realLen, realLaps: Math.round(num(real.laps, 50)),
      pole_s: num(real.pole_s, null), raceLap_s: num(real.raceLap_s, null), turns: num(real.turns, null),
      night: !!f.night, desc: def.desc || '', f1: !!def.f1
    };
  }
  function raceLaps(def, length) {
    length = length || {};
    var inf = info(def) || { realLaps: 50 };
    if (length.kind === 'pct') return Math.max(1, Math.round(inf.realLaps * clamp(num(length.pct, 10), 1, 100) / 100));
    return Math.round(clamp(num(length.laps, 5), 1, 80));
  }
  /** Estimated lap time (s) for timed sessions: the real pole time + ~10 %, else from the length at ~55 m/s. */
  function lapEstimate(def) {
    var inf = info(def) || {};
    if (isFinite(inf.pole_s) && inf.pole_s > 20) return inf.pole_s * 1.1;
    return Math.max(40, num(inf.length_m, 5000) / 55);
  }
  function sessionLength_s(def, session) {
    var lap = lapEstimate(def);
    if (session === 'qualifying') return Math.round(lap * 3.6 + 20);   // out lap + ~2–3 flying laps
    if (session === 'practice') return Math.round(lap * 6 + 20);
    return 0;
  }

  /* ---------------------------------------------------------------- settings */
  function sanitize(s) {
    s = isObj(s) ? s : {};
    var T = teams(), o = {};
    o.team = T && T.get(s.team) ? s.team : DEFAULTS.team;
    o.seat = s.seat === 1 ? 1 : 0;
    o.circuitId = typeof s.circuitId === 'string' && circuit(s.circuitId) ? s.circuitId : ((circuits()[0] || {}).id || null);
    o.format = ids(FORMATS).indexOf(s.format) >= 0 ? s.format : DEFAULTS.format;
    o.lengthKind = s.lengthKind === 'pct' ? 'pct' : 'laps';
    o.laps = Math.round(clamp(num(s.laps, DEFAULTS.laps), 1, 80));
    o.pct = Math.round(clamp(num(s.pct, DEFAULTS.pct), 5, 100));
    o.difficulty = ids(DIFFICULTIES).indexOf(s.difficulty) >= 0 ? s.difficulty : DEFAULTS.difficulty;
    o.weather = ids(WEATHERS).indexOf(s.weather) >= 0 ? s.weather : DEFAULTS.weather;
    o.timeOfDay = s.timeOfDay === 'auto' || ids(TIMES).indexOf(s.timeOfDay) >= 0 ? s.timeOfDay : DEFAULTS.timeOfDay;
    o.startCompound = ['soft', 'medium', 'hard'].indexOf(s.startCompound) >= 0 ? s.startCompound : DEFAULTS.startCompound;
    o.fastestLapPoint = s.fastestLapPoint !== false;
    o.camera = ['chase', 'chase-far', 'cockpit', 'tv', 'heli'].indexOf(s.camera) >= 0 ? s.camera : 'chase';
    var a = isObj(s.assists) ? s.assists : {};
    o.assists = {
      brakingLine: a.brakingLine != null ? !!a.brakingLine : DEFAULTS.assists.brakingLine,
      abs: a.abs != null ? !!a.abs : DEFAULTS.assists.abs,
      tc: a.tc != null ? !!a.tc : DEFAULTS.assists.tc,
      autoShift: a.autoShift != null ? !!a.autoShift : DEFAULTS.assists.autoShift,
      autoDrs: a.autoDrs != null ? !!a.autoDrs : DEFAULTS.assists.autoDrs,
      steering: ['off', 'light', 'medium', 'heavy'].indexOf(a.steering) >= 0 ? a.steering : DEFAULTS.assists.steering
    };
    o.rounds = Math.round(clamp(num(s.rounds, DEFAULTS.rounds), 2, Math.max(2, circuits().length)));
    o.seasonCircuits = Array.isArray(s.seasonCircuits) ? s.seasonCircuits.filter(function (id) { return typeof id === 'string' && circuit(id); }) : null;
    return o;
  }
  function timeOfDayFor(def, tod) {
    if (tod && tod !== 'auto') return tod;
    if (def && (def.timeOfDay === 'night' || (def.f1 && def.f1.night))) return 'night';   // circuit default (Bahrain, Marina Bay, Las Vegas)
    return def && (def.timeOfDay === 'dusk' || (def.f1 && def.f1.dusk)) ? 'dusk' : 'day';
  }

  /* ---------------------------------------------------------------- grid */
  var DIFF_SKILL = { rookie: [0.48, 0.6], amateur: [0.62, 0.75], pro: [0.76, 0.87], alien: [0.93, 1.0] };   // pace via CB.f1.ai paceOf: rookie ~0.85, amateur ~0.9, pro ~0.94-0.96, alien ~1
  function playerBuild(teamId, opts) {
    var T = teams();
    opts = opts || {};
    return T ? T.buildFor(teamId, { seat: opts.seat || 0, isPlayer: true, driverName: opts.playerName || null }) : null;
  }
  /** The 21 AI drivers: everyone but the player's seat. Team pace nudges skill (car is one spec: it is the driver). */
  function entrants(o) {
    o = o || {};
    var T = teams();
    if (!T) return [];
    var pTeam = T.get(o.playerTeam) ? o.playerTeam : DEFAULTS.team, pSeat = o.playerSeat === 1 ? 1 : 0;
    var range = DIFF_SKILL[o.difficulty] || DIFF_SKILL.amateur;
    var rng = rngOf(num(o.seed, hashStr('f1|' + pTeam + '|' + (o.difficulty || ''))));
    var out = [];
    T.list.forEach(function (t) {
      t.drivers.forEach(function (d, seat) {
        if (t.id === pTeam && seat === pSeat) return;
        var paceT = clamp((num(t.pace, 0.9) - 0.82) / 0.15, 0, 1);   // 0 back-marker .. 1 front-runner
        var skill = range[0] + (range[1] - range[0]) * clamp(0.55 * paceT + 0.45 * rng(), 0, 1);
        var b = T.buildFor(t.id, { seat: seat });
        out.push({
          id: 'f1-' + d.id, name: d.name, code: d.short, nationality: d.nation, team: t.name, teamId: t.id, teamShort: t.short,
          number: d.number, color: t.livery.primary, accent: t.livery.secondary,
          livery: { color: t.livery.primary, accent: t.livery.secondary, stripe: t.livery.accent, number: d.number, team: t.name },
          build: b, bodyStyle: 'hypercar', difficulty: o.difficulty || 'amateur', carName: t.chassis || 'F1', model: null,
          skill: Math.round(skill * 1000) / 1000,
          aggression: Math.round((0.35 + 0.4 * rng()) * 1000) / 1000,
          consistency: Math.round(clamp(range[0] + 0.08 + (range[1] - range[0]) * rng(), 0, 0.99) * 1000) / 1000,
          f1: { teamId: t.id, seat: seat, driverId: d.id, number: d.number, helmet: d.helmet }
        });
      });
    });
    return out;
  }

  /** gridOrder: car ids P1-first ('player' for the player). Returns { opponents (ordered), startPosition }. */
  function orderGrid(opps, gridOrder) {
    if (!Array.isArray(gridOrder) || !gridOrder.length) return null;
    var rank = {};
    gridOrder.forEach(function (id, i) { rank[id] = i; });
    var sorted = opps.slice().sort(function (a, b) { return num(rank[a.id], 999) - num(rank[b.id], 999); });
    var pPos = num(rank.player, gridOrder.length) + 1;
    // the player's slot among all cars: count how many sorted AI rank ahead of the player
    var ahead = sorted.filter(function (o) { return num(rank[o.id], 999) < num(rank.player, 999); }).length;
    return { opponents: sorted, startPosition: Math.min(ahead + 1, pPos) };
  }

  /* ---------------------------------------------------------------- session */
  function sessionConfig(o) {
    o = o || {};
    var S = sanitize(o.settings || o);
    var def = circuit(o.circuitId || S.circuitId);
    var session = ids(SESSIONS).indexOf(o.session) >= 0 ? o.session : 'race';
    var seed = num(o.seed, (hashStr((def && def.id) + '|' + session + '|' + Date.now()) >>> 0));
    var laps = session === 'race' ? (isFinite(+o.laps) ? Math.max(1, Math.round(+o.laps)) : raceLaps(def, { kind: S.lengthKind, laps: S.laps, pct: S.pct })) : 50;
    var opps = entrants({ playerTeam: S.team, playerSeat: S.seat, difficulty: S.difficulty, seed: seed ^ 0x51f1 });
    var grid = orderGrid(opps, o.gridOrder);
    var tod = timeOfDayFor(def, S.timeOfDay);
    var engineMode = session === 'race' ? 'race' : 'practice';
    var assists = { abs: S.assists.abs, tc: S.assists.tc, autoShift: S.assists.autoShift, racingLine: S.assists.brakingLine, steeringAssist: false };
    var meta = null;
    try { meta = CB.f1.circuits && typeof CB.f1.circuits.meta === 'function' && def ? CB.f1.circuits.meta(def) : null; } catch (e) { meta = null; }
    var startCompound = S.weather === 'wet' ? 'wet' : S.weather === 'damp' ? 'inter' : (o.startCompound || S.startCompound);
    var hooks = [];
    var H = CB.f1.hooks;
    var hookObj = null;
    if (H && typeof H.create === 'function') {
      try {
        hookObj = H.create({
          circuit: def, meta: meta, mode: session, weather: S.weather, playerTeam: S.team, playerSeat: S.seat, entrants: opps, seed: seed,
          laps: laps, difficulty: S.difficulty,
          assists: { abs: S.assists.abs, tc: S.assists.tc, autoShift: S.assists.autoShift, brakingLine: S.assists.brakingLine, ersAuto: true, autoDrs: S.assists.autoDrs },
          requireTwoCompounds: session === 'race' && S.weather === 'dry' && laps >= 10,
          tyreStart: { player: startCompound }, playerName: o.playerName || null, playerBuild: playerBuild(S.team, { seat: S.seat, playerName: o.playerName })
        });
        if (hookObj) hooks.push(hookObj);
      } catch (e2) { hookObj = null; if (typeof console !== 'undefined') console.warn('[f1.mode] hooks.create failed', e2); }
    }
    var launch = {
      settings: {
        discipline: 'race', trackId: def ? def.id : null, mode: engineMode, laps: laps, opponents: 11,
        difficulty: S.difficulty, weather: S.weather, timeOfDay: tod, assists: assists, steerAssist: S.assists.steering, camera3d: S.camera, graphics: '3d'
      },
      trackId: def ? def.id : null,
      opponents: grid ? grid.opponents : opps,
      maxOpponents: 21,
      seed: seed,
      hooks: hooks,
      // the two-dry-compound rule is enforced by the F1 hooks (requireTwoCompounds), not the engine's mandatory stop count
      extras: { pitStops: true, mandatoryPitStops: 0, autoPit: false },
      context: { kind: 'f1', label: 'Formula 1 · ' + (SESSIONS.filter(function (x) { return x.id === session; })[0].name) },
      trackLimitsWarnings: 3,
      f1: { session: session, circuitId: def ? def.id : null, team: S.team, seat: S.seat, laps: laps, weather: S.weather, difficulty: S.difficulty,
        startCompound: startCompound, hooks: hookObj, meta: meta }
    };
    if (grid) { launch.gridOrder = 'given'; launch.startPosition = grid.startPosition; }
    else if (session === 'race') launch.startPosition = o.startPosition != null ? o.startPosition : 'middle';
    if (session !== 'race') launch.maxTime_s = o.maxTime_s != null ? o.maxTime_s : sessionLength_s(def, session);
    if (o.playerName) launch.playerName = o.playerName;
    return { build: playerBuild(S.team, { seat: S.seat, playerName: o.playerName }), launch: launch, settings: S, circuit: def };
  }

  CB.f1.mode = {
    SESSIONS: SESSIONS, FORMATS: FORMATS, DIFFICULTIES: DIFFICULTIES, WEATHERS: WEATHERS, TIMES: TIMES, COMPOUNDS: COMPOUNDS, DEFAULTS: DEFAULTS,
    sanitize: sanitize, circuits: circuits, circuit: circuit, info: info, raceLaps: raceLaps, lapEstimate: lapEstimate,
    sessionLength_s: sessionLength_s, entrants: entrants, playerBuild: playerBuild, orderGrid: orderGrid, sessionConfig: sessionConfig,
    timeOfDayFor: timeOfDayFor, compound: function (id) { return COMPOUNDS.filter(function (c) { return c.id === id; })[0] || null; }
  };
})();

if (typeof module !== 'undefined') module.exports = CB.f1.mode;

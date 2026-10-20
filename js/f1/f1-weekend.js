/* ==========================================================================
   Redline — js/f1/f1-weekend.js
   CB.f1.weekend : race weekends, championships, points and standings (docs/F1-SPEC.md §6). Pure, Node-loadable.

     POINTS [25,18,15,12,10,8,6,4,2,1] · FASTEST_LAP_POINT 1 (top-10 finishers only, optional)
     entryOf(row, ctx) -> { id, driverId, name, teamId, team, isPlayer }     maps an engine classification row
     score(classification, { fastestLapPoint, playerTeam, playerSeat }) -> [{ ...entry, position, status, points, fastestLap, gridPosition, gained }]
     gridFrom(classification) -> car ids P1-first (qualifying: by best lap, no time = back)
     createWeekend({ circuitId, format 'quick'|'weekend', settings }) -> weekend
         weekend = { v, kind:'weekend', circuitId, format, sessions: [{ id, done, results }], index, grid }
     currentSession(w) / recordSession(w, sessionId, results) / isComplete(w)
     createSeason({ rounds: [circuitId], settings }) -> season { kind:'season', rounds, round (index), weekend, standings, history }
     applyRound(season, scoredRows) -> season (points added, round advanced)
     standings(season | totals) -> { drivers: [...sorted], constructors: [...sorted] }   ties: wins, then 2nds, ...
     store(storage?) -> { load(), save(state), clear(), loadSettings(), saveSettings(s), records }
   Keys: 'forge.f1.save.v1' (the running weekend / season), 'forge.f1.settings.v1', records 'forge.f1.records.v1'.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.f1 = CB.f1 || {};

(function () {
  'use strict';

  var POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
  var FASTEST_LAP_POINT = 1;
  var KEY_SAVE = 'forge.f1.save.v1', KEY_SETTINGS = 'forge.f1.settings.v1', KEY_RECORDS = 'forge.f1.records.v1';

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function num(v, d) { if (v === null || v === undefined || v === '') return d; var n = Number(v); return isFinite(n) ? n : d; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function teams() { return CB.f1.teams || null; }

  /* ---------------------------------------------------------------- entries */
  function entryOf(row, ctx) {
    ctx = ctx || {};
    var T = teams(), id = row && row.id;
    if (row && (row.isPlayer || id === 'player')) {
      var pt = T && T.get(ctx.playerTeam);
      return { id: 'player', driverId: 'player', name: row.name || ctx.playerName || 'You', teamId: pt ? pt.id : (ctx.playerTeam || null),
        team: pt ? pt.name : (row.team || ''), isPlayer: true, number: row.number };
    }
    var did = typeof id === 'string' && id.indexOf('f1-') === 0 ? id.slice(3) : id;
    var info = T && T.driver(did);
    return { id: id, driverId: did, name: info ? info.driver.name : (row && row.name) || String(id), teamId: info ? info.team.id : (row && row.teamId) || null,
      team: info ? info.team.name : (row && row.team) || '', isPlayer: false, number: info ? info.driver.number : row && row.number };
  }
  function rowsOf(results) {
    if (Array.isArray(results)) return results;
    if (results && Array.isArray(results.classification)) return results.classification;
    if (results && Array.isArray(results.rows)) return results.rows;
    return [];
  }
  /** Points per row (race classification, finishing order). DNF / DSQ score nothing. */
  function score(results, opts) {
    opts = opts || {};
    var rows = rowsOf(results).slice().sort(function (a, b) { return num(a.position, 99) - num(b.position, 99); });
    var flId = null, flT = Infinity;
    rows.forEach(function (r) { if (isFinite(+r.bestLap_s) && +r.bestLap_s > 0 && +r.bestLap_s < flT) { flT = +r.bestLap_s; flId = r.id; } });
    if (results && results.fastestLap && results.fastestLap.carId) flId = results.fastestLap.carId;
    return rows.map(function (r, i) {
      var e = entryOf(r, opts), pos = num(r.position, i + 1), classified = r.status !== 'dnf' && r.status !== 'dsq';
      var pts = classified && pos <= POINTS.length ? POINTS[pos - 1] : 0;
      var fl = r.id === flId;
      if (opts.fastestLapPoint !== false && fl && classified && pos <= 10) pts += FASTEST_LAP_POINT;
      var grid = num(r.gridPosition, null);
      return Object.assign(e, { position: pos, status: r.status || 'finished', points: pts, fastestLap: fl, bestLap_s: num(r.bestLap_s, null),
        gridPosition: grid, gained: grid != null && classified ? grid - pos : null, pitStops: num(r.pitStops, 0), gapText: r.gapText || '',
        compounds: r.endurance && r.endurance.f1 && Array.isArray(r.endurance.f1.compoundsUsed) ? r.endurance.f1.compoundsUsed.slice() : [] });
    });
  }
  /** Qualifying / practice: car ids by best lap (cars without a time go to the back in their listed order). */
  function gridFrom(results) {
    var rows = rowsOf(results).slice();
    rows.sort(function (a, b) {
      var ta = isFinite(+a.bestLap_s) && +a.bestLap_s > 0 ? +a.bestLap_s : Infinity, tb = isFinite(+b.bestLap_s) && +b.bestLap_s > 0 ? +b.bestLap_s : Infinity;
      if (ta !== tb) return ta - tb;
      return num(a.position, 99) - num(b.position, 99);
    });
    return rows.map(function (r) { return r.isPlayer ? 'player' : r.id; });
  }

  /* ---------------------------------------------------------------- weekends */
  function createWeekend(o) {
    o = o || {};
    var format = o.format === 'weekend' ? 'weekend' : 'quick';
    var list = format === 'weekend' ? (Array.isArray(o.sessions) ? o.sessions : ['practice', 'qualifying', 'race']) : ['race'];
    return { v: 1, kind: 'weekend', circuitId: o.circuitId || null, format: format, settings: clone(o.settings || {}),
      sessions: list.map(function (id) { return { id: id, done: false, results: null, skipped: false }; }), index: 0, grid: null, created: o.now || Date.now() };
  }
  function currentSession(w) { return w && w.sessions ? w.sessions[w.index] || null : null; }
  function isComplete(w) { return !!w && w.sessions.every(function (s) { return s.done; }); }
  /** Compact results kept in the save: the classification rows minus heavy fields. */
  function compact(results) {
    return rowsOf(results).map(function (r) {
      return { id: r.isPlayer ? 'player' : r.id, name: r.name, team: r.team, number: r.number, color: r.color, isPlayer: !!r.isPlayer,
        position: r.position, status: r.status, bestLap_s: num(r.bestLap_s, null), totalTime_s: num(r.totalTime_s, null), gapText: r.gapText || '',
        gap_s: num(r.gap_s, null), laps: r.laps, gridPosition: r.gridPosition, pitStops: num(r.pitStops, 0), fastestLap: !!r.fastestLap,
        penalties_s: num(r.penalties_s, 0), endurance: r.endurance && r.endurance.f1 ? { f1: { compoundsUsed: r.endurance.f1.compoundsUsed || [], compound: r.endurance.f1.compound || null } } : null };
    });
  }
  function recordSession(w, sessionId, results, opts) {
    if (!w) return w;
    var s = null, idx = -1;
    w.sessions.forEach(function (x, i) { if (!s && x.id === sessionId && !x.done) { s = x; idx = i; } });
    if (!s) return w;
    s.done = true; s.skipped = !!(opts && opts.skipped);
    s.results = results ? compact(results) : null;
    if (results && results.fastestLap) s.fastestLap = clone(results.fastestLap);
    if (sessionId === 'qualifying' && s.results && s.results.length) w.grid = gridFrom(s.results);
    w.index = Math.min(w.sessions.length, idx + 1);
    return w;
  }
  function skipSession(w) { var s = currentSession(w); if (!s || s.id === 'race') return w; return recordSession(w, s.id, null, { skipped: true }); }

  /* ---------------------------------------------------------------- seasons */
  function createSeason(o) {
    o = o || {};
    var rounds = (Array.isArray(o.rounds) ? o.rounds : []).filter(function (r) { return typeof r === 'string'; });
    var st = { v: 1, kind: 'season', rounds: rounds, round: 0, settings: clone(o.settings || {}), history: [], totals: { drivers: {}, constructors: {} },
      weekend: null, created: o.now || Date.now(), sessionFormat: o.sessionFormat === 'weekend' ? 'weekend' : 'quick' };
    st.weekend = rounds.length ? createWeekend({ circuitId: rounds[0], format: st.sessionFormat, settings: st.settings }) : null;
    return st;
  }
  function addTo(map, key, base, pts, pos) {
    var e = map[key] || (map[key] = Object.assign({ points: 0, wins: 0, podiums: 0, finishes: [], best: 99 }, base));
    e.points += pts;
    if (pos === 1) e.wins++;
    if (pos <= 3) e.podiums++;
    e.finishes.push(pos);
    e.best = Math.min(e.best, pos);
    return e;
  }
  function applyRound(season, scored, opts) {
    if (!season || season.round >= season.rounds.length) return season;
    var T = season.totals;
    (scored || []).forEach(function (r) {
      var pos = r.status === 'dnf' || r.status === 'dsq' ? 99 : r.position;
      addTo(T.drivers, r.driverId, { id: r.driverId, name: r.name, teamId: r.teamId, team: r.team, isPlayer: !!r.isPlayer }, r.points, pos);
      if (r.teamId) addTo(T.constructors, r.teamId, { id: r.teamId, name: r.team }, r.points, pos);
    });
    season.history.push({ circuitId: season.rounds[season.round], results: (scored || []).map(function (r) {
      return { driverId: r.driverId, name: r.name, teamId: r.teamId, position: r.position, status: r.status, points: r.points, fastestLap: r.fastestLap, isPlayer: !!r.isPlayer };
    }) });
    season.round++;
    season.weekend = season.round < season.rounds.length ? createWeekend({ circuitId: season.rounds[season.round], format: season.sessionFormat, settings: season.settings }) : null;
    void opts;
    return season;
  }
  function cmpStanding(a, b) {
    if (b.points !== a.points) return b.points - a.points;
    // count-back: most wins, then most 2nds, 3rds ...
    for (var p = 1; p <= 22; p++) {
      var ca = a.finishes.filter(function (x) { return x === p; }).length, cb = b.finishes.filter(function (x) { return x === p; }).length;
      if (ca !== cb) return cb - ca;
    }
    return String(a.name).localeCompare(String(b.name));
  }
  function standings(src) {
    var T = src && src.totals ? src.totals : src || { drivers: {}, constructors: {} };
    var d = Object.keys(T.drivers || {}).map(function (k) { return T.drivers[k]; }).sort(cmpStanding);
    var c = Object.keys(T.constructors || {}).map(function (k) { return T.constructors[k]; }).sort(cmpStanding);
    d.forEach(function (e, i) { e.position = i + 1; e.gap = i ? d[0].points - e.points : 0; });
    c.forEach(function (e, i) { e.position = i + 1; e.gap = i ? c[0].points - e.points : 0; });
    return { drivers: d, constructors: c };
  }
  function isSeasonOver(s) { return !!s && s.round >= s.rounds.length; }

  /* ---------------------------------------------------------------- storage */
  function store(storage) {
    var ls = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    function get(k) { try { var v = ls && ls.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
    function set(k, v) { try { if (ls) ls.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
    return {
      load: function () { var s = get(KEY_SAVE); return isObj(s) && s.v === 1 ? s : null; },
      save: function (st) { return set(KEY_SAVE, st); },
      clear: function () { try { if (ls) ls.removeItem(KEY_SAVE); } catch (e) { /* ignore */ } },
      loadSettings: function () { return get(KEY_SETTINGS) || {}; },
      saveSettings: function (s) { return set(KEY_SETTINGS, s); },
      stats: function () { return get('forge.f1.stats.v1') || { races: 0, wins: 0, podiums: 0, poles: 0, points: 0, fastestLaps: 0, titles: 0, circuitsWon: [], teamsRaced: [] }; },
      saveStats: function (s) { return set('forge.f1.stats.v1', s); }
    };
  }

  CB.f1.weekend = {
    POINTS: POINTS, FASTEST_LAP_POINT: FASTEST_LAP_POINT, KEYS: { save: KEY_SAVE, settings: KEY_SETTINGS, records: KEY_RECORDS },
    entryOf: entryOf, score: score, gridFrom: gridFrom, compact: compact,
    createWeekend: createWeekend, currentSession: currentSession, recordSession: recordSession, skipSession: skipSession, isComplete: isComplete,
    createSeason: createSeason, applyRound: applyRound, standings: standings, isSeasonOver: isSeasonOver, store: store
  };
})();

if (typeof module !== 'undefined') module.exports = CB.f1.weekend;

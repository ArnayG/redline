/* ==========================================================================
   FORGE Atelier — js/game/profile.js
   CB.game.profile : the single persisted player profile shared by every game
   system (career, economy, achievements, replays, challenges, hub).

   - Persisted in localStorage 'forge.profile.v1' (memory fallback when
     localStorage is missing, blocked, or full).
   - Schema versioning + migration from legacy / partial / corrupt data.
   - Transaction ledger (last 200), credit & XP helpers, level curve
     xpForLevel(l) = round(1000 * l^1.6)  (XP needed to go from l -> l+1).
   - Change subscription (in-process + cross-tab via 'storage' events).
   - Stats helpers (recordRaceStats(results, config)), owned-car CRUD,
     settings defaults + keyboard / gamepad control bindings.

   Pure (no DOM required). Works in browsers (classic <script>) and Node.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.game = CB.game || {};

(function () {
  'use strict';

  /* ================================================================ consts */

  var STORAGE_KEY = 'forge.profile.v1';
  var BACKUP_KEY = 'forge.profile.v1.backup';
  var CURRENT_VERSION = 1;
  var START_CREDITS = 150000;
  var LEDGER_MAX = 200;
  var HISTORY_MAX = 60;
  var MAX_LEVEL = 100;
  var MAX_CARS = 64;
  var MAX_CREDITS = 1e12;

  var DIFFICULTIES = ['rookie', 'amateur', 'pro', 'alien'];
  var UNITS = ['kph', 'mph'];
  var CAMERAS = ['chase', 'north', 'tv'];
  var QUALITIES = ['low', 'medium', 'high', 'ultra'];
  var AVATAR_COLORS = ['#c8a96a', '#d94f3d', '#3d7fd9', '#3dbf8a', '#9b5de5', '#f2a541', '#e8e8e8', '#2b2d42'];

  var STAT_KEYS = ['races', 'wins', 'podiums', 'poles', 'fastestLaps', 'distance_km', 'topSpeed_kph',
    'crashes', 'creditsEarned', 'driftScoreBest'];
  /* additive, non-contract stats (kept alongside the contract keys) */
  var EXTRA_STAT_KEYS = ['dnfs', 'laps', 'cleanRaces', 'timeTrials', 'practiceSessions', 'creditsSpent',
    'xpEarned', 'carsBought', 'carsSold', 'racesLed', 'overtakes', 'penalties_s', 'timeDriven_s',
    'trackLimits', 'longestWinStreak', 'currentWinStreak', 'challengesCompleted'];
  /* stats combined with Math.max instead of addition */
  var MAX_STATS = { topSpeed_kph: 1, driftScoreBest: 1, longestWinStreak: 1 };

  /* Control actions (keyboard). Values are KeyboardEvent.code strings. */
  var ACTIONS = [
    { id: 'throttle',   label: 'Throttle',          group: 'Driving' },
    { id: 'brake',      label: 'Brake / Reverse',   group: 'Driving' },
    { id: 'steerLeft',  label: 'Steer left',        group: 'Driving' },
    { id: 'steerRight', label: 'Steer right',       group: 'Driving' },
    { id: 'handbrake',  label: 'Handbrake',         group: 'Driving' },
    { id: 'shiftUp',    label: 'Shift up',          group: 'Gearbox' },
    { id: 'shiftDown',  label: 'Shift down',        group: 'Gearbox' },
    { id: 'camera',     label: 'Cycle camera',      group: 'View' },
    { id: 'lookBack',   label: 'Look back',         group: 'View' },
    { id: 'pause',      label: 'Pause',             group: 'Session' },
    { id: 'reset',      label: 'Reset to track',    group: 'Session' },
    { id: 'pit',        label: 'Request pit stop',  group: 'Session' },
    { id: 'replay',     label: 'Instant replay',    group: 'Session' },
    { id: 'photo',      label: 'Photo mode',        group: 'Session' },
    { id: 'hud',        label: 'Toggle HUD',        group: 'View' }
  ];
  var MAX_BINDINGS_PER_ACTION = 3;

  function defaultBindings() {
    return {
      throttle:   ['KeyW', 'ArrowUp'],
      brake:      ['KeyS', 'ArrowDown'],
      steerLeft:  ['KeyA', 'ArrowLeft'],
      steerRight: ['KeyD', 'ArrowRight'],
      handbrake:  ['Space'],
      shiftUp:    ['KeyE', 'ShiftLeft', 'ShiftRight'],
      shiftDown:  ['KeyQ', 'ControlLeft', 'ControlRight'],
      camera:     ['KeyC'],
      lookBack:   ['KeyB'],
      pause:      ['KeyP', 'Escape'],
      reset:      ['KeyR'],
      pit:        ['KeyL'],
      replay:     ['KeyX'],
      photo:      ['KeyF'],
      hud:        ['KeyH']
    };
  }

  /* Gamepad defaults (W3C "standard" mapping). 'axisN+/-' or 'buttonN'. */
  function defaultGamepadBindings() {
    return {
      steer:     'axis0',
      throttle:  'button7',
      brake:     'button6',
      handbrake: 'button0',
      shiftUp:   'button5',
      shiftDown: 'button4',
      camera:    'button3',
      lookBack:  'button2',
      pause:     'button9',
      reset:     'button8',
      pit:       'button1'
    };
  }

  function defaultSettings() {
    return {
      units: 'kph',
      difficulty: 'amateur',
      assists: { abs: true, tc: true, autoShift: true, racingLine: false, steeringAssist: false, stabilityControl: true },
      audio: { master: 0.8, engine: 0.9, sfx: 0.8, music: 0.5, muted: false },
      controls: {
        bindings: defaultBindings(),
        gamepad: { enabled: true, bindings: defaultGamepadBindings(), deadzone: 0.12, steerLinearity: 1.0, vibration: true },
        steerSensitivity: 1.0,
        steerReturn: 1.0,
        invertSteer: false
      },
      camera: 'chase',
      graphics: { quality: 'high', particles: true, shadows: true, skidmarks: true, motionBlur: false, fpsCounter: false },
      hud: { minimap: true, speedometer: true, splits: true, opacity: 1.0 },
      gameplay: { defaultLaps: 3, defaultOpponents: 7, field: 'similar', weather: 'dry', timeOfDay: 'day', ghost: true, damage: true },
      ui: { reducedMotion: false, showTutorialHints: true, confirmPurchases: true },
      lockParts: true
    };
  }

  /* ============================================================== helpers */

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clone(v) {
    if (v === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
  }
  function num(v, def) {
    var n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && isFinite(n) ? n : def;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function clampNum(v, def, lo, hi) { return clamp(num(v, def), lo, hi); }
  function intNum(v, def, lo, hi) { return Math.round(clampNum(v, def, lo, hi)); }
  function bool(v, def) { return typeof v === 'boolean' ? v : def; }
  function str(v, def, maxLen) {
    if (typeof v !== 'string') return def;
    var s = v.replace(/[\u0000-\u001f]/g, '').trim();
    if (!s) return def;
    return maxLen ? s.slice(0, maxLen) : s;
  }
  function oneOf(v, list, def) { return list.indexOf(v) >= 0 ? v : def; }
  function uniqStrings(arr) {
    var out = [], seen = {};
    if (!Array.isArray(arr)) return out;
    for (var i = 0; i < arr.length; i++) {
      var s = arr[i];
      if (typeof s === 'number') s = String(s);
      if (typeof s !== 'string' || !s || seen[s]) continue;
      seen[s] = 1; out.push(s);
    }
    return out;
  }
  function now() { return Date.now(); }
  var idCounter = 0;
  function makeId(prefix) {
    idCounter = (idCounter + 1) % 1679616;
    return (prefix || 'id') + '-' + now().toString(36) + '-' + idCounter.toString(36) +
      Math.floor(Math.random() * 1296).toString(36);
  }
  function getPath(obj, path) {
    var parts = String(path).split('.'), o = obj;
    for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
    return o;
  }
  function setPath(obj, path, value) {
    var parts = String(path).split('.'), o = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!isObj(o[parts[i]])) o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
  }
  function deepMerge(target, src) {
    if (!isObj(src)) return target;
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      var v = src[k];
      if (isObj(v) && isObj(target[k])) deepMerge(target[k], v);
      else target[k] = clone(v);
    }
    return target;
  }
  function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0);
  }
  function defaultBuildFallback() {
    try {
      if (CB.data && typeof CB.data.defaultBuild === 'function') return CB.data.defaultBuild();
    } catch (e) { /* ignore */ }
    return {};
  }

  /* ============================================================ xp curve */

  /** XP needed to advance from level l to level l+1. */
  function xpForLevel(l) {
    l = Math.max(1, Math.floor(num(l, 1)));
    return Math.round(1000 * Math.pow(l, 1.6));
  }
  /* cumulative thresholds: totalXpForLevel(L) = XP total needed to *be* level L */
  var cumCache = [0, 0];
  function totalXpForLevel(L) {
    L = clamp(Math.floor(num(L, 1)), 1, MAX_LEVEL);
    while (cumCache.length <= L) {
      var k = cumCache.length; // level k
      cumCache.push(cumCache[k - 1] + xpForLevel(k - 1));
    }
    return cumCache[L];
  }
  function levelForXp(xp) {
    xp = Math.max(0, num(xp, 0));
    var lo = 1, hi = MAX_LEVEL;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (totalXpForLevel(mid) <= xp) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  /** Rich progress info for UIs (progress bars). */
  function levelInfo(xp) {
    xp = Math.max(0, Math.floor(num(xp, 0)));
    var level = levelForXp(xp);
    var start = totalXpForLevel(level);
    var maxed = level >= MAX_LEVEL;
    var next = maxed ? start : totalXpForLevel(level + 1);
    var needed = maxed ? 0 : next - start;
    return {
      level: level, xp: xp, levelStartXp: start, nextLevelXp: next,
      into: xp - start, needed: needed, remaining: maxed ? 0 : next - xp,
      progress: maxed ? 1 : clamp((xp - start) / needed, 0, 1), maxed: maxed, maxLevel: MAX_LEVEL
    };
  }
  function levelTitle(level) {
    var titles = [[1, 'Rookie'], [5, 'Club Racer'], [10, 'Privateer'], [15, 'Works Driver'], [20, 'Pro'],
      [30, 'Ace'], [40, 'Champion'], [55, 'Legend'], [75, 'Icon'], [100, 'Immortal']];
    var t = titles[0][1];
    for (var i = 0; i < titles.length; i++) if (level >= titles[i][0]) t = titles[i][1];
    return t;
  }

  /* ============================================================ defaults */

  function defaultStats() {
    var s = {};
    STAT_KEYS.forEach(function (k) { s[k] = 0; });
    EXTRA_STAT_KEYS.forEach(function (k) { s[k] = 0; });
    s.tracks = {};
    s.modes = {};
    s.history = [];
    return s;
  }

  function defaultProfile(opts) {
    opts = opts || {};
    var t = now();
    return {
      version: CURRENT_VERSION,
      id: makeId('drv'),
      driverName: str(opts.driverName, 'Driver', 24),
      avatarColor: str(opts.avatarColor, AVATAR_COLORS[0], 16),
      credits: START_CREDITS,
      xp: 0,
      level: 1,
      createdAt: t,
      updatedAt: t,
      ownedCars: [],
      activeCarId: null,
      unlocks: { parts: [], tracks: [], bodyStyles: [] },
      career: {},
      achievements: {},
      stats: defaultStats(),
      settings: defaultSettings(),
      ledger: [],
      meta: { sessions: 0, lastPlayed: t, migratedFrom: null }
    };
  }

  /* ============================================================ normalize */

  function normalizeCar(c, i) {
    if (!isObj(c)) return null;
    var build = isObj(c.build) ? clone(c.build) : defaultBuildFallback();
    return {
      id: str(c.id, null, 64) || makeId('car'),
      name: str(c.name, (build && build.name) || ('Car ' + (i + 1)), 40),
      build: build,
      purchasedFor: intNum(c.purchasedFor, 0, 0, MAX_CREDITS),
      purchasedAt: num(c.purchasedAt, null),
      odometer_km: clampNum(c.odometer_km, 0, 0, 1e9),
      races: intNum(c.races, 0, 0, 1e9),
      wins: intNum(c.wins, 0, 0, 1e9),
      podiums: intNum(c.podiums, 0, 0, 1e9),
      condition: clampNum(c.condition, 1, 0, 1),
      upgradesSpent: intNum(c.upgradesSpent, 0, 0, MAX_CREDITS),
      favorite: bool(c.favorite, false),
      thumbnail: typeof c.thumbnail === 'string' && c.thumbnail.length < 400000 ? c.thumbnail : null
    };
  }

  function normalizeBindings(src) {
    var def = defaultBindings();
    var out = {};
    var used = {};
    ACTIONS.forEach(function (a) {
      var list = isObj(src) && Array.isArray(src[a.id]) ? uniqStrings(src[a.id]) : def[a.id].slice();
      list = list.filter(function (code) { return code.length <= 32; }).slice(0, MAX_BINDINGS_PER_ACTION);
      out[a.id] = list;
    });
    // Resolve duplicates: first action (in ACTIONS order) keeps the key.
    ACTIONS.forEach(function (a) {
      out[a.id] = out[a.id].filter(function (code) {
        if (used[code]) return false;
        used[code] = a.id; return true;
      });
    });
    return out;
  }

  function normalizeSettings(s) {
    var d = defaultSettings();
    var src = isObj(s) ? s : {};
    var out = deepMerge(clone(d), src);
    // units aliases
    var u = src.units;
    if (u === 'metric' || u === 'km/h') u = 'kph';
    if (u === 'imperial') u = 'mph';
    out.units = oneOf(u, UNITS, d.units);
    out.difficulty = oneOf(src.difficulty, DIFFICULTIES, d.difficulty);
    out.camera = oneOf(src.camera, CAMERAS, d.camera);
    ['abs', 'tc', 'autoShift', 'racingLine', 'steeringAssist', 'stabilityControl'].forEach(function (k) {
      out.assists[k] = bool(out.assists[k], d.assists[k]);
    });
    ['master', 'engine', 'sfx', 'music'].forEach(function (k) {
      out.audio[k] = clampNum(out.audio[k], d.audio[k], 0, 1);
    });
    out.audio.muted = bool(out.audio.muted, false);
    var c = out.controls;
    if (!isObj(c)) c = out.controls = clone(d.controls);
    c.bindings = normalizeBindings(isObj(src.controls) ? src.controls.bindings : null);
    if (!isObj(c.gamepad)) c.gamepad = clone(d.controls.gamepad);
    c.gamepad.enabled = bool(c.gamepad.enabled, true);
    c.gamepad.deadzone = clampNum(c.gamepad.deadzone, 0.12, 0, 0.5);
    c.gamepad.steerLinearity = clampNum(c.gamepad.steerLinearity, 1, 0.3, 3);
    c.gamepad.vibration = bool(c.gamepad.vibration, true);
    var gpd = defaultGamepadBindings();
    if (!isObj(c.gamepad.bindings)) c.gamepad.bindings = gpd;
    Object.keys(gpd).forEach(function (k) {
      var v = c.gamepad.bindings[k];
      if (typeof v !== 'string' || !/^(axis\d{1,2}[+-]?|button\d{1,2})$/.test(v)) c.gamepad.bindings[k] = gpd[k];
    });
    c.steerSensitivity = clampNum(c.steerSensitivity, 1, 0.3, 3);
    c.steerReturn = clampNum(c.steerReturn, 1, 0.3, 3);
    c.invertSteer = bool(c.invertSteer, false);
    var g = out.graphics;
    g.quality = oneOf(g.quality, QUALITIES, d.graphics.quality);
    ['particles', 'shadows', 'skidmarks', 'motionBlur', 'fpsCounter'].forEach(function (k) {
      g[k] = bool(g[k], d.graphics[k]);
    });
    ['minimap', 'speedometer', 'splits'].forEach(function (k) { out.hud[k] = bool(out.hud[k], d.hud[k]); });
    out.hud.opacity = clampNum(out.hud.opacity, 1, 0.2, 1);
    var gp = out.gameplay;
    gp.defaultLaps = intNum(gp.defaultLaps, 3, 1, 50);
    gp.defaultOpponents = intNum(gp.defaultOpponents, 7, 0, 11);
    gp.field = oneOf(gp.field, ['similar', 'presets', 'mixed'], 'similar');
    gp.weather = oneOf(gp.weather, ['dry', 'damp', 'wet'], 'dry');
    gp.timeOfDay = oneOf(gp.timeOfDay, ['day', 'dusk', 'night'], 'day');
    gp.ghost = bool(gp.ghost, true);
    gp.damage = bool(gp.damage, true);
    ['reducedMotion', 'showTutorialHints', 'confirmPurchases'].forEach(function (k) {
      out.ui[k] = bool(out.ui[k], d.ui[k]);
    });
    out.lockParts = bool(out.lockParts, true);
    return out;
  }

  function normalizeStats(s) {
    var out = defaultStats();
    if (!isObj(s)) return out;
    STAT_KEYS.concat(EXTRA_STAT_KEYS).forEach(function (k) {
      out[k] = Math.max(0, num(s[k], 0));
    });
    // keep any other numeric stats contributed by other systems
    Object.keys(s).forEach(function (k) {
      if (out[k] === undefined && typeof s[k] === 'number' && isFinite(s[k])) out[k] = s[k];
    });
    if (isObj(s.tracks)) {
      Object.keys(s.tracks).forEach(function (tid) {
        var t = s.tracks[tid];
        if (!isObj(t)) return;
        out.tracks[tid] = {
          races: intNum(t.races, 0, 0, 1e9), wins: intNum(t.wins, 0, 0, 1e9), podiums: intNum(t.podiums, 0, 0, 1e9),
          bestLap_s: num(t.bestLap_s, null), bestFinish: num(t.bestFinish, null),
          distance_km: Math.max(0, num(t.distance_km, 0)), lastRaced: num(t.lastRaced, null)
        };
      });
    }
    if (isObj(s.modes)) {
      Object.keys(s.modes).forEach(function (m) { out.modes[m] = Math.max(0, intNum(s.modes[m], 0, 0, 1e9)); });
    }
    if (Array.isArray(s.history)) out.history = s.history.filter(isObj).slice(-HISTORY_MAX).map(clone);
    return out;
  }

  function normalizeLedger(l) {
    if (!Array.isArray(l)) return [];
    return l.filter(function (e) { return isObj(e) && typeof e.amount === 'number' && isFinite(e.amount); })
      .slice(-LEDGER_MAX)
      .map(function (e) {
        return {
          id: str(e.id, null, 64) || makeId('tx'), t: num(e.t, 0), amount: Math.round(e.amount),
          reason: str(e.reason, 'misc', 120), balance: Math.round(num(e.balance, 0)),
          kind: oneOf(e.kind, ['credit', 'debit'], e.amount >= 0 ? 'credit' : 'debit'),
          category: str(e.category, null, 32)
        };
      });
  }

  function normalizeAchievements(a) {
    var out = {};
    if (!isObj(a)) return out;
    Object.keys(a).forEach(function (id) {
      var e = a[id];
      if (e === true) { out[id] = { unlockedAt: 0, progress: null }; return; }
      if (!isObj(e)) return;
      var copy = clone(e);
      copy.unlockedAt = e.unlockedAt == null ? null : num(e.unlockedAt, null);
      if (!('progress' in copy)) copy.progress = null;
      out[id] = copy;
    });
    return out;
  }

  /** Coerce any (possibly partial / corrupt) object into a valid current-version profile. */
  function normalize(p) {
    var d = defaultProfile();
    if (!isObj(p)) return d;
    var out = {};
    // preserve unknown top-level keys contributed by other systems
    Object.keys(p).forEach(function (k) {
      if (k === '__proto__' || k === 'constructor') return;
      if (!(k in d)) out[k] = clone(p[k]);
    });
    out.version = CURRENT_VERSION;
    out.id = str(p.id, d.id, 64);
    out.driverName = str(p.driverName, d.driverName, 24);
    out.avatarColor = /^#[0-9a-fA-F]{3,8}$/.test(p.avatarColor || '') ? p.avatarColor : d.avatarColor;
    out.credits = intNum(p.credits, START_CREDITS, 0, MAX_CREDITS);
    out.xp = intNum(p.xp, 0, 0, totalXpForLevel(MAX_LEVEL) * 4);
    out.level = levelForXp(out.xp);
    out.createdAt = num(p.createdAt, d.createdAt);
    out.updatedAt = num(p.updatedAt, out.createdAt);
    var seen = {};
    out.ownedCars = (Array.isArray(p.ownedCars) ? p.ownedCars : []).map(normalizeCar).filter(function (c) {
      if (!c || seen[c.id]) return false;
      seen[c.id] = 1; return true;
    }).slice(0, MAX_CARS);
    out.activeCarId = seen[p.activeCarId] ? p.activeCarId : (out.ownedCars[0] ? out.ownedCars[0].id : null);
    var u = isObj(p.unlocks) ? p.unlocks : {};
    out.unlocks = { parts: uniqStrings(u.parts), tracks: uniqStrings(u.tracks), bodyStyles: uniqStrings(u.bodyStyles) };
    Object.keys(u).forEach(function (k) { if (!(k in out.unlocks) && Array.isArray(u[k])) out.unlocks[k] = uniqStrings(u[k]); });
    out.career = isObj(p.career) ? clone(p.career) : {};
    out.achievements = normalizeAchievements(p.achievements);
    out.stats = normalizeStats(p.stats);
    out.settings = normalizeSettings(p.settings);
    out.ledger = normalizeLedger(p.ledger);
    var m = isObj(p.meta) ? p.meta : {};
    out.meta = deepMerge(clone(d.meta), m);
    out.meta.sessions = intNum(out.meta.sessions, 0, 0, 1e9);
    return out;
  }

  /* ============================================================ migration */

  /* Each migration takes raw data at version N and returns data at version N+1. */
  var MIGRATIONS = {
    /* v0 = unversioned / pre-release prototype save */
    0: function (raw) {
      var p = clone(raw) || {};
      if (p.credits == null && p.money != null) p.credits = p.money;
      if (p.credits == null && p.cash != null) p.credits = p.cash;
      if (!p.driverName && (p.name || p.playerName)) p.driverName = p.name || p.playerName;
      if (!p.ownedCars && Array.isArray(p.cars)) p.ownedCars = p.cars;
      if (!p.ownedCars && Array.isArray(p.garage)) p.ownedCars = p.garage;
      if (Array.isArray(p.ownedCars)) {
        p.ownedCars = p.ownedCars.map(function (c) {
          if (!isObj(c)) return c;
          if (c.odometer_km == null && c.km != null) c.odometer_km = c.km;
          if (c.odometer_km == null && c.mileage_km != null) c.odometer_km = c.mileage_km;
          if (c.purchasedFor == null && c.price != null) c.purchasedFor = c.price;
          if (c.condition != null && c.condition > 1) c.condition = c.condition / 100; // percent -> 0..1
          return c;
        });
      }
      if (!p.activeCarId && p.activeCar) p.activeCarId = p.activeCar;
      if (Array.isArray(p.unlocks)) {
        // flat array: "parts:engine.types:w16" | "tracks:id" | "bodyStyles:id" | "engine.types:w16"
        var u = { parts: [], tracks: [], bodyStyles: [] };
        p.unlocks.forEach(function (s) {
          if (typeof s !== 'string') return;
          var m = /^(parts|tracks|bodyStyles):(.+)$/.exec(s);
          if (m) u[m[1]].push(m[2]); else u.parts.push(s);
        });
        p.unlocks = u;
      }
      if (Array.isArray(p.achievements)) {
        var a = {};
        p.achievements.forEach(function (id) { if (typeof id === 'string') a[id] = { unlockedAt: 0, progress: null }; });
        p.achievements = a;
      }
      if (isObj(p.settings) && typeof p.settings.units === 'string') {
        if (p.settings.units === 'metric') p.settings.units = 'kph';
        if (p.settings.units === 'imperial') p.settings.units = 'mph';
      }
      if (isObj(p.stats)) {
        if (p.stats.distance_km == null && p.stats.distance_m != null) p.stats.distance_km = p.stats.distance_m / 1000;
        if (p.stats.topSpeed_kph == null && p.stats.topSpeed_ms != null) p.stats.topSpeed_kph = p.stats.topSpeed_ms * 3.6;
      }
      p.version = 1;
      return p;
    }
  };

  /** Migrate raw stored data of any version into a valid current profile. Returns {profile, from, changed}. */
  function migrate(raw) {
    if (!isObj(raw)) return { profile: defaultProfile(), from: null, changed: true };
    var v = Math.floor(num(raw.version, 0));
    var from = v;
    var data = raw;
    if (v > CURRENT_VERSION) {
      // Saved by a newer build: keep everything we understand, never throw away unknown fields.
      data = clone(raw);
    } else {
      while (v < CURRENT_VERSION) {
        var fn = MIGRATIONS[v];
        data = fn ? fn(data) : clone(data);
        v = Math.floor(num(data && data.version, v + 1));
        if (!fn) v = Math.max(v, from + 1);
      }
    }
    var p = normalize(data);
    if (from !== CURRENT_VERSION) p.meta.migratedFrom = from;
    return { profile: p, from: from, changed: from !== CURRENT_VERSION };
  }

  /* ============================================================== storage */

  function createMemoryStorage() {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; },
      clear: function () { m = {}; },
      _memory: true
    };
  }
  function detectStorage() {
    try {
      var ls = typeof localStorage !== 'undefined' ? localStorage : (typeof window !== 'undefined' ? window.localStorage : null);
      if (!ls) return null;
      var probe = '__forge_probe__';
      ls.setItem(probe, '1'); ls.removeItem(probe);
      return ls;
    } catch (e) { return null; }
  }

  var storage = null;          // active backend
  var memoryStore = createMemoryStorage();
  var persistent = false;      // true while writing to real localStorage
  var lastSaveError = null;

  function backend() {
    if (!storage) {
      var ls = detectStorage();
      storage = ls || memoryStore;
      persistent = !!ls;
    }
    return storage;
  }

  /* ================================================================ state */

  var current = null;          // live profile (internal reference)
  var listeners = [];
  var draft = null;            // active update() draft (nested update support)
  var emitting = false;
  var pendingEmits = [];
  var storageListenerInstalled = false;

  function ensureLoaded() { if (!current) load(); return current; }

  function emit(meta) {
    pendingEmits.push(meta || {});
    if (emitting) return;
    emitting = true;
    try {
      while (pendingEmits.length) {
        var m = pendingEmits.shift();
        var snapshot = listeners.slice();
        for (var i = 0; i < snapshot.length; i++) {
          try { snapshot[i](current, m); } catch (e) {
            if (typeof console !== 'undefined' && console.error) console.error('[profile] listener error', e);
          }
        }
      }
    } finally { emitting = false; }
  }

  function installStorageListener() {
    if (storageListenerInstalled) return;
    storageListenerInstalled = true;
    try {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('storage', function (e) {
          if (!e || e.key !== STORAGE_KEY || !persistent) return;
          if (e.newValue == null) { current = defaultProfile(); emit({ reason: 'external-reset', external: true }); return; }
          try {
            var res = migrate(JSON.parse(e.newValue));
            current = res.profile;
            emit({ reason: 'external', external: true });
          } catch (err) { /* ignore corrupt foreign writes */ }
        });
      }
    } catch (e) { /* ignore */ }
  }

  /** Load from storage (or create). Returns the live profile. */
  function load() {
    var be = backend();
    var raw = null, parsed = null, corrupt = false;
    try { raw = be.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    if (raw) {
      try { parsed = JSON.parse(raw); } catch (e) { corrupt = true; }
    }
    var fresh = !parsed;
    if (corrupt) {
      try { be.setItem(BACKUP_KEY, raw); } catch (e) { /* ignore */ }
    }
    var res = migrate(parsed);
    if (res.changed && parsed && res.from !== CURRENT_VERSION) {
      try { be.setItem(BACKUP_KEY, raw); } catch (e) { /* ignore */ }
    }
    current = res.profile;
    current.meta.sessions += 1;
    current.meta.lastPlayed = now();
    if (corrupt) current.meta.recoveredFromCorrupt = true;
    installStorageListener();
    save();
    emit({ reason: fresh ? 'created' : 'load', migratedFrom: res.changed ? res.from : undefined });
    return current;
  }

  /** Persist the live profile. Returns true on success (memory writes count as success). */
  function save() {
    if (!current) return false;
    current.updatedAt = now();
    var json;
    try { json = JSON.stringify(current); } catch (e) { lastSaveError = e; return false; }
    var be = backend();
    try {
      be.setItem(STORAGE_KEY, json);
      lastSaveError = null;
      return true;
    } catch (e) {
      lastSaveError = e;
      // Quota: shed bulky optional data, then retry.
      try {
        current.ledger = current.ledger.slice(-50);
        current.stats.history = current.stats.history.slice(-10);
        current.ownedCars.forEach(function (c) { c.thumbnail = null; });
        be.setItem(STORAGE_KEY, JSON.stringify(current));
        lastSaveError = null;
        return true;
      } catch (e2) {
        // Fall back to in-memory storage for the rest of the session.
        storage = memoryStore; persistent = false;
        try { memoryStore.setItem(STORAGE_KEY, JSON.stringify(current)); } catch (e3) { /* ignore */ }
        return true;
      }
    }
  }

  /** Deep clone of the current profile (safe to read / mutate freely). */
  function get() { return clone(ensureLoaded()); }

  /** Live read-only reference (no copy; DO NOT mutate). Fast path for render loops. */
  function peek() { return ensureLoaded(); }

  /**
   * update(fn): fn receives a mutable clone; may return a replacement object.
   * The result is normalized, committed, saved, and listeners notified.
   * Nested update() calls inside fn (or inside helpers) operate on the same draft.
   * Returns fn's return value if it isn't an object replacement, else the new profile clone.
   */
  function update(fn, meta) {
    ensureLoaded();
    if (typeof fn !== 'function') return get();
    if (draft) {
      var r = fn(draft);
      return r;
    }
    var prev = current;
    draft = clone(current);
    var ret, failed = true;
    try {
      ret = fn(draft);
      failed = false;
    } finally {
      var d = draft;
      draft = null;
      if (!failed) {
        if (isObj(ret) && ret.version != null && ret.ownedCars) d = ret; // replacement profile
        var next = normalize(d);
        next.meta = d.meta || next.meta;
        var levelBefore = prev.level;
        current = next;
        save();
        var m = isObj(meta) ? meta : { reason: typeof meta === 'string' ? meta : 'update' };
        m.prev = prev;
        if (current.level !== levelBefore) m.levelChanged = { from: levelBefore, to: current.level };
        emit(m);
      }
    }
    if (isObj(ret) && ret.version != null && ret.ownedCars) return get();
    return ret;
  }

  /** subscribe(fn(profile, meta)) → unsubscribe(). */
  function subscribe(fn, opts) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    if (opts && opts.immediate) { try { fn(ensureLoaded(), { reason: 'subscribe' }); } catch (e) { /* ignore */ } }
    return function unsubscribe() {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /** reset({keepSettings, keepName}) — wipe progress. Returns the new profile clone. */
  function reset(opts) {
    opts = opts || {};
    var prev = current;
    var fresh = defaultProfile();
    if (prev && opts.keepSettings) fresh.settings = clone(prev.settings);
    if (prev && opts.keepName) { fresh.driverName = prev.driverName; fresh.avatarColor = prev.avatarColor; }
    current = fresh;
    try { backend().removeItem(BACKUP_KEY); } catch (e) { /* ignore */ }
    save();
    emit({ reason: 'reset', prev: prev });
    return get();
  }

  /* ============================================================ ledger */

  function pushLedger(p, amount, reason, category) {
    var entry = {
      id: makeId('tx'), t: now(), amount: Math.round(amount), reason: str(reason, amount >= 0 ? 'credit' : 'debit', 120),
      balance: p.credits, kind: amount >= 0 ? 'credit' : 'debit', category: str(category, null, 32)
    };
    p.ledger.push(entry);
    if (p.ledger.length > LEDGER_MAX) p.ledger.splice(0, p.ledger.length - LEDGER_MAX);
    return entry;
  }

  /** addCredits(n, reason, category?) → new balance. Negative n deducts (clamped at 0) without failing. */
  function addCredits(n, reason, category) {
    n = Math.round(num(n, 0));
    if (!n) return ensureLoaded().credits;
    return update(function (p) {
      var before = p.credits;
      p.credits = clamp(p.credits + n, 0, MAX_CREDITS);
      var delta = p.credits - before;
      if (delta > 0) p.stats.creditsEarned += delta;
      if (delta < 0) p.stats.creditsSpent += -delta;
      if (delta) pushLedger(p, delta, reason, category);
      return p.credits;
    }, { reason: 'credits', amount: n, label: reason });
  }

  /** spend(n, reason, category?) → true if affordable (deducted), else false (no change). */
  function spend(n, reason, category) {
    n = Math.round(num(n, 0));
    if (n < 0) return false;
    if (n === 0) return true;
    if (ensureLoaded().credits < n) return false;
    return update(function (p) {
      if (p.credits < n) return false;
      p.credits -= n;
      p.stats.creditsSpent += n;
      pushLedger(p, -n, reason, category);
      return true;
    }, { reason: 'spend', amount: -n, label: reason });
  }

  function canAfford(n) { return ensureLoaded().credits >= Math.round(num(n, 0)); }

  /** Ledger query: getLedger({limit, kind, category, since}) newest-first copies. */
  function getLedger(q) {
    q = q || {};
    var l = ensureLoaded().ledger.slice().reverse();
    if (q.kind) l = l.filter(function (e) { return e.kind === q.kind; });
    if (q.category) l = l.filter(function (e) { return e.category === q.category; });
    if (q.since) l = l.filter(function (e) { return e.t >= q.since; });
    if (q.limit) l = l.slice(0, q.limit);
    return clone(l);
  }
  /** Aggregate ledger: {earned, spent, net, byCategory:{cat:{earned, spent}}}. */
  function ledgerSummary() {
    var out = { earned: 0, spent: 0, net: 0, byCategory: {} };
    ensureLoaded().ledger.forEach(function (e) {
      var c = e.category || 'misc';
      var b = out.byCategory[c] || (out.byCategory[c] = { earned: 0, spent: 0 });
      if (e.amount >= 0) { out.earned += e.amount; b.earned += e.amount; }
      else { out.spent -= e.amount; b.spent -= e.amount; }
    });
    out.net = out.earned - out.spent;
    return out;
  }

  /* ================================================================ xp */

  /** addXp(n) → {levelUp, newLevel, oldLevel, levelsGained, xp, info}. */
  function addXp(n, reason) {
    n = Math.max(0, Math.round(num(n, 0)));
    var p0 = ensureLoaded();
    var oldLevel = p0.level;
    if (!n) return { levelUp: false, newLevel: oldLevel, oldLevel: oldLevel, levelsGained: 0, xp: p0.xp, gained: 0, info: levelInfo(p0.xp) };
    var res = update(function (p) {
      p.xp += n;
      p.stats.xpEarned += n;
      p.level = levelForXp(p.xp);
      return { xp: p.xp, level: p.level };
    }, { reason: 'xp', amount: n, label: reason });
    return {
      levelUp: res.level > oldLevel, newLevel: res.level, oldLevel: oldLevel,
      levelsGained: res.level - oldLevel, xp: res.xp, gained: n, info: levelInfo(res.xp)
    };
  }

  /** Award credits + xp in a single commit: award({credits, xp, reason, category}). */
  function award(a) {
    a = a || {};
    var oldLevel = ensureLoaded().level;
    var credits = Math.max(0, Math.round(num(a.credits, 0)));
    var xp = Math.max(0, Math.round(num(a.xp, 0)));
    var r = update(function (p) {
      if (credits) {
        p.credits = clamp(p.credits + credits, 0, MAX_CREDITS);
        p.stats.creditsEarned += credits;
        pushLedger(p, credits, a.reason || 'reward', a.category || 'reward');
      }
      if (xp) { p.xp += xp; p.stats.xpEarned += xp; p.level = levelForXp(p.xp); }
      return { level: p.level, credits: p.credits, xp: p.xp };
    }, { reason: 'award', credits: credits, xp: xp, label: a.reason });
    return { credits: r.credits, xp: r.xp, levelUp: r.level > oldLevel, oldLevel: oldLevel, newLevel: r.level, info: levelInfo(r.xp) };
  }

  /* =============================================================== stats */

  /** recordStat(key, value, mode 'add'|'max'|'min'|'set') → new value. */
  function recordStat(key, value, mode) {
    value = num(value, 0);
    mode = mode || (MAX_STATS[key] ? 'max' : 'add');
    return update(function (p) {
      var cur = num(p.stats[key], 0);
      var has = typeof p.stats[key] === 'number';
      var next = mode === 'max' ? Math.max(cur, value)
        : mode === 'min' ? (has && cur ? Math.min(cur, value) : value)
        : mode === 'set' ? value : cur + value;
      p.stats[key] = next;
      return next;
    }, { reason: 'stat', key: key });
  }
  function incStat(key, by) { return recordStat(key, by == null ? 1 : by, 'add'); }

  function pickNum(o, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = o[keys[i]];
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return null;
  }
  function countish(v) {
    if (Array.isArray(v)) return v.length;
    return typeof v === 'number' && isFinite(v) ? v : 0;
  }

  function trackLengthFor(config, results) {
    var c = config || {};
    var L = pickNum(c, ['trackLength_m', 'length_m', 'lapLength_m']);
    if (L == null && isObj(c.geom)) L = pickNum(c.geom, ['length', 'length_m', 'totalLength']);
    if (L == null && isObj(c.track)) L = pickNum(c.track, ['length_m', 'length']);
    if (L == null && isObj(results)) L = pickNum(results, ['trackLength_m', 'length_m']);
    if (L == null && c.trackId) {
      try {
        var list = CB.race && CB.race.tracks && CB.race.tracks.list;
        if (Array.isArray(list)) {
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].id === c.trackId) { L = pickNum(list[i], ['length_m', 'length']); break; }
          }
        }
        if (L == null && CB.race.tracks.get) { var t = CB.race.tracks.get(c.trackId); if (t) L = pickNum(t, ['length_m', 'length']); }
      } catch (e) { /* ignore */ }
    }
    return L;
  }

  /**
   * Normalize arbitrary engine results into a summary for the player.
   * Accepts: array of car results | {cars|results|order|classification|standings: [...], fastestLap, playerId, ...} | snapshot.
   */
  function summarizeRace(results, config) {
    config = config || {};
    var list = null, root = {};
    if (Array.isArray(results)) list = results;
    else if (isObj(results)) {
      root = results;
      list = results.cars || results.results || results.order || results.classification || results.standings || results.entries || null;
    }
    if (!Array.isArray(list)) list = [];
    list = list.filter(isObj);
    var playerId = root.playerId != null ? root.playerId : config.playerId;
    var player = null;
    for (var i = 0; i < list.length && !player; i++) if (list[i].isPlayer) player = list[i];
    if (!player && playerId != null) {
      for (var j = 0; j < list.length && !player; j++) if (list[j].id === playerId || list[j].carId === playerId) player = list[j];
    }
    if (!player && list.length === 1) player = list[0];
    if (!player && isObj(root.player)) player = root.player;
    var mode = config.mode || root.mode || 'race';
    var fieldSize = num(root.fieldSize, null) || num(config.fieldSize, null) || list.length ||
      (num(config.opponents, 0) + 1);
    var trackId = config.trackId || root.trackId || null;
    var summary = {
      valid: !!player, mode: mode, trackId: trackId, fieldSize: fieldSize, position: null, dnf: false,
      win: false, podium: false, pole: false, fastestLap: false, clean: false, ledEveryLap: false,
      bestLap_s: null, finishTime_s: null, laps: 0, distance_km: 0, topSpeed_kph: 0, crashes: 0,
      driftScore: 0, penalties_s: 0, trackLimits: 0, overtakes: 0, time_s: 0, gridPosition: null,
      difficulty: config.difficulty || root.difficulty || null, carId: config.carId || null
    };
    if (!player) return summary;
    var pid = player.id != null ? player.id : player.carId;

    var pos = pickNum(player, ['position', 'pos', 'place', 'finishPosition']);
    if (pos == null) {
      var sorted = list.slice().sort(function (a, b) { return num(a.position, 99) - num(b.position, 99); });
      pos = sorted.indexOf(player) + 1;
    }
    summary.position = pos;
    summary.dnf = !!(player.dnf || player.dsq || player.retired || player.status === 'dnf' || player.status === 'dsq' ||
      (root.complete === false && player.status === 'running' && config.countUnfinishedAsDnf !== false && mode === 'race'));
    summary.status = player.status || (summary.dnf ? 'dnf' : 'finished');
    var isRace = mode === 'race';
    summary.win = isRace && !summary.dnf && pos === 1 && fieldSize > 1;
    summary.podium = isRace && !summary.dnf && pos >= 1 && pos <= 3 && fieldSize > 1;

    var grid = pickNum(player, ['gridPosition', 'grid', 'startPosition', 'gridSlot', 'qualifyingPosition']);
    summary.gridPosition = grid;
    summary.pole = isRace && fieldSize > 1 && (grid === 1 || !!player.pole || root.poleCarId === pid);

    var fl = root.fastestLap || (config && config.fastestLap);
    summary.fastestLap = fieldSize > 1 && isRace && !!(player.fastestLap === true || (isObj(fl) && fl.carId != null && fl.carId === pid));

    summary.bestLap_s = pickNum(player, ['bestLap_s', 'bestLap', 'bestLapTime']);
    summary.finishTime_s = pickNum(player, ['finishTime_s', 'totalTime_s', 'time_s', 'raceTime_s']);
    summary.laps = Math.max(0, Math.floor(num(pickNum(player, ['lapsCompleted', 'laps', 'lap']), 0)));

    var dkm = pickNum(player, ['distance_km']);
    if (dkm == null) { var dm = pickNum(player, ['distance_m', 'distance']); if (dm != null) dkm = dm / 1000; }
    if (dkm == null) {
      var L = trackLengthFor(config, root);
      if (L && summary.laps) dkm = (summary.laps * L) / 1000;
      else if (L && summary.finishTime_s && !summary.dnf) dkm = (num(config.laps, 0) * L) / 1000;
    }
    summary.distance_km = Math.max(0, num(dkm, 0));

    var ts = pickNum(player, ['topSpeed_kph', 'maxSpeed_kph', 'vmax_kph']);
    if (ts == null) { var tms = pickNum(player, ['topSpeed_ms', 'maxSpeed_ms', 'topSpeed', 'maxSpeed']); if (tms != null) ts = tms * 3.6; }
    summary.topSpeed_kph = Math.max(0, num(ts, 0));

    // "Contacts" = the count the results screen shows: the race UI's session tally (root.collisions / root.contacts) when
    // present, else the player's intensity-filtered contact events (>= 0.35, 0.6 s debounce), else the raw engine counter.
    var crashes = null;
    if (isNum(root.contacts)) crashes = root.contacts;
    else if (isNum(root.collisions)) crashes = root.collisions;
    else if (player.contacts != null) crashes = countish(player.contacts);
    else if (player.crashes != null) crashes = countish(player.crashes);
    else if (Array.isArray(root.events) && root.events.some(function (e) { return e && isNum(e.intensity) && (e.type === 'collision' || e.type === 'wall'); })) {
      var lastT = -Infinity;
      crashes = root.events.filter(function (e) {
        if (!(e && e.carId === pid && (e.type === 'collision' || e.type === 'wall') && num(e.intensity, 0) >= 0.35)) return false;
        var t = num(e.t, null);
        if (t != null && t - lastT <= 0.6) return false;
        if (t != null) lastT = t;
        return true;
      }).length;
    } else if (player.collisions != null) crashes = countish(player.collisions);
    else crashes = countish(player.impacts) + countish(player.wallHits);
    summary.crashes = Math.max(0, Math.round(crashes));
    summary.penalties_s = Math.max(0, num(pickNum(player, ['penalties_s', 'penalty_s']), 0));
    summary.trackLimits = Math.max(0, Math.round(num(player.trackLimits, 0)));
    summary.driftScore = Math.max(0, num(pickNum(player, ['driftScore', 'driftScoreBest']), num(root.driftScore, 0)));
    summary.overtakes = Math.max(0, Math.round(num(player.overtakes, 0)));
    var lapsLed = num(player.lapsLed, null);
    if (lapsLed == null && Array.isArray(player.positionsByLap)) {
      lapsLed = player.positionsByLap.filter(function (x) { return x === 1; }).length;
    }
    summary.lapsLed = Math.max(0, Math.round(num(lapsLed, 0)));
    summary.ledEveryLap = !!(player.ledEveryLap || (isRace && summary.laps > 0 && summary.lapsLed >= summary.laps));
    summary.positionsGained = grid != null && pos ? grid - pos : 0;
    if (!player.overtakes && summary.positionsGained > 0 && !summary.dnf) summary.overtakes = summary.positionsGained;
    summary.time_s = Math.max(0, num(summary.finishTime_s, num(root.duration_s, 0)));
    summary.clean = !summary.dnf && summary.crashes === 0 && summary.penalties_s === 0 &&
      (player.clean !== false) && summary.trackLimits === 0;
    if (player.clean === true) summary.clean = !summary.dnf;
    return summary;
  }

  /** Apply a race summary to a profile object (pure mutation; no save). */
  function applyRaceSummary(p, s, opts) {
    opts = opts || {};
    if (!s.valid) return p;
    var st = p.stats;
    var mode = s.mode;
    st.modes[mode] = (st.modes[mode] || 0) + 1;
    if (mode === 'race') {
      st.races += 1;
      if (s.win) { st.wins += 1; st.currentWinStreak += 1; st.longestWinStreak = Math.max(st.longestWinStreak, st.currentWinStreak); }
      else st.currentWinStreak = 0;
      if (s.podium) st.podiums += 1;
      if (s.pole) st.poles += 1;
      if (s.fastestLap) st.fastestLaps += 1;
      if (s.dnf) st.dnfs += 1;
      if (s.clean && s.fieldSize > 1) st.cleanRaces += 1;
      if (s.lapsLed > 0) st.racesLed += 1;
    } else if (mode === 'time-trial') st.timeTrials += 1;
    else if (mode === 'practice') st.practiceSessions += 1;
    st.laps += s.laps;
    st.distance_km = Math.round((st.distance_km + s.distance_km) * 1000) / 1000;
    st.topSpeed_kph = Math.max(st.topSpeed_kph, Math.round(s.topSpeed_kph * 10) / 10);
    st.crashes += s.crashes;
    st.driftScoreBest = Math.max(st.driftScoreBest, Math.round(s.driftScore));
    st.overtakes += s.overtakes;
    st.penalties_s += s.penalties_s;
    st.trackLimits += s.trackLimits;
    st.timeDriven_s += s.time_s;

    var newRecords = [];
    if (s.trackId) {
      var t = st.tracks[s.trackId] || (st.tracks[s.trackId] = { races: 0, wins: 0, podiums: 0, bestLap_s: null, bestFinish: null, distance_km: 0, lastRaced: null });
      t.races += 1;
      if (s.win) t.wins += 1;
      if (s.podium) t.podiums += 1;
      if (s.bestLap_s != null && s.bestLap_s > 0 && (t.bestLap_s == null || s.bestLap_s < t.bestLap_s)) {
        if (t.bestLap_s != null) newRecords.push({ type: 'bestLap', trackId: s.trackId, prev: t.bestLap_s, value: s.bestLap_s });
        else newRecords.push({ type: 'firstLap', trackId: s.trackId, value: s.bestLap_s });
        t.bestLap_s = s.bestLap_s;
      }
      if (mode === 'race' && !s.dnf && s.position && (t.bestFinish == null || s.position < t.bestFinish)) t.bestFinish = s.position;
      t.distance_km = Math.round((t.distance_km + s.distance_km) * 1000) / 1000;
      t.lastRaced = now();
    }

    st.history.push({
      t: now(), mode: mode, trackId: s.trackId, position: s.position, fieldSize: s.fieldSize, dnf: s.dnf,
      bestLap_s: s.bestLap_s, distance_km: Math.round(s.distance_km * 100) / 100, topSpeed_kph: Math.round(s.topSpeed_kph),
      carId: null, difficulty: s.difficulty, eventType: opts.eventType || null
    });
    if (st.history.length > HISTORY_MAX) st.history.splice(0, st.history.length - HISTORY_MAX);

    // Owned car wear / odometer
    var carId = s.carId || opts.carId || p.activeCarId;
    var car = null;
    for (var i = 0; i < p.ownedCars.length; i++) if (p.ownedCars[i].id === carId) car = p.ownedCars[i];
    if (car) {
      st.history[st.history.length - 1].carId = car.id;
      car.odometer_km = Math.round((car.odometer_km + s.distance_km) * 1000) / 1000;
      if (mode === 'race') { car.races += 1; if (s.win) car.wins += 1; if (s.podium) car.podiums += 1; }
      if (!opts.skipCarWear) {
        var wear = s.distance_km * 0.0015 + s.crashes * 0.02 + (s.dnf ? 0.05 : 0);
        car.condition = Math.max(0, Math.round((car.condition - wear) * 10000) / 10000);
      }
    }
    s.newRecords = newRecords;
    return p;
  }

  /**
   * recordRaceStats(results, config) — fold an engine result into the profile stats,
   * per-track records, race history, and the active (or config.carId) owned car.
   * Returns the summary {position, win, podium, pole, fastestLap, distance_km, newRecords, ...}.
   */
  function recordRaceStats(results, config, opts) {
    var s = summarizeRace(results, config);
    if (!s.valid) return s;
    update(function (p) { applyRaceSummary(p, s, opts || config || {}); }, { reason: 'race-stats', summary: s });
    return s;
  }

  /** Derived dashboard numbers for the Profile screen. */
  function statsSummary(profile) {
    var p = profile || ensureLoaded();
    var st = p.stats;
    var races = st.races || 0;
    var pct = function (a) { return races ? Math.round((a / races) * 1000) / 10 : 0; };
    var favTrack = null, favCount = 0;
    Object.keys(st.tracks || {}).forEach(function (k) { if (st.tracks[k].races > favCount) { favCount = st.tracks[k].races; favTrack = k; } });
    var finishes = (st.history || []).filter(function (h) { return h.mode === 'race' && !h.dnf && h.position; });
    var avgFinish = finishes.length ? finishes.reduce(function (a, h) { return a + h.position; }, 0) / finishes.length : null;
    return {
      races: races, wins: st.wins, podiums: st.podiums, poles: st.poles, fastestLaps: st.fastestLaps,
      winRate: pct(st.wins), podiumRate: pct(st.podiums), poleRate: pct(st.poles), dnfRate: pct(st.dnfs),
      avgFinish: avgFinish == null ? null : Math.round(avgFinish * 100) / 100,
      distance_km: st.distance_km, topSpeed_kph: st.topSpeed_kph, crashes: st.crashes,
      crashesPerRace: races ? Math.round((st.crashes / races) * 100) / 100 : 0,
      creditsEarned: st.creditsEarned, creditsSpent: st.creditsSpent, driftScoreBest: st.driftScoreBest,
      favoriteTrack: favTrack, carsOwned: p.ownedCars.length, level: p.level, levelTitle: levelTitle(p.level),
      achievementsUnlocked: Object.keys(p.achievements).filter(function (k) { return p.achievements[k].unlockedAt != null; }).length,
      longestWinStreak: st.longestWinStreak, timeDriven_s: st.timeDriven_s,
      recentForm: (st.history || []).filter(function (h) { return h.mode === 'race'; }).slice(-10).map(function (h) { return h.dnf ? null : h.position; })
    };
  }

  /* =========================================================== owned cars */

  function findCar(p, id) {
    for (var i = 0; i < p.ownedCars.length; i++) if (p.ownedCars[i].id === id) return p.ownedCars[i];
    return null;
  }
  function getCar(id) { var c = findCar(ensureLoaded(), id); return c ? clone(c) : null; }
  function listCars() { return clone(ensureLoaded().ownedCars); }
  function activeCar() { var p = ensureLoaded(); var c = findCar(p, p.activeCarId); return c ? clone(c) : null; }

  /**
   * addCar(build, {name, purchasedFor, setActive, id, condition, odometer_km}) → car clone (or null if garage full).
   * Does NOT charge credits (economy / hub calls spend() first, then addCar).
   */
  function addCar(build, opts) {
    opts = opts || {};
    if (isObj(build) && isObj(build.build) && opts.purchasedFor == null && !opts.name) { opts = build; build = build.build; }
    return update(function (p) {
      if (p.ownedCars.length >= MAX_CARS) return null;
      var id = str(opts.id, null, 64);
      if (!id || findCar(p, id)) id = makeId('car');
      var b = isObj(build) ? clone(build) : defaultBuildFallback();
      var car = normalizeCar({
        id: id, name: opts.name || (b && b.name) || ('Car ' + (p.ownedCars.length + 1)), build: b,
        purchasedFor: opts.purchasedFor || 0, purchasedAt: now(), odometer_km: opts.odometer_km || 0,
        condition: opts.condition == null ? 1 : opts.condition, thumbnail: opts.thumbnail
      }, p.ownedCars.length);
      p.ownedCars.push(car);
      p.stats.carsBought += 1;
      if (opts.setActive !== false && (!p.activeCarId || opts.setActive)) p.activeCarId = car.id;
      return clone(car);
    }, { reason: 'car-added' });
  }

  /** removeCar(id) → removed car clone or null. Active car moves to the next available car. */
  function removeCar(id, opts) {
    opts = opts || {};
    return update(function (p) {
      var idx = -1;
      for (var i = 0; i < p.ownedCars.length; i++) if (p.ownedCars[i].id === id) idx = i;
      if (idx < 0) return null;
      var removed = p.ownedCars.splice(idx, 1)[0];
      if (opts.sold) p.stats.carsSold += 1;
      if (p.activeCarId === id) {
        var next = p.ownedCars[Math.min(idx, p.ownedCars.length - 1)];
        p.activeCarId = next ? next.id : null;
      }
      return clone(removed);
    }, { reason: 'car-removed', carId: id });
  }

  /** setActiveCar(id) → true if the car exists. */
  function setActiveCar(id) {
    if (!findCar(ensureLoaded(), id)) return false;
    if (current.activeCarId === id) return true;
    update(function (p) { p.activeCarId = id; }, { reason: 'active-car', carId: id });
    return true;
  }

  /**
   * updateCar(id, patch | fn(car)) → updated car clone or null.
   * patch is shallow-merged except `build`, which is replaced wholesale (builds are atomic).
   */
  function updateCar(id, patch) {
    if (!findCar(ensureLoaded(), id)) return null;
    return update(function (p) {
      var idx = -1;
      for (var i = 0; i < p.ownedCars.length; i++) if (p.ownedCars[i].id === id) idx = i;
      if (idx < 0) return null;
      var car = p.ownedCars[idx];
      if (typeof patch === 'function') {
        var r = patch(car);
        if (isObj(r)) car = r;
      } else if (isObj(patch)) {
        Object.keys(patch).forEach(function (k) {
          if (k === 'id' || k === '__proto__') return;
          car[k] = k === 'build' ? clone(patch[k]) : (isObj(patch[k]) ? clone(patch[k]) : patch[k]);
        });
      }
      car.id = id;
      var n = normalizeCar(car, idx);
      p.ownedCars[idx] = n;
      return clone(n);
    }, { reason: 'car-updated', carId: id });
  }

  /** Rename helper. */
  function renameCar(id, name) { return updateCar(id, { name: name }); }

  /* ============================================================== unlocks */

  function unlockKey(kind, a, b) { return kind === 'parts' && b != null ? a + ':' + b : String(a); }
  /** unlock('parts', 'engine.types', 'w16') | unlock('tracks', 'monza') → true if newly unlocked. */
  function unlock(kind, a, b) {
    var key = unlockKey(kind, a, b);
    var p = ensureLoaded();
    if (p.unlocks[kind] && p.unlocks[kind].indexOf(key) >= 0) return false;
    update(function (d) {
      if (!d.unlocks[kind]) d.unlocks[kind] = [];
      if (d.unlocks[kind].indexOf(key) < 0) d.unlocks[kind].push(key);
    }, { reason: 'unlock', kind: kind, key: key });
    return true;
  }
  function hasUnlock(kind, a, b, profile) {
    var p = profile || ensureLoaded();
    var list = p.unlocks && p.unlocks[kind];
    return !!list && list.indexOf(unlockKey(kind, a, b)) >= 0;
  }

  /* ============================================================ settings */

  function getSettings() { return clone(ensureLoaded().settings); }
  function getSetting(path, def) {
    var v = getPath(ensureLoaded().settings, path);
    return v === undefined ? def : clone(v);
  }
  /** setSetting('audio.master', 0.5) or setSetting({audio:{master:.5}}) — validated via normalize. */
  function setSetting(path, value) {
    update(function (p) {
      if (isObj(path)) deepMerge(p.settings, path);
      else setPath(p.settings, path, clone(value));
    }, { reason: 'settings', path: isObj(path) ? null : path });
    return getSettings();
  }
  function resetSettings() {
    update(function (p) { p.settings = defaultSettings(); }, { reason: 'settings', path: null });
    return getSettings();
  }

  /** bindKey(action, code, {slot, replace}) — assigns code to action, stealing it from any other action. */
  function bindKey(action, code, opts) {
    opts = opts || {};
    if (!ACTIONS.some(function (a) { return a.id === action; }) || typeof code !== 'string' || !code) return null;
    var stolenFrom = null;
    update(function (p) {
      var b = p.settings.controls.bindings;
      Object.keys(b).forEach(function (k) {
        var i = b[k].indexOf(code);
        if (i >= 0 && k !== action) { b[k].splice(i, 1); stolenFrom = k; }
      });
      var list = (b[action] || []).filter(function (c) { return c !== code; });
      if (opts.replace) list = [code];
      else if (opts.slot != null) {
        var slot = clamp(Math.floor(num(opts.slot, 0)), 0, MAX_BINDINGS_PER_ACTION - 1);
        if (slot < list.length) list[slot] = code; else list.push(code);
      } else list.unshift(code);
      b[action] = uniqStrings(list).slice(0, MAX_BINDINGS_PER_ACTION);
    }, { reason: 'settings', path: 'controls.bindings' });
    return { action: action, code: code, stolenFrom: stolenFrom, bindings: getSetting('controls.bindings') };
  }
  function unbindKey(action, code) {
    update(function (p) {
      var b = p.settings.controls.bindings;
      if (b[action]) b[action] = b[action].filter(function (c) { return c !== code; });
    }, { reason: 'settings', path: 'controls.bindings' });
    return getSetting('controls.bindings');
  }
  function resetBindings() {
    update(function (p) {
      p.settings.controls.bindings = defaultBindings();
      p.settings.controls.gamepad.bindings = defaultGamepadBindings();
    }, { reason: 'settings', path: 'controls.bindings' });
    return getSetting('controls.bindings');
  }
  /** Reverse lookup: code → action id (or null). */
  function actionForCode(code, bindings) {
    var b = bindings || ensureLoaded().settings.controls.bindings;
    for (var k in b) if (Array.isArray(b[k]) && b[k].indexOf(code) >= 0) return k;
    return null;
  }
  /** Map code → action for fast input handling. */
  function bindingMap(bindings) {
    var b = bindings || ensureLoaded().settings.controls.bindings, m = {};
    Object.keys(b).forEach(function (k) { (b[k] || []).forEach(function (c) { if (!m[c]) m[c] = k; }); });
    return m;
  }
  var KEY_NAMES = {
    Space: 'Space', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
    AltLeft: 'L-Alt', AltRight: 'R-Alt', MetaLeft: 'L-Cmd', MetaRight: 'R-Cmd',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', CapsLock: 'Caps'
  };
  /** Human label for a KeyboardEvent.code or gamepad binding. */
  function keyLabel(code) {
    if (typeof code !== 'string' || !code) return '—';
    if (KEY_NAMES[code]) return KEY_NAMES[code];
    var m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
    if ((m = /^Digit(\d)$/.exec(code))) return m[1];
    if ((m = /^Numpad(.+)$/.exec(code))) return 'Num ' + m[1];
    if ((m = /^button(\d+)$/.exec(code))) {
      var pad = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'LS', 'RS', 'D-Up', 'D-Down', 'D-Left', 'D-Right', 'Home'];
      return pad[+m[1]] || ('Button ' + m[1]);
    }
    if ((m = /^axis(\d+)([+-]?)$/.exec(code))) {
      var axes = ['Left stick X', 'Left stick Y', 'Right stick X', 'Right stick Y'];
      return (axes[+m[1]] || ('Axis ' + m[1])) + (m[2] ? ' ' + m[2] : '');
    }
    return code;
  }
  /** Settings mapped onto a CB.race.engine.createSession cfg fragment. */
  function raceDefaults(profile) {
    var s = (profile || ensureLoaded()).settings;
    return {
      laps: s.gameplay.defaultLaps, opponents: s.gameplay.defaultOpponents, weather: s.gameplay.weather,
      timeOfDay: s.gameplay.timeOfDay, difficulty: s.difficulty, field: s.gameplay.field,
      assists: { abs: s.assists.abs, tc: s.assists.tc, autoShift: s.assists.autoShift, racingLine: s.assists.racingLine, steeringAssist: s.assists.steeringAssist },
      units: s.units, camera: s.camera
    };
  }

  /* ============================================================ identity */

  function setDriver(name, color) {
    update(function (p) {
      if (name != null) p.driverName = name;
      if (color != null) p.avatarColor = color;
    }, { reason: 'identity' });
    var p = ensureLoaded();
    return { driverName: p.driverName, avatarColor: p.avatarColor };
  }
  function initials(name) {
    var n = String(name || (ensureLoaded().driverName) || 'D').trim().split(/\s+/);
    return ((n[0] || 'D')[0] + (n.length > 1 ? n[n.length - 1][0] : '')).toUpperCase();
  }

  /* ========================================================== import/export */

  function exportJSON(pretty) { return JSON.stringify(ensureLoaded(), null, pretty ? 2 : 0); }
  /** importJSON(json|object) → {ok, error?, migratedFrom?}. Replaces the live profile. */
  function importJSON(data) {
    var parsed = data;
    if (typeof data === 'string') {
      try { parsed = JSON.parse(data); } catch (e) { return { ok: false, error: 'Invalid JSON' }; }
    }
    if (!isObj(parsed)) return { ok: false, error: 'Not a profile object' };
    if (!('credits' in parsed) && !('ownedCars' in parsed) && !('stats' in parsed) && !('money' in parsed) && !('cars' in parsed)) {
      return { ok: false, error: 'Missing profile fields' };
    }
    var res = migrate(parsed);
    var prev = current;
    current = res.profile;
    save();
    emit({ reason: 'import', prev: prev });
    return { ok: true, migratedFrom: res.changed ? res.from : undefined };
  }
  function checksum(profile) { return hashString(JSON.stringify(profile || ensureLoaded())).toString(16); }

  /* ============================================================ testing */

  /** Swap storage backend (tests / embedding). Pass null to re-detect, 'memory' for memory. */
  function _setStorage(s) {
    if (s === 'memory') { memoryStore = createMemoryStorage(); storage = memoryStore; persistent = false; }
    else if (s) { storage = s; persistent = !s._memory; }
    else { storage = null; }
    current = null;
  }
  function _unload() { current = null; draft = null; }

  /* ============================================================== export */

  var api = {
    STORAGE_KEY: STORAGE_KEY, BACKUP_KEY: BACKUP_KEY, VERSION: CURRENT_VERSION, START_CREDITS: START_CREDITS,
    LEDGER_MAX: LEDGER_MAX, MAX_LEVEL: MAX_LEVEL, MAX_CARS: MAX_CARS, ACTIONS: ACTIONS,
    DIFFICULTIES: DIFFICULTIES, UNITS: UNITS, CAMERAS: CAMERAS, QUALITIES: QUALITIES, AVATAR_COLORS: AVATAR_COLORS,
    STAT_KEYS: STAT_KEYS,
    // lifecycle
    load: load, save: save, get: get, peek: peek, update: update, subscribe: subscribe, reset: reset,
    // economy primitives
    addCredits: addCredits, spend: spend, canAfford: canAfford, getLedger: getLedger, ledgerSummary: ledgerSummary,
    addXp: addXp, award: award,
    // level curve
    xpForLevel: xpForLevel, totalXpForLevel: totalXpForLevel, levelForXp: levelForXp, levelInfo: levelInfo, levelTitle: levelTitle,
    // stats
    recordRaceStats: recordRaceStats, summarizeRace: summarizeRace, applyRaceSummary: applyRaceSummary,
    recordStat: recordStat, incStat: incStat, statsSummary: statsSummary,
    // cars
    addCar: addCar, removeCar: removeCar, setActiveCar: setActiveCar, updateCar: updateCar, renameCar: renameCar,
    getCar: getCar, listCars: listCars, activeCar: activeCar,
    // unlocks
    unlock: unlock, hasUnlock: hasUnlock,
    // settings
    defaultSettings: defaultSettings, defaultBindings: defaultBindings, defaultGamepadBindings: defaultGamepadBindings,
    getSettings: getSettings, getSetting: getSetting, setSetting: setSetting, resetSettings: resetSettings,
    bindKey: bindKey, unbindKey: unbindKey, resetBindings: resetBindings, actionForCode: actionForCode,
    bindingMap: bindingMap, keyLabel: keyLabel, raceDefaults: raceDefaults,
    // identity
    setDriver: setDriver, initials: initials,
    // schema
    defaultProfile: defaultProfile, normalize: normalize, migrate: migrate, MIGRATIONS: MIGRATIONS,
    exportJSON: exportJSON, importJSON: importJSON, checksum: checksum,
    isPersistent: function () { backend(); return persistent; },
    lastSaveError: function () { return lastSaveError; },
    _setStorage: _setStorage, _unload: _unload
  };
  /* `ledger` — live view of the last 200 transactions (oldest-first copy). */
  Object.defineProperty(api, 'ledger', {
    enumerable: true,
    get: function () { return clone(ensureLoaded().ledger); }
  });

  CB.game.profile = api;
})();

if (typeof module !== 'undefined') module.exports = CB.game.profile;

/* ==========================================================================
   FORGE Atelier — js/race/race-ui.js
   CB.race.ui : full-screen Race Mode overlay.

   Owns:
     - #race-root overlay (created on demand) + injected <style id="race-styles">
     - screens: setup -> loading/grid -> race (countdown + racing) -> pause -> results
     - the rAF loop with a fixed-step accumulator (session.update at 1/120 s),
       renderer.render(snap, alpha) then hud.draw(ctx, snap), audio.update(snap)
     - input: keyboard, Gamepad API (analog), touch controls on coarse pointers
     - records (per-track best lap per build hash) in localStorage
       'forge.race.records.v1'; settings in 'forge.race.settings.v1'

   Public API (RACE-SPEC "Inter-module contracts"):
     CB.race.ui.open(build, opts?)   opts { onClose(), settings: {...} }
     CB.race.ui.close()
     CB.race.ui.isOpen()
     CB.race.ui.openNet(session, cfg)  multiplayer (NET-SPEC / js/net/lobby.js): runs a CB.net.race session as-is (setup
       locked to it, starts at once, never pauses / restarts, results from the host, name tags over remote cars, ping /
       drivers / sync pill); leaving calls cfg.onClose(results) + session.destroy(). Same as open(build, cfg, {netSession}).
     CB.race.ui.netHooks()   engine hooks (assist preStep) a session creator may pass as cfg.hooks; without them the
       assist is applied to the input before session.update.
   Plus pure helpers (Node-testable) on CB.race.ui._ (fmtTime, buildHash,
   createRecords, createInput, trackStats, normalizeResults, ...).

   Every collaborator is feature-detected at call time: CB.race.tracks,
   .engine, .renderer, .hud, .audio, .ai, .vehicle, CB.physics, CB.render,
   CB.data, CB.state. Missing optional modules degrade gracefully; missing
   required ones (tracks, engine) produce a clear on-screen message.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};

(function () {
  'use strict';

  var hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined' &&
    typeof document.createElement === 'function';

  /* ======================================================================
     Constants
     ====================================================================== */
  var STEP = 1 / 120;
  var MAX_FRAME_DT = 0.25;
  var MAX_SUBSTEPS = 40;
  var LS_RECORDS = 'forge.race.records.v1';
  var LS_SETTINGS = 'forge.race.settings.v1';
  /* arcade session keys (stored in settings.arcade) and the presentation keys an arcade setup may share with Race */
  var ARC_KEYS = ['trackId', 'mode', 'laps', 'opponents', 'difficulty', 'weather', 'timeOfDay'];   // no steerAssist: arcade handling needs none
  var ARC_SHARED = ['camera', 'camera3d', 'graphics', 'quality', 'units', 'muted', 'steerSensitivity', 'invertSteer', 'touchControls', 'showHints'];
  var RESULTS_DELAY_AFTER_PLAYER_FINISH = 9;   // sim seconds before results are forced
  var RESULTS_DELAY_AFTER_SESSION_FINISH = 1.6;
  var FAST_FORWARD_BUDGET_MS = 450;               // wall-clock cap for simulating the rest of the field home

  var MODES = [
    { id: 'race', name: 'Grand Prix', desc: 'Full grid, standing start, penalties live' },
    { id: 'time-trial', name: 'Time Trial', desc: 'Solo hot laps chasing your ghost' },
    { id: 'practice', name: 'Practice', desc: 'Free running, learn the circuit' }
  ];
  var DIFFICULTIES = [
    { id: 'rookie', name: 'Rookie', desc: 'Forgiving, early braking' },
    { id: 'amateur', name: 'Amateur', desc: 'Club racers, some mistakes' },
    { id: 'pro', name: 'Pro', desc: 'Committed, consistent' },
    { id: 'alien', name: 'Alien', desc: 'On the limit, every lap' }
  ];
  var FIELDS = [
    { id: 'similar', name: 'Matched', desc: 'Performance-matched variations of your build' },
    { id: 'presets', name: 'Icons', desc: 'Redline preset legends' },
    { id: 'mixed', name: 'Mixed', desc: 'A bit of everything' }
  ];
  var WEATHERS = [
    { id: 'dry', name: 'Dry', icon: 'sun' },
    { id: 'damp', name: 'Damp', icon: 'cloud' },
    { id: 'wet', name: 'Wet', icon: 'rain' }
  ];
  var TIMES = [
    { id: 'day', name: 'Day', icon: 'sun' },
    { id: 'dusk', name: 'Dusk', icon: 'sunset' },
    { id: 'night', name: 'Night', icon: 'moon' }
  ];
  var CAMERAS = [
    { id: 'chase', name: 'Chase' },
    { id: 'north', name: 'North-up' },
    { id: 'tv', name: 'Broadcast' }
  ];
  /** 3D camera modes (CB.race.renderer3d cycleCamera order). 'map' delegates to the 2D top-down renderer. */
  var CAMERAS_3D = [
    { id: 'cockpit', name: 'Cockpit', desc: 'First person from the driver seat' },
    { id: 'hood', name: 'Hood', desc: 'Bonnet camera' },
    { id: 'bumper', name: 'Bumper', desc: 'Low front-bumper camera' },
    { id: 'chase', name: 'Chase', desc: 'Third person, close' },
    { id: 'chase-far', name: 'Chase far', desc: 'Third person, high and wide' },
    { id: 'tv', name: 'TV', desc: 'Trackside broadcast cameras' },
    { id: 'heli', name: 'Heli', desc: 'High orbiting helicopter view' },
    { id: 'map', name: 'Map', desc: 'Top-down 2D view' }
  ];
  var GRAPHICS = [
    { id: '3d', name: '3D', desc: 'WebGL cockpit & chase cameras' },
    { id: '2d', name: 'Top-down', desc: 'Canvas 2D bird\'s-eye view (lightest)' }
  ];
  var QUALITIES = [
    { id: 'auto', name: 'Auto', desc: 'Picks a tier for this device (high on desktop, low/medium on phones) and steps down if frames run long' },
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Med' },
    { id: 'high', name: 'High' },
    { id: 'ultra', name: 'Ultra' }
  ];
  var UNITS = [
    { id: 'kph', name: 'km/h' },
    { id: 'mph', name: 'mph' }
  ];
  var TOUCH_MODES = [
    { id: 'auto', name: 'Auto' },
    { id: 'on', name: 'On' },
    { id: 'off', name: 'Off' }
  ];
  var ASSISTS = [
    { id: 'abs', name: 'ABS', hint: 'Prevents wheel lock under braking' },
    { id: 'tc', name: 'Traction control', hint: 'Limits wheelspin on exit' },
    { id: 'autoShift', name: 'Automatic gearbox', hint: 'Off: shift with E / Q' },
    { id: 'racingLine', name: 'Racing line', hint: 'Braking-aware driving line overlay' },
    { id: 'steeringAssist', name: 'Steering assist', hint: 'Counter-steer & stability help' }
  ];
  /** First-step discipline choice (DRIFT-SPEC §7): a scored drift session or a classic race. */
  var DISCIPLINES = [
    { id: 'drift', name: 'Drift', icon: 'drift', kicker: 'Style · angle · commitment',
      desc: 'Slide through scored runs: clipping zones, combo chains, swing transitions and tandem battles against an AI lead car.',
      bullets: ['Score attack, free run or tandem', 'Drift tracks: mountain pass, harbour park, skidpad', 'Heavy assist: arrow keys are all you need'] },
    { id: 'race', name: 'Race', icon: 'flag', kicker: 'Wheel to wheel',
      desc: 'Grand prix against a full AI grid, solo time trials chasing your ghost, or open practice on every circuit.',
      bullets: ['Up to 12 cars, four AI skill levels', 'Weather, night racing, penalties', 'Assisted steering, braking and racing line'] }
  ];
  var DRIFT_MODES = [
    { id: 'trial', name: 'Score attack', desc: 'Timed scored run with bronze to platinum targets' },
    { id: 'free', name: 'Free run', desc: 'Endless practice: every slide is scored, no clock' },
    { id: 'tandem', name: 'Tandem', desc: 'Chase an AI lead drifter; stay close for the proximity bonus' }
  ];
  /** CB.race.assist levels (DRIFT-SPEC §1). Each discipline keeps its own level: Light for racing, Heavy for drifting. */
  var STEER_ASSISTS = [
    { id: 'off', name: 'Off', desc: 'You do everything (drifting: keyboard steering still self-aligns with the slide)' },
    { id: 'light', name: 'Light', desc: 'Smoothed steering and slide catching; drifting: release an arrow to hold the angle, tap the other one to switch' },
    { id: 'medium', name: 'Medium', desc: 'Counter-steer help, stability control and braking assist' },
    { id: 'heavy', name: 'Heavy', desc: 'Arrow keys are enough: automatic counter-steer, stability, braking and line help' },
    { id: 'auto', name: 'Auto', desc: 'Heavy, plus the car picks its own lines and drifts: just hold throttle' }
  ];
  var DRIFT_TUNES = [
    { id: 'grip', name: 'Grip', desc: 'Your build as configured, barely touched' },
    { id: 'street', name: 'Street', desc: 'Locked rear diff, more steering lock, power floor for small cars' },
    { id: 'pro', name: 'Pro', desc: 'Pro-am drift spec: big lock, loose rear, quick steering' },
    { id: 'competition', name: 'Comp', desc: 'Full competition drift car: maximum angle and power' }
  ];
  var DRIFT_DURATIONS = [
    { id: '60', name: '60 s' }, { id: '90', name: '90 s' }, { id: '120', name: '2 min' }, { id: '180', name: '3 min' }
  ];
  var MEDAL_COLORS = { bronze: '#c98a4b', silver: '#c9ced6', gold: '#f2c14e', platinum: '#a8e6ff' };

  var DEFAULT_SETTINGS = {
    trackId: null,
    mode: 'race',
    laps: 3,
    opponents: 7,
    difficulty: 'amateur',
    field: 'mixed',
    weather: 'dry',
    timeOfDay: 'day',
    assists: { abs: true, tc: true, autoShift: true, racingLine: false, steeringAssist: false },
    rubberBanding: false,
    camera: 'chase',
    graphics: '3d',
    camera3d: 'cockpit',   // RACE3D-SPEC: first-person cockpit is the default 3D view
    quality: 'auto',
    units: 'kph',
    muted: false,
    steerSensitivity: 1,
    invertSteer: false,
    touchControls: 'auto',
    showHints: true,
    // DRIFT / RACE discipline (first setup step) + CB.race.assist steering level
    discipline: 'race',
    steerAssist: 'light',          // the ACTIVE level (= the current discipline's own level below, or a launch override)
    raceSteerAssist: 'light',      // Race: light by default (the player drives; slides are caught)
    driftSteerAssist: 'heavy',     // Drift: heavy by default (arrow keys are enough)
    assistDefaultsV: 2,            // 2 = per-discipline steering assist (older saves shared one level)
    driftMode: 'trial',
    driftTune: 'street',
    driftDuration: 90,
    driftCamera3d: 'chase',   // DRIFT-SPEC: chase camera is the default for drifting
    raceTrackId: null,
    driftTrackId: null
  };

  /* ======================================================================
     Small pure helpers
     ====================================================================== */
  function clamp(v, a, b) { v = +v; if (v !== v) v = a; return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function approach(cur, target, maxDelta) {
    if (cur < target) return Math.min(target, cur + maxDelta);
    if (cur > target) return Math.max(target, cur - maxDelta);
    return cur;
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  function has(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }
  function pick(list, id, fallbackIdx) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[fallbackIdx || 0];
  }
  function ids(list) { return list.map(function (o) { return o.id; }); }

  function deepClone(o) {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(deepClone);
    var out = {};
    for (var k in o) if (has(o, k)) out[k] = deepClone(o[k]);
    return out;
  }
  function isPlain(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
  function deepMerge(base, src) {
    var out = deepClone(base);
    if (!isPlain(src)) return out;
    for (var k in src) {
      if (!has(src, k)) continue;
      if (isPlain(src[k]) && isPlain(out[k])) out[k] = deepMerge(out[k], src[k]);
      else out[k] = deepClone(src[k]);
    }
    return out;
  }

  /** 83.4567 -> "1:23.457"; >= 1h -> "1:02:03.456" */
  function fmtTime(s, empty) {
    if (!isNum(s) || s < 0) return empty != null ? empty : '--:--.---';
    var ms = Math.round(s * 1000);
    var m = Math.floor(ms / 60000);
    var sec = Math.floor(ms / 1000) % 60;
    var milli = ms % 1000;
    if (m >= 60) return Math.floor(m / 60) + ':' + pad(m % 60, 2) + ':' + pad(sec, 2) + '.' + pad(milli, 3);
    return m + ':' + pad(sec, 2) + '.' + pad(milli, 3);
  }
  /** signed gap: +1.234 / -0.512 / +1:02.345 */
  function fmtGap(s) {
    if (!isNum(s)) return '—';
    var sign = s < 0 ? '−' : '+';
    var a = Math.abs(s);
    if (a >= 60) return sign + fmtTime(a);
    return sign + a.toFixed(3);
  }
  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtLength(m, units) {
    if (!isNum(m)) return '—';
    if (units === 'mph') return (m / 1609.344).toFixed(2) + ' mi';
    return (m / 1000).toFixed(2) + ' km';
  }
  function fmtSpeed(kph, units) {
    if (!isNum(kph)) return '—';
    if (units === 'mph') return Math.round(kph / 1.609344) + ' mph';
    return Math.round(kph) + ' km/h';
  }
  function fmtInt(n) {
    if (!isNum(n)) return '—';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function plural(n, a, b) { return n + ' ' + (n === 1 ? a : (b || a + 's')); }

  /* ----------------------------------------------------------- hashing */
  var HASH_EXCLUDE = { meta: 1, exterior: 1, interior: 1, tech: 1, version: 1 };
  function stableStringify(v) {
    if (v === undefined || typeof v === 'function') return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    var keys = Object.keys(v).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(v[k]); }).join(',') + '}';
  }
  function fnv1a(str, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul ? Math.imul(h, 16777619) >>> 0 : (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }
  /** Hash of the performance-relevant part of a build (cosmetics/meta excluded). */
  function buildHash(build) {
    if (!build || typeof build !== 'object') return 'none';
    var o = {};
    Object.keys(build).forEach(function (k) { if (!HASH_EXCLUDE[k]) o[k] = build[k]; });
    var s = stableStringify(o);
    return fnv1a(s, 0x811c9dc5).toString(36) + fnv1a(s, 0x01000193 ^ 0x5bd1e995).toString(36);
  }

  /* ----------------------------------------------------------- storage */
  function memoryStorage() {
    var m = {};
    return {
      getItem: function (k) { return has(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; }
    };
  }
  function defaultStorage() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        var t = '__forge_race_probe__';
        localStorage.setItem(t, '1'); localStorage.removeItem(t);
        return localStorage;
      }
    } catch (e) { /* private mode / file:// quirks */ }
    return memoryStorage();
  }
  var STORE = null;
  function store() { return STORE || (STORE = defaultStorage()); }
  function lsGet(key, fallback, storage) {
    try {
      var raw = (storage || store()).getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function lsSet(key, val, storage) {
    try { (storage || store()).setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  }

  /* ======================================================================
     Records: { v:1, tracks: { [trackId]: { best: Rec|null, builds: { [hash]: Rec } } } }
     Rec = { time, sectors, date, buildName, buildHash, mode, weather, timeOfDay }
     ====================================================================== */
  function createRecords(storage, key) {
    key = key || LS_RECORDS;
    function load() {
      var d = lsGet(key, null, storage);
      if (!d || typeof d !== 'object' || d.v !== 1 || typeof d.tracks !== 'object' || !d.tracks) d = { v: 1, tracks: {} };
      return d;
    }
    function trackEntry(d, id) {
      var t = d.tracks[id];
      if (!t || typeof t !== 'object') t = d.tracks[id] = { best: null, builds: {} };
      if (!t.builds || typeof t.builds !== 'object') t.builds = {};
      return t;
    }
    return {
      all: load,
      track: function (trackId) {
        var d = load(), t = d.tracks[trackId];
        return t ? { best: t.best || null, builds: t.builds || {} } : { best: null, builds: {} };
      },
      bestFor: function (trackId, hash) {
        var t = load().tracks[trackId];
        return (t && t.builds && t.builds[hash]) || null;
      },
      trackBest: function (trackId) {
        var t = load().tracks[trackId];
        return (t && t.best) || null;
      },
      /** returns {buildBest:bool, trackRecord:bool, prevBuild, prevTrack} */
      submit: function (trackId, hash, rec) {
        var out = { buildBest: false, trackRecord: false, prevBuild: null, prevTrack: null };
        if (!trackId || !rec || !isNum(rec.time) || rec.time <= 0) return out;
        var d = load(), t = trackEntry(d, trackId);
        var entry = {
          time: rec.time,
          sectors: Array.isArray(rec.sectors) ? rec.sectors.slice(0, 3) : null,
          date: rec.date || Date.now(),
          buildName: rec.buildName || 'Untitled Build',
          buildHash: hash,
          mode: rec.mode || 'race',
          weather: rec.weather || 'dry',
          timeOfDay: rec.timeOfDay || 'day'
        };
        var pb = t.builds[hash] || null;
        out.prevBuild = pb; out.prevTrack = t.best || null;
        if (!pb || entry.time < pb.time) { t.builds[hash] = entry; out.buildBest = true; }
        if (!t.best || entry.time < t.best.time) { t.best = entry; out.trackRecord = true; }
        if (out.buildBest || out.trackRecord) lsSet(key, d, storage);
        return out;
      },
      /* drift runs keep their own best SCORES (t.drift = { best, builds }) — never mixed with race lap times */
      driftBestFor: function (trackId, hash) {
        var t = load().tracks[trackId];
        return (t && t.drift && t.drift.builds && t.drift.builds[hash]) || null;
      },
      driftTrackBest: function (trackId) {
        var t = load().tracks[trackId];
        return (t && t.drift && t.drift.best) || null;
      },
      /** returns {buildBest:bool, trackRecord:bool, prevBuild, prevTrack} (higher score = better) */
      submitDrift: function (trackId, hash, rec) {
        var out = { buildBest: false, trackRecord: false, prevBuild: null, prevTrack: null };
        if (!trackId || !rec || !isNum(rec.score) || rec.score <= 0) return out;
        var d = load(), t = trackEntry(d, trackId);
        if (!t.drift || typeof t.drift !== 'object') t.drift = { best: null, builds: {} };
        if (!t.drift.builds || typeof t.drift.builds !== 'object') t.drift.builds = {};
        var entry = { score: Math.round(rec.score), medal: rec.medal || null, date: rec.date || Date.now(),
          buildName: rec.buildName || 'Untitled Build', buildHash: hash, mode: rec.mode || 'trial', assist: rec.assist || null };
        var pb = t.drift.builds[hash] || null;
        out.prevBuild = pb; out.prevTrack = t.drift.best || null;
        if (!pb || entry.score > pb.score) { t.drift.builds[hash] = entry; out.buildBest = true; }
        if (!t.drift.best || entry.score > t.drift.best.score) { t.drift.best = entry; out.trackRecord = true; }
        if (out.buildBest || out.trackRecord) lsSet(key, d, storage);
        return out;
      },
      clearTrack: function (trackId) {
        var d = load(); delete d.tracks[trackId]; lsSet(key, d, storage);
      },
      clearAll: function () { lsSet(key, { v: 1, tracks: {} }, storage); }
    };
  }

  /* ======================================================================
     Settings
     ====================================================================== */
  function sanitizeSettings(s) {
    var o = deepMerge(DEFAULT_SETTINGS, isPlain(s) ? s : {});
    if (ids(MODES).indexOf(o.mode) < 0) o.mode = 'race';
    if (ids(DIFFICULTIES).indexOf(o.difficulty) < 0) o.difficulty = 'amateur';
    if (ids(FIELDS).indexOf(o.field) < 0) o.field = 'mixed';
    if (ids(WEATHERS).indexOf(o.weather) < 0) o.weather = 'dry';
    if (ids(TIMES).indexOf(o.timeOfDay) < 0) o.timeOfDay = 'day';
    if (ids(CAMERAS).indexOf(o.camera) < 0) o.camera = 'chase';
    if (ids(GRAPHICS).indexOf(o.graphics) < 0) o.graphics = '3d';
    if (ids(CAMERAS_3D).indexOf(o.camera3d) < 0) o.camera3d = 'cockpit';
    if (ids(QUALITIES).indexOf(o.quality) < 0) o.quality = 'auto';
    if (ids(UNITS).indexOf(o.units) < 0) o.units = 'kph';
    if (ids(TOUCH_MODES).indexOf(o.touchControls) < 0) o.touchControls = 'auto';
    o.laps = Math.round(clamp(o.laps, 1, 50));
    o.opponents = Math.round(clamp(o.opponents, 1, 11));
    o.steerSensitivity = clamp(o.steerSensitivity, 0.5, 1.6);
    ASSISTS.forEach(function (a) { o.assists[a.id] = !!o.assists[a.id]; });
    o.rubberBanding = !!o.rubberBanding; o.muted = !!o.muted; o.invertSteer = !!o.invertSteer;
    o.showHints = o.showHints !== false;
    if (o.trackId != null && typeof o.trackId !== 'string') o.trackId = null;
    if (ids(DISCIPLINES).indexOf(o.discipline) < 0 && o.discipline !== 'arcade') o.discipline = 'race';   // 'arcade': #/arcade only, never saved
    if (o.arcade != null && !isPlain(o.arcade)) o.arcade = null;
    if (ids(STEER_ASSISTS).indexOf(o.raceSteerAssist) < 0) o.raceSteerAssist = DEFAULT_ASSIST.race;
    if (ids(STEER_ASSISTS).indexOf(o.driftSteerAssist) < 0) o.driftSteerAssist = DEFAULT_ASSIST.drift;
    // active level: an explicit valid one is kept (launch override), else the discipline's own level
    if (!(isPlain(s) && ids(STEER_ASSISTS).indexOf(s.steerAssist) >= 0)) o.steerAssist = o[assistKey(o.discipline) || 'raceSteerAssist'];
    if (ids(DRIFT_MODES).indexOf(o.driftMode) < 0) o.driftMode = 'trial';
    if (ids(DRIFT_TUNES).indexOf(o.driftTune) < 0) o.driftTune = 'street';
    if (ids(CAMERAS_3D).indexOf(o.driftCamera3d) < 0) o.driftCamera3d = 'chase';
    o.driftDuration = Math.round(clamp(o.driftDuration, 30, 600));
    ['raceTrackId', 'driftTrackId'].forEach(function (k) { if (o[k] != null && typeof o[k] !== 'string') o[k] = null; });
    return o;
  }
  /** Per-discipline steering assist: the stored key for a discipline (null for arcade, which keeps its own store). */
  var DEFAULT_ASSIST = { race: 'light', drift: 'heavy' };
  function assistKey(disc) { return disc === 'drift' ? 'driftSteerAssist' : disc === 'race' ? 'raceSteerAssist' : null; }
  /** Make S.steerAssist the current discipline's own level. Mutates S. */
  function syncAssist(S) {
    var k = S && assistKey(S.discipline);
    if (k && ids(STEER_ASSISTS).indexOf(S[k]) >= 0) S.steerAssist = S[k];
    return S;
  }
  /** The player picked a level: it is the active level and the current discipline's remembered one. Mutates S. */
  function setAssist(S, v) {
    if (ids(STEER_ASSISTS).indexOf(v) < 0) return S;
    S.steerAssist = v;
    var k = assistKey(S.discipline);
    if (k) S[k] = v;
    return S;
  }
  /** Saves from before the per-discipline split shared one level whose default was Heavy: a player who never changed it
      gets the new defaults (Race Light, Drift Heavy); a level they explicitly chose (anything but Heavy) is kept for both. */
  function migrateAssist(saved) {
    if (saved.assistDefaultsV === 2) return saved;
    var old = saved.steerAssist != null ? saved.steerAssist : profileAssist();
    var chosen = ids(STEER_ASSISTS).indexOf(old) >= 0 && old !== 'heavy' ? old : null;
    if (saved.raceSteerAssist == null) saved.raceSteerAssist = chosen || DEFAULT_ASSIST.race;
    if (saved.driftSteerAssist == null) saved.driftSteerAssist = chosen || DEFAULT_ASSIST.drift;
    saved.assistDefaultsV = 2;
    return saved;
  }
  /** Key of the 3D camera setting for the discipline (drifting defaults to chase, racing to cockpit). */
  function cam3dKey(S) { return S && S.discipline === 'drift' ? 'driftCamera3d' : 'camera3d'; }
  /** Human label of the session (drift mode name or race mode name). */
  function sessionLabel(S) {
    return S.discipline === 'drift' ? 'Drift · ' + pick(DRIFT_MODES, S.driftMode).name : pick(MODES, S.mode).name;
  }
  /** Switch discipline, keeping a separate remembered circuit for each. Mutates S. */
  function setDiscipline(S, disc) {
    if (ids(DISCIPLINES).indexOf(disc) < 0 || S.discipline === disc) { S.discipline = ids(DISCIPLINES).indexOf(disc) < 0 ? S.discipline : disc; return S; }
    S[S.discipline + 'TrackId'] = S.trackId;
    S.discipline = disc;
    S.trackId = S[disc + 'TrackId'] || null;
    syncAssist(S);   // each discipline keeps its own steering assist level
    return S;
  }
  function loadSettings() {
    var saved = lsGet(LS_SETTINGS, null);
    if (!saved) {
      saved = {};
      try {
        var lang = (typeof navigator !== 'undefined' && navigator.language) || '';
        if (/^en-(US|GB|LR|MM)$/i.test(lang)) saved.units = 'mph';
      } catch (e) { /* ignore */ }
    }
    // one game, one units setting: the profile's (Settings → General) wins over race-ui's own copy
    var pu = profileUnits();
    if (pu) saved.units = pu;
    // per-discipline steering assist (older saves / profiles shared one level, see migrateAssist)
    migrateAssist(saved);
    return syncAssist(sanitizeSettings(saved));
  }
  function profileAssist() {
    var P = profileMod(); if (!P) return null;
    try { var a = P.getSetting('steerAssist'); return /^(off|light|medium|heavy|auto)$/.test(String(a)) ? a : null; } catch (e) { return null; }
  }
  function profileMod() { var P = CB.game && CB.game.profile; return P && typeof P.getSetting === 'function' ? P : null; }
  function profileUnits() {
    var P = profileMod(); if (!P) return null;
    try { var u = P.getSetting('units'); return u === 'mph' || u === 'kph' ? u : null; } catch (e) { return null; }
  }
  function setProfileUnits(v) {
    var P = profileMod(); if (!P || typeof P.setSetting !== 'function' || (v !== 'mph' && v !== 'kph')) return;
    try { if (P.getSetting('units') !== v) P.setSetting('units', v); } catch (e) { /* ignore */ }
  }
  function saveSettings(s) { lsSet(LS_SETTINGS, s); }

  /* ======================================================================
     Build resolution & metrics
     ====================================================================== */
  function fallbackBuild() {
    return {
      version: 1,
      meta: { name: 'Redline GT', id: 'b_race_fallback', created: 0, modified: 0, presetId: null },
      body: { style: 'coupe', chassisMaterial: 'aluminum', wheelbase_mm: 2650, trackWidth_mm: 1600, doors: 2, seats: 2 },
      engine: {
        type: 'ice', layout: 'V8', displacement_l: 4.0, aspiration: 'twin-turbo', boost_bar: 1.2, compression: 10.0,
        fuel: 'premium', redline_rpm: 7500, position: 'front', tune: 'stock', exhaust: 'sport', cooling: 'standard',
        motors: 2, motorPower_kw: 200, battery_kwh: 85, chemistry: 'nmc', voltage: 800, regen: 2
      },
      transmission: { type: 'dct', gears: 7, ratios: [3.8, 2.6, 1.9, 1.45, 1.15, 0.95, 0.78], finalDrive: 3.42, launchControl: true },
      drivetrain: {
        layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'none', torqueSplitFront_pct: 0,
        torqueVectoring: false, tractionControl: 2
      },
      suspension: {
        type: 'double-wishbone', springFront_nmm: 60, springRear_nmm: 70, damping: 5, rideHeight_mm: 120,
        camberFront_deg: -1.5, camberRear_deg: -1.0, toeFront_deg: 0.0, toeRear_deg: 0.1, arbFront: 5, arbRear: 4
      },
      brakes: { material: 'iron', frontRotor_mm: 360, rearRotor_mm: 330, frontPistons: 6, rearPistons: 4, abs: 'sport' },
      wheels: {
        design: 'y-spoke', material: 'cast', diameter_in: 19, widthFront_in: 9.0, widthRear_in: 10.5,
        finish: '#2b2b2b', staggered: true
      },
      tires: { compound: 'performance', widthFront_mm: 255, widthRear_mm: 295, profileFront: 35, profileRear: 30 },
      aero: {
        splitter: 'lip', wing: 'none', wingAngle_deg: 6, diffuser: 'mild', canards: false, sideSkirts: true, activeAero: false
      },
      weight: {
        soundDeadening: true, rearSeats: true, spareTire: false, glass: 'standard', battery: 'lead', rollCage: 'none',
        ballast_kg: 0, ballastPosition: 'center'
      },
      exterior: {
        paint: '#b3121f', finish: 'metallic', roof: 'body', roofColor: '#111111', stripe: 'none', stripeColor: '#ffffff',
        caliperColor: '#f2c200', windowTint_pct: 20, lights: 'led', mirrors: 'body', badge: 'chrome', livery_number: ''
      },
      interior: {
        seatType: 'sport', upholstery: 'leather', primaryColor: '#1a1a1a', accentColor: '#b3121f', stitchColor: '#b3121f',
        trim: 'aluminum', steering: 'round', headliner: 'alcantara', ambientLighting: true, ambientColor: '#ff3344', harness: false
      },
      tech: {
        screen_in: 12, digitalCluster: true, hud: false, audio: 'premium', adas: 'assist', climateZones: 2,
        telemetry: false, liftSystem: false, nightVision: false
      }
    };
  }

  function presetBuild(index) {
    try {
      var D = CB.data;
      if (D && Array.isArray(D.presets) && D.presets.length) {
        var p = D.presets[index || 0];
        var base = typeof D.defaultBuild === 'function' ? D.defaultBuild() : fallbackBuild();
        var b = deepMerge(base, (p && p.build) || {});
        b.meta = b.meta || {};
        if (p && p.name && (!b.meta.name || b.meta.name === 'Untitled Build')) b.meta.name = p.name;
        b.meta.presetId = p && p.id;
        return b;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /** Accepts whatever the caller hands us and returns a complete, independent build. */
  function resolveBuild(build) {
    var b = null;
    if (isPlain(build) && build.engine && build.body) b = deepClone(build);
    if (!b) {
      try { if (CB.state && typeof CB.state.get === 'function') { var s = CB.state.get(); if (isPlain(s) && s.engine) b = deepClone(s); } } catch (e) { /* ignore */ }
    }
    if (!b) {
      try { if (CB.data && typeof CB.data.defaultBuild === 'function') b = CB.data.defaultBuild(); } catch (e2) { /* ignore */ }
    }
    if (!b) b = presetBuild(0);
    if (!b) b = fallbackBuild();
    // fill any holes from the reference shape so downstream modules never see undefined sections
    b = deepMerge(fallbackBuild(), b);
    try { if (CB.state && typeof CB.state.normalize === 'function') { var n = CB.state.normalize(b); if (isPlain(n) && n.engine) b = n; } } catch (e3) { /* ignore */ }
    if (isPlain(build) && isPlain(build.f1) && !b.f1) { b.f1 = deepClone(build.f1); if (build.body && b.body) b.body.model = build.body.model; }   // F1 (docs/F1-SPEC.md): normalize drops the team block + 'f1-2026' model
    return b;
  }

  function dataFind(collection, id) {
    try {
      var D = CB.data;
      if (!D) return null;
      if (typeof D.find === 'function') { var r = D.find(collection, id); if (r) return r; }
      var parts = collection.split('.'), arr = D;
      for (var i = 0; i < parts.length; i++) arr = arr && arr[parts[i]];
      if (Array.isArray(arr)) for (var j = 0; j < arr.length; j++) if (arr[j] && arr[j].id === id) return arr[j];
    } catch (e) { /* ignore */ }
    return null;
  }

  var BODY_WEIGHTS = { coupe: 1450, sedan: 1550, hatchback: 1250, wagon: 1600, suv: 2000, roadster: 1300, pickup: 2100, hypercar: 1300, 'shooting-brake': 1550, van: 2200 };
  var ASP_MULT = { na: 1, turbo: 1.32, 'twin-turbo': 1.4, 'quad-turbo': 1.58, supercharged: 1.3, twincharged: 1.48, 'electric-turbo': 1.42 };
  var TUNE_MULT = { eco: 0.9, stock: 1, stage1: 1.12, stage2: 1.24, stage3: 1.38, 'time-attack': 1.5 };

  /** Rough metrics straight from the build when CB.physics is unavailable. */
  function estimateMetrics(b) {
    b = b || fallbackBuild();
    var e = b.engine || {}, body = b.body || {}, dt = b.drivetrain || {};
    var ice = 0, elec = 0;
    if (e.type !== 'ev') {
      var disp = clamp(e.displacement_l || 3, 0.6, 9);
      var boost = e.aspiration === 'na' ? 0 : clamp(e.boost_bar || 1, 0, 3);
      var asp = ASP_MULT[e.aspiration] || 1;
      ice = disp * 78 * Math.pow(clamp(e.compression || 10, 8, 14) / 10, 0.35) * (asp + boost * 0.18) *
        (TUNE_MULT[e.tune] || 1) * Math.pow(clamp(e.redline_rpm || 7000, 4500, 9500) / 7000, 0.6);
      if (e.fuel === 'diesel') ice *= 0.72;
      if (e.fuel === 'e85' || e.fuel === 'race') ice *= 1.06;
    }
    if (e.type === 'ev' || e.type === 'hybrid') {
      elec = clamp(e.motors || 1, 1, 4) * clamp(e.motorPower_kw || 150, 30, 500) * 1.341 * (e.type === 'hybrid' ? 0.75 : 1);
    }
    var hp = Math.max(60, ice + elec);
    var bs = dataFind('bodyStyles', body.style);
    var w = (bs && isNum(bs.baseWeight_kg)) ? bs.baseWeight_kg : (BODY_WEIGHTS[body.style] || 1500);
    var cm = dataFind('chassisMaterials', body.chassisMaterial);
    if (cm && isNum(cm.weightFactor)) w *= cm.weightFactor;
    if (e.type === 'ev') w += clamp(e.battery_kwh || 80, 20, 220) * 5.6 - 150;
    if (e.type === 'hybrid') w += 120;
    var wt = b.weight || {};
    if (wt.rollCage === 'half') w += 18; else if (wt.rollCage === 'full') w += 40;
    if (wt.soundDeadening === false) w -= 25;
    if (wt.rearSeats === false) w -= 22;
    w += clamp(wt.ballast_kg || 0, 0, 100);
    w = Math.max(700, w);
    var kgPerHp = w / hp;
    var floor = dt.layout === 'awd' ? 2.0 : dt.layout === 'fwd' ? 3.6 : 2.7;
    var compound = (b.tires && b.tires.compound) || 'performance';
    if (compound === 'slick' || compound === 'track') floor *= 0.88;
    var z60 = Math.max(floor, 1.75 * Math.pow(kgPerHp, 0.75));
    var cd = (bs && isNum(bs.cd)) ? bs.cd : 0.32, fa = (bs && isNum(bs.frontalArea_m2)) ? bs.frontalArea_m2 : 2.0;
    var P = hp * 745.7 * 0.86;
    var vmax = Math.pow(2 * P / (1.2 * cd * fa), 1 / 3) * 3.6;
    vmax = Math.min(vmax, 440);
    return {
      power_hp: hp, power_kw: hp / 1.341, torque_nm: hp * 1.35, weight_kg: w,
      zeroTo60_s: z60, zeroTo100_s: z60 * 1.07, topSpeed_kph: vmax, topSpeed_mph: vmax / 1.609344,
      powerToWeight_hpPerTon: hp / (w / 1000), redlineRpm: e.redline_rpm || 7000, estimated: true
    };
  }

  function computeMetrics(build) {
    try {
      if (CB.physics && typeof CB.physics.compute === 'function') {
        var m = CB.physics.compute(build);
        if (m && isNum(m.power_hp)) return { m: m, estimated: false };
      }
    } catch (e) { if (typeof console !== 'undefined') console.warn('[race-ui] CB.physics.compute failed', e); }
    return { m: estimateMetrics(build), estimated: true };
  }

  function engineLabel(b) {
    var e = (b && b.engine) || {};
    if (e.type === 'ev') return 'Electric · ' + (e.motors || 1) + '×' + (e.motorPower_kw || 0) + ' kW';
    var asp = dataFind('aspirations', e.aspiration);
    var s = (isNum(e.displacement_l) ? e.displacement_l.toFixed(1) + 'L ' : '') + (e.layout || '') +
      (e.aspiration && e.aspiration !== 'na' ? ' ' + ((asp && asp.name) || e.aspiration) : '');
    if (e.type === 'hybrid') s += ' hybrid';
    return s.trim();
  }
  function nameOf(collection, id) { var o = dataFind(collection, id); return (o && o.name) || (id ? String(id) : '—'); }

  /* ======================================================================
     Track helpers (pure): spline, stats, corner detection, minimap drawing
     ====================================================================== */
  function ptXY(p) {
    if (Array.isArray(p)) return [+p[0], +p[1]];
    if (p && typeof p === 'object') return [+p.x, +p.y];
    return [0, 0];
  }

  /** Closed centripetal Catmull-Rom (Barry-Goldman), `segs` samples per span. */
  function catmullRomClosed(points, segs) {
    var pts = (points || []).map(ptXY).filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); });
    var n = pts.length, out = [];
    if (n < 3) return pts;
    segs = segs || 10;
    function tj(ti, a, b) { var dx = b[0] - a[0], dy = b[1] - a[1]; return ti + Math.max(1e-4, Math.pow(dx * dx + dy * dy, 0.25)); }
    for (var i = 0; i < n; i++) {
      var p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      var t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
      for (var j = 0; j < segs; j++) {
        var t = lerp(t1, t2, j / segs);
        var a1x = (t1 - t) / (t1 - t0) * p0[0] + (t - t0) / (t1 - t0) * p1[0];
        var a1y = (t1 - t) / (t1 - t0) * p0[1] + (t - t0) / (t1 - t0) * p1[1];
        var a2x = (t2 - t) / (t2 - t1) * p1[0] + (t - t1) / (t2 - t1) * p2[0];
        var a2y = (t2 - t) / (t2 - t1) * p1[1] + (t - t1) / (t2 - t1) * p2[1];
        var a3x = (t3 - t) / (t3 - t2) * p2[0] + (t - t2) / (t3 - t2) * p3[0];
        var a3y = (t3 - t) / (t3 - t2) * p2[1] + (t - t2) / (t3 - t2) * p3[1];
        var b1x = (t2 - t) / (t2 - t0) * a1x + (t - t0) / (t2 - t0) * a2x;
        var b1y = (t2 - t) / (t2 - t0) * a1y + (t - t0) / (t2 - t0) * a2y;
        var b2x = (t3 - t) / (t3 - t1) * a2x + (t - t1) / (t3 - t1) * a3x;
        var b2y = (t3 - t) / (t3 - t1) * a2y + (t - t1) / (t3 - t1) * a3y;
        out.push([(t2 - t) / (t2 - t1) * b1x + (t - t1) / (t2 - t1) * b2x, (t2 - t) / (t2 - t1) * b1y + (t - t1) / (t2 - t1) * b2y]);
      }
    }
    return out;
  }

  function polyLength(poly) {
    var L = 0;
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      L += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return L;
  }

  /** Resample a closed polyline at fixed spacing. */
  function resampleClosed(poly, step) {
    var out = [], n = poly.length;
    if (n < 2) return poly.slice();
    var carry = 0;
    out.push(poly[0].slice());
    for (var i = 0; i < n; i++) {
      var a = poly[i], b = poly[(i + 1) % n];
      var seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (seg <= 1e-9) continue;
      var d = step - carry;
      while (d <= seg) {
        var t = d / seg;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        d += step;
      }
      carry = seg - (d - step);
    }
    if (out.length > 2) {
      var f = out[0], l = out[out.length - 1];
      if (Math.hypot(f[0] - l[0], f[1] - l[1]) < step * 0.5) out.pop();
    }
    return out;
  }

  function wrapAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

  /** Count corners: contiguous runs with radius < 190 m and >= 22 deg total turn. */
  function countCorners(poly) {
    var step = 5, rs = resampleClosed(poly, step), n = rs.length;
    if (n < 12) return 0;
    var hd = new Array(n), k = new Array(n), W = 4, i;
    for (i = 0; i < n; i++) {
      var a = rs[i], b = rs[(i + 1) % n];
      hd[i] = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
    for (i = 0; i < n; i++) k[i] = wrapAngle(hd[(i + W) % n] - hd[(i - W + n) % n]) / (2 * W * step);
    var thr = 1 / 190, start = -1;
    for (i = 0; i < n; i++) if (Math.abs(k[i]) < thr) { start = i; break; }
    if (start < 0) return Math.max(1, Math.round(Math.abs(sumTurn(hd)) / (Math.PI / 2)));
    var count = 0, inC = false, sign = 0, turn = 0, gap = 0;
    for (var c = 0; c <= n; c++) {
      var idx = (start + c) % n, kk = k[idx];
      var on = Math.abs(kk) >= thr;
      var sg = kk > 0 ? 1 : -1;
      if (on && (!inC || (sg !== sign && Math.abs(turn) > 0.2))) {
        if (inC && Math.abs(turn) >= 22 * Math.PI / 180) count++;
        if (!inC || sg !== sign) { inC = true; sign = sg; turn = 0; }
        gap = 0;
      }
      if (on) { turn += wrapAngle(hd[(idx + 1) % n] - hd[idx]); gap = 0; }
      else if (inC) {
        gap++;
        if (gap > 3) { if (Math.abs(turn) >= 22 * Math.PI / 180) count++; inC = false; turn = 0; }
      }
    }
    if (inC && Math.abs(turn) >= 22 * Math.PI / 180) count++;
    return count;
  }
  function sumTurn(hd) { var s = 0; for (var i = 0; i < hd.length; i++) s += wrapAngle(hd[(i + 1) % hd.length] - hd[i]); return s; }

  var TRACK_STATS_CACHE = {};
  function trackStats(def) {
    if (!def) return null;
    var key = (def.id || '') + ':' + ((def.points && def.points.length) || 0);
    if (TRACK_STATS_CACHE[key]) return TRACK_STATS_CACHE[key];
    var poly = catmullRomClosed(def.points || [], 12);
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    poly.forEach(function (p) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    });
    var len = polyLength(poly);
    var st = {
      poly: poly,
      length_m: isNum(def.length_m) && def.length_m > 0 ? def.length_m : len,
      polyLength: len,
      corners: isNum(def.corners) ? def.corners : (Array.isArray(def.corners) ? def.corners.length : countCorners(poly)),
      bounds: { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: maxX - minX, h: maxY - minY }
    };
    TRACK_STATS_CACHE[key] = st;
    return st;
  }

  /* ======================================================================
     Input manager (DOM-free core; DOM wiring happens in attach())
     steer output convention: value fed to vehicle; `leftSign` is the steer
     value that turns the car LEFT (CCW). Determined by a runtime probe of
     CB.race.vehicle (see probeLeftSign) and flippable via invertSteer.
     ====================================================================== */
  var KEYMAP = {
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    Space: 'handbrake', KeyB: 'lookBack'
  };
  var ACTIONMAP = {
    KeyE: 'shiftUp', ShiftLeft: 'shiftUp', ShiftRight: 'shiftUp',
    KeyQ: 'shiftDown', ControlLeft: 'shiftDown', ControlRight: 'shiftDown',
    KeyC: 'camera', KeyP: 'pause', Escape: 'pause', KeyR: 'reset', KeyM: 'mute'
  };

  /* Player key bindings ({action: [codes]}, CB.game.profile settings.controls.bindings shape) -> race key maps.
     Escape always pauses; unbound defaults stay available only if the player did not reassign the key. */
  var HELD_ACTIONS = { throttle: 'up', brake: 'down', steerLeft: 'left', steerRight: 'right', handbrake: 'handbrake', lookBack: 'lookBack' };
  var EDGE_ACTIONS = { shiftUp: 'shiftUp', shiftDown: 'shiftDown', camera: 'camera', pause: 'pause', reset: 'reset', mute: 'mute', pit: 'pit' };
  function profileBindings() {
    try {
      var P = CB.game && CB.game.profile;
      var p = P && typeof P.get === 'function' ? P.get() : null;
      var b = p && p.settings && p.settings.controls && p.settings.controls.bindings;
      return b && typeof b === 'object' ? b : null;
    } catch (e) { return null; }
  }
  function buildKeymaps(bindings) {
    if (!bindings || typeof bindings !== 'object') return { held: KEYMAP, action: ACTIONMAP };
    var held = {}, action = {}, any = false;
    Object.keys(bindings).forEach(function (a) {
      var codes = Array.isArray(bindings[a]) ? bindings[a] : (typeof bindings[a] === 'string' ? [bindings[a]] : []);
      codes.forEach(function (c) {
        if (typeof c !== 'string' || !c) return;
        if (HELD_ACTIONS[a]) { held[c] = HELD_ACTIONS[a]; any = true; }
        else if (EDGE_ACTIONS[a]) { action[c] = EDGE_ACTIONS[a]; any = true; }
      });
    });
    if (!any) return { held: KEYMAP, action: ACTIONMAP };
    if (!held.Escape) action.Escape = 'pause';
    if (!held.KeyB && !action.KeyB && !has(bindings, 'lookBack')) held.KeyB = 'lookBack';
    if (!held.KeyM && !action.KeyM) action.KeyM = 'mute';
    return { held: held, action: action };
  }

  /** Settings → Driving "Gamepad stick" (js/input/sources.js): proportional (default) unless set to digital (classic). */
  function gamepadProportional() {
    var SS = CB.input && CB.input.sources;
    try { return !SS || typeof SS.gamepadProportional !== 'function' || SS.gamepadProportional(); } catch (e) { return true; }
  }
  function createInput(opts) {
    opts = opts || {};
    var maps = buildKeymaps(opts.bindings || (opts.settings && opts.settings.bindings) || profileBindings());
    var I = {
      settings: opts.settings || DEFAULT_SETTINGS,
      onAction: opts.onAction || function () {},
      leftSign: 1,
      held: { up: false, down: false, left: false, right: false, handbrake: false, lookBack: false },
      tapped: {},   // keys pressed since the last sample (a quick tap released before the next sim step still counts once)
      kb: { steer: 0, throttle: 0, brake: 0 },
      gp: { index: -1, id: '', steer: 0, throttle: 0, brake: 0, handbrake: false, prev: [], active: false, lastActive: 0 },
      touch: { steer: 0, throttle: 0, brake: 0, handbrake: false, active: false },
      ext: { steer: 0, throttle: 0, brake: 0, handbrake: false, active: false, source: null },   // CB.input.hub (phone tilt / phone wheel)
      pendingUp: false, pendingDown: false,
      lastDevice: 'keyboard',
      last: { throttle: 0, brake: 0, steer: 0, handbrake: false, shiftUp: false, shiftDown: false },
      enabled: true
    };

    /** returns true if the key was consumed */
    I.handleKey = function (code, down, repeat) {
      if (!I.enabled) return false;
      var k = maps.held[code];
      if (k) { I.held[k] = !!down; if (down) { I.tapped[k] = true; I.lastDevice = 'keyboard'; } return true; }
      var a = maps.action[code];
      if (a) {
        if (down && !repeat) {
          I.lastDevice = 'keyboard';
          if (a === 'shiftUp') I.pendingUp = true;
          else if (a === 'shiftDown') I.pendingDown = true;
          else if (a === 'pit') I.pendingPit = true;
          else I.onAction(a);
        }
        return true;
      }
      return false;
    };
    I.clearHeld = function () {
      for (var k in I.held) I.held[k] = false;
      I.tapped = {};
      I.kb.throttle = 0; I.kb.brake = 0;
    };
    I.reset = function () {
      I.clearHeld(); I.kb.steer = 0; I.pendingUp = I.pendingDown = false;
      I.touch.steer = I.touch.throttle = I.touch.brake = 0; I.touch.handbrake = false;
      I.ext.steer = I.ext.throttle = I.ext.brake = 0; I.ext.handbrake = false;
    };
    /* Analog phone sources (js/input/analog.js CB.input.hub, +1 = right there): continuous steer + pedals. When the source
       drops (phone disconnected / sensor stalled) the hub reports inactive -> steering centres, throttle lifts. */
    I.pollExt = function () {
      var X = I.ext, hub = CB.input && CB.input.hub, r = null;
      if (hub && typeof hub.read === 'function') { try { r = hub.read(); } catch (e) { r = null; } }
      if (!r || !r.active || !I.enabled) { X.active = false; X.steer = X.throttle = X.brake = 0; X.handbrake = false; X.source = null; return; }
      X.active = true; X.source = r.source;
      X.steer = clamp(-(+r.steer || 0), -1, 1); X.throttle = clamp(+r.throttle || 0, 0, 1); X.brake = clamp(+r.brake || 0, 0, 1); X.handbrake = !!r.handbrake;
      if (Math.abs(X.steer) > 0.05 || X.throttle > 0.05 || X.brake > 0.05) I.lastDevice = r.source === 'wheel' ? 'phone' : r.source || 'tilt';
    };
    /** Edge events from the phone (shift, pause, camera, reset) -> the same actions as keys. Polled every frame, even paused. */
    I.pollExtEvents = function () {
      var hub = CB.input && CB.input.hub;
      if (!hub || typeof hub.takeEvents !== 'function') return;
      var evs; try { evs = hub.takeEvents(); } catch (e) { return; }
      (evs || []).forEach(function (e) {
        if (!e || !I.enabled) return;
        if (e.type === 'shiftUp') I.pendingUp = true;
        else if (e.type === 'shiftDown') I.pendingDown = true;
        else if (e.type === 'pause' || e.type === 'camera' || e.type === 'reset' || e.type === 'confirm' || e.type === 'menuUp' || e.type === 'menuDown') I.onAction(e.type);
      });
    };
    I.queueShift = function (dir) { if (dir > 0) I.pendingUp = true; else I.pendingDown = true; };

    /** Arcade sessions: the key-steering rates of the arcade model (CB.race.vehicle.ARCADE.keys), else null. */
    function arcadeKeyShape(s) {
      if (!s || s.discipline !== 'arcade') return null;
      var A = CB.race && CB.race.vehicle && CB.race.vehicle.ARCADE;
      return (A && A.keys) || { rateIn: 10, rateOut: 14, rateFlip: 18 };
    }
    /** Speed-sensitive, rate-limited digital steering + source blending. */
    I.sample = function (dt, speed) {
      var s = I.settings, sens = clamp(s.steerSensitivity || 1, 0.5, 1.6);
      speed = Math.abs(speed || 0);
      var h = I.held, tp = I.tapped;
      if (tp.up || tp.down || tp.left || tp.right || tp.handbrake) {
        h = { up: h.up || !!tp.up, down: h.down || !!tp.down, left: h.left || !!tp.left, right: h.right || !!tp.right, handbrake: h.handbrake || !!tp.handbrake, lookBack: h.lookBack };
      }
      I.tapped = {};
      var target = (h.left ? 1 : 0) - (h.right ? 1 : 0);       // +1 = left
      var hi = smoothstep(4, 72, speed);
      var limit = clamp(lerp(1, 0.5, hi) * lerp(0.85, 1.15, (sens - 0.5) / 1.1), 0.2, 1);
      var cur = I.kb.steer, rate;
      var AK = arcadeKeyShape(s);
      if (AK) {
        // ARCADE: full lock already IS the cornering limit at every speed (vehicle.js arcadeCurvatureLimit), so no
        // speed-dependent lock cut and no assist layer: ~100 ms to full lock, quick centering and direction flips
        hi = 0; limit = 1;
        rate = target === 0 ? AK.rateOut : cur !== 0 && (target > 0) !== (cur > 0) ? AK.rateFlip : AK.rateIn * lerp(0.8, 1.2, (sens - 0.5) / 1.1);
      } else if (target === 0) rate = 5.5 + 2 * hi;                            // self-centering
      else if (cur !== 0 && (target > 0) !== (cur > 0)) rate = 9;                // fast direction change
      else rate = (3.1 * sens) * lerp(1, 0.62, hi);                              // build-up
      I.kb.steer = approach(cur, target * limit, rate * dt);
      I.kb.throttle = approach(I.kb.throttle, h.up ? 1 : 0, (h.up ? 7.5 : 12) * dt);
      I.kb.brake = approach(I.kb.brake, h.down ? 1 : 0, (h.down ? 9 : 14) * dt);

      var steerL = I.kb.steer;
      I.pollExt();
      var X = I.ext, kbSteering = !!(h.left || h.right) || Math.abs(I.kb.steer) > 0.02;
      var extSteer = X.active && !kbSteering;                  // keys override the phone while held
      if (extSteer) steerL = X.steer * lerp(1, 0.72, hi);
      if (I.gp.active && Math.abs(I.gp.steer) > 0.015) steerL = I.gp.steer * lerp(1, 0.72, hi) * lerp(0.9, 1.1, (sens - 0.5) / 1.1);
      if (I.touch.active && Math.abs(I.touch.steer) > 0.01) steerL = I.touch.steer * clamp(lerp(1, 0.6, hi), 0.3, 1);
      var sign = I.leftSign * (s.invertSteer ? -1 : 1);
      var out = {
        throttle: clamp(Math.max(I.kb.throttle, I.gp.active ? I.gp.throttle : 0, I.touch.throttle, X.throttle), 0, 1),
        brake: clamp(Math.max(I.kb.brake, I.gp.active ? I.gp.brake : 0, I.touch.brake, X.brake), 0, 1),
        steer: clamp(steerL * sign, -1, 1),
        handbrake: !!(h.handbrake || I.gp.handbrake || I.touch.handbrake || X.handbrake),
        shiftUp: I.pendingUp,
        shiftDown: I.pendingDown,
        pit: !!I.pendingPit
      };
      I.pendingUp = I.pendingDown = false; I.pendingPit = false;
      I.last = out;
      // Raw driver intent for CB.race.assist (DRIFT-SPEC §1): digital keys + analog axes (+1 = left), before smoothing.
      var inv = !!s.invertSteer;
      var intent = {
        left: !!(inv ? h.right : h.left), right: !!(inv ? h.left : h.right), up: !!h.up, down: !!h.down,
        handbrake: out.handbrake, shiftUp: out.shiftUp, shiftDown: out.shiftDown, pit: out.pit
      };
      var axisSign = inv ? -1 : 1;
      if (I.gp.active && Math.abs(I.gp.steer) > 0.015) {
        intent.steerAxis = clamp(I.gp.steer * axisSign, -1, 1);
        // Settings "Gamepad stick: proportional" (default, CB.input.sources): the assist follows the stick's magnitude at
        // every level (no line pick); 'digital' keeps the classic arrow-key-like reading under Heavy / Auto
        if (gamepadProportional()) { intent.steerAnalog = true; intent.steerSource = 'gamepad'; }
      } else if (I.touch.active && Math.abs(I.touch.steer) > 0.01) intent.steerAxis = clamp(I.touch.steer * axisSign, -1, 1);
      // phone tilt / wheel: a continuous wheel angle; steerAnalog tells CB.race.assist to steer proportionally (no line pick)
      else if (extSteer) { intent.steerAxis = clamp(X.steer * axisSign, -1, 1); intent.steerAnalog = true; intent.steerSource = X.source; }
      var thrAxis = Math.max(I.gp.active ? I.gp.throttle : 0, I.touch.active ? I.touch.throttle : 0, X.throttle);
      var brkAxis = Math.max(I.gp.active ? I.gp.brake : 0, I.touch.active ? I.touch.brake : 0, X.brake);
      if (thrAxis > 0.02 && !h.up) intent.throttleAxis = clamp(thrAxis, 0, 1);
      if (brkAxis > 0.02 && !h.down) intent.brakeAxis = clamp(brkAxis, 0, 1);
      I.lastIntent = intent;
      return out;
    };
    /** Sample once and return the raw intent (keys + axes) instead of the smoothed engine input. */
    I.sampleIntent = function (dt, speed) { I.sample(dt, speed); return I.lastIntent; };

    /* ---------------- Gamepad (standard mapping; fallback for others) */
    function shapeAxis(x, dz) {
      var a = Math.abs(x);
      if (a < dz) return 0;
      var t = (a - dz) / (1 - dz);
      t = 0.35 * t + 0.65 * t * t * (t < 1 ? 1 : 1);
      return (x < 0 ? -1 : 1) * clamp(t, 0, 1);
    }
    function btn(gp, i) {
      var b = gp.buttons && gp.buttons[i];
      if (!b) return 0;
      return typeof b === 'object' ? (b.value || (b.pressed ? 1 : 0)) : (b ? 1 : 0);
    }
    I.pollGamepad = function (now) {
      I.pollExtEvents();
      var nav = typeof navigator !== 'undefined' ? navigator : null;
      if (!nav || typeof nav.getGamepads !== 'function') return;
      var pads;
      try { pads = nav.getGamepads(); } catch (e) { return; }
      var gp = null;
      if (pads) {
        if (I.gp.index >= 0 && pads[I.gp.index] && pads[I.gp.index].connected !== false) gp = pads[I.gp.index];
        else for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) { gp = pads[i]; I.gp.index = i; break; }
      }
      if (!gp) { I.gp.active = false; I.gp.index = -1; return; }
      I.gp.id = gp.id || 'Gamepad';
      var std = gp.mapping === 'standard';
      var ax = gp.axes || [];
      var steer = -shapeAxis(ax[0] || 0, 0.07);
      var thr, brk;
      if (std) { thr = btn(gp, 7); brk = btn(gp, 6); }
      else { var y = ax[1] || 0; thr = Math.max(0, -y); brk = Math.max(0, y); }
      // right stick vertical as alternative pedals (some players prefer)
      if (std && ax.length > 3) { var ry = ax[3] || 0; if (Math.abs(ry) > 0.25) { thr = Math.max(thr, Math.max(0, -ry)); brk = Math.max(brk, Math.max(0, ry)); } }
      var hb = btn(gp, 0) > 0.5;
      var pressed = [];
      for (var b = 0; b < 17; b++) pressed[b] = btn(gp, b) > 0.5;
      var prev = I.gp.prev;
      function edge(i) { return pressed[i] && !prev[i]; }
      if (edge(5) || edge(1)) I.pendingUp = true;
      if (edge(4) || edge(2)) I.pendingDown = true;
      if (edge(3)) I.onAction('camera');
      if (edge(9)) I.onAction('pause');
      if (edge(8)) I.onAction('reset');
      if (edge(12)) I.onAction('menuUp');
      if (edge(13)) I.onAction('menuDown');
      if (edge(0)) I.onAction('confirm');
      I.gp.prev = pressed;
      var anyInput = Math.abs(steer) > 0.05 || thr > 0.05 || brk > 0.05 || hb || pressed.some(Boolean);
      if (anyInput) { I.gp.lastActive = now || 0; I.lastDevice = 'gamepad'; }
      I.gp.active = true;
      I.gp.steer = steer; I.gp.throttle = clamp(thr, 0, 1); I.gp.brake = clamp(brk, 0, 1); I.gp.handbrake = hb;
    };
    return I;
  }

  /** Determine which steer sign turns the car left (CCW) using the vehicle model itself. */
  function probeLeftSign(build, metrics) {
    try {
      var V = CB.race && CB.race.vehicle;
      if (!V || typeof V.fromBuild !== 'function' || typeof V.createState !== 'function' || typeof V.step !== 'function') return 1;
      if (isNum(V.STEER_LEFT_SIGN)) return V.STEER_LEFT_SIGN < 0 ? -1 : 1;
      var p = V.fromBuild(build, metrics || null);
      var st = V.createState(p, { x: 0, y: 0, heading: 0 });
      if (!st || !isNum(st.heading)) return 1;
      var h0 = st.heading, inp = { throttle: 0.7, brake: 0, steer: 1, handbrake: false, shiftUp: false, shiftDown: false };
      var env = { gripMult: 1, wet: false };
      for (var i = 0; i < 150; i++) {
        var r = V.step(p, st, inp, STEP, env);
        if (r && typeof r === 'object' && isNum(r.heading)) st = r;
      }
      var dh = wrapAngle(st.heading - h0);
      if (Math.abs(dh) < 1e-4) return 1;
      return dh > 0 ? 1 : -1;
    } catch (e) { return 1; }
  }

  /* ======================================================================
     Lap tracker (pure): per-car lap list, top speed, positions per lap
     ====================================================================== */
  function createLapTracker() {
    var T = { cars: {}, gridOrder: null };
    T.reset = function () { T.cars = {}; T.gridOrder = null; };
    /** returns array of {carId, isPlayer, lap, time, valid, sectors} for laps completed since last update */
    T.update = function (snap) {
      var done = [];
      if (!snap || !Array.isArray(snap.cars)) return done;
      if (!T.gridOrder) {
        T.gridOrder = {};
        snap.cars.forEach(function (c, i) { T.gridOrder[c.id] = isNum(c.position) ? c.position : i + 1; });
      }
      snap.cars.forEach(function (c) {
        var e = T.cars[c.id];
        if (!e) e = T.cars[c.id] = { laps: [], lapCount: isNum(c.lap) ? c.lap : 0, prevValid: true, topSpeed: 0, positions: [], collisions: 0, offTracks: 0, wasOff: false };
        if (isNum(c.speed) && Math.abs(c.speed) > e.topSpeed) e.topSpeed = Math.abs(c.speed);
        if (c.offTrack && !e.wasOff) e.offTracks++;
        e.wasOff = !!c.offTrack;
        if (isNum(c.lap) && c.lap > e.lapCount) {
          var t = isNum(c.lastLap_s) ? c.lastLap_s : null;
          if (t != null && t > 0) {
            var lap = { carId: c.id, isPlayer: !!c.isPlayer, lap: c.lap, time: t, valid: e.prevValid !== false, sectors: Array.isArray(c.lastSectors) ? c.lastSectors.slice() : null, position: c.position };
            e.laps.push(lap);
            e.positions.push(c.position);
            done.push(lap);
          }
          e.lapCount = c.lap;
        } else if (isNum(c.lap) && c.lap < e.lapCount) {
          e.lapCount = c.lap; // restart / reset
        }
        e.prevValid = c.lapValid !== false;
      });
      return done;
    };
    return T;
  }

  /* ======================================================================
     Results normalization (pure)
     ====================================================================== */
  function normalizeResults(res, snap, opts) {
    opts = opts || {};
    var mode = opts.mode || (snap && snap.mode) || 'race';
    var rows = null;
    if (Array.isArray(res)) rows = res;
    else if (res && typeof res === 'object') {
      var keys = ['order', 'classification', 'standings', 'cars', 'results', 'rows', 'finishOrder'];
      for (var i = 0; i < keys.length && !rows; i++) if (Array.isArray(res[keys[i]]) && res[keys[i]].length) rows = res[keys[i]];
    }
    var snapCars = (snap && Array.isArray(snap.cars)) ? snap.cars : [];
    var byId = {};
    snapCars.forEach(function (c) { byId[c.id] = c; });
    if (!rows || !rows.length) rows = snapCars.slice();
    rows = rows.map(function (r, idx) {
      if (!isPlain(r)) r = { id: r };
      var id = r.id != null ? r.id : (r.carId != null ? r.carId : null);
      var base = id != null && byId[id] ? byId[id] : {};
      var o = {};
      var k;
      for (k in base) if (has(base, k)) o[k] = base[k];
      for (k in r) if (has(r, k) && r[k] !== undefined) o[k] = r[k];
      o.id = id != null ? id : (base.id != null ? base.id : idx);
      if (!isNum(o.position)) o.position = idx + 1;
      o._order = idx;
      return o;
    });
    if (mode !== 'race') {
      rows.sort(function (a, b) {
        var ta = isNum(a.bestLap_s) ? a.bestLap_s : Infinity, tb = isNum(b.bestLap_s) ? b.bestLap_s : Infinity;
        return ta - tb || a._order - b._order;
      });
      rows.forEach(function (r, i) { r.position = i + 1; });
    } else {
      rows.sort(function (a, b) { return (a.position - b.position) || (a._order - b._order); });
    }
    var leader = rows[0] || null;
    rows.forEach(function (r) {
      r.penalties_s = isNum(r.penalties_s) ? r.penalties_s : 0;
      if (isNum(r.totalTime_s)) r.total_s = r.totalTime_s;
      else if (isNum(r.finishTime_s)) r.total_s = r.finishTime_s + (r.penaltiesIncluded ? 0 : r.penalties_s);
      else r.total_s = null;
    });
    var fastest = (res && res.fastestLap) || (snap && snap.fastestLap) || null;
    if (!fastest) {
      rows.forEach(function (r) { if (isNum(r.bestLap_s) && (!fastest || r.bestLap_s < fastest.time)) fastest = { carId: r.id, time: r.bestLap_s }; });
    }
    var bestOverall = fastest && isNum(fastest.time) ? fastest.time : null;
    rows.forEach(function (r, i) {
      r.isFastest = !!(fastest && fastest.carId === r.id);
      if (mode !== 'race') {
        r.gapText = i === 0 ? fmtTime(r.bestLap_s, 'No time') : (isNum(r.bestLap_s) && isNum(leader.bestLap_s) ? fmtGap(r.bestLap_s - leader.bestLap_s) : 'No time');
        return;
      }
      if (r.dnf) { r.gapText = 'DNF'; return; }
      if (i === 0) { r.gapText = r.total_s != null ? fmtTime(r.total_s) : (r.finished ? 'Winner' : 'Leader'); return; }
      var lapsDown = isNum(leader.lap) && isNum(r.lap) ? leader.lap - r.lap : 0;
      if (!r.finished && r.status === 'running' && typeof r.gapText === 'string' && r.gapText) {
        // the engine classifies running cars by distance (a car on its final lap is not "+1 Lap")
        if (!/lap/i.test(r.gapText)) r.gapText = (isNum(r.gapLeader_s) ? fmtGap(r.gapLeader_s) : r.gapText) + '*';
        return;
      } else if (!r.finished && lapsDown >= 1 && isNum(r.raceDist) && isNum(leader.raceDist) && isNum(opts.lapLength) && opts.lapLength > 0) {
        lapsDown = Math.max(0, Math.floor((leader.raceDist - r.raceDist) / opts.lapLength));
      }
      if (r.finished && leader.total_s != null && r.total_s != null && lapsDown <= 0) r.gapText = fmtGap(r.total_s - leader.total_s);
      else if (lapsDown >= 1) r.gapText = '+' + plural(lapsDown, 'Lap');
      else if (isNum(r.gapLeader_s)) r.gapText = fmtGap(r.gapLeader_s) + (r.finished ? '' : '*');
      else r.gapText = r.finished ? '—' : 'Running';
    });
    return { rows: rows, fastestLap: fastest, bestOverall: bestOverall, mode: mode, raw: res };
  }

  /* ======================================================================
     Module discovery
     ====================================================================== */
  function R_() { return CB.race || {}; }
  function moduleStatus() {
    var r = R_();
    var st = {
      tracks: !!(r.tracks && (Array.isArray(r.tracks.list) || typeof r.tracks.list === 'function')),
      vehicle: !!(r.vehicle && typeof r.vehicle.fromBuild === 'function'),
      ai: !!(r.ai && typeof r.ai.createGrid === 'function'),
      engine: !!(r.engine && typeof r.engine.createSession === 'function'),
      renderer: !!(r.renderer && typeof r.renderer.create === 'function'),
      renderer3d: !!(r.renderer3d && typeof r.renderer3d.create === 'function'),
      hud: !!(r.hud && typeof r.hud.create === 'function'),
      audio: !!(r.audio && typeof r.audio.create === 'function'),
      physics: !!(CB.physics && typeof CB.physics.compute === 'function'),
      render: !!(CB.render && typeof CB.render.thumbnail === 'function'),
      data: !!(CB.data && typeof CB.data.defaultBuild === 'function')
    };
    st.canRace = st.tracks && st.engine;
    return st;
  }
  var MODULE_INFO = {
    tracks: { file: 'js/race/tracks.js', label: 'Track catalog', required: true },
    engine: { file: 'js/race/engine.js', label: 'Race engine', required: true },
    vehicle: { file: 'js/race/vehicle.js', label: 'Vehicle dynamics', required: false },
    ai: { file: 'js/race/ai.js', label: 'AI drivers', required: false, note: 'Grid will be empty' },
    renderer: { file: 'js/race/renderer.js', label: 'World renderer', required: false, note: 'Basic fallback view used' },
    hud: { file: 'js/race/hud.js', label: 'HUD', required: false, note: 'Minimal fallback HUD used' },
    audio: { file: 'js/race/audio.js', label: 'Audio', required: false, note: 'Silent' }
  };

  function getTrackList() {
    var t = R_().tracks;
    if (!t) return [];
    try {
      var l = typeof t.list === 'function' ? t.list() : t.list;
      // challenge layouts (CB.game.challenges) register into the catalog too; they are launched from the hub only
      return Array.isArray(l) ? l.filter(function (d) { return d && d.id && !d.challenge && !d.isChallenge && !d.hidden; }) : [];
    } catch (e) { return []; }
  }
  /* ---------------------------------------------------------- drift integration (js/race/drift/*) */
  function driftMod() {
    var D = CB.race && CB.race.drift;
    return D && typeof D.createSession === 'function' ? D : null;
  }
  function isDriftTrack(def) {
    if (!def) return false;
    var D = CB.race && CB.race.drift;
    try { if (D && D.session && typeof D.session.isDriftTrack === 'function') return !!D.session.isDriftTrack(def); } catch (e) { /* fall through */ }
    return !!(def.drift || def.driftZones || (Array.isArray(def.tags) && def.tags.indexOf('drift') >= 0));
  }
  /** Tracks for the discipline: drift tracks first for drifting; classic circuits first for racing. */
  function tracksFor(discipline) {
    var all = getTrackList();
    var drift = all.filter(isDriftTrack), other = all.filter(function (d) { return !isDriftTrack(d); });
    return discipline === 'drift' ? drift.concat(other) : other.concat(drift);
  }
  function findTrack(id) {
    var PLt = pluginOf();
    if (PLt && typeof PLt.findTrack === 'function') { try { var pt = PLt.findTrack(id); if (pt) return pt; } catch (eP) { /* fall through */ } }
    if (U && isArcadeS(U.settings)) { var ad = arcadeTrack(id); if (ad) return ad; }
    var l = getTrackList();
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    var t = R_().tracks;
    try { if (t && typeof t.get === 'function') return t.get(id) || null; } catch (e) { /* ignore */ }
    return null;
  }
  function defaultTrackId(list) {
    if (!list.length) return null;
    for (var i = 0; i < list.length; i++) if (/forge/i.test(list[i].id) || /forge/i.test(list[i].name || '')) return list[i].id;
    return list[0].id;
  }

  /* ======================================================================
     Multiplayer (NET-SPEC): pure helpers for CB.race.ui.openNet(session, cfg)
     The session is a CB.net.race session (js/net/netrace.js) the lobby already created: it runs its own clock
     (the host's race clock), so race-ui only feeds update(STEP, input), renders snapshot() and never restarts it.
     ====================================================================== */
  var STEER_RANK = { off: 0, light: 1, medium: 2, heavy: 3, auto: 4 };
  function netCall(o, fn, dflt) { try { return o && typeof o[fn] === 'function' ? o[fn]() : dflt; } catch (e) { return dflt; } }
  function netGet(o, k) { try { return o ? o[k] : undefined; } catch (e) { return undefined; } }
  /** 'race' | 'drift' | 'free' for a net session (+ the lobby cfg as fallback). */
  function netModeOf(session, cfg) {
    var m = netGet(session, 'mode') || (cfg && cfg.mode) || 'race';
    m = m === 'free-roam' || m === 'freeroam' || m === 'practice' ? 'free' : m;
    return m === 'drift' || m === 'free' ? m : 'race';
  }
  /** Steering assist for a net session: the player's level (heavy by default), capped by the host's max. */
  function netSteerLevel(want, max) {
    var w = has(STEER_RANK, want) ? want : 'heavy';
    if (!has(STEER_RANK, max)) return w;
    return STEER_RANK[w] <= STEER_RANK[max] ? w : max;
  }
  /** Setup locked to the net session: discipline / circuit / mode / laps / conditions / drift format / assists. */
  function netSettings(session, cfg, base) {
    cfg = cfg || {};
    var S = sanitizeSettings(deepClone(base || {}));
    var mode = netModeOf(session, cfg);
    var td = netGet(session, 'trackDef'), ec = netGet(session, 'config') || {};
    S.discipline = mode === 'drift' ? 'drift' : netGet(session, 'isArcadeNet') ? 'arcade' : 'race';   // arcade MP: js/net/netarcade.js
    S.trackId = (td && td.id) || ec.trackId || cfg.trackId || (cfg.track && cfg.track.id) || S.trackId;
    S.mode = mode === 'free' ? 'practice' : 'race';
    var laps = isNum(ec.laps) && ec.laps > 0 && mode === 'race' ? ec.laps : cfg.laps;
    if (isNum(+laps) && +laps > 0) S.laps = Math.round(clamp(+laps, 1, 50));
    if (ids(WEATHERS).indexOf(ec.weather || cfg.weather) >= 0) S.weather = ec.weather || cfg.weather;
    if (ids(TIMES).indexOf(ec.timeOfDay || cfg.timeOfDay) >= 0) S.timeOfDay = ec.timeOfDay || cfg.timeOfDay;
    var allowed = cfg.assists || {};
    ['abs', 'tc', 'autoShift', 'racingLine'].forEach(function (k) { if (allowed[k] === false) S.assists[k] = false; });
    S.assists.steeringAssist = false;
    syncAssist(S);   // the player's own level for this discipline (race / drift battle) ...
    S.steerAssist = netSteerLevel(S.steerAssist, cfg.maxSteerAssist === 'auto' ? 'heavy' : cfg.maxSteerAssist);   // ... capped by the host
    if (S.discipline === 'arcade') S.steerAssist = 'off';   // arcade MP: the single arcade handling model, no assist
    if (mode === 'drift') {
      var snap = netCall(session, 'snapshot', null), bt = snap && snap.net && snap.net.battle;
      S.driftMode = bt && bt.format === 'attack' ? 'trial' : 'tandem';
    }
    return S;
  }
  /** The input fed to session.update in net mode. Drift sessions (rawInput) run CB.race.assist themselves; race / free
      sessions get the assist applied here (assist.filter on session.playerState()) unless the race-ui engine hook
      (CB.race.ui.netHooks(), passed by the session creator as cfg.hooks) is already doing it inside the engine. */
  function netInput(R, inp) {
    var raw = R.input && R.input.lastIntent;
    if (R.rawInput) return raw || inp;
    if (!R.netAssist || R.netHookSeen || !raw) return inp;
    var ph = R.lastSnap && R.lastSnap.phase;
    if (ph && ph !== 'racing') return inp;          // never override the grid hold / jump-start logic
    var ps = netCall(R.session, 'playerState', null);
    if (!ps) return inp;
    try {
      var o = R.netAssist.filter(raw, ps, { dt: STEP, geom: R.session.geom || null });
      if (!o) return inp;
      o.requestReset = !!(inp && inp.requestReset); o.pit = !!(inp && inp.pit);
      if (inp && inp.shiftUp) o.shiftUp = true;
      if (inp && inp.shiftDown) o.shiftDown = true;
      return o;
    } catch (e) { return inp; }
  }
  /** Engine hook for net session creators (cfg.hooks): runs the active net race's steering assist at 120 Hz. */
  var netHookTarget = { R: null };
  function netHooks() {
    return [{
      preStep: function (car, input, dt) {
        var R = netHookTarget.R;
        if (!R || !R.netAssist || R.rawInput || !car || !car.isPlayer || car.autopilotActive) return input;
        var c = car.ctx, ph = c && c.phase;
        if (ph === 'grid' || ph === 'countdown' || ph === 'finished') return input;
        if (c && car.frozenUntil > c.t) return input;
        var raw = R.input && R.input.lastIntent;
        if (!raw) return input;
        R.netHookSeen = true;
        try {
          var o = R.netAssist.filter(raw, car.state, { dt: dt, geom: c && c.geom, params: car.params, gripMult: c && c.gripMult });
          o.requestReset = !!(input && input.requestReset); o.pit = !!(input && input.pit);
          return o;
        } catch (e) { return input; }
      }
    }];
  }
  /** createRaceSession's first branch: a net launch runs on the session the lobby handed over (never a new engine). */
  function netSessionFor(R) {
    var n = R && R.net;
    if (!n || !n.session) return null;
    R.rawInput = !!netGet(n.session, 'wantsRawInput');
    R.assistVia = R.rawInput ? 'net-drift' : R.netAssist ? 'net' : 'none';
    return n.session;
  }
  /** Results only once the host's final classification is in (or the session ended: host left / kicked). */
  function netFinished(snap, session) {
    if (snap && snap.phase === 'finished') return true;
    var ns = netCall(session, 'netState', null);
    return !!(ns && (ns.final || ns.ended));
  }
  /** Compact HUD-corner status from session.netState(). */
  function netStatusLine(ns) {
    if (!ns) return { text: 'Offline', quality: 'poor' };
    var humans = (ns.players || []).filter(function (p) { return p.kind !== 'ai' && p.connected !== false; }).length;
    var q = (ns.sync && ns.sync.quality) || 'good';
    var parts = [ns.role === 'host' ? 'Host' : (isNum(ns.ping_ms) ? ns.ping_ms + ' ms' : '— ms'), plural(humans || 1, 'driver'), 'sync ' + q];
    if (ns.connected === false) { parts[0] = 'Reconnecting…'; q = 'poor'; }
    if (ns.via === 'relay') parts.push('via server');   // server-relay fallback (js/net/relay.js)
    else if (ns.via === 'turn') parts.push('via TURN');
    return { text: parts.join(' · '), quality: q };
  }
  /** Same projection as CB.race.drift.hud (renderer3d getCameraState: sim (x, y) -> GL (x, h, -y)). */
  function projectThrough(cam, W, H, x, y, hgt) {
    if (!cam || !cam.eye || !cam.target) return null;
    var e = cam.eye, tg = cam.target, up = cam.up || [0, 1, 0];
    var fx = tg[0] - e[0], fy = tg[1] - e[1], fz = tg[2] - e[2];
    var fl = Math.hypot(fx, fy, fz); if (!(fl > 1e-9)) return null;
    fx /= fl; fy /= fl; fz /= fl;
    var rx = fy * up[2] - fz * up[1], ry = fz * up[0] - fx * up[2], rz = fx * up[1] - fy * up[0];
    var rl = Math.hypot(rx, ry, rz); if (!(rl > 1e-9)) return null;
    rx /= rl; ry /= rl; rz /= rl;
    var ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
    var px = x - e[0], py = (hgt || 0) - e[1], pz = -y - e[2];
    var depth = px * fx + py * fy + pz * fz;
    if (!(depth > (isNum(cam.near) ? cam.near : 0.1))) return null;
    var th = Math.tan((isNum(cam.fov) ? cam.fov : 60) * Math.PI / 360), aspect = W / Math.max(1, H);
    var nx = (px * rx + py * ry + pz * rz) / (depth * th * aspect);
    var ny = (px * ux + py * uy + pz * uz) / (depth * th);
    return { x: (nx + 1) * 0.5 * W, y: (1 - ny) * 0.5 * H, depth: depth, visible: Math.abs(nx) < 1.1 && Math.abs(ny) < 1.1 };
  }
  /** Name tags for remote cars: [{id, text, sub, x, y, alpha, scale}] (project(x, y) -> {x, y, depth, visible} | null). */
  function netTags(snap, project, maxDist) {
    var out = [];
    if (!snap || !Array.isArray(snap.cars) || typeof project !== 'function') return out;
    maxDist = maxDist || 260;
    snap.cars.forEach(function (c) {
      if (!c || c.isPlayer || !(c.remote || c.kind === 'human' || c.kind === 'ai')) return;
      if (!isNum(c.x) || !isNum(c.y)) return;
      var p = project(c.x, c.y);
      if (!p || !p.visible || !(p.depth > 0) || p.depth > maxDist) return;
      var fade = p.depth > maxDist * 0.7 ? clamp((maxDist - p.depth) / (maxDist * 0.3), 0, 1) : 1;
      out.push({ id: c.id, text: String(c.name || 'Driver').slice(0, 24), sub: c.position ? 'P' + c.position : '', kind: c.kind || 'human',
                 x: p.x, y: p.y, depth: p.depth, alpha: fade * (isNum(c.opacity) ? clamp(c.opacity, 0.25, 1) : 1) * (c.ghost ? 0.6 : 1),
                 scale: clamp(26 / p.depth, 0.7, 1.15), color: c.color || '#c8a24a' });
    });
    out.sort(function (a, b) { return b.depth - a.depth; });   // far first, near drawn on top
    return out;
  }

  /* ======================================================================
     Pure exports (also used by tests)
     ====================================================================== */
  var api = CB.race.ui = CB.race.ui || {};
  var LOCK_KEYS = ['trackId', 'mode', 'laps', 'opponents', 'weather', 'timeOfDay', 'difficulty', 'field', 'rubberBanding', 'driftMode', 'driftDuration'];
  api._ = {
    STEP: STEP, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    clamp: clamp, fmtTime: fmtTime, fmtGap: fmtGap, ordinal: ordinal, fmtLength: fmtLength, fmtSpeed: fmtSpeed,
    buildHash: buildHash, stableStringify: stableStringify,
    createRecords: createRecords, memoryStorage: memoryStorage, drawLapChart: drawLapChart,
    sanitizeSettings: sanitizeSettings, resolveBuild: resolveBuild, fallbackBuild: fallbackBuild,
    loadSettings: loadSettings, migrateAssist: migrateAssist, syncAssist: syncAssist, setAssist: setAssist, assistKey: assistKey, DEFAULT_ASSIST: DEFAULT_ASSIST,
    estimateMetrics: estimateMetrics, computeMetrics: computeMetrics,
    catmullRomClosed: catmullRomClosed, resampleClosed: resampleClosed, countCorners: countCorners, trackStats: trackStats,
    createInput: createInput, probeLeftSign: probeLeftSign, createLapTracker: createLapTracker,
    normalizeResults: normalizeResults, moduleStatus: moduleStatus,
    DISCIPLINES: DISCIPLINES, DRIFT_MODES: DRIFT_MODES, STEER_ASSISTS: STEER_ASSISTS, DRIFT_TUNES: DRIFT_TUNES,
    setDiscipline: setDiscipline, cam3dKey: cam3dKey, sessionLabel: sessionLabel, isDriftTrack: isDriftTrack, tracksFor: tracksFor,
    launchMismatchOf: launchMismatchOf, LOCK_KEYS: LOCK_KEYS,
    netSessionFor: netSessionFor, netModeOf: netModeOf, netSteerLevel: netSteerLevel, netSettings: netSettings, netInput: netInput, netFinished: netFinished,
    netStatusLine: netStatusLine, netTags: netTags, projectThrough: projectThrough, netHooks: netHooks, netHookTarget: netHookTarget,
    isArcadeS: isArcadeS, enterArcadeSettings: enterArcadeSettings, arcadeSettingsOf: arcadeSettingsOf, arcadeSanitize: arcadeSanitize, ARC_KEYS: ARC_KEYS
  };
  api.netHooks = netHooks;
  api.records = createRecords();
  api.buildHash = buildHash;
  api.fmtTime = fmtTime;

  if (!hasDOM) {
    api.open = function () { return null; };
    api.close = function () {};
    api.isOpen = function () { return false; };
    if (typeof module !== 'undefined') module.exports = CB.race.ui;
    return;
  }

  /* ######################################################################
     ################################ DOM ################################
     ###################################################################### */

  /* ----------------------------------------------------------- DOM builder */
  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!has(attrs, k)) continue;
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') { for (var sk in v) if (has(v, sk)) node.style.setProperty(sk, v[sk]); }
        else if (k === 'dataset') { for (var dk in v) if (has(v, dk)) node.dataset[dk] = v[dk]; }
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
      }
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { for (var i = 0; i < c.length; i++) append(node, c[i]); return; }
    if (typeof c === 'string' || typeof c === 'number') node.appendChild(document.createTextNode(String(c)));
    else node.appendChild(c);
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }
  function svgIcon(name, size) {
    size = size || 16;
    var p = ICONS[name] || '';
    return '<svg class="rx-ico" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }
  function icon(name, size) { return h('span', { class: 'rx-icon', html: svgIcon(name, size) }); }

  var ICONS = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    cloud: '<path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 9.3 4.5 4.5 0 0 0 7 18z"/>',
    rain: '<path d="M7 14h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 5.3 4.5 4.5 0 0 0 7 14z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>',
    sunset: '<path d="M3 18h18M5 21h14M12 3v5M5.6 9.6l1.4 1.4M18.4 9.6 17 11M8 18a4 4 0 0 1 8 0"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    film: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    camera: '<path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/>',
    sound: '<path d="M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
    mute: '<path d="M4 10v4h4l5 4V6L8 10zM17 9l5 6M22 9l-5 6"/>',
    restart: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5M4 4v4.5h4.5"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4a3 3 0 0 0 4 4M16 6h4a3 3 0 0 1-4 4M12 13v4M8 21h8M9 17h6"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8 6.2 21l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    gamepad: '<path d="M6 9h12a4 4 0 0 1 3.9 4.9l-.9 3.6a2 2 0 0 1-3.4.9L15 16H9l-2.6 2.4a2 2 0 0 1-3.4-.9l-.9-3.6A4 4 0 0 1 6 9z"/><path d="M8 11v3M6.5 12.5h3M15.5 12h.01M17.5 13.5h.01"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    warn: '<path d="M12 3l10 18H2zM12 10v5M12 18h.01"/>',
    reset: '<path d="M12 2l3 6H9zM12 8v6M5 20a7 4 0 0 1 14 0"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    steer: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M3.5 10.5h6.5M14 10.5h6.5M12 14v7"/>',
    gauge: '<path d="M4.9 19A9 9 0 1 1 19.1 19"/><path d="M12 13l4-5"/>',
    drift: '<path d="M4 18c3-7 8-11 16-12"/><path d="M14 4l6 2-2 6"/><circle cx="6" cy="20" r="1.2"/><circle cx="3.5" cy="15.5" r="1"/><circle cx="9" cy="21" r=".8"/>',
    medal: '<circle cx="12" cy="15" r="6"/><path d="M8.5 3h7L13 9.5h-2zM12 12.5v5M10 15h4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'
  };

  /* ----------------------------------------------------------- styles */
  function injectStyles() {
    if (document.getElementById('race-styles')) return;
    var st = document.createElement('style');
    st.id = 'race-styles';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  var CSS = [
    /* UNIFY-SPEC: every --rx-* token is an alias of the shared design tokens in css/styles.css (fallbacks for standalone pages) */
    '#race-root{--rx-accent:var(--accent,#c9a56b);--rx-accent-ink:var(--accent-ink,#17130b);--rx-bg:var(--bg,#0b0b0d);--rx-panel:var(--panel,#141519);--rx-panel-2:var(--panel-2,#1b1c21);',
    '--rx-line:var(--line-soft,rgba(255,255,255,.055));--rx-line-2:var(--line,#2b2c33);--rx-text:var(--text,#ecebe6);--rx-dim:var(--text-dim,#9b9890);--rx-faint:var(--text-faint,#6c6a64);',
    '--rx-good:var(--good,#3fbf7f);--rx-warn:var(--warn,#e3a33a);--rx-bad:var(--bad,#e5484d);--rx-purple:var(--hud-purple,#b26bff);--rx-red:var(--race,#e0412f);',
    '--rx-font:var(--font);',
    '--rx-mono:var(--mono);',
    'position:fixed;inset:0;z-index:9000;color:var(--rx-text);font-family:var(--rx-font);font-size:var(--fs-md);line-height:1.4;',
    'background:var(--rx-bg);overflow:hidden;-webkit-font-smoothing:antialiased;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}',
    '#race-root *,#race-root *::before,#race-root *::after{box-sizing:border-box}',
    '#race-root button{font-family:inherit;color:inherit}',
    // the id rule above outranks .cb-btn.primary's dark ink: gold buttons (Take the grid, Resume) showed pale text on gold
    '#race-root .cb-btn.primary{color:var(--btn-color,var(--accent-ink))}',
    '#race-root .rx-ico{display:block;flex:none}',
    '#race-root .rx-icon{display:inline-flex;align-items:center;justify-content:center}',
    /* carbon fibre + vignette */
    /* same studio backdrop as the Atelier / menu screens */
    '#race-root .rx-carbon{position:absolute;inset:0;background-color:var(--bg,#0b0b0d);',
    'background-image:radial-gradient(120% 80% at 50% -10%,var(--studio-spot,rgba(201,165,107,.13)),transparent 60%),radial-gradient(90% 70% at 100% 100%,var(--studio-spot-2,rgba(106,166,216,.07)),transparent 60%),var(--noise,none)}',
    '#race-root .rx-carbon::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent,var(--bg-3,rgba(0,0,0,.4)));opacity:.6;pointer-events:none}',
    /* routed screen (index.html#/race, #/drift): fills the router layer instead of covering the page */
    '#race-root.is-routed{position:absolute;inset:0;z-index:auto;width:100%;height:100%}',
    '#race-root.is-routed .rx-brand{display:none}',
    '#race-root .rx-disc-switch{flex:none}#race-root .rx-disc-switch .cb-tab-list{min-width:200px}#race-root .rx-disc-switch .cb-tab{min-width:90px;cursor:pointer}',
    /* each tab carries its mode accent (--mode-* tokens, css/styles.css § 01): icon tint + active underline */
    '#race-root .rx-disc-switch .cb-tab .rx-icon{color:var(--mc,currentColor);opacity:.85}#race-root .rx-disc-switch .cb-tab.is-active .rx-icon{opacity:1}',
    '#race-root .rx-disc-switch .cb-tab.is-active::after{background:var(--mc,var(--accent-grad))}',
    '@media (max-width:640px){#race-root .rx-disc-switch .cb-tab-list{min-width:0}#race-root .rx-disc-switch .cb-tab{min-width:0;padding:0 10px}}',
    /* short landscape phones: a slimmer setup header (the step pills duplicate the switch) */
    '@media (max-height:500px){#race-root .rx-topbar{padding-top:8px;padding-bottom:8px}#race-root .rx-topbar .rx-steps{display:none}#race-root .rx-topbar>.rx-btn:last-child{margin-left:auto}}',
    /* phones: the back button keeps its icon (the label stays for screen readers and in the title) */
    '@media (max-width:560px){#race-root .rx-topbar>.rx-btn:last-child{font-size:0;gap:0;min-width:40px;padding:0 10px;margin-left:auto}#race-root .rx-topbar>.rx-btn:last-child .rx-kbd{display:none}}',
    '#race-root .rx-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}',
    '#race-root .rx-layer{position:absolute;inset:0}',
    '#race-root[data-screen="setup"] .rx-canvas,#race-root[data-screen="discipline"] .rx-canvas,#race-root[data-screen="results-only"] .rx-canvas{visibility:hidden}',
    '#race-root .race3d-gl{z-index:0}',
    '#race-root[data-screen="setup"] .race3d-gl,#race-root[data-screen="discipline"] .race3d-gl,#race-root[data-screen="results-only"] .race3d-gl,#race-root[data-screen="error"] .race3d-gl{visibility:hidden}',
    '#race-root .rx-host{position:absolute;inset:0;pointer-events:none}',
    '#race-root .rx-host>*{pointer-events:auto}',
    /* generic */
    '#race-root .rx-eyebrow{font-size:var(--fs-2xs);letter-spacing:var(--tracking-caps);text-transform:uppercase;color:var(--rx-dim);font-weight:600}',
    '#race-root .rx-eyebrow.accent{color:var(--rx-accent)}',
    '#race-root .rx-display{font-family:var(--serif);font-weight:600;font-style:normal;letter-spacing:-.02em;text-transform:none;line-height:1}',
    '#race-root .rx-num{font-family:var(--rx-mono);font-variant-numeric:tabular-nums;letter-spacing:-.01em}',
    '#race-root .rx-panel{background:var(--surface-grad,none),var(--glass,rgba(18,19,23,.72));border:1px solid var(--rx-line-2);border-radius:var(--radius-lg,16px);',
    'box-shadow:var(--shadow);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}',
    /* buttons are the shared .cb-btn (css/styles.css); only race-specific sizes live here */
    '#race-root .rx-btn{cursor:pointer}',
    '#race-root .rx-btn:focus-visible,#race-root .rx-seg-btn:focus-visible,#race-root .rx-track-card:focus-visible,#race-root .rx-toggle:focus-visible{outline:none;box-shadow:var(--focus,0 0 0 2px var(--rx-accent))}',
    '#race-root .rx-btn.primary[disabled]{filter:grayscale(1) brightness(.7);cursor:not-allowed}',
    '#race-root .rx-btn.big{min-height:var(--control-h-lg);padding:0 var(--sp-6);font-size:var(--fs-md);border-radius:var(--radius-sm);font-weight:650;letter-spacing:.01em}',
    '#race-root .rx-btn.icon{width:36px;min-height:36px;padding:0}',
    '#race-root .rx-kbd{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:5px;',
    'border:1px solid var(--rx-line-2);border-bottom-width:2px;background:rgba(255,255,255,.05);font-family:var(--rx-mono);font-size:var(--fs-xs);color:var(--rx-text)}',
    '#race-root .rx-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;border:1px solid var(--rx-line-2);font-size:var(--fs-xs);color:var(--rx-dim);white-space:nowrap}',
    '#race-root .rx-chip.accent{color:var(--rx-accent);border-color:var(--accent-ring,rgba(201,165,107,.45))}',
    '#race-root .rx-skew{display:inline-block;width:26px;height:4px;background:var(--rx-accent);transform:skewX(-30deg);margin-right:10px;vertical-align:middle}',
    '#race-root .rx-stripe{height:3px;background:linear-gradient(90deg,var(--rx-red) 0 33%,var(--text-strong) 33% 66%,var(--rx-accent) 66%)}',
    /* scrollbars */
    '#race-root .rx-scroll{overflow:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}',
    '#race-root .rx-scroll::-webkit-scrollbar{width:8px;height:8px}#race-root .rx-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:8px}',
    /* ---------------- setup */
    '#race-root .rx-setup{position:absolute;inset:0;display:grid;grid-template-rows:auto 1fr auto;animation:rx-fade .35s ease}',
    '#race-root .rx-topbar{display:flex;align-items:center;gap:18px;padding:14px 28px;border-bottom:1px solid var(--rx-line-2);background:var(--glass,rgba(18,19,23,.72));backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}',
    '#race-root .rx-brand{display:flex;align-items:center;gap:12px}',
    '#race-root .rx-brand-mark{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;background:var(--accent-grad);color:var(--accent-ink);font-weight:800;font-size:var(--fs-lg);letter-spacing:-.05em;box-shadow:0 6px 18px -6px var(--rx-accent)}',
    '#race-root .rx-brand-name{font-weight:800;letter-spacing:.24em;font-size:var(--fs-sm);text-transform:uppercase}',
    '#race-root .rx-brand-sub{font-size:var(--fs-2xs);letter-spacing:.3em;color:var(--rx-accent);text-transform:uppercase;font-weight:700}',
    '#race-root .rx-steps{display:flex;gap:6px;margin:0 auto;min-width:0}',
    '#race-root .rx-step{font-size:var(--fs-2xs);letter-spacing:.18em;text-transform:uppercase;color:var(--rx-faint);padding:6px 12px;border-radius:999px;border:1px solid transparent;font-weight:700;white-space:nowrap;flex:0 0 auto}',
    '#race-root .rx-step.is-on{color:var(--rx-text);border-color:var(--rx-line-2);background:rgba(255,255,255,.04)}',
    '#race-root .rx-step b{color:var(--rx-accent);margin-right:6px}',
    '#race-root .rx-setup-main{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(360px,1fr);gap:22px;padding:22px 28px;min-height:0}',
    '#race-root .rx-col{min-height:0;display:flex;flex-direction:column;gap:16px}',
    '#race-root .rx-col>*{flex-shrink:0}',
    '#race-root .rx-col.rx-scroll{padding-right:6px}',
    '#race-root .rx-section-title{display:flex;align-items:center;justify-content:space-between;margin:2px 0 -4px}',
    '#race-root .rx-section-title h3{margin:0;display:inline-flex;align-items:center;gap:var(--sp-2);font-size:var(--fs-2xs);letter-spacing:var(--tracking-caps);text-transform:uppercase;font-weight:700;color:var(--rx-text)}',
    /* featured track */
    '#race-root .rx-featured{position:relative;display:grid;grid-template-columns:minmax(0,1.25fr) minmax(220px,1fr);min-height:300px;overflow:hidden}',
    '#race-root .rx-featured-map{position:relative;min-height:300px;border-right:1px solid var(--rx-line);background:radial-gradient(80% 80% at 50% 50%,rgba(255,255,255,.035),transparent 70%)}',
    '#race-root .rx-featured-map canvas{position:absolute;inset:0;width:100%;height:100%}',
    '#race-root .rx-map-legend{position:absolute;left:14px;bottom:12px;display:flex;gap:10px;font-size:var(--fs-2xs);color:var(--rx-dim);letter-spacing:.1em;text-transform:uppercase}',
    '#race-root .rx-map-legend i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle}',
    '#race-root .rx-featured-info{padding:22px 22px 18px;display:flex;flex-direction:column;gap:12px}',
    '#race-root .rx-track-name{font-size:var(--fs-title)}',
    '#race-root .rx-track-desc{color:var(--rx-dim);font-size:var(--fs-sm);max-width:44ch}',
    '#race-root .rx-statgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--rx-line);border:1px solid var(--rx-line);border-radius:10px;overflow:hidden;margin-top:auto}',
    '#race-root .rx-statgrid>div{background:var(--panel,rgba(12,13,15,.92));padding:10px 12px}',
    '#race-root .rx-stat-l{font-size:var(--fs-2xs);letter-spacing:.16em;text-transform:uppercase;color:var(--rx-dim);font-weight:600}',
    '#race-root .rx-stat-v{font-size:var(--fs-lg);font-weight:700;margin-top:2px}',
    '#race-root .rx-stat-v small{font-size:var(--fs-xs);color:var(--rx-dim);font-weight:500;margin-left:3px}',
    '#race-root .rx-pips{display:inline-flex;gap:3px;vertical-align:middle}',
    '#race-root .rx-pips i{width:12px;height:5px;border-radius:1px;background:rgba(255,255,255,.12);transform:skewX(-20deg)}',
    '#race-root .rx-pips i.on{background:var(--rx-accent)}',
    '#race-root .rx-pips.hot i.on{background:linear-gradient(90deg,var(--rx-accent),var(--rx-red))}',
    /* track cards */
    '#race-root .rx-track-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:12px}',
    /* track cards are shared .cb-card selectable cards */
    '#race-root .rx-track-card{cursor:pointer;padding:0;gap:0;font:inherit}',
    '#race-root .rx-track-thumb{position:relative;height:104px;border-bottom:1px solid var(--rx-line);background:repeating-linear-gradient(45deg,rgba(255,255,255,.015) 0 6px,transparent 6px 12px)}',
    '#race-root .rx-track-thumb canvas{position:absolute;inset:0;width:100%;height:100%}',
    '#race-root .rx-track-meta{padding:10px 12px 12px}',
    '#race-root .rx-track-meta b{display:block;font-size:var(--fs-sm);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#race-root .rx-track-meta span{display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:var(--fs-xs);color:var(--rx-dim);margin-top:4px}',
    '#race-root .rx-track-meta .rx-track-stat{display:block;white-space:nowrap;margin:0;flex-shrink:1;min-width:0;overflow:hidden;text-overflow:ellipsis}#race-root .rx-track-meta .rx-pips{flex-shrink:0}',
    '#race-root .rx-track-badge{position:absolute;right:8px;top:8px;padding:1px 7px;font-size:var(--fs-2xs);background:var(--glass-strong,rgba(0,0,0,.6))}',
    '#race-root .rx-track-pb{position:absolute;left:10px;top:10px;font-size:var(--fs-2xs);padding:2px 7px;border-radius:999px;background:var(--glass-strong,rgba(0,0,0,.6));border:1px solid var(--rx-line-2);color:var(--rx-accent)}',
    /* car card */
    '#race-root .rx-car.cb-card{display:grid;padding:16px 18px;gap:16px}#race-root .rx-car.cb-card:hover{transform:none}',
    '#race-root .rx-car-make{font-size:var(--fs-2xs);letter-spacing:.2em;text-transform:uppercase;color:var(--rx-accent);font-weight:700}',
    '#race-root .rx-car{padding:16px 18px;display:grid;grid-template-columns:150px 1fr;gap:16px;align-items:center;position:relative;overflow:hidden}',
    '#race-root .rx-car::before{content:"";position:absolute;inset:0;background:radial-gradient(60% 120% at 0% 50%,var(--rx-paint,var(--accent-soft,rgba(201,165,107,.14))),transparent 70%);opacity:.22;pointer-events:none}',
    '#race-root .rx-car-thumb{position:relative;height:90px;display:flex;align-items:center;justify-content:center}',
    '#race-root .rx-car-thumb svg{max-width:100%;max-height:100%;filter:drop-shadow(0 8px 10px rgba(0,0,0,.6))}',
    '#race-root .rx-car-name{font-family:var(--serif);font-size:var(--fs-xl);font-weight:600;letter-spacing:-.01em}',
    '#race-root .rx-car-sub{color:var(--rx-dim);font-size:var(--fs-sm);margin-top:2px}',
    '#race-root .rx-car-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 14px;margin-top:12px}',
    '#race-root .rx-car-stats .rx-stat-v{font-size:var(--fs-lg)}',
    '#race-root .rx-car-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}',
    '#race-root .rx-est{position:absolute;top:10px;right:12px}',
    /* form controls */
    '#race-root .rx-form{padding:16px 18px;display:flex;flex-direction:column;gap:16px}',
    '#race-root .rx-field{display:flex;flex-direction:column;gap:8px}',
    '#race-root .rx-field-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px}',
    '#race-root .rx-label{font-size:var(--fs-2xs);letter-spacing:.18em;text-transform:uppercase;color:var(--rx-dim);font-weight:700}',
    '#race-root .rx-field-val{font-size:var(--fs-sm);color:var(--rx-text)}',
    '#race-root .rx-field-desc{font-size:var(--fs-xs);color:var(--rx-faint);min-height:1em}',
    '#race-root .rx-field.is-disabled{opacity:.38;pointer-events:none}',
    '#race-root .rx-field.is-locked{opacity:.5;pointer-events:none}',
    '#race-root .rx-track-card.is-locked{opacity:.32;cursor:not-allowed}',
    /* segmented controls are the shared .cb-seg-btns / .cb-seg-btn */
    '#race-root .rx-seg{display:flex;flex-wrap:wrap;width:100%}',
    '#race-root .rx-seg-btn{flex:1 1 auto;cursor:pointer;padding:0 8px;font:inherit;font-size:var(--fs-sm);font-weight:600}',
    '#race-root .rx-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}',
    '#race-root .rx-stepper{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
    '#race-root .rx-stepper .rx-btn{width:36px;height:36px;padding:0;justify-content:center;font-size:var(--fs-lg)}',
    '#race-root .rx-stepper-val{min-width:56px;text-align:center;font-size:var(--fs-xl);font-weight:700;font-variant-numeric:tabular-nums}',
    '#race-root .rx-quick{display:flex;flex-wrap:wrap;gap:4px;margin-left:auto;min-width:0}',
    '#race-root .rx-quick button{appearance:none;border:1px solid var(--rx-line);background:transparent;border-radius:6px;padding:4px 7px;min-width:28px;min-height:28px;font-size:var(--fs-xs);color:var(--rx-dim);cursor:pointer}',
    '#race-root .rx-quick button:hover,#race-root .rx-quick button.is-active{color:var(--rx-text);border-color:var(--rx-accent)}',
    '#race-root .rx-toggles{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '#race-root .rx-toggle{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:var(--radius-sm,9px);border:1px solid var(--rx-line);background:var(--rx-panel-2);cursor:pointer;text-align:left;appearance:none;width:100%;font:inherit;color:inherit}',
    '#race-root .rx-toggle:hover{border-color:var(--rx-line-2)}',
    '#race-root .rx-toggle.is-on{border-color:color-mix(in srgb,var(--rx-accent) 30%,var(--rx-line-2))}',
    '#race-root .rx-toggle-text{flex:1;min-width:0}',
    '#race-root .rx-toggle-text b{display:block;font-size:var(--fs-sm);font-weight:600}',
    '#race-root .rx-toggle-text small{display:block;font-size:var(--fs-2xs);color:var(--rx-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    /* switches are the shared .cb-switch */
    '#race-root .rx-switch{display:block}',
    '#race-root .rx-range{width:100%;accent-color:var(--rx-accent)}',
    '#race-root .rx-banner{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border-radius:10px;border:1px solid rgba(255,176,32,.35);background:rgba(255,176,32,.07);font-size:var(--fs-sm)}',
    '#race-root .rx-banner.bad{border-color:rgba(255,77,77,.45);background:rgba(255,77,77,.08)}',
    '#race-root .rx-banner ul{margin:4px 0 0;padding-left:16px;color:var(--rx-dim)}',
    '#race-root .rx-banner code{font-family:var(--rx-mono);font-size:var(--fs-xs);color:var(--rx-text)}',
    '#race-root .rx-keys{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;align-items:center;font-size:var(--fs-sm);color:var(--rx-dim)}',
    '#race-root .rx-keys>span:nth-child(odd){display:flex;gap:4px;justify-content:flex-end}',
    '#race-root details.rx-details{border-top:1px solid var(--rx-line);padding-top:12px}',
    '#race-root details.rx-details summary{cursor:pointer;list-style:none;font-size:var(--fs-2xs);letter-spacing:.18em;text-transform:uppercase;color:var(--rx-dim);font-weight:700;display:flex;align-items:center;gap:8px}',
    '#race-root details.rx-details summary::-webkit-details-marker{display:none}',
    '#race-root details.rx-details[open] summary{color:var(--rx-text);margin-bottom:12px}',
    /* footer */
    '#race-root .rx-footer{display:flex;align-items:center;gap:var(--sp-4);padding:var(--sp-3) var(--sp-6);border-top:1px solid var(--line);background:var(--glass-strong,rgba(14,15,18,.9));backdrop-filter:saturate(160%) blur(14px);-webkit-backdrop-filter:saturate(160%) blur(14px)}',
    '#race-root .rx-summary{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0}',
    '#race-root .rx-summary b{font-family:var(--font);font-size:var(--fs-md);font-weight:650;color:var(--text-strong);margin-right:var(--sp-1)}',
    '#race-root .rx-footer .rx-btn.big{margin-left:auto;min-width:200px;justify-content:center}',
    /* ---------------- loading / grid */
    '#race-root .rx-loading{position:absolute;inset:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,440px);gap:28px;padding:48px 56px;',
    'background:linear-gradient(90deg,rgba(5,6,7,.94) 0%,rgba(5,6,7,.78) 55%,rgba(5,6,7,.9) 100%);animation:rx-fade .3s ease}',
    '#race-root .rx-load-left{display:flex;flex-direction:column;justify-content:flex-end;gap:18px;min-width:0}',
    '#race-root .rx-load-title{font-size:clamp(44px,7vw,96px)}',
    '#race-root .rx-load-title span{color:var(--rx-accent)}',
    '#race-root .rx-progress{display:flex;flex-direction:column;gap:7px;font-size:var(--fs-sm);color:var(--rx-dim);max-width:420px}',
    '#race-root .rx-progress div{display:flex;align-items:center;gap:10px}',
    '#race-root .rx-progress i{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.15);flex:none}',
    '#race-root .rx-progress .is-done i{background:var(--rx-good);box-shadow:0 0 8px var(--rx-good)}',
    '#race-root .rx-progress .is-active i{background:var(--rx-accent);animation:rx-pulse 1s infinite}',
    '#race-root .rx-progress .is-done{color:var(--rx-text)}',
    '#race-root .rx-progress .is-error i{background:var(--rx-bad)}',
    '#race-root .rx-loadbar{height:3px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden;max-width:420px}',
    '#race-root .rx-loadbar i{display:block;height:100%;width:0;background:var(--rx-accent);transition:width .25s}',
    '#race-root .rx-grid-panel{display:flex;flex-direction:column;min-height:0;padding:18px}',
    '#race-root .rx-grid-list{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;margin-top:12px;padding-bottom:12px}',
    '#race-root .rx-grid-slot{position:relative;display:flex;align-items:center;gap:9px;padding:8px 10px 8px 0;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid var(--rx-line);overflow:hidden;animation:rx-slide .4s both}',
    '#race-root .rx-grid-slot:nth-child(even){margin-top:22px;margin-bottom:-22px}',
    '#race-root .rx-grid-slot.is-player{border-color:var(--rx-accent);background:var(--accent-softer,rgba(201,165,107,.07))}',
    '#race-root .rx-grid-slot .rx-livery{width:5px;align-self:stretch;flex:none}',
    '#race-root .rx-grid-pos{font-family:var(--rx-mono);font-size:var(--fs-xs);color:var(--rx-dim);width:22px;text-align:right;flex:none}',
    '#race-root .rx-grid-who{min-width:0;flex:1}',
    '#race-root .rx-grid-who b{display:block;font-size:var(--fs-sm);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#race-root .rx-grid-who small{display:block;font-size:var(--fs-2xs);color:var(--rx-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#race-root .rx-carnum{flex:none;min-width:26px;height:20px;padding:0 4px;border-radius:4px;display:grid;place-items:center;font-size:var(--fs-xs);font-weight:800;font-family:var(--rx-mono)}',
    '#race-root .rx-go-row{display:flex;align-items:center;gap:14px;margin-top:6px}',
    /* ---------------- race overlays */
    '#race-root .rx-race{position:absolute;inset:0;pointer-events:none}',
    '#race-root .rx-race>*{pointer-events:auto}',
    '#race-root .rx-quickbar{position:absolute;top:50%;right:12px;transform:translateY(-50%);display:flex;flex-direction:column;gap:6px;opacity:.45;transition:opacity .2s}',
    '#race-root .rx-quickbar:hover{opacity:1}',
    /* multiplayer: ping / drivers / sync pill, end-of-session banner, pause-menu player list */
    '#race-root .rx-net{position:absolute;left:50%;top:10px;transform:translateX(-50%);display:flex;align-items:center;gap:7px;padding:4px 11px;border-radius:999px;background:rgba(8,9,11,.66);border:1px solid var(--rx-line-2);font-size:var(--fs-xs);font-weight:600;letter-spacing:.02em;color:var(--rx-text);pointer-events:none;white-space:nowrap;font-variant-numeric:tabular-nums;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}',
    '#race-root .rx-net.is-drift{left:auto;right:12px;transform:none}',
    '#race-root .rx-net i{width:7px;height:7px;border-radius:50%;background:var(--rx-good);box-shadow:0 0 6px currentColor}',
    '#race-root .rx-net.q-fair i{background:var(--rx-warn)}#race-root .rx-net.q-poor i{background:var(--rx-bad)}',
    '#race-root .rx-net-banner{position:absolute;left:50%;top:44px;transform:translateX(-50%);padding:10px 16px;border-radius:10px;background:rgba(8,9,11,.86);border:1px solid var(--rx-bad);color:var(--rx-text);font-weight:700;font-size:var(--fs-sm);pointer-events:none}',
    '#race-root .rx-net-card{margin:4px 0 14px}#race-root .rx-net-card .rx-net{margin:6px 0 8px;transform:none;display:inline-flex}',
    '#race-root .rx-net-list{display:flex;flex-direction:column;gap:4px}',
    '#race-root .rx-net-row{display:flex;justify-content:space-between;gap:10px;padding:6px 10px;border-radius:8px;background:rgba(255,255,255,.04);font-size:var(--fs-sm)}',
    '#race-root .rx-net-row.is-me{border-left:3px solid var(--rx-accent)}#race-root .rx-net-row.is-off{opacity:.5}',
    // portrait phones: the top centre is taken by the leaderboard and the position box (the pill covered P2/3 and
    // LEADER); park it bottom-left, above the pedals and the steering pad
    '@media (orientation:portrait) and (max-width:600px){#race-root .rx-net{top:auto;bottom:calc(214px + env(safe-area-inset-bottom,0px));left:12px;right:auto;transform:none}}',
    '#race-root .rx-quickbar .rx-btn{background:rgba(0,0,0,.45);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}',
    '#race-root .rx-lights{position:absolute;left:50%;top:14%;transform:translateX(-50%);display:flex;gap:10px;padding:14px 18px;border-radius:14px;',
    'background:linear-gradient(180deg,#141414,#050505);border:1px solid rgba(255,255,255,.1);box-shadow:0 20px 40px rgba(0,0,0,.7);pointer-events:none;transition:opacity .4s}',
    '#race-root .rx-lights.is-hidden{opacity:0}',
    '#race-root .rx-light{width:44px;display:flex;flex-direction:column;gap:7px;padding:7px;border-radius:9px;background:#0b0b0b;border:1px solid #222}',
    '#race-root .rx-light i{display:block;width:30px;height:30px;border-radius:50%;background:#2a0b0b;box-shadow:inset 0 2px 6px rgba(0,0,0,.8)}',
    '#race-root .rx-light.on i{background:radial-gradient(circle at 40% 35%,#ff8a80,#ff1a1a 45%,#a00000);box-shadow:0 0 18px #ff2a2a,0 0 40px rgba(255,0,0,.5)}',
    '#race-root .rx-lights.go .rx-light i{background:radial-gradient(circle at 40% 35%,#b9ffd0,#22e06b 45%,#0a8a3a);box-shadow:0 0 18px #22e06b}',
    /* phone portrait: the canvas HUD's tower, timing + sector boxes and minimap fill the top third, so the start
       lights sit smaller, below them (they used to cover the sector boxes) */
    '@media (orientation:portrait) and (max-width:600px){#race-root .rx-lights{top:31%;transform:translateX(-50%) scale(.72);transform-origin:50% 0}}',
    '#race-root .rx-go{position:absolute;left:50%;top:32%;transform:translate(-50%,-50%);font-size:clamp(60px,12vw,150px);color:var(--hud-ink);text-shadow:0 0 40px rgba(34,224,107,.8);pointer-events:none;animation:rx-go .9s ease-out forwards}',
    '#race-root .rx-feed{position:absolute;left:50%;bottom:22%;transform:translateX(-50%);display:flex;flex-direction:column-reverse;align-items:center;gap:6px;pointer-events:none;width:min(560px,90vw)}',
    '#race-root .rx-feed-item{display:flex;align-items:center;gap:10px;padding:8px 14px;border-radius:9px;background:rgba(8,9,11,.82);border:1px solid var(--rx-line-2);',
    'border-left:3px solid var(--rx-accent);font-size:var(--fs-sm);font-weight:600;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);animation:rx-feed-in .3s ease both;transition:opacity .5s,transform .5s}',
    '#race-root .rx-feed-item.purple{border-left-color:var(--rx-purple)}#race-root .rx-feed-item.bad{border-left-color:var(--rx-bad)}',
    '#race-root .rx-feed-item.good{border-left-color:var(--rx-good)}#race-root .rx-feed-item.is-out{opacity:0;transform:translateY(8px)}',
    '#race-root .rx-feed-item .rx-eyebrow{font-size:var(--fs-2xs)}',
    '#race-root .rx-hints{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;flex-wrap:wrap;justify-content:center;gap:6px 14px;padding:8px 14px;border-radius:10px;',
    'background:rgba(0,0,0,.55);border:1px solid var(--rx-line);font-size:var(--fs-xs);color:var(--rx-dim);pointer-events:none;transition:opacity .8s;max-width:92vw}',
    '#race-root .rx-hints span{display:inline-flex;align-items:center;gap:5px}',
    '#race-root .rx-hints.is-hidden{opacity:0}',
    '#race-root .rx-finish{position:absolute;left:0;right:0;top:20%;display:flex;flex-direction:column;align-items:center;gap:10px;pointer-events:none;animation:rx-fade .5s ease}',
    '#race-root .rx-finish-flag{width:min(520px,80vw);height:22px;background:repeating-conic-gradient(#fff 0 25%,#111 0 50%) 0 0/22px 22px;transform:skewX(-14deg);box-shadow:0 10px 30px rgba(0,0,0,.6)}',
    '#race-root .rx-finish-text{font-size:clamp(40px,7vw,84px);text-shadow:0 6px 30px rgba(0,0,0,.8)}',
    '#race-root .rx-finish-sub{font-size:var(--fs-md);color:var(--rx-dim);background:rgba(0,0,0,.6);padding:6px 14px;border-radius:999px}',
    '#race-root .rx-fallback-note{position:absolute;left:50%;transform:translateX(-50%);bottom:62px;white-space:nowrap;font-size:var(--fs-xs);color:var(--rx-warn);background:rgba(0,0,0,.6);padding:6px 10px;border-radius:8px;border:1px solid rgba(255,176,32,.3);pointer-events:none}',
    /* touch */
    '#race-root .rx-touch{position:absolute;inset:auto 0 0 0;height:min(42vh,260px);pointer-events:none;display:flex;justify-content:space-between;align-items:flex-end;padding:0 16px 18px;gap:12px}',
    '#race-root .rx-touch>*{pointer-events:auto;touch-action:none}',
    '#race-root .rx-steerpad{position:relative;width:min(46vw,300px);height:96px;border-radius:48px;background:var(--hud-panel-soft,rgba(0,0,0,.35));border:1px solid var(--hud-line,rgba(255,255,255,.14));backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}',
    '#race-root .rx-steerpad::before{content:"‹  ›";position:absolute;inset:0;display:grid;place-items:center;font-size:var(--fs-title);color:rgba(255,255,255,.18);letter-spacing:40px;padding-left:40px}',
    '#race-root .rx-knob{position:absolute;top:50%;left:50%;width:76px;height:76px;margin:-38px 0 0 -38px;border-radius:50%;background:radial-gradient(circle at 40% 35%,rgba(255,255,255,.35),rgba(255,255,255,.08));border:1px solid rgba(255,255,255,.3);box-shadow:0 8px 20px rgba(0,0,0,.5);will-change:transform}',
    '#race-root .rx-pedals{display:flex;align-items:flex-end;gap:10px}',
    '#race-root .rx-pedal{width:74px;height:140px;border-radius:16px;border:1px solid var(--hud-line,rgba(255,255,255,.16));background:var(--hud-panel-soft,rgba(0,0,0,.35));font:800 var(--fs-xs) var(--hud-font);display:flex;align-items:flex-end;justify-content:center;padding-bottom:12px;font-size:var(--fs-xs);letter-spacing:.14em;font-weight:800;color:var(--hud-dim,rgba(255,255,255,.7));position:relative;overflow:hidden;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}',
    '#race-root .rx-pedal.gas{height:170px}',
    '#race-root .rx-pedal .rx-fill{position:absolute;left:0;right:0;bottom:0;height:0;opacity:.45}',
    '#race-root .rx-pedal.gas .rx-fill{background:linear-gradient(0deg,var(--rx-good),transparent)}',
    '#race-root .rx-pedal.brake .rx-fill{background:linear-gradient(0deg,var(--rx-bad),transparent)}',
    '#race-root .rx-pedal span{position:relative}',
    '#race-root .rx-touch-aux{display:flex;flex-direction:column;gap:8px}',
    '#race-root .rx-tbtn{width:58px;height:46px;border-radius:12px;border:1px solid var(--hud-line,rgba(255,255,255,.16));background:var(--hud-panel-soft,rgba(0,0,0,.4));font:800 var(--fs-xs) var(--hud-font);font-size:var(--fs-xs);font-weight:800;letter-spacing:.08em;color:var(--hud-dim,rgba(255,255,255,.75));display:grid;border-radius:var(--hud-radius,12px);place-items:center}',
    '#race-root .rx-tbtn.is-down,#race-root .rx-pedal.is-down{border-color:var(--rx-accent);color:var(--hud-ink,#fff);background:var(--hud-press,rgba(255,255,255,.22))}',
    /* ---------------- modal (pause / results / error) */
    '#race-root .rx-modal{position:absolute;inset:0;display:grid;place-items:center;padding:24px;background:radial-gradient(80% 80% at 50% 40%,rgba(0,0,0,.45),rgba(0,0,0,.82));backdrop-filter:blur(7px) saturate(.7);-webkit-backdrop-filter:blur(7px) saturate(.7);animation:rx-fade .2s ease}',
    '#race-root .rx-pause{width:min(880px,100%);display:grid;grid-template-columns:300px 1fr;overflow:hidden}',
    '#race-root .rx-pause-menu{padding:26px 22px;display:flex;flex-direction:column;gap:8px;border-right:1px solid var(--rx-line);background:rgba(0,0,0,.25)}',
    '#race-root .rx-pause-menu h2{margin:0 0 4px;font-size:var(--fs-title)}',
    '#race-root .rx-pause-menu .rx-btn{justify-content:flex-start;padding:12px 14px}',
    '#race-root .rx-pause-menu .rx-btn.is-focus{border-color:var(--rx-accent)}',
    '#race-root .rx-pause-side{padding:24px;display:flex;flex-direction:column;gap:18px;max-height:min(80vh,640px)}',
    '#race-root .rx-pause-status{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
    '#race-root .rx-tile{padding:12px;border-radius:10px;border:1px solid var(--rx-line);background:rgba(255,255,255,.025)}',
    '#race-root .rx-tile .rx-stat-v{font-size:var(--fs-xl)}',
    '#race-root .rx-tile.accent{border-color:var(--accent-ring,rgba(201,165,107,.45));background:var(--accent-softer,rgba(201,165,107,.07))}',
    '#race-root .rx-tile.purple .rx-stat-v{color:var(--rx-purple)}',
    /* results */
    '#race-root .rx-results{position:absolute;inset:0;display:grid;grid-template-rows:auto 1fr auto;animation:rx-fade .35s ease;background:linear-gradient(180deg,color-mix(in srgb,var(--bg) 90%,transparent),color-mix(in srgb,var(--bg) 97%,transparent));backdrop-filter:blur(10px) saturate(.7);-webkit-backdrop-filter:blur(10px) saturate(.7)}',
    '#race-root .rx-res-head{display:flex;align-items:flex-end;gap:28px;padding:28px 32px 18px;border-bottom:1px solid var(--rx-line)}',
    '#race-root .rx-res-pos{font-size:clamp(64px,9vw,120px);color:var(--rx-accent);text-shadow:0 10px 40px var(--accent-ring,rgba(201,165,107,.45))}',
    '#race-root .rx-res-pos small{font-size:.35em;color:var(--rx-text);margin-left:6px}',
    '#race-root .rx-res-title{display:flex;flex-direction:column;gap:6px;padding-bottom:10px}',
    '#race-root .rx-res-title h2{margin:0;font-size:var(--fs-title);font-weight:var(--fw-title);letter-spacing:var(--tracking-title);line-height:1.08}',
    '#race-root .rx-badges{display:flex;flex-wrap:wrap;gap:8px;margin-left:auto;padding-bottom:12px}',
    '#race-root .rx-badge{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;font-size:var(--fs-sm);font-weight:800;letter-spacing:.1em;text-transform:uppercase;',
    'background:linear-gradient(90deg,var(--accent-soft,rgba(201,165,107,.14)),var(--accent-softer,rgba(201,165,107,.07)));border:1px solid var(--rx-accent);color:var(--rx-text);animation:rx-pop .5s cubic-bezier(.2,1.6,.4,1) both}',
    '#race-root .rx-badge.purple{background:linear-gradient(90deg,rgba(178,107,255,.3),rgba(178,107,255,.08));border-color:var(--rx-purple)}',
    '#race-root .rx-badge.good{background:linear-gradient(90deg,rgba(61,220,132,.25),rgba(61,220,132,.06));border-color:var(--rx-good)}',
    '#race-root .rx-res-main{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(320px,1fr);gap:20px;padding:20px 32px;min-height:0}',
    '#race-root .rx-table-wrap{min-height:0;padding:6px 0}',
    '#race-root table.rx-table{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}',
    '#race-root .rx-table th{position:sticky;top:0;background:var(--panel-2,#111215);text-align:left;font-size:var(--fs-2xs);letter-spacing:.16em;text-transform:uppercase;color:var(--rx-dim);font-weight:700;padding:10px 12px;border-bottom:1px solid var(--rx-line)}',
    '#race-root .rx-table td{padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.045);white-space:nowrap}',
    '#race-root .rx-table tr{animation:rx-slide .35s both}',
    '#race-root .rx-table tr.is-player td{background:var(--accent-softer,rgba(201,165,107,.07))}',
    '#race-root .rx-table tr.is-player td:first-child{box-shadow:inset 3px 0 0 var(--rx-accent)}',
    '#race-root .rx-table .r{text-align:right}',
    '#race-root .rx-table .pos{font-weight:700;font-size:var(--fs-md);width:44px;font-variant-numeric:tabular-nums}',
    '#race-root .rx-table .who{display:flex;align-items:center;gap:10px}',
    '#race-root .rx-table .who small{display:block;color:var(--rx-dim);font-size:var(--fs-xs)}',
    '#race-root .rx-purple{color:var(--rx-purple)}#race-root .rx-bad{color:var(--rx-bad)}#race-root .rx-good{color:var(--rx-good)}#race-root .rx-dim{color:var(--rx-dim)}',
    '#race-root .rx-res-side{display:flex;flex-direction:column;gap:14px;min-height:0}',
    '#race-root .rx-res-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}',
    '#race-root .rx-chart{position:relative;padding:14px 14px 10px}',
    '#race-root .rx-chart canvas{display:block;width:100%;height:190px}',
    '#race-root .rx-chart.small canvas{height:120px}',
    '#race-root .rx-chart-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}',
    '#race-root .rx-legend{display:flex;gap:12px;font-size:var(--fs-xs);color:var(--rx-dim)}',
    '#race-root .rx-legend i{display:inline-block;width:12px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle}',
    '#race-root .rx-res-foot{display:flex;align-items:center;gap:12px;padding:14px 32px;border-top:1px solid var(--rx-line);background:var(--glass-strong,rgba(14,15,18,.9));backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}',
    '#race-root .rx-res-foot .rx-spacer{flex:1}',
    '#race-root .rx-res-foot .rx-res-keys{white-space:nowrap}@media (max-width:1360px){#race-root .rx-res-foot .rx-res-keys{display:none}}',   // keyboard hint: never wraps into a 3-line column
    /* error */
    '#race-root .rx-error{width:min(620px,100%);padding:26px}',
    '#race-root .rx-error pre{max-height:180px;overflow:auto;font-family:var(--rx-mono);font-size:var(--fs-xs);color:var(--rx-dim);background:rgba(0,0,0,.4);padding:10px;border-radius:8px;white-space:pre-wrap}',
    /* toast */
    '#race-root .rx-toasts{position:absolute;top:18px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none;z-index:5}',
    '#race-root .rx-toast{padding:8px 16px;border-radius:999px;background:var(--glass-strong,rgba(10,11,13,.9));border:1px solid var(--rx-line-2);font-size:var(--fs-sm);font-weight:600;animation:rx-feed-in .25s both;transition:opacity .4s}',
    /* animations */
    '@keyframes rx-fade{from{opacity:0}to{opacity:1}}',
    '@keyframes rx-slide{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:none}}',
    '@keyframes rx-feed-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}',
    '@keyframes rx-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
    '@keyframes rx-pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}',
    '@keyframes rx-go{0%{opacity:0;transform:translate(-50%,-50%) scale(.6)}20%{opacity:1;transform:translate(-50%,-50%) scale(1.08)}70%{opacity:1}100%{opacity:0;transform:translate(-50%,-50%) scale(1.25)}}',
    '@media (prefers-reduced-motion:reduce){#race-root *{animation-duration:.01ms!important;transition-duration:.01ms!important}}',
    /* responsive */
    /* stacked layouts: rows size to their content (min-height:auto) and columns never grow past the viewport (minmax(0,1fr)) */
    '#race-root .rx-setup,#race-root .rx-results{grid-template-columns:minmax(0,1fr)}',
    '@media (max-width:1100px){#race-root .rx-setup-main{grid-template-columns:minmax(0,1fr);grid-auto-rows:max-content;align-content:start;overflow:auto}#race-root .rx-setup-main>.rx-col{min-height:auto}#race-root .rx-col.rx-scroll{overflow:visible}',
    '#race-root .rx-steps{flex-wrap:nowrap;justify-content:center;gap:4px}#race-root .rx-step{padding:4px 8px;letter-spacing:.12em}',
    '#race-root .rx-res-main{grid-template-columns:minmax(0,1fr);grid-auto-rows:max-content;overflow:auto}#race-root .rx-res-main>*{min-height:auto}#race-root .rx-res-head{flex-wrap:wrap;gap:16px 28px}#race-root .rx-res-foot{flex-wrap:wrap}',
    '#race-root .rx-loading{grid-template-columns:minmax(0,1fr);padding:28px;overflow:auto}',
    '#race-root .rx-modal{place-items:start center;overflow:auto}',
    '#race-root .rx-pause{grid-template-columns:minmax(0,1fr);max-height:calc(100vh - 48px);max-height:calc(100dvh - 48px);overflow:auto}#race-root .rx-pause-side{max-height:none}',
    '#race-root .rx-pause-menu{border-right:0;border-bottom:1px solid var(--rx-line)}}',
    '@media (max-width:900px){#race-root .rx-topbar{gap:10px}#race-root .rx-step{padding:4px 6px;letter-spacing:.06em;font-size:var(--fs-2xs)}#race-root .rx-step b{margin-right:3px}}',
    '@media (max-width:720px){#race-root .rx-featured{grid-template-columns:1fr}#race-root .rx-featured-map{min-height:220px;border-right:0;border-bottom:1px solid var(--rx-line)}',
    '#race-root .rx-topbar,#race-root .rx-footer,#race-root .rx-setup-main{padding-left:14px;padding-right:14px}#race-root .rx-footer{flex-wrap:wrap}#race-root .rx-footer .rx-btn.big{width:100%}',
    '#race-root .rx-car{grid-template-columns:1fr}#race-root .rx-toggles,#race-root .rx-two{grid-template-columns:1fr}#race-root .rx-res-head{flex-wrap:wrap;padding:18px}',
    '#race-root .rx-res-main,#race-root .rx-res-foot{padding-left:14px;padding-right:14px}#race-root .rx-res-foot{flex-wrap:wrap}#race-root .rx-pause-status,#race-root .rx-res-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}',
    '#race-root .rx-hints{display:none}}',
    /* ---------------- discipline chooser (first step: DRIFT / RACE) */
    '#race-root .rx-disc{position:absolute;inset:0;display:grid;grid-template-rows:auto 1fr auto;animation:rx-fade .35s ease}',
    '#race-root .rx-disc-main{display:grid;grid-template-columns:1fr 1fr;gap:22px;padding:26px 28px;min-height:0}',
    '#race-root .rx-disc-card{position:relative;overflow:hidden;text-align:left;cursor:pointer;border-radius:20px;border:1px solid var(--rx-line-2);padding:30px 30px 26px;',
    'display:flex;flex-direction:column;justify-content:flex-end;gap:10px;min-height:0;color:var(--rx-text);',
    'background:var(--surface-grad,none),var(--panel,rgba(10,11,13,.95));transition:transform .2s cubic-bezier(.2,.8,.2,1),border-color .2s,box-shadow .2s}',
    '#race-root .rx-disc-card:hover,#race-root .rx-disc-card:focus-visible{transform:translateY(-4px);border-color:var(--rx-disc,var(--rx-accent));box-shadow:0 30px 70px -30px var(--rx-disc,var(--rx-accent));outline:none}',
    '#race-root .rx-disc-card.is-last::after{content:"Last played";position:absolute;top:18px;right:18px;font-size:var(--fs-2xs);letter-spacing:.2em;text-transform:uppercase;color:var(--rx-disc);border:1px solid var(--rx-disc);border-radius:999px;padding:4px 10px}',
    '#race-root .rx-disc-art{position:absolute;inset:0;z-index:0;opacity:.9;pointer-events:none}',
    '#race-root .rx-disc-art svg{width:100%;height:100%;display:block}',
    '#race-root .rx-disc-art::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(8,9,11,.92) 0%,rgba(8,9,11,.7) 38%,rgba(8,9,11,.15) 70%,transparent),linear-gradient(0deg,rgba(8,9,11,.85),transparent 55%)}',
    '#race-root .rx-disc-card>*:not(.rx-disc-art){position:relative;z-index:1}',
    '#race-root .rx-disc-name{font-size:clamp(54px,8vw,112px);font-family:var(--serif);font-weight:600;letter-spacing:-.03em;line-height:.9;',
    'background:linear-gradient(180deg,var(--hud-ink),var(--rx-disc,var(--rx-accent)));-webkit-background-clip:text;background-clip:text;color:transparent}',
    '#race-root .rx-disc-desc{max-width:44ch;color:var(--hud-dim);font-size:var(--fs-md)}',
    '#race-root .rx-disc-list{list-style:none;margin:4px 0 6px;padding:0;display:grid;gap:5px;color:var(--rx-dim);font-size:var(--fs-sm)}',
    '#race-root .rx-disc-list li::before{content:"";display:inline-block;width:14px;height:2px;margin-right:9px;vertical-align:middle;background:var(--rx-disc,var(--rx-accent));transform:skewX(-30deg)}',
    '#race-root .rx-disc-go{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--rx-disc,var(--rx-accent))}',
    '#race-root .rx-disc-foot{display:flex;align-items:center;gap:14px;padding:14px 28px;border-top:1px solid var(--rx-line);color:var(--rx-dim);font-size:var(--fs-sm)}',
    '#race-root .rx-disc-foot .rx-seg{margin-left:auto}',
    '@media (max-width:820px){#race-root .rx-disc-main{grid-template-columns:1fr;overflow:auto}#race-root .rx-disc-card{min-height:300px}}',
    '#race-root .rx-step.is-link{cursor:pointer;pointer-events:auto}',
    '#race-root .rx-step.is-link:hover{color:var(--rx-text)}',
    '#race-root .rx-chip.drift{color:var(--mode-drift);border-color:color-mix(in srgb,var(--mode-drift) 45%,transparent)}',
    '#race-root .rx-chip.arcade{color:var(--mode-arcade);border-color:color-mix(in srgb,var(--mode-arcade) 50%,transparent)}',
    '#race-root .rx-arcade-handling{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--mode-arcade) 40%,transparent);border-radius:var(--radius-sm);color:var(--mode-arcade);background:var(--mode-arcade-soft);font-size:var(--fs-sm);font-weight:600}',
    '#race-root .rx-arcade-intro{display:flex;flex-direction:column;gap:6px;padding:12px 14px;margin-bottom:12px;border-color:color-mix(in srgb,var(--mode-arcade) 35%,var(--rx-line-2))}',
    '#race-root .rx-arcade-intro p{margin:0;font-size:var(--fs-sm);line-height:1.45;color:var(--rx-dim)}',
    /* ---------------- drift results */
    '#race-root .rx-drift-score{display:flex;align-items:flex-end;gap:22px;flex-wrap:wrap}',
    '#race-root .rx-drift-total{font-size:clamp(48px,7vw,92px);font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.03em;line-height:.9;color:var(--text-strong)}',
    '#race-root .rx-medal{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;font-size:var(--fs-sm);border:1px solid currentColor}',
    '#race-root .rx-medal i{width:14px;height:14px;border-radius:50%;background:currentColor;box-shadow:0 0 14px currentColor}',
    '#race-root .rx-ladder{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:14px}',
    '#race-root .rx-ladder>div{border:1px solid var(--rx-line);border-radius:10px;padding:9px 11px;opacity:.55}',
    '#race-root .rx-ladder>div.got{opacity:1;border-color:currentColor;background:rgba(255,255,255,.03)}',
    '#race-root .rx-ladder b{display:block;font-size:var(--fs-2xs);letter-spacing:.18em;text-transform:uppercase}',
    '@media (max-width:700px){#race-root .rx-ladder{grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '#race-root .rx-drift-panel{padding:22px 24px;display:flex;flex-direction:column;gap:14px;min-height:0}',
    '#race-root .rx-drift-bar{height:8px;border-radius:8px;background:rgba(255,255,255,.07);overflow:hidden}',
    '#race-root .rx-drift-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--mode-drift),var(--warn))}',
    /* ---------------- phones / tablets (touch only; desktop untouched): 40px+ tap targets, safe areas, no hover-only UI,
       no zoom / selection / callout while driving, scroll-as-a-page setup + results on short landscape screens */
    '#race-root .rx-rotate{display:none}',
    '@media (pointer:coarse){',
    '#race-root .rx-canvas,#race-root .rx-race,#race-root .rx-touch,#race-root .rx-touch *{touch-action:none;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}',
    '#race-root .rx-quickbar{opacity:.92;right:max(10px,env(safe-area-inset-right))}#race-root .rx-quickbar .rx-btn.icon{width:44px;min-height:44px;height:44px}',
    '#race-root .rx-hints,#race-root span.rx-dim:has(>.rx-kbd),#race-root .rx-btn>.rx-kbd{display:none}',
    '#race-root .rx-btn,#race-root .rx-seg-btn,#race-root .cb-tab{min-height:44px}',
    '#race-root .rx-stepper .rx-btn{width:44px;height:44px}#race-root .rx-quick{gap:6px}#race-root .rx-quick button{min-width:44px;min-height:40px;padding:4px 10px;font-size:var(--fs-sm)}',
    '#race-root .rx-step{min-height:40px;display:inline-flex;align-items:center}#race-root .rx-steps{align-items:center}#race-root .rx-footer>.rx-btn:last-child{margin-left:auto!important}',
    '#race-root details.rx-details summary{min-height:44px}#race-root .rx-range{height:40px}',
    '#race-root .rx-modal{z-index:8;padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}',
    '#race-root .rx-touch{padding:0 max(16px,env(safe-area-inset-right)) max(18px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}',
    '#race-root .rx-topbar,#race-root .rx-footer,#race-root .rx-setup-main,#race-root .rx-res-head,#race-root .rx-res-main,#race-root .rx-res-foot,#race-root .rx-disc-main,#race-root .rx-disc-foot{padding-left:max(28px,env(safe-area-inset-left));padding-right:max(28px,env(safe-area-inset-right))}',
    '#race-root .rx-footer,#race-root .rx-res-foot{padding-bottom:max(14px,env(safe-area-inset-bottom))}',
    /* "rotate your phone" prompt while driving in portrait: dims the view but never blocks it (touches pass through) */
    '#race-root .rx-rotate{position:absolute;inset:0;z-index:5;align-items:center;justify-content:center;padding:24px;background:rgba(5,5,7,.55);pointer-events:none}',
    '#race-root .rx-rotate-card{pointer-events:auto;width:min(300px,100%);display:flex;flex-direction:column;align-items:center;gap:12px;padding:22px 20px 18px;border-radius:18px;text-align:center;background:rgba(14,15,18,.94);border:1px solid var(--accent-ring,rgba(201,165,107,.45));box-shadow:0 24px 60px rgba(0,0,0,.6)}',
    '#race-root .rx-rotate-card b{font-size:var(--fs-lg);line-height:1.2}#race-root .rx-rotate-card p{margin:0;color:var(--rx-dim);font-size:var(--fs-sm);line-height:1.45}',
    '#race-root .rx-rotate-ico{color:var(--rx-accent);animation:rx-rot-hint 2.4s ease-in-out infinite}',
    '@keyframes rx-rot-hint{0%,25%{transform:rotate(0)}55%,85%{transform:rotate(-90deg)}100%{transform:rotate(0)}}',
    '#race-root .rx-rotate-card .rx-btn{min-height:44px;padding:0 18px}}',
    '@media (pointer:coarse) and (orientation:portrait){#race-root .rx-rotate{display:flex}html.pw-tilt-on #race-root .rx-rotate,#race-root .rx-rotate.is-dismissed{display:none}}',
    '@media (pointer:coarse) and (max-width:720px){#race-root .rx-topbar,#race-root .rx-footer,#race-root .rx-setup-main,#race-root .rx-res-head,#race-root .rx-res-main,#race-root .rx-res-foot,#race-root .rx-disc-main,#race-root .rx-disc-foot{padding-left:max(14px,env(safe-area-inset-left));padding-right:max(14px,env(safe-area-inset-right))}}',
    '@media (pointer:coarse) and (max-width:560px){#race-root .rx-steps{display:none}#race-root .rx-topbar>.rx-btn{margin-left:auto}#race-root .rx-topbar{gap:8px}}',
    /* short landscape phones: the whole setup / results screen scrolls (header scrolls away, the action bar stays docked) */
    '@media (pointer:coarse) and (max-height:500px){',
    '#race-root .rx-setup,#race-root .rx-results{display:block;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}',
    '#race-root .rx-setup-main,#race-root .rx-res-main{overflow:visible}',
    '#race-root .rx-footer,#race-root .rx-res-foot{position:sticky;bottom:0;z-index:2;padding-top:8px;padding-bottom:max(8px,env(safe-area-inset-bottom));background:rgba(14,15,18,.94)}',
    '#race-root .rx-footer .rx-summary{display:none}#race-root .rx-res-head{padding-top:14px;padding-bottom:12px}',
    '#race-root .rx-res-foot{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}#race-root .rx-res-foot>*{flex:0 0 auto}#race-root .rx-res-foot>.rx-btn.primary{order:-1}#race-root .rx-res-foot{gap:8px}#race-root .rx-res-foot>.rx-btn:not(.primary){padding:0 12px}#race-root .rx-res-foot>.rx-btn:not(.primary) .rx-ico{display:none}',
    '#race-root .rx-touch{padding-bottom:max(12px,env(safe-area-inset-bottom))}#race-root .rx-pedal{height:112px;width:70px}#race-root .rx-pedal.gas{height:128px}',
    '#race-root .rx-quickbar{top:auto;transform:none;flex-direction:row;bottom:calc(max(12px,env(safe-area-inset-bottom)) + 140px)}}',
    /* short landscape phones while driving: the canvas HUD turns its tach into a slim bar at the bottom centre (below the
       car), so the touch controls slim down to leave that band free and the right column stacks, bottom-up: pedals ·
       arcade ITEM / NITRO (+ the webcam GO / COAST / BRAKE chip) · quick buttons; the webcam preview sits above the
       steering pad. All tap targets stay >= 44px, every edge is safe-area aware. */
    '@media (pointer:coarse) and (max-height:500px) and (orientation:landscape){',
    '#race-root .rx-touch{padding-bottom:max(10px,env(safe-area-inset-bottom));gap:8px}',
    '#race-root .rx-steerpad{width:min(34vw,260px);height:84px;border-radius:42px}#race-root .rx-steerpad::before{font-size:var(--fs-2xl);letter-spacing:30px;padding-left:30px}',
    '#race-root .rx-pedals{gap:8px}#race-root .rx-touch-aux{gap:6px}#race-root .rx-tbtn{width:52px;height:44px}',
    '#race-root .rx-pedal{width:64px;height:100px;padding-bottom:10px}#race-root .rx-pedal.gas{height:116px}',
    '#race-root .rx-quickbar{gap:6px;bottom:calc(max(10px,env(safe-area-inset-bottom)) + 192px)}',
    '#race-root .arc-touch{right:max(16px,env(safe-area-inset-right));bottom:calc(max(10px,env(safe-area-inset-bottom)) + 124px);gap:10px}',
    '#race-root .arc-btn.nitro{width:60px;height:60px;font-size:var(--fs-sm)}#race-root .arc-btn.item{width:50px;height:50px}#race-root .arc-btn.item canvas{width:34px;height:34px}',
    'html body .cw-pip{width:150px;left:max(16px,env(safe-area-inset-left));bottom:calc(max(10px,env(safe-area-inset-bottom)) + 94px)}html body .cw-pip .cw-pl{padding:3px 5px;font-size:var(--fs-2xs)}',
    'html body .cw-hud{top:auto;transform:none;right:max(16px,env(safe-area-inset-right));bottom:calc(max(10px,env(safe-area-inset-bottom)) + 128px);min-width:0;flex-direction:row;gap:6px;padding:6px 12px;border-radius:12px}',
    'html body .cw-hud b{font-size:var(--fs-xl)}html body .cw-hud b.is-rev{font-size:var(--fs-2xl)}html body .cw-hud small{display:none}html body .cw-hud .cw-hand svg{width:22px;height:22px}',
    'html body:has(#race-root .arc-touch) .cw-hud{right:calc(max(16px,env(safe-area-inset-right)) + 130px)}}',
    // the Arcade ITEM / NITRO buttons belong to the driving screen only (they stayed over the results table)
    '#race-root:not([data-screen="race"]) .arc-touch{display:none}',
    /* ---------------- screen family (css/styles.css § 18): Race · Drift · Arcade share the Derby / F1 / Drag look; only the mode accent changes */
    '#race-root[data-mode="race"]{--rx-accent:var(--mode-race,#e0412f);--rx-accent-soft:var(--mode-race-soft,rgba(224,65,47,.14))}',
    '#race-root[data-mode="drift"]{--rx-accent:var(--mode-drift,#ff7a2b);--rx-accent-soft:var(--mode-drift-soft,rgba(255,122,43,.14))}',
    '#race-root[data-mode="arcade"]{--rx-accent:var(--mode-arcade,#5b8cff);--rx-accent-soft:var(--mode-arcade-soft,rgba(91,140,255,.15))}',
    /* head: kicker + serif title, then the Race·Drift·Arcade switch, the step pills and "Main menu" */
    '#race-root .rx-headline{display:flex;flex-direction:column;justify-content:center;min-width:0;flex:0 1 auto}',
    '#race-root .rx-headline .mx-kicker{margin:0 0 2px;white-space:nowrap}',
    '#race-root .rx-headline .mx-title{font-size:var(--fs-xl);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '@media (min-width:1200px) and (min-height:821px){#race-root .rx-headline .mx-title{font-size:var(--fs-title)}}',
    '#race-root .rx-topbar{padding-top:var(--sp-3);padding-bottom:var(--sp-3);gap:var(--sp-5)}',
    '#race-root .rx-topbar>.rx-back{margin-left:auto;flex:none}#race-root .rx-steps{margin:0 auto 0 0}',
    '@media (max-width:1100px){#race-root .rx-steps{display:none}}',
    '@media (max-width:720px){#race-root .rx-topbar{flex-wrap:wrap;row-gap:var(--sp-2)}#race-root .rx-headline{order:-1;flex:1 1 100%}}',
    '@media (max-height:500px){#race-root .rx-headline .mx-title{display:none}#race-root .rx-headline{order:0;flex:0 1 auto}#race-root .rx-topbar{flex-wrap:nowrap}}',
    '#race-root .mx-kicker{color:var(--rx-accent)}',
    /* section heads: caps label + numbered step badge in the mode accent; the dash keeps the accent too */
    '#race-root .rx-section-title .mx-step{color:var(--rx-accent);background:var(--rx-accent-soft);border-color:color-mix(in srgb,var(--rx-accent) 35%,transparent)}',
    '#race-root .rx-skew{width:18px;height:2px;border-radius:2px;transform:none;margin-right:var(--sp-1)}',
    /* selected track / stunt card: the mode-accent ring + soft tint (like .mx-card.is-on) */
    '#race-root .rx-track-card.is-selected{border-color:var(--rx-accent);box-shadow:inset 0 0 0 1px var(--rx-accent);background:linear-gradient(160deg,var(--rx-accent-soft),transparent 70%),var(--panel-2)}',
    '#race-root .rx-track-card.is-selected::after{box-shadow:none}',
    /* segmented controls: the .cb-tab-list / .cb-tab look (raised active tab, short accent underline) */
    '#race-root .rx-seg.cb-seg-btns,#race-root .rx-seg .cb-seg-btns{padding:3px;border-radius:12px;box-shadow:none}',
    '#race-root .rx-seg .cb-seg-btn{position:relative;min-height:32px;border-radius:9px;font-size:var(--fs-sm);font-weight:650}',
    '#race-root .rx-seg .cb-seg-btn.is-active{color:var(--text-strong);border-color:var(--line);box-shadow:0 2px 8px -3px rgba(0,0,0,.5)}',
    '[data-theme="light"] #race-root .rx-seg .cb-seg-btn.is-active{background:var(--panel);box-shadow:0 2px 6px -3px rgba(40,32,18,.25)}',
    '#race-root .rx-seg .cb-seg-btn.is-active::after{content:"";position:absolute;left:30%;right:30%;bottom:3px;height:2px;border-radius:2px;background:var(--accent-grad)}',
    '#race-root .rx-quick button.is-active{color:var(--text-strong);border-color:var(--rx-accent);background:var(--rx-accent-soft)}',
    /* pause card = .mx-menu: serif title, full-width menu buttons */
    '#race-root .rx-pause-menu h2{font-size:var(--fs-title);font-weight:var(--fw-title);letter-spacing:var(--tracking-title)}',
    '#race-root .rx-pause-menu .rx-btn{min-height:var(--control-h-lg)}',
    /* kickers sit on a short accent dash (§ 18) */
    '#race-root .rx-eyebrow.mx-kicker{margin:0;letter-spacing:var(--tracking-caps);font-weight:700}',
    '@media (pointer:coarse){#race-root .rx-seg .cb-seg-btn{min-height:44px}#race-root .rx-back{min-width:44px}}',
    /* in-race overlays (lights, feed, hints, quickbar, rotate card) sit on the dark 3D view in both themes: HUD tokens */
    '#race-root .rx-race{--rx-text:var(--hud-ink,#f4f5f7);--rx-dim:var(--hud-dim,rgba(244,245,247,.62));--rx-faint:var(--hud-faint,rgba(244,245,247,.3));--rx-line:var(--hud-line,rgba(255,255,255,.16));--rx-line-2:var(--hud-line,rgba(255,255,255,.16));--text:var(--hud-ink,#f4f5f7);--text-strong:var(--hud-ink,#fff);--text-dim:var(--hud-dim,rgba(244,245,247,.62));color:var(--rx-text)}',
    '#race-root .rx-net,#race-root .rx-net-banner,#race-root .rx-fallback-note{color:var(--hud-ink,#f4f5f7)}',
    /* the loading / grid screen follows the theme like the results screen (it covers the 3D view) */
    '#race-root .rx-loading{background:linear-gradient(90deg,color-mix(in srgb,var(--bg) 94%,transparent) 0%,color-mix(in srgb,var(--bg) 78%,transparent) 55%,color-mix(in srgb,var(--bg) 90%,transparent) 100%)}',
  ].join('\n');

  /* ----------------------------------------------------------- canvas utils */
  function fitCanvas(canvas, w, hgt) {
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    w = w || canvas.clientWidth || 300; hgt = hgt || canvas.clientHeight || 150;
    var W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(hgt * dpr));
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: hgt, dpr: dpr };
  }
  function cssVar(name, fallback) {
    try {
      var root = document.getElementById('race-root') || document.documentElement;
      var v = getComputedStyle(root).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }
  function accentColor() { return cssVar('--rx-accent', '') || cssVar('--accent', '') || '#c8a24a'; }

  /** Draw a track minimap (procedural) into a canvas. */
  function drawTrackMap(canvas, def, opts) {
    opts = opts || {};
    var st = trackStats(def);
    var f = fitCanvas(canvas);
    var ctx = f.ctx, w = f.w, hh = f.h;
    ctx.clearRect(0, 0, w, hh);
    if (!st || st.poly.length < 3) {
      ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.font = '12px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('No geometry', w / 2, hh / 2);
      return;
    }
    var pad = opts.padding != null ? opts.padding : 14;
    var b = st.bounds;
    var sc = Math.min((w - pad * 2) / Math.max(1, b.w), (hh - pad * 2) / Math.max(1, b.h));
    var ox = (w - b.w * sc) / 2, oy = (hh - b.h * sc) / 2;
    function X(p) { return ox + (p[0] - b.minX) * sc; }
    function Y(p) { return hh - (oy + (p[1] - b.minY) * sc); } // y-up world
    var poly = st.poly, theme = def.theme || {};
    var widthPx = clamp((def.width_m || 12) * sc, opts.minWidth || 2.5, opts.maxWidth || 9);
    function path() {
      ctx.beginPath();
      for (var i = 0; i < poly.length; i++) { var x = X(poly[i]), y = Y(poly[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.closePath();
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // glow / shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
    path(); ctx.strokeStyle = 'rgba(0,0,0,.9)'; ctx.lineWidth = widthPx + 5; ctx.stroke();
    ctx.restore();
    path(); ctx.strokeStyle = opts.highlight ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.16)'; ctx.lineWidth = widthPx + 2; ctx.stroke();
    path(); ctx.strokeStyle = theme.asphalt || '#2d3036'; ctx.lineWidth = widthPx; ctx.stroke();
    var acc = opts.accent || accentColor();
    if (opts.sectors) {
      var cols = [acc, '#e9e6df', '#6fa8ff'];
      var total = 0, seg = [], i;
      for (i = 0; i < poly.length; i++) { var a = poly[i], c = poly[(i + 1) % poly.length]; seg.push(Math.hypot(c[0] - a[0], c[1] - a[1])); total += seg[i]; }
      var acc0 = 0;
      ctx.lineWidth = Math.max(1.6, widthPx * 0.3);
      for (i = 0; i < poly.length; i++) {
        var sIdx = Math.min(2, Math.floor(acc0 / total * 3));
        ctx.beginPath(); ctx.moveTo(X(poly[i]), Y(poly[i])); var nx = poly[(i + 1) % poly.length]; ctx.lineTo(X(nx), Y(nx));
        ctx.strokeStyle = cols[sIdx]; ctx.stroke();
        acc0 += seg[i];
      }
    } else {
      path(); ctx.strokeStyle = opts.highlight ? acc : 'rgba(255,255,255,.55)';
      ctx.lineWidth = Math.max(1, widthPx * 0.22); ctx.setLineDash(opts.highlight ? [] : [3, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    // start/finish: perpendicular chequered tick at sample 0
    var p0 = poly[0], p1 = poly[1 % poly.length];
    var ang = Math.atan2(-(Y(p1) - Y(p0)), X(p1) - X(p0));
    ctx.save();
    ctx.translate(X(p0), Y(p0)); ctx.rotate(-ang);
    var L = widthPx + 8, sq = Math.max(2, L / 6);
    for (var r = 0; r < 2; r++) for (var q = 0; q < 6; q++) {
      ctx.fillStyle = (r + q) % 2 ? '#111' : '#fff';
      ctx.fillRect(-sq + r * sq, -L / 2 + q * sq, sq, sq);
    }
    ctx.restore();
    // direction chevron a few % in
    if (opts.direction !== false) {
      var di = Math.floor(poly.length * 0.06), d0 = poly[di], d1 = poly[(di + 2) % poly.length];
      var a2 = Math.atan2(Y(d1) - Y(d0), X(d1) - X(d0));
      ctx.save(); ctx.translate(X(d0), Y(d0)); ctx.rotate(a2);
      ctx.beginPath(); var s = Math.max(4, widthPx * 0.9);
      ctx.moveTo(s, 0); ctx.lineTo(-s * 0.7, -s * 0.75); ctx.lineTo(-s * 0.2, 0); ctx.lineTo(-s * 0.7, s * 0.75); ctx.closePath();
      ctx.fillStyle = acc; ctx.fill();
      ctx.restore();
    }
    if (opts.labels) {
      ctx.font = '600 10px ' + 'system-ui'; ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.textAlign = 'left';
      ctx.fillText('S/F', X(p0) + 10, Y(p0) - 10);
    }
  }

  /* ----------------------------------------------------------- fallback renderer / hud */
  function geomSamples(geom) {
    if (!geom) return [];
    var arr = geom.samples || geom.centerline || geom.points || geom.center || [];
    return Array.isArray(arr) ? arr : [];
  }
  function createFallbackRenderer(canvas, geom, trackDef) {
    var samples = geomSamples(geom).map(function (p) { var xy = ptXY(p); return { x: xy[0], y: xy[1], w: (p && p.width) || (trackDef && trackDef.width_m) || 12 }; });
    if (samples.length < 3 && trackDef) samples = trackStats(trackDef).poly.map(function (p) { return { x: p[0], y: p[1], w: trackDef.width_m || 12 }; });
    var cam = { x: 0, y: 0, zoom: 3.2 };
    return {
      render: function (snap) {
        var f = fitCanvas(canvas), ctx = f.ctx;
        ctx.fillStyle = '#1f3a22'; ctx.fillRect(0, 0, f.w, f.h);
        var me = null;
        (snap.cars || []).forEach(function (c) { if (c.isPlayer || c.id === snap.playerId) me = c; });
        if (me) { cam.x = lerp(cam.x, me.x, 0.2); cam.y = lerp(cam.y, me.y, 0.2); cam.zoom = lerp(cam.zoom, clamp(4.2 - Math.abs(me.speed || 0) * 0.03, 2.2, 4.2), 0.05); }
        ctx.save();
        ctx.translate(f.w / 2, f.h / 2); ctx.scale(cam.zoom, -cam.zoom); ctx.translate(-cam.x, -cam.y);
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        function path() { ctx.beginPath(); samples.forEach(function (p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.closePath(); }
        var w = (samples[0] && samples[0].w) || 12;
        path(); ctx.strokeStyle = '#d8d8d8'; ctx.lineWidth = w + 1.2; ctx.stroke();
        path(); ctx.strokeStyle = '#3a3c40'; ctx.lineWidth = w; ctx.stroke();
        if (samples.length) { ctx.fillStyle = '#fff'; ctx.fillRect(samples[0].x - 1, samples[0].y - w / 2, 2, w); }
        (snap.cars || []).forEach(function (c) {
          ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.heading || 0);
          var L = c.length_m || 4.5, W = c.width_m || 1.9;
          ctx.fillStyle = c.color || '#c00'; ctx.fillRect(-L / 2, -W / 2, L, W);
          ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(L * 0.05, -W * 0.38, L * 0.22, W * 0.76);
          if (c.isPlayer) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.25; ctx.strokeRect(-L / 2, -W / 2, L, W); }
          ctx.restore();
        });
        if (snap.ghost) { ctx.save(); ctx.globalAlpha = 0.35; ctx.translate(snap.ghost.x, snap.ghost.y); ctx.rotate(snap.ghost.heading || 0); ctx.fillStyle = '#9cf'; ctx.fillRect(-2.2, -0.95, 4.4, 1.9); ctx.restore(); }
        ctx.restore();
      },
      setCamera: function () {}, cycleCamera: function () { return 'north'; }, resize: function () {}, destroy: function () {}
    };
  }
  function createFallbackHud(units) {
    var u = units;
    return {
      draw: function (ctx, snap) {
        var me = null;
        (snap.cars || []).forEach(function (c) { if (c.isPlayer || c.id === snap.playerId) me = c; });
        if (!me) return;
        var W = ctx.canvas.clientWidth, H = ctx.canvas.clientHeight;
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(16, 16, 230, 112);
        ctx.fillStyle = '#fff'; ctx.font = '700 28px system-ui';
        ctx.fillText('P' + (me.position || '-') + '/' + (snap.cars || []).length, 28, 52);
        ctx.font = '600 13px system-ui';
        ctx.fillText('Lap ' + Math.min((me.lap || 0) + 1, snap.lapsTotal || 99) + '/' + (snap.lapsTotal || '∞'), 140, 46);
        ctx.font = '12px ui-monospace,monospace';
        ctx.fillText('Lap  ' + fmtTime(me.currentLap_s), 28, 76);
        ctx.fillText('Last ' + fmtTime(me.lastLap_s), 28, 94);
        ctx.fillText('Best ' + fmtTime(me.bestLap_s), 28, 112);
        var kph = Math.abs(me.speed || 0) * 3.6;
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(W - 196, H - 106, 180, 90);
        ctx.fillStyle = '#fff'; ctx.textAlign = 'right'; ctx.font = '800 italic 42px system-ui';
        ctx.fillText(String(Math.round(u === 'mph' ? kph / 1.609344 : kph)), W - 70, H - 46);
        ctx.font = '600 12px system-ui'; ctx.fillText(u === 'mph' ? 'MPH' : 'KM/H', W - 70, H - 26);
        ctx.font = '800 34px system-ui'; ctx.fillStyle = '#c8a24a';
        ctx.fillText(me.gear === 0 ? 'N' : me.gear < 0 ? 'R' : String(me.gear || 1), W - 26, H - 46);
        ctx.restore();
      },
      setUnits: function (x) { u = x; }, destroy: function () {}
    };
  }

  /* ######################################################################
     Controller (singleton overlay)
     ###################################################################### */
  var U = null; // UI state while open

  function isOpen() { return !!U; }

  /* Launch options from the game hub / career (GAME-SPEC "CB.race.ui.open(build, cfgOverrides, {onFinish})"):
     cfgOverrides may carry engine cfg keys (extras, hooks, seed, startPosition, opponents[], challenge session, ...);
     the third argument supplies callbacks { onFinish(results), onClose() }. */
  function launchOf(opts, cb) {
    var o = {};
    var k;
    for (k in (opts || {})) if (has(opts, k)) o[k] = opts[k];
    if (cb && typeof cb === 'object') for (k in cb) if (has(cb, k) && o[k] === undefined) o[k] = cb[k];
    return o;
  }
  /** Mount the race UI: into a router layer (opts._layer, UNIFY-SPEC) or, standalone, as a full-page overlay. */
  function mount(build, opts, callbacks) {
    opts = launchOf(opts, callbacks);
    injectStyles();
    if (U && (U.layer || null) !== (opts._layer || null)) destroy();   // moving between the overlay and a router layer
    if (U) { // already open: refresh build and go to setup
      teardownRace();
      U.opts = opts;
      U.launchLock = null;
      if (opts.settings) U.settings = sanitizeSettings(deepMerge(U.settings, launchSettings(opts)));
      launchDiscipline();
      U.build = resolveBuild(build);
      U.metricsInfo = computeMetrics(U.build);
      U.hash = buildHash(U.build);
      entryScreen();
      return api;
    }
    var root = document.getElementById('race-root');
    if (root) root.parentNode.removeChild(root);
    var layer = opts._layer && opts._layer.nodeType === 1 ? opts._layer : null;
    root = layer
      ? h('div', { id: 'race-root', class: 'is-routed', role: 'region', 'aria-label': opts._route === 'drift' ? 'Drift' : opts._route === 'arcade' ? 'Arcade' : 'Race', tabindex: '-1', dataset: { screen: 'setup', route: opts._route || 'race' } })
      : h('div', { id: 'race-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Race mode', tabindex: '-1', dataset: { screen: 'setup' } });
    var carbon = h('div', { class: 'rx-carbon' });
    var canvas = h('canvas', { class: 'rx-canvas', 'aria-hidden': 'true' });
    var host = h('div', { class: 'rx-host' });
    var toasts = h('div', { class: 'rx-toasts', 'aria-live': 'polite' });
    root.appendChild(carbon); root.appendChild(canvas); root.appendChild(host); root.appendChild(toasts);
    (layer || document.body).appendChild(root);

    U = {
      root: root, canvas: canvas, host: host, toasts: toasts, layer: layer, route: layer ? (opts._route || 'race') : null,
      opts: opts,
      prevFocus: document.activeElement,
      prevOverflow: document.documentElement.style.overflow,
      settings: sanitizeSettings(deepMerge(loadSettings(), launchSettings(opts))),
      records: api.records,
      screen: 'setup',
      race: null,
      listeners: []
    };
    launchDiscipline();
    U.build = resolveBuild(build);
    U.metricsInfo = computeMetrics(U.build);
    U.hash = buildHash(U.build);
    if (!layer) document.documentElement.style.overflow = 'hidden';

    listen(window, 'keydown', onKeyDown, true);
    listen(window, 'keyup', onKeyUp, true);
    listen(window, 'blur', function () { if (U && U.race && U.race.input) U.race.input.clearHeld(); });
    listen(window, 'resize', onResize);
    listen(document, 'visibilitychange', function () {
      if (document.hidden && U && U.race && U.screen === 'race' && U.race.simActive && !U.race.paused && !U.race.forced && !U.race.net) pauseRace();
    });
    // touch driving enters fullscreen; the browser then eats Esc (and Android's back gesture) to leave fullscreen, so
    // the keydown never arrives: leaving fullscreen mid-race opens the pause menu, as Esc does everywhere else
    var onFsChange = function () {
      var fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (!fs && !document.hidden && U && U.race && U.screen === 'race' && U.race.simActive && !U.race.paused && !U.race.forced && !U.pauseRefs) pauseRace();
    };
    listen(document, 'fullscreenchange', onFsChange);
    listen(document, 'webkitfullscreenchange', onFsChange);
    listen(window, 'gamepadconnected', function (e) { toast(icon('gamepad', 14), 'Controller connected' + (e && e.gamepad && e.gamepad.id ? ' · ' + String(e.gamepad.id).split('(')[0].trim() : '')); });
    listen(window, 'gamepaddisconnected', function () { toast('Controller disconnected'); if (U && U.race && U.screen === 'race' && !U.race.paused && U.race.simActive) pauseRace(); });

    entryScreen();
    try { root.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    return api;
  }

  /** Game launches (career round, challenge, hub quick race) go straight to the grid; everything else opens the setup screen. */
  function isGameLaunch() { return !!(U && U.opts && U.opts.context && U.opts.context.kind); }
  function entryScreen() {
    if (U.opts && (U.opts.autoStart === true || (isGameLaunch() && U.opts.autoStart !== false))) startRace();
    else if (U.layer || (U.opts && U.opts.settings && U.opts.settings.discipline)) showSetup();   // the route / caller already chose
    else showDiscipline();
  }
  /** Career / challenge / hub launches race unless the launcher explicitly asks for a drift session; the
      player's remembered discipline (from free play) must never turn a championship round into a drift run. */
  function launchDiscipline() {
    var o = U.opts || {}, want = o.settings && o.settings.discipline;
    if (o.context && o.context.kind) U.settings.discipline = want === 'drift' ? 'drift' : 'race';
    else if (want) setDiscipline(U.settings, want);
    if ((o.discipline === 'drift' || o.discipline === 'race') && !(o.context && o.context.kind)) setDiscipline(U.settings, o.discipline);   // keeps a remembered circuit per discipline
    else if (o.discipline === 'drift' || o.discipline === 'race') U.settings.discipline = o.discipline;
    if (o.settings && typeof o.settings.trackId === 'string') U.settings.trackId = o.settings.trackId;
    // steering assist: the discipline's own level unless the launcher fixed one (deep link ?assist=, career / challenge opts)
    if (!(o.settings && ids(STEER_ASSISTS).indexOf(o.settings.steerAssist) >= 0)) syncAssist(U.settings);
    if (o.discipline === 'arcade' && !(o.context && o.context.kind)) enterArcadeSettings(U.settings, o.settings || {});
    U.records = isArcadeS(U.settings) ? arcadeRecords() : api.records;
    if (o.plugin && o.plugin.records && typeof o.plugin.records.submit === 'function') U.records = o.plugin.records;   // F1: its own best laps
  }
  /** Launch settings minus the discipline (applied by launchDiscipline through setDiscipline so each discipline keeps its circuit). */
  function launchSettings(o) {
    var s = {}, src = (o && o.settings) || {};
    for (var k in src) if (has(src, k) && k !== 'discipline') s[k] = src[k];
    return s;
  }
  /* Session lock for game launches: a career round / event / challenge is raced exactly as launched (circuit, laps,
     field, mode, conditions); only assists, camera, units and other presentation settings stay editable. Paid launches
     (career / event / challenge) lock every session key; other game launches (hub quick race, time trial) lock only
     the keys the launcher fixed. */
  /* LOCK_KEYS (session keys a game launch fixes) is defined above api._ */
  function strictLaunch() { var k = U && U.opts && U.opts.context && U.opts.context.kind; return k === 'career' || k === 'event' || k === 'challenge'; }
  /** The launcher's explicit session values ({} for free play). */
  function launchFixed() {
    var o = (U && U.opts) || {}, src = o.settings || {}, out = {};
    LOCK_KEYS.forEach(function (k) {
      if (has(src, k) && src[k] != null) out[k] = src[k];
      else if (k !== 'opponents' && has(o, k) && o[k] != null && typeof o[k] !== 'object') out[k] = o[k];
    });
    if (out.opponents == null && Array.isArray(o.opponents) && o.opponents.length) out.opponents = o.opponents.length;
    return out;
  }
  /** Is this setting locked for the current launch? */
  function isLocked(key) {
    if (!isGameLaunch()) return false;
    if (strictLaunch()) return LOCK_KEYS.indexOf(key) >= 0;
    return has(launchFixed(), key);
  }
  /** Re-apply the locked launch values (before a (re)start) or capture them on the first start. */
  function enforceLaunchLock(S) {
    if (!isGameLaunch()) { U.launchLock = null; return; }
    if (!U.launchLock) {
      // captured after the circuit is resolved (S already carries the sanitized launch values: locked controls can't change them)
      var lock = { keys: [], values: {} };
      LOCK_KEYS.forEach(function (k) { if (isLocked(k)) { lock.keys.push(k); lock.values[k] = S[k] == null ? null : deepClone(S[k]); } });
      lock.discipline = S.discipline;
      U.launchLock = lock;
    }
    var L = U.launchLock;
    L.keys.forEach(function (k) { if (L.values[k] !== undefined && L.values[k] !== null) S[k] = L.values[k]; });
    if (L.discipline) S.discipline = L.discipline;
  }
  /** Grey out + disable a setup field that the launch fixes. */
  function lockField(f) {
    if (!f || !f.classList) return f;
    f.classList.add('is-locked');
    f.setAttribute('aria-disabled', 'true');
    f.title = 'Fixed by ' + ((U && U.opts && U.opts.context && U.opts.context.label) || 'this event');
    Array.prototype.forEach.call(f.querySelectorAll('button,input,select'), function (b) { b.disabled = true; b.tabIndex = -1; });
    return f;
  }
  function lockIf(key, f) { return isLocked(key) ? lockField(f) : f; }
  /** Results safety net: flag a session that does not match the launch configuration. */
  function launchMismatch(R) { return launchMismatchOf(U && U.launchLock, R); }
  /** Pure: which launch keys does session R ({def, settings, opponents, isDrift}) differ on from lock? (null: no lock) */
  function launchMismatchOf(L, R) {
    if (!L || !R) return null;
    var v = L.values, why = [];
    if (v.trackId != null && R.def && R.def.id !== v.trackId) why.push('trackId');
    if (R.isDrift) {   // drift runs are engine practice sessions: compare the drift session keys instead
      if (v.driftMode != null && R.settings.driftMode !== v.driftMode) why.push('driftMode');
      if (v.driftDuration != null && +R.settings.driftDuration !== +v.driftDuration) why.push('driftDuration');
      if (L.discipline && L.discipline !== 'drift') why.push('discipline');
      return why;
    }
    if (L.discipline && L.discipline !== 'race') why.push('discipline');
    if (v.mode != null && R.settings.mode !== v.mode) why.push('mode');
    if (v.laps != null && R.settings.mode !== 'practice' && +R.settings.laps !== +v.laps) why.push('laps');
    if (L.fieldSize != null && R.opponents && R.opponents.length + 1 !== L.fieldSize) why.push('fieldSize');
    if (v.weather != null && R.settings.weather !== v.weather) why.push('weather');
    return why;
  }
  function backLabel() {
    if (U && U.opts && U.opts.backLabel) return U.opts.backLabel;
    if (U && U.layer) {
      var n = routeName(U.opts.returnTo || U.opts._from || RT.from);
      var names = { atelier: 'Garage', menu: 'menu', career: 'career', garage: 'My Cars', challenges: 'challenges', profile: 'profile', settings: 'settings', replays: 'replays', achievements: 'achievements' };
      var to = names[n] || (isGameLaunch() ? 'career' : 'menu');
      return to === 'menu' ? 'Main menu' : 'Back to ' + to;   // copy shared by every screen head (css/styles.css § 18)
    }
    return isGameLaunch() ? 'Back to career' : 'Back to Garage';
  }

  function listen(target, type, fn, capture) {
    target.addEventListener(type, fn, !!capture);
    U.listeners.push(function () { target.removeEventListener(type, fn, !!capture); });
  }

  /** Leave race mode. Routed: navigate back to where the player came from (the route's leave handler tears down). */
  function close() {
    if (!U) return;
    if (U.layer && routeBack()) return;
    destroy();
  }
  /** Tear everything down (session, audio, listeners, DOM) without navigating. */
  function destroy() {
    if (!U) return;
    var u = U;
    teardownRace();
    u.listeners.forEach(function (off) { try { off(); } catch (e) { /* ignore */ } });
    if (u.root && u.root.parentNode) u.root.parentNode.removeChild(u.root);
    if (!u.layer) document.documentElement.style.overflow = u.prevOverflow || '';
    U = null;
    setDriving(false);
    try { if (!u.layer && u.prevFocus && typeof u.prevFocus.focus === 'function') u.prevFocus.focus(); } catch (e) { /* ignore */ }
    if (!u.switching) { try { document.dispatchEvent(new CustomEvent('cb:race-closed')); } catch (e2) { /* ignore */ } }
    if (!u.switching && typeof u.opts.onClose === 'function') { try { u.opts.onClose(); } catch (e3) { /* ignore */ } }
  }

  function setScreen(name) {
    U.screen = name;
    U.root.dataset.screen = name;
    // screen family (css/styles.css § 18): the mode accent (--mode-race / -drift / -arcade) follows the discipline
    U.root.dataset.mode = isArcadeS(U.settings) ? 'arcade' : U.settings.discipline === 'drift' ? 'drift' : 'race';
    U.root.classList.add('mx');
    setDriving(name === 'race' || name === 'loading');
  }
  /** While driving the global nav bar is hidden (UNIFY-SPEC): flag on <html> + event + optional router hook. */
  var drivingFlag = false;
  function setDriving(on) {
    on = !!on;
    if (on === drivingFlag) return;
    drivingFlag = on;
    try { document.documentElement.classList.toggle('cb-driving', on); } catch (e) { /* ignore */ }
    var r = CB.router;
    try {
      if (r && typeof r.setDriving === 'function') r.setDriving(on);
      else if (r && typeof r.setChrome === 'function') r.setChrome(!on);
    } catch (e2) { /* ignore */ }
    try { document.dispatchEvent(new CustomEvent('cb:driving', { detail: { driving: on } })); } catch (e3) { /* ignore */ }
  }
  /* ---------------------------------------------------------------- ARCADE (ARCADE-SPEC §5)
     #/arcade runs discipline 'arcade' inside this UI: every car on the arcade vehicle model (handling 'arcade'),
     stunt tracks (CB.arcade.stunt) first, own settings (settings.arcade) and best laps (CB.arcade.mode.RECORDS_KEY). */
  function arcadeMod() { var A = CB.arcade && CB.arcade.mode; return A && typeof A.createSession === 'function' ? A : null; }
  function isArcadeS(S) { return !!S && S.discipline === 'arcade'; }
  var ARC_RECORDS = null;
  function arcadeRecords() {
    var key = (arcadeMod() && arcadeMod().RECORDS_KEY) || 'forge.arcade.records.v1';
    if (!ARC_RECORDS || ARC_RECORDS._key !== key) { ARC_RECORDS = createRecords(null, key); ARC_RECORDS._key = key; }
    return ARC_RECORDS;
  }
  function arcadeSanitize(a) {
    var A = arcadeMod();
    if (A) return A.sanitize(a);
    a = isPlain(a) ? a : {};
    return { trackId: typeof a.trackId === 'string' ? a.trackId : null, mode: a.mode === 'time-trial' ? 'time-trial' : 'race', laps: Math.round(clamp(isNum(+a.laps) ? +a.laps : 3, 1, 20)),
      opponents: Math.round(clamp(isNum(+a.opponents) ? +a.opponents : 7, 1, 11)), difficulty: ids(DIFFICULTIES).indexOf(a.difficulty) >= 0 ? a.difficulty : 'amateur',
      weather: ids(WEATHERS).indexOf(a.weather) >= 0 ? a.weather : 'dry', timeOfDay: ids(TIMES).indexOf(a.timeOfDay) >= 0 ? a.timeOfDay : 'day',
      options: isPlain(a.options) ? a.options : {} };
  }
  /** Overlay the saved arcade session values on S (S.discipline = 'arcade'); deep-link values (dl) win. */
  function enterArcadeSettings(S, dl) {
    var A = arcadeSanitize(S.arcade);
    S.discipline = 'arcade';
    ARC_KEYS.forEach(function (k) { S[k] = A[k]; });
    S.arcadeOptions = deepClone(A.options || {});
    dl = dl || {};
    ['trackId', 'laps', 'opponents', 'difficulty', 'weather', 'timeOfDay'].forEach(function (k) { if (dl[k] != null && dl[k] !== '') S[k] = dl[k]; });
    S.steerAssist = 'off';   // arcade handling: no steering assist layer (Race / Drift keep their own levels, assistKey('arcade') = null)
    if (dl.mode === 'race' || dl.mode === 'time-trial') S.mode = dl.mode;
    if (S.mode !== 'race' && S.mode !== 'time-trial') S.mode = 'race';
    return S;
  }
  function arcadeSettingsOf(S) {
    var o = {};
    ARC_KEYS.forEach(function (k) { o[k] = S[k]; });
    o.options = deepClone(S.arcadeOptions || {});
    return arcadeSanitize(o);
  }
  function persistArcade() {
    var saved = loadSettings(), S = U.settings, a = arcadeSettingsOf(S);
    var dl = U.opts && U.opts._deepLink, prev = arcadeSanitize(saved.arcade);
    if (dl) Object.keys(dl).forEach(function (k) { if (ARC_KEYS.indexOf(k) >= 0 && a[k] === dl[k]) a[k] = prev[k]; });
    saved.arcade = a; S.arcade = deepClone(a);
    ARC_SHARED.forEach(function (k) { if (S[k] !== undefined) saved[k] = deepClone(S[k]); });
    saveSettings(saved);
  }
  /** Arcade track list: stunt tracks first (CB.arcade.stunt), then the circuits (drift venues last). */
  function arcadeTracks() {
    var A = arcadeMod(), circuits = tracksFor('race');
    if (A) return A.trackEntries(circuits);
    return circuits.map(function (d) { return { id: d.id, name: d.name || d.id, kind: 'circuit', def: d }; });
  }
  function arcadeTrack(id) {
    var l = arcadeTracks();
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i].def;
    return null;
  }
  function arcadeDefaultTrack(list) {
    if (!list.length) return null;
    var c = list.filter(function (e) { return e.kind !== 'stunt'; }).map(function (e) { return e.def; });
    return list[0].kind === 'stunt' ? list[0].id : defaultTrackId(c);
  }
  function isStuntDef(def) { return !!def && (def.kind === 'stunt' || def.stunt === true || (arcadeMod() ? arcadeMod().isStunt(def) : false)); }

  function persist() {   // career / challenge settings never overwrite the player's race defaults
    if (isGameLaunch()) return;
    if (U && isArcadeS(U.settings)) { persistArcade(); return; }   // ARCADE-SPEC §5: own store, Race / Drift defaults untouched
    if (U && U.opts && U.opts.net) { var ns0 = U.settings; var keep = loadSettings(); ['raceSteerAssist', 'driftSteerAssist', 'camera', 'camera3d', 'driftCamera3d', 'graphics', 'quality', 'units', 'muted', 'steerSensitivity', 'invertSteer', 'touchControls'].forEach(function (k) { keep[k] = ns0[k]; }); saveSettings(keep); return; }   // net: presentation only
    var dl = U.opts && U.opts._deepLink;
    if (!dl) { saveSettings(U.settings); return; }
    // deep-link values the player has not changed keep the previously saved defaults
    var saved = loadSettings(), out = deepClone(U.settings);
    Object.keys(dl).forEach(function (k) {
      if (k === 'trackId') {
        if (out.trackId === dl.trackId) out.trackId = (saved.discipline === out.discipline ? saved.trackId : saved[out.discipline + 'TrackId']) || null;
        ['raceTrackId', 'driftTrackId'].forEach(function (tk) { if (out[tk] === dl.trackId) out[tk] = saved[tk] != null ? saved[tk] : null; });
      } else if (out[k] === dl[k]) out[k] = saved[k];
    });
    saveSettings(out);
  }

  function toast() {
    if (!U) return;
    var t = h('div', { class: 'rx-toast' });
    for (var i = 0; i < arguments.length; i++) append(t, arguments[i]);
    t.style.display = 'flex'; t.style.alignItems = 'center'; t.style.gap = '8px';
    // same-kind toasts (e.g. rapid camera cycling) replace each other instead of stacking
    var kind = String(t.textContent || '').split('·')[0].trim();
    t.setAttribute('data-kind', kind);
    Array.prototype.slice.call(U.toasts.children).forEach(function (o) { if (o.getAttribute('data-kind') === kind && o.parentNode) o.parentNode.removeChild(o); });
    U.toasts.appendChild(t);
    while (U.toasts.children.length > 3) U.toasts.removeChild(U.toasts.firstChild);
    setTimeout(function () { t.style.opacity = '0'; }, 1600);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2100);
  }

  /* ======================================================================
     Keyboard routing
     ====================================================================== */
  function isTypingTarget(t) {
    if (!t || !t.tagName) return false;
    var tag = t.tagName.toLowerCase();
    return (tag === 'input' && !/^(range|checkbox|radio|button)$/i.test(t.type || '')) || tag === 'textarea' || t.isContentEditable;
  }
  function onKeyDown(e) {
    if (!U) return;
    var code = e.code || '', scr = U.screen, R = U.race;
    // keep configurator shortcuts from firing underneath
    e.stopPropagation();
    // the replay viewer / photo mode (CB.game.replay, mounted inside #race-root) owns the keyboard while it is open
    if (document.getElementById('game-replay')) return;
    // so does a dialog opened on top (phone-wheel pairing, webcam setup, a ui-kit modal): Esc there used to also resume the
    // race from the pause menu (or leave the setup screen) underneath the dialog
    if (document.querySelector('body > .pw-overlay, body > .cw-ov, #modal-root > .cb-modal.is-open')) return;
    if (scr === 'race' && R && R.input) {
      if (R.paused) {
        if (code === 'Escape' || code === 'KeyP') { e.preventDefault(); resumeRace(); }
        else if (code === 'ArrowDown' || code === 'ArrowUp') { e.preventDefault(); movePauseFocus(code === 'ArrowDown' ? 1 : -1); }
        return;
      }
      if (R.input.handleKey(code, true, e.repeat)) e.preventDefault();
      return;
    }
    if (isTypingTarget(e.target)) return;
    if (scr === 'discipline') {
      if (code === 'Escape') { e.preventDefault(); close(); }
      else if (code === 'KeyD') { e.preventDefault(); chooseDiscipline('drift'); }
      else if (code === 'KeyR') { e.preventDefault(); chooseDiscipline('race'); }
      else if ((code === 'ArrowLeft' || code === 'ArrowRight') && U.disciplineCards) {
        e.preventDefault();
        var cs = U.disciplineCards, i = cs.indexOf(document.activeElement);
        var nx = cs[(i < 0 ? 0 : i + (code === 'ArrowRight' ? 1 : cs.length - 1)) % cs.length];
        try { nx.focus({ preventScroll: true }); } catch (eF) { /* ignore */ }
      }
      return;
    }
    if (scr === 'setup') {
      if (code === 'Escape') { e.preventDefault(); if (isGameLaunch() || U.layer) close(); else showDiscipline(); }
      else if ((code === 'Enter' || code === 'NumpadEnter') && (!e.target || e.target === U.root || e.target === document.body)) { e.preventDefault(); startRace(); }
    } else if (scr === 'loading' && U.opts && U.opts.net) {
      if ((code === 'Enter' || code === 'Space' || code === 'NumpadEnter') && R && R.ready) { e.preventDefault(); goRace(); }
    } else if (scr === 'error' && U.opts && U.opts.net) {
      if (code === 'Escape') { e.preventDefault(); netLeave(); }
    } else if (scr === 'loading') {
      if (code === 'Escape') { e.preventDefault(); teardownRace(); showSetup(); }
      else if ((code === 'Enter' || code === 'Space' || code === 'NumpadEnter') && R && R.ready) { e.preventDefault(); goRace(); }
    } else if (scr === 'results' && U.opts && U.opts.net) {
      if (code === 'Escape' || ((code === 'Enter' || code === 'NumpadEnter') && (!e.target || e.target === U.root || e.target === document.body))) { e.preventDefault(); netLeave(); }
    } else if (scr === 'results') {
      if (oneShotLaunch()) { if (code === 'Escape' || ((code === 'Enter' || code === 'NumpadEnter') && (!e.target || e.target === U.root || e.target === document.body))) { e.preventDefault(); close(); } }
      else if (code === 'Escape') { e.preventDefault(); teardownRace(); showSetup(); }
      else if ((code === 'Enter' || code === 'NumpadEnter') && (!e.target || e.target === U.root || e.target === document.body)) { e.preventDefault(); startRace(); }
    } else if (scr === 'error') {
      if (code === 'Escape') { e.preventDefault(); teardownRace(); showSetup(); }
    }
  }
  function onKeyUp(e) {
    if (!U) return;
    e.stopPropagation();
    var R = U.race;
    if (R && R.input && U.screen === 'race' && R.input.handleKey(e.code || '', false, false)) e.preventDefault();
  }
  function onResize() {
    if (!U) return;
    var R = U.race;
    if (R && R.renderer && typeof R.renderer.resize === 'function') { try { R.renderer.resize(); } catch (e) { /* ignore */ } }
    if (U.screen === 'setup' && U.setupRefs) drawSetupCanvases();
    if (U.screen === 'results' && U.resultsRedraw) U.resultsRedraw();
    if (R && R.touchEl) updateTouchVisibility();
  }

  /* ======================================================================
     Reusable controls
     ====================================================================== */
  function field(label, control, opts) {
    opts = opts || {};
    var desc = opts.desc != null ? h('div', { class: 'rx-field-desc', text: opts.desc }) : null;
    var val = opts.value != null ? h('span', { class: 'rx-field-val rx-num', text: opts.value }) : null;
    var f = h('div', { class: 'rx-field' + (opts.disabled ? ' is-disabled' : '') },
      h('div', { class: 'rx-field-head' }, h('span', { class: 'rx-label', text: label }), val, opts.headExtra || null),
      control, desc);
    // accessible names: a bare slider / select gets the field label; stepper buttons say what they change
    if (control && control.nodeType === 1 && typeof label === 'string') {
      if (/^(INPUT|SELECT)$/.test(control.tagName) && !control.hasAttribute('aria-label')) control.setAttribute('aria-label', label);
      if (control.querySelectorAll) Array.prototype.forEach.call(control.querySelectorAll('.rx-stepper > [aria-label="Decrease"], .rx-stepper > [aria-label="Increase"]'), function (b) {
        b.setAttribute('aria-label', b.getAttribute('aria-label') + ' ' + label.toLowerCase());
      });
    }
    f._desc = desc; f._val = val;
    return f;
  }
  function segmented(options, value, onChange) {
    var wrap = h('div', { class: 'cb-seg-btns rx-seg', role: 'radiogroup' });
    var btns = options.map(function (o) {
      var b = h('button', { class: 'cb-seg-btn rx-seg-btn' + (o.id === value ? ' is-active' : ''), type: 'button', role: 'radio', 'aria-checked': o.id === value ? 'true' : 'false', title: o.desc || o.name },
        o.icon ? icon(o.icon, 14) : null, o.name);
      b.addEventListener('click', function () {
        btns.forEach(function (x) { x.classList.remove('is-active'); x.setAttribute('aria-checked', 'false'); });
        b.classList.add('is-active'); b.setAttribute('aria-checked', 'true');
        onChange(o.id, o);
      });
      return b;
    });
    btns.forEach(function (b) { wrap.appendChild(b); });
    return wrap;
  }
  function toggleRow(label, hint, value, onChange) {
    var b = h('button', { class: 'rx-toggle' + (value ? ' is-on' : ''), type: 'button', role: 'switch', 'aria-checked': value ? 'true' : 'false' },
      h('span', { class: 'rx-toggle-text' }, h('b', { text: label }), hint ? h('small', { text: hint }) : null),
      h('span', { class: 'cb-switch rx-switch' + (value ? ' is-on' : ''), 'aria-hidden': 'true' }, h('span', { class: 'cb-switch-knob' })));
    b.addEventListener('click', function () {
      value = !value;
      b.classList.toggle('is-on', value); b.setAttribute('aria-checked', value ? 'true' : 'false');
      var sw = b.querySelector('.cb-switch'); if (sw) sw.classList.toggle('is-on', value);
      onChange(value);
    });
    return b;
  }
  function stepper(value, min, max, onChange, quick) {
    var valEl = h('span', { class: 'rx-stepper-val rx-num', text: String(value) });
    var quickWrap = quick ? h('div', { class: 'rx-quick' }) : null;
    function set(v) {
      value = Math.round(clamp(v, min, max));
      valEl.textContent = String(value);
      if (quickWrap) Array.prototype.forEach.call(quickWrap.children, function (c) { c.classList.toggle('is-active', +c.dataset.v === value); });
      onChange(value);
    }
    var minus = h('button', { class: 'cb-btn rx-btn', type: 'button', 'aria-label': 'Decrease', onclick: function () { set(value - 1); } }, '−');
    var plus = h('button', { class: 'cb-btn rx-btn', type: 'button', 'aria-label': 'Increase', onclick: function () { set(value + 1); } }, '+');
    if (quick) quick.forEach(function (q) {
      quickWrap.appendChild(h('button', { type: 'button', class: q === value ? 'is-active' : '', dataset: { v: String(q) }, onclick: function () { set(q); } }, String(q)));
    });
    return h('div', { class: 'rx-stepper' }, minus, valEl, plus, quickWrap);
  }
  function rangeInput(min, max, step, value, onInput) {
    var r = h('input', { class: 'rx-range', type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    r.addEventListener('input', function () { onInput(parseFloat(r.value)); });
    return r;
  }
  function pips(n, max, hot) {
    var w = h('span', { class: 'rx-pips' + (hot ? ' hot' : ''), title: 'Difficulty ' + n + '/' + max });
    for (var i = 1; i <= max; i++) w.appendChild(h('i', { class: i <= n ? 'on' : '' }));
    return w;
  }
  function statCell(label, value, unit, cls) {
    return h('div', { class: cls || '' }, h('div', { class: 'rx-stat-l', text: label }),
      h('div', { class: 'rx-stat-v rx-num' }, String(value), unit ? h('small', { text: unit }) : null));
  }
  function kbd(t) { return h('span', { class: 'rx-kbd', text: t }); }
  function keysReference() {
    var rows = [
      [['W', '↑'], 'Throttle'], [['S', '↓'], 'Brake / reverse'], [['A', 'D'], 'Steer'], [['Space'], 'Handbrake'],
      [['E', 'Shift'], 'Shift up'], [['Q', 'Ctrl'], 'Shift down'], [['C'], 'Cycle camera'], [['R'], 'Reset to track'],
      [['M'], 'Mute'], [['P', 'Esc'], 'Pause']
    ];
    var g = h('div', { class: 'rx-keys' });
    rows.forEach(function (r) {
      g.appendChild(h('span', null, r[0].map(kbd)));
      g.appendChild(h('span', { text: r[1] }));
    });
    g.appendChild(h('span', null, icon('gamepad', 16)));
    g.appendChild(h('span', { text: 'Gamepad: LS steer · RT/LT pedals · A handbrake · RB/LB shift · Y camera · Start pause' }));
    return g;
  }

  /* ======================================================================
     SETUP screen
     ====================================================================== */
  function showSetup() {
    if (!U) return;
    teardownRace();
    setScreen('setup');
    U.resultsRedraw = null;
    clear(U.host);
    var S = U.settings;
    var mods = moduleStatus();
    if (isArcadeS(S)) { showArcadeSetup(mods); return; }
    if (S.discipline === 'drift' && !driftMod()) { S.discipline = 'race'; syncAssist(S); }
    var drifting = S.discipline === 'drift';
    var tracks = tracksFor(S.discipline);
    if (!S.trackId || !tracks.some(function (t) { return t.id === S.trackId; })) S.trackId = drifting ? (tracks[0] && tracks[0].id) || null : defaultTrackId(tracks);
    var refs = U.setupRefs = { cards: {}, fields: {} };

    /* top bar */
    var top = h('header', { class: 'rx-topbar' },
      h('div', { class: 'rx-brand' }, h('div', { class: 'rx-brand-mark', text: 'R' }),
        h('div', null, h('div', { class: 'rx-brand-name', text: 'Redline' }), h('div', { class: 'rx-brand-sub', text: drifting ? 'Drift Mode' : 'Race Mode' }))),
      headline(refs, drifting ? 'drift' : 'race'),
      isGameLaunch() ? null : disciplineTabs(S.discipline),
      h('nav', { class: 'rx-steps' },
        h('span', { class: 'rx-step is-on is-link', role: 'button', tabindex: '0', title: 'Change discipline (Drift / Race)', html: '<b>01</b>' + (drifting ? 'Drift' : 'Race'),
          onclick: function () { if (!isGameLaunch()) switchDiscipline(drifting ? 'race' : 'drift'); } }),
        h('span', { class: 'rx-step is-on', html: '<b>02</b>Circuit' }),
        h('span', { class: 'rx-step is-on', html: '<b>03</b>Session' }),
        h('span', { class: 'rx-step', html: '<b>04</b>Drive' })),
      h('button', { class: 'cb-btn rx-btn ghost cb-back rx-back', type: 'button', onclick: close, title: backLabel() + ' (Esc)', 'aria-label': backLabel() }, icon('back', 16), backLabel(), kbd('Esc')));

    /* left column: circuit */
    var left = h('div', { class: 'rx-col rx-scroll' });
    var banner = moduleBanner(mods);
    if (banner) left.appendChild(banner);
    left.appendChild(h('div', { class: 'rx-section-title' }, h('h3', null, stepBadge(2), 'Select circuit'),
      h('span', { class: 'rx-eyebrow', text: tracks.length ? plural(tracks.length, 'circuit') : '' })));
    var featured = h('div', { class: 'rx-panel rx-featured' });
    refs.featured = featured;
    left.appendChild(featured);
    var grid = h('div', { class: 'rx-track-grid' });
    tracks.forEach(function (def) {
      var st = trackStats(def);
      var pb = drifting ? U.records.driftBestFor(def.id, U.hash) : U.records.bestFor(def.id, U.hash);
      var pbText = pb ? (drifting ? 'Best ' + fmtPts(pb.score) + ' pts' : 'PB ' + fmtTime(pb.time)) : '';
      var cv = h('canvas');
      var card = h('button', { class: 'cb-card rx-track-card' + (def.id === S.trackId ? ' is-selected' : ''), type: 'button', 'aria-pressed': def.id === S.trackId ? 'true' : 'false', title: def.name },
        h('div', { class: 'rx-track-thumb' }, cv, pb ? h('span', { class: 'rx-track-pb rx-num', text: pbText }) : null,
          isDriftTrack(def) ? h('span', { class: 'rx-chip drift rx-track-badge' }, icon('drift', 11), 'Drift') : null),
        h('div', { class: 'rx-track-meta' }, h('b', { text: def.name || def.id }),
          h('span', null, h('span', { class: 'rx-num rx-track-stat', text: fmtLength(st.length_m, S.units) + ' · ' + st.corners + '\u00a0T' }),
            pips(def.difficulty || 3, 5, true))));
      card._canvas = cv; card._def = def;
      if (isLocked('trackId') && def.id !== S.trackId) { card.disabled = true; card.classList.add('is-locked'); card.title = def.name + ' (this event is raced on ' + ((findTrack(S.trackId) || {}).name || S.trackId) + ')'; }
      card.addEventListener('click', function () { selectTrack(def.id); });
      card.addEventListener('dblclick', function () { selectTrack(def.id); startRace(); });
      refs.cards[def.id] = card;
      grid.appendChild(card);
    });
    if (!tracks.length) {
      grid.appendChild(h('div', { class: 'rx-banner bad' }, icon('warn', 18),
        h('div', null, h('b', { text: 'No circuits available.' }),
          h('div', { class: 'rx-dim', html: 'The track catalog (<code>js/race/tracks.js</code>) is not loaded, so there is nothing to race on yet.' }))));
    }
    left.appendChild(grid);

    /* right column: car + session */
    var right = h('div', { class: 'rx-col rx-scroll' });
    right.appendChild(h('div', { class: 'rx-section-title' }, h('h3', null, h('span', { class: 'rx-skew' }), 'Your machine'),
      h('span', { class: 'rx-eyebrow accent', text: 'From the Garage' })));
    right.appendChild(carCard());
    right.appendChild(h('div', { class: 'rx-section-title' }, h('h3', null, stepBadge(3), 'Session')));
    right.appendChild(sessionForm(mods));

    var main = h('div', { class: 'rx-setup-main' }, left, right);

    /* footer */
    var summary = h('div', { class: 'rx-summary' });
    refs.summary = summary;
    var startBtn = h('button', { class: 'cb-btn rx-btn primary big', type: 'button', onclick: startRace }, icon(drifting ? 'drift' : 'flag', 18), drifting ? 'Start drift' : 'Start race');
    refs.startBtn = startBtn;
    var foot = h('footer', { class: 'rx-footer' }, summary,
      h('span', { class: 'rx-dim', style: { 'font-size': 'var(--fs-sm)', 'margin-left': 'auto' } }, kbd('Enter'), ' to start'),
      startBtn);
    foot.lastChild.style.marginLeft = '0';

    var screen = h('div', { class: 'rx-setup' }, top, main, foot);
    U.host.appendChild(screen);
    renderFeatured();
    refreshSetupState();
    requestAnimationFrame(drawSetupCanvases);
  }

  /** Track map, or the stunt pack's own thumbnail (CB.arcade.stunt.drawThumb) for stunt tracks without a 2D outline. */
  function drawTrackThumb(canvas, def, opts) {
    var ST = CB.arcade && CB.arcade.stunt;
    if (def && isStuntDef(def) && !(def.points && def.points.length > 2)) {
      if (ST && typeof ST.drawThumb === 'function') { try { ST.drawThumb(canvas, def, opts); return; } catch (e) { /* fall through */ } }
      var f = fitCanvas(canvas), c = f.ctx, w = f.w, hh = f.h, r = Math.min(w, hh) * 0.28;
      c.clearRect(0, 0, w, hh);
      c.lineWidth = Math.max(3, r * 0.16); c.lineCap = 'round'; c.strokeStyle = '#ffb21f';
      c.beginPath(); c.arc(w / 2, hh / 2, r, Math.PI * 0.75, Math.PI * 2.6); c.stroke();
      c.strokeStyle = '#33d6ff'; c.beginPath(); c.moveTo(w * 0.12, hh * 0.78); c.lineTo(w / 2 - r * 0.7, hh / 2 + r * 0.7); c.stroke();
      return;
    }
    drawTrackMap(canvas, def, opts);
  }

  /** #/arcade setup: stunt tracks first, then the circuits; arcade session + extension options; shared look & controls. */
  function showArcadeSetup(mods) {
    var S = U.settings;
    var list = arcadeTracks();
    if (!S.trackId || !list.some(function (e) { return e.id === S.trackId; })) S.trackId = arcadeDefaultTrack(list);
    var refs = U.setupRefs = { cards: {}, fields: {} };
    var top = h('header', { class: 'rx-topbar' },
      h('div', { class: 'rx-brand' }, h('div', { class: 'rx-brand-mark', text: 'R' }),
        h('div', null, h('div', { class: 'rx-brand-name', text: 'Redline' }), h('div', { class: 'rx-brand-sub', text: 'Arcade Mode' }))),
      headline(refs, 'arcade'),
      isGameLaunch() ? null : disciplineTabs('arcade'),
      h('nav', { class: 'rx-steps' },
        h('span', { class: 'rx-step is-on', html: '<b>01</b>Arcade' }),
        h('span', { class: 'rx-step is-on', html: '<b>02</b>Track' }),
        h('span', { class: 'rx-step is-on', html: '<b>03</b>Rules' }),
        h('span', { class: 'rx-step', html: '<b>04</b>Drive' })),
      h('button', { class: 'cb-btn rx-btn ghost cb-back rx-back', type: 'button', onclick: close, title: backLabel() + ' (Esc)', 'aria-label': backLabel() }, icon('back', 16), backLabel(), kbd('Esc')));

    var left = h('div', { class: 'rx-col rx-scroll' });
    var banner = moduleBanner(mods);
    if (banner) left.appendChild(banner);
    if (!arcadeMod()) left.appendChild(h('div', { class: 'rx-banner bad' }, icon('warn', 18), h('div', null, h('b', { text: 'Arcade module not loaded.' }),
      h('div', { class: 'rx-dim', html: '<code>js/arcade/mode.js</code> is missing: sessions run on circuits only, without arcade extensions.' }))));
    left.appendChild(h('div', { class: 'rx-panel rx-arcade-intro' },
      h('span', { class: 'rx-chip arcade' }, icon('bolt', 12), 'Arcade handling'),
      h('p', { text: 'Grip never breaks: no wheelspin, no lock-ups, no spins. Point it and go — crisp steering at any speed, huge brakes, soft walls. Your build’s power, weight and top speed still decide who is quickest.' })));
    var stunts = list.filter(function (e) { return e.kind === 'stunt'; }), circuits = list.filter(function (e) { return e.kind !== 'stunt'; });
    function section(title, entries, eyebrow) {
      if (!entries.length) return;
      left.appendChild(h('div', { class: 'rx-section-title' }, h('h3', null, stepBadge(2), title),
        h('span', { class: 'rx-eyebrow', text: eyebrow })));
      var grid = h('div', { class: 'rx-track-grid' });
      entries.forEach(function (e) {
        var def = e.def, stunt = e.kind === 'stunt';
        var pb = U.records.bestFor(def.id, U.hash);
        var cv = h('canvas');
        var card = h('button', { class: 'cb-card rx-track-card' + (def.id === S.trackId ? ' is-selected' : ''), type: 'button', 'aria-pressed': def.id === S.trackId ? 'true' : 'false', title: def.name || def.id, dataset: { track: def.id, kind: e.kind } },
          h('div', { class: 'rx-track-thumb' }, cv, pb ? h('span', { class: 'rx-track-pb rx-num', text: 'PB ' + fmtTime(pb.time) }) : null,
            stunt ? h('span', { class: 'rx-chip arcade rx-track-badge' }, icon('bolt', 11), 'Stunt') : null),
          h('div', { class: 'rx-track-meta' }, h('b', { text: def.name || def.id }),
            h('span', null, h('span', { class: 'rx-num rx-track-stat', text: stunt ? (def.tagline || def.desc || 'Loops · ramps · boost pads').toString().slice(0, 34) : (function () { var st = trackStats(def); return fmtLength(st.length_m, S.units) + ' · ' + st.corners + ' T'; })() }),
              pips(def.difficulty || 3, 5, true))));
        card._canvas = cv; card._def = def;
        card.addEventListener('click', function () { selectTrack(def.id); });
        card.addEventListener('dblclick', function () { selectTrack(def.id); startRace(); });
        refs.cards[def.id] = card;
        grid.appendChild(card);
      });
      left.appendChild(grid);
    }
    section('Stunt tracks', stunts, plural(stunts.length, 'track'));
    section('Circuits', circuits, circuits.length ? plural(circuits.length, 'circuit') + ' · arcade grip' : '');
    if (!list.length) left.appendChild(h('div', { class: 'rx-banner bad' }, icon('warn', 18), h('b', { text: 'No tracks available.' })));
    var featured = h('div', { class: 'rx-panel rx-featured' });
    refs.featured = featured;
    left.insertBefore(featured, left.children[banner ? 2 : 1] || null);

    var right = h('div', { class: 'rx-col rx-scroll' });
    right.appendChild(h('div', { class: 'rx-section-title' }, h('h3', null, h('span', { class: 'rx-skew' }), 'Your machine'),
      h('span', { class: 'rx-eyebrow accent', text: 'From the garage' })));
    right.appendChild(carCard());
    right.appendChild(h('div', { class: 'rx-section-title' }, h('h3', null, stepBadge(3), 'Arcade session')));
    var form = h('div', { class: 'rx-panel rx-form' });
    var ARC_MODES = (arcadeMod() && arcadeMod().MODES) || [{ id: 'race', name: 'Race', desc: 'Grid start against arcade AI' }, { id: 'time-trial', name: 'Time trial', desc: 'Solo hot laps' }];
    var modeField = field('Mode', segmented(ARC_MODES, S.mode, function (v, o) { S.mode = v; persist(); modeField._desc.textContent = o.desc; refreshSetupState(); }), { desc: pick(ARC_MODES, S.mode).desc });
    form.appendChild(modeField);
    var lapsField = field('Laps', stepper(S.laps, 1, 20, function (v) { S.laps = v; persist(); refreshSetupState(); }, [1, 3, 5]));
    var oppField = field('Opponents', stepper(S.opponents, 1, 11, function (v) { S.opponents = v; persist(); refreshSetupState(); }, [3, 7, 11]));
    refs.fields.laps = lapsField; refs.fields.opponents = oppField;
    form.appendChild(h('div', { class: 'rx-two' }, lapsField, oppField));
    var diffField = field('AI difficulty', segmented(DIFFICULTIES, S.difficulty, function (v, o) { S.difficulty = v; persist(); diffField._desc.textContent = o.desc; refreshSetupState(); }), { desc: pick(DIFFICULTIES, S.difficulty).desc });
    refs.fields.difficulty = diffField;
    form.appendChild(diffField);
    form.appendChild(field('Handling', h('div', { class: 'rx-arcade-handling' }, icon('steer', 14), h('span', { text: 'Arcade handling — no assist needed' })),
      { desc: 'Tight, snappy steering and grip that never lets go. Steering assist is a Race / Drift option.' }));
    // extension options (nitro / items / speed classes ...) registered via CB.arcade.mode.registerExtension
    var defs = arcadeMod() ? arcadeMod().optionDefs() : [];
    if (!isPlain(S.arcadeOptions)) S.arcadeOptions = {};
    if (defs.length) {
      var rules = h('div', { class: 'rx-form rx-arcade-rules', style: { padding: '0' } });
      var toggles = h('div', { class: 'rx-toggles' });
      defs.forEach(function (d) {
        var cur = S.arcadeOptions[d.id];
        if (d.type === 'choice') {
          var ch = d.choices || [];
          if (ids(ch).indexOf(cur) < 0) cur = S.arcadeOptions[d.id] = d.default != null ? d.default : (ch[0] && ch[0].id);
          var fd = field(d.name || d.id, segmented(ch, cur, function (v, o) { S.arcadeOptions[d.id] = v; persist(); if (fd._desc) fd._desc.textContent = o.desc || d.desc || ''; refreshSetupState(); }),
            { desc: (pick(ch, cur) || {}).desc || d.desc || '' });
          rules.appendChild(fd);
        } else {
          if (cur == null) cur = S.arcadeOptions[d.id] = d.default !== false;
          toggles.appendChild(toggleRow(d.name || d.id, d.desc || '', !!cur, function (v) { S.arcadeOptions[d.id] = v; persist(); refreshSetupState(); }));
        }
      });
      if (toggles.children.length) rules.appendChild(toggles);
      form.appendChild(field('Arcade rules', rules));
    }
    commonFields(form, mods);
    right.appendChild(form);

    var main = h('div', { class: 'rx-setup-main' }, left, right);
    var summary = h('div', { class: 'rx-summary' });
    refs.summary = summary;
    var startBtn = h('button', { class: 'cb-btn rx-btn primary big', type: 'button', onclick: startRace }, icon('bolt', 18), 'Start arcade');
    refs.startBtn = startBtn;
    var foot = h('footer', { class: 'rx-footer' }, summary,
      h('span', { class: 'rx-dim', style: { 'font-size': 'var(--fs-sm)', 'margin-left': 'auto' } }, kbd('Enter'), ' to start'), startBtn);
    startBtn.style.marginLeft = '0';   // the hint keeps the CTA docked right, like the race / drift footer
    var screen = h('div', { class: 'rx-setup rx-arcade' }, top, main, foot);
    U.host.appendChild(screen);
    renderArcadeFeatured();
    refreshSetupState();
    requestAnimationFrame(drawSetupCanvases);
  }
  function renderArcadeFeatured() {
    var refs = U.setupRefs, S = U.settings, el = refs.featured;
    if (!el) return;
    clear(el);
    var def = findTrack(S.trackId);
    if (!def) { el.appendChild(h('div', { class: 'rx-featured-info' }, h('div', { class: 'rx-eyebrow', text: 'No track selected' }))); refs.featuredCanvas = null; return; }
    var stunt = isStuntDef(def);
    var cv = h('canvas');
    refs.featuredCanvas = cv;
    var rec = U.records.trackBest(def.id), pb = U.records.bestFor(def.id, U.hash);
    var st = stunt ? null : trackStats(def);
    el.appendChild(h('div', { class: 'rx-featured-map' }, cv));
    el.appendChild(h('div', { class: 'rx-featured-info' },
      h('div', { class: 'rx-eyebrow accent', text: stunt ? 'Stunt track' : (def.country || 'Circuit') + ' · arcade grip' }),
      h('div', { class: 'rx-track-name rx-display', text: def.name || def.id }),
      def.desc ? h('div', { class: 'rx-track-desc', text: def.desc }) : null,
      h('div', { class: 'rx-statgrid' },
        statCell('Length', isNum(def.length_m) || st ? fmtLength(isNum(def.length_m) ? def.length_m : st.length_m, S.units) : '—'),
        stunt ? statCell('Stunts', isNum(def.stunts) ? def.stunts : Array.isArray(def.features) ? def.features.length : '—') : statCell('Corners', st.corners),
        h('div', null, h('div', { class: 'rx-stat-l', text: 'Difficulty' }), h('div', { class: 'rx-stat-v' }, pips(def.difficulty || 3, 5, true))),
        statCell('Arcade record', rec ? fmtTime(rec.time) : 'Unset', null, rec ? '' : 'rx-dim'),
        statCell('Your best (this build)', pb ? fmtTime(pb.time) : '—'))));
  }
  function refreshArcadeSetup(S, refs, mods) {
    var tt = S.mode === 'time-trial';
    if (refs.fields.opponents) refs.fields.opponents.classList.toggle('is-disabled', tt || !mods.ai);
    if (refs.fields.difficulty) refs.fields.difficulty.classList.toggle('is-disabled', tt || !mods.ai);
    var def = findTrack(S.trackId);
    var cars = tt || !mods.ai ? 1 : S.opponents + 1;
    if (refs.featured && (!refs.featured._for || refs.featured._for !== S.trackId)) { renderArcadeFeatured(); refs.featured._for = S.trackId; }
    clear(refs.summary);
    append(refs.summary, [
      h('b', { text: def ? def.name || def.id : 'No track' }),
      h('span', { class: 'rx-chip arcade' }, icon('bolt', 12), 'Arcade'),
      def && isStuntDef(def) ? h('span', { class: 'rx-chip arcade', text: 'Stunt' }) : null,
      h('span', { class: 'rx-chip', text: plural(S.laps, 'lap') }),
      h('span', { class: 'rx-chip', text: cars === 1 ? 'Solo' : cars + ' cars · ' + pick(DIFFICULTIES, S.difficulty).name }),
      h('span', { class: 'rx-chip accent' }, icon('steer', 12), 'Arcade handling')
    ]);
    var stuntOk = !def || !isStuntDef(def) || !!(CB.arcade && CB.arcade.stunt && typeof CB.arcade.stunt.createSession === 'function');
    var can = mods.canRace && !!def && stuntOk;
    refs.startBtn.disabled = !can;
    refs.startBtn.title = can ? 'Start arcade session (Enter)' : (!def ? 'No track available' : !stuntOk ? 'Stunt tracks need js/arcade/stunt-track.js' : 'Race engine (js/race/engine.js) not loaded');
  }

  /* ======================================================================
     DISCIPLINE screen (first step: DRIFT / RACE)
     ====================================================================== */
  function disciplineArt(id) {
    if (id === 'drift') {
      return '<svg viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' +
        '<defs><radialGradient id="rxdg" cx="70%" cy="30%" r="80%"><stop offset="0" stop-color="#ff5a1f" stop-opacity=".42"/><stop offset=".55" stop-color="#ff5a1f" stop-opacity=".06"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>' +
        '<linearGradient id="rxds" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".22"/></linearGradient>' +
        '<filter id="rxdb"><feGaussianBlur stdDeviation="9"/></filter></defs>' +
        '<rect width="600" height="400" fill="url(#rxdg)"/>' +
        // tyre arcs (the drift line) with smoke
        '<path d="M-20 360 C 140 330 260 250 330 170 S 470 40 640 30" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="22" stroke-linecap="round"/>' +
        '<path d="M-20 392 C 150 360 280 285 350 200 S 490 75 640 62" fill="none" stroke="#000" stroke-opacity=".45" stroke-width="20" stroke-linecap="round"/>' +
        '<g filter="url(#rxdb)" opacity=".75"><ellipse cx="300" cy="215" rx="120" ry="40" fill="#d8d4cc" opacity=".35" transform="rotate(-32 300 215)"/>' +
        '<ellipse cx="200" cy="285" rx="140" ry="46" fill="#d8d4cc" opacity=".22" transform="rotate(-22 200 285)"/><ellipse cx="100" cy="335" rx="130" ry="40" fill="#d8d4cc" opacity=".14" transform="rotate(-12 100 335)"/></g>' +
        // the car, nose pointing to the inside of the corner (counter-steer)
        '<g transform="translate(410 120) rotate(-62)"><rect x="-34" y="-62" width="68" height="124" rx="22" fill="#ff5a1f"/><rect x="-26" y="-30" width="52" height="44" rx="10" fill="#101216"/>' +
        '<rect x="-30" y="-60" width="60" height="16" rx="6" fill="#ffd2b8" opacity=".55"/><rect x="-40" y="-46" width="10" height="24" rx="3" fill="#0b0b0d" transform="rotate(-24 -35 -34)"/>' +
        '<rect x="30" y="-46" width="10" height="24" rx="3" fill="#0b0b0d" transform="rotate(-24 35 -34)"/><rect x="-41" y="24" width="10" height="26" rx="3" fill="#0b0b0d"/><rect x="31" y="24" width="10" height="26" rx="3" fill="#0b0b0d"/></g>' +
        '<g stroke="url(#rxds)" stroke-width="2"><path d="M60 110h160M30 150h140M90 70h120"/></g></svg>';
    }
    var chk = '';
    for (var r = 0; r < 4; r++) for (var c = 0; c < 10; c++) if ((r + c) % 2 === 0) chk += '<rect x="' + (330 + c * 27) + '" y="' + (38 + r * 27) + '" width="27" height="27"/>';
    return '<svg viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' +
      '<defs><radialGradient id="rxrg" cx="30%" cy="30%" r="85%"><stop offset="0" stop-color="#c8a24a" stop-opacity=".36"/><stop offset=".55" stop-color="#c8a24a" stop-opacity=".05"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>' +
      '<linearGradient id="rxrt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2c31"/><stop offset="1" stop-color="#0d0e10"/></linearGradient></defs>' +
      '<rect width="600" height="400" fill="url(#rxrg)"/>' +
      '<path d="M120 400 L270 140 L330 140 L480 400 Z" fill="url(#rxrt)" opacity=".9"/>' +
      '<path d="M300 150 L300 180 M300 215 L300 255 M300 295 L300 350" stroke="#e9e6df" stroke-opacity=".55" stroke-width="6"/>' +
      '<path d="M270 140 L120 400" stroke="#e10600" stroke-width="10" stroke-dasharray="18 18"/><path d="M330 140 L480 400" stroke="#e10600" stroke-width="10" stroke-dasharray="18 18"/>' +
      '<g fill="#fff" opacity=".14" transform="skewX(-14)">' + chk + '</g>' +
      '<g opacity=".95"><rect x="212" y="292" width="48" height="84" rx="16" fill="#c8a24a"/><rect x="218" y="314" width="36" height="28" rx="7" fill="#111"/>' +
      '<rect x="338" y="250" width="40" height="70" rx="13" fill="#4d8dff"/><rect x="343" y="268" width="30" height="23" rx="6" fill="#111"/>' +
      '<rect x="278" y="200" width="34" height="58" rx="11" fill="#e10600"/><rect x="282" y="215" width="26" height="19" rx="5" fill="#111"/></g></svg>';
  }

  function showDiscipline() {
    if (!U) return;
    teardownRace();
    setScreen('discipline');
    U.resultsRedraw = null; U.setupRefs = null;
    clear(U.host);
    var S = U.settings, hasDrift = !!driftMod();
    var top = h('header', { class: 'rx-topbar' },
      h('div', { class: 'rx-brand' }, h('div', { class: 'rx-brand-mark', text: 'R' }),
        h('div', null, h('div', { class: 'rx-brand-name', text: 'Redline' }), h('div', { class: 'rx-brand-sub', text: 'Choose your discipline' }))),
      headline(null, 'discipline'),
      h('nav', { class: 'rx-steps', 'aria-hidden': 'true' },
        h('span', { class: 'rx-step is-on', html: '<b>01</b>Discipline' }),
        h('span', { class: 'rx-step', html: '<b>02</b>Circuit' }),
        h('span', { class: 'rx-step', html: '<b>03</b>Session' }),
        h('span', { class: 'rx-step', html: '<b>04</b>Drive' })),
      h('button', { class: 'cb-btn rx-btn ghost cb-back rx-back', type: 'button', onclick: close, title: backLabel() + ' (Esc)', 'aria-label': backLabel() }, icon('back', 16), backLabel(), kbd('Esc')));
    var cards = DISCIPLINES.map(function (d) {
      var off = d.id === 'drift' && !hasDrift;
      var colour = d.id === 'drift' ? 'var(--mode-drift)' : 'var(--mode-race)';
      var card = h('button', { class: 'rx-disc-card' + (S.discipline === d.id ? ' is-last' : ''), type: 'button', 'data-disc': d.id,
          style: { '--rx-disc': colour }, disabled: off ? true : null,
          title: off ? 'Drift modules (js/race/drift/*) are not loaded on this page' : d.name + ' (' + d.name.charAt(0) + ')' },
        h('div', { class: 'rx-disc-art', html: disciplineArt(d.id) }),
        h('div', { class: 'rx-eyebrow', style: { color: colour }, text: d.kicker }),
        h('div', { class: 'rx-disc-name', text: d.name }),
        h('div', { class: 'rx-disc-desc', text: off ? 'Drift mode is not available on this page.' : d.desc }),
        h('ul', { class: 'rx-disc-list' }, d.bullets.map(function (b) { return h('li', { text: b }); })),
        h('div', { class: 'rx-disc-go' }, icon(d.icon, 18), off ? 'Unavailable' : (d.id === 'drift' ? 'Go sideways' : 'Go racing'), kbd(d.name.charAt(0))));
      if (off) card.style.opacity = '.45';
      card.addEventListener('click', function () { chooseDiscipline(d.id); });
      return card;
    });
    // each discipline has its own steering assist (Race: Light, Drift: Heavy by default); changed on the setup screen
    var assistHint = h('span', { class: 'rx-disc-assist', text: 'Race ' + pick(STEER_ASSISTS, S.raceSteerAssist).name + ' · Drift ' + pick(STEER_ASSISTS, S.driftSteerAssist).name +
      ' (each is set on its setup screen)' });
    var foot = h('footer', { class: 'rx-disc-foot' }, icon('steer', 16), h('b', { text: 'Steering assist' }), assistHint);
    U.host.appendChild(h('div', { class: 'rx-disc' }, top, h('div', { class: 'rx-disc-main' }, cards), foot));
    U.disciplineCards = cards;
    var focus = cards[S.discipline === 'race' || !hasDrift ? 1 : 0];
    try { focus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  /** Numbered section badge (css/styles.css § 18 .mx-step), the number of the matching step pill. */
  function stepBadge(n) { return h('i', { class: 'mx-step', 'aria-hidden': 'true', text: String(n) }); }
  /** Screen head shared with Derby / F1 / Drag (§ 18): mode-accent kicker + serif title. The kicker follows the session mode. */
  var HEADLINES = { race: 'Go racing', drift: 'Go sideways', arcade: 'Point it and go', discipline: 'Choose your discipline' };
  function headKicker(kind) {
    var S = U && U.settings;
    if (!S || kind === 'discipline') return 'Race · Drift';
    if (kind === 'arcade') return 'Arcade · ' + (S.mode === 'time-trial' ? 'Time trial' : 'Race');
    if (kind === 'drift') return 'Drift · ' + pick(DRIFT_MODES, S.driftMode).name;
    return 'Race · ' + pick(MODES, S.mode).name;
  }
  function headline(refs, kind) {
    var k = h('div', { class: 'mx-kicker rx-head-kicker', text: headKicker(kind) });
    if (refs) refs.kicker = k;
    return h('div', { class: 'rx-headline' }, k, h('h1', { class: 'mx-title rx-head-title', text: HEADLINES[kind] || '' }));
  }
  function syncHeadline() {
    var refs = U && U.setupRefs;
    if (refs && refs.kicker) refs.kicker.textContent = headKicker(isArcadeS(U.settings) ? 'arcade' : U.settings.discipline === 'drift' ? 'drift' : 'race');
  }
  /** Race | Drift switch (shared .cb-tabs look). Routed: navigates between #/race and #/drift. */
  function disciplineTabs(active) {
    var hasDrift = !!driftMod();
    var list = h('div', { class: 'cb-tab-list rx-disc-tabs', role: 'tablist', 'aria-label': 'Discipline' });
    var discs = [{ id: 'race', name: 'Race', icon: 'flag' }, { id: 'drift', name: 'Drift', icon: 'drift' }];
    // routed (#/race, #/drift, #/arcade): the three setups share one switch; Arcade is its own route
    if (U && U.layer && routerApi()) discs.push({ id: 'arcade', name: 'Arcade', icon: 'bolt' });
    discs.forEach(function (d) {
      var off = d.id === 'drift' && !hasDrift;
      list.appendChild(h('button', { class: 'cb-tab' + (d.id === active ? ' is-active' : ''), type: 'button', role: 'tab',
        'aria-selected': d.id === active ? 'true' : 'false', disabled: off ? true : null, style: { '--mc': 'var(--mode-' + d.id + ')' },
        title: off ? 'Drift modules (js/race/drift/*) are not loaded' : d.name + ' mode',
        onclick: function () { if (d.id !== active) switchDiscipline(d.id); } }, icon(d.icon, 15), d.name));
    });
    return h('div', { class: 'cb-tabs rx-disc-switch' }, list);
  }
  function switchDiscipline(id) {
    if (!U) return;
    if (id === 'drift' && !driftMod()) { toast(icon('warn', 14), 'Drift modules are not loaded'); return; }
    if (id === 'arcade' && !(U.layer && !isGameLaunch())) return;   // Arcade is reached through its route only
    if (U.layer && !isGameLaunch()) {
      // carry the launcher's callbacks (e.g. the Atelier's onFinish) and return point over to the other route
      var keep = {}, o = U.opts || {};
      for (var k in o) if (has(o, k) && k !== '_layer' && k !== '_route' && k !== 'discipline' && k !== 'autoStart') keep[k] = o[k];
      keep.settings = launchSettings(o);
      delete keep.settings.trackId;
      RT.pending = { route: id, build: null, opts: keep };
      U.switching = true;   // the launcher's onClose fires when race mode really closes, not on a Race <-> Drift switch
      if (goRoute(id)) return;
      if (U) U.switching = false;
      RT.pending = null;
    }
    chooseDiscipline(id);
  }
  function chooseDiscipline(id) {
    if (!U) return;
    if (id === 'drift' && !driftMod()) { toast(icon('warn', 14), 'Drift modules are not loaded'); return; }
    setDiscipline(U.settings, id);
    persist();
    showSetup();
  }

  function moduleBanner(mods) {
    var missing = Object.keys(MODULE_INFO).filter(function (k) { return !mods[k]; });
    if (!missing.length) return null;
    var hard = missing.filter(function (k) { return MODULE_INFO[k].required; });
    var list = h('ul');
    missing.forEach(function (k) {
      var m = MODULE_INFO[k];
      list.appendChild(h('li', { html: '<code>' + m.file + '</code> — ' + escapeHtml(m.label) + (m.required ? ' <b style="color:#ff8a8a">(required)</b>' : (m.note ? ' · ' + escapeHtml(m.note) : '')) }));
    });
    return h('div', { class: 'rx-banner' + (hard.length ? ' bad' : '') }, icon('warn', 18),
      h('div', null, h('b', { text: hard.length ? 'Race mode can’t start yet — core modules are missing.' : 'Some race modules are not loaded; using fallbacks.' }), list));
  }

  function selectTrack(id) {
    var S = U.settings;
    if (S.trackId === id) return;
    if (isLocked('trackId')) { toast('The circuit is fixed for this event'); return; }
    S.trackId = id; persist();
    var refs = U.setupRefs;
    Object.keys(refs.cards).forEach(function (k) {
      var on = k === id;
      refs.cards[k].classList.toggle('is-selected', on);
      refs.cards[k].setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderFeatured();
    refreshSetupState();
    requestAnimationFrame(function () { if (refs.featuredCanvas) drawTrackThumb(refs.featuredCanvas, findTrack(id), { sectors: true, padding: 26, maxWidth: 12, labels: true }); });
  }

  function renderFeatured() {
    if (U && isArcadeS(U.settings)) { renderArcadeFeatured(); return; }
    var refs = U.setupRefs, S = U.settings, el = refs.featured;
    clear(el);
    var def = findTrack(S.trackId);
    if (!def) {
      el.appendChild(h('div', { class: 'rx-featured-info' }, h('div', { class: 'rx-eyebrow', text: 'No circuit selected' })));
      refs.featuredCanvas = null;
      return;
    }
    var st = trackStats(def);
    var cv = h('canvas');
    refs.featuredCanvas = cv;
    var acc = accentColor();
    var driftRec = S.discipline === 'drift';
    var rec = driftRec ? U.records.driftTrackBest(def.id) : U.records.trackBest(def.id);
    var pb = driftRec ? U.records.driftBestFor(def.id, U.hash) : U.records.bestFor(def.id, U.hash);
    var recText = function (r) { return r ? (driftRec ? fmtPts(r.score) + ' pts' : fmtTime(r.time)) : null; };
    var grip = def.surface && isNum(def.surface.grip) ? def.surface.grip : null;
    el.appendChild(h('div', { class: 'rx-featured-map' }, cv,
      h('div', { class: 'rx-map-legend' },
        h('span', null, h('i', { style: { background: acc } }), 'S1'),
        h('span', null, h('i', { style: { background: '#e9e6df' } }), 'S2'),
        h('span', null, h('i', { style: { background: '#6fa8ff' } }), 'S3'))));
    el.appendChild(h('div', { class: 'rx-featured-info' },
      h('div', { class: 'rx-eyebrow accent', text: def.country || 'Circuit' }),
      h('div', { class: 'rx-track-name rx-display', text: def.name || def.id }),
      def.desc ? h('div', { class: 'rx-track-desc', text: def.desc }) : null,
      h('div', { class: 'rx-statgrid' },
        statCell('Length', fmtLength(st.length_m, S.units)),
        statCell('Corners', st.corners),
        h('div', null, h('div', { class: 'rx-stat-l', text: 'Difficulty' }), h('div', { class: 'rx-stat-v' }, pips(def.difficulty || 3, 5, true))),
        statCell('Width', isNum(def.width_m) ? def.width_m.toFixed(0) : '—', 'm'),
        statCell('Surface grip', grip != null ? Math.round(grip * 100) : '—', grip != null ? '%' : ''),
        S.discipline === 'drift'
          ? statCell('Drift zones', Array.isArray(def.driftZones) ? def.driftZones.length : 'Auto', null, isDriftTrack(def) ? 'rx-accent' : 'rx-dim')
          : statCell('Laps × distance', S.mode === 'practice' ? '∞' : fmtLength(st.length_m * S.laps, S.units)),
        statCell(driftRec ? 'Your best score' : 'Your track record', rec ? recText(rec) : 'Unset', null, rec ? '' : 'rx-dim'),
        statCell('Your best (this build)', pb ? recText(pb) : '—'))));
    refs.featuredDistance = el.querySelectorAll('.rx-statgrid > div')[5];
  }

  function carCard() {
    var b = U.build, mi = U.metricsInfo, m = mi.m, S = U.settings;
    var thumb = h('div', { class: 'rx-car-thumb' });
    var svg = null;
    try { if (CB.render && typeof CB.render.thumbnail === 'function') svg = CB.render.thumbnail(b); } catch (e) { svg = null; }
    if (typeof svg === 'string' && svg.indexOf('<svg') >= 0) thumb.innerHTML = svg;
    else if (svg && svg.nodeType === 1) thumb.appendChild(svg);
    else thumb.innerHTML = fallbackCarSvg(b);
    var paint = (b.exterior && b.exterior.paint) || '#b3121f';
    var mph = S.units === 'mph';
    var z = mph ? m.zeroTo60_s : (isNum(m.zeroTo100_s) ? m.zeroTo100_s : m.zeroTo60_s);
    var top = mph ? (isNum(m.topSpeed_mph) ? m.topSpeed_mph : (m.topSpeed_kph || 0) / 1.609344) : m.topSpeed_kph;
    var weight = mph ? m.weight_kg * 2.20462 : m.weight_kg;
    var card = h('div', { class: 'cb-card rx-panel rx-car', style: { '--rx-paint': paint } },
      mi.estimated ? h('span', { class: 'rx-chip rx-est', title: 'CB.physics unavailable — figures are estimated from the build', text: 'Estimated' }) : null,
      thumb,
      h('div', null,
        carModelLabel(b) ? h('div', { class: 'rx-car-make', text: carModelLabel(b) }) : null,
        h('div', { class: 'rx-car-name', text: (b.meta && b.meta.name) || carModelLabel(b) || 'Untitled Build' }),
        h('div', { class: 'rx-car-sub', text: nameOf('bodyStyles', b.body && b.body.style) + ' · ' + engineLabel(b) }),
        h('div', { class: 'rx-car-stats' },
          statCell('Power', fmtInt(m.power_hp), 'hp'),
          statCell('Weight', fmtInt(weight), mph ? 'lb' : 'kg'),
          statCell(mph ? '0–60' : '0–100', isNum(z) ? z.toFixed(1) : '—', 's'),
          statCell('Torque', fmtInt(m.torque_nm), 'Nm'),
          statCell('Top speed', fmtInt(top), mph ? 'mph' : 'km/h'),
          statCell('Power/ton', fmtInt(m.powerToWeight_hpPerTon), 'hp/t')),
        h('div', { class: 'rx-car-chips' },
          h('span', { class: 'rx-chip accent', text: String((b.drivetrain && b.drivetrain.layout) || 'rwd').toUpperCase() }),
          h('span', { class: 'rx-chip', text: nameOf('tireCompounds', b.tires && b.tires.compound) + ' tyres' }),
          h('span', { class: 'rx-chip', text: nameOf('transmissions', b.transmission && b.transmission.type) + (b.transmission && b.transmission.gears > 1 ? ' · ' + b.transmission.gears + '-spd' : '') }),
          b.aero && b.aero.wing && b.aero.wing !== 'none' ? h('span', { class: 'rx-chip', text: nameOf('aero.wings', b.aero.wing) }) : null,
          isNum(m.lapTime_s) ? h('span', { class: 'rx-chip', title: 'Physics estimate for the Redline Ring', text: 'Sim lap ' + fmtTime(m.lapTime_s) }) : null)));
    return card;
  }

  /** "Porsche 911 (992)" for the build's real manufacturer model (CB.shapes, js/shapes/README.md), or ''. */
  function carModelLabel(b) {
    var S = CB.shapes;
    try {
      var m = S && typeof S.getModel === 'function' ? S.getModel(b) : null;
      if (m) return [m.make, m.name].filter(Boolean).join(' ');
    } catch (e) { /* ignore */ }
    return '';
  }
  function fallbackCarSvg(b) {
    var paint = (b.exterior && b.exterior.paint) || '#b3121f';
    var wheel = (b.wheels && b.wheels.finish) || '#2b2b2b';
    return '<svg viewBox="0 0 220 90" width="200" height="82" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="rxp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".45" stop-color="' + escapeHtml(paint) + '"/><stop offset="1" stop-color="#000" stop-opacity=".6"/></linearGradient></defs>' +
      '<ellipse cx="110" cy="78" rx="96" ry="5" fill="#000" opacity=".5"/>' +
      '<path d="M14 62 C14 52 22 48 40 46 L70 44 C84 30 100 24 128 24 C150 24 164 32 178 44 L198 48 C206 50 208 56 208 62 L208 66 L14 66 Z" fill="' + escapeHtml(paint) + '"/>' +
      '<path d="M14 62 C14 52 22 48 40 46 L70 44 C84 30 100 24 128 24 C150 24 164 32 178 44 L198 48 C206 50 208 56 208 62 L208 66 L14 66 Z" fill="url(#rxp)"/>' +
      '<path d="M80 44 C92 33 104 29 126 29 C144 29 156 35 166 44 Z" fill="#0b0d10" opacity=".85"/>' +
      '<circle cx="56" cy="66" r="14" fill="#0c0c0c"/><circle cx="56" cy="66" r="9" fill="' + escapeHtml(wheel) + '" stroke="#888" stroke-width="1"/>' +
      '<circle cx="168" cy="66" r="14" fill="#0c0c0c"/><circle cx="168" cy="66" r="9" fill="' + escapeHtml(wheel) + '" stroke="#888" stroke-width="1"/>' +
      '</svg>';
  }

  function sessionForm(mods) {
    var S = U.settings, refs = U.setupRefs;
    var form = h('div', { class: 'rx-panel rx-form' });
    if (S.discipline === 'drift') { driftFields(form); return commonFields(form, mods); }
    var modeField = field('Mode', segmented(MODES, S.mode, function (v, o) {
      S.mode = v; persist(); modeField._desc.textContent = o.desc; refreshSetupState(); renderFeatured();
      requestAnimationFrame(function () { if (refs.featuredCanvas) drawTrackMap(refs.featuredCanvas, findTrack(S.trackId), { sectors: true, padding: 26, maxWidth: 12, labels: true }); });
    }), { desc: pick(MODES, S.mode).desc });
    lockIf('mode', modeField);
    form.appendChild(modeField);

    var lapsField = field('Laps', stepper(S.laps, 1, 50, function (v) {
      S.laps = v; persist(); refreshSetupState();
      var def = findTrack(S.trackId);
      if (def && refs.featuredDistance) { var vv = refs.featuredDistance.querySelector('.rx-stat-v'); if (vv) vv.textContent = S.mode === 'practice' ? '∞' : fmtLength(trackStats(def).length_m * S.laps, S.units); }
    }, [1, 3, 5, 10]));
    var oppField = field('Opponents', stepper(S.opponents, 1, 11, function (v) { S.opponents = v; persist(); refreshSetupState(); }, [3, 7, 11]));
    lockIf('laps', lapsField); lockIf('opponents', oppField);
    refs.fields.laps = lapsField; refs.fields.opponents = oppField;
    form.appendChild(h('div', { class: 'rx-two' }, lapsField, oppField));

    var diffField = field('AI difficulty', segmented(DIFFICULTIES, S.difficulty, function (v, o) { S.difficulty = v; persist(); diffField._desc.textContent = o.desc; refreshSetupState(); }), { desc: pick(DIFFICULTIES, S.difficulty).desc });
    var fieldField = field('Field', segmented(FIELDS, S.field, function (v, o) { S.field = v; persist(); fieldField._desc.textContent = o.desc; }), { desc: pick(FIELDS, S.field).desc });
    lockIf('difficulty', diffField); lockIf('field', fieldField);
    refs.fields.difficulty = diffField; refs.fields.field = fieldField;
    form.appendChild(diffField);
    form.appendChild(fieldField);
    if (!mods.ai) form.appendChild(h('div', { class: 'rx-field-desc', text: 'AI module not loaded — you will run alone.' }));

    form.appendChild(steerAssistField());
    var assists = h('div', { class: 'rx-toggles' });
    ASSISTS.forEach(function (a) {
      if (a.id === 'steeringAssist') return;   // superseded by the CB.race.assist level selector above
      assists.appendChild(toggleRow(a.name, a.hint, S.assists[a.id], function (v) { S.assists[a.id] = v; persist(); }));
    });
    var rb = toggleRow('Rubber-banding', 'AI pace adapts to keep it close', S.rubberBanding, function (v) { S.rubberBanding = v; persist(); });
    if (isLocked('rubberBanding')) { rb.disabled = true; rb.classList.add('is-locked'); }
    refs.rubber = rb;
    assists.appendChild(rb);
    form.appendChild(field('Driving aids', assists));
    return commonFields(form, mods);
  }

  /** Steering assist level (CB.race.assist), remembered per discipline: Light for racing, Heavy for drifting by default. */
  function steerAssistField() {
    var S = U.settings;
    var has = !!(CB.race && CB.race.assist && typeof CB.race.assist.create === 'function') || !!driftMod();
    var f = field('Steering assist', segmented(STEER_ASSISTS, S.steerAssist, function (v, o) { setAssist(S, v); persist(); f._desc.textContent = o.desc; refreshSetupState(); }),
      { desc: pick(STEER_ASSISTS, S.steerAssist).desc + (has ? '' : ' (basic smoothing: js/race/drift/assist.js not loaded)'), headExtra: icon('steer', 14) });
    return f;
  }

  /** Drift-specific session fields: mode, run length, handling tune, assist. */
  function driftFields(form) {
    var S = U.settings, refs = U.setupRefs;
    var modeField = field('Drift mode', segmented(DRIFT_MODES, S.driftMode, function (v, o) {
      S.driftMode = v; persist(); modeField._desc.textContent = o.desc; refreshSetupState();
    }), { desc: pick(DRIFT_MODES, S.driftMode).desc });
    lockIf('driftMode', modeField);
    form.appendChild(modeField);
    var durField = field('Run length', segmented(DRIFT_DURATIONS, String(S.driftDuration), function (v) { S.driftDuration = +v; persist(); refreshSetupState(); }),
      { desc: 'Score attack and tandem runs end when the clock runs out' });
    lockIf('driftDuration', durField);
    refs.fields.duration = durField;
    var tuneField = field('Drift tune', segmented(DRIFT_TUNES, S.driftTune, function (v, o) { S.driftTune = v; persist(); tuneField._desc.textContent = o.desc; }),
      { desc: pick(DRIFT_TUNES, S.driftTune).desc });
    form.appendChild(h('div', { class: 'rx-two' }, durField, tuneField));
    form.appendChild(steerAssistField());
    var diffField = field('Scoring difficulty', segmented(DIFFICULTIES, S.difficulty, function (v, o) { S.difficulty = v; persist(); diffField._desc.textContent = o.desc; }),
      { desc: 'Sets the medal targets (and the tandem lead driver)' });
    lockIf('difficulty', diffField);
    form.appendChild(diffField);
    var aids = h('div', { class: 'rx-toggles' },
      toggleRow('Automatic gearbox', 'Holds the gear through a drift', S.assists.autoShift, function (v) { S.assists.autoShift = v; persist(); }),
      toggleRow('Racing line', 'Show the drift line', S.assists.racingLine, function (v) { S.assists.racingLine = v; persist(); }));
    form.appendChild(field('Driving aids', aids, { desc: 'ABS stays on and traction control is off for drifting' }));
  }

  /** Fields shared by both disciplines: weather, graphics + camera, units, controls. */
  function commonFields(form, mods) {
    var S = U.settings;
    void mods;
    form.appendChild(h('div', { class: 'rx-two' },
      lockIf('weather', field('Weather', segmented(WEATHERS, S.weather, function (v) { S.weather = v; persist(); refreshSetupState(); }))),
      lockIf('timeOfDay', field('Time of day', segmented(TIMES, S.timeOfDay, function (v) { S.timeOfDay = v; persist(); refreshSetupState(); })))));

    // graphics: 3D (WebGL) or top-down 2D; the camera list follows the choice
    var has3d = can3d();
    var gfxOn3d = has3d && S.graphics === '3d';
    var camHost = h('div');
    var qualityField = field('Quality', segmented(QUALITIES, S.quality, function (v, o) { S.quality = v; persist(); qualityField._desc.textContent = o.desc || ''; }),
      { desc: pick(QUALITIES, S.quality).desc || '' });
    function renderCamField() {
      clear(camHost);
      var on3d = has3d && S.graphics === '3d';
      var ck = cam3dKey(S);
      camHost.appendChild(on3d
        ? field('Camera', segmented(CAMERAS_3D, S[ck], function (v) { S[ck] = v; persist(); }), { desc: 'C cycles in race · hold B to look back' + (S.discipline === 'drift' ? ' · chase is the classic drift view' : '') })
        : field('Camera', segmented(CAMERAS, S.camera, function (v) { S.camera = v; persist(); }), { desc: 'C cycles in race' }));
      qualityField.classList.toggle('is-disabled', !on3d);
    }
    var gfxField = field('Graphics', segmented(GRAPHICS, gfxOn3d ? '3d' : '2d', function (v) {
      if (v === '3d' && !has3d) return;
      S.graphics = v; persist(); renderCamField();
      if (gfxField._desc) gfxField._desc.textContent = v === '3d' ? 'WebGL 3D — cockpit, chase & TV cameras' : 'Canvas 2D top-down view';
    }), { desc: has3d ? (gfxOn3d ? 'WebGL 3D — cockpit, chase & TV cameras' : 'Canvas 2D top-down view') : '3D needs WebGL (not available here) — using top-down' });
    if (!has3d) gfxField.classList.add('is-disabled');
    form.appendChild(h('div', { class: 'rx-two' }, gfxField, qualityField));
    renderCamField();
    form.appendChild(camHost);
    form.appendChild(h('div', { class: 'rx-two' },
      field('Units', segmented(UNITS, S.units, function (v) {
        S.units = v; persist(); setProfileUnits(v);
        var keep = U.setupRefs && U.setupRefs.featured ? document.querySelector('#race-root .rx-setup-main .rx-col:last-child') : null;
        var sc = keep ? keep.scrollTop : 0;
        showSetup();
        var nk = document.querySelector('#race-root .rx-setup-main .rx-col:last-child');
        if (nk) nk.scrollTop = sc;
      }))));

    var ctl = h('details', { class: 'rx-details' }, h('summary', null, icon('settings', 14), 'Controls & input'));
    var sensField = field('Steering sensitivity', rangeInput(0.5, 1.6, 0.05, S.steerSensitivity, function (v) {
      S.steerSensitivity = v; persist(); sensField._val.textContent = Math.round(v * 100) + '%';
    }), { value: Math.round(S.steerSensitivity * 100) + '%' });
    ctl.appendChild(h('div', { class: 'rx-form', style: { padding: '0' } },
      sensField,
      h('div', { class: 'rx-toggles' },
        toggleRow('Invert steering', 'Flip left/right if your setup needs it', S.invertSteer, function (v) { S.invertSteer = v; persist(); }),
        toggleRow('Sound', 'Engine, tyres & impacts', !S.muted, function (v) { S.muted = !v; persist(); }),
        toggleRow('Control hints', 'Show key hints at race start', S.showHints, function (v) { S.showHints = v; persist(); })),
      field('Touch controls', segmented(TOUCH_MODES, S.touchControls, function (v) { S.touchControls = v; persist(); }), { desc: 'Auto shows on-screen pedals on touch devices' }),
      phoneSetupRow(),
      keysReference()));
    form.appendChild(ctl);
    return form;
  }

  function refreshSetupState() {
    if (!U || !U.setupRefs) return;
    var S = U.settings, refs = U.setupRefs, mods = moduleStatus();
    syncHeadline();
    if (S.discipline === 'drift') { refreshDriftSetup(S, refs, mods); return; }
    if (isArcadeS(S)) { refreshArcadeSetup(S, refs, mods); return; }
    var tt = S.mode === 'time-trial', pr = S.mode === 'practice';
    if (refs.fields.opponents) refs.fields.opponents.classList.toggle('is-disabled', tt || !mods.ai);
    if (refs.fields.difficulty) refs.fields.difficulty.classList.toggle('is-disabled', tt || !mods.ai);
    if (refs.fields.field) refs.fields.field.classList.toggle('is-disabled', tt || !mods.ai);
    if (refs.rubber) refs.rubber.style.opacity = tt ? '.38' : '';
    if (refs.fields.laps) {
      refs.fields.laps.classList.toggle('is-disabled', pr);
      var lbl = refs.fields.laps.querySelector('.rx-label');
      if (lbl) lbl.textContent = pr ? 'Laps (unlimited)' : 'Laps';
    }
    var def = findTrack(S.trackId);
    var cars = tt || !mods.ai ? 1 : S.opponents + 1;
    clear(refs.summary);
    append(refs.summary, [
      h('b', { text: def ? def.name : 'No circuit' }),
      h('span', { class: 'rx-chip accent', text: pick(MODES, S.mode).name }),
      h('span', { class: 'rx-chip', text: pr ? 'Open session' : plural(S.laps, 'lap') }),
      h('span', { class: 'rx-chip', text: cars === 1 ? 'Solo' : cars + ' cars · ' + pick(DIFFICULTIES, S.difficulty).name }),
      h('span', { class: 'rx-chip accent' }, icon('steer', 12), pick(STEER_ASSISTS, S.steerAssist).name + ' assist'),
      h('span', { class: 'rx-chip' }, icon(pick(WEATHERS, S.weather).icon, 12), pick(WEATHERS, S.weather).name),
      h('span', { class: 'rx-chip' }, icon(pick(TIMES, S.timeOfDay).icon, 12), pick(TIMES, S.timeOfDay).name)
    ]);
    var can = mods.canRace && !!def;
    refs.startBtn.disabled = !can;
    refs.startBtn.title = can ? 'Start race (Enter)' : (!mods.engine ? 'Race engine (js/race/engine.js) not loaded' : 'No circuit available');
  }

  function refreshDriftSetup(S, refs, mods) {
    var free = S.driftMode === 'free';
    if (refs.fields.duration) refs.fields.duration.classList.toggle('is-disabled', free);
    var def = findTrack(S.trackId);
    clear(refs.summary);
    append(refs.summary, [
      h('b', { text: def ? def.name : 'No circuit' }),
      h('span', { class: 'rx-chip drift' }, icon('drift', 12), pick(DRIFT_MODES, S.driftMode).name),
      h('span', { class: 'rx-chip', text: free ? 'Endless' : (S.driftDuration >= 120 ? (S.driftDuration / 60) + ' min' : S.driftDuration + ' s') }),
      S.driftMode === 'tandem' ? h('span', { class: 'rx-chip', text: 'vs AI lead' }) : null,
      h('span', { class: 'rx-chip', text: pick(DRIFT_TUNES, S.driftTune).name + ' tune' }),
      h('span', { class: 'rx-chip accent' }, icon('steer', 12), pick(STEER_ASSISTS, S.steerAssist).name + ' assist'),
      h('span', { class: 'rx-chip' }, icon(pick(WEATHERS, S.weather).icon, 12), pick(WEATHERS, S.weather).name),
      def && !isDriftTrack(def) ? h('span', { class: 'rx-chip', title: 'Not a dedicated drift venue: clipping zones are generated from the corners', text: 'Grip circuit' }) : null
    ]);
    var can = mods.canRace && !!def && !!driftMod();
    refs.startBtn.disabled = !can;
    refs.startBtn.title = can ? 'Start drift session (Enter)' : (!driftMod() ? 'Drift modules (js/race/drift/*) not loaded' : 'No circuit available');
  }

  function drawSetupCanvases() {
    if (!U || !U.setupRefs) return;
    var refs = U.setupRefs;
    Object.keys(refs.cards).forEach(function (id) {
      var c = refs.cards[id];
      try { drawTrackThumb(c._canvas, c._def, { padding: 12, maxWidth: 5, minWidth: 2.2, direction: true }); } catch (e) { /* ignore */ }
    });
    if (refs.featuredCanvas) {
      try { drawTrackThumb(refs.featuredCanvas, findTrack(U.settings.trackId), { sectors: true, padding: 26, maxWidth: 12, labels: true }); } catch (e2) { /* ignore */ }
    }
  }

  /* ======================================================================
     LOADING / GRID
     ====================================================================== */
  /** Launch the session from U.settings. start = { immediate: true } (test hooks, window.drift.start) builds it
      synchronously and drives straight on (no loading screen wait, no timers: works in a background tab). */
  function startRace(start) {
    if (!U) return;
    var net = U.opts && U.opts.net && U.opts.net.session ? U.opts.net : null;
    if (net && U.race && U.race.net === net) return;   // a net session runs once (rematch = a new session from the lobby)
    var immediate = !!(start && start.immediate === true) || !!net;   // net: the race clock already runs on the host
    var mods = moduleStatus();
    var S = U.settings;
    // direct launches (#/race?quick=1, game launches) skip showSetup(), which is where the default circuit is picked:
    // resolve it here too (a fresh profile has no remembered trackId -> "No circuit is available" although tracks exist)
    if (S.discipline === 'drift' && !driftMod()) { S.discipline = 'race'; syncAssist(S); }
    if (U.launchLock) enforceLaunchLock(S);   // a career round / challenge always races as launched (setup cannot change it)
    var def = net ? (netGet(net.session, 'trackDef') || findTrack(S.trackId) || (net.cfg && net.cfg.track) || null) : findTrack(S.trackId);
    if (!def && !net && isArcadeS(S)) { S.trackId = arcadeDefaultTrack(arcadeTracks()); def = findTrack(S.trackId); }
    if (!def && !net) {
      var tl = tracksFor(S.discipline);
      S.trackId = S.discipline === 'drift' ? (tl[0] && tl[0].id) || null : defaultTrackId(tl);
      def = findTrack(S.trackId);
    }
    if (!mods.canRace || !def) {
      showError(!mods.engine ? 'The race engine is not loaded.' : 'No circuit is available.',
        'Race mode needs js/race/tracks.js and js/race/engine.js. Missing: ' +
        Object.keys(MODULE_INFO).filter(function (k) { return MODULE_INFO[k].required && !mods[k]; }).map(function (k) { return MODULE_INFO[k].file; }).join(', '));
      return;
    }
    if (!U.launchLock) enforceLaunchLock(S);   // first start of a game launch: capture the launch session
    persist();
    teardownRace();
    // Audio must be created inside the user gesture.
    var audio = null;
    if (mods.audio) {
      try { audio = CB.race.audio.create(); if (audio && typeof audio.start === 'function') audio.start(); if (audio && audio.setMuted) audio.setMuted(true); } catch (e) { audio = null; }
    }
    var drifting = S.discipline === 'drift' && !!driftMod();
    var R = U.race = {
      def: def, settings: deepClone(S), audio: audio, session: null, renderer: null, hud: null, input: null,
      isDrift: drifting, isArcade: isArcadeS(S) && (!net || !!netGet(net.session, 'isArcadeNet')), dhud: null, rawInput: false, assistVia: 'none', driftGoAt: null, rawResults: null,
      raf: 0, running: false, simActive: false, paused: false, acc: 0, last: 0, simTime: 0,
      tracker: createLapTracker(), feed: [], events: { collisions: 0, lastCollision: -9 },
      recordFlags: { buildBest: false, trackRecord: false, prevBuild: null, prevTrack: null, lapTime: null },
      playerFinishedAt: null, sessionFinishedAt: null, ended: false, ready: false, lastSnap: null,
      fallbackRenderer: false, fallbackHud: false, lightsState: '', goShown: false, hintsTimer: null,
      cameraIdx: Math.max(0, ids(CAMERAS).indexOf(S.camera)), playerSpeed: 0, is3d: false, aq: null, lookBack: false
    };
    R.immediate = immediate; R.testCfg = immediate && start && isPlain(start.cfg) ? start.cfg : null;
    R.forced = driftHooks && driftHooks._forced ? Object.assign({}, driftHooks._forced) : null;   // window.drift.setInput
    if (drifting) { R.settings.mode = 'practice'; createDriftSfx(R); }   // drift runs are engine practice sessions (scored by the drift scorer)
    if (net) setupNetRace(R, net);
    showLoading(def);
    var steps = U.loadingRefs.steps;
    var stepIdx = 0;
    function mark(i, state) {
      var el = steps[i]; if (!el) return;
      el.className = state;
      U.loadingRefs.bar.style.width = Math.round(((state === 'is-done' ? i + 1 : i) / steps.length) * 100) + '%';
    }
    function fail(e, where) {
      if (!U || U.race !== R) return;
      mark(stepIdx, 'is-error');
      if (typeof console !== 'undefined') console.error('[race-ui] ' + where, e);
      showError('Could not start the session (' + where + ').', (e && (e.stack || e.message)) || String(e));
    }
    var tasks = [
      function () { // grid
        var opps = [];
        if (R.isDrift || R.net) { R.opponents = []; return; }   // net: the host's grid (players + AI fill) is in the session   // the drift session adds its own tandem lead car
        var L0 = launchCfg(def);
        if (L0 && Array.isArray(L0.opponents) && L0.opponents.length && R.settings.mode === 'race') {
          var oppCap = isNum(L0.maxOpponents) ? L0.maxOpponents : (isNum(R.settings.opponents) ? R.settings.opponents : L0.opponents.length);   // plugin grids (F1: 21)
          R.opponents = L0.opponents.slice(0, Math.max(1, oppCap));
          return;
        }
        if (R.settings.mode !== 'time-trial' && moduleStatus().ai) {
          opps = CB.race.ai.createGrid(U.build, {
            count: R.settings.opponents, difficulty: R.settings.difficulty, field: R.settings.field,
            rubberBanding: R.settings.rubberBanding, trackId: def.id
          }) || [];
        }
        R.opponents = Array.isArray(opps) ? opps : [];
      },
      function () { // session (geometry, racing line, grid placement)
        if (U.launchLock && U.launchLock.fieldSize == null && !R.isDrift) U.launchLock.fieldSize = (R.opponents ? R.opponents.length : 0) + 1;
        var mi = U.metricsInfo;
        var cfg = {
          trackId: def.id, track: def,
          laps: R.settings.mode === 'practice' ? 50 : R.settings.laps,
          opponents: R.opponents, opponentCount: R.opponents.length,
          playerBuild: U.build, playerMetrics: mi.estimated ? null : mi.m,
          playerName: playerDriverName(),
          weather: R.settings.weather, timeOfDay: R.settings.timeOfDay, mode: R.settings.mode,
          assists: deepClone(R.settings.assists),
          difficulty: R.settings.difficulty, field: R.settings.field, rubberBanding: R.settings.rubberBanding,
          buildHash: U.hash
        };
        if (R.isArcade) {   // ARCADE-SPEC: every car on the arcade vehicle model
          cfg.handling = 'arcade'; cfg.arcade = arcadeSettingsOf(R.settings); cfg.steerAssist = 'off';   // no assist layer in arcade
          cfg.rubberBanding = false; cfg.field = 'mixed';
          if (R.testCfg && R.testCfg.seed != null) cfg.seed = R.testCfg.seed;
        }
        var L1 = launchCfg(def);
        if (L1) {
          ['extras', 'hooks', 'seed', 'startPosition', 'maxTime_s', 'gridOrder', 'playerTeam', 'challengeId', 'lightsOutDelay_s',
           'persistGhost', 'trackLimitsWarnings', 'stuckDnf_s', 'career', 'maxOpponents'].forEach(function (k) { if (L1[k] !== undefined) cfg[k] = L1[k]; });
          if (L1.playerName) cfg.playerName = L1.playerName;
          if (L1.challenge && !(cfg.extras && cfg.extras.challenge)) cfg.extras = Object.assign({}, cfg.extras || {}, { challenge: L1.challenge });
        }
        R.challenge = L1 && L1.challenge && typeof L1.challenge.evaluate === 'function' ? L1.challenge : null;
        if (R.challenge && typeof R.challenge.reset === 'function') { try { R.challenge.reset(); } catch (e) { /* ignore */ } }
        R.challengeEval = null; R.challengeDoneAt = null;
        try { R.replayBaseline = CB.game && CB.game.replay && typeof CB.game.replay.last === 'function' ? CB.game.replay.last() : null; } catch (eRb) { R.replayBaseline = null; }
        var cfgP = pluginCall('configure', [cfg, R]);
        if (cfgP && typeof cfgP === 'object') cfg = cfgP;
        R.session = createRaceSession(R, def, cfg);
        if (!R.session || typeof R.session.update !== 'function' || typeof R.session.snapshot !== 'function') throw new Error('engine.createSession returned an invalid session');
        pluginCall('attach', [R.session, R]);
        R.geom = R.session.geom || (CB.race.tracks.build ? CB.race.tracks.build(def) : null);
      },
      function () { // renderer + HUD
        var S2 = R.settings;
        createRaceRenderer(R, def, S2.graphics);
        if (R.challenge && typeof R.challenge.setRenderer === 'function') { try { R.challenge.setRenderer(R.renderer); } catch (e3) { /* ignore */ } }
        if (R.challenge && typeof R.challenge.setUnits === 'function') { try { R.challenge.setUnits(S2.units); } catch (e4) { /* ignore */ } }
        if (moduleStatus().hud) {
          try { var L2 = launchCfg(def);
            var hudO = { units: S2.units, mode: S2.mode, assists: S2.assists,
              playerName: (L2 && L2.playerName) || (U.opts && U.opts.playerName) || 'You' };
            var PLh = pluginOf();
            if (PLh && isPlain(PLh.hudOptions)) Object.assign(hudO, PLh.hudOptions);
            R.hud = CB.race.hud.create(U.canvas, R.geom, def, hudO); } catch (e2) { R.hud = null; if (typeof console !== 'undefined') console.warn('[race-ui] hud.create failed', e2); }
        }
        if (!R.hud || typeof R.hud.draw !== 'function') { R.hud = createFallbackHud(S2.units); R.fallbackHud = true; }
        if (R.isDrift) createDriftHud(R, def);
        R.ctx = U.canvas.getContext('2d');
        // The contract HUD draws its own start lights + penalty/finish banners; only fall back to DOM overlays
        // when it is missing or explicitly opts out (drawsCountdown === false).
        R.hudDrawsCountdown = !R.fallbackHud && R.hud.drawsCountdown !== false && !(CB.race.hud && CB.race.hud.drawsCountdown === false);
        R.hudDrawsBanners = !R.fallbackHud && R.hud.drawsBanners !== false;
      },
      function () { // input + first frame
        R.input = createInput({ settings: R.settings, onAction: onRaceAction });
        R.input.leftSign = probeLeftSign(U.build, U.metricsInfo.estimated ? null : U.metricsInfo.m);
        var snap = R.session.snapshot();
        R.lastSnap = snap;
        R.tracker.update(snap);
        populateGrid(snap);
        R.running = true; R.last = 0;
        R.raf = requestAnimationFrame(frame);
      }
    ];
    function run() {
      if (!U || U.race !== R) return;
      if (stepIdx >= tasks.length) {
        R.ready = true;
        U.loadingRefs.bar.style.width = '100%';
        U.loadingRefs.go.disabled = false;
        if (R.immediate) { goRace(); return; }
        try { U.loadingRefs.go.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        return;
      }
      mark(stepIdx, 'is-active');
      var exec = function () {
        if (!U || U.race !== R) return;
        try { tasks[stepIdx](); } catch (e) { fail(e, ['grid', 'session', 'renderer', 'input'][stepIdx]); return; }
        mark(stepIdx, 'is-done');
        stepIdx++;
        run();
      };
      if (R.immediate) exec(); else laterStep(exec, 40);
    }
    run();
  }

  /* ------------------------------------------------------------ sessions */
  /** Engine cfg without hooks (drift sessions concatenate cfg.hooks after their own assist / scorer hooks). */
  function engineCfgOf(cfg) {
    var o = {};
    for (var k in cfg) if (has(cfg, k) && k !== 'hooks') o[k] = cfg[k];
    return o;
  }
  /**
   * Create the session for a run:
   *  - DRIFT: CB.race.drift.createSession (free / trial / tandem) with the drift tune, scorer and CB.race.assist in 'drift' mode;
   *  - RACE with a steering assist: CB.race.drift.createSession({mode:'race'}) wrapping the normal engine race (career extras,
   *    endurance, challenge hooks and AI field all pass through engineCfg / hooks) with CB.race.assist in 'race' mode;
   *  - otherwise (assist off, or drift modules missing): the plain CB.race.engine session. When only assist.js is present its
   *    engine hook filters the player input; with nothing loaded the engine's built-in steering smoothing is used.
   * Assisted sessions take the raw key intent (R.rawInput) so CB.race.assist sees the digital arrows, not pre-smoothed steer.
   */
  function createRaceSession(R, def, cfg) {
    var ns = netSessionFor(R);
    if (ns) return ns;
    if (R.isArcade && !R.arcInner && arcadeMod()) {
      // stunt tracks: CB.arcade.stunt.createSession; circuits: this same factory (assist wrapper + engine) with handling 'arcade'
      return arcadeMod().createSession(cfg, { createCircuit: function (c) {
        R.arcInner = true;
        try { return createRaceSession(R, def, c); } finally { R.arcInner = false; }
      } });
    }
    var S2 = R.settings, D = driftMod(), lvl = R.isArcade ? 'off' : S2.steerAssist;   // arcade: never the race / drift assist layer
    var hooks = cfg.hooks;
    R.rawInput = false; R.assistVia = 'none';
    if (R.isDrift && D) {
      var ec = engineCfgOf(cfg);
      ['mode', 'laps', 'opponents', 'opponentCount', 'startPosition', 'gridOrder', 'field', 'rubberBanding', 'career'].forEach(function (k) { delete ec[k]; });
      ec.assists = { abs: true, tc: false, autoShift: S2.assists.autoShift !== false, racingLine: !!S2.assists.racingLine, steeringAssist: false };
      try {
        var ds = D.createSession({
          trackId: def.id, track: def, mode: S2.driftMode, build: U.build, assist: lvl, tune: S2.driftTune,
          timeOfDay: S2.timeOfDay, weather: S2.weather,
          duration_s: R.testCfg && isNum(R.testCfg.duration_s) ? R.testCfg.duration_s : S2.driftMode === 'free' ? 0 : S2.driftDuration,
          seed: R.testCfg && R.testCfg.seed != null ? R.testCfg.seed : cfg.seed, difficulty: S2.difficulty, playerName: cfg.playerName, engineCfg: ec, hooks: hooks,
          startDelay_s: R.testCfg && isNum(R.testCfg.startDelay_s) ? R.testCfg.startDelay_s : undefined
        });
        R.rawInput = true; R.assistVia = 'drift';
        return ds;
      } catch (eD) {
        if (typeof console !== 'undefined') console.warn('[race-ui] drift session failed, running a practice session', eD);
        R.isDrift = false;
        cfg.mode = R.settings.mode = 'practice'; cfg.laps = 50;
      }
    }
    if (lvl !== 'off' && D) {
      var ec2 = engineCfgOf(cfg);
      ec2.assists = Object.assign({}, cfg.assists || {}, { steeringAssist: false });
      ec2.startPosition = cfg.startPosition !== undefined ? cfg.startPosition : 'middle';   // the drift wrapper defaults to the back of the grid
      ec2.persistGhost = cfg.persistGhost !== undefined ? cfg.persistGhost : true;
      if (ec2.opponents === undefined) ec2.opponents = [];
      try {
        var rs = D.createSession({
          mode: 'race', trackId: def.id, track: def, build: U.build, assist: lvl, timeOfDay: cfg.timeOfDay, weather: cfg.weather,
          seed: cfg.seed, difficulty: cfg.difficulty, laps: cfg.laps, opponents: cfg.opponents, playerName: cfg.playerName,
          racingLine: !!(cfg.assists && cfg.assists.racingLine), engineCfg: ec2, hooks: hooks
        });
        R.rawInput = true; R.assistVia = 'drift';
        return rs;
      } catch (eR) { if (typeof console !== 'undefined') console.warn('[race-ui] assisted session failed, using the plain engine', eR); }
    }
    cfg.assists = Object.assign({}, cfg.assists || {}, { steeringAssist: lvl !== 'off' });
    var A = CB.race && CB.race.assist;
    if (lvl !== 'off' && A && typeof A.create === 'function') {
      try {
        var ast = A.create({ level: lvl, mode: 'race' });
        R.assistObj = ast;
        var hk = typeof ast.engineHook === 'function' ? ast.engineHook(function () { return R.input ? R.input.lastIntent : null; }) : null;
        if (hk && typeof hk.preStep === 'function') {
          // only preStep: a vehicleParams hook would stop the engine from attaching the endurance hooks automatically
          cfg.hooks = [].concat(hooks || [], [{ preStep: function (car, inp, dt) {
            var c = car && car.ctx, ph = c && c.phase;
            if (ph === 'grid' || ph === 'countdown' || ph === 'finished') return inp;   // never override the grid hold / jump-start logic
            if (c && car.frozenUntil > c.t) return inp;
            return hk.preStep(car, inp, dt);
          } }]);
          cfg.assists.steeringAssist = false;
          R.assistVia = 'hook';
        }
      } catch (eA) { /* fall back to the engine smoothing */ }
    }
    return CB.race.engine.createSession(cfg);
  }

  /* ------------------------------------------------------------ drift camera + sfx */
  /** Drift chase camera (CB.race.drift.camera): follows the travel direction so slides read sideways in frame.
      It only acts in the chase / chase-far modes; other cameras keep the renderer's built-in behaviour. */
  function attachDriftCamera(R) {
    R.dcam = null;
    var DC = CB.race && CB.race.drift && CB.race.drift.camera;
    if (!R.isDrift || !R.is3d || !DC || typeof DC.create !== 'function' || !R.renderer || typeof R.renderer.setCameraController !== 'function') return;
    try { R.dcam = DC.create(); R.renderer.setCameraController(R.dcam.controller); }
    catch (e) { R.dcam = null; if (typeof console !== 'undefined') console.warn('[race-ui] drift camera', e); }
  }
  /** Drift scorer popup sounds (CB.race.drift.sfx); must be started from a user gesture. */
  function createDriftSfx(R) {
    R.dsfx = null;
    var DS = CB.race && CB.race.drift && CB.race.drift.sfx;
    if (!R.isDrift || !DS || typeof DS.create !== 'function') return;
    try {
      R.dsfx = DS.create();
      if (R.dsfx && typeof R.dsfx.start === 'function') R.dsfx.start();
      if (R.dsfx && typeof R.dsfx.setMuted === 'function') R.dsfx.setMuted(true);   // unmuted with the race audio in goRace
    } catch (e) { R.dsfx = null; }
  }

  /* ------------------------------------------------------------ drift HUD */
  function createDriftHud(R, def) {
    var DH = CB.race && CB.race.drift && CB.race.drift.hud, S2 = R.settings;
    R.dhud = null;
    if (!DH || typeof DH.create !== 'function') return;
    try {
      var sc = typeof R.session.scorerState === 'function' ? R.session.scorerState() : null;
      R.dhud = DH.create(U.canvas, {
        units: S2.units, mode: S2.driftMode, tandem: S2.driftMode === 'tandem',
        duration_s: (R.session.driftConfig && R.session.driftConfig.duration_s) || (S2.driftMode === 'free' ? undefined : S2.driftDuration),
        geom: R.geom, trackDef: def, leadId: 'lead', targets: (sc && sc.targets) || undefined
      });
      attachDriftHudRenderer(R);
    } catch (e) { R.dhud = null; if (typeof console !== 'undefined') console.warn('[race-ui] drift hud', e); }
  }
  /** 3D-anchored zone markers: R.dhud.attachRenderer(R.renderer) (projector + camera source), else a bare projector;
      2D / fallback renderers: no projector (the HUD draws its screen-space markers). Re-run after a renderer switch. */
  function attachDriftHudRenderer(R) {
    if (!R || !R.dhud) return;
    try {
      if (R.is3d && R.renderer && R.renderer.is3D && typeof R.dhud.attachRenderer === 'function') { R.dhud.attachRenderer(R.renderer); return; }
      if (typeof R.dhud.setProjector !== 'function') return;
      if (R.is3d && R.renderer && typeof R.renderer.worldToScreen === 'function') {
        var rr = R.renderer;
        R.dhud.setProjector(function (x, y, z) { try { return rr.worldToScreen(x, y, z); } catch (e) { return null; } });
      } else R.dhud.setProjector(null);
    } catch (e) { if (typeof console !== 'undefined') console.warn('[race-ui] drift hud projector', e); }
  }
  /** Drift-run cosmetics (ported from drift.html): thick rear smoke + squeal scaled by the slip, and a wall kiss shakes
      the drift chase camera. Mutates the frame's snapshot car only (render-side; the sim never reads it back). */
  function driftCosmetics(R, snap, me) {
    var fx = snap && snap.drift && snap.drift.fx;
    if (fx && me && fx.drifting) {
      var sl = clamp(+fx.slip || 0, 0, 1);
      if (sl > 0.05) {
        me.skidding = Math.max(+me.skidding || 0, 0.45 + 0.55 * sl);
        me.wheelspin = Math.max(+me.wheelspin || 0, 0.3 + 0.7 * sl);
      }
    }
    if (R.dcam && typeof R.dcam.kick === 'function') {
      (snap.events || []).forEach(function (e) {
        if (e && (e.type === 'wall' || e.type === 'collision') && e.carId === 'player') { try { R.dcam.kick(0.25 + 0.6 * Math.min(1, +e.intensity || 0)); } catch (eK) { /* ignore */ } }
      });
    }
  }
  function fmtPts(n) { return isNum(n) ? Math.round(n).toLocaleString('en-US') : '0'; }
  /** Drift sessions run on an engine practice session, but the drift HUD owns the top of the screen: the regular HUD
      keeps its minimap, speed cluster, pedals and (tandem) tower, labelled with the drift mode, while its lap-timing
      block (top-right: PRACTICE · LAP · DELTA · S1-S3 · LAST/BEST) is clipped away. Geometry mirrors js/race/hud.js. */
  function drawHudForDrift(R, ctx, snap, W, H) {
    if (!R.hud || typeof R.hud.draw !== 'function') return;
    var hs = R._hudSnap;
    if (!hs || R._hudSnapSrc !== snap) {
      hs = {};
      for (var key in snap) if (has(snap, key)) hs[key] = snap[key];
      hs.mode = R.settings && R.settings.driftMode === 'tandem' ? 'tandem' : R.settings && R.settings.driftMode === 'free' ? 'free' : 'trial';
      R._hudSnap = hs; R._hudSnapSrc = snap;
    }
    if (R.fallbackHud) { R.hud.draw(ctx, hs); return; }
    var compact = W < 760 || H < 480;
    var k = compact ? clamp(Math.min(W / 420, H / 420), 0.62, 1.05) : clamp(Math.min(W / 1366, H / 800) * 1.06, 0.72, 1.6);
    var M = Math.round((compact ? 8 : 18) * k);
    var tw = (compact ? 178 : 268) * k;
    var th = ((compact ? 150 : 198) + ((snap.cars || []).length > 1 ? 48 : 0)) * k;
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.rect(W, 0, -(tw + M + 4), M + th + 4 * k);   // opposite winding -> hole (nonzero rule)
      ctx.clip();
      R.hud.draw(ctx, hs);
    } finally { ctx.restore(); }
  }
  /** Drift HUD (or a compact fallback) + the start countdown / GO / TIME callouts. ctx is in CSS-pixel transform. */
  /* ------------------------------------------------------------ arcade layer (ARCADE-SPEC §3) */
  /** World (sim x, y, height z) -> HUD canvas CSS px via the 3D camera (or a renderer's own toScreen). */
  function arcadeProjector(R, cw, ch) {
    var r = R.renderer;
    if (r && typeof r.toScreen === 'function') return function (x, y, z) { try { return r.toScreen(x, y, z || 0); } catch (e) { return { x: 0, y: 0, visible: false, scale: 0 }; } };
    var C = null;
    try { C = r && typeof r.getCameraState === 'function' ? r.getCameraState() : null; } catch (e0) { C = null; }
    if (!C || !C.eye || !C.target) return function () { return { x: 0, y: 0, visible: false, scale: 0 }; };
    var e = C.eye, t = C.target, up = C.up || [0, 1, 0];
    var fx = t[0] - e[0], fy = t[1] - e[1], fz = t[2] - e[2], fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    var rx = fy * up[2] - fz * up[1], ry = fz * up[0] - fx * up[2], rz = fx * up[1] - fy * up[0], rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    var ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
    var f = 1 / Math.tan((isNum(C.fov) ? C.fov : 60) * Math.PI / 360), asp = cw / Math.max(1, ch), near = isNum(C.near) ? C.near : 0.1;
    return function (x, y, z) {
      var dx = x - e[0], dy = (z || 0) - e[1], dz = -y - e[2];
      var cz = dx * fx + dy * fy + dz * fz;
      if (cz <= near) return { x: 0, y: 0, visible: false, scale: 0 };
      var sx = (dx * rx + dy * ry + dz * rz) * f / asp / cz, sy = (dx * ux + dy * uy + dz * uz) * f / cz;
      return { x: (sx * 0.5 + 0.5) * cw, y: (0.5 - sy * 0.5) * ch, visible: Math.abs(sx) < 1.2 && Math.abs(sy) < 1.2, scale: f * ch * 0.5 / cz, depth: cz };
    };
  }
  /** Hand the extensions' world entities to the renderer (renderer.setEntities) once per frame. */
  function arcadeEntities(R, snap) {
    var A = R.session && R.session.arcade;
    R.arcEnts = null;
    if (!A || typeof A.entities !== 'function') return;
    var list = A.entities(snap) || [];
    R.arcEnts = list;
    if (R.renderer && typeof R.renderer.setEntities === 'function') { try { R.renderer.setEntities(list); R.arcEntsDrawn = true; } catch (e) { R.arcEntsDrawn = false; } }
    else R.arcEntsDrawn = false;
  }
  /** ARCADE badge + extension HUD widgets (+ simple markers for entities the renderer cannot draw). */
  function drawArcadeLayer(R, ctx, snap, cw, ch) {
    var A = R.session && R.session.arcade, proj = null;
    var view = { width: cw, height: ch, units: R.settings.units, renderer: R.renderer, playerId: 'player',
      project: function (x, y, z) { if (!proj) proj = arcadeProjector(R, cw, ch); return proj(x, y, z); } };
    if (R.arcEnts && R.arcEnts.length && !R.arcEntsDrawn) {
      for (var i = 0; i < R.arcEnts.length && i < 80; i++) {
        var en = R.arcEnts[i]; if (!en || !isNum(en.x) || !isNum(en.y)) continue;
        var p = view.project(en.x, en.y, isNum(en.z) ? en.z : 0.6);
        if (!p.visible || p.scale < 2) continue;
        var rr = clamp((isNum(en.radius) ? en.radius : 0.9) * p.scale, 3, 60);
        ctx.fillStyle = en.color || '#ffcf3a'; ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.fill();
        if (en.glyph && rr > 7) { ctx.globalAlpha = 1; ctx.fillStyle = '#10131a'; ctx.font = '800 ' + Math.round(rr) + 'px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(en.glyph), p.x, p.y + 1); }
        ctx.globalAlpha = 1;
      }
    }
    if (A && typeof A.drawHud === 'function') { ctx.save(); try { A.drawHud(ctx, snap, view); } finally { ctx.restore(); } }
    // ARCADE badge (top centre)
    ctx.save();
    ctx.font = '800 11px system-ui,sans-serif';
    var label = 'ARCADE', w = ctx.measureText(label).width + 22, x = cw / 2 - w / 2, y = 8, hh = 20;
    ctx.fillStyle = '#ffcf3a';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, hh, 10); else ctx.rect(x, y, w, hh);
    ctx.fill();
    ctx.fillStyle = '#1a1300'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
    ctx.fillText(label, cw / 2 + 1, y + hh / 2 + 0.5);
    ctx.restore();
  }

  function drawDriftLayer(R, ctx, snap, cw, ch) {
    var d = snap.drift || {}, st = d.scorer;
    if (R.dcam && typeof R.dcam.setFx === 'function' && d.fx) { try { R.dcam.setFx(d.fx); } catch (eC) { /* ignore */ } }
    if (R.dsfx && st && !R.paused && typeof R.dsfx.update === 'function') { try { R.dsfx.update(st); } catch (eS) { R.dsfx = null; } }
    if (R.dhud) {
      try { R.dhud.draw(ctx, snap, st, d.assist); }
      catch (e) { if (typeof console !== 'undefined') console.warn('[race-ui] drift hud draw', e); R.dhud = null; }
    } else if (st) {
      var cx = cw / 2;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(9,10,14,.74)'; ctx.fillRect(cx - 160, 14, 320, 74);
      ctx.fillStyle = '#ff5a1f'; ctx.fillRect(cx - 160, 14, 320, 3);
      ctx.fillStyle = '#f1ede4'; ctx.font = '800 italic 40px Inter,system-ui,sans-serif';
      ctx.fillText(fmtPts(st.total), cx, 56);
      ctx.font = '600 12px ui-monospace,Menlo,monospace'; ctx.fillStyle = '#9a968d';
      ctx.fillText('×' + (+st.multiplier || 1).toFixed(1) + '  ·  ' + Math.round(st.angle_deg || 0) + '°' + (d.timeLeft_s != null ? '  ·  ' + d.timeLeft_s.toFixed(1) + ' s' : ''), cx, 78);
      if (st.current > 0) { ctx.fillStyle = '#ff7a3d'; ctx.font = '800 italic 30px Inter,system-ui,sans-serif'; ctx.fillText('+' + fmtPts(st.current) + (st.grade ? '  ' + st.grade : ''), cx, 128); }
      if (st.lastEvent && st.lastEvent.text) { ctx.fillStyle = '#f1ede4'; ctx.font = '700 17px Inter,system-ui,sans-serif'; ctx.fillText(st.lastEvent.text, cx, 156); }
      ctx.restore();
    }
    // countdown / GO / TIME callouts (the engine practice session has no start lights)
    var text = null, col = '#fff', t = snap.t || 0;
    if (d.countdown_s > 0) { text = String(Math.ceil(d.countdown_s)); R.driftGoAt = t; }
    else if (R.driftGoAt != null && t - R.driftGoAt < 0.9) { text = 'GO'; col = '#3ddc84'; }
    else if (d.finished) { text = d.mode === 'tandem' ? 'BATTLE OVER' : 'TIME'; col = '#ffb020'; }
    if (text) {
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var size = Math.min(150, Math.max(64, ch * 0.16));
      ctx.font = '900 italic ' + size + 'px Inter,system-ui,sans-serif';
      ctx.lineWidth = Math.max(4, size * 0.06); ctx.strokeStyle = 'rgba(0,0,0,.65)';
      ctx.strokeText(text, cw / 2, ch * 0.42);
      ctx.fillStyle = col; ctx.fillText(text, cw / 2, ch * 0.42);
      ctx.restore();
    }
  }

  /* ----------------------------------------------------------- renderers */
  /** True when the WebGL renderer is loaded and the browser can run it (cached by renderer3d). */
  function can3d() {
    if (!moduleStatus().renderer3d) return false;
    try { return CB.race.renderer3d.isSupported ? !!CB.race.renderer3d.isSupported() : true; } catch (e) { return false; }
  }
  /** Camera list for the active renderer. */
  function camList(R) { return R && R.is3d ? CAMERAS_3D : CAMERAS; }
  /** The 3D first-person cockpit camera is live (and not looking back): its dash already shows rpm / speed / gear. */
  function isCockpitView(R) {
    if (!R || !R.is3d || R.lookBack) return false;
    var cam = camList(R)[R.cameraIdx];
    return !!(cam && cam.id === 'cockpit');
  }
  function camIndexFor(R) {
    var list = camList(R), want = R.is3d ? R.settings[cam3dKey(R.settings)] : R.settings.camera;
    return Math.max(0, ids(list).indexOf(want));
  }
  /**
   * (Re)create the world renderer for a race: the WebGL renderer when graphics = '3d' and supported, else the
   * Canvas 2D top-down renderer, else a minimal built-in fallback. Safe to call mid-race (pause menu switch).
   */
  function createRaceRenderer(R, def, graphics) {
    var S2 = R.settings;
    if (R.renderer && typeof R.renderer.destroy === 'function') { try { R.renderer.destroy(); } catch (e0) { /* ignore */ } }
    R.renderer = null; R.is3d = false; R.fallbackRenderer = false;
    try { var c2 = U.canvas.getContext('2d'); c2.setTransform(1, 0, 0, 1, 0, 0); c2.clearRect(0, 0, U.canvas.width, U.canvas.height); } catch (eC) { /* ignore */ }
    U.canvas.style.background = ''; U.canvas.style.backgroundColor = '';
    var mods = moduleStatus();
    if (R.isArcade) {   // stunt tracks bring their own renderer (ARCADE-SPEC §4)
      var ST = CB.arcade && CB.arcade.stunt, ses = R.session;
      var mk = ses && typeof ses.createRenderer === 'function' ? function (c, o) { return ses.createRenderer(c, ses, o); }
        : isStuntDef(def) && ST && typeof ST.createRenderer === 'function' ? function (c, o) { return ST.createRenderer(c, ses, o); } : null;
      if (mk) {
        try {
          R.renderer = mk(U.canvas, { timeOfDay: S2.timeOfDay, weather: S2.weather, quality: S2.quality, camera: S2[cam3dKey(S2)], units: S2.units, graphics: graphics });
          if (!R.renderer || typeof R.renderer.render !== 'function') R.renderer = null;
          else R.is3d = !!R.renderer.is3D;
        } catch (eS) { R.renderer = null; if (typeof console !== 'undefined') console.warn('[race-ui] stunt renderer failed', eS); }
      }
    }
    if (!R.renderer && graphics === '3d' && can3d()) {
      try {
        // 'auto': start at the device's tier (CB.device: desktop 'high' as before, phones 'low'/'medium')
        var Dv = CB.device, autoQ = S2.quality === 'auto';
        var q = autoQ ? (Dv && typeof Dv.autoTier === 'function' ? Dv.autoTier() : 'high') : S2.quality;
        R.renderer = CB.race.renderer3d.create(U.canvas, R.geom, def, {
          timeOfDay: S2.timeOfDay, weather: S2.weather, quality: q, camera: S2[cam3dKey(S2)],
          racingLine: S2.assists.racingLine, autoQuality: false, units: S2.units,
          // drift runs: the renderer places smoke / skids / sparks at the car's real road elevation (drift venues have
          // hills and a bridge; the effects module's auto-emit puts them at y = 0, under the road) — as drift.html did
          manualEffects: !!R.isDrift
        });
        R.is3d = true;
        // the first frames include shader compiles & uploads: arm the auto-quality governor only after warm-up
        R.aq = { frames: 0, t0: (typeof performance !== 'undefined' ? performance.now() : Date.now()), armed: !autoQ, auto: autoQ, start: q,
                 sg: autoQ && Dv && typeof Dv.createStartupGovernor === 'function' ? Dv.createStartupGovernor() : null, last: 0 };
      } catch (e3) {
        R.renderer = null; R.is3d = false;
        if (typeof console !== 'undefined') console.warn('[race-ui] 3D renderer failed, using 2D', e3);
        toast(icon('camera', 14), '3D unavailable — top-down view');
      }
    }
    if (!R.renderer && mods.renderer) {
      try {
        R.renderer = CB.race.renderer.create(U.canvas, R.geom, def, { timeOfDay: S2.timeOfDay, weather: S2.weather, camera: S2.camera, units: S2.units, racingLine: S2.assists.racingLine });
      } catch (e4) { R.renderer = null; if (typeof console !== 'undefined') console.warn('[race-ui] renderer.create failed', e4); }
    }
    if (!R.renderer || typeof R.renderer.render !== 'function') { R.renderer = createFallbackRenderer(U.canvas, R.geom, def); R.fallbackRenderer = true; }
    R.cameraIdx = camIndexFor(R);
    try {
      // the renderer may refuse the saved camera (no cockpit on stunt tracks / without an interior model): show the
      // camera it actually uses (pause menu, C cycling) without overwriting the saved preference
      var camGot = R.renderer.setCamera ? R.renderer.setCamera(camList(R)[R.cameraIdx].id) : null;
      var camGotIdx = typeof camGot === 'string' ? ids(camList(R)).indexOf(camGot) : -1;
      if (camGotIdx >= 0) R.cameraIdx = camGotIdx;
    } catch (e) { /* ignore */ }
    if (R.challenge && typeof R.challenge.setRenderer === 'function') { try { R.challenge.setRenderer(R.renderer); } catch (e5) { /* ignore */ } }
    pluginCall('setRenderer', [R.renderer, R]);
    attachDriftCamera(R);
    R.lookBack = false;
    if (R.isArcade && R.session && R.session.arcade && typeof R.session.arcade.setRenderer === 'function') { try { R.session.arcade.setRenderer(R.renderer); } catch (eA) { /* ignore */ } }
    return R.renderer;
  }
  /** 'Auto' graphics: remember the tier this device settled on (CB.device.learn) so the next race starts there. */
  function learnAutoQuality(R) {
    var A = R && R.aq;
    if (!A || !A.start || !R.is3d || !R.renderer || !R.renderer.getQuality || !CB.device || typeof CB.device.learn !== 'function') return;
    if (!A.auto || !(A.startup || A.armed)) return;   // too short a session to say anything
    try {
      var q = R.renderer.getQuality(), detected = CB.device.info().tier;
      CB.device.learn(q === 'ultra' ? 'high' : q, detected);
    } catch (e) { /* ignore */ }
  }
  /** Arms renderer3d's auto-quality after 120 frames and 2 s of wall time (see race3d.html). */
  function armAutoQuality(R, now) {
    var A = R.aq;
    if (!R.is3d || !A) return;
    // 'auto': the first seconds of rendering (countdown included) decide at once when a phone is far over budget
    if (A.sg) {
      var dtm = A.last ? now - A.last : 0; A.last = now;
      var sr = dtm > 0 && !R.paused ? A.sg.sample(dtm) : null;
      if (sr) {
        A.sg = null; A.startup = sr;
        if (sr.action === 'down') {
          try {
            var cq = R.renderer.getQuality ? R.renderer.getQuality() : A.start, to = CB.device.stepDown(cq, sr.steps);
            if (to !== cq && R.renderer.setQuality) { R.renderer.setQuality(to); A.frames = 0; A.t0 = now; }
          } catch (eS) { /* ignore */ }
        }
      }
    }
    if (A.armed) return;
    A.frames++;
    if (A.frames < 120 || now - A.t0 < 2000) return;
    A.armed = true;
    try { if (R.renderer.setAutoQuality) R.renderer.setAutoQuality(true); } catch (e) { /* ignore */ }
  }

  /** Run fn after a short cosmetic pause (lets the loading steps paint). In a background tab chained timers
   *  are throttled to one per second — or one per minute after a while — so there a MessageChannel hop
   *  (not throttled) is used instead and the session is ready when the player comes back. */
  var stepChannel = null, stepQueue = [];
  function postStep(fn) {
    if (!stepChannel) {
      stepChannel = new MessageChannel();
      stepChannel.port1.onmessage = function () { var f = stepQueue.shift(); if (f) f(); };
    }
    stepQueue.push(fn);
    stepChannel.port2.postMessage(0);
  }
  function laterStep(fn, ms) {
    var done = false, onVis = null;
    function go() {
      if (done) return;
      done = true;
      if (onVis) document.removeEventListener('visibilitychange', onVis);
      fn();
    }
    var canPost = typeof MessageChannel === 'function' && typeof document !== 'undefined';
    if (canPost && document.hidden) { postStep(go); return; }
    setTimeout(go, ms);
    // the tab may be hidden while the timer is pending (it would then fire up to a minute late)
    if (canPost) {
      onVis = function () { if (document.hidden) postStep(go); };
      document.addEventListener('visibilitychange', onVis);
    }
  }

  function showLoading(def) {
    setScreen('loading');
    clear(U.host);
    var S = U.race.settings, st = trackStats(def);
    var drifting = S.discipline === 'drift';
    var stepNames = drifting
      ? [S.driftMode === 'tandem' ? 'Briefing the lead driver' : 'Rolling out to the line', 'Mapping drift zones', 'Calibrating the judge', 'Warming tyres']
      : ['Assembling the grid', 'Surveying circuit & racing line', 'Rigging cameras & timing', 'Warming tyres'];
    var steps = stepNames.map(function (n) { return h('div', null, h('i'), h('span', { text: n })); });
    var bar = h('i');
    var go = h('button', { class: 'cb-btn rx-btn primary big', type: 'button', disabled: true, onclick: goRace }, icon('play', 16), S.discipline === 'drift' ? 'Start the run' : S.mode === 'race' ? 'Take the grid' : 'Go to track');
    var gridList = h('div', { class: 'rx-grid-list' });
    var mm = h('canvas', { style: { width: '100%', height: '120px' } });
    U.loadingRefs = { steps: steps, bar: bar, go: go, gridList: gridList };
    var nameParts = String(def.name || def.id).split(' ');
    var last = nameParts.length > 1 ? nameParts.pop() : '';
    var screen = h('div', { class: 'rx-loading' },
      h('div', { class: 'rx-load-left' },
        h('div', { class: 'rx-eyebrow accent mx-kicker', text: (def.country || 'Circuit') + ' · ' + sessionLabel(S) }),
        h('div', { class: 'rx-load-title rx-display' }, nameParts.join(' ') + (last ? ' ' : ''), last ? h('span', { text: last }) : null),
        h('div', { class: 'rx-summary' },
          h('span', { class: 'rx-chip', text: fmtLength(st.length_m, S.units) }),
          h('span', { class: 'rx-chip', text: st.corners + ' corners' }),
          h('span', { class: 'rx-chip', text: S.discipline === 'drift' ? (S.driftMode === 'free' ? 'Endless run' : S.driftDuration + ' s run') : S.mode === 'practice' ? 'Open session' : plural(S.laps, 'lap') }),
          h('span', { class: 'rx-chip' }, icon(pick(WEATHERS, S.weather).icon, 12), pick(WEATHERS, S.weather).name),
          h('span', { class: 'rx-chip' }, icon(pick(TIMES, S.timeOfDay).icon, 12), pick(TIMES, S.timeOfDay).name),
          drifting ? h('span', { class: 'rx-chip drift' }, icon('drift', 12), pick(DRIFT_MODES, S.driftMode).name) : null,
          drifting ? h('span', { class: 'rx-chip', text: pick(DRIFT_TUNES, S.driftTune).name + ' tune' }) : h('span', { class: 'rx-chip accent', text: pick(DIFFICULTIES, S.difficulty).name + ' AI' }),
          h('span', { class: 'rx-chip' }, icon('steer', 12), isArcadeS(S) ? 'Arcade handling' : pick(STEER_ASSISTS, S.steerAssist).name + ' assist')),
        h('div', { class: 'rx-loadbar' }, bar),
        h('div', { class: 'rx-progress' }, steps),
        h('div', { class: 'rx-go-row' }, go,
          h('button', { class: 'cb-btn rx-btn ghost', type: 'button', onclick: function () { teardownRace(); showSetup(); } }, icon('back', 14), 'Setup'),
          h('span', { class: 'rx-dim', style: { 'font-size': 'var(--fs-sm)' } }, kbd('Enter'), ' / ', kbd('A')))),
      h('div', { class: 'rx-panel rx-grid-panel' },
        h('div', { class: 'rx-section-title' }, h('h3', null, h('span', { class: 'rx-skew' }), drifting ? 'Drift brief' : S.mode === 'race' ? 'Starting grid' : 'Session'),
          h('span', { class: 'rx-eyebrow', text: (U.race.def && U.race.def.name) || '' })),
        mm,
        h('div', { class: 'rx-scroll', style: { flex: '1', 'min-height': '0', 'margin-top': '6px' } }, gridList)));
    U.host.appendChild(screen);
    requestAnimationFrame(function () { try { drawTrackMap(mm, def, { sectors: true, padding: 10, maxWidth: 6 }); } catch (e) { /* ignore */ } });
  }

  /** Drift loading panel: what the run is scored on, instead of a one-car starting grid. */
  function driftBrief(list, S, def) {
    var m = pick(DRIFT_MODES, S.driftMode);
    var zones = def && Array.isArray(def.driftZones) ? plural(def.driftZones.length, 'clipping zone') : 'Clipping zones generated from the corners';
    var row = function (label, value) {
      return h('div', { class: 'rx-grid-slot is-player' }, h('span', { class: 'rx-livery', style: { background: 'linear-gradient(180deg,var(--mode-drift),var(--warn))' } }),
        h('span', { class: 'rx-grid-who' }, h('b', { text: label }), h('small', { text: value })));
    };
    list.appendChild(row(m.name, m.desc));
    list.appendChild(row('Judging', zones + ' · angle, speed & line'));
    list.appendChild(row(S.driftMode === 'free' ? 'Endless run' : (S.driftDuration >= 120 ? (S.driftDuration / 60) + ' min' : S.driftDuration + ' s') + ' run',
      pick(DRIFT_TUNES, S.driftTune).name + ' tune · ' + pick(STEER_ASSISTS, S.steerAssist).name + ' assist'));
  }
  function populateGrid(snap) {
    if (!U || !U.loadingRefs) return;
    var list = U.loadingRefs.gridList;
    clear(list);
    var RS = U.race && U.race.settings;
    if (RS && RS.discipline === 'drift' && RS.driftMode !== 'tandem') { driftBrief(list, RS, U.race.def); return; }
    var cars = (snap.cars || []).slice().sort(function (a, b) { return (a.position || 99) - (b.position || 99); });
    cars.forEach(function (c, i) {
      var col = c.color || '#888', acc = c.accent || '#fff';
      var sub = carSubtitle(c);
      var slot = h('div', { class: 'rx-grid-slot' + (c.isPlayer ? ' is-player' : ''), style: { 'animation-delay': (i * 45) + 'ms' } },
        h('span', { class: 'rx-livery', style: { background: 'linear-gradient(180deg,' + col + ',' + acc + ')' } }),
        h('span', { class: 'rx-grid-pos', text: 'P' + (c.position || i + 1) }),
        h('span', { class: 'rx-carnum', style: { background: col, color: readableOn(col) }, text: c.number != null ? String(c.number) : '' }),
        h('span', { class: 'rx-grid-who' }, h('b', { text: c.isPlayer ? (c.name || 'You') + ' (you)' : (c.name || 'Driver') }), h('small', { text: sub })));
      list.appendChild(slot);
    });
    if (!cars.length) list.appendChild(h('div', { class: 'rx-dim', text: 'No cars reported by the session.' }));
  }

  function readableOn(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return '#fff';
    var n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111' : '#fff';
  }

  /* ======================================================================
     RACE screen
     ====================================================================== */
  function goRace() {
    var R = U && U.race;
    if (!R || !R.ready) return;
    setScreen('race');
    clear(U.host);
    U.loadingRefs = null;
    var S = R.settings;
    var lights = h('div', { class: 'rx-lights' + (R.hudDrawsCountdown ? ' is-hidden' : ''), 'aria-hidden': 'true' });
    for (var i = 0; i < 5; i++) lights.appendChild(h('div', { class: 'rx-light' }, h('i'), h('i')));
    var feed = h('div', { class: 'rx-feed', 'aria-live': 'polite' });
    var muteBtn = h('button', { class: 'cb-btn rx-btn icon', type: 'button', title: 'Mute (M)', html: svgIcon(S.muted ? 'mute' : 'sound', 16), onclick: function () { onRaceAction('mute'); } });
    var quick = h('div', { class: 'rx-quickbar' },
      h('button', { class: 'cb-btn rx-btn icon', type: 'button', title: 'Camera (C)', html: svgIcon('camera', 16), onclick: function () { onRaceAction('camera'); } }),
      muteBtn,
      h('button', { class: 'cb-btn rx-btn icon', type: 'button', title: 'Pause (P / Esc)', html: svgIcon('pause', 16), onclick: function () { onRaceAction('pause'); } }));
    var layer = h('div', { class: 'rx-race' }, lights, feed, quick, rotatePrompt());
    if (S.showHints) {
      var hints = R.isDrift ? h('div', { class: 'rx-hints', style: { bottom: 'auto', top: '138px' } },
        h('span', null, kbd('↑'), 'Hold to drift'), h('span', null, kbd('←'), kbd('→'), 'Pick side · angle'), h('span', null, kbd('↓'), 'Less angle'),
        h('span', null, kbd('Space'), 'Handbrake kick'), h('span', null, kbd('C'), 'Camera'), h('span', null, kbd('R'), 'Reset'), h('span', null, kbd('Esc'), 'Pause'))
      : h('div', { class: 'rx-hints' },
        h('span', null, kbd('W'), kbd('S'), 'Pedals'), h('span', null, kbd('A'), kbd('D'), 'Steer'), h('span', null, kbd('Space'), 'Handbrake'),
        S.assists.autoShift ? null : h('span', null, kbd('E'), kbd('Q'), 'Shift'),
        h('span', null, kbd('C'), 'Camera'), h('span', null, kbd('R'), 'Reset'), h('span', null, kbd('M'), 'Mute'), h('span', null, kbd('Esc'), 'Pause'));
      layer.appendChild(hints);
      R.hintsTimer = setTimeout(function () { hints.classList.add('is-hidden'); }, 7000);
    }
    if (R.fallbackRenderer || R.fallbackHud) {
      layer.appendChild(h('div', { class: 'rx-fallback-note', text: 'Fallback view — ' + [R.fallbackRenderer ? 'renderer.js' : null, R.fallbackHud ? 'hud.js' : null].filter(Boolean).join(' & ') + ' not loaded' }));
    }
    var netEl = null, netText = null;
    if (R.net) {
      netText = h('span', { text: 'Connecting…' });
      netEl = h('div', { class: 'rx-net', role: 'status', 'aria-live': 'off', title: 'Multiplayer: ping · drivers · sync' }, h('i'), netText);
      layer.appendChild(netEl);
    }
    U.host.appendChild(layer);
    R.dom = { layer: layer, lights: lights, feed: feed, muteBtn: muteBtn, finish: null, net: netEl, netText: netText };
    buildTouchControls(layer);
    R.simActive = true; R.paused = false; R.acc = 0;
    if (R.audio && R.audio.setMuted) { try { R.audio.setMuted(!!S.muted); } catch (e) { /* ignore */ } }
    if (R.dsfx && R.dsfx.setMuted) { try { R.dsfx.setMuted(!!S.muted); } catch (eS) { /* ignore */ } }
    try { U.root.focus({ preventScroll: true }); } catch (e2) { /* ignore */ }
  }

  function onRaceAction(a) {
    var R = U && U.race;
    if (!R) return;
    if (a === 'pause') { if (U.screen === 'race') { if (R.paused) resumeRace(); else if (R.simActive) pauseRace(); } else if (U.screen === 'loading' && R.ready) goRace(); return; }
    if (a === 'confirm') {
      if (U.screen === 'loading' && R.ready) goRace();
      else if (U.screen === 'race' && R.paused && U.pauseRefs) { var f = U.pauseRefs.buttons[U.pauseRefs.focus]; if (f) f.click(); }
      return;
    }
    if (a === 'menuUp' || a === 'menuDown') { if (R.paused) movePauseFocus(a === 'menuDown' ? 1 : -1); return; }
    if (U.screen !== 'race' || R.paused) return;
    if (a === 'camera') {
      var cl = camList(R), cam = null;
      // skip the cameras this renderer does not take (stunt tracks: no bumper / heli / map), so no C press is dead
      for (var ci = 0; ci < cl.length; ci++) {
        R.cameraIdx = (R.cameraIdx + 1) % cl.length;
        cam = cl[R.cameraIdx];
        var gotCam;
        try { if (R.renderer.setCamera) gotCam = R.renderer.setCamera(cam.id); else if (R.renderer.cycleCamera) R.renderer.cycleCamera(); } catch (e) { /* ignore */ }
        if (typeof gotCam !== 'string' || gotCam === cam.id) break;
      }
      if (R.is3d) { var ck = cam3dKey(R.settings); U.settings[ck] = R.settings[ck] = cam.id; }
      else U.settings.camera = R.settings.camera = cam.id;
      persist();
      toast(icon('camera', 14), 'Camera · ' + cam.name);
    } else if (a === 'mute') {
      setMuted(!R.settings.muted);
    } else if (a === 'reset') {
      if (R.net && R.netMode === 'race') return;   // no resets in a multiplayer race (fairness)
      try { if (typeof R.session.resetPlayerToTrack === 'function') { R.session.resetPlayerToTrack(); toast(icon('reset', 14), 'Car reset to track'); } } catch (e2) { /* ignore */ }
    }
  }

  function setMuted(m) {
    var R = U.race;
    U.settings.muted = m; if (R) R.settings.muted = m; persist();
    if (R && R.audio && R.audio.setMuted) { try { R.audio.setMuted(m || R.paused); } catch (e) { /* ignore */ } }
    if (R && R.dsfx && R.dsfx.setMuted) { try { R.dsfx.setMuted(m); } catch (eS) { /* ignore */ } }
    if (R && R.dom && R.dom.muteBtn) R.dom.muteBtn.innerHTML = svgIcon(m ? 'mute' : 'sound', 16);
    toast(icon(m ? 'mute' : 'sound', 14), m ? 'Sound off' : 'Sound on');
  }

  /* -------------------------------------------------------------- main loop */
  function frame(now) {
    if (!U || !U.race || !U.race.running) return;
    var R = U.race;
    R.raf = requestAnimationFrame(frame);
    var dt = R.last ? (now - R.last) / 1000 : 0;
    R.last = now;
    if (!(dt >= 0)) dt = 0;
    dt = Math.min(dt, MAX_FRAME_DT);
    try {
      if (R.input) R.input.pollGamepad(now);
      var stepped = 0;
      if (R.simActive && (!R.paused || R.net) && !R.ended) {   // net sessions never pause (the pause menu only overlays)
        R.acc += dt;
        while (R.acc >= STEP && stepped < MAX_SUBSTEPS) {
          var inp = R.input.sample(STEP, R.playerSpeed);
          // assisted sessions (CB.race.drift.createSession) take the raw key intent and run CB.race.assist themselves
          var useIn = R.net ? netInput(R, inp) : R.rawInput && R.input.lastIntent ? R.input.lastIntent : inp;
          if (R.forced) useIn = forcedInput(R, useIn);
          R.session.update(STEP, useIn);
          R.acc -= STEP; R.simTime += STEP; stepped++;
        }
        if (stepped >= MAX_SUBSTEPS) R.acc = 0; // spiral-of-death guard
      }
      var snap = R.session.snapshot();
      R.lastSnap = snap;
      var me = playerCar(snap);
      R.playerSpeed = me ? Math.abs(me.speed || 0) : 0;
      phoneFrame(R, snap, me);
      var alpha = (R.simActive && (!R.paused || R.net)) ? (R.net ? clamp(netCall(R.session, 'alpha', 0), 0, 1) : clamp(R.acc / STEP, 0, 1)) : 1;
      if (R.input && R.renderer.setLookBack) {
        var lb = !!R.input.held.lookBack && !R.paused;
        if (lb !== R.lookBack) { R.lookBack = lb; try { R.renderer.setLookBack(lb); } catch (eL) { /* ignore */ } }
      }
      if (R.isDrift) driftCosmetics(R, snap, me);
      if (R.isArcade) arcadeEntities(R, snap);
      R.renderer.render(snap, alpha);
      if (R.is3d) armAutoQuality(R, now);
      if (R.hud && R.ctx && U.screen !== 'loading') {
        var ctx = R.ctx, cw = U.canvas.clientWidth || 1;
        var dpr = U.canvas.width / cw;
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (typeof R.hud.setCockpit === 'function') R.hud.setCockpit(isCockpitView(R));
        if (typeof R.hud.setLayout === 'function') hudTouchLayout(R, now);
        try {
          if (R.isDrift) { drawHudForDrift(R, ctx, snap, cw, U.canvas.clientHeight || 1); drawDriftLayer(R, ctx, snap, cw, U.canvas.clientHeight || 1); }
          else R.hud.draw(ctx, snap);
          if (R.isArcade) drawArcadeLayer(R, ctx, snap, cw, U.canvas.clientHeight || 1);
          if (R.net) drawNetTags(R, ctx, snap, cw, U.canvas.clientHeight || 1);
          if (U.opts && U.opts.plugin) pluginCall('drawHud', [ctx, snap, { width: cw, height: U.canvas.clientHeight || 1, renderer: R.renderer, units: R.settings.units,
            paused: !!R.paused, screen: U.screen, cockpit: isCockpitView(R), project: arcadeProjector(R, cw, U.canvas.clientHeight || 1), R: R }]);
        } finally { ctx.restore(); }
        if (R.challenge) {
          ctx.save();
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          try {
            if (R.simActive && !R.ended) R.challengeEval = R.challenge.evaluate(snap) || R.challengeEval;
            if (typeof R.challenge.drawOverlay === 'function') R.challenge.drawOverlay(ctx, snap, { width: cw, height: U.canvas.clientHeight || 1 });
          } catch (eC) { if (!R.challengeWarned && typeof console !== 'undefined') { R.challengeWarned = true; console.warn('[race-ui] challenge overlay', eC); } }
          finally { ctx.restore(); }
          var ce = R.challengeEval;
          if (ce && (ce.done || ce.failed) && R.challengeDoneAt == null) R.challengeDoneAt = R.simTime;
        }
      }
      if (R.audio && R.audio.update && !R.paused) { try { R.audio.update(snap); } catch (e) { /* audio must never kill the race */ } }
      if (R.simActive) {
        handleEvents(snap);
        var laps = R.tracker.update(snap);
        laps.forEach(onLapCompleted);
        updateRaceDom(snap, me);
        if (R.net) updateNetDom(R, now);
        checkFinish(snap, me, stepped * STEP);
        if (R.challengeDoneAt != null && !R.ended && R.simTime - R.challengeDoneAt >= 2.2) endSession();
      }
      if (R.paused && U.pauseRefs && (now - (U.pauseRefs.lastRefresh || 0) > 500)) {
        U.pauseRefs.lastRefresh = now; refreshPauseStatus();
        if (R.net && U.netPauseBox) { clear(U.netPauseBox); U.netPauseBox.appendChild(netPauseStatus(R)); }
      }
    } catch (err) {
      R.running = false;
      cancelAnimationFrame(R.raf);
      if (typeof console !== 'undefined') console.error('[race-ui] frame error', err);
      showError('The race stopped because of an internal error.', (err && (err.stack || err.message)) || String(err));
    }
  }

  /** The player's row name in the grid / HUD / results: the profile's driver name (the car shows in the subtitle);
      the build name only when there is no profile (it used to read "Untitled Build (you)"). */
  function playerDriverName() {
    var P = CB.game && CB.game.profile, pr = null;
    try { pr = P && typeof P.get === 'function' ? P.get() : null; } catch (e) { pr = null; }
    var n = pr && typeof pr.driverName === 'string' ? pr.driverName.trim() : '';
    if (n) return n.slice(0, 24);
    var b = U && U.build && U.build.meta && U.build.meta.name;
    return b && b !== 'Untitled Build' ? b : 'You';
  }
  /** Results subtitle name: the build's own name, or its real model when it still has the default "Untitled Build" name (career cars). */
  function resultBuildName() {
    var n = U && U.build && U.build.meta && U.build.meta.name;
    if (!n || n === 'Untitled Build') n = realCarName({ build: U && U.build }) || n;
    return n || 'Your build';
  }
  /** Real manufacturer model name ("Honda Civic Type R") for a grid car / result row, or ''. */
  function realCarName(c) {
    if (!c) return '';
    if (c.carName) return String(c.carName);
    var b = c.build || (c.isPlayer && U && U.build) || null;
    if (!b && c.id != null && U && U.race && U.race.opponents && U.race.opponents.length) {
      for (var i = 0; i < U.race.opponents.length; i++) {
        var o = U.race.opponents[i];
        if (o && o.id === c.id) { if (o.carName) return String(o.carName); b = o.build || null; break; }
      }
    }
    if (b && b.f1 && (b.f1.chassis || b.f1.carName)) return String(b.f1.chassis || b.f1.carName);   // F1 cars (docs/F1-SPEC.md): the team's chassis
    if (!b || !b.body || !CB.shapes || typeof CB.shapes.getModel !== 'function') return '';
    try {
      var m = CB.shapes.getModel(b, { strict: true });
      return m ? ((m.make ? m.make + ' ' : '') + (m.name || m.id)) : '';
    } catch (e) { return ''; }
  }
  /** "Team · Car" subtitle; avoids "Team · Team #37" when an AI build is named after its team. */
  function carSubtitle(c) {
    if (!c) return '';
    var body = realCarName(c) || nameOf('bodyStyles', c.bodyStyle || (c.build && c.build.body && c.build.body.style));
    var name = (c.build && c.build.meta && c.build.meta.name) || '';
    if (name === 'Untitled Build' || name === 'Untitled build') name = '';
    var team = c.team ? String(c.team) : '';
    if (!name || (team && name.toLowerCase().indexOf(team.toLowerCase()) === 0)) name = body;
    return team ? (name ? team + ' · ' + name : team) : name;
  }
  function playerCar(snap) {
    if (!snap || !snap.cars) return null;
    for (var i = 0; i < snap.cars.length; i++) {
      var c = snap.cars[i];
      if (c.isPlayer || (snap.playerId != null && c.id === snap.playerId)) return c;
    }
    return null;
  }
  function carById(snap, id) {
    if (!snap || !snap.cars) return null;
    for (var i = 0; i < snap.cars.length; i++) if (snap.cars[i].id === id) return snap.cars[i];
    return null;
  }

  function handleEvents(snap) {
    var R = U.race, evs = snap.events;
    if (!Array.isArray(evs) || !evs.length) return;
    var me = playerCar(snap), myId = me ? me.id : snap.playerId;
    evs.forEach(function (ev) {
      if (!ev || !ev.type) return;
      var car = carById(snap, ev.carId), who = car ? (car.isPlayer ? 'You' : car.name || 'Car ' + ev.carId) : '';
      var mine = ev.carId === myId;
      switch (ev.type) {
        case 'penalty':
          if (mine && R.hudDrawsBanners) { /* HUD banner */ }
          else if (mine) feedPush('Penalty', ev.text || ('+' + (isNum(ev.value) ? ev.value : 5) + 's time penalty'), 'bad');
          else if (R.settings.mode === 'race' && car) feedPush('Race control', who + ' · +' + (isNum(ev.value) ? ev.value : 5) + 's penalty' + (ev.text ? ' (' + ev.text + ')' : ''), '');
          break;
        case 'jumpstart':
          if (mine && R.hudDrawsBanners) break;
          feedPush('Jump start', mine ? (ev.text || 'You jumped the start' + (isNum(ev.value) ? ' · +' + ev.value + 's' : '')) : who + ' jumped the start', 'bad');
          break;
        case 'fastestLap':
          feedPush('Fastest lap', who + ' · ' + fmtTime(isNum(ev.value) ? ev.value : (car && car.bestLap_s)), 'purple');
          break;
        case 'finish':
          if (mine) { /* banner handles player */ }
          else if (car && R.settings.mode === 'race' && (car.position === 1 || (isNum(ev.value) && ev.value === 1))) feedPush('Chequered flag', who + ' wins the race', 'good');
          break;
        case 'collision':
        case 'wall':
          if (mine && (R.simTime - R.events.lastCollision > 0.6) && (ev.intensity == null || ev.intensity > 0.12)) { R.events.collisions++; R.events.lastCollision = R.simTime; }
          break;
        /* game hooks (GAME-SPEC endurance / pit stops) */
        case 'pitRequest':
          if (mine) feedPush('Pit wall', ev.text || 'Box this lap', '');
          break;
        case 'pitCancel':
          if (mine) feedPush('Pit wall', ev.text || 'Stay out', '');
          break;
        case 'pitStop':
          if (mine) feedPush('Pit stop', isNum(ev.value) ? ev.value.toFixed(1) + ' s stationary' : (ev.text || 'Service complete'), 'good');
          else if (R.settings.mode === 'race' && car) feedPush('Pit lane', ev.text || (who + ' pits'), '');
          break;
        case 'endurance':
          if (mine && ev.text) feedPush(ev.kind === 'engine-failure' || ev.kind === 'puncture' ? 'Failure' : 'Car', ev.text, ev.kind === 'engine-failure' || ev.kind === 'puncture' ? 'bad' : '');
          break;
        default: break;
      }
    });
  }

  function onLapCompleted(lap) {
    var R = U.race;
    if (!lap.isPlayer) return;
    if (!lap.valid) return;
    if (R.isDrift) return;   // drift runs record scores (records.submitDrift), not lap times
    if (R.net && R.isArcade) return;   // arcade multiplayer laps never go into the arcade records (ARCADE-SPEC §6)
    var res = U.records.submit(R.def.id, U.hash, {
      time: lap.time, sectors: lap.sectors, buildName: (U.build.meta && U.build.meta.name) || 'Untitled Build',
      mode: R.settings.mode, weather: R.settings.weather, timeOfDay: R.settings.timeOfDay
    });
    if (res.trackRecord) {
      if (!R.recordFlags.trackRecord) R.recordFlags.prevTrack = res.prevTrack;
      R.recordFlags.trackRecord = true; R.recordFlags.lapTime = lap.time;
      feedPush('Your track best', fmtTime(lap.time) + (res.prevTrack ? ' · ' + fmtGap(lap.time - res.prevTrack.time) : ''), 'purple');
    } else if (res.buildBest) {
      feedPush('Personal best', fmtTime(lap.time) + (res.prevBuild ? ' · ' + fmtGap(lap.time - res.prevBuild.time) : ''), 'good');
    }
    if (res.buildBest) {
      if (!R.recordFlags.buildBest) R.recordFlags.prevBuild = res.prevBuild;
      R.recordFlags.buildBest = true; R.recordFlags.lapTime = lap.time;
    }
  }

  function feedPush(title, text, cls) {
    var R = U.race;
    if (!R || !R.dom) return;
    var item = h('div', { class: 'rx-feed-item ' + (cls || '') }, h('span', { class: 'rx-eyebrow', text: title }), h('span', { text: text }));
    R.dom.feed.insertBefore(item, R.dom.feed.firstChild);
    while (R.dom.feed.children.length > 4) R.dom.feed.removeChild(R.dom.feed.lastChild);
    setTimeout(function () { item.classList.add('is-out'); }, 4200);
    setTimeout(function () { if (item.parentNode) item.parentNode.removeChild(item); }, 4800);
  }

  function updateRaceDom(snap, me) {
    var R = U.race, d = R.dom;
    if (!d) return;
    // start lights
    if (!R.hudDrawsCountdown) {
      var cd = snap.countdown || {}, ph = snap.phase;
      var on = ph === 'grid' ? 0 : clamp(cd.lightsOn | 0, 0, 5);
      var state;
      if (ph === 'grid' || (ph === 'countdown' && !cd.lightsOut)) state = 'on' + on;
      else if (cd.lightsOut || ph === 'racing') state = 'out';
      else state = 'hidden';
      if (state !== R.lightsState) {
        R.lightsState = state;
        var lamps = d.lights.children;
        for (var i = 0; i < lamps.length; i++) lamps[i].classList.toggle('on', state.indexOf('on') === 0 && i < on);
        d.lights.classList.toggle('go', state === 'out');
        if (state === 'out' && !R.goShown) {
          R.goShown = true;
          d.layer.appendChild(h('div', { class: 'rx-go rx-display', text: 'GO' }));
          setTimeout(function () { if (d.lights) d.lights.classList.add('is-hidden'); }, 900);
        }
        if (state.indexOf('on') === 0) d.lights.classList.remove('is-hidden');
      }
    }
    // finish banner
    if (me && me.finished && !d.finish && R.settings.mode === 'race' && !R.hudDrawsBanners) {
      var total = (snap.cars || []).length;
      d.finish = h('div', { class: 'rx-finish' },
        h('div', { class: 'rx-finish-flag' }),
        h('div', { class: 'rx-finish-text rx-display', text: me.dnf ? 'DNF' : (me.position === 1 ? 'Victory' : ordinal(me.position || 0)) }),
        h('div', { class: 'rx-finish-sub rx-num', text: 'P' + me.position + ' of ' + total + (isNum(me.finishTime_s) ? ' · ' + fmtTime(me.finishTime_s) : '') + (me.penalties_s ? ' · +' + me.penalties_s + 's pen.' : '') }),
        h('div', { class: 'rx-finish-flag' }));
      d.layer.appendChild(d.finish);
    }
  }

  function checkFinish(snap, me, simDt) {
    var R = U.race;
    if (R.ended) return;
    if (R.net) {   // multiplayer: results wait for the host (final classification) or the end of the session
      if (!netFinished(snap, R.session)) return;
      R._finWall = (R._finWall || 0) + 1 / 60;
      if (R._finWall >= RESULTS_DELAY_AFTER_SESSION_FINISH || R.netEnded) endSession();
      return;
    }
    if (snap.phase === 'finished') {
      if (R.sessionFinishedAt == null) R.sessionFinishedAt = R.simTime;
      R.sessionFinishedAt -= 0; // keep
      if (R.simTime - R.sessionFinishedAt >= RESULTS_DELAY_AFTER_SESSION_FINISH || simDt === 0) {
        // phase finished: the engine may stop advancing; count wall time instead
        R._finWall = (R._finWall || 0) + 1 / 60;
        if (R._finWall >= RESULTS_DELAY_AFTER_SESSION_FINISH) endSession();
      }
      return;
    }
    if (me && (me.finished || me.dnf) && R.settings.mode !== 'practice') {
      if (R.playerFinishedAt == null) R.playerFinishedAt = R.simTime;
      if (R.simTime - R.playerFinishedAt >= (R.settings.mode === 'race' ? RESULTS_DELAY_AFTER_PLAYER_FINISH : 2.5)) endSession();
    }
  }

  /* ======================================================================
     PAUSE
     ====================================================================== */
  function pauseRace() {
    var R = U.race;
    if (!R || R.paused || R.ended) return;
    R.paused = true;
    R.input.clearHeld();
    if (R.audio && R.audio.setMuted) { try { R.audio.setMuted(true); } catch (e) { /* ignore */ } }
    var S = R.settings;
    var me = playerCar(R.lastSnap) || {};
    var buttons = [];
    function mb(label, ico, fn, cls) {
      var b = h('button', { class: 'cb-btn rx-btn ' + (cls || ''), type: 'button', onclick: fn }, icon(ico, 16), label);
      buttons.push(b);
      return b;
    }
    var status = h('div', { class: 'rx-pause-status' });
    var gfxRow = can3d() ? field('Graphics', segmented(GRAPHICS, R.is3d ? '3d' : '2d', function (v) {
      if ((v === '3d') === !!R.is3d) return;
      U.settings.graphics = S.graphics = v; persist();
      try { createRaceRenderer(R, R.def, v); } catch (eG) { if (typeof console !== 'undefined') console.warn('[race-ui] graphics switch', eG); }
      if (R.isDrift) attachDriftHudRenderer(R);
      // rebuild the pause card so the camera list matches the new renderer
      if (U.pauseRefs && U.pauseRefs.modal.parentNode) U.pauseRefs.modal.parentNode.removeChild(U.pauseRefs.modal);
      U.pauseRefs = null; R.paused = false;
      pauseRace();
    }), { desc: R.is3d ? 'WebGL 3D view' : 'Top-down 2D view' }) : null;
    var canSetAssist = !!(R.session && typeof R.session.setAssistLevel === 'function') || !!(R.assistObj && typeof R.assistObj.setLevel === 'function');
    var netMax = R.net && R.net.cfg ? (R.net.cfg.maxSteerAssist === 'auto' ? 'heavy' : R.net.cfg.maxSteerAssist) : null;
    var assistLevels = netMax && has(STEER_RANK, netMax) ? STEER_ASSISTS.filter(function (a) { return STEER_RANK[a.id] <= STEER_RANK[netMax]; }) : STEER_ASSISTS;
    var assistRow = R.isArcade ? null : field('Steering assist', segmented(assistLevels, S.steerAssist, function (v, o) {
      setAssist(U.settings, v); S.steerAssist = v; persist();
      try {
        if (R.net && !R.isDrift) {
          if (R.netAssist) R.netAssist.setLevel(v);
          else if (v !== 'off' && CB.race && CB.race.assist) { R.netAssist = R.assistObj = CB.race.assist.create({ level: v, mode: 'race' }); }
        } else if (R.session && typeof R.session.setAssistLevel === 'function') R.session.setAssistLevel(v);
        else if (R.assistObj && typeof R.assistObj.setLevel === 'function') R.assistObj.setLevel(v);
      } catch (eA) { /* ignore */ }
      if (assistRow && assistRow._desc) assistRow._desc.textContent = o.desc + (canSetAssist ? '' : ' · applies from the next session');
    }), { desc: pick(STEER_ASSISTS, S.steerAssist).desc + (canSetAssist ? '' : ' · applies from the next session'), headExtra: icon('steer', 14) });
    // drift runs: the handling tune can be changed here too (drift.html parity); it applies on a restart of the run
    var tuneRow = R.isDrift && R.session && typeof R.session.setTuneLevel === 'function'
      ? field('Drift tune (restarts the run)', segmented(DRIFT_TUNES, S.driftTune, function (v) {
          if (v === S.driftTune) return;
          U.settings.driftTune = S.driftTune = v; persist();
          try { R.session.setTuneLevel(v); } catch (eT) { /* ignore */ }
          restartRace();
        }), { desc: pick(DRIFT_TUNES, S.driftTune).desc })
      : null;
    var settingsBox = h('div', { class: 'rx-form', style: { padding: '0' } },
      gfxRow,
      assistRow,
      tuneRow,
      h('div', { class: 'rx-two' },
        field('Camera', segmented(camList(R), (camList(R)[R.cameraIdx] || camList(R)[0]).id, function (v) {
          R.cameraIdx = Math.max(0, ids(camList(R)).indexOf(v));
          try { if (R.renderer.setCamera) R.renderer.setCamera(v); } catch (e) { /* ignore */ }
          if (R.is3d) { var ck3 = cam3dKey(S); U.settings[ck3] = S[ck3] = v; } else U.settings.camera = S.camera = v;
          persist();
        })),
        field('Units', segmented(UNITS, S.units, function (v) {
          U.settings.units = S.units = v; persist(); setProfileUnits(v);
          try { if (R.hud && R.hud.setUnits) R.hud.setUnits(v); } catch (e) { /* ignore */ }
        }))),
      h('div', { class: 'rx-toggles' },
        toggleRow('Sound', 'Engine & effects', !S.muted, function (v) { U.settings.muted = S.muted = !v; persist(); if (R.dom && R.dom.muteBtn) R.dom.muteBtn.innerHTML = svgIcon(S.muted ? 'mute' : 'sound', 16); }),
        toggleRow('Racing line', 'Show driving line', S.assists.racingLine, function (v) {
          S.assists.racingLine = v; U.settings.assists.racingLine = v; persist();
          try {
            var cfg = R.session.config;
            if (cfg && cfg.assists) cfg.assists.racingLine = v;
            if (R.renderer && typeof R.renderer.setRacingLine === 'function') R.renderer.setRacingLine(v);
          } catch (e) { /* ignore */ }
        }),
        toggleRow('Invert steering', 'Flip left/right', S.invertSteer, function (v) { U.settings.invertSteer = S.invertSteer = v; persist(); }),
        toggleRow('Touch controls', 'On-screen pedals', touchWanted(), function (v) { U.settings.touchControls = S.touchControls = v ? 'on' : 'off'; persist(); updateTouchVisibility(); })),
      (function () {
        var f = field('Steering sensitivity', rangeInput(0.5, 1.6, 0.05, S.steerSensitivity, function (v) {
          U.settings.steerSensitivity = S.steerSensitivity = v; persist(); f._val.textContent = Math.round(v * 100) + '%';
        }), { value: Math.round(S.steerSensitivity * 100) + '%' });
        return f;
      })());
    var card = h('div', { class: 'rx-panel rx-pause', role: 'dialog', 'aria-label': 'Paused' },
      h('div', { class: 'rx-pause-menu' },
        h('div', { class: 'rx-eyebrow accent mx-kicker', text: (R.def.name || '') + ' · ' + (R.net ? 'Multiplayer · ' + (R.netMode === 'drift' ? 'Drift battle' : R.netMode === 'free' ? 'Free roam' : 'Race') : sessionLabel(S)) }),
        h('h2', { class: 'rx-display', text: R.net ? 'Menu' : 'Paused' }),
        R.net ? h('div', { class: 'rx-dim', style: { margin: '-4px 0 10px', 'font-size': 'var(--fs-sm)' }, text: 'Online session: the race keeps running while this menu is open.' }) : null,
        mb('Resume', 'play', resumeRace, 'primary'),
        phoneButtons(mb),
        R.net ? null : mb('Restart session', 'restart', restartRace),
        R.net && R.netMode === 'race' ? null : mb('Reset car to track', 'reset', function () { try { R.session.resetPlayerToTrack(); } catch (e) { /* ignore */ } resumeRace(); toast('Car reset to track'); }),
        R.net ? (netIsHost(R) && typeof R.session.end === 'function' ? mb('End session for everyone', 'flag', function () { try { R.session.end(); } catch (e) { /* ignore */ } resumeRace(); }) : null)
          : S.mode !== 'race' ? mb(R.isDrift ? 'End run · results' : 'End session · results', 'flag', function () { endSession(); }) : null,
        R.net ? mb(netIsHost(R) ? 'Leave · ends the session' : 'Leave race · lobby', 'back', netLeave, 'ghost') : mb('Change setup', 'settings', function () { teardownRace(); showSetup(); }),
        R.net ? null : isGameLaunch() ? mb(backLabel(), 'back', close) : mb('Tune car · Garage', 'wrench', goAtelier),
        !R.net && !isGameLaunch() && U.layer ? mb('Main menu', 'back', goMenu, 'ghost') : null),
      h('div', { class: 'rx-pause-side rx-scroll' },
        status,
        R.net ? (U.netPauseBox = h('div', null, netPauseStatus(R))) : null,
        h('div', { class: 'rx-section-title' }, h('h3', null, h('span', { class: 'rx-skew' }), 'Settings')),
        settingsBox,
        h('details', { class: 'rx-details' }, h('summary', null, icon('keyboard', 14), 'Controls'), keysReference())));
    var modal = h('div', { class: 'rx-modal' }, card);
    modal.addEventListener('click', function (e) { if (e.target === modal) resumeRace(); });
    U.host.appendChild(modal);
    U.pauseRefs = { modal: modal, status: status, buttons: buttons, focus: 0, lastRefresh: 0 };
    refreshPauseStatus();
    movePauseFocus(0);
    void me;
  }
  function movePauseFocus(d) {
    var P = U.pauseRefs;
    if (!P) return;
    P.focus = (P.focus + d + P.buttons.length) % P.buttons.length;
    P.buttons.forEach(function (b, i) { b.classList.toggle('is-focus', i === P.focus); });
    try { P.buttons[P.focus].focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  function refreshPauseStatus() {
    var R = U.race, P = U.pauseRefs;
    if (!R || !P) return;
    var snap = R.lastSnap || {}, me = playerCar(snap) || {};
    var total = (snap.cars || []).length;
    clear(P.status);
    if (R.isDrift) {
      var d = snap.drift || {}, sc = d.scorer || {};
      append(P.status, [
        h('div', { class: 'rx-tile accent' }, h('div', { class: 'rx-stat-l', text: 'Score' }), h('div', { class: 'rx-stat-v rx-num', text: fmtPts(sc.total) })),
        h('div', { class: 'rx-tile' }, h('div', { class: 'rx-stat-l', text: 'Combo' }), h('div', { class: 'rx-stat-v rx-num', text: '×' + (+(sc.multiplier || 1)).toFixed(1) })),
        h('div', { class: 'rx-tile purple' }, h('div', { class: 'rx-stat-l', text: d.timeLeft_s != null ? 'Time left' : 'Run time' }),
          h('div', { class: 'rx-stat-v rx-num', text: d.timeLeft_s != null ? d.timeLeft_s.toFixed(1) + ' s' : fmtTime(d.elapsed_s, '—') })),
        h('div', { class: 'rx-tile' }, h('div', { class: 'rx-stat-l', text: 'Assist' }), h('div', { class: 'rx-stat-v', text: pick(STEER_ASSISTS, d.assistLevel || R.settings.steerAssist).name }))
      ]);
      return;
    }
    var lapsTotal = snap.lapsTotal || R.settings.laps;
    append(P.status, [
      h('div', { class: 'rx-tile accent' }, h('div', { class: 'rx-stat-l', text: 'Position' }), h('div', { class: 'rx-stat-v rx-num', text: me.position ? 'P' + me.position + '/' + total : '—' })),
      h('div', { class: 'rx-tile' }, h('div', { class: 'rx-stat-l', text: 'Lap' }), h('div', { class: 'rx-stat-v rx-num', text: R.settings.mode === 'practice' ? String((me.lap || 0) + 1) : Math.min((me.lap || 0) + 1, lapsTotal) + '/' + lapsTotal })),
      h('div', { class: 'rx-tile purple' }, h('div', { class: 'rx-stat-l', text: 'Best lap' }), h('div', { class: 'rx-stat-v rx-num', text: fmtTime(me.bestLap_s, '—') })),
      h('div', { class: 'rx-tile' }, h('div', { class: 'rx-stat-l', text: 'Last lap' }), h('div', { class: 'rx-stat-v rx-num', text: fmtTime(me.lastLap_s, '—') }))
    ]);
  }
  function resumeRace() {
    var R = U && U.race;
    if (!R || !R.paused) return;
    R.paused = false;
    R.acc = 0; R.last = 0;
    if (U.pauseRefs && U.pauseRefs.modal.parentNode) U.pauseRefs.modal.parentNode.removeChild(U.pauseRefs.modal);
    U.pauseRefs = null;
    if (R.audio && R.audio.setMuted) { try { R.audio.setMuted(!!R.settings.muted); } catch (e) { /* ignore */ } }
    try { U.root.focus({ preventScroll: true }); } catch (e2) { /* ignore */ }
  }
  function restartRace() {
    var R = U.race;
    if (!R || R.net) return;   // a net session cannot be restarted (rematch = a new session from the lobby)
    try {
      if (typeof R.session.restart === 'function') R.session.restart();
      else { startRace(); return; }
    } catch (e) { showError('Restart failed.', e && (e.stack || e.message)); return; }
    if (R.renderer && typeof R.renderer.reset === 'function') { try { R.renderer.reset(); } catch (e2) { /* ignore */ } }
    R.tracker.reset(); R.input.reset();
    if (R.dhud && typeof R.dhud.reset === 'function') { try { R.dhud.reset(); } catch (eD) { /* ignore */ } }
    if (R.dcam && typeof R.dcam.reset === 'function') { try { R.dcam.reset(); } catch (eDc) { /* ignore */ } }
    if (R.dsfx && typeof R.dsfx.reset === 'function') { try { R.dsfx.reset(); } catch (eDs) { /* ignore */ } }
    R.driftGoAt = null;
    R.playerFinishedAt = null; R.sessionFinishedAt = null; R._finWall = 0; R.ended = false;
    R.lightsState = ''; R.goShown = false; R.simTime = 0; R.events.collisions = 0;
    R.recordFlags = { buildBest: false, trackRecord: false, prevBuild: null, prevTrack: null, lapTime: null };
    R.driftRecord = null;
    R.challengeEval = null; R.challengeDoneAt = null;
    if (R.challenge && typeof R.challenge.reset === 'function') { try { R.challenge.reset(); } catch (eR) { /* ignore */ } }
    if (R.dom && R.dom.finish) { R.dom.finish.parentNode && R.dom.finish.parentNode.removeChild(R.dom.finish); R.dom.finish = null; }
    if (R.dom) { var go = R.dom.layer.querySelector('.rx-go'); if (go) go.parentNode.removeChild(go); clear(R.dom.feed); }
    R.paused = true; // so resume does bookkeeping
    resumeRace();
    toast(icon('restart', 14), 'Session restarted');
  }

  /* ======================================================================
     MULTIPLAYER (CB.race.ui.openNet) — the lobby (js/net/lobby.js) hands over a running CB.net.race session
     ====================================================================== */
  /** openNet(session, cfg): race / drift / free roam on a CB.net.race session. cfg (lobby): { mode, trackId, laps,
      weather, timeOfDay, assists, maxSteerAssist, players, selfId, isHost, build, seed, t0, onClose(results) }.
      The setup is locked to the session; the run starts at once (the host's clock is already running); leaving the
      results (or quitting) calls cfg.onClose(results) and session.destroy(), and the lobby takes over for a rematch. */
  function openNet(session, cfg) {
    if (!session || typeof session.update !== 'function' || typeof session.snapshot !== 'function') throw new Error('CB.race.ui.openNet: invalid net session');
    cfg = cfg || {};
    // a guest's session may still be waiting for the host's `start` (track, grid, mode): open once it has arrived
    var ns0 = netCall(session, 'netState', null);
    if (ns0 && ns0.started === false && !(arguments[2] && arguments[2].force)) {
      var t0 = Date.now();
      var waitStart = function () {
        var ns = netCall(session, 'netState', null);
        if (ns && ns.ended) { netCloseEarly(session, cfg); return; }
        if ((ns && ns.started) || netGet(session, 'geom')) { openNet(session, cfg); return; }
        if (Date.now() - t0 > 20000) { if (typeof console !== 'undefined') console.warn('[race-ui] openNet: no start from the host'); netCloseEarly(session, cfg); return; }
        setTimeout(waitStart, 60);
      };
      setTimeout(waitStart, 0);
      return api;
    }
    var settings = netSettings(session, cfg, loadSettings());
    var route = settings.discipline === 'drift' && driftMod() ? 'drift' : settings.discipline === 'arcade' && arcadeMod() ? 'arcade' : 'race';
    if (route === 'race') settings.discipline = 'race';
    var o = { net: { session: session, cfg: cfg }, autoStart: true, discipline: route, settings: settings,
              returnTo: 'multiplayer', backLabel: 'Back to lobby', _deepLink: deepClone(settings) };
    return open(cfg.build || stateBuild(), o);
  }
  /** The session ended before it could be shown (host left during the countdown, no start): back to the lobby. */
  function netCloseEarly(session, cfg) {
    var res = netCall(session, 'results', null), done = false;
    if (cfg && typeof cfg.onClose === 'function') { try { cfg.onClose(res); done = true; } catch (e) { /* ignore */ } }
    try { if (typeof session.destroy === 'function') session.destroy(); } catch (e2) { /* ignore */ }
    if (!done) goRoute('multiplayer');
  }
  /** Wire a net launch into the race R (called by startRace before the session task). */
  function setupNetRace(R, net) {
    var s = net.session, S = R.settings;
    R.net = net; R.netMode = netModeOf(s, net.cfg); R.netHookSeen = false; R.netClosed = false; R.netEnded = null; R.netOffs = [];
    netHookTarget.R = R;
    // arcade MP on a stunt track: the stunt drive model runs its own assist at the level the host replays (no CB.race.assist)
    var stuntNet = R.isArcade && netGet(s, 'arcadeKind') === 'stunt';
    if (R.isArcade) { R.netAssist = null; }   // arcade MP: one arcade handling model, no assist layer (circuit or stunt)
    else if (!R.isDrift && !stuntNet) {
      var AS = CB.race && CB.race.assist;
      if (S.steerAssist !== 'off' && AS && typeof AS.create === 'function') {
        try { R.netAssist = AS.create({ level: S.steerAssist, mode: 'race' }); R.assistObj = R.netAssist; } catch (e) { R.netAssist = null; }
      }
    } else { try { if (typeof s.setAssistLevel === 'function') s.setAssistLevel(S.steerAssist); } catch (e2) { /* ignore */ } }
    try { if (typeof s.setAssists === 'function') s.setAssists(deepClone(S.assists)); } catch (e3) { /* ignore */ }
    if (typeof s.onResults === 'function') {
      R.netOffs.push(s.onResults(function (res) {
        if (!U || U.race !== R) return;
        if (R.ended && U.screen === 'results') { R.rawResults = res || netCall(s, 'results', R.rawResults); showNetResults(R); }
      }));
    }
    if (typeof s.onEnd === 'function') {
      R.netOffs.push(s.onEnd(function (e) {
        if (!U || U.race !== R) return;
        R.netEnded = e || { message: 'Session ended' };
        var msg = (e && e.message) || 'Session ended';
        toast(icon('warn', 14), msg);
        feedPush('Session', msg, 'bad');
        if (R.ended && U.screen === 'results') showNetResults(R);
      }));
    }
  }
  function netIsHost(R) { var ns = netCall(R.session, 'netState', null); return !!((ns && ns.role === 'host') || (R.net.cfg && R.net.cfg.isHost)); }
  /** Leave the net race: cfg.onClose(results) (the lobby routes back to #/multiplayer) + session.destroy(). */
  function netClose(R, async) {
    if (!R || !R.net || R.netClosed) return;
    R.netClosed = true;
    if (netHookTarget.R === R) netHookTarget.R = null;
    var s = R.session || R.net.session, res = R.rawResults || netCall(s, 'results', null);
    (R.netOffs || []).forEach(function (off) { try { if (typeof off === 'function') off(); } catch (e) { /* ignore */ } });
    var cb = R.net.cfg && R.net.cfg.onClose;
    var fire = function () {
      var handled = false;
      if (typeof cb === 'function') { try { cb(res); handled = true; } catch (e) { if (typeof console !== 'undefined') console.error('[race-ui] net onClose', e); } }
      try { if (s && typeof s.destroy === 'function') s.destroy(); } catch (e2) { /* ignore */ }
      if (!handled) goRoute('multiplayer');
    };
    if (async) setTimeout(fire, 0); else fire();
  }
  function netLeave() {
    var R = U && U.race;
    if (R && R.net) netClose(R, false);
    else if (!goRoute('multiplayer')) close();
  }
  /** HUD corner: ping / drivers / sync (refreshed ~3x a second). */
  function updateNetDom(R, now) {
    var d = R.dom;
    if (!d || !d.net || now - (R.netDomAt || 0) < 300) return;
    R.netDomAt = now;
    var ns = netCall(R.session, 'netState', null), st = netStatusLine(ns);
    d.net.className = 'rx-net q-' + st.quality + (R.isDrift ? ' is-drift' : '');
    d.netText.textContent = st.text;
    var ended = R.netEnded || (ns && ns.ended);
    if (ended && !d.netBanner) {
      d.netBanner = h('div', { class: 'rx-net-banner', role: 'status', text: ended.message || 'Session ended' });
      d.layer.appendChild(d.netBanner);
    }
    var me = playerCar(R.lastSnap);
    if (!d.netWait && me && me.finished && R.netMode === 'race' && !(ns && ns.final)) {
      d.netWait = true;
      feedPush('Finished', 'Waiting for the other drivers · results follow from the host', 'good');
    }
  }
  /** Small name tags above remote cars (3D only: projected through renderer3d's camera). */
  function drawNetTags(R, ctx, snap, W, H) {
    if (!R.is3d || !R.renderer || typeof R.renderer.getCameraState !== 'function') return;
    var cam = R.renderer.getCameraState();
    if (!cam || cam.mode === 'map') return;
    var gy = null;
    try { var D = typeof R.renderer._debug === 'function' ? R.renderer._debug() : null; gy = D && D.S && D.S.world && typeof D.S.world.groundY === 'function' ? D.S.world.groundY : null; } catch (e) { gy = null; }
    var tags = netTags(snap, function (x, y) {
      var g = 0;
      if (gy) { try { g = +gy(x, -y) || 0; } catch (e2) { g = 0; } }
      return projectThrough(cam, W, H, x, y, g + 1.75);
    });
    if (!tags.length) return;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var placed = [];   // nearest tags keep their spot; farther ones that would overlap are lifted above them
    tags.slice().reverse().forEach(function (t) {
      var fs = Math.round(12 * t.scale), label = t.text + (t.sub ? '  ' + t.sub : '');
      ctx.font = '700 ' + fs + 'px Inter, system-ui, sans-serif';
      t._w = ctx.measureText(label).width + 16 * t.scale; t._h = fs + 9 * t.scale; t._y = t.y - t._h / 2; t._label = label; t._fs = fs;
      for (var guard = 0; guard < 6; guard++) {
        var hit = placed.filter(function (p) { return Math.abs(p.x - t.x) < (p._w + t._w) / 2 + 2 && Math.abs(p._y - t._y) < (p._h + t._h) / 2 + 2; })[0];
        if (!hit) break;
        t._y = hit._y - (hit._h + t._h) / 2 - 3;
      }
      placed.push(t);
    });
    tags.forEach(function (t) {
      var fs = t._fs, label = t._label;
      ctx.font = '700 ' + fs + 'px Inter, system-ui, sans-serif';
      var w = t._w, hh = t._h, x = t.x, y = t._y;
      ctx.globalAlpha = t.alpha * 0.82;
      ctx.fillStyle = 'rgba(10,12,16,0.78)';
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x - w / 2, y - hh / 2, w, hh, hh / 2); ctx.fill(); }
      else ctx.fillRect(x - w / 2, y - hh / 2, w, hh);
      ctx.fillStyle = t.color; ctx.fillRect(x - w / 2 + 6 * t.scale, y - 1.5, 3 * t.scale, 3);
      ctx.globalAlpha = t.alpha;
      ctx.fillStyle = t.kind === 'ai' ? '#c9ced6' : '#ffffff';
      ctx.fillText(label, x + 3 * t.scale, y + 0.5);
      ctx.globalAlpha = t.alpha * 0.55;
      ctx.beginPath(); ctx.moveTo(x - 4, y + hh / 2); ctx.lineTo(x + 4, y + hh / 2); ctx.lineTo(x, y + hh / 2 + 5); ctx.closePath();
      ctx.fillStyle = 'rgba(10,12,16,0.78)'; ctx.fill();
    });
    ctx.restore();
  }
  /** Players / ping / sync block of the pause menu. */
  function netPauseStatus(R) {
    var ns = netCall(R.session, 'netState', null) || {}, st = netStatusLine(ns);
    var list = h('div', { class: 'rx-net-list' });
    (ns.players || []).forEach(function (p) {
      list.appendChild(h('div', { class: 'rx-net-row' + (p.isLocal ? ' is-me' : '') + (p.connected === false ? ' is-off' : '') },
        h('b', { text: (p.name || 'Driver') + (p.isLocal ? ' (you)' : '') }),
        h('span', { class: 'rx-dim', text: p.kind === 'ai' ? 'AI' : p.connected === false ? 'left' : isNum(p.ping_ms) ? p.ping_ms + ' ms' : '—' })));
    });
    return h('div', { class: 'rx-net-card' },
      h('div', { class: 'rx-section-title' }, h('h3', null, h('span', { class: 'rx-skew' }), 'Session · ' + (ns.role === 'host' ? 'you host' : 'online'))),
      h('div', { class: 'rx-net q-' + st.quality, style: { position: 'static' } }, h('i'), h('span', { text: st.text })),
      list);
  }
  /** Final (or provisional) classification from the host. */
  function showNetResults(R) {
    if (!U || U.race !== R) return;
    setScreen('results');
    clear(U.host);
    var raw = R.rawResults || {}, rows = Array.isArray(raw.classification) ? raw.classification : [];
    R.netMode = netModeOf(R.session, R.net && R.net.cfg);
    var drift = R.netMode === 'drift', free = R.netMode === 'free', arc = !!R.isArcade;
    var final = !!(raw.final || raw.complete), ended = R.netEnded || (raw.aborted ? { message: raw.message } : null);
    var cars = (R.lastSnap && R.lastSnap.cars) || [];
    var lobbyPlayers = (R.net && R.net.cfg && Array.isArray(R.net.cfg.players)) ? R.net.cfg.players : [];
    function carFor(r) {
      for (var i = 0; i < cars.length; i++) { var c = cars[i]; if ((r.netId != null && c.netId === r.netId) || c.id === r.id) return c; }
      var nid = String(r.netId != null ? r.netId : r.id);
      for (var j = 0; j < lobbyPlayers.length; j++) {   // a driver who left is gone from the snapshot: the lobby roster still has the build
        var lp = lobbyPlayers[j], pid = String(lp && lp.id != null ? lp.id : '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 24);
        if (lp && lp.build && pid && pid === nid) return { build: lp.build };
      }
      return null;
    }
    var me = null;
    rows.forEach(function (r) { if (r.isPlayer) me = r; });
    var title = ended && !final ? 'Session ended' : drift ? (me && me.position === 1 && rows.length > 1 && num0(rows[1].score) < num0(me.score) ? 'Battle won' : 'Drift battle') :
      free ? 'Free roam' : me && me.status === 'dnf' ? 'Did not finish' : me && me.position === 1 && rows.length > 1 && me.status === 'finished' ? 'Victory' : 'Race classification';
    var note = ended && !final ? (ended.message || 'The session ended') : !final ? 'Provisional — waiting for the host\'s final results…' : 'Final classification from the host';
    var head = h('header', { class: 'rx-res-head' },
      h('div', { class: 'rx-res-pos rx-display rx-num' }, me ? 'P' : null, me ? String(me.position) : '—', me ? h('small', { text: '/' + rows.length }) : null),
      h('div', { class: 'rx-res-title' },
        h('div', { class: 'rx-eyebrow accent mx-kicker', text: (R.def.name || '') + ' · Multiplayer · ' + (arc ? 'Arcade · ' : '') + (drift ? 'Drift battle' : free ? 'Free roam' : plural(R.settings.laps, 'lap')) }),
        h('h2', { class: 'rx-display mx-res-title', text: title }, arc ? h('span', { class: 'rx-chip arcade rx-res-arcade', title: 'Arcade multiplayer: no records, no purse' }, icon('bolt', 12), 'ARCADE') : null),
        h('div', { class: 'rx-dim' + (ended && !final ? ' rx-bad' : ''), 'data-net-note': final ? 'final' : 'pending', text: note })));
    var tbl = h('table', { class: 'rx-table' });
    tbl.appendChild(h('thead', null, h('tr', null, h('th', { text: 'Pos' }), h('th', { text: 'Driver' }),
      drift ? h('th', { class: 'r', text: 'Score' }) : h('th', { class: 'r', text: 'Laps' }),
      h('th', { class: 'r', text: drift ? 'Gap' : 'Time / Gap' }), drift ? null : h('th', { class: 'r', text: 'Best lap' }),
      h('th', { class: 'r', text: drift ? 'Runs' : arc ? 'Hits · items · coins' : 'Pen.' }))));
    var tbody = h('tbody');
    rows.forEach(function (r, i) {
      var c = carFor(r) || {}, col = r.color || c.color || '#888';
      var sub = realCarName({ build: c.build, carName: c.carName }) || carSubtitle(c) || (r.kind === 'ai' ? 'AI driver' : '');
      tbody.appendChild(h('tr', { class: r.isPlayer ? 'is-player' : '', style: { 'animation-delay': (i * 40) + 'ms' } },
        h('td', { class: 'pos rx-num', text: String(r.position || i + 1) }),
        h('td', null, h('div', { class: 'who' },
          h('span', { class: 'rx-carnum', style: { background: col, color: readableOn(col) }, text: r.number != null ? String(r.number) : '' }),
          h('div', null, h('b', { text: (r.name || 'Driver') + (r.isPlayer ? ' (you)' : '') + (r.kind === 'ai' ? ' · AI' : '') }), h('small', { text: sub })))),
        drift ? h('td', { class: 'r rx-num', text: fmtPts(r.score) }) : h('td', { class: 'r rx-num', text: String(isNum(r.laps) ? r.laps : '—') }),
        h('td', { class: 'r rx-num' + (r.status === 'dnf' ? ' rx-bad' : ''), text: r.status === 'dnf' && !drift ? 'DNF' : (r.gapText || '—') }),
        drift ? null : h('td', { class: 'r rx-num' + (r.fastestLap ? ' rx-purple' : '') }, fmtTime(r.bestLap_s, '—'), r.fastestLap ? ' ●' : null),
        h('td', { class: 'r rx-num rx-dim', text: drift ? (Array.isArray(r.runScores) ? r.runScores.map(function (v) { return v == null ? '—' : fmtPts(v); }).join(' · ') : '—')
          : arc ? (r.arcade ? num0(r.arcade.hitsLanded) + ' · ' + num0(r.arcade.itemsUsed) + ' · ' + num0(r.arcade.coins) : '—')
          : (r.penalties_s ? '+' + r.penalties_s + 's' : '—') })));
    });
    if (!rows.length) tbody.appendChild(h('tr', null, h('td', { colspan: '6', class: 'rx-dim', text: 'No classification was received.' })));
    tbl.appendChild(tbody);
    var main = h('div', { class: 'rx-res-main', style: { 'grid-template-columns': '1fr' } }, h('div', { class: 'rx-panel rx-table-wrap rx-scroll' }, tbl));
    // the host is gone (lost, left, closed the room) or we were removed: there is no lobby to rematch in
    var lob = null;
    try { lob = CB.net && CB.net.lobby && typeof CB.net.lobby.state === 'function' ? CB.net.lobby.state() : null; } catch (eL) { lob = null; }
    var noRoom = !!(ended && !final && (/^(host-timeout|kicked|version)$/.test(String(ended.reason || '')) ||
      (lob && (lob.view === 'closed' || (lob.core && lob.core.phase === 'closed')))));
    var back = h('button', { class: 'cb-btn rx-btn primary big', type: 'button', 'data-act': 'net-lobby', onclick: netLeave }, icon('back', 16), noRoom ? 'Back to multiplayer' : 'Back to lobby · rematch');
    var foot = h('footer', { class: 'rx-res-foot' }, h('span', { class: 'rx-spacer' }),
      h('span', { class: 'rx-dim', style: { 'font-size': 'var(--fs-sm)' } }, kbd('Enter'), noRoom ? ' back to multiplayer' : ' back to lobby'), back);
    U.host.appendChild(h('div', { class: 'rx-results', 'data-net': final ? 'final' : 'pending' }, head, main, foot));
    U.resultsRedraw = null;
    try { back.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  /* ======================================================================
     TOUCH controls
     ====================================================================== */
  /** "Rotate to landscape" card for the driving view (CSS shows it only on touch screens in portrait; touches pass
      through the dimmed backdrop; "Keep portrait" hides it for the rest of the browser session). */
  var ROTATE_KEY = 'rx-rotate-dismissed';
  function rotatePrompt() {
    var off = false;
    try { off = window.sessionStorage.getItem(ROTATE_KEY) === '1'; } catch (e) { off = false; }
    var el = h('div', { class: 'rx-rotate' + (off ? ' is-dismissed' : ''), role: 'status' });
    el.appendChild(h('div', { class: 'rx-rotate-card' },
      h('div', { class: 'rx-rotate-ico', html: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/></svg>' }),
      h('b', { text: 'Rotate your phone to landscape' }),
      h('p', { text: 'Driving works best sideways: steer on the left, pedals on the right.' }),
      h('button', { class: 'cb-btn rx-btn ghost', type: 'button', text: 'Keep portrait', onclick: function (e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        el.classList.add('is-dismissed');
        try { window.sessionStorage.setItem(ROTATE_KEY, '1'); } catch (e2) { /* private mode: dismissed for this session only */ }
      } })));
    return el;
  }
  function touchWanted() {
    var m = U.settings.touchControls;
    if (m === 'on') return true;
    if (m === 'off') return false;
    try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; }
  }
  function updateTouchVisibility() {
    var R = U && U.race;
    if (!R || !R.touchEl) return;
    var on = touchWanted() && !tiltOn();      // tilt steering brings its own pedal layout (js/input/input-ui.js)
    R.touchEl.style.display = on ? '' : 'none';
    R.input.touch.active = on;
    var gears = R.touchEl.querySelector('.rx-touch-gears');
    if (gears) gears.style.display = R.settings.assists.autoShift ? 'none' : '';
  }
  /** Phone layout hints for the canvas HUD (CB.race.hud.setLayout), re-measured ~4x a second: the free bottom band
      between the touch steering pad / tilt zones (left) and the pedals (right), the controls' bottom edge, and whether
      the webcam preview sits in the left column. Only on coarse pointers: desktop layouts never change. */
  function hudTouchLayout(R, t) {
    if (R._hudLayoutAt && t - R._hudLayoutAt < 250 && t >= R._hudLayoutAt) return;
    R._hudLayoutAt = t;
    var o = { touch: false, band: null, bottom: 0, noMinimap: false };
    try {
      o.touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      var cv = U.canvas, cr = cv && cv.getBoundingClientRect(), root = U.root || document;
      if (o.touch && cr && cr.width > 0) {
        var W = cr.width, H = cr.height, l = 0, r = W, bottom = 0, lift = 0;
        var els = root.querySelectorAll('.rx-steerpad,.rx-pedals,.pw-zone,.pw-tb,.pw-steerind,.pw-chip');
        for (var i = 0; i < els.length; i++) {
          var b = els[i].getBoundingClientRect();
          if (b.width < 1 || b.height < 1) continue;
          var x0 = b.left - cr.left, x1 = b.right - cr.left, y0 = b.top - cr.top, y1 = b.bottom - cr.top;
          if (y1 < H * 0.6) continue;
          if (x0 < W / 2 && x1 > W / 2) { lift = Math.max(lift, H - y0 + 6); continue; }   // centred: the bar sits above it
          if (x1 <= W / 2) l = Math.max(l, x1); else r = Math.min(r, x0);
          bottom = Math.max(bottom, H - y1);
        }
        if (l > 0 || r < W) o.band = { l: l, r: r };
        o.bottom = Math.max(bottom, lift);
        var pip = document.querySelector('.cw-pip');
        if (pip && pip.style.display !== 'none') { var pb = pip.getBoundingClientRect(); o.noMinimap = pb.width > 0 && pb.left - cr.left < W * 0.3; }
      }
    } catch (e) { /* hints are optional */ }
    try { R.hud.setLayout(o); } catch (e2) { /* ignore */ }
  }
  function buildTouchControls(layer) {
    var R = U.race, T = R.input.touch;
    var knob = h('div', { class: 'rx-knob' });
    var pad = h('div', { class: 'rx-steerpad', 'aria-label': 'Steering' }, knob);
    var steerId = null;
    function steerAt(e) {
      var r = pad.getBoundingClientRect();
      var x = clamp((e.clientX - (r.left + r.width / 2)) / (r.width * 0.42), -1, 1);
      T.steer = -x; // left is +1 in input space
      knob.style.transform = 'translateX(' + (x * r.width * 0.36) + 'px)';
    }
    pad.addEventListener('pointerdown', function (e) { steerId = e.pointerId; try { pad.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } steerAt(e); e.preventDefault(); });
    pad.addEventListener('pointermove', function (e) { if (e.pointerId === steerId) steerAt(e); });
    function steerEnd(e) { if (e.pointerId !== steerId) return; steerId = null; T.steer = 0; knob.style.transform = ''; }
    pad.addEventListener('pointerup', steerEnd); pad.addEventListener('pointercancel', steerEnd);

    function pedal(cls, label, key) {
      var fill = h('div', { class: 'rx-fill' });
      var p = h('div', { class: 'rx-pedal ' + cls }, fill, h('span', { text: label }));
      var id = null;
      function at(e) {
        var r = p.getBoundingClientRect();
        var v = clamp(0.55 + 0.45 * (1 - (e.clientY - r.top) / r.height) * 1.2, 0.35, 1);
        T[key] = v; fill.style.height = Math.round(v * 100) + '%';
      }
      p.addEventListener('pointerdown', function (e) { id = e.pointerId; try { p.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } p.classList.add('is-down'); at(e); e.preventDefault(); });
      p.addEventListener('pointermove', function (e) { if (e.pointerId === id) at(e); });
      function end(e) { if (e.pointerId !== id) return; id = null; T[key] = 0; fill.style.height = '0'; p.classList.remove('is-down'); }
      p.addEventListener('pointerup', end); p.addEventListener('pointercancel', end);
      return p;
    }
    function tbtn(label, down, up) {
      var b = h('div', { class: 'rx-tbtn', role: 'button', text: label });
      b.addEventListener('pointerdown', function (e) { b.classList.add('is-down'); try { b.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } down(); e.preventDefault(); });
      function end() { b.classList.remove('is-down'); if (up) up(); }
      b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end);
      return b;
    }
    var gears = h('div', { class: 'rx-touch-aux rx-touch-gears' },
      tbtn('+', function () { R.input.queueShift(1); }),
      tbtn('−', function () { R.input.queueShift(-1); }));
    var aux = h('div', { class: 'rx-touch-aux' },
      tbtn('HB', function () { T.handbrake = true; }, function () { T.handbrake = false; }));
    var el = h('div', { class: 'rx-touch' }, pad,
      h('div', { class: 'rx-pedals' }, gears, aux, pedal('brake', 'BRAKE', 'brake'), pedal('gas', 'GAS', 'throttle')));
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    layer.appendChild(el);
    R.touchEl = el;
    updateTouchVisibility();
    var IU = CB.input && CB.input.ui;
    if (IU && typeof IU.mountTouch === 'function') { try { IU.mountTouch(layer, R, updateTouchVisibility); } catch (eT) { /* optional */ } }
  }
  /* ---------------- phone steering (js/input/*: CB.input.hub / tilt / phone wheel; all optional, feature-detected) */
  function tiltOn() { var T = CB.input && CB.input.tilt; return !!(T && T.local && T.local.enabled); }
  function phoneButtons(mb) {
    var IU = CB.input && CB.input.ui;
    if (!IU || typeof IU.menuItems !== 'function') return null;
    try { return IU.menuItems().map(function (it) { return mb(it.label, it.icon || 'steer', it.fn); }); } catch (e) { return null; }
  }
  function phoneSetupRow() {
    var IU = CB.input && CB.input.ui;
    if (!IU || typeof IU.setupRow !== 'function') return null;
    try { return IU.setupRow(); } catch (e) { return null; }
  }
  /** Per-frame report to CB.input.hub: drive status for the phone + haptics (kerbs, contact, walls). */
  function phoneFrame(R, snap, me) {
    var hub = CB.input && CB.input.hub;
    if (!hub || typeof hub.frame !== 'function') return;
    try {
      hub.frame({
        screen: R.isDrift ? 'drift' : 'race', driving: !!R.simActive && !R.ended, paused: !!R.paused && !R.net, net: !!R.net,
        speed: me ? Math.abs(me.speed || 0) : 0, gear: me && isNum(me.gear) ? me.gear : 0,
        rpmFrac: me && isNum(me.rpm) && isNum(me.redline || me.maxRpm) ? me.rpm / (me.redline || me.maxRpm) : 0,
        surface: me ? me.surface : null, events: snap && snap.events, playerId: me ? me.id : null, assist: R.settings && R.settings.steerAssist
      });
    } catch (e) { /* never break the loop */ }
  }

  /* ======================================================================
     RESULTS
     ====================================================================== */
  function endSession() {
    var R = U && U.race;
    if (!R || R.ended) return;
    R.ended = true;
    R.simActive = false;
    if (R.net) {   // multiplayer: the host's classification (re-rendered when the final results arrive)
      try { R.rawResults = R.session.results(); } catch (eN) { R.rawResults = null; }
      if (R.audio && R.audio.setMuted) { try { R.audio.setMuted(true); } catch (eN2) { /* ignore */ } }
      R.running = false;
      cancelAnimationFrame(R.raf);
      U.pauseRefs = null;
      showNetResults(R);
      return;
    }
    fastForwardField(R);
    var raw = null;
    try { if (typeof R.session.results === 'function') raw = R.session.results(); } catch (e) { raw = null; }
    R.rawResults = raw;
    var snap = R.lastSnap || { cars: [] };
    var res = normalizeResults(raw, snap, { mode: R.settings.mode });
    // final record sweep: engine's best lap (in case lap tracking missed it)
    var me = playerCar(snap);
    var myRow = null;
    res.rows.forEach(function (r) { if (r.isPlayer || (me && r.id === me.id)) myRow = r; });
    if (R.isDrift) {
      var dsc = raw && raw.drift;
      R.driftRecord = dsc ? U.records.submitDrift(R.def.id, U.hash, {
        score: num0(dsc.total), medal: dsc.medal || null, buildName: (U.build.meta && U.build.meta.name) || 'Untitled Build',
        mode: (raw && raw.driftMode) || R.settings.driftMode, assist: R.settings.steerAssist
      }) : null;
    } else if (myRow && isNum(myRow.bestLap_s)) {
      var sub = U.records.submit(R.def.id, U.hash, {
        time: myRow.bestLap_s, sectors: myRow.bestSectors, buildName: (U.build.meta && U.build.meta.name) || 'Untitled Build',
        mode: R.settings.mode, weather: R.settings.weather, timeOfDay: R.settings.timeOfDay
      });
      if (sub.buildBest) { if (!R.recordFlags.buildBest) R.recordFlags.prevBuild = sub.prevBuild; R.recordFlags.buildBest = true; }
      if (sub.trackRecord) { if (!R.recordFlags.trackRecord) R.recordFlags.prevTrack = sub.prevTrack; R.recordFlags.trackRecord = true; }
    }
    if (R.audio && R.audio.setMuted) { try { R.audio.setMuted(true); } catch (e2) { /* ignore */ } }
    R.running = false;
    cancelAnimationFrame(R.raf);
    if (U.pauseRefs) U.pauseRefs = null;
    captureReplay(R);
    pluginCall('results', [raw, res, snap]);
    reportFinish(raw, res, snap);
    showResults(res, myRow, snap);
  }

  /** Once the player has taken the flag, run the rest of the field home off-screen (bounded by a wall-clock
      budget) so the classification shows real finishing gaps instead of cars stranded on their final lap. */
  function fastForwardField(R) {
    try {
      var S = R.session, me = playerCar(R.lastSnap);
      if (R.settings.mode !== 'race' || !S || typeof S.simulate !== 'function' || !me || !me.finished) return;
      if (typeof S.getPhase === 'function' && S.getPhase() === 'finished') return;
      var t0 = (typeof performance !== 'undefined' ? performance : Date).now(), simmed = 0;
      while (simmed < 900 && (!S.getPhase || S.getPhase() !== 'finished')) {
        S.simulate(1);
        simmed += 1;
        if ((typeof performance !== 'undefined' ? performance : Date).now() - t0 > FAST_FORWARD_BUDGET_MS) break;
      }
      R.lastSnap = S.snapshot();
    } catch (e) { if (typeof console !== 'undefined') console.warn('[race-ui] fast-forward', e); }
  }

  /* ---------------------------------------------------------- replays */
  function replayMod() { var G = CB.game && CB.game.replay; return G && typeof G.openUI === 'function' ? G : null; }
  /** Finalise this session's replay recording (CB.game.replay.install wraps engine sessions) so the
      results screen can offer "Watch replay" / "Photo mode" straight away. */
  function captureReplay(R) {
    var G = replayMod();
    if (!G || !R) return null;
    var rep = null;
    try {
      var es = R.session && typeof R.session.finishReplay !== 'function' && R.session.engine ? R.session.engine : R.session;   // drift sessions wrap the engine
      if (es && typeof es.finishReplay === 'function') rep = es.finishReplay();
    } catch (e) { rep = null; }
    if (!rep) { try { var last = typeof G.last === 'function' ? G.last() : null; if (last && last !== R.replayBaseline) rep = last; } catch (e2) { rep = null; } }
    if (rep && rep.meta) {
      if (!rep.meta.trackName && R.def) rep.meta.trackName = R.def.name;
      if (!rep.meta.buildName && U.build && U.build.meta) rep.meta.buildName = U.build.meta.name;
    }
    R.replay = rep || null;
    return R.replay;
  }
  function openReplay(R, photo) {
    var G = replayMod();
    if (!G || !R || !R.replay) { toast('No replay was recorded for this session'); return; }
    try {
      var o = { root: U.root, geom: R.geom, trackDef: R.def, units: R.settings.units === 'mph' ? 'mph' : 'kph', autoplay: !photo, photo: !!photo,
        name: ((U.build.meta && U.build.meta.name) || 'Race') + ' · ' + (R.def.name || ''),
        onClose: function () { try { U && U.root && U.root.focus({ preventScroll: true }); } catch (e) { /* ignore */ } if (U && U.resultsRedraw) U.resultsRedraw(); } };
      G.openUI(R.replay, o);
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[race-ui] replay', e);
      toast(icon('warn', 14), 'Replay unavailable');
    }
  }
  /** Career rounds and events count once: the race UI never offers a re-run of the same round. */
  function oneShotLaunch() {
    if (U && U.opts && typeof U.opts.oneShot === 'boolean') return U.opts.oneShot;   // plugin launches (F1 weekend sessions)
    var k = U && U.opts && U.opts.context && U.opts.context.kind; return k === 'career' || k === 'event' || k === 'challenge';
  }

  /** Hand the classification to the launcher (hub / career) once per finished session. */
  function reportFinish(raw, res, snap) {
    var R = U.race, out = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { classification: res.rows, mode: R.settings.mode, trackId: R.def.id };
    out.trackId = out.trackId || R.def.id;
    out.mode = out.mode || R.settings.mode;
    out.settings = deepClone(R.settings);
    out.fieldSize = out.fieldSize || (res.rows ? res.rows.length : null);
    out.collisions = R.events.collisions;
    out.lastSnapshot = snap;
    if (R.challenge) {
      var ev = R.challengeEval;
      try { ev = R.challenge.evaluate(snap) || ev; } catch (e) { /* keep last */ }
      if (ev) out.challenge = ev;
      try { if (typeof R.challenge.result === 'function' && R.challenge.result()) out.challengeResult = R.challenge.result(); } catch (e2) { /* ignore */ }
    }
    if (U.opts && U.opts.career) out.career = U.opts.career;
    if (U.launchLock) {
      var LL = U.launchLock, why = launchMismatch(R) || [];
      out.launchSettings = Object.assign({ discipline: LL.discipline || null, fieldSize: LL.fieldSize != null ? LL.fieldSize : null }, deepClone(LL.values));
      out.launchMismatch = why.length > 0;
      if (why.length) out.launchMismatchKeys = why;
    }
    out.discipline = R.isDrift ? 'drift' : 'race';
    out.steerAssist = R.settings.steerAssist;
    out.handling = R.isArcade ? 'arcade' : 'sim';   // ARCADE-SPEC: arcade runs are flagged for profile / reward listeners
    if (R.isArcade) out.arcade = true;
    if (R.isDrift && out.drift) {
      var dr = out.drift;
      out.driftScore = isNum(dr.total) ? Math.round(dr.total) : 0;
      out.driftMode = out.driftMode || R.settings.driftMode;
      var pl = (out.classification || []).filter(function (c) { return c && (c.isPlayer || c.id === 'player'); })[0];
      if (pl) pl.driftScore = out.driftScore;
      if (out.player && typeof out.player === 'object') out.player.driftScore = out.driftScore;
      var A = CB.game && CB.game.achievements;
      if (A && typeof A.check === 'function') {
        try { A.check(null, { type: 'drift', score: out.driftScore, combo: num0(dr.maxCombo || dr.maxMultiplier), duration_s: num0(out.elapsed_s), medal: dr.medal || null, trackId: out.trackId, mode: out.driftMode }); }
        catch (eA) { if (typeof console !== 'undefined') console.warn('[race-ui] drift achievements', eA); }
      }
    }
    R.reported = out;
    if (typeof U.opts.onFinish === 'function') { try { U.opts.onFinish(out); } catch (e3) { if (typeof console !== 'undefined') console.error('[race-ui] onFinish', e3); } }
    try { document.dispatchEvent(new CustomEvent('cb:race-finished', { detail: { results: out } })); } catch (e4) { /* ignore */ }
  }
  /** Engine cfg overrides from the launcher, applicable to this circuit (null when the player picked another track). */
  /** Mode plugin of the launch (docs/F1-SPEC.md §6): { id, findTrack, configure, attach, setRenderer, drawHud, hudOptions,
      results, resultsPanel, records, detach }. Every member optional; failures never stop the session. */
  function pluginOf() { var p = U && U.opts && U.opts.plugin; return p && typeof p === 'object' ? p : null; }
  function pluginCall(fn, args) {
    var p = pluginOf();
    if (!p || typeof p[fn] !== 'function') return undefined;
    try { return p[fn].apply(p, args || []); } catch (e) { if (typeof console !== 'undefined') console.warn('[race-ui] plugin.' + fn, e); return undefined; }
  }
  function launchCfg(def) {
    var L = U && U.opts;
    if (!L) return null;
    var any = ['extras', 'hooks', 'opponents', 'challenge', 'seed', 'startPosition'].some(function (k) { return L[k] !== undefined; });
    if (!any) return null;
    var tid = L.trackId || (L.settings && L.settings.trackId);
    if (tid && def && def.id && tid !== def.id) return null;
    return L;
  }

  function showResults(res, myRow, snap) {
    var R = U.race, S = R.settings;
    if (R.isDrift && R.rawResults && R.rawResults.drift) { showDriftResults(R.rawResults, res, myRow); return; }
    setScreen('results');
    clear(U.host);
    var rows = res.rows, total = rows.length;
    var mode = S.mode;
    var myTrack = myRow ? R.tracker.cars[myRow.id] : null;
    var myLaps = myTrack ? myTrack.laps : [];
    var validLaps = myLaps.filter(function (l) { return l.valid; });
    var avg = validLaps.length ? validLaps.reduce(function (a, l) { return a + l.time; }, 0) / validLaps.length : null;
    var gridPos = myRow && R.tracker.gridOrder ? R.tracker.gridOrder[myRow.id] : null;
    var gained = gridPos && myRow && mode === 'race' ? gridPos - myRow.position : null;
    var top = myTrack ? myTrack.topSpeed * 3.6 : null;

    /* header */
    var title = mode === 'race' ? (myRow && myRow.dnf ? 'Did not finish' : (myRow && myRow.position === 1 ? 'Victory' : 'Race classification')) :
      mode === 'time-trial' ? 'Time trial complete' : 'Practice summary';
    // a Driving School challenge runs as a time trial on its own course: name the challenge and its outcome instead
    var chEval = R.challenge && R.challengeEval, chName = chEval && chEval.result && chEval.result.name;
    if (chName) title = chName + ' · ' + (chEval.failed ? 'not completed' : chEval.medal ? chEval.medal.charAt(0).toUpperCase() + chEval.medal.slice(1) + ' medal' : 'complete');
    var badges = h('div', { class: 'rx-badges' });
    var delay = 0;
    function badge(text, cls, ico) { badges.appendChild(h('span', { class: 'rx-badge ' + (cls || ''), style: { 'animation-delay': (delay += 120) + 'ms' } }, icon(ico || 'star', 14), text)); }
    // the stored "track record" is the player's own best on this circuit (any build) — AI laps are never stored, so
    // only call it a track record when no car in this session lapped faster; otherwise it is the player's record
    if (R.recordFlags.trackRecord) badge(myRow && (myRow.isFastest || total <= 1) ? 'New track record' : 'New personal track best', 'purple', 'trophy');
    if (R.recordFlags.buildBest) badge(R.recordFlags.prevBuild ? 'New personal best' : 'First record set', 'good', 'timer');
    if (myRow && myRow.isFastest && mode === 'race' && total > 1) badge('Fastest lap', 'purple', 'timer');
    if (mode === 'race' && myRow && myRow.position === 1 && total > 1) badge('Race winner', '', 'trophy');
    if (gained != null && gained >= 3) badge('+' + gained + ' places', 'good', 'flag');
    if (myRow && !myRow.penalties_s && mode === 'race' && R.events.collisions === 0 && !myRow.dnf) badge('Clean race', 'good', 'star');

    var posText = mode === 'race' ? (myRow && !myRow.dnf ? String(myRow.position) : 'DNF') : (myRow && isNum(myRow.bestLap_s) ? fmtTime(myRow.bestLap_s) : '—');
    var head = h('header', { class: 'rx-res-head' },
      h('div', { class: 'rx-res-pos rx-display rx-num' }, mode === 'race' && myRow && !myRow.dnf ? 'P' : null, posText,
        mode === 'race' && myRow && !myRow.dnf ? h('small', { text: '/' + total }) : null),
      h('div', { class: 'rx-res-title' },
        h('div', { class: 'rx-eyebrow accent mx-kicker', text: (R.def.name || '') + (chName ? ' · ' + (chEval.text || 'Challenge') : ' · ' + pick(MODES, mode).name + (mode === 'practice' ? '' : ' · ' + plural(S.laps, 'lap'))) }),
        R.isArcade ? h('span', { class: 'rx-chip arcade rx-res-arcade', title: 'Arcade handling: separate best laps' }, icon('bolt', 12), 'ARCADE') : null,
        h('h2', { class: 'rx-display mx-res-title', text: title }),
        h('div', { class: 'rx-dim', text: resultBuildName() + ' · ' + pick(WEATHERS, S.weather).name + ' · ' + pick(TIMES, S.timeOfDay).name })),
      badges);

    /* table */
    var tbl = h('table', { class: 'rx-table' });
    var thead = h('thead', null, h('tr', null,
      h('th', { text: 'Pos' }), h('th', { text: 'Driver' }), h('th', { class: 'r', text: 'Laps' }),
      h('th', { class: 'r', text: mode === 'race' ? 'Time / Gap' : 'Gap' }), h('th', { class: 'r', text: 'Best lap' }),
      h('th', { class: 'r', text: 'Pen.' })));
    var tbody = h('tbody');
    rows.forEach(function (r, i) {
      var col = r.color || '#888';

      var laps = isNum(r.lap) ? r.lap : (R.tracker.cars[r.id] ? R.tracker.cars[r.id].laps.length : 0);
      var gp = R.tracker.gridOrder ? R.tracker.gridOrder[r.id] : null;
      var delta = gp && mode === 'race' && !r.dnf ? gp - r.position : 0;
      tbody.appendChild(h('tr', { class: r.isPlayer ? 'is-player' : '', style: { 'animation-delay': (i * 40) + 'ms' } },
        h('td', { class: 'pos rx-num' }, String(r.position),
          delta ? h('span', { class: delta > 0 ? 'rx-good' : 'rx-bad', style: { 'font-size': 'var(--fs-2xs)', 'margin-left': '5px', 'font-style': 'normal' }, text: (delta > 0 ? '▲' : '▼') + Math.abs(delta) }) : null),
        h('td', null, h('div', { class: 'who' },
          h('span', { class: 'rx-carnum', style: { background: col, color: readableOn(col) }, text: r.number != null ? String(r.number) : '' }),
          h('div', null, h('b', { text: (r.name || 'Driver') + (r.isPlayer ? ' (you)' : '') }), h('small', { text: carSubtitle(r) })))),
        h('td', { class: 'r rx-num', text: String(laps) }),
        h('td', { class: 'r rx-num' + (r.dnf ? ' rx-bad' : ''), text: r.gapText || '—' }),
        h('td', { class: 'r rx-num' + (r.isFastest ? ' rx-purple' : '') }, fmtTime(r.bestLap_s, '—'), r.isFastest ? ' ●' : null),
        h('td', { class: 'r rx-num' + (r.penalties_s ? ' rx-bad' : ' rx-dim'), text: r.penalties_s ? '+' + r.penalties_s + 's' : '—' })));
    });
    tbl.appendChild(thead); tbl.appendChild(tbody);
    var tableWrap = h('div', { class: 'rx-panel rx-table-wrap rx-scroll' }, tbl);
    if (mode === 'race' && rows.some(function (r) { return /\*$/.test(r.gapText || ''); })) {
      tableWrap.appendChild(h('div', { class: 'rx-dim', style: { 'font-size': 'var(--fs-xs)', padding: '8px 12px' }, text: '* still running when the session closed — gap estimated' }));
    }

    /* side: tiles + charts */
    var rec = U.records.trackBest(R.def.id), pb = U.records.bestFor(R.def.id, U.hash);
    var tiles = h('div', { class: 'rx-res-tiles' },
      h('div', { class: 'rx-tile' + (myRow && myRow.isFastest ? ' purple' : ''), title: myRow && myRow.isFastest ? 'Fastest lap of the session' : '' }, h('div', { class: 'rx-stat-l', text: 'Best lap' }), h('div', { class: 'rx-stat-v rx-num', text: fmtTime(myRow && myRow.bestLap_s, '—') })),
      h('div', { class: 'rx-tile' }, h('div', { class: 'rx-stat-l', text: 'Average lap' }), h('div', { class: 'rx-stat-v rx-num', text: fmtTime(avg, '—') })),
      h('div', { class: 'rx-tile' }, h('div', { class: 'rx-stat-l', text: 'Top speed' }), h('div', { class: 'rx-stat-v rx-num', text: top ? fmtSpeed(top, S.units) : '—' })),
      h('div', { class: 'rx-tile accent' }, h('div', { class: 'rx-stat-l', text: 'Personal best' }), h('div', { class: 'rx-stat-v rx-num', text: pb ? fmtTime(pb.time) : '—' })),
      h('div', { class: 'rx-tile' }, h('div', { class: 'rx-stat-l', text: 'Your track record' }), h('div', { class: 'rx-stat-v rx-num', text: rec ? fmtTime(rec.time) : '—' })),
      h('div', { class: 'rx-tile' }, h('div', { class: 'rx-stat-l', text: mode === 'race' ? 'Contacts · Pen.' : 'Valid laps' }),
        h('div', { class: 'rx-stat-v rx-num', text: mode === 'race' ? R.events.collisions + ' · ' + (myRow && myRow.penalties_s ? '+' + myRow.penalties_s + 's' : '0s') : validLaps.length + '/' + myLaps.length })));
    var lapCv = h('canvas');
    var acc = accentColor();
    var compare = pickCompareCar(rows, myRow, R);
    var lapChart = h('div', { class: 'rx-panel rx-chart' },
      h('div', { class: 'rx-chart-head' }, h('span', { class: 'rx-label', text: 'Lap times' }),
        h('div', { class: 'rx-legend' },
          h('span', null, h('i', { style: { background: acc } }), 'You'),
          compare ? h('span', null, h('i', { style: { background: compare.color || '#8a8f98' } }), compare.name || 'Rival') : null,
          h('span', null, h('i', { style: { background: '#b26bff' } }), 'Best'),
          h('span', null, h('i', { style: { background: '#ff4d4d' } }), 'Invalid'))),
      lapCv);
    var posCv = null, posChart = null;
    if (mode === 'race' && total > 1) {
      posCv = h('canvas');
      posChart = h('div', { class: 'rx-panel rx-chart small' }, h('div', { class: 'rx-chart-head' }, h('span', { class: 'rx-label', text: 'Position by lap' })), posCv);
    }
    var sectorsBox = null;
    if (myRow && Array.isArray(myRow.bestSectors) && myRow.bestSectors.some(isNum)) {
      var ideal = myRow.bestSectors.reduce(function (a, s) { return a + (isNum(s) ? s : 0); }, 0);
      sectorsBox = h('div', { class: 'rx-res-tiles' },
        myRow.bestSectors.slice(0, 3).map(function (s, i) {
          return h('div', { class: 'rx-tile' }, h('div', { class: 'rx-stat-l', text: 'Best S' + (i + 1) }), h('div', { class: 'rx-stat-v rx-num', text: isNum(s) ? s.toFixed(3) : '—' }));
        }));
      sectorsBox.appendChild(h('div', { class: 'rx-tile', style: { 'grid-column': '1 / -1' } }, h('div', { class: 'rx-stat-l', text: 'Ideal lap (sum of best sectors)' }), h('div', { class: 'rx-stat-v rx-num', text: fmtTime(ideal) })));
    }
    var plPanel = pluginCall('resultsPanel', [res, R.rawResults, myRow]);
    var side = h('div', { class: 'rx-res-side rx-scroll' }, plPanel && plPanel.nodeType === 1 ? plPanel : null, tiles, lapChart, posChart, sectorsBox);
    var main = h('div', { class: 'rx-res-main' }, tableWrap, side);

    var oneShot = oneShotLaunch();
    var backBtn = h('button', { class: 'cb-btn rx-btn' + (oneShot ? ' primary big' : ''), type: 'button', onclick: isGameLaunch() ? close : goAtelier, title: isGameLaunch() ? ((U.opts && U.opts.backLabel) || 'Return to career') : 'Back to the Garage to tune your car' }, icon(isGameLaunch() ? 'back' : 'wrench', 16), isGameLaunch() ? (oneShot ? ((U.opts && U.opts.continueLabel) || 'Continue · rewards') : backLabel()) : 'Tune car · Garage');
    var again = oneShot ? backBtn : h('button', { class: 'cb-btn rx-btn primary big', type: 'button', onclick: startRace }, icon('restart', 16), 'Race again');
    var hasReplay = !!(R.replay && replayMod());
    var foot = h('footer', { class: 'rx-res-foot' },
      oneShot ? null : h('button', { class: 'cb-btn rx-btn', type: 'button', onclick: function () { teardownRace(); showSetup(); } }, icon('settings', 16), 'Change setup'),
      oneShot ? null : backBtn,
      routedBackBtn(),
      hasReplay ? h('button', { class: 'cb-btn rx-btn', type: 'button', 'data-act': 'replay', title: 'Broadcast replay with timeline, cameras and event markers', onclick: function () { openReplay(R, false); } }, icon('film', 16), 'Watch replay') : null,
      hasReplay ? h('button', { class: 'cb-btn rx-btn', type: 'button', 'data-act': 'photo', title: 'Free camera, filters and PNG export', onclick: function () { openReplay(R, true); } }, icon('camera', 16), 'Photo mode') : null,
      h('span', { class: 'rx-spacer' }),
      h('span', { class: 'rx-dim rx-res-keys', style: { 'font-size': 'var(--fs-sm)' } }, kbd('Enter'), oneShot ? ' continue' : ' race again · ', oneShot ? null : kbd('Esc'), oneShot ? null : ' setup'),
      again);

    U.host.appendChild(h('div', { class: 'rx-results' }, head, main, foot));
    var draw = function () {
      try { drawLapChart(lapCv, myLaps, compare ? (R.tracker.cars[compare.id] || { laps: [] }).laps : null, compare ? compare.color : null, pb && pb.time); } catch (e) { /* ignore */ }
      if (posCv) { try { drawPositionChart(posCv, myTrack, total, gridPos, myRow && myRow.status === 'finished' ? myRow.position : null); } catch (e2) { /* ignore */ } }
    };
    U.resultsRedraw = draw;
    requestAnimationFrame(draw);
    try { again.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    void snap;
  }

  /** Routed free play: a "Back to <where you came from>" button next to "Tune car · Garage" (unless that is where we came from). */
  function routedBackBtn() {
    if (!U || !U.layer || isGameLaunch()) return null;
    if (routeName(U.opts._from || RT.from) === 'atelier') return null;
    return h('button', { class: 'cb-btn rx-btn ghost', type: 'button', onclick: close }, icon('back', 16), backLabel());
  }
  function num0(v) { return isNum(+v) ? +v : 0; }
  /** "New best score" / "Best: N pts" chip for the drift results header (scores only — never lap times). */
  function driftRecordBadge(dr, total) {
    if (!dr) return null;
    if (dr.trackRecord || dr.buildBest) {
      var prev = dr.trackRecord ? dr.prevTrack : dr.prevBuild;
      return h('span', { class: 'rx-badge purple', 'data-drift-record': dr.trackRecord ? 'track' : 'build' }, icon('trophy', 14),
        (dr.trackRecord ? 'New best score' : 'Build best score') + (prev && isNum(prev.score) ? ' · +' + fmtPts(total - prev.score) : ''));
    }
    var best = dr.prevTrack || dr.prevBuild;
    return best && isNum(best.score) ? h('span', { class: 'rx-badge', 'data-drift-record': 'none' }, icon('star', 14), 'Your best ' + fmtPts(best.score) + ' pts') : null;
  }
  /** Results screen for drift runs: score, medal ladder, run stats, tandem stats, replay buttons. */
  function showDriftResults(raw, res, myRow) {
    var R = U.race, S = R.settings, d = raw.drift || {};
    setScreen('results');
    clear(U.host);
    var medal = d.medal || null, total = num0(d.total);
    var bd = d.bestDrift, bdPts = bd && typeof bd === 'object' ? bd.points : bd;
    var targets = d.targets || null;
    var modeName = pick(DRIFT_MODES, raw.driftMode || S.driftMode).name;
    var head = h('header', { class: 'rx-res-head' },
      h('div', { class: 'rx-res-title' },
        h('div', { class: 'rx-eyebrow accent mx-kicker', text: (R.def.name || '') + ' · Drift · ' + modeName }),
        h('div', { class: 'rx-drift-score' },
          h('div', { class: 'rx-drift-total rx-num', text: fmtPts(total) }),
          medal ? h('span', { class: 'rx-medal', style: { color: MEDAL_COLORS[medal] || '#fff' } }, h('i'), medal)
                : h('span', { class: 'rx-medal', style: { color: 'var(--rx-dim)' } }, 'No medal'),
          driftRecordBadge(R.driftRecord, total)),
        h('div', { class: 'rx-dim', text: ((U.build.meta && U.build.meta.name) || 'Your build') + ' · ' + pick(DRIFT_TUNES, raw.tuneLevel || S.driftTune).name + ' tune · ' +
          pick(STEER_ASSISTS, raw.assistLevel || S.steerAssist).name + ' assist · ' + pick(WEATHERS, S.weather).name })));
    var ladder = null;
    if (targets) {
      ladder = h('div', { class: 'rx-ladder' }, ['bronze', 'silver', 'gold', 'platinum'].map(function (k) {
        var tv = Array.isArray(targets) ? null : targets[k];
        if (!isNum(tv)) return null;
        return h('div', { class: total >= tv ? 'got' : '', style: { color: MEDAL_COLORS[k] } }, h('b', { text: k }), h('span', { class: 'rx-num', style: { color: 'var(--rx-text)' }, text: fmtPts(tv) }));
      }));
    }
    var next = null;
    if (targets && !Array.isArray(targets)) {
      var order = ['bronze', 'silver', 'gold', 'platinum'];
      for (var i = 0; i < order.length; i++) if (isNum(targets[order[i]]) && total < targets[order[i]]) { next = { medal: order[i], need: targets[order[i]] }; break; }
    }
    var tile = function (l, v, cls) { return h('div', { class: 'rx-tile' + (cls ? ' ' + cls : '') }, h('div', { class: 'rx-stat-l', text: l }), h('div', { class: 'rx-stat-v rx-num', text: v })); };
    var tiles = h('div', { class: 'rx-res-tiles' },
      tile('Best drift' + (bd && bd.grade ? ' · ' + bd.grade : ''), fmtPts(bdPts), 'accent'),
      tile('Longest drift', num0(d.longestDrift_s).toFixed(1) + ' s'),
      tile('Max angle', Math.round(num0(d.maxAngle_deg)) + '°'),
      tile('Max combo', '×' + (+(d.maxCombo || d.maxMultiplier || 1)).toFixed(1), 'purple'),
      tile('Clipping zones hit', Math.round(num0(d.zonesHitPct)) + '%'),
      tile('Drifts', fmtPts(d.drifts)),
      d.transitions != null ? tile('Transitions', fmtPts(d.transitions)) : null,
      d.wallHits != null ? tile('Wall hits', fmtPts(d.wallHits), d.wallHits ? '' : 'accent') : null,
      tile('Run time', fmtTime(raw.elapsed_s, '—')),
      myRow && isNum(myRow.bestLap_s) ? tile('Best lap', fmtTime(myRow.bestLap_s)) : null);
    var tandem = null;
    if (raw.tandem) {
      var tdm = raw.tandem;
      tandem = h('div', { class: 'rx-panel rx-drift-panel' },
        h('div', { class: 'rx-section-title' }, h('h3', null, h('span', { class: 'rx-skew' }), 'Tandem battle')),
        h('div', { class: 'rx-res-tiles' },
          tile('Average distance', isNum(tdm.avgDist_m) ? tdm.avgDist_m.toFixed(1) + ' m' : '—'),
          tile('Closest', isNum(tdm.minDist_m) ? tdm.minDist_m.toFixed(1) + ' m' : '—'),
          tile('Close-chase time', num0(tdm.close_s).toFixed(1) + ' s', 'accent'),
          tile('Lead driver', tdm.driftAi ? 'Drift AI' : 'Race AI')));
    }
    var nextBox = next ? h('div', { class: 'rx-panel rx-drift-panel' },
      h('div', { class: 'rx-stat-l', text: 'Next: ' + next.medal }),
      h('div', { class: 'rx-num', style: { 'font-size': 'var(--fs-xl)', 'font-weight': '800' }, text: fmtPts(next.need - total) + ' pts to go' }),
      h('div', { class: 'rx-drift-bar' }, h('i', { style: { width: Math.round(clamp(total / next.need, 0, 1) * 100) + '%' } }))) : null;
    var main = h('div', { class: 'rx-res-main' },
      h('div', { class: 'rx-panel rx-drift-panel rx-scroll' },
        h('div', { class: 'rx-section-title' }, h('h3', null, h('span', { class: 'rx-skew' }), 'Run summary')), ladder, tiles),
      h('div', { class: 'rx-res-side rx-scroll' }, nextBox, tandem));

    var oneShot = oneShotLaunch();
    var backBtn = h('button', { class: 'cb-btn rx-btn' + (oneShot ? ' primary big' : ''), type: 'button', onclick: isGameLaunch() ? close : goAtelier }, icon(isGameLaunch() ? 'back' : 'wrench', 16), isGameLaunch() ? (oneShot ? ((U.opts && U.opts.continueLabel) || 'Continue · rewards') : backLabel()) : 'Tune car · Garage');
    var again = oneShot ? backBtn : h('button', { class: 'cb-btn rx-btn primary big', type: 'button', onclick: startRace }, icon('restart', 16), 'Go again');
    var hasReplay = !!(R.replay && replayMod());
    var foot = h('footer', { class: 'rx-res-foot' },
      oneShot ? null : h('button', { class: 'cb-btn rx-btn', type: 'button', onclick: function () { teardownRace(); showSetup(); } }, icon('settings', 16), 'Change setup'),
      oneShot || isGameLaunch() ? null : h('button', { class: 'cb-btn rx-btn', type: 'button', onclick: function () { switchDiscipline('race'); } }, icon('flag', 16), 'Switch to racing'),
      oneShot ? null : backBtn,
      routedBackBtn(),
      hasReplay ? h('button', { class: 'cb-btn rx-btn', type: 'button', 'data-act': 'replay', onclick: function () { openReplay(R, false); } }, icon('film', 16), 'Watch replay') : null,
      hasReplay ? h('button', { class: 'cb-btn rx-btn', type: 'button', 'data-act': 'photo', onclick: function () { openReplay(R, true); } }, icon('camera', 16), 'Photo mode') : null,
      h('span', { class: 'rx-spacer' }),
      h('span', { class: 'rx-dim rx-res-keys', style: { 'font-size': 'var(--fs-sm)' } }, kbd('Enter'), oneShot ? ' continue' : ' go again · ', oneShot ? null : kbd('Esc'), oneShot ? null : ' setup'),
      again);
    U.host.appendChild(h('div', { class: 'rx-results' }, head, main, foot));
    U.resultsRedraw = null;
    try { again.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    void res;
  }

  function pickCompareCar(rows, myRow, R) {
    if (!rows.length) return null;
    var cand = null;
    if (myRow && myRow.position !== 1) cand = rows[0];
    else if (rows.length > 1) cand = rows[1];
    if (cand && cand.isPlayer) cand = null;
    if (cand && (!R.tracker.cars[cand.id] || !R.tracker.cars[cand.id].laps.length)) return null;
    return cand;
  }

  function drawLapChart(canvas, laps, rival, rivalColor, pbTime) {
    var f = fitCanvas(canvas), ctx = f.ctx, W = f.w, H = f.h;
    ctx.clearRect(0, 0, W, H);
    var acc = accentColor();
    if (!laps || !laps.length) {
      ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.font = '600 12px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('No completed laps', W / 2, H / 2);
      return;
    }
    var all = laps.map(function (l) { return l.time; });
    if (rival) rival.forEach(function (l) { all.push(l.time); });
    // robust range: ignore huge outliers (e.g. spun laps) beyond 1.6x median
    var sorted = all.slice().sort(function (a, b) { return a - b; });
    var med = sorted[Math.floor(sorted.length / 2)];
    var cap = med * 1.6;
    var lo = sorted[0], hi = Math.min(sorted[sorted.length - 1], cap);
    if (hi - lo < 0.5) { hi += 0.5; lo -= 0.5; }
    var padT = (hi - lo) * 0.15; lo -= padT; hi += padT;
    var nLaps = Math.max(laps.length, rival ? rival.length : 0);
    var L = 58, Rm = 14, T = 10, B = 24;
    function X(i) { return L + (nLaps <= 1 ? (W - L - Rm) / 2 : i * (W - L - Rm) / (nLaps - 1)); }
    function Y(t) { return T + (1 - (Math.min(t, hi) - lo) / (hi - lo)) * (H - T - B); }
    // grid
    ctx.font = '10px ui-monospace,Menlo,monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var g = 0; g <= 4; g++) {
      var tv = lo + (hi - lo) * g / 4, y = Y(tv);
      ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L, Math.round(y) + 0.5); ctx.lineTo(W - Rm, Math.round(y) + 0.5); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.fillText(fmtTime(tv).replace(/^0:/, ''), L - 8, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var i = 0; i < nLaps; i++) {
      if (nLaps > 16 && i % Math.ceil(nLaps / 12) !== 0) continue;
      ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.fillText('L' + (i + 1), X(i), H - B + 7);
    }
    // personal best reference
    if (isNum(pbTime) && pbTime >= lo && pbTime <= hi) {
      ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(200,162,74,.5)';
      ctx.beginPath(); ctx.moveTo(L, Y(pbTime)); ctx.lineTo(W - Rm, Y(pbTime)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(200,162,74,.8)'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText('PB', W - Rm, Y(pbTime) - 2);
    }
    function series(list, color, width, dots, label) {
      if (!list || !list.length) return;
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round';
      ctx.beginPath();
      if (list.length === 1) { var y1 = Y(list[0].time); ctx.moveTo(L, y1); ctx.lineTo(W - Rm, y1); }   // one lap: a level line, not a lone dot
      else list.forEach(function (l, j) { var x = X(j), y = Y(l.time); if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
      if (label) {
        var ly = Y(list[list.length - 1].time);
        ctx.fillStyle = color; ctx.font = '700 10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(label, L + 4, (list.length === 1 ? ly : Y(list[0].time)) - 4);
        ctx.font = '10px ui-monospace,Menlo,monospace';
      }
      if (dots) {
        var best = Infinity;
        list.forEach(function (l) { if (l.valid && l.time < best) best = l.time; });
        list.forEach(function (l, j) {
          var x = X(j), y = Y(l.time);
          ctx.beginPath(); ctx.arc(x, y, l.time === best ? 5 : 3.5, 0, Math.PI * 2);
          if (!l.valid) { ctx.strokeStyle = '#ff4d4d'; ctx.lineWidth = 1.6; ctx.fillStyle = '#111'; ctx.fill(); ctx.stroke(); }
          else { ctx.fillStyle = l.time === best ? '#b26bff' : color; ctx.fill(); }
          if (l.time > hi) { ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('↑', x, y - 6); }
        });
      }
    }
    if (rival) series(rival, rivalColor || 'rgba(140,145,155,.7)', 1.5, false);
    // area under the player line
    var grad = ctx.createLinearGradient(0, T, 0, H - B);
    grad.addColorStop(0, 'rgba(200,162,74,.22)'); grad.addColorStop(1, 'rgba(200,162,74,0)');
    ctx.beginPath();
    if (laps.length === 1) { var ay = Y(laps[0].time); ctx.moveTo(L, ay); ctx.lineTo(W - Rm, ay); ctx.lineTo(W - Rm, H - B); ctx.lineTo(L, H - B); }
    else {
      laps.forEach(function (l, j) { var x = X(j), y = Y(l.time); if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.lineTo(X(laps.length - 1), H - B); ctx.lineTo(X(0), H - B);
    }
    ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    series(laps, acc, 2.2, true, laps.length === 1 ? 'You' : null);
  }

  function drawPositionChart(canvas, track, total, gridPos, finalPos) {
    var f = fitCanvas(canvas), ctx = f.ctx, W = f.w, H = f.h;
    ctx.clearRect(0, 0, W, H);
    var pts = [];
    if (isNum(gridPos)) pts.push(gridPos);
    if (track) track.positions.forEach(function (p) { if (isNum(p)) pts.push(p); });
    // the finish point is the classified position (time penalties applied), so the chart matches the table
    if (isNum(finalPos) && pts.length >= 2) pts[pts.length - 1] = finalPos;
    if (pts.length < 2) {
      ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.font = '600 12px system-ui'; ctx.textAlign = 'center'; ctx.fillText('Not enough laps', W / 2, H / 2);
      return;
    }
    var L = 40, Rm = 14, T = 10, B = 18;
    function X(i) { return L + i * (W - L - Rm) / (pts.length - 1); }
    function Y(p) { return T + (p - 1) / Math.max(1, total - 1) * (H - T - B); }
    ctx.font = '10px ui-monospace,Menlo,monospace'; ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    [1, Math.ceil(total / 2), total].forEach(function (p) {
      ctx.fillText('P' + p, L - 8, Y(p));
      ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.moveTo(L, Y(p)); ctx.lineTo(W - Rm, Y(p)); ctx.stroke();
    });
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('Grid', X(0), H - B + 5);
    ctx.fillText('Finish', X(pts.length - 1), H - B + 5);
    ctx.strokeStyle = accentColor(); ctx.lineWidth = 2.2;
    ctx.beginPath();
    pts.forEach(function (p, i) {
      var x = X(i), y = Y(p);
      if (!i) ctx.moveTo(x, y); else { ctx.lineTo(x, Y(pts[i - 1])); ctx.lineTo(x, y); }
    });
    ctx.stroke();
    pts.forEach(function (p, i) { ctx.beginPath(); ctx.arc(X(i), Y(p), 3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); });
  }

  /* ======================================================================
     ERROR screen
     ====================================================================== */
  function showError(message, detail) {
    if (!U) return;
    var R = U.race;
    if (R) { R.running = false; cancelAnimationFrame(R.raf); R.simActive = false; }
    setScreen('error');
    clear(U.host);
    var card = h('div', { class: 'rx-panel rx-error' },
      h('div', { class: 'rx-eyebrow', style: { color: 'var(--rx-bad)' } }, 'Race mode'),
      h('h2', { class: 'rx-display', style: { margin: '6px 0 10px', 'font-size': 'var(--fs-2xl)' }, text: 'Something went wrong' }),
      h('p', { text: message }),
      detail ? h('pre', { text: String(detail).split('\n').slice(0, 12).join('\n') }) : null,
      h('div', { style: { display: 'flex', gap: '10px', 'margin-top': '14px' } },
        U.opts && U.opts.net ? h('button', { class: 'cb-btn rx-btn primary', type: 'button', onclick: netLeave }, icon('back', 14), 'Back to lobby')
          : h('button', { class: 'cb-btn rx-btn primary', type: 'button', onclick: function () { teardownRace(); showSetup(); } }, icon('back', 14), 'Back to setup'),
        U.opts && U.opts.net ? null : h('button', { class: 'cb-btn rx-btn', type: 'button', onclick: close }, backLabel())));
    U.host.appendChild(h('div', { class: 'rx-modal' }, card));
  }

  /* ======================================================================
     Teardown
     ====================================================================== */
  function teardownRace() {
    if (!U || !U.race) return;
    var R = U.race;
    U.race = null;
    R.running = false;
    if (R.raf) cancelAnimationFrame(R.raf);
    pluginCall('detach', [R]);
    if (R.net) netClose(R, true);   // left without the results button (nav, route change): still hand back to the lobby
    if (R.hintsTimer) clearTimeout(R.hintsTimer);
    learnAutoQuality(R);
    [R.dsfx, R.dhud, R.hud, R.renderer, R.audio, R.session].forEach(function (m) {
      if (m && typeof m.destroy === 'function') { try { m.destroy(); } catch (e) { /* ignore */ } }
    });
    if (R.input) R.input.reset();
    U.pauseRefs = null; U.loadingRefs = null; U.resultsRedraw = null;
    try { var ctx = U.canvas.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, U.canvas.width, U.canvas.height); } catch (e2) { /* ignore */ }
  }

  /* ======================================================================
     Router screens (UNIFY-SPEC): #/race (race setup -> 3D race) and #/drift (drift setup -> 3D drift).
     CB.router.on(route, enter, leave): enter receives the screen layer (Element, or {layer|el, params}) and the
     route params; leave tears the session down. CB.race.ui.open() stays as a wrapper that routes.
     ====================================================================== */
  var RT = { registered: null, mounted: null, pending: null, from: null, navigating: false };
  function routerApi() { var r = CB.router; return r && typeof r.on === 'function' && typeof r.go === 'function' ? r : null; }
  /** '#/race?quick=1', '/race', {route:'race'} -> 'race' */
  function routeName(v) {
    if (v && typeof v === 'object') v = v.route || v.name || v.path || v.id || '';
    return String(v || '').replace(/^#/, '').replace(/^\/+/, '').split(/[?#]/)[0].split('/')[0];
  }
  function routerCurrent() {
    var r = routerApi();
    try { return r && typeof r.current === 'function' ? r.current() : null; } catch (e) { return null; }
  }
  function goRoute(target) {
    var r = routerApi();
    if (!r || target == null) return false;
    try {
      // {route, sub, params} (router.current()) goes through whole so sub-screens survive (#/career/championship?id=...)
      if (typeof target === 'object') r.go(target.route || target.name ? { route: target.route || target.name, sub: target.sub != null ? target.sub : null, params: target.params } : target.path, target.route || target.name ? undefined : target.params);
      else r.go(String(target).replace(/^#\/?/, ''));
      return true;
    } catch (e) { if (typeof console !== 'undefined') console.warn('[race-ui] router.go', e); return false; }
  }
  /** Navigate back to where race mode was entered from (results "always return to where you came from"). */
  function routeBack() {
    var o = (U && U.opts) || {};
    var back = o.returnTo || o._from || RT.from;
    if (!back || routeName(back) === U.route || routeName(back) === 'race' || routeName(back) === 'drift' || routeName(back) === 'arcade') back = isGameLaunch() ? 'career' : 'menu';
    return goRoute(back);
  }
  function goAtelier() { if (U && U.layer && goRoute('atelier')) return; close(); }
  function goMenu() { if (U && U.layer && goRoute('menu')) return; close(); }
  function layerOf(args, route) {
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (a && a.nodeType === 1) return a;
      if (a && typeof a === 'object' && a.layer && a.layer.nodeType === 1) return a.layer;
      if (a && typeof a === 'object' && a.el && a.el.nodeType === 1) return a.el;
    }
    var r = routerApi();
    try { if (r && typeof r.layer === 'function') { var l = r.layer(route); if (l && l.nodeType === 1) return l; } } catch (e) { /* ignore */ }
    var appRoot = document.getElementById('app-root');
    if (appRoot) {
      var ex = appRoot.querySelector('[data-route="' + route + '"]') || document.getElementById('screen-' + route);
      if (ex) return ex;
      var made = h('section', { class: 'cb-screen', 'data-route': route, style: { position: 'absolute', inset: '0' } });
      appRoot.appendChild(made);
      return made;
    }
    return null;
  }
  function paramsOf(args) {
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (!a || typeof a !== 'object' || a.nodeType === 1) continue;
      if (isPlain(a.params)) return a.params;
      if (!a.layer && !a.el) return a;
    }
    return {};
  }
  function truthyParam(v) { return v != null && v !== false && v !== '0' && v !== 'false' && v !== 0; }
  /** The car is ALWAYS the configurator's current build (CB.state) unless a career / challenge launch hands one over. */
  function stateBuild() {
    try { if (CB.state && typeof CB.state.get === 'function') { var b = CB.state.get(); if (isPlain(b) && b.engine) return b; } } catch (e) { /* ignore */ }
    return null;
  }
  function enterRoute(route, args) {
    if (!hasDOM) return;
    var params = Object.assign({}, paramsOf(args) || {});
    try {   // '#/race?quick=1&track=forge-ring' (deep links) when the router does not hand us params
      var q = String(location.hash || '').split('?')[1];
      if (q && routeName(location.hash) === route) q.split('&').forEach(function (kv) {
        var i = kv.indexOf('='), k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i)), v = i < 0 ? '1' : decodeURIComponent(kv.slice(i + 1));
        if (k && params[k] === undefined) params[k] = v;
      });
    } catch (eQ) { /* ignore */ }
    var p = RT.pending;
    RT.pending = null;
    if (p && p.route !== route) p = null;
    if (U && U.layer && RT.mounted === route && !p) return;   // duplicate enter (e.g. 'race' and '/race' both registered)
    var layer = layerOf(args, route);
    RT.mounted = route;
    var build, opts;
    if (p) { build = p.build; opts = p.opts; }
    else {
      build = stateBuild();
      opts = { settings: {} };
      if (truthyParam(params.quick)) opts.autoStart = true;
      if (typeof params.track === 'string' && params.track) opts.settings.trackId = params.track;
      if (typeof params.mode === 'string') {
        if (route === 'drift' && ids(DRIFT_MODES).indexOf(params.mode) >= 0) opts.settings.driftMode = params.mode;
        else if (route === 'race' && ids(MODES).indexOf(params.mode) >= 0) opts.settings.mode = params.mode;
        else if (route === 'arcade' && (params.mode === 'race' || params.mode === 'time-trial')) opts.settings.mode = params.mode;
      }
      if (typeof params.assist === 'string' && ids(STEER_ASSISTS).indexOf(params.assist) >= 0) opts.settings.steerAssist = params.assist;
      if (typeof params.tune === 'string' && ids(DRIFT_TUNES).indexOf(params.tune) >= 0) opts.settings.driftTune = params.tune;
      var deep = {}, anyDeep = false;
      for (var dk in opts.settings) if (has(opts.settings, dk)) { deep[dk] = opts.settings[dk]; anyDeep = true; }
      if (anyDeep) opts._deepLink = deep;   // one-off deep-link settings: never saved as the player's defaults
    }
    opts._layer = layer; opts._route = route;
    if (!opts._from) opts._from = RT.from;
    if (!(opts.context && opts.context.kind)) {   // free play: the route decides the discipline (applied via setDiscipline)
      if (opts.settings && opts.settings.discipline) { opts.settings = Object.assign({}, opts.settings); delete opts.settings.discipline; }
      opts.discipline = route;
    }
    try { mount(build || (p && p.build), opts); }
    catch (e) { if (typeof console !== 'undefined') console.error('[race-ui] route enter', e); }
    if (!p) consumeDeepLink(route, params);
    if (route === 'drift' && !driftMod() && U) toast(icon('warn', 14), 'Drift modules are not loaded · race setup shown');
  }
  /** Once ?quick / ?track / ?mode / ?assist have been read, put the plain #/race (#/drift) back in the address bar
      so a reload or "Change setup" does not auto-start the deep-linked session again. */
  function consumeDeepLink(route, params) {
    if (!hasDOM || !params) return;
    if (params.quick == null && params.track == null && params.mode == null && params.assist == null && params.tune == null) return;
    try {
      var hsh = String(location.hash || '');
      if (hsh.indexOf('?') < 0 || routeName(hsh) !== route) return;
      var clean = '#/' + route;
      if (history && typeof history.replaceState === 'function') history.replaceState(history.state, '', clean);
    } catch (e) { /* some file:// setups block the History API: leave the URL alone */ }
  }
  function leaveRoute(route) {
    if (RT.mounted !== route) return;
    RT.mounted = null;
    if (U && U.layer) destroy();
  }
  /** Register #/race and #/drift with CB.router (idempotent; called at load, on DOMContentLoaded and on 'cb:router-ready'). */
  function registerRoutes(r) {
    r = r && typeof r.on === 'function' ? r : routerApi();
    if (!r || RT.registered === r) return !!r;
    RT.registered = r;
    ['race', 'drift', 'arcade'].forEach(function (route) {
      try {
        r.on(route, function () { enterRoute(route, Array.prototype.slice.call(arguments)); }, function () { leaveRoute(route); });
      } catch (e) { if (typeof console !== 'undefined') console.warn('[race-ui] router.on(' + route + ')', e); }
    });
    // remember the last non-driving route so "Back" returns there
    try {
      if (typeof window !== 'undefined') window.addEventListener('hashchange', function (e) {
        var prev = e && e.oldURL ? String(e.oldURL).split('#')[1] || '' : '';
        var n = routeName(prev);
        if (n && n !== 'race' && n !== 'drift' && n !== 'arcade') RT.from = prev.replace(/^\/+/, '');
      });
    } catch (e2) { /* ignore */ }
    // the router may already sit on #/race or #/drift (deep link) before we registered: mount it ourselves
    setTimeout(function () {
      var n = routeName(routerCurrent());
      if ((n === 'race' || n === 'drift' || n === 'arcade') && !RT.mounted && !U) {
        var cur = routerCurrent();
        enterRoute(n, [cur && typeof cur === 'object' && isPlain(cur.params) ? cur.params : {}]);
      }
    }, 0);
    return true;
  }
  /** Public open(): with a router, route to #/race or #/drift carrying the launch; standalone pages keep the overlay. */
  function open(build, opts, callbacks) {
    var o = launchOf(opts, callbacks);
    if (o.netSession && !o.net) {   // open(build, cfgOverrides, {netSession}) == openNet(session, cfgOverrides + build)
      var nc = {}, nk; for (nk in o) if (has(o, nk) && nk !== 'netSession') nc[nk] = o[nk];
      if (!nc.build) nc.build = build;
      return openNet(o.netSession, nc);
    }
    var r = routerApi();
    if (r && !o._layer && o.overlay !== true) {
      registerRoutes(r);
      var want = o.discipline === 'arcade' ? 'arcade' : o.discipline === 'drift' || (o.settings && o.settings.discipline === 'drift') ? 'drift' : 'race';
      if (!(o.context && o.context.kind) && !(o.settings && o.settings.discipline) && !o.discipline) want = 'race';
      var cur = routerCurrent(), curName = routeName(cur);
      if (curName && curName !== 'race' && curName !== 'drift' && curName !== 'arcade') { o._from = cur; RT.from = cur; }
      RT.pending = { route: want, build: build, opts: o };
      if (U && U.layer && curName === want) { RT.pending = null; o._layer = U.layer; o._route = want; mount(build, o); return api; }
      if (goRoute(want)) {
        if (RT.pending && curName === want) enterRoute(want, []);   // router ignored a same-route go
        var pend = RT.pending;
        // hash routers may enter on the next 'hashchange'; if nothing mounts soon, fall back to the overlay
        if (pend) setTimeout(function () { if (RT.pending === pend) { RT.pending = null; if (typeof console !== 'undefined') console.warn('[race-ui] #/' + want + ' did not mount; using overlay'); mount(pend.build, pend.opts); } }, 700);
        return api;
      }
      RT.pending = null;
    }
    mount(build, o);
    return api;
  }
  if (hasDOM) {
    registerRoutes();
    try { document.addEventListener('DOMContentLoaded', function () { registerRoutes(); }); } catch (eR) { /* ignore */ }
    try { document.addEventListener('cb:router-ready', function (e) { registerRoutes(e && e.detail && e.detail.router); }); } catch (eR2) { /* ignore */ }
  }

  /* ======================================================================
     window.drift — the drift test / debug hooks (drift.html parity; drift.html now redirects to index.html#/drift)
       drift.start(cfg)   cfg: { mode 'drift'|'race'|'free'|'trial'|'tandem', driftMode, trackId, assist, tune, car ('drift' |
                          preset id), tod, weather, view '3d'|'2d', quality, camera, laps, opponents, difficulty, duration_s,
                          startDelay_s, seed } -> builds the session synchronously on #/drift (#/race) and drives -> session
       drift.step(n, dt)  advance n frames of dt (default 1/60) without rAF (works in background tabs) -> state()
       drift.setInput(o)  force intent keys { left, right, up, down, handbrake } (null clears)
       drift.state()      compact JSON-able state;  drift.tick(dt) · restart() · pause() · resume() · menu() · setup(mode) · showResults()
     ====================================================================== */
  /** Forced test keys over the frame's input (raw intent for assisted sessions, engine input for the plain engine). */
  function forcedInput(R, base) {
    var f = R.forced || {}, o = {}, k;
    for (k in base) if (has(base, k)) o[k] = base[k];
    if (R.rawInput) { for (k in f) if (has(f, k)) o[k] = f[k]; return o; }
    if (has(f, 'up')) o.throttle = f.up ? 1 : 0;
    if (has(f, 'down')) o.brake = f.down ? 1 : 0;
    if (has(f, 'left') || has(f, 'right')) o.steer = ((f.left ? 1 : 0) - (f.right ? 1 : 0)) * ((R.input && R.input.leftSign) || 1);
    if (has(f, 'handbrake')) o.handbrake = !!f.handbrake;
    return o;
  }
  function hookBuild(car) {
    var DS = CB.race && CB.race.drift && CB.race.drift.session;
    try {
      if (car === 'drift' && DS && typeof DS.driftPresetBuild === 'function') return DS.driftPresetBuild();
      if (typeof car === 'string' && CB.data && typeof CB.data.presetBuild === 'function') {
        var b = CB.data.presetBuild(car);
        if (b) return CB.state && typeof CB.state.normalize === 'function' ? CB.state.normalize(b) : b;
      }
      if (isPlain(car)) return car;
    } catch (e) { /* the current build stays */ }
    return null;
  }
  function hookStart(cfg) {
    if (!hasDOM) return null;
    var c = isPlain(cfg) ? cfg : {};
    var arcadeRun = c.mode === 'arcade' || c.arcade === true;
    var race = c.mode === 'race' || arcadeRun, route = arcadeRun ? 'arcade' : race ? 'race' : 'drift';
    if (route === 'drift' && !driftMod()) return null;
    if (!U || !U.layer || U.route !== route) {
      goRoute(route);
      if (!U || U.route !== route) enterRoute(route, []);
    }
    if (!U) return null;
    var S = U.settings, dl = {};
    function set(k, v) { if (v === undefined || v === null || v === '') return; S[k] = v; dl[k] = v; }
    var dm = c.driftMode || c.mode;
    if (!race && ids(DRIFT_MODES).indexOf(dm) >= 0) set('driftMode', dm);
    if (race) set('mode', arcadeRun && c.arcadeMode === 'time-trial' ? 'time-trial' : 'race');
    set('trackId', c.trackId || c.track);
    if (ids(STEER_ASSISTS).indexOf(c.assist) >= 0) set('steerAssist', c.assist);
    if (ids(DRIFT_TUNES).indexOf(c.tune) >= 0) set('driftTune', c.tune);
    set('timeOfDay', c.tod || c.timeOfDay); set('weather', c.weather); set('graphics', c.view); set('quality', c.quality);
    if (c.camera) set(race ? 'camera3d' : 'driftCamera3d', c.camera);
    if (isNum(c.laps)) set('laps', c.laps);
    if (isNum(c.opponents)) set('opponents', c.opponents);
    set('difficulty', c.difficulty);
    U.settings = sanitizeSettings(S);
    U.opts._deepLink = Object.assign({}, U.opts._deepLink || {}, dl);   // test settings never become the player's defaults
    if (c.car) {
      var b = hookBuild(c.car);
      if (b) { U.build = resolveBuild(b); U.metricsInfo = computeMetrics(U.build); U.hash = buildHash(U.build); }
    }
    startRace({ immediate: true, cfg: c });
    return U && U.race ? U.race.session : null;
  }
  function hookStep(n, dt) {
    var R = U && U.race;
    if (!R) return hookState();
    var ms = (isNum(dt) && dt > 0 ? dt : 1 / 60) * 1000, t = R.last || (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (var i = 0; i < (n || 1); i++) {
      if (!U || U.race !== R || !R.running) break;
      t += ms;
      cancelAnimationFrame(R.raf);
      frame(t);
    }
    return hookState();
  }
  function hookState() {
    var R = U && U.race, s = R && R.session, snap = null;
    try { snap = R ? (R.lastSnap || (s && s.snapshot())) : null; } catch (e) { snap = null; }
    var d = snap && snap.drift, me = snap ? playerCar(snap) : null, sc = d && d.scorer, res = R && R.rawResults;
    function call(fn, dflt) { try { return s && typeof s[fn] === 'function' ? s[fn]() : dflt; } catch (e) { return dflt; } }
    var scr = !U ? null : U.screen === 'race' ? (R && R.paused ? 'pause' : 'play') : U.screen;
    return {
      screen: scr, route: U ? U.route : null, paused: !!(R && R.paused), mode: U ? (U.settings.discipline === 'drift' ? 'drift' : U.settings.discipline === 'arcade' ? 'arcade' : 'race') : null,
      handling: snap && snap.handling ? snap.handling : null,
      driftMode: s && s.mode ? s.mode : U ? U.settings.driftMode : null, trackId: R && R.def ? R.def.id : U ? U.settings.trackId : null,
      assist: call('getAssistLevel', U ? U.settings.steerAssist : null), tune: call('getTuneLevel', U ? U.settings.driftTune : null), phase: call('getPhase', null),
      t: snap ? snap.t : 0, elapsed_s: d ? d.elapsed_s : 0, timeLeft_s: d ? d.timeLeft_s : null, countdown_s: d ? d.countdown_s : 0, finished: !!(d && d.finished),
      camera: R && R.renderer && R.renderer.getCamera ? R.renderer.getCamera() : null, renderer: R ? (R.is3d ? '3d' : R.fallbackRenderer ? 'fallback' : '2d') : null,
      gfx: R && R.is3d && R.renderer && R.renderer.getQuality ? { quality: R.renderer.getQuality(), setting: U.settings.quality, start: R.aq ? R.aq.start : null,
                     startup: R.aq && R.aq.startup ? R.aq.startup : null, fps: R.renderer.stats ? R.renderer.stats().fps : null } : null,
      player: me ? { x: me.x, y: me.y, heading: me.heading, speed_kph: me.speed * 3.6, gear: me.gear, lap: me.lap, s: me.s, lateral: me.lateral,
                     surface: me.surface, position: me.position, angle_deg: d && d.player ? d.player.angle_deg : null,
                     beta_deg: d && d.player && isNum(d.player.beta) ? d.player.beta / Math.PI * 180 : null, steer: me.steerAngle, throttle: me.throttle } : null,
      scorer: sc ? { total: sc.total, current: sc.current, multiplier: sc.multiplier, angle_deg: sc.angle_deg, grade: sc.grade, drifting: sc.drifting,
                     lastEvent: sc.lastEvent ? sc.lastEvent.text : null } : null,
      assistDebug: d ? d.assist : null, tandem: d ? d.tandem : null, cars: snap && snap.cars ? snap.cars.length : 0,
      results: res ? { total: res.drift ? res.drift.total : null, medal: res.drift ? res.drift.medal : null, position: res.player ? res.player.position : null } : null,
      input: R ? R.forced || null : null, dcam: R && R.dcam && typeof R.dcam.debug === 'function' ? R.dcam.debug() : null, fx: d ? d.fx : null,
      dhud: !!(R && R.dhud), zoneMarkers3d: !!(R && R.dhud && R.is3d && R.renderer && R.renderer.is3D)
    };
  }
  var driftHooks = {
    start: hookStart, step: hookStep, state: hookState,
    tick: function (dt) { return hookStep(1, dt); },
    setInput: function (o) { var R = U && U.race; var f = isPlain(o) ? Object.assign({}, o) : null; driftHooks._forced = f; if (R) R.forced = f; return f; },
    restart: function () { if (U && U.race) restartRace(); return hookState(); },
    pause: function () { if (U && U.race && U.screen === 'race') pauseRace(); return hookState(); },
    resume: function () { if (U && U.race && U.race.paused) resumeRace(); return hookState(); },
    menu: function () { if (U && U.race) teardownRace(); goMenu(); return hookState(); },
    setup: function (mode) {
      var route = mode === 'race' ? 'race' : mode === 'arcade' ? 'arcade' : mode ? 'drift' : (U && U.route) || 'drift';
      if (!U || U.route !== route) { goRoute(route); if (!U || U.route !== route) enterRoute(route, []); }
      if (U) { teardownRace(); showSetup(); }
      return hookState();
    },
    showResults: function () { if (U && U.race) endSession(); return hookState(); },
    _forced: null
  };
  api.driftHooks = driftHooks;
  if (hasDOM && typeof window !== 'undefined' && !window.drift) window.drift = driftHooks;

  /* ======================================================================
     Public API
     ====================================================================== */
  api.open = open;
  api.openNet = openNet;
  api.mount = mount;
  api.registerRoutes = registerRoutes;
  api.routes = { race: { enter: function () { enterRoute('race', Array.prototype.slice.call(arguments)); }, leave: function () { leaveRoute('race'); } },
                 drift: { enter: function () { enterRoute('drift', Array.prototype.slice.call(arguments)); }, leave: function () { leaveRoute('drift'); } },
                 arcade: { enter: function () { enterRoute('arcade', Array.prototype.slice.call(arguments)); }, leave: function () { leaveRoute('arcade'); } } };
  api.close = close;
  api.isOpen = isOpen;
  api.injectStyles = injectStyles;
  api.drawTrackMap = drawTrackMap;
  /** Dev/test hooks: drive frames manually (e.g. in a hidden tab where rAF is throttled). */
  api._dev = {
    state: function () { return U; },
    tick: function (ms, n) {
      if (!U || !U.race) return null;
      var R = U.race, t = R.last || performance.now();
      for (var i = 0; i < (n || 1); i++) { t += ms || 16.667; if (R.running) { cancelAnimationFrame(R.raf); frame(t); } }
      return R.lastSnap;
    },
    end: function () { if (U && U.race) endSession(); },
    pause: function () { if (U && U.race) pauseRace(); },
    go: function () { if (U && U.race && U.race.ready && U.screen === 'loading') { goRace(); return true; } return false; },
    resume: function () { if (U && U.race && U.race.paused) resumeRace(); },
    autopilot: function (on) { if (U && U.race && U.race.session && U.race.session.setPlayerAutopilot) U.race.session.setPlayerAutopilot(on !== false); },
    key: function (code, down) { if (U && U.race && U.race.input) U.race.input.handleKey(code, down !== false, false); }
  };
  api.getSettings = function () { return U ? deepClone(U.settings) : loadSettings(); };
  /** change saved settings from outside (the webcam wheel's "easy driving" preset): fn(settings) mutates; applied to the
      stored settings and to the open session's (its next race), each discipline's assist kept in sync */
  api.patchSettings = function (fn) {
    if (typeof fn !== 'function') return null;
    var st = loadSettings(); fn(st); syncAssist(st); saveSettings(sanitizeSettings(st));
    if (U && U.settings) { try { fn(U.settings); syncAssist(U.settings); } catch (e) { /* ignore */ } }
    return deepClone(st);
  };

  if (typeof module !== 'undefined') module.exports = CB.race.ui;
})();

if (typeof module !== 'undefined') module.exports = CB.race.ui;

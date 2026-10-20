/* ==========================================================================
   FORGE Atelier — js/game/hub.js
   CB.game.hub : full-screen main menu / career hub (#game-hub).

   Contract: docs/GAME-SPEC.md § Hub UI.

   Public API
     CB.game.hub.open(opts?)        opts { screen, params, standalone, onClose() }  -> api
     CB.game.hub.close()
     CB.game.hub.isOpen()
     CB.game.hub.show(screenId, params?, {replace})   navigate (pushes on the stack)
     CB.game.hub.back()
     CB.game.hub.refresh()          re-render current screen + header
     CB.game.hub.toast(msg, kind?)
     CB.game.hub.boot(opts?)        standalone boot used by hub.html
     CB.game.hub.screens            ids of every screen
     CB.game.hub.reportRaceResult(results, ctx)   manual integration entry point
     CB.game.hub._                  pure helpers (Node-testable)

   Screens
     title, menu, career, championship, briefing, rewards, trophies, event,
     quickrace, timetrial, challenges, garage, showroom, workshop,
     achievements, replays, profile, settings

   Dependencies — every one feature-detected at call time, with friendly
   fallbacks so the hub renders even when they are missing or partial:
     CB.game.profile / economy / career / achievements / challenges / replay
     CB.race.ui (open(build, cfgOverrides, {onFinish})), CB.race.tracks,
     CB.app.openAtelier({mode, carId, onConfirm(build)}),
     CB.render.thumbnail(build), CB.physics.compute(build), CB.data, CB.state

   Input
     Keyboard: arrows / WASD move focus spatially, Enter / Space activate,
     Esc / Backspace back, Q / E (or PageUp / PageDown) switch tabs.
     Gamepad (standard mapping): D-pad / left stick move, A select, B back,
     LB / RB tabs, Start = menu. Mouse & touch work everywhere.

   Pure logic loads in Node: no DOM touched until open().
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.game = CB.game || {};

(function () {
  'use strict';

  var hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined' &&
    typeof document.createElement === 'function';

  /* ======================================================================
     Generic helpers
     ====================================================================== */
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) {
    var n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return isNum(n) ? n : (d === undefined ? 0 : d);
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clone(v) {
    if (v === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function first() {
    for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
    return undefined;
  }
  function getPath(o, path) {
    if (o == null) return undefined;
    var parts = String(path).split('.');
    for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
    return o;
  }
  function hashStr(s) {
    s = String(s);
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  /** mulberry32 deterministic RNG. */
  function rng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function safe(fn, fallback) {
    try { var r = fn(); return r === undefined ? fallback : r; } catch (e) {
      if (typeof console !== 'undefined' && console.warn && safe.debug) console.warn('[hub]', e);
      return fallback;
    }
  }
  safe.debug = true;
  function call(obj, names, args, fallback) {
    if (!obj) return fallback;
    for (var i = 0; i < names.length; i++) {
      if (typeof obj[names[i]] === 'function') {
        var fn = obj[names[i]];
        return safe(function () { return fn.apply(obj, args || []); }, fallback);
      }
    }
    return fallback;
  }
  function arr(v) {
    if (Array.isArray(v)) return v;
    if (isObj(v)) return Object.keys(v).map(function (k) { var x = v[k]; if (isObj(x) && x.id == null) x = Object.assign({ id: k }, x); return x; });
    return [];
  }

  /* ----------------------------------------------------------- formatting */
  function fmtInt(n) {
    n = Math.round(num(n, 0));
    var s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '−' : '') + s;
  }
  function fmtCredits(n) {
    var E = eco();
    if (E && typeof E.formatCredits === 'function') { var r = safe(function () { return E.formatCredits(n); }, null); if (r) return r; }
    return 'CR ' + fmtInt(n);
  }
  function fmtCompact(n) {
    n = num(n, 0);
    var a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e4) return (n / 1e3).toFixed(0) + 'k';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  function fmtTime(s) {
    if (!isNum(s) || s <= 0) return '—';
    var m = Math.floor(s / 60), r = s - m * 60;
    var sec = r.toFixed(3);
    if (r < 10) sec = '0' + sec;
    return m + ':' + sec;
  }
  function fmtDuration(s) {
    s = Math.max(0, Math.round(num(s, 0)));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    if (h) return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
    if (m) return m + 'm ' + (x < 10 ? '0' : '') + x + 's';
    return x + 's';
  }
  function fmtDist(km, units) {
    km = num(km, 0);
    if (units === 'mph') return fmtInt(km * 0.621371) + ' mi';
    return (km < 100 ? km.toFixed(1) : fmtInt(km)) + ' km';
  }
  function fmtSpeed(kph, units) {
    kph = num(kph, 0);
    return units === 'mph' ? Math.round(kph * 0.621371) + ' mph' : Math.round(kph) + ' km/h';
  }
  function fmtDate(ms) {
    if (!isNum(ms)) return '—';
    var d = new Date(ms);
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + M[d.getMonth()] + ' ' + d.getFullYear();
  }
  function ordinal(n) {
    n = Math.round(num(n, 0));
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function pct(v, d) { return (num(v, 0) * 100).toFixed(d || 0) + '%'; }
  function conditionLabel(c) {
    c = clamp(num(c, 1), 0, 1);
    if (c >= 0.95) return { label: 'Showroom', kind: 'good' };
    if (c >= 0.8) return { label: 'Excellent', kind: 'good' };
    if (c >= 0.6) return { label: 'Worn', kind: 'warn' };
    if (c >= 0.35) return { label: 'Tired', kind: 'warn' };
    return { label: 'Critical', kind: 'bad' };
  }
  function titleCase(s) {
    return String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  /* ======================================================================
     Dependency accessors (resolved lazily — modules may load later)
     ====================================================================== */
  function prof() { return (CB.game && CB.game.profile) || null; }
  function eco() { return (CB.game && CB.game.economy) || null; }
  function career() { return (CB.game && CB.game.career) || null; }
  function achv() { return (CB.game && CB.game.achievements) || null; }
  function chal() { return (CB.game && CB.game.challenges) || null; }
  function rep() { return (CB.game && CB.game.replay) || null; }
  function raceUI() { return (CB.race && CB.race.ui && typeof CB.race.ui.open === 'function') ? CB.race.ui : null; }
  function tracksMod() { return (CB.race && CB.race.tracks) || null; }
  function appMod() { return (CB.app && typeof CB.app.openAtelier === 'function') ? CB.app : null; }

  /* In-memory profile used only when CB.game.profile is absent. */
  var memProfile = null;
  function fallbackProfile() {
    if (!memProfile) {
      memProfile = {
        version: 1, driverName: 'Driver', avatarColor: '#c8a96a', credits: 150000, xp: 0, level: 1, createdAt: Date.now(),
        ownedCars: [], activeCarId: null, unlocks: { parts: [], tracks: [], bodyStyles: [] }, career: {}, achievements: {},
        stats: { races: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, distance_km: 0, topSpeed_kph: 0, crashes: 0, creditsEarned: 0, driftScoreBest: 0, history: [], tracks: {} },
        settings: {
          units: 'kph', difficulty: 'amateur',
          assists: { abs: true, tc: true, autoShift: true, racingLine: false, steeringAssist: false },
          audio: { master: 0.8, engine: 0.9, sfx: 0.8, music: 0.5 },
          controls: { bindings: {} }, camera: 'chase',
          graphics: { quality: 'high', particles: true, shadows: true, skidmarks: true },
          gameplay: { defaultLaps: 3, defaultOpponents: 7, field: 'similar', weather: 'dry', timeOfDay: 'day' }
        },
        ledger: []
      };
    }
    return memProfile;
  }
  /** Live (read-only!) profile object. */
  function P() {
    var pm = prof();
    if (pm) return safe(function () { return typeof pm.peek === 'function' ? pm.peek() : pm.get(); }, fallbackProfile());
    return fallbackProfile();
  }
  function updateProfile(fn, meta) {
    var pm = prof();
    if (pm && typeof pm.update === 'function') return pm.update(fn, meta);
    var r = fn(fallbackProfile());
    emitLocal();
    return r;
  }
  var localListeners = [];
  function emitLocal() { localListeners.slice().forEach(function (f) { safe(function () { f(P(), {}); }); }); }
  function setting(path, def) {
    var v = getPath(P().settings, path);
    return v === undefined ? def : v;
  }
  function setSetting(path, value) {
    var pm = prof();
    if (pm && typeof pm.setSetting === 'function') return pm.setSetting(path, value);
    var parts = path.split('.'), o = fallbackProfile().settings;
    for (var i = 0; i < parts.length - 1; i++) { if (!isObj(o[parts[i]])) o[parts[i]] = {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = value;
    emitLocal();
  }
  function levelInfo() {
    var pm = prof(), p = P();
    if (pm && typeof pm.levelInfo === 'function') return pm.levelInfo(p.xp);
    var lvl = p.level || 1;
    var need = Math.round(1000 * Math.pow(lvl, 1.6));
    return { level: lvl, xp: p.xp, into: 0, needed: need, remaining: need, progress: 0, maxed: false };
  }
  function xpForLevel(l) {
    var pm = prof();
    if (pm && typeof pm.xpForLevel === 'function') return pm.xpForLevel(l);
    return Math.round(1000 * Math.pow(Math.max(1, l), 1.6));
  }
  function levelTitle(l) {
    var pm = prof();
    if (pm && typeof pm.levelTitle === 'function') return pm.levelTitle(l);
    return l >= 40 ? 'Champion' : l >= 20 ? 'Pro' : l >= 10 ? 'Privateer' : l >= 5 ? 'Club Racer' : 'Rookie';
  }
  function activeCar() {
    var p = P();
    var cars = p.ownedCars || [];
    for (var i = 0; i < cars.length; i++) if (cars[i].id === p.activeCarId) return cars[i];
    return cars[0] || null;
  }
  function defaultBuild() {
    if (CB.data && typeof CB.data.defaultBuild === 'function') return safe(function () { return CB.data.defaultBuild(); }, null);
    return null;
  }
  function currentAtelierBuild() {
    if (CB.state && typeof CB.state.get === 'function') return safe(function () { return CB.state.get(); }, null);
    return null;
  }
  /** Build to show / race with: active owned car, else the atelier build, else default. */
  function activeBuild() {
    var c = activeCar();
    if (c && c.build) return c.build;
    return currentAtelierBuild() || defaultBuild() || firstPresetBuild();
  }
  function firstPresetBuild() {
    var ps = presets();
    return ps.length ? ps[0].build : null;
  }
  function presets() {
    var D = CB.data;
    if (!D || !Array.isArray(D.presets)) return [];
    return D.presets.map(function (p) {
      var b = (typeof D.presetBuild === 'function') ? safe(function () { return D.presetBuild(p.id); }, null) : null;
      if (!b) b = p.build;
      if (b && CB.state && typeof CB.state.normalize === 'function') b = safe(function () { return CB.state.normalize(b); }, b);
      return { id: p.id, name: p.name, tagline: p.tagline || p.desc || '', build: b };
    });
  }
  function normalizeBuild(b) {
    if (b && CB.state && typeof CB.state.normalize === 'function') return safe(function () { return CB.state.normalize(b); }, b);
    return b;
  }

  /* ---------------------------------------------------- build metrics */
  var metricsCache = {};
  /** Approximate metrics: CB.physics if present, else a catalog estimate. */
  function metricsFor(build) {
    if (!build) return null;
    var key = hashStr(safe(function () { return JSON.stringify(build); }, String(Math.random())));
    if (metricsCache[key]) return metricsCache[key];
    var m = null;
    if (CB.physics && typeof CB.physics.compute === 'function') m = safe(function () { return CB.physics.compute(build); }, null);
    if (!m) m = estimateMetrics(build);
    metricsCache[key] = m;
    return m;
  }
  function estimateMetrics(b) {
    var e = b.engine || {}, D = CB.data || {};
    var hp;
    if (e.type === 'ev') hp = num(e.motors, 2) * num(e.motorPower_kw, 200) * 1.341 * 0.9;
    else {
      var disp = num(e.displacement_l, 3);
      var asp = { na: 1, turbo: 1.35, 'twin-turbo': 1.45, 'quad-turbo': 1.65, supercharged: 1.38, twincharged: 1.5, 'electric-turbo': 1.42 }[e.aspiration] || 1.2;
      var tune = { eco: 0.9, stock: 1, stage1: 1.1, stage2: 1.2, stage3: 1.32, 'time-attack': 1.45 }[e.tune] || 1;
      hp = disp * 78 * asp * tune * (1 + num(e.boost_bar, 0) * 0.12);
      if (e.type === 'hybrid') hp += num(e.motors, 1) * num(e.motorPower_kw, 80) * 1.341 * 0.8;
    }
    var bs = (D.bodyStyles || []).filter(function (x) { return x.id === getPath(b, 'body.style'); })[0];
    var weight = (bs && bs.baseWeight_kg) || 1450;
    if (e.type === 'ev') weight += num(e.battery_kwh, 80) * 5.5;
    var cm = { steel: 1, 'high-strength-steel': 0.95, aluminum: 0.86, 'carbon-tub': 0.76, 'carbon-monocoque': 0.68 }[getPath(b, 'body.chassisMaterial')] || 1;
    weight = weight * cm + num(getPath(b, 'weight.ballast_kg'), 0);
    var mu = { eco: 0.8, 'all-season': 0.86, winter: 0.82, touring: 0.92, performance: 1.02, 'super-sport': 1.12, track: 1.25, slick: 1.4 }[getPath(b, 'tires.compound')] || 1;
    var ptw = hp / (weight / 1000);
    var z60 = clamp(42 / Math.sqrt(ptw) * (getPath(b, 'drivetrain.layout') === 'awd' ? 0.9 : 1), 1.8, 16);
    var top = clamp(140 + Math.cbrt(hp) * 26, 120, 480);
    return {
      power_hp: Math.round(hp), weight_kg: Math.round(weight), powerToWeight_hpPerTon: Math.round(ptw),
      zeroTo60_s: Math.round(z60 * 10) / 10, topSpeed_kph: Math.round(top), lateralG: Math.round(mu * 100) / 100,
      lapTime_s: 160 - Math.min(60, ptw / 12) - mu * 10, estimated: true
    };
  }
  /** Single performance index 100..999 used for class badges & simulations. */
  function performanceIndex(m) {
    if (!m) return 0;
    var ptw = num(m.powerToWeight_hpPerTon, num(m.power_hp, 200) / (num(m.weight_kg, 1400) / 1000));
    var g = num(m.lateralG, 1);
    var pi = 100 + ptw * 1.15 + g * 180 + (num(m.topSpeed_kph, 220) - 200) * 0.6;
    return Math.round(clamp(pi, 100, 999));
  }
  function piClass(pi) {
    if (pi >= 900) return { id: 'X', color: '#8fe9ff' };
    if (pi >= 800) return { id: 'S2', color: '#c17bff' };
    if (pi >= 700) return { id: 'S1', color: '#ff5a8a' };
    if (pi >= 600) return { id: 'A', color: '#ff7a3d' };
    if (pi >= 500) return { id: 'B', color: '#f3c246' };
    if (pi >= 400) return { id: 'C', color: '#4cd18a' };
    return { id: 'D', color: '#57a8ff' };
  }
  function buildName(b, fallback) {
    return (b && ((b.meta && b.meta.name) || b.name)) || fallback || 'Untitled Build';
  }
  function bodyStyleOf(b) { return getPath(b, 'body.style') || 'coupe'; }
  /** Real manufacturer model of a build ("Honda Civic Type R"), or '' without CB.shapes. */
  function modelName(b) {
    // only a build with an explicit real model names it (body.model null = generic style shape, not the style default)
    if (!b || !getPath(b, 'body.model') || !CB.shapes || typeof CB.shapes.getModel !== 'function') return '';
    var m = safe(function () { return CB.shapes.getModel(b, { strict: true }); }, null);
    return m ? ((m.make ? m.make + ' ' : '') + (m.name || m.id || '')) : '';
  }

  /* ======================================================================
     Tracks
     ====================================================================== */
  var FALLBACK_TRACKS = [
    { id: 'forge-ring', name: 'Redline Ring Grand Prix Circuit', short: 'Redline Ring', country: 'Germany', difficulty: 3, length_m: 5800 },
    { id: 'forge-speedway', name: 'Redline Motor Speedway', short: 'Speedway', country: 'USA', difficulty: 1, length_m: 4000 },
    { id: 'porto-vecchio', name: 'Porto Vecchio Street Circuit', short: 'Porto Vecchio', country: 'Italy', difficulty: 4, length_m: 3300 },
    { id: 'akagane-pass', name: 'Akagane Pass', short: 'Akagane', country: 'Japan', difficulty: 5, length_m: 4600 },
    { id: 'little-anvil', name: 'Little Anvil Kartodromo', short: 'Little Anvil', country: 'Italy', difficulty: 2, length_m: 1200 }
  ];
  function trackList() {
    var T = tracksMod();
    var l = T && Array.isArray(T.list) && T.list.length ? T.list : FALLBACK_TRACKS;
    return l.filter(function (t) { return t && t.id && !t.hidden && !t.challenge && !t.isChallenge; });
  }
  function trackById(id) {
    var T = tracksMod();
    if (T && typeof T.get === 'function') { var t = safe(function () { return T.get(id); }, null); if (t) return t; }
    var all = (T && Array.isArray(T.list) ? T.list : []).concat(FALLBACK_TRACKS);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function trackName(id, short) {
    var t = trackById(id);
    if (!t) return id ? titleCase(id) : 'Unknown circuit';
    return (short && t.short) || t.name || titleCase(id);
  }
  var trackLenCache = {};
  function trackLength(id) {
    if (trackLenCache[id] != null) return trackLenCache[id];
    var t = trackById(id), L = t && num(t.length_m, 0);
    if (!L) {
      var T = tracksMod();
      if (T && typeof T.geometry === 'function') {
        var g = safe(function () { return T.geometry(id); }, null);
        L = g ? num(g.length || g.length_m || g.totalLength, 0) : 0;
      }
    }
    trackLenCache[id] = L || 4000;
    return trackLenCache[id];
  }
  var previewCache = {};
  /** Preview polyline in a w×h box. Falls back to a generic loop. */
  function trackPreview(id, w, h) {
    var key = id + ':' + w + 'x' + h;
    if (previewCache[key]) return previewCache[key];
    var T = tracksMod(), pts = null, def = trackById(id);
    if (T && typeof T.previewPath === 'function' && def && def.points) pts = safe(function () { return T.previewPath(def, w, h, 8); }, null);
    if (!pts || !pts.length) {
      var r = rng(hashStr(id || 'x'));
      pts = [];
      var n = 48;
      var lobes = 2 + Math.floor(r() * 3), amp = 0.12 + r() * 0.22, ph = r() * 6.28;
      for (var i = 0; i < n; i++) {
        var a = (i / n) * Math.PI * 2;
        var rad = 1 + amp * Math.sin(a * lobes + ph) + 0.06 * Math.sin(a * 5 + ph * 2);
        pts.push([w / 2 + Math.cos(a) * rad * (w * 0.36), h / 2 + Math.sin(a) * rad * (h * 0.34)]);
      }
    }
    previewCache[key] = pts;
    return pts;
  }
  function trackPreviewSVG(id, w, h, opts) {
    opts = opts || {};
    var pts = trackPreview(id, w, h);
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ') + ' Z';
    var s = pts[0];
    return '<svg class="gh-track-svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" aria-hidden="true">' +
      '<path d="' + d + '" fill="none" stroke="rgba(0,0,0,.55)" stroke-width="' + (opts.width || 7) + '" stroke-linejoin="round"/>' +
      '<path d="' + d + '" fill="none" stroke="' + (opts.color || 'currentColor') + '" stroke-width="' + ((opts.width || 7) - 3.5) + '" stroke-linejoin="round" class="gh-track-line"/>' +
      '<path d="' + d + '" fill="none" stroke="var(--gh-accent)" stroke-width="1.6" stroke-dasharray="6 260" class="gh-track-runner"/>' +
      (s ? '<rect x="' + (s[0] - 3) + '" y="' + (s[1] - 3) + '" width="6" height="6" fill="#fff" stroke="#000" stroke-width="1"/>' : '') +
      '</svg>';
  }

  /* ======================================================================
     Pure: spatial navigation
     ====================================================================== */
  /**
   * pickNext(rects, fromIdx, dir) -> index | -1
   * rects: [{x, y, w, h}], dir: 'up'|'down'|'left'|'right'.
   * Scores candidates in the half-plane of `dir` by primary distance plus a
   * weighted orthogonal offset (with overlap bonus) — classic TV-style nav.
   */
  function pickNext(rects, fromIdx, dir) {
    var a = rects[fromIdx];
    if (!a) return rects.length ? 0 : -1;
    var ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    var best = -1, bestScore = Infinity;
    for (var i = 0; i < rects.length; i++) {
      if (i === fromIdx) continue;
      var b = rects[i];
      if (!b || (b.w === 0 && b.h === 0)) continue;
      var bx = b.x + b.w / 2, by = b.y + b.h / 2;
      var primary, ortho, overlap;
      if (dir === 'right') { primary = b.x - (a.x + a.w); ortho = Math.abs(by - ay); overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); if (bx <= ax + 1) continue; }
      else if (dir === 'left') { primary = a.x - (b.x + b.w); ortho = Math.abs(by - ay); overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); if (bx >= ax - 1) continue; }
      else if (dir === 'down') { primary = b.y - (a.y + a.h); ortho = Math.abs(bx - ax); overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x); if (by <= ay + 1) continue; }
      else { primary = a.y - (b.y + b.h); ortho = Math.abs(bx - ax); overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x); if (by >= ay - 1) continue; }
      primary = Math.max(0, primary);
      var score = primary + ortho * (overlap > 0 ? 0.6 : 2.4) - (overlap > 0 ? Math.min(overlap, 40) : 0);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  /* ======================================================================
     Pure: animation helpers
     ====================================================================== */
  function easeOutCubic(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }
  function easeInOut(t) { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function countUpValue(from, to, t) { return Math.round(lerp(from, to, easeOutCubic(t))); }
  /**
   * xpSegments(startXp, gained, startLevel?) — slices of an animated XP bar.
   * Each {level, from (0..1), to (0..1), levelUp:bool}. Uses the profile curve
   * (xpForLevel(l) = XP needed to go from l -> l+1).
   */
  function xpSegments(startXp, gained, startLevel, curve) {
    curve = curve || xpForLevel;
    startXp = Math.max(0, num(startXp, 0));
    gained = Math.max(0, num(gained, 0));
    var level = Math.max(1, Math.round(num(startLevel, 0)) || levelFromXp(startXp, curve));
    var base = 0;
    for (var l = 1; l < level; l++) base += curve(l);
    var into = startXp - base;
    var segs = [], left = gained, guard = 0;
    while (guard++ < 200) {
      var need = curve(level);
      if (need <= 0) break;
      var room = need - into;
      if (left >= room && left > 0) {
        segs.push({ level: level, from: into / need, to: 1, levelUp: true });
        left -= room; into = 0; level += 1;
        if (left <= 0) { segs.push({ level: level, from: 0, to: 0, levelUp: false }); break; }
      } else {
        segs.push({ level: level, from: into / need, to: (into + left) / need, levelUp: false });
        break;
      }
    }
    return segs;
  }
  function levelFromXp(xp, curve) {
    curve = curve || xpForLevel;
    var l = 1, acc = 0;
    while (l < 200 && acc + curve(l) <= xp) { acc += curve(l); l++; }
    return l;
  }

  /* ======================================================================
     Pure: career model normalisation
     ====================================================================== */
  var TIER_FALLBACK = [
    { id: 'rookie', name: 'Rookie Cup', color: '#57a8ff' },
    { id: 'national', name: 'National GT', color: '#4cd18a' },
    { id: 'continental', name: 'Continental Series', color: '#f3c246' },
    { id: 'world-endurance', name: 'World Endurance', color: '#ff7a3d' },
    { id: 'hypercar', name: 'Hypercar Masters', color: '#c17bff' }
  ];
  function catalogOf(C) {
    if (!C) return null;
    var cat = C.catalog;
    if (typeof cat === 'function') cat = safe(function () { return C.catalog(); }, null);
    return cat || null;
  }
  function stateOf(C, profile) {
    if (!C) return {};
    if (typeof C.state === 'function') return safe(function () { return C.state(profile); }, null) || (profile && profile.career) || {};
    return (profile && profile.career) || {};
  }
  function champMap(cat) {
    var m = {};
    arr(cat && (cat.championships || cat.champs)).forEach(function (c) { if (c && c.id) m[c.id] = c; });
    return m;
  }
  function roundsOf(ch) {
    var r = ch && (ch.rounds || ch.calendar || ch.races);
    if (Array.isArray(r)) return r.map(function (x, i) {
      if (typeof x === 'string') return { trackId: x, index: i };
      return Object.assign({ index: i }, x || {});
    });
    if (isNum(r)) { var out = []; for (var i = 0; i < r; i++) out.push({ index: i, trackId: null }); return out; }
    return [];
  }
  function reqOf(ch) {
    return (ch && (ch.requirements || ch.entry || ch.eligibility || ch.reqs || ch.restrictions)) || {};
  }
  function champStateOf(st, id) {
    if (!st) return null;
    var pools = [st.championships, st.champs, st.progress, st.byChampionship, st.events, st];
    for (var i = 0; i < pools.length; i++) {
      var pool = pools[i];
      if (Array.isArray(pool)) {
        for (var j = 0; j < pool.length; j++) if (pool[j] && (pool[j].id === id || pool[j].champId === id)) return pool[j];
      } else if (isObj(pool) && isObj(pool[id])) return pool[id];
    }
    if (Array.isArray(st.tiers)) {
      for (var t = 0; t < st.tiers.length; t++) {
        var cs = st.tiers[t] && st.tiers[t].championships;
        if (Array.isArray(cs)) for (var k = 0; k < cs.length; k++) if (cs[k] && cs[k].id === id && (cs[k].status || cs[k].standings || cs[k].roundsCompleted != null)) return cs[k];
      }
    }
    return null;
  }
  /**
   * careerModel(C, profile) -> { available, tiers:[{id,name,index,color,unlocked,lockReason,complete,championships:[vm]}],
   *                               events:[vm], trophies:[...], totals }
   * Accepts several catalog shapes: {tiers:[{championships:[obj|id]}]}, {tiers, championships:[{tier|tierId}]}, array of tiers.
   */
  function careerModel(C, profile) {
    var cat = catalogOf(C);
    if (!cat) return { available: false, tiers: [], events: [], trophies: [] };
    var tiersRaw = Array.isArray(cat) ? cat : arr(cat.tiers);
    var cmap = champMap(cat);
    var st = stateOf(C, profile) || {};
    var lvl = num(profile && profile.level, 1);
    var tiers = tiersRaw.map(function (t, ti) {
      var fb = TIER_FALLBACK[ti] || TIER_FALLBACK[TIER_FALLBACK.length - 1];
      var champs = arr(t.championships || t.champs || t.series).map(function (c) { return typeof c === 'string' ? cmap[c] : c; }).filter(Boolean);
      if (!champs.length) champs = Object.keys(cmap).map(function (k) { return cmap[k]; }).filter(function (c) { return c.tier === t.id || c.tierId === t.id || c.tier === ti; });
      return {
        id: t.id || fb.id, name: t.name || fb.name, index: ti, color: t.color || fb.color, desc: t.desc || t.tagline || '',
        minLevel: num(first(t.minLevel, t.levelRequired, t.unlockLevel, t.requiredLevel), 0),
        raw: t, championships: champs.map(function (c) { return champVM(C, profile, st, c, t, ti); })
      };
    });
    // unlock logic: explicit API > state flags > previous tier progress + level
    tiers.forEach(function (t, i) {
      var explicit = C && typeof C.isTierUnlocked === 'function' ? safe(function () { return C.isTierUnlocked(profile, t.id); }, null) : null;
      var flag = getPath(st, 'tiers.' + t.id + '.unlocked');
      if (explicit == null && flag == null && Array.isArray(st.unlockedTiers)) flag = st.unlockedTiers.indexOf(t.id) >= 0;
      if (explicit == null && flag == null && t.raw.unlocked != null) flag = !!t.raw.unlocked;
      var prev = tiers[i - 1];
      var prevOk = !prev || prev.championships.some(function (c) { return c.complete; });
      var levelOk = lvl >= t.minLevel;
      t.unlocked = explicit != null ? !!explicit : flag != null ? !!flag : (i === 0 || (prevOk && levelOk));
      t.lockReason = t.unlocked ? '' : (!levelOk ? 'Reach level ' + t.minLevel : 'Complete a ' + (prev ? prev.name : 'previous') + ' championship');
      t.complete = t.championships.length > 0 && t.championships.every(function (c) { return c.complete; });
      t.progress = t.championships.length ? t.championships.filter(function (c) { return c.complete; }).length / t.championships.length : 0;
      t.championships.forEach(function (c) {
        if (!t.unlocked) { c.locked = true; c.lockReason = t.lockReason; }
        else if (c.minLevel && lvl < c.minLevel) { c.locked = true; c.lockReason = 'Reach level ' + c.minLevel; }
      });
    });
    var events = arr(cat.events || cat.specialEvents || cat.specials).map(function (e) { return champVM(C, profile, st, e, null, -1); });
    var trophies = arr(st.trophies || (profile && profile.career && profile.career.trophies));
    return { available: true, tiers: tiers, events: events, trophies: trophies, state: st };
  }
  function champVM(C, profile, st, c, tier, ti) {
    var cs = champStateOf(st, c.id) || {};
    var rounds = roundsOf(c);
    var done = num(first(cs.roundsCompleted, cs.completedRounds, cs.round, cs.roundIdx, cs.nextRound,
      Array.isArray(cs.results) ? cs.results.length : undefined), 0);
    if (Array.isArray(cs.results) && cs.results.length > done) done = cs.results.length;
    done = clamp(done, 0, rounds.length || 99);
    var status = typeof cs.status === 'string' ? cs.status : null;
    var complete = !!(cs.complete || cs.completed || cs.finished || status === 'complete' || status === 'completed' || (rounds.length && done >= rounds.length));
    var entered = !!(cs.entered || cs.active || status === 'active' || status === 'in-progress' || status === 'entered' || (done > 0 && !complete));
    var standings = normalizeStandings(cs.standings || cs.table || []);
    var me = standings.filter(function (s) { return s.isPlayer; })[0] || null;
    return {
      id: c.id, name: c.name || titleCase(c.id), desc: c.desc || c.tagline || c.description || '',
      tierId: tier ? tier.id : (c.tier || c.tierId || null), tierIndex: ti,
      type: c.eventType || c.type || (ti < 0 ? 'event' : 'championship'),
      rounds: rounds, roundsDone: done, complete: complete, started: done > 0 && !complete, entered: entered && !complete, status: status,
      season: num(first(cs.season, cs.seasons), 0), bestResult: first(cs.bestPosition, cs.bestResult, null), rival: first(c.rival, c.rivalId, null),
      standings: standings, playerPos: me ? me.position : null, playerPoints: me ? me.points : 0, playerUnranked: !!(me && me.unranked),
      requirements: reqOf(c), minLevel: num(first(c.minLevel, c.levelRequired, c.unlockLevel), 0),
      entryFee: num(first(c.entryFee, c.fee), 0), prize: first(c.prize, c.purse, c.reward, c.rewards),
      laps: c.laps, difficulty: c.difficulty, color: c.color || null, trophy: cs.trophy || null,
      result: cs.finalPosition || cs.result || null, locked: false, lockReason: '', raw: c
    };
  }
  /** normalizeStandings(rows) → sorted [{position, name, team, points, wins, isPlayer, color, gap}] */
  function normalizeStandings(rows) {
    var list = arr(rows).map(function (r, i) {
      r = r || {};
      var rid = first(r.id, r.driverId, r.carId, 'd' + i);
      var isMe = !!(r.isPlayer || r.player === true || r.you || rid === 'player');
      var drv = isMe ? null : driverInfo(rid);
      return {
        id: rid, name: first(r.name, r.driver, r.driverName, isMe ? (getPath(P(), 'driverName') || 'You') : null, drv && drv.name, 'Driver ' + (i + 1)),
        team: first(r.team, r.teamName, isMe ? 'Redline Garage' : null, drv && drv.team, ''), points: num(first(r.points, r.pts, r.score), 0), wins: num(first(r.wins, r.victories), 0),
        podiums: num(r.podiums, 0), isPlayer: isMe, color: first(r.color, r.livery, isMe ? getPath(activeBuild(), 'exterior.paint') : null, drv && drv.color, null),
        number: first(r.number, r.no, null), results: Array.isArray(r.results) ? r.results : (Array.isArray(r.finishes) ? r.finishes : []),
        lastPosition: first(r.lastPosition, null), change: num(r.change, 0),
        srcPos: num(r.position, 1e3 + i), starts: num(first(r.starts, r.races), 0)
      };
    });
    // ties keep the source order (CB.game.career applies the countback tiebreakers), never an alphabetical re-rank
    list.sort(function (a, b) { return (b.points - a.points) || (b.wins - a.wins) || (b.podiums - a.podiums) || (a.srcPos - b.srcPos) || (a.name < b.name ? -1 : 1); });
    var lead = list.length ? list[0].points : 0;
    // nobody has scored or started yet (new season): everyone is level, no fake ranking
    var unranked = list.length > 0 && list.every(function (r) { return !r.points && !r.wins && !r.starts && !r.results.length; });
    list.forEach(function (r, i) { r.position = i + 1; r.gap = lead - r.points; r.unranked = unranked; });
    return list;
  }
  /** Requirement chips for a championship requirement object. */
  function requirementChips(req) {
    var out = [];
    if (!isObj(req)) return out;
    var units = setting('units', 'kph');
    if (req.maxPower_hp != null) out.push('≤ ' + fmtInt(req.maxPower_hp) + ' hp');
    if (req.minPower_hp != null) out.push('≥ ' + fmtInt(req.minPower_hp) + ' hp');
    if (req.minWeight_kg != null) out.push('≥ ' + fmtInt(req.minWeight_kg) + ' kg');
    if (req.maxWeight_kg != null) out.push('≤ ' + fmtInt(req.maxWeight_kg) + ' kg');
    if (req.maxPrice != null) out.push('≤ ' + fmtCredits(req.maxPrice));
    if (req.maxPI != null) out.push('PI ≤ ' + req.maxPI);
    ['bodyStyles', 'drivetrain', 'engineTypes', 'tireCompounds', 'engineLayouts', 'aspirations'].forEach(function (k) {
      var v = req[k];
      if (v == null) return;
      var l = Array.isArray(v) ? v : [v];
      if (l.length) out.push(l.map(titleCase).join(' / '));
    });
    if (req.maxTopSpeed_kph != null) out.push('Vmax ≤ ' + fmtSpeed(req.maxTopSpeed_kph, units));
    if (req.desc) out.push(String(req.desc));
    return out;
  }
  /** Eligibility with career.checkEligibility, else local evaluation of the known keys. */
  function eligibility(C, build, champRaw) {
    if (!build) return { ok: false, reasons: ['No car selected — buy or select a car in My Cars'] };
    if (C && typeof C.checkEligibility === 'function') {
      var r = safe(function () { return C.checkEligibility(build, champRaw); }, null);
      if (r && typeof r.ok === 'boolean') return { ok: r.ok, reasons: arr(r.reasons).map(function (x) { return typeof x === 'string' ? x : (x && (x.message || x.text || x.label)) || String(x); }) };
    }
    return localEligibility(build, reqOf(champRaw));
  }
  function localEligibility(build, req) {
    var m = metricsFor(build) || {}, reasons = [];
    var inList = function (v, l) { l = Array.isArray(l) ? l : [l]; return !l.length || l.indexOf(v) >= 0; };
    if (req.maxPower_hp != null && num(m.power_hp, 0) > req.maxPower_hp) reasons.push('Power ' + fmtInt(m.power_hp) + ' hp exceeds ' + fmtInt(req.maxPower_hp) + ' hp');
    if (req.minPower_hp != null && num(m.power_hp, 0) < req.minPower_hp) reasons.push('Needs at least ' + fmtInt(req.minPower_hp) + ' hp');
    if (req.minWeight_kg != null && num(m.weight_kg, 0) < req.minWeight_kg) reasons.push('Weight ' + fmtInt(m.weight_kg) + ' kg below minimum ' + fmtInt(req.minWeight_kg) + ' kg');
    if (req.maxWeight_kg != null && num(m.weight_kg, 0) > req.maxWeight_kg) reasons.push('Weight above ' + fmtInt(req.maxWeight_kg) + ' kg');
    if (req.bodyStyles && !inList(getPath(build, 'body.style'), req.bodyStyles)) reasons.push('Body style must be ' + arr(req.bodyStyles).map(titleCase).join(' / '));
    if (req.drivetrain && !inList(getPath(build, 'drivetrain.layout'), req.drivetrain)) reasons.push('Drivetrain must be ' + [].concat(req.drivetrain).join(' / ').toUpperCase());
    if (req.engineTypes && !inList(getPath(build, 'engine.type'), req.engineTypes)) reasons.push('Engine type must be ' + [].concat(req.engineTypes).map(titleCase).join(' / '));
    if (req.tireCompounds && !inList(getPath(build, 'tires.compound'), req.tireCompounds)) reasons.push('Tyres must be ' + [].concat(req.tireCompounds).map(titleCase).join(' / '));
    if (req.maxPrice != null) {
      var E = eco(), cost = E ? safe(function () { return E.carCost(build); }, 0) : 0;
      if (cost > req.maxPrice) reasons.push('Car value ' + fmtCredits(cost) + ' exceeds ' + fmtCredits(req.maxPrice));
    }
    return { ok: reasons.length === 0, reasons: reasons };
  }

  /* ======================================================================
     Pure: race result simulation (used when the race module is absent)
     ====================================================================== */
  var SIM_NAMES = ['L. Moretti', 'K. Tanaka', 'S. Okafor', 'A. Lindqvist', 'M. Duarte', 'J. Becker', 'R. Novak', 'E. Laurent',
    'T. Harrow', 'Y. Chen', 'P. Castellano', 'D. Ivanova', 'O. Reyes', 'H. Vos'];
  var SIM_TEAMS = ['Scuderia Ferro', 'Kurogane Racing', 'Atlas Motorsport', 'Nordlys GT', 'Vela Corse', 'Brandt Works', 'Halcyon', 'Rouge Équipe'];
  /**
   * simulateResults({build, opponents, laps, trackId, difficulty, seed, mode}) -> engine-like results
   * {mode, trackId, laps, playerId, fieldSize, fastestLap:{carId,time}, cars:[{id,isPlayer,name,team,position,finished,
   *  finishTime_s, bestLap_s, lapsCompleted, gridPosition, topSpeed_kph, collisions, penalties_s, dnf}], simulated:true}
   */
  function simulateResults(o) {
    o = o || {};
    var r = rng(num(o.seed, hashStr(JSON.stringify([o.trackId, o.laps, o.difficulty, Date.now()]))));
    var mode = o.mode || 'race';
    var n = mode === 'race' ? clamp(Math.round(num(o.opponents, 7)), 1, 11) : 0;
    var laps = clamp(Math.round(num(o.laps, 3)), 1, 50);
    var m = metricsFor(o.build) || estimateMetrics(o.build || {});
    var pi = performanceIndex(m);
    var skill = { rookie: 0.35, amateur: 0.55, pro: 0.75, alien: 0.92 }[o.difficulty] || 0.55;
    var L = trackLength(o.trackId);
    var baseLap = L / Math.max(25, 32 + (pi - 400) * 0.045);
    var cars = [];
    var playerPace = baseLap * (1 + (r() - 0.5) * 0.03);
    var grid = Math.floor(r() * (n + 1)) + 1;
    cars.push({ id: 'player', isPlayer: true, name: getPath(P(), 'driverName') || 'You', team: 'Redline Garage', pace: playerPace, consistency: 0.7 + r() * 0.2, color: getPath(o.build, 'exterior.paint') || '#c8a96a' });
    for (var i = 0; i < n; i++) {
      var pace = baseLap * (1 + (0.6 - skill) * 0.05 + (r() - 0.5) * 0.06);
      cars.push({ id: 'ai' + i, isPlayer: false, name: SIM_NAMES[i % SIM_NAMES.length], team: SIM_TEAMS[i % SIM_TEAMS.length], pace: pace, consistency: 0.6 + r() * 0.35, color: ['#d94f3d', '#3d7fd9', '#3dbf8a', '#f2a541', '#9b5de5', '#e8e8e8', '#2b2d42', '#ff6fb5'][i % 8] });
    }
    var fastest = null;
    cars.forEach(function (c, idx) {
      var total = 0, best = Infinity;
      for (var l = 0; l < laps; l++) {
        var t = c.pace * (1 + (r() - 0.5) * 0.02 * (2 - c.consistency)) + (l === 0 ? 2.5 + idx * 0.25 : 0);
        if (r() < 0.04 * (1.2 - c.consistency)) t += 2 + r() * 4;
        total += t; if (t < best) best = t;
      }
      c.finishTime_s = Math.round(total * 1000) / 1000;
      c.bestLap_s = Math.round(best * 1000) / 1000;
      c.dnf = !c.isPlayer && r() < 0.02;
      c.collisions = r() < 0.25 ? 1 + Math.floor(r() * 2) : 0;
      if (c.isPlayer && r() < 0.5) c.collisions = 0;
      if (!fastest || c.bestLap_s < fastest.time) fastest = { carId: c.id, time: c.bestLap_s };
    });
    var order = cars.slice().sort(function (a, b) { return (a.dnf - b.dnf) || (a.finishTime_s - b.finishTime_s); });
    var gridOrder = cars.slice().sort(function (a, b) { return a.pace - b.pace; });
    order.forEach(function (c, i) {
      c.position = i + 1;
      c.finished = !c.dnf;
      c.lapsCompleted = c.dnf ? Math.floor(laps * r()) : laps;
      c.gridPosition = c.isPlayer ? Math.min(grid, n + 1) : gridOrder.indexOf(c) + 1;
      c.topSpeed_kph = Math.round(num(m.topSpeed_kph, 220) * (0.82 + r() * 0.12));
      c.penalties_s = 0;
      c.gapLeader_s = Math.round((c.finishTime_s - order[0].finishTime_s) * 1000) / 1000;
      c.distance_m = c.lapsCompleted * L;
      delete c.pace; delete c.consistency;
    });
    return {
      simulated: true, mode: mode, trackId: o.trackId || null, laps: laps, playerId: 'player', fieldSize: cars.length,
      difficulty: o.difficulty || 'amateur', fastestLap: mode === 'race' ? fastest : null, cars: order
    };
  }

  /** Classification rows of an engine / race-ui / career / hub-simulated results object. */
  function resultRows(results) {
    if (Array.isArray(results)) return results;
    if (!results || typeof results !== 'object') return [];
    var l = results.cars || results.classification || results.results || results.order || results.standings;
    return Array.isArray(l) ? l : [];
  }
  /** Player summary from results (profile.summarizeRace when available). */
  function summarize(results, config) {
    var pm = prof();
    if (pm && typeof pm.summarizeRace === 'function') {
      var s = safe(function () { return pm.summarizeRace(results, config); }, null);
      if (s) return s;
    }
    var list = resultRows(results);
    var me = list.filter(function (c) { return c && c.isPlayer; })[0] || list[0] || {};
    return { valid: !!me, mode: (config && config.mode) || 'race', position: me.position || null, fieldSize: list.length, dnf: !!me.dnf,
      bestLap_s: me.bestLap_s || null, finishTime_s: me.finishTime_s || null, win: me.position === 1, podium: me.position <= 3, trackId: config && config.trackId };
  }

  /* ======================================================================
     Pure: profile chart series
     ====================================================================== */
  function formSeries(history, n) {
    return arr(history).filter(function (h) { return h && h.mode === 'race'; }).slice(-(n || 20)).map(function (h, i) {
      return { i: i, position: h.dnf ? null : num(h.position, null), field: num(h.fieldSize, 0), trackId: h.trackId, t: h.t, dnf: !!h.dnf };
    });
  }
  function resultBuckets(history) {
    var b = { win: 0, podium: 0, points: 0, other: 0, dnf: 0 };
    arr(history).forEach(function (h) {
      if (!h || h.mode !== 'race') return;
      if (h.dnf) b.dnf++;
      else if (h.position === 1) b.win++;
      else if (h.position <= 3) b.podium++;
      else if (h.position <= 10) b.points++;
      else b.other++;
    });
    return [
      { id: 'win', label: 'Wins', value: b.win }, { id: 'podium', label: 'Podiums (P2–P3)', value: b.podium },
      { id: 'points', label: 'Points (P4–P10)', value: b.points }, { id: 'other', label: 'Outside points', value: b.other },
      { id: 'dnf', label: 'DNF', value: b.dnf }
    ];
  }
  function balanceSeries(ledger, startCredits) {
    var l = arr(ledger).filter(function (e) { return e && isNum(e.balance); });
    var pts = [];
    if (l.length) {
      var first0 = l[0];
      pts.push({ t: first0.t - 1, balance: first0.balance - num(first0.amount, 0) });
      l.forEach(function (e) { pts.push({ t: e.t, balance: e.balance, amount: e.amount, reason: e.reason }); });
    } else pts.push({ t: Date.now(), balance: num(startCredits, 150000) });
    return pts;
  }
  function trackUsage(tracksStats) {
    return Object.keys(tracksStats || {}).map(function (id) {
      var t = tracksStats[id] || {};
      return { id: id, name: trackName(id, true), races: num(t.races, 0), wins: num(t.wins, 0), bestLap_s: t.bestLap_s, distance_km: num(t.distance_km, 0) };
    }).sort(function (a, b) { return b.races - a.races || b.distance_km - a.distance_km; });
  }

  /* ======================================================================
     Pure: replays list adapter
     ====================================================================== */
  var REPLAY_KEY = 'forge.replays.v1';
  function lsGet(k) {
    try { if (typeof localStorage === 'undefined') return null; var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function replayList() {
    var R = rep(), list = null;
    if (R) list = call(R, ['list', 'listStored', 'stored', 'listReplays', 'all'], [], null);
    if (!list && R && R.store) list = call(R.store, ['list', 'all'], [], null);
    if (!list && R && R.storage) list = call(R.storage, ['list', 'all'], [], null);
    if (!list) {
      var raw = lsGet(REPLAY_KEY);
      list = Array.isArray(raw) ? raw : (raw && (raw.replays || raw.items || raw.list)) || [];
    }
    return arr(list).map(function (r, i) {
      var meta = Object.assign({}, r, r.info || {}, r.meta || r.header || {});
      return {
        id: first(r.id, meta.id, 'replay-' + i), raw: r, pinned: !!r.pinned, winner: meta.winner || null,
        overtakes: num(meta.overtakes, 0), collisions: num(meta.collisions, 0), weather: meta.weather || null, timeOfDay: meta.timeOfDay || null,
        trackName: meta.trackName || null, playerColor: meta.playerColor || null,
        trackId: first(meta.trackId, getPath(meta, 'config.trackId'), null),
        createdAt: num(first(meta.savedAt, meta.createdAt, meta.date, meta.t), null),
        duration: num(first(meta.duration, meta.duration_s, meta.length_s), 0),
        mode: first(meta.mode, getPath(meta, 'config.mode'), 'race'),
        cars: num(first(meta.carCount, Array.isArray(meta.cars) ? meta.cars.length : meta.cars), 0),
        laps: num(first(meta.laps, getPath(meta, 'config.laps')), 0),
        position: first(meta.playerFinish, meta.playerPosition, meta.position, null),
        bestLap: first(meta.bestLap_s, meta.bestLap, null),
        name: first(meta.name, meta.title, null),
        size: num(first(meta.size, meta.bytes, meta.chars), 0)
      };
    }).sort(function (a, b) { return num(b.createdAt, 0) - num(a.createdAt, 0); });
  }

  /* ======================================================================
     Pure: car side-view SVG (fallback when CB.render.thumbnail is absent)
     ====================================================================== */
  /* Each profile: body polyline in a 400×140 box (y up = smaller). ground at y=118. */
  var CAR_SHAPES = {
    coupe: { body: 'M18 96 C20 80 40 74 70 72 L120 66 C150 44 190 34 236 36 C270 38 300 52 322 68 L366 74 C384 78 392 88 390 100 L386 106 L18 106 Z', glass: 'M134 66 C160 48 192 42 232 43 C258 45 282 56 300 68 Z', wheelbase: [92, 312], wheelR: 26 },
    sedan: { body: 'M16 94 C18 80 38 74 66 72 L110 66 C138 44 176 36 228 36 C266 37 296 48 318 66 L364 72 C384 76 392 88 390 100 L386 106 L16 106 Z', glass: 'M124 66 C148 48 180 42 226 42 C256 43 282 52 302 66 Z', wheelbase: [90, 314], wheelR: 25 },
    hatchback: { body: 'M24 96 C26 80 44 74 72 72 L118 64 C142 44 176 36 222 36 C262 38 300 46 320 58 C330 66 334 80 336 92 L334 106 L24 106 Z', glass: 'M130 64 C152 48 180 43 220 43 C256 44 290 52 312 62 L312 66 Z', wheelbase: [92, 288], wheelR: 24 },
    wagon: { body: 'M16 94 C18 80 38 74 66 72 L110 64 C134 44 170 36 220 35 L330 36 C352 38 362 52 368 70 L380 76 C390 82 392 92 390 102 L386 106 L16 106 Z', glass: 'M124 64 C146 48 176 42 218 42 L326 42 C344 44 352 54 356 64 Z', wheelbase: [90, 318], wheelR: 25 },
    suv: { body: 'M18 88 C20 70 40 62 66 60 L106 54 C126 30 162 22 214 22 L320 24 C342 26 354 40 360 58 L376 64 C388 70 392 82 390 96 L386 104 L18 104 Z', glass: 'M118 54 C138 34 166 28 212 28 L318 30 C336 32 344 42 348 54 Z', wheelbase: [94, 316], wheelR: 30 },
    roadster: { body: 'M18 98 C20 84 40 78 72 76 L150 72 C168 60 196 56 214 58 L236 68 L330 70 C366 72 388 84 390 98 L386 106 L18 106 Z', glass: 'M156 70 C170 60 192 58 208 60 L220 70 Z', wheelbase: [92, 310], wheelR: 25 },
    pickup: { body: 'M14 90 C16 72 36 64 62 62 L104 56 C120 34 150 26 196 26 L218 28 L226 60 L382 62 C390 66 392 80 390 98 L386 104 L14 104 Z', glass: 'M114 56 C130 36 154 32 192 32 L212 34 L216 56 Z', wheelbase: [86, 318], wheelR: 30 },
    hypercar: { body: 'M12 100 C14 90 30 84 60 82 L130 72 C160 52 196 44 236 46 C268 48 296 60 318 74 L372 80 C390 84 396 92 394 102 L390 108 L12 108 Z', glass: 'M150 70 C172 56 200 50 232 52 C254 54 274 62 290 72 Z', wheelbase: [96, 312], wheelR: 26 },
    'shooting-brake': { body: 'M16 96 C18 80 38 74 68 72 L118 64 C146 44 182 36 230 36 L316 40 C342 44 358 58 366 72 L378 76 C390 82 392 92 390 102 L386 106 L16 106 Z', glass: 'M130 64 C154 47 186 42 228 42 L314 46 C334 50 346 58 352 66 Z', wheelbase: [92, 314], wheelR: 26 },
    van: { body: 'M20 92 C20 70 30 40 60 24 C80 16 110 14 150 14 L340 16 C362 18 372 30 376 50 L384 90 C388 96 388 100 386 104 L20 104 Z', glass: 'M60 52 C66 34 82 24 110 22 L160 22 L160 54 Z', wheelbase: [86, 320], wheelR: 26 }
  };
  function carSVG(build, opts) {
    opts = opts || {};
    var style = bodyStyleOf(build);
    var sh = CAR_SHAPES[style] || CAR_SHAPES.coupe;
    var paint = getPath(build, 'exterior.paint') || '#b3121f';
    var finish = getPath(build, 'exterior.finish') || 'metallic';
    var rim = getPath(build, 'wheels.finish') || '#2b2b2b';
    var caliper = getPath(build, 'exterior.caliperColor') || '#f2c200';
    var stripe = getPath(build, 'exterior.stripe') || 'none';
    var stripeColor = getPath(build, 'exterior.stripeColor') || '#ffffff';
    var wing = getPath(build, 'aero.wing') || 'none';
    var number = getPath(build, 'exterior.livery_number') || '';
    var dia = num(getPath(build, 'wheels.diameter_in'), 19);
    var ride = num(getPath(build, 'suspension.rideHeight_mm'), 120);
    var id = 'c' + (hashStr(paint + style + (opts.uid || '')) % 1e6);
    var lift = clamp((ride - 120) / 12, -4, 8);
    var wr = sh.wheelR * clamp(0.85 + (dia - 15) * 0.035, 0.85, 1.15);
    var spin = opts.spin ? ' class="gh-wheel-spin"' : '';
    var spokes = Math.max(5, Math.min(10, num(getPath(build, 'wheels.spokes'), 5)));
    var gloss = finish === 'matte' ? 0.08 : finish === 'satin' ? 0.18 : finish === 'chrome' ? 0.7 : 0.42;
    var s = [];
    s.push('<svg class="gh-car-svg" viewBox="0 0 400 140" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + esc(buildName(build, titleCase(style))) + '">');
    s.push('<defs><linearGradient id="' + id + 'p" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + shade(paint, 0.35) + '"/><stop offset=".45" stop-color="' + paint + '"/><stop offset="1" stop-color="' + shade(paint, -0.55) + '"/></linearGradient>' +
      '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9fb4c8" stop-opacity=".9"/><stop offset=".5" stop-color="#1b2633"/><stop offset="1" stop-color="#05080c"/></linearGradient>' +
      '<linearGradient id="' + id + 's" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity="' + gloss + '"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
      '<radialGradient id="' + id + 'sh" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#000" stop-opacity=".75"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>' +
      '<clipPath id="' + id + 'c"><path d="' + sh.body + '"/></clipPath></defs>');
    s.push('<ellipse cx="200" cy="' + (120 + lift * 0.2) + '" rx="190" ry="10" fill="url(#' + id + 'sh)"/>');
    s.push('<g transform="translate(0 ' + (-lift) + ')">');
    if (wing === 'gt-wing' || wing === 'swan-neck' || wing === 'biplane' || wing === 'active') {
      s.push('<path d="M326 ' + (wing === 'swan-neck' ? 40 : 46) + ' L384 ' + (wing === 'swan-neck' ? 36 : 42) + ' L384 50 L326 52 Z" fill="' + shade(paint, -0.6) + '"/>');
      s.push('<rect x="346" y="50" width="4" height="22" fill="#111"/><rect x="368" y="48" width="4" height="22" fill="#111"/>');
      if (wing === 'biplane') s.push('<path d="M330 58 L382 56 L382 61 L330 62 Z" fill="#111"/>');
    } else if (wing === 'ducktail' || wing === 'lip-spoiler') {
      s.push('<path d="M340 70 L384 66 L382 74 L344 76 Z" fill="' + shade(paint, -0.4) + '"/>');
    }
    s.push('<path d="' + sh.body + '" fill="url(#' + id + 'p)" stroke="rgba(0,0,0,.6)" stroke-width="1.2"/>');
    s.push('<g clip-path="url(#' + id + 'c)">');
    if (stripe === 'racing-dual' || stripe === 'center' || stripe === 'le-mans' || stripe === 'hood') s.push('<rect x="0" y="66" width="400" height="7" fill="' + stripeColor + '" opacity=".9"/>');
    if (stripe === 'side-skirt' || stripe === 'le-mans' || stripe === 'gradient') s.push('<rect x="0" y="92" width="400" height="5" fill="' + stripeColor + '" opacity=".85"/>');
    if (stripe === 'pinstripe') s.push('<rect x="0" y="80" width="400" height="1.4" fill="' + stripeColor + '"/>');
    s.push('<rect x="0" y="30" width="400" height="34" fill="url(#' + id + 's)" class="gh-car-sheen"/>');
    s.push('<rect x="0" y="100" width="400" height="10" fill="#000" opacity=".35"/>');
    s.push('</g>');
    s.push('<path d="' + sh.glass + '" fill="url(#' + id + 'g)" stroke="rgba(0,0,0,.7)" stroke-width="1"/>');
    if (number) {
      s.push('<circle cx="200" cy="84" r="11" fill="#f4f1ea" stroke="#111" stroke-width="1.2"/>');
      s.push('<text x="200" y="88.5" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-weight="800" font-size="12" fill="#111">' + esc(String(number).slice(0, 3)) + '</text>');
    }
    s.push('<path d="M384 82 l6 2 l-1 6 l-7 -1 z" fill="#ffe7a8" class="gh-car-head"/>');
    s.push('<path d="M20 84 l-4 2 l1 6 l5 -1 z" fill="#ff2b2b" class="gh-car-tail"/>');
    sh.wheelbase.forEach(function (x) {
      var cy = 106 + lift * 0.0;
      s.push('<circle cx="' + x + '" cy="' + cy + '" r="' + (wr + 4) + '" fill="#050506"/>');
      s.push('<circle cx="' + x + '" cy="' + cy + '" r="' + wr + '" fill="#0d0d0f" stroke="#2a2a2e" stroke-width="2"/>');
      s.push('<g' + spin + ' style="transform-origin:' + x + 'px ' + cy + 'px">');
      s.push('<circle cx="' + x + '" cy="' + cy + '" r="' + (wr * 0.72) + '" fill="' + rim + '" stroke="' + shade(rim, 0.4) + '" stroke-width="1.2"/>');
      for (var k = 0; k < spokes; k++) {
        var a = (k / spokes) * Math.PI * 2;
        s.push('<line x1="' + x + '" y1="' + cy + '" x2="' + (x + Math.cos(a) * wr * 0.68).toFixed(1) + '" y2="' + (cy + Math.sin(a) * wr * 0.68).toFixed(1) + '" stroke="' + shade(rim, 0.55) + '" stroke-width="2.2" stroke-linecap="round"/>');
      }
      s.push('<circle cx="' + x + '" cy="' + cy + '" r="' + (wr * 0.16) + '" fill="#111" stroke="' + shade(rim, 0.6) + '"/>');
      s.push('</g>');
      s.push('<path d="M' + (x + wr * 0.3) + ' ' + (cy - wr * 0.55) + ' a ' + (wr * 0.62) + ' ' + (wr * 0.62) + ' 0 0 1 ' + (wr * 0.3) + ' ' + (wr * 0.45) + '" stroke="' + caliper + '" stroke-width="5" fill="none" stroke-linecap="round"/>');
    });
    s.push('</g></svg>');
    return s.join('');
  }
  function shade(hex, pctv) {
    if (CB.util && typeof CB.util.shade === 'function') {
      var r0 = safe(function () { return CB.util.shade(hex, pctv * 100); }, null);
      if (typeof r0 === 'string' && /^#/.test(r0)) return r0;
    }
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return hex || '#888';
    var v = parseInt(m[1], 16), r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    var f = function (c) { return Math.round(pctv >= 0 ? c + (255 - c) * pctv : c * (1 + pctv)); };
    return '#' + [f(r), f(g), f(b)].map(function (c) { return ('0' + clamp(c, 0, 255).toString(16)).slice(-2); }).join('');
  }
  /** Car art: CB.render.thumbnail if present (and it returns SVG markup), else our side-view SVG. */
  function carArt(build, opts) {
    if (!build) return '<div class="gh-car-empty">No car</div>';
    if (!(opts && opts.own) && CB.render && typeof CB.render.thumbnail === 'function') {
      var t = safe(function () { return CB.render.thumbnail(build, opts); }, null);
      if (typeof t === 'string' && t.indexOf('<svg') >= 0) return t;
    }
    return carSVG(build, opts);
  }

  /* ======================================================================
     Styles (injected once as <style id="game-hub-styles">)
     ====================================================================== */
  var CSS = `
#game-hub{--gh-bg:var(--bg,#0b0b0d);--gh-bg2:var(--bg-2,#111114);--gh-panel:var(--panel,#141519);--gh-panel2:var(--panel-2,#1b1c21);--gh-line:var(--line,#2b2c33);
--gh-line2:var(--line-2,#3a3b44);--gh-text:var(--text,#ecebe6);--gh-dim:var(--text-dim,#9b9890);--gh-mute:var(--text-faint,#6c6a64);--gh-accent:var(--accent,#c9a56b);--gh-accent2:var(--accent-hi,#e7cd9a);--gh-hot:var(--race,#e0412f);
--gh-good:var(--good,#3fbf7f);--gh-warn:var(--warn,#e3a33a);--gh-bad:var(--bad,#e5484d);--gh-blue:var(--accent-2,#6aa6d8);--gh-font:var(--font,"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);
--gh-mono:var(--mono,"SF Mono",ui-monospace,Menlo,Consolas,monospace);--gh-r:var(--radius,12px);--gh-r-sm:var(--radius-sm,9px);--gh-cut:0px;
position:fixed;inset:0;z-index:9000;background:var(--gh-bg);color:var(--gh-text);font:14px/1.5 var(--gh-font);display:flex;flex-direction:column;overflow:hidden;
-webkit-font-smoothing:antialiased;user-select:none;-webkit-user-select:none}
#game-hub.is-routed{position:absolute;z-index:auto}
#game-hub *{box-sizing:border-box}
#game-hub button{font:inherit;color:inherit}
#game-hub .gh-num{font-family:var(--gh-mono);font-variant-numeric:tabular-nums}
#game-hub .gh-bgfx{position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none}
#game-hub.is-routed:not([data-screen="title"]):not([data-screen="menu"]) .gh-bgfx{opacity:0}
#game-hub .gh-carbon{position:absolute;inset:0;z-index:0;pointer-events:none;
background-image:radial-gradient(120% 80% at 50% -10%,var(--studio-spot,rgba(201,165,107,.13)),transparent 60%),radial-gradient(90% 70% at 100% 100%,var(--studio-spot-2,rgba(106,166,216,.07)),transparent 60%),var(--noise,none)}
#game-hub .gh-top{position:relative;z-index:3;display:flex;align-items:center;gap:18px;height:56px;padding:0 28px;border-bottom:1px solid var(--gh-line);
background:var(--glass,rgba(18,19,23,.72));backdrop-filter:saturate(160%) blur(18px)}
#game-hub.is-routed .gh-top{height:44px}#game-hub.is-routed .gh-brand,#game-hub.is-routed .gh-wallet{display:none}
#game-hub .gh-brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.24em;font-size:14px;cursor:pointer;background:none;border:0;padding:6px 0}
#game-hub .gh-brand i{display:block;width:22px;height:22px;border-radius:6px;background:var(--accent-grad,linear-gradient(135deg,#f1dcae,#c9a56b))}
#game-hub .gh-brand small{white-space:nowrap;font-weight:500;letter-spacing:.2em;color:var(--gh-dim);font-size:10px;margin-left:4px}
#game-hub .gh-crumbs{display:flex;align-items:center;gap:8px;color:var(--gh-dim);font-size:12px;letter-spacing:.14em;text-transform:uppercase;min-width:0;overflow:hidden;white-space:nowrap}
#game-hub .gh-crumbs b{color:var(--gh-text);font-weight:700}
#game-hub .gh-crumbs span::before{content:"/";margin-right:8px;color:var(--gh-mute)}#game-hub .gh-crumbs span.first::before{content:none}
#game-hub .gh-crumb{all:unset;cursor:pointer;color:inherit;letter-spacing:inherit;border-radius:3px;transition:color .15s}#game-hub .gh-crumb:hover,#game-hub .gh-crumb:focus-visible{color:var(--gh-text);text-decoration:underline;text-underline-offset:3px}
#game-hub .gh-spacer{flex:1}
#game-hub .gh-wallet{display:flex;align-items:center;gap:14px;flex-shrink:0}#game-hub .gh-driver-txt{white-space:nowrap}#game-hub .gh-crumbs .gh-crumb-gap{color:var(--gh-mute);letter-spacing:.05em}
#game-hub .gh-credits{white-space:nowrap;font-family:var(--gh-mono);font-size:14px;font-weight:650;color:var(--gh-accent);padding:6px 12px;border:1px solid var(--gh-line);border-radius:var(--pill,999px);
background:var(--accent-softer,rgba(201,165,107,.07));transition:color .3s}
#game-hub .gh-credits.is-bump{animation:gh-bump .6s}
@keyframes gh-bump{0%{transform:scale(1)}30%{transform:scale(1.08);color:#fff}100%{transform:scale(1)}}
#game-hub .gh-driver{display:flex;align-items:center;gap:10px;background:none;border:0;cursor:pointer;padding:4px;border-radius:30px}
#game-hub .gh-avatar{position:relative;width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:13px;color:#111}
#game-hub .gh-avatar svg{position:absolute;inset:-4px;width:46px;height:46px;transform:rotate(-90deg)}
#game-hub .gh-driver-txt{text-align:left;line-height:1.15}
#game-hub .gh-driver-txt b{display:block;font-size:13px}
#game-hub .gh-driver-txt small{color:var(--gh-dim);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
#game-hub .gh-main{position:relative;z-index:2;flex:1;overflow:auto;overflow-x:hidden;scroll-behavior:smooth;scrollbar-width:thin;scrollbar-color:#333 transparent}
#game-hub .gh-screen{padding:28px 40px 60px;max-width:1500px;margin:0 auto;animation:gh-in .42s cubic-bezier(.2,.8,.2,1) both}
#game-hub.is-back .gh-screen{animation-name:gh-in-back}
@keyframes gh-in{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}
@keyframes gh-in-back{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:none}}
#game-hub .gh-foot{position:relative;z-index:3;display:flex;align-items:center;gap:22px;height:40px;padding:0 28px;border-top:1px solid var(--gh-line);
font-size:11.5px;color:var(--gh-dim);background:var(--glass,rgba(18,19,23,.72))}
#game-hub .gh-foot kbd{display:inline-grid;place-items:center;min-width:22px;height:20px;padding:0 6px;margin-right:6px;border:1px solid var(--gh-line2);border-bottom-width:2px;border-radius:5px;
font:600 10px var(--gh-mono);color:var(--gh-text);background:var(--gh-panel2)}
#game-hub .gh-foot kbd.pad{border-radius:50%;min-width:20px;padding:0}
#game-hub .gh-foot kbd.pad-a{background:#1d7a3e;border-color:#3ecf8e}#game-hub .gh-foot kbd.pad-b{background:#7a1d1d;border-color:#ff5d5d}
#game-hub .gh-status{margin-left:auto;display:flex;gap:14px;align-items:center}
#game-hub .gh-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:var(--gh-mute)}
#game-hub .gh-dot.on{background:var(--gh-good);box-shadow:0 0 8px var(--gh-good)}
/* headings */
#game-hub .gh-h1{font-size:32px;line-height:1.1;font-weight:650;letter-spacing:-.02em;margin:0 0 6px;font-family:var(--serif,var(--gh-font))}
#game-hub .gh-h1 em{font-style:normal;color:var(--gh-accent)}
#game-hub .gh-kicker{display:flex;align-items:center;gap:10px;font-size:10.5px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--gh-accent);margin-bottom:8px}
#game-hub .gh-kicker::before{content:"";width:18px;height:2px;border-radius:2px;background:var(--accent-grad,var(--gh-accent))}
#game-hub .gh-sub{color:var(--gh-dim);max-width:720px;margin:0 0 26px}
#game-hub .gh-h2{font-size:11px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--gh-dim);margin:30px 0 12px;display:flex;align-items:center;gap:12px}
#game-hub .gh-h2::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--gh-line2),transparent)}
#game-hub .gh-head{display:flex;align-items:flex-end;gap:24px;flex-wrap:wrap;margin-bottom:8px}
#game-hub .gh-head > div:first-child{flex:1;min-width:280px}
/* buttons */
/* .gh-btn renders exactly like the Atelier's .cb-btn (css/styles.css § 04) */
#game-hub .gh-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;height:auto;padding:0 16px;border:1px solid var(--gh-line);
background:linear-gradient(180deg,var(--panel-3,#22232a),var(--gh-panel2));color:var(--gh-text);font-weight:600;font-size:13px;letter-spacing:.015em;cursor:pointer;text-decoration:none;
border-radius:var(--gh-r-sm);box-shadow:0 1px 0 rgba(255,255,255,.04) inset,var(--shadow-sm,0 1px 2px rgba(0,0,0,.4));transition:background .2s,border-color .2s,transform .12s,color .2s;outline:none;white-space:nowrap}
#game-hub .gh-btn:hover{border-color:color-mix(in srgb,var(--gh-accent) 45%,var(--gh-line));color:var(--text-strong,#fff)}
#game-hub .gh-btn:active{transform:translateY(1px) scale(.985)}
#game-hub .gh-btn.primary{background:var(--accent-grad,linear-gradient(135deg,#f1dcae,#c9a56b));background-size:160% 160%;color:var(--accent-ink,#17130b);border-color:transparent;
box-shadow:0 1px 0 rgba(255,255,255,.35) inset,0 8px 22px -10px var(--accent-ring,rgba(201,165,107,.45))}
#game-hub .gh-btn.primary:hover{background-position:100% 50%;color:var(--accent-ink,#17130b);transform:translateY(-1px)}
#game-hub .gh-btn.hot{background:linear-gradient(135deg,var(--race-2,#ff7a45),var(--gh-hot));border-color:transparent;color:#fff;box-shadow:0 8px 22px -10px var(--gh-hot)}
#game-hub .gh-btn.ghost{background:transparent;border-color:transparent;box-shadow:none;color:var(--gh-dim)}
#game-hub .gh-btn.ghost:hover{background:var(--gh-panel2);border-color:var(--gh-line);color:var(--gh-text)}
#game-hub .gh-btn.danger{border-color:color-mix(in srgb,var(--gh-bad) 50%,transparent);color:var(--gh-bad);background:var(--bad-soft,rgba(229,72,77,.14))}
#game-hub .gh-btn.small{min-height:28px;height:auto;padding:0 10px;font-size:12px;border-radius:7px}
#game-hub .gh-btn[disabled]{opacity:.38;cursor:not-allowed;filter:grayscale(.6)}
#game-hub .gh-btns{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
/* focus */
#game-hub [data-nav]{outline:none}
#game-hub .is-focus,#game-hub [data-nav]:focus-visible{box-shadow:var(--focus,0 0 0 2px #0b0b0d,0 0 0 4px #c9a56b)!important;z-index:2}
#game-hub .gh-btn.is-focus,#game-hub .gh-btn:focus-visible{border-color:var(--gh-accent)}
/* panels & cards */
#game-hub .gh-panel{position:relative;background:linear-gradient(180deg,var(--gh-panel2),var(--gh-panel));border:1px solid var(--gh-line);border-radius:var(--gh-r);padding:20px;box-shadow:var(--shadow,none)}
#game-hub .gh-panel.cut{clip-path:none}
#game-hub .gh-grid{display:grid;gap:16px}
#game-hub .gh-grid.c2{grid-template-columns:repeat(2,minmax(0,1fr))}
#game-hub .gh-grid.c3{grid-template-columns:repeat(3,minmax(0,1fr))}
#game-hub .gh-grid.c4{grid-template-columns:repeat(4,minmax(0,1fr))}
#game-hub .gh-grid.auto{grid-template-columns:repeat(auto-fill,minmax(270px,1fr))}
/* .gh-card renders like the Atelier's .cb-card (css/styles.css § 10) */
#game-hub .gh-card{position:relative;display:flex;flex-direction:column;text-align:left;color:var(--gh-text);background:linear-gradient(180deg,var(--gh-panel2),var(--gh-panel));
border:1px solid var(--gh-line);border-radius:var(--gh-r);padding:18px;cursor:pointer;transition:transform .2s var(--ease,ease),border-color .2s,box-shadow .32s,background .2s;overflow:hidden;min-width:0}
#game-hub .gh-card:hover,#game-hub .gh-card.is-focus{transform:translateY(-2px);border-color:color-mix(in srgb,var(--gh-accent) 38%,var(--gh-line));box-shadow:0 14px 30px -18px rgba(0,0,0,.8),0 0 0 1px var(--accent-softer,transparent)}
#game-hub .gh-card.is-locked{cursor:default;filter:saturate(.25);opacity:.62}
#game-hub .gh-card.is-locked:hover{transform:none}
#game-hub .gh-card h3{margin:0 0 4px;font-size:16px;font-weight:650;letter-spacing:-.01em}
#game-hub .gh-card p{margin:0;color:var(--gh-dim);font-size:12.5px}
#game-hub .gh-card .gh-card-foot{margin-top:auto;padding-top:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
#game-hub .gh-card .gh-stripe{position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--c,var(--gh-accent))}
/* chips = the Atelier's .cb-badge */
#game-hub .gh-chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:var(--pill,999px);font-size:11px;font-weight:650;letter-spacing:.02em;
background:var(--gh-panel2);border:1px solid var(--gh-line);color:var(--gh-dim);white-space:nowrap}
#game-hub .gh-chip.good{color:var(--gh-good);border-color:color-mix(in srgb,var(--gh-good) 40%,transparent);background:var(--good-soft,rgba(63,191,127,.13))}
#game-hub .gh-chip.warn{color:var(--gh-warn);border-color:color-mix(in srgb,var(--gh-warn) 40%,transparent);background:var(--warn-soft,rgba(227,163,58,.13))}
#game-hub .gh-chip.bad{color:var(--gh-bad);border-color:color-mix(in srgb,var(--gh-bad) 40%,transparent);background:var(--bad-soft,rgba(229,72,77,.14))}
#game-hub .gh-chip.gold{color:var(--accent-ink,#17130b);background:var(--accent-grad,var(--gh-accent));border-color:transparent}
#game-hub .gh-pi{display:inline-flex;align-items:stretch;height:22px;font:800 11px var(--gh-mono);border-radius:6px;overflow:hidden;border:1px solid var(--gh-line2)}
#game-hub .gh-pi b{background:var(--c);color:#0b0b0b;padding:0 6px;display:grid;place-items:center}
#game-hub .gh-pi span{padding:0 6px;display:grid;place-items:center;background:var(--gh-panel2);color:var(--gh-text)}
#game-hub .gh-pi i{font:700 10px var(--gh-font);font-style:normal;letter-spacing:.06em;text-transform:uppercase;padding:0 7px;display:grid;place-items:center;background:var(--gh-panel2);color:var(--gh-dim);border-right:1px solid var(--gh-line2)}
#game-hub .gh-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 18px;font-size:13px}
#game-hub .gh-kv dt{color:var(--gh-dim)}#game-hub .gh-kv dd{margin:0;text-align:right;font-family:var(--gh-mono);font-variant-numeric:tabular-nums}
#game-hub .gh-bar{position:relative;height:6px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden}
#game-hub .gh-bar i{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,var(--gh-accent),var(--gh-accent2));border-radius:3px;transition:width .6s cubic-bezier(.2,.8,.2,1)}
#game-hub .gh-bar.good i{background:var(--gh-good)}#game-hub .gh-bar.warn i{background:var(--gh-warn)}#game-hub .gh-bar.bad i{background:var(--gh-bad)}
#game-hub .gh-empty{padding:40px;text-align:center;color:var(--gh-dim);border:1px dashed var(--gh-line2);border-radius:var(--gh-r);background:var(--gh-bg2)}
#game-hub .gh-empty b{display:block;color:var(--gh-text);font-size:16px;margin-bottom:6px}
#game-hub .gh-loading{display:flex;align-items:center;gap:14px;padding:26px;border:1px solid var(--gh-line);border-radius:var(--gh-r);background:var(--gh-panel);color:var(--gh-dim)}
#game-hub .gh-loading::before{content:"";width:22px;height:22px;border-radius:50%;border:2px solid var(--gh-line2);border-top-color:var(--gh-accent);animation:gh-spin 1s linear infinite;flex:none}
#game-hub .gh-loading b{color:var(--gh-text)}
@keyframes gh-spin{to{transform:rotate(360deg)}}
/* title */
#game-hub .gh-title{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;overflow:hidden}
#game-hub .gh-title-logo{position:relative;font-size:clamp(52px,11.5vw,170px);font-weight:700;letter-spacing:.04em;line-height:.9;display:flex;margin-top:-6vh}
#game-hub .gh-title-logo span{display:inline-block;background:var(--accent-grad,linear-gradient(180deg,#fff 0%,#e9e3d6 38%,#8d877a 52%,#efe7d6 64%,#a8a091 100%));-webkit-background-clip:text;background-clip:text;color:transparent;
filter:drop-shadow(0 10px 30px rgba(0,0,0,.6));opacity:0;transform:translateY(40px);animation:gh-letter .9s cubic-bezier(.2,.9,.2,1) forwards}
#game-hub .gh-title-logo::after{content:"REDLINE";position:absolute;inset:0;display:flex;letter-spacing:inherit;color:transparent;-webkit-text-fill-color:transparent;
background:linear-gradient(105deg,transparent 42%,rgba(255,255,255,.5) 50%,transparent 58%) no-repeat;background-size:250% 100%;background-position:150% 0;-webkit-background-clip:text;background-clip:text;
opacity:0;animation:gh-fade .01s 1.4s forwards,gh-sheen 4.5s 1.4s ease-in-out infinite;pointer-events:none}
#game-hub .gh-title-logo span.is-red{background:linear-gradient(180deg,#ff8a6a 0%,#ff4b33 40%,#c22a17 58%,#ff6a4d 72%,#a8200f 100%);-webkit-background-clip:text;background-clip:text}
@keyframes gh-letter{to{opacity:1;transform:none}}
@keyframes gh-sheen{0%{background-position:150% 0}55%,100%{background-position:-60% 0}}
#game-hub .gh-title-tag{margin-top:14px;font-size:13px;letter-spacing:.7em;text-transform:uppercase;color:var(--gh-accent);opacity:0;animation:gh-fade 1s 1s forwards;padding-left:.7em}
#game-hub .gh-title-car{position:relative;width:min(760px,80vw);margin-top:3vh;opacity:0;transform:translateX(-60px);animation:gh-car-in 1.3s .5s cubic-bezier(.15,.85,.25,1) forwards}
#game-hub .gh-title-car svg{width:100%;height:auto;display:block;filter:drop-shadow(0 30px 40px rgba(0,0,0,.7))}
#game-hub .gh-title-car::after{content:"";position:absolute;left:5%;right:5%;bottom:-6%;height:30%;background:radial-gradient(closest-side,rgba(212,176,106,.22),transparent);filter:blur(10px);z-index:-1}
@keyframes gh-car-in{to{opacity:1;transform:none}}
#game-hub .gh-title-press{margin-top:5vh;font-size:12px;letter-spacing:.42em;text-transform:uppercase;color:var(--gh-text);opacity:0;animation:gh-fade .8s 1.8s forwards,gh-pulse 2s 2.6s ease-in-out infinite}
@keyframes gh-fade{to{opacity:1}}
@keyframes gh-pulse{0%,100%{opacity:1}50%{opacity:.35}}
#game-hub .gh-title-meta{position:absolute;bottom:22px;left:28px;right:28px;display:flex;justify-content:space-between;font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--gh-mute)}
#game-hub .gh-wheel-spin{animation:gh-spin .5s linear infinite}
#game-hub .gh-car-sheen{animation:gh-carsheen 5s ease-in-out infinite}
@keyframes gh-carsheen{0%,100%{transform:translateX(-30%)}50%{transform:translateX(30%)}}
/* menu (home): hero with the build + Quick race / Continue career, mode tiles, compact rows */
#game-hub .gh-home{display:flex;flex-direction:column;max-width:1400px;margin:0 auto}
#game-hub .gh-home .gh-h2{margin:26px 0 12px}
#game-hub .gh-home-hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:32px;align-items:center;padding:28px 32px;border:1px solid var(--gh-line);border-radius:var(--radius-xl,22px);
background:radial-gradient(90% 120% at 85% 60%,var(--accent-softer,rgba(201,165,107,.07)),transparent 60%),linear-gradient(180deg,var(--gh-panel2),var(--gh-panel));box-shadow:var(--shadow,none);overflow:hidden}
#game-hub .gh-home-hero::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,var(--gh-accent),var(--gh-hot) 70%,transparent)}
#game-hub .gh-home-txt{min-width:0;display:flex;flex-direction:column;gap:12px}
#game-hub .gh-home-txt .gh-kicker{margin:0}
#game-hub .gh-hero-name{font-size:var(--fs-3xl,38px);font-weight:600;letter-spacing:-.02em;line-height:1.05;font-family:var(--serif,var(--gh-font));overflow-wrap:anywhere}
#game-hub .gh-home-chips{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#game-hub .gh-home-cta{display:flex;gap:10px;flex-wrap:wrap;align-items:stretch;margin-top:6px}
#game-hub .gh-btn.big{min-height:var(--control-h-lg,46px);padding:6px 18px;font-size:14px;border-radius:12px;text-align:left;gap:10px}
#game-hub .gh-btn.big>span{display:flex;flex-direction:column;line-height:1.2}
#game-hub .gh-btn.big small{font-size:11px;font-weight:500;letter-spacing:0;opacity:.72;white-space:nowrap}
#game-hub .gh-home-prog{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:1px;margin-top:10px;background:var(--gh-line);border:1px solid var(--gh-line);border-radius:var(--gh-r);overflow:hidden}
#game-hub .gh-home-prog>div{background:var(--gh-panel);padding:10px 14px;min-width:0;font-size:12.5px}
#game-hub .gh-home-lv{display:grid;grid-template-columns:1fr auto;gap:6px 10px;align-items:center}
#game-hub .gh-home-lv .gh-num{color:var(--gh-dim);font-size:11px}
#game-hub .gh-home-lv .gh-bar{grid-column:1/-1}
#game-hub .gh-home-stat small{display:block;font-size:var(--fs-2xs,10.5px);font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--gh-dim);margin-bottom:2px}
#game-hub .gh-home-stat span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#game-hub .gh-home-car{min-width:0}
#game-hub .gh-home-car .car{position:relative;margin:-6px 0 12px}
#game-hub .gh-home-car .car::after{content:"";position:absolute;left:8%;right:8%;bottom:2%;height:16%;background:radial-gradient(closest-side,rgba(0,0,0,.45),transparent);z-index:-1}
#game-hub .gh-home-car .car svg{width:100%;max-width:720px;height:auto;display:block;margin:0 auto;filter:drop-shadow(0 24px 30px rgba(0,0,0,.55))}
#game-hub .gh-home-car .car.is-3d::after{content:none}
#game-hub .gh-hero-img{display:block;width:100%;max-width:760px;height:auto;margin:0 auto;animation:gh-fade .35s both;opacity:0;
-webkit-mask-image:radial-gradient(75% 85% at 50% 48%,#000 62%,transparent 100%);mask-image:radial-gradient(75% 85% at 50% 48%,#000 62%,transparent 100%)}
#game-hub .gh-hero-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--gh-line);border:1px solid var(--gh-line);border-radius:var(--gh-r);overflow:hidden;margin-top:6px}
#game-hub .gh-hero-stats div{background:var(--gh-panel);padding:10px 14px}
#game-hub .gh-hero-stats b{display:block;font:700 18px var(--gh-mono);font-variant-numeric:tabular-nums}
#game-hub .gh-hero-stats small{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--gh-dim)}
#game-hub .gh-modes{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:12px}
#game-hub .gh-mode{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-height:132px;padding:16px;text-align:left;cursor:pointer;overflow:hidden;
border:1px solid var(--gh-line);border-radius:var(--gh-r);background:linear-gradient(165deg,var(--mcs,var(--accent-soft)),transparent 62%),linear-gradient(180deg,var(--gh-panel2),var(--gh-panel));
transition:transform .2s var(--ease,ease),border-color .2s,box-shadow .25s}
#game-hub .gh-mode::before{content:"";position:absolute;left:16px;right:16px;top:0;height:2px;border-radius:0 0 2px 2px;background:var(--mc,var(--gh-accent));opacity:.85}
#game-hub .gh-mode-art{position:absolute;right:-22px;bottom:-26px;color:var(--mc,var(--gh-accent));opacity:.07;transition:opacity .25s,transform .35s var(--ease-out,ease)}
#game-hub .gh-mode-ic{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;margin-bottom:auto;color:var(--mc,var(--gh-accent));background:var(--mcs,var(--accent-soft));border:1px solid color-mix(in srgb,var(--mc,var(--gh-accent)) 30%,transparent)}
#game-hub .gh-mode-lbl{position:relative;margin-top:14px;font-size:16px;font-weight:650;letter-spacing:-.01em;line-height:1.2;white-space:nowrap}
#game-hub .gh-mode-ds{position:relative;font-size:11.5px;color:var(--gh-dim);line-height:1.35;min-height:2.7em}
#game-hub .gh-mode:hover,#game-hub .gh-mode.is-focus{transform:translateY(-3px);border-color:color-mix(in srgb,var(--mc,var(--gh-accent)) 55%,var(--gh-line));box-shadow:0 18px 36px -22px var(--mc,var(--gh-accent))}
#game-hub .gh-mode:hover .gh-mode-art,#game-hub .gh-mode.is-focus .gh-mode-art{opacity:.18;transform:rotate(-6deg) scale(1.05)}
#game-hub .gh-mode:active{transform:translateY(-1px) scale(.99)}
#game-hub .gh-links{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
#game-hub .gh-link,#game-hub .gh-mode,#game-hub .gh-home-cta .gh-btn{min-width:0}
#game-hub .gh-link{display:flex;align-items:center;gap:12px;min-height:58px;padding:10px 12px;text-align:left;cursor:pointer;border:1px solid var(--gh-line);border-radius:var(--gh-r-sm);
background:var(--gh-panel);transition:border-color .2s,background .2s}
#game-hub .gh-link-ic{display:grid;place-items:center;flex:none;width:34px;height:34px;border-radius:9px;background:var(--gh-panel2);color:var(--gh-accent);border:1px solid var(--gh-line)}
#game-hub .gh-link-txt{min-width:0;flex:1}
#game-hub .gh-link-txt b{display:block;font-size:13.5px;font-weight:650}
#game-hub .gh-link-txt small{display:block;font-size:11.5px;color:var(--gh-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#game-hub .gh-link-go{color:var(--gh-mute);transition:transform .2s,color .2s}
#game-hub .gh-link:hover,#game-hub .gh-link.is-focus{border-color:color-mix(in srgb,var(--gh-accent) 40%,var(--gh-line));background:var(--gh-panel2)}
#game-hub .gh-link:hover .gh-link-go,#game-hub .gh-link.is-focus .gh-link-go{transform:translateX(3px);color:var(--gh-accent)}
#game-hub .gh-home .badge{font:700 10px var(--gh-mono);padding:2px 7px;border-radius:10px;background:var(--gh-accent);color:var(--accent-ink,#17130b);margin-left:8px;vertical-align:2px;font-style:normal}
@media (max-width:1179px){#game-hub .gh-modes{grid-template-columns:repeat(4,minmax(0,1fr))}}
#game-hub .gh-home-lv>span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media (max-width:1100px){#game-hub .gh-home-hero{grid-template-columns:1fr;gap:8px}#game-hub .gh-home-car{order:-1}#game-hub .gh-home-car .car svg{max-width:520px}#game-hub .gh-links{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:640px){#game-hub .gh-home-hero{padding:18px 16px;border-radius:var(--radius-lg,16px)}#game-hub .gh-hero-name{font-size:26px}
#game-hub .gh-home-cta{display:grid;grid-template-columns:minmax(0,1fr)}#game-hub .gh-home-cta .gh-btn{justify-content:flex-start}
#game-hub .gh-home-prog{grid-template-columns:1fr 1fr}#game-hub .gh-home-lv{grid-column:1/-1}
#game-hub .gh-hero-stats div{padding:8px 10px}#game-hub .gh-hero-stats b{font-size:15px}#game-hub .gh-hero-stats small{font-size:9px;letter-spacing:.1em}
#game-hub .gh-modes{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}#game-hub .gh-mode{min-height:112px;padding:14px}#game-hub .gh-mode-lbl{margin-top:10px}
#game-hub .gh-links{grid-template-columns:minmax(0,1fr)}
#game-hub .gh-btn.big small{white-space:normal}#game-hub .gh-home-hero{grid-template-columns:minmax(0,1fr)}
#game-hub .gh-title-tag{letter-spacing:.36em;font-size:11px;padding-left:.36em;text-align:center}}
@media (max-height:520px) and (min-width:641px){#game-hub .gh-home-hero{grid-template-columns:1fr 1fr;padding:16px 20px}#game-hub .gh-home-car{order:0}#game-hub .gh-hero-name{font-size:24px}#game-hub .gh-home-prog{display:none}}
/* tabs */
/* tabs = the Atelier's .cb-tab-list / .cb-tab */
#game-hub .gh-tabs{display:inline-flex;gap:2px;padding:3px;background:var(--gh-bg2);border:1px solid var(--gh-line);border-radius:12px;margin:6px 0 22px;overflow-x:auto;max-width:100%}
#game-hub .gh-tabs>.gh-tab{flex:none}
#game-hub .gh-tabs.gh-tabs-wrap{flex-wrap:wrap;overflow:visible;row-gap:2px}
#game-hub .gh-tab{position:relative;min-height:32px;padding:0 14px;background:none;border:1px solid transparent;border-radius:9px;cursor:pointer;color:var(--gh-dim);font-weight:650;font-size:12.5px;white-space:nowrap}
#game-hub .gh-tab:hover{color:var(--gh-text);background:var(--gh-panel2)}
#game-hub .gh-tab.is-active{color:var(--text-strong,#fff);background:linear-gradient(180deg,var(--panel-3,#22232a),var(--gh-panel2));border-color:var(--gh-line)}
#game-hub .gh-tab.is-active::after{content:"";position:absolute;left:30%;right:30%;bottom:3px;height:2px;border-radius:2px;background:var(--accent-grad,var(--gh-accent))}
#game-hub .gh-tab .k{font:600 9px var(--gh-mono);color:var(--gh-mute);margin-left:6px}
/* career map */
#game-hub .gh-tiermap{position:relative;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px;margin:10px 0 6px}
#game-hub .gh-tier{position:relative;padding:18px 16px 16px;min-height:170px;border:1px solid var(--gh-line);background:linear-gradient(160deg,rgba(255,255,255,.05),rgba(255,255,255,.01));
cursor:pointer;text-align:left;border-radius:var(--gh-r);transition:transform .2s,background .2s}
#game-hub .gh-tier:hover,#game-hub .gh-tier.is-focus{transform:translateY(-3px);background:linear-gradient(160deg,rgba(255,255,255,.09),rgba(255,255,255,.02))}
#game-hub .gh-tier.is-active{border-color:var(--c);background:linear-gradient(160deg,color-mix(in srgb,var(--c) 18%,transparent),rgba(255,255,255,.01))}
#game-hub .gh-tier .n{font:650 42px/1 var(--serif,var(--gh-font));color:var(--c);opacity:.9}
#game-hub .gh-tier h3{margin:8px 0 6px;font-size:15px;font-weight:650;letter-spacing:-.005em}
#game-hub .gh-tier .lock{position:absolute;top:14px;right:22px;color:var(--gh-dim)}
#game-hub .gh-tier.is-locked{opacity:.5}
#game-hub .gh-tier .gh-bar{margin-top:12px}
#game-hub .gh-tier-link{position:absolute;top:50%;right:-14px;width:14px;height:2px;background:var(--gh-line2)}
#game-hub .gh-champ .gh-art{height:110px;margin:-18px -18px 14px;position:relative;overflow:hidden;background:linear-gradient(135deg,color-mix(in srgb,var(--c) 30%,#0b0b0d),#0b0b0d 70%)}
#game-hub .gh-champ .gh-art .gh-track-svg{position:absolute;right:10px;top:8px;color:rgba(255,255,255,.75)}
#game-hub .gh-champ .gh-art .rounds{position:absolute;left:16px;bottom:12px;font:650 32px/1 var(--serif,var(--gh-font));color:#f3f1ea}
#game-hub .gh-champ .gh-art .rounds small{font-size:11px;letter-spacing:.2em;font-style:normal;color:rgba(243,241,234,.62);margin-left:6px}
#game-hub .gh-reasons{margin:10px 0 0;padding:10px 12px;border-left:3px solid var(--gh-bad);background:rgba(255,93,93,.06);font-size:12px;color:color-mix(in srgb,var(--gh-bad) 55%,var(--gh-text));list-style:none}
#game-hub .gh-reasons li+li{margin-top:3px}
#game-hub .gh-ok{margin:10px 0 0;padding:8px 12px;border-left:3px solid var(--gh-good);background:rgba(62,207,142,.06);font-size:12px;color:#aef3d0}
/* calendar */
#game-hub .gh-cal{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}
#game-hub .gh-round{position:relative;padding:14px;border:1px solid var(--gh-line);background:linear-gradient(180deg,var(--gh-panel2),var(--gh-panel));border-radius:var(--gh-r);text-align:left;cursor:pointer}
#game-hub .gh-round.is-done{opacity:.7}
#game-hub .gh-round.is-next{border-color:var(--gh-accent);background:linear-gradient(180deg,rgba(212,176,106,.12),rgba(212,176,106,.02))}
#game-hub .gh-round .r{font:800 11px var(--gh-mono);letter-spacing:.14em;color:var(--gh-accent)}
#game-hub .gh-round h4{margin:4px 0 2px;font-size:14px}
#game-hub .gh-round .res{position:absolute;top:12px;right:12px;font:800 15px var(--gh-mono)}
#game-hub .gh-round .gh-track-svg{display:block;margin:8px 0 4px;color:rgba(255,255,255,.6)}
#game-hub .gh-cal .gh-round{display:flex;flex-direction:column;min-width:0}
#game-hub .gh-round .r{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:30px}
#game-hub .gh-round h4{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:26px}
#game-hub .gh-round>small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#game-hub .gh-round-foot{display:flex;gap:6px;align-items:center;flex-wrap:nowrap;white-space:nowrap;overflow:hidden;color:var(--gh-dim);font-size:11.5px;margin-top:auto}
#game-hub .gh-round-foot>span{overflow:hidden;text-overflow:ellipsis}
#game-hub .gh-round-foot svg{flex:none}
#game-hub .gh-round-tag{height:18px;margin-top:6px;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#game-hub .gh-round-tag b{color:var(--gh-warn);font-weight:800}
/* tables */
#game-hub table.gh-table{width:100%;border-collapse:collapse;font-size:13px}
#game-hub .gh-table th{text-align:left;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--gh-dim);font-weight:700;padding:8px 10px;border-bottom:1px solid var(--gh-line2)}
#game-hub .gh-table td{padding:9px 10px;border-bottom:1px solid var(--gh-line)}
#game-hub .gh-table td.n,#game-hub .gh-table th.n{text-align:right;font-family:var(--gh-mono);font-variant-numeric:tabular-nums}
#game-hub .gh-table tr.is-player td{background:rgba(212,176,106,.12);color:#fff;font-weight:700}
#game-hub .gh-table tr.is-player td:first-child{box-shadow:inset 3px 0 0 var(--gh-accent)}
#game-hub .gh-pos{display:inline-grid;place-items:center;width:28px;height:24px;font:700 12px var(--gh-mono);background:var(--gh-panel2);border-radius:6px}
#game-hub .gh-pos.p1{background:linear-gradient(180deg,#ffe28a,#c99a22);color:#1a1200}
#game-hub .gh-pos.p2{background:linear-gradient(180deg,#f2f4f7,#9aa3ad);color:#111}
#game-hub .gh-pos.p3{background:linear-gradient(180deg,#f0b585,#a3602f);color:#1a0b00}
#game-hub .gh-swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:8px;vertical-align:middle;border:1px solid rgba(255,255,255,.3)}
/* briefing */
#game-hub .gh-brief{display:grid;grid-template-columns:1.25fr 1fr;gap:20px}
#game-hub .gh-brief-map{position:relative;min-height:320px;display:grid;place-items:center;background:radial-gradient(closest-side,rgba(212,176,106,.08),transparent),#0b0c0f}
#game-hub .gh-brief-map .gh-track-svg{color:#e9e3d6;max-width:100%;height:auto}
#game-hub .gh-brief-map .gh-track-runner{animation:gh-run 6s linear infinite}
@keyframes gh-run{to{stroke-dashoffset:-1000}}
#game-hub .gh-cond{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0}
#game-hub .gh-cond div{padding:12px;border:1px solid var(--gh-line);background:var(--gh-panel);border-radius:var(--gh-r-sm)}
#game-hub .gh-cond small{display:block;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--gh-dim)}
#game-hub .gh-cond b{font-size:16px}
/* rewards */
#game-hub .gh-rewards{display:grid;grid-template-columns:1fr 1fr;gap:22px}
#game-hub .gh-result-hero{position:relative;padding:28px;overflow:hidden;background:linear-gradient(135deg,rgba(212,176,106,.16),rgba(12,13,16,.95) 60%);border:1px solid rgba(212,176,106,.3)}
#game-hub .gh-result-pos{font:650 112px/0.9 var(--serif,var(--gh-font));letter-spacing:-.04em;background:linear-gradient(180deg,#fff,#d4b06a);-webkit-background-clip:text;background-clip:text;color:transparent}
#game-hub .gh-result-pos small{font-size:36px}
#game-hub .gh-count{font:800 44px/1 var(--gh-mono);font-variant-numeric:tabular-nums;color:var(--gh-accent2)}
#game-hub .gh-count.xp{color:#9fd0ff}
#game-hub .gh-breakdown{list-style:none;margin:14px 0 0;padding:0}
#game-hub .gh-breakdown li{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--gh-line);opacity:0;transform:translateX(-10px);transition:.35s}
#game-hub .gh-breakdown li.in{opacity:1;transform:none}
#game-hub .gh-breakdown li span:first-child{flex:1;color:var(--gh-dim)}
#game-hub .gh-breakdown li .c{font-family:var(--gh-mono);color:var(--gh-accent2);min-width:110px;text-align:right}
#game-hub .gh-breakdown li .x{font-family:var(--gh-mono);color:#9fd0ff;min-width:80px;text-align:right}
#game-hub .gh-xpbar{position:relative;height:10px;background:var(--gh-panel2);margin-top:12px;border-radius:10px;overflow:hidden}
#game-hub .gh-xpbar i{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#3987e5,#9fd0ff);box-shadow:0 0 18px rgba(57,135,229,.6)}
#game-hub .gh-levelup{position:fixed;inset:0;z-index:20;display:grid;place-items:center;pointer-events:none;background:radial-gradient(closest-side,rgba(212,176,106,.25),rgba(0,0,0,.75));animation:gh-fade .3s forwards}
#game-hub .gh-levelup.out{animation:gh-out .5s forwards}
@keyframes gh-out{to{opacity:0}}
#game-hub .gh-levelup .box{text-align:center;transform:scale(.6);animation:gh-pop .7s cubic-bezier(.2,1.6,.3,1) forwards}
#game-hub .gh-levelup .lv{font:650 150px/0.9 var(--serif,var(--gh-font));background:linear-gradient(180deg,#fff,#f3d9a0 40%,#d4b06a);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 0 30px rgba(212,176,106,.6))}
#game-hub .gh-levelup .t{font-size:14px;letter-spacing:.6em;text-transform:uppercase;color:var(--gh-accent2)}
#game-hub .gh-levelup canvas{position:absolute;inset:0;width:100%;height:100%}
@keyframes gh-pop{to{transform:none}}
/* garage */
#game-hub .gh-carcard .gh-art{height:150px;margin:-18px -18px 12px;display:grid;place-items:center;background:radial-gradient(ellipse at 50% 85%,rgba(212,176,106,.12),transparent 60%),linear-gradient(180deg,#15161b,#0b0c0f);border-bottom:1px solid var(--gh-line);position:relative}
#game-hub .gh-carcard .gh-art svg{width:88%;height:auto}
#game-hub .gh-carcard.is-active{border-color:var(--gh-accent)}
#game-hub .gh-carcard .act{position:absolute;top:10px;left:10px}
#game-hub .gh-carcard .gh-btns{margin-top:10px}
#game-hub .gh-cond-row{display:flex;align-items:center;gap:10px;margin-top:8px;font-size:11.5px;color:var(--gh-dim)}
#game-hub .gh-cond-row .gh-bar{flex:1}
/* workshop */
#game-hub .gh-ws{display:grid;grid-template-columns:1fr 360px;gap:22px}
#game-hub .gh-ws-group{margin-bottom:18px}
#game-hub .gh-ws-group h4{margin:0 0 8px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--gh-dim)}
#game-hub .gh-opts{display:flex;flex-wrap:wrap;gap:8px}
#game-hub .gh-opt{position:relative;padding:8px 12px;min-width:110px;border:1px solid var(--gh-line);background:var(--gh-panel);cursor:pointer;text-align:left;border-radius:var(--gh-r-sm)}
#game-hub .gh-opt b{display:block;font-size:12.5px}
#game-hub .gh-opt small{color:var(--gh-dim);font-family:var(--gh-mono);font-size:10.5px}
#game-hub .gh-opt.is-sel{border-color:var(--gh-accent);background:rgba(212,176,106,.12)}
#game-hub .gh-opt.is-orig::after{content:"FITTED";position:absolute;top:-7px;right:6px;font:700 8px var(--gh-mono);background:#2a2b30;padding:1px 4px;color:var(--gh-dim)}
#game-hub .gh-opt.is-locked{opacity:.45;cursor:not-allowed}
#game-hub .gh-opt.is-locked small{color:var(--gh-warn)}
/* settings */
#game-hub .gh-set{display:grid;grid-template-columns:minmax(0,1fr);gap:2px;max-width:900px}
#game-hub .gh-row{display:flex;align-items:center;gap:18px;padding:12px 16px;background:var(--gh-panel);border:1px solid var(--line-soft,transparent);border-left:3px solid transparent;border-radius:var(--gh-r-sm);min-height:56px}
#game-hub .gh-row:focus-within,#game-hub .gh-row.is-focus-row{border-left-color:var(--gh-accent);background:rgba(212,176,106,.06)}
#game-hub .gh-row > label,#game-hub .gh-row > .lbl{flex:1;min-width:0}
#game-hub .gh-row .lbl b{display:block;font-size:13.5px}
#game-hub .gh-row .lbl small{color:var(--gh-dim);font-size:11.5px}
/* segmented = the Atelier's .cb-seg */
#game-hub .gh-seg{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--gh-line);border-radius:10px;background:var(--gh-bg2);overflow:hidden}
#game-hub .gh-seg button{height:30px;padding:0 12px;border:0;border-radius:7px;background:transparent;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--gh-dim)}
#game-hub .gh-seg button:hover{color:var(--gh-text)}
#game-hub .gh-seg button.is-on{background:var(--accent-soft,rgba(201,165,107,.14));color:var(--gh-accent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--gh-accent) 40%,transparent)}
#game-hub .gh-switch{position:relative;width:46px;height:24px;border-radius:12px;border:1px solid var(--gh-line2);background:var(--gh-panel2);cursor:pointer;transition:background .2s;flex:none}
#game-hub .gh-switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#777;transition:.2s}
#game-hub .gh-switch.is-on{background:rgba(212,176,106,.35);border-color:var(--gh-accent)}
#game-hub .gh-switch.is-on::after{left:25px;background:var(--gh-accent2)}
#game-hub input[type=range].gh-range{-webkit-appearance:none;appearance:none;width:220px;height:4px;background:linear-gradient(90deg,var(--gh-accent) var(--v,50%),rgba(255,255,255,.12) var(--v,50%));border-radius:2px;outline:none}
#game-hub input[type=range].gh-range::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:3px solid var(--gh-accent);cursor:pointer}
#game-hub input[type=range].gh-range::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#fff;border:3px solid var(--gh-accent)}
#game-hub .gh-rv{width:48px;text-align:right;font-family:var(--gh-mono);color:var(--gh-dim)}
#game-hub input.gh-input{height:36px;padding:0 12px;border:1px solid var(--gh-line);background:var(--gh-bg2);color:var(--gh-text);font:inherit;border-radius:var(--gh-r-sm);min-width:220px;user-select:text;-webkit-user-select:text}
#game-hub input.gh-input:focus{border-color:var(--gh-accent);outline:none}
#game-hub .gh-keys{display:flex;gap:6px;flex-wrap:wrap}
#game-hub .gh-key{min-width:64px;height:32px;padding:0 10px;border:1px solid var(--gh-line2);border-bottom-width:3px;border-radius:6px;background:var(--gh-panel2);cursor:pointer;font:700 11.5px var(--gh-mono);color:var(--gh-text)}
#game-hub .gh-key.empty{color:var(--gh-mute);border-style:dashed}
#game-hub .gh-key.is-capturing{border-color:var(--gh-accent);color:var(--gh-accent2);animation:gh-pulse 1s infinite}
#game-hub .gh-colors{display:flex;gap:8px}
#game-hub .gh-color{width:28px;height:28px;border-radius:50%;border:2px solid transparent;cursor:pointer}
#game-hub .gh-color.is-on{border-color:#fff;box-shadow:0 0 0 2px var(--gh-accent)}
/* profile */
#game-hub .gh-tiles{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}
#game-hub .gh-tile{padding:16px;border:1px solid var(--gh-line);background:linear-gradient(180deg,var(--gh-panel2),var(--gh-panel));border-radius:var(--gh-r)}
#game-hub .gh-tile small{display:block;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--gh-dim);margin-bottom:6px}
#game-hub .gh-tile b{font:800 26px/1 var(--gh-mono);font-variant-numeric:tabular-nums}
#game-hub .gh-tile span{display:block;font-size:11.5px;color:var(--gh-dim);margin-top:6px}
#game-hub .gh-chart{position:relative;height:240px}
#game-hub .gh-chart canvas{position:absolute;inset:0;width:100%;height:100%}
#game-hub .gh-chart-tip{position:absolute;pointer-events:none;padding:7px 10px;background:#0b0c0f;border:1px solid var(--gh-line2);font-size:11.5px;border-radius:3px;white-space:nowrap;
transform:translate(-50%,calc(-100% - 12px));opacity:0;transition:opacity .12s;z-index:3}
#game-hub .gh-chart-tip b{font-family:var(--gh-mono)}
#game-hub .gh-chart-title{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}
#game-hub .gh-chart-title h3{margin:0;font-size:13px;letter-spacing:.14em;text-transform:uppercase}
#game-hub .gh-chart-title small{color:var(--gh-dim)}
#game-hub .gh-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--gh-dim);margin-top:8px}
#game-hub .gh-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
/* trophies */
#game-hub .gh-cabinet{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:18px;padding:26px;background:linear-gradient(180deg,#141518,#0c0d10);border:1px solid var(--gh-line);
box-shadow:inset 0 -30px 60px rgba(0,0,0,.6)}
#game-hub .gh-trophy{text-align:center;padding:14px 8px 10px;border-bottom:6px solid #23252b;position:relative}
#game-hub .gh-trophy svg{width:96px;height:120px;filter:drop-shadow(0 8px 14px rgba(0,0,0,.6))}
#game-hub .gh-trophy.is-empty svg{opacity:.18;filter:grayscale(1)}
#game-hub .gh-trophy b{display:block;font-size:12.5px;margin-top:6px}
#game-hub .gh-trophy small{color:var(--gh-dim);font-size:11px}
/* modal */
#game-hub .gh-modal{position:absolute;inset:0;z-index:30;display:grid;place-items:center;background:var(--scrim,rgba(4,4,6,.62));backdrop-filter:blur(6px);animation:gh-fade .2s forwards;opacity:0}
#game-hub .gh-modal-card{width:min(560px,92vw);max-height:86vh;overflow:auto;background:linear-gradient(180deg,var(--gh-panel2),var(--gh-panel));border:1px solid var(--gh-line);border-radius:var(--radius-lg,16px);padding:26px;
box-shadow:var(--shadow-lg,0 30px 80px -20px rgba(0,0,0,.8));animation:gh-in .3s both}
#game-hub .gh-modal-card h2{margin:0 0 8px;font-size:22px;font-weight:650;letter-spacing:-.015em;font-family:var(--serif,var(--gh-font))}
#game-hub .gh-modal-card p{color:var(--gh-dim)}
#game-hub .gh-modal-card .gh-btns{margin-top:22px;justify-content:flex-end}
#game-hub .gh-capture{position:absolute;inset:0;z-index:40;display:grid;place-items:center;background:rgba(0,0,0,.8);font-size:18px;text-align:center}
#game-hub .gh-capture b{display:block;font-size:32px;font-weight:650;margin-bottom:6px;color:var(--gh-accent)}
/* toast */
#game-hub .gh-toasts{position:absolute;right:24px;bottom:64px;z-index:35;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none}
#game-hub .gh-toast{padding:12px 16px;min-width:240px;max-width:400px;min-height:48px;display:flex;align-items:center;background:var(--glass-strong,#17181d);border:1px solid var(--gh-line);border-left:3px solid var(--gh-accent);border-radius:14px;font-size:13px;
animation:gh-in .3s both;box-shadow:var(--shadow-lg,0 10px 30px rgba(0,0,0,.5));backdrop-filter:blur(14px)}
#game-hub .gh-toast.good{border-left-color:var(--gh-good)}#game-hub .gh-toast.bad{border-left-color:var(--gh-bad)}#game-hub .gh-toast.warn{border-left-color:var(--gh-warn)}
#game-hub .gh-toast.out{opacity:0;transform:translateX(20px);transition:.3s}
/* achievements */
#game-hub .gh-ach{display:flex;gap:14px;align-items:flex-start;padding:14px;border:1px solid var(--gh-line);background:linear-gradient(180deg,var(--gh-panel2),var(--gh-panel));border-radius:var(--gh-r)}
#game-hub .gh-ach .ic{width:48px;height:48px;flex:none}
#game-hub .gh-ach .ic svg{width:48px;height:48px}
#game-hub .gh-ach.is-locked .ic{filter:grayscale(1) brightness(.5)}
#game-hub .gh-ach h4{margin:0 0 2px;font-size:13.5px}
#game-hub .gh-ach p{margin:0 0 8px;font-size:12px;color:var(--gh-dim)}
#game-hub .gh-ring{display:flex;align-items:center;gap:22px}
#game-hub .gh-ring svg{width:130px;height:130px}
/* challenge medals */
#game-hub .gh-medals{display:flex;gap:6px}
#game-hub .gh-medal{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font:800 9px var(--gh-mono);color:#111;opacity:.25}
#game-hub .gh-medal.on{opacity:1;box-shadow:0 0 10px currentColor}
#game-hub .gh-medal.bronze{background:#c27a43;color:#c27a43}#game-hub .gh-medal.silver{background:#c6ccd4;color:#c6ccd4}#game-hub .gh-medal.gold{background:#f0c246;color:#f0c246}
#game-hub .gh-medal span{color:#111}
/* setup forms (quick race) */
#game-hub .gh-setup{display:grid;grid-template-columns:1fr 380px;gap:22px}
#game-hub .gh-trackcard{padding:0;overflow:hidden}
#game-hub .gh-trackcard .gh-art{height:120px;display:grid;place-items:center;background:#0c0d10;color:rgba(255,255,255,.8);border-bottom:1px solid var(--gh-line)}
#game-hub .gh-trackcard .bd{padding:12px 14px}
#game-hub .gh-trackcard.is-sel{border-color:var(--gh-accent);box-shadow:inset 0 0 0 1px var(--gh-accent)}
#game-hub .gh-diff{display:inline-flex;gap:2px}
#game-hub .gh-diff i{width:6px;height:10px;border-radius:2px;background:var(--gh-line2)}
#game-hub .gh-diff i.on{background:var(--gh-accent)}
@media (max-width:1100px){#game-hub .gh-menu,#game-hub .gh-brief,#game-hub .gh-rewards,#game-hub .gh-ws,#game-hub .gh-setup{grid-template-columns:1fr}
#game-hub .gh-menu-hero{border-left:0;padding-left:0}#game-hub .gh-tiermap{grid-template-columns:repeat(2,1fr)}#game-hub .gh-tiles{grid-template-columns:repeat(3,1fr)}
#game-hub .gh-grid.c3,#game-hub .gh-grid.c4{grid-template-columns:repeat(2,1fr)}#game-hub .gh-news{grid-template-columns:1fr}}
@media (max-width:640px){#game-hub .gh-screen{padding:18px 16px 50px}#game-hub .gh-h1{font-size:28px}#game-hub .gh-grid.c2,#game-hub .gh-grid.c3,#game-hub .gh-grid.c4{grid-template-columns:1fr}
#game-hub .gh-tiles{grid-template-columns:repeat(2,1fr)}#game-hub .gh-driver-txt,#game-hub .gh-crumbs{display:none}#game-hub .gh-foot{display:none}}
#game-hub.reduced *,#game-hub.reduced *::before,#game-hub.reduced *::after{animation-duration:.001s!important;animation-delay:0s!important;transition-duration:.001s!important}
@media (prefers-reduced-motion:reduce){#game-hub *{animation-duration:.001s!important;animation-delay:0s!important}}
`;

  function injectStyles() {
    if (!hasDOM || document.getElementById('game-hub-styles')) return;
    var s = document.createElement('style');
    s.id = 'game-hub-styles';
    s.textContent = CSS + CSS2;
    document.head.appendChild(s);
  }

  /* ---------------------------------------------------------------- icons */
  var ICONS = {
    career: '<path d="M6 3h12v4a6 6 0 0 1-12 0z"/><path d="M6 5H3v2a3 3 0 0 0 3 3M18 5h3v2a3 3 0 0 1-3 3M9 21h6M12 13v8"/>',
    race: '<path d="M4 21V4M4 4h13l-2 4 2 4H4"/>',
    drift: '<path d="M4 18c3-7 8-11 16-12"/><path d="M14 4l6 2-2 6"/><circle cx="6" cy="20" r="1.2"/><circle cx="3.5" cy="15.5" r="1"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
    cone: '<path d="M9 3h6l4 16H5z"/><path d="M3 21h18M8 10h8M7 15h10"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5z"/>',
    garage: '<path d="M3 21V9l9-6 9 6v12"/><path d="M7 21v-8h10v8M7 17h10"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    film: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="1"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    chev: '<path d="M9 5l7 7-7 7"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/>',
    check: '<path d="M4 12l5 5L20 6"/>',
    cup: '<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M12 14v4M8 21h8"/>',
    flag: '<path d="M5 21V4M5 4h14v9H5"/><path d="M9 4v9M13 4v9M5 8.5h14"/>',
    coin: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .9-3 2s1 1.7 3 2 3 .9 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6v2M12 16v2"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
    rain: '<path d="M7 15a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1A4 4 0 0 1 18 15z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
    moon: '<path d="M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    f1: '<path d="M3 15h4l2-4h7l2 4h3"/><circle cx="6.5" cy="16.5" r="2.5"/><circle cx="17.5" cy="16.5" r="2.5"/><path d="M11 11V8h5"/>',
    derby: '<path d="M12 2.5l1.8 5.2 5.2-2.3-2.4 5 5.2 1.8-5.2 1.8 2.4 5-5.2-2.3L12 21.5l-1.8-5.2-5.2 2.3 2.4-5L2.2 11.8l5.2-1.8-2.4-5 5.2 2.3z"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
    gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-6M8 17h8"/>',
    users: '<circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><path d="M2 20c0-3.3 2.7-6 6-6s6 2.7 6 6M12 20c0-3.3 2.7-6 6-6"/>'
  };
  function icon(name, size) {
    size = size || 18;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }
  function trophySVG(kind, color) {
    var c = kind === 'gold' ? ['#fff3b8', '#f0c246', '#8a5a06'] : kind === 'silver' ? ['#ffffff', '#c6ccd4', '#59626d'] : kind === 'bronze' ? ['#f3c296', '#c27a43', '#5b2e12'] : ['#f2fdff', '#a9dcea', '#21495a'];
    var id = 'tg' + kind + (color ? hashStr(color) % 999 : '');
    return '<svg viewBox="0 0 80 100" aria-hidden="true"><defs><linearGradient id="' + id + '" x1="0" x2="1"><stop offset="0" stop-color="' + c[2] + '"/><stop offset=".35" stop-color="' + c[0] + '"/><stop offset=".6" stop-color="' + c[1] + '"/><stop offset="1" stop-color="' + c[2] + '"/></linearGradient></defs>' +
      '<path d="M18 8h44v18c0 14-9 24-22 24S18 40 18 26z" fill="url(#' + id + ')"/>' +
      '<path d="M18 14H8v6c0 8 6 13 12 13M62 14h10v6c0 8-6 13-12 13" fill="none" stroke="url(#' + id + ')" stroke-width="4"/>' +
      '<rect x="35" y="50" width="10" height="16" fill="url(#' + id + ')"/><path d="M24 66h32l4 10H20z" fill="url(#' + id + ')"/>' +
      '<rect x="16" y="76" width="48" height="16" fill="#1a1b1f" stroke="' + (color || c[1]) + '" stroke-width="1.5"/>' +
      '<path d="M28 16c0 10 4 20 12 22" stroke="#fff" stroke-opacity=".5" stroke-width="3" fill="none"/></svg>';
  }

  /* ======================================================================
     Controller
     ====================================================================== */
  var H = null;           // live hub state while open
  var SCREENS = {};       // id -> {title, crumb, render(host, params), live?, onLeave?}
  function screen(id, def) { def.id = id; SCREENS[id] = def; }

  function $(sel, root) { return (root || (H && H.root) || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || (H && H.root) || document).querySelectorAll(sel)); }
  function html(el, markup) { el.innerHTML = markup; return el; }
  function div(cls, markup) { var d = document.createElement('div'); if (cls) d.className = cls; if (markup != null) d.innerHTML = markup; return d; }
  /** Delegated actions: elements with data-act="name" + data-* params. */
  function onAct(host, map) {
    host.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!t || !host.contains(t) || t.disabled || t.getAttribute('aria-disabled') === 'true') return;
      var fn = map[t.getAttribute('data-act')];
      if (fn) { e.preventDefault(); sfx('select'); fn(t.dataset, t, e); }
    });
  }

  /* ----------------------------------------------------------- UI audio */
  var actx = null;
  function sfx(kind) {
    if (!hasDOM || !H) return;
    var vol = num(setting('audio.master', 0.8), 0.8) * num(setting('audio.sfx', 0.8), 0.8) * 0.18;
    if (setting('audio.muted', false) || vol <= 0.001) return;
    try {
      if (!actx) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; actx = new AC(); }
      if (actx.state === 'suspended') actx.resume();
      var t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
      var f = { move: [880, 990, 0.04], select: [520, 1040, 0.09], back: [600, 300, 0.09], error: [180, 140, 0.18], coin: [1320, 1760, 0.06], level: [523, 1046, 0.5] }[kind] || [700, 700, 0.05];
      o.type = kind === 'error' ? 'square' : kind === 'level' ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(f[0], t); o.frequency.exponentialRampToValueAtTime(f[1], t + f[2]);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol * (kind === 'move' ? 0.4 : 1), t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + f[2] + 0.05);
      o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + f[2] + 0.08);
      if (kind === 'level') {
        [659, 784, 1046].forEach(function (fr, i) {
          var o2 = actx.createOscillator(), g2 = actx.createGain();
          o2.type = 'triangle'; o2.frequency.value = fr;
          g2.gain.setValueAtTime(0.0001, t + 0.12 * (i + 1)); g2.gain.exponentialRampToValueAtTime(vol, t + 0.12 * (i + 1) + 0.02);
          g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.12 * (i + 1) + 0.5);
          o2.connect(g2); g2.connect(actx.destination); o2.start(t + 0.12 * (i + 1)); o2.stop(t + 0.12 * (i + 1) + 0.6);
        });
      }
    } catch (e) { /* audio is optional */ }
  }

  /* ------------------------------------------------------------- open */
  /** Replay recording must be wired whichever way the hub was entered (hub.html boot() or CB.app.openHub -> open()). */
  function ensureIntegrations() {
    var R = rep();
    if (R && typeof R.install === 'function' && !ensureIntegrations.replay) { ensureIntegrations.replay = true; safe(function () { R.install({}); }); }
  }
  function open(opts) {
    if (!hasDOM) return api;
    opts = opts || {};
    injectStyles();
    ensureIntegrations();
    if (H) {
      // re-entering from the Atelier ("Menu"): un-park the hub
      H.inAtelier = null;
      if (H.root.style.display === 'none') H.root.style.display = '';
      if (!H.routed) document.documentElement.style.overflow = 'hidden';
      if (typeof opts.onScreen === 'function') H.opts.onScreen = opts.onScreen;
      if (opts.screen) show(opts.screen, opts.params, { replace: true }); else refresh();
      try { H.root.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      return api;
    }
    var old = document.getElementById('game-hub');
    if (old) old.parentNode.removeChild(old);
    var root = document.createElement('div');
    root.id = 'game-hub';
    root.setAttribute('role', 'application');
    root.setAttribute('aria-label', 'Redline game hub');
    root.tabIndex = -1;
    // CB.router hosts the hub inside its #screen-hub layer (UNIFY-SPEC); standalone pages use a full-page overlay
    var host = opts.host && opts.host.nodeType === 1 ? opts.host : document.body;
    if (opts.routed || host !== document.body) root.className = 'is-routed';
    root.innerHTML =
      '<canvas class="gh-bgfx" aria-hidden="true"></canvas><div class="gh-carbon"></div>' +
      '<header class="gh-top"><button class="gh-brand" data-gh-home title="Main menu"><i></i>REDLINE<small>GARAGE · RACING</small></button>' +
      '<nav class="gh-crumbs" aria-label="Breadcrumb"></nav><div class="gh-spacer"></div><div class="gh-wallet"></div></header>' +
      '<main class="gh-main"></main>' +
      '<footer class="gh-foot"></footer><div class="gh-toasts" aria-live="polite"></div>';
    host.appendChild(root);
    H = {
      root: root, main: root.querySelector('.gh-main'), stack: [], opts: opts, listeners: [], focusIdx: -1, timers: [], charts: [],
      prevOverflow: document.documentElement.style.overflow, prevFocus: document.activeElement, pad: { prev: {}, last: 0, active: false, repeat: {} },
      modal: null, capture: null, raf: 0, unsub: null, standalone: !!opts.standalone, bgfx: null, routed: root.className === 'is-routed'
    };
    if (!H.routed) document.documentElement.style.overflow = 'hidden';
    if (setting('ui.reducedMotion', false)) root.classList.add('reduced');
    root.querySelector('[data-gh-home]').addEventListener('click', function () { sfx('back'); show('menu', null, { reset: true }); });
    root.querySelector('.gh-crumbs').addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-gh-crumb]');
      if (!b || !H) return;
      unwindTo(parseInt(b.getAttribute('data-gh-crumb'), 10));
    });
    listen(window, 'keydown', onKey, true);
    listen(window, 'resize', function () { if (H && H.bgfx) H.bgfx.resize(); });
    listen(window, 'gamepadconnected', function (e) { H.pad.active = true; toast('Controller connected' + (e.gamepad && e.gamepad.id ? ' · ' + String(e.gamepad.id).split('(')[0].trim() : ''), 'good'); renderFoot(); });
    listen(window, 'gamepaddisconnected', function () { toast('Controller disconnected', 'warn'); renderFoot(); });
    // a race launched from the hub returns here; a race started from the Atelier (Free Build) returns to the Atelier
    listen(document, 'cb:race-closed', function () { if (H && !H.inAtelier) { H.root.style.display = ''; refresh(); } });
    // Back / Forward / the nav bar / any router transition dismisses the transient UI opened on the previous screen
    listen(document, 'cb:route', function () { dismissStale(); });
    listen(H.main, 'mousemove', function (e) {
      var t = e.target.closest && e.target.closest('[data-nav]');
      if (t && H.main.contains(t)) setFocusEl(t, true);
    });
    // Tab / click focus moves the highlight too, so arrows and Enter continue from where the keyboard focus is
    listen(root, 'focusin', function (e) {
      var t = e.target;
      if (H && t && t.hasAttribute && t.hasAttribute('data-nav') && t !== H.focusEl) setFocusEl(t, true, true);
    });
    var pm = prof();
    // storage blocked (private mode, disabled site data) or full: say once that progress only lasts for this tab
    if (!storageWarned && pm && typeof pm.isPersistent === 'function') later(function () {
      if (!H || storageWarned || safe(function () { return pm.isPersistent(); }, true)) return;
      storageWarned = true;
      if (H.root.querySelector('.gh-toasts')) toast('Progress can’t be saved in this browser (storage blocked or full). It lasts until you close this tab.', 'warn');
    }, 1500);
    if (pm && typeof pm.subscribe === 'function') H.unsub = pm.subscribe(onProfileChange);
    else { localListeners.push(onProfileChange); H.unsub = function () { localListeners.splice(localListeners.indexOf(onProfileChange), 1); }; }
    var A = achv();
    if (A && typeof A.onUnlock === 'function') {
      var off = A.onUnlock(function () { if (H) renderHeader(); });
      if (typeof off === 'function') H.listeners.push(off);
    }
    H.bgfx = createBgFx(root.querySelector('.gh-bgfx'));
    renderHeader();
    renderFoot();
    padLoop();
    var first = opts.screen && SCREENS[opts.screen] ? opts.screen : 'title';
    // deep links (#garage, open({screen})) sit on top of the main menu so Back / Esc and the breadcrumb lead somewhere
    if (first !== 'title' && first !== 'menu') { H.stack = [{ id: 'menu' }]; show(first, opts.params); }
    else show(first, opts.params, { replace: true });
    try { root.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    return api;
  }
  function listen(target, type, fn, capture) {
    target.addEventListener(type, fn, !!capture);
    H.listeners.push(function () { target.removeEventListener(type, fn, !!capture); });
  }
  function close() {
    if (!H) return;
    var h0 = H;
    leaveScreen();
    h0.listeners.forEach(function (off) { safe(off); });
    if (h0.unsub) safe(h0.unsub);
    if (h0.raf) cancelAnimationFrame(h0.raf);
    if (h0.bgfx) h0.bgfx.destroy();
    h0.timers.forEach(clearTimeout);
    if (h0.root.parentNode) h0.root.parentNode.removeChild(h0.root);
    document.documentElement.style.overflow = h0.prevOverflow || '';
    H = null;
    // overlays the hub launched (replay viewer / library, achievements gallery) live outside its root: close them too
    if (h0.overlay) { h0.overlay = null; safe(function () { var R = rep(); if (R && typeof R.close === 'function') R.close(); }); }
    if (h0.gallery) { h0.gallery = null; safe(function () { var A = achv(); if (A && typeof A.closeGallery === 'function') A.closeGallery(); }); }
    safe(function () { if (h0.prevFocus && h0.prevFocus.focus) h0.prevFocus.focus(); });
    if (typeof h0.opts.onClose === 'function') safe(h0.opts.onClose);
  }
  function isOpen() { return !!H; }
  /** Parked: the hub hid itself while one of its flows (career race, career Atelier session) runs on another screen. */
  function isParked() { return !!H && H.root.style.display === 'none' && !H.overlay; }
  function unpark() {
    if (!H) return;
    H.inAtelier = null;
    if (H.root.style.display === 'none') H.root.style.display = '';
  }
  /** True when the router layer hosting the hub is hidden (another route is on screen). */
  function layerHidden() { return !!(H && H.routed && H.root.closest && H.root.closest('[hidden]')); }
  function routerMod() { return CB.router && typeof CB.router.go === 'function' && (typeof CB.router.isBooted !== 'function' || CB.router.isBooted()) ? CB.router : null; }
  /** Identifies the screen on show: a transient overlay opened under one key is stale once the key changes. */
  function routeKey() { return hasDOM && window.location ? String(window.location.hash || '') : ''; }
  /** Which transient UI a route change must dismiss (pure). st {modal, overlay, gallery, inAction} each holding the routeKey it was opened under. */
  function staleOverlays(st, key) {
    st = st || {};
    var out = [];
    if (st.modal != null && !st.inAction && st.modal !== key) out.push('modal');
    if (st.overlay != null && st.overlay !== key) out.push('overlay');
    if (st.gallery != null && st.gallery !== key) out.push('gallery');
    return out;
  }
  function dismissStale() {
    if (!H) return;
    var key = routeKey();
    var todo = staleOverlays({ modal: H.modal && H.modal.key != null ? H.modal.key : null, overlay: H.overlay ? H.overlay.key : null, gallery: H.gallery ? H.gallery.key : null, inAction: H.modalAction > 0 }, key);
    if (todo.indexOf('modal') >= 0) closeModal(false);
    if (todo.indexOf('gallery') >= 0 && H) {
      H.gallery = null;
      safe(function () { var A = achv(); if (A && typeof A.closeGallery === 'function') A.closeGallery(); });
    }
    if (todo.indexOf('overlay') >= 0 && H) {
      H.overlay = null;
      safe(function () { var R = rep(); if (R && typeof R.close === 'function') R.close(); });
      // the library closes silently (no onClose): un-hide the hub ourselves
      if (H && !H.inAtelier) { H.root.style.display = ''; refresh(); }
    }
  }
  function later(fn, ms) { if (!H) return 0; var id = setTimeout(function () { if (H) fn(); }, ms); H.timers.push(id); return id; }

  var profileDirty = false;
  function onProfileChange(p, meta) {
    if (!H) return;
    renderHeader(meta);
    var cur = H.stack[H.stack.length - 1];
    var def = cur && SCREENS[cur.id];
    if (def && def.live && !H.modal && !H.capture && !(meta && meta.reason === 'settings' && def.id === 'settings')) {
      if (profileDirty) return;
      profileDirty = true;
      later(function () { profileDirty = false; renderScreen(true); }, 30);
    }
  }

  /* ----------------------------------------------------------- header */
  var lastCredits = null;
  function renderHeader(meta) {
    if (!H) return;
    var p = P(), li = levelInfo();
    var wallet = H.root.querySelector('.gh-wallet');
    var ring = 2 * Math.PI * 21;
    var color = p.avatarColor || '#d4b06a';
    var initials = (prof() && prof().initials) ? safe(function () { return prof().initials(p.driverName); }, 'D') : String(p.driverName || 'D').slice(0, 2).toUpperCase();
    wallet.innerHTML =
      '<div class="gh-credits gh-num" title="Credits">' + esc(fmtCredits(p.credits)) + '</div>' +
      '<button class="gh-driver" data-gh-profile title="Profile & stats"><span class="gh-avatar" style="background:' + esc(color) + '">' + esc(initials) +
      '<svg viewBox="0 0 46 46"><circle cx="23" cy="23" r="21" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="2.5"/>' +
      '<circle cx="23" cy="23" r="21" fill="none" stroke="var(--gh-accent)" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="' + (ring * li.progress).toFixed(1) + ' ' + ring.toFixed(1) + '"/></svg></span>' +
      '<span class="gh-driver-txt"><b>' + esc(p.driverName || 'Driver') + '</b><small>Lv ' + li.level + ' · ' + esc(levelTitle(li.level)) + '</small></span></button>';
    wallet.querySelector('[data-gh-profile]').addEventListener('click', function () { show('profile'); });
    if (lastCredits != null && p.credits !== lastCredits) {
      var c = wallet.querySelector('.gh-credits');
      c.classList.add('is-bump');
    }
    lastCredits = p.credits;
    var cur = H.stack[H.stack.length - 1];
    var crumbs = H.root.querySelector('.gh-crumbs');
    var top = H.root.querySelector('.gh-top');
    if (!cur || cur.id === 'title') { crumbs.innerHTML = ''; top.style.display = 'none'; return; }
    var trail = [];
    // unified game: the global nav bar already names the top-level screen (and has the logo, credits and profile), so the
    // hub only shows a slim trail on deeper sub-screens (Career › Rookie Cup › Round 2 briefing), without the menu root
    H.stack.forEach(function (s, si) { if (s.id !== 'title' && !(H.routed && s.id === 'menu')) trail.push({ s: s, si: si }); });
    top.style.display = H.routed && trail.length < 2 ? 'none' : '';
    // long trails collapse their middle into an ellipsis (first crumb + the last three stay clickable)
    var MAX_CRUMBS = 5;
    if (trail.length > MAX_CRUMBS) trail = [trail[0], { gap: trail.length - 4 }].concat(trail.slice(-3));
    crumbs.innerHTML = trail.map(function (e, i, a) {
      if (e.gap) return '<span class="gh-crumb-gap" title="' + e.gap + ' more">…</span>';
      var s = e.s, d = SCREENS[s.id], t = (d && (typeof d.crumb === 'function' ? safe(function () { return d.crumb(s.params || {}); }, d.title) : d.title)) || s.id;
      return i === a.length - 1 ? '<b>' + esc(t) + '</b>'
        : '<span class="' + (i ? '' : 'first') + '"><button type="button" class="gh-crumb" data-gh-crumb="' + e.si + '" title="Back to ' + esc(t) + '">' + esc(t) + '</button></span>';
    }).join(' ');
  }
  function renderFoot() {
    if (!H) return;
    var pad = H.pad.active;
    var cur = H.stack[H.stack.length - 1];
    var hasTabs = cur && SCREENS[cur.id] && SCREENS[cur.id].tabs;
    var k = function (key, padKey, cls, label) { return '<span>' + (pad ? '<kbd class="pad ' + (cls || '') + '">' + padKey + '</kbd>' : '<kbd>' + key + '</kbd>') + label + '</span>'; };
    var foot = H.root.querySelector('.gh-foot');
    // the Atelier and Race / Drift setup have no hint bar: in the unified game the hub shows one only for a controller
    foot.style.display = !cur || cur.id === 'title' || (H.routed && !pad) ? 'none' : '';
    foot.innerHTML =
      k('↑↓←→', '✛', '', 'Navigate') + k('Enter', 'A', 'pad-a', 'Select') + k('Esc', 'B', 'pad-b', 'Back') +
      (hasTabs ? k('Q / E', 'LB RB', '', 'Tabs') : '');
  }

  /* -------------------------------------------------------- navigation */
  function show(id, params, opts) {
    if (!H) { open({ screen: id, params: params }); return; }
    opts = opts || {};
    if (!SCREENS[id]) id = 'menu';
    leaveScreen();
    var cur = H.stack[H.stack.length - 1];
    if (cur) cur.scroll = H.main.scrollTop;
    if (opts.reset) H.stack = [{ id: 'menu' }];
    // revisiting a screen already in the trail unwinds back to it (keeps breadcrumbs and Back short: menu › garage › … › garage)
    if (!opts.replace && !opts.reset) {
      for (var si = H.stack.length - 1; si >= 0; si--) if (H.stack[si].id === id) { H.stack.length = si; break; }
    }
    if (opts.replace && H.stack.length) H.stack[H.stack.length - 1] = { id: id, params: params || {} };
    else if (!(opts.reset && id === 'menu')) H.stack.push({ id: id, params: params || {} });
    if (H.stack.length > 24) H.stack.splice(1, H.stack.length - 24);
    H.root.classList.remove('is-back');
    renderScreen(false);
  }
  /* unwind the screen stack to index idx (breadcrumb click) — like pressing Back repeatedly, without the intermediate renders */
  function unwindTo(idx) {
    if (!H || !(idx >= 0) || idx >= H.stack.length - 1) return;
    if (H.modal) closeModal(false);
    leaveScreen();
    H.stack.length = idx + 1;
    var top = H.stack[idx];
    H.root.classList.add('is-back');
    sfx('back');
    renderScreen(false, top && top.scroll);
  }
  function back() {
    if (!H) return;
    if (H.modal) { closeModal(false); return; }
    if (H.stack.length <= 1) {
      var cur0 = H.stack[0];
      if (cur0 && cur0.id === 'menu') { show('title', null, { replace: true }); sfx('back'); }
      else if (cur0 && cur0.id !== 'title') { sfx('back'); show('menu', null, { reset: true }); }
      return;
    }
    leaveScreen();
    H.stack.pop();
    var top = H.stack[H.stack.length - 1];
    if (top && top.id === 'title' && H.stack.length > 1) { H.stack.pop(); top = H.stack[H.stack.length - 1]; }
    H.root.classList.add('is-back');
    sfx('back');
    renderScreen(false, top && top.scroll);
  }
  function leaveScreen() {
    if (!H) return;
    var cur = H.stack[H.stack.length - 1];
    var def = cur && SCREENS[cur.id];
    if (def && def.onLeave) safe(function () { def.onLeave(cur.params || {}); });
    H.charts.forEach(function (c) { safe(function () { c.destroy(); }); });
    H.charts = [];
    if (H.screenCleanup) { H.screenCleanup.forEach(function (f) { safe(f); }); }
    H.screenCleanup = [];
  }
  function onCleanup(fn) { if (H) H.screenCleanup.push(fn); }
  function renderScreen(isRefresh, scrollTo) {
    if (!H) return;
    var h0 = H;
    h0.rendering = (h0.rendering || 0) + 1;
    try { renderScreenNow(isRefresh, scrollTo); } finally { h0.rendering = Math.max(0, h0.rendering - 1); }
  }
  function renderScreenNow(isRefresh, scrollTo) {
    if (!H) return;
    var cur = H.stack[H.stack.length - 1];
    var def = SCREENS[cur.id];
    // sub-screens whose in-memory model / params are gone (Back/Forward, deep link, reload) fall back to their parent screen
    var redirected = false;
    for (var hop = 0; hop < 3 && def && typeof def.fallback === 'function'; hop++) {
      var fb = safe(function () { return def.fallback(cur.params || {}); }, null);
      if (!fb || !SCREENS[fb.id] || fb.id === cur.id) break;
      cur = H.stack[H.stack.length - 1] = { id: fb.id, params: fb.params || {} };
      for (var si2 = H.stack.length - 2; si2 >= 0; si2--) if (H.stack[si2].id === fb.id) { H.stack.splice(si2, 1); }
      cur = H.stack[H.stack.length - 1];
      def = SCREENS[cur.id];
      redirected = true;
    }
    if (redirected && isRefresh) { leaveScreen(); isRefresh = false; }
    var keepScroll = isRefresh ? H.main.scrollTop : 0;
    var focusKey = isRefresh && H.focusEl ? (H.focusEl.getAttribute('data-key') || null) : null;
    var focusIdx = isRefresh ? H.focusIdx : -1;
    if (isRefresh) leaveScreen();
    H.main.innerHTML = '';
    var host = div('gh-screen gh-s-' + cur.id);
    if (isRefresh) host.style.animation = 'none';
    H.main.appendChild(host);
    H.focusEl = null; H.focusIdx = -1;
    H.root.dataset.screen = cur.id;

    try { def.render(host, cur.params || {}); }
    catch (e) {
      if (typeof console !== 'undefined') console.error('[hub] screen ' + cur.id + ' failed', e);
      host.innerHTML = '<div class="gh-empty"><b>This screen hit a snag</b>' + esc(e && e.message) + '<div class="gh-btns" style="justify-content:center;margin-top:16px"><button class="gh-btn" data-nav data-act="back">Back</button></div></div>';
      onAct(host, { back: back });
    }
    if (H.bgfx) H.bgfx.setMode(cur.id === 'title' ? 'title' : 'hub');
    // tab title follows the screen ('Redline — Career', 'Redline — Rookie Cup'), like every other routed screen
    if (!isRefresh && hasDOM && !layerHidden()) {
      var ttl = cur.id === 'title' || cur.id === 'menu' ? 'Menu' : (typeof def.crumb === 'function' ? safe(function () { return def.crumb(cur.params || {}); }, def.title) : def.title);
      if (ttl) document.title = 'Redline — ' + ttl;
    }
    renderHeader();
    renderFoot();
    // CB.router mirrors the hub's screen in the URL / global nav bar (back navigation replaces the entry)
    if (!isRefresh && typeof H.opts.onScreen === 'function') {
      var shownId = cur.id, shownParams = cur.params || {}, wasBack = H.root.classList.contains('is-back');
      safe(function () { H.opts.onScreen(shownId, shownParams, { replace: wasBack || redirected }); });
    }
    // jump (not smooth-scroll) to the restored position: .gh-main has scroll-behavior:smooth, which would otherwise animate
    // from the previous screen's offset and get stuck part-way when the new content is shorter
    H.main.style.scrollBehavior = 'auto';
    H.main.scrollTop = isRefresh ? keepScroll : (scrollTo || 0);
    // initial focus
    var target = null;
    if (focusKey) target = H.main.querySelector('[data-key="' + cssEscape(focusKey) + '"]');
    var navs = navEls();
    if (!target && focusIdx >= 0 && navs[focusIdx]) target = navs[focusIdx];
    if (!target) {
      target = H.main.querySelector('[data-autofocus]');
      // tabbed screens: start on the active tab (switching tabs re-renders the screen; focus stays on the tab just chosen)
      if (!target && navs[0] && navs[0].classList.contains('gh-tab')) target = H.main.querySelector('.gh-tab.is-active');
      if (!target) target = navs[0];
    }
    if (target) setFocusEl(target, true, true);
    // a fresh screen opens at the top when its first focus target is already visible from there (keeps the hero title in view)
    if (!isRefresh && !scrollTo && target && H.main.scrollTop) {
      var mr = H.main.getBoundingClientRect(), tr = target.getBoundingClientRect();
      if (tr.bottom + H.main.scrollTop - mr.top < H.main.clientHeight - 16) H.main.scrollTop = 0;
    }
    H.main.style.scrollBehavior = '';
  }
  function refresh() { if (H) renderScreen(true); }
  function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* ------------------------------------------------------------- focus */
  function navEls() {
    if (!H) return [];
    var scope = H.capture ? null : H.modal ? H.modal.card : H.main;
    if (!scope) return [];
    return $$('[data-nav]', scope).filter(function (el) {
      if (el.disabled && !el.hasAttribute('data-nav-disabled-ok')) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
  }
  function setFocusEl(el, silent, noScroll) {
    if (!H || !el) return;
    if (H.focusEl && H.focusEl !== el) H.focusEl.classList.remove('is-focus');
    H.focusEl = el;
    var navs = navEls();
    H.focusIdx = navs.indexOf(el);
    el.classList.add('is-focus');
    var row = el.closest && el.closest('.gh-row');
    $$('.gh-row.is-focus-row').forEach(function (r) { if (r !== row) r.classList.remove('is-focus-row'); });
    if (row) row.classList.add('is-focus-row');
    // automatic / hover focus never puts the caret in a text field (that pops the phone keyboard on every Profile visit);
    // the field is only highlighted, and Enter / A (activateFocus) or a tap focuses it.
    var textField = el.tagName === 'INPUT' && /^(text|search|email|number|)$/.test(el.type || '');
    if (document.activeElement !== el && !(silent && textField) && (el.tagName === 'INPUT' || el.tagName === 'BUTTON' || el.tabIndex >= 0)) {
      try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    if (!noScroll) {
      var r = el.getBoundingClientRect(), mr = (H.modal ? H.modal.card : H.main).getBoundingClientRect();
      if (r.top < mr.top + 20 || r.bottom > mr.bottom - 20) {
        try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e2) { el.scrollIntoView(false); }
      }
    }
    if (!silent) sfx('move');
  }
  function moveFocus(dir) {
    var navs = navEls();
    if (!navs.length) return;
    var idx = navs.indexOf(H.focusEl);
    if (idx < 0) { setFocusEl(navs[0]); return; }
    var rects = navs.map(function (el) { var r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    var next = pickNext(rects, idx, dir);
    if (next >= 0) setFocusEl(navs[next]);
  }
  function activateFocus() {
    var el = H && H.focusEl;
    if (!el || !document.contains(el)) return;
    if (el.tagName === 'INPUT' && el.type === 'range') return;
    if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'search')) { el.focus(); return; }
    el.click();
  }
  function switchTab(delta) {
    var tabs = $$('.gh-tab', H.modal ? H.modal.card : H.main);
    if (!tabs.length) return;
    var i = tabs.findIndex(function (t) { return t.classList.contains('is-active'); });
    var n = tabs[(i + delta + tabs.length) % tabs.length];
    if (n) { sfx('move'); n.click(); }
  }

  /* ------------------------------------------------------------- keys */
  /** A dialog that isn't the hub's own (achievements gallery, garage/atelier modals) is open on top of the hub. */
  function foreignModal() {
    if (!H || typeof document === 'undefined') return false;
    // .cw-ov: the webcam-wheel setup dialog (role=dialog without aria-modal); without it Esc there also ran the hub's back()
    var list = document.querySelectorAll('[aria-modal="true"], .gach-overlay, .cw-ov');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (H.root && H.root.contains(el)) continue;
      if (el.classList && el.classList.contains('is-leaving')) continue;
      var ov = el.closest ? (el.closest('.gach-overlay') || el) : el;
      if (ov.classList && ov.classList.contains('is-leaving')) continue;
      if (el.getClientRects && !el.getClientRects().length) continue;   // display:none
      return true;
    }
    return false;
  }
  function onKey(e) {
    if (!H) return;
    if (document.getElementById('race-root') && getComputedStyle(document.getElementById('race-root')).display !== 'none') return;
    if (H.root.style.display === 'none' || layerHidden()) return;
    if (H.capture) { H.capture.onKey(e); return; }
    if (foreignModal()) return;   // e.g. the achievements gallery handles its own keys (Esc closes it)
    var t = e.target, typing = t && (t.tagName === 'INPUT' && (t.type === 'text' || t.type === 'search' || t.type === 'number')) || (t && t.tagName === 'TEXTAREA');
    var cur = H.stack[H.stack.length - 1];
    if (cur && cur.id === 'title') {
      if (e.key === 'Escape' && H.standalone !== true && H.opts.onClose) { e.preventDefault(); close(); return; }
      if (!e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); sfx('select'); show('menu', null, { replace: true }); }
      return;
    }
    var k = e.key;
    // Tab stays inside an open hub dialog (it used to walk out to the top nav behind the scrim)
    if (k === 'Tab' && H.modal && H.modal.card) {
      var foc = $$('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])', H.modal.card)
        .filter(function (el) { return el.getClientRects().length > 0; });
      if (!foc.length) { e.preventDefault(); return; }
      var at = foc.indexOf(document.activeElement), nx;
      if (at < 0) nx = e.shiftKey ? foc.length - 1 : 0;
      else if (e.shiftKey && at === 0) nx = foc.length - 1;
      else if (!e.shiftKey && at === foc.length - 1) nx = 0;
      if (nx != null) { e.preventDefault(); foc[nx].focus(); if (foc[nx].hasAttribute('data-nav')) setFocusEl(foc[nx], true, true); }
      return;
    }
    if (typing) {
      if (k === 'Escape' || k === 'Enter') { t.blur(); e.preventDefault(); }
      return;
    }
    var isRange = t && t.tagName === 'INPUT' && t.type === 'range';
    // Enter / Space on a control the keyboard focused with Tab (or the top nav, outside the hub) must activate *that*
    // control, not the stale gamepad highlight (it used to click H.focusEl: Enter on "Buy a car" opened the race screen).
    if (k === 'Enter' || k === ' ') {
      var ae = document.activeElement;
      if (ae && ae !== H.focusEl && ae !== document.body && ae !== document.documentElement && ae.matches &&
          ae.matches('button,a[href],select,input,textarea,summary,[role=button],[role=tab],[role=menuitem],[tabindex]:not([tabindex="-1"])')) {
        if (H.root.contains(ae) && ae.hasAttribute('data-nav')) setFocusEl(ae, true, true);
        else return;   // native activation (click on Enter / Space) of the focused control
      }
    }
    var handled = true;
    switch (k) {
      case 'ArrowUp': case 'w': case 'W': moveFocus('up'); break;
      case 'ArrowDown': case 's': case 'S': moveFocus('down'); break;
      case 'ArrowLeft': case 'a': case 'A': if (isRange && k === 'ArrowLeft') handled = false; else moveFocus('left'); break;
      case 'ArrowRight': case 'd': case 'D': if (isRange && k === 'ArrowRight') handled = false; else moveFocus('right'); break;
      case 'Enter': case ' ': activateFocus(); break;
      case 'Escape': case 'Backspace': back(); break;
      case 'q': case 'Q': case 'PageUp': switchTab(-1); break;
      case 'e': case 'E': case 'PageDown': switchTab(1); break;
      case 'Home': show('menu', null, { reset: true }); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  /* ---------------------------------------------------------- gamepad */
  function padLoop() {
    if (!H) return;
    var REPEAT_DELAY = 380, REPEAT_RATE = 110;
    function frame(ts) {
      if (!H) return;
      H.raf = requestAnimationFrame(frame);
      if (H.bgfx) H.bgfx.frame(ts);
      if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
      var raceOpen = document.getElementById('race-root');
      if (raceOpen && getComputedStyle(raceOpen).display !== 'none') return;
      if (H.root.style.display === 'none' || layerHidden()) return;
      var pads = safe(function () { return navigator.getGamepads(); }, []) || [];
      var gp = null;
      for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { gp = pads[i]; break; }
      if (!gp) return;
      if (!H.pad.active) { H.pad.active = true; renderFoot(); }
      var dz = num(setting('controls.gamepad.deadzone', 0.12), 0.12) + 0.3;
      var btn = function (n) { var b = gp.buttons[n]; return !!(b && (b.pressed || b.value > 0.5)); };
      var ax = gp.axes || [];
      var state = {
        up: btn(12) || num(ax[1], 0) < -dz, down: btn(13) || num(ax[1], 0) > dz,
        left: btn(14) || num(ax[0], 0) < -dz, right: btn(15) || num(ax[0], 0) > dz,
        a: btn(0), b: btn(1), lb: btn(4), rb: btn(5), start: btn(9), y: btn(3)
      };
      if (H.capture && H.capture.onPad) { H.capture.onPad(gp); H.pad.prev = state; return; }
      if (foreignModal()) { H.pad.prev = state; return; }
      var prev = H.pad.prev;
      ['up', 'down', 'left', 'right'].forEach(function (d) {
        if (state[d] && !prev[d]) { H.pad.repeat[d] = ts + REPEAT_DELAY; padDir(d); }
        else if (state[d] && ts >= (H.pad.repeat[d] || Infinity)) { H.pad.repeat[d] = ts + REPEAT_RATE; padDir(d); }
      });
      var cur = H.stack[H.stack.length - 1];
      if (state.a && !prev.a) { if (cur && cur.id === 'title') show('menu', null, { replace: true }); else activateFocus(); }
      if (state.b && !prev.b) back();
      if (state.lb && !prev.lb) switchTab(-1);
      if (state.rb && !prev.rb) switchTab(1);
      if (state.start && !prev.start) show('menu', null, { reset: true });
      H.pad.prev = state;
    }
    H.raf = requestAnimationFrame(frame);
  }
  function padDir(d) {
    var el = H.focusEl;
    if (el && el.tagName === 'INPUT' && el.type === 'range' && (d === 'left' || d === 'right')) {
      var step = num(el.step, 1) || 1;
      el.value = clamp(num(el.value, 0) + (d === 'left' ? -step : step), num(el.min, 0), num(el.max, 100));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    var cur = H.stack[H.stack.length - 1];
    if (cur && cur.id === 'title') return;
    moveFocus(d);
  }

  /* ------------------------------------------------------- toast/modal */
  function toast(msg, kind) {
    if (!H) return;
    var host = H.root.querySelector('.gh-toasts');
    var t = div('gh-toast ' + (kind || ''), msg);
    host.appendChild(t);
    while (host.children.length > 4) host.removeChild(host.firstChild);
    setTimeout(function () { t.classList.add('out'); }, 2800);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3200);
  }
  /**
   * modal({title, body (html), actions:[{label, kind, value, autofocus}], onClose(value), wide}) -> {card, close(value)}
   */
  function modal(o) {
    if (!H) return null;
    closeModal(undefined, true);
    var wrap = div('gh-modal');
    var card = div('gh-modal-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', String(o.title || o.kicker || 'Dialog'));
    if (o.wide) card.style.width = 'min(860px,94vw)';
    card.innerHTML = (o.kicker ? '<div class="gh-kicker">' + esc(o.kicker) + '</div>' : '') + '<h2>' + esc(o.title || '') + '</h2>' + (o.body || '') +
      '<div class="gh-btns">' + (o.actions || [{ label: 'OK', kind: 'primary', value: true }]).map(function (a, i) {
        return '<button class="gh-btn ' + (a.kind || '') + '" data-nav data-mval="' + i + '"' + (a.disabled ? ' disabled' : '') + (a.title ? ' title="' + esc(a.title) + '"' : '') + (a.autofocus ? ' data-autofocus' : '') + '>' + esc(a.label) + '</button>';
      }).join('') + '</div>';
    wrap.appendChild(card);
    H.root.appendChild(wrap);
    var prevFocus = H.focusEl;
    var m = {
      // a dialog a screen opens while rendering belongs to the route that render is about to publish (onScreen -> URL)
      card: card, wrap: wrap, prevFocus: prevFocus, key: H.rendering ? null : routeKey(),
      close: function (v) { closeModal(v); }
    };
    m.onClose = o.onClose;
    m.actions = o.actions || [{ label: 'OK', value: true }];
    H.modal = m;
    if (m.key == null) later(function () { if (H.modal === m && m.key == null) m.key = routeKey(); }, 0);
    card.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-mval]');
      if (!b || b.disabled) return;
      var a = m.actions[+b.getAttribute('data-mval')];
      sfx(a && a.value === false ? 'back' : 'select');
      if (a && typeof a.handler === 'function') {
        // a handler that navigates (show() -> 'cb:route') must not see its own dialog cancelled under it
        var keep;
        if (H) H.modalAction = (H.modalAction || 0) + 1;
        try { keep = a.handler(m); } finally { if (H) H.modalAction = Math.max(0, (H.modalAction || 1) - 1); }
        if (keep === true) return;
      }
      closeModal(a ? a.value : undefined);
    });
    card.addEventListener('mousemove', function (e) { var t = e.target.closest && e.target.closest('[data-nav]'); if (t) setFocusEl(t, true); });
    wrap.addEventListener('click', function (e) { if (e.target === wrap) closeModal(false); });
    if (typeof o.mount === 'function') safe(function () { o.mount(card, m); });
    var f = card.querySelector('[data-autofocus]') || card.querySelector('.gh-btn.primary') || card.querySelector('[data-nav]');
    if (f) setFocusEl(f, true);
    return m;
  }
  function closeModal(value, silent) {
    if (!H || !H.modal) return;
    var m = H.modal;
    H.modal = null;
    if (m.wrap.parentNode) m.wrap.parentNode.removeChild(m.wrap);
    if (m.prevFocus && document.contains(m.prevFocus)) setFocusEl(m.prevFocus, true, true);
    if (!silent && typeof m.onClose === 'function') safe(function () { m.onClose(value); });
  }
  function confirmBox(title, body, okLabel, cb, opts) {
    opts = opts || {};
    return modal({
      title: title, kicker: opts.kicker, body: '<p>' + body + '</p>' + (opts.extra || ''),
      actions: [{ label: 'Cancel', kind: 'ghost', value: false }, { label: okLabel || 'Confirm', kind: opts.danger ? 'hot' : 'primary', value: true, autofocus: !opts.danger, disabled: opts.disabled }],
      onClose: function (v) { if (v) cb(); }
    });
  }

  /* ------------------------------------------------- background effect */
  /** Animated backdrop: perspective speed-lines / light streaks (title) and a slow drift (hub). */
  function createBgFx(canvas) {
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return { frame: function () {}, resize: function () {}, setMode: function () {}, destroy: function () {} };
    var W = 0, Hh = 0, dpr = 1, mode = 'title', streaks = [], last = 0, t0 = 0, dead = false;
    var R = rng(1234);
    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = canvas.clientWidth || window.innerWidth; Hh = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(Hh * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function spawn() {
      return { x: R() * 2 - 1, y: R() * 0.9 + 0.05, z: R() * 1 + 0.05, len: 0.05 + R() * 0.25, hue: R() < 0.2 ? 'hot' : R() < 0.6 ? 'gold' : 'white', w: R() * 1.6 + 0.4 };
    }
    for (var i = 0; i < 120; i++) streaks.push(spawn());
    resize();
    function frame(ts) {
      if (dead) return;
      if (!t0) t0 = ts;
      var dt = Math.min(0.05, (ts - (last || ts)) / 1000); last = ts;
      if (H && H.root.classList.contains('reduced')) dt *= 0.1;
      var t = (ts - t0) / 1000;
      ctx.clearRect(0, 0, W, Hh);
      var hz = Hh * (mode === 'title' ? 0.62 : 0.7);
      // horizon glow
      var g = ctx.createRadialGradient(W / 2, hz, 0, W / 2, hz, W * 0.6);
      g.addColorStop(0, mode === 'title' ? 'rgba(212,176,106,0.16)' : 'rgba(212,176,106,0.06)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, Hh);
      // perspective road grid
      ctx.save();
      ctx.globalAlpha = mode === 'title' ? 0.5 : 0.18;
      ctx.strokeStyle = 'rgba(212,176,106,0.35)'; ctx.lineWidth = 1;
      var speed = mode === 'title' ? 1.6 : 0.25;
      for (var k = 0; k < 18; k++) {
        var p = ((k / 18) + t * speed * 0.12) % 1;
        var y = hz + Math.pow(p, 2.2) * (Hh - hz);
        ctx.globalAlpha = (mode === 'title' ? 0.45 : 0.15) * p;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      ctx.globalAlpha = mode === 'title' ? 0.35 : 0.12;
      for (var j = -12; j <= 12; j++) {
        ctx.beginPath(); ctx.moveTo(W / 2 + j * 12, hz); ctx.lineTo(W / 2 + j * W * 0.16, Hh); ctx.stroke();
      }
      ctx.restore();
      // streaks
      var sp = mode === 'title' ? 0.9 : 0.12;
      for (var s = 0; s < streaks.length; s++) {
        var st = streaks[s];
        st.z -= dt * sp * (0.6 + st.w * 0.4);
        if (st.z <= 0.02) { streaks[s] = spawn(); streaks[s].z = 1; continue; }
        var sx = W / 2 + (st.x / st.z) * W * 0.18, sy = hz - (st.y / st.z) * Hh * 0.08 + (st.y > 0.5 ? (1 - st.z) * 30 : 0);
        var ex = W / 2 + (st.x / (st.z + st.len)) * W * 0.18;
        var a = clamp((1 - st.z) * 1.2, 0, 1) * (mode === 'title' ? 0.85 : 0.25);
        ctx.strokeStyle = st.hue === 'hot' ? 'rgba(232,50,43,' + a + ')' : st.hue === 'gold' ? 'rgba(243,217,160,' + a + ')' : 'rgba(255,255,255,' + a * 0.7 + ')';
        ctx.lineWidth = st.w * (1.2 - st.z);
        ctx.beginPath(); ctx.moveTo(ex, sy); ctx.lineTo(sx, sy); ctx.stroke();
      }
      // vignette
      var v = ctx.createRadialGradient(W / 2, Hh / 2, Math.min(W, Hh) * 0.3, W / 2, Hh / 2, Math.max(W, Hh) * 0.75);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.7)');
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, Hh);
    }
    return {
      frame: frame, resize: resize,
      setMode: function (m) { mode = m; },
      destroy: function () { dead = true; }
    };
  }

  /* ======================================================================
     Race flow: launch → (race UI | simulation fallback) → process → rewards
     ====================================================================== */
  /* ---- one settings store for driving options (UNIFY-SPEC: one game, one set of options) ----
     Camera / quality / steering assist live in the race UI's own store (forge.race.settings.v1), which every Race and
     Drift entry point reads. Settings reads and writes that store directly, with race-ui's own option lists. */
  var RACE_LS = 'forge.race.settings.v1';
  var RACE_CAMS_FB = [{ id: 'cockpit', name: 'Cockpit' }, { id: 'hood', name: 'Hood' }, { id: 'bumper', name: 'Bumper' }, { id: 'chase', name: 'Chase' },
    { id: 'chase-far', name: 'Chase far' }, { id: 'tv', name: 'TV' }, { id: 'heli', name: 'Heli' }, { id: 'map', name: 'Map' }];
  var RACE_QUALITY_FB = [{ id: 'auto', name: 'Auto' }, { id: 'low', name: 'Low' }, { id: 'medium', name: 'Med' }, { id: 'high', name: 'High' }, { id: 'ultra', name: 'Ultra' }];
  var STEER_FB = [{ id: 'off', name: 'Off' }, { id: 'light', name: 'Light' }, { id: 'medium', name: 'Medium' }, { id: 'heavy', name: 'Heavy' }, { id: 'auto', name: 'Auto' }];
  /** ' (this device: Medium)' — the tier 'Auto' graphics starts at (CB.device), or '' without it. */
  function autoTierNote() {
    try { var t = CB.device && CB.device.autoTier ? CB.device.autoTier() : ''; return t ? ' (this device: ' + titleCase(t) + ')' : ''; } catch (e) { return ''; }
  }
  /** An option list exported by race-ui (CB.race.ui._[name]) or the identical fallback. */
  function raceOpts(name, fb) {
    var L = CB.race && CB.race.ui && CB.race.ui._ && CB.race.ui._[name];
    if (!Array.isArray(L) || !L.length) return fb;
    return L.map(function (o) { return isObj(o) ? { id: o.id, name: o.name || titleCase(o.id) } : { id: o, name: titleCase(o) }; });
  }
  function raceStoreRaw() {
    try { var t = typeof localStorage !== 'undefined' ? localStorage.getItem(RACE_LS) : null; var o = t ? JSON.parse(t) : null; return isObj(o) ? o : {}; }
    catch (e) { return {}; }
  }
  /** Race-UI settings as the race setup will see them (sanitized with race-ui's own rules when it is loaded). */
  function raceStore() {
    var raw = raceStoreRaw();
    var san = CB.race && CB.race.ui && CB.race.ui._ && CB.race.ui._.sanitizeSettings;
    var o = typeof san === 'function' ? safe(function () { return san(clone(raw)); }, null) : null;
    return o || Object.assign({ camera3d: 'cockpit', driftCamera3d: 'chase', quality: 'auto', raceSteerAssist: steerAssistLevel('race'), driftSteerAssist: steerAssistLevel('drift') }, raw);
  }
  function raceStoreSet(key, value) {
    var o = raceStoreRaw();
    o[key] = value;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(RACE_LS, JSON.stringify(o)); } catch (e) { /* storage unavailable */ }
  }
  var STEER_IDS = ['off', 'light', 'medium', 'heavy', 'auto'];
  var STEER_DEFAULT = { race: 'light', drift: 'heavy' };
  /** Steering assist level of a discipline (Race: light, Drift: heavy by default). The race store (also changed from the
      race / drift setup) wins. Older saves shared one level whose default was heavy: a level the player picked there
      (anything but heavy) still applies to both disciplines until they set one (mirrors race-ui migrateAssist). */
  function steerAssistLevel(disc) {
    disc = disc === 'drift' ? 'drift' : 'race';
    var raw = raceStoreRaw(), own = raw[disc + 'SteerAssist'];
    if (STEER_IDS.indexOf(own) >= 0) return own;
    if (raw.assistDefaultsV !== 2) {
      var old = STEER_IDS.indexOf(raw.steerAssist) >= 0 ? raw.steerAssist : setting('steerAssist', null);
      if (STEER_IDS.indexOf(old) >= 0 && old !== 'heavy') return old;
    }
    return STEER_DEFAULT[disc];
  }
  /** Settings → Driving / quick session: remember a discipline's steering assist in the race store. */
  function setSteerAssistLevel(disc, v) {
    if (STEER_IDS.indexOf(v) < 0) return;
    var other = disc === 'drift' ? 'race' : 'drift';
    var o = raceStoreRaw();
    if (o.assistDefaultsV !== 2 && STEER_IDS.indexOf(o[other + 'SteerAssist']) < 0) raceStoreSet(other + 'SteerAssist', steerAssistLevel(other));   // keep the other one as it was
    raceStoreSet(disc === 'drift' ? 'driftSteerAssist' : 'raceSteerAssist', v);
    raceStoreSet('assistDefaultsV', 2);
  }

  /** Race-UI settings fragment from the profile (raceDefaults) + overrides. */
  function raceSettings(over) {
    var pm = prof();
    var base = pm && typeof pm.raceDefaults === 'function' ? safe(function () { return pm.raceDefaults(); }, {}) : {
      laps: setting('gameplay.defaultLaps', 3), opponents: setting('gameplay.defaultOpponents', 7), difficulty: setting('difficulty', 'amateur'),
      weather: setting('gameplay.weather', 'dry'), timeOfDay: setting('gameplay.timeOfDay', 'day'), field: setting('gameplay.field', 'similar'),
      assists: setting('assists', {}), units: setting('units', 'kph'), camera: setting('camera', 'chase')
    };
    var s = Object.assign({}, base, over || {});
    s.assists = Object.assign({}, base.assists || {}, (over && over.assists) || {});
    s.muted = !!setting('audio.muted', false);
    // CB.race.assist steering level (DRIFT-SPEC §1), per discipline: Light for racing, Heavy for drifting by default
    if (!(over && over.steerAssist)) s.steerAssist = steerAssistLevel(s.discipline);
    s.steerSensitivity = num(setting('controls.steerSensitivity', 1), 1);
    s.invertSteer = !!setting('controls.invertSteer', false);
    return s;
  }
  /**
   * launchRace({build, settings, cfg, context:{kind, champId, roundIdx, challengeId, carId, label}})
   * context.kind: 'quick' | 'timetrial' | 'career' | 'event' | 'challenge' | 'practice'
   */
  function launchRace(o) {
    o = o || {};
    var build = o.build || activeBuild();
    var ctx = Object.assign({ kind: 'quick' }, o.context || {});
    ctx.carId = ctx.carId || (activeCar() && activeCar().id) || null;
    var settings = raceSettings(o.settings);
    var R = raceUI();
    var cfg = Object.assign({}, o.cfg || {}, { settings: settings });
    if (!cfg.trackId && settings.trackId) cfg.trackId = settings.trackId;
    if (!R) {
      modal({
        kicker: 'Race module', title: 'Race module loading…',
        body: '<div class="gh-loading"><span><b>The circuit isn\'t ready yet.</b><br>The race engine (CB.race.ui) hasn\'t loaded on this page. ' +
          'You can wait and retry, or let the stewards simulate the session from your car\'s performance so your career keeps moving.</span></div>',
        actions: [{ label: 'Cancel', kind: 'ghost', value: false }, { label: 'Retry', value: 'retry' }, { label: 'Simulate session', kind: 'primary', value: 'sim', autofocus: true }],
        onClose: function (v) {
          if (v === 'retry') later(function () { launchRace(o); }, 50);
          else if (v === 'sim') {
            var res = simulateResults({ build: build, opponents: settings.mode === 'race' || !settings.mode ? settings.opponents : 0, laps: settings.laps, trackId: settings.trackId || cfg.trackId, difficulty: settings.difficulty, mode: settings.mode || 'race' });
            finishRace(res, ctx, settings, build);
          }
        }
      });
      return false;
    }
    var finished = null, done = false, seenResults = [];
    function onFinish(results) {
      if (!results || seenResults.indexOf(results) >= 0) return;   // callback + cb:race-finished event carry the same object
      seenResults.push(results);
      if (ctx.kind === 'career' || ctx.kind === 'event') { if (finished) return; }
      finished = results;
      ctx.resultsCount = (ctx.resultsCount || 0) + 1;
      H && (H.pendingRewards = processResults(results, ctx, settings, build));
    }
    function onClose() {
      if (done) return; done = true;
      if (H) {
        H.root.style.display = '';
        if (H.pendingRewards) { var m = H.pendingRewards; H.pendingRewards = null; show('rewards', rewardsParams(m)); }
        else refresh();
      }
    }
    var evListener = function (e) { if (e && e.detail) onFinish(e.detail.results || e.detail); };
    document.addEventListener('cb:race-finished', evListener);
    var cleanup = function () { document.removeEventListener('cb:race-finished', evListener); document.removeEventListener('cb:race-closed', closeListener); };
    var closeListener = function () { cleanup(); onClose(); };
    document.addEventListener('cb:race-closed', closeListener);
    var hooks = { onFinish: onFinish, onClose: function () { cleanup(); onClose(); }, context: ctx };
    var arg2 = Object.assign({}, cfg, hooks);
    if (H) H.root.style.display = 'none';
    var ok = safe(function () { R.open(build, arg2, hooks); return true; }, false);
    if (!ok) { cleanup(); if (H) H.root.style.display = ''; toast('Race UI failed to open', 'bad'); return false; }
    return true;
  }
  /** Rewards screen params: the model stays in memory; champId (primitive) reaches the URL so Back/Forward can fall back to it. */
  function rewardsParams(m) {
    var cid = m && m.context && m.context.champId;
    return cid ? { model: m, champId: String(cid) } : { model: m };
  }
  function finishRace(results, ctx, settings, build) {
    var model = processResults(results, ctx, settings, build);
    show('rewards', rewardsParams(model));
  }

  /**
   * processResults(results, ctx, settings, build) -> rewards model
   * Applies stats, credits/xp, career standings and achievements exactly once.
   */
  function processResults(results, ctx, settings, build) {
    ctx = ctx || {}; settings = settings || {};
    var pm = prof(), E = eco(), C = career(), A = achv();
    var p0 = P();
    var before = { credits: p0.credits, xp: p0.xp, level: p0.level, info: levelInfo() };
    var mode = settings.mode || (ctx.kind === 'timetrial' ? 'time-trial' : 'race');
    var config = {
      mode: mode, trackId: settings.trackId || (results && results.trackId) || null, laps: settings.laps, difficulty: settings.difficulty,
      opponents: settings.opponents, carId: ctx.carId, eventType: ctx.eventType || null, fieldSize: results && results.fieldSize
    };
    var summary = summarize(results, config);
    var model = {
      kind: ctx.kind, context: ctx, mode: mode, trackId: config.trackId, summary: summary, simulated: !!(results && results.simulated),
      results: results, credits: 0, xp: 0, breakdown: [], before: before, achievements: [], standings: null, pointsTable: null,
      championshipComplete: false, trophy: null, records: []
    };
    var careerRes = null;
    // Safety net: race-ui flags sessions whose circuit/laps/field/weather differ from the career launch.
    // Such a run is not a valid round — record nothing and tell the player why.
    var mismatch = (ctx.kind === 'career' || ctx.kind === 'event') && results && results.launchMismatch;
    if (mismatch) {
      model.notCounted = true;
      model.notCountedReason = 'Session settings changed (' + arr(results.launchMismatchKeys).join(', ') + ') — round not counted.';
      safe(function () { toast(model.notCountedReason, 'warn'); });
    }
    if (!mismatch && (ctx.kind === 'career' || ctx.kind === 'event') && C && typeof C.recordResult === 'function') {
      var statsBefore = num(getPath(p0, 'stats.races'), 0) + num(getPath(p0, 'stats.timeTrials'), 0) + num(getPath(p0, 'stats.practiceSessions'), 0);
      var credBefore = p0.credits, xpBefore = p0.xp, statsAfter = statsBefore, credAfter = credBefore, xpAfter = xpBefore;
      updateProfile(function (p) {
        careerRes = C.recordResult(p, ctx.champId, ctx.roundIdx, results);
        statsAfter = num(getPath(p, 'stats.races'), 0) + num(getPath(p, 'stats.timeTrials'), 0) + num(getPath(p, 'stats.practiceSessions'), 0);
        credAfter = p.credits; xpAfter = p.xp;
      }, { reason: 'career-result' });
      careerRes = careerRes || {};
      if (statsAfter === statsBefore && pm && typeof pm.recordRaceStats === 'function') {
        var s2 = safe(function () { return pm.recordRaceStats(results, config); }, null);
        if (s2) { summary = s2; model.summary = s2; }
      }
      var rw = careerRes.rewards || {};
      model.breakdown = arr(rw.breakdown);
      var gotCred = P().credits - credBefore, gotXp = P().xp - xpBefore;
      if (credAfter === credBefore && num(rw.credits, 0) > 0 && pm) { safe(function () { pm.award({ credits: rw.credits, xp: xpAfter === xpBefore ? rw.xp : 0, reason: 'Career · ' + (ctx.label || 'round'), category: 'race' }); }); }
      else if (xpAfter === xpBefore && num(rw.xp, 0) > 0 && pm) safe(function () { pm.addXp(rw.xp, 'Career round'); });
      gotCred = P().credits - credBefore; gotXp = P().xp - xpBefore;
      model.credits = Math.max(num(rw.credits, 0), gotCred);
      model.xp = Math.max(num(rw.xp, 0), gotXp);
      model.pointsTable = careerRes.pointsTable || null;
      model.standings = careerRes.standings ? normalizeStandings(careerRes.standings) : null;
      model.championshipComplete = !!careerRes.championshipComplete;
      model.trophy = careerRes.trophy || null;
      if (A) {
        model.achievements = model.achievements.concat(arr(safe(function () {
          return A.check(null, { type: 'career', action: model.championshipComplete ? 'championship-complete' : 'round-complete', champId: ctx.champId,
            standings: careerRes.standings, trophy: careerRes.trophy, pointsTable: careerRes.pointsTable, roundPosition: summary.position, eventType: ctx.eventType, perfect: !!careerRes.perfect, position: model.championshipComplete ? first(careerRes.position, model.trophy && model.trophy.position) : summary.position });
        }, [])));
      }
    } else {
      // quick race / time trial / practice / challenge (or career without the module)
      var s = pm && typeof pm.recordRaceStats === 'function' ? safe(function () { return pm.recordRaceStats(results, config); }, null) : null;
      if (s) { summary = s; model.summary = s; }
      model.records = arr(s && s.newRecords);
      var mult = ctx.kind === 'quick' ? 0.5 : ctx.kind === 'timetrial' ? 0.2 : ctx.kind === 'challenge' ? 0.3 : 0.5;
      var label = ctx.kind === 'quick' ? 'Quick race purse' : ctx.kind === 'timetrial' ? 'Time trial stipend' : 'Session purse';
      // Arcade is a fun mode (nitro, items, stunt tracks): it pays half the usual purse so it never out-earns real racing.
      if (results && (results.handling === 'arcade' || (results.settings && results.settings.handling === 'arcade'))) { mult *= 0.5; label = 'Arcade purse'; }
      var rw2 = null;
      // Challenges pay only through their medal bonus below; a timed session without a single timed lap pays nothing
      // (otherwise quitting straight after the start would be a free purse).
      var noLap = mode !== 'race' && !isNum(summary.bestLap_s);
      if (ctx.kind === 'drift' || (results && results.discipline === 'drift')) { rw2 = driftRewards(results, settings); model.drift = rw2.drift; }
      else if (ctx.kind === 'challenge' || noLap) rw2 = { credits: 0, xp: 0, breakdown: noLap && ctx.kind !== 'challenge' ? [{ label: 'No timed lap — no purse', credits: 0, xp: 0 }] : [] };
      if (E && !rw2) {
        rw2 = safe(function () {
          return E.rewardsFromResults ? E.rewardsFromResults(results, { difficulty: settings.difficulty, laps: settings.laps, trackId: config.trackId, mode: mode, multiplier: mult, multiplierLabel: label })
            : E.raceRewards({ position: summary.position, fieldSize: summary.fieldSize, difficulty: settings.difficulty, laps: settings.laps, trackId: config.trackId, cleanRace: summary.clean, fastestLap: summary.fastestLap, pole: summary.pole, multiplier: mult, multiplierLabel: label });
        }, null);
      }
      if (!rw2) {
        var pos = num(summary.position, 8), fs = Math.max(1, num(summary.fieldSize, 8));
        var base = Math.round((fs - pos + 1) / fs * 9000 * mult / 100) * 100;
        rw2 = { credits: base, xp: Math.round(base / 6), breakdown: [{ label: 'Finishing position ' + ordinal(pos), credits: base, xp: Math.round(base / 6) }] };
      }
      model.breakdown = arr(rw2.breakdown);
      model.credits = Math.max(0, Math.round(num(rw2.credits, 0)));
      model.xp = Math.max(0, Math.round(num(rw2.xp, 0)));
      if (pm && (model.credits || model.xp)) safe(function () { pm.award({ credits: model.credits, xp: model.xp, reason: (ctx.label || titleCase(ctx.kind)) + ' · ' + trackName(config.trackId, true), category: 'race' }); });
      else if (!pm) { var fp = fallbackProfile(); fp.credits += model.credits; fp.xp += model.xp; fp.level = levelFromXp(fp.xp); emitLocal(); }
    }
    if (ctx.kind === 'challenge' && ctx.challengeId) {
      var chs = ctx.session || null, ev = null;
      if (results && isObj(results.challenge)) ev = results.challenge;
      else if (results && isObj(results.evaluation)) ev = results.evaluation;
      else if (chs && typeof chs.evaluate === 'function') ev = safe(function () { return chs.evaluate(results && (results.snapshot || results.lastSnapshot) || results); }, null);
      if (ev && isNum(ev.score)) {
        var cdef = challengeList().filter(function (c) { return c.id === ctx.challengeId; })[0] || {};
        var lower = !!(cdef.lowerIsBetter || getPath(cdef, 'rules.lowerIsBetter'));
        var rec = chSaveRecord(ctx.challengeId, { score: ev.score, medal: ev.medal || null, lowerIsBetter: lower });
        model.challenge = { id: ctx.challengeId, name: cdef.name || titleCase(ctx.challengeId), score: ev.score, medal: ev.medal || null, best: rec.score, def: cdef };
        var CM = chal(), full = results && isObj(results.challengeResult) ? results.challengeResult : Object.assign({}, ev), cr = null;
        if (CM && typeof CM.recordResult === 'function') {
          // the module owns records, licences and medal-upgrade rewards (a medal pays once, upgrades pay the difference)
          updateProfile(function (p) { cr = CM.recordResult(p, ctx.challengeId, full); }, { reason: 'challenge-result' });
          if (cr && cr.best != null) model.challenge.best = cr.best;
          var crw = cr && cr.rewards;
          if (crw) {
            arr(crw.breakdown).forEach(function (b) { model.breakdown.push(b); });
            model.credits += Math.max(0, num(crw.credits, 0)); model.xp += Math.max(0, num(crw.xp, 0));
            if (pm && (num(crw.credits, 0) || num(crw.xp, 0))) safe(function () { pm.award({ credits: num(crw.credits, 0), xp: num(crw.xp, 0), reason: 'Challenge · ' + model.challenge.name, category: 'challenge' }); });
          }
          if (cr && cr.licenseEarned) model.license = cr.licenseEarned;
        }
        var bonus = cr ? 0 : ({ bronze: 1500, silver: 3500, gold: 7500, platinum: 12000 }[ev.medal] || 0);
        if (bonus) {
          model.breakdown.push({ label: titleCase(ev.medal) + ' medal · ' + model.challenge.name, credits: bonus, xp: Math.round(bonus / 5) });
          model.credits += bonus; model.xp += Math.round(bonus / 5);
          if (pm) safe(function () { pm.award({ credits: bonus, xp: Math.round(bonus / 5), reason: 'Challenge medal · ' + model.challenge.name, category: 'challenge' }); });
        }
        if (A) model.achievements = model.achievements.concat(arr(safe(function () { return A.check(null, { type: 'challenge', id: ctx.challengeId, medal: ev.medal, score: ev.score }); }, [])));
      } else {
        var cdef0 = challengeList().filter(function (c) { return c.id === ctx.challengeId; })[0] || {};
        model.challenge = { id: ctx.challengeId, name: cdef0.name || titleCase(ctx.challengeId), score: null, medal: null, best: null, def: cdef0, reason: ev && ev.reason };
      }
    }
    if (A) {
      model.achievements = model.achievements.concat(arr(safe(function () { return A.check(null, { type: 'race-finished', results: results, config: config }); }, [])));
      model.achievements = model.achievements.concat(arr(safe(function () { return A.check(null, { type: 'stat', stats: P().stats }); }, [])));
    }
    var p1 = P();
    model.after = { credits: p1.credits, xp: p1.xp, level: p1.level, info: levelInfo() };
    model.levelUp = p1.level > before.level;
    model.newUnlocks = [];
    if (model.levelUp && E && typeof E.unlocksAtLevel === 'function') {
      for (var l = before.level + 1; l <= p1.level; l++) model.newUnlocks = model.newUnlocks.concat(arr(safe(function () { return E.unlocksAtLevel(l); }, [])));
    }
    var seen = {};
    model.achievements = model.achievements.filter(function (a) { if (!a || seen[a.id]) return false; seen[a.id] = 1; return true; });
    return model;
  }

  /** Drift purse: paid on score (scaled by scoring difficulty) plus a medal bonus; free runs pay half. */
  function driftRewards(results, settings) {
    results = results || {}; settings = settings || {};
    var d = isObj(results.drift) ? results.drift : {};
    var score = Math.max(0, num(d.total, num(results.driftScore, 0)));
    var medal = d.medal || null;
    var diff = { rookie: 0.8, amateur: 1, pro: 1.25, alien: 1.5 }[settings.difficulty] || 1;
    var free = (results.driftMode || settings.driftMode) === 'free';
    var base = Math.min(18000, Math.round(score * 0.06 * diff * (free ? 0.5 : 1) / 50) * 50);
    var bonus = free ? 0 : Math.round(({ bronze: 800, silver: 2000, gold: 4000, platinum: 7000 }[medal] || 0) * diff / 50) * 50;
    var breakdown = [{ label: 'Drift score · ' + fmtInt(score) + ' pts' + (free ? ' (free run, half purse)' : ''), credits: base, xp: Math.round(base / 5) }];
    if (bonus) breakdown.push({ label: titleCase(medal) + ' medal', credits: bonus, xp: Math.round(bonus / 4) });
    if (!score) breakdown = [{ label: 'No drift score, no purse', credits: 0, xp: 0 }];
    return { credits: base + bonus, xp: Math.round(base / 5) + Math.round(bonus / 4), breakdown: breakdown,
      drift: { score: score, medal: medal, mode: results.driftMode || settings.driftMode || null, bestDrift: d.bestDrift || null, maxCombo: d.maxCombo || d.maxMultiplier || null } };
  }

  /** Public integration point: the integrator may call this directly. */
  function reportRaceResult(results, ctx) {
    var model = processResults(results, ctx || { kind: 'quick' }, (ctx && ctx.settings) || {}, null);
    if (H) show('rewards', rewardsParams(model));
    return model;
  }

  /* ======================================================================
     Shared view fragments
     ====================================================================== */
  function piBadge(build, label) {
    var pi = performanceIndex(metricsFor(build)), c = piClass(pi), what = 'Class ' + c.id + ', performance index ' + pi;
    // label: optional visible text ("Your car") so the chip is not just a letter and a number
    return '<span class="gh-pi" style="--c:' + c.color + '" role="img" aria-label="' + esc((label ? label + ': ' : '') + what) + '" title="' + esc(what) + '">' +
      (label ? '<i aria-hidden="true">' + esc(label) + '</i>' : '') + '<b aria-hidden="true">' + c.id + '</b><span aria-hidden="true">' + pi + ' PI</span></span>';
  }
  function carStatsStrip(build) {
    var m = metricsFor(build) || {}, u = setting('units', 'kph');
    return '<div class="gh-hero-stats">' +
      '<div><b>' + fmtInt(m.power_hp) + '</b><small>hp</small></div>' +
      '<div><b>' + fmtInt(m.weight_kg) + '</b><small>kg</small></div>' +
      '<div><b>' + (isNum(m.zeroTo60_s) ? m.zeroTo60_s.toFixed(1) : '—') + '</b><small>0–60 s</small></div>' +
      '<div><b>' + (u === 'mph' ? Math.round(num(m.topSpeed_kph, 0) * 0.621371) : fmtInt(m.topSpeed_kph)) + '</b><small>' + (u === 'mph' ? 'mph top' : 'km/h top') + '</small></div></div>';
  }
  function moduleMissing(name, what) {
    return '<div class="gh-loading"><span><b>' + esc(name) + ' module loading…</b><br>' + esc(what || 'This feature becomes available as soon as the module is loaded.') + '</span></div>';
  }
  /** The career entry-car offer for the current Atelier build (C.entryCarOffer), or null. */
  function entryOffer() {
    var C = career();
    if (!C || typeof C.entryCarOffer !== 'function') return null;
    try { var o = C.entryCarOffer(); return o && o.build ? o : null; } catch (e) { return null; }
  }
  /** One line explaining how the unlock rules detuned the Atelier build (e.g. "647 hp → 231 hp at level 1"), or ''. */
  function entryDetuneText(offer) {
    if (!offer || !Array.isArray(offer.changes) || !offer.changes.length) return '';
    var raw = null;
    try { raw = CB.state && typeof CB.state.get === 'function' ? CB.state.get() : null; } catch (e) { raw = null; }
    var a = raw ? metricsFor(raw) : null, b = metricsFor(offer.build), lv = num(getPath(P() || {}, 'level'), 1);
    var n = offer.changes.length + ' part' + (offer.changes.length === 1 ? '' : 's') + ' not unlocked yet';
    if (a && b && isNum(a.power_hp) && isNum(b.power_hp) && Math.round(a.power_hp) !== Math.round(b.power_hp)) {
      return n + ': ' + fmtInt(a.power_hp) + ' hp → ' + fmtInt(b.power_hp) + ' hp at level ' + lv + '. Race and Drift still use the full build.';
    }
    return n + ' at level ' + lv + ', so the career copy is detuned. Race and Drift still use the full build.';
  }
  function needCarNotice() {
    var offer = entryOffer();
    if (offer) {
      var det = entryDetuneText(offer);
      return '<div class="gh-empty"><b>Register your Garage build</b>Use <b>' + esc(offer.name) + '</b>, the car you drive in Race and Drift, as your free career entry car.' +
        (det ? '<div class="cb-hint" style="margin-top:8px">' + esc(det) + '</div>' : '') +
        '<div class="gh-btns" style="justify-content:center;margin-top:16px"><button class="gh-btn primary" data-nav data-act="register-entry">Register this build</button>' +
        '<button class="gh-btn" data-nav data-act="showroom">Visit showroom</button></div></div>';
    }
    return '<div class="gh-empty"><b>No career car yet</b>Buy your first car from the showroom to start racing in career mode.' +
      '<div class="gh-btns" style="justify-content:center;margin-top:16px"><button class="gh-btn primary" data-nav data-act="showroom">Visit showroom</button></div></div>';
  }
  /** data-act="register-entry": C.registerAtelierBuild() + a toast that lists what the unlock rules changed. */
  function registerEntry() {
    var C = career(), offer = entryOffer(), det = entryDetuneText(offer), r = null;
    try { r = C && typeof C.registerAtelierBuild === 'function' ? C.registerAtelierBuild() : null; } catch (e) { r = null; }
    if (r && r.ok) {
      toast(icon('check', 14) + ' Registered ' + esc((r.car && r.car.name) || (offer && offer.name) || 'your build') + ' as your entry car' + (det ? ' · ' + esc(det) : ''), 'success');
      refresh();
    } else {
      sfx('error');
      toast(esc((r && r.reason) || 'Could not register the build'), 'warn');
    }
  }
  function diffPips(n) {
    var s = '<span class="gh-diff" title="Difficulty ' + n + '/5">';
    for (var i = 1; i <= 5; i++) s += '<i class="' + (i <= n ? 'on' : '') + '"></i>';
    return s + '</span>';
  }
  function tabsHTML(tabs, active) {
    return '<div class="gh-tabs" role="tablist">' + tabs.map(function (t, i) {
      return '<button class="gh-tab' + (t.id === active ? ' is-active' : '') + '" role="tab" data-nav data-key="tab-' + t.id + '" data-act="tab" data-tab="' + t.id + '">' + esc(t.name) + (t.count != null ? ' <span class="k">' + t.count + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function setParam(k, v) {
    var cur = H.stack[H.stack.length - 1];
    cur.params = Object.assign({}, cur.params, (function () { var o = {}; o[k] = v; return o; })());
  }

  /* ======================================================================
     Screen: title
     ====================================================================== */
  screen('title', {
    title: 'Redline',
    render: function (host) {
      var b = activeBuild(), p = P();
      var coarse = hasDOM && window.matchMedia ? safe(function () { return window.matchMedia('(pointer: coarse)').matches; }, false) : false;
      host.className = 'gh-title';
      host.style.padding = '0';
      var letters = 'REDLINE'.split('').map(function (c, i) { return '<span' + (i >= 3 ? ' class="is-red"' : '') + ' style="animation-delay:' + (0.15 + i * 0.09) + 's">' + c + '</span>'; }).join('');
      host.innerHTML = '<div class="gh-title-logo" aria-label="Redline">' + letters + '</div>' +
        '<div class="gh-title-tag">Build it · Race it · Drift it</div>' +
        '<div class="gh-title-car">' + carArt(b, { spin: true, uid: 'title', own: !(CB.render && CB.render.thumbnail) }) + '</div>' +
        '<div class="gh-title-press">' + (coarse ? 'Tap to start' : 'Press any key') + (H.pad.active ? ' · Ⓐ' : '') + '</div>' +
        '<div class="gh-title-meta"><span>' + esc(p.driverName || 'Driver') + ' · Level ' + (p.level || 1) + '</span><span>' + esc(buildName(b, '')) + '</span><span>© Redline</span></div>';
      host.addEventListener('click', function () { sfx('select'); show('menu', null, { replace: true }); });
    }
  });

  /* ======================================================================
     Screen: main menu
     ====================================================================== */
  var MENU = [
    { id: 'career', label: 'Career', desc: 'Five tiers from Rookie Cup to Hypercar Masters', icon: 'career' },
    { id: 'quickrace', label: 'Quick Race · Drift', desc: 'Race a full grid or go sideways in a scored 3D drift run', icon: 'race' },
    { id: 'timetrial', label: 'Time Trial', desc: 'Solo hot laps against your ghost', icon: 'timer' },
    { id: 'challenges', label: 'Challenges', desc: 'Driving school: launch, braking, slalom, drift score attack', icon: 'cone' },
    { id: 'atelier', label: 'Garage', desc: 'Build and tune your car — design without limits', icon: 'wrench' },
    { id: 'garage', label: 'My Cars', desc: 'Current build, saved builds and career cars', icon: 'garage' },
    { id: 'achievements', label: 'Achievements', desc: 'Medals, milestones and secrets', icon: 'star' },
    { id: 'replays', label: 'Replays', desc: 'Relive and export your best moments', icon: 'film' },
    { id: 'profile', label: 'Profile & Stats', desc: 'Your racing record in numbers', icon: 'chart' },
    { id: 'settings', label: 'Settings', desc: 'Controls, audio, assists, graphics', icon: 'gear' }
  ];
  /** Main-menu entries. In the unified game Race and Drift are the router's #/race and #/drift screens. */
  function menuItems() {
    if (!routerMod()) return MENU;
    var out = [];
    MENU.forEach(function (m) {
      if (m.id === 'quickrace') {
        out.push({ id: 'race', label: 'Race', desc: 'Pick a circuit and race a full grid in 3D', icon: 'race' });
        out.push({ id: 'drift', label: 'Drift', desc: 'Go sideways: scored 3D drift runs, free or tandem', icon: 'drift' });
        out.push({ id: 'arcade', label: 'Arcade', desc: 'No-grip-loss arcade racing: stunt tracks, boosts, every circuit', icon: 'bolt' });
        out.push({ id: 'derby', label: 'Demolition Derby', desc: 'Bolt on a flamethrower or a ram and wreck them all: last car standing', icon: 'derby' });
        out.push({ id: 'f1', label: 'Formula 1', desc: 'Pick your team: identical F1 cars on the real circuits, weekends and championships', icon: 'f1' });
      } else if (m.id === 'atelier') out.push({ id: 'atelier', label: 'Garage', desc: 'Build and tune your car — what you build is what you drive', icon: 'wrench' });
      else out.push(m);
    });
    return out;
  }
  /** The menu hero shows the same low-poly 3D car the game drives: one still from the Garage studio renderer
      (CB.studio3d.still), cached per build / theme / size; the 2D drawing stays when WebGL is unavailable. */
  var HERO_STILL = { key: '', url: null };
  function heroStill(el, b) {
    var S3 = CB.studio3d;
    if (!el || !b || !hasDOM || !S3 || typeof S3.still !== 'function') return;
    var apply = function (url) {
      if (!url || !el.isConnected) return;
      el.innerHTML = '<img class="gh-hero-img" alt="' + esc(buildName(b)) + ' — 3D studio render" src="' + url + '">';
      el.classList.add('is-3d');
    };
    var w = Math.min(760, Math.max(260, el.clientWidth || 640)), hh = Math.round(w * 0.4);
    var key = hashStr(safe(function () { return JSON.stringify(b); }, '') || '') + '|' + appTheme() + '|' + Math.round(w / 40);
    if (HERO_STILL.key === key) { apply(HERO_STILL.url); return; }
    setTimeout(function () {   // after the menu has painted: building the mesh takes a few tens of ms
      if (!el.isConnected) return;
      var url = safe(function () { return S3.still(b, { width: w, height: hh }); }, null);
      HERO_STILL = { key: key, url: url };
      apply(url);
    }, 80);
  }
  function openAtelier(mode, extra) {
    var app = appMod();
    var router = routerMod();
    // unified game: Free Build is simply the #/atelier screen (no session banner)
    if (router && mode === 'free') return !!router.go('atelier');
    if (app) {
      if (H) { H.root.style.display = 'none'; H.inAtelier = mode; if (!H.routed) document.documentElement.style.overflow = H.prevOverflow || ''; }
      // career buy / upgrade: the hub stays parked while the player configures on #/atelier, then resumes where it was
      var hubScreen = H && H.stack.length ? H.stack[H.stack.length - 1].id : null;
      if (router) router.go('atelier', null, { keepHub: true });
      var restore = function () {
        if (!H) { if (router) router.go(hubScreen ? 'menu/' + hubScreen : 'menu'); return; }
        H.inAtelier = null; H.root.style.display = '';
        if (!H.routed) document.documentElement.style.overflow = 'hidden';
        if (router) {
          var R0 = router._ && router._.fromHubScreen ? router._.fromHubScreen(H.stack[H.stack.length - 1].id) : { route: 'menu', sub: null };
          router.go(R0.route + (R0.sub ? '/' + R0.sub : ''));
        }
        refresh();
      };
      var o = Object.assign({ mode: mode }, extra || {});
      var userConfirm = o.onConfirm, userCancel = o.onCancel;
      o.onConfirm = function (build) { restore(); if (userConfirm) userConfirm(build); };
      o.onCancel = function () { restore(); if (userCancel) userCancel(); };
      o.onClose = o.onClose || function () { restore(); };
      var ok = safe(function () { app.openAtelier(o); return true; }, false);
      if (!ok) restore();
      return ok;
    }
    return false;
  }
  screen('menu', {
    title: 'Main menu', live: true,
    render: function (host) {
      var b = activeBuild(), car = activeCar(), p = P(), li = levelInfo();
      // Unified game: the menu's Race / Drift drive the Atelier build (CB.state), so the hero shows that build.
      var heroCar = car, ab = (H && H.routed) ? currentAtelierBuild() : null;
      if (ab) { b = ab; heroCar = null; }
      var A = achv(), sum = A ? safe(function () { return A.summary(); }, null) : null;
      var E = eco(), next = E ? arr(safe(function () { return E.nextUnlocks(p, 3); }, [])) : [];
      var model = careerModel(career(), p);
      var nextChamp = null;
      model.tiers.forEach(function (t) { t.championships.forEach(function (c) { if (!nextChamp && !c.locked && c.started) nextChamp = c; }); });
      var items = menuItems(), byId = {};
      items.forEach(function (m) { byId[m.id] = m; });
      var badgeOf = function (id) {
        if (id === 'garage' && car && num(car.condition, 1) < 0.6) return '<span class="badge" title="Your career car needs a repair">!</span>';
        if (id === 'career' && nextChamp) return '<span class="badge">R' + (nextChamp.roundsDone + 1) + '</span>';
        return '';
      };
      // Play: every driving mode as a tile (mode accent = --mode-* tokens, css/styles.css § 01); the rest as compact rows
      var PLAY = [
        { id: 'race', short: 'Full grid, 3D circuits', mc: 'race' }, { id: 'drift', short: 'Scored runs, free or tandem', mc: 'drift' },
        { id: 'arcade', short: 'Stunt tracks, nitro and items', mc: 'arcade' }, { id: 'derby', short: 'Weapons on, last car standing', mc: 'derby' },
        { id: 'f1', short: 'Pick a team, real circuits', mc: 'f1' }, { id: 'timetrial', short: 'Hot laps against your ghost', mc: 'career' }
      ];
      var playIds = {};
      var tiles = PLAY.filter(function (t) { return byId[t.id]; }).map(function (t) {
        var m = byId[t.id]; playIds[t.id] = 1;
        return '<button class="gh-mode" role="menuitem" data-nav data-key="mi-' + m.id + '" data-act="go" data-id="' + m.id + '" title="' + esc(m.desc) + '" style="--mc:var(--mode-' + t.mc + ');--mcs:var(--mode-' + t.mc + '-soft)">' +
          '<span class="gh-mode-art" aria-hidden="true">' + icon(m.icon, 120) + '</span><span class="gh-mode-ic">' + icon(m.icon, 20) + '</span>' +
          '<span class="gh-mode-lbl">' + esc(m.id === 'derby' ? 'Derby' : m.label) + badgeOf(m.id) + '</span><span class="gh-mode-ds">' + esc(t.short) + '</span></button>';
      });
      if (routerMod()) {
        tiles.push('<button class="gh-mode" role="menuitem" data-nav data-key="mi-multiplayer" data-act="go" data-id="multiplayer" title="Peer-to-peer races with friends, each in their own build" style="--mc:var(--mode-online);--mcs:var(--mode-online-soft)">' +
          '<span class="gh-mode-art" aria-hidden="true">' + icon('users', 120) + '</span><span class="gh-mode-ic">' + icon('users', 20) + '</span>' +
          '<span class="gh-mode-lbl">Multiplayer</span><span class="gh-mode-ds">Race friends online</span></button>');
      }
      var links = items.filter(function (m) { return !playIds[m.id]; }).map(function (m) {
        return '<button class="gh-link" role="menuitem" data-nav data-key="mi-' + m.id + '" data-act="go" data-id="' + m.id + '">' +
          '<span class="gh-link-ic">' + icon(m.icon, 18) + '</span><span class="gh-link-txt"><b>' + esc(m.label) + badgeOf(m.id) + '</b><small>' + esc(m.desc) + '</small></span>' +
          '<span class="gh-link-go" aria-hidden="true">' + icon('chev', 16) + '</span></button>';
      });
      var careerCta = nextChamp
        ? '<button class="gh-btn big" data-nav data-key="cta-career" data-act="go" data-id="career">' + icon('career', 18) + '<span>Continue career<small>' + esc(nextChamp.name) + ' · round ' + (nextChamp.roundsDone + 1) + ' of ' + nextChamp.rounds.length + '</small></span></button>'
        : '<button class="gh-btn big" data-nav data-key="cta-career" data-act="go" data-id="career">' + icon('career', 18) + '<span>Start career<small>Rookie Cup to Hypercar Masters</small></span></button>';
      var quickCta = routerMod() && CB.app && typeof CB.app.drive === 'function'
        ? '<button class="gh-btn primary big" data-nav data-key="cta-quick" data-act="quick" data-autofocus>' + icon('play', 18) + '<span>Quick race<small>Your last setup, straight to the grid</small></span></button>'
        : '<button class="gh-btn primary big" data-nav data-key="cta-quick" data-act="go" data-id="' + (byId.race ? 'race' : 'quickrace') + '" data-autofocus>' + icon('play', 18) + '<span>Quick race<small>Pick a circuit and go</small></span></button>';
      host.innerHTML = '<div class="gh-home" role="menu" aria-label="Main menu">' +
        '<section class="gh-home-hero">' +
          '<div class="gh-home-txt"><div class="gh-kicker">' + (heroCar ? 'Active car' : 'Your build') + (b ? ' · ' + esc(modelName(b) || titleCase(bodyStyleOf(b))) : '') + '</div>' +
          '<div class="gh-hero-name">' + esc(heroCar ? heroCar.name : buildName(b)) + '</div>' +
          '<div class="gh-home-chips">' + (b ? piBadge(b) : '') + (heroCar ? '<span class="gh-chip ' + conditionLabel(heroCar.condition).kind + '">' + conditionLabel(heroCar.condition).label + ' · ' + pct(heroCar.condition) + '</span>'
            : ab ? (car ? '<span class="gh-chip" title="Career championships use your active career car">Career car · ' + esc(car.name) + '</span>' : '') : '<span class="gh-chip warn">Not owned</span>') +
            '<button class="gh-btn ghost small" data-nav data-key="cta-garage" data-act="go" data-id="atelier">' + icon('wrench', 14) + 'Tune in Garage</button></div>' +
          '<div class="gh-home-cta">' + quickCta + careerCta + '</div>' +
          '<div class="gh-home-prog">' +
            '<div class="gh-home-lv"><span><b>Level ' + li.level + '</b> · ' + esc(levelTitle(li.level)) + '</span><span class="gh-num">' + (li.maxed ? 'Max level' : fmtInt(li.remaining) + ' XP to go') + '</span>' +
              '<div class="gh-bar"><i style="width:' + (li.progress * 100).toFixed(1) + '%"></i></div></div>' +
            '<div class="gh-home-stat"><small>' + 'Next unlock' + '</small><span>' + (next.length ? esc(next[0].name || titleCase(next[0].id)) + ' · Lv ' + next[0].level : 'Everything unlocked') + '</span></div>' +
            '<div class="gh-home-stat"><small>Achievements</small><span>' + (sum ? sum.unlocked + ' / ' + sum.total + ' · ' + pct(sum.pct) : 'Loading…') + '</span></div>' +
          '</div></div>' +
          '<div class="gh-home-car"><div class="car" data-gh-hero3d>' + carArt(b, { uid: 'menu' }) + '</div>' + (b ? carStatsStrip(b) : '') + '</div>' +
        '</section>' +
        '<h2 class="gh-h2">Play</h2><div class="gh-modes">' + tiles.join('') + '</div>' +
        '<h2 class="gh-h2">Progress &amp; garage</h2><div class="gh-links">' + links.join('') + '</div>' +
        '</div>';
      heroStill(host.querySelector('[data-gh-hero3d]'), b);
      onAct(host, {
        go: function (d) {
          var router = routerMod();
          if (router && d.id === 'arcade') { router.go('arcade'); return; }
          if (router && d.id === 'derby') { router.go('derby'); return; }   // ARCADE-SPEC / DERBY-SPEC: their own modes, never career-recorded
          if (router && d.id === 'f1') { router.go('f1'); return; }   // F1-SPEC: its own mode
          if (router && (d.id === 'race' || d.id === 'drift')) {
            if (CB.app && typeof CB.app.drive === 'function') CB.app.drive(d.id); else router.go(d.id);
            return;
          }
          if (router && d.id === 'timetrial' && raceUI()) {
            // one race setup for the whole game: Time Trial is the race UI's own mode, with the Atelier build
            H.lastLaunch = { build: currentAtelierBuild() || activeBuild(), settings: { discipline: 'race', mode: 'time-trial', opponents: 0 }, cfg: { autoStart: false }, context: { kind: 'timetrial', label: 'Time trial' } };
            launchRace(H.lastLaunch);
            return;
          }
          if (d.id === 'race' || d.id === 'drift') { show('quickrace', d.id === 'drift' ? { discipline: 'drift' } : null); return; }
          if (d.id === 'atelier') {
            if (!openAtelier('free')) {
              if (H.standalone && hasDOM) {
                confirmBox('Open the Garage', 'The car builder lives on its own page in this build. Open it now?', 'Open Garage', function () { window.location.href = 'index.html'; });
              } else toast('The Garage is unavailable on this page', 'warn');
            }
            return;
          }
          show(d.id);
        },
        quick: function () {
          // Quick race: the race setup's last settings, straight to the grid (CB.app.drive autoStart)
          if (CB.app && typeof CB.app.drive === 'function') { sfx('select'); CB.app.drive('race', { quick: true }); return; }
          show('quickrace');
        },
        showroom: function () { show('showroom'); }, 'register-entry': registerEntry
      });
    }
  });

  /* ======================================================================
     Pure-ish helpers: drivers, career wrappers, garage operations
     ====================================================================== */
  /** Display info for an AI driver id (career roster > race AI > id). */
  function driverInfo(id) {
    if (id == null) return null;
    var C = career();
    var d = C ? call(C, ['getDriver', 'driver'], [id], null) : null;
    if (d && d.name) return d;
    var A = CB.race && CB.race.ai;
    if (A && Array.isArray(A.DRIVERS)) {
      for (var i = 0; i < A.DRIVERS.length; i++) {
        var x = A.DRIVERS[i];
        if (x && (x.id === id || ('drv-' + String(x.first + '-' + x.last).toLowerCase().replace(/[^a-z0-9]+/g, '-')) === id)) return x;
      }
    }
    var s = String(id).replace(/^drv-|^rival-/, '');
    return { id: id, name: titleCase(s), team: '' };
  }
  function champRaw(id) {
    var C = career();
    var c = C ? call(C, ['getChampionship'], [id], null) : null;
    if (c) return c;
    var cat = catalogOf(C);
    return cat ? champMap(cat)[id] || null : null;
  }
  function champVMById(id) {
    var model = careerModel(career(), P());
    var found = null;
    model.tiers.forEach(function (t) { t.championships.forEach(function (c) { if (c.id === id) { found = c; found.tier = t; } }); });
    if (!found) model.events.forEach(function (e) { if (e.id === id) found = e; });
    if (found && !found.locked) {
      var C = career();
      if (C && typeof C.isUnlocked === 'function') {
        var u = safe(function () { return C.isUnlocked(P(), id); }, null);
        if (u && u.ok === false) { found.locked = true; found.lockReason = arr(u.reasons).join(' · '); }
      }
    }
    return found;
  }
  /** Standings rows for a championship (career.standings > raw state). */
  function standingsFor(champId) {
    var C = career();
    var rows = C ? call(C, ['standings'], [P(), champId], null) : null;
    if (!rows || !arr(rows).length) {
      var vm = champVMById(champId);
      rows = vm ? vm.standings : [];
      if ((!rows || !rows.length) && vm) {
        var raw = getPath(P(), 'career.championships.' + champId + '.standings');
        rows = raw ? normalizeStandings(raw) : [];
      }
      return rows;
    }
    return normalizeStandings(rows);
  }
  /** Calendar rounds: career.calendar > catalog rounds annotated with state. */
  function calendarFor(champId) {
    var C = career(), vm = champVMById(champId);
    var cal = C ? arr(call(C, ['calendar'], [P(), champId], null)) : [];
    var rounds = vm ? vm.rounds : [];
    var cs = getPath(P(), 'career.championships.' + champId) || {};
    var results = arr(cs.results);
    var done = vm ? vm.roundsDone : 0;
    return rounds.map(function (r, i) {
      var c = cal[i] || {};
      var res = results[i] || c.result || null;
      var pos = res ? first(res.playerPosition, res.position, getPath(res, 'player.position'), res.playerPos, null) : null;
      if (pos == null && res && Array.isArray(res.order)) {
        res.order.forEach(function (o, k) { if (o && (o.id === 'player' || o.isPlayer)) pos = first(o.position, k + 1); });
      }
      var status = c.status || (i < done ? 'done' : i === done && vm && (vm.entered || vm.started) ? 'next' : 'upcoming');
      if (status === 'complete' || status === 'completed') status = 'done';
      return Object.assign({}, r, c, {
        index: i, name: c.name || r.name || ('Round ' + (i + 1)), trackId: c.trackId || r.trackId, laps: c.laps || r.laps,
        weather: first(c.weather, (cs.weather || [])[i], r.weather, 'dry'), timeOfDay: first(c.timeOfDay, r.timeOfDay, 'day'),
        status: status, position: pos, points: res ? first(res.playerPoints, res.points, null) : null, dateLabel: dateText(c.dateLabel) || dateText(c.date) || null
      });
    });
  }
  /** career dates may be strings or {day, month, label, season} objects */
  function dateText(d) {
    if (d == null || d === '') return null;
    if (typeof d === 'string' || typeof d === 'number') return String(d);
    if (isObj(d)) return d.label || ((d.day != null && d.month) ? d.day + ' ' + d.month : null);
    return null;
  }
  function eventTypeLabel(t) {
    var cat = catalogOf(career());
    var et = cat && cat.eventTypes && cat.eventTypes[t];
    return (et && et.name) || titleCase(t || 'race');
  }
  /** Wrap a career mutation so it commits once through the profile module. */
  function careerMutate(fnName, args) {
    var C = career();
    if (!C || typeof C[fnName] !== 'function') return { ok: false, reason: 'Career module unavailable' };
    var out = null;
    try {
      updateProfile(function (p) { out = C[fnName].apply(C, [p].concat(args || [])); }, { reason: 'career-' + fnName });
    } catch (e) {
      if (typeof console !== 'undefined') console.error('[hub] career.' + fnName, e);
      return { ok: false, reason: e && e.message };
    }
    return out || { ok: true };
  }

  /* garage operations — every one returns {ok, reason?} */
  function achEvent(ev) {
    var A = achv();
    if (A && typeof A.check === 'function') safe(function () { A.check(null, ev); });
  }
  function spendCredits(n, reason, category) {
    var pm = prof();
    if (pm && typeof pm.spend === 'function') return !!pm.spend(n, reason, category);
    var fp = fallbackProfile();
    if (fp.credits < n) return false;
    fp.credits -= n; fp.ledger.push({ t: Date.now(), amount: -n, reason: reason, balance: fp.credits, category: category });
    emitLocal();
    return true;
  }
  function addCredits(n, reason, category) {
    var pm = prof();
    if (pm && typeof pm.addCredits === 'function') return pm.addCredits(n, reason, category);
    var fp = fallbackProfile();
    fp.credits += n; fp.ledger.push({ t: Date.now(), amount: n, reason: reason, balance: fp.credits, category: category });
    emitLocal();
  }
  function priceOf(build) {
    var E = eco();
    if (E && typeof E.carCost === 'function') { var c = safe(function () { return E.carCost(build); }, null); if (isNum(c)) return c; }
    var m = metricsFor(build) || {};
    return Math.max(5000, Math.round((num(m.power_hp, 200) * 120 + 15000) / 100) * 100);
  }
  function lockViolations(build) {
    var E = eco();
    if (!E || typeof E.buildLockViolations !== 'function') return [];
    return arr(safe(function () { return E.buildLockViolations(P(), build); }, []));
  }
  /** Career-legal version of a build (every locked part swapped for the closest unlocked one). */
  function legalBuild(build) {
    var E = eco();
    if (!E || typeof E.clampBuildToUnlocks !== 'function') return { build: build, changes: [] };
    var r = safe(function () { return E.clampBuildToUnlocks(P(), build); }, null);
    if (!r) return { build: build, changes: [] };
    if (r.build) return { build: normalizeBuild(r.build), changes: arr(r.changes) };
    return { build: normalizeBuild(r), changes: [] };
  }
  function buyCar(build, opts) {
    opts = opts || {};
    build = normalizeBuild(clone(build));
    var price = isNum(opts.price) ? opts.price : priceOf(build);
    var name = opts.name || buildName(build, 'New car');
    var locks = lockViolations(build);
    if (locks.length && !opts.ignoreLocks) return { ok: false, reason: 'Uses locked parts: ' + locks.slice(0, 3).map(function (l) { return l.name + ' (L' + l.level + ')'; }).join(', ') };
    if (num(P().credits, 0) < price) return { ok: false, reason: 'Not enough credits — need ' + fmtCredits(price - num(P().credits, 0)) + ' more' };
    var pm = prof();
    var car = null;
    if (pm && typeof pm.addCar === 'function') {
      var ok = false;
      updateProfile(function () {
        ok = spendCredits(price, 'Purchase · ' + name, 'car');
        if (ok) car = pm.addCar(build, { name: name, purchasedFor: price, setActive: true });
      }, { reason: 'car-purchase' });
      if (!ok) return { ok: false, reason: 'Purchase declined' };
      if (!car) return { ok: false, reason: 'My Cars is full' };
    } else {
      if (!spendCredits(price, 'Purchase · ' + name, 'car')) return { ok: false, reason: 'Not enough credits' };
      var fp = fallbackProfile();
      car = { id: 'car-' + Date.now().toString(36), name: name, build: build, purchasedFor: price, odometer_km: 0, races: 0, wins: 0, condition: 1 };
      fp.ownedCars.push(car); fp.activeCarId = car.id; emitLocal();
    }
    achEvent({ type: 'garage', action: 'buy', car: car, price: price });
    achEvent({ type: 'build-changed', build: build });
    return { ok: true, car: car, price: price };
  }
  function setActive(id) {
    var pm = prof();
    if (pm && typeof pm.setActiveCar === 'function') return pm.setActiveCar(id);
    fallbackProfile().activeCarId = id; emitLocal(); return true;
  }
  function patchCar(id, patch) {
    var pm = prof();
    if (pm && typeof pm.updateCar === 'function') return pm.updateCar(id, patch);
    var c = fallbackProfile().ownedCars.filter(function (x) { return x.id === id; })[0];
    if (c) Object.assign(c, typeof patch === 'function' ? patch(c) || {} : patch);
    emitLocal();
    return c;
  }
  function carById(id) { return (P().ownedCars || []).filter(function (c) { return c.id === id; })[0] || null; }
  function repairQuote(car) {
    var E = eco();
    var q = E && typeof E.repairQuote === 'function' ? safe(function () { return E.repairQuote(car, 1); }, null) : null;
    if (!q) { var c = Math.round((1 - num(car.condition, 1)) * num(car.purchasedFor, 20000) * 0.18 / 10) * 10; q = { credits: c, lines: [{ label: 'Workshop repair', credits: c }] }; }
    return q;
  }
  function repairCar(id) {
    var car = carById(id); if (!car) return { ok: false, reason: 'Unknown car' };
    var q = repairQuote(car);
    if (q.credits <= 0) return { ok: true, credits: 0 };
    var ok = false;
    updateProfile(function () {
      ok = spendCredits(q.credits, 'Repair · ' + car.name, 'repair');
      if (ok) patchCar(id, { condition: 1, damage: null });
    }, { reason: 'car-repair' });
    if (!ok) return { ok: false, reason: 'Not enough credits' };
    achEvent({ type: 'garage', action: 'repair', car: car, cost: q.credits });
    return { ok: true, credits: q.credits };
  }
  function sellQuote(car) {
    var E = eco();
    var q = E && typeof E.sellQuote === 'function' ? safe(function () { return E.sellQuote(car); }, null) : null;
    if (!q) { var v = Math.round(num(car.purchasedFor, 20000) * 0.6 * num(car.condition, 1) / 100) * 100; q = { credits: v, lines: [{ label: 'Dealer offer', credits: v }] }; }
    return q;
  }
  function sellCar(id) {
    var car = carById(id); if (!car) return { ok: false, reason: 'Unknown car' };
    var CC = CB.game && CB.game.career;
    var gate = CC && typeof CC.canSellCar === 'function' ? safe(function () { return CC.canSellCar(P(), id); }, null) : null;
    if (gate && gate.ok === false) return { ok: false, reason: gate.reason, blocked: true };
    var q = sellQuote(car), pm = prof();
    updateProfile(function () {
      if (pm && typeof pm.removeCar === 'function') pm.removeCar(id, { sold: true });
      else {
        var fp = fallbackProfile();
        fp.ownedCars = fp.ownedCars.filter(function (c) { return c.id !== id; });
        if (fp.activeCarId === id) fp.activeCarId = fp.ownedCars[0] ? fp.ownedCars[0].id : null;
      }
      addCredits(q.credits, 'Sold · ' + car.name, 'car-sale');
    }, { reason: 'car-sale' });
    achEvent({ type: 'garage', action: 'sell', car: car, value: q.credits });
    return { ok: true, credits: q.credits };
  }
  function upgradeQuote(oldB, newB, car) {
    var E = eco();
    var q = E && typeof E.upgradeQuote === 'function' ? safe(function () { return E.upgradeQuote(oldB, newB, car ? { car: car } : undefined); }, null) : null;
    if (!q) { var d = priceOf(newB) - priceOf(oldB); q = { total: d >= 0 ? d : Math.round(d * 0.5), lines: [{ label: 'Spec change', net: d }], changes: d ? 1 : 0 }; }
    return q;
  }
  function applyUpgrade(id, newBuild) {
    var car = carById(id); if (!car) return { ok: false, reason: 'Unknown car' };
    newBuild = normalizeBuild(clone(newBuild));
    var locks = lockViolations(newBuild);
    if (locks.length) return { ok: false, reason: 'Uses locked parts: ' + locks.slice(0, 3).map(function (l) { return l.name + ' (L' + l.level + ')'; }).join(', ') };
    var q = upgradeQuote(car.build, newBuild, car);
    var total = Math.round(num(q.total, 0));
    if (total > 0 && num(P().credits, 0) < total) return { ok: false, reason: 'Not enough credits — need ' + fmtCredits(total) };
    var ok = true;
    updateProfile(function () {
      if (total > 0) ok = spendCredits(total, 'Upgrade · ' + car.name, 'upgrade');
      else if (total < 0) addCredits(-total, 'Parts refund · ' + car.name, 'upgrade');
      if (ok) patchCar(id, { build: newBuild, purchasedFor: Math.max(0, num(car.purchasedFor, 0) + Math.max(0, total)) });
    }, { reason: 'car-upgrade' });
    if (!ok) return { ok: false, reason: 'Not enough credits' };
    achEvent({ type: 'garage', action: 'upgrade', car: car, cost: total });
    achEvent({ type: 'build-changed', build: newBuild });
    return { ok: true, credits: total, quote: q };
  }

  /* ---------------------------------------------- challenge records */
  var CH_KEY = 'forge.hub.challenges.v1';
  function chRecords() { var r = lsGet(CH_KEY); return isObj(r) ? r : {}; }
  function chSaveRecord(id, rec) {
    var all = chRecords(), prev = all[id] || {};
    var rank = { none: 0, bronze: 1, silver: 2, gold: 3, platinum: 4 };
    var better = !prev.score || (rec.lowerIsBetter ? rec.score < prev.score : rec.score > prev.score);
    all[id] = {
      score: better ? rec.score : prev.score, medal: (rank[rec.medal] || 0) > (rank[prev.medal] || 0) ? rec.medal : (prev.medal || rec.medal || null),
      attempts: num(prev.attempts, 0) + 1, last: rec.score, t: Date.now()
    };
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(CH_KEY, JSON.stringify(all)); } catch (e) { /* ignore */ }
    return all[id];
  }
  function challengeList() {
    var M = chal();
    var l = M && (Array.isArray(M.list) ? M.list : Array.isArray(M.catalog) ? M.catalog : typeof M.list === 'function' ? safe(function () { return M.list(); }, null) : null);
    return arr(l);
  }
  function challengeBest(id) {
    var M = chal(), b = null;
    if (M) b = call(M, ['best', 'getBest', 'record', 'getRecord'], [P(), id], null) || call(M, ['best', 'getBest'], [id], null);
    if (!b) b = getPath(P(), 'challenges.' + id) || chRecords()[id] || null;
    return b;
  }
  var CHALLENGE_PLACEHOLDERS = [
    { id: 'launch-control', name: 'Launch Control', desc: 'Nail the launch: 0–200 km/h as fast as possible.', icon: 'timer' },
    { id: 'braking-zone', name: 'Braking Zone', desc: 'Stop inside the box from top speed. Precision over bravery.', icon: 'flag' },
    { id: 'slalom', name: 'Slalom', desc: 'Weave the cones without a touch. Penalties for every cone.', icon: 'cone' },
    { id: 'drift-trial', name: 'Drift Trial', desc: 'Angle × speed × duration, with a combo multiplier.', icon: 'race' },
    { id: 'top-speed', name: 'Top Speed Run', desc: 'The long straight. How fast is fast?', icon: 'race' },
    { id: 'hot-lap', name: 'Hot Lap', desc: 'Beat the target lap times for bronze, silver and gold.', icon: 'timer' },
    { id: 'elk-test', name: 'Elk Test', desc: 'Lane change at speed — stay composed through the gates.', icon: 'cone' }
  ];

  /* ======================================================================
     Mini canvas charts (profile dashboard)
     Single-hue marks, recessive grid, crosshair / per-mark tooltip.
     ====================================================================== */
  var VIZ = { blue: '#3987e5', blueSoft: 'rgba(57,135,229,.18)', grid: 'rgba(255,255,255,.07)', axis: 'rgba(255,255,255,.22)', ink: '#f2eee6', dim: '#9b978d', mute: '#6c6961', surface: '#14151a', good: '#0ca30c', bad: '#d03b3b' };
  /**
   * miniChart(host, spec) -> {destroy, redraw}
   * spec: {type:'line'|'area'|'bars'|'hbars', points:[{x, y, label, tip}], yMin, yMax, invertY, yTicks, xLabel(fn), yFmt(fn), height, markers}
   */
  function miniChart(host, spec) {
    var canvas = document.createElement('canvas');
    var tip = div('gh-chart-tip');
    host.appendChild(canvas); host.appendChild(tip);
    var ctx = canvas.getContext('2d');
    var W = 0, Hh = 0, hover = -1, geo = [], dead = false;
    var pad = { l: spec.type === 'hbars' ? Math.min(150, num(spec.labelWidth, 110)) : 44, r: 16, t: 14, b: spec.type === 'hbars' ? 8 : 26 };
    var pts = arr(spec.points);
    function measure() {
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      W = host.clientWidth || 400; Hh = host.clientHeight || num(spec.height, 220);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(Hh * dpr);
      canvas.style.width = W + 'px'; canvas.style.height = Hh + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function niceStep(range, n) {
      var raw = range / Math.max(1, n), mag = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, raw)))), f = raw / mag;
      return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
    }
    function rr(x, y, w, h, r) {
      r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
    }
    function draw() {
      if (dead) return;
      ctx.clearRect(0, 0, W, Hh);
      geo = [];
      ctx.font = '11px ' + 'Inter, system-ui, sans-serif';
      var yfmt = spec.yFmt || function (v) { return fmtCompact(v); };
      if (!pts.length) {
        ctx.fillStyle = VIZ.dim; ctx.textAlign = 'center'; ctx.fillText(spec.empty || 'No data yet', W / 2, Hh / 2);
        return;
      }
      if (spec.type === 'hbars') {
        var maxV = Math.max(1e-9, Math.max.apply(null, pts.map(function (p) { return num(p.y, 0); })));
        var rowH = Math.min(30, (Hh - pad.t - pad.b) / pts.length), bh = Math.max(6, rowH - 10);
        pts.forEach(function (p, i) {
          var y = pad.t + i * rowH + (rowH - bh) / 2, w = (W - pad.l - pad.r - 54) * num(p.y, 0) / maxV;
          ctx.fillStyle = VIZ.dim; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
          ctx.fillText(String(p.label).slice(0, 22), pad.l - 10, y + bh / 2);
          ctx.fillStyle = hover === i ? '#6da7ec' : (p.color || VIZ.blue);
          if (w > 0.5) { rr(pad.l, y, Math.max(2, w), bh, 4); ctx.fill(); }
          ctx.fillStyle = VIZ.ink; ctx.textAlign = 'left';
          ctx.fillText(p.valueLabel != null ? p.valueLabel : yfmt(p.y), pad.l + Math.max(2, w) + 8, y + bh / 2);
          geo.push({ x: 0, y: pad.t + i * rowH, w: W, h: rowH, cx: pad.l + w, cy: y });
        });
        return;
      }
      var ys = pts.map(function (p) { return p.y; }).filter(isNum);
      var y0 = isNum(spec.yMin) ? spec.yMin : Math.min(0, Math.min.apply(null, ys));
      var y1 = isNum(spec.yMax) ? spec.yMax : Math.max.apply(null, ys);
      if (y1 === y0) y1 = y0 + 1;
      if (!isNum(spec.yMax) && spec.type !== 'bars') y1 += (y1 - y0) * 0.08;
      var step = spec.yStep || niceStep(y1 - y0, spec.yTicks || 4);
      if (spec.integer) step = Math.max(1, Math.round(step));
      if (!isNum(spec.yMax)) y1 = Math.ceil(y1 / step) * step;
      if (!isNum(spec.yMin)) y0 = Math.floor(y0 / step) * step;
      var pw = W - pad.l - pad.r, ph = Hh - pad.t - pad.b;
      var yPix = function (v) { var t = (v - y0) / (y1 - y0); return spec.invertY ? pad.t + t * ph : pad.t + ph - t * ph; };
      // grid + y labels
      ctx.strokeStyle = VIZ.grid; ctx.lineWidth = 1; ctx.fillStyle = VIZ.mute; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (var v = y0; v <= y1 + 1e-9; v += step) {
        var gy = Math.round(yPix(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(W - pad.r, gy); ctx.stroke();
        ctx.fillText(yfmt(v), pad.l - 8, gy);
      }
      var n = pts.length;
      if (spec.type === 'bars') {
        var slot = pw / n, bw = Math.max(4, Math.min(48, slot - 2 - slot * 0.25));
        pts.forEach(function (p, i) {
          var x = pad.l + i * slot + (slot - bw) / 2, yv = num(p.y, 0), top = yPix(Math.max(yv, y0)), base = yPix(Math.max(0, y0));
          ctx.fillStyle = hover === i ? '#6da7ec' : (p.color || VIZ.blue);
          if (Math.abs(base - top) > 0.5) {
            ctx.beginPath();
            var r = Math.min(4, bw / 2, base - top);
            ctx.moveTo(x, base); ctx.lineTo(x, top + r); ctx.quadraticCurveTo(x, top, x + r, top); ctx.lineTo(x + bw - r, top);
            ctx.quadraticCurveTo(x + bw, top, x + bw, top + r); ctx.lineTo(x + bw, base); ctx.closePath(); ctx.fill();
          }
          ctx.fillStyle = VIZ.dim; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillText(String(p.label != null ? p.label : i + 1).slice(0, 12), x + bw / 2, Hh - pad.b + 8);
          if (spec.valueLabels) { ctx.fillStyle = VIZ.ink; ctx.textBaseline = 'bottom'; ctx.fillText(p.valueLabel != null ? p.valueLabel : yfmt(yv), x + bw / 2, top - 4); }
          geo.push({ x: pad.l + i * slot, y: pad.t, w: slot, h: ph, cx: x + bw / 2, cy: top });
        });
      } else {
        var xPix = function (i) { return n === 1 ? pad.l + pw / 2 : pad.l + (i / (n - 1)) * pw; };
        // x labels (sparse)
        ctx.fillStyle = VIZ.mute; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        var every = Math.max(1, Math.ceil(n / 8));
        pts.forEach(function (p, i) { if (i % every === 0 || i === n - 1) ctx.fillText(spec.xLabel ? spec.xLabel(p, i) : String(i + 1), xPix(i), Hh - pad.b + 8); });
        // area
        var segs = [], cur = [];
        pts.forEach(function (p, i) { if (isNum(p.y)) cur.push([xPix(i), yPix(p.y)]); else if (cur.length) { segs.push(cur); cur = []; } });
        if (cur.length) segs.push(cur);
        if (spec.type === 'area') {
          segs.forEach(function (s) {
            var g = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
            g.addColorStop(0, 'rgba(57,135,229,.28)'); g.addColorStop(1, 'rgba(57,135,229,0)');
            ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(s[0][0], yPix(Math.max(y0, 0)));
            s.forEach(function (q) { ctx.lineTo(q[0], q[1]); }); ctx.lineTo(s[s.length - 1][0], yPix(Math.max(y0, 0))); ctx.closePath(); ctx.fill();
          });
        }
        ctx.strokeStyle = VIZ.blue; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        segs.forEach(function (s) { ctx.beginPath(); s.forEach(function (q, k) { if (k) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.stroke(); });
        // markers
        pts.forEach(function (p, i) {
          var x = xPix(i);
          if (isNum(p.y)) {
            var y = yPix(p.y);
            if (spec.markers !== false && n <= 40) {
              ctx.beginPath(); ctx.arc(x, y, hover === i ? 5.5 : 4, 0, Math.PI * 2);
              ctx.fillStyle = p.highlight ? '#f3d9a0' : VIZ.blue; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = VIZ.surface; ctx.stroke();
            }
            geo.push({ x: x - pw / Math.max(1, n - 1) / 2, y: pad.t, w: pw / Math.max(1, n - 1), h: ph, cx: x, cy: y });
          } else {
            // missing value (DNF): small muted cross on the baseline
            var by = spec.invertY ? pad.t + ph - 4 : pad.t + ph - 4;
            ctx.strokeStyle = VIZ.mute; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(x - 4, by - 4); ctx.lineTo(x + 4, by + 4); ctx.moveTo(x + 4, by - 4); ctx.lineTo(x - 4, by + 4); ctx.stroke();
            geo.push({ x: x - pw / Math.max(1, n - 1) / 2, y: pad.t, w: pw / Math.max(1, n - 1), h: ph, cx: x, cy: by });
          }
        });
        if (hover >= 0 && geo[hover]) {
          ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(Math.round(geo[hover].cx) + 0.5, pad.t); ctx.lineTo(Math.round(geo[hover].cx) + 0.5, pad.t + ph); ctx.stroke(); ctx.setLineDash([]);
        }
      }
      // last-value direct label
      if (spec.lastLabel && pts.length && (spec.type === 'line' || spec.type === 'area')) {
        var lp = geo[geo.length - 1];
        if (lp) { ctx.fillStyle = VIZ.ink; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.font = '600 11px Inter, system-ui, sans-serif'; ctx.fillText(spec.lastLabel, Math.min(W - pad.r, lp.cx), lp.cy - 8); }
      }
    }
    function onMove(e) {
      var r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, idx = -1;
      for (var i = 0; i < geo.length; i++) { var g = geo[i]; if (mx >= g.x && mx <= g.x + g.w && my >= g.y - 10 && my <= g.y + g.h + 10) { idx = i; break; } }
      if (idx !== hover) { hover = idx; draw(); }
      if (idx >= 0 && pts[idx]) {
        var p = pts[idx];
        tip.innerHTML = p.tip || ('<b>' + esc(spec.yFmt ? spec.yFmt(p.y) : fmtInt(p.y)) + '</b> ' + esc(p.label || ''));
        tip.style.left = clamp(geo[idx].cx, 70, W - 70) + 'px'; tip.style.top = Math.max(18, geo[idx].cy) + 'px'; tip.style.opacity = '1';
      } else tip.style.opacity = '0';
    }
    function onLeave() { hover = -1; tip.style.opacity = '0'; draw(); }
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('pointerdown', onMove);   // touch: a tap shows the point's tooltip (no hover on phones)
    var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(function () { measure(); draw(); }) : null;
    if (ro) ro.observe(host);
    measure(); draw();
    var handle = {
      redraw: function (s) { if (s) { spec = Object.assign(spec, s); pts = arr(spec.points); } measure(); draw(); },
      destroy: function () { dead = true; if (ro) ro.disconnect(); canvas.removeEventListener('mousemove', onMove); canvas.removeEventListener('mouseleave', onLeave); canvas.removeEventListener('pointerdown', onMove); }
    };
    if (H) H.charts.push(handle);
    return handle;
  }

  /* ---------------------------------------------------- celebrations */
  function confetti(canvas, ms) {
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    var W = canvas.width = canvas.clientWidth || window.innerWidth, Hh = canvas.height = canvas.clientHeight || window.innerHeight;
    var r = rng(Date.now() >>> 0), parts = [];
    var cols = ['#f3d9a0', '#d4b06a', '#ffffff', '#e8322b', '#3987e5'];
    for (var i = 0; i < 160; i++) parts.push({ x: W / 2 + (r() - 0.5) * 120, y: Hh * 0.45, vx: (r() - 0.5) * 18, vy: -6 - r() * 14, s: 4 + r() * 6, a: r() * 6, va: (r() - 0.5) * 0.4, c: cols[i % cols.length] });
    var t0 = 0;
    function f(ts) {
      if (!t0) t0 = ts;
      if (ts - t0 > (ms || 2600) || !canvas.isConnected) return;
      ctx.clearRect(0, 0, W, Hh);
      parts.forEach(function (p) {
        p.vy += 0.42; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.globalAlpha = clamp(1 - (ts - t0) / (ms || 2600), 0, 1);
        ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
      });
      requestAnimationFrame(f);
    }
    requestAnimationFrame(f);
  }
  function levelUpFanfare(level, unlocks) {
    if (!H) return;
    sfx('level');
    var ov = div('gh-levelup', '<canvas></canvas><div class="box"><div class="t">Level up</div><div class="lv">' + level + '</div><div class="t">' + esc(levelTitle(level)) + '</div>' +
      (arr(unlocks).length ? '<div style="margin-top:18px;font-size:12px;letter-spacing:.14em;color:var(--gh-dim);text-transform:uppercase">Unlocked · ' + esc(arr(unlocks).slice(0, 4).map(function (u) { return u.name || titleCase(u.id); }).join(' · ')) + (arr(unlocks).length > 4 ? ' +' + (arr(unlocks).length - 4) : '') + '</div>' : '') + '</div>');
    H.root.appendChild(ov);
    confetti(ov.querySelector('canvas'), 2800);
    later(function () { ov.classList.add('out'); }, 2600);
    later(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 3200);
  }
  /** Animate numbers inside el from `from` to `to` over ms, formatting with fmt. */
  function countUp(el, from, to, ms, fmt, onTick) {
    if (!el) return;
    fmt = fmt || fmtInt;
    var reduced = H && H.root.classList.contains('reduced');
    if (reduced || !hasDOM || typeof requestAnimationFrame === 'undefined' || (typeof document !== 'undefined' && document.hidden)) { el.textContent = fmt(to); return; }
    var t0 = 0, lastTick = 0, done = false;
    // rAF is paused in background tabs: make sure the final value always lands
    setTimeout(function () { if (!done && el.isConnected) { done = true; el.textContent = fmt(to); } }, ms + 400);
    function f(ts) {
      if (done || !el.isConnected) return;
      if (ts - t0 >= ms && t0) done = true;
      if (!t0) t0 = ts;
      var t = clamp((ts - t0) / ms, 0, 1);
      el.textContent = fmt(countUpValue(from, to, t));
      if (onTick && ts - lastTick > 70 && t < 1) { lastTick = ts; onTick(t); }
      if (t < 1) requestAnimationFrame(f);
    }
    requestAnimationFrame(f);
  }
  function posClass(p) { return p === 1 ? 'p1' : p === 2 ? 'p2' : p === 3 ? 'p3' : ''; }
  function standingsTable(rows, opts) {
    opts = opts || {};
    rows = arr(rows);
    if (!rows.length) return '<div class="gh-empty"><b>No standings yet</b>The table fills in after the first round.</div>';
    var lim = opts.limit ? rows.slice(0, opts.limit) : rows;
    var me = rows.filter(function (r) { return r.isPlayer; })[0];
    if (opts.limit && me && lim.indexOf(me) < 0) lim = lim.concat([me]);
    var maxRounds = 0;
    rows.forEach(function (r) { maxRounds = Math.max(maxRounds, arr(r.results).length); });
    var showRounds = opts.rounds && maxRounds > 0;
    return '<table class="gh-table"><thead><tr><th>Pos</th><th>Driver</th><th>Team</th>' +
      (showRounds ? Array.apply(null, Array(maxRounds)).map(function (_, i) { return '<th class="n">R' + (i + 1) + '</th>'; }).join('') : '') +
      '<th class="n">Wins</th><th class="n">Pts</th><th class="n">Gap</th></tr></thead><tbody>' +
      lim.map(function (r) {
        return '<tr class="' + (r.isPlayer ? 'is-player' : '') + '"><td><span class="gh-pos ' + (r.unranked ? '' : posClass(r.position)) + '">' + (r.unranked ? '—' : r.position) + '</span></td>' +
          '<td><span class="gh-swatch" style="background:' + esc(r.color || '#555') + '"></span>' + esc(r.name) + (r.number != null && r.number !== '' ? ' <small style="color:var(--gh-mute)">#' + esc(r.number) + '</small>' : '') + '</td>' +
          '<td style="color:var(--gh-dim)">' + esc(r.team || '') + '</td>' +
          (showRounds ? Array.apply(null, Array(maxRounds)).map(function (_, i) { var f = arr(r.results)[i]; var v = isObj(f) ? first(f.position, f.pos) : f; return '<td class="n" style="color:' + (v === 1 ? 'var(--gh-accent2)' : 'var(--gh-dim)') + '">' + (v == null ? '—' : v === 0 || v === 'dnf' ? 'DNF' : esc(v)) + '</td>'; }).join('') : '') +
          '<td class="n">' + r.wins + '</td><td class="n"><b>' + fmtInt(r.points) + '</b></td><td class="n" style="color:var(--gh-dim)">' + (r.position === 1 || !(r.gap > 0) ? '—' : '−' + fmtInt(r.gap)) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function weatherIcon(w) { return w === 'wet' || w === 'damp' ? icon('rain', 16) : icon('sun', 16); }
  function timeIcon(t) { return t === 'night' ? icon('moon', 16) : icon('sun', 16); }

  /** Pop the stack back to the nearest screen `id` (or push it). */
  function goBackTo(id, params) {
    if (!H) return;
    for (var i = H.stack.length - 1; i >= 0; i--) {
      if (H.stack[i].id === id) {
        leaveScreen();
        H.stack.length = i + 1;
        if (params) H.stack[i].params = Object.assign({}, H.stack[i].params, params);
        H.root.classList.add('is-back');
        renderScreen(false, H.stack[i].scroll);
        return;
      }
    }
    show(id, params);
  }
  function carEligibilityHTML(elig) {
    if (!elig) return '';
    return elig.ok ? '<div class="gh-ok">' + icon('check', 14) + ' Your car is eligible</div>'
      : '<ul class="gh-reasons">' + elig.reasons.map(function (r) { return '<li>✕ ' + esc(r) + '</li>'; }).join('') + '</ul>';
  }
  function modifyCarForChamp(champ) {
    var car = activeCar();
    if (!car) { show('showroom', { champId: champ && champ.id }); return; }
    var req = champ ? requirementChips(champ.requirements).join(' · ') : '';
    var opened = openAtelier('career-upgrade', {
      carId: car.id, build: car.build, message: req ? 'Target: ' + req : undefined,
      priceLabel: 'Upgrade priced in credits',
      onConfirm: function (b) { confirmUpgrade(car.id, b); }
    });
    if (!opened) show('workshop', { carId: car.id, champId: champ && champ.id });
  }
  function confirmUpgrade(carId, newBuild) {
    var car = carById(carId); if (!car) return;
    var q = upgradeQuote(car.build, newBuild, car), total = Math.round(num(q.total, 0));
    var locks = lockViolations(newBuild);
    var lines = arr(q.lines).slice(0, 12).map(function (l) {
      var v = isNum(l.net) ? l.net : num(l.cost, 0) - num(l.refund, 0);
      return '<li><span>' + esc(l.label) + '</span><span class="c">' + (v < 0 ? '+' + fmtCredits(-v) : fmtCredits(v)) + '</span></li>';
    }).join('');
    modal({
      kicker: 'Workshop invoice', title: total >= 0 ? 'Confirm upgrade' : 'Confirm downgrade',
      body: '<p>' + esc(car.name) + ' — ' + (q.changes || 0) + ' change' + (q.changes === 1 ? '' : 's') + '.</p>' +
        '<ul class="gh-breakdown">' + lines.replace(/<li>/g, '<li class="in">') + '</ul>' +
        '<div style="display:flex;justify-content:space-between;margin-top:14px;font-weight:800"><span>' + (total >= 0 ? 'Total due' : 'Net refund') + '</span><span class="gh-num" style="color:var(--gh-accent2)">' + fmtCredits(Math.abs(total)) + '</span></div>' +
        (locks.length ? '<ul class="gh-reasons">' + locks.slice(0, 5).map(function (l) { return '<li>' + icon('lock', 12) + ' ' + esc(l.name) + ' unlocks at level ' + l.level + '</li>'; }).join('') + '</ul>' : '') +
        (total > num(P().credits, 0) ? '<ul class="gh-reasons"><li>Not enough credits (balance ' + esc(fmtCredits(P().credits)) + ')</li></ul>' : ''),
      actions: [{ label: 'Discard', kind: 'ghost', value: false }, { label: total >= 0 ? 'Pay & fit' : 'Fit & refund', kind: 'primary', value: true, disabled: !!locks.length || total > num(P().credits, 0) }],
      onClose: function (v) {
        if (!v) return;
        var r = applyUpgrade(carId, newBuild);
        if (r.ok) { sfx('coin'); toast('Upgrade fitted · ' + (r.credits >= 0 ? '−' + fmtCredits(r.credits) : '+' + fmtCredits(-r.credits)), 'good'); refresh(); }
        else { sfx('error'); toast(esc(r.reason), 'bad'); }
      }
    });
  }

  /* ======================================================================
     Screen: career (tier map, championships, events, trophies)
     ====================================================================== */
  function champCardHTML(c, build) {
    var C = career();
    var elig = build && !c.locked ? eligibility(C, build, c.raw) : null;
    var firstTrack = c.rounds[0] && c.rounds[0].trackId;
    var status = c.locked ? '<span class="gh-chip">' + icon('lock', 12) + ' Locked</span>'
      : c.complete ? '<span class="gh-chip gold">Complete' + (c.result ? ' · ' + ordinal(c.result) : '') + '</span>'
      : c.entered || c.started ? '<span class="gh-chip good">Round ' + (c.roundsDone + 1) + ' / ' + c.rounds.length + '</span>'
      : elig && elig.ok ? '<span class="gh-chip good">Eligible</span>' : elig ? '<span class="gh-chip bad">Not eligible</span>' : '';
    var purse = isObj(c.prize) ? first(c.prize.purse, c.prize.credits) : c.prize;
    return '<button class="gh-card gh-champ' + (c.locked ? ' is-locked' : '') + '" style="--c:' + esc(c.color || '#d4b06a') + '" data-nav data-key="ch-' + esc(c.id) + '" data-act="champ" data-id="' + esc(c.id) + '">' +
      '<div class="gh-art">' + (firstTrack ? trackPreviewSVG(firstTrack, 150, 92, { width: 6 }) : '') +
      '<div class="rounds">' + c.rounds.length + '<small>' + (c.rounds.length === 1 ? 'ROUND' : 'ROUNDS') + '</small></div></div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">' + status + (c.type && c.type !== 'race' && c.type !== 'championship' ? '<span class="gh-chip">' + esc(eventTypeLabel(c.type)) + '</span>' : '') + '</div>' +
      '<h3>' + esc(c.name) + '</h3><p>' + esc(c.desc).slice(0, 170) + '</p>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">' + requirementChips(c.requirements).map(function (r) { return '<span class="gh-chip">' + esc(r) + '</span>'; }).join('') + '</div>' +
      (c.locked ? '<ul class="gh-reasons"><li>' + icon('lock', 12) + ' ' + esc(c.lockReason || 'Locked') + '</li></ul>' : (!c.complete && elig && !elig.ok ? carEligibilityHTML({ ok: false, reasons: elig.reasons.slice(0, 3) }) : '')) +
      '<div class="gh-card-foot"><span class="gh-chip">' + icon('coin', 12) + ' ' + (purse ? esc(fmtCredits(purse)) : '—') + '</span>' +
      (c.entryFee ? '<span class="gh-chip">Entry ' + esc(fmtCredits(c.entryFee)) + '</span>' : '<span class="gh-chip good">Free entry</span>') +
      '<span style="margin-left:auto;color:var(--gh-accent)">' + icon('chev', 16) + '</span></div></button>';
  }
  screen('career', {
    title: 'Career', live: true, tabs: true,
    render: function (host, params) {
      var C = career();
      if (!C) { host.innerHTML = '<div class="gh-kicker">Career</div><h1 class="gh-h1">Career</h1>' + moduleMissing('Career', 'Championships, rivals and trophies appear here as soon as js/game/career.js has loaded.'); return; }
      var p = P(), model = careerModel(C, p), build = activeCar() ? activeCar().build : null;
      var tab = params.tab || 'tiers';
      var tierIdx = isNum(params.tier) ? params.tier : (function () { var t = 0; model.tiers.forEach(function (x, i) { if (x.unlocked) t = i; }); return t; })();
      var tier = model.tiers[tierIdx] || model.tiers[0];
      var trophies = trophyList(C, model);
      var champsDone = 0, champsTotal = 0;
      model.tiers.forEach(function (t) { t.championships.forEach(function (c) { champsTotal++; if (c.complete) champsDone++; }); });
      var out = '<div class="gh-head"><div><div class="gh-kicker">Career mode</div><h1 class="gh-h1">The road to the <em>Masters</em></h1>' +
        '<p class="gh-sub">Five tiers, from club racing to the hypercar summit. Win trophies to unlock the next tier, keep your car eligible, and manage your credits between rounds.</p></div>' +
        '<div class="gh-btns"><span class="gh-chip gold">' + icon('cup', 12) + ' ' + trophies.length + ' trophies</span><span class="gh-chip">' + champsDone + ' / ' + champsTotal + ' championships</span>' +
        (build ? piBadge(build, 'Your car') : '<span class="gh-chip warn">No car</span>') + '</div></div>';
      out += tabsHTML([{ id: 'tiers', name: 'Championships', count: champsTotal }, { id: 'events', name: 'Special events', count: model.events.length }, { id: 'trophies', name: 'Trophy cabinet', count: trophies.length }], tab);
      if (!build) out += '<div style="margin-bottom:18px">' + needCarNotice() + '</div>';
      if (tab === 'tiers') {
        out += '<div class="gh-tiermap">' + model.tiers.map(function (t, i) {
          return '<button class="gh-tier' + (i === tierIdx ? ' is-active' : '') + (t.unlocked ? '' : ' is-locked') + '" style="--c:' + esc(t.color) + '" data-nav data-key="tier-' + i + '" data-act="tier" data-i="' + i + '">' +
            (t.unlocked ? '' : '<span class="lock">' + icon('lock', 16) + '</span>') + '<div class="n">' + (i + 1) + '</div><h3>' + esc(t.name) + '</h3>' +
            '<p style="margin:0;font-size:11.5px;color:var(--gh-dim)">' + (t.unlocked ? t.championships.filter(function (c) { return c.complete; }).length + ' / ' + t.championships.length + ' complete' : esc(t.lockReason)) + '</p>' +
            '<div class="gh-bar"><i style="width:' + (t.progress * 100).toFixed(0) + '%"></i></div>' + (i < model.tiers.length - 1 ? '<span class="gh-tier-link"></span>' : '') + '</button>';
        }).join('') + '</div>';
        if (tier) {
          var tu = call(C, ['isUnlocked'], [p, tier.id], null);
          out += '<h2 class="gh-h2" style="color:' + esc(tier.color) + '">' + esc(tier.name) + '</h2>' +
            (tier.desc ? '<p class="gh-sub" style="margin-top:-6px">' + esc(tier.desc) + '</p>' : '') +
            (!tier.unlocked && tu && arr(tu.reasons).length ? '<ul class="gh-reasons" style="margin-bottom:16px">' + arr(tu.reasons).map(function (r) { return '<li>' + icon('lock', 12) + ' ' + esc(r) + '</li>'; }).join('') + '</ul>' : '') +
            '<div class="gh-grid auto">' + tier.championships.map(function (c) { return champCardHTML(c, build); }).join('') + '</div>';
        }
      } else if (tab === 'events') {
        var evs = model.events.map(function (e) {
          var u = call(C, ['isUnlocked'], [p, e.id], null);
          if (u && u.ok === false) { e.locked = true; e.lockReason = arr(u.reasons).join(' · '); }
          return e;
        });
        out += evs.length ? '<div class="gh-grid auto">' + evs.map(function (c) { return champCardHTML(c, build); }).join('') + '</div>'
          : '<div class="gh-empty"><b>No special events</b>Rivals, time attacks and endurance specials will appear here.</div>';
      } else {
        out += trophyCabinetHTML(trophies, model);
      }
      host.innerHTML = out;
      onAct(host, {
        tab: function (d) { setParam('tab', d.tab); renderScreen(false); },
        tier: function (d) { setParam('tier', +d.i); setParam('tab', 'tiers'); renderScreen(true); },
        champ: function (d) {
          var vm = champVMById(d.id);
          if (vm && vm.locked) { sfx('error'); toast(icon('lock', 14) + ' ' + esc(vm.lockReason || 'Locked'), 'warn'); }
          show('championship', { id: d.id });
        },
        showroom: function () { show('showroom'); }, 'register-entry': registerEntry
      });
    }
  });
  function trophyList(C, model) {
    var r = call(C, ['trophies'], [P()], null);
    if (Array.isArray(r)) return r;
    if (r && Array.isArray(r.trophies)) return r.trophies;
    return arr(model && model.trophies).filter(function (t) { return isObj(t) && (t.champId || t.position); });
  }
  function trophyMedal(t) {
    var pos = num(first(t.position, t.finalPosition), 0);
    return t.medal || (pos === 1 ? 'gold' : pos === 2 ? 'silver' : pos === 3 ? 'bronze' : 'none');
  }
  function trophyCabinetHTML(trophies, model) {
    trophies = arr(trophies);
    var won = {};
    trophies.forEach(function (t) { var id = t.champId || t.id; if (!won[id] || num(t.position, 9) < num(won[id].position, 9)) won[id] = t; });
    var out = '';
    model.tiers.forEach(function (tier) {
      out += '<h2 class="gh-h2" style="color:' + esc(tier.color) + '">' + esc(tier.name) + '</h2><div class="gh-cabinet">' +
        tier.championships.map(function (c) {
          var t = won[c.id];
          var tName = (c.raw && c.raw.trophy && c.raw.trophy.name) || c.name + ' Trophy';
          return '<div class="gh-trophy' + (t ? '' : ' is-empty') + '">' + trophySVG(t ? trophyMedal(t) : 'silver', tier.color) +
            '<b>' + esc(t ? (t.name || tName) : tName) + '</b><small>' + (t ? ordinal(t.position || 1) + ' · ' + esc(c.name) + (t.season ? ' · S' + t.season : '') : 'Not yet won') + '</small></div>';
        }).join('') + '</div>';
    });
    var evWon = trophies.filter(function (t) { return t.kind === 'event'; });
    if (evWon.length) {
      out += '<h2 class="gh-h2">Special events</h2><div class="gh-cabinet">' + evWon.map(function (t) {
        return '<div class="gh-trophy">' + trophySVG(trophyMedal(t)) + '<b>' + esc(t.name || titleCase(t.champId)) + '</b><small>' + (t.t || t.at ? fmtDate(t.t || t.at) : '') + '</small></div>';
      }).join('') + '</div>';
    }
    return out;
  }

  screen('trophies', {
    title: 'Trophy cabinet', live: true,
    render: function (host) {
      var C = career();
      if (!C) { host.innerHTML = '<h1 class="gh-h1">Trophies</h1>' + moduleMissing('Career'); return; }
      var model = careerModel(C, P()), trophies = trophyList(C, model);
      host.innerHTML = '<div class="gh-kicker">Career</div><h1 class="gh-h1">Trophy <em>cabinet</em></h1><p class="gh-sub">' + trophies.length + ' trophies won. Every championship podium earns silverware.</p>' + trophyCabinetHTML(trophies, model);
    }
  });

  /* ======================================================================
     Screen: championship / event detail
     ====================================================================== */
  function renderChampionship(host, params) {
    var C = career();
    if (!C) { host.innerHTML = moduleMissing('Career'); return; }
    var vm = champVMById(params.id || params.champId);
    if (!vm) { host.innerHTML = '<div class="gh-empty"><b>Unknown championship</b>' + esc(params.id || params.champId || '') + '<div class="gh-btns" style="justify-content:center;margin-top:14px"><button class="gh-btn" data-nav data-act="back">Back</button></div></div>'; onAct(host, { back: back }); return; }
    var car = activeCar(), build = car ? car.build : null;
    var elig = build ? eligibility(C, build, vm.raw) : { ok: false, reasons: ['No car selected — buy or select a car in My Cars'] };
    var tab = params.tab || 'calendar';
    var cal = calendarFor(vm.id);
    var rows = standingsFor(vm.id);
    var next = call(C, ['nextRound'], [P(), vm.id], null);
    var nextIdx = next && isNum(next.roundIdx) ? next.roundIdx : vm.roundsDone;
    var active = vm.entered || vm.started;
    var purse = isObj(vm.prize) ? first(vm.prize.purse, vm.prize.credits) : vm.prize;
    var raw = vm.raw || {};
    var rival = raw.rival || (Array.isArray(raw.rivals) && raw.rivals[0]);
    var rivalDef = rival ? call(C, ['getRival'], [rival], null) : null;
    var out = '<div class="gh-head"><div><div class="gh-kicker" style="color:' + esc(vm.color || 'var(--gh-accent)') + '">' + esc(raw.tierName || (vm.tier && vm.tier.name) || 'Special event') + ' · ' + esc(eventTypeLabel(vm.type)) + '</div>' +
      '<h1 class="gh-h1">' + esc(vm.name) + '</h1><p class="gh-sub">' + esc(vm.desc) + '</p>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' + requirementChips(vm.requirements).map(function (r) { return '<span class="gh-chip">' + esc(r) + '</span>'; }).join('') +
      (raw.pointsSystemName ? '<span class="gh-chip">' + esc(raw.pointsSystemName) + ' points</span>' : '') + '</div></div>' +
      '<div class="gh-panel cut" style="min-width:300px"><dl class="gh-kv">' +
      '<dt>Rounds</dt><dd>' + vm.roundsDone + ' / ' + vm.rounds.length + '</dd>' +
      '<dt>Purse (winner)</dt><dd>' + (purse ? esc(fmtCredits(purse)) : '—') + '</dd>' +
      '<dt>Entry fee</dt><dd>' + (vm.entryFee ? esc(fmtCredits(vm.entryFee)) : 'Free') + '</dd>' +
      (vm.season ? '<dt>Season</dt><dd>' + vm.season + '</dd>' : '') +
      (vm.playerPos ? '<dt>Your position</dt><dd>' + (vm.playerUnranked ? '—' : ordinal(vm.playerPos)) + ' · ' + fmtInt(vm.playerPoints) + ' pts</dd>' : '') +
      (raw.sponsor ? '<dt>Sponsor</dt><dd>' + esc(raw.sponsor) + '</dd>' : '') + '</dl></div></div>';
    // action bar
    out += '<div class="gh-panel" style="margin:18px 0;display:flex;gap:18px;align-items:center;flex-wrap:wrap">' +
      '<div style="width:180px">' + (build ? carArt(build, { uid: 'ch' }) : '') + '</div>' +
      '<div style="flex:1;min-width:240px"><div class="gh-kicker" style="margin-bottom:4px">Your entry</div><b style="font-size:16px">' + esc(car ? car.name : 'No car') + '</b> ' + (build ? piBadge(build) : '') + carEligibilityHTML(elig) + '</div>' +
      '<div class="gh-btns">';
    if (vm.locked) out += '<span class="gh-chip">' + icon('lock', 12) + ' ' + esc(vm.lockReason) + '</span>';
    else if (vm.complete) out += '<button class="gh-btn primary" data-nav data-act="restart" data-autofocus>New season</button>';
    else if (active) out += '<button class="gh-btn primary" data-nav data-act="brief" data-i="' + nextIdx + '" data-autofocus' + (elig.ok ? '' : ' disabled') + '>Round ' + (nextIdx + 1) + ' briefing</button><button class="gh-btn ghost small" data-nav data-act="withdraw">Withdraw</button>';
    else out += '<button class="gh-btn primary" data-nav data-act="enter" data-autofocus' + (elig.ok ? '' : ' disabled') + '>Enter' + (vm.entryFee ? ' · ' + esc(fmtCredits(vm.entryFee)) : '') + '</button>';
    if (!elig.ok && !vm.locked) out += '<button class="gh-btn" data-nav data-act="modify">Modify car</button><button class="gh-btn ghost" data-nav data-act="garage">My Cars</button>';
    out += '</div></div>';
    out += tabsHTML([{ id: 'calendar', name: 'Calendar', count: vm.rounds.length }, { id: 'standings', name: 'Standings' }, { id: 'info', name: 'Rules & rewards' }], tab);
    if (tab === 'calendar') {
      out += '<div class="gh-cal">' + cal.map(function (r) {
        var isNext = active && r.index === nextIdx;
        return '<button class="gh-round' + (r.status === 'done' ? ' is-done' : '') + (isNext ? ' is-next' : '') + '" data-nav data-key="rd-' + r.index + '" data-act="round" data-i="' + r.index + '">' +
          '<div class="r">R' + (r.index + 1) + (r.dateLabel ? ' · ' + esc(r.dateLabel) : '') + (r.isFinal ? ' · FINALE' : '') + '</div>' +
          (r.position ? '<span class="res"><span class="gh-pos ' + posClass(r.position) + '">' + r.position + '</span></span>' : '') +
          '<h4>' + esc(r.name) + '</h4><small style="color:var(--gh-dim)">' + esc(r.trackName || trackName(r.trackId, true)) + '</small>' +
          trackPreviewSVG(r.trackId, 160, 70, { width: 5 }) +
          '<div class="gh-round-foot">' + weatherIcon(r.weather) + '<span>' + titleCase(r.weather) + '</span>' + timeIcon(r.timeOfDay) + '<span>' + titleCase(r.timeOfDay) + ' · ' + r.laps + ' laps</span></div>' +
          // special-format tag on its own fixed row (every card has it) so it never wraps the footer or shifts the title
          '<div class="gh-round-tag">' + (r.eventType && r.eventType !== vm.type ? '<b>' + esc(eventTypeLabel(r.eventType)) + '</b>' : '') + '</div></button>';
      }).join('') + '</div>';
    } else if (tab === 'standings') {
      out += '<div class="gh-panel" style="padding:8px 8px 2px">' + standingsTable(rows, { rounds: true }) + '</div>';
    } else {
      var pts = raw.pointsSystem && getPath(catalogOf(C), 'pointsSystems.' + raw.pointsSystem);
      var table = pts && (pts.points || pts.table);
      out += '<div class="gh-grid c2"><div class="gh-panel"><h3 style="margin:0 0 10px">Points</h3>' +
        (Array.isArray(table) ? '<div style="display:flex;gap:6px;flex-wrap:wrap">' + table.map(function (v, i) { return '<span class="gh-chip">' + ordinal(i + 1) + ' · ' + v + '</span>'; }).join('') + '</div>' : '<p style="color:var(--gh-dim)">25 · 18 · 15 · 12 · 10 · 8 · 6 · 4 · 2 · 1, +1 for fastest lap.</p>') +
        (pts && (pts.fastestLap || pts.fastestLapBonus) ? '<p style="color:var(--gh-dim);margin-top:10px">+' + (pts.fastestLap || pts.fastestLapBonus) + ' for fastest lap' + (pts.pole ? ', +' + pts.pole + ' for pole' : '') + '</p>' : '') +
        '</div><div class="gh-panel"><h3 style="margin:0 0 10px">Rewards</h3><dl class="gh-kv">' +
        (isObj(vm.prize) && Array.isArray(vm.prize.positions) ? vm.prize.positions.slice(0, 5).map(function (v, i) { return '<dt>Champion' + (i ? ' ' + ordinal(i + 1) : '') + '</dt><dd>' + esc(fmtCredits(v)) + '</dd>'; }).join('') : '') +
        (isObj(vm.prize) && vm.prize.xp ? '<dt>XP bonus</dt><dd>' + fmtInt(vm.prize.xp) + ' XP</dd>' : '') + '</dl>' +
        (raw.rewards && raw.rewards.unlocks ? '<p style="color:var(--gh-dim);margin-top:10px">Unlocks: ' + esc(Object.keys(raw.rewards.unlocks).map(function (k) { return arr(raw.rewards.unlocks[k]).map(function (x) { return titleCase(String(x).split(':').pop()); }).join(', '); }).filter(Boolean).join(' · ') || '—') + '</p>' : '') + '</div>' +
        (rivalDef ? '<div class="gh-panel" style="grid-column:1/-1"><div class="gh-kicker">Rival</div><h3 style="margin:0 0 6px">' + esc(rivalDef.name || (rivalDef.first + ' ' + rivalDef.last)) + '</h3><p style="color:var(--gh-dim);margin:0">' + esc(rivalDef.bio || rivalDef.desc || rivalDef.tagline || '') + '</p></div>' : '') + '</div>';
    }
    host.innerHTML = out;
    onAct(host, {
      tab: function (d) { setParam('tab', d.tab); renderScreen(false); },
      enter: function () {
        if (!elig.ok) { sfx('error'); return; }
        confirmBox('Enter ' + vm.name, 'Season entry ' + (vm.entryFee ? 'costs <b>' + esc(fmtCredits(vm.entryFee)) + '</b> (balance ' + esc(fmtCredits(P().credits)) + ').' : 'is free.') + ' Your active car <b>' + esc(car.name) + '</b> will be entered.', 'Enter championship', function () {
          var r = careerMutate('enter', [vm.id, { build: build, carId: car.id }]);
          if (r && r.ok === false) { sfx('error'); toast(esc(r.reason || 'Could not enter'), 'bad'); return; }
          sfx('coin'); toast('Entered ' + esc(vm.name), 'good');
          var nr = call(career(), ['nextRound'], [P(), vm.id], null);
          show('briefing', { champId: vm.id, roundIdx: nr && isNum(nr.roundIdx) ? nr.roundIdx : 0 });
        }, { disabled: vm.entryFee > num(P().credits, 0) });
      },
      brief: function (d) { show('briefing', { champId: vm.id, roundIdx: +d.i }); },
      round: function (d) {
        var i = +d.i;
        if (active && i === nextIdx) show('briefing', { champId: vm.id, roundIdx: i });
        else {
          var r = cal[i];
          modal({ kicker: 'Round ' + (i + 1), title: r.name, body: '<p>' + esc(r.desc || '') + '</p><div style="display:grid;place-items:center;margin:10px 0">' + trackPreviewSVG(r.trackId, 360, 200, { width: 8 }) + '</div>' +
            '<dl class="gh-kv"><dt>Circuit</dt><dd>' + esc(trackName(r.trackId)) + '</dd><dt>Laps</dt><dd>' + r.laps + '</dd><dt>Conditions</dt><dd>' + titleCase(r.weather) + ' · ' + titleCase(r.timeOfDay) + '</dd>' +
            (r.position ? '<dt>Your result</dt><dd>' + ordinal(r.position) + (r.points != null ? ' · ' + r.points + ' pts' : '') + '</dd>' : '') + '</dl>', actions: [{ label: 'Close', kind: 'primary', value: true }] });
        }
      },
      withdraw: function () {
        confirmBox('Withdraw?', 'You will forfeit this season\'s points. Entry fees are not refunded.', 'Withdraw', function () {
          careerMutate('withdraw', [vm.id]); toast('Withdrawn from ' + esc(vm.name), 'warn'); refresh();
        }, { danger: true });
      },
      restart: function () {
        var r = careerMutate('restart', [vm.id]);
        if (r && r.ok === false) { careerMutate('enter', [vm.id, { build: build }]); }
        toast('New season · ' + esc(vm.name), 'good'); refresh();
      },
      modify: function () { modifyCarForChamp(vm); },
      garage: function () { show('garage'); }
    });
  }
  /** Championship / event / briefing without a (known) championship id: back to the career overview. */
  function champFallback(id) {
    if (!career()) return null;          // module still loading: the screen says so
    return id && champVMById(id) ? null : { id: 'career' };
  }
  screen('championship', { title: 'Championship', live: true, tabs: true, crumb: function (p) { var c = champRaw(p.id || p.champId); return c ? (c.short || c.name) : 'Championship'; }, render: renderChampionship,
    fallback: function (p) { return champFallback(p.id || p.champId); } });
  screen('event', { title: 'Event', live: true, tabs: true, crumb: function (p) { var c = champRaw(p.id || p.champId); return c ? (c.short || c.name) : 'Event'; }, render: renderChampionship,
    fallback: function (p) { return champFallback(p.id || p.champId); } });

  /* ======================================================================
     Screen: pre-race briefing
     ====================================================================== */
  screen('briefing', {
    title: 'Briefing', live: true,
    crumb: function (p) { return 'Round ' + (num(p.roundIdx, 0) + 1) + ' briefing'; },
    fallback: function (p) { return champFallback(p.champId); },
    render: function (host, params) {
      var C = career();
      var vm = champVMById(params.champId);
      if (!C || !vm) { host.innerHTML = moduleMissing('Career'); return; }
      var idx = clamp(num(params.roundIdx, vm.roundsDone), 0, Math.max(0, vm.rounds.length - 1));
      var r = calendarFor(vm.id)[idx] || vm.rounds[idx] || {};
      var br = call(C, ['briefing'], [P(), vm.id, idx], null) || {};
      var cfg = call(C, ['raceConfigFor'], [P(), vm.id, idx], null) || {};
      var car = activeCar(), build = car ? car.build : null;
      var elig = build ? eligibility(C, build, vm.raw) : { ok: false, reasons: ['No car selected'] };
      var units = setting('units', 'kph');
      var L = trackLength(r.trackId);
      var opp = num(first(Array.isArray(cfg.opponents) ? cfg.opponents.length : cfg.opponents, cfg.opponentCount, Array.isArray(r.opponents) ? r.opponents.length : r.opponents, vm.raw && vm.raw.opponents), 7);
      var et = first(getPath(cfg, 'extras.eventType'), r.eventType, vm.type);
      var lines = arr(first(br.paragraphs, br.lines, null));
      var text = first(br.text, br.intro, br.summary, r.desc, '');
      var rows = standingsFor(vm.id);
      var condition = car ? conditionLabel(car.condition) : null;
      host.innerHTML = '<div class="gh-kicker" style="color:' + esc(vm.color || 'var(--gh-accent)') + '">' + esc(vm.name) + ' · Round ' + (idx + 1) + ' of ' + vm.rounds.length + (r.isFinal ? ' · Finale' : '') + '</div>' +
        '<h1 class="gh-h1">' + esc(first(br.title, r.name, 'Round ' + (idx + 1))) + '</h1><p class="gh-sub">' + esc(trackName(r.trackId)) + ' · ' + esc(eventTypeLabel(et)) + '</p>' +
        '<div class="gh-brief"><div><div class="gh-panel cut gh-brief-map">' + trackPreviewSVG(r.trackId, 560, 320, { width: 11 }) + '</div>' +
        '<div class="gh-cond">' +
        '<div><small>Weather</small><b>' + weatherIcon(first(cfg.weather, r.weather)) + ' ' + titleCase(first(cfg.weather, r.weather, 'dry')) + '</b></div>' +
        '<div><small>Time of day</small><b>' + timeIcon(first(cfg.timeOfDay, r.timeOfDay)) + ' ' + titleCase(first(cfg.timeOfDay, r.timeOfDay, 'day')) + '</b></div>' +
        '<div><small>Distance</small><b class="gh-num">' + first(cfg.laps, r.laps, 3) + ' laps · ' + fmtDist(L * num(first(cfg.laps, r.laps), 3) / 1000, units) + '</b></div>' +
        '<div><small>Grid</small><b class="gh-num">' + (opp + 1) + ' cars</b></div>' +
        '<div><small>AI level</small><b>' + titleCase(first(cfg.difficulty, getPath(cfg, 'ai.level'), setting('difficulty', 'amateur'))) + '</b></div>' +
        '<div><small>Format</small><b>' + esc(eventTypeLabel(et)) + '</b></div></div>' +
        (getPath(cfg, 'extras.endurance') || getPath(cfg, 'extras.fuel') || getPath(cfg, 'extras.pitStops') ? '<div class="gh-panel" style="padding:12px 16px;border-left:3px solid var(--gh-warn)"><b>Endurance rules</b> — ' +
          [getPath(cfg, 'extras.wear') || getPath(cfg, 'extras.endurance') ? 'tyre wear' : null, getPath(cfg, 'extras.fuel') ? 'fuel consumption' : null, getPath(cfg, 'extras.damage') ? 'damage' : null, getPath(cfg, 'extras.pitStops') ? 'pit stops' + (isNum(getPath(cfg, 'extras.mandatoryPitStops')) ? ' (' + getPath(cfg, 'extras.mandatoryPitStops') + ' mandatory)' : '') : null].filter(Boolean).join(', ') + ' are active.</div>' : '') +
        '</div><div>' +
        '<div class="gh-panel"><div class="gh-kicker">Team briefing</div><p style="margin:0 0 8px">' + esc(text) + '</p>' + lines.map(function (l) { return '<p style="margin:0 0 8px;color:var(--gh-dim)">' + esc(typeof l === 'string' ? l : l.text) + '</p>'; }).join('') +
        (br.rivalLine || br.rival ? '<blockquote style="margin:12px 0 0;padding:10px 14px;border-left:3px solid var(--gh-hot);background:rgba(232,50,43,.06);font-style:italic">“' + esc(br.rivalLine || (isObj(br.rival) ? br.rival.line : br.rival)) + '”' + (isObj(br.rival) && br.rival.name ? '<br><small style="font-style:normal;color:var(--gh-dim)">— ' + esc(br.rival.name) + '</small>' : '') + '</blockquote>' : '') +
        (br.stakes ? '<p style="margin:12px 0 0;color:var(--gh-accent2)"><b>Stakes:</b> ' + esc(typeof br.stakes === 'string' ? br.stakes : arr(br.stakes).join(' · ')) + '</p>' : '') + '</div>' +
        '<div class="gh-panel" style="margin-top:14px"><div class="gh-kicker">Your car</div><div style="display:flex;gap:14px;align-items:center"><div style="width:170px">' + (build ? carArt(build, { uid: 'br' }) : '') + '</div><div><b>' + esc(car ? car.name : 'No car') + '</b>' + (build && modelName(build) ? '<div style="color:var(--gh-dim);font-size:12px">' + esc(modelName(build)) + '</div>' : '') + '<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">' + (build ? piBadge(build) : '') +
        (condition ? '<span class="gh-chip ' + condition.kind + '">' + condition.label + ' ' + pct(car.condition) + '</span>' : '') + '</div></div></div>' + carEligibilityHTML(elig) +
        (car && num(car.condition, 1) < 0.6 ? '<ul class="gh-reasons" style="border-left-color:var(--gh-warn);color:color-mix(in srgb,var(--gh-warn) 60%,var(--gh-text));background:rgba(240,180,41,.06)"><li>Worn car: performance and reliability suffer. Consider a repair (' + esc(fmtCredits(repairQuote(car).credits)) + ').</li></ul>' : '') + '</div>' +
        '<div class="gh-panel" style="margin-top:14px;padding:8px 8px 2px"><div class="gh-kicker" style="padding:8px 8px 0">Championship standings</div>' + standingsTable(rows, { limit: 5 }) + '</div>' +
        '<div class="gh-btns" style="margin-top:18px"><button class="gh-btn hot" data-nav data-act="go" data-autofocus' + (elig.ok ? '' : ' disabled') + '>' + icon('flag', 16) + ' Go racing</button>' +
        '<button class="gh-btn" data-nav data-act="sim"' + (elig.ok ? '' : ' disabled') + ' title="Let the stewards simulate this round from your car\'s performance">Simulate round</button>' +
        (car && num(car.condition, 1) < 0.95 ? '<button class="gh-btn ghost" data-nav data-act="repair">Repair</button>' : '') +
        (!elig.ok ? '<button class="gh-btn" data-nav data-act="modify">Modify car</button>' : '') + '</div></div></div>';
      var ctx = { kind: vm.tierIndex < 0 ? 'event' : 'career', champId: vm.id, roundIdx: idx, eventType: et, label: (vm.raw && vm.raw.short) || vm.name };
      var settings = {
        mode: 'race', trackId: first(cfg.trackId, r.trackId), laps: first(cfg.laps, r.laps), opponents: opp,
        difficulty: first(cfg.difficulty, getPath(cfg, 'ai.level'), setting('difficulty', 'amateur')), weather: first(cfg.weather, r.weather), timeOfDay: first(cfg.timeOfDay, r.timeOfDay), field: first(cfg.field, getPath(vm, 'raw.field'), 'mixed')
      };
      onAct(host, {
        go: function () {
          // Drift-judged rounds run as drift trials on #/drift (career.launchSpec decides the discipline + drift settings)
          var spec = call(C, ['launchSpec'], [P(), vm.id, idx, { build: build }], null);
          var st = settings, cf = cfg;
          if (spec && spec.route === 'drift' && spec.params) {
            st = Object.assign({}, settings, spec.params.settings || {}, { discipline: 'drift' });
            cf = Object.assign({}, cfg, spec.params.cfg || {}, { discipline: 'drift',
              launch: { route: 'drift', kind: ctx.kind, champId: vm.id, drift: spec.params.drift || null } });
          } else st = Object.assign({}, settings, { discipline: 'race' });
          H.lastLaunch = { build: build, settings: st, cfg: cf, context: ctx }; launchRace(H.lastLaunch);
        },
        sim: function () {
          confirmBox('Simulate this round?', 'The stewards simulate the race from your car\'s performance and the field. Rewards are paid as normal.', 'Simulate', function () {
            // the career module simulates with the real championship field (named rivals, team-mates, calibrated pace);
            // the generic hub simulation is only a fallback when it is missing or fails
            var res = call(C, ['simulateSession'], [P(), vm.id, idx, { build: build }], null);
            if (!res || !resultRows(res).length) res = simulateResults({ build: build, opponents: settings.opponents, laps: settings.laps, trackId: settings.trackId, difficulty: settings.difficulty, mode: 'race' });
            else { res.simulated = true; res.mode = res.mode || 'race'; res.trackId = res.trackId || settings.trackId; res.fieldSize = res.fieldSize || resultRows(res).length; }
            finishRace(res, ctx, settings, build);
          });
        },
        repair: function () { repairFlow(car.id); },
        modify: function () { modifyCarForChamp(vm); }
      });
    }
  });

  /* ======================================================================
     Screen: post-race rewards
     ====================================================================== */
  screen('rewards', {
    title: 'Results',
    // the results model lives in memory only: Back/Forward or a reload lands on the championship (or the menu) instead
    fallback: function (p) {
      if (p.model) return null;
      var cid = p.champId || p.id;
      if (cid && career() && champVMById(cid)) return { id: 'championship', params: { id: String(cid) } };
      return { id: cid ? 'career' : 'menu' };
    },
    render: function (host, params) {
      var m = params.model;
      if (!m) { host.innerHTML = '<div class="gh-empty"><b>No results</b></div>'; return; }
      var s = m.summary || {}, units = setting('units', 'kph');
      var isRace = m.mode === 'race';
      var pos = s.position, dnf = s.dnf;
      var flags = [];
      if (s.win) flags.push('<span class="gh-chip gold">Victory</span>');
      else if (s.podium) flags.push('<span class="gh-chip good">Podium</span>');
      if (s.pole) flags.push('<span class="gh-chip">Pole position</span>');
      if (s.fastestLap) flags.push('<span class="gh-chip" style="color:color-mix(in srgb,#a66bff 70%,var(--gh-text));border-color:rgba(166,107,255,.5)">Fastest lap</span>');
      if (s.clean && !m.challenge && (isRace || num(s.bestLap_s, 0) > 0)) flags.push('<span class="gh-chip good">Clean race</span>');
      if (dnf) flags.push('<span class="gh-chip bad">DNF</span>');
      if (m.simulated) flags.push('<span class="gh-chip warn">Simulated</span>');
      if (m.challenge) flags.push('<span class="gh-chip ' + (m.challenge.medal ? 'gold' : '') + '">' + esc(m.challenge.medal ? titleCase(m.challenge.medal) + ' medal' : 'No medal') + ' · ' + esc(fmtScore(m.challenge.def || {}, m.challenge.score)) + '</span>');
      if (m.drift) flags.push('<span class="gh-chip ' + (m.drift.medal ? 'gold' : '') + '">' + esc(m.drift.medal ? titleCase(m.drift.medal) + ' medal' : 'No medal') + '</span>');
      var hero = m.drift ? '<div class="gh-result-pos" style="font-size:72px">' + fmtInt(m.drift.score) + '</div><div style="color:var(--gh-dim)">Drift points' + (m.drift.maxCombo ? ' · max combo ×' + (+m.drift.maxCombo).toFixed(1) : '') + '</div>'
        : m.challenge ? '<div class="gh-result-pos" style="font-size:72px">' + esc(fmtScore(m.challenge.def || {}, m.challenge.score)) + '</div><div style="color:var(--gh-dim)">' + esc(m.challenge.medal ? titleCase(m.challenge.medal) + ' medal' : 'No medal') + (isNum(m.challenge.best) ? ' · best ' + esc(fmtScore(m.challenge.def || {}, m.challenge.best)) : '') + '</div>'
        : isRace && pos ? '<div class="gh-result-pos">' + (dnf ? 'DNF' : 'P' + pos) + '<small> / ' + (s.fieldSize || '—') + '</small></div>'
        : '<div class="gh-result-pos" style="font-size:72px">' + fmtTime(s.bestLap_s) + '</div><div style="color:var(--gh-dim)">Best lap</div>';
      var champBanner = m.championshipComplete ? '<div class="gh-panel cut" style="margin-top:16px;display:flex;gap:16px;align-items:center;border-color:rgba(212,176,106,.5)"><div style="width:70px">' + trophySVG(m.trophy ? trophyMedal(m.trophy) : 'gold') + '</div><div><div class="gh-kicker">Championship complete</div><b style="font-size:18px">' +
        esc(m.trophy && m.trophy.name ? m.trophy.name : 'Season over') + '</b><p style="margin:4px 0 0;color:var(--gh-dim)">' + (m.trophy && m.trophy.position ? 'Final position: ' + ordinal(m.trophy.position) : 'Check the trophy cabinet') + '</p></div></div>' : '';
      var me = resultRows(m.results).filter(function (c) { return c && c.isPlayer; })[0] || {};
      host.innerHTML = '<div class="gh-kicker">' + esc(m.context && m.context.label ? m.context.label : titleCase(m.kind || 'race')) + ' · ' + esc(trackName(m.trackId)) + '</div>' +
        '<h1 class="gh-h1">' + (m.drift ? (m.drift.medal ? 'Sideways <em>and golden</em>'.replace('golden', esc(m.drift.medal)) : 'Run <em>complete</em>') : m.challenge ? (m.challenge.medal ? 'Medal <em>earned</em>' : 'Challenge <em>' + (isNum(m.challenge.score) ? 'complete' : 'abandoned') + '</em>') : s.win ? 'Chequered <em>glory</em>' : dnf ? 'Did not <em>finish</em>' : s.podium ? 'On the <em>podium</em>' : isRace ? 'Session <em>complete</em>' : num(s.bestLap_s, 0) > 0 ? 'Lap <em>complete</em>' : 'Run <em>ended</em>') + '</h1>' +
        '<div class="gh-rewards"><div><div class="gh-result-hero">' + hero + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:16px">' + flags.join('') + '</div>' +
        '<dl class="gh-kv" style="margin-top:18px"><dt>Best lap</dt><dd>' + fmtTime(s.bestLap_s) + '</dd>' + (s.finishTime_s ? '<dt>Race time</dt><dd>' + fmtTime(s.finishTime_s) + '</dd>' : '') +
        (s.gridPosition ? '<dt>Started</dt><dd>' + ordinal(s.gridPosition) + '</dd>' : '') + (s.topSpeed_kph || me.topSpeed_kph ? '<dt>Top speed</dt><dd>' + fmtSpeed(s.topSpeed_kph || me.topSpeed_kph, units) + '</dd>' : '') +
        (s.distance_km ? '<dt>Distance</dt><dd>' + fmtDist(s.distance_km, units) + '</dd>' : '') + (s.overtakes ? '<dt>Overtakes</dt><dd>' + s.overtakes + '</dd>' : '') + '</dl></div>' + champBanner +
        (m.records && m.records.length ? '<div class="gh-panel" style="margin-top:16px"><div class="gh-kicker">New records</div>' + m.records.map(function (r) { return '<div>' + icon('star', 14) + ' ' + (r.type === 'bestLap' ? 'Personal best lap at ' : 'First lap time at ') + esc(trackName(r.trackId, true)) + ' — <b class="gh-num">' + fmtTime(r.value) + '</b>' + (r.prev ? ' <small style="color:var(--gh-good)">(−' + (r.prev - r.value).toFixed(3) + 's)</small>' : '') + '</div>'; }).join('') + '</div>' : '') +
        (m.standings ? '<div class="gh-panel" style="margin-top:16px;padding:8px 8px 2px"><div class="gh-kicker" style="padding:8px 8px 0">Championship standings</div>' + standingsTable(m.standings, { limit: 6 }) + '</div>' : '') +
        '</div><div><div class="gh-panel cut"><div class="gh-grid c2"><div><small style="letter-spacing:.18em;color:var(--gh-dim);font-size:10px">CREDITS EARNED</small><div class="gh-count" data-count="credits">CR 0</div></div>' +
        '<div><small style="letter-spacing:.18em;color:var(--gh-dim);font-size:10px">XP EARNED</small><div class="gh-count xp" data-count="xp">0</div></div></div>' +
        '<div style="display:flex;justify-content:space-between;margin-top:18px;font-size:12px;color:var(--gh-dim)"><span data-lvl>Level ' + m.before.level + '</span><span data-xpleft></span></div>' +
        '<div class="gh-xpbar"><i style="width:' + (num(getPath(m, 'before.info.progress'), 0) * 100).toFixed(1) + '%"></i></div>' +
        '<ul class="gh-breakdown">' + arr(m.breakdown).map(function (b) {
          return '<li><span>' + esc(b.label) + '</span><span class="c">' + (num(b.credits, 0) ? (b.credits < 0 ? '−' : '+') + esc(fmtCredits(Math.abs(b.credits))) : '') + '</span><span class="x">' + (num(b.xp, 0) ? (b.xp < 0 ? '−' : '+') + fmtInt(Math.abs(b.xp)) + ' XP' : '') + '</span></li>';
        }).join('') + '</ul></div>' +
        (m.achievements.length ? '<div class="gh-panel" style="margin-top:16px"><div class="gh-kicker">Achievements unlocked</div>' + m.achievements.map(function (a) {
          return '<div class="gh-ach" style="margin-top:8px"><div class="ic">' + (a.icon || icon('star', 40)) + '</div><div><h4>' + esc(a.name) + ' <span class="gh-chip">' + esc(a.tier || '') + '</span></h4><p>' + esc(a.desc || '') + '</p></div></div>';
        }).join('') + '</div>' : '') +
        (m.levelUp && m.newUnlocks.length ? '<div class="gh-panel" style="margin-top:16px"><div class="gh-kicker">New unlocks</div><div style="display:flex;gap:6px;flex-wrap:wrap">' + m.newUnlocks.slice(0, 16).map(function (u) { return '<span class="gh-chip good">' + esc(u.name || titleCase(u.id)) + '</span>'; }).join('') + '</div></div>' : '') +
        '<div class="gh-btns" style="margin-top:20px"><button class="gh-btn primary" data-nav data-act="cont" data-autofocus>Continue</button>' +
        (H.lastLaunch && m.kind !== 'career' && m.kind !== 'event' ? '<button class="gh-btn" data-nav data-act="again">Race again</button>' : '') +
        (rep() && call(rep(), ['last'], [], null) ? '<button class="gh-btn" data-nav data-act="replay">' + icon('film', 14) + ' Watch replay</button>' : '') +
        (isRace && m.results && resultRows(m.results).length > 1 ? '<button class="gh-btn ghost" data-nav data-act="classif">Classification</button>' : '') + '</div></div></div>';
      // animations (once per model)
      var credEl = host.querySelector('[data-count="credits"]'), xpEl = host.querySelector('[data-count="xp"]');
      var items = $$('.gh-breakdown li', host);
      if (m.animated) {
        credEl.textContent = fmtCredits(m.credits); xpEl.textContent = fmtInt(m.xp); items.forEach(function (li) { li.classList.add('in'); });
        var bar0 = host.querySelector('.gh-xpbar i'); bar0.style.width = (num(getPath(m, 'after.info.progress'), 0) * 100).toFixed(1) + '%';
        host.querySelector('[data-lvl]').textContent = 'Level ' + m.after.level;
      } else {
        m.animated = true;
        items.forEach(function (li, i) { later(function () { li.classList.add('in'); }, 250 + i * 140); });
        var dur = 900 + Math.min(1600, items.length * 140);
        later(function () { countUp(credEl, 0, m.credits, dur, fmtCredits, function () { sfx('coin'); }); countUp(xpEl, 0, m.xp, dur, fmtInt); }, 300);
        // XP bar segments
        // animate to the profile's real post-race XP (achievement XP granted during the race included) so the
        // bar, the level label and the 'XP to level N' line all agree with the header
        var gainedAll = Math.max(num(m.xp, 0), num(getPath(m, 'after.xp'), 0) - num(getPath(m, 'before.xp'), 0));
        var segs = xpSegments(m.before.xp, gainedAll, m.before.level);
        var bar = host.querySelector('.gh-xpbar i'), lvlEl = host.querySelector('[data-lvl]');
        var tAcc = 600;
        segs.forEach(function (sg) {
          later(function () {
            bar.style.transition = 'none'; bar.style.width = (sg.from * 100).toFixed(1) + '%';
            lvlEl.textContent = 'Level ' + sg.level;
            void bar.offsetWidth;
            bar.style.transition = 'width .9s cubic-bezier(.2,.8,.2,1)'; bar.style.width = (sg.to * 100).toFixed(1) + '%';
          }, tAcc);
          tAcc += 950;
          if (sg.levelUp) later(function () { levelUpFanfare(sg.level + 1, m.newUnlocks); }, tAcc - 50);
        });
        if (m.achievements.length && achv() && typeof achv().toast === 'function') m.achievements.slice(0, 3).forEach(function (a, i) { later(function () { safe(function () { achv().toast(a); }); }, tAcc + 400 + i * 900); });
      }
      var li2 = m.after && m.after.info;
      if (li2) host.querySelector('[data-xpleft]').textContent = li2.maxed ? 'Max level' : fmtInt(li2.remaining) + ' XP to level ' + (m.after.level + 1);
      onAct(host, {
        cont: function () {
          if ((m.kind === 'career' || m.kind === 'event') && m.context && m.context.champId) goBackTo(m.kind === 'event' ? 'event' : 'championship', { id: m.context.champId, tab: m.championshipComplete ? 'standings' : 'calendar' });
          else if (m.kind === 'challenge') goBackTo('challenges');
          else if (m.kind === 'timetrial') goBackTo('timetrial');
          else if (m.kind === 'quick' || m.kind === 'drift') goBackTo('quickrace');
          else back();
        },
        again: function () { if (H.lastLaunch) launchRace(H.lastLaunch); },
        replay: function () { watchReplay(null); },
        classif: function () {
          var cars = resultRows(m.results);
          modal({
            kicker: 'Classification', title: trackName(m.trackId), wide: true,
            body: '<table class="gh-table"><thead><tr><th>Pos</th><th>Driver</th><th class="n">Grid</th><th class="n">Best lap</th><th class="n">Time / gap</th></tr></thead><tbody>' + cars.map(function (c) {
              return '<tr class="' + (c.isPlayer ? 'is-player' : '') + '"><td><span class="gh-pos ' + posClass(c.position) + '">' + (c.position || '—') + '</span></td><td><span class="gh-swatch" style="background:' + esc(c.color || '#555') + '"></span>' + esc(c.name || c.driverName || c.id) + '</td>' +
                '<td class="n">' + (c.gridPosition || '—') + '</td><td class="n">' + fmtTime(c.bestLap_s) + '</td><td class="n">' + (c.dnf || c.status === 'dnf' ? 'DNF' : c.position === 1 ? fmtTime(first(c.finishTime_s, c.totalTime_s, c.time_s, c.raceTime_s)) : c.gapText ? esc(c.gapText) : '+' + num(first(c.gapLeader_s, c.gap_s), 0).toFixed(3)) + '</td></tr>';
            }).join('') + '</tbody></table>', actions: [{ label: 'Close', kind: 'primary', value: true }]
          });
        }
      });
    }
  });

  /* ======================================================================
     Shared setup widgets
     ====================================================================== */
  function segHTML(key, value, options) {
    return '<div class="gh-seg" role="radiogroup">' + options.map(function (o) {
      var id = isObj(o) ? o.id : o, name = isObj(o) ? o.name : titleCase(o);
      return '<button class="' + (String(id) === String(value) ? 'is-on' : '') + '" role="radio" aria-checked="' + (String(id) === String(value)) + '" data-nav data-key="seg-' + esc(key) + '-' + esc(id) + '" data-act="seg" data-k="' + esc(key) + '" data-v="' + esc(id) + '">' + esc(name) + '</button>';
    }).join('') + '</div>';
  }
  function stepperHTML(key, value, min, max) {
    return '<div class="gh-btns" style="gap:6px"><button class="gh-btn small" data-nav data-key="st-' + key + '-dn" data-act="step" data-k="' + key + '" data-d="-1"' + (value <= min ? ' disabled' : '') + '>−</button>' +
      '<b class="gh-num" style="min-width:34px;text-align:center;font-size:16px">' + value + '</b>' +
      '<button class="gh-btn small" data-nav data-key="st-' + key + '-up" data-act="step" data-k="' + key + '" data-d="1"' + (value >= max ? ' disabled' : '') + '>+</button></div>';
  }
  function switchHTML(key, on, label) {
    return '<button class="gh-switch' + (on ? ' is-on' : '') + '" role="switch" aria-checked="' + !!on + '" aria-label="' + esc(label || key) + '" data-nav data-key="sw-' + esc(key) + '" data-act="toggle" data-k="' + esc(key) + '"></button>';
  }
  var storageWarned = false;
  function rowHTML(label, hint, control) {
    // a slider has no visible text of its own: name it after its row so screen readers announce "Master volume, 80%"
    control = String(control).replace(/<input type="range"(?![^>]*aria-label)/g, '<input type="range" aria-label="' + esc(label) + '"');
    return '<div class="gh-row"><div class="lbl"><b>' + esc(label) + '</b>' + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</div>' + control + '</div>';
  }
  function trackLocked(id) {
    var E = eco();
    if (!E || typeof E.isTrackUnlocked !== 'function') return null;
    if (safe(function () { return E.isTrackUnlocked(P(), id); }, true)) return null;
    return { level: safe(function () { return E.trackUnlockLevel(id); }, null) };
  }
  function isDriftTrackDef(t) {
    var D = CB.race && CB.race.drift && CB.race.drift.session;
    if (D && typeof D.isDriftTrack === 'function') { var r = safe(function () { return D.isDriftTrack(t); }, null); if (r != null) return !!r; }
    return !!(t && (t.drift || t.driftZones));
  }
  function driftAvailable() { return !!(CB.race && CB.race.drift && typeof CB.race.drift.createSession === 'function'); }
  function trackCardsHTML(selected, opts) {
    opts = opts || {};
    var units = setting('units', 'kph');
    var list = trackList();
    if (opts.discipline === 'drift') list = list.filter(isDriftTrackDef).concat(list.filter(function (t) { return !isDriftTrackDef(t); }));
    else if (opts.discipline === 'race') list = list.filter(function (t) { return !isDriftTrackDef(t); }).concat(list.filter(isDriftTrackDef));
    return '<div class="gh-grid auto" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">' + list.map(function (t) {
      var lock = opts.ignoreLocks ? null : trackLocked(t.id);
      var st = getPath(P(), 'stats.tracks.' + t.id) || {};
      return '<button class="gh-card gh-trackcard' + (t.id === selected ? ' is-sel' : '') + (lock ? ' is-locked' : '') + '" data-nav data-key="tr-' + esc(t.id) + '" data-act="track" data-id="' + esc(t.id) + '">' +
        '<div class="gh-art">' + trackPreviewSVG(t.id, 180, 100, { width: 6 }) + '</div><div class="bd"><h3 style="font-size:14px">' + esc(t.short || t.name) +
        (isDriftTrackDef(t) ? ' <span class="gh-chip warn" style="font-size:10px;padding:1px 6px">Drift</span>' : '') + '</h3>' +
        '<p>' + esc([t.country, fmtDist(trackLength(t.id) / 1000, units)].filter(Boolean).join(' · ')) + '</p>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">' + diffPips(num(t.difficulty, 3)) +
        (lock ? '<span class="gh-chip">' + icon('lock', 11) + ' L' + (lock.level || '?') + '</span>' : st.bestLap_s ? '<span class="gh-chip">PB ' + fmtTime(st.bestLap_s) + '</span>' : '') + '</div></div></button>';
    }).join('') + '</div>';
  }
  function carPanelHTML(title) {
    var car = activeCar(), b = activeBuild();
    return '<div class="gh-panel cut"><div class="gh-kicker">' + esc(title || 'Your car') + '</div><div class="gh-hero-name" style="font-size:20px">' + esc(car ? car.name : buildName(b)) + '</div>' +
      '<div style="display:flex;gap:6px;margin:8px 0">' + (b ? piBadge(b) : '') + (car ? '<span class="gh-chip ' + conditionLabel(car.condition).kind + '">' + pct(car.condition) + '</span>' : '<span class="gh-chip warn">Garage build (not owned)</span>') + '</div>' +
      '<div>' + carArt(b, { uid: 'setup' }) + '</div>' + (b ? carStatsStrip(b) : '') +
      '<div class="gh-btns" style="margin-top:12px"><button class="gh-btn small" data-nav data-act="garage">Change car</button></div></div>';
  }

  /* ======================================================================
     Screen: quick race
     ====================================================================== */
  var DIFFS = [{ id: 'rookie', name: 'Rookie' }, { id: 'amateur', name: 'Amateur' }, { id: 'pro', name: 'Pro' }, { id: 'alien', name: 'Alien' }];
  var FIELDS = [{ id: 'similar', name: 'Matched' }, { id: 'presets', name: 'Icons' }, { id: 'mixed', name: 'Mixed' }];
  var WEATHERS = [{ id: 'dry', name: 'Dry' }, { id: 'damp', name: 'Damp' }, { id: 'wet', name: 'Wet' }];
  var TIMES = [{ id: 'day', name: 'Day' }, { id: 'dusk', name: 'Dusk' }, { id: 'night', name: 'Night' }];
  function setupState(kind) {
    H.setup = H.setup || {};
    if (!H.setup[kind]) {
      var tl = trackList();
      var firstOpen = tl.filter(function (t) { return !trackLocked(t.id); })[0] || tl[0] || {};
      H.setup[kind] = {
        trackId: firstOpen.id, laps: kind === 'tt' ? 3 : num(setting('gameplay.defaultLaps', 3), 3), opponents: kind === 'tt' ? 0 : num(setting('gameplay.defaultOpponents', 7), 7),
        difficulty: setting('difficulty', 'amateur'), field: setting('gameplay.field', 'similar'), weather: setting('gameplay.weather', 'dry'), timeOfDay: setting('gameplay.timeOfDay', 'day'),
        ghost: setting('gameplay.ghost', true) !== false
      };
    }
    return H.setup[kind];
  }
  function setupActions(kind, st, extra) {
    return Object.assign({
      track: function (d) { if (trackLocked(d.id)) { sfx('error'); toast(icon('lock', 14) + ' Track unlocks at level ' + (trackLocked(d.id).level || '?'), 'warn'); return; } st.trackId = d.id; refresh(); },
      seg: function (d) { st[d.k] = d.v; refresh(); },
      step: function (d) {
        var lim = { laps: [1, kind === 'tt' ? 20 : 50], opponents: [1, 11] }[d.k] || [0, 99];
        st[d.k] = clamp(num(st[d.k], 0) + num(d.d, 0), lim[0], lim[1]); refresh();
      },
      toggle: function (d) { st[d.k] = !st[d.k]; refresh(); },
      garage: function () { show('garage'); }
    }, extra || {});
  }
  var DISCIPLINE_OPTS = [{ id: 'race', name: 'Race' }, { id: 'drift', name: 'Drift' }];
  var DRIFT_MODE_OPTS = [{ id: 'trial', name: 'Score attack' }, { id: 'free', name: 'Free run' }, { id: 'tandem', name: 'Tandem' }];
  var DRIFT_LEN_OPTS = [{ id: '60', name: '60 s' }, { id: '90', name: '90 s' }, { id: '120', name: '2 min' }, { id: '180', name: '3 min' }];
  var ASSIST_OPTS = [{ id: 'off', name: 'Off' }, { id: 'light', name: 'Light' }, { id: 'medium', name: 'Medium' }, { id: 'heavy', name: 'Heavy' }, { id: 'auto', name: 'Auto' }];
  /** Quick-session state per discipline: switching keeps a remembered circuit for each. */
  function quickState() {
    var st = setupState('qr');
    if (!st.discipline) { st.discipline = 'race'; st.driftMode = 'trial'; st.driftDuration = '90'; }
    if (STEER_IDS.indexOf(st.raceSteerAssist) < 0) st.raceSteerAssist = steerAssistLevel('race');
    if (STEER_IDS.indexOf(st.driftSteerAssist) < 0) st.driftSteerAssist = steerAssistLevel('drift');
    if (st.discipline === 'drift' && !driftAvailable()) st.discipline = 'race';
    return st;
  }
  function firstTrackFor(discipline) {
    var l = trackList().filter(function (t) { return !trackLocked(t.id); });
    var drift = l.filter(isDriftTrackDef), other = l.filter(function (t) { return !isDriftTrackDef(t); });
    var pick0 = discipline === 'drift' ? (drift[0] || other[0]) : (other[0] || drift[0]);
    return pick0 ? pick0.id : null;
  }
  screen('quickrace', {
    title: 'Quick race', live: true,
    render: function (host) {
      var st = quickState(), drift = st.discipline === 'drift';
      if (!st.trackId) st.trackId = firstTrackFor(st.discipline);
      var t = trackById(st.trackId) || {};
      var units = setting('units', 'kph');
      var head = drift
        ? '<div class="gh-kicker">Quick session · Drift</div><h1 class="gh-h1">Angle, smoke, <em>style points</em></h1><p class="gh-sub">Scored drift runs in 3D: clipping zones, combo chains and tandem battles. The purse pays on score and medal; heavy steering assist makes the arrow keys enough.</p>'
        : '<div class="gh-kicker">Quick race</div><h1 class="gh-h1">Pick a circuit, <em>go racing</em></h1><p class="gh-sub">Single races against the AI. Purses are paid at half the career rate; stats, records and achievements all count.</p>';
      var discRow = rowHTML('Discipline', driftAvailable() ? 'Wheel-to-wheel racing or a scored drift session' : 'Drift modules are not loaded on this page', segHTML('discipline', st.discipline, driftAvailable() ? DISCIPLINE_OPTS : DISCIPLINE_OPTS.slice(0, 1)));
      var rows = drift
        ? rowHTML('Drift mode', st.driftMode === 'tandem' ? 'Chase an AI lead drifter: stay close for the proximity bonus' : st.driftMode === 'free' ? 'Endless practice, every slide scored' : 'Timed run with bronze to platinum targets', segHTML('driftMode', st.driftMode, DRIFT_MODE_OPTS)) +
          (st.driftMode === 'free' ? '' : rowHTML('Run length', 'The run ends when the clock runs out', segHTML('driftDuration', String(st.driftDuration), DRIFT_LEN_OPTS))) +
          rowHTML('Scoring difficulty', 'Medal targets and the purse multiplier', segHTML('difficulty', st.difficulty, DIFFS)) +
          rowHTML('Steering assist', 'Heavy (default): counter-steer and angle hold are automatic', segHTML('steerAssist', st.driftSteerAssist, ASSIST_OPTS)) +
          rowHTML('Weather', 'Wet tarmac slides earlier', segHTML('weather', st.weather, WEATHERS)) +
          rowHTML('Time of day', 'Night runs under the floodlights', segHTML('timeOfDay', st.timeOfDay, TIMES))
        : rowHTML('Laps', fmtDist(trackLength(st.trackId) * st.laps / 1000, units) + ' race distance', stepperHTML('laps', st.laps, 1, 50)) +
          rowHTML('Opponents', (st.opponents + 1) + ' cars on the grid', stepperHTML('opponents', st.opponents, 1, 11)) +
          rowHTML('AI difficulty', 'Changes pace, racecraft and the purse multiplier', segHTML('difficulty', st.difficulty, DIFFS)) +
          rowHTML('Field', 'Who you race against', segHTML('field', st.field, FIELDS)) +
          rowHTML('Steering assist', 'Light (default): you drive, slides are caught · Heavy: arrow keys are enough, with braking and line help', segHTML('steerAssist', st.raceSteerAssist, ASSIST_OPTS)) +
          rowHTML('Weather', 'Wet tarmac reduces grip for everyone', segHTML('weather', st.weather, WEATHERS)) +
          rowHTML('Time of day', 'Headlights on at dusk and night', segHTML('timeOfDay', st.timeOfDay, TIMES));
      host.innerHTML = head +
        '<div class="gh-setup"><div><div class="gh-set" style="margin-bottom:14px">' + discRow + '</div>' + trackCardsHTML(st.trackId, { ignoreLocks: false, discipline: st.discipline }) +
        '<h2 class="gh-h2">Session</h2><div class="gh-set">' + rows + '</div></div>' +
        '<div>' + carPanelHTML(drift ? 'Drifting with' : 'Racing with') + '<div class="gh-panel" style="margin-top:14px"><div class="gh-kicker">' + esc(t.name || trackName(st.trackId)) + '</div><p style="color:var(--gh-dim);margin:0 0 12px">' + esc(t.desc || t.blurb || '') + '</p>' +
        '<button class="gh-btn hot" style="width:100%" data-nav data-act="go" data-autofocus>' + icon('flag', 16) + (drift ? ' Start drift run' : ' Start race') + '</button></div></div></div>';
      onAct(host, setupActions('qr', st, {
        seg: function (d) {
          if (d.k === 'discipline' && d.v !== st.discipline) {
            st[st.discipline + 'TrackId'] = st.trackId;
            st.discipline = d.v;
            st.trackId = st[d.v + 'TrackId'] || firstTrackFor(d.v);
          } else if (d.k === 'steerAssist') st[st.discipline + 'SteerAssist'] = d.v;   // each discipline keeps its own level
          else st[d.k] = d.v;
          refresh();
        },
        go: function () {
          var settings, context;
          if (st.discipline === 'drift') {
            settings = { discipline: 'drift', mode: 'practice', driftMode: st.driftMode, driftDuration: +st.driftDuration || 90, steerAssist: st.driftSteerAssist,
              trackId: st.trackId, difficulty: st.difficulty, weather: st.weather, timeOfDay: st.timeOfDay, opponents: 0 };
            context = { kind: 'drift', label: 'Drift · ' + ({ trial: 'Score attack', free: 'Free run', tandem: 'Tandem' }[st.driftMode] || 'Run') };
          } else {
            settings = { discipline: 'race', mode: 'race', trackId: st.trackId, laps: st.laps, opponents: st.opponents, difficulty: st.difficulty, field: st.field, weather: st.weather, timeOfDay: st.timeOfDay, steerAssist: st.raceSteerAssist };
            context = { kind: 'quick', label: 'Quick race' };
          }
          H.lastLaunch = { build: activeBuild(), settings: settings, cfg: { trackId: st.trackId }, context: context };
          launchRace(H.lastLaunch);
        }
      }));
    }
  });

  /* ======================================================================
     Screen: time trial
     ====================================================================== */
  screen('timetrial', {
    title: 'Time trial', live: true,
    render: function (host) {
      var st = setupState('tt');
      var tracks = getPath(P(), 'stats.tracks') || {};
      var rows = trackList().map(function (t) { var r = tracks[t.id] || {}; return { id: t.id, name: t.short || t.name, best: r.bestLap_s, races: r.races || 0 }; });
      var raceRec = CB.race && CB.race.ui && CB.race.ui.records;
      host.innerHTML = '<div class="gh-kicker">Time trial</div><h1 class="gh-h1">Solo hot laps, <em>chase the ghost</em></h1><p class="gh-sub">An empty circuit, your car and the clock. Your fastest lap becomes the ghost to beat.</p>' +
        '<div class="gh-setup"><div>' + trackCardsHTML(st.trackId) +
        '<h2 class="gh-h2">Session</h2><div class="gh-set">' +
        rowHTML('Laps', 'Timed laps after the out-lap', stepperHTML('laps', st.laps, 1, 20)) +
        rowHTML('Ghost car', 'Race against your personal best', switchHTML('ghost', st.ghost, 'Ghost')) +
        rowHTML('Weather', '', segHTML('weather', st.weather, WEATHERS)) + rowHTML('Time of day', '', segHTML('timeOfDay', st.timeOfDay, TIMES)) + '</div>' +
        '<h2 class="gh-h2">Personal bests</h2><div class="gh-panel" style="padding:6px"><table class="gh-table"><thead><tr><th>Circuit</th><th class="n">Sessions</th><th class="n">Best lap</th></tr></thead><tbody>' +
        rows.map(function (r) { return '<tr class="' + (r.id === st.trackId ? 'is-player' : '') + '"><td>' + esc(r.name) + '</td><td class="n">' + r.races + '</td><td class="n">' + fmtTime(r.best) + '</td></tr>'; }).join('') + '</tbody></table></div></div>' +
        '<div>' + carPanelHTML('Car') + '<div class="gh-panel" style="margin-top:14px"><div class="gh-kicker">Target</div><div class="gh-count" style="font-size:34px">' + fmtTime(getPath(tracks, st.trackId + '.bestLap_s')) + '</div><p style="color:var(--gh-dim);margin:4px 0 12px">Personal best at ' + esc(trackName(st.trackId, true)) + (raceRec ? '' : '') + '</p>' +
        '<button class="gh-btn hot" style="width:100%" data-nav data-act="go" data-autofocus>' + icon('timer', 16) + ' Start time trial</button></div></div></div>';
      onAct(host, setupActions('tt', st, {
        go: function () {
          var settings = { mode: 'time-trial', trackId: st.trackId, laps: st.laps, opponents: 0, weather: st.weather, timeOfDay: st.timeOfDay, ghost: st.ghost };
          H.lastLaunch = { build: activeBuild(), settings: settings, cfg: { trackId: st.trackId, mode: 'time-trial' }, context: { kind: 'timetrial', label: 'Time trial' } };
          launchRace(H.lastLaunch);
        }
      }));
    }
  });

  /* ======================================================================
     Screen: challenges / driving school
     ====================================================================== */
  /* Medal targets scale with the car's performance class (CB.game.challenges medalsFor(build)); the catalogue's static
     c.medals are for its reference car, so they are only used when no build-specific targets can be computed. */
  var medalCache = { key: null, map: {} };
  function medalThresholds(c, build) {
    var m = null;
    if (c && typeof c.medalsFor === 'function') {
      build = build || activeBuild();
      var key = safe(function () { return JSON.stringify(build); }, null);
      if (key !== medalCache.key) medalCache = { key: key, map: {} };
      if (!(c.id in medalCache.map)) medalCache.map[c.id] = safe(function () { return c.medalsFor(build); }, null);
      m = medalCache.map[c.id];
    }
    m = (m && typeof m === 'object') ? m : (c.medals || {});
    if (Array.isArray(m)) return { bronze: m[0], silver: m[1], gold: m[2] };
    return { bronze: first(m.bronze, getPath(m, 'bronze.score')), silver: first(m.silver, getPath(m, 'silver.score')), gold: first(m.gold, getPath(m, 'gold.score')) };
  }
  function medalRank(m) { return { bronze: 1, silver: 2, gold: 3, platinum: 4 }[m] || 0; }
  function fmtScore(c, v) {
    if (!isNum(v)) return '—';
    var unit = c.unit || getPath(c, 'rules.unit') || (c.lowerIsBetter || getPath(c, 'rules.lowerIsBetter') ? 's' : 'pts');
    if (unit === 's' || unit === 'time') return v < 60 ? v.toFixed(2) + ' s' : fmtTime(v);
    if (unit === 'm') return v.toFixed(2) + ' m';
    if (unit === 'kph' || unit === 'km/h') return fmtSpeed(v, setting('units', 'kph'));
    return fmtInt(v) + ' ' + unit;
  }
  function launchChallenge(c) {
    var M = chal(), build = activeBuild();
    // Drift challenges are judged drift trials on #/drift: the challenges module's own launcher sets the session up,
    // records the medal and returns here (a time-trial race session can't score a drift).
    if (M && c && c.kind === 'drift' && typeof M.launch === 'function' && routerMod()) {
      var okD = safe(function () { return M.launch(c.id, { build: build, returnTo: 'challenges', onClose: function () { later(refresh, 0); } }); }, false);
      if (okD) return;
    }
    var sess = M ? call(M, ['createChallengeSession', 'createSession'], [c.id, build], null) : null;
    if (!sess) { sfx('error'); toast('Challenge module is not ready', 'bad'); return; }
    var cfg = sess.cfg || sess.config || sess;
    var trackId = first(cfg.trackId, getPath(c, 'trackDef.id'), getPath(cfg, 'track.id'));
    var settings = { mode: first(cfg.mode, 'time-trial'), trackId: trackId, laps: first(cfg.laps, 1), opponents: num(cfg.opponents, 0), weather: first(cfg.weather, 'dry'), timeOfDay: first(cfg.timeOfDay, 'day') };
    H.lastLaunch = { build: build, settings: settings, cfg: Object.assign({}, cfg, { challenge: sess, trackId: trackId }), context: { kind: 'challenge', challengeId: c.id, label: c.name, session: sess } };
    launchRace(H.lastLaunch);
  }
  screen('challenges', {
    title: 'Challenges', live: true,
    render: function (host) {
      var M = chal(), list = challengeList();
      var usingPlaceholders = !list.length;
      if (usingPlaceholders) list = CHALLENGE_PLACEHOLDERS;
      var golds = 0, medals = 0;
      list.forEach(function (c) { var b = challengeBest(c.id); var r = medalRank(b && b.medal); if (r) medals++; if (r >= 3) golds++; });
      host.innerHTML = '<div class="gh-head"><div><div class="gh-kicker">Driving school</div><h1 class="gh-h1">Skill <em>challenges</em></h1><p class="gh-sub">Short, sharp tests of a single skill on purpose-built layouts. Earn bronze, silver and gold — and the credits that come with them.</p></div>' +
        '<div class="gh-btns"><span class="gh-chip gold">' + golds + ' gold</span><span class="gh-chip">' + medals + ' / ' + list.length + ' medals</span></div></div>' +
        (usingPlaceholders ? moduleMissing('Challenges', 'The driving school layouts register themselves when js/game/challenges.js loads. A preview of the curriculum is shown below.') + '<div style="height:16px"></div>' : '') +
        (driftAvailable() ? '<div class="gh-panel cut gh-drift-cta" style="display:flex;gap:18px;align-items:center;margin-bottom:16px;border-color:var(--gh-line2)">' +
          '<span style="color:var(--gh-accent)">' + icon('drift', 30) + '</span><div class="gh-drift-cta-txt" style="flex:1"><div class="gh-kicker">Drift school · 3D</div><b style="font-size:17px">Drift score attack and tandem battles</b>' +
          '<p style="margin:4px 0 0;color:var(--gh-dim)">Full drift sessions on the dedicated drift venues: clipping zones, combos, medals and an AI lead car to chase.</p></div>' +
          '<div class="gh-btns"><button class="gh-btn hot" data-nav data-act="drift" data-mode="trial">Score attack</button><button class="gh-btn" data-nav data-act="drift" data-mode="tandem">Tandem</button></div></div>' : '') +
        '<div class="gh-grid auto">' + list.map(function (c) {
          var b = challengeBest(c.id) || {}, th = medalThresholds(c), rank = medalRank(b.medal);
          return '<button class="gh-card' + (usingPlaceholders ? ' is-locked' : '') + '" data-nav data-key="cg-' + esc(c.id) + '" data-act="start" data-id="' + esc(c.id) + '">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><span style="color:var(--gh-accent)">' + icon(c.icon && ICONS[c.icon] ? c.icon : 'cone', 26) + '</span>' +
            '<div class="gh-medals">' + ['bronze', 'silver', 'gold'].map(function (m, i) { return '<span class="gh-medal ' + m + (rank > i ? ' on' : '') + '" title="' + titleCase(m) + (th[m] != null ? ': ' + esc(fmtScore(c, th[m])) : '') + '"><span>' + m[0].toUpperCase() + '</span></span>'; }).join('') + '</div></div>' +
            '<h3>' + esc(c.name) + '</h3><p>' + esc(c.desc || '') + '</p>' +
            '<div class="gh-card-foot"><span class="gh-chip">Best ' + esc(fmtScore(c, num(b.score, NaN))) + '</span>' + (b.attempts ? '<span class="gh-chip">' + b.attempts + (b.attempts === 1 ? ' attempt' : ' attempts') + '</span>' : '') +
            (th.gold != null ? '<span class="gh-chip warn">Gold ' + esc(fmtScore(c, th.gold)) + '</span>' : '') + '</div></button>';
        }).join('') + '</div>';
      onAct(host, {
        start: function (d) {
          if (usingPlaceholders || !M) { sfx('error'); toast('Challenges module loading…', 'warn'); return; }
          var c = list.filter(function (x) { return x.id === d.id; })[0];
          if (c) launchChallenge(c);
        },
        drift: function (d) {
          var rt = routerMod();
          if (rt) { safe(function () { rt.go('drift', { mode: d.mode === 'tandem' ? 'tandem' : 'trial' }); }); return; }
          var st = quickState();
          if (st.discipline !== 'drift') { st[st.discipline + 'TrackId'] = st.trackId; st.discipline = 'drift'; st.trackId = st.driftTrackId || firstTrackFor('drift'); }
          st.driftMode = d.mode === 'tandem' ? 'tandem' : 'trial';
          show('quickrace');
        }
      });
    }
  });

  /* ======================================================================
     Screen: garage
     ====================================================================== */
  function repairFlow(id) {
    var car = carById(id); if (!car) return;
    var q = repairQuote(car);
    if (q.credits <= 0) { toast('Nothing to repair', 'good'); return; }
    modal({
      kicker: 'Workshop', title: 'Repair ' + car.name,
      body: '<ul class="gh-breakdown">' + arr(q.lines).map(function (l) { return '<li class="in"><span>' + esc(l.label) + '</span><span class="c">' + esc(fmtCredits(l.credits)) + '</span></li>'; }).join('') + '</ul>' +
        '<div style="display:flex;justify-content:space-between;margin-top:14px;font-weight:800"><span>Total</span><span class="gh-num" style="color:var(--gh-accent2)">' + esc(fmtCredits(q.credits)) + '</span></div>',
      actions: [{ label: 'Cancel', kind: 'ghost', value: false }, { label: 'Repair to 100%', kind: 'primary', value: true, disabled: q.credits > num(P().credits, 0) }],
      onClose: function (v) {
        if (!v) return;
        var r = repairCar(id);
        if (r.ok) { sfx('coin'); toast(esc(car.name) + ' repaired · −' + esc(fmtCredits(r.credits)), 'good'); refresh(); } else { sfx('error'); toast(esc(r.reason), 'bad'); }
      }
    });
  }
  function sellFlow(id) {
    var car = carById(id); if (!car) return;
    var q = sellQuote(car);
    modal({
      kicker: 'Dealer offer', title: 'Sell ' + car.name + '?',
      body: '<ul class="gh-breakdown">' + arr(q.lines).map(function (l) { return '<li class="in"><span>' + esc(l.label) + '</span><span class="c">' + (l.credits < 0 ? '−' : '') + esc(fmtCredits(Math.abs(l.credits))) + '</span></li>'; }).join('') + '</ul>' +
        '<div style="display:flex;justify-content:space-between;margin-top:14px;font-weight:800"><span>Offer</span><span class="gh-num" style="color:var(--gh-accent2)">' + esc(fmtCredits(q.credits)) + '</span></div>' +
        (P().ownedCars.length === 1 ? '<ul class="gh-reasons"><li>This is your only car — you will need to buy another to race in career.</li></ul>' : ''),
      actions: [{ label: 'Keep car', kind: 'ghost', value: false }, { label: 'Sell for ' + fmtCredits(q.credits), kind: 'hot', value: true }],
      onClose: function (v) {
        if (!v) return;
        var r = sellCar(id);
        if (r.ok) { sfx('coin'); toast('Sold · +' + esc(fmtCredits(r.credits)), 'good'); refresh(); }
        else if (r.reason) toast(esc(r.reason), 'warn');
      }
    });
  }
  function renameFlow(id) {
    var car = carById(id); if (!car) return;
    var val = car.name;
    modal({
      kicker: 'My Cars', title: 'Rename car', body: '<input class="gh-input" data-nav maxlength="40" style="width:100%" aria-label="Car name" value="' + esc(car.name) + '">',
      actions: [{ label: 'Cancel', kind: 'ghost', value: false }, { label: 'Save', kind: 'primary', value: true, handler: function (m) { val = m.card.querySelector('input').value; } }],
      mount: function (card) {
        var i = card.querySelector('input');
        i.addEventListener('input', function () { val = i.value; });
        setTimeout(function () { i.focus(); i.select(); }, 30);
      },
      onClose: function (v) {
        if (v && String(val || '').trim()) { patchCar(id, { name: String(val).trim().slice(0, 40) }); toast('Renamed to ' + esc(String(val).trim()), 'good'); refresh(); }
      }
    });
  }
  function upgradeFlow(id) {
    var car = carById(id); if (!car) return;
    var opened = openAtelier('career-upgrade', { carId: car.id, build: car.build, onConfirm: function (b) { confirmUpgrade(car.id, b); } });
    if (!opened) show('workshop', { carId: id });
  }
  /** Saved Atelier builds (CB.garage / CB.state localStorage garage). */
  function savedBuilds() {
    var G = CB.garage;
    var l = G && typeof G.list === 'function' ? safe(function () { return G.list(); }, []) : [];
    return arr(l).filter(function (e) { return e && e.id && e.build; });
  }
  function driveCurrent(disc) {
    var router = routerMod();
    if (CB.app && typeof CB.app.drive === 'function') { safe(function () { CB.app.drive(disc); }); return; }
    if (router) { router.go(disc); return; }
    show('quickrace', disc === 'drift' ? { discipline: 'drift' } : null);
  }
  /** My Cars (route id 'garage', URL #/cars): the current Garage build, saved builds and career-owned cars. */
  screen('garage', {
    title: 'My Cars', live: true,
    render: function (host) {
      var p = P(), cars = p.ownedCars || [], units = setting('units', 'kph');
      // garage value = market value of every car; resale = what the dealer would pay for the cars you may sell
      var Eg = eco(), CCg = CB.game && CB.game.career;
      var marketOf = function (c) {
        // free / token-priced entry cars (purchasedFor ~ 0) are valued on their build, not on what they cost
        var v = Eg && typeof Eg.carValue === 'function' && num(c.purchasedFor, 0) >= 1000 ? safe(function () { return Eg.carValue(c); }, null) : null;
        if (!(isNum(v) && v > 0)) v = c.build ? priceOf(c.build) * (0.45 + 0.55 * Math.max(0, Math.min(1, num(c.condition, 1)))) : 0;
        return Math.round(v / 100) * 100;
      };
      var sellable = function (c) {
        var gate = CCg && typeof CCg.canSellCar === 'function' ? safe(function () { return CCg.canSellCar(p, c.id); }, null) : null;
        return !(gate && gate.ok === false);
      };
      var total = cars.reduce(function (s, c) { return s + marketOf(c); }, 0);
      var resale = cars.reduce(function (s, c) { return s + (sellable(c) ? Math.max(0, num(sellQuote(c).credits, 0)) : 0); }, 0);
      var cur = currentAtelierBuild(), saved = savedBuilds(), G = CB.garage;
      var curId = cur && cur.meta ? cur.meta.id : null;
      var dirty = cur && G && typeof G.isDirty === 'function' ? !!safe(function () { return G.isDirty(cur); }, false) : false;
      var curSaved = saved.some(function (e) { return e.id === curId; });
      var spec = function (b) { return esc(modelName(b) || titleCase(bodyStyleOf(b))) + ' · ' + fmtInt(getPath(metricsFor(b), 'power_hp')) + ' hp'; };
      var out = '<div class="gh-head"><div><div class="gh-kicker">My Cars</div><h1 class="gh-h1">Your <em>cars</em></h1><p class="gh-sub">Your current build, the builds you saved and the cars you own in career, in one place. Race and Drift always drive the current build; career championships use your active career car.</p></div>' +
        '<div class="gh-btns"><span class="gh-chip">' + saved.length + ' saved build' + (saved.length === 1 ? '' : 's') + '</span><span class="gh-chip">' + cars.length + ' career car' + (cars.length === 1 ? '' : 's') + '</span>' +
        (cars.length ? '<span class="gh-chip gold" title="Market value of your career cars">Collection value ' + esc(fmtCredits(total)) + '</span>' +
          '<span class="gh-chip" title="What the dealer pays for the cars you can sell right now (free entry cars and a car needed mid-season are excluded)">Resale ' + esc(fmtCredits(resale)) + '</span>' : '') +
        '<button class="gh-btn" data-nav data-act="buy">' + icon('plus', 14) + ' Buy a car</button></div></div>';
      // current build (CB.state): what Race / Drift drive
      if (cur) {
        out += '<h2 class="gh-h2">Current build</h2><div class="gh-card gh-carcard is-active gh-gar-cur" style="cursor:default">' +
          '<div class="gh-art"><span class="gh-chip gold act">In the Garage</span>' + carArt(cur, { uid: 'gcur' }) + '</div>' +
          '<div><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px"><h3>' + esc(buildName(cur)) + '</h3>' + piBadge(cur) + '</div>' +
          '<p>' + spec(cur) + (curSaved ? (dirty ? ' · unsaved changes' : ' · saved') : ' · not saved yet') + '</p>' +
          '<div class="gh-btns"><button class="gh-btn small primary" data-nav data-act="driveRace" data-autofocus>' + icon('flag', 12) + ' Race</button>' +
          '<button class="gh-btn small" data-nav data-act="driveDrift">Drift</button>' +
          '<button class="gh-btn small" data-nav data-act="atelier">' + icon('wrench', 12) + ' Edit in Garage</button>' +
          (G && typeof G.save === 'function' ? '<button class="gh-btn small ghost" data-nav data-act="saveCur"' + (curSaved && !dirty ? ' disabled' : '') + '>' + (curSaved ? 'Save changes' : 'Save build') + '</button>' : '') +
          '</div></div></div>';
      }
      // saved builds (the Atelier's saved-builds garage)
      out += '<h2 class="gh-h2">Saved builds</h2>' + (saved.length ? '<div class="gh-grid auto" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">' + saved.map(function (e, i) {
        var isCur = e.id === curId;
        return '<div class="gh-card gh-carcard' + (isCur ? ' is-active' : '') + '" style="cursor:default">' +
          '<div class="gh-art">' + (isCur ? '<span class="gh-chip gold act">Current</span>' : '') + carArt(e.build, { uid: 'gs' + i }) + '</div>' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px"><h3>' + esc(e.name || buildName(e.build)) + '</h3>' + piBadge(e.build) + '</div>' +
          '<p>' + spec(e.build) + (isNum(e.saved) ? ' · saved ' + esc(fmtDate(e.saved)) : '') + '</p>' +
          '<div class="gh-btns">' + (isCur ? '<button class="gh-btn small" data-nav data-act="atelier">Edit in Garage</button>'
            : '<button class="gh-btn small primary" data-nav data-key="sb-' + esc(e.id) + '" data-act="loadSaved" data-id="' + esc(e.id) + '">Make current</button>') +
          '<button class="gh-btn small danger" data-nav data-act="delSaved" data-id="' + esc(e.id) + '"' + (G && typeof G.remove === 'function' ? '' : ' disabled') + '>Delete</button></div></div>';
      }).join('') + '</div>' : '<p class="gh-sub" style="margin-top:0">Builds you save in the Garage appear here. Make one current to race or drift it.</p>');
      // career-owned cars
      out += '<h2 class="gh-h2">Career cars</h2>';
      host.innerHTML = out +
        (cars.length ? '<div class="gh-grid auto" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">' + cars.map(function (c, i) {
          var isAct = c.id === p.activeCarId || (!p.activeCarId && i === 0), cl = conditionLabel(c.condition);
          var rq = repairQuote(c).credits;
          return '<div class="gh-card gh-carcard' + (isAct ? ' is-active' : '') + '" style="cursor:default">' +
            '<div class="gh-art">' + (isAct ? '<span class="gh-chip gold act">Active</span>' : '') + carArt(c.build, { uid: 'g' + i }) + '</div>' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px"><h3>' + esc(c.name) + '</h3>' + piBadge(c.build) + '</div>' +
            '<p>' + esc(modelName(c.build) || titleCase(bodyStyleOf(c.build))) + ' · ' + fmtInt(getPath(metricsFor(c.build), 'power_hp')) + ' hp · ' + esc(fmtDist(c.odometer_km, units)) + ' · ' + num(c.races, 0) + ' races · ' + num(c.wins, 0) + ' wins</p>' +
            '<div class="gh-cond-row"><span>Condition</span><div class="gh-bar ' + cl.kind + '"><i style="width:' + (num(c.condition, 1) * 100).toFixed(0) + '%"></i></div><b class="gh-num">' + pct(c.condition) + '</b></div>' +
            '<div class="gh-btns">' + (isAct ? '<button class="gh-btn small primary" data-nav data-act="race" data-id="' + esc(c.id) + '">Race</button>' : '<button class="gh-btn small primary" data-nav data-act="activate" data-id="' + esc(c.id) + '">Set active</button>') +
            '<button class="gh-btn small" data-nav data-act="upgrade" data-id="' + esc(c.id) + '">Upgrade</button>' +
            '<button class="gh-btn small" data-nav data-act="repair" data-id="' + esc(c.id) + '"' + (rq > 0 ? '' : ' disabled') + '>Repair' + (rq > 0 ? ' · ' + esc(fmtCompact(rq)) : '') + '</button>' +
            '<button class="gh-btn small ghost" data-nav data-act="rename" data-id="' + esc(c.id) + '">Rename</button>' +
            '<button class="gh-btn small danger" data-nav data-act="sell" data-id="' + esc(c.id) + '">Sell</button></div></div>';
        }).join('') + '</div>' : '<div class="gh-panel" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:240px"><b>No career cars yet</b><p style="margin:4px 0 0;color:var(--gh-dim)">Career championships are raced in cars you buy with credits. Free races and drift sessions use your current build.</p></div>' +
          '<button class="gh-btn primary" data-nav data-act="showroom">Visit showroom</button></div>');
      if (hasDOM) {
        var onChange = function () { if (H && H.stack.length && H.stack[H.stack.length - 1].id === 'garage') later(function () { refresh(); }, 30); };
        document.addEventListener('cb:garage-changed', onChange);
        onCleanup(function () { document.removeEventListener('cb:garage-changed', onChange); });
      }
      onAct(host, {
        buy: function () { show('showroom'); }, showroom: function () { show('showroom'); },
        driveRace: function () { driveCurrent('race'); },
        driveDrift: function () { driveCurrent('drift'); },
        atelier: function () { if (!openAtelier('free')) toast('The Garage is not available on this page', 'warn'); },
        saveCur: function () { if (G && typeof G.save === 'function') { var e = safe(function () { return G.save(); }, null); if (e) toast('Saved “' + esc(e.name || buildName(cur)) + '”', 'good'); refresh(); } },
        loadSaved: function (d) {
          if (!G || typeof G.load !== 'function') return;
          var pr = safe(function () { return G.load(d.id); }, null);
          if (pr && typeof pr.then === 'function') pr.then(function (ok) { if (ok && H) { toast('Current build changed', 'good'); refresh(); } });
          else refresh();
        },
        delSaved: function (d) { if (G && typeof G.remove === 'function') safe(function () { G.remove(d.id); }); },
        activate: function (d) { setActive(d.id); toast('Active car set', 'good'); refresh(); },
        race: function (d) {
          // unified game: the race UI's own setup (#/race) with this car, results back to the hub's rewards screen
          var rc = (d && d.id && carById(d.id)) || activeCar();
          if (routerMod() && raceUI() && rc && rc.build) { launchRace({ build: rc.build, settings: { discipline: 'race' }, cfg: { autoStart: false }, context: { kind: 'quick', carId: rc.id, label: rc.name } }); return; }
          show('quickrace');
        },
        upgrade: function (d) { upgradeFlow(d.id); },
        repair: function (d) { repairFlow(d.id); },
        sell: function (d) { sellFlow(d.id); },
        rename: function (d) { renameFlow(d.id); }
      });
    }
  });

  /* ======================================================================
     Screen: showroom (buy a car)
     ====================================================================== */
  function buyFlow(build, opts) {
    opts = opts || {};
    var price = priceOf(build), name = opts.name || buildName(build, 'New car');
    var locks = lockViolations(build), bal = num(P().credits, 0);
    var E = eco(), q = E && E.carQuote ? safe(function () { return E.carQuote(build); }, null) : null;
    function complete() {
      var r = buyCar(build, { price: price, name: name });
      if (r.ok) { sfx('coin'); toast('Welcome to My Cars: ' + esc(name), 'good'); if (opts.after) opts.after(r); else goBackTo('garage'); }
      else { sfx('error'); toast(esc(r.reason), 'bad'); }
    }
    // the Atelier's own "Confirm purchase" bar already showed the price: don't ask twice
    if (opts.confirmed && !locks.length && price <= bal) { complete(); return; }
    modal({
      kicker: 'Showroom', title: 'Buy ' + name,
      body: '<div style="margin:6px 0 10px">' + carArt(build, { uid: 'buy' }) + '</div>' + carStatsStrip(build) +
        '<dl class="gh-kv" style="margin-top:14px">' + (q && q.msrp ? '<dt>List price (MSRP)</dt><dd>$' + fmtInt(q.msrp) + '</dd><dt>Career price (×' + q.factor + ')</dt><dd>' + esc(fmtCredits(price)) + '</dd>' : '<dt>Price</dt><dd>' + esc(fmtCredits(price)) + '</dd>') +
        '<dt>Balance after</dt><dd style="color:' + (bal - price < 0 ? 'var(--gh-bad)' : 'inherit') + '">' + esc(fmtCredits(bal - price)) + '</dd></dl>' +
        (locks.length ? '<p class="gh-reasons-head" style="margin:12px 0 -6px;font-weight:700;color:var(--gh-bad)">' + icon('lock', 12) + ' Buy is locked: ' + locks.length + ' part' + (locks.length === 1 ? ' needs' : 's need') + ' a higher driver level (you are level ' + fmtInt(num(P().level, 1)) + '). Customise or pick the Club-spec version.</p>' +
          '<ul class="gh-reasons">' + locks.slice(0, 6).map(function (l) { return '<li>' + icon('lock', 12) + ' ' + esc((l.category ? l.category + ': ' : '') + l.name) + ' — level ' + l.level + '</li>'; }).join('') + (locks.length > 6 ? '<li>…and ' + (locks.length - 6) + ' more</li>' : '') + '</ul>' : '') +
        (price > bal ? '<ul class="gh-reasons"><li>You need ' + esc(fmtCredits(price - bal)) + ' more.</li></ul>' : ''),
      actions: [{ label: 'Cancel', kind: 'ghost', value: false }].concat(locks.length && opts.canCustomise !== false && appMod() ? [{ label: 'Customise', value: 'custom' }] : []).concat(locks.length ? [{ label: 'Club-spec version', value: 'legal' }] : []).concat([{ label: 'Buy · ' + fmtCredits(price), kind: 'primary', value: true, disabled: !!locks.length || price > bal,
        title: locks.length ? 'Locked: ' + locks.map(function (l) { return l.name; }).slice(0, 6).join(', ') + (locks.length > 6 ? '…' : '') : price > bal ? 'You need ' + fmtCredits(price - bal) + ' more' : '' }]),
      onClose: function (v) {
        if (v === 'custom') { customBuy(build); return; }
        if (v === 'legal') { var lb = legalBuild(build); later(function () { buyFlow(lb.build, Object.assign({}, opts, { name: name + ' Club Spec' })); }, 40); return; }
        if (!v) return;
        complete();
      }
    });
  }
  function customBuy(seed) {
    var ok = openAtelier('career-buy', { build: seed || defaultBuild() || undefined, priceLabel: 'Prices in credits', onConfirm: function (b) { later(function () { buyFlow(b, { canCustomise: false, confirmed: true }); }, 60); } });
    if (!ok) {
      if (H && H.standalone && hasDOM) {
        // hub.html has no configurator: hand over to index.html, which reopens this hub on the showroom
        confirmBox('Commission in the Garage', 'The car builder runs on its own page. Open it now? The career showroom reopens there so you can commission and buy your build.', 'Open Garage', function () {
          window.location.href = 'index.html#/cars/showroom';
        });
        return;
      }
      var cur = currentAtelierBuild();
      if (cur) buyFlow(cur, { canCustomise: false });
      else toast('The Garage is not available on this page', 'warn');
    }
  }
  screen('showroom', {
    title: 'Showroom', live: true,
    render: function (host, params) {
      var ps = presets().filter(function (x) { return x.build; });
      var atelier = currentAtelierBuild();
      var C = career(), champ = params.champId ? champRaw(params.champId) : null;
      var bal = num(P().credits, 0);
      var clubs = [];
      ps.forEach(function (x) {
        if (!lockViolations(x.build).length) return;
        var lb = legalBuild(x.build);
        if (!lockViolations(lb.build).length) clubs.push({ id: 'club-' + x.id, name: x.name + ' Club Spec', build: lb.build, changes: lb.changes.length || 'Some' });
      });
      clubs = clubs.slice(0, 6);
      var card = function (b, name, tag, key, act) {
        var price = priceOf(b), locks = lockViolations(b), elig = champ ? eligibility(C, b, champ) : null;
        return '<button class="gh-card gh-carcard" data-nav data-key="' + esc(key) + '" data-act="' + act + '" data-id="' + esc(key) + '">' +
          '<div class="gh-art">' + carArt(b, { uid: key }) + '</div><div style="display:flex;justify-content:space-between;gap:10px"><h3>' + esc(name) + '</h3>' + piBadge(b) + '</div><p>' + esc(tag || '') + '</p>' +
          '<div class="gh-card-foot"><span class="gh-chip ' + (price > bal ? 'bad' : 'gold') + '">' + esc(fmtCredits(price)) + '</span>' +
          (locks.length ? '<span class="gh-chip warn">' + icon('lock', 11) + ' ' + locks.length + ' locked part' + (locks.length > 1 ? 's' : '') + '</span>' : '') +
          (elig ? '<span class="gh-chip ' + (elig.ok ? 'good' : 'bad') + '">' + (elig.ok ? 'Eligible' : 'Not eligible') + '</span>' : '') + '</div></button>';
      };
      host.innerHTML = '<div class="gh-head"><div><div class="gh-kicker">Showroom</div><h1 class="gh-h1">Buy a <em>car</em></h1><p class="gh-sub">Career prices are 35% of list. Exotic parts unlock as you level up — locked parts must be swapped before you can buy.' +
        (champ ? ' Showing eligibility for <b>' + esc(champ.name) + '</b>.' : '') + '</p></div><div class="gh-btns"><span class="gh-chip gold">Balance ' + esc(fmtCredits(bal)) + '</span>' +
        '<button class="gh-btn primary" data-nav data-act="custom" data-autofocus>' + icon('wrench', 14) + ' Commission a custom build</button></div></div>' +
        (atelier ? '<h2 class="gh-h2">From your Garage</h2><div class="gh-grid auto" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">' + card(atelier, buildName(atelier, 'Garage build'), (modelName(atelier) ? modelName(atelier) + ' · your current Garage build' : 'Your current Garage build'), 'atelier', 'buyAtelier') + '</div>' : '') +
(clubs.length ? '<h2 class="gh-h2">Club spec · ready to race</h2><p class="gh-sub" style="margin-top:-6px">Icons rebuilt with the parts you have unlocked — eligible for career purchase today.</p><div class="gh-grid auto" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">' + clubs.map(function (x) { return card(x.build, x.name, x.changes + ' parts swapped for unlocked equivalents', x.id, 'buyClub'); }).join('') + '</div>' : '') +
        '<h2 class="gh-h2">Redline icons</h2>' + (ps.length ? '<div class="gh-grid auto" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">' + ps.map(function (x) { return card(x.build, x.name, x.tagline, x.id, 'buyPreset'); }).join('') + '</div>'
          : moduleMissing('Catalog', 'Preset cars come from js/data.js.'));
      onAct(host, {
        custom: function () { customBuy(); },
        buyAtelier: function () { buyFlow(atelier); },
        buyClub: function (d) { var x = clubs.filter(function (q) { return q.id === d.id; })[0]; if (x) buyFlow(x.build, { name: x.name }); },
        buyPreset: function (d) { var x = ps.filter(function (q) { return q.id === d.id; })[0]; if (x) buyFlow(x.build, { name: x.name }); }
      });
    }
  });

  /* ======================================================================
     Screen: workshop (in-hub upgrade shop; used when the Atelier is absent)
     ====================================================================== */
  var WS_GROUPS = [
    { title: 'Engine', items: [{ path: 'engine.tune', label: 'ECU tune' }, { path: 'engine.aspiration', label: 'Aspiration', ice: true }, { path: 'engine.exhaust', label: 'Exhaust', ice: true }, { path: 'engine.cooling', label: 'Cooling' }] },
    { title: 'Drivetrain', items: [{ path: 'transmission.type', label: 'Transmission' }, { path: 'drivetrain.rearDiff', label: 'Rear differential' }] },
    { title: 'Chassis', items: [{ path: 'suspension.type', label: 'Suspension' }, { path: 'brakes.material', label: 'Brakes' }, { path: 'body.chassisMaterial', label: 'Chassis material' }, { path: 'weight.rollCage', label: 'Roll cage' }, { path: 'weight.glass', label: 'Glazing' }] },
    { title: 'Wheels & tyres', items: [{ path: 'tires.compound', label: 'Tyre compound' }, { path: 'wheels.material', label: 'Wheel material' }] },
    { title: 'Aerodynamics', items: [{ path: 'aero.splitter', label: 'Front splitter' }, { path: 'aero.wing', label: 'Rear wing' }, { path: 'aero.diffuser', label: 'Diffuser' }] }
  ];
  function setPath(o, path, v) {
    var parts = path.split('.');
    for (var i = 0; i < parts.length - 1; i++) { if (!isObj(o[parts[i]])) o[parts[i]] = {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = v;
  }
  function collectionFor(path) {
    var pc = (CB.data && CB.data.pathCollections) || {};
    return pc[path] || null;
  }
  function optionsFor(path) {
    var coll = collectionFor(path), D = CB.data;
    if (!coll || !D) return [];
    var l = typeof D.list === 'function' ? safe(function () { return D.list(coll); }, null) : null;
    if (!l) l = getPath(D, coll);
    return arr(l);
  }
  screen('workshop', {
    title: 'Workshop', live: true,
    crumb: function (p) { var c = carById(p.carId); return c ? 'Workshop · ' + c.name : 'Workshop'; },
    onLeave: function () { },
    render: function (host, params) {
      var car = carById(params.carId) || activeCar();
      if (!car) { host.innerHTML = needCarNotice(); onAct(host, { showroom: function () { show('showroom'); }, 'register-entry': registerEntry }); return; }
      if (!CB.data) { host.innerHTML = '<h1 class="gh-h1">Workshop</h1>' + moduleMissing('Catalog', 'Parts come from js/data.js.'); return; }
      H.ws = H.ws && H.ws.carId === car.id ? H.ws : { carId: car.id, draft: clone(car.build) };
      var draft = H.ws.draft, E = eco();
      var isEv = getPath(draft, 'engine.type') === 'ev';
      var q = upgradeQuote(car.build, draft, car), total = Math.round(num(q.total, 0));
      var m0 = metricsFor(car.build) || {}, m1 = metricsFor(draft) || {};
      var champ = params.champId ? champRaw(params.champId) : null;
      var elig = champ ? eligibility(career(), draft, champ) : null;
      var delta = function (a, b, unit, lowerBetter, dp) {
        var d = num(b, 0) - num(a, 0);
        var good = lowerBetter ? d < 0 : d > 0;
        var txt = (dp ? num(b, 0).toFixed(dp) : fmtInt(b)) + (unit ? ' ' + unit : '');
        // hide deltas that would display as zero at the shown precision (e.g. a −0.003 g change shown as "−0.00")
        var shown = dp ? Math.abs(d).toFixed(dp) : fmtInt(Math.abs(d));
        return txt + (Math.abs(d) > 1e-6 && Number(String(shown).replace(/[^0-9.]/g, '')) > 0 ? ' <small style="color:' + (good ? 'var(--gh-good)' : 'var(--gh-bad)') + '">' + (d > 0 ? '+' : '−') + (dp ? Math.abs(d).toFixed(dp) : fmtInt(Math.abs(d))) + '</small>' : '');
      };
      var groups = WS_GROUPS.map(function (g) {
        var items = g.items.filter(function (it) { return !(it.ice && isEv) && optionsFor(it.path).length; });
        if (!items.length) return '';
        return '<h2 class="gh-h2">' + esc(g.title) + '</h2>' + items.map(function (it) {
          var cur = getPath(draft, it.path), orig = getPath(car.build, it.path);
          return '<div class="gh-ws-group"><h4>' + esc(it.label) + '</h4><div class="gh-opts">' + optionsFor(it.path).map(function (o) {
            var locked = E && typeof E.isUnlocked === 'function' ? !safe(function () { return E.isUnlocked(P(), it.path, o.id); }, true) : false;
            var lvl = locked ? safe(function () { return E.partUnlockLevel(it.path, o.id); }, '?') : null;
            var cost = E && typeof E.partCost === 'function' ? safe(function () { return E.partCost(it.path, o.id); }, null) : null;
            return '<button class="gh-opt' + (String(o.id) === String(cur) ? ' is-sel' : '') + (String(o.id) === String(orig) ? ' is-orig' : '') + (locked ? ' is-locked' : '') + '" data-nav data-key="op-' + esc(it.path) + '-' + esc(o.id) + '" data-act="opt" data-p="' + esc(it.path) + '" data-v="' + esc(o.id) + '"' + (locked ? ' aria-disabled="true"' : '') + ' title="' + esc(o.desc || o.name) + '">' +
              '<b>' + esc(o.name || titleCase(o.id)) + '</b><small>' + (locked ? icon('lock', 10) + ' Level ' + lvl : isNum(cost) ? esc(fmtCredits(cost)) : '') + '</small></button>';
          }).join('') + '</div></div>';
        }).join('');
      }).join('');
      host.innerHTML = '<div class="gh-kicker">Workshop</div><h1 class="gh-h1">' + esc(car.name) + '</h1><p class="gh-sub">Swap components and see the invoice live. Removed parts are refunded at 50%; fitting and setup labour is charged per change.</p>' +
        '<div class="gh-ws"><div>' + groups + '</div><div><div style="position:sticky;top:10px;max-height:calc(100vh - 150px);max-height:calc(100dvh - 150px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin"><div class="gh-panel cut"><div>' + carArt(draft, { uid: 'ws' }) + '</div>' +
        '<dl class="gh-kv" style="margin-top:10px"><dt>Power</dt><dd>' + delta(m0.power_hp, m1.power_hp, 'hp') + '</dd><dt>Weight</dt><dd>' + delta(m0.weight_kg, m1.weight_kg, 'kg', true) + '</dd>' +
        '<dt>0–60 mph</dt><dd>' + delta(m0.zeroTo60_s, m1.zeroTo60_s, 's', true, 1) + '</dd><dt>Top speed</dt><dd>' + delta(m0.topSpeed_kph, m1.topSpeed_kph, 'km/h') + '</dd>' +
        '<dt>Lateral grip</dt><dd>' + delta(m0.lateralG, m1.lateralG, 'g', false, 2) + '</dd><dt>Performance index</dt><dd>' + delta(performanceIndex(m0), performanceIndex(m1)) + '</dd></dl>' +
        (elig ? carEligibilityHTML(elig) : '') +
        '<ul class="gh-breakdown">' + arr(q.lines).slice(0, 10).map(function (l) { var v = isNum(l.net) ? l.net : num(l.cost, 0) - num(l.refund, 0); return '<li class="in"><span>' + esc(l.label) + '</span><span class="c">' + (v < 0 ? '+' + esc(fmtCredits(-v)) : esc(fmtCredits(v))) + '</span></li>'; }).join('') + '</ul>' +
        '<div style="display:flex;justify-content:space-between;margin-top:12px;font-weight:800"><span>' + (total >= 0 ? 'Total' : 'Net refund') + '</span><span class="gh-num" style="color:var(--gh-accent2)">' + esc(fmtCredits(Math.abs(total))) + '</span></div>' +
        '<div class="gh-btns" style="margin-top:14px"><button class="gh-btn primary" data-nav data-act="confirm"' + (q.changes ? '' : ' disabled') + '>Confirm purchase</button><button class="gh-btn ghost" data-nav data-act="reset"' + (q.changes ? '' : ' disabled') + '>Reset</button>' +
        (appMod() ? '<button class="gh-btn" data-nav data-act="atelier">Full Garage</button>' : '') + '</div></div></div></div></div>';
      onAct(host, {
        opt: function (d, el) {
          if (el.classList.contains('is-locked')) { sfx('error'); toast(icon('lock', 14) + ' Unlocks at a higher driver level', 'warn'); return; }
          var nb = clone(draft); setPath(nb, d.p, d.v); H.ws.draft = normalizeBuild(nb); refresh();
        },
        reset: function () { H.ws.draft = clone(car.build); refresh(); },
        confirm: function () { var target = H.ws.draft; confirmUpgrade(car.id, target); },
        atelier: function () { upgradeFlow(car.id); }
      });
    }
  });

  /* ======================================================================
     Screen: achievements
     ====================================================================== */
  function ringSVG(p, label, sub) {
    var r = 54, c = 2 * Math.PI * r;
    return '<svg viewBox="0 0 130 130" aria-hidden="true"><circle cx="65" cy="65" r="' + r + '" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="10"/>' +
      '<circle cx="65" cy="65" r="' + r + '" fill="none" stroke="var(--gh-accent)" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + (c * clamp(p, 0, 1)).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 65 65)"/>' +
      '<text x="65" y="66" text-anchor="middle" font-family="SF Mono,Menlo,monospace" font-size="24" font-weight="800" fill="#f2eee6">' + esc(label) + '</text>' +
      '<text x="65" y="86" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="10" letter-spacing="2" fill="#9b978d">' + esc(sub) + '</text></svg>';
  }
  var TIER_COLORS = { bronze: '#c27a43', silver: '#c6ccd4', gold: '#f0c246', platinum: '#a9dcea' };
  screen('achievements', {
    title: 'Achievements', live: true, tabs: true,
    render: function (host, params) {
      var A = achv();
      if (!A) { host.innerHTML = '<div class="gh-kicker">Achievements</div><h1 class="gh-h1">Achievements</h1>' + moduleMissing('Achievements'); return; }
      var sum = safe(function () { return A.summary(); }, null) || { unlocked: 0, total: 0, pct: 0, byTier: {}, byCategory: {}, recent: [] };
      var cats = arr(A.categories);
      var tab = params.tab || 'all', filter = params.filter || 'all';
      var list = arr(A.list).filter(function (a) { return tab === 'all' || a.category === tab; });
      var rows = list.map(function (a) {
        var un = !!safe(function () { return A.isUnlocked(null, a.id); }, false);
        var pr = un ? null : safe(function () { return A.progress(null, a.id); }, null);
        return { a: a, un: un, pr: pr };
      }).filter(function (r) { return filter === 'all' || (filter === 'unlocked' ? r.un : !r.un); });
      rows.sort(function (x, y) { return (y.un - x.un) || (num(y.pr && y.pr.pct, 0) - num(x.pr && x.pr.pct, 0)); });
      host.innerHTML = '<div class="gh-head"><div><div class="gh-kicker">Achievements</div><h1 class="gh-h1">Medals &amp; <em>milestones</em></h1><p class="gh-sub">Every achievement pays XP and credits. Hidden ones reveal themselves when you earn them.</p></div>' +
        '<div class="gh-ring">' + ringSVG(sum.pct, Math.round(sum.pct * 100) + '%', sum.unlocked + ' / ' + sum.total) +
        '<div>' + ['bronze', 'silver', 'gold', 'platinum'].map(function (t) { var b = sum.byTier[t] || { unlocked: 0, total: 0 }; return '<div style="display:flex;gap:10px;align-items:center;font-size:12px;margin:4px 0"><i style="width:10px;height:10px;border-radius:50%;background:' + TIER_COLORS[t] + '"></i><span style="width:70px">' + titleCase(t) + '</span><b class="gh-num">' + b.unlocked + ' / ' + b.total + '</b></div>'; }).join('') +
        '<div class="gh-btns" style="margin-top:10px"><button class="gh-btn small" data-nav data-act="gallery">Open gallery</button></div></div></div></div>' +
        tabsHTML([{ id: 'all', name: 'All', count: arr(A.list).length }].concat(cats.map(function (c) { var b = sum.byCategory[c.id] || {}; return { id: c.id, name: c.name, count: b.total != null ? b.unlocked + '/' + b.total : null }; })), tab).replace('class="gh-tabs"', 'class="gh-tabs gh-tabs-wrap"') +
        '<div style="margin-bottom:14px">' + segHTML('filter', filter, [{ id: 'all', name: 'All' }, { id: 'unlocked', name: 'Unlocked' }, { id: 'locked', name: 'In progress' }]) + '</div>' +
        (rows.length ? '<div class="gh-grid c2">' + rows.map(function (r) {
          var a = r.a, hidden = a.hidden && !r.un;
          var cur = r.pr ? num(r.pr.cur, 0) : 0, max = r.pr ? num(r.pr.max, 0) : 0;
          return '<div class="gh-ach' + (r.un ? '' : ' is-locked') + '" data-nav data-key="ac-' + esc(a.id) + '" tabindex="0">' +
            '<div class="ic">' + (hidden ? icon('lock', 40) : (a.icon || icon('star', 40))) + '</div><div style="flex:1;min-width:0"><h4>' + esc(hidden ? 'Hidden achievement' : a.name) +
            ' <span class="gh-chip" style="color:' + (TIER_COLORS[a.tier] || '#999') + '">' + esc(a.tier || '') + '</span></h4><p>' + esc(hidden ? (a.hint || 'Keep playing to discover this one.') : a.desc) + '</p>' +
            (r.un ? '<small style="color:var(--gh-good)">' + icon('check', 12) + ' Unlocked' + (getPath(P(), 'achievements.' + a.id + '.unlockedAt') ? ' · ' + fmtDate(getPath(P(), 'achievements.' + a.id + '.unlockedAt')) : '') + '</small>'
              : max > 1 ? '<div class="gh-cond-row" style="margin:0"><div class="gh-bar"><i style="width:' + (clamp(cur / max, 0, 1) * 100).toFixed(1) + '%"></i></div><span class="gh-num">' + fmtCompact(cur) + ' / ' + fmtCompact(max) + '</span></div>' : '') +
            '<div style="display:flex;gap:6px;margin-top:8px">' + (a.xp ? '<span class="gh-chip">+' + fmtInt(a.xp) + ' XP</span>' : '') + (a.credits ? '<span class="gh-chip">+' + esc(fmtCredits(a.credits)) + '</span>' : '') + '</div></div></div>';
        }).join('') + '</div>' : '<div class="gh-empty"><b>Nothing here</b>Try another filter.</div>');
      onAct(host, {
        tab: function (d) { setParam('tab', d.tab); renderScreen(false); },
        seg: function (d) { setParam('filter', d.v); renderScreen(true); },
        gallery: function () {
          var tok = { key: routeKey() };
          var g = safe(function () { return A.openGallery({ onClose: function () { if (H && H.gallery === tok) H.gallery = null; } }); }, null);
          if (g && H) H.gallery = tok;
        }
      });
    }
  });

  /* ======================================================================
     Screen: replays
     ====================================================================== */
  function watchReplay(id) {
    var R = rep();
    if (!R) { toast('Replay module unavailable', 'bad'); return false; }
    var target = id ? (call(R, ['load'], [id], null) || id) : call(R, ['last'], [], null);
    if (!target) { toast('No replay available', 'warn'); return false; }
    var tok = { key: routeKey() };
    var restore = function () { if (H && H.overlay === tok) { H.overlay = null; H.root.style.display = ''; refresh(); } };
    if (H) { H.overlay = tok; H.root.style.display = 'none'; }
    var ok = safe(function () { R.openUI(target, { onClose: restore, units: setting('units', 'kph') }); return true; }, false);
    if (!ok) { restore(); toast('Could not open the replay', 'bad'); }
    return ok;
  }
  function downloadText(name, text, type) {
    try {
      var blob = new Blob([text], { type: type || 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      return true;
    } catch (e) { return false; }
  }
  screen('replays', {
    title: 'Replays', live: true,
    render: function (host) {
      var R = rep();
      if (!R) { host.innerHTML = '<div class="gh-kicker">Replays</div><h1 class="gh-h1">Replays</h1>' + moduleMissing('Replay'); return; }
      var list = replayList(), usage = R.store && R.store.usage ? safe(function () { return R.store.usage(); }, null) : null;
      var last = call(R, ['last'], [], null);
      host.innerHTML = '<div class="gh-head"><div><div class="gh-kicker">Replays &amp; photo mode</div><h1 class="gh-h1">Relive the <em>race</em></h1><p class="gh-sub">The last ' + (R.MAX_STORED || 5) + ' saved replays are kept on this device. Pin your favourites, export them to share, or open photo mode to frame the perfect shot.</p></div>' +
        '<div class="gh-btns">' + (usage ? '<span class="gh-chip">' + usage.count + ' / ' + usage.max + ' · ' + pct(usage.chars / Math.max(1, usage.cap)) + ' storage</span>' : '') +
        (last ? '<button class="gh-btn primary" data-nav data-act="last" data-autofocus>' + icon('play', 14) + ' Last race</button>' : '') +
        '<button class="gh-btn" data-nav data-act="library">Library &amp; import</button></div></div>' +
        (list.length ? '<div class="gh-grid auto" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">' + list.map(function (r, i) {
          return '<div class="gh-card" style="cursor:default"><div class="gh-art" style="height:110px;margin:-18px -18px 12px;display:grid;place-items:center;background:#0c0d10;color:rgba(255,255,255,.75)">' + (r.trackId ? trackPreviewSVG(r.trackId, 180, 96, { width: 6 }) : icon('film', 40)) + '</div>' +
            '<div style="display:flex;justify-content:space-between;gap:8px"><h3>' + esc(r.name || r.trackName || trackName(r.trackId, true)) + '</h3>' + (r.pinned ? '<span class="gh-chip gold">Pinned</span>' : '') + '</div>' +
            '<p>' + esc([titleCase(r.mode), r.laps ? r.laps + ' laps' : null, r.cars ? r.cars + ' cars' : null, r.duration ? fmtDuration(r.duration) : null].filter(Boolean).join(' · ')) + '</p>' +
            '<p style="margin-top:4px">' + (r.position ? 'Finished ' + ordinal(r.position) + ' · ' : '') + (r.bestLap ? 'Best ' + fmtTime(r.bestLap) + ' · ' : '') + (r.createdAt ? fmtDate(r.createdAt) : '') + '</p>' +
            '<div class="gh-btns" style="margin-top:12px"><button class="gh-btn small primary" data-nav data-act="watch" data-id="' + esc(r.id) + '"' + (!last && i === 0 ? ' data-autofocus' : '') + '>' + icon('play', 12) + ' Watch</button>' +
            '<button class="gh-btn small" data-nav data-act="pin" data-id="' + esc(r.id) + '">' + (r.pinned ? 'Unpin' : 'Pin') + '</button>' +
            '<button class="gh-btn small" data-nav data-act="export" data-id="' + esc(r.id) + '">' + icon('download', 12) + '</button>' +
            '<button class="gh-btn small danger" data-nav data-act="del" data-id="' + esc(r.id) + '">' + icon('trash', 12) + '</button></div></div>';
        }).join('') + '</div>' : '<div class="gh-empty"><b>No saved replays</b>Finish a race, press “Watch replay” on the results screen, then “Save” to keep it here.</div>');
      onAct(host, {
        last: function () { watchReplay(null); },
        watch: function (d) { watchReplay(d.id); },
        library: function () {
          var tok = { key: routeKey() };
          if (H) { H.overlay = tok; H.root.style.display = 'none'; }
          var ok = safe(function () { R.openBrowser({ onClose: function () { if (H && H.overlay === tok) { H.overlay = null; H.root.style.display = ''; refresh(); } } }); return true; }, false);
          if (!ok && H) { if (H.overlay === tok) H.overlay = null; H.root.style.display = ''; }
        },
        pin: function (d) { call(R.store, ['pin'], [d.id]); refresh(); },
        export: function (d) {
          var s = call(R.store, ['exportString'], [d.id], null);
          if (!s) { toast('Export failed', 'bad'); return; }
          if (downloadText('redline-replay-' + d.id + '.redlinereplay', s)) toast('Replay exported', 'good');
          else if (navigator.clipboard) navigator.clipboard.writeText(s).then(function () { toast('Replay copied to clipboard', 'good'); });
        },
        del: function (d) { confirmBox('Delete replay?', 'This cannot be undone.', 'Delete', function () { call(R, ['remove'], [d.id]); toast('Replay deleted', 'warn'); refresh(); }, { danger: true }); }
      });
    }
  });

  /* ======================================================================
     Screen: profile & stats dashboard
     ====================================================================== */
  var AVATAR_COLORS = ['#c8a96a', '#d94f3d', '#3d7fd9', '#3dbf8a', '#9b5de5', '#f2a541', '#e8e8e8', '#2b2d42'];
  function chartCard(id, title, sub, height, wide) {
    return '<div class="gh-panel"' + (wide ? ' style="grid-column:1/-1"' : '') + '><div class="gh-chart-title"><h3>' + esc(title) + '</h3><small>' + esc(sub || '') + '</small></div><div class="gh-chart" data-chart="' + id + '" style="height:' + (height || 220) + 'px"></div></div>';
  }
  screen('profile', {
    title: 'Profile & stats', live: true,
    render: function (host) {
      var p = P(), pm = prof(), st = p.stats || {}, units = setting('units', 'kph'), li = levelInfo();
      var ss = pm && typeof pm.statsSummary === 'function' ? safe(function () { return pm.statsSummary(); }, null) : null;
      ss = ss || { races: st.races || 0, wins: st.wins || 0, podiums: st.podiums || 0, winRate: st.races ? Math.round(st.wins / st.races * 1000) / 10 : 0, podiumRate: st.races ? Math.round(st.podiums / st.races * 1000) / 10 : 0, avgFinish: null, crashesPerRace: 0, favoriteTrack: null };
      var hist = arr(st.history);
      var ledger = pm && pm.ledger ? safe(function () { return pm.ledger; }, p.ledger) : p.ledger;
      var lsum = pm && typeof pm.ledgerSummary === 'function' ? safe(function () { return pm.ledgerSummary(); }, null) : null;
      var cstats = getPath(p, 'career.stats') || {};
      var tile = function (label, value, sub) { return '<div class="gh-tile"><small>' + esc(label) + '</small><b>' + value + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</div>'; };
      host.innerHTML = '<div class="gh-head"><div><div class="gh-kicker">Profile</div><h1 class="gh-h1">' + esc(p.driverName || 'Driver') + '</h1><p class="gh-sub">Level ' + li.level + ' · ' + esc(levelTitle(li.level)) + ' · racing since ' + fmtDate(p.createdAt) + '</p></div>' +
        '<div class="gh-panel" style="min-width:340px"><div class="gh-row" style="padding:0;background:none;min-height:0;border:0"><div class="lbl"><b>Driver name</b></div><input class="gh-input" data-nav data-key="name" maxlength="24" aria-label="Driver name" autocomplete="nickname" value="' + esc(p.driverName || '') + '"></div>' +
        '<div class="gh-colors" style="margin-top:12px">' + AVATAR_COLORS.map(function (c) { return '<button class="gh-color' + (String(p.avatarColor).toLowerCase() === c ? ' is-on' : '') + '" style="background:' + c + '" data-nav data-key="col-' + c + '" data-act="color" data-c="' + c + '" aria-label="Avatar colour ' + c + '"></button>'; }).join('') + '</div>' +
        '<div class="gh-bar" style="margin-top:14px"><i style="width:' + (li.progress * 100).toFixed(1) + '%"></i></div><small style="color:var(--gh-dim)">' + fmtInt(p.xp) + ' XP · ' + (li.maxed ? 'max level' : fmtInt(li.remaining) + ' to level ' + (li.level + 1)) + '</small></div></div>' +
        '<div class="gh-tiles">' +
        tile('Races', fmtInt(ss.races), (st.timeTrials ? fmtInt(st.timeTrials) + (st.timeTrials === 1 ? ' time trial' : ' time trials') : '')) +
        tile('Wins', fmtInt(ss.wins), ss.winRate + '% win rate') +
        tile('Podiums', fmtInt(ss.podiums), ss.podiumRate + '% podium rate') +
        tile('Poles · FL', fmtInt(st.poles) + ' · ' + fmtInt(st.fastestLaps), 'pole positions · fastest laps') +
        tile('Avg finish', ss.avgFinish != null ? ss.avgFinish.toFixed(1) : '—', ss.longestWinStreak ? 'best streak ' + ss.longestWinStreak + ' wins' : '') +
        tile('Distance', esc(fmtDist(st.distance_km, units)), st.timeDriven_s ? fmtDuration(st.timeDriven_s) + ' driven' : '') +
        tile('Top speed', esc(fmtSpeed(st.topSpeed_kph, units)), '') +
        tile('Contacts', fmtInt(st.crashes), (ss.crashesPerRace || 0) + ' per race') +
        tile('Credits earned', esc(fmtCompact(st.creditsEarned)), lsum ? 'spent ' + fmtCompact(lsum.spent) : '') +
        tile('Drift best', fmtInt(st.driftScoreBest), 'points') +
        tile('Titles', fmtInt(cstats.titles), fmtInt(cstats.rounds) + ' career rounds') +
        tile('Career cars', fmtInt((p.ownedCars || []).length), ss.favoriteTrack ? 'favourite: ' + esc(trackName(ss.favoriteTrack, true)) : '') + '</div>' +
        '<div class="gh-grid c2" style="margin-top:16px">' +
        chartCard('form', 'Recent form', 'Finishing position, last 20 races (P1 at top)', 230) +
        chartCard('results', 'Results breakdown', 'All races', 230) +
        chartCard('balance', 'Credit balance', 'From the transaction ledger', 230, true) +
        chartCard('tracks', 'Circuits', 'Races per circuit', 230) +
        chartCard('earn', 'Earnings by source', 'Credits earned per category', 230) + '</div>' +
        '<h2 class="gh-h2">Recent transactions</h2><div class="gh-panel" style="padding:6px">' + (arr(ledger).length ? '<table class="gh-table"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th class="n">Amount</th><th class="n">Balance</th></tr></thead><tbody>' +
          arr(ledger).slice(-12).reverse().map(function (e) { return '<tr><td style="color:var(--gh-dim)">' + fmtDate(e.t) + '</td><td>' + esc(e.reason) + '</td><td style="color:var(--gh-dim)">' + esc(titleCase(e.category || '')) + '</td><td class="n" style="color:' + (e.amount >= 0 ? 'var(--gh-good)' : 'var(--gh-bad)') + '">' + (e.amount >= 0 ? '+' : '−') + esc(fmtCredits(Math.abs(e.amount))) + '</td><td class="n">' + (isNum(e.balance) ? esc(fmtCredits(e.balance)) : '—') + '</td></tr>'; }).join('') + '</tbody></table>' : '<div class="gh-empty"><b>No transactions yet</b></div>') + '</div>';
      // charts
      var form = formSeries(hist, 20);
      var maxField = Math.max(4, Math.max.apply(null, form.map(function (f) { return f.field || 0; }).concat([4])));
      miniChart(host.querySelector('[data-chart="form"]'), {
        type: 'line', invertY: true, yMin: 1, yMax: maxField, yStep: maxField > 10 ? 2 : 1, yFmt: function (v) { return 'P' + Math.round(v); }, empty: 'Race to build your form guide',
        points: form.map(function (f, i) { return { y: f.position, highlight: f.position === 1, label: trackName(f.trackId, true), tip: '<b>' + (f.dnf ? 'DNF' : 'P' + f.position) + '</b> / ' + f.field + ' · ' + esc(trackName(f.trackId, true)) + (f.t ? '<br><small>' + fmtDate(f.t) + '</small>' : '') }; }),
        xLabel: function (p0, i) { return String(i + 1); }
      });
      var buckets = resultBuckets(hist);
      miniChart(host.querySelector('[data-chart="results"]'), {
        type: 'bars', valueLabels: true, integer: true, yFmt: function (v) { return fmtInt(v); }, empty: 'No races yet',
        points: buckets.some(function (b) { return b.value; }) ? buckets.map(function (b) { return { y: b.value, label: b.label.split(' (')[0], tip: '<b>' + b.value + '</b> ' + esc(b.label) }; }) : []
      });
      var bal = balanceSeries(ledger, p.credits);
      miniChart(host.querySelector('[data-chart="balance"]'), {
        type: 'area', yFmt: function (v) { return fmtCompact(v); }, markers: bal.length <= 40, lastLabel: fmtCredits(p.credits),
        points: bal.map(function (b) { return { y: b.balance, label: b.reason || '', tip: '<b>' + esc(fmtCredits(b.balance)) + '</b>' + (b.amount != null ? ' (' + (b.amount >= 0 ? '+' : '−') + esc(fmtCredits(Math.abs(b.amount))) + ')' : '') + (b.reason ? '<br><small>' + esc(b.reason) + '</small>' : '') + '<br><small>' + fmtDate(b.t) + '</small>' }; }),
        xLabel: function (b) { return ''; }
      });
      var tu = trackUsage(st.tracks).slice(0, 7);
      miniChart(host.querySelector('[data-chart="tracks"]'), {
        type: 'hbars', labelWidth: 110, empty: 'No circuits raced yet',
        points: tu.map(function (t) { return { y: t.races, label: t.name, valueLabel: t.races + (t.wins ? ' · ' + t.wins + 'W' : ''), tip: '<b>' + t.races + '</b> races · ' + t.wins + ' wins' + (t.bestLap_s ? '<br>Best lap ' + fmtTime(t.bestLap_s) : '') }; })
      });
      var cats = lsum ? Object.keys(lsum.byCategory).map(function (k) { return { k: k, v: lsum.byCategory[k].earned }; }).filter(function (x) { return x.v > 0; }).sort(function (a, b) { return b.v - a.v; }).slice(0, 7) : [];
      miniChart(host.querySelector('[data-chart="earn"]'), {
        type: 'hbars', labelWidth: 110, empty: 'Earn credits by racing', yFmt: function (v) { return fmtCompact(v); },
        points: cats.map(function (c) { return { y: c.v, label: titleCase(c.k), tip: '<b>' + esc(fmtCredits(c.v)) + '</b> ' + esc(titleCase(c.k)) }; })
      });
      var nameInput = host.querySelector('input[data-key="name"]');
      nameInput.addEventListener('change', function () {
        var v = nameInput.value.trim().slice(0, 24);
        if (!v) return;
        if (pm && typeof pm.setDriver === 'function') pm.setDriver(v, null); else { fallbackProfile().driverName = v; emitLocal(); }
        toast('Driver name saved', 'good');
      });
      onAct(host, {
        color: function (d) { if (pm && typeof pm.setDriver === 'function') pm.setDriver(null, d.c); else { fallbackProfile().avatarColor = d.c; emitLocal(); } }
      });
    }
  });

  /* ======================================================================
     Screen: settings (incl. control rebinding)
     ====================================================================== */
  var FALLBACK_ACTIONS = [
    { id: 'throttle', label: 'Throttle', group: 'Driving' }, { id: 'brake', label: 'Brake / Reverse', group: 'Driving' },
    { id: 'steerLeft', label: 'Steer left', group: 'Driving' }, { id: 'steerRight', label: 'Steer right', group: 'Driving' },
    { id: 'handbrake', label: 'Handbrake', group: 'Driving' }, { id: 'shiftUp', label: 'Shift up', group: 'Gearbox' },
    { id: 'shiftDown', label: 'Shift down', group: 'Gearbox' }, { id: 'camera', label: 'Cycle camera', group: 'View' },
    { id: 'pause', label: 'Pause', group: 'Session' }, { id: 'reset', label: 'Reset to track', group: 'Session' }
  ];
  var PAD_ACTIONS = [
    { id: 'steer', label: 'Steering (axis)' }, { id: 'throttle', label: 'Throttle' }, { id: 'brake', label: 'Brake' }, { id: 'handbrake', label: 'Handbrake' },
    { id: 'shiftUp', label: 'Shift up' }, { id: 'shiftDown', label: 'Shift down' }, { id: 'camera', label: 'Camera' }, { id: 'lookBack', label: 'Look back' },
    { id: 'pause', label: 'Pause' }, { id: 'reset', label: 'Reset' }, { id: 'pit', label: 'Pit request' }
  ];
  function keyLabel(code) {
    var pm = prof();
    if (pm && typeof pm.keyLabel === 'function') return pm.keyLabel(code);
    if (!code) return '—';
    var m = /^Key([A-Z])$/.exec(code) || /^Digit(\d)$/.exec(code);
    return m ? m[1] : code;
  }
  function startCapture(o) {
    if (!H) return;
    var ov = div('gh-capture', '<div><b>' + esc(o.title) + '</b>' + esc(o.prompt) + '<br><small style="color:var(--gh-dim)">' + esc(o.hint || 'Esc to cancel') + '</small></div>');
    H.root.appendChild(ov);
    var done = function () { H.capture = null; if (ov.parentNode) ov.parentNode.removeChild(ov); };
    var base = null;
    H.capture = {
      onKey: function (e) {
        e.preventDefault(); e.stopPropagation();
        if (!o.keyboard) { if (e.key === 'Escape') { done(); sfx('back'); } return; }
        if (e.repeat) return;
        if (e.code === 'Escape') { done(); sfx('back'); return; }
        done();
        if (e.code === 'Backspace' || e.code === 'Delete') o.onClear && o.onClear(); else o.onCode(e.code);
      },
      onPad: function (gp) {
        if (!o.pad) return;
        var btns = gp.buttons.map(function (b) { return !!(b && (b.pressed || b.value > 0.5)); });
        var axes = (gp.axes || []).slice();
        if (!base) { base = { btns: btns, axes: axes }; return; }
        for (var i = 0; i < btns.length; i++) if (btns[i] && !base.btns[i]) { done(); o.onCode('button' + i); return; }
        for (var a = 0; a < axes.length; a++) {
          if (Math.abs(axes[a]) > 0.6 && Math.abs(num(base.axes[a], 0)) < 0.3) { done(); o.onCode(o.axisPlain ? 'axis' + a : 'axis' + a + (axes[a] > 0 ? '+' : '-')); return; }
        }
        base.btns = btns.map(function (b, k) { return b && base.btns[k]; });
      }
    };
    ov.addEventListener('click', function () { done(); });
  }
  function appTheme() {
    if (CB.app && typeof CB.app.theme === 'function') return safe(function () { return CB.app.theme(); }, 'dark') === 'light' ? 'light' : 'dark';
    return hasDOM && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }
  function setAppTheme(t) {
    t = t === 'light' ? 'light' : 'dark';
    if (CB.app && typeof CB.app.setTheme === 'function') { safe(function () { CB.app.setTheme(t); }); return; }
    if (hasDOM) document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('forge.theme.v1', JSON.stringify(t)); } catch (e) { /* ignore */ }   // app.js reads it with JSON.parse
  }
  function saveSetting(path, value, silentRerender) {
    setSetting(path, value);
    if (path === 'ui.reducedMotion' && H) H.root.classList.toggle('reduced', !!value);
    if (!silentRerender) renderScreen(true);
  }
  screen('settings', {
    title: 'Settings', live: true, tabs: true,
    render: function (host, params) {
      var pm = prof(), tab = params.tab || 'general', rs = raceStore();
      var s = function (path, d) { return setting(path, d); };
      var range = function (path, min, max, stp, fmt, d) {
        var v = num(s(path, d), d), pctv = ((v - min) / (max - min) * 100).toFixed(1);
        return '<input type="range" class="gh-range" data-nav data-key="rg-' + path + '" data-path="' + path + '" min="' + min + '" max="' + max + '" step="' + stp + '" value="' + v + '" style="--v:' + pctv + '%" data-fmt="' + (fmt || 'pct') + '"><span class="gh-rv">' + (fmt === 'x' ? v.toFixed(2) + '×' : fmt === 'raw' ? v.toFixed(2) : Math.round(v * 100) + '%') + '</span>';
      };
      var sw = function (path, d, label) { return switchHTML(path, !!s(path, d), label); };
      var seg = function (path, d, opts) { return segHTML(path, s(path, d), opts); };
      var body = '';
      if (tab === 'general') {
        body = rowHTML('Units', 'Speed and distance display', seg('units', 'kph', [{ id: 'kph', name: 'km/h · km' }, { id: 'mph', name: 'mph · mi' }])) +
          rowHTML('Difficulty', 'Default AI level for quick races (career sets its own)', seg('difficulty', 'amateur', DIFFS)) +
          rowHTML('Appearance', 'Light or dark theme for every screen (T in the Garage)', segHTML('app.theme', appTheme(), [{ id: 'dark', name: 'Dark' }, { id: 'light', name: 'Light' }])) +
          rowHTML('Race camera', 'Starting camera for 3D races · C cycles while driving', segHTML('race.camera3d', rs.camera3d, raceOpts('CAMERAS_3D', RACE_CAMS_FB))) +
          rowHTML('Drift camera', 'Starting camera for 3D drift sessions', segHTML('race.driftCamera3d', rs.driftCamera3d, raceOpts('CAMERAS_3D', RACE_CAMS_FB))) +
          rowHTML('Reduced motion', 'Minimise menu animation', sw('ui.reducedMotion', false, 'Reduced motion')) +
          rowHTML('Tutorial hints', 'Contextual tips in the hub and races', sw('ui.showTutorialHints', true, 'Hints')) +
          rowHTML('Confirm purchases', 'Ask before spending credits', sw('ui.confirmPurchases', true, 'Confirm purchases'));
      } else if (tab === 'driving') {
        body = '<h2 class="gh-h2" style="margin-top:0">Assists</h2>' +
          rowHTML('ABS', 'Prevents wheel lock under braking', sw('assists.abs', true, 'ABS')) +
          rowHTML('Traction control', 'Limits wheelspin on throttle', sw('assists.tc', true, 'Traction control')) +
          rowHTML('Stability control', 'Catches slides before they become spins', sw('assists.stabilityControl', true, 'Stability control')) +
          rowHTML('Automatic gearbox', 'Shifts for you at the ideal rpm', sw('assists.autoShift', true, 'Auto shift')) +
          rowHTML('Racing line', 'Coloured braking guide on track', sw('assists.racingLine', false, 'Racing line')) +
          rowHTML('Race steering assist', 'How much the car helps you steer in races — Light (default): you drive and slides are caught; Heavy makes arrow keys alone enough; Auto drives the line for you',
            segHTML('steerAssist.race', steerAssistLevel('race'), raceOpts('STEER_ASSISTS', STEER_FB))) +
          rowHTML('Drift steering assist', 'How much the car helps you drift — Heavy (default): arrow keys are enough, counter-steer and angle hold are automatic; Light / Off: you hold the angle, the keyboard steering still self-aligns',
            segHTML('steerAssist.drift', steerAssistLevel('drift'), raceOpts('STEER_ASSISTS', STEER_FB))) +
          '<h2 class="gh-h2">Race defaults</h2>' +
          rowHTML('Default laps', '', stepperHTML('gameplay.defaultLaps', num(s('gameplay.defaultLaps', 3), 3), 1, 50)) +
          rowHTML('Default opponents', '', stepperHTML('gameplay.defaultOpponents', num(s('gameplay.defaultOpponents', 7), 7), 1, 11)) +
          rowHTML('Damage', 'Collisions affect performance', sw('gameplay.damage', true, 'Damage')) +
          rowHTML('Ghost car', 'Show your best lap in time trials', sw('gameplay.ghost', true, 'Ghost')) +
          '<h2 class="gh-h2">Steering</h2>' +
          rowHTML('Sensitivity', 'Keyboard and stick steering rate', range('controls.steerSensitivity', 0.4, 2, 0.05, 'x', 1)) +
          rowHTML('Self-centring', 'How fast the wheel returns', range('controls.steerReturn', 0.4, 2, 0.05, 'x', 1)) +
          rowHTML('Invert steering', '', sw('controls.invertSteer', false, 'Invert steering')) +
          (CB.input && CB.input.ui && typeof CB.input.ui.settingsHTML === 'function' ? safe(function () { return CB.input.ui.settingsHTML(); }) || '' : '');
      } else if (tab === 'audio') {
        body = rowHTML('Mute all', '', sw('audio.muted', false, 'Mute')) +
          rowHTML('Master volume', '', range('audio.master', 0, 1, 0.05, 'pct', 0.8)) +
          rowHTML('Engine', 'Engine, turbo and exhaust', range('audio.engine', 0, 1, 0.05, 'pct', 0.9)) +
          rowHTML('Effects', 'Tyres, impacts and menu sounds', range('audio.sfx', 0, 1, 0.05, 'pct', 0.8)) +
          rowHTML('Music', '', range('audio.music', 0, 1, 0.05, 'pct', 0.5));
      } else if (tab === 'controls') {
        var actions = (pm && Array.isArray(pm.ACTIONS)) ? pm.ACTIONS : FALLBACK_ACTIONS;
        var binds = s('controls.bindings', {}) || {};
        var pad = s('controls.gamepad.bindings', {}) || {};
        var lastGroup = null;
        body = '<h2 class="gh-h2" style="margin-top:0">Keyboard</h2><p class="gh-sub" style="margin-top:-6px">Select a slot and press a key. Backspace clears the slot. A key already in use moves to the new action.</p>' +
          actions.map(function (a) {
            var codes = arr(binds[a.id]);
            var head = a.group && a.group !== lastGroup ? '<div style="margin:16px 0 6px;font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--gh-accent)">' + esc(a.group) + '</div>' : '';
            lastGroup = a.group;
            return head + rowHTML(a.label, '', '<div class="gh-keys">' + [0, 1, 2].map(function (slot) {
              var c = codes[slot];
              return '<button class="gh-key' + (c ? '' : ' empty') + '" data-nav data-key="kb-' + a.id + '-' + slot + '" data-act="bind" data-a="' + a.id + '" data-slot="' + slot + '" data-code="' + esc(c || '') + '">' + esc(c ? keyLabel(c) : '+') + '</button>';
            }).join('') + '</div>');
          }).join('') +
          '<div class="gh-btns" style="margin:14px 0"><button class="gh-btn small" data-nav data-act="resetBinds">Reset to defaults</button></div>' +
          '<h2 class="gh-h2">Gamepad</h2>' +
          rowHTML('Gamepad enabled', H.pad.active ? 'Controller detected' : 'Connect a controller and press any button', sw('controls.gamepad.enabled', true, 'Gamepad')) +
          rowHTML('Vibration', 'Rumble on kerbs and contact', sw('controls.gamepad.vibration', true, 'Vibration')) +
          rowHTML('Stick deadzone', '', range('controls.gamepad.deadzone', 0, 0.4, 0.01, 'raw', 0.12)) +
          rowHTML('Steering linearity', '1.0 = linear, higher = finer centre', range('controls.gamepad.steerLinearity', 0.5, 2.5, 0.05, 'x', 1)) +
          PAD_ACTIONS.map(function (a) {
            return rowHTML(a.label, '', '<button class="gh-key" style="min-width:120px" data-nav data-key="gp-' + a.id + '" data-act="padbind" data-a="' + a.id + '">' + esc(pad[a.id] ? keyLabel(pad[a.id]) : '—') + '</button>');
          }).join('');
      } else if (tab === 'graphics') {
        body = rowHTML('Quality', 'Overall 3D rendering detail · Auto picks a tier for this device' + autoTierNote() + ' and steps down if frames run long', segHTML('race.quality', rs.quality, raceOpts('QUALITIES', RACE_QUALITY_FB))) +
          rowHTML('Particles', 'Tyre smoke, sparks, spray', sw('graphics.particles', true, 'Particles')) +
          rowHTML('Shadows', 'Car and scenery shadows', sw('graphics.shadows', true, 'Shadows')) +
          rowHTML('Skidmarks', 'Persistent rubber on the tarmac', sw('graphics.skidmarks', true, 'Skidmarks')) +
          rowHTML('Motion blur', 'Speed effect at high velocity', sw('graphics.motionBlur', false, 'Motion blur')) +
          rowHTML('FPS counter', '', sw('graphics.fpsCounter', false, 'FPS counter')) +
          '<h2 class="gh-h2">HUD</h2>' +
          rowHTML('Minimap', '', sw('hud.minimap', true, 'Minimap')) + rowHTML('Speedometer', '', sw('hud.speedometer', true, 'Speedometer')) +
          rowHTML('Split times', '', sw('hud.splits', true, 'Splits')) + rowHTML('HUD opacity', '', range('hud.opacity', 0.3, 1, 0.05, 'pct', 1));
      } else if (tab === 'developer') {
        body = rowHTML('Body shape preview', 'Developer tool: every real-car body model (js/shapes) side by side', '<a class="gh-btn small" data-nav href="shapes-preview.html" target="_blank" rel="noopener">Open shapes preview</a>') +
          rowHTML('Version', 'Single entry point · index.html', '<span class="gh-chip">' + esc((CB.router && CB.router.version) || 'standalone') + '</span>');
      } else {
        body = rowHTML('Storage', pm && pm.isPersistent && pm.isPersistent() ? 'Saved in this browser (localStorage)' : 'Session only — progress is lost when the page closes', '<span class="gh-chip ' + (pm && pm.isPersistent && pm.isPersistent() ? 'good' : 'warn') + '">' + (pm && pm.isPersistent && pm.isPersistent() ? 'Persistent' : 'Memory') + '</span>') +
          rowHTML('Export profile', 'Download a backup of your progress', '<button class="gh-btn small" data-nav data-act="export">' + icon('download', 12) + ' Export</button>') +
          rowHTML('Import profile', 'Restore from a backup file or pasted JSON', '<button class="gh-btn small" data-nav data-act="import">Import</button>') +
          rowHTML('Reset settings', 'Restore every setting to its default', '<button class="gh-btn small" data-nav data-act="resetSettings">Reset settings</button>') +
          rowHTML('Reset profile', 'Erase credits, cars, career and achievements', '<button class="gh-btn small danger" data-nav data-act="resetProfile">Reset profile</button>');
      }
      host.innerHTML = '<div class="gh-kicker">Settings</div><h1 class="gh-h1">Settings</h1>' +
        tabsHTML([{ id: 'general', name: 'General' }, { id: 'driving', name: 'Driving' }, { id: 'audio', name: 'Audio' }, { id: 'controls', name: 'Controls' }, { id: 'graphics', name: 'Graphics' }, { id: 'profile', name: 'Profile data' }, { id: 'developer', name: 'Developer' }], tab) +
        '<div class="gh-set">' + body + '</div>';
      // range sliders: live label, commit on change
      $$('input[type=range]', host).forEach(function (r) {
        var lab = r.nextElementSibling;
        var upd = function () {
          var v = num(r.value, 0), f = r.getAttribute('data-fmt');
          r.style.setProperty('--v', ((v - num(r.min, 0)) / (num(r.max, 1) - num(r.min, 0)) * 100).toFixed(1) + '%');
          if (lab) lab.textContent = f === 'x' ? v.toFixed(2) + '×' : f === 'raw' ? v.toFixed(2) : Math.round(v * 100) + '%';
        };
        r.addEventListener('input', upd);
        r.addEventListener('change', function () { upd(); saveSetting(r.getAttribute('data-path'), num(r.value, 0), true); if (/^audio/.test(r.getAttribute('data-path'))) sfx('move'); });
      });
      onAct(host, {
        tab: function (d) { setParam('tab', d.tab); renderScreen(false); },
        seg: function (d) {
          if (d.k === 'app.theme') { setAppTheme(d.v); renderScreen(true); return; }
          if (d.k.indexOf('race.') === 0) { raceStoreSet(d.k.slice(5), d.v); if (d.k === 'race.quality') setSetting('graphics.quality', d.v); renderScreen(true); return; }
          if (d.k === 'steerAssist.race' || d.k === 'steerAssist.drift') { setSteerAssistLevel(d.k.slice(12), d.v); renderScreen(true); return; }
          saveSetting(d.k, d.v);
        },
        toggle: function (d) { saveSetting(d.k, !setting(d.k, false)); },
        step: function (d) {
          var lim = d.k === 'gameplay.defaultLaps' ? [1, 50] : [1, 11];
          saveSetting(d.k, clamp(num(setting(d.k, 3), 3) + num(d.d, 0), lim[0], lim[1]));
        },
        bind: function (d) {
          var a = d.a, slot = +d.slot, code = d.code;
          startCapture({
            keyboard: true, title: 'Press a key', prompt: 'for “' + (((pm && Array.isArray(pm.ACTIONS) ? pm.ACTIONS : FALLBACK_ACTIONS).filter(function (x) { return x.id === a; })[0] || { label: a }).label) + '” (slot ' + (slot + 1) + ')', hint: 'Esc to cancel · Backspace to clear',
            onCode: function (c) {
              var r = pm && typeof pm.bindKey === 'function' ? pm.bindKey(a, c, { slot: slot }) : null;
              if (!pm) { var b = setting('controls.bindings', {}) || {}; var l = arr(b[a]).slice(); l[slot] = c; b[a] = l.filter(Boolean); setSetting('controls.bindings', b); }
              sfx('select');
              var acts = (pm && Array.isArray(pm.ACTIONS)) ? pm.ACTIONS : FALLBACK_ACTIONS;
              var labelOf = function (id) { var x = acts.filter(function (q) { return q.id === id; })[0]; return x ? x.label : String(id); };
              if (r && r.stolenFrom) toast(esc(keyLabel(c)) + ' moved from ' + esc(labelOf(r.stolenFrom)) + ' to ' + esc(labelOf(a)), 'warn');
              else toast(esc(keyLabel(c)) + ' bound to ' + esc(labelOf(a)), 'good');
              renderScreen(true);
            },
            onClear: function () { if (code && pm && typeof pm.unbindKey === 'function') pm.unbindKey(a, code); renderScreen(true); }
          });
        },
        padbind: function (d) {
          if (!H.pad.active) { toast('Connect a controller first', 'warn'); }
          startCapture({
            pad: true, axisPlain: d.a === 'steer', title: 'Press a button', prompt: d.a === 'steer' ? 'or move a stick for steering' : 'or move a stick/trigger', hint: 'Esc to cancel',
            onCode: function (c) { setSetting('controls.gamepad.bindings.' + d.a, c); sfx('select'); toast(esc(keyLabel(c)) + ' bound', 'good'); renderScreen(true); }
          });
        },
        resetBinds: function () { if (pm && typeof pm.resetBindings === 'function') pm.resetBindings(); toast('Controls reset', 'good'); renderScreen(true); },
        export: function () {
          var json = pm && typeof pm.exportJSON === 'function' ? pm.exportJSON(true) : JSON.stringify(P(), null, 2);
          if (downloadText('redline-profile-' + new Date().toISOString().slice(0, 10) + '.json', json, 'application/json')) toast('Profile exported', 'good');
        },
        import: function () {
          var text = '';
          modal({
            kicker: 'Profile data', title: 'Import profile', wide: true,
            body: '<p>Paste an exported profile JSON or choose a file. This replaces your current progress.</p><textarea class="gh-input" style="width:100%;height:180px;padding:10px;font-family:var(--gh-mono);font-size:11px" data-nav></textarea><input type="file" accept=".json,application/json" style="margin-top:10px;color:var(--gh-dim)">',
            mount: function (card) {
              var ta = card.querySelector('textarea'), f = card.querySelector('input[type=file]');
              ta.addEventListener('input', function () { text = ta.value; });
              f.addEventListener('change', function () { var fl = f.files && f.files[0]; if (!fl) return; var rd = new FileReader(); rd.onload = function () { ta.value = text = String(rd.result || ''); }; rd.readAsText(fl); });
            },
            actions: [{ label: 'Cancel', kind: 'ghost', value: false }, { label: 'Import', kind: 'hot', value: true }],
            onClose: function (v) {
              if (!v || !text.trim()) return;
              var r = pm && typeof pm.importJSON === 'function' ? pm.importJSON(text) : { ok: false, error: 'Profile module unavailable' };
              if (r && r.ok) { toast('Profile imported', 'good'); show('menu', null, { reset: true }); } else toast('Import failed: ' + esc(r && r.error || 'invalid data'), 'bad');
            }
          });
        },
        resetSettings: function () { confirmBox('Reset settings?', 'Every setting, including control bindings, returns to its default.', 'Reset', function () { if (pm && pm.resetSettings) pm.resetSettings(); renderScreen(true); toast('Settings reset', 'good'); }); },
        resetProfile: function () {
          confirmBox('Reset profile?', 'This erases <b>all</b> credits, cars, career progress, records and achievements. Your settings and driver name are kept.', 'Erase everything', function () {
            if (pm && typeof pm.reset === 'function') pm.reset({ keepSettings: true, keepName: true }); else memProfile = null;
            H.setup = null; H.ws = null;
            toast('Profile reset — a fresh start', 'warn');
            show('title', null, { reset: true });
          }, { danger: true });
        }
      });
    }
  });

  /* ======================================================================
     Extra styles (dashboard, settings, misc) — appended to CSS
     ====================================================================== */
  var CSS2 = `
#game-hub[data-screen="menu"] .gh-bgfx{opacity:.55;-webkit-mask-image:linear-gradient(90deg,transparent 0,transparent 36%,#000 58%);mask-image:linear-gradient(90deg,transparent 0,transparent 36%,#000 58%)}
@media (max-width:1100px){#game-hub[data-screen="menu"] .gh-bgfx{opacity:.16;-webkit-mask-image:none;mask-image:none}
#game-hub .gh-menu{min-height:0;gap:28px}#game-hub .gh-menu-hero{display:flex;border-top:1px solid var(--gh-line);padding-top:24px}}
#game-hub .gh-gar-cur{display:grid;grid-template-columns:minmax(220px,380px) 1fr;gap:22px;align-items:center;max-width:1040px}
#game-hub .gh-gar-cur .gh-art{margin:0}
@media (max-width:760px){#game-hub .gh-gar-cur{grid-template-columns:1fr}}
#game-hub .gh-tiles .gh-tile b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
#game-hub .gh-tiles .gh-tile span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#game-hub .gh-chart-tip small{color:var(--gh-dim)}
#game-hub .gh-ach[data-nav]{cursor:default}
#game-hub .gh-ach.is-focus{border-color:rgba(212,176,106,.5)}
#game-hub .gh-row .gh-keys .gh-key.is-focus{border-color:var(--gh-accent)}
#game-hub .gh-row > .gh-seg,#game-hub .gh-row > .gh-btns,#game-hub .gh-row > .gh-keys{flex:none}
#game-hub .gh-card .gh-art .gh-chip.act{position:absolute;top:10px;left:10px}
#game-hub .gh-champ{min-height:340px}
#game-hub .gh-champ h3{font-size:16px}
#game-hub .gh-round.is-focus{border-color:var(--gh-accent)}
#game-hub .gh-trackcard .gh-art .gh-track-svg{max-width:90%;height:auto}
#game-hub .gh-trackcard.is-focus .gh-track-runner,#game-hub .gh-trackcard.is-sel .gh-track-runner{animation:gh-run 5s linear infinite}
#game-hub .gh-result-hero .gh-kv{max-width:360px}
#game-hub .gh-modal-card .gh-car-svg{width:100%;height:auto}
#game-hub .gh-modal-card .gh-hero-stats b{font-size:16px}
#game-hub .gh-panel .gh-car-svg{width:100%;height:auto;display:block}
#game-hub .gh-cabinet .gh-trophy:hover svg{transform:translateY(-3px);transition:transform .2s}
#game-hub .gh-seg button.is-focus{box-shadow:inset 0 0 0 2px var(--gh-accent)!important}
#game-hub .gh-color.is-focus{box-shadow:0 0 0 3px var(--gh-accent)!important}
#game-hub .gh-opt.is-focus{border-color:var(--gh-accent2)}
#game-hub .gh-tab.is-focus{color:var(--gh-accent2);box-shadow:none!important;background:rgba(212,176,106,.08)}
#game-hub textarea.gh-input{resize:vertical;user-select:text;-webkit-user-select:text}
#game-hub .gh-car-empty{display:grid;place-items:center;height:120px;color:var(--gh-mute);border:1px dashed var(--gh-line2)}
@media (max-width:1100px){#game-hub .gh-champ{min-height:0}}
/* phones: notch / home-indicator safe areas (env() is 0 on desktop, so these resolve to the desktop values) */
#game-hub .gh-top{padding-left:max(28px,env(safe-area-inset-left));padding-right:max(28px,env(safe-area-inset-right))}
@media (min-width:640.02px){#game-hub .gh-screen{padding-left:max(40px,env(safe-area-inset-left));padding-right:max(40px,env(safe-area-inset-right));padding-bottom:calc(60px + env(safe-area-inset-bottom))}}
@media (max-width:640px){#game-hub .gh-screen{padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right));padding-bottom:calc(50px + env(safe-area-inset-bottom))}
#game-hub .gh-row{flex-wrap:wrap;row-gap:10px}#game-hub .gh-row > .lbl,#game-hub .gh-row > label{flex:1 1 170px}
#game-hub .gh-row > .gh-seg{flex:0 1 auto;max-width:100%;flex-wrap:wrap}#game-hub .gh-row > .gh-btns,#game-hub .gh-row > .gh-keys{flex:0 1 auto;max-width:100%;flex-wrap:wrap}
#game-hub input[type=range].gh-range{width:100%;max-width:220px}#game-hub .gh-row .gh-input{max-width:100%}
#game-hub .gh-drift-cta{flex-wrap:wrap}#game-hub .gh-drift-cta .gh-drift-cta-txt{flex:1 1 200px!important;min-width:0}}
#game-hub .gh-title-meta{bottom:max(22px,env(safe-area-inset-bottom));left:max(28px,env(safe-area-inset-left));right:max(28px,env(safe-area-inset-right))}
@media (max-width:640px){#game-hub .gh-title-meta{flex-wrap:wrap;justify-content:center;gap:4px 14px;left:16px;right:16px}}
/* phones in landscape: the title screen fits the short viewport */
@media (max-height:520px){#game-hub .gh-title-logo{font-size:clamp(40px,15vh,110px);margin-top:0}#game-hub .gh-title-tag{margin-top:6px;font-size:11px}
#game-hub .gh-title-car{width:min(760px,80vw,110vh);margin-top:1vh}#game-hub .gh-title-press{margin-top:2vh}#game-hub .gh-title-meta{bottom:max(10px,env(safe-area-inset-bottom))}
#game-hub .gh-menu{min-height:0}}
/* touch: >= 40px tap targets; keyboard / gamepad hints are hidden */
@media (pointer:coarse){#game-hub .gh-foot{display:none}
#game-hub .gh-tab,#game-hub .gh-btn,#game-hub .gh-btn.small,#game-hub .gh-input{min-height:40px}
#game-hub .gh-seg button{height:auto;min-height:40px}
#game-hub .gh-key{height:40px}
#game-hub .gh-color{width:40px;height:40px;flex:none}
#game-hub .gh-colors{flex-wrap:wrap}
#game-hub .gh-btn.small{min-width:40px}
#game-hub .gh-switch::before{content:"";position:absolute;left:50%;top:50%;width:54px;height:44px;transform:translate(-50%,-50%)}
#game-hub input[type=range].gh-range{height:40px;background:linear-gradient(90deg,var(--gh-accent) var(--v,50%),rgba(255,255,255,.12) var(--v,50%)) center/100% 4px no-repeat}
#game-hub input[type=range].gh-range::-webkit-slider-thumb{width:22px;height:22px}
#game-hub .gh-crumb{display:inline-flex;align-items:center;min-height:40px}}
`;

  /* ======================================================================
     Boot & public API
     ====================================================================== */
  function boot(opts) {
    opts = opts || {};
    var pm = prof();
    if (pm && typeof pm.load === 'function') safe(function () { pm.load(); });
    var A = achv();
    if (A && typeof A.install === 'function' && !boot.installed) { safe(function () { A.install({}); }); }
    ensureIntegrations();
    boot.installed = true;
    var screenId = opts.screen;
    if (!screenId && hasDOM && window.location && window.location.hash) {
      var hsh = window.location.hash.replace(/^#\/?/, '');
      if (SCREENS[hsh]) screenId = hsh;
    }
    return open(Object.assign({ standalone: true }, opts, { screen: screenId || 'title' }));
  }

  var api = {
    open: open, close: close, isOpen: isOpen, isParked: isParked, unpark: unpark, show: show, back: back, refresh: refresh, toast: toast, boot: boot,
    screens: Object.keys(SCREENS), reportRaceResult: reportRaceResult, launchRace: launchRace, modal: modal,
    get current() { return H && H.stack.length ? H.stack[H.stack.length - 1].id : null; },
    _: {
      pickNext: pickNext, xpSegments: xpSegments, levelFromXp: levelFromXp, driftRewards: driftRewards, countUpValue: countUpValue, easeOutCubic: easeOutCubic, easeInOut: easeInOut,
      careerModel: careerModel, champVM: champVM, normalizeStandings: normalizeStandings, requirementChips: requirementChips,
      eligibility: eligibility, localEligibility: localEligibility, simulateResults: simulateResults, summarize: summarize,
      processResults: processResults, formSeries: formSeries, resultBuckets: resultBuckets, balanceSeries: balanceSeries, trackUsage: trackUsage,
      replayList: replayList, carSVG: carSVG, carArt: carArt, estimateMetrics: estimateMetrics, metricsFor: metricsFor,
      performanceIndex: performanceIndex, piClass: piClass, trackPreview: trackPreview, trackList: trackList,
      fmtTime: fmtTime, fmtCredits: fmtCredits, fmtInt: fmtInt, fmtCompact: fmtCompact, fmtDuration: fmtDuration, fmtDist: fmtDist, fmtSpeed: fmtSpeed,
      staleOverlays: staleOverlays, rowHTML: rowHTML, ordinal: ordinal, conditionLabel: conditionLabel, titleCase: titleCase, shade: shade, medalThresholds: medalThresholds,
      buyCar: buyCar, sellCar: sellCar, repairCar: repairCar, applyUpgrade: applyUpgrade, upgradeQuote: upgradeQuote, priceOf: priceOf,
      chSaveRecord: chSaveRecord, challengeList: challengeList, driverInfo: driverInfo, calendarFor: calendarFor, standingsFor: standingsFor,
      fallbackProfile: fallbackProfile, steerAssistLevel: steerAssistLevel, setSteerAssistLevel: setSteerAssistLevel, raceSettings: raceSettings,
      CSS: function () { return CSS + CSS2; }
    }
  };
  CB.game.hub = api;

  // Record every race on host pages (race.html / index.html RACE button), not only those launched from the hub.
  if (hasDOM) safe(ensureIntegrations);

  // Career refuses to launch a round with an empty garage (e.g. after selling the only car) — tell the player why.
  if (hasDOM && typeof document.addEventListener === 'function') {
    document.addEventListener('cb:career-blocked', function (e) {
      var msg = e && e.detail && e.detail.message;
      if (msg && H) safe(function () { toast(msg, 'bad'); });
    });
  }

  /* Deep link for host pages that embed the hub (index.html): '#hub' or '#hub=<screen>' opens it once the app has booted.
     hub.html hands over here when the player needs the configurator. */
  if (hasDOM && window.location && /(^#|&)hub(=|&|$)/.test(window.location.hash || '')) {
    var deep = (/(?:^#|&)hub=([a-z-]+)/.exec(window.location.hash) || [])[1] || 'menu';
    var openDeep = function () {
      setTimeout(function () {
        if (H || !document.getElementById('stage') && !(CB.app && CB.app.openAtelier)) return;  // standalone hub.html boots itself
        if (CB.router) return;   // the unified game's router maps '#hub=<screen>' itself
        try { history.replaceState(history.state, '', window.location.pathname + window.location.search + (window.location.hash || '').replace(/(^#|&)hub(=[a-z-]+)?/, '$1').replace(/^#&?$/, '')); } catch (e) { /* ignore */ }
        safe(function () { open({ screen: SCREENS[deep] ? deep : 'menu' }); });
      }, 450);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openDeep); else openDeep();
  }
})();

if (typeof module !== 'undefined') module.exports = CB.game.hub;

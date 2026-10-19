/* FORGE Atelier — Achievements (CB.game.achievements)
 *
 * Contract: docs/GAME-SPEC.md § Achievements.
 *
 *   CB.game.achievements.list                 -> array of achievement defs (146), each
 *        { id, name, desc, icon (svg string), tier: 'bronze'|'silver'|'gold'|'platinum', xp, credits,
 *          category, hidden?, hint?, progress?(profile) -> {cur, max} }
 *   CB.game.achievements.check(profile, event, opts?) -> newly unlocked achievements (array)
 *        event: {type:'build-changed', build, metrics?, pricing?|price?}
 *             | {type:'race-finished', results, config, stats?, events?}
 *             | {type:'career', action, ...}          (see normalizeCareer below)
 *             | {type:'stat', key?, value?, stats?}
 *             | extras: {type:'challenge', id, medal, score} | {type:'drift', score, combo}
 *                       {type:'garage', action:'buy'|'sell'|'repair'|'upgrade'} | {type:'replay', action}
 *                       {type:'photo', action:'exported'} | {type:'profile'} | {type:'session'}
 *        Profile resolution:
 *          - if CB.game.profile exists and `profile` is omitted / is the module's profile (same createdAt),
 *            changes go through CB.game.profile.update() and rewards through addCredits()/addXp();
 *          - else the passed profile object is mutated in place (credits/xp/level applied directly);
 *          - else (no profile at all) an internal store persisted to localStorage 'forge.achievements.v1'.
 *        opts: { toast: bool (default: auto in browsers), persist: bool (default true), now: ms }
 *   evaluate(profile, event)            -> dry run (ids that would unlock; nothing mutated)
 *   progress(profile, id)               -> {cur, max, pct} | null
 *   summary(profile)                    -> {unlocked, total, pct, byTier, byCategory, xpEarned, creditsEarned, recent}
 *   isUnlocked(profile, id), unlock(profile, id, opts), reset(profile)
 *   toast(a), openGallery(opts {root?, inline?, onClose?, category?, status?, focus?}), closeGallery(), onUnlock(fn) -> unsubscribe, install(opts)
 *        openGallery({root: el}) mounts the gallery inline in a router screen layer (#/achievements) instead of a modal.
 *
 * Pure logic loads in Node (no DOM touched until toast()/openGallery()).
 */
var CB = (globalThis.CB = globalThis.CB || {});
CB.game = CB.game || {};

(function () {
  'use strict';

  /* ================================================================== helpers */

  var STORE_KEY = 'forge.achievements.v1';
  var hasDOM = typeof document !== 'undefined' && !!document.createElement;

  function num(v, d) { var n = typeof v === 'string' ? parseFloat(v) : v; return (typeof n === 'number' && isFinite(n)) ? n : (d === undefined ? NaN : d); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function get(o, path) {
    if (!o) return undefined;
    var parts = String(path).split('.');
    for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
    return o;
  }
  function first() { for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i]; return undefined; }
  function firstNum() { for (var i = 0; i < arguments.length; i++) if (isNum(arguments[i])) return arguments[i]; return NaN; }
  function clone(o) {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(clone);
    var r = {}; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) { var v = o[k]; if (typeof v !== 'function') r[k] = clone(v); }
    return r;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtInt(n) {
    n = Math.round(num(n, 0));
    var s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + s;
  }
  function fmtCompact(n) {
    n = num(n, 0);
    var a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return (n / 1e3).toFixed(0) + 'k';
    return fmtInt(n);
  }
  function fmtDate(ms) {
    if (!isNum(ms)) return '';
    try {
      var d = new Date(ms);
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) { return new Date(ms).toISOString().slice(0, 10); }
  }
  function lsGet(k) { try { return globalThis.localStorage ? globalThis.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (globalThis.localStorage) globalThis.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function profileModule() { var p = CB.game && CB.game.profile; return (p && typeof p.get === 'function') ? p : null; }

  /* ================================================================== tiers */

  var TIERS = {
    bronze:   { id: 'bronze', name: 'Bronze', rank: 1, xp: 250, credits: 2500,
                face: ['#f3c296', '#c27a43', '#7a4220'], rim: ['#9b5a2c', '#4a2410'], ink: '#fff4e8', inkShade: '#5b2e12', glow: '#e08a4c' },
    silver:   { id: 'silver', name: 'Silver', rank: 2, xp: 600, credits: 7500,
                face: ['#ffffff', '#c6ccd4', '#7f8893'], rim: ['#a8b0ba', '#3e454e'], ink: '#26303a', inkShade: '#eef2f6', glow: '#c9d3de' },
    gold:     { id: 'gold', name: 'Gold', rank: 3, xp: 1500, credits: 20000,
                face: ['#fff3b8', '#f0c246', '#a8700c'], rim: ['#d39b1d', '#5e3d02'], ink: '#4d3000', inkShade: '#fff6cf', glow: '#ffcc3d' },
    platinum: { id: 'platinum', name: 'Platinum', rank: 4, xp: 4000, credits: 60000,
                face: ['#f2fdff', '#a9dcea', '#5d93a8'], rim: ['#cfefff', '#21495a'], ink: '#0e3442', inkShade: '#ffffff', glow: '#8fe9ff' }
  };
  var TIER_ORDER = ['bronze', 'silver', 'gold', 'platinum'];

  var CATEGORIES = [
    { id: 'atelier', name: 'Garage', desc: 'Commission, engineer and style extraordinary machines.' },
    { id: 'racing', name: 'Racing', desc: 'Wheel-to-wheel feats on the circuits.' },
    { id: 'career', name: 'Career', desc: 'Championships, rivals and the climb to the Hypercar Masters.' },
    { id: 'drift', name: 'Drift', desc: 'Style, angle and commitment.' },
    { id: 'endurance', name: 'Endurance', desc: 'Tyres, fuel, pit stops and stamina.' },
    { id: 'challenges', name: 'Driving School', desc: 'Medals from the skill challenges.' },
    { id: 'garage', name: 'Collection & Economy', desc: 'Collecting, maintaining and earning.' },
    { id: 'milestones', name: 'Milestones', desc: 'Long-haul career statistics.' },
    { id: 'media', name: 'Replays & Photo', desc: 'Capture and relive the moments.' },
    { id: 'meta', name: 'Meta', desc: 'Achievements about achievements.' }
  ];

  /* ================================================================== icons */
  // Every glyph is drawn in a 64×64 view box, inside the ~18..46 safe area. `c` = ink, `s` = shade.

  var GLYPHS = {
    trophy: function (c, s) {
      return '<path d="M23 18h18v7c0 6-4 11-9 11s-9-5-9-11z" fill="' + c + '"/>' +
        '<path d="M23 21h-4c0 5 2 8 5 9M41 21h4c0 5-2 8-5 9" fill="none" stroke="' + c + '" stroke-width="2.4" stroke-linecap="round"/>' +
        '<path d="M29 36h6v5h-6z" fill="' + c + '"/><path d="M24 41h16v4H24z" fill="' + c + '"/>' +
        '<path d="M27 21v5c0 3 2 6 4 7" fill="none" stroke="' + s + '" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>';
    },
    flag: function (c, s) {
      var sq = '';
      for (var r = 0; r < 4; r++) for (var q = 0; q < 5; q++) if ((r + q) % 2 === 0) sq += '<rect x="' + (24 + q * 4) + '" y="' + (19 + r * 4) + '" width="4" height="4" fill="' + s + '"/>';
      return '<path d="M22 17v30" stroke="' + c + '" stroke-width="2.6" stroke-linecap="round"/>' +
        '<path d="M24 19h20v16H24z" fill="' + c + '"/>' + sq;
    },
    wheel: function (c, s) {
      var sp = '';
      for (var i = 0; i < 5; i++) { var a = i * Math.PI * 2 / 5 - Math.PI / 2; sp += '<path d="M32 32L' + (32 + Math.cos(a) * 9).toFixed(1) + ' ' + (32 + Math.sin(a) * 9).toFixed(1) + '" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/>'; }
      return '<circle cx="32" cy="32" r="14" fill="none" stroke="' + c + '" stroke-width="4"/>' +
        '<circle cx="32" cy="32" r="10.5" fill="none" stroke="' + c + '" stroke-width="1" opacity=".6"/>' + sp +
        '<circle cx="32" cy="32" r="3" fill="' + c + '"/><circle cx="32" cy="32" r="1.2" fill="' + s + '"/>';
    },
    piston: function (c, s) {
      return '<rect x="24" y="17" width="16" height="12" rx="2" fill="' + c + '"/>' +
        '<path d="M24 21h16M24 24h16" stroke="' + s + '" stroke-width="1.2" opacity=".6"/>' +
        '<path d="M32 29l-4 12M32 29l4 12" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/>' +
        '<circle cx="32" cy="43" r="4" fill="none" stroke="' + c + '" stroke-width="2.6"/>';
    },
    bolt: function (c) { return '<path d="M35 15L22 35h9l-3 14 14-21h-9z" fill="' + c + '"/>'; },
    leaf: function (c, s) {
      return '<path d="M44 18c-16 0-25 8-25 19 0 4 2 7 5 9 2-9 8-15 15-19-6 5-10 11-12 20 13 0 18-12 17-29z" fill="' + c + '"/>' +
        '<path d="M22 46l-3 3" stroke="' + c + '" stroke-width="2.4" stroke-linecap="round"/>';
    },
    feather: function (c, s) {
      return '<path d="M43 17c-12 2-22 12-23 26l4-4c1-8 6-14 13-18-5 5-9 11-10 18 10-3 16-11 16-22z" fill="' + c + '"/>' +
        '<path d="M20 47l14-17" stroke="' + c + '" stroke-width="2" stroke-linecap="round"/>' +
        '<path d="M28 34h7M31 29h6" stroke="' + s + '" stroke-width="1.2" opacity=".6"/>';
    },
    gauge: function (c, s) {
      var t = '';
      for (var i = 0; i <= 8; i++) { var a = Math.PI * (0.8 + i * 1.4 / 8); t += '<path d="M' + (32 + Math.cos(a) * 12).toFixed(1) + ' ' + (36 + Math.sin(a) * 12).toFixed(1) + 'L' + (32 + Math.cos(a) * 15).toFixed(1) + ' ' + (36 + Math.sin(a) * 15).toFixed(1) + '" stroke="' + (i > 6 ? s : c) + '" stroke-width="2" stroke-linecap="round"/>'; }
      return '<path d="M17.8 42A15 15 0 1 1 46.2 42" fill="none" stroke="' + c + '" stroke-width="1.6" opacity=".55"/>' + t +
        '<path d="M32 36L42 25" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/><circle cx="32" cy="36" r="3.2" fill="' + c + '"/>';
    },
    coin: function (c, s) {
      return '<circle cx="32" cy="32" r="14" fill="' + c + '"/><circle cx="32" cy="32" r="11" fill="none" stroke="' + s + '" stroke-width="1.4" opacity=".7"/>' +
        '<path d="M36.5 26.5c-1-1.6-2.8-2.3-4.6-2.3-2.6 0-4.6 1.3-4.6 3.5 0 4.9 9.6 2.6 9.6 7.6 0 2.3-2.1 3.8-4.9 3.8-2 0-3.9-.8-5-2.6M32 21.5v21" fill="none" stroke="' + s + '" stroke-width="2.4" stroke-linecap="round"/>';
    },
    wrench: function (c) {
      return '<path d="M42.5 18.5a8 8 0 0 0-10.4 10.2L18.6 42.2a3 3 0 0 0 4.2 4.2l13.5-13.5a8 8 0 0 0 10.2-10.4l-4.9 4.9-4.2-1.1-1.1-4.2z" fill="' + c + '"/>';
    },
    star: function (c) {
      var p = '';
      for (var i = 0; i < 10; i++) { var r = i % 2 ? 6.5 : 15, a = -Math.PI / 2 + i * Math.PI / 5; p += (i ? 'L' : 'M') + (32 + Math.cos(a) * r).toFixed(1) + ' ' + (33 + Math.sin(a) * r).toFixed(1); }
      return '<path d="' + p + 'z" fill="' + c + '"/>';
    },
    crown: function (c, s) {
      return '<path d="M18 24l7 6 7-11 7 11 7-6-3 17H21z" fill="' + c + '"/><path d="M21 44h22" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/>' +
        '<circle cx="18" cy="23" r="2.2" fill="' + c + '"/><circle cx="46" cy="23" r="2.2" fill="' + c + '"/><circle cx="32" cy="18" r="2.2" fill="' + c + '"/>' +
        '<circle cx="32" cy="34" r="2.4" fill="' + s + '"/>';
    },
    flame: function (c, s) {
      return '<path d="M32 15c2 7 11 11 11 21a11 11 0 0 1-22 0c0-6 4-9 5-14 2 3 2 6 4 7 1-5 0-9 2-14z" fill="' + c + '"/>' +
        '<path d="M32 33c1 3 5 4 5 8a5 5 0 0 1-10 0c0-3 2-4 2-7 1 1 2 2 3 2z" fill="' + s + '" opacity=".75"/>';
    },
    swirl: function (c, s) {
      return '<path d="M20 40c4-14 26-18 26-6 0 7-10 9-13 4-2-4 3-7 6-4" fill="none" stroke="' + c + '" stroke-width="3.2" stroke-linecap="round"/>' +
        '<path d="M17 46c6 0 10-1 14-3M21 49c4 0 7-1 10-2" stroke="' + c + '" stroke-width="2" stroke-linecap="round" opacity=".7"/>' +
        '<circle cx="43" cy="22" r="2" fill="' + c + '" opacity=".7"/><circle cx="47" cy="27" r="1.4" fill="' + c + '" opacity=".5"/>';
    },
    stopwatch: function (c, s) {
      return '<circle cx="32" cy="35" r="12.5" fill="none" stroke="' + c + '" stroke-width="3.4"/>' +
        '<path d="M28 17h8M32 17v5M42 23l2.5-2.5" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M32 35V27M32 35l5 3" stroke="' + c + '" stroke-width="2.6" stroke-linecap="round"/><circle cx="32" cy="35" r="1.8" fill="' + c + '"/>';
    },
    fuel: function (c, s) {
      return '<rect x="20" y="18" width="16" height="28" rx="2.5" fill="' + c + '"/><rect x="23" y="21" width="10" height="8" rx="1" fill="' + s + '" opacity=".8"/>' +
        '<path d="M36 25h3a3 3 0 0 1 3 3v11a2 2 0 0 0 4 0V24l-4-4" fill="none" stroke="' + c + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="M18 46h20" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/>';
    },
    shield: function (c, s) {
      return '<path d="M32 16l13 5v9c0 9-6 15-13 18-7-3-13-9-13-18v-9z" fill="' + c + '"/>' +
        '<path d="M26 32l4 4 8-9" fill="none" stroke="' + s + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>';
    },
    camera: function (c, s) {
      return '<path d="M19 25h6l3-4h8l3 4h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H19a2 2 0 0 1-2-2V27a2 2 0 0 1 2-2z" fill="' + c + '"/>' +
        '<circle cx="32" cy="34" r="6.5" fill="' + s + '"/><circle cx="32" cy="34" r="4" fill="' + c + '"/><circle cx="41" cy="28.5" r="1.3" fill="' + s + '"/>';
    },
    globe: function (c, s) {
      return '<circle cx="32" cy="32" r="14" fill="none" stroke="' + c + '" stroke-width="3"/>' +
        '<ellipse cx="32" cy="32" rx="6" ry="14" fill="none" stroke="' + c + '" stroke-width="2"/>' +
        '<path d="M18 32h28M20.5 24h23M20.5 40h23" stroke="' + c + '" stroke-width="1.8"/>';
    },
    laurel: function (c, s) {
      var l = '';
      for (var i = 0; i < 5; i++) {
        var y = 42 - i * 5.5, dx = 3 + i * 0.6;
        l += '<ellipse cx="' + (22 - dx + 3) + '" cy="' + y + '" rx="2.2" ry="4" transform="rotate(' + (-40 + i * 8) + ' ' + (22 - dx + 3) + ' ' + y + ')" fill="' + c + '"/>';
        l += '<ellipse cx="' + (42 + dx - 3) + '" cy="' + y + '" rx="2.2" ry="4" transform="rotate(' + (40 - i * 8) + ' ' + (42 + dx - 3) + ' ' + y + ')" fill="' + c + '"/>';
      }
      return '<path d="M24 46c-6-5-8-14-4-24M40 46c6-5 8-14 4-24" fill="none" stroke="' + c + '" stroke-width="1.8" stroke-linecap="round"/>' + l +
        '<path d="M32 25l2.2 4.6 5 .6-3.7 3.4 1 5-4.5-2.5-4.5 2.5 1-5-3.7-3.4 5-.6z" fill="' + c + '"/>';
    },
    medal: function (c, s) {
      return '<path d="M24 15h6l4 10h-6zM40 15h-6l-4 10h6z" fill="' + c + '" opacity=".75"/>' +
        '<circle cx="32" cy="36" r="11" fill="' + c + '"/><circle cx="32" cy="36" r="7.5" fill="none" stroke="' + s + '" stroke-width="1.6"/>' +
        '<path d="M32 31.5l1.5 3 3.3.4-2.4 2.3.6 3.3-3-1.6-3 1.6.6-3.3-2.4-2.3 3.3-.4z" fill="' + s + '"/>';
    },
    gear: function (c, s) {
      var p = '';
      for (var i = 0; i < 16; i++) { var a = i * Math.PI / 8, r = (i % 2) ? 11 : 15; var a2 = a + Math.PI / 8; p += (i ? 'L' : 'M') + (32 + Math.cos(a) * r).toFixed(1) + ' ' + (32 + Math.sin(a) * r).toFixed(1) + 'L' + (32 + Math.cos(a2 - 0.08) * r).toFixed(1) + ' ' + (32 + Math.sin(a2 - 0.08) * r).toFixed(1); }
      return '<path d="' + p + 'z" fill="' + c + '"/><circle cx="32" cy="32" r="5" fill="' + s + '"/>';
    },
    wing: function (c, s) {
      return '<path d="M15 25c10-3 24-3 34 0l-2 5c-10-2-20-2-30 0z" fill="' + c + '"/>' +
        '<path d="M17 25v-4M47 25v-4" stroke="' + c + '" stroke-width="2.4" stroke-linecap="round"/>' +
        '<path d="M26 30l-2 10M38 30l2 10" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M18 44h28" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M22 35c-2 2-5 3-7 3M42 35c2 2 5 3 7 3" stroke="' + c + '" stroke-width="1.5" stroke-linecap="round" opacity=".6"/>';
    },
    horseshoe: function (c, s) {
      return '<path d="M22 44V30a10 10 0 0 1 20 0v14" fill="none" stroke="' + c + '" stroke-width="6.5" stroke-linecap="butt"/>' +
        '<path d="M19 45h6M39 45h6" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/>' +
        [[22, 38], [22.6, 31], [26, 24.5], [42, 38], [41.4, 31], [38, 24.5]].map(function (p) { return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="1.1" fill="' + s + '"/>'; }).join('');
    },
    drop: function (c, s) {
      return '<path d="M32 15c6 9 12 15 12 22a12 12 0 0 1-24 0c0-7 6-13 12-22z" fill="' + c + '"/>' +
        '<path d="M26 37a6 6 0 0 0 5 6" stroke="' + s + '" stroke-width="2.2" stroke-linecap="round" fill="none" opacity=".75"/>';
    },
    moon: function (c, s) {
      return '<path d="M38 16a16 16 0 1 0 9 26 13 13 0 0 1-9-26z" fill="' + c + '"/>' +
        '<circle cx="44" cy="21" r="1.4" fill="' + c + '"/><circle cx="47" cy="29" r="1" fill="' + c + '"/>';
    },
    road: function (c, s) {
      return '<path d="M26 16h12l8 32H18z" fill="' + c + '"/><path d="M32 18v5M32 28v6M32 39v7" stroke="' + s + '" stroke-width="2.4" stroke-linecap="round"/>';
    },
    key: function (c, s) {
      return '<circle cx="24" cy="32" r="8" fill="none" stroke="' + c + '" stroke-width="4"/>' +
        '<path d="M32 32h15M42 32v6M47 32v5" stroke="' + c + '" stroke-width="4" stroke-linecap="round"/>';
    },
    garage: function (c, s) {
      return '<path d="M16 30l16-12 16 12v16H16z" fill="' + c + '"/><rect x="21" y="32" width="22" height="14" fill="' + s + '" opacity=".85"/>' +
        '<path d="M21 36h22M21 40h22" stroke="' + c + '" stroke-width="1.4"/>';
    },
    podium: function (c, s) {
      return '<rect x="26" y="26" width="12" height="20" fill="' + c + '"/><rect x="15" y="33" width="11" height="13" fill="' + c + '" opacity=".8"/>' +
        '<rect x="38" y="37" width="11" height="9" fill="' + c + '" opacity=".65"/>' +
        '<text x="32" y="38" text-anchor="middle" font-size="9" font-weight="800" font-family="system-ui,sans-serif" fill="' + s + '">1</text>' +
        '<path d="M32 16l1.6 3.2 3.5.5-2.5 2.4.6 3.5-3.2-1.7-3.2 1.7.6-3.5-2.5-2.4 3.5-.5z" fill="' + c + '"/>';
    },
    helmet: function (c, s) {
      return '<path d="M17 36c0-11 7-18 16-18 8 0 14 6 14 14v8c0 3-2 5-5 5H24c-4 0-7-4-7-9z" fill="' + c + '"/>' +
        '<path d="M30 28h17v7H32a2 2 0 0 1-2-2z" fill="' + s + '" opacity=".85"/><path d="M19 40h12" stroke="' + s + '" stroke-width="1.6" opacity=".6"/>';
    },
    tire: function (c, s) {
      var t = '';
      for (var i = 0; i < 12; i++) { var a = i * Math.PI / 6; t += '<path d="M' + (32 + Math.cos(a) * 12).toFixed(1) + ' ' + (32 + Math.sin(a) * 12).toFixed(1) + 'L' + (32 + Math.cos(a + .2) * 15.5).toFixed(1) + ' ' + (32 + Math.sin(a + .2) * 15.5).toFixed(1) + '" stroke="' + s + '" stroke-width="2"/>'; }
      return '<circle cx="32" cy="32" r="14" fill="none" stroke="' + c + '" stroke-width="6"/>' + t + '<circle cx="32" cy="32" r="6" fill="' + c + '"/>';
    },
    arrowUp: function (c, s) {
      return '<path d="M32 15l12 13h-7v18H27V28h-7z" fill="' + c + '"/><path d="M20 47h24" stroke="' + c + '" stroke-width="2" stroke-linecap="round" opacity=".6"/>';
    },
    chart: function (c, s) {
      return '<path d="M18 46h28" stroke="' + c + '" stroke-width="2.4" stroke-linecap="round"/><rect x="20" y="34" width="5" height="10" fill="' + c + '"/>' +
        '<rect x="28" y="28" width="5" height="16" fill="' + c + '"/><rect x="36" y="21" width="5" height="23" fill="' + c + '"/>' +
        '<path d="M19 28l9-7 6 4 9-8" fill="none" stroke="' + c + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".7"/>';
    },
    diamond: function (c, s) {
      return '<path d="M20 26l6-8h12l6 8-12 20z" fill="' + c + '"/><path d="M20 26h24M26 18l6 8 6-8M32 26v20" fill="none" stroke="' + s + '" stroke-width="1.3" opacity=".7"/>';
    },
    eye: function (c, s) {
      return '<path d="M14 32c5-8 11-12 18-12s13 4 18 12c-5 8-11 12-18 12s-13-4-18-12z" fill="' + c + '"/><circle cx="32" cy="32" r="6" fill="' + s + '"/><circle cx="32" cy="32" r="2.6" fill="' + c + '"/>';
    },
    seat: function (c, s) {
      return '<path d="M24 16h8a3 3 0 0 1 3 3l-1 15h7a3 3 0 0 1 3 3v4H24a4 4 0 0 1-4-4l1-18a3 3 0 0 1 3-3z" fill="' + c + '"/>' +
        '<path d="M27 46h14M30 41v5M38 41v5" stroke="' + c + '" stroke-width="2.6" stroke-linecap="round"/><path d="M27 21v9" stroke="' + s + '" stroke-width="1.6" opacity=".6"/>';
    },
    palette: function (c, s) {
      return '<path d="M32 16c-9 0-16 7-16 15 0 9 7 15 13 15 3 0 3-3 2-5s0-4 3-4h4c5 0 8-3 8-8 0-8-6-13-14-13z" fill="' + c + '"/>' +
        '<circle cx="24" cy="28" r="2.4" fill="' + s + '"/><circle cx="30" cy="22" r="2.4" fill="' + s + '"/><circle cx="38" cy="23" r="2.4" fill="' + s + '"/><circle cx="23" cy="36" r="2.4" fill="' + s + '"/>';
    },
    burst: function (c, s) {
      var p = '';
      for (var i = 0; i < 16; i++) { var r = i % 2 ? 7 : 15, a = i * Math.PI / 8 + 0.2; p += (i ? 'L' : 'M') + (32 + Math.cos(a) * r).toFixed(1) + ' ' + (32 + Math.sin(a) * r).toFixed(1); }
      return '<path d="' + p + 'z" fill="' + c + '"/><circle cx="32" cy="32" r="3.5" fill="' + s + '"/>';
    },
    film: function (c, s) {
      var h = '';
      for (var i = 0; i < 4; i++) h += '<rect x="19.5" y="' + (20 + i * 6.5) + '" width="3" height="3" fill="' + s + '"/><rect x="41.5" y="' + (20 + i * 6.5) + '" width="3" height="3" fill="' + s + '"/>';
      return '<rect x="17" y="17" width="30" height="30" rx="2.5" fill="' + c + '"/>' + h + '<path d="M29 26v12l10-6z" fill="' + s + '"/>';
    },
    book: function (c, s) {
      return '<path d="M16 20c6-2 11-1 16 2v25c-5-3-10-4-16-2z" fill="' + c + '"/><path d="M48 20c-6-2-11-1-16 2v25c5-3 10-4 16-2z" fill="' + c + '" opacity=".8"/>' +
        '<path d="M20 26c3-.7 6-.4 8 .8M20 31c3-.7 6-.4 8 .8M36 26.8c2-1.2 5-1.5 8-.8" stroke="' + s + '" stroke-width="1.3" opacity=".7"/>';
    },
    cone: function (c, s) {
      return '<path d="M29 16h6l8 26H21z" fill="' + c + '"/><path d="M26.6 26h10.8M24.4 34h15.2" stroke="' + s + '" stroke-width="3.2"/><rect x="16" y="42" width="32" height="4" rx="1.5" fill="' + c + '"/>';
    },
    battery: function (c, s) {
      return '<rect x="16" y="22" width="29" height="20" rx="3" fill="none" stroke="' + c + '" stroke-width="3"/><rect x="45" y="28" width="4" height="8" rx="1" fill="' + c + '"/>' +
        '<path d="M32 25l-6 8h5l-2 6 7-9h-5z" fill="' + c + '"/>';
    },
    infinity: function (c) {
      return '<path d="M32 32c-4-5-7-8-11-8a8 8 0 0 0 0 16c4 0 7-3 11-8s7-8 11-8a8 8 0 0 1 0 16c-4 0-7-3-11-8z" fill="none" stroke="' + c + '" stroke-width="3.6" stroke-linecap="round"/>';
    },
    hourglass: function (c, s) {
      return '<path d="M21 16h22M21 48h22" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/><path d="M23 17c0 9 9 11 9 15s-9 6-9 15h18c0-9-9-11-9-15s9-6 9-15z" fill="' + c + '"/>' +
        '<path d="M27 44c2-3 3-4 5-4s3 1 5 4z" fill="' + s + '" opacity=".8"/>';
    },
    pit: function (c, s) {
      return '<path d="M20 44l8-12M30 36l-6 9" stroke="' + c + '" stroke-width="3.4" stroke-linecap="round"/>' +
        '<path d="M28 20h10l4 6-4 6H28l-4-6z" fill="' + c + '"/><circle cx="33" cy="26" r="2.6" fill="' + s + '"/>' +
        '<path d="M42 38a6 6 0 1 0 0 .1" fill="none" stroke="' + c + '" stroke-width="2.6"/>';
    },
    handshake: function (c, s) {
      return '<path d="M14 30l8-8 6 3h6l8-3 8 8-6 6-3-1-6 6c-2 2-4 1-5 0l-6-6-4 1z" fill="' + c + '"/>' +
        '<path d="M28 31l5 5M31 28l5 5M25 34l4 4" stroke="' + s + '" stroke-width="1.6" stroke-linecap="round" opacity=".7"/>';
    },
    target: function (c, s) {
      return '<circle cx="32" cy="32" r="14" fill="none" stroke="' + c + '" stroke-width="3"/><circle cx="32" cy="32" r="8.5" fill="none" stroke="' + c + '" stroke-width="3"/><circle cx="32" cy="32" r="3.2" fill="' + c + '"/>' +
        '<path d="M32 32l13-13M41 18h5v5" stroke="' + c + '" stroke-width="2" stroke-linecap="round" fill="none"/>';
    },
    skull: function (c, s) {
      return '<path d="M32 16c-8 0-14 6-14 13 0 5 3 8 5 9v5h18v-5c2-1 5-4 5-9 0-7-6-13-14-13z" fill="' + c + '"/>' +
        '<circle cx="26" cy="30" r="3.6" fill="' + s + '"/><circle cx="38" cy="30" r="3.6" fill="' + s + '"/><path d="M32 34l-2 4h4z" fill="' + s + '"/>' +
        '<path d="M27 43v4M32 43v4M37 43v4" stroke="' + c + '" stroke-width="2.4" stroke-linecap="round"/>';
    },
    snail: function (c, s) {
      return '<circle cx="34" cy="32" r="10" fill="' + c + '"/><path d="M34 32a4 4 0 1 1 4-4" fill="none" stroke="' + s + '" stroke-width="2"/>' +
        '<path d="M16 44h30c2 0 3-2 2-3l-4-1H16z" fill="' + c + '"/><path d="M19 41v-9M23 41v-8" stroke="' + c + '" stroke-width="2" stroke-linecap="round"/>';
    },
    mountain: function (c, s) {
      return '<path d="M14 46l12-20 6 9 5-7 13 18z" fill="' + c + '"/><path d="M26 26l-3 5 3-1 2 2z" fill="' + s + '" opacity=".8"/><path d="M37 28l-2 3 2-.5 1.5 1z" fill="' + s + '" opacity=".8"/>';
    },
    question: function (c, s) {
      return '<path d="M25 25a7 7 0 1 1 10 6.3c-2 1-3 2.4-3 4.7v1.5" fill="none" stroke="' + c + '" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="45" r="2.6" fill="' + c + '"/>';
    },
    lock: function (c, s) {
      return '<rect x="21" y="29" width="22" height="17" rx="3" fill="' + c + '"/><path d="M25 29v-5a7 7 0 0 1 14 0v5" fill="none" stroke="' + c + '" stroke-width="3.4"/>' +
        '<circle cx="32" cy="36" r="2.5" fill="' + s + '"/><path d="M32 37v4" stroke="' + s + '" stroke-width="2.2" stroke-linecap="round"/>';
    },
    number: function (c, s, label) {
      var L = String(label || '1');
      var fs = L.length >= 4 ? 10 : L.length === 3 ? 13 : 17;
      return '<text x="32" y="' + (32 + fs * 0.36).toFixed(1) + '" text-anchor="middle" font-size="' + fs + '" font-weight="900" font-family="system-ui,-apple-system,Segoe UI,sans-serif" letter-spacing="-0.5" fill="' + c + '">' + esc(L) + '</text>';
    }
  };

  function polygon(n, r, cx, cy, rot) {
    var p = '';
    for (var i = 0; i < n; i++) { var a = (rot || 0) + i * Math.PI * 2 / n; p += (i ? 'L' : 'M') + (cx + Math.cos(a) * r).toFixed(2) + ' ' + (cy + Math.sin(a) * r).toFixed(2); }
    return p + 'z';
  }
  function rosette(points, rOut, rIn, cx, cy) {
    var p = '';
    for (var i = 0; i < points * 2; i++) { var r = i % 2 ? rIn : rOut, a = -Math.PI / 2 + i * Math.PI / points; p += (i ? 'L' : 'M') + (cx + Math.cos(a) * r).toFixed(2) + ' ' + (cy + Math.sin(a) * r).toFixed(2); }
    return p + 'z';
  }

  var iconSeq = 0;
  /** Build a tiered badge SVG. glyph: GLYPHS key; tier: bronze|silver|gold|platinum|locked; opts {label, size, uid} */
  function icon(glyph, tier, opts) {
    opts = opts || {};
    var locked = tier === 'locked';
    var T = TIERS[tier] || TIERS.bronze;
    var face = locked ? ['#4a4d55', '#30333a', '#1d1f24'] : T.face;
    var rim = locked ? ['#5b5f68', '#1a1c20'] : T.rim;
    var ink = locked ? '#8b909a' : T.ink;
    var shade = locked ? '#2a2c31' : T.inkShade;
    var uid = 'ga' + (opts.uid || (glyph + '-' + tier)).replace(/[^a-z0-9]/gi, '') + (opts.uniq ? '-' + (++iconSeq) : '');
    var size = opts.size || 64;
    var g = GLYPHS[glyph] || GLYPHS.star;
    var defs = '<defs>' +
      '<linearGradient id="' + uid + 'f" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="' + face[0] + '"/><stop offset="0.55" stop-color="' + face[1] + '"/><stop offset="1" stop-color="' + face[2] + '"/></linearGradient>' +
      '<linearGradient id="' + uid + 'r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + rim[0] + '"/><stop offset="1" stop-color="' + rim[1] + '"/></linearGradient>' +
      '<radialGradient id="' + uid + 'h" cx="0.35" cy="0.25" r="0.6"><stop offset="0" stop-color="#fff" stop-opacity="' + (locked ? 0.08 : 0.55) + '"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>' +
      (tier === 'platinum' ? '<linearGradient id="' + uid + 'i" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd6f7"/><stop offset="0.33" stop-color="#c9f3ff"/><stop offset="0.66" stop-color="#e3ffd9"/><stop offset="1" stop-color="#d9d6ff"/></linearGradient>' : '') +
      '</defs>';
    var frame;
    if (locked || tier === 'bronze') {
      frame = '<circle cx="32" cy="32" r="29" fill="url(#' + uid + 'r)"/>' +
        '<circle cx="32" cy="32" r="25.5" fill="url(#' + uid + 'f)"/>' +
        '<circle cx="32" cy="32" r="27.2" fill="none" stroke="' + (locked ? '#666a73' : '#ffd2a8') + '" stroke-opacity=".35" stroke-width=".8" stroke-dasharray="1.5 2.2"/>';
    } else if (tier === 'silver') {
      frame = '<path d="' + polygon(6, 30, 32, 32, Math.PI / 6) + '" fill="url(#' + uid + 'r)"/>' +
        '<path d="' + polygon(6, 26, 32, 32, Math.PI / 6) + '" fill="url(#' + uid + 'f)"/>' +
        '<path d="' + polygon(6, 28, 32, 32, Math.PI / 6) + '" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width=".8"/>';
    } else if (tier === 'gold') {
      frame = '<path d="' + rosette(12, 31, 27.5, 32, 32) + '" fill="url(#' + uid + 'r)"/>' +
        '<circle cx="32" cy="32" r="25" fill="url(#' + uid + 'f)"/>' +
        '<circle cx="32" cy="32" r="22.5" fill="none" stroke="#fff5c9" stroke-opacity=".55" stroke-width="1"/>' +
        '<circle cx="32" cy="32" r="25" fill="none" stroke="#6b4300" stroke-opacity=".5" stroke-width="1"/>';
    } else {
      frame = '<path d="' + rosette(8, 31.5, 25, 32, 32) + '" fill="url(#' + uid + 'i)" opacity=".95"/>' +
        '<path d="' + polygon(8, 27, 32, 32, Math.PI / 8) + '" fill="url(#' + uid + 'r)"/>' +
        '<path d="' + polygon(8, 24, 32, 32, Math.PI / 8) + '" fill="url(#' + uid + 'f)"/>' +
        '<path d="' + polygon(8, 24, 32, 32, Math.PI / 8) + '" fill="none" stroke="url(#' + uid + 'i)" stroke-width="1.4"/>' +
        [0, 1, 2, 3].map(function (i) { var a = -Math.PI / 2 + i * Math.PI / 2; return '<circle cx="' + (32 + Math.cos(a) * 29).toFixed(1) + '" cy="' + (32 + Math.sin(a) * 29).toFixed(1) + '" r="1.8" fill="#fff"/>'; }).join('');
    }
    var glyphSvg = locked && opts.hidden ? GLYPHS.question(ink, shade) : g(ink, shade, opts.label);
    var drop = '<g transform="translate(0 1.2)" opacity=".35">' + (locked && opts.hidden ? GLYPHS.question('#000', '#000') : g('#000', '#000', opts.label)) + '</g>';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="' + size + '" height="' + size + '" class="gach-icon gach-icon--' + (locked ? 'locked' : tier) + '" aria-hidden="true">' +
      defs + frame + drop + glyphSvg +
      '<ellipse cx="27" cy="20" rx="17" ry="10" fill="url(#' + uid + 'h)"/>' +
      (locked && !opts.hidden ? '<g transform="translate(36 36) scale(.42)"><circle cx="32" cy="32" r="22" fill="#1b1d22" stroke="#6d717b" stroke-width="3"/>' + GLYPHS.lock('#a5aab4', '#1b1d22') + '</g>' : '') +
      '</svg>';
  }

  /* ================================================================== event normalization */

  var KIND_ALIASES = {
    'build-changed': 'build', build: 'build', 'build-saved': 'build',
    'race-finished': 'race', race: 'race', 'race-result': 'race',
    career: 'career', garage: 'garage', economy: 'garage',
    stat: 'stat', stats: 'stat',
    challenge: 'challenge', 'challenge-finished': 'challenge',
    drift: 'drift', endurance: 'endurance', pit: 'endurance',
    replay: 'replay', photo: 'photo',
    profile: 'profile', session: 'session', meta: 'meta', boot: 'session'
  };

  function safeCompute(fnHolder, fnName, args) {
    try { if (fnHolder && typeof fnHolder[fnName] === 'function') return fnHolder[fnName].apply(fnHolder, args); } catch (e) { /* defensive */ }
    return null;
  }

  function estimatePrice(build) {
    var D = CB.data;
    if (!build || !D || typeof D.find !== 'function') return NaN;
    var total = 0;
    var bs = D.find('bodyStyles', get(build, 'body.style'));
    if (bs) total += num(bs.basePrice, 0);
    var pc = D.pathCollections || {};
    for (var path in pc) {
      if (!Object.prototype.hasOwnProperty.call(pc, path)) continue;
      if (path === 'body.style') continue;
      if (get(build, 'engine.type') === 'ev' && /^engine\.(layout|aspiration|fuel|tune|exhaust|cooling)$/.test(path)) continue;
      var opt = D.find(pc[path], get(build, path));
      if (opt) total += num(opt.price, 0) + (path === 'engine.layout' ? num(opt.basePrice, 0) : 0);
    }
    return total;
  }

  function normalizeBuild(ev) {
    var b = ev.build || (CB.state && typeof CB.state.get === 'function' ? safeCompute(CB.state, 'get', []) : null) || null;
    var m = ev.metrics || (b ? safeCompute(CB.physics, 'compute', [b]) : null) || {};
    var price = firstNum(num(ev.price), num(get(ev, 'pricing.total')), NaN);
    if (!isNum(price) && b) {
      var pr = safeCompute(CB.pricing, 'compute', [b, m]);
      price = pr ? firstNum(num(pr.total), num(pr.msrp)) : NaN;
      if (!isNum(price)) price = estimatePrice(b);
    }
    var engType = get(b, 'engine.type');
    return {
      build: b, metrics: m, price: price,
      power: num(m.power_hp), weight: num(m.weight_kg), zeroTo60: num(m.zeroTo60_s), topSpeed: num(m.topSpeed_kph),
      pwr: firstNum(num(m.powerToWeight_hpPerTon), (isNum(num(m.power_hp)) && num(m.weight_kg) > 0) ? m.power_hp / (m.weight_kg / 1000) : NaN),
      downforce: num(m.downforce_kg_200), latG: num(m.lateralG), ratings: m.ratings || {},
      engineType: engType, isEV: engType === 'ev', isHybrid: engType === 'hybrid',
      layout: engType === 'ev' ? 'ev' : get(b, 'engine.layout'),
      style: get(b, 'body.style'), presetId: get(b, 'meta.presetId'),
      // a build loaded straight from a preset or set by Auto-config (stock spec) was not built by the player:
      // it pays no "built a car" reward until it differs from what it was loaded from
      unmodified: typeof ev.unmodified === 'boolean' ? ev.unmodified : isUncustomised(b)
    };
  }

  function stripMeta(b) { var c = {}; for (var k in b) if (k !== 'meta' && Object.prototype.hasOwnProperty.call(b, k)) c[k] = b[k]; return c; }
  function sameSpec(a, b) {
    var St = CB.state, n = function (x) { return St && typeof St.normalize === 'function' ? (safeCompute(St, 'normalize', [x]) || x) : x; };
    try { return JSON.stringify(stripMeta(n(a))) === JSON.stringify(stripMeta(n(b))); } catch (e) { return false; }
  }
  /** True when the build is exactly its preset (meta.presetId) or its model's factory spec (CB.stock.isStock). */
  function isUncustomised(b) {
    if (!b || typeof b !== 'object') return false;
    var pid = get(b, 'meta.presetId');
    if (pid && CB.data && typeof CB.data.presetBuild === 'function') {
      var p = safeCompute(CB.data, 'presetBuild', [pid]);
      if (p && sameSpec(b, p)) return true;
    }
    return !!(CB.stock && typeof CB.stock.isStock === 'function' && safeCompute(CB.stock, 'isStock', [b]));
  }

  function carsOf(res) {
    if (!res) return [];
    if (Array.isArray(res)) return res;
    var c = res.cars || res.order || res.classification || res.standings || res.results || res.finishOrder;
    return Array.isArray(c) ? c : [];
  }

  function trackList() {
    var T = CB.race && CB.race.tracks;
    var L = T && Array.isArray(T.list) ? T.list : null;
    if (!L || !L.length) return ['forge-speedway', 'porto-vecchio', 'forge-ring', 'akagane-pass', 'little-anvil', 'neon-harbour', 'ouroboros'];
    return L.filter(function (t) { return t && t.id && !t.challenge && !t.hidden && !t.isChallenge && !(t.kind && t.kind !== 'circuit') && !/^(ch|challenge)[-_]/.test(t.id); })
      .map(function (t) { return t.id; });
  }
  function trackLength(id) {
    var T = CB.race && CB.race.tracks;
    var L = T && Array.isArray(T.list) ? T.list : [];
    for (var i = 0; i < L.length; i++) if (L[i] && L[i].id === id) return num(L[i].length_m, NaN);
    return NaN;
  }

  /** true = tyres were changed at a stop, false = known untouched, null = unknown (stops made but no tyre data). */
  function tyresChanged(endur, st, player) {
    var lists = [endur.pits, st.pits, player.pitLog, get(player, 'endurance.pits')];
    var seen = false, logKnown = 0;
    for (var i = 0; i < lists.length; i++) {
      if (!Array.isArray(lists[i])) continue;
      for (var j = 0; j < lists[i].length; j++) {
        var p = lists[i][j];
        if (!p) continue;
        var bd = p.breakdown, t = p.tires != null ? p.tires : p.tiresChanged != null ? p.tiresChanged : get(p, 'breakdown.tires');
        // engine pitLog rows carry endurance.pitStop()'s breakdown: [{label:'4 tyres (Medium)', seconds}, ...]
        if (t == null && Array.isArray(bd)) t = bd.some(function (b) { return b && /tyre|tire/i.test(String(b.label || '')) && !/no refuel/i.test(String(b.label || '')); });
        if (t === true || num(t, 0) > 0) return true;
        if (t != null) { seen = true; if (lists[i] === player.pitLog) logKnown++; }
      }
    }
    var lp = endur.lastPit || st.lastPit || null;
    if (lp) {
      var lt = lp.tires != null ? lp.tires : lp.tiresChanged;
      if (lt === true || num(lt, 0) > 0) return true;
      if (lt != null) seen = true;
    }
    var stops = firstNum(num(endur.pitStops), num(st.pitStops), num(player.pitStops), 0);
    if (stops <= 0) return false;
    // A single lastPit only describes the final stop; with more stops and no full log the earlier ones are unknown.
    if (seen && (logKnown >= stops || Array.isArray(endur.pits) || Array.isArray(st.pits) || stops <= 1)) return false;
    return null;
  }

  function normalizeRace(ev) {
    var res = ev.results || {};
    var cfg = ev.config || res.config || {};
    var st = ev.stats || res.stats || {};
    var cars = carsOf(res).slice();
    var pid = first(cfg.playerId, res.playerId, ev.playerId);
    var player = null, pIdx = -1;
    for (var i = 0; i < cars.length; i++) if (cars[i] && (cars[i].isPlayer || (pid !== undefined && cars[i].id === pid))) { player = cars[i]; pIdx = i; break; }
    if (!player && ev.player) player = ev.player;
    if (!player && res.player && typeof res.player === 'object') player = res.player;
    player = player || {};
    var fieldSize = cars.length || (Array.isArray(cfg.opponents) ? cfg.opponents.length + 1 : num(cfg.opponents, 0) + 1) || 1;
    var position = firstNum(num(player.position), num(player.pos), num(st.position), pIdx >= 0 ? pIdx + 1 : NaN);
    var grid = firstNum(num(player.gridPosition), num(player.startPosition), num(player.grid), num(st.startPosition), num(st.gridPosition));
    var dnf = !!(player.dnf === true || st.dnf === true || player.status === 'dnf' || player.dnfReason);
    var mode0 = cfg.mode || res.mode || st.mode || 'race';
    // engine classification rows carry status 'finished'|'running'|'dnf'; snapshot cars carry finished bool
    var finished = !dnf && (player.finished === true || player.status === 'finished' ||
      (player.finished !== false && player.status !== 'running') || (player.status === 'running' && mode0 !== 'race' && res.complete !== false));
    var laps = firstNum(num(cfg.laps), num(res.lapsTotal), num(st.laps));
    var flObj = res.fastestLap || ev.fastestLap || null;
    var fastestLap = !!(st.fastestLap || player.fastestLap === true || player.isFastest === true || (flObj && player.id !== undefined && flObj.carId === player.id));
    if (!flObj && !fastestLap && isNum(num(player.bestLap_s)) && cars.length > 1) {
      var best = Infinity;
      cars.forEach(function (c) { var b = num(c && c.bestLap_s); if (isNum(b) && b > 0 && b < best) best = b; });
      fastestLap = isNum(best) && num(player.bestLap_s) <= best;
    }
    var pbl = Array.isArray(player.positionsByLap) ? player.positionsByLap.filter(isNum) : null;
    var lapsLed = firstNum(num(player.lapsLed), num(st.lapsLed), pbl && pbl.length ? pbl.filter(function (p) { return p === 1; }).length : NaN);
    var ledEveryLap = !!(player.ledEveryLap || st.ledEveryLap || (isNum(lapsLed) && isNum(laps) && laps > 0 && lapsLed >= laps) ||
      (pbl && pbl.length && isNum(laps) && pbl.length >= laps && pbl.every(function (p) { return p === 1; })));
    var evts = Array.isArray(ev.events) ? ev.events : Array.isArray(res.events) ? res.events : [];
    var evCollisions = 0, evWall = 0;
    evts.forEach(function (e) {
      if (!e || (player.id !== undefined && e.carId !== player.id && e.otherId !== player.id)) return;
      if (e.type === 'collision') evCollisions++; else if (e.type === 'wall') evWall++;
    });
    var collisions = firstNum(num(player.collisions), num(st.collisions), evts.length ? evCollisions : NaN);
    var wallHits = firstNum(num(player.wallHits), num(st.wallHits), evts.length ? evWall : NaN);
    var penalties = firstNum(num(player.penalties_s), num(st.penalties_s), 0);
    var trackLimits = firstNum(num(player.trackLimits), num(st.trackLimits), 0);
    var clean = st.cleanRace === true || player.cleanRace === true ||
      (st.cleanRace !== false && penalties <= 0 && trackLimits <= 0 && (isNum(collisions) ? collisions === 0 : true) && (isNum(wallHits) ? wallHits === 0 : true));
    var tTime = function (c) { var tt = num(c.totalTime_s); if (isNum(tt)) return tt; tt = num(c.total_s); if (isNum(tt)) return tt; return firstNum(num(c.finishTime_s), num(c.raceTime_s)) + num(c.penalties_s, 0); };
    var margin = num(st.margin_s);
    if (!isNum(margin) && position === 1 && cars.length > 1) {
      var me = tTime(player), second = null;
      cars.forEach(function (c) { if (c && c !== player && num(c.position) === 2) second = c; });
      if (!second) second = cars.filter(function (c) { return c !== player; })[0];
      if (second && isNum(me) && isNum(tTime(second))) margin = tTime(second) - me;
    }
    var topSpeed = firstNum(num(st.topSpeed_kph), num(player.topSpeed_kph), num(player.maxSpeed_kph), isNum(num(player.maxSpeed)) ? player.maxSpeed * 3.6 : NaN);
    var extras = cfg.extras || {};
    var eventType = first(ev.eventType, extras.eventType, cfg.eventType, st.eventType) || null;
    var trackId = first(cfg.trackId, res.trackId, st.trackId) || null;
    var dist = firstNum(num(st.distance_km), isNum(num(player.distance_m)) ? player.distance_m / 1000 : NaN);
    if (!isNum(dist)) {
      var tl = firstNum(num(res.trackLength_m), trackLength(trackId));
      var lapsDone = firstNum(typeof player.laps === 'number' ? player.laps : NaN, Array.isArray(player.lapTimes) ? player.lapTimes.length : NaN, num(player.lap), finished ? laps : NaN);
      if (isNum(tl) && isNum(lapsDone)) dist = tl * lapsDone / 1000;
    }
    var difficulty = first(cfg.difficulty, cfg.aiDifficulty, get(cfg, 'ai.difficulty'), st.difficulty) || null;
    var endur = ev.endurance || st.endurance || player.endurance || {};
    var build = player.build || cfg.playerBuild || ev.build || null;
    var engType = get(build, 'engine.type');
    return {
      res: res, cfg: cfg, player: player, cars: cars, fieldSize: fieldSize,
      position: position, grid: grid, finished: finished, dnf: dnf,
      // a Practice session is ranked by best lap and starts in grid order: no win, podium or pole there
      won: finished && position === 1 && fieldSize >= 2 && mode0 !== 'practice',
      podium: finished && position <= 3 && fieldSize >= 3 && mode0 !== 'practice',
      last: finished && fieldSize >= 2 && position === fieldSize && mode0 !== 'practice',
      pole: !!(st.pole || player.pole || grid === 1) && mode0 !== 'practice', fastestLap: fastestLap, ledEveryLap: ledEveryLap, lapsLed: lapsLed,
      collisions: collisions, wallHits: wallHits, penalties: penalties, trackLimits: trackLimits, clean: clean,
      margin: margin, topSpeed: topSpeed, laps: laps, trackId: trackId, mode: mode0,
      // a standing start from the lights: a Race (not Time Trial / Practice, not a drift event, not a rolling start)
      standingStart: mode0 === 'race' && !isNum(firstNum(num(st.driftScore), num(player.driftScore), num(ev.driftScore))) &&
        eventType !== 'drift' && String(first(cfg.discipline, extras.discipline) || '').toLowerCase() !== 'drift' && !cfg.rollingStart && !cfg.drift,
      weather: cfg.weather || res.weather || st.weather || 'dry', timeOfDay: cfg.timeOfDay || res.timeOfDay || st.timeOfDay || 'day',
      difficulty: difficulty ? String(difficulty).toLowerCase() : null, eventType: eventType ? String(eventType).toLowerCase() : null,
      endurance: !!(extras.endurance || eventType === 'endurance' || endur.enabled),
      pitStops: firstNum(num(endur.pitStops), num(st.pitStops), num(player.pitStops), 0),
      fuelLeft: firstNum(num(endur.fuelLeft_l), num(st.fuelLeft_l), num(get(player, 'endurance.fuel_l'))),
      tireWear: endur.tireWear || st.tireWear || get(player, 'endurance.tireWear') || null,
      tireAges: Array.isArray(endur.tireAge_laps) ? endur.tireAge_laps : Array.isArray(st.tireAge_laps) ? st.tireAge_laps : null,
      tyresChanged: tyresChanged(endur, st, player),
      damage: endur.damage || get(player, 'endurance.damage') || null,
      drift: firstNum(num(st.driftScore), num(player.driftScore), num(ev.driftScore)),
      distance: dist, bestLap: num(player.bestLap_s), lapValid: player.lapValid !== false,
      overtakes: firstNum(num(st.overtakes), num(player.overtakes)),
      build: build, isEV: engType === 'ev',
      power: firstNum(num(player.power_hp), num(get(player, 'metrics.power_hp')), num(st.power_hp))
    };
  }

  var TIER_KEYS = ['rookie', 'national', 'continental', 'world', 'hypercar'];
  function careerTierIndex(ev) {
    var idx = firstNum(num(ev.tierIndex), num(get(ev, 'tier.index')));
    if (isNum(idx)) return idx;
    var tid = first(ev.tierId, typeof ev.tier === 'string' ? ev.tier : get(ev, 'tier.id'), get(ev, 'championship.tierId'), get(ev, 'championship.tier'));
    var C = CB.game && CB.game.career, tiers = C && C.catalog && (C.catalog.tiers || (Array.isArray(C.catalog) ? C.catalog : null));
    if (tid != null && Array.isArray(tiers)) for (var i = 0; i < tiers.length; i++) if (tiers[i] && (tiers[i].id === tid || tiers[i].name === tid)) return i;
    if (tid == null && ev.champId && Array.isArray(tiers)) {
      for (var j = 0; j < tiers.length; j++) {
        var champs = tiers[j] && (tiers[j].championships || tiers[j].champs) || [];
        for (var k = 0; k < champs.length; k++) if (champs[k] && champs[k].id === ev.champId) return j;
      }
    }
    var s = String(tid || ev.champId || '').toLowerCase();
    for (var t = 0; t < TIER_KEYS.length; t++) if (s.indexOf(TIER_KEYS[t]) >= 0) return t;
    if (/gt/.test(s)) return 1;
    return NaN;
  }

  /** Rival id of a rivals-duel event (catalog champ.rival), falling back to the event id so each duel stays distinct. */
  function champRival(champId) {
    if (!champId) return null;
    var C = CB.game && CB.game.career, cat = C && C.catalog;
    var list = cat && (Array.isArray(cat.championships) ? cat.championships : Array.isArray(cat.events) ? cat.events : null);
    if (list) for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === champId && list[i].rival) return typeof list[i].rival === 'string' ? list[i].rival : (list[i].rival.id || champId);
    return champId;
  }

  /** Championship-level event type from the career catalog (a duel's last round may itself be a drag/endurance round). */
  function champEventType(champId) {
    if (!champId) return null;
    var C = CB.game && CB.game.career, cat = C && C.catalog, c = null;
    if (cat && cat.byId && cat.byId[champId]) c = cat.byId[champId];
    else if (C && typeof C.getChampionship === 'function') { try { c = C.getChampionship(champId); } catch (e) { c = null; } }
    return c && c.eventType ? String(c.eventType).toLowerCase() : null;
  }

  function normalizeCareer(ev) {
    var action = String(ev.action || ev.kind || '').toLowerCase();
    var champComplete = action === 'championship-complete' || action === 'championship' || !!ev.championshipComplete;
    var standings = Array.isArray(ev.standings) ? ev.standings : [];
    var me = null;
    standings.forEach(function (s, i) { if (s && (s.isPlayer || s.player)) me = { pos: firstNum(num(s.position), i + 1), s: s }; });
    var champPos = firstNum(num(ev.position), num(get(ev, 'trophy.position')), me ? me.pos : NaN, ev.trophy && champComplete ? 1 : NaN);
    var eventType = ev.eventType ? String(ev.eventType).toLowerCase() : null;
    // a completed championship / event is classified by its own type, not by the format of its final round
    var cType = first(ev.champEventType, ev.championshipEventType, champEventType(ev.champId || get(ev, 'championship.id')));
    if (cType && (champComplete || !eventType)) eventType = String(cType).toLowerCase();
    // championship-complete payloads (career.js / hub.js) carry the standings rows: {wins, starts, finishes[]}
    var myWins = me ? num(me.s.wins, 0) : 0;
    var myRounds = me ? Math.max(Array.isArray(me.s.finishes) ? me.s.finishes.length : 0, num(me.s.starts, 0), num(ev.rounds, 0)) : 0;
    var roundPos = firstNum(num(ev.roundPosition), num(ev.finishPosition), action === 'round-complete' ? num(ev.position) : NaN);
    return {
      action: action, champId: ev.champId || get(ev, 'championship.id') || null,
      tier: careerTierIndex(ev), champComplete: champComplete, champPos: champComplete ? champPos : NaN,
      champWon: champComplete && champPos === 1,
      perfect: !!(ev.perfect || ev.perfectSeason || (champComplete && get(ev, 'trophy.perfect') === true && !(me && myRounds < 2)) ||
        (champComplete && isNum(num(ev.wins)) && isNum(num(ev.rounds)) && ev.wins >= ev.rounds && ev.rounds > 0) ||
        (champComplete && me && myRounds >= 2 && myWins >= myRounds)),
      roundComplete: action === 'round-complete' || action === 'round' || (!!ev.pointsTable && !champComplete),
      roundPos: roundPos,
      rivalBeaten: action === 'rival-defeated' || action === 'rival-beaten' || !!ev.rivalDefeated || (champComplete && champPos === 1 && eventType === 'rivals'),
      rivalId: ev.rivalId || (typeof ev.rival === 'string' ? ev.rival : get(ev, 'rival.id')) || (eventType === 'rivals' ? champRival(ev.champId) : null),
      eventType: eventType,
      eventWon: (champComplete || action === 'event-complete' || action === 'special-event') && (champComplete ? champPos : num(ev.position)) === 1,
      garage: /^(car-)?(purchased|purchase|buy|bought|sold|sell|repair|repaired|upgrade|upgraded)$/.test(action) ? action.replace(/^car-/, '') : null
    };
  }

  function garageAction(a) {
    a = String(a || '').toLowerCase().replace(/^car-/, '');
    if (/^(buy|bought|purchase|purchased)$/.test(a)) return 'buy';
    if (/^(sell|sold)$/.test(a)) return 'sell';
    if (/^(repair|repaired)$/.test(a)) return 'repair';
    if (/^(upgrade|upgraded)$/.test(a)) return 'upgrade';
    return a || null;
  }

  function normalize(ev, opts) {
    ev = ev || {};
    var kind = KIND_ALIASES[String(ev.type || '').toLowerCase()] || 'other';
    var ctx = { kind: kind, ev: ev, now: num((opts && opts.now), num(ev.now, Date.now())) };
    if (kind === 'build') ctx.b = normalizeBuild(ev);
    if (kind === 'race') ctx.r = normalizeRace(ev);
    if (kind === 'career') { ctx.c = normalizeCareer(ev); if (ctx.c.garage) ctx.g = garageAction(ctx.c.garage); }
    if (kind === 'garage') ctx.g = garageAction(ev.action);
    if (kind === 'challenge') ctx.ch = { id: ev.id || ev.challengeId || null, medal: ev.medal ? String(ev.medal).toLowerCase() : null, score: num(ev.score) };
    if (kind === 'drift') ctx.d = { score: num(ev.score, 0), combo: num(ev.combo, 0), duration: num(ev.duration_s, 0) };
    if (kind === 'endurance') ctx.en = { pit: ev.action === 'pit' || ev.type === 'pit' || !!ev.pitStop };
    if (kind === 'race' && ctx.r && isNum(ctx.r.drift)) ctx.d = { score: ctx.r.drift, combo: num(get(ev, 'stats.driftCombo'), 0), duration: 0 };
    if (kind === 'stat') {
      ctx.stats = {};
      if (ev.stats && typeof ev.stats === 'object') for (var k in ev.stats) ctx.stats[k] = ev.stats[k];
      if (ev.key) ctx.stats[ev.key] = ev.value;
    }
    return ctx;
  }

  /* ================================================================== definitions */

  var DEFS = [];
  var BY_ID = {};

  function def(d) {
    d.tier = d.tier || 'bronze';
    var T = TIERS[d.tier];
    d.xp = isNum(d.xp) ? d.xp : T.xp;
    d.credits = isNum(d.credits) ? d.credits : T.credits;
    d.category = d.category || 'atelier';
    d.glyph = d.glyph || 'star';
    d.on = d.on || [];
    d.icon = icon(d.glyph, d.tier, { label: d.label, uid: d.id });
    if (BY_ID[d.id]) throw new Error('duplicate achievement id ' + d.id);
    BY_ID[d.id] = d;
    DEFS.push(d);
    return d;
  }

  function stat(P, key) { return num(get(P, 'stats.' + key), 0); }
  function maxOf(d, P) { return typeof d.max === 'function' ? d.max(P) : d.max; }

  /** Predicate achievement on one event kind. */
  function when(id, name, desc, tier, glyph, category, on, fn, extra) {
    var d = { id: id, name: name, desc: desc, tier: tier, glyph: glyph, category: category, on: [].concat(on), when: fn };
    if (extra) for (var k in extra) d[k] = extra[k];
    return def(d);
  }
  function buildIs(id, name, desc, tier, glyph, fn, extra) {
    return when(id, name, desc, tier, glyph, 'atelier', 'build', function (ctx) { return !!ctx.b && !!ctx.b.build && !ctx.b.unmodified && !!fn(ctx.b, ctx.b.build, ctx.b.metrics); }, extra);
  }
  function raceIs(id, name, desc, tier, glyph, fn, extra) {
    return when(id, name, desc, tier, glyph, (extra && extra.category) || 'racing', 'race', function (ctx) { return !!ctx.r && !!fn(ctx.r, ctx); }, extra);
  }

  /** Counter achievement: progress = max(profile.stats[statKey], own tally of qualifying events). */
  function counter(id, name, desc, tier, glyph, category, statKey, max, on, inc, extra) {
    var d = {
      id: id, name: name, desc: desc, tier: tier, glyph: glyph, category: category, on: [].concat(on || []), always: !!statKey, max: max,
      track: inc ? function (ctx, tr) { var n = num(inc(ctx), 0); if (n) tr.tally = num(tr.tally, 0) + n; } : null,
      measure: function (P, tr) { return Math.max(statKey ? stat(P, statKey) : 0, num(tr && tr.tally, 0)); }
    };
    if (extra) for (var k in extra) d[k] = extra[k];
    return def(d);
  }

  /** Set-collection achievement: collect distinct keys. */
  function collect(id, name, desc, tier, glyph, category, on, keyFn, max, extra) {
    var d = {
      id: id, name: name, desc: desc, tier: tier, glyph: glyph, category: category, on: [].concat(on), max: max,
      track: function (ctx, tr) {
        var keys = [].concat(keyFn(ctx) || []);
        tr.items = Array.isArray(tr.items) ? tr.items : [];
        keys.forEach(function (k) { if (k != null && k !== '' && tr.items.indexOf(k) < 0) tr.items.push(k); });
      },
      measure: function (P, tr) {
        var items = (tr && tr.items) || [];
        var universe = d.universe ? d.universe() : null;
        return universe ? items.filter(function (k) { return universe.indexOf(k) >= 0; }).length : items.length;
      }
    };
    if (extra) for (var k in extra) d[k] = extra[k];
    return def(d);
  }

  /** Profile-state achievement checked on every event (credits, garage, level…). */
  function state(id, name, desc, tier, glyph, category, measure, max, extra) {
    var d = { id: id, name: name, desc: desc, tier: tier, glyph: glyph, category: category, on: [], always: true, max: max, measure: function (P) { return num(measure(P), 0); } };
    if (extra) for (var k in extra) d[k] = extra[k];
    return def(d);
  }

  /* ------------------------------------------------------------------ Atelier */

  buildIs('first-commission', 'Opening Commission', 'Commission your first car, in the Garage or the showroom.', 'bronze', 'wrench', function () { return true; }, { xp: 100, credits: 1000 });
  buildIs('bespoke', 'Bespoke', 'Specify a build costing more than $500,000.', 'silver', 'diamond', function (b) { return b.price > 500000; });
  buildIs('seven-figures', 'Seven Figures', 'Specify a build costing more than $1,000,000.', 'gold', 'diamond', function (b) { return b.price > 1000000; });
  buildIs('shoestring', 'Shoestring', 'Configure a car under $35,000 that still makes 150 hp or more.', 'bronze', 'coin', function (b) { return b.price > 0 && b.price < 35000 && b.power >= 150; });
  buildIs('featherweight', 'Featherweight', 'Engineer a car weighing less than 900 kg.', 'silver', 'feather', function (b) { return b.weight > 0 && b.weight < 900; });
  buildIs('land-yacht', 'Land Yacht', 'Build something heavier than 3,000 kg. Bring a tugboat.', 'bronze', 'garage', function (b) { return b.weight > 3000; });
  buildIs('half-thousand', 'Half a Thousand', 'Reach 500 horsepower.', 'bronze', 'horseshoe', function (b) { return b.power >= 500; });
  buildIs('thousand-horses', 'Thousand Horses', 'Reach 1,000 horsepower.', 'gold', 'horseshoe', function (b) { return b.power >= 1000; });
  buildIs('two-thousand', 'Stampede', 'Reach 2,000 horsepower. Absolutely unnecessary.', 'platinum', 'number', function (b) { return b.power >= 2000; }, { label: '2K', hidden: true, hint: 'Some say more is never enough…' });
  buildIs('silent-running', 'Silent Running', 'Commission a fully electric build.', 'bronze', 'battery', function (b) { return b.isEV; });
  buildIs('best-of-both', 'Best of Both', 'Commission a hybrid build.', 'bronze', 'leaf', function (b) { return b.isHybrid; });
  buildIs('three-second-club', 'Three-Second Club', 'Build a car that does 0-60 mph in under 3.0 seconds.', 'silver', 'stopwatch', function (b) { return b.zeroTo60 > 0 && b.zeroTo60 < 3.0; });
  buildIs('warp-factor', 'Warp Factor', 'Build a car that does 0-60 mph in under 2.0 seconds.', 'gold', 'bolt', function (b) { return b.zeroTo60 > 0 && b.zeroTo60 < 2.0; });
  buildIs('paper-ton', 'Theoretical Ton', 'Engineer a calculated top speed of 400 km/h or more.', 'silver', 'gauge', function (b) { return b.topSpeed >= 400; });
  buildIs('power-density', 'Power Density', 'Exceed 1,000 hp per tonne.', 'gold', 'bolt', function (b) { return b.pwr >= 1000; });
  buildIs('inverted-flight', 'Inverted Flight', 'Generate 300 kg of downforce at 200 km/h.', 'silver', 'wing', function (b) { return b.downforce >= 300; });
  buildIs('glue', 'Glue', 'Build a car capable of 1.6 g of lateral grip.', 'silver', 'tire', function (b) { return b.latG >= 1.6; });
  buildIs('sixteen', 'Sixteen', 'Fit the W16 — four turbos, sixteen cylinders, one ego.', 'silver', 'number', function (b, B) { return b.engineType !== 'ev' && get(B, 'engine.layout') === 'W16'; }, { label: 'W16' });
  buildIs('brap-brap', 'Brap Brap', 'Fit a twin-rotor Wankel.', 'bronze', 'gear', function (b, B) { return b.engineType !== 'ev' && get(B, 'engine.layout') === 'rotary-2'; });
  buildIs('twelve-cylinders', 'Operatic', 'Fit a V12.', 'bronze', 'number', function (b, B) { return b.engineType !== 'ev' && get(B, 'engine.layout') === 'V12'; }, { label: 'V12' });
  buildIs('oil-burner', 'Oil Burner', 'Run a diesel engine.', 'bronze', 'fuel', function (b, B) { return b.engineType !== 'ev' && get(B, 'engine.fuel') === 'diesel'; });
  buildIs('screamer', 'Screamer', 'Set the redline to 9,500 rpm.', 'bronze', 'gauge', function (b, B) { return b.engineType !== 'ev' && num(get(B, 'engine.redline_rpm'), 0) >= 9500; });
  buildIs('antisocial', 'Antisocial', 'Straight pipes and a Time Attack map. The neighbours have questions.', 'bronze', 'flame', function (b, B) { return get(B, 'engine.exhaust') === 'straight-pipe' && get(B, 'engine.tune') === 'time-attack' && b.engineType !== 'ev'; }, { hidden: true, hint: 'Make as much noise as legally impossible.' });
  buildIs('carbon-addict', 'Carbon Addict', 'Carbon monocoque, carbon wheels, carbon-ceramic brakes and carbon aero — all at once.', 'gold', 'diamond', function (b, B) {
    return get(B, 'body.chassisMaterial') === 'carbon-monocoque' && get(B, 'wheels.material') === 'carbon' && get(B, 'brakes.material') === 'carbon-ceramic' &&
      /^(carbon|race)$/.test(get(B, 'aero.splitter') || '') && /^(carbon|race)$/.test(get(B, 'aero.diffuser') || '');
  });
  buildIs('homologation', 'Homologation Special', 'Slicks, a full cage, FIA race shells and a harness.', 'silver', 'helmet', function (b, B) {
    return get(B, 'tires.compound') === 'slick' && get(B, 'weight.rollCage') === 'full' && get(B, 'interior.seatType') === 'race-shell' && !!get(B, 'interior.harness');
  });
  buildIs('grand-salon', 'Grand Salon', 'Lounge massage seats, semi-aniline hide and a Concert Hall audio system.', 'silver', 'seat', function (b, B) {
    return get(B, 'interior.seatType') === 'lounge' && get(B, 'interior.upholstery') === 'semi-aniline' && get(B, 'tech.audio') === 'concert';
  });
  buildIs('sleeper', 'Sleeper', 'A wagon, sedan or van with 700+ hp, no stripes and no badges.', 'gold', 'eye', function (b, B) {
    return /^(wagon|sedan|van)$/.test(b.style || '') && b.power >= 700 && get(B, 'exterior.stripe') === 'none' && get(B, 'exterior.badge') === 'delete' && !get(B, 'exterior.livery_number');
  }, { hidden: true, hint: 'Nothing to see here. Move along.' });
  buildIs('chameleon', 'Chameleon', 'Paint a car in a colour-shifting chameleon finish.', 'bronze', 'palette', function (b, B) { return get(B, 'exterior.finish') === 'chameleon'; });
  buildIs('hypermiler', 'Hypermiler', 'Achieve under 4.0 L/100 km — or under 130 Wh/km in an EV.', 'silver', 'leaf', function (b, B, m) {
    return b.isEV ? (num(m.efficiency_whkm) > 0 && num(m.efficiency_whkm) < 130) : (num(m.fuelEconomy_l100) > 0 && num(m.fuelEconomy_l100) < 4.0);
  });
  buildIs('long-haul', 'Long Haul', 'Build a car with a range of 900 km or more.', 'silver', 'road', function (b, B, m) { return num(m.range_km, 0) >= 900; });
  buildIs('mud-plugger', 'Mud Plugger', 'An SUV or pickup on all-terrains with a locking diff and 200 mm+ of ride height.', 'bronze', 'mountain', function (b, B) {
    return /^(suv|pickup)$/.test(b.style || '') && get(B, 'tires.compound') === 'all-season' && num(get(B, 'suspension.rideHeight_mm'), 0) >= 200 &&
      (get(B, 'drivetrain.rearDiff') === 'locking' || get(B, 'drivetrain.frontDiff') === 'locking' || get(B, 'drivetrain.centerDiff') === 'locking');
  });
  buildIs('momentum-car', 'Momentum Car', 'A roadster under 1,000 kg with fewer than 200 hp. Never lift.', 'silver', 'feather', function (b) { return b.style === 'roadster' && b.weight > 0 && b.weight < 1000 && b.power > 0 && b.power < 200; });
  buildIs('save-the-manuals', 'Save the Manuals', 'Three pedals, rear-wheel drive and 600+ hp.', 'bronze', 'gear', function (b, B) { return get(B, 'transmission.type') === 'manual' && get(B, 'drivetrain.layout') === 'rwd' && b.power >= 600; });
  buildIs('no-nannies', 'No Nannies', 'Traction control off and ABS off. Pure, terrifying feedback.', 'bronze', 'skull', function (b, B) { return num(get(B, 'drivetrain.tractionControl'), 1) === 0 && get(B, 'brakes.abs') === 'off'; }, { hidden: true, hint: 'Who needs electronics?' });
  buildIs('full-house', 'Full House', 'Configure a car with eight or more seats.', 'bronze', 'seat', function (b, B) { return num(get(B, 'body.seats'), 0) >= 8; });
  buildIs('track-ready', 'Track Ready', 'Reach a track rating of 95 or more.', 'gold', 'flag', function (b) { return num(b.ratings.track, 0) >= 95; });
  buildIs('gilded', 'Gilded Lily', 'Chrome paint, laser lights and a forged-carbon trim. Subtle.', 'bronze', 'crown', function (b, B) { return get(B, 'exterior.finish') === 'chrome' && get(B, 'exterior.lights') === 'laser' && get(B, 'interior.trim') === 'forged-carbon'; }, { hidden: true, hint: 'More is more.' });

  var BODY_IDS = ['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van'];
  function bodyUniverse() { var L = CB.data && CB.data.bodyStyles; return Array.isArray(L) && L.length ? L.map(function (x) { return x.id; }) : BODY_IDS; }
  function engineUniverse() { var L = CB.data && CB.data.engineLayouts; return (Array.isArray(L) && L.length ? L.map(function (x) { return x.id; }) : ['I3', 'I4', 'I5', 'I6', 'V6', 'V8', 'V10', 'V12', 'W16', 'flat-4', 'flat-6', 'rotary-2']).concat(['ev']); }
  function presetUniverse() { var L = CB.data && CB.data.presets; return Array.isArray(L) && L.length ? L.map(function (x) { return x.id; }) : null; }

  collect('body-collector', 'Coachbuilder', 'Design a car in every body style.', 'gold', 'garage', 'atelier', 'build',
    function (ctx) { return ctx.b && !ctx.b.unmodified && ctx.b.style; }, function () { return bodyUniverse().length; }, { universe: bodyUniverse });
  collect('engine-sommelier', 'Engine Sommelier', 'Try every engine layout — and an electric drivetrain.', 'gold', 'piston', 'atelier', 'build',
    function (ctx) { return ctx.b && !ctx.b.unmodified && ctx.b.layout; }, function () { return engineUniverse().length; }, { universe: engineUniverse });
  collect('showroom-tour', 'Showroom Tour', 'Load eight different factory presets.', 'silver', 'key', 'atelier', 'build',
    function (ctx) { return ctx.b && ctx.b.presetId; }, 8);
  counter('tinkerer', 'Tinkerer', 'Make 100 changes in the Garage.', 'bronze', 'wrench', 'atelier', null, 100, 'build', function () { return 1; });
  counter('obsessive', 'Obsessive', 'Make 1,000 changes in the Garage.', 'silver', 'wrench', 'atelier', null, 1000, 'build', function () { return 1; });

  /* ------------------------------------------------------------------ Racing */

  raceIs('lights-out', 'Lights Out', 'Finish your first race from a standing start.', 'bronze', 'flag', function (r) { return r.finished && r.standingStart; }, { xp: 150, credits: 1500 });
  raceIs('first-win', 'First Win', 'Win a race against at least one opponent.', 'bronze', 'trophy', function (r) { return r.won && r.mode !== 'time-trial'; });
  raceIs('champagne', 'Champagne', 'Finish on the podium.', 'bronze', 'podium', function (r) { return r.podium && r.mode !== 'time-trial'; });
  raceIs('grand-slam', 'Grand Slam', 'Pole, win, fastest lap and lead every lap — all in one race.', 'platinum', 'crown', function (r) { return r.won && r.pole && r.fastestLap && r.ledEveryLap && r.fieldSize >= 4; });
  raceIs('clean-sweep', 'Clean Sweep', 'Win against 7+ rivals with no contact, penalties or track-limit warnings.', 'gold', 'shield', function (r) { return r.won && r.fieldSize >= 8 && r.clean; });
  raceIs('comeback', 'Comeback', 'Win from last on the grid (6+ cars).', 'gold', 'arrowUp', function (r) { return r.won && r.fieldSize >= 6 && r.grid === r.fieldSize; });
  raceIs('charge', 'Through the Field', 'Gain eight or more places in a single race.', 'silver', 'arrowUp', function (r) { return r.finished && isNum(r.grid) && r.grid - r.position >= 8; });
  raceIs('ton-up', 'Ton-Up', 'Hit 400 km/h on track.', 'gold', 'gauge', function (r) { return r.topSpeed >= 400; });
  raceIs('three-hundred', 'Three Hundred Club', 'Hit 300 km/h on track.', 'silver', 'gauge', function (r) { return r.topSpeed >= 300; });
  raceIs('pro-licence', 'Pro Licence', 'Win a race on Pro difficulty or harder.', 'silver', 'helmet', function (r) { return r.won && (r.difficulty === 'pro' || r.difficulty === 'alien'); });
  raceIs('alien-slayer', 'Alien Slayer', 'Win a race against Alien-difficulty opponents (6+ cars).', 'gold', 'skull', function (r) { return r.won && r.difficulty === 'alien' && r.fieldSize >= 6; });
  raceIs('rain-master', 'Rain Master', 'Win a race in the wet.', 'silver', 'drop', function (r) { return r.won && r.weather === 'wet'; });
  raceIs('night-owl', 'Night Owl', 'Win a race at night.', 'bronze', 'moon', function (r) { return r.won && r.timeOfDay === 'night'; });
  raceIs('dominant', 'Dominant', 'Win by more than 10 seconds.', 'silver', 'trophy', function (r) { return r.won && r.margin > 10; });
  raceIs('photo-finish', 'Photo Finish', 'Win by less than a tenth of a second.', 'silver', 'camera', function (r) { return r.won && r.margin >= 0 && r.margin < 0.1; });
  raceIs('marathon', 'Marathon', 'Finish a race of 20 laps or more.', 'silver', 'hourglass', function (r) { return r.finished && r.laps >= 20; });
  raceIs('full-grid', 'Full Grid', 'Finish a race with a full 12-car field.', 'bronze', 'flag', function (r) { return r.finished && r.fieldSize >= 12; });
  raceIs('silent-assassin', 'Silent Assassin', 'Win a race in an electric car.', 'silver', 'battery', function (r) { return r.won && r.isEV; });
  raceIs('hot-lapper', 'Hot Lapper', 'Set a valid lap in Time Trial.', 'bronze', 'stopwatch', function (r) { return r.mode === 'time-trial' && r.bestLap > 0 && r.lapValid; });
  raceIs('giant-killer', 'Giant Killer', 'Win while driving the least powerful car in the field.', 'gold', 'target', function (r) {
    if (!r.won || r.fieldSize < 4 || !isNum(r.power)) return false;
    return r.cars.every(function (c) { var p = firstNum(num(c && c.power_hp), num(get(c, 'metrics.power_hp'))); return c === r.player || !isNum(p) || p >= r.power; });
  });
  raceIs('participation', 'Participation Trophy', 'Finish dead last in a field of six or more.', 'bronze', 'snail', function (r) { return r.last && r.fieldSize >= 6; }, { hidden: true, hint: 'Somebody has to.' });
  raceIs('smoke-mirrors', 'Smoke and Mirrors', 'Fail to finish a race.', 'bronze', 'flame', function (r) { return r.dnf; }, { hidden: true, hint: 'It happens to the best of us.' });
  raceIs('demolition', 'Demolition Derby', 'Make contact ten or more times in a single race.', 'bronze', 'burst', function (r) { return num(r.collisions, 0) >= 10; }, { hidden: true, hint: 'Rubbing is racing. A lot of rubbing is…' });
  raceIs('pole-sitter', 'Pole Sitter', 'Start a race from pole position.', 'bronze', 'number', function (r) { return r.pole && r.fieldSize >= 2; }, { label: 'P1' });

  def({
    id: 'hat-trick', name: 'Hat-Trick', desc: 'Win three races in a row.', tier: 'silver', glyph: 'number', label: '3', category: 'racing', on: ['race'], max: 3,
    track: function (ctx, tr) { var r = ctx.r; if (!r || r.mode === 'time-trial') return; tr.streak = r.won ? num(tr.streak, 0) + 1 : 0; tr.best = Math.max(num(tr.best, 0), tr.streak); },
    measure: function (P, tr) { return num(tr && tr.best, 0); }
  });
  def({
    id: 'unstoppable', name: 'Unstoppable', desc: 'Win ten races in a row.', tier: 'platinum', glyph: 'flame', category: 'racing', on: ['race'], max: 10,
    track: function (ctx, tr) { var r = ctx.r; if (!r || r.mode === 'time-trial') return; tr.streak = r.won ? num(tr.streak, 0) + 1 : 0; tr.best = Math.max(num(tr.best, 0), tr.streak); },
    measure: function (P, tr) { return num(tr && tr.best, 0); }
  });
  collect('world-tour', 'World Tour', 'Finish a race on every circuit.', 'gold', 'globe', 'racing', 'race',
    function (ctx) { return ctx.r && ctx.r.finished ? ctx.r.trackId : null; }, function () { return trackList().length; }, { universe: trackList });
  collect('conqueror', 'Conqueror', 'Win on every circuit.', 'platinum', 'laurel', 'racing', 'race',
    function (ctx) { return ctx.r && ctx.r.won ? ctx.r.trackId : null; }, function () { return trackList().length; }, { universe: trackList });

  /* ------------------------------------------------------------------ Milestones (stats) */

  function raceInc(field) { return function (ctx) { var r = ctx.r; if (!r) return 0; return field(r) ? 1 : 0; }; }
  counter('veteran', 'Veteran', 'Start 25 races.', 'bronze', 'helmet', 'milestones', 'races', 25, 'race', raceInc(function () { return true; }));
  counter('centurion', 'Centurion', 'Start 100 races.', 'gold', 'number', 'milestones', 'races', 100, 'race', raceInc(function () { return true; }), { label: '100' });
  counter('serial-winner', 'Serial Winner', 'Win 10 races.', 'silver', 'trophy', 'milestones', 'wins', 10, 'race', raceInc(function (r) { return r.won; }));
  counter('legend', 'Legend', 'Win 50 races.', 'gold', 'laurel', 'milestones', 'wins', 50, 'race', raceInc(function (r) { return r.won; }));
  counter('podium-regular', 'Podium Regular', 'Finish on the podium 25 times.', 'silver', 'podium', 'milestones', 'podiums', 25, 'race', raceInc(function (r) { return r.podium; }));
  counter('pole-master', 'Pole Master', 'Start from pole 10 times.', 'silver', 'number', 'milestones', 'poles', 10, 'race', raceInc(function (r) { return r.pole && r.fieldSize >= 2; }), { label: 'P1' });
  counter('fastest-lap', 'Purple Sector', 'Set the fastest lap of a race.', 'bronze', 'stopwatch', 'milestones', 'fastestLaps', 1, 'race', raceInc(function (r) { return r.fastestLap && r.fieldSize >= 2; }));
  counter('stopwatch', 'Stopwatch', 'Set the fastest lap in 10 races.', 'silver', 'stopwatch', 'milestones', 'fastestLaps', 10, 'race', raceInc(function (r) { return r.fastestLap && r.fieldSize >= 2; }));
  counter('road-trip', 'Road Trip', 'Drive 1,000 km on track.', 'silver', 'road', 'milestones', 'distance_km', 1000, 'race', function (ctx) { return ctx.r && isNum(ctx.r.distance) ? ctx.r.distance : 0; });
  counter('circumnavigator', 'Circumnavigator', 'Drive 40,075 km — once around the Earth.', 'platinum', 'globe', 'milestones', 'distance_km', 40075, 'race', function (ctx) { return ctx.r && isNum(ctx.r.distance) ? ctx.r.distance : 0; });
  counter('crash-test', 'Crash Test Dummy', 'Crash 100 times. The insurers have your photo.', 'bronze', 'burst', 'milestones', 'crashes', 100, 'race', function (ctx) { return ctx.r ? num(ctx.r.collisions, 0) + num(ctx.r.wallHits, 0) : 0; }, { hidden: true, hint: 'Experience is what you get when you…' });
  def({
    id: 'top-speed-stat', name: 'Velocity', desc: 'Record a top speed of 350 km/h.', tier: 'silver', glyph: 'gauge', category: 'milestones', on: ['race'], always: true, max: 350,
    track: function (ctx, tr) { if (ctx.r && isNum(ctx.r.topSpeed)) tr.best = Math.max(num(tr.best, 0), ctx.r.topSpeed); },
    measure: function (P, tr) { return Math.max(stat(P, 'topSpeed_kph'), num(tr && tr.best, 0)); }
  });

  /* ------------------------------------------------------------------ Career */

  function careerIs(id, name, desc, tier, glyph, fn, extra) {
    return when(id, name, desc, tier, glyph, 'career', 'career', function (ctx) { return !!ctx.c && !!fn(ctx.c, ctx); }, extra);
  }
  careerIs('sign-contract', 'Sign the Contract', 'Complete your first career round.', 'bronze', 'handshake', function (c) { return c.roundComplete || c.champComplete; }, { xp: 150, credits: 2500 });
  careerIs('round-winner', 'Points Leader', 'Win a career championship round.', 'bronze', 'flag', function (c) { return c.roundComplete && c.roundPos === 1; });
  careerIs('champion', 'Champion', 'Win a championship.', 'silver', 'trophy', function (c) { return c.champWon; });
  careerIs('rookie-champion', 'Rookie Cup Champion', 'Win a Rookie Cup championship.', 'bronze', 'medal', function (c) { return c.champWon && c.tier === 0; });
  careerIs('national-champion', 'National GT Champion', 'Win a National GT championship.', 'silver', 'medal', function (c) { return c.champWon && c.tier === 1; });
  careerIs('continental-champion', 'Continental Champion', 'Win a Continental Series championship.', 'gold', 'medal', function (c) { return c.champWon && c.tier === 2; });
  careerIs('endurance-champion', 'World Endurance Champion', 'Win a World Endurance championship.', 'gold', 'hourglass', function (c) { return c.champWon && c.tier === 3; });
  careerIs('hypercar-master', 'Hypercar Master', 'Win a Hypercar Masters championship.', 'platinum', 'crown', function (c) { return c.champWon && c.tier === 4; });
  careerIs('perfect-season', 'Perfect Season', 'Win every round of a championship.', 'platinum', 'star', function (c) { return c.champWon && c.perfect; });
  careerIs('runner-up', 'Bridesmaid', 'Finish a championship in second place.', 'bronze', 'number', function (c) { return c.champComplete && c.champPos === 2; }, { label: 'P2', hidden: true, hint: 'So close.' });
  careerIs('nemesis', 'Nemesis', 'Defeat a rival in a one-on-one duel.', 'silver', 'target', function (c) { return c.rivalBeaten; });
  careerIs('drag-king', 'Quarter-Mile King', 'Win a career Drag Race event.', 'silver', 'bolt', function (c) { return c.eventWon && c.eventType === 'drag'; });
  careerIs('last-one-standing', 'Last One Standing', 'Win a career Eliminator event.', 'silver', 'shield', function (c) { return c.eventWon && c.eventType === 'eliminator'; });
  careerIs('brand-ambassador', 'Brand Ambassador', 'Win a Manufacturer Challenge.', 'silver', 'wrench', function (c) { return c.eventWon && /manufacturer/.test(c.eventType || ''); });
  collect('grand-champion', 'Grand Champion', 'Win a championship in all five career tiers.', 'platinum', 'laurel', 'career', 'career',
    function (ctx) { return ctx.c && ctx.c.champWon && isNum(ctx.c.tier) ? 't' + ctx.c.tier : null; }, 5);
  collect('rivalry', 'Rivalry Collector', 'Defeat five different rivals.', 'gold', 'handshake', 'career', 'career',
    function (ctx) { return ctx.c && ctx.c.rivalBeaten ? (ctx.c.rivalId || ('rival-' + ctx.now)) : null; }, 5);
  collect('trophy-hunter', 'Trophy Hunter', 'Win 10 different championships.', 'gold', 'trophy', 'career', 'career',
    function (ctx) { return ctx.c && ctx.c.champWon ? (ctx.c.champId || ('champ-' + ctx.now)) : null; }, 10);

  /* ------------------------------------------------------------------ Drift */

  function driftBest(P, tr) { return Math.max(stat(P, 'driftScoreBest'), num(tr && tr.best, 0)); }
  function driftTrack(ctx, tr) { if (ctx.d) { tr.best = Math.max(num(tr.best, 0), ctx.d.score); tr.combo = Math.max(num(tr.combo, 0), ctx.d.combo); } }
  def({ id: 'sideways', name: 'Sideways', desc: 'Score 10,000 points in a single drift run.', tier: 'bronze', glyph: 'swirl', category: 'drift', on: ['drift', 'race', 'challenge'], always: true, max: 10000, track: driftTrack, measure: driftBest });
  def({ id: 'angle-of-attack', name: 'Angle of Attack', desc: 'Score 50,000 points in a single drift run.', tier: 'silver', glyph: 'swirl', category: 'drift', on: ['drift', 'race', 'challenge'], always: true, max: 50000, track: driftTrack, measure: driftBest });
  def({ id: 'drift-king', name: 'Drift King', desc: 'Score 150,000 points in a single drift run.', tier: 'gold', glyph: 'crown', category: 'drift', on: ['drift', 'race', 'challenge'], always: true, max: 150000, track: driftTrack, measure: driftBest });
  def({ id: 'combo-breaker', name: 'Combo Breaker', desc: 'Chain a ×10 drift combo.', tier: 'silver', glyph: 'infinity', category: 'drift', on: ['drift', 'race', 'challenge'], max: 10, track: driftTrack, measure: function (P, tr) { return num(tr && tr.combo, 0); } });
  when('touge-spirit', 'Touge Spirit', 'Win at Akagane Pass in a rear-wheel-drive car.', 'silver', 'mountain', 'drift', 'race', function (ctx) {
    var r = ctx.r; return !!r && r.won && r.trackId === 'akagane-pass' && get(r.build, 'drivetrain.layout') === 'rwd';
  });

  /* ------------------------------------------------------------------ Endurance */

  counter('pit-crew', 'Pit Crew', 'Make a pit stop.', 'bronze', 'pit', 'endurance', null, 1, ['endurance', 'race'], function (ctx) { return ctx.en ? (ctx.en.pit ? 1 : 0) : ctx.r ? num(ctx.r.pitStops, 0) : 0; });
  counter('pit-regular', 'Box, Box, Box', 'Make 25 pit stops.', 'silver', 'pit', 'endurance', null, 25, ['endurance', 'race'], function (ctx) { return ctx.en ? (ctx.en.pit ? 1 : 0) : ctx.r ? num(ctx.r.pitStops, 0) : 0; });
  raceIs('iron-man', 'Iron Man', 'Finish an endurance race.', 'gold', 'hourglass', function (r) { return r.finished && r.endurance; }, { category: 'endurance' });
  raceIs('on-fumes', 'On Fumes', 'Finish an endurance race with less than one litre of fuel left.', 'silver', 'fuel', function (r) { return r.finished && r.endurance && isNum(r.fuelLeft) && r.fuelLeft < 1; }, { category: 'endurance', hidden: true, hint: 'Cut it fine. Really fine.' });
  raceIs('tyre-whisperer', 'Tyre Whisperer', 'Win an endurance race without changing tyres while keeping them above 50%.', 'gold', 'tire', function (r) {
    if (!r.won || !r.endurance || !Array.isArray(r.tireWear) || !r.tireWear.length) return false;
    if (r.tyresChanged === true) return false;
    // tyre age resets to 0 when a tyre is changed: any tyre much younger than the race distance was fitted mid-race
    var agesKnown = Array.isArray(r.tireAges) && r.tireAges.length && isNum(r.laps) && r.laps > 1;
    if (agesKnown && !r.tireAges.every(function (a) { return num(a, 0) >= r.laps - 1; })) return false;
    if (r.tyresChanged == null && !agesKnown) return false;
    // tireWear convention: 0 = new, 1 = destroyed (per endurance.js)
    return r.tireWear.every(function (w) { return num(w, 1) <= 0.5; });
  }, { category: 'endurance' });
  raceIs('one-stop', 'Strategist', 'Win an endurance race making exactly one pit stop.', 'silver', 'pit', function (r) { return r.won && r.endurance && r.pitStops === 1; }, { category: 'endurance' });
  raceIs('battle-scarred', 'Battle Scarred', 'Finish an endurance race with heavy damage.', 'bronze', 'wrench', function (r) {
    if (!r.finished || !r.endurance || !r.damage) return false;
    var m = 0; for (var k in r.damage) m = Math.max(m, num(r.damage[k], 0)); return m >= 0.6;
  }, { category: 'endurance', hidden: true, hint: 'To finish first, first you must finish.' });

  /* ------------------------------------------------------------------ Driving school */

  var MEDAL_RANK = { bronze: 1, silver: 2, gold: 3, platinum: 4 };
  function challengeUniverse() {
    var C = CB.game && CB.game.challenges;
    var L = C && (Array.isArray(C.list) ? C.list : Array.isArray(C.catalog) ? C.catalog : null);
    return L && L.length ? L.map(function (c) { return c.id; }) : null;
  }
  function medalTrack(ctx, tr) {
    if (!ctx.ch || !ctx.ch.id) return;
    tr.medals = tr.medals || {};
    var rk = MEDAL_RANK[ctx.ch.medal] || 0;
    if (rk > num(tr.medals[ctx.ch.id], 0)) tr.medals[ctx.ch.id] = rk;
    if (!(ctx.ch.id in tr.medals)) tr.medals[ctx.ch.id] = 0;
  }
  function medalCount(minRank) {
    return function (P, tr) {
      var m = (tr && tr.medals) || {}, n = 0, U = challengeUniverse();
      for (var k in m) if (m[k] >= minRank && (!U || U.indexOf(k) >= 0)) n++;
      return n;
    };
  }
  def({ id: 'student', name: 'Student Driver', desc: 'Complete any Driving School challenge.', tier: 'bronze', glyph: 'book', category: 'challenges', on: ['challenge'], max: 1, track: medalTrack, measure: medalCount(0) });
  def({ id: 'honour-roll', name: 'Honour Roll', desc: 'Earn a medal in five different challenges.', tier: 'silver', glyph: 'medal', category: 'challenges', on: ['challenge'], max: 5, track: medalTrack, measure: medalCount(1) });
  def({ id: 'gold-standard', name: 'Gold Standard', desc: 'Earn gold in five different challenges.', tier: 'gold', glyph: 'medal', category: 'challenges', on: ['challenge'], max: 5, track: medalTrack, measure: medalCount(3) });
  def({
    id: 'valedictorian', name: 'Valedictorian', desc: 'Earn gold in every Driving School challenge.', tier: 'platinum', glyph: 'laurel', category: 'challenges', on: ['challenge'], track: medalTrack, measure: medalCount(3),
    max: function () { var U = challengeUniverse(); return U ? U.length : 7; }
  });
  function chIs(id, name, desc, tier, glyph, pattern) {
    return when(id, name, desc, tier, glyph, 'challenges', 'challenge', function (ctx) { return !!ctx.ch && ctx.ch.medal === 'gold' && pattern.test(String(ctx.ch.id || '')); });
  }
  chIs('launch-perfect', 'Launch Control', 'Earn gold in the Launch Control challenge.', 'silver', 'bolt', /launch/);
  chIs('braking-perfect', 'Late Braker', 'Earn gold in the Braking Zone challenge.', 'silver', 'target', /brak/);
  chIs('slalom-perfect', 'Cone Dancer', 'Earn gold in the Slalom challenge.', 'silver', 'cone', /slalom/);
  chIs('elk-perfect', 'Elk Whisperer', 'Earn gold in the Elk Test.', 'silver', 'cone', /elk|moose/);
  chIs('topspeed-perfect', 'Flat Out', 'Earn gold in the Top Speed Run.', 'silver', 'gauge', /top-?speed|v-?max/);

  /* ------------------------------------------------------------------ Garage & economy */

  function owned(P) { return Array.isArray(P && P.ownedCars) ? P.ownedCars : []; }
  state('keys-in-hand', 'Keys in Hand', 'Own your first car.', 'bronze', 'key', 'garage', function (P) { return owned(P).length; }, 1);
  state('collector', 'Collector', 'Own five cars at once.', 'silver', 'garage', 'garage', function (P) { return owned(P).length; }, 5);
  state('museum', 'Museum Curator', 'Own ten cars at once.', 'gold', 'garage', 'garage', function (P) { return owned(P).length; }, 10);
  state('millionaire', 'Millionaire', 'Hold 1,000,000 credits at once.', 'gold', 'coin', 'garage', function (P) { return num(P && P.credits, 0); }, 1000000);
  state('earner', 'Prize Money', 'Earn 1,000,000 credits in total.', 'silver', 'coin', 'garage', function (P) { return stat(P, 'creditsEarned'); }, 1000000);
  state('tycoon', 'Tycoon', 'Earn 10,000,000 credits in total.', 'platinum', 'crown', 'garage', function (P) { return stat(P, 'creditsEarned'); }, 10000000);
  state('high-mileage', 'High Mileage', 'Put 1,000 km on a single car.', 'silver', 'road', 'garage', function (P) {
    return owned(P).reduce(function (m, c) { return Math.max(m, num(c && c.odometer_km, 0)); }, 0);
  }, 1000);
  state('running-on-fumes', 'Running on Fumes', 'Drop below 1,000 credits.', 'bronze', 'fuel', 'garage', function (P) {
    return (P && isNum(num(P.credits)) && P.credits < 1000 && (owned(P).length > 0 || stat(P, 'races') > 0)) ? 1 : 0;
  }, 1, { hidden: true, hint: 'Money comes, money goes.' });
  function garageCounter(id, name, desc, tier, glyph, action, max) {
    return counter(id, name, desc, tier, glyph, 'garage', null, max, ['garage', 'career'], function (ctx) { return ctx.g === action ? 1 : 0; });
  }
  garageCounter('grease-monkey', 'Grease Monkey', 'Repair a car.', 'bronze', 'wrench', 'repair', 1);
  garageCounter('evolution', 'Evolution', 'Upgrade an owned car.', 'bronze', 'arrowUp', 'upgrade', 1);
  garageCounter('moving-on', 'Moving On', 'Sell a car.', 'bronze', 'coin', 'sell', 1);
  garageCounter('flipper', 'Flipper', 'Sell ten cars.', 'silver', 'coin', 'sell', 10);
  garageCounter('tuner-shop', 'Tuner Shop', 'Upgrade cars ten times.', 'silver', 'gear', 'upgrade', 10);

  state('level-10', 'Rising Star', 'Reach driver level 10.', 'silver', 'number', 'milestones', function (P) { return num(P && P.level, 1); }, 10, { label: '10' });
  state('level-25', 'Professional', 'Reach driver level 25.', 'gold', 'number', 'milestones', function (P) { return num(P && P.level, 1); }, 25, { label: '25' });
  state('level-50', 'Hall of Fame', 'Reach driver level 50.', 'platinum', 'number', 'milestones', function (P) { return num(P && P.level, 1); }, 50, { label: '50' });

  /* ------------------------------------------------------------------ Media */

  counter('directors-cut', "Director's Cut", 'Save a replay.', 'bronze', 'film', 'media', null, 1, 'replay', function (ctx) { return /save/.test(String(ctx.ev.action || 'saved')) ? 1 : 0; });
  counter('cinephile', 'Cinephile', 'Watch ten replays.', 'silver', 'film', 'media', null, 10, 'replay', function (ctx) { return /watch|play|view/.test(String(ctx.ev.action || '')) ? 1 : 0; });
  // Photo Mode also emits {type:'photo', action:'open'}; only exports count.
  function photoExported(ctx) { var a = String(ctx.ev.action || '').toLowerCase(); return /^export/.test(a) ? 1 : 0; }
  counter('shutterbug', 'Shutterbug', 'Export a photo from Photo Mode.', 'bronze', 'camera', 'media', null, 1, 'photo', photoExported);
  counter('gallery-wall', 'Gallery Wall', 'Export 25 photos.', 'silver', 'camera', 'media', null, 25, 'photo', photoExported);

  /* ------------------------------------------------------------------ Secret / time-based */

  when('night-shift', 'Night Shift', 'Play between 2 and 4 in the morning.', 'bronze', 'moon', 'meta', ['build', 'race', 'challenge', 'career', 'session'], function (ctx) {
    var h = new Date(ctx.now).getHours(); return h >= 2 && h < 4;
  }, { hidden: true, hint: 'Some builds only happen after midnight.' });

  /* ------------------------------------------------------------------ Meta */

  function unlockedCount(P, exceptCat) {
    var a = (P && P.achievements) || {}, n = 0;
    for (var k in a) if (BY_ID[k] && a[k] && a[k].unlockedAt && (!exceptCat || BY_ID[k].category !== exceptCat)) n++;
    return n;
  }
  state('collector-10', 'Getting Started', 'Unlock 10 achievements.', 'bronze', 'star', 'meta', function (P) { return unlockedCount(P, 'meta'); }, 10);
  state('collector-25', 'Achiever', 'Unlock 25 achievements.', 'silver', 'star', 'meta', function (P) { return unlockedCount(P, 'meta'); }, 25);
  state('collector-50', 'Overachiever', 'Unlock 50 achievements.', 'gold', 'star', 'meta', function (P) { return unlockedCount(P, 'meta'); }, 50);
  state('platinum-collector', 'Platinum Shelf', 'Unlock five platinum achievements.', 'gold', 'diamond', 'meta', function (P) {
    var a = (P && P.achievements) || {}, n = 0; for (var k in a) if (BY_ID[k] && BY_ID[k].tier === 'platinum' && a[k] && a[k].unlockedAt) n++; return n;
  }, 5);
  state('completionist', 'Completionist', 'Unlock every other achievement.', 'platinum', 'infinity', 'meta', function (P) { return unlockedCount(P, 'meta'); },
    function () { return DEFS.filter(function (d) { return d.category !== 'meta'; }).length; });

  /* ================================================================== engine */

  function ensure(P) {
    if (!P.achievements || typeof P.achievements !== 'object') P.achievements = {};
    if (!P.stats || typeof P.stats !== 'object') P.stats = {};
    return P;
  }
  function recOf(P, id, create) {
    var a = P.achievements[id];
    if (!a && create) a = P.achievements[id] = { unlockedAt: null, progress: null };
    return a || null;
  }
  function trOf(P, id, create) {
    var r = recOf(P, id, create);
    if (!r) return null;
    if (!r.progress || typeof r.progress !== 'object') { if (!create) return null; r.progress = {}; }
    return r.progress;
  }
  function isUnlockedP(P, id) { var r = P && P.achievements && P.achievements[id]; return !!(r && r.unlockedAt); }

  function measureOf(d, P) {
    if (!d.measure) return null;
    var tr = (P.achievements && P.achievements[d.id] && P.achievements[d.id].progress) || null;
    var max = maxOf(d, P);
    return { cur: d.measure(P, tr), max: max };
  }

  function relevant(d, kind, pass) {
    if (pass > 0) return !!d.always;
    if (d.always) return true;
    return d.on.indexOf(kind) >= 0;
  }

  /** Core: mutate draft profile P with tracking + unlocks; returns unlocked defs. */
  function runInto(P, ctx) {
    ensure(P);
    if (ctx.stats) for (var sk in ctx.stats) {
      // stat events report current values: never decrease
      var v = num(ctx.stats[sk]);
      if (isNum(v)) P.stats[sk] = Math.max(num(P.stats[sk], 0), v);
    }
    var unlocked = [];
    for (var pass = 0; pass < 4; pass++) {
      var any = false;
      for (var i = 0; i < DEFS.length; i++) {
        var d = DEFS[i];
        if (isUnlockedP(P, d.id) || !relevant(d, ctx.kind, pass)) continue;
        var trackRan = false;
        if (pass === 0 && d.track && d.on.indexOf(ctx.kind) >= 0) {
          try { d.track(ctx, trOf(P, d.id, true), P); trackRan = true; } catch (e) { /* defensive */ }
        }
        var ok = false;
        try {
          if (d.when) ok = (pass === 0 && d.on.indexOf(ctx.kind) >= 0) ? !!d.when(ctx, P) : false;
          else if (d.measure) {
            var m = measureOf(d, P);
            ok = isNum(m.cur) && isNum(m.max) && m.cur >= m.max;
            if (!ok && (trackRan || P.achievements[d.id]) && isNum(m.cur) && m.cur > 0) {
              var tr = trOf(P, d.id, true); tr.cur = m.cur; tr.max = m.max;
            }
          }
        } catch (e2) { ok = false; }
        if (ok) {
          var rec = recOf(P, d.id, true);
          var mm = d.measure ? measureOf(d, P) : null;
          rec.unlockedAt = ctx.now;
          rec.progress = Object.assign({}, rec.progress || {}, mm ? { cur: mm.max, max: mm.max } : { cur: 1, max: 1 });
          unlocked.push(d);
          any = true;
        }
      }
      if (!any) break;
    }
    return unlocked;
  }

  /* ------------------------------------------------------------------ rewards & persistence */

  function xpForLevel(l) {
    var PM = profileModule();
    if (PM && typeof PM.xpForLevel === 'function') { try { return PM.xpForLevel(l); } catch (e) { /* fallthrough */ } }
    return Math.round(1000 * Math.pow(l, 1.6));
  }
  /** Level from total XP. xpForLevel(l) = XP needed to advance l -> l+1 (GAME-SPEC curve), so thresholds are cumulative. */
  function levelForXp(xp, floor) {
    var PM = profileModule();
    if (PM && typeof PM.levelForXp === 'function') { try { var L = PM.levelForXp(xp); if (isNum(L)) return Math.max(L, num(floor, 1)); } catch (e) { /* fallthrough */ } }
    var lvl = 1, need = 0;
    while (lvl < 100) { need += xpForLevel(lvl); if (xp < need) break; lvl++; }
    return Math.max(lvl, num(floor, 1));
  }
  function applyRewardsDirect(P, list) {
    var cr = 0, xp = 0;
    list.forEach(function (d) { cr += d.credits; xp += d.xp; });
    if (cr) { P.credits = num(P.credits, 0) + cr; P.stats.creditsEarned = num(P.stats.creditsEarned, 0) + cr; }
    if (xp) {
      P.xp = num(P.xp, 0) + xp;
      P.level = levelForXp(P.xp, num(P.level, 1));
    }
    if (Array.isArray(P.ledger)) list.forEach(function (d) { if (d.credits) P.ledger.push({ t: Date.now(), amount: d.credits, reason: 'Achievement: ' + d.name }); });
  }

  var memStore = null;
  function internalProfile() {
    if (memStore) return memStore;
    var raw = lsGet(STORE_KEY), p = null;
    if (raw) { try { p = JSON.parse(raw); } catch (e) { p = null; } }
    memStore = ensure(p && typeof p === 'object' ? p : { achievements: {}, stats: {}, credits: 0, xp: 0, level: 1 });
    return memStore;
  }
  function saveInternal() { if (memStore) lsSet(STORE_KEY, JSON.stringify(memStore)); }

  function isModuleProfile(PM, profile) {
    if (!PM) return false;
    if (profile == null) return true;
    var cur; try { cur = PM.get(); } catch (e) { return false; }
    if (!cur) return false;
    if (cur === profile) return true;
    return cur.createdAt !== undefined && cur.createdAt === profile.createdAt && cur.driverName === profile.driverName;
  }

  var listeners = [];
  function emit(list, P) {
    list.forEach(function (d) {
      listeners.slice().forEach(function (fn) { try { fn(publicOf(d), P); } catch (e) { /* listener error */ } });
    });
  }

  function publicOf(d) {
    var o = { id: d.id, name: d.name, desc: d.desc, icon: d.icon, tier: d.tier, xp: d.xp, credits: d.credits, category: d.category, hidden: !!d.hidden, glyph: d.glyph };
    if (d.hint) o.hint = d.hint;
    if (d.label) o.label = d.label;
    if (d.measure) o.progress = function (profile) { var p = progress(profile, d.id); return p ? { cur: p.cur, max: p.max } : null; };
    return o;
  }

  var config = { autoToast: true, sound: true };

  /** check(profile, event, opts) -> newly unlocked achievements. */
  function check(profile, event, opts) {
    opts = opts || {};
    var ctx = normalize(event, opts);
    var PM = opts.persist === false ? null : profileModule();
    var unlocked = [], P = null;
    if (PM && isModuleProfile(PM, profile)) {
      var ran = false;
      var work = function (draft) { if (ran) return; ran = true; unlocked = runInto(draft, ctx); P = draft; };
      if (typeof PM.update === 'function') {
        try { PM.update(function (draft) { work(draft); return draft; }); } catch (e) { ran = false; }
      }
      if (!ran) { var cur = PM.get(); work(cur); if (typeof PM.save === 'function') { try { PM.save(cur); } catch (e3) { /* ignore */ } } }
      if (unlocked.length) {
        var directCr = [], directXp = [];
        unlocked.forEach(function (d) {
          if (d.credits) { if (typeof PM.addCredits === 'function') { try { PM.addCredits(d.credits, 'Achievement: ' + d.name); } catch (e) { directCr.push(d); } } else directCr.push(d); }
        });
        var xpSum = unlocked.reduce(function (s, d) { return s + d.xp; }, 0);
        var xpRes = null;
        if (xpSum) { if (typeof PM.addXp === 'function') { try { xpRes = PM.addXp(xpSum); } catch (e) { directXp = unlocked; } } else directXp = unlocked; }
        if (directCr.length || directXp.length) {
          var fix = function (draft) {
            ensure(draft);
            applyRewardsDirect(draft, directCr.map(function (d) { return { credits: d.credits, xp: 0, name: d.name }; })
              .concat(directXp.map(function (d) { return { credits: 0, xp: d.xp, name: d.name }; })));
          };
          if (typeof PM.update === 'function') { try { PM.update(fix); } catch (e) { /* ignore */ } }
        }
        try { P = PM.get(); } catch (e) { /* keep draft */ }
        // level-ups can unlock level achievements: re-run a profile-only pass
        if (xpRes && xpRes.levelUp && !opts._nested) {
          var more = check(null, { type: 'profile' }, { toast: false, _nested: true, now: ctx.now });
          unlocked = unlocked.concat(more.map(function (a) { return BY_ID[a.id]; }));
        }
      }
    } else if (profile && typeof profile === 'object') {
      P = profile;
      unlocked = runInto(P, ctx);
      if (unlocked.length) {
        applyRewardsDirect(P, unlocked);
        var more2 = runInto(P, { kind: 'meta', ev: {}, now: ctx.now });
        if (more2.length) { applyRewardsDirect(P, more2); unlocked = unlocked.concat(more2); }
      }
    } else {
      P = internalProfile();
      unlocked = runInto(P, ctx);
      if (unlocked.length) applyRewardsDirect(P, unlocked);
      if (unlocked.length || ctx.kind === 'build' || ctx.kind === 'race') saveInternal();
    }
    if (unlocked.length && !opts._nested) {
      emit(unlocked, P);
      var wantToast = opts.toast !== undefined ? !!opts.toast : (config.autoToast && hasDOM);
      if (wantToast && hasDOM) unlocked.forEach(function (d, i) { setTimeout(function () { toast(publicOf(d)); }, i * 250); });
    }
    return unlocked.map(publicOf);
  }

  function evaluate(profile, event) {
    var P = ensure(clone(profile || resolveProfile() || {}));
    return runInto(P, normalize(event, {})).map(function (d) { return d.id; });
  }

  function resolveProfile(profile) {
    if (profile && typeof profile === 'object') return profile;
    var PM = profileModule();
    if (PM) { try { return PM.get(); } catch (e) { /* fallthrough */ } }
    return internalProfile();
  }

  function progress(profile, id) {
    var d = BY_ID[id]; if (!d) return null;
    var P = ensure(clone(resolveProfile(profile)) || {});
    if (isUnlockedP(P, id)) { var mx = d.measure ? maxOf(d, P) : 1; return { cur: mx, max: mx, pct: 1, unlocked: true }; }
    if (!d.measure) return { cur: 0, max: 1, pct: 0, unlocked: false };
    var m = measureOf(d, P);
    var cur = clamp(num(m.cur, 0), 0, num(m.max, 1));
    return { cur: cur, max: m.max, pct: m.max > 0 ? cur / m.max : 0, unlocked: false };
  }

  function summary(profile) {
    var P = resolveProfile(profile) || {};
    var out = { unlocked: 0, total: DEFS.length, pct: 0, byTier: {}, byCategory: {}, xpEarned: 0, creditsEarned: 0, recent: [] };
    TIER_ORDER.forEach(function (t) { out.byTier[t] = { unlocked: 0, total: 0 }; });
    CATEGORIES.forEach(function (c) { out.byCategory[c.id] = { unlocked: 0, total: 0 }; });
    DEFS.forEach(function (d) {
      out.byTier[d.tier].total++;
      out.byCategory[d.category].total++;
      if (isUnlockedP(P, d.id)) {
        out.unlocked++; out.byTier[d.tier].unlocked++; out.byCategory[d.category].unlocked++;
        out.xpEarned += d.xp; out.creditsEarned += d.credits;
        out.recent.push({ id: d.id, at: P.achievements[d.id].unlockedAt });
      }
    });
    out.recent.sort(function (a, b) { return b.at - a.at; });
    out.recent = out.recent.slice(0, 5).map(function (r) { return Object.assign(publicOf(BY_ID[r.id]), { unlockedAt: r.at }); });
    out.pct = out.total ? out.unlocked / out.total : 0;
    out.score = DEFS.reduce(function (s, d) { return s + (isUnlockedP(P, d.id) ? TIERS[d.tier].rank * 10 : 0); }, 0);
    return out;
  }

  /** Manually grant an achievement (debug / scripted rewards). */
  function unlock(profile, id, opts) {
    var d = BY_ID[id]; if (!d) return null;
    opts = opts || {};
    var now = num(opts.now, Date.now());
    var PM = opts.persist === false ? null : profileModule();
    var grant = function (P) {
      ensure(P);
      if (isUnlockedP(P, id)) return false;
      var rec = recOf(P, id, true); rec.unlockedAt = now;
      var mx = d.measure ? maxOf(d, P) : 1; rec.progress = Object.assign({}, rec.progress || {}, { cur: mx, max: mx });
      return true;
    };
    var did = false;
    if (PM && isModuleProfile(PM, profile) && typeof PM.update === 'function') {
      PM.update(function (draft) { did = grant(draft); });
      if (did) {
        if (typeof PM.addCredits === 'function') PM.addCredits(d.credits, 'Achievement: ' + d.name);
        if (typeof PM.addXp === 'function') PM.addXp(d.xp);
      }
    } else {
      var P = resolveProfile(profile);
      did = grant(P);
      if (did) applyRewardsDirect(P, [d]);
      if (P === memStore) saveInternal();
    }
    if (!did) return null;
    emit([d], resolveProfile(profile));
    if (opts.toast !== false && hasDOM && config.autoToast) toast(publicOf(d));
    return publicOf(d);
  }

  function reset(profile) {
    var PM = profileModule();
    if (PM && isModuleProfile(PM, profile) && typeof PM.update === 'function') PM.update(function (d) { d.achievements = {}; });
    else { var P = resolveProfile(profile); P.achievements = {}; if (P === memStore) saveInternal(); }
  }

  function onUnlock(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }

  /* ================================================================== UI: styles */

  var CSS = [
    ':root{--gach-bronze:#d6884a;--gach-silver:#c9d3de;--gach-gold:#ffcc3d;--gach-platinum:#8fe9ff}',
    '#game-ach-toasts{position:fixed;top:calc(var(--cb-nav-h,52px) + 14px);right:18px;z-index:10050;display:flex;flex-direction:column;gap:10px;pointer-events:none;max-width:min(380px,calc(100vw - 24px))}',
    '.gach-toast{--tc:var(--gach-gold);pointer-events:auto;position:relative;display:grid;grid-template-columns:64px 1fr;gap:14px;align-items:center;padding:14px 16px 16px 14px;border-radius:var(--radius-lg,16px);',
    'background:var(--glass-strong,rgba(14,15,18,.94));-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);color:var(--text,#ecebe6);border:1px solid var(--line,#2b2c33);',
    'box-shadow:var(--shadow-lg,0 18px 48px rgba(0,0,0,.55)),0 0 32px -10px var(--tc);overflow:hidden;cursor:pointer;font-family:var(--font,"Inter","SF Pro Display",system-ui,sans-serif);',
    'transform-origin:100% 50%;animation:gach-in .62s cubic-bezier(.2,1.3,.35,1) both}',
    '.gach-toast.is-leaving{animation:gach-out .42s cubic-bezier(.6,0,.8,.3) both}',
    'html.cb-driving #game-ach-toasts{display:none}',
    '.gach-toast.tier-bronze{--tc:var(--gach-bronze)}.gach-toast.tier-silver{--tc:var(--gach-silver)}.gach-toast.tier-gold{--tc:var(--gach-gold)}.gach-toast.tier-platinum{--tc:var(--gach-platinum)}',
    '.gach-toast::before{content:"";position:absolute;inset:0;background:radial-gradient(120% 90% at 0% 50%,color-mix(in srgb,var(--tc) 22%,transparent),transparent 60%);pointer-events:none}',
    '.gach-toast::after{content:"";position:absolute;top:0;bottom:0;width:40%;left:-60%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.14),transparent);animation:gach-sweep 1.4s .45s ease-out both;pointer-events:none}',
    '.gach-toast-icon{position:relative;width:64px;height:64px;animation:gach-pop .8s .15s cubic-bezier(.2,1.6,.4,1) both}',
    '.gach-toast-icon svg{width:64px;height:64px;filter:drop-shadow(0 4px 10px rgba(0,0,0,.5)) drop-shadow(0 0 12px color-mix(in srgb,var(--tc) 55%,transparent))}',
    '.gach-ring{position:absolute;inset:-6px;border-radius:50%;border:2px solid var(--tc);opacity:0;animation:gach-ring 1.1s .3s ease-out both}',
    '.gach-toast-body{min-width:0;position:relative}',
    '.gach-kicker{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--tc);font-weight:700;display:flex;gap:6px;align-items:center}',
    '.gach-kicker i{width:6px;height:6px;border-radius:50%;background:var(--tc);box-shadow:0 0 8px var(--tc)}',
    '.gach-name{font-size:17px;font-weight:750;margin:3px 0 2px;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.gach-desc{font-size:12.5px;color:var(--text-dim,#a7a39b);line-height:1.35}',
    '.gach-rewards{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}',
    '.gach-chip{font:600 11px/1 var(--mono,ui-monospace,"SF Mono",Menlo,monospace);padding:5px 8px;border-radius:var(--pill,999px);background:var(--panel-hover,#1f2026);border:1px solid var(--line-soft,rgba(255,255,255,.06));font-variant-numeric:tabular-nums}',
    '.gach-chip.xp{color:var(--text,#ecebe6)}.gach-chip.cr{color:var(--accent-hi,#e7cd9a)}',
    '.gach-timer{position:absolute;left:0;bottom:0;height:3px;width:100%;background:var(--tc);transform-origin:0 50%;opacity:.8;animation:gach-timer var(--gach-dur,5s) linear both}',
    '.gach-toast:hover .gach-timer{animation-play-state:paused}',
    '.gach-confetti{position:absolute;left:46px;top:46px;width:6px;height:10px;border-radius:2px;background:var(--c,var(--tc));opacity:0;animation:gach-confetti 1.3s var(--d,0s) cubic-bezier(.15,.7,.4,1) both;pointer-events:none}',
    '@keyframes gach-in{0%{opacity:0;transform:translateX(60px) scale(.86) rotateY(-24deg)}100%{opacity:1;transform:none}}',
    '@keyframes gach-out{to{opacity:0;transform:translateX(80px) scale(.92)}}',
    '@keyframes gach-pop{0%{transform:scale(.2) rotate(-35deg);opacity:0}70%{transform:scale(1.12) rotate(6deg);opacity:1}100%{transform:none}}',
    '@keyframes gach-ring{0%{opacity:.9;transform:scale(.7)}100%{opacity:0;transform:scale(1.6)}}',
    '@keyframes gach-sweep{to{left:130%}}',
    '@keyframes gach-timer{from{transform:scaleX(1)}to{transform:scaleX(0)}}',
    '@keyframes gach-confetti{0%{opacity:1;transform:translate(0,0) rotate(0)}100%{opacity:0;transform:translate(var(--x),var(--y)) rotate(var(--r))}}',
    /* gallery */
    '.gach-overlay{position:fixed;inset:0;z-index:10040;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--scrim,rgba(4,4,6,.62));backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);animation:gach-fade .25s ease both;font-family:var(--font,"Inter","SF Pro Display",system-ui,sans-serif)}',
    '.gach-overlay.is-inline{position:absolute;inset:0;z-index:auto;background:none;-webkit-backdrop-filter:none;backdrop-filter:none;padding:clamp(12px,2.5vw,28px);animation:none}',
    '.gach-overlay.is-inline .gach-modal{width:min(1240px,100%);height:100%;max-height:none;margin:0 auto;animation:none}',
    '.gach-overlay.is-leaving{animation:gach-fade .2s ease reverse both}',
    '@keyframes gach-fade{from{opacity:0}to{opacity:1}}',
    '.gach-modal{width:min(1180px,100%);max-height:100%;display:flex;flex-direction:column;background:var(--panel,#141519);color:var(--text,#ecebe6);',
    'border:1px solid var(--line,#2b2c33);border-radius:var(--radius-xl,22px);box-shadow:var(--shadow-lg,0 40px 120px rgba(0,0,0,.65));overflow:hidden;animation:gach-rise .38s cubic-bezier(.2,1.1,.3,1) both}',
    '@keyframes gach-rise{from{opacity:0;transform:translateY(24px) scale(.98)}to{opacity:1;transform:none}}',
    '.gach-head{display:grid;grid-template-columns:auto 1fr auto;gap:22px;align-items:center;padding:22px 26px 18px;border-bottom:1px solid var(--line,rgba(255,255,255,.07));',
    'background:radial-gradient(600px 160px at 10% 0%,var(--accent-softer,rgba(201,165,107,.07)),transparent)}',
    '.gach-ringwrap{position:relative;width:84px;height:84px}.gach-ringwrap svg{width:84px;height:84px;transform:rotate(-90deg)}',
    '.gach-ringwrap b{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font:700 20px/1 var(--mono,ui-monospace,Menlo,monospace);font-variant-numeric:tabular-nums}',
    '.gach-ringwrap b small{font:600 9.5px/1.4 var(--font,system-ui);letter-spacing:.14em;color:var(--text-dim,#a7a39b);text-transform:uppercase}',
    '.gach-title{font-family:var(--serif,Georgia,serif);font-size:28px;font-weight:600;letter-spacing:-.01em;margin:0;color:var(--text-strong,#fff)}.gach-sub{color:var(--text-dim,#a7a39b);font-size:13px;margin-top:4px}',
    '.gach-tiers{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}',
    '.gach-tierpill{display:flex;align-items:center;gap:7px;padding:5px 10px 5px 6px;border-radius:var(--pill,999px);background:var(--bg,#0b0b0d);border:1px solid var(--line,#2b2c33);font:600 12px/1 var(--mono,ui-monospace,Menlo,monospace);color:var(--text,#ecebe6);cursor:pointer;transition:background .15s,border-color .15s}',
    '.gach-tierpill svg{width:22px;height:22px}.gach-tierpill:hover{background:var(--panel-hover,#1f2026)}.gach-tierpill.is-active{border-color:var(--accent,#c9a56b);background:var(--accent-soft,rgba(201,165,107,.14))}',
    '.gach-close{align-self:start;font-size:20px;line-height:1}',
    '.gach-overlay.is-inline .gach-close[data-inline-hide]{display:none}',
    '.gach-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:14px 26px;border-bottom:1px solid var(--line,#2b2c33);background:var(--bg,#0b0b0d)}',
    '.gach-cats{display:flex;gap:6px;flex-wrap:wrap;flex:1 1 520px}',
    '.gach-cat{border:1px solid var(--line,#2b2c33);background:transparent;color:var(--text-dim,#9b9890);border-radius:var(--pill,999px);padding:7px 12px;font:600 12px/1 var(--font,system-ui);cursor:pointer;transition:all .15s;display:inline-flex;gap:6px;align-items:center}',
    '.gach-cat em{font-style:normal;font-family:var(--mono,ui-monospace,monospace);font-size:10.5px;opacity:.7}',
    '.gach-cat:hover{color:var(--text,#ecebe6);border-color:var(--accent-ring,rgba(201,165,107,.45))}.gach-cat.is-active{background:var(--accent,#c9a56b);border-color:var(--accent,#c9a56b);color:var(--accent-ink,#17130b)}',
    '.gach-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.gach-input,.gach-sel{height:var(--control-h,38px);border-radius:var(--radius-sm,9px);border:1px solid var(--line,#2b2c33);background:var(--bg,#0b0b0d);color:inherit;padding:0 10px;font:500 13px var(--font,system-ui)}',
    '.gach-input{width:180px}.gach-input:focus,.gach-sel:focus{outline:none;border-color:var(--accent,#c9a56b);box-shadow:0 0 0 3px var(--accent-soft,rgba(201,165,107,.14))}.gach-sel option{background:var(--panel,#141519);color:var(--text,#ecebe6)}',
    '.gach-seg{display:inline-flex;border:1px solid var(--line,#2b2c33);border-radius:var(--radius-sm,9px);overflow:hidden;background:var(--bg,#0b0b0d)}',
    '.gach-seg button{border:0;background:transparent;color:var(--text-dim,#9b9890);font:600 12px var(--font,system-ui);padding:0 11px;height:calc(var(--control-h,38px) - 2px);cursor:pointer}',
    '.gach-seg button.is-active{background:var(--accent-soft,rgba(201,165,107,.14));color:var(--accent,#c9a56b)}',
    '.gach-check{display:inline-flex;gap:6px;align-items:center;font-size:12px;color:var(--text-dim,#9b9890);cursor:pointer;user-select:none}',
    '.gach-body{overflow:auto;padding:20px 26px 28px;flex:1;scrollbar-width:thin}',
    '.gach-section{margin-bottom:22px}.gach-section h3{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--text-dim,#a7a39b);margin:0 0 10px;display:flex;justify-content:space-between;gap:10px}',
    '.gach-section h3 span{font-family:var(--mono,ui-monospace,monospace);letter-spacing:0}',
    '.gach-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}',
    '.gach-card{--tc:var(--gach-gold);position:relative;display:grid;grid-template-columns:56px 1fr;gap:12px;align-items:center;padding:12px;border-radius:var(--radius,12px);background:var(--bg,#0b0b0d);border:1px solid var(--line,#2b2c33);',
    'cursor:pointer;transition:transform .18s,border-color .18s,background .18s;animation:gach-card .4s calc(var(--i,0)*18ms) ease both;text-align:left;color:inherit;font:inherit}',
    '@keyframes gach-card{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
    '.gach-card:hover,.gach-card:focus-visible{transform:translateY(-2px);border-color:color-mix(in srgb,var(--tc) 50%,transparent);background:var(--panel-hover,#1f2026);outline:none}',
    '.gach-card.tier-bronze{--tc:var(--gach-bronze)}.gach-card.tier-silver{--tc:var(--gach-silver)}.gach-card.tier-platinum{--tc:var(--gach-platinum)}',
    '.gach-card.is-unlocked{background:linear-gradient(135deg,color-mix(in srgb,var(--tc) 10%,var(--bg,#0b0b0d)),var(--bg,#0b0b0d))}',
    '.gach-card.is-unlocked .gach-card-icon svg{filter:drop-shadow(0 2px 6px rgba(0,0,0,.5)) drop-shadow(0 0 8px color-mix(in srgb,var(--tc) 40%,transparent))}',
    '.gach-card.is-locked .gach-card-icon{filter:grayscale(.85) brightness(.7)}.gach-card.is-locked .gach-card-name{color:var(--text-dim,#c9c4ba)}',
    '.gach-card-icon svg{width:56px;height:56px;display:block}',
    '.gach-card-name{font-weight:700;font-size:14px;display:flex;gap:6px;align-items:center;justify-content:space-between}',
    '.gach-card-name small{font:700 9.5px/1 var(--font,system-ui);letter-spacing:.12em;text-transform:uppercase;color:var(--tc);flex:none}',
    '.gach-card-desc{font-size:12px;color:var(--text-dim,#a7a39b);line-height:1.35;margin-top:3px}',
    '.gach-bar{height:5px;border-radius:var(--pill,999px);background:var(--line-soft,rgba(255,255,255,.06));margin-top:8px;overflow:hidden}',
    '.gach-bar i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,color-mix(in srgb,var(--tc) 60%,#000),var(--tc));transform-origin:0 50%;animation:gach-grow .8s .1s cubic-bezier(.2,.9,.3,1) both}',
    '@keyframes gach-grow{from{transform:scaleX(0)}}',
    '.gach-meta{display:flex;justify-content:space-between;gap:8px;margin-top:6px;font:500 10.5px/1.2 var(--mono,ui-monospace,monospace);color:var(--text-dim,#8f8a82);font-variant-numeric:tabular-nums}',
    '.gach-empty{text-align:center;padding:60px 20px;color:var(--text-dim,#a7a39b)}',
    '.gach-detail{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--scrim,rgba(4,4,6,.62));backdrop-filter:blur(4px);animation:gach-fade .2s both;z-index:2}',
    '.gach-detail-card{--tc:var(--gach-gold);width:min(420px,90%);padding:28px;border-radius:var(--radius-xl,22px);text-align:center;background:var(--panel,#141519);border:1px solid color-mix(in srgb,var(--tc) 40%,var(--line,#2b2c33));',
    'box-shadow:var(--shadow-lg,0 30px 80px rgba(0,0,0,.6)),0 0 60px -20px var(--tc);animation:gach-rise .3s cubic-bezier(.2,1.2,.3,1) both}',
    '.gach-detail-card.tier-bronze{--tc:var(--gach-bronze)}.gach-detail-card.tier-silver{--tc:var(--gach-silver)}.gach-detail-card.tier-platinum{--tc:var(--gach-platinum)}',
    '.gach-detail-card svg.gach-icon{width:128px;height:128px;animation:gach-pop .6s cubic-bezier(.2,1.6,.4,1) both}',
    '.gach-detail-card h4{font-size:22px;margin:12px 0 4px}.gach-detail-card p{color:var(--text-dim,#a7a39b);font-size:13.5px;line-height:1.5;margin:0 0 14px}',
    '.gach-detail-card .gach-rewards{justify-content:center}',
    '.gach-detail-card .gach-btn{margin-top:18px}',
    '.gach-modal-wrap{position:relative;display:flex;flex-direction:column;min-height:0;flex:1}',
    '@media (max-width:700px){.gach-head{grid-template-columns:auto 1fr;padding:16px}.gach-close{position:absolute;top:12px;right:12px}.gach-toolbar,.gach-body{padding-left:14px;padding-right:14px}.gach-input{width:100%}.gach-overlay{padding:0}.gach-modal{border-radius:0;height:100%}}',
    '@media (prefers-reduced-motion:reduce){.gach-toast,.gach-toast-icon,.gach-card,.gach-modal,.gach-bar i,.gach-confetti,.gach-toast::after,.gach-ring{animation-duration:.01ms!important;animation-delay:0s!important}}'
  ].join('\n');

  function injectStyles() {
    if (!hasDOM || document.getElementById('game-achievements-styles')) return;
    var s = document.createElement('style');
    s.id = 'game-achievements-styles';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ================================================================== UI: toast */

  var toastQueue = [], toastActive = [], recentToasts = {}, heldToasts = [];
  var MAX_VISIBLE = 3;
  var HOVER_PAUSE_MAX = 6000;   // a hovered toast still leaves after this much paused time
  var toastWatch = false;

  /** A car is being driven (race / drift HUD up): achievement toasts wait for the results screen. */
  function isDriving() {
    try { return !!(hasDOM && document.documentElement && document.documentElement.classList.contains('cb-driving')); } catch (e) { return false; }
  }
  function flushHeld() {
    if (isDriving() || !heldToasts.length) return;
    var list = heldToasts.splice(0, heldToasts.length);
    list.forEach(function (a) { if (toastActive.length >= MAX_VISIBLE) toastQueue.push(a); else showToast(a); });
  }
  /** Drop every visible / queued toast (route change): they never linger over another screen. Held ones survive. */
  function clearToasts() {
    toastQueue.length = 0;
    toastActive.slice().forEach(function (el) { if (el && el._leave) el._leave(true); });
  }
  function watchToasts() {
    if (toastWatch || !hasDOM) return;
    toastWatch = true;
    try { document.addEventListener('cb:route', function () { clearToasts(); setTimeout(flushHeld, 0); }); } catch (e) { /* ignore */ }
    try {
      if (typeof MutationObserver === 'function') {
        new MutationObserver(function () { if (!isDriving()) flushHeld(); else clearToasts(); })
          .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      }
    } catch (e2) { /* ignore */ }
  }

  function rewardChips(a) {
    return '<div class="gach-rewards">' + (a.xp ? '<span class="gach-chip xp">+' + fmtInt(a.xp) + ' XP</span>' : '') +
      (a.credits ? '<span class="gach-chip cr">+' + fmtInt(a.credits) + ' CR</span>' : '') + '</div>';
  }

  /** Pure HTML for a toast (exported for tests). */
  function toastHTML(a) {
    var T = TIERS[a.tier] || TIERS.bronze;
    var confetti = '';
    if (T.rank >= 3) {
      var cols = a.tier === 'platinum' ? ['#8fe9ff', '#ffd6f7', '#e3ffd9', '#ffffff'] : ['#ffcc3d', '#fff3b8', '#ff9f43', '#ffffff'];
      for (var i = 0; i < 18; i++) {
        var ang = (i / 18) * Math.PI * 2 + (i % 3) * 0.3, dist = 50 + (i * 37 % 60);
        confetti += '<span class="gach-confetti" style="--x:' + Math.round(Math.cos(ang) * dist) + 'px;--y:' + Math.round(Math.sin(ang) * dist) + 'px;--r:' + (i * 67 % 540) + 'deg;--d:' + (0.2 + (i % 5) * 0.03).toFixed(2) + 's;--c:' + cols[i % cols.length] + '"></span>';
      }
    }
    return '<div class="gach-toast-icon">' + (a.icon || icon('star', a.tier)) + '<span class="gach-ring"></span></div>' +
      '<div class="gach-toast-body"><div class="gach-kicker"><i></i>' + (a.hidden ? 'Secret achievement' : 'Achievement unlocked') + ' · ' + T.name + '</div>' +
      '<div class="gach-name">' + esc(a.name) + '</div><div class="gach-desc">' + esc(a.desc) + '</div>' + rewardChips(a) + '</div>' +
      '<div class="gach-timer"></div>' + confetti;
  }

  /* The chime's AudioContext is created lazily INSIDE the first user gesture (pointer / key / touch), never at load or
     from a toast fired by a timer — Chrome's autoplay policy warns ("AudioContext was not allowed to start") otherwise.
     Toasts that fire before any gesture are simply silent. */
  var chimeAC = null, gestureArmed = false;
  var GESTURE_EVENTS = ['pointerdown', 'mousedown', 'keydown', 'touchend'];
  function onFirstGesture() {
    if (typeof window !== 'undefined') GESTURE_EVENTS.forEach(function (t) { window.removeEventListener(t, onFirstGesture, true); });
    if (chimeAC) return;
    var AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    try { chimeAC = toast._ac = new AC(); } catch (e) { chimeAC = null; }
  }
  function armAudioOnGesture() {
    if (gestureArmed || !hasDOM || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    gestureArmed = true;
    GESTURE_EVENTS.forEach(function (t) { window.addEventListener(t, onFirstGesture, { capture: true, passive: true }); });
  }

  function playChime(tier) {
    if (!config.sound) return;
    try {
      var PM = profileModule(), aud = PM && get(PM.get(), 'settings.audio');
      var vol = aud ? num(aud.master, 1) * num(aud.sfx, 1) : 0.8;
      if (!(vol > 0)) return;
      var ac = chimeAC;
      if (!ac) { armAudioOnGesture(); return; }   // no gesture yet: stay silent (never construct an AudioContext here)
      if (ac.state === 'closed') { chimeAC = null; gestureArmed = false; armAudioOnGesture(); return; }
      if (ac.state === 'suspended' && ac.resume) { try { ac.resume(); } catch (e0) { /* ignore */ } }
      var notes = { bronze: [660, 880], silver: [660, 880, 1100], gold: [523, 659, 784, 1047], platinum: [523, 659, 784, 1047, 1319] }[tier] || [660, 880];
      var t0 = ac.currentTime + 0.02, master = ac.createGain();
      master.gain.value = 0.12 * clamp(vol, 0, 1);
      master.connect(ac.destination);
      notes.forEach(function (f, i) {
        var o = ac.createOscillator(), g = ac.createGain(), t = t0 + i * 0.085;
        o.type = i === notes.length - 1 ? 'triangle' : 'sine';
        o.frequency.setValueAtTime(f, t);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(1, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5 + i * 0.05);
        o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.7 + i * 0.05);
      });
    } catch (e) { /* audio optional */ }
  }

  function toastRoot() {
    var r = document.getElementById('game-ach-toasts');
    if (!r) {
      r = document.createElement('div'); r.id = 'game-ach-toasts';
      r.setAttribute('aria-live', 'polite'); r.setAttribute('role', 'status');
      document.body.appendChild(r);
    }
    return r;
  }

  function toast(a) {
    if (!a) return null;
    if (typeof a === 'string') a = BY_ID[a] ? publicOf(BY_ID[a]) : { id: a, name: a, desc: '', tier: 'bronze' };
    if (!hasDOM || !document.body) return null;
    var key = a.id || a.name, nowT = Date.now();
    if (recentToasts[key] && nowT - recentToasts[key] < 10000) return null;
    recentToasts[key] = nowT;
    injectStyles();
    watchToasts();
    if (isDriving()) { heldToasts.push(a); return null; }   // shown on the results screen
    if (toastActive.length >= MAX_VISIBLE) { toastQueue.push(a); return null; }
    return showToast(a);
  }

  function showToast(a) {
    var root = toastRoot();
    var T = TIERS[a.tier] || TIERS.bronze;
    var dur = 4200 + T.rank * 600;
    var el = document.createElement('div');
    el.className = 'gach-toast tier-' + (a.tier || 'bronze');
    el.style.setProperty('--gach-dur', dur + 'ms');
    el.innerHTML = toastHTML(a);
    el.title = 'Open achievements';
    root.appendChild(el);
    toastActive.push(el);
    playChime(a.tier);
    var remaining = dur, started = Date.now(), timer = null, capTimer = null, pausedAt = 0, pausedTotal = 0;
    function leave(now) {
      if (el._gone) return; el._gone = true;
      clearTimeout(timer); clearTimeout(capTimer);
      var i0 = toastActive.indexOf(el); if (i0 >= 0) toastActive.splice(i0, 1);
      el.style.pointerEvents = 'none';
      el.classList.add('is-leaving');
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
        if (toastQueue.length && !isDriving() && toastActive.length < MAX_VISIBLE) showToast(toastQueue.shift());
      }, now ? 0 : 430);
    }
    el._leave = leave;
    function arm() { started = Date.now(); timer = setTimeout(leave, Math.max(0, remaining)); }
    // hovering pauses the countdown, but never for more than HOVER_PAUSE_MAX in total
    el.addEventListener('mouseenter', function () {
      if (el._gone) return;
      clearTimeout(timer); remaining -= Date.now() - started; pausedAt = Date.now();
      capTimer = setTimeout(leave, Math.max(0, HOVER_PAUSE_MAX - pausedTotal));
    });
    el.addEventListener('mouseleave', function () {
      if (el._gone) return;
      clearTimeout(capTimer); if (pausedAt) pausedTotal += Date.now() - pausedAt; pausedAt = 0;
      arm();
    });
    el.addEventListener('click', function () { leave(); openGallery({ focus: a.id }); });
    arm();
    return el;
  }

  /* ================================================================== UI: gallery */

  var gallery = null;
  var filters = { category: 'all', tier: 'all', status: 'all', q: '', sort: 'default', showHidden: false };

  function viewModel(P, f) {
    f = f || filters;
    var q = String(f.q || '').trim().toLowerCase();
    var rows = DEFS.map(function (d, idx) {
      var unlocked = isUnlockedP(P, d.id);
      var pr = progress(P, d.id);
      var concealed = d.hidden && !unlocked && !f.showHidden;
      return {
        d: d, idx: idx, unlocked: unlocked, at: unlocked ? P.achievements[d.id].unlockedAt : null, pr: pr, concealed: concealed,
        inProgress: !unlocked && pr && pr.pct > 0
      };
    }).filter(function (r) {
      if (f.category !== 'all' && r.d.category !== f.category) return false;
      if (f.tier !== 'all' && r.d.tier !== f.tier) return false;
      if (f.status === 'unlocked' && !r.unlocked) return false;
      if (f.status === 'locked' && r.unlocked) return false;
      if (f.status === 'progress' && !r.inProgress) return false;
      if (q) {
        var hay = (r.concealed ? 'hidden secret' : (r.d.name + ' ' + r.d.desc)) + ' ' + r.d.tier + ' ' + r.d.category;
        if (hay.toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
    var cmp = {
      'default': function (a, b) { return a.idx - b.idx; },
      tier: function (a, b) { return TIERS[b.d.tier].rank - TIERS[a.d.tier].rank || a.idx - b.idx; },
      recent: function (a, b) { return (b.at || 0) - (a.at || 0) || a.idx - b.idx; },
      progress: function (a, b) { return (b.unlocked ? 2 : (b.pr ? b.pr.pct : 0)) - (a.unlocked ? 2 : (a.pr ? a.pr.pct : 0)) || a.idx - b.idx; },
      name: function (a, b) { return a.d.name < b.d.name ? -1 : a.d.name > b.d.name ? 1 : 0; }
    }[f.sort] || function (a, b) { return a.idx - b.idx; };
    rows.sort(cmp);
    return rows;
  }

  function cardHTML(r, i) {
    var d = r.d;
    var name = r.concealed ? 'Hidden achievement' : d.name;
    var desc = r.concealed ? (d.hint || 'Keep playing to discover this one.') : d.desc;
    var ic = r.unlocked ? d.icon : icon(d.glyph, 'locked', { label: d.label, hidden: r.concealed, uid: d.id + '-l' });
    var bar = '';
    if (!r.unlocked && r.pr && d.measure && r.pr.max > 1 && !r.concealed) {
      bar = '<div class="gach-bar"><i style="width:' + (Math.max(0, Math.min(1, r.pr.pct)) * 100).toFixed(1) + '%"></i></div>';
    }
    var right = r.unlocked ? fmtDate(r.at) : (r.pr && d.measure && r.pr.max > 1 && !r.concealed ? fmtCompact(r.pr.cur) + ' / ' + fmtCompact(r.pr.max) : 'Locked');
    return '<button type="button" class="gach-card tier-' + d.tier + (r.unlocked ? ' is-unlocked' : ' is-locked') + '" data-id="' + esc(d.id) + '" style="--i:' + Math.min(i, 40) + '">' +
      '<div class="gach-card-icon">' + ic + '</div>' +
      '<div><div class="gach-card-name"><span>' + esc(name) + '</span><small>' + TIERS[d.tier].name + '</small></div>' +
      '<div class="gach-card-desc">' + esc(desc) + '</div>' + bar +
      '<div class="gach-meta"><span>' + (r.concealed ? '???' : '+' + fmtCompact(d.xp) + ' XP · +' + fmtCompact(d.credits) + ' CR') + '</span><span>' + esc(right) + '</span></div></div></button>';
  }

  /** Pure HTML for the gallery body (exported for tests). */
  function galleryBodyHTML(P, f) {
    f = f || filters;
    var rows = viewModel(P, f);
    if (!rows.length) return '<div class="gach-empty">No achievements match these filters.</div>';
    if (f.category !== 'all' || f.sort !== 'default') {
      return '<div class="gach-grid">' + rows.map(cardHTML).join('') + '</div>';
    }
    var html = '', n = 0;
    CATEGORIES.forEach(function (c) {
      var rs = rows.filter(function (r) { return r.d.category === c.id; });
      if (!rs.length) return;
      var all = DEFS.filter(function (d) { return d.category === c.id; });
      var un = all.filter(function (d) { return isUnlockedP(P, d.id); }).length;
      html += '<section class="gach-section"><h3>' + esc(c.name) + '<span>' + un + ' / ' + all.length + '</span></h3><div class="gach-grid">' +
        rs.map(function (r) { return cardHTML(r, n++); }).join('') + '</div></section>';
    });
    return html;
  }

  function headHTML(P) {
    var s = summary(P);
    var R = 36, C = 2 * Math.PI * R;
    var tierPills = TIER_ORDER.map(function (t) {
      return '<button type="button" class="gach-tierpill' + (filters.tier === t ? ' is-active' : '') + '" data-tier="' + t + '">' + icon('star', t, { uid: 'pill' + t }) +
        s.byTier[t].unlocked + '/' + s.byTier[t].total + '</button>';
    }).join('');
    return '<div class="gach-ringwrap"><svg viewBox="0 0 84 84"><circle cx="42" cy="42" r="' + R + '" fill="none" stroke="var(--line,#2b2c33)" stroke-width="7"/>' +
      '<circle cx="42" cy="42" r="' + R + '" fill="none" stroke="var(--accent,#c8a26a)" stroke-width="7" stroke-linecap="round" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + (C * (1 - s.pct)).toFixed(1) + '" style="transition:stroke-dashoffset 1s cubic-bezier(.2,.9,.3,1)"/></svg>' +
      '<b>' + Math.round(s.pct * 100) + '%<small>complete</small></b></div>' +
      '<div><h2 class="gach-title">Achievements</h2><div class="gach-sub">' + s.unlocked + ' of ' + s.total + ' unlocked · ' + fmtInt(s.xpEarned) + ' XP · ' + fmtInt(s.creditsEarned) + ' CR earned · score ' + s.score + '</div>' +
      '<div class="gach-tiers">' + tierPills + '</div></div>' +
      '<button type="button" class="cb-btn ghost icon-btn gach-close" data-act="close" aria-label="Close">×</button>';
  }

  function toolbarHTML(P) {
    var s = summary(P);
    var cats = '<button type="button" class="gach-cat' + (filters.category === 'all' ? ' is-active' : '') + '" data-cat="all">All <em>' + s.unlocked + '/' + s.total + '</em></button>' +
      CATEGORIES.map(function (c) {
        var bc = s.byCategory[c.id];
        return bc.total ? '<button type="button" class="gach-cat' + (filters.category === c.id ? ' is-active' : '') + '" data-cat="' + c.id + '" title="' + esc(c.desc) + '">' + esc(c.name) + ' <em>' + bc.unlocked + '/' + bc.total + '</em></button>' : '';
      }).join('');
    var seg = [['all', 'All'], ['unlocked', 'Unlocked'], ['progress', 'In progress'], ['locked', 'Locked']].map(function (o) {
      return '<button type="button" data-status="' + o[0] + '"' + (filters.status === o[0] ? ' class="is-active"' : '') + '>' + o[1] + '</button>';
    }).join('');
    var sorts = [['default', 'Default order'], ['tier', 'Tier'], ['progress', 'Closest to unlock'], ['recent', 'Recently unlocked'], ['name', 'Name']].map(function (o) {
      return '<option value="' + o[0] + '"' + (filters.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
    return '<div class="gach-cats">' + cats + '</div><div class="gach-tools">' +
      '<div class="gach-seg">' + seg + '</div>' +
      '<input class="gach-input" type="search" placeholder="Search…" value="' + esc(filters.q) + '" data-act="search" aria-label="Search achievements">' +
      '<select class="gach-sel" data-act="sort" aria-label="Sort">' + sorts + '</select>' +
      '<label class="gach-check"><input type="checkbox" data-act="hidden"' + (filters.showHidden ? ' checked' : '') + '> Reveal secrets</label></div>';
  }

  function detailHTML(P, id) {
    var d = BY_ID[id]; if (!d) return '';
    var unlocked = isUnlockedP(P, id);
    var concealed = d.hidden && !unlocked && !filters.showHidden;
    var pr = progress(P, id);
    var cat = CATEGORIES.filter(function (c) { return c.id === d.category; })[0];
    var ic = unlocked ? icon(d.glyph, d.tier, { label: d.label, uid: d.id + '-big' }) : icon(d.glyph, 'locked', { label: d.label, hidden: concealed, uid: d.id + '-bigl' });
    var status = unlocked ? 'Unlocked ' + fmtDate(P.achievements[id].unlockedAt)
      : (pr && d.measure && pr.max > 1 && !concealed ? 'Progress ' + fmtInt(pr.cur) + ' / ' + fmtInt(pr.max) + ' (' + Math.round(pr.pct * 100) + '%)' : 'Not yet unlocked');
    return '<div class="gach-detail" data-act="detail-close"><div class="gach-detail-card tier-' + d.tier + '" role="dialog" aria-modal="true" aria-label="' + esc(concealed ? 'Hidden achievement' : d.name) + '">' + ic +
      '<div class="gach-kicker" style="justify-content:center;color:var(--tc)"><i></i>' + TIERS[d.tier].name + ' · ' + esc(cat ? cat.name : d.category) + (d.hidden ? ' · Secret' : '') + '</div>' +
      '<h4>' + esc(concealed ? 'Hidden achievement' : d.name) + '</h4><p>' + esc(concealed ? (d.hint || 'Keep playing to discover this one.') : d.desc) + '</p>' +
      (pr && d.measure && pr.max > 1 && !unlocked && !concealed ? '<div class="gach-bar" style="height:8px"><i style="width:' + (pr.pct * 100).toFixed(1) + '%"></i></div>' : '') +
      '<div class="gach-meta" style="justify-content:center">' + esc(status) + '</div>' +
      (concealed ? '' : rewardChips(d)) +
      '<button type="button" class="cb-btn primary gach-btn" data-act="detail-close">Close</button></div></div>';
  }

  function openGallery(opts) {
    opts = opts || {};
    if (!hasDOM || !document.body) return null;
    injectStyles();
    if (opts.category) filters.category = opts.category;
    if (opts.status) filters.status = opts.status;
    var getP = function () { return ensure(clone(resolveProfile(opts.profile)) || {}); };
    if (gallery && (!gallery.el.isConnected || (opts.root ? gallery.el.parentNode !== opts.root : gallery.inline))) gallery.close(true);   // re-mounted elsewhere / stale
    if (gallery) { gallery.refresh(); if (opts.focus) gallery.showDetail(opts.focus); return gallery; }

    // opts.root (+ inline !== false): mount inside a router screen layer (#/achievements) instead of a fixed modal
    var inline = !!opts.root && opts.inline !== false;
    var host = opts.root || document.getElementById('modal-root') || document.body;
    var overlay = document.createElement('div');
    overlay.className = 'gach-overlay' + (inline ? ' is-inline' : '');
    overlay.id = 'game-achievements-gallery';
    overlay.innerHTML = '<div class="gach-modal" role="dialog" aria-modal="true" aria-label="Achievements"><div class="gach-modal-wrap">' +
      '<header class="gach-head"></header><div class="gach-toolbar"></div><div class="gach-body" tabindex="-1"></div></div></div>';
    host.appendChild(overlay);
    var modal = overlay.querySelector('.gach-modal'), wrap = overlay.querySelector('.gach-modal-wrap');
    var head = overlay.querySelector('.gach-head'), bar = overlay.querySelector('.gach-toolbar'), body = overlay.querySelector('.gach-body');
    var prevFocus = document.activeElement;

    function renderHead() { head.innerHTML = headHTML(getP()); }
    function renderBar() { bar.innerHTML = toolbarHTML(getP()); }
    function renderBody() { var st = body.scrollTop; body.innerHTML = galleryBodyHTML(getP(), filters); body.scrollTop = st; }
    function refresh() { renderHead(); renderBar(); renderBody(); }
    function showDetail(id) {
      var old = wrap.querySelector('.gach-detail'); if (old) old.parentNode.removeChild(old);
      else detailReturn = document.activeElement;
      wrap.insertAdjacentHTML('beforeend', detailHTML(getP(), id));
      var btn = wrap.querySelector('.gach-detail .gach-btn'); if (btn) btn.focus();
    }
    var detailReturn = null;
    function hideDetail() {
      var old = wrap.querySelector('.gach-detail');
      if (!old) return false;
      old.parentNode.removeChild(old);
      // focus goes back to the tile that opened the card
      if (detailReturn && detailReturn.isConnected && detailReturn.focus) { try { detailReturn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      detailReturn = null;
      return true;
    }

    var searchT = null;
    overlay.addEventListener('click', function (e) {
      var t = e.target;
      if (t === overlay) { if (!inline) close(); return; }
      var el = t.closest ? t : t.parentElement;
      if (!el || !el.closest) return;
      if (el.closest('[data-act="close"]')) { close(); return; }
      var dc = el.closest('[data-act="detail-close"]');
      if (dc && (el.classList.contains('gach-detail') || el.closest('.gach-btn'))) { hideDetail(); return; }
      var cat = el.closest('[data-cat]'); if (cat) { filters.category = cat.getAttribute('data-cat'); renderBar(); renderBody(); return; }
      var tier = el.closest('[data-tier]'); if (tier) { var tv = tier.getAttribute('data-tier'); filters.tier = filters.tier === tv ? 'all' : tv; renderHead(); renderBody(); return; }
      var stt = el.closest('[data-status]'); if (stt) { filters.status = stt.getAttribute('data-status'); renderBar(); renderBody(); return; }
      var card = el.closest('.gach-card'); if (card) { showDetail(card.getAttribute('data-id')); }
    });
    overlay.addEventListener('input', function (e) {
      if (e.target.getAttribute('data-act') === 'search') {
        clearTimeout(searchT);
        var v = e.target.value;
        searchT = setTimeout(function () { filters.q = v; renderBody(); }, 120);
      }
    });
    overlay.addEventListener('change', function (e) {
      var a = e.target.getAttribute('data-act');
      if (a === 'sort') { filters.sort = e.target.value; renderBody(); }
      if (a === 'hidden') { filters.showHidden = !!e.target.checked; renderBody(); }
    });
    function onKey(e) {
      if (overlay.isConnected === false) { close(true); return; }   // the router tore the screen down
      if (e.key === 'Escape') {
        if (inline && !wrap.querySelector('.gach-detail')) { if (opts.closeOnEscape) { e.preventDefault(); close(); } return; }   // screen mode: Esc belongs to the router
        e.stopPropagation(); e.preventDefault(); if (!hideDetail()) close();
      }
      else if (e.key === 'Tab' && (!inline || wrap.querySelector('.gach-detail'))) {
        // an open detail card traps Tab inside itself (it used to walk on into the tiles behind it)
        var scope = wrap.querySelector('.gach-detail-card') || modal;
        var f = scope.querySelectorAll('button,input,select,[tabindex="0"]');
        if (!f.length) { e.preventDefault(); return; }
        var firstEl = f[0], lastEl = f[f.length - 1];
        if (!scope.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? lastEl : firstEl).focus(); }
        else if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    var unsubUnlock = onUnlock(function () { if (gallery) refresh(); });
    var unsubProfile = null;
    var PM = profileModule();
    if (PM && typeof PM.subscribe === 'function') { try { unsubProfile = PM.subscribe(function () { if (gallery) { renderHead(); renderBody(); } }); } catch (e) { unsubProfile = null; } }

    function close(silent) {
      if (!gallery) return;
      document.removeEventListener('keydown', onKey, true);
      unsubUnlock();
      if (typeof unsubProfile === 'function') unsubProfile();
      var g = gallery; gallery = null;
      if (inline) { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
      else {
        overlay.classList.add('is-leaving');
        setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 200);
      }
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { /* ignore */ } }
      if (silent !== true && typeof opts.onClose === 'function') opts.onClose();
      return g;
    }

    gallery = { el: overlay, close: close, refresh: refresh, showDetail: showDetail, filters: filters, inline: inline };
    refresh();
    var closeBtn = overlay.querySelector('.gach-close');
    if (inline) { if (!opts.onClose && closeBtn) closeBtn.setAttribute('data-inline-hide', ''); }
    else if (closeBtn) closeBtn.focus();
    if (opts.focus) showDetail(opts.focus);
    return gallery;
  }

  function closeGallery() { if (gallery) gallery.close(); }

  /* ================================================================== auto-wiring (optional) */

  var installed = null;
  /** install({state:true}) subscribes to CB.state changes (debounced) to emit build-changed checks. Idempotent. */
  function install(opts) {
    opts = opts || {};
    if (installed) return installed;
    var unsubs = [];
    if (opts.state !== false && CB.state && typeof CB.state.subscribe === 'function') {
      var t = null;
      unsubs.push(CB.state.subscribe(function (build) {
        clearTimeout(t);
        t = setTimeout(function () { check(opts.profile || null, { type: 'build-changed', build: build }); }, num(opts.debounce, 600));
      }));
    }
    if (opts.session !== false) setTimeout(function () { check(opts.profile || null, { type: 'session' }, { toast: true }); }, 1500);
    installed = { uninstall: function () { unsubs.forEach(function (u) { if (typeof u === 'function') u(); }); installed = null; } };
    return installed;
  }

  /* ================================================================== export */

  var api = {
    list: DEFS.map(publicOf),
    get: function (id) { return BY_ID[id] ? publicOf(BY_ID[id]) : null; },
    tiers: TIERS, tierOrder: TIER_ORDER, categories: CATEGORIES, glyphs: Object.keys(GLYPHS),
    check: check, evaluate: evaluate, progress: progress, summary: summary,
    isUnlocked: function (profile, id) { return isUnlockedP(resolveProfile(profile), id); },
    unlockedList: function (profile) { var P = resolveProfile(profile); return DEFS.filter(function (d) { return isUnlockedP(P, d.id); }).map(publicOf); },
    unlock: unlock, reset: reset, onUnlock: onUnlock,
    icon: icon, toast: toast, openGallery: openGallery, closeGallery: closeGallery, install: install,
    config: config, STORE_KEY: STORE_KEY,
    _internal: {
      DEFS: DEFS, BY_ID: BY_ID, normalize: normalize, normalizeRace: normalizeRace, normalizeBuild: normalizeBuild, normalizeCareer: normalizeCareer,
      runInto: runInto, toastHTML: toastHTML, galleryBodyHTML: galleryBodyHTML, headHTML: headHTML, toolbarHTML: toolbarHTML, detailHTML: detailHTML,
      viewModel: viewModel, filters: filters, estimatePrice: estimatePrice, trackList: trackList, CSS: CSS,
      resetMemory: function () { memStore = null; recentToasts = {}; toastQueue.length = 0; heldToasts.length = 0; }
    }
  };

  CB.game.achievements = api;
  armAudioOnGesture();   // browsers: the chime's AudioContext is born inside the first user gesture
})();

if (typeof module !== 'undefined') module.exports = CB.game.achievements;

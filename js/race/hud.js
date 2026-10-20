/* ==========================================================================
   FORGE Atelier — js/race/hud.js
   CB.race.hud : broadcast-style heads-up display drawn on the race canvas.

   Contract (docs/RACE-SPEC.md, "Inter-module contracts"):
     CB.race.hud.create(canvas, geom, trackDef, opts {units:'kph'|'mph'})
       -> { draw(ctx, snap), setUnits(u), destroy() }
     opts.timing / tower / cluster / minimap === false hide those widgets (mode HUDs such as F1 draw their own)
   draw() is called after renderer.render(); ctx is already in CSS-pixel
   transform, so all layout uses canvas.clientWidth / clientHeight.

   Everything here is defensive: the snapshot, geometry and track definition
   are produced by modules built in parallel, so every field is optional and
   has a sensible fallback. Pure helpers are exposed on `_internal` for tests.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};

(function () {
  'use strict';

  /* ------------------------------------------------------------ constants */

  var PAL = {
    panel: 'rgba(10,12,16,0.82)',
    panelSoft: 'rgba(10,12,16,0.62)',
    panelEdge: 'rgba(255,255,255,0.08)',
    ink: '#f4f5f7',
    inkDim: 'rgba(244,245,247,0.62)',
    inkFaint: 'rgba(244,245,247,0.32)',
    purple: '#b64dff',
    green: '#22d36b',
    yellow: '#ffd23f',
    red: '#ff2e3d',
    amber: '#ff9f1c',
    blue: '#2f8bff',
    cyan: '#30e3ff',
    white: '#ffffff',
    gold: '#e8c25a',
    accent: '#c9a56b'           // FORGE brand accent (css --accent; synced in syncTheme)
  };

  var FONT_UI = "'Barlow Condensed','Roboto Condensed','Arial Narrow','Helvetica Neue',system-ui,sans-serif";
  var FONT_NUM = "ui-monospace,'SF Mono','Roboto Mono',Menlo,Consolas,monospace";

  var TIRE_ICONS = {
    slick: { l: 'S', c: '#ff2e3d' },
    track: { l: 'S', c: '#ff5a5a' },
    'super-sport': { l: 'M', c: '#ffd23f' },
    performance: { l: 'M', c: '#ffd23f' },
    touring: { l: 'H', c: '#f4f5f7' },
    'all-season': { l: 'H', c: '#f4f5f7' },
    eco: { l: 'H', c: '#cfd3da' },
    winter: { l: 'W', c: '#2f8bff' }
  };

  /* ------------------------------------------------------------- helpers */

  function U() { return CB.util || null; }
  function clamp(v, a, b) { v = +v; if (v !== v) v = a; return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  /** Header label for non-race sessions (drift sessions report their drift mode in snap.mode). */
  function sessionLabel(mode) {
    return ({ 'time-trial': 'TIME TRIAL', trial: 'SCORE ATTACK', free: 'FREE RUN', tandem: 'TANDEM', drift: 'DRIFT' })[mode] || 'PRACTICE';
  }
  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  function easeOutCubic(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }
  function easeInCubic(t) { t = clamp(t, 0, 1); return t * t * t; }
  function easeOutBack(t) {
    t = clamp(t, 0, 1);
    var c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function hexToRgb(hex) {
    var u = U();
    if (u && typeof u.hexToRgb === 'function') {
      try { var r = u.hexToRgb(hex); if (r && isNum(r.r)) return r; } catch (e) { /* fall through */ }
    }
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h.slice(0, 6), 16);
    if (h.length < 6 || n !== n) return { r: 200, g: 200, b: 200 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgba(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }
  function lum(hex) {
    var c = hexToRgb(hex);
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  }

  /** "1:32.456" ; null -> "--:--.---" ; opts.short drops leading 0 minutes. */
  function fmtTime(t, opts) {
    if (!isNum(t) || t < 0) return (opts && opts.short) ? '--.---' : '-:--.---';
    var ms = Math.round(t * 1000);
    var m = Math.floor(ms / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    var r = ms % 1000;
    var tail = (s < 10 && (m > 0 || !(opts && opts.short)) ? '0' : '') + s + '.' + (r < 10 ? '00' : r < 100 ? '0' : '') + r;
    if (opts && opts.short && m === 0) return tail;
    return m + ':' + tail;
  }

  /** "+0.123" / "-1.234" (always signed, 3 decimals; >60 s shows minutes). */
  function fmtDelta(d, decimals) {
    if (!isNum(d)) return '--.---';
    var dec = decimals == null ? 3 : decimals;
    var sign = d < 0 ? '-' : '+';
    var a = Math.abs(d);
    if (a >= 60) return sign + fmtTime(a);
    return sign + a.toFixed(dec);
  }

  /** Gap text for standings: '+1.234', '+1 LAP', '+3 LAPS'. */
  function fmtGap(g, lapsDown) {
    if (lapsDown >= 1) return '+' + lapsDown + (lapsDown === 1 ? ' LAP' : ' LAPS');
    if (!isNum(g)) return '';
    if (g >= 60) return '+' + fmtTime(g);
    return '+' + g.toFixed(g < 10 ? 3 : 2);
  }

  /** Sector colour class: purple (overall best), green (personal best), yellow. */
  function sectorClass(t, personalBest, overallBest) {
    if (!isNum(t)) return null;
    var eps = 1e-4;
    if (isNum(overallBest) && t <= overallBest + eps) return 'purple';
    if (!isNum(personalBest) || t <= personalBest + eps) return 'green';
    return 'yellow';
  }
  function classColor(c) {
    return c === 'purple' ? PAL.purple : c === 'green' ? PAL.green : c === 'yellow' ? PAL.yellow : PAL.inkFaint;
  }

  /**
   * Shift-light state for n LEDs. LEDs start lighting at `startFrac` of the
   * redline; first 40% green, next 30% yellow, rest red; at >= 97% of redline
   * every LED goes blue and flashes (`flash` true).
   */
  function shiftLights(rpm, redline, n, startFrac) {
    n = n || 10;
    redline = num(redline, 7000) || 7000;
    var sf = startFrac == null ? 0.68 : startFrac;
    var frac = num(rpm, 0) / redline;
    var p = clamp((frac - sf) / (0.97 - sf), 0, 1);
    var lit = Math.round(p * n);
    var colors = [];
    for (var i = 0; i < n; i++) {
      var f = i / n;
      colors.push(f < 0.4 ? PAL.green : f < 0.7 ? PAL.yellow : PAL.red);
    }
    var flash = frac >= 0.97;
    if (flash) { lit = n; for (var j = 0; j < n; j++) colors[j] = PAL.blue; }
    return { lit: lit, colors: colors, flash: flash, frac: frac };
  }

  /* ------------------------------------------------- geometry extraction */

  function ptXY(p) {
    if (!p) return null;
    if (Array.isArray(p)) return isNum(p[0]) && isNum(p[1]) ? [p[0], p[1]] : null;
    if (isNum(p.x) && isNum(p.y)) return [p.x, p.y];
    return null;
  }

  /**
   * Normalise whatever tracks.build produced into
   * { pts:[[x,y]], s:[cumulative m], length, sectors:[start0,start1,start2], start:[x,y], startHeading }.
   */
  function extractGeom(geom, trackDef) {
    geom = geom || {};
    var src = geom.samples || geom.centerline || geom.centreline || geom.points || geom.path || null;
    if (!Array.isArray(src) || src.length < 3) src = (trackDef && trackDef.points) || [];
    var pts = [], sArr = [], acc = 0, raw = [];
    for (var i = 0; i < src.length; i++) {
      var xy = ptXY(src[i]);
      if (!xy) continue;
      if (pts.length) {
        var q = pts[pts.length - 1];
        acc += Math.hypot(xy[0] - q[0], xy[1] - q[1]);
      }
      pts.push(xy);
      raw.push(src[i]);
      sArr.push(src[i] && isNum(src[i].s) ? src[i].s : acc);
    }
    var closing = pts.length > 1 ? Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) : 0;
    var length = num(geom.length, num(geom.totalLength, num(geom.length_m, num(geom.total, 0))));
    if (!(length > 0)) length = (sArr.length ? sArr[sArr.length - 1] : 0) + closing;
    if (!(length > 0)) length = 1;

    // sectors -> start distances of S1,S2,S3
    var sectors = null;
    var sec = geom.sectors || geom.sectorBoundaries || geom.sectorStarts || null;
    function toS(v) {
      if (isNum(v)) return v;
      if (v && typeof v === 'object') {
        var cand = [v.s, v.start, v.startS, v.start_s, v.s0, v.from];
        for (var k = 0; k < cand.length; k++) if (isNum(cand[k])) return cand[k];
        var idx = isNum(v.index) ? v.index : isNum(v.startIndex) ? v.startIndex : isNum(v.i) ? v.i : null;
        if (idx != null && sArr[idx] != null) return sArr[idx];
        if (isNum(v.end)) return null;
      }
      return null;
    }
    if (Array.isArray(sec) && sec.length) {
      var vals = [];
      for (var j = 0; j < sec.length; j++) { var sv = toS(sec[j]); if (sv != null) vals.push(sv); }
      // object sectors may only carry ends
      if (!vals.length) {
        for (var j2 = 0; j2 < sec.length; j2++) if (sec[j2] && isNum(sec[j2].end)) vals.push(sec[j2].end);
        if (vals.length) vals = [0].concat(vals.slice(0, 2));
      }
      vals = vals.filter(function (v) { return v >= 0 && v <= length + 1; }).sort(function (a, b) { return a - b; });
      if (vals.length >= 3 && vals[0] < 1) sectors = [0, vals[1], vals[2]];
      else if (vals.length >= 3) sectors = [0, vals[0], vals[1]];
      else if (vals.length === 2) sectors = vals[0] < 1 ? [0, vals[1], (vals[1] + length) / 2] : [0, vals[0], vals[1]];
    }
    if (!sectors) sectors = [0, length / 3, length * 2 / 3];

    var start = pts[0] || [0, 0];
    var sl = geom.startLine || geom.startFinish || geom.start || null;
    if (sl) {
      var c = ptXY(sl) || (sl.center && ptXY(sl.center)) || (sl.a && sl.b && ptXY(sl.a) && ptXY(sl.b) ?
        [(ptXY(sl.a)[0] + ptXY(sl.b)[0]) / 2, (ptXY(sl.a)[1] + ptXY(sl.b)[1]) / 2] : null);
      if (c) start = c;
    }
    var h0 = raw[0] && isNum(raw[0].heading) ? raw[0].heading :
      (pts.length > 1 ? Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]) : 0);
    return { pts: pts, s: sArr, length: length, sectors: sectors, start: start, startHeading: h0 };
  }

  /** Decimate a closed polyline to at most `max` points. */
  function decimate(pts, max) {
    if (pts.length <= max) return pts.slice();
    var out = [], step = pts.length / max;
    for (var i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
    return out;
  }

  /**
   * Find rotation + scale that fits the track as large as possible inside a
   * w×h box (with padding). Returns { angle, scale, cx, cy, w, h }.
   * map(x,y) -> [u,v] in box coords (0..w, 0..h).
   */
  function fitTransform(pts, w, h, pad, flipY) {
    pad = pad == null ? 8 : pad;
    var best = null;
    if (!pts.length) return { angle: 0, scale: 1, cx: 0, cy: 0, w: w, h: h, flipY: !!flipY };
    var sample = decimate(pts, 240);
    for (var a = 0; a < 180; a += 3) {
      var ang = a * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang);
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (var i = 0; i < sample.length; i++) {
        var x = sample[i][0], y = flipY ? -sample[i][1] : sample[i][1];
        var rx = x * ca - y * sa, ry = x * sa + y * ca;
        if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
        if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
      }
      var sw = (w - pad * 2) / Math.max(1e-6, maxX - minX);
      var sh = (h - pad * 2) / Math.max(1e-6, maxY - minY);
      var sc = Math.min(sw, sh);
      // tiny bias toward the unrotated orientation so stable tracks stay "north-up"
      var score = sc * (a === 0 ? 1.04 : 1);
      if (!best || score > best.score) {
        best = { score: score, angle: ang, scale: sc, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
      }
    }
    return { angle: best.angle, scale: best.scale, cx: best.cx, cy: best.cy, w: w, h: h, flipY: !!flipY };
  }
  function mapPoint(T, x, y) {
    if (T.flipY) y = -y;
    var ca = Math.cos(T.angle), sa = Math.sin(T.angle);
    var rx = x * ca - y * sa, ry = x * sa + y * ca;
    return [(rx - T.cx) * T.scale + T.w / 2, (ry - T.cy) * T.scale + T.h / 2];
  }

  /** Index of polyline point nearest (x,y), local search from hint then global fallback. */
  function nearestIndex(pts, x, y, hint) {
    var n = pts.length;
    if (!n) return -1;
    var bi = -1, bd = Infinity, i, d, dx, dy;
    if (hint != null && hint >= 0 && hint < n) {
      for (var k = -40; k <= 40; k++) {
        i = ((hint + k) % n + n) % n;
        dx = pts[i][0] - x; dy = pts[i][1] - y; d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bi = i; }
      }
      if (bd < 900) return bi;
    }
    for (i = 0; i < n; i++) {
      dx = pts[i][0] - x; dy = pts[i][1] - y; d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }

  /** Linear interpolation into a sorted [s, t] trace. */
  function traceAt(trace, s) {
    if (!trace || trace.length < 2) return null;
    if (s <= trace[0][0]) return trace[0][1] * (trace[0][0] > 0 ? s / trace[0][0] : 1);
    var lo = 0, hi = trace.length - 1;
    if (s >= trace[hi][0]) return trace[hi][1];
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (trace[mid][0] <= s) lo = mid; else hi = mid;
    }
    var a = trace[lo], b = trace[hi];
    var f = (s - a[0]) / Math.max(1e-6, b[0] - a[0]);
    return a[1] + (b[1] - a[1]) * f;
  }

  /* -------------------------------------------------------- draw helpers */

  function rr(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  /** Slanted broadcast-style parallelogram. */
  function slant(ctx, x, y, w, h, sk) {
    ctx.beginPath();
    ctx.moveTo(x + sk, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w - sk, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
  }
  function panel(ctx, x, y, w, h, r, fill) {
    rr(ctx, x, y, w, h, r);
    ctx.fillStyle = fill || PAL.panel;
    ctx.fill();
    ctx.strokeStyle = PAL.panelEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  function font(ctx, weight, px, fam) {
    ctx.font = weight + ' ' + Math.max(6, Math.round(px * 10) / 10) + 'px ' + (fam || FONT_UI);
  }
  function text(ctx, str, x, y, color, align, baseline) {
    ctx.fillStyle = color || PAL.ink;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = baseline || 'middle';
    ctx.fillText(str, x, y);
  }
  function fitText(ctx, str, maxW) {
    str = String(str == null ? '' : str);
    if (ctx.measureText(str).width <= maxW) return str;
    while (str.length > 1 && ctx.measureText(str + '…').width > maxW) str = str.slice(0, -1);
    return str + '…';
  }
  function tla(name) {
    var parts = String(name || '???').trim().split(/\s+/);
    var last = parts[parts.length - 1] || '???';
    return last.replace(/[^A-Za-zÀ-ÿ]/g, '').slice(0, 3).toUpperCase() || '???';
  }
  function surname(name) {
    var parts = String(name || '').trim().split(/\s+/);
    if (parts.length < 2) return String(name || '').toUpperCase();
    return (parts[0][0] + '. ' + parts.slice(1).join(' ')).toUpperCase();
  }
  function chequer(ctx, x, y, w, h, sq, a) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.globalAlpha *= a == null ? 1 : a;
    for (var i = 0; i * sq < w; i++) {
      for (var j = 0; j * sq < h; j++) {
        ctx.fillStyle = (i + j) % 2 ? '#ffffff' : '#0b0b0d';
        ctx.fillRect(x + i * sq, y + j * sq, sq + 0.5, sq + 0.5);
      }
    }
    ctx.restore();
  }
  function glowDot(ctx, x, y, r, color, glow) {
    ctx.save();
    if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow; }
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  }
  function stopwatchIcon(ctx, x, y, r, color) {
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = Math.max(1, r * 0.28);
    ctx.beginPath(); ctx.arc(x, y + r * 0.12, r * 0.82, 0, Math.PI * 2); ctx.stroke();
    ctx.fillRect(x - r * 0.25, y - r * 1.05, r * 0.5, r * 0.25);
    ctx.beginPath(); ctx.moveTo(x, y + r * 0.12); ctx.lineTo(x + r * 0.42, y - r * 0.3); ctx.stroke();
    ctx.restore();
  }

  /* ================================================================ create */

  /** UNIFY-SPEC: pick up the shared design tokens (css/styles.css) so the HUD matches every other screen. */
  var themeSynced = false;
  function syncTheme() {
    if (themeSynced || typeof window === 'undefined' || typeof document === 'undefined' || !window.getComputedStyle || !document.documentElement) return;
    themeSynced = true;
    try {
      var cs = window.getComputedStyle(document.documentElement);
      var race = String(cs.getPropertyValue('--accent') || '').trim(), text = String(cs.getPropertyValue('--text') || '').trim(),
        gold = String(cs.getPropertyValue('--accent') || '').trim(), good = String(cs.getPropertyValue('--good') || '').trim();
      if (/^#[0-9a-f]{6}$/i.test(race)) PAL.accent = race;
      if (/^#[0-9a-f]{6}$/i.test(text) && lum(text) > 0.7) PAL.ink = text;   // never a dark (light-theme) ink over the 3D view
      if (/^#[0-9a-f]{6}$/i.test(gold)) PAL.gold = gold;
      if (/^#[0-9a-f]{6}$/i.test(good)) PAL.green = good;
      var ui = String(cs.getPropertyValue('--font') || '').trim();
      if (ui) FONT_UI = "'Barlow Condensed','Roboto Condensed'," + ui;
    } catch (e) { /* keep the built-in palette */ }
  }

  function create(canvas, geom, trackDef, opts) {
    opts = opts || {};
    syncTheme();
    var units = opts.units === 'mph' ? 'mph' : 'kph';
    var G = extractGeom(geom, trackDef);
    var miniPts = decimate(G.pts, 520);
    var miniS = [];
    (function () {
      // s for decimated points (look up nearest original index)
      var step = G.pts.length / Math.max(1, miniPts.length);
      for (var i = 0; i < miniPts.length; i++) {
        var oi = G.pts.length <= 520 ? i : Math.floor(i * step);
        miniS.push(G.s[oi] != null ? G.s[oi] : 0);
      }
    })();
    var flipY = opts.minimapFlipY != null ? !!opts.minimapFlipY :
      !!(CB.race.renderer && CB.race.renderer.WORLD_Y_UP);
    var miniT = null, miniKey = '';
    var trackLimitsMax = num(opts.trackLimitsMax, 3);
    var destroyed = false;
    // cockpit camera: the 3D dash (CB.gl.cockpit) already shows rpm / speed / gear, so the HUD tach + shift lights are
    // hidden (they would sit on top of the in-car display) and only the pedal bars + assists stay, tucked in the corner
    var cockpitView = !!opts.cockpit;
    // phone layout hints from race-ui (setLayout): touch = coarse pointer; band = {l, r} free x-range between the touch
    // steering pad and pedals; bottom = px from the canvas bottom to the touch controls' bottom edge; noMinimap = the
    // webcam preview occupies the left column
    var layout = { touch: false, band: null, bottom: 0, noMinimap: false };
    if (CB.race.hud) CB.race.hud.strip = null;

    // ----- animated / remembered state
    var S = {
      lastSnap: null,
      lastReal: now(),
      dt: 0,
      speedDisp: 0,
      rpmDisp: 0,
      banners: [],
      shownKeys: {},
      prev: null,             // previous player fields for diffing
      prevFastest: null,
      rowY: {},               // carId -> animated row index
      posChange: {},          // carId -> {dir, at}
      prevPos: {},
      lapFlash: null,         // {time, cls, at, lapNo}
      goAt: null,
      countdownSeen: false,
      // live delta trace for player
      trace: [],
      bestTrace: null,
      bestTraceTime: null,
      traceLap: null,
      ghostHint: null,
      deltaDisp: null,
      wrongWayAt: null,
      lastPhase: null
    };

    function addBanner(key, title, opt) {
      opt = opt || {};
      var t = now();
      if (key && S.shownKeys[key] && t - S.shownKeys[key] < (opt.dedupeMs || 1e12)) return;
      if (key) S.shownKeys[key] = t;
      S.banners.push({
        key: key, title: title, sub: opt.sub || '', color: opt.color || PAL.accent,
        icon: opt.icon || null, dur: opt.dur || 3200, born: t, style: opt.style || 'bar'
      });
      if (S.banners.length > 4) S.banners.splice(0, S.banners.length - 4);
    }

    function findPlayer(snap) {
      var cars = snap.cars || [];
      for (var i = 0; i < cars.length; i++) {
        if (cars[i] && (cars[i].isPlayer || (snap.playerId != null && cars[i].id === snap.playerId))) return cars[i];
      }
      return cars[0] || null;
    }

    /* --------------------------------------------------- state processing */

    function process(snap, player) {
      var mode = snap.mode || 'race';
      var lapsTotal = num(snap.lapsTotal, 0);
      var cars = snap.cars || [];

      // countdown "GO" moment
      if (snap.phase === 'countdown' || snap.phase === 'grid') S.countdownSeen = true;
      var lightsOut = snap.countdown && snap.countdown.lightsOut;
      if (S.countdownSeen && S.goAt == null && (lightsOut || snap.phase === 'racing')) S.goAt = now();
      if (snap.phase === 'grid' && S.lastPhase && S.lastPhase !== 'grid') {
        // session restarted
        S.goAt = null; S.trace = []; S.prev = null; S.prevFastest = null; S.lapFlash = null;
        S.shownKeys = {}; S.banners = []; S.rowY = {}; S.prevPos = {}; S.posChange = {}; S.cdEnterAt = null;
      }
      S.lastPhase = snap.phase;

      // events since last snapshot
      var evs = snap.events || [];
      for (var i = 0; i < evs.length; i++) {
        var e = evs[i];
        if (!e) continue;
        var mine = player && e.carId === player.id;
        if (e.type === 'jumpstart' && mine) {
          addBanner('jump', 'JUMP START', { color: PAL.red, sub: e.text || (isNum(e.value) ? '+' + e.value + 's time penalty' : 'Time penalty applied'), dur: 3800 });
        } else if (e.type === 'fastestLap' && mode === 'race') {
          var fc = carById(cars, e.carId);
          var ft = isNum(e.value) ? e.value : snap.fastestLap && snap.fastestLap.time;
          addBanner('fl:' + (isNum(ft) ? ft.toFixed(3) : i) + ':' + e.carId, 'FASTEST LAP',
            { color: PAL.purple, icon: 'clock', sub: (fc ? surname(fc.name) + '  ' : '') + fmtTime(ft), dur: 3600 });
        } else if (e.type === 'penalty' && mine) {
          var pv = isNum(e.value) ? e.value : null;
          addBanner('penE:' + (snap.t != null ? Math.round(snap.t) : i), pv != null ? '+' + fmtNumS(pv) + 's PENALTY' : 'PENALTY',
            { color: PAL.red, sub: e.text || 'Time added to race time', dur: 3800 });
          S.penaltyEventAt = now();
        } else if (e.type === 'trackLimits' && mine) {
          var cnt = isNum(e.value) ? e.value : player.trackLimits;
          addBanner('tl:' + cnt, 'TRACK LIMITS (' + cnt + '/' + trackLimitsMax + ')',
            { color: PAL.amber, sub: e.text || (mode === 'race' ? (cnt >= trackLimitsMax ? 'Penalty issued' : 'Warning') : 'Lap time deleted'), dur: 3000 });
        } else if (e.type === 'finish' && mine) {
          finishBanner(snap, player);
        }
      }

      if (!player) return;
      var p = S.prev;

      // ---- diff-based fallbacks (robust when events are missing)
      if (p) {
        if (num(player.trackLimits, 0) > num(p.trackLimits, 0)) {
          var c2 = player.trackLimits;
          addBanner('tl:' + c2, 'TRACK LIMITS (' + c2 + '/' + trackLimitsMax + ')',
            { color: PAL.amber, sub: mode === 'race' ? (c2 >= trackLimitsMax ? 'Penalty issued' : 'Warning') : 'Lap time deleted', dur: 3000 });
        }
        var dp = num(player.penalties_s, 0) - num(p.penalties_s, 0);
        if (dp > 0.01 && !(S.penaltyEventAt && now() - S.penaltyEventAt < 1500)) {
          addBanner('pen:' + num(player.penalties_s, 0).toFixed(2), '+' + fmtNumS(dp) + 's PENALTY',
            { color: PAL.red, sub: 'Total ' + fmtNumS(num(player.penalties_s, 0)) + 's', dur: 3800 });
        }
        if (player.lapValid === false && p.lapValid !== false && mode !== 'race') {
          addBanner('inv:' + player.lap, 'LAP INVALIDATED', { color: PAL.amber, sub: 'Track limits exceeded', dur: 2600 });
        }
        if (num(player.lap, 0) > num(p.lap, 0)) onLapComplete(snap, player, p);
        if (player.finished && !p.finished) finishBanner(snap, player);
        if (player.dnf && !p.dnf) addBanner('dnf', 'DNF', { color: '#8a8f98', sub: 'Retired from the race', dur: 5000 });
      }

      // fastest lap (diff)
      var fl = snap.fastestLap;
      if (fl && isNum(fl.time) && mode === 'race') {
        var pf = S.prevFastest;
        if (pf && (pf.carId !== fl.carId || Math.abs(pf.time - fl.time) > 1e-4)) {
          var fcar = carById(cars, fl.carId);
          addBanner('fl:' + fl.time.toFixed(3) + ':' + fl.carId, 'FASTEST LAP',
            { color: PAL.purple, icon: 'clock', sub: (fcar ? surname(fcar.name) + '  ' : '') + fmtTime(fl.time), dur: 3600 });
        }
        S.prevFastest = { carId: fl.carId, time: fl.time };
      } else if (!fl) S.prevFastest = S.prevFastest || null;
      if (fl && !S.prevFastest) S.prevFastest = { carId: fl.carId, time: fl.time };

      // position change arrows
      for (var c = 0; c < cars.length; c++) {
        var car = cars[c];
        if (!car) continue;
        var pp = S.prevPos[car.id];
        if (pp != null && car.position != null && pp !== car.position && snap.phase === 'racing') {
          S.posChange[car.id] = { dir: car.position < pp ? 1 : -1, at: now() };
        }
        S.prevPos[car.id] = car.position;
      }

      // live delta trace
      recordTrace(player);

      S.prev = {
        lap: player.lap, trackLimits: player.trackLimits, penalties_s: player.penalties_s,
        finished: player.finished, dnf: player.dnf, lapValid: player.lapValid,
        bestLap_s: player.bestLap_s, lastLap_s: player.lastLap_s
      };
    }

    function fmtNumS(v) { return Math.abs(v - Math.round(v)) < 0.01 ? String(Math.round(v)) : v.toFixed(1); }

    function carById(cars, id) {
      for (var i = 0; i < cars.length; i++) if (cars[i] && cars[i].id === id) return cars[i];
      return null;
    }

    function finishBanner(snap, player) {
      var mode = snap.mode || 'race';
      var title = mode === 'race' ? 'FINISH — P' + (player.position || '?') : 'SESSION COMPLETE';
      var sub = mode === 'race'
        ? (player.position === 1 ? 'Victory! ' : '') + (isNum(player.finishTime_s) ? 'Race time ' + fmtTime(player.finishTime_s) : '')
        : (isNum(player.bestLap_s) ? 'Best lap ' + fmtTime(player.bestLap_s) : '');
      addBanner('finish', title, { color: player.position === 1 ? PAL.gold : PAL.white, style: 'chequer', sub: sub, dur: 6500 });
    }

    function onLapComplete(snap, player, p) {
      var mode = snap.mode || 'race';
      var lapsTotal = num(snap.lapsTotal, 0);
      var lt = player.lastLap_s;
      var cls = 'white';
      var fl = snap.fastestLap;
      if (isNum(lt)) {
        if (fl && fl.carId === player.id && Math.abs(fl.time - lt) < 1e-3) cls = 'purple';
        else if (isNum(player.bestLap_s) && lt <= player.bestLap_s + 1e-3) cls = 'green';
        else cls = 'yellow';
        if (player.lapValid === false && mode !== 'race') cls = 'invalid';
      }
      S.lapFlash = { time: lt, cls: cls, at: now(), lapNo: player.lap, sectors: player.lastSectors,
        prevBest: isNum(p && p.bestLap_s) ? p.bestLap_s : null };
      if (mode === 'race' && lapsTotal > 1 && player.lap === lapsTotal - 1 && !player.finished) {
        addBanner('final', 'FINAL LAP', { color: PAL.white, sub: 'Lap ' + lapsTotal + ' of ' + lapsTotal, style: 'final', dur: 3400 });
      }
      if (mode !== 'race' && isNum(lt) && (cls === 'green' || cls === 'purple') && isNum(p && p.bestLap_s) && lt < p.bestLap_s) {
        addBanner('pb:' + lt.toFixed(3), 'NEW PERSONAL BEST', { color: PAL.green, sub: fmtTime(lt), dur: 3000 });
      }
      // promote live trace to best trace
      var isBest = isNum(lt) && isNum(player.bestLap_s) && Math.abs(lt - player.bestLap_s) < 2e-3;
      if (isBest && S.trace.length > 8 && player.lapValid !== false) {
        S.trace.push([G.length, lt]);
        S.bestTrace = S.trace;
        S.bestTraceTime = lt;
      }
      S.trace = [];
      S.traceLap = player.lap;
    }

    function recordTrace(player) {
      if (!isNum(player.s) || !isNum(player.currentLap_s)) return;
      if (S.traceLap !== player.lap) { S.trace = []; S.traceLap = player.lap; }
      var tr = S.trace;
      var last = tr[tr.length - 1];
      if (!last || player.s >= last[0] + 5) {
        if (!last && player.s > 60) return; // joined mid-lap: wait for next lap
        if (last && player.s < last[0]) return;
        tr.push([player.s, player.currentLap_s]);
      }
    }

    function liveDelta(snap, player) {
      if (isNum(player.deltaBest_s)) return player.deltaBest_s;
      if (isNum(player.delta_s)) return player.delta_s;
      if (!S.bestTrace || !isNum(player.s) || !isNum(player.currentLap_s)) return null;
      if (player.s < 15) return null;
      var ref = traceAt(S.bestTrace, player.s);
      return ref == null ? null : player.currentLap_s - ref;
    }

    function ghostDelta(snap, player) {
      if (isNum(snap.ghostDelta_s)) return snap.ghostDelta_s;
      if (isNum(player.ghostDelta_s)) return player.ghostDelta_s;
      var gh = snap.ghost;
      if (!gh || !isNum(gh.x) || !G.pts.length || !isNum(player.s)) return null;
      var idx = nearestIndex(G.pts, gh.x, gh.y, S.ghostHint);
      if (idx < 0) return null;
      S.ghostHint = idx;
      var gs = G.s[idx];
      var ds = gs - player.s;
      if (ds > G.length / 2) ds -= G.length;
      if (ds < -G.length / 2) ds += G.length;
      var v = Math.max(8, num(player.speed, 0));
      return ds / v; // positive: ghost ahead -> player behind
    }

    /* ======================================================== components */

    // --- standings tower --------------------------------------------------
    function drawTower(ctx, snap, player, x, y, k, maxH, compact) {
      var cars = (snap.cars || []).filter(Boolean).slice().sort(function (a, b) {
        return num(a.position, 99) - num(b.position, 99);
      });
      if (!cars.length) return 0;
      var L = G.length;
      var leader = cars[0];
      var rowH = Math.round((compact ? 19 : 23) * k);
      var w = Math.round((compact ? 150 : 262) * k);
      var headH = Math.round((compact ? 22 : 30) * k);
      var maxRows = Math.max(3, Math.floor((maxH - headH - 6 * k) / rowH));
      var tnow = now();

      // choose visible rows: everything if it fits, else top 3 + window around player
      var visible = cars;
      if (cars.length > maxRows) {
        var pi = cars.indexOf(player);
        var set = {};
        var top = Math.min(3, maxRows - 2);
        for (var i = 0; i < top; i++) set[i] = true;
        var rem = maxRows - top;
        var from = clamp(pi - Math.floor(rem / 2), top, cars.length - rem);
        for (var j = from; j < from + rem; j++) set[j] = true;
        visible = cars.filter(function (c, idx) { return set[idx]; });
      }

      // header
      var mode = snap.mode || 'race';
      var lapsTotal = num(snap.lapsTotal, 0);
      var leadLap = Math.min(lapsTotal || Infinity, num(leader.lap, 0) + (leader.finished ? 0 : 1));
      ctx.save();
      slant(ctx, x, y, w, headH, 0);
      var hg = ctx.createLinearGradient(x, y, x + w, y);
      hg.addColorStop(0, '#16181d'); hg.addColorStop(1, '#22252c');
      ctx.fillStyle = hg; ctx.fill();
      ctx.fillStyle = PAL.accent; ctx.fillRect(x, y, Math.max(3, 4 * k), headH);
      font(ctx, '700', (compact ? 11 : 13) * k);
      text(ctx, 'REDLINE', x + 10 * k, y + headH / 2, PAL.ink);
      var fw = ctx.measureText('REDLINE ').width;
      font(ctx, '500', (compact ? 11 : 13) * k);
      text(ctx, mode === 'race' ? 'LAP' : sessionLabel(mode), x + 10 * k + fw, y + headH / 2, PAL.inkDim);
      if (mode === 'race') {
        font(ctx, '700', (compact ? 13 : 16) * k, FONT_NUM);
        var lapStr = (snap.phase === 'finished' || leader.finished) ? 'FINISH' :
          Math.max(1, leadLap) + (lapsTotal ? '/' + lapsTotal : '');
        text(ctx, lapStr, x + w - 10 * k, y + headH / 2, PAL.ink, 'right');
      }
      // interval vs leader column mode (cycles every 10 s like TV graphics)
      var cyc = Math.floor(num(snap.t, tnow / 1000) / 10) % 2;
      var gapMode = opts.towerGap || (cyc ? 'leader' : 'interval');

      var bodyY = y + headH;
      var bodyH = visible.length * rowH + 4 * k;
      ctx.fillStyle = 'rgba(12,13,17,0.86)';
      ctx.fillRect(x, bodyY, w, bodyH);


      var fastest = snap.fastestLap;
      var dt = S.dt;
      // Position-swap animation (FLIP-style): every row has a fixed height and
      // eases from its previous slot to its new one. Settled rows are drawn
      // first, then moving rows (losers, then gainers) each over an opaque
      // backing clipped to the tower body, so swapping rows never show
      // superimposed text — the gainer slides cleanly over the loser.
      var curs = [];
      for (var q = 0; q < visible.length; q++) {
        curs.push(stepRowY(S.rowY[visible[q].id], q, dt));
        S.rowY[visible[q].id] = curs[q];
      }
      var order = towerDrawOrder(curs);
      var anyMoving = order.moving > 0;
      if (anyMoving) {
        ctx.save();
        ctx.beginPath(); ctx.rect(x, bodyY, w, bodyH); ctx.clip();
      }
      for (var oi = 0; oi < order.length; oi++) {
        var r = order[oi];
        var car = visible[r];
        var cur = curs[r];
        var moving = cur !== r;
        var ry = Math.round(bodyY + 2 * k + cur * rowH);
        var isMe = car === player;
        var pos = num(car.position, r + 1);

        if (moving) {
          // opaque backing so the row fully covers whatever it slides over
          ctx.fillStyle = '#0c0d11';
          ctx.fillRect(x, ry, w, rowH);
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(x, ry + rowH - 1, w, 1);
        }

        // gap gaps (non-contiguous rows) separator
        if (!moving && r > 0 && num(visible[r - 1].position, 0) + 1 < pos) {
          ctx.fillStyle = PAL.inkFaint;
          for (var d = 0; d < 3; d++) ctx.fillRect(x + 12 * k + d * 4 * k, ry - 1 * k, 2 * k, 2 * k);
        }

        if (isMe) {
          var pg = ctx.createLinearGradient(x, 0, x + w, 0);
          pg.addColorStop(0, rgba(car.color || PAL.accent, 0.55));
          pg.addColorStop(1, rgba(car.color || PAL.accent, 0.12));
          ctx.fillStyle = pg;
          ctx.fillRect(x, ry, w, rowH - 1);
          ctx.fillStyle = PAL.white;
          ctx.fillRect(x + w - 2 * k, ry, 2 * k, rowH - 1);
        } else if (r % 2) {
          ctx.fillStyle = 'rgba(255,255,255,0.025)';
          ctx.fillRect(x, ry, w, rowH - 1);
        }

        // position box
        var pbw = Math.round(24 * k);
        ctx.fillStyle = pos === 1 ? '#f4f5f7' : isMe ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.08)';
        ctx.fillRect(x + 4 * k, ry + 2 * k, pbw, rowH - 5 * k);
        font(ctx, '700', (compact ? 11 : 13) * k, FONT_NUM);
        text(ctx, String(pos), x + 4 * k + pbw / 2, ry + rowH / 2, (pos === 1 || isMe) ? '#0b0c0f' : PAL.ink, 'center');

        // position change arrow
        var pc = S.posChange[car.id];
        if (pc && tnow - pc.at < 3500) {
          var ax = x + 4 * k + pbw + 4 * k, ay = ry + rowH / 2;
          ctx.fillStyle = pc.dir > 0 ? PAL.green : PAL.red;
          ctx.globalAlpha = 1 - clamp((tnow - pc.at - 2500) / 1000, 0, 1);
          ctx.beginPath();
          if (pc.dir > 0) { ctx.moveTo(ax, ay + 3 * k); ctx.lineTo(ax + 3.5 * k, ay - 3 * k); ctx.lineTo(ax + 7 * k, ay + 3 * k); }
          else { ctx.moveTo(ax, ay - 3 * k); ctx.lineTo(ax + 3.5 * k, ay + 3 * k); ctx.lineTo(ax + 7 * k, ay - 3 * k); }
          ctx.closePath(); ctx.fill();
          ctx.globalAlpha = 1;
        }

        // team colour stripe
        var sx = x + 4 * k + pbw + 13 * k;
        ctx.fillStyle = car.color || '#888';
        ctx.fillRect(sx, ry + 3 * k, 3 * k, rowH - 7 * k);

        // number
        var nx = sx + 7 * k;
        if (!compact) {
          font(ctx, '600', 10 * k, FONT_NUM);
          text(ctx, car.number != null ? String(car.number) : '', nx + 9 * k, ry + rowH / 2 + 0.5 * k, PAL.inkDim, 'center');
          nx += 20 * k;
        }

        // name
        font(ctx, isMe ? '800' : '600', (compact ? 12 : 13.5) * k);
        var nm = isMe && opts.playerName ? (compact ? tla(opts.playerName) : String(opts.playerName).toUpperCase()) : compact ? tla(car.name) : surname(car.name);
        var nameMax = compact ? 34 * k : 88 * k;
        text(ctx, fitText(ctx, nm, nameMax), nx, ry + rowH / 2 + 0.5 * k, car.dnf ? PAL.inkFaint : PAL.ink);

        // icons zone
        var ix = nx + nameMax + 4 * k;
        if (!compact) {
          var comp = car.build && car.build.tires && car.build.tires.compound;
          var ti = TIRE_ICONS[comp];
          if (ti) {
            ctx.beginPath(); ctx.arc(ix + 5 * k, ry + rowH / 2, 5 * k, 0, Math.PI * 2);
            ctx.strokeStyle = ti.c; ctx.lineWidth = 1.6 * k; ctx.stroke();
            font(ctx, '800', 6.5 * k);
            text(ctx, ti.l, ix + 5 * k, ry + rowH / 2 + 0.3 * k, ti.c, 'center');
          }
          ix += 13 * k;
        }
        if (fastest && fastest.carId === car.id && mode === 'race') {
          ctx.fillStyle = PAL.purple;
          rr(ctx, ix, ry + 4 * k, 12 * k, rowH - 9 * k, 2 * k); ctx.fill();
          stopwatchIcon(ctx, ix + 6 * k, ry + rowH / 2, 3.4 * k, '#fff');
          ix += 15 * k;
        }
        if (num(car.penalties_s, 0) > 0 && !compact) {
          font(ctx, '800', 8.5 * k);
          var ptxt = '+' + fmtNumS(car.penalties_s);
          var pw = ctx.measureText(ptxt).width + 6 * k;
          ctx.fillStyle = PAL.red;
          rr(ctx, ix, ry + 4 * k, pw, rowH - 9 * k, 2 * k); ctx.fill();
          text(ctx, ptxt, ix + pw / 2, ry + rowH / 2 + 0.3 * k, '#fff', 'center');
        }

        // gap
        var gx = x + w - 8 * k;
        var gapStr = '', gapCol = PAL.inkDim;
        if (car.dnf) { gapStr = 'DNF'; gapCol = PAL.inkFaint; }
        else if (mode !== 'race') {
          gapStr = fmtTime(car.bestLap_s);
          gapCol = (fastest && fastest.carId === car.id) ? PAL.purple : PAL.inkDim;
        } else if (pos === 1) {
          gapStr = car.finished ? 'WINNER' : (snap.phase === 'racing' ? 'LEADER' : '');
          gapCol = PAL.ink;
        } else {
          var lapsDown = 0;
          if (L > 0 && !car.finished) {
            var lp = num(leader.lap, 0) * L + num(leader.s, 0);
            var cp = num(car.lap, 0) * L + num(car.s, 0);
            lapsDown = Math.floor((lp - cp) / L);
          }
          var g = gapMode === 'leader' ? car.gapLeader_s : car.gapAhead_s;
          if (gapMode !== 'leader' && lapsDown >= 1) {
            // interval to car ahead in laps if the car ahead is a lap+ up
            var ahead = cars[cars.indexOf(car) - 1];
            if (ahead) {
              var ap = num(ahead.lap, 0) * L + num(ahead.s, 0);
              var cp2 = num(car.lap, 0) * L + num(car.s, 0);
              lapsDown = Math.floor((ap - cp2) / L);
            }
          }
          // right after the start every gap reads exactly 0 until the cars reach a timing point: or have no gap yet (null): show a dash, not "+0.000" / the race clock
          gapStr = lapsDown < 1 && (!isNum(g) || Math.abs(g) < 0.0005) ? '\u2014' : fmtGap(g, lapsDown);
          if (snap.phase !== 'racing' && snap.phase !== 'finished') gapStr = '';
        }
        if (car.finished && pos !== 1 && !car.dnf && mode === 'race') {
          chequer(ctx, gx - 7 * k, ry + 5 * k, 7 * k, rowH - 10 * k, 2.4 * k, 0.9);
          gx -= 10 * k;
        }
        font(ctx, '600', (compact ? 10 : 11.5) * k, FONT_NUM);
        text(ctx, gapStr, gx, ry + rowH / 2 + 0.5 * k, isMe ? PAL.ink : gapCol, 'right');
      }
      if (anyMoving) ctx.restore();
      // footer: gap column mode
      var footH = 0;
      if (!compact && mode === 'race') {
        footH = Math.round(15 * k);
        ctx.fillStyle = 'rgba(22,24,29,0.92)';
        ctx.fillRect(x, bodyY + bodyH, w, footH);
        font(ctx, '700', 8.5 * k);
        text(ctx, gapMode === 'leader' ? 'GAP TO LEADER' : 'INTERVAL', x + w - 8 * k, bodyY + bodyH + footH / 2, PAL.inkDim, 'right');
        if (fastest && isNum(fastest.time)) {
          stopwatchIcon(ctx, x + 11 * k, bodyY + bodyH + footH / 2, 3.4 * k, PAL.purple);
          text(ctx, fmtTime(fastest.time), x + 19 * k, bodyY + bodyH + footH / 2, PAL.purple, 'left');
        }
      }
      ctx.restore();
      return headH + bodyH + footH;
    }

    // --- timing panel (position / lap / times / sectors / delta) -----------
    function drawTiming(ctx, snap, player, x, y, k, compact, slim) {
      var mode = snap.mode || 'race';
      var cars = (snap.cars || []).filter(Boolean);
      var w = Math.round((compact ? 178 : 268) * k);
      var pad = 12 * k;
      var lapsTotal = num(snap.lapsTotal, 0);
      var tnow = now();
      var cy = y;

      ctx.save();
      // ---- header block: position + lap
      var hh = Math.round((compact ? 46 : 64) * k);
      panel(ctx, x, cy, w, hh, 6 * k);
      if (mode === 'race') {
        font(ctx, '800', (compact ? 34 : 50) * k);
        var pStr = 'P' + (player.position || '-');
        text(ctx, pStr, x + pad, cy + hh / 2 + 2 * k, PAL.ink);
        var pW = ctx.measureText(pStr).width;
        font(ctx, '600', (compact ? 15 : 20) * k);
        text(ctx, '/' + cars.length, x + pad + pW + 3 * k, cy + hh / 2 + ((compact ? 7 : 10) * k), PAL.inkDim);
      } else {
        font(ctx, '800', (compact ? 16 : 22) * k);
        text(ctx, sessionLabel(mode), x + pad, cy + hh / 2 - 6 * k, PAL.ink);
        font(ctx, '600', (compact ? 10 : 12) * k);
        text(ctx, (trackDef && trackDef.name ? String(trackDef.name).toUpperCase() : 'CIRCUIT'), x + pad, cy + hh / 2 + 12 * k, PAL.inkDim);
      }
      // lap counter
      var lapNow = Math.max(1, num(player.lap, 0) + (player.finished ? 0 : 1));
      if (lapsTotal && mode === 'race') lapNow = Math.min(lapNow, lapsTotal);
      font(ctx, '600', (compact ? 9 : 11) * k);
      text(ctx, 'LAP', x + w - pad, cy + hh * 0.3, PAL.inkDim, 'right');
      font(ctx, '700', (compact ? 18 : 26) * k, FONT_NUM);
      var lapTxt = String(lapNow) + (lapsTotal && mode === 'race' ? '/' + lapsTotal : '');
      if (player.finished && mode === 'race') lapTxt = 'FIN';
      text(ctx, lapTxt, x + w - pad, cy + hh * 0.66, PAL.ink, 'right');
      // final lap tag
      if (mode === 'race' && lapsTotal > 1 && lapNow === lapsTotal && !player.finished && snap.phase === 'racing') {
        font(ctx, '800', 9 * k);
        var tw = ctx.measureText('FINAL LAP').width + 8 * k;
        ctx.fillStyle = PAL.white;
        rr(ctx, x + w - pad - tw - (compact ? 40 : 58) * k, cy + hh * 0.66 - 7 * k, tw, 14 * k, 2 * k); ctx.fill();
        text(ctx, 'FINAL LAP', x + w - pad - tw / 2 - (compact ? 40 : 58) * k, cy + hh * 0.66, '#0b0c0f', 'center');
      }
      cy += hh + 4 * k;

      // ---- current lap time + live delta
      var ch = Math.round((compact ? 34 : 44) * k);
      panel(ctx, x, cy, w, ch, 6 * k);
      var flash = S.lapFlash && tnow - S.lapFlash.at < 4000 ? S.lapFlash : null;
      var curT = player.currentLap_s;
      var curCol = PAL.ink;
      if (flash) {
        curT = flash.time;
        curCol = flash.cls === 'purple' ? PAL.purple : flash.cls === 'green' ? PAL.green :
          flash.cls === 'invalid' ? PAL.red : PAL.yellow;
      }
      if (player.lapValid === false && !flash) curCol = 'rgba(255,90,90,0.95)';
      font(ctx, '700', (compact ? 18 : 24) * k, FONT_NUM);
      var showT = (snap.phase === 'racing' || snap.phase === 'finished' || flash) ? curT : 0;
      text(ctx, fmtTime(showT), x + pad, cy + ch / 2 + 1 * k, curCol);
      if (flash) {
        font(ctx, '700', 9 * k);
        text(ctx, 'LAP ' + flash.lapNo, x + pad, cy + 7 * k, curCol);
      } else if (player.lapValid === false) {
        font(ctx, '700', 9 * k);
        text(ctx, 'INVALID', x + pad, cy + 7 * k, PAL.red);
      }
      // delta pill
      // live delta to best lap; right after a lap: that lap vs the previous best
      var delta = flash ? (isNum(flash.time) && flash.prevBest != null ? flash.time - flash.prevBest : null)
        : liveDelta(snap, player);
      if (isNum(delta)) {
        S.deltaDisp = S.deltaDisp == null ? delta : lerp(S.deltaDisp, delta, 1 - Math.exp(-S.dt * 8));
      } else S.deltaDisp = null;
      var dw = (compact ? 70 : 92) * k, dh = ch - 12 * k;
      var dx = x + w - pad - dw, dy = cy + 6 * k;
      if (S.deltaDisp != null) {
        var dd = S.deltaDisp;
        var col = dd <= 0 ? PAL.green : PAL.red;
        ctx.fillStyle = rgba(col, 0.18);
        rr(ctx, dx, dy, dw, dh, 4 * k); ctx.fill();
        // magnitude bar
        var mag = clamp(Math.abs(dd) / 2, 0, 1);
        ctx.fillStyle = rgba(col, 0.55);
        if (dd <= 0) ctx.fillRect(dx + dw / 2 - (dw / 2 - 3 * k) * mag, dy + dh - 3 * k, (dw / 2 - 3 * k) * mag, 2 * k);
        else ctx.fillRect(dx + dw / 2, dy + dh - 3 * k, (dw / 2 - 3 * k) * mag, 2 * k);
        font(ctx, '700', (compact ? 13 : 16) * k, FONT_NUM);
        text(ctx, fmtDelta(dd), dx + dw / 2, dy + dh / 2, col, 'center');
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        rr(ctx, dx, dy, dw, dh, 4 * k); ctx.fill();
        font(ctx, '600', (compact ? 10 : 12) * k, FONT_NUM);
        text(ctx, 'DELTA', dx + dw / 2, dy + dh / 2, PAL.inkFaint, 'center');
      }
      cy += ch + 4 * k;

      if (slim) { ctx.restore(); return cy - y; }   // short phone landscape: position, lap, time + delta only

      // ---- sector boxes
      var sh = Math.round((compact ? 20 : 30) * k);
      var gap = 4 * k;
      var bw = (w - gap * 2) / 3;
      var overall = [null, null, null];
      cars.forEach(function (c) {
        var bs = c.bestSectors || [];
        for (var i = 0; i < 3; i++) if (isNum(bs[i]) && (overall[i] == null || bs[i] < overall[i])) overall[i] = bs[i];
      });
      var secs = player.sectors || [null, null, null];
      var showingLast = false;
      var allNull = !secs.some(isNum);
      if (flash && allNull && player.lastSectors) { secs = player.lastSectors; showingLast = true; }
      var pbest = player.bestSectors || [];
      var curSec = 0;
      for (var si = 0; si < 3; si++) if (isNum(secs[si])) curSec = si + 1;
      if (!showingLast && isNum(player.s)) {
        curSec = player.s >= G.sectors[2] ? 2 : player.s >= G.sectors[1] ? 1 : 0;
      }
      for (var b = 0; b < 3; b++) {
        var bx = x + b * (bw + gap);
        var t = secs[b];
        var cls = sectorClass(t, pbest[b], overall[b]);
        rr(ctx, bx, cy, bw, sh, 4 * k);
        if (cls) {
          ctx.fillStyle = classColor(cls); ctx.fill();
        } else {
          ctx.fillStyle = PAL.panel; ctx.fill();
          ctx.strokeStyle = PAL.panelEdge; ctx.lineWidth = 1; ctx.stroke();
        }
        var running = !showingLast && !isNum(t) && b === curSec && snap.phase === 'racing';
        if (running) {
          // progress fill within the sector
          var s0 = G.sectors[b], s1 = b < 2 ? G.sectors[b + 1] : G.length;
          var prog = clamp((num(player.s, 0) - s0) / Math.max(1, s1 - s0), 0, 1);
          ctx.save(); rr(ctx, bx, cy, bw, sh, 4 * k); ctx.clip();
          ctx.fillStyle = 'rgba(255,255,255,0.10)';
          ctx.fillRect(bx, cy, bw * prog, sh);
          ctx.restore();
        }
        var tc = cls ? (cls === 'yellow' ? '#1a1608' : '#ffffff') : PAL.inkDim;
        if (compact) {
          font(ctx, '700', 9.5 * k, FONT_NUM);
          text(ctx, isNum(t) ? fmtTime(t, { short: true }) : 'S' + (b + 1), bx + bw / 2, cy + sh / 2 + 0.5 * k, tc, 'center');
        } else {
          font(ctx, '700', 9 * k);
          text(ctx, 'S' + (b + 1), bx + 6 * k, cy + sh / 2, cls ? rgba(cls === 'yellow' ? '#000000' : '#ffffff', 0.7) : PAL.inkFaint);
          font(ctx, '700', 12 * k, FONT_NUM);
          var label = isNum(t) ? fmtTime(t, { short: true }) : (running ? '•••' : '');
          text(ctx, label, bx + bw - 6 * k, cy + sh / 2 + 0.5 * k, tc, 'right');
        }
      }
      cy += sh + 4 * k;

      // ---- last / best
      var lh = Math.round((compact ? 34 : 44) * k);
      panel(ctx, x, cy, w, lh, 6 * k, PAL.panelSoft);
      var fl = snap.fastestLap;
      var bestCol = fl && fl.carId === player.id && isNum(player.bestLap_s) && Math.abs(fl.time - player.bestLap_s) < 1e-3 ? PAL.purple : PAL.ink;
      var lastCol = PAL.ink;
      if (isNum(player.lastLap_s) && isNum(player.bestLap_s)) {
        lastCol = Math.abs(player.lastLap_s - player.bestLap_s) < 1e-3 ? (bestCol === PAL.purple ? PAL.purple : PAL.green) : PAL.yellow;
      }
      var half = w / 2;
      font(ctx, '600', (compact ? 8.5 : 10) * k);
      text(ctx, 'LAST', x + pad, cy + lh * 0.3, PAL.inkDim);
      text(ctx, 'BEST', x + half + pad * 0.5, cy + lh * 0.3, PAL.inkDim);
      font(ctx, '700', (compact ? 12 : 15) * k, FONT_NUM);
      text(ctx, fmtTime(player.lastLap_s), x + pad, cy + lh * 0.68, isNum(player.lastLap_s) ? lastCol : PAL.inkFaint);
      text(ctx, fmtTime(player.bestLap_s), x + half + pad * 0.5, cy + lh * 0.68, isNum(player.bestLap_s) ? bestCol : PAL.inkFaint);
      if (bestCol === PAL.purple && !compact) stopwatchIcon(ctx, x + w - pad - 4 * k, cy + lh * 0.3, 4 * k, PAL.purple);
      cy += lh + 4 * k;

      // ---- mode extras
      if (mode === 'race' && !compact && snap.phase === 'racing' || (mode === 'race' && !compact && snap.phase === 'finished')) {
        var sorted = cars.slice().sort(function (a, b) { return num(a.position, 99) - num(b.position, 99); });
        var idx = sorted.indexOf(player);
        var ahead = sorted[idx - 1], behind = sorted[idx + 1];
        if (ahead || behind) {
          var gh = Math.round(44 * k);
          panel(ctx, x, cy, w, gh, 6 * k, PAL.panelSoft);
          drawGapLine(ctx, x + pad, cy + gh * 0.3, w - pad * 2, k, ahead, isNum(player.gapAhead_s) ? -player.gapAhead_s : null, 'AHEAD');
          drawGapLine(ctx, x + pad, cy + gh * 0.72, w - pad * 2, k, behind, behind && isNum(behind.gapAhead_s) ? behind.gapAhead_s : null, 'BEHIND');
          cy += gh + 4 * k;
        }
      }
      if (mode === 'time-trial') {
        var gd = ghostDelta(snap, player);
        var gh2 = Math.round((compact ? 26 : 34) * k);
        panel(ctx, x, cy, w, gh2, 6 * k, PAL.panelSoft);
        // ghost icon
        var gx = x + pad + 6 * k, gy = cy + gh2 / 2;
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = PAL.cyan;
        ctx.beginPath();
        ctx.arc(gx, gy - 1.5 * k, 5.5 * k, Math.PI, 0);
        ctx.lineTo(gx + 5.5 * k, gy + 6 * k);
        ctx.lineTo(gx + 2.7 * k, gy + 4 * k);
        ctx.lineTo(gx, gy + 6 * k);
        ctx.lineTo(gx - 2.7 * k, gy + 4 * k);
        ctx.lineTo(gx - 5.5 * k, gy + 6 * k);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#0b0c0f';
        ctx.fillRect(gx - 2.8 * k, gy - 2.5 * k, 1.8 * k, 2.2 * k);
        ctx.fillRect(gx + 1 * k, gy - 2.5 * k, 1.8 * k, 2.2 * k);
        ctx.restore();
        font(ctx, '700', (compact ? 10 : 12) * k);
        text(ctx, 'GHOST', gx + 10 * k, gy, PAL.inkDim);
        font(ctx, '700', (compact ? 13 : 16) * k, FONT_NUM);
        if (isNum(gd) && snap.ghost) {
          text(ctx, fmtDelta(gd, 2), x + w - pad, gy, gd <= 0 ? PAL.green : PAL.red, 'right');
        } else {
          text(ctx, snap.ghost === null || !snap.ghost ? 'NO GHOST' : '--.--', x + w - pad, gy, PAL.inkFaint, 'right');
        }
        cy += gh2 + 4 * k;
      }
      ctx.restore();
      return cy - y;
    }

    function drawGapLine(ctx, x, y, w, k, car, gap, label) {
      font(ctx, '600', 9 * k);
      text(ctx, label, x, y, PAL.inkFaint);
      if (!car) { text(ctx, '—', x + w, y, PAL.inkFaint, 'right'); return; }
      ctx.fillStyle = car.color || '#888';
      ctx.fillRect(x + 44 * k, y - 5 * k, 3 * k, 10 * k);
      font(ctx, '700', 12 * k);
      text(ctx, fitText(ctx, surname(car.name), w - 130 * k), x + 51 * k, y + 0.5 * k, PAL.ink);
      font(ctx, '700', 12 * k, FONT_NUM);
      text(ctx, isNum(gap) ? fmtDelta(gap, 3) : '--', x + w, y + 0.5 * k, isNum(gap) ? (gap < 0 ? '#ff8a8a' : '#8affb5') : PAL.inkFaint, 'right');
    }

    // --- tachometer / speedometer cluster ---------------------------------
    function drawCluster(ctx, snap, player, cx, cy, R, k, compact) {
      var redline = num(player.redline, 7500) || 7500;
      var maxRpm = Math.ceil((redline * 1.08) / 1000) * 1000;
      var a0 = Math.PI * 0.75, a1 = Math.PI * 2.25; // 270° sweep
      var rpm = clamp(num(player.rpm, 0), 0, maxRpm);
      S.rpmDisp = lerp(S.rpmDisp, rpm, 1 - Math.exp(-S.dt * 18));
      var spdMs = Math.max(0, num(player.speed, 0));
      var spd = units === 'mph' ? spdMs * 2.236936 : spdMs * 3.6;
      S.speedDisp = lerp(S.speedDisp, spd, 1 - Math.exp(-S.dt * 14));
      var rf = S.rpmDisp / maxRpm;
      var tnow = now();

      ctx.save();
      // backplate
      var bg = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.12);
      bg.addColorStop(0, 'rgba(18,20,26,0.92)');
      bg.addColorStop(0.85, 'rgba(10,11,15,0.88)');
      bg.addColorStop(1, 'rgba(10,11,15,0)');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.12, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1; ctx.stroke();

      // track arc
      var arcW = R * 0.11;
      ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, a0, a1);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = arcW; ctx.stroke();
      // redline zone
      var ar = a0 + (a1 - a0) * (redline / maxRpm);
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, ar, a1);
      ctx.strokeStyle = 'rgba(255,46,61,0.45)'; ctx.lineWidth = arcW; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.955, ar, a1);
      ctx.strokeStyle = PAL.red; ctx.lineWidth = R * 0.025; ctx.stroke();
      // filled rpm
      var af = a0 + (a1 - a0) * rf;
      var inRed = S.rpmDisp >= redline * 0.97;
      var grad = ctx.createLinearGradient(cx - R, cy, cx + R, cy);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.65, PAL.accent);
      grad.addColorStop(1, PAL.red);
      ctx.save();
      ctx.shadowColor = inRed ? PAL.red : PAL.accent; ctx.shadowBlur = 12 * k;
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, a0, Math.max(a0 + 0.001, af));
      ctx.strokeStyle = inRed && Math.floor(tnow / 70) % 2 ? PAL.red : grad;
      ctx.lineWidth = arcW; ctx.stroke();
      ctx.restore();

      // ticks + labels
      var steps = maxRpm / 1000;
      for (var i = 0; i <= steps * 2; i++) {
        var v = i * 500;
        var a = a0 + (a1 - a0) * (v / maxRpm);
        var major = i % 2 === 0;
        var r1 = R * (major ? 0.70 : 0.74), r2 = R * 0.78;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        ctx.strokeStyle = v >= redline ? PAL.red : major ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.3)';
        ctx.lineWidth = major ? 2 * k : 1 * k;
        ctx.stroke();
        if (major && !(compact && (i / 2) % 2 && steps > 8)) {
          font(ctx, '700', R * 0.105);
          var lr = R * 0.6;
          text(ctx, String(v / 1000), cx + Math.cos(a) * lr, cy + Math.sin(a) * lr, v >= redline ? PAL.red : PAL.inkDim, 'center');
        }
      }
      // needle tip marker
      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(af);
      ctx.beginPath();
      ctx.moveTo(R * 0.66, 0); ctx.lineTo(R * 0.93, -R * 0.018); ctx.lineTo(R * 0.93, R * 0.018); ctx.closePath();
      ctx.fillStyle = '#fff'; ctx.shadowColor = '#fff'; ctx.shadowBlur = 6 * k; ctx.fill();
      ctx.restore();

      // speed digits
      font(ctx, '800', R * 0.42, FONT_UI);
      var sStr = String(Math.round(S.speedDisp));
      text(ctx, sStr, cx, cy - R * 0.02, PAL.ink, 'center');
      font(ctx, '600', R * 0.12);
      text(ctx, units === 'mph' ? 'MPH' : 'KM/H', cx, cy + R * 0.24, PAL.inkDim, 'center');
      font(ctx, '600', R * 0.085, FONT_NUM);
      text(ctx, 'x1000 RPM', cx, cy - R * 0.36, PAL.inkFaint, 'center');

      // gear box
      var gear = player.gear;
      var gStr = gear == null ? 'N' : gear < 0 ? 'R' : gear === 0 ? 'N' : (num(player.maxGear, 2) <= 1 && gear === 1 ? 'D' : String(gear));
      var gw = R * 0.42, gh = R * 0.38, gx = cx - gw / 2, gy = cy + R * 0.38;
      rr(ctx, gx, gy, gw, gh, R * 0.06);
      ctx.fillStyle = inRed ? (Math.floor(tnow / 90) % 2 ? PAL.blue : '#1b2030') : 'rgba(255,255,255,0.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.stroke();
      font(ctx, '800', R * 0.32);
      text(ctx, gStr, cx, gy + gh / 2 + R * 0.01, gStr === 'R' ? PAL.red : PAL.ink, 'center');
      if (player.maxGear && !compact) {
        font(ctx, '600', R * 0.07, FONT_NUM);
        text(ctx, '/' + player.maxGear, gx + gw + R * 0.03, gy + gh - R * 0.07, PAL.inkFaint, 'left');
      }
      ctx.restore();
    }

    /** Short phone-landscape cluster: a slim bar at the bottom centre (below the car in the chase view, between the touch
        steering pad and pedals): gear | speed + assists | segmented rpm bar that doubles as the shift lights. */
    function drawStrip(ctx, snap, player, L, k) {
      var x = L.x, y = L.y, w = L.w, h = L.h;
      var redline = num(player.redline, 7500) || 7500;
      var maxRpm = Math.ceil((redline * 1.08) / 1000) * 1000;
      var rpm = clamp(num(player.rpm, 0), 0, maxRpm);
      S.rpmDisp = lerp(S.rpmDisp, rpm, 1 - Math.exp(-S.dt * 18));
      var spdMs = Math.max(0, num(player.speed, 0));
      var spd = units === 'mph' ? spdMs * 2.236936 : spdMs * 3.6;
      S.speedDisp = lerp(S.speedDisp, spd, 1 - Math.exp(-S.dt * 14));
      var tnow = now(), inRed = S.rpmDisp >= redline * 0.97;
      ctx.save();
      panel(ctx, x, y, w, h, 7 * k, 'rgba(10,12,16,0.72)');
      // gear
      var gear = player.gear;
      var gStr = gear == null ? 'N' : gear < 0 ? 'R' : gear === 0 ? 'N' : (num(player.maxGear, 2) <= 1 && gear === 1 ? 'D' : String(gear));
      var pad = 4 * k, gs = h - pad * 2;
      rr(ctx, x + pad, y + pad, gs, gs, 5 * k);
      ctx.fillStyle = inRed ? (Math.floor(tnow / 90) % 2 ? PAL.blue : '#1b2030') : 'rgba(255,255,255,0.08)'; ctx.fill();
      font(ctx, '800', gs * 0.72);
      text(ctx, gStr, x + pad + gs / 2, y + h / 2 + 1, gStr === 'R' ? PAL.red : PAL.ink, 'center');
      // speed + unit
      var bx = x + pad * 2 + gs + 2 * k, bw = x + w - pad - 2 * k - bx;
      var row = y + h * 0.36;
      font(ctx, '800', h * 0.5, FONT_UI);
      var sStr = String(Math.round(S.speedDisp));
      text(ctx, sStr, bx, row, PAL.ink, 'left');
      var sw = ctx.measureText(sStr).width;
      font(ctx, '600', h * 0.2);
      text(ctx, units === 'mph' ? 'MPH' : 'KM/H', bx + sw + 3 * k, row + h * 0.06, PAL.inkDim, 'left');
      drawAssists(ctx, snap, player, x + w - pad - 1 * k, y + pad, k * 0.78, true);
      // rpm bar (10 segments = the shift lights)
      var n = 10, st = shiftLights(S.rpmDisp || player.rpm, player.redline, n);
      var flashOn = !st.flash || Math.floor(tnow / 80) % 2 === 0;
      var rh = Math.max(4, h * 0.17), ry = y + h - pad - rh - 1 * k, gap = 2 * k, segW = (bw - gap * (n - 1)) / n;
      var rf = clamp(S.rpmDisp / maxRpm, 0, 1) * n;
      for (var i = 0; i < n; i++) {
        var sx = bx + i * (segW + gap), col = st.colors[i];
        rr(ctx, sx, ry, segW, rh, 1.5 * k); ctx.fillStyle = rgba(col, 0.16); ctx.fill();
        var f = clamp(rf - i, 0, 1);
        if (f > 0 && (i >= st.lit || flashOn)) {
          rr(ctx, sx, ry, segW * f, rh, 1.5 * k);
          ctx.fillStyle = i < st.lit ? col : 'rgba(255,255,255,0.82)'; ctx.fill();
        }
      }
      ctx.restore();
    }

    function drawShiftLights(ctx, player, cx, y, w, k) {
      var n = 10;
      var st = shiftLights(S.rpmDisp || player.rpm, player.redline, n);
      var tnow = now();
      var flashOn = !st.flash || Math.floor(tnow / 80) % 2 === 0;
      var r = Math.min(w / n / 2 - 1.5 * k, 7 * k);
      var stepX = w / n;
      var x0 = cx - w / 2 + stepX / 2;
      ctx.save();
      rr(ctx, cx - w / 2 - 6 * k, y - r - 5 * k, w + 12 * k, r * 2 + 10 * k, r + 5 * k);
      ctx.fillStyle = 'rgba(8,9,12,0.85)'; ctx.fill();
      for (var i = 0; i < n; i++) {
        var on = i < st.lit && flashOn;
        var col = st.colors[i];
        ctx.beginPath(); ctx.arc(x0 + i * stepX, y, r, 0, Math.PI * 2);
        if (on) {
          ctx.save();
          ctx.shadowColor = col; ctx.shadowBlur = 10 * k;
          ctx.fillStyle = col; ctx.fill();
          ctx.restore();
          ctx.beginPath(); ctx.arc(x0 + i * stepX - r * 0.3, y - r * 0.3, r * 0.35, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fill();
        } else {
          ctx.fillStyle = rgba(col, 0.13); ctx.fill();
        }
      }
      ctx.restore();
    }

    function drawPedals(ctx, player, x, y, h, k) {
      var bw = 9 * k, gap = 5 * k;
      var th = clamp(num(player.throttle, 0), 0, 1), br = clamp(num(player.brake, 0), 0, 1);
      ctx.save();
      [[th, PAL.green, 'T'], [br, PAL.red, 'B']].forEach(function (p, i) {
        var bx = x + i * (bw + gap);
        rr(ctx, bx, y, bw, h, 3 * k);
        ctx.fillStyle = 'rgba(8,9,12,0.8)'; ctx.fill();
        ctx.strokeStyle = PAL.panelEdge; ctx.stroke();
        var fh = (h - 4 * k) * p[0];
        if (fh > 0.5) {
          ctx.save();
          ctx.shadowColor = p[1]; ctx.shadowBlur = 6 * k;
          rr(ctx, bx + 2 * k, y + h - 2 * k - fh, bw - 4 * k, fh, 2 * k);
          ctx.fillStyle = p[1]; ctx.fill();
          ctx.restore();
        }
        font(ctx, '700', 8.5 * k);
        text(ctx, p[2], bx + bw / 2, y + h + 8 * k, PAL.inkDim, 'center');
      });
      ctx.restore();
    }

    function drawAssists(ctx, snap, player, x, y, k, alignRight) {
      var a = snap.assists || (snap.config && snap.config.assists) || opts.assists || {};
      var tnow = now();
      var items = [];
      var absOn = a.abs != null ? !!a.abs : null;
      var tcOn = a.tc != null ? !!a.tc : null;
      var autoOn = a.autoShift != null ? !!a.autoShift : null;
      var absAct = player.absActive != null ? !!player.absActive :
        (absOn && num(player.brake, 0) > 0.5 && num(player.skidding, 0) > 0.08 && num(player.speed, 0) > 3);
      var tcAct = player.tcActive != null ? !!player.tcActive :
        (tcOn && num(player.throttle, 0) > 0.4 && num(player.wheelspin, 0) > 0.12);
      if (absOn != null) items.push({ l: 'ABS', on: absOn, act: absAct, c: PAL.amber });
      if (tcOn != null) items.push({ l: 'TC', on: tcOn, act: tcAct, c: PAL.amber });
      if (autoOn != null) items.push({ l: autoOn ? 'AUTO' : 'MAN', on: true, act: false, c: PAL.cyan });
      if (a.racingLine) items.push({ l: 'LINE', on: true, act: false, c: PAL.cyan });
      if (a.steeringAssist) items.push({ l: 'STR', on: true, act: false, c: PAL.cyan });
      if (!items.length) return;
      ctx.save();
      font(ctx, '800', 9.5 * k);
      var widths = items.map(function (it) { return ctx.measureText(it.l).width + 12 * k; });
      var total = widths.reduce(function (s, v) { return s + v; }, 0) + (items.length - 1) * 4 * k;
      var cx = alignRight ? x - total : x;
      var h = 17 * k;
      items.forEach(function (it, i) {
        var w = widths[i];
        var blink = it.act && Math.floor(tnow / 110) % 2 === 0;
        rr(ctx, cx, y, w, h, 3 * k);
        if (blink) { ctx.fillStyle = it.c; ctx.fill(); }
        else {
          ctx.fillStyle = 'rgba(8,9,12,0.8)'; ctx.fill();
          ctx.strokeStyle = it.on ? rgba(it.c, 0.75) : 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1; ctx.stroke();
        }
        text(ctx, it.l, cx + w / 2, y + h / 2 + 0.5 * k, blink ? '#0b0c0f' : it.on ? it.c : PAL.inkFaint, 'center');
        if (!it.on) {
          ctx.strokeStyle = 'rgba(255,255,255,0.35)';
          ctx.beginPath(); ctx.moveTo(cx + 4 * k, y + h / 2); ctx.lineTo(cx + w - 4 * k, y + h / 2); ctx.stroke();
        }
        cx += w + 4 * k;
      });
      ctx.restore();
    }

    // --- minimap -----------------------------------------------------------
    function drawMinimap(ctx, snap, player, x, y, w, h, k) {
      if (G.pts.length < 3) return;
      var key = Math.round(w) + 'x' + Math.round(h);
      if (key !== miniKey) { miniT = fitTransform(miniPts, w, h, 12 * k, flipY); miniKey = key; }
      var T = miniT;
      ctx.save();
      panel(ctx, x, y, w, h, 8 * k, 'rgba(10,12,16,0.55)');
      ctx.translate(x, y);

      // sector colouring from player's current/last sector status
      var cars = (snap.cars || []).filter(Boolean);
      var overall = [null, null, null];
      cars.forEach(function (c) {
        var bs = c.bestSectors || [];
        for (var i = 0; i < 3; i++) if (isNum(bs[i]) && (overall[i] == null || bs[i] < overall[i])) overall[i] = bs[i];
      });
      var secStatus = [null, null, null];
      if (player) {
        var cur = player.sectors || [], last = player.lastSectors || [], pb = player.bestSectors || [];
        for (var si = 0; si < 3; si++) {
          var t = isNum(cur[si]) ? cur[si] : last[si];
          secStatus[si] = sectorClass(t, pb[si], overall[si]);
        }
      }
      var mp = new Array(miniPts.length);
      for (var i = 0; i < miniPts.length; i++) mp[i] = mapPoint(T, miniPts[i][0], miniPts[i][1]);

      // outline (shadow + body)
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      for (var j = 0; j < mp.length; j++) j ? ctx.lineTo(mp[j][0], mp[j][1]) : ctx.moveTo(mp[j][0], mp[j][1]);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineWidth = 7 * k; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.88)'; ctx.lineWidth = 3.4 * k; ctx.stroke();

      // per-sector tint
      for (var sc = 0; sc < 3; sc++) {
        var s0 = G.sectors[sc], s1 = sc < 2 ? G.sectors[sc + 1] : G.length + 1;
        var col = secStatus[sc] ? classColor(secStatus[sc]) : null;
        if (!col) continue;
        ctx.beginPath();
        var started = false;
        for (var m = 0; m < mp.length; m++) {
          if (miniS[m] >= s0 && miniS[m] < s1) {
            started ? ctx.lineTo(mp[m][0], mp[m][1]) : ctx.moveTo(mp[m][0], mp[m][1]);
            started = true;
          }
        }
        if (sc === 2 && started) ctx.lineTo(mp[0][0], mp[0][1]);
        ctx.strokeStyle = col; ctx.lineWidth = 2.6 * k; ctx.stroke();
      }
      // sector boundary ticks
      for (var sb = 1; sb < 3; sb++) {
        var bi = 0;
        for (var q = 0; q < miniS.length; q++) if (miniS[q] >= G.sectors[sb]) { bi = q; break; }
        var pA = mp[bi], pB = mp[(bi + 1) % mp.length];
        var ang = Math.atan2(pB[1] - pA[1], pB[0] - pA[0]) + Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(pA[0] - Math.cos(ang) * 5 * k, pA[1] - Math.sin(ang) * 5 * k);
        ctx.lineTo(pA[0] + Math.cos(ang) * 5 * k, pA[1] + Math.sin(ang) * 5 * k);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.3 * k; ctx.stroke();
      }

      // start/finish line (chequered bar perpendicular to track)
      var st = mapPoint(T, G.start[0], G.start[1]);
      var st2 = mp[1] || st;
      var sa = Math.atan2(st2[1] - mp[0][1], st2[0] - mp[0][0]);
      ctx.save();
      ctx.translate(st[0], st[1]); ctx.rotate(sa);
      chequer(ctx, -2 * k, -7 * k, 4 * k, 14 * k, 2 * k, 1);
      ctx.restore();

      // ghost
      if (snap.ghost && isNum(snap.ghost.x)) {
        var gp = mapPoint(T, snap.ghost.x, snap.ghost.y);
        ctx.save();
        ctx.globalAlpha = 0.75;
        ctx.beginPath(); ctx.arc(gp[0], gp[1], 3.6 * k, 0, Math.PI * 2);
        ctx.strokeStyle = PAL.cyan; ctx.lineWidth = 1.5 * k; ctx.stroke();
        ctx.restore();
      }

      // cars (others first, player last)
      var order = cars.slice().sort(function (a, b) { return (a === player) - (b === player) || num(b.position, 0) - num(a.position, 0); });
      for (var c = 0; c < order.length; c++) {
        var car = order[c];
        if (!isNum(car.x) || !isNum(car.y)) continue;
        var p = mapPoint(T, car.x, car.y);
        var me = car === player;
        if (me) {
          var pulse = 0.5 + 0.5 * Math.sin(now() / 220);
          ctx.beginPath(); ctx.arc(p[0], p[1], (7 + pulse * 3) * k, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,' + (0.18 * (1 - pulse) + 0.06) + ')'; ctx.fill();
          // heading chevron
          var hd = num(car.heading, 0);
          var dir = mapPoint(T, car.x + Math.cos(hd) * 10, car.y + Math.sin(hd) * 10);
          var ha = Math.atan2(dir[1] - p[1], dir[0] - p[0]);
          ctx.save();
          ctx.translate(p[0], p[1]); ctx.rotate(ha);
          ctx.beginPath();
          ctx.moveTo(7 * k, 0); ctx.lineTo(-4 * k, -4.6 * k); ctx.lineTo(-2 * k, 0); ctx.lineTo(-4 * k, 4.6 * k); ctx.closePath();
          ctx.fillStyle = '#ffffff'; ctx.shadowColor = car.color || PAL.accent; ctx.shadowBlur = 8 * k; ctx.fill();
          ctx.lineWidth = 1.2 * k; ctx.strokeStyle = car.color || PAL.accent; ctx.stroke();
          ctx.restore();
        } else {
          ctx.beginPath(); ctx.arc(p[0], p[1], 3.5 * k, 0, Math.PI * 2);
          ctx.fillStyle = car.color || '#bbb'; ctx.fill();
          ctx.lineWidth = 1 * k; ctx.strokeStyle = lum(car.color || '#bbb') > 0.6 ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.8)'; ctx.stroke();
          if (car.position === 1 && (snap.mode || 'race') === 'race') {
            font(ctx, '800', 7 * k);
            text(ctx, '1', p[0], p[1] - 8 * k, PAL.ink, 'center');
          }
        }
      }
      // track name
      if (trackDef && trackDef.name) {
        font(ctx, '700', 9 * k);
        ctx.globalAlpha = 0.7;
        text(ctx, String(trackDef.name).toUpperCase(), 9 * k, h - 9 * k, PAL.inkDim, 'left');
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }

    // --- countdown lights --------------------------------------------------
    /** Top of the lights gantry: H * 0.12, pushed below every `avoid` rect it would overlap. */
    function countdownTop(W, H, k, avoid) {
      var podH = 108 * k, totalW = 5 * 46 * k + 4 * 12 * k, x0 = W / 2 - totalW / 2;
      var y0 = Math.max(18 * k, H * 0.12), L = x0 - 20 * k, Rr = x0 + totalW + 20 * k;
      for (var pass = 0; pass < 3; pass++) {
        var moved = false;
        (avoid || []).forEach(function (r) {
          if (!r || !(r.w > 0) || !(r.h > 0)) return;
          if (r.x >= Rr || r.x + r.w <= L) return;                      // no horizontal overlap
          if (r.y >= y0 + podH || r.y + r.h <= y0 - 14 * k) return;      // no vertical overlap
          y0 = r.y + r.h + 18 * k; moved = true;
        });
        if (!moved) break;
      }
      return y0;
    }
    function drawCountdown(ctx, snap, W, H, k, avoid) {
      var cd = snap.countdown || {};
      var tnow = now();
      var phase = snap.phase;
      var goAge = S.goAt != null ? tnow - S.goAt : null;
      var showLights = phase === 'grid' || phase === 'countdown' || (goAge != null && goAge < 1600);
      if (!showLights) return;
      var lightsOn = clamp(num(cd.lightsOn, 0), 0, 5);
      var out = !!cd.lightsOut || phase === 'racing';
      if (out) lightsOn = 0;

      var pods = 5;
      var podW = 46 * k, podH = 108 * k, gap = 12 * k;
      var totalW = pods * podW + (pods - 1) * gap;
      var x0 = W / 2 - totalW / 2;
      var y0 = countdownTop(W, H, k, avoid);
      // drop-in / lift-out animation
      var enter = S.cdEnterAt == null ? (S.cdEnterAt = tnow) : S.cdEnterAt;
      var ein = easeOutBack(clamp((tnow - enter) / 450, 0, 1));
      var lift = goAge != null ? easeInCubic(clamp((goAge - 900) / 600, 0, 1)) : 0;
      var dy = (1 - ein) * -(podH + y0) - lift * (podH + y0 + 40 * k);

      ctx.save();
      ctx.translate(0, dy);
      // gantry bar
      ctx.fillStyle = '#15171c';
      ctx.fillRect(x0 - 20 * k, y0 - 14 * k, totalW + 40 * k, 10 * k);
      ctx.fillStyle = '#2a2d35';
      ctx.fillRect(x0 - 20 * k, y0 - 14 * k, totalW + 40 * k, 2 * k);
      for (var i = 0; i < pods; i++) {
        var px = x0 + i * (podW + gap);
        rr(ctx, px, y0, podW, podH, 8 * k);
        var pg = ctx.createLinearGradient(px, 0, px + podW, 0);
        pg.addColorStop(0, '#0b0c0f'); pg.addColorStop(0.5, '#1d2026'); pg.addColorStop(1, '#0b0c0f');
        ctx.fillStyle = pg; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; ctx.stroke();
        for (var j = 0; j < 2; j++) {
          var lx = px + podW / 2, ly = y0 + podH * (0.3 + j * 0.42), lr = podW * 0.34;
          var lit = i < lightsOn;
          ctx.beginPath(); ctx.arc(lx, ly, lr, 0, Math.PI * 2);
          if (lit) {
            ctx.save();
            ctx.shadowColor = PAL.red; ctx.shadowBlur = 26 * k;
            var lg = ctx.createRadialGradient(lx - lr * 0.3, ly - lr * 0.3, lr * 0.1, lx, ly, lr);
            lg.addColorStop(0, '#ffd0d0'); lg.addColorStop(0.35, '#ff3344'); lg.addColorStop(1, '#a30010');
            ctx.fillStyle = lg; ctx.fill();
            ctx.restore();
          } else {
            ctx.fillStyle = '#2a0b0e'; ctx.fill();
            ctx.beginPath(); ctx.arc(lx - lr * 0.3, ly - lr * 0.3, lr * 0.25, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fill();
          }
        }
      }
      ctx.restore();

      // caption
      var capY = y0 + podH + 40 * k + dy * 0.2;
      if (out && goAge != null) {
        var gs = 1 + 0.5 * (1 - easeOutCubic(goAge / 300));
        var ga = 1 - clamp((goAge - 900) / 700, 0, 1);
        ctx.save();
        ctx.globalAlpha = ga;
        ctx.translate(W / 2, capY + 10 * k);
        ctx.scale(gs, gs);
        font(ctx, '900', 72 * k);
        ctx.shadowColor = PAL.green; ctx.shadowBlur = 30 * k;
        text(ctx, 'GO!', 0, 0, PAL.green, 'center');
        ctx.restore();
      } else if (phase === 'grid' || phase === 'countdown') {
        font(ctx, '700', 15 * k);
        ctx.save();
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(tnow / 300);
        var cap = lightsOn > 0 ? (lightsOn >= 5 ? 'WAIT FOR LIGHTS OUT' : 'REV UP · HELD ON THE LINE') : 'GET READY';
        if ((snap.mode || 'race') !== 'race') cap = lightsOn > 0 ? 'GET READY' : 'PREPARE TO LAUNCH';
        // dark backing pill so the caption stays readable over bright track/scenery
        var capW = ctx.measureText(cap).width + 34 * k, capH = 26 * k;
        rr(ctx, W / 2 - capW / 2, capY - capH / 2, capW, capH, capH / 2);
        ctx.fillStyle = 'rgba(8,9,12,0.72)'; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; ctx.stroke();
        text(ctx, cap, W / 2, capY, PAL.ink, 'center');
        ctx.restore();
      }
    }

    // --- banners -------------------------------------------------------------
    function drawBanners(ctx, W, H, k, topY) {
      var tnow = now();
      S.banners = S.banners.filter(function (b) { return tnow - b.born < b.dur + 500; });
      var y = topY;
      for (var i = 0; i < S.banners.length; i++) {
        var b = S.banners[i];
        var age = tnow - b.born;
        var tin = easeOutBack(age / 420);
        var tout = easeInCubic((age - b.dur) / 450);
        var bw = Math.min(W - 24 * k, (b.sub ? 400 : 340) * k);
        var bh = (b.sub ? 62 : 46) * k;
        var x = W / 2 - bw / 2 + (1 - tin) * (W / 2 + bw) - tout * (W / 2 + bw);
        ctx.save();
        ctx.globalAlpha = clamp(1 - tout, 0, 1);
        // body
        slant(ctx, x, y, bw, bh, 16 * k);
        ctx.fillStyle = 'rgba(8,9,12,0.9)'; ctx.fill();
        if (b.style === 'chequer') {
          ctx.save(); slant(ctx, x, y, bw, bh, 16 * k); ctx.clip();
          chequer(ctx, x, y, 40 * k, bh, 6 * k, 0.9);
          chequer(ctx, x + bw - 40 * k, y, 40 * k, bh, 6 * k, 0.9);
          ctx.restore();
        }
        // accent edge
        ctx.save(); slant(ctx, x, y, bw, bh, 16 * k); ctx.clip();
        ctx.fillStyle = b.color;
        ctx.fillRect(x, y, bw, 4 * k);
        if (b.style === 'final') {
          ctx.fillRect(x, y + bh - 4 * k, bw, 4 * k);
        }
        // shimmer sweep
        var sw = ((age / 900) % 1.6) - 0.3;
        var sg = ctx.createLinearGradient(x + sw * bw - 60 * k, 0, x + sw * bw + 60 * k, 0);
        sg.addColorStop(0, 'rgba(255,255,255,0)'); sg.addColorStop(0.5, 'rgba(255,255,255,0.08)'); sg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sg; ctx.fillRect(x, y, bw, bh);
        ctx.restore();

        var tx = W / 2 + (x - (W / 2 - bw / 2));
        var iconOff = 0;
        if (b.icon === 'clock') {
          font(ctx, '900', 24 * k);
          var tw = ctx.measureText(b.title).width;
          stopwatchIcon(ctx, tx - tw / 2 - 16 * k, y + (b.sub ? bh * 0.38 : bh / 2), 8 * k, b.color);
          iconOff = 10 * k;
        }
        font(ctx, '900', 24 * k);
        ctx.shadowColor = b.color; ctx.shadowBlur = 14 * k;
        text(ctx, b.title, tx + iconOff, y + (b.sub ? bh * 0.38 : bh / 2 + 1 * k), b.color === PAL.white ? PAL.white : b.color, 'center');
        ctx.shadowBlur = 0;
        if (b.sub) {
          font(ctx, '600', 13 * k);
          text(ctx, b.sub, tx, y + bh * 0.74, PAL.inkDim, 'center');
        }
        ctx.restore();
        y += (bh + 8 * k) * clamp(1 - tout, 0, 1);
      }
    }

    function drawWrongWay(ctx, snap, player, W, H, k) {
      if (!player || !player.wrongWay || snap.phase !== 'racing') { S.wrongWayAt = null; return; }
      var tnow = now();
      if (S.wrongWayAt == null) S.wrongWayAt = tnow;
      var age = tnow - S.wrongWayAt;
      var on = Math.floor(age / 380) % 2 === 0;
      var sc = easeOutBack(age / 300);
      var cx = W / 2, cy = H * 0.42;
      ctx.save();
      ctx.translate(cx, cy); ctx.scale(sc, sc);
      var w = 300 * k, h = 76 * k;
      rr(ctx, -w / 2, -h / 2, w, h, 10 * k);
      ctx.fillStyle = on ? 'rgba(200,10,25,0.92)' : 'rgba(40,6,8,0.9)';
      ctx.fill();
      ctx.lineWidth = 3 * k; ctx.strokeStyle = '#fff'; ctx.stroke();
      // U-turn arrow
      ctx.save();
      ctx.translate(-w / 2 + 40 * k, 0);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 4 * k; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(0, 0, 13 * k, Math.PI * 0.2, Math.PI * 1.6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(13 * k * Math.cos(Math.PI * 1.6) - 5 * k, 13 * k * Math.sin(Math.PI * 1.6) - 4 * k);
      ctx.lineTo(13 * k * Math.cos(Math.PI * 1.6) + 4 * k, 13 * k * Math.sin(Math.PI * 1.6));
      ctx.lineTo(13 * k * Math.cos(Math.PI * 1.6) - 3 * k, 13 * k * Math.sin(Math.PI * 1.6) + 7 * k);
      ctx.stroke();
      ctx.restore();
      font(ctx, '900', 34 * k);
      text(ctx, 'WRONG WAY', 22 * k, 1 * k, '#fff', 'center');
      ctx.restore();
    }

    function drawTrackLimitsStrip(ctx, player, x, y, k) {
      // small persistent warning pips under the timing panel when warnings exist
      var n = num(player.trackLimits, 0);
      if (n <= 0) return 0;
      ctx.save();
      font(ctx, '700', 9.5 * k);
      text(ctx, 'TRACK LIMITS', x, y + 7 * k, PAL.amber);
      var tw = ctx.measureText('TRACK LIMITS').width;
      for (var i = 0; i < trackLimitsMax; i++) {
        ctx.beginPath();
        ctx.rect(x + tw + 8 * k + i * 11 * k, y + 2 * k, 8 * k, 10 * k);
        ctx.fillStyle = i < n ? PAL.amber : 'rgba(255,159,28,0.18)';
        ctx.fill();
      }
      if (num(player.penalties_s, 0) > 0) {
        var px = x + tw + 14 * k + trackLimitsMax * 11 * k;
        var ps = '+' + fmtNumS(player.penalties_s) + 's';
        var pw = ctx.measureText(ps).width + 8 * k;
        ctx.fillStyle = PAL.red;
        rr(ctx, px, y + 1 * k, pw, 12 * k, 2 * k); ctx.fill();
        text(ctx, ps, px + pw / 2, y + 7 * k, '#fff', 'center');
      }
      ctx.restore();
      return 18 * k;
    }

    function drawPenaltyOnly(ctx, player, x, y, k) {
      if (num(player.penalties_s, 0) <= 0 || num(player.trackLimits, 0) > 0) return 0;
      ctx.save();
      font(ctx, '700', 9.5 * k);
      var ps = 'PENALTY +' + fmtNumS(player.penalties_s) + 's';
      var pw = ctx.measureText(ps).width + 10 * k;
      ctx.fillStyle = PAL.red;
      rr(ctx, x, y + 1 * k, pw, 14 * k, 2 * k); ctx.fill();
      text(ctx, ps, x + pw / 2, y + 8 * k, '#fff', 'center');
      ctx.restore();
      return 18 * k;
    }

    /* ================================================================ draw */

    function draw(ctx, snap) {
      if (destroyed || !ctx || !snap) return;
      var W = (canvas && (canvas.clientWidth || canvas.width)) || 1280;
      var H = (canvas && (canvas.clientHeight || canvas.height)) || 720;
      var t = now();
      S.dt = clamp((t - S.lastReal) / 1000, 0, 0.1);
      S.lastReal = t;

      var player = findPlayer(snap);
      if (snap !== S.lastSnap) { process(snap, player); S.lastSnap = snap; }
      if (!player) return;

      var compact = W < 760 || H < 480;
      var k = compact ? clamp(Math.min(W / 420, H / 420), 0.62, 1.05) : clamp(Math.min(W / 1366, H / 800) * 1.06, 0.72, 1.6);
      var M = Math.round((compact ? 8 : 18) * k);
      var mode = snap.mode || 'race';
      var strip = stripLayout(W, H, layout, k);
      HUD.strip = strip;

      ctx.save();
      ctx.lineJoin = 'miter';
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;

      // --- top-right: timing
      var timingW = (compact ? 178 : 268) * k;
      var tx = W - M - timingW;
      // opts.timing / tower / cluster === false: a mode HUD draws its own (F1: js/f1/f1-hud.js, docs/F1-SPEC.md §6)
      var th = opts.timing === false ? 0 : drawTiming(ctx, snap, player, tx, M, k, compact, !!strip);
      var stripY = M + th;
      if (opts.timing !== false) {
        stripY += drawTrackLimitsStrip(ctx, player, tx, stripY, k);
        stripY += drawPenaltyOnly(ctx, player, tx, stripY, k);
      }

      // --- top-left: tower (race) or minimap in compact
      var towerH = 0;
      if (opts.tower !== false && (mode === 'race' || (snap.cars || []).length > 1)) {
        var maxH = compact ? H * (strip && layout.noMinimap ? 0.36 : 0.42) : H * 0.62;
        towerH = drawTower(ctx, snap, player, M, M, k, maxH, compact);
      }

      // --- minimap
      var mmW, mmH, mmX, mmY;
      if (strip) {
        // short phone landscape: the right column holds the quick buttons / arcade buttons, so the map goes under the
        // tower and only if it clears the touch steering pad (and the webcam preview is not shown there)
        mmW = Math.min(timingW, 150 * k); mmH = mmW * 0.78;
        mmX = M; mmY = M + towerH + (towerH ? 6 * k : 0);
        if (layout.noMinimap || mmY + mmH > H - strip.bottomPad - 104) mmW = 0;
      } else if (compact) {
        mmW = Math.min(timingW, 150 * k); mmH = mmW * 0.78;
        mmX = W - M - mmW; mmY = stripY + 4 * k;
        if (mmY + mmH > H * 0.62) { mmY = M + towerH + 6 * k; mmX = M; }
        if (mmY + mmH > H * 0.7) mmW = 0;
      } else {
        mmW = 250 * k; mmH = 190 * k;
        mmX = M; mmY = H - M - mmH;
        if (mmY < M + towerH + 8 * k) { mmW = 0; }
      }
      if (mmW > 0 && opts.minimap !== false) drawMinimap(ctx, snap, player, mmX, mmY, mmW, mmH, k);

      // --- bottom cluster
      var R = compact ? clamp(Math.min(W, H) * 0.16, 46, 90) : 104 * k;
      var cx, cy;
      if (compact) { cx = W / 2; cy = H - M - R * 1.0; }
      else { cx = W - M - R * 1.12; cy = H - M - R * 1.0; }
      var kk = compact ? R / 104 : k;
      if (opts.cluster === false) {
        S.speedDisp = Math.abs(num(player.speed, 0)) * (units === 'mph' ? 2.23694 : 3.6); S.rpmDisp = num(player.rpm, S.rpmDisp);
      } else if (strip) {
        if (cockpitView || snap.cockpit) {
          S.speedDisp = Math.abs(num(player.speed, 0)) * (units === 'mph' ? 2.23694 : 3.6); S.rpmDisp = num(player.rpm, S.rpmDisp);
        } else drawStrip(ctx, snap, player, strip, k);   // touch pedals show their own fill: no pedal bars
      } else if (cockpitView || snap.cockpit) {
        // keep the smoothed displays ticking so leaving the cockpit view does not jump the needle
        S.speedDisp = Math.abs(num(player.speed, 0)) * (units === 'mph' ? 2.23694 : 3.6); S.rpmDisp = num(player.rpm, S.rpmDisp);
        var ph = R * 0.8;
        drawPedals(ctx, player, W - M - 23 * kk, H - M - ph - 18 * kk, ph, kk);
        drawAssists(ctx, snap, player, W - M, H - M - 2 * kk, kk * 0.95, true);
      } else {
        drawCluster(ctx, snap, player, cx, cy, R, compact ? R / 104 : k, compact);
        drawShiftLights(ctx, player, cx, cy - R * 1.16, R * 1.9, kk);
        drawPedals(ctx, player, cx - R * 1.24 - 23 * kk, cy - R * 0.55, R * 1.1, kk);
        drawAssists(ctx, snap, player, cx + R * 0.95, cy + R * 0.95 + 2 * kk, kk * 0.95, true);
      }

      // --- countdown, wrong way, banners (centre)
      // the lights drop below any top block they would cover (phone portrait: the tower, timing + sectors and minimap)
      var avoid = [{ x: tx, y: M, w: timingW, h: stripY - M }];
      if (towerH) avoid.push({ x: M, y: M, w: (compact ? 150 : 262) * k, h: towerH });
      if (mmW > 0 && opts.minimap !== false) avoid.push({ x: mmX, y: mmY, w: mmW, h: mmH });
      drawCountdown(ctx, snap, W, H, compact ? clamp(W / 640, 0.5, 1) : k, avoid);
      drawWrongWay(ctx, snap, player, W, H, compact ? clamp(W / 520, 0.6, 1) : k);
      var bannerTop = (snap.phase === 'countdown' || snap.phase === 'grid') ? H * 0.5 : H * (compact ? 0.2 : 0.16);
      drawBanners(ctx, W, H, compact ? clamp(W / 520, 0.62, 1) : k, bannerTop);

      ctx.restore();
    }

    return {
      draw: function (ctx, snap) {
        try { draw(ctx, snap); }
        catch (e) {
          if (!S.errLogged && typeof console !== 'undefined') { console.error('[CB.race.hud]', e); S.errLogged = true; }
        }
      },
      setUnits: function (u) { units = u === 'mph' ? 'mph' : 'kph'; },
      /** true while the 3D cockpit camera is active: hides the tach / speed cluster (the in-car dash shows them). */
      setCockpit: function (on) { cockpitView = !!on; },
      /** Phone layout hints (race-ui measures its touch controls): { touch, band: {l, r} | null, bottom, noMinimap }. */
      setLayout: function (o) {
        o = o || {};
        layout.touch = !!o.touch; layout.noMinimap = !!o.noMinimap; layout.bottom = Math.max(0, num(o.bottom, 0));
        layout.band = o.band && isNum(o.band.l) && isNum(o.band.r) && o.band.r > o.band.l ? { l: o.band.l, r: o.band.r } : null;
      },
      getLayout: function () { return layout; },
      isCockpit: function () { return cockpitView; },
      getUnits: function () { return units; },
      /** Optional: renderer/UI may push a banner (e.g. 'PIT LIMITER'). */
      banner: function (title, o) { addBanner(o && o.key || null, String(title || ''), o || {}); },
      reset: function () {
        S.banners = []; S.shownKeys = {}; S.prev = null; S.trace = []; S.goAt = null; S.lapFlash = null;
        S.rowY = {}; S.prevPos = {}; S.posChange = {}; S.cdEnterAt = null; S.countdownSeen = false; S.lastSnap = null;
      },
      destroy: function () { destroyed = true; S.banners = []; S.trace = []; S.bestTrace = null; }
    };
  }

  /**
   * Short phone landscape (touch, compact, H <= 500, W >= 1.3 H): the speed / rpm cluster becomes a slim bar at the bottom
   * centre, clear of the car in the chase view; returns its rect { x, y, w, h, bottomPad } or null (normal layout).
   * L = { touch, band: {l, r} | null, bottom } (see setLayout).
   */
  function stripLayout(W, H, L, k) {
    L = L || {};
    if (!L.touch || !(W < 760 || H < 480) || H > 500 || W < H * 1.3) return null;
    k = isNum(k) ? k : clamp(Math.min(W / 420, H / 420), 0.62, 1.05);
    var h = Math.round(clamp(H * 0.105, 34, 46));
    var l = L.band ? L.band.l : 0, r = L.band ? L.band.r : W;
    var cx = (l + r) / 2;
    var w = Math.round(clamp(Math.min(r - l - 16 * k, 250 * k), 132, 260));
    var x = Math.round(clamp(cx - w / 2, 4, W - w - 4));
    var bottomPad = Math.max(isNum(L.bottom) ? L.bottom : 0, 8);
    return { x: x, y: Math.round(H - bottomPad - h), w: w, h: h, bottomPad: bottomPad };
  }

  /** Ease an animated tower row index toward its slot; snaps when close or far. */
  function stepRowY(cur, target, dt) {
    if (cur == null || !isFinite(cur) || Math.abs(cur - target) > 6) return target;
    var t = 1 - Math.exp(-(dt > 0 ? dt : 0) * 10);
    var v = cur + (target - cur) * t;
    return Math.abs(v - target) < 0.004 ? target : v;
  }

  /**
   * Draw order for tower rows given animated positions (curs[slot]).
   * Settled rows first (slot order), then moving rows: losers (cur < slot)
   * before gainers (cur > slot), smaller displacement first, so the car
   * gaining a place is always painted on top. Returns slot indices with
   * a `moving` count property.
   */
  function towerDrawOrder(curs) {
    var settled = [], mov = [];
    for (var i = 0; i < curs.length; i++) (curs[i] === i ? settled : mov).push(i);
    mov.sort(function (a, b) {
      var da = curs[a] - a, db = curs[b] - b;     // >0: coming from below (gainer)
      if ((da > 0) !== (db > 0)) return da > 0 ? 1 : -1;
      return Math.abs(da) - Math.abs(db) || a - b;
    });
    var out = settled.concat(mov);
    out.moving = mov.length;
    return out;
  }

  var HUD = CB.race.hud = {
    create: create,
    /** last drawn short-landscape cluster bar rect (or null) — CB.arcade.hud stacks its nitro gauge on it */
    strip: null,
    stripLayout: stripLayout,
    _internal: {
      stripLayout: stripLayout,
      fmtTime: fmtTime, fmtDelta: fmtDelta, fmtGap: fmtGap, sectorClass: sectorClass,
      shiftLights: shiftLights, extractGeom: extractGeom, fitTransform: fitTransform,
      mapPoint: mapPoint, traceAt: traceAt, nearestIndex: nearestIndex, tla: tla, surname: surname,
      stepRowY: stepRowY, towerDrawOrder: towerDrawOrder
    }
  };
})();

if (typeof module !== 'undefined') module.exports = CB.race.hud;

/* ==========================================================================
   FORGE Atelier — js/race/drift/hud.js
   CB.race.drift.hud : arcade / broadcast drift overlay (DRIFT-SPEC §6).

     CB.race.drift.hud.create(canvas, opts) -> {
       draw(ctx, snapshot, scorerState, assistDebug?),
       reset(), setUnits('kph'|'mph'), setOptions(o), setProjector(fn),
       popup(text, points?, o?), debugState(), destroy()
     }

   Drawn on the 2D overlay canvas AFTER the regular CB.race.hud (ctx is in
   CSS-pixel transform, layout uses canvas.clientWidth/clientHeight).
   Layout (desktop): score banner + timer + zone counter + medal ladder at
   top-centre, tandem gauge under it, grade popups in the upper-middle,
   zone arrows at mid height left/right, drift meter cluster (angle arc,
   current points + grade, multiplier + combo/chain bars, zone ribbon) at
   bottom-centre between the regular HUD's minimap (bottom-left) and its
   speed cluster (bottom-right). Compact screens stack everything at top.

   Feel / readability (drift-hold feedback): the angle needle is a critically
   damped spring (no frame-noise shiver), DRIFTING/glow use 0.3 s release
   hysteresis, "SAVE IT!" + grace bar when the angle collapses mid-drift,
   cyan hold window on the arc around the assist's target angle ("LOCKED IN"),
   multiplier charge bar, points/s + drift time, milestone counter bumps,
   debounced arrow-key coach strip (scorer state().coach), assist phase chip
   (ANGLE HOLD / KICK! / ASSIST CATCH / SPIN RECOVERY), wall-proximity gauge,
   edge speed streaks that heat up with the combo, repeated callouts stack
   ("SWING! ×2") instead of spamming.

   opts (all optional):
     units 'kph'|'mph', mode 'free'|'trial'|'tandem', tandem bool,
     targets {bronze,silver,gold,platinum} | [{medal,score}] | [b,s,g,p],
     duration_s (run timer when the scorer has no time field),
     geom / trackDef (track length + targets fallback), leadId (tandem lead car id),
     worldToScreen(x, y, z) -> {x, y, visible?}   (draw 3D-anchored zone markers),
     top (px offset for the score banner), bottom (px offset for the meter),
     comboMax (default 5), chainWindow_s (default 1.5), now() (clock in ms, tests),
     coach (false hides the tip strip), streaks (false hides edge speed streaks)

   Every input field is optional; the scorer, session and assist are built
   in parallel so all reads are defensive (see `_internal` for the pure
   normalisers that are Node-tested in tests/drift-hud.test.js).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};
CB.race.drift = CB.race.drift || {};

(function () {
  'use strict';

  /* ------------------------------------------------------------ constants */

  var PAL = {
    panel: 'rgba(9,10,14,0.80)',
    panelSoft: 'rgba(9,10,14,0.55)',
    edge: 'rgba(255,255,255,0.10)',
    ink: '#f5f6f8',
    inkDim: 'rgba(245,246,248,0.64)',
    inkFaint: 'rgba(245,246,248,0.30)',
    accent: '#ff5a1f',     // FORGE orange
    hot: '#ff3fa4',        // drift magenta
    cyan: '#2fe6ff',
    green: '#4dff9a',
    yellow: '#ffd23f',
    amber: '#ff9f1c',
    red: '#ff2e47',
    purple: '#b86bff',
    gold: '#f2c14e'
  };
  var FONT_UI = "'Barlow Condensed','Roboto Condensed','Arial Narrow','Helvetica Neue',system-ui,sans-serif";
  var FONT_NUM = "ui-monospace,'SF Mono','Roboto Mono',Menlo,Consolas,monospace";
  var TAU = Math.PI * 2;
  var DEG = 180 / Math.PI;

  var GRADES = {
    D: { label: 'DRIFT', color: '#9aa3b2', rank: 0 },
    C: { label: 'NICE', color: '#d6dce8', rank: 1 },
    B: { label: 'GOOD', color: '#2fe6ff', rank: 2 },
    A: { label: 'GREAT', color: '#4dff9a', rank: 3 },
    S: { label: 'AWESOME', color: '#ffd23f', rank: 4 },
    SS: { label: 'INSANE', color: '#ff3fa4', rank: 5 },
    SSS: { label: 'LEGENDARY', color: '#ff5a1f', rank: 6 }
  };
  var MEDALS = {
    bronze: { label: 'BRONZE', color: '#d08a4f', rank: 1 },
    silver: { label: 'SILVER', color: '#cfd6e0', rank: 2 },
    gold: { label: 'GOLD', color: '#f2c14e', rank: 3 },
    platinum: { label: 'PLATINUM', color: '#9fe8ff', rank: 4 }
  };
  var MEDAL_ORDER = ['bronze', 'silver', 'gold', 'platinum'];
  var ZONE_KIND = {
    inner: { label: 'INNER CLIP', color: '#2fe6ff' },
    outer: { label: 'OUTER ZONE', color: '#ff3fa4' },
    clip: { label: 'CLIPPING POINT', color: '#2fe6ff' },
    point: { label: 'CLIPPING POINT', color: '#2fe6ff' },
    wall: { label: 'WALL ZONE', color: '#ff9f1c' },
    zone: { label: 'CLIPPING ZONE', color: '#b86bff' },
    swing: { label: 'SWING ZONE', color: '#b86bff' }
  };

  /* ------------------------------------------------------------- helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function first() { for (var i = 0; i < arguments.length; i++) if (isNum(arguments[i])) return arguments[i]; return null; }
  function clamp(v, a, b) { v = +v; if (v !== v) v = a; return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return clamp(v, 0, 1); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutCubic(t) { t = clamp01(t); return 1 - Math.pow(1 - t, 3); }
  function easeInCubic(t) { t = clamp01(t); return t * t * t; }
  function easeOutBack(t) { t = clamp01(t); var c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function easeOutElastic(t) {
    t = clamp01(t); if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1;
  }
  function sysNow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  function hexToRgb(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h.slice(0, 6), 16);
    if (h.length < 6 || n !== n) return { r: 220, g: 220, b: 220 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgba(hex, a) { var c = hexToRgb(hex); return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + clamp01(a) + ')'; }

  /** 1234567 -> "1,234,567" (rounded, signed only when negative). */
  function fmtInt(n) {
    n = Math.round(num(n, 0));
    var neg = n < 0, s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return neg ? '-' + s : s;
  }
  /** 12500 -> "12.5K", 2000000 -> "2M". */
  function fmtShort(n) {
    n = num(n, 0);
    var a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(Math.round(n));
  }
  /** seconds -> "1:05.3" (tenths) / "--:--" for null. */
  function fmtClock(t) {
    if (!isNum(t)) return '--:--';
    t = Math.max(0, t);
    var m = Math.floor(t / 60), s = t - m * 60;
    var ss = s.toFixed(1); if (s < 10) ss = '0' + ss;
    if (ss === '60.0') { m += 1; ss = '00.0'; }
    return m + ':' + ss;
  }
  function fmtMult(m) { m = num(m, 1); return '\u00d7' + (Math.round(m * 10) / 10).toFixed(1); }

  /** Grade code (C/B/A/S/SS…, case-insensitive, also {grade}) -> {code,label,color,rank} or null. */
  function gradeInfo(g) {
    if (g && typeof g === 'object') g = g.grade || g.code || g.id;
    if (g == null || g === '') return null;
    var code = String(g).toUpperCase().trim();
    var gi = GRADES[code];
    if (!gi) return { code: code, label: code, color: PAL.ink, rank: 0 };
    return { code: code, label: gi.label, color: gi.color, rank: gi.rank };
  }

  /** Classify a scorer event text for colour / size / behaviour. */
  var KIND_MAP = { bank: 'bank', zone: 'zone', clip: 'zone', swing: 'swing', manji: 'swing', transition: 'swing', tandem: 'tandem',
    entry: 'bonus', long: 'bonus', bonus: 'bonus', combo: 'bonus', save: 'bonus', saved: 'bonus', milestone: 'bonus',
    wall: 'wall', wallclose: 'wall', scrape: 'wall', wallscrape: 'wall',
    backwards: 'bad', offtrack: 'bad', spin: 'bad', lost: 'bad', crash: 'bad', wallhit: 'bad', hit: 'bad', penalty: 'bad' };
  function classifyEvent(text, points, kind) {
    var t = String(text || '');
    var k = kind && KIND_MAP[String(kind).toLowerCase().replace(/[^a-z]/g, '')];
    if (k) {
      // 'wall' from a scorer could be a hit rather than a bonus: trust the text when it says so
      if (k === 'wall' && /hit|crash|lost/i.test(t)) k = 'bad';
    } else if (/(close|near|kiss).*(wall|barrier)|wall.*(bonus|kiss|close)/i.test(t)) k = 'wall';
    else if (/lost|spin|crash|hit|off[ -]?track|backward|wrong|fail|bust|penal/i.test(t)) k = 'bad';
    else if (/tandem|door|proximity|chase|lead/i.test(t)) k = 'tandem';
    else if (/clip|zone/i.test(t)) k = 'zone';
    else if (/swing|manji|transition|switch|flick/i.test(t)) k = 'swing';
    else if (/long|entry|speed|angle|combo|bonus|max/i.test(t)) k = 'bonus';
    else if (/drift|nice|good|great|awesome|insane|legend|banked|perfect/i.test(t)) k = 'bank';
    else k = isNum(points) && points < 0 ? 'bad' : 'bonus';
    var color = { wall: PAL.amber, bad: PAL.red, tandem: PAL.hot, zone: PAL.cyan, swing: PAL.purple, bank: PAL.gold, bonus: '#ffb347' }[k];
    return { kind: k, color: color, big: k === 'bank', bad: k === 'bad' };
  }

  /** Normalise medal targets -> ascending [{medal,label,color,score}]. */
  function normalizeTargets(t) {
    if (!t) return [];
    var out = [];
    if (Array.isArray(t)) {
      for (var i = 0; i < t.length; i++) {
        var e = t[i];
        if (isNum(e)) { if (MEDAL_ORDER[i]) out.push({ medal: MEDAL_ORDER[i], score: e }); }
        else if (e && typeof e === 'object') {
          var id = String(e.medal || e.id || e.name || e.tier || MEDAL_ORDER[i] || '').toLowerCase();
          var sc = first(e.score, e.points, e.target, e.value, e.min);
          if (isNum(sc)) out.push({ medal: id, score: sc });
        }
      }
    } else if (typeof t === 'object') {
      for (var j = 0; j < MEDAL_ORDER.length; j++) {
        var v = t[MEDAL_ORDER[j]];
        if (v && typeof v === 'object') v = first(v.score, v.points, v.target);
        if (isNum(v)) out.push({ medal: MEDAL_ORDER[j], score: v });
      }
    }
    out.sort(function (a, b) { return a.score - b.score; });
    return out.map(function (e) {
      var m = MEDALS[e.medal] || { label: String(e.medal || '').toUpperCase(), color: PAL.ink, rank: 0 };
      return { medal: e.medal, label: m.label, color: m.color, score: e.score };
    });
  }
  /** {current: medal|null, next: medal|null, toNext} for a total on a ladder. */
  function medalProgress(total, ladder) {
    var cur = null, next = null;
    for (var i = 0; i < ladder.length; i++) {
      if (total >= ladder[i].score) cur = ladder[i];
      else { next = ladder[i]; break; }
    }
    return { current: cur, next: next, toNext: next ? next.score - total : 0 };
  }

  function zoneS(z) { return first(z.s0, z.start, z.startS, z.start_s, z.from, z.s); }
  function zoneLen(z) {
    var L = first(z.length, z.len, z.length_m);
    if (isNum(L)) return Math.max(1, L);
    var a = first(z.s0, z.start), b = first(z.s1, z.end, z.to);
    if (isNum(a) && isNum(b) && b > a) return b - a;
    return 18;
  }
  /** -1 = left, +1 = right, 0 = unknown. */
  function zoneSide(z) {
    function lr(v) {
      if (isNum(v)) return v > 0 ? -1 : v < 0 ? 1 : 0;   // +lateral = left in track frame
      var s = String(v || '').toLowerCase();
      if (s === 'l' || s === 'left') return -1;
      if (s === 'r' || s === 'right') return 1;
      return 0;
    }
    var d = lr(z.side); if (d) return d;
    d = lr(z.screenSide); if (d) return d;
    var turn = lr(z.turn != null ? z.turn : z.dir != null ? z.dir : z.corner);
    var io = String(z.side || z.kind || '').toLowerCase();
    if (turn && io.indexOf('inner') >= 0) return turn;
    if (turn && io.indexOf('outer') >= 0) return -turn;
    if (isNum(z.lateral)) return lr(z.lateral);
    return 0;
  }
  function zoneKind(z) {
    var k = String(z.kind || z.type || '').toLowerCase();
    if (ZONE_KIND[k]) return k;
    var sd = String(z.side || '').toLowerCase();
    if (sd === 'inner' || sd === 'outer') return sd;
    return 'zone';
  }
  /**
   * Next relevant zone ahead of track distance s on a lap of length L.
   * -> {zone, dist, inZone, progress, index} or null.  Hit zones are skipped unless the car is inside them.
   */
  function nextZone(zones, s, L, lookahead) {
    if (!Array.isArray(zones) || !zones.length || !isNum(s)) return null;
    L = L > 0 ? L : 1e9;
    var best = null;
    for (var i = 0; i < zones.length; i++) {
      var z = zones[i]; if (!z) continue;
      var zs = zoneS(z); if (!isNum(zs)) continue;
      var len = zoneLen(z);
      var ahead = ((zs - s) % L + L) % L;
      var inside = ahead > L - len || ahead === 0 || !!z.active;
      if (inside) {
        var back = ahead === 0 ? 0 : L - ahead;
        var cand = { zone: z, dist: 0, inZone: true, progress: clamp01(back / len), index: i };
        if (!best || !best.inZone) best = cand;
        continue;
      }
      if (z.hit) continue;
      if (isNum(lookahead) && ahead > lookahead) continue;
      if (!best || (!best.inZone && ahead < best.dist)) best = { zone: z, dist: ahead, inZone: false, progress: 0, index: i };
    }
    return best;
  }

  /** Signed drift angle (deg) of a snapshot car: negative = velocity right of nose (left-hand drift). */
  function carDriftAngle(car) {
    if (!car) return 0;
    var vxl = car.vxLocal, vyl = car.vyLocal;
    if (!isNum(vxl) || !isNum(vyl)) {
      if (!isNum(car.vx) || !isNum(car.vy) || !isNum(car.heading)) return 0;
      var c = Math.cos(car.heading), s = Math.sin(car.heading);
      vxl = c * car.vx + s * car.vy; vyl = -s * car.vx + c * car.vy;
    }
    if (Math.hypot(vxl, vyl) < 2) return 0;
    return Math.atan2(vyl, Math.abs(vxl)) * DEG;
  }
  function radOrDeg(v, nameIsDeg) {
    if (!isNum(v)) return null;
    if (nameIsDeg) return v;
    return Math.abs(v) <= Math.PI * 1.05 ? v * DEG : v;
  }
  /** Read assist.debug() in any of the plausible field spellings -> {beta, target, counter, level} (deg / -1..1). */
  function readAssist(dbg) {
    if (!dbg || typeof dbg !== 'object') return null;
    var beta = isNum(dbg.beta_deg) ? dbg.beta_deg : radOrDeg(first(dbg.beta, dbg.driftAngle, dbg.slip), false);
    var target = first(dbg.target_deg, dbg.targetAngle_deg, dbg.targetBeta_deg);
    if (!isNum(target)) target = radOrDeg(first(dbg.targetAngle, dbg.targetBeta, dbg.target), false);
    var counter = first(dbg.counterSteer, dbg.appliedCounterSteer, dbg.applied, dbg.counter);
    // CB.race.assist reports counter-steer in degrees of road-wheel angle: normalise against ~40° of lock
    if (!isNum(counter) && isNum(dbg.counterSteer_deg)) counter = dbg.counterSteer_deg / 40;
    var phase = dbg.phase != null ? String(dbg.phase).toLowerCase() : null;
    var stab = first(dbg.yawStab_deg, dbg.yawDamp, dbg.yawDamping, dbg.stabilize);
    return {
      beta: beta, target: target, counter: isNum(counter) ? clamp(counter, -1, 1) : null,
      level: dbg.level || null, mode: dbg.mode || null, phase: phase,
      hold: isNum(dbg.holdAngle_deg) ? dbg.holdAngle_deg : null,
      yawDamp: stab,
      recovering: !!dbg.recovering || phase === 'spin',
      exiting: !!dbg.exiting,
      braking: !!(dbg.assistBraking || dbg.assistBrake),
      initiating: !!(dbg.initiating || dbg.kick || dbg.initiation) || phase === 'init'
    };
  }
  /** Short status chip for the assist ({label, color}) — tells the player the assist has their back. */
  function assistPhase(as) {
    if (!as) return null;
    if (as.phase === 'spin') return { id: 'spin', label: 'SPIN RECOVERY', color: PAL.red };
    if (as.recovering) return { id: 'catch', label: 'ASSIST CATCH', color: PAL.amber };
    if (as.exiting) return { id: 'exit', label: 'STRAIGHTENING', color: PAL.inkDim };
    if (as.braking) return { id: 'brake', label: 'ASSIST BRAKING', color: PAL.amber };
    if (as.initiating) return { id: 'kick', label: 'KICK!', color: PAL.hot };
    if (as.phase === 'drift') return { id: 'hold', label: 'ANGLE HOLD', color: PAL.cyan };
    if (as.phase === 'race') return { id: 'race', label: 'RACE ASSIST', color: PAL.inkDim };
    if (as.phase && as.phase.indexOf('grip') === 0) return { id: 'grip', label: 'GRIP', color: PAL.inkFaint };
    return null;
  }
  /** Normalise scorer.state().coach (object {id,text,tone} or string) -> {id,text,tone,color} | null. */
  var TONE_COLOR = { good: PAL.green, info: PAL.cyan, warn: PAL.amber, bad: PAL.red };
  function coachInfo(c) {
    if (!c) return null;
    if (typeof c === 'string') c = { text: c };
    if (typeof c !== 'object' || !c.text) return null;
    var tone = TONE_COLOR[c.tone] ? c.tone : 'info';
    return { id: String(c.id != null ? c.id : c.text), text: String(c.text).toUpperCase(), tone: tone, color: TONE_COLOR[tone] };
  }
  /** Renderer camera mode -> 'interior' (cockpit / hood / bumper), 'chase' (chase / chase-far / drift cam) or 'other'. */
  function cameraView(m) {
    var s = String(m || '').toLowerCase();
    if (!s) return 'other';
    if (/cockpit|interior|first|fpv?$|driver|hood|bonnet|bumper|nose/.test(s)) return 'interior';
    if (/chase|follow|drift|third/.test(s)) return 'chase';
    return 'other';
  }
  function safeCall(o, fn) { try { return o[fn](); } catch (e) { return null; } }
  /** Short colour key for the zone strip, one entry per distinct colour actually on the track. */
  var ZONE_SHORT = { inner: 'CLIP', clip: 'CLIP', point: 'CLIP', outer: 'OUTER', wall: 'WALL', zone: 'ZONE', swing: 'SWING' };
  function zoneLegend(zones) {
    var out = [], byCol = {};
    if (!Array.isArray(zones)) return out;
    for (var i = 0; i < zones.length; i++) {
      var z = zones[i]; if (!z) continue;
      var kd = zoneKind(z), col = z.color || ZONE_KIND[kd].color, lab = ZONE_SHORT[kd] || 'ZONE';
      var e = byCol[col];
      if (!e) { e = byCol[col] = { color: col, labels: [] }; out.push(e); }
      if (e.labels.indexOf(lab) < 0) e.labels.push(lab);
    }
    var order = { OUTER: 0, CLIP: 1, ZONE: 2, SWING: 3, WALL: 4 };
    return out.map(function (e) { return { color: e.color, label: e.labels.join('/') }; })
      .sort(function (a, b) { var ka = a.label.split('/')[0], kb = b.label.split('/')[0]; return (ka in order ? order[ka] : 9) - (kb in order ? order[kb] : 9); });
  }
  /** HUD-side angle hints (texts match scoring.js coachHint) so the strip never contradicts the meter. */
  var ANGLE_HINT = {
    sweet: { id: 'sweet', text: 'SWEET SPOT \u2014 HOLD IT!', tone: 'good' },
    'more-angle': { id: 'more-angle', text: 'MORE ANGLE \u2014 HOLD THE ARROW + \u2191', tone: 'info' },
    'too-much': { id: 'too-much', text: 'TOO MUCH ANGLE \u2014 EASE OFF \u2193', tone: 'warn' }
  };
  /** Does angle hint `id` still describe |angle| a (deg, as shown on the meter)? margin widens the band (drop hysteresis). */
  function angleHintValid(id, a, drifting, saving, margin) {
    var m = margin || 0;
    if (!drifting || !isNum(a)) return false;
    if (id === 'sweet') return !saving && a >= 30 - m && a <= 50 + m;
    if (id === 'more-angle') return a < 30 + m;
    if (id === 'too-much') return a > 50 - m;
    return true;
  }
  /** Angle hint matching the meter band: <30 more angle, 30-50 sweet spot, >58 too much (50-58: none). */
  function angleHintFor(a, saving) {
    if (!isNum(a)) return null;
    if (a < 30) return ANGLE_HINT['more-angle'];
    if (a <= 50) return saving ? null : ANGLE_HINT.sweet;
    if (a > 58) return ANGLE_HINT['too-much'];
    return null;
  }
  /** Replace a stale / missing scorer angle hint with the one that matches the meter right now. */
  function reconcileAngleHint(c, a, drifting, saving) {
    if (!drifting) return c && ANGLE_HINT[c.id] ? null : c;
    if (c && !ANGLE_HINT[c.id]) return c;                       // zone / spin / wrong-way etc. win
    if (c && angleHintValid(c.id, a, drifting, saving, 0)) return c;
    return coachInfo(angleHintFor(a, saving));
  }
  /** Pre-drift tips ("tap an arrow to kick it sideways", "hold Up for speed", "chain it"): stale once a drift runs. */
  var PRE_DRIFT_HINT = { start: 1, speed: 1, chain: 1 };
  function staleWhileDrifting(c, drifting) { return !!(drifting && c && PRE_DRIFT_HINT[c.id]); }
  /** Critically damped spring step: {x, v} toward target (no overshoot, no twitch). */
  function spring(sp, target, dt, omega) {
    if (!sp || !isNum(sp.x)) return { x: isNum(target) ? target : 0, v: 0 };
    if (!isNum(target) || !(dt > 0)) return sp;
    var w = omega || 12, x = sp.x - target, v = isNum(sp.v) ? sp.v : 0;
    var e = Math.exp(-w * dt);
    var nx = (x + (v + w * x) * dt) * e;
    var nv = (v - w * (v + w * x) * dt) * e;
    return { x: target + nx, v: nv };
  }
  /** Current-drift point milestones that bump the counter. */
  var MILESTONES = [1000, 2500, 5000, 10000, 25000, 50000, 100000];
  function milestoneCrossed(prev, cur) {
    for (var i = MILESTONES.length - 1; i >= 0; i--) if (prev < MILESTONES[i] && cur >= MILESTONES[i]) return MILESTONES[i];
    return 0;
  }
  /** Signed display angle (deg) combining scorer |angle|, assist β and car kinematics. */
  function signedAngle(st, car, as) {
    var carA = carDriftAngle(car);
    var mag = st && isNum(st.angle_deg) ? Math.abs(st.angle_deg) : first(st && st.angle, null);
    if (!isNum(mag)) mag = Math.abs(as && isNum(as.beta) ? as.beta : carA);
    mag = Math.abs(mag);
    var sign = 0;
    if (as && isNum(as.beta) && Math.abs(as.beta) > 0.5) sign = as.beta < 0 ? -1 : 1;
    else if (st && isNum(st.beta_deg) && Math.abs(st.beta_deg) > 0.5) sign = st.beta_deg < 0 ? -1 : 1;
    else if (st && isNum(st.angle_deg) && st.angle_deg < 0) sign = -1;
    else if (Math.abs(carA) > 0.5) sign = carA < 0 ? -1 : 1;
    else if (st && isNum(st.dir)) sign = st.dir < 0 ? -1 : 1;
    else sign = 1;
    return mag * sign;
  }
  /** Angle band for the meter: 'idle' (<15), 'low', 'sweet' (30-50), 'high', 'over' (>70). */
  function angleBand(a) {
    a = Math.abs(a);
    return a < 15 ? 'idle' : a < 30 ? 'low' : a <= 50 ? 'sweet' : a <= 70 ? 'high' : 'over';
  }
  var BAND_COLOR = { idle: 'rgba(245,246,248,0.45)', low: PAL.yellow, sweet: PAL.green, high: PAL.amber, over: PAL.red };

  /** Exponential count-up toward target with a minimum rate; snaps down on resets. */
  function approach(display, target, dt, rate) {
    if (!isNum(display)) return target;
    if (!isNum(target)) return display;
    if (target < display) return target;
    var d = target - display;
    if (d < 0.5) return target;
    var k = 1 - Math.exp(-dt * (rate || 7));
    var step = Math.max(d * k, Math.min(d, dt * 60 + d * 0.02));
    return Math.min(target, display + step);
  }

  function findPlayer(snap) {
    if (!snap || !Array.isArray(snap.cars)) return null;
    for (var i = 0; i < snap.cars.length; i++) {
      var c = snap.cars[i];
      if (c && (c.isPlayer || (snap.playerId != null && c.id === snap.playerId))) return c;
    }
    return snap.cars[0] || null;
  }

  /** Tandem info from scorer state or derived from the snapshot (nearest non-player car). */
  function tandemInfo(st, snap, player, leadId) {
    var t = st && st.tandem;
    var out = null;
    if (t && typeof t === 'object') {
      out = {
        dist: first(t.distance_m, t.distance, t.gap_m, t.gap, t.dist),
        bonus: first(t.points, t.bonus, t.score),
        angleMatch: first(t.angleMatch, t.match, t.sync),
        leadName: t.leadName || t.name || null,
        ahead: t.ahead != null ? !!t.ahead : null
      };
    } else if (isNum(t)) out = { dist: t };
    var sd = snap && snap.drift && snap.drift.tandem;
    if (sd && typeof sd === 'object' && (!out || !isNum(out.dist))) {
      var dd = first(sd.dist_m, sd.gap_m, sd.distance_m);
      // session: gap_m = lead.s - player.s (>0 lead ahead), ahead = PLAYER ahead of the lead; out.ahead = LEAD ahead
      var leadAhead = isNum(sd.gap_m) ? sd.gap_m >= 0 : sd.ahead != null ? !sd.ahead : (out && out.ahead != null ? out.ahead : null);
      if (isNum(dd)) out = Object.assign(out || {}, { dist: dd, ahead: leadAhead });
      if (sd.leadId != null && leadId == null) leadId = sd.leadId;
    }
    if ((!out || !isNum(out.dist)) && st && isNum(st.tandemDist_m)) out = Object.assign(out || {}, { dist: st.tandemDist_m });
    if ((!out || !isNum(out.dist)) && snap && Array.isArray(snap.cars) && player) {
      var lead = null, bd = Infinity;
      for (var i = 0; i < snap.cars.length; i++) {
        var c = snap.cars[i];
        if (!c || c === player || c.isPlayer) continue;
        if (leadId != null && c.id !== leadId) continue;
        if (!isNum(c.x) || !isNum(c.y) || !isNum(player.x)) continue;
        var d = Math.hypot(c.x - player.x, c.y - player.y);
        if (d < bd) { bd = d; lead = c; }
      }
      if (lead) {
        out = out || {};
        out.dist = bd;
        out.leadName = out.leadName || lead.name || 'LEAD';
        if (isNum(lead.raceDist) && isNum(player.raceDist)) out.ahead = lead.raceDist >= player.raceDist;
      }
    }
    if (!out || !isNum(out.dist)) return null;
    out.band = out.ahead === false && out.dist < 25 ? 'ahead' : out.dist < 4 ? 'door' : out.dist < 8 ? 'close' : out.dist < 15 ? 'chase' : 'lost';
    return out;
  }
  var TANDEM_BAND = {
    door: { label: 'DOOR TO DOOR', color: PAL.hot },
    close: { label: 'CLOSE', color: PAL.green },
    chase: { label: 'CHASING', color: PAL.yellow },
    lost: { label: 'TOO FAR', color: PAL.red },
    ahead: { label: 'PASSED LEAD', color: PAL.amber }
  };

  /** Run timer -> {t, remaining:bool, urgent:bool} */
  function timerInfo(st, snap, opts) {
    st = st || {};
    var d = snap && snap.drift && typeof snap.drift === 'object' ? snap.drift : {};
    // the drift session's own clock (snap.drift) is authoritative: it excludes the countdown hold
    var left = first(d.timeLeft_s, st.timeLeft_s, st.timeLeft, st.remaining_s, st.remaining, st.timeRemaining);
    var dur = first(d.timeLeft_s != null ? d.duration_s : null, st.duration_s, st.duration, opts && opts.duration_s, d.duration_s > 0 ? d.duration_s : null);
    var el = first(d.elapsed_s, st.elapsed_s, st.elapsed, st.time, st.t, snap && snap.raceTime, snap && snap.t);
    if (!isNum(left) && isNum(dur) && isNum(el)) left = Math.max(0, dur - el);
    if (isNum(left)) return { t: Math.max(0, left), remaining: true, urgent: left <= 10, frac: isNum(dur) && dur > 0 ? clamp01(left / dur) : null };
    return { t: isNum(el) ? el : null, remaining: false, urgent: false, frac: null };
  }

  /** Stable identity key for a scorer event (id/seq/t when present, else text+points). */
  function eventKey(ev) {
    if (!ev) return '';
    var id = ev.id != null ? 'i' + ev.id : ev.seq != null ? 's' + ev.seq : isNum(ev.t) ? 't' + ev.t : isNum(ev.time) ? 't' + ev.time : '';
    return id + '|' + (ev.text || ev.label || '') + '|' + (isNum(ev.points) ? Math.round(ev.points) : '');
  }

  /**
   * Pure pinhole projection of a sim-space point through a camera state
   * { eye:[x,y,z], target, up, fov (vertical deg) } in GL axes (sim (x, y, h) -> GL (x, h, -y)).
   * -> {x, y, depth, scale, visible} in CSS px of a W x H viewport, or null when behind the camera.
   */
  function projectThrough(cam, W, H, x, y, h) {
    if (!cam || !cam.eye || !cam.target) return null;
    var e = cam.eye, tg = cam.target, up = cam.up || [0, 1, 0];
    var fx = tg[0] - e[0], fy = tg[1] - e[1], fz = tg[2] - e[2];
    var fl = Math.hypot(fx, fy, fz); if (!(fl > 1e-9)) return null;
    fx /= fl; fy /= fl; fz /= fl;
    // right = f x up, u = right x f
    var rx = fy * up[2] - fz * up[1], ry = fz * up[0] - fx * up[2], rz = fx * up[1] - fy * up[0];
    var rl = Math.hypot(rx, ry, rz); if (!(rl > 1e-9)) return null;
    rx /= rl; ry /= rl; rz /= rl;
    var ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
    var px = x - e[0], py = (h || 0) - e[1], pz = -y - e[2];
    var depth = px * fx + py * fy + pz * fz;
    if (!(depth > num(cam.near, 0.1))) return null;
    var th = Math.tan(num(cam.fov, 60) * Math.PI / 360), aspect = W / Math.max(1, H);
    var nx = (px * rx + py * ry + pz * rz) / (depth * th * aspect);
    var ny = (px * ux + py * uy + pz * uz) / (depth * th);
    return { x: (nx + 1) * 0.5 * W, y: (1 - ny) * 0.5 * H, depth: depth, scale: clamp(22 / depth, 0.35, 1.8),
      visible: Math.abs(nx) < 1.15 && Math.abs(ny) < 1.15 && depth < 420 };
  }
  /** worldToScreen(x, y, z) built from a CB.race.renderer3d instance (getCameraState + ground height when reachable). */
  function rendererProjector(renderer, canvas) {
    if (!renderer || typeof renderer.getCameraState !== 'function') return null;
    var hCache = {};
    function ground(x, y) {
      var key = Math.round(x * 2) + ',' + Math.round(y * 2);
      if (key in hCache) return hCache[key];
      var h = 0;
      try {
        var D = typeof renderer._debug === 'function' ? renderer._debug() : null;
        var gy = D && D.S && D.S.world && D.S.world.groundY;
        if (typeof gy === 'function') h = num(gy(x, -y), 0);
      } catch (e) { h = 0; }
      hCache[key] = h;
      return h;
    }
    return function (x, y, z) {
      var cam = renderer.getCameraState();
      var W = (canvas && (canvas.clientWidth || canvas.width)) || 1280, H = (canvas && (canvas.clientHeight || canvas.height)) || 720;
      return projectThrough(cam, W, H, x, y, (isNum(z) && z !== 0 ? z : ground(x, y)) + 0.3);
    };
  }

  /* ------------------------------------------------------------ drawing */

  function txt(ctx, s, x, y, font, color, align, base) {
    ctx.font = font; ctx.fillStyle = color;
    ctx.textAlign = align || 'left'; ctx.textBaseline = base || 'alphabetic';
    ctx.fillText(s, x, y);
  }
  function tracked(ctx, s, x, y, font, color, align, spacing) {
    // letter-spaced small caps label
    ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    var chars = String(s).split(''), w = 0, i;
    for (i = 0; i < chars.length; i++) w += ctx.measureText(chars[i]).width + (i < chars.length - 1 ? spacing : 0);
    var sx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    for (i = 0; i < chars.length; i++) { ctx.fillText(chars[i], sx, y); sx += ctx.measureText(chars[i]).width + spacing; }
    return w;
  }
  /** Slanted (parallelogram) panel path; sl = horizontal slant in px. */
  function slant(ctx, x, y, w, h, sl) {
    ctx.beginPath();
    ctx.moveTo(x + sl, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w - sl, y + h); ctx.lineTo(x, y + h);
    ctx.closePath();
  }
  function slantPanel(ctx, x, y, w, h, sl, fill, edge, glow) {
    ctx.save();
    if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = 18; }
    slant(ctx, x, y, w, h, sl); ctx.fillStyle = fill || PAL.panel; ctx.fill();
    ctx.shadowBlur = 0;
    if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.restore();
  }
  function bar(ctx, x, y, w, h, frac, color, back, sl) {
    sl = sl || 0;
    slant(ctx, x, y, w, h, sl); ctx.fillStyle = back || 'rgba(255,255,255,0.10)'; ctx.fill();
    var f = clamp01(frac);
    if (f > 0) { slant(ctx, x, y, Math.max(sl + 1, w * f), h, sl); ctx.fillStyle = color; ctx.fill(); }
  }
  function chevron(ctx, x, y, s, dir, color, alpha) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.beginPath();
    ctx.moveTo(x - dir * s * 0.45, y - s);
    ctx.lineTo(x + dir * s * 0.45, y);
    ctx.lineTo(x - dir * s * 0.45, y + s);
    ctx.lineTo(x - dir * s * 0.05, y + s);
    ctx.lineTo(x + dir * s * 0.85 - dir * s * 0.4, y);
    ctx.lineTo(x - dir * s * 0.05, y - s);
    ctx.closePath();
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 12;
    ctx.fill();
    ctx.restore();
  }

  /* ============================================================== create */

  function create(canvas, opts) {
    opts = Object.assign({}, opts || {});
    var units = opts.units === 'mph' ? 'mph' : 'kph';
    var projector = typeof opts.worldToScreen === 'function' ? opts.worldToScreen : rendererProjector(opts.renderer, canvas);
    var clock = typeof opts.now === 'function' ? opts.now : sysNow;
    var destroyed = false;
    var camSource = null;   // renderer (getCamera()) used to adapt the meter panel to cockpit / hood / chase views
    var camMode = null;     // explicit camera mode from setCameraMode() (wins over the renderer / snapshot)
    var S;
    function fresh() {
      S = {
        last: null, t: 0, dt: 0,
        dispTotal: 0, dispCurrent: 0, dispMult: 1, angDisp: 0, angTrail: 0,
        prevTotal: null, prevCurrent: 0, prevMult: 1, prevGrade: null, prevMedal: undefined,
        totalPulse: -9, gradePulse: -9, multPulse: -9, badFlash: -9, medalFlash: -9, maxFlash: -9,
        lastDriftT: -9, lastPopupT: -9,
        pops: [], seen: {}, seenOrder: [], lastEvKey: null,
        zoneHit: {}, zoneFlash: -9, lastZoneId: null,
        medalBanner: null, errLogged: false,
        angSp: null, dispDrifting: false, driftOffT: 0, graceT: 0, driftT: 0,
        msPulse: -9, msVal: 0, chargePulse: -9, prevProg: 0,
        coach: null, coachCandKey: undefined, coachCandT: 0, coachShownT: -9, coachOutT: -9, coachPrev: null,
        heat: 0, lockT: 0, health: 1
      };
    }
    fresh();

    /* ------------------------------------------------------- popups */
    function pushPopup(text, points, o) {
      o = o || {};
      var cls = classifyEvent(text, points);
      if (o.kind) { cls.kind = o.kind; cls.big = o.kind === 'bank'; }
      if (o.kind && o.kind !== cls.kind) { var c2 = classifyEvent('', points, o.kind); if (c2.kind === o.kind) cls = c2; }
      var p = {
        t0: S.t, life: o.life || (cls.big ? 2.5 : 1.7), kind: cls.kind, big: cls.big || !!o.big,
        color: o.color || cls.color, text: String(text || '').toUpperCase(), points: isNum(points) ? points : null,
        mult: isNum(o.mult) ? o.mult : null, grade: o.grade || null, x: (Math.random() - 0.5) * 0.06
      };
      if (!p.big) {
        // the same small callout again within a second (e.g. repeated SWING! / WALL scrapes) stacks instead of spamming
        for (var j = S.pops.length - 1; j >= 0; j--) {
          var q = S.pops[j];
          if (!q.big && q.text === p.text && S.t - q.t0 < Math.min(1.0, q.life - 0.3)) {
            q.count = (q.count || 1) + 1;
            if (p.points != null) q.points = (q.points || 0) + p.points;
            q.t0 = S.t - 0.12; q.bump = S.t;
            S.lastPopupT = S.t;
            if (cls.bad) S.badFlash = S.t;
            return q;
          }
        }
      }
      if (p.big) {
        // a bank replaces an older big popup so the centre never stacks two grades
        for (var i = 0; i < S.pops.length; i++) if (S.pops[i].big && S.t - S.pops[i].t0 < S.pops[i].life) S.pops[i].life = Math.min(S.pops[i].life, S.t - S.pops[i].t0 + 0.18);
      }
      S.pops.push(p);
      if (S.pops.length > 12) S.pops.shift();
      S.lastPopupT = S.t;
      if (cls.bad) S.badFlash = S.t;
      if (cls.kind === 'zone') S.zoneFlash = S.t;
      return p;
    }
    function remember(key) {
      if (S.seen[key]) return false;
      S.seen[key] = 1; S.seenOrder.push(key);
      if (S.seenOrder.length > 256) delete S.seen[S.seenOrder.shift()];
      return true;
    }
    function eventPopup(ev, st) {
      var text = ev.text || ev.label || ev.name || '';
      if (!text && !isNum(ev.points)) return;
      var cls = classifyEvent(text, ev.points, ev.kind);
      if (cls.kind === 'bank') {
        var g = gradeInfo(ev.grade || st.grade);
        var mm = /[\u00d7x]\s*(\d+(?:\.\d+)?)\s*$/.exec(text);
        var label = String(text).replace(/^\s*\+?[\d,.]+\s*/, '').replace(/\s*[\u00d7x]\s*\d+(?:\.\d+)?\s*$/, '');
        if (mm && !isNum(ev.multiplier)) ev = Object.assign({}, ev, { multiplier: parseFloat(mm[1]) });
        if (!/drift/i.test(label) && g) label = g.label + ' DRIFT';
        pushPopup(label, ev.points, { kind: 'bank', mult: first(ev.multiplier, ev.mult, S.prevMult), grade: g, color: g ? g.color : null });
      } else {
        pushPopup(text, ev.points, { kind: cls.kind });
      }
    }

    /* ------------------------------------------------ state processing */
    function process(st, snap, player) {
      var total = num(st.total, num(st.score, 0));
      var current = num(st.current, num(st.chainPoints, num(st.currentPoints, 0)));
      var mult = num(st.multiplier, num(st.mult, 1));
      var g = gradeInfo(st.grade);
      var created = S.pops.length;

      // reset (restart) -> clear everything instantly
      if (S.prevTotal !== null && total < S.prevTotal - 0.5) {
        S.dispTotal = total; S.pops = []; S.zoneHit = {}; S.prevMedal = null;
      }

      // explicit events
      var lists = [st.events, st.popups];
      for (var li = 0; li < lists.length; li++) {
        if (!Array.isArray(lists[li])) continue;
        for (var i = 0; i < lists[li].length; i++) {
          var ev = lists[li][i];
          if (ev && typeof ev === 'object' && remember('a' + eventKey(ev))) eventPopup(ev, st);
        }
      }
      if (st.lastEvent && typeof st.lastEvent === 'object') {
        var key = eventKey(st.lastEvent);
        if (key !== S.lastEvKey) {
          S.lastEvKey = key;
          if (remember('a' + key) || !/^[ist]/.test(key)) eventPopup(st.lastEvent, st);
        }
      }
      var newPops = S.pops.length > created;

      // synthesize popups the scorer did not announce
      if (S.prevTotal !== null && total > S.prevTotal + 0.5 && !newPops && S.t - S.lastPopupT > 0.3) {
        var gg = g || S.prevGrade;
        pushPopup(gg ? gg.label + ' DRIFT' : 'DRIFT', total - S.prevTotal, { kind: 'bank', mult: S.prevMult, grade: gg, color: gg ? gg.color : null });
      } else if (S.prevTotal !== null && S.prevCurrent > 50 && current <= 0 && total <= S.prevTotal + 0.5 && !newPops && S.t - S.lastPopupT > 0.3) {
        pushPopup('COMBO LOST', null, { kind: 'bad' });
      }

      // zones newly hit (scorer usually also emits an event; this only flashes the ribbon)
      if (Array.isArray(st.zones)) {
        for (var z = 0; z < st.zones.length; z++) {
          var zz = st.zones[z]; if (!zz) continue;
          var zid = zz.id != null ? zz.id : 'z' + z;
          if (zz.hit && !S.zoneHit[zid]) { S.zoneHit[zid] = S.t; S.zoneFlash = S.t; }
          else if (!zz.hit && S.zoneHit[zid]) delete S.zoneHit[zid];
        }
      }

      // pulses
      if (S.prevTotal !== null && total > S.prevTotal + 0.5) S.totalPulse = S.t;
      if (g && (!S.prevGrade || g.rank > S.prevGrade.rank) && current > 0) S.gradePulse = S.t;
      if (Math.floor(mult + 1e-6) > Math.floor(S.prevMult + 1e-6)) S.multPulse = S.t;
      var cmax = num(st.maxMultiplier, num(opts.comboMax, 5));
      if (mult >= cmax - 1e-6 && S.prevMult < cmax - 1e-6) {
        S.maxFlash = S.t;
        var announced = false;
        for (var pi = 0; pi < S.pops.length; pi++) if (/max\s*combo/i.test(S.pops[pi].text) && S.t - S.pops[pi].t0 < 1.5) announced = true;
        if (!announced) pushPopup('MAX COMBO', null, { kind: 'bonus', color: PAL.hot });
      }

      var drifting = st.drifting != null ? !!st.drifting : (current > 0 && Math.abs(num(st.angle_deg, 0)) >= 12);
      if (drifting) S.lastDriftT = S.t;
      // display hysteresis: labels / glow switch on instantly but only drop after 0.3 s, so a wobble never flickers the HUD
      if (drifting) { S.dispDrifting = true; S.driftOffT = 0; }
      else if (S.dispDrifting) { S.driftOffT += S.dt; if (S.driftOffT > 0.3) S.dispDrifting = false; }
      // grace: still in the drift but the angle has collapsed -> "SAVE IT" warning
      var absA = Math.abs(num(st.angle_deg, 0));
      if (isNum(st.driftHealth)) {
        // scorer-provided fuse (1 = solid, -> 0 as the grace timer runs out)
        S.health = drifting ? clamp01(st.driftHealth) : 1;
        if (drifting && st.driftHealth < 0.97) S.graceT += S.dt; else S.graceT = 0;
      } else {
        if (drifting && absA < 12) S.graceT += S.dt; else S.graceT = 0;
        S.health = S.graceT > 0 ? clamp01(1 - S.graceT / num(st.grace_s, 0.85)) : 1;
      }
      S.driftT = drifting ? num(st.driftTime_s, S.driftT + S.dt) : 0;
      // milestone bumps on the live drift counter
      var ms = milestoneCrossed(S.prevCurrent, current);
      if (ms && drifting) { S.msPulse = S.t; S.msVal = ms; }
      // multiplier charge (progress to the next +0.1)
      var prog = isNum(st.multiplierProgress) ? clamp01(st.multiplierProgress) : null;
      if (prog !== null && prog < S.prevProg - 0.5 && drifting) S.chargePulse = S.t;
      S.prevProg = prog !== null ? prog : 0;
      // heat: builds while sliding (more with multiplier / sweet spot), cools quickly after
      var sweet = absA >= 30 && absA <= 50;
      var heatT = drifting ? clamp01(0.35 + 0.1 * (mult - 1) + (sweet ? 0.25 : 0)) : 0;
      S.heat = lerp(S.heat, heatT, clamp01(S.dt * (heatT > S.heat ? 2.2 : 4)));

      S.prevTotal = total; S.prevCurrent = current; S.prevMult = mult;
      if (g) S.prevGrade = current > 0 || !S.prevGrade ? g : S.prevGrade;
      if (current <= 0 && !drifting) S.prevGrade = g;
      return { total: total, current: current, mult: mult, grade: g, drifting: drifting, cmax: cmax, prog: prog,
        vis: S.dispDrifting, rate: first(st.rate, st.pointsPerSec, st.rate_ps), wall: first(st.wallClose, null) };
    }

    /**
     * Coach hint debounce: a new hint must be stable for 0.35 s (bad tone: instant) and stays at least 1.6 s.
     * Angle hints (sweet / more-angle / too-much) are reconciled with the angle the meter actually shows
     * (absA = |needle|): one that no longer matches is dropped at once (minShown ignored), a mismatching
     * scorer hint is replaced by the right one, and the scorer's silent ranges (25-30 deg) are filled.
     */
    function updateCoach(c, absA, drifting, saving) {
      if (staleWhileDrifting(c, drifting)) c = null;
      c = reconcileAngleHint(c, absA, drifting, saving);
      // a pre-drift tip still on screen goes the moment the slide starts (no 1.6 s minimum)
      if (staleWhileDrifting(S.coach, drifting)) { S.coachPrev = S.coach; S.coachOutT = S.t; S.coach = null; }
      var curId = S.coach ? S.coach.id : null, candId = c ? c.id : null;
      if (S.coach && ANGLE_HINT[curId] && !angleHintValid(curId, absA, drifting, saving, 1)) {
        S.coachPrev = S.coach; S.coachOutT = S.t; S.coach = null; curId = null;
      }
      if (candId === curId) { S.coachCandKey = undefined; if (c) S.coach = c; return; }
      var minShown = S.coach && S.t - S.coachShownT < 1.6;
      if (S.coachCandKey === candId) S.coachCandT += S.dt;
      else { S.coachCandKey = candId; S.coachCandT = 0; }
      var urgent = c && c.tone === 'bad';
      if (urgent || (!minShown && S.coachCandT >= (c ? 0.35 : 0.6))) {
        if (S.coach) { S.coachPrev = S.coach; S.coachOutT = S.t; }
        S.coach = c; S.coachShownT = S.t; S.coachCandKey = undefined;
      }
    }

    /* ======================================================== draw parts */

    function drawScoreBanner(ctx, W, top, k, compact, st, info, timer, ladder) {
      var t = S.t;
      var cw = (compact ? 210 : 300) * k, ch = (compact ? 52 : 70) * k;
      var cx = W / 2, x = cx - cw / 2, y = top;
      var sl = 14 * k;
      // centre: score
      var pulse = clamp01(1 - (t - S.totalPulse) / 0.45);
      slantPanel(ctx, x, y, cw, ch, sl, PAL.panel, PAL.edge, pulse > 0 ? rgba(PAL.gold, 0.6 * pulse) : null);
      // accent stripe
      slant(ctx, x + sl * 0.2, y + ch - 3 * k, cw - sl * 0.4, 3 * k, sl * 0.2);
      ctx.fillStyle = PAL.accent; ctx.fill();
      if (compact) tracked(ctx, 'SCORE', x + sl + 4 * k, y + 13 * k, '700 ' + (9 * k) + 'px ' + FONT_UI, PAL.inkDim, 'left', 1.6 * k);
      else tracked(ctx, 'DRIFT SCORE', cx, y + 15 * k, '700 ' + (10 * k) + 'px ' + FONT_UI, PAL.inkDim, 'center', 2.4 * k);
      var sc = 1 + 0.12 * easeOutCubic(pulse) * pulse;
      ctx.save();
      ctx.translate(cx, y + ch * 0.74); ctx.scale(sc, sc); ctx.transform(1, 0, -0.12, 1, 0, 0);
      ctx.shadowColor = pulse > 0 ? rgba(PAL.gold, 0.9) : 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 10 * k;
      txt(ctx, fmtInt(S.dispTotal), 0, 0, '800 ' + ((compact ? 30 : 42) * k) + 'px ' + FONT_NUM, pulse > 0.05 ? lerp01Color(pulse) : PAL.ink, 'center', 'alphabetic');
      ctx.restore();

      var bottom = y + ch;
      if (!compact) {
        // left wing: timer
        var ww = 112 * k, wh = 46 * k, wy = y + 8 * k;
        var lx = x - ww + sl * 0.4;
        var urgent = timer.urgent && timer.remaining;
        var blink = urgent && Math.floor(t * 4) % 2 === 0;
        slantPanel(ctx, lx, wy, ww, wh, sl, urgent ? 'rgba(60,8,14,0.85)' : PAL.panelSoft, urgent ? rgba(PAL.red, 0.7) : PAL.edge);
        tracked(ctx, timer.remaining ? 'TIME LEFT' : 'RUN TIME', lx + ww / 2 + 2 * k, wy + 14 * k, '700 ' + (9 * k) + 'px ' + FONT_UI, PAL.inkDim, 'center', 1.8 * k);
        txt(ctx, fmtClock(timer.t), lx + ww / 2, wy + 37 * k, '700 ' + (21 * k) + 'px ' + FONT_NUM, blink ? PAL.red : urgent ? '#ff8a96' : PAL.ink, 'center');
        if (isNum(timer.frac)) bar(ctx, lx + sl * 0.5, wy + wh - 4 * k, ww - sl * 1.4, 2 * k, timer.frac, urgent ? PAL.red : PAL.inkDim, 'rgba(255,255,255,0.08)');
        // right wing: zones
        var rx = x + cw - sl * 0.4;
        var zs = Array.isArray(st.zones) ? st.zones : null;
        slantPanel(ctx, rx, wy, ww, wh, sl, PAL.panelSoft, PAL.edge);
        tracked(ctx, 'ZONES', rx + ww / 2 - 2 * k, wy + 14 * k, '700 ' + (9 * k) + 'px ' + FONT_UI, PAL.inkDim, 'center', 1.8 * k);
        var zf = clamp01(1 - (t - S.zoneFlash) / 0.6);
        if (zs && zs.length) {
          var hit = 0; for (var i = 0; i < zs.length; i++) if (zs[i] && zs[i].hit) hit++;
          txt(ctx, hit + '/' + zs.length, rx + ww / 2 - 2 * k, wy + 37 * k, '700 ' + (21 * k) + 'px ' + FONT_NUM, zf > 0 ? PAL.cyan : PAL.ink, 'center');
          bar(ctx, rx + sl * 0.5, wy + wh - 4 * k, ww - sl * 1.4, 2 * k, hit / zs.length, PAL.cyan, 'rgba(255,255,255,0.08)');
        } else {
          var hp = first(st.zonesHitPct, st.zonesHit_pct);
          txt(ctx, isNum(hp) ? Math.round(hp) + '%' : '\u2014', rx + ww / 2 - 2 * k, wy + 37 * k, '700 ' + (21 * k) + 'px ' + FONT_NUM, PAL.ink, 'center');
        }
      } else {
        // compact: timer under the score
        var tc = (timer.remaining ? '' : '') + fmtClock(timer.t);
        txt(ctx, tc, x + cw - 6 * k, y + 13 * k, '700 ' + (10 * k) + 'px ' + FONT_NUM, timer.urgent ? PAL.red : PAL.inkDim, 'right');
      }

      // medal ladder
      if (ladder.length) {
        var lw = (compact ? 210 : 400) * k, lh = 6 * k;
        var lxx = cx - lw / 2, ly = bottom + (compact ? 9 : 22) * k;
        var top_ = ladder[ladder.length - 1].score * 1.08;
        var total = S.dispTotal, proj = total + num(info.current, 0);
        slantPanel(ctx, lxx - 12 * k, ly - (compact ? 5 : 18) * k, lw + 24 * k, (compact ? 18 : 38) * k, 6 * k, PAL.panelSoft, null);
        // projected (current drift) ghost, then banked fill
        bar(ctx, lxx, ly, lw, lh, proj / top_, rgba(PAL.gold, 0.32), 'rgba(255,255,255,0.08)', 2 * k);
        var mp = medalProgress(total, ladder);
        bar(ctx, lxx, ly, lw, lh, total / top_, mp.current ? mp.current.color : PAL.ink, 'rgba(0,0,0,0)', 2 * k);
        for (var m = 0; m < ladder.length; m++) {
          var md = ladder[m], mx = lxx + lw * clamp01(md.score / top_);
          var got = total >= md.score;
          ctx.save();
          ctx.translate(mx, ly + lh / 2);
          var fl = mp.current === md ? clamp01(1 - (t - S.medalFlash) / 0.9) : 0;
          var r = (4.5 + 3 * easeOutElastic(1 - fl) * fl) * k;
          ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath();
          ctx.fillStyle = got ? md.color : 'rgba(20,22,28,0.95)'; ctx.fill();
          ctx.strokeStyle = md.color; ctx.lineWidth = 1.4 * k; ctx.stroke();
          ctx.restore();
          if (!compact) txt(ctx, fmtShort(md.score), mx, ly - 7 * k, '700 ' + (9 * k) + 'px ' + FONT_NUM, got ? md.color : PAL.inkFaint, 'center');
        }
        bottom = ly + (compact ? 14 : 22) * k;
        if (!compact) {
          var nt = mp.next ? mp.next.label + ' IN ' + fmtInt(mp.toNext) : 'PLATINUM SECURED';
          txt(ctx, nt, cx, ly + lh + 13 * k, '800 ' + (9.5 * k) + 'px ' + FONT_UI, mp.next ? mp.next.color : MEDALS.platinum.color, 'center');
        }
        // medal reached flash/popup
        var cm = mp.current ? mp.current.medal : null;
        if (cm && cm !== S.prevMedal && S.prevMedal !== undefined) {
          if (MEDALS[cm] && (!S.prevMedal || (MEDALS[S.prevMedal] && MEDALS[cm].rank > MEDALS[S.prevMedal].rank))) {
            S.medalFlash = t; pushPopup(MEDALS[cm].label + ' MEDAL', null, { kind: 'bonus', color: MEDALS[cm].color });
          }
        }
        S.prevMedal = cm;
      }
      return bottom;
    }
    function lerp01Color(p) { return p > 0.5 ? PAL.gold : '#fff2c4'; }

    function drawTandem(ctx, W, y, k, compact, td) {
      var w = (compact ? 210 : 320) * k, h = (compact ? 26 : 34) * k, x = W / 2 - w / 2, sl = 10 * k;
      var band = TANDEM_BAND[td.band];
      var hot = td.band === 'door';
      slantPanel(ctx, x, y, w, h, sl, PAL.panelSoft, rgba(band.color, 0.45), hot ? rgba(PAL.hot, 0.5 + 0.3 * Math.sin(S.t * 10)) : null);
      tracked(ctx, 'TANDEM', x + sl + 6 * k, y + h * 0.42, '800 ' + (9 * k) + 'px ' + FONT_UI, PAL.inkDim, 'left', 1.6 * k);
      txt(ctx, band.label, x + sl + 6 * k, y + h * 0.82, '800 ' + (10 * k) + 'px ' + FONT_UI, band.color, 'left');
      // gauge: 25 m (left) ... 0 m (right, lead car icon)
      var gx = x + (compact ? 78 : 96) * k, gw = w - (compact ? 78 : 96) * k - 78 * k, gy = y + h / 2 - 3 * k;
      var segs = [{ a: 0, b: 10 / 25, c: PAL.red }, { a: 10 / 25, b: 17 / 25, c: PAL.yellow }, { a: 17 / 25, b: 21 / 25, c: PAL.green }, { a: 21 / 25, b: 1, c: PAL.hot }];
      for (var i = 0; i < segs.length; i++) {
        ctx.fillStyle = rgba(segs[i].c, 0.28);
        ctx.fillRect(gx + gw * segs[i].a, gy, gw * (segs[i].b - segs[i].a) - 1, 6 * k);
      }
      var f = clamp01(1 - td.dist / 25);
      ctx.fillStyle = band.color; ctx.fillRect(gx, gy, gw * f, 6 * k);
      // lead car marker
      ctx.fillStyle = PAL.ink; ctx.beginPath();
      ctx.moveTo(gx + gw + 2 * k, gy - 4 * k); ctx.lineTo(gx + gw + 9 * k, gy + 3 * k); ctx.lineTo(gx + gw + 2 * k, gy + 10 * k); ctx.closePath(); ctx.fill();
      // chaser marker
      var px = gx + gw * f;
      ctx.fillStyle = band.color; ctx.beginPath();
      ctx.moveTo(px, gy - 5 * k); ctx.lineTo(px + 4 * k, gy + 3 * k); ctx.lineTo(px, gy + 11 * k); ctx.lineTo(px - 4 * k, gy + 3 * k); ctx.closePath(); ctx.fill();
      txt(ctx, td.dist.toFixed(1) + ' m', x + w - sl - 6 * k, y + h * 0.66, '700 ' + (13 * k) + 'px ' + FONT_NUM, PAL.ink, 'right');
      if (isNum(td.angleMatch)) bar(ctx, gx, gy + 9 * k, gw, 2 * k, td.angleMatch > 1 ? td.angleMatch / 100 : td.angleMatch, PAL.cyan);
      return y + h;
    }

    /**
     * Tandem: the lead car sits ~8 m ahead = screen centre, so callouts are anchored high and to the right,
     * at most 2 are visible (a grade popup counts as one) and they fade ~40 % sooner.
     */
    function drawPopups(ctx, W, H, baseY, k, compact, tandem) {
      var t = S.t, smallY = baseY, bigDrawn = false, nSmall = 0, maxSmall = compact ? 2 : 3;
      var lifeK = tandem ? 0.6 : 1, sideX = tandem && !compact ? W * 0.27 : 0;
      function lifeOf(p) { return Math.max(0.7, p.life * lifeK); }
      // small callouts sit right under the banner when no grade popup is up, and below it otherwise
      var bigUp = false;
      for (var bi = 0; bi < S.pops.length; bi++) if (S.pops[bi].big && t - S.pops[bi].t0 <= lifeOf(S.pops[bi])) bigUp = true;
      if (tandem) maxSmall = bigUp ? 1 : 2;
      var smallOff = bigUp ? (compact ? 52 : (tandem ? 96 : 128)) * k : (compact ? 14 : 30) * k;
      S.popsShown = 0;
      for (var i = S.pops.length - 1; i >= 0; i--) {
        var p = S.pops[i], age = t - p.t0, life = lifeOf(p);
        if (age > life) continue;
        var tin = clamp01(age / 0.28), tout = clamp01((age - (life - 0.45)) / 0.45);
        var a = clamp01(age / 0.08) * (1 - easeInCubic(tout));
        if (a <= 0.01) continue;
        ctx.save();
        ctx.globalAlpha = a;
        if (p.big && !bigDrawn) {
          bigDrawn = true; S.popsShown++;
          var s = lerp(0.45, 1, easeOutBack(tin));
          var fs = (compact ? 22 : tandem ? 34 : 46) * k;
          var cy = baseY + fs * (compact ? (p.grade ? 1.25 : 0.9) : (p.grade ? 1.55 : 0.95)) - easeInCubic(tout) * 26 * k;
          ctx.translate(W / 2 + sideX + p.x * W, cy); ctx.scale(s, s); ctx.transform(1, 0, -0.14, 1, 0, 0);
          var g = p.grade;
          // grade letter badge
          if (g) {
            var bw = fs * (g.code.length > 1 ? 1.25 : 0.95);
            ctx.save();
            ctx.translate(0, -fs * 0.98);
            slant(ctx, -bw / 2, -fs * 0.42, bw, fs * 0.62, fs * 0.12);
            ctx.fillStyle = g.color; ctx.shadowColor = g.color; ctx.shadowBlur = 16 * k; ctx.fill();
            ctx.shadowBlur = 0;
            txt(ctx, g.code, 0, fs * 0.08, '900 ' + (fs * 0.52) + 'px ' + FONT_UI, '#0b0c10', 'center', 'alphabetic');
            ctx.restore();
          }
          ctx.shadowColor = rgba(p.color, 0.9); ctx.shadowBlur = 22 * k;
          ctx.lineWidth = 5 * k; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineJoin = 'round';
          var main = p.points != null && Math.round(p.points) !== 0 ? '+' + fmtInt(p.points) : p.text;
          ctx.font = '900 ' + fs + 'px ' + FONT_UI; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
          ctx.strokeText(main, 0, 0);
          txt(ctx, main, 0, 0, '900 ' + fs + 'px ' + FONT_UI, p.color, 'center');
          ctx.shadowBlur = 0;
          var sub = (p.points != null && Math.round(p.points) !== 0 ? p.text : '') + (p.mult != null && p.mult > 1.0001 ? '  ' + fmtMult(p.mult) : '');
          if (sub) {
            ctx.font = '800 ' + (fs * 0.4) + 'px ' + FONT_UI; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4 * k;
            ctx.strokeText(sub, 0, fs * 0.48);
            txt(ctx, sub, 0, fs * 0.48, '800 ' + (fs * 0.4) + 'px ' + FONT_UI, PAL.ink, 'center');
          }
          // speed streaks
          var st = easeOutCubic(tin);
          ctx.strokeStyle = rgba(p.color, 0.55 * (1 - st)); ctx.lineWidth = 2 * k;
          for (var q = -2; q <= 2; q++) {
            ctx.beginPath(); ctx.moveTo(-fs * (2.2 + st), q * fs * 0.14 - fs * 0.3); ctx.lineTo(-fs * (1.4 + st * 2.5), q * fs * 0.14 - fs * 0.3); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(fs * (2.2 + st), q * fs * 0.14 - fs * 0.3); ctx.lineTo(fs * (1.4 + st * 2.5), q * fs * 0.14 - fs * 0.3); ctx.stroke();
          }
        } else if (!p.big) {
          if (nSmall >= maxSmall) { ctx.restore(); continue; }
          nSmall++; S.popsShown++;
          var ss = lerp(0.6, 1, easeOutBack(tin)) + (p.bump ? 0.18 * clamp01(1 - (t - p.bump) / 0.25) : 0);
          var yy = smallY + smallOff - easeOutCubic(tout) * 18 * k;
          smallY += (compact ? 16 : 27) * k;
          ctx.translate(W / 2 + sideX, yy); ctx.scale(ss, ss); ctx.transform(1, 0, -0.12, 1, 0, 0);
          var f2 = (compact ? 11 : 21) * k;
          var label = p.text + (p.count > 1 ? ' \u00d7' + p.count : '') + (p.points != null && Math.round(p.points) !== 0 && p.text.indexOf(fmtInt(Math.abs(p.points))) < 0 ? '  ' + (p.points >= 0 ? '+' : '') + fmtInt(p.points) : '');
          ctx.font = '900 ' + f2 + 'px ' + FONT_UI;
          var tw = ctx.measureText(label).width;
          slant(ctx, -tw / 2 - 14 * k, -f2 * 0.92, tw + 28 * k, f2 * 1.22, 8 * k);
          ctx.fillStyle = p.kind === 'bad' ? 'rgba(70,6,16,0.82)' : 'rgba(9,10,14,0.72)'; ctx.fill();
          slant(ctx, -tw / 2 - 14 * k, -f2 * 0.92, 4 * k, f2 * 1.22, 2 * k); ctx.fillStyle = p.color; ctx.fill();
          ctx.shadowColor = rgba(p.color, 0.8); ctx.shadowBlur = 10 * k;
          txt(ctx, label, 0, 0, '900 ' + f2 + 'px ' + FONT_UI, p.color, 'center');
        }
        ctx.restore();
      }
      // prune expired
      while (S.pops.length && t - S.pops[0].t0 > S.pops[0].life + 0.1) S.pops.shift();
    }

    function drawZoneArrows(ctx, W, H, k, compact, nz) {
      if (!nz) return;
      var z = nz.zone, kind = zoneKind(z), ki = ZONE_KIND[kind], side = zoneSide(z);
      var col = z.color || ki.color;
      var y = H * (compact ? 0.56 : 0.5);
      var x = side ? W / 2 + side * W * (compact ? 0.3 : 0.21) : W / 2;
      var t = S.t;
      if (nz.inZone) {
        var pr = clamp01(nz.progress);
        var pulse = 0.5 + 0.5 * Math.sin(t * 12);
        ctx.save();
        ctx.globalAlpha = z.hit ? 0.9 : 0.75 + 0.25 * pulse;
        var bw = 150 * k, bh = 40 * k;
        slantPanel(ctx, x - bw / 2, y - bh / 2, bw, bh, 10 * k, 'rgba(9,10,14,0.7)', rgba(col, 0.9), rgba(col, 0.6 + 0.4 * pulse));
        txt(ctx, z.hit ? 'ZONE \u2713' : 'IN ZONE', x, y + 2 * k, '900 ' + (17 * k) + 'px ' + FONT_UI, z.hit ? PAL.green : col, 'center');
        bar(ctx, x - bw / 2 + 12 * k, y + bh / 2 - 9 * k, bw - 24 * k, 3 * k, pr, col, 'rgba(255,255,255,0.12)', 1 * k);
        ctx.restore();
        return;
      }
      if (nz.dist > 170) return;
      var near = clamp01(1 - (nz.dist - 20) / 150);
      var a = 0.35 + 0.65 * near;
      ctx.save();
      ctx.globalAlpha = a;
      var s = (compact ? 11 : 15) * k * (0.85 + 0.3 * near);
      if (side) {
        for (var i = 0; i < 3; i++) {
          var ph = ((t * 3.2) - i * 0.33) % 1; ph = ph < 0 ? ph + 1 : ph;
          var lit = 0.35 + 0.65 * Math.pow(1 - ph, 2);
          chevron(ctx, x + side * i * s * 1.1, y, s, side, col, lit);
        }
        var lx = x - side * s * 1.4;
        txt(ctx, ki.label, lx, y - 3 * k, '900 ' + (13 * k) + 'px ' + FONT_UI, col, side > 0 ? 'right' : 'left');
        txt(ctx, Math.round(nz.dist) + ' m', lx, y + 14 * k, '700 ' + (12 * k) + 'px ' + FONT_NUM, PAL.ink, side > 0 ? 'right' : 'left');
      } else {
        ctx.save(); ctx.translate(x, y - H * 0.08); ctx.rotate(-Math.PI / 2);
        chevron(ctx, 0, 0, s, 1, col, 0.6 + 0.4 * Math.sin(t * 8));
        ctx.restore();
        txt(ctx, ki.label + '  ' + Math.round(nz.dist) + ' m', x, y - H * 0.08 + s * 2.2, '900 ' + (13 * k) + 'px ' + FONT_UI, col, 'center');
      }
      ctx.restore();
    }

    function drawWorldMarkers(ctx, zones, k, nz, zoneLive) {
      if (!projector || !Array.isArray(zones)) return false;
      var items = [], nextShown = false;
      for (var i = 0; i < zones.length; i++) {
        var z = zones[i];
        if (!z || !isNum(z.x) || !isNum(z.y)) continue;
        var p = null;
        try { p = projector(z.x, z.y, num(z.z, 0)); } catch (e) { p = null; }
        if (!p || !isNum(p.x) || !isNum(p.y) || p.visible === false) continue;
        items.push({ z: z, p: p, i: i, d: num(p.depth, 0) });
      }
      // far first so near markers overlap them
      items.sort(function (a, b) { return b.d - a.d; });
      for (var j = 0; j < items.length; j++) {
        var it = items[j], zz = it.z, pp = it.p;
        var kind = zoneKind(zz), ki = ZONE_KIND[kind];
        var isNext = nz && nz.zone === zz;
        var active = zoneLive !== false && (!!zz.active || (isNext && nz.inZone));
        var col = zz.hit ? PAL.green : (zz.color || ki.color);
        var sc = clamp(num(pp.scale, 1), 0.3, 2.2) * k;
        var hitAge = S.zoneHit[zz.id != null ? zz.id : 'z' + it.i];
        var ha = isNum(hitAge) ? S.t - hitAge : 99;
        var bob = Math.sin(S.t * 3 + it.i) * 3 * sc;
        ctx.save();
        ctx.globalAlpha = zz.hit ? (ha < 1.2 ? 1 : 0.45) : isNext ? 1 : 0.7;
        ctx.translate(pp.x, pp.y);
        // ground ring at the clip point
        var rr = (active ? 16 + 4 * Math.sin(S.t * 12) : 12) * sc;
        ctx.save(); ctx.scale(1, 0.36);
        ctx.beginPath(); ctx.arc(0, 0, rr, 0, TAU);
        ctx.strokeStyle = rgba(col, active ? 0.95 : 0.6); ctx.lineWidth = (active ? 4 : 2.5) * sc;
        ctx.shadowColor = col; ctx.shadowBlur = 12; ctx.stroke();
        if (zz.hit && ha < 0.8) { ctx.beginPath(); ctx.arc(0, 0, rr * (1 + ha * 3), 0, TAU); ctx.strokeStyle = rgba(PAL.green, 0.8 * (1 - ha / 0.8)); ctx.stroke(); }
        ctx.restore();
        // stem + floating marker
        var top = -(34 * sc) + bob;
        ctx.strokeStyle = rgba(col, 0.55); ctx.lineWidth = 1.5 * sc;
        ctx.beginPath(); ctx.moveTo(0, -3 * sc); ctx.lineTo(0, top + 9 * sc); ctx.stroke();
        ctx.translate(0, top);
        var pop = zz.hit && ha < 0.5 ? 1 + 0.6 * easeOutBack(1 - ha / 0.5) * (1 - ha / 0.5) : 1;
        ctx.scale(pop, pop);
        ctx.beginPath(); ctx.moveTo(-8 * sc, -7 * sc); ctx.lineTo(8 * sc, -7 * sc); ctx.lineTo(0, 7 * sc); ctx.closePath();
        ctx.fillStyle = zz.hit ? rgba(PAL.green, 0.85) : rgba(col, isNext ? 0.9 : 0.4);
        ctx.shadowColor = col; ctx.shadowBlur = isNext ? 16 : 8; ctx.fill();
        ctx.shadowBlur = 0; ctx.strokeStyle = col; ctx.lineWidth = 1.6 * sc; ctx.stroke();
        if (zz.hit) txt(ctx, '✓', 0, 1 * sc, '900 ' + (10 * sc) + 'px ' + FONT_UI, '#0b0c10', 'center', 'middle');
        if (isNext && pp.x > 0 && pp.x < (canvas && canvas.clientWidth || 1e9)) nextShown = true;
        if (isNext && !zz.hit && !active && sc > 0.45 * k) {
          var lab = ki.label;
          ctx.font = '900 ' + (11 * sc) + 'px ' + FONT_UI;
          var tw = ctx.measureText(lab).width;
          slant(ctx, -tw / 2 - 7 * sc, -27 * sc, tw + 14 * sc, 15 * sc, 4 * sc);
          ctx.fillStyle = 'rgba(9,10,14,0.72)'; ctx.fill();
          txt(ctx, lab, 0, -15.5 * sc, '900 ' + (11 * sc) + 'px ' + FONT_UI, col, 'center');
          if (isNum(nz.dist)) txt(ctx, Math.round(nz.dist) + ' m', 0, -31 * sc, '700 ' + (9.5 * sc) + 'px ' + FONT_NUM, PAL.ink, 'center');
        }
        ctx.restore();
      }
      return nextShown;
    }

    function drawMeter(ctx, W, H, k, compact, st, info, ang, as, player, nz, zones, L, topY, view, nzIdle) {
      var t = S.t;
      var R = (compact ? 50 : 74) * k;
      var pw = (compact ? 340 : 540) * k, ph = R + (compact ? 52 : 84) * k;
      var cx = W / 2, cy, py, docked = compact || view === 'interior';
      if (docked) { py = topY; cy = py + R + (compact ? 10 : 12) * k; }
      else { py = H - num(opts.bottom, 0) - ((view === 'chase' ? 6 : 18) * k) - ph; cy = py + R + 12 * k; }
      var active = info.drifting || info.current > 0;
      var interior = view === 'interior';
      var dim = active || interior ? 1 : 0.72;
      ctx.save();
      ctx.globalAlpha = dim;
      // backdrop
      var grad = ctx.createLinearGradient(0, py, 0, py + ph);
      if (interior) {
        // cockpit / hood: a solid little plate up top (over the sky / windscreen header, never over the dash)
        grad.addColorStop(0, 'rgba(9,10,14,0.86)'); grad.addColorStop(1, 'rgba(9,10,14,0.74)');
      } else {
        grad.addColorStop(0, 'rgba(9,10,14,0)'); grad.addColorStop(0.4, 'rgba(9,10,14,0.5)'); grad.addColorStop(1, 'rgba(9,10,14,0.78)');
      }
      slant(ctx, cx - pw / 2, py, pw, ph, 22 * k); ctx.fillStyle = grad; ctx.fill();
      if (interior) { ctx.strokeStyle = PAL.edge; ctx.lineWidth = 1; ctx.stroke(); }

      // ---- angle arc meter (±90° drift -> ±100° of arc around "up")
      var SPAN = 100 / 90 * (Math.PI / 180);
      function A(d) { return -Math.PI / 2 + clamp(d, -90, 90) * SPAN; }
      var lw = 9 * k;
      ctx.lineCap = 'butt';
      var bands = [[0, 15, 'rgba(255,255,255,0.10)'], [15, 30, rgba(PAL.yellow, 0.35)], [30, 50, rgba(PAL.green, 0.5)], [50, 70, rgba(PAL.amber, 0.38)], [70, 90, rgba(PAL.red, 0.45)]];
      for (var sd = -1; sd <= 1; sd += 2) {
        for (var b = 0; b < bands.length; b++) {
          var a0 = A(sd * bands[b][0]), a1 = A(sd * bands[b][1]);
          ctx.beginPath(); ctx.arc(cx, cy, R, Math.min(a0, a1) + 0.012, Math.max(a0, a1) - 0.012);
          ctx.strokeStyle = bands[b][2]; ctx.lineWidth = lw; ctx.stroke();
        }
      }
      // ticks
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.2 * k;
      for (var d = -90; d <= 90; d += 10) {
        var ta = A(d), r0 = R + lw * 0.7, r1 = R + lw * 0.7 + (d % 30 === 0 ? 6 : 3) * k;
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(ta) * r0, cy + Math.sin(ta) * r0); ctx.lineTo(cx + Math.cos(ta) * r1, cy + Math.sin(ta) * r1); ctx.stroke();
      }
      if (!compact) {
        txt(ctx, 'L', cx + Math.cos(A(-90)) * (R + 16 * k), cy + Math.sin(A(-90)) * (R + 16 * k) + 4 * k, '700 ' + (9 * k) + 'px ' + FONT_UI, PAL.inkFaint, 'center');
        txt(ctx, 'R', cx + Math.cos(A(90)) * (R + 16 * k), cy + Math.sin(A(90)) * (R + 16 * k) + 4 * k, '700 ' + (9 * k) + 'px ' + FONT_UI, PAL.inkFaint, 'center');
      }
      // live fill (trail) from 0 to the needle
      var band = angleBand(S.angDisp), bc = BAND_COLOR[band];
      if (Math.abs(S.angDisp) > 1) {
        var aa = A(0), ab = A(S.angDisp);
        ctx.save();
        ctx.shadowColor = bc; ctx.shadowBlur = band === 'sweet' ? 16 * k : 6 * k;
        ctx.beginPath(); ctx.arc(cx, cy, R, Math.min(aa, ab), Math.max(aa, ab));
        ctx.strokeStyle = bc; ctx.lineWidth = lw * 0.55; ctx.stroke();
        ctx.restore();
      }
      // peak trail (slow-decaying max)
      if (Math.abs(S.angTrail) > 2) {
        var pa = A(S.angTrail);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 2 * k;
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(pa) * (R - lw * 0.5), cy + Math.sin(pa) * (R - lw * 0.5)); ctx.lineTo(cx + Math.cos(pa) * (R + lw * 0.5), cy + Math.sin(pa) * (R + lw * 0.5)); ctx.stroke();
      }
      // assist hold window (±6° around the angle the assist is holding) — sit the needle in it = LOCKED IN
      var locked = false;
      if (as && isNum(as.target) && Math.abs(as.target) > 5 && info.vis) {
        var w0 = A(as.target - 6), w1 = A(as.target + 6);
        locked = Math.abs(S.angDisp - as.target) <= 6 && info.drifting;
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, R + lw * 0.95, Math.min(w0, w1), Math.max(w0, w1));
        ctx.strokeStyle = rgba(PAL.cyan, locked ? 0.95 : 0.4); ctx.lineWidth = 3 * k;
        if (locked) { ctx.shadowColor = PAL.cyan; ctx.shadowBlur = 12 * k; }
        ctx.stroke();
        ctx.restore();
      }
      S.lockT = locked ? S.lockT + S.dt : 0;
      // assist target ghost
      if (as && isNum(as.target) && Math.abs(as.target) > 1) {
        var ga = A(as.target);
        ctx.save();
        ctx.translate(cx + Math.cos(ga) * (R + lw * 0.9 + 4 * k), cy + Math.sin(ga) * (R + lw * 0.9 + 4 * k)); ctx.rotate(ga + Math.PI / 2);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-4 * k, -7 * k); ctx.lineTo(4 * k, -7 * k); ctx.closePath();
        ctx.fillStyle = PAL.cyan; ctx.fill();
        ctx.restore();
      }
      // needle
      var na = A(S.angDisp);
      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(na);
      ctx.shadowColor = bc; ctx.shadowBlur = 10 * k;
      ctx.beginPath(); ctx.moveTo(R * 0.74, -2.6 * k); ctx.lineTo(R + lw * 0.75, 0); ctx.lineTo(R * 0.74, 2.6 * k); ctx.closePath();
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.restore();
      // centre readout
      var sweet = band === 'sweet';
      var af = (compact ? 24 : 34) * k;
      ctx.save();
      ctx.translate(cx, cy - R * 0.12); ctx.transform(1, 0, -0.1, 1, 0, 0);
      if (sweet) { ctx.shadowColor = PAL.green; ctx.shadowBlur = 14 * k; }
      txt(ctx, Math.round(Math.abs(S.angDisp)) + '\u00b0', 0, 0, '800 ' + af + 'px ' + FONT_NUM, band === 'idle' ? PAL.inkDim : bc, 'center');
      ctx.restore();
      var lockedIn = S.lockT > 0.25 && sweet;
      tracked(ctx, lockedIn ? 'LOCKED IN' : sweet ? 'SWEET SPOT' : band === 'over' ? 'TOO MUCH' : 'DRIFT ANGLE', cx, cy - R * 0.12 + 14 * k, '800 ' + (8.5 * k) + 'px ' + FONT_UI, lockedIn ? PAL.cyan : sweet ? PAL.green : band === 'over' ? PAL.red : PAL.inkFaint, 'center', 1.6 * k);
      var spd = num(st.speed, player ? num(player.speed, 0) : 0);
      var spdTxt = units === 'mph' ? Math.round(spd * 2.236936) + ' MPH' : Math.round(spd * 3.6) + ' KM/H';
      if (info.vis && S.driftT > 0.2) spdTxt += '  \u00b7  ' + S.driftT.toFixed(1) + 's';
      txt(ctx, spdTxt, cx, cy - R * 0.12 + 27 * k, '700 ' + (11 * k) + 'px ' + FONT_NUM, PAL.inkDim, 'center');

      // ---- left block: current drift points + grade
      var sideW = (compact ? 104 : 168) * k;
      var lx = cx - R - lw - 14 * k;
      var cf = (compact ? 22 : 32) * k;
      var g = info.grade;
      var gp = clamp01(1 - (t - S.gradePulse) / 0.5);
      var saving = info.drifting && S.graceT > 0.08;
      var hdr = saving ? 'SAVE IT!' : info.vis ? 'DRIFTING' : info.current > 0 ? 'HOLD IT' : 'DRIFT';
      var hdrCol = saving ? (Math.floor(t * 8) % 2 ? PAL.amber : PAL.yellow) : info.vis ? PAL.hot : PAL.inkFaint;
      var hw = tracked(ctx, hdr, lx, cy - R * 0.62, '800 ' + (9 * k) + 'px ' + FONT_UI, hdrCol, 'right', 1.8 * k);
      if (info.vis && isNum(info.rate) && info.rate > 0 && !compact) {
        txt(ctx, '+' + fmtInt(info.rate) + '/s', lx - hw - 8 * k, cy - R * 0.62, '700 ' + (9.5 * k) + 'px ' + FONT_NUM, rgba(PAL.gold, 0.85), 'right');
      }
      var msp = clamp01(1 - (t - S.msPulse) / 0.55);
      ctx.save();
      ctx.translate(lx, cy - R * 0.62 + cf + 2 * k); ctx.transform(1, 0, -0.14, 1, 0, 0);
      var bump = 1 + 0.28 * easeOutBack(1 - msp) * msp + 0.04 * S.heat;
      ctx.scale(bump, bump);
      if (info.vis) { ctx.shadowColor = rgba(msp > 0 ? PAL.gold : PAL.hot, 0.6 + 0.3 * S.heat); ctx.shadowBlur = (8 + 10 * S.heat + 14 * msp) * k; }
      txt(ctx, fmtInt(S.dispCurrent), 0, 0, '800 ' + cf + 'px ' + FONT_NUM, msp > 0.2 ? PAL.gold : info.current > 0 ? PAL.ink : PAL.inkFaint, 'right');
      ctx.restore();
      if (saving) {
        // grace bar: how long the slide survives at this angle before it banks
        var gl = num(S.health, 1);
        bar(ctx, lx - 96 * k, cy - R * 0.62 + cf + 30 * k, 96 * k, 3 * k, gl, PAL.amber, 'rgba(255,255,255,0.1)', 1 * k);
      }
      if (g && info.current > 0) {
        var gs = 1 + 0.5 * easeOutElastic(1 - gp) * gp + 0.35 * gp;
        var gw = (g.code.length > 1 ? 34 : 26) * k, gh = 20 * k;
        ctx.save();
        ctx.translate(lx - gw / 2 - 2 * k, cy - R * 0.62 + cf + 18 * k); ctx.scale(gs, gs);
        slant(ctx, -gw / 2, -gh / 2, gw, gh, 5 * k);
        ctx.fillStyle = g.color; ctx.shadowColor = g.color; ctx.shadowBlur = 10 * k * (0.5 + gp); ctx.fill();
        ctx.shadowBlur = 0;
        txt(ctx, g.code, 0, 6 * k, '900 ' + (16 * k) + 'px ' + FONT_UI, '#0b0c10', 'center');
        ctx.restore();
        if (!compact) txt(ctx, g.label, lx - gw - 10 * k, cy - R * 0.62 + cf + 23 * k, '800 ' + (11 * k) + 'px ' + FONT_UI, g.color, 'right');
      }

      // ---- right block: multiplier + combo bar + chain timer
      var rx = cx + R + lw + 14 * k;
      var mp = clamp01(1 - (t - S.multPulse) / 0.45);
      var hotM = info.mult >= info.cmax - 1e-6;
      var mcol = hotM ? PAL.hot : info.mult >= 3 ? PAL.amber : info.mult > 1.0001 ? PAL.yellow : PAL.inkDim;
      tracked(ctx, 'COMBO', rx, cy - R * 0.62, '800 ' + (9 * k) + 'px ' + FONT_UI, PAL.inkFaint, 'left', 1.8 * k);
      ctx.save();
      ctx.translate(rx, cy - R * 0.62 + cf + 2 * k);
      var ms = 1 + 0.3 * easeOutCubic(mp) * mp;
      ctx.scale(ms, ms); ctx.transform(1, 0, -0.14, 1, 0, 0);
      if (info.mult > 1.0001) { ctx.shadowColor = mcol; ctx.shadowBlur = (hotM ? 16 + 6 * Math.sin(t * 9) : 8) * k; }
      txt(ctx, fmtMult(S.dispMult), 0, 0, '900 ' + cf + 'px ' + FONT_UI, mcol, 'left');
      ctx.restore();
      // segmented combo bar 1 .. cmax
      var segN = Math.max(1, Math.round(info.cmax - 1)), bw = sideW - 18 * k, sgw = bw / segN;
      var by = cy - R * 0.62 + cf + 12 * k;
      for (var si = 0; si < segN; si++) {
        var f = clamp01(S.dispMult - 1 - si);
        var sx = rx + si * sgw;
        slant(ctx, sx, by, sgw - 3 * k, 7 * k, 3 * k); ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fill();
        if (f > 0) {
          slant(ctx, sx, by, Math.max(3 * k + 1, (sgw - 3 * k) * f), 7 * k, 3 * k);
          ctx.fillStyle = si >= segN - 1 ? PAL.hot : si >= segN / 2 ? PAL.amber : PAL.yellow; ctx.fill();
        }
      }
      // multiplier charge: thin bar under the segments filling toward the next step, flashes when it ticks over
      if (isNum(info.prog) && info.vis && info.mult < info.cmax - 1e-6) {
        var cflash = clamp01(1 - (t - S.chargePulse) / 0.4);
        ctx.save();
        if (cflash > 0) { ctx.shadowColor = PAL.yellow; ctx.shadowBlur = 12 * k * cflash; }
        bar(ctx, rx, by + 8.5 * k, bw - 3 * k, 2 * k, cflash > 0 ? 1 : info.prog, cflash > 0 ? rgba('#ffffff', 0.6 + 0.4 * cflash) : rgba(PAL.yellow, 0.85), 'rgba(255,255,255,0.06)', 1 * k);
        ctx.restore();
      }
      // chain (decay) timer
      var win = num(st.chainWindow_s, num(opts.chainWindow_s, 1.5));
      if (info.drifting && isNum(st.comboTimeLeft_s)) S.chainWin = Math.max(S.chainWin || 0, st.comboTimeLeft_s);
      if (S.chainWin > 0 && !isNum(st.chainWindow_s)) win = S.chainWin;
      var left = first(st.comboTimeLeft_s, st.comboTimeLeft, st.comboTimer, st.decay_s, st.comboDecay_s, st.chainTimeLeft);
      if (!isNum(left)) left = info.drifting ? win : Math.max(0, win - (t - S.lastDriftT));
      var showChain = (info.current > 0 || info.mult > 1.0001) && !info.drifting && left > 0;
      if (showChain) {
        var cfrac = clamp01(left / win);
        bar(ctx, rx, by + 11 * k, bw - 3 * k, 3 * k, cfrac, cfrac < 0.35 ? PAL.red : PAL.ink, 'rgba(255,255,255,0.08)', 1 * k);
        txt(ctx, 'CHAIN ' + left.toFixed(1) + 's', rx, by + 26 * k, '800 ' + (9 * k) + 'px ' + FONT_UI, cfrac < 0.35 && Math.floor(t * 8) % 2 ? PAL.red : PAL.yellow, 'left');
      } else if (info.drifting) {
        tracked(ctx, 'KEEP SLIDING', rx, by + 22 * k, '800 ' + (8.5 * k) + 'px ' + FONT_UI, rgba(PAL.hot, 0.75 + 0.25 * Math.sin(t * 10)), 'left', 1.4 * k);
      }

      // ---- zone ribbon (next 300 m)
      var rbW = pw - (compact ? 60 : 120) * k, rbX = cx - rbW / 2, rbY = cy + 25 * k, rbH = 8 * k;
      var LOOK = 300;
      var ps = player && isNum(player.s) ? player.s : null;
      slant(ctx, rbX, rbY, rbW, rbH, 4 * k); ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
      if (ps !== null && Array.isArray(zones) && zones.length) {
        for (var zi = 0; zi < zones.length; zi++) {
          var z = zones[zi]; if (!z) continue;
          var zs = zoneS(z); if (!isNum(zs)) continue;
          var zl = zoneLen(z);
          var ahead = ((zs - ps) % L + L) % L;
          if (ahead > L - zl) ahead = ahead - L;   // currently inside
          if (ahead > LOOK || ahead + zl < 0) continue;
          var a0x = rbX + rbW * clamp01(ahead / LOOK), a1x = rbX + rbW * clamp01((ahead + zl) / LOOK);
          var zc = z.hit ? PAL.green : (z.color || ZONE_KIND[zoneKind(z)].color);
          var zsd = zoneSide(z);
          var yy = zsd < 0 ? rbY - 1 * k : zsd > 0 ? rbY + rbH * 0.5 + 1 * k : rbY;
          var hh = zsd ? rbH * 0.5 : rbH;
          ctx.fillStyle = z.hit ? rgba(PAL.green, 0.6) : zc;
          ctx.fillRect(a0x, yy, Math.max(2 * k, a1x - a0x), hh);
        }
      }
      // player marker
      ctx.fillStyle = PAL.ink; ctx.beginPath();
      ctx.moveTo(rbX + 2 * k, rbY - 4 * k); ctx.lineTo(rbX + 9 * k, rbY + rbH / 2); ctx.lineTo(rbX + 2 * k, rbY + rbH + 4 * k); ctx.closePath(); ctx.fill();
      if (!compact) {
        txt(ctx, '0', rbX, rbY + rbH + 13 * k, '700 ' + (8.5 * k) + 'px ' + FONT_NUM, PAL.inkFaint, 'left');
        txt(ctx, LOOK + ' m', rbX + rbW, rbY + rbH + 13 * k, '700 ' + (8.5 * k) + 'px ' + FONT_NUM, PAL.inkFaint, 'right');
        var zlabel = nz ? (nz.inZone ? 'IN ' + ZONE_KIND[zoneKind(nz.zone)].label : 'NEXT ' + ZONE_KIND[zoneKind(nz.zone)].label + ' ' + Math.round(nz.dist) + ' m')
          : nzIdle ? ZONE_KIND[zoneKind(nzIdle.zone)].label + ' \u2014 DRIFT THROUGH IT' : 'NO ZONES AHEAD';
        var zlz = nz ? nz.zone : nzIdle ? nzIdle.zone : null;
        txt(ctx, zlabel, cx, rbY + rbH + 13 * k, '800 ' + (9 * k) + 'px ' + FONT_UI, zlz ? (zlz.color || ZONE_KIND[zoneKind(zlz)].color) : PAL.inkFaint, 'center');
      }

      // ---- wall proximity ("kiss the wall") gauge
      if (isNum(info.wall) && info.wall > 0.03 && info.vis) {
        var wx = cx + pw / 2 + 6 * k, wy0 = py + ph * 0.3, wh0 = ph * 0.6;
        ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(wx, wy0, 5 * k, wh0);
        var wf = clamp01(info.wall);
        ctx.save(); ctx.fillStyle = PAL.amber; ctx.shadowColor = PAL.amber; ctx.shadowBlur = 10 * k * wf;
        ctx.fillRect(wx, wy0 + wh0 * (1 - wf), 5 * k, wh0 * wf); ctx.restore();
        if (!compact) txt(ctx, 'WALL', wx + 2.5 * k, wy0 - 5 * k, '800 ' + (8 * k) + 'px ' + FONT_UI, wf > 0.6 ? PAL.amber : PAL.inkFaint, 'center');
      }

      // ---- assist chip + counter-steer bar
      if (as && !compact) {
        var ax = cx + pw / 2 - 90 * k, ay = py + ph - 5 * k;
        var lv = String(as.level || 'assist').toUpperCase();
        var aph = assistPhase(as);   // (not `ph`: that is the panel height, still used below)
        var chip = 'ASSIST ' + lv + (aph && aph.id !== 'grip' && aph.id !== 'race' ? '  \u00b7  ' + aph.label : '');
        var hotChip = aph && (aph.id === 'catch' || aph.id === 'spin' || aph.id === 'kick' || aph.id === 'brake');
        txt(ctx, chip, ax + 40 * k, ay, '800 ' + (8.5 * k) + 'px ' + FONT_UI, hotChip ? aph.color : aph && aph.id === 'hold' ? rgba(PAL.cyan, 0.8) : PAL.inkFaint, 'right');
        if (isNum(as.counter)) {
          var cbx = cx - pw / 2 + 90 * k, cbw = 70 * k;
          ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(cbx, ay - 5 * k, cbw, 3 * k);
          ctx.fillStyle = PAL.cyan;
          var half = cbw / 2, v = as.counter * half;
          ctx.fillRect(cbx + half + Math.min(0, v), ay - 5 * k, Math.abs(v), 3 * k);
          ctx.fillStyle = PAL.ink; ctx.fillRect(cbx + half - 0.5, ay - 7 * k, 1, 7 * k);
          tracked(ctx, 'COUNTERSTEER', cbx, ay - 9 * k, '800 ' + (7 * k) + 'px ' + FONT_UI, PAL.inkFaint, 'left', 1 * k);
        }
      }
      // ---- zone strip colour key (only the kinds this track actually has)
      if (!compact && Array.isArray(zones) && zones.length) {
        var keys = zoneLegend(zones);
        if (keys.length) {
          ctx.font = '800 ' + (7.5 * k) + 'px ' + FONT_UI;
          var gap = 10 * k, sw = 7 * k, kw = 0, kws = [];
          for (var ki2 = 0; ki2 < keys.length; ki2++) { var ww = sw + 4 * k + ctx.measureText(keys[ki2].label).width + keys[ki2].label.length * 0.8 * k; kws.push(ww); kw += ww + (ki2 ? gap : 0); }
          var kx = cx - kw / 2, kyy = rbY + rbH + 24 * k;   // between the ribbon label and the assist chip row
          for (var kj = 0; kj < keys.length; kj++) {
            ctx.fillStyle = keys[kj].color; ctx.fillRect(kx, kyy - 6 * k, sw, 5 * k);
            tracked(ctx, keys[kj].label, kx + sw + 4 * k, kyy, '800 ' + (7.5 * k) + 'px ' + FONT_UI, rgba(keys[kj].color, 0.9), 'left', 0.8 * k);
            kx += kws[kj] + gap;
          }
        }
      }
      // ---- ASSIST BRAKING cue (the lock is braking for the corner ahead while Up is held: not a fault)
      // (0.4 s release hold: a governor that eases on / off never flickers the cue)
      S.brakeHold = as && as.braking && !info.drifting ? 0.4 : Math.max(0, num(S.brakeHold, 0) - S.dt);
      if (S.brakeHold > 0 && !info.drifting) {
        // beside the panel (left), so it never collides with the coach strip above / below it
        var bfz = (compact ? 9 : 10) * k;
        ctx.save();
        ctx.font = '800 ' + bfz + 'px ' + FONT_UI;
        var btw = ctx.measureText('ASSIST BRAKING').width + 26 * k;
        var bcx = compact ? cx : cx - pw / 2 - 10 * k - btw / 2, bcy = compact ? py + ph + 12 * k : cy - R * 0.2;
        slantPanel(ctx, bcx - btw / 2, bcy - bfz * 1.25, btw, bfz * 1.75, 5 * k, 'rgba(9,10,14,0.78)', rgba(PAL.amber, 0.6));
        tracked(ctx, 'ASSIST BRAKING', bcx, bcy, '800 ' + bfz + 'px ' + FONT_UI, PAL.amber, 'center', 1.4 * k);
        ctx.restore();
      }
      S.brakeCue = S.brakeHold > 0 && !info.drifting;
      ctx.restore();
      return { top: py, bottom: py + ph, docked: !compact && docked };
    }

    /** Coach strip: one arrow-key tip at a time, debounced, cross-faded. */
    function drawCoach(ctx, W, y, k, compact) {
      var t = S.t;
      function one(c, a, dy) {
        if (!c || a <= 0.01) return;
        ctx.save();
        ctx.globalAlpha = a;
        var f = (compact ? 10 : 13) * k;
        ctx.font = '800 ' + f + 'px ' + FONT_UI;
        var parts = String(c.text);
        var tw = ctx.measureText(parts).width + parts.length * 1.2 * k;
        var w = tw + 34 * k, h = f * 1.9, x = W / 2 - w / 2, yy = y - h + dy;
        slantPanel(ctx, x, yy, w, h, 8 * k, 'rgba(9,10,14,0.74)', rgba(c.color, 0.55));
        slant(ctx, x + 2 * k, yy, 4 * k, h, 2 * k); ctx.fillStyle = c.color; ctx.fill();
        if (c.tone === 'good') { ctx.shadowColor = c.color; ctx.shadowBlur = 10 * k; }
        tracked(ctx, parts, W / 2 + 2 * k, yy + h * 0.68, '800 ' + f + 'px ' + FONT_UI, c.tone === 'bad' && Math.floor(t * 6) % 2 ? '#ffd0d6' : c.color, 'center', 1.2 * k);
        ctx.restore();
      }
      var ain = S.coach ? easeOutCubic((t - S.coachShownT) / 0.22) : 0;
      var aout = S.coachPrev ? 1 - clamp01((t - S.coachOutT) / 0.2) : 0;
      if (aout > 0) one(S.coachPrev, aout, 6 * k * (1 - aout));
      else S.coachPrev = null;
      if (S.coach) one(S.coach, ain, 8 * k * (1 - ain));
    }

    /** Speed streaks at the screen edges while sliding — intensity follows the "heat" (combo + sweet spot). */
    function drawStreaks(ctx, W, H, k) {
      var h = S.heat;
      if (h < 0.04) return;
      ctx.save();
      ctx.lineCap = 'round';
      var N = 18;
      for (var i = 0; i < N; i++) {
        var seed = Math.sin(i * 12.9898) * 43758.5453; seed -= Math.floor(seed);
        var seed2 = Math.sin(i * 78.233) * 12345.678; seed2 -= Math.floor(seed2);
        var side = i % 2 ? 1 : -1;
        var ph = (S.t * (1.4 + seed * 1.6) + seed2) % 1;
        var yy = H * (0.12 + 0.76 * seed2);
        var x0 = side < 0 ? W * (0.02 + 0.12 * seed) : W * (0.98 - 0.12 * seed);
        var len = (40 + 120 * seed) * k * h;
        var a = h * 0.32 * Math.sin(Math.PI * ph);
        var col = S.heat > 0.7 ? PAL.hot : '#ffffff';
        ctx.strokeStyle = rgba(col, a); ctx.lineWidth = (1 + 1.5 * seed) * k;
        var dx = side * len * (0.3 + ph);
        ctx.beginPath(); ctx.moveTo(x0 + side * ph * 30 * k, yy); ctx.lineTo(x0 + side * ph * 30 * k + dx, yy + len * 0.08); ctx.stroke();
      }
      ctx.restore();
    }

    function drawEdges(ctx, W, H, k, info) {
      var t = S.t;
      var bf = clamp01(1 - (t - S.badFlash) / 0.7);
      if (bf > 0) {
        ctx.save();
        var g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
        g.addColorStop(0, 'rgba(255,30,60,0)'); g.addColorStop(1, 'rgba(255,30,60,' + (0.45 * bf) + ')');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
      if (info.mult >= info.cmax - 1e-6 && info.drifting) {
        ctx.save();
        var pa = 0.18 + 0.1 * Math.sin(t * 6);
        var g2 = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, Math.max(W, H) * 0.8);
        g2.addColorStop(0, 'rgba(255,63,164,0)'); g2.addColorStop(1, 'rgba(255,63,164,' + pa + ')');
        ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    }

    /* ============================================================== draw */
    function draw(ctx, snap, scorerState, assistDebug) {
      if (destroyed || !ctx) return;
      var W = (canvas && (canvas.clientWidth || canvas.width)) || 1280;
      var H = (canvas && (canvas.clientHeight || canvas.height)) || 720;
      var tn = clock();
      S.dt = S.last === null ? 0 : clamp((tn - S.last) / 1000, 0, 0.1);
      S.last = tn; S.t += S.dt;
      var st = scorerState && typeof scorerState === 'object' ? scorerState : {};
      snap = snap || {};
      var player = findPlayer(snap);
      var as = readAssist(assistDebug || (snap.drift && snap.drift.assist));
      var info = process(st, snap, player);

      // animated values
      S.dispTotal = approach(S.dispTotal, info.total, S.dt, 6);
      S.dispCurrent = info.current < S.dispCurrent ? info.current : approach(S.dispCurrent, info.current, S.dt, 14);
      S.dispMult = info.mult < S.dispMult ? lerp(S.dispMult, info.mult, clamp01(S.dt * 12)) : lerp(S.dispMult, info.mult, clamp01(S.dt * 9));
      if (Math.abs(S.dispMult - info.mult) < 0.005) S.dispMult = info.mult;
      var ang = signedAngle(st, player, as);
      // critically damped needle: follows the slide closely but never shivers with frame-to-frame noise
      S.angSp = spring(S.angSp, ang, S.dt, 13);
      S.angDisp = clamp(S.angSp.x, -95, 95);
      if (Math.abs(ang) >= Math.abs(S.angTrail) || (ang * S.angTrail) < 0) S.angTrail = ang;
      else S.angTrail = lerp(S.angTrail, ang, clamp01(S.dt * 1.5));
      // coach strip after the needle moved, so angle hints always agree with the meter (and the SAVE IT! header)
      var fxDrift = !!(snap.drift && snap.drift.fx && snap.drift.fx.drifting);
      updateCoach(coachInfo(st.coach), Math.abs(S.angDisp), info.drifting || fxDrift, info.drifting && S.graceT > 0.08);

      var compact = W < 760 || H < 480;
      var view = cameraView(camMode || opts.camera || (camSource && safeCall(camSource, 'getCamera')) || snap.camera || (snap.drift && snap.drift.camera));
      S.view = view;
      // zone states (IN ZONE chip, active rings, "IN OUTER ZONE") only once the car is rolling / sliding:
      // a zone overlapping the grid must not light up during the 3-2-1 countdown at 0 km/h
      var spdNow = num(st.speed, player ? num(player.speed, 0) : 0);
      var zoneLive = info.drifting || info.current > 0 || spdNow > 3;
      var k = compact ? clamp(Math.min(W / 420, H / 420), 0.62, 1.05) : clamp(Math.min(W / 1366, H / 800) * 1.06, 0.72, 1.6);
      var M = Math.round((compact ? 8 : 18) * k);
      var L = num(snap.trackLength, num(opts.geom && (opts.geom.length || opts.geom.totalLength), 0));
      if (!(L > 0)) L = 1e9;
      var zones = Array.isArray(st.zones) ? st.zones : null;
      var nz = player ? nextZone(zones, player.s, L, 400) : null;
      var nzIdle = !zoneLive && nz && nz.inZone ? nz : null;   // parked inside a zone: show it as "ahead", not "in"
      if (nzIdle) nz = null;
      var ladder = normalizeTargets(st.targets || st.medalTargets || st.medals || opts.targets ||
        snap.driftTargets || (opts.trackDef && (opts.trackDef.driftTargets || opts.trackDef.medalTargets || (opts.trackDef.drift && opts.trackDef.drift.targets))));
      var timer = timerInfo(st, snap, opts);
      var mode = st.mode || opts.mode || snap.driftMode || null;
      var wantTandem = mode === 'tandem' || !!opts.tandem || st.tandem === true || isNum(st.tandemDist_m) || (st.tandem != null && typeof st.tandem === 'object') || isNum(st.tandem);
      var td = wantTandem ? tandemInfo(st, snap, player, opts.leadId) : null;

      ctx.save();
      ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.lineJoin = 'miter';
      drawEdges(ctx, W, H, k, info);
      if (opts.streaks !== false) drawStreaks(ctx, W, H, k);
      var markerShown = drawWorldMarkers(ctx, zones, k, nz, zoneLive);
      var top = num(opts.top, M);
      var y = drawScoreBanner(ctx, W, top, k, compact, st, info, timer, ladder);
      if (td) y = drawTandem(ctx, W, y + 6 * k, k, compact, td);
      // chase cams: a smaller panel tucked lower so the rear wheels + smoke stay visible;
      // interior cams: a compact panel docked at the TOP under the score banner, so the steering wheel, the
      // instrument cluster and the in-car readouts at the bottom of the screen stay visible
      var mk = !compact && view === 'chase' ? k * 0.86 : !compact && view === 'interior' ? k * 0.72 : k;
      var meter = drawMeter(ctx, W, H, mk, compact, st, info, ang, as, player, nz, zones, L, y + 4 * k, view, nzIdle);
      // the 3D marker already points at the next zone: keep only the in-zone progress box on screen
      if (!markerShown || (nz && nz.inZone)) drawZoneArrows(ctx, W, H, k, compact, nz);
      var docked = compact || meter.docked;
      if (opts.coach !== false) drawCoach(ctx, W, docked ? meter.bottom + 30 * k : meter.top - 6 * k, k, compact);
      var popBase = docked ? meter.bottom + (S.coach && opts.coach !== false ? 36 : 6) * k : td ? y + 10 * k : Math.max(y + 18 * k, H * 0.26);
      drawPopups(ctx, W, H, popBase, k, compact, !!td);
      ctx.restore();
    }

    return {
      draw: function (ctx, snap, scorerState, assistDebug) {
        try { draw(ctx, snap, scorerState, assistDebug); }
        catch (e) {
          if (!S.errLogged && typeof console !== 'undefined') { console.error('[CB.race.drift.hud]', e); S.errLogged = true; }
        }
      },
      reset: function () { fresh(); },
      setUnits: function (u) { units = u === 'mph' ? 'mph' : 'kph'; },
      getUnits: function () { return units; },
      setOptions: function (o) { if (o) { Object.assign(opts, o); if (typeof o.worldToScreen === 'function') projector = o.worldToScreen; if (o.units) units = o.units === 'mph' ? 'mph' : 'kph'; } },
      /** fn(x, y, z) -> {x, y, visible?, scale?}, or a CB.race.renderer3d instance (projection built from its camera state). */
      setProjector: function (fn) { projector = typeof fn === 'function' ? fn : rendererProjector(fn, canvas); if (fn && typeof fn.getCamera === 'function') camSource = fn; },
      /** Optional: the race UI's camera mode ('chase' | 'cockpit' | 'hood' | ...); null = ask the renderer. */
      setCameraMode: function (m) { camMode = m ? String(m) : null; return cameraView(camMode); },
      attachRenderer: function (r) { projector = rendererProjector(r, canvas); if (r && typeof r.getCamera === 'function') camSource = r; return !!projector; },
      /** Manually push a popup (session/UI can announce things the scorer doesn't). */
      popup: function (text, points, o) { return pushPopup(text, points, o); },
      /** Test/debug view of the animated state. */
      debugState: function () {
        return { t: S.t, dispTotal: S.dispTotal, dispCurrent: S.dispCurrent, dispMult: S.dispMult, angle: S.angDisp,
          drifting: S.dispDrifting, grace: S.graceT, heat: S.heat, coach: S.coach ? S.coach.text : null, coachId: S.coach ? S.coach.id : null,
          locked: S.lockT > 0.25, view: S.view || null, brakeCue: !!S.brakeCue, popsShown: S.popsShown || 0,
          popups: S.pops.map(function (p) { return { text: p.text, points: p.points, kind: p.kind, big: p.big, age: S.t - p.t0 }; }) };
      },
      destroy: function () { destroyed = true; S.pops = []; }
    };
  }

  CB.race.drift.hud = {
    create: create,
    _internal: {
      fmtInt: fmtInt, fmtShort: fmtShort, fmtClock: fmtClock, fmtMult: fmtMult, gradeInfo: gradeInfo,
      classifyEvent: classifyEvent, normalizeTargets: normalizeTargets, medalProgress: medalProgress,
      nextZone: nextZone, zoneSide: zoneSide, zoneKind: zoneKind, carDriftAngle: carDriftAngle,
      readAssist: readAssist, signedAngle: signedAngle, angleBand: angleBand, approach: approach,
      tandemInfo: tandemInfo, timerInfo: timerInfo, projectThrough: projectThrough, rendererProjector: rendererProjector, eventKey: eventKey, findPlayer: findPlayer,
      easeOutBack: easeOutBack, easeOutElastic: easeOutElastic,
      assistPhase: assistPhase, coachInfo: coachInfo, spring: spring, milestoneCrossed: milestoneCrossed,
      angleHintValid: angleHintValid, angleHintFor: angleHintFor, reconcileAngleHint: reconcileAngleHint,
      cameraView: cameraView, zoneLegend: zoneLegend, staleWhileDrifting: staleWhileDrifting
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.race.drift.hud;

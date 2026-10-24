/* ==========================================================================
   Redline — js/drag/drag-hud.js
   CB.drag.hud : canvas HUD for Drag Racing (docs/DRAG-SPEC.md §0).

     layout(w, h, {compact, touch, safe {l, r, t, b}}) -> PURE rects {tach, lights, launch, tree, splits, progress, prompt, banner, heat, n2o}
     touchLayout(w, h, safe) -> PURE rects for the on-screen controls {throttle, brake, up, down, n2o, pause, camera}
     prompt(snap, lane, opts) -> PURE { text, sub, kind } — what the player should do now
     fmtSpeed(v_ms, units) -> '123.4 mph' / '198.6 km/h'      gradeColor(g)
     create() -> hud { draw(ctx, snap, view), reset(), popups() }
        view {width, height, compact, touch, safe, units 'imperial'|'metric', keys {up, down, thr, brk, n2o}, fps?, paused?}
   Draws: big tach with a shift-light bar, gear and speed; launch-rpm gauge with the green sweet spot; tyre-heat meter
   in the burnout box; the Christmas tree (both lanes) or the flagger; live split timers for both lanes; a lane progress
   bar vs the opponent; prompts; PERFECT / GOOD / EARLY / LATE shift pop-ups; RT flash; red-light / win banners.
   Classic script; the pure helpers load in Node (tests/drag-hud.test.js).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.drag = CB.drag || {};

(function () {
  'use strict';
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  var FONT = "'Barlow Condensed','Roboto Condensed','Arial Narrow','Helvetica Neue',system-ui,sans-serif",   // --hud-font (synced in create)
    MONO = "ui-monospace,'SF Mono','Roboto Mono',Menlo,Consolas,monospace";   // --hud-num

  /* Shared HUD tokens (css/styles.css § 01 --hud-*, --mode-drag): every mode's HUD — race, drift, arcade, derby,
     Formula 1, drag — draws with the same display + numeral fonts, panel fill / edge, ink and status colours, and
     its own mode accent. The literals are the token values (Node tests, first frame); syncHud() reads the live
     tokens once. HUDs stay dark over the 3D view in both themes, so the light theme's darkened accents are skipped. */
  var HUD = {
    font: "'Barlow Condensed','Roboto Condensed','Arial Narrow','Helvetica Neue',system-ui,sans-serif",
    num: "ui-monospace,'SF Mono','Roboto Mono',Menlo,Consolas,monospace",
    panel: 'rgba(8,10,14,0.78)', panelSoft: 'rgba(8,10,14,0.55)', line: 'rgba(255,255,255,0.16)',
    ink: '#f4f5f7', dim: 'rgba(244,245,247,0.62)', faint: 'rgba(244,245,247,0.3)',
    accent: '#e7cd9a', good: '#3fdc8a', warn: '#ffb13a', bad: '#ff5a4d', mode: '#8fd14f', radius: 10, radiusSm: 6
  };
  var HUD_VARS = { font: '--hud-font', num: '--hud-num', panel: '--hud-panel', panelSoft: '--hud-panel-soft', line: '--hud-line', ink: '--hud-ink',
    dim: '--hud-dim', faint: '--hud-faint', accent: '--hud-accent', good: '--hud-good', warn: '--hud-warn', bad: '--hud-bad', mode: '--mode-drag',
    radius: '--hud-radius', radiusSm: '--hud-radius-sm' };
  var hudSynced = false;
  function syncHud() {
    if (hudSynced || typeof window === 'undefined' || typeof document === 'undefined' || !window.getComputedStyle || !document.documentElement) return HUD;
    hudSynced = true;
    try {
      var root = document.documentElement, cs = window.getComputedStyle(root), light = root.getAttribute('data-theme') === 'light';
      Object.keys(HUD_VARS).forEach(function (k) {
        if (k === 'mode' && light) return;
        var v = String(cs.getPropertyValue(HUD_VARS[k]) || '').trim();
        if (!v) return;
        if (k === 'radius' || k === 'radiusSm') { var n = parseFloat(v); if (n >= 0) HUD[k] = n; } else HUD[k] = v;
      });
    } catch (e) { /* keep the literals */ }
    return HUD;
  }
  /** A HUD panel fill at a given opacity (same tint as --hud-panel). */
  function hudFill(a) { var m = /rgba?\(([^,]+),([^,]+),([^,)]+)/.exec(HUD.panel); return 'rgba(' + (m ? m[1] + ',' + m[2] + ',' + m[3] : '8,10,14') + ',' + a + ')'; }
  var MPH = 2.2369363, KPH = 3.6;
  var GRADE_COL = { perfect: HUD.good, good: '#c8f05a', early: HUD.warn, late: HUD.bad };
  function gradeColor(g) { return GRADE_COL[g] || HUD.ink; }
  function fmtSpeed(v, units) { v = num(v, 0); return units === 'metric' ? (v * KPH).toFixed(1) + ' km/h' : (v * MPH).toFixed(1) + ' mph'; }
  /** reaction-time verdict for the launch readout */
  function rtGrade(rt) {
    if (rt == null || !isFinite(rt)) return null;
    if (rt < 0) return { text: 'RED LIGHT', col: HUD.bad };
    if (rt <= 0.010) return { text: 'PERFECT!', col: HUD.good };
    if (rt <= 0.05) return { text: 'GREAT', col: '#9dff6a' };
    if (rt <= 0.15) return { text: 'GOOD', col: '#e6f45a' };
    if (rt <= 0.35) return { text: 'OK', col: HUD.ink };
    return { text: 'SLOW', col: HUD.warn };
  }
  function f3(t) { return t == null || !isFinite(t) ? '—' : t.toFixed(3); }

  /* ------------------------------------------------------------------ pure layout */
  function layout(w, h, o) {
    o = o || {};
    var s = o.safe || {}, L = num(s.l, 0), R = num(s.r, 0), T = num(s.t, 0), B = num(s.b, 0);
    var compact = !!o.compact || h < 520 || w < 700, touch = !!o.touch;
    var out = { compact: compact };
    if (!compact) {
      var tr = 132;
      out.tach = { x: w - 2 * tr - 34 - R, y: h - 2 * tr - 30 - B, w: 2 * tr, h: 2 * tr };
      out.lights = { x: out.tach.x - 10, y: out.tach.y - 34, w: out.tach.w + 20, h: 22 };
      out.launch = { x: w / 2 - 230, y: h - 92 - B, w: 460, h: 54 };
      out.heat = { x: w / 2 - 230, y: h - 152 - B, w: 460, h: 40 };
      out.tree = { x: 20 + L, y: h / 2 - 170, w: 112, h: 300 };
      out.splits = { x: 20 + L, y: 18 + T, w: 330, h: 0 };
      out.progress = { x: w / 2 - 260, y: 18 + T, w: 520, h: 40 };
      out.prompt = { x: w / 2 - 320, y: 74 + T, w: 640, h: 56 };
      out.banner = { x: w / 2 - 340, y: h * 0.42, w: 680, h: 110 };   // below the 3D timing boards
      out.pop = { x: w / 2, y: h * 0.34 };
      out.n2o = { x: out.tach.x - 110, y: out.tach.y + out.tach.h - 44, w: 96, h: 40 };
    } else {
      var lw = Math.min(300, w * 0.4);
      if (touch) {
        // phone landscape: BRAKE bottom-left, THROTTLE bottom-right with the shift column beside it (touchLayout);
        // the tach sits left of the shift column, the gauges between the brake and the tach: the car stays visible
        var TL = touchLayout(w, h, s), r3 = clamp(Math.min(h * 0.19, w * 0.09), 44, 72);
        out.tach = { x: TL.up.x - 2 * r3 - 10, y: h - 2 * r3 - 10 - B, w: 2 * r3, h: 2 * r3 };
        var gx0 = TL.brake.x + TL.brake.w + 12 + 74, gx1 = out.tach.x - 12, gw = clamp(gx1 - gx0, 120, 300);
        out.launch = { x: gx0 + Math.max(0, (gx1 - gx0 - gw) / 2), y: h - 44 - B, w: gw, h: 34 };
        out.heat = { x: out.launch.x, y: out.launch.y - 32, w: gw, h: 26 };
        out.tree = { x: 8 + L, y: 46 + T, w: 58, h: clamp(TL.brake.y - 56 - T, 96, 160) };
        out.splits = { x: w - 214 - R, y: 60 + T, w: 206, h: 0 };
        out.n2o = null;   // the N2O touch button shows the bottle itself
      } else {
        var r2 = clamp(Math.min(h * 0.27, w * 0.12), 52, 92);
        out.tach = { x: w - 2 * r2 - 12 - R, y: h - 2 * r2 - 10 - B, w: 2 * r2, h: 2 * r2 };
        out.launch = { x: w / 2 - lw / 2, y: h - 52 - B, w: lw, h: 38 };
        out.heat = { x: w / 2 - lw / 2, y: out.launch.y - 32, w: lw, h: 26 };
        out.tree = { x: 8 + L, y: 46 + T, w: 62, h: 166 };
        out.splits = { x: w - 214 - R, y: 46 + T, w: 206, h: 0 };
        out.n2o = { x: out.tach.x - 72, y: out.tach.y + out.tach.h - 30, w: 64, h: 26 };
      }
      out.lights = { x: out.tach.x - 8, y: out.tach.y - 18, w: out.tach.w + 16, h: 13 };
      out.progress = { x: w / 2 - Math.min(190, w * 0.24), y: 6 + T, w: Math.min(380, w * 0.48), h: 28 };
      out.prompt = { x: w / 2 - Math.min(250, w * 0.34), y: 40 + T, w: Math.min(500, w * 0.68), h: 40 };
      out.banner = { x: w / 2 - Math.min(260, w * 0.38), y: h * 0.12, w: Math.min(520, w * 0.76), h: 74 };
      out.pop = { x: w / 2, y: h * 0.4 };
    }
    return out;
  }
  /** first person: the launch-rpm and tyre gauges move off the bottom centre (where the dash cluster with the tach,
   *  staging lamps and ET sits) to the lower left over the door; on touch screens to the upper left, clear of the pads. */
  function fpGauges(Lo, w, h, view) {
    view = view || {};
    var s = view.safe || {}, L = num(s.l, 0), T = num(s.t, 0), B = num(s.b, 0);
    if (view.touch) {
      var tw = clamp(w * 0.3, 160, 260);
      // below the prompt line, right of the (practice) tree column, above the N2O button
      Lo.launch = { x: 74 + L, y: 88 + T, w: tw, h: 34 };
      Lo.heat = { x: 74 + L, y: 88 + T + 38, w: tw, h: 22 };
    } else if (Lo.compact) {
      var cw = clamp(w * 0.3, 170, 250);
      Lo.launch = { x: 10 + L, y: h - 48 - B, w: cw, h: 38 };
      Lo.heat = { x: 10 + L, y: h - 80 - B, w: cw, h: 26 };
    } else {
      var lw = clamp(w * 0.28, 260, 380);
      Lo.launch = { x: 20 + L, y: h - 84 - B, w: lw, h: 54 };
      Lo.heat = { x: 20 + L, y: h - 136 - B, w: lw, h: 40 };
    }
    return Lo;
  }
  /** on-screen controls (phone landscape first): BRAKE bottom-left, THROTTLE bottom-right, shift ▲/▼ beside the
   *  throttle, N2O above the brake, pause / camera top-right. Every target ≥ 44 px. */
  function touchLayout(w, h, safe) {
    safe = safe || {};
    var L = num(safe.l, 0), R = num(safe.r, 0), T = num(safe.t, 0), B = num(safe.b, 0);
    var pw = clamp(w * 0.15, 96, 150), ph = clamp(h * 0.44, 120, 230), m = 12;
    var sw = clamp(w * 0.085, 56, 84), sh = clamp(h * 0.2, 48, 80);
    var o = {
      brake: { x: m + L, y: h - ph - m - B, w: pw, h: ph },
      throttle: { x: w - pw - m - R, y: h - ph - m - B, w: pw, h: ph },
      up: { x: w - pw - sw - 2 * m - R, y: h - ph - m - B, w: sw, h: sh },
      down: { x: w - pw - sw - 2 * m - R, y: h - sh - m - B, w: sw, h: sh },
      n2o: { x: m + L, y: h - ph - m - B - 56, w: Math.min(pw, 96), h: 46 },
      pause: { x: w - 52 - R - m, y: 8 + T, w: 44, h: 44 },
      camera: { x: w - 104 - R - m, y: 8 + T, w: 44, h: 44 }
    };
    return o;
  }

  /* ------------------------------------------------------------------ prompts (pure) */
  function prompt(snap, me, o) {
    o = o || {};
    var k = o.keys || { thr: 'W', brk: 'S', up: 'E', down: 'Q' };
    if (!snap || !me) return null;
    var ph = snap.phase, street = snap.venue === 'street' || snap.treeType === 'flag';
    if (me.red) return { text: 'RED LIGHT', sub: me.rt != null && me.rt < 0 ? 'You left ' + Math.abs(me.rt).toFixed(3) + ' s before the green' : 'You left before the green', kind: 'bad' };
    if (me.dq) return { text: 'DISQUALIFIED', sub: String(me.dq), kind: 'bad' };
    if (ph === 'burnout') {
      if (me.burnout) {
        var T = num(me.tyreTemp, 28);
        if (T > 110) return { text: 'TOO HOT — LET GO', sub: 'Overheated tyres lose grip', kind: 'bad' };
        if (T >= 70) return { text: 'TYRES IN THE WINDOW', sub: 'Release and roll to the line', kind: 'good' };
        return { text: 'BURNOUT!', sub: 'Keep holding to heat the tyres', kind: 'info' };
      }
      if (me.x < num(o.burnoutEnd, -14)) return { text: 'Hold ' + k.brk + ' + ' + k.thr + ' for a burnout', sub: 'Hot tyres bite harder · or tap ' + k.thr + ' to roll to the line', kind: 'info' };
    }
    if (ph === 'burnout' || ph === 'staging') {
      if (street) return me.staged ? { text: 'ON THE LINE', sub: 'Hold ' + k.brk + ', rev it up, go on the flag drop', kind: 'info' } : { text: 'Roll up to the line', sub: 'Tap ' + k.thr + ' to creep', kind: 'info' };
      if (me.staged) {
        var oth = (snap.lanes || []).filter(function (l) { return l && l !== me && l.kind !== 'none'; })[0];
        return { text: me.deep ? 'DEEP STAGED' : 'STAGED', sub: 'Hold ' + k.brk + ' + rev · release on green' + (oth && !oth.staged ? ' · waiting for the other lane' : ''), kind: 'good' };
      }
      if (me.preStaged) return { text: 'PRE-STAGED', sub: 'Tiny taps of ' + k.thr + ' to stage', kind: 'info' };
      return { text: 'Creep in: tap ' + k.thr, sub: 'Stop when the stage bulbs light (' + k.brk + ' brakes)', kind: 'info' };
    }
    if (ph === 'tree') {
      if (me.launch && me.launch.held) {
        var r = num(me.launch.rpm, 0), lo = num(me.launch.lo, 0), hi = num(me.launch.hi, 0);
        if (me.launch.ev || me.launch.lc) return { text: me.launch.lc ? '2-STEP ARMED' : 'LAUNCH MODE', sub: 'Release ' + k.brk + ' on green', kind: 'good' };
        if (hi > lo && r < lo) return { text: 'MORE REVS', sub: 'Bring the needle into the green band', kind: 'warn' };
        if (hi > lo && r > hi) return { text: 'TOO MANY REVS', sub: 'Feather ' + k.thr + ' back into the band', kind: 'warn' };
        return { text: 'IN THE BAND', sub: 'Release ' + k.brk + ' on green', kind: 'good' };
      }
      return { text: street ? 'WATCH THE FLAG' : 'WATCH THE TREE', sub: 'Hold ' + k.brk + ' + ' + k.thr + ' to rev on the brake', kind: 'info' };
    }
    if (ph === 'run' && !me.finished && !me.autoShift && me.gear >= 1 && me.gear < num(me.maxGear, 6) && me.shiftLight && me.shiftLight.flash) return { text: 'SHIFT!', sub: k.up, kind: 'shift' };
    return null;
  }

  /* ------------------------------------------------------------------ drawing helpers */
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function panel(ctx, r, a) { rr(ctx, r.x, r.y, r.w, r.h, Math.min(HUD.radius, r.h / 3)); ctx.fillStyle = hudFill(a == null ? 0.78 : a); ctx.fill(); ctx.strokeStyle = HUD.line; ctx.lineWidth = 1; ctx.stroke(); }
  function text(ctx, s, x, y, size, color, align, weight, font) {
    ctx.font = (weight || 700) + ' ' + Math.round(size) + 'px ' + (font || FONT); ctx.fillStyle = color || HUD.ink; ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle'; ctx.fillText(s, x, y);
  }
  function bulb(ctx, x, y, r, on, col, dim, pop) {
    if (on && pop > 0) r *= 1 + 0.4 * pop;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = on ? col : dim || 'rgba(255,255,255,.07)'; ctx.fill();
    if (on) { ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = r * (1.6 + 2.4 * (pop || 0)); ctx.fill(); if (pop > 0) { ctx.globalAlpha = 0.35 * pop; ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, Math.PI * 2); ctx.fill(); } ctx.restore(); ctx.fillStyle = HUD.faint; ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.32, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  }
  function me_(snap) { var L = snap && snap.lanes || []; var i = snap && snap.playerLane != null ? snap.playerLane : 0; return L[i] || L[0] || null; }
  function other_(snap, me) { return (snap && snap.lanes || []).filter(function (l) { return l && l !== me && l.kind !== 'none'; })[0] || null; }

  /* tach: 240° sweep from idle-ish 0 to redline × 1.1; red zone from the redline; shift target tick */
  function drawTach(ctx, r, me, units, compact) {
    var cx = r.x + r.w / 2, cy = r.y + r.h / 2, R = r.w / 2;
    var red = num(me.redline, 7000), maxR = Math.ceil(red * 1.1 / 1000) * 1000, rpm = clamp(num(me.rpm, 0), 0, maxR);
    var a0 = Math.PI * 0.75, sweep = Math.PI * 1.5;
    function ang(v) { return a0 + sweep * clamp(v / maxR, 0, 1); }
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = hudFill(.78); ctx.fill(); ctx.strokeStyle = HUD.line; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.lineWidth = Math.max(4, R * 0.07);
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, ang(red), ang(maxR)); ctx.strokeStyle = 'rgba(255,60,50,.85)'; ctx.stroke();
    var opt = num(me.shiftRpm, 0);
    if (opt > 0 && !me.autoShift) { ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, ang(opt - red * 0.025), ang(opt + red * 0.025)); ctx.strokeStyle = 'rgba(93,255,122,.9)'; ctx.stroke(); }
    ctx.lineWidth = 2;
    for (var k = 0; k <= maxR; k += 1000) {
      var a = ang(k), c = Math.cos(a), s = Math.sin(a);
      ctx.beginPath(); ctx.moveTo(cx + c * R * 0.72, cy + s * R * 0.72); ctx.lineTo(cx + c * R * 0.8, cy + s * R * 0.8); ctx.strokeStyle = k >= red ? '#ff6a5a' : 'rgba(255,255,255,.7)'; ctx.stroke();
      if (!compact || k % 2000 === 0) text(ctx, String(k / 1000), cx + c * R * 0.6, cy + s * R * 0.6, Math.max(9, R * 0.1), 'rgba(255,255,255,.75)', 'center', 700);
    }
    var na = ang(rpm);
    ctx.beginPath(); ctx.moveTo(cx - Math.cos(na) * R * 0.1, cy - Math.sin(na) * R * 0.1); ctx.lineTo(cx + Math.cos(na) * R * 0.84, cy + Math.sin(na) * R * 0.84);
    ctx.strokeStyle = me.limiter ? HUD.bad : '#ffb13a'; ctx.lineWidth = Math.max(2.5, R * 0.03); ctx.lineCap = 'round'; ctx.stroke(); ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.06, 0, Math.PI * 2); ctx.fillStyle = '#ffb13a'; ctx.fill();
    var g = me.gear == null ? '—' : me.gear < 0 ? 'R' : me.gear === 0 ? 'N' : String(me.gear);
    text(ctx, g, cx, cy + R * 0.12, R * 0.42, me.limiter ? HUD.bad : '#ffffff', 'center', 900);
    var sp = num(me.speed, Math.abs(num(me.vx, 0)));
    text(ctx, String(Math.round(units === 'metric' ? sp * KPH : sp * MPH)), cx, cy + R * 0.5, R * 0.2, HUD.ink, 'center', 800, MONO);
    text(ctx, units === 'metric' ? 'KM/H' : 'MPH', cx, cy + R * 0.68, Math.max(8, R * 0.08), HUD.dim, 'center', 700);
    if (me.autoShift) text(ctx, 'AUTO', cx, cy - R * 0.32, Math.max(8, R * 0.09), HUD.dim, 'center', 800);
    else text(ctx, 'RPM ×1000', cx, cy - R * 0.32, Math.max(8, R * 0.075), HUD.faint, 'center', 700);
  }
  /* 12-LED shift-light bar: green → amber → red, all flash blue-white in the window */
  function drawLights(ctx, r, me, t) {
    var sl = me.shiftLight || {}, lvl = clamp(num(sl.level, 0), 0, 1), n = 12, gap = 3, bw = (r.w - gap * (n - 1)) / n;
    var flash = !!sl.flash && (Math.floor(t * 12) % 2 === 0);
    for (var i = 0; i < n; i++) {
      var on = lvl * n >= i + 0.5, col = i < 5 ? '#46e05a' : i < 9 ? '#ffc23a' : HUD.bad;
      if (sl.flash) { on = flash; col = '#7ec8ff'; }
      rr(ctx, r.x + i * (bw + gap), r.y, bw, r.h, Math.min(4, r.h / 3));
      ctx.fillStyle = on ? col : 'rgba(255,255,255,.08)'; ctx.fill();
      if (on) { ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 8; ctx.fill(); ctx.restore(); }
    }
  }
  /* launch-rpm gauge: rev range with the green sweet spot, the live needle */
  function drawLaunch(ctx, r, me, compact) {
    var L = me.launch || {};
    panel(ctx, r, 0.7);
    var pad = compact ? 8 : 12, bx = r.x + pad, bw = r.w - pad * 2, by = r.y + r.h * 0.55, bh = Math.max(8, r.h * 0.24);
    text(ctx, 'LAUNCH RPM', r.x + pad, r.y + r.h * 0.24, compact ? 9 : 11, HUD.dim, 'left', 800);
    if (L.ev || L.lc) {
      text(ctx, L.lc ? '2-STEP LAUNCH CONTROL' : 'EV LAUNCH MODE', r.x + r.w / 2, by + bh / 2, compact ? 11 : 15, L.held ? HUD.good : '#fff', 'center', 900);
      text(ctx, L.held ? 'ARMED' : 'HOLD BRAKE + THROTTLE', r.x + r.w - pad, r.y + r.h * 0.24, compact ? 9 : 11, L.held ? HUD.good : HUD.dim, 'right', 800);
      return;
    }
    var red = num(me.redline, 7000), rpm = clamp(num(L.held ? L.rpm : me.rpm, 0), 0, red * 1.05);
    function X(v) { return bx + bw * clamp(v / (red * 1.05), 0, 1); }
    rr(ctx, bx, by, bw, bh, bh / 2); ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fill();
    var lo = num(L.lo, 0), hi = num(L.hi, 0);
    if (hi > lo) { rr(ctx, X(lo), by, Math.max(4, X(hi) - X(lo)), bh, bh / 2); ctx.fillStyle = 'rgba(70,224,90,.75)'; ctx.fill(); }
    if (L.best > 0) { ctx.fillStyle = '#d8ffd8'; ctx.fillRect(X(L.best) - 1, by - 2, 2, bh + 4); }
    ctx.fillStyle = 'rgba(255,60,50,.6)'; ctx.fillRect(X(red), by, bx + bw - X(red), bh);
    var inBand = hi > lo && rpm >= lo && rpm <= hi;
    ctx.fillStyle = inBand ? HUD.good : '#ffb13a';
    ctx.beginPath(); ctx.moveTo(X(rpm), by - 3); ctx.lineTo(X(rpm) - 6, by - 11); ctx.lineTo(X(rpm) + 6, by - 11); ctx.closePath(); ctx.fill();
    ctx.fillRect(X(rpm) - 1.5, by - 3, 3, bh + 6);
    text(ctx, Math.round(rpm) + ' rpm' + (hi > lo ? '  ·  band ' + Math.round(lo / 100) / 10 + '–' + Math.round(hi / 100) / 10 + 'k' : ''), r.x + r.w - pad, r.y + r.h * 0.24, compact ? 9 : 11, inBand ? HUD.good : '#fff', 'right', 800, MONO);
  }
  function drawHeat(ctx, r, me, compact) {
    panel(ctx, r, 0.7);
    var T = num(me.tyreTemp, 28), pad = compact ? 8 : 12, bx = r.x + pad + (compact ? 64 : 92), bw = r.x + r.w - pad - bx, by = r.y + r.h / 2 - 4, bh = 8;
    function X(v) { return bx + bw * clamp((v - 20) / 130, 0, 1); }
    text(ctx, 'TYRES ' + Math.round(T) + '°C', r.x + pad, r.y + r.h / 2, compact ? 9 : 12, T > 110 ? HUD.bad : T >= 70 ? HUD.good : '#fff', 'left', 800);
    rr(ctx, bx, by, bw, bh, 4); ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fill();
    ctx.fillStyle = 'rgba(70,224,90,.55)'; ctx.fillRect(X(70), by, X(95) - X(70), bh);
    ctx.fillStyle = 'rgba(255,60,50,.5)'; ctx.fillRect(X(110), by, X(150) - X(110), bh);
    ctx.fillStyle = '#fff'; ctx.fillRect(X(T) - 1.5, by - 4, 3, bh + 8);
    if (me.gripBonus) text(ctx, (me.gripBonus > 0 ? '+' : '') + Math.round(me.gripBonus * 100) + '% grip', r.x + r.w - pad, r.y + 9, compact ? 8 : 10, me.gripBonus > 0 ? HUD.good : HUD.bad, 'right', 800);
  }
  /* the tree: lane 0 bulbs on the left column, lane 1 on the right (as seen from behind the line) */
  function drawTree(ctx, r, snap, compact, H) {
    var tnow = num(snap.t, 0);
    function pop(key, on) { if (!H) return 0; var m = H.bulbs || (H.bulbs = {}); if (!on) { m[key] = null; return 0; } if (m[key] == null) m[key] = tnow; return clamp(1 - (tnow - m[key]) / 0.22, 0, 1); }
    panel(ctx, r, 0.72);
    var tr = snap.tree || {}, L = tr.lanes || [], lanes = snap.lanes || [];
    if (snap.treeType === 'flag') {
      var st = tr.flag || null, cx = r.x + r.w / 2, cy = r.y + r.h * 0.42, s = r.w * 0.36;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, s * 0.12); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(cx, cy - s * 0.9, s * 0.22, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - s * 0.65); ctx.lineTo(cx, cy + s * 0.4); ctx.lineTo(cx - s * 0.35, cy + s * 1.0); ctx.moveTo(cx, cy + s * 0.4); ctx.lineTo(cx + s * 0.35, cy + s * 1.0); ctx.stroke();
      var up = st === 'ready' || st === 'up';
      ctx.beginPath(); ctx.moveTo(cx, cy - s * 0.45);
      if (up) { ctx.lineTo(cx - s * 0.6, cy - s * 1.2); ctx.moveTo(cx, cy - s * 0.45); ctx.lineTo(cx + s * 0.6, cy - s * 1.2); }
      else if (st === 'drop') { ctx.lineTo(cx - s * 0.75, cy + s * 0.05); ctx.moveTo(cx, cy - s * 0.45); ctx.lineTo(cx + s * 0.75, cy + s * 0.05); }
      else { ctx.lineTo(cx - s * 0.25, cy + s * 0.25); ctx.moveTo(cx, cy - s * 0.45); ctx.lineTo(cx + s * 0.25, cy + s * 0.25); }
      ctx.stroke(); ctx.lineCap = 'butt';
      text(ctx, st === 'drop' ? 'GO!' : st ? 'READY' : 'LINE UP', cx, r.y + r.h - (compact ? 14 : 22), compact ? 12 : 18, st === 'drop' ? HUD.good : '#ffc23a', 'center', 900);
      return;
    }
    var cols = [r.x + r.w * 0.3, r.x + r.w * 0.7], rows = 7, top = r.y + (compact ? 10 : 16), step = (r.h - (compact ? 20 : 32)) / (rows - 1), br = Math.min(step * 0.36, r.w * 0.16);
    ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(r.x + r.w / 2 - 1.5, top, 3, r.h - (compact ? 20 : 32));
    for (var i = 0; i < 2; i++) {
      var lt = L[i] || {}, ln = lanes[i] || {}, x = cols[i], none = ln.kind === 'none';
      if (none) continue;
      var sm = br * 0.6;
      var pp = pop(i + 'p', !!lt.preStage), ps = pop(i + 's', !!lt.stage);
      bulb(ctx, x - sm * 1.05, top, sm, !!lt.preStage, '#fff7d6', null, pp); bulb(ctx, x + sm * 1.05, top, sm, !!lt.preStage, '#fff7d6', null, pp);
      bulb(ctx, x - sm * 1.05, top + step, sm, !!lt.stage, '#fff7d6', null, ps); bulb(ctx, x + sm * 1.05, top + step, sm, !!lt.stage, '#fff7d6', null, ps);
      var am = lt.amber || [];
      for (var a = 0; a < 3; a++) bulb(ctx, x, top + step * (2 + a), br, !!am[a], '#ffae1a', null, pop(i + 'a' + a, !!am[a]));
      bulb(ctx, x, top + step * 5, br, !!lt.green, '#3dff5a', null, pop(i + 'g', !!lt.green));
      bulb(ctx, x, top + step * 6, br, !!lt.red, '#ff2a20', null, pop(i + 'r', !!lt.red));
    }
  }
  function shortName(n) { n = String(n || 'OPP'); var m = n.match(/["“]([^"”]+)["”]/); return (m ? m[1] : n.split(' ')[0]).slice(0, 9).toUpperCase(); }
  function splitRows(ln, other) {
    var rows = [], sp = ln.splits || [], so = other ? other.splits || [] : [];
    sp.forEach(function (s, i) { rows.push({ label: s.label, t: s.t, v: s.v, ot: so[i] ? so[i].t : null, ov: so[i] ? so[i].v : null, trap: false, kph: s.kph }); });
    return rows;
  }
  function drawSplits(ctx, r, snap, me, oth, units, compact) {
    var rows = splitRows(me, oth), rh = compact ? 15 : 22, head = compact ? 18 : 26;
    var h = head + rh * (rows.length + 1) + (compact ? 6 : 10);
    var R2 = { x: r.x, y: r.y, w: r.w, h: h };
    panel(ctx, R2, 0.66);
    var fs = compact ? 9.5 : 12.5, pad = compact ? 7 : 12, c1 = r.x + r.w * (oth ? 0.62 : 0.96), c2 = r.x + r.w - pad;
    text(ctx, (snap.distance && snap.distance.name || '').toUpperCase(), r.x + pad, r.y + head / 2 + 2, compact ? 9 : 11, HUD.dim, 'left', 800);
    text(ctx, 'YOU', c1, r.y + head / 2 + 2, compact ? 9 : 11, '#ffb13a', 'right', 800);
    if (oth) text(ctx, shortName(oth.name), c2, r.y + head / 2 + 2, compact ? 9 : 11, 'rgba(255,255,255,.7)', 'right', 800);
    var y = r.y + head + rh / 2;
    text(ctx, 'R/T', r.x + pad, y, fs, 'rgba(255,255,255,.75)', 'left', 700);
    text(ctx, me.red ? 'RED' : f3(me.rt), c1, y, fs, me.red ? HUD.bad : '#fff', 'right', 700, MONO);
    if (oth) text(ctx, oth.red ? 'RED' : f3(oth.rt), c2, y, fs, oth.red ? HUD.bad : '#fff', 'right', 700, MONO);
    rows.forEach(function (row, i) {
      var yy = y + rh * (i + 1);
      var last = i === rows.length - 1;
      text(ctx, row.label, r.x + pad, yy, fs, 'rgba(255,255,255,.75)', 'left', 700);
      var a = row.t == null ? '—' : row.t.toFixed(3) + (row.v != null && (last || /1\/8/.test(row.label)) && !compact ? ' @' + Math.round((units === 'metric' ? row.v * KPH : row.v * MPH) * 10) / 10 : '');
      text(ctx, a, c1, yy, fs, last && row.t != null ? '#ffb13a' : '#fff', 'right', last ? 800 : 700, MONO);
      if (oth) text(ctx, row.ot == null ? '—' : row.ot.toFixed(3), c2, yy, fs, HUD.ink, 'right', 700, MONO);
    });
    return R2;
  }
  function laneFrac(ln, snap) {
    var d = snap.distance || {};
    if (d.speed) return clamp(num(ln.speed, 0) / Math.max(1, num(d.toV, 55.6)), 0, 1);
    return clamp(num(ln.xFront, 0) / Math.max(1, num(d.m, 402.336)), 0, 1);
  }
  function drawProgress(ctx, r, snap, me, oth, compact) {
    panel(ctx, r, 0.6);
    var pad = compact ? 8 : 12, bx = r.x + pad, bw = r.w - pad * 2, by = r.y + r.h * 0.62, bh = compact ? 5 : 7;
    rr(ctx, bx, by, bw, bh, bh / 2); ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fill();
    var fm = laneFrac(me, snap), fo = oth ? laneFrac(oth, snap) : null;
    rr(ctx, bx, by, Math.max(bh, bw * fm), bh, bh / 2); ctx.fillStyle = '#ffb13a'; ctx.fill();
    function mark(f, col) { var x = bx + bw * f; ctx.beginPath(); ctx.arc(x, by + bh / 2, compact ? 5 : 7, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1.5; ctx.stroke(); }
    if (fo != null) mark(fo, '#9bb7ff');
    mark(fm, '#ffb13a');
    var lab = 'YOU';
    if (oth && snap.phase === 'run') {
      var d = (snap.distance && snap.distance.speed) ? null : num(me.xFront, 0) - num(oth.xFront, 0);
      if (d != null) lab = Math.abs(d) < 0.5 ? 'DEAD EVEN' : (d > 0 ? 'AHEAD ' : 'BEHIND ') + Math.abs(d).toFixed(1) + ' m';
    } else if (oth) lab = 'YOU vs ' + shortName(oth.name);
    text(ctx, lab, r.x + r.w / 2, r.y + r.h * 0.3, compact ? 9 : 12, HUD.ink, 'center', 800);
  }
  function drawPrompt(ctx, r, p, t, compact) {
    if (!p) return;
    var col = p.kind === 'good' ? HUD.good : p.kind === 'bad' ? HUD.bad : p.kind === 'warn' ? '#ffb13a' : p.kind === 'shift' ? '#7ec8ff' : '#ffffff';
    ctx.save(); ctx.globalAlpha = p.kind === 'shift' ? 0.6 + 0.4 * Math.abs(Math.sin(t * 14)) : 1;
    text(ctx, p.text, r.x + r.w / 2, r.y + r.h * 0.32, compact ? 17 : 26, col, 'center', 900);
    if (p.sub) text(ctx, p.sub, r.x + r.w / 2, r.y + r.h * 0.85, compact ? 10.5 : 14, 'rgba(255,255,255,.82)', 'center', 600);
    ctx.restore();
  }
  function drawBanner(ctx, r, title, sub, col, compact) {
    ctx.save(); rr(ctx, r.x, r.y, r.w, r.h, 14); ctx.fillStyle = hudFill(.78); ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
    text(ctx, title, r.x + r.w / 2, r.y + r.h * 0.4, compact ? 24 : 42, col, 'center', 900);
    if (sub) text(ctx, sub, r.x + r.w / 2, r.y + r.h * 0.78, compact ? 11 : 16, 'rgba(255,255,255,.85)', 'center', 600, MONO);
    ctx.restore();
  }

  /* ------------------------------------------------------------------ HUD instance */
  function create() {
    syncHud(); FONT = HUD.font; MONO = HUD.num;
    var H = { pops: [], rtFlash: null, banner: null, lastT: 0, seen: {}, ticker: [], bulbs: {} };
    function reset() { H.pops = []; H.rtFlash = null; H.banner = null; H.seen = {}; H.ticker = []; H.bulbs = {}; }
    function ingest(snap, me) {
      var pl = snap.playerLane != null ? snap.playerLane : 0;
      (snap.events || []).forEach(function (e) {
        if (!e) return;
        if (e.type === 'shift' && e.lane === pl && e.grade) H.pops.push({ t: snap.t, text: e.grade === 'perfect' ? 'PERFECT SHIFT' : String(e.grade).toUpperCase(), col: gradeColor(e.grade), sub: e.rpm ? Math.round(e.rpm) + ' rpm' : '' });
        else if (e.type === 'bog' && e.lane === pl) H.pops.push({ t: snap.t, text: 'BOG!', col: '#ffb13a', sub: 'Too few revs' });
        else if (e.type === 'wheelspin' && e.lane === pl) H.pops.push({ t: snap.t, text: 'WHEELSPIN', col: '#ffb13a', sub: 'Too many revs / cold tyres' });
        else if (e.type === 'overheat' && e.lane === pl) H.pops.push({ t: snap.t, text: 'OVERHEATED', col: HUD.bad, sub: 'Tyres too hot' });
        else if (e.type === 'win') H.banner = { t: snap.t, winner: e.winner, reason: e.reason, margin: e.margin_s };
        else if (e.type === 'red' && e.lane === pl) H.pops.push({ t: snap.t, text: 'RED LIGHT', col: HUD.bad, sub: '' });
      });
      if (me && me.rt != null && !H.rtFlash && !me.red) H.rtFlash = { t: snap.t, rt: me.rt };
      while (H.pops.length > 3) H.pops.shift();
    }
    function liveEt(snap, me) {
      if (me.et != null) return me.et;
      var g = snap.tree && snap.tree.greenT ? snap.tree.greenT[snap.playerLane || 0] : null;
      if (g == null || me.rt == null || !me.left) return null;
      return Math.max(0, num(snap.t, 0) - g - me.rt);
    }
    function highlightRect(ctx, r, t) {
      if (!r) return;
      var k = 0.5 + 0.5 * Math.sin(t * 6), pad = 6;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,210,74,' + (0.55 + 0.45 * k).toFixed(2) + ')'; ctx.lineWidth = 3; ctx.shadowColor = '#ffd24a'; ctx.shadowBlur = 10 + 10 * k;
      rr(ctx, r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, 14); ctx.stroke();
      ctx.fillStyle = '#ffd24a'; var ax = r.x + r.w / 2, ay = r.y - pad - 6 - 4 * k;
      if (ay < 14) { ay = r.y + r.h + pad + 6 + 4 * k; ctx.beginPath(); ctx.moveTo(ax, ay - 8); ctx.lineTo(ax - 8, ay + 4); ctx.lineTo(ax + 8, ay + 4); ctx.closePath(); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(ax, ay + 8); ctx.lineTo(ax - 8, ay - 4); ctx.lineTo(ax + 8, ay - 4); ctx.closePath(); ctx.fill(); }
      ctx.restore();
    }
    function draw(ctx, snap, view) {
      if (!ctx || !snap) return;
      view = view || {};
      var w = num(view.width, 800), h = num(view.height, 450), units = view.units === 'metric' ? 'metric' : 'imperial';
      var Lo = layout(w, h, { compact: view.compact, touch: view.touch, safe: view.safe }), compact = Lo.compact;
      var me = me_(snap); if (!me) return;
      var oth = other_(snap, me), t = num(snap.t, 0), pl = snap.playerLane || 0;
      if (t < H.lastT - 0.5) reset();
      H.lastT = t;
      ingest(snap, me);
      (snap.events || []).forEach(function (e) {
        if (e && e.type === 'split' && e.lane === pl && e.t != null) {
          var sp = (snap.distance && snap.distance.splits || []).filter(function (x) { return x.id === e.id; })[0];
          H.ticker.push({ t: t, label: sp ? sp.label : e.id, val: e.t, v: e.v, trap: !!(sp && (sp.id === 'eighth' || sp.id === 'quarter' || sp.id === 'half' || sp.id === 'km')) });
          while (H.ticker.length > 4) H.ticker.shift();
        }
      });
      // first person: the dash carries the tach; the HUD keeps a dash-mounted shift-light bar and a minimal readout
      var fp = !!view.cockpit;
      if (fp) {
        Lo.lights = compact ? { x: w / 2 - 110, y: h * 0.6, w: 220, h: 11 } : { x: w / 2 - 170, y: h * 0.605, w: 340, h: 16 };
        if (view.touch) Lo.lights = { x: Lo.tach.x - 8, y: Lo.tach.y + Lo.tach.h - 14, w: Lo.tach.w + 16, h: 12 };
        fpGauges(Lo, w, h, view);   // keep the launch / tyre gauges off the dash cluster
      }
      ctx.save();
      var treeOn = (snap.phase === 'burnout' || snap.phase === 'staging' || snap.phase === 'tree' || snap.phase === 'run' && t - num((snap.tree && snap.tree.greenT && snap.tree.greenT[pl]), t) < 3) && (!fp || view.showTree || snap.treeType === 'flag');
      if (treeOn) drawTree(ctx, Lo.tree, snap, compact, H);
      var spR = drawSplits(ctx, Lo.splits, snap, me, oth, units, compact);
      if (oth || snap.phase === 'run' || snap.phase === 'shutdown') drawProgress(ctx, Lo.progress, snap, me, oth, compact);
      drawLights(ctx, Lo.lights, me, t);
      if (!fp) drawTach(ctx, Lo.tach, me, units, compact);
      var pre = snap.phase === 'burnout' || snap.phase === 'staging' || snap.phase === 'tree';
      if (pre && !me.burnout && (me.staged || (me.launch && me.launch.held) || snap.phase === 'tree' || view.highlight === 'launch')) drawLaunch(ctx, Lo.launch, me, compact);
      if (snap.phase === 'burnout' || (pre && num(me.tyreTemp, 28) > 40)) drawHeat(ctx, Lo.heat, me, compact);
      if (me.nitrous && me.nitrous.shot_hp > 0 && Lo.n2o) {
        var n = me.nitrous, nr = Lo.n2o; panel(ctx, nr, 0.7);
        text(ctx, 'N2O ' + n.shot_hp, nr.x + nr.w / 2, nr.y + nr.h * 0.36, compact ? 9 : 12, n.active ? '#7ec8ff' : n.armed ? '#fff' : HUD.faint, 'center', 900);
        ctx.fillStyle = n.active ? '#7ec8ff' : 'rgba(126,200,255,.5)'; ctx.fillRect(nr.x + 6, nr.y + nr.h - 9, (nr.w - 12) * clamp(num(n.left_s, 0) / 6, 0, 1), 4);
      }
      // live ET + speed counter (and gear in first person)
      var et = liveEt(snap, me), cy = Lo.progress.y + Lo.progress.h + (compact ? 16 : 26);
      if (et != null && (snap.phase === 'run' || snap.phase === 'shutdown' || me.finished)) {
        var sp = num(me.speed, 0), spTxt = String(Math.round(units === 'metric' ? sp * KPH : sp * MPH));
        text(ctx, et.toFixed(me.finished ? 3 : 2), w / 2 - (compact ? 8 : 12), cy, compact ? 20 : 34, me.finished ? '#ffb13a' : '#ffffff', 'right', 900, MONO);
        text(ctx, spTxt, w / 2 + (compact ? 8 : 12), cy, compact ? 20 : 34, HUD.ink, 'left', 900, MONO);
        text(ctx, 'ET', w / 2 - (compact ? 8 : 12), cy + (compact ? 14 : 22), compact ? 8 : 10, HUD.dim, 'right', 800);
        text(ctx, (units === 'metric' ? 'KM/H' : 'MPH') + (fp ? '  ·  GEAR ' + (me.gear > 0 ? me.gear : 'N') : ''), w / 2 + (compact ? 8 : 12), cy + (compact ? 14 : 22), compact ? 8 : 10, HUD.dim, 'left', 800);
      } else if (fp && pre) {
        text(ctx, (me.gear > 0 ? 'GEAR ' + me.gear : 'N') + '  ·  ' + Math.round(num(me.rpm, 0)) + ' RPM', w / 2, Lo.lights.y + Lo.lights.h + (compact ? 12 : 18), compact ? 9 : 12, 'rgba(255,255,255,.8)', 'center', 800, MONO);
      }
      var bannerOn = H.banner && (snap.phase === 'shutdown' || snap.phase === 'done' || me.finished);
      if (!bannerOn && !view.noPrompt) {
        var pr = prompt(snap, me, { keys: view.keys, burnoutEnd: -14 });
        var PR = pr && snap.phase === 'run' ? { x: Lo.prompt.x, y: cy + (compact ? 26 : 40), w: Lo.prompt.w, h: Lo.prompt.h } : Lo.prompt;
        drawPrompt(ctx, PR, pr, t, compact);
      }
      // split ticker: each timing beam slides in on the right
      if (!compact) {
        H.ticker = H.ticker.filter(function (k) { return t - k.t < 3.2 && t >= k.t - 0.05; });
        H.ticker.forEach(function (k, i) {
          var age = t - k.t, slide = clamp(age / 0.22, 0, 1), out = clamp((age - 2.8) / 0.4, 0, 1);
          var bw = 280, bh = 40, x = w - num(view.safe && view.safe.r, 0) - 24 - bw + (1 - slide * slide) * (bw + 40) + out * 60, y = h * 0.3 + i * (bh + 8);
          ctx.save(); ctx.globalAlpha = 1 - out;
          rr(ctx, x, y, bw, bh, 10); ctx.fillStyle = hudFill(.78); ctx.fill(); ctx.fillStyle = '#ffb13a'; ctx.fillRect(x, y + 6, 4, bh - 12);
          text(ctx, String(k.label).toUpperCase(), x + 16, y + bh / 2, 13, 'rgba(255,255,255,.75)', 'left', 800);
          text(ctx, k.val.toFixed(3) + (k.trap && k.v ? '  ' + Math.round((units === 'metric' ? k.v * KPH : k.v * MPH) * 10) / 10 : ''), x + bw - 14, y + bh / 2, 18, HUD.ink, 'right', 900, MONO);
          ctx.restore();
        });
      }
      // reaction-time readout on the launch: "0.012 — PERFECT!"
      if (H.rtFlash && t - H.rtFlash.t < 2.4 && (snap.phase === 'run' || snap.phase === 'shutdown')) {
        var age2 = t - H.rtFlash.t, g = rtGrade(H.rtFlash.rt) || { text: '', col: '#fff' }, sc = 1 + 0.5 * Math.max(0, 1 - age2 / 0.25), fade = clamp((2.4 - age2) / 0.5, 0, 1);
        var blink = age2 < 0.9 && Math.floor(age2 * 10) % 2 === 1 ? 0.55 : 1;
        ctx.save(); ctx.globalAlpha = fade * blink;
        text(ctx, H.rtFlash.rt.toFixed(3) + ' — ' + g.text, w / 2, Lo.pop.y - (compact ? 34 : 64), (compact ? 22 : 40) * sc, g.col, 'center', 900, MONO);
        text(ctx, 'REACTION TIME', w / 2, Lo.pop.y - (compact ? 34 : 64) + (compact ? 18 : 30) * sc, compact ? 8 : 11, 'rgba(255,255,255,.7)', 'center', 800);
        ctx.restore();
      }
      // shift pop-ups
      H.pops = H.pops.filter(function (p) { return t - p.t < 1.1 && t >= p.t - 0.05; });
      H.pops.forEach(function (p, i) {
        var k = (t - p.t) / 1.1, y = Lo.pop.y + (compact ? 6 : 10) - k * 30 + i * (compact ? 26 : 40);
        ctx.save(); ctx.globalAlpha = 1 - k * k;
        text(ctx, p.text, Lo.pop.x, y, (compact ? 20 : 34) * (1 + 0.3 * Math.max(0, 0.15 - k) / 0.15), p.col, 'center', 900);
        if (p.sub) text(ctx, p.sub, Lo.pop.x, y + (compact ? 16 : 24), compact ? 9 : 12, 'rgba(255,255,255,.8)', 'center', 700, MONO);
        ctx.restore();
      });
      if (bannerOn) {
        var won = H.banner.winner === pl, solo = !oth, age3 = t - H.banner.t;
        var title = solo ? (me.red ? 'RED LIGHT' : f3(me.et)) : me.red ? 'RED LIGHT' : won ? 'WIN' : 'LOSS';
        var col = me.red ? HUD.bad : (won || solo) ? HUD.good : HUD.bad;
        var sub = (me.et != null ? 'ET ' + f3(me.et) : '') + (me.trap != null ? '  ·  ' + fmtSpeed(me.trap, units) : '') + (!solo && H.banner.margin != null && isFinite(H.banner.margin) ? '  ·  by ' + Math.abs(H.banner.margin).toFixed(3) + ' s' : '') + (H.banner.reason === 'holeshot' || snap.decision && snap.decision.holeshot && won ? '  ·  HOLESHOT' : '');
        ctx.save(); var bs = 1 + 0.3 * Math.max(0, 1 - age3 / 0.3); ctx.translate(w / 2, Lo.banner.y + Lo.banner.h / 2); ctx.scale(bs, bs); ctx.translate(-w / 2, -(Lo.banner.y + Lo.banner.h / 2));
        drawBanner(ctx, Lo.banner, title, sub, col, compact); ctx.restore();
      }
      if (view.highlight) highlightRect(ctx, view.highlight === 'lights' ? Lo.lights : view.highlight === 'tree' ? (treeOn ? Lo.tree : null) : Lo[view.highlight], t);
      if (view.fps) text(ctx, Math.round(view.fps) + ' fps', w - 10 - num(view.safe && view.safe.r, 0), h - 10, 10, HUD.dim, 'right', 700, MONO);
      ctx.restore();
      return spR;
    }
    return { draw: draw, reset: reset, popups: function () { return H.pops.slice(); }, ticker: function () { return H.ticker.slice(); }, _H: H };
  }

  CB.drag.hud = { rtGrade: rtGrade, shortName: shortName, layout: layout, fpGauges: fpGauges, touchLayout: touchLayout, prompt: prompt, fmtSpeed: fmtSpeed, gradeColor: gradeColor, create: create, roundRect: rr, laneFrac: laneFrac };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.drag.hud;
})();

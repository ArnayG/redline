/* ==========================================================================
   Redline — js/f1/f1-hud.js
   CB.f1.hud : the Formula 1 HUD and the F1 controls (docs/F1-SPEC.md §6). Drawn by race-ui's plugin.drawHud on top
   of the (trimmed) race HUD, which keeps the start lights, banners and wrong-way warnings.

     CB.f1.hud.create({ hooks, session ('practice'|'qualifying'|'race'), circuit (def), meta, playerTeam, units,
                        maxTime_s, pitCompound }) -> hud
       hud.attach(session, rootEl)        engine session (requestPit / cancelPit, geom) + #race-root (touch buttons)
       hud.draw(ctx, snap, view)          view { width, height, cockpit, paused, units }
       hud.controls()                     { drs, ersBoost, ersMode, pitCompound, box }   (also pushed to hooks.setPlayerControls)
       hud.detach()
   Widgets: steering-wheel dash (shift lights, gear, speed, DRS, ERS bar + mode, tyre temps / wear per corner, delta),
   timing tower (interval / gap, tyre, pit stops; best laps in practice / qualifying), session box (lap or time left,
   sectors purple / green / yellow), track map (DRS zones), race-control and team-radio messages, box prompt.
   Compact phone-landscape layout below 760 x 480. Controls: F = DRS, N (hold) = ERS boost, V = ERS mode, I = box this
   lap, O = pit tyre; gamepad RB DRS, LB ERS boost, Back box; touch DRS / ERS / BOX; phone wheel ITEM = DRS, NITRO = ERS.
   Pure helpers on CB.f1.hud._ for tests.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.f1 = CB.f1 || {};

(function () {
  'use strict';

  var hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined' && typeof document.createElement === 'function';
  var FONT = "'Barlow Condensed','Roboto Condensed','Arial Narrow','Helvetica Neue',system-ui,sans-serif";   // --hud-font (synced in create)
  var MONO = "ui-monospace,'SF Mono','Roboto Mono',Menlo,Consolas,monospace";   // --hud-num
  var C = { panel: 'rgba(8,10,14,0.78)', soft: 'rgba(8,10,14,0.55)', line: 'rgba(255,255,255,0.16)', ink: '#f4f5f7', dim: 'rgba(244,245,247,0.62)', faint: 'rgba(244,245,247,0.3)',
    purple: '#b64dff', green: '#22d36b', yellow: '#ffd23f', red: '#ff2e3d', blue: '#2f8bff', cyan: '#30e3ff', amber: '#ff9f1c' };
  var TYRE = { soft: ['S', '#ff2e3d'], medium: ['M', '#ffd23f'], hard: ['H', '#f4f5f7'], inter: ['I', '#22d36b'], wet: ['W', '#2f8bff'] };
  var PIT_ORDER = ['soft', 'medium', 'hard', 'inter', 'wet'];

  /* Shared HUD tokens (css/styles.css § 01 --hud-*, --mode-f1): every mode's HUD — race, drift, arcade, derby,
     Formula 1, drag — draws with the same display + numeral fonts, panel fill / edge, ink and status colours, and
     its own mode accent. The literals are the token values (Node tests, first frame); syncHud() reads the live
     tokens once. HUDs stay dark over the 3D view in both themes, so the light theme's darkened accents are skipped. */
  var HUD = {
    font: "'Barlow Condensed','Roboto Condensed','Arial Narrow','Helvetica Neue',system-ui,sans-serif",
    num: "ui-monospace,'SF Mono','Roboto Mono',Menlo,Consolas,monospace",
    panel: 'rgba(8,10,14,0.78)', panelSoft: 'rgba(8,10,14,0.55)', line: 'rgba(255,255,255,0.16)',
    ink: '#f4f5f7', dim: 'rgba(244,245,247,0.62)', faint: 'rgba(244,245,247,0.3)',
    accent: '#e7cd9a', good: '#3fdc8a', warn: '#ffb13a', bad: '#ff5a4d', mode: '#ff1e3c', radius: 10, radiusSm: 6
  };
  var HUD_VARS = { font: '--hud-font', num: '--hud-num', panel: '--hud-panel', panelSoft: '--hud-panel-soft', line: '--hud-line', ink: '--hud-ink',
    dim: '--hud-dim', faint: '--hud-faint', accent: '--hud-accent', good: '--hud-good', warn: '--hud-warn', bad: '--hud-bad', mode: '--mode-f1',
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
  function syncTheme() {
    if (hudSynced) return;
    syncHud();
    C.panel = HUD.panel; C.soft = HUD.panelSoft; C.line = HUD.line; C.ink = HUD.ink; C.dim = HUD.dim; C.faint = HUD.faint;
    FONT = HUD.font; MONO = HUD.num;
  }
  var ERS_MODES = ['auto', 'harvest', 'overtake'];

  function clamp(v, a, b) { v = +v; if (v !== v) v = a; return v < a ? a : v > b ? b : v; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }

  /* ---------------------------------------------------------------- pure helpers */
  function fmtLap(t) {
    if (!isNum(t) || t <= 0) return '-:--.---';
    var m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3);
  }
  function fmtGap(g) { return isNum(g) ? (g >= 0 ? '+' : '-') + Math.abs(g).toFixed(g < 10 ? 3 : 1) : ''; }
  function fmtClock(t) { t = Math.max(0, t); var m = Math.floor(t / 60), s = Math.floor(t - m * 60); return m + ':' + (s < 10 ? '0' : '') + s; }
  /** 'purple' (session best) | 'green' (personal best) | 'yellow' (slower) | null. */
  function sectorClass(t, pb, sb) {
    if (!isNum(t)) return null;
    if (isNum(sb) && t <= sb + 1e-4) return 'purple';
    if (!isNum(pb) || t <= pb + 1e-4) return 'green';
    return 'yellow';
  }
  function f1Of(car) { return (car && car.endurance && car.endurance.f1) || null; }
  function code(car) {
    if (car && car.isPlayer && /^(driver|you|player)(\s*\d+)?$/i.test(String(car.name || '').trim())) return 'YOU';
    var f = car && car.endurance && car.endurance.f1;
    if (f && f.short && !car.isPlayer) return String(f.short).slice(0, 3).toUpperCase();
    var n = String((car && car.name) || '').trim().split(/\s+/);
    var last = n[n.length - 1] || 'CAR';
    return last.replace(/[^A-Za-zÀ-ÿ]/g, '').slice(0, 3).toUpperCase() || 'CAR';
  }
  /** Tower rows: race order by position; timed sessions by best lap. */
  function towerRows(snap, session) {
    var cars = (snap && snap.cars || []).slice();
    if (session === 'race') cars.sort(function (a, b) { return num(a.position, 99) - num(b.position, 99); });
    else cars.sort(function (a, b) { var ta = isNum(a.bestLap_s) && a.bestLap_s > 0 ? a.bestLap_s : 1e9, tb = isNum(b.bestLap_s) && b.bestLap_s > 0 ? b.bestLap_s : 1e9; return ta - tb || num(a.position, 99) - num(b.position, 99); });
    var best = null;
    cars.forEach(function (c) { if (isNum(c.bestLap_s) && c.bestLap_s > 0 && (best === null || c.bestLap_s < best)) best = c.bestLap_s; });
    return cars.map(function (c, i) {
      var f = f1Of(c), txt;
      if (session === 'race') {
        if (c.dnf) txt = 'OUT';
        else if (i === 0) txt = 'Leader';
        else if (num(c.lapsDown, 0) > 0) txt = '+' + c.lapsDown + 'L';
        else txt = isNum(c.gapAhead_s) ? '+' + c.gapAhead_s.toFixed(1) : '';
      } else txt = isNum(c.bestLap_s) && c.bestLap_s > 0 ? (i === 0 ? fmtLap(c.bestLap_s) : '+' + (c.bestLap_s - best).toFixed(3)) : 'No time';
      return { id: c.id, pos: i + 1, code: code(c), color: c.color || '#888', isPlayer: !!c.isPlayer, text: txt,
        compound: f ? f.compound : null, pits: num(c.pitStops, 0), inPit: !!(c.pitPhase || (f && f.inPitLane)), drs: !!(f && f.drs && f.drs.open), dnf: !!c.dnf };
    });
  }
  /** Compact tower: P1..P3 + the player and the cars either side. */
  function compactRows(rows, max) {
    max = max || 6;
    var pi = -1; rows.forEach(function (r, i) { if (r.isPlayer) pi = i; });
    if (rows.length <= max) return rows;
    var keep = {}; [0, 1, 2].forEach(function (i) { keep[i] = 1; });
    if (pi >= 0) [pi - 1, pi, pi + 1].forEach(function (i) { if (i >= 0 && i < rows.length) keep[i] = 1; });
    return rows.filter(function (r, i) { return keep[i]; });
  }
  function tyreTempColor(t, compound) {
    var win = compound === 'inter' ? [45, 80] : compound === 'wet' ? [35, 70] : [85, 115];
    if (!isNum(t)) return C.faint;
    if (t < win[0] - 15) return '#2f8bff';
    if (t < win[0]) return '#30e3ff';
    if (t <= win[1]) return '#22d36b';
    if (t <= win[1] + 15) return '#ffd23f';
    return '#ff2e3d';
  }
  function cycle(list, cur, dir) { var i = list.indexOf(cur); return list[(i + (dir || 1) + list.length) % list.length]; }

  /* ---------------------------------------------------------------- drawing utils */
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  function panel(ctx, x, y, w, h, r, fill) { rr(ctx, x, y, w, h, r); ctx.fillStyle = fill || C.panel; ctx.fill(); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke(); }
  function txt(ctx, s, x, y, color, px, weight, align, fam) {
    ctx.font = (weight || 700) + ' ' + Math.round(px) + 'px ' + (fam || FONT);
    ctx.fillStyle = color; ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }
  function tyreDot(ctx, x, y, r, compound) {
    var t = TYRE[compound]; if (!t) return;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = '#111'; ctx.fill();
    ctx.lineWidth = Math.max(1.2, r * 0.32); ctx.strokeStyle = t[1]; ctx.stroke();
    txt(ctx, t[0], x, y + 0.5, t[1], r * 1.15, 800, 'center');
  }

  /* ---------------------------------------------------------------- instance */
  function create(o) {
    o = o || {};
    syncTheme();
    var session = o.session || 'race';
    var hooks = o.hooks || null;
    var ctl = { drs: false, ersBoost: false, ersMode: 'auto', pitCompound: o.pitCompound || (o.weather === 'wet' ? 'wet' : 'medium'), box: false };
    var L = { keys: {}, offs: [], touch: null, sess: null, geom: null, map: null, msgs: [], radio: null, lastMsgT: 0, phoneT: 0, startT: null,
      drsWasOpen: false, lastDrsZone: -1, destroyed: false, gpPrev: {}, lastSnapT: -1 };

    function typing(e) { var t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); }
    function onKey(e) {
      if (L.destroyed || typing(e)) return;
      var down = e.type === 'keydown', c = e.code;
      if (c === 'KeyF') { if (down && !e.repeat) toggleDrs(); e.preventDefault(); }
      else if (c === 'KeyN') { L.keys.boost = down; e.preventDefault(); }
      else if (c === 'KeyV') { if (down && !e.repeat) setErsMode(cycle(ERS_MODES, ctl.ersMode, 1)); e.preventDefault(); }
      else if (c === 'KeyI') { if (down && !e.repeat) toggleBox(); e.preventDefault(); }
      else if (c === 'KeyO') { if (down && !e.repeat) cyclePitTyre(); e.preventDefault(); }
    }
    function toggleDrs() { ctl.drs = !ctl.drs; }
    function setErsMode(m) { ctl.ersMode = m; say('radio', 'ERS mode: ' + m.toUpperCase()); }
    function cyclePitTyre() { ctl.pitCompound = cycle(PIT_ORDER, ctl.pitCompound, 1); say('radio', 'Box tyre: ' + ctl.pitCompound.toUpperCase()); pushControls(); }
    function toggleBox() {
      var S = L.sess, me = L.me;
      if (!S || session !== 'race') { say('info', 'Pit stops are for the race'); return; }
      if (me && me.pitPhase) return;
      if (me && me.pitRequested) { try { S.cancelPit('player'); } catch (e) { /* ignore */ } say('radio', 'Copy, stay out.'); return; }
      var ok = false;
      try { ok = S.requestPit('player', { tires: true, compound: ctl.pitCompound }); } catch (e2) { ok = false; }
      say('radio', ok === false ? 'Pit lane not available.' : 'Box, box. ' + ctl.pitCompound.charAt(0).toUpperCase() + ctl.pitCompound.slice(1) + 's are ready.');
    }
    function say(kind, text) {
      var m = { kind: kind, text: String(text), t: nowMs() };
      if (kind === 'radio') L.radio = m; else { L.msgs.push(m); if (L.msgs.length > 3) L.msgs.shift(); }
    }
    function pushControls() {
      if (hooks && typeof hooks.setPlayerControls === 'function') {
        try { hooks.setPlayerControls({ drs: ctl.drs, ersBoost: ctl.ersBoost, ersMode: ctl.ersMode === 'overtake' ? 'boost' : ctl.ersMode, pitCompound: ctl.pitCompound }); } catch (e) { /* ignore */ }
      }
    }
    function pollPad() {
      if (!hasDOM || !navigator.getGamepads) return {};
      var out = {}, pads;
      try { pads = navigator.getGamepads(); } catch (e) { return out; }
      for (var i = 0; pads && i < pads.length; i++) {
        var p = pads[i]; if (!p || !p.buttons) continue;
        var b = function (k) { var x = p.buttons[k]; return !!(x && (x.pressed || x.value > 0.5)); };
        out.drs = out.drs || b(5); out.boost = out.boost || b(4); out.box = out.box || b(8);
      }
      return out;
    }
    function updateInput() {
      var g = pollPad(), T = L.touch || {};
      if (g.drs && !L.gpPrev.drs) toggleDrs();
      if (g.box && !L.gpPrev.box) toggleBox();
      L.gpPrev = g;
      ctl.ersBoost = !!(L.keys.boost || g.boost || T.boost || L.keys.phoneBoost || ctl.ersMode === 'overtake');
      pushControls();
    }
    function bindDom() {
      if (!hasDOM) return;
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('keyup', onKey, true);
      var blur = function () { L.keys = {}; };
      window.addEventListener('blur', blur);
      L.offs.push(function () { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKey, true); window.removeEventListener('blur', blur); });
      var hub = CB.input && CB.input.hub;
      if (hub && typeof hub.onEvent === 'function') {
        try {
          L.offs.push(hub.onEvent(function (e) {
            if (!e) return;
            if (e.type === 'nitroOn') L.keys.phoneBoost = true;
            else if (e.type === 'nitroOff') L.keys.phoneBoost = false;
            else if (e.type === 'item' || e.type === 'itemBack') toggleDrs();
          }));
        } catch (e2) { /* ignore */ }
      }
    }
    function touchWanted() {
      if (!hasDOM) return false;
      try { var s = JSON.parse(localStorage.getItem('forge.race.settings.v1') || '{}'); if (s.touchControls === 'on') return true; if (s.touchControls === 'off') return false; } catch (e) { /* ignore */ }
      try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e2) { return false; }
    }
    function buildTouch(root) {
      if (L.touch || !root || !touchWanted()) return;
      if (!document.getElementById('f1-touch-css')) {
        var st = document.createElement('style'); st.id = 'f1-touch-css';
        st.textContent = '.f1-touch{position:absolute;right:200px;bottom:calc(min(42vh,260px) + 6px);display:flex;gap:10px;z-index:5;pointer-events:none}' +
          '.f1-touch>*{pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none;display:grid;place-items:center;width:62px;height:62px;border-radius:50%;' +
          'border:2px solid var(--hud-line,rgba(255,255,255,.16));background:var(--hud-panel-soft,rgba(8,10,14,.55));color:var(--hud-ink,#f4f5f7);font:800 13px/1 var(--hud-font,system-ui,sans-serif);letter-spacing:.08em}' +
          '.f1-touch .is-on{border-color:#22d36b;box-shadow:0 0 18px rgba(34,211,107,.7)}.f1-touch .ers.is-down{border-color:#30e3ff;box-shadow:0 0 18px rgba(48,227,255,.7)}' +
          '.f1-touch .box.is-on{border-color:#ffd23f;box-shadow:0 0 18px rgba(255,210,63,.7)}' +
          '@media (max-height:500px){.f1-touch{right:12px;bottom:146px;gap:8px}.f1-touch>*{width:46px;height:46px;font-size:11px}}';
        document.head.appendChild(st);
      }
      var wrap = document.createElement('div'); wrap.className = 'f1-touch';
      var T = L.touch = { el: wrap, boost: false };
      function btn(cls, label, onDown, onUp) {
        var b = document.createElement('div'); b.className = cls; b.setAttribute('role', 'button'); b.textContent = label;
        b.addEventListener('pointerdown', function (e) { b.classList.add('is-down'); onDown(); e.preventDefault(); e.stopPropagation(); });
        var up = function () { b.classList.remove('is-down'); if (onUp) onUp(); };
        b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
        wrap.appendChild(b); return b;
      }
      T.drsEl = btn('drs', 'DRS', toggleDrs);
      T.ersEl = btn('ers', 'ERS', function () { T.boost = true; }, function () { T.boost = false; });
      if (session === 'race') T.boxEl = btn('box', 'BOX', toggleBox);
      wrap.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      root.appendChild(wrap);
      L.offs.push(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); L.touch = null; });
    }
    function phoneStatus(f) {
      var W = CB.input && CB.input.wheel, s = null;
      if (!W || typeof W.session !== 'function') return;
      try { s = W.session(); } catch (e) { s = null; }
      if (!s || !s.rx || typeof s.rx.send !== 'function') return;
      var t = nowMs(); if (t - L.phoneT < 300) return; L.phoneT = t;
      try { s.rx.send('arcade', { on: true, nitro: f && f.ers ? clamp(f.ers.soc, 0, 1) : 0, nitroOn: !!(f && f.ers && f.ers.deploying && ctl.ersBoost), item: null, uses: 0, nitroEnabled: true }, 'fast'); } catch (e2) { /* ignore */ }
    }

    /* ---------------- messages from hooks + engine events ---------------- */
    function ingest(snap) {
      if (hooks && typeof hooks.drainMessages === 'function') {
        var ms; try { ms = hooks.drainMessages() || []; } catch (e) { ms = []; }
        ms.forEach(function (m) { if (m && m.text && (!m.carId || m.carId === 'player' || m.kind === 'flag' || m.kind === 'drs' || m.kind === 'info')) say(m.kind === 'radio' ? 'radio' : m.kind || 'info', m.text); });
      }
      (snap.events || []).forEach(function (e) {
        if (!e) return;
        if (e.type === 'penalty' && e.carId === 'player') say('penalty', e.text || 'Time penalty');
        else if (e.type === 'trackLimits' && e.carId === 'player') say('flag', e.text || 'Track limits');
        else if (e.type === 'fastestLap') say('info', 'Fastest lap · ' + (carName(snap, e.carId) || '') + (isNum(e.value) ? ' ' + fmtLap(e.value) : ''));
        else if (e.type === 'pitStop' && e.carId === 'player') say('radio', 'Good stop' + (isNum(e.value) ? ', ' + e.value.toFixed(1) + ' s' : '') + '. Push now.');
        else if (e.type === 'pitExit' && e.carId === 'player') say('radio', 'Watch the white line on exit.');
        else if (e.type === 'lap' && e.carId === 'player' && session === 'race' && snap.lapsTotal && (snap.cars.filter(function (c) { return c.isPlayer; })[0] || {}).lap === snap.lapsTotal - 1) say('radio', 'Last lap. Bring it home.');
      });
    }
    function carName(snap, id) { var c = (snap.cars || []).filter(function (x) { return x.id === id; })[0]; return c ? c.name : null; }

    /* ---------------- widgets ---------------- */
    function drawTower(ctx, snap, x, y, k, compact, maxH) {
      var rows = towerRows(snap, session);
      if (compact) rows = compactRows(rows, 6);
      var rowH = (compact ? 17 : 21) * k, w = (compact ? 128 : 186) * k, head = (compact ? 18 : 26) * k;
      var n = Math.min(rows.length, Math.floor((maxH - head) / rowH));
      if (n <= 0) return 0;
      rows = rows.slice(0, n);
      var h = head + n * rowH + 4 * k;
      panel(ctx, x, y, w, h, 6 * k);
      // header: lap / session
      var me = playerOf(snap), hdr;
      if (session === 'race') hdr = 'LAP ' + Math.min(num(snap.lapsTotal, 1), num(me && me.lap, 0) + 1) + '/' + num(snap.lapsTotal, 1);
      else hdr = (session === 'qualifying' ? 'QUALIFYING' : 'PRACTICE');
      ctx.fillStyle = '#e10600'; ctx.fillRect(x, y, 4 * k, head);
      txt(ctx, hdr, x + 10 * k, y + head / 2, C.ink, (compact ? 11 : 14) * k, 800);
      var prevPos = 0;
      rows.forEach(function (r, i) {
        var ry = y + head + i * rowH, cy = ry + rowH / 2;
        if (compact && r.pos !== prevPos + 1 && i > 0) { ctx.fillStyle = C.faint; ctx.fillRect(x + 6 * k, ry, w - 12 * k, 1); }
        prevPos = r.pos;
        if (r.isPlayer) { ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(x + 2 * k, ry + 1, w - 4 * k, rowH - 2); }
        txt(ctx, String(r.pos), x + (compact ? 13 : 16) * k, cy, C.ink, (compact ? 11 : 13) * k, 800, 'center');
        ctx.fillStyle = r.color; ctx.fillRect(x + (compact ? 23 : 29) * k, ry + 3 * k, 3 * k, rowH - 6 * k);
        txt(ctx, r.code, x + (compact ? 30 : 37) * k, cy, r.dnf ? C.faint : C.ink, (compact ? 11 : 14) * k, 700);
        var gx = x + w - (compact ? 22 : 30) * k;
        txt(ctx, r.inPit ? 'PIT' : r.text, gx - 4 * k, cy, r.inPit ? C.yellow : r.drs ? C.green : C.dim, (compact ? 10 : 12) * k, 600, 'right', MONO);
        if (r.compound) tyreDot(ctx, x + w - (compact ? 11 : 15) * k, cy, (compact ? 5 : 6.5) * k, r.compound);
        if (!compact && r.pits > 0) txt(ctx, String(r.pits), x + w - 3 * k, ry + 5 * k, C.faint, 8 * k, 700, 'right');
      });
      return h;
    }
    function playerOf(snap) { var l = snap.cars || []; for (var i = 0; i < l.length; i++) if (l[i].isPlayer) return l[i]; return null; }

    function drawSession(ctx, snap, me, x, y, w, k, compact) {
      var h = (compact ? 54 : 84) * k;
      panel(ctx, x, y, w, h, 6 * k);
      var left;
      if (session === 'race') left = 'P' + num(me.position, 1) + ' / ' + (snap.cars || []).length;
      else {
        var rem = num(o.maxTime_s, 0) > 0 ? o.maxTime_s - num(snap.t, 0) : null;
        left = rem != null ? fmtClock(rem) + ' left' : 'Free practice';
      }
      txt(ctx, left, x + 10 * k, y + 13 * k, C.ink, (compact ? 13 : 17) * k, 800);
      txt(ctx, fmtLap(me.currentLap_s), x + w - 10 * k, y + 13 * k, C.ink, (compact ? 13 : 17) * k, 700, 'right', MONO);
      // delta to best
      var d = me.deltaBest_s;
      if (isNum(d) && !compact) txt(ctx, (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2), x + w - 10 * k, y + 34 * k, d <= 0 ? C.green : C.red, 14 * k, 700, 'right', MONO);
      if (!compact) {
        txt(ctx, 'BEST ' + fmtLap(me.bestLap_s), x + 10 * k, y + 34 * k, C.dim, 12 * k, 600, 'left', MONO);
        txt(ctx, 'LAST ' + fmtLap(me.lastLap_s), x + 10 * k, y + 50 * k, C.dim, 12 * k, 600, 'left', MONO);
      }
      // sectors
      var sy = y + h - (compact ? 16 : 18) * k, sw = (w - 20 * k - 8 * k) / 3, sb = snap.sessionBestSectors || [];
      var cur = me.sectors || [], last = me.lastSectors || [], pb = me.bestSectors || [];
      for (var i = 0; i < 3; i++) {
        var t = isNum(cur[i]) ? cur[i] : (num(me.sector, 1) - 1 <= i ? null : null);
        var shown = isNum(t) ? t : (num(me.sector, 1) === 1 ? last[i] : null);
        var cls = sectorClass(shown, pb[i], sb[i]);
        var col = cls === 'purple' ? C.purple : cls === 'green' ? C.green : cls === 'yellow' ? C.yellow : 'rgba(255,255,255,0.14)';
        var sx = x + 10 * k + i * (sw + 4 * k);
        ctx.fillStyle = col; rr(ctx, sx, sy, sw, (compact ? 10 : 12) * k, 2 * k); ctx.fill();
        txt(ctx, isNum(shown) ? shown.toFixed(compact ? 1 : 3) : 'S' + (i + 1), sx + sw / 2, sy + (compact ? 5 : 6) * k + 0.5, cls ? '#0b0b0b' : C.dim, (compact ? 8.5 : 10) * k, 800, 'center', MONO);
      }
      return h;
    }

    function drawDash(ctx, snap, me, cx, by, k, compact, cockpit) {
      var f = f1Of(me) || {}, w = (compact ? 300 : 430) * k * (cockpit ? 0.82 : 1), h = (compact ? 64 : 112) * k * (cockpit ? 0.82 : 1);
      var s = cockpit ? 0.82 : 1, x = cx - w / 2, y = by - h;
      // wheel silhouette
      ctx.save();
      rr(ctx, x, y, w, h, 18 * k * s); ctx.fillStyle = 'rgba(10,11,14,0.9)'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.stroke();
      // shift lights: 15 LEDs green -> red -> blue
      var red = num(me.redline, 12500), rpm = num(me.rpm, 0), frac = clamp((rpm - red * 0.62) / (red * 0.36), 0, 1);
      var n = 15, lw = (w - 40 * k * s) / n, ly = y + (compact ? 8 : 11) * k * s, flash = rpm > red * 0.985 && (Math.floor(nowMs() / 70) % 2 === 0);
      for (var i = 0; i < n; i++) {
        var on = frac * n > i + 0.25, col = i < 5 ? C.green : i < 10 ? C.red : C.blue;
        if (flash) { on = true; col = C.blue; }
        ctx.beginPath(); ctx.arc(x + 20 * k * s + lw * (i + 0.5), ly, Math.min(lw * 0.36, 5 * k * s), 0, Math.PI * 2);
        ctx.fillStyle = on ? col : 'rgba(255,255,255,0.1)'; ctx.fill();
      }
      // gear + speed
      var units = o.units === 'mph' ? 'mph' : 'kph', sp = Math.abs(num(me.speed, 0)) * (units === 'mph' ? 2.23694 : 3.6);
      var g = me.gear, gs = g === 0 ? 'N' : g < 0 ? 'R' : String(g);
      if (me.pitLimiter) gs = 'L';
      var midY = y + h * (compact ? 0.6 : 0.52);
      txt(ctx, gs, cx, midY, me.pitLimiter ? C.yellow : C.ink, (compact ? 34 : 56) * k * s, 800, 'center');
      txt(ctx, String(Math.round(sp)), cx - (compact ? 46 : 72) * k * s, midY - (compact ? 2 : 6) * k * s, C.ink, (compact ? 22 : 32) * k * s, 800, 'right', MONO);
      txt(ctx, units === 'mph' ? 'MPH' : 'KM/H', cx - (compact ? 46 : 72) * k * s, midY + (compact ? 13 : 18) * k * s, C.dim, (compact ? 8 : 10) * k * s, 700, 'right');
      // delta
      if (isNum(me.deltaBest_s)) {
        var d = me.deltaBest_s;
        txt(ctx, (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2), cx + (compact ? 46 : 72) * k * s, midY - (compact ? 2 : 6) * k * s, d <= 0 ? C.green : C.red, (compact ? 16 : 22) * k * s, 800, 'left', MONO);
        txt(ctx, 'DELTA', cx + (compact ? 46 : 72) * k * s, midY + (compact ? 13 : 18) * k * s, C.dim, (compact ? 8 : 10) * k * s, 700, 'left');
      }
      // DRS box (left end)
      var drs = f.drs || {}, dw = (compact ? 40 : 58) * k * s, dh = (compact ? 18 : 26) * k * s, dx = x + 12 * k * s, dy = midY - dh / 2;
      var dCol = drs.open ? C.green : drs.available || drs.eligible ? 'rgba(34,211,107,0.35)' : 'rgba(255,255,255,0.08)';
      rr(ctx, dx, dy, dw, dh, 4 * k * s); ctx.fillStyle = dCol; ctx.fill();
      if ((drs.available || drs.eligible) && !drs.open) { ctx.strokeStyle = C.green; ctx.lineWidth = 1.5; ctx.stroke(); }
      txt(ctx, 'DRS', dx + dw / 2, dy + dh / 2 + 0.5, drs.open ? '#04140a' : drs.available || drs.eligible ? C.green : C.faint, (compact ? 11 : 15) * k * s, 800, 'center');
      // ERS (right end)
      var ers = f.ers || {}, ew = (compact ? 44 : 64) * k * s, ex = x + w - 12 * k * s - ew, eh = (compact ? 8 : 10) * k * s, ey = midY - eh / 2 - (compact ? 2 : 4) * k * s;
      rr(ctx, ex, ey, ew, eh, 2 * k); ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fill();
      var soc = clamp(num(ers.soc, 0), 0, 1);
      rr(ctx, ex, ey, Math.max(2, ew * soc), eh, 2 * k); ctx.fillStyle = ers.deploying ? C.cyan : ers.harvesting ? C.amber : '#7fb8ff'; ctx.fill();
      var mode = ctl.ersMode === 'overtake' || ctl.ersBoost ? 'BOOST' : (ers.mode || ctl.ersMode || 'auto').toUpperCase();
      txt(ctx, 'ERS ' + mode, ex + ew / 2, ey + eh + (compact ? 8 : 10) * k * s, ctl.ersBoost ? C.cyan : C.dim, (compact ? 8 : 10) * k * s, 800, 'center');
      // tyres (bottom row): 4 corners + compound + wear
      if (!compact || h > 50) {
        var tw = (compact ? 9 : 12) * k * s, th = (compact ? 13 : 18) * k * s, tx0 = cx - (compact ? 26 : 34) * k * s, ty0 = y + h - (compact ? 30 : 42) * k * s;
        var temps = f.tyreTemp || [], wear = f.tyreWear || [];
        if (!compact) {
          for (var c2 = 0; c2 < 4; c2++) {
            var col2 = c2 & 1, row = c2 >> 1;
            var px = tx0 + (col2 ? (compact ? 40 : 56) * k * s : 0), py = ty0 + row * (th + 4 * k * s);
            rr(ctx, px, py, tw, th, 2 * k); ctx.fillStyle = tyreTempColor(temps[c2], f.compound); ctx.fill();
            var wv = clamp(num(wear[c2], 0), 0, 1);
            txt(ctx, Math.round((1 - wv) * 100) + '', px + (col2 ? tw + 4 * k : -4 * k), py + th / 2, wv > 0.7 ? C.red : C.dim, 9 * k * s, 700, col2 ? 'left' : 'right', MONO);
          }
          if (f.compound) tyreDot(ctx, cx + (compact ? 6 : 8) * k * s, ty0 + th + 2 * k * s, 8 * k * s, f.compound);
        }
      }
      ctx.restore();
      return { x: x, y: y, w: w, h: h };
    }

    function buildMap() {
      var g = L.geom;
      if (!g || !Array.isArray(g.samples) || g.samples.length < 10) return null;
      var pts = [], step = Math.max(1, Math.floor(g.samples.length / 260));
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (var i = 0; i < g.samples.length; i += step) {
        var p = g.samples[i]; pts.push([p.x, p.y, num(p.s, 0)]);
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      var drs = [];
      try {
        var M = o.meta || (CB.f1.circuits && CB.f1.circuits.meta && o.circuit ? CB.f1.circuits.meta(o.circuit) : null);
        if (M && Array.isArray(M.drs)) drs = M.drs;
      } catch (e) { drs = []; }
      return { pts: pts, minX: minX, maxX: maxX, minY: minY, maxY: maxY, drs: drs, L: num(g.length, 1) };
    }
    function drawMap(ctx, snap, x, y, w, h, k) {
      if (!L.map) L.map = buildMap();
      var M = L.map; if (!M) return;
      panel(ctx, x, y, w, h, 6 * k, C.soft);
      var pad = 10 * k, sc = Math.min((w - pad * 2) / (M.maxX - M.minX || 1), (h - pad * 2) / (M.maxY - M.minY || 1));
      var ox = x + (w - (M.maxX - M.minX) * sc) / 2, oy = y + (h + (M.maxY - M.minY) * sc) / 2;
      function P(px, py) { return [ox + (px - M.minX) * sc, oy - (py - M.minY) * sc]; }
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      M.pts.forEach(function (p, i) { var q = P(p[0], p[1]); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
      ctx.closePath(); ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 3 * k; ctx.stroke();
      // DRS zones
      ctx.strokeStyle = C.green; ctx.lineWidth = 3.4 * k;
      M.drs.forEach(function (z) {
        if (!isNum(z.start_s) || !isNum(z.end_s)) return;
        ctx.beginPath(); var first = true;
        M.pts.forEach(function (p) {
          var s = p[2], inZ = z.end_s >= z.start_s ? (s >= z.start_s && s <= z.end_s) : (s >= z.start_s || s <= z.end_s);
          if (!inZ) { first = true; return; }
          var q = P(p[0], p[1]); if (first) { ctx.moveTo(q[0], q[1]); first = false; } else ctx.lineTo(q[0], q[1]);
        });
        ctx.stroke();
      });
      // start line
      var s0 = P(M.pts[0][0], M.pts[0][1]); ctx.fillStyle = '#fff'; ctx.fillRect(s0[0] - 2 * k, s0[1] - 2 * k, 4 * k, 4 * k);
      var me = null;
      (snap.cars || []).forEach(function (c) {
        if (c.isPlayer) { me = c; return; }
        var q = P(c.x, c.y); ctx.beginPath(); ctx.arc(q[0], q[1], 3 * k, 0, Math.PI * 2); ctx.fillStyle = c.color || '#999'; ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
      });
      if (me) { var q2 = P(me.x, me.y); ctx.beginPath(); ctx.arc(q2[0], q2[1], 5 * k, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2.5 * k; ctx.strokeStyle = me.color || '#e10600'; ctx.stroke(); }
    }
    function drawMessages(ctx, W, H, k, compact, topY) {
      var t = nowMs();
      L.msgs = L.msgs.filter(function (m) { return t - m.t < 5200; });
      var y = topY;
      L.msgs.forEach(function (m) {
        var col = m.kind === 'penalty' ? C.red : m.kind === 'flag' ? C.yellow : m.kind === 'drs' ? C.green : '#e10600';
        var label = m.kind === 'penalty' ? 'PENALTY' : m.kind === 'flag' ? 'TRACK LIMITS' : m.kind === 'drs' ? 'DRS' : 'RACE CONTROL';
        ctx.font = '700 ' + Math.round((compact ? 11 : 14) * k) + 'px ' + FONT;
        var tw = ctx.measureText(m.text).width, lw = (compact ? 74 : 104) * k, w = Math.min(W * 0.8, tw + lw + 24 * k), h = (compact ? 20 : 28) * k, x = W / 2 - w / 2;
        var a = clamp((5200 - (t - m.t)) / 400, 0, 1);
        ctx.globalAlpha = a;
        panel(ctx, x, y, w, h, 4 * k);
        ctx.fillStyle = col; ctx.fillRect(x, y, lw, h);
        txt(ctx, label, x + lw / 2, y + h / 2, m.kind === 'flag' || m.kind === 'drs' ? '#111' : '#fff', (compact ? 9 : 12) * k, 800, 'center');
        txt(ctx, m.text, x + lw + 10 * k, y + h / 2, C.ink, (compact ? 11 : 14) * k, 700);
        ctx.globalAlpha = 1;
        y += h + 4 * k;
      });
    }
    function drawRadio(ctx, x, y, k, compact, teamColor, centerW) {
      var m = L.radio; if (!m) return;
      var age = nowMs() - m.t; if (age > 5000) { L.radio = null; return; }
      ctx.globalAlpha = clamp((5000 - age) / 400, 0, 1);
      ctx.font = '700 ' + Math.round((compact ? 11 : 14) * k) + 'px ' + FONT;
      var w = ctx.measureText(m.text).width + (compact ? 70 : 92) * k, h = (compact ? 22 : 30) * k;
      if (centerW) x = centerW / 2 - w / 2;   // phones: centred above the dash, clear of the steering pad
      panel(ctx, x, y - h, w, h, 5 * k);
      ctx.fillStyle = teamColor || '#e10600'; ctx.fillRect(x, y - h, 5 * k, h);
      txt(ctx, 'RADIO', x + 12 * k, y - h / 2, teamColor && teamColor !== '#0c0c0d' ? teamColor : C.ink, (compact ? 9 : 12) * k, 800);
      txt(ctx, m.text, x + (compact ? 54 : 70) * k, y - h / 2, C.ink, (compact ? 11 : 14) * k, 700);
      ctx.globalAlpha = 1;
    }
    function drawPitPrompt(ctx, me, W, y, k, compact) {
      var f = f1Of(me) || {}, label = null, col = C.yellow;
      if (me.pitPhase === 'stopped') label = 'PIT STOP · ' + (ctl.pitCompound || '').toUpperCase();
      else if (me.pitLimiter || me.pitPhase) label = 'PIT LIMITER';
      else if (me.pitRequested) { label = 'BOX THIS LAP · ' + (ctl.pitCompound || '').toUpperCase(); col = C.amber; }
      else if (session === 'race' && f.pitWindow) label = 'PIT WINDOW OPEN · I to box';
      if (!label) return;
      var h = (compact ? 20 : 28) * k, w = (compact ? 180 : 260) * k;
      panel(ctx, W / 2 - w / 2, y, w, h, 4 * k, 'rgba(20,16,4,0.88)');
      ctx.strokeStyle = col; ctx.lineWidth = 2; rr(ctx, W / 2 - w / 2, y, w, h, 4 * k); ctx.stroke();
      txt(ctx, label, W / 2, y + h / 2, col, (compact ? 11 : 15) * k, 800, 'center');
    }

    function draw(ctx, snap, view) {
      if (L.destroyed || !ctx || !snap) return;
      view = view || {};
      var W = num(view.width, 1280), H = num(view.height, 720);
      var me = playerOf(snap); L.me = me;
      if (!view.paused) updateInput();
      if (snap.t !== L.lastSnapT) { L.lastSnapT = snap.t; ingest(snap); }
      if (!me) return;
      var f = f1Of(me);
      // DRS request is a one-shot toggle per zone: drop it once the flap closed again (end of zone, braking)
      if (f && f.drs) {
        if (f.drs.open) L.drsWasOpen = true;
        else if (L.drsWasOpen) { L.drsWasOpen = false; ctl.drs = false; }
        if (!f.drs.available && !f.drs.eligible && !f.drs.open && ctl.drs && f.drs.zone < 0) ctl.drs = false;
      }
      phoneStatus(f);
      if (L.touch) {
        if (L.touch.drsEl) L.touch.drsEl.classList.toggle('is-on', !!(f && f.drs && (f.drs.open || f.drs.available)));
        if (L.touch.boxEl) L.touch.boxEl.classList.toggle('is-on', !!me.pitRequested);
      }
      var compact = W < 760 || H < 480;
      var k = compact ? clamp(Math.min(W / 640, H / 380), 0.7, 1.1) : clamp(Math.min(W / 1366, H / 800) * 1.06, 0.72, 1.6);
      var M = (compact ? 8 : 18) * k;
      ctx.save();
      var towerH = drawTower(ctx, snap, M, M, k, compact, compact ? H * 0.62 : H * 0.72);
      var sw = (compact ? 168 : 250) * k;
      var sh = drawSession(ctx, snap, me, W - M - sw, M, sw, k, compact);
      var dash = drawDash(ctx, snap, me, W / 2, H - M - (compact ? 4 : 0) * k, k, compact, !!view.cockpit);
      if (!compact) {
        var mw = 220 * k, mh = 170 * k;
        if (M + towerH + 10 * k < H - M - mh) drawMap(ctx, snap, M, H - M - mh, mw, mh, k);
        else drawMap(ctx, snap, W - M - mw, M + sh + 10 * k, mw, mh, k);
      }
      drawPitPrompt(ctx, me, W, dash.y - (compact ? 54 : 38) * k, k, compact);
      drawMessages(ctx, W, H, k, compact, compact ? M + 4 * k : M + 70 * k);
      drawRadio(ctx, compact ? M : M + 240 * k, compact ? dash.y - 4 * k : H - M, k, compact, teamColor(me), compact ? W : 0);
      ctx.restore();
    }
    function teamColor(me) { return me && me.color || '#e10600'; }

    var api = {
      attach: function (sess, root) {
        L.sess = sess || null;
        L.geom = sess && sess.geom || null; L.map = null;
        if (!L.bound) { L.bound = true; bindDom(); }
        if (root) buildTouch(root);
        if (session === 'race' && L.startSaid !== true) { L.startSaid = true; say('radio', 'Radio check. Good luck out there.'); }
      },
      draw: function (ctx, snap, view) { try { draw(ctx, snap, view); } catch (e) { if (!L.err && typeof console !== 'undefined') { L.err = true; console.error('[f1.hud]', e); } } },
      controls: function () { return Object.assign({}, ctl); },
      setControls: function (c) { if (c) Object.assign(ctl, c); pushControls(); },
      say: say,
      toggleBox: toggleBox, toggleDrs: toggleDrs,
      detach: function () { L.destroyed = true; L.offs.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); L.offs = []; },
      _state: L
    };
    return api;
  }

  CB.f1.hud = {
    create: create,
    _: { fmtLap: fmtLap, fmtGap: fmtGap, fmtClock: fmtClock, sectorClass: sectorClass, towerRows: towerRows, compactRows: compactRows, tyreTempColor: tyreTempColor, code: code }
  };
})();

if (typeof module !== 'undefined') module.exports = CB.f1.hud;

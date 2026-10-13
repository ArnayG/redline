/* ==========================================================================
   FORGE — js/input/mouse-steer.js
   CB.input.mouse : "Mouse / trackpad wheel". Click the track to capture the mouse (Pointer Lock); horizontal mouse
   movement turns a virtual steering wheel (proportional, no network, read on the very next physics step). Esc
   releases the mouse (and pauses). Without Pointer Lock (unsupported / refused) the wheel follows the cursor's
   horizontal position across the screen instead.

   Core (pure, Node-tested):
     M.createWheel(prefs) -> W
       W.move(dx, tMs)              add raw mouse counts (movementX) to the wheel: full lock = LOCK_COUNTS / sensitivity
       W.absolute(x, width, tMs)    absolute mode: cursor at the left / right edge = full lock (x sensitivity)
       W.read(tMs) -> steer [-1, 1] (+1 = right) after the self-centring spring and the dead zone
       W.angle (raw wheel, -1..1)   W.centre()   W.setPrefs(p)
     Self-centring spring: the wheel decays toward centre at centering x SPRING per second (0 = it stays where you
     leave it, like a real wheel with no force feedback).
     M.normPrefs(p)   prefs: sensitivity (0.2..4, 1), centering (0..1, 0.15), deadzone (0..0.25, 0.02), invert,
                      buttons 'off' (default) | 'pedals' (left = throttle, right = brake, wheel click = nitro in Arcade
                      / handbrake in Drift, back side button = item), mode 'lock' (default) | 'absolute'
                      localStorage 'forge.mouseSteer.v1'
   Browser:
     M.enable() / M.disable() / M.enabled()   the 'mouse' CB.input.hub source (priority 7) + listeners
     M.capture() (from a click) / M.release() / M.locked()     M.stats() -> {locked, absolute, steer, latencyMs, avgMs}
   Steering source picker entry: CB.input.sources 'mouse'.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.input = CB.input || {};

(function () {
  'use strict';
  var PREF_KEY = 'forge.mouseSteer.v1';
  var LOCK_COUNTS = 600;   // movementX counts from centre to full lock at sensitivity 1 (~ a 6 cm flick at 800 dpi)
  var SPRING = 6;          // 1/s at centering 1
  var DEFAULT_PREFS = { sensitivity: 1, centering: 0.15, deadzone: 0.02, invert: false, buttons: 'off', mode: 'lock' };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { v = +v; return isFinite(v) ? v : d; }
  function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }

  function normPrefs(p) {
    p = p && typeof p === 'object' ? p : {};
    return {
      sensitivity: clamp(num(p.sensitivity, DEFAULT_PREFS.sensitivity), 0.2, 4),
      centering: clamp(num(p.centering, DEFAULT_PREFS.centering), 0, 1),
      deadzone: clamp(num(p.deadzone, DEFAULT_PREFS.deadzone), 0, 0.25),
      invert: !!p.invert,
      buttons: p.buttons === 'pedals' ? 'pedals' : 'off',
      mode: p.mode === 'absolute' ? 'absolute' : 'lock'
    };
  }
  function loadPrefs() {
    try { var s = globalThis.localStorage && globalThis.localStorage.getItem(PREF_KEY); if (s) return normPrefs(JSON.parse(s)); } catch (e) { /* ignore */ }
    return normPrefs(DEFAULT_PREFS);
  }
  function savePrefs(p) { try { if (globalThis.localStorage) globalThis.localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ } }

  /** Dead zone around centre, rescaled so full lock is still 1. */
  function shape(a, dz) {
    var m = Math.abs(a);
    if (m <= dz) return 0;
    return (a < 0 ? -1 : 1) * clamp((m - dz) / (1 - dz), 0, 1);
  }

  function createWheel(prefs) {
    var W = { angle: 0, lastT: null, prefs: normPrefs(prefs), absoluteMode: false };
    function advance(t) {
      t = num(t, nowMs());
      if (W.lastT != null && !W.absoluteMode && W.prefs.centering > 0) {
        var dt = clamp((t - W.lastT) / 1000, 0, 0.25);
        W.angle *= Math.exp(-W.prefs.centering * SPRING * dt);
      }
      W.lastT = t;
    }
    W.move = function (dx, t) {
      advance(t);
      W.absoluteMode = false;
      W.angle = clamp(W.angle + num(dx, 0) * W.prefs.sensitivity / LOCK_COUNTS * (W.prefs.invert ? -1 : 1), -1, 1);
      return W.angle;
    };
    W.absolute = function (x, width, t) {
      W.lastT = num(t, nowMs());
      W.absoluteMode = true;
      var w = Math.max(1, num(width, 1));
      W.angle = clamp((clamp(num(x, w / 2), 0, w) / w * 2 - 1) * W.prefs.sensitivity * (W.prefs.invert ? -1 : 1), -1, 1);
      return W.angle;
    };
    W.read = function (t) { advance(t); return shape(W.angle, W.prefs.deadzone); };
    W.centre = function () { W.angle = 0; };
    W.setPrefs = function (p) { W.prefs = normPrefs(Object.assign({}, W.prefs, p || {})); };
    return W;
  }

  var M = {
    LOCK_COUNTS: LOCK_COUNTS, SPRING: SPRING, DEFAULT_PREFS: DEFAULT_PREFS,
    normPrefs: normPrefs, createWheel: createWheel, shape: shape,
    prefs: loadPrefs()
  };
  M.setPrefs = function (p) {
    M.prefs = normPrefs(Object.assign({}, M.prefs, p || {}));
    savePrefs(M.prefs);
    if (B.wheel) B.wheel.setPrefs(M.prefs);
    return M.prefs;
  };

  /* ================================================================ browser binding */
  var hasDOM = typeof document !== 'undefined' && typeof window !== 'undefined';
  var B = {
    on: false, wheel: null, unreg: null, locked: false, lockFailed: false, releasing: false, lastMoveT: 0,
    btn: { l: false, r: false, m: false }, evT: 0, evPending: false, lat: [], lastLat: null, raf: 0, hud: null, lockShownT: 0
  };
  function H() { return CB.input.hub; }
  function SS() { return CB.input.sources; }
  function toast(t, k) { var u = CB.input.ui; if (u && u.toast) u.toast(t, k); }
  function hubStatus() { var h = H(); return h && h.status ? h.status() : {}; }
  function drivingNow() { var s = hubStatus(); return !!(s.driving && !s.paused); }
  function lockSupported() { return hasDOM && typeof Element !== 'undefined' && typeof Element.prototype.requestPointerLock === 'function'; }
  function absoluteNow() { return M.prefs.mode === 'absolute' || B.lockFailed || !lockSupported(); }
  function target() { return document.getElementById('race-root') || document.body; }

  function setButtons(l, r, m) {
    var mPrev = B.btn.m;
    B.btn.l = !!l; B.btn.r = !!r; B.btn.m = !!m;
    var h = H();
    if (h && m !== mPrev) h.pushEvent(m ? 'nitroOn' : 'nitroOff', 'mouse');
  }
  function clearButtons() { setButtons(false, false, false); }

  function source() {
    return {
      read: function (now) {
        if (!B.on || !B.wheel) return null;
        var abs = absoluteNow();
        if (!B.locked && !(abs && B.lastMoveT)) return null;
        var t = num(now, nowMs()), steer = B.wheel.read(t);
        if (B.evPending) {   // latency: input event -> the first physics step that reads it
          B.evPending = false;
          var l = nowMs() - B.evT;
          if (l >= 0 && l < 1000) { B.lastLat = l; B.lat.push(l); if (B.lat.length > 120) B.lat.shift(); }
        }
        var pedals = M.prefs.buttons === 'pedals' && (B.locked || abs);
        return {
          active: true, steer: steer,
          throttle: pedals && B.btn.l ? 1 : 0, brake: pedals && B.btn.r ? 1 : 0,
          handbrake: !!(pedals && B.btn.m && hubStatus().screen === 'drift')
        };
      }
    };
  }

  function onMove(e) {
    if (!B.on || !B.wheel) return;
    var t = e.timeStamp > 0 && e.timeStamp < 1e12 ? e.timeStamp : nowMs();
    if (B.locked) {
      var dx = num(e.movementX, 0);
      if (!dx) return;
      B.wheel.move(dx, t);
    } else if (absoluteNow() && drivingNow()) {
      B.wheel.absolute(e.clientX, window.innerWidth || 1, t);
      B.lastMoveT = t;
    } else return;
    B.evT = t; B.evPending = true;
  }
  function interactive(el) { return !!(el && el.closest && el.closest('button,a,input,select,textarea,label,[role=button],[role=dialog],.rx-modal,.pw-overlay,.rx-pause')); }
  function onDown(e) {
    if (!B.on) return;
    if (!B.locked) {
      if (!drivingNow() || interactive(e.target) || absoluteNow()) {
        if (absoluteNow() && drivingNow() && !interactive(e.target)) { mouseButtons(e, true); }
        return;
      }
      var root = document.getElementById('race-root');
      if (!root || !root.contains(e.target)) return;
      if (e.button === 0) { e.preventDefault(); M.capture(); }
      return;
    }
    mouseButtons(e, true);
    e.preventDefault();
  }
  function mouseButtons(e, down) {
    if (M.prefs.buttons !== 'pedals') return;
    var b = e.button;
    var l = B.btn.l, r = B.btn.r, m = B.btn.m;
    if (b === 0) l = down; else if (b === 2) r = down; else if (b === 1) m = down;
    else if (b === 3 && down) { var h = H(); if (h) h.pushEvent('item', 'mouse'); }
    setButtons(l, r, m);
  }
  function onUp(e) { if (B.on && (B.locked || absoluteNow())) mouseButtons(e, false); }
  function onContext(e) { if (B.on && (B.locked || (absoluteNow() && drivingNow()))) e.preventDefault(); }
  function onAux(e) { if (B.on && B.locked) e.preventDefault(); }   // no middle-click autoscroll / back navigation

  function onLockChange() {
    var was = B.locked;
    B.locked = !!(document.pointerLockElement && B.on);
    if (B.locked) { B.lockShownT = nowMs(); B.lockFailed = false; return; }
    clearButtons();
    if (was && !B.releasing && B.on) {
      // Esc / tab switch / focus loss while driving: pause (unless the game already paused on the same Esc)
      setTimeout(function () {
        var s = hubStatus();
        if (s.driving && !s.paused) { var h = H(); if (h) h.pushEvent('pause', 'mouse'); }
      }, 120);
    }
    B.releasing = false;
  }
  function onLockError() {
    B.locked = false;
    if (!B.lockFailed) toast('Pointer lock unavailable: steering follows the cursor across the screen instead.', 'bad');
    B.lockFailed = true;
  }

  M.capture = function () {
    if (!hasDOM || !B.on || B.locked) return;
    if (!lockSupported()) { B.lockFailed = true; return; }
    var t = target();
    try {
      var p = t.requestPointerLock({ unadjustedMovement: true });   // raw counts, no OS acceleration (Chrome / Edge)
      if (p && typeof p.catch === 'function') {
        p.catch(function (err) {
          if (err && err.name === 'NotSupportedError') {
            try { var p2 = t.requestPointerLock(); if (p2 && p2.catch) p2.catch(function () { onLockError(); }); } catch (e2) { onLockError(); }
          }
        });
      }
    } catch (e) { try { t.requestPointerLock(); } catch (e3) { onLockError(); } }
  };
  M.release = function () {
    if (!hasDOM) return;
    clearButtons();
    if (document.pointerLockElement) { B.releasing = true; try { document.exitPointerLock(); } catch (e) { /* ignore */ } }
  };
  M.locked = function () { return B.locked; };
  M.enabled = function () { return B.on; };
  M.recentre = function () { if (B.wheel) B.wheel.centre(); };
  M.stats = function () {
    var a = B.lat, avg = a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null;
    return { on: B.on, locked: B.locked, absolute: absoluteNow(), steer: B.wheel ? B.wheel.read(nowMs()) : 0, angle: B.wheel ? B.wheel.angle : 0, latencyMs: B.lastLat, avgMs: avg, samples: a.length };
  };

  function hudLoop() {
    B.raf = 0;
    if (!B.on) { if (B.hud) B.hud.hide(); return; }
    var s = hubStatus();
    if (s.driving && !s.paused) {
      var abs = absoluteNow(), st = B.wheel ? B.wheel.read(nowMs()) : 0;
      var hint = B.locked ? (nowMs() - B.lockShownT < 2500 ? 'Mouse steering on · Esc releases the mouse' : '')
        : abs ? (B.lastMoveT ? '' : 'Move the mouse left / right to steer') : 'Click the track to steer with the mouse';
      if (!B.hud) B.hud = SS() && SS().hud ? SS().hud('mouse') : null;
      if (B.hud) B.hud.show(st, B.locked || (abs && B.lastMoveT) ? 'Mouse wheel ' + (st >= 0 ? '+' : '') + Math.round(st * 100) + '%' : 'Mouse wheel', hint);
    } else {
      if (B.hud) B.hud.hide();
      if (B.locked) M.release();
      if (!s.driving) B.lastMoveT = 0;
    }
    B.raf = requestAnimationFrame(hudLoop);
  }

  M.enable = function () {
    if (!hasDOM) return { ok: false, reason: 'no-dom' };
    if (B.on) return { ok: true };
    B.on = true;
    B.wheel = createWheel(M.prefs);
    var h = H();
    if (h && !B.unreg) B.unreg = h.register('mouse', source(), 7);
    document.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('contextmenu', onContext, true);
    document.addEventListener('auxclick', onAux, true);
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('pointerlockerror', onLockError);
    if (!B.raf) B.raf = requestAnimationFrame(hudLoop);
    return { ok: true };
  };
  M.disable = function () {
    if (!B.on) return;
    M.release();
    B.on = false; B.locked = false; B.lastMoveT = 0;
    if (B.unreg) { B.unreg(); B.unreg = null; }
    document.removeEventListener('mousemove', onMove, { passive: true });
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('mouseup', onUp, true);
    document.removeEventListener('contextmenu', onContext, true);
    document.removeEventListener('auxclick', onAux, true);
    document.removeEventListener('pointerlockchange', onLockChange);
    document.removeEventListener('pointerlockerror', onLockError);
    if (B.hud) B.hud.hide();
  };
  if (hasDOM) {
    document.addEventListener('cb:driving', function (e) { if (!(e && e.detail && e.detail.driving)) { M.release(); B.lastMoveT = 0; } });
    window.addEventListener('blur', function () { clearButtons(); });
  }

  /* ---------------------------------------------------------------- steering-source picker entry */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function rangeRow(label, key, min, max, step, val, fmt) {
    return '<label class="ss-row"><span>' + esc(label) + '</span><input type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '" data-ms-pref="' + key + '" data-fmt="' + fmt + '"><b>' + fmtVal(val, fmt) + '</b></label>';
  }
  function fmtVal(v, f) { v = +v; return f === 'x' ? v.toFixed(2) + '×' : f === 'pct' ? Math.round(v * 100) + '%' : String(v); }
  function seg(key, cur, opts) {
    return '<div class="ss-chipseg">' + opts.map(function (o) { return '<button type="button" data-ms-seg="' + key + '" data-v="' + o[0] + '" class="' + (String(cur) === String(o[0]) ? 'is-on' : '') + '">' + esc(o[1]) + '</button>'; }).join('') + '</div>';
  }
  function detailHTML() {
    var p = M.prefs;
    return '<div class="ss-hint">Click the track to capture the mouse, move it left / right to turn the wheel, <b>Esc</b> releases it (and pauses). ' +
      (lockSupported() ? '' : '<b>This browser has no Pointer Lock: the wheel follows the cursor position.</b>') + '</div>' +
      rangeRow('Sensitivity', 'sensitivity', 0.2, 4, 0.05, p.sensitivity, 'x') +
      rangeRow('Self-centring', 'centering', 0, 1, 0.05, p.centering, 'pct') +
      rangeRow('Dead zone', 'deadzone', 0, 0.25, 0.01, p.deadzone, 'pct') +
      '<div class="ss-row"><span>Mode</span>' + seg('mode', p.mode, [['lock', 'Capture (Pointer Lock)'], ['absolute', 'Cursor position']]) + '</div>' +
      '<div class="ss-row"><span>Mouse buttons</span>' + seg('buttons', p.buttons, [['off', 'Off'], ['pedals', 'Left gas · right brake · wheel nitro']]) + '</div>' +
      '<div class="ss-row"><span>Invert</span>' + seg('invert', p.invert ? '1' : '0', [['0', 'Normal'], ['1', 'Inverted']]) + '</div>';
  }
  function bindDetail(host) {
    if (!host) return;
    host.addEventListener('input', function (e) {
      var k = e.target && e.target.getAttribute('data-ms-pref');
      if (!k) return;
      var o = {}; o[k] = +e.target.value; M.setPrefs(o);
      if (e.target.nextSibling) e.target.nextSibling.textContent = fmtVal(e.target.value, e.target.getAttribute('data-fmt'));
    });
    host.addEventListener('click', function (e) {
      var b = e.target && e.target.closest && e.target.closest('[data-ms-seg]');
      if (!b) return;
      var k = b.getAttribute('data-ms-seg'), v = b.getAttribute('data-v'), o = {};
      o[k] = k === 'invert' ? v === '1' : v; M.setPrefs(o);
      Array.prototype.forEach.call(b.parentNode.children, function (c) { c.classList.toggle('is-on', c === b); });
    });
  }
  function defineSource() {
    var S = SS();
    if (!S || !S.define) return;
    S.define('mouse', {
      name: 'Mouse / trackpad wheel', short: 'Mouse',
      hint: 'Steer with horizontal mouse or trackpad movement: proportional, read on the next physics step (no network).',
      available: function () { return hasDOM && !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches) ? { ok: true } : { ok: false, reason: 'No mouse on this device' }; },
      enable: function () { return M.enable(); }, disable: M.disable, isOn: function () { return B.on; },
      detailHTML: detailHTML, bindDetail: bindDetail,
      status: function () {
        if (!B.on) return null;
        var st = M.stats();
        return st.locked ? { cls: 'ok', text: 'Mouse captured · ' + (st.steer >= 0 ? '+' : '') + Math.round(st.steer * 100) + '%' + (st.avgMs != null ? ' · ' + st.avgMs.toFixed(1) + ' ms to the car' : '') }
          : st.absolute ? { cls: 'ok', text: 'Following the cursor position (no Pointer Lock)' } : { cls: '', text: 'On · click the track while driving to capture the mouse' };
      },
      menuItems: function () {
        return [
          { label: 'Mouse wheel: re-centre', icon: 'steer', fn: function () { M.recentre(); toast('Steering centred'); } },
          { label: 'Mouse steering: off', icon: 'steer', fn: function () { var S2 = SS(); if (S2) S2.select('default'); M.disable(); toast('Mouse steering off'); } }
        ];
      }
    });
    if (S.selected() === 'mouse' && hasDOM) M.enable();
  }
  defineSource();

  M._B = B;
  CB.input.mouse = M;
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
})();

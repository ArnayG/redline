/* ==========================================================================
   Redline — js/input/orient.js
   CB.input.orient : keeps the page SIDEWAYS while the phone is used as a steering wheel, even when the player turns the
   phone past 90 deg and the OS auto-rotates the screen (landscape <-> portrait, or to the other landscape side).

   Two layers:
     1. Real lock where the browser allows it (Android Chrome / installed web app): fullscreen + screen.orientation.lock()
        to the landscape side the phone is held in when the steering session starts.
     2. CSS counter-rotation fallback (iOS Safari can't lock): the session freezes its "intended" landscape side A; when the
        OS rotates the screen to angle B, the session container is rotated by (A - B) with CSS (and its width / height
        swapped when that is 90 / 270 deg), so the UI never moves relative to the player's hands. Safe-area insets are
        re-mapped through CSS variables (--pw-sa-top/right/bottom/left) and pointer coordinates are mapped back into the
        container's own frame (orient.point).

   Pure core (Node-tested):
     orient.deviceRoll(beta, gamma)       -> {angle, conf}  rotation of the phone about its screen normal in the DEVICE
                                             frame (0 = device top up, -90 = top to the LEFT, +90 = top to the RIGHT)
     orient.sideFromRoll(rollDeg)         -> 90 | 270       the landscape screen angle that matches how the phone is held
     orient.rotationFor(side, screenAng)  -> 0 | 90 | 180 | 270   CSS clockwise counter-rotation for the container
     orient.insetMap(rot)                 -> {top, right, bottom, left}  env() expression for each side of the rotated box
     orient.toLocal(px, py, box, rot)     -> {x, y}   viewport point -> container frame (box = {cx, cy, w, h})
     orient.createState()                 -> state machine: begin({screenAngle, roll, conf}) / update(screenAngle) /
                                             locked(screenAngle) / recentre({...}) / end() / snapshot()
   Browser:
     orient.begin(el, owner, opts?) -> snapshot    start (or re-target) a steering session on container `el`
     orient.end(owner)                              stop it: undo the rotation, release the lock
     orient.recentre({beta, gamma}?)                re-pick the landscape side from the phone's current hold
     orient.lock()                                  try fullscreen-less lock to the frozen side (call again after fullscreen)
     orient.requestFullscreenAndLock()              from a user gesture: fullscreen, then lock
     orient.point(el, ev) -> {x, y, w, h}           pointer position inside `el` in its own (unrotated) frame
     orient.onSide(fn(snapshot)) -> off            the frozen side was set / changed (steering re-bases on it)
     orient.active() / orient.snapshot()
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.input = CB.input || {};

(function () {
  'use strict';
  var DEG = Math.PI / 180;
  var SIDES = ['top', 'right', 'bottom', 'left'];
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function norm360(a) { a = Math.round(num(a, 0)) % 360; return a < 0 ? a + 360 : a; }
  function snap90(a) { return norm360(Math.round(num(a, 0) / 90) * 90); }
  function isLand(a) { a = snap90(a); return a === 90 || a === 270; }

  /* ---------------------------------------------------------------- pure geometry */
  /** Device-frame roll from DeviceOrientation beta / gamma (gravity vector, independent of the screen orientation). */
  function deviceRoll(beta, gamma) {
    if (!isFinite(beta) || !isFinite(gamma)) return null;
    var b = beta * DEG, g = gamma * DEG;
    var ux = -Math.sin(g) * Math.cos(b), uy = Math.sin(b);          // world "up" in device x / y (W3C Z-X'-Y'')
    var mag = Math.hypot(ux, uy);
    return { angle: Math.atan2(-ux, uy) / DEG, conf: clamp((mag - 0.15) / 0.35, 0, 1) };
  }
  /** Device-frame roll straight from a gravity vector (DeviceMotion accelerationIncludingGravity, +z = up at rest). */
  function rollFromGravity(gx, gy, gz) {
    var n = Math.hypot(gx, gy, gz);
    if (!(n > 1e-6)) return null;
    var ux = gx / n, uy = gy / n, mag = Math.hypot(ux, uy);
    return { angle: Math.atan2(-ux, uy) / DEG, conf: clamp((mag - 0.15) / 0.35, 0, 1) };
  }
  function heldSideways(o) { return o && o.roll != null && num(o.conf, 1) > 0.3 && Math.abs(wrapDeg(o.roll)) > 45 && Math.abs(wrapDeg(o.roll)) < 135; }
  function wrapDeg(a) { return ((num(a, 0) + 180) % 360 + 360) % 360 - 180; }
  /** roll -90 (device top to the left) -> screen angle 90; roll +90 (top to the right) -> 270. */
  function sideFromRoll(roll) { return wrapDeg(num(roll, -90)) > 0 ? 270 : 90; }
  /** CSS clockwise rotation that turns the OS-rotated content back to the frozen side. */
  function rotationFor(side, screenAngle) { return norm360(snap90(side) - snap90(screenAngle)); }
  function insetMap(rot) {
    var k = snap90(rot) / 90, m = {};
    for (var i = 0; i < 4; i++) m[SIDES[i]] = 'env(safe-area-inset-' + SIDES[(i + k) % 4] + ')';
    return m;
  }
  /** Viewport point -> point in the rotated container's own frame. box: {cx, cy} its on-screen centre, {w, h} its layout size. */
  function toLocal(px, py, box, rot) {
    var t = snap90(rot) * DEG, c = Math.round(Math.cos(t)), s = Math.round(Math.sin(t));
    var dx = px - box.cx, dy = py - box.cy;
    // CSS rotate(t): x' = x c - y s, y' = x s + y c   ->  inverse
    return { x: dx * c + dy * s + box.w / 2, y: -dx * s + dy * c + box.h / 2 };
  }

  /* ---------------------------------------------------------------- state machine */
  function createState() {
    var S = { active: false, side: 90, screen: 0, rot: 0, lockedOS: false };
    function snap() { return { active: S.active, side: S.side, screen: S.screen, rot: S.active ? S.rot : 0, swap: S.active && (S.rot === 90 || S.rot === 270), lockedOS: S.lockedOS }; }
    function pick(o) {
      o = o || {};
      var sa = snap90(num(o.screenAngle, 0));
      if (isLand(sa)) return sa;                                                   // what the player is looking at
      if (heldSideways(o)) return sideFromRoll(o.roll);                           // OS portrait (e.g. rotation lock on)
      return o.keep != null ? o.keep : 90;
    }
    return {
      /** start a session: freeze the landscape side. Re-calling while active keeps the frozen side (no flicker). */
      begin: function (o) {
        o = o || {};
        if (!S.active) { S.side = pick(o); S.lockedOS = false; }
        S.active = true;
        S.screen = snap90(num(o.screenAngle, S.screen));
        S.rot = rotationFor(S.side, S.screen);
        return snap();
      },
      /** OS rotated the screen: only the counter-rotation changes, never the frozen side. */
      update: function (screenAngle) {
        S.screen = snap90(num(screenAngle, S.screen));
        S.rot = S.active ? rotationFor(S.side, S.screen) : 0;
        return snap();
      },
      /** the browser granted a real orientation lock: the OS side is authoritative from now on. */
      locked: function (screenAngle) {
        if (!S.active) return snap();
        S.screen = snap90(num(screenAngle, S.screen));
        if (isLand(S.screen)) S.side = S.screen;
        S.lockedOS = true;
        S.rot = rotationFor(S.side, S.screen);
        return snap();
      },
      /** explicit re-centre (CENTRE button): re-pick the side from the current hold. */
      recentre: function (o) {
        if (!S.active) return snap();
        o = o || {};
        // the OS shows a landscape side: that is how the phone is held now. OS portrait: the phone's hold if it is
        // clearly sideways (system rotation lock), else (mid-turn) keep the frozen side.
        if (!S.lockedOS) S.side = pick({ screenAngle: S.screen, roll: o.roll, conf: o.conf, keep: S.side });
        S.rot = rotationFor(S.side, S.screen);
        return snap();
      },
      end: function () { S.active = false; S.rot = 0; S.lockedOS = false; return snap(); },
      snapshot: snap
    };
  }

  var api = {
    deviceRoll: deviceRoll, rollFromGravity: rollFromGravity, sideFromRoll: sideFromRoll, rotationFor: rotationFor,
    insetMap: insetMap, toLocal: toLocal, createState: createState, snap90: snap90
  };
  CB.input.orient = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  /* ---------------------------------------------------------------- browser binding */
  var hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (!hasDOM) return;

  var CSS = [
    /* the session container: centred, counter-rotated, width / height swapped for 90 / 270 */
    'html.pw-orient-rot .pw-orient-target{position:fixed!important;inset:auto!important;left:50%!important;top:50%!important;right:auto!important;bottom:auto!important;',
    'width:100vw!important;height:100vh!important;width:100dvw!important;height:100dvh!important;transform:translate(-50%,-50%) rotate(var(--pw-orient-rot,0deg))!important;transform-origin:50% 50%!important;z-index:9000}',
    'html.pw-orient-swap .pw-orient-target{width:100vh!important;height:100vw!important;width:100dvh!important;height:100dvw!important}',
    'html.pw-orient-rot,html.pw-orient-rot body{overflow:hidden!important}',
    /* the page IS sideways now: the "turn your phone" prompts would be wrong */
    'html.pw-orient-swap .pwp-rot,html.pw-orient-swap #race-root .pw-rotate,html.pw-orient-swap #race-root .rx-rotate{display:none!important}'
  ].join('\n');
  function ensureCss() {
    if (document.getElementById('pw-orient-css')) return;
    var s = document.createElement('style'); s.id = 'pw-orient-css'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function screenAngle() {
    try { if (window.screen && window.screen.orientation && isFinite(window.screen.orientation.angle)) return snap90(window.screen.orientation.angle); } catch (e) { /* ignore */ }
    if (isFinite(window.orientation)) return snap90(window.orientation);
    // last resort: viewport shape (portrait = 0, landscape = 90)
    return window.innerWidth > window.innerHeight ? 90 : 0;
  }

  var state = createState(), target = null, owner = null, lastRoll = null, listening = false;
  // latest gravity reading from the tilt sensor (device frame) -> which landscape side the phone is held in
  function feedRoll(b, g) { var r = deviceRoll(b, g); if (r && r.conf > 0) lastRoll = r; }
  function hookSensor() {
    var T = CB.input.tilt;
    if (T && T.sensor && T.sensor.onReading && !hookSensor.done) { hookSensor.done = true; T.sensor.onReading(feedRoll); }
  }

  var subs = [], lastSide = null;
  function notify(s) {
    if (s.active && s.side !== lastSide) { lastSide = s.side; subs.slice().forEach(function (fn) { try { fn(s); } catch (e) { /* ignore */ } }); }
    if (!s.active) lastSide = null;
  }
  function apply() {
    var s = state.snapshot(), root = document.documentElement;
    notify(s);
    root.classList.toggle('pw-orient-rot', s.active && s.rot !== 0);
    root.classList.toggle('pw-orient-swap', !!s.swap);
    root.classList.toggle('pw-orient-on', s.active);
    if (target) {
      if (s.active) {
        target.classList.add('pw-orient-target');
        target.style.setProperty('--pw-orient-rot', s.rot + 'deg');
        var m = insetMap(s.rot);
        SIDES.forEach(function (k) { target.style.setProperty('--pw-sa-' + k, m[k]); });
        target.setAttribute('data-orient-rot', String(s.rot));
      } else clearTarget(target);
    }
    return s;
  }
  function clearTarget(el) {
    el.classList.remove('pw-orient-target');
    el.style.removeProperty('--pw-orient-rot');
    SIDES.forEach(function (k) { el.style.removeProperty('--pw-sa-' + k); });
    el.removeAttribute('data-orient-rot');
  }
  function onOsRotate() { if (!state.snapshot().active) return; state.update(screenAngle()); apply(); }
  function listen(on) {
    if (on === listening) return;
    listening = on;
    var fn = on ? 'addEventListener' : 'removeEventListener';
    try { if (window.screen && window.screen.orientation && window.screen.orientation[fn]) window.screen.orientation[fn]('change', onOsRotate); } catch (e) { /* ignore */ }
    window[fn]('orientationchange', onOsRotate);
    window[fn]('resize', onOsRotate);
  }

  function lockTypeFor(side) {
    // keep the side the phone is in: if the OS already shows it, lock that exact type, otherwise the matching primary / secondary
    try {
      var o = window.screen.orientation;
      if (o && snap90(o.angle) === side && /^landscape/.test(o.type || '')) return o.type;
    } catch (e) { /* ignore */ }
    return side === 270 ? 'landscape-secondary' : 'landscape-primary';
  }
  function lock() {
    var s = state.snapshot();
    var o = window.screen && window.screen.orientation;
    if (!o || typeof o.lock !== 'function') return Promise.resolve(false);
    var type = s.active ? lockTypeFor(s.side) : 'landscape';
    var p;
    try { p = o.lock(type); } catch (e) { return Promise.resolve(false); }
    if (!p || typeof p.then !== 'function') return Promise.resolve(false);
    return p.then(function () {
      if (state.snapshot().active) { state.locked(screenAngle()); apply(); }
      return true;
    }, function () { return false; });   // iOS / not fullscreen / desktop: the CSS fallback covers it
  }
  function inFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  function requestFullscreenAndLock() {
    var d = document.documentElement, p = null;
    try {
      if (!inFullscreen()) {
        var fn = d.requestFullscreen || d.webkitRequestFullscreen;
        if (fn) p = fn.call(d, { navigationUI: 'hide' });
      }
    } catch (e) { p = null; }          // iOS Safari: no element fullscreen
    if (p && typeof p.then === 'function') return p.then(lock, lock);
    return lock();
  }
  function unlock() { try { if (window.screen && window.screen.orientation && window.screen.orientation.unlock) window.screen.orientation.unlock(); } catch (e) { /* ignore */ } }

  api.screenAngle = screenAngle;
  api.begin = function (el, who, opts) {
    ensureCss(); hookSensor();
    opts = opts || {};
    if (target && el && target !== el) clearTarget(target);
    if (el) target = el;
    owner = who || owner || 'app';
    var r = opts.roll != null ? { angle: opts.roll, conf: num(opts.conf, 1) } : lastRoll;
    state.begin({ screenAngle: screenAngle(), roll: r ? r.angle : null, conf: r ? r.conf : 0 });
    listen(true);
    var s = apply();
    if (opts.lock !== false && inFullscreen()) lock();
    return s;
  };
  api.end = function (who) {
    if (who && owner && who !== owner) return state.snapshot();
    state.end(); apply(); listen(false);
    if (target) clearTarget(target);
    target = null; owner = null;
    unlock();
    return state.snapshot();
  };
  api.recentre = function (o) {
    if (o && o.beta != null && o.gamma != null) feedRoll(+o.beta, +o.gamma);   // the reading that triggered it
    var r = lastRoll;
    state.update(screenAngle());
    state.recentre({ roll: r ? r.angle : null, conf: r ? r.conf : 0 });
    var s = apply();
    if (inFullscreen()) lock();
    return s;
  };
  /** onSide(fn(snapshot)) -> off : the frozen landscape side was set / changed (session start, real lock, CENTRE) */
  api.onSide = function (fn) { subs.push(fn); return function () { var i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; };
  api.lock = lock;
  api.requestFullscreenAndLock = requestFullscreenAndLock;
  api.active = function () { return state.snapshot().active; };
  api.snapshot = function () { return state.snapshot(); };
  api.target = function () { return target; };
  api._feedRoll = feedRoll;
  /** Pointer position inside `el`, in el's own unrotated frame: {x, y, w, h}. Works with and without a counter-rotation. */
  api.point = function (el, ev) {
    var s = state.snapshot();
    if (!s.active || !s.rot || !target || !target.contains(el)) {
      var r = el.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top, w: r.width, h: r.height };
    }
    var tr = target.getBoundingClientRect();
    var p = toLocal(ev.clientX, ev.clientY, { cx: tr.left + tr.width / 2, cy: tr.top + tr.height / 2, w: target.offsetWidth, h: target.offsetHeight }, s.rot);
    // el's layout offset inside the container (offsetLeft / offsetTop ignore transforms)
    var ox = 0, oy = 0, n = el;
    while (n && n !== target) {
      ox += n.offsetLeft || 0; oy += n.offsetTop || 0;
      var par = n.offsetParent;
      if (!par || !target.contains(par)) break;
      n = par;
    }
    return { x: p.x - ox, y: p.y - oy, w: el.offsetWidth, h: el.offsetHeight };
  };
})();

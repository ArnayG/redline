/* ==========================================================================
   FORGE — js/input/analog.js
   CB.input.hub : the analog input hub for phone steering. Pure logic (no DOM needed), classic script, Node-loadable.

   Sources feed one continuous driver intent into CB.race.ui's input manager (race-ui createInput.sample merges it with
   keyboard / gamepad / on-screen touch). Two sources exist:
     'wheel'  a paired phone used as a steering wheel for the game on the computer (js/input/phone-wheel.js)
     'tilt'   this device's own tilt sensor + on-screen pedals (playing on the phone itself, js/input/tilt.js)

   Conventions (CB.input.*): steer in [-1, 1], +1 = RIGHT (clockwise wheel); throttle / brake in [0, 1].
   race-ui flips the sign into its own input space (+1 = left).

     var off = hub.register(id, src, priority?)   src.read(now) -> {active, steer, throttle, brake, handbrake} | null
     hub.read(now?) -> {active, steer, throttle, brake, handbrake, source}   the highest-priority active source
     hub.pushEvent(type, data?)   edge events from a source: 'shiftUp' 'shiftDown' 'pause' 'camera' 'reset' 'confirm'
     hub.takeEvents() -> [{type, source, data}]   (drained by race-ui once per frame)
     hub.onEvent(fn) -> off()   live subscription to the same edge events (arcade layer: 'nitroOn' 'nitroOff' 'item' 'itemBack')
     hub.frame(info)              race-ui, once per rendered frame: {screen:'race'|'drift'|'setup'|..., driving, paused,
                                  speed (m/s), gear, rpmFrac, surface, events:[engine snapshot events for the player]}
                                  -> derives haptic feedback (kerb rumble, collisions, walls) + a status for the phone
     hub.onFeedback(fn({kind:'kerb'|'hit'|'wall'|'offroad', intensity}))   hub.onStatus(fn(status))
     hub.status() -> last status      hub.sources() -> ids      hub.lastSource()
     hub.prefs / hub.setPrefs(p)  shared tilt-steer preferences (maxAngle 35 deg = full lock, deadzone 2 deg,
                                  smoothing 0..1), persisted in localStorage 'forge.phoneSteer.v1'
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.input = CB.input || {};

(function () {
  'use strict';

  var PREF_KEY = 'forge.phoneSteer.v1';
  var DEFAULT_PREFS = { maxAngle: 35, deadzone: 2, smoothing: 0.5, invert: false, tiltEnabled: false };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }

  function normPrefs(p) {
    p = p && typeof p === 'object' ? p : {};
    return {
      maxAngle: clamp(num(+p.maxAngle, DEFAULT_PREFS.maxAngle), 10, 180),
      deadzone: clamp(num(+p.deadzone, DEFAULT_PREFS.deadzone), 0, 10),
      smoothing: clamp(num(+p.smoothing, DEFAULT_PREFS.smoothing), 0, 1),
      invert: !!p.invert,
      tiltEnabled: !!p.tiltEnabled
    };
  }
  function loadPrefs() {
    try { var s = globalThis.localStorage && globalThis.localStorage.getItem(PREF_KEY); if (s) return normPrefs(JSON.parse(s)); } catch (e) { /* ignore */ }
    return normPrefs(DEFAULT_PREFS);
  }
  function savePrefs(p) { try { if (globalThis.localStorage) globalThis.localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ } }

  function emitter() {
    var map = {};
    return {
      on: function (t, fn) { (map[t] = map[t] || []).push(fn); return function () { var l = map[t]; if (l) { var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }; },
      emit: function (t, a) { (map[t] || []).slice().forEach(function (fn) { try { fn(a); } catch (e) { if (typeof console !== 'undefined') console.error('[input.hub]', e); } }); }
    };
  }

  function createHub() {
    var ev = emitter();
    var srcs = [];                      // {id, src, priority}
    var events = [];
    var last = { active: false, steer: 0, throttle: 0, brake: 0, handbrake: false, source: null };
    var status = { screen: null, driving: false, paused: false, speed: 0, gear: 0, rpmFrac: 0 };
    var hap = { kerbT: -1e9, hitT: -1e9, wasKerb: false };
    var H = {
      prefs: loadPrefs(),
      register: function (id, src, priority) {
        H.unregister(id);
        srcs.push({ id: String(id), src: src, priority: num(priority, 0) });
        srcs.sort(function (a, b) { return b.priority - a.priority; });
        return function () { H.unregister(id); };
      },
      unregister: function (id) { srcs = srcs.filter(function (s) { return s.id !== String(id); }); },
      sources: function () { return srcs.map(function (s) { return s.id; }); },
      read: function (now) {
        now = num(now, nowMs());
        for (var i = 0; i < srcs.length; i++) {
          var r = null;
          try { r = srcs[i].src && typeof srcs[i].src.read === 'function' ? srcs[i].src.read(now) : null; } catch (e) { r = null; }
          if (r && r.active) {
            last = {
              active: true, source: srcs[i].id,
              steer: clamp(num(+r.steer, 0), -1, 1) * (H.prefs.invert ? -1 : 1),
              throttle: clamp(num(+r.throttle, 0), 0, 1), brake: clamp(num(+r.brake, 0), 0, 1), handbrake: !!r.handbrake
            };
            return last;
          }
        }
        // nothing active: neutral (centred steering, no throttle) — this is also the disconnect failsafe
        last = { active: false, steer: 0, throttle: 0, brake: 0, handbrake: false, source: null };
        return last;
      },
      lastSource: function () { return last.source; },
      pushEvent: function (type, source, data) {
        if (typeof type !== 'string') return;
        var e = { type: type, source: source || null, data: data == null ? null : data };
        events.push(e);
        if (events.length > 32) events.shift();
        ev.emit('event', e);   // live subscribers (arcade NITRO / ITEM buttons) — race-ui still drains takeEvents()
      },
      /** onEvent(fn({type, source, data})) -> off()   every pushed edge event, as it arrives */
      onEvent: function (fn) { return ev.on('event', fn); },
      takeEvents: function () { var e = events; events = []; return e; },
      /** race-ui per-frame report -> status for the phone + haptic feedback derivation. */
      frame: function (info) {
        info = info || {};
        var t = num(info.now, nowMs());
        var st = {
          screen: info.screen || null, driving: !!info.driving, paused: !!info.paused,
          speed: Math.abs(num(info.speed, 0)), gear: num(info.gear, 0) | 0, rpmFrac: clamp(num(info.rpmFrac, 0), 0, 1),
          assist: info.assist || null, net: !!info.net
        };
        var changed = st.driving !== status.driving || st.paused !== status.paused || st.screen !== status.screen || st.gear !== status.gear;
        status = st;
        if (changed) ev.emit('status', st);
        if (!st.driving || st.paused) { hap.wasKerb = false; return; }
        var evs = Array.isArray(info.events) ? info.events : [];
        for (var i = 0; i < evs.length; i++) {
          var e = evs[i];
          if (!e || (info.playerId && e.carId && e.carId !== info.playerId)) continue;
          if (e.type === 'collision' || e.type === 'wall') {
            if (t - hap.hitT < 90) continue;
            hap.hitT = t;
            ev.emit('feedback', { kind: e.type === 'wall' ? 'wall' : 'hit', intensity: clamp(num(e.intensity, 0.5), 0.1, 1) });
          }
        }
        var onKerb = info.surface === 'kerb' && st.speed > 4;
        var offroad = (info.surface === 'grass' || info.surface === 'sand' || info.surface === 'gravel') && st.speed > 6;
        if ((onKerb || offroad) && t - hap.kerbT > (onKerb ? 140 : 220)) {
          hap.kerbT = t;
          ev.emit('feedback', { kind: onKerb ? 'kerb' : 'offroad', intensity: clamp(st.speed / 40, 0.2, 1) });
        }
        hap.wasKerb = onKerb;
      },
      feedback: function (f) { if (f && f.kind) ev.emit('feedback', f); },
      onFeedback: function (fn) { return ev.on('feedback', fn); },
      onStatus: function (fn) { return ev.on('status', fn); },
      status: function () { return status; },
      setPrefs: function (p) {
        H.prefs = normPrefs(Object.assign({}, H.prefs, p || {}));
        savePrefs(H.prefs);
        ev.emit('prefs', H.prefs);
        return H.prefs;
      },
      onPrefs: function (fn) { return ev.on('prefs', fn); },
      _reset: function () { srcs = []; events = []; status = { screen: null, driving: false, paused: false, speed: 0, gear: 0, rpmFrac: 0 }; }
    };
    return H;
  }

  CB.input.hub = CB.input.hub || createHub();
  CB.input.createHub = createHub;
  CB.input.normPrefs = normPrefs;
  CB.input.DEFAULT_PREFS = DEFAULT_PREFS;
  if (typeof module !== 'undefined' && module.exports) module.exports = { hub: CB.input.hub, createHub: createHub, normPrefs: normPrefs, DEFAULT_PREFS: DEFAULT_PREFS };
})();

/* ==========================================================================
   Redline — js/arcade/arcade-layer.js
   CB.arcade.layer : wires the Arcade GAMEPLAY LAYER (js/arcade/gameplay.js) into an arcade session.

   Registers itself as the 'gameplay' extension of CB.arcade.mode (docs/ARCADE-SPEC.md §3) when that module is present
   (feature-detected; retried on DOMContentLoaded if mode.js loads later). Setup options it contributes:
     items (toggle) · itemFrequency low|normal|high|frantic · nitro (toggle) · speedClass street|pro|mayhem · coins (toggle)
   Time Trial (mode 'time-trial') automatically means: no item boxes, triple Turbo at the start, ghost from the engine.

   Instance (per session) — CB.arcade.layer.createInstance(ctx) also works stand-alone:
     inst.hooks [gameplay.hooks]           engine hooks (CB.race.engine cfg.hooks; stunt sessions take the same shape)
     inst.attach(session)                  engine: track-space geometry + auto layout; stunt: gameplayTrack() bridge
     inst.snapshot(snap) -> state          decorates cars (visual yaw / slide / hop, car.arcade) + returns gameplay state
     inst.drawHud(ctx, snap, view)         per frame: input polling, events -> HUD / FX / SFX, draws FX then HUD widgets
     inst.setRenderer(r)                   renderer3d: camera FOV kick + shake, car hop
     inst.entities(snap)                   world entities as {id, type, x, y, z, heading, radius, color, glyph, drawnBy}
     inst.results(r)                       r.arcade.gameplay = { player: stats, cars: {id: stats} }
     inst.serialize() / restore(o) / reset() / destroy()
   Controls: N / Shift = nitro (hold) · F / X = use item (hold S / ↓ to aim back) · Space = powerslide (handbrake)
             gamepad B / RB = nitro, X / LB = item · touch NITRO + ITEM buttons · phone wheel NITRO + ITEM buttons
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.arcade = CB.arcade || {};

(function () {
  'use strict';

  var hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined' && typeof document.createElement === 'function';
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }

  var OPTIONS = [
    { id: 'items', name: 'Items', desc: 'Item boxes with Mario-Kart style power-ups', default: true },
    { id: 'itemFrequency', name: 'Item boxes', desc: 'How many rows of item boxes per lap',
      choices: [{ id: 'low', name: 'Few' }, { id: 'normal', name: 'Normal' }, { id: 'high', name: 'Many' }, { id: 'frantic', name: 'Frantic' }], default: 'normal' },
    { id: 'nitro', name: 'Nitro', desc: 'Nitro meter filled by drifts, drafting, jumps and near-misses', default: true },
    { id: 'speedClass', name: 'Speed class', desc: 'Scales top speed and AI aggression',
      choices: [{ id: 'street', name: 'Street', desc: 'Real-world pace' }, { id: 'pro', name: 'Pro', desc: '+12% top speed' }, { id: 'mayhem', name: 'Mayhem', desc: '+28% top speed' }], default: 'street' },
    { id: 'coins', name: 'Coins', desc: 'Collect up to 10 for a small top-speed bonus', default: true }
  ];

  var CSS = [
    '.arc-touch{position:absolute;right:200px;bottom:calc(min(42vh,260px) + 6px);display:flex;align-items:flex-end;gap:12px;z-index:5;pointer-events:none}',
    '.arc-touch>*{pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none}',
    '.arc-btn{display:grid;place-items:center;border-radius:50%;border:2px solid rgba(255,255,255,.28);background:rgba(8,12,22,.55);color:#fff;font:800 12px/1 "Barlow Condensed","Arial Narrow",system-ui,sans-serif;letter-spacing:.1em;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}',
    '.arc-btn.nitro{width:86px;height:86px;background:radial-gradient(circle at 40% 35%,rgba(80,170,255,.55),rgba(10,40,120,.55));border-color:rgba(127,227,255,.7);font-size:15px}',
    '.arc-btn.item{width:66px;height:66px;position:relative}',
    '.arc-btn.item canvas{width:44px;height:44px}',
    '.arc-btn.is-down{transform:scale(.94);border-color:#fff}',
    '.arc-btn .arc-fill{position:absolute;inset:0;border-radius:50%;pointer-events:none}'
  ].join('\n');

  function createInstance(ctx) {
    ctx = ctx || {};
    var G = CB.arcade.gameplay;
    if (!G) return null;
    var o = ctx.options || {};
    var settings = ctx.settings || {};
    var gp = G.create({
      seed: num(ctx.seed, 1), items: o.items !== false, itemFrequency: o.itemFrequency || 'normal', nitro: o.nitro !== false,
      coins: o.coins !== false, speedClass: o.speedClass || 'street', timeTrial: ctx.mode === 'time-trial',
      difficulty: settings.difficulty || ctx.difficulty || 'normal', rubberBand: o.rubberBand !== false && settings.rubberBanding !== false,
      track: ctx.trackSpace || null
    });
    var hud = CB.arcade.hud ? CB.arcade.hud.create({}) : null;
    var fx = CB.arcade.fx ? CB.arcade.fx.create({ track: gp.track() }) : null;
    var sfx = CB.arcade.sfx && hasDOM ? CB.arcade.sfx.create({ muted: readMuted() }) : null;
    var L = { keys: {}, last: 0, gpPrev: {}, touch: null, offs: [], muted: readMuted(), phoneT: 0, session: null, destroyed: false, renderer: null };
    var pin = { nitro: false, item: false, aimBack: false };

    function readMuted() {
      try { var s = JSON.parse(localStorage.getItem('forge.race.settings.v1') || '{}'); return !!s.muted; } catch (e) { return false; }
    }

    /* ---------------- input ---------------- */
    var NITRO_KEYS = { KeyN: 1, ShiftLeft: 1, ShiftRight: 1 }, ITEM_KEYS = { KeyF: 1, KeyX: 1 }, BACK_KEYS = { KeyS: 1, ArrowDown: 1 };
    function typing(e) { var t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); }
    function onKey(e) {
      if (L.destroyed || typing(e)) return;
      var down = e.type === 'keydown', c = e.code;
      if (down && sfx) sfx.unlock();
      if (NITRO_KEYS[c] && gp.options.nitro) { L.keys.nitro = down ? (L.keys.nitro | 0) | (c === 'KeyN' ? 1 : 2) : (L.keys.nitro | 0) & ~(c === 'KeyN' ? 1 : 2); e.preventDefault(); e.stopImmediatePropagation(); }
      else if (ITEM_KEYS[c]) { L.keys.item = down; if (down && !e.repeat) L.keys.itemT = nowMs(); e.preventDefault(); e.stopImmediatePropagation(); }
      if (BACK_KEYS[c]) L.keys.back = down;
      if (c === 'KeyW' || c === 'ArrowUp') L.keys.gas = down;   // read only (never consumed): rocket-start rev gauge
    }
    function onBlur() { L.keys = {}; }
    if (hasDOM) {
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('keyup', onKey, true);
      window.addEventListener('blur', onBlur);
      var unlock = function () { if (sfx) sfx.unlock(); };
      window.addEventListener('pointerdown', unlock, true);
      L.offs.push(function () {
        window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKey, true);
        window.removeEventListener('blur', onBlur); window.removeEventListener('pointerdown', unlock, true);
      });
    }
    // phone wheel / tilt buttons through CB.input.hub edge events
    var hub = CB.input && CB.input.hub;
    if (hub && typeof hub.onEvent === 'function') {
      L.offs.push(hub.onEvent(function (e) {
        if (!e) return;
        if (e.type === 'nitroOn') L.keys.phoneNitro = true;
        else if (e.type === 'nitroOff') L.keys.phoneNitro = false;
        else if (e.type === 'item') L.keys.phoneItemT = nowMs();
        else if (e.type === 'itemBack') { L.keys.phoneItemT = nowMs(); L.keys.phoneBackT = nowMs(); }
      }));
    }
    function pollGamepad() {
      var out = { nitro: false, item: false, back: false };
      if (!hasDOM || !navigator.getGamepads) return out;
      var pads; try { pads = navigator.getGamepads(); } catch (e) { return out; }
      for (var i = 0; pads && i < pads.length; i++) {
        var p = pads[i]; if (!p || p.connected === false || !p.buttons) continue;
        function b(k) { var x = p.buttons[k]; return !!(x && (x.pressed || x.value > 0.5)); }
        out.nitro = out.nitro || b(1) || b(5);
        out.item = out.item || b(2) || b(4);
        out.back = out.back || b(13) || b(6);
        var rt = p.buttons[7]; out.gas = Math.max(out.gas || 0, rt ? (rt.value || (rt.pressed ? 1 : 0)) : 0);
      }
      return out;
    }
    function updateInput() {
      var g = pollGamepad(), t = nowMs(), T = L.touch || {};
      pin.nitro = !!(L.keys.nitro || g.nitro || T.nitro || L.keys.phoneNitro);
      var phoneItem = L.keys.phoneItemT && t - L.keys.phoneItemT < 120;
      // a press shorter than one frame still fires (keys and the touch button latch for 120 ms, like the phone's)
      var tapItem = (L.keys.itemT && t - L.keys.itemT < 120) || (T.itemT && t - T.itemT < 120);
      pin.item = !!(L.keys.item || g.item || T.item || phoneItem || tapItem);
      pin.aimBack = !!(L.keys.back || g.back || T.back || (L.keys.phoneBackT && t - L.keys.phoneBackT < 120));
      var ext = 0, hb2 = CB.input && CB.input.hub;
      if (hb2 && typeof hb2.status === 'function' && typeof hb2.read === 'function') { try { var hr = hb2.read(); if (hr && hr.active) ext = +hr.throttle || 0; } catch (eH) { /* ignore */ } }
      var tt = 0;
      try { var RU = CB.race && CB.race.ui && CB.race.ui._dev && CB.race.ui._dev.state(); tt = RU && RU.race && RU.race.input && RU.race.input.touch ? +RU.race.input.touch.throttle || 0 : 0; } catch (eT) { tt = 0; }
      pin.rev = Math.max(L.keys.gas ? 1 : 0, g.gas || 0, ext, tt);
      gp.setInput(pin);
    }

    /* ---------------- touch buttons ---------------- */
    function touchWanted() {
      if (!hasDOM) return false;
      try {
        var s = JSON.parse(localStorage.getItem('forge.race.settings.v1') || '{}');
        if (s.touchControls === 'on') return true;
        if (s.touchControls === 'off') return false;
      } catch (e) { /* ignore */ }
      try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e2) { return false; }
    }
    function buildTouch(host) {
      if (L.touch || !hasDOM || !host || !touchWanted()) return;
      if (!document.getElementById('arc-touch-css')) { var st = document.createElement('style'); st.id = 'arc-touch-css'; st.textContent = CSS; document.head.appendChild(st); }
      var wrap = document.createElement('div'); wrap.className = 'arc-touch';
      var item = document.createElement('div'); item.className = 'arc-btn item'; item.setAttribute('role', 'button'); item.setAttribute('aria-label', 'Use item');
      var cv = document.createElement('canvas'); cv.width = 88; cv.height = 88; item.appendChild(cv);
      var nitro = document.createElement('div'); nitro.className = 'arc-btn nitro'; nitro.setAttribute('role', 'button'); nitro.textContent = 'NITRO';
      var T = L.touch = { el: wrap, item: false, nitro: false, back: false, cv: cv, lastIcon: null };
      function hold(el, key) {
        var id = null, y0 = 0;
        // y in the button's own frame (CB.input.orient may counter-rotate the race view while tilt-steering)
        function py(e) { var O = CB.input && CB.input.orient; return O && O.point ? O.point(el, e).y : e.clientY; }
        el.addEventListener('pointerdown', function (e) { id = e.pointerId; y0 = py(e); try { el.setPointerCapture(id); } catch (x) { /* ignore */ } T[key] = true; T[key + 'T'] = nowMs(); T.back = false; el.classList.add('is-down'); if (sfx) sfx.unlock(); e.preventDefault(); e.stopPropagation(); });
        el.addEventListener('pointermove', function (e) { if (e.pointerId === id && key === 'item') T.back = py(e) - y0 > 28; });   // swipe down on ITEM = fire backwards
        function end(e) { if (e.pointerId !== id) return; id = null; T[key] = false; el.classList.remove('is-down'); }
        el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
      }
      hold(item, 'item'); hold(nitro, 'nitro');
      if (!gp.options.nitro) nitro.style.display = 'none';
      wrap.appendChild(item); wrap.appendChild(nitro);
      wrap.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      host.appendChild(wrap);
      L.offs.push(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); L.touch = null; });
    }
    function updateTouch(P) {
      var T = L.touch; if (!T || !P) return;
      var id = P.roulette ? '?' : P.item ? P.item.id : '';
      if (id !== T.lastIcon && CB.arcade.hud) {
        T.lastIcon = id;
        var c2 = T.cv.getContext('2d'); c2.clearRect(0, 0, 88, 88);
        if (id) CB.arcade.hud.drawIcon(c2, id, 44, 44, 64);
        else { c2.fillStyle = 'rgba(255,255,255,.5)'; c2.font = '800 18px sans-serif'; c2.textAlign = 'center'; c2.textBaseline = 'middle'; c2.fillText('ITEM', 44, 46); }
      }
      var nb = T.el.querySelector('.nitro');
      if (nb) nb.style.boxShadow = P.nitroOn ? '0 0 26px rgba(80,180,255,.9)' : 'inset 0 ' + (-86 * P.nitro) + 'px 0 rgba(47,139,255,.55)';
    }

    /* ---------------- phone wheel status (NITRO / ITEM buttons on the phone page) ---------------- */
    function phoneStatus(P) {
      var W = CB.input && CB.input.wheel, s = null;
      if (!W || typeof W.session !== 'function') return;
      try { s = W.session(); } catch (e) { s = null; }
      if (!s || !s.rx || typeof s.rx.send !== 'function') return;
      var t = nowMs();
      if (t - L.phoneT < 250) return;
      L.phoneT = t;
      try { s.rx.send('arcade', { on: true, nitro: P ? Math.round(P.nitro * 100) / 100 : 0, nitroOn: !!(P && P.nitroOn), item: P && P.item ? P.item.id : P && P.roulette ? '?' : null, uses: P && P.item ? P.item.uses : 0, nitroEnabled: !!gp.options.nitro }, 'fast'); } catch (e2) { /* ignore */ }
    }
    function phoneOff() {
      var W = CB.input && CB.input.wheel, s = null;
      try { s = W && W.session ? W.session() : null; if (s && s.rx) s.rx.send('arcade', { on: false }, 'rel'); } catch (e) { /* ignore */ }
    }

    /* ---------------- session attach ---------------- */
    function attach(session) {
      L.session = session;
      var dbg = gp.findEngineDebug(session);
      if (dbg && dbg.A) gp.attachEngine(session, { wrapSnapshot: false });
      else {
        // stunt sessions (CB.arcade.stunt): track-space bridge, ARCADE-SPEC § 7 Gameplay layer
        var st = stuntBridge(session);
        if (st) { try { gp.setTrack(st.track, st.layout); } catch (e2) { /* ignore */ } }
        // special features (stunt-features.js) award nitro through this gameplay instance (stars, fire rings, bumpers …)
        if (session && typeof session.bindGameplay === 'function') { try { session.bindGameplay(gp); } catch (e3) { /* optional */ } }
        if (hud && st && st.starsTotal) hud.setStars(0, st.starsTotal);
      }
      if (fx) fx.setTrack(gp.track());
    }

    /** CB.arcade.stunt built track -> { track {length, pose, halfWidth}, layout (its pad / ring / box / coin / can features) } */
    function stuntBridge(session) {
      var T = null, SM = CB.arcade && CB.arcade.stunt;
      try {
        if (session && typeof session.gameplayTrack === 'function') { var g = session.gameplayTrack(); if (g && g.length) return { track: g, layout: g.features ? featureSpecs(g.features) : null }; }
        T = session && (session.stuntTrack || session.track && session.track.pointAt && session.track) || null;
        var id = session && (session.trackDef && session.trackDef.id || session.config && session.config.trackId);
        if (!T && SM && id && typeof SM.get === 'function') T = SM.get(id);
      } catch (e) { T = null; }
      if (!T || typeof T.pointAt !== 'function' || !(T.length > 0)) return null;
      var track = {
        length: T.length,
        halfWidth: function (s) { var sm = T.sample ? T.sample(s) : null; return sm ? sm.halfWidth : 6; },
        pose: function (s, lat) {
          var p = T.pointAt(s, lat, 0), sm = T.sample ? T.sample(s) : null, tg = sm && sm.tangent;
          // stunt world = GL axes (+Y up); gameplay / FX poses are sim axes (x, y = -z, z = up)
          return { x: p[0], y: -p[2], z: p[1], heading: tg ? Math.atan2(-tg[2], tg[0]) : 0, pos3: p, up3: sm && sm.up };
        }
      };
      var Fe = SM && SM.features, laps = num(session && session.config && session.config.laps, num(T.laps, 3)), stars = 0;
      try { stars = Fe && typeof Fe.index === 'function' ? Fe.index(T).starTotal * laps : 0; } catch (e3) { stars = 0; }
      return { track: track, layout: featureSpecs(T.features || []), starsTotal: stars };
    }
    /** the stunt session's own special-feature events ('stuntFx': BARREL ROLL!, WARP!, hazards, stars …) of a snapshot;
        each snapshot object is read once (race-ui may hand the same snap to drawHud twice when paused) */
    function stuntEvents(snap) {
      if (!snap || snap === L.lastSnap || !Array.isArray(snap.events)) return [];
      L.lastSnap = snap;
      var out = [];
      for (var i = 0; i < snap.events.length; i++) { var e = snap.events[i]; if (e && e.type === 'stuntFx') out.push(e); }
      return out;
    }
    function featureSpecs(list) {
      return list.filter(function (f) { return f && /^(box|pad|ring|coin|can)$/.test(f.type); })
        .map(function (f) { var o = { type: f.type, s: f.s, lat: num(f.lat, 0) }; ['z', 'len', 'w', 'r', 'row'].forEach(function (k) { if (f[k] != null) o[k] = f[k]; }); return o; });
    }

    var lastState = null, pendingEvents = [];
    function snapshot(snap) {
      var st = gp.decorate(snap, { key: null });
      if (st && st.events && st.events.length) pendingEvents = pendingEvents.concat(st.events);
      lastState = st;
      return st;
    }

    function stateFrom(snap) {
      var a = snap && snap.arcade;
      if (a && a.ext && a.ext.gameplay) return a.ext.gameplay;
      if (a && a.karts) return a;
      return lastState;
    }

    function drawHud(c2d, snap, view) {
      if (L.destroyed) return;
      view = view || {};
      var t = nowMs(), dt = L.last ? Math.min(0.1, (t - L.last) / 1000) : 0.016;
      L.last = t;
      updateInput();
      if (sfx && t - (L.muteT || 0) > 500) {   // follow race-ui's mute (button / M key), persisted in its settings
        L.muteT = t;
        var m = readMuted();
        if (m !== L.muted) { L.muted = m; sfx.setMuted(m); }
      }
      var st = stateFrom(snap);
      if (!st) return;
      if (view.renderer && view.renderer !== L.renderer) setRenderer(view.renderer);
      if (!L.touch && hasDOM) buildTouch(document.getElementById('race-root') || (c2d.canvas && c2d.canvas.parentNode));
      var me = st.player ? st.player.id : 'player';
      var ev = pendingEvents; pendingEvents = [];
      if (st.events && st.events !== ev && !ev.length) ev = st.events;
      var sev = stuntEvents(snap);
      if (sev.length) ev = ev.concat(sev);
      if (hud) hud.events(ev, me);
      if (fx) fx.events(ev, snap, st);
      // paused / menus: the sim clock stops -> silence the continuous layers (nitro roar, drift hiss)
      if (st.t !== L.lastSimT) { L.lastSimT = st.t; L.stillT = 0; } else L.stillT = (L.stillT || 0) + dt;
      if (sfx) { sfx.events(ev, me); sfx.frame(L.stillT > 0.25 ? null : st, dt); }
      var W = num(view.width, c2d.canvas ? c2d.canvas.clientWidth : 1280), H = num(view.height, c2d.canvas ? c2d.canvas.clientHeight : 720);
      if (fx) fx.draw(c2d, snap, st, W, H, dt);
      if (hud) hud.draw(c2d, st, W, H, dt);
      updateTouch(st.player);
      phoneStatus(st.player);
    }
    function setRenderer(r) { L.renderer = r || null; if (fx && r) fx.attachRenderer(r); }

    function entities() {
      var T = gp.track(), out = [];
      gp.entities().forEach(function (e) {
        if (e.respawn > 0) return;
        var p = T && typeof T.pose === 'function' ? T.pose(e.s, e.lat) : null;
        if (!p) return;
        var D = CB.arcade.items && CB.arcade.items.get(e.type === 'oil' ? 'oil' : e.type === 'rocket' ? 'rocket' : '');
        out.push({ id: e.id, type: e.type, x: p.x, y: p.y, z: p.z || 0, heading: p.heading || 0, radius: e.type === 'box' ? 1.6 : e.type === 'pad' ? 3.5 : e.type === 'ring' ? 2.8 : 1.4,
          color: e.type === 'box' ? '#ffffff' : e.type === 'pad' ? '#ff8a1f' : e.type === 'coin' ? '#ffcc33' : e.type === 'can' ? '#2f7bff' : D ? D.color : '#fff',
          glyph: e.type === 'box' ? '?' : e.type === 'coin' ? '$' : e.type === 'can' ? 'N' : '', drawnBy: 'arcade-fx' });
      });
      return out;
    }

    function results(r) {
      if (!r) return;
      var cars = {};
      gp.karts().forEach(function (K) { cars[K.id] = gp.stats(K.id); });
      r.arcade = r.arcade || {};
      r.arcade.gameplay = { player: gp.stats('player'), cars: cars, options: gp.options };
    }

    function destroy() {
      if (L.destroyed) return;
      L.destroyed = true;
      L.offs.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } });
      L.offs = [];
      phoneOff();
      if (fx) fx.destroy();
      if (sfx) sfx.destroy();
    }

    return {
      id: 'gameplay', gameplay: gp, hud: hud, fx: fx, sfx: sfx,
      hooks: [gp.hooks],
      // NOTE: no `entities` member on purpose — race-ui would draw fallback 2D markers on top of arcade-fx's projected
      // crates / pads; worldEntities() is there for a renderer that gains setEntities() (ARCADE-SPEC § Gameplay).
      attach: attach, snapshot: snapshot, drawHud: drawHud, setRenderer: setRenderer, worldEntities: entities, results: results,
      serialize: function () { return gp.serialize(); }, restore: function (s) { return gp.load(s); },
      reset: function () { gp.reset(); if (hud) hud.reset(); }, destroy: destroy,
      _layer: L, _input: pin
    };
  }

  var EXT = {
    id: 'gameplay', name: 'Nitro & items', order: 20, options: OPTIONS,
    appliesTo: function () { return true; },
    create: function (ctx) { return createInstance(ctx); }
  };
  var registered = false;
  function register() {
    if (registered) return true;
    var M = CB.arcade && CB.arcade.mode;
    if (!M || typeof M.registerExtension !== 'function') return false;
    M.registerExtension(EXT);
    registered = true;
    return true;
  }
  if (!register() && hasDOM) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', register);
    else setTimeout(register, 0);
  }

  CB.arcade.layer = { createInstance: createInstance, EXTENSION: EXT, OPTIONS: OPTIONS, register: register };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.arcade.layer;

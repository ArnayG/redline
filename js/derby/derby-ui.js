/* ==========================================================================
   Redline — js/derby/derby-ui.js
   CB.derby.ui : the #/derby route (docs/DERBY-SPEC.md §10) — setup (car, loadout garage with 3D preview, arena,
   match rules), the play loop (renderer or a 2D fallback, HUD, input, touch controls, slow-mo, spectate), pause and
   results. Registers itself on CB.router ('derby'). Test hooks: window.derby {start, state, step, setInput, end}.

     CB.derby.ui.enter(layer, params) / leave()     CB.derby.ui.state()
     CB.derby.ui._ : PURE helpers (Node): DEFAULTS, sanitizeSettings, createInput, hubSteer, rating, KEYS
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.derby = CB.derby || {};

(function () {
  'use strict';
  var hasDOM = typeof document !== 'undefined' && typeof window !== 'undefined' && typeof document.createElement === 'function';
  var LS_KEY = 'forge.derby.settings.v1';
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function approach(c, t, s) { return c < t ? Math.min(t, c + s) : Math.max(t, c - s); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function now() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function AC() { return CB.derby.accessories; }
  function AR() { return CB.derby.arenas; }

  /* ================================================================== settings (pure) */
  var DIFFS = ['rookie', 'amateur', 'pro', 'alien'];
  var QUALS = ['auto', 'low', 'medium', 'high'];
  var TIMES = [0, 120, 180, 300];
  var DEFAULTS = { source: 'preset', presetId: 'muscle', savedId: null, arenaId: 'mud-bowl', opponents: 7, difficulty: 'amateur', timeLimit_s: 0, lives: 1,
    accessories: ['ram', 'armour', 'nitro'], quality: 'auto', muted: false, slowmo: true, replays: true, haptics: true, touch: 'auto', camera: 'chase', showFps: false };
  function sanitizeSettings(s) {
    s = s && typeof s === 'object' ? s : {};
    var o = {};
    for (var k in DEFAULTS) o[k] = Array.isArray(DEFAULTS[k]) ? DEFAULTS[k].slice() : DEFAULTS[k];
    if (s.source === 'preset' || s.source === 'current' || s.source === 'saved') o.source = s.source;
    if (typeof s.presetId === 'string' && s.presetId) o.presetId = s.presetId;
    if (typeof s.savedId === 'string') o.savedId = s.savedId;
    var arenas = AR() ? AR().ids() : null;
    if (typeof s.arenaId === 'string' && (!arenas || arenas.indexOf(s.arenaId) >= 0)) o.arenaId = s.arenaId;
    if (isFinite(+s.opponents)) o.opponents = clamp(Math.round(+s.opponents), 3, 11);
    if (DIFFS.indexOf(s.difficulty) >= 0) o.difficulty = s.difficulty;
    if (TIMES.indexOf(+s.timeLimit_s) >= 0) o.timeLimit_s = +s.timeLimit_s;
    if (isFinite(+s.lives)) o.lives = clamp(Math.round(+s.lives), 1, 3);
    if (Array.isArray(s.accessories)) o.accessories = AC() ? AC().sanitize(s.accessories) : s.accessories.filter(function (x) { return typeof x === 'string'; });
    if (QUALS.indexOf(s.quality) >= 0) o.quality = s.quality;
    if (s.touch === 'auto' || s.touch === 'on' || s.touch === 'off') o.touch = s.touch;
    if (typeof s.camera === 'string') o.camera = s.camera;
    o.muted = !!s.muted; o.slowmo = s.slowmo !== false; o.replays = s.replays !== false; o.haptics = s.haptics !== false; o.showFps = !!s.showFps;
    return o;
  }
  function storage() { return CB.device && CB.device.storage ? CB.device.storage : null; }
  function loadSettings() {
    var raw = null;
    try { raw = storage() ? storage().get(LS_KEY) : (hasDOM && window.localStorage ? window.localStorage.getItem(LS_KEY) : null); } catch (e) { raw = null; }
    var o = null; try { o = raw ? JSON.parse(raw) : null; } catch (e2) { o = null; }
    return sanitizeSettings(o);
  }
  function saveSettings(s) {
    var v = JSON.stringify(sanitizeSettings(s));
    try { if (storage()) storage().set(LS_KEY, v); else if (hasDOM && window.localStorage) window.localStorage.setItem(LS_KEY, v); } catch (e) { /* blocked */ }
  }

  /** CB.input.hub steer is +1 = RIGHT; the derby sim is +1 = LEFT */
  function hubSteer(v) { return clamp(-num(v, 0), -1, 1) || 0; }

  /* ================================================================== input (keys / pad / touch / phone) */
  var KEYS = {
    held: { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
      Space: 'handbrake', KeyF: 'a1', KeyJ: 'a1', KeyG: 'a2', KeyK: 'a2', KeyR: 'reset', KeyB: 'lookBack',
      ShiftLeft: 'boost', ShiftRight: 'boost', KeyL: 'boost' },
    action: { KeyC: 'camera', Escape: 'pause', KeyP: 'pause', KeyM: 'mute', Enter: 'confirm', Tab: 'spectate' }
  };
  var RATE = { in: 10, out: 14, flip: 18 };
  function createInput(opts) {
    opts = opts || {};
    var I = {
      held: {}, kb: { steer: 0, throttle: 0, brake: 0 }, touch: { active: false, steer: 0, throttle: 0, brake: 0, handbrake: false, a1: false, a2: false, boost: false },
      gp: { active: false, steer: 0, throttle: 0, brake: 0, handbrake: false, a1: false, a2: false, boost: false, prev: [], any: false }, phone: { a1T: 0, a2: false, a2T: 0, nitro: false },
      boostAvail: false,
      forced: null, onAction: opts.onAction || function () {}, lastDevice: 'keyboard', enabled: true
    };
    I.handleKey = function (code, down, repeat) {
      if (!I.enabled) return false;
      var k = KEYS.held[code];
      if (k) { I.held[k] = !!down; if (down) I.lastDevice = 'keyboard'; return true; }
      var a = KEYS.action[code];
      if (a) { if (down && !repeat) I.onAction(a); return true; }
      return false;
    };
    I.clear = function () { I.held = {}; I.kb.steer = I.kb.throttle = I.kb.brake = 0; I.touch.steer = I.touch.throttle = I.touch.brake = 0; I.touch.a1 = I.touch.a2 = I.touch.handbrake = I.touch.boost = false; I.phone.a2 = false; I.phone.a1T = 0; I.phone.a2T = 0; I.phone.nitro = false; };
    I.pollPad = function () {
      var nav = typeof navigator !== 'undefined' ? navigator : null, pads = null;
      if (!nav || typeof nav.getGamepads !== 'function') return;
      try { pads = nav.getGamepads(); } catch (e) { return; }
      var gp = null; if (pads) for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) { gp = pads[i]; break; }
      if (!gp) { I.gp.active = false; return; }
      function b(n) { var x = gp.buttons && gp.buttons[n]; return x ? (typeof x === 'object' ? (x.value || (x.pressed ? 1 : 0)) : (x ? 1 : 0)) : 0; }
      var ax = gp.axes || [], sx = ax[0] || 0;
      sx = Math.abs(sx) < 0.08 ? 0 : (sx - Math.sign(sx) * 0.08) / 0.92;
      I.gp.steer = -sx; I.gp.throttle = b(7); I.gp.brake = b(6); I.gp.handbrake = b(0) > 0.5; I.gp.a1 = b(2) > 0.5; I.gp.a2 = b(1) > 0.5; I.gp.boost = b(5) > 0.5;
      I.gp.pad = gp;
      var pr = []; for (var k = 0; k < 17; k++) pr[k] = b(k) > 0.5;
      var pv = I.gp.prev;
      if (pr[3] && !pv[3]) I.onAction('camera');
      if (pr[9] && !pv[9]) I.onAction('pause');
      if (pr[14] && !pv[14]) I.onAction('specPrev');
      if (pr[15] && !pv[15]) I.onAction('specNext');
      if (pr[8] && !pv[8]) I.onAction('confirm');
      I.gp.anyEdge = pr.some(function (x, k) { return x && !pv[k]; });
      I.gp.prev = pr;
      I.gp.active = true;
      if (Math.abs(sx) > 0.1 || I.gp.throttle > 0.05 || I.gp.brake > 0.05) I.lastDevice = 'gamepad';
    };
    I.sample = function (dt) {
      if (I.forced) return Object.assign({ throttle: 0, brake: 0, steer: 0, handbrake: false, action1: false, action2: false, reset: false }, I.forced);
      I.pollPad();
      var h = I.held, target = (h.left ? 1 : 0) - (h.right ? 1 : 0), cur = I.kb.steer;
      var rate = target === 0 ? RATE.out : cur !== 0 && (target > 0) !== (cur > 0) ? RATE.flip : RATE.in;
      I.kb.steer = approach(cur, target, rate * dt);
      I.kb.throttle = approach(I.kb.throttle, h.up ? 1 : 0, (h.up ? 8 : 14) * dt);
      I.kb.brake = approach(I.kb.brake, h.down ? 1 : 0, (h.down ? 9 : 14) * dt);
      var steer = I.kb.steer, thr = I.kb.throttle, brk = I.kb.brake, hb = !!h.handbrake;
      var hub = CB.input && CB.input.hub, r = null;
      if (hub && typeof hub.read === 'function') { try { r = hub.read(); } catch (e) { r = null; } }
      var keysSteer = !!(h.left || h.right) || Math.abs(I.kb.steer) > 0.02;
      if (r && r.active) {
        if (!keysSteer) steer = hubSteer(r.steer);
        thr = Math.max(thr, clamp(num(r.throttle, 0), 0, 1)); brk = Math.max(brk, clamp(num(r.brake, 0), 0, 1)); hb = hb || !!r.handbrake;
      }
      if (I.gp.active) {
        if (Math.abs(I.gp.steer) > 0.02) steer = I.gp.steer;
        thr = Math.max(thr, I.gp.throttle); brk = Math.max(brk, I.gp.brake); hb = hb || I.gp.handbrake;
      }
      var T = I.touch;
      if (T.active) {
        if (Math.abs(T.steer) > 0.01) steer = T.steer;
        thr = Math.max(thr, T.throttle); brk = Math.max(brk, T.brake); hb = hb || T.handbrake;
      }
      if (I.phone.a1T > 0) I.phone.a1T -= dt;
      if (I.phone.a2T > 0) I.phone.a2T -= dt;
      // phone wheel NITRO (hold) = RAM BOOST when the sim has it, else ACTION 2 (older sims); ITEM swipe-down = ACTION 2 press
      var phoneBoost = I.boostAvail && I.phone.nitro, phoneA2 = (!I.boostAvail && I.phone.nitro) || I.phone.a2T > 0;
      return {
        throttle: clamp(thr, 0, 1), brake: clamp(brk, 0, 1), steer: clamp(steer, -1, 1), handbrake: hb,
        action1: !!(h.a1 || I.gp.a1 || T.a1 || I.phone.a1T > 0), action2: !!(h.a2 || I.gp.a2 || T.a2 || phoneA2), reset: !!h.reset, lookBack: !!h.lookBack,
        boost: !!(h.boost || I.gp.boost || T.boost || phoneBoost)
      };
    };
    I.phoneEvent = function (type) {
      if (type === 'item') I.phone.a1T = 0.16;
      else if (type === 'itemBack') { if (I.boostAvail) I.phone.a2T = 0.16; else I.phone.a1T = 0.16; }
      else if (type === 'nitroOn') I.phone.nitro = true;
      else if (type === 'nitroOff') I.phone.nitro = false;
    };
    return I;
  }

  /* ================================================================== car catalog */
  var specCache = {};
  function presetList() { return CB.data && Array.isArray(CB.data.presets) ? CB.data.presets : []; }
  function presetBuild(id) { try { return CB.data.presetBuild(id); } catch (e) { return CB.data && CB.data.defaultBuild ? CB.data.defaultBuild() : null; } }
  function specOf(key, build) {
    if (specCache[key]) return specCache[key];
    var s = null;
    try { s = CB.derby.physics.specFromBuild(build); } catch (e) { s = null; }
    specCache[key] = s;
    return s;
  }
  /** derby rating 1..5 per axis: toughness (mass), punch (power to weight), grip */
  function rating(spec) {
    if (!spec) return { tough: 3, punch: 3, overall: 3 };
    var tough = clamp(1 + (spec.mass - 1100) / 1500 * 4, 1, 5), punch = clamp(1 + (spec.pw - 100) / 600 * 4, 1, 5);
    return { tough: Math.round(tough * 2) / 2, punch: Math.round(punch * 2) / 2, overall: Math.round((tough * 0.6 + punch * 0.4) * 2) / 2 };
  }
  function savedBuilds() {
    var out = [];
    try { if (CB.state && typeof CB.state.listLocal === 'function') out = CB.state.listLocal().slice(0, 12); } catch (e) { out = []; }
    return out;
  }
  function currentBuild() { try { return CB.state && typeof CB.state.get === 'function' ? CB.state.get() : null; } catch (e) { return null; } }
  function buildName(b, fb) { return (b && b.meta && b.meta.name) || fb || 'My build'; }
  /** the player's build + display info for the current settings */
  function playerCar(S) {
    if (S.source === 'current') { var b = currentBuild(); if (b) return { build: b, name: buildName(b, 'Garage build'), presetId: null, key: 'current' }; }
    if (S.source === 'saved' && S.savedId) {
      var e = savedBuilds().filter(function (x) { return x.id === S.savedId; })[0];
      if (e && e.build) return { build: (CB.state.normalize ? CB.state.normalize(e.build) : e.build), name: e.name || buildName(e.build), presetId: null, key: 'saved:' + e.id };
    }
    var pid = S.presetId, p = presetList().filter(function (x) { return x.id === pid; })[0] || presetList()[0];
    return { build: p ? presetBuild(p.id) : null, name: p ? p.name : 'Car', presetId: p ? p.id : null, key: 'preset:' + (p ? p.id : '') };
  }
  function paintOf(b) { return (b && b.exterior && b.exterior.paint) || '#c0392b'; }

  /* ================================================================== icons */
  var ICON = {
    flame: '<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-7 1.5 1 2 2.5 2 4 1-2 1-4 1-7z"/>',
    ramp: '<path d="M3 18h18L6 9z"/><path d="M3 18v-2"/>',
    hammer: '<path d="M14 4l6 6-3 3-6-6z"/><path d="M12 9L4 17l3 3 8-8"/>',
    spikes: '<path d="M3 16h18M5 16l2-7 2 7M10 16l2-8 2 8M15 16l2-7 2 7"/>',
    ram: '<path d="M2 12h12M14 8h6v8h-6zM20 10l2 2-2 2"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    caltrops: '<path d="M12 4v8M5 18l7-6 7 6M7 9l5 3 5-3"/>',
    drop: '<path d="M12 3c3 5 6 8 6 11a6 6 0 0 1-12 0c0-3 3-6 6-11z"/>',
    magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z"/>',
    ball: '<circle cx="15" cy="15" r="6"/><path d="M3 4l3 3 2-1 2 3 2-1"/>',
    saw: '<circle cx="12" cy="12" r="3"/><path d="M12 2l2 4 4-2-1 4 4 2-4 2 1 4-4-2-2 4-2-4-4 2 1-4-4-2 4-2-1-4 4 2z"/>',
    bubble: '<circle cx="12" cy="12" r="9"/><path d="M8 9a5 5 0 0 1 4-3"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    plough: '<path d="M4 8h10v8H4zM14 10l6-2v8l-6-2"/>',
    play: '<path d="M7 4l13 8-13 8z"/>', pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z"/>', cam: '<path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="4"/>',
    back: '<path d="M15 18l-6-6 6-6"/>', next: '<path d="M9 18l6-6-6-6"/>', star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'
  };
  function icon(n, size) { return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON[n] || ICON.star) + '</svg>'; }

  /* ================================================================== styles */
  var CSS = [
    '.dd-root{position:relative;min-height:100%;color:var(--text);font-family:var(--font,system-ui,sans-serif);background:radial-gradient(1100px 520px at 18% -12%,var(--mode-derby-soft),transparent 62%),var(--bg)}',
    '.dd-setup{max-width:1500px;margin:0 auto;padding:var(--sp-5) max(var(--sp-4),env(safe-area-inset-right)) var(--sp-6) max(var(--sp-4),env(safe-area-inset-left));display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:var(--sp-5)}',
    '.dd-head{grid-column:1/-1;display:flex;align-items:flex-end;justify-content:space-between;gap:var(--sp-3);flex-wrap:wrap}',
    '.dd-kicker{font-size:var(--fs-2xs);letter-spacing:.2em;text-transform:uppercase;font-weight:700;color:var(--mode-derby)}',
    '.dd-title{font-family:var(--serif,Georgia,serif);font-size:var(--fs-3xl);font-weight:600;letter-spacing:-.02em;margin:var(--sp-1) 0 0;line-height:1.05;color:var(--text-strong,var(--text))}',
    '.dd-sub{color:var(--text-dim);font-size:var(--fs-sm,13px);margin-top:var(--sp-2);max-width:640px}',
    '.dd-headbar{display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap}',
    '.dd-sec{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-lg,14px);padding:var(--sp-4);margin-bottom:var(--sp-4)}',
    '.dd-sec h3{margin:0 0 var(--sp-3);font-size:var(--fs-2xs);letter-spacing:.2em;text-transform:uppercase;font-weight:700;color:var(--text-dim);display:flex;justify-content:space-between;align-items:center;gap:var(--sp-2);flex-wrap:wrap}',
    '.dd-sec h3 .t{display:inline-flex;align-items:center;gap:var(--sp-2);color:var(--text)}',
    '.dd-step{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:7px;font:800 11px var(--mono,monospace);letter-spacing:0;color:var(--mode-derby);background:var(--mode-derby-soft);border:1px solid color-mix(in srgb,var(--mode-derby) 35%,transparent)}',
    '.dd-tabs{margin-bottom:var(--sp-3)}.dd-tabs .cb-tab-list{display:inline-flex}.dd-tabs .cb-tab{flex:0 0 auto}',
    '.dd-segt{display:inline-flex;flex-wrap:wrap}.dd-segt .cb-tab{flex:0 0 auto;min-height:var(--control-h-sm,30px)}',
    '.dd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:var(--sp-2)}',
    '.dd-card{text-align:left;border:1px solid var(--line);background:var(--panel-2);color:var(--text);border-radius:var(--radius-sm,10px);padding:var(--sp-2) var(--sp-3);cursor:pointer;font:inherit;position:relative;min-height:var(--control-h-lg,46px);transition:border-color var(--dur-2,.15s),background var(--dur-2,.15s),box-shadow var(--dur-2,.15s)}',
    '.dd-card:hover{border-color:var(--line-2)}.dd-card.is-on{border-color:var(--mode-derby);box-shadow:0 0 0 1px var(--mode-derby) inset;background:linear-gradient(160deg,var(--mode-derby-soft),transparent 70%),var(--panel-2)}',
    '.dd-card:focus-visible{outline:none;box-shadow:var(--focus)}',
    '.dd-card.is-off{opacity:.42}.dd-card .n{font-weight:700;font-size:var(--fs-sm,13px);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dd-card .m{font-size:var(--fs-xs,11px);color:var(--text-dim);display:block;margin-top:2px}.dd-sw{display:inline-block;width:10px;height:10px;border-radius:3px;vertical-align:-1px;margin-right:6px;box-shadow:0 0 0 1px var(--line)}',
    '.dd-bars{display:grid;grid-template-columns:auto 1fr;gap:2px 6px;align-items:center;margin-top:6px;font-size:10px;color:var(--text-dim)}',
    '.dd-bar{height:4px;border-radius:2px;background:var(--line);overflow:hidden}.dd-bar i{display:block;height:100%;background:var(--mode-derby)}.dd-bar i.p{background:var(--accent)}',
    '.dd-acc{display:grid;grid-template-columns:34px 1fr;gap:4px var(--sp-2)}.dd-acc .ic{grid-row:span 2;width:34px;height:34px;border-radius:9px;display:grid;place-items:center;background:var(--panel-3,var(--bg-3))}',
    '.dd-acc .n{padding-right:30px}.dd-acc .pts{position:absolute;right:8px;top:9px;font:700 10px var(--mono,monospace);color:var(--accent)}',
    '.dd-badge{font-size:9px;font-weight:800;letter-spacing:.08em;border-radius:4px;padding:1px 5px;margin-left:4px;background:var(--mode-derby-soft);color:var(--mode-derby);border:1px solid color-mix(in srgb,var(--mode-derby) 40%,transparent);vertical-align:1px}',
    '.dd-slots{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:var(--sp-2);margin-bottom:var(--sp-3)}.dd-slot{border:1px dashed var(--line-2);border-radius:9px;padding:6px;font-size:10px;color:var(--text-dim);min-height:46px}',
    '.dd-slot b{display:block;color:var(--text);font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dd-slot.is-full{border-style:solid;border-color:color-mix(in srgb,var(--mode-derby) 55%,var(--line));background:var(--mode-derby-soft)}',
    '.dd-meter{display:flex;align-items:center;gap:var(--sp-2);font:700 12px var(--mono,monospace);letter-spacing:0;text-transform:none;color:var(--text)}.dd-meter .dd-bar{width:140px;height:6px}.dd-meter .dd-bar i{background:var(--accent)}.dd-meter.is-over{color:var(--bad)}.dd-meter.is-over .dd-bar i{background:var(--bad)}',
    '.dd-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:var(--sp-3)}.dd-chips .cb-btn{min-height:var(--control-h-sm,30px);border:1px solid var(--line);border-radius:var(--pill,999px)}.dd-chips .cb-btn:hover{border-color:color-mix(in srgb,var(--mode-derby) 45%,var(--line))}',
    '.dd-arenas{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}.dd-arena canvas{width:100%;height:96px;display:block;border-radius:7px;background:#0d0e11;margin-bottom:6px}',
    '.dd-pips{color:var(--mode-derby);font-size:10px;letter-spacing:1px}',
    '.dd-rows{display:grid;grid-template-columns:150px 1fr;gap:var(--sp-3) var(--sp-4);align-items:center;font-size:var(--fs-sm,13px)}.dd-rows label{color:var(--text-dim)}',
    '.dd-range{display:flex;align-items:center;gap:var(--sp-3)}.dd-range input{width:200px;accent-color:var(--accent)}',
    '.dd-side{position:sticky;top:var(--sp-3);align-self:start}.dd-prev{position:relative;height:250px;border-radius:var(--radius-lg,12px);overflow:hidden;background:radial-gradient(circle at 50% 70%,var(--panel-3,#2a2c33),var(--bg-2,#0d0e11));border:1px solid var(--line)}',
    '.dd-prev canvas{position:absolute;inset:0;width:100%;height:100%;display:block}.dd-sum{margin-top:var(--sp-3);font-size:var(--fs-sm,13px);line-height:1.55;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-lg,14px);padding:var(--sp-3) var(--sp-4)}',
    '.dd-sum h4{margin:0 0 var(--sp-1);font-family:var(--serif,Georgia,serif);font-weight:600;font-size:var(--fs-lg,18px)}.dd-sum .dd-k{color:var(--text-dim);font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;margin-right:4px}',
    '.dd-foot{position:sticky;bottom:0;z-index:20;display:flex;align-items:center;gap:var(--sp-4);padding:var(--sp-3) max(var(--sp-6),env(safe-area-inset-right)) max(var(--sp-3),env(safe-area-inset-bottom)) max(var(--sp-6),env(safe-area-inset-left));border-top:1px solid var(--line);background:var(--glass,rgba(18,19,23,.72));backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}',
    '.dd-foot-sum{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}.dd-foot-sum b{font-size:var(--fs-md,14px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dd-foot-sum span{font-size:var(--fs-xs,11.5px);color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dd-foot .dd-cta{display:flex;gap:var(--sp-2);align-items:center;flex:none}.dd-foot .rx-btn.big{min-width:200px;justify-content:center}',
    '.dd-root .cb-btn{min-height:var(--control-h-md,38px)}.dd-root .cb-btn.big,.dd-root .rx-btn.big{min-height:var(--control-h-lg,46px);padding:0 var(--sp-6);font-size:var(--fs-md,14px);letter-spacing:.04em}',
    '.dd-errs{color:var(--bad);font-size:12px;margin-top:6px}',
    '.dd-btn{border:1px solid var(--line);background:var(--panel-2);color:var(--text);border-radius:10px;padding:9px 14px;font:700 13px inherit;cursor:pointer;min-height:42px}',
    '.dd-btn.primary{background:var(--accent-grad,var(--accent));border-color:transparent;color:var(--accent-ink,#17130b)}',
    '.dd-play{position:fixed;inset:0;z-index:40;background:#000;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none}',
    '.dd-play canvas.dd-hud{position:absolute;left:0;top:0;width:100%;height:100%;display:block}',
    '.dd-load{position:absolute;inset:0;display:grid;place-items:center;background:#0b0b0d;color:#fff;font:800 15px system-ui;letter-spacing:.1em;z-index:5}',
    '.dd-t{position:absolute;z-index:4;display:grid;place-items:center;border-radius:14px;background:rgba(20,22,28,.55);border:1px solid rgba(255,255,255,.18);color:#fff;font:900 12px system-ui;letter-spacing:.06em;touch-action:none;-webkit-tap-highlight-color:transparent;overflow:hidden;text-align:center}',
    '.dd-t.is-down{background:rgba(224,65,47,.55);border-color:rgba(255,255,255,.4)}.dd-t .fill{position:absolute;left:0;right:0;bottom:0;height:0;background:rgba(255,255,255,.18)}',
    '.dd-t.round{border-radius:50%}.dd-t.act{background:rgba(255,177,58,.28);border-color:rgba(255,177,58,.75);font-size:10px;line-height:1.1;padding:4px}.dd-t.act.not-ready{opacity:.45}',
    '.dd-t .knob{position:absolute;top:50%;left:50%;width:54px;height:54px;margin:-27px 0 0 -27px;border-radius:50%;background:rgba(255,255,255,.28);border:2px solid rgba(255,255,255,.55)}',
    '.dd-t .chg{position:absolute;left:0;bottom:0;height:4px;background:#ffb13a}',
    '.dd-t.boost{background:rgba(30,90,180,.4);border:0;font-size:12px;letter-spacing:.1em}.dd-t.boost span{position:relative;z-index:2}',
    '.dd-t.boost .ring{position:absolute;inset:0;border-radius:50%;-webkit-mask:radial-gradient(circle,transparent 62%,#000 63%);mask:radial-gradient(circle,transparent 62%,#000 63%)}',
    '.dd-t.boost.is-ready{background:rgba(58,160,255,.6);box-shadow:0 0 18px rgba(58,160,255,.8)}.dd-t.boost.is-on{background:rgba(255,255,255,.75);color:#0b2a52}',
    '.dd-score{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;margin:var(--sp-3) 0}.dd-score div{background:var(--panel-2);border:1px solid var(--line);border-radius:9px;padding:7px 10px;font-size:12px;display:flex;justify-content:space-between}',
    '.dd-score b{color:var(--accent);font-family:var(--mono,monospace)}.dd-big{display:flex;gap:var(--sp-5);flex-wrap:wrap;margin:var(--sp-4) 0 var(--sp-1)}.dd-big div{font-size:var(--fs-2xs);color:var(--text-dim);letter-spacing:.2em;text-transform:uppercase;font-weight:700}',
    '.dd-big b{display:block;font:600 var(--fs-2xl)/1.15 var(--serif,Georgia,serif);color:var(--text-strong,var(--text));letter-spacing:-.01em;text-transform:none}.dd-big .gold b{color:var(--accent)}.dd-big .mvp b{max-width:340px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dd-ovl{position:absolute;inset:0;z-index:8;display:grid;place-items:center;background:rgba(5,5,8,.62);backdrop-filter:blur(3px)}',
    '.dd-menu{background:var(--panel,#141519);border:1px solid var(--line,#2b2c33);border-radius:16px;padding:18px;min-width:280px;max-width:92vw;display:grid;gap:8px}',
    '.dd-menu h2{margin:0 0 6px;font-size:20px;letter-spacing:.08em}',
    '.dd-spec{position:absolute;z-index:6;left:50%;transform:translateX(-50%);bottom:max(14px,env(safe-area-inset-bottom));display:flex;gap:8px}',
    '.dd-res{max-width:1100px;margin:0 auto;padding:var(--sp-6) max(var(--sp-4),env(safe-area-inset-right)) var(--sp-10) max(var(--sp-4),env(safe-area-inset-left));color:var(--text)}',
    '.dd-res h1{font-family:var(--serif,Georgia,serif);font-size:var(--fs-3xl);margin:var(--sp-1) 0 0;font-weight:600;letter-spacing:-.02em;line-height:1.08;color:var(--text-strong,var(--text))}.dd-res h1.win{color:var(--accent)}',
    '.dd-hl{display:flex;flex-wrap:wrap;gap:var(--sp-2);margin:var(--sp-4) 0}.dd-hl span{background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:8px 12px;font-size:13px}',
    '.dd-hl b{color:var(--accent)}.dd-tbl-wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-lg,14px)}.dd-tbl{width:100%;border-collapse:collapse;font-size:13px;min-width:720px}',
    '.dd-tbl th{text-align:left;font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--text-dim);padding:8px 10px;border-bottom:1px solid var(--line)}',
    '.dd-tbl td{padding:8px 10px;border-bottom:1px solid var(--line-soft)}.dd-tbl tr:last-child td{border-bottom:0}.dd-tbl tr.me td{background:var(--mode-derby-soft)}.dd-tbl .num{font-variant-numeric:tabular-nums;text-align:right}',
    '.dd-actions{display:flex;gap:var(--sp-3);flex-wrap:wrap;margin-top:var(--sp-5)}',
    '@media (max-width:980px){.dd-setup{grid-template-columns:minmax(0,1fr)}.dd-side{position:static;order:-1}.dd-prev{height:200px}}',
    '@media (max-width:640px){.dd-foot{flex-wrap:wrap;gap:var(--sp-2);padding-left:max(var(--sp-4),env(safe-area-inset-left));padding-right:max(var(--sp-4),env(safe-area-inset-right))}.dd-foot .dd-cta{width:100%}.dd-foot .dd-cta .rx-btn.big{flex:1;min-width:0}}',
    '@media (max-width:600px){.dd-meter .dd-bar{width:72px}.dd-sec h3{letter-spacing:.14em}.dd-rows{grid-template-columns:1fr}.dd-slots{grid-template-columns:repeat(3,minmax(0,1fr))}.dd-title{font-size:var(--fs-2xl)}.dd-res h1{font-size:var(--fs-2xl)}.dd-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}}',
    '@media (max-width:560px){.dd-back .lbl{display:none}.dd-back{padding:0 var(--sp-3)}}',
    '@media (pointer:coarse){.dd-root .cb-btn,.dd-root .cb-tab,.dd-card{min-height:var(--touch-min,44px)}.dd-segt .cb-tab,.dd-chips .cb-btn{min-height:40px}}',
    '@media (max-height:500px) and (orientation:landscape){.dd-prev{height:150px}.dd-setup{padding-top:var(--sp-3)}.dd-foot{padding-top:var(--sp-2);padding-bottom:max(var(--sp-2),env(safe-area-inset-bottom))}.dd-foot .dd-cta{width:auto}}'
  ].join('\n');
  function injectStyles() {
    if (!hasDOM || document.getElementById('dd-styles')) return;
    var st = document.createElement('style'); st.id = 'dd-styles'; st.textContent = CSS; document.head.appendChild(st);
  }

  CB.derby.ui = CB.derby.ui || {};
  CB.derby.ui._ = { DEFAULTS: DEFAULTS, sanitizeSettings: sanitizeSettings, createInput: createInput, hubSteer: hubSteer, rating: rating, KEYS: KEYS, RATE: RATE, LS_KEY: LS_KEY, playerCar: playerCar, ICON: ICON };
  CB.derby.ui._parts = { clamp: clamp, num: num, esc: esc, now: now, AC: AC, AR: AR, loadSettings: loadSettings, saveSettings: saveSettings, presetList: presetList, presetBuild: presetBuild,
    specOf: specOf, savedBuilds: savedBuilds, currentBuild: currentBuild, buildName: buildName, paintOf: paintOf, icon: icon, injectStyles: injectStyles, hasDOM: hasDOM, DIFFS: DIFFS, QUALS: QUALS, TIMES: TIMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.derby.ui;
})();

/* ---------------------------------------------------------------------------------------------------------------
   CB.derby.ui (browser part): setup screen, play loop, pause, results, route registration.
   --------------------------------------------------------------------------------------------------------------- */
(function () {
  'use strict';
  var P = CB.derby.ui._parts, X = CB.derby.ui._;
  if (!P || !P.hasDOM) return;
  var clamp = P.clamp, num = P.num, esc = P.esc, icon = P.icon, AC = P.AC, AR = P.AR;
  var U = { layer: null, root: null, screen: null, S: null, preview: null, R: null, params: {}, offs: [] };

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v; else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null || c === false) continue; if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); }); else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return el;
  }
  function persist() { P.saveSettings(U.S); }
  function DEFAULTS_ACC() { return X.DEFAULTS.accessories.slice(); }
  function safe(fn) { try { return fn(); } catch (e) { if (typeof console !== 'undefined') console.warn('[derby-ui]', e); return null; } }
  function router() { return CB.router || null; }
  function setDriving(on) { var r = router(); if (r && r.setDriving) r.setDriving(on); }
  function seg(opts, val, onPick) {
    var w = h('div', { class: 'cb-tab-list dd-segt', role: 'group' });
    opts.forEach(function (o) {
      w.appendChild(h('button', { type: 'button', class: 'cb-tab' + (o.v === val ? ' is-active' : ''), 'aria-pressed': o.v === val ? 'true' : 'false', text: o.t,
        onclick: function () { onPick(o.v); } }));
    });
    return w;
  }

  /* ================================================================== SETUP */
  function showSetup() {
    teardownPlay();
    U.screen = 'setup';
    setDriving(false);
    var S = U.S;
    var root = U.root; root.innerHTML = '';
    var wrap = h('div', { class: 'dd-setup' });
    root.appendChild(wrap);
    wrap.appendChild(h('div', { class: 'dd-head' },
      h('div', null, h('div', { class: 'dd-kicker', text: 'Demolition Derby · last car standing' }), h('h1', { class: 'dd-title', text: 'Wreck them all' }),
        h('div', { class: 'dd-sub', text: 'Pick a car, bolt on weapons, wreck everyone. Where you get hit changes how you drive.' })),
      h('div', { class: 'dd-headbar' },
        (CB.input && CB.input.ui && typeof CB.input.ui.openPairing === 'function') ? h('button', { class: 'cb-btn ghost', type: 'button', html: icon('cam', 14) + ' Controls', title: 'Controls / phone wheel', onclick: function () { safe(function () { CB.input.ui.openPairing(); }); } }) : null,
        h('button', { class: 'cb-btn ghost dd-back', type: 'button', 'aria-label': 'Main menu', html: icon('back', 16) + '<span class="lbl">Main menu</span>', onclick: function () { var r = router(); if (r) r.go('menu'); } }))));
    var main = h('div'), side = h('div', { class: 'dd-side' });
    wrap.appendChild(main); wrap.appendChild(side);
    U.mainEl = main;
    fillMain();
    side.appendChild(sidePanel());
    root.appendChild(footer());
    updateSum();
    refreshPreview();
  }
  function fillMain() {
    var main = U.mainEl; main.innerHTML = '';
    main.appendChild(carSection());
    main.appendChild(loadoutSection());
    main.appendChild(arenaSection());
    main.appendChild(matchSection());
  }
  function rerender() {
    if (U.screen !== 'setup' || !U.mainEl) return;
    var y = window.scrollY; fillMain(); window.scrollTo(0, y);
    updateSum(); refreshPreview();
    var go = U.root.querySelector('[data-dd="start"]'); if (go) go.disabled = !AC().validate(U.S.accessories).ok;
  }

  function carSection() {
    var S = U.S, sec = h('section', { class: 'dd-sec', 'aria-label': 'Car' });
    sec.appendChild(h('h3', null, h('span', { class: 't', html: '<span class="dd-step">1</span>Car' }), h('span', { class: 'dd-sub', style: { margin: 0, textTransform: 'none', letterSpacing: 0 }, text: 'Heavy = tough · power = punch' })));
    var tabs = h('div', { class: 'dd-tabs' }), tl = h('div', { class: 'cb-tab-list', role: 'tablist' });
    tabs.appendChild(tl);
    var mine = S.source !== 'preset';
    var showMine0 = U.carTab ? U.carTab === 'mine' : mine;
    tl.appendChild(h('button', { type: 'button', role: 'tab', 'aria-selected': !showMine0 ? 'true' : 'false', class: 'cb-tab' + (!showMine0 ? ' is-active' : ''), text: 'Presets (' + P.presetList().length + ')', onclick: function () { U.carTab = 'preset'; rerender(); } }));
    tl.appendChild(h('button', { type: 'button', role: 'tab', 'aria-selected': showMine0 ? 'true' : 'false', class: 'cb-tab' + (showMine0 ? ' is-active' : ''), text: 'My Cars', onclick: function () { U.carTab = 'mine'; rerender(); } }));
    sec.appendChild(tabs);
    var grid = h('div', { class: 'dd-grid' });
    var showMine = U.carTab ? U.carTab === 'mine' : mine;
    if (!showMine) {
      P.presetList().forEach(function (p) {
        var b = P.presetBuild(p.id), sp = P.specOf('preset:' + p.id, b), rt = X.rating(sp);
        var on = S.source === 'preset' && S.presetId === p.id;
        grid.appendChild(carCard(p.name, b, sp, rt, on, function () { S.source = 'preset'; S.presetId = p.id; persist(); rerender(); }));
      });
    } else {
      var cur = P.currentBuild();
      if (cur) { var sp0 = P.specOf('current', cur); grid.appendChild(carCard(P.buildName(cur, 'Garage build') + ' (current)', cur, sp0, X.rating(sp0), S.source === 'current', function () { S.source = 'current'; persist(); rerender(); })); }
      P.savedBuilds().forEach(function (e) {
        var sp1 = P.specOf('saved:' + e.id, e.build);
        grid.appendChild(carCard(e.name || P.buildName(e.build), e.build, sp1, X.rating(sp1), S.source === 'saved' && S.savedId === e.id, function () { S.source = 'saved'; S.savedId = e.id; persist(); rerender(); }));
      });
      if (!grid.children.length) grid.appendChild(h('div', { class: 'dd-sub', text: 'No saved builds yet — build one in the Garage, or pick a preset.' }));
    }
    sec.appendChild(grid);
    return sec;
  }
  function carCard(name, b, sp, rt, on, pick) {
    var hp = sp ? Math.round(sp.powerKw / 0.7457) : '—', kg = sp ? Math.round(sp.baseMass) : '—';
    return h('button', { type: 'button', class: 'dd-card' + (on ? ' is-on' : ''), 'aria-pressed': on ? 'true' : 'false', onclick: pick },
      h('span', { class: 'n' }, h('span', { class: 'dd-sw', style: { background: P.paintOf(b) } }), name),
      h('span', { class: 'm', text: hp + ' hp · ' + kg + ' kg · ' + (sp ? sp.drive.toUpperCase() : '') + (sp && sp.enginePos !== 'front' ? ' · ' + sp.enginePos + '-engine' : '') }),
      h('span', { class: 'dd-bars' }, 'Tough', h('span', { class: 'dd-bar' }, h('i', { style: { width: (rt.tough / 5 * 100) + '%' } })),
        'Punch', h('span', { class: 'dd-bar' }, h('i', { class: 'p', style: { width: (rt.punch / 5 * 100) + '%' } }))));
  }

  function loadoutSection() {
    var S = U.S, A = AC(), sec = h('section', { class: 'dd-sec', 'aria-label': 'Accessories loadout' });
    var v = A.validate(S.accessories);
    var meter = h('span', { class: 'dd-meter' + (v.points > v.budget ? ' is-over' : '') }, v.points + ' / ' + v.budget + ' pts',
      h('span', { class: 'dd-bar' }, h('i', { style: { width: Math.min(100, v.points / v.budget * 100) + '%' } })), '+' + v.mass + ' kg');
    sec.appendChild(h('h3', null, h('span', { class: 't', html: '<span class="dd-step">2</span>Accessories loadout' }), meter));
    // slots
    var slots = h('div', { class: 'dd-slots' }), fitted = {};
    S.accessories.forEach(function (id) { var d = A.DEFS[id]; if (d) (fitted[d.slot] = fitted[d.slot] || []).push(d); });
    ['front', 'rear', 'roof', 'side', 'util', 'util'].forEach(function (s, i) {
      var list = fitted[s] || [], d = s === 'util' ? list[i === 4 ? 0 : 1] : list[0];
      var btn = d ? A.validate(S.accessories).actives.indexOf(d.id) : -1;
      slots.appendChild(h('div', { class: 'dd-slot' + (d ? ' is-full' : '') }, A.SLOT_NAMES[s], h('b', { html: d ? esc(d.name) + (btn >= 0 ? '<span class="dd-badge">A' + (btn + 1) + '</span>' : '') : '—' })));
    });
    sec.appendChild(slots);
    var chips = h('div', { class: 'dd-chips' });
    A.PRESETS.forEach(function (pr) { chips.appendChild(h('button', { type: 'button', class: 'cb-btn ghost small', text: pr.name, title: pr.items.map(function (i) { return A.DEFS[i].name; }).join(' + ') || 'No accessories', onclick: function () { S.accessories = A.sanitize(pr.items); persist(); rerender(); } })); });
    sec.appendChild(chips);
    var grid = h('div', { class: 'dd-grid' });
    A.LIST.forEach(function (d) {
      var on = S.accessories.indexOf(d.id) >= 0;
      var test = on ? null : A.validate(S.accessories.concat([d.id]));
      var blocked = test && !test.ok;
      var ai = v.actives.indexOf(d.id);
      grid.appendChild(h('button', { type: 'button', class: 'dd-card dd-acc' + (on ? ' is-on' : '') + (blocked ? ' is-off' : ''), 'aria-pressed': on ? 'true' : 'false',
        title: d.desc + (blocked ? '\n\n' + test.errors.join(' · ') : ''),
        onclick: function () {
          if (on) S.accessories = S.accessories.filter(function (x) { return x !== d.id; });
          else {
            var next = S.accessories.concat([d.id]);
            if (!A.validate(next).ok) {
              // swap out whatever occupies the slot, then retry
              next = S.accessories.filter(function (x) { return A.DEFS[x].slot !== d.slot || d.slot === 'util'; }).concat([d.id]);
              if (!A.validate(next).ok) { toast(A.validate(next).errors[0] || 'Does not fit'); return; }
            }
            S.accessories = next;
          }
          persist(); rerender();
        } },
        h('span', { class: 'ic', style: { color: d.color }, html: icon(d.icon, 20) }),
        h('span', { class: 'n', html: esc(d.name) + (d.active ? '<span class="dd-badge">' + (on && ai >= 0 ? 'A' + (ai + 1) : 'ACTION') + '</span>' : '') }),
        h('span', { class: 'm', text: A.SLOT_NAMES[d.slot] + ' · ' + d.mass + ' kg · ' + d.short }),
        h('span', { class: 'pts', text: d.points + ' pt' })));
    });
    sec.appendChild(grid);
    if (v.errors.length) sec.appendChild(h('div', { class: 'dd-errs', text: v.errors.join(' · ') }));
    sec.appendChild(h('div', { class: 'dd-sub', html: 'ACTION 1 = <b>F</b> / <b>J</b> · pad X · ACTION 2 = <b>G</b> / <b>K</b> · pad B · touch buttons · phone wheel ITEM / NITRO' }));
    return sec;
  }

  function arenaSection() {
    var S = U.S, sec = h('section', { class: 'dd-sec', 'aria-label': 'Arena' });
    sec.appendChild(h('h3', null, h('span', { class: 't', html: '<span class="dd-step">3</span>Arena' })));
    var grid = h('div', { class: 'dd-grid dd-arenas' });
    AR().list().forEach(function (a) {
      var cv = h('canvas', { width: 420, height: 192, 'aria-hidden': 'true' });
      var on = S.arenaId === a.id;
      grid.appendChild(h('button', { type: 'button', class: 'dd-card dd-arena' + (on ? ' is-on' : ''), 'aria-pressed': on ? 'true' : 'false', onclick: function () { S.arenaId = a.id; persist(); rerender(); } },
        cv, h('span', { class: 'n', text: a.name }),
        h('span', { class: 'm' }, h('span', { class: 'dd-pips', text: '●●●●●'.slice(0, a.difficulty) + '○○○○○'.slice(a.difficulty) }), ' · ' + a.timeOfDay + ' · ' + a.surface.kind),
        h('span', { class: 'm', text: a.tagline })));
      setTimeout(function () { drawThumb(cv, a); }, 0);
    });
    sec.appendChild(grid);
    return sec;
  }
  function drawThumb(cv, a) {
    var c = cv.getContext && cv.getContext('2d'), HD = CB.derby.hud;
    if (!c || !HD) return;
    c.fillStyle = '#0d0e11'; c.fillRect(0, 0, cv.width, cv.height);
    HD.drawMinimap(c, a, [], { x: 0, y: 0, w: cv.width, h: cv.height }, { noPanel: true, ground: a.surface.color });
    // spawn ring
    var B = a.bounds, sc = Math.min((cv.width - 12) / (B.maxX - B.minX), (cv.height - 12) / (B.maxY - B.minY));
    c.fillStyle = 'rgba(255,255,255,.75)';
    a.spawns.forEach(function (s) { c.beginPath(); c.arc(cv.width / 2 + (s.x - (B.minX + B.maxX) / 2) * sc, cv.height / 2 - (s.y - (B.minY + B.maxY) / 2) * sc, 2.2, 0, Math.PI * 2); c.fill(); });
  }

  function matchSection() {
    var S = U.S, sec = h('section', { class: 'dd-sec', 'aria-label': 'Match rules' });
    sec.appendChild(h('h3', null, h('span', { class: 't', html: '<span class="dd-step">4</span>Match' })));
    var rows = h('div', { class: 'dd-rows' });
    var oppVal = h('b', { text: S.opponents + ' AI' });
    var rng = h('input', { type: 'range', min: 3, max: 11, step: 1, value: S.opponents, 'aria-label': 'Opponents', oninput: function (e) { S.opponents = +e.target.value; oppVal.textContent = S.opponents + ' AI'; persist(); updateSum(); } });
    rows.appendChild(h('label', { text: 'Opponents' })); rows.appendChild(h('div', { class: 'dd-range' }, rng, oppVal));
    rows.appendChild(h('label', { text: 'AI aggression' })); rows.appendChild(seg([{ v: 'rookie', t: 'Rookie' }, { v: 'amateur', t: 'Amateur' }, { v: 'pro', t: 'Pro' }, { v: 'alien', t: 'Alien' }], S.difficulty, function (v) { S.difficulty = v; persist(); rerender(); }));
    rows.appendChild(h('label', { text: 'Time limit' })); rows.appendChild(seg([{ v: 0, t: 'Off' }, { v: 120, t: '2 min' }, { v: 180, t: '3 min' }, { v: 300, t: '5 min' }], S.timeLimit_s, function (v) { S.timeLimit_s = v; persist(); rerender(); }));
    rows.appendChild(h('label', { text: 'Lives' })); rows.appendChild(seg([{ v: 1, t: '1' }, { v: 2, t: '2' }, { v: 3, t: '3' }], S.lives, function (v) { S.lives = v; persist(); rerender(); }));
    rows.appendChild(h('label', { text: 'Graphics' })); rows.appendChild(seg([{ v: 'auto', t: 'Auto' }, { v: 'low', t: 'Low' }, { v: 'medium', t: 'Medium' }, { v: 'high', t: 'High' }], S.quality, function (v) { S.quality = v; persist(); rerender(); }));
    rows.appendChild(h('label', { text: 'Big-hit slow-mo' })); rows.appendChild(seg([{ v: true, t: 'On' }, { v: false, t: 'Off' }], S.slowmo, function (v) { S.slowmo = v; persist(); rerender(); }));
    rows.appendChild(h('label', { text: 'Takedown replays' })); rows.appendChild(seg([{ v: true, t: 'On' }, { v: false, t: 'Off' }], S.replays, function (v) { S.replays = v; persist(); rerender(); }));
    rows.appendChild(h('label', { text: 'Rumble / haptics' })); rows.appendChild(seg([{ v: true, t: 'On' }, { v: false, t: 'Off' }], S.haptics, function (v) { S.haptics = v; persist(); rerender(); }));
    rows.appendChild(h('label', { text: 'Sound' })); rows.appendChild(seg([{ v: false, t: 'On' }, { v: true, t: 'Muted' }], S.muted, function (v) { S.muted = v; persist(); rerender(); }));
    rows.appendChild(h('label', { text: 'Touch controls' })); rows.appendChild(seg([{ v: 'auto', t: 'Auto' }, { v: 'on', t: 'On' }, { v: 'off', t: 'Off' }], S.touch, function (v) { S.touch = v; persist(); rerender(); }));
    sec.appendChild(rows);
    return sec;
  }

  function sidePanel() {
    var S = U.S, box = h('div');
    var cv = h('canvas', { class: 'dd-prev-cv', 'aria-label': 'Car preview' });
    box.appendChild(h('div', { class: 'dd-prev' }, cv));
    U.prevCanvas = cv;
    U.sumEl = h('div', { class: 'dd-sum' });
    box.appendChild(U.sumEl);
    return box;
  }
  /** sticky footer (like the race setup's .rx-footer): session summary + Quick derby + the gold Start CTA, always reachable */
  function footer() {
    var S = U.S, v = AC().validate(S.accessories);
    U.footSum = h('div', { class: 'dd-foot-sum' });
    return h('div', { class: 'dd-foot' }, U.footSum,
      h('div', { class: 'dd-cta' },
        h('button', { class: 'cb-btn ghost big', type: 'button', 'data-dd': 'quick', html: icon('bolt', 16) + ' Quick derby', title: 'Your last car and loadout on a random arena', onclick: function () {
          var ids = AR().ids(); if (!AC().validate(S.accessories).ok) S.accessories = AC().sanitize(DEFAULTS_ACC());
          S.arenaId = ids[Math.floor(Math.random() * ids.length)] || S.arenaId; persist(); startMatch(); } }),
        h('button', { class: 'cb-btn primary rx-btn big', type: 'button', disabled: v.ok ? null : true, 'data-dd': 'start', html: icon('play', 16) + ' Start derby', onclick: function () { startMatch(); } })));
  }
  function updateSum() {
    if (!U.sumEl) return;
    var S = U.S, car = X.playerCar(S), a = AR().get(S.arenaId), v = AC().validate(S.accessories), A = AC();
    if (U.footSum) U.footSum.innerHTML = '<b>' + esc(car.name) + ' · ' + esc(a ? a.name : '') + '</b><span>' + (S.opponents + 1) + ' cars · ' + esc((CB.derby.session.DIFFICULTY[S.difficulty] || {}).label || S.difficulty) +
      ' · ' + v.points + ' / ' + v.budget + ' pts' + (S.timeLimit_s ? ' · ' + S.timeLimit_s / 60 + ' min' : '') + (S.lives > 1 ? ' · ' + S.lives + ' lives' : '') + '</span>';
    var acts = v.actives.map(function (id, i) { return 'A' + (i + 1) + ' ' + A.DEFS[id].name; });
    var pas = S.accessories.filter(function (id) { return !A.DEFS[id].active; }).map(function (id) { return A.DEFS[id].name; });
    U.sumEl.innerHTML = '<h4>' + esc(car.name) + '</h4>' +
      '<div><span class="dd-k">Arena</span> ' + esc(a ? a.name : '') + ' · ' + (S.opponents + 1) + ' cars · ' + esc(S.difficulty) + '</div>' +
      '<div><span class="dd-k">Actions</span> ' + (acts.length ? esc(acts.join(' · ')) : '—') + '</div>' +
      '<div><span class="dd-k">Passive</span> ' + (pas.length ? esc(pas.join(' · ')) : '—') + '</div>' +
      '<div><span class="dd-k">Rules</span> last car standing' + (S.timeLimit_s ? ' · ' + S.timeLimit_s / 60 + ' min' : '') + (S.lives > 1 ? ' · ' + S.lives + ' lives' : '') + '</div>';
  }
  function refreshPreview() {
    var cv = U.prevCanvas; if (!cv || !cv.isConnected) return;
    var S = U.S, car = X.playerCar(S), opts = { build: car.build, color: P.paintOf(car.build), accessories: S.accessories.slice(), number: 1 };
    var DR = CB.derby.renderer;
    if (U.preview && U.preview.canvas !== cv) { safe(function () { U.preview.destroy(); }); U.preview = null; }
    if (!U.preview && DR && typeof DR.createPreview === 'function' && !U.noGL) {
      var pv = safe(function () { return DR.createPreview(cv, opts); });
      if (pv && pv.ok !== false) { pv.canvas = cv; U.preview = pv; return; }
      U.noGL = true;
    }
    if (U.preview) { safe(function () { U.preview.update(opts); }); return; }
    draw2DPreview(cv, opts);
  }
  /** fallback: top-down car with its accessories */
  function draw2DPreview(cv, o) {
    var r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
    var c = cv.getContext('2d'); if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var W = r.width, H = r.height, sc = Math.min(W / 9, H / 6.5);
    c.translate(W / 2, H / 2); c.scale(sc, sc);
    var L = 4.5, Wd = 1.9, has = function (id) { return o.accessories.indexOf(id) >= 0; };
    c.fillStyle = 'rgba(0,0,0,.4)'; c.fillRect(-L / 2 + 0.1, -Wd / 2 + 0.15, L, Wd);
    c.fillStyle = o.color; CB.derby.hud.roundRect(c, -L / 2, -Wd / 2, L, Wd, 0.4); c.fill();
    c.fillStyle = 'rgba(15,20,28,.85)'; c.fillRect(-0.6, -Wd / 2 + 0.2, 1.6, Wd - 0.4);
    c.fillStyle = '#111'; [[1.35, 1], [1.35, -1], [-1.35, 1], [-1.35, -1]].forEach(function (p) { c.fillRect(p[0] - 0.36, p[1] - 0.14, 0.72, 0.28); });
    c.strokeStyle = '#ccc'; c.lineWidth = 0.08; c.fillStyle = '#9aa';
    if (has('ram')) c.fillRect(L / 2, -0.25, 1.0, 0.5);
    if (has('ramp')) { c.beginPath(); c.moveTo(L / 2, -Wd / 2); c.lineTo(L / 2 + 0.5, -Wd / 2 - 0.1); c.lineTo(L / 2 + 0.5, Wd / 2 + 0.1); c.lineTo(L / 2, Wd / 2); c.fill(); }
    if (has('bullbar')) { c.beginPath(); c.moveTo(L / 2 + 0.2, -Wd / 2); c.lineTo(L / 2 + 0.2, Wd / 2); c.stroke(); }
    if (has('spikes')) { c.fillRect(-L / 2 - 0.3, -Wd / 2, 0.3, Wd); }
    if (has('flamethrower')) { c.fillStyle = '#ff7a1a'; c.fillRect(0.2, -0.12, 1.2, 0.24); }
    if (has('magnet')) { c.fillStyle = '#d24a4a'; c.beginPath(); c.arc(0, 0, 0.45, 0, Math.PI * 2); c.fill(); }
    if (has('hammer')) { c.fillStyle = '#a8adb5'; c.fillRect(0.1, Wd / 2, 0.2, 1.4); c.fillRect(-0.15, Wd / 2 + 1.2, 0.7, 0.45); }
    if (has('wrecking-ball')) { c.beginPath(); c.moveTo(-L / 2, 0); c.lineTo(-L / 2 - 2.2, 0.6); c.stroke(); c.fillStyle = '#3c3f44'; c.beginPath(); c.arc(-L / 2 - 2.5, 0.65, 0.45, 0, Math.PI * 2); c.fill(); }
    if (has('armour')) { c.strokeStyle = '#6d737c'; c.lineWidth = 0.14; CB.derby.hud.roundRect(c, -L / 2 - 0.05, -Wd / 2 - 0.05, L + 0.1, Wd + 0.1, 0.4); c.stroke(); }
    if (has('shield')) { c.strokeStyle = 'rgba(122,215,255,.6)'; c.lineWidth = 0.06; c.beginPath(); c.arc(0, 0, 2.9, 0, Math.PI * 2); c.stroke(); }
  }
  function toast(msg) { if (CB.ui && typeof CB.ui.toast === 'function') CB.ui.toast(msg, 'info'); else if (typeof console !== 'undefined') console.info('[derby] ' + msg); }

  CB.derby.ui._app = { U: U, h: h, showSetup: showSetup, safe: safe, setDriving: setDriving, toast: toast, persist: persist, seg: seg, router: router, refreshPreview: refreshPreview, teardownPlay: function () { teardownPlay(); } };
  function teardownPlay() { if (CB.derby.ui._app.teardown) CB.derby.ui._app.teardown(); }
  function startMatch(o) { CB.derby.ui._app.startMatch(o); }
})();

/* ---------------------------------------------------------------------------------------------------------------
   CB.derby.ui (browser part 2): play loop, 2D fallback renderer, touch controls, pause, results, routes, hooks.
   --------------------------------------------------------------------------------------------------------------- */
(function () {
  'use strict';
  var P = CB.derby.ui._parts, X = CB.derby.ui._, APP = CB.derby.ui._app;
  if (!P || !P.hasDOM || !APP) return;
  var clamp = P.clamp, num = P.num, esc = P.esc, icon = P.icon, AC = P.AC, AR = P.AR, h = APP.h, safe = APP.safe, U = APP.U;

  function quality() {
    var q = U.S.quality;
    if (q === 'auto') q = CB.device && typeof CB.device.resolveQuality === 'function' ? safe(function () { return CB.device.resolveQuality('auto'); }) || 'high' : 'high';
    return ['low', 'medium', 'high', 'ultra'].indexOf(q) >= 0 ? q : 'high';
  }
  function coarse() { try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; } }
  function touchOn() { return U.S.touch === 'on' || (U.S.touch === 'auto' && coarse()); }
  function safeInsets() {
    var p = document.createElement('div');
    p.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(p);
    var cs = getComputedStyle(p), o = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
    p.parentNode.removeChild(p);
    return o;
  }

  /* ================================================================== START */
  function startMatch(o) {
    o = o || {};
    APP.teardown();
    if (U.preview) { safe(function () { U.preview.destroy(); }); U.preview = null; }
    var S = U.S;
    var car = X.playerCar(S);
    var cfg = {
      arenaId: S.arenaId, seed: num(o.seed, (Date.now() & 0x7fffffff) || 1), difficulty: S.difficulty, opponents: S.opponents,
      rules: { timeLimit_s: S.timeLimit_s, lives: S.lives, teams: false },
      player: { build: car.build, presetId: car.presetId, name: 'You', color: P.paintOf(car.build), accessories: S.accessories.slice() }
    };
    U.screen = 'play';
    APP.setDriving(true);
    var root = U.root; root.innerHTML = '';
    var play = h('div', { class: 'dd-play' });
    var cv = h('canvas', { class: 'dd-hud' });
    var load = h('div', { class: 'dd-load', text: 'LOADING ' + (AR().get(S.arenaId) || {}).name.toUpperCase() + '…' });
    play.appendChild(cv); play.appendChild(load);
    root.appendChild(play);
    var R = U.R = {
      cfg: cfg, play: play, canvas: cv, ctx2d: null, session: null, renderer: null, hud: CB.derby.hud.create(), sfx: null, raf: 0, last: 0, paused: false,
      followId: 'player', spectating: false, ended: false, reported: false, launches: 0, frames: 0, fpsEma: 60, tLoad: performance.now(), lastSnap: null, cam2d: null, fx2d: [],
      phoneT: 0, touchEl: null, touch: false, lastLayout: 0, quality: quality(), offs: [], carName: car.name,
      juice: CB.derby.hud.createJuice ? CB.derby.hud.createJuice() : null, hitStop: 0, flash: null, toasts: [], rb: [], replay: null, replayPending: null, lastReplayT: -99, stats: { hitStops: 0, replays: 0 }
    };
    R.input = X.createInput({ onAction: onAction });
    try { R.session = CB.derby.session.create(cfg); } catch (e) { load.textContent = 'Could not start: ' + (e && e.message); return; }
    if (o.autopilot) R.session.setPlayerAutopilot(true);
    R.sfx = CB.derby.sfx ? CB.derby.sfx.create({ muted: S.muted, mobile: R.quality === 'low' || coarse() }) : null;
    if (R.sfx) R.sfx.start();
    bindInput(R);
    // the renderer builds 12 car models: give the loading text a frame to paint first
    setTimeout(function () {
      if (U.R !== R) return;
      var DR = CB.derby.renderer;
      if (DR && typeof DR.create === 'function' && (!DR.isSupported || DR.isSupported()) && !o.force2d) {
        R.renderer = safe(function () { return DR.create(cv, R.session, { quality: R.quality, camera: S.camera }); });
      }
      if (!R.renderer) R.ctx2d = cv.getContext('2d');
      else R.ctx2d = cv.getContext('2d');
      if (load.parentNode) load.parentNode.removeChild(load);
      R.touch = touchOn();
      if (R.touch) buildTouch(R);
      R.last = 0;
      R.raf = requestAnimationFrame(frame);
    }, 30);
  }

  /* ================================================================== input binding */
  function bindInput(R) {
    function kd(e) {
      if (U.R !== R || U.screen !== 'play') return;
      if (R.replay) { if (!e.repeat && e.code !== 'Escape') { endReplay(R); e.preventDefault(); return; } }
      if (R.paused) { if (e.code === 'Escape' || e.code === 'KeyP') { e.preventDefault(); resume(); } return; }
      if (R.spectating && (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'KeyA' || e.code === 'KeyD')) { if (!e.repeat) cycleSpectate(e.code === 'ArrowLeft' || e.code === 'KeyA' ? -1 : 1); e.preventDefault(); return; }
      if (R.input.handleKey(e.code, true, e.repeat)) e.preventDefault();
    }
    function ku(e) { if (U.R !== R) return; if (R.input.handleKey(e.code, false, false)) e.preventDefault(); }
    function blur() { R.input.clear(); }
    function vis() { if (document.hidden && U.R === R && !R.paused && !R.ended) pause(); }
    function rs() { if (R.renderer && R.renderer.resize) safe(function () { R.renderer.resize(); }); if (R.touchEl) layoutTouch(R); }
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku); window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', vis); window.addEventListener('resize', rs);
    R.offs.push(function () { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', vis); window.removeEventListener('resize', rs); });
    function tap() { if (U.R === R && R.replay) endReplay(R); }
    R.play.addEventListener('pointerdown', tap, true);
    R.offs.push(function () { R.play.removeEventListener('pointerdown', tap, true); });
    var hub = CB.input && CB.input.hub;
    if (hub && typeof hub.onEvent === 'function') { var off = safe(function () { return hub.onEvent(function (e) { if (U.R === R && e) R.input.phoneEvent(e.type); }); }); if (typeof off === 'function') R.offs.push(off); }
  }
  function onAction(a) {
    var R = U.R; if (!R) return;
    if (a === 'pause') { if (R.ended) return; if (R.paused) resume(); else pause(); }
    else if (a === 'camera') { if (R.renderer && R.renderer.cycleCamera) { var m = R.renderer.cycleCamera(); U.S.camera = m; APP.persist(); } }
    else if (a === 'mute') { U.S.muted = !U.S.muted; APP.persist(); if (R.sfx) R.sfx.setMuted(U.S.muted); }
    else if (a === 'confirm') { if (R.spectating || (R.lastSnap && R.lastSnap.phase === 'over')) finish(true); }
    else if (a === 'specPrev') { if (R.spectating) cycleSpectate(-1); }
    else if (a === 'specNext' || a === 'spectate') { if (R.spectating) cycleSpectate(1); }
  }
  function pollHubEvents(R) {
    var hub = CB.input && CB.input.hub;
    if (!hub || typeof hub.takeEvents !== 'function') return;
    var evs = safe(function () { return hub.takeEvents(); }) || [];
    evs.forEach(function (e) { if (e && (e.type === 'pause' || e.type === 'camera' || e.type === 'confirm')) onAction(e.type); else if (e && e.type === 'reset') { R.input.held.reset = true; setTimeout(function () { R.input.held.reset = false; }, 300); } });
  }
  function cycleSpectate(dir) {
    var R = U.R; if (!R || !R.session) return;
    var ids = R.session.spectateTargets(); if (!ids.length) return;
    var i = ids.indexOf(R.followId); R.followId = ids[((i < 0 ? 0 : i + dir) % ids.length + ids.length) % ids.length];
    if (R.renderer && R.renderer.setFollow) R.renderer.setFollow(R.followId);
  }

  /* ================================================================== touch controls */
  function buildTouch(R) {
    var T = R.input.touch; T.active = true;
    var el = h('div', { class: 'dd-touch' });
    function btn(cls, label) { var b = h('div', { class: 'dd-t ' + cls, role: 'button', 'aria-label': label }); b.innerHTML = label; el.appendChild(b); return b; }
    var steer = btn('steer', ''), knob = h('div', { class: 'knob' }); steer.appendChild(knob); steer.setAttribute('aria-label', 'Steering');
    var sid = null;
    function sAt(e) { var r = steer.getBoundingClientRect(); var x = clamp((e.clientX - (r.left + r.width / 2)) / (r.width * 0.42), -1, 1); T.steer = -x; knob.style.transform = 'translateX(' + (x * r.width * 0.36) + 'px)'; }
    steer.addEventListener('pointerdown', function (e) { sid = e.pointerId; try { steer.setPointerCapture(sid); } catch (x) { /* ignore */ } sAt(e); e.preventDefault(); });
    steer.addEventListener('pointermove', function (e) { if (e.pointerId === sid) sAt(e); });
    function sEnd(e) { if (e.pointerId !== sid) return; sid = null; T.steer = 0; knob.style.transform = ''; }
    steer.addEventListener('pointerup', sEnd); steer.addEventListener('pointercancel', sEnd);
    function pedal(cls, label, key) {
      var b = btn(cls, label), fill = h('div', { class: 'fill' }); b.insertBefore(fill, b.firstChild); var id = null;
      function at(e) { var r = b.getBoundingClientRect(); var v = clamp(0.55 + 0.45 * (1 - (e.clientY - r.top) / r.height) * 1.2, 0.4, 1); T[key] = v; fill.style.height = Math.round(v * 100) + '%'; }
      b.addEventListener('pointerdown', function (e) { id = e.pointerId; try { b.setPointerCapture(id); } catch (x) { /* ignore */ } b.classList.add('is-down'); at(e); e.preventDefault(); });
      b.addEventListener('pointermove', function (e) { if (e.pointerId === id) at(e); });
      function end(e) { if (e.pointerId !== id) return; id = null; T[key] = 0; fill.style.height = '0'; b.classList.remove('is-down'); }
      b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end);
      return b;
    }
    function hold(cls, label, onDown, onUp) {
      var b = btn(cls, label);
      b.addEventListener('pointerdown', function (e) { b.classList.add('is-down'); try { b.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } onDown(); e.preventDefault(); });
      function end() { b.classList.remove('is-down'); if (onUp) onUp(); }
      b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end);
      return b;
    }
    var gas = pedal('gas', '<span>GAS</span>', 'throttle'), brake = pedal('brake', '<span>BRAKE<br>REV</span>', 'brake');
    var hb = hold('hb', 'HB', function () { T.handbrake = true; }, function () { T.handbrake = false; });
    var a1 = hold('round act a1', 'A1', function () { T.a1 = true; }, function () { T.a1 = false; });
    var a2 = hold('round act a2', 'A2', function () { T.a2 = true; }, function () { T.a2 = false; });
    var bo = hold('round boost', '<span>BOOST</span>', function () { T.boost = true; }, function () { T.boost = false; });
    bo.appendChild(h('div', { class: 'ring' }));
    var pz = hold('pause', icon('pause', 18), function () { onAction('pause'); });
    var cm = hold('camera', icon('cam', 18), function () { onAction('camera'); });
    a1.appendChild(h('div', { class: 'chg' })); a2.appendChild(h('div', { class: 'chg' }));
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    R.play.appendChild(el);
    R.touchEl = el; R.tb = { steer: steer, gas: gas, brake: brake, handbrake: hb, action1: a1, action2: a2, boost: bo, pause: pz, camera: cm };
    layoutTouch(R);
  }
  var TOUCH_LABEL = { flamethrower: 'FLAME', hammer: 'HAMMER', nitro: 'NITRO', magnet: 'MAGNET', shield: 'SHIELD', repair: 'REPAIR', oil: 'OIL', caltrops: 'SPIKES' };
  function layoutTouch(R) {
    var w = R.play.clientWidth, hh = R.play.clientHeight, L = CB.derby.hud.touchLayout(w, hh, safeInsets());
    Object.keys(R.tb).forEach(function (k) { var r = L[k], b = R.tb[k]; if (!r || !b) return; b.style.left = r.x + 'px'; b.style.top = r.y + 'px'; b.style.width = r.w + 'px'; b.style.height = r.h + 'px'; });
    R.touchLayout = L;
  }
  function updateTouchButtons(R, me) {
    if (!R.tb || !me) return;
    var acts = (me.acc || []).filter(function (a) { return a.button; });
    [1, 2].forEach(function (n) {
      var b = R.tb['action' + n], a = acts.filter(function (x) { return x.button === n; })[0];
      if (!b) return;
      b.style.display = a && !me.out ? '' : 'none';
      if (!a) return;
      var label = TOUCH_LABEL[a.id] || (a.name || a.id).split(' ')[0].toUpperCase().slice(0, 7);
      if (b._label !== label) { b.childNodes[0].textContent = label; b._label = label; }
      b.classList.toggle('not-ready', !a.ready && !a.active);
      var ch = b.querySelector('.chg'); if (ch) ch.style.width = Math.round(clamp(num(a.charge, 1), 0, 1) * 100) + '%';
    });
    var hide = me.out;
    ['steer', 'gas', 'brake', 'handbrake'].forEach(function (k) { if (R.tb[k]) R.tb[k].style.display = hide ? 'none' : ''; });
    var bo = R.tb.boost;
    if (bo) {
      bo.style.display = hide || !me.ram ? 'none' : '';
      if (me.ram) {
        var ch2 = clamp(num(me.ram.charge, 0), 0, 1), ring = bo.querySelector('.ring');
        if (ring) ring.style.background = 'conic-gradient(' + (me.ram.active ? '#fff' : '#3aa0ff') + ' ' + Math.round(ch2 * 360) + 'deg, rgba(255,255,255,.12) 0)';
        bo.classList.toggle('is-ready', ch2 >= 0.999 && !me.ram.active);
        bo.classList.toggle('is-on', !!me.ram.active);
      }
    }
  }

  /* ================================================================== frame loop */
  function frame(ts) {
    var R = U.R; if (!R || U.screen !== 'play') return;
    R.raf = requestAnimationFrame(frame);
    var dt = R.last ? clamp((ts - R.last) / 1000, 0, 0.1) : 1 / 60; R.last = ts;
    R.msEma = num(R.msEma, 16.7) + (dt * 1000 - num(R.msEma, 16.7)) * 0.05; R.fpsEma = 1000 / Math.max(1, R.msEma);
    R.frames++;
    pollHubEvents(R);
    if (R.paused) { draw(R, R.lastSnap, dt, true); return; }
    if (R.replay) { playReplay(R, dt); return; }
    var inp = R.input.sample(dt);
    var scale = 1;
    if (U.S.slowmo && R.quality !== 'low' && R.lastSnap) scale = 1 - 0.62 * clamp(num(R.lastSnap.slowmo, 0), 0, 1);
    if (R.renderer && R.renderer.setLookBack) R.renderer.setLookBack(!!inp.lookBack);
    // HIT-STOP: freeze the sim for a few frames on big hits involving the followed car (the render keeps going)
    if (R.hitStop > 0) R.hitStop -= dt;
    else R.session.update(dt * scale, inp);
    var snap = R.session.snapshot();
    R.lastSnap = snap;
    var me = snap.cars[0];
    R.input.boostAvail = !!me.ram;
    // replay ring buffer (~3.2 s of snapshots; off on low tier / in settings)
    if (U.S.replays && R.quality !== 'low' && (!R.rb.length || R.rb[R.rb.length - 1].t !== snap.t)) {
      R.rb.push(snap);
      while (R.rb.length && snap.t - R.rb[0].t > 3.2) R.rb.shift();
    }
    // events: juice (hit-stop, shake, kick, flash, rumble, popups, announcer, replay triggers), launches
    (snap.events || []).forEach(function (e) { if (e.type === 'launch' && e.carId === 'player') R.launches++; });
    var fx = R.juice ? R.juice.ingest(snap, { followId: R.followId, playerId: 'player' }) : null;
    if (fx) applyFx(R, fx, snap);
    if (R.replayPending && (snap.t >= R.replayPending.at || snap.phase === 'over')) { var rp = R.replayPending; R.replayPending = null; startReplay(R, rp.info); if (R.replay) return; }
    // spectate when the player is out for good
    if (me.out && (me.lives <= 0) && !R.spectating && snap.phase === 'fight') {
      R.spectating = true;
      R.specAt = snap.t;
      setTimeout(function () { if (U.R === R && R.spectating && R.followId === 'player') cycleSpectate(1); }, 2200);
      showSpecBar(R);
    }
    if (R.sfx) R.sfx.frame(snap, R.followId, dt);
    draw(R, snap, dt, false);
    if (R.frames % 6 === 0) updateTouchButtons(R, me);
    phoneStatus(R, me);
    if (snap.phase === 'over' && snap.overT > 3.2 && !R.ended) finish(false);
  }
  /* ================================================================== juice: hit-stop, shake, kick, flash, rumble */
  function applyFx(R, fx, snap) {
    var big = fx.shake > 0;
    if (fx.hitstop > 0 && R.hitStop <= 0) { R.hitStop = fx.hitstop; R.stats.hitStops++; }
    var rd = R.renderer;
    if (big && rd) {
      if (rd.shake) safe(function () { rd.shake(fx.shake); });
      if (fx.kick && rd.kick) safe(function () { rd.kick(fx.kick.x, fx.kick.y, fx.kick.amount); });
    } else if (big && !rd && R.cam2d) R.cam2d.shake = Math.min(1.5, num(R.cam2d.shake, 0) + fx.shake);
    if (fx.flash && R.quality !== 'low') R.flash = { color: fx.flash.color, a: Math.max(R.flash ? R.flash.a : 0, fx.flash.a) };
    if (fx.rumble > 0 && U.S.haptics) rumble(R, fx.rumble);
    fx.stings.forEach(function (n) { if (R.sfx && R.sfx.sting) R.sfx.sting(n); });
    fx.toasts.forEach(function (tx) { R.toasts.push({ t: snap.t, text: '+ ' + tx }); if (R.toasts.length > 3) R.toasts.shift(); });
    if (fx.replay && U.S.replays && R.quality !== 'low' && snap.t - R.lastReplayT > 6 && !R.replayPending) {
      R.replayPending = { at: snap.t + (fx.replay.final ? 0.9 : 0.6), info: fx.replay };
    }
  }
  function rumble(R, k) {
    var gp = R.input.gp && R.input.gp.pad, va = gp && gp.vibrationActuator;
    if (va && typeof va.playEffect === 'function') safe(function () { va.playEffect('dual-rumble', { duration: Math.round(80 + 140 * k), strongMagnitude: clamp(k, 0, 1), weakMagnitude: clamp(k * 0.7, 0, 1) }); });
    if (R.touch && typeof navigator !== 'undefined' && navigator.vibrate) safe(function () { navigator.vibrate(Math.round(20 + 45 * k)); });
    var hub = CB.input && CB.input.hub;
    if (hub && typeof hub.feedback === 'function') safe(function () { hub.feedback({ kind: 'hit', intensity: clamp(k, 0.1, 1) }); });
  }
  /** world -> CSS px (3D renderer or the 2D fallback camera) */
  function project(R, x, y, z, w, hh) {
    if (R.renderer && R.renderer.worldToScreen) return safe(function () { return R.renderer.worldToScreen(x, y, z); });
    var cam = R.cam2d; if (!cam || !cam.sc) return null;
    var dx = x - cam.x, dy = y - cam.y, a = -(cam.rot - Math.PI / 2), c = Math.cos(a), s = Math.sin(a);
    var rx = dx * c - dy * s, ry = dx * s + dy * c;
    return { x: cam.W / 2 + rx * cam.sc, y: cam.H * 0.6 - ry * cam.sc, visible: true, scale: cam.sc };
  }

  /* ================================================================== slow-mo replay of takedowns / the final kill */
  function startReplay(R, info) {
    if (!info || !R.rb.length) return;
    var tE = info.t, frames = R.rb.filter(function (f) { return f.t >= tE - 2.0 && f.t <= tE + 0.7; });
    if (frames.length < 20) return;
    R.replay = { frames: frames, i: 0, simT: frames[0].t, tE: tE, end: frames[frames.length - 1].t, info: info, realT: 0, shown: {} };
    R.lastReplayT = tE; R.stats.replays++;
    var tgt = info.targetId || 'player';
    if (R.renderer) {
      if (R.renderer.setCinematic) safe(function () { R.renderer.setCinematic({ targetId: tgt, focus: info.x != null ? { x: info.x, y: info.y } : null, orbit: true, dur: 3 }); });
      else if (R.renderer.setFollow) safe(function () { R.renderer.setFollow(tgt); });
    }
    if (R.sfx && R.sfx.setSlow) R.sfx.setSlow(true);
    R.input.clear();
  }
  function endReplay(R) {
    if (!R || !R.replay) return;
    R.replay = null; R.last = 0;
    if (R.renderer) {
      if (R.renderer.setCinematic) safe(function () { R.renderer.setCinematic(null); });
      if (R.renderer.setFollow) safe(function () { R.renderer.setFollow(R.followId); });
    }
    if (R.sfx && R.sfx.setSlow) R.sfx.setSlow(false);
    R.input.clear();
  }
  function playReplay(R, dt) {
    var P2 = R.replay;
    R.input.pollPad();
    if (R.input.gp.anyEdge || (R.input.touch.active && R.input.touch.throttle > 0.5 && P2.realT > 0.4)) { endReplay(R); return; }
    P2.realT += dt;
    var near = Math.abs(P2.simT - P2.tE) < 0.45;
    P2.simT += dt * (near ? 0.22 : 0.9);
    while (P2.i < P2.frames.length - 1 && P2.frames[P2.i + 1].t <= P2.simT) P2.i++;
    var f = P2.frames[P2.i];
    if (P2.simT >= P2.end || P2.realT > 7) { endReplay(R); return; }
    // events fire their sparks once, on the frame's first showing
    var view0 = P2.shown[P2.i] ? Object.assign({}, f, { events: [] }) : f;
    P2.shown[P2.i] = 1;
    draw(R, view0, dt, false, true);
  }
  function drawReplayOverlay(c, R, v) {
    var P2 = R.replay; if (!P2) return;
    var W = v.width, H = v.height, bar = Math.round(H * 0.09), t = P2.realT;
    c.fillStyle = 'rgba(0,0,0,.92)'; c.fillRect(0, 0, W, bar); c.fillRect(0, H - bar, W, bar);
    var FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
    c.textBaseline = 'middle';
    c.fillStyle = (Math.floor(t * 2) % 2) ? '#ff3b2f' : 'rgba(255,59,47,.35)'; c.beginPath(); c.arc(24 + (v.safe.l || 0), bar / 2, 6, 0, Math.PI * 2); c.fill();
    c.font = '900 ' + Math.max(12, bar * 0.36) + 'px ' + FONT; c.textAlign = 'left'; c.fillStyle = '#fff'; c.fillText('REPLAY', 38 + (v.safe.l || 0), bar / 2);
    c.textAlign = 'right'; c.font = '700 ' + Math.max(11, bar * 0.26) + 'px ' + FONT; c.fillStyle = 'rgba(255,255,255,.7)'; c.fillText(R.touch ? 'Tap to skip' : 'Any key to skip', W - 16 - (v.safe.r || 0), H - bar / 2);
    var k = clamp(t / 0.25, 0, 1), sz = (v.compact ? 40 : 76) * (1.6 - 0.6 * k);
    c.save(); c.globalAlpha = k; c.translate(W / 2, H * 0.24); c.rotate(-0.05);
    c.font = 'italic 900 ' + sz + 'px ' + FONT; c.textAlign = 'center';
    c.lineWidth = sz * 0.14; c.strokeStyle = 'rgba(0,0,0,.85)'; c.strokeText(P2.info.title || 'TAKEDOWN!', 0, 0);
    c.fillStyle = P2.info.targetId === 'player' && !/WIN/.test(P2.info.title) ? '#ff5a48' : '#ffd84a'; c.fillText(P2.info.title || 'TAKEDOWN!', 0, 0);
    c.restore();
  }

  function view(R) {
    var w = R.play.clientWidth, hh = R.play.clientHeight;
    return { width: w, height: hh, followId: R.followId, spectating: R.spectating, compact: hh < 520 || w < 700, touch: R.touch, safe: R.safe || (R.safe = safeInsets()),
      keys: R.touch ? { a1: 'A1', a2: 'A2', boost: 'BOOST' } : R.input.lastDevice === 'gamepad' ? { a1: 'X', a2: 'B', boost: 'RB' } : { a1: 'F', a2: 'G', boost: 'SHIFT' }, fps: U.S.showFps ? R.fpsEma : 0,
      juice: R.juice ? R.juice.state : null, flash: R.flash, toasts: R.toasts, project: function (x, y, z) { return project(R, x, y, z, w, hh); } };
  }
  function draw(R, snap, dt, paused, replay) {
    if (!snap) return;
    var v = view(R), cv = R.canvas, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (R.flash) { R.flash.a -= dt * 3.2; if (R.flash.a <= 0) R.flash = null; }
    if (R.toasts.length && snap.t - R.toasts[0].t > 2) R.toasts.shift();
    if (replay) {
      if (R.renderer) safe(function () { R.renderer.render(snap, 1); });
      else {
        var wpx0 = Math.round(v.width * dpr), hpx0 = Math.round(v.height * dpr);
        if (cv.width !== wpx0 || cv.height !== hpx0) { cv.width = wpx0; cv.height = hpx0; }
        var tgt = R.replay && R.replay.info.targetId; var f0 = R.followId; R.followId = tgt || f0;
        R.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0); draw2D(R, R.ctx2d, snap, v, dt * 0.3); R.followId = f0;
      }
      var c0 = R.ctx2d; if (!c0) return;
      c0.setTransform(cv.width / Math.max(1, v.width), 0, 0, cv.width / Math.max(1, v.width), 0, 0);
      drawReplayOverlay(c0, R, v);
      return;
    }
    if (R.renderer) {
      if (!paused || R.frames % 2 === 0) safe(function () { if (R.renderer.setFollow) R.renderer.setFollow(R.followId); R.renderer.render(snap, R.session.alpha); });
    } else {
      var wpx = Math.round(v.width * dpr), hpx = Math.round(v.height * dpr);
      if (cv.width !== wpx || cv.height !== hpx) { cv.width = wpx; cv.height = hpx; }
      R.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw2D(R, R.ctx2d, snap, v, paused ? 0 : dt);
    }
    var c = R.ctx2d; if (!c) return;
    var sx = cv.width / Math.max(1, v.width);
    c.setTransform(sx, 0, 0, sx, 0, 0);
    if (R.renderer) {
      // the 3D renderer cleared the HUD canvas; draw the HUD on top
      R.hud.draw(c, snap, v);
    } else R.hud.draw(c, snap, v);
  }

  /* ---------------- 2D top-down fallback renderer (no WebGL) */
  function draw2D(R, c, snap, v, dt) {
    var W = v.width, H = v.height, a = snap.arena;
    var f = null; snap.cars.forEach(function (x) { if (x.id === R.followId) f = x; }); f = f || snap.cars[0];
    var cam = R.cam2d || (R.cam2d = { x: f.x, y: f.y, rot: f.heading });
    var k = 1 - Math.exp(-dt * 6);
    cam.x += (f.x - cam.x) * k; cam.y += (f.y - cam.y) * k;
    var dr = f.heading - cam.rot; while (dr > Math.PI) dr -= Math.PI * 2; while (dr < -Math.PI) dr += Math.PI * 2; cam.rot += dr * (1 - Math.exp(-dt * 2.5));
    var sc = Math.min(W, H) / 46;
    c.fillStyle = '#0a0a0c'; c.fillRect(0, 0, W, H);
    c.save();
    c.translate(W / 2, H * 0.6); c.scale(sc, -sc); c.rotate(-(cam.rot - Math.PI / 2)); c.translate(-cam.x, -cam.y);
    cam.sc = sc; cam.W = W; cam.H = H;
    var HD = CB.derby.hud;
    HD.arenaPath(c, a, function (x, y) { return [x, y]; });
    c.fillStyle = a.surface.color; c.fill();
    c.lineWidth = 1.2; c.strokeStyle = a.wall.style === 'tyres' ? '#222' : a.wall.style === 'stone' ? '#8a7a60' : '#b9b9b9'; c.stroke();
    (a.hazards || []).forEach(function (hz) {
      c.fillStyle = hz.type === 'fire' ? 'rgba(255,110,20,.85)' : hz.type === 'crusher' ? 'rgba(160,40,30,' + (0.3 + 0.6 * AR().crusherClosed(hz, snap.t)) + ')' : hz.type === 'oil' ? 'rgba(0,0,0,.55)' : 'rgba(70,45,25,.5)';
      if (hz.type === 'crusher') { poly(c, HD.boxPts(hz)); c.fill(); } else { c.beginPath(); c.arc(hz.x, hz.y, hz.r, 0, Math.PI * 2); c.fill(); }
    });
    (a.floors || []).forEach(function (fl) { poly(c, HD.boxPts(fl)); c.fillStyle = 'rgba(255,255,255,.12)'; c.fill(); });
    (a.ramps || []).forEach(function (rp) { poly(c, HD.boxPts(rp)); c.fillStyle = 'rgba(230,200,120,.45)'; c.fill(); });
    (a.obstacles || []).forEach(function (o) {
      c.fillStyle = o.kind === 'tyres' ? '#1d1d1f' : o.kind === 'island' ? '#3d6b33' : o.kind === 'container' ? '#7a4a2a' : '#8a8a90';
      if (o.type === 'circle') { c.beginPath(); c.arc(o.x, o.y, o.r, 0, Math.PI * 2); c.fill(); } else { poly(c, HD.boxPts(o)); c.fill(); }
    });
    (snap.entities || []).forEach(function (e) {
      if (e.type === 'oil') { c.fillStyle = 'rgba(5,5,10,.8)'; c.beginPath(); c.arc(e.x, e.y, e.r, 0, Math.PI * 2); c.fill(); }
      else if (e.type === 'caltrops') { c.fillStyle = '#ccc'; for (var i = 0; i < 14; i++) { var an = i * 2.4, rr = e.r * ((i * 37 % 10) / 10); c.fillRect(e.x + Math.cos(an) * rr - 0.1, e.y + Math.sin(an) * rr - 0.1, 0.2, 0.2); } }
      else if (e.type === 'ball') { c.strokeStyle = '#888'; c.lineWidth = 0.08; c.beginPath(); c.moveTo(e.ax, e.ay); c.lineTo(e.x, e.y); c.stroke(); c.fillStyle = '#333'; c.beginPath(); c.arc(e.x, e.y, 0.5, 0, Math.PI * 2); c.fill(); }
    });
    // impact sparks / smoke (cosmetic)
    (snap.events || []).forEach(function (e) {
      if ((e.type === 'impact' || e.type === 'wall' || e.type === 'hammer') && e.x != null) for (var i = 0; i < (e.big ? 16 : 6); i++) R.fx2d.push({ x: e.x, y: e.y, vx: (Math.random() - 0.5) * 14, vy: (Math.random() - 0.5) * 14, life: 0.4, age: 0, col: '255,200,90', r: 0.12 });
      if (e.type === 'explode') for (var j = 0; j < 30; j++) R.fx2d.push({ x: e.x, y: e.y, vx: (Math.random() - 0.5) * 10, vy: (Math.random() - 0.5) * 10, life: 0.9, age: 0, col: '255,120,30', r: 0.5 });
    });
    snap.cars.forEach(function (car) {
      var sm = car.engine ? car.engine.smoke : 0;
      if ((sm > 0.25 || car.out) && Math.random() < 0.25) { var g = Math.round(220 - 180 * num(car.engine && car.engine.black, 0)); R.fx2d.push({ x: car.x, y: car.y, vx: 0.5, vy: 0.8, life: 1.6, age: 0, col: g + ',' + g + ',' + g, r: 0.8, grow: 1.2, a: 0.35 }); }
    });
    for (var q = R.fx2d.length - 1; q >= 0; q--) { var p = R.fx2d[q]; p.age += dt; if (p.age > p.life) { R.fx2d.splice(q, 1); continue; } p.x += p.vx * dt; p.y += p.vy * dt; }
    if (R.fx2d.length > 500) R.fx2d.splice(0, R.fx2d.length - 500);
    snap.cars.forEach(function (car) { drawCar2D(c, car, snap.t); });
    R.fx2d.forEach(function (p) { var t = p.age / p.life; c.fillStyle = 'rgba(' + p.col + ',' + ((p.a || 1) * (1 - t)).toFixed(3) + ')'; c.beginPath(); c.arc(p.x, p.y, p.r * (1 + num(p.grow, 0) * p.age), 0, Math.PI * 2); c.fill(); });
    c.restore();
  }
  function poly(c, pts) { c.beginPath(); pts.forEach(function (p, i) { if (i) c.lineTo(p[0], p[1]); else c.moveTo(p[0], p[1]); }); c.closePath(); }
  function drawCar2D(c, car, t) {
    var L = car.spec.length, Wd = car.spec.width;
    c.save(); c.translate(car.x, car.y); c.rotate(car.heading);
    var lift = car.airborne ? 1 + Math.min(0.3, car.z * 0.08) : 1; c.scale(lift, lift);
    c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(-L / 2 + 0.15, -Wd / 2 - 0.15, L, Wd);
    var hp = clamp(num(car.health, 1), 0, 1);
    c.fillStyle = car.out ? '#2a2a2a' : car.color; CB.derby.hud.roundRect(c, -L / 2, -Wd / 2, L, Wd, 0.35); c.fill();
    if (!car.out && hp < 0.95) { c.fillStyle = 'rgba(0,0,0,' + ((1 - hp) * 0.45).toFixed(3) + ')'; c.fill(); }
    var z = car.zones || {};
    function tint(d, x, y, w, h2) { if (d > 0.15) { c.fillStyle = 'rgba(30,10,5,' + (d * 0.6).toFixed(3) + ')'; c.fillRect(x, y, w, h2); } }
    tint(z.front, L / 2 - 0.9, -Wd / 2, 0.9, Wd); tint(z.rear, -L / 2, -Wd / 2, 0.9, Wd); tint(z.left, -L / 2, Wd / 2 - 0.4, L, 0.4); tint(z.right, -L / 2, -Wd / 2, L, 0.4);
    c.fillStyle = 'rgba(15,20,28,.9)'; c.fillRect(-0.5, -Wd / 2 + 0.22, 1.5, Wd - 0.44);
    c.fillStyle = '#0c0c0c';
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(function (s, i) { if (car.wheelLost && car.wheelLost[i]) return; c.fillRect(s[0] * L * 0.3 - 0.35, s[1] * (Wd / 2) - 0.13, 0.7, 0.26); });
    if (car.isPlayer) { c.strokeStyle = '#fff'; c.lineWidth = 0.12; CB.derby.hud.roundRect(c, -L / 2, -Wd / 2, L, Wd, 0.35); c.stroke(); }
    (car.acc || []).forEach(function (ac) {
      if (ac.id === 'flamethrower' && ac.active) {
        var g = c.createLinearGradient(L / 2, 0, L / 2 + 10, 0); g.addColorStop(0, 'rgba(255,240,140,.95)'); g.addColorStop(0.5, 'rgba(255,120,20,.7)'); g.addColorStop(1, 'rgba(200,40,10,0)');
        c.fillStyle = g; c.beginPath(); c.moveTo(L / 2, 0); c.lineTo(L / 2 + 10, 4.6 + Math.sin(t * 30) * 0.4); c.lineTo(L / 2 + 10, -4.6); c.closePath(); c.fill();
      }
      if (ac.id === 'hammer' && ac.swing > 0) { var an = Math.sin(ac.swing * Math.PI) * 1.4 * (ac.side || 1); c.save(); c.rotate(an); c.fillStyle = '#aab'; c.fillRect(-0.1, 0, 0.2, 3 * (ac.side || 1)); c.fillRect(-0.4, 2.7 * (ac.side || 1) - 0.3, 0.8, 0.6); c.restore(); }
      if (ac.id === 'ram') { c.fillStyle = '#8a6a4a'; c.fillRect(L / 2, -0.2, 1, 0.4); }
      if (ac.id === 'ramp') { c.fillStyle = '#ccc'; c.fillRect(L / 2, -Wd / 2, 0.45, Wd); }
    });
    if (car.shield > 0) { c.strokeStyle = 'rgba(122,215,255,.8)'; c.lineWidth = 0.15; c.beginPath(); c.arc(0, 0, L * 0.75, 0, Math.PI * 2); c.stroke(); }
    if (car.onFire > 0.05 || (car.engine && car.engine.fire > 0.05)) { c.fillStyle = 'rgba(255,' + Math.round(120 + 100 * Math.sin(t * 20)) + ',20,.85)'; c.beginPath(); c.arc(L * 0.25, 0, 0.7 + 0.2 * Math.sin(t * 25), 0, Math.PI * 2); c.fill(); }
    c.restore();
  }

  /* ---------------- phone wheel status: ITEM = action 1, NITRO = action 2 */
  function phoneStatus(R, me) {
    var Wh = CB.input && CB.input.wheel, s = null;
    if (!Wh || typeof Wh.session !== 'function') return;
    var t = performance.now(); if (t - R.phoneT < 250) return; R.phoneT = t;
    s = safe(function () { return Wh.session(); });
    if (!s || !s.rx || typeof s.rx.send !== 'function') return;
    var acts = (me.acc || []).filter(function (a) { return a.button; }), a1 = acts.filter(function (a) { return a.button === 1; })[0], a2 = acts.filter(function (a) { return a.button === 2; })[0];
    safe(function () { s.rx.send('arcade', { on: true, item: a1 && !me.out ? a1.name : null, uses: a1 ? (a1.ammo != null && a1.ammo !== 0 ? a1.ammo : 1) : 0, nitroEnabled: !!a2, nitro: a2 ? clamp(num(a2.charge, 1), 0, 1) : 0, nitroOn: !!(a2 && a2.active) }, 'fast'); });
    R.phoneOn = true;
  }
  function phoneOff(R) {
    if (!R || !R.phoneOn) return;
    var Wh = CB.input && CB.input.wheel;
    safe(function () { var s = Wh && Wh.session ? Wh.session() : null; if (s && s.rx) s.rx.send('arcade', { on: false }, 'rel'); });
  }

  /* ================================================================== spectate bar, pause */
  function showSpecBar(R) {
    if (R.specEl) return;
    var bar = h('div', { class: 'dd-spec' },
      h('button', { class: 'dd-btn', type: 'button', 'aria-label': 'Previous car', html: icon('back', 16), onclick: function () { cycleSpectate(-1); } }),
      h('button', { class: 'dd-btn primary', type: 'button', text: 'Results', onclick: function () { finish(true); } }),
      h('button', { class: 'dd-btn', type: 'button', 'aria-label': 'Next car', html: icon('next', 16), onclick: function () { cycleSpectate(1); } }));
    R.play.appendChild(bar); R.specEl = bar;
  }
  function pause() {
    var R = U.R; if (!R || R.paused || R.ended) return;
    if (R.replay) endReplay(R);
    R.paused = true; R.input.clear(); if (R.sfx) R.sfx.suspend();
    var S = U.S;
    var menu = h('div', { class: 'dd-menu', role: 'dialog', 'aria-label': 'Paused' },
      h('h2', { text: 'PAUSED' }),
      h('button', { class: 'dd-btn primary', type: 'button', 'data-autofocus': '', text: 'Resume', onclick: resume }),
      h('button', { class: 'dd-btn', type: 'button', text: 'Restart derby', onclick: function () { startMatch({ seed: R.cfg.seed + 1 }); } }),
      R.renderer && R.renderer.cycleCamera ? h('button', { class: 'dd-btn', type: 'button', text: 'Camera: ' + (R.renderer.cameraLabel ? R.renderer.cameraLabel() : R.renderer.getCamera()), onclick: function (e) { onAction('camera'); e.target.textContent = 'Camera: ' + (R.renderer.cameraLabel ? R.renderer.cameraLabel() : R.renderer.getCamera()); } }) : null,
      h('button', { class: 'dd-btn', type: 'button', text: 'Sound: ' + (S.muted ? 'off' : 'on'), onclick: function (e) { onAction('mute'); e.target.textContent = 'Sound: ' + (S.muted ? 'off' : 'on'); } }),
      h('button', { class: 'dd-btn', type: 'button', text: 'Takedown replays: ' + (S.replays ? 'on' : 'off'), onclick: function (e) { S.replays = !S.replays; APP.persist(); e.target.textContent = 'Takedown replays: ' + (S.replays ? 'on' : 'off'); } }),
      R.renderer && R.renderer.setQuality ? h('button', { class: 'dd-btn', type: 'button', text: 'Graphics: ' + R.renderer.getQuality(), onclick: function (e) {
        var qs = ['low', 'medium', 'high'], qn = qs[(qs.indexOf(R.renderer.getQuality()) + 1) % qs.length]; R.renderer.setQuality(qn); R.quality = qn; U.S.quality = qn; APP.persist(); e.target.textContent = 'Graphics: ' + qn; } }) : null,
      h('button', { class: 'dd-btn', type: 'button', text: 'Quit to setup', onclick: function () { APP.showSetup(); } }),
      h('button', { class: 'dd-btn', type: 'button', text: 'Main menu', onclick: function () { var r = APP.router(); if (r) r.go('menu'); } }));
    var ov = h('div', { class: 'dd-ovl' }, menu);
    R.play.appendChild(ov); R.pauseEl = ov;
    var f = menu.querySelector('[data-autofocus]'); if (f) f.focus();
  }
  function resume() {
    var R = U.R; if (!R || !R.paused) return;
    R.paused = false; if (R.pauseEl && R.pauseEl.parentNode) R.pauseEl.parentNode.removeChild(R.pauseEl); R.pauseEl = null; R.last = 0;
    if (R.sfx) R.sfx.resume();
  }

  /* ================================================================== finish / results */
  function finish(skip) {
    var R = U.R; if (!R || R.ended) return;
    R.ended = true;
    var ses = R.session;
    // the player left early (spectating): fast-forward the rest of the derby without rendering
    if (R.replay) endReplay(R);
    if (skip && ses) { if (!ses._cars[0].out) ses.setPlayerAutopilot(true); var n = 0; while (ses.world.phase !== 'over' && n < 120 * 240) { ses.step(); if (R.juice && n % 6 === 0) R.juice.ingest(ses.snapshot(), { playerId: 'player' }); n++; } }
    var res = ses.results();
    res.carName = R.carName; res.launches = R.launches;
    scoreResults(R, res);
    report(R, res);
    APP.teardown();
    showResults(res);
  }
  /** score + coins: the session's own (stats.score / coins) when it has them, else the HUD juice tally */
  var COIN_MULT = { rookie: 0.6, amateur: 1, pro: 1.4, alien: 1.9 };
  function scoreResults(R, res) {
    var me = res.player || {}, st = me.stats || {}, J = R.juice ? R.juice.state : null;
    var simScore = num(st.score, 0);
    res.score = Math.round(simScore > 0 ? simScore : J ? J.score : 0);
    res.breakdown = st.scoreBy || st.breakdown || (J ? J.breakdown : {}) || {};
    res.bestHit_kph = Math.max(num(st.maxImpact_kph, 0), J ? Math.round(J.bestHit * 3.6) : 0);
    res.juice = J ? { hits: J.hits, bigHits: J.bigHits, firstHitT: J.firstHitT, longestGap: Math.round(J.longestGap * 10) / 10, hitStops: R.stats.hitStops, replays: R.stats.replays } : null;
    var place = me.position || res.classification.length, total = res.classification.length;
    var coins = num(me.coins, NaN);
    if (!isFinite(coins)) coins = num(st.coins, NaN);
    if (!isFinite(coins)) coins = Math.round((res.score / 20 + (total - place) * 15 + (res.won ? 150 : 0) + num(st.kills, 0) * 25) * (COIN_MULT[res.difficulty] || 1));
    res.coinsEarned = Math.max(0, Math.round(coins));
  }
  function creditCoins(R, res) {
    var Pf = CB.game && CB.game.profile;
    if (!res.coinsEarned || !Pf || typeof Pf.addCredits !== 'function' || res.coinsCredited) return;
    safe(function () { Pf.addCredits(res.coinsEarned, 'Demolition Derby — ' + (res.arenaName || 'arena'), 'derby'); res.coinsCredited = true; });
  }
  function report(R, res) {
    if (R.reported) return; R.reported = true;
    var me = res.player || { stats: {} }, st = me.stats || {};
    var Pf = CB.game && CB.game.profile;
    if (Pf && typeof Pf.incStat === 'function') safe(function () {
      Pf.incStat('derby_played', 1);
      if (res.won) Pf.incStat('derby_wins', 1);
      if (st.kills) Pf.incStat('derby_kills', st.kills);
      Pf.recordStat('derby_damage', Math.round(num(st.dealt, 0) * 100), 'add');
      Pf.recordStat('derby_tbones_best', num(st.tbones, 0), 'max');
      Pf.recordStat('derby_impact_best_kph', num(st.maxImpact_kph, 0), 'max');
      Pf.recordStat('derby_score_best', num(res.score, 0), 'max');
    });
    creditCoins(R, res);
    var A = CB.game && CB.game.achievements;
    if (A && typeof A.check === 'function') safe(function () {
      A.check(null, { type: 'derby', results: res, launches: R.launches });
      var pr = Pf && Pf.get ? Pf.get() : null; if (pr && pr.stats) A.check(null, { type: 'stat', stats: pr.stats });
    });
    safe(function () { document.dispatchEvent(new CustomEvent('cb:derby-finished', { detail: { results: res } })); });
  }
  function showResults(res) {
    U.screen = 'results'; U.lastResults = res;
    APP.setDriving(false);
    var root = U.root; root.innerHTML = '';
    var me = res.player || {}, st = me.stats || {}, total = res.classification.length;
    var won = !!res.won;
    var hl = [];
    if (st.tbones) hl.push('T-bones <b>' + st.tbones + '</b>');
    if (st.kills) hl.push('Eliminations <b>' + st.kills + '</b>');
    hl.push('Damage dealt <b>' + Math.round(num(st.dealt, 0) * 100) + '%</b>');
    hl.push('Damage taken <b>' + Math.round(num(st.taken, 0) * 100) + '%</b>');
    if (st.maxImpact_kph) hl.push('Biggest hit <b>' + st.maxImpact_kph + ' km/h</b>');
    if (res.launches) hl.push('Ramp launches <b>' + res.launches + '</b>');
    if (st.flameDmg > 0.01) hl.push('Flame damage <b>' + Math.round(st.flameDmg * 100) + '%</b>');
    hl.push('Survived <b>' + Math.round(num(st.survived_s, 0)) + ' s</b>');
    var bd = res.breakdown || {}, bdKeys = Object.keys(bd).sort(function (a, b) { return bd[b] - bd[a]; });
    var scoreHtml = '<div class="dd-big"><div class="gold">Score<b>' + Math.round(num(res.score, 0)).toLocaleString() + '</b></div>' +
      '<div class="gold">Coins earned<b>+' + num(res.coinsEarned, 0).toLocaleString() + (res.coinsCredited ? '' : '') + '</b></div>' +
      '<div>Best hit<b>' + num(res.bestHit_kph, 0) + ' km/h</b></div>' +
      '<div class="mvp">MVP<b>' + esc(res.mvpId === 'player' ? 'YOU' : ((res.classification.filter(function (r) { return r.id === res.mvpId; })[0] || {}).name || res.mvpName || '—')) + '</b></div></div>' +
      (bdKeys.length ? '<div class="dd-score">' + bdKeys.map(function (k) { return '<div><span>' + esc(k) + '</span><b>+' + Math.round(bd[k]) + '</b></div>'; }).join('') + '</div>' : '');
    var A = AC();
    var rows = res.classification.map(function (r) {
      var s = r.stats;
      return '<tr class="' + (r.isPlayer ? 'me' : '') + '"><td class="num">' + r.position + '</td><td><span class="dd-sw" style="background:' + esc(r.color) + '"></span>' + esc(r.isPlayer ? 'You' : r.name) + (r.id === res.mvpId ? ' <span class="dd-badge">MVP</span>' : '') + '</td>' +
        '<td>' + esc(r.isPlayer && res.carName ? res.carName : r.presetName || '') + '</td><td>' + esc(r.accessories.map(function (id) { return A.DEFS[id] ? A.DEFS[id].name : id; }).join(', ') || '—') + '</td>' +
        '<td class="num">' + Math.round(s.dealt * 100) + '%</td><td class="num">' + Math.round(s.taken * 100) + '%</td><td class="num">' + s.hits + '</td><td class="num">' + s.kills + '</td><td class="num">' + s.tbones + '</td>' +
        '<td class="num">' + s.maxImpact_kph + '</td><td class="num">' + Math.round(s.survived_s) + 's</td><td>' + (r.alive ? 'alive · ' + Math.round(r.health * 100) + '%' : esc(r.elimReason || 'out')) + '</td></tr>';
    }).join('');
    var wrap = h('div', { class: 'dd-res' });
    wrap.innerHTML = '<div class="dd-kicker">Derby results · ' + esc(res.arenaName) + ' · ' + esc(res.difficulty) + ' · ' + Math.round(res.duration_s) + ' s' + (res.endReason === 'time' ? ' · time limit' : '') + '</div>' +
      '<h1 class="' + (won ? 'win' : '') + '">' + (won ? 'Last car standing!' : 'You finished ' + ordinal(me.position || total).toLowerCase() + ' of ' + total) + '</h1>' +
      '<div class="dd-sub">' + (won ? 'You survived the derby.' : 'Winner: ' + esc((res.classification[0] || {}).isPlayer ? 'You' : (res.classification[0] || {}).name || '—')) + ' · MVP: ' + esc(res.mvpId === 'player' ? 'You' : (res.classification.filter(function (r) { return r.id === res.mvpId; })[0] || {}).name || res.mvpName || '—') + '</div>' +
      scoreHtml + '<div class="dd-hl">' + hl.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</div>' +
      '<div class="dd-tbl-wrap"><table class="dd-tbl"><thead><tr><th>#</th><th>Driver</th><th>Car</th><th>Accessories</th><th class="num">Dealt</th><th class="num">Taken</th><th class="num">Hits</th><th class="num">Kills</th><th class="num">T-bones</th><th class="num">Max km/h</th><th class="num">Time</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    var acts = h('div', { class: 'dd-actions' },
      h('button', { class: 'cb-btn primary rx-btn big', type: 'button', 'data-dd': 'rematch', html: icon('play', 16) + ' Rematch', onclick: function () { startMatch({}); } }),
      h('button', { class: 'cb-btn ghost big', type: 'button', text: 'Change loadout', onclick: function () { APP.showSetup(); } }),
      h('button', { class: 'cb-btn ghost big', type: 'button', text: 'Main menu', onclick: function () { var r = APP.router(); if (r) r.go('menu'); } }));
    wrap.appendChild(acts);
    root.appendChild(wrap);
    window.scrollTo(0, 0);
  }
  function ordinal(n) { var s = ['TH', 'ST', 'ND', 'RD'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  /* ================================================================== teardown, route */
  APP.teardown = function () {
    var R = U.R; if (!R) return;
    U.R = null;
    cancelAnimationFrame(R.raf);
    R.offs.forEach(function (f) { safe(f); }); R.offs = [];
    phoneOff(R);
    if (R.renderer) safe(function () { R.renderer.destroy(); });
    if (R.sfx) safe(function () { R.sfx.destroy(); });
    if (R.session) safe(function () { R.session.destroy(); });
    R.renderer = null; R.session = null;
  };
  APP.startMatch = startMatch;

  function enter(layer, params) {
    P.injectStyles();
    U.layer = layer; U.params = params || {};
    U.S = P.loadSettings();
    if (!U.root || U.root.parentNode !== layer) { layer.innerHTML = ''; U.root = h('div', { class: 'dd-root' }); layer.appendChild(U.root); }
    if (U.params.arena && AR().get(U.params.arena)) U.S.arenaId = U.params.arena;
    if (U.params.quick === '1' || U.params.quick === 1 || U.params.quick === true) { startMatch({}); return; }
    if (U.screen === 'play' && U.R) return;
    APP.showSetup();
  }
  function leave() {
    APP.teardown();
    if (U.preview) { safe(function () { U.preview.destroy(); }); U.preview = null; }
    APP.setDriving(false);
    U.screen = null;
    if (U.root) U.root.innerHTML = '';
  }
  function register() {
    var r = CB.router;
    if (!r || typeof r.on !== 'function' || U.registered) return;
    U.registered = true;
    r.on('derby', enter, leave);
  }
  if (CB.router && CB.router.on) register();
  document.addEventListener('cb:router-ready', register);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(register, 0); }); else setTimeout(register, 0);

  /* ================================================================== public + test hooks */
  function state() {
    var R = U.R, sn = R && R.lastSnap, me = sn ? sn.cars[0] : null;
    return {
      screen: U.screen, paused: !!(R && R.paused), phase: sn ? sn.phase : null, t: sn ? sn.t : 0, alive: sn ? sn.aliveCount : null, total: sn ? sn.total : null, spectating: !!(R && R.spectating), followId: R ? R.followId : null,
      renderer: R ? (R.renderer ? '3d' : '2d') : null, quality: R ? R.quality : null, fps: R ? Math.round(R.fpsEma) : null, rstats: R && R.renderer && R.renderer.stats ? safe(function () { return R.renderer.stats(); }) : null,
      player: me ? { x: me.x, y: me.y, heading: me.heading, speed_kph: me.speed * 3.6, health: me.health, zones: me.zones, wheels: me.wheels, out: me.out, acc: me.acc, stats: me.stats, flipped: me.flipped, airborne: me.airborne } : null,
      winnerId: sn ? sn.winnerId : null, results: U.screen === 'results' && U.lastResults ? { won: U.lastResults.won, position: U.lastResults.player && U.lastResults.player.position, mvp: U.lastResults.mvpId } : null,
      touch: !!(R && R.touch), touchLayout: R ? R.touchLayout || null : null
    };
  }
  CB.derby.ui.enter = enter; CB.derby.ui.leave = leave; CB.derby.ui.state = state; CB.derby.ui.start = function (o) { return hooks.start(o); };
  var hooks = {
    start: function (o) {
      o = o || {};
      var r = CB.router;
      if (r && r.current && r.current().route !== 'derby') r.go('derby');
      if (!U.S) { P.injectStyles(); U.S = P.loadSettings(); }
      if (!U.root) { var L = r && r.layer ? r.layer('derby') : document.body; U.root = h('div', { class: 'dd-root' }); L.appendChild(U.root); U.layer = L; }
      if (o.arenaId) U.S.arenaId = o.arenaId;
      if (o.presetId) { U.S.source = 'preset'; U.S.presetId = o.presetId; }
      if (o.accessories) U.S.accessories = AC().sanitize(o.accessories);
      if (o.opponents) U.S.opponents = clamp(o.opponents, 3, 11);
      if (o.difficulty) U.S.difficulty = o.difficulty;
      if (o.quality) U.S.quality = o.quality;
      if (o.timeLimit_s != null) U.S.timeLimit_s = o.timeLimit_s;
      if (o.lives) U.S.lives = o.lives;
      if (o.touch) U.S.touch = o.touch;
      if (o.slowmo != null) U.S.slowmo = !!o.slowmo;
      if (o.persist) APP.persist();
      startMatch({ seed: o.seed, autopilot: o.autopilot, force2d: o.force2d });
      return state();
    },
    state: state,
    step: function (n) { var R = U.R; if (!R || !R.session) return state(); for (var i = 0; i < (n || 1); i++) R.session.step(); R.lastSnap = R.session.snapshot(); return state(); },
    setInput: function (o) { var R = U.R; if (R) R.input.forced = o ? Object.assign({}, o) : null; return !!R; },
    autopilot: function (on) { var R = U.R; if (R && R.session) R.session.setPlayerAutopilot(on !== false); },
    end: function () { finish(true); return state(); },
    pause: pause, resume: resume, setup: function () { APP.showSetup(); return state(); },
    session: function () { return U.R ? U.R.session : null; }, renderer: function () { return U.R ? U.R.renderer : null; },
    lastResults: function () { return U.lastResults || null; },
    juice: function () { var R = U.R, J = R && R.juice ? R.juice.state : null; return J ? { score: J.score, combo: J.combo, popups: J.popups.length, announce: J.announce ? J.announce.text : null, hits: J.hits, bigHits: J.bigHits, firstHitT: J.firstHitT, longestGap: J.longestGap, replay: !!R.replay, hitStops: R.stats.hitStops, replays: R.stats.replays } : null; }
  };
  CB.derby.ui.hooks = hooks;
  if (!window.derby) window.derby = hooks;
})();

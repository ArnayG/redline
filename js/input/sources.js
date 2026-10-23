/* ==========================================================================
   FORGE — js/input/sources.js
   CB.input.sources : the shared "Steering source" picker. Every optional steering input (phone wheel, webcam air wheel,
   mouse / trackpad wheel, controller tilt) registers a definition here, and Settings → Driving, the race / drift setup
   "Controls & input" panel and the pause menu all render the same picker from it. Keyboard and gamepad always work on
   top of whatever is picked (they take over while used); picking a source switches the other OPT-IN sources off so two
   of them never fight over the wheel (a paired phone session is left alone: it only steers while it is connected).

     S.define(id, def)   def: { name, short?, order?, hint?,
                                available() -> {ok, reason?}      (reason: shown as the hint when not ok)
                                enable() -> Promise|*             (called from the click: a user gesture)
                                disable()                        isOn() -> bool
                                detailHTML() -> HTML             (settings for the source; inputs use data-ss-* or own attrs)
                                bindDetail(host)                 (wire listeners after detailHTML is inserted)
                                menuItems() -> [{label, icon, fn}]  (pause-menu entries while this source is picked)
                                status() -> {cls:'ok'|'bad'|'', text} | null }
     Built-in ids, in picker order: 'default' (Keyboard / Gamepad), 'phone' (Phone wheel), 'webcam' (Webcam air wheel,
     js/input/camwheel.js), 'mouse' (js/input/mouse-steer.js), 'padtilt' (Controller tilt, js/input/pad-tilt.js).
     A later define(id, ...) replaces the built-in adapter for that id.
     S.list() -> [{id, def}]   S.get(id)   S.selected() -> id   S.select(id) -> Promise   S.onChange(fn) -> off
     S.prefs / S.setPrefs({source, gamepadStick})   localStorage 'forge.steerSource.v1'
        gamepadStick 'proportional' (default) | 'digital': how CB.race.assist reads a gamepad stick (race-ui marks a
        proportional stick as steerAnalog, like the phone wheel: no line pick / lane pull, the wheel angle follows the stick)
     S.gamepadProportional() -> bool
     S.settingsHTML() -> HTML (Settings → Driving)   S.setupEl() -> Element (setup "Controls & input")   S.menuItems()
   Pure enough for Node (no DOM at load); the UI parts no-op without a document.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.input = CB.input || {};

(function () {
  'use strict';
  var PREF_KEY = 'forge.steerSource.v1';
  var ORDER = ['default', 'phone', 'webcam', 'mouse', 'padtilt'];
  var DEFAULT_PREFS = { source: 'default', gamepadStick: 'proportional' };
  var hasDOM = typeof document !== 'undefined' && typeof window !== 'undefined';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function normPrefs(p) {
    p = p && typeof p === 'object' ? p : {};
    return {
      source: typeof p.source === 'string' && p.source ? p.source : DEFAULT_PREFS.source,
      gamepadStick: p.gamepadStick === 'digital' ? 'digital' : 'proportional'
    };
  }
  function load() {
    try { var s = globalThis.localStorage && globalThis.localStorage.getItem(PREF_KEY); if (s) return normPrefs(JSON.parse(s)); } catch (e) { /* ignore */ }
    return normPrefs(DEFAULT_PREFS);
  }
  function save(p) { try { if (globalThis.localStorage) globalThis.localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ } }

  var defs = {};
  var listeners = [];
  function emit() { listeners.slice().forEach(function (fn) { try { fn(S.prefs.source); } catch (e) { /* ignore */ } }); }

  function okOf(def) {
    if (!def) return { ok: false, reason: 'Not available in this build' };
    if (typeof def.available !== 'function') return { ok: true };
    try { var r = def.available(); return r && typeof r === 'object' ? r : { ok: !!r }; } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
  }

  var S = {
    prefs: load(),
    define: function (id, def) { defs[String(id)] = def || {}; if (S._rerender) S._rerender(); return S; },
    get: function (id) { return defs[id] || null; },
    list: function () {
      var ids = ORDER.slice();
      Object.keys(defs).forEach(function (k) { if (ids.indexOf(k) < 0) ids.push(k); });
      return ids.filter(function (id) { return !!defs[id]; }).map(function (id) { return { id: id, def: defs[id] }; })
        .sort(function (a, b) { return (a.def.order != null ? a.def.order : ORDER.indexOf(a.id) * 10) - (b.def.order != null ? b.def.order : ORDER.indexOf(b.id) * 10); });
    },
    selected: function () { return defs[S.prefs.source] ? S.prefs.source : 'default'; },
    setPrefs: function (p) { S.prefs = normPrefs(Object.assign({}, S.prefs, p || {})); save(S.prefs); return S.prefs; },
    gamepadProportional: function () { return S.prefs.gamepadStick !== 'digital'; },
    onChange: function (fn) { listeners.push(fn); return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    /** Pick a source (call from a click: the source may need a user gesture). Other opt-in sources are switched off. */
    select: function (id) {
      var def = defs[id];
      if (!def) return Promise.resolve({ ok: false, reason: 'unknown' });
      Object.keys(defs).forEach(function (k) {
        if (k === id || k === 'default' || k === 'phone') return;
        var d = defs[k];
        try { if (d && typeof d.isOn === 'function' && d.isOn() && typeof d.disable === 'function') d.disable(); } catch (e) { /* ignore */ }
      });
      S.setPrefs({ source: id });
      var r;
      try { r = typeof def.enable === 'function' ? def.enable() : null; } catch (e) { r = { ok: false, reason: String(e && e.message || e) }; }
      emit();
      return Promise.resolve(r).then(function (x) { emit(); return x || { ok: true }; }, function (e) { emit(); return { ok: false, reason: String(e && e.message || e) }; });
    },
    menuItems: function () {
      var d = defs[S.selected()];
      if (!d || typeof d.menuItems !== 'function') return [];
      try { return d.menuItems() || []; } catch (e) { return []; }
    },
    _okOf: okOf, _ORDER: ORDER, _normPrefs: normPrefs, DEFAULT_PREFS: DEFAULT_PREFS
  };

  /* ---------------------------------------------------------------- built-in adapters */
  S.define('default', {
    name: 'Keyboard / Gamepad', short: 'Keys / pad',
    hint: 'Arrow keys or W A S D, or any standard gamepad (stick, triggers). Always available, whatever you pick.',
    available: function () { return { ok: true }; }, isOn: function () { return true; }
  });
  S.define('phone', {
    name: 'Phone wheel', short: 'Phone',
    hint: 'Pair a phone with a QR code and tilt it like a wheel (goes over the network: a few ms on Wi-Fi, more via the server relay).',
    available: function () { return { ok: !!(CB.input.ui && CB.input.ui.openPairing) || !!CB.input.wheel }; },
    enable: function () { var u = CB.input.ui; if (u && u.openPairing) u.openPairing(); return { ok: true }; },
    isOn: function () { var w = CB.input.wheel; return !!(w && w.session && w.session()); },
    detailHTML: function () { return '<div class="ss-row"><button class="gh-btn small" type="button" data-pw-act="pair">Pair phone</button><small>Phone steering settings are further down this page.</small></div>'; }
  });
  // webcam: a thin adapter over js/input/camwheel.js (that module may define('webcam', ...) itself to replace this)
  S.define('webcam', {
    name: 'Webcam air wheel', short: 'Webcam',
    hint: 'Hold your hands up like a steering wheel in front of the webcam and turn.',
    available: function () {
      var cw = CB.input.camwheel;
      if (!cw) return { ok: false, reason: 'Not loaded' };
      if (typeof cw.supported === 'function' && !cw.supported()) return { ok: false, reason: typeof cw.secure === 'function' && !cw.secure() ? 'Needs HTTPS' : 'No camera API in this browser' };
      return { ok: true };
    },
    enable: function () {
      var u = CB.input.ui, cw = CB.input.camwheel;
      if (u && typeof u.openCamWheel === 'function') return u.openCamWheel();
      if (cw && typeof cw.enable === 'function') return cw.enable();
      return { ok: false };
    },
    disable: function () { var cw = CB.input.camwheel; if (cw && typeof cw.disable === 'function') cw.disable(); },
    isOn: function () { var cw = CB.input.camwheel; return !!(cw && typeof cw.running === 'function' && cw.running()); }
  });

  /* ---------------------------------------------------------------- UI (browser only) */
  var CSS = [
    '.ss-box{display:flex;flex-direction:column;gap:10px}',
    '.ss-seg{display:flex;flex-wrap:wrap;gap:6px}',
    /* source buttons = the shared selection card (.mx-card): accent border + inset ring + soft tint when picked */
    '.ss-seg button{appearance:none;border:1px solid var(--line,#2b2c33);background:var(--panel-2,#1b1c21);color:var(--text,#ecebe6);border-radius:var(--radius-sm);transition:border-color var(--dur-2) var(--ease),background var(--dur-2) var(--ease);padding:8px 12px;font:600 var(--fs-sm) var(--font,system-ui,sans-serif);cursor:pointer;min-height:38px}',
    '.ss-seg button:hover:not(.is-on):not([disabled]){border-color:var(--line-2)}',
    '.ss-seg button.is-on{border-color:var(--accent,#c9a56b);background:linear-gradient(160deg,var(--accent-soft),transparent 70%),var(--panel-2);box-shadow:inset 0 0 0 1px var(--accent);color:var(--text-strong,#fff)}',
    '.ss-seg button:focus-visible,.ss-chipseg button:focus-visible{outline:none;box-shadow:var(--focus)}',
    '.ss-seg button[disabled]{opacity:.45;cursor:not-allowed}',
    '.ss-hint{color:var(--text-dim,#9b9890);font-size:var(--fs-xs);line-height:1.45}',
    '.ss-detail{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:var(--radius-sm);border:1px solid var(--line,#2b2c33);background:var(--bg-2)}',
    '.ss-detail:empty{display:none}',
    '.ss-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:var(--fs-sm)}',
    '.ss-row>span:first-child{min-width:130px;color:var(--text-dim,#9b9890)}',
    '.ss-row input[type=range]{flex:1;min-width:120px}',
    '.ss-row b{font-variant-numeric:tabular-nums;min-width:52px}',
    '.ss-row small{color:var(--text-dim,#9b9890)}',
    /* segmented = the shared .cb-tab-list look */
    '.ss-chipseg{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--line,#2b2c33);border-radius:12px;background:var(--bg-2)}',
    '.ss-chipseg button{appearance:none;border:1px solid transparent;border-radius:9px;min-height:28px;background:transparent;color:var(--text-dim,#9b9890);padding:0 10px;font:600 var(--fs-xs) var(--font,system-ui);cursor:pointer}',
    '.ss-chipseg button.is-on{background:linear-gradient(180deg,var(--panel-3),var(--panel-2));border-color:var(--line);box-shadow:var(--elev-1);color:var(--text-strong,#fff)}[data-theme="light"] .ss-chipseg button.is-on{background:var(--panel)}',
    '.ss-status{display:flex;align-items:center;gap:8px;font-size:var(--fs-sm);font-variant-numeric:tabular-nums}',
    '.ss-dot{width:9px;height:9px;border-radius:50%;background:var(--warn,#e3a33a);flex:none}',
    '.ss-dot.ok{background:var(--good,#3fbf7f)} .ss-dot.bad{background:var(--bad,#e5484d)}',
    '@media (pointer:coarse){.ss-seg button{min-height:44px}.ss-chipseg button{min-height:40px}}'
  ].join('\n');
  function ensureCss() {
    if (!hasDOM || document.getElementById('ss-css')) return;
    var s = document.createElement('style'); s.id = 'ss-css'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function pickerInner() {
    var cur = S.selected(), list = S.list();
    var segs = list.map(function (it) {
      var ok = okOf(it.def), on = it.id === cur;
      return '<button type="button" data-ss-pick="' + esc(it.id) + '" class="' + (on ? 'is-on' : '') + '" aria-pressed="' + on + '"' +
        (ok.ok ? '' : ' disabled title="' + esc(ok.reason || 'Not available') + '"') + '>' + esc(it.def.name || it.id) + '</button>';
    }).join('');
    var d = defs[cur] || {}, ok = okOf(d), st = null;
    try { st = typeof d.status === 'function' ? d.status() : null; } catch (e) { st = null; }
    var detail = '';
    try { detail = typeof d.detailHTML === 'function' ? d.detailHTML() || '' : ''; } catch (e) { detail = ''; }
    var unavailable = list.filter(function (it) { return !okOf(it.def).ok && it.id !== 'webcam'; }).map(function (it) { return esc(it.def.name) + ': ' + esc(okOf(it.def).reason || 'not available'); });
    return '<div class="ss-seg" role="radiogroup" aria-label="Steering source">' + segs + '</div>' +
      '<div class="ss-hint">' + esc(d.hint || '') + (ok.ok ? '' : ' <b>' + esc(ok.reason || '') + '</b>') + (cur !== 'default' ? ' Keyboard and gamepad still work and take over while used.' : '') + '</div>' +
      (st ? '<div class="ss-status" data-ss-status><span class="ss-dot ' + esc(st.cls || '') + '"></span><span>' + esc(st.text || '') + '</span></div>' : '') +
      '<div class="ss-detail" data-ss-detail>' + detail + '</div>' +
      (unavailable.length ? '<div class="ss-hint">' + unavailable.join(' · ') + '</div>' : '') +
      '<div class="ss-row"><span>Gamepad stick</span><div class="ss-chipseg" role="radiogroup">' +
      ['proportional', 'digital'].map(function (m) {
        return '<button type="button" data-ss-gp="' + m + '" class="' + (S.prefs.gamepadStick === m ? 'is-on' : '') + '">' + (m === 'proportional' ? 'Proportional (recommended)' : 'Digital (classic)') + '</button>';
      }).join('') + '</div><small>Proportional: half stick = half steering at every assist level. Digital: Heavy / Auto treat the stick like the arrow keys (it picks the line).</small></div>';
  }
  function bindRoot(root) {
    var d = defs[S.selected()];
    if (d && typeof d.bindDetail === 'function') { try { d.bindDetail(root.querySelector('[data-ss-detail]'), root); } catch (e) { /* ignore */ } }
  }
  function renderInto(root) {
    if (!root) return;
    // keep keyboard focus on the same button across the re-render (picking a source with Enter used to drop focus to <body>)
    var ae = document.activeElement, keep = null;
    if (ae && root.contains(ae)) keep = ['data-ss-pick', 'data-ss-gp'].filter(function (a) { return ae.hasAttribute(a); }).map(function (a) { return '[' + a + '="' + ae.getAttribute(a) + '"]'; })[0];
    root.innerHTML = pickerInner(); bindRoot(root);
    var n = keep && root.querySelector(keep);
    var dialogOpen = Array.prototype.some.call(document.querySelectorAll('[aria-modal="true"],[role="dialog"]'), function (d) { return !d.contains(root) && d.getClientRects().length > 0; });
    if (n && !n.disabled && !dialogOpen) { try { n.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }   // a dialog the pick opened keeps focus
  }
  function rerenderAll() { if (!hasDOM) return; Array.prototype.forEach.call(document.querySelectorAll('[data-ss-root]'), renderInto); }
  S._rerender = function () { if (hasDOM && document.body) rerenderAll(); };

  /** Settings → Driving section (HTML). Listeners are delegated on document. */
  S.settingsHTML = function () {
    ensureCss();
    if (hasDOM) setTimeout(function () { Array.prototype.forEach.call(document.querySelectorAll('[data-ss-root]'), bindRoot); }, 0);
    return '<h2 class="gh-h2">Steering source</h2><div class="gh-row" style="display:block"><div class="ss-box" data-ss-root>' + pickerInner() + '</div></div>';
  };
  /** Race / drift setup "Controls & input" (Element). */
  S.setupEl = function () {
    ensureCss();
    var box = document.createElement('div'); box.className = 'pw-setup';
    box.innerHTML = '<b>Steering source</b>';
    var root = document.createElement('div'); root.className = 'ss-box'; root.setAttribute('data-ss-root', '');
    box.appendChild(root); renderInto(root);
    return box;
  };
  S.refresh = rerenderAll;

  /* ---------------------------------------------------------------- driving HUD: steering indicator + hint line
     S.hud(id) -> { show(steer [-1, 1] (+1 = right), label, hint?), hide() }   one shared element in #race-root, the
     newest caller owns it (only one opt-in source steers at a time). */
  var hudEl = null, hudOwner = null, hudHintT = 0;
  var HUD_CSS = '#race-root .ss-hud{position:absolute;left:50%;bottom:max(64px,calc(env(safe-area-inset-bottom) + 56px));transform:translateX(-50%);z-index:5;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:6px;font:700 var(--fs-xs) var(--hud-font);color:var(--hud-ink);text-shadow:0 1px 2px rgba(0,0,0,.6)}' +
    '#race-root .ss-hud .ss-bar{position:relative;width:200px;height:8px;border-radius:4px;background:var(--hud-panel-soft);box-shadow:inset 0 0 0 1px var(--hud-line)}' +
    '#race-root .ss-hud .ss-bar::before{content:"";position:absolute;left:50%;top:-3px;bottom:-3px;width:1px;background:rgba(255,255,255,.4)}' +
    '#race-root .ss-hud .ss-fill{position:absolute;top:1px;bottom:1px;left:50%;width:0;border-radius:3px;background:var(--accent,#c9a56b)}' +
    '#race-root .ss-hud .ss-knob{position:absolute;top:-4px;width:6px;height:16px;margin-left:-3px;border-radius:3px;background:var(--hud-ink);left:50%}' +
    '#race-root .ss-hud .ss-lab{letter-spacing:.12em;text-transform:uppercase;font-size:var(--fs-2xs);opacity:.8}' +
    '#race-root .ss-hud .ss-tip{padding:7px 12px;border-radius:var(--pill);background:var(--hud-panel);border:1px solid var(--hud-line);letter-spacing:.02em;font-size:var(--fs-xs);text-transform:none}' +
    '#race-root .ss-hud .ss-tip:empty{display:none}';
  S.hud = function (id) {
    return {
      show: function (steer, label, hint) {
        if (!hasDOM) return;
        var root = document.getElementById('race-root');
        if (!root) return;
        if (!document.getElementById('ss-hud-css')) { var s = document.createElement('style'); s.id = 'ss-hud-css'; s.textContent = HUD_CSS; (document.head || document.documentElement).appendChild(s); }
        if (!hudEl || hudEl.parentNode !== root) {
          if (hudEl && hudEl.parentNode) hudEl.parentNode.removeChild(hudEl);
          hudEl = document.createElement('div'); hudEl.className = 'ss-hud'; hudEl.setAttribute('aria-hidden', 'true');
          hudEl.innerHTML = '<div class="ss-tip"></div><div class="ss-bar"><div class="ss-fill"></div><div class="ss-knob"></div></div><div class="ss-lab"></div>';
          root.appendChild(hudEl);
        }
        hudOwner = id;
        var v = Math.max(-1, Math.min(1, +steer || 0)), f = hudEl.querySelector('.ss-fill'), k = hudEl.querySelector('.ss-knob');
        k.style.left = (50 + 50 * v) + '%';
        f.style.left = (v < 0 ? 50 + 50 * v : 50) + '%'; f.style.width = (50 * Math.abs(v)) + '%';
        var lab = hudEl.querySelector('.ss-lab'), tip = hudEl.querySelector('.ss-tip');
        if (lab.textContent !== (label || '')) lab.textContent = label || '';
        if (tip.textContent !== (hint || '')) tip.textContent = hint || '';
        hudEl.style.display = '';
        hudHintT = Date.now();
      },
      hide: function () { if (hudEl && hudOwner === id) hudEl.style.display = 'none'; }
    };
  };

  if (hasDOM) {
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target : null;
      if (!t) return;
      var b = t.closest('[data-ss-pick]');
      if (b) {
        e.preventDefault(); e.stopPropagation();
        var id = b.getAttribute('data-ss-pick');
        if (id === 'default') {   // Keyboard / Gamepad: switch every opt-in source off
          Object.keys(defs).forEach(function (k) { var d = defs[k]; if (k !== 'default' && k !== 'phone' && d && typeof d.isOn === 'function' && d.isOn() && d.disable) { try { d.disable(); } catch (x) { /* ignore */ } } });
        }
        S.select(id).then(function () { rerenderAll(); });
        rerenderAll();
        return;
      }
      var g = t.closest('[data-ss-gp]');
      if (g) { e.preventDefault(); e.stopPropagation(); S.setPrefs({ gamepadStick: g.getAttribute('data-ss-gp') }); rerenderAll(); }
    }, true);
    // live status line (connection, live angle) while a picker is on screen
    setInterval(function () {
      var nodes = document.querySelectorAll('[data-ss-status]');
      if (!nodes.length) return;
      var d = defs[S.selected()], st = null;
      try { st = d && typeof d.status === 'function' ? d.status() : null; } catch (e) { st = null; }
      if (!st) return;
      Array.prototype.forEach.call(nodes, function (n) { n.innerHTML = '<span class="ss-dot ' + esc(st.cls || '') + '"></span><span>' + esc(st.text || '') + '</span>'; });
    }, 200);
  }

  CB.input.sources = S;
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
})();

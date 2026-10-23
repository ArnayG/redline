/* ==========================================================================
   Redline — js/f1/f1-ui.js
   CB.f1.ui : the #/f1 screens (docs/F1-SPEC.md §6). Registers itself on CB.router ('f1').

   Screens (all inside #screen-f1):
     setup     pick your team (11 liveries, text badges, which seat you take), the circuit (real F1 layouts) or the
               championship calendar, the format (Quick race / Race weekend / Championship), race length (laps or % of
               the real distance), difficulty, weather, time of day, starting tyre, assists, fastest-lap point
     hub       the running weekend: Practice → Qualifying → Race cards, last session's timing, the grid, points scored;
               in a championship also the drivers' and constructors' standings and the calendar
   Sessions run in CB.race.ui (overlay) with the F1 plugin: F1 circuits (findTrack), engine hooks (CB.f1.hooks via
   CB.f1.mode.sessionConfig), the F1 HUD (CB.f1.hud), separate best laps ('forge.f1.records.v1'), results panel.
   Saves: 'forge.f1.settings.v1', 'forge.f1.save.v1' (weekend / season in progress), 'forge.f1.stats.v1'.

   API: CB.f1.ui.open(el, params) · close() · state() · startSession(id?, opts?) · _ (pure helpers)
   Deep link: #/f1?quick=1&circuit=<id>&team=<id>&laps=<n> starts a quick race at once.
   Test hooks: window.f1 = { state(), start(sessionId), finish(results), go(screen) }.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.f1 = CB.f1 || {};

(function () {
  'use strict';

  var hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined' && typeof document.createElement === 'function';

  function mode() { return CB.f1.mode || null; }
  function wk() { return CB.f1.weekend || null; }
  function teams() { return CB.f1.teams || null; }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtLap(t) { if (!isNum(t) || t <= 0) return '—'; var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3); }
  function km(m) { return isNum(m) ? (m / 1000).toFixed(3) + ' km' : ''; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  /* ---------------------------------------------------------------- pure helpers */
  /** Seeded grid when qualifying is skipped: AI by skill (+ noise), the player mid-pack. Returns ids P1-first. */
  function simGrid(entrants, seed, playerPos) {
    var a = (seed >>> 0) || 7;
    function rnd() { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
    var l = (entrants || []).map(function (e) { return { id: e.id, s: (+e.skill || 0.7) + (rnd() - 0.5) * 0.06 }; });
    l.sort(function (x, y) { return y.s - x.s; });
    var ids = l.map(function (x) { return x.id; });
    var p = Math.max(0, Math.min(ids.length, (isNum(playerPos) ? playerPos : Math.floor(ids.length / 2) + 1) - 1));
    ids.splice(p, 0, 'player');
    return ids;
  }
  /** Calendar: the chosen circuits in catalogue order (the real-season order of CB.f1.circuits.list). */
  function calendar(all, chosen, rounds) {
    var ids = (all || []).map(function (d) { return d.id; });
    var pick = Array.isArray(chosen) && chosen.length >= 2 ? ids.filter(function (id) { return chosen.indexOf(id) >= 0; }) : ids.slice(0, rounds || 4);
    return pick;
  }
  function lapsLabel(S, def) {
    var M = mode();
    var laps = M ? M.raceLaps(def, { kind: S.lengthKind, laps: S.laps, pct: S.pct }) : S.laps;
    return laps + (laps === 1 ? ' lap' : ' laps');
  }

  /* ---------------------------------------------------------------- styles */
  /* Design system (css/styles.css § 01 tokens, § 18 screen family): the root is `.mx[data-mode="f1"]`, so the header
     (.mx-head / .mx-kicker / .mx-title / .mx-sub / .cb-back), section cards (.mx-sec + .mx-sec-title + .mx-step),
     selection cards (.mx-card.is-on), the sticky footer (.mx-foot / .mx-foot-sum / .mx-cta) and the gold CTA are the
     same as Race / Drift / Arcade / Derby / Drag. The F1 identity colour (--mode-f1 via --mx) only marks identity.
     Rules below only add the F1-specific layout (livery strips, circuit thumbnails, weekend sessions, timing tables). */
  var CSS = [
    '#screen-f1{background:var(--bg);color:var(--text)}',
    '.f1-root{min-height:100%;display:flex;flex-direction:column;font-family:var(--font);box-sizing:border-box;color:var(--text);background:radial-gradient(1100px 520px at 18% -12%,var(--mode-f1-soft),transparent 62%),var(--bg)}',
    '.f1-root *{box-sizing:border-box}',
    /* header: the shared .mx-head, in the page flow (like the derby / drag setups) */
    '.f1-top{width:100%;max-width:1500px;margin:0 auto;padding:var(--sp-5) max(var(--sp-4),env(safe-area-inset-right)) 0 max(var(--sp-4),env(safe-area-inset-left))}',
    '.f1-top .mx-headbar{margin-left:auto}',
    '@media (max-width:560px){.f1-teams{grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--sp-2)}.f1-livery{height:44px}.f1-back .lbl{display:none}.f1-back{min-width:var(--touch-min);padding:0 var(--sp-2)}}',
    '.f1-spacer{flex:1}',
    '.f1-main{flex:1;width:100%;max-width:1500px;margin:0 auto;padding:var(--sp-4) max(var(--sp-4),env(safe-area-inset-right)) var(--sp-6) max(var(--sp-4),env(safe-area-inset-left))}',
    '.f1-grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:var(--sp-5);align-items:start}',
    '@media (max-width:980px){.f1-grid{grid-template-columns:1fr}}',
    /* team / circuit cards: .mx-card selection look; the team card keeps its livery strip edge to edge */
    '.f1-teams{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:var(--sp-3)}',
    '.f1-team.mx-card{padding:0;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-start;align-items:stretch}',
    '.f1-livery{height:54px;position:relative}',
    '.f1-livery .num{position:absolute;right:var(--sp-2);bottom:var(--sp-1);font:800 var(--fs-2xl)/1 var(--hud-font);opacity:.95}',
    '.f1-team .meta{padding:var(--sp-2) var(--sp-3) var(--sp-3)}',
    '.f1-badge{display:inline-block;font:800 var(--fs-sm)/1 var(--hud-font);letter-spacing:.08em;text-transform:uppercase;padding:var(--sp-1) 7px;border-radius:var(--radius-xs);color:var(--mode-ink)}',
    '.f1-team .drv{font-size:var(--fs-xs);color:var(--text-dim);margin-top:6px;line-height:1.45}',
    '.f1-team .drv b{color:var(--text-strong);font-weight:600}',
    '.f1-seat{margin-top:var(--sp-2)}',
    '.f1-circuits{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:var(--sp-3)}',
    '.f1-circ.mx-card{padding:var(--sp-3);display:flex;gap:var(--sp-3);align-items:center;justify-content:flex-start}',
    '.f1-circ canvas{flex:0 0 auto;width:84px;height:64px}',
    '.f1-circ .nm{font-weight:650;font-size:var(--fs-md);line-height:1.2;color:var(--text-strong)}',
    '.f1-circ .ct{font-size:var(--fs-xs);color:var(--text-dim);margin-top:2px}',
    '.f1-circ .st{font:600 var(--fs-xs)/1.3 var(--mono);color:var(--text);margin-top:5px}',
    '.f1-circ .rnd{position:absolute;top:6px;right:var(--sp-2);font-size:var(--fs-2xs);font-weight:700;letter-spacing:.12em;color:var(--mx)}',
    '.f1-night{display:inline-block;font-size:var(--fs-2xs);font-weight:700;letter-spacing:.1em;padding:2px 5px;border-radius:var(--radius-xs);background:var(--panel-3);color:var(--text-dim);border:1px solid var(--line);margin-left:6px;vertical-align:middle}',
    /* session sidebar: an .mx-sec card, sticky */
    '.f1-panel.mx-sec{position:sticky;top:var(--sp-4);margin-bottom:0}',
    '.f1-field{margin-bottom:var(--sp-4)}',
    '.f1-field>label{display:block;font-size:var(--fs-2xs);font-weight:700;letter-spacing:var(--tracking-caps);text-transform:uppercase;color:var(--text-dim);margin-bottom:var(--sp-2)}',
    /* segmented controls: the shared tab list */
    '.f1-root .cb-tab-list.f1-seg{flex-wrap:wrap;overflow:visible}',
    '.f1-root .f1-seg .cb-tab{flex:1 1 auto;min-height:var(--control-h-sm);cursor:pointer}',
    '.f1-row{display:flex;align-items:center;gap:var(--sp-2)}',
    '.f1-step{display:flex;align-items:center;gap:var(--sp-2)}',
    '.f1-step output{min-width:64px;text-align:center;font:700 var(--fs-lg)/1 var(--mono);color:var(--text-strong)}',
    '.f1-step .cb-btn{width:var(--control-h-md);min-height:var(--control-h-md);padding:0;font-size:var(--fs-lg)}',
    '.f1-toggle{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-3);min-height:var(--control-h-sm);font-size:var(--fs-sm);cursor:pointer;color:var(--text)}',
    '.f1-toggle input{width:18px;height:18px;accent-color:var(--accent)}',
    '.f1-hint{font-size:var(--fs-xs);color:var(--text-dim);line-height:1.45}',
    '.f1-hint b{color:var(--text)}',
    '.f1-continue{display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-3) var(--sp-4);border-radius:var(--radius-lg);background:linear-gradient(90deg,var(--mx-soft),transparent 75%),var(--panel);border:1px solid color-mix(in srgb,var(--mx) 40%,var(--line));margin-bottom:var(--sp-4);flex-wrap:wrap}',
    '.f1-continue b{color:var(--text-strong)}',
    /* weekend hub: session cards share the .mx-card look (current = selected) */
    '.f1-sessions{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:var(--sp-3);margin-bottom:var(--sp-4)}',
    '.f1-sess.mx-card{padding:var(--sp-3) var(--sp-4);cursor:default}',
    '.f1-sess.is-done{opacity:.78}',
    '.f1-sess .k{font-size:var(--fs-2xs);font-weight:700;letter-spacing:var(--tracking-caps);text-transform:uppercase;color:var(--mx)}',
    '.f1-sess .n{font-family:var(--serif);font-size:var(--fs-xl);font-weight:var(--fw-title);color:var(--text-strong);margin:var(--sp-1) 0}',
    '.f1-table{width:100%;border-collapse:collapse;font-size:var(--fs-sm);color:var(--text)}',
    '.f1-table th{text-align:left;font-size:var(--fs-2xs);font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text-dim);padding:var(--sp-2);border-bottom:1px solid var(--line)}',
    '.f1-table td{padding:6px var(--sp-2);border-bottom:1px solid var(--line-soft);white-space:nowrap}',
    '.f1-table tr.me td{background:var(--mx-soft);color:var(--text-strong);font-weight:650}',
    '.f1-table .bar{display:inline-block;width:4px;height:14px;vertical-align:middle;margin-right:6px;border-radius:1px}',
    '.f1-table .mono{font-family:var(--mono)}',
    '.f1-table .pts{font-weight:750;text-align:right;color:var(--text-strong)}',
    '.f1-tyre{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;border:2px solid;font:800 var(--fs-2xs)/1 var(--hud-font);margin-right:2px;background:var(--panel-3)}',
    /* F1 timing purple: fastest lap (the sport's own colour, used identically by the F1 HUD) */
    '.f1-fl{color:#b64dff;font-weight:800}',
    '.f1-tabs{margin-bottom:var(--sp-3)}',
    '.f1-scroll{overflow:auto;max-width:100%}',
    '.f1-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:var(--sp-2);margin-top:var(--sp-3)}',
    '.f1-stat{background:var(--panel-2);border:1px solid var(--line);border-radius:var(--radius-sm);padding:var(--sp-2)}',
    '.f1-stat b{display:block;font-size:var(--fs-xl);font-weight:700;color:var(--text-strong);font-variant-numeric:tabular-nums}',
    '.f1-stat span{font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--text-dim)}',
    /* result banner (weekend hub + the race results panel): accent-tinted card with a serif verdict */
    '.f1-res{display:flex;flex-direction:column;gap:6px;padding:var(--sp-3) var(--sp-4);border-radius:var(--radius-lg);background:linear-gradient(90deg,var(--mx-soft,var(--mode-f1-soft)),transparent 80%),var(--panel);border:1px solid color-mix(in srgb,var(--mx,var(--mode-f1)) 40%,var(--line));margin-bottom:var(--sp-3);color:var(--text)}',
    '.f1-res b{font-family:var(--serif);font-size:var(--fs-xl);font-weight:var(--fw-title);letter-spacing:var(--tracking-title);color:var(--text-strong)}',
    '.f1-foot{display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap;margin-top:var(--sp-3)}',
    /* sticky footer: the shared .mx-foot; the team swatch leads the summary line */
    '.f1-footer .sw{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:0;margin-right:var(--sp-2)}',
    '.f1-cta svg{width:16px;height:16px}',
    /* short landscape phones: a slim header (no subtitle) and footer so the cards keep the screen */
    '@media (max-height:500px){.f1-top{padding-top:var(--sp-3)}.f1-top .mx-sub{display:none}.f1-top .mx-title{font-size:var(--fs-xl)}.f1-top .mx-kicker{margin-bottom:var(--sp-1)}.f1-main{padding-top:var(--sp-3)}.f1-footer.mx-foot{padding-top:var(--sp-2);padding-bottom:max(var(--sp-2),env(safe-area-inset-bottom))}.f1-footer .f1-cta{min-height:var(--control-h-md)}.f1-panel.mx-sec{position:static}}',
    /* touch: >= 44 px controls */
    '@media (pointer:coarse){.f1-root .cb-btn{min-height:var(--touch-min)}.f1-root .f1-seg .cb-tab{min-height:var(--touch-min)}.f1-toggle{min-height:var(--touch-min)}.f1-toggle input{width:22px;height:22px}.f1-step .cb-btn{width:var(--touch-min);min-height:var(--touch-min)}}'
  ].join('\n');
  function injectStyles() {
    if (!hasDOM || document.getElementById('f1-ui-styles')) return;
    var st = document.createElement('style'); st.id = 'f1-ui-styles'; st.textContent = CSS; document.head.appendChild(st);
  }

  /* ---------------------------------------------------------------- DOM helper */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && isObj(v)) Object.keys(v).forEach(function (s) { el.style.setProperty(s, v[s]); });
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function seg(list, cur, onPick) {
    return h('div', { class: 'cb-tab-list f1-seg', role: 'group' }, list.map(function (o) {
      return h('button', { class: 'cb-tab' + (o.id === cur ? ' is-active' : ''), type: 'button', title: o.desc || null, 'aria-pressed': o.id === cur ? 'true' : 'false',
        onclick: function () { onPick(o.id); } }, o.name);
    }));
  }
  function field(label, body, hint) { return h('div', { class: 'f1-field' }, h('label', { text: label }), body, hint ? h('div', { class: 'f1-hint' }, hint) : null); }
  function toggle(label, on, cb, title) {
    var inp = h('input', { type: 'checkbox' });
    inp.checked = !!on;
    inp.addEventListener('change', function () { cb(inp.checked); });
    return h('label', { class: 'f1-toggle', title: title || null }, h('span', { text: label }), inp);
  }
  function stepper(val, min, max, cb, fmt) {
    var out = h('output', { text: fmt ? fmt(val) : String(val) });
    function set(v) { v = Math.max(min, Math.min(max, v)); val = v; out.textContent = fmt ? fmt(v) : String(v); cb(v); }
    return h('div', { class: 'f1-step' },
      h('button', { class: 'cb-btn', type: 'button', 'aria-label': 'Less', onclick: function () { set(val - 1); } }, '−'), out,
      h('button', { class: 'cb-btn', type: 'button', 'aria-label': 'More', onclick: function () { set(val + 1); } }, '+'));
  }
  function liveryCss(t) {
    var L = t.livery;
    return 'linear-gradient(118deg,' + L.primary + ' 0 52%,' + L.secondary + ' 52% 70%,' + L.accent + ' 70% 76%,' + L.primary + ' 76% 100%)';
  }
  function tyreChip(c) {
    var M = mode(), cc = M && M.compound(c);
    if (!cc) return '';
    return '<span class="f1-tyre" style="border-color:' + cc.color + ';color:' + cc.color + '" title="' + esc(cc.name) + '">' + cc.letter + '</span>';
  }
  /** a § 01 design token's current value (theme-aware) for canvas drawing */
  function token(name, fb) {
    try { var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fb; } catch (e) { return fb; }
  }
  function drawPreview(cv, def) {
    var T = CB.race && CB.race.tracks;
    if (!cv || !T || typeof T.previewPath !== 'function') return;
    var dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1), w = 84, hh = 64;
    cv.width = w * dpr; cv.height = hh * dpr;
    var ctx = cv.getContext && cv.getContext('2d'); if (!ctx) return;
    var pts; try { pts = T.previewPath(def, w, hh, 6); } catch (e) { return; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); pts.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath();
    ctx.strokeStyle = token('--text', '#e9e6df'); ctx.lineWidth = 2.2; ctx.stroke();
    if (pts[0]) { ctx.fillStyle = token('--mode-f1', '#ff1e3c'); ctx.fillRect(pts[0][0] - 2.5, pts[0][1] - 2.5, 5, 5); }
  }

  /* ---------------------------------------------------------------- state */
  var U = null;
  function store() { return wk() ? wk().store() : null; }
  function persist() { var s = store(); if (s && U) s.saveSettings(U.settings); }
  function saveRun() { var s = store(); if (!s || !U) return; if (U.run) s.save(U.run); else s.clear(); }
  function playerName() {
    try { var p = CB.game && CB.game.profile && CB.game.profile.get && CB.game.profile.get(); var n = p && typeof p.driverName === 'string' ? p.driverName.trim() : ''; if (n) return n.slice(0, 24); } catch (e) { /* ignore */ }
    return 'You';
  }
  function records() {
    var RU = CB.race && CB.race.ui && CB.race.ui._;
    if (!RU || typeof RU.createRecords !== 'function') return null;
    try { return RU.createRecords(typeof localStorage !== 'undefined' ? localStorage : null, 'forge.f1.records.v1'); } catch (e) { return null; }
  }

  function open(el, params) {
    injectStyles();
    params = params || {};
    var M = mode();
    var saved = store() ? store().loadSettings() : {};
    if (!U || U.el !== el) U = { el: el, screen: 'setup', run: store() ? store().load() : null, tab: 'session' };
    U.settings = M ? M.sanitize(Object.assign({}, saved, U.settings || {})) : saved;
    // deep link
    if (params.team && teams() && teams().get(params.team)) U.settings.team = params.team;
    if (params.circuit && M && M.circuit(params.circuit)) U.settings.circuitId = params.circuit;
    if (params.laps && isFinite(+params.laps)) { U.settings.lengthKind = 'laps'; U.settings.laps = Math.max(1, Math.round(+params.laps)); }
    if (U.run && (U.run.kind === 'season' || U.run.kind === 'weekend') && params.quick !== '1') U.screen = U.screen === 'hub' ? 'hub' : 'setup';
    render();
    if (params.quick === '1' || params.quick === 1) {
      U.run = wk().createWeekend({ circuitId: U.settings.circuitId, format: 'quick', settings: U.settings });
      startSession();
    }
    return api;
  }
  function close() {
    if (CB.race && CB.race.ui && CB.race.ui.isOpen && CB.race.ui.isOpen() && U && U.racing) { U.closing = true; try { CB.race.ui.close(); } catch (e) { /* ignore */ } }
    if (U) U.racing = false;
  }
  function render() {
    if (!U || !U.el || !hasDOM) return;
    var el = U.el;
    while (el.firstChild) el.removeChild(el.firstChild);
    if (!mode() || !teams() || !wk()) { el.appendChild(h('div', { class: 'f1-root' }, h('p', { text: 'Formula 1 modules did not load (js/f1/*).' }))); return; }
    var root = h('div', { class: 'f1-root mx', 'data-mode': 'f1' });
    el.appendChild(root);
    if (U.screen === 'hub' && U.run) renderHub(root); else renderSetup(root);
    try { el.scrollTop = U.scroll || 0; } catch (e) { /* ignore */ }
  }
  var BACK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
  var FLAG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/></svg>';
  function sharedIcon(name, fb) { var I = CB.ui && CB.ui.icons; return (I && I[name]) || fb; }
  /** Header (§ 18 screen family): accent kicker + serif title + sub; ghost actions and "Main menu" (Esc) on the right. */
  function header(kicker, title, sub, extra) {
    return h('header', { class: 'f1-top mx-head' },
      h('div', { class: 'f1-titles' },
        h('div', { class: 'mx-kicker', text: kicker }),
        h('h1', { class: 'mx-title', text: title }),
        sub ? h('p', { class: 'mx-sub', text: sub }) : null),
      h('div', { class: 'mx-headbar' },
        extra || null,
        h('button', { class: 'cb-btn ghost cb-back f1-back', type: 'button', title: 'Main menu (Esc)', 'aria-label': 'Main menu',
          html: sharedIcon('back', BACK_SVG) + '<span class="lbl">Main menu</span><kbd>Esc</kbd>',
          onclick: function () { goMenu(); } })));
  }
  function goMenu() { if (CB.router && CB.router.go) CB.router.go('menu'); }
  /** Esc on the setup / weekend screens goes back to the main menu (like the race setup); never while racing or typing. */
  function onKey(e) {
    if (e.key !== 'Escape' || !U || U.racing || !U.el || !U.el.isConnected || e.defaultPrevented) return;
    var r = CB.router && CB.router.current ? CB.router.current() : null;
    if (r && r.route && r.route !== 'f1') return;
    var scr = U.el.closest ? U.el.closest('.cb-screen') : null;
    if (scr && scr.hidden) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (document.querySelector('.cb-modal:not([hidden]), #modal-root .cb-modal')) return;
    e.preventDefault(); goMenu();
  }
  /** Sticky footer (.mx-foot): summary line + meta line on the left, the gold CTA on the right. */
  function footer(title, meta, cta, swatch) {
    return h('footer', { class: 'f1-footer mx-foot' },
      h('div', { class: 'mx-foot-sum' },
        h('b', null, swatch ? h('i', { class: 'sw', style: { background: swatch } }) : null, title),
        meta ? h('span', { text: meta }) : null),
      cta ? h('div', { class: 'mx-cta' }, cta) : null);
  }
  function cta(label, attrs, onclick) {
    return h('button', Object.assign({ class: 'cb-btn primary large f1-cta', type: 'button', onclick: onclick, html: sharedIcon('play', FLAG_SVG) + '<span>' + esc(label) + '</span>' }, attrs || {}));
  }
  function secTitle(n, label, hint) {
    return h('h3', { class: 'mx-sec-title f1-h' },
      h('span', { class: 't' }, n ? h('i', { class: 'mx-step', text: String(n) }) : null, label),
      hint ? h('span', { class: 'mx-hint', text: hint }) : null);
  }

  /* ---------------------------------------------------------------- setup */
  function renderSetup(root) {
    var S = U.settings, M = mode(), T = teams();
    root.appendChild(header('Formula 1', 'Team & circuit', 'Single-spec grid · ' + T.list.length + ' teams · real circuits'));
    var main0 = h('div', { class: 'f1-main' });
    root.appendChild(main0);
    var rootAll = root;
    root = main0;
    if (U.run) {
      var r = U.run, def = M.circuit(r.kind === 'season' ? r.rounds[r.round] : r.circuitId);
      var label = r.kind === 'season' ? 'Championship · round ' + (r.round + 1) + ' of ' + r.rounds.length : 'Race weekend';
      root.appendChild(h('div', { class: 'f1-continue' },
        h('div', null, h('b', { text: label }), h('div', { class: 'f1-hint', text: (def ? def.name : '') + ' · ' + ((T.get(r.settings && r.settings.team) || {}).name || '') })),
        h('div', { class: 'f1-spacer' }),
        h('button', { class: 'cb-btn primary', type: 'button', onclick: function () { U.screen = 'hub'; render(); } }, 'Continue'),
        h('button', { class: 'cb-btn ghost', type: 'button', onclick: function () { if (!hasDOM || window.confirm('Abandon the ' + (r.kind === 'season' ? 'championship' : 'weekend') + ' in progress?')) { U.run = null; saveRun(); render(); } } }, 'Abandon')));
    }
    var grid = h('div', { class: 'f1-grid' });
    var left = h('div'), right = h('div');
    grid.appendChild(left); grid.appendChild(right);
    root.appendChild(grid);

    // teams
    var tGrid = h('div', { class: 'f1-teams' });
    T.list.forEach(function (t) {
      var on = S.team === t.id;
      var card = h('button', { class: 'f1-team mx-card' + (on ? ' is-on' : ''), type: 'button', 'data-team': t.id, 'aria-pressed': on ? 'true' : 'false',
        onclick: function (e) { if (e.target && e.target.closest && e.target.closest('.f1-seat')) return; S.team = t.id; persist(); render(); } },
        h('div', { class: 'f1-livery', style: { background: liveryCss(t) } }, h('span', { class: 'num', style: { color: t.livery.number }, text: t.drivers[on ? 1 - S.seat : 0].number })),
        h('div', { class: 'meta' },
          h('span', { class: 'f1-badge', style: { background: t.livery.secondary === '#ffffff' || t.livery.secondary === '#f2f2f2' ? '#111' : t.livery.secondary }, text: t.name }),
          h('div', { class: 'drv', html: on
            ? 'You <b>replace ' + esc(t.drivers[S.seat].name) + '</b><br>Teammate: ' + esc(t.drivers[1 - S.seat].name) + ' #' + t.drivers[1 - S.seat].number
            : t.drivers.map(function (d) { return '#' + d.number + ' ' + esc(d.name); }).join('<br>') }),
          on ? h('div', { class: 'f1-seat cb-tab-list f1-seg' }, t.drivers.map(function (d, i) {
            return h('span', { class: 'cb-tab' + (S.seat === i ? ' is-active' : ''), role: 'button', tabindex: '0', title: 'Take this seat', 'aria-pressed': S.seat === i ? 'true' : 'false',
              onclick: function (e) { e.stopPropagation(); S.seat = i; persist(); render(); },
              onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); S.seat = i; persist(); render(); } } }, 'Seat ' + (i + 1));
          })) : null));
      tGrid.appendChild(card);
    });
    left.appendChild(h('section', { class: 'f1-sec mx-sec' }, secTitle(1, 'Pick your team', 'Every car is the same spec — the liveries are the teams\' real colours'), tGrid));

    // circuits
    var list = M.circuits(), season = S.format === 'season';
    var chosen = season ? (S.seasonCircuits && S.seasonCircuits.length >= 2 ? S.seasonCircuits : calendar(list, null, S.rounds)) : null;
    var cGrid = h('div', { class: 'f1-circuits' });
    list.forEach(function (d) {
      var inf = M.info(d), on = season ? chosen.indexOf(d.id) >= 0 : S.circuitId === d.id;
      var cv = h('canvas', { 'aria-hidden': 'true' });
      var rnd = season && on ? calendar(list, chosen).indexOf(d.id) + 1 : 0;
      var card = h('button', { class: 'f1-circ mx-card' + (on ? ' is-on' : ''), type: 'button', 'data-circuit': d.id, 'aria-pressed': on ? 'true' : 'false',
        onclick: function () {
          if (season) {
            var c = chosen.slice(), i = c.indexOf(d.id);
            if (i >= 0) { if (c.length > 2) c.splice(i, 1); } else c.push(d.id);
            S.seasonCircuits = c; S.rounds = c.length;
          } else S.circuitId = d.id;
          persist(); render();
        } },
        cv,
        h('div', null,
          h('div', { class: 'nm', html: esc(inf.name) + (inf.night ? '<span class="f1-night">NIGHT</span>' : '') }),
          h('div', { class: 'ct', text: [d.city, inf.country].filter(Boolean).join(' · ') }),
          h('div', { class: 'st', text: km(inf.realLength_m) + (inf.f1 ? ' · ' + inf.realLaps + ' laps' : '') + (isNum(inf.pole_s) ? ' · pole ' + fmtLap(inf.pole_s) : '') })),
        rnd ? h('span', { class: 'rnd', text: 'R' + rnd }) : null);
      cGrid.appendChild(card);
      setTimeout(function () { drawPreview(cv, d); }, 0);
    });
    left.appendChild(h('section', { class: 'f1-sec mx-sec' }, season ? secTitle(2, 'Championship calendar', 'Tap circuits to add or remove rounds (' + chosen.length + ' rounds)') : secTitle(2, 'Pick the circuit', 'Faithful recreations of the real layouts'), cGrid));

    // settings panel
    var P = h('div', { class: 'f1-panel mx-sec' });
    P.appendChild(secTitle(3, 'Session'));
    P.appendChild(field('Format', seg(M.FORMATS, S.format, function (v) { S.format = v; persist(); render(); }),
      (M.FORMATS.filter(function (f) { return f.id === S.format; })[0] || {}).desc));
    if (season) P.appendChild(field('Each round', seg([{ id: 'quick', name: 'Race only' }, { id: 'weekend', name: 'Full weekend' }], S.seasonWeekend ? 'weekend' : 'quick', function (v) { S.seasonWeekend = v === 'weekend'; persist(); render(); })));
    var def0 = M.circuit(S.circuitId);
    P.appendChild(field('Race length', h('div', null,
      seg([{ id: 'laps', name: 'Laps' }, { id: 'pct', name: '% distance' }], S.lengthKind, function (v) { S.lengthKind = v; persist(); render(); }),
      h('div', { style: { 'margin-top': '6px' } }, S.lengthKind === 'laps'
        ? stepper(S.laps, 1, 80, function (v) { S.laps = v; persist(); var o = U.el.querySelector('[data-laps-label]'); if (o) o.textContent = lapsLabel(S, def0); })
        : seg([5, 10, 25, 50, 100].map(function (p) { return { id: p, name: p + '%' }; }), S.pct, function (v) { S.pct = v; persist(); render(); }))),
      season ? 'Per round' : h('span', { 'data-laps-label': '1', text: lapsLabel(S, def0) + ' at ' + (def0 ? M.info(def0).name : '') })));
    P.appendChild(field('Difficulty', seg(M.DIFFICULTIES, S.difficulty, function (v) { S.difficulty = v; persist(); render(); }),
      (M.DIFFICULTIES.filter(function (d) { return d.id === S.difficulty; })[0] || {}).desc + ' · AI skill only, the cars are identical'));
    P.appendChild(field('Weather', seg(M.WEATHERS, S.weather, function (v) { S.weather = v; persist(); render(); })));
    P.appendChild(field('Time of day', seg([{ id: 'auto', name: 'Circuit default', desc: 'Night races run under the lights' }].concat(M.TIMES), S.timeOfDay, function (v) { S.timeOfDay = v; persist(); render(); })));
    if (S.weather === 'dry') P.appendChild(field('Starting tyre', seg(M.COMPOUNDS.slice(0, 3), S.startCompound, function (v) { S.startCompound = v; persist(); render(); })));
    P.appendChild(field('Camera', seg([{ id: 'chase', name: 'Chase' }, { id: 'chase-far', name: 'Far' }, { id: 'cockpit', name: 'Onboard' }, { id: 'tv', name: 'TV' }], S.camera, function (v) { S.camera = v; persist(); render(); }), 'C cycles cameras in the race'))
    var A = S.assists;
    P.appendChild(field('Assists', h('div', null,
      toggle('Braking line', A.brakingLine, function (v) { A.brakingLine = v; persist(); }),
      toggle('ABS', A.abs, function (v) { A.abs = v; persist(); }),
      toggle('Traction control', A.tc, function (v) { A.tc = v; persist(); }),
      toggle('Automatic gears', A.autoShift, function (v) { A.autoShift = v; persist(); }),
      toggle('Automatic DRS', A.autoDrs, function (v) { A.autoDrs = v; persist(); }, 'Opens the flap for you whenever DRS is available'),
      h('div', { style: { 'margin-top': '6px' } }, seg([{ id: 'off', name: 'Steer off' }, { id: 'light', name: 'Light' }, { id: 'medium', name: 'Medium' }], A.steering, function (v) { A.steering = v; persist(); render(); })))));
    if (S.format !== 'quick') P.appendChild(toggle('Fastest-lap point (top 10)', S.fastestLapPoint, function (v) { S.fastestLapPoint = v; persist(); }));
    var start = cta(S.format === 'quick' ? 'Start race' : S.format === 'weekend' ? 'Start weekend' : 'Start championship', { 'data-act': 'start' }, beginRun);
    P.appendChild(h('div', { class: 'f1-hint', style: { 'margin-top': 'var(--sp-2)' }, html: 'Keys: <b>F</b> DRS · <b>N</b> ERS boost (hold) · <b>V</b> ERS mode · <b>I</b> box this lap · <b>O</b> pit tyre. Pad: RB DRS, LB boost, Back box.' }));
    var st = store() ? store().stats() : null;
    if (st && st.races) P.appendChild(h('div', { class: 'f1-stats' },
      [['Races', st.races], ['Wins', st.wins], ['Podiums', st.podiums], ['Poles', st.poles], ['Points', st.points], ['Titles', st.titles]].map(function (x) { return h('div', { class: 'f1-stat' }, h('b', { text: String(x[1]) }), h('span', { text: x[0] })); })));
    right.appendChild(P);
    var tm = T.get(S.team) || T.list[0], defS = M.circuit(S.circuitId), fmt = (M.FORMATS.filter(function (f) { return f.id === S.format; })[0] || {}).name || S.format;
    rootAll.appendChild(footer(tm.name + ' · ' + (season ? chosen.length + ' rounds' : (defS ? M.info(defS).name : '')),
      [fmt, season ? null : lapsLabel(S, defS), 'AI ' + ((M.DIFFICULTIES.filter(function (d) { return d.id === S.difficulty; })[0] || {}).name || S.difficulty)].filter(Boolean).join(' · '),
      start, tm.livery.primary));
  }

  function beginRun() {
    var S = U.settings, W = wk(), M = mode();
    if (U.run && !(hasDOM && window.confirm('Start a new ' + (S.format === 'season' ? 'championship' : 'event') + '? The one in progress will be abandoned.'))) return;
    if (S.format === 'season') {
      var rounds = calendar(M.circuits(), S.seasonCircuits, S.rounds);
      U.run = W.createSeason({ rounds: rounds, settings: clone(S), sessionFormat: S.seasonWeekend ? 'weekend' : 'quick' });
    } else U.run = W.createWeekend({ circuitId: S.circuitId, format: S.format, settings: clone(S) });
    saveRun();
    if (S.format === 'quick') { startSession(); return; }
    U.screen = 'hub'; render();
  }

  /* ---------------------------------------------------------------- weekend / season hub */
  function weekendOf(run) { return run ? (run.kind === 'season' ? run.weekend : run) : null; }
  function runSettings() { return U.run && U.run.settings && U.run.settings.team ? mode().sanitize(U.run.settings) : U.settings; }
  function renderHub(root) {
    var run = U.run, W = wk(), M = mode(), T = teams(), S = runSettings();
    var w = weekendOf(run), def = w ? M.circuit(w.circuitId) : null, inf = def ? M.info(def) : null;
    var team = T.get(S.team);
    var title = run.kind === 'season' ? 'Championship · ' + (W.isSeasonOver(run) ? 'final standings' : 'round ' + (run.round + 1) + ' of ' + run.rounds.length) : 'Race weekend';
    root.appendChild(header('Formula 1 · ' + title, inf ? inf.name : title, inf ? [def.city, inf.country].filter(Boolean).join(' · ') + ' · ' + km(inf.realLength_m) + ' · ' + lapsLabel(S, def) : null,
      h('button', { class: 'cb-btn ghost', type: 'button', html: sharedIcon('settings', '') + '<span>Setup</span>', onclick: function () { U.screen = 'setup'; render(); } })));
    var rootAll = root, hubCta = null;
    root = h('div', { class: 'f1-main' });
    rootAll.appendChild(root);
    if (U.lastPanel) { root.appendChild(U.lastPanel); }
    var main = h('div', { class: 'f1-grid' }), left = h('div'), right = h('div');
    main.appendChild(left); main.appendChild(right); root.appendChild(main);
    if (w) {
      var cur = W.currentSession(w);
      var sRow = h('div', { class: 'f1-sessions' });
      w.sessions.forEach(function (s, i) {
        var meta = M.SESSIONS.filter(function (x) { return x.id === s.id; })[0] || { name: s.id };
        var isCur = cur && cur === s;
        var status = s.done ? (s.skipped ? 'Skipped' : sessionSummary(s)) : isCur ? meta.desc : 'Later';
        sRow.appendChild(h('div', { class: 'f1-sess mx-card' + (isCur ? ' is-cur is-on' : '') + (s.done ? ' is-done' : '') },
          h('div', { class: 'k', text: 'Session ' + (i + 1) }), h('div', { class: 'n', text: meta.name }), h('div', { class: 'f1-hint', text: status }),
          isCur && s.id !== 'race' ? h('div', { class: 'f1-foot' },
            h('button', { class: 'cb-btn ghost', type: 'button', onclick: function () { skip(); } }, s.id === 'qualifying' ? 'Skip (simulate)' : 'Skip')) : null));
        if (isCur) hubCta = cta('Start ' + String(meta.name).toLowerCase(), { 'data-act': 'session' }, function () { startSession(s.id); });
      });
      left.appendChild(sRow);
      var last = null;
      w.sessions.forEach(function (s) { if (s.done && s.results) last = s; });
      if (last) left.appendChild(h('section', { class: 'f1-sec mx-sec' }, secTitle(0, (M.SESSIONS.filter(function (x) { return x.id === last.id; })[0] || {}).name || last.id, 'Classification'), resultsTable(last)));
      if (cur && cur.id === 'race' && w.grid) left.appendChild(h('div', { class: 'f1-hint', text: 'Grid set by qualifying: you start P' + (w.grid.indexOf('player') + 1) + '.' }));
    } else if (W.isSeasonOver(run)) {
      left.appendChild(h('div', { class: 'f1-res' }, h('b', { text: 'Season complete' }), h('div', { text: championLine(run) }),
        null));
      hubCta = cta('New season', null, function () { U.run = null; saveRun(); U.screen = 'setup'; U.lastPanel = null; render(); });
    }
    if (run.kind === 'season') right.appendChild(standingsPanel(run));
    else if (w && W.isComplete(w)) {
      right.appendChild(h('div', { class: 'f1-panel mx-sec' }, secTitle(0, 'Weekend complete'), h('div', { class: 'f1-hint', text: 'Every session of this weekend has run.' })));
      hubCta = cta('Back to setup', null, function () { U.run = null; saveRun(); U.screen = 'setup'; U.lastPanel = null; render(); });
    }
    else right.appendChild(h('div', { class: 'f1-panel mx-sec' }, secTitle(0, 'Your car'),
      h('div', { class: 'f1-livery', style: { background: liveryCss(team), height: '70px', 'border-radius': 'var(--radius-sm)' } }),
      h('div', { class: 'f1-hint', style: { 'margin-top': 'var(--sp-2)' }, text: team.full + ' · ' + team.power + ' power unit · teammate ' + team.drivers[1 - S.seat].name })));
    var curS = w ? W.currentSession(w) : null, curMeta = curS ? (M.SESSIONS.filter(function (x) { return x.id === curS.id; })[0] || { name: curS.id }) : null;
    rootAll.appendChild(footer([team ? team.name : null, inf ? inf.name : null].filter(Boolean).join(' · '),
      [run.kind === 'season' ? 'Round ' + Math.min(run.round + 1, run.rounds.length) + ' of ' + run.rounds.length : 'Race weekend', curMeta ? 'Next: ' + curMeta.name : 'Complete'].join(' · '),
      hubCta, team ? team.livery.primary : null));
  }
  function sessionSummary(s) {
    var me = (s.results || []).filter(function (r) { return r.isPlayer; })[0];
    if (!me) return 'Done';
    if (s.id === 'race') return 'Finished P' + me.position + (me.status === 'dnf' ? ' (DNF)' : '');
    return 'P' + me.position + ' · ' + fmtLap(me.bestLap_s);
  }
  function resultsTable(s) {
    var isRace = s.id === 'race', W = wk(), S = runSettings();
    var scored = isRace ? W.score(s.results, { fastestLapPoint: S.fastestLapPoint && S.format !== 'quick', playerTeam: S.team, playerName: playerName() }) : null;
    var best = null;
    (s.results || []).forEach(function (r) { if (isNum(r.bestLap_s) && r.bestLap_s > 0 && (best === null || r.bestLap_s < best)) best = r.bestLap_s; });
    var rows = isRace ? s.results : W.gridFrom(s.results).map(function (id) { return s.results.filter(function (r) { return (r.isPlayer ? 'player' : r.id) === id; })[0]; }).filter(Boolean);
    var tb = h('tbody');
    rows.forEach(function (r, i) {
      var sc = scored ? scored[i] : null;
      var comp = r.endurance && r.endurance.f1 ? (r.endurance.f1.compoundsUsed || []).map(tyreChip).join('') : '';
      tb.appendChild(h('tr', { class: r.isPlayer ? 'me' : '', html:
        '<td>' + (isRace ? r.position : i + 1) + '</td>' +
        '<td><span class="bar" style="background:' + esc(r.color || '#888') + '"></span>' + esc(r.isPlayer ? playerName() : r.name) + '</td>' +
        '<td>' + esc(r.team || '') + '</td>' +
        (isRace ? '<td class="mono">' + esc(r.status === 'dnf' ? 'DNF' : r.gapText || '') + '</td><td class="mono' + (r.fastestLap ? ' f1-fl' : '') + '">' + fmtLap(r.bestLap_s) + '</td><td>' + comp + (r.pitStops ? ' ' + r.pitStops + '×' : '') + '</td><td class="pts">' + (sc && sc.points ? sc.points : '') + '</td>'
          : '<td class="mono">' + fmtLap(r.bestLap_s) + '</td><td class="mono">' + (i && isNum(r.bestLap_s) && best ? '+' + (r.bestLap_s - best).toFixed(3) : '') + '</td>')
      }));
    });
    var head = isRace ? '<tr><th>Pos</th><th>Driver</th><th>Team</th><th>Gap</th><th>Best</th><th>Tyres / stops</th><th style="text-align:right">Pts</th></tr>'
      : '<tr><th>Pos</th><th>Driver</th><th>Team</th><th>Best lap</th><th>Gap</th></tr>';
    return h('div', { class: 'f1-scroll' }, h('table', { class: 'f1-table' }, h('thead', { html: head }), tb));
  }
  function standingsPanel(run) {
    var st = wk().standings(run), P = h('div', { class: 'f1-panel mx-sec' });
    var tab = U.standTab || 'drivers';
    P.appendChild(h('div', { class: 'f1-tabs' }, seg([{ id: 'drivers', name: 'Drivers' }, { id: 'constructors', name: 'Constructors' }, { id: 'calendar', name: 'Calendar' }], tab,
      function (v) { U.standTab = v; render(); })));
    var T = teams(), tb = h('tbody');
    if (tab === 'calendar') {
      run.rounds.forEach(function (id, i) {
        var d = mode().circuit(id), hist = run.history[i];
        var me = hist ? hist.results.filter(function (r) { return r.isPlayer; })[0] : null;
        var win = hist ? hist.results.filter(function (r) { return r.position === 1; })[0] : null;
        tb.appendChild(h('tr', { class: i === run.round ? 'me' : '', html: '<td>R' + (i + 1) + '</td><td>' + esc(d ? mode().info(d).name : id) + '</td><td>' + (win ? esc(win.isPlayer ? playerName() : win.name) : '') + '</td><td>' + (me ? 'P' + me.position : '') + '</td>' }));
      });
      P.appendChild(h('table', { class: 'f1-table' }, h('thead', { html: '<tr><th>Rd</th><th>Circuit</th><th>Winner</th><th>You</th></tr>' }), tb));
      return P;
    }
    var rows = tab === 'drivers' ? st.drivers : st.constructors;
    if (!rows.length) { P.appendChild(h('div', { class: 'f1-hint', text: 'Standings appear after round 1.' })); return P; }
    rows.forEach(function (r) {
      var t = T.get(tab === 'drivers' ? r.teamId : r.id), col = t ? t.livery.primary : '#888';
      var me = tab === 'drivers' ? r.isPlayer : (r.id === runSettings().team);
      tb.appendChild(h('tr', { class: me ? 'me' : '', html: '<td>' + r.position + '</td><td><span class="bar" style="background:' + col + '"></span>' + esc(tab === 'drivers' ? (r.isPlayer ? playerName() : r.name) : r.name) + '</td><td>' + r.wins + '</td><td class="pts">' + r.points + '</td>' }));
    });
    P.appendChild(h('table', { class: 'f1-table' }, h('thead', { html: '<tr><th>Pos</th><th>' + (tab === 'drivers' ? 'Driver' : 'Team') + '</th><th>Wins</th><th style="text-align:right">Pts</th></tr>' }), tb));
    return P;
  }
  function championLine(run) {
    var st = wk().standings(run), d = st.drivers[0], c = st.constructors[0], me = st.drivers.filter(function (x) { return x.isPlayer; })[0];
    return (d ? 'Drivers\' champion: ' + (d.isPlayer ? playerName() : d.name) + ' (' + d.points + ' pts)' : '') + (c ? ' · Constructors: ' + c.name : '') + (me ? ' · You: P' + me.position + ', ' + me.points + ' pts' : '');
  }
  function skip() {
    var W = wk(), w = weekendOf(U.run), cur = W.currentSession(w);
    if (!cur) return;
    if (cur.id === 'qualifying') {
      var S = runSettings(), M = mode();
      var ent = M.entrants({ playerTeam: S.team, playerSeat: S.seat, difficulty: S.difficulty, seed: 99 });
      W.recordSession(w, 'qualifying', null, { skipped: true });
      w.grid = simGrid(ent, (Date.now() & 0xffff) ^ 0x1234, S.difficulty === 'rookie' ? 6 : S.difficulty === 'amateur' ? 10 : 12);
    } else W.skipSession(w);
    saveRun(); render();
  }

  /* ---------------------------------------------------------------- sessions */
  function startSession(sessionId, opts) {
    opts = opts || {};
    var RU = CB.race && CB.race.ui, M = mode(), W = wk();
    if (!RU || typeof RU.open !== 'function') { if (hasDOM) window.alert('The race engine (js/race/race-ui.js) is not loaded.'); return null; }
    var w = weekendOf(U.run);
    if (!w) return null;
    var cur = W.currentSession(w);
    if (!cur) return null;
    sessionId = sessionId || cur.id;
    var S = runSettings();
    var sc = M.sessionConfig({ settings: S, circuitId: w.circuitId, session: sessionId, gridOrder: sessionId === 'race' ? w.grid : null,
      playerName: playerName(), seed: opts.seed, maxTime_s: opts.maxTime_s, laps: opts.laps });
    var launch = sc.launch, info = M.info(sc.circuit);
    var hud = null, hooksNow = launch.f1.hooks, sessRef = null, starts = 0;
    var oneShot = !(U.run.kind === 'weekend' && U.run.format === 'quick');
    var plugin = {
      id: 'f1',
      findTrack: function (id) { return M.circuit(id); },
      records: records(),
      hudOptions: CB.f1.hud ? { tower: false, timing: false, cluster: false, minimap: false } : null,
      configure: function (cfg) {
        // a fresh F1 hook set for every start (Race again / Restart): tyres, ERS and DRS state never carry over
        starts++;
        if (starts > 1 && CB.f1.hooks) {
          var again = M.sessionConfig({ settings: S, circuitId: w.circuitId, session: sessionId, gridOrder: sessionId === 'race' ? w.grid : null, playerName: playerName(), seed: cfg.seed, laps: launch.settings.laps });
          hooksNow = again.launch.f1.hooks;
          cfg.hooks = (cfg.hooks || []).filter(function (x) { return x !== launch.f1.hooks && !(x && x.__f1); }).concat(hooksNow ? [hooksNow] : []);
        }
        if (hooksNow) hooksNow.__f1 = true;
        cfg.maxOpponents = 21;
        return cfg;
      },
      attach: function (session, R) {
        sessRef = engineOf(session);
        var meta = launch.f1.meta;
        if (hooksNow && typeof hooksNow.attach === 'function') { try { hooksNow.attach(sessRef); if (typeof hooksNow.meta === 'function') meta = hooksNow.meta() || meta; } catch (eA) { /* ignore */ } }
        if (CB.f1.hud) {
          hud = CB.f1.hud.create({ hooks: hooksNow, session: sessionId, circuit: sc.circuit, meta: meta, playerTeam: S.team, units: R && R.settings ? R.settings.units : 'kph',
            maxTime_s: launch.maxTime_s, weather: S.weather, pitCompound: S.weather === 'wet' ? 'wet' : S.weather === 'damp' ? 'inter' : (sc.launch.f1.startCompound === 'soft' ? 'medium' : 'hard') });
          hud.attach(sessRef, hasDOM ? document.getElementById('race-root') : null);
        }
      },
      drawHud: function (ctx, snap, view) { if (hud) hud.draw(ctx, snap, view); },
      detach: function () { if (hud) { hud.detach(); hud = null; } },
      resultsPanel: function (res, raw) { return resultsPanel(sessionId, raw || res, S); }
    };
    U.racing = true;
    U.closing = false;
    var finished = null;
    var o = Object.assign({}, launch, {
      plugin: plugin, oneShot: oneShot, autoStart: true,
      continueLabel: sessionId === 'race' ? (U.run.kind === 'season' ? 'Continue · standings' : 'Continue') : 'Continue weekend',
      backLabel: 'Back to Formula 1',
      onFinish: function (results) { finished = results; recordResult(sessionId, results, S); },
      onClose: function () {
        U.racing = false;
        if (U.closing) return;
        afterSession(sessionId, finished);
      }
    });
    delete o.f1;
    o.f1Session = { session: sessionId, circuitId: w.circuitId, team: S.team, info: info };
    try { RU.open(sc.build, o); } catch (e) { U.racing = false; if (typeof console !== 'undefined') console.error('[f1.ui] race-ui open failed', e); return null; }
    return o;
  }
  /** The engine session behind race-ui's wrappers (assisted sessions wrap it): requestPit / cancelPit live there. */
  function engineOf(s) {
    if (s && typeof s.requestPit === 'function') return s;
    try { var d = s && typeof s._debug === 'function' ? s._debug() : null; if (d && d.inner) return engineOf(d.inner); } catch (e) { /* ignore */ }
    try { var p = s && Object.getPrototypeOf(s); if (p && typeof p.requestPit === 'function') return p; } catch (e2) { /* ignore */ }
    return s;
  }
  function recordResult(sessionId, results, S) {
    var W = wk(), w = weekendOf(U.run);
    if (!w || !results) return;
    U.lastResults = results;
    W.recordSession(w, sessionId, results);
    if (sessionId === 'race') {
      var scored = W.score(results, { fastestLapPoint: S.fastestLapPoint && U.run.format !== 'quick', playerTeam: S.team, playerName: playerName() });
      U.lastScored = scored;
      if (U.run.kind === 'season') W.applyRound(U.run, scored);
      bumpStats(results, scored, S);
    } else if (sessionId === 'qualifying') bumpPole(results);
    saveRun();
  }
  function bumpStats(results, scored, S) {
    var st = store(); if (!st) return;
    var s = st.stats(), me = scored.filter(function (r) { return r.isPlayer; })[0];
    if (!me) return;
    s.races++; s.points += me.points;
    if (me.position === 1 && me.status !== 'dnf') { s.wins++; if (s.circuitsWon.indexOf(results.trackId) < 0) s.circuitsWon.push(results.trackId); }
    if (me.position <= 3 && me.status !== 'dnf') s.podiums++;
    if (me.fastestLap) s.fastestLaps++;
    if (s.teamsRaced.indexOf(S.team) < 0) s.teamsRaced.push(S.team);
    var titled = false;
    if (U.run.kind === 'season' && wk().isSeasonOver(U.run)) {
      var d = wk().standings(U.run).drivers[0];
      if (d && d.isPlayer) { s.titles++; titled = true; }
    }
    st.saveStats(s);
    // profile stats + achievements (the F1 session owns its result: race-ui's free-play recorder skips it)
    try {
      if (CB.game && CB.game.profile && typeof CB.game.profile.recordRaceStats === 'function') {
        CB.game.profile.recordRaceStats(results, { mode: 'race', trackId: results.trackId, laps: results.lapsTotal, difficulty: S.difficulty, opponents: 21,
          fieldSize: (results.classification || []).length, freeBuild: true, eventType: 'f1' });
      }
    } catch (e) { /* ignore */ }
    try {
      var A = CB.game && CB.game.achievements;
      if (A && typeof A.check === 'function') A.check(null, { type: 'f1', results: results, position: me.position, status: me.status, gained: me.gained, fastestLap: me.fastestLap,
        pitStops: me.pitStops, teamId: S.team, circuitId: results.trackId, title: titled, difficulty: S.difficulty, weather: S.weather, stats: s });
    } catch (e2) { /* ignore */ }
  }
  function bumpPole(results) {
    var g = wk().gridFrom(results);
    if (g[0] === 'player') { var st = store(); if (st) { var s = st.stats(); s.poles++; st.saveStats(s); } }
    try { var A = CB.game && CB.game.achievements; if (A && A.check) A.check(null, { type: 'f1', session: 'qualifying', pole: g[0] === 'player', gridPosition: g.indexOf('player') + 1 }); } catch (e) { /* ignore */ }
  }
  function resultsPanel(sessionId, raw, S) {
    if (!hasDOM) return null;
    var rows = raw && Array.isArray(raw.classification) ? raw.classification : raw && raw.rows || [];
    var me = rows.filter(function (r) { return r.isPlayer; })[0];
    if (!me) return null;
    var box = h('div', { class: 'f1-res', style: { margin: '0 0 12px' } });
    injectStyles();
    if (sessionId === 'race') {
      var sc = wk().score(raw, { fastestLapPoint: S.fastestLapPoint && U.run && U.run.format !== 'quick', playerTeam: S.team });
      var m2 = sc.filter(function (r) { return r.isPlayer; })[0] || {};
      var fl = raw.fastestLap && rows.filter(function (r) { return r.id === raw.fastestLap.carId; })[0];
      box.appendChild(h('b', { text: (me.status === 'dnf' ? 'DNF' : 'P' + me.position) + ' · ' + (m2.points || 0) + ' points' }));
      box.appendChild(h('div', { class: 'f1-hint', html: (isNum(m2.gained) ? (m2.gained > 0 ? '+' + m2.gained + ' places from P' + m2.gridPosition : m2.gained < 0 ? m2.gained + ' places from P' + m2.gridPosition : 'Held P' + m2.gridPosition) + ' · ' : '') +
        (me.pitStops || 0) + (me.pitStops === 1 ? ' stop' : ' stops') + (me.endurance && me.endurance.f1 ? ' · ' + (me.endurance.f1.compoundsUsed || []).map(tyreChip).join('') : '') +
        (fl ? '<br>Fastest lap: <span class="f1-fl">' + esc(fl.isPlayer ? 'You' : fl.name) + ' ' + fmtLap(raw.fastestLap.time) + '</span>' : '') }));
    } else {
      var g = wk().gridFrom(raw), p = g.indexOf('player') + 1;
      box.appendChild(h('b', { text: (sessionId === 'qualifying' ? 'Qualified P' : 'Practice P') + p }));
      box.appendChild(h('div', { class: 'f1-hint', text: 'Best lap ' + fmtLap(me.bestLap_s) }));
    }
    return box;
  }
  function afterSession(sessionId, results) {
    var W = wk();
    if (!U.run) { render(); return; }
    var w = weekendOf(U.run);
    U.lastPanel = null;
    if (U.run.kind === 'weekend' && U.run.format === 'quick') { U.run = null; saveRun(); U.screen = 'setup'; render(); return; }
    if (results && sessionId === 'race' && U.lastScored) {
      var me = U.lastScored.filter(function (r) { return r.isPlayer; })[0];
      if (me && hasDOM) U.lastPanel = h('div', { class: 'f1-res' }, h('b', { text: (me.status === 'dnf' ? 'DNF' : 'P' + me.position) + ' · +' + me.points + ' points' }),
        h('div', { class: 'f1-hint', text: U.run.kind === 'season' ? championshipLine() : 'Weekend complete.' }));
    }
    if (U.run.kind === 'weekend' && w && W.isComplete(w)) { /* stay on the hub with the final classification */ }
    U.screen = 'hub';
    render();
  }
  function championshipLine() {
    var st = wk().standings(U.run), me = st.drivers.filter(function (x) { return x.isPlayer; })[0];
    return me ? 'Championship: P' + me.position + ' with ' + me.points + ' pts' + (me.position > 1 ? ' (−' + me.gap + ' to the leader)' : ' (leading)') : '';
  }

  /* ---------------------------------------------------------------- router */
  var api = {
    open: open, close: close, startSession: startSession,
    state: function () { return U ? { screen: U.screen, settings: clone(U.settings), run: clone(U.run), racing: !!U.racing } : null; },
    _: { simGrid: simGrid, calendar: calendar, engineOf: engineOf, CSS: CSS }
  };
  CB.f1.ui = api;

  var registered = false;
  function register() {
    if (registered || !CB.router || typeof CB.router.on !== 'function') return;
    registered = true;
    CB.router.on('f1', function (el, params) {
      var layer = el && el.nodeType === 1 ? el : (el && (el.layer || el.el)) || (hasDOM ? document.getElementById('screen-f1') : null);
      open(layer, params || {});
    }, function () { close(); });
  }
  if (hasDOM) {
    register();
    document.addEventListener('keydown', onKey);
    document.addEventListener('DOMContentLoaded', register);
    document.addEventListener('cb:router-ready', register);
    window.f1 = {
      state: api.state,
      start: function (id, o) { return startSession(id, o); },
      go: function (s) { if (U) { U.screen = s; render(); } },
      newRun: function (format, extra) { if (!U) return null; Object.assign(U.settings, extra || {}, { format: format || 'quick' }); U.run = null; beginRunNoConfirm(); return api.state(); }
    };
  }
  function beginRunNoConfirm() { var keep = U.run; U.run = null; void keep; var conf = hasDOM ? window.confirm : null; if (hasDOM) window.confirm = function () { return true; }; try { beginRun(); } finally { if (hasDOM) window.confirm = conf; } }
})();

if (typeof module !== 'undefined') module.exports = CB.f1.ui;

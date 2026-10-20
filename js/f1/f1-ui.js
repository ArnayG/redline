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
  /* Design system (css/styles.css § 01): every colour is a token (light + dark themes), spacing on --sp-*, controls on
     --control-h-*. The F1 identity colour (--mode-f1) only marks identity: eyebrows, step numbers, selected cards. The
     primary CTA is the shared gold .cb-btn.primary; segmented controls are .cb-tab-list / .cb-tab. */
  var CSS = [
    '#screen-f1{background:var(--bg);color:var(--text)}',
    '.f1-root{min-height:100%;display:flex;flex-direction:column;font-family:var(--font,system-ui,sans-serif);box-sizing:border-box;color:var(--text)}',
    '.f1-root *{box-sizing:border-box}',
    /* header: kicker + serif title, ghost "Main menu" on the right (the race setup pattern) */
    '.f1-top{display:flex;align-items:center;gap:var(--sp-4);padding:var(--sp-4) clamp(14px,3vw,28px);border-bottom:1px solid var(--line);background:var(--glass,var(--panel));backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);flex-wrap:nowrap}',
    '.f1-mark{flex:none;display:block;width:30px;height:18px;background:linear-gradient(115deg,var(--mode-f1) 0 58%,transparent 58% 66%,var(--mode-f1) 66% 100%);transform:skewX(-12deg);border-radius:2px}',
    '.f1-titles{flex:1 1 auto;display:flex;flex-direction:column;gap:3px;min-width:0}',
    '.f1-kicker{font-size:var(--fs-2xs);letter-spacing:.2em;text-transform:uppercase;font-weight:650;color:var(--accent)}',
    '.f1-title{margin:0;font-family:var(--serif);font-weight:500;font-size:var(--fs-2xl);line-height:1.1;color:var(--text-strong);letter-spacing:-.01em}',
    '@media (min-width:980px){.f1-title{font-size:var(--fs-3xl)}}',
    '.f1-sub{color:var(--text-dim);font-size:var(--fs-sm)}',
    '.f1-spacer{flex:1}',
    '.f1-top-actions{flex:none;display:flex;align-items:center;gap:var(--sp-2);margin-left:auto}',
    '.f1-back svg{width:18px;height:18px}',
    '@media (max-width:560px){.f1-back span{display:none}.f1-back{width:var(--control-h-md);padding:0}.f1-title{font-size:var(--fs-xl)}.f1-top{gap:var(--sp-3)}.f1-mark{width:22px;height:14px}.f1-sub{font-size:var(--fs-xs)}}',
    '.f1-main{flex:1;width:100%;max-width:1500px;margin:0 auto;padding:var(--sp-5) clamp(14px,3vw,28px) var(--sp-8)}',
    '.f1-grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:var(--sp-5);align-items:start}',
    '@media (max-width:980px){.f1-grid{grid-template-columns:1fr}}',
    '.f1-sec{margin-bottom:var(--sp-6)}',
    /* section eyebrow with the step number in the mode colour */
    '.f1-h{display:flex;align-items:baseline;flex-wrap:wrap;gap:var(--sp-2);margin:0 0 var(--sp-3);font-size:var(--fs-xs);font-weight:650;letter-spacing:.18em;text-transform:uppercase;color:var(--text-strong)}',
    '.f1-h b{color:var(--mode-f1);font-variant-numeric:tabular-nums;letter-spacing:.08em}',
    '.f1-h span{font-size:var(--fs-sm);font-weight:400;letter-spacing:0;text-transform:none;color:var(--text-dim)}',
    '.f1-h.big{font-family:var(--serif);font-size:var(--fs-xl);font-weight:500;letter-spacing:0;text-transform:none}',
    /* team / circuit cards */
    '.f1-teams{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:var(--sp-3)}',
    '.f1-team,.f1-circ{position:relative;text-align:left;border:1px solid var(--line);background:var(--panel);border-radius:var(--radius,12px);overflow:hidden;cursor:pointer;color:inherit;padding:0;font:inherit;transition:border-color var(--dur-2) var(--ease),background var(--dur-2) var(--ease),box-shadow var(--dur-2) var(--ease)}',
    '.f1-team:hover,.f1-circ:hover{border-color:color-mix(in srgb,var(--mode-f1) 45%,var(--line))}',
    '.f1-team.is-on,.f1-circ.is-on{border-color:var(--mode-f1);box-shadow:0 0 0 1px var(--mode-f1) inset;background:linear-gradient(var(--mode-f1-soft),var(--mode-f1-soft)),var(--panel)}',
    '.f1-team:focus-visible,.f1-circ:focus-visible{outline:none;box-shadow:var(--focus)}',
    '.f1-livery{height:54px;position:relative}',
    '.f1-livery .num{position:absolute;right:8px;bottom:4px;font:800 26px/1 "Barlow Condensed","Arial Narrow",sans-serif;opacity:.95}',
    '.f1-team .meta{padding:var(--sp-2) var(--sp-3) var(--sp-3)}',
    '.f1-badge{display:inline-block;font:800 13px/1 "Barlow Condensed","Arial Narrow",sans-serif;letter-spacing:.08em;text-transform:uppercase;padding:4px 7px;border-radius:4px;color:#fff}',
    '.f1-team .drv{font-size:var(--fs-xs);color:var(--text-dim);margin-top:6px;line-height:1.45}',
    '.f1-team .drv b{color:var(--text-strong);font-weight:600}',
    '.f1-seat{margin-top:var(--sp-2)}',
    '.f1-circuits{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:var(--sp-3)}',
    '.f1-circ{padding:var(--sp-3);display:flex;gap:var(--sp-3);align-items:center}',
    '.f1-circ canvas{flex:0 0 auto;width:84px;height:64px}',
    '.f1-circ .nm{font-weight:650;font-size:var(--fs-md);line-height:1.2;color:var(--text-strong)}',
    '.f1-circ .ct{font-size:var(--fs-xs);color:var(--text-dim);margin-top:2px}',
    '.f1-circ .st{font:600 11px/1.3 var(--mono,ui-monospace,Menlo,monospace);color:var(--text);margin-top:5px}',
    '.f1-circ .rnd{position:absolute;top:6px;right:8px;font-size:var(--fs-2xs);font-weight:700;letter-spacing:.12em;color:var(--mode-f1)}',
    '.f1-night{display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.1em;padding:2px 5px;border-radius:3px;background:var(--panel-3);color:var(--text-dim);border:1px solid var(--line);margin-left:6px;vertical-align:middle}',
    /* settings panel */
    '.f1-panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-lg,14px);padding:var(--sp-4);position:sticky;top:var(--sp-4);box-shadow:var(--elev-1,none)}',
    '.f1-field{margin-bottom:var(--sp-4)}',
    '.f1-field>label{display:block;font-size:var(--fs-2xs);font-weight:650;letter-spacing:.18em;text-transform:uppercase;color:var(--text-dim);margin-bottom:var(--sp-2)}',
    /* segmented controls: the shared tab list; the active tab is accent-soft with a light ring and the gold underline */
    '.f1-root .cb-tab-list.f1-seg{flex-wrap:wrap;overflow:visible}',
    '.f1-root .f1-seg .cb-tab{flex:1 1 auto;min-height:var(--control-h-sm);cursor:pointer}',
    '.f1-root .f1-seg .cb-tab.is-active,[data-theme="light"] .f1-root .f1-seg .cb-tab.is-active{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 34%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 18%,transparent);color:var(--text-strong)}',
    '.f1-row{display:flex;align-items:center;gap:var(--sp-2)}',
    '.f1-step{display:flex;align-items:center;gap:var(--sp-2)}',
    '.f1-step output{min-width:64px;text-align:center;font:700 15px/1 var(--mono,ui-monospace,Menlo,monospace);color:var(--text-strong)}',
    '.f1-step .cb-btn{width:var(--control-h-md);min-height:var(--control-h-md);padding:0;font-size:var(--fs-lg)}',
    '.f1-toggle{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-3);min-height:var(--control-h-sm);font-size:var(--fs-sm);cursor:pointer;color:var(--text)}',
    '.f1-toggle input{width:18px;height:18px;accent-color:var(--accent)}',
    '.f1-hint{font-size:var(--fs-xs);color:var(--text-dim);line-height:1.45}',
    '.f1-hint b{color:var(--text)}',
    '.f1-continue{display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-3) var(--sp-4);border-radius:var(--radius,12px);background:linear-gradient(90deg,var(--mode-f1-soft),transparent 75%),var(--panel);border:1px solid color-mix(in srgb,var(--mode-f1) 40%,var(--line));margin-bottom:var(--sp-5);flex-wrap:wrap}',
    '.f1-continue b{color:var(--text-strong)}',
    /* weekend hub */
    '.f1-sessions{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:var(--sp-3);margin-bottom:var(--sp-5)}',
    '.f1-sess{border:1px solid var(--line);background:var(--panel);border-radius:var(--radius,12px);padding:var(--sp-3) var(--sp-4)}',
    '.f1-sess.is-cur{border-color:var(--mode-f1);background:linear-gradient(var(--mode-f1-soft),var(--mode-f1-soft)),var(--panel)}',
    '.f1-sess.is-done{opacity:.78}',
    '.f1-sess .k{font-size:var(--fs-2xs);font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--mode-f1)}',
    '.f1-sess .n{font-family:var(--serif);font-size:var(--fs-xl);font-weight:500;color:var(--text-strong);margin:var(--sp-1) 0}',
    '.f1-table{width:100%;border-collapse:collapse;font-size:var(--fs-sm);color:var(--text)}',
    '.f1-table th{text-align:left;font-size:var(--fs-2xs);font-weight:650;letter-spacing:.14em;text-transform:uppercase;color:var(--text-dim);padding:var(--sp-2);border-bottom:1px solid var(--line)}',
    '.f1-table td{padding:6px var(--sp-2);border-bottom:1px solid var(--line-soft,var(--line));white-space:nowrap}',
    '.f1-table tr.me td{background:var(--accent-soft);color:var(--text-strong);font-weight:650}',
    '.f1-table .bar{display:inline-block;width:4px;height:14px;vertical-align:middle;margin-right:6px;border-radius:1px}',
    '.f1-table .mono{font-family:var(--mono,ui-monospace,Menlo,monospace)}',
    '.f1-table .pts{font-weight:750;text-align:right;color:var(--text-strong)}',
    '.f1-tyre{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;border:2px solid;font:800 9px/1 sans-serif;margin-right:2px;background:var(--panel-3)}',
    '.f1-fl{color:#b64dff;font-weight:800}',
    '.f1-tabs{margin-bottom:var(--sp-3)}',
    '.f1-scroll{overflow:auto;max-width:100%}',
    '.f1-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:var(--sp-2);margin-top:var(--sp-3)}',
    '.f1-stat{background:var(--panel-2);border:1px solid var(--line);border-radius:var(--radius-sm,8px);padding:var(--sp-2)}',
    '.f1-stat b{display:block;font-size:var(--fs-xl);font-weight:700;color:var(--text-strong);font-variant-numeric:tabular-nums}',
    '.f1-stat span{font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--text-dim)}',
    '.f1-res{display:flex;flex-direction:column;gap:6px;padding:var(--sp-3) var(--sp-4);border-radius:var(--radius,12px);background:linear-gradient(var(--mode-f1-soft),var(--mode-f1-soft)),var(--panel);border:1px solid color-mix(in srgb,var(--mode-f1) 40%,var(--line));margin-bottom:var(--sp-3);color:var(--text)}',
    '.f1-res b{font-family:var(--serif);font-size:var(--fs-xl);font-weight:500;color:var(--text-strong)}',
    '.f1-foot{display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap;margin-top:var(--sp-3)}',
    /* sticky footer: session summary + the primary CTA (like the race setup .rx-footer) */
    '.f1-footer{position:sticky;bottom:0;z-index:3;display:flex;align-items:center;gap:var(--sp-4);padding:var(--sp-3) clamp(14px,3vw,28px) max(var(--sp-3),env(safe-area-inset-bottom));border-top:1px solid var(--line);background:var(--glass-strong,var(--panel));backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}',
    '.f1-summary{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:var(--sp-1) var(--sp-4);font-size:var(--fs-sm);color:var(--text-dim)}',
    '.f1-summary b{color:var(--text-strong);font-weight:650}',
    '.f1-summary .sw{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:6px}',
    '.f1-cta{min-width:220px}',
    '.f1-root .cb-btn.large{min-height:var(--control-h-lg)}',
    '@media (max-width:560px){.f1-footer{flex-wrap:wrap;gap:var(--sp-2)}.f1-footer .f1-cta{width:100%;min-width:0}.f1-summary{flex-wrap:nowrap;overflow:hidden;white-space:nowrap;-webkit-mask-image:linear-gradient(90deg,#000 85%,transparent);mask-image:linear-gradient(90deg,#000 85%,transparent);font-size:var(--fs-xs)}}',
    /* short landscape phones: a slim header (no subtitle) and footer so the cards keep the screen */
    '@media (max-height:500px){.f1-top{padding-top:var(--sp-2);padding-bottom:var(--sp-2)}.f1-sub{display:none}.f1-title{font-size:var(--fs-xl)}.f1-kicker{font-size:9.5px}.f1-main{padding-top:var(--sp-3)}.f1-footer{padding-top:var(--sp-2);padding-bottom:max(var(--sp-2),env(safe-area-inset-bottom))}.f1-footer .f1-cta{min-height:var(--control-h-md)}.f1-summary{flex-wrap:nowrap;overflow:hidden;white-space:nowrap}.f1-panel{position:static}}',
    /* touch: 40–44 px controls */
    '@media (pointer:coarse){.f1-root .cb-btn{min-height:var(--touch-min,44px)}.f1-root .f1-seg .cb-tab{min-height:40px}.f1-toggle{min-height:40px}.f1-toggle input{width:22px;height:22px}.f1-step .cb-btn{width:44px;min-height:44px}.f1-back{min-width:44px}}'
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
    var root = h('div', { class: 'f1-root' });
    el.appendChild(root);
    if (U.screen === 'hub' && U.run) renderHub(root); else renderSetup(root);
    try { el.scrollTop = U.scroll || 0; } catch (e) { /* ignore */ }
  }
  var BACK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
  /** Header (race setup pattern): F1 mark, small uppercase kicker + serif title, ghost "Main menu" on the right. */
  function header(kicker, title, sub, extra) {
    return h('header', { class: 'f1-top' },
      h('span', { class: 'f1-mark', 'aria-hidden': 'true' }),
      h('div', { class: 'f1-titles' },
        h('div', { class: 'f1-kicker', text: kicker }),
        h('h1', { class: 'f1-title', text: title }),
        sub ? h('div', { class: 'f1-sub', text: sub }) : null),
      h('div', { class: 'f1-top-actions' },
        extra || null,
        h('button', { class: 'cb-btn ghost f1-back', type: 'button', title: 'Main menu', 'aria-label': 'Main menu', html: BACK_SVG + '<span>Main menu</span>',
          onclick: function () { if (CB.router && CB.router.go) CB.router.go('menu'); } })));
  }
  /** Sticky footer: session summary + the primary CTA (shared gold .cb-btn.primary). */
  function footer(summary, cta) {
    return h('footer', { class: 'f1-footer' }, h('div', { class: 'f1-summary' }, summary), cta || null);
  }
  function sumItem(label, value, swatch) {
    return h('span', null, swatch ? h('i', { class: 'sw', style: { background: swatch } }) : null, label ? label + ' ' : '', h('b', { text: value }));
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
      var card = h('button', { class: 'f1-team' + (on ? ' is-on' : ''), type: 'button', 'data-team': t.id, 'aria-pressed': on ? 'true' : 'false',
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
    left.appendChild(h('div', { class: 'f1-sec' }, h('div', { class: 'f1-h', html: '<b>01</b> Pick your team <span>every car is the same spec — the liveries are the teams\' real colours</span>' }), tGrid));

    // circuits
    var list = M.circuits(), season = S.format === 'season';
    var chosen = season ? (S.seasonCircuits && S.seasonCircuits.length >= 2 ? S.seasonCircuits : calendar(list, null, S.rounds)) : null;
    var cGrid = h('div', { class: 'f1-circuits' });
    list.forEach(function (d) {
      var inf = M.info(d), on = season ? chosen.indexOf(d.id) >= 0 : S.circuitId === d.id;
      var cv = h('canvas', { 'aria-hidden': 'true' });
      var rnd = season && on ? calendar(list, chosen).indexOf(d.id) + 1 : 0;
      var card = h('button', { class: 'f1-circ' + (on ? ' is-on' : ''), type: 'button', 'data-circuit': d.id, 'aria-pressed': on ? 'true' : 'false',
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
    left.appendChild(h('div', { class: 'f1-sec' }, h('div', { class: 'f1-h', html: '<b>02</b> ' + (season ? 'Championship calendar <span>tap circuits to add or remove rounds (' + chosen.length + ' rounds)</span>' : 'Pick the circuit <span>faithful recreations of the real layouts</span>') }), cGrid));

    // settings panel
    var P = h('div', { class: 'f1-panel' });
    P.appendChild(h('div', { class: 'f1-h', html: '<b>03</b> Session' }));
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
    var start = h('button', { class: 'cb-btn primary large rx-btn big f1-cta', type: 'button', 'data-act': 'start', onclick: beginRun },
      S.format === 'quick' ? 'Start race' : S.format === 'weekend' ? 'Start weekend' : 'Start championship');
    P.appendChild(h('div', { class: 'f1-hint', style: { 'margin-top': 'var(--sp-2)' }, html: 'Keys: <b>F</b> DRS · <b>N</b> ERS boost (hold) · <b>V</b> ERS mode · <b>I</b> box this lap · <b>O</b> pit tyre. Pad: RB DRS, LB boost, Back box.' }));
    var st = store() ? store().stats() : null;
    if (st && st.races) P.appendChild(h('div', { class: 'f1-stats' },
      [['Races', st.races], ['Wins', st.wins], ['Podiums', st.podiums], ['Poles', st.poles], ['Points', st.points], ['Titles', st.titles]].map(function (x) { return h('div', { class: 'f1-stat' }, h('b', { text: String(x[1]) }), h('span', { text: x[0] })); })));
    right.appendChild(P);
    var tm = T.get(S.team) || T.list[0], defS = M.circuit(S.circuitId), fmt = (M.FORMATS.filter(function (f) { return f.id === S.format; })[0] || {}).name || S.format;
    rootAll.appendChild(footer([
      sumItem('', tm.name, tm.livery.primary),
      sumItem('', season ? (chosen.length + ' rounds') : (defS ? M.info(defS).name : '')),
      sumItem('', fmt),
      season ? null : sumItem('', lapsLabel(S, defS)),
      sumItem('AI', (M.DIFFICULTIES.filter(function (d) { return d.id === S.difficulty; })[0] || {}).name || S.difficulty)
    ], start));
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
      h('button', { class: 'cb-btn ghost', type: 'button', onclick: function () { U.screen = 'setup'; render(); } }, 'Setup')));
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
        sRow.appendChild(h('div', { class: 'f1-sess' + (isCur ? ' is-cur' : '') + (s.done ? ' is-done' : '') },
          h('div', { class: 'k', text: 'SESSION ' + (i + 1) }), h('div', { class: 'n', text: meta.name }), h('div', { class: 'f1-hint', text: status }),
          isCur && s.id !== 'race' ? h('div', { class: 'f1-foot' },
            h('button', { class: 'cb-btn ghost', type: 'button', onclick: function () { skip(); } }, s.id === 'qualifying' ? 'Skip (simulate)' : 'Skip')) : null));
        if (isCur) hubCta = h('button', { class: 'cb-btn primary large rx-btn big f1-cta', type: 'button', 'data-act': 'session', onclick: function () { startSession(s.id); } }, 'Start ' + meta.name);
      });
      left.appendChild(sRow);
      var last = null;
      w.sessions.forEach(function (s) { if (s.done && s.results) last = s; });
      if (last) left.appendChild(h('div', { class: 'f1-sec' }, h('div', { class: 'f1-h', html: (M.SESSIONS.filter(function (x) { return x.id === last.id; })[0] || {}).name + ' <span>classification</span>' }), resultsTable(last)));
      if (cur && cur.id === 'race' && w.grid) left.appendChild(h('div', { class: 'f1-hint', text: 'Grid set by qualifying: you start P' + (w.grid.indexOf('player') + 1) + '.' }));
    } else if (W.isSeasonOver(run)) {
      left.appendChild(h('div', { class: 'f1-res' }, h('b', { text: 'Season complete' }), h('div', { text: championLine(run) }),
        null));
      hubCta = h('button', { class: 'cb-btn primary large rx-btn big f1-cta', type: 'button', onclick: function () { U.run = null; saveRun(); U.screen = 'setup'; U.lastPanel = null; render(); } }, 'New season');
    }
    if (run.kind === 'season') right.appendChild(standingsPanel(run));
    else if (w && W.isComplete(w)) {
      right.appendChild(h('div', { class: 'f1-panel' }, h('div', { class: 'f1-h', text: 'Weekend complete' }), h('div', { class: 'f1-hint', text: 'Every session of this weekend has run.' })));
      hubCta = h('button', { class: 'cb-btn primary large rx-btn big f1-cta', type: 'button', onclick: function () { U.run = null; saveRun(); U.screen = 'setup'; U.lastPanel = null; render(); } }, 'Back to setup');
    }
    else right.appendChild(h('div', { class: 'f1-panel' }, h('div', { class: 'f1-h', text: 'Your car' }),
      h('div', { class: 'f1-livery', style: { background: liveryCss(team), height: '70px', 'border-radius': '8px' } }),
      h('div', { class: 'f1-hint', style: { 'margin-top': 'var(--sp-2)' }, text: team.full + ' · ' + team.power + ' power unit · teammate ' + team.drivers[1 - S.seat].name })));
    var curS = w ? W.currentSession(w) : null, curMeta = curS ? (M.SESSIONS.filter(function (x) { return x.id === curS.id; })[0] || { name: curS.id }) : null;
    rootAll.appendChild(footer([
      team ? sumItem('', team.name, team.livery.primary) : null,
      inf ? sumItem('', inf.name) : null,
      run.kind === 'season' ? sumItem('Round', (Math.min(run.round + 1, run.rounds.length)) + '/' + run.rounds.length) : null,
      curMeta ? sumItem('Next', curMeta.name) : sumItem('', 'Complete')
    ], hubCta));
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
    var st = wk().standings(run), P = h('div', { class: 'f1-panel' });
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

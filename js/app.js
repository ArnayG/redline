/* ==========================================================================
   FORGE Atelier — js/app.js
   The application shell: boot, layout wiring, navigation, routing, the live
   summary sidebar (performance / price / issues), top bar, keyboard shortcuts.

   Data flow
   ---------
     CB.state (single store) ──subscribe──▶ scheduleFrame() ──rAF──▶ frame()
        frame(): compute ONE bundle per build  { metrics, pricing, issues, legality }
                 ├─ CB.render.update(build, metrics)
                 ├─ active panel .update(build, metrics, change)  (or re-render, scroll preserved)
                 ├─ perf strip (animated count-up + delta chips)
                 ├─ nav issue badges, undo/redo state, build name, status
                 └─ summary aside (cheap parts every frame; charts debounced ~110 ms)

   Routing:  location.hash carries  '#p=<panelId>'  and may also carry  'b=<share code>'
             ('#p=engine&b=v1.xxx' or '#b=v1.xxx'). CB.state reads b= itself on boot / hashchange;
             app.js reads p= and, once a shared build has been restored, strips b= so later edits are
             not overridden by a stale share code on reload (autosave keeps the edits).

   Public:   CB.app = { boot, goto, next, prev, activePanel, bundle, compute, refresh, setTheme, theme,
                        setView, toggleXray, toggleSpin, finance, openAtelier, closeAtelier,
                        showShortcuts, version }

   Every dependency is feature-detected; a missing module logs a single console.warn and the UI
   degrades gracefully instead of crashing.
   ========================================================================== */
window.CB = window.CB || {};

(function () {
  'use strict';

  var CB = window.CB;
  var U = CB.util;
  if (!U) { console.error('[CB.app] CB.util missing — cannot start.'); return; }
  var el = U.el;

  var LS_THEME = 'forge.theme.v1';
  var LS_VIEW = 'forge.view.v1';
  var LS_FIN = 'forge.finance.v1';
  var LS_UI = 'forge.ui.v1';

  var reduceMotion = false;
  try { reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }

  /* ---------------------------------------------------------------- guards & storage */
  var warned = {};
  function warnOnce(key, msg) {
    if (warned[key]) return;
    warned[key] = true;
    if (typeof console !== 'undefined') console.warn('[CB.app] ' + msg);
  }
  function has(path) {
    var v = U.get(CB, path);
    return typeof v === 'function' || (v && typeof v === 'object');
  }
  function safe(fn, fallback, label) {
    try { return fn(); } catch (err) {
      if (typeof console !== 'undefined') console.error('[CB.app] ' + (label || 'error'), err);
      return fallback;
    }
  }
  function lsGet(key, fallback) {
    try { var s = window.localStorage.getItem(key); return s == null ? fallback : JSON.parse(s); } catch (e) { return fallback; }
  }
  function lsSet(key, val) { try { window.localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ } }
  function $(id) { return document.getElementById(id); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d === undefined ? 0 : d); }
  function fmt(v, d) { return v == null || !isFinite(Number(v)) ? '—' : U.fmtNum(v, d || 0); }
  function money(v, opts) { return v == null || !isFinite(Number(v)) ? '—' : U.fmtMoney(v, opts); }
  function icon(name) { return (CB.ui && CB.ui.icons && CB.ui.icons[name]) || ''; }

  function fmtLap(s) {
    if (s == null || !isFinite(s)) return '—';
    var m = Math.floor(s / 60), r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(3);
  }

  /* ---------------------------------------------------------------- compute bundle */
  var bundleCache = { build: null, bundle: null };
  var lastBundle = null;

  /** Compute metrics, pricing, issues & legality for any build. Memoised for the current build. */
  function compute(build) {
    if (!build) return { metrics: null, pricing: null, issues: [], legality: null };
    if (bundleCache.build === build && bundleCache.bundle) return bundleCache.bundle;
    var metrics = null, pricing = null, issues = [], legality = null;
    if (has('physics.compute')) metrics = safe(function () { return CB.physics.compute(build); }, null, 'physics.compute failed');
    else warnOnce('physics', 'CB.physics missing — performance figures unavailable.');
    if (has('pricing.compute')) pricing = safe(function () { return CB.pricing.compute(build, metrics); }, null, 'pricing.compute failed');
    else warnOnce('pricing', 'CB.pricing missing — price breakdown unavailable.');
    if (has('rules.validate')) issues = safe(function () { return CB.rules.validate(build, metrics) || []; }, [], 'rules.validate failed');
    else warnOnce('rules', 'CB.rules missing — validation unavailable.');
    if (has('rules.legality')) legality = safe(function () { return CB.rules.legality(build, metrics); }, null, 'rules.legality failed');
    if (!Array.isArray(issues)) issues = [];
    var b = { build: build, metrics: metrics, pricing: pricing, issues: issues, legality: legality };
    bundleCache = { build: build, bundle: b };
    return b;
  }

  var referenceMetrics;
  function reference() {
    if (referenceMetrics !== undefined) return referenceMetrics;
    referenceMetrics = null;
    if (has('physics.compute') && has('data.defaultBuild')) {
      referenceMetrics = safe(function () {
        var d = CB.data.defaultBuild();
        if (has('state.normalize')) d = CB.state.normalize(d);
        return CB.physics.compute(d);
      }, null, 'reference metrics');
    }
    return referenceMetrics;
  }

  /* ---------------------------------------------------------------- theme */
  function theme() { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  function setTheme(t, opts) {
    t = t === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#eceae4' : '#0d0f12');
    var btn = $('btn-theme');
    if (btn) {
      btn.setAttribute('aria-pressed', t === 'light' ? 'true' : 'false');
      btn.title = t === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
      btn.innerHTML = t === 'light'
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    }
    if (!opts || opts.persist !== false) lsSet(LS_THEME, t);
    if (booted) {
      // charts read CSS variables at draw time → redraw everything
      markChartsDirty();
      redrawPanelCharts();
      if (has('render.update')) safe(function () { CB.render.update(CB.state.get(), lastBundle && lastBundle.metrics); }, null, 'render.update (theme)');
    }
  }
  // Apply the persisted theme as early as possible (script runs at the end of <body>).
  (function () {
    var saved = lsGet(LS_THEME, null);
    if (!saved) {
      try { saved = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch (e) { saved = 'dark'; }
    }
    document.documentElement.setAttribute('data-theme', saved === 'light' ? 'light' : 'dark');
  })();

  /* ---------------------------------------------------------------- routing */
  /** CB.router (index.html, UNIFY-SPEC) owns the URL: '#/atelier/<panel>'. Legacy pages keep '#p=<panel>&b=<code>'. */
  function routed() { return !!(CB.router && typeof CB.router.go === 'function'); }
  function routedActive() { return routed() && (typeof CB.router.isBooted !== 'function' || CB.router.isBooted()); }
  function onAtelierRoute() {
    if (!routedActive()) return true;
    var c = safe(function () { return CB.router.current(); }, null);
    return !c || c.route === 'atelier';
  }
  function parseHash() {
    var h = String(window.location.hash || '').replace(/^#/, '');
    var out = {};
    if (h.charAt(0) === '/') {
      // router form: '/atelier/<panel>?k=v&b=<code>'
      var qi = h.search(/[?&]/), path = qi < 0 ? h : h.slice(0, qi), segs = path.split('/').filter(Boolean);
      if ((segs[0] === 'garage' || segs[0] === 'atelier') && segs[1]) out.p = segs[1];   // #/garage = the builder (#/atelier: legacy)
      h = qi < 0 ? '' : h.slice(qi + 1);
    }
    h.split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = i < 0 ? kv : kv.slice(0, i), v = i < 0 ? '' : kv.slice(i + 1);
      try { out[decodeURIComponent(k)] = decodeURIComponent(v); } catch (e) { out[k] = v; }
    });
    return out;
  }
  function writeHash(params) {
    if (routed()) {
      // the router writes '#/atelier/<panel>' — and only while the Atelier is the screen on show
      if (!routedActive() || !onAtelierRoute()) return;
      var cur0 = safe(function () { return CB.router.current(); }, null);
      if (params.p && (!cur0 || cur0.sub !== params.p)) safe(function () { CB.router.go('atelier/' + params.p, null, { replace: true }); }, null, 'router.go');
      return;
    }
    var parts = [];
    if (params.p) parts.push('p=' + encodeURIComponent(params.p));
    if (params.b) parts.push('b=' + params.b);
    var next = parts.length ? '#' + parts.join('&') : '';
    var cur = window.location.hash || '';
    if (cur === next || (cur === '#' && next === '')) return;
    try {
      history.replaceState(history.state, '', next || (window.location.pathname + window.location.search));
    } catch (e) {
      // replaceState can be blocked on some file:// setups — fall back to a hash write.
      ignoreHash = true;
      window.location.hash = next;
    }
  }
  var ignoreHash = false;

  /* ---------------------------------------------------------------- panels */
  var active = { id: null, def: null, body: null, frame: null };
  var navItems = {};

  function panels() {
    if (typeof CB.panelList === 'function') return safe(function () { return CB.panelList(); }, [], 'panelList');
    if (CB.panels) return Object.keys(CB.panels).map(function (k) { return CB.panels[k]; }).sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    return [];
  }

  function groupsOf(list) {
    var order = (CB.ui && CB.ui.panelGroups) || ['Engineering', 'Chassis', 'Design'];
    var map = {};
    list.forEach(function (p) { var g = p.group || 'Other'; (map[g] = map[g] || []).push(p); });
    var names = Object.keys(map).sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return names.map(function (n) {
      return { name: n, panels: map[n].sort(function (a, b) { return (a.order || 0) - (b.order || 0); }) };
    });
  }

  var GROUP_NOTES = {
    Engineering: 'Body, power and how it reaches the road',
    Chassis: 'Suspension, brakes, wheels, aero and mass',
    Design: 'Paint, cabin and technology'
  };

  function buildNav() {
    var nav = $('sidenav'), bottom = $('bottomnav');
    if (!nav) return;
    U.clear(nav);
    if (bottom) U.clear(bottom);
    navItems = {};
    var list = panels();
    if (!list.length) {
      nav.appendChild(el('div', { class: 'nav-empty cb-hint' }, 'No configuration panels are loaded.'));
      warnOnce('panels', 'No panels registered — check that panels-*.js loaded.');
      return;
    }
    var index = 0;
    groupsOf(list).forEach(function (g) {
      var groupEl = el('div', { class: 'nav-group', role: 'group', 'aria-label': g.name },
        el('div', { class: 'nav-group-head' },
          el('span', { class: 'nav-group-name' }, g.name),
          GROUP_NOTES[g.name] ? el('span', { class: 'nav-group-note' }, GROUP_NOTES[g.name]) : null));
      g.panels.forEach(function (p) {
        index++;
        var key = index <= 9 ? String(index) : null;
        var badge = el('span', { class: 'nav-badge', hidden: true });
        var btn = el('button', {
          type: 'button', class: 'nav-item', dataset: { panel: p.id }, title: p.title + (key ? '  (' + key + ')' : ''),
          'aria-current': 'false'
        },
          el('span', { class: 'nav-icon', html: p.icon || icon('spark') }),
          el('span', { class: 'nav-text' },
            el('span', { class: 'nav-title' }, p.title),
            p.subtitle ? el('span', { class: 'nav-sub' }, p.subtitle) : null),
          key ? el('kbd', { class: 'nav-key' }, key) : null,
          badge);
        btn.addEventListener('click', function () { goto(p.id); });
        groupEl.appendChild(btn);
        var mb = null, mbadge = null;
        if (bottom) {
          mbadge = el('span', { class: 'nav-badge', hidden: true });
          mb = el('button', { type: 'button', class: 'bnav-item', dataset: { panel: p.id }, 'aria-label': p.title },
            el('span', { class: 'nav-icon', html: p.icon || icon('spark') }), el('span', { class: 'bnav-title' }, p.title), mbadge);
          mb.addEventListener('click', function () { goto(p.id); });
          bottom.appendChild(mb);
        }
        navItems[p.id] = { btn: btn, badge: badge, mobile: mb, mbadge: mbadge, def: p, index: index };
      });
      nav.appendChild(groupEl);
    });

    // progress footer: how many sections have been visited this session
    nav.appendChild(el('div', { class: 'nav-foot' },
      el('div', { class: 'nav-progress' }, el('span', { class: 'nav-progress-bar', id: 'nav-progress-bar' })),
      el('span', { class: 'nav-progress-label cb-hint', id: 'nav-progress-label' }, '')));
    updateNavState();
  }

  var visited = {};
  function updateNavState() {
    Object.keys(navItems).forEach(function (id) {
      var it = navItems[id], on = id === active.id;
      it.btn.classList.toggle('is-active', on);
      it.btn.setAttribute('aria-current', on ? 'page' : 'false');
      it.btn.classList.toggle('is-visited', !!visited[id]);
      if (it.mobile) { it.mobile.classList.toggle('is-active', on); if (on && it.mobile.scrollIntoView) safe(function () { it.mobile.scrollIntoView({ block: 'nearest', inline: 'center' }); }); }
    });
    var total = Object.keys(navItems).length, seen = Object.keys(visited).filter(function (k) { return navItems[k]; }).length;
    var bar = $('nav-progress-bar'), label = $('nav-progress-label');
    if (bar) bar.style.width = (total ? (seen / total) * 100 : 0) + '%';
    if (label) label.textContent = seen + ' of ' + total + ' sections reviewed';
  }

  function updateNavBadges(issues) {
    var by = {};
    (issues || []).forEach(function (i) {
      var s = i.section || 'other';
      by[s] = by[s] || { error: 0, warning: 0, info: 0 };
      by[s][i.severity === 'error' || i.severity === 'warning' ? i.severity : 'info']++;
    });
    Object.keys(navItems).forEach(function (id) {
      var it = navItems[id], c = by[id];
      [[it.badge, it.btn], [it.mbadge, it.mobile]].forEach(function (pair) {
        var b = pair[0];
        if (!b) return;
        if (!c || (!c.error && !c.warning)) { b.hidden = true; b.textContent = ''; b.className = 'nav-badge'; return; }
        b.hidden = false;
        b.textContent = String(c.error || c.warning);
        b.className = 'nav-badge ' + (c.error ? 'is-error' : 'is-warning');
        b.title = (c.error ? c.error + ' error' + (c.error > 1 ? 's' : '') : '') + (c.error && c.warning ? ', ' : '') + (c.warning ? c.warning + ' warning' + (c.warning > 1 ? 's' : '') : '');
      });
    });
  }

  function orderedIds() { return panels().map(function (p) { return p.id; }); }

  function goto(id, opts) {
    opts = opts || {};
    var list = panels();
    if (!list.length) return false;
    var def = (CB.panels && CB.panels[id]) || null;
    if (!def) def = list[0];
    if (active.id === def.id && !opts.force) { focusPanel(opts); return true; }
    mountPanel(def, opts);
    return true;
  }
  function step(delta) {
    var ids = orderedIds(), i = ids.indexOf(active.id);
    if (!ids.length) return;
    var j = i < 0 ? 0 : (i + delta + ids.length) % ids.length;
    goto(ids[j]);
  }
  function focusPanel(opts) {
    if (opts && opts.focus === false) return;
    var host = $('panel-host');
    if (host && opts && opts.focus) safe(function () { host.focus({ preventScroll: true }); });
  }

  function destroyActive() {
    if (!active.def) return;
    var d = active.def;
    ['destroy', 'unmount'].forEach(function (fn) { if (typeof d[fn] === 'function') safe(function () { d[fn].call(d, active.body); }, null, 'panel ' + fn); });
  }

  function mountPanel(def, opts) {
    var host = $('panel-host');
    if (!host) return;
    destroyActive();
    U.clear(host);
    var ids = orderedIds(), idx = ids.indexOf(def.id);
    var prevDef = idx > 0 ? CB.panels[ids[idx - 1]] : null;
    var nextDef = idx >= 0 && idx < ids.length - 1 ? CB.panels[ids[idx + 1]] : null;

    var body = el('div', { class: 'panel-body', dataset: { panel: def.id } });
    var head = el('header', { class: 'panel-head' },
      el('span', { class: 'panel-head-icon', html: def.icon || icon('spark') }),
      el('div', { class: 'panel-head-text' },
        el('div', { class: 'panel-crumb' }, (def.group || 'Configuration') + ' / ' + 'section ' + (idx + 1) + ' of ' + ids.length),
        el('h2', { class: 'panel-title', id: 'panel-title' }, def.title || def.id),
        def.subtitle ? el('p', { class: 'panel-subtitle' }, def.subtitle) : null),
      el('div', { class: 'panel-head-nav' },
        navBtn(prevDef, -1, 'Previous section'),
        navBtn(nextDef, 1, 'Next section')));
    var foot = el('footer', { class: 'panel-foot' },
      prevDef ? el('button', { type: 'button', class: 'cb-btn ghost panel-foot-prev', onclick: function () { goto(prevDef.id, { focus: true }); } },
        el('span', { class: 'panel-foot-dir' }, 'Back'), el('span', { class: 'panel-foot-name' }, prevDef.title)) : el('span'),
      nextDef ? el('button', { type: 'button', class: 'cb-btn panel-foot-next', onclick: function () { goto(nextDef.id, { focus: true }); } },
        el('span', { class: 'panel-foot-dir' }, 'Continue to'), el('span', { class: 'panel-foot-name' }, nextDef.title))
        : el('button', { type: 'button', class: 'cb-btn primary panel-foot-next', onclick: function () { openGarage('openSpec'); } },
          el('span', { class: 'panel-foot-dir' }, 'Finished?'), el('span', { class: 'panel-foot-name' }, 'Review the spec sheet')));
    var frame = el('article', { class: 'panel-frame', 'aria-labelledby': 'panel-title' }, head, body, foot);
    host.appendChild(frame);

    active = { id: def.id, def: def, body: body, frame: frame };
    visited[def.id] = true;
    var b = CB.state.get(), bundle = compute(b);
    renderPanelBody(def, body, b, bundle.metrics);
    host.scrollTop = 0;
    frame.classList.add('is-entering');
    setTimeout(function () { frame.classList.remove('is-entering'); }, 400);
    var params = parseHash();
    writeHash({ p: def.id, b: params.b && !bootStripped ? params.b : null });
    lsSet(LS_UI, Object.assign(lsGet(LS_UI, {}), { panel: def.id }));
    updateNavState();
    focusPanel(opts);
  }

  function navBtn(def, dir, label) {
    return el('button', {
      type: 'button', class: 'cb-btn ghost icon-btn', disabled: !def, 'aria-label': label + (def ? ': ' + def.title : ''), title: def ? def.title : '',
      html: dir < 0 ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
      onclick: function () { if (def) goto(def.id, { focus: true }); }
    });
  }

  function renderPanelBody(def, body, build, metrics) {
    U.clear(body);
    safe(function () { def.render.call(def, body, build, metrics); }, null, 'panel "' + def.id + '" render failed');
    if (!body.firstChild) {
      body.appendChild(el('div', { class: 'cb-section panel-error' },
        el('p', null, 'This section could not be displayed. Your build is unaffected — try another section or reload.')));
    }
  }

  function updateActivePanel(build, metrics, change) {
    if (!active.def || !active.body) return;
    var def = active.def;
    if (typeof def.update === 'function') {
      safe(function () { def.update.call(def, build, metrics, change || { path: '*' }); }, null, 'panel "' + def.id + '" update failed');
    } else {
      var host = $('panel-host'), st = host ? host.scrollTop : 0, ws = window.scrollY;
      var focusedPath = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-cb-path]');
      var fp = focusedPath ? focusedPath.dataset.cbPath : null;
      renderPanelBody(def, active.body, build, metrics);
      if (host) host.scrollTop = st;
      if (window.scrollY !== ws) window.scrollTo(0, ws);
      if (fp) {
        var again = active.body.querySelector('[data-cb-path="' + fp.replace(/"/g, '') + '"] input, [data-cb-path="' + fp.replace(/"/g, '') + '"] button');
        if (again) safe(function () { again.focus({ preventScroll: true }); });
      }
    }
  }

  function redrawPanelCharts() {
    if (!active.def) return;
    var b = CB.state.get();
    updateActivePanel(b, compute(b).metrics, { path: '*', type: 'theme' });
  }

  /* ---------------------------------------------------------------- perf strip */
  var QS = [
    { id: 'qs-hp', key: 'power_hp', d: 0, better: 1 },
    { id: 'qs-torque', key: 'torque_nm', d: 0, better: 1 },
    { id: 'qs-060', key: 'zeroTo60_s', d: 1, better: -1 },
    { id: 'qs-top', key: 'topSpeed_kph', d: 0, better: 1 },
    { id: 'qs-weight', key: 'weight_kg', d: 0, better: -1 },
    { id: 'qs-price', key: 'price', d: 0, better: -1, money: true }
  ];
  var qsState = {};

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function animateNumber(node, from, to, opts) {
    opts = opts || {};
    var format = opts.format || function (v) { return fmt(v, opts.d); };
    if (node._raf) cancelAnimationFrame(node._raf);
    if (reduceMotion || from == null || !isFinite(from) || !isFinite(to) || from === to || document.hidden) {
      node.textContent = format(to);
      return;
    }
    var start = null, dur = opts.duration || 520;
    function tick(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / dur);
      node.textContent = format(from + (to - from) * easeOut(t));
      if (t < 1) node._raf = requestAnimationFrame(tick);
      else { node._raf = null; node.textContent = format(to); }
    }
    node._raf = requestAnimationFrame(tick);
  }

  function initPerfStrip() {
    QS.forEach(function (q) {
      var node = $(q.id);
      if (!node) return;
      var qs = node.closest('.qs');
      var delta = el('span', { class: 'qs-delta', 'aria-hidden': 'true' });
      if (qs) qs.appendChild(delta);
      qsState[q.id] = { node: node, qs: qs, delta: delta, value: null, timer: null };
    });
    var strip = $('perf-strip');
    if (strip && !strip.querySelector('.qs-note')) {
      strip.appendChild(el('div', { class: 'qs qs-note', id: 'qs-note-wrap', hidden: true },
        el('span', { class: 'qs-label' }, 'Traction'), el('span', { class: 'qs-value qs-note-text', id: 'qs-note' }, '')));
    }
  }

  function updatePerfStrip(bundle, animate) {
    var m = bundle.metrics || {}, p = bundle.pricing || {};
    QS.forEach(function (q) {
      var st = qsState[q.id];
      if (!st) return;
      var v = q.key === 'price' ? (p.total != null ? p.total : p.msrp) : m[q.key];
      if (v == null || !isFinite(v)) { st.node.textContent = '—'; st.value = null; return; }
      var format = q.money ? function (x) { return U.fmtMoney(Math.round(x)); } : function (x) { return fmt(x, q.d); };
      var prev = st.value;
      if (animate) animateNumber(st.node, prev, v, { d: q.d, format: format });
      else st.node.textContent = format(v);
      if (animate && prev != null && Math.abs(v - prev) > Math.pow(10, -q.d) / 2) {
        var diff = v - prev, good = diff * q.better > 0;
        st.delta.textContent = (diff > 0 ? '+' : '−') + (q.money ? U.fmtMoney(Math.abs(Math.round(diff))) : fmt(Math.abs(diff), q.d));
        st.delta.className = 'qs-delta is-visible ' + (good ? 'is-good' : 'is-bad');
        if (st.qs) { st.qs.classList.remove('is-pulse'); void st.qs.offsetWidth; st.qs.classList.add('is-pulse'); }
        clearTimeout(st.timer);
        st.timer = setTimeout(function () { st.delta.classList.remove('is-visible'); }, 2200);
      }
      st.value = v;
    });
    var noteWrap = $('qs-note-wrap'), note = $('qs-note');
    if (noteWrap && note) {
      var n = m.zeroTo60_note;
      noteWrap.hidden = !n;
      note.textContent = n ? U.capitalize(String(n).replace(/-/g, ' ')) : '';
    }
  }

  /* ---------------------------------------------------------------- charts registry */
  var charts = {};       // name -> { inst, canvas }
  var chartDirty = {};   // name -> true when needs redraw (e.g. hidden tab)

  function drawChart(name, canvas, fnName, args) {
    if (!canvas) return;
    var fn = CB.charts && CB.charts[fnName];
    var slot = charts[name];
    if (typeof fn !== 'function') {
      warnOnce('chart-' + fnName, 'CB.charts.' + fnName + ' missing — chart "' + name + '" skipped.');
      var wrap = canvas.parentNode;
      if (wrap && !wrap.querySelector('.chart-missing')) wrap.appendChild(el('div', { class: 'chart-missing cb-hint' }, 'Chart unavailable'));
      return;
    }
    if (!canvas.isConnected || canvas.offsetParent === null) { chartDirty[name] = { canvas: canvas, fnName: fnName, args: args }; return; }
    if (slot && slot.inst && slot.canvas === canvas && typeof slot.inst.update === 'function') {
      safe(function () { slot.inst.update.apply(slot.inst, args); }, null, 'chart ' + name + ' update');
    } else {
      if (slot && slot.inst && typeof slot.inst.destroy === 'function') safe(function () { slot.inst.destroy(); });
      var inst = safe(function () { return fn.apply(CB.charts, [canvas].concat(args)); }, null, 'chart ' + name);
      charts[name] = { inst: inst, canvas: canvas };
    }
    delete chartDirty[name];
  }
  function flushDirtyCharts() {
    Object.keys(chartDirty).forEach(function (n) {
      var d = chartDirty[n];
      if (d.canvas.offsetParent !== null) drawChart(n, d.canvas, d.fnName, d.args);
    });
  }
  function markChartsDirty() { summaryDirty = true; scheduleHeavy(); }

  /* ---------------------------------------------------------------- summary aside */
  var summary = { tab: 'perf', built: false };
  var summaryDirty = true;

  function initSummaryTabs() {
    var root = $('summary-tabs');
    if (!root) return;
    var tabsEls = Array.prototype.slice.call(root.querySelectorAll('.cb-tab'));
    function select(id, focus) {
      tabsEls.forEach(function (t) {
        var on = t.dataset.tab === id;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        var pane = $(t.getAttribute('aria-controls'));
        if (pane) pane.hidden = !on;
        if (on && focus) t.focus();
      });
      summary.tab = id;
      lsSet(LS_UI, Object.assign(lsGet(LS_UI, {}), { tab: id }));
      summaryDirty = true;
      refreshSummary(true);
    }
    tabsEls.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t.dataset.tab); });
      t.addEventListener('keydown', function (ev) {
        var d = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        ev.preventDefault();
        select(tabsEls[(i + d + tabsEls.length) % tabsEls.length].dataset.tab, true);
      });
    });
    summary.selectTab = select;
    var saved = lsGet(LS_UI, {}).tab;
    select(saved && root.querySelector('[data-tab="' + saved + '"]') ? saved : 'perf');
  }

  /* -------- performance pane */
  var RATING_LABELS = [
    ['acceleration', 'Acceleration'], ['handling', 'Handling'], ['braking', 'Braking'], ['track', 'Track pace'],
    ['comfort', 'Comfort'], ['efficiency', 'Efficiency'], ['reliability', 'Reliability'], ['practicality', 'Practicality'],
    ['luxury', 'Luxury'], ['sound', 'Sound']
  ];
  var perf = {};

  function buildPerfPane() {
    var host = $('summary-perf');
    if (!host) return;
    U.clear(host);
    perf.ratings = el('div', { class: 'rating-list' });
    perf.ratingRows = {};
    RATING_LABELS.forEach(function (r) {
      var fill = el('span', { class: 'rating-fill' });
      var val = el('span', { class: 'rating-val' }, '—');
      var row = el('div', { class: 'rating-row', title: r[1] }, el('span', { class: 'rating-name' }, r[1]), el('span', { class: 'rating-bar' }, fill), val);
      perf.ratingRows[r[0]] = { fill: fill, val: val };
      perf.ratings.appendChild(row);
    });
    perf.overall = el('div', { class: 'overall' },
      el('span', { class: 'overall-num', id: 'overall-num' }, '—'),
      el('span', { class: 'overall-text' }, el('span', { class: 'overall-label' }, 'Redline index'), el('span', { class: 'overall-class cb-hint', id: 'overall-class' }, '')));

    perf.kv = CB.ui && CB.ui.kv ? CB.ui.kv([]) : el('dl', { class: 'cb-kv' });

    perf.lap = el('div', { class: 'lap-card' },
      el('div', { class: 'lap-head' },
        el('div', null, el('div', { class: 'cb-label' }, (U.get(CB, 'data.constants.lapName') || 'Redline Ring') + ' lap'),
          el('div', { class: 'lap-sub cb-hint' }, fmt(U.get(CB, 'data.constants.lapLength_km') || 5.8, 1) + ' km circuit, dry, estimated')),
        el('div', { class: 'lap-time-wrap' }, el('span', { class: 'lap-time', id: 'lap-time' }, '—'), el('span', { class: 'lap-delta', id: 'lap-delta' }, ''))),
      el('div', { class: 'sector-bar', id: 'sector-bar' }),
      el('div', { class: 'sector-legend', id: 'sector-legend' }));

    function chartBox(title, id, h) {
      var c = el('canvas', { id: id, role: 'img', 'aria-label': title });
      return el('div', { class: 'summary-chart' }, el('div', { class: 'cb-label summary-chart-title' }, title), el('div', { class: 'cb-chart', style: { height: (h || 180) + 'px' } }, c));
    }
    perf.dynoBox = chartBox('Dyno: power and torque against rpm', 'summary-dyno', 180);
    perf.accelBox = chartBox('Acceleration: speed against time', 'summary-accel', 170);
    perf.warnings = el('div', { class: 'physics-warnings' });
    perf.race = el('div', { class: 'race-cta', hidden: true },
      el('div', null, el('div', { class: 'race-cta-title' }, 'Take it to the track'), el('div', { class: 'cb-hint' }, 'Race this exact build against AI drivers.')),
      el('button', { type: 'button', class: 'cb-btn primary', onclick: openRace }, 'Race'));

    host.appendChild(perf.overall);
    host.appendChild(perf.ratings);
    host.appendChild(el('div', { class: 'summary-block' }, el('div', { class: 'cb-label' }, 'Key figures'), perf.kv));
    host.appendChild(perf.lap);
    host.appendChild(perf.dynoBox);
    host.appendChild(perf.accelBox);
    host.appendChild(perf.warnings);
    host.appendChild(perf.race);
  }

  function ratingsAvg(r) {
    if (!r) return null;
    var keys = Object.keys(r).filter(function (k) { return isFinite(r[k]); });
    if (!keys.length) return null;
    return keys.reduce(function (s, k) { return s + Number(r[k]); }, 0) / keys.length;
  }
  function classify(m) {
    if (!m) return '';
    var r = m.ratings || {};
    if (m.zeroTo60_s != null && m.zeroTo60_s < 2.6) return 'Hypercar territory';
    if ((r.track || 0) > 80) return 'Circuit specialist';
    if ((r.luxury || 0) > 75 && (r.comfort || 0) > 65) return 'Grand tourer';
    if ((r.efficiency || 0) > 78) return 'Efficiency champion';
    if ((r.practicality || 0) > 75) return 'Everyday all-rounder';
    if ((r.acceleration || 0) > 75) return 'Straight-line weapon';
    if ((r.handling || 0) > 70) return 'Driver’s car';
    return 'Balanced road car';
  }

  function updatePerfPaneCheap(bundle) {
    if (!perf.ratingRows) return;
    var m = bundle.metrics;
    var r = (m && m.ratings) || {};
    RATING_LABELS.forEach(function (x) {
      var row = perf.ratingRows[x[0]], v = r[x[0]];
      if (!row) return;
      var ok = v != null && isFinite(v);
      row.fill.style.width = (ok ? U.clamp(v, 0, 100) : 0) + '%';
      row.fill.className = 'rating-fill' + (ok && v >= 75 ? ' is-high' : ok && v < 35 ? ' is-low' : '');
      row.val.textContent = ok ? fmt(v, 0) : '—';
    });
    var avg = ratingsAvg(m && m.ratings);
    var on = $('overall-num'), oc = $('overall-class');
    if (on) on.textContent = avg == null ? '—' : fmt(avg, 0);
    if (oc) oc.textContent = classify(m);

    if (m) {
      var u = U.units || {};
      var rows = [
        ['Power', fmt(m.power_hp) + ' hp / ' + fmt(m.power_kw) + ' kW' + (m.peakPowerRpm ? ' @ ' + fmt(m.peakPowerRpm) + ' rpm' : '')],
        ['Torque', fmt(m.torque_nm) + ' Nm' + (u.nmToLbft ? ' / ' + fmt(u.nmToLbft(m.torque_nm || 0)) + ' lb-ft' : '') + (m.peakTorqueRpm ? ' @ ' + fmt(m.peakTorqueRpm) + ' rpm' : '')],
        ['0–60 mph / 0–100 km/h', fmt(m.zeroTo60_s, 2) + ' s / ' + fmt(m.zeroTo100_s, 2) + ' s'],
        ['0–200 km/h', m.zeroTo200_s == null ? 'Not reached' : fmt(m.zeroTo200_s, 1) + ' s'],
        ['Quarter mile', fmt(m.quarterMile_s, 2) + ' s @ ' + fmt(m.quarterMileTrap_mph) + ' mph'],
        ['Top speed', fmt(m.topSpeed_kph) + ' km/h / ' + fmt(m.topSpeed_mph) + ' mph' + (m.topSpeedLimitedBy ? ' (' + m.topSpeedLimitedBy + '-limited)' : '')],
        ['Lateral grip', fmt(m.lateralG, 2) + ' g'],
        ['Braking 100–0 km/h', fmt(m.brakingDist_100_0_m, 1) + ' m'],
        ['Weight', fmt(m.weight_kg) + ' kg, ' + fmt(m.weightFront_pct, 1) + '% front'],
        ['Power to weight', fmt(m.powerToWeight_hpPerTon) + ' hp/tonne'],
        ['Drag', 'Cd ' + fmt(m.cd, 3) + ', CdA ' + fmt(m.cda, 2) + ' m²'],
        ['Downforce @ 200 km/h', fmt(m.downforce_kg_200) + ' kg'],
        m.efficiency_whkm ? ['Efficiency', fmt(m.efficiency_whkm) + ' Wh/km'] : ['Fuel economy', fmt(m.fuelEconomy_l100, 1) + ' L/100 km / ' + fmt(m.fuelEconomy_mpg, 1) + ' mpg'],
        ['Range', fmt(m.range_km) + ' km'],
        ['CO₂', fmt(m.co2_gkm) + ' g/km'],
        ['Cabin noise / exhaust', fmt(m.noise_db_cabin) + ' dB / ' + fmt(m.exhaust_db) + ' dB']
      ];
      if (perf.kv.set) perf.kv.set(rows);
    } else if (perf.kv.set) {
      perf.kv.set([['Performance', 'The physics engine is not loaded']]);
    }

    // lap
    var lt = $('lap-time'), ld = $('lap-delta'), bar = $('sector-bar'), leg = $('sector-legend');
    if (lt) lt.textContent = m ? fmtLap(m.lapTime_s) : '—';
    var ref = reference();
    if (ld) {
      if (m && ref && isFinite(m.lapTime_s) && isFinite(ref.lapTime_s)) {
        var d = m.lapTime_s - ref.lapTime_s;
        ld.textContent = Math.abs(d) < 0.0005 ? 'Reference' : (d > 0 ? '+' : '−') + Math.abs(d).toFixed(3) + ' s vs reference';
        ld.className = 'lap-delta ' + (d < -0.0005 ? 'is-good' : d > 0.0005 ? 'is-bad' : '');
      } else ld.textContent = '';
    }
    if (bar && leg) {
      U.clear(bar); U.clear(leg);
      var secs = (m && Array.isArray(m.lapSectors)) ? m.lapSectors : [];
      var refSecs = ref && Array.isArray(ref.lapSectors) ? ref.lapSectors : [];
      var tot = secs.reduce(function (s, x) { return s + num(x); }, 0);
      secs.forEach(function (s, i) {
        var dd = refSecs[i] != null ? s - refSecs[i] : 0;
        var kind = dd < -0.05 ? 'is-good' : dd > 0.05 ? 'is-bad' : '';
        bar.appendChild(el('span', { class: 'sector s' + (i + 1) + ' ' + kind, style: { flexGrow: String(tot ? s / tot : 1) }, title: 'Sector ' + (i + 1) + ': ' + fmt(s, 3) + ' s' }));
        leg.appendChild(el('span', { class: 'sector-item ' + kind },
          el('span', { class: 'sector-name' }, 'S' + (i + 1)), el('span', { class: 'sector-time' }, fmt(s, 3)),
          refSecs[i] != null && Math.abs(dd) >= 0.0005 ? el('span', { class: 'sector-d' }, (dd > 0 ? '+' : '−') + Math.abs(dd).toFixed(2)) : null));
      });
    }

    // physics warnings
    if (perf.warnings) {
      var w = (m && m.warnings) || [];
      var key = w.join('|');
      if (perf.warnings._key !== key) {
        perf.warnings._key = key;
        U.clear(perf.warnings);
        if (w.length) {
          perf.warnings.appendChild(el('div', { class: 'cb-label' }, 'Engineering notes'));
          w.forEach(function (t) { perf.warnings.appendChild(el('div', { class: 'cb-issue is-warning is-compact' }, el('span', { class: 'cb-issue-icon', html: icon('warn') }), el('div', { class: 'cb-issue-body' }, el('div', { class: 'cb-issue-msg' }, t)))); });
        }
      }
    }
    if (perf.race) perf.race.hidden = !raceAvailable();
  }

  function updatePerfCharts(bundle) {
    var m = bundle.metrics;
    if (!m) return;
    drawChart('radar', $('radar'), 'radar', [m.ratings || {}]);
    drawChart('dyno', $('summary-dyno'), 'dyno', [m]);
    drawChart('accel', $('summary-accel'), 'accel', [m]);
  }

  /* -------- price pane */
  var DEFAULT_FIN = {
    apr: 6.9, months: 60, down: 15000, tradeIn: 0, taxRate: 7.25,
    lease: { months: 36, residual_pct: 55, moneyFactor: 0.0025, down: 5000 },
    mode: 'finance'
  };
  var fin = U.deepMerge(DEFAULT_FIN, lsGet(LS_FIN, {}) || {});
  var price = {};

  function saveFin() { lsSet(LS_FIN, fin); }

  /** Pure local amortisation used as fallback and as a sanity check for CB.pricing.finance. */
  function localFinance(total, o) {
    var tax = Math.max(0, num(o.taxRate)) / 100;
    var principal = Math.max(0, total * (1 + tax) - num(o.down) - num(o.tradeIn));
    var n = Math.max(1, Math.round(num(o.months, 60)));
    var r = Math.max(0, num(o.apr)) / 100 / 12;
    var monthly = r === 0 ? principal / n : principal * r / (1 - Math.pow(1 + r, -n));
    var bal = principal, schedule = [], totalInterest = 0;
    for (var i = 1; i <= n; i++) {
      var interest = bal * r, pr = monthly - interest;
      bal = Math.max(0, bal - pr); totalInterest += interest;
      schedule.push({ month: i, principal: pr, interest: interest, balance: bal });
    }
    return {
      monthly: monthly, totalInterest: totalInterest, principal: principal, taxes: total * tax,
      totalCost: monthly * n + num(o.down) + num(o.tradeIn), schedule: schedule
    };
  }
  function localLease(total, o) {
    var n = Math.max(1, Math.round(num(o.months, 36)));
    var residual = total * num(o.residual_pct, 55) / 100;
    var cap = Math.max(0, total - num(o.down));
    var dep = Math.max(0, (cap - residual) / n);
    var charge = (cap + residual) * num(o.moneyFactor, 0.0025);
    var monthly = dep + charge;
    return { monthly: monthly, residual: residual, depreciation: dep, financeCharge: charge, totalCost: monthly * n + num(o.down), apr: num(o.moneyFactor) * 2400 };
  }

  /** Use CB.pricing.finance when it agrees with standard amortisation (detecting % vs fraction conventions). */
  function finance(total) {
    total = num(total);
    var local = localFinance(total, fin);
    if (!has('pricing.finance')) return local;
    var attempts = [
      { apr: fin.apr, months: fin.months, down: fin.down, tradeIn: fin.tradeIn, taxRate: fin.taxRate },
      { apr: fin.apr / 100, months: fin.months, down: fin.down, tradeIn: fin.tradeIn, taxRate: fin.taxRate / 100 },
      { apr: fin.apr / 100, months: fin.months, down: fin.down, tradeIn: fin.tradeIn, taxRate: fin.taxRate },
      { apr: fin.apr, months: fin.months, down: fin.down, tradeIn: fin.tradeIn, taxRate: fin.taxRate / 100 }
    ];
    for (var i = 0; i < attempts.length; i++) {
      var r = safe(function () { return CB.pricing.finance(total, attempts[i]); }, null, 'pricing.finance');
      if (r && isFinite(r.monthly) && Math.abs(r.monthly - local.monthly) <= Math.max(2, local.monthly * 0.03)) {
        if (!Array.isArray(r.schedule) || !r.schedule.length) r.schedule = local.schedule;
        if (!isFinite(r.totalInterest)) r.totalInterest = local.totalInterest;
        if (!isFinite(r.totalCost)) r.totalCost = local.totalCost;
        r.principal = r.principal != null ? r.principal : local.principal;
        return r;
      }
    }
    warnOnce('finance-mismatch', 'CB.pricing.finance result disagrees with standard amortisation — using local calculation.');
    return local;
  }
  function lease(total) {
    total = num(total);
    var local = localLease(total, fin.lease);
    if (!has('pricing.lease')) return local;
    var r = safe(function () { return CB.pricing.lease(total, Object.assign({}, fin.lease)); }, null, 'pricing.lease');
    if (r && isFinite(r.monthly) && r.monthly > 0 && r.monthly < total) return Object.assign({}, local, r);
    return local;
  }

  function finControls() {
    if (!CB.ui || !CB.ui.slider) return el('p', { class: 'cb-hint' }, 'Form controls unavailable.');
    function slider(label, key, min, max, stepv, unit, format, obj) {
      obj = obj || fin;
      return CB.ui.slider({
        label: label, min: min, max: max, step: stepv, unit: unit, format: format, ticks: false,
        defaultValue: U.get(DEFAULT_FIN, obj === fin ? key : 'lease.' + key),
        get: function () { return obj[key]; },
        set: function (v) { obj[key] = v; saveFin(); updateFinance(lastBundle); }
      });
    }
    var moneyFmt = function (v) { return U.fmtMoney(v); };
    price.finBox = el('div', { class: 'fin-form' },
      slider('APR', 'apr', 0, 19.9, 0.1, '%', function (v) { return fmt(v, 1) + '%'; }),
      CB.ui.segmented({
        label: 'Term', options: [24, 36, 48, 60, 72, 84].map(function (n) { return { id: n, name: n + ' mo' }; }),
        get: function () { return fin.months; }, set: function (v) { fin.months = Number(v); saveFin(); updateFinance(lastBundle); }
      }),
      slider('Down payment', 'down', 0, 250000, 500, '', moneyFmt),
      slider('Trade-in value', 'tradeIn', 0, 200000, 500, '', moneyFmt),
      slider('Sales tax', 'taxRate', 0, 12, 0.05, '%', function (v) { return fmt(v, 2) + '%'; }));
    price.leaseBox = el('div', { class: 'fin-form' },
      CB.ui.segmented({
        label: 'Lease term', options: [24, 36, 39, 48].map(function (n) { return { id: n, name: n + ' mo' }; }),
        get: function () { return fin.lease.months; }, set: function (v) { fin.lease.months = Number(v); saveFin(); updateFinance(lastBundle); }
      }),
      slider('Residual value', 'residual_pct', 20, 75, 1, '%', function (v) { return fmt(v, 0) + '%'; }, fin.lease),
      slider('Money factor', 'moneyFactor', 0.0005, 0.006, 0.0001, '', function (v) { return v.toFixed(4) + ' (≈' + fmt(v * 2400, 1) + '% APR)'; }, fin.lease),
      slider('Due at signing', 'down', 0, 60000, 500, '', moneyFmt, fin.lease));
    return null;
  }

  function buildPricePane() {
    var host = $('price-breakdown');
    if (!host) return;
    U.clear(host);
    price.openSections = lsGet(LS_UI, {}).openPriceSections || {};
    price.lines = el('div', { class: 'price-lines' });
    price.totals = el('div', { class: 'price-totals' });
    var donutCanvas = el('canvas', { id: 'summary-donut', role: 'img', 'aria-label': 'Price composition by section' });
    price.donut = el('div', { class: 'summary-chart' }, el('div', { class: 'cb-label summary-chart-title' }, 'Where the money goes'), el('div', { class: 'cb-chart donut-wrap' }, donutCanvas)); // height chosen by CB.charts (ring + full legend)
    finControls();
    price.finOut = el('div', { class: 'fin-out' });
    var amortCanvas = el('canvas', { id: 'summary-amort', role: 'img', 'aria-label': 'Loan amortisation' });
    price.amort = el('div', { class: 'cb-chart amort-wrap', style: { height: '210px' } }, amortCanvas);
    price.leaseOut = el('div', { class: 'fin-out' });
    price.meta = el('div', { class: 'price-meta' });

    var modeSeg = el('div', { class: 'cb-seg fin-mode' }, el('div', { class: 'cb-seg-btns', role: 'tablist' },
      ['finance', 'lease', 'cash'].map(function (m) {
        var b = el('button', { type: 'button', class: 'cb-seg-btn', dataset: { mode: m }, role: 'tab' }, U.capitalize(m));
        b.addEventListener('click', function () { fin.mode = m; saveFin(); syncFinMode(); updateFinance(lastBundle); });
        return b;
      })));
    price.modeSeg = modeSeg;
    price.finWrap = el('div', { class: 'fin-pane', dataset: { mode: 'finance' } }, price.finBox, price.finOut, price.amort);
    price.leaseWrap = el('div', { class: 'fin-pane', dataset: { mode: 'lease' } }, price.leaseBox, price.leaseOut);
    price.cashWrap = el('div', { class: 'fin-pane', dataset: { mode: 'cash' } }, el('p', { class: 'cb-hint' }, 'Paying outright: the on-the-road figure below includes sales tax at your chosen rate.'), el('div', { class: 'fin-out', id: 'cash-out' }));

    host.appendChild(el('div', { class: 'summary-block' }, el('div', { class: 'price-lines-head' }, el('span', { class: 'cb-label' }, 'Itemised build'),
      el('button', { type: 'button', class: 'cb-btn ghost small', onclick: function () { toggleAllSections(); } }, 'Expand all')), price.lines, price.totals));
    host.appendChild(price.donut);
    host.appendChild(el('div', { class: 'summary-block fin-block' }, el('div', { class: 'cb-label' }, 'Pay for it'), modeSeg, price.finWrap, price.leaseWrap, price.cashWrap));
    host.appendChild(price.meta);
    syncFinMode();
  }

  function syncFinMode() {
    if (!price.modeSeg) return;
    Array.prototype.forEach.call(price.modeSeg.querySelectorAll('.cb-seg-btn'), function (b) {
      var on = b.dataset.mode === fin.mode;
      b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    [price.finWrap, price.leaseWrap, price.cashWrap].forEach(function (w) { if (w) w.hidden = w.dataset.mode !== fin.mode; });
  }

  function toggleAllSections() {
    var details = price.lines ? price.lines.querySelectorAll('details') : [];
    var anyClosed = Array.prototype.some.call(details, function (d) { return !d.open; });
    Array.prototype.forEach.call(details, function (d) { d.open = anyClosed; price.openSections[d.dataset.section] = anyClosed; });
    lsSet(LS_UI, Object.assign(lsGet(LS_UI, {}), { openPriceSections: price.openSections }));
  }

  function sectionTitle(id) {
    if (CB.panels && CB.panels[id]) return CB.panels[id].title;
    var map = { base: 'Base vehicle', fees: 'Fees & taxes', options: 'Options', paint: 'Paint', other: 'Other' };
    return map[id] || U.capitalize(String(id || 'Other').replace(/[-_]/g, ' '));
  }

  function updatePriceLines(bundle) {
    if (!price.lines) return;
    var p = bundle.pricing;
    if (!p) {
      U.clear(price.lines); U.clear(price.totals);
      price.lines.appendChild(el('p', { class: 'cb-hint' }, 'The pricing engine is not loaded, so no breakdown is available.'));
      return;
    }
    var lines = Array.isArray(p.lines) ? p.lines : [];
    var key = JSON.stringify(lines.map(function (l) { return [l.section, l.label, Math.round(num(l.amount))]; })) + '|' + p.total;
    if (price._key === key) return;
    price._key = key;
    U.clear(price.lines);
    var order = orderedIds();
    var groups = {};
    lines.forEach(function (l) { var s = l.section || 'other'; (groups[s] = groups[s] || []).push(l); });
    var secIds = Object.keys(groups).sort(function (a, b) {
      var ia = a === 'base' ? -1 : order.indexOf(a), ib = b === 'base' ? -1 : order.indexOf(b);
      return (ia < -1 ? 99 : ia < 0 && a !== 'base' ? 98 : ia) - (ib < -1 ? 99 : ib < 0 && b !== 'base' ? 98 : ib);
    });
    var max = 0;
    secIds.forEach(function (s) { var t = groups[s].reduce(function (a, l) { return a + num(l.amount); }, 0); groups[s]._t = t; max = Math.max(max, t); });
    secIds.forEach(function (s) {
      var items = groups[s], tot = items._t;
      var d = el('details', { class: 'price-sec', dataset: { section: s } },
        el('summary', null,
          el('span', { class: 'price-sec-name' }, sectionTitle(s)),
          el('span', { class: 'price-sec-count cb-hint' }, items.length + (items.length === 1 ? ' item' : ' items')),
          el('span', { class: 'price-sec-bar' }, el('span', { style: { width: (max ? Math.max(2, tot / max * 100) : 0) + '%' } })),
          el('span', { class: 'price-sec-total' }, money(tot))),
        el('ul', { class: 'price-items' }, items.map(function (l) {
          var a = num(l.amount);
          return el('li', { class: a < 0 ? 'is-credit' : a === 0 ? 'is-included' : '' },
            el('span', { class: 'price-item-label' }, l.label),
            el('span', { class: 'price-item-amt' }, a === 0 ? 'Included' : (a < 0 ? '−' : '') + U.fmtMoney(Math.abs(a))));
        })));
      d.open = !!price.openSections[s];
      d.addEventListener('toggle', function () {
        price.openSections[s] = d.open;
        lsSet(LS_UI, Object.assign(lsGet(LS_UI, {}), { openPriceSections: price.openSections }));
      });
      price.lines.appendChild(d);
    });

    U.clear(price.totals);
    var rows = [['Subtotal', p.subtotal], ['Destination & delivery', p.destination], ['Gas-guzzler tax', p.gasGuzzlerTax], ['Luxury tax', p.luxuryTax], ['EV credit', p.evCredit]];
    rows.forEach(function (r) {
      if (r[1] == null || (!num(r[1]) && r[0] !== 'Subtotal')) return;
      var v = num(r[1]), credit = r[0] === 'EV credit';
      price.totals.appendChild(el('div', { class: 'price-total-row' + (credit ? ' is-credit' : '') }, el('span', null, r[0]),
        el('span', null, (credit && v > 0 ? '−' : v < 0 ? '−' : '') + U.fmtMoney(Math.abs(v)))));
    });
    price.totals.appendChild(el('div', { class: 'price-total-row is-grand' }, el('span', null, 'Total as configured'), el('span', null, money(p.total))));
    if (p.msrp != null && Math.round(p.msrp) !== Math.round(p.total)) price.totals.appendChild(el('div', { class: 'price-total-row is-dim' }, el('span', null, 'Manufacturer’s suggested retail'), el('span', null, money(p.msrp))));
  }

  function totalOf(bundle) { var p = bundle && bundle.pricing; return p ? num(p.total != null ? p.total : p.msrp) : null; }

  function updateFinance(bundle) {
    if (!bundle) return;
    var total = totalOf(bundle);
    var monthlyEl = $('price-monthly');
    if (total == null) {
      if (monthlyEl) monthlyEl.textContent = '';
      if (price.finOut) U.clear(price.finOut);
      return;
    }
    var f = finance(total), l = lease(total);
    var tax = total * num(fin.taxRate) / 100;
    if (monthlyEl) {
      monthlyEl.textContent = fin.mode === 'lease'
        ? 'or ' + U.fmtMoney(Math.round(l.monthly)) + '/mo leased over ' + fin.lease.months + ' months'
        : fin.mode === 'cash' ? U.fmtMoney(Math.round(total + tax)) + ' on the road incl. tax'
          : 'or ' + U.fmtMoney(Math.round(f.monthly)) + '/mo at ' + fmt(fin.apr, 1) + '% APR over ' + fin.months + ' months';
    }
    if (price.finOut) {
      U.clear(price.finOut);
      price.finOut.appendChild(el('div', { class: 'fin-headline' }, el('span', { class: 'fin-big' }, U.fmtMoney(Math.round(f.monthly))), el('span', { class: 'cb-hint' }, ' per month for ' + fin.months + ' months')));
      price.finOut.appendChild(CB.ui && CB.ui.kv ? CB.ui.kv([
        ['Amount financed', money(Math.round(f.principal != null ? f.principal : total + tax - fin.down - fin.tradeIn))],
        ['Sales tax', money(Math.round(tax))],
        ['Total interest', money(Math.round(f.totalInterest))],
        ['Total cost of ownership', money(Math.round(f.totalCost))]
      ]) : el('div'));
    }
    drawChart('amort', $('summary-amort'), 'amortization', [f]);
    if (price.leaseOut) {
      U.clear(price.leaseOut);
      price.leaseOut.appendChild(el('div', { class: 'fin-headline' }, el('span', { class: 'fin-big' }, U.fmtMoney(Math.round(l.monthly))), el('span', { class: 'cb-hint' }, ' per month for ' + fin.lease.months + ' months')));
      price.leaseOut.appendChild(CB.ui && CB.ui.kv ? CB.ui.kv([
        ['Residual value', money(Math.round(l.residual != null ? l.residual : total * fin.lease.residual_pct / 100))],
        ['Equivalent APR', fmt(fin.lease.moneyFactor * 2400, 2) + '%'],
        ['Due at signing', money(fin.lease.down)],
        ['Total lease cost', money(Math.round(l.totalCost != null ? l.totalCost : l.monthly * fin.lease.months + fin.lease.down))]
      ]) : el('div'));
    }
    var cash = $('cash-out');
    if (cash) {
      U.clear(cash);
      cash.appendChild(el('div', { class: 'fin-headline' }, el('span', { class: 'fin-big' }, U.fmtMoney(Math.round(total + tax))), el('span', { class: 'cb-hint' }, ' on the road')));
    }
  }

  function updatePriceMeta(bundle) {
    if (!price.meta) return;
    var p = bundle.pricing || {};
    U.clear(price.meta);
    var wk = p.buildTime_weeks, ig = p.insuranceGroup;
    function metaCard(label, value, sub, pct) {
      return el('div', { class: 'meta-card' }, el('span', { class: 'cb-label' }, label), el('span', { class: 'meta-value' }, value),
        pct != null ? el('span', { class: 'meta-gauge' }, el('span', { style: { width: U.clamp(pct, 0, 100) + '%' } })) : null,
        sub ? el('span', { class: 'cb-hint' }, sub) : null);
    }
    var eta = null;
    if (isFinite(wk)) { var d = new Date(Date.now() + wk * 7 * 864e5); eta = 'Est. delivery ' + d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }
    price.meta.appendChild(metaCard('Build time', isFinite(wk) ? fmt(wk) + ' weeks' : '—', eta, isFinite(wk) ? wk / 52 * 100 : null));
    price.meta.appendChild(metaCard('Insurance group', isFinite(ig) ? fmt(ig) + ' of 50' : '—', isFinite(ig) ? (ig > 40 ? 'Specialist cover required' : ig > 28 ? 'High premium bracket' : ig > 15 ? 'Moderate premiums' : 'Low premiums') : null, isFinite(ig) ? ig / 50 * 100 : null));
  }

  /* -------- issues pane */
  function applyFix(iss) {
    if (!iss || !iss.fix || !iss.fix.patch) return;
    CB.state.patch(iss.fix.patch, { label: 'Fix: ' + (iss.fix.label || iss.message) });
    toast('Applied: ' + (iss.fix.label || 'fix'), 'success');
  }
  /* "Fix all" only ever applies error / warning fixes (info-level notes are suggestions, and merging them can
     undo an error fix — e.g. a "quad turbo" note raising boost after the knock fix changed fuel). Uses the
     severity-ordered resolver in garage.js (errors first, re-validating every pass); local fallback mirrors it. */
  function autoFixable(issues) {
    return (issues || []).filter(function (i) { return i && (i.severity === 'error' || i.severity === 'warning') && i.fix && i.fix.patch; });
  }
  function resolveLocal(b) {
    var applied = [];
    for (var pass = 0; pass < 8; pass++) {
      var issues = compute(b).issues || [];
      var list = issues.filter(function (i) { return i && i.severity === 'error' && i.fix && i.fix.patch; });
      if (!list.length) list = issues.filter(function (i) { return i && i.severity === 'warning' && i.fix && i.fix.patch; });
      if (!list.length) break;
      var merged = {};
      list.forEach(function (i) { merged = U.deepMerge(merged, i.fix.patch); applied.push(i.fix.label || i.id || 'fix'); });
      var next = has('state.normalize') ? CB.state.normalize(U.deepMerge(b, merged), { paths: CB.state.leafPaths ? CB.state.leafPaths(merged) : [], prev: b }) : U.deepMerge(b, merged);
      if (U.equal(next, b)) break;
      b = next;
    }
    return { build: b, applied: applied };
  }
  function applyAllFixes() {
    var b = CB.state.get();
    var res = has('garage.resolveIssues') ? safe(function () { return CB.garage.resolveIssues(b); }, null, 'garage.resolveIssues') : null;
    if (!res || !res.build) res = resolveLocal(b);
    var seen = {};
    (res.applied || []).forEach(function (l) { seen[l] = 1; });
    var fixed = Object.keys(seen).length;
    if (!fixed || U.equal(res.build, b)) { toast('Nothing to fix automatically', 'info'); return; }
    CB.state.replace(res.build, { label: 'Apply ' + fixed + ' fix' + (fixed > 1 ? 'es' : '') });
    toast('Applied ' + fixed + ' automatic fix' + (fixed > 1 ? 'es' : ''), 'success', { action: { label: 'Undo', onClick: function () { CB.state.undo(); } } });
  }

  function updateIssuesPane(bundle) {
    var host = $('issue-list');
    var count = $('issue-count');
    var issues = bundle.issues || [];
    var errors = issues.filter(function (i) { return i.severity === 'error'; });
    var warnings = issues.filter(function (i) { return i.severity === 'warning'; });
    var infos = issues.filter(function (i) { return i.severity !== 'error' && i.severity !== 'warning'; });
    if (count) {
      count.textContent = issues.length ? String(errors.length || warnings.length || infos.length) : '';
      count.className = 'cb-tab-badge' + (errors.length ? ' is-error' : warnings.length ? ' is-warning' : issues.length ? ' is-info' : '');
    }
    if (!host) return;
    var key = JSON.stringify(issues.map(function (i) { return [i.id, i.severity, i.message, i.fix && i.fix.label]; })) + JSON.stringify(bundle.legality);
    if (host._key === key) return;
    host._key = key;
    U.clear(host);

    var leg = bundle.legality;
    var legal = leg ? !!leg.streetLegal : null;
    host.appendChild(el('div', { class: 'legal-card ' + (legal === null ? 'is-unknown' : legal ? 'is-legal' : 'is-track') },
      el('span', { class: 'legal-icon', html: icon(legal === false ? 'warn' : legal ? 'check' : 'info') }),
      el('div', null,
        el('div', { class: 'legal-title' }, legal === null ? 'Legality not assessed' : legal ? 'Street legal' : 'Track use only'),
        el('div', { class: 'cb-hint' }, legal === null ? 'The rules engine is not loaded.' : legal ? 'Meets road-registration requirements as configured.' : 'This build cannot be registered for the road:'),
        leg && !legal && leg.reasons && leg.reasons.length ? el('ul', { class: 'legal-reasons' }, leg.reasons.map(function (r) { return el('li', null, typeof r === 'string' ? r : r.message || String(r)); })) : null)));

    var fixable = autoFixable(issues).length;
    host.appendChild(el('div', { class: 'issues-head' },
      el('div', { class: 'issue-tally' },
        tally(errors.length, 'error', 'errors'), tally(warnings.length, 'warning', 'warnings'), tally(infos.length, 'info', 'notes')),
      fixable ? el('button', { type: 'button', class: 'cb-btn small', onclick: applyAllFixes }, 'Fix ' + fixable + ' automatically') : null));

    if (!issues.length) {
      host.appendChild(el('div', { class: 'cb-issues-empty' }, el('span', { class: 'cb-issue-icon', html: icon('check') }),
        has('rules.validate') ? 'No conflicts. Every component in this build works with every other.' : 'Validation is unavailable.'));
      return;
    }
    [['Errors', 'error', errors, 'Must be resolved before the car can be built.'],
      ['Warnings', 'warning', warnings, 'Buildable, but with compromises worth knowing about.'],
      ['Notes', 'info', infos, 'Observations from the engineering team.']].forEach(function (g) {
      if (!g[2].length) return;
      var groupEl = el('div', { class: 'issue-group is-' + g[1] }, el('div', { class: 'issue-group-head' }, el('span', { class: 'issue-group-name' }, g[0] + ' (' + g[2].length + ')'), el('span', { class: 'cb-hint' }, g[3])));
      g[2].forEach(function (iss) {
        var sev = g[1];
        groupEl.appendChild(el('div', { class: 'cb-issue is-' + sev },
          el('span', { class: 'cb-issue-icon', html: icon(sev === 'warning' ? 'warn' : sev) }),
          el('div', { class: 'cb-issue-body' },
            el('div', { class: 'cb-issue-msg' }, iss.message),
            iss.section ? el('button', { type: 'button', class: 'issue-jump', onclick: function () { goto(iss.section, { focus: true }); } }, 'Open ' + sectionTitle(iss.section)) : null),
          iss.fix && iss.fix.patch ? el('button', { type: 'button', class: 'cb-fix-btn cb-btn', onclick: function () { applyFix(iss); } }, iss.fix.label || 'Fix') : null));
      });
      host.appendChild(groupEl);
    });
  }
  function tally(n, kind, label) {
    return el('span', { class: 'tally is-' + kind + (n ? '' : ' is-zero') }, el('b', null, String(n)), ' ' + (n === 1 ? label.replace(/s$/, '') : label));
  }

  /* -------- summary head */
  function updateSummaryHead(bundle, animate) {
    var t = $('price-total'), total = totalOf(bundle);
    if (t) {
      if (total == null) t.textContent = '—';
      else if (animate && summary.lastTotal != null) animateNumber(t, summary.lastTotal, total, { format: function (v) { return U.fmtMoney(Math.round(v)); } });
      else t.textContent = U.fmtMoney(Math.round(total));
      summary.lastTotal = total;
    }
    var badge = $('legality-badge'), leg = bundle.legality;
    if (badge) {
      var errs = bundle.issues.filter(function (i) { return i.severity === 'error'; }).length;
      if (!leg) { badge.textContent = errs ? errs + ' to resolve' : 'Unchecked'; badge.className = 'cb-badge legality ' + (errs ? 'is-bad' : 'is-dim'); }
      else {
        badge.textContent = leg.streetLegal ? 'Street legal' : 'Track only';
        badge.className = 'cb-badge legality ' + (leg.streetLegal ? 'is-good' : 'is-warn');
        badge.title = leg.streetLegal ? 'Road-registrable as configured' : (leg.reasons || []).map(function (r) { return typeof r === 'string' ? r : r.message; }).join('\n');
      }
      badge.style.cursor = 'pointer';
    }
  }

  function refreshSummary(heavy) {
    if (!lastBundle) return;
    updateSummaryHead(lastBundle, false);
    if (summary.tab === 'perf') { updatePerfPaneCheap(lastBundle); if (heavy) updatePerfCharts(lastBundle); }
    if (summary.tab === 'price') { updatePriceLines(lastBundle); updateFinance(lastBundle); updatePriceMeta(lastBundle); if (heavy && lastBundle.pricing) drawChart('donut', $('summary-donut'), 'priceDonut', [lastBundle.pricing]); }
    else updateFinance(lastBundle);
    updateIssuesPane(lastBundle);
    flushDirtyCharts();
  }

  /* ---------------------------------------------------------------- top bar */
  function initTopbar() {
    var name = $('build-name');
    if (name) {
      var commitName = function () {
        var v = name.value.trim().slice(0, 60) || 'Untitled Build';
        if (v !== CB.state.get().meta.name) CB.state.set('meta.name', v, { label: 'Rename to “' + v + '”' });
        name.value = v;
      };
      name.addEventListener('change', commitName);
      name.addEventListener('blur', commitName);
      name.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); name.blur(); }
        else if (ev.key === 'Escape') { name.value = CB.state.get().meta.name; name.blur(); }
      });
      name.addEventListener('input', function () { name.style.setProperty('--chars', Math.max(8, name.value.length + 1)); });
    }
    on('btn-undo', function () { if (CB.state.undo()) toast('Undone', 'info', { duration: 1400 }); });
    on('btn-redo', function () { if (CB.state.redo()) toast('Redone', 'info', { duration: 1400 }); });
    injectHistoryButton();
    on('btn-theme', function () { setTheme(theme() === 'light' ? 'dark' : 'light'); });
    on('btn-garage', function () { openGarage('openSaved'); });
    on('btn-compare', function () { openGarage('openCompare'); });
    on('btn-share', function () { openGarage('openShare'); });
    on('btn-spec', function () { openGarage('openSpec'); });
    on('btn-presets', function () { openGarage('openPresets'); });
    var badge = $('legality-badge');
    if (badge) badge.addEventListener('click', function () { if (summary.selectTab) summary.selectTab('issues'); });
    injectExtraButtons();
  }
  function on(id, fn) { var n = $(id); if (n) n.addEventListener('click', fn); return n; }

  function openGarage(fn) {
    if (CB.garage && typeof CB.garage[fn] === 'function') return safe(function () { return CB.garage[fn](); }, null, 'garage.' + fn);
    warnOnce('garage-' + fn, 'CB.garage.' + fn + ' missing.');
    toast('This feature is not available in this build of the Garage.', 'warning');
  }

  function raceAvailable() { return !!(CB.race && CB.race.ui && typeof CB.race.ui.open === 'function'); }
  /**
   * drive(discipline 'race' | 'drift', opts?) — take the configurator's current build (CB.state) out on track.
   * Unified game: routes to #/race or #/drift (CB.race.ui mounts its setup there, heavy steering assist by default).
   * A career purchase / upgrade session test-drives in an overlay on top of the Atelier instead, so the session survives.
   */
  function drive(discipline, opts) {
    opts = opts || {};
    discipline = discipline === 'drift' ? 'drift' : 'race';
    if (!raceAvailable()) {
      if (routedActive()) { CB.router.go(discipline); return; }
      toast('Race mode is not loaded on this page.', 'warning'); return;
    }
    closePop();
    var b = CB.state.get();
    if (onAtelierRoute()) {
      var errs = compute(b).issues.filter(function (i) { return i.severity === 'error'; });
      if (errs.length) toast('Heads up: ' + errs.length + ' unresolved error' + (errs.length > 1 ? 's' : '') + ' in this build.', 'warning');
    }
    var sessionMode = atelierMode();
    var launch = { settings: { discipline: discipline }, discipline: discipline };
    if (opts.quick) launch.autoStart = true;
    if (sessionMode && sessionMode !== 'free') { launch.overlay = true; launch.backLabel = 'Back to Garage'; }
    safe(function () {
      CB.race.ui.open(b, launch, { onFinish: function (results) { recordFreeRace(results, sessionMode); } });
    }, null, 'race.ui.open');
  }
  function openRace() { drive('race'); }
  /** The Atelier's "Drive it" call to action: Race or Drift with this exact build. */
  function openDriveMenu(anchor) {
    if (!anchor) { drive('race'); return; }
    popover(anchor, [
      { label: 'Race', hint: 'R · grid race, 3D', icon: 'check', run: function () { drive('race'); } },
      { label: 'Drift', hint: 'D · scored drift run, 3D', icon: 'spark', run: function () { drive('drift'); } }
    ], 'menu-pop drive-pop');
  }

  /** A race started from the Atelier (Free Build) still counts towards the driver's record and achievements;
      it pays no purse (that is reserved for hub events). Career purchase / upgrade sessions are test drives
      of a car the player does not own yet, so they are not recorded. */
  var handledResults = [];   // results objects already seen by recordFreeRace (callback + cb:race-finished share one object)
  function seenResults(results) { return handledResults.indexOf(results) >= 0; }
  function recordFreeRace(results, sessionMode) {
    if (!results || typeof results !== 'object' || seenResults(results)) return;
    handledResults.push(results);
    if (handledResults.length > 40) handledResults.shift();
    if (sessionMode && sessionMode !== 'free') return;
    var settings = results.settings || {};
    var config = { mode: results.mode || settings.mode || 'race', trackId: results.trackId || settings.trackId || null, laps: settings.laps,
      difficulty: settings.difficulty, opponents: settings.opponents, fieldSize: results.fieldSize, freeBuild: true, eventType: 'free-build' };
    if (has('game.profile.recordRaceStats')) safe(function () { CB.game.profile.recordRaceStats(results, config); }, null, 'profile.recordRaceStats');
    if (has('game.achievements.check')) {
      safe(function () {
        CB.game.achievements.check(null, { type: 'race-finished', results: results, config: config });
        var p = profileNow();
        if (p && p.stats) CB.game.achievements.check(null, { type: 'stat', stats: p.stats });
      }, null, 'achievements.check');
    }
  }

  /** Does a launcher own this session's result? Career / hub / challenge launches (a context kind, a launch lock,
      career or challenge data on the results) and any session opened with an onFinish callback (CB.app.drive()
      included) record their own results. Only sessions with no owner — #/race or #/drift opened by URL, bookmark,
      refresh or a race.html / drift.html redirect — fall through to the Atelier's free-race recording. */
  function ownedSession(results) {
    if (!results || typeof results !== 'object') return true;
    if (results.career || results.challenge || results.challengeResult || results.launchSettings) return true;
    var ui = CB.race && CB.race.ui;
    var st = ui && ui._dev && typeof ui._dev.state === 'function' ? safe(function () { return ui._dev.state(); }, null, 'race.ui state') : null;
    var o = st && st.opts;
    if (o && (typeof o.onFinish === 'function' || (o.context && o.context.kind) || o.career || o.challenge)) return true;
    return false;
  }
  /** 'cb:race-finished' listener: records free sessions nobody else claimed (B1). Returns true when it recorded. */
  function onRaceFinished(e) {
    var d = e && e.detail;
    var results = d && (d.results || d);
    if (!results || typeof results !== 'object' || seenResults(results) || ownedSession(results)) return false;
    var mode = atelierMode();
    if (mode && mode !== 'free') return false;   // a career purchase / upgrade test drive is never recorded
    recordFreeRace(results, null);
    return true;
  }

  function hubAvailable() { return !!(CB.game && CB.game.hub && typeof CB.game.hub.open === 'function'); }
  function openHub(screen) {
    if (routedActive()) {
      if (atelierSession && atelierSession.mode !== 'free') { toast('Confirm or cancel the current career session first.', 'info'); return; }
      closePop();
      CB.router.go(typeof screen === 'string' && screen ? screen : 'menu');
      return;
    }
    if (!hubAvailable()) { toast('The career hub is not loaded on this page.', 'warning'); return; }
    if (atelierSession && atelierSession.mode !== 'free') { toast('Confirm or cancel the current career session first.', 'info'); return; }
    if (atelierSession) atelierSession.finish('close');   // Free Build hands back to the hub (which un-parks itself)
    closePop();
    var o = typeof screen === 'string' ? { screen: screen } : { screen: 'menu' };
    safe(function () { CB.game.hub.open(o); }, null, 'hub.open');
  }

  function injectExtraButtons() {
    var actions = document.querySelector('.topbar-actions');
    if (!actions) return;
    // Race (only when race mode is present). index.html ships #btn-race hidden; create it if a host page lacks it.
    var race = $('btn-race');
    if (!race && raceAvailable()) {
      race = el('button', { id: 'btn-race', type: 'button', class: 'cb-btn race-btn', title: 'Race this build (R)' }, 'Race');
      actions.insertBefore(race, $('btn-share') || null);
    }
    if (race) {
      race.hidden = !raceAvailable();
      if (routed()) race.hidden = false;   // "Drive it" offers Race / Drift (an unavailable mode explains itself)
      if (!race.dataset.cbBound) {
        race.dataset.cbBound = '1';
        race.addEventListener('click', function (ev) { if (routed()) { ev.stopPropagation(); openDriveMenu(race); } else openRace(); });
      }
    }
    // Career hub (only when the game hub is present)
    var hub = $('btn-hub');
    if (!hub && hubAvailable()) {
      hub = el('button', { id: 'btn-hub', type: 'button', class: 'cb-btn ghost', title: 'Career hub (H)' }, 'Career');
      actions.insertBefore(hub, race || $('btn-share') || null);
    }
    if (hub) {
      hub.hidden = !hubAvailable();
      if (!hub.dataset.cbBound) { hub.dataset.cbBound = '1'; hub.addEventListener('click', function () { openHub('career'); }); }
    }
    // Game menu: back to the hub's main menu (title screen → menu flow of index.html)
    var menu = $('btn-menu');
    if (!menu && hubAvailable()) {
      menu = el('button', { id: 'btn-menu', type: 'button', class: 'cb-btn ghost menu-btn', title: 'Main menu: career, races, my cars (M)',
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg><span>Menu</span>' });
      var brand = document.querySelector('#topbar .brand');
      if (brand && brand.parentNode) brand.parentNode.insertBefore(menu, brand.nextSibling);
    }
    if (menu) {
      menu.hidden = !hubAvailable();
      if (!menu.dataset.cbBound) { menu.dataset.cbBound = '1'; menu.addEventListener('click', function () { openHub('menu'); }); }
    }

    // Overflow "More" menu
    var more = el('button', { id: 'btn-more', type: 'button', class: 'cb-btn ghost icon-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'More actions', 'aria-label': 'More actions',
      html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>' });
    var themeBtn = $('btn-theme');
    actions.insertBefore(more, themeBtn || null);
    more.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var items = [
        { label: 'Surprise me', hint: 'Random, valid build', icon: 'spark', run: function () { openGarage('surprise'); } },
        { label: 'Save build', hint: 'Ctrl/⌘ S', icon: 'check', run: function () { if (CB.garage && CB.garage.save) CB.garage.save(); else { CB.state.saveLocal(); toast('Build saved', 'success'); } } },
        { label: 'New build', hint: 'Start from the default car', icon: 'reset', run: newBuild },
        { sep: true },
        { label: 'Export JSON', hint: 'Download this build', run: function () { openGarage('exportJSON'); } },
        { label: 'Import JSON', hint: 'Load a build file', run: function () { openGarage('importJSON'); } },
        { sep: true },
        raceAvailable() ? { label: 'Race this build', hint: 'R', run: openRace } : null,
        raceAvailable() && routed() ? { label: 'Drift this build', hint: 'D', run: function () { drive('drift'); } } : null,
        hubAvailable() ? { label: 'Main menu', hint: 'M', run: function () { openHub('menu'); } } : null,
        hubAvailable() ? { label: 'Career hub', hint: 'H', run: function () { openHub('career'); } } : null,
        has('game.achievements.openGallery') ? { label: 'Achievements', hint: 'Medals and milestones', run: function () { safe(function () { CB.game.achievements.openGallery(); }, null, 'achievements.openGallery'); } } : null,
        { label: 'Keyboard shortcuts', hint: '?', run: showShortcuts }
      ].filter(Boolean);
      popover(more, items, 'menu-pop');
    });
  }

  function newBuild() {
    var go = function () {
      CB.state.reset({ label: 'New build' });
      toast('Started a new build', 'info', { action: { label: 'Undo', onClick: function () { CB.state.undo(); } } });
    };
    if (CB.ui && CB.ui.confirm) CB.ui.confirm({ title: 'Start a new build?', message: 'Your current configuration stays in the undo history, and you can save it to your saved builds first.', okLabel: 'Start new build' }).then(function (ok) { if (ok) go(); });
    else go();
  }

  /* -------- popovers (history + more menu) */
  var openPop = null;
  function closePop() {
    if (!openPop) return;
    var p = openPop; openPop = null;
    if (p.anchor) p.anchor.setAttribute('aria-expanded', 'false');
    p.node.classList.add('is-leaving');
    setTimeout(function () { if (p.node.parentNode) p.node.parentNode.removeChild(p.node); }, 160);
  }
  function popover(anchor, items, cls) {
    if (openPop && openPop.anchor === anchor) { closePop(); return; }
    closePop();
    var node = el('div', { class: 'pop ' + (cls || ''), role: 'menu' });
    items.forEach(function (it) {
      if (it.sep) { node.appendChild(el('div', { class: 'pop-sep', role: 'separator' })); return; }
      if (it.header) { node.appendChild(el('div', { class: 'pop-header' }, it.header)); return; }
      var b = el('button', { type: 'button', class: 'pop-item' + (it.cls ? ' ' + it.cls : ''), role: 'menuitem', disabled: it.disabled },
        it.icon ? el('span', { class: 'pop-icon', html: icon(it.icon) }) : null,
        el('span', { class: 'pop-label' }, it.label), it.hint ? el('span', { class: 'pop-hint' }, it.hint) : null);
      b.addEventListener('click', function () { closePop(); it.run(); });
      node.appendChild(b);
    });
    document.body.appendChild(node);
    var r = anchor.getBoundingClientRect();
    var w = node.offsetWidth;
    var left = Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w));
    if (cls === 'history-pop') left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left));
    node.style.left = left + 'px';
    node.style.top = (r.bottom + 6) + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    openPop = { node: node, anchor: anchor };
    // focus the first item right away (rAF is paused in background tabs / script-opened menus), so the menu's keys work
    // however it was opened; the Atelier's global R / D shortcuts still apply while it is open.
    var f0 = node.querySelector('.pop-item:not([disabled])'); if (f0) { try { f0.focus({ preventScroll: true }); } catch (e) { f0.focus(); } }
    requestAnimationFrame(function () { node.classList.add('is-open'); var f = node.querySelector('.pop-item:not([disabled])'); if (f && !node.contains(document.activeElement)) f.focus(); });
    node.addEventListener('keydown', function (ev) {
      var list = Array.prototype.slice.call(node.querySelectorAll('.pop-item:not([disabled])'));
      var i = list.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); (list[i + 1] || list[0]).focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); (list[i - 1] || list[list.length - 1]).focus(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closePop(); anchor.focus(); }
      else if (ev.key === 'Tab') closePop();
    });
  }
  document.addEventListener('mousedown', function (ev) { if (openPop && !openPop.node.contains(ev.target) && ev.target !== openPop.anchor && !openPop.anchor.contains(ev.target)) closePop(); });
  window.addEventListener('resize', closePop);

  function injectHistoryButton() {
    var redo = $('btn-redo');
    if (!redo || $('btn-history')) return;
    var btn = el('button', { id: 'btn-history', type: 'button', class: 'cb-btn ghost icon-btn history-btn', title: 'History', 'aria-label': 'Change history', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>' });
    redo.parentNode.insertBefore(btn, redo.nextSibling);
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var d = has('state.historyDetail') ? CB.state.historyDetail() : { past: CB.state.history().map(function (l) { return { label: l }; }), future: [] };
      var items = [];
      if (d.future.length) {
        items.push({ header: 'Redo' });
        d.future.slice().reverse().slice(0, 12).forEach(function (h, i, arr) {
          var steps = arr.length - i;
          items.push({ label: h.label || 'Change', hint: ago(h.time), cls: 'is-future', run: function () { for (var k = 0; k < steps; k++) CB.state.redo(); } });
        });
        items.push({ sep: true });
      }
      items.push({ header: 'Current: ' + (CB.state.get().meta.name || 'Untitled') });
      if (!d.past.length) items.push({ label: 'No changes yet', disabled: true, run: function () {} });
      d.past.slice().reverse().slice(0, 30).forEach(function (h, i) {
        var steps = i + 1;
        items.push({ label: h.label || 'Change', hint: ago(h.time), run: function () { for (var k = 0; k < steps; k++) CB.state.undo(); toast('Reverted ' + steps + ' step' + (steps > 1 ? 's' : ''), 'info', { duration: 1600 }); } });
      });
      if (d.past.length > 30) items.push({ label: '+' + (d.past.length - 30) + ' older steps', disabled: true, run: function () {} });
      popover(btn, items, 'history-pop');
    });
  }
  function ago(t) {
    if (!t) return '';
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    return Math.round(s / 3600) + ' h ago';
  }

  function updateTopbar(build, change) {
    var u = $('btn-undo'), r = $('btn-redo');
    if (u) { u.disabled = !CB.state.canUndo(); var h = CB.state.history(); u.title = h.length ? 'Undo ' + h[h.length - 1] + ' (Ctrl/⌘ Z)' : 'Nothing to undo'; }
    if (r) {
      r.disabled = !CB.state.canRedo();
      var hd = has('state.historyDetail') ? CB.state.historyDetail().future : [];
      r.title = hd.length ? 'Redo ' + hd[0].label + ' (Ctrl/⌘ Shift Z)' : 'Nothing to redo';
    }
    var hb = $('btn-history');
    if (hb) hb.disabled = !CB.state.canUndo() && !CB.state.canRedo();
    var name = $('build-name');
    if (name && document.activeElement !== name && name.value !== build.meta.name) { name.value = build.meta.name; name.style.setProperty('--chars', Math.max(8, name.value.length + 1)); }
    syncTitle(build);
    if (change && change.type !== 'boot') setStatus('Autosaving…', 'busy');
  }
  /** Tab title: the build name only while the Atelier is on screen; every other routed screen reads 'Redline — <Label>'. */
  function syncTitle(build) {
    if (typeof document === 'undefined') return;
    var cur = routed() ? safe(function () { return CB.router.current(); }, null) : null;
    if (cur && cur.route && cur.route !== 'atelier') {
      var labels = (CB.router && CB.router.labels) || {};
      var lbl = labels[cur.route] || (cur.route.charAt(0).toUpperCase() + cur.route.slice(1));
      document.title = 'Redline — ' + lbl;
      return;
    }
    var b = build || (CB.state && typeof CB.state.get === 'function' ? safe(function () { return CB.state.get(); }, null) : null);
    var nm = b && b.meta && b.meta.name;
    document.title = (nm || 'Untitled Build') + ' — Redline Garage';
  }
  var statusTimer = null;
  function setStatus(text, kind) {
    var s = $('build-status');
    if (!s) return;
    s.textContent = text;
    s.className = 'build-status' + (kind ? ' is-' + kind : '');
    clearTimeout(statusTimer);
    if (kind === 'busy') statusTimer = setTimeout(function () { setStatus('Saved on this device', 'ok'); }, 700);
  }

  /* -------- viewer controls */
  var view = U.deepMerge({ view: 'side', xray: false, spin: false }, lsGet(LS_VIEW, {}) || {});
  var viewOrbit = false;   // the 3D studio turntable / a drag has moved the camera off the chosen view
  function paintViewButtons() {
    ['side', 'front', 'rear', 'top'].forEach(function (k) {
      var b = $('view-' + k), on = !viewOrbit && k === view.view;
      if (b) { b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    });
    var viewer = $('viewer');   // #viewer::before reads "Studio · Orbit" while .is-orbit (css)
    if (viewer) viewer.classList.toggle('is-orbit', viewOrbit);
  }
  function setViewOrbit(on) {
    on = !!on;
    if (on === viewOrbit) return;
    viewOrbit = on;
    paintViewButtons();
  }
  function setView(v) {
    if (['side', 'front', 'rear', 'top'].indexOf(v) < 0) v = 'side';
    view.view = v; lsSet(LS_VIEW, view);
    viewOrbit = false;      // pressing a view snaps the camera back: the label is honest again at once
    paintViewButtons();
    var viewer = $('viewer');
    if (viewer) viewer.dataset.view = v;
    if (has('render.setView')) safe(function () { CB.render.setView(v); }, null, 'render.setView');
  }
  function toggleXray(force) {
    view.xray = typeof force === 'boolean' ? force : !view.xray; lsSet(LS_VIEW, view);
    var b = $('btn-xray');
    if (b) { b.classList.toggle('is-active', view.xray); b.setAttribute('aria-pressed', view.xray ? 'true' : 'false'); }
    var viewer = $('viewer'); if (viewer) viewer.classList.toggle('is-xray', view.xray);
    if (has('render.toggleXray')) safe(function () { CB.render.toggleXray(view.xray); }, null, 'render.toggleXray');
    return view.xray;
  }
  function toggleSpin(force) {
    view.spin = typeof force === 'boolean' ? force : !view.spin; lsSet(LS_VIEW, view);
    var b = $('btn-spin');
    if (b) { b.classList.toggle('is-active', view.spin); b.setAttribute('aria-pressed', view.spin ? 'true' : 'false'); }
    var viewer = $('viewer'); if (viewer) viewer.classList.toggle('is-spinning', view.spin);
    var R = CB.render || {};
    var fn = R.toggleSpin || R.setSpin || R.spin || R.toggleSpinning;
    if (typeof fn === 'function') safe(function () { fn.call(R, view.spin); }, null, 'render spin');
    else warnOnce('spin', 'CB.render has no toggleSpin/setSpin — spin toggles a CSS class on #viewer only.');
    return view.spin;
  }
  function initViewer() {
    ['side', 'front', 'rear', 'top'].forEach(function (k) { on('view-' + k, function () { setView(k); }); });
    window.addEventListener('cb:studio-orbit', function (e) { setViewOrbit(!!(e && e.detail && e.detail.orbit)); });
    on('btn-xray', function () { toggleXray(); });
    on('btn-spin', function () { toggleSpin(); });
    var mount = $('car-mount');
    if (mount && has('render.mount')) {
      safe(function () { CB.render.mount(mount); }, null, 'render.mount');
    } else if (mount) {
      warnOnce('render', 'CB.render missing — the visualiser is disabled.');
      mount.appendChild(el('div', { class: 'viewer-fallback' }, el('span', { html: icon('body') }), el('span', null, 'The visualiser is not loaded.')));
    }
    setView(view.view);
    if (view.xray) toggleXray(true);
    if (view.spin) toggleSpin(true);
  }

  /* ---------------------------------------------------------------- keyboard */
  var SHORTCUTS = [
    ['Ctrl/⌘ Z', 'Undo'], ['Ctrl/⌘ Shift Z', 'Redo (also Ctrl Y)'], ['1 – 9', 'Jump to section'],
    ['[  ]', 'Previous / next section'], ['X', 'Toggle x-ray view'], ['S', 'Toggle wheel spin'],
    ['V', 'Cycle camera: side, front, rear, top'], ['T', 'Toggle light / dark theme'],
    ['P', 'Presets gallery'], ['G', 'Saved builds'], ['C', 'Compare builds'], ['Ctrl/⌘ S', 'Save build'],
    ['Ctrl/⌘ P', 'Spec sheet'], ['R', 'Race this build (when race mode is loaded)'], ['D', 'Drift this build'], ['H', 'Career hub (when the game is loaded)'], ['M', 'Main menu (title screen, career, my cars)'], ['?', 'This help'], ['Esc', 'Close dialogs and menus']
  ];
  function showShortcuts() {
    if (!CB.ui || !CB.ui.modal) return;
    CB.ui.modal({
      title: 'Keyboard shortcuts', subtitle: 'Single-key shortcuts are ignored while you type in a field.', size: 'sm',
      content: el('dl', { class: 'shortcut-list' }, SHORTCUTS.map(function (s) {
        return el('div', { class: 'shortcut-row' }, el('dt', null, s[0].split(' ').map(function (k) { return el('kbd', null, k); })), el('dd', null, s[1]));
      })),
      actions: [{ label: 'Close', kind: 'primary' }]
    });
  }
  function isTyping(t) {
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select' || t.isContentEditable) return true;
    if (tag === 'input') return ['range', 'checkbox', 'radio', 'button', 'color'].indexOf((t.type || '').toLowerCase()) < 0;
    return false;
  }
  /** True when a full-screen overlay (race / hub) is present AND actually shown (the hub hides itself during Atelier sessions). */
  function overlayVisible(id) {
    var n = document.getElementById(id);
    if (!n || n.hidden) return false;
    var cs = safe(function () { return getComputedStyle(n); }, null);
    return !cs || (cs.display !== 'none' && cs.visibility !== 'hidden');
  }
  function onKey(ev) {
    if (ev.defaultPrevented) return;
    var mod = ev.metaKey || ev.ctrlKey;
    var typing = isTyping(ev.target);
    var modalOpen = document.documentElement.classList.contains('cb-modal-open') || overlayVisible('race-root') || overlayVisible('game-hub');
    var k = ev.key;
    if (mod && !ev.altKey) {
      var lk = String(k).toLowerCase();
      if (lk === 'z' && !typing && !modalOpen) { ev.preventDefault(); if (ev.shiftKey) CB.state.redo(); else CB.state.undo(); return; }
      if (lk === 'y' && !typing && !modalOpen) { ev.preventDefault(); CB.state.redo(); return; }
      if (lk === 's' && !modalOpen) { ev.preventDefault(); if (CB.garage && CB.garage.save) CB.garage.save(); return; }
      if (lk === 'p' && !modalOpen && CB.garage && CB.garage.openSpec) { ev.preventDefault(); CB.garage.openSpec(); return; }
      return;
    }
    if (typing || modalOpen || ev.altKey) return;
    if (!onAtelierRoute()) return;   // another router screen (menu, career, race...) owns the keyboard
    if (k === 'Escape') { closePop(); return; }
    if (/^[1-9]$/.test(k)) {
      var ids = orderedIds(), i = Number(k) - 1;
      if (ids[i]) { ev.preventDefault(); goto(ids[i]); }
      return;
    }
    switch (k) {
      case '?': ev.preventDefault(); showShortcuts(); break;
      case 'x': case 'X': ev.preventDefault(); toast('X-ray ' + (toggleXray() ? 'on' : 'off'), 'info', { duration: 1200 }); break;
      case 's': case 'S': ev.preventDefault(); toast('Wheel spin ' + (toggleSpin() ? 'on' : 'off'), 'info', { duration: 1200 }); break;
      case 'v': case 'V': {
        var vs = ['side', 'front', 'rear', 'top'];
        ev.preventDefault(); setView(vs[(vs.indexOf(view.view) + 1) % vs.length]); break;
      }
      case 't': case 'T': ev.preventDefault(); setTheme(theme() === 'light' ? 'dark' : 'light'); break;
      case '[': ev.preventDefault(); step(-1); break;
      case ']': ev.preventDefault(); step(1); break;
      case 'p': case 'P': ev.preventDefault(); openGarage('openPresets'); break;
      case 'g': case 'G': ev.preventDefault(); openGarage('openSaved'); break;
      case 'c': case 'C': ev.preventDefault(); openGarage('openCompare'); break;
      case 'r': case 'R': if (raceAvailable()) { ev.preventDefault(); openRace(); } break;
      case 'd': case 'D': if (raceAvailable() && routed()) { ev.preventDefault(); drive('drift'); } break;
      case 'h': case 'H': if (hubAvailable()) { ev.preventDefault(); openHub('career'); } break;
      case 'm': case 'M': if (hubAvailable()) { ev.preventDefault(); openHub('menu'); } break;
      default: break;
    }
  }

  /* ---------------------------------------------------------------- frame loop */
  var pending = null;       // latest change (merged)
  var rafId = 0;
  var heavyTimer = null;
  var booted = false;

  function scheduleFrame(change) {
    pending = mergeChange(pending, change);
    if (rafId || frameTimer) return;
    // rAF is paused in background / hidden tabs (and throttled in some embedders), so race it against a
    // timer: whichever fires first renders the frame, the other is cancelled. Keeps tabs opened in the
    // background (or via window.open) fully populated when the user switches to them.
    if (typeof requestAnimationFrame === 'function' && !document.hidden) rafId = requestAnimationFrame(frame);
    frameTimer = setTimeout(frame, document.hidden ? 0 : 120);
  }

  /* Coalesce changes queued before one frame. A passive 'refresh' (route entry, tab re-shown) must never mask a
     pending 'boot' or user edit — otherwise frame() would see type 'refresh' and treat the default build as
     a user commission (free achievements on page load). */
  var USER_EDIT = /^(set|patch|replace|undo|redo)$/;
  function isUserEdit(change) { return !!change && USER_EDIT.test(change.type || ''); }
  function mergeChange(prev, change) {
    if (!change) change = { path: '*', type: 'refresh' };
    if (!prev) return change;
    var passive = function (c) { return c.type === 'boot' || c.type === 'refresh' || !c.type; };
    // which type wins: a user edit beats everything; boot beats refresh
    var type = isUserEdit(change) ? change.type : isUserEdit(prev) ? prev.type
      : (prev.type === 'boot' || change.type === 'boot') ? 'boot' : change.type;
    var label = isUserEdit(change) || !isUserEdit(prev) ? change.label : prev.label;
    if (change.path === prev.path && change.type === type && !passive(change)) return change;
    if (change.path === prev.path && change.path !== '*' && type === change.type) return change;
    return { path: '*', type: type, label: label, paths: ['*'] };
  }

  var frameTimer = null;
  function frame() {
    if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = 0;
    clearTimeout(frameTimer); frameTimer = null;
    var change = pending || { path: '*' };
    pending = null;
    var build = CB.state.get();
    var bundle = compute(build);
    lastBundle = bundle;
    if (has('render.update')) safe(function () { CB.render.update(build, bundle.metrics); }, null, 'render.update');
    updateActivePanel(build, bundle.metrics, change);
    updatePerfStrip(bundle, change.type !== 'boot');
    updateNavBadges(bundle.issues);
    updateTopbar(build, change);
    updateSummaryHead(bundle, change.type !== 'boot');
    if (summary.tab === 'perf') updatePerfPaneCheap(bundle);
    updateIssuesPane(bundle);
    summaryDirty = true;
    scheduleHeavy();
    if (isUserEdit(change)) scheduleAchievements(bundle);
    if (atelierSession && atelierSession.refresh) safe(function () { atelierSession.refresh(build); }, null, 'atelier banner');
    // cross-module hook for anything else that wants the shared bundle
    safe(function () { document.dispatchEvent(new CustomEvent('cb:frame', { detail: { build: build, metrics: bundle.metrics, pricing: bundle.pricing, issues: bundle.issues, change: change } })); });
  }

  /* Achievements: evaluated on settled builds (debounced) with the shared metrics + pricing bundle. */
  var achTimer = null;
  function scheduleAchievements(bundle) {
    if (!has('game.achievements.check')) return;
    clearTimeout(achTimer);
    achTimer = setTimeout(function () {
      var b = CB.state.get(), cb = compute(b);
      safe(function () {
        CB.game.achievements.check(null, { type: 'build-changed', build: b, metrics: cb.metrics, pricing: cb.pricing });
      }, null, 'achievements.check');
    }, 900);
  }

  function scheduleHeavy() {
    clearTimeout(heavyTimer);
    heavyTimer = setTimeout(function () {
      if (!summaryDirty) return;
      summaryDirty = false;
      refreshSummary(true);
    }, 110);
  }

  /* ---------------------------------------------------------------- atelier hook (career hub) */
  var atelierSession = null;
  function eco() { return CB.game && CB.game.economy ? CB.game.economy : null; }
  function profileNow() { return has('game.profile.get') ? safe(function () { return CB.game.profile.get(); }, null, 'profile.get') : null; }
  function fmtCr(n) { return (n < 0 ? '−' : '') + U.fmtNum(Math.abs(Math.round(num(n))), 0) + ' cr'; }

  /**
   * Career quote for the current session build.
   *   career-buy:     price = economy.carCost(build)
   *   career-upgrade: price = economy.upgradeCost(before, build)  (negative = net refund)
   * opts.quote(build, before) may override → {credits, label?, lines?}
   */
  function careerQuote(s, build) {
    var o = s.opts, E = eco(), prof = profileNow(), q = { credits: 0, label: '', lines: [], violations: [], balance: prof ? num(prof.credits) : null };
    if (typeof o.quote === 'function') {
      var oq = safe(function () { return o.quote(build, s.before); }, null, 'atelier quote');
      if (oq) { q.credits = num(oq.credits); q.label = oq.label || ''; q.lines = oq.lines || []; }
    } else if (E && s.mode === 'career-buy' && typeof E.carCost === 'function') {
      q.credits = num(safe(function () { return E.carCost(build); }, 0, 'economy.carCost'));
      q.label = 'Purchase price';
    } else if (E && s.mode === 'career-upgrade') {
      var ucar = prof && Array.isArray(prof.ownedCars) && o.carId != null ? prof.ownedCars.filter(function (c) { return c && c.id === o.carId; })[0] : null;
      var uq = typeof E.upgradeQuote === 'function' ? safe(function () { return E.upgradeQuote(s.before, build, ucar ? { car: ucar } : undefined); }, null, 'economy.upgradeQuote') : null;
      if (uq) { q.credits = num(uq.total); q.lines = Array.isArray(uq.lines) ? uq.lines : []; }
      else if (typeof E.upgradeCost === 'function') q.credits = num(safe(function () { return E.upgradeCost(s.before, build); }, 0, 'economy.upgradeCost'));
      q.label = q.credits < 0 ? 'Net refund' : 'Upgrade cost';
    }
    if (E && prof && typeof E.buildLockViolations === 'function' && o.ignoreLocks !== true) {
      q.violations = safe(function () { return E.buildLockViolations(prof, build) || []; }, [], 'economy.buildLockViolations');
    }
    q.affordable = q.balance == null || q.credits <= q.balance;
    return q;
  }

  /**
   * openAtelier({mode:'free'|'career-buy'|'career-upgrade', carId?, build?, message?, quote?(build, before),
   *              ignoreLocks?, onConfirm(build, quote), onCancel(), onClose(kind, build)})
   * Brings the configurator to the front (the hub hides itself) and shows a context banner with
   * confirm / cancel actions appropriate to the mode. Career modes show a live credits quote, the
   * player's balance and any parts still locked at their level; Confirm is gated on both.
   */
  /* Self-contained styles for the career-session banner (styles.css may override; it loads first, so these use :where() for zero specificity). */
  function injectAtelierStyles() {
    if ($('app-atelier-styles')) return;
    var css = [
      ':where(.atelier-banner){position:sticky;top:0;z-index:30;display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:10px 18px;',
      'padding:12px 18px;margin:0 0 10px;border:1px solid var(--line,#2a2a2e);border-radius:var(--radius,12px);',
      'background:linear-gradient(100deg,color-mix(in srgb,var(--accent,#c9a96e) 16%,var(--panel,#141417)),var(--panel,#141417) 60%);box-shadow:var(--shadow,0 8px 30px rgba(0,0,0,.35))}',
      ':where(.atelier-banner-text){display:flex;flex-direction:column;gap:2px;min-width:0}',
      ':where(.atelier-banner-text strong){font-size:15px;letter-spacing:.02em;color:var(--text,#eee)}',
      ':where(.atelier-quote){display:flex;flex-direction:column;align-items:flex-end;gap:2px;font-family:var(--mono,ui-monospace,monospace);font-variant-numeric:tabular-nums}',
      ':where(.atelier-quote-main){display:flex;align-items:baseline;gap:8px}',
      ':where(.atelier-quote-value){font-size:20px;font-weight:700;color:var(--accent,#c9a96e)}',
      ':where(.atelier-quote-value.is-credit){color:var(--good,#4caf7a)}',
      ':where(.atelier-quote-sub.is-bad){color:var(--bad,#e5484d)}',
      ':where(.atelier-banner-actions){display:flex;gap:8px}',
      ':where(.atelier-locks){grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding-top:8px;border-top:1px dashed var(--line,#2a2a2e);color:var(--warn,#e0a63b);font-size:13px}',
      ':where(.atelier-locks[hidden]){display:none}',
      ':where(.atelier-locks-head){display:inline-flex;align-items:center;gap:6px;font-weight:600}',
      ':where(.atelier-locks-head svg){width:14px;height:14px}',
      ':where(.atelier-lock-list){display:flex;flex-wrap:wrap;gap:4px 10px;margin:0;padding:0;list-style:none}',
      ':where(.atelier-lock-list .issue-jump){background:none;border:0;padding:0;color:inherit;text-decoration:underline dotted;cursor:pointer;font:inherit}',
      '@media (max-width:900px){:where(.atelier-banner){grid-template-columns:1fr}:where(.atelier-quote){align-items:flex-start}}'
    ].join('\n');
    document.head.appendChild(el('style', { id: 'app-atelier-styles' }, css));
  }

  function openAtelier(opts) {
    opts = opts || {};
    injectAtelierStyles();
    closeAtelier(true);
    closePop();
    var mode = opts.mode === 'career-buy' || opts.mode === 'career-upgrade' ? opts.mode : 'free';
    var preSession = CB.state.get();
    if (opts.build) CB.state.replace(opts.build, { label: mode === 'career-upgrade' ? 'Open car for upgrade' : mode === 'career-buy' ? 'New career car' : 'Open car' });
    var before = CB.state.get();
    var stage = $('stage') || document.body;
    var titles = {
      'free': ['Free build', 'Design without limits. Your build is kept when you return.'],
      'career-buy': ['Buying a new car', 'Configure it, then confirm the purchase. Cancelling discards these changes.'],
      'career-upgrade': ['Upgrading your car', 'Changes are priced as an upgrade: new parts at career prices, removed parts refunded at 50%.']
    };
    var t = titles[mode];
    var quoteEl = el('div', { class: 'atelier-quote', 'aria-live': 'polite' });
    var lockEl = el('div', { class: 'atelier-locks', hidden: true });
    var confirmBtn = mode === 'free' ? null
      : el('button', { type: 'button', class: 'cb-btn primary', onclick: function () { finish('confirm'); } }, mode === 'career-buy' ? 'Confirm purchase' : 'Confirm upgrade');
    var banner = el('div', { class: 'atelier-banner is-' + mode, role: 'region', 'aria-label': t[0] },
      el('div', { class: 'atelier-banner-text' }, el('strong', null, t[0]), el('span', { class: 'cb-hint' }, opts.message || t[1])),
      mode === 'free' ? null : quoteEl,
      el('div', { class: 'atelier-banner-actions' },
        mode === 'free'
          ? el('button', { type: 'button', class: 'cb-btn primary', onclick: function () { finish('close'); } }, 'Back to career')
          : [el('button', { type: 'button', class: 'cb-btn ghost', onclick: function () { finish('cancel'); } }, 'Cancel'), confirmBtn]),
      lockEl);
    stage.insertBefore(banner, stage.firstChild);
    document.documentElement.setAttribute('data-atelier-mode', mode);

    var s = { opts: opts, mode: mode, banner: banner, before: before, preSession: preSession, quote: null };
    s.refresh = function (build) {
      if (mode === 'free') return;
      var q = careerQuote(s, build || CB.state.get());
      s.quote = q;
      U.clear(quoteEl);
      quoteEl.appendChild(el('div', { class: 'atelier-quote-main' },
        el('span', { class: 'cb-label' }, q.label || 'Price'),
        el('span', { class: 'atelier-quote-value' + (q.credits < 0 ? ' is-credit' : '') }, fmtCr(q.credits))));
      if (q.balance != null) {
        var after = q.balance - q.credits;
        quoteEl.appendChild(el('div', { class: 'atelier-quote-sub cb-hint' + (q.affordable ? '' : ' is-bad') },
          'Balance ' + fmtCr(q.balance) + ' → ' + fmtCr(after)));
      }
      if (q.lines && q.lines.length) {
        quoteEl.title = q.lines.slice(0, 14).map(function (l) {
          return (l.label || l.name || l.path || 'Item') + ': ' + fmtCr(num(l.credits != null ? l.credits : l.amount));
        }).join('\n');
      }
      U.clear(lockEl);
      lockEl.hidden = !q.violations.length;
      if (q.violations.length) {
        lockEl.appendChild(el('span', { class: 'atelier-locks-head', html: icon('lock') + '<span>' + q.violations.length + ' part' + (q.violations.length > 1 ? 's' : '') + ' above your level:</span>' }));
        lockEl.appendChild(el('ul', { class: 'atelier-lock-list' }, q.violations.slice(0, 6).map(function (v) {
          var section = String(v.path || '').split('.')[0];
          return el('li', null, el('button', { type: 'button', class: 'issue-jump', onclick: function () { if (CB.panels && CB.panels[section]) goto(section, { focus: true }); } },
            (v.category ? v.category + ': ' : '') + (v.name || v.id) + ' (level ' + v.level + ')'));
        })));
        var E = eco();
        if (E && typeof E.clampBuildToUnlocks === 'function') {
          lockEl.appendChild(el('button', { type: 'button', class: 'cb-btn small', onclick: function () {
            var prof = profileNow(), r = prof && safe(function () { return E.clampBuildToUnlocks(prof, CB.state.get()); }, null, 'economy.clampBuildToUnlocks');
            if (r && r.build) { CB.state.replace(r.build, { label: 'Swap locked parts' }); toast('Swapped ' + (r.changes ? r.changes.length : 0) + ' locked part(s) for unlocked equivalents', 'success'); }
          } }, 'Swap for unlocked parts'));
        }
      }
      if (confirmBtn) {
        var reason = q.violations.length ? 'Some parts are locked at your level' : !q.affordable ? 'Not enough credits' : '';
        confirmBtn.disabled = !!reason;
        confirmBtn.title = reason || '';
      }
    };
    atelierSession = s;
    if (mode !== 'free') installCareerHooks(s);
    s.refresh(before);

    function finish(kind) {
      if (atelierSession !== s) return;
      if (kind === 'confirm' && s.quote && confirmBtn && confirmBtn.disabled) { toast(confirmBtn.title || 'Cannot confirm yet', 'warning'); return; }
      atelierSession = null;
      removeCareerHooks();
      document.documentElement.removeAttribute('data-atelier-mode');
      if (banner.parentNode) banner.parentNode.removeChild(banner);
      var b = CB.state.get();
      // Design decision (UNIFY-SPEC "what you build is what you drive"): a confirmed purchase / upgrade stays in the Atelier, so the
      // car you just bought is the one Race / Drift / Career drive next. Only Cancel restores the pre-session build.
      if (kind === 'confirm' && mode !== 'free' && opts.build) keepPreSessionBuild(s.preSession);
      if (kind === 'confirm' && opts.onConfirm) safe(function () { opts.onConfirm(b, s.quote); }, null, 'atelier onConfirm');
      if (kind === 'cancel') {
        // career sessions are sandboxed: restore whatever the Atelier held before the session began
        if (mode !== 'free') CB.state.replace(s.preSession, { label: 'Discard career changes' });
        if (opts.onCancel) safe(function () { opts.onCancel(); }, null, 'atelier onCancel');
      }
      if (opts.onClose) safe(function () { opts.onClose(kind, b); }, null, 'atelier onClose');
    }
    s.finish = finish;
    window.scrollTo(0, 0);
    return { close: function () { finish('close'); }, confirm: function () { finish('confirm'); }, cancel: function () { finish('cancel'); }, quote: function () { return s.quote; } };
  }
  /**
   * A confirmed career purchase / upgrade replaces the Atelier build (see finish). If the build the player had before the
   * session was never saved (or has unsaved changes), keep it in Saved builds so free-play work is never silently lost.
   */
  function keepPreSessionBuild(pre) {
    safe(function () {
      var G = CB.garage;
      if (!pre || !pre.meta || !G || typeof G.isDirty !== 'function' || !CB.state.saveLocal) return;
      if (!G.isDirty(pre)) return;
      var e = CB.state.saveLocal(pre);
      if (!e) return;
      try { document.dispatchEvent(new CustomEvent('cb:garage-changed', { detail: { action: 'save', id: e.id } })); } catch (eEv) { /* ignore */ }
      toast('Your previous build “' + (e.name || pre.meta.name || 'Untitled Build') + '” was kept in Saved builds', 'info');
    }, null, 'keep pre-session build');
  }
  function closeAtelier(silent) {
    if (!atelierSession) return;
    var s = atelierSession; atelierSession = null;
    removeCareerHooks();
    document.documentElement.removeAttribute('data-atelier-mode');
    if (s.banner.parentNode) s.banner.parentNode.removeChild(s.banner);
    if (!silent && s.opts.onClose) safe(function () { s.opts.onClose('close', CB.state.get()); });
  }
  function atelierMode() { return atelierSession ? atelierSession.mode : null; }

  /**
   * Career sessions: catalog prices are shown in career credits (economy.CAREER_PRICE_FACTOR) and parts above
   * the driver's level are greyed with a lock badge (CB.ui.lockOption / CB.ui.lockReason hooks read by ui-kit
   * and panels-style). Free Build installs nothing — it ignores locks entirely.
   */
  function installCareerHooks(s) {
    var E = eco();
    if (!E || !CB.ui) return;
    var factor = num(E.CAREER_PRICE_FACTOR) || 0.35;
    CB.ui.currency = {
      factor: factor,
      format: function (n) {
        var c = Math.round(num(n) * factor / 10) * 10;
        if (!c) return n ? (n > 0 ? '+' : '−') + '10 cr' : 'Included';
        return (c > 0 ? '+' : '−') + U.fmtNum(Math.abs(c), 0) + ' cr';
      }
    };
    if (s.opts.ignoreLocks !== true && typeof E.lockedPaths === 'function') {
      var prof = profileNow() || {};
      var locked = safe(function () { return E.lockedPaths(prof); }, {}, 'economy.lockedPaths') || {};
      var feats = typeof E.lockedFeatures === 'function' ? (safe(function () { return E.lockedFeatures(prof); }, {}, 'economy.lockedFeatures') || {}) : {};
      var lvl = typeof E.profileLevel === 'function' ? safe(function () { return E.profileLevel(prof); }, null) : (prof.level || null);
      var you = lvl ? ' (you are level ' + lvl + ')' : '';
      var inSet = function (set, id) { return !!set && typeof set.has === 'function' && (set.has(id) || set.has(String(id)) || (id !== '' && isFinite(Number(id)) && set.has(Number(id)))); };
      CB.ui.lockOption = function (path, id) {
        if (id === true) {
          if (!feats[path]) return false;
          var fu = E.FEATURE_UNLOCKS && E.FEATURE_UNLOCKS[path];
          return { level: feats[path], reason: (fu && fu.name ? fu.name : 'This feature') + ' unlocks at driver level ' + feats[path] + you };
        }
        if (!inSet(locked[path], id)) return false;
        var need = typeof E.partUnlockLevel === 'function' ? safe(function () { return E.partUnlockLevel(path, id); }, null) : null;
        return { level: need, reason: 'Locked: unlocks at driver level ' + (need || '?') + you };
      };
      CB.ui.lockReason = function (coll, id) {
        if (coll === 'feature') { var r = CB.ui.lockOption(id, true); return r ? r.reason : false; }
        if (typeof E.isUnlocked !== 'function' || safe(function () { return E.isUnlocked(prof, coll, id); }, true)) return false;
        var need = typeof E.partUnlockLevel === 'function' ? safe(function () { return E.partUnlockLevel(coll, id); }, null) : null;
        return 'Locked: unlocks at driver level ' + (need || '?') + you;
      };
    }
    if (CB.ui.syncAll) safe(function () { CB.ui.syncAll(document.body); }, null, 'ui.syncAll');
  }
  function removeCareerHooks() {
    if (!CB.ui || !(CB.ui.currency || CB.ui.lockOption || CB.ui.lockReason)) return;
    CB.ui.currency = null; CB.ui.lockOption = null; CB.ui.lockReason = null;
    if (CB.ui.syncAll) safe(function () { CB.ui.syncAll(document.body); }, null, 'ui.syncAll');
  }

  /* ---------------------------------------------------------------- toast */
  function toast(msg, kind, opts) {
    if (CB.ui && CB.ui.toast) return CB.ui.toast(msg, kind, opts);
    if (typeof console !== 'undefined') console.log('[toast]', msg);
    return { close: function () {} };
  }

  /* ---------------------------------------------------------------- boot */
  var bootStripped = false;
  function stripShareParam() {
    var params = parseHash();
    if (params.b) { bootStripped = true; writeHash({ p: params.p || active.id }); }
  }

  function boot() {
    if (booted) return;
    if (!CB.state || !CB.data) {
      console.error('[CB.app] CB.state / CB.data missing — cannot boot.');
      var host = $('panel-host');
      if (host) host.innerHTML = '<div class="boot-error"><h2>The Garage failed to load</h2><p>Core files are missing (state or catalog). Check that every file in /js is present and reload.</p></div>';
      return;
    }
    booted = true;
    document.documentElement.classList.add('cb-booting');
    setTheme(theme(), { persist: false });

    var info = CB.state.bootInfo || (CB.state.boot ? safe(function () { return CB.state.boot(); }, null) : null);
    var src = info && info.source;

    initViewer();
    initPerfStrip();
    buildPerfPane();
    buildPricePane();
    initSummaryTabs();
    initTopbar();
    buildNav();

    var params = parseHash();
    var initial = params.p && CB.panels && CB.panels[params.p] ? params.p : (lsGet(LS_UI, {}).panel || null);
    if (!initial || !CB.panels || !CB.panels[initial]) { var ids = orderedIds(); initial = ids[0]; }
    if (initial) goto(initial, { force: true, focus: false });
    else {
      var host2 = $('panel-host');
      if (host2) { U.clear(host2); host2.appendChild(el('div', { class: 'boot-error' }, el('h2', null, 'No configuration sections'), el('p', null, 'The panel scripts did not load. The summary and visualiser still work.'))); }
    }
    if (src === 'url') stripShareParam();

    CB.state.subscribe(function (build, change) { scheduleFrame(change); });
    if (has('game.achievements.install')) safe(function () { CB.game.achievements.install({ state: false }); }, null, 'achievements.install');
    document.addEventListener('keydown', onKey);
    document.addEventListener('cb:route', function () { syncTitle(); });
    document.addEventListener('cb:race-finished', onRaceFinished);
    syncTitle();
    window.addEventListener('hashchange', function () {
      if (ignoreHash) { ignoreHash = false; return; }
      var p = parseHash();
      if (p.p && p.p !== active.id && CB.panels && CB.panels[p.p]) goto(p.p);
      if (p.b) { setTimeout(function () { bootStripped = true; writeHash({ p: active.id }); toast('Loaded shared build', 'success'); }, 0); }
    });
    document.addEventListener('cb:panel-registered', U.debounce(function () {
      buildNav();
      if (!active.id) { var ids = orderedIds(); if (ids[0]) goto(ids[0], { force: true }); }
    }, 30));
    document.addEventListener('visibilitychange', function () { if (!document.hidden) scheduleFrame({ path: '*', type: 'refresh' }); });
    window.addEventListener('afterprint', function () { markChartsDirty(); });

    // first full frame (no count-up on boot)
    scheduleFrame({ path: '*', type: 'boot' });
    var markReady = function () {
      document.documentElement.classList.remove('cb-booting');
      document.documentElement.classList.add('cb-ready');
    };
    if (document.hidden) markReady(); else { requestAnimationFrame(markReady); setTimeout(markReady, 150); }
    bootHub(src);
    var msg = src === 'url' ? 'Loaded a shared build' : src === 'autosave' ? 'Restored your last session' : 'New build';
    setStatus(msg, src === 'url' ? 'ok' : '');
    if (src === 'url') toast('Loaded a shared build. Edits are autosaved on this device.', 'success');
  }

  /**
   * Entry flow: index.html opens on the game hub's title screen ("FORGE" → main menu); "Free Build (Atelier)"
   * parks the hub and reveals the configurator, and the top-bar Menu button returns. Share links (#b=...) and
   * explicit '#atelier' / '?atelier' links skip straight to the configurator.
   */
  function bootHub(src) {
    if (routed()) return;   // index.html: CB.router boots to #/menu (title screen) and owns every screen
    if (!hubAvailable() || typeof CB.game.hub.boot !== 'function') return;
    var hash = (window.location && window.location.hash) || '', search = (window.location && window.location.search) || '';
    if (src === 'url' || /(^#|&)(atelier|hub)(=|&|$)/.test(hash) || /[?&]atelier(=|&|$)/.test(search)) return;
    if (/[?&]b=/.test(search) || /(^#|&)b=/.test(hash)) return;
    safe(function () { CB.game.hub.boot({ standalone: false, screen: 'title' }); }, null, 'hub.boot');
  }

  CB.app = {
    version: '1.0.0',
    boot: boot,
    goto: goto, next: function () { step(1); }, prev: function () { step(-1); },
    activePanel: function () { return active.id; },
    bundle: function () { return lastBundle || compute(CB.state.get()); },
    compute: compute,
    refresh: function () { bundleCache = { build: null, bundle: null }; scheduleFrame({ path: '*', type: 'refresh' }); },
    setTheme: setTheme, theme: theme,
    setView: setView, toggleXray: toggleXray, toggleSpin: toggleSpin,
    finance: function () { return U.deepClone(fin); },
    financeFor: function (total) { return { finance: finance(total), lease: lease(total), settings: U.deepClone(fin) }; },
    openAtelier: openAtelier, closeAtelier: closeAtelier, atelierMode: atelierMode, openHub: openHub,
    showShortcuts: showShortcuts, openRace: openRace, drive: drive, openDriveMenu: openDriveMenu,
    fmtLap: fmtLap,
    _test: { mergeChange: mergeChange, isUserEdit: isUserEdit, autoFixable: autoFixable, onRaceFinished: onRaceFinished, recordFreeRace: recordFreeRace, ownedSession: ownedSession, keepPreSessionBuild: keepPreSessionBuild }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

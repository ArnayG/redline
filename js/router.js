/* ==========================================================================
   Redline — js/router.js
   CB.router : the single entry point's hash router (UNIFY-SPEC § Router).

   Routes (hash):  #/menu  #/garage[/<panel>]  #/race  #/drift  #/arcade (ARCADE-SPEC)  #/career  #/challenges  #/cars
                   #/achievements  #/replays  #/profile  #/settings        (default: #/menu)
                   #/multiplayer[/<ROOM>]   (CB.net.lobby, js/net/lobby.js: registers itself via CB.router.on)
   Sub screens:    #/<route>/<sub>?k=v   e.g. #/career/championship?id=rookie-cup, #/garage/engine
   Legacy links:   #b=<share>, #p=<panel>&b=<share>, #atelier, ?atelier  -> #/garage (the builder)
                   #/atelier[/<panel>]                                    -> #/garage[/<panel>]
                   #hub, #hub=<screen>, #<hub screen>                     -> the matching hub route

   Route ids vs URL segments (the Redline rebrand). Internal route ids are unchanged so every
   CB.router.go('atelier') / go('garage') / on('atelier', ...) caller keeps working:
       route id 'atelier'  (the car builder, shown as "Garage")    <->  URL  #/garage[/<panel>]
       route id 'garage'   (saved cars, shown as "My Cars")        <->  URL  #/cars[/<sub>]
   format() writes the URL segment, parse() reads URL segments (and still accepts '#/atelier' as a legacy
   alias). Bare ids passed to go()/normalizeTarget() ('garage', 'atelier/engine') are route ids; hash
   strings ('#/garage', '#/cars') are URLs. 'cars' is also accepted as an alias id for the My Cars route.
   NB: before the rebrand '#/garage' was the saved-cars screen; such old bookmarks now open the builder.

   Public API
     CB.router.boot()                       idempotent; index.html calls it on DOMContentLoaded
     CB.router.go(route, params?, opts?)    route: 'career' | 'career/briefing?x=1' | '#/race' | {route, sub, params}
                                            opts { replace, keepHub }  -> true when the navigation happened
     CB.router.current()                    -> { route, sub, params, path }
     CB.router.on(route, enter, leave)      -> off();  enter(layerEl, params, ctx{route, sub, from}), leave(ctx{to})
     CB.router.back()                       browser back (or the menu when there is no history)
     CB.router.layer(route)                 the screen layer Element of a route
     CB.router.setDriving(on)               hides the global nav bar while a car is being driven
     CB.router.refreshNav()                 re-render the nav bar (credits / level chip)
     CB.router.routes, CB.router._          route ids and pure helpers (Node-testable)

   Layers: every route is a full-viewport <section class="cb-screen"> inside #app-root; exactly one is visible.
     atelier  -> #screen-atelier  (the configurator: #topbar / #layout / #bottomnav live in it)
     race     -> #screen-race     (CB.race.ui mounts #race-root into it via CB.router.on('race', ...))
     drift    -> #screen-drift
     arcade   -> #screen-arcade    (CB.race.ui discipline 'arcade', ARCADE-SPEC.md)
     multiplayer -> #screen-multiplayer (CB.net.lobby renders into it; the sub path is the room code to join)
     hub      -> #screen-hub      (menu, career, challenges, garage, achievements, replays, profile, settings:
                                   one CB.game.hub instance; its screens are the router's screens)
   Events: 'cb:router-ready' {router}, 'cb:route' {route, sub, params, from}.

   Zero dependencies, classic script, works from file://. Pure helpers load in Node.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});

(function () {
  'use strict';

  var hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined' && typeof document.createElement === 'function';

  /* ======================================================================
     Route table (pure)
     ====================================================================== */
  var ROUTES = ['menu', 'atelier', 'race', 'drift', 'arcade', 'multiplayer', 'career', 'challenges', 'garage', 'achievements', 'replays', 'profile', 'settings'];
  var LABELS = {
    menu: 'Menu', atelier: 'Garage', race: 'Race', drift: 'Drift', arcade: 'Arcade', multiplayer: 'Multiplayer', career: 'Career', challenges: 'Challenges', garage: 'My Cars',
    achievements: 'Achievements', replays: 'Replays', profile: 'Profile', settings: 'Settings'
  };
  /** Routes rendered by the game hub, and the hub screen each opens on. */
  var HUB_ROUTES = { menu: 'menu', career: 'career', challenges: 'challenges', garage: 'garage', achievements: 'achievements', replays: 'replays', profile: 'profile', settings: 'settings' };
  /** Hub screen -> owning route (sub screens keep the parent's nav item lit). Unlisted screens live under #/menu. */
  var HUB_FAMILY = {
    title: 'menu', menu: 'menu',
    career: 'career', championship: 'career', event: 'career', briefing: 'career', rewards: 'career', trophies: 'career',
    challenges: 'challenges',
    garage: 'garage', showroom: 'garage', workshop: 'garage',
    achievements: 'achievements', replays: 'replays', profile: 'profile', settings: 'settings'
  };
  /** Route id -> URL segment, where they differ (see the header), and URL segment -> route id. */
  var URL_SEG = { atelier: 'garage', garage: 'cars' };
  var SEG_ROUTE = { garage: 'atelier', cars: 'garage' };
  /** Legacy URL segments that still resolve (and are rewritten to the current form). */
  var LEGACY_SEG = { atelier: 'atelier' };
  /** Global nav bar items (UNIFY-SPEC § Unified shell). */
  var NAV = [
    { route: 'atelier', label: 'Garage', icon: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>' },
    { route: 'race', label: 'Race', icon: '<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/>' },
    { route: 'drift', label: 'Drift', icon: '<path d="M4 18c3-7 8-11 16-12"/><path d="M14 4l6 2-2 6"/><circle cx="6" cy="20" r="1.2"/>' },
    { route: 'arcade', label: 'Arcade', icon: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>' },
    { route: 'multiplayer', label: 'Multiplayer', icon: '<circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><path d="M2 20c0-3.3 2.7-6 6-6s6 2.7 6 6M12 20c0-3.3 2.7-6 6-6"/>' },
    { route: 'career', label: 'Career', icon: '<path d="M6 3h12v4a6 6 0 0 1-12 0z"/><path d="M6 5H3v2a3 3 0 0 0 3 3M18 5h3v2a3 3 0 0 1-3 3M9 21h6M12 13v8"/>' },
    { route: 'garage', label: 'My Cars', icon: '<path d="M3 21V9l9-5 9 5v12"/><path d="M7 21v-7h10v7M7 17h10"/>' }
  ];

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function dec(s) { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return String(s); } }
  function enc(s) { return encodeURIComponent(String(s)); }
  function isRoute(r) { return ROUTES.indexOf(r) >= 0; }
  function isHubRoute(r) { return Object.prototype.hasOwnProperty.call(HUB_ROUTES, r); }
  /** Which layer renders a route. */
  function layerOf(route) { return isHubRoute(route) ? 'hub' : route === 'atelier' || route === 'race' || route === 'drift' || route === 'arcade' || route === 'multiplayer' ? route : 'hub'; }

  function parseQuery(q) {
    var out = {};
    String(q || '').split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = dec(i < 0 ? kv : kv.slice(0, i));
      if (!k) return;
      out[k] = i < 0 ? '' : dec(kv.slice(i + 1));
    });
    return out;
  }
  /** Only primitive params are written to the URL; objects / functions (builds, callbacks) stay in memory. */
  function urlParams(params) {
    var out = {};
    if (!isObj(params)) return out;
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (k.charAt(0) === '_' || v == null) return;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    });
    return out;
  }
  /** The hub screen id a route shows -> {route, sub}. */
  function fromHubScreen(id) {
    id = String(id || 'menu');
    var route = HUB_FAMILY[id] || 'menu';
    return { route: route, sub: id === route || id === 'title' ? null : id };
  }
  /** The hub screen a hub route (+ optional sub) opens. */
  function hubScreenFor(route, sub) {
    if (sub && (HUB_FAMILY[sub] === route || (route === 'menu' && !HUB_FAMILY[sub]))) return sub;
    return HUB_ROUTES[route] || 'menu';
  }

  /**
   * parse(hash, search?) -> {route, sub, params, legacy}
   * Accepts router hashes ('#/career/briefing?id=x') and every legacy form the old pages used.
   */
  function parse(hash, search, internalIds) {
    var h = String(hash == null ? '' : hash).replace(/^#/, '');
    if (h.charAt(0) === '/' || h === '') {
      var qi = h.indexOf('?');
      var path = qi < 0 ? h : h.slice(0, qi), query = qi < 0 ? '' : h.slice(qi + 1);
      var ai = path.indexOf('&');                  // '#/atelier/engine&b=v1.x' (share-code friendly form)
      if (ai >= 0) { query = path.slice(ai + 1) + (query ? '&' + query : ''); path = path.slice(0, ai); }
      var segs = path.split('/').filter(Boolean).map(dec);
      var route = segs.length ? segs[0].toLowerCase() : '';
      var sub = segs.length > 1 ? segs.slice(1).join('/') : null;
      var params = parseQuery(query);
      if (internalIds) {
        if (route === 'cars') route = 'garage';
      } else if (Object.prototype.hasOwnProperty.call(SEG_ROUTE, route)) {
        route = SEG_ROUTE[route];
      } else if (Object.prototype.hasOwnProperty.call(LEGACY_SEG, route)) {
        return { route: LEGACY_SEG[route], sub: sub, params: params, legacy: true };
      }
      if (!route) {
        if (search && /[?&]atelier(=|&|$)/.test(String(search))) return { route: 'atelier', sub: null, params: params, legacy: true };
        return { route: 'menu', sub: null, params: params, legacy: false };
      }
      if (!isRoute(route)) {
        if (HUB_FAMILY[route] || route === 'quickrace' || route === 'timetrial') {
          var f = fromHubScreen(route);
          if (!HUB_FAMILY[route]) f.sub = route;
          return { route: f.route, sub: f.sub, params: params, legacy: true };
        }
        return { route: 'menu', sub: null, params: params, legacy: true };
      }
      return { route: route, sub: sub, params: params, legacy: false };
    }
    // legacy key=value hashes
    var kv = parseQuery(h);
    if (Object.prototype.hasOwnProperty.call(kv, 'hub')) {
      var hs = kv.hub || 'menu', fh = fromHubScreen(hs);
      if (!HUB_FAMILY[hs]) fh.sub = hs;
      return { route: fh.route, sub: fh.sub, params: {}, legacy: true };
    }
    if (kv.b || kv.p || Object.prototype.hasOwnProperty.call(kv, 'atelier')) {
      return { route: 'atelier', sub: kv.p || null, params: kv.b ? { b: kv.b } : {}, legacy: true };
    }
    if (HUB_FAMILY[h]) { var fs = fromHubScreen(h); return { route: fs.route, sub: fs.sub, params: {}, legacy: true }; }
    return { route: 'menu', sub: null, params: {}, legacy: true };
  }

  /** format(route, sub?, params?) -> '#/route/sub?k=v' ('b' is always written as '&b=' so CB.state still finds it). */
  function format(route, sub, params) {
    var out = '#/' + (isRoute(route) ? (URL_SEG[route] || route) : 'menu');
    if (sub) out += '/' + String(sub).split('/').map(enc).join('/');
    var p = urlParams(params), keys = Object.keys(p).filter(function (k) { return k !== 'b'; });
    var parts = keys.map(function (k) { return enc(k) + '=' + enc(p[k]); });
    if (p.b != null) parts.push('b=' + String(p.b));
    if (parts.length) out += (parts[0].indexOf('b=') === 0 ? '?&' : '?') + parts.join('&');
    return out;
  }

  /** normalizeTarget('career/briefing?x=1' | '#/race' | {route, sub, params}, params?) -> {route, sub, params} */
  function normalizeTarget(target, params) {
    var t;
    if (isObj(target)) {
      var r = String(target.route || target.name || target.path || target.id || 'menu');
      t = r.indexOf('/') >= 0 || r.indexOf('?') >= 0 || r.charAt(0) === '#' ? normalizeTarget(r) : { route: r, sub: null, params: {} };
      if (target.sub != null) t.sub = target.sub;
      if (isObj(target.params)) t.params = Object.assign({}, t.params, target.params);
    } else {
      var raw = String(target == null ? 'menu' : target);
      // '#/garage' is a URL (the builder); a bare 'garage' / '/garage' is a route id (My Cars)
      var isUrl = raw.charAt(0) === '#';
      var s = raw.replace(/^#/, '');
      if (s.charAt(0) !== '/') s = '/' + s;
      var pp = parse('#' + s, '', !isUrl);
      t = { route: pp.route, sub: pp.sub, params: pp.params };
    }
    if (t.route === 'cars') t.route = 'garage';
    if (!isRoute(t.route)) t = { route: 'menu', sub: null, params: t.params || {} };
    if (isObj(params)) t.params = Object.assign({}, t.params, params);
    t.params = t.params || {};
    return t;
  }
  function sameUrlParams(a, b) { return JSON.stringify(urlParams(a)) === JSON.stringify(urlParams(b)); }

  /* ======================================================================
     Runtime (DOM)
     ====================================================================== */
  var cur = null;              // {route, sub, params}
  var booted = false;
  var transitioning = false;
  var handlers = {};           // route -> [{enter, leave}]
  var layers = {};             // layer id -> Element
  var hubFlow = false;          // the hub parked itself for a flow on another screen and expects to resume
  var firstMenu = true;        // the very first #/menu visit shows the hub's title screen
  var pushed = 0;              // history entries this session created (back() falls back to the menu when 0)
  var ignoreHash = null;       // hash we wrote ourselves through location.hash (file:// fallback)

  function html() { return document.documentElement; }
  function hub() { var h = CB.game && CB.game.hub; return h && typeof h.open === 'function' ? h : null; }
  function app() { return CB.app || null; }
  function safe(fn, label) {
    try { return fn(); } catch (e) { if (typeof console !== 'undefined') console.error('[CB.router] ' + (label || 'error'), e); return undefined; }
  }
  function emit(name, detail) { safe(function () { document.dispatchEvent(new CustomEvent(name, { detail: detail })); }); }

  function current() {
    if (!cur) {
      var p = hasDOM ? parse(window.location.hash, window.location.search) : { route: 'menu', sub: null, params: {} };
      return { route: p.route, sub: p.sub, params: p.params, path: p.route + (p.sub ? '/' + p.sub : '') };
    }
    return { route: cur.route, sub: cur.sub, params: cur.params, path: cur.route + (cur.sub ? '/' + cur.sub : '') };
  }

  function on(route, enter, leave) {
    route = String(route || '').replace(/^#?\/?/, '').split(/[/?]/)[0];
    var h = { enter: typeof enter === 'function' ? enter : null, leave: typeof leave === 'function' ? leave : null };
    (handlers[route] = handlers[route] || []).push(h);
    // registering for the route already on screen: enter it now (late scripts, deep links)
    if (booted && cur && cur.route === route && h.enter && !transitioning) {
      var el = layer(route);
      safe(function () { h.enter(el, cur.params || {}, { route: route, sub: cur.sub, from: null }); }, 'enter ' + route);
      if (route === 'race' || route === 'drift' || route === 'arcade') clearDriveFallback(route);
    }
    return function off() { var l = handlers[route] || [], i = l.indexOf(h); if (i >= 0) l.splice(i, 1); };
  }
  function userHandlers(route) { return (handlers[route] || []).slice(); }

  /* ----------------------------------------------------------- history */
  function writeUrl(hash, replace) {
    if (!hasDOM) return;
    if (window.location.hash === hash) return;
    try {
      if (replace) history.replaceState(history.state, '', hash);
      else { history.pushState({ cbRoute: hash }, '', hash); pushed++; }
    } catch (e) {
      // some file:// setups block the History API: fall back to a plain hash write
      ignoreHash = hash;
      if (replace && window.location.replace) window.location.replace(hash);
      else { window.location.hash = hash; pushed++; }
    }
  }

  /* ----------------------------------------------------------- DOM shell */
  function ensureShell() {
    var root = document.getElementById('app-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'app-root';
      document.body.insertBefore(root, document.body.firstChild);
    }
    ['atelier', 'race', 'drift', 'arcade', 'multiplayer', 'hub'].forEach(function (id) {
      var el = document.getElementById('screen-' + id);
      if (!el) {
        el = document.createElement('section');
        el.id = 'screen-' + id;
        el.className = 'cb-screen';
        el.setAttribute('data-route', id);
        el.hidden = true;
        root.appendChild(el);
      }
      el.classList.add('cb-screen');
      layers[id] = el;
    });
    // the configurator markup (#topbar/#layout/#bottomnav) belongs in the atelier layer
    ['topbar', 'layout', 'bottomnav'].forEach(function (id) {
      var n = document.getElementById(id);
      if (n && !layers.atelier.contains(n)) layers.atelier.appendChild(n);
    });
    var nav = document.getElementById('gnav');
    if (!nav) {
      nav = document.createElement('header');
      nav.id = 'gnav';
      document.body.insertBefore(nav, root);
    }
    nav.className = 'gnav';
    nav.setAttribute('role', 'banner');
    return root;
  }
  function layer(route) {
    if (!hasDOM) return null;
    if (!layers.hub) ensureShell();
    return layers[layerOf(route)] || null;
  }
  function showLayer(id) {
    Object.keys(layers).forEach(function (k) {
      var on = k === id;
      if (layers[k].hidden === on) layers[k].hidden = !on;
      layers[k].classList.toggle('is-active', on);
    });
  }

  /* ----------------------------------------------------------- nav bar */
  function svg(path, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function profileNow() {
    var P = CB.game && CB.game.profile;
    if (!P || typeof P.get !== 'function') return null;
    return safe(function () { return P.get(); }, 'profile.get') || null;
  }
  function creditsText(n) {
    var E = CB.game && CB.game.economy;
    if (E && typeof E.formatCredits === 'function') { var r = safe(function () { return E.formatCredits(n); }); if (r) return r; }
    return Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' cr';
  }
  /** The Redline mark: a tachometer arc whose last segment is the red zone, needle pinned into it. */
  function brandMark(size) {
    return '<svg class="gnav-mark" viewBox="0 0 64 64" width="' + size + '" height="' + size + '" aria-hidden="true">' +
      '<rect width="64" height="64" rx="14" fill="currentColor" opacity=".12"/>' +
      '<path d="M14 42a18 18 0 0 1 28.5-14.6" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>' +
      '<path d="M46.4 31.4A18 18 0 0 1 50 42" fill="none" style="stroke:var(--race,#e0412f)" stroke-width="5" stroke-linecap="round"/>' +
      '<path d="M32 42l13-9" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="42" r="4.5" fill="currentColor"/></svg>';
  }
  var navBuilt = false, navUnsub = null;
  function buildNav() {
    var nav = document.getElementById('gnav');
    if (!nav) return;
    nav.innerHTML =
      '<a class="gnav-brand" href="#/menu" data-go="menu" title="Main menu" aria-label="Redline — main menu">' + brandMark(26) +
        '<span class="gnav-name">RED<b>LINE</b></span></a>' +
      '<nav class="gnav-links" aria-label="Main">' + NAV.map(function (n) {
        return '<a class="gnav-link" href="' + format(n.route) + '" data-go="' + n.route + '" data-nav-route="' + n.route + '">' + svg(n.icon, 16) + '<span>' + esc(n.label) + '</span></a>';
      }).join('') + '</nav>' +
      '<div class="gnav-spacer"></div>' +
      '<a class="gnav-chip" href="#/profile" data-go="profile" data-nav-route="profile" title="Profile & stats"><span class="gnav-credits">—</span><span class="gnav-level"></span></a>' +
      '<a class="cb-btn ghost icon-btn gnav-icon" href="#/settings" data-go="settings" data-nav-route="settings" title="Settings" aria-label="Settings">' +
        svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', 18) + '</a>';
    nav.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('[data-go]');
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0) return;
      e.preventDefault();
      navigate(a.getAttribute('data-go'));
    });
    navBuilt = true;
    var P = CB.game && CB.game.profile;
    if (!navUnsub && P && typeof P.subscribe === 'function') navUnsub = safe(function () { return P.subscribe(function () { updateNav(); }); }, 'profile.subscribe') || true;
  }
  /** Nav-bar launches: Race / Drift go through CB.app (so free races are recorded); everything else is a plain route. */
  function navigate(route) {
    if ((route === 'race' || route === 'drift') && cur && cur.route !== route) {
      var A = app();
      if (A && typeof A.drive === 'function' && CB.race && CB.race.ui && typeof CB.race.ui.open === 'function') {
        if (!canLeave(route)) return false;
        safe(function () { A.drive(route); }, 'app.drive');
        return true;
      }
    }
    return go(route);
  }
  function updateNav() {
    if (!hasDOM) return;
    var nav = document.getElementById('gnav');
    if (!nav || !navBuilt) return;
    var r = cur ? cur.route : null;
    Array.prototype.forEach.call(nav.querySelectorAll('[data-nav-route]'), function (a) {
      var on = a.getAttribute('data-nav-route') === r;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var p = profileNow(), chip = nav.querySelector('.gnav-chip');
    if (chip) {
      chip.hidden = !p;
      if (p) {
        chip.querySelector('.gnav-credits').textContent = creditsText(p.credits);
        chip.querySelector('.gnav-level').textContent = 'Lv ' + (p.level || 1);
        chip.title = (p.driverName || 'Driver') + ' · profile & stats';
      }
    }
  }
  function setDriving(on) {
    if (!hasDOM) return;
    html().classList.toggle('cb-driving', !!on);
  }

  /* ----------------------------------------------------------- built-in screens */
  function canLeave(nextRoute) {
    if (!cur) return true;
    if (cur.route === 'atelier' && nextRoute !== 'atelier') {
      var A = app(), mode = A && typeof A.atelierMode === 'function' ? safe(function () { return A.atelierMode(); }) : null;
      if (mode && mode !== 'free') {
        var msg = 'Confirm or cancel the current career purchase / upgrade first.';
        if (CB.ui && typeof CB.ui.toast === 'function') CB.ui.toast(msg, 'info'); else if (typeof console !== 'undefined') console.info('[CB.router] ' + msg);
        return false;
      }
    }
    return true;
  }

  function enterAtelier(t) {
    var A = app();
    if (A && t.sub && CB.panels && CB.panels[t.sub] && typeof A.activePanel === 'function' && A.activePanel() !== t.sub) safe(function () { A.goto(t.sub); }, 'app.goto');
    if (A && typeof A.activePanel === 'function' && !t.sub) {
      var p = A.activePanel();
      if (p) { t.sub = p; writeUrl(format('atelier', p, t.params), true); }
    }
    if (A && typeof A.refresh === 'function') safe(function () { A.refresh(); }, 'app.refresh');
    // the visualiser / charts measured a hidden layer: let them re-measure now that it is visible
    setTimeout(function () { safe(function () { window.dispatchEvent(new Event('resize')); }); }, 0);
  }

  function hubOpts(screen, params) {
    return { screen: screen, params: params || {}, host: layers.hub, routed: true, onScreen: onHubScreen };
  }
  function enterHub(t) {
    var H = hub();
    if (!H) { renderMissing(layers.hub, 'The game hub (js/game/hub.js) did not load.'); return; }
    var screen = hubScreenFor(t.route, t.sub);
    if (t.route === 'menu' && !t.sub && firstMenu) screen = 'title';
    firstMenu = false;
    var params = Object.assign({}, t.params || {});
    if (H.isOpen() && hubFlow) {
      // back from one of the hub's own flows (career round, career purchase): the hub decides what to show next
      // (rewards, the showroom it came from ...); the URL follows it
      hubFlow = false;
      if (typeof H.unpark === 'function') H.unpark();
      syncFromHub(true);
      return;
    }
    hubFlow = false;
    if (H.isOpen()) {
      var now = H.current;
      if (typeof H.unpark === 'function') H.unpark();
      // 'same' only when the exact screen to open is already on show (#/career while on #/career/championship opens Career)
      var same = !!now && now === screen;
      // a top-level route (global nav, typed URL) or a jump into another hub family (typed URL, back/forward) starts a
      // fresh trail: Main menu › <screen>, not the whole history. Moves inside one family keep (and unwind) the trail.
      var nowFamily = now ? (now === 'title' ? 'menu' : (HUB_FAMILY[now] || 'menu')) : null;
      var resetTrail = !t.sub || nowFamily !== t.route;
      if (same && !Object.keys(urlParams(params)).length) { if (typeof H.refresh === 'function') H.refresh(); }
      else safe(function () { H.show(screen, params, resetTrail ? { reset: true } : undefined); }, 'hub.show');
    } else {
      safe(function () { H.open(hubOpts(screen, params)); }, 'hub.open');
    }
    syncFromHub(true);
  }
  function leaveHub(next, opts) {
    var H = hub();
    if (!H || !H.isOpen()) return;
    // the hub parks itself (display:none) while one of its own flows runs elsewhere — a career round on #/race,
    // a career purchase in #/garage (route id 'atelier') — and resumes when it comes back. Otherwise it is torn down.
    var parked = typeof H.isParked === 'function' ? H.isParked() : false;
    if (parked || (opts && opts.keepHub)) { hubFlow = true; return; }
    safe(function () { H.close(); }, 'hub.close');
  }
  /** The hub navigated internally (menu -> career -> briefing): mirror it in the URL and the nav bar. */
  function onHubScreen(id, params, info) {
    if (!booted || transitioning || !cur || !isHubRoute(cur.route)) return;
    var t = fromHubScreen(id);
    var p = urlParams(params);
    if (t.route === cur.route && t.sub === cur.sub && sameUrlParams(p, cur.params)) return;
    var from = cur;
    cur = { route: t.route, sub: t.sub, params: p };
    writeUrl(format(t.route, t.sub, p), !!(info && info.replace) || id === 'title' || from.sub === null && from.route === 'menu' && id === 'menu');
    updateNav();
    emit('cb:route', { route: cur.route, sub: cur.sub, params: cur.params, from: from.route });
  }
  function syncFromHub(replace) {
    var H = hub();
    if (!H || !H.isOpen() || !cur || !isHubRoute(cur.route)) return;
    var id = H.current;
    if (!id) return;
    var t = fromHubScreen(id);
    if (t.route !== cur.route || t.sub !== cur.sub) {
      cur = { route: t.route, sub: t.sub, params: cur.params };
      writeUrl(format(t.route, t.sub, urlParams(cur.params)), replace);
    }
  }

  /** #/multiplayer is rendered by CB.net.lobby (its CB.router.on handler); say so if js/net/lobby.js is missing. */
  var mpFallbackTimer = null;
  function enterMultiplayer(t) {
    var el = layers.multiplayer;
    clearTimeout(mpFallbackTimer);
    mpFallbackTimer = setTimeout(function () {
      if (!cur || cur.route !== t.route || !el || userHandlers('multiplayer').length || el.children.length) return;
      renderMissing(el, 'Multiplayer (js/net/lobby.js) did not load on this page.');
    }, 600);
  }

  var driveFallbackTimers = {};
  function enterDrive(t) {
    // CB.race.ui registers #/race and #/drift itself (CB.router.on). If nothing mounts, say so instead of a blank screen.
    var route = t.route, el = layers[route];
    clearTimeout(driveFallbackTimers[route]);
    driveFallbackTimers[route] = setTimeout(function () {
      if (!cur || cur.route !== route || !el || el.querySelector('#race-root')) return;
      if (userHandlers(route).length) return;
      renderMissing(el, (route === 'drift' ? 'Drift' : route === 'arcade' ? 'Arcade' : 'Race') + ' mode (js/race/race-ui.js) did not load on this page.');
    }, 400);
  }
  function clearDriveFallback(route) {
    clearTimeout(driveFallbackTimers[route]);
    var el = layers[route], m = el && el.querySelector('.cb-screen-missing');
    if (m) m.parentNode.removeChild(m);
  }
  function leaveDrive(t) {
    clearTimeout(driveFallbackTimers[t.route]);
    var el = layers[t.route], m = el && el.querySelector('.cb-screen-missing');
    if (m) m.parentNode.removeChild(m);
    setDriving(false);
    // race-ui's leave handler destroys its session; make sure nothing keeps running if it did not
    var rr = el && el.querySelector('#race-root');
    if (rr && CB.race && CB.race.ui && typeof CB.race.ui.isOpen === 'function' && CB.race.ui.isOpen()) {
      // still open after its own leave(): it is an overlay-style session — close it
      safe(function () { if (el.contains(document.getElementById('race-root'))) CB.race.ui.close(); }, 'race.ui.close');
    }
  }
  function renderMissing(el, text) {
    if (!el || el.querySelector('.cb-screen-missing')) return;
    var box = document.createElement('div');
    box.className = 'cb-screen-missing';
    box.innerHTML = '<div class="cb-card"><h2>Not available</h2><p class="cb-hint">' + esc(text) + '</p>' +
      '<div class="cb-screen-missing-actions"><a class="cb-btn primary" href="#/menu" data-go="menu">Main menu</a><a class="cb-btn ghost" href="#/garage" data-go="atelier">Garage</a></div></div>';
    box.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('[data-go]');
      if (a) { e.preventDefault(); go(a.getAttribute('data-go')); }
    });
    el.appendChild(box);
  }

  /* ----------------------------------------------------------- transitions */
  function transition(t, opts) {
    opts = opts || {};
    var prev = cur;
    var prevLayer = prev ? layerOf(prev.route) : null, nextLayer = layerOf(t.route);
    var routeChanged = !prev || prev.route !== t.route;
    transitioning = true;
    try {
      if (prev && routeChanged) {
        // leave handlers run while current() still reports the old route
        userHandlers(prev.route).forEach(function (h) { if (h.leave) safe(function () { h.leave({ route: prev.route, to: t.route }); }, 'leave ' + prev.route); });
        if (prevLayer !== nextLayer) {
          if (prevLayer === 'hub') leaveHub(t, opts);
          else if (prevLayer === 'race' || prevLayer === 'drift' || prevLayer === 'arcade') leaveDrive(prev);
        }
      }
      cur = { route: t.route, sub: t.sub || null, params: t.params || {} };
      html().setAttribute('data-route', t.route);
      showLayer(nextLayer);
      if (nextLayer === 'atelier') enterAtelier(cur);
      else if (nextLayer === 'hub') enterHub(cur);
      else if (nextLayer === 'multiplayer') enterMultiplayer(cur);
      else enterDrive(cur);
      var ctx = { route: cur.route, sub: cur.sub, from: prev ? prev.route : null };
      var el = layers[nextLayer];
      userHandlers(cur.route).forEach(function (h) { if (h.enter) safe(function () { h.enter(el, cur.params, ctx); }, 'enter ' + cur.route); });
      if (nextLayer === 'race' || nextLayer === 'drift' || nextLayer === 'arcade') { if (el && el.querySelector('#race-root')) clearDriveFallback(nextLayer); }
    } finally {
      transitioning = false;
    }
    if (nextLayer !== 'race' && nextLayer !== 'drift' && nextLayer !== 'arcade') setDriving(false);
    updateNav();
    if (routeChanged && hasDOM && nextLayer !== 'atelier') safe(function () { window.scrollTo(0, 0); });
    emit('cb:route', { route: cur.route, sub: cur.sub, params: cur.params, from: prev ? prev.route : null });
  }

  /** go(route, params?, opts?) -> true when the navigation happened. */
  function go(target, params, opts) {
    opts = opts || {};
    var t = normalizeTarget(target, params);
    if (!booted) { boot(t); return true; }
    if (cur && t.route === cur.route && (t.sub || null) === (cur.sub || null) && sameUrlParams(t.params, cur.params) && !opts.force) {
      // same screen: still hand fresh in-memory params (launch payloads) to the route's handlers
      if (Object.keys(t.params).length && !sameParamsIdentity(t.params, cur.params)) { transition(t, opts); return true; }
      if (isHubRoute(t.route)) { var H = hub(); if (H && typeof H.unpark === 'function') H.unpark(); }
      return false;
    }
    if (cur && t.route !== cur.route && !canLeave(t.route)) return false;
    writeUrl(format(t.route, t.sub, t.params), !!opts.replace);
    transition(t, opts);
    return true;
  }
  function sameParamsIdentity(a, b) {
    var ka = Object.keys(a || {}), kb = Object.keys(b || {});
    if (ka.length !== kb.length) return false;
    return ka.every(function (k) { return a[k] === (b || {})[k]; });
  }
  function back() {
    if (!hasDOM) return;
    if (pushed > 0) { pushed--; history.back(); return; }
    go('menu', null, { replace: true });
  }

  function onHashChange() {
    if (!booted) return;
    var hash = window.location.hash;
    if (ignoreHash && hash === ignoreHash) { ignoreHash = null; return; }
    var t = parse(hash, '');
    // a share link opened in-session (#b=...): CB.state / CB.app have already read it (their hashchange listeners are
    // registered before this one); drop it from the router URL like boot() does, or later writes would carry the stale
    // b= along and a reload would bring the shared build back over the player's edits
    if (t.params && t.params.b != null) {
      var pb = Object.assign({}, t.params); delete pb.b;
      t = { route: t.route, sub: t.sub, params: pb, legacy: true };
    }
    if (cur && t.route === cur.route && (t.sub || null) === (cur.sub || null) && sameUrlParams(t.params, cur.params)) {
      if (t.legacy) writeUrl(format(cur.route, cur.sub, cur.params), true);
      return;
    }
    if (cur && t.route !== cur.route && !canLeave(t.route)) {
      // blocked: put the URL back where it was
      writeUrl(format(cur.route, cur.sub, cur.params), true);
      return;
    }
    if (t.legacy) writeUrl(format(t.route, t.sub, t.params), true);
    transition(t);
  }

  /* ----------------------------------------------------------- boot */
  function boot(initial) {
    if (!hasDOM || booted) return api;
    // #/wheel/<CODE>: this tab is a phone steering-wheel controller (js/input/wheel-page.js owns the page)
    if (CB.input && CB.input.wheelPage && typeof CB.input.wheelPage.claimsPage === 'function' && CB.input.wheelPage.claimsPage()) return api;
    ensureShell();
    html().classList.add('cb-routed');
    buildNav();
    booted = true;
    var t = initial && isObj(initial) && initial.route ? initial : parse(window.location.hash, window.location.search);
    // a share link (#b=...) has already been read by CB.state; the router URL drops it
    var p = Object.assign({}, t.params || {});
    if (t.route === 'atelier' && p.b) delete p.b;
    t = { route: t.route, sub: t.sub, params: p };
    writeUrl(format(t.route, t.sub, t.params), true);
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', function () { setTimeout(onHashChange, 0); });
    document.addEventListener('cb:driving', function (e) { setDriving(!!(e && e.detail && e.detail.driving)); });
    transition(t);
    emit('cb:router-ready', { router: api });
    return api;
  }

  var api = {
    version: '1.0.0',
    routes: ROUTES.slice(),
    labels: LABELS,
    boot: function () { return boot(); },
    go: go,
    current: current,
    on: on,
    back: back,
    layer: layer,
    setDriving: setDriving,
    refreshNav: updateNav,
    isBooted: function () { return booted; },
    _: {
      parse: parse, format: format, normalizeTarget: normalizeTarget, fromHubScreen: fromHubScreen, hubScreenFor: hubScreenFor,
      urlParams: urlParams, layerOf: layerOf, isHubRoute: isHubRoute, HUB_FAMILY: HUB_FAMILY, HUB_ROUTES: HUB_ROUTES, NAV: NAV,
      URL_SEG: URL_SEG, SEG_ROUTE: SEG_ROUTE
    }
  };
  CB.router = api;

  if (hasDOM) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { boot(); });
    else setTimeout(function () { boot(); }, 0);
  }

  if (typeof module !== 'undefined') module.exports = api;
})();

/* ==========================================================================
   FORGE Atelier — js/net/lobby.js
   CB.net.lobby : the multiplayer lobby screen (docs/NET-SPEC.md § Files, js/net/lobby.js).

   Route  #/multiplayer          create / join a room (connection method picker, your car, name)
          #/multiplayer/<CODE>   deep link: join room CODE straight away

   ---------------------------------------------------------------- INTEGRATION (3 lines elsewhere)
   1) index.html, after js/race/race-ui.js and BEFORE js/router.js:
        <script src="js/net/signal.js" charset="utf-8"></script><script src="js/net/transport.js" charset="utf-8"></script><script src="js/net/netrace.js" charset="utf-8"></script><script src="js/net/lobby.js" charset="utf-8"></script>
   2) js/router.js NAV array (global nav item):
        { route: 'multiplayer', label: 'Multiplayer', icon: '<circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><path d="M2 20c0-3.3 2.7-6 6-6s6 2.7 6 6M12 20c0-3.3 2.7-6 6-6"/>' },
      (works on its own: lobby.js intercepts clicks on [data-go="multiplayer"] while the router does not know the
       route. For first-class routing also add 'multiplayer' to ROUTES; lobby.js then registers itself through
       CB.router.on('multiplayer', ...) and mounts into its own layer <section id="screen-multiplayer">.)
   3) js/race/race-ui.js — the network race hook:
        CB.race.ui.openNet = function (session, cfg) { ... }
      session: a CB.net.race session (same update(dt, input) / snapshot() / results() surface as engine sessions,
               plus optional destroy()); cfg: { mode:'race'|'drift'|'free', trackId, track, laps, ai, weather,
               timeOfDay, assists:{abs,tc,autoShift,racingLine}, maxSteerAssist, players:[{id,name,build,slot}],
               selfId, isHost, build, seed, t0, onClose(results) }.
      race-ui must run its loop on `session` instead of creating an engine session, lock the setup to cfg, and call
      cfg.onClose(results) when the player leaves the results screen (or quits) — the lobby then shows the results
      and is ready for a rematch. Without openNet the lobby shows a "race UI integration pending" notice.

   ---------------------------------------------------------------- what lobby.js expects from js/net/*
   (feature-detected; missing modules give friendly on-screen states, never exceptions)
     CB.net.signal   backend factory, any of: signal.backend(name) | signal.create(name) | signal.use(name) |
                     signal[name]() | signal.backends[name]  (name 'vercel' | 'local' | 'manual')
                     backend: create() -> {code} | code ; join(code) ; close() ; manual backend additionally emits the
                     codes to show via onCode(fn) / on('code', fn) and takes pasted codes via paste(code) / accept(code)
     CB.net.transport host(signal) -> host { on('peer'|'join'|'connection', fn(peer)), close(), invite?(), accept?(code) }
                     connect(signal) -> peer
                     peer { id, send('rel'|'fast', obj), on('message'|'rel', fn), on('close', fn), rtt|ping|stats(), close() }
     CB.net.race     createHostSession(host, cfg) / createClientSession(client, {start, build, name}) (netrace.js);
                     a generic createSession(opts) is used as a fallback
   Lobby messages on the rel channel (NET-SPEC § Messages): hello{name,build,version,pid} roster{players,phase}
   ready{v} chat{text} (host relays chat{id,name,text,ts,sys}) settings{settings} countdown{cfg,seed,t0} kick{} bye{reason}
   results{results}, abort{} (host cancelled the countdown), welcome{id,code}, chat-log{chat}, note{message}.
   The race itself — start{v,seed,t0,grid,…} lights go lap finish results — is CB.net.race's (netrace.js): the lobby's
   pre-race countdown is a separate `countdown` message so the two never collide; a guest stores netrace's start
   (state.netStart) and hands it to createClientSession(client, {start}). Unknown types are ignored.

   Pure, Node-testable core: CB.net.lobby.createCore(opts) (state machine, no DOM, no network) — see tests/net-lobby.test.js.
   Zero dependencies, classic script, works from file:// (Invite code / Same device methods).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.net = CB.net || {};

(function () {
  'use strict';

  var hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined' && typeof document.createElement === 'function';

  /* ======================================================================
     Constants
     ====================================================================== */
  var PROTOCOL = 'forge-net/2';   // 2: Arcade multiplayer (js/net/netarcade.js) — older pages are refused, never mis-run an arcade race
  var MAX_PLAYERS = 8;
  var MAX_AI = 7;
  var COUNTDOWN_MS = 3500;
  var CHAT_MAX = 280;
  var CHAT_KEEP = 120;
  var NAME_MAX = 24;
  var BUILD_MAX_JSON = 60000;
  var LS_NAME = 'forge.net.name';
  var LS_PID = 'forge.net.pid';
  var LS_METHOD = 'forge.net.method';
  var SS_LAST = 'forge.net.last';

  var MODES = [
    { id: 'race', name: 'Race', desc: 'Wheel to wheel, standing start, first past the flag' },
    { id: 'drift', name: 'Drift battle', desc: 'Tandem lead / chase scoring, roles swap every run' },
    { id: 'free', name: 'Free roam', desc: 'No clock, no rules — just drive together' },
    { id: 'arcade', name: 'Arcade', desc: 'Stunt tracks and circuits with nitro, item boxes and power-ups (arcade grip)' }
  ];
  // Arcade rules (ARCADE-SPEC §3/§7; CB.arcade.mode.optionDefs() when the arcade modules are loaded)
  var ARCADE_OPTS = [
    { id: 'items', name: 'Items', type: 'toggle', default: true },
    { id: 'itemFrequency', name: 'Item boxes', choices: [{ id: 'low', name: 'Few' }, { id: 'normal', name: 'Normal' }, { id: 'high', name: 'Many' }, { id: 'frantic', name: 'Frantic' }], default: 'normal' },
    { id: 'nitro', name: 'Nitro', type: 'toggle', default: true },
    { id: 'speedClass', name: 'Speed class', choices: [{ id: 'street', name: 'Street' }, { id: 'pro', name: 'Pro' }, { id: 'mayhem', name: 'Mayhem' }], default: 'street' },
    { id: 'coins', name: 'Coins', type: 'toggle', default: true }
  ];
  var ARCADE_DIFF = [{ id: 'rookie', name: 'Rookie' }, { id: 'amateur', name: 'Amateur' }, { id: 'pro', name: 'Pro' }, { id: 'alien', name: 'Alien' }];
  function arcadeOptDefs() {
    var M = CB.arcade && CB.arcade.mode, list = M && typeof M.optionDefs === 'function' ? safe(function () { return M.optionDefs(); }) : null;
    if (!Array.isArray(list) || !list.length) return ARCADE_OPTS;
    return list.map(function (d) { return { id: d.id, name: d.name, type: Array.isArray(d.choices) ? 'choice' : 'toggle', choices: d.choices, default: d.default }; });
  }
  function normArcade(a, d) {
    a = isObj(a) ? a : {}; d = isObj(d) ? d : {};
    var o = {};
    arcadeOptDefs().forEach(function (def) {
      var v = a[def.id] !== undefined ? a[def.id] : d[def.id];
      if (Array.isArray(def.choices)) o[def.id] = ids(def.choices).indexOf(v) >= 0 ? v : (def.default != null ? def.default : def.choices[0].id);
      else o[def.id] = typeof v === 'boolean' ? v : def.default !== false;
    });
    return o;
  }
  var WEATHERS = [{ id: 'dry', name: 'Dry' }, { id: 'damp', name: 'Damp' }, { id: 'wet', name: 'Wet' }];
  var TIMES = [{ id: 'day', name: 'Day' }, { id: 'dusk', name: 'Dusk' }, { id: 'night', name: 'Night' }];
  var ASSISTS = [
    { id: 'abs', name: 'ABS' }, { id: 'tc', name: 'Traction control' },
    { id: 'autoShift', name: 'Auto gearbox' }, { id: 'racingLine', name: 'Racing line' }
  ];
  var STEER_LEVELS = [
    { id: 'off', name: 'Off' }, { id: 'light', name: 'Light' }, { id: 'medium', name: 'Medium' },
    { id: 'heavy', name: 'Heavy' }, { id: 'auto', name: 'Auto' }
  ];
  var METHODS = [
    { id: 'online', name: 'Online', desc: 'Share a 5-letter room code or link. Needs the site’s signalling server.' },
    { id: 'manual', name: 'Invite code', desc: 'Swap two codes by chat or email. Works anywhere, no server.' },
    { id: 'local', name: 'Same device', desc: 'Two browser tabs on this computer — handy for testing.' }
  ];
  var METHOD_BACKEND = { online: 'vercel', manual: 'manual', local: 'local' };
  var FALLBACK_TRACKS = [
    { id: 'forge-ring', name: 'Redline Ring', kind: 'race' },
    { id: 'kurogane-pass', name: 'Kurogane Pass', kind: 'drift' }
  ];

  /* ======================================================================
     Pure helpers
     ====================================================================== */
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function ids(list) { return list.map(function (x) { return x.id; }); }
  function pick(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return list[0]; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"'`]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c];
    });
  }
  function wellFormed(s) {
    if (typeof s.toWellFormed === 'function') return s.toWellFormed();
    return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '�').replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1�');
  }
  /** Chat / name text: control + bidi-override chars removed, whitespace collapsed, capped by code points (emoji-safe). */
  function cleanText(s, max) {
    s = wellFormed(String(s == null ? '' : s))
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩﻿]/g, '')
      .replace(/\s+/g, ' ').trim();
    var cps = Array.from(s);
    if (cps.length > max) s = cps.slice(0, max).join('').trim();
    return s;
  }
  function cleanName(s) { return cleanText(s, NAME_MAX) || 'Driver'; }
  function normCode(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
  function safeColor(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#8a8a8a'; }
  function randId(n) {
    var a = 'abcdefghijkmnpqrstuvwxyz23456789', s = '';
    for (var i = 0; i < (n || 10); i++) s += a.charAt(Math.floor(Math.random() * a.length));
    return s;
  }

  /**
   * sanitizeBuild(build) -> plain JSON-safe copy (or null). Builds come from remote peers, so every string loses
   * markup characters (they end up in SVG thumbnails / attributes), keys are restricted and size is capped.
   */
  function sanitizeBuild(b) {
    if (!isObj(b)) return null;
    function walk(v, depth) {
      if (depth > 7) return undefined;
      if (typeof v === 'string') return v.replace(/[<>"'`&\\\u0000-\u001F]/g, '').slice(0, 96);
      if (typeof v === 'number') return isFinite(v) ? v : 0;
      if (typeof v === 'boolean' || v === null) return v;
      if (Array.isArray(v)) return v.slice(0, 64).map(function (x) { return walk(x, depth + 1); }).filter(function (x) { return x !== undefined; });
      if (isObj(v)) {
        var o = {};
        Object.keys(v).slice(0, 120).forEach(function (k) {
          if (!/^[A-Za-z0-9_-]{1,48}$/.test(k) || k === '__proto__' || k === 'constructor' || k === 'prototype') return;
          var w = walk(v[k], depth + 1);
          if (w !== undefined) o[k] = w;
        });
        return o;
      }
      return undefined;
    }
    var out;
    try { out = walk(JSON.parse(JSON.stringify(b)), 0); } catch (e) { return null; }
    try { if (JSON.stringify(out).length > BUILD_MAX_JSON) return null; } catch (e2) { return null; }
    return out || null;
  }

  /* ---------------------------------------------------------------- tracks */
  function raceTracks() {
    var T = CB.race && CB.race.tracks, D = CB.race && CB.race.drift && CB.race.drift.tracks;
    var list = T && Array.isArray(T.list) ? T.list : T && typeof T.list === 'function' ? safe(function () { return T.list(); }) || [] : [];
    var isDrift = D && typeof D.isDrift === 'function' ? function (d) { return !!safe(function () { return D.isDrift(d); }); } : function (d) { return d && d.mode === 'drift'; };
    var out = list.filter(Boolean).map(function (d) { return { id: String(d.id), name: String(d.name || d.id), kind: isDrift(d) ? 'drift' : 'race', def: d }; });
    if (D && Array.isArray(D.list)) D.list.forEach(function (d) { if (d && !out.some(function (x) { return x.id === d.id; })) out.push({ id: String(d.id), name: String(d.name || d.id), kind: 'drift', def: d }); });
    return out.length ? out : FALLBACK_TRACKS.slice();
  }
  /** Arcade stunt tracks (CB.arcade.stunt, feature-detected). */
  function stuntTracks() {
    var S = CB.arcade && CB.arcade.stunt, l = S && typeof S.list === 'function' ? safe(function () { return S.list(); }) : null;
    return Array.isArray(l) ? l.filter(function (d) { return d && d.id; }).map(function (d) { return { id: String(d.id), name: String(d.name || d.id), kind: 'stunt', def: d }; }) : [];
  }
  function isStuntId(id) { return stuntTracks().some(function (t) { return t.id === id; }); }
  /** Tracks offered for a mode: drift battle lists drift circuits first, races list circuits first; free roam gets all;
      arcade: stunt tracks first, then the race circuits. */
  function tracksFor(mode) {
    if (mode === 'arcade') return stuntTracks().concat(raceTracks().filter(function (t) { return t.kind === 'race'; }));
    var all = raceTracks();
    if (mode === 'free') return all;
    var want = mode === 'drift' ? 'drift' : 'race';
    var a = all.filter(function (t) { return t.kind === want; }), b = all.filter(function (t) { return t.kind !== want; });
    return a.concat(b);
  }
  function trackKnown(id) {
    if (isStuntId(id)) return true;
    var all = raceTracks();
    if (all === FALLBACK_TRACKS || !(CB.race && CB.race.tracks)) return typeof id === 'string' && /^[a-z0-9-]{1,48}$/.test(id);
    return all.some(function (t) { return t.id === id; });
  }

  /* ---------------------------------------------------------------- settings */
  function defaultSettings() {
    var t = tracksFor('race')[0];
    return {
      mode: 'race', trackId: t ? t.id : 'forge-ring', laps: 3, ai: 3, weather: 'dry', timeOfDay: 'day',
      assists: { abs: true, tc: true, autoShift: true, racingLine: true }, maxSteerAssist: 'auto', collisions: true,
      arcade: normArcade({}), difficulty: 'amateur'
    };
  }
  /** normalizeSettings(next, prev?) -> a complete, valid settings object (unknown values fall back to prev / defaults). */
  function normalizeSettings(s, prev) {
    var d = prev && isObj(prev) ? prev : defaultSettings();
    s = isObj(s) ? s : {};
    var o = {};
    o.mode = ids(MODES).indexOf(s.mode) >= 0 ? s.mode : d.mode;
    o.trackId = typeof s.trackId === 'string' && trackKnown(s.trackId) ? s.trackId : d.trackId;
    if (s.mode && s.mode !== d.mode && !s.trackId) {
      // mode switch without an explicit track: move to the first track of the new discipline when the old one does not fit
      var first = tracksFor(o.mode)[0], cur = raceTracks().filter(function (t) { return t.id === o.trackId; })[0];
      if (first && cur && o.mode !== 'free' && o.mode !== 'arcade' && cur.kind !== (o.mode === 'drift' ? 'drift' : 'race')) o.trackId = first.id;
      if (first && o.mode === 'arcade' && cur && cur.kind !== 'race') o.trackId = first.id;   // drift venue -> first stunt track
      if (o.mode === 'arcade' && !cur && !isStuntId(o.trackId) && first) o.trackId = first.id;
    }
    if (o.mode !== 'arcade' && isStuntId(o.trackId)) { var fr = tracksFor(o.mode)[0]; o.trackId = fr ? fr.id : 'forge-ring'; }   // stunt tracks are arcade-only
    o.laps = Math.round(clamp(num(s.laps, d.laps), 1, 20));
    o.ai = Math.round(clamp(num(s.ai, d.ai), 0, MAX_AI));
    o.weather = ids(WEATHERS).indexOf(s.weather) >= 0 ? s.weather : d.weather;
    o.timeOfDay = ids(TIMES).indexOf(s.timeOfDay) >= 0 ? s.timeOfDay : d.timeOfDay;
    var sa = isObj(s.assists) ? s.assists : {}, da = isObj(d.assists) ? d.assists : {};
    o.assists = {};
    ASSISTS.forEach(function (a) { o.assists[a.id] = typeof sa[a.id] === 'boolean' ? sa[a.id] : da[a.id] !== false; });
    o.maxSteerAssist = ids(STEER_LEVELS).indexOf(s.maxSteerAssist) >= 0 ? s.maxSteerAssist : d.maxSteerAssist;
    o.collisions = typeof s.collisions === 'boolean' ? s.collisions : d.collisions !== false;
    o.arcade = normArcade(s.arcade, d.arcade);
    o.difficulty = ids(ARCADE_DIFF).indexOf(s.difficulty) >= 0 ? s.difficulty : (ids(ARCADE_DIFF).indexOf(d.difficulty) >= 0 ? d.difficulty : 'amateur');
    return o;
  }

  /* ======================================================================
     Lobby core — pure state machine (host or guest). No DOM, no network.
       host:  core.addPeer({id, send(obj), close(), rtt?()}), core.receive(peerId, msg), core.peerClosed(peerId)
       guest: createCore({role:'guest', send(obj)}), core.receive('host', msg), core.peerClosed('host')
     Events (core.on): 'change'(state) 'chat'(msg) 'launch'({cfg, seed, t0, players}) 'closed'({reason, message})
                       'results'(results)
     ====================================================================== */
  var REASONS = {
    version: 'Your game version does not match the host’s. Both players should reload the page.',
    full: 'This room is full (8 players).',
    kicked: 'The host removed you from the room.',
    'host-left': 'The host closed the room.',
    'host-lost': 'Lost the connection to the host.',
    left: 'You left the room.',
    racing: 'A race is running — you will join the next one.'
  };

  function createCore(o) {
    o = o || {};
    var role = o.role === 'host' ? 'host' : 'guest';
    var now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };   // wall clock (chat stamps)
    var clock = typeof o.clock === 'function' ? o.clock : now;                            // race clock (host: start t0)
    var rnd = typeof o.random === 'function' ? o.random : Math.random;
    var version = o.version || PROTOCOL;
    var toLocal = typeof o.hostToLocal === 'function' ? o.hostToLocal : function (t) { return t; };
    var sendHost = typeof o.send === 'function' ? o.send : function () {};
    var self = { id: String(o.selfId || (role === 'host' ? 'host' : 'me')), pid: String(o.pid || randId(12)), name: cleanName(o.name), build: sanitizeBuild(o.build) };
    var st = {
      role: role, selfId: self.id, code: o.code || null, phase: 'lobby', players: [], settings: normalizeSettings(o.settings),
      chat: [], startAt: 0, start: null, results: null, closed: null, connected: role === 'host'
    };
    var peers = {};       // host: peerId -> {peer, joined, pid, chatTimes:[]}
    var banned = {};      // host: pid -> true
    var listeners = {};
    var joinSeq = 0;

    function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return function () { var l = listeners[ev] || [], i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }; }
    function emit(ev, a) { (listeners[ev] || []).slice().forEach(function (fn) { try { fn(a); } catch (e) { if (typeof console !== 'undefined') console.error('[CB.net.lobby] ' + ev, e); } }); }
    function changed() { emit('change', st); }

    function player(id) { for (var i = 0; i < st.players.length; i++) if (st.players[i].id === id) return st.players[i]; return null; }
    function pub(p) { return { id: p.id, name: p.name, build: p.build, ready: !!p.ready, ping: Math.round(p.ping || 0), host: !!p.host, late: !!p.late, link: p.link === 'reconnecting' ? 'reconnecting' : 'open' }; }
    function pushChat(m) {
      st.chat.push(m);
      if (st.chat.length > CHAT_KEEP) st.chat.splice(0, st.chat.length - CHAT_KEEP);
      emit('chat', m);
    }
    function sys(text) {
      var m = { t: 'chat', id: null, name: '', text: text, ts: now(), sys: true };
      pushChat(m);
      if (role === 'host') broadcast(m);
    }

    /* ------------------------------------------------ host side */
    function sendTo(id, msg) {
      var p = peers[id];
      if (!p || !p.peer || typeof p.peer.send !== 'function') return;
      try { p.peer.send(msg); } catch (e) { /* closing peer */ }
    }
    function broadcast(msg, except) { Object.keys(peers).forEach(function (id) { if (peers[id].joined && id !== except) sendTo(id, msg); }); }
    function rosterMsg() { return { t: 'roster', phase: st.phase, players: st.players.map(pub) }; }
    function pushRoster() { broadcast(rosterMsg()); changed(); }
    function guests() { return st.players.filter(function (p) { return !p.host; }); }

    if (role === 'host') st.players.push({ id: self.id, pid: self.pid, name: self.name, build: self.build, ready: true, ping: 0, host: true, joinedAt: joinSeq++ });

    function addPeer(peer) {
      if (role !== 'host' || !peer || peer.id == null) return;
      var id = String(peer.id);
      peers[id] = { peer: peer, joined: false, pid: null, chatTimes: [] };
    }
    function reject(id, reason) {
      sendTo(id, { t: 'bye', reason: reason, message: REASONS[reason] || '' });
      var p = peers[id];
      delete peers[id];
      if (p && p.peer && typeof p.peer.close === 'function') { try { p.peer.close(); } catch (e) { /* ignore */ } }
    }
    function hostReceive(id, msg) {
      var pe = peers[id];
      if (!pe) return;
      var p = player(id);
      switch (msg.t) {
        case 'hello': {
          if (String(msg.version || '') !== version) { reject(id, 'version'); return; }
          var pid = String(msg.pid || id).slice(0, 40);
          if (banned[pid]) { reject(id, 'kicked'); return; }
          var name = cleanName(msg.name), build = sanitizeBuild(msg.build);
          if (p) { p.name = name; if (build) p.build = build; pushRoster(); return; }  // profile / car update
          // a rejoin with the same persistent id replaces the stale entry
          st.players.filter(function (x) { return !x.host && x.pid === pid; }).forEach(function (x) { dropPlayer(x.id, null, true); });
          if (st.players.length >= MAX_PLAYERS) { reject(id, 'full'); return; }
          pe.joined = true; pe.pid = pid;
          st.players.push({ id: id, pid: pid, name: name, build: build, ready: false, ping: 0, host: false, late: st.phase !== 'lobby', joinedAt: joinSeq++ });
          sendTo(id, { t: 'welcome', id: id, code: st.code, version: version });
          sendTo(id, { t: 'settings', settings: st.settings });
          sendTo(id, { t: 'chat-log', chat: st.chat.slice(-30) });
          if (st.phase === 'countdown' && st.start) sendTo(id, { t: 'note', reason: 'racing', message: REASONS.racing });
          pushRoster();
          sys(name + ' joined');
          return;
        }
        case 'ready': {
          if (!p || st.phase === 'racing') return;
          p.ready = !!msg.v;
          if (!p.ready && st.phase === 'countdown') { cancelCountdown(p.name + ' is no longer ready'); return; }
          pushRoster();
          return;
        }
        case 'chat': {
          if (!p) return;
          var t = now();
          pe.chatTimes = pe.chatTimes.filter(function (x) { return t - x < 8000; });
          if (pe.chatTimes.length >= 6) return;            // 6 messages / 8 s per player
          var text = cleanText(msg.text, CHAT_MAX);
          if (!text) return;
          pe.chatTimes.push(t);
          var m = { t: 'chat', id: id, name: p.name, text: text, ts: t };
          pushChat(m); broadcast(m); changed();
          return;
        }
        case 'bye': dropPlayer(id, ' left'); return;
        default: return;   // netrace / transport traffic
      }
    }
    function dropPlayer(id, why, quiet) {
      var p = player(id);
      if (p && p.host) return;
      var pe = peers[id];
      delete peers[id];
      // remove first: closing the transport peer can re-enter here synchronously (peer-leave / close events)
      var i = p ? st.players.indexOf(p) : -1;
      if (i >= 0) st.players.splice(i, 1);
      if (pe && pe.peer && typeof pe.peer.close === 'function' && !quiet) { try { pe.peer.close(); } catch (e) { /* ignore */ } }
      if (i < 0) return;
      pushRoster();
      if (why && !quiet) sys(p.name + why);
    }
    function kick(id) {
      if (role !== 'host') return false;
      var p = player(id);
      if (!p || p.host) return false;
      if (p.pid) banned[p.pid] = true;
      sendTo(id, { t: 'kick' });
      dropPlayer(id, null);
      sys(p.name + ' was removed by the host');
      return true;
    }
    /** 'Waiting for Bo to ready up' / 'Waiting for 2 players to ready up: Aki, Bo' / '…: A, B, C +2 more'. */
    function waitingReason(waiting) {
      if (waiting.length === 1) return 'Waiting for ' + waiting[0].name + ' to ready up';
      var names = waiting.slice(0, 3).map(function (p) { return p.name; }).join(', ');
      return 'Waiting for ' + waiting.length + ' players to ready up: ' + names + (waiting.length > 3 ? ' +' + (waiting.length - 3) + ' more' : '');
    }
    function canStart() {
      if (role !== 'host') return { ok: false, reason: 'Only the host can start' };
      if (st.phase !== 'lobby') return { ok: false, reason: st.phase === 'countdown' ? 'Starting…' : 'Race in progress' };
      var waiting = guests().filter(function (p) { return !p.ready; });
      if (waiting.length) return { ok: false, reason: waitingReason(waiting), waiting: waiting.map(function (p) { return p.id; }) };
      if (!guests().length && st.settings.mode !== 'free' && st.settings.ai === 0) return { ok: true, solo: true, reason: 'Nobody else here yet — you can still start a solo run' };
      return { ok: true };
    }
    function raceConfig() {
      var s = st.settings;
      var racers = st.players.slice().sort(function (a, b) { return a.joinedAt - b.joinedAt; });
      return {
        mode: s.mode, trackId: s.trackId, laps: s.mode === 'race' || s.mode === 'arcade' ? s.laps : 0,
        ai: s.mode === 'free' ? 0 : Math.min(s.ai, Math.max(0, MAX_PLAYERS - racers.length)),
        weather: s.weather, timeOfDay: s.timeOfDay, assists: Object.assign({}, s.assists), maxSteerAssist: s.maxSteerAssist,
        collisions: s.collisions, hostId: self.id, arcade: s.mode === 'arcade' ? Object.assign({}, s.arcade) : undefined, difficulty: s.difficulty,
        players: racers.map(function (p, i) { return { id: p.id, name: p.name, build: p.build, slot: i }; })
      };
    }
    function startCountdown(force) {
      var g = canStart();
      if (!g.ok && !force) return g;
      var cfg = raceConfig();
      st.players.forEach(function (p) { p.late = false; });
      st.start = { cfg: cfg, seed: Math.floor(rnd() * 2147483646) + 1, t0: clock() + (o.countdownMs != null ? o.countdownMs : COUNTDOWN_MS) };
      st.startAt = st.start.t0;
      st.phase = 'countdown';
      broadcast({ t: 'countdown', cfg: st.start.cfg, seed: st.start.seed, t0: st.start.t0 });
      pushRoster();
      return { ok: true };
    }
    function cancelCountdown(why) {
      if (st.phase !== 'countdown') return false;
      st.phase = 'lobby'; st.start = null; st.startAt = 0;
      if (role === 'host') { broadcast({ t: 'abort', reason: why || '' }); pushRoster(); if (why) sys('Start cancelled — ' + why); }
      else changed();
      return true;
    }
    function updateSettings(partial) {
      if (role !== 'host' || st.phase !== 'lobby') return false;
      var next = normalizeSettings(Object.assign({}, st.settings, partial || {}, { assists: Object.assign({}, st.settings.assists, (partial && partial.assists) || {}), arcade: Object.assign({}, st.settings.arcade, (partial && partial.arcade) || {}) }), st.settings);
      if (partial && partial.mode && partial.mode !== st.settings.mode && !partial.trackId) next = normalizeSettings({ mode: partial.mode }, next);
      if (JSON.stringify(next) === JSON.stringify(st.settings)) return false;
      st.settings = next;
      broadcast({ t: 'settings', settings: next });
      changed();
      return true;
    }
    function refreshPings() {
      if (role !== 'host') return;
      var dirty = false;
      Object.keys(peers).forEach(function (id) {
        var p = player(id); if (!p) return;
        var r = readRtt(peers[id].peer);
        if (r != null && Math.abs(r - (p.ping || 0)) >= 3) { p.ping = r; dirty = true; }
      });
      if (dirty) pushRoster();
    }

    /* ------------------------------------------------ guest side */
    function guestReceive(msg) {
      switch (msg.t) {
        case 'welcome': st.connected = true; if (msg.id) { st.selfId = String(msg.id); } if (msg.code) st.code = normCode(msg.code); changed(); return;
        case 'roster': {
          st.connected = true;
          var list = Array.isArray(msg.players) ? msg.players.slice(0, MAX_PLAYERS) : [];
          st.players = list.filter(isObj).map(function (p, i) {
            return { id: String(p.id), name: cleanName(p.name), build: sanitizeBuild(p.build), ready: !!p.ready, ping: clamp(num(p.ping, 0), 0, 9999), host: !!p.host, late: !!p.late, link: p.link === 'reconnecting' ? 'reconnecting' : 'open', joinedAt: i };
          });
          var ph = ['lobby', 'countdown', 'racing'].indexOf(msg.phase) >= 0 ? msg.phase : 'lobby';
          if (st.phase === 'countdown' && ph === 'racing' && st.start) {
            // the host's clock got there first: launch now instead of waiting for our own tick
            st.startAt = Math.min(st.startAt, clock());
            changed(); tick();
            return;
          }
          if (ph === 'lobby' && st.phase === 'countdown') { st.start = null; st.startAt = 0; }
          if (ph === 'lobby' || !((st.phase === 'racing' || st.phase === 'waiting') && ph !== 'lobby')) st.phase = ph;
          changed();
          return;
        }
        case 'settings': st.settings = normalizeSettings(isObj(msg.settings) ? msg.settings : msg, st.settings); changed(); return;
        case 'chat': {
          var text = cleanText(msg.text, CHAT_MAX);
          if (!text) return;
          pushChat({ t: 'chat', id: msg.id == null ? null : String(msg.id), name: msg.sys ? '' : cleanName(msg.name), text: text, ts: num(msg.ts, now()), sys: !!msg.sys });
          changed();
          return;
        }
        case 'chat-log':
          if (Array.isArray(msg.chat) && !st.chat.length) msg.chat.slice(-30).forEach(function (m) { if (isObj(m)) guestReceive(Object.assign({}, m, { t: 'chat' })); });
          return;
        case 'start':
          // CB.net.race's own start{v, seed, t0, grid, you, …}: kept for the client session (it may arrive before
          // our session exists); never changes the lobby phase
          st.netStart = msg;
          return;
        case 'countdown': {
          if (!isObj(msg.cfg)) return;
          st.netStart = null;
          var cfg = Object.assign({}, msg.cfg, normalizeSettings(msg.cfg, st.settings));
          cfg.laps = cfg.mode === 'race' || cfg.mode === 'arcade' ? cfg.laps : 0;
          cfg.ai = clamp(Math.round(num(msg.cfg.ai, 0)), 0, MAX_AI);
          cfg.players = (Array.isArray(msg.cfg.players) ? msg.cfg.players : []).slice(0, MAX_PLAYERS).filter(isObj).map(function (p, i) {
            return { id: String(p.id), name: cleanName(p.name), build: sanitizeBuild(p.build), slot: Math.round(num(p.slot, i)) };
          });
          cfg.hostId = msg.cfg.hostId != null ? String(msg.cfg.hostId) : null;
          var inRace = cfg.players.some(function (p) { return p.id === st.selfId; });
          st.start = { cfg: cfg, seed: Math.round(num(msg.seed, 1)), t0: num(msg.t0, clock()), spectator: !inRace };
          st.startAt = toLocal(st.start.t0);
          st.phase = 'countdown';
          changed();
          return;
        }
        case 'abort': cancelCountdown(); if (msg.reason) pushChat({ t: 'chat', id: null, name: '', text: 'Start cancelled — ' + cleanText(msg.reason, 80), ts: now(), sys: true }); return;
        case 'results': {
          // lobby results{results} or CB.net.race's final results{…classification}
          var r = msg.results !== undefined ? msg.results : Object.assign({}, msg);
          if (isObj(r)) delete r.t;
          st.results = r == null ? null : r;
          emit('results', st.results); changed();
          return;
        }
        case 'note': if (msg.message) pushChat({ t: 'chat', id: null, name: '', text: cleanText(msg.message, 160), ts: now(), sys: true }); changed(); return;
        case 'kick': close('kicked'); return;
        case 'bye': close(REASONS[msg.reason] ? msg.reason : 'host-left'); return;
        default: return;
      }
    }

    /* ------------------------------------------------ shared */
    function receive(from, msg) {
      if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return; } }
      if (!isObj(msg) || typeof msg.t !== 'string' || st.phase === 'closed') return;
      if (role === 'host') hostReceive(String(from), msg); else guestReceive(msg);
    }
    function peerClosed(id, reason) {
      if (st.phase === 'closed') return;
      if (role === 'host') dropPlayer(String(id), reason === 'timeout' ? ' lost connection' : ' left', false);
      else close(reason === 'host-closed' ? 'host-left' : reason === 'kicked' || reason === 'full' || reason === 'version' ? reason : 'host-lost');
    }
    /** Transport link state of a player ('open' | 'reconnecting'); shown on the car cards. */
    function setLink(id, state) {
      if (role === 'host') {
        var p = player(String(id));
        if (!p || p.link === state) return;
        p.link = state === 'reconnecting' ? 'reconnecting' : 'open';
        pushRoster();
      } else { st.link = state; changed(); }
    }
    function close(reason) {
      if (st.phase === 'closed') return;
      var was = st.phase;
      st.phase = 'closed';
      st.closed = { reason: reason, message: REASONS[reason] || String(reason || ''), wasPhase: was };
      if (role === 'host') {
        broadcast({ t: 'bye', reason: 'host-left' });
        Object.keys(peers).forEach(function (id) { var p = peers[id].peer; if (p && typeof p.close === 'function') { try { p.close(); } catch (e) { /* ignore */ } } });
        peers = {};
      }
      emit('closed', st.closed);
      changed();
    }
    function leave() {
      if (role === 'guest' && st.phase !== 'closed') { try { sendHost({ t: 'bye' }); } catch (e) { /* ignore */ } }
      close('left');
    }
    function hello() {
      if (role !== 'guest') return;
      sendHost({ t: 'hello', name: self.name, build: self.build, version: version, pid: self.pid });
    }
    function setReady(v) {
      v = !!v;
      if (role === 'host') return false;
      var me = player(st.selfId);
      if (me) me.ready = v;
      sendHost({ t: 'ready', v: v });
      changed();
      return true;
    }
    function chat(text) {
      text = cleanText(text, CHAT_MAX);
      if (!text || st.phase === 'closed') return false;
      if (role === 'host') { var m = { t: 'chat', id: self.id, name: self.name, text: text, ts: now() }; pushChat(m); broadcast(m); changed(); }
      else sendHost({ t: 'chat', text: text });
      return true;
    }
    function setProfile(name, build) {
      if (name != null) self.name = cleanName(name);
      if (build !== undefined) self.build = sanitizeBuild(build);
      if (role === 'host') { var me = player(self.id); if (me) { me.name = self.name; me.build = self.build; } pushRoster(); }
      else if (st.connected) hello();
    }
    function tick() {
      if (st.phase !== 'countdown' || !st.start) return false;
      if (clock() < st.startAt) return false;
      var s = st.start;
      st.phase = 'racing';
      if (role === 'host') pushRoster(); else changed();
      emit('launch', { cfg: s.cfg, seed: s.seed, t0: s.t0, players: s.cfg.players, spectator: !!s.spectator, role: role, selfId: st.selfId });
      return true;
    }
    function raceEnded(results) {
      if (results !== undefined) st.results = results;
      if (role === 'host') {
        if (st.phase === 'closed') return;
        st.phase = 'lobby'; st.start = null; st.startAt = 0;
        st.players.forEach(function (p) { if (!p.host) p.ready = false; p.late = false; });
        if (results !== undefined) broadcast({ t: 'results', results: results, lobby: true });
        pushRoster();
        sys('Back in the lobby — ready up for a rematch');
      } else {
        var me = player(st.selfId); if (me) me.ready = false;
        if (st.phase === 'racing') st.phase = 'waiting';   // until the host's roster says lobby
        changed();
      }
    }
    function countdownLeft() { return st.phase === 'countdown' ? Math.max(0, st.startAt - clock()) : 0; }

    return {
      role: role, on: on, receive: receive, addPeer: addPeer, peerClosed: peerClosed, setLink: setLink,
      hello: hello, setReady: setReady, chat: chat, setProfile: setProfile, kick: kick,
      canStart: canStart, startCountdown: startCountdown, cancelCountdown: function () { return cancelCountdown(role === 'host' ? 'the host cancelled' : null); },
      updateSettings: updateSettings, refreshPings: refreshPings, tick: tick, raceEnded: raceEnded, leave: leave, close: close,
      countdownLeft: countdownLeft, raceConfig: raceConfig,
      state: function () { return st; },
      player: player,
      me: function () { return player(st.selfId); },
      isHost: function () { return role === 'host'; }
    };
  }

  function readRtt(peer) {
    if (!peer) return null;
    var r = null;
    try {
      if (typeof peer.rtt === 'function') r = peer.rtt();
      else if (peer.rtt != null) r = peer.rtt;
      else if (typeof peer.ping === 'function') r = peer.ping();
      else if (peer.ping != null && typeof peer.ping !== 'object') r = peer.ping;
      else if (typeof peer.stats === 'function') { var s = peer.stats(); r = s && (s.rtt != null ? s.rtt : s.ping); }
      else if (peer.stats && peer.stats.rtt != null) r = peer.stats.rtt;
    } catch (e) { r = null; }
    r = Number(r);
    return isFinite(r) && r >= 0 ? Math.round(r) : null;
  }

  /* ======================================================================
     Car cards (pure-ish: uses CB.state / CB.shapes / CB.physics / CB.render when present)
     ====================================================================== */
  var cardCache = {}, cardKeys = [];
  function safe(fn) { try { return fn(); } catch (e) { return undefined; } }
  function carSummary(build, withThumb) {
    if (!isObj(build)) return { name: 'No car yet', make: '', gen: '', hp: null, kg: null, drive: '', paint: '#8a8a8a', buildName: '', thumb: '' };
    var key;
    try { key = JSON.stringify(build); } catch (e) { key = String(Math.random()); }
    key += withThumb ? '|t' : '';
    if (cardCache[key]) return cardCache[key];
    var model = null;
    if (CB.state && typeof CB.state.modelOf === 'function') model = safe(function () { return CB.state.modelOf(build); }) || null;
    if (!model && CB.shapes && typeof CB.shapes.getModel === 'function') model = safe(function () { return CB.shapes.getModel(build); }) || null;
    var metrics = CB.physics && typeof CB.physics.compute === 'function' ? safe(function () { return CB.physics.compute(build); }) : null;
    var meta = build.meta || {};
    var out = {
      name: model ? String(model.name || '') : String(meta.name || 'Custom build'),
      make: model ? String(model.make || '') : '',
      gen: model ? String(model.gen || '') : '',
      hp: metrics && isFinite(metrics.power_hp) ? Math.round(metrics.power_hp) : null,
      kg: metrics && isFinite(metrics.weight_kg) ? Math.round(metrics.weight_kg) : null,
      drive: String((build.drivetrain && build.drivetrain.layout) || '').toUpperCase(),
      paint: safeColor(build.exterior && build.exterior.paint),
      buildName: String(meta.name || ''),
      thumb: ''
    };
    if (withThumb && hasDOM && CB.render && typeof CB.render.thumbnail === 'function') {
      var svg = safe(function () { return CB.render.thumbnail(build, { uid: 'nl', theme: 'dark' }); });
      if (typeof svg === 'string' && /^\s*<svg[\s>]/i.test(svg) && !/<script|on\w+\s*=|javascript:/i.test(svg)) out.thumb = svg;
    }
    cardCache[key] = out; cardKeys.push(key);
    while (cardKeys.length > 48) delete cardCache[cardKeys.shift()];
    return out;
  }

  /** Normalise whatever a session's results() returns into rows {pos, name, id, value}. */
  function resultRows(results) {
    var list = Array.isArray(results) ? results : isObj(results) ? (results.standings || results.results || results.order || results.rows || results.classification || []) : [];
    if (!Array.isArray(list)) return [];
    return list.filter(isObj).slice(0, 16).map(function (r, i) {
      var time = num(r.totalTime != null ? r.totalTime : r.time != null ? r.time : r.raceTime, NaN);
      var score = num(r.score != null ? r.score : r.points, NaN);
      var value = r.dnf ? 'DNF' : isFinite(time) && time > 0 ? fmtTime(time) : isFinite(score) ? Math.round(score).toLocaleString('en-US') + ' pts' : '—';
      return { pos: Math.round(num(r.pos != null ? r.pos : r.position, i + 1)), id: r.id == null ? null : String(r.id), name: cleanName(r.name || r.driver || r.driverName), value: value, best: isFinite(num(r.bestLap, NaN)) ? fmtTime(num(r.bestLap)) : '' };
    }).sort(function (a, b) { return a.pos - b.pos; });
  }
  function fmtTime(s) {
    s = Math.max(0, num(s, 0));
    var m = Math.floor(s / 60), r = s - m * 60;
    return (m ? m + ':' + (r < 10 ? '0' : '') : '') + r.toFixed(3);
  }

  /** '#/multiplayer' | '#/multiplayer/ABCDE' -> {code} ; anything else -> null */
  function parseHash(h) {
    var m = /^#?\/multiplayer(?:\/([^?&/]*))?(?:[?&].*)?$/i.exec(String(h || ''));
    if (!m) return null;
    return { code: normCode(safe(function () { return decodeURIComponent(m[1] || ''); }) || '') };
  }
  function shareLink(code, loc) {
    loc = loc || (hasDOM ? window.location : { origin: '', pathname: 'index.html', protocol: 'https:' });
    var base = (loc.protocol === 'file:' ? 'file://' : (loc.origin || '')) + String(loc.pathname || '/');
    return base + '#/multiplayer/' + normCode(code);
  }

  /* ======================================================================
     Network adapter (CB.net.signal + CB.net.transport) — everything feature-detected
     ====================================================================== */
  function netMissing() {
    var N = CB.net || {};
    var miss = [];
    if (!N.signal) miss.push('js/net/signal.js');
    if (!N.transport) miss.push('js/net/transport.js');
    return miss;
  }
  function call(obj, names, args) {
    if (!obj) return undefined;
    for (var i = 0; i < names.length; i++) if (typeof obj[names[i]] === 'function') return obj[names[i]].apply(obj, args || []);
    return undefined;
  }
  function hasFn(obj, names) { return !!obj && names.some(function (n) { return typeof obj[n] === 'function'; }); }
  function listen(obj, evs, fn) {
    if (!obj) return false;
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i], cap = 'on' + ev.charAt(0).toUpperCase() + ev.slice(1);
      if (typeof obj.on === 'function') { try { obj.on(ev, fn); } catch (e) { /* ignore */ } }
      if (typeof obj[cap] === 'function') { try { obj[cap](fn); } catch (e2) { /* ignore */ } }
    }
    return typeof obj.on === 'function';
  }
  function asPromise(v) { return v && typeof v.then === 'function' ? v : Promise.resolve(v); }
  function withTimeout(p, ms, label) {
    return new Promise(function (res, rej) {
      var done = false, t = setTimeout(function () { if (!done) { done = true; rej(new Error(label || 'timeout')); } }, ms);
      asPromise(p).then(function (v) { if (!done) { done = true; clearTimeout(t); res(v); } }, function (e) { if (!done) { done = true; clearTimeout(t); rej(e); } });
    });
  }
  function openSignal(method) {
    var S = CB.net && CB.net.signal, name = METHOD_BACKEND[method] || method;
    if (!S) throw new Error('Signalling module (js/net/signal.js) is not loaded');
    var sig = call(S, ['backend', 'use', 'open', 'make', 'createBackend'], [name]);
    if (!sig && S.backends && S.backends[name]) sig = typeof S.backends[name] === 'function' ? S.backends[name]() : S.backends[name];
    if (!sig && S[name]) sig = typeof S[name] === 'function' ? S[name]() : S[name];
    if (!sig && typeof S.create === 'function' && S.create.length >= 1 && !S.join) sig = S.create(name);
    if (!sig) throw new Error('The “' + method + '” connection method is not available in this build');
    return sig;
  }
  /** Wrap a transport peer into {id, raw, send(obj), close(), rtt()}; rel messages -> onMsg, final close -> onClose(reason). */
  function wrapPeer(raw, onMsg, onClose, onState) {
    var closed = false;
    var w = {
      id: String(raw.id != null ? raw.id : raw.peerId != null ? raw.peerId : 'host'),
      raw: raw,
      send: function (obj) { if (typeof raw.send === 'function') raw.send('rel', obj); },
      close: function (why) { if (closed) return; closed = true; call(raw, ['close', 'destroy'], [why]); },
      rtt: function () { return readRtt(raw); }
    };
    // CB.net.transport delivers (channel, data); tolerate (data, channel) and ({channel, data}) too
    function msgIn(a, b) {
      var msg, ch;
      if (a === 'rel' || a === 'fast') { ch = a; msg = b; }
      else if (isObj(a) && a.t == null && (a.data != null || a.msg != null)) { msg = a.data != null ? a.data : a.msg; ch = a.channel; }
      else { msg = a; ch = typeof b === 'string' ? b : null; }
      if (ch && ch !== 'rel') return;
      if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return; } }
      if (isObj(msg)) onMsg(msg);
    }
    function fin(why) { if (closed) return; closed = true; onClose(why); }
    if (typeof raw.on === 'function') {
      raw.on('message', msgIn);
      raw.on('close', function (why) { fin(why); });
      raw.on('state', function (st) {
        st = isObj(st) ? st.state : st;
        if (st === 'failed') fin('failed');
        else if (onState && (st === 'reconnecting' || st === 'open')) onState(st);
      });
    } else {
      if (typeof raw.onMessage === 'function') raw.onMessage(msgIn);
      if (typeof raw.onClose === 'function') raw.onClose(fin);
    }
    return w;
  }

  /* ======================================================================
     DOM application
     ====================================================================== */
  var A = {
    layer: null, view: 'home', method: null, onlineOk: null, core: null, net: null, busy: false,
    error: null, code: '', manual: null, ui: {}, timers: {}, raceOpen: false, session: null, notice: null,
    chatSeen: 0, lastHtml: {}, stateUnsub: null, fallbackOpen: false, guard: false
  };

  function lsGet(k) { return safe(function () { return window.localStorage.getItem(k); }) || null; }
  function lsSet(k, v) { safe(function () { window.localStorage.setItem(k, v); }); }
  function ssGet(k) { return safe(function () { return JSON.parse(window.sessionStorage.getItem(k) || 'null'); }) || null; }
  function ssSet(k, v) { safe(function () { if (v == null) window.sessionStorage.removeItem(k); else window.sessionStorage.setItem(k, JSON.stringify(v)); }); }
  /** Persistent player id: per browser (localStorage) + per tab (sessionStorage), so a reload rejoins as the same
      player while two same-device tabs stay two players. */
  function pid() {
    var p = lsGet(LS_PID); if (!p) { p = randId(14); lsSet(LS_PID, p); }
    var t = safe(function () { return window.sessionStorage.getItem(LS_PID + '.tab'); });
    if (!t) { t = randId(4); safe(function () { window.sessionStorage.setItem(LS_PID + '.tab', t); }); }
    return p + '-' + t;
  }
  /** The driver name: this tab's own choice first (sessionStorage), so two same-device tabs keep two names, then the
      browser-wide last name (localStorage), then the profile's driver name. */
  function myName() {
    var tabName = ssGet(LS_NAME + '.tab');
    if (typeof tabName === 'string' && cleanName(tabName)) return cleanName(tabName);
    var n = lsGet(LS_NAME);
    if (n) return cleanName(n);
    var P = CB.game && CB.game.profile, pr = P && typeof P.get === 'function' ? safe(function () { return P.get(); }) : null;
    return cleanName(pr && pr.driverName);
  }
  function myBuild() { return CB.state && typeof CB.state.get === 'function' ? safe(function () { return CB.state.get(); }) || null : null; }
  function toast(msg, kind) { if (CB.ui && typeof CB.ui.toast === 'function') CB.ui.toast(msg, kind || 'info'); }

  var ICON = {
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    ticket: '<path d="M3 8a2 2 0 0 0 0 4v4h18v-4a2 2 0 0 1 0-4V4H3z" transform="translate(0 2)"/><path d="M14 6v12" stroke-dasharray="2 2"/>',
    tabs: '<rect x="3" y="5" width="13" height="11" rx="2"/><path d="M8 19h11a2 2 0 0 0 2-2V9"/>',
    crown: '<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/>',
    send: '<path d="M4 12l16-8-6 16-2-7z"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    bot: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 8V4M9 13h.01M15 13h.01"/>',
    leave: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'
  };
  function svg(name, size) { return '<svg viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON[name] || '') + '</svg>'; }

  /* ---------------------------------------------------------------- styles */
  var CSS = [
    '#screen-multiplayer{z-index:12;overflow-y:auto;overflow-x:hidden;background:var(--bg);background-image:radial-gradient(1200px 500px at 85% -10%,var(--accent-softer),transparent 70%),var(--noise)}',
    'html:not(.cb-routed) #screen-multiplayer{position:fixed;inset:0;}',
    /* the shared stage rule (html.cb-routed .cb-screen:not(#screen-atelier){overflow:hidden}) outranks the id rule above: keep the lobby scrollable */
    'html.cb-routed body #screen-multiplayer.cb-screen{overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}',
    'html.nl-open body{overflow:hidden}',
    '.nl-wrap{max-width:1360px;margin:0 auto;padding:28px 32px 48px;display:flex;flex-direction:column;gap:20px;color:var(--text);font-family:var(--font)}',
    '.nl-head{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap}',
    '.nl-head h1{font-family:var(--serif);font-size:34px;font-weight:600;letter-spacing:-.01em;color:var(--text-strong);margin:2px 0 0}',
    '.nl-eyebrow{font:700 11px/1 var(--font);letter-spacing:.22em;text-transform:uppercase;color:var(--accent)}',
    '.nl-head .nl-sub{color:var(--text-dim);font-size:13.5px;margin-top:6px;max-width:620px}',
    '.nl-head-actions{margin-left:auto;display:flex;gap:8px;align-items:center}',
    '.nl-pill{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 11px;border-radius:var(--pill);border:1px solid var(--line);background:var(--panel);font-size:12px;font-weight:600;color:var(--text-dim);white-space:nowrap}',
    '.nl-dot{width:8px;height:8px;border-radius:50%;background:var(--text-faint);flex:none}',
    '.nl-dot.is-good{background:var(--good);box-shadow:0 0 0 3px var(--good-soft)}.nl-dot.is-warn{background:var(--warn);box-shadow:0 0 0 3px var(--warn-soft)}.nl-dot.is-bad{background:var(--bad);box-shadow:0 0 0 3px var(--bad-soft)}',
    '.nl-card{background:var(--panel);background-image:var(--surface-grad);border:1px solid var(--line);border-radius:var(--radius-lg);box-shadow:var(--shadow);padding:20px;display:flex;flex-direction:column;gap:14px;min-width:0}',
    '.nl-card h2{font-size:15px;font-weight:700;color:var(--text-strong);margin:0;display:flex;align-items:center;gap:8px}',
    '.nl-card h2 .nl-count{font:600 12px var(--mono);color:var(--text-dim)}',
    '.nl-hint{font-size:12.5px;line-height:1.5;color:var(--text-dim);margin:0}',
    '.nl-methods{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}',
    '.nl-method{position:relative;text-align:left;display:flex;gap:12px;align-items:flex-start;padding:16px;border-radius:var(--radius);border:1px solid var(--line);background:var(--panel-2);color:var(--text);cursor:pointer;font:inherit;transition:border-color var(--dur-2) var(--ease),background var(--dur-2) var(--ease),transform var(--dur-2) var(--ease)}',
    '.nl-method:hover{border-color:var(--line-2);background:var(--panel-hover)}',
    '.nl-method:focus-visible,.nl-track:focus-visible,.nl-chip-btn:focus-visible{outline:none;box-shadow:var(--focus)}',
    '.nl-method[aria-checked="true"]{border-color:color-mix(in srgb,var(--accent) 55%,var(--line));background:var(--accent-softer);box-shadow:inset 0 0 0 1px var(--accent-ring)}',
    '.nl-method .nl-mi{flex:none;width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:var(--panel-3);color:var(--accent)}',
    '.nl-method b{display:block;font-size:14px;color:var(--text-strong);margin-bottom:3px}',
    '.nl-method span.nl-md{display:block;font-size:12px;line-height:1.45;color:var(--text-dim)}',
    '.nl-method .nl-badge{position:absolute;top:10px;right:10px}',
    '.nl-badge{font:700 10px/1 var(--font);letter-spacing:.08em;text-transform:uppercase;padding:4px 7px;border-radius:var(--pill);background:var(--panel-3);color:var(--text-dim)}',
    '.nl-badge.is-good{background:var(--good-soft);color:var(--good)}.nl-badge.is-bad{background:var(--bad-soft);color:var(--bad)}.nl-badge.is-accent{background:var(--accent-soft);color:var(--accent)}',
    '.nl-grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,.9fr);gap:16px}',
    '.nl-field{display:flex;flex-direction:column;gap:7px;min-width:0}',
    '.nl-label{font:700 11px/1 var(--font);letter-spacing:.12em;text-transform:uppercase;color:var(--text-dim)}',
    '.nl-input,.nl-select,.nl-area{width:100%;min-height:var(--control-h);padding:0 12px;border-radius:var(--radius-sm);border:1px solid var(--line);background:var(--bg-2);color:var(--text);font:500 14px var(--font);box-sizing:border-box}',
    '.nl-input:focus,.nl-select:focus,.nl-area:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}',
    '.nl-input.is-code{font:700 22px/1 var(--mono);letter-spacing:.3em;text-transform:uppercase;text-align:center;height:52px}',
    '.nl-area{min-height:88px;padding:10px 12px;font:12px/1.45 var(--mono);resize:vertical;word-break:break-all}',
    '.nl-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.nl-row > .nl-input{flex:1;min-width:120px}',
    '.nl-big{font-size:15px}',
    '.nl-room{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:20px;align-items:start}',
    '.nl-main,.nl-side{display:flex;flex-direction:column;gap:20px;min-width:0}',
    '.nl-side{position:sticky;top:0}',
    '.nl-roombar{display:flex;align-items:center;gap:18px;flex-wrap:wrap}',
    '.nl-code{font:800 40px/1 var(--mono);letter-spacing:.24em;background:var(--accent-grad);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;padding-left:.24em}',
    '.nl-roombar .nl-linkbox{flex:1;min-width:240px;display:flex;gap:8px}',
    '.nl-roombar .nl-linkbox .nl-input{font:12.5px var(--mono);color:var(--text-dim)}',
    '.nl-players{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}',
    '.nl-player{position:relative;display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:var(--radius);border:1px solid var(--line);background:var(--panel-2);min-width:0}',
    '.nl-player.is-me{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}',
    '.nl-player.is-ready{box-shadow:inset 0 -2px 0 var(--good)}',
    '.nl-player.is-ai{border-style:dashed;background:transparent;opacity:.8}',
    '.nl-ptop{display:flex;align-items:center;gap:8px;min-width:0}',
    '.nl-pname{font-weight:700;font-size:14px;color:var(--text-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
    '.nl-ptag{font:700 10px/1 var(--font);letter-spacing:.06em;text-transform:uppercase;color:var(--accent);display:inline-flex;align-items:center;gap:3px;flex:none}',
    '.nl-ping{margin-left:auto;display:inline-flex;align-items:flex-end;gap:2px;height:14px;flex:none}',
    '.nl-ping i{display:block;width:3px;border-radius:1px;background:var(--line-2)}',
    '.nl-ping i:nth-child(1){height:5px}.nl-ping i:nth-child(2){height:9px}.nl-ping i:nth-child(3){height:13px}',
    '.nl-ping.is-good i{background:var(--good)}.nl-ping.is-warn i.on{background:var(--warn)}.nl-ping.is-bad i.on{background:var(--bad)}',
    '.nl-ping-ms{font:600 11px var(--mono);color:var(--text-dim);margin-left:5px}',
    '.nl-thumb{height:78px;border-radius:var(--radius-sm);background:radial-gradient(120% 90% at 50% 100%,var(--panel-3),transparent 70%);display:grid;place-items:center;overflow:hidden}',
    '.nl-thumb svg{max-width:100%;max-height:74px;width:auto;height:auto}',
    '.nl-thumb .nl-thumb-ph{width:70%;height:22px;border-radius:12px 18px 6px 6px;opacity:.9}',
    '.nl-model{display:flex;align-items:center;gap:8px;min-width:0}',
    '.nl-swatch{flex:none;width:14px;height:14px;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18),0 0 0 1px rgba(0,0,0,.4)}',
    '.nl-model-name{font-size:13px;font-weight:650;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.nl-model-name small{color:var(--text-dim);font-weight:500}',
    '.nl-specs{display:flex;gap:6px;flex-wrap:wrap}',
    '.nl-spec{font:600 11.5px var(--mono);color:var(--text-dim);padding:3px 7px;border-radius:6px;background:var(--bg-2);border:1px solid var(--line-soft)}',
    '.nl-pfoot{display:flex;align-items:center;gap:8px;justify-content:space-between}',
    '.nl-state{font-size:12px;font-weight:700;color:var(--text-faint)}',
    '.nl-state.is-ready{color:var(--good)}',
    '.nl-settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 18px}',
    '.nl-settings .nl-wide{grid-column:1/-1}',
    '.nl-seg{display:flex;gap:4px;padding:3px;border-radius:var(--radius-sm);background:var(--bg-2);border:1px solid var(--line);flex-wrap:wrap}',
    '.nl-chip-btn{flex:1;min-height:30px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--text-dim);font:600 12.5px var(--font);cursor:pointer;white-space:nowrap}',
    '.nl-chip-btn:hover:not(:disabled){color:var(--text);background:var(--panel-2)}',
    '.nl-chip-btn[aria-pressed="true"]{background:var(--panel-3);color:var(--text-strong);box-shadow:inset 0 -2px 0 var(--accent)}',
    '.nl-chip-btn:disabled{cursor:default}',
    '.nl-tracks{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px;max-height:316px;overflow:auto;padding:2px}',
    '.nl-track{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:var(--radius-sm);border:1px solid var(--line);background:var(--bg-2);color:var(--text);font:inherit;text-align:left;cursor:pointer}',
    '.nl-track:hover:not(:disabled){border-color:var(--line-2)}',
    '.nl-track[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-softer)}',
    '.nl-track:disabled{cursor:default}',
    '.nl-track svg{width:100%;height:58px;display:block}',
    '.nl-track svg polyline{fill:none;stroke:var(--text-dim);stroke-width:2.2;stroke-linejoin:round}',
    '.nl-track[aria-pressed="true"] svg polyline{stroke:var(--accent)}',
    '.nl-track b{font-size:12px;font-weight:650;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.nl-track span{font-size:10.5px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em}',
    '.nl-stepper{display:flex;align-items:center;gap:6px}',
    '.nl-stepper output{min-width:42px;text-align:center;font:700 16px var(--mono);color:var(--text-strong)}',
    '.nl-checks{display:flex;gap:6px 14px;flex-wrap:wrap}',
    '.nl-check{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--text);cursor:pointer}',
    '.nl-check input{accent-color:var(--accent);width:16px;height:16px}',
    '.nl-ro{font-size:13.5px;color:var(--text-strong);font-weight:600}',
    '.nl-go{display:flex;flex-direction:column;gap:10px}',
    '.nl-go .cb-btn{width:100%}',
    '.nl-gate{font-size:12.5px;color:var(--text-dim);text-align:center;min-height:18px}',
    '.nl-gate.is-blocked{color:var(--warn);display:flex;gap:6px;align-items:center;justify-content:center}.nl-gate.is-blocked svg{flex:none}',
    '.nl-start-wrap{display:block;cursor:not-allowed}.nl-start-wrap>.cb-btn{width:100%;pointer-events:none}',
    '.nl-countdown{display:flex;align-items:center;justify-content:center;gap:14px;padding:6px 0}',
    '.nl-countdown output{font:800 56px/1 var(--mono);color:var(--accent);min-width:60px;text-align:center}',
    '.nl-chat{display:flex;flex-direction:column;gap:10px;min-height:280px}',
    '.nl-log{list-style:none;margin:0;padding:0 2px 0 0;display:flex;flex-direction:column;gap:6px;height:260px;overflow-y:auto;font-size:13px;line-height:1.45;overflow-wrap:anywhere}',
    '.nl-log li b{color:var(--accent);font-weight:700;margin-right:6px}',
    '.nl-log li.is-me b{color:var(--accent-2)}',
    '.nl-log li.is-sys{color:var(--text-faint);font-size:12px;font-style:italic}',
    '.nl-log li time{color:var(--text-faint);font:11px var(--mono);margin-right:6px}',
    '.nl-chatform{display:flex;gap:8px}',
    '.nl-chatform .nl-input{flex:1}',
    '.nl-steps{display:flex;flex-direction:column;gap:14px;counter-reset:nlstep}',
    '.nl-step{display:grid;grid-template-columns:30px minmax(0,1fr);gap:12px;align-items:start}',
    '.nl-step::before{counter-increment:nlstep;content:counter(nlstep);width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font:700 13px var(--mono);background:var(--panel-3);color:var(--text-dim);border:1px solid var(--line)}',
    '.nl-step.is-active::before{background:var(--accent-soft);color:var(--accent);border-color:var(--accent-ring)}',
    '.nl-step.is-done::before{content:"\\2713";background:var(--good-soft);color:var(--good);border-color:transparent}',
    '.nl-step.is-later{opacity:.45}',
    '.nl-step > div{display:flex;flex-direction:column;gap:8px;min-width:0}',
    '.nl-step b{font-size:13.5px;color:var(--text-strong)}',
    '.nl-center{max-width:560px;margin:40px auto;text-align:center;align-items:center}',
    '.nl-center h2{font-family:var(--serif);font-size:24px;justify-content:center}',
    '.nl-spinner{width:34px;height:34px;border-radius:50%;border:3px solid var(--line);border-top-color:var(--accent);animation:nl-spin 0.9s linear infinite}',
    '@keyframes nl-spin{to{transform:rotate(360deg)}}',
    '@media (prefers-reduced-motion:reduce){.nl-spinner{animation-duration:3s}}',
    '.nl-notice{display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:var(--radius);border:1px solid color-mix(in srgb,var(--warn) 45%,var(--line));background:var(--warn-soft);font-size:13px}',
    '.nl-notice.is-bad{border-color:color-mix(in srgb,var(--bad) 45%,var(--line));background:var(--bad-soft)}',
    '.nl-notice > div{flex:1}',
    '.nl-results{width:100%;border-collapse:collapse;font-size:13px}',
    '.nl-results td{padding:6px 4px;border-top:1px solid var(--line-soft)}',
    '.nl-results td:first-child{font:700 12px var(--mono);color:var(--accent);width:28px}',
    '.nl-results td:last-child{text-align:right;font:600 12.5px var(--mono);color:var(--text-dim)}',
    '.nl-you{display:flex;gap:14px;align-items:center}',
    '.nl-you .nl-thumb{flex:0 0 150px;height:80px}',
    '.nl-you-body{display:flex;flex-direction:column;gap:6px;min-width:0}',
    '.nl-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    '@media (max-width:1279.98px){.nl-room{grid-template-columns:minmax(0,1fr) 320px}.nl-grid2{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.nl-grid2 > .nl-yourcar{grid-column:1/-1}.nl-wrap{padding:24px 24px 40px}}',
    '@media (max-width:959.98px){.nl-room{grid-template-columns:minmax(0,1fr)}.nl-side{position:static}.nl-methods{grid-template-columns:minmax(0,1fr)}.nl-settings{grid-template-columns:minmax(0,1fr)}.nl-code{font-size:32px}}',
    '@media (max-width:719.98px){.nl-grid2{grid-template-columns:minmax(0,1fr)}.nl-wrap{padding:18px 14px 32px}.nl-head h1{font-size:27px}.nl-players{grid-template-columns:minmax(0,1fr)}.nl-head-actions{margin-left:0}}',
    /* touch screens: 40px+ tap targets and notch / home-bar safe areas (desktop unchanged) */
    '@media (pointer:coarse){.nl-wrap{padding-left:max(14px,env(safe-area-inset-left));padding-right:max(14px,env(safe-area-inset-right));padding-bottom:max(32px,calc(env(safe-area-inset-bottom) + 16px))}.nl-wrap .cb-btn{min-height:44px}.nl-chip-btn{min-height:40px}.nl-input{min-height:44px}.nl-chatform .cb-btn{min-width:44px}.nl-stepper .cb-btn{min-width:44px;min-height:44px}.nl-check{min-height:44px;padding-right:4px}.nl-check input{width:20px;height:20px}.nl-area{-webkit-user-select:text;user-select:text}}',
    '@media (pointer:coarse) and (min-width:720px){.nl-wrap{padding-left:max(24px,env(safe-area-inset-left));padding-right:max(24px,env(safe-area-inset-right))}}'
  ].join('\n');
  function injectStyles() {
    if (!hasDOM || document.getElementById('net-lobby-styles')) return;
    var s = document.createElement('style');
    s.id = 'net-lobby-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ---------------------------------------------------------------- layer / routing */
  var ROUTE = 'multiplayer';
  function routerKnows() { var R = CB.router; return !!(R && Array.isArray(R.routes) && R.routes.indexOf(ROUTE) >= 0 && typeof R.on === 'function'); }
  function ensureLayer() {
    if (A.layer && A.layer.isConnected) return A.layer;
    injectStyles();
    var el = document.getElementById('screen-multiplayer');
    if (!el) {
      el = document.createElement('section');
      el.id = 'screen-multiplayer';
      el.setAttribute('data-route', ROUTE);
      el.setAttribute('aria-label', 'Multiplayer lobby');
      el.hidden = true;
      (document.getElementById('app-root') || document.body).appendChild(el);
    }
    el.classList.add('cb-screen');
    A.layer = el;
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('keydown', onKey);
    el.addEventListener('submit', function (e) { e.preventDefault(); onSubmit(e.target); });
    return el;
  }
  function showLayer(on) {
    var el = ensureLayer();
    el.hidden = !on;
    el.classList.toggle('is-active', !!on);
    document.documentElement.classList.toggle('nl-open', !!on);
    var nav = document.querySelector('#gnav [data-nav-route="multiplayer"]');
    if (nav && !routerKnows()) { nav.classList.toggle('is-active', !!on); if (on) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current'); }
    if (on) startTimers(); else if (!A.core) stopTimers();
  }
  function isOpen() { return !!(A.layer && !A.layer.hidden); }
  function setUrl(code) {
    var h = '#/multiplayer' + (code ? '/' + normCode(code) : '');
    if (window.location.hash === h) return;
    safe(function () { history.replaceState(history.state, '', h); });
  }

  /** open({code}) — show the lobby; a code joins that room (online / same device). */
  function open(opts) {
    if (!hasDOM) return false;
    opts = opts || {};
    ensureLayer();
    showLayer(true);
    if (A.raceOpen) return true;
    var code = normCode(opts.code || '');
    if (!A.core && A.view === 'home' && code && !A.busy) {
      A.code = code;
      render();
      autoJoin(code);
    } else render();
    return true;
  }
  function hide() { if (A.layer) showLayer(false); }

  /* fallback routing (router without a 'multiplayer' route) */
  function onHashChange(e) {
    if (routerKnows()) return;
    // newURL: the router may already have rewritten an unknown '#/multiplayer' to '#/menu' if it listened first
    var nu = e && e.newURL ? String(e.newURL) : '', hi = nu.indexOf('#');
    var p = parseHash(hi >= 0 ? nu.slice(hi) : window.location.hash);
    if (p) {
      A.fallbackOpen = true; A.guard = true;
      setTimeout(function () { A.guard = false; }, 0);
      open(p);
      setTimeout(function () { if (isOpen()) setUrl(p.code || (A.core && A.core.state().code) || ''); }, 0);
    } else if (A.fallbackOpen) { A.fallbackOpen = false; hide(); }
  }
  function onRouterRoute() {
    if (routerKnows() || !A.fallbackOpen) return;
    if (A.guard) return;
    A.fallbackOpen = false; hide();
  }
  function onDocClick(e) {
    if (routerKnows() || e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var a = e.target && e.target.closest && e.target.closest('[data-go], a[href^="#/multiplayer"]');
    if (!a || (A.layer && A.layer.contains(a))) return;
    var go = a.getAttribute('data-go'), href = a.getAttribute('href') || '';
    if (go === ROUTE || (!go && parseHash(href))) {
      e.preventDefault(); e.stopPropagation();
      var p = parseHash(href) || { code: '' };
      safe(function () { history.pushState({ cbRoute: '#/multiplayer' }, '', '#/multiplayer' + (p.code ? '/' + p.code : '')); });
      A.fallbackOpen = true;
      open(p);
    } else if (A.fallbackOpen) {
      // another nav item while our overlay is up: give the screen back to the router
      A.fallbackOpen = false; hide();
      var R = CB.router, c = R && R.current ? R.current() : null;
      if (c && R._ && R._.format) safe(function () { history.replaceState(history.state, '', R._.format(c.route, c.sub, c.params)); });
    }
  }
  var bootHash = hasDOM ? String(window.location.hash || '') : '';
  var installed = false;
  function install() {
    if (installed || !hasDOM) return;
    var R = CB.router;
    if (!R) return;
    installed = true;
    if (routerKnows()) {
      R.on(ROUTE, function (el, params, ctx) { open({ code: (ctx && ctx.sub) || (params && params.code) || '' }); }, function () { hide(); });
      return;
    }
    var p = parseHash(bootHash);
    if (p) { A.fallbackOpen = true; open(p); setTimeout(function () { setUrl(p.code); }, 0); }
  }
  if (hasDOM) {
    window.addEventListener('hashchange', onHashChange);
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('cb:route', onRouterRoute);
    document.addEventListener('cb:router-ready', install);
    if (CB.router && typeof CB.router.isBooted === 'function' && CB.router.isBooted()) setTimeout(install, 0);
  }

  /* ---------------------------------------------------------------- timers */
  function startTimers() {
    if (A.timers.tick) return;
    A.timers.tick = setInterval(function () {
      var c = A.core;
      if (!c) return;
      if (c.tick()) return;
      if (c.state().phase === 'countdown') renderCountdown();
    }, 100);
    A.timers.ping = setInterval(function () { if (A.core) { A.core.refreshPings(); } }, 2000);
  }
  function stopTimers() { clearInterval(A.timers.tick); clearInterval(A.timers.ping); A.timers = {}; }

  /* ---------------------------------------------------------------- online probe */
  function probeOnline() {
    if (A.onlineOk != null) return Promise.resolve(A.onlineOk);
    var S = CB.net && CB.net.signal;
    var direct = S ? call(S, ['available', 'isAvailable', 'detect', 'probe'], ['vercel']) : undefined;
    var p;
    if (direct !== undefined) {
      p = asPromise(direct).then(function (v) { return v === true || v === 'vercel' || (isObj(v) && (v.ok || v.backend === 'vercel')); });
    } else if (window.location.protocol === 'file:' || typeof fetch !== 'function') {
      p = Promise.resolve(false);
    } else {
      p = withTimeout(fetch('api/signal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"ping"}' }), 3500, 'probe')
        .then(function (r) { if (r.status === 404 || r.status === 405 || r.status === 501) return false; return r.json().then(function (j) { return !!j && j.code !== 'no-backend'; }, function () { return false; }); });
    }
    return p.then(function (v) { A.onlineOk = !!v; return A.onlineOk; }, function () { A.onlineOk = false; return false; });
  }
  function chosenMethod() {
    if (A.method) return A.method;
    var saved = lsGet(LS_METHOD);
    if (saved === 'manual' || saved === 'local') return saved;
    return A.onlineOk === false ? 'manual' : 'online';
  }

  /* ---------------------------------------------------------------- connect flows */
  function failure(e, retry) {
    A.busy = false;
    A.error = { message: (e && e.message) || String(e || 'Something went wrong'), retry: retry || null };
    A.view = 'error';
    render();
  }
  function bindCore(core) {
    A.core = core;
    A.chatSeen = 0;
    core.on('change', function () { render(); });
    core.on('launch', launch);
    core.on('closed', function (info) {
      ssSet(SS_LAST, info.reason === 'left' || info.reason === 'kicked' ? null : ssGet(SS_LAST));
      if (info.reason === 'left') return;
      A.closedInfo = info;
      A.view = 'closed';
      teardownNet();
      render();
    });
    if (!A.stateUnsub && CB.state && typeof CB.state.subscribe === 'function') {
      var t = null;
      A.stateUnsub = CB.state.subscribe(function () {
        clearTimeout(t);
        t = setTimeout(function () { if (A.core && A.core.state().phase === 'lobby') A.core.setProfile(null, myBuild()); }, 700);
      }) || true;
    }
  }
  function teardownNet() {
    var n = A.net;
    A.net = null;
    if (!n) return;
    safe(function () { if (n.host) call(n.host, ['close', 'destroy']); });
    safe(function () { if (n.peer) n.peer.close(); });
    safe(function () { if (n.sig) call(n.sig, ['close', 'destroy']); });
  }
  function hostToLocalFrom(peerRaw) {
    return function (t) {
      var off = null;
      safe(function () {
        off = typeof peerRaw.clockOffset === 'function' ? peerRaw.clockOffset() : peerRaw.clockOffset != null ? peerRaw.clockOffset : peerRaw.offset;
      });
      off = Number(off);
      // offset = hostClock - localClock (transport convention); fall back to "a countdown from now"
      return isFinite(off) ? t - off : t;
    };
  }

  function createRoom() {
    var method = chosenMethod();
    var miss = netMissing();
    if (miss.length) return failure(new Error('Multiplayer networking is still being installed: ' + miss.join(', ') + ' did not load on this page.'));
    A.busy = true; A.view = 'connecting'; A.connectingText = method === 'manual' ? 'Preparing your room…' : 'Creating a room…'; render();
    var sig;
    try { sig = openSignal(method); } catch (e) { return failure(e); }
    withTimeout(call(sig, ['create', 'createRoom', 'host']), 15000, 'The signalling server did not answer in time.').then(function (res) {
      // manual rooms have no joinable code (sig.room is an internal tag): no code / link is shown
      var code = method === 'manual' ? '' : normCode((isObj(res) && (res.code || res.room)) || (typeof res === 'string' ? res : '') || sig.code || '');
      var T = CB.net.transport;
      // relay: server-relay fallback (js/net/relay.js) when a network blocks direct WebRTC (campus Wi-Fi, strict NATs)
      var host = call(T, ['host', 'createHost', 'listen'], [sig, { relay: method === 'online' }]);
      return asPromise(host).then(function (h) {
        if (!h) throw new Error('The WebRTC transport could not start a room.');
        A.net = { role: 'host', sig: sig, host: h, method: method, peers: {} };
        var core = createCore({ role: 'host', selfId: (h.id != null ? String(h.id) : 'host'), pid: pid(), name: myName(), build: myBuild(), code: code || null, version: protocol(),
          clock: typeof h.now === 'function' ? function () { return h.now(); } : null });
        bindCore(core);
        listen(h, ['peer', 'join', 'connection'], function (raw) {
          if (!raw || !A.core || A.core !== core) return;
          var id = String(raw.id != null ? raw.id : raw.peerId);
          if (A.net.peers[id]) return;
          var w = wrapPeer(raw, function (msg) { core.receive(id, msg); }, function (why) { delete (A.net ? A.net.peers : {})[id]; core.peerClosed(id, why); },
            function (stt) { core.setLink(id, stt); });
          A.net.peers[id] = w;
          core.addPeer(w);
          if (A.manual && A.manual.step === 2) { A.manual.step = 3; render(); }
        });
        if (typeof h.on === 'function') {
          h.on('peer-leave', function (raw, why) { var id = raw && String(raw.id); if (!id || !A.net) return; var w = A.net.peers[id]; delete A.net.peers[id]; if (w) w.close(); core.peerClosed(id, why); });
          h.on('peer-state', function (raw, stt) { if (raw && raw.id != null) core.setLink(String(raw.id), stt); });
        }
        A.busy = false;
        A.view = 'room';
        A.manual = method === 'manual' ? { role: 'host', step: 0, invite: '', reply: '' } : null;
        if (code) { setUrl(code); ssSet(SS_LAST, { method: method, code: code, role: 'host' }); }
        render();
        if (method === 'manual') manualInvite();
      });
    }).catch(function (e) { failure(e, createRoom); });
  }

  function joinRoom(code, method) {
    method = method || chosenMethod();
    var miss = netMissing();
    if (miss.length) return failure(new Error('Multiplayer networking is still being installed: ' + miss.join(', ') + ' did not load on this page.'));
    if (method === 'manual') { A.view = 'manual-guest'; A.manual = { role: 'guest', step: 1, invite: '', reply: '' }; render(); return; }
    code = normCode(code);
    if (code.length < 4) { toast('Room codes are 5 letters/numbers', 'warning'); return; }
    A.busy = true; A.code = code; A.view = 'connecting'; A.connectingText = 'Joining room ' + code + '…'; render();
    var sig;
    try { sig = openSignal(method); } catch (e) { return failure(e); }
    withTimeout(call(sig, ['join', 'joinRoom'], [code]), 15000, 'The signalling server did not answer in time.')
      .then(function (res) {
        if (isObj(res) && res.ok === false) throw new Error(res.code || res.error || 'join failed');
        return guestConnect(sig, method, code);
      })
      .catch(function (e) { failure(friendlyJoinError(e), function () { joinRoom(code, method); }); });
  }
  function friendlyJoinError(e) {
    var m = (e && (e.code || e.message)) || '';
    if (/not.?found|no.?room|unknown/i.test(m)) return new Error('No room with that code. Check the code with your friend — rooms expire after 2 hours.');
    if (/full/i.test(m)) return new Error(REASONS.full);
    if (/no-backend/i.test(m)) return new Error('Online play is not set up on this site yet. Use “Invite code” instead.');
    return e instanceof Error ? e : new Error(String(m || 'Could not join the room'));
  }
  function guestConnect(sig, method, code) {
    var T = CB.net.transport;
    A.connectingText = 'Connecting to the host…'; render();
    var raw = call(T, ['connect', 'join', 'dial'], [sig, { relay: method === 'online' }]);
    return withTimeout(asPromise(raw).then(function (peerRaw) {
      if (!peerRaw) throw new Error('Could not open a connection to the host.');
      return waitOpen(peerRaw);
    }), method === 'manual' ? 600000 : 25000, 'The connection timed out. Strict networks (some offices, mobile hotspots) may need a TURN relay.')
      .then(function (peerRaw) { attachGuest(sig, peerRaw, method, code); });
  }
  function waitOpen(peerRaw) {
    if (peerRaw.ready && typeof peerRaw.ready.then === 'function') return peerRaw.ready.then(function () { return peerRaw; });
    var st = safe(function () { return typeof peerRaw.state === 'function' ? peerRaw.state() : peerRaw.state || peerRaw.readyState; });
    if (st == null || st === 'open' || st === 'connected' || typeof peerRaw.on !== 'function') return Promise.resolve(peerRaw);
    return new Promise(function (res, rej) {
      peerRaw.on('open', function () { res(peerRaw); });
      peerRaw.on('state', function (s) { s = isObj(s) ? s.state : s; if (s === 'open' || s === 'connected') res(peerRaw); else if (s === 'failed' || s === 'closed') rej(new Error('The connection to the host failed.')); });
    });
  }
  function attachGuest(sig, peerRaw, method, code) {
    var core;
    var w = wrapPeer(peerRaw, function (msg) { if (core) core.receive('host', msg); }, function (why) { if (core) core.peerClosed('host', why); },
      function (stt) { if (core) core.setLink('host', stt); });
    A.net = { role: 'guest', sig: sig, peer: w, method: method };
    core = createCore({ role: 'guest', selfId: String(peerRaw.selfId || peerRaw.localId || 'me'), pid: pid(), name: myName(), build: myBuild(), code: code || null, version: protocol(), send: function (m) { w.send(m); }, hostToLocal: hostToLocalFrom(peerRaw),
      clock: typeof peerRaw.now === 'function' ? function () { return peerRaw.now(); } : null });
    bindCore(core);
    core.hello();
    A.busy = false; A.view = 'room'; A.manual = null;
    if (code) { setUrl(code); ssSet(SS_LAST, { method: method, code: code, role: 'guest' }); }
    render();
  }
  function autoJoin(code) {
    // deep link: online if the server answers, else same-device (BroadcastChannel) when another tab hosts it
    A.busy = true; A.view = 'connecting'; A.connectingText = 'Looking for room ' + code + '…'; render();
    probeOnline().then(function (ok) {
      A.busy = false;
      var last = ssGet(SS_LAST);
      var method = A.method || (last && last.code === code && last.method !== 'manual' ? last.method : ok ? 'online' : 'local');
      A.method = method;
      joinRoom(code, method);
    });
  }

  /* manual (invite code) flow */
  function manualCodes(sig, fn) { listen(sig, ['code', 'local', 'outgoing', 'signal'], function (c) { var s = isObj(c) ? (c.code || c.text || c.data) : c; if (typeof s === 'string' && s) fn(s); }); }
  function manualInvite() {
    var n = A.net, M = A.manual;
    if (!n || !M) return;
    M.step = 1; M.invite = ''; M.reply = ''; render();
    if (!M.listening) { M.listening = true; manualCodes(n.sig, function (c) { if (A.manual && A.manual.role === 'host') { A.manual.invite = c; render(); } }); }
    var r = call(n.host, ['invite', 'createInvite', 'offer']);
    if (r === undefined) r = call(n.sig, ['invite', 'createInvite', 'offer']);
    asPromise(r).then(function (c) {
      var s = isObj(c) ? (c.code || c.text) : c;
      if (typeof s === 'string' && s && A.manual) { A.manual.invite = s; render(); }
    }, function (e) { toast('Could not create an invite: ' + ((e && e.message) || e), 'error'); });
  }
  function manualAcceptReply(text) {
    var n = A.net, M = A.manual;
    text = String(text || '').trim();
    if (!n || !M || !text) return;
    var r = hasFn(n.host, ['accept', 'acceptReply', 'answer']) ? call(n.host, ['accept', 'acceptReply', 'answer'], [text]) : call(n.sig, ['paste', 'accept', 'receive', 'input', 'feed', 'submit'], [text]);
    M.step = 2; render();
    asPromise(r).catch(function (e) { M.step = 1; render(); toast('That reply code did not work: ' + ((e && e.message) || e), 'error'); });
  }
  function manualGuestPasteInvite(text) {
    text = String(text || '').trim();
    var M = A.manual;
    if (!M || !text) return;
    var sig;
    try { sig = openSignal('manual'); } catch (e) { return failure(e); }
    M.step = 2; M.reply = ''; render();
    manualCodes(sig, function (c) { if (A.manual && A.manual.role === 'guest') { A.manual.reply = c; A.manual.step = 2; render(); } });
    var j = hasFn(sig, ['join', 'joinRoom']) ? call(sig, ['join', 'joinRoom'], [text]) : call(sig, ['paste', 'accept', 'receive', 'input'], [text]);
    asPromise(j).then(function (res) {
      var s = isObj(res) ? (res.reply || res.code || res.answer) : typeof res === 'string' ? res : null;
      if (s && A.manual) { A.manual.reply = s; render(); }
      var done = guestConnect(sig, 'manual', '');
      if (typeof sig.answer === 'function') asPromise(sig.answer()).then(function (c) { if (typeof c === 'string' && A.manual && !A.manual.reply) { A.manual.reply = c; render(); } }, function () {});
      return done;
    }).catch(function (e) { if (A.manual) { A.manual.step = 1; } failure(e, function () { joinRoom('', 'manual'); }); });
  }

  function protocol() {
    var N = CB.net || {};
    var tp = String(N.PROTOCOL || (N.transport && (N.transport.PROTO || N.transport.PROTOCOL)) || (N.race && (N.race.PROTO || N.race.PROTOCOL)) || '');
    return tp && tp !== PROTOCOL ? PROTOCOL + '+' + tp : PROTOCOL;   // lobby protocol (arcade-aware) + the transport's
  }

  function leaveRoom() {
    if (A.core) { var c = A.core; A.core = null; safe(function () { c.leave(); }); }
    destroySession();
    teardownNet();
    ssSet(SS_LAST, null);
    A.view = 'home'; A.manual = null; A.error = null; A.closedInfo = null; A.notice = null; A.lastHtml = {};
    if (isOpen()) setUrl('');
    render();
  }
  function rejoin() {
    var info = A.lastRoom || ssGet(SS_LAST);
    var core = A.core;
    A.core = null; A.view = 'home';
    if (core) safe(function () { core.close('left'); });
    teardownNet();
    if (info && info.code && info.role === 'guest') { A.method = info.method; joinRoom(info.code, info.method); }
    else render();
  }

  /* ---------------------------------------------------------------- race launch */
  function destroySession() {
    var s = A.session;
    A.session = null;
    if (s) safe(function () { call(s, ['destroy', 'close', 'dispose']); });
  }
  function launch(info) {
    var R = CB.net && CB.net.race;
    var factory = R && (typeof R.createSession === 'function' ? R.createSession : typeof R.create === 'function' ? R.create : null);
    var hasNet = R && (typeof R.createHostSession === 'function' || factory);
    var core = A.core;
    if (info.spectator) { A.notice = { kind: 'warn', text: 'A race started without you (you joined late). You are in for the rematch.' }; render(); return; }
    if (!hasNet) {
      A.notice = { kind: 'warn', text: 'The multiplayer race engine (js/net/netrace.js) is not loaded on this page yet, so the race cannot start.', back: true };
      if (core && core.isHost()) core.raceEnded(undefined);
      render();
      return;
    }
    var n = A.net || {};
    function uiHooks() { var U = CB.race && CB.race.ui; try { return U && typeof U.netHooks === 'function' ? U.netHooks() : undefined; } catch (e) { return undefined; } }
    var session, c = info.cfg, st = core.state();
    var NA = CB.net && CB.net.arcade;
    if (c.mode === 'arcade' && !NA) {
      A.notice = { kind: 'warn', text: 'Arcade multiplayer (js/net/netarcade.js) is not loaded on this page, so the race cannot start.', back: true };
      if (core.isHost()) core.raceEnded(undefined);
      render();
      return;
    }
    var steer = c.maxSteerAssist === 'off' ? 'off' : c.maxSteerAssist === 'light' || c.maxSteerAssist === 'medium' ? c.maxSteerAssist : 'heavy';
    try {
      if (c.mode === 'arcade' && core.isHost() && n.host) {
        session = NA.createHostSession(n.host, {
          trackId: c.trackId, laps: c.laps || 3, weather: c.weather, timeOfDay: c.timeOfDay, ai: c.ai, difficulty: c.difficulty, arcade: { options: c.arcade || {} },
          build: myBuild(), name: myName(), seed: info.seed, maxSteerAssist: c.maxSteerAssist, steerAssist: steer,
          players: c.players.filter(function (p) { return p.id !== st.selfId; }).map(function (p) { return { peerId: p.id, name: p.name, build: p.build, steerAssist: steer }; }),
          hooks: uiHooks()
        });
      } else if (c.mode === 'arcade' && n.peer) {
        session = NA.createClientSession(n.peer.raw, { start: NA.isArcadeStart(st.netStart) ? st.netStart : undefined, build: myBuild(), name: myName(), steerAssist: steer, hooks: uiHooks() });
      } else if (core.isHost() && typeof R.createHostSession === 'function' && n.host) {
        session = R.createHostSession(n.host, {
          mode: c.mode, trackId: c.trackId, laps: c.laps || 1, weather: c.weather, timeOfDay: c.timeOfDay, ai: c.ai,
          build: myBuild(), name: myName(), seed: info.seed, gridOrder: 'given',
          players: c.players.filter(function (p) { return p.id !== st.selfId; }).map(function (p) { return { peerId: p.id, name: p.name, build: p.build }; }),
          assistsAllowed: { abs: c.assists.abs, tc: c.assists.tc, autoShift: c.assists.autoShift, racingLine: c.assists.racingLine, steeringAssist: c.maxSteerAssist !== 'off' },
          drift: { assistLevel: c.maxSteerAssist === 'auto' ? 'heavy' : c.maxSteerAssist },
          resolvePlayer: function (pid) { var p = core.player(pid); return p ? { name: p.name, build: p.build } : null; },
          hooks: uiHooks()
        });
      } else if (!core.isHost() && typeof R.createClientSession === 'function' && n.peer) {
        session = R.createClientSession(n.peer.raw, { start: st.netStart || undefined, build: myBuild(), name: myName(), hooks: uiHooks() });
      } else if (factory) {
        session = factory.call(R, {
          role: core.role, isHost: core.isHost(), selfId: st.selfId, cfg: c, seed: info.seed, t0: info.t0,
          players: info.players, build: myBuild(), host: n.host || null, peer: n.peer ? n.peer.raw : null,
          peers: function () { return Object.keys(n.peers || {}).map(function (k) { return n.peers[k].raw; }); }, lobby: api
        });
      } else throw new Error('no session factory');
    } catch (e) {
      A.notice = { kind: 'bad', text: 'The race could not start: ' + ((e && e.message) || e), back: true };
      if (core.isHost()) core.raceEnded(undefined);
      render();
      return;
    }
    A.session = session;
    var ui = CB.race && CB.race.ui;
    var track = null;
    var T = CB.race && CB.race.tracks;
    if (T && typeof T.get === 'function') track = safe(function () { return T.get(info.cfg.trackId); }) || null;
    var cfg = Object.assign({}, info.cfg, {
      track: track, selfId: core.state().selfId, isHost: core.isHost(), build: myBuild(), seed: info.seed, t0: info.t0,
      onClose: function (results) { raceFinished(session, results); }
    });
    if (ui && typeof ui.openNet === 'function') {
      A.raceOpen = true;
      hide();
      try { ui.openNet(session, cfg); } catch (e) { A.raceOpen = false; open({}); A.notice = { kind: 'bad', text: 'The race screen failed to open: ' + ((e && e.message) || e), back: true }; render(); }
    } else {
      A.notice = { kind: 'warn', text: 'Race UI integration pending: CB.race.ui.openNet(session, cfg) is not available yet. The network session is running in the background.', back: true };
      render();
    }
  }
  function raceFinished(session, results) {
    if (results === undefined && session) results = safe(function () { return typeof session.results === 'function' ? session.results() : session.results; });
    if (session && session === A.session) destroySession();
    A.raceOpen = false;
    A.notice = null;
    if (A.core) A.core.raceEnded(results === undefined ? null : results);
    var code = A.core && A.core.state().code;
    if (routerKnows()) CB.router.go(ROUTE + (code ? '/' + code : ''));
    else { A.fallbackOpen = true; safe(function () { history.pushState({ cbRoute: '#/multiplayer' }, '', '#/multiplayer' + (code ? '/' + code : '')); }); open({}); }
  }

  /* ---------------------------------------------------------------- rendering */
  function patch(el, html) {
    if (!el) return;
    if (el.__nlHtml === html) return;
    var ae = document.activeElement, key = ae && el.contains(ae) ? ae.getAttribute('data-k') : null;
    var selStart = key && ae && typeof ae.selectionStart === 'number' ? ae.selectionStart : null;
    el.innerHTML = html;
    el.__nlHtml = html;
    if (key) {
      var n = el.querySelector('[data-k="' + key.replace(/"/g, '') + '"]');
      if (n) { n.focus({ preventScroll: true }); if (selStart != null && typeof n.setSelectionRange === 'function') safe(function () { n.setSelectionRange(selStart, selStart); }); }
    }
  }
  function q(sel) { return A.layer ? A.layer.querySelector(sel) : null; }

  function render() {
    if (!hasDOM || !A.layer) return;
    var view = A.view === 'room' && !A.core ? 'home' : A.view;
    if (A.layer.__view !== view) {
      A.layer.__view = view;
      A.layer.innerHTML = '<div class="nl-wrap">' + headHtml() + '<div class="nl-body"></div></div>';
      A.layer.__nlHtml = null;
      var body = q('.nl-body');
      if (view === 'room') {
        body.innerHTML = '<div class="nl-notice-slot"></div><div class="nl-room"><div class="nl-main"><section class="nl-card nl-roombar-card"></section><div class="nl-manual-slot"></div><section class="nl-card"><h2>Drivers <span class="nl-count"></span></h2><div class="nl-players"></div></section><section class="nl-card"><h2>Session settings <span class="nl-hostonly"></span></h2><div class="nl-settings"></div></section></div>' +
          '<aside class="nl-side"><section class="nl-card nl-go"></section><section class="nl-card nl-results-slot" hidden></section><section class="nl-card nl-chat"><h2>Chat</h2><ul class="nl-log" aria-live="polite" aria-label="Chat messages"></ul>' +
          '<form class="nl-chatform" data-form="chat"><label class="nl-sr" for="nl-chat-in">Message</label><input id="nl-chat-in" class="nl-input" data-k="chat" maxlength="400" autocomplete="off" placeholder="Say something… 🏁"><button class="cb-btn primary icon-btn" type="submit" aria-label="Send message">' + svg('send', 16) + '</button></form></section></aside></div>';
        A.chatSeen = 0;
      }
    } else {
      var hh = q('.nl-head');
      if (hh) { var tmp = document.createElement('div'); tmp.innerHTML = headHtml(); if (hh.outerHTML !== tmp.firstChild.outerHTML) hh.parentNode.replaceChild(tmp.firstChild, hh); }
    }
    var b = q('.nl-body');
    if (view === 'home') patch(b, homeHtml());
    else if (view === 'connecting') patch(b, centerHtml('<div class="nl-spinner" role="progressbar" aria-label="Connecting"></div><h2>' + esc(A.connectingText || 'Connecting…') + '</h2><p class="nl-hint">This usually takes a couple of seconds.</p><div class="nl-row"><button class="cb-btn ghost" data-act="cancel">Cancel</button></div>'));
    else if (view === 'error') patch(b, centerHtml('<h2>Could not connect</h2><p class="nl-hint" role="alert">' + esc(A.error && A.error.message) + '</p><div class="nl-row">' + (A.error && A.error.retry ? '<button class="cb-btn primary" data-act="retry">' + svg('refresh') + 'Try again</button>' : '') + '<button class="cb-btn ghost" data-act="home">Back</button></div><p class="nl-hint">Tip: if Online does not work, “Invite code” connects without any server.</p>'));
    else if (view === 'closed') {
      var ci = A.closedInfo || {};
      var canRe = ci.reason === 'host-lost' && (ssGet(SS_LAST) || {}).role === 'guest';
      if (canRe) A.lastRoom = ssGet(SS_LAST);
      patch(b, centerHtml('<h2>' + esc(ci.reason === 'kicked' ? 'Removed from the room' : ci.reason === 'host-lost' ? 'Connection lost' : 'Room closed') + '</h2><p class="nl-hint" role="alert">' + esc(ci.message || '') + '</p><div class="nl-row">' + (canRe ? '<button class="cb-btn primary" data-act="rejoin">' + svg('refresh') + 'Rejoin</button>' : '') + '<button class="cb-btn ghost" data-act="home">Back to multiplayer</button></div>'));
    }
    else if (view === 'manual-guest') patch(b, manualGuestHtml());
    else if (view === 'room') renderRoom();
  }
  function centerHtml(inner) { return '<section class="nl-card nl-center">' + inner + '</section>'; }
  function headHtml() {
    var c = A.core && A.core.state().phase !== 'closed' && A.view === 'room' ? A.core : null, st = c && c.state();
    var status = !c ? '' : st.phase === 'countdown' ? '<span class="nl-pill"><span class="nl-dot is-warn"></span>Starting</span>' : st.phase === 'racing' ? '<span class="nl-pill"><span class="nl-dot is-warn"></span>Racing</span>' : st.connected ? '<span class="nl-pill"><span class="nl-dot is-good"></span>' + (c.isHost() ? 'Hosting' : 'Connected') + '</span>' : '<span class="nl-pill"><span class="nl-dot"></span>Joining…</span>';
    return '<header class="nl-head"><div><div class="nl-eyebrow">Multiplayer</div><h1>' + (c ? (c.isHost() ? 'Your room' : 'Room lobby') : 'Race with friends') + '</h1>' +
      (c ? '' : '<p class="nl-sub">Peer-to-peer: up to 8 drivers, each in their own Garage build. The host runs the race; everyone sees everyone.</p>') + '</div>' +
      '<div class="nl-head-actions">' + status + (c ? '<button class="cb-btn ghost danger" data-act="leave">' + svg('leave') + 'Leave room</button>' : '') + '</div></header>';
  }

  function carCardHtml(build, opts) {
    opts = opts || {};
    var s = carSummary(build, true);
    var thumb = s.thumb || '<div class="nl-thumb-ph" style="background:' + esc(s.paint) + '"></div>';
    var specs = [s.hp != null ? s.hp + ' hp' : null, s.kg != null ? s.kg.toLocaleString('en-US') + ' kg' : null, s.drive || null].filter(Boolean);
    return '<div class="nl-thumb" aria-hidden="true">' + thumb + '</div>' +
      '<div class="nl-model"><span class="nl-swatch" style="background:' + esc(s.paint) + '" title="Paint ' + esc(s.paint) + '"></span><span class="nl-model-name" title="' + esc((s.make + ' ' + s.name).trim()) + '">' + esc(s.make) + ' ' + esc(s.name) + (s.gen ? ' <small>' + esc(s.gen) + '</small>' : '') + '</span></div>' +
      '<div class="nl-specs">' + specs.map(function (x) { return '<span class="nl-spec">' + esc(x) + '</span>'; }).join('') + '</div>';
  }
  function pingHtml(ms, isSelfHost) {
    if (isSelfHost) return '<span class="nl-ping is-good" title="Host"><i class="on"></i><i class="on"></i><i class="on"></i></span>';
    var lvl = ms <= 0 ? 0 : ms < 80 ? 3 : ms < 160 ? 2 : 1, cls = lvl === 3 ? 'is-good' : lvl === 2 ? 'is-warn' : lvl === 1 ? 'is-bad' : '';
    return '<span class="nl-ping ' + cls + '" title="Ping ' + (ms > 0 ? ms + ' ms' : 'measuring…') + '" aria-label="Ping ' + (ms > 0 ? ms + ' milliseconds' : 'unknown') + '">' + [1, 2, 3].map(function (i) { return '<i class="' + (i <= lvl ? 'on' : '') + '"></i>'; }).join('') + '</span><span class="nl-ping-ms">' + (ms > 0 ? ms : '–') + '</span>';
  }

  function homeHtml() {
    var m = chosenMethod(), b = myBuild();
    var methods = METHODS.map(function (x) {
      var badge = x.id === 'online' ? (A.onlineOk == null ? '<span class="nl-badge">Checking…</span>' : A.onlineOk ? '<span class="nl-badge is-good">Available</span>' : '<span class="nl-badge is-bad">Not set up</span>') : x.id === 'manual' ? '<span class="nl-badge is-accent">No server</span>' : '';
      var ic = x.id === 'online' ? 'globe' : x.id === 'manual' ? 'ticket' : 'tabs';
      return '<button type="button" class="nl-method" role="radio" aria-checked="' + (m === x.id) + '" tabindex="' + (m === x.id ? 0 : -1) + '" data-act="method" data-v="' + x.id + '" data-k="m-' + x.id + '">' + badge + '<span class="nl-mi">' + svg(ic, 20) + '</span><span><b>' + esc(x.name) + '</b><span class="nl-md">' + esc(x.desc) + '</span></span></button>';
    }).join('');
    var miss = netMissing();
    var notice = miss.length ? '<div class="nl-notice"><div><b>Networking modules pending.</b> ' + esc(miss.join(', ')) + ' did not load on this page yet — creating or joining a room will become available once they ship.</div></div>' : '';
    var onlineDown = m === 'online' && A.onlineOk === false;
    var joinBody = m === 'manual'
      ? '<p class="nl-hint">Your friend creates a room with <b>Invite code</b> selected and sends you an invite code. You paste it on the next screen and send back a reply code.</p><button class="cb-btn ghost large" data-act="join-manual">I have an invite code</button>'
      : '<form class="nl-field" data-form="join"><label class="nl-label" for="nl-join-code">Room code</label><div class="nl-row"><input id="nl-join-code" class="nl-input is-code" data-k="join-code" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE" value="' + esc(A.code || '') + '" aria-describedby="nl-join-hint"></div><button class="cb-btn primary large" type="submit"' + (onlineDown ? ' disabled' : '') + '>Join room</button></form><p class="nl-hint" id="nl-join-hint">Or just open the link your friend sent — it joins automatically.</p>';
    return notice +
      '<section class="nl-card"><h2>How do you want to connect?</h2><div class="nl-methods" role="radiogroup" aria-label="Connection method">' + methods + '</div>' +
      (onlineDown ? '<p class="nl-hint">Online rooms need the site’s signalling function (Vercel + Upstash). It is not configured here — use <b>Invite code</b>, which works without any server.</p>' : '<p class="nl-hint">All driving data flows directly between players (WebRTC). Some strict networks need a TURN relay (<code>window.REDLINE_TURN</code>).</p>') + '</section>' +
      '<div class="nl-grid2">' +
        '<section class="nl-card"><h2>' + svg('crown', 18) + 'Host a room</h2><p class="nl-hint">' + (m === 'manual' ? 'You get an invite code to send to each friend.' : m === 'local' ? 'Then open this page in a second tab and join with the code.' : 'You get a room code and a link to share.') + '</p>' +
          '<div class="nl-field"><label class="nl-label" for="nl-name">Your driver name</label><input id="nl-name" class="nl-input" data-k="name" maxlength="24" autocomplete="nickname" value="' + esc(myName()) + '"></div>' +
          '<button class="cb-btn primary large race-btn" data-act="create"' + (onlineDown || A.busy ? ' disabled' : '') + '>' + svg('flag') + 'Create room</button></section>' +
        '<section class="nl-card"><h2>' + svg('link', 18) + 'Join a room</h2>' + joinBody + '</section>' +
        '<section class="nl-card nl-yourcar"><h2>Your car</h2><div class="nl-you"><div class="nl-you-body" style="flex:1">' + carCardHtml(b) + '</div></div><p class="nl-hint">Everyone races the car they built in the Garage.</p><button class="cb-btn ghost" data-act="atelier">' + svg('wrench') + 'Change car in the Garage</button></section>' +
      '</div>';
  }

  function manualGuestHtml() {
    var M = A.manual || { step: 1 };
    var s1 = M.step === 1 ? 'is-active' : 'is-done', s2 = M.step < 2 ? 'is-later' : M.reply ? 'is-done' : 'is-active', s3 = M.step < 2 || !M.reply ? 'is-later' : 'is-active';
    return '<section class="nl-card" style="max-width:760px"><h2>' + svg('ticket', 18) + 'Join with an invite code</h2><div class="nl-steps">' +
      '<div class="nl-step ' + s1 + '"><div><b>Paste the invite code your host sent you</b>' +
        '<form data-form="manual-invite" class="nl-field"><label class="nl-sr" for="nl-mi">Invite code</label><textarea id="nl-mi" class="nl-area" data-k="manual-invite" spellcheck="false" placeholder="Paste the invite code here"' + (M.step > 1 ? ' readonly' : '') + '>' + esc(M.inviteIn || '') + '</textarea>' +
        (M.step === 1 ? '<div class="nl-row"><button class="cb-btn primary" type="submit">Next</button><button class="cb-btn ghost" type="button" data-act="home">Cancel</button></div>' : '') + '</form></div></div>' +
      '<div class="nl-step ' + s2 + '"><div><b>Send this reply code back to the host</b>' + (M.step >= 2 ? (M.reply ? '<textarea class="nl-area" readonly data-k="manual-reply" aria-label="Your reply code">' + esc(M.reply) + '</textarea><div class="nl-row"><button class="cb-btn primary" data-act="copy" data-copy="reply">' + svg('copy') + 'Copy reply code</button></div>' : '<div class="nl-row"><div class="nl-spinner" style="width:20px;height:20px;border-width:2px"></div><span class="nl-hint">Generating your reply code…</span></div>') : '<p class="nl-hint">Appears after step 1.</p>') + '</div></div>' +
      '<div class="nl-step ' + s3 + '"><div><b>Wait for the host to paste it</b><p class="nl-hint">You join the room automatically as soon as the host enters your reply code. Keep this tab open.</p></div></div>' +
      '</div></section>';
  }
  function manualHostHtml() {
    var M = A.manual;
    if (!M || M.role !== 'host') return '';
    var s1 = M.step <= 1 ? 'is-active' : 'is-done', s2 = M.step < 1 ? 'is-later' : M.step === 1 ? 'is-active' : 'is-done', s3 = M.step === 3 ? 'is-done' : M.step === 2 ? 'is-active' : 'is-later';
    return '<section class="nl-card"><h2>' + svg('ticket', 18) + 'Invite a friend with a code</h2><div class="nl-steps">' +
      '<div class="nl-step ' + s1 + '"><div><b>Copy this invite code and send it to your friend</b>' + (M.invite ? '<textarea class="nl-area" readonly data-k="manual-invite-out" aria-label="Invite code">' + esc(M.invite) + '</textarea><div class="nl-row"><button class="cb-btn primary" data-act="copy" data-copy="invite">' + svg('copy') + 'Copy invite code</button><span class="nl-hint">Chat, email, anything works. One code per friend.</span></div>' : '<div class="nl-row"><div class="nl-spinner" style="width:20px;height:20px;border-width:2px"></div><span class="nl-hint">Generating…</span></div>') + '</div></div>' +
      '<div class="nl-step ' + s2 + '"><div><b>Paste the reply code they send back</b><form data-form="manual-reply" class="nl-field"><label class="nl-sr" for="nl-mr">Reply code</label><textarea id="nl-mr" class="nl-area" data-k="manual-reply-in" spellcheck="false" placeholder="Paste your friend’s reply code"' + (M.step !== 1 ? ' readonly' : '') + '>' + esc(M.replyIn || '') + '</textarea>' + (M.step === 1 ? '<div class="nl-row"><button class="cb-btn primary" type="submit">Connect</button></div>' : '') + '</form></div></div>' +
      '<div class="nl-step ' + s3 + '"><div><b>' + (M.step === 3 ? 'Connected!' : 'Connecting') + '</b>' + (M.step === 3 ? '<div class="nl-row"><button class="cb-btn ghost" data-act="invite-more">Invite another friend</button></div>' : M.step === 2 ? '<p class="nl-hint">Opening a direct connection…</p>' : '<p class="nl-hint">They show up in the driver list.</p>') + '</div></div>' +
      '</div></section>';
  }

  function renderRoom() {
    var c = A.core, st = c.state(), host = c.isHost(), locked = !host || st.phase !== 'lobby';
    // notice
    var linkNote = !host && st.link === 'reconnecting' ? '<div class="nl-notice" role="status"><div class="nl-spinner" style="width:18px;height:18px;border-width:2px"></div><div><b>Connection hiccup.</b> Reconnecting to the host…</div></div>' : '';
    patch(q('.nl-notice-slot'), linkNote + (A.notice ? '<div class="nl-notice ' + (A.notice.kind === 'bad' ? 'is-bad' : '') + '" role="status"><div>' + esc(A.notice.text) + '</div>' + (A.notice.back ? '<button class="cb-btn ghost small" data-act="dismiss-notice">Back to lobby</button>' : '') + '</div>' : ''));
    // room bar
    var method = (A.net && A.net.method) || chosenMethod();
    var code = st.code;
    patch(q('.nl-roombar-card'), '<div class="nl-roombar">' +
      (code ? '<div><div class="nl-label">Room code</div><div class="nl-code" aria-label="Room code ' + esc(code.split('').join(' ')) + '">' + esc(code) + '</div></div><button class="cb-btn ghost" data-act="copy" data-copy="code">' + svg('copy') + 'Copy code</button>' +
        '<div class="nl-linkbox"><label class="nl-sr" for="nl-link">Share link</label><input id="nl-link" class="nl-input" readonly value="' + esc(shareLink(code)) + '" data-k="link"><button class="cb-btn primary" data-act="copy" data-copy="link">' + svg('link') + 'Copy link</button></div>'
        : '<div><div class="nl-label">Connection</div><div class="nl-ro">' + esc(pick(METHODS, method).name) + (host ? ' — invite friends below' : ' — connected to the host') + '</div></div>') +
      '<span class="nl-pill">' + svg(method === 'online' ? 'globe' : method === 'manual' ? 'ticket' : 'tabs', 14) + esc(pick(METHODS, method).name) + '</span></div>');
    patch(q('.nl-manual-slot'), host ? manualHostHtml() : '');
    // players
    var aiN = st.phase === 'lobby' || !st.start ? (st.settings.mode === 'free' ? 0 : Math.min(st.settings.ai, Math.max(0, MAX_PLAYERS - st.players.length))) : st.start.cfg.ai || 0;
    q('.nl-count').textContent = st.players.length + ' / ' + MAX_PLAYERS + (aiN ? ' · +' + aiN + ' AI' : '');
    var cards = st.players.map(function (p) {
      var me = p.id === st.selfId, ready = p.host || p.ready;
      return '<article class="nl-player' + (me ? ' is-me' : '') + (ready ? ' is-ready' : '') + '" aria-label="' + esc(p.name + (p.host ? ', host' : '') + (me ? ', you' : '') + (ready ? ', ready' : ', not ready')) + '">' +
        '<div class="nl-ptop"><span class="nl-pname">' + esc(p.name) + '</span>' + (p.host ? '<span class="nl-ptag" title="Host">' + svg('crown', 12) + 'Host</span>' : '') + (me ? '<span class="nl-ptag">You</span>' : '') + pingHtml(p.ping, p.host) + '</div>' +
        carCardHtml(p.build) +
        '<div class="nl-pfoot"><span class="nl-state' + (ready ? ' is-ready' : '') + '">' + (p.link === 'reconnecting' ? 'Reconnecting…' : p.late ? 'Joins next race' : p.host ? 'Host' : ready ? '✓ Ready' : 'Not ready') + '</span>' +
        (host && !p.host ? '<button class="cb-btn ghost danger small" data-act="kick" data-id="' + esc(p.id) + '" data-k="kick-' + esc(p.id) + '"' + (A.kickArm === p.id ? ' aria-label="Confirm removing ' + esc(p.name) + '">Confirm kick' : ' aria-label="Remove ' + esc(p.name) + ' from the room">Kick') + '</button>' : '') +
        (me && !p.host ? '<button class="cb-btn ghost small" data-act="atelier">' + svg('wrench', 14) + 'Change car</button>' : '') + '</div></article>';
    });
    for (var i = 0; i < aiN; i++) cards.push('<article class="nl-player is-ai" aria-label="AI driver"><div class="nl-ptop"><span class="nl-pname">AI driver ' + (i + 1) + '</span><span class="nl-ptag">' + svg('bot', 12) + 'AI</span></div><p class="nl-hint">Fills an empty grid slot.</p></article>');
    patch(q('.nl-players'), cards.join(''));
    // settings
    q('.nl-hostonly').innerHTML = host ? '' : '<span class="nl-badge">Host picks</span>';
    patch(q('.nl-settings'), settingsHtml(st.settings, locked));
    // go panel
    patch(q('.nl-go'), goHtml());
    // results
    var rr = resultRows(st.results), rs = q('.nl-results-slot');
    rs.hidden = !rr.length;
    patch(rs, rr.length ? '<h2>Last results</h2><table class="nl-results"><tbody>' + rr.map(function (r) { return '<tr><td>' + r.pos + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.value) + '</td></tr>'; }).join('') + '</tbody></table>' : '');
    renderChat();
  }
  function seg(key, list, val, locked) {
    return '<div class="nl-seg" role="group">' + list.map(function (x) {
      return '<button type="button" class="nl-chip-btn" data-set="' + key + '" data-v="' + x.id + '" data-k="s-' + key + '-' + x.id + '" aria-pressed="' + (val === x.id) + '"' + (locked ? ' disabled' : '') + '>' + esc(x.name) + '</button>';
    }).join('') + '</div>';
  }
  function minimap(def) {
    var T = CB.race && CB.race.tracks;
    if (!def || !T || typeof T.previewPath !== 'function') return '';
    var pts = safe(function () { return T.previewPath(def, 120, 58, 5); });
    if (!Array.isArray(pts) || pts.length < 3) return '';
    var step = Math.max(1, Math.floor(pts.length / 90)), out = [];
    for (var i = 0; i < pts.length; i += step) out.push(num(pts[i][0], 0).toFixed(1) + ',' + num(pts[i][1], 0).toFixed(1));
    out.push(num(pts[0][0], 0).toFixed(1) + ',' + num(pts[0][1], 0).toFixed(1));
    return '<svg viewBox="0 0 120 58" aria-hidden="true"><polyline points="' + out.join(' ') + '"/></svg>';
  }
  var mapCache = {};
  /** 2D outline of a stunt track (def.points) as the same small SVG. */
  function stuntMinimap(def) {
    var pts = def && Array.isArray(def.points) ? def.points : null;
    if (!pts || pts.length < 3) return '';
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    pts.forEach(function (p) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
    var sc = Math.min(110 / Math.max(1, x1 - x0), 48 / Math.max(1, y1 - y0)), ox = (120 - (x1 - x0) * sc) / 2, oy = (58 - (y1 - y0) * sc) / 2;
    var step = Math.max(1, Math.floor(pts.length / 90)), out = [];
    for (var i = 0; i < pts.length; i += step) out.push((ox + (pts[i][0] - x0) * sc).toFixed(1) + ',' + (oy + (y1 - pts[i][1]) * sc).toFixed(1));
    out.push(out[0]);
    return '<svg viewBox="0 0 120 58" aria-hidden="true"><polyline points="' + out.join(' ') + '"/></svg>';
  }
  function trackMap(t) { return mapCache[t.id] = mapCache[t.id] || (t.kind === 'stunt' ? stuntMinimap(t.def) : minimap(t.def)); }
  function kindLabel(k) { return k === 'drift' ? 'Drift' : k === 'stunt' ? 'Stunt' : 'Circuit'; }
  function settingsHtml(s, locked) {
    var tracks = tracksFor(s.mode);
    var cur = tracks.filter(function (t) { return t.id === s.trackId; })[0];
    var tr = locked
      ? '<div class="nl-tracks" style="max-height:none;grid-template-columns:minmax(0,220px)"><div class="nl-track" aria-pressed="true">' + (cur ? trackMap(cur) : '') + '<b>' + esc(cur ? cur.name : s.trackId) + '</b><span>' + esc(cur ? kindLabel(cur.kind) : '') + '</span></div></div>'
      : '<div class="nl-tracks" role="group" aria-label="Track">' + tracks.map(function (t) {
        return '<button type="button" class="nl-track" data-set="trackId" data-v="' + esc(t.id) + '" data-k="t-' + esc(t.id) + '" aria-pressed="' + (t.id === s.trackId) + '" title="' + esc(t.name) + '">' + trackMap(t) + '<b>' + esc(t.name) + '</b><span>' + esc(kindLabel(t.kind)) + '</span></button>';
      }).join('') + '</div>';
    var stepper = function (key, val, min, max, label) {
      return '<div class="nl-stepper"><button type="button" class="cb-btn ghost icon-btn small" data-step="' + key + '" data-d="-1" data-k="st-' + key + '-m" aria-label="Fewer ' + label + '"' + (locked || val <= min ? ' disabled' : '') + '>−</button><output aria-live="polite" aria-label="' + label + '">' + val + '</output><button type="button" class="cb-btn ghost icon-btn small" data-step="' + key + '" data-d="1" data-k="st-' + key + '-p" aria-label="More ' + label + '"' + (locked || val >= max ? ' disabled' : '') + '>+</button></div>';
    };
    var checks = ASSISTS.map(function (a) {
      return '<label class="nl-check"><input type="checkbox" data-assist="' + a.id + '" data-k="a-' + a.id + '"' + (s.assists[a.id] ? ' checked' : '') + (locked ? ' disabled' : '') + '>' + esc(a.name) + '</label>';
    }).join('');
    return '<div class="nl-field nl-wide"><span class="nl-label">Mode</span>' + seg('mode', MODES, s.mode, locked) + '<p class="nl-hint">' + esc(pick(MODES, s.mode).desc) + '</p></div>' +
      '<div class="nl-field nl-wide"><span class="nl-label">Track</span>' + tr + '</div>' +
      (s.mode === 'race' || s.mode === 'arcade' ? '<div class="nl-field"><span class="nl-label">Laps</span>' + stepper('laps', s.laps, 1, 20, 'laps') + '</div>' : '') +
      (s.mode !== 'free' ? '<div class="nl-field"><span class="nl-label">AI drivers</span>' + stepper('ai', s.ai, 0, MAX_AI, 'AI drivers') + '<p class="nl-hint">Fill empty grid slots (max 8 cars).</p></div>' : '') +
      '<div class="nl-field"><span class="nl-label">Weather</span>' + seg('weather', WEATHERS, s.weather, locked) + '</div>' +
      '<div class="nl-field"><span class="nl-label">Time of day</span>' + seg('timeOfDay', TIMES, s.timeOfDay, locked) + '</div>' +
      (s.mode === 'arcade' ? arcadeHtml(s, locked) : '<div class="nl-field nl-wide"><span class="nl-label">Allowed assists</span><div class="nl-checks">' + checks + '</div></div>') +
      '<div class="nl-field nl-wide"><span class="nl-label">Max steering assist</span>' + seg('maxSteerAssist', STEER_LEVELS, s.maxSteerAssist, locked) + '</div>';
  }
  /** Arcade rules (host): items, item boxes, nitro, speed class, coins, AI difficulty. */
  function arcadeHtml(s, locked) {
    var a = s.arcade || {}, onOff = [{ id: 'on', name: 'On' }, { id: 'off', name: 'Off' }];
    return arcadeOptDefs().map(function (d) {
      var list = Array.isArray(d.choices) ? d.choices : onOff, val = Array.isArray(d.choices) ? a[d.id] : (a[d.id] ? 'on' : 'off');
      return '<div class="nl-field"><span class="nl-label">' + esc(d.name || d.id) + '</span>' + seg('arc.' + d.id, list, val, locked) + '</div>';
    }).join('') + '<div class="nl-field"><span class="nl-label">AI difficulty</span>' + seg('difficulty', ARCADE_DIFF, s.difficulty, locked) + '</div>';
  }
  function goHtml() {
    var c = A.core, st = c.state(), host = c.isHost(), me = c.me();
    if (st.phase === 'countdown') {
      var left = Math.ceil(c.countdownLeft() / 1000);
      return '<h2>' + svg('flag', 18) + 'Get ready</h2><div class="nl-countdown"><output aria-live="assertive" data-cd>' + left + '</output></div>' +
        (st.start && st.start.spectator ? '<p class="nl-gate">You joined after the grid was set — you are in for the next race.</p>' : '<p class="nl-gate">Loading ' + esc(trackName(st.start ? st.start.cfg.trackId : st.settings.trackId)) + '…</p>') +
        (host ? '<button class="cb-btn ghost" data-act="cancel-start" data-k="cancel-start">Cancel start</button>' : (!me || !me.ready ? '' : '<button class="cb-btn ghost" data-act="ready" data-k="ready">Not ready</button>'));
    }
    if (st.phase === 'racing' || st.phase === 'waiting') return '<h2>' + svg('flag', 18) + 'Race in progress</h2><p class="nl-gate">' + (st.phase === 'waiting' ? 'Waiting for the others to finish…' : A.raceOpen ? 'Racing…' : 'The race is running. You will be in the next one.') + '</p>';
    if (!st.connected) return '<h2>Joining…</h2><p class="nl-gate">Saying hello to the host…</p>';
    if (host) {
      var g = c.canStart();
      // disabled: the reason is the button's tooltip (on a wrapper too — disabled buttons swallow hover in some
      // browsers) and an inline hint the button is described by
      var gateTxt = g.ok ? (g.solo ? g.reason : 'Everyone is ready') : g.reason;
      var startBtn = '<button class="cb-btn primary large race-btn" data-act="start" data-k="start" aria-describedby="nl-start-gate"' + (g.ok ? '' : ' disabled aria-disabled="true" title="' + esc(g.reason) + '"') + '>' + svg('flag') + 'Start ' + esc(pick(MODES, st.settings.mode).name.toLowerCase()) + '</button>';
      return '<h2>' + svg('flag', 18) + 'Start the session</h2>' + (g.ok ? startBtn : '<span class="nl-start-wrap" title="' + esc(g.reason) + '">' + startBtn + '</span>') +
        '<p class="nl-gate' + (g.ok ? '' : ' is-blocked') + '" id="nl-start-gate" role="status">' + (g.ok ? '' : svg('info', 13)) + esc(gateTxt) + '</p>';
    }
    var r = !!(me && me.ready);
    return '<h2>Ready up</h2><button class="cb-btn ' + (r ? 'ghost' : 'primary') + ' large" data-act="ready" data-k="ready" aria-pressed="' + r + '">' + (r ? svg('check') + 'Ready — click to cancel' : 'I’m ready') + '</button><p class="nl-gate" role="status">' + (r ? 'Waiting for the host to start…' : 'The host starts once everyone is ready.') + '</p>';
  }
  function trackName(id) { var t = raceTracks().concat(stuntTracks()).filter(function (x) { return x.id === id; })[0]; return t ? t.name : id; }
  function renderCountdown() {
    var o = q('[data-cd]');
    if (o && A.core) { var v = String(Math.ceil(A.core.countdownLeft() / 1000)); if (o.textContent !== v) o.textContent = v; }
  }
  function renderChat() {
    var log = q('.nl-log');
    if (!log || !A.core) return;
    var chat = A.core.state().chat, selfId = A.core.state().selfId;
    if (A.chatSeen > chat.length) { log.innerHTML = ''; A.chatSeen = 0; }
    var stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    for (var i = A.chatSeen; i < chat.length; i++) {
      var m = chat[i], li = document.createElement('li');
      if (m.sys) { li.className = 'is-sys'; li.textContent = m.text; }
      else {
        if (m.id === selfId) li.className = 'is-me';
        var tm = document.createElement('time'), d = new Date(m.ts);
        tm.textContent = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
        var b = document.createElement('b'); b.textContent = m.name;
        li.appendChild(tm); li.appendChild(b); li.appendChild(document.createTextNode(m.text));   // textContent: no markup
      }
      log.appendChild(li);
    }
    A.chatSeen = chat.length;
    if (stick) log.scrollTop = log.scrollHeight;
  }

  /* ---------------------------------------------------------------- events */
  function copyText(text, btn) {
    function ok() {
      if (!btn) return;
      var html = btn.innerHTML;
      btn.innerHTML = svg('check') + 'Copied';
      btn.__nlBusy = true;
      setTimeout(function () { btn.innerHTML = html; btn.__nlBusy = false; }, 1500);
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var done = safe(function () { return document.execCommand('copy'); });
      document.body.removeChild(ta);
      if (done) ok(); else toast('Copy failed — select the text and copy it manually', 'warning');
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  }
  function onClick(e) {
    var t = e.target.closest && e.target.closest('[data-act],[data-set],[data-step]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act');
    var c = A.core;
    if (t.hasAttribute('data-set') && c) {
      var key = t.getAttribute('data-set'), v = t.getAttribute('data-v'), part = {};
      if (key.indexOf('arc.') === 0) { part.arcade = {}; part.arcade[key.slice(4)] = v === 'on' ? true : v === 'off' ? false : v; c.updateSettings(part); return; }
      part[key] = v; c.updateSettings(part); return;
    }
    if (t.hasAttribute('data-step') && c) {
      var k = t.getAttribute('data-step'), d = Number(t.getAttribute('data-d')), p2 = {};
      p2[k] = c.state().settings[k] + d; c.updateSettings(p2); return;
    }
    switch (act) {
      case 'method': A.method = t.getAttribute('data-v'); lsSet(LS_METHOD, A.method); render(); break;
      case 'create': saveName(); createRoom(); break;
      case 'join-manual': saveName(); joinRoom('', 'manual'); break;
      case 'atelier': if (CB.router && typeof CB.router.go === 'function') { A.fallbackOpen = false; hide(); CB.router.go('atelier'); } break;
      case 'leave': leaveRoom(); break;
      case 'cancel': case 'home': if (A.core) leaveRoom(); else { teardownNet(); A.busy = false; A.view = 'home'; A.manual = null; setUrl(''); render(); } break;
      case 'retry': if (A.error && A.error.retry) { var r = A.error.retry; A.error = null; r(); } break;
      case 'rejoin': rejoin(); break;
      case 'ready': if (c) { var me = c.me(); c.setReady(!(me && me.ready)); } break;
      case 'start': if (c) { var res = c.startCountdown(); if (!res.ok) toast(res.reason, 'info'); } break;
      case 'cancel-start': if (c) c.cancelCountdown(); break;
      case 'kick': {
        var id = t.getAttribute('data-id');
        if (A.kickArm === id) { A.kickArm = null; clearTimeout(A.kickT); if (c) c.kick(id); }
        else { A.kickArm = id; clearTimeout(A.kickT); A.kickT = setTimeout(function () { A.kickArm = null; render(); }, 3500); render(); }
        break;
      }
      case 'copy': {
        if (t.__nlBusy) return;
        var w = t.getAttribute('data-copy'), st = c && c.state();
        var text = w === 'code' ? st && st.code : w === 'link' ? st && shareLink(st.code) : w === 'invite' ? A.manual && A.manual.invite : w === 'reply' ? A.manual && A.manual.reply : '';
        if (text) copyText(text, t);
        break;
      }
      case 'invite-more': manualInvite(); break;
      case 'dismiss-notice': {
        var s = A.session;
        if (s || (c && c.state().phase !== 'lobby')) raceFinished(s, undefined); else { A.notice = null; render(); }
        break;
      }
      default: break;
    }
  }
  function setName(v) { var c = cleanName(v); lsSet(LS_NAME, c); ssSet(LS_NAME + '.tab', c); }
  function saveName() { var n = q('#nl-name'); if (n) setName(n.value); }
  function onInput(e) {
    var t = e.target, k = t.getAttribute && t.getAttribute('data-k');
    if (k === 'join-code') { var v = normCode(t.value); if (v !== t.value) t.value = v; A.code = v; }
    else if (k === 'name') setName(t.value);
    else if (k === 'manual-invite' && A.manual) A.manual.inviteIn = t.value;
    else if (k === 'manual-reply-in' && A.manual) A.manual.replyIn = t.value;
  }
  function onChange(e) {
    var t = e.target;
    if (t.hasAttribute && t.hasAttribute('data-assist') && A.core) {
      var a = {}; a[t.getAttribute('data-assist')] = !!t.checked;
      A.core.updateSettings({ assists: a });
    } else if (t.getAttribute && t.getAttribute('data-k') === 'name' && A.core) A.core.setProfile(t.value);
  }
  function onKey(e) {
    // arrow keys move between connection-method radios (roving tabindex)
    var t = e.target;
    if (t.classList && t.classList.contains('nl-method') && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
      e.preventDefault();
      var all = Array.prototype.slice.call(A.layer.querySelectorAll('.nl-method')), i = all.indexOf(t);
      var nx = all[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
      A.method = nx.getAttribute('data-v'); lsSet(LS_METHOD, A.method); render();
      var f = q('[data-k="m-' + A.method + '"]'); if (f) f.focus();
    }
  }
  function onSubmit(form) {
    var f = form.getAttribute('data-form');
    if (f === 'join') { saveName(); joinRoom(A.code, chosenMethod()); }
    else if (f === 'chat') { var inp = form.querySelector('input'); if (A.core && inp && A.core.chat(inp.value)) inp.value = ''; }
    else if (f === 'manual-invite') { var ta = form.querySelector('textarea'); A.manual.inviteIn = ta.value; manualGuestPasteInvite(ta.value); }
    else if (f === 'manual-reply') { var tb = form.querySelector('textarea'); A.manual.replyIn = tb.value; manualAcceptReply(tb.value); }
  }

  /* first paint of the home screen probes the online backend */
  var _render = render;
  render = function () {
    if (hasDOM && A.layer && !A.layer.hidden && A.onlineOk == null && !A.probing) {
      A.probing = true;
      probeOnline().then(function () { A.probing = false; _render(); });
    }
    _render();
  };

  /* ======================================================================
     Public API
     ====================================================================== */
  var api = {
    version: '1.0.0',
    PROTOCOL: PROTOCOL,
    open: open,
    close: hide,
    isOpen: isOpen,
    leave: leaveRoom,
    createCore: createCore,
    state: function () { return { view: A.view, core: A.core ? A.core.state() : null, method: chosenMethod(), onlineOk: A.onlineOk, raceOpen: A.raceOpen }; },
    _: {
      createCore: createCore, normalizeSettings: normalizeSettings, defaultSettings: defaultSettings, sanitizeBuild: sanitizeBuild,
      cleanText: cleanText, cleanName: cleanName, esc: esc, normCode: normCode, parseHash: parseHash, shareLink: shareLink,
      carSummary: carSummary, resultRows: resultRows, readRtt: readRtt, wrapPeer: wrapPeer, tracksFor: tracksFor, MODES: MODES, MAX_PLAYERS: MAX_PLAYERS,
      myName: myName, setName: setName, goHtml: goHtml,
      app: A
    }
  };
  CB.net.lobby = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

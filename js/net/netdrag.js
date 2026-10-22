/* ==========================================================================
   Redline — js/net/netdrag.js
   CB.net.drag : two-player heads-up DRAG RACES over CB.net.transport (docs/DRAG-SPEC.md §7).

   Model: each side simulates ONLY ITS OWN CAR in a CB.drag.session (zero input lag, the real vehicle model); the
   other lane is a 'remote' puppet posed from the opponent's state packets (20 Hz 'fast': position, speed, revs,
   gear, beams, RT, splits, finish). The HOST is authoritative for the tree: it arms it when both lanes report
   staged and sends the amber / green times relative to now ('rel' nd.tree; the guest subtracts half the RTT), so
   each driver's reaction time and red light are measured against their own green on their own machine. The host
   decides the race from both lanes' RT / ET (CB.drag.tree.decide) and broadcasts the decision (nd.res).
   Host = lane 0 (left), guest = lane 1 (right).

   API
     createHostSession(host, cfg { distanceId, venue, surface, night, treeType, skipBurnout, build, name, assists,
                       seed, players: [{ peerId, name, build }] })
     createClientSession(client, cfg { start (the host's start message, optional: waits for it), build, name, assists })
     isDragStart(msg)
     session: the CB.drag.session surface — update(dt, input), snapshot(), results(), destroy() — plus selfLane,
              config (the session cfg), net { role, peer, rtt, lastRx_s }, ready() (client: start received)
   Messages: start{ t:'start', drag:true, v, seed, cfg, lanes:[{name, build}], you } · nd.s{ s, tr? } (fast) ·
             nd.tree{ startIn, greenIn:[a,b] } · nd.res{ d } · nd.quit{}
   Pure logic (no DOM). Loads in Node (tests with CB.net.transport.loopback).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.net = CB.net || {};

(function () {
  'use strict';
  var VERSION = 'redline-net-drag/1', SEND_HZ = 20, DISCONNECT_S = 15;
  function num(v, d) { var n = Number(v); return v != null && isFinite(n) ? n : d; }
  function onOf(obj, type, fn) {
    if (obj && typeof obj.on === 'function') { var off = obj.on(type, fn); return typeof off === 'function' ? off : function () { if (typeof obj.off === 'function') obj.off(type, fn); }; }
    return function () {};
  }
  function isDragStart(m) { return !!(m && typeof m === 'object' && m.t === 'start' && m.drag === true); }
  function pickCfg(c) {
    c = c || {};
    return { distanceId: c.distanceId || 'quarter', venue: c.venue === 'street' ? 'street' : 'strip', surface: c.surface || 'prepped', night: !!c.night,
      treeType: c.treeType || (c.venue === 'street' ? 'flag' : 'pro'), skipBurnout: !!c.skipBurnout, class: c.class === 'pro-mod' ? 'pro-mod' : 'street' };
  }

  /** Shared wrapper: a drag session + the state stream to / from the other side. */
  function wrap(sess, selfLane, send, extra) {
    var acc = 0, sentTree = false, decided = false, lastRx = 0, closed = false, t = 0, finishT = null;
    var api = {
      isDragNet: true, selfLane: selfLane, config: sess.cfg, net: { role: extra.role, rtt: 0, lastRx_s: 0 },
      update: function (dt, input) {
        if (closed) return 0;
        t += num(dt, 0);
        var n = sess.update(dt, input);
        acc += num(dt, 0);
        if (acc >= 1 / SEND_HZ) {
          acc = 0;
          var pk = { t: 'nd.s', s: sess.netState(selfLane) };
          if (extra.role === 'host') { var tr = sess.treeRel(); if (tr) pk.tr = tr; }
          send('fast', pk);
        }
        if (extra.role === 'host') {
          var tr2 = sess.treeRel();
          if (tr2 && !sentTree) { sentTree = true; send('rel', Object.assign({ t: 'nd.tree' }, tr2)); }
          var snapD = sess.results();
          if (!decided && snapD.reason !== 'none') {
            decided = true; send('rel', { t: 'nd.res', d: { winner: snapD.winner, reason: snapD.reason, margin_s: snapD.margin_s, holeshot: snapD.holeshot } });
          }
        }
        // opponent gone: after our own finish, wait DISCONNECT_S for theirs, then give up on them
        var me = sess.lane(selfLane);
        if (me && (me.finished || me.red) && finishT == null) finishT = t;
        if (finishT != null && t - finishT > DISCONNECT_S && t - lastRx > 3) {
          sess.setRemote(1 - selfLane, Object.assign({}, sess.lane(1 - selfLane).rs || {}, { dq: 'disconnected', left: true }));
        }
        return n;
      },
      onMessage: function (ch, m) {
        if (!m || typeof m !== 'object') return;
        lastRx = t; api.net.lastRx_s = t;
        if (m.t === 'nd.s' && m.s) {
          var lat = Math.max(0, num(extra.rtt && extra.rtt(), 0) / 2), s = Object.assign({}, m.s);
          if (s.xFront != null && s.vx) s.xFront += s.vx * Math.min(lat, 0.3);
          sess.setRemote(1 - selfLane, s);
          if (extra.role === 'peer' && m.tr) api.applyTree(m.tr);
        } else if (m.t === 'nd.tree' && extra.role === 'peer') api.applyTree(m);
        else if (m.t === 'nd.res' && extra.role === 'peer' && m.d) sess.setDecision(m.d);
        else if (m.t === 'nd.quit') sess.setRemote(1 - selfLane, Object.assign({}, sess.lane(1 - selfLane).rs || {}, { dq: 'left the race', left: true }));
      },
      applyTree: function (tr) {
        var lat = Math.max(0, num(extra.rtt && extra.rtt(), 0) / 2);
        sess.setTree({ startIn: num(tr.startIn, 0) - lat, greenIn: [num(tr.greenIn && tr.greenIn[0], 1) - lat, num(tr.greenIn && tr.greenIn[1], 1) - lat] });
      },
      snapshot: function () { var sn = sess.snapshot(); sn.net = true; sn.playerLane = selfLane; return sn; },
      results: function () { var r = sess.results(); r.net = true; r.selfLane = selfLane; return r; },
      phase: function () { return sess.phase(); },
      view: function (i) { return sess.view(i == null ? selfLane : i); },
      lane: function (i) { return sess.lane(i); },
      ghostRun: function (i) { return sess.ghostRun(i == null ? selfLane : i); },
      restart: function () { /* a rematch goes back through the lobby */ },
      destroy: function () { if (closed) return; closed = true; try { send('rel', { t: 'nd.quit' }); } catch (e) { /* gone */ } (extra.offs || []).forEach(function (o) { try { o(); } catch (e) { /* ignore */ } }); sess.destroy(); },
      _session: sess
    };
    return api;
  }

  function createHostSession(H, cfg) {
    cfg = cfg || {};
    var g = (cfg.players || [])[0] || {};
    var base = pickCfg(cfg), seed = num(cfg.seed, 1) >>> 0;
    var lanes = [{ name: cfg.name || 'Host', build: cfg.build }, { name: g.name || 'Guest', build: g.build }];
    var sess = CB.drag.session.create(Object.assign({}, base, { seed: seed, playerLane: 0, lanes: [
      { kind: 'player', name: lanes[0].name, build: lanes[0].build, assists: cfg.assists, nitrous_hp: cfg.nitrous_hp },
      g.peerId == null
        ? { kind: 'ai', name: 'Lena "Bavaria" Kraus', build: CB.drag.ai.rivalBuild('bmw-m4-g82'), difficulty: 'pro' }   // solo run: an AI rival
        : { kind: 'remote', name: lanes[1].name, build: lanes[1].build }] }));
    var peerId = g.peerId;
    function send(ch, m) { try { return peerId != null ? H.send(peerId, ch, m) : (H.broadcast && H.broadcast(ch, m)); } catch (e) { return false; } }
    var offs = [];
    var api = wrap(sess, 0, send, { role: 'host', offs: offs, rtt: function () { var p = H.get && H.get(peerId); return p && p.rtt > 0 ? p.rtt / 1000 : 0; } });
    offs.push(onOf(H, 'message', function (peer, ch, m) { var id = peer && peer.id != null ? peer.id : peer; if (peerId == null || id === peerId) api.onMessage(ch, m); }));
    send('rel', { t: 'start', drag: true, v: VERSION, seed: seed, cfg: base, lanes: lanes, you: 1 });
    return api;
  }

  function createClientSession(C, cfg) {
    cfg = cfg || {};
    var offs = [], inner = null, pending = [];
    function send(ch, m) { try { return C.send(ch, m); } catch (e) { return false; } }
    function rtt() { return num(C.rtt, 0) > 0 ? C.rtt / 1000 : 0; }
    function begin(st) {
      if (inner) return;
      var c = pickCfg(st.cfg), L = st.lanes || [];
      var sess = CB.drag.session.create(Object.assign({}, c, { seed: num(st.seed, 1), playerLane: 1, treeAuthority: 'remote', lanes: [
        { kind: 'remote', name: (L[0] && L[0].name) || 'Host', build: L[0] && L[0].build },
        { kind: 'player', name: cfg.name || (L[1] && L[1].name) || 'You', build: cfg.build || (L[1] && L[1].build), assists: cfg.assists, nitrous_hp: cfg.nitrous_hp }] }));
      inner = wrap(sess, 1, send, { role: 'peer', offs: offs, rtt: rtt });
      pending.forEach(function (x) { inner.onMessage(x[0], x[1]); }); pending = [];
    }
    offs.push(onOf(C, 'message', function (ch, m) {
      if (isDragStart(m)) { begin(m); return; }
      if (inner) inner.onMessage(ch, m); else if (pending.length < 64) pending.push([ch, m]);
    }));
    if (cfg.start && isDragStart(cfg.start)) begin(cfg.start);
    // proxy (the session exists once the start message arrived)
    function idle() { return { t: 0, phase: 'waiting', lanes: [], tree: { armed: false, lanes: [], greenT: [null, null] }, events: [], net: true, waiting: true, playerLane: 1 }; }
    return {
      isDragNet: true, selfLane: 1, net: { role: 'peer' },
      ready: function () { return !!inner; },
      get config() { return inner ? inner.config : null; },
      update: function (dt, input) { return inner ? inner.update(dt, input) : 0; },
      snapshot: function () { return inner ? inner.snapshot() : idle(); },
      results: function () { return inner ? inner.results() : null; },
      phase: function () { return inner ? inner.phase() : 'waiting'; },
      view: function (i) { return inner ? inner.view(i) : null; },
      lane: function (i) { return inner ? inner.lane(i) : null; },
      ghostRun: function (i) { return inner ? inner.ghostRun(i) : null; },
      restart: function () {},
      destroy: function () { if (inner) inner.destroy(); else offs.forEach(function (o) { try { o(); } catch (e) { /* ignore */ } }); },
      _inner: function () { return inner; }
    };
  }

  CB.net.drag = { VERSION: VERSION, isDragStart: isDragStart, createHostSession: createHostSession, createClientSession: createClientSession };
})();

if (typeof module !== 'undefined') module.exports = CB.net.drag;

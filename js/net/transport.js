/* ==========================================================================
   FORGE Atelier — js/net/transport.js
   CB.net.transport : peer-to-peer WebRTC transport (star topology, host authoritative) + an in-memory loopback with
   simulated latency / jitter / loss for Node tests. Zero dependencies, classic script, require()-able in Node.

   ---------------------------------------------------------------- API (same objects for WebRTC and loopback)
   var T = CB.net.transport;
   T.PROTO                                   'forge-net/1'
   T.host(signal, opts?)  -> Host            signal: a CB.net.signal object on which create() already resolved
   T.connect(signal, opts?) -> Client        signal: a CB.net.signal object on which join() already resolved
     opts: {iceServers, turn, maxPeers:7, pingInterval:1000, timeout:30000 (connect), graceMs:15000 (host waits for a
            dropped peer to come back), reconnectAttempts:3, linkTimeout:8000 (no packets -> link lost)}
     relay: true | {after:4500}  server-relay fallback (js/net/relay.js): when the data channels are not open `after` ms
            after the join (or ICE fails), the client asks {t:'relay'}, the host attaches a relay link and answers
            {t:'relay-ok'}; traffic then goes through the signalling server. BOTH ends must pass relay:true.
            peer.mode 'direct' | 'relay' tells which one is in use.  client.stage: 'waiting' (join sent, no offer yet)
            | 'connecting' (offer received, ICE running) | 'relay' (switching to the server relay) | 'open'  ('stage' event)
            relay object extras: {downlinks, upGap, upInFlight, turnAfter:9000 (ms before relaying while ICE runs with TURN)}
            (js/net/relay.js DEFAULTS); host side: opts.relayOpts.
     ICE: STUN stun.l.google.com:19302 + stun.cloudflare.com:3478, plus window.REDLINE_TURN (or the older window.FORGE_TURN; object or array of
          RTCIceServer, e.g. {urls:'turn:…', username, credential}), plus the TURN servers the signalling server hands out
          (signal.ice(): api/turn-config.php / TURN env vars; skipped with opts.iceServers or opts.serverIce:false).
          Strict/symmetric NATs need TURN. ICE prefers direct paths, then TURN; the server relay is the last resort.
          peer.mode 'direct' | 'turn' (the selected candidate pair goes through TURN) | 'relay'.

   Peer (a remote endpoint; Client *is* a Peer whose id is 'host'):
     peer.id, peer.state ('connecting'|'open'|'reconnecting'|'closed'), peer.rtt (ms, smoothed), peer.rttMin (best of the
       last 10 pings), peer.clockOffset
       (remote clock − local clock, ms; best of recent pings), peer.stats {sentRel, sentFast, recvRel, recvFast, dropped}
     peer.send(channel, data) -> bool        channel 'rel' (ordered reliable) | 'fast' (unordered, maxRetransmits 0)
                                             data: JSON-able object  -> delivered as the same object
                                                   ArrayBuffer/TypedArray -> delivered as an ArrayBuffer
                                             rel messages sent before open are queued; fast messages are dropped
     peer.on(type, fn) -> unsubscribe        'message'(channel, data) 'open'() 'state'(state) 'rtt'(rtt) 'close'(reason)
     peer.close(reason?)                     host side: kicks that peer; client side: leaves
     peer.remoteNow()                        estimate of the remote clock now (local now + clockOffset)
   Host:
     host.id 'host', host.role 'host', host.now() (host clock ms; the race clock for start{t0}/go{t})
     host.list() -> [Peer], host.get(id) -> Peer
     host.send(id, channel, data), host.broadcast(channel, data, exceptId?)
     host.on('peer', fn(peer))              first time a peer's channels are open
     host.on('message', fn(peer, channel, data))
     host.on('peer-state', fn(peer, state))   ('reconnecting' while a dropped peer may come back)
     host.on('peer-leave', fn(peer, reason))  reason: 'left'|'kicked'|'timeout'|'failed'|'host-closed'|...
     host.close()                           says bye to everyone (the signal stays owned by the caller)
   Client (extends Peer, id 'host'):
     client.role 'peer', client.selfId (own id from the signal), client.ready (Promise, resolves on first open,
     rejects on failure), client.now() (local), client.hostNow() (local + clockOffset), client.attempts
     events also: 'error'(err)   close reasons: 'left'|'kicked'|'host-closed'|'timeout'|'failed'|'full'|'expired'
     (manual signal: connect timeout defaults to 10 min; 'expired' = ICE gave up before the answer code was pasted)
   Binary car state (quantised; ≈40 bytes/car):
     T.packStates([state…]) -> ArrayBuffer    T.unpackStates(buf) -> [state…]   T.packState(s) / T.unpackState(buf)
     T.isStates(buf) -> bool                  T.PACK (field precision)
     state = {id (≤24 ASCII chars), t (ms, f64), x, y (f32), heading (rad, int16 over ±π), vx, vy (m/s, 0.01),
              yawRate (rad/s, 0.001), steer (−1..1, 1/127), throttle, brake (0..1, 1/255), gear (int8), rpm (uint16),
              flags (uint16)}
   ---------------------------------------------------------------- Loopback (Node tests, no WebRTC)
     var net = T.loopback({latency:30, jitter:0, loss:0, seed:1, clock:'manual'|'real', pingInterval:1000});
       latency: one-way ms; jitter: extra uniform 0..jitter ms per packet; loss: 0..1 drop chance on 'fast' only.
       'rel' stays ordered + lossless; 'fast' packets are independent (can reorder under jitter, can be lost).
     var host = net.host(opts?)               -> Host (same API as above)
     var c = net.connect({id?, skew?, name?}) -> Client (same API); opens after ~1.5 RTT. skew: client clock offset (ms)
     net.advance(ms)        manual clock: run every timer / delivery due in the next ms (deterministic)
     net.run(ms, stepMs?)   same as advance but in steps (default 16 ms)
     net.now()              virtual network time (== host clock)
     net.setConditions({latency, jitter, loss})
     net.disconnect(id, {permanent?})   drop the link for client `id`: both ends see 'reconnecting'; unless permanent,
                                        the client re-links after ~1 RTT + 200 ms (exercise reconnect paths)
     net.clients()          -> [Client]
     clock:'real' uses real timers (advance() is then a no-op); default 'manual'.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  var PROTO = 'forge-net/1';
  var DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
  var FAST_BUFFER_MAX = 64 * 1024;
  var REL_QUEUE_MAX = 512;

  function emitter(obj) {
    var map = {};
    obj.on = function (type, fn) { (map[type] = map[type] || []).push(fn); return function () { obj.off(type, fn); }; };
    obj.off = function (type, fn) { var l = map[type]; if (l) { var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } };
    obj.once = function (type, fn) { var off = obj.on(type, function () { off(); fn.apply(null, arguments); }); return off; };
    obj.emit = function (type) {
      var l = (map[type] || []).slice(), args = Array.prototype.slice.call(arguments, 1);
      for (var i = 0; i < l.length; i++) { try { l[i].apply(null, args); } catch (e) { if (typeof console !== 'undefined') console.error('[net.transport] listener error', e); } }
      return l.length;
    };
    return obj;
  }
  function randId(n) {
    var a = 'abcdefghjkmnpqrstuvwxyz23456789', s = '', c = globalThis.crypto, b = null;
    if (c && c.getRandomValues) { b = new Uint8Array(n); c.getRandomValues(b); }
    for (var i = 0; i < n; i++) s += a[(b ? b[i] : Math.floor(Math.random() * 256)) % a.length];
    return s;
  }
  function perfNow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  /* ---------------------------------------------------------------- clocks / timers */
  function realClock(offset) {
    var off = offset || 0;
    return {
      now: function () { return perfNow() + off; },
      setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
      clearTimeout: function (id) { clearTimeout(id); },
      setInterval: function (fn, ms) { return setInterval(fn, ms); },
      clearInterval: function (id) { clearInterval(id); }
    };
  }
  function scheduler() {
    var t = 0, q = [], seq = 0, cancelled = new Set();
    function insert(ev) {
      var lo = 0, hi = q.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; var m = q[mid]; if (m.at < ev.at || (m.at === ev.at && m.seq < ev.seq)) lo = mid + 1; else hi = mid; }
      q.splice(lo, 0, ev);
    }
    var S = {
      now: function () { return t; },
      setTimeout: function (fn, ms) { var id = ++seq; insert({ at: t + Math.max(0, ms || 0), seq: id, fn: fn }); return id; },
      clearTimeout: function (id) { if (id) cancelled.add(id); },
      setInterval: function (fn, ms) {
        var holder = { id: 0 }, iid = ++seq;
        function tick() { if (cancelled.has(iid)) return; fn(); if (!cancelled.has(iid)) holder.id = S.setTimeout(tick, ms); }
        holder.id = S.setTimeout(tick, ms);
        return iid;
      },
      clearInterval: function (id) { if (id) cancelled.add(id); },
      advance: function (ms) {
        var end = t + Math.max(0, ms || 0);
        while (q.length && q[0].at <= end) {
          var ev = q.shift();
          t = ev.at;
          if (cancelled.has(ev.seq)) { cancelled.delete(ev.seq); continue; }
          try { ev.fn(); } catch (e) { if (typeof console !== 'undefined') console.error('[net.loopback] timer error', e); }
        }
        t = end;
      },
      pending: function () { return q.length; }
    };
    return S;
  }
  function skewed(clock, skew) {
    var c = Object.create(clock);
    c.now = function () { return clock.now() + skew; };
    return c;
  }

  /* ---------------------------------------------------------------- binary car state */
  var PACK = { magic: 0xF5, version: 1, heading: (2 * Math.PI) / 65534, vel: 0.01, yaw: 0.001, steer: 1 / 127, pedal: 1 / 255 };
  function q16(v, step) { var n = Math.round((Number(v) || 0) / step); return n > 32767 ? 32767 : n < -32767 ? -32767 : n; }
  function wrapPi(a) { a = Number(a) || 0; a = ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a; }
  function clampI(v, lo, hi) { v = Math.round(Number(v) || 0); return v < lo ? lo : v > hi ? hi : v; }
  function toU8(buf) {
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return null;
  }
  function packStates(states) {
    states = (states || []).slice(0, 255);
    var size = 3;
    var ids = states.map(function (s) {
      var id = String(s.id == null ? '' : s.id).replace(/[^\x20-\x7e]/g, '').slice(0, 24);
      size += 1 + id.length + 8 + 8 + 2 + 2 + 2 + 2 + 1 + 1 + 1 + 1 + 2 + 2;
      return id;
    });
    var buf = new ArrayBuffer(size), dv = new DataView(buf), o = 0;
    dv.setUint8(o++, PACK.magic); dv.setUint8(o++, PACK.version); dv.setUint8(o++, states.length);
    states.forEach(function (s, i) {
      var id = ids[i];
      dv.setUint8(o++, id.length);
      for (var k = 0; k < id.length; k++) dv.setUint8(o++, id.charCodeAt(k));
      dv.setFloat64(o, Number(s.t) || 0, true); o += 8;
      dv.setFloat32(o, Number(s.x) || 0, true); o += 4;
      dv.setFloat32(o, Number(s.y) || 0, true); o += 4;
      dv.setInt16(o, q16(wrapPi(s.heading), PACK.heading), true); o += 2;
      dv.setInt16(o, q16(s.vx, PACK.vel), true); o += 2;
      dv.setInt16(o, q16(s.vy, PACK.vel), true); o += 2;
      dv.setInt16(o, q16(s.yawRate, PACK.yaw), true); o += 2;
      dv.setInt8(o++, clampI((Number(s.steer) || 0) * 127, -127, 127));
      dv.setUint8(o++, clampI((Number(s.throttle) || 0) * 255, 0, 255));
      dv.setUint8(o++, clampI((Number(s.brake) || 0) * 255, 0, 255));
      dv.setInt8(o++, clampI(s.gear, -128, 127));
      dv.setUint16(o, clampI(s.rpm, 0, 65535), true); o += 2;
      dv.setUint16(o, clampI(s.flags, 0, 65535), true); o += 2;
    });
    return buf;
  }
  function isStates(buf) { var u = toU8(buf); return !!(u && u.length >= 3 && u[0] === PACK.magic && u[1] === PACK.version); }
  function unpackStates(buf) {
    var u = toU8(buf);
    if (!u || !isStates(u)) return [];
    var dv = new DataView(u.buffer, u.byteOffset, u.byteLength), o = 2, n = dv.getUint8(o++), out = [];
    try {
      for (var i = 0; i < n; i++) {
        var len = dv.getUint8(o++), id = '';
        for (var k = 0; k < len; k++) id += String.fromCharCode(dv.getUint8(o++));
        var s = { id: id };
        s.t = dv.getFloat64(o, true); o += 8;
        s.x = dv.getFloat32(o, true); o += 4;
        s.y = dv.getFloat32(o, true); o += 4;
        s.heading = dv.getInt16(o, true) * PACK.heading; o += 2;
        s.vx = dv.getInt16(o, true) * PACK.vel; o += 2;
        s.vy = dv.getInt16(o, true) * PACK.vel; o += 2;
        s.yawRate = dv.getInt16(o, true) * PACK.yaw; o += 2;
        s.steer = dv.getInt8(o++) / 127;
        s.throttle = dv.getUint8(o++) / 255;
        s.brake = dv.getUint8(o++) / 255;
        s.gear = dv.getInt8(o++);
        s.rpm = dv.getUint16(o, true); o += 2;
        s.flags = dv.getUint16(o, true); o += 2;
        out.push(s);
      }
    } catch (e) { /* truncated packet: return what decoded */ }
    return out;
  }
  function packState(s) { return packStates([s]); }
  function unpackState(buf) { return unpackStates(buf)[0] || null; }

  /* ---------------------------------------------------------------- Peer (shared by WebRTC + loopback) */
  /**
   * makePeer(id, clock, opts) -> Peer. A link is attached with peer._attach(link) where
   * link = {send(channel, payload:string|ArrayBuffer) -> bool, close()}; incoming data -> peer._recv(channel, payload).
   */
  function makePeer(id, clock, opts) {
    opts = opts || {};
    var peer = emitter({
      id: id, state: 'connecting', mode: null, rtt: 0, rttMin: 0, clockOffset: 0, lastSeen: 0,
      stats: { sentRel: 0, sentFast: 0, recvRel: 0, recvFast: 0, dropped: 0 }
    });
    var link = null, queue = [], samples = [], pingTimer = null, everOpened = false;
    var pingEvery = opts.pingInterval || 1000, linkTimeout = opts.linkTimeout || 8000;

    peer._setState = function (s) { if (peer.state !== s && peer.state !== 'closed') { peer.state = s; peer.emit('state', s); } };
    function raw(ch, payload) {
      if (!link) return false;
      var ok = false;
      try { ok = link.send(ch, payload); } catch (e) { ok = false; }
      if (ok) { if (ch === 'rel') peer.stats.sentRel++; else peer.stats.sentFast++; } else peer.stats.dropped++;
      return ok;
    }
    function encode(data) {
      if (data instanceof ArrayBuffer) return data;
      if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return JSON.stringify(data);
    }
    peer.send = function (ch, data) {
      if (ch !== 'rel' && ch !== 'fast') throw new Error('channel must be rel or fast');
      if (peer.state === 'closed') return false;
      var payload = encode(data);
      if (peer.state !== 'open' || !link) {
        if (ch === 'rel' && queue.length < REL_QUEUE_MAX) { queue.push(payload); return true; }
        peer.stats.dropped++;
        return false;
      }
      return raw(ch, payload);
    };
    peer.now = function () { return clock.now(); };
    peer.remoteNow = function () { return clock.now() + peer.clockOffset; };
    var pingN = 0;
    function ping() {
      if (peer.state !== 'open') return;
      if (peer.lastSeen && clock.now() - peer.lastSeen > linkTimeout) { peer._linkLost('timeout'); return; }
      if (link && link.mode === 'relay' && (pingN++ % 2)) return;   // over the server relay: half as often (request budget)
      raw('fast', JSON.stringify({ t: '_ping', a: clock.now() }));
    }
    peer._attach = function (l) {
      if (peer.state === 'closed') { try { l.close(); } catch (e) { /* ignore */ } return; }
      if (link && link !== l) { try { link.close(); } catch (e) { /* ignore */ } }
      link = l;
      peer.mode = l.mode || 'direct';
      peer.lastSeen = clock.now();
      peer._setState('open');
      var q = queue; queue = [];
      q.forEach(function (p) { raw('rel', p); });
      if (!pingTimer) pingTimer = clock.setInterval(ping, pingEvery);
      ping();
      if (!everOpened) { everOpened = true; peer.emit('open'); } else peer.emit('reopen');
    };
    peer._detach = function () {
      var l = link; link = null;
      if (l) { try { l.close(); } catch (e) { /* ignore */ } }
    };
    peer._hasLink = function (l) { return link === l; };
    /** Link died; owner decides about reconnecting (via 'lost' event). */
    peer._linkLost = function (reason) {
      if (peer.state === 'closed') return;
      peer._detach();
      peer._setState('reconnecting');
      peer.emit('lost', reason);
    };
    peer._recv = function (ch, payload) {
      if (peer.state === 'closed') return;
      peer.lastSeen = clock.now();
      if (ch === 'rel') peer.stats.recvRel++; else peer.stats.recvFast++;
      if (typeof payload !== 'string') {
        var ab = payload instanceof ArrayBuffer ? payload : ArrayBuffer.isView(payload) ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) : payload;
        peer.emit('message', ch, ab);
        return;
      }
      var m;
      try { m = JSON.parse(payload); } catch (e) { return; }
      if (m && typeof m.t === 'string' && m.t.charAt(0) === '_') {
        if (m.t === '_ping') raw('fast', JSON.stringify({ t: '_pong', a: m.a, b: clock.now() }));
        else if (m.t === '_pong') {
          var now = clock.now(), rtt = Math.max(0, now - m.a);
          samples.push({ rtt: rtt, off: m.b - (m.a + rtt / 2) });
          if (samples.length > 10) samples.shift();
          peer.rtt = peer.rtt ? peer.rtt * 0.75 + rtt * 0.25 : rtt;
          var best = samples[0];
          for (var i = 1; i < samples.length; i++) if (samples[i].rtt < best.rtt) best = samples[i];
          peer.clockOffset = best.off;
          peer.rttMin = best.rtt;
          peer.emit('rtt', peer.rtt);
        } else if (m.t === '_bye') peer.emit('bye', m.reason || 'left');
        return;
      }
      peer.emit('message', ch, m);
    };
    /** Final close. notify: send a bye first (rel). */
    peer._close = function (reason, notify) {
      if (peer.state === 'closed') return;
      if (notify && link) raw('rel', JSON.stringify({ t: '_bye', reason: notify }));
      if (pingTimer) { clock.clearInterval(pingTimer); pingTimer = null; }
      var l = link; link = null; queue = [];
      peer.state = 'closed';
      peer.emit('state', 'closed');
      peer.emit('close', reason || 'closed');
      // give the bye a moment to flush before tearing the link down
      if (l) clock.setTimeout(function () { try { l.close(); } catch (e) { /* ignore */ } }, notify ? 150 : 0);
    };
    return peer;
  }

  /* ---------------------------------------------------------------- host / client cores (link-agnostic) */
  function makeHost(clock, opts) {
    opts = opts || {};
    var H = emitter({ id: 'host', role: 'host', closed: false });
    var peers = new Map(), graceTimers = {};
    var maxPeers = opts.maxPeers || 7, graceMs = opts.graceMs == null ? 15000 : opts.graceMs;
    H.now = function () { return clock.now(); };
    H.list = function () { return Array.from(peers.values()).filter(function (p) { return p.state !== 'closed'; }); };
    H.get = function (id) { return peers.get(id) || null; };
    H.send = function (id, ch, data) { var p = peers.get(id); return p ? p.send(ch, data) : false; };
    H.broadcast = function (ch, data, except) {
      var n = 0, enc = data;
      if (ArrayBuffer.isView(data)) enc = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      peers.forEach(function (p) { if (p.id !== except && p.state === 'open' && p.send(ch, enc)) n++; });
      return n;
    };
    H._full = function (id) { return !peers.has(id) && H.list().length >= maxPeers; };
    /** get or create the Peer object for id (persists across reconnects). */
    H._peer = function (id) {
      var p = peers.get(id);
      if (p && p.state !== 'closed') return p;
      p = makePeer(id, clock, opts);
      peers.set(id, p);
      p.on('open', function () { H.emit('peer', p); });
      p.on('state', function (s) {
        if (s === 'open' && graceTimers[id]) { clock.clearTimeout(graceTimers[id]); delete graceTimers[id]; }
        H.emit('peer-state', p, s);
      });
      p.on('message', function (ch, data) { H.emit('message', p, ch, data); });
      p.on('bye', function (reason) { p._close(reason === 'left' ? 'left' : reason); });
      p.on('lost', function (reason) {
        if (graceTimers[id]) return;
        graceTimers[id] = clock.setTimeout(function () { delete graceTimers[id]; if (p.state !== 'open') p._close(reason || 'timeout'); }, graceMs);
      });
      p.on('close', function (reason) {
        if (graceTimers[id]) { clock.clearTimeout(graceTimers[id]); delete graceTimers[id]; }
        if (peers.get(id) === p) peers.delete(id);
        if (H._onPeerClosed) H._onPeerClosed(p, reason);
        H.emit('peer-leave', p, reason);
      });
      // host-side close(reason) == kick
      p.close = function (reason) { p._close(reason || 'kicked', reason || 'kicked'); };
      return p;
    };
    H.close = function () {
      if (H.closed) return;
      H.closed = true;
      H.list().forEach(function (p) { p._close('host-closed', 'host-closed'); });
      if (H._onClose) H._onClose();
      H.emit('close', 'closed');
    };
    return H;
  }

  function makeClient(clock, opts, selfId) {
    var C = makePeer('host', clock, opts);
    C.role = 'peer'; C.selfId = selfId; C.attempts = 0;
    C.hostNow = function () { return clock.now() + C.clockOffset; };
    var settle;
    C.ready = new Promise(function (res, rej) { settle = { res: res, rej: rej }; });
    C.ready.catch(function () {});
    C.on('open', function () { if (settle) { settle.res(C); settle = null; } });
    C.on('close', function (reason) { if (settle) { var e = new Error('connection ' + reason); e.code = reason; settle.rej(e); settle = null; } });
    C.on('bye', function (reason) { C._close(reason === 'left' ? 'host-closed' : reason); });
    C.close = function (reason) { C._close(reason || 'left', 'left'); };
    return C;
  }

  /* ---------------------------------------------------------------- WebRTC */
  function iceConfig(opts) {
    var list = (opts && opts.iceServers) ? opts.iceServers.slice() : DEFAULT_ICE.slice();
    var turn = (opts && opts.turn) || (typeof window !== 'undefined' ? (window.REDLINE_TURN || window.FORGE_TURN) : null);   // FORGE_TURN: pre-rebrand name
    if (turn) list = list.concat(Array.isArray(turn) ? turn : [turn]);
    return { iceServers: list, iceCandidatePoolSize: 0 };
  }
  function hasTurn(list) {
    return (list || []).some(function (s) { return [].concat(s && s.urls || []).some(function (u) { return /^turns?:/i.test(String(u)); }); });
  }
  /**
   * -> Promise<RTCConfiguration>: the static list (opts / DEFAULT_ICE / window.REDLINE_TURN) plus the TURN servers the
   * site's signalling server hands out (signal.ice(): api/turn-config.php or env). Never rejects; gives up after 3 s.
   */
  function iceConfigFor(signal, opts) {
    var base = iceConfig(opts);
    if (opts && (opts.iceServers || opts.serverIce === false)) return Promise.resolve(base);
    if (!signal || typeof signal.ice !== 'function') return Promise.resolve(base);
    return new Promise(function (resolve) {
      var done = false, t = setTimeout(function () { if (!done) { done = true; resolve(base); } }, 3000);
      Promise.resolve().then(function () { return signal.ice(); }).then(function (list) {
        if (done) return; done = true; clearTimeout(t);
        list = Array.isArray(list) ? list.filter(function (x) { return x && x.urls; }) : [];
        resolve(list.length ? Object.assign({}, base, { iceServers: base.iceServers.concat(list) }) : base);
      }, function () { if (!done) { done = true; clearTimeout(t); resolve(base); } });
    });
  }
  /**
   * Which path a connected RTCPeerConnection uses: 'turn' when the selected candidate pair goes through a TURN relay,
   * else 'direct'. -> Promise<'direct'|'turn'|null>
   */
  function selectedPath(pc) {
    if (!pc || typeof pc.getStats !== 'function') return Promise.resolve(null);
    return pc.getStats().then(function (st) {
      var byId = {}, pairId = null, pair = null;
      st.forEach(function (r) { byId[r.id] = r; if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
      pair = pairId ? byId[pairId] : null;
      if (!pair) st.forEach(function (r) { if (!pair && r.type === 'candidate-pair' && r.state === 'succeeded' && (r.selected || r.nominated)) pair = r; });
      if (!pair) return null;
      var lc = byId[pair.localCandidateId], rc = byId[pair.remoteCandidateId];
      return (lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay') ? 'turn' : 'direct';
    }, function () { return null; });
  }
  function relayLib() { return (CB.net && CB.net.relay) || null; }
  /** attach a server-relay link to `peer` (host side: to = peer id; client side: to = 'host') */
  function attachRelay(signal, peer, to, epoch, relayOpts) {
    var RL = relayLib();
    var l = RL.link(signal, to, function (ch, p) { if (peer._hasLink(l)) peer._recv(ch, p); }, Object.assign({}, relayOpts || {}, { epoch: epoch }));
    l.onDead = function (reason) { if (peer._hasLink(l)) peer._linkLost(reason || 'relay-failed'); };
    peer._attach(l);
    return l;
  }
  function getRTC(opts) {
    var R = (opts && opts.RTCPeerConnection) || globalThis.RTCPeerConnection || globalThis.webkitRTCPeerConnection;
    if (!R) { var e = new Error('WebRTC is not available in this browser'); e.code = 'unsupported'; throw e; }
    return R;
  }

  /** Wire an RTCPeerConnection to a Peer. Returns ctl {pc, sid, setRemote(desc), addIce(c), close()}. */
  function rtcLink(pc, peer, sid, sendSig, onDead) {
    var chans = {}, pending = [], remoteSet = false, dead = false, discTimer = null;
    var link = {
      mode: 'direct',
      send: function (ch, payload) {
        var dc = chans[ch];
        if (!dc || dc.readyState !== 'open') return false;
        if (ch === 'fast' && dc.bufferedAmount > FAST_BUFFER_MAX) return false;
        dc.send(payload);
        return true;
      },
      close: function () { die(null); }
    };
    function die(reason) {
      if (dead) return;
      dead = true;
      clearTimeout(discTimer);
      Object.keys(chans).forEach(function (k) { try { chans[k].close(); } catch (e) { /* ignore */ } });
      try { pc.close(); } catch (e) { /* ignore */ }
      if (reason && onDead) onDead(reason, link);
    }
    function attach(dc) {
      dc.binaryType = 'arraybuffer';
      chans[dc.label] = dc;
      dc.onopen = check;
      dc.onmessage = function (ev) { if (!dead) peer._recv(dc.label, ev.data); };
      dc.onclose = function () { if (!dead && peer._hasLink(link)) die('channel-closed'); };
      if (dc.readyState === 'open') check();
    }
    function check() {
      if (!dead && chans.rel && chans.fast && chans.rel.readyState === 'open' && chans.fast.readyState === 'open' && !peer._hasLink(link)) {
        peer._attach(link);
        // direct or through a TURN relay? (checked again later: ICE may switch to a better pair)
        var look = function () { selectedPath(pc).then(function (m) { if (m && !dead && peer._hasLink(link)) { link.mode = m; peer.mode = m; } }); };
        look(); setTimeout(look, 2500);
      }
    }
    pc.onicecandidate = function (ev) {
      if (dead) return;
      sendSig({ t: 'ice', c: ev.candidate ? (ev.candidate.toJSON ? ev.candidate.toJSON() : { candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex }) : null, sid: sid });
    };
    pc.ondatachannel = function (ev) { attach(ev.channel); };
    pc.onconnectionstatechange = function () {
      var s = pc.connectionState;
      if (s === 'failed') die('failed');
      else if (s === 'disconnected') { clearTimeout(discTimer); discTimer = setTimeout(function () { if (pc.connectionState !== 'connected') die('disconnected'); }, 4000); }
      else if (s === 'connected') clearTimeout(discTimer);
      else if (s === 'closed') die('closed');
    };
    var ctl = {
      pc: pc, sid: sid, link: link, attach: attach,
      setRemote: async function (desc) {
        await pc.setRemoteDescription(desc);
        remoteSet = true;
        var p = pending; pending = [];
        for (var i = 0; i < p.length; i++) { try { await pc.addIceCandidate(p[i]); } catch (e) { /* ignore bad candidate */ } }
      },
      addIce: async function (c) {
        if (dead) return;
        if (!remoteSet) { pending.push(c || null); return; }
        try { await pc.addIceCandidate(c || null); } catch (e) { /* ignore */ }
      },
      close: function () { die(null); },
      isDead: function () { return dead; }
    };
    return ctl;
  }

  function host(signal, opts) {
    opts = opts || {};
    var R = getRTC(opts), cfgP = iceConfigFor(signal, opts), clock = realClock();
    var H = makeHost(clock, opts);
    H.signal = signal;
    var conns = {}; // peerId -> rtc ctl
    function sendSig(id) { return function (m) { signal.send(id, m).catch(function () {}); }; }

    async function start(id, sid) {
      var cfg = await cfgP;
      if (H.closed) return;
      if (H._full(id)) { sendSig(id)({ t: 'reject', reason: 'full' }); return; }
      if (conns[id] && conns[id].sid === sid && !conns[id].isDead()) return; // duplicate join retry
      if (conns[id]) { conns[id].close(); delete conns[id]; }
      var peer = H._peer(id);
      if (peer.state === 'open') { peer._detach(); peer._setState('reconnecting'); }
      var pc = new R(cfg);
      var ctl = rtcLink(pc, peer, sid, sendSig(id), function (reason, link) {
        if (conns[id] === ctl) delete conns[id];
        if (peer._hasLink(link)) peer._linkLost(reason);
      });
      conns[id] = ctl;
      ctl.attach(pc.createDataChannel('rel', { ordered: true }));
      ctl.attach(pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
      try {
        var offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSig(id)({ t: 'sdp', type: 'offer', sdp: pc.localDescription.sdp, sid: sid });
      } catch (e) { H.emit('error', e); }
    }
    H._onPeerClosed = function (p) { if (conns[p.id]) { var c = conns[p.id]; delete conns[p.id]; setTimeout(function () { c.close(); }, 200); } };
    var offMsg = signal.onMessage(function (from, msg) {
      if (!msg || typeof msg !== 'object' || H.closed) return;
      var c = conns[from];
      if (msg.t === 'join') start(from, String(msg.sid || randId(6)));
      else if (msg.t === 'sdp' && msg.type === 'answer' && c && (msg.sid == null || msg.sid === c.sid)) c.setRemote({ type: 'answer', sdp: msg.sdp }).catch(function (e) { H.emit('error', e); });
      else if (msg.t === 'ice' && c && (msg.sid == null || msg.sid === c.sid)) c.addIce(msg.c);
      else if (msg.t === 'bye' || msg.t === '_leave') { var p = H.get(from); if (p) p._close('left'); }
      else if (msg.t === 'relay' && opts.relay && relayLib() && relayLib().supported(signal)) hostRelay(from, msg);
    });
    function hostRelay(id, msg) {
      if (H._full(id)) { sendSig(id)({ t: 'reject', reason: 'full' }); return; }
      var peer = H._peer(id), e = String(msg.e || '');
      // same request repeated (our relay-ok got lost / crossed): keep the link, just confirm again
      if (!(peer.state === 'open' && peer.mode === 'relay' && peer._relayEpoch === e)) {
        if (conns[id]) { conns[id].close(); delete conns[id]; } // stop ICE: one path at a time
        peer._relayEpoch = e;
        attachRelay(signal, peer, id, null, opts.relayOpts);
      }
      sendSig(id)({ t: 'relay-ok', e: e });
    }
    H._onClose = function () { offMsg(); setTimeout(function () { Object.keys(conns).forEach(function (k) { conns[k].close(); }); conns = {}; }, 250); };
    return H;
  }

  function connect(signal, opts) {
    opts = opts || {};
    var R = getRTC(opts), cfgP = iceConfigFor(signal, opts), clock = realClock(), turnOn = false;
    cfgP.then(function (c) { turnOn = hasTurn(c.iceServers); });
    var C = makeClient(clock, opts, signal.peer);
    C.signal = signal;
    var ctl = null, wantSid = null, joinTimer = null, joinTries = 0, failTimer = null;
    var maxAttempts = opts.reconnectAttempts == null ? 3 : opts.reconnectAttempts;
    var relayOn = !!(opts.relay && relayLib() && relayLib().supported(signal) && !(signal.caps && signal.caps.codes));
    var relayAfter = (opts.relay && opts.relay.after) || 4500, relayTimer = null, relayEpoch = null, joinAt = 0;
    // with TURN available, ICE over TURN/TLS may need a few more seconds before the server relay takes over
    var turnAfter = (opts.relay && opts.relay.turnAfter) || 9000;
    var relayOpts = opts.relay && typeof opts.relay === 'object' ? opts.relay : null;
    function sig(m) { return signal.send('host', m).catch(function () {}); }
    C.stage = 'waiting';
    function stage(s) { if (C.stage !== s) { C.stage = s; C.emit('stage', s); } }
    function askRelay(iceDead) {
      clearTimeout(relayTimer);
      if (!relayOn || C.state === 'open' || C.state === 'closed') return;
      var wait = joinAt + turnAfter - Date.now();
      if (iceDead !== true && turnOn && !relayEpoch && ctl && !ctl.isDead() && wait > 0) { relayTimer = setTimeout(askRelay, wait); return; }
      if (!relayEpoch) relayEpoch = randId(8);
      stage('relay');
      sig({ t: 'relay', sid: wantSid, e: relayEpoch });
      relayTimer = setTimeout(askRelay, 3000); // repeat until the host confirms
    }
    function onRelayOk(msg) {
      if (!relayEpoch || msg.e !== relayEpoch || C.state === 'open' || C.state === 'closed') return;
      clearTimeout(relayTimer);
      if (ctl) { var c0 = ctl; ctl = null; c0.close(); }
      attachRelay(signal, C, 'host', relayEpoch, relayOpts);
    }

    function sendJoin() {
      wantSid = randId(8); joinTries = 0; relayEpoch = null; joinAt = Date.now();
      stage('waiting');
      if (relayOn) { clearTimeout(relayTimer); relayTimer = setTimeout(askRelay, relayAfter); }
      (function again() {
        if (C.state === 'open' || C.state === 'closed') return;
        if (++joinTries > 5) return;
        sig({ t: 'join', v: PROTO, sid: wantSid });
        joinTimer = setTimeout(again, ctl ? 8000 : 4000);
      })();
    }
    function startFailTimer() {
      clearTimeout(failTimer);
      failTimer = setTimeout(function () { if (C.state !== 'open' && C.state !== 'closed') { C.emit('error', Object.assign(new Error('could not connect'), { code: 'timeout' })); C._close('timeout'); } }, opts.timeout || (signal.caps && signal.caps.codes ? 600000 : 30000)); // manual: humans copy/paste codes
    }
    async function onOffer(msg) {
      var cfg = await cfgP;
      if (C.state === 'closed') return;
      if (relayEpoch) return; // already switching to / using the server relay
      if (ctl && msg.sid === ctl.sid) return; // duplicate
      if (!(msg.sid === wantSid || !ctl || ctl.isDead())) return; // stale
      if (ctl) ctl.close();
      stage('connecting');
      var pc = new R(cfg);
      var my = ctl = rtcLink(pc, C, msg.sid, sig, function (reason, link) {
        if (C._hasLink(link)) C._linkLost(reason);
        else if (relayOn && my === ctl && C.state !== 'open' && C.state !== 'closed') askRelay(true); // ICE failed: relay now
        else if (C.state === 'connecting' && my === ctl && !(signal.caps && signal.caps.reconnect)) {
          // manual codes: ICE gave up before the host pasted our answer -> codes expired, make new ones
          C.emit('error', Object.assign(new Error('connection attempt expired'), { code: 'expired' }));
          C._close('expired');
        }
      });
      try {
        await my.setRemote({ type: 'offer', sdp: msg.sdp });
        var ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        sig({ t: 'sdp', type: 'answer', sdp: pc.localDescription.sdp, sid: msg.sid });
      } catch (e) { C.emit('error', e); }
    }
    var offMsg = signal.onMessage(function (from, msg) {
      if (from !== 'host' || !msg || typeof msg !== 'object') return;
      if (msg.t === 'sdp' && msg.type === 'offer') onOffer(msg);
      else if (msg.t === 'ice' && ctl && (msg.sid == null || msg.sid === ctl.sid)) ctl.addIce(msg.c);
      else if (msg.t === 'relay-ok') onRelayOk(msg);
      else if (msg.t === 'reject') C._close(msg.reason || 'rejected');
      else if (msg.t === '_closed' || msg.t === 'bye') { if (C.state !== 'open') C._close('host-closed'); }
    });
    C.on('open', function () { clearTimeout(joinTimer); clearTimeout(failTimer); clearTimeout(relayTimer); C.attempts = 0; stage('open'); });
    C.on('reopen', function () { clearTimeout(joinTimer); clearTimeout(failTimer); clearTimeout(relayTimer); C.attempts = 0; stage('open'); });
    C.on('lost', function (reason) {
      if (!signal.caps || !signal.caps.reconnect || signal.state === 'closed' || C.attempts >= maxAttempts) { C._close(reason || 'failed'); return; }
      C.attempts++;
      setTimeout(function () { if (C.state === 'reconnecting') { sendJoin(); startFailTimer(); } }, 1000 * Math.pow(2, C.attempts - 1));
    });
    C.on('close', function () {
      clearTimeout(joinTimer); clearTimeout(failTimer); clearTimeout(relayTimer); offMsg();
      sig({ t: 'bye' });
      var c = ctl; setTimeout(function () { if (c) c.close(); }, 250);
    });
    sendJoin();
    startFailTimer();
    return C;
  }

  /* ---------------------------------------------------------------- loopback network */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function loopback(netOpts) {
    netOpts = netOpts || {};
    var cond = { latency: netOpts.latency == null ? 30 : netOpts.latency, jitter: netOpts.jitter || 0, loss: netOpts.loss || 0 };
    var rng = mulberry32(netOpts.seed == null ? 1 : netOpts.seed);
    var manual = netOpts.clock !== 'real';
    var base;
    if (manual) base = scheduler();
    else { var t0 = perfNow(); base = realClock(-t0); base.advance = function () {}; }
    var H = null, clients = [], links = {}; // id -> {up:boolean, pair}
    var net = {
      now: function () { return base.now(); },
      advance: function (ms) { base.advance(ms); },
      run: function (ms, step) { step = step || 16; for (var t = 0; t < ms; t += step) base.advance(Math.min(step, ms - t)); },
      setConditions: function (c) { Object.keys(c || {}).forEach(function (k) { if (k in cond) cond[k] = c[k]; }); },
      conditions: function () { return Object.assign({}, cond); },
      clients: function () { return clients.slice(); },
      clock: base
    };
    function copy(p) { return typeof p === 'string' ? p : p instanceof ArrayBuffer ? p.slice(0) : ArrayBuffer.isView(p) ? p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength) : p; }
    /** One direction of a link pair: sends to `dst` peer. */
    function half(rec, dst) {
      var lastRel = 0;
      return {
        send: function (ch, payload) {
          if (!rec.up) return false;
          var data = copy(payload);
          if (ch === 'fast' && cond.loss > 0 && rng() < cond.loss) return true; // silently lost on the wire
          var delay = cond.latency + (cond.jitter ? rng() * cond.jitter : 0);
          var at = base.now() + delay;
          if (ch === 'rel') { at = Math.max(at, lastRel); lastRel = at; }
          var gen = rec.gen;
          base.setTimeout(function () { if (rec.up && rec.gen === gen) dst._recv(ch, data); }, at - base.now());
          return true;
        },
        close: function () {
          if (!rec.up) return;
          rec.up = false;
          // the other side notices after one latency (like a channel close)
          base.setTimeout(function () { if (rec.onDown) rec.onDown('closed'); }, cond.latency);
        }
      };
    }
    function establish(id) {
      var rec = links[id];
      if (!rec || !H || H.closed) return;
      var C = rec.client;
      if (C.state === 'closed') return;
      if (H._full(id)) { C._close('full'); return; }
      var hp = H._peer(id);
      rec.up = true; rec.gen = (rec.gen || 0) + 1;
      var gen = rec.gen;
      var toClient = half(rec, C), toHost = half(rec, hp);
      rec.hostLink = toClient; rec.clientLink = toHost;
      rec.onDown = function (reason) {
        if (rec.gen !== gen) return;
        if (hp._hasLink(toClient)) hp._linkLost(reason);
        if (C._hasLink(toHost)) C._linkLost(reason);
      };
      hp._attach(toClient);
      C._attach(toHost);
    }
    net.host = function (opts) {
      if (H && !H.closed) throw new Error('loopback already has a host');
      H = makeHost(base, Object.assign({ pingInterval: netOpts.pingInterval }, opts || {}));
      H._onPeerClosed = function (p, reason) {
        var rec = links[p.id];
        if (rec && rec.up) {
          var gen = rec.gen;
          base.setTimeout(function () {
            if (rec.gen === gen) rec.up = false;
            if (rec.client.state !== 'closed') rec.client._close(reason === 'left' ? 'left' : reason || 'kicked');
          }, cond.latency + 160);
        }
      };
      return H;
    };
    net.connect = function (opts) {
      opts = opts || {};
      var id = opts.id || 'p' + randId(6);
      var clock = opts.skew ? skewed(base, opts.skew) : base;
      var C = makeClient(clock, Object.assign({ pingInterval: netOpts.pingInterval }, opts), id);
      var rec = links[id] = { up: false, client: C, gen: 0 };
      clients.push(C);
      C.on('lost', function () {
        if (rec.permanent || C.attempts >= (opts.reconnectAttempts == null ? 3 : opts.reconnectAttempts)) { C._close('failed'); return; }
        C.attempts++;
        base.setTimeout(function () { if (C.state === 'reconnecting') establish(id); }, cond.latency * 2 + 200);
      });
      C.on('reopen', function () { C.attempts = 0; });
      C.on('close', function (reason) {
        if (rec.up && H) {
          var hp = H.get(id);
          // bye travels over rel; then the link goes down
          base.setTimeout(function () { rec.up = false; if (hp && hp.state !== 'closed') hp._close(reason === 'left' ? 'left' : reason); }, cond.latency + 160);
        }
      });
      base.setTimeout(function () {
        if (!H || H.closed) { C._close('timeout'); return; }
        establish(id);
      }, Math.round(cond.latency * 3));
      return C;
    };
    net.disconnect = function (id, o) {
      var rec = links[id];
      if (!rec || !rec.up) return false;
      rec.permanent = !!(o && o.permanent);
      rec.up = false;
      if (rec.onDown) rec.onDown('disconnected');
      return true;
    };
    return net;
  }

  var api = {
    PROTO: PROTO, DEFAULT_ICE: DEFAULT_ICE, PACK: PACK,
    host: host, connect: connect, loopback: loopback,
    packStates: packStates, unpackStates: unpackStates, packState: packState, unpackState: unpackState, isStates: isStates,
    iceConfig: iceConfig, iceConfigFor: iceConfigFor, selectedPath: selectedPath,
    _makePeer: makePeer, _scheduler: scheduler
  };
  CB.net = CB.net || {};
  CB.net.transport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

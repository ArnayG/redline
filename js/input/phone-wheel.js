/* ==========================================================================
   FORGE — js/input/phone-wheel.js
   CB.input.wheel : "use your phone as a steering wheel" for the game running on the computer.
   Rides on the multiplayer plumbing: CB.net.signal (online /api/signal, same-device BroadcastChannel, or manual
   invite codes) + CB.net.transport (WebRTC data channels: 'fast' unordered for the ~60 Hz wheel input, 'rel' for
   control). Pure protocol core (transport-agnostic, tested over the loopback transport) + the desktop pairing session.

   Protocol 'forge-wheel/1' (JSON on both channels)
     phone -> desktop  rel  {t:'hello', v, name, sensor:'tilt'|'touch'}       {t:'btn', b:'shiftUp'|'shiftDown'|'pause'|'camera'|'reset'|'confirm'}
                      fast {t:'in', q:seq, s:steer(-1..1, + = right), th, br (0..1), hb:0|1, a:wheel angle deg}   ~60 Hz
     desktop -> phone rel  {t:'welcome', v, game}   {t:'status', driving, paused, screen, gear}   {t:'bye', reason}
                      fast {t:'hap', k:'kerb'|'hit'|'wall'|'offroad', i:0..1}  {t:'tel', spd (km/h), gear, rpm (0..1)}  ~10 Hz
                      {t:'arcade', on, nitro 0..1, nitroOn, item id|'?'|null, uses, nitroEnabled}  ~4 Hz in arcade sessions
     phone -> desktop  arcade buttons: {t:'btn', b:'nitroOn'|'nitroOff'|'item'|'itemBack'}  (hub.onEvent subscribers)
   Failsafe (desktop): no input packet for staleMs (300 ms) or the link drops -> the hub source reports centred steering,
   no throttle, no brake (the car coasts straight; assists keep it on the road). When the phone is gone for good the
   source goes inactive and the keyboard / gamepad take over. Reconnects resume automatically.
   Server relay (js/net/relay.js): when WebRTC cannot connect (campus Wi-Fi client isolation, UDP blocked, strict NAT)
   both ends fall back to relaying through api/signal(.php) after ~4.5 s. Input then arrives in batches at ~4–6 Hz
   (latest state wins), so the failsafe is relaxed to relayStaleMs (1000 ms) in relay mode. rx.mode() / S.mode():
   'direct' | 'relay' | null.

     var rx = wheel.createReceiver(host, {hub, now, staleMs, name})   desktop side (host: CB.net.transport host / loopback host)
       rx.state 'waiting'|'connected'|'stale'   rx.phone {id, name, rtt}   rx.read(now) (hub source)   rx.rate (Hz)
       rx.on('state'|'input'|'hello'|'btn', fn)   rx.send(type, obj, channel?)   rx.close()
     var tx = wheel.createSender(client, {now, rateHz:60, name, sensor})   phone side (client: transport client)
       tx.set({steer, throttle, brake, handbrake, angle})   tx.tick(now) (sends 'in' when due)   tx.press(button)
       tx.on('welcome'|'status'|'hap'|'tel'|'state', fn)   tx.state   tx.rtt()   tx.close()
     wheel.pair(opts?) -> Promise<Session>   desktop: create a room and wait for the phone
       opts {via:'auto'|'online'|'local'|'manual'}
       Session {via, code, url, invite?, state, rx, accept(answerCode) (manual), close(), on('state'|'change', fn)}
     wheel.session()  the active pairing session (or null)      wheel.urlFor(code, via) -> the phone URL
     wheel.parseRoute(hash) -> {code, via, invite} | null      (#/wheel/ABCDE, #/wheel/ABCDE?via=local, #/wheel/~<invite>)
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.input = CB.input || {};

(function () {
  'use strict';

  var PROTO = 'forge-wheel/1';
  var CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
  var LOCAL_CHANNEL = 'forge-wheel-v1';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function emitter(o) {
    var map = {};
    o.on = function (t, fn) { (map[t] = map[t] || []).push(fn); return function () { var l = map[t]; if (l) { var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }; };
    o.emit = function (t) { var a = Array.prototype.slice.call(arguments, 1); (map[t] || []).slice().forEach(function (fn) { try { fn.apply(null, a); } catch (e) { if (typeof console !== 'undefined') console.error('[wheel]', e); } }); };
    return o;
  }

  /* ================================================================ desktop: receiver */
  function createReceiver(host, opts) {
    opts = opts || {};
    var now = opts.now || nowMs, directStale = num(opts.staleMs, 300), relayStale = num(opts.relayStaleMs, 1000);
    function staleLimit() { return cur && cur.mode === 'relay' ? relayStale : directStale; }
    var hub = opts.hub === undefined ? CB.input.hub : opts.hub;
    var rx = emitter({ state: 'waiting', phone: null, rate: 0, closed: false, lastIn: null });
    var cur = null;                         // the phone's Peer
    var inp = { steer: 0, throttle: 0, brake: 0, handbrake: false, angle: 0, q: -1, t: -1e9 };
    var rateN = 0, rateT0 = 0, offs = [];
    function setState(s) { if (rx.state !== s) { rx.state = s; rx.emit('state', s); } }
    function neutral() { inp.steer = 0; inp.throttle = 0; inp.brake = 0; inp.handbrake = false; }
    function adopt(peer) {
      if (cur && cur !== peer && cur.state !== 'closed') { try { cur.send('rel', { t: 'bye', reason: 'replaced' }); cur.close('replaced'); } catch (e) { /* ignore */ } }
      cur = peer; inp.q = -1;
      rx.phone = { id: peer.id, name: rx.phone && rx.phone.id === peer.id ? rx.phone.name : 'Phone', rtt: peer.rtt || 0 };
    }
    offs.push(host.on('peer', function (peer) { adopt(peer); setState('connected'); }));
    offs.push(host.on('peer-state', function (peer, s) {
      if (peer !== cur) return;
      if (s === 'open') setState('connected');
      else if (s === 'reconnecting') { neutral(); setState('stale'); }
    }));
    offs.push(host.on('peer-leave', function (peer) {
      if (peer !== cur) return;
      cur = null; neutral(); setState('waiting');
    }));
    offs.push(host.on('message', function (peer, ch, m) {
      if (!m || typeof m !== 'object') return;
      if (peer !== cur) { if (m.t === 'hello') adopt(peer); else return; }
      if (m.t === 'in') {
        var q = num(m.q, 0);
        if (q <= inp.q && inp.q - q < 1000) return;             // late / duplicated unordered packet
        inp.q = q; inp.t = now();
        inp.steer = clamp(num(+m.s, 0), -1, 1); inp.throttle = clamp(num(+m.th, 0), 0, 1); inp.brake = clamp(num(+m.br, 0), 0, 1);
        inp.handbrake = !!m.hb; inp.angle = num(+m.a, 0);
        rateN++; var t = inp.t; if (!rateT0) rateT0 = t; if (t - rateT0 >= 1000) { rx.rate = Math.round(rateN * 1000 / (t - rateT0)); rateN = 0; rateT0 = t; }
        if (rx.state !== 'connected') setState('connected');
        rx.lastIn = inp;
        rx.emit('input', inp);
      } else if (m.t === 'hello') {
        if (m.v !== PROTO) { peer.send('rel', { t: 'bye', reason: 'version' }); return; }
        rx.phone = { id: peer.id, name: String(m.name || 'Phone').slice(0, 40), rtt: peer.rtt || 0, sensor: m.sensor || 'tilt' };
        peer.send('rel', { t: 'welcome', v: PROTO, game: opts.name || 'Redline' });
        if (hub && hub.status) { var st = hub.status(); peer.send('rel', statusMsg(st)); }
        setState('connected');
        rx.emit('hello', rx.phone);
      } else if (m.t === 'btn' && typeof m.b === 'string') {
        if (hub && hub.pushEvent) hub.pushEvent(m.b, 'wheel');
        rx.emit('btn', m.b);
      }
    }));
    function statusMsg(st) { st = st || {}; return { t: 'status', driving: !!st.driving, paused: !!st.paused, screen: st.screen || null, gear: st.gear | 0, net: !!st.net }; }
    /** Hub source: the failsafe lives here. */
    rx.read = function (t) {
      t = num(t, now());
      if (rx.closed || !cur) return null;                                    // gone -> inactive (keyboard takes over)
      var fresh = rx.state === 'connected' && t - inp.t <= staleLimit();
      if (!fresh) return { active: true, stale: true, steer: 0, throttle: 0, brake: 0, handbrake: false };   // centre + lift
      return { active: true, steer: inp.steer, throttle: inp.throttle, brake: inp.brake, handbrake: inp.handbrake };
    };
    rx.isFresh = function (t) { return !!cur && rx.state === 'connected' && num(t, now()) - inp.t <= staleLimit(); };
    rx.mode = function () { return cur && cur.state === 'open' ? (cur.mode || 'direct') : null; };
    rx.rtt = function () { return cur ? Math.round(cur.rtt || 0) : null; };
    rx.send = function (type, obj, ch) { if (!cur || cur.state !== 'open') return false; return cur.send(ch || 'rel', Object.assign({ t: type }, obj || {})); };
    var unreg = null, offHub = [];
    if (hub && hub.register) {
      unreg = hub.register('wheel', { read: rx.read }, 10);
      offHub.push(hub.onFeedback(function (f) { if (f && f.kind) rx.send('hap', { k: f.kind, i: r3(clamp(num(f.intensity, 0.5), 0, 1)) }, 'fast'); }));
      offHub.push(hub.onStatus(function (st) { if (cur && cur.state === 'open') cur.send('rel', statusMsg(st)); }));
    }
    var telT = 0;
    /** Telemetry for the phone's dash (called by the UI at frame rate; throttled to ~10 Hz). */
    rx.telemetry = function (st, t) {
      t = num(t, now());
      if (!cur || t - telT < 100 || !st) return;
      telT = t;
      rx.send('tel', { spd: Math.round(num(st.speed, 0) * 3.6), gear: num(st.gear, 0) | 0, rpm: r3(num(st.rpmFrac, 0)) }, 'fast');
    };
    rx.close = function (reason) {
      if (rx.closed) return;
      if (cur && cur.state === 'open') { try { cur.send('rel', { t: 'bye', reason: reason || 'closed' }); } catch (e) { /* ignore */ } }
      rx.closed = true; cur = null; neutral();
      offs.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } });
      offHub.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } });
      if (unreg) unreg();
      setState('closed');
    };
    return rx;
  }

  /* ================================================================ phone: sender */
  function createSender(client, opts) {
    opts = opts || {};
    var now = opts.now || nowMs, period = 1000 / clamp(num(opts.rateHz, 60), 5, 120);
    var tx = emitter({ state: client.state || 'connecting', closed: false, sent: 0, welcome: null, status: null });
    var v = { steer: 0, throttle: 0, brake: 0, handbrake: false, angle: 0 }, q = 0, lastT = -1e9;
    var offs = [];
    function hello() { client.send('rel', { t: 'hello', v: PROTO, name: opts.name || 'Phone', sensor: opts.sensor || 'tilt' }); }
    offs.push(client.on('state', function (s) { tx.state = s; tx.emit('state', s); if (s === 'open') hello(); }));
    offs.push(client.on('close', function (reason) { tx.state = 'closed'; tx.emit('state', 'closed', reason); }));
    offs.push(client.on('message', function (ch, m) {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'welcome') { tx.welcome = m; tx.emit('welcome', m); }
      else if (m.t === 'status') { tx.status = m; tx.emit('status', m); }
      else if (m.t === 'hap') tx.emit('hap', { kind: m.k, intensity: num(m.i, 0.5) });
      else if (m.t === 'tel') tx.emit('tel', m);
      else if (m.t === 'arcade') tx.emit('arcade', m);   // arcade gameplay HUD for the phone (NITRO / ITEM buttons)
      else if (m.t === 'bye') tx.emit('bye', m.reason || 'closed');
    }));
    if (client.state === 'open') hello();
    tx.set = function (o) {
      o = o || {};
      if (o.steer != null) v.steer = clamp(num(+o.steer, 0), -1, 1);
      if (o.throttle != null) v.throttle = clamp(num(+o.throttle, 0), 0, 1);
      if (o.brake != null) v.brake = clamp(num(+o.brake, 0), 0, 1);
      if (o.handbrake != null) v.handbrake = !!o.handbrake;
      if (o.angle != null) v.angle = num(+o.angle, 0);
    };
    tx.get = function () { return Object.assign({}, v); };
    tx.packet = function () { return { t: 'in', q: q, s: r3(v.steer), th: r3(v.throttle), br: r3(v.brake), hb: v.handbrake ? 1 : 0, a: Math.round(v.angle * 10) / 10 }; };
    /** Send the input when due (call every animation frame). Returns true when a packet went out. */
    tx.tick = function (t) {
      t = num(t, now());
      if (tx.closed || client.state !== 'open' || t - lastT < period - 1) return false;
      lastT = t; q++;
      var ok = client.send('fast', tx.packet());
      if (ok) tx.sent++;
      return ok;
    };
    tx.press = function (b) { if (client.state === 'open') return client.send('rel', { t: 'btn', b: String(b) }); return false; };
    tx.rtt = function () { return Math.round(client.rtt || 0); };
    tx.mode = function () { return client.state === 'open' ? (client.mode || 'direct') : null; };
    tx.close = function () {
      if (tx.closed) return;
      tx.closed = true;
      offs.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } });
    };
    return tx;
  }

  /* ================================================================ routes / URLs */
  function parseRoute(hash) {
    var h = String(hash || '').replace(/^#/, '');
    var m = /^\/?wheel\/([^?&]*)(?:[?&](.*))?$/i.exec(h);
    if (!m) return null;
    var seg = decodeURIComponent(m[1] || ''), q = {};
    String(m[2] || '').split('&').forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
    if (seg.charAt(0) === '~') return { code: null, invite: seg.slice(1), via: 'manual' };
    var code = seg.toUpperCase().replace(/[\s-]/g, '');
    return { code: CODE_RE.test(code) ? code : null, via: q.via === 'local' ? 'local' : q.via === 'manual' ? 'manual' : 'online', invite: null, raw: seg };
  }
  function baseUrl() {
    if (typeof window === 'undefined' || !window.location) return 'index.html';
    var L = window.location, path = L.pathname || '/';
    path = path.replace(/[^/]*$/, '');
    return (L.origin && L.origin !== 'null' ? L.origin : L.protocol + '//' + L.host) + path + 'index.html';
  }
  function urlFor(code, via, invite) {
    if (invite) return baseUrl() + '#/wheel/~' + invite;
    return baseUrl() + '#/wheel/' + code + (via === 'local' ? '?via=local' : '');
  }

  /* ================================================================ desktop pairing session */
  var active = null;
  function signalFor(via) {
    var S = CB.net && CB.net.signal;
    if (!S) throw Object.assign(new Error('Multiplayer modules missing'), { code: 'unsupported' });
    if (via === 'local') return S.local({ channel: LOCAL_CHANNEL });
    if (via === 'manual') return S.manual();
    return S.vercel();
  }
  function detectVia() {
    var S = CB.net && CB.net.signal;
    if (!S || typeof S.detect !== 'function') return Promise.resolve('manual');
    return S.detect().then(function (k) { return k === 'vercel' ? 'online' : 'manual'; }, function () { return 'manual'; });
  }
  function pair(opts) {
    opts = opts || {};
    var T = CB.net && CB.net.transport;
    if (!T) return Promise.reject(Object.assign(new Error('Transport missing'), { code: 'unsupported' }));
    if (active && !active.closed && (!opts.via || opts.via === 'auto' || opts.via === active.via)) return Promise.resolve(active);
    if (active) active.close();
    var viaP = !opts.via || opts.via === 'auto' ? detectVia() : Promise.resolve(opts.via);
    return viaP.then(function (via) {
      var sig = signalFor(via);
      return sig.create().then(function (room) {
        var host = (opts.transport || T).host(sig, { maxPeers: 2, graceMs: 30000, pingInterval: 500, relay: opts.relay !== false });
        var rx = createReceiver(host, { hub: CB.input.hub, name: 'Redline' });
        var S = emitter({ via: via, code: room.room, url: null, invite: null, state: 'waiting', rx: rx, host: host, signal: sig, closed: false, error: null });
        S.url = urlFor(room.room, via);
        S.mode = function () { return rx.mode(); };
        rx.on('state', function (s) {
          S.state = s;
          if (s === 'connected' && sig.setIdle) { try { sig.setIdle(true); } catch (e) { /* ignore */ } }
          if (s === 'waiting' && sig.setIdle) { try { sig.setIdle(false); } catch (e2) { /* ignore */ } }
          S.emit('state', s); S.emit('change');
        });
        rx.on('hello', function () { S.emit('change'); });
        sig.on && sig.on('closed', function () { if (!S.closed) { S.error = 'signal-closed'; S.emit('change'); } });
        S.newInvite = function () {
          if (via !== 'manual' || !sig.invite) return Promise.resolve(null);
          return sig.invite().then(function (code) { S.invite = code; S.url = urlFor(null, 'manual', code); S.emit('change'); return code; });
        };
        S.accept = function (answer) { return sig.accept ? sig.accept(String(answer || '').trim()) : Promise.reject(new Error('not manual')); };
        S.close = function () {
          if (S.closed) return;
          S.closed = true;
          try { rx.close('closed'); } catch (e) { /* ignore */ }
          try { host.close(); } catch (e1) { /* ignore */ }
          try { sig.close(); } catch (e2) { /* ignore */ }
          if (active === S) active = null;
          S.state = 'closed'; S.emit('state', 'closed'); S.emit('change');
          if (CB.input.wheel) CB.input.wheel.emit('session', null);
        };
        active = S;
        if (CB.input.wheel) CB.input.wheel.emit('session', S);
        return via === 'manual' ? S.newInvite().then(function () { return S; }) : S;
      });
    });
  }

  var api = emitter({
    PROTO: PROTO, LOCAL_CHANNEL: LOCAL_CHANNEL,
    createReceiver: createReceiver, createSender: createSender,
    parseRoute: parseRoute, urlFor: urlFor, baseUrl: baseUrl, signalFor: signalFor, detectVia: detectVia,
    pair: pair, session: function () { return active && !active.closed ? active : null }
  });
  CB.input.wheel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

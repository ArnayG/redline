/* ==========================================================================
   FORGE Atelier — js/net/signal.js
   CB.net.signal : client-side signalling backends for multiplayer (docs/NET-SPEC.md). Zero dependencies, classic script,
   also loadable in Node (require) for tests.

   Every backend returns a Signal object with the same interface:
     sig.kind                    'vercel' | 'local' | 'manual'
     sig.caps                    {trickle, reconnect, codes}  (manual: no trickle/reconnect, uses copy/paste codes)
     sig.create()      -> Promise<{room, peer:'host', role:'host'}>
     sig.join(code)    -> Promise<{room, peer, role:'peer', host:'host'}>
     sig.send(to, msg) -> Promise   (msg: any JSON value; peers can only reach 'host', host can reach any peer id)
     sig.onMessage(fn(from, msg)) -> unsubscribe   (messages received before the first listener are buffered)
     sig.on(type, fn) -> unsubscribe   types: 'message'(from,msg) 'state'(state) 'closed'({reason}) 'error'(err)
                                              'code'({kind:'invite'|'answer', peer, code})   (manual only)
     sig.close()       -> Promise   (host: closes the room for everyone; peer: leaves)
     sig.room / sig.peer / sig.role / sig.state ('idle'|'open'|'reconnecting'|'closed')
     sig.setIdle(bool)            (vercel: slower, cheaper polling once WebRTC is up — still receives late joiners)
   Server-relay extras (vercel only, caps.relay; used by js/net/relay.js when WebRTC cannot connect):
     sig.exchange(posts:[{to, msgs}], wait, {nopoll}) -> Promise<n received>   one 'relay' request = post + poll; the
                                  received messages are delivered through onMessage exactly like the poll loop's
     sig.stream({wait, probe, onHeader}) -> Promise<{streamed, buffered, n, max}>   streamed downlink: one 'relay'
                                  request whose NDJSON response carries many messages as they arrive; detects a
                                  buffering proxy (lines written > 250 ms apart arriving together); old servers answer
                                  plain JSON (streamed:false)
     sig.pausePolling(bool)       stop / restart the background poll loop (the relay's loops replace it)
     sig.ice() -> Promise<[RTCIceServer]>   TURN/STUN servers from the site's server-side config ('ice' action;
                                  [] when none / old server). Used by CB.net.transport automatically.
   Errors (err.code): 'unreachable' (no response / network down / timeout), 'blocked' (HTTP 403/406/429/5xx with a
     non-JSON body: host firewall such as ModSecurity / Sucuri; err.status), 'no-backend', 'not-found', 'room-closed', …
   Manual-only extras (no server at all, works from file://):
     host: sig.invite()        -> Promise<inviteCode>  (one per guest; resolves once the host's offer+ICE are gathered)
           sig.accept(answer)  -> Promise<peerId>      (paste the guest's answer code)
     guest: sig.join(inviteCode), then sig.answer() -> Promise<answerCode> (give it back to the host)
   Factories:
     CB.net.signal.vercel(opts?)  opts: {url, fetch, wait:8000}   url omitted -> auto-detected endpoint (see endpoint())
     CB.net.signal.local(opts?)   BroadcastChannel (same browser, two tabs) — opts: {channel, probeTimeout}
     CB.net.signal.manual(opts?)  opts: {gatherTimeout:3500}
     CB.net.signal.open(kind, opts)
     CB.net.signal.detect(opts?) -> Promise<'vercel'|'manual'>   (POST {action:'status'}; file:// -> 'manual')
     CB.net.signal.endpoint(opts?) -> Promise<url|null>  probes ENDPOINTS (relative, so a sub-folder install works):
                                    'api/signal.php' first (PHP / cPanel; vercel.json and tools/dev-server.js map it to the
                                    Node function too), then 'api/signal'; the first that answers {ok:true} wins and is
                                    cached for the page
     CB.net.signal.auto(opts?)   -> Promise<Signal>
     CB.net.signal.normalizeCode(str) -> 'ABCDE' | null   (accepts 'abcde', 'AB-CDE', '…#/multiplayer/ABCDE')
     CB.net.signal.codec: {encode(obj, kind), decode(code), compactSdp(sdp), expandSdp(obj)}
   Signalling message shapes used by CB.net.transport (manual understands them):
     {t:'join', v, sid}  {t:'sdp', type:'offer'|'answer', sdp, sid}  {t:'ice', c:{candidate,sdpMid,sdpMLineIndex}|null, sid}
     {t:'bye'}   Backend-generated: {t:'_leave'} (peer left, to host)  {t:'_closed'} (room closed, to peers)
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var hasWin = typeof window !== 'undefined';

  /* ---------------------------------------------------------------- utils */
  function rand(n, alpha) {
    alpha = alpha || ALPHABET;
    var s = '', buf = null;
    var c = globalThis.crypto;
    if (c && c.getRandomValues) { buf = new Uint8Array(n); c.getRandomValues(buf); }
    for (var i = 0; i < n; i++) s += alpha[(buf ? buf[i] : Math.floor(Math.random() * 256)) % alpha.length];
    return s;
  }
  function randPeer() { return 'p' + rand(6, 'abcdefghjkmnpqrstuvwxyz23456789'); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }

  function normalizeCode(s) {
    if (typeof s !== 'string') return null;
    var m = s.match(/multiplayer\/([A-Za-z0-9-]+)/);
    if (m) s = m[1];
    s = s.trim().toUpperCase().replace(/[\s-]/g, '');
    return /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/.test(s) ? s : null;
  }

  function emitter(obj) {
    var map = {};
    obj.on = function (type, fn) {
      (map[type] = map[type] || []).push(fn);
      return function () { obj.off(type, fn); };
    };
    obj.off = function (type, fn) { var l = map[type]; if (l) { var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } };
    obj.emit = function (type) {
      var l = (map[type] || []).slice(), args = Array.prototype.slice.call(arguments, 1);
      for (var i = 0; i < l.length; i++) { try { l[i].apply(null, args); } catch (e) { if (typeof console !== 'undefined') console.error('[net.signal] listener error', e); } }
      return l.length;
    };
    obj.listeners = function (type) { return (map[type] || []).length; };
    return obj;
  }

  /** Common Signal skeleton: emitter, state, buffered delivery. */
  function base(kind, caps) {
    var sig = emitter({ kind: kind, caps: caps, room: null, peer: null, role: null, state: 'idle' });
    var inbox = [];
    sig._deliver = function (from, msg) {
      if (sig.state === 'closed') return;
      if (!sig.listeners('message')) { inbox.push([from, msg]); return; }
      sig.emit('message', from, msg);
    };
    sig.onMessage = function (fn) {
      var off = sig.on('message', fn);
      if (inbox.length) {
        var q = inbox; inbox = [];
        setTimeout(function () { q.forEach(function (m) { sig.emit('message', m[0], m[1]); }); }, 0);
      }
      return off;
    };
    sig._setState = function (s) { if (sig.state !== s) { sig.state = s; sig.emit('state', s); } };
    sig._closed = function (reason) {
      if (sig.state === 'closed') return;
      sig._setState('closed');
      sig.emit('closed', { reason: reason || 'closed' });
    };
    sig.setIdle = function () {};
    return sig;
  }

  /* ================================================================ endpoint detection (PHP host or Vercel/dev-server) */
  // Relative URLs on purpose: they resolve against the page, so https://example.com/forge/ works as well as a domain root.
  var ENDPOINTS = ['api/signal.php', 'api/signal'];
  var cachedEndpoint = null;   // url that answered {ok:true} (only cached when using the real global fetch)
  function probeOne(doFetch, url, timeout) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, timeout || 4000) : null;
    return Promise.resolve().then(function () {
      return doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"status"}', credentials: 'same-origin', signal: ctl ? ctl.signal : undefined });
    }).then(function (r) {
      var st = r.status | 0;
      return r.json().then(function (j) { return { url: url, ok: !!(j && j.ok), json: !!j && typeof j === 'object', backend: j && j.backend, status: st, code: j && j.code }; },
        function () { return { url: url, ok: false, json: false, status: st }; });
    }, function () { return { url: url, ok: false, json: false, status: 0 }; }).then(function (x) { if (t) clearTimeout(t); return x; });
  }
  /** -> Promise<{url, ok, json}> best candidate (ok first, in ENDPOINTS order; else one that at least spoke JSON). */
  function probeEndpoints(opts) {
    opts = opts || {};
    var doFetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!doFetch) return Promise.resolve({ url: null, ok: false, json: false });
    var shared = !opts.fetch && !opts.url;
    if (shared && cachedEndpoint) return Promise.resolve({ url: cachedEndpoint, ok: true, json: true });
    var list = opts.url ? [opts.url] : (opts.endpoints || ENDPOINTS);
    // sequential, so a working first candidate costs one request and no 404 noise in the console
    var spoke = null, blocked = null, reached = false;
    function next(i) {
      if (i >= list.length) {
        var out = spoke || { url: null, ok: false, json: false };
        // a firewall answering HTML 403/406 (ModSecurity, Sucuri…) is not "no server": report it as blocked
        if (!spoke && blocked) { out = { url: blocked.url, ok: false, json: false, blocked: true, status: blocked.status }; }
        if (!reached) out.unreachable = true;
        return Promise.resolve(out);
      }
      return probeOne(doFetch, list[i], opts.timeout).then(function (r) {
        if (r.status) reached = true;
        if (r.ok) { if (shared) cachedEndpoint = r.url; return r; }
        if (r.json && !spoke) spoke = r;
        if (!r.json && !blocked && (r.status === 403 || r.status === 406 || r.status === 429 || r.status >= 500)) blocked = r;
        return next(i + 1);
      });
    }
    return next(0);
  }
  function endpoint(opts) { return probeEndpoints(opts).then(function (b) { return b.ok ? b.url : null; }); }

  /* ================================================================ vercel (fetch api/signal[.php] + long-poll) */
  function vercel(opts) {
    opts = opts || {};
    // explicit url wins; an injected fetch (tests) keeps the historical 'api/signal'; otherwise auto-detect once.
    var url = opts.url || (opts.fetch && !opts.probe ? 'api/signal' : null);
    var doFetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    var wait = opts.wait == null ? 8000 : opts.wait;
    var sig = base('vercel', { trickle: true, reconnect: true, codes: false });
    var token = null, polling = false, idle = false, abort = null, queues = {}, flushTimer = null, unload = null;
    var lastActivity = 0; // recent send/receive => negotiation in progress => poll tightly

    function httpErr(status) {
      if (status === 404) return err('no-backend', 'no pairing server at this address (HTTP 404)');
      if (status === 403 || status === 406 || status === 429 || status >= 500) {
        var e = err('blocked', 'blocked by the web host (HTTP ' + status + ')'); e.status = status; return e;
      }
      return err('network', 'bad response (' + status + ')');
    }
    async function call(action, body, extra) {
      if (!doFetch) throw err('no-backend', 'fetch unavailable');
      if (!url) {
        var best = await probeEndpoints({ fetch: opts.fetch, timeout: opts.timeout });
        if (!url && best.blocked) throw httpErr(best.status);
        if (!url && best.unreachable && !opts.fetch) throw err('unreachable', 'cannot reach the pairing server');
        if (!url) url = best.url || ENDPOINTS[ENDPOINTS.length - 1];
      }
      body = Object.assign({ action: action }, body || {});
      var init = Object.assign({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' }, extra || {});
      // never hang forever on a stuck connection (shared hosts / proxies): give up after the long-poll + 12 s
      var ctl = null, tmo = null, timedOut = false;
      if (!init.signal && !init.keepalive && typeof AbortController === 'function') {
        ctl = new AbortController(); init.signal = ctl.signal;
        tmo = setTimeout(function () { timedOut = true; ctl.abort(); }, (Number(body.wait) || 0) + 12000);
      }
      var r;
      try { r = await doFetch(url, init); }
      catch (e) { if (tmo) clearTimeout(tmo); if (e && e.name === 'AbortError' && !timedOut) throw e; throw err('unreachable', timedOut ? 'the pairing server did not answer' : 'cannot reach the pairing server'); }
      var j = null;
      try { j = await r.json(); } catch (e) { if (tmo) clearTimeout(tmo); throw httpErr(r.status); }
      if (tmo) clearTimeout(tmo);
      if (!j || !j.ok) throw err((j && j.code) || 'network', (j && j.error) || 'request failed');
      return j;
    }
    sig._call = call;
    sig.url = function () { return url; };

    function attachUnload() {
      if (!hasWin || !window.addEventListener) return;
      unload = function () {
        if (!token || sig.state === 'closed') return;
        var payload = JSON.stringify({ action: 'close', room: sig.room, token: token });
        try {
          if (navigator.sendBeacon && url) navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
        } catch (e) { /* ignore */ }
      };
      window.addEventListener('pagehide', unload);
    }

    function deliverAll(msgs) {
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (m && m.msg && m.msg.t === '_closed' && m.from === 'host') { sig._deliver('host', m.msg); sig._closed('host-closed'); token = null; break; }
        if (m) { if (!(m.msg && m.msg.t === '_r')) lastActivity = Date.now(); sig._deliver(m.from, m.msg); }
      }
    }
    var paused = false;
    async function pollLoop() {
      if (polling) return;
      polling = true;
      var backoff = 0;
      while (sig.state !== 'closed' && token && !paused) {
        try {
          abort = typeof AbortController === 'function' ? new AbortController() : null;
          var busy = Date.now() - lastActivity < 10000;
          var j = await call('poll', { room: sig.room, token: token, wait: busy ? Math.min(wait, 4000) : wait, idle: (idle && !busy) || undefined, busy: busy || undefined }, abort ? { signal: abort.signal } : null);
          abort = null;
          if (backoff) { backoff = 0; sig._setState('open'); }
          var msgs = j.msgs || [];
          deliverAll(msgs);
          if (idle && !msgs.length) await sleep(1500);
        } catch (e) {
          abort = null;
          if (sig.state === 'closed') break;
          if (e.code === 'room-closed' || e.code === 'auth' || e.code === 'not-found') { sig._closed(e.code === 'auth' ? 'kicked' : 'room-closed'); token = null; break; }
          if (e.code === 'no-backend') { sig.emit('error', e); sig._closed('no-backend'); break; }
          backoff = Math.min(10000, backoff ? backoff * 2 : 500);
          sig._setState('reconnecting');
          sig.emit('error', e);
          await sleep(backoff * (0.75 + Math.random() * 0.5));
        }
      }
      polling = false;
    }

    async function flush(to, tok) {
      var q = queues[to];
      if (!q || !q.items.length) return;
      var tk = tok || token;
      if (!tk) { var dropped = q.waiters.splice(0); q.items.length = 0; dropped.forEach(function (w) { w.reject(err('closed', 'signal closed')); }); return; }
      var items = q.items.splice(0, 32), waiters = q.waiters.splice(0, items.length);
      var attempt = 0;
      for (;;) {
        try {
          await call('post', { room: sig.room, token: tk, to: to, msgs: items });
          waiters.forEach(function (w) { w.resolve(); });
          break;
        } catch (e) {
          if (e.code === 'network' || e.code === 'backend-error' || e.code === 'rate-limited') {
            if (++attempt <= 4 && sig.state !== 'closed') { await sleep(300 * Math.pow(2, attempt)); continue; }
          }
          waiters.forEach(function (w) { w.reject(e); });
          if (e.code === 'room-closed') sig._closed('room-closed');
          break;
        }
      }
      if (q.items.length) return flush(to, tok);
    }

    sig.create = async function () {
      var j = await call('create', {});
      token = j.token; sig.room = j.room; sig.peer = 'host'; sig.role = 'host';
      sig._setState('open'); attachUnload(); pollLoop();
      return { room: sig.room, peer: sig.peer, role: sig.role };
    };
    sig.join = async function (code) {
      var room = normalizeCode(code);
      if (!room) throw err('bad-request', 'Room codes are 5 characters');
      var j = await call('join', { room: room });
      token = j.token; sig.room = j.room; sig.peer = j.peer; sig.role = 'peer'; lastActivity = Date.now();
      sig._setState('open'); attachUnload(); pollLoop();
      return { room: sig.room, peer: sig.peer, role: sig.role, host: 'host' };
    };
    sig.send = function (to, msg) {
      if (!token || sig.state === 'closed') return Promise.reject(err('closed', 'signal closed'));
      lastActivity = Date.now();
      var q = queues[to] = queues[to] || { items: [], waiters: [] };
      return new Promise(function (resolve, reject) {
        q.items.push(msg); q.waiters.push({ resolve: resolve, reject: reject });
        if (!flushTimer) flushTimer = setTimeout(function () {
          flushTimer = null;
          Object.keys(queues).forEach(function (k) { flush(k).catch(function () {}); });
        }, 20); // batch trickle-ICE bursts into one request
      });
    };
    sig.setIdle = function (v) { idle = !!v; };
    sig.caps.relay = true;
    /** One 'relay' request: deliver posts, then (unless nopoll) wait up to `wait` ms for our own mail. */
    sig.exchange = async function (posts, wait, o) {
      if (!token || sig.state === 'closed') throw err('closed', 'signal closed');
      var body = { room: sig.room, token: token, posts: posts || [], wait: Math.max(0, wait | 0) };
      if (o && o.nopoll) body.nopoll = true;
      var j;
      try { j = await call('relay', body); }
      catch (e) {
        if (e.code === 'room-closed' || e.code === 'auth') { sig._closed(e.code === 'auth' ? 'kicked' : 'room-closed'); token = null; }
        throw e;
      }
      if (sig.state === 'open' || sig.state === 'reconnecting') sig._setState('open');
      var msgs = j.msgs || [];
      if (j.dropped && o && typeof o.onDropped === 'function') { try { o.onDropped(j.dropped); } catch (e) { /* ignore */ } }
      deliverAll(msgs);
      return msgs.length;
    };
    /**
     * Streamed downlink: one 'relay' request whose response stays open and carries many messages (NDJSON lines,
     * flushed as mail arrives). o: {wait, probe, onHeader(h)}. Resolves {streamed, buffered, n, max}:
     *   streamed false  -> the server answered plain JSON (no streaming support; any mail in it was delivered)
     *   buffered true   -> lines written far apart arrived together (a proxy / the host buffers the response):
     *                      the caller should fall back to long-polls. A probe ({probe:true}) touches no mailbox.
     */
    sig.stream = async function (o) {
      o = o || {};
      if (!token || sig.state === 'closed') throw err('closed', 'signal closed');
      if (!url) await call('status', {});
      var body = { action: 'relay', room: sig.room, token: token, posts: [], stream: 1 };
      if (o.probe) { body.probe = 1; body.nopoll = true; body.wait = 0; } else body.wait = Math.max(0, o.wait | 0);
      var ctl = typeof AbortController === 'function' ? new AbortController() : null, tmo = null;
      if (ctl) tmo = setTimeout(function () { ctl.abort(); }, (body.wait || 0) + 15000);
      var r;
      try {
        r = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', signal: ctl ? ctl.signal : undefined });
      } catch (e) { if (tmo) clearTimeout(tmo); throw err('unreachable', 'cannot reach the pairing server'); }
      var ctype = String((r.headers && r.headers.get && r.headers.get('content-type')) || '');
      var out = { streamed: false, buffered: false, n: 0, max: 0 };
      try {
        if (ctype.indexOf('ndjson') < 0 || !r.body || typeof r.body.getReader !== 'function') {
          var j = null;
          if (ctype.indexOf('ndjson') >= 0) { // no readable stream in this browser: parse it whole, treat as buffered
            var lines0 = String(await r.text()).split('\n');
            out.streamed = true; out.buffered = true;
            lines0.forEach(function (ln) { try { var x = JSON.parse(ln); if (x && x.m) { out.n += x.m.length; deliverAll(x.m); } } catch (e) { /* skip */ } });
            return out;
          }
          try { j = await r.json(); } catch (e) { throw httpErr(r.status); }
          if (!j || !j.ok) throw err((j && j.code) || 'network', (j && j.error) || 'request failed');
          var msgs = j.msgs || [];
          out.n = msgs.length; deliverAll(msgs);
          return out;
        }
        out.streamed = true;
        var reader = r.body.getReader(), dec = new TextDecoder(), buf = '', tHead = 0, tEnd = 0;
        for (;;) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += dec.decode(chunk.value, { stream: true });
          var nl = buf.lastIndexOf('\n');
          if (nl < 0) continue;
          var lines = buf.slice(0, nl).split('\n'); buf = buf.slice(nl + 1);
          var lo = Infinity, hi = -Infinity;
          for (var i = 0; i < lines.length; i++) {
            var ln = lines[i].trim(); if (!ln) continue;
            var x; try { x = JSON.parse(ln); } catch (e) { continue; }
            if (typeof x.st === 'number') { if (x.st < lo) lo = x.st; if (x.st > hi) hi = x.st; }
            if (x.ok === false) throw err(x.code || 'network', x.error || 'request failed');
            if (x.stream) { tHead = Date.now(); out.max = Number(x.max) || 0; if (o.onHeader) { try { o.onHeader(x); } catch (e) { /* ignore */ } } }
            if (x.m && x.m.length) { out.n += x.m.length; deliverAll(x.m); }
            if (x.end) tEnd = Date.now();
          }
          // lines the server wrote > 250 ms apart arrived in one piece: something on the way buffers the stream
          if (hi - lo > 250) { out.buffered = true; if (ctl) try { ctl.abort(); } catch (e) { /* ignore */ } break; }
        }
        if (o.probe && !out.buffered && !(tHead && tEnd && tEnd - tHead >= 250)) out.buffered = true;
        if (sig.state === 'open' || sig.state === 'reconnecting') sig._setState('open');
        return out;
      } catch (e) {
        if (out.buffered) return out;
        if (e && e.name === 'AbortError') throw err('unreachable', 'the pairing server did not answer');
        if (e && (e.code === 'room-closed' || e.code === 'auth')) { sig._closed(e.code === 'auth' ? 'kicked' : 'room-closed'); token = null; }
        throw e && e.code ? e : err('unreachable', 'stream interrupted');
      } finally { if (tmo) clearTimeout(tmo); }
    };
    var iceCache = null;
    /**
     * ICE servers from the site's own config (api/turn-config.php or the TURN env vars on Vercel / dev-server):
     * -> Promise<[RTCIceServer]> ([] when none are configured, the server is old, or anything fails). Short-lived
     * credentials are minted server-side; cached here until shortly before they expire.
     */
    sig.ice = function () {
      if (iceCache && iceCache.exp > Date.now()) return Promise.resolve(iceCache.list);
      if (!token || sig.state === 'closed') return Promise.resolve([]);
      return call('ice', { room: sig.room, token: token }).then(function (j) {
        var list = Array.isArray(j.iceServers) ? j.iceServers.filter(function (s) { return s && s.urls; }) : [];
        var ttl = Math.max(60, Math.min(Number(j.ttl) || 3600, 86400));
        iceCache = { list: list, exp: Date.now() + ttl * 500 };
        return list;
      }, function () { return []; });
    };
    /** The relay's exchange loop replaces the background poll loop while it runs. */
    sig.pausePolling = function (v) {
      paused = !!v;
      if (!paused && token && sig.state !== 'closed') pollLoop();
    };
    sig.close = async function () {
      if (sig.state === 'closed') return;
      var t = token;
      token = null;
      sig._closed('closed');
      if (abort) try { abort.abort(); } catch (e) { /* ignore */ }
      if (unload && hasWin) window.removeEventListener('pagehide', unload);
      // deliver anything still batched (e.g. a final {t:'bye'}) with the old token before leaving the room
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (t) await Promise.all(Object.keys(queues).map(function (k) { return flush(k, t).catch(function () {}); }));
      if (t) { try { await call('close', { room: sig.room, token: t }, { keepalive: true }); } catch (e) { /* best effort */ } }
    };
    return sig;
  }

  /* ================================================================ local (BroadcastChannel, same browser) */
  function local(opts) {
    opts = opts || {};
    var BC = opts.BroadcastChannel || globalThis.BroadcastChannel;
    var sig = base('local', { trickle: true, reconnect: true, codes: false });
    var ch = null;
    function open() {
      if (!BC) throw err('unsupported', 'BroadcastChannel is not available');
      ch = new BC(opts.channel || 'forge-net-v1');
      ch.onmessage = function (ev) {
        var d = ev.data;
        if (!d || d.room !== sig.room || sig.state === 'closed') return;
        if (d.k === 'probe' && sig.role === 'host') ch.postMessage({ k: 'here', room: sig.room, to: d.from });
        else if (d.k === 'here' && d.to === sig.peer && sig._probe) sig._probe();
        else if (d.k === 'msg' && d.to === sig.peer) sig._deliver(d.from, d.msg);
        else if (d.k === 'closed' && sig.role === 'peer') { sig._deliver('host', { t: '_closed' }); sig._closed('host-closed'); shut(); }
      };
    }
    // closing / reloading a tab says goodbye at once (the online backends do this with a beacon); without it the other
    // tab only noticed after the WebRTC consent timeout plus the 15 s reconnect grace
    var unload = null;
    function bye() {
      if (!ch || sig.state === 'closed') return;
      try {
        if (sig.role === 'host') ch.postMessage({ k: 'closed', room: sig.room });
        else ch.postMessage({ k: 'msg', room: sig.room, from: sig.peer, to: 'host', msg: { t: '_leave' } });
      } catch (e) { /* ignore */ }
    }
    function shut() {
      if (unload && hasWin && window.removeEventListener) window.removeEventListener('pagehide', unload);
      unload = null;
      if (ch) { try { ch.close(); } catch (e) { /* ignore */ } ch = null; }
    }
    function watchUnload() {
      if (unload || !hasWin || !window.addEventListener) return;
      unload = function (ev) { if (ev && ev.persisted) return; bye(); };   // a page kept in the back/forward cache may come back
      window.addEventListener('pagehide', unload);
    }
    sig.create = async function () {
      sig.room = rand(5); sig.peer = 'host'; sig.role = 'host';
      open(); watchUnload(); sig._setState('open');
      return { room: sig.room, peer: 'host', role: 'host' };
    };
    sig.join = async function (code) {
      var room = normalizeCode(code);
      if (!room) throw err('bad-request', 'Room codes are 5 characters');
      sig.room = room; sig.peer = randPeer(); sig.role = 'peer';
      open();
      var ok = await new Promise(function (resolve) {
        var t = setTimeout(function () { sig._probe = null; resolve(false); }, opts.probeTimeout || 1500);
        sig._probe = function () { clearTimeout(t); sig._probe = null; resolve(true); };
        ch.postMessage({ k: 'probe', room: room, from: sig.peer });
      });
      if (!ok) { shut(); sig.room = null; throw err('not-found', 'No room ' + room + ' open in another tab'); }
      watchUnload();
      sig._setState('open');
      return { room: room, peer: sig.peer, role: 'peer', host: 'host' };
    };
    sig.send = function (to, msg) {
      if (!ch || sig.state === 'closed') return Promise.reject(err('closed', 'signal closed'));
      if (sig.role === 'peer' && to !== 'host') return Promise.reject(err('forbidden', 'peers may only message the host'));
      ch.postMessage({ k: 'msg', room: sig.room, from: sig.peer, to: to, msg: JSON.parse(JSON.stringify(msg)) });
      return Promise.resolve();
    };
    sig.close = async function () {
      if (sig.state === 'closed') return;
      bye();
      sig._closed('closed');
      shut();
    };
    return sig;
  }

  /* ================================================================ manual codec (compact copy/paste codes) */
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var u = unescape(encodeURIComponent(s)), a = new Uint8Array(u.length);
    for (var i = 0; i < u.length; i++) a[i] = u.charCodeAt(i);
    return a;
  }
  function unutf8(a) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(a);
    var s = ''; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return decodeURIComponent(escape(s));
  }
  function b64e(bytes) {
    var s = '', i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      s += B64[n >> 18 & 63] + B64[n >> 12 & 63] + B64[n >> 6 & 63] + B64[n & 63];
    }
    var r = bytes.length - i;
    if (r === 1) { var a = bytes[i] << 16; s += B64[a >> 18 & 63] + B64[a >> 12 & 63]; }
    else if (r === 2) { var b = (bytes[i] << 16) | (bytes[i + 1] << 8); s += B64[b >> 18 & 63] + B64[b >> 12 & 63] + B64[b >> 6 & 63]; }
    return s;
  }
  function b64d(s) {
    s = s.replace(/[^A-Za-z0-9\-_]/g, '');
    var out = new Uint8Array(Math.floor(s.length * 3 / 4)), o = 0, n = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B64.indexOf(s[i]);
      if (v < 0) throw err('bad-code', 'invalid character');
      n = (n << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (n >> bits) & 255; }
    }
    return out.subarray(0, o);
  }
  function checksum(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return B64[h & 63] + B64[(h >> 6) & 63]; }

  /** SDP (data-channel only) -> small object. Falls back to {raw} if the SDP isn't the expected single m=application shape. */
  function compactSdp(sdp, extraCands) {
    var lines = String(sdp).split(/\r?\n/), o = { c: [] }, mlines = 0;
    lines.forEach(function (l) {
      if (/^m=/.test(l)) { mlines++; if (!/^m=application .* webrtc-datachannel/.test(l)) o.bad = 1; }
      var m;
      if ((m = l.match(/^a=ice-ufrag:(.+)$/))) o.u = m[1];
      else if ((m = l.match(/^a=ice-pwd:(.+)$/))) o.w = m[1];
      else if ((m = l.match(/^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)$/))) {
        o.h = m[1].toLowerCase() === 'sha-256' ? undefined : m[1];
        o.f = b64e(new Uint8Array(m[2].split(':').map(function (x) { return parseInt(x, 16); })));
      }
      else if ((m = l.match(/^a=setup:(\w+)$/))) o.s = { actpass: 0, active: 1, passive: 2 }[m[1]];
      else if ((m = l.match(/^a=mid:(.+)$/))) o.m = m[1];
      else if ((m = l.match(/^a=sctp-port:(\d+)$/))) o.p = Number(m[1]);
      else if ((m = l.match(/^a=max-message-size:(\d+)$/))) o.x = Number(m[1]);
      else if ((m = l.match(/^a=candidate:(.+)$/))) o.c.push(compactCand(m[1]));
    });
    (extraCands || []).forEach(function (c) { if (c) { var s = String(c).replace(/^(a=)?candidate:/, ''); var cc = compactCand(s); if (o.c.indexOf(cc) < 0) o.c.push(cc); } });
    if (o.bad || mlines !== 1 || !o.u || !o.w || !o.f || o.s === undefined) return { raw: String(sdp) };
    if (o.m === '0') delete o.m;
    if (o.p === 5000) delete o.p;
    if (o.x === 262144) delete o.x;
    if (o.h === undefined) delete o.h;
    return o;
  }
  function compactCand(c) {
    // keep "foundation component proto priority ip port typ type [raddr a rport b] [tcptype t]"; drop generation/ufrag/network-*
    var p = c.trim().split(/\s+/), keep = p.slice(0, 8);
    for (var i = 8; i + 1 < p.length; i += 2) if (p[i] === 'raddr' || p[i] === 'rport' || p[i] === 'tcptype') keep.push(p[i], p[i + 1]);
    return keep.join(' ');
  }
  function expandSdp(o) {
    if (o.raw) return o.raw;
    var mid = o.m == null ? '0' : o.m;
    var fp = Array.prototype.map.call(b64d(o.f), function (b) { return (b < 16 ? '0' : '') + b.toString(16).toUpperCase(); }).join(':');
    var sess = String(Math.floor(Math.random() * 9e15) + 1e15);
    var L = [
      'v=0', 'o=- ' + sess + ' 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE ' + mid, 'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0'
    ];
    (o.c || []).forEach(function (c) { L.push('a=candidate:' + c); });
    if (o.c && o.c.length) L.push('a=end-of-candidates');
    L.push('a=ice-ufrag:' + o.u, 'a=ice-pwd:' + o.w, 'a=ice-options:trickle',
      'a=fingerprint:' + (o.h || 'sha-256') + ' ' + fp, 'a=setup:' + ['actpass', 'active', 'passive'][o.s],
      'a=mid:' + mid, 'a=sctp-port:' + (o.p || 5000), 'a=max-message-size:' + (o.x || 262144));
    return L.join('\r\n') + '\r\n';
  }
  /** encode(obj, kind 'i'|'a') -> 'FG1i:<base64url>:<chk>' */
  function encode(obj, kind) {
    var body = b64e(utf8(JSON.stringify(obj)));
    var head = 'FG1' + (kind || 'x');
    return head + ':' + body + ':' + checksum(head + body);
  }
  function decode(code) {
    var s = String(code || '').replace(/\s+/g, '');
    var m = s.match(/FG1([a-z])[.:]([A-Za-z0-9\-_]+)[.:]([A-Za-z0-9\-_]{2})/);
    if (!m) throw err('bad-code', 'That doesn\'t look like a Redline code');
    if (checksum('FG1' + m[1] + m[2]) !== m[3]) throw err('bad-code', 'Code is incomplete or mistyped');
    var obj;
    try { obj = JSON.parse(unutf8(b64d(m[2]))); } catch (e) { throw err('bad-code', 'Code is corrupted'); }
    return { kind: m[1], data: obj };
  }

  /* ================================================================ manual (copy/paste codes, no server) */
  function manual(opts) {
    opts = opts || {};
    var gatherTimeout = opts.gatherTimeout || 3500;
    var sig = base('manual', { trickle: false, reconnect: false, codes: true });
    var outgoing = {}; // peer -> {sdp, cands:[], sid, done, resolve, reject, timer, promise}

    function slot(to) {
      var s = outgoing[to];
      if (!s) {
        s = outgoing[to] = { sdp: null, type: null, cands: [], sid: null, done: false };
        s.promise = new Promise(function (res, rej) { s.resolve = res; s.reject = rej; });
        s.promise.catch(function () {});
      }
      return s;
    }
    function finish(to) {
      var s = outgoing[to];
      if (!s || s.done || !s.sdp) return;
      s.done = true;
      clearTimeout(s.timer);
      var d = compactSdp(s.sdp, s.cands);
      var payload = { p: sig.role === 'host' ? to : sig.peer, s: s.sid, d: d };
      var kind = s.type === 'offer' ? 'i' : 'a';
      if (kind === 'i') payload.r = sig.room;
      var code = encode(payload, kind);
      s.code = code;
      s.resolve(code);
      sig.emit('code', { kind: kind === 'i' ? 'invite' : 'answer', peer: to, code: code });
    }

    sig.create = async function () {
      sig.room = 'M' + rand(4); sig.peer = 'host'; sig.role = 'host';
      sig._setState('open');
      return { room: sig.room, peer: 'host', role: 'host' };
    };
    sig.invite = function () {
      if (sig.role !== 'host') return Promise.reject(err('forbidden', 'only the host creates invites'));
      var peer = randPeer(), sid = rand(8, 'abcdefghjkmnpqrstuvwxyz23456789');
      var s = slot(peer); s.sid = sid;
      sig._deliver(peer, { t: 'join', sid: sid, manual: true });
      return s.promise;
    };
    sig.accept = async function (code) {
      var d = decode(code);
      if (d.kind !== 'a') throw err('bad-code', d.kind === 'i' ? 'That is an invite code — paste your friend\'s answer code' : 'Not an answer code');
      var p = d.data.p;
      if (!outgoing[p]) throw err('not-found', 'This answer is for an invite from a different session');
      sig._deliver(p, { t: 'sdp', type: 'answer', sdp: expandSdp(d.data.d), sid: d.data.s });
      return p;
    };
    sig.join = async function (code) {
      var d = decode(code);
      if (d.kind !== 'i') throw err('bad-code', 'That is not an invite code');
      sig.room = d.data.r || 'MANUAL'; sig.peer = d.data.p; sig.role = 'peer';
      sig._setState('open');
      sig._deliver('host', { t: 'sdp', type: 'offer', sdp: expandSdp(d.data.d), sid: d.data.s });
      return { room: sig.room, peer: sig.peer, role: 'peer', host: 'host' };
    };
    sig.answer = function () { return slot('host').promise; };
    sig.send = function (to, msg) {
      if (sig.state === 'closed') return Promise.reject(err('closed', 'signal closed'));
      if (!msg || typeof msg !== 'object') return Promise.resolve();
      if (msg.t === 'sdp') {
        var s = slot(to);
        if (s.done) return Promise.resolve(); // renegotiation is not possible without a new code
        s.sdp = msg.sdp; s.type = msg.type; s.sid = msg.sid || s.sid;
        clearTimeout(s.timer);
        s.timer = setTimeout(function () { finish(to); }, gatherTimeout);
      } else if (msg.t === 'ice') {
        var s2 = slot(to);
        if (s2.done) return Promise.resolve();
        if (msg.c && msg.c.candidate) s2.cands.push(msg.c.candidate);
        else if (!msg.c) finish(to);
      }
      // join/bye and anything else has no out-of-band path in manual mode
      return Promise.resolve();
    };
    sig.close = async function () {
      Object.keys(outgoing).forEach(function (k) { clearTimeout(outgoing[k].timer); if (!outgoing[k].done) outgoing[k].reject(err('closed', 'closed')); });
      sig._closed('closed');
    };
    return sig;
  }

  /* ================================================================ detection */
  async function detect(opts) {
    opts = opts || {};
    if (hasWin && window.location && window.location.protocol === 'file:') return 'manual';
    try { return (await probeEndpoints(opts)).ok ? 'vercel' : 'manual'; } catch (e) { return 'manual'; }
  }
  function open(kind, opts) {
    if (kind === 'vercel' || kind === 'online') return vercel(opts);
    if (kind === 'local' || kind === 'same-device') return local(opts);
    if (kind === 'manual' || kind === 'invite') return manual(opts);
    throw err('bad-request', 'unknown signal backend ' + kind);
  }
  async function auto(opts) { return open(await detect(opts), opts); }

  var api = {
    vercel: vercel, local: local, manual: manual, open: open, detect: detect, auto: auto,
    endpoint: endpoint, ENDPOINTS: ENDPOINTS, _resetEndpoint: function () { cachedEndpoint = null; },
    normalizeCode: normalizeCode, ALPHABET: ALPHABET,
    codec: { encode: encode, decode: decode, compactSdp: compactSdp, expandSdp: expandSdp, b64e: b64e, b64d: b64d },
    _emitter: emitter, _rand: rand
  };
  CB.net = CB.net || {};
  CB.net.signal = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

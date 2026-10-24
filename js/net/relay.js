/* ==========================================================================
   Redline — js/net/relay.js
   CB.net.relay : server-relay fallback for CB.net.transport. When a WebRTC data channel cannot open (campus / hotel
   Wi-Fi with client isolation, UDP blocked, symmetric NAT on cellular, no TURN server) the two ends keep talking
   through the signalling server instead: api/signal.php (cPanel), api/signal (Vercel) or tools/dev-server.js.
   Zero dependencies, classic script, require()-able in Node.

   A relay link has the same shape as a WebRTC link, so CB.net.transport attaches it to a Peer with peer._attach(link)
   and everything above (rel / fast channels, pings, bye, the wheel and lobby protocols) works unchanged:
     var l = CB.net.relay.link(signal, to, onRecv(channel, payload), opts?)
       l.mode 'relay'   l.send(channel 'rel'|'fast', payload string|ArrayBuffer) -> bool   l.close()   l.onDead = fn(reason)
   Delivery
     'rel'  ordered + reliable: every frame carries a sequence number; the receiver re-orders, drops duplicates and
            skips a gap only after 1.5 s (a frame lost to a failed request is re-sent first)
     'fast' latest-state-wins: queued 'fast' payloads are coalesced per message type ({"t":"in"…} keeps only the newest
            wheel input, binary payloads keep the newest car-state packet), so slow hosting never builds a backlog
   Request scheduler (shared-hosting / firewall friendly: Sucuri / ModSecurity ban IPs that send too much, and a phone
   and a computer on campus Wi-Fi share one IP). All links of one signal share one hub; with the vercel/PHP signal it
   replaces the signal's poll loop. Every request is the 'relay' action (post + optional poll), nothing waits for the
   previous round trip:
     uplink    small posts, latest-state-wins, pipelined (<= upInFlight at once, >= upGap apart; 'rel' data and clock
               pings sooner: relGap / relFlush)
     downlink  downlinks > 0: that many long-polls stay open and are re-issued at once (the server answers within
               ~10 ms of new mail), each carrying whatever is queued; or, when the server streams and nothing on the way
               buffers it (probed once), ONE streamed response carries every message as it arrives
               downlinks = 0: every post also collects our mail (wait 0); one long-poll is held only while idle
     back-off  HTTP 429 or a firewall page (403/406/5xx HTML) doubles every gap (up to 8x) and pauses 1-8 s
   Phone wheel: phone upGap 125 ms, downlinks 0 (~8 req/s); computer downlinks 2 (~4-8 req/s, driven by the phone).
   One-way input delay ~ two network legs (phone -> server -> computer) + <= 10 ms: ~190 ms behind a ~170 ms RTT host,
   was ~200-360 ms (+ the wait for the computer's next poll) with the old one-request-at-a-time loop.
   Old servers: no streaming -> long-polls; no 'relay' action (bad-action) -> plain post + the normal poll loop.
   Other signals (BroadcastChannel 'local') -> sig.send() per frame batch. Manual copy/paste codes cannot relay.
   Multiplayer: CB.net.transport.host(sig, {relay:true}) / connect(sig, {relay:true}) enables the same fallback for
     a lobby (both ends must opt in; the guest asks with {t:'relay'}, the host answers {t:'relay-ok'}). Defaults: each
     side posts <= ~7/s (one host request carries posts for every guest) and collects its mail with them.
   Multiplayer also passes streamDown:true (one streamed downlink when the server streams, posts then skip the poll) and
     guests open fast-only side links to other relayed guests (opts.side: frames carry x:1; fan-out, needs a server that
     accepts peer -> peer fast-only frames; a 'dropped' answer switches that destination off). sig.clock (optional
     {now, setTimeout, clearTimeout}) replaces the real clock (tests: CB.net.transport.loopback({relay})).
   Wire format (a normal signalling message): {t:'_r', e: link epoch, n: batch#, s: first rel seq, r:[payload…], f:[payload…]}
     payload: string, or {b:'<base64>'} for binary.
     CB.net.relay.supported(signal) -> bool      CB.net.relay.hub(signal) -> Hub (debug: hub.stats, hub.mode 'split'|'post',
                                                 hub.stream, hub.inFlight())
     CB.net.relay.DEFAULTS
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  var DEFAULTS = {
    // Request budget: the host's firewall (Sucuri / ModSecurity) bans IPs that send too much, and a phone + computer
    // on campus Wi-Fi share one IP. Defaults keep a multiplayer side at ~7 requests/s; the phone wheel uses
    // upGap 125 (phone ~8/s) and downlinks 2 on the computer (~8/s, driven by the phone's posts).
    upGap: 150,         // ms between posts (pipelined: a slow round trip never holds the next one back)
    upInFlight: 2,      // posts in flight at once
    relGap: 40,         // ms: queued 'rel' data may go out this soon after the previous post
    downlinks: 0,       // long-polls held open; 0 = every post also collects our mail (one long-poll only when idle)
    pollGap: 150,       // ms between long-poll starts (paces a host that many guests wake up)
    idlePoll: 400,      // downlinks 0: hold a long-poll once nothing was posted for this long
    fastFlush: 150,     // ms queued 'fast' data waits for a long-poll re-issue to carry it before it gets its own post
    relFlush: 40,       // same for 'rel' data
    upMulMax: 8,        // HTTP 429 / firewall 403: every gap doubles up to this factor, then recovers
    longWait: 4000,     // ms long-poll (PHP caps it at 5000); answered as soon as mail arrives
    stream: true,       // with downlinks > 0: try one streamed response instead of long-polls when the server offers it
    streamDown: false,  // with downlinks 0 (multiplayer): when the server streams (probed once), ONE streamed response
                        // carries our mail as soon as it is posted and every post skips the poll (nopoll); otherwise
                        // posts collect the mail as before. Saves the wait for our next post (~upGap/2, up to upGap).
    streamWait: 12000,  // ms a streamed response stays open (the server caps it)
    streamOverlap: 600, // ms: the next stream opens this long before the current one ends
    minGap: 150,        // ms between posts in the old-server 'post' fallback
    gapSkip: 1500,      // ms a missing rel frame may hold up later ones
    relMax: 512,        // queued rel payloads per link
    batchBytes: 40000   // payload bytes per request (the server takes 64 KB bodies)
  };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function now() { return Date.now(); }
  var REAL_CLOCK = { now: now, setTimeout: function (f, ms) { return setTimeout(f, ms); }, clearTimeout: function (h) { clearTimeout(h); } };

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64e(buf) {
    var u = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (typeof Buffer !== 'undefined' && typeof window === 'undefined') return Buffer.from(u).toString('base64');
    var s = '';
    for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64d(s) {
    if (typeof Buffer !== 'undefined' && typeof window === 'undefined') { var b = Buffer.from(s, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    var bin = atob(s), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  function enc(p) { return typeof p === 'string' ? p : { b: b64e(p) }; }
  function dec(p) { return typeof p === 'string' ? p : p && typeof p.b === 'string' ? b64d(p.b) : null; }
  function size(p) { return typeof p === 'string' ? p.length + 3 : (p.b ? p.b.length + 8 : 8); }
  /** coalescing key of a 'fast' payload: the JSON message type, or 'bin' for binary */
  function fastKey(p) {
    if (typeof p !== 'string') return 'bin';
    var m = /^\{"t":"([^"]{1,32})"/.exec(p);
    return m ? m[1] : 'json';
  }

  function supported(sig) {
    return !!(sig && typeof sig.send === 'function' && typeof sig.onMessage === 'function' && !(sig.caps && sig.caps.codes));
  }

  /* ---------------------------------------------------------------- hub (one per signal) */
  function hub(sig, opts) {
    if (sig._relayHub && !sig._relayHub.dead) { sig._relayHub.tune(opts); return sig._relayHub; }
    var o = Object.assign({}, DEFAULTS, opts || {});
    var C = sig.clock || REAL_CLOCK;   // a virtual clock (tests: CB.net.transport.loopback({relay}))
    var H = { links: {}, mode: typeof sig.exchange === 'function' ? 'split' : 'post', dead: false, opts: o,
      stream: typeof sig.stream === 'function' && o.stream ? 'unknown' : 'off',   // 'unknown' | 'probing' | 'on' | 'buffered' | 'unsupported' | 'off'
      stats: { requests: 0, posts: 0, polls: 0, streams: 0, errors: 0, rateLimited: 0, sentFrames: 0, recvFrames: 0 } };
    sig._relayHub = H; H.C = C;
    var running = false, batchNo = 0, timer = null, timerAt = 0;
    var up = { inFlight: 0, last: -1e9, holdUntil: 0, mul: 1, backoff: 0, since: 0, relBusy: 0 };
    var down = { polls: 0, lastPoll: -1e9, streams: 0, streamErrors: 0, nextTimer: null };

    var offMsg = sig.onMessage(function (from, msg) {
      if (!msg || msg.t !== '_r') return;
      var l = H.links[from];
      if (l) l._in(msg);
      else if (msg.x === 1 && typeof H.onStray === 'function') { try { H.onStray(from, msg); } catch (e) { /* ignore */ } }   // fan-out frame, no side link yet
    });
    var offClosed = sig.on ? sig.on('closed', function (e) { killAll((e && e.reason) || 'signal-closed'); }) : null;

    function linkCount() { return Object.keys(H.links).length; }
    function killAll(reason) {
      Object.keys(H.links).forEach(function (k) { var l = H.links[k]; delete H.links[k]; l._dead(reason); });
      stop();
    }
    function hasData() { return Object.keys(H.links).some(function (k) { return H.links[k]._pending(up.relBusy > 0); }); }
    /** rel data, or a clock ping/pong (their timing feeds the RTT / clock-offset estimate: never hold them back) */
    function hasRel() { return Object.keys(H.links).some(function (k) { return H.links[k]._urgent(up.relBusy > 0); }); }
    /** take one frame per link with queued data -> [{to, msgs:[frame]}], plus a restore() for failed requests.
     *  'rel' data rides in ONE request at a time: two pipelined requests can reach the server out of order (a slow
     *  PHP worker, a cold connection), and a rel frame overtaken by later ones for longer than gapSkip used to be
     *  skipped by the receiver — lost. Until the request carrying rel data has been answered (or failed and put
     *  its frames back), later requests carry 'fast' data only. */
    function drain() {
      var posts = [], undo = [], budget = o.batchBytes, noRel = up.relBusy > 0, rel = false;
      Object.keys(H.links).forEach(function (k) {
        var l = H.links[k];
        if (!l._pending()) return;
        var t = l._take(budget, noRel);
        if (!t) return;
        budget -= t.bytes;
        if (t.rel.length) rel = true;
        posts.push({ to: l.to, msgs: [t.frame] });
        undo.push(function () { l._restore(t); });
      });
      if (posts.length) up.since = 0;
      if (rel) up.relBusy++;
      return { posts: posts, rel: rel, restore: function () { undo.forEach(function (f) { f(); }); } };
    }
    function drained(d) { if (d.rel) up.relBusy--; }
    function fatal(e) {
      return sig.state === 'closed' || (e && (e.code === 'closed' || e.code === 'room-closed' || e.code === 'auth'));
    }
    /** HTTP 429 / a firewall page (Sucuri, ModSecurity: 403/406/5xx HTML): slow right down before the host bans the IP */
    function throttled(e) { return e && (e.code === 'rate-limited' || e.code === 'blocked' || e.status === 429); }
    function failed(e) {
      H.stats.errors++; H.lastError = e;
      if (e && e.code === 'bad-action') { switchToPost(); return true; }
      if (fatal(e)) { killAll((e && e.code) || 'closed'); return true; }
      if (throttled(e)) { H.stats.rateLimited++; up.mul = Math.min(o.upMulMax, up.mul * 2); }
      up.backoff = Math.min(8000, up.backoff ? up.backoff * 2 : (throttled(e) ? 1000 : 300));
      up.holdUntil = C.now() + up.backoff;
      return false;
    }
    /** the server refused some destinations (a peer that left; an older server without fan-out): side links die */
    function dropped(list) {
      (list || []).forEach(function (to) { var l = H.links[to]; if (l && l.side) { delete H.links[to]; l._dead('dropped'); } });
    }
    function succeeded() { up.backoff = 0; if (up.mul > 1) up.mul = Math.max(1, up.mul * 0.9); }

    function kick() {
      if (H.dead) return;
      if (H.mode === 'post') { schedulePost(); return; }
      if (!up.since && hasData()) up.since = C.now();
      if (!running) start();
      pump();
    }
    H.kick = kick;
    /** a later link may ask for more downlinks / a faster uplink (e.g. the phone-wheel host) */
    H.tune = function (x) {
      if (!x) return;
      ['downlinks', 'upInFlight'].forEach(function (k) { if (x[k] > o[k]) o[k] = x[k]; });
      ['upGap', 'pollGap', 'fastFlush', 'relFlush'].forEach(function (k) { if (x[k] >= 0 && x[k] < o[k]) o[k] = x[k]; });
      if (x.streamDown && !o.streamDown) { o.streamDown = true; if (running && H.stream === 'unknown') probeStream(); }
      if (running) pump();
    };

    function start() {
      if (running || H.dead) return;
      running = true;
      if (sig.pausePolling) sig.pausePolling(true);
      if (H.stream === 'unknown' && (o.downlinks > 0 || o.streamDown)) probeStream();
    }
    function stop() {
      if (timer) { C.clearTimeout(timer); timer = null; }
      if (down.nextTimer) { C.clearTimeout(down.nextTimer); down.nextTimer = null; }
      running = false;
      if (sig.pausePolling && sig.state !== 'closed') sig.pausePolling(false);
    }
    function arm(ms) {
      var at = C.now() + Math.max(0, ms);
      if (timer && timerAt <= at) return;
      if (timer) C.clearTimeout(timer);
      timerAt = at;
      timer = C.setTimeout(function () { timer = null; pump(); }, Math.max(0, ms));
    }

    /*
     * The request scheduler. Two kinds of request, both the 'relay' action:
     *   long-poll  {posts: whatever is queued, wait: longWait}  held open by the server until mail arrives
     *   post       {posts, wait: 0}  (+ nopoll when long-polls are held: they collect the mail)
     * downlinks > 0 (e.g. the wheel's computer): that many long-polls stay open, each re-issued at once (>= pollGap
     *   apart) carrying the queued data; data that would wait longer than fastFlush / relFlush goes in a post.
     * downlinks = 0 (phone, multiplayer): every post also collects our mail (wait 0), pipelined at upGap; one
     *   long-poll is held only while there is nothing to send.
     * A server that streams (H.stream 'on') replaces the long-polls by one streamed response.
     */
    function pump() {
      if (!running || H.dead || H.mode !== 'split') return;
      if (!linkCount()) { stop(); return; }
      var t = C.now(), mul = up.mul;
      if (t < up.holdUntil) { arm(up.holdUntil - t); return; }
      if (H.stream === 'on' && (o.downlinks > 0 || o.streamDown)) { if (!down.streams) openStream(); }
      else {
        var want = o.downlinks > 0 ? o.downlinks : (up.inFlight || hasData() ? 0 : 1);
        if (o.downlinks <= 0 && want && down.polls < want && t - up.last < o.idlePoll) { arm(up.last + o.idlePoll - t); want = 0; }
        while (down.polls < want) {
          var g = down.lastPoll + Math.max(15, o.pollGap * mul) - t;
          if (g > 0) { arm(g); break; }
          startPoll();
        }
      }
      if (!hasData() || up.inFlight >= o.upInFlight) return;
      var streamDown = o.downlinks <= 0 && o.streamDown && H.stream === 'on' && down.streams > 0;
      var held = streamDown || (o.downlinks > 0 && (down.polls > 0 || down.streams > 0));
      var urgent = hasRel(), due = up.last + (urgent ? o.relGap : o.upGap) * mul;
      if (held && !streamDown) due = Math.max(due, (up.since || t) + (urgent ? o.relFlush : o.fastFlush) * mul);
      if (due > t) { arm(due - t); return; }
      startPost(held);
    }
    function startPoll() {
      var d = drain();
      down.polls++; down.lastPoll = C.now();
      H.stats.requests++; H.stats.polls++;
      sig.exchange(d.posts, o.longWait, { onDropped: dropped }).then(function () { H.stats.sentFrames += d.posts.length; succeeded(); },
        function (e) { d.restore(); failed(e); }).then(function () { drained(d); down.polls--; reap(); pump(); });
    }
    function startPost(nopoll) {
      var d = drain();
      if (!d.posts.length) return;
      up.inFlight++; up.last = C.now();
      H.stats.requests++; H.stats.posts++;
      sig.exchange(d.posts, 0, { nopoll: !!nopoll, onDropped: dropped }).then(function () { H.stats.sentFrames += d.posts.length; succeeded(); },
        function (e) { d.restore(); failed(e); }).then(function () { drained(d); up.inFlight--; reap(); pump(); });
    }

    /** one short probe: does a streamed response arrive piece by piece (not buffered by a proxy / the host)? */
    function probeStream() {
      H.stream = 'probing';
      sig.stream({ probe: true }).then(function (r) {
        if (H.stream !== 'probing') return;
        H.stream = r.streamed ? (r.buffered ? 'buffered' : 'on') : 'unsupported';
        H.streamProbe = r;
        pump();
      }, function () { if (H.stream === 'probing') H.stream = 'unsupported'; });
    }
    function openStream() {
      if (!running || H.dead || H.stream !== 'on' || down.streams >= 2 || !linkCount()) return;
      down.streams++;
      H.stats.requests++; H.stats.streams++;
      var opened = false;
      function next() { if (!opened) { opened = true; openStream(); } }
      sig.stream({ wait: o.streamWait, onHeader: function (h) {
        // open the next stream shortly before this one ends, so the server always has a listener
        var max = Number(h && h.max) || o.streamWait;
        if (down.nextTimer) C.clearTimeout(down.nextTimer);
        down.nextTimer = C.setTimeout(function () { down.nextTimer = null; next(); }, Math.max(500, max - o.streamOverlap));
      } }).then(function (r) {
        down.streams--; down.streamErrors = 0;
        if (!r.streamed || r.buffered) { H.stream = r.streamed ? 'buffered' : 'unsupported'; pump(); return; }   // back to long-polls
        next();
      }, function (e) {
        down.streams--;
        if (failed(e) || !running) return;
        if (++down.streamErrors >= 2) { H.stream = 'unsupported'; pump(); return; }
        C.setTimeout(next, 300);
      });
    }

    function switchToPost() {   // server predates the 'relay' action: post + the signal's normal poll loop
      if (H.mode === 'post') return;
      H.mode = 'post'; running = false;
      if (timer) { C.clearTimeout(timer); timer = null; }
      if (sig.pausePolling) sig.pausePolling(false);
      schedulePost();
    }

    /* 'post' mode: no combined action -> sig.send() frames; mail arrives through the signal's own poll loop */
    var postTimer = null, posting = false, lastPost = 0;
    function schedulePost() {
      if (postTimer || posting || H.dead) return;
      postTimer = C.setTimeout(doPost, Math.max(0, lastPost + o.minGap - C.now()));
    }
    async function doPost() {
      postTimer = null;
      if (posting || H.dead) return;
      posting = true; lastPost = C.now();
      var d = drain();
      H.stats.requests += d.posts.length;
      await Promise.all(d.posts.map(function (p) {
        return sig.send(p.to, p.msgs[0]).then(function () { H.stats.sentFrames++; }, function (e) {
          H.stats.errors++;
          if (sig.state === 'closed') return;
          var l = H.links[p.to]; if (l) l._restoreFrame(p.msgs[0]);
        });
      }));
      drained(d);
      posting = false;
      reap();
      if (hasData()) schedulePost();
    }

    /** links that were closed and have flushed (or waited long enough) leave the hub */
    function reap() {
      Object.keys(H.links).forEach(function (k) {
        var l = H.links[k];
        if (l.closed && (!l._pending() || C.now() - l.closedAt > 2000)) delete H.links[k];
      });
      if (!linkCount()) { stop(); }
    }

    H.add = function (l) {
      var old = H.links[l.to];
      if (old && old !== l) old._dead(null);
      H.links[l.to] = l;
      kick();
    };
    H.remove = function (l) {
      if (H.links[l.to] !== l) return;
      if (l._pending()) { kick(); C.setTimeout(reap, 2100); } else { delete H.links[l.to]; reap(); }
    };
    H.destroy = function () {
      H.dead = true; killAll(null); offMsg(); if (offClosed) offClosed();
      if (sig._relayHub === H) sig._relayHub = null;
    };
    H._nextBatch = function () { return ++batchNo; };
    /** requests currently open (debug / tests) */
    H.inFlight = function () { return { posts: up.inFlight, polls: down.polls, streams: down.streams }; };
    return H;
  }

  /* ---------------------------------------------------------------- link */
  function link(sig, to, onRecv, opts) {
    var H = hub(sig, opts), o = H.opts, C = H.C;
    var relOut = 0, rel = [], fast = new Map();
    var rin = 0, held = {}, gapTimer = null, lastN = -1, lastFrom = 0, inEpoch = null, seenEpochs = {};
    var epoch = (opts && opts.epoch) || Math.random().toString(36).slice(2, 10);
    var side = !!(opts && opts.side);   // fan-out side link to another peer: 'fast' only, frames marked x:1
    var L = { mode: 'relay', to: to, epoch: epoch, closed: false, closedAt: 0, onDead: null, _rel: rel, side: side };

    L.send = function (ch, payload) {
      if (L.closed || H.dead) return false;
      var p = enc(payload);
      if (ch === 'rel' && side) return false;
      if (ch === 'rel') {
        if (rel.length >= o.relMax) return false;
        rel.push({ s: relOut++, p: p });
      } else {
        var k = fastKey(payload);
        fast.delete(k); fast.set(k, p); // newest wins, keeps arrival order of the types
      }
      H.kick();
      return true;
    };
    L.close = function () {
      if (L.closed) return;
      L.closed = true; L.closedAt = C.now();
      fast.clear();
      if (gapTimer) { C.clearTimeout(gapTimer); gapTimer = null; }
      H.remove(L);
    };
    /** noRel: a request carrying rel data is still in flight (only 'fast' data may go now) */
    L._pending = function (noRel) { return (!noRel && rel.length > 0) || fast.size > 0; };
    L._urgent = function (noRel) { return (!noRel && rel.length > 0) || fast.has('_ping') || fast.has('_pong'); };
    /** build one frame within `budget` bytes; returns {frame, bytes, rel:[…], fast:[[k,p]…]} */
    L._take = function (budget, noRel) {
      var r = [], bytes = 0;
      while (!noRel && rel.length && (bytes + size(rel[0].p) <= budget || !r.length)) { var x = rel.shift(); r.push(x); bytes += size(x.p); }
      var f = [];
      if (!L.closed) fast.forEach(function (p, k) { if (bytes + size(p) <= budget) { f.push([k, p]); bytes += size(p); } });
      f.forEach(function (kp) { fast.delete(kp[0]); });
      if (!r.length && !f.length) return null;
      var frame = { t: '_r', e: epoch, n: H._nextBatch() };
      if (side) frame.x = 1;
      if (r.length) { frame.s = r[0].s; frame.r = r.map(function (x) { return x.p; }); }
      if (f.length) frame.f = f.map(function (kp) { return kp[1]; });
      return { frame: frame, bytes: bytes, rel: r, fast: f };
    };
    /** a request failed: rel frames go back to the front; fast ones only if nothing newer was queued meanwhile */
    L._restore = function (t) {
      for (var i = t.rel.length - 1; i >= 0; i--) rel.unshift(t.rel[i]);
      t.fast.forEach(function (kp) { if (!fast.has(kp[0]) && !L.closed) fast.set(kp[0], kp[1]); });
    };
    L._restoreFrame = function (frame) {
      if (frame.r) for (var i = frame.r.length - 1; i >= 0; i--) rel.unshift({ s: frame.s + i, p: frame.r[i] });
    };

    function deliver(ch, p) {
      var v = dec(p);
      if (v == null) return;
      try { onRecv(ch, v); } catch (e) { if (typeof console !== 'undefined') console.error('[net.relay] receiver error', e); }
    }
    function flushHeld() {
      while (held[rin] !== undefined) { var p = held[rin]; delete held[rin]; rin++; deliver('rel', p); }
      var keys = Object.keys(held);
      if (gapTimer) { C.clearTimeout(gapTimer); gapTimer = null; }
      if (keys.length) {
        gapTimer = C.setTimeout(function () {
          gapTimer = null;
          var min = Math.min.apply(null, Object.keys(held).map(Number));
          if (isFinite(min) && min > rin) { rin = min; flushHeld(); }
        }, o.gapSkip);
      }
    }
    L._in = function (m) {
      if (L.closed) return;
      H.stats.recvFrames++;
      lastFrom = C.now();
      if (m.e !== inEpoch) {
        // a new link on the other side (first frame, or it reconnected): its sequence numbers start again at 0.
        // Frames from an epoch we already left behind are leftovers of a dead link: ignore them.
        if (m.e != null && seenEpochs[m.e]) return;
        if (inEpoch != null) seenEpochs[inEpoch] = 1;
        inEpoch = m.e; rin = 0; held = {}; lastN = -1;
        if (gapTimer) { C.clearTimeout(gapTimer); gapTimer = null; }
      }
      if (Array.isArray(m.r) && typeof m.s === 'number') {
        for (var i = 0; i < m.r.length; i++) { var s = m.s + i; if (s >= rin && held[s] === undefined) held[s] = m.r[i]; }
        flushHeld();
      }
      if (Array.isArray(m.f)) {
        var n = typeof m.n === 'number' ? m.n : 0;
        if (n < lastN && lastN - n < 1000) return; // an older batch arrived late: its fast state is stale
        lastN = n;
        for (var j = 0; j < m.f.length; j++) deliver('fast', m.f[j]);
      }
    };
    L._dead = function (reason) {
      if (L.closed && !reason) return;
      L.closed = true; L.closedAt = L.closedAt || C.now();
      if (gapTimer) { C.clearTimeout(gapTimer); gapTimer = null; }
      if (reason && typeof L.onDead === 'function') { try { L.onDead(reason); } catch (e) { /* ignore */ } }
    };
    H.add(L);
    return L;
  }

  var api = { DEFAULTS: DEFAULTS, link: link, hub: hub, supported: supported, _fastKey: fastKey, _b64e: b64e, _b64d: b64d };
  CB.net = CB.net || {};
  CB.net.relay = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

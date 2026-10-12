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
   Request budget (shared-hosting / Sucuri friendly — at most ONE long-poll + ONE short post in flight per tab)
     All links of one signal share one hub. With the vercel/PHP signal the hub replaces the signal's poll loop by an
     'exchange' loop: each request is {action:'relay', posts:[{to, msgs}], wait} = post + poll in one round trip.
       data queued -> wait 0 (returns at once with whatever mail is waiting), paced to >= minGap (150 ms) apart
       nothing queued -> long-poll (longWait 4000 ms; the server answers as soon as mail arrives)
       data queued while a long-poll is held -> one extra 'nopoll' post after 60 ms (rel) / 150 ms (fast only), paced
       like the main loop (so a held poll never delays input by more than ~150 ms)
     So a phone wheel costs each side ~4–6 requests/s (bounded by the round-trip time) with ~150–300 ms latency.
     Old servers without the 'relay' action (bad-action) -> plain post + the normal poll loop. Other signals
     (BroadcastChannel 'local') -> sig.send() per frame batch. Manual copy/paste codes cannot relay (no server).
   Multiplayer: CB.net.transport.host(sig, {relay:true}) / connect(sig, {relay:true}) enables the same fallback for
     a lobby (both ends must opt in; the guest asks with {t:'relay'}, the host answers {t:'relay-ok'}). An 8-player
     room shares the host's single exchange loop (one request carries posts for every guest); each guest runs its own.
   Wire format (a normal signalling message): {t:'_r', e: link epoch, n: batch#, s: first rel seq, r:[payload…], f:[payload…]}
     payload: string, or {b:'<base64>'} for binary.
     CB.net.relay.supported(signal) -> bool      CB.net.relay.hub(signal) -> Hub (debug: hub.stats, hub.mode)
     CB.net.relay.DEFAULTS
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  var DEFAULTS = {
    minGap: 150,        // ms between request starts (caps one tab at ~6.7 requests/s)
    longWait: 4000,     // ms long-poll when there is nothing to send (PHP caps it at 5000)
    relFlush: 60,       // ms before an extra post for queued 'rel' data while a long-poll is held
    fastFlush: 150,     // ms before an extra post for queued 'fast'-only data while a long-poll is held
    gapSkip: 1500,      // ms a missing rel frame may hold up later ones
    relMax: 512,        // queued rel payloads per link
    batchBytes: 40000   // payload bytes per request (the server takes 64 KB bodies)
  };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function now() { return Date.now(); }

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
    if (sig._relayHub && !sig._relayHub.dead) return sig._relayHub;
    var o = Object.assign({}, DEFAULTS, opts || {});
    var H = { links: {}, mode: typeof sig.exchange === 'function' ? 'exchange' : 'post', dead: false, opts: o,
      stats: { requests: 0, extra: 0, errors: 0, sentFrames: 0, recvFrames: 0 } };
    sig._relayHub = H;
    var running = false, inMain = false, mainLong = false, inExtra = false, extraTimer = null, wake = null, lastStart = 0, batchNo = 0;

    var offMsg = sig.onMessage(function (from, msg) {
      if (!msg || msg.t !== '_r') return;
      var l = H.links[from];
      if (l) l._in(msg);
    });
    var offClosed = sig.on ? sig.on('closed', function (e) { killAll((e && e.reason) || 'signal-closed'); }) : null;

    function killAll(reason) {
      Object.keys(H.links).forEach(function (k) { var l = H.links[k]; delete H.links[k]; l._dead(reason); });
      stop();
    }
    function hasData() { return Object.keys(H.links).some(function (k) { return H.links[k]._pending(); }); }
    function hasRel() { return Object.keys(H.links).some(function (k) { return H.links[k]._rel.length > 0; }); }
    /** take one frame per link with queued data -> [{to, msgs:[frame]}], plus a restore() for failed requests */
    function drain() {
      var posts = [], undo = [], budget = o.batchBytes;
      Object.keys(H.links).forEach(function (k) {
        var l = H.links[k];
        if (!l._pending()) return;
        var t = l._take(budget);
        if (!t) return;
        budget -= t.bytes;
        posts.push({ to: l.to, msgs: [t.frame] });
        undo.push(function () { l._restore(t); });
      });
      return { posts: posts, restore: function () { undo.forEach(function (f) { f(); }); } };
    }

    function kick() {
      if (H.mode === 'post') { schedulePost(); return; }
      if (!running) { start(); return; }
      if (wake) { var w = wake; wake = null; w(); return; }
      if (inMain && mainLong && !inExtra && !extraTimer) {
        extraTimer = setTimeout(extraPost, hasRel() ? o.relFlush : o.fastFlush);
      }
    }
    H.kick = kick;

    async function extraPost() {
      extraTimer = null;
      if (!running || !inMain || !mainLong || inExtra || !hasData()) return;
      inExtra = true;
      var d = drain();
      if (d.posts.length) {
        H.stats.extra++; H.stats.requests++;
        try { await sig.exchange(d.posts, 0, { nopoll: true }); H.stats.sentFrames += d.posts.length; }
        catch (e) { d.restore(); H.stats.errors++; }
      }
      inExtra = false;
      if (!inMain && wake) { var w = wake; wake = null; w(); }
      else if (inMain && mainLong && hasData() && !extraTimer) extraTimer = setTimeout(extraPost, o.minGap);
    }

    function start() {
      if (running || H.dead) return;
      running = true;
      if (sig.pausePolling) sig.pausePolling(true);
      loop();
    }
    function stop() {
      if (extraTimer) { clearTimeout(extraTimer); extraTimer = null; }
      if (running) { running = false; if (wake) { var w = wake; wake = null; w(); } }
      if (sig.pausePolling && sig.state !== 'closed') sig.pausePolling(false);
    }

    async function loop() {
      var backoff = 0;
      while (running && !H.dead) {
        if (!Object.keys(H.links).length) break;
        var gap = lastStart + o.minGap - now();
        if (gap > 0) await sleep(gap);
        while (inExtra && running) await new Promise(function (r) { wake = r; setTimeout(r, 200); });
        if (!running) break;
        var d = drain();
        var wait = d.posts.length ? 0 : o.longWait;
        lastStart = now(); inMain = true; mainLong = wait > 0;
        H.stats.requests++;
        try {
          await sig.exchange(d.posts, wait);
          H.stats.sentFrames += d.posts.length;
          backoff = 0;
        } catch (e) {
          d.restore(); H.stats.errors++;
          inMain = false; mainLong = false;
          if (e && e.code === 'bad-action') { // server predates the 'relay' action: post + normal polling
            H.mode = 'post'; running = false;
            if (sig.pausePolling) sig.pausePolling(false);
            schedulePost();
            return;
          }
          if (sig.state === 'closed' || (e && (e.code === 'closed' || e.code === 'room-closed' || e.code === 'auth'))) { killAll((e && e.code) || 'closed'); return; }
          backoff = Math.min(4000, backoff ? backoff * 2 : 300);
          H.lastError = e;
          await sleep(backoff);
        }
        inMain = false; mainLong = false;
        if (extraTimer) { clearTimeout(extraTimer); extraTimer = null; }
        reap();
      }
      running = false;
      if (!Object.keys(H.links).length) stop();
    }

    /* 'post' mode: no combined action -> sig.send() frames; mail arrives through the signal's own poll loop */
    var postTimer = null, posting = false, lastPost = 0;
    function schedulePost() {
      if (postTimer || posting || H.dead) return;
      postTimer = setTimeout(doPost, Math.max(0, lastPost + o.minGap - now()));
    }
    async function doPost() {
      postTimer = null;
      if (posting || H.dead) return;
      posting = true; lastPost = now();
      var d = drain();
      H.stats.requests += d.posts.length;
      await Promise.all(d.posts.map(function (p) {
        return sig.send(p.to, p.msgs[0]).then(function () { H.stats.sentFrames++; }, function (e) {
          H.stats.errors++;
          if (sig.state === 'closed') return;
          var l = H.links[p.to]; if (l) l._restoreFrame(p.msgs[0]);
        });
      }));
      posting = false;
      reap();
      if (hasData()) schedulePost();
    }

    /** links that were closed and have flushed (or waited long enough) leave the hub */
    function reap() {
      Object.keys(H.links).forEach(function (k) {
        var l = H.links[k];
        if (l.closed && (!l._pending() || now() - l.closedAt > 2000)) delete H.links[k];
      });
      if (!Object.keys(H.links).length) { stop(); }
    }

    H.add = function (l) {
      var old = H.links[l.to];
      if (old && old !== l) old._dead(null);
      H.links[l.to] = l;
      kick();
    };
    H.remove = function (l) {
      if (H.links[l.to] !== l) return;
      if (l._pending()) { kick(); setTimeout(reap, 2100); } else { delete H.links[l.to]; reap(); }
    };
    H.destroy = function () {
      H.dead = true; killAll(null); offMsg(); if (offClosed) offClosed();
      if (sig._relayHub === H) sig._relayHub = null;
    };
    H._nextBatch = function () { return ++batchNo; };
    return H;
  }

  /* ---------------------------------------------------------------- link */
  function link(sig, to, onRecv, opts) {
    var H = hub(sig, opts), o = H.opts;
    var relOut = 0, rel = [], fast = new Map();
    var rin = 0, held = {}, gapTimer = null, lastN = -1, lastFrom = 0, inEpoch = null, seenEpochs = {};
    var epoch = (opts && opts.epoch) || Math.random().toString(36).slice(2, 10);
    var L = { mode: 'relay', to: to, epoch: epoch, closed: false, closedAt: 0, onDead: null, _rel: rel };

    L.send = function (ch, payload) {
      if (L.closed || H.dead) return false;
      var p = enc(payload);
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
      L.closed = true; L.closedAt = now();
      fast.clear();
      if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
      H.remove(L);
    };
    L._pending = function () { return rel.length > 0 || fast.size > 0; };
    /** build one frame within `budget` bytes; returns {frame, bytes, rel:[…], fast:[[k,p]…]} */
    L._take = function (budget) {
      var r = [], bytes = 0;
      while (rel.length && (bytes + size(rel[0].p) <= budget || !r.length)) { var x = rel.shift(); r.push(x); bytes += size(x.p); }
      var f = [];
      if (!L.closed) fast.forEach(function (p, k) { if (bytes + size(p) <= budget) { f.push([k, p]); bytes += size(p); } });
      f.forEach(function (kp) { fast.delete(kp[0]); });
      if (!r.length && !f.length) return null;
      var frame = { t: '_r', e: epoch, n: H._nextBatch() };
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
      if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
      if (keys.length) {
        gapTimer = setTimeout(function () {
          gapTimer = null;
          var min = Math.min.apply(null, Object.keys(held).map(Number));
          if (isFinite(min) && min > rin) { rin = min; flushHeld(); }
        }, o.gapSkip);
      }
    }
    L._in = function (m) {
      if (L.closed) return;
      H.stats.recvFrames++;
      lastFrom = now();
      if (m.e !== inEpoch) {
        // a new link on the other side (first frame, or it reconnected): its sequence numbers start again at 0.
        // Frames from an epoch we already left behind are leftovers of a dead link: ignore them.
        if (m.e != null && seenEpochs[m.e]) return;
        if (inEpoch != null) seenEpochs[inEpoch] = 1;
        inEpoch = m.e; rin = 0; held = {}; lastN = -1;
        if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
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
      L.closed = true; L.closedAt = L.closedAt || now();
      if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
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

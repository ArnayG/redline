/* Node tests for the server-relay fallback: js/net/relay.js (ordering, coalescing, epochs, request budget), the
   'relay' action of api/signal.js (rate buckets, validation), js/net/signal.js error reasons (blocked / unreachable),
   and CB.net.transport + the phone wheel switching to the relay when WebRTC never connects (fake RTCPeerConnection).
   Real HTTP: tools/dev-server.js (in-memory store) on a free port. The PHP twin is covered in cpanel-package.test.js.
   Run: node tests/run.js net-relay */
'use strict';
var path = require('path');
var Readable = require('stream').Readable;
var root = path.join(__dirname, '..');
var API = require(path.join(root, 'api', 'signal.js'));
var S = require(path.join(root, 'js', 'net', 'signal.js'));
var RL = require(path.join(root, 'js', 'net', 'relay.js'));
var T = require(path.join(root, 'js', 'net', 'transport.js'));
var W = require(path.join(root, 'js', 'input', 'phone-wheel.js'));
var DEV = require(path.join(root, 'tools', 'dev-server.js'));

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(fn, ms, what) {
  var t0 = Date.now();
  while (Date.now() - t0 < (ms || 5000)) { if (fn()) return true; await sleep(10); }
  throw new Error('timed out waiting for ' + (what || 'condition'));
}

var srv = null, base = null;
async function server() {
  if (srv) return base;
  srv = DEV.createServer();
  await new Promise(function (r) { srv.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + srv.address().port + '/';
  return base;
}
function stopServer() { if (srv) { try { srv.close(); if (srv.closeAllConnections) srv.closeAllConnections(); } catch (e) { /* ignore */ } srv = null; } }
/** fetch that counts requests per action (and can rewrite responses) */
function counting(wrap) {
  var f = async function (u, init) {
    var b = {}; try { b = JSON.parse(init.body); } catch (e) { /* ignore */ }
    f.n[b.action] = (f.n[b.action] || 0) + 1;
    if (wrap) { var w = await wrap(b, u, init); if (w) return w; }
    return fetch(u, init);
  };
  f.n = {};
  return f;
}
function sigPair(fetchA, fetchB) {
  return server().then(async function (b) {
    var host = S.vercel({ url: b + 'api/signal.php', fetch: fetchA || fetch, wait: 3000 });
    var guest = S.vercel({ url: b + 'api/signal.php', fetch: fetchB || fetch, wait: 3000 });
    var room = await host.create();
    await guest.join(room.room);
    return { host: host, guest: guest };
  });
}

/* ------------------------------------------------------------------ unit */
test('relay: fast coalescing keys and base64 round trip', function () {
  assert.equal(RL._fastKey('{"t":"in","q":1}'), 'in');
  assert.equal(RL._fastKey('{"t":"_ping","a":1}'), '_ping');
  assert.equal(RL._fastKey(new ArrayBuffer(4)), 'bin');
  var u = new Uint8Array([0, 1, 2, 250, 255, 128]);
  assert.deepEqual(Array.from(new Uint8Array(RL._b64d(RL._b64e(u.buffer)))), Array.from(u));
});

test('relay: receiver re-orders rel frames, drops duplicates and stale fast state, resets on a new epoch', async function () {
  var fake = S.local({ BroadcastChannel: function () { this.postMessage = function () {}; this.close = function () {}; } });
  fake.room = 'ABCDE'; fake.peer = 'host'; fake.role = 'host'; fake.state = 'open';
  var got = [];
  var l = RL.link(fake, 'pabcdef', function (ch, p) { got.push(ch + ':' + p); }, { gapSkip: 100 });
  l._in({ t: '_r', e: 'A', n: 2, s: 2, r: ['c', 'd'], f: ['{"t":"in","q":2}'] });
  l._in({ t: '_r', e: 'A', n: 1, s: 0, r: ['a', 'b'], f: ['{"t":"in","q":1}'] });  // late batch: rel kept, fast dropped
  l._in({ t: '_r', e: 'A', n: 3, s: 1, r: ['b', 'c', 'd', 'e'] });                   // duplicates
  assert.deepEqual(got, ['fast:{"t":"in","q":2}', 'rel:a', 'rel:b', 'rel:c', 'rel:d', 'rel:e']);
  got.length = 0;
  l._in({ t: '_r', e: 'A', n: 4, s: 7, r: ['h'] });     // gap (5, 6 missing): held, then skipped after gapSkip
  assert.deepEqual(got, []);
  await sleep(160);
  assert.deepEqual(got, ['rel:h']);
  got.length = 0;
  l._in({ t: '_r', e: 'B', n: 1, s: 0, r: ['new0'] });  // the other side re-created its link
  l._in({ t: '_r', e: 'A', n: 9, s: 8, r: ['old'] });   // leftovers of the dead link are ignored
  assert.deepEqual(got, ['rel:new0']);
  l.close();
  RL.hub(fake).destroy();
});

/* ------------------------------------------------------------------ over HTTP (dev server, in-memory store) */
test('relay: exchange loop delivers rel in order + coalesced fast both ways; idle costs few requests', async function () {
  var fa = counting(), fb = counting();
  var p = await sigPair(fa, fb);
  var atHost = [], atGuest = [];
  var lh = RL.link(p.host, p.guest.peer, function (ch, x) { atHost.push([ch, x]); });
  var lg = RL.link(p.guest, 'host', function (ch, x) { atGuest.push([ch, x]); });
  for (var i = 0; i < 40; i++) { lg.send('rel', JSON.stringify({ t: 'btn', i: i })); lg.send('fast', JSON.stringify({ t: 'in', q: i })); }
  lh.send('rel', '{"t":"welcome"}');
  var bin = new Uint8Array([0xF5, 1, 0, 9]).buffer;
  lh.send('fast', bin);
  await until(function () { return atHost.filter(function (m) { return m[0] === 'rel'; }).length === 40 && atGuest.length >= 2; }, 6000, 'delivery');
  var rels = atHost.filter(function (m) { return m[0] === 'rel'; }).map(function (m) { return JSON.parse(m[1]).i; });
  assert.deepEqual(rels, Array.from({ length: 40 }, function (_, k) { return k; }), 'rel in order, exactly once');
  var fasts = atHost.filter(function (m) { return m[0] === 'fast'; }).map(function (m) { return JSON.parse(m[1]).q; });
  assert.ok(fasts.length >= 1 && fasts.length <= 3, 'fast coalesced: ' + fasts);
  assert.equal(fasts[fasts.length - 1], 39, 'newest input wins');
  assert.equal(atGuest[0][1], '{"t":"welcome"}');
  var b = atGuest.filter(function (m) { return m[0] === 'fast'; })[0][1];
  assert.ok(b instanceof ArrayBuffer && new Uint8Array(b)[0] === 0xF5, 'binary payload survives');
  // idle: both sides long-poll -> only a handful of requests in 2 s, and the signal poll loop is paused meanwhile
  var r0 = (fa.n.relay || 0) + (fb.n.relay || 0), p0 = (fa.n.poll || 0) + (fb.n.poll || 0);
  await sleep(2000);
  var r1 = (fa.n.relay || 0) + (fb.n.relay || 0), p1 = (fa.n.poll || 0) + (fb.n.poll || 0);
  assert.ok(r1 - r0 <= 4, 'idle relay requests in 2 s: ' + (r1 - r0));
  assert.ok(p1 - p0 <= 1, 'signal poll loop paused while relaying (' + (p1 - p0) + ')');
  // closing the last link resumes the normal signalling poll loop
  lh.close(); lg.close();
  await sleep(400);
  var got = [];
  p.guest.onMessage(function (from, m) { got.push(m); });
  await p.host.send(p.guest.peer, { t: 'after' });
  await until(function () { return got.some(function (m) { return m.t === 'after'; }); }, 6000, 'poll loop resumed');
  await p.host.close(); await p.guest.close();
});

test('relay: a steady 60 Hz sender stays within ~7 requests/s per side', async function () {
  var fa = counting(), fb = counting();
  var p = await sigPair(fa, fb);
  var n = 0, last = -1;
  RL.link(p.host, p.guest.peer, function (ch, x) { if (ch === 'fast') { n++; last = JSON.parse(x).q; } });
  var lg = RL.link(p.guest, 'host', function () {});
  var q = 0, iv = setInterval(function () { lg.send('fast', JSON.stringify({ t: 'in', q: ++q })); }, 16);
  await sleep(300);
  var a0 = fa.n.relay || 0, b0 = fb.n.relay || 0;
  await sleep(2000);
  clearInterval(iv);
  var a = (fa.n.relay || 0) - a0, b = (fb.n.relay || 0) - b0;
  assert.ok(b <= 15, 'sender requests in 2 s: ' + b);
  assert.ok(a <= 16, 'receiver requests in 2 s: ' + a);
  console.log('    [rate] sender', b, 'receiver', a, 'deliveries', n, 'in 2 s');
  assert.ok(n >= 6, 'input updates delivered: ' + n);
  await until(function () { return last === q; }, 2000, 'newest input');
  await p.host.close(); await p.guest.close();
});

test('relay: an old server without the relay action (bad-action) falls back to post + poll', async function () {
  var old = function (b) { return b.action === 'relay' ? { status: 400, json: async function () { return { ok: false, code: 'bad-action', error: 'unknown action' }; } } : null; };
  var p = await sigPair(counting(old), counting(old));
  var atHost = [], atGuest = [];
  RL.link(p.host, p.guest.peer, function (ch, x) { atHost.push(x); }).send('rel', 'w');
  var lg = RL.link(p.guest, 'host', function (ch, x) { atGuest.push(x); });
  lg.send('rel', 'a'); lg.send('rel', 'b'); lg.send('fast', '{"t":"in","q":3}');
  await until(function () { return atHost.length >= 3 && atGuest.length >= 1; }, 8000, 'fallback delivery');
  assert.deepEqual(atHost.slice(0, 2), ['a', 'b']);
  assert.equal(RL.hub(p.guest).mode, 'post');
  await p.host.close(); await p.guest.close();
});

/* ------------------------------------------------------------------ api/signal.js relay action */
function invoke(handler, body, ip) {
  var raw = JSON.stringify(body), req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = { host: 'forge.test', 'content-type': 'application/json', 'x-forwarded-for': ip || '10.0.0.9' };
  return new Promise(function (resolve, reject) {
    var res = { statusCode: 200, headers: {}, headersSent: false, setHeader: function (k, v) { this.headers[k] = v; },
      end: function (b) { this.headersSent = true; resolve({ status: this.statusCode, body: b ? JSON.parse(b) : null }); } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
test('api relay: post + poll in one request, per-destination drops, validation, own rate bucket', async function () {
  var h = API.createHandler({ redis: API.createMemoryRedis(), sleep: function () { return sleep(1); } });
  var c = (await invoke(h, { action: 'create' })).body;
  var g = (await invoke(h, { action: 'join', room: c.room })).body;
  var r = await invoke(h, { action: 'relay', room: c.room, token: g.token, posts: [{ to: 'host', msgs: [{ t: '_r', n: 1 }] }, { to: 'pzzzzzz', msgs: [{ t: 'x' }] }], wait: 0 });
  assert.equal(r.status, 200); assert.deepEqual(r.body.dropped, ['pzzzzzz'], 'guests may only reach the host');
  r = await invoke(h, { action: 'relay', room: c.room, token: c.token, posts: [{ to: g.peer, msgs: [{ t: 'back' }] }], wait: 200 });
  assert.deepEqual(r.body.msgs.map(function (m) { return [m.from, m.msg.t]; }), [[g.peer, '_r']]);
  r = await invoke(h, { action: 'relay', room: c.room, token: g.token, nopoll: true });
  assert.deepEqual(r.body.msgs, [], 'nopoll leaves the mailbox alone');
  r = await invoke(h, { action: 'relay', room: c.room, token: g.token });
  assert.deepEqual(r.body.msgs.map(function (m) { return m.msg.t; }), ['back']);
  assert.equal((await invoke(h, { action: 'relay', room: c.room, token: 'nope' })).body.code, 'auth');
  assert.equal((await invoke(h, { action: 'relay', room: c.room, token: g.token, posts: 'x' })).body.code, 'bad-request');
  assert.equal((await invoke(h, { action: 'relay', room: c.room, token: g.token, posts: Array.from({ length: 9 }, function () { return { to: 'host', msgs: [] }; }) })).status, 413);
  // 700 relay requests in a minute (two phones at ~6/s) do not touch the 600/min signalling budget
  for (var i = 0; i < 700; i++) { var x = await invoke(h, { action: 'relay', room: c.room, token: g.token, nopoll: true }, '10.0.0.7'); if (x.status !== 200) throw new Error('relay ' + i + ' -> ' + x.status); }
  assert.equal((await invoke(h, { action: 'poll', room: c.room, token: g.token, wait: 0 }, '10.0.0.7')).status, 200, 'poll still allowed');
  var lim = API.createHandler({ redis: API.createMemoryRedis(), limits: { relayPerIp: 3 } });
  var c2 = (await invoke(lim, { action: 'create' }, '10.1.1.1')).body;
  var codes = [];
  for (var k = 0; k < 4; k++) codes.push((await invoke(lim, { action: 'relay', room: c2.room, token: c2.token, nopoll: true }, '10.1.1.1')).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
});

/* ------------------------------------------------------------------ signal.js: visible reasons, never a silent hang */
test('signal: HTML 403/406 from a host firewall -> code blocked; dead network -> unreachable; probe reports blocked', async function () {
  var html = function (st) { return async function () { return { status: st, json: async function () { throw new SyntaxError('Unexpected token <'); } }; }; };
  await assert.rejects(S.vercel({ url: 'api/signal.php', fetch: html(406) }).join('ABCDE'), function (e) { return e.code === 'blocked' && e.status === 406; });
  await assert.rejects(S.vercel({ url: 'api/signal.php', fetch: html(403) }).create(), function (e) { return e.code === 'blocked' && e.status === 403; });
  await assert.rejects(S.vercel({ url: 'api/signal.php', fetch: async function () { throw new TypeError('Failed to fetch'); } }).join('ABCDE'), function (e) { return e.code === 'unreachable'; });
  var f = async function (u) { return u === 'api/signal.php' ? { status: 403, json: async function () { throw new Error('html'); } } : { status: 404, json: async function () { throw new Error('html'); } }; };
  await assert.rejects(S.vercel({ fetch: f, probe: true }).join('ABCDE'), function (e) { return e.code === 'blocked' && e.status === 403; });
});

/* ------------------------------------------------------------------ transport + phone wheel over the relay */
function DeadPC() { this.connectionState = 'new'; this.localDescription = null; this.onicecandidate = null; }
DeadPC.prototype.createDataChannel = function (label) { return { label: label, readyState: 'connecting', bufferedAmount: 0, send: function () {}, close: function () {} }; };
DeadPC.prototype.createOffer = async function () { return { type: 'offer', sdp: 'v=0\r\n' }; };
DeadPC.prototype.createAnswer = async function () { return { type: 'answer', sdp: 'v=0\r\n' }; };
DeadPC.prototype.setLocalDescription = async function (d) { this.localDescription = d; };
DeadPC.prototype.setRemoteDescription = async function () {};
DeadPC.prototype.addIceCandidate = async function () {};
DeadPC.prototype.close = function () { this.connectionState = 'closed'; };

test('transport relay: WebRTC never connects -> both ends switch to the server relay; wheel input + controls flow', async function () {
  var p = await sigPair();
  var host = T.host(p.host, { RTCPeerConnection: DeadPC, relay: true, pingInterval: 300 });
  var rx = W.createReceiver(host, { hub: null });
  var client = T.connect(p.guest, { RTCPeerConnection: DeadPC, relay: { after: 400 }, pingInterval: 300 });
  var stages = [];
  client.on('stage', function (s) { stages.push(s); });
  var tx = W.createSender(client, { name: 'Test phone', sensor: 'touch' });
  var welcome = null; tx.on('welcome', function (m) { welcome = m; });
  await until(function () { return client.state === 'open' && rx.phone && rx.phone.name === 'Test phone' && welcome; }, 8000, 'relay open + hello/welcome');
  assert.equal(client.mode, 'relay'); assert.equal(rx.mode(), 'relay'); assert.equal(tx.mode(), 'relay');
  assert.ok(stages.indexOf('relay') >= 0 && stages[stages.length - 1] === 'open', stages.join(','));
  var btn = []; rx.on('btn', function (b) { btn.push(b); });
  tx.set({ steer: 0.6, throttle: 0.9 });
  var iv = setInterval(function () { tx.tick(); }, 16);
  tx.press('shiftUp'); tx.press('shiftDown');
  await until(function () { return rx.lastIn && rx.lastIn.steer === 0.6 && btn.length === 2; }, 4000, 'input on desktop');
  assert.deepEqual(btn, ['shiftUp', 'shiftDown']);
  var t = Date.now(); while (Date.now() - t < 600) { var rd = rx.read(); assert.ok(rd && !rd.stale, 'relay input stays fresh (1 s failsafe)'); await sleep(50); }
  await until(function () { return client.rtt > 0; }, 3000, 'rtt over the relay');
  // failsafe still bites in relay mode: phone stops sending -> centred within ~1 s
  clearInterval(iv);
  await sleep(1300);
  var stale = rx.read(); assert.ok(stale.stale && stale.steer === 0 && stale.throttle === 0);
  client.close(); host.close(); rx.close();
  await sleep(200);
  await p.host.close(); await p.guest.close();
});

test('transport relay: without relay:true on the host the guest keeps waiting (no half-open link)', async function () {
  var p = await sigPair();
  var host = T.host(p.host, { RTCPeerConnection: DeadPC });
  var client = T.connect(p.guest, { RTCPeerConnection: DeadPC, relay: { after: 200 }, timeout: 1500 });
  var reason = null; client.on('close', function (r) { reason = r; });
  await until(function () { return reason; }, 4000, 'timeout');
  assert.equal(reason, 'timeout');
  assert.equal(host.list().filter(function (x) { return x.state === 'open'; }).length, 0);
  host.close();
  await p.host.close(); await p.guest.close();
});

test('relay: cleanup', function () { stopServer(); });

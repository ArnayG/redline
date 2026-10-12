/* Node tests for api/signal.js (against an in-memory Upstash REST mock) and js/net/signal.js
   (vercel backend via an in-process fetch, local BroadcastChannel backend, manual codes).
   Run: node tests/run.js net-signal */
'use strict';
var path = require('path');
var Readable = require('stream').Readable;
var root = path.join(__dirname, '..');
var API = require(path.join(root, 'api', 'signal.js'));
var S = require(path.join(root, 'js', 'net', 'signal.js'));

/* ------------------------------------------------------------------ harness */
function upstashMock(mem, token) {
  var calls = [];
  var f = async function (url, init) {
    calls.push(url);
    if ((init.headers || {}).Authorization !== 'Bearer ' + token) return { ok: false, status: 401, json: async function () { return { error: 'Unauthorized' }; } };
    var body = JSON.parse(init.body);
    var run = function (cmd) { try { return { result: mem.command(cmd) }; } catch (e) { return { error: e.message }; } };
    var out = /\/pipeline$/.test(url) ? body.map(run) : run(body);
    return { ok: true, status: 200, json: async function () { return out; } };
  };
  f.calls = calls;
  return f;
}
function env() {
  var clock = { t: 1700000000000 };
  var mem = API.createMemoryRedis({ now: function () { return clock.t; } });
  var fetch = upstashMock(mem, 'tok');
  var handler = API.createHandler({
    env: { UPSTASH_REDIS_REST_URL: 'https://fake.upstash.io/', UPSTASH_REDIS_REST_TOKEN: 'tok' },
    fetch: fetch,
    now: function () { return clock.t; },
    sleep: async function (ms) { clock.t += ms; if (clock.onSleep) await clock.onSleep(ms); }
  });
  return { clock: clock, mem: mem, fetch: fetch, handler: handler };
}
function invoke(handler, body, o) {
  o = o || {};
  var raw = o.raw != null ? o.raw : body === undefined ? '' : JSON.stringify(body);
  var req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = o.method || 'POST';
  req.headers = Object.assign({ host: 'forge.test', 'content-type': 'application/json', 'x-forwarded-for': o.ip || '10.0.0.1' }, o.headers || {});
  return new Promise(function (resolve, reject) {
    var res = {
      statusCode: 200, headers: {}, headersSent: false,
      setHeader: function (k, v) { this.headers[k.toLowerCase()] = v; },
      end: function (b) { this.headersSent = true; resolve({ status: this.statusCode, headers: this.headers, body: b ? JSON.parse(b) : null }); }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
async function ok(h, body, o) { var r = await invoke(h, body, o); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.ok, true, JSON.stringify(r.body)); return r.body; }

/* ------------------------------------------------------------------ api/signal.js */
test('api: no env -> 200 {ok:false, code:no-backend}', async function () {
  var h = API.createHandler({ env: {} });
  var r = await invoke(h, { action: 'create' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.code], [false, 'no-backend']);
  var g = await invoke(h, undefined, { method: 'GET' });
  assert.equal(g.body.code, 'no-backend');
});

test('api: KV_REST_API_* env names are accepted; status reports backend', async function () {
  var mem = API.createMemoryRedis(), fetch = upstashMock(mem, 'kv');
  var h = API.createHandler({ env: { KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 'kv' }, fetch: fetch });
  var b = await ok(h, { action: 'status' });
  assert.equal(b.backend, 'upstash');
  var c = await ok(h, { action: 'create' });
  assert.match(c.room, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
  assert.ok(fetch.calls.every(function (u) { return u === 'https://kv.example/pipeline'; }));
});

test('api: create / join / post / poll round trip, both directions', async function () {
  var E = env(), h = E.handler;
  var c = await ok(h, { action: 'create' });
  assert.equal(c.peer, 'host'); assert.ok(c.token.length >= 20); assert.equal(c.ttl, 7200);
  var j = await ok(h, { action: 'join', room: c.room.toLowerCase() });
  assert.match(j.peer, /^p[a-z0-9]{6}$/); assert.equal(j.room, c.room); assert.equal(j.host, 'host');
  await ok(h, { action: 'post', room: c.room, token: j.token, to: 'host', msg: { t: 'join', sid: 'x' } });
  await ok(h, { action: 'post', room: c.room, token: j.token, to: 'host', msgs: [{ t: 'ice', c: 1 }, { t: 'ice', c: 2 }] });
  var p = await ok(h, { action: 'poll', room: c.room, token: c.token, wait: 0 });
  assert.deepEqual(p.msgs.map(function (m) { return m.msg.t + (m.msg.c || ''); }), ['join', 'ice1', 'ice2']);
  assert.ok(p.msgs.every(function (m) { return m.from === j.peer && typeof m.ts === 'number'; }));
  var p2 = await ok(h, { action: 'poll', room: c.room, token: c.token, wait: 0 });
  assert.equal(p2.msgs.length, 0, 'poll drains the mailbox');
  await ok(h, { action: 'post', room: c.room, token: c.token, to: j.peer, msg: { t: 'sdp', type: 'offer' } });
  var p3 = await ok(h, { action: 'poll', room: c.room, token: j.token, wait: 0 });
  assert.equal(p3.msgs[0].from, 'host'); assert.equal(p3.msgs[0].msg.type, 'offer');
});

test('api: poll waits (short sleeps, <= 8 s) and returns as soon as a message lands', async function () {
  var E = env(), h = E.handler;
  var c = await ok(h, { action: 'create' }), j = await ok(h, { action: 'join', room: c.room });
  var t0 = E.clock.t, slept = 0;
  var empty = await ok(h, { action: 'poll', room: c.room, token: c.token, wait: 60000 });
  assert.equal(empty.msgs.length, 0);
  assert.ok(E.clock.t - t0 <= 8000 && E.clock.t - t0 >= 6000, 'waited ' + (E.clock.t - t0));
  E.clock.onSleep = async function () {
    if (++slept === 3) await ok(h, { action: 'post', room: c.room, token: j.token, to: 'host', msg: 'hi' });
  };
  t0 = E.clock.t;
  var got = await ok(h, { action: 'poll', room: c.room, token: c.token, wait: 8000 });
  assert.deepEqual(got.msgs.map(function (m) { return m.msg; }), ['hi']);
  assert.ok(E.clock.t - t0 < 1500, 'returned early');
});

test('api: TTLs — mailbox 2 min, room 2 h (sliding on host poll)', async function () {
  var E = env(), h = E.handler;
  var c = await ok(h, { action: 'create' }), j = await ok(h, { action: 'join', room: c.room });
  assert.equal(E.mem.command(['TTL', 'fg:room:' + c.room]), 7200);
  await ok(h, { action: 'post', room: c.room, token: j.token, to: 'host', msg: 1 });
  assert.equal(E.mem.command(['TTL', 'fg:mb:' + c.room + ':host']), 120);
  E.clock.t += 121000;
  var p = await ok(h, { action: 'poll', room: c.room, token: c.token, wait: 0 });
  assert.equal(p.msgs.length, 0, 'mailbox expired');
  E.clock.t += 7100 * 1000; // host polled 121 s in -> room lives until +7321 s
  await ok(h, { action: 'poll', room: c.room, token: j.token, wait: 0 });
  E.clock.t += 200 * 1000;
  var r = await invoke(h, { action: 'join', room: c.room });
  assert.equal(r.status, 404); assert.equal(r.body.code, 'not-found');
  var r2 = await invoke(h, { action: 'poll', room: c.room, token: j.token, wait: 0 });
  assert.equal(r2.body.code, 'room-closed');
});

test('api: payload caps (64 KB body, 32 msgs/post, 256 queued) and validation', async function () {
  var E = env(), h = E.handler;
  var c = await ok(h, { action: 'create' }), j = await ok(h, { action: 'join', room: c.room });
  var big = await invoke(h, { action: 'post', room: c.room, token: j.token, to: 'host', msg: 'x'.repeat(70000) });
  assert.equal(big.status, 413); assert.equal(big.body.code, 'too-large');
  var many = await invoke(h, { action: 'post', room: c.room, token: j.token, to: 'host', msgs: new Array(33).fill(1) });
  assert.equal(many.body.code, 'too-large');
  for (var i = 0; i < 9; i++) await ok(h, { action: 'post', room: c.room, token: j.token, to: 'host', msgs: new Array(32).fill(i) });
  assert.equal(E.mem.command(['LLEN', 'fg:mb:' + c.room + ':host']), 256, 'mailbox trimmed to newest 256');
  assert.equal((await invoke(h, null, { raw: '{nope' })).body.code, 'bad-request');
  assert.equal((await invoke(h, [1, 2])).body.code, 'bad-request');
  assert.equal((await invoke(h, { action: 'hack' })).body.code, 'bad-action');
  assert.equal((await invoke(h, { action: '__proto__' })).body.code, 'bad-action');
  assert.equal((await invoke(h, { action: 'join', room: 'AB' })).body.code, 'bad-request');
  assert.equal((await invoke(h, { action: 'join', room: 'IL0O1' })).body.code, 'bad-request');
  assert.equal((await invoke(h, { action: 'join', room: 'ZZZZZ' })).body.code, 'not-found');
  assert.equal((await invoke(h, { action: 'post', room: c.room, token: j.token, to: '../x', msg: 1 })).body.code, 'bad-request');
  assert.equal((await invoke(h, { action: 'post', room: c.room, token: j.token, to: 'host' })).body.code, 'bad-request');
  assert.equal((await invoke(h, { action: 'poll', room: c.room, token: 'wrong', wait: 0 })).body.code, 'auth');
  assert.equal((await invoke(h, { action: 'create' }, { method: 'PUT' })).status, 405);
});

test('api: peers may only message the host; host may message any member', async function () {
  var E = env(), h = E.handler;
  var c = await ok(h, { action: 'create' });
  var a = await ok(h, { action: 'join', room: c.room }), b = await ok(h, { action: 'join', room: c.room });
  var r = await invoke(h, { action: 'post', room: c.room, token: a.token, to: b.peer, msg: 1 });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'forbidden');
  await ok(h, { action: 'post', room: c.room, token: c.token, to: b.peer, msg: 1 });
  assert.equal((await invoke(h, { action: 'post', room: c.room, token: c.token, to: 'pzzzzzz', msg: 1 })).body.code, 'not-found');
  assert.equal((await invoke(h, { action: 'post', room: c.room, token: c.token, to: 'host', msg: 1 })).body.code, 'bad-request');
});

test('api: room holds 8 players (host + 7)', async function () {
  var E = env(), h = E.handler;
  var c = await ok(h, { action: 'create' });
  for (var i = 0; i < 7; i++) await ok(h, { action: 'join', room: c.room, ip: 'x' }, { ip: '10.1.0.' + i });
  var r = await invoke(h, { action: 'join', room: c.room }, { ip: '10.2.0.1' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'full');
});

test('api: close — host closes room (peers told), peer leave (host told)', async function () {
  var E = env(), h = E.handler;
  var c = await ok(h, { action: 'create' });
  var a = await ok(h, { action: 'join', room: c.room }), b = await ok(h, { action: 'join', room: c.room });
  await ok(h, { action: 'close', room: c.room, token: b.token });
  var hp = await ok(h, { action: 'poll', room: c.room, token: c.token, wait: 0 });
  assert.deepEqual(hp.msgs.map(function (m) { return [m.from, m.msg.t]; }), [[b.peer, '_leave']]);
  assert.equal((await invoke(h, { action: 'poll', room: c.room, token: b.token, wait: 0 })).body.code, 'auth', 'left peer token is dead');
  assert.equal((await invoke(h, { action: 'close', room: c.room, token: a.token + 'x' })).body.code, 'auth');
  await ok(h, { action: 'close', room: c.room, token: c.token });
  var ap = await ok(h, { action: 'poll', room: c.room, token: a.token, wait: 0 }).catch(function (e) { return e; });
  // room record is gone, so auth fails with room-closed; the _closed notice sits in the (now orphaned) mailbox
  assert.ok(ap instanceof Error || (ap.msgs && ap.msgs[0].msg.t === '_closed'));
  var again = await invoke(h, { action: 'poll', room: c.room, token: a.token, wait: 0 });
  assert.equal(again.body.code, 'room-closed');
  var dup = await ok(h, { action: 'close', room: c.room, token: c.token });
  assert.equal(dup.already, true);
});

test('api: per-IP rate limits (creates and overall)', async function () {
  var E = env(), h = API.createHandler({
    redis: E.mem, now: function () { return E.clock.t; }, limits: { ratePerIp: 20, createPerIp: 3 }
  });
  for (var i = 0; i < 3; i++) await ok(h, { action: 'create' }, { ip: '1.1.1.1' });
  var r = await invoke(h, { action: 'create' }, { ip: '1.1.1.1' });
  assert.equal(r.status, 429); assert.equal(r.body.code, 'rate-limited');
  await ok(h, { action: 'create' }, { ip: '2.2.2.2' });
  var codes = [];
  for (var k = 0; k < 25; k++) codes.push((await invoke(h, { action: 'join', room: 'ZZZZZ' }, { ip: '3.3.3.3' })).body.code);
  assert.equal(codes.indexOf("rate-limited"), 20, codes.join(","));
  E.clock.t += 61000;
  await ok(h, { action: 'create' }, { ip: '1.1.1.1' }); // new window
});

test('api: same-origin only (cross-origin rejected, no CORS headers), OPTIONS answered', async function () {
  var E = env(), h = E.handler;
  var r = await invoke(h, { action: 'create' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'forbidden');
  var n = await invoke(h, { action: 'create' }, { headers: { origin: 'null' } });
  assert.equal(n.status, 403);
  var s = await invoke(h, { action: 'create' }, { headers: { origin: 'https://forge.test' } });
  assert.equal(s.body.ok, true);
  assert.equal(s.headers['access-control-allow-origin'], undefined);
  assert.equal(s.headers['cache-control'], 'no-store');
  var o = await invoke(h, undefined, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(o.status, 204);
  assert.equal(o.headers['access-control-allow-origin'], undefined);
});

test('api: Vercel-style pre-parsed req.body is accepted', async function () {
  var E = env();
  var req = Readable.from([]); req.method = 'POST'; req.headers = { host: 'forge.test' }; req.body = { action: 'create' };
  var out = await new Promise(function (resolve) {
    E.handler(req, { setHeader: function () {}, end: function (b) { resolve(JSON.parse(b)); } });
  });
  assert.equal(out.ok, true);
});

test('api: backend failure -> 502 backend-error', async function () {
  var h = API.createHandler({ redis: { exec: async function () { throw new Error('boom'); } } });
  var origErr = console.error; console.error = function () {};
  try {
    var r = await invoke(h, { action: 'create' });
    assert.equal(r.status, 502); assert.equal(r.body.code, 'backend-error');
  } finally { console.error = origErr; }
});

/* ------------------------------------------------------------------ client: vercel backend (in-process fetch) */
function inProcessFetch(handler) {
  return async function (url, init) {
    var raw = init && init.body ? String(init.body) : '';
    var req = Readable.from(raw ? [Buffer.from(raw)] : []);
    req.method = (init && init.method) || 'GET'; req.headers = { host: 'forge.test', 'x-forwarded-for': '127.0.0.1' };
    var aborted = false;
    if (init && init.signal) init.signal.addEventListener('abort', function () { aborted = true; });
    var out = await new Promise(function (resolve) {
      handler(req, { statusCode: 200, setHeader: function () {}, end: function (b) { resolve({ status: this.statusCode, body: b }); } });
    });
    if (aborted) { var e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    return { ok: out.status < 400, status: out.status, json: async function () { return JSON.parse(out.body); } };
  };
}
function until(fn, ms) {
  var t0 = Date.now();
  return new Promise(function (resolve, reject) {
    (function check() { var v = fn(); if (v) return resolve(v); if (Date.now() - t0 > (ms || 3000)) return reject(new Error('timeout')); setTimeout(check, 10); })();
  });
}

test('signal/vercel: create, join, send both ways (batched), close notifies peer', async function () {
  var h = API.createHandler({ redis: API.createMemoryRedis() });
  var f = inProcessFetch(h);
  var host = S.vercel({ fetch: f, wait: 300 }), guest = S.vercel({ fetch: f, wait: 300 });
  var hr = await host.create();
  assert.equal(hr.role, 'host'); assert.match(hr.room, /^[A-Z2-9]{5}$/);
  var hostGot = [], guestGot = [], closed = null;
  host.onMessage(function (from, m) { hostGot.push([from, m]); });
  var gr = await guest.join(hr.room.toLowerCase().slice(0, 2) + '-' + hr.room.toLowerCase().slice(2));
  guest.onMessage(function (from, m) { guestGot.push([from, m]); });
  guest.on('closed', function (e) { closed = e.reason; });
  await Promise.all([guest.send('host', { t: 'join', sid: 'a' }), guest.send('host', { t: 'ice', n: 1 }), guest.send('host', { t: 'ice', n: 2 })]);
  await until(function () { return hostGot.length === 3; });
  assert.deepEqual(hostGot.map(function (x) { return x[1].t; }), ['join', 'ice', 'ice']);
  assert.equal(hostGot[0][0], gr.peer);
  await host.send(gr.peer, { t: 'sdp', type: 'offer' });
  await until(function () { return guestGot.length === 1; });
  assert.equal(guestGot[0][0], 'host');
  await assert.rejects(guest.send('pxxxxxx', {}), function (e) { return e.code === 'forbidden'; });
  await host.close();
  await until(function () { return closed; }, 3000);
  assert.equal(closed, 'host-closed');
  assert.equal(guest.state, 'closed');
});

test('signal/vercel: buffered delivery before the first listener; detect() picks vercel or manual', async function () {
  var h = API.createHandler({ redis: API.createMemoryRedis() });
  var f = inProcessFetch(h);
  assert.equal(await S.detect({ fetch: f }), 'vercel');
  assert.equal(await S.detect({ fetch: inProcessFetch(API.createHandler({ env: {} })) }), 'manual');
  assert.equal(await S.detect({ fetch: async function () { throw new Error('offline'); } }), 'manual');
  var host = S.vercel({ fetch: f, wait: 200 }), guest = S.vercel({ fetch: f, wait: 200 });
  var hr = await host.create(); await guest.join(hr.room);
  await guest.send('host', { t: 'early' });
  await new Promise(function (r) { setTimeout(r, 400); });
  var got = [];
  host.onMessage(function (from, m) { got.push(m.t); });
  await until(function () { return got.length === 1; });
  assert.deepEqual(got, ['early']);
  await guest.close(); await host.close();
});

test('signal/vercel: no-backend and bad codes surface as coded errors', async function () {
  var sig = S.vercel({ fetch: inProcessFetch(API.createHandler({ env: {} })) });
  await assert.rejects(sig.create(), function (e) { return e.code === 'no-backend'; });
  var sig2 = S.vercel({ fetch: inProcessFetch(API.createHandler({ redis: API.createMemoryRedis() })) });
  await assert.rejects(sig2.join('nope'), function (e) { return e.code === 'bad-request'; });
  await assert.rejects(sig2.join('ZZZZZ'), function (e) { return e.code === 'not-found'; });
});

test('signal: normalizeCode', function () {
  assert.equal(S.normalizeCode('ab-cde'), 'ABCDE');
  assert.equal(S.normalizeCode('https://x.vercel.app/#/multiplayer/k7m2q'), 'K7M2Q');
  assert.equal(S.normalizeCode('ABCD'), null);
  assert.equal(S.normalizeCode('ABCD0'), null);
  assert.equal(S.normalizeCode(null), null);
});

/* ------------------------------------------------------------------ client: local (BroadcastChannel) */
test('signal/local: two endpoints over BroadcastChannel', async function () {
  if (typeof BroadcastChannel !== 'function') return;
  var chan = 'forge-test-' + Math.random();
  var host = S.local({ channel: chan }), guest = S.local({ channel: chan, probeTimeout: 500 }), stray = S.local({ channel: chan, probeTimeout: 200 });
  try {
    var hr = await host.create();
    await assert.rejects(stray.join('ZZZZZ'), function (e) { return e.code === 'not-found'; });
    var got = [], gotG = [], closed = null;
    host.onMessage(function (f, m) { got.push([f, m]); });
    var gr = await guest.join(hr.room);
    guest.onMessage(function (f, m) { gotG.push([f, m]); });
    guest.on('closed', function (e) { closed = e.reason; });
    await guest.send('host', { t: 'join', sid: 's' });
    await until(function () { return got.length; });
    assert.deepEqual(got[0], [gr.peer, { t: 'join', sid: 's' }]);
    await host.send(gr.peer, { t: 'sdp', type: 'offer', sdp: 'x' });
    await until(function () { return gotG.length; });
    assert.equal(gotG[0][1].sdp, 'x');
    await host.close();
    await until(function () { return closed; });
    assert.equal(closed, 'host-closed');
  } finally { host.close(); guest.close(); stray.close(); }
});

/* ------------------------------------------------------------------ manual codes */
var CHROME_OFFER = [
  'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  'a=candidate:3402446530 1 udp 2113937151 1f2e3d4c-aaaa-bbbb-cccc-1234567890ab.local 54321 typ host generation 0 network-cost 999',
  'a=ice-ufrag:9Jx+', 'a=ice-pwd:7rKZp5yBvK1Hs0D9b+HbV2Lq', 'a=ice-options:trickle',
  'a=fingerprint:sha-256 6B:8B:5D:EA:59:04:20:23:29:C8:87:1C:CB:3C:0E:4E:3B:5D:7E:92:1A:65:44:CC:1F:2E:6F:03:0B:3E:8D:21',
  'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', ''
].join('\r\n');
var SRFLX = 'candidate:842163049 1 udp 1677729535 203.0.113.7 61000 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag 9Jx+ network-cost 999';

test('manual codec: SDP compaction round-trip keeps every field WebRTC needs', function () {
  var C = S.codec;
  var o = C.compactSdp(CHROME_OFFER, [SRFLX]);
  assert.ok(!o.raw, 'compacted');
  var sdp = C.expandSdp(o);
  ['a=ice-ufrag:9Jx+', 'a=ice-pwd:7rKZp5yBvK1Hs0D9b+HbV2Lq', 'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
    'a=fingerprint:sha-256 6B:8B:5D:EA:59:04:20:23:29:C8:87:1C:CB:3C:0E:4E:3B:5D:7E:92:1A:65:44:CC:1F:2E:6F:03:0B:3E:8D:21',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=group:BUNDLE 0',
    'a=candidate:3402446530 1 udp 2113937151 1f2e3d4c-aaaa-bbbb-cccc-1234567890ab.local 54321 typ host',
    'a=candidate:842163049 1 udp 1677729535 203.0.113.7 61000 typ srflx raddr 0.0.0.0 rport 0'
  ].forEach(function (l) { assert.ok(sdp.indexOf(l + '\r\n') >= 0, 'missing ' + l); });
  // idempotent
  assert.deepEqual(C.compactSdp(sdp), o);
  // odd SDPs fall back to raw
  var weird = C.compactSdp('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n');
  assert.ok(weird.raw);
  assert.equal(C.expandSdp(weird), 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n');
});

test('manual codec: encode/decode round-trip, compact size, checksum catches typos', function () {
  var C = S.codec;
  var obj = { p: 'pabc234', s: 'sid12345', r: 'MABCD', d: C.compactSdp(CHROME_OFFER, [SRFLX]), u: 'ünïcødé ✓' };
  var code = C.encode(obj, 'i');
  assert.match(code, /^FG1i:[A-Za-z0-9\-_]+:[A-Za-z0-9\-_]{2}$/);
  assert.ok(code.length < 700, 'code is compact: ' + code.length);
  assert.ok(code.length < CHROME_OFFER.length + SRFLX.length, 'smaller than the raw SDP');
  assert.deepEqual(C.decode(code), { kind: 'i', data: obj });
  assert.deepEqual(C.decode('  ' + code.slice(0, 40) + '\n' + code.slice(40) + ' ').data, obj, 'whitespace / line breaks tolerated');
  var i = code.indexOf(':') + 10;
  var typo = code.slice(0, i) + (code[i] === 'A' ? 'B' : 'A') + code.slice(i + 1);
  assert.throws(function () { C.decode(typo); }, function (e) { return e.code === 'bad-code'; });
  assert.throws(function () { C.decode(code.slice(0, code.length - 20)); }, function (e) { return e.code === 'bad-code'; });
  assert.throws(function () { C.decode('hello'); }, function (e) { return e.code === 'bad-code'; });
  var bytes = new Uint8Array(256); for (var k = 0; k < 256; k++) bytes[k] = k;
  for (var n = 0; n < 5; n++) assert.deepEqual(Array.from(C.b64d(C.b64e(bytes.subarray(n)))), Array.from(bytes.subarray(n)));
});

test('signal/manual: invite -> join -> answer -> accept carries offer, answer and candidates', async function () {
  var H = S.manual({ gatherTimeout: 1000 }), G = S.manual({ gatherTimeout: 1000 });
  await H.create();
  var hostMsgs = [];
  H.onMessage(function (from, m) {
    hostMsgs.push([from, m]);
    if (m.t === 'join') {
      H.send(from, { t: 'sdp', type: 'offer', sdp: CHROME_OFFER, sid: m.sid });
      H.send(from, { t: 'ice', c: { candidate: SRFLX, sdpMid: '0', sdpMLineIndex: 0 }, sid: m.sid });
      H.send(from, { t: 'ice', c: null, sid: m.sid });
    }
  });
  var codes = [];
  H.on('code', function (e) { codes.push(e.kind); });
  var invite = await H.invite();
  assert.match(invite, /^FG1i:/);
  assert.deepEqual(codes, ['invite']);
  var joinSid = hostMsgs[0][1].sid, guestId = hostMsgs[0][0];
  await assert.rejects(H.accept(invite), function (e) { return e.code === 'bad-code'; });

  var info = await G.join(invite);
  assert.equal(info.peer, guestId); assert.equal(info.role, 'peer');
  var offer = await new Promise(function (resolve) { G.onMessage(function (from, m) { if (m.t === 'sdp') resolve([from, m]); }); });
  assert.equal(offer[0], 'host'); assert.equal(offer[1].type, 'offer'); assert.equal(offer[1].sid, joinSid);
  assert.ok(offer[1].sdp.indexOf('203.0.113.7 61000 typ srflx') > 0, 'trickled candidate folded into the SDP');
  G.send('host', { t: 'join', sid: 'ignored' });
  G.send('host', { t: 'sdp', type: 'answer', sdp: CHROME_OFFER.replace('actpass', 'active'), sid: joinSid });
  G.send('host', { t: 'ice', c: null, sid: joinSid });
  var answer = await G.answer();
  assert.match(answer, /^FG1a:/);
  var pid = await H.accept(answer);
  assert.equal(pid, guestId);
  await until(function () { return hostMsgs.length === 2; });
  assert.equal(hostMsgs[1][0], guestId); assert.equal(hostMsgs[1][1].type, 'answer');
  assert.ok(hostMsgs[1][1].sdp.indexOf('a=setup:active') > 0);
  await H.close(); await G.close();
});

test('signal/manual: gather timeout flushes the code without an end-of-candidates', async function () {
  var H = S.manual({ gatherTimeout: 60 });
  await H.create();
  H.onMessage(function (from, m) { if (m.t === 'join') H.send(from, { t: 'sdp', type: 'offer', sdp: CHROME_OFFER, sid: m.sid }); });
  var t0 = Date.now(), code = await H.invite();
  assert.ok(Date.now() - t0 >= 50);
  assert.equal(S.codec.decode(code).kind, 'i');
  await H.close();
});

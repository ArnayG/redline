/* Latency work on the server-relay fallback and TURN support:
     - js/net/relay.js scheduler: pipelined posts (<= upInFlight, >= upGap apart), latest-state coalescing, rel ordering
       under out-of-order delivery, held long-polls with piggybacked data, firewall / 429 back-off, request budget
     - streamed downlink: dev server (api/signal.js) stream + probe, buffering proxy detection -> long-poll fallback
     - api/signal.php under php -S (PHP_CLI_SERVER_WORKERS=8): mailbox wake latency, NDJSON stream, 'ice' action with
       mocked Cloudflare / Metered APIs (no secret reaches the client, credentials cached, port 53 dropped, TLS 443 added)
     - api/signal.js 'ice' action, CB.net.transport ICE merging / TURN path detection / later relay with TURN,
       phone-wheel one-way latency estimate under clock skew, zip + .htaccess + .gitignore keep turn-config.php private
   Run: node tests/run.js net-relay-latency */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var http = require('http');
var net = require('net');
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
function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[s.length >> 1]; }
function rng(seed) { return function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; }

/* ------------------------------------------------------------------ in-memory "server" with per-leg latency */
function simNet(oneWay, jitter, seed) {
  var boxes = {}, waiters = {}, rnd = rng(seed || 7);
  function leg() { return oneWay + (jitter ? rnd() * jitter : 0); }
  function wake(to) { var w = waiters[to]; if (w && w.length) w.shift()(); }
  function push(to, from, msg) { (boxes[to] = boxes[to] || []).push({ from: from, msg: msg }); wake(to); }
  function sig(me) {
    var s = { state: 'open', peer: me, room: 'SIMUL', caps: { relay: true }, fns: [], st: { open: 0, max: 0, posts: 0, polls: 0, maxPosts: 0, openPosts: 0, starts: [] } };
    s.onMessage = function (fn) { s.fns.push(fn); return function () {}; };
    s.on = function () { return function () {}; };
    s.send = async function (to, m) { push(to, me, m); };
    s.fail = null;   // fn(posts, wait) -> error to throw, or null
    s.exchange = async function (posts, wait, o) {
      var isPoll = wait > 0;
      s.st.open++; s.st.max = Math.max(s.st.max, s.st.open);
      if (isPoll) s.st.polls++; else { s.st.posts++; s.st.openPosts++; s.st.maxPosts = Math.max(s.st.maxPosts, s.st.openPosts); s.st.starts.push(Date.now()); }
      try {
        var e = s.fail && s.fail(posts, wait);
        await sleep(leg());
        if (e) throw e;
        posts.forEach(function (p) { p.msgs.forEach(function (m) { push(p.to, me, m); }); });
        var got = [];
        if (!(o && o.nopoll)) {
          if (!(boxes[me] || []).length && wait) {
            await new Promise(function (r) {
              var q = waiters[me] = waiters[me] || [];
              var done = function () { var i = q.indexOf(done); if (i >= 0) q.splice(i, 1); clearTimeout(t); r(); };
              var t = setTimeout(done, wait);
              q.push(done);
            });
          }
          got = (boxes[me] || []).splice(0);
        }
        await sleep(leg());
        got.forEach(function (m) { s.fns.forEach(function (fn) { fn(m.from, m.msg); }); });
        return got.length;
      } finally { s.st.open--; if (!isPoll) s.st.openPosts--; }
    };
    return s;
  }
  return { sig: sig };
}
function wheelPair(netw, phoneOpts, deskOpts) {
  var desk = netw.sig('host'), phone = netw.sig('pphone1');
  var atDesk = [], atPhone = [];
  var ld = RL.link(desk, 'pphone1', function (ch, x) { atDesk.push([ch, x, Date.now()]); }, deskOpts);
  var lp = RL.link(phone, 'host', function (ch, x) { atPhone.push([ch, x, Date.now()]); }, phoneOpts);
  return { desk: desk, phone: phone, ld: ld, lp: lp, atDesk: atDesk, atPhone: atPhone,
    stop: function () { ld.close(); lp.close(); RL.hub(desk).destroy(); RL.hub(phone).destroy(); } };
}

test('relay pipeline: posts overlap (<= upInFlight), keep >= upGap apart, newest input wins, rel stays ordered', async function () {
  var p = wheelPair(simNet(60, 50, 3), { upGap: 40, upInFlight: 3, downlinks: 0 }, { downlinks: 2, pollGap: 0 });
  var q = 0, b = 0;
  var iv = setInterval(function () { p.lp.send('fast', JSON.stringify({ t: 'in', q: ++q, ts: Date.now() })); }, 16);
  var iv2 = setInterval(function () { p.lp.send('rel', JSON.stringify({ t: 'btn', i: b++ })); }, 70);
  await sleep(1500);
  clearInterval(iv); clearInterval(iv2);
  await until(function () { var f = p.atDesk.filter(function (m) { return m[0] === 'fast'; }); return f.length && JSON.parse(f[f.length - 1][1]).q === q; }, 3000, 'newest input');
  await until(function () { return p.atDesk.filter(function (m) { return m[0] === 'rel'; }).length === b; }, 4000, 'all rel');
  var st = p.phone.st;
  assert.ok(st.maxPosts >= 2 && st.maxPosts <= 3, 'posts in flight at once: ' + st.maxPosts);
  for (var i = 1; i < st.starts.length; i++) assert.ok(st.starts[i] - st.starts[i - 1] >= 30, 'posts >= upGap apart (' + (st.starts[i] - st.starts[i - 1]) + ' ms)');
  assert.ok(st.posts <= 1.5 / 0.04 + 6, 'post count bounded by upGap: ' + st.posts);
  var fq = p.atDesk.filter(function (m) { return m[0] === 'fast'; }).map(function (m) { return JSON.parse(m[1]).q; });
  for (var k = 1; k < fq.length; k++) assert.ok(fq[k] > fq[k - 1], 'fast never goes backwards (late batches dropped): ' + fq.slice(Math.max(0, k - 3), k + 1));
  assert.ok(fq.length < q / 2, 'coalesced: ' + fq.length + ' of ' + q);
  var rels = p.atDesk.filter(function (m) { return m[0] === 'rel'; }).map(function (m) { return JSON.parse(m[1]).i; });
  assert.deepEqual(rels, Array.from({ length: b }, function (_, j) { return j; }), 'rel exactly once, in order, despite jittered legs');
  p.stop();
});

test('relay downlinks: the computer holds 2 long-polls, piggybacks its data, and input arrives in ~2 legs', async function () {
  var p = wheelPair(simNet(50, 0), { upGap: 125, downlinks: 0 }, { downlinks: 2, pollGap: 0, fastFlush: 150 });
  var lat = [], q = 0;
  var iv = setInterval(function () { p.lp.send('fast', JSON.stringify({ t: 'in', q: ++q, ts: Date.now() })); }, 16);
  var iv2 = setInterval(function () { p.ld.send('fast', JSON.stringify({ t: 'tel', spd: q })); }, 100);
  await sleep(800);
  var d0 = p.desk.st.polls + p.desk.st.posts, f0 = p.phone.st.polls + p.phone.st.posts, n0 = p.atDesk.length;
  await sleep(2000);
  clearInterval(iv); clearInterval(iv2);
  p.atDesk.slice(n0).forEach(function (m) { if (m[0] === 'fast') lat.push(m[2] - JSON.parse(m[1]).ts); });
  var deskReq = p.desk.st.polls + p.desk.st.posts - d0, phoneReq = p.phone.st.polls + p.phone.st.posts - f0;
  console.log('    [sim 50 ms/leg] one-way median ' + median(lat) + ' ms · phone ' + (phoneReq / 2) + ' req/s · computer ' + (deskReq / 2) + ' req/s · ' + (lat.length / 2) + ' updates/s');
  assert.ok(median(lat) <= 2 * 50 + 30, 'one-way ~ two legs: ' + median(lat));
  assert.ok(phoneReq / 2 <= 9, 'phone budget ~8 req/s: ' + phoneReq / 2);
  assert.ok(deskReq / 2 <= 10, 'computer budget: ' + deskReq / 2);
  assert.ok(lat.length / 2 >= 6, 'updates/s ' + lat.length / 2);
  assert.ok(RL.hub(p.desk).inFlight().polls === 2, 'two long-polls held');
  assert.ok(p.desk.st.posts <= 3, 'telemetry rode on the re-issued long-polls (' + p.desk.st.posts + ' extra posts)');
  assert.ok(p.atPhone.some(function (m) { return /"tel"/.test(m[1]); }), 'telemetry reached the phone');
  p.stop();
});

test('relay back-off: a firewall 403 page / HTTP 429 slows every request down, then it recovers', async function () {
  var p = wheelPair(simNet(5, 0), { upGap: 40, downlinks: 0 }, { downlinks: 1 });
  var blocked = true;
  p.phone.fail = function () { return blocked ? Object.assign(new Error('blocked by the web host (HTTP 403)'), { code: 'blocked', status: 403 }) : null; };
  var q = 0, iv = setInterval(function () { p.lp.send('fast', JSON.stringify({ t: 'in', q: ++q })); }, 16);
  await sleep(1500);
  var during = p.phone.st.posts + p.phone.st.polls;
  assert.ok(during <= 4, 'requests while blocked in 1.5 s: ' + during + ' (no hammering)');
  assert.ok(RL.hub(p.phone).stats.rateLimited >= 1);
  blocked = false;
  await until(function () { var f = p.atDesk.filter(function (m) { return m[0] === 'fast'; }); return f.length && JSON.parse(f[f.length - 1][1]).q > q - 10; }, 12000, 'recovered delivery');
  clearInterval(iv);
  p.stop();
});

/* ------------------------------------------------------------------ streamed downlink (dev server) */
var srv = null, base = null;
async function server() {
  if (srv) return base;
  srv = DEV.createServer();
  await new Promise(function (r) { srv.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + srv.address().port + '/';
  return base;
}
/** a proxy that buffers whole responses (like a CDN that does not pass streams through) */
async function bufferingFetch(u, init) {
  var r = await fetch(u, init);
  var txt = await r.text();
  return new Response(txt, { status: r.status, headers: r.headers });
}
test('relay stream: probe says "on", the computer gets its mail through one streamed response', async function () {
  var b = await server();
  var host = S.vercel({ url: b + 'api/signal.php', fetch: fetch }), guest = S.vercel({ url: b + 'api/signal.php', fetch: fetch });
  var room = await host.create(); await guest.join(room.room);
  var got = [];
  var ld = RL.link(host, guest.peer, function (ch, x) { got.push([x, Date.now()]); }, { downlinks: 2, pollGap: 0 });
  var lg = RL.link(guest, 'host', function () {}, { upGap: 100 });
  await until(function () { return RL.hub(host).stream === 'on'; }, 3000, 'stream probe');
  for (var i = 0; i < 10; i++) { lg.send('fast', JSON.stringify({ t: 'in', q: i, ts: Date.now() })); await sleep(110); }
  await until(function () { return got.length && JSON.parse(got[got.length - 1][0]).q === 9; }, 3000, 'stream delivery');
  var h = RL.hub(host);
  assert.ok(h.stats.streams >= 1, 'streams ' + h.stats.streams);
  assert.ok(h.inFlight().polls === 0, 'no long-polls while streaming');
  var lat = got.map(function (g) { return g[1] - JSON.parse(g[0]).ts; });
  assert.ok(median(lat) < 60, 'localhost stream latency ' + median(lat));
  ld.close(); lg.close(); h.destroy(); RL.hub(guest).destroy();
  await host.close(); await guest.close();
});
test('relay stream: a buffering proxy is detected and the hub falls back to long-polls (nothing lost)', async function () {
  var b = await server();
  var host = S.vercel({ url: b + 'api/signal.php', fetch: bufferingFetch }), guest = S.vercel({ url: b + 'api/signal.php', fetch: fetch });
  var room = await host.create(); await guest.join(room.room);
  var r = await host.stream({ probe: true });
  assert.deepEqual([r.streamed, r.buffered], [true, true], 'probe through a buffering proxy');
  var got = [];
  var ld = RL.link(host, guest.peer, function (ch, x) { got.push(x); }, { downlinks: 2, pollGap: 0 });
  var lg = RL.link(guest, 'host', function () {});
  await until(function () { return RL.hub(host).stream === 'buffered'; }, 3000, 'buffered verdict');
  lg.send('rel', 'one'); lg.send('rel', 'two');
  await until(function () { return got.length === 2; }, 4000, 'delivery over long-polls');
  assert.deepEqual(got, ['one', 'two']);
  assert.ok(RL.hub(host).inFlight().polls >= 1);
  // an old server: the probe gets plain JSON -> 'unsupported'
  var old = S.vercel({ url: b + 'api/signal.php', fetch: function (u, init) { var bd = JSON.parse(init.body); delete bd.stream; return fetch(u, Object.assign({}, init, { body: JSON.stringify(bd) })); } });
  await old.join(room.room);
  assert.equal((await old.stream({ probe: true })).streamed, false);
  ld.close(); lg.close(); RL.hub(host).destroy(); RL.hub(guest).destroy();
  await host.close(); await guest.close(); await old.close();
});
test('relay stream: cleanup dev server', function () { if (srv) { srv.close(); if (srv.closeAllConnections) srv.closeAllConnections(); srv = null; } });

/* ------------------------------------------------------------------ api/signal.js 'ice' */
function invoke(handler, body, ip) {
  var raw = JSON.stringify(body), req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = { host: 'forge.test', 'content-type': 'application/json', 'x-forwarded-for': ip || '10.0.0.9' };
  return new Promise(function (resolve, reject) {
    var res = { statusCode: 200, headers: {}, headersSent: false, setHeader: function (k, v) { this.headers[k] = v; },
      end: function (b) { this.headersSent = true; resolve({ status: this.statusCode, raw: b, body: b ? JSON.parse(b) : null }); } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
test('api ice (Node): Cloudflare credentials minted server-side, cleaned, cached; the API token never reaches the client', async function () {
  var calls = [];
  var mock = async function (u, init) {
    calls.push({ u: u, auth: init.headers.Authorization });
    return { status: 201, json: async function () { return { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u-short', credential: 'c-short' }] }; } };
  };
  var h = API.createHandler({ redis: API.createMemoryRedis(), fetch: mock, turn: { provider: 'cloudflare', cloudflare: { keyId: 'KEYID123', apiToken: 'SECRET-TOKEN-XYZ' } } });
  var c = (await invoke(h, { action: 'create' })).body;
  var r = await invoke(h, { action: 'ice', room: c.room, token: c.token });
  assert.equal(r.status, 200);
  assert.ok(r.raw.indexOf('SECRET-TOKEN-XYZ') < 0 && r.raw.indexOf('KEYID123') < 0, 'no secret in the response');
  assert.equal(calls.length, 1); assert.equal(calls[0].auth, 'Bearer SECRET-TOKEN-XYZ');
  assert.match(calls[0].u, /\/turn\/keys\/KEYID123\/credentials\/generate-ice-servers$/);
  var turn = r.body.iceServers.filter(function (s) { return s.username; })[0];
  assert.deepEqual(turn, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u-short', credential: 'c-short' }, 'port 53 dropped');
  await invoke(h, { action: 'ice', room: c.room, token: c.token });
  assert.equal(calls.length, 1, 'cached');
  assert.equal((await invoke(h, { action: 'ice', room: c.room, token: 'nope' })).body.code, 'auth', 'needs a room token');
  var none = API.createHandler({ redis: API.createMemoryRedis(), env: {} , turn: undefined });
  var c2 = (await invoke(API.createHandler({ redis: API.createMemoryRedis(), turn: null }), { action: 'create' })).body;
  assert.ok(c2.room); assert.ok(none);
  var plain = API.createHandler({ redis: API.createMemoryRedis(), turn: null });
  var c3 = (await invoke(plain, { action: 'create' })).body;
  assert.deepEqual((await invoke(plain, { action: 'ice', room: c3.room, token: c3.token })).body.iceServers, []);
  // Metered list without TLS: turns:<host>:443 is added; provider failure -> static fallback
  assert.deepEqual(API.cleanIce([{ urls: 'stun:a.relay.metered.ca:80' }, { urls: 'turn:a.relay.metered.ca:443?transport=tcp', username: 'x', credential: 'y' }]).slice(-1)[0],
    { urls: 'turns:a.relay.metered.ca:443?transport=tcp', username: 'x', credential: 'y' });
  var down = API.createHandler({ redis: API.createMemoryRedis(), fetch: async function () { return { status: 500, json: async function () { return {}; } }; },
    turn: { provider: 'metered', metered: { app: 'demo', apiKey: 'K' }, static: [{ urls: 'turn:backup.example:3478', username: 'b', credential: 'c' }] } });
  var c4 = (await invoke(down, { action: 'create' })).body;
  var r4 = await invoke(down, { action: 'ice', room: c4.room, token: c4.token });
  assert.equal(r4.body.provider, 'static'); assert.equal(r4.body.iceServers[0].urls, 'turn:backup.example:3478');
});

/* ------------------------------------------------------------------ transport: ICE + TURN path */
test('transport: server ICE servers are merged in, TURN paths are labelled, the relay waits longer while TURN is tried', async function () {
  var sig = { ice: async function () { return [{ urls: 'turns:t.example:443?transport=tcp', username: 'u', credential: 'c' }]; } };
  var cfg = await T.iceConfigFor(sig, {});
  assert.equal(cfg.iceServers.length, T.DEFAULT_ICE.length + 1);
  assert.equal((await T.iceConfigFor({ ice: function () { return new Promise(function () {}); } }, {})).iceServers.length, T.DEFAULT_ICE.length, 'never hangs (3 s cap)');
  assert.equal((await T.iceConfigFor(sig, { iceServers: [] })).iceServers.length, 0, 'explicit iceServers win');
  function stats(type) {
    var m = new Map();
    m.set('T1', { id: 'T1', type: 'transport', selectedCandidatePairId: 'P1' });
    m.set('P1', { id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', state: 'succeeded' });
    m.set('L1', { id: 'L1', type: 'local-candidate', candidateType: type });
    m.set('R1', { id: 'R1', type: 'remote-candidate', candidateType: 'srflx' });
    return { getStats: async function () { return m; } };
  }
  assert.equal(await T.selectedPath(stats('relay')), 'turn');
  assert.equal(await T.selectedPath(stats('host')), 'direct');
  assert.equal(await T.selectedPath({}), null);
  assert.equal(W.modeText('turn'), 'via TURN'); assert.equal(W.modeText('relay'), 'via server'); assert.equal(W.modeText('direct'), 'direct');
});

/* ------------------------------------------------------------------ phone wheel: one-way delay estimate */
test('wheel latency: the computer estimates one-way input delay through a 5 s clock skew and tells the phone', function () {
  var lb = T.loopback({ latency: 40, pingInterval: 300 });
  var host = lb.host();
  var rx = W.createReceiver(host, { hub: null, now: function () { return lb.now(); } });
  var c = lb.connect({ skew: 5000 });
  var tx = W.createSender(c, { now: function () { return c.now(); }, rateHz: 30 });
  var lat = null; tx.on('lat', function (v) { lat = v; });
  for (var i = 0; i < 300; i++) { tx.tick(c.now()); lb.advance(16); }
  assert.ok(rx.latency() >= 30 && rx.latency() <= 60, 'estimated ' + rx.latency() + ' ms for a 40 ms link');
  assert.match(rx.delayText(), /^~\d+ ms delay$/);
  assert.ok(lat >= 30 && lat <= 60, 'phone got ' + lat);
  assert.equal(tx.latency(), lat);
  assert.ok(rx.latSamples.length > 50 && typeof rx.latSamples[0].ts === 'number');
  assert.equal(W.delayText(null, 300), '~150 ms delay'); assert.equal(W.delayText(null, 0), '— ms');
  rx.close(); host.close();
});

/* ------------------------------------------------------------------ PHP: wake latency, stream, ice (php -S, 8 workers) */
var phpOk = false;
try { phpOk = cp.spawnSync('php', ['-v'], { encoding: 'utf8' }).status === 0; } catch (e) { phpOk = false; }
var phpT = phpOk ? test : test.skip;
var php = null, pbase = null, tmp = null, mock = null, mockHits = [];
function freePort() {
  return new Promise(function (resolve, reject) {
    var s = net.createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', function () { var p = s.address().port; s.close(function () { resolve(p); }); });
  });
}
async function call(body) {
  var r = await fetch(pbase + 'api/signal.php', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  var raw = await r.text();
  try { return { status: r.status, raw: raw, body: JSON.parse(raw) }; } catch (e) { throw new Error('not JSON: ' + raw.slice(0, 400)); }
}
function writeTurn(cfg) {
  fs.writeFileSync(path.join(tmp, 'turn-config.php'), '<?php return json_decode(' + JSON.stringify(JSON.stringify(cfg)).replace(/\$/g, '\\$') + ', true);\n');
}
phpT('php relay: start php -S (8 workers) with a temp data dir, TURN config and a mock provider', async function () {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-lat-'));
  mock = http.createServer(function (req, res) {
    var body = ''; req.on('data', function (c) { body += c; });
    req.on('end', function () {
      mockHits.push({ url: req.url, auth: req.headers.authorization || '', body: body });
      res.setHeader('Content-Type', 'application/json');
      if (/\/cf\/turn\/keys\/KID9\/credentials\/generate-ice-servers$/.test(req.url)) {
        res.statusCode = 201;
        return res.end(JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turn:turn.cloudflare.com:80?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'cf-user', credential: 'cf-pass' }] }));
      }
      if (/^\/metered\/api\/v1\/turn\/credentials\?apiKey=MKEY/.test(req.url)) {
        return res.end(JSON.stringify([{ urls: 'stun:stun.relay.metered.ca:80' }, { urls: 'turn:global.relay.metered.ca:80', username: 'm-user', credential: 'm-pass' }, { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'm-user', credential: 'm-pass' }]));
      }
      res.statusCode = 401; res.end('{"error":"bad key"}');
    });
  });
  await new Promise(function (r) { mock.listen(0, '127.0.0.1', r); });
  var port = await freePort();
  php = cp.spawn('php', ['-S', '127.0.0.1:' + port, '-t', root], {
    env: Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '8', FORGE_SIGNAL_DATA: path.join(tmp, 'data'), FORGE_TURN_CONFIG: path.join(tmp, 'turn-config.php') }), stdio: 'ignore', detached: true
  });
  php.unref();
  pbase = 'http://127.0.0.1:' + port + '/';
  for (var i = 0; i < 80; i++) { try { if ((await fetch(pbase + 'api/signal.php')).status === 200) break; } catch (e) { await sleep(100); } }
  var st = (await call({ action: 'status' })).body;
  assert.equal(st.backend, 'php'); assert.equal(st.stream, true); assert.equal(st.ice, true);
});
phpT('php relay: a parked long-poll wakes within a few ms of the post (cheap 10 ms stat checks)', async function () {
  var h = (await call({ action: 'create' })).body, g = (await call({ action: 'join', room: h.room })).body;
  var wake = [];
  for (var i = 0; i < 8; i++) {
    var poll = call({ action: 'relay', room: h.room, token: h.token, posts: [], wait: 3000 }).then(function (r) { return { at: Date.now(), n: r.body.msgs.length }; });
    await sleep(250);
    await call({ action: 'relay', room: h.room, token: g.token, posts: [{ to: 'host', msgs: [{ t: 'x', i: i }] }], nopoll: true });
    var done = Date.now(), p = await poll;
    assert.equal(p.n, 1);
    wake.push(p.at - done);
  }
  console.log('    [php wake] after the post returns: median ' + median(wake) + ' ms, max ' + Math.max.apply(null, wake) + ' ms (was a 50 ms poll step)');
  assert.ok(median(wake) <= 20, 'median wake ' + median(wake));
  await call({ action: 'close', room: h.room, token: h.token });
});
phpT('php relay: NDJSON stream flushes each message as it arrives; probe touches no mailbox', async function () {
  var h = (await call({ action: 'create' })).body, g = (await call({ action: 'join', room: h.room })).body;
  var hs = S.vercel({ url: pbase + 'api/signal.php', fetch: fetch });
  await hs.join(h.room);   // a second guest login just to get a signal object; use the raw token for the host below
  var r = await fetch(pbase + 'api/signal.php', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'relay', room: h.room, token: h.token, posts: [], stream: 1, wait: 2500 }) });
  assert.match(r.headers.get('content-type'), /ndjson/);
  var reader = r.body.getReader(), dec = new TextDecoder(), buf = '', lines = [], t0 = Date.now();
  var poster = (async function () {
    for (var i = 0; i < 3; i++) { await sleep(400); await call({ action: 'relay', room: h.room, token: g.token, posts: [{ to: 'host', msgs: [{ t: 'm', i: i, ts: Date.now() }] }], nopoll: true }); }
  })();
  for (;;) {
    var c = await reader.read();
    if (c.done) break;
    buf += dec.decode(c.value, { stream: true });
    var k; while ((k = buf.indexOf('\n')) >= 0) { var ln = buf.slice(0, k).trim(); buf = buf.slice(k + 1); if (ln) lines.push([JSON.parse(ln), Date.now()]); }
  }
  await poster;
  var msgs = lines.filter(function (l) { return l[0].m; });
  assert.equal(lines[0][0].stream, 1); assert.ok(lines[lines.length - 1][0].end);
  assert.deepEqual(msgs.map(function (l) { return l[0].m[0].msg.i; }), [0, 1, 2], 'one line per message, in order');
  msgs.forEach(function (l) { assert.ok(l[1] - l[0].m[0].msg.ts < 60, 'line arrived ' + (l[1] - l[0].m[0].msg.ts) + ' ms after its post'); });
  assert.ok(lines[lines.length - 1][1] - t0 >= 2000, 'stream stays open for its wait');
  // probe: timing only, mailbox untouched
  await call({ action: 'relay', room: h.room, token: g.token, posts: [{ to: 'host', msgs: [{ t: 'keep' }] }], nopoll: true });
  var pr = await hs.stream({ probe: true });
  assert.deepEqual([pr.streamed, pr.buffered], [true, false], 'php -S passes the stream through');
  assert.deepEqual((await call({ action: 'relay', room: h.room, token: h.token, wait: 0 })).body.msgs.map(function (m) { return m.msg.t; }), ['keep']);
  await hs.close();
  await call({ action: 'close', room: h.room, token: h.token });
});
phpT('php ice: Cloudflare / Metered keys stay on the server; credentials are cleaned, cached and fall back', async function () {
  var h = (await call({ action: 'create' })).body;
  function ice() { return call({ action: 'ice', room: h.room, token: h.token }); }
  var r = await ice();
  assert.deepEqual([r.body.iceServers, r.body.provider], [[], 'none'], 'no config file -> no TURN');
  var mb = 'http://127.0.0.1:' + mock.address().port;
  writeTurn({ provider: 'cloudflare', cloudflare: { keyId: 'KID9', apiToken: 'CF-SECRET-123', baseUrl: mb + '/cf', ttl: 7200 } });
  r = await ice();
  assert.equal(r.body.provider, 'cloudflare');
  assert.ok(r.raw.indexOf('CF-SECRET-123') < 0 && r.raw.indexOf('KID9') < 0, 'no secret reaches the browser');
  var t = r.body.iceServers.filter(function (s) { return s.username; })[0];
  assert.deepEqual(t.urls, ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:80?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'], 'port 53 dropped, TLS 443 kept');
  assert.equal(t.username, 'cf-user');
  assert.ok(r.body.ttl > 0 && r.body.ttl <= 3600);
  var hit = mockHits.filter(function (x) { return /\/cf\//.test(x.url); });
  assert.equal(hit.length, 1); assert.equal(hit[0].auth, 'Bearer CF-SECRET-123'); assert.equal(JSON.parse(hit[0].body).ttl, 7200);
  await ice();
  assert.equal(mockHits.filter(function (x) { return /\/cf\//.test(x.url); }).length, 1, 'cached server-side');
  writeTurn({ provider: 'metered', metered: { app: 'demo', apiKey: 'MKEY', baseUrl: mb + '/metered' } });
  r = await ice();
  assert.equal(r.body.provider, 'metered');
  assert.ok(r.raw.indexOf('MKEY') < 0);
  assert.deepEqual(r.body.iceServers[r.body.iceServers.length - 1], { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'm-user', credential: 'm-pass' }, 'TURN over TLS on 443 added for campus firewalls');
  writeTurn({ provider: 'metered', metered: { app: 'demo', apiKey: 'WRONG', baseUrl: mb + '/metered' }, static: [{ urls: ['turn:backup.example:3478'], username: 'b', credential: 'c' }] });
  r = await ice();
  assert.equal(r.body.provider, 'static'); assert.equal(r.body.iceServers[0].urls, 'turn:backup.example:3478');
  // files in the data folder are guarded, and nothing in it carries an API key
  var dataDir = path.join(tmp, 'data');
  fs.readdirSync(dataDir).filter(function (f) { return /\.php$/.test(f); }).forEach(function (f) {
    var txt = fs.readFileSync(path.join(dataDir, f), 'utf8');
    assert.equal(txt.indexOf('<?php exit; ?>'), 0, f);
    assert.ok(txt.indexOf('CF-SECRET-123') < 0 && txt.indexOf('MKEY') < 0 && txt.indexOf('WRONG') < 0, f + ' holds no key');
  });
  assert.equal((await call({ action: 'ice', room: h.room, token: 'bad' })).body.code, 'auth');
  await call({ action: 'close', room: h.room, token: h.token });
});
phpT('php relay: rate limits match api/signal.js', function () {
  var src = fs.readFileSync(path.join(root, 'api', 'signal.php'), 'utf8');
  ['relayPerIp', 'ratePerIp', 'icePerIp', 'relayPosts', 'relayMsgs'].forEach(function (k) {
    var m = new RegExp("'" + k + "' => (\\d+)").exec(src);
    assert.ok(m, k); assert.equal(Number(m[1]), API.LIMITS[k], k);
  });
});
phpT('php relay: cleanup', function () {
  if (php) { try { process.kill(-php.pid, 'SIGKILL'); } catch (e) { try { php.kill('SIGKILL'); } catch (e2) { /* ignore */ } } php = null; }
  if (mock) { mock.close(); mock = null; }
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } tmp = null; }
});

/* ------------------------------------------------------------------ keys stay private: git, zip, .htaccess */
test('turn-config.php: ignored by git, never packed into the zip (so re-uploads keep it), denied by .htaccess', function () {
  var gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n').map(function (l) { return l.trim(); });
  assert.ok(gi.indexOf('api/turn-config.php') >= 0);
  var Z = require(path.join(root, 'tools', 'build-zip.js'));
  var real = path.join(root, 'api', 'turn-config.php'), made = false;
  if (!fs.existsSync(real)) { fs.writeFileSync(real, "<?php return array('provider' => 'none');\n"); made = true; }
  var out = path.join(os.tmpdir(), 'redline-turn-zip-' + process.pid + '.zip');
  try {
    Z.build({ out: out });
    var names = Z.readZip(fs.readFileSync(out)).map(function (e) { return e.name; });
    assert.ok(names.some(function (n) { return /\/api\/turn-config\.example\.php$/.test(n); }), 'template shipped');
    assert.ok(!names.some(function (n) { return /\/api\/turn-config\.php$/.test(n); }), 'keys file never shipped');
  } finally { if (made) fs.unlinkSync(real); try { fs.unlinkSync(out); } catch (e) { /* ignore */ } }
  var ht = fs.readFileSync(path.join(root, '.htaccess'), 'utf8');
  assert.match(ht, /<FilesMatch "\^\(turn-config\|_config\)\(\\\.example\)\?\\\.php\$">/);
  var ex = fs.readFileSync(path.join(root, 'api', 'turn-config.example.php'), 'utf8');
  assert.match(ex, /'apiToken' => ''/); assert.match(ex, /'apiKey' => ''/);
});

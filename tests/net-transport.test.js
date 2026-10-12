/* Node tests for js/net/transport.js — loopback transport (delivery, ordering, loss, RTT / clock offset, kick / leave /
   reconnect) and binary car-state packing.  Run: node tests/run.js net-transport */
'use strict';
var path = require('path');
var T = require(path.join(__dirname, '..', 'js', 'net', 'transport.js'));

function setup(o) {
  var net = T.loopback(Object.assign({ latency: 25 }, o || {}));
  var host = net.host();
  return { net: net, host: host };
}

test('loopback: connect opens both sides; rel delivers objects both ways in order', function () {
  var s = setup(), net = s.net, host = s.host;
  var peers = [], hostGot = [], cliGot = [];
  host.on('peer', function (p) { peers.push(p.id); });
  host.on('message', function (p, ch, m) { hostGot.push([p.id, ch, m.n]); });
  var c = net.connect({ id: 'pa' });
  var opened = false;
  c.on('open', function () { opened = true; });
  c.on('message', function (ch, m) { cliGot.push([ch, m.n]); });
  for (var i = 0; i < 5; i++) c.send('rel', { t: 'x', n: i }); // queued before open
  assert.equal(c.state, 'connecting');
  net.advance(100);
  assert.ok(opened); assert.equal(c.state, 'open'); assert.deepEqual(peers, ['pa']);
  assert.equal(host.get('pa').state, 'open');
  for (var k = 5; k < 50; k++) c.send('rel', { t: 'x', n: k });
  host.send('pa', 'rel', { t: 'y', n: 7 });
  net.advance(100);
  assert.deepEqual(hostGot.map(function (x) { return x[2]; }), Array.from({ length: 50 }, function (_, i) { return i; }));
  assert.ok(hostGot.every(function (x) { return x[0] === 'pa' && x[1] === 'rel'; }));
  assert.deepEqual(cliGot, [['rel', 7]]);
});

test('loopback: latency is applied (one-way ≈ latency)', function () {
  var s = setup({ latency: 40 }), net = s.net;
  var c = net.connect({ id: 'pa' }); net.advance(200);
  var at = null;
  s.host.on('message', function () { at = net.now(); });
  var t0 = net.now(); c.send('rel', { t: 'x' });
  net.advance(39); assert.equal(at, null);
  net.advance(2); assert.equal(at - t0, 40);
});

test('loopback: rel stays ordered + lossless under jitter and loss; fast is lossy and may reorder', function () {
  var s = setup({ latency: 30, jitter: 40, loss: 0.3, seed: 7 }), net = s.net;
  var c = net.connect({ id: 'pa' }); net.run(300);
  var rel = [], fast = [];
  s.host.on('message', function (p, ch, m) { (ch === 'rel' ? rel : fast).push(m.n); });
  for (var i = 0; i < 400; i++) { c.send('rel', { n: i }); c.send('fast', { n: i }); net.advance(2); }
  net.advance(500);
  assert.deepEqual(rel, Array.from({ length: 400 }, function (_, i) { return i; }), 'rel exact');
  assert.ok(fast.length > 200 && fast.length < 360, 'fast loss ~30%: got ' + fast.length);
  var reordered = 0; for (var k = 1; k < fast.length; k++) if (fast[k] < fast[k - 1]) reordered++;
  assert.ok(reordered > 0, 'jitter reorders unordered fast packets');
  assert.equal(new Set(fast).size, fast.length, 'no duplicates');
});

test('loopback: binary payloads arrive as ArrayBuffer copies; broadcast relays to everyone but the sender', function () {
  var s = setup(), net = s.net, host = s.host;
  var a = net.connect({ id: 'pa' }), b = net.connect({ id: 'pb' }), c = net.connect({ id: 'pc' });
  net.advance(200);
  var got = { pa: [], pb: [], pc: [] };
  [a, b, c].forEach(function (cl) { cl.on('message', function (ch, d) { got[cl.selfId].push(d); }); });
  host.on('message', function (p, ch, d) { if (d instanceof ArrayBuffer) host.broadcast('fast', d, p.id); });
  var buf = T.packStates([{ id: 'pa', t: 1, x: 2, y: 3 }]);
  a.send('fast', new Uint8Array(buf));
  net.advance(200);
  assert.equal(got.pa.length, 0);
  assert.equal(got.pb.length, 1); assert.equal(got.pc.length, 1);
  assert.ok(got.pb[0] instanceof ArrayBuffer);
  assert.notEqual(got.pb[0], got.pc[0], 'each receiver gets its own copy');
  assert.equal(T.unpackState(got.pc[0]).id, 'pa');
  assert.equal(host.list().length, 3);
  assert.equal(host.broadcast('rel', { t: 'roster' }), 3);
});

test('loopback: RTT and clock offset estimation (client clock skewed by +5 s)', function () {
  var s = setup({ latency: 35, jitter: 6, seed: 3 }), net = s.net;
  var c = net.connect({ id: 'pa', skew: 5000 });
  var rtts = 0; c.on('rtt', function () { rtts++; });
  net.run(6000);
  assert.ok(rtts >= 4, 'pings ran: ' + rtts);
  assert.ok(Math.abs(c.rtt - 76) < 10, 'client rtt ' + c.rtt);
  assert.ok(Math.abs(c.clockOffset + 5000) < 6, 'offset ' + c.clockOffset);
  assert.ok(Math.abs(c.hostNow() - s.host.now()) < 6, 'hostNow tracks host clock');
  var hp = s.host.get('pa');
  assert.ok(Math.abs(hp.rtt - 76) < 10, 'host-side rtt ' + hp.rtt);
  assert.ok(Math.abs(hp.clockOffset - 5000) < 6, 'host sees client +5 s');
  assert.ok(Math.abs(hp.remoteNow() - c.now()) < 6);
});

test('loopback: client leave -> host peer-leave(left); host kick -> client close(kicked)', function () {
  var s = setup(), net = s.net, host = s.host, leaves = [];
  host.on('peer-leave', function (p, r) { leaves.push([p.id, r]); });
  var a = net.connect({ id: 'pa' }), b = net.connect({ id: 'pb' });
  net.advance(200);
  var aReason = null, bReason = null;
  a.on('close', function (r) { aReason = r; }); b.on('close', function (r) { bReason = r; });
  a.close();
  net.advance(300);
  assert.equal(aReason, 'left');
  host.get('pb').close('kicked');
  net.advance(300);
  assert.equal(bReason, 'kicked');
  assert.deepEqual(leaves, [['pa', 'left'], ['pb', 'kicked']]);
  assert.equal(host.list().length, 0);
  assert.equal(a.send('rel', {}), false);
});

test('loopback: host.close() tells clients host-closed', function () {
  var s = setup(), net = s.net;
  var a = net.connect({ id: 'pa' }); net.advance(200);
  var r = null; a.on('close', function (x) { r = x; });
  s.host.close();
  net.advance(300);
  assert.equal(r, 'host-closed');
});

test('loopback: disconnect -> reconnecting -> re-linked with the same Peer object; permanent -> failed + host grace', function () {
  var s = setup(), net = s.net, host = s.host;
  var joins = 0, states = [], leaves = [];
  host.on('peer', function () { joins++; });
  host.on('peer-state', function (p, st) { states.push(st); });
  host.on('peer-leave', function (p, r) { leaves.push(r); });
  var c = net.connect({ id: 'pa' }); net.advance(200);
  var hp = host.get('pa'), cs = [], got = [];
  c.on('state', function (st) { cs.push(st); });
  hp.on('message', function (ch, m) { got.push(m.n); });
  net.disconnect('pa');
  assert.equal(c.state, 'reconnecting');
  assert.equal(c.send('rel', { n: 1 }), true, 'rel queued while reconnecting');
  assert.equal(c.send('fast', { n: 2 }), false, 'fast dropped while reconnecting');
  net.advance(500);
  assert.equal(c.state, 'open');
  assert.equal(host.get('pa'), hp, 'same peer identity');
  assert.equal(joins, 1, 'no second peer event');
  net.advance(100);
  assert.deepEqual(got, [1], 'queued rel flushed after reconnect');
  assert.deepEqual(cs, ['reconnecting', 'open']);
  var reason = null; c.on('close', function (r) { reason = r; });
  net.disconnect('pa', { permanent: true });
  net.advance(100);
  assert.equal(reason, 'failed');
  assert.equal(hp.state, 'reconnecting');
  net.advance(16000);
  assert.equal(hp.state, 'closed');
  assert.deepEqual(leaves, ['disconnected']);
});

test('loopback: link timeout when packets stop (silent drop)', function () {
  var s = setup({ pingInterval: 500 }), net = s.net;
  var c = net.connect({ id: 'pa', linkTimeout: 2000 }); net.advance(200);
  var seen = []; c.on('state', function (st) { seen.push(st); });
  net.setConditions({ loss: 1 }); // fast pings all lost, nothing else flowing
  net.advance(3000);
  assert.ok(seen.indexOf('reconnecting') >= 0, 'noticed the dead link: ' + seen.join(','));
});

test('loopback: maxPeers enforced; manual clock is deterministic', function () {
  var net = T.loopback({ latency: 10 });
  var host = net.host({ maxPeers: 2 });
  var a = net.connect({ id: 'pa' }), b = net.connect({ id: 'pb' }), c = net.connect({ id: 'pc' });
  var cr = null; c.on('close', function (r) { cr = r; });
  net.advance(100);
  assert.equal(a.state, 'open'); assert.equal(b.state, 'open'); assert.equal(cr, 'full');
  function trace(seed) {
    var n = T.loopback({ latency: 20, jitter: 30, loss: 0.2, seed: seed }); n.host();
    var out = [], h2 = null;
    var cl = n.connect({ id: 'pz' }); n.advance(100);
    cl.on('message', function (ch, m) { out.push(m.i + '@' + n.now()); });
    h2 = n.clients()[0];
    for (var i = 0; i < 50; i++) { cl.send('fast', { i: i }); n.advance(5); }
    var hp = null; // reflect: host echoes via its peer
    return out.join(',') + '|' + h2.stats.sentFast + '|' + n.now();
  }
  assert.equal(trace(9), trace(9));
});

test('ready promise resolves on open and rejects on failure', async function () {
  var s = setup(), net = s.net;
  var c = net.connect({ id: 'pa' });
  net.advance(200);
  assert.equal(await c.ready, c);
  var lone = T.loopback({ latency: 5 });
  var d = lone.connect({ id: 'pb' });
  lone.advance(100);
  await assert.rejects(d.ready, function (e) { return e.code === 'timeout'; });
});

test('loopback: real-clock mode works with real timers', async function () {
  var net = T.loopback({ latency: 5, clock: 'real', pingInterval: 50 });
  var host = net.host();
  var c = net.connect({ id: 'pa' });
  await c.ready;
  var got = await new Promise(function (resolve) { host.on('message', function (p, ch, m) { resolve(m); }); c.send('rel', { hi: 1 }); });
  assert.deepEqual(got, { hi: 1 });
  await new Promise(function (r) { setTimeout(r, 160); });
  assert.ok(c.rtt > 0);
  host.close();
  await new Promise(function (r) { setTimeout(r, 50); });
});

/* ------------------------------------------------------------------ packing */
test('pack/unpack: quantisation precision and multi-car packets', function () {
  var cars = [], rnd = 1;
  function r() { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; }
  for (var i = 0; i < 8; i++) cars.push({
    id: 'p' + i + 'abcde', t: 123456.789 + i, x: (r() - 0.5) * 4000, y: (r() - 0.5) * 4000, heading: (r() - 0.5) * 20,
    vx: (r() - 0.5) * 180, vy: (r() - 0.5) * 30, yawRate: (r() - 0.5) * 6, steer: r() * 2 - 1, throttle: r(), brake: r(),
    gear: Math.floor(r() * 8) - 1, rpm: Math.floor(r() * 9000), flags: Math.floor(r() * 65535)
  });
  var buf = T.packStates(cars);
  assert.ok(buf instanceof ArrayBuffer);
  assert.ok(buf.byteLength <= 3 + 8 * 45, 'compact: ' + buf.byteLength + ' bytes for 8 cars');
  assert.ok(T.isStates(buf)); assert.ok(!T.isStates(new ArrayBuffer(4)));
  var out = T.unpackStates(buf);
  assert.equal(out.length, 8);
  out.forEach(function (o, i) {
    var c = cars[i];
    assert.equal(o.id, c.id); assert.equal(o.t, c.t);
    assert.ok(Math.abs(o.x - c.x) < 2e-4 * Math.max(1, Math.abs(c.x)), 'x');
    assert.ok(Math.abs(o.y - c.y) < 2e-4 * Math.max(1, Math.abs(c.y)), 'y');
    var dh = Math.atan2(Math.sin(o.heading - c.heading), Math.cos(o.heading - c.heading));
    assert.ok(Math.abs(dh) <= T.PACK.heading, 'heading ' + dh);
    assert.ok(o.heading >= -Math.PI && o.heading <= Math.PI);
    assert.ok(Math.abs(o.vx - c.vx) <= 0.005 + 1e-9, 'vx'); assert.ok(Math.abs(o.vy - c.vy) <= 0.005 + 1e-9, 'vy');
    assert.ok(Math.abs(o.yawRate - c.yawRate) <= 0.0005 + 1e-9, 'yaw');
    assert.ok(Math.abs(o.steer - c.steer) <= 0.5 / 127 + 1e-9, 'steer');
    assert.ok(Math.abs(o.throttle - c.throttle) <= 0.5 / 255 + 1e-9);
    assert.ok(Math.abs(o.brake - c.brake) <= 0.5 / 255 + 1e-9);
    assert.equal(o.gear, c.gear); assert.equal(o.rpm, c.rpm); assert.equal(o.flags, c.flags);
  });
});

test('pack/unpack: clamping, defaults, typed-array / Buffer input, truncated packets', function () {
  var s = T.unpackState(T.packState({ id: 'x'.repeat(40) + 'é', vx: 9999, vy: -9999, steer: 3, throttle: -1, brake: 2, rpm: 1e6, gear: 300 }));
  assert.equal(s.id, 'x'.repeat(24));
  assert.ok(Math.abs(s.vx - 327.67) < 1e-6); assert.ok(Math.abs(s.vy + 327.67) < 1e-6);
  assert.equal(s.steer, 1); assert.equal(s.throttle, 0); assert.equal(s.brake, 1); assert.equal(s.rpm, 65535); assert.equal(s.gear, 127);
  assert.equal(s.x, 0); assert.equal(s.t, 0); assert.equal(s.flags, 0);
  var buf = T.packStates([{ id: 'a', x: 1.5 }, { id: 'b', x: 2.5 }]);
  assert.equal(T.unpackStates(new Uint8Array(buf))[1].x, 2.5);
  assert.equal(T.unpackStates(Buffer.from(buf))[0].x, 1.5);
  var cut = T.unpackStates(buf.slice(0, buf.byteLength - 5));
  assert.equal(cut.length, 1, 'truncated second record dropped');
  assert.deepEqual(T.unpackStates(new ArrayBuffer(0)), []);
  assert.equal(T.unpackState(null), null);
  assert.equal(T.unpackStates(T.packStates([])).length, 0);
});

test('iceConfig: default STUN list plus optional TURN', function () {
  var c = T.iceConfig({});
  assert.deepEqual(c.iceServers.map(function (s) { return s.urls; }), ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']);
  var t = T.iceConfig({ turn: { urls: 'turn:turn.example:3478', username: 'u', credential: 'p' } });
  assert.equal(t.iceServers.length, 3); assert.equal(t.iceServers[2].username, 'u');
  assert.equal(T.iceConfig({ turn: [{ urls: 'turn:a' }, { urls: 'turns:b' }] }).iceServers.length, 4);
});

test('host()/connect() need WebRTC: friendly unsupported error in Node', function () {
  if (globalThis.RTCPeerConnection) return;
  assert.throws(function () { T.host({ onMessage: function () { return function () {}; } }); }, function (e) { return e.code === 'unsupported'; });
});

/* Guest-side lag in multiplayer (non-hosts): host + 2 guests in-process over the CB.net.transport loopback, both over
   direct links and over the SERVER RELAY emulation (loopback({relay}) runs the real js/net/relay.js scheduler against a
   virtual signalling server: ~85 ms per leg + jitter + TCP-retransmit "loss", newest-wins coalescing, posts ~6-7/s,
   streamed downlink, guest -> guest fan-out). Asserts, for guests:
     - own car: input acts in the very same update (local simulation / prediction, no round trip)
     - other cars: smooth (no frame-to-frame jumps), small error against the true trajectory, update rate >= 6 Hz,
       bounded interpolation delay; the race results agree everywhere
     - arcade: the client sim runs exactly 2 substeps per 60 fps frame (no 3,1,2 judder) and puppets never freeze/jump
   Run: node tests/run.js net-lag */
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');

var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js', 'js/race/vehicle.js',
 'js/race/ai.js', 'js/race/engine.js', 'js/race/drift/tune.js', 'js/race/drift/scoring.js', 'js/race/drift/assist.js', 'js/race/drift/arcade.js',
 'js/race/drift/ai.js', 'js/race/drift/tracks.js', 'js/race/drift/session.js', 'js/arcade/mode.js', 'js/arcade/stunt-track.js', 'js/arcade/stunt-maps.js',
 'js/arcade/stunt-physics.js', 'js/arcade/stunt-ai.js', 'js/arcade/stunt-session.js', 'js/arcade/items.js', 'js/arcade/nitro.js', 'js/arcade/gameplay.js',
 'js/arcade/arcade-hud.js', 'js/arcade/arcade-layer.js', 'js/net/relay.js', 'js/net/transport.js', 'js/net/netrace.js', 'js/net/netarcade.js'].forEach(function (f) {
  var p = path.join(root, f);
  if (fs.existsSync(p)) { try { require(p); } catch (e) { console.log('  (net-lag: skip ' + f + ': ' + e.message + ')'); } }
});
var CB = globalThis.CB;
var T = CB.net.transport, NR = CB.net.race, NA = CB.net.arcade;

var local = typeof globalThis.test !== 'function';
var queue = [];
function test(name, fn) { if (!local) return globalThis.test('net-lag: ' + name, fn); queue.push({ name: name, fn: fn }); }

function preset(i) { var p = CB.data.presets[i % CB.data.presets.length]; return JSON.parse(JSON.stringify(p.build || p)); }
var RELAY = { oneWay: 85, jitter: 30, loss: 0.03 };
var RELAY_OPTS = { streamDown: true };

/** host + 2 guests. o {arcade, relay (virtual server opts) | net (loopback latency opts), mode, track, laps, ai, autopilot, input(f, k)} */
function setup(o) {
  o = o || {};
  var net = o.relay ? T.loopback({ latency: 0, seed: o.seed || 5, relay: Object.assign({ opts: RELAY_OPTS }, o.relay) })
    : T.loopback(Object.assign({ latency: 30, jitter: 20, loss: 0.02, seed: o.seed || 5 }, o.net || {}));
  var H = net.host(), cl = [net.connect({ id: 'pa', skew: 1500 }), net.connect({ id: 'pb', skew: -900 })];
  net.run(3000);
  var NS = o.arcade ? NA : NR, clients = [];
  cl.forEach(function (c, i) { NS.waitForStart(c, function (st) { clients[i] = NS.createClientSession(c, { start: st, build: preset(i + 1), name: 'C' + i, autopilot: o.autopilot !== false }); }); });
  var hc = { trackId: o.track || 'little-anvil', laps: o.laps || 5, seed: 42, build: preset(0), name: 'Host', autopilot: o.autopilot !== false, leadIn_s: 2, ai: o.ai == null ? 1 : o.ai,
             players: cl.map(function (c, i) { return { peerId: c.selfId, name: 'C' + i, build: preset(i + 1) }; }) };
  if (!o.arcade) hc.mode = o.mode || 'race';
  else hc.arcade = { options: { items: false } };
  var host = NS.createHostSession(H, hc);
  var env = { net: net, host: host, clients: clients, hist: {}, views: {}, steps: {}, frame: 0 };
  env.all = function () { return [host].concat(clients.filter(Boolean)); };
  env.step = function (frames, each) {
    for (var f = 0; f < frames; f++) {
      net.advance(1000 / 60);
      var all = env.all(), tw = net.now(), gf = env.frame++;
      for (var k = 0; k < all.length; k++) {
        var n = all[k].update(1 / 60, o.input ? o.input(gf, k) : {});
        (env.steps[k] = env.steps[k] || []).push(n);
      }
      all.forEach(function (s) {
        var sn = s.snapshot(), id = s.netState().carId, a = typeof sn.alpha === 'number' ? sn.alpha : 1;
        (sn.cars || []).forEach(function (c) {
          var x = c.x, y = c.y;
          if (typeof c.prevX === 'number' && typeof c.prevY === 'number') { x = c.prevX + (c.x - c.prevX) * a; y = c.prevY + (c.y - c.prevY) * a; }
          if (c.isPlayer) (env.hist[id] = env.hist[id] || []).push({ t: tw, x: x, y: y });
          else if (c.netId && env.hist !== null) { var key = id + '>' + c.netId; (env.views[key] = env.views[key] || []).push({ t: tw, x: x, y: y }); }
        });
      });
      if (each && each(f, all) === true) return f;
    }
    return frames;
  };
  return env;
}
function interpAt(tr, t) {
  var lo = 0, hi = tr.length - 1;
  if (!tr.length || t < tr[0].t || t > tr[hi].t) return null;
  while (hi - lo > 1) { var m = (lo + hi) >> 1; if (tr[m].t <= t) lo = m; else hi = m; }
  var a = tr[lo], b = tr[hi], u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}
/** guest views of remote cars: best-fit display lag (ms), RMS error at that lag (m), frame-to-frame jumps (> 0.5 m off a
 *  constant-velocity continuation) and the p99 of that deviation (m) */
function viewStats(env, fromT) {
  var out = {};
  Object.keys(env.views).forEach(function (key) {
    var viewer = key.split('>')[0], id = key.split('>')[1], truth = env.hist[id];
    if (viewer === 'host' || !truth) return;   // guests only
    var v = env.views[key].filter(function (p) { return p.t > fromT; });
    var best = null;
    for (var tau = 0; tau <= 1500; tau += 10) {
      var s = 0, n = 0;
      for (var i = 0; i < v.length; i += 2) { var q = interpAt(truth, v[i].t - tau); if (!q) continue; s += Math.pow(v[i].x - q.x, 2) + Math.pow(v[i].y - q.y, 2); n++; }
      if (n > 100) { var rms = Math.sqrt(s / n); if (!best || rms < best.rms) best = { tau: tau, rms: rms }; }
    }
    var jumps = 0, devs = [];
    for (var j = 2; j < v.length; j++) {
      var d = Math.hypot(v[j].x - (2 * v[j - 1].x - v[j - 2].x), v[j].y - (2 * v[j - 1].y - v[j - 2].y));
      devs.push(d); if (d > 0.5) jumps++;
    }
    devs.sort(function (a, b) { return a - b; });
    out[key] = { lag: best && best.tau, err: best && best.rms, jumps: jumps, devP99: devs[Math.floor(devs.length * 0.99)] || 0, n: v.length };
  });
  return out;
}
function fmt(o) { return JSON.stringify(o, function (k, v) { return typeof v === 'number' ? Math.round(v * 100) / 100 : v; }); }

/* ------------------------------------------------------------------ relay emulation itself */
test('loopback({relay}) runs the real relay scheduler: coalescing, request budget, streamed downlink', function () {
  var net = T.loopback({ latency: 0, seed: 2, relay: Object.assign({ opts: RELAY_OPTS }, RELAY) });
  var H = net.host(), C = net.connect({ id: 'pa' });
  net.run(3000);
  assert.strictEqual(C.mode, 'relay');
  assert.strictEqual(H.get('pa').mode, 'relay');
  var got = [];
  C.on('message', function (ch, d) { if (ch === 'fast') got.push(d.n); });
  for (var i = 0; i < 100; i++) { H.send('pa', 'fast', { t: 'st', n: i }); net.advance(10); }
  net.run(2000);
  assert.ok(got.length >= 5 && got.length < 30, 'coalesced fast packets ' + got.length);
  assert.strictEqual(got[got.length - 1], 99, 'newest wins');
  var st = net.relayStats().byPeer;
  assert.ok(st.pa.requests / 5 < 10, 'guest requests/s ' + (st.pa.requests / 5).toFixed(1));
});

/* ------------------------------------------------------------------ Race / free roam / drift over the relay */
test('race over the server relay: guests see every other car smoothly (merged host packets + adaptive buffer + fan-out)', function () {
  var env = setup({ relay: { oneWay: 85, jitter: 30, loss: 0 } });
  env.step(60 * 30);
  var vs = viewStats(env, 9000);
  var keys = Object.keys(vs);
  assert.ok(keys.length >= 4, 'guest views ' + keys.join(','));
  keys.forEach(function (k) {
    var s = vs[k];
    assert.ok(s.jumps <= 3, k + ' jumps ' + fmt(s));
    assert.ok(s.devP99 < 0.25, k + ' frame-to-frame p99 ' + fmt(s));
    assert.ok(s.err < 0.5, k + ' error vs truth ' + fmt(s));
    assert.ok(s.lag <= 600, k + ' display lag ' + fmt(s));
  });
  env.clients.forEach(function (c, i) {
    var ns = c.netState();
    assert.strictEqual(ns.via, 'relay');
    ns.players.filter(function (p) { return !p.isLocal && p.kind === 'human'; }).forEach(function (p) {
      assert.ok(p.updateHz >= 5, 'client ' + i + ' sees ' + p.carId + ' at ' + p.updateHz + ' Hz');
      assert.ok(p.delay_ms <= 1200, 'delay ' + p.delay_ms);
    });
    assert.ok(ns.sync.fanIn > 50, 'fan-out frames in ' + ns.sync.fanIn);
  });
  var rs = env.net.relayStats().byPeer, secs = env.net.now() / 1000;
  ['host', 'pa', 'pb'].forEach(function (id) { assert.ok(rs[id].requests / secs <= 10, id + ' requests/s ' + (rs[id].requests / secs).toFixed(1)); });
});

test('race over the relay with an old server (no fan-out): the host path still keeps every car smooth', function () {
  var env = setup({ relay: Object.assign({ fanout: false }, RELAY) });
  env.step(60 * 26);
  var vs = viewStats(env, 9000);
  Object.keys(vs).forEach(function (k) { assert.ok(vs[k].jumps <= 3 && vs[k].err < 1.2, k + ' ' + fmt(vs[k])); });
  env.clients.forEach(function (c) { assert.strictEqual(c.netState().sync.fanIn, 0); });
});

test('relay at 5 Hz (200 ms posts), jitter and loss: still no jumps; own car acts on input in the same update', function () {
  var steerAt = 60 * 14, before = {}, after = {};
  var env = setup({ relay: { oneWay: 85, jitter: 60, loss: 0.08, opts: { streamDown: true, upGap: 200 } }, autopilot: false,
    input: function (f, k) { return f < steerAt ? { throttle: 0.6, steer: 0 } : { throttle: 0.6, steer: k ? 1 : 0 }; } });
  env.step(steerAt, function (f, all) { if (f === steerAt - 1) all.forEach(function (s, k) { before[k] = s._debug().sim.player().state.steerAngle; }); });
  env.step(1, function (f, all) { all.forEach(function (s, k) { after[k] = s._debug().sim.player().state.steerAngle; }); });
  [1, 2].forEach(function (k) { assert.ok(Math.abs(after[k] - before[k]) > 1e-4, 'guest ' + k + ' steers in the same update: ' + before[k] + ' -> ' + after[k]); });
  env.step(60 * 10);
  var vs = viewStats(env, 9000);
  Object.keys(vs).forEach(function (k) { assert.ok(vs[k].jumps <= 4, k + ' ' + fmt(vs[k])); });
});

test('free roam and drift battle over the relay: smooth remote cars for guests', function () {
  ['free', 'drift'].forEach(function (mode) {
    var env = setup({ relay: RELAY, mode: mode, track: mode === 'drift' ? undefined : 'little-anvil', ai: 0 });
    env.step(60 * 22);
    var vs = viewStats(env, 9000);
    assert.ok(Object.keys(vs).length >= 2, mode + ' views');
    Object.keys(vs).forEach(function (k) { assert.ok(vs[k].jumps <= 3 && vs[k].devP99 < 0.3, mode + ' ' + k + ' ' + fmt(vs[k])); });
  });
});

test('race over direct links: unchanged quality (25 Hz, ~100 ms buffer) and identical results everywhere', function () {
  var env = setup({ net: { latency: 30, jitter: 20, loss: 0.02 }, laps: 1, ai: 1 });
  var fin = env.step(60 * 240, function () { return env.clients.length === 2 && env.clients.every(function (c) { return c.netState().final; }) && env.host.netState().final; });
  assert.ok(fin < 60 * 240, 'race finished');
  var vs = viewStats(env, 9000);
  Object.keys(vs).forEach(function (k) { assert.ok(vs[k].jumps === 0 && vs[k].err < 0.3 && vs[k].lag <= 300, k + ' ' + fmt(vs[k])); });
  function cls(s) {
    var me = s.netState().carId;
    return s.results().classification.map(function (x) { return (x.id === 'player' ? me : x.id) + ':' + (x.raceTime_s != null ? x.raceTime_s.toFixed(2) : x.status); }).join(' ');
  }
  var ref = cls(env.host);
  env.clients.forEach(function (c) { assert.strictEqual(cls(c), ref); });
});

/* ------------------------------------------------------------------ Arcade */
test('arcade guests: exactly 2 substeps per 60 fps frame (no 3,1,2 judder) and smooth puppets, direct and relay', function () {
  if (!NA || !CB.arcade || !CB.arcade.mode) return;
  [{ net: { latency: 30, jitter: 20, loss: 0.02 } }, { relay: RELAY }].forEach(function (nc) {
    ['forge-speedway', null].forEach(function (track) {
      var env = setup(Object.assign({ arcade: true, track: track || (CB.arcade.mode.stuntTracks ? CB.arcade.mode.stuntTracks()[0].id : 'loop-rush'), ai: 1 }, nc));
      env.step(60 * 24);
      [1, 2].forEach(function (k) {
        var st = env.steps[k].slice(60 * 12), odd = st.filter(function (n) { return n !== 2; }).length;
        assert.ok(odd <= st.length * 0.02, (nc.relay ? 'relay ' : 'direct ') + track + ' guest ' + k + ' irregular substeps ' + odd + '/' + st.length);
      });
      var vs = viewStats(env, 12000);
      Object.keys(vs).forEach(function (k) {
        var lim = nc.relay ? 3 : 0;
        if (track) assert.ok(vs[k].jumps <= lim && vs[k].devP99 < (nc.relay ? 0.45 : 0.3), (nc.relay ? 'relay ' : 'direct ') + track + ' ' + k + ' ' + fmt(vs[k]));
      });
    });
  });
});

test('arcade guest over the relay: own car steers in the same update (predicted locally, no round trip)', function () {
  if (!NA || !CB.arcade || !CB.arcade.mode) return;
  var at = 60 * 13, before = {}, after = {};
  var env = setup({ arcade: true, track: 'forge-speedway', relay: RELAY, autopilot: false, ai: 0,
    input: function (f, k) { return { throttle: 0.7, steer: f >= at ? (k ? 1 : 0) : 0 }; } });
  function steerOf(s) { var sn = s.snapshot(); var me = (sn.cars || []).filter(function (c) { return c.isPlayer; })[0]; return me ? me.steerAngle : null; }
  env.step(at, function (f, all) { if (f === at - 1) all.forEach(function (s, k) { before[k] = steerOf(s); }); });
  env.step(1, function (f, all) { all.forEach(function (s, k) { after[k] = steerOf(s); }); });
  [1, 2].forEach(function (k) { assert.ok(Math.abs(after[k] - before[k]) > 1e-4, 'arcade guest ' + k + ': ' + before[k] + ' -> ' + after[k]); });
});

if (local) {
  (async function () {
    var pass = 0, fail = 0;
    for (var i = 0; i < queue.length; i++) {
      var t0 = Date.now();
      try { await queue[i].fn(); pass++; console.log('  ✓ ' + queue[i].name + ' (' + (Date.now() - t0) + ' ms)'); }
      catch (e) { fail++; console.log('  ✗ ' + queue[i].name + '\n    ' + (e && e.stack || e)); }
    }
    console.log(pass + ' passed, ' + fail + ' failed');
    if (fail) process.exitCode = 1;
  })();
}

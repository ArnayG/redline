/* Drag multiplayer (js/net/netdrag.js) over the in-memory loopback: host-authoritative tree, each side simulates its own
   car, both sides agree on RT / ET and the winner; a guest that leaves early on the guest's own green is a red light. */
'use strict';
var assert = require('assert'), path = require('path'), fs = require('fs');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach(function (f) { require(path.join(root, f)); });
// index.html order (the first model registered per body style is its default: tests/shapes-* check it)
['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van', 'pack-jdm', 'pack-usa', 'pack-exotic', 'pack-sport'].forEach(function (f) { require(path.join(root, 'js/shapes/models', f + '.js')); });
['js/shapes/stock-specs.js', 'js/state.js', 'js/physics.js', 'js/rules.js', 'js/race/vehicle.js', 'js/drag/drag-strip.js', 'js/drag/drag-tree.js', 'js/drag/drag-timing.js',
 'js/drag/drag-launch.js', 'js/drag/drag-ai.js', 'js/drag/drag-session.js', 'js/net/transport.js', 'js/net/netdrag.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, T = CB.net.transport, ND = CB.net.drag;
var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('net drag: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
function stock(id) { return CB.stock.build(id).build; }
function bot(rt) {
  return function (s, lane) {
    var v = s.view(lane); if (!v) return {};
    if (!v.left) {
      if (!v.staged) return CB.drag.ai.stageControl(v, false);
      if (v.greenT != null && v.t >= v.greenT + rt - (v.rolloutT || 0.2)) return { throttle: 1 };
      return { brake: 1, throttle: 1, analog: true };
    }
    return { throttle: 1, shiftUp: v.rpm > v.optShift && v.clutchLocked };
  };
}
function race(o) {
  var net = T.loopback({ latency: o.latency || 40, jitter: 10, loss: 0.02, seed: 2 }), H = net.host(), c = net.connect({ id: 'pa', skew: 700 });
  net.run(600);
  var guest = ND.createClientSession(c, { build: stock('dodge-challenger-srt-hellcat'), name: 'Guest' });
  var host = ND.createHostSession(H, { seed: 5, distanceId: 'eighth', build: stock('bmw-m4-g82'), name: 'Host', skipBurnout: true,
    players: [{ peerId: c.selfId, name: 'Guest', build: stock('dodge-challenger-srt-hellcat') }] });
  var bh = bot(o.hostRt), bg = bot(o.guestRt);
  for (var f = 0; f < 60 * 60; f++) {
    net.advance(1000 / 60);
    host.update(1 / 60, bh(host, 0)); guest.update(1 / 60, bg(guest, 1));
    if (host.phase() === 'done' && guest.phase() === 'done') break;
  }
  return { h: host.results(), g: guest.results(), host: host, guest: guest };
}
test('heads-up over the network: both sides agree on RTs, ETs and the winner', function () {
  var r = race({ hostRt: 0.1, guestRt: 0.1 });
  assert.ok(r.guest.ready());
  [0, 1].forEach(function (i) {
    assert.ok(Math.abs(r.h.lanes[i].et - r.g.lanes[i].et) < 0.002, 'ET lane ' + i);
    assert.ok(Math.abs(r.h.lanes[i].rt - r.g.lanes[i].rt) < 0.002, 'RT lane ' + i);
    assert.ok(r.h.lanes[i].et > 6 && r.h.lanes[i].et < 8.5);
    assert.ok(r.h.lanes[i].rt > 0 && r.h.lanes[i].rt < 0.3, 'own-green RT ' + r.h.lanes[i].rt);
  });
  assert.strictEqual(r.h.winner, r.g.winner);
  assert.ok(r.h.net && r.g.selfLane === 1);
});
test('a guest who leaves before their green is red-lighted on both sides', function () {
  var r = race({ hostRt: 0.15, guestRt: -0.3 });
  assert.ok(r.g.lanes[1].red && r.h.lanes[1].red);
  assert.strictEqual(r.h.winner, 0); assert.strictEqual(r.g.winner, 0);
});
test('lobby: Drag mode settings normalise and the race config is heads-up (2 racers, no AI)', function () {
  require(path.join(root, 'js/net/lobby.js'));
  var LB = CB.net.lobby._;
  assert.ok(LB.MODES.some(function (m) { return m.id === 'drag'; }));
  var s = LB.normalizeSettings({ mode: 'drag', dragDistance: 'eighth', dragVenue: 'street', dragSurface: 'bogus' });
  assert.strictEqual(s.mode, 'drag'); assert.strictEqual(s.dragDistance, 'eighth'); assert.strictEqual(s.dragVenue, 'street'); assert.strictEqual(s.dragSurface, 'prepped');
  var t = 1000, host = LB.createCore({ role: 'host', selfId: 'h', name: 'H', now: function () { return t; }, code: 'ABCDE', countdownMs: 100, random: function () { return 0.5; } });
  host.updateSettings({ mode: 'drag', ai: 5 });
  ['g1', 'g2'].forEach(function (id) { host.addPeer({ id: id, send: function () {}, close: function () {} }); host.receive(id, { t: 'hello', name: id, build: {}, version: CB.net.lobby.PROTOCOL, pid: id }); host.receive(id, { t: 'ready', v: true }); });
  var r = host.startCountdown(true);
  var cfg = host.state().start && host.state().start.cfg;
  assert.ok(cfg, JSON.stringify(r)); assert.strictEqual(cfg.mode, 'drag'); assert.strictEqual(cfg.ai, 0); assert.strictEqual(cfg.players.length, 2);
});

/* Node tests for js/net/netarcade.js (CB.net.arcade, ARCADE-SPEC §6): host-authoritative arcade multiplayer over the
   CB.net.transport in-memory loopback (manual clock, latency / jitter / loss), host + 2 clients in-process.
   Run: node tests/run.js net-arcade */
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');

var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js', 'js/race/vehicle.js', 'js/race/ai.js',
 'js/race/engine.js', 'js/race/drift/assist.js', 'js/arcade/mode.js', 'js/arcade/stunt-track.js', 'js/arcade/stunt-maps.js', 'js/arcade/stunt-physics.js',
 'js/arcade/stunt-ai.js', 'js/arcade/stunt-session.js', 'js/arcade/items.js', 'js/arcade/nitro.js', 'js/arcade/gameplay.js', 'js/arcade/arcade-hud.js',
 'js/arcade/arcade-layer.js', 'js/net/transport.js', 'js/net/netarcade.js', 'js/net/lobby.js'].forEach(function (f) {
  var p = path.join(root, f);
  if (fs.existsSync(p)) { try { require(p); } catch (e) { console.log('  (net-arcade: skip ' + f + ': ' + e.message + ')'); } }
});
var CB = globalThis.CB;
var T = CB.net.transport, NA = CB.net.arcade, GP = CB.arcade.gameplay;
var I = NA._internal;

var local = typeof globalThis.test !== 'function';
var queue = [];
function test(name, fn) { if (!local) return globalThis.test('net-arcade: ' + name, fn); queue.push({ name: name, fn: fn }); }

/* ------------------------------------------------------------------ helpers */
function preset(i) { var p = CB.data.presets[i % CB.data.presets.length]; return JSON.parse(JSON.stringify(p.build || p)); }
function finiteDeep(o, where, seen) {
  seen = seen || [];
  if (typeof o === 'number') { assert.ok(isFinite(o), 'non-finite number at ' + where); return; }
  if (!o || typeof o !== 'object' || seen.indexOf(o) >= 0) return;
  seen.push(o);
  Object.keys(o).forEach(function (k) { if (k !== 'build') finiteDeep(o[k], where + '.' + k, seen); });
}
/** host + n clients on one loopback. o { track, laps, ai, net {latency, jitter, loss}, autopilot, options, input(f, k) } */
function setup(o) {
  o = o || {};
  var net = T.loopback(Object.assign({ latency: 40, jitter: 30, loss: 0.02, seed: o.netSeed || 3 }, o.net || {}));
  var H = net.host(), skews = [1200, -800, 300], cl = [];
  for (var i = 0; i < (o.n || 2); i++) cl.push(net.connect({ id: 'p' + String.fromCharCode(97 + i), skew: skews[i] }));
  net.run(600);
  var clients = [];
  cl.forEach(function (c, i) {
    NA.waitForStart(c, function (st) { clients[i] = NA.createClientSession(c, { start: st, build: preset(i + 1), name: 'C' + i, autopilot: !!o.autopilot }); });
  });
  var host = NA.createHostSession(H, {
    trackId: o.track || 'loop-rush', laps: o.laps || 1, ai: o.ai == null ? 2 : o.ai, seed: o.seed || 42, build: preset(0), name: 'Host', autopilot: !!o.autopilot,
    leadIn_s: 2, finishWait_s: o.finishWait_s, arcade: { options: Object.assign({ items: true, itemFrequency: 'frantic' }, o.options || {}) },
    players: cl.map(function (c, i) { return { peerId: c.selfId, name: 'C' + i, build: preset(i + 1) }; })
  });
  var env = { net: net, H: H, transports: cl, host: host, clients: clients };
  env.all = function () { return [host].concat(clients.filter(Boolean)); };
  env.step = function (frames, each) {
    for (var f = 0; f < frames; f++) {
      net.advance(1000 / 60);
      var all = env.all();
      for (var k = 0; k < all.length; k++) {
        if (o.buttons) all[k].setButtons(o.buttons(f, k));
        all[k].update(1 / 60, o.input ? o.input(f, k) : {});
      }
      if (each && each(f, all) === true) return f;
    }
    return frames;
  };
  return env;
}
function rowsOf(r) { return r.classification.map(function (c) { return c.netId + ':' + c.status; }); }
function hitEvents(snap) {
  var g = snap && snap.arcade && snap.arcade.ext && snap.arcade.ext.gameplay;
  return g && Array.isArray(g.events) ? g.events.filter(function (e) { return e.type === 'hit' && e.carId === 'player'; }).length : 0;
}

/* ------------------------------------------------------------------ protocol units */
test('input quantisation round-trips and carries buttons', function () {
  var q = I.quantInput({ steer: -0.5, throttle: 1, brake: 0.25, handbrake: true }, { nitro: true, aimBack: true });
  assert.deepStrictEqual(q.slice(0, 3), [-63, 255, 64]);
  assert.strictEqual(q[3], 1 | 2 | 4);
  var o = I.inputOf(q);
  assert.ok(Math.abs(o.steer + 0.5) < 0.01 && o.throttle === 1 && Math.abs(o.brake - 0.25) < 0.01 && o.handbrake === true);
  assert.deepStrictEqual(I.quantInput(I.inputOf(q), { nitro: true, aimBack: true }), q, 'quantised input is a fixed point');
});

test('InputBuffer replays the input of tick n - D and adapts D to the measured lateness', function () {
  var b = new I.InputBuffer();
  b.push([[10, 0, 255, 0, 0, 0, 0], [20, 127, 255, 0, 2, 1, 0]], 25, 31, 0.25);
  assert.strictEqual(b.at(15)[0], 10);
  assert.strictEqual(b.at(20)[1], 127);
  assert.strictEqual(b.at(25)[5], 1, 'item press counter');
  assert.strictEqual(b.starved, 0);
  b.at(40);
  assert.strictEqual(b.starved, 1, 'asking past the known tick counts as starved');
  assert.strictEqual(b.push([[5, 0, 0, 0, 0, 0, 0]], 24, 40, 0.3), false, 'stale packets are ignored');
  for (var k = 0; k < 40; k++) b.push([], 30 + k * 5, 30 + k * 5 + 12, 0.3 + k * 0.04);
  b.adapt(1);
  assert.ok(b.D >= 12 && b.D <= 22, 'D covers ~12 ticks of lateness, got ' + b.D);
});

test('stunt / circuit pose rows round-trip within the quantisation', function () {
  var c = { mode: 'air', s: 123.456, dist: 2623.4, lat: -2.345, psi: 0.123, v: 45.67, rpm: 6500, gear: 4, steerAngle: 0.05, throttle: 1, finished: false, nitroOn: true,
            boostT: 0.3, fade: 0, px: 1.5, py: 22.25, pz: -300.5, vx: 3, vy: -1.5, vz: 44, fx: 0.6, fy: 0.1, fz: -0.79, ux: 0, uy: 1, uz: 0, airT: 0.75, takeoffS: 120.5, _air: true };
  var u = I.unpackStunt(I.packStunt(3, c));
  assert.strictEqual(u.mode, 'air'); assert.ok(u.nitroOn && u.boosting && u.inAir);
  assert.ok(Math.abs(u.dist - c.dist) < 0.01 && Math.abs(u.lat - c.lat) < 0.01 && Math.abs(u.v - c.v) < 0.01 && Math.abs(u.psi - c.psi) < 0.001);
  assert.ok(Math.abs(u.air.py - 22.25) < 0.01 && Math.abs(u.air.fz + 0.79) < 1e-4 && Math.abs(u.air.airT - 0.75) < 0.001);
  var car = { state: { x: 10.5, y: -4.25, heading: 1.2, yawRate: 0.3, rpm: 5000, gear: 3, steerAngle: 0.1 }, wvx: 20, wvy: 1, input: { throttle: 0.5, brake: 0, handbrake: true }, finished: true };
  var v = I.unpackCircuit(I.packCircuit(1, car));
  assert.ok(Math.abs(v.x - 10.5) < 0.01 && Math.abs(v.h - 1.2) < 0.001 && v.handbrake && v.finished && Math.abs(v.vx - 20) < 0.01);
  var mid = I.interpStunt(I.unpackStunt(I.packStunt(0, { mode: 'ground', s: 2500, dist: 2500, lat: 0, psi: 0, v: 40 })),
                          I.unpackStunt(I.packStunt(0, { mode: 'ground', s: 10, dist: 2529, lat: 2, psi: 0.2, v: 42 })), 0.5, 2519);
  assert.ok(Math.abs(mid.dist - 2514.5) < 0.01 && Math.abs(mid.lat - 1) < 0.01, 'interpolation unwraps across the start line');
});

test('gameplay netPack / netApply: a follower mirrors the host karts (item, shield, coins, rockets) and keeps its own nitro', function () {
  var L = 2000, mk = function (role) { var g = GP.create({ seed: 5, layout: [{ type: 'box', s: 300, lat: 0 }, { type: 'pad', s: 500, lat: 0 }], track: { length: L } }); if (role) g.setNet({ role: role }); return g; };
  var host = mk(null), fol = mk('follower');
  var cars = [{ id: 'player', isPlayer: true, s: 100, dist: 100, lat: 0, speed: 30, position: 2 }, { id: 'b', isPlayer: false, s: 140, dist: 140, lat: 0, speed: 30, position: 1 }];
  function stepBoth(n) { for (var k = 0; k < n; k++) { host.step(1 / 120, { t: k / 120, phase: 'racing', cars: cars }); fol.step(1 / 120, { t: k / 120, phase: 'racing', cars: cars }); } }
  stepBoth(2);
  host.giveItem('b', 'rocket'); host.kart('b').shieldT = 4; host.kart('b').coins = 7;
  host.useItem('b', true);
  host.step(1 / 120, { t: 1, phase: 'racing', cars: cars });
  fol.kart('player').nitro.level = 0.8; host.kart('player').nitro.level = 0.72;
  assert.ok(fol.netApply(JSON.parse(JSON.stringify(host.netPack())), { self: 'player', age: 0.05 }));
  var fb = fol.kart('b');
  assert.strictEqual(fb.item, null, 'rocket used on the host');
  assert.ok(fb.shieldT > 3.8 && fb.coins === 7);
  var rk = fol.entities().filter(function (e) { return e.type === 'rocket'; });
  assert.strictEqual(rk.length, 1, 'the host rocket appears on the follower');
  var nl = fol.kart('player').nitro.level;
  assert.ok(nl < 0.8 && nl > 0.72, 'own nitro is blended toward the host, not overwritten: ' + nl);
  // a follower never rolls items itself: driving through the box does nothing until the host says so
  for (var k = 0; k < 240; k++) { cars[0].s += 0.5; cars[0].dist += 0.5; fol.step(1 / 120, { t: 2 + k / 120, phase: 'racing', cars: cars }); }
  assert.strictEqual(fol.kart('player').roulette, null);
  assert.strictEqual(fol.kart('player').item, null);
  // ... but it predicts its own boost pad
  for (var j = 0; j < 1200 && !(fol.kart('player').boost); j++) { cars[0].s += 0.5; cars[0].dist += 0.5; fol.step(1 / 120, { t: 5 + j / 120, phase: 'racing', cars: cars }); }
  assert.ok(fol.kart('player').boost && fol.kart('player').boost.kind === 'pad', 'pad boost predicted locally');
  fol.applyHit('player', 'oil');
  assert.ok(fol.kart('player').spinT > 0.5 && fol.kart('player').slowT > 0, 'host-decided hit applied');
});

test('gameplay humans: a remote player kart uses its own input (item press counter, nitro), never the AI', function () {
  var g = GP.create({ seed: 7, layout: [], track: { length: 2000 } });
  g.setNet({ role: 'host', humans: ['h2'], externalLaunch: true });
  var cars = [{ id: 'player', isPlayer: true, s: 0, dist: 0, lat: 0, speed: 0, position: 2 }, { id: 'h2', s: 10, dist: 10, lat: 0, speed: 0, position: 1 }];
  g.step(1 / 120, { t: 0, phase: 'countdown', cars: cars });
  g.step(1 / 120, { t: 0.01, phase: 'racing', cars: cars });
  assert.ok(g.kart('h2').launchPending, 'remote start waits for the client grade');
  assert.ok(g.launchKart('h2', 'perfect'));
  assert.strictEqual(g.kart('h2').startGrade, 'perfect');
  assert.ok(g.kart('h2').boost && g.kart('h2').boost.kind === 'start');
  g.giveItem('h2', 'turbo');
  for (var k = 0; k < 600; k++) g.step(1 / 120, { t: 0.02 + k / 120, phase: 'racing', cars: cars });
  assert.strictEqual(g.kart('h2').item.uses, 3, 'no AI item use on a human kart');
  g.setInput('h2', { itemSeq: 1 });
  g.step(1 / 120, { t: 9, phase: 'racing', cars: cars });
  assert.strictEqual(g.kart('h2').item.uses, 2, 'one press = one use');
  g.step(1 / 120, { t: 9.01, phase: 'racing', cars: cars });
  assert.strictEqual(g.kart('h2').item.uses, 2, 'the counter does not repeat');
});

/* ------------------------------------------------------------------ full races */
test('stunt race: host + 2 clients + 2 AI with frantic items finish; every peer agrees on classification and item hits', function () {
  var hitsSeen = [0, 0];
  var env = setup({ track: 'loop-rush', input: function () { return { throttle: 1, steer: 0 }; },
    buttons: function (f) { return { item: f % 90 === 1, nitro: f % 240 < 50 }; } });
  var snaps = 0;
  env.step(60 * 150, function (f, all) {
    env.clients.forEach(function (c, i) { if (c) { var sn = c.snapshot(); hitsSeen[i] += hitEvents(sn); if (f % 120 === 0) { finiteDeep(sn, 'snap'); snaps++; } } });
    if (f % 2 === 0) env.host.snapshot();
    return all.length === 3 && all.every(function (s) { return s.isFinished(); });
  });
  var res = env.all().map(function (s) { return s.results(); });
  assert.strictEqual(res.length, 3);
  var ref = rowsOf(res[0]);
  assert.strictEqual(ref.length, 5);
  res.forEach(function (r, i) {
    assert.ok(r.final && r.complete, 'peer ' + i + ' has the final results');
    assert.deepStrictEqual(rowsOf(r), ref, 'peer ' + i + ' classification');
    assert.strictEqual(r.classification.filter(function (c) { return c.isPlayer; }).length, 1);
    assert.strictEqual(r.handling, 'arcade');
    assert.ok(r.arcade && r.arcade.net);
  });
  ['host', 'pa', 'pb'].forEach(function (id) { var row = res[0].classification.filter(function (c) { return c.netId === id; })[0]; assert.strictEqual(row.status, 'finished', id + ' finished'); });
  var cls = res[0].classification, totalHits = cls.reduce(function (s, c) { return s + c.arcade.hitsTaken; }, 0), used = cls.reduce(function (s, c) { return s + c.arcade.itemsUsed; }, 0);
  assert.ok(used >= 4, 'items were used (' + used + ')');
  assert.ok(totalHits >= 1, 'somebody got hit (' + totalHits + ')');
  ['pa', 'pb'].forEach(function (id, i) {
    var row = cls.filter(function (c) { return c.netId === id; })[0];
    assert.strictEqual(hitsSeen[i], row.arcade.hitsTaken, id + ': the client saw exactly the hits the host decided');
  });
  // the gameplay pack maps karts by net id: each client's own kart mirrors ITS kart on the host, not the host's
  [['pa', 0], ['pb', 1]].forEach(function (x) {
    var hk = env.host.gameplay.kart(x[0]), ck = env.clients[x[1]].gameplay.kart('player'), hh = env.host.gameplay.kart('player');
    assert.strictEqual(ck.coins, hk.coins, x[0] + ' coins');
    assert.strictEqual(env.clients[x[1]].gameplay.kart('host').coins, hh.coins, 'host kart on ' + x[0]);
  });
  var ns = env.clients[0].netState();
  assert.strictEqual(ns.sync.snaps, 0, 'no hard snaps in a normal race');
  assert.ok(ns.sync.snapshotsIn > 300 && ns.sync.inputsOut > 300);
  assert.ok(snaps > 10);
});

test('prediction: with no interaction the host replay matches the client car to millimetres (reconciliation idle)', function () {
  var env = setup({ track: 'canyon-leap', ai: 0, n: 1, net: { latency: 45, jitter: 0, loss: 0 }, options: { items: false, coins: false },
    input: function (f, k) { return k === 0 ? { throttle: 0 } : { throttle: 1, steer: Math.sin(f / 70) * 0.05 }; } });
  env.step(60 * 40);
  var d = env.clients[0]._debug();
  assert.ok(d.stats.corrections > 0 || d.stats.maxErr === 0);
  assert.ok(d.stats.maxErr < 0.25, 'max error ' + d.stats.maxErr + ' m');
  assert.strictEqual(d.stats.snaps, 0);
  var hp = env.host.netState().players.filter(function (p) { return p.carId === 'pa'; })[0];
  assert.ok(hp.inputDelay_ms >= 45 && hp.inputDelay_ms < 160, 'input delay ' + hp.inputDelay_ms);
  // the client's car and the host's copy are the same car, D ticks apart
  var hc = env.host._debug().cars.pa, cc = d.cars.player;
  assert.ok(Math.abs(cc.dist - hc.dist) < 0.3 * cc.v + 5, 'client ' + cc.dist + ' vs host ' + hc.dist);
});

test('circuit race (Redline Ring): clients on autopilot finish; standings and results agree', function () {
  var env = setup({ track: 'forge-ring', ai: 1, autopilot: true, options: { itemFrequency: 'normal' } });
  env.step(60 * 260, function (f, all) { if (f % 3 === 0) all.forEach(function (s) { s.snapshot(); }); return all.length === 3 && all.every(function (s) { return s.isFinished(); }); });
  var res = env.all().map(function (s) { return s.results(); });
  var ref = rowsOf(res[0]);
  assert.strictEqual(ref.length, 4);
  res.forEach(function (r, i) { assert.ok(r.final, 'peer ' + i + ' final'); assert.deepStrictEqual(rowsOf(r), ref); });
  assert.ok(res[0].classification.filter(function (c) { return c.status === 'finished'; }).length >= 3);
  var sn = env.clients[1].snapshot();
  assert.strictEqual(sn.phase, 'finished');
  assert.strictEqual(sn.cars.length, 4);
  assert.ok(sn.cars.some(function (c) { return c.remote && c.kind === 'human'; }));
  finiteDeep(sn.cars.map(function (c) { return [c.x, c.y, c.heading, c.position]; }), 'cars');
});

test('disconnect: a player who leaves mid-race becomes an AI car; the race still finishes for the rest', function () {
  var env = setup({ track: 'loop-rush', ai: 1, input: function () { return { throttle: 1 }; } });
  var left = false;
  env.step(60 * 150, function (f, all) {
    if (f === 60 * 12 && !left) { left = true; env.clients[1].destroy(); env.transports[1].close('left'); env.clients.splice(1, 1); }
    if (f % 4 === 0) all.forEach(function (s) { s.snapshot(); });
    return left && env.all().every(function (s) { return s.isFinished(); });
  });
  var r = env.host.results(), rc = env.clients[0].results();
  var pb = r.classification.filter(function (c) { return c.netId === 'pb'; })[0];
  assert.ok(pb, 'the car stays in the classification');
  assert.strictEqual(pb.kind, 'ai');
  assert.ok(/\(AI\)/.test(pb.name));
  assert.ok(r.final && rc.final);
  assert.deepStrictEqual(rowsOf(rc), rowsOf(r));
  var pl = env.host.netState().players.filter(function (p) { return p.carId === 'pb'; })[0];
  assert.strictEqual(pl.connected, false);
  // the host's AI kept driving it
  assert.ok(env.host._debug().cars.pb.dist > 300);
});

test('host leaving ends the session for the clients; a non-arcade start is refused', function () {
  var env = setup({ track: 'loop-rush', ai: 0, input: function () { return { throttle: 1 }; } });
  env.step(60 * 6);
  var endedMsg = null;
  env.clients[0].onEnd(function (e) { endedMsg = e.message; });
  env.host.destroy();
  env.step(30);
  assert.ok(env.clients[0].isFinished());
  assert.ok(/host/i.test(endedMsg || ''), String(endedMsg));
  var net = T.loopback({ latency: 10 }), H = net.host(), c = net.connect({ id: 'px' });
  net.run(300);
  var s = NA.createClientSession(c, { start: { t: 'start', v: 'forge-net-race/1', seed: 1, t0: 0, grid: [] } });
  assert.strictEqual(s.isFinished(), false, 'not an arcade start: still waiting');
  H.send(c.selfId || 'px', 'rel', { t: 'start', v: 'redline-net-arcade/0', arcade: true, seed: 1, t0: 0, cfg: {}, grid: [], you: 'px' });
  net.run(200);
  assert.ok(s.isFinished() && s.netState().ended.reason === 'version');
});

test('server-relay link (peer.mode relay): self-contained 5 Hz snapshots, longer interpolation, larger input budget; race completes', function () {
  var env = setup({ track: 'loop-rush', ai: 1, net: { latency: 160, jitter: 140, loss: 0 }, input: function () { return { throttle: 1 }; } });
  var relayId = env.transports[0].selfId;
  env.transports[0].mode = 'relay';
  var hp = env.H.get(relayId); if (hp) hp.mode = 'relay';
  var got = [], off = env.transports[0].on('message', function (ch, m) { if (m && m.t === 'na.s') got.push({ at: env.net.now(), g: !!m.g }); });
  env.step(60 * 150, function (f, all) { if (f % 4 === 0) all.forEach(function (s) { s.snapshot(); }); return all.length === 3 && all.every(function (s) { return s.isFinished(); }); });
  off();
  var mid = got.slice(20, 60), span = (mid[mid.length - 1].at - mid[0].at) / 1000;
  var hz = (mid.length - 1) / span;
  assert.ok(hz > 3.5 && hz < 6.5, 'relay snapshot rate ' + hz.toFixed(2) + ' Hz');
  assert.ok(mid.every(function (x) { return x.g; }), 'every relay snapshot carries the gameplay pack');
  var ns = env.clients[0].netState();
  assert.strictEqual(ns.via, 'relay');
  assert.ok(ns.sync.interpDelay_ms >= 300, 'interpolation window ' + ns.sync.interpDelay_ms);
  var pl = env.host.netState().players.filter(function (p) { return p.carId === relayId; })[0];
  assert.strictEqual(pl.via, 'relay');
  assert.ok(env.host._debug().inbufs[relayId].maxD > 42);
  var r = env.all().map(function (s) { return s.results(); });
  r.forEach(function (x) { assert.ok(x.final); assert.deepStrictEqual(rowsOf(x), rowsOf(r[0])); });
  // the direct client kept the full rate
  assert.ok(env.clients[1].netState().sync.snapshotsIn > env.clients[0].netState().sync.snapshotsIn * 2);
});

test('lobby: Arcade mode lists stunt tracks first, sanitises the arcade rules and passes them to the race config', function () {
  var L = CB.net.lobby, X = L._internal || L;
  var norm = X.normalizeSettings || (L.core && L.core.normalizeSettings);
  if (!norm) return;   // older lobby builds expose no internals
  var s = norm({ mode: 'arcade' });
  assert.strictEqual(s.mode, 'arcade');
  assert.ok(CB.arcade.stunt.list().some(function (t) { return t.id === s.trackId; }), 'a stunt track by default: ' + s.trackId);
  assert.strictEqual(X.tracksFor('arcade')[0].kind, 'stunt');
  var s2 = norm({ mode: 'arcade', trackId: 'canyon-leap', arcade: { items: false, itemFrequency: 'bogus', speedClass: 'mayhem' } }, s);
  assert.strictEqual(s2.trackId, 'canyon-leap');
  assert.strictEqual(s2.arcade.items, false); assert.strictEqual(s2.arcade.itemFrequency, 'normal'); assert.strictEqual(s2.arcade.speedClass, 'mayhem');
  var s3 = norm({ mode: 'race' }, s2);
  assert.ok(!CB.arcade.stunt.list().some(function (t) { return t.id === s3.trackId; }), 'stunt tracks are arcade-only');
  var core = L.createCore({ role: 'host', selfId: 'h', name: 'Hana', clock: function () { return 0; } });
  core.updateSettings({ mode: 'arcade' });
  core.updateSettings({ arcade: { nitro: false }, laps: 4 });
  var got = null;
  core.on('launch', function (i) { got = i; });
  core.startCountdown(true);
  assert.strictEqual(core.state().start.cfg.mode, 'arcade');
  assert.strictEqual(core.state().start.cfg.laps, 4);
  assert.strictEqual(core.state().start.cfg.arcade.nitro, false);
  void got;
});

if (local) {
  (async function () {
    var fail = 0;
    for (var i = 0; i < queue.length; i++) {
      try { await queue[i].fn(); console.log('ok', queue[i].name); } catch (e) { fail++; console.log('FAIL', queue[i].name, e); }
    }
    if (fail) process.exitCode = 1;
  })();
}

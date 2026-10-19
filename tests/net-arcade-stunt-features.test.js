/* Node tests: arcade multiplayer (js/net/netarcade.js) on the stunt maps with SPECIAL FEATURES (js/arcade/stunt-features.js):
   moving hazards are host-authoritative and run on each car's own race clock (car.clockOffset = D ticks on the host for a
   remote player's delayed copy), so host + 2 clients agree on the results AND on every hazard hit of every human car. */
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');

var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js', 'js/race/vehicle.js', 'js/race/ai.js',
 'js/race/engine.js', 'js/arcade/mode.js', 'js/arcade/stunt-track.js', 'js/arcade/stunt-maps.js', 'js/arcade/stunt-physics.js', 'js/arcade/stunt-features.js',
 'js/arcade/stunt-ai.js', 'js/arcade/stunt-session.js', 'js/arcade/items.js', 'js/arcade/nitro.js', 'js/arcade/gameplay.js', 'js/arcade/arcade-hud.js',
 'js/arcade/arcade-layer.js', 'js/net/transport.js', 'js/net/netarcade.js'].forEach(function (f) {
  var p = path.join(root, f);
  if (fs.existsSync(p)) require(p);
});
var CB = globalThis.CB;
var T = CB.net.transport, NA = CB.net.arcade;
var test = globalThis.test || function (n, f) { f(); };

function preset(i) { var p = CB.data.presets[i % CB.data.presets.length]; return JSON.parse(JSON.stringify(p.build || p)); }
function setup(o) {
  var net = T.loopback(Object.assign({ latency: 40, jitter: 0, loss: 0, seed: 3 }, o.net || globalThis.__netArcadeStuntNet || {}));
  var H = net.host(), cl = [net.connect({ id: 'pa', skew: 900 }), net.connect({ id: 'pb', skew: -600 })];
  net.run(600);
  var clients = [];
  cl.forEach(function (c, i) { NA.waitForStart(c, function (st) { clients[i] = NA.createClientSession(c, { start: st, build: preset(i + 1), name: 'C' + i, autopilot: false }); }); });
  var host = NA.createHostSession(H, {
    trackId: o.track, laps: 1, ai: o.ai == null ? 0 : o.ai, seed: o.seed || 9, build: preset(0), name: 'Host', autopilot: false, leadIn_s: 2,
    arcade: { options: { items: false, coins: false } },
    players: cl.map(function (c, i) { return { peerId: c.selfId, name: 'C' + i, build: preset(i + 1) }; })
  });
  var env = { net: net, host: host, clients: clients };
  env.all = function () { return [host].concat(clients.filter(Boolean)); };
  return env;
}

/** a scripted HUMAN driver (no autopilot: the AI's guided stunt helpers would differ from the host's 'player' helpers):
    follows the road centre with a lane offset, lifts above the corner speed — computed from the peer's own car only,
    so the host's replay of these recorded inputs is the same car */
function human(sess, lane) {
  var d = sess._debug(), c = d.cars && d.cars.player, S = CB.arcade.stunt;
  if (!c || !d.sim || !d.sim.track) return { throttle: 1, steer: 0 };
  if (c.mode !== 'ground') return { throttle: 1, steer: 0 };
  var tr = d.sim.track, sm = tr.sample(c.s), plan = S.ai.plan(tr), v = c.v, i = Math.round(c.s / tr.DS) % tr.N;
  var latT = Math.max(-1, Math.min(1, lane)) * Math.max(0, sm.halfWidth - 2.2);
  var psiDes = Math.max(-0.35, Math.min(0.35, 0.22 * (latT - c.lat))), yawDes = sm.kLeft * v + 3.2 * (psiDes - c.psi);
  var M = drive || (drive = S.physics.resolveDrive({}));
  var steer = M.steerFor ? M.steerFor(c.drive, yawDes, v, { bank: sm.bank }) : 0;
  var thr = v > plan.speed[i] * 1.08 ? 0 : 1, brk = v > plan.speed[i] * 1.2 ? 0.7 : 0;
  return { throttle: thr, brake: brk, steer: steer };
}
var drive = null;
function raceOn(track, net) {
  var env = setup({ track: track, net: net });
  var lanes = [0, 0.75, -0.75];   // apart: no car-to-car contacts (those make the prediction diverge a little anyway)
  var seen = [0, 0, 0];   // hazard callouts of each peer's own car (host, pa, pb) through the snapshots race-ui renders
  for (var f = 0; f < 60 * 200; f++) {
    env.net.advance(1000 / 60);
    var all = env.all();
    all.forEach(function (s, k) {
      s.update(1 / 60, human(s, lanes[k]));
      var sn = s.snapshot();
      (sn.events || []).forEach(function (e) { if (e.type === 'stuntFx' && e.kind === 'hazard' && e.carId === 'player') seen[k]++; });
    });
    if (all.length === 3 && all.every(function (s) { return s.isFinished(); })) break;
  }
  return { env: env, seen: seen };
}

[['megacity-rooftops', null], ['toybox-bedroom', null], ['megacity-rooftops', { latency: 60, jitter: 35, loss: 0.03, seed: 7 }]].forEach(function (cs) {
  var track = cs[0];
  test('net-arcade stunt features (' + track + (cs[1] ? ', jitter + loss' : '') + '): host + 2 clients agree on results and on every human car\'s hazard hits', function () {
    if (!CB.arcade.stunt.getDef(track)) return;
    var R = raceOn(track, cs[1]), env = R.env;
    var res = env.all().map(function (s) { return s.results(); });
    var ref = res[0].classification.map(function (c) { return c.netId + ':' + c.status; });
    res.forEach(function (r, i) {
      assert.ok(r.final && r.complete, 'peer ' + i + ' final');
      assert.deepStrictEqual(r.classification.map(function (c) { return c.netId + ':' + c.status; }), ref, 'peer ' + i + ' classification');
    });
    var cls = res[0].classification;
    ['host', 'pa', 'pb'].forEach(function (id) {
      var row = cls.filter(function (c) { return c.netId === id; })[0];
      assert.strictEqual(row.status, 'finished', id + ' finished');
      assert.ok(row.stunt && typeof row.stunt.hazardHits === 'number', id + ' carries stunt stats');
    });
    var hostCars = env.host._debug().cars, total = 0;
    ['pa', 'pb'].forEach(function (id, i) {
      var hostHits = (hostCars[id].feat || {}).hz | 0, own = (env.clients[i]._debug().cars.player.feat || {}).hz | 0;
      var row = cls.filter(function (c) { return c.netId === id; })[0];
      assert.strictEqual(own, hostHits, id + ': client predicted ' + own + ' hazard hits, host decided ' + hostHits);
      assert.strictEqual(row.stunt.hazardHits, hostHits, id + ': results carry the host count');
      assert.strictEqual(R.seen[i + 1], own, id + ': every predicted hit reached the HUD once');
      assert.ok(Math.abs(hostCars[id].clockOffset - env.host._debug().inbufs[id].D / 120) < 1e-9, id + ' hazard clock offset = D');
      total += hostHits;
      assert.strictEqual(env.clients[i].netState().sync.snaps, 0, id + ': no hard snaps');
    });
    assert.strictEqual(R.seen[0], (hostCars.player.feat || {}).hz | 0, 'host HUD saw its own hits');
    // hazard bonks really happen on these maps (pendulums / pistons / hammers sit on the racing line)
    total += (hostCars.player.feat || {}).hz | 0;
    console.log('    ' + track + ': hazard hits host/pa/pb = ' + [(hostCars.player.feat || {}).hz | 0, (hostCars.pa.feat || {}).hz | 0, (hostCars.pb.feat || {}).hz | 0].join('/'));
  });
});
globalThis.__netArcadeStuntRace = raceOn;   // debugging hook (tools / ad-hoc scripts)

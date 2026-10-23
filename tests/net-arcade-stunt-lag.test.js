/* Arcade STUNT multiplayer over a slow link: host + 2 guests in-process (CB.net.transport loopback), over the SERVER RELAY
   emulation (~85 ms per leg + jitter + TCP-retransmit loss, newest-wins coalescing, ~5 Hz snapshots) and over a direct
   link, on stunt maps with ramps / gaps, cannons, warps and barrel-roll tubes. Asserts, for guests:
     - remote cars never jump (frame-to-frame > 0.5 m off a constant-velocity continuation; warp portals are teleports,
       counted apart and never slid across the world)
     - the own car is as smooth as the host's own car (corrections in track space, phase mismatches at launches /
       landings deferred, a hard snap only rarely — after a host-decided contact / slipstream near a ramp)
     - every guest shows the host's classification
   (pooled over 3 seeds per map, see below; the interaction-free prediction is checked exactly, bit for bit)
   plus the pieces: stunt-session prev-substep poses (1 / 2 / 3 substep frames draw a smooth car), snapshot() never touches
   the physics (landings independent of when the renderer asks), the host's copy of a guest replays exactly one input per
   physics step (E), puppet interpolation is ballistic in the air and does not slide through a warp portal.
   Run: node tests/run.js net-arcade-stunt-lag */
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');

var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js', 'js/race/vehicle.js', 'js/race/ai.js',
 'js/race/engine.js', 'js/arcade/mode.js', 'js/arcade/stunt-track.js', 'js/arcade/stunt-maps.js', 'js/arcade/stunt-physics.js', 'js/arcade/stunt-features.js',
 'js/arcade/stunt-ai.js', 'js/arcade/stunt-session.js', 'js/arcade/items.js', 'js/arcade/nitro.js', 'js/arcade/gameplay.js', 'js/arcade/arcade-hud.js',
 'js/arcade/arcade-layer.js', 'js/net/relay.js', 'js/net/transport.js', 'js/net/netarcade.js'].forEach(function (f) {
  var p = path.join(root, f);
  if (fs.existsSync(p)) require(p);
});
var CB = globalThis.CB;
var T = CB.net.transport, NA = CB.net.arcade, S = CB.arcade.stunt;
var test = globalThis.test || function (n, f) { f(); console.log('  ok ' + n); };

function preset(i) { var p = CB.data.presets[i % CB.data.presets.length]; return JSON.parse(JSON.stringify(p.build || p)); }
var RELAY = { oneWay: 85, jitter: 30, loss: 0.03, opts: { streamDown: true } };

/* The whole-race checks are chaotic in the car dynamics. Car-car contacts and slipstreams are decided by the HOST (a
   guest's own prediction never bumps the delayed puppets) and reach the guest as corrections — now and then as a hard
   snap when a ramp is near (one side launches, the other does not), or a few corrections in a row when a contact put
   the host's copy on the other side of a split-lane divider. With four cars racing in a pack that happens somewhere in
   most races; WHERE depends on the seed, so a per-race "0 snaps, < N jumps/min" passed only on lucky seeds. Every
   whole-race check therefore runs SEEDS races and asserts per race the hard invariants (teleports only at portals, a
   hard snap at most rarely, every guest shows a classification the host had moments ago) and, pooled over the races,
   the jump rates and the snap count. The interaction-FREE prediction is checked exactly by the last test: until its first
   contact / slipstream the host's copy of a guest is the guest's own prediction, bit for bit.
   STUNT_SEED=<n> moves the seed base — sweep: for s in $(seq 40 60); do STUNT_SEED=$s node tests/run.js stunt-lag; done */
var SEED0 = +process.env.STUNT_SEED || 44, SEEDS = [SEED0, SEED0 + 1, SEED0 + 2];
var GUESTS = ['pa', 'pb'];

/** host + 2 autopiloted guests + 1 AI on `track`; records every view's drawn 2D position per 60 Hz frame, the host's
    classification per frame and the first host-side interaction (contact / slipstream) of each guest's copy */
function race(track, relay, secs, seed, opts) {
  opts = opts || {};
  var net = relay ? T.loopback({ latency: 0, seed: 5, relay: RELAY }) : T.loopback({ latency: 30, jitter: 20, loss: 0.02, seed: 5 });
  var H = net.host(), cl = [net.connect({ id: 'pa', skew: 1500 }), net.connect({ id: 'pb', skew: -900 })].slice(0, opts.guests || 2);
  net.run(3000);
  var clients = [];
  cl.forEach(function (c, i) {
    NA.waitForStart(c, function (st) {
      clients[i] = NA.createClientSession(c, { start: st, build: preset(i + 1), name: 'C' + i, autopilot: true });
      if (opts.errLog) clients[i]._debug().stats.errLog = [];
    });
  });
  var host = NA.createHostSession(H, { trackId: track, laps: 3, seed: seed || SEED0, build: preset(0), name: 'Host', autopilot: true, leadIn_s: 2, ai: opts.ai != null ? opts.ai : 1,
    arcade: { options: { items: false } }, players: cl.map(function (c, i) { return { peerId: c.selfId, name: 'C' + i, build: preset(i + 1) }; }) });
  var views = {}, frames = 60 * (secs + 6), hostCls = [], firstTouchTick = {}, lastCol = {};
  for (var f = 0; f < frames; f++) {
    net.advance(1000 / 60);
    var all = [host].concat(clients.filter(Boolean));
    all.forEach(function (s) { s.update(1 / 60, {}); });
    if (opts.errLog) {   // host side: the first tick (in the copy's input index) its copy touches / drafts another car
      var hd = host._debug(), gp = host.gameplay;
      GUESTS.forEach(function (g) {
        var car = hd.cars[g], K = gp && gp.kart(g), buf = hd.inbufs[g];
        if (!car || firstTouchTick[g] != null) return;
        var col = car.collisions | 0, touched = col !== (lastCol[g] | 0) || !!(K && (K.slip.charge > 0 || (K.boost && K.boost.kind === 'slip')));
        lastCol[g] = col;
        if (touched && buf && buf.E !== null) firstTouchTick[g] = Math.round(hd.raceNow() * 120) - buf.E;
      });
    }
    if (f < 60 * 9) continue;   // grid + countdown + launch
    hostCls.push(clsOf(host));
    all.forEach(function (s) {
      var sn = s.snapshot(), me = s.netState().carId, a = typeof sn.alpha === 'number' ? sn.alpha : 1;
      (sn.cars || []).forEach(function (c) {
        var key = me + '>' + (c.isPlayer ? 'P' : c.netId);
        (views[key] = views[key] || []).push([c.prevX + (c.x - c.prevX) * a, c.prevY + (c.y - c.prevY) * a]);
      });
    });
  }
  var jumps = {};
  Object.keys(views).forEach(function (k) {
    var v = views[k], n = 0, tele = 0;
    for (var i = 2; i < v.length; i++) {
      var d = Math.hypot(v[i][0] - 2 * v[i - 1][0] + v[i - 2][0], v[i][1] - 2 * v[i - 1][1] + v[i - 2][1]);
      if (d > 12) tele++; else if (d > 0.5) n++;
    }
    jumps[k] = { n: n, min: v.length / 3600, perMin: n / (v.length / 60) * 60, tele: tele };
  });
  return { host: host, clients: clients, jumps: jumps, hostCls: hostCls, firstTouchTick: firstTouchTick, results: clients.map(clsOf) };
}
function clsOf(s) { return s.results().classification.map(function (r) { return r.netId + ':' + r.position + ':' + r.laps; }).join(','); }
function round1(k, v) { return typeof v === 'number' ? Math.round(v * 10) / 10 : v; }
/** jumps per minute of view `key`, pooled over the races */
function pooled(runs, key) {
  var n = 0, min = 0;
  runs.forEach(function (r) { var j = r.jumps[key]; if (j) { n += j.n; min += j.min; } });
  return min > 0 ? n / min : 0;
}

function check(track, relay, o) {
  o = o || {};
  var tag = track + (relay ? ' relay' : ' direct') + ' seeds ' + SEEDS.join('/');
  var runs = SEEDS.map(function (seed) {
    var r = race(track, relay, o.secs || 30, seed);
    var msg = track + (relay ? ' relay' : ' direct') + ' seed ' + seed + ' ' + JSON.stringify(r.jumps, function (k, v) { return k === 'n' || k === 'min' ? undefined : round1(k, v); });
    GUESTS.forEach(function (g, i) {
      ['host', 'pa', 'pb'].forEach(function (id) {
        if (id === g) return;
        var j = r.jumps[g + '>' + id];
        assert.ok(j, g + ' draws ' + id + ' — ' + msg);
        assert.ok(j.tele <= (o.teleports || 0) * 2 + 2, g + ' sees ' + id + ' teleport ' + j.tele + 'x — ' + msg);
      });
      var sy = r.clients[i].netState().sync;
      assert.ok(sy.snaps <= 2 + (o.snaps || 0), 'guest ' + g + ': ' + sy.snaps + ' hard snaps in one race ' + JSON.stringify(r.clients[i]._debug().stats.snapWhy || {}) + ' — ' + msg);
    });
    // every guest shows a classification the host had moments ago (the provisional standings travel at 5 Hz)
    var recent = r.hostCls.slice(-90);
    r.results.forEach(function (cls, i) {
      assert.ok(recent.indexOf(cls) >= 0, 'guest ' + GUESTS[i] + ' results agree with the host: ' + cls + ' | host ' + r.hostCls[r.hostCls.length - 1] + ' — ' + msg);
    });
    return r;
  });
  // pooled over the races: one contact-heavy race costs a few corrections, a netcode regression costs them all
  var hostOwn = pooled(runs, 'host>P');
  GUESTS.forEach(function (g, i) {
    ['host', 'pa', 'pb'].forEach(function (id) {
      if (id === g) return;
      var m = pooled(runs, g + '>' + id);
      assert.ok(m < 5, g + ' sees ' + id + ' jump ' + m.toFixed(1) + '/min over ' + tag + ' (< 5): ' + runs.map(function (r) { return r.jumps[g + '>' + id].perMin.toFixed(1); }).join(' / '));
    });
    var own = pooled(runs, g + '>P');
    assert.ok(own <= hostOwn + 6, g + ' own car ' + own.toFixed(1) + '/min vs host own car ' + hostOwn.toFixed(1) + '/min over ' + tag + ': '
      + runs.map(function (r) { return r.jumps[g + '>P'].perMin.toFixed(1) + ' vs ' + r.jumps['host>P'].perMin.toFixed(1); }).join(' / '));
    var snaps = runs.map(function (r) { return r.clients[i].netState().sync.snaps; }), total = snaps.reduce(function (a, b) { return a + b; }, 0);
    assert.ok(total <= SEEDS.length * ((o.snaps || 0) + 1), 'guest ' + g + ': ' + total + ' hard snaps over ' + tag + ' (' + snaps.join(' / ') + ')');
  });
  return runs;
}

/* ------------------------------------------------------------------ the pieces */
test('stunt-session: the snapshot interpolates the previous SUBSTEP pose -> current (smooth for 1 / 2 / 3 substep frames)', function () {
  var sess = S.createSession({ trackId: 'loop-rush', laps: 1, mode: 'race', opponents: 0, seed: 3, playerAutopilot: true, countdown: false });
  sess.simulate(4);
  var seq = [2, 2, 3, 1, 2, 2, 3, 1, 0, 4, 2], xs = [], dts = [];
  seq.forEach(function (n) {
    sess.update(n / 120 + 1e-7, {});
    var sn = sess.snapshot(), c = sn.cars[0], a = sn.alpha;
    assert.ok(c.prevPos && c.pos, 'prevPos / pos in the snapshot');
    xs.push(c.prevX + (c.x - c.prevX) * a); dts.push(sn.t + a / 120);
  });
  for (var i = 1; i < xs.length; i++) {
    var v = (xs[i] - xs[i - 1]) / Math.max(1e-6, dts[i] - dts[i - 1]);
    if (dts[i] - dts[i - 1] > 1e-6) assert.ok(v > 5 && v < 120, 'drawn speed stays physical across uneven substeps: ' + v.toFixed(1) + ' m/s');
  }
});

test('stunt-session: snapshot() never feeds the physics (landing test memory c.prevH): same run with / without snapshots', function () {
  function run(snapEvery) {
    var sess = S.createSession({ trackId: 'canyon-leap', laps: 1, mode: 'race', opponents: 2, seed: 11, playerAutopilot: true });
    for (var f = 0; f < 60 * 40; f++) { sess.update(1 / 60, {}); if (snapEvery && f % snapEvery === 0) sess.snapshot(); }
    return sess.getState().cars.map(function (c) { return [c.id, c.mode, c.s.toFixed(6), c.lat.toFixed(6), c.landings].join(':'); }).join('|');
  }
  assert.strictEqual(run(1), run(0));
  assert.strictEqual(run(3), run(0));
});

test('netarcade puppets: ballistic Hermite in the air (no stepping), one-sided across a warp portal (no slide through the world)', function () {
  var I = NA._internal, tr = S.get('sky-highway');
  var L = tr.length;
  var a = { mode: 'air', s: 100, dist: 100, lat: 0, psi: 0, v: 40, rpm: 0, steerAngle: 0, throttle: 1, fade: 0,
            air: { px: 0, py: 10, pz: 0, vx: 40, vy: 5, vz: 0, fx: 1, fy: 0, fz: 0, ux: 0, uy: 1, uz: 0, airT: 0.2, takeoffS: 90 } };
  var b = { mode: 'air', s: 108, dist: 108, lat: 0, psi: 0, v: 40, rpm: 0, steerAngle: 0, throttle: 1, fade: 0,
            air: { px: 8, py: 10.7, pz: 0, vx: 40, vy: 2.1, vz: 0, fx: 1, fy: 0, fz: 0, ux: 0, uy: 1, uz: 0, airT: 0.4, takeoffS: 90 } };
  var m = I.interpStunt(a, b, 0.5, L, 0.2, tr);
  assert.ok(Math.abs(m.air.px - 4) < 0.3 && m.air.py > 10.4 && m.air.py < 11, 'mid-flight point on the arc ' + JSON.stringify(m.air));
  assert.ok(tr.warps && tr.warps.length, 'sky-highway has warps');
  var w = tr.warps[0];
  var a2 = assign(a, { s: w.s - 4, dist: w.s - 4, air: assign(a.air, { px: w.from[0], py: w.from[1] + 1, pz: w.from[2], vx: w.fromFwd[0] * 40, vy: 0, vz: w.fromFwd[2] * 40 }) });
  var b2 = assign(a, { s: w.s + 4, dist: w.s + 4, air: assign(a.air, { px: w.to[0], py: w.to[1] + 1, pz: w.to[2], vx: w.toFwd[0] * 40, vy: 0, vz: w.toFwd[2] * 40 }) });
  for (var u = 0; u <= 1.0001; u += 0.1) {
    var o = I.interpStunt(a2, b2, u, L, 0.2, tr), p = [o.air.px, o.air.py, o.air.pz];
    var dA = Math.hypot(p[0] - w.from[0], p[2] - w.from[2]), dB = Math.hypot(p[0] - w.to[0], p[2] - w.to[2]);
    assert.ok(Math.min(dA, dB) < 12, 'u=' + u.toFixed(1) + ': drawn at one of the portal mouths, not between them (' + dA.toFixed(1) + ' / ' + dB.toFixed(1) + ' m)');
  }
  function assign(x, y) { return Object.assign({}, x, y); }
});

test('netarcade host: the copy of a guest steps once per recorded input (E), holds / doubles a step when D moves', function () {
  var r = race('volcano-cannon', true, 14);
  var ib = r.host._debug().inbufs;
  Object.keys(ib).forEach(function (id) { assert.ok(ib[id].E !== null && ib[id].E >= 3, id + ' E ' + ib[id].E); });
  r.clients.forEach(function (c, i) {
    // a contact can put the copy on the other side of a split-lane divider for a while (seed-dependent, a few m), but
    // never so far that a ground 'far' snap (14 m) is needed; the interaction-free prediction is exact (last test)
    var st = c._debug().stats;
    assert.ok(st.maxErr < 14 && !(st.snapWhy && st.snapWhy.far), 'guest ' + i + ': no divergence needing a far snap (maxErr ' + st.maxErr + ')');
  });
});

/* ------------------------------------------------------------------ whole races */
test('relay 85 ms: volcano-cannon (2 cannons) — guests see no jumps, hardly a snap, results agree (3 seeds)', function () { check('volcano-cannon', true); });
test('relay 85 ms: sky-highway (warp portals, ski jump) — warps teleport, nothing else jumps (3 seeds)', function () { check('sky-highway', true, { teleports: 4 }); });
test('relay 85 ms: tube-twister (barrel-roll tubes, zero-g) — guests see no jumps, hardly a snap (3 seeds)', function () { check('tube-twister', true); });
test('relay 85 ms: loop-rush + canyon-leap (loops, gaps) — guests see no jumps, hardly a snap (3 seeds)', function () { check('loop-rush', true); check('canyon-leap', true, { snaps: 1 }); });
test('direct link: volcano-cannon + sky-highway stay smooth too (3 seeds)', function () { check('volcano-cannon', false); check('sky-highway', false, { teleports: 4 }); });

test('netarcade stunt: until a car-car interaction the host copy of a guest is its own prediction, bit for bit (GO, rocket-start bog, pads, held / doubled steps)', function () {
  // one guest, no AI: the copy meets the host car only now and then. Every snapshot error before its first contact /
  // slipstream must be the 1 cm snapshot quantisation only (the copy used to roll back on a sloped grid while waiting for
  // GO + D, get its start bog / boosts / nitro a step late, tick its timers through held steps and boost towards a
  // generic 220 km/h top speed: 0.1–1 m errors corrected forever after)
  ['loop-rush', 'canyon-leap'].forEach(function (track) {
    var r = race(track, false, 14, SEED0, { guests: 1, ai: 0, errLog: true });
    var c = r.clients[0], go = c._debug().goTick, first = r.firstTouchTick.pa != null ? r.firstTouchTick.pa : Infinity;
    var errs = c._debug().stats.errLog.filter(function (e) { return e[0] >= go && e[0] < first - 2 && e[1] >= 0; });
    assert.ok(errs.length >= 8, track + ': ' + errs.length + ' snapshots between GO and the first interaction (tick ' + go + ' .. ' + first + ')');
    var worst = errs.reduce(function (w, e) { return e[1] > w[1] ? e : w; }, [0, 0]);
    assert.ok(worst[1] <= 0.008, track + ': prediction error ' + worst[1] + ' m at tick ' + worst[0] + ' before any interaction (> the 1 cm snapshot quantisation) ' + JSON.stringify(errs.slice(0, 12)));
  });
});

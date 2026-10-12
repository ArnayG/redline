/* Node tests for js/net/netrace.js (CB.net.race) over the CB.net.transport in-memory loopback
   (manual clock, 30–120 ms one-way latency, 2% loss on 'fast', skewed client clocks).
   Run: node tests/run.js net-race */
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');

var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js', 'js/race/vehicle.js',
 'js/race/ai.js', 'js/race/engine.js', 'js/race/drift/tune.js', 'js/race/drift/scoring.js', 'js/race/drift/assist.js', 'js/race/drift/arcade.js',
 'js/race/drift/ai.js', 'js/race/drift/tracks.js', 'js/race/drift/session.js', 'js/net/transport.js', 'js/net/netrace.js'].forEach(function (f) {
  var p = path.join(root, f);
  if (fs.existsSync(p)) { try { require(p); } catch (e) { console.log('  (net-race: skip ' + f + ': ' + e.message + ')'); } }
});
var CB = globalThis.CB;
var T = CB.net.transport, NR = CB.net.race;

var local = typeof globalThis.test !== 'function';
var queue = [];
function test(name, fn) { if (!local) return globalThis.test('net-race: ' + name, fn); queue.push({ name: name, fn: fn }); }

/* ------------------------------------------------------------------ helpers */
function preset(i) {
  var p = CB.data.presets[i % CB.data.presets.length];
  return JSON.parse(JSON.stringify(p.build || p));
}
function finiteDeep(o, where, seen) {
  seen = seen || [];
  if (typeof o === 'number') { assert.ok(isFinite(o), 'non-finite number at ' + where); return; }
  if (!o || typeof o !== 'object' || seen.indexOf(o) >= 0) return;
  seen.push(o);
  Object.keys(o).forEach(function (k) { if (k !== 'build' && k !== 'endurance') finiteDeep(o[k], where + '.' + k, seen); });
}
/** host + n clients on one loopback; returns {net, host, clients, all, step(frames, fn)} */
function setup(o) {
  o = o || {};
  var net = T.loopback({ latency: 30, jitter: 90, loss: 0.02, seed: o.netSeed || 3 });
  var H = net.host();
  var skews = [3200, -1700, 450, -900, 2100];
  var cl = [];
  for (var i = 0; i < (o.n || 3); i++) cl.push(net.connect({ id: 'p' + String.fromCharCode(97 + i), skew: skews[i] }));
  net.run(600);
  var clients = [];
  cl.forEach(function (c, i) {
    NR.waitForStart(c, function (st) { clients[i] = NR.createClientSession(c, { start: st, build: preset(i + 1), name: 'C' + i, autopilot: o.autopilot !== false }); });
  });
  var host = NR.createHostSession(H, Object.assign({
    trackId: 'little-anvil', laps: 2, seed: 42, build: preset(0), name: 'Host', autopilot: o.autopilot !== false, leadIn_s: 2,
    players: cl.map(function (c, i) { return { peerId: c.selfId, name: 'C' + i, build: preset(i + 1) }; })
  }, o.host || {}));
  var env = { net: net, H: H, transports: cl, host: host, clients: clients, all: null };
  env.step = function (frames, each) {
    for (var f = 0; f < frames; f++) {
      net.advance(1000 / 60);
      var all = [host].concat(clients.filter(Boolean));
      env.all = all;
      for (var k = 0; k < all.length; k++) all[k].update(1 / 60, {});
      if (each && each(f, all) === true) return f;
    }
    return frames;
  };
  return env;
}
function rowsOf(r) { return r.classification.map(function (c) { return c.netId + ':' + c.status; }); }

/* ------------------------------------------------------------------ race */
function runRace(netSeed) {
  var env = setup({ netSeed: netSeed, host: { mode: 'race', ai: 1 } });
  var snaps = 0;
  env.step(60 * 220, function (f, all) {
    if (f % 30 === 0) all.forEach(function (s) { var sn = s.snapshot(); finiteDeep(sn, 'snap'); snaps++; });
    return all.length === 4 && all.every(function (s) { return s.isFinished(); });
  });
  return { env: env, results: env.all.map(function (s) { return s.results(); }), snaps: snaps };
}

test('3 clients + host + 1 AI complete a 2-lap race; every peer agrees on the host classification', function () {
  var R = runRace(3);
  assert.strictEqual(R.results.length, 4);
  var ref = rowsOf(R.results[0]);
  assert.strictEqual(ref.length, 5);
  R.results.forEach(function (r, i) {
    assert.ok(r.complete && r.final, 'peer ' + i + ' has final results');
    assert.deepStrictEqual(rowsOf(r), ref, 'peer ' + i + ' classification');
    r.classification.forEach(function (c) { assert.strictEqual(c.status, 'finished'); assert.strictEqual(c.laps, 2); assert.ok(c.totalTime_s > 20); });
    assert.strictEqual(r.classification.filter(function (c) { return c.isPlayer; }).length, 1, 'exactly one isPlayer row');
    assert.strictEqual(r.player.id, 'player');
    finiteDeep(r.classification.map(function (c) { return [c.totalTime_s, c.bestLap_s, c.position]; }), 'results');
  });
  // ordering is by total time
  var tot = R.results[0].classification.map(function (c) { return c.totalTime_s; });
  for (var k = 1; k < tot.length; k++) assert.ok(tot[k] >= tot[k - 1], 'sorted by total time');
  assert.deepStrictEqual(R.results[0].net.validation, { rejected: 0, corrected: 0 }, 'honest lap claims all validated');
  assert.ok(R.snaps > 100);
  // snapshot surface while finished
  var sn = R.env.clients[1].snapshot();
  assert.strictEqual(sn.phase, 'finished');
  assert.strictEqual(sn.cars.filter(function (c) { return c.isPlayer; }).length, 1);
  assert.strictEqual(sn.cars.length, 5);
  assert.ok(sn.net && sn.netMode);
});

test('results ordering is deterministic for the same seeds', function () {
  var a = runRace(5), b = runRace(5);
  assert.deepStrictEqual(rowsOf(a.results[0]), rowsOf(b.results[0]));
  assert.deepStrictEqual(a.results[0].classification.map(function (c) { return c.totalTime_s; }),
                         b.results[0].classification.map(function (c) { return c.totalTime_s; }));
});

test('lights go out together on all peers despite skewed clocks', function () {
  var env = setup({ host: { mode: 'race' } });
  var go = {};
  env.step(60 * 14, function (f, all) {
    all.forEach(function (s, i) {
      if (go[i] == null && s.snapshot().countdown.lightsOut) go[i] = s._debug().raceNow();
    });
    return Object.keys(go).length === 4;
  });
  var v = Object.keys(go).map(function (k) { return go[k]; });
  assert.strictEqual(v.length, 4);
  var spread = Math.max.apply(null, v) - Math.min.apply(null, v);
  assert.ok(spread < 0.12, 'lights-out spread ' + spread.toFixed(3) + ' s');
  env.clients.forEach(function (c) { assert.ok(c.netState().clockReady); });
});

test('remote interpolation error stays bounded under latency, jitter and 2% loss', function () {
  var env = setup({ host: { mode: 'race' } });
  var hist = {};        // sender carId -> [[raceT, x, y]]
  var errs = [], warm = 60 * 12;
  env.step(60 * 40, function (f, all) {
    all.forEach(function (s) {
      var d = s._debug(), me = d.sim.player();
      if (!me) return;
      var id = s.netState().carId;
      (hist[id] = hist[id] || []).push([d.sim.epoch + d.sim.time(), me.state.x, me.state.y]);
    });
    if (f < warm || f % 3) return;
    all.forEach(function (s) {
      var d = s._debug(), sn = s.snapshot();
      sn.cars.forEach(function (c) {
        if (!c.remote) return;
        var tr = d.tracks[c.netId], h = hist[c.netId];
        if (!tr || !h || tr.prevRt == null) return;
        var rt = tr.prevRt, i = h.length - 1;
        while (i > 0 && h[i - 1][0] > rt) i--;
        if (i < 1) return;
        var a = h[i - 1], b = h[i], u = (rt - a[0]) / Math.max(1e-6, b[0] - a[0]);
        u = Math.max(0, Math.min(1, u));
        var tx = a[1] + (b[1] - a[1]) * u, ty = a[2] + (b[2] - a[2]) * u;
        errs.push(Math.hypot(c.x - tx, c.y - ty));
      });
    });
  });
  assert.ok(errs.length > 500, 'samples ' + errs.length);
  errs.sort(function (a, b) { return a - b; });
  var mean = errs.reduce(function (s, v) { return s + v; }, 0) / errs.length, p99 = errs[Math.floor(errs.length * 0.99)];
  assert.ok(mean < 0.35, 'mean interpolation error ' + mean.toFixed(3) + ' m');
  assert.ok(p99 < 2.0, 'p99 interpolation error ' + p99.toFixed(3) + ' m');
  var ns = env.clients[0].netState();
  ns.players.filter(function (p) { return !p.isLocal; }).forEach(function (p) {
    assert.ok(p.delay_ms >= 100 && p.delay_ms <= 350, 'delay ' + p.delay_ms);
    assert.ok(p.loss_pct < 8, 'loss ' + p.loss_pct);
  });
});

test('a client that drops out becomes a ghost, is removed, and the race still finishes', function () {
  var env = setup({ host: { mode: 'race' } });
  env.step(60 * 20);
  var gone = env.clients[2].netState().carId;
  env.net.disconnect(env.transports[2].selfId, { permanent: true });
  var sawGhost = false, removed = false, done = false;
  var c0 = env.clients[0];
  env.clients.splice(2, 1);
  env.step(60 * 200, function (f) {
    if (f % 10) return;
    var sn = c0.snapshot(), car = sn.cars.filter(function (c) { return c.netId === gone; })[0];
    if (car && car.ghost) sawGhost = true;
    if (sawGhost && !car) removed = true;
    done = env.host.isFinished() && c0.isFinished() && env.clients[1].isFinished();
    return done;
  });
  assert.ok(sawGhost, 'disconnected car shown as ghost');
  assert.ok(removed, 'ghost removed from snapshots');
  assert.ok(done, 'race finished for the remaining players');
  var row = env.host.results().classification.filter(function (c) { return c.netId === gone; })[0];
  assert.strictEqual(row.status, 'dnf');
  assert.strictEqual(row.dnfReason, 'disconnected');
  assert.strictEqual(env.host.results().classification[env.host.results().classification.length - 1].netId, gone);
});

test('host leaving ends client sessions gracefully with a message', function () {
  var env = setup({ n: 2, host: { mode: 'race' } });
  env.step(60 * 8);
  var ended = null;
  env.clients[0].onEnd(function (e) { ended = e; });
  env.host.destroy();
  env.H.close();
  var host = env.host;
  env.host = { update: function () { return 0; } };
  env.step(60 * 3);
  void host;
  assert.ok(ended && /host/i.test(ended.message), 'end message: ' + (ended && ended.message));
  var sn = env.clients[0].snapshot();
  assert.strictEqual(sn.phase, 'finished');
  assert.ok(sn.events.length || sn.net.message);
  var r = env.clients[0].results();
  assert.ok(r.aborted && r.message);
  finiteDeep(sn, 'snap');
});

test('host rejects implausible lap claims and credits laps from its own observation', function () {
  var RC = NR._internal.RaceControl;
  var rc = new RC({ mode: 'race', laps: 2, L: 800, entrants: [{ carId: 'a', kind: 'human' }, { carId: 'b', kind: 'human' }] });
  rc.claimLap('a', { lap: 1, time: 2.0 }, 1);                    // faster than physically possible
  rc.claimLap('b', { lap: 1, time: 40 }, 1);                     // plausible time but never observed
  rc.tick(2, 0, 'racing');
  assert.strictEqual(rc.cars.a.lap, 0);
  assert.strictEqual(rc.rejected, 1);
  rc.tick(9, 0, 'racing');
  assert.strictEqual(rc.cars.b.lap, 0, 'unobserved claim rejected after the wait');
  assert.strictEqual(rc.rejected, 2);
  // the host's puppet of b really completes the lap -> accepted on the next claim / observation
  rc.observe('b', { lapTimes: [{ lap: 1, time: 41.2 }], raceDist: 810 }, 10);
  rc.claimLap('b', { lap: 1, time: 30 }, 10);                    // too fast vs observation -> corrected
  rc.tick(10.1, 0, 'racing');
  assert.strictEqual(rc.cars.b.lap, 1);
  assert.strictEqual(rc.cars.b.lapTimes[0], 41.2);
  assert.strictEqual(rc.corrected, 1);
  rc.observe('a', { lapTimes: [{ lap: 1, time: 45 }], raceDist: 805 }, 11);
  rc.tick(16, 0, 'racing');
  assert.strictEqual(rc.cars.a.lap, 1, 'lap credited from observation');
});

/* ------------------------------------------------------------------ drift battle */
test('two-player tandem drift battle: lead/chase swap, per-run scores, host ranking', function () {
  var env = setup({ n: 1, host: { mode: 'drift', trackId: null, drift: { format: 'tandem', runs: 2, runTime_s: 12, startDelay_s: 2, interRun_s: 3 } } });
  var roles = {};
  // scripted scorer totals per car and run (real drift physics is covered by the drift tests; here we test the battle plumbing)
  var SCORE = { host: [1000, 2500], pa: [1800, 900] };
  function inject(s) {
    var S = s._debug().sim && s._debug().sim.s, id = s.netState().carId, run = s.netState().run;
    if (!S || S._inj) return;
    S._inj = true;
    var v = function () { return SCORE[id][run]; };
    S.scorerState = function () { return { total: v() }; };
    var orr = S.results;
    S.results = function () { var rr = orr.call(S); rr.drift = Object.assign({}, rr.drift, { total: v() }); return rr; };
  }
  env.step(60 * 60, function (f, all) {
    all.forEach(inject);
    if (f % 20 === 0) all.forEach(function (s, i) {
      var sn = s.snapshot();
      finiteDeep(sn, 'drift snap');
      var b = sn.net.battle;
      if (b) (roles[i] = roles[i] || {})[b.run] = b.role;
    });
    return all.length === 2 && all.every(function (s) { return s.isFinished(); });
  });
  assert.deepStrictEqual(roles[0], { 0: roles[0][0], 1: roles[0][0] === 'lead' ? 'chase' : 'lead' }, 'host swaps roles');
  assert.notStrictEqual(roles[0][0], roles[1][0], 'opposite roles in run 1');
  var rh = env.host.results(), rcl = env.clients[0].results();
  assert.ok(rh.complete && rcl.complete);
  assert.strictEqual(rh.battle.format, 'tandem');
  assert.strictEqual(rh.battle.runs.length, 2);
  rh.battle.runs.forEach(function (run) { Object.keys(run.scores).forEach(function (id) { assert.ok(run.scores[id] >= 0, 'score for run ' + run.run); }); });
  var ids = rh.classification.map(function (c) { return c.netId; });
  assert.deepStrictEqual(rcl.classification.map(function (c) { return c.netId; }), ids);
  rh.classification.forEach(function (c) {
    var sum = c.runScores.reduce(function (s, v) { return s + (v || 0); }, 0);
    assert.strictEqual(c.score, sum, 'total = sum of runs');
  });
  assert.deepStrictEqual(rh.classification.map(function (c) { return [c.netId, c.score]; }), [['host', 3500], ['pa', 2700]]);
  assert.deepStrictEqual(rh.battle.runs.map(function (run) { return [run.scores.host, run.scores.pa]; }), [[1000, 1800], [2500, 900]]);
  assert.strictEqual(rh.battle.winnerId, 'player', 'host sees itself as the winner');
  assert.strictEqual(rcl.battle.winnerId, 'host');
  assert.strictEqual(rh.drift.total, rh.classification.filter(function (c) { return c.isPlayer; })[0].score);
});

test('drift battle with >2 players runs a simultaneous score attack', function () {
  var plan = NR._internal.driftPlan({ format: 'auto', runTime_s: 10 }, ['a', 'b', 'c']);
  assert.strictEqual(plan.format, 'attack');
  assert.strictEqual(plan.runs, 1);
  var dc = new NR._internal.DriftControl(plan, [{ carId: 'a', kind: 'human', name: 'A' }, { carId: 'b', kind: 'human', name: 'B' }, { carId: 'c', kind: 'human', name: 'C' }]);
  dc.submit('a', 0, 1200); dc.submit('b', 0, 5400); dc.submit('c', 0, 300);
  dc.tick(plan.endAll() + 1);
  assert.ok(dc.ended);
  var res = dc.results(true);
  assert.deepStrictEqual(res.classification.map(function (c) { return c.id; }), ['b', 'a', 'c']);
  assert.strictEqual(res.battle.winnerId, 'b');
});

/* ------------------------------------------------------------------ free roam + late join */
test('free roam: a late joiner gets a reserved car slot and appears for everyone', function () {
  var env = setup({ n: 1, host: { mode: 'free' } });
  env.step(60 * 6);
  var late = env.net.connect({ id: 'pz', skew: 700 });
  NR.waitForStart(late, function (st) { env.clients.push(NR.createClientSession(late, { start: st, build: preset(4), name: 'Late', autopilot: true })); });
  env.step(60 * 6);
  assert.strictEqual(env.clients.length, 2);
  var lj = env.clients[1];
  assert.ok(!lj.netState().spectator, 'late joiner drives');
  var id = lj.netState().carId;
  assert.ok(/^r\d+$/.test(id), 'reserved slot id ' + id);
  var seen = env.clients[0].snapshot().cars.filter(function (c) { return c.netId === id; })[0];
  assert.ok(seen && !seen.ghost, 'visible to the earlier client');
  var hs = env.host.snapshot().cars.filter(function (c) { return c.netId === id; })[0];
  assert.ok(hs, 'visible to the host');
  assert.ok(Math.hypot(hs.x - lj.snapshot().cars.filter(function (c) { return c.isPlayer; })[0].x, 0) < 60);
  assert.notStrictEqual(env.host.snapshot().phase, 'finished');
});

test('race: a late joiner spectates (follows the leader) without disturbing the grid', function () {
  var env = setup({ n: 1, host: { mode: 'race' } });
  env.step(60 * 12);
  var late = env.net.connect({ id: 'pz' });
  NR.waitForStart(late, function (st) { env.clients.push(NR.createClientSession(late, { start: st, build: preset(2), name: 'Spec' })); });
  env.step(60 * 4);
  var sp = env.clients[1];
  assert.ok(sp.netState().spectator);
  var sn = sp.snapshot();
  assert.strictEqual(sn.cars.length, 2);
  assert.strictEqual(sn.cars.filter(function (c) { return c.isPlayer; }).length, 1);
  assert.strictEqual(sn.phase, 'racing');
  assert.strictEqual(env.host.snapshot().cars.length, 2);
});

test('engine-session surface for race-ui', function () {
  var env = setup({ n: 1, host: { mode: 'race' } });
  env.step(30);
  [env.host, env.clients[0]].forEach(function (s) {
    ['update', 'snapshot', 'results', 'restart', 'destroy', 'netState', 'resetPlayerToTrack', 'getPhase', 'playerState'].forEach(function (k) { assert.strictEqual(typeof s[k], 'function', k); });
    assert.ok(s.geom && s.trackDef, 'geom + trackDef');
    assert.strictEqual(s.restart(), s);
    assert.strictEqual(typeof s.simulate, 'undefined', 'no simulate(): race-ui must not fast-forward a net race');
    var ns = s.netState();
    finiteDeep(ns, 'netState');
    assert.ok(ns.players.length === 2);
  });
  // edge-triggered input is latched until a substep actually runs
  var steps = env.clients[0].update(0, { shiftUp: true });
  assert.strictEqual(steps, 0);
});

/* ------------------------------------------------------------------ standalone */
if (local) {
  (async function () {
    var fails = 0;
    for (var i = 0; i < queue.length; i++) {
      var t0 = Date.now();
      try { await queue[i].fn(); console.log('  ok  ' + queue[i].name + ' (' + (Date.now() - t0) + 'ms)'); }
      catch (e) { fails++; console.log('  FAIL ' + queue[i].name + '\n    ' + (e && e.stack || e)); }
    }
    console.log(fails ? fails + ' failed' : 'all passed');
    process.exit(fails ? 1 : 0);
  })();
}

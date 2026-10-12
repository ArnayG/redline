/* Arcade mode (docs/ARCADE-SPEC.md): arcade vehicle model, AI arcade laps on every circuit, determinism / replay meta,
   CB.arcade.mode core, race-ui arcade settings isolation, route / menu presence, Race & Drift unchanged. */
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js', 'js/race/vehicle.js',
 'js/race/ai.js', 'js/race/engine.js', 'js/race/drift/assist.js', 'js/game/replay.js', 'js/arcade/mode.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, V = CB.race.vehicle, E = CB.race.engine, M = CB.arcade.mode;
var DEG = 180 / Math.PI;

var standalone = require.main === module || typeof globalThis.test !== 'function';
var passed = 0;
function test(name, fn) {
  if (!standalone) return globalThis.test('arcade: ' + name, fn);
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
function build() { return CB.data.defaultBuild(); }
function bodyBeta(s) { return s.speed > 3 ? Math.atan2(s.vy, Math.abs(s.vx)) : 0; }
function trackIds() { var l = typeof CB.race.tracks.list === 'function' ? CB.race.tracks.list() : CB.race.tracks.list; return l.map(function (t) { return t.id; }); }

var P_SIM = V.fromBuild(build());
var P_ARC = V.fromBuild(build(), null, { handling: 'arcade' });

test('fromBuild: arcade params carry the arcade envelope, simulation params are untouched', function () {
  assert.strictEqual(P_ARC.handling, 'arcade');
  assert.ok(P_ARC.arcade && P_ARC.arcade.latG >= 1.2 && P_ARC.arcade.brakeG >= 1.25);
  assert.ok(P_ARC.maxLatG > P_SIM.maxLatG);
  assert.notStrictEqual(P_SIM.handling, 'arcade');
  assert.strictEqual(P_SIM.arcade, undefined);
  var W = V.withHandling(P_SIM, 'arcade');
  assert.strictEqual(W.handling, 'arcade');
  assert.ok(Math.abs(W.maxLatG - P_ARC.maxLatG) < 1e-9);
  assert.strictEqual(V.withHandling(P_SIM, 'sim'), P_SIM);
  // a sim car's launch is exactly what it was (no arcade code path)
  var a = V.simulateLaunch(P_SIM, 100).t, b = V.simulateLaunch(V.fromBuild(build()), 100).t;
  assert.strictEqual(a, b);
});

test('no slip / no spin: full throttle + full lock at 60..300 km/h', function () {
  [17, 30, 50, 70, 83].forEach(function (v0) {
    [1, -1].forEach(function (dir) {
      var s = V.createState(P_ARC, { speed: v0 }), maxB = 0, maxSpin = 0, yawMax = 0;
      for (var i = 0; i < 120 * 5; i++) {
        V.step(P_ARC, s, { throttle: 1, steer: dir }, 1 / 120, { gripMult: 1 });
        maxB = Math.max(maxB, Math.abs(bodyBeta(s))); maxSpin = Math.max(maxSpin, s.wheelspin, s.skidding);
        yawMax = Math.max(yawMax, Math.abs(s.yawRate));
      }
      assert.ok(maxB * DEG < 1.0, 'beta ' + (maxB * DEG).toFixed(2) + ' deg at ' + v0);
      assert.ok(maxSpin < 0.01, 'wheelspin / skid ' + maxSpin);
      assert.ok(Math.abs(s.gLat) > 1.1 && Math.abs(s.gLat) < 2.2, 'lateral g ' + s.gLat);
      assert.ok(s.speed > 10 && isFinite(s.x), 'still driving');
      assert.ok(Math.sign(s.yawRate) === dir, 'turning the way it was steered');
    });
  });
});

test('steering is proportional (analog input) and speed sensitive', function () {
  function yawAt(v, steer) { var s = V.createState(P_ARC, { speed: v }); for (var i = 0; i < 240; i++) V.step(P_ARC, s, { throttle: 0.3, steer: steer }, 1 / 120, {}); return s.yawRate; }
  var r25 = yawAt(40, 0.25), r50 = yawAt(40, 0.5), r100 = yawAt(40, 1);
  assert.ok(r25 > 0 && r50 > r25 * 1.7 && r50 < r25 * 2.3, 'half input ~ twice the quarter input');
  assert.ok(r100 > r50 * 1.7);
  assert.ok(V.arcadeCurvatureLimit(P_ARC, 80) < V.arcadeCurvatureLimit(P_ARC, 20) / 8, 'less lock per input at speed');
});

test('braking: strong, straight, never locks (even while steering)', function () {
  var s = V.createState(P_ARC, { speed: 250 / 3.6 }), t = 0, maxB = 0, locked = false;
  while (s.speed > 0.3 && t < 10) { V.step(P_ARC, s, { brake: 1, steer: 0.4 }, 1 / 60, {}); t += 1 / 60; if (s.speed > 16) maxB = Math.max(maxB, Math.abs(bodyBeta(s))); /* below ~15 m/s the slip is kinematic geometry */ locked = locked || s.wheels.some(function (w) { return w.locked; }); }
  assert.ok(t < 5.5, '250-0 in ' + t.toFixed(2) + ' s');
  assert.ok(maxB * DEG < 1.0);
  assert.ok(!locked);
  var s2 = V.createState(P_ARC, { speed: 200 / 3.6 }), h0 = s2.heading, d = 0;
  while (s2.speed > 0.3 && d < 600) { V.step(P_ARC, s2, { brake: 1 }, 1 / 120, {}); d++; }
  assert.ok(Math.abs(s2.heading - h0) < 1e-6 && Math.abs(s2.y) < 1e-6, 'dead straight');
});

test('launch: no wheelspin, quicker than the sim, power / weight still separate builds', function () {
  var s = V.createState(P_ARC, {}), maxSpin = 0;
  for (var i = 0; i < 240; i++) { V.step(P_ARC, s, { throttle: 1 }, 1 / 120, {}); maxSpin = Math.max(maxSpin, s.wheelspin); }
  assert.strictEqual(maxSpin, 0);
  assert.ok(V.simulateLaunch(P_ARC, 100).t < V.simulateLaunch(P_SIM, 100).t);
  var heavy = build(); heavy.body = Object.assign({}, heavy.body);
  var pHeavy = V.withHandling(Object.assign({}, P_ARC, { mass: P_ARC.mass * 1.5, Iz: P_ARC.Iz * 1.5, handling: 'sim', arcade: undefined }), 'arcade');
  assert.ok(V.simulateLaunch(pHeavy, 100).t > V.simulateLaunch(P_ARC, 100).t * 1.15, 'weight matters');
});

test('off-road: grass slows the car but never spins it', function () {
  var s = V.createState(P_ARC, { speed: 45 }), maxB = 0;
  for (var i = 0; i < 360; i++) { V.step(P_ARC, s, { throttle: 0.6, steer: i < 180 ? 1 : -1 }, 1 / 120, { gripMult: 0.58, surface: 'grass' }); maxB = Math.max(maxB, Math.abs(bodyBeta(s))); }
  assert.ok(maxB * DEG < 1.0);
  assert.ok(s.speed < 45);
});

test('collisions: a big yaw kick straightens out instead of spinning', function () {
  var s = V.createState(P_ARC, { speed: 40 });
  s.yawRate = 1.6; s.vy = 6;
  var h0 = s.heading;
  for (var i = 0; i < 120; i++) V.step(P_ARC, s, { throttle: 1 }, 1 / 120, {});
  assert.ok(Math.abs(s.yawRate) < 0.05 && Math.abs(bodyBeta(s)) * DEG < 1, 'recovered');
  assert.ok(Math.abs(s.heading - h0) < 0.6, 'less than ~35 deg of rotation');
});

test('powerslide: handbrake + steer holds a bounded angle, keeps speed, recovers', function () {
  var s = V.createState(P_ARC, { speed: 30 }), maxB = 0, v0 = s.speed;
  for (var i = 0; i < 240; i++) { V.step(P_ARC, s, { throttle: 1, steer: 0.8, handbrake: i < 180 }, 1 / 120, {}); maxB = Math.max(maxB, Math.abs(bodyBeta(s))); if (i === 150) assert.ok(s.powerslide && s.slideTime > 1); }
  assert.ok(maxB * DEG > 15 && maxB * DEG < 32, 'slide angle ' + (maxB * DEG).toFixed(1));
  assert.ok(s.speed > v0 * 0.9);
  assert.ok(Math.abs(bodyBeta(s)) * DEG < 2 && !s.powerslide);
});

test('spinOut: a cartoon 360 that keeps the travel direction, then full control', function () {
  var s = V.createState(P_ARC, { speed: 40, heading: 0.3 });
  V.spinOut(P_ARC, s, { duration: 1, dir: 1, speedLoss: 0.5 });
  var turned = 0, prev = s.heading;
  for (var i = 0; i < 150; i++) {
    V.step(P_ARC, s, { throttle: 1, steer: 1 }, 1 / 120, {});
    var d = s.heading - prev; if (d < -Math.PI) d += 2 * Math.PI; if (d > Math.PI) d -= 2 * Math.PI; turned += d; prev = s.heading;
  }
  assert.strictEqual(s.spin, null);
  assert.ok(Math.abs(turned - 2 * Math.PI) < 0.35, 'turned ' + turned);
  var dir = Math.atan2(s.y, s.x);
  assert.ok(Math.abs(dir - 0.3) < 0.15, 'travel direction kept');
});

test('env.arcade boost / push / topSpeedMult', function () {
  function v(env, n) { var s = V.createState(P_ARC, { speed: 20 }); for (var i = 0; i < (n || 360); i++) V.step(P_ARC, s, { throttle: 1 }, 1 / 120, env); return s; }
  var base = v({}).speed, boost = v({ arcade: { boost: 1.5 } }), push = v({ arcade: { push: 6 } }).speed;
  assert.ok(boost.speed > base + 1 && boost.boosting);
  assert.ok(push > base + 5);
  var r = V.arcadeResponse(P_ARC, 30, { throttle: 1, steer: 0.5 });
  assert.ok(r.accelLong > 0 && r.curvature > 0 && Math.abs(r.yawRate - 30 * r.curvature) < 1e-9 && r.maxLatAccel > 11);
  assert.ok(V.arcadeResponse(P_ARC, 30, { brake: 1 }).accelLong < -12);
});

test('engine: handling flag, every car arcade, deterministic with the same seed, separate ghost key', function () {
  function run(seed) {
    var s = E.createSession({ trackId: 'little-anvil', laps: 1, opponents: 3, playerBuild: build(), playerAutopilot: true, handling: 'arcade', seed: seed, persistGhost: false });
    for (var i = 0; i < 600; i++) s.update(0.05, {});
    return s;
  }
  var a = run(3), b = run(3);
  var sa = a.snapshot(), sb = b.snapshot();
  assert.strictEqual(sa.handling, 'arcade');
  assert.strictEqual(a.results().handling, 'arcade');
  assert.deepStrictEqual(sa.cars.map(function (c) { return [c.x, c.y, c.heading]; }), sb.cars.map(function (c) { return [c.x, c.y, c.heading]; }));
  var sim = E.createSession({ trackId: 'little-anvil', laps: 1, opponents: 1, playerBuild: build(), seed: 3 });
  assert.strictEqual(sim.snapshot().handling, 'sim');
  assert.notStrictEqual(sim.config.handling, 'arcade');
});

test('AI: arcade laps on every circuit, zero off-track, zero wall hits', function () {
  trackIds().forEach(function (id) {
    var s = E.createSession({ trackId: id, laps: 1, opponents: 2, difficulty: 'pro', playerBuild: build(), playerAutopilot: true, handling: 'arcade', seed: 7, persistGhost: false });
    var off = 0, walls = 0, t = 0;
    while (t < 600) {
      s.update(0.1, {}); t += 0.1;
      var sn = s.snapshot();
      sn.cars.forEach(function (c) { if (c.onTrack === false) off++; });
      sn.events.forEach(function (e) { if (e.type === 'wall') walls++; });
      if (sn.cars.every(function (c) { return c.finished; })) break;
    }
    var r = s.results(), rows = r.classification || r.rows || r.cars || [];
    assert.ok(rows.length >= 3 && rows.every(function (x) { return !x.dnf && x.bestLap_s > 0; }), id + ': every car set a lap');
    assert.strictEqual(off, 0, id + ': off-track samples');
    assert.strictEqual(walls, 0, id + ': wall hits');
  });
});

test('replay: recorder stores handling meta and playback snapshots carry it', function () {
  var s = E.createSession({ trackId: 'little-anvil', laps: 1, opponents: 1, playerBuild: build(), playerAutopilot: true, handling: 'arcade', seed: 9, persistGhost: false });
  var rec = CB.game.replay.createRecorder(s, {});
  for (var i = 0; i < 200; i++) { s.update(0.05, {}); rec.capture(s.snapshot()); }
  var rep = rec.finish();
  assert.strictEqual(rep.meta.handling, 'arcade');
  var back = CB.game.replay.deserialize(CB.game.replay.serialize(rep));
  assert.strictEqual(back.meta.handling, 'arcade');
  assert.strictEqual(CB.game.replay.snapshotAt(back, 2).handling, 'arcade');
});

test('CB.arcade.mode: settings, stunt tracks first, extensions (options, env hooks, snapshot)', function () {
  var S = M.sanitize({ laps: 99, mode: 'bogus', opponents: 0, steerAssist: 'light' });
  assert.strictEqual(S.laps, 20); assert.strictEqual(S.mode, 'race'); assert.strictEqual(S.opponents, 1); assert.strictEqual(S.steerAssist, 'light');
  var hadStunt = CB.arcade.stunt;
  CB.arcade.stunt = hadStunt || { list: function () { return [{ id: 'stub-loop', name: 'Stub Loop', kind: 'stunt' }]; }, createSession: function () { return null; } };
  var entries = M.trackEntries([{ id: 'c1', name: 'C1' }]);
  assert.strictEqual(entries[0].kind, 'stunt');
  assert.strictEqual(entries[entries.length - 1].id, 'c1');
  if (!hadStunt) delete CB.arcade.stunt;
  var calls = 0;
  var off = M.registerExtension({ id: 'test-ext', options: [{ id: 'speedClass', name: 'Class', choices: [{ id: 'a' }, { id: 'b' }], default: 'b' }],
    create: function (ctx) {
      assert.strictEqual(typeof ctx.rng, 'function');
      return { hooks: { vehicleEnv: function (car, env) { calls++; return Object.assign({}, env, { arcade: { boost: 1.3 } }); } }, snapshot: function () { return { ok: true }; } };
    } });
  try {
    assert.strictEqual(M.sanitize({}).options.speedClass, 'b');
    var s = M.createSession({ trackId: 'little-anvil', laps: 1, opponents: [], playerBuild: build(), seed: 1, persistGhost: false });
    for (var i = 0; i < 40; i++) s.update(0.05, { throttle: 1 });
    var sn = s.snapshot();
    assert.strictEqual(sn.handling, 'arcade');
    assert.deepStrictEqual(sn.arcade.ext['test-ext'], { ok: true });
    assert.ok(calls > 0);
    assert.strictEqual(s.results().handling, 'arcade');
  } finally { off(); }
});

test('CB.race.assist: arcade cars keep the full arcade lock at speed (no sim slip limiter)', function () {
  var A = CB.race.assist.create({ level: 'heavy', mode: 'race' });
  var s = V.createState(P_ARC, { speed: 70 });
  var out;
  for (var i = 0; i < 90; i++) out = A.filter({ up: true, left: true }, s, { dt: 1 / 60, params: P_ARC });
  assert.ok(out.steer > 0.8, 'steer ' + out.steer);
  assert.ok(out.throttle > 0.9, 'no slide throttle cut: ' + out.throttle);
});

test('race-ui: arcade settings live in settings.arcade, Race defaults untouched', function () {
  var ui = require(path.join(root, 'js', 'race', 'race-ui.js'))._;
  var race = ui.sanitizeSettings({ trackId: 'forge-ring', laps: 5, opponents: 3, mode: 'race', arcade: { trackId: 'little-anvil', laps: 2, opponents: 9 } });
  var S = JSON.parse(JSON.stringify(race));
  ui.enterArcadeSettings(S, {});
  assert.strictEqual(S.discipline, 'arcade');
  assert.strictEqual(S.trackId, 'little-anvil'); assert.strictEqual(S.laps, 2); assert.strictEqual(S.opponents, 9);
  var a = ui.arcadeSettingsOf(S);
  assert.strictEqual(a.laps, 2);
  assert.strictEqual(race.laps, 5); assert.strictEqual(race.trackId, 'forge-ring'); assert.strictEqual(race.discipline, 'race');
  assert.strictEqual(ui.sanitizeSettings({}).discipline, 'race', 'the default discipline is still Race');
  assert.ok(ui.ARC_KEYS.indexOf('trackId') >= 0);
  var dl = JSON.parse(JSON.stringify(race)); ui.enterArcadeSettings(dl, { trackId: 'x', mode: 'time-trial' });
  assert.strictEqual(dl.trackId, 'x'); assert.strictEqual(dl.mode, 'time-trial');
});

test('route / menu / page: #/arcade is a top-level mode', function () {
  var router = require(path.join(root, 'js', 'router.js'));
  var R = (router && router._) ? router : CB.router;
  assert.ok(R.routes.indexOf('arcade') >= 0);
  assert.ok(R._.NAV.some(function (n) { return n.route === 'arcade' && n.label === 'Arcade'; }));
  var html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(/id="screen-arcade"/.test(html) && /js\/arcade\/mode\.js/.test(html));
  var hub = fs.readFileSync(path.join(root, 'js', 'game', 'hub.js'), 'utf8');
  assert.ok(/id: 'arcade', label: 'Arcade'/.test(hub));
});

if (standalone) console.log(passed + ' arcade tests passed');

/* F1 mode glue (docs/F1-SPEC.md §6-§7): settings sanitising, the 21-car single-spec grid, session configs for every
   circuit, grid order from qualifying, and a short engine race through the real hooks (22 cars, F1 snapshot data). */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js', 'js/f1/f1-teams.js', 'js/f1/f1-circuits.js',
 'js/race/vehicle.js', 'js/race/ai.js', 'js/race/engine.js', 'js/f1/f1-car.js', 'js/f1/f1-strategy.js', 'js/f1/f1-ai.js', 'js/f1/f1-hooks.js',
 'js/f1/f1-mode.js', 'js/f1/f1-weekend.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, M = CB.f1.mode, T = CB.f1.teams;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('f1-mode: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

test('sanitize: defaults and clamps', function () {
  var d = M.sanitize(null);
  assert.strictEqual(d.team, 'mclaren');
  assert.strictEqual(d.format, 'quick');
  assert.ok(M.circuit(d.circuitId), 'a valid default circuit');
  var s = M.sanitize({ team: 'nope', seat: 5, laps: 999, pct: 0, difficulty: 'godlike', weather: 'snow', format: 'season', startCompound: 'wet' });
  assert.strictEqual(s.team, 'mclaren');
  assert.strictEqual(s.seat, 0);
  assert.strictEqual(s.laps, 80);
  assert.strictEqual(s.pct, 5);
  assert.strictEqual(s.difficulty, 'amateur');
  assert.strictEqual(s.weather, 'dry');
  assert.strictEqual(s.format, 'season');
  assert.strictEqual(s.startCompound, 'medium');
});

test('circuits: the F1 calendar is served (not the Race circuits)', function () {
  var l = M.circuits();
  assert.ok(l.length >= 8, l.length + ' circuits');
  l.forEach(function (d) { assert.ok(d.f1, d.id + ' has F1 metadata'); var i = M.info(d); assert.ok(i.realLaps > 10 && i.realLength_m > 3000, d.id); });
  var monza = M.circuit('f1-monza');
  assert.strictEqual(M.raceLaps(monza, { kind: 'pct', pct: 100 }), M.info(monza).realLaps);
  assert.strictEqual(M.raceLaps(monza, { kind: 'laps', laps: 7 }), 7);
  assert.ok(M.raceLaps(monza, { kind: 'pct', pct: 10 }) >= 1);
});

test('entrants: 21 AI, every team twice minus the player seat, identical spec, chassis names', function () {
  var e = M.entrants({ playerTeam: 'ferrari', playerSeat: 1, difficulty: 'pro', seed: 3 });
  assert.strictEqual(e.length, 21);
  var ids = e.map(function (x) { return x.id; });
  assert.strictEqual(new Set(ids).size, 21);
  assert.ok(ids.indexOf('f1-lefevre') < 0, 'player took seat 2 at Ferrari');
  assert.ok(ids.indexOf('f1-marchetti') >= 0);
  e.forEach(function (x) {
    assert.ok(T.isF1Build(x.build));
    assert.strictEqual(x.build.body.model, 'f1-2026');
    assert.ok(x.skill >= 0.76 && x.skill <= 0.87, 'pro skill ' + x.skill);   // DIFF_SKILL.pro
    assert.strictEqual(x.carName, T.get(x.teamId).chassis);
    assert.ok(!/ferrari sf90/i.test(x.carName));
  });
  var rk = M.entrants({ playerTeam: 'ferrari', difficulty: 'rookie', seed: 3 });
  assert.ok(Math.max.apply(null, rk.map(function (x) { return x.skill; })) < 0.66);
});

test('sessionConfig: every circuit and session builds a launch', function () {
  M.circuits().forEach(function (d) {
    ['practice', 'qualifying', 'race'].forEach(function (sess) {
      var c = M.sessionConfig({ settings: { team: 'haas', circuitId: d.id, laps: 3 }, session: sess, seed: 11 });
      var L = c.launch;
      assert.strictEqual(L.trackId, d.id);
      assert.strictEqual(L.opponents.length, 21);
      assert.strictEqual(L.maxOpponents, 21);
      assert.strictEqual(L.context.kind, 'f1');
      assert.strictEqual(L.settings.mode, sess === 'race' ? 'race' : 'practice');
      if (sess === 'race') assert.strictEqual(L.settings.laps, 3); else assert.ok(L.maxTime_s > 60, d.id + ' ' + sess + ' timed');
      assert.ok(L.hooks.length === 1 && typeof L.hooks[0].setPlayerControls === 'function');
      assert.strictEqual(c.build.f1.teamId, 'haas');
      if (d.f1.night) assert.strictEqual(L.settings.timeOfDay, 'night');
    });
  });
});

test('grid order from qualifying: player slot and AI order follow the list', function () {
  var opps = M.entrants({ playerTeam: 'mclaren', seed: 1 });
  var order = opps.map(function (o) { return o.id; }).reverse();
  order.splice(4, 0, 'player');
  var c = M.sessionConfig({ settings: { team: 'mclaren' }, session: 'race', gridOrder: order, seed: 2 });
  assert.strictEqual(c.launch.gridOrder, 'given');
  assert.strictEqual(c.launch.startPosition, 5);
  assert.deepStrictEqual(c.launch.opponents.map(function (o) { return o.id; }), order.filter(function (id) { return id !== 'player'; }));
});

test('engine: a 22-car F1 race runs with F1 snapshot data and scores points', function () {
  var c = M.sessionConfig({ settings: { team: 'williams', circuitId: 'f1-red-bull-ring' }, session: 'race', laps: 1, seed: 9, playerName: 'Ari Novak' });
  var L = c.launch;
  var s = CB.race.engine.createSession(Object.assign({ trackId: L.trackId, playerBuild: c.build, playerAutopilot: true, playerName: 'Ari Novak' }, L.settings,
    { opponents: L.opponents, maxOpponents: 21, seed: L.seed, extras: L.extras, hooks: L.hooks, startPosition: L.startPosition }));
  var snap = s.snapshot();
  assert.strictEqual(snap.cars.length, 22);
  s.simulate(25, {});
  snap = s.snapshot();
  var me = snap.cars.filter(function (x) { return x.isPlayer; })[0];
  assert.ok(me.endurance && me.endurance.f1, 'endurance.f1 on snapshot cars');
  assert.ok(Array.isArray(me.endurance.f1.tyreWear) && me.endurance.f1.ers, 'tyres + ERS');
  assert.ok(me.speed > 20, 'player autopilot moving ' + me.speed);
  var sc = CB.f1.weekend.score(s.results(), { playerTeam: 'williams' });
  assert.strictEqual(sc.reduce(function (a, r) { return a + r.points; }, 0) >= 101, true);
  assert.strictEqual(sc.filter(function (r) { return r.isPlayer; })[0].teamId, 'williams');
  s = null; snap = null; L = null; c = null;   // release the session (the full suite runs near the heap limit)
});

test('time of day: circuit default (night races at night) unless the player picks one', function () {
  var nights = M.circuits().filter(function (d) { return d.timeOfDay === 'night' || (d.f1 && d.f1.night); });
  assert.ok(nights.length >= 1, 'night circuits exist');
  nights.forEach(function (d) {
    assert.strictEqual(M.sessionConfig({ settings: { circuitId: d.id }, session: 'race', seed: 1 }).launch.settings.timeOfDay, 'night', d.id);
    assert.strictEqual(M.sessionConfig({ settings: { circuitId: d.id, timeOfDay: 'day' }, session: 'race', seed: 1 }).launch.settings.timeOfDay, 'day', d.id + ' explicit');
  });
  assert.strictEqual(M.sanitize({}).timeOfDay, 'auto');
  assert.strictEqual(M.timeOfDayFor({ timeOfDay: 'night' }, 'auto'), 'night');
  assert.strictEqual(M.sessionConfig({ settings: { circuitId: 'f1-monza' }, session: 'race', seed: 1 }).launch.settings.timeOfDay, 'day');
});

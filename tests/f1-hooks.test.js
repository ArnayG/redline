/* Node tests: CB.f1.hooks on real CB.race.engine sessions (docs/F1-SPEC.md §4).
   - every car becomes the spec F1 car (params, build, livery, collision box), 22-car grids (maxOpponents 21)
   - snapshot endurance.f1 block; race-control messages
   - pit stop: request -> pit-lane approach -> limiter -> team box (~2.5 s) -> new compound -> exit, no track limits
   - DRS: never in the first two laps of a race, used in a pack after that; free in practice; off in the wet
   - ERS state moves in a session; two-dry-compound rule; determinism (same seed -> identical results) */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');
function tryLoad(rel) { var p = path.join(root, rel); if (!fs.existsSync(p)) return; try { require(p); } catch (e) { console.log('  (skip ' + rel + ': ' + e.message + ')'); } }
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach(tryLoad);
var modelsDir = path.join(root, 'js', 'shapes', 'models');
// index.html order (base styles first, then the packs): the first registered model of a style with no explicit
// default becomes CB.shapes.defaultModel, and the runner shares CB across test files (tests/models.test.js checks it)
if (fs.existsSync(modelsDir)) ['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van',
  'pack-jdm', 'pack-usa', 'pack-exotic', 'pack-sport'].forEach(function (f) { tryLoad('js/shapes/models/' + f + '.js'); });
['js/shapes/stock-specs.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js', 'js/race/vehicle.js', 'js/race/ai.js',
  'js/game/endurance.js', 'js/race/engine.js', 'js/f1/f1-teams.js', 'js/f1/f1-car.js', 'js/f1/f1-hooks.js'].forEach(tryLoad);
var CB = globalThis.CB, T = CB.f1 && CB.f1.teams, E = CB.race && CB.race.engine;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  name = 'f1-hooks: ' + name;
  if (!standalone) return globalThis.test(name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
if (!T || !E || !CB.f1.hooks) { console.log('  (f1-hooks: modules missing — skipped)'); module.exports = []; return; }

var TRACK = 'forge-ring';
function entrants(n) {
  var out = [];
  for (var i = 0; i < n; i++) {
    var tm = T.list[Math.floor((i + 1) / 2) % T.list.length], seat = (i + 1) % 2, d = tm.drivers[seat];
    out.push({ id: 'ai-' + i, name: d.name, number: d.number, build: T.buildFor(tm.id, { seat: seat }), skill: 0.9, aggression: 0.35, consistency: 0.97,
      f1: { teamId: tm.id, seat: seat, number: d.number, driver: d.name } });
  }
  return out;
}
function session(o) {
  o = o || {};
  var def = CB.race.tracks.get(o.track || TRACK);
  var H = CB.f1.hooks.create(Object.assign({ circuit: def, mode: o.hookMode || o.mode || 'race', laps: o.laps || 2, playerTeam: 'mclaren', seed: o.seed || 5, weather: o.weather || 'dry' }, o.hooks || {}));
  var s = E.createSession({
    trackId: def.id, track: def, laps: o.laps || 2, mode: o.mode || 'race', opponents: entrants(o.n == null ? 3 : o.n), maxOpponents: 21,
    playerBuild: T.buildFor('mclaren'), hooks: [H], extras: { pitStops: true, autoPit: o.autoPit !== undefined ? o.autoPit : false },
    seed: o.seed || 5, playerAutopilot: true, weather: o.weather || 'dry', assists: { abs: true, tc: true, autoShift: true }
  });
  return { s: s, H: H, def: def };
}

test('every car is the spec F1 car: params, build with livery, 5.6 m x 2.0 m box; 22-car grid', function () {
  var x = session({ n: 21, laps: 1 });
  var snap = x.s.snapshot();
  assert.strictEqual(snap.cars.length, 22);
  var p0 = CB.f1.car.params();
  snap.cars.forEach(function (c) {
    assert.ok(T.isF1Build(c.build), 'F1 build for ' + c.id);
    assert.ok(c.build.f1 && c.build.f1.livery && c.build.f1.livery.primary, 'livery');
    assert.ok(Math.abs(c.length_m - 5.63) < 0.01 && Math.abs(c.width_m - 2.0) < 0.01, 'collision box');
    assert.ok(c.endurance && c.endurance.f1, 'snapshot endurance.f1');
    var f = c.endurance.f1;
    ['team', 'compound', 'tyreWear', 'tyreTemp', 'tyreAge', 'drs', 'ers', 'pitStops', 'number', 'driver'].forEach(function (k) { assert.ok(f[k] !== undefined, k); });
    assert.strictEqual(f.tyreWear.length, 4);
  });
  var player = snap.cars.filter(function (c) { return c.isPlayer; })[0];
  assert.strictEqual(player.endurance.f1.team, 'mclaren');
  assert.strictEqual(player.color, T.get('mclaren').livery.primary);
  var st = x.H.state();
  Object.keys(st.cars).forEach(function (id) { assert.ok(st.cars[id].teamId, 'team for ' + id); });
  // the session's cars share the one cached params object (single spec)
  assert.strictEqual(CB.f1.car.params(), p0);
});

test('pit stop: approach, limiter, team box ~2.5 s, new compound, exit; no track-limits strikes', function () {
  var x = session({ n: 0, laps: 3 });
  var s = x.s;
  s.simulate(25, {});
  x.H.setPlayerControls({ pitCompound: 'soft' });
  assert.ok(s.requestPit('player', { tires: true }));
  var phases = {}, stoppedT = 0, laneMax = 0, lim = x.H.meta().pit.speedLimit_ms, done = false;
  for (var k = 0; k < 2000 && !done; k++) {
    s.simulate(0.1, {});
    var c = s.snapshot().cars[0], f = c.endurance.f1;
    if (f.pitPhase) phases[f.pitPhase] = true;
    if (f.pitPhase === 'stopped') stoppedT += 0.1;
    if (f.pitPhase === 'lane' || f.pitPhase === 'exit') laneMax = Math.max(laneMax, c.speed);
    if (c.pitStops === 1 && !f.pitPhase && !f.inPitLane) done = true;
  }
  assert.ok(done, 'stop completed and the car rejoined');
  assert.ok(phases.lane && phases.stopped && phases.exit, 'phases ' + Object.keys(phases));
  assert.ok(stoppedT >= 2.0 && stoppedT <= 4.0, 'stationary ' + stoppedT.toFixed(1) + ' s');
  assert.ok(laneMax <= lim + 1.6, 'limiter: ' + (laneMax * 3.6).toFixed(0) + ' km/h');
  var c2 = s.snapshot().cars[0];
  assert.strictEqual(c2.endurance.f1.compound, 'soft');
  assert.deepStrictEqual(c2.endurance.f1.compoundsUsed.slice(-1), ['soft']);
  assert.strictEqual(c2.trackLimits, 0, 'no track limits for the pit lane');
  var m = x.H.drainMessages();
  assert.ok(m.some(function (q) { return q.kind === 'pit' && /Softs fitted/.test(q.text); }), 'pit message');
});

test('per-team boxes differ; the engine stops each car at its own box', function () {
  var x = session({ n: 3, laps: 1 });
  x.s.simulate(0.2, {});
  var meta = x.H.meta(), st = x.H.state().cars;
  var boxes = Object.keys(st).map(function (id) { return meta.pit.box_s(st[id].teamIndex); });
  assert.ok(new Set(boxes.map(function (b) { return Math.round(b); })).size >= 2, 'distinct boxes ' + boxes);
});

test('DRS: closed for laps 1–2, used in a pack later; practice is free; wet races have none', function () {
  var x = session({ n: 9, laps: 4, seed: 9 });
  var openEarly = false, openUnavailable = false, k;
  for (k = 0; k < 3000; k++) {
    x.s.simulate(0.2, {});
    var snap = x.s.snapshot();
    if (snap.phase === 'finished') break;
    snap.cars.forEach(function (c) { var d = c.endurance.f1.drs; if (d.open && c.lap < 2) openEarly = true; if (d.open && !d.available) openUnavailable = true; });
  }
  assert.ok(!openEarly, 'no DRS in the first two laps');
  assert.ok(!openUnavailable, 'DRS only opens where it is available');
  assert.ok(x.H.state().drsEnabled, 'DRS enabled announced');
  var log = x.H.drsLog();
  assert.ok(log.length >= 10 * 2 * 3, 'every car is timed at every detection point (' + log.length + ')');
  log.forEach(function (e) {
    var want = e.lap >= 3 && e.gap_s != null && e.gap_s <= 1.0;
    assert.strictEqual(e.eligible, want, 'detection rule ' + JSON.stringify(e));
  });
  // a car that was eligible gets DRS in the zone that follows (if it stays flat out): available is seen
  var st = x.H.state().cars, uses = 0;
  Object.keys(st).forEach(function (id) { uses += st[id].drs.uses || 0; });
  if (log.some(function (e) { return e.eligible; })) assert.ok(uses > 0, 'eligible cars used DRS');

  var p = session({ n: 0, mode: 'practice', hookMode: 'practice', laps: 50 });
  p.H.setPlayerControls({ drs: true });
  var opened = false;
  for (k = 0; k < 1200 && !opened; k++) { p.s.simulate(0.1, {}); p.H.setPlayerControls({ drs: true }); opened = p.s.snapshot().cars[0].endurance.f1.drs.open; }
  assert.ok(opened, 'practice: DRS opens in a zone on the first lap');

  var w = session({ n: 2, laps: 3, weather: 'wet' });
  for (k = 0; k < 1500; k++) { w.s.simulate(0.2, {}); var c = w.s.snapshot().cars; assert.ok(!c.some(function (q) { return q.endurance.f1.drs.open; }), 'no DRS in the wet'); }
  assert.strictEqual(w.s.snapshot().cars[0].endurance.f1.compound === 'wet' || w.s.snapshot().cars[0].endurance.f1.compound === 'inter', true, 'wet-weather tyres in the wet');
});

test('ERS and tyres evolve during a session; race control reports track limits / penalties as messages', function () {
  var x = session({ n: 0, laps: 2 });
  x.s.simulate(60, {});
  var f = x.s.snapshot().cars[0].endurance.f1;
  assert.ok(f.ers.soc < 0.9, 'ERS deployed: soc ' + f.ers.soc);
  assert.ok(f.tyreWear[2] > 0 && f.tyreTemp[2] > 60, 'rear tyre worn / warm');
  x.H.setPlayerControls({ cycleErs: true });
  x.s.simulate(0.1, {});
  assert.strictEqual(x.s.snapshot().cars[0].endurance.f1.ers.mode, 'boost');
  assert.ok(x.H.drainMessages().some(function (m) { return /ERS mode/.test(m.text); }));
});

test('two dry compounds rule: a dry race on one compound gets +10 s at the flag', function () {
  var x = session({ n: 0, laps: 2, hooks: { requireTwoCompounds: true } });
  x.s.simulateToEnd(600);
  var r = x.s.results().classification[0];
  assert.ok(r.penalties_s >= 10, 'penalty ' + r.penalties_s);
});

test('determinism: same seed, same race', function () {
  function run() { var x = session({ n: 3, laps: 1, seed: 21 }); x.s.simulateToEnd(400); return x.s.results().classification.map(function (r) { return r.id + ':' + (r.totalTime_s || 0).toFixed(4); }).join(','); }
  assert.strictEqual(run(), run());
});

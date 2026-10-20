/* Node tests for js/f1/f1-teams.js (docs/F1-SPEC.md §1) and the engine hooks the F1 mode relies on
   (cfg.maxOpponents, wrapDriver, pitBox, pit lane never a track-limits excursion). */
'use strict';
var path = require('path');
var root = path.join(__dirname, '..');
require(path.join(root, 'js', 'util.js'));
require(path.join(root, 'js', 'data.js'));
var T = require(path.join(root, 'js', 'f1', 'f1-teams.js'));
require(path.join(root, 'js', 'race', 'tracks.js'));
require(path.join(root, 'js', 'race', 'vehicle.js'));
require(path.join(root, 'js', 'race', 'ai.js'));
var E = require(path.join(root, 'js', 'race', 'engine.js'));

test('f1 teams: 11 teams, 22 unique fictional drivers and numbers, hex liveries', function () {
  assert.equal(T.list.length, 11);
  var nums = {}, names = {};
  T.list.forEach(function (t) {
    assert.ok(t.id && t.name && t.short.length === 3);
    ['primary', 'secondary', 'accent', 'number', 'halo', 'wheel'].forEach(function (k) { assert.match(t.livery[k], /^#[0-9a-f]{6}$/i, t.id + ' ' + k); });
    assert.equal(t.drivers.length, 2);
    t.drivers.forEach(function (d) { assert.ok(!nums[d.number], 'dup number ' + d.number); nums[d.number] = 1; assert.ok(!names[d.name]); names[d.name] = 1; });
  });
  assert.equal(Object.keys(nums).length, 22);
});

test('f1 teams: buildFor makes an F1 build with livery + driver', function () {
  var b = T.buildFor('mclaren', { seat: 1, isPlayer: true, driverName: 'You', number: '99' });
  assert.ok(T.isF1Build(b));
  assert.equal(b.body.model, T.MODEL_ID);
  assert.equal(b.f1.teamId, 'mclaren'); assert.equal(b.f1.seat, 1); assert.equal(b.f1.number, '99'); assert.equal(b.f1.driver, 'You');
  assert.equal(b.exterior.paint, T.get('mclaren').livery.primary);
  assert.ok(!T.isF1Build(CB.data.defaultBuild()));
  assert.equal(T.buildFor('nope').f1.teamId, T.list[0].id);
});

test('engine: maxOpponents widens the grid, wrapDriver and pitBox hooks are called', function () {
  var opps = [];
  for (var i = 0; i < 21; i++) { var tm = T.list[Math.floor(i / 2) % 11]; opps.push({ id: 'f1-' + i, name: 'D' + i, build: T.buildFor(tm.id, { seat: i % 2 }), skill: 0.8, aggression: 0.3, consistency: 0.9 }); }
  var wrapped = 0, boxAsked = 0;
  var hook = {
    wrapDriver: function (drv) { wrapped++; return drv; },
    pitBox: function (car, info) { boxAsked++; return info.box_s; },
    pitStop: function () { return { duration_s: 2.5 }; }
  };
  var s = E.createSession({ trackId: 'forge-ring', laps: 2, mode: 'race', opponents: opps, maxOpponents: 21, hooks: [hook], seed: 7, extras: { pitStops: true } });
  var snap = s.snapshot();
  assert.equal(snap.cars.length, 22);
  assert.equal(wrapped, 21);
  var def = E.createSession({ trackId: 'forge-ring', laps: 1, mode: 'race', opponents: opps, seed: 7 });
  assert.equal(def.snapshot().cars.length, 12, 'default cap stays 11 opponents');
  s = def = null;   // release the 22-car session before the pit run (the runner shares one heap)
  // pit box: a small field is enough (the default car laps forge-ring in ~2.9 min, the lane is near the end of it)
  var p = E.createSession({ trackId: 'forge-ring', laps: 2, mode: 'race', opponents: opps.slice(0, 2), maxOpponents: 21, hooks: [hook], seed: 7, extras: { pitStops: true } });
  p.requestPit('f1-0');
  p.simulate(230, { throttle: 0 });
  assert.ok(boxAsked > 0, 'pitBox consulted while a car is in the lane');
  p = null;
});

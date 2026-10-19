/* Node tests: launch control, traction control and the standing start (race model ↔ Garage figure).
   - vehicle input.hold: the car is held on the line, the engine revs (launch control: its launch rpm + pre-spool)
   - the race model's staged 0–100 lands close to the Garage's (shared traction model, CB.physics.traction / metrics.launch)
   - traction control is a slip-target torque limiter: wheelspin held near the target, more power never launches slower
   - engine: throttle before lights-out is never a jump start (race / time trial / practice), the car does not creep,
     launches at GO; the classification's position-by-lap ends on the classified position (penalties applied) */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
function tryLoad(rel) {
  var p = path.join(root, rel);
  if (!fs.existsSync(p)) return false;
  try { require(p); return true; } catch (e) { console.log('  (skip ' + rel + ': ' + e.message + ')'); return false; }
}
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach(tryLoad);
var modelsDir = path.join(root, 'js', 'shapes', 'models');
if (fs.existsSync(modelsDir)) fs.readdirSync(modelsDir).filter(function (f) { return /\.js$/.test(f); }).sort().forEach(function (f) { tryLoad('js/shapes/models/' + f); });
['js/shapes/stock-specs.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/vehicle.js', 'js/race/ai.js', 'js/race/engine.js'].forEach(tryLoad);
var CB = globalThis.CB;

var standalone = require.main === module || typeof globalThis.test !== 'function';
var passed = 0, failed = 0;
function test(name, fn) {
  name = 'race-launch: ' + name;
  if (!standalone) return globalThis.test(name, fn);
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

var V = CB.race && CB.race.vehicle, E = CB.race && CB.race.engine, P = CB.physics, D = CB.data, K = CB.stock;
if (!V || !E || !P || !D) { console.log('  (race-launch: modules missing — skipped)'); module.exports = []; return; }
function norm(b) { return CB.state && CB.state.normalize ? CB.state.normalize(b) : b; }
function ref(patch) { return norm(CB.util.deepMerge(D.referenceBuild ? D.referenceBuild() : D.defaultBuild(), patch || {})); }
function paramsOf(b) { return V.fromBuild(b, P.compute(b)); }

test('metrics.launch and CB.physics.traction: the shared launch model is exported', function () {
  var m = P.compute(ref());
  assert.ok(m.launch && m.launch.rpm > 1000 && m.launch.driveRatioR > 1 && m.launch.tcForce > 0.9, JSON.stringify(m.launch));
  var Tx = P.traction;
  assert.ok(Tx && Tx.TC_SLIP.length === 4 && Tx.forceFraction(1) > 0.999, 'traction helpers');
  // TC levels: 2 sits on the peak; 3 is conservative; off (driver) gives the least
  assert.ok(Tx.tcForceFraction(2) > Tx.tcForceFraction(3) && Tx.tcForceFraction(3) > Tx.tcForceFraction(0) - 0.05);
  var p = paramsOf(ref());
  assert.ok(Math.abs(p.launchRpm - m.launch.rpm) < 1 && p.driveXR > 1, 'vehicle params carry the plan');
});

test('hold: the car is held on the line while the engine revs; launch control holds its launch rpm and pre-spools', function () {
  var p = paramsOf(ref({ transmission: { launchControl: true } }));
  var s = V.createState(p, { x: 0, y: 0, heading: 0 });
  for (var i = 0; i < 240; i++) V.step(p, s, { throttle: 1, brake: 0, steer: 0.6, hold: true }, 1 / 120, { gripMult: 1 });
  assert.ok(Math.hypot(s.x, s.y) < 1e-6 && s.speed === 0, 'did not move');
  assert.ok(Math.abs(s.rpm - p.launchRpm) < 60, 'rpm ' + s.rpm + ' vs launch ' + p.launchRpm);
  if (p.turbo) assert.ok(s.spool > 0.4, 'pre-spool ' + s.spool);
  assert.equal(s.gear, 1);
  // without launch control (manual): free revs up to the limiter, still held
  var pm = paramsOf(ref({ transmission: { type: 'manual', gears: 6, launchControl: false } }));
  var sm = V.createState(pm, { x: 0, y: 0, heading: 0 });
  for (var j = 0; j < 240; j++) V.step(pm, sm, { throttle: 1, hold: true }, 1 / 120, { gripMult: 1 });
  assert.ok(sm.rpm > pm.redline * 0.9 && sm.speed === 0, 'manual revs ' + sm.rpm);
  // released: it launches
  for (var k = 0; k < 120; k++) V.step(pm, sm, { throttle: 1 }, 1 / 120, { gripMult: 1 });
  assert.ok(sm.vx > 5, 'launched ' + sm.vx);
});

test('race 0–100 (staged) lands close to the Garage figure for every preset and stock spec', function () {
  var builds = D.presets.map(function (pr) { return ['preset:' + pr.id, norm(D.presetBuild(pr.id))]; });
  if (K && CB.shapes && CB.shapes.list) CB.shapes.list().filter(function (m) { return m.ref && K.has(m.id); }).forEach(function (m) { builds.push([m.id, K.build(m.id).build]); });
  var n = 0, close = 0, worst = 0, sum = 0, bad = [];
  builds.forEach(function (b) {
    var m = P.compute(b[1]); if (!(m.zeroTo100_s > 0)) return;
    var r = V.simulateLaunch(V.fromBuild(b[1], m), 100).t;
    assert.ok(r != null, b[0] + ' never reaches 100 km/h');
    var e = Math.abs(r - m.zeroTo100_s) / m.zeroTo100_s;
    n++; sum += e; worst = Math.max(worst, e); if (Math.abs(r - m.zeroTo100_s) <= 0.3) close++; else bad.push(b[0] + ' ' + m.zeroTo100_s + '/' + r.toFixed(2));
  });
  if (standalone) console.log('       ' + n + ' cars: mean |race-garage| ' + (sum / n * 100).toFixed(1) + ' %, worst ' + (worst * 100).toFixed(0) + ' %, within 0.3 s: ' + close + ' (' + bad.join(', ') + ')');
  assert.ok(sum / n < 0.05, 'mean deviation ' + (sum / n * 100).toFixed(1) + ' %');
  assert.ok(worst < 0.15, 'worst ' + (worst * 100).toFixed(0) + ' %');
  assert.ok(close >= n * 0.85, close + ' / ' + n + ' within 0.3 s: ' + bad.join(', '));
});

test('traction control: slip held near the target, TC never inverts the power ordering', function () {
  var hp = [300, 450, 600, 800, 1000];
  [0, 1, 2, 3].forEach(function (tc) {
    var prev = Infinity;
    hp.forEach(function (h) {
      var b = ref({ drivetrain: { tractionControl: tc }, transmission: { launchControl: false } });
      var m = P.compute(b), mm = Object.assign({}, m, { power_hp: h, power_kw: h * 0.7457 });
      mm.curve = m.curve.map(function (c) { return { rpm: c.rpm, nm: c.nm * h / m.power_hp, hp: c.hp * h / m.power_hp }; });
      var t = V.simulateLaunch(V.fromBuild(b, mm), 100).t;
      assert.ok(t != null && t <= prev + 0.02, 'TC' + tc + ' ' + h + ' hp: ' + t + ' (less power: ' + prev + ')');
      prev = t;
    });
  });
  // TC 2 on a 1000 hp RWD car: the driven wheels stay near the peak slip, no smoky launch
  var b2 = ref({ drivetrain: { tractionControl: 2 } }), m2 = P.compute(b2);
  var p2 = V.fromBuild(b2, Object.assign({}, m2, { curve: m2.curve.map(function (c) { return { rpm: c.rpm, nm: c.nm * 1.6 }; }) }));
  var s = V.createState(p2, { x: 0, y: 0, heading: 0 }), maxK = 0;
  for (var i = 0; i < 180; i++) V.step(p2, s, { throttle: 1, hold: true }, 1 / 120, { gripMult: 1 });
  for (var j = 0; j < 360; j++) { V.step(p2, s, { throttle: 1 }, 1 / 120, { gripMult: 1 }); if (s.vx > 6) maxK = Math.max(maxK, s.wheels[2].kappa / p2.kappaPeakR); }
  assert.ok(maxK < 2.2, 'rear slip ' + maxK.toFixed(2) + ' × peak');
});

function memStorage() { var m = {}; return { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } }; }
['race', 'time-trial', 'practice'].forEach(function (mode) {
  test(mode + ': full throttle through the countdown is no jump start, the car is held and leaves at GO', function () {
    var s = E.createSession({ mode: mode, trackId: 'forge-ring', opponents: mode === 'race' ? 3 : 0, laps: 1, seed: 5, storage: memStorage(), lightsOutDelay_s: 0.5 });
    var dbg = s._debug(), me = dbg.player, x0 = me.state.x, y0 = me.state.y, maxRpm = 0, events = [];
    var guard = 0;
    while (s.getPhase() !== 'racing' && guard++ < 120 * 30) {
      s.update(1 / 120, { throttle: 1, brake: 0, steer: 0.5 });
      maxRpm = Math.max(maxRpm, me.state.rpm);
      events = events.concat(s.snapshot().events || []);
    }
    assert.ok(Math.hypot(me.state.x - x0, me.state.y - y0) < 0.05, 'held on the line (moved ' + Math.hypot(me.state.x - x0, me.state.y - y0).toFixed(3) + ' m)');
    if (guard > 1) assert.ok(maxRpm > 2500, 'revved to ' + maxRpm.toFixed(0));   // (practice starts without lights)
    for (var i = 0; i < 240; i++) { s.update(1 / 120, { throttle: 1, steer: 0 }); events = events.concat(s.snapshot().events || []); }
    assert.ok(Math.abs(me.state.speed) > 8, 'launched at GO (' + me.state.speed.toFixed(1) + ' m/s)');
    var snapMe = s.snapshot().cars.filter(function (c) { return c.isPlayer; })[0];
    assert.ok(!snapMe.penalties_s, 'no penalty: ' + snapMe.penalties_s);
    assert.ok(!events.some(function (e) { return e.type === 'jumpstart'; }), 'no jump-start event');
    if (mode === 'race') s.snapshot().cars.forEach(function (c) { assert.ok(!c.jumpStart, c.name + ' no jump start'); });
  });
});

test('results: position-by-lap ends on the classified position (penalties applied)', function () {
  var s = E.createSession({ mode: 'race', trackId: 'little-anvil', opponents: 3, laps: 2, seed: 9, storage: memStorage(), playerAutopilot: true });
  s.simulateToEnd(600);
  s.results().classification.forEach(function (r) {
    if (r.status !== 'finished' || !r.positionsByLap.length) return;
    assert.equal(r.positionsByLap[r.positionsByLap.length - 1], r.position, r.name);
  });
});

if (standalone) console.log('\nrace-launch: ' + passed + ' passed, ' + failed + ' failed');

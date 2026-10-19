/* Node tests: race-AI robustness to the car it is given (mass / aero / grip variation, Real-car mass & aero).
   The AI plans from static estimates of the car (CB.race.ai estimateLimits) and corrects them online from what the car
   actually does (adaptive cornering + braking limits). These laps run the real race engine (walls, surfaces, the
   player-autopilot driver) for a sample of stock specs — heavy SUV, van, pickup, electric truck, hypercar, light
   roadster — with body.modelPhysics on (stock specs set it), on every circuit, plus the Range Rover "Overland" preset
   with +20 kg ballast at the Grünwald Ring (it used to leave the road there) and ±20 % mass the AI is not told about.
   Clean = completes the lap, < 1 s off track, no wall hits, no resets.  tools/ai-robustness.js is the full sweep. */
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
['js/shapes/stock-specs.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js', 'js/race/vehicle.js',
  'js/race/ai.js', 'js/race/engine.js'].forEach(tryLoad);
var CB = globalThis.CB;

var standalone = require.main === module || typeof globalThis.test !== 'function';
var passed = 0, failed = 0;
function test(name, fn) {
  name = 'race-ai-robust: ' + name;
  if (!standalone) return globalThis.test(name, fn);
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

var E = CB.race && CB.race.engine, T = CB.race && CB.race.tracks, K = CB.stock, D = CB.data;
if (!E || !T || !K || typeof K.build !== 'function' || !CB.physics || !(CB.shapes && CB.shapes.models)) {
  console.log('  (race-ai-robust: modules missing — skipped)');
  module.exports = [];
  return;
}

/** One flying lap (practice, autopilot) of build b on track tid; massK scales the vehicle's mass behind the AI's back. */
function lap(b, tid, massK) {
  var cache = {};
  var hook = massK && massK !== 1 ? {
    vehicleParams: function (car, p) {
      if (cache.src !== p) { var q = Object.assign({}, p); q.mass = p.mass * massK; q.Iz = p.Iz * massK; cache.src = p; cache.q = q; }
      return cache.q;
    }
  } : null;
  var s = E.createSession({ trackId: tid, mode: 'practice', laps: 0, opponents: 0, playerBuild: b, playerAutopilot: true, seed: 7,
    stuckDnf_s: 0, hooks: hook ? [hook] : undefined });
  var off = 0, walls = 0, resets = 0, t = 0, L = s.geom.length || 3000;
  var tMax = Math.max(120, L / 12) * 1.6;
  while (t < tMax) {
    s.update(0.05, {}); t += 0.05;
    var sn = s.snapshot(), me = sn.cars.filter(function (c) { return c.isPlayer; })[0];
    (sn.events || []).forEach(function (e) {
      if (e.carId !== me.id) return;
      if (e.type === 'wall') walls++;
      if (e.type === 'reset') resets++;
    });
    if (me.offTrack) off += 0.05;
    if (me.lap >= 1) break;
  }
  var r = s.results().classification.filter(function (c) { return c.isPlayer; })[0];
  return { laps: r.laps, off: off, walls: walls, resets: resets, lap_s: r.lapTimes[0] };
}
function stock(id) { var b = K.build(id).build; assert.ok(b.body.modelPhysics, id + ': stock spec has Real-car mass & aero on'); return b; }
function clean(x, label) {
  assert.ok(x.laps >= 1, label + ': lap not completed');
  assert.ok(x.off < 1.0, label + ': off track ' + x.off.toFixed(2) + ' s');
  assert.ok(x.walls === 0, label + ': ' + x.walls + ' wall hit(s)');
  assert.ok(x.resets === 0, label + ': ' + x.resets + ' reset(s)');
}

var TRACKS = T.list.map(function (d) { return d.id; });
var SAMPLE = [
  ['range-rover-sport-l461', 'heavy SUV'], ['mercedes-sprinter-vs30', 'van'], ['ford-f150-raptor-gen3', 'pickup truck'],
  ['tesla-cybertruck', 'electric truck'], ['bugatti-chiron', 'hypercar'], ['mazda-mx5-nd', 'light roadster']
];

SAMPLE.forEach(function (c) {
  test('clean laps on every circuit: ' + c[1] + ' (' + c[0] + ', Real-car mass & aero)', function () {
    var b = stock(c[0]);
    TRACKS.forEach(function (tid) { clean(lap(b, tid), c[0] + ' @ ' + tid); });
  });
});

test('Overland preset (Range Rover) + 20 kg ballast, Real-car mass & aero: clean Grünwald Ring lap', function () {
  var b = CB.util.deepClone(D.presetBuild('overland'));
  b.weight.ballast_kg = Math.min(100, (b.weight.ballast_kg || 0) + 20);
  b.body.modelPhysics = true;
  b = CB.state.normalize(b);
  clean(lap(b, 'gruenwald-ring'), 'overland +20 kg');
});

test('±20 % mass the AI is not told about: heavy SUV and hypercar stay clean on the hardest circuits', function () {
  [['range-rover-sport-l461', 0.8], ['range-rover-sport-l461', 1.2], ['bugatti-chiron', 0.8], ['bugatti-chiron', 1.2]].forEach(function (c) {
    var b = stock(c[0]);
    ['gruenwald-ring', 'neon-harbour', 'akagane-pass'].forEach(function (tid) { clean(lap(b, tid, c[1]), c[0] + ' ×' + c[1] + ' @ ' + tid); });
  });
});

if (standalone) console.log('\nrace-ai-robust: ' + passed + ' passed, ' + failed + ' failed');

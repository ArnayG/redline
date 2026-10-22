/* Brake lights end to end: every car's snapshot (player and AI) carries its brake input, car-mesh pose() turns it
   into a brighter 'light-brake' emissive at both LODs (far cars are seen from behind too), and the F1 car's rain
   light is a 'light-brake' part at both LODs. */
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
// per-style files first (their first-registered model is each style's default, as in index.html), then the rest
['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van'].forEach(function (s) { tryLoad('js/shapes/models/' + s + '.js'); });
if (fs.existsSync(modelsDir)) fs.readdirSync(modelsDir).filter(function (f) { return /\.js$/.test(f); }).sort().forEach(function (f) { tryLoad('js/shapes/models/' + f); });
['js/shapes/stock-specs.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js', 'js/race/vehicle.js',
  'js/race/ai.js', 'js/race/engine.js', 'js/f1/f1-teams.js', 'js/race/gl/lowpoly.js'].forEach(tryLoad);
var lpDir = path.join(root, 'js', 'shapes', 'lowpoly');
if (fs.existsSync(lpDir)) fs.readdirSync(lpDir).filter(function (f) { return /\.js$/.test(f); }).sort().forEach(function (f) { tryLoad('js/shapes/lowpoly/' + f); });
['js/race/gl/car-mesh.js', 'js/race/gl/f1-car-mesh.js'].forEach(tryLoad);
var CB = globalThis.CB;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  name = 'brake-lights: ' + name;
  if (!standalone) return globalThis.test(name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
var E = CB.race && CB.race.engine, CAR = CB.gl && CB.gl.car, D = CB.data;
if (!E || !CAR || !D) { console.log('  (brake-lights: modules missing — skipped)'); module.exports = []; return; }

function brakeEm(model, snap, st) {
  CAR.pose(model, snap, 1 / 60, st);
  var it = st.items.filter(function (i) { return i.kind === 'light-brake'; })[0];
  return it ? it.material.emissive[0] : null;
}

test('player and AI snapshots carry brake; it reaches every car, both LODs', function () {
  var s = E.createSession({ trackId: 'forge-speedway', mode: 'race', laps: 2, opponents: 5, playerBuild: D.defaultBuild(), playerAutopilot: true, seed: 11 });
  var maxB = {}, t = 0;
  while (t < 40) {
    s.update(0.05, {}); t += 0.05;
    s.snapshot().cars.forEach(function (c) { assert.ok(typeof c.brake === 'number', c.id + ' snapshot brake'); maxB[c.id] = Math.max(maxB[c.id] || 0, c.brake); });
  }
  var ids = Object.keys(maxB);
  assert.ok(ids.length === 6, 'six cars: ' + ids);
  // the grid hold (brake = 1) and the first corners: every car, AI included, has braked
  ids.forEach(function (id) { assert.ok(maxB[id] > 0.3, id + ' braked (' + maxB[id].toFixed(2) + ')'); });
  var snap = s.snapshot(), ai = snap.cars.filter(function (c) { return !c.isPlayer; })[0];
  ['high', 'low'].forEach(function (lod) {
    var m = CAR.build(null, ai.build || D.defaultBuild(), { lod: lod, carStyle: 'lowpoly', id: ai.id, isPlayer: false }), st = {};
    assert.ok(m.parts.some(function (p) { return p.kind === 'light-brake'; }), lod + ' LOD has a brake-light part');
    var off = brakeEm(m, { x: 0, y: 0, heading: 0, speed: 20, brake: 0 }, st);
    var on = brakeEm(m, { x: 0, y: 0, heading: 0, speed: 20, brake: 1 }, st);
    var night = brakeEm(m, { x: 0, y: 0, heading: 0, speed: 20, brake: 0, headlights: true }, st);
    assert.ok(on > off + 2 && on > night + 1.5 && night > off, lod + ' brake ' + on + ' > tail ' + night + ' > idle ' + off);
  });
});

test('F1 rain light is a light-brake part at both LODs and brightens under braking', function () {
  var F1 = CB.gl.f1car, TEAMS = CB.f1 && CB.f1.teams;
  if (!F1 || !TEAMS) return;
  ['high', 'low'].forEach(function (lod) {
    var g = F1.build(TEAMS.buildFor('ferrari'), { lod: lod });
    var rain = g.parts.filter(function (p) { return p.kind === 'light-brake'; });
    assert.strictEqual(rain.length, 1, lod + ' rain light part');
    assert.ok(rain[0].triangles >= 12, lod + ' rain light geometry');
    assert.ok(g.anchors.brakeLights.length === 2, 'anchors');
  });
});

if (standalone) console.log(process.exitCode ? 'brake-lights tests FAILED' : 'all brake-lights tests passed');

/* FORGE Atelier — 3D race view: camera line-of-sight + adaptive-quality governor tests (Node, no DOM / GL).
   - the helicopter camera never ends up with tall scenery (grandstand roofs, city blocks) between it and the car
   - the quality governor does not strip quality on a 30 Hz-capped display / when the renderer is cheap */
'use strict';
var assert = require('assert');
var path = require('path');

var ROOT = path.join(__dirname, '..');
function load(rel) { return require(path.join(ROOT, rel)); }
load('js/data.js');
var T = load('js/race/tracks.js');
['js/race/gl/gl-core.js', 'js/race/gl/textures.js', 'js/race/gl/track-mesh.js', 'js/race/gl/scenery.js',
  'js/race/gl/car-mesh.js', 'js/race/gl/cockpit.js', 'js/race/gl/effects.js', 'js/race/gl/renderer3d.js'].forEach(load);
var CB = globalThis.CB, GL = CB.gl, R3 = CB.race.renderer3d, H = R3._;

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var test = standalone
  ? function (name, fn) {
    try { fn(); console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
  }
  : globalThis.test;

test('cameras: occluder boxes / circles and segment blocking', function () {
  var geom = { scenery: [{ type: 'grandstand', x: 0, y: 0, l: 40, w: 10, h: 10, rot: 0 }], samples: [] };
  var occ = H.buildOccluders(geom, [{ type: 'city', x: 100, y: 0, r: 10, h: 30 }, { type: 'lamp', x: 50, y: 0, r: 0.5 }], null);
  assert.strictEqual(occ.length, 2, 'grandstand + city (lamps are not occluders)');
  // straight through the grandstand at 5 m height -> blocked; 40 m above it -> clear
  assert.ok(H.segmentBlocked(occ, -30, 0, 5, 30, 0, 5));
  assert.ok(!H.segmentBlocked(occ, -30, 0, 40, 30, 0, 40));
  // past the end of the stand (|x| > 20) -> clear
  assert.ok(!H.segmentBlocked(occ, 25, -20, 2, 25, 20, 2));
  // city circle
  assert.ok(H.segmentBlocked(occ, 100, -30, 5, 100, 30, 5));
  assert.ok(!H.segmentBlocked(occ, 100, -30, 35, 100, 30, 35));
  var near = H.occludersNear(occ, 100, 0, 5, []);
  assert.strictEqual(near.length, 1);
});

var defs = T.list.map(function (t) { return T.get ? T.get(t.id) : t; });
defs.forEach(function (def) {
  test('cameras: ' + def.id + ' heli camera keeps a clear line of sight to the car', function () {
    var g = T.build(def);
    var sg = GL.scenery.buildGeometry(g, def, { quality: 'high' });
    var occ = H.buildOccluders(g, sg.placed, null);
    var street = !!((def.style && def.style.street) || (def.tags && def.tags.indexOf('street') >= 0));
    var R = street ? 24 : 52, hh = street ? 66 : 34, near = [], n = 0, bad = 0;
    for (var i = 0; i < g.samples.length; i += 9) {
      var sm = g.samples[i];
      for (var a = 0; a < 6.2; a += 1.3) {
        n++;
        var nn = H.occludersNear(occ, sm.x, sm.y, R + 12, near);
        var c = H.pickHeliCandidate(nn, sm.x, sm.y, 0, a, R, hh), C = H.HELI_CANDIDATES[c];
        var A = a + C[0];
        if (H.segmentBlocked(nn, sm.x, sm.y, 0.9, sm.x + Math.cos(A) * R * C[1], sm.y - Math.sin(A) * R * C[1], hh * C[2])) bad++;
      }
    }
    assert.ok(n > 50);
    assert.ok(bad / n < 0.01, def.id + ': ' + bad + '/' + n + ' heli views still blocked');
  });
});

test('cameras: governor still downgrades a genuinely slow renderer (interval only, probe keeps it)', function () {
  var g = H.createGovernor({ thresholdMs: 22, holdS: 2, warmupS: 0 });
  var r = false, t = 0;
  while (!r && t < 10000) { r = g.sample(30); t += 30; }
  assert.strictEqual(r, 'down');
  // after the downgrade the frame time really improves -> no restore
  for (t = 0; t < 4000; t += 16.7) assert.notStrictEqual(g.sample(16.7), 'restore');
});

test('cameras: governor restores quality on a 30 Hz cap and then stops downgrading', function () {
  var g = H.createGovernor({ thresholdMs: 22, holdS: 2, warmupS: 1.5 });
  var downs = 0, restores = 0;
  for (var t = 0; t < 30000; t += 33.3) {
    var r = g.sample(33.3, 2.5);                // capped rAF, the renderer itself costs 2.5 ms
    if (r === 'down') downs++;
    if (r === 'restore') restores++;
  }
  assert.ok(downs <= 1, 'downgrades on a 30 Hz cap: ' + downs);
  assert.strictEqual(restores, downs, 'every probe downgrade is restored');
});

test('cameras: governor with GPU timing ignores slow intervals when the renderer is cheap', function () {
  var g = H.createGovernor({ thresholdMs: 22, holdS: 2, warmupS: 0 });
  for (var t = 0; t < 20000; t += 33.3) assert.ok(!g.sample(33.3, 1.0, 3.0), 'cheap frames on a capped display never downgrade');
  var g2 = H.createGovernor({ thresholdMs: 22, holdS: 2, warmupS: 0 }), fired = false;
  for (t = 0; t < 10000 && !fired; t += 33.3) fired = g2.sample(33.3, 2.0, 26.0) === 'down';
  assert.ok(fired, 'GPU-bound frames downgrade');
});

test('cameras: headlight lighting presets keep the day exposure below 1 (no blown-out whites)', function () {
  assert.ok(H.lightingFor('day', 'dry').exposure < 1);
  assert.ok(H.lightingFor('night', 'dry').exposure >= 1);
});

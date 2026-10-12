/* FORGE Atelier — 3D race view: regression tests for the final 3D pass (Node, no DOM / GL).
   - quality governor warm-up is gated on frames AND clamped time (build hitches cannot burn it)
   - car-mesh triangles are wound to agree with their normals (needed for back-face culling / back-face shading)
   - squared-arch clad strip stays on the flanks (pickup tailgate keeps the paint colour)
   - scenery placed[] entries carry their footprint (l / w / h / rot) for camera blocker checks
   - bright painted scenery is albedo-capped */
'use strict';
var assert = require('assert');
var path = require('path');

var ROOT = path.join(__dirname, '..');
function load(rel) { return require(path.join(ROOT, rel)); }
load('js/data.js');
var T = load('js/race/tracks.js');
['js/race/gl/gl-core.js', 'js/race/gl/textures.js', 'js/race/gl/track-mesh.js', 'js/race/gl/scenery.js',
  'js/race/gl/car-mesh.js', 'js/race/gl/cockpit.js', 'js/race/gl/effects.js', 'js/race/gl/renderer3d.js'].forEach(load);
var CB = globalThis.CB, GL = CB.gl, H = CB.race.renderer3d._;

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var test = standalone
  ? function (name, fn) {
    try { fn(); console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
  }
  : globalThis.test;

test('final pass: governor warm-up survives a few huge build hitches', function () {
  var g = H.createGovernor({ thresholdMs: 22, holdS: 2, warmupS: 1.5 });
  // 8 hitch frames of 200 ms (= 1.6 s of "time") would have consumed the old time-only warm-up
  for (var i = 0; i < 8; i++) assert.strictEqual(g.sample(200, 150), false);
  assert.ok(g.warm > 0 && g.warmN > 0, 'warm-up still running after the hitches');
  // a slow-but-settling stretch right after is still inside the warm-up: no downgrade
  for (i = 0; i < 100; i++) assert.notStrictEqual(g.sample(30, 25), 'down');
});

test('final pass: governor still downgrades a sustained slow renderer after warm-up', function () {
  var g = H.createGovernor({ thresholdMs: 22, holdS: 2, warmupS: 1.5 }), r = false;
  for (var t = 0; t < 20000 && r !== 'down'; t += 40) r = g.sample(40, 30);
  assert.strictEqual(r, 'down');
});

function facingMismatchArea(geo) {
  var P = geo.p, N = geo.n, I = geo.i, bad = 0, all = 0;
  for (var t = 0; t < I.length; t += 3) {
    var a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    var ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    var fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx, ar = Math.sqrt(fx * fx + fy * fy + fz * fz) / 2;
    var d = fx * (N[a] + N[b] + N[c]) + fy * (N[a + 1] + N[b + 1] + N[c + 1]) + fz * (N[a + 2] + N[b + 2] + N[c + 2]);
    all += ar; if (d < 0) bad += ar;
  }
  return { bad: bad, all: all };
}

test('final pass: car body / wing triangles are wound to agree with their normals', function () {
  ['hot-hatch', 'super-wagon', 'track-weapon', 'desert-runner'].forEach(function (id) {
    var b = CB.data.presetBuild(id);
    var desc = GL.car.buildGeometry(b, { lod: 'high' });
    desc.parts.forEach(function (p) {
      if (!/^(body|wing|roof)$/.test(p.kind)) return;
      p.geo.finish();                 // orients in place
      var m = facingMismatchArea(p.geo);
      assert.ok(m.bad / m.all < 0.0015, id + ' ' + p.kind + ' mismatched area share ' + (m.bad / m.all).toFixed(5));
    });
  });
});

test('final pass: pickup tail cap is not swept by the squared-arch clad strip', function () {
  var b = CB.data.presetBuild('desert-runner');
  var desc = GL.car.buildGeometry(b, { lod: 'high' });
  var trim = desc.parts.filter(function (p) { return p.kind === 'trim'; })[0];
  assert.ok(trim, 'trim part');
  // lowerBodyHigh's clad colour is linear 0.030; count its rear-facing triangles on the tail cap
  var g = trim.geo, P = g.p, N = g.n, C = g.c, xmin = Infinity, n = 0;
  for (var i = 0; i < P.length; i += 3) xmin = Math.min(xmin, P[i]);
  for (var t = 0; t < g.i.length; t += 3) {
    var a = g.i[t] * 3, bb = g.i[t + 1] * 3, c = g.i[t + 2] * 3;
    var nx = (N[a] + N[bb] + N[c]) / 3, cx = (P[a] + P[bb] + P[c]) / 3;
    if (nx < -0.5 && cx < xmin + 0.4 && Math.abs(C[g.i[t] * 4] - 0.03) < 0.0005) n++;
  }
  assert.ok(n < 16, 'rear-facing clad triangles on the tail cap: ' + n);
});

test('final pass: scenery placed[] entries carry footprint dims', function () {
  var def = T.get('forge-ring') || T.list[0], g = T.build(def);
  var res = GL.scenery.buildGeometry(g, def, { quality: 'high' });
  var big = res.placed.filter(function (o) { return o.type === 'grandstand' || o.type === 'pits' || o.type === 'city'; });
  assert.ok(big.length > 0, 'has big blockers');
  big.forEach(function (o) {
    assert.ok(o.l > 0 && o.w > 0 && o.h > 0 && isFinite(o.rot), o.type + ' dims ' + JSON.stringify(o));
  });
  res.placed.filter(function (o) { return o.authored; }).forEach(function (o) { assert.ok(isFinite(o.rot), 'authored rot'); });
});

test('final pass: square tails (pickup, van) are closed by a painted end cap', function () {
  ['desert-runner', 'atelier-shuttle'].forEach(function (id) {
    var desc = GL.car.buildGeometry(CB.data.presetBuild(id), { lod: 'high' });
    var body = desc.parts.filter(function (p) { return p.kind === 'body'; })[0];
    var g = body.geo, P = g.p, xmin = Infinity, area = 0;
    for (var i = 0; i < P.length; i += 3) xmin = Math.min(xmin, P[i]);
    for (var t = 0; t < g.i.length; t += 3) {
      var a = g.i[t] * 3, b = g.i[t + 1] * 3, c = g.i[t + 2] * 3;
      if ((P[a] + P[b] + P[c]) / 3 > xmin + 0.05) continue;
      var ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      var fx = uy * vz - uz * vy, l = Math.hypot(fx, uz * vx - ux * vz, ux * vy - uy * vx);
      if (l > 0 && Math.abs(fx) / l > 0.9) area += l / 2;
    }
    assert.ok(area > 0.5, id + ' painted tail face area ' + area.toFixed(3) + ' m2');
  });
});

/* Node tests for js/race/gl/envmap.js (pure helpers: cube face bases, SH9 projection, presets, lod mapping).
   Run: node tests/race3d-envmap.test.js   (or via node tests/run.js) */
'use strict';
var assert = require('assert');
var path = require('path');
require(path.join(__dirname, '..', 'js', 'race', 'gl', 'gl-core.js'));
var E = require(path.join(__dirname, '..', 'js', 'race', 'gl', 'envmap.js'));
var I = E._;
var passed = 0;
var test = typeof globalThis.test === 'function' ? globalThis.test : function (name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
};
function close(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }

/* GL spec cube-map face selection: returns {face, s, t} for a direction */
function cubeLookup(d) {
  var ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]), face, sc, tc, ma;
  if (ax >= ay && ax >= az) { ma = ax; if (d[0] > 0) { face = 0; sc = -d[2]; tc = -d[1]; } else { face = 1; sc = d[2]; tc = -d[1]; } }
  else if (ay >= az) { ma = ay; if (d[1] > 0) { face = 2; sc = d[0]; tc = d[2]; } else { face = 3; sc = d[0]; tc = -d[2]; } }
  else { ma = az; if (d[2] > 0) { face = 4; sc = d[0]; tc = -d[1]; } else { face = 5; sc = -d[0]; tc = -d[1]; } }
  return { face: face, s: (sc / ma + 1) / 2, t: (tc / ma + 1) / 2 };
}

test('envmap: exports + GLSL chunk declares the consumer uniforms', function () {
  assert.strictEqual(typeof E.create, 'function');
  assert.strictEqual(CB.gl.envmap, E);
  ['uEnvCube', 'uUseEnvCube', 'uEnvLod', 'uEnvSH[9]', 'uEnvScale', 'envCubeSpec', 'envSH'].forEach(function (k) { assert.ok(E.GLSL.indexOf(k) >= 0, k); });
  assert.strictEqual(E.SAMPLER_UNIT, 4);
});

test('envmap: face bases are orthonormal and match the GL cube-map (s, t) convention for bottom-up rendering', function () {
  for (var f = 0; f < 6; f++) {
    var B = I.FACES[f];
    [B.F, B.R, B.U].forEach(function (v) { assert.ok(close(Math.hypot(v[0], v[1], v[2]), 1, 1e-9)); });
    assert.ok(close(B.F[0] * B.R[0] + B.F[1] * B.R[1] + B.F[2] * B.R[2], 0, 1e-9));
    assert.ok(close(B.F[0] * B.U[0] + B.F[1] * B.U[1] + B.F[2] * B.U[2], 0, 1e-9));
    for (var k = 0; k < 9; k++) {
      var x = (k % 3) * 0.8 - 0.8, y = Math.floor(k / 3) * 0.8 - 0.8;
      var r = cubeLookup(I.faceDir(f, x, y));
      assert.strictEqual(r.face, f);
      assert.ok(close(r.s, (x + 1) / 2, 1e-9) && close(r.t, (y + 1) / 2, 1e-9), 'face ' + f + ' x ' + x + ' y ' + y);
    }
  }
});

test('envmap: face basis equals the lookAt camera basis used for capture', function () {
  var m4 = CB.gl.mat4, v = m4.create();
  for (var f = 0; f < 6; f++) {
    var B = I.FACES[f];
    m4.lookAt(v, [0, 0, 0], B.F, B.up);
    // view matrix rows: right, up, -forward
    for (var c = 0; c < 3; c++) {
      assert.ok(close(v[c * 4], B.R[c], 1e-6) && close(v[c * 4 + 1], B.U[c], 1e-6) && close(v[c * 4 + 2], -B.F[c], 1e-6));
    }
  }
});

test('envmap: sphereInFace culls spheres behind / beside the face only', function () {
  assert.ok(I.sphereInFace(0, 10, 0, 0, 1));
  assert.ok(!I.sphereInFace(0, -10, 0, 0, 1));
  assert.ok(!I.sphereInFace(0, 1, 0, 10, 1));
  assert.ok(I.sphereInFace(0, -0.5, 0, 0, 1)); // overlapping the origin
});

test('envmap: SH9 of constant radiance evaluates to that radiance everywhere', function () {
  var sh = I.shProject(8, function () { return [0.5, 1, 2]; });
  [[0, 1, 0], [1, 0, 0], [0, 0, -1], [0.57735, -0.57735, 0.57735]].forEach(function (n) {
    var c = I.shEval(sh, n);
    assert.ok(close(c[0], 0.5, 0.01) && close(c[1], 1, 0.01) && close(c[2], 2, 0.02), JSON.stringify(c));
  });
});

test('envmap: SH9 irradiance of a sky hemisphere (L = 1 above horizon) ~ 1 up, ~0.5 sideways, ~0 down', function () {
  var sh = I.shProject(16, function (f, ix, iy, d) { return d[1] > 0 ? [1, 1, 1] : [0, 0, 0]; });
  assert.ok(close(I.shEval(sh, [0, 1, 0])[0], 1, 0.08));
  assert.ok(close(I.shEval(sh, [1, 0, 0])[0], 0.5, 0.05));
  assert.ok(I.shEval(sh, [0, -1, 0])[0] < 0.08);
});

test('envmap: shFromTiles decodes the Reinhard RGBA8 tile layout', function () {
  var T = 8, W = T * 6, u8 = new Uint8Array(W * T * 4);
  for (var i = 0; i < W * T; i++) { u8[i * 4] = 128; u8[i * 4 + 1] = 128; u8[i * 4 + 2] = 128; u8[i * 4 + 3] = 255; }
  var sh = I.shFromTiles(u8, T), e = 128 / 255, L = e / (1 - e);
  assert.ok(close(I.shEval(sh, [0, 1, 0])[1], L, 0.02));
});

test('envmap: presets per time of day / weather / studio, lighting overrides', function () {
  var d = E.preset('day', 'dry'), n = E.preset('night', 'dry'), w = E.preset('day', 'wet'), s = E.preset('day', 'dry', null, true);
  assert.ok(d.zenith[2] > n.zenith[2] * 5);
  assert.strictEqual(n.night, 1);
  assert.ok(w.cloud > d.cloud && w.sunColor[0] < d.sunColor[0]);
  assert.strictEqual(s.studio, 1);
  assert.ok(s.lights[0] > 1);
  var o = E.preset('dusk', 'dry', { envTop: [0.1, 0.2, 0.3], sunDir: [0, 2, 0] });
  assert.deepStrictEqual(o.zenith, [0.1, 0.2, 0.3]);
  assert.ok(close(o.sunDir[1], 1));
  assert.notStrictEqual(d.key, w.key);
});

test('envmap: lod mapping monotonic and bounded; quality configs', function () {
  var prev = -1;
  for (var r = 0; r <= 1.0001; r += 0.1) {
    var l = I.lodForRoughness(r, 4, 'prefiltered', 128), b = I.lodForRoughness(r, 7, 'box', 128);
    assert.ok(l >= prev && l <= 4 && b >= 0 && b <= 7); prev = l;
  }
  assert.strictEqual(I.config('low').dynamic, false);
  assert.ok(I.config('high').size >= 128 && I.config('high').dynamic);
  assert.ok(I.config('ultra').size > I.config('medium').size);
  assert.strictEqual(I.config('high', { size: 100 }).size, 128);
  assert.ok(I.config('high', { facesPerFrame: 6, interval: 1 }).interval >= 2);
});

if (typeof globalThis.test !== 'function') console.log(passed + ' passed');

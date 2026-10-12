/* Node tests for js/race/gl/effects.js (pure helpers + mock-GL smoke test).
   Run: node tests/race3d-effects.test.js   (or via node tests/run.js) */
'use strict';
var assert = require('assert');
var path = require('path');
var FX = require(path.join(__dirname, '..', 'js', 'race', 'gl', 'effects.js'));
var I = FX._internal;
var passed = 0;
var test = typeof globalThis.test === 'function' ? globalThis.test : function (name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
};

function len3(v) { return Math.hypot(v[0], v[1], v[2]); }
function close(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }

/* ---------------------------------------------------------------- mock GL */
function mockGL() {
  var calls = [];
  var consts = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ACTIVE_UNIFORMS: 5, ACTIVE_ATTRIBUTES: 6,
    ARRAY_BUFFER: 7, ELEMENT_ARRAY_BUFFER: 8, STATIC_DRAW: 9, DYNAMIC_DRAW: 10, BLEND: 11, DEPTH_TEST: 12, CULL_FACE: 13,
    POLYGON_OFFSET_FILL: 14, VIEWPORT: 15, CURRENT_PROGRAM: 16, ALIASED_POINT_SIZE_RANGE: 17, FLOAT: 18, TRIANGLES: 19,
    POINTS: 20, UNSIGNED_SHORT: 21, LEQUAL: 22, LESS: 23, ONE: 24, ONE_MINUS_SRC_ALPHA: 25, SRC_ALPHA: 26
  };
  var attribNames = ['aPos', 'aVel', 'aTime', 'aParams', 'aColor', 'aData', 'aSeq', 'aSeed', 'aCorner'];
  var target = {
    calls: calls, drawingBufferWidth: 1280, drawingBufferHeight: 720,
    createBuffer: function () { return { buf: true }; },
    createShader: function () { return {}; }, createProgram: function () { return { prog: true }; },
    getShaderParameter: function () { return true; }, getProgramParameter: function (p, k) {
      if (k === consts.ACTIVE_UNIFORMS) return 0;
      if (k === consts.ACTIVE_ATTRIBUTES) return attribNames.length;
      return true;
    },
    getActiveAttrib: function (p, i) { return { name: attribNames[i] }; },
    getAttribLocation: function (p, n) { return attribNames.indexOf(n); },
    getParameter: function (k) {
      if (k === consts.VIEWPORT) return [0, 0, 1280, 720];
      if (k === consts.ALIASED_POINT_SIZE_RANGE) return [1, 1024];
      return null;
    },
    isEnabled: function () { return false; },
    getExtension: function () { return null; }
  };
  for (var k in consts) target[k] = consts[k];
  return new Proxy(target, {
    get: function (t, k) {
      if (k in t) return t[k];
      return function () { calls.push([k].concat([].slice.call(arguments))); };
    }
  });
}

function lookAtView(eye, tgt) {
  // column-major view matrix (gl-matrix lookAt), up = +Y
  var z = [eye[0] - tgt[0], eye[1] - tgt[1], eye[2] - tgt[2]], zl = len3(z); z = z.map(function (v) { return v / zl; });
  var up = [0, 1, 0];
  var x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]], xl = len3(x); x = x.map(function (v) { return v / xl; });
  var y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  var d = function (a) { return a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2]; };
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -d(x), -d(y), -d(z), 1]);
}
function perspective(fovy, aspect, n, f) {
  var t = 1 / Math.tan(fovy / 2), nf = 1 / (n - f);
  return new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) * nf, -1, 0, 0, 2 * f * n * nf, 0]);
}
function camera(eye, tgt) {
  return { view: lookAtView(eye, tgt), proj: perspective(1.1, 16 / 9, 0.1, 2000), position: eye, viewport: [0, 0, 1280, 720] };
}
function car(o) {
  var c = { id: 'c1', x: 0, y: 0, heading: 0, speed: 20, vx: 20, vy: 0, length_m: 4.4, width_m: 1.9, surface: 'asphalt',
    skidding: 0, wheelspin: 0, brake: 0, throttle: 0.5, rpm: 4000, redline: 7000, build: { drivetrain: { layout: 'rwd' } } };
  for (var k in o) c[k] = o[k];
  return c;
}

/* ------------------------------------------------------------------ tests */
test('effects: loads in Node without DOM and exports API', function () {
  assert.strictEqual(typeof FX.create, 'function');
  assert.strictEqual(typeof FX.getLighting, 'function');
  assert.ok(globalThis.CB.gl.effects === FX);
});

test('effects: getLighting covers every timeOfDay x weather with sane values', function () {
  ['day', 'dusk', 'night'].forEach(function (t) {
    ['dry', 'damp', 'wet'].forEach(function (w) {
      var L = FX.getLighting(t, w);
      assert.strictEqual(L.timeOfDay, t); assert.strictEqual(L.weather, w);
      assert.ok(close(len3(L.sunDir), 1, 1e-6), 'sunDir unit');
      assert.ok(L.sunDir[1] > 0.05, 'sun above horizon (shadow pass requires it)');
      ['sunColor', 'ambientSky', 'ambientGround', 'fogColor', 'envTop', 'envHorizon', 'envBottom', 'ambient'].forEach(function (k) {
        assert.strictEqual(L[k].length, 3, k);
        L[k].forEach(function (v) { assert.ok(isFinite(v) && v >= 0, k); });
      });
      assert.ok(L.fogDensity > 0 && L.fogDensity < 0.01);
    });
  });
});

test('effects: lighting matches renderer3d sun/fog conventions and weather trends', function () {
  var d = FX.getLighting('day', 'dry'), du = FX.getLighting('dusk', 'dry'), n = FX.getLighting('night', 'dry'), wet = FX.getLighting('day', 'wet');
  var expect = [-0.42, 0.78, -0.46], el = len3(expect);
  for (var i = 0; i < 3; i++) assert.ok(close(d.sunDir[i], expect[i] / el, 1e-6));
  assert.deepStrictEqual(d.fogColor, [0.70, 0.78, 0.88]);
  assert.ok(du.sunDir[1] < d.sunDir[1], 'dusk sun lower');
  assert.ok(n.stars > 0.9 && d.stars === 0, 'stars only at night');
  assert.ok(n.moonVisible > 0.9 && d.sunVisible > 0.9 && n.sunVisible === 0);
  assert.ok(wet.fogDensity > d.fogDensity * 2, 'wet fog denser');
  assert.ok(wet.overcast === 1 && wet.rain === 1 && wet.wetness === 1 && d.rain === 0);
  assert.ok(wet.sunVisible === 0 && wet.cloudCover > d.cloudCover);
  assert.ok(wet.sunColor[0] < d.sunColor[0]);
  assert.strictEqual(d.headlights, false); assert.strictEqual(du.headlights, true); assert.strictEqual(wet.headlights, true);
  assert.strictEqual(FX.getLighting('bogus', 'bogus').timeOfDay, 'day');
});

test('effects: getLighting returns independent copies', function () {
  var a = FX.getLighting('day', 'dry'); a.sunDir[0] = 99; a.fogDensity = 5;
  var b = FX.getLighting('day', 'dry');
  assert.ok(b.sunDir[0] !== 99 && b.fogDensity !== 5);
});

test('effects: quality caps are monotonic', function () {
  var order = ['low', 'medium', 'high', 'ultra'];
  for (var i = 1; i < order.length; i++) {
    var a = I.qualityCaps(order[i - 1]), b = I.qualityCaps(order[i]);
    ['maxParticles', 'skidSegments', 'rainDrops', 'emitScale', 'cloudOctaves'].forEach(function (k) { assert.ok(b[k] >= a[k], k); });
  }
  assert.strictEqual(I.qualityCaps('nope'), I.qualityCaps('high'));
});

test('effects: ParticlePool ring buffer wraps and reports dirty ranges', function () {
  var P = new I.ParticlePool(16);
  for (var i = 0; i < 10; i++) P.emit(0, 1, 0, 0, 0, 0, 0, 1, 0.1, 1, 1, 0, 0, 0.5, 1, 1, 1, 1);
  assert.deepStrictEqual(P.takeDirty(), [[0, 10]]);
  assert.deepStrictEqual(P.takeDirty(), []);
  for (i = 0; i < 9; i++) P.emit(0, 1, 0, 0, 0, 0, 2, 1, 0.1, 1, 1, 0, 0, 0.5, 1, 1, 1, 1);
  assert.deepStrictEqual(P.takeDirty(), [[10, 6], [0, 3]]);
  assert.strictEqual(P.head, 3);
  assert.strictEqual(P.count(), 16);
  assert.strictEqual(P.alive(2.5), 9, 'only second batch alive at t=2.5');
  assert.strictEqual(P.alive(10), 0);
  for (i = 0; i < 40; i++) P.emit(0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0);
  assert.deepStrictEqual(P.takeDirty(), [[0, 16]], 'overfull dirty -> whole ring');
  assert.strictEqual(P.data.length, 16 * I.P_STRIDE);
});

test('effects: SkidBuffer builds continuous ribbons and breaks on gaps/idle', function () {
  var S = new I.SkidBuffer(100);
  assert.strictEqual(S.add('a', [0, 0, 0], 1, 0, 0.3), false, 'first point only starts a ribbon');
  assert.strictEqual(S.add('a', [0.1, 0, 0], 1, 0.01, 0.3), false, 'below min length');
  assert.strictEqual(S.add('a', [1, 0, 0], 1, 0.05, 0.3), true);
  assert.strictEqual(S.add('a', [2, 0, 0], 0.5, 0.1, 0.3), true);
  assert.strictEqual(S.count(), 2);
  var d = S.data, st = I.S_STRIDE;
  // segment 1 start edge == segment 0 end edge (continuous ribbon)
  assert.ok(close(d[1 * 4 * st + 0], d[0 * 4 * st + 2 * st + 0]) && close(d[1 * 4 * st + 2], d[0 * 4 * st + 2 * st + 2]));
  // width 0.3 across the ribbon (z direction since moving along +x)
  assert.ok(close(Math.abs(d[2] - d[st + 2]), 0.3, 1e-6));
  assert.ok(d[1] > 0 && d[1] < 0.05, 'lifted slightly above road');
  assert.strictEqual(S.add('a', [20, 0, 0], 1, 0.15, 0.3), false, 'teleport gap breaks ribbon');
  assert.strictEqual(S.add('a', [21, 0, 0], 1, 2.0, 0.3), false, 'idle breaks ribbon');
  S.end('a');
  assert.strictEqual(S.add('a', [22, 0, 0], 1, 2.05, 0.3), false, 'after end() a new ribbon starts');
  assert.strictEqual(new I.SkidBuffer(1e6).cap, 16000, 'capped for 16-bit indices');
  S.prune(100); assert.deepStrictEqual(Object.keys(S.wheels), []);
});

test('effects: carFrame maps sim (x, y, heading) to GL axes', function () {
  var f = I.carFrame(car({ x: 10, y: 5, heading: Math.PI / 2, vx: 0, vy: 20 }));
  assert.deepStrictEqual(f.center, [10, 0, -5]);
  assert.ok(close(f.fwd[0], 0, 1e-9) && close(f.fwd[2], -1, 1e-9), 'heading pi/2 (sim +y) -> GL -z');
  assert.ok(close(f.vel[2], -20, 1e-9));
  f = I.carFrame(car({ heading: 0, build: { body: { wheelbase_mm: 2600, trackWidth_mm: 1600 } } }));
  assert.ok(close(f.wheels[0][0], 1.3) && close(f.wheels[0][2], -0.8), 'FL at +x forward, left = -z');
  assert.ok(close(f.wheels[3][0], -1.3) && close(f.wheels[3][2], 0.8), 'RR');
});

test('effects: wheelSlip follows drivetrain layout and state', function () {
  assert.deepStrictEqual(I.wheelSlip(car({ speed: 0.2, wheelspin: 0 })), [0, 0, 0, 0]);
  var r = I.wheelSlip(car({ wheelspin: 0.9 }));
  assert.ok(r[2] > 0.8 && r[3] > 0.8 && r[0] === 0 && r[1] === 0, 'rwd spins rears');
  var f = I.wheelSlip(car({ wheelspin: 0.9, build: { drivetrain: { layout: 'fwd' } } }));
  assert.ok(f[0] > 0.8 && f[2] === 0, 'fwd spins fronts');
  var lock = I.wheelSlip(car({ skidding: 0.8, brake: 1 }));
  assert.ok(lock[0] > 0.7 && lock[2] > 0.5, 'lockup marks all wheels');
  var hb = I.wheelSlip(car({ handbrake: true }));
  assert.ok(hb[2] > 0.8 && hb[0] === 0);
});

test('effects: camera helpers recover eye/forward from a view matrix', function () {
  var v = lookAtView([5, 2, 7], [15, 2, 7]);
  var p = I.camPosFromView(v), fw = I.camFwdFromView(v);
  assert.ok(close(p[0], 5, 1e-4) && close(p[1], 2, 1e-4) && close(p[2], 7, 1e-4));
  assert.ok(close(fw[0], 1, 1e-5) && close(fw[1], 0, 1e-5));
  var ci = I.readCamera({ viewMatrix: v, projection: perspective(1, 1, 0.1, 100) });
  assert.ok(ci && close(ci.pos[0], 5, 1e-4));
  assert.strictEqual(I.readCamera({}), null);
});

test('effects: shader sources are well-formed strings', function () {
  var sh = I.shaders;
  ['PARTICLE_VS', 'PARTICLE_FS', 'SKID_VS', 'SKID_FS', 'RAIN_VS', 'RAIN_FS', 'SKY_VS'].forEach(function (k) {
    assert.ok(typeof sh[k] === 'string' && /void main\s*\(\)/.test(sh[k]), k);
    var o = (sh[k].match(/\{/g) || []).length, c = (sh[k].match(/\}/g) || []).length;
    assert.strictEqual(o, c, k + ' braces balanced');
  });
  var sky = sh.skyFS(5, true);
  assert.ok(/#define OCT 5/.test(sky) && /#define CLOUD_SHADOW/.test(sky));
});

test('effects: create() runs against a mock GL (update, emit, draw, quality, dedupe)', function () {
  var gl = mockGL();
  var fx = FX.create({ gl: gl, isWebGL2: false }, { quality: 'medium', timeOfDay: 'day', weather: 'dry' });
  var cam = camera([0, 1.2, 0], [10, 1.2, 0]);
  var snap = { t: 0, timeOfDay: 'night', weather: 'wet', cars: [car({ wheelspin: 1, skidding: 0.9 }), car({ id: 'c2', x: 4, surface: 'grass', speed: 25 })], events: [{ type: 'wall', carId: 'c1', x: 1, y: 0, intensity: 0.9 }] };
  for (var i = 0; i < 30; i++) { snap.cars[0].x += 0.6; fx.update(1 / 60, snap, cam); }
  var s = fx.stats();
  assert.ok(s.particlesAlive > 0, 'auto emission produced particles');
  assert.ok(s.skidSegments > 0, 'auto skids laid');
  assert.strictEqual(fx.getLighting().timeOfDay, 'day', 'explicit opts env wins over snapshot');
  fx.setWeather('wet');
  assert.ok(fx.rain.intensity === 1 && fx.rain.wetness === 1);
  var items = fx.drawItems(cam);
  assert.strictEqual(items.length, 3);
  items.forEach(function (it) { assert.ok(it.transparent && !it.castShadow && typeof it.draw === 'function' && typeof it.mesh.draw === 'function'); it.draw(cam); it.mesh.draw(null); });
  fx.drawSky(cam, 'dusk', 'dry');
  var draws = gl.calls.filter(function (c) { return c[0] === 'drawArrays' || c[0] === 'drawElements'; });
  assert.ok(draws.length >= 7, 'skids, particles, rain (x2 paths) and sky drawn: ' + draws.length);
  assert.ok(gl.calls.some(function (c) { return c[0] === 'drawArrays' && c[1] === gl.POINTS; }), 'point sprites');
  // dedupe: once an external caller lays skids, auto skids stop
  fx.clear();
  fx.addSkid('x', 0, [0, 0, 0], 1);
  fx.addSkid('x', 0, [1, 0, 0], 1);
  fx.addSkid('x', 0, [2, 0, 0], 0);
  assert.strictEqual(fx.stats().skidSegments, 2);
  for (i = 0; i < 30; i++) { snap.cars[0].x += 0.6; fx.update(1 / 60, snap, cam); }
  assert.strictEqual(fx.stats().skidSegments, 2, 'no auto skids after external addSkid');
  fx.setQuality('ultra', 300);
  assert.strictEqual(fx.getQuality(), 'ultra');
  assert.ok(fx.stats().particleCap >= 300 && fx.stats().skidSegments === 2, 'skids survive quality change');
  fx.emitSparks([0, 0.3, 0], [10, 0, 0], 50);
  fx.emitDust([0, 0, 0], [5, 0, 0], 'sand');
  fx.emitSmoke([0, 0, 0], [5, 0, 0], 0.8);
  assert.ok(fx.stats().particlesAlive > 20);
  fx.reset();
  assert.strictEqual(fx.stats().particlesAlive, 0);
  fx.destroy(); fx.destroy();
  fx.update(1 / 60, snap, cam); fx.drawSky(cam);
});

test('effects: create() throws cleanly without a GL context', function () {
  assert.throws(function () { FX.create(null); }, /no WebGL context/);
});

if (typeof globalThis.test !== 'function') console.log('race3d-effects: ' + passed + ' passed');

test('effects: smoke sprites fade into the road and are dithered (no horizontal banding)', function () {
  var vs = I.shaders.PARTICLE_VS, fs = I.shaders.PARTICLE_FS;
  assert.ok(/varying vec4 vGround;/.test(vs) && /varying vec4 vGround;/.test(fs), 'soft-ground varying');
  assert.ok(/vGround = vec4\(p\.y,/.test(vs), 'centre height + world radius passed to the FS');
  assert.ok(/smoothstep\(0\.0, clamp\(vGround\.y/.test(fs), 'alpha fades toward the ground plane');
  assert.ok(/gl_FragCoord\.xy/.test(fs) && /dn \/ 255\.0/.test(fs), 'sub-LSB dither');
  assert.ok(!/mix\(1\.06, 0\.72, gl_PointCoord\.y\)/.test(fs), 'no per-sprite top->bottom gradient (it stacked into stripes)');
});

/* Node tests for js/race/gl/renderer3d.js pure helpers (no DOM / GL): matrices, springs, FOV, pose interpolation,
   frustum culling, chase-cam wall safety, TV cams, lighting, light picking, quality governor, fallback geometry. */
'use strict';
var assert = require('assert');
var path = require('path');

var T = require(path.join(__dirname, '..', 'js', 'race', 'tracks.js'));
var R3 = require(path.join(__dirname, '..', 'js', 'race', 'gl', 'renderer3d.js'));
var H = R3._;

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var test = standalone
  ? function (name, fn) {
    try { fn(); console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
  }
  : globalThis.test;

function near(a, b, eps, msg) { assert.ok(Math.abs(a - b) <= (eps || 1e-6), (msg || '') + ' ' + a + ' vs ' + b); }

test('renderer3d: module shape + isSupported false in Node', function () {
  assert.strictEqual(typeof R3.create, 'function');
  assert.strictEqual(R3.isSupported(), false);
  assert.deepStrictEqual(R3.CAMERA_MODES, ['cockpit', 'hood', 'bumper', 'chase', 'chase-far', 'tv', 'heli', 'map']);
  assert.strictEqual(R3.normalizeCamera('north'), 'map');
  assert.strictEqual(R3.normalizeCamera('first-person'), 'cockpit');
  assert.strictEqual(R3.normalizeCamera('third-person'), 'chase');
  assert.strictEqual(R3.normalizeCamera('bogus'), null);
});

test('renderer3d: carMatrix maps car-local +X to sim heading, +Z right, sim y -> GL -z', function () {
  var m = new Float32Array(16);
  var h = 0.7;
  H.carMatrix(m, 10, 20, 0, h, 0, 0);
  var p = H.xformPoint(m, 1, 0, 0);
  near(p[0], 10 + Math.cos(h), 1e-5); near(p[2], -(20 + Math.sin(h)), 1e-5);
  // right side (+Z local) = sim right normal (sin h, -cos h)
  var r = H.xformDir(m, 0, 0, 1);
  near(r[0], Math.sin(h), 1e-5); near(r[2], -(-Math.cos(h)), 1e-5);
  // roll keeps the frame orthonormal
  H.carMatrix(m, 0, 0, 0, 1.2, 0.05, -0.08);
  var x = H.xformDir(m, 1, 0, 0), y = H.xformDir(m, 0, 1, 0);
  near(x[0] * y[0] + x[1] * y[1] + x[2] * y[2], 0, 1e-6);
  near(Math.hypot(y[0], y[1], y[2]), 1, 1e-6);
});

test('renderer3d: mat4 lookAt / perspective / invert are consistent', function () {
  var v = new Float32Array(16), iv = new Float32Array(16), I = new Float32Array(16);
  H.m4.lookAt(v, [3, 4, 5], [0, 1, 0], [0, 1, 0]);
  H.m4.invert(iv, v); H.m4.multiply(I, v, iv);
  for (var i = 0; i < 16; i++) near(I[i], i % 5 === 0 ? 1 : 0, 1e-5);
  var e = H.xformPoint(v, 3, 4, 5); near(e[0], 0, 1e-5); near(e[1], 0, 1e-5); near(e[2], 0, 1e-5);
});

test('renderer3d: critically damped spring converges, is stable for large dt', function () {
  var s = { x: 0, v: 0 };
  for (var i = 0; i < 240; i++) H.spring(s, 10, 6, 1 / 60);
  near(s.x, 10, 0.01);
  var s2 = { x: 0, v: 0 };
  for (i = 0; i < 20; i++) { H.spring(s2, 5, 50, 0.5); assert.ok(isFinite(s2.x) && Math.abs(s2.x) < 10); }
  near(s2.x, 5, 0.05);
});

test('renderer3d: FOV widens with speed between 60 and 75 degrees', function () {
  near(H.fovForSpeed(0), 60); near(H.fovForSpeed(200), 75);
  var mid = H.fovForSpeed(45); assert.ok(mid > 60 && mid < 75);
});

test('renderer3d: pose interpolation lerps but never across teleports', function () {
  var p = H.interpolatePose({ x: 10, y: 0, heading: 0.2, prevX: 8, prevY: 0, prevHeading: 0 }, 0.5);
  near(p.x, 9); near(p.heading, 0.1);
  var wrap = H.interpolatePose({ x: 0, y: 0, heading: -3.1, prevX: 0, prevY: 0, prevHeading: 3.1 }, 0.5);
  assert.ok(Math.abs(Math.abs(wrap.heading) - Math.PI) < 0.05, 'shortest-arc heading lerp');
  var tp = H.interpolatePose({ x: 100, y: 0, heading: 0, prevX: 0, prevY: 0, prevHeading: 0 }, 0.5);
  near(tp.x, 100);
});

test('renderer3d: frustum culling keeps objects in front, drops behind', function () {
  var v = new Float32Array(16), p = new Float32Array(16), vp = new Float32Array(16);
  H.m4.lookAt(v, [0, 1, 0], [0, 1, -10], [0, 1, 0]);
  H.m4.perspective(p, 65 * Math.PI / 180, 16 / 9, 0.1, 1000);
  H.m4.multiply(vp, p, v);
  var pl = H.frustumPlanes(vp);
  assert.ok(H.sphereInFrustum(pl, 0, 1, -50, 2));
  assert.ok(!H.sphereInFrustum(pl, 0, 1, 50, 2));
  assert.ok(!H.sphereInFrustum(pl, 0, 1, -2000, 2), 'beyond far plane');
  assert.ok(H.sphereInFrustum(pl, 0, 1, 1, 2), 'sphere straddling the camera');
});

test('renderer3d: chase camera boom never ends outside the walls (street circuit)', function () {
  var def = T.list.filter(function (d) { return /porto|street|neon/.test(d.id); })[0] || T.list[0];
  var g = T.build(def), S = g.samples;
  var bad = 0, checked = 0;
  for (var i = 0; i < S.length; i += 37) {
    var sm = S[i];
    // car near the right wall, camera pointing out across the wall
    var cx = sm.x, cy = sm.y;
    var ox = cx - sm.nx * (sm.wallR + 30), oy = cy - sm.ny * (sm.wallR + 30);
    var t = H.chaseSafeFraction(g, cx, cy, ox, oy, i, 0.45);
    var px = cx + (ox - cx) * t, py = cy + (oy - cy) * t;
    checked++;
    if (!H.insideWalls(g, px, py, i, 0)) bad++;
  }
  assert.ok(checked > 10);
  assert.strictEqual(bad, 0);
});

test('renderer3d: TV cams are placed off-track on every circuit and picked cyclically', function () {
  T.list.forEach(function (def) {
    var g = T.build(def);
    var cams = H.buildTvCams(g);
    assert.ok(cams.length >= 4, def.id + ' has cams');
    cams.forEach(function (c) {
      var p = g.project(c.x, c.y);
      assert.ok(!p.onTrack, def.id + ' tv cam not on the road');
      assert.ok(c.h > 3);
    });
    var L = g.length;
    for (var s = 0; s < L; s += L / 17) {
      var k = H.pickTvCam(cams, s, L, 0);
      assert.ok(k >= 0 && k < cams.length);
    }
  });
});

test('renderer3d: lighting presets per time of day / weather', function () {
  var day = H.lightingFor('day', 'dry'), night = H.lightingFor('night', 'dry'), wet = H.lightingFor('day', 'wet');
  assert.strictEqual(day.headlights, false);
  assert.strictEqual(night.headlights, true);
  assert.ok(night.sunColor[0] < day.sunColor[0]);
  assert.ok(wet.wetness === 1 && wet.fogDensity > day.fogDensity && wet.headlights);
  near(Math.hypot.apply(null, day.sunDir), 1, 1e-6);
});

test('renderer3d: light picking prefers priority then distance, packs 8 slots', function () {
  var cands = [];
  for (var i = 0; i < 20; i++) cands.push({ pos: [i * 10, 2, 0], color: [1, 1, 1], range: 40 });
  cands.push({ pos: [500, 0, 0], color: [1, 0, 0], range: 70, dir: [1, 0, 0], priority: 2 });
  var picked = H.pickLights(cands, [0, 0, 0], 8);
  assert.strictEqual(picked.length, 8);
  assert.strictEqual(picked[0].priority, 2);
  assert.strictEqual(picked[1].pos[0], 0);
  var env = H.packLights(picked, {});
  assert.strictEqual(env.lightCount, 8);
  assert.strictEqual(env.lightPos.length, 24);
  assert.strictEqual(env.lightParams[3], 1, 'spot type');
});

test('renderer3d: quality governor downgrades only after 2 s of slow frames', function () {
  var g = H.createGovernor({ thresholdMs: 22, holdS: 2, warmupS: 0 });
  var fired = false, t = 0;
  for (var i = 0; i < 200 && !fired; i++) { fired = g.sample(16.7); t += 16.7; }
  assert.ok(!fired, 'fast frames never downgrade');
  t = 0;
  while (!fired && t < 10000) { fired = g.sample(30); t += 30; }
  assert.ok(fired);
  assert.ok(t >= 2000 && t < 3500, 'fired after ~2 s, was ' + t);
  assert.ok(!g.sample(400), 'hitches ignored');
  assert.strictEqual(H.lowerQuality('high'), 'medium');
  assert.strictEqual(H.lowerQuality('low'), null);
});

test('renderer3d: fallback geometry is well-formed', function () {
  function check(geo) {
    var nv = geo.positions.length / 3;
    assert.ok(nv > 0);
    assert.strictEqual(geo.normals.length, nv * 3);
    assert.strictEqual(geo.colors.length, nv * 4);
    for (var i = 0; i < geo.indices.length; i++) assert.ok(geo.indices[i] < nv);
    for (i = 0; i < geo.positions.length; i++) assert.ok(isFinite(geo.positions[i]));
  }
  var car = H.fallbackCarGeometry(4.4, 1.85, 1.3);
  check(car.body); check(car.glass); check(car.dark);
  assert.ok(car.cockpitEye[1] > 0.8);
  var g = T.build(T.list[0]);
  var tr = H.fallbackTrackGeometry(g);
  check(tr.road); check(tr.walls); check(tr.ground);
  var rl = H.racingLineGeometry(g);
  if (rl) check(rl);
});

function windingAgreement(geo) {
  var P = geo.positions, N = geo.normals, I = geo.indices, bad = 0, tot = 0;
  for (var t = 0; t < I.length; t += 3) {
    var a = I[t] * 3, b = I[t + 1] * 3, d = I[t + 2] * 3;
    var ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    var vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (Math.hypot(nx, ny, nz) < 1e-9) continue;
    tot++;
    if (nx * N[a] + ny * N[a + 1] + nz * N[a + 2] < 0) bad++;
  }
  return { bad: bad, tot: tot };
}

test('renderer3d: fallback car is a lofted, outward-facing shape for every body style', function () {
  ['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van'].forEach(function (st) {
    var car = H.fallbackCarGeometry(4.5, 1.9, /suv|van|pickup/.test(st) ? 1.75 : 1.3, 4, st);
    var w = windingAgreement(car.body);
    assert.strictEqual(w.bad, 0, st + ': body triangles agree with normals');
    assert.ok(car.lights.indices.length > 0, st + ': lights');
    var tris = (car.body.indices.length + car.glass.indices.length + car.dark.indices.length + car.lights.indices.length) / 3;
    assert.ok(tris < 1600, st + ': fallback stays light (' + tris + ' tris)');
    // driver eye sits above the beltline and inside the body footprint
    assert.ok(car.cockpitEye[1] > car.dims.belt, st + ': eye above belt');
    assert.ok(Math.abs(car.cockpitEye[2]) < car.dims.width / 2 && Math.abs(car.cockpitEye[0]) < car.dims.length / 2);
  });
});

test('renderer3d: built-in cockpit geometry places wheel, gauges and mirror in front of the eye', function () {
  var car = H.fallbackCarGeometry(4.5, 1.9, 1.3, 4, 'coupe');
  var ck = H.fallbackCockpitGeometry(car.cockpitEye, car.dims, 4);
  ['shell', 'wheel', 'gauges', 'mirrorGlass'].forEach(function (k) {
    var g = ck[k];
    assert.ok(g && g.indices.length > 0, k);
    for (var i = 0; i < g.indices.length; i++) assert.ok(g.indices[i] < g.positions.length / 3, k + ' index range');
  });
  var e = car.cockpitEye;
  assert.ok(ck.wheelCenter[0] > e[0] + 0.2 && ck.wheelCenter[1] < e[1], 'wheel ahead of and below the eye');
  assert.ok(ck.mirror.pos[0] > e[0] && ck.mirror.pos[1] > e[1] - 0.05, 'mirror ahead, roughly at eye level or above');
  var n = ck.mirror.normal;
  assert.ok(n[0] < 0, 'mirror faces the driver');
  near(Math.hypot(n[0], n[1], n[2]), 1, 1e-6);
  // open-top roadster: no roof liner -> fewer shell triangles
  var rd = H.fallbackCarGeometry(4.2, 1.8, 1.22, 4, 'roadster');
  var ckr = H.fallbackCockpitGeometry(rd.cockpitEye, rd.dims, 4);
  assert.ok(ckr.shell.indices.length < ck.shell.indices.length, 'roadster has no roof');
});

/* Node tests for js/shapes/core.js — run: node tests/run.js shapes-core */
'use strict';
var path = require('path');
var fs = require('fs');

// A model file registering BEFORE core loads must still end up registered (the _pending queue).
var CB = (globalThis.CB = globalThis.CB || {});
CB.shapes = CB.shapes || {};
function C(a, b, c) { return { t: 'C', p: [a, b, c] }; }
function L(a) { return { t: 'L', p: [a] }; }
function M(a) { return { t: 'M', p: [a] }; }
var Zs = { t: 'Z', p: [] };

/* Tiny sample coupe (≈ 992 911 proportions) to exercise fit/loft. */
function sample(id) {
  var wb = 2.45, h = 1.30;
  return {
    id: id || 'test-coupe', make: 'Test', name: 'Coupe', gen: 'T1', years: '2020–', style: '_test',
    enginePosition: 'rear', drivetrain: 'rwd', powertrain: 'ice',
    ref: { length: 4.519, width: 1.852, height: h, wheelbase: wb, trackF: 1.589, trackR: 1.557, frontOverhang: 1.02, rearOverhang: 1.05,
      wheelDiameter_in: 20, tireF: '245/35R20', tireR: '305/30ZR21', groundClearance: 0.11, rideHeight: 0.11, cd: 0.29, curbWeight_kg: 1505 },
    side: {
      body: [M([2.245, 0.30]), C([2.27, 0.45], [2.20, 0.62], [1.95, 0.70]), C([1.4, 0.80], [0.85, 0.86], [0.55, 0.88]),
        C([0.2, 1.15], [-0.2, 1.30], [-0.5, 1.30]), C([-1.0, 1.29], [-1.7, 1.05], [-2.2, 0.92]),
        C([-2.28, 0.80], [-2.28, 0.45], [-2.27, 0.30]), L([-2.27, 0.22]),
        // rear arch cut
        L([-1.58, 0.22]), C([-1.58, 0.62], [-0.87, 0.62], [-0.87, 0.22]),
        L([0.87, 0.22]),
        // front arch cut
        C([0.87, 0.60], [1.58, 0.60], [1.58, 0.22]), L([2.245, 0.22]), Zs],
      greenhouse: [M([0.45, 0.9]), C([0.2, 1.1], [-0.2, 1.24], [-0.5, 1.24]), C([-0.9, 1.23], [-1.3, 1.08], [-1.55, 0.95]), L([0.45, 0.9]), Zs],
      windows: [[[0.4, 0.92], [-0.3, 1.2], [-0.6, 1.0], [-0.6, 0.93]]],
      archF: { x: 1.225, y: 0.34, r: 0.37, flare: 0.02 },
      archR: { x: -1.225, y: 0.34, r: 0.39, flare: 0.04 }
    },
    top: {
      body: [M([2.245, 0]), C([2.24, 0.6], [1.9, 0.86], [1.3, 0.88]), C([0.3, 0.9], [-1.0, 0.926], [-1.6, 0.926]),
        C([-2.1, 0.92], [-2.27, 0.7], [-2.27, 0]), C([-2.27, -0.7], [-2.1, -0.92], [-1.6, -0.926]),
        C([-1.0, -0.926], [0.3, -0.9], [1.3, -0.88]), C([1.9, -0.86], [2.24, -0.6], [2.245, 0]), Zs],
      greenhouse: 'M 0.5 0.65 L -1.5 0.6 L -1.5 -0.6 L 0.5 -0.65 Z'
    },
    front: {
      body: [M([0, 0.2]), L([0.88, 0.22]), C([0.93, 0.5], [0.92, 0.75], [0.8, 0.88]), L([-0.8, 0.88]), C([-0.92, 0.75], [-0.93, 0.5], [-0.88, 0.22]), Zs],
      greenhouse: [M([0.65, 0.9]), L([0.5, 1.28]), L([-0.5, 1.28]), L([-0.65, 0.9]), Zs],
      headlights: [{ path: [M([0.55, 0.7]), C([0.75, 0.72], [0.8, 0.6], [0.7, 0.55]), C([0.6, 0.5], [0.5, 0.6], [0.55, 0.7]), Zs], paint: 'light' }]
    },
    rear: {
      body: [M([0, 0.2]), L([0.9, 0.22]), C([0.95, 0.5], [0.93, 0.8], [0.8, 0.92]), L([-0.8, 0.92]), C([-0.93, 0.8], [-0.95, 0.5], [-0.9, 0.22]), Zs],
      exhaust: [{ shape: 'oval', cx: 0.4, cy: 0.3, w: 0.12, h: 0.06 }, { shape: 'oval', cx: -0.4, cy: 0.3, w: 0.12, h: 0.06 }]
    },
    details: [{ view: 'side', role: 'mirror', path: [[0.45, 0.95], [0.3, 0.98], [0.32, 0.92]], paint: 'body' }],
    signature: { headlights: 'oval', taillights: 'light bar' }
  };
}

(CB.shapes._pending = CB.shapes._pending || []).push(sample('pre-core'));
var S = require(path.join(__dirname, '..', 'js', 'shapes', 'core.js'));

function near(a, b, eps, msg) { assert.ok(Math.abs(a - b) <= (eps || 1e-6), (msg || '') + ' expected ' + b + ' got ' + a); }

test('shapes-core: exports the contract API', function () {
  ['registerModel', 'modelsByStyle', 'defaultModel', 'getModel', 'fit', 'toSvgPath', 'bounds', 'sectionsFromViews', 'loftToMesh'].forEach(function (k) {
    assert.equal(typeof S[k], 'function', k);
  });
  assert.equal(CB.shapes, S);
  assert.equal(typeof S.models, 'object');
});

test('shapes-core: drains models pushed to _pending before load, and after load', function () {
  assert.ok(S.models['pre-core']);
  CB.shapes._pending.push(sample('post-core'));
  assert.ok(S.models['post-core']);
});

test('shapes-core: registry lookup + getModel fallback', function () {
  var m = S.registerModel(sample());
  assert.equal(S.models['test-coupe'], m);
  assert.ok(S.modelsByStyle('_test').indexOf(m) >= 0);
  assert.equal(S.defaultModel('_test'), S.models['pre-core']);
  assert.equal(S.defaultModel('van-nonexistent'), null);
  assert.equal(S.getModel({ body: { style: 'coupe', model: 'test-coupe' } }), m);
  assert.equal(S.getModel({ body: { style: '_test', model: 'bogus' } }), S.defaultModel('_test'));
  // string greenhouse was parsed into segments
  assert.ok(S.isPath(m.top.greenhouse));
  // point-list window converted
  assert.ok(S.isPath(m.side.windows[0]));
});

test('shapes-core: toSvgPath + bounds', function () {
  var p = [M([0, 0]), L([1, 0]), C([1, 1], [0, 1], [0, 0.5]), Zs];
  var d = S.toSvgPath(p, { scale: 100, flipY: true, ox: 10, oy: 200 });
  assert.equal(d.indexOf('M 10 200'), 0);
  assert.ok(/C 110 100 10 100 10 150 Z$/.test(d), d);
  var b = S.bounds(p);
  near(b.minX, 0); near(b.maxX, 1); near(b.minY, 0);
  assert.ok(b.maxY > 0.7 && b.maxY <= 1);
  assert.deepEqual(S.parsePath('M 0 0 l 1 0 v 1 Z').map(function (s) { return s.t; }), ['M', 'L', 'L', 'Z']);
});

test('shapes-core: parseTire handles common notations', function () {
  assert.deepEqual(S.parseTire('245/35R20'), { width_mm: 245, profile: 35, rim_in: 20 });
  assert.deepEqual(S.parseTire('305/30ZR21'), { width_mm: 305, profile: 30, rim_in: 21 });
  assert.deepEqual(S.parseTire('LT275/70R18'), { width_mm: 275, profile: 70, rim_in: 18 });
  near(S.tireDiameter(S.parseTire('245/35R20')), 0.6795, 1e-3);
});

test('shapes-core: fit with reference dims is the identity', function () {
  var m = S.models['test-coupe'];
  var f = S.fit(m, S.refBuild(m));
  near(f.dims.wheelbase, 2.45); near(f.dims.length, 4.519);
  near(f.dims.rideHeight, 0.11);
  near(f.side.archF.r, 0.37, 1e-9); near(f.side.archF.x, 1.225, 1e-9);
  assert.deepEqual(f.side.body, m.side.body);
  assert.deepEqual(f.front.body, m.front.body);
  near(f.wheels.front.x, 1.225); near(f.wheels.front.r, S.tireDiameter(S.parseTire('245/35R20')) / 2, 1e-9);
  near(f.wheels.rear.rimR, 21 * 0.0254 / 2, 1e-9);
  // fit(model) with no build behaves the same
  near(S.fit(m).dims.wheelbase, 2.45);
});

test('shapes-core: fit remaps wheelbase, ride height, track and arches', function () {
  var m = S.models['test-coupe'];
  var b = S.refBuild(m);
  b.body.wheelbase_mm = 2650; b.suspension.rideHeight_mm = 150; b.body.trackWidth_mm = 1700;
  b.wheels.diameter_in = 22; b.tires.profileFront = 35; b.tires.profileRear = 35; b._rimRear_in = undefined;
  var f = S.fit(m, b);
  near(f.dims.wheelbase, 2.65); near(f.dims.axleF, 1.325); near(f.dims.axleR, -1.325);
  near(f.dims.length, 4.519 + 0.2, 1e-9);
  near(f.dims.height, 1.30 + 0.04, 1e-9);
  var sb = S.bounds(f.side.body), ob = S.bounds(m.side.body);
  near(sb.maxX, ob.maxX + 0.1, 1e-6, 'front overhang kept');
  near(sb.minX, ob.minX - 0.1, 1e-6, 'rear overhang kept');
  near(sb.maxY, ob.maxY + 0.04, 1e-3, 'body raised by ride-height delta');
  near(f.side.archF.x, 1.325, 1e-9);
  near(f.side.archF.y, 0.34 + 0.04, 1e-9);
  assert.ok(f.side.archF.r > 0.37, 'arch grew for larger tire');
  assert.ok(f.side.archF.r >= 2 * f.wheels.front.r - f.side.archF.y, 'tire fits under arch');
  var fb = S.bounds(f.front.body), fob = S.bounds(m.front.body);
  near(fb.maxX / fob.maxX, f.dims.scaleZ, 1e-6);
  near(f.rear.exhaust[0].cx, 0.4 * f.dims.scaleZ, 1e-9);
  near(f.rear.exhaust[0].cy, 0.34, 1e-9);
  assert.equal(f.details[0].path[0].t, 'M');
  // original untouched
  near(m.side.archF.x, 1.225, 1e-12);
});

test('shapes-core: sectionsFromViews produces consistent rings', function () {
  var m = S.fit(S.models['test-coupe']);
  var secs = S.sectionsFromViews(m, { stations: 40, ringVerts: 32 });
  assert.ok(secs.length >= 36);
  secs.forEach(function (s) {
    assert.equal(s.ring.length, 32);
    s.ring.forEach(function (q) { assert.ok(isFinite(q[0]) && isFinite(q[1])); });
    // symmetric
    near(s.ring[1][1], -s.ring[31][1], 1e-9);
  });
  var mid = secs[Math.floor(secs.length / 2)];
  var maxZ = Math.max.apply(null, mid.ring.map(function (q) { return q[1]; }));
  var maxY = Math.max.apply(null, mid.ring.map(function (q) { return q[0]; }));
  assert.ok(maxZ > 0.8 && maxZ < 0.95, 'half width ~0.9: ' + maxZ);
  assert.ok(maxY > 1.1 && maxY <= 1.31, 'roof height: ' + maxY);
  assert.ok(secs.some(function (s) { return s.belt != null; }), 'greenhouse belt present');
  for (var i = 1; i < secs.length; i++) assert.ok(secs[i].x > secs[i - 1].x);
});

test('shapes-core: loftToMesh is watertight with outward normals', function () {
  var m = S.fit(S.models['test-coupe']);
  var mesh = S.loftToMesh(S.sectionsFromViews(m, { stations: 30, ringVerts: 24 }));
  assert.ok(mesh.positions instanceof Float32Array);
  assert.ok(mesh.indices instanceof Uint32Array);
  assert.equal(mesh.normals.length, mesh.positions.length);
  assert.equal(mesh.uvs.length, mesh.positions.length / 3 * 2);
  // every edge shared by exactly two triangles, in opposite directions
  var edges = {}, I = mesh.indices;
  for (var t = 0; t < I.length; t += 3) for (var k = 0; k < 3; k++) {
    var a = I[t + k], b = I[t + (k + 1) % 3], key = a + '_' + b;
    assert.ok(!edges[key], 'duplicate directed edge ' + key);
    edges[key] = 1;
  }
  Object.keys(edges).forEach(function (key) { var p = key.split('_'); assert.ok(edges[p[1] + '_' + p[0]], 'open edge ' + key); });
  // signed volume positive and plausible
  var P = mesh.positions, vol = 0;
  for (var j = 0; j < I.length; j += 3) {
    var A = I[j] * 3, B = I[j + 1] * 3, Cc = I[j + 2] * 3;
    vol += (P[A] * (P[B + 1] * P[Cc + 2] - P[B + 2] * P[Cc + 1]) - P[A + 1] * (P[B] * P[Cc + 2] - P[B + 2] * P[Cc]) + P[A + 2] * (P[B] * P[Cc + 1] - P[B + 1] * P[Cc])) / 6;
  }
  assert.ok(vol > 4 && vol < 11, 'volume m^3: ' + vol);
  // normal at the widest right-side vertex points +z
  var best = -1, bz = -Infinity;
  for (var v = 0; v < P.length / 3; v++) if (P[v * 3 + 2] > bz) { bz = P[v * 3 + 2]; best = v; }
  assert.ok(mesh.normals[best * 3 + 2] > 0.5);
  assert.ok(mesh.glass.indices.length > 0, 'glass mesh present');
});

test('shapes-core: sectionsFromViews carves wheel wells inboard of the tyres', function () {
  var m = S.models['test-coupe'], f = S.fit(m, S.refBuild(m));
  var secs = S.sectionsFromViews(f, { stations: 64, ringVerts: 32 });
  var aF = f.side.archF, zIn = f.dims.trackF / 2 - f.dims.tireWidthF / 2;
  var atAxle = secs.reduce(function (best, s) { return Math.abs(s.x - aF.x) < Math.abs(best.x - aF.x) ? s : best; });
  var wellTop = aF.y + Math.sqrt(Math.max(0, aF.r * aF.r - (atAxle.x - aF.x) * (atAxle.x - aF.x)));
  atAxle.ring.forEach(function (q) {
    if (q[0] < wellTop - 0.01) assert.ok(Math.abs(q[1]) <= zIn + 1e-6, 'skin inside wheel well at y=' + q[0] + ' z=' + q[1]);
  });
  var mid = secs.reduce(function (best, s) { return Math.abs(s.x) < Math.abs(best.x) ? s : best; });
  var maxZ = Math.max.apply(null, mid.ring.map(function (q) { return Math.abs(q[1]); }));
  assert.ok(maxZ > zIn + 0.02, 'full width between the axles');
  var noWells = S.sectionsFromViews(f, { stations: 64, ringVerts: 32, wheelWells: false });
  assert.equal(noWells.length, secs.length);
  var m2 = S.loftToMesh(secs);
  assert.ok(m2.indices.length > 0 && m2.glass.indices.length > 0, 'mesh + glass');
});
test('shapes-core: glass flags follow the greenhouse and leave a plan-view roof painted', function () {
  var m = JSON.parse(JSON.stringify(S.models['test-coupe']));
  m.id = 'test-coupe-roof';
  m.top.roof = 'M 0.0 0.5 L -1.0 0.5 L -1.0 -0.5 L 0.0 -0.5 Z';
  var r = S.registerModel(m), f = S.fit(r, S.refBuild(r));
  var secs = S.sectionsFromViews(f, { stations: 48, ringVerts: 32 });
  var withBelt = secs.filter(function (s) { return s.belt != null; });
  assert.ok(withBelt.length > 4, 'greenhouse stations');
  withBelt.forEach(function (s) {
    assert.equal(s.glass.length, s.ring.length);
    s.ring.forEach(function (q, i) { if (q[0] < s.belt) assert.equal(s.glass[i], 0, 'no glass below belt'); });
  });
  var roofSec = withBelt.filter(function (s) { return s.x < -0.2 && s.x > -0.8; })[0];
  var topIdx = 16; // ring vertex at the crown (ringVerts/2)
  assert.equal(roofSec.glass[topIdx], 0, 'roof crown painted');
  assert.ok(roofSec.glass.some(Boolean), 'side glass present under the roof');
  var mesh = S.loftToMesh(secs);
  assert.ok(mesh.glass.indices.length > 0);
  for (var i = 0; i < mesh.glass.positions.length; i++) assert.ok(isFinite(mesh.glass.positions[i]));
  delete S.models['test-coupe-roof']; S._order.splice(S._order.indexOf('test-coupe-roof'), 1);
});
test('shapes-core: explicit half sections are mirrored', function () {
  var m = sample('sec-model');
  m.sections = [0, 1, 2].map(function (i) {
    return { x: -1 + i, ringHalf: true, ring: [[0.2, 0], [0.3, 0.8], [0.9, 0.85], [1.2, 0.5], [1.3, 0]] };
  });
  var reg = S.registerModel(m);
  var secs = S.sectionsFromViews(reg, { ringVerts: 32 });
  assert.equal(secs.length, 3);
  assert.equal(secs[0].ring.length, 32);
  near(secs[0].ring[3][1], -secs[0].ring[29][1], 1e-9);
  assert.ok(S.loftToMesh(secs).indices.length > 0);
});

test('shapes-core: every model file under js/shapes/models loads and fits', function () {
  var dir = path.join(__dirname, '..', 'js', 'shapes', 'models');
  var files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(function (f) { return f.endsWith('.js'); }) : [];
  files.forEach(function (f) { require(path.join(dir, f)); });
  S.list().forEach(function (mm) {
    var f = S.fit(mm, S.refBuild(mm));
    assert.ok(f.dims.length > 2.5 && f.dims.length < 7, mm.id + ' length');
    var secs = S.sectionsFromViews(f, { stations: 24, ringVerts: 16 });
    assert.ok(secs.length >= (mm.sections ? 2 : 5), mm.id + ' sections');
    assert.ok(S.loftToMesh(secs).indices.length > 0, mm.id + ' mesh');
  });
});

test('shapes-core: (cleanup) remove test models from the shared registry', function () {
  ['pre-core', 'post-core', 'test-coupe', 'sec-model'].forEach(function (id) {
    delete S.models[id];
    var i = S._order.indexOf(id); if (i >= 0) S._order.splice(i, 1);
  });
  assert.equal(S.modelsByStyle('_test').length, 0);
});

/* Demolition Derby renderer pure parts (docs/DERBY-SPEC.md §9): mesh deformation, normals, hammer swing, car frame
   conventions, arena outlines + geometry for all six arenas, accessory geometry. No WebGL needed. */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
['js/derby/derby-arenas.js', 'js/race/gl/derby-parts.js', 'js/race/gl/derby-arena-mesh.js', 'js/race/gl/derby-renderer.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, DR = CB.derby.renderer, U = DR._, DA = CB.gl.derbyArena, DP = CB.gl.derbyParts, AR = CB.derby.arenas;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('derby-render: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
function finite(arr) { for (var i = 0; i < arr.length; i++) if (!isFinite(arr[i])) return false; return true; }

/* a box-ish "car body" point cloud with DUPLICATED seam vertices (flat-shaded meshes do that) */
function carCloud() {
  var p = [];
  for (var x = -2.2; x <= 2.2001; x += 0.2) for (var y = 0.3; y <= 1.3001; y += 0.25) { p.push(x, y, 0.95, x, y, 0.95, x, y, -0.95); }
  return new Float32Array(p);
}

test('applyDents: no dents = identity, weights 0', function () {
  var b = carCloud(), o = new Float32Array(b.length);
  var w = U.applyDents(b, o, []);
  assert.deepStrictEqual(Array.from(o), Array.from(b));
  assert.ok(Array.from(w).every(function (v) { return v === 0; }));
});

test('applyDents: a left-side dent pushes left-side vertices inward (GL +Z = right, sim +y = left), bounded, finite', function () {
  var b = carCloud(), o = new Float32Array(b.length);
  // sim: point on the LEFT flank (y = +0.95), inward push = -y
  var w = U.applyDents(b, o, [{ x: 0, y: 0.95, z: 0.8, nx: 0, ny: -1, depth: 0.3, r: 0.9 }]);
  assert.ok(finite(o));
  var moved = 0, maxD = 0;
  for (var i = 0; i < b.length; i += 3) {
    var dz = o[i + 2] - b[i + 2], d = Math.hypot(o[i] - b[i], o[i + 1] - b[i + 1], dz);
    maxD = Math.max(maxD, d);
    if (b[i + 2] < 0 && Math.hypot(b[i], b[i + 1] - 0.8) < 0.5) { assert.ok(dz > 0.05, 'left flank (GL z<0) pushed toward +z (inward)'); moved++; }
    if (b[i + 2] > 0) assert.ok(d < 1e-6, 'far (right) side untouched');
  }
  assert.ok(moved > 3);
  assert.ok(maxD <= 0.5 + 1e-6, 'displacement capped');
  assert.ok(Math.max.apply(null, Array.from(w)) > 0.3, 'weights mark the dent for scorch');
});

test('applyDents: duplicated seam vertices move identically (no cracks)', function () {
  var b = carCloud(), o = new Float32Array(b.length);
  U.applyDents(b, o, [{ x: 0.4, y: 0.95, z: 0.7, nx: 0, ny: -1, depth: 0.35, r: 1.1 }, { x: -1.2, y: 0.95, z: 0.5, nx: 0.3, ny: -0.95, depth: 0.2, r: 0.8 }]);
  for (var i = 0; i < b.length; i += 9) {
    assert.strictEqual(o[i], o[i + 3]); assert.strictEqual(o[i + 1], o[i + 4]); assert.strictEqual(o[i + 2], o[i + 5]);
  }
});

test('applyDents: 48 deep dents stay bounded and above the floor', function () {
  var b = carCloud(), o = new Float32Array(b.length), dents = [];
  for (var k = 0; k < 48; k++) { var a = k * 2.399; dents.push({ x: Math.cos(a) * 2.2, y: Math.sin(a) * 0.95, z: 0.35 + (k % 4) * 0.25, nx: -Math.cos(a), ny: -Math.sin(a), depth: 0.42, r: 1.3 }); }
  U.applyDents(b, o, dents);
  assert.ok(finite(o));
  for (var i = 0; i < b.length; i += 3) {
    assert.ok(Math.hypot(o[i] - b[i], o[i + 1] - b[i + 1], o[i + 2] - b[i + 2]) <= 0.5 + 1e-6);
    assert.ok(o[i + 1] >= 0.04 - 1e-6);
  }
});

test('computeNormals + orientLike: unit normals, flip to the original side', function () {
  var pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), idx = [0, 1, 2];
  var n = U.computeNormals(pos, idx);
  for (var i = 0; i < 9; i += 3) assert.ok(Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1) < 1e-6);
  var ref = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
  U.orientLike(n, ref);
  assert.ok(n[1] > 0.99 && n[4] > 0.99 && n[7] > 0.99);
});

test('hammerAngle: rest, wind-up, hit past horizontal, return', function () {
  var rest = U.hammerAngle(0);
  assert.ok(U.hammerAngle(0.1) < rest);
  assert.ok(U.hammerAngle(0.4) > 1.5, 'boom swings down to the side at impact');
  assert.ok(Math.abs(U.hammerAngle(0.999) - rest) < 0.05);
  for (var s = 0; s <= 1; s += 0.05) assert.ok(isFinite(U.hammerAngle(s)));
});

test('carFrame: heading / pitch (nose up) / roll (left side up) conventions in GL [x, z, -y]', function () {
  var f = U.carFrame({ x: 3, y: 4, z: 1, heading: Math.PI / 2, pitch: 0, roll: 0 });
  assert.deepStrictEqual(f.pos, [3, 1, -4]);
  assert.ok(Math.abs(f.fwd[2] + 1) < 1e-9, 'heading +90 deg (north) = GL -Z');
  var p = U.carFrame({ heading: 0, pitch: 0.3, roll: 0 });
  assert.ok(p.fwd[1] > 0.29, 'positive pitch lifts the nose');
  var r = U.carFrame({ heading: 0, pitch: 0, roll: 0.3 });
  // left side = -right; positive roll raises the left side: up tilts toward +right (GL +Z)
  assert.ok(r.up[2] > 0.29);
  var t = U.wheelTilt([true, false, false, false]);
  assert.ok(t.pitch < 0 && t.roll < 0 && t.drop < 0, 'lost front-left wheel: nose and left side drop');
  assert.strictEqual(U.wheelCorner({ front: true, z: -0.8 }), 0);
  assert.strictEqual(U.wheelCorner({ front: false, z: 0.8 }), 3);
});

/* a fuller car-shaped cloud: skin on both sides, bonnet / roof on top, nose + tail faces */
function carBody() {
  var p = [];
  for (var x = -2.3; x <= 2.3001; x += 0.1) {
    for (var y = 0.2; y <= 1.0001; y += 0.1) p.push(x, y, 0.92, x, y, -0.92);
    for (var z = -0.9; z <= 0.9001; z += 0.15) p.push(x, x > -1 && x < 0.9 ? 1.38 : 1.0, z);
  }
  for (var y2 = 0.2; y2 <= 1.0001; y2 += 0.1) for (var z2 = -0.9; z2 <= 0.9001; z2 += 0.15) p.push(2.3, y2, z2, -2.3, y2, z2);
  return new Float32Array(p);
}
var DIMS = { length: 4.6, width: 1.84, roof: 1.38, belt: 1.0, frontAxle: 1.4, rearAxle: -1.35, wheelRadius: 0.34, track: 1.58 };
function extentX(a) { var mn = 1e9, mx = -1e9; for (var i = 0; i < a.length; i += 3) { mn = Math.min(mn, a[i]); mx = Math.max(mx, a[i]); } return [mn, mx]; }

test('deformCar: no damage = identity, empty mask', function () {
  var b = carBody(), o = new Float32Array(b.length);
  var r = U.deformCar(b, o, { dims: U.damageDims(DIMS) });
  assert.deepStrictEqual(Array.from(o), Array.from(b));
  assert.ok(Array.from(r.mask).every(function (m) { return m === 0; }));
});

test('deformCar: front / rear crumple visibly shortens the car, the cabin keeps its length', function () {
  var b = carBody(), o = new Float32Array(b.length), D = U.damageDims(DIMS);
  U.deformCar(b, o, { dims: D, zones: { front: 1, rear: 0 } });
  var e0 = extentX(b), e1 = extentX(o);
  assert.ok(finite(o));
  assert.ok(e0[1] - e1[1] > 0.45, 'nose pushed in by > 45 cm: ' + (e0[1] - e1[1]).toFixed(2));
  assert.ok(Math.abs(e1[0] - e0[0]) < 1e-6, 'rear untouched by front damage');
  for (var i = 0; i < b.length; i += 3) if (b[i] < D.fA - 0.4 && b[i] > D.rA + 0.4) assert.ok(Math.abs(o[i] - b[i]) < 1e-6, 'cabin x unchanged');
  var o2 = new Float32Array(b.length);
  U.deformCar(b, o2, { dims: D, zones: { front: 0.5, rear: 1 } });
  var e2 = extentX(o2);
  assert.ok(e2[0] - e0[0] > 0.45 && e0[1] - e2[1] > 0.15 && e0[1] - e2[1] < e0[1] - e1[1], 'rear crumple + partial front');
});

test('deformCar: side damage caves the doors in (sim left = GL -Z), roof crush on rollover', function () {
  var b = carBody(), o = new Float32Array(b.length), D = U.damageDims(DIMS);
  U.deformCar(b, o, { dims: D, zones: { left: 1 } });
  var maxIn = 0;
  for (var i = 0; i < b.length; i += 3) {
    if (b[i + 2] < -0.9 && Math.abs(b[i]) < 1 && b[i + 1] < 0.9) maxIn = Math.max(maxIn, o[i + 2] - b[i + 2]);
    if (b[i + 2] > 0.9) assert.ok(Math.abs(o[i + 2] - b[i + 2]) < 1e-6, 'right side untouched');
  }
  assert.ok(maxIn > 0.25, 'left doors pushed in ' + maxIn.toFixed(2));
  var o2 = new Float32Array(b.length);
  U.deformCar(b, o2, { dims: D, roof: 1 });
  var top0 = 0, top1 = 0;
  for (var k = 0; k < b.length; k += 3) { top0 = Math.max(top0, b[k + 1]); top1 = Math.max(top1, o2[k + 1]); }
  assert.ok(top0 - top1 > 0.12, 'roof flattened by ' + (top0 - top1).toFixed(2));
});

test('inPart + deformCar masks: detached parts are masked (hole), hanging parts move, only the chosen region', function () {
  var D = U.damageDims(DIMS);
  assert.ok(U.inPart('bumperF', 2.25, 0.4, 0, D) && !U.inPart('bumperF', -2.25, 0.4, 0, D));
  assert.ok(U.inPart('bumperR', -2.25, 0.4, 0, D));
  assert.ok(U.inPart('hood', 1.6, 1.0, 0, D) && !U.inPart('hood', 0, 1.38, 0, D), 'bonnet, not the roof');
  assert.ok(U.inPart('trunk', -1.9, 1.0, 0.2, D));
  assert.ok(U.inPart('doorL', 0.3, 0.6, -0.92, D) && !U.inPart('doorL', 0.3, 0.6, 0.92, D), 'left door is GL -Z');
  assert.ok(U.inPart('doorR', 0.3, 0.6, 0.92, D));
  var b = carBody(), o = new Float32Array(b.length);
  var r = U.deformCar(b, o, { dims: D, parts: { doorL: true } });
  var holes = 0;
  for (var i = 0; i < r.mask.length; i++) {
    if (r.mask[i] & 1) { holes++; assert.ok(U.inPart('doorL', b[i * 3], b[i * 3 + 1], b[i * 3 + 2], D)); assert.ok(o[i * 3 + 2] > b[i * 3 + 2], 'skin pulled inward'); }
  }
  assert.ok(holes > 10, 'door region masked: ' + holes);
  var o2 = new Float32Array(b.length), r2 = U.deformCar(b, o2, { dims: D, hang: { doorR: 1, bumperF: 1 }, flap: 0.25 });
  var hung = 0, moved = 0;
  for (var j = 0; j < r2.mask.length; j++) if (r2.mask[j] & 2) { hung++; if (Math.hypot(o2[j * 3] - b[j * 3], o2[j * 3 + 1] - b[j * 3 + 1], o2[j * 3 + 2] - b[j * 3 + 2]) > 0.05) moved++; }
  assert.ok(hung > 10 && moved > hung * 0.4, 'hanging door / bumper swing: ' + moved + '/' + hung);
  assert.ok(finite(o2));
});

test('deformCar: broken lamp collapses only that side; lost merged wheels are hidden', function () {
  var D = U.damageDims(DIMS);
  var L = new Float32Array([2.2, 0.7, -0.6, 2.2, 0.7, 0.6, -2.2, 0.8, -0.6, -2.2, 0.8, 0.6]), o = new Float32Array(12);
  var r = U.deformCar(L, o, { dims: D, kind: 'light', lights: { fl: true } });
  assert.strictEqual(r.mask[0] & 1, 1); assert.strictEqual(r.mask[1], 0); assert.strictEqual(r.mask[2], 0);
  assert.ok(o[3] === L[3] && o[4] === L[4], 'right headlight intact');
  var Wh = new Float32Array([1.4, 0.34, -0.8, 1.4, 0.34, 0.8, -1.35, 0.34, -0.8, -1.35, 0.34, 0.8]), o2 = new Float32Array(12);
  var r2 = U.deformCar(Wh, o2, { dims: D, kind: 'wheels', lost: [false, true, false, false] });
  assert.ok(r2.mask[1] & 1 && !(r2.mask[0] & 1), 'FR (GL +Z front) hidden');
  assert.ok(Math.abs(o2[5]) < 0.8, 'pulled under the car');
});

test('paintDamage: dents scrape to bare metal, holes go dark, glass cracks milky, soot blackens', function () {
  var n = 4, cb = new Float32Array([0.7, 0.05, 0.03, 1, 0.7, 0.05, 0.03, 1, 0.7, 0.05, 0.03, 1, 0.01, 0.01, 0.01, 1]), co = new Float32Array(16);
  var w = new Float32Array([0, 0.4, 0.2, 0]), m = new Uint8Array([0, 0, 1, 0]);
  U.paintDamage(cb, co, 4, w, m, { kind: 'body' }, new Float32Array(12));
  assert.deepStrictEqual(Array.from(co.slice(0, 4)).map(function (v) { return +v.toFixed(5); }), [0.7, 0.05, 0.03, 1], 'undamaged vertex keeps its paint');
  assert.ok(co[4] < 0.7 && co[5] > 0.05, 'red paint scraped toward grey metal');
  assert.ok(co[8] < 0.05 && co[9] < 0.05, 'detached part = dark hole');
  U.paintDamage(cb, co, 4, new Float32Array(4), new Uint8Array(4), { kind: 'body', soot: 1 }, new Float32Array(12));
  assert.ok(co[0] < 0.7 * 0.5, 'soot blackens');
  U.paintDamage(cb, co, 4, new Float32Array(4), new Uint8Array(4), { kind: 'glass', glassCrack: 1 }, new Float32Array(12));
  assert.ok(co[12] > 0.2, 'dark glass turns milky');
  for (var i = 0; i < 16; i++) assert.ok(isFinite(co[i]) && co[i] >= 0);
});

test('wheelSink, camClear, damageKey', function () {
  var p = U.wheelSink([false, false, false, false], [true, false, false, false]);
  assert.ok(p.drop < 0 && p.drop > -0.05 && p.roll < 0, 'punctured FL sinks a little');
  var l = U.wheelSink([true, false, false, false], null);
  assert.ok(l.drop < p.drop && l.roll < p.roll * 2, 'lost wheel sinks much more');
  assert.strictEqual(U.camClear([0, 1, 0], [10, 1, 0], function () { return false; }), 1);
  var f = U.camClear([0, 1, 0], [10, 1, 0], function (x) { return x > 5 && x < 6; }, 20);
  assert.ok(f > 0.3 && f < 0.5, 'pulled in front of the pillar: ' + f);
  var k0 = U.damageKey({ dentSeq: 1, zones: { front: 0.2 } }), k1 = U.damageKey({ dentSeq: 1, zones: { front: 0.21 } }), k2 = U.damageKey({ dentSeq: 1, zones: { front: 0.4 } });
  assert.strictEqual(k0, k1, 'tiny zone changes do not re-deform'); assert.notStrictEqual(k0, k2);
  assert.notStrictEqual(U.damageKey({ parts: { hood: true } }), U.damageKey({}));
});

test('deformCar on a real car model: finite, bounded, every preset', function () {
  var fs = require('fs');
  try {
    require(path.join(root, 'js/data.js')); require(path.join(root, 'js/shapes/core.js'));
    [path.join(root, 'js/shapes/models')].forEach(function (d) { fs.readdirSync(d).filter(function (f) { return /\.js$/.test(f); }).sort().forEach(function (f) { require(path.join(d, f)); }); });
    require(path.join(root, 'js/race/gl/lowpoly.js'));
    var LPD = path.join(root, 'js/shapes/lowpoly'); if (fs.existsSync(LPD)) fs.readdirSync(LPD).filter(function (f) { return /\.js$/.test(f); }).sort().forEach(function (f) { require(path.join(LPD, f)); });
    require(path.join(root, 'js/race/gl/car-mesh.js'));
  } catch (e) { /* optional */ }
  assert.ok(CB.gl.car && CB.gl.car.buildGeometry && CB.data && CB.data.presetBuild, 'car geometry loads in Node');
  ['muscle', 'hot-hatch', 'overland'].forEach(function (pid) {
    var bg = CB.gl.car.buildGeometry(CB.data.presetBuild(pid), { lod: 'high' }), D = U.damageDims(bg.dims);
    bg.parts.filter(function (pp) { return !pp.attach || pp.attach === 'body'; }).forEach(function (pp) {
      var g = pp.geo.finish(), b = new Float32Array(g.positions), o = new Float32Array(b.length);
      U.deformCar(b, o, { dims: D, zones: { front: 1, rear: 1, left: 1, right: 1 }, roof: 1, parts: { hood: true, doorL: true }, hang: { doorR: 1 }, flap: 0.3,
        dents: [{ x: 1.8, y: 0, z: 0.6, nx: -1, ny: 0, depth: 0.4, r: 0.9 }] });
      assert.ok(finite(o), pid + ' ' + pp.kind);
      for (var i = 0; i < b.length; i += 3) assert.ok(Math.hypot(o[i] - b[i], o[i + 1] - b[i + 1], o[i + 2] - b[i + 2]) < 2.2, pid + ' bounded');
    });
  });
});

test('arena outlines: closed, CCW, open edges only on the rooftop', function () {
  AR.list().forEach(function (def) {
    var o = DA.outline(def, 2);
    assert.ok(o.length >= 24, def.id);
    var area = 0;
    for (var i = 0; i < o.length; i++) { var a = o[i], b = o[(i + 1) % o.length]; area += a.x * b.y - b.x * a.y; }
    assert.ok(area > 0, def.id + ' outline is CCW');
    var open = o.filter(function (p) { return p.open; }).length;
    if (def.id === 'rooftop') assert.ok(open > 5); else assert.strictEqual(open, 0, def.id);
    // every outline point lies on the boundary (sdBoundary ~ 0)
    o.forEach(function (p) { assert.ok(Math.abs(AR.sdBoundary(def, p.x, p.y).d) < 0.6, def.id + ' ' + p.x + ',' + p.y); });
  });
});

test('arena geometry: every arena builds at every quality, finite, within triangle budgets, lights / hazards present', function () {
  AR.list().forEach(function (def) {
    var hi = DA.buildGeometry(def, { quality: 'high' }), lo = DA.buildGeometry(def, { quality: 'low' });
    assert.ok(hi.stats.triangles > 5000 && hi.stats.triangles < 120000, def.id + ' high ' + hi.stats.triangles);
    assert.ok(lo.stats.triangles < hi.stats.triangles && lo.stats.triangles < 30000, def.id + ' low ' + lo.stats.triangles);
    Object.keys(hi.groups).forEach(function (k) { var g = hi.groups[k]; assert.ok(finite(g.p), def.id + ' ' + k); assert.strictEqual(g.p.length / 3 * 4, g.c.length); });
    if (def.timeOfDay !== 'day') assert.ok(hi.dynamic.lamps.length + hi.dynamic.spots.length > 0, def.id + ' night lights');
    if (def.id === 'junkyard') assert.strictEqual(hi.dynamic.crushers.length, 1);
    if (def.id === 'colosseum') { assert.strictEqual(hi.dynamic.fires.length, 4); assert.ok(hi.dynamic.spots.length >= 6); }
  });
});

test('accessory geometry: every accessory builds, anchors for the FX, hammer has a pivot', function () {
  var ids = CB.derby.accessories ? CB.derby.accessories.LIST.map(function (d) { return d.id; }) :
    ['flamethrower', 'ramp', 'hammer', 'bullbar', 'ram', 'armour', 'nitro', 'caltrops', 'oil', 'magnet', 'wrecking-ball', 'saws', 'shield', 'repair', 'spikes'];
  ids.forEach(function (id) {
    var r = DP.buildGeometry([id], { length: 4.5, width: 1.9, roof: 1.35 });
    assert.ok(r.stats.triangles > 4, id);
    Object.keys(r.groups).forEach(function (k) { assert.ok(finite(r.groups[k].p), id + ' ' + k); });
  });
  var all = DP.buildGeometry(ids, { length: 4.5, width: 1.9, roof: 1.35 });
  assert.ok(all.anchors.flame && all.anchors.magnet && all.anchors.hitch && all.anchors.hammerPivot && all.anchors.nitro.length === 2);
  assert.ok(all.hammer && all.hammer.pivot.length === 3);
  assert.ok(all.stats.triangles < 6000, 'full kit stays cheap: ' + all.stats.triangles);
  ['ball', 'chainLink', 'bubble', 'caltrop'].forEach(function (k) { var g = DP[k + 'Geometry'](); assert.ok(g.triangles > 0 && finite(g.positions), k); });
  ['panel', 'wheel', 'chunk', 'hood', 'door', 'bumper'].forEach(function (k) { assert.ok(DP.debrisGeometry(k).triangles > 0, k); });
});

test('renderer module loads in Node without WebGL and exposes the spec surface', function () {
  assert.strictEqual(typeof DR.create, 'function');
  assert.strictEqual(typeof DR.createPreview, 'function');
  assert.deepStrictEqual(DR.MODES, ['chase', 'far', 'hood', 'overhead']);
  ['low', 'medium', 'high', 'ultra'].forEach(function (q) { assert.ok(DR.QUALITY[q]); });
  assert.strictEqual(DR.QUALITY.low.shadow, 0);
  assert.strictEqual(DR.QUALITY.low.shake, false, 'camera shake is tier-gated');
  assert.strictEqual(DR.createPreview(null).ok, false);
});

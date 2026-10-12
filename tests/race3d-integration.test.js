/* FORGE Atelier — 3D race view integration tests (Node, no DOM / GL).
   Loads every js/race/gl module into ONE CB namespace in race3d.html order and checks the cross-module contracts
   the renderer relies on: nothing clobbers the core, renderer3d detects the real core, track + scenery materials
   resolve through gl-core, the cockpit hides every exterior part of the player's car that would float through the
   interior, car-local axes / sim->GL conversion agree between car-mesh and renderer3d, and the scenery never puts
   geometry on the racing surface. */
'use strict';
var assert = require('assert');
var path = require('path');

var ROOT = path.join(__dirname, '..');
function load(rel) { return require(path.join(ROOT, rel)); }
load('js/data.js');
var T = load('js/race/tracks.js');
['js/race/gl/gl-core.js', 'js/race/gl/textures.js', 'js/race/gl/track-mesh.js', 'js/race/gl/scenery.js',
  'js/race/gl/car-mesh.js', 'js/race/gl/cockpit.js', 'js/race/gl/effects.js', 'js/race/gl/renderer3d.js'].forEach(load);
var CB = globalThis.CB, GL = CB.gl, R3 = CB.race.renderer3d;

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var test = standalone
  ? function (name, fn) {
    try { fn(); console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
  }
  : globalThis.test;

function finite(v) { return typeof v === 'number' && isFinite(v); }
function allFinite(a) { for (var i = 0; i < a.length; i++) if (!isFinite(a[i])) return false; return true; }

test('integration: all gl modules share one CB.gl namespace and the core survives', function () {
  ['createContext', 'createMesh', 'shaders', 'drawList', 'createShadowMap', 'createRenderTarget', 'resolveMaterial', 'mat4', 'geometry']
    .forEach(function (k) { assert.ok(GL[k], 'CB.gl.' + k + ' missing after loading all modules'); });
  ['textures', 'track', 'scenery', 'car', 'cockpit', 'effects'].forEach(function (k) { assert.ok(GL[k], 'CB.gl.' + k + ' missing'); });
  assert.strictEqual(typeof GL.track.build, 'function');
  assert.strictEqual(typeof GL.scenery.build, 'function');
  assert.strictEqual(typeof GL.car.build, 'function');
  assert.strictEqual(typeof GL.car.pose, 'function');
  assert.strictEqual(typeof GL.cockpit.build, 'function');
  assert.strictEqual(typeof GL.effects.create, 'function');
  assert.strictEqual(typeof GL.effects.getLighting, 'function');
  assert.ok(R3._.hasCore(), 'renderer3d must detect gl-core (else it falls back to its lite core)');
});

test('integration: effects lighting feeds renderer-compatible colours for every time of day / weather', function () {
  ['day', 'dusk', 'night'].forEach(function (tod) {
    ['dry', 'damp', 'wet'].forEach(function (w) {
      var L = GL.effects.getLighting(tod, w);
      ['sunDir', 'sunColor', 'fogColor', 'ambientSky', 'ambientGround'].forEach(function (k) {
        assert.ok(L[k] && L[k].length >= 3 && allFinite(L[k]), tod + '/' + w + ' ' + k);
      });
      assert.ok(L.sunDir[1] > 0, 'sun above horizon');
      assert.ok(finite(L.fogDensity) && L.fogDensity >= 0 && L.fogDensity < 0.05, 'fog density ' + L.fogDensity);
    });
  });
});

var defs = T.list.map(function (t) { return T.get ? T.get(t.id) : t; });
var geoms = {};
function geomOf(def) { return geoms[def.id] || (geoms[def.id] = T.build(def)); }

defs.forEach(function (def) {
  test('integration: ' + def.id + ' track + scenery materials resolve through gl-core', function () {
    var g = geomOf(def);
    var tg = GL.track.buildGeometry(g, def, { quality: 'medium' });
    var parts = tg.parts || tg.meshes || [];
    assert.ok(parts.length > 5, 'track parts');
    parts.forEach(function (p) {
      var m = GL.resolveMaterial(p.material || {});
      ['r', 'g', 'b', 'a', 'metallic', 'roughness'].forEach(function (k) { assert.ok(finite(m[k]), def.id + ' track ' + p.kind + ' ' + k); });
    });
    var sg = GL.scenery.buildGeometry(g, def, { quality: 'medium', timeOfDay: 'night' });
    assert.ok(sg.parts && sg.parts.length > 3, 'scenery parts');
    sg.parts.forEach(function (p) {
      var m = GL.resolveMaterial(p.material || {});
      assert.ok(finite(m.r) && finite(m.roughness), def.id + ' scenery ' + (p.kind || p.mat));
    });
  });
});

test('integration: night scenery has no huge solid self-lit panels (shopfronts are split into window bays)', function () {
  var def = defs.filter(function (d) { return /neon|harbour/.test(d.id); })[0] || defs[0];
  var sg = GL.scenery.buildGeometry(geomOf(def), def, { quality: 'high', timeOfDay: 'night' });
  sg.parts.filter(function (p) { return /lamp/.test(p.mat || p.kind || (p.material && p.material.name) || ''); }).forEach(function (p) {
    var pos = p.positions || (p.geometry && p.geometry.positions), idx = p.indices || (p.geometry && p.geometry.indices);
    if (!pos || !idx) return;
    for (var t = 0; t < idx.length; t += 3) {
      var a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      var vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      var cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      var area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
      assert.ok(area < 40, 'self-lit triangle of ' + area.toFixed(1) + ' m2 on ' + def.id);
    }
  });
});

test('integration: cockpit hides every exterior part of the player car that would float through the interior', function () {
  var b = CB.data.defaultBuild();
  var g = GL.car.buildGeometry(b, { lod: 'high' });
  var kinds = {};
  g.parts.forEach(function (p) { kinds[p.kind] = true; });
  var hide = GL.cockpit.HIDE_KINDS;
  ['body', 'glass', 'interior', 'driver', 'tire-fl', 'tire-fr', 'tire-rl', 'tire-rr', 'wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr']
    .forEach(function (k) {
      if (kinds[k]) assert.ok(hide.indexOf(k) >= 0, 'cockpit.HIDE_KINDS lacks car part kind "' + k + '"');
    });
  Object.keys(kinds).filter(function (k) { return /^caliper-/.test(k); }).forEach(function (k) { assert.ok(hide.indexOf(k) >= 0, k); });
});

test('integration: car-mesh eye sits inside the car and cockpit layout uses it', function () {
  var b = CB.data.defaultBuild();
  var m = GL.car.build({}, b, { lod: 'high' });
  var d = m.dims, e = m.cockpitEye;
  assert.ok(e && e.length === 3 && allFinite(e), 'cockpitEye');
  assert.ok(Math.abs(e[0]) < d.length / 2 && Math.abs(e[2]) < d.width / 2 && e[1] > 0.6 && e[1] < d.height + 0.2, 'eye inside the car ' + e);
  assert.ok(e[2] < 0, 'left-hand drive: driver sits on the car-local -Z (left) side');
  var L = GL.cockpit.layout(b, { eye: e, dims: d });
  assert.ok(L && L.wheel && L.wheel.c && L.wheel.c[0] > e[0], 'steering wheel ahead of the eye');
  if (m.destroy) m.destroy();
});

test('integration: car pose world matrix agrees with renderer3d sim->GL convention (sim y -> GL -z)', function () {
  var b = CB.data.defaultBuild();
  var model = GL.car.build({}, b, { lod: 'low' });
  var snap = { id: 'p', x: 12, y: 34, heading: 0.6, speed: 0, steerAngle: 0, brake: 0, throttle: 0 };
  var items = GL.car.pose(model, snap, 1 / 60, {});
  assert.ok(items && items.length, 'pose items');
  var body = items.filter(function (i) { return i.kind === 'body'; })[0] || items[0];
  var M = body.model, R = new Float32Array(16);
  R3._.carMatrix(R, 12, 34, 0, 0.6, 0, 0);
  // translation and forward (+X local) axis must match the renderer's own car matrix
  assert.ok(Math.abs(M[12] - R[12]) < 0.05 && Math.abs(M[14] - R[14]) < 0.05, 'position ' + [M[12], M[14]] + ' vs ' + [R[12], R[14]]);
  var f = [M[0], M[1], M[2]], fl = Math.hypot(f[0], f[1], f[2]);
  assert.ok(Math.abs(f[0] / fl - Math.cos(0.6)) < 0.03 && Math.abs(f[2] / fl + Math.sin(0.6)) < 0.03, 'forward axis');
  if (model.destroy) model.destroy();
});

test('integration: renderer3d quality tables keep the mirror cheap and every camera mode labelled', function () {
  R3.QUALITY_ORDER.forEach(function (q) {
    var Q = R3.QUALITY[q];
    assert.ok(Q.mirrorScale > 0 && Q.mirrorScale <= 0.35, q + ' mirror scale');
    assert.ok(Q.mirrorEvery >= 1, q + ' mirror cadence');
  });
  R3.CAMERA_MODES.forEach(function (m) { assert.ok(R3.CAMERA_LABELS[m], 'label for ' + m); });
});

test('integration: TV broadcast cameras never stand inside buildings / grandstands (street circuits included)', function () {
  var SOLID = { building: 1, city: 1, grandstand: 1, pits: 1, tower: 1, 'tv-tower': 1, 'footbridge-tower': 1, truck: 1, tent: 1, tree: 1 };
  defs.forEach(function (def) {
    var g = geomOf(def);
    var sg = GL.scenery.buildGeometry(g, def, { quality: 'high' });
    var cams = R3._.buildTvCams(g, { blockers: sg.placed });
    assert.ok(cams.length >= 4, def.id + ' has ' + cams.length + ' TV cams');
    cams.forEach(function (c) {
      var nearWall = false, p = g.project ? g.project(c.x, c.y) : null;
      if (p && (p.surface === 'wall' || (finite(p.wallDist) && p.wallDist > -1.0))) nearWall = true;   // pole cam on the barrier line
      sg.placed.forEach(function (o) {
        if (!SOLID[o.type] || nearWall) return;
        assert.ok(Math.hypot(c.x - o.x, c.y - o.y) >= (o.r || 2) + 1.5, def.id + ' TV cam inside ' + o.type);
      });
    });
  });
});

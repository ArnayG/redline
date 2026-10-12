/* Node tests for js/race/gl/scenery.js (CB.gl.scenery) — pure geometry + GL build against a mock core.
   Every catalog circuit must build at every quality, deterministically, with sane buffers, nothing standing
   on the racing surface, a start gantry with 5 controllable countdown lights, lamp lights at night and a
   working LOD / culling runtime. */
'use strict';
var assert = require('assert');
var path = require('path');

var T = require(path.join(__dirname, '..', 'js', 'race', 'tracks.js'));
var TM = require(path.join(__dirname, '..', 'js', 'race', 'gl', 'track-mesh.js'));
var SC = require(path.join(__dirname, '..', 'js', 'race', 'gl', 'scenery.js'));

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var test = standalone
  ? function (name, fn) {
    try { fn(); console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
  }
  : globalThis.test;

var geoms = {}, grounds = {}, cache = {};
function geomOf(def) { return geoms[def.id] || (geoms[def.id] = T.build(def)); }
function groundOf(def) { return grounds[def.id] || (grounds[def.id] = TM.buildGeometry(geomOf(def), def, { quality: 'low' }).groundY); }
function sceneryOf(def, q, tod) {
  var k = def.id + ':' + q + ':' + (tod || '');
  if (!cache[k]) {
    var warns = [], ow = console.warn;
    console.warn = function () { warns.push([].slice.call(arguments).join(' ')); };
    try { cache[k] = SC.buildGeometry(geomOf(def), def, { quality: q, groundY: groundOf(def), timeOfDay: tod || def.timeOfDay }); }
    finally { console.warn = ow; }
    cache[k].warnings = warns;
  }
  return cache[k];
}

test('scenery exports the spec API', function () {
  assert.strictEqual(typeof SC.build, 'function');
  assert.strictEqual(typeof SC.buildGeometry, 'function');
  assert.ok(SC.QUALITY && SC.QUALITY.low && SC.QUALITY.ultra);
});

test('every track builds at every quality with valid buffers and no warnings', function () {
  T.list.forEach(function (def) {
    ['low', 'medium', 'high', 'ultra'].forEach(function (q) {
      var r = sceneryOf(def, q);
      assert.deepStrictEqual(r.warnings, [], def.id + ' ' + q + ' warnings');
      assert.ok(r.parts.length > 10, def.id + ' has parts');
      r.parts.forEach(function (p) {
        var nv = p.positions.length / 3;
        assert.ok(p.indices instanceof Uint16Array, 'Uint16 indices');
        assert.ok(nv <= 65535, 'vertex count fits Uint16');
        assert.strictEqual(p.normals.length, p.positions.length);
        assert.strictEqual(p.uvs.length, nv * 2);
        assert.strictEqual(p.colors.length, nv * 4);
        assert.strictEqual(p.indices.length % 3, 0);
        for (var i = 0; i < p.indices.length; i++) if (p.indices[i] >= nv) throw new Error(def.id + ' index out of range in ' + p.key);
        for (var j = 0; j < p.positions.length; j++) if (!isFinite(p.positions[j])) throw new Error(def.id + ' NaN position in ' + p.key);
        for (j = 0; j < p.normals.length; j++) if (!isFinite(p.normals[j])) throw new Error(def.id + ' NaN normal in ' + p.key);
        for (j = 0; j < p.uvs.length; j++) if (!isFinite(p.uvs[j])) throw new Error(def.id + ' NaN uv in ' + p.key);
        assert.ok(isFinite(p.bounds.radius), 'finite bounds');
      });
    });
  });
});

test('triangle budget scales with quality', function () {
  T.list.forEach(function (def) {
    var lo = sceneryOf(def, 'low').stats.triangles, hi = sceneryOf(def, 'high').stats.triangles, ul = sceneryOf(def, 'ultra').stats.triangles;
    assert.ok(lo <= hi + 1 && hi <= ul + 1, def.id + ' monotonic ' + lo + ' ' + hi + ' ' + ul);
    assert.ok(hi < 400000, def.id + ' high budget ' + hi);
    assert.ok(ul < 600000, def.id + ' ultra budget ' + ul);
  });
});

test('deterministic: same track -> identical geometry', function () {
  var def = T.get('forge-ring');
  var a = SC.buildGeometry(geomOf(def), def, { quality: 'medium', groundY: groundOf(def) });
  var b = SC.buildGeometry(geomOf(def), def, { quality: 'medium', groundY: groundOf(def) });
  assert.strictEqual(a.parts.length, b.parts.length);
  assert.strictEqual(a.stats.triangles, b.stats.triangles);
  for (var i = 0; i < a.parts.length; i++) {
    assert.strictEqual(a.parts[i].key, b.parts[i].key);
    var pa = a.parts[i].positions, pb = b.parts[i].positions;
    assert.strictEqual(pa.length, pb.length);
    for (var j = 0; j < pa.length; j += 97) assert.strictEqual(pa[j], pb[j]);
  }
});

test('nothing low stands on the racing surface (sampled vertices, tracks.project)', function () {
  T.list.forEach(function (def) {
    var g = geomOf(def), r = sceneryOf(def, 'high'), bad = 0, checked = 0, worst = null;
    r.parts.forEach(function (p) {
      if (p.lod === 'global' || p.dynamic) return;
      var P = p.positions;
      for (var i = 0; i < P.length; i += 3 * 11) {
        var y = P[i + 1];
        if (y > 2.2) continue;               // gantry / footbridge decks and lamp arms span the track overhead
        var x = P[i], sy = -P[i + 2], pr = T.project(g, x, sy);
        var sm = g.samples[pr.index];
        if (sm.layer) continue;              // bridge ramps (elevated deck)
        checked++;
        if (pr.onTrack) { bad++; if (!worst) worst = p.key + ' @ ' + x.toFixed(1) + ',' + sy.toFixed(1); }
      }
    });
    assert.ok(checked > 100, def.id + ' checked');
    assert.strictEqual(bad, 0, def.id + ': ' + bad + ' vertices on track, e.g. ' + worst);
  });
});

test('placed objects are clear of the barriers', function () {
  T.list.forEach(function (def) {
    var g = geomOf(def), r = sceneryOf(def, 'high');
    r.placed.forEach(function (o) {
      if (o.spans || o.authored || o.marker) return;    // the footbridge spans the track; authored items were checked by tracks.js
      var pr = T.project(g, o.x, o.y);
      assert.ok(pr.wallDist < 0.2, def.id + ' ' + o.type + ' inside the barriers (wallDist ' + pr.wallDist.toFixed(2) + ')');
    });
  });
});

test('start gantry with 5 countdown light parts on every track', function () {
  T.list.forEach(function (def) {
    var r = sceneryOf(def, 'high');
    assert.ok(r.gantry && r.gantry.pos, def.id + ' gantry');
    var lights = r.dynamic.filter(function (p) { return p.light != null; }).map(function (p) { return p.light; }).sort();
    assert.deepStrictEqual(lights, [0, 1, 2, 3, 4], def.id + ' countdown lights');
  });
});

test('night tracks get lamp lights; footbridge on circuits; city for street tracks; trees elsewhere', function () {
  var neon = sceneryOf(T.get('neon-harbour'), 'high');
  assert.ok(neon.lights.length >= 30, 'neon harbour lamp lights ' + neon.lights.length);
  neon.lights.forEach(function (l) {
    assert.ok(l.pos && l.pos.length === 3 && l.pos.every(isFinite));
    assert.ok(l.range > 0 && l.color.length === 3);
    if (l.dir) assert.ok(Math.abs(Math.hypot(l.dir[0], l.dir[1], l.dir[2]) - 1) < 1e-3);
  });
  var dusk = sceneryOf(T.get('ouroboros'), 'high', 'night');
  assert.ok(dusk.lights.length > 10, 'procedural lamps at night ' + dusk.lights.length);
  assert.ok(sceneryOf(T.get('forge-ring'), 'high').placed.some(function (o) { return o.type === 'footbridge'; }), 'forge ring footbridge');
  assert.ok((sceneryOf(T.get('porto-vecchio'), 'high').stats.byType.city || 0) > 50, 'porto city fill');
  assert.ok(sceneryOf(T.get('forge-ring'), 'high').stats.trees > 500, 'forge ring forest');
  assert.ok(sceneryOf(T.get('akagane-pass'), 'high').placed.some(function (o) { return o.type === 'retaining-walls'; }), 'touge walls');
  assert.ok(sceneryOf(T.get('forge-ring'), 'high').parts.some(function (p) { return p.lod === 'global'; }), 'skyline ring');
});

/* ---------------- GL build against a mock core */
function withMockCore(fn) {
  var CB = globalThis.CB;
  var prev = CB.gl.createMesh, n = 0;
  CB.gl.createMesh = function (ctx, geo) { n++; return { geo: geo, bounds: null, destroyed: false, destroy: function () { this.destroyed = true; } }; };
  try { return fn(function () { return n; }); } finally { if (prev) CB.gl.createMesh = prev; else delete CB.gl.createMesh; }
}

test('build(): items, LOD selection, countdown lights, skyline follows the camera, destroy', function () {
  var def = T.get('forge-ring'), g = geomOf(def);
  withMockCore(function (count) {
    var sc = SC.build({ mock: true }, g, def, { quality: 'high', groundY: groundOf(def) });
    assert.ok(count() > 20 && sc.items.length === count(), 'one mesh per item');
    assert.strictEqual(sc.hasGantry, true);
    assert.ok(Array.isArray(sc.lights));
    sc.items.forEach(function (it) {
      assert.ok(it.mesh && it.material && it.model && it.model.length === 16);
      assert.ok(it.material.uBaseColor && it.material.baseColor, 'both material key conventions');
    });
    var s0 = g.samples[0], cam = [s0.x, 1.2, -s0.y];
    sc.update(1, cam, { phase: 'countdown', countdown: { lightsOn: 3, lightsOut: false } }, { far: 2600 });
    var vis = sc.getItems(cam);
    assert.ok(vis.length > 0 && vis.length < sc.items.length, 'distance culling ' + vis.length + '/' + sc.items.length);
    var sky = vis.filter(function (it) { return it.lod === 'global'; });
    assert.ok(sky.length > 0, 'skyline always drawn');
    assert.ok(sky[0].model[12] === cam[0] && sky[0].model[14] === cam[2] && sky[0].model[0] > 100, 'skyline centred on camera, scaled');
    assert.strictEqual(sky[0].material.depthWrite, false, 'backdrop does not write depth');
    // near models and far cards are complementary per chunk
    var nearKeys = {}, farKeys = {};
    vis.forEach(function (it) { if (it.lod === 'near') nearKeys[it.chunk] = 1; if (it.lod === 'far') farKeys[it.chunk] = 1; });
    Object.keys(nearKeys).forEach(function (k) { assert.ok(!farKeys[k], 'chunk ' + k + ' drawn twice'); });
    // countdown lights: 3 of 5 lit
    var lens = sc.items.filter(function (it) { return /^scenery-countdown-/.test(it.material.name); });
    assert.strictEqual(lens.length, 5);
    var lit = lens.filter(function (it) { return it.material.uBaseColor[0] > 1; }).length;
    assert.strictEqual(lit, 3);
    sc.setCountdown({ lightsOn: 5, lightsOut: true });
    assert.strictEqual(lens.filter(function (it) { return it.material.uBaseColor[0] > 1; }).length, 0, 'lights out');
    assert.strictEqual(sc.setQuality('low'), 'low');
    var visLow = sc.getItems(cam).length;
    assert.ok(visLow <= vis.length, 'lower quality draws no more');
    sc.destroy();
    assert.strictEqual(sc.getItems(cam).length, 0);
  });
});

test('build() without a GL core degrades gracefully', function () {
  var def = T.get('little-anvil'), g = geomOf(def);
  var CB = globalThis.CB, prev = CB.gl.createMesh;
  delete CB.gl.createMesh;
  try {
    var sc = SC.build(null, g, def, {});
    assert.ok(sc.items.length > 0 && sc.items.every(function (it) { return it.mesh === null && it.geometry; }));
    assert.doesNotThrow(function () { sc.update(0, [0, 0, 0], null, null); sc.getItems([0, 0, 0]); sc.setCountdown(null); });
  } finally { if (prev) CB.gl.createMesh = prev; }
});

test('foliage: faceted trees wound outward, wind-sway weights encoded in colour alpha, tufts + touge roadside detail', function () {
  try { require(path.join(__dirname, '..', 'js', 'race', 'drift', 'tracks.js')); } catch (e) { /* optional */ }
  ['kurogane-pass', 'forge-ring', 'circle-lab'].forEach(function (id) {
    var def = T.get(id);
    if (!def) return;
    var r = sceneryOf(def, 'high'), g = geomOf(def), fol = 0, swaying = 0, flipped = 0, grassOn = 0, grass = 0;
    r.parts.forEach(function (p) {
      var C = p.colors, P = p.positions, Nn = p.normals, I = p.indices, i;
      if (p.mat === 'foliage' || p.mat === 'treeCard' || p.mat === 'grass') {
        for (i = 3; i < C.length; i += 4) { assert.ok(C[i] >= 0.989 && C[i] <= 1, id + ' sway alpha ' + C[i]); if (C[i] < 0.9999) swaying++; }
      }
      if (p.mat === 'foliage' && p.lod === 'near') {
        for (i = 0; i < I.length; i += 3 * 7) {
          var a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
          var ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
          var gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
          var d = gx * (Nn[a] + Nn[b] + Nn[c]) + gy * (Nn[a + 1] + Nn[b + 1] + Nn[c + 1]) + gz * (Nn[a + 2] + Nn[b + 2] + Nn[c + 2]);
          fol++; if (d < -1e-9) flipped++;
        }
      }
      if (p.mat === 'grass') {
        for (i = 0; i < P.length; i += 3 * 5) { grass++; if (T.project(g, P[i], -P[i + 2]).wallDist > 0) grassOn++; }
      }
    });
    assert.ok(fol > 100, id + ' near foliage triangles');
    assert.ok(flipped / fol < 0.03, id + ' foliage winding (flipped ' + flipped + '/' + fol + ')');
    assert.ok(swaying > 1000, id + ' sway-weighted vertices');
    assert.ok(grass > 100, id + ' grass tufts');
    assert.strictEqual(grassOn, 0, id + ' grass tufts inside the barriers');
    if (def.style && def.style.touge) assert.ok(r.stats.poles > 3, id + ' utility poles');
  });
  // low quality: no tufts and no sway program
  var lo = sceneryOf(T.get('forge-ring'), 'low');
  assert.ok(!lo.parts.some(function (p) { return p.mat === 'grass'; }), 'no tufts on low');
});

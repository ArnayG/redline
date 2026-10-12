/* Node tests for js/race/gl/track-mesh.js (CB.gl.track) — pure geometry, no GL.
   Every catalog circuit must build at every quality without NaN / bad indices, within the
   triangle budget, with the road + edge lines exactly spanning the sim width, walls exactly on
   the engine's wall line (sample.wallL / wallR) and sane groundY / roadY. */
'use strict';
var assert = require('assert');
var path = require('path');

var T = require(path.join(__dirname, '..', 'js', 'race', 'tracks.js'));
var TM = require(path.join(__dirname, '..', 'js', 'race', 'gl', 'track-mesh.js'));

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var test = standalone
  ? function (name, fn) {
    try { fn(); console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
  }
  : globalThis.test;

var geoms = {}, built = {};
function geomOf(def) { return geoms[def.id] || (geoms[def.id] = T.build(def)); }
function meshOf(def, q) {
  var k = def.id + ':' + q;
  return built[k] || (built[k] = TM.buildGeometry(geomOf(def), def, { quality: q }));
}
// lateral (+left) of a sim point relative to sample i
function latAt(sm, x, y) { return (x - sm.x) * sm.nx + (y - sm.y) * sm.ny; }
function nearestSample(S, x, y) {
  var best = 0, bd = Infinity;
  for (var i = 0; i < S.length; i++) {
    var dx = x - S[i].x, dy = y - S[i].y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

test('track-mesh exports the spec API', function () {
  assert.strictEqual(typeof TM.build, 'function');
  assert.strictEqual(typeof TM.buildGeometry, 'function');
  assert.ok(T.list && T.list.length >= 1);
});

T.list.forEach(function (def) {
  ['low', 'medium', 'high', 'ultra'].forEach(function (q) {
    test(def.id + ' [' + q + '] builds without NaN, valid indices, < 600k triangles', function () {
      var r = meshOf(def, q);
      assert.ok(r.parts.length > 0, 'no parts');
      var tris = 0;
      r.parts.forEach(function (p) {
        assert.ok(p.vertexCount > 0 && p.vertexCount <= 65535, p.kind + ' vertex count ' + p.vertexCount);
        assert.strictEqual(p.positions.length, p.vertexCount * 3);
        assert.strictEqual(p.normals.length, p.vertexCount * 3);
        assert.strictEqual(p.uvs.length, p.vertexCount * 2);
        assert.strictEqual(p.colors.length, p.vertexCount * 4);
        assert.strictEqual(p.indices.length % 3, 0);
        [p.positions, p.normals, p.uvs, p.colors].forEach(function (a) {
          for (var i = 0; i < a.length; i++) if (!isFinite(a[i])) assert.fail(p.kind + ' has non-finite value at ' + i);
        });
        for (var i = 0; i < p.indices.length; i++) if (p.indices[i] >= p.vertexCount) assert.fail(p.kind + ' index out of range');
        for (var n = 0; n < p.normals.length; n += 3) {
          var l = Math.hypot(p.normals[n], p.normals[n + 1], p.normals[n + 2]);
          if (Math.abs(l - 1) > 0.02) assert.fail(p.kind + ' normal not unit: ' + l);
        }
        tris += p.triangleCount;
      });
      assert.ok(tris > 5000, 'suspiciously few triangles: ' + tris);
      // 600k budget per 7 km of circuit (long rings get a proportionally larger budget).
      var budget = 600000 * Math.max(1, (T.build ? T.build(def).length : 0) / 7000);
      assert.ok(tris < budget, 'too many triangles: ' + tris + ' (budget ' + Math.round(budget) + ')');
      assert.strictEqual(r.stats.triangles, tris);
      var kinds = {};
      r.parts.forEach(function (p) { kinds[p.kind] = 1; });
      ['terrain', 'road', 'line', 'kerb', 'decal'].forEach(function (k) { assert.ok(kinds[k], 'missing part kind ' + k); });
    });
  });

  test(def.id + ' road ribbon + edge lines span exactly the sim width', function () {
    var g = geomOf(def), S = g.samples, r = meshOf(def, 'high'), LW = TM.constants.LINE_W;
    var maxRoad = -Infinity, maxLine = -Infinity, minLine = Infinity, checked = 0;
    r.parts.forEach(function (p) {
      if (p.kind !== 'road' && p.kind !== 'line') return;
      for (var v = 0; v < p.vertexCount; v += 5) {
        var x = p.positions[v * 3], y = -p.positions[v * 3 + 2];
        var sm = S[nearestSample(S, x, y)];
        var lon = (x - sm.x) * sm.tx + (y - sm.y) * sm.ty;
        if (Math.abs(lon) > 0.05) continue;                // vertex sits on another sample's ring
        var al = Math.abs(latAt(sm, x, y));
        if (p.kind === 'road') maxRoad = Math.max(maxRoad, al - (sm.hw - LW));
        else { maxLine = Math.max(maxLine, al - sm.hw); minLine = Math.min(minLine, al - (sm.hw - LW)); }
        checked++;
      }
    });
    assert.ok(checked > 100, 'too few vertices checked');
    assert.ok(Math.abs(maxRoad) < 0.01, 'road edge off by ' + maxRoad);
    assert.ok(Math.abs(maxLine) < 0.01, 'edge line outer edge off by ' + maxLine);
    assert.ok(minLine > -0.01, 'edge line intrudes into road by ' + minLine);
  });

  test(def.id + ' walls lie on the engine wall line (sample.wallL / wallR)', function () {
    var g = geomOf(def), S = g.samples, r = meshOf(def, 'high');
    var exact = 0;
    for (var i = 0; i < S.length; i++) {
      var sm = S[i];
      var lx = r.walls.left[i][0], ly = -r.walls.left[i][1], rx = r.walls.right[i][0], ry = -r.walls.right[i][1];
      var el = Math.hypot(lx - (sm.x + sm.nx * sm.wallL), ly - (sm.y + sm.ny * sm.wallL));
      var er = Math.hypot(rx - (sm.x - sm.nx * sm.wallR), ry - (sm.y - sm.ny * sm.wallR));
      if (el < 1e-6) exact++;
      if (er < 1e-6) exact++;
      // folded inside-of-bend points are collapsed onto a neighbour: still never inside the track
      assert.ok(Math.abs(latAt(sm, lx, ly)) > sm.hw, 'left wall on the road at ' + i);
      assert.ok(Math.abs(latAt(sm, rx, ry)) > sm.hw, 'right wall on the road at ' + i);
    }
    // the only allowed deviation: points where the sim offset curve folds back on itself inside a
    // hairpin (wall radius > bend radius) are collapsed onto the previous point to avoid a twisted mesh
    assert.ok(exact + r.stats.wallFolds >= S.length * 2, 'walls off the sim line: ' + exact + '+' + r.stats.wallFolds + ' folds / ' + S.length * 2);
    assert.ok(r.stats.wallFolds <= S.length * 2 * 0.06, 'too many folded wall points: ' + r.stats.wallFolds);
  });

  test(def.id + ' groundY / roadY / heightAt are finite and terrain stays below the road', function () {
    var g = geomOf(def), S = g.samples, r = meshOf(def, 'high');
    for (var i = 0; i < S.length; i += 7) {
      var sm = S[i];
      var gy = r.groundY(sm.x, -sm.y);
      assert.ok(isFinite(gy), 'groundY NaN');
      assert.ok(gy <= 0.001, 'terrain pokes through the road at ' + i + ': ' + gy);
      assert.ok(isFinite(r.heightAt(sm.s)) && isFinite(r.roadY(sm.x, -sm.y, i)));
      // well beyond the walls the terrain may undulate but stays bounded
      var far = r.groundY(sm.x + sm.nx * (sm.wallL + 150), -(sm.y + sm.ny * (sm.wallL + 150)));
      assert.ok(isFinite(far) && far > -5 && far < 80, 'terrain height out of range: ' + far);
    }
    assert.ok(isFinite(r.groundY(1e6, 1e6)));
  });
});

test('street circuits get raised sidewalks behind the barriers that never intrude inside any wall corridor', function () {
  var streets = T.list.filter(function (d) { return d.style && d.style.street; });
  assert.ok(streets.length > 0, 'expected at least one street circuit');
  streets.forEach(function (def) {
    var g = geomOf(def), S = g.samples, r = meshOf(def, 'high'), ds = g.length / S.length, n = 0;
    r.parts.forEach(function (p) {
      if (p.kind !== 'sidewalk') return;
      for (var v = 0; v < p.vertexCount; v += 3) {
        var x = p.positions[v * 3], y = -p.positions[v * 3 + 2];
        n++;
        for (var i = 0; i < S.length; i++) {
          var sm = S[i], dx = x - sm.x, dy = y - sm.y;
          if (Math.abs(dx * sm.tx + dy * sm.ty) > ds * 0.5) continue;
          var lat = latAt(sm, x, y), wall = lat >= 0 ? sm.wallL : sm.wallR;
          if (Math.abs(lat) < wall + 0.5) assert.fail(def.id + ' sidewalk vertex inside the wall corridor of sample ' + i + ' (lat ' + lat.toFixed(2) + ', wall ' + wall + ')');
        }
      }
    });
    assert.ok(n > 100, def.id + ' has no sidewalk geometry');
  });
});

test('figure-8 bridge: upper deck raised, lower road at grade (roadY uses the sample hint)', function () {
  var def = T.list.filter(function (d) { return d.crossing === 'bridge'; })[0];
  if (!def) return;
  var g = geomOf(def), r = meshOf(def, 'high');
  var cr = (g.crossings || []).filter(function (c) { return c.type === 'bridge'; })[0];
  assert.ok(cr, 'no bridge crossing');
  var up = g.samples[cr.upperIndex], lo = g.samples[cr.lowerIndex];
  assert.ok(r.heightAtIndex(cr.upperIndex) > 4, 'deck not raised');
  assert.ok(r.roadY(up.x, -up.y, cr.upperIndex) > 4, 'roadY on deck');
  assert.ok(Math.abs(r.roadY(lo.x, -lo.y, cr.lowerIndex)) < 0.01, 'lower road should stay at y=0');
});

test('build() without a GL context returns meshes with pure geometry + API', function () {
  var def = T.list[0], g = geomOf(def);
  var b = TM.build(null, g, def, { quality: 'low' });
  assert.ok(Array.isArray(b.meshes) && b.meshes.length > 0);
  assert.strictEqual(typeof b.groundY, 'function');
  assert.strictEqual(typeof b.roadY, 'function');
  assert.ok(b.bounds && b.bounds.min.length === 3);
  b.meshes.forEach(function (m) { assert.ok(m.geometry && m.material && m.model && m.model.length === 16); });
  b.destroy();
});

test('buildGeometry is deterministic', function () {
  var def = T.list[T.list.length - 1], g = geomOf(def);
  var a = TM.buildGeometry(g, def, { quality: 'low' }), b = TM.buildGeometry(g, def, { quality: 'low' });
  assert.strictEqual(a.stats.triangles, b.stats.triangles);
  assert.strictEqual(a.parts.length, b.parts.length);
  for (var i = 0; i < a.parts[0].positions.length; i += 97) assert.strictEqual(a.parts[0].positions[i], b.parts[0].positions[i]);
});

test('track-mesh: asphalt materials carry the world-space mottle (gl-core uMottleMap / uMottle) against tiling', function () {
  var GL = require(path.join(__dirname, '..', 'js', 'race', 'gl', 'gl-core.js'));
  var fs = GL.SOURCES.STANDARD_FS;
  assert.ok(/uniform sampler2D uMottleMap/.test(fs) && /uniform vec4 uMottle\b/.test(fs) && /vWorld\.xz \* uMottle\.x/.test(fs), 'standard shader samples the mottle in world xz');
  var tex = { texture: {} }, r = GL.resolveMaterial({ mottleMap: tex, mottle: [41, 1, 0.37, 0.61] });
  assert.ok(r.mottleMap && Math.abs(r.mo0 - 1 / 41) < 1e-12 && r.mo1 === 1 && r.mo2 === 0.37 && r.mo3 === 0.61);
  var none = GL.resolveMaterial({});
  assert.ok(!none.mottleMap && none.mo1 === 0, 'no mottle unless a material asks for it');
  // the GL build hands road / run-off tarmac the mottle when the textures module provides it (stubbed GL + textures)
  var CB = globalThis.CB, saveMesh = CB.gl.createMesh, saveT = CB.gl.textures, asph = { id: 'asphalt' }, mot = { id: 'mottle' };
  try {
    CB.gl.createMesh = function () { return { draw: function () {}, destroy: function () {} }; };
    CB.gl.textures = { asphalt: function () { return asph; }, asphaltMottle: function () { return mot; }, ASPHALT_MOTTLE_M: 41 };
    var def = T.list[0], built = TM.build({ gl: {} }, geomOf(def), def, { quality: 'low' });
    var road = built.meshes.filter(function (m) { return m.kind === 'road'; })[0];
    assert.ok(road && road.material.mottleMap === mot && road.material.mottle[0] === 41 && road.material.mottle[1] === 1, 'road mottle');
    built.meshes.forEach(function (m) { if (m.material.map !== asph) assert.ok(!m.material.mottleMap, m.kind + ' (not asphalt) has no mottle'); });
  } finally { CB.gl.createMesh = saveMesh; CB.gl.textures = saveT; }
});

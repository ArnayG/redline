/* Node tests for js/race/drift/tracks.js (DRIFT-SPEC.md §4) — run standalone (`node tests/drift-tracks.test.js`)
   or via tests/run.js. Checks registration into CB.race.tracks, catalog def shape, closed loops, no
   self-intersection (except the intentional Circle Lab figure-8 bridge, handled exactly like Ouroboros), drift
   widths 14-22 m, project() round-trips, themes / scenery, drift zones, and that the 3D track mesh
   (js/race/gl/track-mesh.js) and scenery (js/race/gl/scenery.js) build for every drift track without NaN. */
'use strict';
var assert = require('assert');
var path = require('path');

var root = path.join(__dirname, '..');
var T = require(path.join(root, 'js', 'race', 'tracks.js'));
var DT = require(path.join(root, 'js', 'race', 'drift', 'tracks.js'));
var CB = globalThis.CB;

function tryRequire(p) { try { return require(p); } catch (e) { return null; } }
var TM = tryRequire(path.join(root, 'js', 'race', 'gl', 'track-mesh.js'));
var SC = tryRequire(path.join(root, 'js', 'race', 'gl', 'scenery.js'));

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var passed = 0, failed = 0;
var test = standalone
  ? function (name, fn) {
    try { fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { failed++; console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
  }
  : globalThis.test;

var IDS = ['kurogane-pass', 'dockyard-sliders', 'circle-lab'];
var geoms = {};
function geomOf(def) { return geoms[def.id] || (geoms[def.id] = T.build(def)); }
function wrap(a) { a %= Math.PI * 2; if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; }
function arcDist(a, b, L) { var d = Math.abs(a - b) % L; return Math.min(d, L - d); }
function rng(seed) {
  var a = seed >>> 0;
  return function () { a = (a + 0x6d2b79f5) >>> 0; var t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function segX(ax, ay, bx, by, cx, cy, dx, dy) {
  var d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  var d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  var d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  var d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
/** brute-force (bucketed) centerline crossings between non-adjacent parts of the lap */
function crossingsOf(g) {
  var S = g.samples, N = S.length, cell = 40, buckets = {}, out = [], seen = {};
  for (var i = 0; i < N; i++) {
    var a = S[i], b = S[(i + 1) % N];
    var x0 = Math.floor(Math.min(a.x, b.x) / cell), x1 = Math.floor(Math.max(a.x, b.x) / cell);
    var y0 = Math.floor(Math.min(a.y, b.y) / cell), y1 = Math.floor(Math.max(a.y, b.y) / cell);
    for (var cx = x0; cx <= x1; cx++) for (var cy = y0; cy <= y1; cy++) (buckets[cx + ',' + cy] = buckets[cx + ',' + cy] || []).push(i);
  }
  Object.keys(buckets).forEach(function (k) {
    var list = buckets[k];
    for (var p = 0; p < list.length; p++) for (var q = p + 1; q < list.length; q++) {
      var i = list[p], j = list[q];
      if (Math.abs(i - j) < 3 || N - Math.abs(i - j) < 3) continue;
      var key = Math.min(i, j) + ':' + Math.max(i, j);
      if (seen[key]) continue;
      var A = S[i], B = S[(i + 1) % N], C = S[j], D = S[(j + 1) % N];
      if (segX(A.x, A.y, B.x, B.y, C.x, C.y, D.x, D.y)) { seen[key] = 1; out.push({ i: i, j: j, x: A.x, y: A.y }); }
    }
  });
  return out;
}
function isHex(c) { return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c); }

/* ------------------------------------------------------------------ registration */

test('drift tracks: exports + three defs registered into CB.race.tracks', function () {
  assert.strictEqual(CB.race.drift.tracks, DT);
  assert.deepStrictEqual(DT.errors, [], 'no spec failed to build: ' + JSON.stringify(DT.errors));
  assert.deepStrictEqual(DT.ids, IDS);
  IDS.forEach(function (id) {
    var d = DT.get(id);
    assert.ok(d, id + ' missing');
    assert.strictEqual(T.get(id), d, 'CB.race.tracks.get(' + id + ')');
    assert.ok(T.list.indexOf(d) >= 0, id + ' in CB.race.tracks.list');
    assert.ok(T.ids.indexOf(id) >= 0, id + ' in CB.race.tracks.ids');
    assert.strictEqual(T.byId[id], d);
    assert.strictEqual(T.geometry(id), T.build(d), 'geometry(id) works and is cached');
    assert.ok(DT.isDrift(id) && DT.isDrift(d));
  });
  assert.ok(!DT.isDrift('forge-ring'));
  assert.ok(T.get('forge-ring'), 'built-in catalog still intact');
});

test('drift tracks: install() is idempotent (no duplicate list entries)', function () {
  var before = T.list.length, ids = T.ids.length;
  assert.strictEqual(DT.install(), true);
  assert.strictEqual(DT.install(T), true);
  assert.strictEqual(T.list.length, before);
  assert.strictEqual(T.ids.length, ids);
  IDS.forEach(function (id) {
    assert.strictEqual(T.list.filter(function (d) { return d.id === id; }).length, 1);
  });
});

test('drift tracks: defs have the exact catalog shape of js/race/tracks.js (+ drift metadata)', function () {
  var ref = T.get('akagane-pass') || T.list[0];
  IDS.forEach(function (id) {
    var d = DT.get(id);
    Object.keys(ref).forEach(function (k) { assert.ok(k in d, id + ' lacks catalog key ' + k); });
    assert.ok(Array.isArray(d.points) && d.points.length > 20);
    d.points.forEach(function (p) { assert.ok(isFinite(p[0]) && isFinite(p[1])); });
    assert.ok(d.length_m > 600 && d.length_m < 4000, id + ' length ' + d.length_m);
    assert.strictEqual(d.mode, 'drift');
    assert.ok(d.tags.indexOf('drift') >= 0);
    assert.ok(d.style && d.style.drift === true);
    assert.ok(d.drift && d.drift.duration_s > 0);
    var m = d.drift.medals;
    assert.ok(m.bronze < m.silver && m.silver < m.gold && m.gold < m.platinum, id + ' medal targets ordered');
    assert.ok(['day', 'dusk', 'night'].indexOf(d.timeOfDay) >= 0);
    assert.ok(typeof d.name === 'string' && d.desc.length > 40);
  });
  assert.ok(DT.get('kurogane-pass').style.touge, 'mountain pass uses the touge terrain style');
  assert.ok(DT.get('dockyard-sliders').style.street, 'harbor park is industrial (street) asphalt');
  assert.strictEqual(DT.get('circle-lab').crossing, 'bridge', 'figure-8 crosses on a bridge like Ouroboros');
});

/* ------------------------------------------------------------------ geometry */

IDS.forEach(function (id) {
  var def = DT.get(id);

  test(id + ': builds cleanly, closed loop, uniform resampling', function () {
    var g = geomOf(def);
    var S = g.samples, N = S.length;
    assert.ok(N > 200);
    assert.ok(Math.abs(g.length - def.length_m) < 30, 'length ' + g.length + ' vs def ' + def.length_m);
    var t = T.turtle(def.layout, { heading0: 0 });
    assert.ok(t.closureGap < 1e-6, 'turtle closes exactly (gap ' + t.closureGap + ')');
    var maxStep = 0, minStep = Infinity, maxTurn = 0;
    for (var i = 0; i < N; i++) {
      var a = S[i], b = S[(i + 1) % N];
      var st = Math.hypot(b.x - a.x, b.y - a.y);
      maxStep = Math.max(maxStep, st); minStep = Math.min(minStep, st);
      maxTurn = Math.max(maxTurn, Math.abs(wrap(b.heading - a.heading)));
      ['x', 'y', 'heading', 'curvature', 'width', 'hw', 'wallL', 'wallR', 'racingLine'].forEach(function (k) {
        assert.ok(isFinite(a[k]), id + ' sample ' + i + ' ' + k + ' not finite');
      });
      assert.ok(a.wallL > a.hw && a.wallR > a.hw, 'walls outside the asphalt at ' + i);
      assert.ok(Math.abs(a.racingLine) < a.hw, 'racing line inside the track at ' + i);
    }
    // the wrap-around step (last -> first sample) is as short as every other step: the loop is closed
    assert.ok(maxStep < g.ds * 1.25 && minStep > g.ds * 0.6, 'steps ' + minStep + '..' + maxStep + ' ds ' + g.ds);
    assert.ok(maxTurn < 12 * Math.PI / 180, 'max heading step ' + (maxTurn * 180 / Math.PI));
    assert.ok(g.corners.length >= 3, 'corners detected');
    assert.ok(g.gridSlots.length >= 8, 'grid slots');
    assert.strictEqual(g.sectors.length, 3);
  });

  test(id + ': no self-intersection (figure-8 crossing only where intended)', function () {
    var g = geomOf(def);
    var v = T.validate(g);
    assert.strictEqual(v.selfIntersections, 0, JSON.stringify(v));
    var raw = crossingsOf(g);
    if (def.crossing) {
      assert.strictEqual(def.crossings, 1);
      assert.strictEqual(g.crossings.length, 1, 'exactly one intentional crossing');
      var cr = g.crossings[0];
      assert.strictEqual(cr.type, 'bridge');
      assert.ok(cr.upperIndex != null && cr.lowerIndex != null);
      assert.ok(g.samples[cr.upperIndex].layer === 1 && g.samples[cr.lowerIndex].layer === 0, 'upper deck flagged');
      raw.forEach(function (x) { assert.ok(Math.hypot(x.x - cr.x, x.y - cr.y) < 30, 'unexpected crossing at ' + x.x + ',' + x.y); });
      assert.ok(raw.length >= 1);
      // the start line is well away from the crossing / bridge
      assert.ok(Math.hypot(g.startLine.x - cr.x, g.startLine.y - cr.y) > 60);
    } else {
      assert.strictEqual(g.crossings.length, 0);
      assert.strictEqual(raw.length, 0, 'raw crossings ' + JSON.stringify(raw.slice(0, 3)));
    }
    // asphalt of different parts of the lap never overlaps (outside the intended crossing)
    assert.ok(v.minClearance > 8, 'min clearance between track parts ' + v.minClearance);
  });

  test(id + ': drift-wide track, widths 14-22 m', function () {
    def.widthKeys.forEach(function (k) { assert.ok(k[1] >= 14 && k[1] <= 22, 'authored width ' + k[1]); });
    assert.ok(def.width_m >= 14 && def.width_m <= 22);
    var g = geomOf(def);
    g.samples.forEach(function (sm, i) {
      assert.ok(sm.width >= 14 && sm.width <= 22, id + ' built width ' + sm.width + ' at ' + i);
      assert.ok(Math.abs(sm.hw * 2 - sm.width) < 1e-9);
    });
  });

  test(id + ': project() round-trips (with and without hint)', function () {
    var g = geomOf(def), S = g.samples, N = S.length, r = rng(7 + id.length);
    for (var k = 0; k < 160; k++) {
      var s = r() * g.length, sm = S[T.indexAt(g, s)];
      var lat = (r() * 2 - 1) * sm.hw * 0.85;
      var p = T.pointAt(g, s, lat);
      var hint = (p.index + Math.round((r() * 2 - 1) * 6) + N) % N;
      var pr = T.project(g, p.x, p.y, hint);
      assert.ok(arcDist(pr.s, s, g.length) < 1.5, id + ' s ' + pr.s + ' vs ' + s);
      assert.ok(Math.abs(pr.lateral - lat) < 0.6, id + ' lateral ' + pr.lateral + ' vs ' + lat);
      assert.ok(pr.onTrack && pr.surface === 'asphalt');
      var bound = g.project(p.x, p.y, hint);
      assert.strictEqual(bound.index, pr.index);
      if (!def.crossing || S[pr.index].layer === 0 && Math.hypot(p.x - g.crossings[0].x, p.y - g.crossings[0].y) > 45) {
        var nh = T.project(g, p.x, p.y);
        assert.ok(arcDist(nh.s, s, g.length) < 1.5, id + ' (no hint) s ' + nh.s + ' vs ' + s);
      }
    }
    // beyond the barrier is classified as wall
    var sm0 = S[Math.floor(N / 3)];
    var w = T.project(g, sm0.x + sm0.nx * (sm0.wallL + 1), sm0.y + sm0.ny * (sm0.wallL + 1), sm0.i);
    assert.strictEqual(w.surface, 'wall');
  });

  test(id + ': speed profile is finite and positive (AI / assist braking targets)', function () {
    var g = geomOf(def);
    var prof = T.speedProfile(g, 1.1, 1.0, function () { return 4; });
    var arr = prof.speed || prof.v || prof;
    assert.ok(arr.length === g.samples.length || arr.length > 0);
    for (var i = 0; i < arr.length; i++) assert.ok(isFinite(arr[i]) && arr[i] > 0, 'speed ' + arr[i] + ' at ' + i);
  });

  test(id + ': theme + scenery usable by the 3D scenery module', function () {
    ['grass', 'asphalt', 'kerbA', 'kerbB', 'sand', 'sky', 'line', 'wall', 'barrier', 'tree', 'ground', 'accent'].forEach(function (k) {
      assert.ok(isHex(def.theme[k]), id + ' theme.' + k + ' = ' + def.theme[k]);
    });
    assert.strictEqual(typeof def.theme.night, 'boolean');
    var g = geomOf(def);
    assert.ok(def.scenery.length > 100, 'authored scenery ' + def.scenery.length);
    assert.ok(g.scenery.length >= def.scenery.length * 0.85, 'resolved ' + g.scenery.length + ' / ' + def.scenery.length);
    var types = {};
    g.scenery.forEach(function (o) {
      types[o.type] = 1;
      assert.ok(isFinite(o.x) && isFinite(o.y) && isFinite(o.r) && isFinite(o.h));
      var pr = T.project(g, o.x, o.y);
      assert.ok(Math.abs(pr.lateral) > S_hw(g, pr.index), o.type + ' sits on the asphalt');
    });
    ['lamp', 'billboard', 'tyres'].forEach(function (t) { assert.ok(types[t], id + ' has ' + t); });
    assert.ok(Object.keys(types).length >= 6, 'varied scenery: ' + Object.keys(types).join(','));
  });

  test(id + ': drift zones (clipping points, outer zones, swings) resolve onto the geometry', function () {
    var Z = def.driftZones;
    assert.ok(Array.isArray(Z) && Z.length >= 6, 'zones ' + (Z && Z.length));
    var clips = Z.filter(function (z) { return z.kind === 'clip'; }), outer = Z.filter(function (z) { return z.kind === 'zone'; });
    assert.ok(clips.length >= 3 && outer.length >= 3);
    var idsSeen = {};
    Z.forEach(function (z) {
      assert.ok(!idsSeen[z.id], 'unique zone id'); idsSeen[z.id] = 1;
      assert.ok(z.u >= 0 && z.u < 1 && z.u0 >= 0 && z.u0 < 1 && z.u1 >= 0 && z.u1 < 1);
      assert.ok(['clip', 'zone', 'swing'].indexOf(z.kind) >= 0);
      if (z.kind === 'clip') assert.strictEqual(z.clip, 'inner');
      if (z.kind === 'zone') assert.strictEqual(z.clip, 'outer');
      if (z.kind !== 'swing') assert.strictEqual(Math.sign(z.lateral), z.side, 'lateral on the zone side');
      if (z.kind === 'clip') assert.strictEqual(z.side, z.dir, 'inner clip on the inside of the corner');
      if (z.kind === 'zone') assert.strictEqual(z.side, -z.dir, 'outer zone on the outside of the corner');
      assert.ok(z.points > 0 && z.radius > 0);
    });
    var g = geomOf(def);
    var R = DT.zones(g);
    assert.strictEqual(R.length, Z.length);
    assert.deepStrictEqual(DT.zones(def).map(function (z) { return z.s; }), R.map(function (z) { return z.s; }), 'def or geom input');
    R.forEach(function (z) {
      ['s', 's0', 's1', 'x', 'y', 'heading', 'lateral'].forEach(function (k) { assert.ok(isFinite(z[k]), z.id + ' ' + k); });
      assert.ok(z.s >= 0 && z.s < g.length);
      assert.strictEqual(z.hit, false);
      var pr = T.project(g, z.x, z.y, z.index);
      assert.ok(pr.onTrack, z.id + ' (' + z.name + ') must lie on the track (lateral ' + pr.lateral + ', hw ' + pr.halfWidth + ')');
      if (z.kind === 'clip') {
        // inner clips really sit on the inside of a curving part of the track
        var k = g.samples[pr.index].curvature;
        assert.ok(Math.sign(k) === z.dir && Math.abs(k) > 1 / 200, z.id + ' curvature ' + k);
      }
    });
    // zones are not shared objects with the def (scorers mutate .hit)
    R[0].hit = true;
    assert.strictEqual(Z[0].hit, undefined);
  });

  test(id + ': js/race/gl/track-mesh.js builds the 3D mesh without NaN', function () {
    if (!TM || typeof TM.buildGeometry !== 'function') return; // 3D module not loadable in Node: nothing to check
    ['low', 'high'].forEach(function (q) {
      var r = TM.buildGeometry(geomOf(def), def, { quality: q });
      assert.ok(r.parts.length > 3);
      var tris = 0;
      r.parts.forEach(function (p) {
        ['positions', 'normals', 'uvs', 'colors'].forEach(function (k) {
          var a = p[k];
          if (!a) return;
          for (var i = 0; i < a.length; i++) if (!isFinite(a[i])) assert.fail(id + ' [' + q + '] ' + p.kind + '.' + k + ' NaN at ' + i);
        });
        var nv = p.positions.length / 3;
        for (var j = 0; j < p.indices.length; j++) if (p.indices[j] >= nv) assert.fail(p.kind + ' index out of range');
        tris += p.indices.length / 3;
      });
      assert.ok(tris > 1000 && tris < 600000, 'triangles ' + tris);
      var S = geomOf(def).samples;
      for (var i = 0; i < S.length; i += 17) {
        assert.ok(isFinite(r.groundY(S[i].x, -S[i].y)));
        assert.ok(isFinite(r.heightAt(S[i].s)));
      }
      if (def.crossing) {
        var cr = geomOf(def).crossings[0];
        assert.ok(r.heightAtIndex(cr.upperIndex) > 3, 'bridge deck raised');
        assert.ok(Math.abs(r.heightAtIndex(cr.lowerIndex)) < 0.5, 'lower road at grade');
      }
    });
  });

  test(id + ': js/race/gl/scenery.js builds trackside objects without NaN', function () {
    if (!SC || typeof SC.buildGeometry !== 'function') return;
    var g = geomOf(def);
    var tm = TM && TM.buildGeometry ? TM.buildGeometry(g, def, { quality: 'medium' }) : null;
    var r = SC.buildGeometry(g, def, { quality: 'medium', timeOfDay: def.timeOfDay, groundY: tm ? tm.groundY : undefined });
    assert.ok(r.parts && r.parts.length > 0);
    r.parts.forEach(function (p) {
      var a = p.positions;
      if (!a) return;
      for (var i = 0; i < a.length; i++) if (!isFinite(a[i])) assert.fail(id + ' scenery ' + (p.kind || '') + ' NaN at ' + i);
    });
    assert.ok(r.stats && r.stats.objects > 50);
  });
});

function S_hw(g, i) { return g.samples[i].hw; }

test('drift tracks: zones() is safe on non-drift defs', function () {
  assert.deepStrictEqual(DT.zones(T.get('forge-ring')), []);
  assert.deepStrictEqual(DT.zones(null), []);
});

if (standalone && require.main === module) {
  console.log('\ndrift-tracks: ' + passed + ' passed, ' + failed + ' failed');
}

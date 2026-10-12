/* Node tests for js/race/tracks-extra.js — run standalone (`node tests/tracks-extra.test.js`) or via tests/run.js.
   Checks registration into CB.race.tracks, catalog def shape, closed loops without self-intersection, valid
   widths, project() round-trips, themes / scenery, Shuto drift zones, banking / tunnel metadata, that the race AI
   (js/race/ai.js) completes a lap of each circuit (stub vehicle + real CB.race.vehicle when loadable), and that the
   3D track mesh (js/race/gl/track-mesh.js) and scenery (js/race/gl/scenery.js) build without NaN. */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
function tryRequire(p) { try { return require(p); } catch (e) { return null; } }
function tryLoad(rel) { var p = path.join(root, rel); return fs.existsSync(p) ? tryRequire(p) : null; }
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js'].forEach(tryLoad);
var T = require(path.join(root, 'js', 'race', 'tracks.js'));
var X = require(path.join(root, 'js', 'race', 'tracks-extra.js'));
var AI = tryLoad('js/race/ai.js');
tryLoad('js/race/vehicle.js');
var TM = tryLoad('js/race/gl/track-mesh.js');
var SC = tryLoad('js/race/gl/scenery.js');
var CB = globalThis.CB;

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var passed = 0, failed = 0;
function test(name, fn) {
  if (!standalone) return globalThis.test('tracks-extra: ' + name, fn);
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
}

var IDS = ['gruenwald-ring', 'shuto-night-loop', 'mesa-verde'];
var WIDTHS = { 'gruenwald-ring': [9, 16], 'shuto-night-loop': [14, 20], 'mesa-verde': [11, 18] };
var LENGTHS = { 'gruenwald-ring': [11000, 13000], 'shuto-night-loop': [3000, 6000], 'mesa-verde': [3000, 5000] };
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
  var S = g.samples, N = S.length, cell = 40, buckets = {}, out = 0, seen = {};
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
      if (segX(A.x, A.y, B.x, B.y, C.x, C.y, D.x, D.y)) { seen[key] = 1; out++; }
    }
  });
  return out;
}
function isHex(c) { return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c); }

/* ------------------------------------------------------------------ registration */

test('exports + three defs registered into CB.race.tracks', function () {
  assert.strictEqual(CB.race.tracksExtra, X);
  assert.deepStrictEqual(X.errors, [], 'no spec failed to build: ' + JSON.stringify(X.errors));
  assert.deepStrictEqual(X.ids, IDS);
  IDS.forEach(function (id) {
    var d = X.get(id);
    assert.ok(d, id + ' missing');
    assert.strictEqual(T.get(id), d, 'CB.race.tracks.get(' + id + ')');
    assert.ok(T.list.indexOf(d) >= 0 && T.ids.indexOf(id) >= 0 && T.byId[id] === d, id + ' in list / ids / byId');
    assert.strictEqual(T.geometry(id), T.build(d), 'geometry(id) works and is cached');
  });
  assert.ok(T.get('forge-ring'), 'built-in catalog still intact');
  assert.strictEqual(X.get('nope'), null);
});

test('install() is idempotent (no duplicate list entries)', function () {
  var before = T.list.length, ids = T.ids.length;
  assert.strictEqual(X.install(), true);
  assert.strictEqual(X.install(T), true);
  assert.strictEqual(T.list.length, before);
  assert.strictEqual(T.ids.length, ids);
  IDS.forEach(function (id) { assert.strictEqual(T.list.filter(function (d) { return d.id === id; }).length, 1); });
});

test('install() also works through a register() API when the catalog grows one', function () {
  var got = [], fake = { makeTrack: T.makeTrack, turtle: T.turtle, get: function () { return null; }, register: function (d) { got.push(d.id); } };
  assert.strictEqual(X.install(fake), true);
  assert.deepStrictEqual(got, IDS);
});

test('defs have the exact catalog shape of js/race/tracks.js (+ extra metadata)', function () {
  var ref = T.get('forge-ring');
  IDS.forEach(function (id) {
    var d = X.get(id);
    Object.keys(ref).forEach(function (k) { assert.ok(k in d, id + ' lacks catalog key ' + k); });
    assert.ok(Array.isArray(d.points) && d.points.length > 40);
    d.points.forEach(function (p) { assert.ok(isFinite(p[0]) && isFinite(p[1])); });
    assert.ok(d.length_m >= LENGTHS[id][0] && d.length_m <= LENGTHS[id][1], id + ' length ' + d.length_m);
    assert.ok(['day', 'dusk', 'night'].indexOf(d.timeOfDay) >= 0);
    assert.ok(typeof d.name === 'string' && d.desc.length > 60);
    assert.ok(d.difficulty >= 1 && d.difficulty <= 5 && d.defaultLaps >= 1);
    assert.ok(Array.isArray(d.modes) && d.modes.indexOf('race') >= 0);
    assert.ok(Array.isArray(d.elevation) && d.elevation.length >= 4);
    d.elevation.forEach(function (k) { assert.ok(k[0] >= 0 && k[0] <= 1 && isFinite(k[1])); });
    assert.ok(Array.isArray(d.tunnels) && Array.isArray(d.banking));
  });
  var gw = X.get('gruenwald-ring'), sh = X.get('shuto-night-loop'), mv = X.get('mesa-verde');
  assert.ok(gw.name.indexOf('Grünwald') === 0 && sh.name === 'Shuto Night Loop' && mv.name.indexOf('Mesa Verde') === 0);
  assert.strictEqual(gw.wallType, 'armco');
  assert.ok(gw.tags.indexOf('nordschleife') >= 0);
  assert.strictEqual(sh.timeOfDay, 'night');
  assert.ok(sh.style.street && sh.style.night && sh.wallType === 'concrete', 'Shuto: night street circuit, concrete walls');
  assert.ok(sh.modes.indexOf('drift') >= 0 && sh.drift && sh.drift.duration_s > 0);
  var m = sh.drift.medals;
  assert.ok(m.bronze < m.silver && m.silver < m.gold && m.gold < m.platinum, 'medal targets ordered');
  assert.ok(mv.runoff.left === 'sand' && mv.runoff.right === 'sand' && mv.gravel === true, 'Mesa Verde: sand run-off');
  assert.ok(!gw.driftZones && !mv.driftZones, 'only Shuto carries drift zones');
});

test('Grünwald Ring: Nordschleife features (Karussell banking, long straight, many named corners)', function () {
  var d = X.get('gruenwald-ring'), g = geomOf(d);
  assert.strictEqual(d.banking.length, 1);
  var b = d.banking[0];
  assert.strictEqual(b.name, 'Karussell');
  assert.ok(b.deg > 5 && b.deg < 30 && b.u0 > 0 && b.u1 > b.u0 && b.u1 < 1);
  // the banked section is a tight, long left-hander on the built geometry
  var mid = Math.round((b.u0 + b.u1) / 2 * g.n) % g.n;
  var k = g.samples[mid].curvature;
  assert.ok(k > 1 / 60, 'Karussell is a tight left (curvature ' + k + ')');
  var kar = g.corners.filter(function (c) { return c.name === 'Karussell'; })[0];
  assert.ok(kar && kar.dir === 1 && kar.angle_deg > 120, 'Karussell detected as a big left corner');
  // a straight of more than 1.2 km
  var best = 0, run = 0;
  for (var pass = 0; pass < 2; pass++) for (var i = 0; i < g.n; i++) { run = Math.abs(g.samples[i].curvature) < 1 / 1500 ? run + g.ds : 0; best = Math.max(best, run); }
  assert.ok(best > 1200, 'longest straight ' + Math.round(best) + ' m');
  assert.ok(g.corners.length >= 30, 'corners ' + g.corners.length);
  var named = g.corners.filter(function (c) { return !/^Turn /.test(c.name); });
  assert.ok(named.length >= 20, 'named corners ' + named.length);
});

test('Shuto Night Loop: tunnels map onto straight sections', function () {
  var d = X.get('shuto-night-loop'), g = geomOf(d);
  assert.ok(d.tunnels.length >= 2);
  d.tunnels.forEach(function (tn) {
    assert.ok(tn.name && tn.u0 >= 0 && tn.u1 > tn.u0 && tn.u1 < 1);
    var i = Math.round((tn.u0 + tn.u1) / 2 * g.n) % g.n;
    assert.ok(Math.abs(g.samples[i].curvature) < 1 / 300, tn.name + ' is a straight tube');
  });
});

/* ------------------------------------------------------------------ geometry */

IDS.forEach(function (id) {
  var def = X.get(id);

  test(id + ': builds cleanly, closed loop, uniform resampling', function () {
    var g = geomOf(def);
    var S = g.samples, N = S.length;
    assert.ok(N > 1000);
    assert.ok(Math.abs(g.length - def.length_m) < 30, 'length ' + g.length + ' vs def ' + def.length_m);
    var t = T.turtle(def.layout, { heading0: 0 });
    assert.ok(t.closureGap < 1e-6, 'turtle closes exactly (gap ' + t.closureGap + ')');
    var maxStep = 0, minStep = Infinity, maxTurn = 0;
    for (var i = 0; i < N; i++) {
      var a = S[i], b = S[(i + 1) % N];
      var st = Math.hypot(b.x - a.x, b.y - a.y);
      maxStep = Math.max(maxStep, st); minStep = Math.min(minStep, st);
      maxTurn = Math.max(maxTurn, Math.abs(wrap(b.heading - a.heading)));
      ['x', 'y', 'heading', 'curvature', 'width', 'hw', 'wallL', 'wallR', 'racingLine', 'sandL', 'sandR'].forEach(function (k) {
        assert.ok(isFinite(a[k]), id + ' sample ' + i + ' ' + k + ' not finite');
      });
      assert.ok(a.wallL > a.hw && a.wallR > a.hw, 'walls outside the asphalt at ' + i);
      assert.ok(Math.abs(a.racingLine) < a.hw, 'racing line inside the track at ' + i);
    }
    // the wrap-around step (last -> first sample) is as short as every other step: the loop is closed
    assert.ok(maxStep < g.ds * 1.25 && minStep > g.ds * 0.6, 'steps ' + minStep + '..' + maxStep + ' ds ' + g.ds);
    assert.ok(maxTurn < 12 * Math.PI / 180, 'max heading step ' + (maxTurn * 180 / Math.PI));
    assert.ok(g.corners.length >= 8, 'corners detected');
    assert.ok(g.gridSlots.length >= 16, 'grid slots');
    g.gridSlots.forEach(function (sl) {
      var pr = T.project(g, sl.x, sl.y);
      assert.ok(pr.onTrack, 'grid slot ' + sl.slot + ' on the asphalt');
    });
    assert.strictEqual(g.sectors.length, 3);
  });

  test(id + ': no self-intersection, generous clearance between track parts', function () {
    var g = geomOf(def);
    var v = T.validate(g);
    assert.strictEqual(v.selfIntersections, 0, JSON.stringify(v));
    assert.strictEqual(g.crossings.length, 0);
    assert.strictEqual(crossingsOf(g), 0, 'raw centerline crossings');
    assert.ok(v.minClearance == null || v.minClearance > 15, 'min clearance between track parts ' + v.minClearance);
  });

  test(id + ': widths valid', function () {
    var lim = WIDTHS[id];
    def.widthKeys.forEach(function (k) { assert.ok(k[1] >= lim[0] && k[1] <= lim[1], 'authored width ' + k[1]); });
    assert.ok(def.width_m >= lim[0] && def.width_m <= lim[1]);
    geomOf(def).samples.forEach(function (sm, i) {
      assert.ok(sm.width >= lim[0] && sm.width <= lim[1], id + ' built width ' + sm.width + ' at ' + i);
      assert.ok(Math.abs(sm.hw * 2 - sm.width) < 1e-9);
    });
  });

  test(id + ': project() round-trips (with and without hint)', function () {
    var g = geomOf(def), S = g.samples, N = S.length, r = rng(11 + id.length);
    for (var k = 0; k < 200; k++) {
      var s = r() * g.length, sm = S[T.indexAt(g, s)];
      var lat = (r() * 2 - 1) * sm.hw * 0.85;
      var p = T.pointAt(g, s, lat);
      var hint = (p.index + Math.round((r() * 2 - 1) * 6) + N) % N;
      var pr = T.project(g, p.x, p.y, hint);
      assert.ok(arcDist(pr.s, s, g.length) < 1.5, id + ' s ' + pr.s + ' vs ' + s);
      assert.ok(Math.abs(pr.lateral - lat) < 0.6, id + ' lateral ' + pr.lateral + ' vs ' + lat);
      assert.ok(pr.onTrack && pr.surface === 'asphalt');
      assert.strictEqual(g.project(p.x, p.y, hint).index, pr.index);
      var nh = T.project(g, p.x, p.y);
      assert.ok(arcDist(nh.s, s, g.length) < 1.5, id + ' (no hint) s ' + nh.s + ' vs ' + s);
    }
    var sm0 = S[Math.floor(N / 3)];
    var w = T.project(g, sm0.x + sm0.nx * (sm0.wallL + 1), sm0.y + sm0.ny * (sm0.wallL + 1), sm0.i);
    assert.strictEqual(w.surface, 'wall');
  });

  test(id + ': speed profile is finite and positive', function () {
    var g = geomOf(def);
    var prof = T.speedProfile(g, 1.1, 1.0, function () { return 4; });
    var arr = prof.speed || prof.v || prof;
    assert.ok(arr.length > 0);
    for (var i = 0; i < arr.length; i++) assert.ok(isFinite(arr[i]) && arr[i] > 0, 'speed ' + arr[i] + ' at ' + i);
  });

  test(id + ': theme + scenery usable by the 3D scenery module', function () {
    ['grass', 'asphalt', 'kerbA', 'kerbB', 'sand', 'sky', 'line', 'wall', 'barrier', 'tree', 'ground', 'accent'].forEach(function (k) {
      assert.ok(isHex(def.theme[k]), id + ' theme.' + k + ' = ' + def.theme[k]);
    });
    assert.strictEqual(typeof def.theme.night, 'boolean');
    assert.strictEqual(def.theme.night, def.timeOfDay === 'night');
    var g = geomOf(def);
    assert.ok(def.scenery.length > 150, 'authored scenery ' + def.scenery.length);
    assert.ok(g.scenery.length >= def.scenery.length * 0.85, 'resolved ' + g.scenery.length + ' / ' + def.scenery.length);
    var types = {};
    g.scenery.forEach(function (o) {
      types[o.type] = 1;
      assert.ok(isFinite(o.x) && isFinite(o.y) && isFinite(o.r) && isFinite(o.h));
      var pr = T.project(g, o.x, o.y);
      assert.ok(Math.abs(pr.lateral) > g.samples[pr.index].hw, o.type + ' sits on the asphalt');
    });
    ['lamp', 'billboard', 'pits', 'tower'].forEach(function (t) { assert.ok(types[t], id + ' has ' + t); });
    assert.ok(Object.keys(types).length >= 7, 'varied scenery: ' + Object.keys(types).join(','));
    if (id === 'gruenwald-ring') assert.ok(g.scenery.filter(function (o) { return o.type === 'tree'; }).length > 1000, 'forest');
    if (id === 'mesa-verde') {
      assert.ok(g.scenery.every(function (o) { return o.type !== 'tree' || o.variant === 'shrub'; }), 'desert: scrub only, no forest');
      var sandy = g.samples.filter(function (sm) { return sm.sandL > 3 || sm.sandR > 3; }).length;
      assert.ok(sandy > g.n * 0.1, 'sand traps on ' + sandy + ' samples');
    }
    if (id === 'shuto-night-loop') {
      assert.ok(g.scenery.filter(function (o) { return o.type === 'building'; }).length > 80, 'city blocks');
      assert.ok(g.scenery.filter(function (o) { return o.lit; }).length > 100, 'lit at night');
    }
  });

  test(id + ': js/race/gl/track-mesh.js builds the 3D mesh without NaN', function () {
    if (!TM || typeof TM.buildGeometry !== 'function') return; // 3D module not loadable in Node: nothing to check
    ['low', 'high'].forEach(function (q) {
      var r = TM.buildGeometry(geomOf(def), def, { quality: q, terrainAmplitude: def.terrainAmplitude });
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
      assert.ok(tris > 1000 && tris < 2000000, 'triangles ' + tris);
      var S = geomOf(def).samples;
      for (var i = 0; i < S.length; i += 23) {
        assert.ok(isFinite(r.groundY(S[i].x, -S[i].y)));
        assert.ok(isFinite(r.heightAt(S[i].s)));
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
    assert.ok(r.stats && r.stats.objects > 100);
  });
});

/* ------------------------------------------------------------------ drift zones (Shuto) */

test('shuto-night-loop: drift zones (clips, outer zones, swings) resolve onto the geometry', function () {
  var def = X.get('shuto-night-loop'), Z = def.driftZones;
  assert.ok(Array.isArray(Z) && Z.length >= 12, 'zones ' + (Z && Z.length));
  var clips = Z.filter(function (z) { return z.kind === 'clip'; }), outer = Z.filter(function (z) { return z.kind === 'zone'; });
  var swings = Z.filter(function (z) { return z.kind === 'swing'; });
  assert.ok(clips.length >= 6 && outer.length >= 6 && swings.length >= 2, clips.length + '/' + outer.length + '/' + swings.length);
  var seen = {};
  Z.forEach(function (z) {
    assert.ok(!seen[z.id], 'unique zone id'); seen[z.id] = 1;
    assert.ok(z.u >= 0 && z.u < 1 && z.u0 >= 0 && z.u0 < 1 && z.u1 >= 0 && z.u1 < 1);
    if (z.kind === 'clip') assert.ok(z.clip === 'inner' && z.side === z.dir);
    if (z.kind === 'zone') assert.ok(z.clip === 'outer' && z.side === -z.dir);
    if (z.kind !== 'swing') assert.strictEqual(Math.sign(z.lateral), z.side, 'lateral on the zone side');
    assert.ok(z.points > 0 && z.radius > 0);
  });
  var g = geomOf(def), R = X.zones(g);
  assert.strictEqual(R.length, Z.length);
  assert.deepStrictEqual(X.zones(def).map(function (z) { return z.s; }), R.map(function (z) { return z.s; }));
  R.forEach(function (z) {
    ['s', 's0', 's1', 'x', 'y', 'heading', 'lateral'].forEach(function (k) { assert.ok(isFinite(z[k]), z.id + ' ' + k); });
    assert.strictEqual(z.hit, false);
    var pr = T.project(g, z.x, z.y, z.index);
    assert.ok(pr.onTrack, z.id + ' (' + z.name + ') on the track');
    if (z.kind === 'clip') {
      var k = g.samples[pr.index].curvature;
      assert.ok(Math.sign(k) === z.dir && Math.abs(k) > 1 / 200, z.id + ' curvature ' + k);
    }
  });
  R[0].hit = true;
  assert.strictEqual(Z[0].hit, undefined, 'resolved zones are copies');
  assert.deepStrictEqual(X.zones(X.get('mesa-verde')), []);
  assert.deepStrictEqual(X.zones(null), []);
  // the drift module recognises it as a drift venue
  var DS = CB.race.drift && CB.race.drift.session;
  if (DS && typeof DS.isDriftTrack === 'function') assert.ok(DS.isDriftTrack(def) && !DS.isDriftTrack(X.get('mesa-verde')));
});

/* ------------------------------------------------------------------ AI laps (js/race/ai.js) */

var stubVehicle = {
  fromBuild: function () {
    return { mass: 1450, wheelbase: 2.65, width: 1.9, length: 4.5, maxSteer: 0.55, mu: 1.05,
      power_kw: 300, cdA: 0.65, downforce_kg_200: 60, maxBrakeG: 1.0, abs: true };
  },
  createState: function (p, pose) {
    return { x: pose.x, y: pose.y, heading: pose.heading, vx: 0, vy: 0, speed: 0, yawRate: 0, steerAngle: 0, rpm: 1000, gear: 1,
      wheelspin: 0, skidding: 0, slipAngleF: 0, slipAngleR: 0 };
  },
  step: function (p, s, inp, dt, env) {
    var grip = (env && env.gripMult) || 1, v = s.vx;
    var lock = p.maxSteer / (1 + Math.pow(Math.abs(v) / 45, 2) * 0.6);
    var target = Math.max(-1, Math.min(1, inp.steer || 0)) * lock;
    s.steerAngle += Math.max(-3 * dt, Math.min(3 * dt, target - s.steerAngle));
    var df = p.downforce_kg_200 * 9.81 * (v * v) / (55.56 * 55.56);
    var muN = p.mu * grip * (p.mass * 9.81 + df);
    var drag = 0.5 * 1.225 * p.cdA * v * v + 0.013 * p.mass * 9.81;
    var fDrive = inp.throttle * Math.min(p.power_kw * 1000 / Math.max(3, Math.abs(v)), muN * 0.6);
    var fBrake = inp.brake * muN * 0.95;
    var yaw = v * Math.tan(s.steerAngle) / p.wheelbase, aLat = v * yaw, latMax = muN / p.mass;
    if (Math.abs(aLat) > latMax) { yaw *= latMax / Math.abs(aLat); aLat = (aLat > 0 ? 1 : -1) * latMax; }
    var longMax = Math.sqrt(Math.max(0.05, 1 - Math.pow(aLat / latMax, 2))) * muN;
    var fx;
    if (v <= 0.05 && inp.brake > 0 && inp.throttle < 0.05) { fx = 0; s.vx = Math.max(0, s.vx); }
    else fx = Math.max(-longMax, Math.min(longMax, fDrive)) - Math.min(fBrake, longMax) - drag;
    s.vx = Math.max(0, s.vx + fx / p.mass * dt);
    s.yawRate = yaw; s.heading += yaw * dt;
    s.x += Math.cos(s.heading) * s.vx * dt; s.y += Math.sin(s.heading) * s.vx * dt;
    s.speed = Math.abs(s.vx);
    return s;
  }
};

/** one AI car from the start line until it completes a lap (or tMax); returns lap time / off-track stats */
function aiLap(geom, veh, params, opp, tMax) {
  var I = AI._internal, A = I.adaptGeom(geom);
  var driver = AI.createDriver(opp, geom, params);
  var i0 = Math.round(10 / A.ds) % A.n;
  var st = veh.createState(params, { x: A.xs[i0], y: A.ys[i0], heading: A.hs[i0] });
  var dt = 1 / 60, t = 0, hint = -1, prevS = null, progress = 0, offT = 0, maxOff = 0;
  while (t < tMax && progress < A.length) {
    var ctx = { t: t, phase: t < 0.5 ? 'countdown' : 'racing', countdown: { lightsOut: t >= 0.5 }, weather: 'dry',
      cars: [{ id: opp.id, x: st.x, y: st.y, heading: st.heading, speed: st.speed, vx: st.vx, vy: st.vy, s: prevS || 0, lap: 0 }] };
    var inp = driver.control(st, ctx, dt);
    if (!(isFinite(inp.throttle) && isFinite(inp.brake) && isFinite(inp.steer))) throw new Error('non-finite AI input');
    var pr = I.projectLocal(A, st.x, st.y, hint);
    hint = pr.index;
    var excess = Math.abs(pr.lateral) - A.hw[pr.index] - (pr.lateral > 0 ? A.kerbL[pr.index] : A.kerbR[pr.index]);
    if (excess > maxOff) maxOff = excess;
    if (excess > 0) offT += dt;
    veh.step(params, st, inp, dt, { gripMult: excess > 0.5 ? 0.6 : 1, wet: false });
    if (!(isFinite(st.x) && isFinite(st.y))) throw new Error('vehicle state went non-finite');
    if (prevS !== null) {
      var d = pr.s - prevS;
      if (d < -A.length / 2) d += A.length; else if (d > A.length / 2) d -= A.length;
      progress += d;
    }
    prevS = pr.s;
    t += dt;
  }
  return { t: t, progress: progress, length: A.length, offT: offT, maxOff: maxOff, done: progress >= A.length };
}

if (AI && typeof AI.createDriver === 'function' && AI._internal && AI._internal.adaptGeom) {
  var opp = { id: 'xt', name: 'Extra Test', skill: 0.9, consistency: 0.95, aggression: 0.5, reaction_s: 0.2, seed: 5 };
  IDS.forEach(function (id) {
    test(id + ': race AI completes a lap (stub vehicle)', function () {
      var g = geomOf(X.get(id));
      var r = aiLap(g, stubVehicle, stubVehicle.fromBuild(), opp, Math.max(150, g.length / 12));
      if (standalone) console.log('       ' + id + ' stub: lap ' + r.t.toFixed(1) + ' s (' + (r.length / r.t * 3.6).toFixed(0) + ' km/h avg), off ' + r.offT.toFixed(2) + ' s');
      assert.ok(r.done, 'completed lap (progress ' + r.progress.toFixed(0) + ' of ' + r.length.toFixed(0) + ' m in ' + r.t.toFixed(0) + ' s)');
      assert.ok(r.offT < 3, 'off-track time ' + r.offT.toFixed(2));
    });
    var V = CB.race.vehicle;
    if (V && typeof V.fromBuild === 'function' && CB.data && typeof CB.data.defaultBuild === 'function') {
      // default build = rear-engined 911 Carrera S; reference = front-engined V8 calibration coupe
      [['default 911', function () { return CB.data.defaultBuild(); }],
        ['reference V8', function () { return (CB.data.referenceBuild || CB.data.defaultBuild)(); }]].forEach(function (bc) {
        test(id + ': race AI completes a lap (real vehicle, ' + bc[0] + ')', function () {
          var g = geomOf(X.get(id)), build = bc[1]();
          var params = V.fromBuild(build, CB.physics && CB.physics.compute ? CB.physics.compute(build) : null);
          var r = aiLap(g, V, params, Object.assign({ build: build }, opp), Math.max(180, g.length / 10));
          if (standalone) console.log('       ' + id + ' ' + bc[0] + ': lap ' + r.t.toFixed(1) + ' s (' + (r.length / r.t * 3.6).toFixed(0) + ' km/h avg), off ' + r.offT.toFixed(2) + ' s');
          assert.ok(r.done, 'completed lap (progress ' + r.progress.toFixed(0) + ' of ' + r.length.toFixed(0) + ' m in ' + r.t.toFixed(0) + ' s)');
          assert.ok(r.offT < 1.0, 'off-track time ' + r.offT.toFixed(2));
          assert.ok(r.maxOff < 0.5, 'max excess beyond the kerb ' + r.maxOff.toFixed(2) + ' m');
        });
      });
    }
  });
}

/* ------------------------------------------------------------------ drift AI on the Shuto loop */

(function () {
  ['js/race/drift/tune.js', 'js/race/drift/assist.js', 'js/race/drift/arcade.js', 'js/race/drift/scoring.js'].forEach(tryLoad);
  var DAI = tryLoad('js/race/drift/ai.js'), V = CB.race.vehicle, TUNE = CB.race.drift && CB.race.drift.tune;
  if (!DAI || typeof DAI.simulate !== 'function' || !V || !TUNE || !CB.data || !CB.data.presetBuild || !CB.util || !CB.util.deepMerge) return;
  test('shuto-night-loop: drift AI slides a clean lap (tandem lead car)', function () {
    var b = CB.data.presetBuild('muscle');
    b = CB.util.deepMerge(b, TUNE.recommendedBuildPatch(b));
    if (CB.state && CB.state.normalize) b = CB.state.normalize(b) || b;
    var p = TUNE.apply(V.fromBuild(b), { level: 'street', build: b });
    var s = DAI.simulate(geomOf(X.get('shuto-night-loop')), p, { laps: 1, maxTime: 300 });
    if (standalone) console.log('       shuto drift: lap ' + (s.lapTimes || []).map(function (x) { return x.toFixed(1); }) + ' s, corner |beta| ' + s.cornerBetaAvg_deg.toFixed(1) + ' deg, sideways ' + (100 * s.driftTime_s / s.time).toFixed(0) + '%');
    assert.ok(s.completed, 'completed the lap');
    assert.ok(!s.spins, 'no spins');
    assert.ok(!(s.offTrack_s > 2), 'off-track ' + s.offTrack_s);
    assert.ok(s.driftTime_s > s.time * 0.1, 'sideways part of the lap');
  });
})();

if (standalone && require.main === module) {
  console.log('\ntracks-extra: ' + passed + ' passed, ' + failed + ' failed');
}

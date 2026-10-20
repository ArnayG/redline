/* Node tests for js/f1/f1-circuits.js (docs/F1-SPEC.md §2): the real F1 circuits build as closed, valid tracks,
   lengths within ±5 % of the real lap, sectors / DRS zones / pit lane are present and resolved in metres,
   tracks.project() reports the 'pit' surface in the pit lane, the catalog lists are unchanged, and the 3D track
   mesh + scenery build for every circuit. */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
function tryLoad(rel) { var p = path.join(root, rel); try { return fs.existsSync(p) ? require(p) : null; } catch (e) { return null; } }
var T = require(path.join(root, 'js', 'race', 'tracks.js'));
var listBefore = T.list.map(function (d) { return d.id; });
tryLoad('js/f1/f1-teams.js');
var C = require(path.join(root, 'js', 'f1', 'f1-circuits.js'));
var TM = tryLoad('js/race/gl/track-mesh.js');
var SC = tryLoad('js/race/gl/scenery.js');
tryLoad('js/race/gl/f1-scenery.js');

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var passed = 0, failed = 0;
function test(name, fn) {
  if (!standalone) return globalThis.test('f1-circuits: ' + name, fn);
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
}
var REQUIRED = ['monza', 'silverstone', 'spa', 'monaco', 'suzuka', 'interlagos', 'red-bull-ring', 'montreal'];
var DRS_COUNT = { monza: 2, silverstone: 2, spa: 2, monaco: 1, suzuka: 1, interlagos: 2, 'red-bull-ring': 3, montreal: 3, bahrain: 3, zandvoort: 2, cota: 2, 'marina-bay': 4, 'las-vegas': 2 };
// built per test with noCache and dropped afterwards: the full suite runs close to Node's default heap limit
var last = null;
function geomOf(d) { if (!last || last.def !== d) last = { def: d, g: T.build(d, { noCache: true }) }; return last.g; }
function mod(a, n) { return ((a % n) + n) % n; }

test('no build errors; at least the 8 required circuits plus the stretch ones', function () {
  assert.deepStrictEqual(C.errors, []);
  REQUIRED.forEach(function (k) { assert.ok(C.get(k), 'missing ' + k); assert.ok(C.get('f1-' + k), 'missing f1-' + k); });
  assert.ok(C.list.length >= 13, 'expected 13 circuits, got ' + C.list.length);
});

test('registered into CB.race.tracks.get() only: Race / Drift / Arcade lists unchanged', function () {
  assert.deepStrictEqual(T.list.map(function (d) { return d.id; }), listBefore);
  C.ids.forEach(function (id) {
    assert.strictEqual(T.get(id), C.get(id));
    assert.ok(T.list.indexOf(C.get(id)) < 0);
    assert.strictEqual(C.get(id).hidden, true);
  });
  assert.ok(T.get('forge-ring'), 'existing circuits still resolve');
});

C.list.forEach(function (def) {
  var key = def.f1.key;
  test(key + ': closed, valid, length within ±5 % of real', function () {
    var g = geomOf(def), v = T.validate(g);
    var real = def.f1.real.length_m;
    assert.ok(Math.abs(g.length - real) / real < 0.05, key + ' length ' + g.length + ' vs ' + real);
    var a = g.samples[0], b = g.samples[g.samples.length - 1];
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < g.ds * 2.5, 'closed loop');
    assert.strictEqual(v.selfIntersections, 0, 'self intersections');
    if (key === 'suzuka') { assert.strictEqual(g.crossings.length, 1); assert.strictEqual(g.crossings[0].type, 'bridge'); }
    else assert.strictEqual(g.crossings.length, 0);
    assert.ok(v.minClearance > 0, 'clearance ' + v.minClearance);
    assert.ok(v.maxHeadingStep_deg < 25, 'heading step ' + v.maxHeadingStep_deg);
    g.samples.forEach(function (s) { assert.ok(isFinite(s.x) && isFinite(s.y) && s.width >= 7 && s.width < 20 && s.wallL > s.hw && s.wallR > s.hw); });
    assert.ok(['cw', 'ccw', 'figure-8'].indexOf(def.f1.real.direction) >= 0);
    // the race direction matches the real circuit (signed area: + = anticlockwise)
    if (def.f1.real.direction !== 'figure-8') {
      var A = 0, S = g.samples;
      for (var i = 0; i < S.length; i++) { var p = S[i], q = S[(i + 1) % S.length]; A += p.x * q.y - q.x * p.y; }
      assert.strictEqual(A > 0 ? 'ccw' : 'cw', def.f1.real.direction);
    }
    assert.ok(g.corners.length >= Math.min(8, def.f1.real.turns - 2), 'corners ' + g.corners.length);
  });

  test(key + ': sectors, DRS zones (real count) and pit lane resolved in metres', function () {
    var g = geomOf(def), m = C.meta(def.id), L = g.length;
    assert.strictEqual(m.length_m, L);
    assert.strictEqual(m.sectors_s.length, 2);
    assert.ok(m.sectors_s[0] > 0 && m.sectors_s[0] < m.sectors_s[1] && m.sectors_s[1] < L);
    assert.strictEqual(m.drs.length, DRS_COUNT[key]);
    m.drs.forEach(function (z) {
      assert.ok(z.length_m > 150 && z.length_m < 2200, 'DRS zone length ' + z.length_m);
      var lead = mod(z.start_s - z.detect_s, L);
      assert.ok(lead > 20 && lead < L * 0.5, 'detection point before the zone');
      // a DRS zone is a straight: no tight corner inside it
      for (var s = z.start_s; mod(s - z.start_s, L) < z.length_m - 5; s += 10) {
        var sm = g.samples[Math.round(mod(s, L) / g.ds) % g.samples.length];
        assert.ok(Math.abs(sm.curvature) < 1 / 75, key + ' DRS zone runs through a corner at s=' + Math.round(s));
      }
    });
    var p = m.pit;
    assert.ok(p.side === 1 || p.side === -1);
    assert.ok(p.length_m > 200 && p.length_m < 1300, 'pit lane length ' + p.length_m);
    assert.ok(p.speedLimit_kph === 60 || p.speedLimit_kph === 80);
    assert.ok(Math.abs(def.pitEntry_s - p.entry_s) < 15 && Math.abs(def.pitExit_s - p.exit_s) < 15);
    for (var t = 0; t < 11; t++) {
      var bs = p.box_s(t);
      assert.ok(p.inLane(bs), 'box ' + t + ' inside the lane');
      var lat = p.laneLatAt(bs);
      assert.ok(Math.abs(lat - p.side * p.offset_m) < 0.6, 'boxes on the full-width lane section');
    }
  });

  test(key + ': project() reports the pit lane surface (and never the track)', function () {
    var g = geomOf(def), m = C.meta(def.id), p = m.pit;
    [p.fastLat, p.boxLat].forEach(function (lat) {
      for (var t = 0; t < 11; t += 2) {
        var pt = g.pointAt(p.box_s(t), lat), r = T.project(g, pt.x, pt.y);
        assert.strictEqual(r.surface, 'pit', key + ' lat ' + lat + ' -> ' + r.surface);
        assert.strictEqual(r.onTrack, true);
        assert.strictEqual(r.pitLane, true);
      }
    });
    // the centre of the track is still asphalt in the pit section; the other side is never pit lane
    var mid = g.pointAt(p.box_s(5), 0), r0 = T.project(g, mid.x, mid.y);
    assert.strictEqual(r0.surface, 'asphalt');
    var opp = g.pointAt(p.box_s(5), -p.side * (g.samples[0].hw + 3)), r1 = T.project(g, opp.x, opp.y);
    assert.notStrictEqual(r1.surface, 'pit');
    // the lane does not reach another part of the circuit
    g.samples.forEach(function (sm) {
      if (!sm.pit) return;
      var q = g.pointAt(sm.s, p.side * sm.pit.outer), pr = T.project(g, q.x, q.y, sm.i);
      var d = Math.abs(mod(pr.s - sm.s + g.length / 2, g.length) - g.length / 2);
      assert.ok(d < 40, key + ' pit lane overlaps another section at s=' + Math.round(sm.s));
    });
  });
});

test('metadata: real data, night races, landmarks, grid slots', function () {
  C.list.forEach(function (d) {
    var r = d.f1.real;
    assert.ok(r.laps > 40 && r.laps < 80 && r.pole_s > 60 && r.pole_s < 110 && r.turns >= 10 && r.turns <= 20, d.id);
    assert.ok(d.theme && d.theme.kerbA && d.theme.kerbB);
    assert.ok(geomOf(d).gridSlots.length >= 22, 'grid for 22 cars');
  });
  ['marina-bay', 'las-vegas', 'bahrain'].forEach(function (k) { assert.strictEqual(C.meta(k).night, true); });
  assert.strictEqual(C.meta('monaco').street, true);
  assert.strictEqual(C.meta('monaco').pit.speedLimit_kph, 60);
  assert.strictEqual(C.get('suzuka').f1.landmark, 'ferris-wheel');
});

test('monaco: barriers right at the track edge everywhere (no run-off), no gravel', function () {
  var g = geomOf(C.get('monaco'));
  var far = 0;
  g.samples.forEach(function (s) {
    if (s.pit) return;
    if (s.wallL - s.hw - s.leftKerb > 3 || s.wallR - s.hw - s.rightKerb > 3) far++;
    assert.strictEqual(s.sandL + s.sandR, 0);
  });
  assert.ok(far / g.samples.length < 0.05, 'barriers far from the edge on ' + far + ' samples');
});

if (TM && TM.buildGeometry) {
  test('3D track mesh + scenery build without NaN for every circuit', function () {
    C.list.forEach(function (d) {
      var g = geomOf(d), tm = TM.buildGeometry(g, d, { quality: 'low' });
      assert.ok(tm.parts.length > 5, d.id);
      tm.parts.forEach(function (p) { for (var i = 0; i < p.positions.length; i += 97) assert.ok(isFinite(p.positions[i]), d.id + ' ' + p.kind); });
      if (SC && SC.buildGeometry) {
        var sc = SC.buildGeometry(g, d, { quality: 'low', groundY: tm.groundY });
        assert.ok(sc.parts.length > 3, d.id + ' scenery');
        sc.parts.forEach(function (p) { for (var i = 0; i < p.positions.length; i += 131) assert.ok(isFinite(p.positions[i]), d.id + ' scenery ' + p.key); });
      }
    });
  });
}

if (standalone && typeof globalThis.test !== 'function') console.log('\n' + passed + ' passed, ' + failed + ' failed');

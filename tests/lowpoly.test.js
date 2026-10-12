/* FORGE Atelier — CB.lowpoly (js/race/gl/lowpoly.js) + hand-authored defs (js/shapes/lowpoly/*.js).
   Every registered CB.shapes model builds as a low-poly car (auto or authored) with finite flat-shaded geometry,
   a sane triangle budget, wheels on the ground at the fitted axles and dims matching the real car; authored defs
   validate; CB.gl.car delegates to the low-poly builder for carStyle 'lowpoly' and keeps the detailed path for
   'detailed'. Loading this file sets CB.lowpoly.style = 'detailed' so the other suites keep testing the detailed
   mesh; the tests here opt in with { carStyle: 'lowpoly' }. */
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');
var ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'js', 'data.js'));
var SH = require(path.join(ROOT, 'js', 'shapes', 'core.js'));
fs.readdirSync(path.join(ROOT, 'js', 'shapes', 'models')).filter(function (f) { return /\.js$/.test(f); }).sort()
  .forEach(function (f) { require(path.join(ROOT, 'js', 'shapes', 'models', f)); });
var LP = require(path.join(ROOT, 'js', 'race', 'gl', 'lowpoly.js'));
var LPDIR = path.join(ROOT, 'js', 'shapes', 'lowpoly');
if (fs.existsSync(LPDIR)) fs.readdirSync(LPDIR).filter(function (f) { return /\.js$/.test(f); }).sort().forEach(function (f) { require(path.join(LPDIR, f)); });
var CAR = require(path.join(ROOT, 'js', 'race', 'gl', 'car-mesh.js'));
var D = globalThis.CB.data;
var SHIPPED = SH.list().map(function (m) { return m.id; });   // shipped models (other suites register fixtures later)
function shipped() { return SHIPPED.map(function (id) { return SH.models[id]; }).filter(Boolean); }
LP.style = 'detailed';   // other suites test the detailed mesh; these tests opt in explicitly

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var test = standalone
  ? function (name, fn) { try { fn(); console.log('  ok   ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; } }
  : globalThis.test;

function refBuild(m) {
  var b = D.defaultBuild(), rb = SH.refBuild(m);
  Object.keys(rb).forEach(function (k) { if (rb[k] && typeof rb[k] === 'object') { b[k] = b[k] || {}; for (var q in rb[k]) b[k][q] = rb[k][q]; } });
  b.body.style = m.style; b.body.model = m.id;
  return b;
}
var cache = {};
function lp(id, lod, extra) {
  var k = id + lod + JSON.stringify(extra || {});
  if (!cache[k]) {
    var b = refBuild(SH.models[id]);
    if (extra) Object.keys(extra).forEach(function (s) { b[s] = Object.assign({}, b[s] || {}, extra[s]); });
    cache[k] = LP.build(b, { lod: lod });
  }
  return cache[k];
}
function checkPart(p, label) {
  var nv = p.positions.length / 3;
  assert.ok(nv > 0, label + ' empty');
  assert.strictEqual(p.normals.length, p.positions.length, label + ' normals');
  assert.strictEqual(p.colors.length, nv * 4, label + ' colours');
  assert.strictEqual(p.indices.length % 3, 0, label + ' indices');
  for (var i = 0; i < p.positions.length; i++) if (!isFinite(p.positions[i]) || !isFinite(p.normals[i])) assert.fail(label + ' NaN');
  for (i = 0; i < p.indices.length; i++) if (p.indices[i] >= nv) assert.fail(label + ' index out of range');
  // flat shading: each triangle owns its 3 vertices and they share one unit normal equal to the face normal
  var P = p.positions, N = p.normals, I = p.indices;
  for (var t = 0; t < I.length; t += 3) {
    var a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    var ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    var fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx, fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-12) continue;
    for (var k = 0; k < 3; k++) {
      var o = I[t + k] * 3;
      if (Math.abs(Math.hypot(N[o], N[o + 1], N[o + 2]) - 1) > 1e-3) assert.fail(label + ' non-unit normal');
      if (Math.abs(N[o] - N[a]) + Math.abs(N[o + 1] - N[a + 1]) + Math.abs(N[o + 2] - N[a + 2]) > 1e-5) assert.fail(label + ' smooth (welded) normal');
    }
    if ((fx * N[a] + fy * N[a + 1] + fz * N[a + 2]) / fl < 0.98) assert.fail(label + ' normal != face normal / winding');
  }
}

test('lowpoly: API surface', function () {
  ['register', 'has', 'get', 'list', 'validate', 'autoDef', 'build', 'carStyle', 'materials'].forEach(function (k) { assert.strictEqual(typeof LP[k], 'function', k); });
  assert.strictEqual(globalThis.CB.lowpoly, LP);
  assert.strictEqual(LP.carStyle({ carStyle: 'lowpoly' }), 'lowpoly');
  assert.strictEqual(LP.carStyle({ carStyle: 'detailed' }), 'detailed');
});

test('lowpoly: every registered model builds (auto or authored) at both LODs, finite + flat shaded, within budget', function () {
  var models = shipped();
  assert.ok(models.length >= 50, 'models: ' + models.length);
  models.forEach(function (m) {
    ['high', 'low'].forEach(function (lod) {
      var r = lp(m.id, lod);
      assert.ok(r && r.parts.length, m.id + ' ' + lod + ' built');
      assert.strictEqual(r.model.id, m.id);
      r.parts.forEach(function (p) { checkPart(p, m.id + '/' + lod + '/' + p.kind); });
      var t = r.stats.triangles;
      if (lod === 'high') {   // wheels stay cheap so authored bodies keep headroom for build extras (wings, splitters)
        var wt = r.parts.filter(function (p) { return p.attach === 'wheel' || p.attach === 'caliper'; }).reduce(function (a, p) { return a + p.triangles; }, 0);
        assert.ok(wt <= 900, m.id + ' wheels ' + wt + ' tris');
      }
      if (lod === 'low') assert.ok(t >= 120 && t <= 500, m.id + ' low LOD ' + t + ' tris');
      else assert.ok(t >= 600 && t <= 3600, m.id + ' high LOD ' + t + ' tris');
      ['cockpitEye', 'hoodCam', 'bumperCam'].forEach(function (k) { assert.ok(r[k].length === 3 && r[k].every(isFinite), m.id + ' ' + k); });
    });
  });
});

test('lowpoly: dims match the real car; wheels on the ground at the fitted axles', function () {
  shipped().forEach(function (m) {
    var r = lp(m.id, 'high'), b = refBuild(m), f = SH.fit(m, b), d = r.dims;
    assert.ok(Math.abs(d.length / f.dims.length - 1) < 0.03, m.id + ' length ' + d.length + ' vs ' + f.dims.length);
    assert.ok(Math.abs(d.height / f.dims.height - 1) < 0.08, m.id + ' height ' + d.height + ' vs ' + f.dims.height);
    assert.ok(Math.abs(d.wheelbase - f.dims.wheelbase) < 1e-9, m.id + ' wheelbase');
    var wheels = r.parts.filter(function (p) { return p.attach === 'wheel'; });
    assert.strictEqual(wheels.length, 8, m.id + ' 4 rims + 4 tyres');
    wheels.forEach(function (p) {
      var W = p.wheel.front ? f.wheels.front : f.wheels.rear;
      assert.ok(Math.abs(p.wheel.x - (W.x - f.dims.centerX)) < 1e-6, m.id + ' wheel x');
      assert.ok(Math.abs(Math.abs(p.wheel.z) - W.track / 2) < 1e-6, m.id + ' track');
      assert.ok(Math.abs(p.wheel.y - p.wheel.r) < 1e-9, m.id + ' on the ground');
      // wheel-local geometry: the tyre radius matches the fitted tyre
      var mx = 0, P = p.positions;
      for (var i = 0; i < P.length; i += 3) mx = Math.max(mx, Math.hypot(P[i], P[i + 1]));
      if (/^tire/.test(p.kind)) assert.ok(Math.abs(mx - W.r) < 0.01, m.id + ' tyre radius ' + mx + ' vs ' + W.r);
    });
    // body clears the ground, is centred on the overall length
    var body = r.parts.filter(function (p) { return p.kind === 'body'; })[0], P2 = body.positions, lo = Infinity, x0 = Infinity, x1 = -Infinity;
    for (var j = 0; j < P2.length; j += 3) { lo = Math.min(lo, P2[j + 1]); x0 = Math.min(x0, P2[j]); x1 = Math.max(x1, P2[j]); }
    assert.ok(lo > 0.02, m.id + ' body clears the ground ' + lo);
    assert.ok(Math.abs(x0 + x1) < 0.06, m.id + ' centred ' + x0 + ' ' + x1);
    ['body', 'glass', 'light-head', 'light-brake'].forEach(function (k) { assert.ok(r.parts.some(function (p) { return p.kind === k; }), m.id + ' has ' + k); });
    assert.strictEqual(r.anchors.headlights.length, 2);
    assert.ok(r.anchors.headlights[0][2] * r.anchors.headlights[1][2] < 0, m.id + ' headlights mirrored');
  });
});

test('lowpoly: hand-authored defs validate and are used', function () {
  var ids = LP.list();
  assert.ok(ids.indexOf('porsche-911-992') >= 0 && ids.indexOf('ford-f150-raptor-gen3') >= 0, 'exemplars registered: ' + ids);
  ids.forEach(function (id) {
    var def = LP.get(id);
    assert.ok(SH.models[id], id + ' has a CB.shapes model');
    var v = LP.validate(def);
    assert.ok(v.ok, id + ': ' + v.errors.join('; '));
    ['body', 'cabin'].forEach(function (k) {
      var sh = def[k]; if (!sh) return;
      var n = sh.stations[0].pts.length;
      sh.stations.forEach(function (s) { assert.strictEqual(s.pts.length, n, id + ' ' + k + ' station point count'); });
      assert.strictEqual(sh.mats.length, sh.stations.length - 1, id + ' ' + k + ' mats rows');
      sh.mats.forEach(function (row) { assert.strictEqual(row.length, n - 1, id + ' ' + k + ' mats cols'); });
    });
    assert.ok(/https?:\/\//.test(def.notes || ''), id + ' notes carry the reference photo URLs');
    assert.strictEqual(lp(id, 'high').auto, false, id + ' built from the authored def');
  });
  // validation catches broken defs
  var bad = LP.validate({ body: { stations: [{ x: 1, pts: [[0, 0], [1, 1], [2, 0]] }, { x: 0, pts: [[0, 0], [1, 1]] }], mats: [['paint']] } });
  assert.ok(!bad.ok && bad.errors.some(function (e) { return /pts/.test(e); }), 'point count mismatch reported');
  var bad2 = LP.validate({ body: { stations: [{ x: 1, pts: [[0, 0], [1, 1], [2, 0]] }, { x: 0, pts: [[0, 0], [1, 1], [2, 0]] }], mats: [['paint', 'nope']] } });
  assert.ok(!bad2.ok && bad2.errors.some(function (e) { return /unknown material/.test(e); }), 'unknown material reported');
});

test('lowpoly: build options drive wings, splitter, diffuser, numbers, paint and wheel size', function () {
  var id = 'porsche-911-992';
  var base = lp(id, 'high', { aero: { wing: 'none', splitter: 'none', diffuser: 'none', sideSkirts: false, canards: false } });
  var gt = lp(id, 'high', { aero: { wing: 'gt-wing' } });
  assert.ok(gt.parts.some(function (p) { return p.kind === 'wing'; }), 'gt wing part');
  var act = lp(id, 'high', { aero: { wing: 'active' } }), wp = act.parts.filter(function (p) { return p.kind === 'wing'; })[0];
  assert.ok(wp && wp.wing && wp.wing.active, 'active wing flagged for pose()');
  function tris(r, k) { return r.parts.filter(function (p) { return p.kind === k; }).reduce(function (a, p) { return a + p.triangles; }, 0); }
  var aero = lp(id, 'high', { aero: { splitter: 'race', diffuser: 'race', wing: 'none' } });
  assert.ok(tris(aero, 'carbon') > tris(base, 'carbon') + 20, 'carbon splitter / diffuser');
  var num = lp(id, 'high', { exterior: { livery_number: '27' } });
  assert.ok(tris(num, 'trim') > tris(base, 'trim') + 20, 'number roundels');
  var red = lp(id, 'high', { exterior: { paint: '#ff0000' } }), blue = lp(id, 'high', { exterior: { paint: '#0000ff' } });
  var cr = red.parts[0].colors, cb = blue.parts[0].colors;
  assert.ok(cr[0] > cr[2] && cb[2] > cb[0], 'paint colour reaches the body faces');
  var big = lp(id, 'high', { wheels: { diameter_in: 21 } }), small = lp(id, 'high', { wheels: { diameter_in: 18 } });
  assert.ok(big.dims.wheelRadius > small.dims.wheelRadius, 'tyre size follows the build');
  var ev = lp(id, 'high', { engine: { type: 'ev' } });
  assert.strictEqual(ev.anchors.exhaust.length, 0, 'EV: no exhaust tips');
});

test('lowpoly: CB.gl.car delegates for carStyle lowpoly, keeps the detailed mesh for detailed; pose works', function () {
  var b = refBuild(SH.models['porsche-911-992']);
  var g = CAR.buildGeometry(b, { lod: 'high', carStyle: 'lowpoly' });
  assert.ok(g.lowpoly && g.dims.lowpoly && g.dims.authored, 'low-poly geometry');
  assert.ok(g.stats.triangles < 4000, 'low-poly budget ' + g.stats.triangles);
  var det = CAR.buildGeometry(b, { lod: 'high', carStyle: 'detailed' });
  assert.ok(!det.lowpoly && det.stats.triangles > 8000, 'detailed geometry kept');
  assert.ok(Math.abs(g.dims.length - det.dims.length) < 1e-9 && Math.abs(g.dims.wheelbase - det.dims.wheelbase) < 1e-9, 'same dims as the detailed real model');
  for (var c = 0; c < 3; c++) assert.ok(Math.abs(g.cockpitEye[c] - det.cockpitEye[c]) < 1e-9, 'same cockpit eye');
  // cache keys differ per style
  assert.notStrictEqual(CAR.cache.key(b, { lod: 'high', carStyle: 'lowpoly' }), CAR.cache.key(b, { lod: 'high', carStyle: 'detailed' }));
  // realised model + pose: wheels spin / steer, brake lights glow
  var m = CAR.build(null, b, { lod: 'high', carStyle: 'lowpoly' }), st = {};
  assert.ok(m.parts.length > 10 && m.parts.every(function (p) { return p.mesh; }));
  var items = CAR.pose(m, { x: 0, y: 0, heading: 0, speed: 0, brake: 0 }, 1 / 60, st);
  assert.strictEqual(items.length, m.parts.length);
  var brake = st.items.filter(function (i) { return i.kind === 'light-brake'; })[0], off = brake.material.emissive[0];
  CAR.pose(m, { x: 0, y: 0, heading: 0, speed: 20, brake: 1, steerAngle: 0.4 }, 1 / 60, st);
  assert.ok(brake.material.emissive[0] > off + 1, 'brake lights glow');
  var fl = st.items.filter(function (i) { return i.kind === 'wheel-fl'; })[0], rl = st.items.filter(function (i) { return i.kind === 'wheel-rl'; })[0];
  assert.ok(fl && rl, 'wheel parts');
  assert.ok(Math.abs(fl.model[2]) > 0.05 && Math.abs(rl.model[2]) < Math.abs(fl.model[2]), 'front wheels steer');
  CAR.pose(m, { x: 0, y: 0, heading: 0, speed: 20, brake: 0, headlights: true }, 1 / 60, st);
  var head = st.items.filter(function (i) { return i.kind === 'light-head' && !i.part.lightKey; })[0];
  assert.ok(head.material.emissive[0] > 1, 'headlights on');
  // low LOD through car-mesh
  var lo = CAR.buildGeometry(b, { lod: 'low', carStyle: 'lowpoly' });
  assert.ok(lo.lowpoly && lo.stats.triangles < 500, 'low LOD ' + lo.stats.triangles);
  // AI opponents: deterministic per-opponent model in low-poly too
  var ai = CAR.buildGeometry({ body: { style: 'coupe' } }, { lod: 'low', carStyle: 'lowpoly', isPlayer: false, id: 'ai-3' });
  assert.ok(ai.lowpoly && ai.model && SH.models[ai.model.id]);
  // no shapes model / shapes:false -> procedural loft as before
  assert.ok(!CAR.buildGeometry(b, { lod: 'high', carStyle: 'lowpoly', shapes: false }).lowpoly);
});

test('lowpoly: auto defs come from CB.shapes with consistent stations', function () {
  ['bmw-m4-g82', 'mercedes-sprinter-vs30', 'tesla-model-s-2021', 'mazda-mx5-nd'].forEach(function (id) {
    var d = LP.autoDef(id);
    assert.ok(d && d.auto, id);
    var v = LP.validate(d);
    assert.ok(v.ok, id + ' ' + v.errors.join('; '));
    assert.ok(d.body.stations.length >= 8 && d.body.stations.length <= 16, id + ' stations ' + d.body.stations.length);
    assert.ok(d.parts.some(function (p) { return p.mat === 'light'; }) && d.parts.some(function (p) { return p.mat === 'tail'; }), id + ' lamps from the views');
  });
  assert.ok(lp('porsche-911-992', 'high').auto === false && LP.build(refBuild(SH.models['porsche-911-992']), { forceAuto: true }).auto === true, 'forceAuto');
});

test('lowpoly: mirror stalks stay short when the housing sits outboard of the skin', function () {
  var id = 'ferrari-sf90-stradale', orig = LP.get(id), d = JSON.parse(JSON.stringify(orig));
  d.parts.forEach(function (p) { if (p.mat === 'mirror' && p.t === 'prism') { p.z0 += 0.04; p.z1 += 0.04; } if (p.mat === 'mirror' && p.t === 'box') p.c[2] += 0.04; });
  try {
    LP.clearCache(); LP.register(id, d);
    var r = LP.build(refBuild(SH.models[id]), { lod: 'high' });
    assert.ok(r.mirrorPlan && r.mirrorPlan.stalks.length, 'stalk planned');
    r.mirrorPlan.stalks.forEach(function (s) { assert.ok(s.s[1] < 0.15, 'stalk height ' + s.s[1]); });
  } finally { LP.clearCache(); LP.register(id, orig); }
});

test('lowpoly: def exhaust override replaces the model tips; validation', function () {
  var rx = lp('mazda-rx7-fd3s', 'high').anchors.exhaust;
  assert.strictEqual(rx.length, 2, 'RX-7 twin tips');
  assert.ok(rx.every(function (e) { return e[2] > 0.3; }), 'RX-7 tips on the right');
  var gt = lp('ford-gt-2017', 'high').anchors.exhaust;
  assert.ok(gt.length === 2 && gt.every(function (e) { return Math.abs(e[1] - 0.72) < 0.03; }), 'Ford GT tips high');
  assert.strictEqual(lp('aston-martin-vantage-2018', 'high').anchors.exhaust.length, 4, 'Vantage quad tips');
  assert.strictEqual(lp('alpine-a110', 'high').anchors.exhaust.length, 1, 'A110 single tip');
  assert.ok(!LP.validate({ body: LP.get('alpine-a110').body, exhaust: [{ cy: 0.3 }] }).ok, 'bad exhaust rejected');
});

test('lowpoly: flare bands start at the arch cut; maxTilt decals are one flat polygon', function () {
  var A = { x: 1, cy: 0.35, r: 0.4 }, q = function (r, a) { return [A.x + Math.cos(a) * r, A.cy + Math.sin(a) * r]; };
  var pts = LP._.clampFlare([q(0.37, 0.5), q(0.47, 0.5), q(0.47, 0.8), q(0.37, 0.8)], [A]);
  [0, 3].forEach(function (k) { assert.ok(Math.abs(Math.hypot(pts[k][0] - A.x, pts[k][1] - A.cy) - A.r) < 1e-9, 'inner edge on the cut'); });
  assert.ok(Math.abs(Math.hypot(pts[1][0] - A.x, pts[1][1] - A.cy) - 0.47) < 1e-9, 'outer edge kept');
  var C = LP._.compile('tesla-model-s-2021', LP.get('tesla-model-s-2021'));
  var lamp = LP.get('tesla-model-s-2021').parts.filter(function (p) { return p.view === 'front' && p.mat === 'light'; })[0];
  assert.ok(lamp.maxTilt > 0);
  var pcs = LP._.planeDecal(C.tris, 'front', lamp.pts, 0.009, lamp.maxTilt * Math.PI / 180);
  assert.strictEqual(pcs.length, 1);
  var n = pcs[0].n;
  assert.ok(n[0] >= Math.cos(lamp.maxTilt * Math.PI / 180) - 1e-6, 'faces the front within maxTilt');
  var d0 = pcs[0].pts[0][0] * n[0] + pcs[0].pts[0][1] * n[1] + pcs[0].pts[0][2] * n[2];
  pcs[0].pts.forEach(function (p) { assert.ok(Math.abs(p[0] * n[0] + p[1] * n[1] + p[2] * n[2] - d0) < 1e-9, 'planar'); });
  var M = LP.materials({});
  assert.ok(M.glass.materialType === 'standard' && M.glass.envIntensity <= 0.5 && M.carbon.envIntensity <= 0.35 && M.gloss.envIntensity < 1, 'dark glass / carbon / gloss reflections');
});

if (standalone && require.main === module) console.log(process.exitCode ? 'FAILED' : 'all lowpoly tests passed');

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
        // pickups opt into all-terrain tyres (wheels.tyre 'at': lug blocks on a grooved tread): their 33-35 in
        // off-road tyres are the most visible part of the truck, so they get a larger wheel allowance
        assert.ok(wt <= (m.style === 'pickup' ? 1500 : 900), m.id + ' wheels ' + wt + ' tris');
      }
      if (lod === 'low') assert.ok(t >= 120 && t <= 500, m.id + ' low LOD ' + t + ' tris');
      // high LOD: 3600 + 600 for the detailed rear (racing is seen from behind: multi-element tail lamps, light bars,
      // diffuser fins, plate recess, badge text, wing endplates); pickups +700 (tailgate, bed rails, tow hitch on
      // top of their larger all-terrain tyre allowance)
      else assert.ok(t >= 600 && t <= (m.style === 'pickup' ? 4300 : 4200), m.id + ' high LOD ' + t + ' tris');
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

test('lowpoly: opt-in all-terrain tyres (wheels.tyre "at"): lug blocks on the tread, true size, low LOD untouched', function () {
  var W = { r: 0.44, rim: 0.22, tw: 0.32 }, o = { style: 'star', spokes: 6, sides: 12, finish: [0.3, 0.3, 0.3] };
  var road = LP._.wheelGeo(W, o), at = LP._.wheelGeo(W, Object.assign({ tyre: 'at' }, o));
  assert.ok(at.tyre.tris() > road.tyre.tris() + 100, 'lugs add geometry ' + road.tyre.tris() + ' -> ' + at.tyre.tris());
  var mx = 0, mn = Infinity, P = at.tyre.p;
  for (var i = 0; i < P.length; i += 3) { var rr = Math.hypot(P[i], P[i + 1]); mx = Math.max(mx, rr); if (Math.abs(P[i + 2]) < W.tw * 0.37 && rr > W.rim + 0.05) mn = Math.min(mn, rr); }
  assert.ok(Math.abs(mx - W.r) < 0.004, 'lug tops on the tyre radius ' + mx);
  assert.ok(mn < W.r - 0.01, 'grooved tread under the lugs ' + mn);
  // the tall sidewall stays visible: the rim face does not grow over the bead as much as on a road tyre
  function rimR(g) { var m = 0; for (var k = 0; k < g.rim.p.length; k += 3) m = Math.max(m, Math.hypot(g.rim.p[k], g.rim.p[k + 1])); return m; }
  assert.ok(rimR(at) < rimR(road) - 0.01, 'AT rim face ' + rimR(at) + ' vs road ' + rimR(road));
  var lowA = LP._.wheelGeo(W, Object.assign({ tyre: 'at', low: true }, o)), lowR = LP._.wheelGeo(W, Object.assign({ low: true }, o));
  assert.strictEqual(lowA.tyre.tris(), lowR.tyre.tris(), 'low LOD unchanged');
  ['ford-f150-raptor-gen3', 'toyota-tacoma-trdpro-2024', 'tesla-cybertruck'].forEach(function (id) {
    var r = lp(id, 'high'), t = r.parts.filter(function (p) { return /^tire-/.test(p.kind); })[0];
    assert.ok(t && t.triangles > 200, id + ' uses all-terrain tyres (' + (t && t.triangles) + ' tris)');
  });
});

test('lowpoly: glass tips — a twisted side-glass quad gives its flat sliver to the panel it lies on', function () {
  var GT = LP._.glassTipMats;
  // emitShell quad A (row i, col j) -> Bq (row i2, col j) -> C (i2, j+1) -> D (i, j+1); split A-D-Bq / D-C-Bq.
  // Rear station's glass column lies nearly flat on the haunch: D-C-Bq faces the sky.
  var A = [-0.4, 0.9, 0.66], Bq = [-0.9, 0.97, 0.6], C = [-0.9, 1.05, 0.42], D = [-0.4, 1.11, 0.52];
  var mats = { 6: 'paint', 7: 'glass', 8: 'paint2' }, calls = [];
  function matFn(i, j) { calls.push(j); return mats[j]; }
  function P() { return [0, 0, 0]; }
  assert.deepStrictEqual(GT(matFn, 0, 7, 1, 11, P, [A, D, Bq], [D, C, Bq], A, Bq), ['glass', 'paint2'], 'upper sliver -> roof column');
  assert.deepStrictEqual(calls, [8]);
  // front tip: the window column starts as a flat ledge on the cowl, the sliver along the lower edge -> belt column
  var A1 = [0.4, 0.9, 0.7], D1 = [0.4, 0.93, 0.6], B1 = [-0.1, 0.885, 0.745], C1 = [-0.1, 1.115, 0.62];
  assert.deepStrictEqual(GT(matFn, 0, 7, 1, 11, P, [A1, D1, B1], [D1, C1, B1], A1, B1), ['paint', 'glass'], 'lower sliver -> belt column');
  // side glass running into a screen keeps its glass; a planar quad is left alone
  mats[8] = 'glass';
  assert.strictEqual(GT(matFn, 0, 7, 1, 11, P, [A, D, Bq], [D, C, Bq], A, Bq), null);
  var A2 = [-0.4, 0.9, 0.7], B2 = [-0.9, 0.92, 0.69], C2 = [-0.9, 1.1, 0.6], D2 = [-0.4, 1.08, 0.61];
  assert.strictEqual(GT(matFn, 0, 7, 1, 11, P, [A2, D2, B2], [D2, C2, B2], A2, B2), null);
});

test('lowpoly: rear side glass on the hypercars / C 63 has no pale up-facing facet (no hard fold inside the glass)', function () {
  // a facet folded >20 deg off its glass neighbours toward the sky mirrors the environment as a pale triangle on the
  // dark side window (rear 3/4 views). The P1 is exempt: its side glass runs on into the glass roof panel.
  ['ferrari-sf90-stradale', 'bugatti-chiron', 'koenigsegg-jesko', 'porsche-918-spyder', 'lamborghini-huracan-evo', 'ferrari-296-gtb',
    'audi-r8-v10-gen2', 'chevrolet-corvette-c8', 'ford-gt-2017', 'mercedes-amg-c63-w206'].forEach(function (id) {
    var r = lp(id, 'high'), T = [];
    r.parts.filter(function (p) { return p.mat === 'glass'; }).forEach(function (p) {
      var P = p.positions, N = p.normals, I = p.indices;
      for (var t = 0; t < I.length; t += 3) {
        var v = [0, 1, 2].map(function (q) { var k = I[t + q] * 3; return [P[k], P[k + 1], P[k + 2]]; });
        var cx = (v[0][0] + v[1][0] + v[2][0]) / 3, cz = (v[0][2] + v[1][2] + v[2][2]) / 3;
        if (cx < -0.3 && cz > 0.45) T.push({ v: v, n: [N[I[t] * 3], N[I[t] * 3 + 1], N[I[t] * 3 + 2]] });
      }
    });
    function key(q) { return q.map(function (x) { return x.toFixed(4); }).join(','); }
    var E = {};
    T.forEach(function (t, ti) { for (var e = 0; e < 3; e++) { var a = key(t.v[e]), b = key(t.v[(e + 1) % 3]), k = a < b ? a + '|' + b : b + '|' + a; (E[k] = E[k] || []).push(ti); } });
    Object.keys(E).forEach(function (k) {
      var l = E[k]; if (l.length !== 2) return;
      var a = T[l[0]].n, b = T[l[1]].n, ang = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) / Math.PI * 180;
      assert.ok(ang < 20, id + ': rear side glass folds ' + ang.toFixed(1) + ' deg at ' + k);
    });
  });
  // the C 63's C-pillar (roof-rail column behind the quarter glass) is body colour, not glass
  var c63 = LP.get('mercedes-amg-c63-w206');
  assert.strictEqual(c63.body.mats[10][7], 'paint'); assert.strictEqual(c63.body.mats[11][7], 'paint');
});

test('lowpoly: wellGrid — an arch end snapped near an authored ring never lands inboard of the next arch vertex (no flank wedge)', function () {
  var ring = function () { return [[0.15, 0], [0.15, 0.8], [0.6, 0.9], [0.9, 0.75], [1.2, 0.5], [1.25, 0]]; };
  var A = { x: 1.3, cy: 0.33, r: 0.37, zIn: 0.6 };
  // authored rings within 3 cm of both arch ends, but inboard of the neighbouring arch vertex (the ends wrap below the axle)
  var e = A.r * Math.cos(-0.3) - 0.026;
  [5, 2].forEach(function (K) {
    var st = [2.2, A.x + e, 0.5, A.x - e, -2.2].map(function (x) { return { x: x, pts: ring() }; });
    var g = LP._.wellGrid(st, [A], K).grid;
    for (var i = 1; i < g.length; i++) assert.ok(g[i].x <= g[i - 1].x + 1e-9, 'rings stay in x order');
    // inside the arch span every ring is cut (well), outside none: one open -> well -> open run, no open ring between wells
    var seq = g.map(function (r) { return r.well == null ? 'o' : 'w'; }).join('').replace(/(.)\1+/g, '$1');
    assert.strictEqual(seq, 'owo', 'K=' + K + ' well sequence ' + g.map(function (r) { return r.x.toFixed(3) + (r.well == null ? 'o' : 'w'); }).join(' '));
  });
});

test('lowpoly: stacked maxTilt decals — the lamp sits on (coplanar with, proud of) its surround; mirrored copies symmetric', function () {
  var def = JSON.parse(JSON.stringify(LP.get('mclaren-p1')));
  def.parts.forEach(function (p) { if (p.t === 'poly' && p.view === 'front' && p.mirror) p.maxTilt = 35; });
  var C = LP._.compile('test-p1-tilt', def);
  var head = C.parts.filter(function (p) { return p.t === 'poly3' && p.mat === 'light'; });
  var surround = C.parts.filter(function (p) { return p.t === 'poly3' && p.mat === 'gloss' && p.pts[0][0] > 1; });
  assert.ok(head.length >= 2 && surround.length >= 2);
  [1, -1].forEach(function (sg) {
    var h = head.filter(function (p) { return p.pts[0][2] * sg > 0; })[0], s = surround.filter(function (p) { return p.pts[0][2] * sg > 0 && Math.abs(p.pts[0][1] - h.pts[0][1]) < 0.15; })[0];
    assert.ok(h && s, 'lamp + surround on side ' + sg);
    assert.ok(Math.abs(h.n[0] * s.n[0] + h.n[1] * s.n[1] + h.n[2] * s.n[2] - 1) < 1e-6, 'coplanar stack');
    var dh = h.pts[0][0] * h.n[0] + h.pts[0][1] * h.n[1] + h.pts[0][2] * h.n[2], ds = s.pts[0][0] * s.n[0] + s.pts[0][1] * s.n[1] + s.pts[0][2] * s.n[2];
    assert.ok(dh > ds + 1e-4, 'lamp in front of its surround');
  });
  var R = head.filter(function (p) { return p.pts[0][2] > 0; }), L = head.filter(function (p) { return p.pts[0][2] < 0; });
  assert.strictEqual(R.length, L.length);
  R.forEach(function (r, k) {
    var l = L[k];
    assert.ok(Math.abs(r.n[0] - l.n[0]) + Math.abs(r.n[1] - l.n[1]) + Math.abs(r.n[2] + l.n[2]) < 1e-6, 'mirrored normal');
    r.pts.forEach(function (q, i) { var m = l.pts[i]; assert.ok(Math.abs(q[0] - m[0]) + Math.abs(q[1] - m[1]) + Math.abs(q[2] + m[2]) < 1e-6, 'mirrored vertex'); });
  });
});

test('lowpoly: per-def stock wheel look (wheels.stock) applies only while the build keeps the generic default', function () {
  var id = 'mclaren-p1', def = LP.get(id), saved = def.wheels;
  try {
    def.wheels = Object.assign({}, saved, { stock: { rim: '#c0c2c5', material: 'steel', caliper: '#2a2a2a' } });
    assert.ok(LP.validate(def).ok, LP.validate(def).errors.join('; '));
    assert.deepStrictEqual(LP.stockWheels(id), { finish: '#c0c2c5', material: 'steel', caliper: '#2a2a2a' });
    function rimCal(extra) {
      var b = refBuild(SH.models[id]);
      if (extra) Object.keys(extra).forEach(function (s) { b[s] = Object.assign({}, b[s] || {}, extra[s]); });
      var r = LP.build(b, { lod: 'high' }), cal = r.parts.filter(function (p) { return p.kind === 'caliper-fl'; })[0];
      var rim = r.parts.filter(function (p) { return p.kind === 'wheel-fl'; })[0];
      return { cal: [cal.colors[0], cal.colors[1], cal.colors[2]], rim: rim };
    }
    var a = rimCal(), x = rimCal({ exterior: { caliperColor: '#d40000' }, wheels: { finish: '#111111' } });
    assert.ok(Math.abs(a.cal[0] - a.cal[2]) < 0.02 && a.cal[0] < 0.1, 'stock dark calliper on the default build');
    assert.ok(x.cal[0] > 0.3 && x.cal[2] < 0.1, 'explicit red calliper wins');
    def.wheels = Object.assign({}, saved, { stock: { rim: 'silver' } });
    assert.ok(!LP.validate(def).ok, 'bad hex rejected');
  } finally { def.wheels = saved; LP.clearCache(); }
  assert.strictEqual(LP.stockWheels('no-such-car'), null);
});

test('lowpoly: Garage stock spec (CB.stock) uses a def\'s wheels.stock when the model has no wheel signature', function () {
  ['js/util.js', 'js/shapes/stock-specs.js', 'js/state.js', 'js/physics.js', 'js/rules.js'].forEach(function (f) { var p = path.join(ROOT, f); if (fs.existsSync(p)) require(p); });
  var ST = globalThis.CB.stock;
  if (!ST || typeof ST.build !== 'function') return;
  var id = 'ford-transit-hr', def = LP.get(id), saved = def.wheels;
  assert.ok(!SH.models[id].wheel, 'fixture model has no wheel signature');
  try {
    def.wheels = Object.assign({}, saved, { stock: { rim: '#b1b4b8', caliper: '#202020' } });
    var b = ST.build(id).build;
    assert.strictEqual(b.wheels.finish, '#b1b4b8');
    assert.strictEqual(b.exterior.caliperColor, '#202020');
  } finally { def.wheels = saved; LP.clearCache(); }
});

if (standalone && require.main === module) console.log(process.exitCode ? 'FAILED' : 'all lowpoly tests passed');

test('lowpoly: text badges (stroke font) sit flat on the rear, low:true parts draw at the low LOD, lens / smoke mats', function () {
  var src = LP.get('porsche-911-992');
  var d = JSON.parse(JSON.stringify(src));
  d.parts = d.parts.filter(function (p) { return !p.low && p.mat !== 'chrome'; });   // fixture lamps / strokes only
  d.parts.push({ t: 'text', view: 'rear', str: 'GT3 RS', at: [0, 0.85], h: 0.05, mat: 'chrome' });
  d.parts.push({ t: 'poly', view: 'rear', mat: 'tail', low: true, maxTilt: 40, pts: [[-0.7, 0.9], [0.7, 0.9], [0.7, 0.93], [-0.7, 0.93]] });
  d.parts.push({ t: 'poly', view: 'rear', mat: 'lens', mirror: true, pts: [[0.3, 0.7], [0.5, 0.7], [0.5, 0.75], [0.3, 0.75]] });
  d.parts.push({ t: 'poly', view: 'rear', mat: 'smoke', mirror: true, pts: [[0.3, 0.6], [0.5, 0.6], [0.5, 0.65], [0.3, 0.65]] });
  assert.ok(LP.validate(d).ok, JSON.stringify(LP.validate(d).errors));
  assert.ok(!LP.validate({ body: d.body, parts: [{ t: 'text', view: 'rear', str: '', at: [0, 1], h: 0.05 }] }).ok, 'empty text rejected');
  var C = LP._.compile('lp-text-fixture', d);
  var strokes = C.parts.filter(function (p) { return p.t === 'poly3' && p.mat === 'badgeP'; });   // chrome text on the paint: contrast badge
  assert.ok(strokes.length >= 15 && strokes.length <= 40, 'GT3 RS strokes ' + strokes.length);
  var xs = strokes.map(function (p) { return p.pts.map(function (q) { return q[0]; }); }).reduce(function (a, b) { return a.concat(b); }, []);
  assert.ok(Math.max.apply(null, xs) - Math.min.apply(null, xs) < 0.05, 'one flat plane facing the rear');
  var zs = strokes[0].pts.map(function (q) { return q[2]; });
  assert.ok(Math.max.apply(null, zs) < 0, 'text reads left to right from behind (G on the viewer\'s left = -z)');
  assert.ok(C.parts.some(function (p) { return p.t === 'poly3' && p.mat === 'tail' && p.low; }), 'low flag kept on projected decals');
  LP.register('lp-text-fixture', d);
  var m = Object.assign({}, SH.models['porsche-911-992'], { id: 'lp-text-fixture' }), b = refBuild(SH.models['porsche-911-992']);
  b.body.model = m.id;
  SH.models[m.id] = m;   // fixture only (not in SH.list()); removed again below
  var lo, hi;
  try { lo = LP.build(b, { lod: 'low' }); hi = LP.build(b, { lod: 'high' }); } finally { delete SH.models[m.id]; LP.unregister(m.id); }
  assert.ok(lo && hi && lo.model.id === m.id && hi.model.id === m.id, 'fixture built');
  var tail = lo.parts.filter(function (p) { return p.kind === 'light-brake'; })[0];
  assert.ok(tail && tail.triangles === 2, 'low LOD: the authored light bar replaces the per-side lamp quads (' + (tail && tail.triangles) + ')');
  // contrast badge: dark lettering on white paint, chrome on dark paint
  var white = refBuild(SH.models['porsche-911-992']); white.body.model = m.id; white.exterior = Object.assign({}, white.exterior, { paint: '#f4f4f2' });
  var black = refBuild(SH.models['porsche-911-992']); black.body.model = m.id; black.exterior = Object.assign({}, black.exterior, { paint: '#101012' });
  SH.models[m.id] = m; LP.register(m.id, d);
  var hw, hb;
  try { hw = LP.build(white, { lod: 'high' }); hb = LP.build(black, { lod: 'high' }); } finally { delete SH.models[m.id]; LP.unregister(m.id); }
  var gw = hw.parts.filter(function (p) { return p.mat === 'gloss'; })[0], cb = hb.parts.filter(function (p) { return p.mat === 'chrome'; })[0];
  assert.ok(hb.parts.filter(function (p) { return p.mat === 'chrome'; })[0].triangles > hw.parts.filter(function (p) { return p.mat === 'chrome'; }).reduce(function (a, p) { return a + p.triangles; }, 0), 'lettering is chrome on dark paint only');
  assert.ok(gw && cb, 'gloss / chrome parts');
  // low-LOD decal fit: authored low lamps stay inside the low shell's rear silhouette
  var lt = lo.parts.filter(function (p) { return p.kind === 'light-brake'; })[0], zmax = 0;
  for (var k = 2; k < lt.positions.length; k += 3) zmax = Math.max(zmax, Math.abs(lt.positions[k]));
  assert.ok(zmax < 0.7 * lo.dims.width / 2 + 0.2 && zmax <= lo.shell.hw, 'low lamp inboard of the low shell (' + zmax + ')');
  var base = lp('porsche-911-992', 'high');
  assert.ok(hi.stats.triangles > base.stats.triangles + 30, 'text + lens adds geometry at high LOD');
});

test('lowpoly: low-LOD station decimation keeps the ends — nose / tail sections match the authored shell (Wrangler tailgate)', function () {
  function env(s) { var e = [-Infinity, Infinity, -Infinity]; s.pts.forEach(function (p) { e[0] = Math.max(e[0], p[0]); e[1] = Math.min(e[1], p[0]); e[2] = Math.max(e[2], p[1]); }); return e; }
  shipped().forEach(function (m) {
    var def = LP.get(m.id);
    if (!def) return;
    var st = def.body.stations.map(function (s) { return { x: +s.x, pts: s.pts }; }).sort(function (a, b) { return b.x - a.x; });
    var dec = LP._decimateStations(st, 6, 4), x0 = st[0].x, x1 = st[st.length - 1].x;
    assert.ok(dec[0] === st[0] && dec[dec.length - 1] === st[st.length - 1], m.id + ' first / last station kept');
    assert.ok(dec.length >= Math.min(6, st.length) && dec.length <= 10, m.id + ' ' + dec.length + ' stations');
    // every authored section in the first / last 35 cm (bumper faces, tailgate folds, raked tail lips) is
    // reproduced by the low shell's interpolation within 5 cm (top, bottom, half width)
    st.forEach(function (S) {
      if (Math.min(x0 - S.x, S.x - x1) >= 0.35) return;
      for (var i = 0; i < dec.length - 1; i++) {
        var A = dec[i], B = dec[i + 1];
        if (S.x > A.x + 1e-9 || S.x < B.x - 1e-9) continue;
        var t = A.x === B.x ? 0 : (A.x - S.x) / (A.x - B.x), es = env(S), ea = env(A), eb = env(B);
        for (var c = 0; c < 3; c++) assert.ok(Math.abs(es[c] - (ea[c] + (eb[c] - ea[c]) * t)) < 0.05, m.id + ' end section x ' + S.x + ' missed by the low shell');
        break;
      }
    });
  });
  // the Wrangler needs no low-only body-colour boxes any more: its tub and upright tailgate come from the shell
  assert.ok(!LP.get('jeep-wrangler-rubicon-jl').parts.some(function (p) { return p.t === 'box' && p.low === 'only' && p.mat === 'paint'; }), 'no Wrangler low-LOD workaround boxes');
});

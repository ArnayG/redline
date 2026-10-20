/* Redline — CB.gl.f1car (js/race/gl/f1-car-mesh.js) + the car-mesh / pose integration (docs/F1-SPEC.md §2).
   Pure geometry, no GL: part kinds, wheels, triangle budgets per LOD, dims (5.6 x 2.0 m, 3.6 m wheelbase), team
   liveries in the vertex colours, CB.gl.car routing of F1 builds, DRS flap + tyre-compound stripe in pose(). */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');

require(path.join(root, 'js', 'util.js'));
require(path.join(root, 'js', 'data.js'));
require(path.join(root, 'js', 'state.js'));
require(path.join(root, 'js', 'f1', 'f1-teams.js'));
require(path.join(root, 'js', 'race', 'gl', 'lowpoly.js'));
var CAR = require(path.join(root, 'js', 'race', 'gl', 'car-mesh.js'));
var F1 = require(path.join(root, 'js', 'race', 'gl', 'f1-car-mesh.js'));
var TEAMS = globalThis.CB.f1.teams;

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var test = standalone
  ? function (name, fn) {
    try { fn(); console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
  }
  : globalThis.test;

function lin(hex) { var n = parseInt(hex.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(function (v) { return Math.pow(v, 2.2); }); }
function hasColour(part, rgb, tol) {
  var c = part.colors;
  for (var i = 0; i < c.length; i += 4) {
    // faces carry a +-3.5 % value jitter
    var k = c[i] / Math.max(1e-6, rgb[0]) || c[i + 1] / Math.max(1e-6, rgb[1]);
    if (Math.abs(c[i] - rgb[0] * k) < tol && Math.abs(c[i + 1] - rgb[1] * k) < tol && Math.abs(c[i + 2] - rgb[2] * k) < tol && k > 0.9 && k < 1.1) return true;
  }
  return false;
}
function bounds(g, skipWheels) {
  var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  g.parts.forEach(function (p) {
    if (skipWheels && p.attach === 'wheel') return;
    for (var i = 0; i < p.positions.length; i += 3) for (var k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p.positions[i + k]); mx[k] = Math.max(mx[k], p.positions[i + k]); }
  });
  return { mn: mn, mx: mx };
}

test('f1car: detects F1 builds (also after CB.state.normalize drops build.f1), leaves road cars alone', function () {
  var b = TEAMS.buildFor('ferrari');
  assert.ok(F1.isF1(b));
  // CB.state.normalize drops build.f1 (and, with CB.shapes loaded, the unknown body.model): the F1 hooks restore
  // car.build in carCreated. A build that kept its model id still finds its team from the livery paint.
  var n = JSON.parse(JSON.stringify(b)); delete n.f1;
  assert.ok(F1.isF1(n), 'body.model f1-2026 alone marks an F1 build');
  assert.strictEqual(F1.livery(n).teamId, 'ferrari', 'team recovered from the livery paint');
  assert.ok(!F1.isF1(globalThis.CB.data.defaultBuild()));
});

test('f1car: high and low LOD part kinds, wheels, DRS flap, decals, triangle budgets', function () {
  var hi = F1.build(TEAMS.buildFor('mclaren'), { lod: 'high' }), lo = F1.build(TEAMS.buildFor('mclaren'), { lod: 'low' });
  var kinds = hi.parts.map(function (p) { return p.kind; });
  ['body', 'carbon', 'wing', 'driver', 'light-brake', 'decal'].forEach(function (k) { assert.ok(kinds.indexOf(k) >= 0, 'high has ' + k); });
  ['fl', 'fr', 'rl', 'rr'].forEach(function (w) {
    assert.ok(kinds.indexOf('wheel-' + w) >= 0 && kinds.indexOf('tire-' + w) >= 0, 'wheel ' + w);
    hi.parts.filter(function (p) { return p.kind === 'tire-' + w || p.kind === 'wheel-' + w; }).forEach(function (p) { assert.strictEqual(p.attach, 'wheel'); assert.strictEqual(p.wheel.id, w); });
  });
  var flap = hi.parts.filter(function (p) { return p.wing && p.wing.drs; });
  assert.strictEqual(flap.length, 1, 'one DRS flap');
  assert.ok(flap[0].wing.open > 0.3 && flap[0].wing.open < 0.6, 'flap opens ~26 deg');
  assert.ok(hi.parts.some(function (p) { return p.texture === 'number'; }), 'number decal');
  assert.ok(hi.parts.some(function (p) { return /^f1badge:mclaren/.test(p.texture || ''); }), 'team-name text badge');
  assert.strictEqual(hi.parts.filter(function (p) { return p.stripe; }).length, 4, 'compound stripe per tyre');
  assert.ok(hi.stats.triangles > 1500 && hi.stats.triangles <= 4000, 'high ' + hi.stats.triangles);
  assert.ok(lo.stats.triangles <= 420, 'low ' + lo.stats.triangles);
  assert.ok(lo.parts.length <= 3, 'low LOD is <= 3 draw calls');
  [hi, lo].forEach(function (g) {
    g.parts.forEach(function (p) {
      for (var i = 0; i < p.positions.length; i++) assert.ok(isFinite(p.positions[i]), 'finite positions ' + p.kind);
      var nv = p.positions.length / 3;
      for (var j = 0; j < p.indices.length; j++) assert.ok(p.indices[j] < nv, 'index in range');
      assert.strictEqual(p.uvs.length, nv * 2, 'uvs per vertex');
    });
  });
});

test('f1car: real F1 dimensions (5.6 m x 2.0 m, 3.6 m wheelbase, ~0.97 m tall, 720 mm tyres)', function () {
  var g = F1.build(TEAMS.buildFor('redbull'), { lod: 'high' }), B = bounds(g, true);
  assert.ok(Math.abs((B.mx[0] - B.mn[0]) - 5.6) < 0.15, 'length ' + (B.mx[0] - B.mn[0]));
  assert.ok(Math.abs((B.mx[2] - B.mn[2]) - 2.0) < 0.06, 'width ' + (B.mx[2] - B.mn[2]));
  assert.ok(B.mx[1] > 0.93 && B.mx[1] < 1.05, 'height ' + B.mx[1]);
  assert.ok(B.mn[1] >= 0.02 && B.mn[1] < 0.05, 'floor just off the ground ' + B.mn[1]);
  var W = g.anchors.wheels;
  assert.strictEqual(W.length, 4);
  assert.ok(Math.abs((W[0].x - W[2].x) - 3.6) < 1e-6, 'wheelbase');
  W.forEach(function (w) { assert.ok(Math.abs(w.r - 0.36) < 1e-6 && Math.abs(w.y - w.r) < 1e-6, 'tyre on the ground'); });
  assert.ok(W[2].width > W[0].width, 'rear tyres wider');
  assert.strictEqual(g.dims.length, 5.6); assert.strictEqual(g.dims.width, 2.0);
  assert.ok(g.cockpitEye[1] > 0.7 && g.cockpitEye[1] < 0.9 && g.hoodCam[1] > 1.0, 'onboard eye under the halo, T-cam above the airbox');
});

test('f1car: every team livery lands in the vertex colours; teams differ; helmets per driver', function () {
  var seen = {};
  TEAMS.list.forEach(function (t) {
    var g = F1.build(TEAMS.buildFor(t.id), { lod: 'high' }), body = g.parts.filter(function (p) { return p.kind === 'body'; })[0];
    assert.ok(hasColour(body, lin(t.livery.primary), 0.02), t.id + ' primary on the body');
    var sig = Array.prototype.map.call(body.colors, function (v) { return v.toFixed(2); }).join();
    assert.ok(!seen[sig], t.id + ' differs from the other liveries');
    seen[sig] = 1;
    var h0 = F1.livery(TEAMS.buildFor(t.id, { seat: 0 })).helmet, h1 = F1.livery(TEAMS.buildFor(t.id, { seat: 1 })).helmet;
    assert.strictEqual(h0, t.drivers[0].helmet); assert.strictEqual(h1, t.drivers[1].helmet);
  });
});

test('f1car: CB.gl.car routes F1 builds to the F1 model; pose opens the DRS flap and tints the compound stripe', function () {
  var b = TEAMS.buildFor('williams');
  var desc = CAR.buildGeometry(b, { lod: 'high' });
  assert.ok(desc.f1 && desc.dims.f1 && desc.dims.length === 5.6, 'F1 geometry');
  assert.ok(desc.parts.some(function (p) { return p.stripe; }) && desc.parts.some(function (p) { return p.wing && p.wing.drs; }));
  assert.ok(!CAR.buildGeometry(globalThis.CB.data.defaultBuild(), { lod: 'high', shapes: false }).f1, 'road car not routed');
  var model = CAR.build(null, b, { lod: 'high', number: '28' });
  var st = {}, c = { x: 0, y: 0, heading: 0, speed: 60, endurance: { f1: { drs: { open: false }, compound: 'soft' } } };
  var items = CAR.pose(model, c, 0, st);
  var fi = items.findIndex(function (it) { return it.part.wing && it.part.wing.drs; });
  var closed = Array.prototype.slice.call(items[fi].model);
  c.endurance.f1.drs.open = true;
  for (var i = 0; i < 30; i++) items = CAR.pose(model, c, 1 / 60, st);
  var open = Array.prototype.slice.call(items[fi].model);
  assert.ok(Math.abs(Math.atan2(open[1], open[0]) - Math.atan2(closed[1], closed[0])) > 0.3, 'flap rotated open');
  var si = items.filter(function (it) { return it.part.stripe; });
  var soft = F1.compoundColor('soft');
  assert.ok(Math.abs(si[0].material.baseColor[0] - soft[0]) < 1e-6, 'soft = red stripe');
  c.endurance.f1.compound = 'hard';
  items = CAR.pose(model, c, 1 / 60, st);
  assert.ok(items.filter(function (it) { return it.part.stripe; })[0].material.baseColor[2] > 0.8, 'hard = white stripe');
  // other cars sharing the cached model keep their own stripe colour (per-pose-state material copies)
  var st2 = {}, items2 = CAR.pose(model, { x: 0, y: 0, heading: 0, endurance: { f1: { compound: 'inter' } } }, 0, st2);
  assert.notStrictEqual(items2.filter(function (it) { return it.part.stripe; })[0].material, si[0].material);
});

test('f1 cockpit: onboard layout + geometry build in Node (no NaN), heading wrap never loops on huge / non-finite headings', function () {
  var CK = require(path.join(root, 'js', 'race', 'gl', 'cockpit.js'));
  // the old while-loop wrap spun forever on these (frozen race in cockpit view)
  [1e20, -1e20, Infinity, -Infinity, NaN, 7, -7].forEach(function (h) {
    var w = CK.wrapPi(h);
    assert.ok(isFinite(w) && w >= -Math.PI - 1e-9 && w <= Math.PI + 1e-9, 'wrapPi(' + h + ') = ' + w);
  });
  TEAMS.ids.forEach(function (id) {
    var b = TEAMS.buildFor(id), g = F1.build(b, { lod: 'high' });
    var cb = CK.f1CockpitBuild(b);
    assert.ok(cb.f1 && cb.body.style === 'roadster' && b.body.style === 'hypercar', 'cockpit build is a copy');
    var L = CK.layout(cb, { eye: g.cockpitEye, dims: g.dims });
    CK.f1Layout(L, g.dims);
    assert.strictEqual(L.sideMirrors.length, 2);
    L.sideMirrors.forEach(function (m) { assert.ok(m.normal.every(isFinite) && m.pos.every(isFinite)); });
    assert.ok(L.wheel.c[0] > g.cockpitEye[0] && L.wheel.c[1] < g.cockpitEye[1], 'wheel ahead of / below the eye');
    var geo = CK.buildGeometry(cb, L, CK.palette(cb, {}));
    var W = geo.wheel, tris = 0;
    for (var k in W) {
      tris += W[k].tris();
      var P = W[k].P || W[k].p || [];
      for (var i = 0; i < P.length; i++) assert.ok(isFinite(P[i]), id + ' wheel ' + k + ' finite');
    }
    assert.ok(tris > 50, id + ' race wheel built');
    assert.ok(geo.hands.length === 2 && geo.panels.wheelDisplay, id + ' hands + wheel display');
  });
});

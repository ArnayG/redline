/* FORGE Atelier — CB.studio3d (js/studio3d.js): the Atelier's WebGL turntable of the low-poly car.
   Node has no WebGL, so these cover the API surface, the pure helpers (framing, view angles, x-ray layout,
   feature edges, geometry signatures, CSS colour parsing) and CB.render's hand-over contract (SVG fallback). */
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');
var ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'js', 'util.js'));
require(path.join(ROOT, 'js', 'data.js'));
var SH = require(path.join(ROOT, 'js', 'shapes', 'core.js'));
fs.readdirSync(path.join(ROOT, 'js', 'shapes', 'models')).filter(function (f) { return /\.js$/.test(f); }).sort()
  .forEach(function (f) { require(path.join(ROOT, 'js', 'shapes', 'models', f)); });
require(path.join(ROOT, 'js', 'race', 'gl', 'gl-core.js'));
var LP = require(path.join(ROOT, 'js', 'race', 'gl', 'lowpoly.js'));
var LPDIR = path.join(ROOT, 'js', 'shapes', 'lowpoly');
if (fs.existsSync(LPDIR)) fs.readdirSync(LPDIR).filter(function (f) { return /\.js$/.test(f); }).sort().forEach(function (f) { require(path.join(LPDIR, f)); });
var R = require(path.join(ROOT, 'js', 'render.js'));
var S3 = require(path.join(ROOT, 'js', 'studio3d.js'));
var D = globalThis.CB.data;
var _ = S3._;

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var test = standalone
  ? function (name, fn) { try { fn(); console.log('  ok   ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; } }
  : globalThis.test;

function buildFor(id, patch) {
  var b = D.defaultBuild(), m = SH.models[id];
  if (m) {
    var rb = SH.refBuild ? SH.refBuild(m) : null;
    if (rb) Object.keys(rb).forEach(function (k) { if (rb[k] && typeof rb[k] === 'object') { b[k] = b[k] || {}; for (var q in rb[k]) b[k][q] = rb[k][q]; } });
    b.body.style = m.style; b.body.model = id;
  }
  if (patch) Object.keys(patch).forEach(function (k) { b[k] = Object.assign({}, b[k] || {}, patch[k]); });
  return b;
}
function finite3(p) { return Array.isArray(p) && p.length === 3 && p.every(function (v) { return typeof v === 'number' && isFinite(v); }); }

test('studio3d: API surface and Node behaviour (no DOM -> no WebGL, mount is a no-op)', function () {
  ['isSupported', 'mount', 'update', 'setView', 'getView', 'setXray', 'isXray', 'setSpin', 'isSpinning', 'resetCamera', 'isMounted', 'destroy', 'stats']
    .forEach(function (k) { assert.strictEqual(typeof S3[k], 'function', k); });
  assert.strictEqual(globalThis.CB.studio3d, S3);
  assert.strictEqual(S3.isSupported(), false);
  assert.strictEqual(S3.mount({}), null);
  assert.strictEqual(S3.isMounted(), false);
  assert.deepStrictEqual(S3.stats(), { mounted: false });
  assert.doesNotThrow(function () { S3.update(D.defaultBuild()); S3.setView('front'); S3.setXray(true); S3.setSpin(true); S3.destroy(); });
});

test('studio3d: CB.render keeps its public API, stays SVG in Node and exposes mode / use3d', function () {
  ['mount', 'update', 'setView', 'toggleXray', 'snapshotSVG', 'thumbnail', 'markup', 'resolve', 'toggleSpin', 'mode', 'use3d']
    .forEach(function (k) { assert.strictEqual(typeof R[k], 'function', k); });
  assert.strictEqual(R.mount(null), null);
  assert.strictEqual(R.mode(), null);
  assert.strictEqual(R.use3d(), false, 'no DOM -> never 3D');
  var svg = R.snapshotSVG();
  assert.ok(/^<svg[\s>]/.test(svg.trim()) || /<svg/.test(svg), 'snapshot is still an SVG');
  assert.ok(/<svg/.test(R.thumbnail(buildFor('porsche-911-992'))), 'thumbnails stay SVG');
});

test('studio3d: views, shortest yaw and eased camera helpers', function () {
  _.VIEW_IDS.forEach(function (v) { var a = _.viewAngles(v); assert.ok(isFinite(a.yaw) && a.pitch >= 0 && a.pitch <= 89, v); });
  assert.deepStrictEqual(_.viewAngles('nope'), _.viewAngles('side'));
  assert.ok(_.viewAngles('top').pitch > 80);
  assert.strictEqual(_.viewAngles('front').yaw, 0);
  assert.strictEqual(Math.abs(_.viewAngles('rear').yaw), 180);
  assert.strictEqual(_.shortestYaw(170, -170), 20);
  assert.strictEqual(_.shortestYaw(-170, 170), -20);
  assert.strictEqual(_.shortestYaw(0, 180), 180);
  assert.strictEqual(_.shortestYaw(10, 10), 0);
  assert.strictEqual(_.shortestYaw(-90, 630), 0);
  assert.strictEqual(_.easeInOut(0), 0); assert.strictEqual(_.easeInOut(1), 1); assert.ok(Math.abs(_.easeInOut(0.5) - 0.5) < 1e-9);
});

test('studio3d: fitDistance frames bigger cars further away, narrower stages further away, never NaN', function () {
  var fov = 27 * Math.PI / 180;
  var small = _.fitDistance({ length: 3.9, width: 1.73, height: 1.24 }, 3, fov, 8);
  var big = _.fitDistance({ length: 5.9, width: 2.03, height: 2.0 }, 3, fov, 8);
  assert.ok(small > 3 && big > small, small + ' < ' + big);
  assert.ok(_.fitDistance({ length: 4.5, width: 1.9, height: 1.3 }, 1.4, fov, 8) > _.fitDistance({ length: 4.5, width: 1.9, height: 1.3 }, 3, fov, 8));
  [0, 5, 45, 88, 90].forEach(function (p) { var d = _.fitDistance({ length: 4.5, width: 1.9, height: 1.3 }, 2.6, fov, p); assert.ok(isFinite(d) && d > 0, 'pitch ' + p); });
  assert.ok(isFinite(_.fitDistance(null, NaN, NaN, NaN)));
  // the turntable never breathes: distance is yaw independent by construction (no yaw argument)
  assert.strictEqual(_.fitDistance.length, 4);
});

test('studio3d: CSS colour parsing for the theme tokens', function () {
  assert.deepStrictEqual(_.parseCssColor('#fff'), [1, 1, 1, 1]);
  assert.deepStrictEqual(_.parseCssColor(' #000000 '), [0, 0, 0, 1]);
  var c = _.parseCssColor('rgba(201, 165, 107, .13)');
  assert.ok(Math.abs(c[0] - 201 / 255) < 1e-9 && Math.abs(c[3] - 0.13) < 1e-9);
  assert.deepStrictEqual(_.parseCssColor('rgb(255 0 0)'), [1, 0, 0, 1]);
  assert.deepStrictEqual(_.parseCssColor('transparent'), [0, 0, 0, 0]);
  assert.strictEqual(_.parseCssColor(''), null);
  assert.strictEqual(_.parseCssColor('var(--x)'), null);
  ['dark', 'light'].forEach(function (t) { var P = _.xrPal(t); ['line', 'soft', 'eng', 'bat', 'mot', 'fuel', 'hot', 'text', 'cg'].forEach(function (k) { assert.ok(_.parseCssColor(P[k]), t + ' ' + k); }); });
});

test('studio3d: featureEdges of a box are its 12 edges; a low-poly car yields far fewer lines than triangle edges', function () {
  var g = globalThis.CB.gl.geometry.box(1, 1, 1);
  var E = _.featureEdges(g.positions, g.indices);
  assert.strictEqual(E.length, 12 * 6);
  for (var i = 0; i < E.length; i++) assert.ok(Math.abs(Math.abs(E[i]) - 0.5) < 1e-6, 'edge endpoints on the cube corners');
  // unindexed (flat shaded) input gives the same edges
  var flat = globalThis.CB.gl.geometry.toNonIndexed(g);
  assert.strictEqual(_.featureEdges(flat.positions, null).length, 12 * 6);
  var r = LP.build(buildFor('porsche-911-992'), { lod: 'high' });
  var body = r.parts.filter(function (p) { return p.kind === 'body'; })[0];
  var E2 = _.featureEdges(body.positions, body.indices);
  var triEdges = body.indices.length;   // 3 per triangle
  assert.ok(E2.length > 0 && E2.length / 6 < triEdges, E2.length / 6 + ' vs ' + triEdges);
  assert.ok(Array.prototype.every.call(E2, isFinite));
  assert.strictEqual(_.featureEdges(null).length, 0);
});

test('studio3d: geomSig / buildKey change with paint, wheels and ride height, stay put for identical builds', function () {
  var b0 = buildFor('bmw-m3-g80') || buildFor('porsche-911-992');
  var id = b0.body.model;
  var s0 = _.geomSig(LP.build(b0, { lod: 'high' }));
  assert.strictEqual(_.geomSig(LP.build(buildFor(id), { lod: 'high' })), s0, 'deterministic');
  var b1 = buildFor(id, { exterior: { paint: '#1f4fd1' } });
  assert.notStrictEqual(_.geomSig(LP.build(b1, { lod: 'high' })), s0, 'paint');
  var b2 = buildFor(id, { suspension: { rideHeight_mm: num(b0.suspension.rideHeight_mm, 120) - 40 } });
  assert.notStrictEqual(_.geomSig(LP.build(b2, { lod: 'high' })), s0, 'ride height');
  var b3 = buildFor(id, { aero: { wing: 'gt-wing' } });
  assert.notStrictEqual(_.geomSig(LP.build(b3, { lod: 'high' })), s0, 'aero');
  assert.strictEqual(_.geomSig(null), '');
  var k0 = _.buildKey(b0), bm = buildFor(id); bm.meta = { name: 'renamed' };
  assert.strictEqual(_.buildKey(bm), _.buildKey(Object.assign({}, b0, { meta: { name: 'x' } })), 'meta ignored');
  assert.notStrictEqual(_.buildKey(b1), k0);
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
});

test('studio3d: x-ray layout (ICE front / mid / rear, EV, hybrid) stays inside every shipped car', function () {
  var variants = [
    { engine: { type: 'ice', position: 'front', layout: 'V8', aspiration: 'twin-turbo' }, drivetrain: { layout: 'rwd' } },
    { engine: { type: 'ice', position: 'front', layout: 'I4', aspiration: 'turbo' }, drivetrain: { layout: 'fwd' } },
    { engine: { type: 'ice', position: 'mid', layout: 'V10' }, drivetrain: { layout: 'awd' } },
    { engine: { type: 'ice', position: 'rear', layout: 'F6', aspiration: 'twin-turbo' }, drivetrain: { layout: 'rwd' } },
    { engine: { type: 'ev', motors: 3, battery_kwh: 100 }, drivetrain: { layout: 'awd' } },
    { engine: { type: 'hybrid', position: 'front', layout: 'V6' }, drivetrain: { layout: 'awd' } }
  ];
  var ids = SH.list().map(function (m) { return m.id; });
  var checked = 0;
  ids.forEach(function (id, ix) {
    var r = LP.build(buildFor(id), { lod: 'high' }), dm = r.dims;
    variants.forEach(function (v, vi) {
      if ((ix + vi) % 3) return;          // a deterministic third of the matrix keeps the suite quick
      var b = buildFor(id, v), spec = R.resolve(b, null), lay = _.xrayLayout(dm, spec);
      assert.ok(lay.blocks.length >= 5, id + ' blocks');
      lay.blocks.forEach(function (bl) {
        var pts = bl.shape === 'rod' ? [bl.p0, bl.p1] : [bl.c];
        pts.forEach(function (p) {
          assert.ok(finite3(p), id + ' ' + bl.shape + ' finite');
          assert.ok(Math.abs(p[0]) <= dm.length / 2 + 0.05, id + ' v' + vi + ' ' + bl.tone + ' x ' + p[0]);
          assert.ok(p[1] >= 0 && p[1] <= dm.height + 0.05, id + ' v' + vi + ' ' + bl.tone + ' y ' + p[1]);
          assert.ok(Math.abs(p[2]) <= dm.width / 2 + 0.05, id + ' v' + vi + ' ' + bl.tone + ' z ' + p[2]);
        });
        if (bl.s) bl.s.forEach(function (s) { assert.ok(s > 0 && isFinite(s), id + ' size'); });
        assert.ok(_.xrPal('dark')[bl.tone], 'tone ' + bl.tone);
      });
      assert.ok(finite3(lay.cg) && lay.cg[0] < dm.frontAxle && lay.cg[0] > dm.rearAxle, id + ' CG between the axles');
      assert.ok(lay.labels.some(function (l) { return /^CG \d+ mm$/.test(l.text); }), 'CG label');
      assert.ok(lay.labels.some(function (l) { return /^F \d+\.\d%/.test(l.text); }) && lay.labels.some(function (l) { return /^R \d+\.\d%/.test(l.text); }), 'weight split labels');
      lay.labels.forEach(function (l) { assert.ok(finite3(l.p) && l.text && !/NaN|undefined/.test(l.text), id + ' label ' + l.text); });
      if (spec.d.engType === 'ev') assert.ok(lay.labels.some(function (l) { return /kWh/.test(l.text); }), 'EV battery label');
      else assert.ok(lay.labels.some(function (l) { return / L /.test(l.text); }), 'engine label');
      checked++;
    });
  });
  assert.ok(checked >= ids.length, 'checked ' + checked);
  // the x-ray degrades gracefully without a spec
  var lay0 = _.xrayLayout(null, null);
  assert.ok(lay0.blocks.length > 0 && finite3(lay0.cg));
});

test('studio3d: wheelLocal matches the CB.gl.car convention (translation, spin about the axle)', function () {
  var m = new Float32Array(16);
  _.wheelLocal(m, 1.2, 0.33, -0.8, 0, Math.PI / 2);
  assert.ok(Math.abs(m[12] - 1.2) < 1e-6 && Math.abs(m[13] - 0.33) < 1e-6 && Math.abs(m[14] + 0.8) < 1e-6);
  // spin rotates x into y about z (the axle), leaves z alone
  assert.ok(Math.abs(m[0]) < 1e-6 && Math.abs(m[1] - 1) < 1e-6 && Math.abs(m[10] - 1) < 1e-6);
  _.wheelLocal(m, 0, 0, 0, 0.05, 0);
  var det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  assert.ok(Math.abs(det - 1) < 1e-6, 'rigid');
});

test('studio3d: index.html / render.js wiring keeps the SVG fallback reachable', function () {
  var src = fs.readFileSync(path.join(ROOT, 'js', 'render.js'), 'utf8');
  assert.ok(/CB\.studio3d\.mount\(/.test(src), 'render.js hands the viewer to studio3d');
  assert.ok(/fallbackToSvg/.test(src), 'and falls back to SVG');
  var s3 = fs.readFileSync(path.join(ROOT, 'js', 'studio3d.js'), 'utf8');
  assert.ok(/prefers-reduced-motion/.test(s3) && /IntersectionObserver/.test(s3) && /visibilitychange/.test(s3), 'reduced motion + pause when hidden');
  assert.ok(/low-power/.test(s3), 'low-power GPU preference');
});

test('studio3d: orientation — Side shows the nose on the LEFT (like the SVG), Front looks at the nose, no mirroring', function () {
  var M4 = globalThis.CB.gl.mat4, DEG = Math.PI / 180;
  function viewOf(v) {
    var a = _.viewAngles(v), y = a.yaw * DEG, p = a.pitch * DEG, R = 10;
    var eye = [Math.cos(y) * Math.cos(p) * R, Math.sin(p) * R + 0.6, Math.sin(y) * Math.cos(p) * R];
    var m = M4.create(); M4.lookAt(m, eye, [0, 0.6, 0], [0, 1, 0]);
    return { m: m, eye: eye };
  }
  // CB.lowpoly frame: +x = front bumper (front axle / headlights at +x)
  var r = LP.build(buildFor('porsche-911-992'), { lod: 'high' });
  assert.ok(r.dims.frontAxle > 0 && r.anchors.headlights[0][0] > 0, '+x is the nose');
  var side = viewOf('side').m;
  // view-space x of the nose point: negative = left of screen centre
  assert.ok(side[0] * r.anchors.headlights[0][0] + side[12] < 0, 'nose left in Side');
  assert.ok(viewOf('front').eye[0] > 5 && viewOf('rear').eye[0] < -5, 'Front camera ahead of the car, Rear behind');
  // a rotation-only view: det(+1) -> the car is never mirrored
  var d = side[0] * (side[5] * side[10] - side[6] * side[9]) - side[4] * (side[1] * side[10] - side[2] * side[9]) + side[8] * (side[1] * side[6] - side[2] * side[5]);
  assert.ok(Math.abs(d - 1) < 1e-5, 'no mirror');
  assert.strictEqual(typeof S3.setCamera, 'function');
  assert.strictEqual(S3.setCamera({ yaw: 42 }), null, 'no-op without a mount');
});

test('studio3d: orbit state — turntable / drag off the preset view is not labelled "Side"', function () {
  var O = S3._.isOrbiting, side = S3._.viewAngles('side'), front = S3._.viewAngles('front');
  assert.strictEqual(O({ yaw: side.yaw, pitch: side.pitch }, 'side', false), false, 'parked on the view');
  assert.strictEqual(O({ yaw: side.yaw + 2, pitch: side.pitch - 1 }, 'side', false), false, 'within tolerance');
  assert.strictEqual(O({ yaw: side.yaw + 25, pitch: side.pitch }, 'side', false), true, 'turntable moved it');
  assert.strictEqual(O({ yaw: side.yaw, pitch: side.pitch + 20 }, 'side', false), true, 'user tilted it');
  assert.strictEqual(O({ yaw: side.yaw + 90, pitch: side.pitch }, 'front', true), false, 'tweening to a view counts as on-view');
  assert.strictEqual(O({ yaw: front.yaw + 360, pitch: front.pitch }, 'front', false), false, 'yaw wraps');
  assert.strictEqual(typeof S3.isOrbiting, 'function');
  assert.strictEqual(S3.isOrbiting(), false, 'false without a mount');
});

test('studio3d: x-ray label declutter never overlaps, keeps every label it can and stays on the stage', function () {
  var boxes = [{ x: 200, y: 100, w: 120, h: 16 }, { x: 210, y: 104, w: 90, h: 16 }, { x: 205, y: 98, w: 60, h: 16 }, null, { x: 600, y: 100, w: 80, h: 16 }, { x: -50, y: 5, w: 80, h: 16 }];
  var out = _.declutter(boxes, 640, 300);
  assert.strictEqual(out.length, boxes.length);
  assert.strictEqual(out[3], null);
  var placed = out.filter(Boolean);
  assert.ok(placed.length >= 5, 'crowded labels are nudged, not dropped');
  for (var i = 0; i < placed.length; i++) {
    var a = placed[i];
    assert.ok(a.x - a.w / 2 >= 0 && a.x + a.w / 2 <= 640 && a.y - a.h >= 0 && a.y <= 300, 'inside the stage');
    for (var j = i + 1; j < placed.length; j++) {
      var b = placed[j];
      var ox = Math.abs(a.x - b.x) * 2 < a.w + b.w, oy = Math.abs((a.y - a.h / 2) - (b.y - b.h / 2)) * 2 < a.h + b.h;
      assert.ok(!(ox && oy), 'labels ' + i + ' / ' + j + ' overlap');
    }
  }
  assert.deepStrictEqual(_.declutter(null, 1, 1), []);
});

test('studio3d: the stage supersamples 1x screens to 2x and caps big viewports by a pixel budget', function () {
  assert.strictEqual(_.stageDpr(800, 330, 1), 2, '1x desktop renders at 2x');
  assert.strictEqual(_.stageDpr(390, 280, 3), 2, '3x phone capped at 2x');
  var big = _.stageDpr(2400, 1300, 1);
  assert.ok(big >= 1 && big < 2 && 2400 * 1300 * big * big <= 3.21e6, 'big stage within the budget');
  assert.ok(isFinite(_.stageDpr(0, 0, NaN)));
});

test('studio3d: the Garage car is the race car, vertex for vertex (CB.lowpoly.build == CB.gl.car.buildGeometry)', function () {
  var CM;
  try { CM = require(path.join(ROOT, 'js', 'race', 'gl', 'car-mesh.js')); } catch (e) { CM = null; }
  if (!CM || typeof CM.buildGeometry !== 'function') return;
  ['porsche-911-992', 'bmw-m4-g82', 'ford-f150-raptor-gen3'].forEach(function (id) {
    var b = buildFor(id, { exterior: { paint: '#c8102e' } });
    var r = LP.build(b, { lod: 'high' }), d = CM.buildGeometry(b, { lod: 'high', isPlayer: true });
    assert.ok(r && d, id + ' builds in both paths');
    if (!d.lowpoly) return;   // another suite switched CB.gl.car to the detailed loft (graphics.carStyle) in this process
    assert.strictEqual(r.parts.length, d.parts.length, id + ' part count');
    r.parts.forEach(function (p, i) {
      var q = d.parts[i].geo.p;
      assert.strictEqual(p.positions.length, q.length, id + ' part ' + i + ' vertex count');
      var md = 0;
      for (var k = 0; k < q.length; k++) md = Math.max(md, Math.abs(p.positions[k] - q[k]));
      assert.ok(md < 1e-6, id + ' part ' + i + ' (' + p.kind + ') same shape, max diff ' + md);
    });
  });
});

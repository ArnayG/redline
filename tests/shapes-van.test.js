/* Node tests for js/shapes/models/van.js — run: node tests/run.js shapes-van */
'use strict';
var path = require('path');
var fs = require('fs');
var ROOT = path.join(__dirname, '..');
var CB = (globalThis.CB = globalThis.CB || {});
CB.shapes = CB.shapes || {};
var models = require(path.join(ROOT, 'js', 'shapes', 'models', 'van.js'));

var IDS = ['mercedes-sprinter-vs30', 'vw-id-buzz', 'ford-transit-hr'];

/* ---- geometry helpers (independent of core.js) ---- */
function isPath(p) { return Array.isArray(p) && p.length > 0 && p[0] && typeof p[0].t === 'string'; }
function eachPath(obj, fn, where) {
  if (!obj || typeof obj !== 'object') return;
  if (isPath(obj)) { fn(obj, where); return; }
  if (Array.isArray(obj)) { obj.forEach(function (o, i) { eachPath(o, fn, where + '[' + i + ']'); }); return; }
  Object.keys(obj).forEach(function (k) { eachPath(obj[k], fn, where + '.' + k); });
}
/* sampled bounds of a path (curves evaluated, not control hulls) */
function bounds(p) {
  var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, cur = null, start = null;
  function add(q) { b.minX = Math.min(b.minX, q[0]); b.maxX = Math.max(b.maxX, q[0]); b.minY = Math.min(b.minY, q[1]); b.maxY = Math.max(b.maxY, q[1]); }
  p.forEach(function (s) {
    if (s.t === 'M') { cur = start = s.p[0]; add(cur); }
    else if (s.t === 'L') { cur = s.p[0]; add(cur); }
    else if (s.t === 'C' || s.t === 'Q') {
      for (var i = 1; i <= 24; i++) {
        var t = i / 24, u = 1 - t, q;
        if (s.t === 'C') q = [0, 1].map(function (k) { return u * u * u * cur[k] + 3 * u * u * t * s.p[0][k] + 3 * u * t * t * s.p[1][k] + t * t * t * s.p[2][k]; });
        else q = [0, 1].map(function (k) { return u * u * cur[k] + 2 * u * t * s.p[0][k] + t * t * s.p[1][k]; });
        add(q);
      }
      cur = s.p[s.p.length - 1];
    } else if (s.t === 'Z') { cur = start; }
  });
  return b;
}
function union(list) {
  var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  list.forEach(function (p) { var c = bounds(p); b.minX = Math.min(b.minX, c.minX); b.maxX = Math.max(b.maxX, c.maxX); b.minY = Math.min(b.minY, c.minY); b.maxY = Math.max(b.maxY, c.maxY); });
  return b;
}
function tireRadius(spec) {
  var m = /^(\d+)\/(\d+)Z?R(\d+)/.exec(spec);
  return (Number(m[3]) * 25.4 / 2 + Number(m[1]) * Number(m[2]) / 100) / 1000;
}
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, msg + ': ' + a.toFixed(4) + ' vs ' + b.toFixed(4) + ' (tol ' + tol.toFixed(4) + ')'); }
function byId(id) { return models.filter(function (m) { return m.id === id; })[0]; }

test('shapes-van: file exports and registers the three real vans', function () {
  assert.ok(Array.isArray(models));
  assert.deepEqual(models.map(function (m) { return m.id; }).sort(), IDS.slice().sort());
  var registered = (CB.shapes.models && Object.keys(CB.shapes.models)) || [];
  var pending = Array.isArray(CB.shapes._pending) ? CB.shapes._pending.map(function (m) { return m.id; }) : [];
  IDS.forEach(function (id) { assert.ok(registered.indexOf(id) >= 0 || pending.indexOf(id) >= 0, id + ' registered or pending'); });
  models.forEach(function (m) {
    assert.equal(m.style, 'van');
    ['make', 'name', 'gen', 'years', 'enginePosition', 'powertrain'].forEach(function (k) { assert.equal(typeof m[k], 'string', m.id + '.' + k); });
    ['headlights', 'taillights', 'grille', 'notes'].forEach(function (k) { assert.ok(m.signature[k].length > 20, m.id + ' signature.' + k); });
  });
  assert.equal(byId('vw-id-buzz').powertrain, 'ev');
  assert.equal(byId('vw-id-buzz').enginePosition, 'rear');
});

test('shapes-van: ref figures are complete and self-consistent', function () {
  models.forEach(function (m) {
    var r = m.ref;
    ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR', 'frontOverhang', 'rearOverhang', 'wheelDiameter_in',
      'groundClearance', 'rideHeight', 'cd', 'curbWeight_kg'].forEach(function (k) { assert.ok(Number.isFinite(r[k]) && r[k] > 0, m.id + ' ref.' + k); });
    near(r.wheelbase + r.frontOverhang + r.rearOverhang, r.length, 0.002, m.id + ' wb + overhangs = length');
    assert.ok(r.trackF < r.width && r.trackR < r.width, m.id + ' tracks inside width');
    assert.equal(Number(/R(\d+)/.exec(r.tireF)[1]), r.wheelDiameter_in, m.id + ' tyre rim matches wheel');
  });
});

test('shapes-van: every path is well-formed with finite coordinates', function () {
  var arity = { M: 1, L: 1, C: 3, Q: 2, Z: 0 };
  models.forEach(function (m) {
    var n = 0;
    eachPath(m, function (p, where) {
      n++;
      assert.equal(p[0].t, 'M', m.id + where + ' starts with M');
      p.forEach(function (s) {
        assert.ok(s.t in arity, m.id + where + ' segment type ' + s.t);
        assert.equal(s.p.length, arity[s.t], m.id + where + ' arity ' + s.t);
        s.p.forEach(function (q) { assert.ok(q.length === 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]), m.id + where + ' finite'); });
      });
    }, '');
    assert.ok(n > 60, m.id + ' has a rich set of paths (' + n + ')');
    m.details.forEach(function (d, i) {
      assert.ok(['side', 'top', 'front', 'rear'].indexOf(d.view) >= 0, m.id + ' detail ' + i + ' view');
      assert.ok(typeof d.role === 'string' && typeof d.paint === 'string', m.id + ' detail ' + i + ' role/paint');
    });
  });
});

test('shapes-van: side silhouette matches real length, height and overhangs (within 1%)', function () {
  models.forEach(function (m) {
    var r = m.ref, b = bounds(m.side.body);
    near(b.maxX - b.minX, r.length, r.length * 0.01, m.id + ' side length');
    near(b.maxY, r.height, r.height * 0.01, m.id + ' side height');
    near(b.maxX, r.wheelbase / 2 + r.frontOverhang, r.length * 0.01, m.id + ' front bumper x');
    near(b.minX, -(r.wheelbase / 2 + r.rearOverhang), r.length * 0.01, m.id + ' rear bumper x');
    assert.ok(b.minY > 0.1 && b.minY < 0.6, m.id + ' body clears the ground: ' + b.minY);
    var gh = bounds(m.side.greenhouse);
    assert.ok(gh.maxY < r.height && gh.minX > b.minX && gh.maxX < b.maxX, m.id + ' greenhouse inside body');
  });
});

test('shapes-van: wheel arches centred on the axles and sized for the real tyres', function () {
  models.forEach(function (m) {
    var r = m.ref, half = r.wheelbase / 2;
    [['archF', r.tireF, half], ['archR', r.tireR, -half]].forEach(function (a) {
      var arch = m.side[a[0]], tr = tireRadius(a[1]);
      near(arch.x, a[2], 0.005, m.id + ' ' + a[0] + ' x on axle');
      near(arch.y, tr, 0.01, m.id + ' ' + a[0] + ' centre at wheel-centre height');
      assert.ok(arch.r > tr * 1.03 && arch.r < tr * 1.25, m.id + ' ' + a[0] + ' radius ' + arch.r + ' fits tyre r ' + tr.toFixed(3));
      assert.ok(arch.flare >= 0 && arch.flare < 0.08, m.id + ' flare');
    });
    // the silhouette really has openings over the wheels: no body below arch top at the axle
    var b = bounds(m.side.body);
    assert.ok(b.minY < m.side.archF.y + m.side.archF.r, m.id + ' arch cut present');
  });
});

test('shapes-van: plan view width matches ref.width and is symmetric', function () {
  models.forEach(function (m) {
    var r = m.ref, b = bounds(m.top.body);
    near(b.maxY - b.minY, r.width, r.width * 0.01, m.id + ' top width');
    near(b.maxY, -b.minY, 0.002, m.id + ' top symmetric');
    near(b.maxX - b.minX, r.length, r.length * 0.01, m.id + ' top length');
    var mir = union(m.top.mirrors);
    assert.ok(mir.maxY > r.width / 2 && mir.maxY < r.width / 2 + 0.25, m.id + ' mirrors stick out');
    near(mir.maxY, -mir.minY, 0.002, m.id + ' mirrors symmetric');
  });
});

test('shapes-van: front and rear views are symmetric about z = 0 and match width/height', function () {
  models.forEach(function (m) {
    var r = m.ref;
    ['front', 'rear'].forEach(function (v) {
      var view = m[v], b = bounds(view.body);
      near(b.maxX, -b.minX, 0.002, m.id + ' ' + v + ' body symmetric');
      near(b.maxX - b.minX, r.width, r.width * 0.01, m.id + ' ' + v + ' width');
      near(b.maxY, r.height, r.height * 0.01, m.id + ' ' + v + ' height');
      var all = [];
      eachPath(view, function (p) { all.push(p); }, '');
      m.details.filter(function (d) { return d.view === v; }).forEach(function (d) { all.push(d.path); });
      var u = union(all);
      near(u.maxX, -u.minX, 0.003, m.id + ' ' + v + ' all features symmetric');
      var lamps = v === 'front' ? view.headlights : view.taillights;
      assert.equal(lamps.length % 2, 0, m.id + ' paired lamps');
      var l0 = bounds(lamps[0]), l1 = bounds(lamps[1]);
      near(l0.maxX, -l1.minX, 0.002, m.id + ' ' + v + ' lamp pair mirrored');
      near(l0.maxY, l1.maxY, 0.002, m.id + ' ' + v + ' lamp pair level');
    });
    m.rear.exhaust.forEach(function (e) { ['cx', 'cy', 'w', 'h'].forEach(function (k) { assert.ok(Number.isFinite(e[k])); }); });
  });
  assert.equal(byId('vw-id-buzz').rear.exhaust.length, 0, 'EV has no tailpipes');
});

test('shapes-van: core.js fit() and toSvgPath() work on the vans (when core is present)', function () {
  var corePath = path.join(ROOT, 'js', 'shapes', 'core.js');
  if (!fs.existsSync(corePath)) return; // core written in parallel by another team
  require(corePath);
  var S = CB.shapes;
  if (typeof S.fit !== 'function' || typeof S.toSvgPath !== 'function') return;
  IDS.forEach(function (id) { assert.ok(S.models[id], id + ' in CB.shapes.models after core drained _pending'); });
  assert.ok(S.modelsByStyle('van').length >= 3);
  models.forEach(function (m) {
    var build = typeof S.refBuild === 'function' ? S.refBuild(m) :
      { body: { style: 'van', model: m.id, wheelbase_mm: Math.round(m.ref.wheelbase * 1000), trackWidth_mm: Math.round((m.ref.trackF + m.ref.trackR) / 2 * 1000) },
        suspension: { rideHeight_mm: Math.round(m.ref.rideHeight * 1000) } };
    assert.equal(S.getModel(build).id, m.id);
    var f = S.fit(m, build);
    assert.ok(f && f.dims, m.id + ' fit dims');
    Object.keys(f.dims).forEach(function (k) { if (typeof f.dims[k] === 'number') assert.ok(Number.isFinite(f.dims[k]), m.id + ' dims.' + k); });
    near(f.dims.length, m.ref.length, 0.01, m.id + ' fit at ref keeps length');
    near(f.dims.wheelbase, m.ref.wheelbase, 0.005, m.id + ' fit at ref keeps wheelbase');
    var fb = bounds(f.side.body);
    near(fb.maxX - fb.minX, m.ref.length, m.ref.length * 0.01, m.id + ' fitted side length');
    var d = S.toSvgPath(f.side.body, { scale: 100, flipY: true, ox: 0, oy: 0 });
    assert.ok(typeof d === 'string' && /^M/.test(d.trim()) && !/NaN|undefined/.test(d), m.id + ' svg path');
    // the configurator default van build (3.3 m wheelbase) stretches between the axles only
    var g = S.fit(m, { body: { style: 'van', model: m.id, wheelbase_mm: 3300, trackWidth_mm: 1660 }, suspension: { rideHeight_mm: 150 } });
    near(g.dims.wheelbase, 3.3, 0.005, m.id + ' fitted wheelbase');
    near(g.side.archF.x - g.side.archR.x, 3.3, 0.01, m.id + ' fitted arches on axles');
    if (typeof S.sectionsFromViews === 'function' && typeof S.loftToMesh === 'function') {
      var mesh = S.loftToMesh(S.sectionsFromViews(f, { stations: 48, ringVerts: 32 }));
      assert.ok(mesh.positions.length > 300 && mesh.indices.length > 300, m.id + ' mesh built');
      for (var i = 0; i < mesh.positions.length; i++) assert.ok(Number.isFinite(mesh.positions[i]), m.id + ' finite mesh');
    }
  });
});

test('shapes-van: Sprinter and Transit read differently (grille, slats, bumper, roof cap) and sections are slab-sided', function () {
  var sp = byId('mercedes-sprinter-vs30'), tr = byId('ford-transit-hr'), bz = byId('vw-id-buzz');
  var gs = bounds(sp.front.grille[0]), gt = bounds(tr.front.grille[0]);
  near(gs.maxX, 0.56, 0.01, 'Sprinter grille top half-width');
  near(gt.maxX, 0.72, 0.01, 'Transit grille top half-width');
  assert.ok(gt.maxY - gt.minY > gs.maxY - gs.minY + 0.1, 'Transit grille much taller');
  function chrome(m) { return m.details.filter(function (d) { return d.view === 'front' && d.paint === 'chrome' && d.role === 'trim'; }); }
  var spY = {}; chrome(sp).forEach(function (d) { var b = bounds(d.path); spY[((b.minY + b.maxY) / 2).toFixed(2)] = 1; });
  assert.equal(Object.keys(spY).length, 2, 'Sprinter has two slat rows');
  assert.equal(chrome(tr).length, 3, 'Transit has three chrome bars');
  assert.equal(tr.front.bumper.paint, 'black', 'Transit front bumper is black');
  assert.equal(sp.rear.bumper.paint, 'black', 'Sprinter rear step bumper is black');
  // Transit brow leans forward of the screen header; Sprinter dome recedes
  var tb = bounds(tr.side.body), sb = bounds(sp.side.body);
  assert.ok(tb.maxY > sb.maxY, 'Transit high roof is taller');
  assert.ok(bounds(tr.top.roof).maxY < 0.9 && bounds(tr.top.body).maxY > 1.03, 'Transit roof cap narrower than body');
  // ID. Buzz front door shut line drops near-vertically from the A-pillar base
  var dc = bz.side.doorCuts[0];
  var pts = []; dc.forEach(function (s) { if (s.p.length) pts.push(s.p[s.p.length - 1]); });
  var hi = pts.filter(function (q) { return Math.abs(q[1] - 1.205) < 0.002; })[0], lo = pts.filter(function (q) { return Math.abs(q[1] - 0.86) < 0.002; })[0];
  assert.ok(hi && lo && Math.abs(hi[0] - lo[0]) < 0.04, 'ID. Buzz door line near vertical');
  // explicit half-ring sections: flat slab sides (within 0.02 m) in the mid-body
  models.forEach(function (m) {
    assert.ok(Array.isArray(m.sections) && m.sections.length >= 20, m.id + ' explicit sections');
    var mid = m.sections.filter(function (s) { return Math.abs(s.x) < 0.3; })[0];
    assert.ok(mid && mid.ringHalf, m.id + ' mid section');
    var zMax = Math.max.apply(null, mid.ring.map(function (q) { return q[1]; }));
    var yMin = Math.min.apply(null, mid.ring.map(function (q) { return q[0]; }));
    // the outer wall is a straight vertical run at full half-width from just above the rocker to the belt
    var wall = mid.ring.filter(function (q) { return zMax - q[1] <= 0.02; }).map(function (q) { return q[0]; });
    assert.ok(mid.belt != null, m.id + ' mid section has side glass');
    assert.ok(Math.min.apply(null, wall) < yMin + 0.12, m.id + ' slab starts near the rocker');
    assert.ok(Math.max.apply(null, wall) > mid.belt - 0.01, m.id + ' slab runs up to the belt');
  });
});

/* sampled side-body top at x (max y over all crossings of the outline) */
function sideTopAt(path, x) {
  var pts = [], cur = null, st = null;
  path.forEach(function (s) {
    if (s.t === 'M') { cur = st = s.p[0]; pts.push(cur); }
    else if (s.t === 'L') { cur = s.p[0]; pts.push(cur); }
    else if (s.t === 'C') { for (var i = 1; i <= 24; i++) { var t = i / 24, u = 1 - t;
      pts.push([0, 1].map(function (k) { return u * u * u * cur[k] + 3 * u * u * t * s.p[0][k] + 3 * u * t * t * s.p[1][k] + t * t * t * s.p[2][k]; })); }
      cur = s.p[2]; }
    else if (s.t === 'Z' && st) pts.push(st);
  });
  var hi = -Infinity;
  for (var i = 0; i + 1 < pts.length; i++) { var a = pts[i], b = pts[i + 1];
    if ((a[0] - x) * (b[0] - x) > 0 || a[0] === b[0]) continue;
    hi = Math.max(hi, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])); }
  return hi;
}

test('shapes-van: Transit high roof is flat (side outline and 3D sections), not a wedge', function () {
  var tr = byId('ford-transit-hr');
  [0.4, 0, -1, -2.5].forEach(function (x) {
    assert.ok(sideTopAt(tr.side.body, x) >= 2.78, 'Transit side roof at x ' + x + ' = ' + sideTopAt(tr.side.body, x).toFixed(3));
  });
  tr.sections.filter(function (s) { return s.x < 0.8 && s.x > -2.9; }).forEach(function (s) {
    var top = Math.max.apply(null, s.ring.map(function (q) { return q[0]; }));
    assert.ok(top >= 2.78, 'Transit section roof at x ' + s.x + ' = ' + top.toFixed(3));
  });
});

test('shapes-van: ID. Buzz cowl, nose plan, roof band, lamps and V-face', function () {
  var bz = byId('vw-id-buzz');
  function sec(x) { return bz.sections.reduce(function (b, s) { return Math.abs(s.x - x) < Math.abs(b.x - x) ? s : b; }); }
  function top(s) { return Math.max.apply(null, s.ring.map(function (q) { return q[0]; })); }
  function hw(s) { return Math.max.apply(null, s.ring.map(function (q) { return q[1]; })); }
  // cowl: section tops fall smoothly from the screen base onto the lid (no step)
  var lid = bz.sections.filter(function (s) { return s.x > 1.70 && s.x < 2.12; });
  for (var i = 1; i < lid.length; i++) {
    var drop = top(lid[i - 1]) - top(lid[i]), dx = lid[i].x - lid[i - 1].x;
    assert.ok(drop / dx < 0.85, 'Buzz cowl slope at x ' + lid[i].x + ' = ' + (drop / dx).toFixed(2));
  }
  near(top(sec(1.92)), 1.165, 0.015, 'Buzz cowl height at 1.92');
  // plan view curves in towards the nose
  near(hw(sec(1.96)), 0.97, 0.015, 'Buzz half-width at 1.96');
  near(hw(sec(2.11)), 0.90, 0.02, 'Buzz half-width at 2.11');
  near(hw(sec(2.24)), 0.78, 0.03, 'Buzz half-width at 2.24');
  // ~0.10 m roof band above the side glass
  var gt = bounds(bz.side.greenhouse).maxY;
  assert.ok(bz.ref.height - gt >= 0.09, 'Buzz roof band above DLO ' + (bz.ref.height - gt).toFixed(3));
  var mid = sec(0);
  assert.ok(mid.glassTop <= 1.845, 'Buzz section glassTop lowered');
  // headlamps ~0.17 tall
  var hl = bounds(bz.front.headlights[0]);
  assert.ok(hl.maxY - hl.minY >= 0.155, 'Buzz headlamp height ' + (hl.maxY - hl.minY).toFixed(3));
  // V-face drawn as a solid panel line down to the apex at y 0.70
  assert.ok(Array.isArray(bz.front.panelLines) && bz.front.panelLines.length >= 1, 'Buzz V panel line');
  near(bounds(bz.front.panelLines[0]).minY, 0.70, 0.01, 'V apex');
  assert.equal(bz.defaultStyle.roof, 'contrast');
});

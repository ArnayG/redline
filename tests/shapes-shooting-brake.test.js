/* Node tests for js/shapes/models/shooting-brake.js — run: node tests/run.js shooting-brake */
'use strict';
var path = require('path');
var root = path.join(__dirname, '..', 'js', 'shapes');

// Load the model file with no core present: models must queue on CB.shapes._pending.
globalThis.CB = globalThis.CB || {};
globalThis.CB.shapes = globalThis.CB.shapes || {};
var hadRegister = typeof globalThis.CB.shapes.registerModel === 'function';
var captured = [];
var savedRegister = globalThis.CB.shapes.registerModel;
var savedPending = globalThis.CB.shapes._pending;
delete globalThis.CB.shapes.registerModel;
globalThis.CB.shapes._pending = [];
var file = path.join(root, 'models', 'shooting-brake.js');
delete require.cache[require.resolve(file)];
require(file);
captured = globalThis.CB.shapes._pending.slice();
// restore whatever was there (core may already be loaded by other tests) and hand the models on
globalThis.CB.shapes._pending = savedPending;
if (hadRegister) { globalThis.CB.shapes.registerModel = savedRegister; captured.forEach(function (m) { savedRegister(m); }); }
else if (savedPending && typeof savedPending.push === 'function') captured.forEach(function (m) { savedPending.push(m); });
else globalThis.CB.shapes._pending = captured.slice();

var IDS = ['porsche-taycan-cross-turismo', 'ferrari-gtc4lusso', 'mercedes-cls-shooting-brake-x218'];
function byId(id) { return captured.filter(function (m) { return m.id === id; })[0]; }

// ---------- geometry helpers
function isPath(v) { return Array.isArray(v) && v.length > 0 && v[0] && typeof v[0].t === 'string'; }
function sample(p) { // sample curve points of a path
  var pts = [], cur = null, start = null;
  p.forEach(function (s) {
    if (s.t === 'M') { cur = s.p[0]; start = cur; pts.push(cur); }
    else if (s.t === 'L') { cur = s.p[0]; pts.push(cur); }
    else if (s.t === 'C' || s.t === 'Q') {
      var c = [cur].concat(s.p);
      for (var k = 1; k <= 12; k++) {
        var t = k / 12, u = 1 - t, q;
        if (s.t === 'C') q = [u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0],
          u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1]];
        else q = [u * u * c[0][0] + 2 * u * t * c[1][0] + t * t * c[2][0], u * u * c[0][1] + 2 * u * t * c[1][1] + t * t * c[2][1]];
        pts.push(q);
      }
      cur = s.p[s.p.length - 1];
    } else if (s.t === 'Z') { cur = start; }
  });
  return pts;
}
function bounds(p) {
  var b = { minA: Infinity, maxA: -Infinity, minB: Infinity, maxB: -Infinity };
  sample(p).forEach(function (q) {
    b.minA = Math.min(b.minA, q[0]); b.maxA = Math.max(b.maxA, q[0]);
    b.minB = Math.min(b.minB, q[1]); b.maxB = Math.max(b.maxB, q[1]);
  });
  return b;
}
function walk(obj, fn, where) { // visit every path in a model
  if (isPath(obj)) return fn(obj, where);
  if (Array.isArray(obj)) return obj.forEach(function (v, i) { walk(v, fn, where + '[' + i + ']'); });
  if (obj && typeof obj === 'object') Object.keys(obj).forEach(function (k) { walk(obj[k], fn, where + '.' + k); });
}
function viewPaths(m, view) {
  var out = [];
  walk(m[view], function (p, w) { out.push({ p: p, w: w }); }, view);
  m.details.forEach(function (d, i) { if (d.view === view && d.role !== 'wiper') out.push({ p: d.path, w: 'details[' + i + ']' }); });
  return out;
}
function tireDiameter(spec) {
  var m = /^(\d+)\/(\d+)\s*Z?R\s*(\d+)/i.exec(spec);
  return (+m[3] * 25.4 + 2 * (+m[1]) * (+m[2]) / 100) / 1000;
}
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, msg + ': ' + a.toFixed(4) + ' vs ' + b.toFixed(4) + ' (tol ' + tol + ')'); }

// ---------- tests
test('shooting-brake: three real models queue on _pending when core is absent', function () {
  assert.equal(captured.length, 3);
  assert.deepEqual(captured.map(function (m) { return m.id; }).sort(), IDS.slice().sort());
  captured.forEach(function (m) {
    assert.equal(m.style, 'shooting-brake');
    ['make', 'name', 'gen', 'years'].forEach(function (k) { assert.equal(typeof m[k], 'string', m.id + ' ' + k); });
    assert.ok(['front', 'mid', 'rear'].indexOf(m.enginePosition) >= 0);
    assert.ok(['ice', 'ev', 'hybrid'].indexOf(m.powertrain) >= 0);
    ['headlights', 'taillights', 'grille', 'notes'].forEach(function (k) { assert.ok(m.signature[k].length > 20, m.id + ' signature.' + k); });
  });
});

test('shooting-brake: ref figures are real-world plausible and self-consistent', function () {
  captured.forEach(function (m) {
    var r = m.ref;
    ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR', 'frontOverhang', 'rearOverhang', 'groundClearance', 'rideHeight', 'cd', 'curbWeight_kg', 'wheelDiameter_in']
      .forEach(function (k) { assert.ok(Number.isFinite(r[k]) && r[k] > 0, m.id + ' ref.' + k); });
    near(r.frontOverhang + r.wheelbase + r.rearOverhang, r.length, 0.002, m.id + ' overhangs + wheelbase = length');
    assert.ok(r.length > 4.5 && r.length < 5.2 && r.width > 1.8 && r.width < 2.05 && r.height > 1.3 && r.height < 1.5, m.id + ' size');
    assert.ok(/R\s*\d+$/.test(r.tireF) && /R\s*\d+$/.test(r.tireR));
    assert.equal(+/R\s*(\d+)$/.exec(r.tireF)[1], r.wheelDiameter_in);
  });
});

test('shooting-brake: every path is well-formed with finite coordinates', function () {
  var counts = { M: 0, L: 0, C: 0, Q: 0, Z: 0 };
  var arity = { M: 1, L: 1, C: 3, Q: 2, Z: 0 };
  captured.forEach(function (m) {
    var n = 0;
    walk({ side: m.side, top: m.top, front: m.front, rear: m.rear, d: m.details.map(function (d) { return d.path; }) }, function (p, w) {
      n++;
      assert.equal(p[0].t, 'M', m.id + ' ' + w + ' starts with M');
      p.forEach(function (s) {
        assert.ok(s.t in arity, m.id + ' ' + w + ' bad segment ' + s.t);
        assert.equal(s.p.length, arity[s.t], m.id + ' ' + w + ' arity');
        counts[s.t]++;
        s.p.forEach(function (q) { assert.ok(q.length === 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]), m.id + ' ' + w + ' finite'); });
      });
    }, m.id);
    assert.ok(n > 60, m.id + ' has rich detail (' + n + ' paths)');
    m.details.forEach(function (d) {
      assert.ok(['side', 'top', 'front', 'rear'].indexOf(d.view) >= 0 && typeof d.role === 'string' && typeof d.paint === 'string');
    });
    m.rear.exhaust.forEach(function (e) {
      assert.ok(['round', 'oval', 'trapezoid', 'hidden'].indexOf(e.shape) >= 0);
      ['cx', 'cy', 'w', 'h'].forEach(function (k) { assert.ok(Number.isFinite(e[k])); });
    });
  });
  assert.ok(counts.C > counts.L, 'body surfaces are predominantly smooth cubic beziers');
});

test('shooting-brake: side body matches published length and height within 1%', function () {
  captured.forEach(function (m) {
    var b = bounds(m.side.body), r = m.ref;
    near(b.maxA - b.minA, r.length, r.length * 0.01, m.id + ' length');
    near(b.maxA, r.wheelbase / 2 + r.frontOverhang, r.length * 0.01, m.id + ' front bumper x');
    near(b.minA, -r.wheelbase / 2 - r.rearOverhang, r.length * 0.01, m.id + ' rear bumper x');
    near(b.maxB, r.height, r.height * 0.01, m.id + ' height');
    assert.ok(b.minB > 0.1 && b.minB < 0.25, m.id + ' body clears the ground');
    // greenhouse sits inside the body silhouette vertically
    var g = bounds(m.side.greenhouse);
    assert.ok(g.maxB < r.height && g.minB > 0.85, m.id + ' greenhouse height');
  });
});

test('shooting-brake: wheel arches centred on axles and sized for the real tyres', function () {
  captured.forEach(function (m) {
    var r = m.ref, pts = sample(m.side.body);
    [['archF', r.wheelbase / 2, r.tireF], ['archR', -r.wheelbase / 2, r.tireR]].forEach(function (a) {
      var arch = m.side[a[0]], tr = tireDiameter(a[2]) / 2;
      near(arch.x, a[1], 0.001, m.id + ' ' + a[0] + '.x');
      near(arch.y, tr, 0.01, m.id + ' ' + a[0] + '.y = tyre radius');
      assert.ok(arch.r - tr >= 0.02 && arch.r - tr <= 0.08, m.id + ' ' + a[0] + ' radius clears tyre');
      assert.ok(Number.isFinite(arch.flare));
      // the body outline actually contains the arch opening (point at the crown of the arch)
      var crown = pts.some(function (q) { return Math.abs(q[0] - arch.x) < 0.03 && Math.abs(q[1] - (arch.y + arch.r)) < 0.01; });
      assert.ok(crown, m.id + ' ' + a[0] + ' cut into body outline');
      // no body below the arch crown directly over the tyre (opening is empty)
      var inside = pts.some(function (q) { return Math.hypot(q[0] - arch.x, q[1] - arch.y) < arch.r - 0.01; });
      assert.ok(!inside, m.id + ' ' + a[0] + ' no body inside the opening');
    });
  });
});

test('shooting-brake: plan view width matches published width', function () {
  captured.forEach(function (m) {
    var b = bounds(m.top.body), r = m.ref;
    near(b.maxB - b.minB, r.width, r.width * 0.01, m.id + ' top width');
    near(b.maxB, -b.minB, 0.002, m.id + ' plan symmetric');
    near(b.maxA - b.minA, r.length, r.length * 0.01, m.id + ' top length');
    var fb = bounds(m.front.body), rb = bounds(m.rear.body);
    near(fb.maxA - fb.minA, r.width, r.width * 0.01, m.id + ' front-view width');
    near(rb.maxA - rb.minA, r.width, r.width * 0.01, m.id + ' rear-view width');
    near(fb.maxB, r.height, r.height * 0.01, m.id + ' front-view height');
    if (r.widthMirrors) {
      var mb = bounds((function (v) { return Array.isArray(v[0]) ? [].concat.apply([], v) : v; })(m.top.mirrors));
      near(mb.maxB - mb.minB, r.widthMirrors, 0.01, m.id + ' width incl. mirrors');
    }
  });
});

test('shooting-brake: front and rear views are symmetric about z = 0', function () {
  captured.forEach(function (m) {
    ['front', 'rear'].forEach(function (view) {
      var list = viewPaths(m, view).map(function (e) { return { w: e.w, b: bounds(e.p) }; });
      list.forEach(function (e) {
        var mirrored = list.some(function (o) {
          return Math.abs(o.b.minA + e.b.maxA) < 0.003 && Math.abs(o.b.maxA + e.b.minA) < 0.003 &&
            Math.abs(o.b.minB - e.b.minB) < 0.003 && Math.abs(o.b.maxB - e.b.maxB) < 0.003;
        });
        assert.ok(mirrored, m.id + ' ' + view + ' ' + e.w + ' has no mirror partner');
      });
    });
    var ex = m.rear.exhaust;
    ex.forEach(function (e) {
      assert.ok(ex.some(function (o) { return Math.abs(o.cx + e.cx) < 1e-6 && o.cy === e.cy && o.shape === e.shape; }), m.id + ' exhaust symmetric');
    });
  });
});

test('shooting-brake: signature features present (Taycan light bar & 4-point DRL, Ferrari quad lamps, CLS twin trapezoids)', function () {
  var t = byId('porsche-taycan-cross-turismo'), f = byId('ferrari-gtc4lusso'), c = byId('mercedes-cls-shooting-brake-x218');
  assert.ok(isPath(t.rear.lightBar) && t.rear.exhaust.length === 0 && t.front.drl.length === 8 && t.powertrain === 'ev');
  assert.ok(t.details.some(function (d) { return d.role === 'chargePort'; }));
  assert.equal(f.rear.taillights.length, 4);
  assert.equal(f.rear.exhaust.length, 4);
  assert.ok(f.details.filter(function (d) { return d.role === 'vent' && d.view === 'side'; }).length >= 4, 'Ferrari triple-louvre gill');
  assert.ok(c.rear.exhaust.every(function (e) { return e.shape === 'trapezoid'; }) && c.rear.exhaust.length === 2);
  assert.equal(c.side.windows.length, 3);
  assert.equal(f.side.windows.length, 2);
});

// Optional integration with the shared core (written in parallel by another team).
var core = null;
try { core = require(path.join(root, 'core.js')); } catch (e) { core = null; }
var S = globalThis.CB.shapes;
if (core && typeof S.fit === 'function' && typeof S.toSvgPath === 'function') {
  test('shooting-brake: core registerModel / fit / toSvgPath work on these models', function () {
    // other test files may replace globalThis.CB between load and run: prefer the core module's own exports
    var S = core && typeof core.registerModel === 'function' ? core : globalThis.CB.shapes;
    if (S._pending && S._pending.length && typeof S.registerModel === 'function') {
      S._pending.splice(0).forEach(function (m) { S.registerModel(m); });
    }
    IDS.forEach(function (id) {
      if (!S.models[id]) S.registerModel(byId(id));
      assert.ok(S.models[id], id + ' registered');
    });
    assert.ok(S.modelsByStyle('shooting-brake').length >= 3);
    var build = { body: { style: 'shooting-brake', wheelbase_mm: 2750, model: 'ferrari-gtc4lusso' } };
    if (globalThis.CB.data && globalThis.CB.data.defaultBuild) {
      var d = globalThis.CB.data.defaultBuild(); d.body.style = 'shooting-brake'; d.body.model = 'ferrari-gtc4lusso'; build = d;
    }
    var m = S.getModel(build);
    assert.equal(m.id, 'ferrari-gtc4lusso');
    var fitted = S.fit(m, build);
    assert.ok(fitted && fitted.dims && Number.isFinite(fitted.dims.wheelbase));
    var svg = S.toSvgPath(fitted.side.body, { scale: 100, flipY: true, ox: 300, oy: 200 });
    assert.ok(/^M[\s\d.\-]/.test(svg) && /C/.test(svg) && !/NaN|undefined/.test(svg));
  });
}

// ---------- design-critique regressions (recognizability)
function segPts(p) { var o = []; p.forEach(function (s) { if (s.p.length) o.push(s.p[s.p.length - 1]); }); return o; }
function hasNode(p, a, b, tol) { return segPts(p).some(function (q) { return Math.abs(q[0] - a) <= tol && Math.abs(q[1] - b) <= tol; }); }
function halfAt(p, x) { // max |b| of a closed plan path at station x
  var pts = sample(p), best = 0;
  for (var i = 0; i + 1 < pts.length; i++) {
    var a = pts[i], c = pts[i + 1];
    if ((a[0] - x) * (c[0] - x) > 0 || a[0] === c[0]) continue;
    best = Math.max(best, Math.abs(a[1] + (c[1] - a[1]) * (x - a[0]) / (c[0] - a[0])));
  }
  return best;
}

test('shooting-brake: DLO ends in a sharp rising point (window tail corners)', function () {
  [['porsche-taycan-cross-turismo', -2.04], ['ferrari-gtc4lusso', -2.10], ['mercedes-cls-shooting-brake-x218', -2.15]].forEach(function (c) {
    var m = byId(c[0]), w = m.side.windows[m.side.windows.length - 1];
    assert.ok(hasNode(w, c[1], 1.20, 0.035), c[0] + ' rear window tail point near (' + c[1] + ', 1.20)');
    assert.ok(hasNode(m.side.greenhouse, bounds(m.side.greenhouse).minA, 1.20, 0.01), c[0] + ' DLO tail is the rising point');
  });
});

test('shooting-brake: plan greenhouse matches the side DLO in x and tapers hard toward the tail', function () {
  IDS.forEach(function (id) {
    var m = byId(id), s = bounds(m.side.greenhouse), t = bounds(m.top.greenhouse);
    near(t.maxA, s.maxA, 0.03, id + ' greenhouse front x');
    near(t.minA, s.minA, 0.03, id + ' greenhouse rear x');
    var g = m.top.greenhouse;
    assert.ok(halfAt(g, -0.4) > halfAt(g, -1.6) + 0.05, id + ' taper -0.4 -> -1.6');
    assert.ok(halfAt(g, -1.6) > halfAt(g, t.minA + 0.04) + 0.15, id + ' taper to tail');
    assert.ok(halfAt(m.top.body, -m.ref.wheelbase / 2) > halfAt(g, -m.ref.wheelbase / 2) + 0.2, id + ' rear haunch wider than cabin');
  });
});

test('shooting-brake: rear glass is small and sits high under the roof spoiler', function () {
  IDS.forEach(function (id) {
    var m = byId(id), g = m.details.filter(function (d) { return d.view === 'rear' && d.role === 'glass'; })[0];
    assert.ok(g, id + ' rear glass');
    var b = bounds(g.path), sp = bounds(m.rear.spoiler);
    var cls = id === 'mercedes-cls-shooting-brake-x218';
    assert.ok(b.minB >= (id === 'ferrari-gtc4lusso' ? 1.015 : cls ? 1.025 : 1.045), id + ' glass base ' + b.minB);
    assert.ok(b.maxA <= (cls ? 0.605 : 0.585), id + ' glass half-width ' + b.maxA);
    assert.ok(b.maxB < sp.minB, id + ' glass under the spoiler');
  });
});

test('shooting-brake: per-car front signatures (Taycan teardrops, GTC4 single grille, CLS AMG trapezoids)', function () {
  var t = byId('porsche-taycan-cross-turismo'), f = byId('ferrari-gtc4lusso'), c = byId('mercedes-cls-shooting-brake-x218');
  var hl = bounds(t.front.headlights[0]);
  assert.ok(hl.maxA - hl.minA < 0.27 && hl.maxB - hl.minB > 0.15, 'Taycan compact upright headlight');
  near((hl.maxA + hl.minA) / 2, 0.76, 0.03, 'Taycan headlight centre z');
  var ik = bounds(t.front.intakes[0]);
  assert.ok(ik.maxB >= hl.minB + 0.02 && ik.minB <= 0.41, 'Taycan air curtain joins the lamp bottom');
  assert.equal(f.front.intakes.length, 0);
  assert.equal(f.front.grille.length, 1);
  var gb = bounds(f.front.grille[0]);
  near(gb.maxA, 0.74, 0.01, 'GTC4 grille half-width');
  var fh = bounds(f.front.headlights[0]);
  assert.ok(fh.maxB - fh.minB >= 0.11, 'GTC4 wedge headlight height');
  assert.equal(c.front.intakes.length, 2);
  assert.ok(c.front.intakes[0].every(function (s) { return s.t !== 'C'; }), 'CLS angular intakes');
  var cg = bounds(c.front.grille[0]), chl = bounds(c.front.headlights[0]);
  near(cg.maxA, 0.45, 0.01, 'CLS grille half-width');
  assert.ok(cg.maxB <= chl.minB - 0.01, 'CLS grille sits below the headlamp line');
  var cb = bounds(c.front.badgeArea);
  assert.ok(cb.maxA - cb.minA >= 0.12 && cb.minB >= 0.52 && cb.maxB <= 0.61, 'CLS centre star area on the louvres');
  c.rear.exhaust.forEach(function (e) { assert.ok(e.cy - e.h / 2 >= 0.22, 'CLS tips inside bumper'); });
  assert.ok(c.details.filter(function (d) { return d.role === 'pillar' && d.paint === 'gloss-black'; }).length === 2);
});

test('shooting-brake: GTC4 steep Kamm tail under the roof spoiler', function () {
  var f = byId('ferrari-gtc4lusso');
  assert.ok(hasNode(f.side.body, -2.205, 1.315, 0.01), 'roof spoiler corner');
  assert.ok(hasNode(f.side.body, -2.378, 0.985, 0.01), 'hatch base');
  var ang = Math.atan2(1.315 - 0.985, 2.378 - 2.205) * 180 / Math.PI;
  assert.ok(ang > 58 && ang < 66, 'tailgate angle ' + ang.toFixed(1));
});

test('shooting-brake: explicit 3D sections are half rings with shoulders wider than the greenhouse', function () {
  IDS.forEach(function (id) {
    var m = byId(id);
    assert.ok(Array.isArray(m.sections) && m.sections.length >= 8, id + ' sections');
    var xs = m.sections.map(function (s) { return s.x; });
    for (var i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], id + ' sections sorted');
    var ax = -m.ref.wheelbase / 2, sec = m.sections.reduce(function (a, s) { return Math.abs(s.x - ax) < Math.abs(a.x - ax) ? s : a; });
    assert.ok(sec.ringHalf);
    var maxZ = Math.max.apply(null, sec.ring.map(function (q) { return q[1]; }));
    var topZ = Math.max.apply(null, sec.ring.filter(function (q) { return q[0] > sec.belt + 0.1; }).map(function (q) { return q[1]; }));
    assert.ok(sec.ring.every(function (q) { return Number.isFinite(q[0]) && Number.isFinite(q[1]) && q[1] >= -1e-9; }));
    assert.ok(maxZ - topZ > 0.2, id + ' haunch ' + maxZ.toFixed(3) + ' vs cabin ' + topZ.toFixed(3));
  });
});

test('shooting-brake: 3D cabin stays full-width behind the side-glass tail (no fin over the tailgate)', function () {
  [['porsche-taycan-cross-turismo', -2.14, -2.38], ['ferrari-gtc4lusso', -2.21, -2.32], ['mercedes-cls-shooting-brake-x218', -2.22, -2.44]].forEach(function (c) {
    var m = byId(c[0]);
    m.sections.filter(function (s) { return s.x <= c[1] + 0.01 && s.x >= c[2] - 0.01; }).forEach(function (s) {
      var r = s.ring, top = Math.max.apply(null, r.map(function (q) { return q[0]; })), y = top - 0.03, hw = 0;
      for (var i = 0; i + 1 < r.length; i++) {
        var a = r[i], b = r[i + 1];
        if ((a[0] - y) * (b[0] - y) <= 0 && a[0] !== b[0]) hw = Math.max(hw, a[1] + (b[1] - a[1]) * (y - a[0]) / (b[0] - a[0]));
      }
      assert.ok(hw > 0.42, c[0] + ' cabin half-width at x ' + s.x + ' = ' + hw.toFixed(3));
    });
  });
});

test('shooting-brake: tall tailgate glass reaches the spoiler; GTC4/CLS front mirrors have stalks', function () {
  IDS.forEach(function (id) {
    var m = byId(id), g = bounds(m.details.filter(function (d) { return d.view === 'rear' && d.role === 'glass'; })[0].path);
    assert.ok(bounds(m.rear.spoiler).minB - g.maxB < 0.012, id + ' no body band between glass and spoiler');
  });
  ['ferrari-gtc4lusso', 'mercedes-cls-shooting-brake-x218'].forEach(function (id) {
    var m = byId(id), mir = bounds(m.details.filter(function (d) { return d.view === 'front' && d.role === 'mirror'; })[0].path);
    var stalk = m.details.some(function (d) {
      if (d.view !== 'front' || d.role !== 'trim') return false;
      var b = bounds(d.path); return b.minA <= 0.72 && b.maxA >= mir.minA && b.maxB < 1.02 && b.minB > 0.95;
    });
    assert.ok(stalk, id + ' mirror stalk');
  });
  var c = byId('mercedes-cls-shooting-brake-x218');
  assert.ok(bounds(c.rear.bumper).maxB < bounds(c.rear.plateArea).minB, 'CLS bumper split under the plate');
});

// ---------- round-2 critique regressions (3D glass, tail caps, rear trim)
function expand(s) { // replicate core's half-ring expansion length for flag checks
  return s.glass ? s.glass.length : 0;
}
test('shooting-brake: side glass flags keep one clean vertex row (no saw-tooth) and never glaze the cowl', function () {
  IDS.forEach(function (id) {
    var m = byId(id), cowl = { 'porsche-taycan-cross-turismo': 0.80, 'ferrari-gtc4lusso': 0.32, 'mercedes-cls-shooting-brake-x218': 0.88 }[id];
    m.sections.forEach(function (s) {
      if (s.x >= cowl - 0.02) assert.ok(s.belt == null && !s.glass, id + ' no glass on the bonnet at x ' + s.x);
      if (s.glass) {
        assert.equal(expand(s), 40, id + ' glass flags sized for ringVerts 40');
        assert.ok(Array.isArray(s.glassFrac) && s.glassFrac[0] < s.glassFrac[1], id + ' glassFrac');
      }
    });
    // in the cabin (B-pillar to C-pillar) every station glazes exactly the same contiguous vertex rows
    var cab = m.sections.filter(function (s) { return s.glass && s.x < -0.5 && s.x > -1.5; }), sig = null;
    assert.ok(cab.length >= 6, id + ' cabin glass stations');
    cab.forEach(function (s) {
      var rows = s.glass.slice(0, 21).map(String).join('');
      assert.ok(/^0+1+0+$/.test(rows), id + ' contiguous side glass ' + rows);
      if (sig == null) sig = rows; else assert.equal(rows, sig, id + ' same glass rows at x ' + s.x);
    });
  });
});

test('shooting-brake: 3D tail and nose end in shrinking cap rings (no blunt slab)', function () {
  IDS.forEach(function (id) {
    var m = byId(id), S0 = m.sections[0], S1 = m.sections[m.sections.length - 1];
    function hw(s) { return Math.max.apply(null, s.ring.map(function (q) { return q[1]; })); }
    function ht(s) { var y = s.ring.map(function (q) { return q[0]; }); return Math.max.apply(null, y) - Math.min.apply(null, y); }
    var in0 = m.sections.filter(function (s) { return s.x - S0.x > 0.02; })[0];
    var in1 = m.sections.filter(function (s) { return S1.x - s.x > 0.02; }).pop();
    assert.ok(hw(S0) < 0.4 * hw(in0) && ht(S0) < 0.6 * ht(in0), id + ' tail cap');
    assert.ok(hw(S1) < 0.4 * hw(in1) && ht(S1) < 0.6 * ht(in1), id + ' nose cap');
    near(S0.x, -m.ref.wheelbase / 2 - m.ref.rearOverhang, 0.015, id + ' cap keeps the published length (rear)');
    near(S1.x, m.ref.wheelbase / 2 + m.ref.frontOverhang, 0.015, id + ' cap keeps the published length (front)');
  });
});

test('shooting-brake: GTC4 ducktail crease and lip stay inside the rear body outline', function () {
  var f = byId('ferrari-gtc4lusso');
  var lines = (f.rear.characterLines || []).concat(f.details.filter(function (d) { return d.view === 'rear' && d.paint === 'black'; }).map(function (d) { return d.path; }));
  lines.forEach(function (p) { assert.ok(bounds(p).maxA <= halfAt(f.rear.body.map(function (s) { return { t: s.t, p: s.p.map(function (q) { return [q[1], q[0]]; }) }; }), 0.918) + 1e-6 || bounds(p).maxB < 0.5); });
  assert.ok(bounds(f.rear.characterLines[0]).maxA <= 0.865);
});

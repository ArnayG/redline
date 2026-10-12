/* Node tests for js/shapes/models/roadster.js — run: node tests/run.js shapes-roadster */
'use strict';
var path = require('path');
// Allow `node tests/shapes-roadster.test.js` on its own (tests/run.js normally provides test/assert).
if (typeof globalThis.test !== 'function') {
  globalThis.assert = require('node:assert/strict');
  var _q = []; globalThis.test = function (n, fn) { _q.push([n, fn]); };
  setTimeout(function () {
    var bad = 0;
    _q.forEach(function (t) { try { t[1](); console.log('  ok  ' + t[0]); } catch (e) { bad++; console.log('  FAIL ' + t[0] + '\n    ' + e.message); } });
    console.log(_q.length - bad + ' passed, ' + bad + ' failed'); if (bad) process.exitCode = 1;
  }, 0);
}
var fs = require('fs');
var ROOT = path.join(__dirname, '..', 'js', 'shapes');

// Load the model file without core.js: models land in CB.shapes._pending.
globalThis.CB = globalThis.CB || {};
var CB = globalThis.CB;
CB.shapes = CB.shapes || {};
var hadCore = typeof CB.shapes.registerModel === 'function';
var mod = require(path.join(ROOT, 'models', 'roadster.js'));
var MODELS = mod.models;
var IDS = ['mazda-mx5-nd', 'bmw-z4-g29', 'porsche-718-boxster-982'];

function eachPoint(p, fn) { p.forEach(function (s) { s.p.forEach(function (q) { fn(q, s); }); }); }
function bounds(paths) {
  var b = { minA: Infinity, maxA: -Infinity, minB: Infinity, maxB: -Infinity };
  paths.forEach(function (p) {
    eachPoint(p, function (q) {
      b.minA = Math.min(b.minA, q[0]); b.maxA = Math.max(b.maxA, q[0]);
      b.minB = Math.min(b.minB, q[1]); b.maxB = Math.max(b.maxB, q[1]);
    });
  });
  return b;
}
// Bounds of the actual curve (sampled Béziers), not just control points.
function curveBounds(paths) {
  var b = { minA: Infinity, maxA: -Infinity, minB: Infinity, maxB: -Infinity };
  function add(x, y) { b.minA = Math.min(b.minA, x); b.maxA = Math.max(b.maxA, x); b.minB = Math.min(b.minB, y); b.maxB = Math.max(b.maxB, y); }
  paths.forEach(function (p) {
    var cur = null, start = null;
    p.forEach(function (s) {
      if (s.t === 'M') { cur = s.p[0]; start = cur; add(cur[0], cur[1]); }
      else if (s.t === 'L') { cur = s.p[0]; add(cur[0], cur[1]); }
      else if (s.t === 'C' || s.t === 'Q') {
        var c = [cur].concat(s.p);
        for (var i = 1; i <= 24; i++) {
          var t = i / 24, u = 1 - t, x, y;
          if (s.t === 'C') { x = u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0]; y = u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1]; }
          else { x = u * u * c[0][0] + 2 * u * t * c[1][0] + t * t * c[2][0]; y = u * u * c[0][1] + 2 * u * t * c[1][1] + t * t * c[2][1]; }
          add(x, y);
        }
        cur = s.p[s.p.length - 1];
      } else if (s.t === 'Z') { cur = start; }
    });
  });
  return b;
}
function isPath(p) { return Array.isArray(p) && p.length > 0 && p[0] && typeof p[0].t === 'string'; }
function collectPaths(obj, out) {
  out = out || [];
  if (isPath(obj)) out.push(obj);
  else if (Array.isArray(obj)) obj.forEach(function (o) { collectPaths(o, out); });
  else if (obj && typeof obj === 'object') Object.keys(obj).forEach(function (k) { collectPaths(obj[k], out); });
  return out;
}
function tireDia(spec) { var m = /(\d+)\/(\d+)\D*R?\s*(\d+)/.exec(spec); return (2 * m[1] * m[2] / 100 + m[3] * 25.4) / 1000; }
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, msg + ': ' + a.toFixed(4) + ' vs ' + b.toFixed(4) + ' (tol ' + tol.toFixed(4) + ')'); }

test('roadster: exports and registers three real models', function () {
  assert.equal(MODELS.length, 3);
  assert.deepEqual(MODELS.map(function (m) { return m.id; }), IDS);
  if (!hadCore && typeof CB.shapes.registerModel !== 'function') {
    var pend = (CB.shapes._pending || []).map(function (m) { return m.id; });
    IDS.forEach(function (id) { assert.ok(pend.indexOf(id) >= 0, id + ' pending'); });
  }
  MODELS.forEach(function (m) {
    assert.equal(m.style, 'roadster');
    assert.ok(m.make && m.name && m.gen && m.years, m.id + ' meta');
    assert.ok(['front', 'mid', 'rear'].indexOf(m.enginePosition) >= 0);
    ['side', 'top', 'front', 'rear', 'details', 'signature', 'ref'].forEach(function (k) { assert.ok(m[k], m.id + ' has ' + k); });
    ['headlights', 'taillights', 'grille', 'notes'].forEach(function (k) { assert.ok(typeof m.signature[k] === 'string' && m.signature[k].length > 10, m.id + ' signature.' + k); });
  });
});

test('roadster: ref dimensions are self-consistent real figures', function () {
  MODELS.forEach(function (m) {
    var r = m.ref;
    near(r.frontOverhang + r.wheelbase + r.rearOverhang, r.length, 0.002, m.id + ' overhangs + wheelbase = length');
    ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR', 'groundClearance', 'cd', 'curbWeight_kg', 'wheelDiameter_in'].forEach(function (k) {
      assert.ok(isFinite(r[k]) && r[k] > 0, m.id + ' ref.' + k);
    });
    assert.ok(new RegExp('R' + r.wheelDiameter_in + '$').test(r.tireF) && new RegExp('R' + r.wheelDiameter_in + '$').test(r.tireR), m.id + ' tyre rim size');
  });
});

test('roadster: every path is well-formed with finite coordinates', function () {
  var arity = { M: 1, L: 1, C: 3, Q: 2, Z: 0 };
  MODELS.forEach(function (m) {
    var paths = collectPaths({ side: m.side, top: m.top, front: m.front, rear: m.rear, d: m.details.map(function (d) { return d.path; }) });
    assert.ok(paths.length > 60, m.id + ' has rich geometry (' + paths.length + ' paths)');
    paths.forEach(function (p) {
      assert.equal(p[0].t, 'M', m.id + ' path starts with M');
      p.forEach(function (s) {
        assert.ok(s.t in arity, 'segment type ' + s.t);
        assert.equal(s.p.length, arity[s.t], m.id + ' ' + s.t + ' arity');
        s.p.forEach(function (q) { assert.ok(q.length === 2 && isFinite(q[0]) && isFinite(q[1]), m.id + ' finite point'); });
      });
    });
    m.details.forEach(function (d) {
      assert.ok(['side', 'top', 'front', 'rear'].indexOf(d.view) >= 0, 'detail view');
      assert.ok(typeof d.role === 'string' && typeof d.paint === 'string', 'detail role/paint');
    });
  });
});

test('roadster: side silhouette matches published length and height (1%)', function () {
  MODELS.forEach(function (m) {
    var r = m.ref, b = curveBounds([m.side.body]);
    near(b.maxA - b.minA, r.length, r.length * 0.01, m.id + ' side length');
    near(b.maxA, r.wheelbase / 2 + r.frontOverhang, r.length * 0.01, m.id + ' front bumper x');
    near(b.minA, -(r.wheelbase / 2 + r.rearOverhang), r.length * 0.01, m.id + ' rear bumper x');
    var all = curveBounds([m.side.body, m.side.greenhouse, m.side.softTop]);
    near(all.maxB, r.height, r.height * 0.01, m.id + ' overall height (hood up)');
    assert.ok(b.minB >= r.groundClearance * 0.9 && b.minB <= r.groundClearance + 0.03, m.id + ' body underside ≈ ground clearance (' + b.minB + ')');
    assert.ok(curveBounds([m.side.greenhouse]).maxB < r.height, m.id + ' windscreen below hood roof');
  });
});

test('roadster: wheel arches centred on axles and sized for the real tyres', function () {
  MODELS.forEach(function (m) {
    var r = m.ref;
    [['archF', r.tireF, 1], ['archR', r.tireR, -1]].forEach(function (a) {
      var arch = m.side[a[0]], rad = tireDia(a[1]) / 2;
      near(arch.x, a[2] * r.wheelbase / 2, 0.001, m.id + ' ' + a[0] + '.x on axle');
      near(arch.y, rad, 0.003, m.id + ' ' + a[0] + '.y = tyre radius');
      assert.ok(arch.r > rad * 1.03 && arch.r < rad * 1.2, m.id + ' ' + a[0] + '.r clears tyre (' + arch.r + ' vs ' + rad + ')');
    });
    // the body path actually contains the arch cut-out: some point lies on the arch circle above the axle
    var hit = 0;
    eachPoint(m.side.body, function (q) {
      var d = Math.hypot(q[0] - m.side.archF.x, q[1] - m.side.archF.y);
      if (Math.abs(d - m.side.archF.r) < 0.002 && q[1] > m.side.archF.y) hit++;
    });
    assert.ok(hit >= 2, m.id + ' front arch cut into side body');
  });
});

test('roadster: plan view width matches published width; length agrees with side', function () {
  MODELS.forEach(function (m) {
    var r = m.ref, b = curveBounds([m.top.body]);
    near(b.maxB - b.minB, r.width, r.width * 0.01, m.id + ' plan width');
    near(b.maxB, -b.minB, 0.001, m.id + ' plan symmetric');
    near(b.maxA - b.minA, r.length, r.length * 0.01, m.id + ' plan length');
    var mb = bounds(m.top.mirrors);
    assert.ok(mb.maxB > r.width / 2, m.id + ' mirrors stand proud of the body');
  });
});

test('roadster: front and rear views are symmetric about z = 0 and to scale', function () {
  MODELS.forEach(function (m) {
    ['front', 'rear'].forEach(function (v) {
      var V = m[v];
      // body outline: every point has a mirror partner
      var pts = [];
      eachPoint(V.body, function (q) { pts.push(q); });
      pts.forEach(function (q) {
        assert.ok(pts.some(function (o) { return Math.abs(o[0] + q[0]) < 1e-3 && Math.abs(o[1] - q[1]) < 1e-3; }), m.id + ' ' + v + ' body mirror of ' + q);
      });
      var b = curveBounds([V.body]);
      near(b.maxA - b.minA, m.ref.width, m.ref.width * 0.01, m.id + ' ' + v + ' width');
      // the whole view (all features) is balanced left/right
      var feats = collectPaths(V);
      var fb = bounds(feats);
      near(fb.maxA, -fb.minA, 0.002, m.id + ' ' + v + ' features symmetric');
      var lights = v === 'front' ? V.headlights : V.taillights;
      assert.equal(lights.length, 2, m.id + ' ' + v + ' light pair');
      var l0 = bounds([lights[0]]), l1 = bounds([lights[1]]);
      near(l0.maxA, -l1.minA, 1e-3, m.id + ' ' + v + ' lights mirrored');
      var all = curveBounds([V.body, V.greenhouse, V.softTop]);
      near(all.maxB, m.ref.height, m.ref.height * 0.01, m.id + ' ' + v + ' height');
    });
    m.rear.exhaust.forEach(function (e) { assert.ok(['round', 'oval', 'trapezoid', 'hidden'].indexOf(e.shape) >= 0 && isFinite(e.cx + e.cy + e.w + e.h)); });
    var ex = m.rear.exhaust.reduce(function (s, e) { return s + e.cx; }, 0);
    near(ex, 0, 1e-6, m.id + ' exhaust layout symmetric');
  });
});

test('roadster: recognisable signature features are present', function () {
  var byId = {}; MODELS.forEach(function (m) { byId[m.id] = m; });
  var z4 = byId['bmw-z4-g29'], bx = byId['porsche-718-boxster-982'], mx = byId['mazda-mx5-nd'];
  assert.equal(z4.front.grille.length, 2, 'Z4 has twin kidneys');
  assert.ok(z4.details.some(function (d) { return d.view === 'side' && d.role === 'vent'; }), 'Z4 Air Breather');
  function pth(it) { return it && it.path ? it.path : it; }
  function leds(m) { return m.front.drl.filter(function (it) { return !(it && it.role === 'lampInterior'); }).map(pth); }
  var zl = leds(z4);
  assert.equal(zl.length, 4, 'Z4 stacked twin LED elements per side');
  // the two stacked strokes per side are separate (vertical gap) and sit on a dark lamp interior
  var zr = zl.map(function (p) { return bounds([p]); }).filter(function (b) { return b.minA > 0; }).sort(function (a, b) { return a.minB - b.minB; });
  assert.equal(zr.length, 2); assert.ok(zr[1].minB - zr[0].maxB > 0.05, 'Z4 LED strokes separated');
  assert.ok(z4.front.drl.some(function (it) { return it.role === 'lampInterior' && it.paint === 'gloss-black'; }), 'Z4 dark lamp interior');
  // kidney surround is a ring (two sub-paths) so the mesh stays visible
  var sur = z4.details.filter(function (d) { return d.view === 'front' && d.paint === 'chrome'; });
  assert.equal(sur.length, 2); sur.forEach(function (d) { assert.equal(d.path.filter(function (sg) { return sg.t === 'M'; }).length, 2, 'Z4 surround is a ring'); });
  assert.ok(bx.details.some(function (d) { return d.view === 'side' && d.role === 'intake'; }), 'Boxster side intake');
  assert.equal(leds(bx).filter(function (p) { var b = bounds([p]); return b.maxA - b.minA < 0.08 && b.maxB - b.minB < 0.05; }).length, 8, 'Boxster four-point DRL x2');
  assert.ok(!mx.front.intakes.some(function (p) { var b = bounds([p]); return b.maxB - b.minB > 0.08; }), 'MX-5 has no round lower openings, only thin slots');
  assert.equal(bx.enginePosition, 'mid');
  assert.equal(bx.rear.exhaust.length, 1, 'Boxster single central tailpipe');
  assert.ok(bx.details.some(function (d) { return d.view === 'rear' && d.paint === 'gloss-black' && d.role === 'trim'; }), 'Boxster black rear accent bar (unlit, carries lettering)');
  assert.equal(mx.details.filter(function (d) { return d.view === 'rear' && d.role === 'light'; }).length, 4, 'MX-5 twin round lamp rings');
  // Boxster intake sits between the door and the rear arch
  var ib = bounds([bx.details.filter(function (d) { return d.role === 'intake'; })[0].path]);
  assert.ok(ib.minA > bx.side.archR.x + bx.side.archR.r - 0.02, 'intake ahead of rear arch');
});

test('roadster: blunt upright nose and short side glass', function () {
  var ends = { 'mazda-mx5-nd': -0.70, 'bmw-z4-g29': -0.85, 'porsche-718-boxster-982': -0.85 };
  MODELS.forEach(function (m) {
    var wb = curveBounds(m.side.windows);
    near(wb.minA, ends[m.id], 0.015, m.id + ' side glass rear edge');
    var gb = curveBounds([m.side.greenhouse]);
    assert.ok(gb.minA > ends[m.id] - 0.06, m.id + ' greenhouse frame ends just behind the glass');
    var nose = m.ref.wheelbase / 2 + m.ref.frontOverhang;
    eachPoint(m.side.body, function (q) { if (q[0] > nose - 0.3 && q[1] > 0.25 && q[1] < 0.48) assert.ok(q[0] > nose - 0.045, m.id + ' upright front face at ' + q); });
    var lamp = m.details.filter(function (d) { return d.view === 'side' && d.role === 'light'; })[0];
    var lb = curveBounds([lamp.path]);
    assert.ok(lb.maxB - lb.minB >= 0.09, m.id + ' side headlamp is a real lens (' + (lb.maxB - lb.minB).toFixed(3) + ')');
  });
});

test('roadster: explicit open-top sections (32-vert topology, cockpit tub, fender crests)', function () {
  MODELS.forEach(function (m) {
    assert.ok(Array.isArray(m.sections) && m.sections.length > 40, m.id + ' sections');
    m.sections.forEach(function (s, i) {
      assert.equal(s.ring.length, 32, m.id + ' ring verts (contract ringVerts 32)');
      assert.equal(s.glass.length, 32, m.id + ' glass flags');
      s.ring.forEach(function (q) { assert.ok(isFinite(q[0]) && isFinite(q[1])); });
      if (i) assert.ok(s.x > m.sections[i - 1].x, m.id + ' sorted stations');
    });
    var mid = m.sections.filter(function (s) { return s.x < m.side.archF.x - 1.0 && s.x > m.side.archR.x + 0.6 && s.glass.some(Boolean); });
    assert.ok(mid.length > 3, m.id + ' cockpit stations');
    var fs = m.sections.filter(function (s) { return Math.abs(s.x - (m.side.archF.x + 0.15)) < 0.1; })[0];
    var top = Math.max.apply(null, fs.ring.map(function (q) { return q[0]; }));
    var centre = fs.ring[16][0];
    assert.ok(top - centre > 0.03 && top - centre < 0.09, m.id + ' fender crest above bonnet (' + (top - centre).toFixed(3) + ')');
  });
});

test('roadster: 3D windscreen is a raked shell, hoops stand proud, arches evenly sampled, carves present', function () {
  MODELS.forEach(function (m) {
    var S = m.sections;
    // windscreen: glass top (9) and underside (12) differ by ~0.034 m; void under it reaches the tub floor at the header
    var ws = S.filter(function (s) { return s.belt != null; });
    assert.ok(ws.length >= 4, m.id + ' windscreen stations');
    var last = ws[0];                                   // rearmost windscreen station = header
    near(last.ring[9][0] - last.ring[12][0], 0.034, 0.01, m.id + ' glass shell thickness');
    var floor = last.ring[16][0];
    assert.ok(last.ring[12][0] - floor > 0.25, m.id + ' void under the glass drops to the tub floor');
    // first cockpit station behind the header: glass vertices collapse at the A-pillar top (no full-width slab)
    var ck = S[S.indexOf(last) - 1];
    [10, 11, 12].forEach(function (j) { assert.deepEqual(ck.ring[j], ck.ring[9], m.id + ' glass edge collapses'); });
    assert.ok(ck.ring[9][1] > 0.5, m.id + ' collapse point at the pillar, not the centre');
    // roll hoops: crowns at least 0.06 m above the deck surface at the same station
    var hb = bounds(m.side.rollHoops), hs = S.filter(function (s) { return s.x < hb.maxA && s.x > hb.minA && s.ring[12][0] - s.ring[9][0] > 0.05; });
    assert.ok(hs.length >= 3, m.id + ' roll hoop crowns in 3D (' + hs.length + ')');
    // wheel arches: even station spacing (0.035 m ± 0.006) over axle ± (r + 0.02)
    [m.side.archF, m.side.archR].forEach(function (a) {
      var xs = S.map(function (s) { return s.x; }).filter(function (x) { return Math.abs(x - a.x) <= a.r + 0.021; });
      for (var i = 1; i < xs.length; i++) near(xs[i] - xs[i - 1], 0.035, 0.007, m.id + ' arch station spacing');
    });
    // glass flags survive core expansion at the contract ring size
    if (typeof CB.shapes.sectionsFromViews === 'function') {
      var ex = CB.shapes.sectionsFromViews(m, { ringVerts: 32 });
      assert.ok(ex.some(function (s) { return s.glass && s.glass.some(Boolean); }), m.id + ' glass flags kept at ringVerts 32');
    }
  });
  var byId = {}; MODELS.forEach(function (m) { byId[m.id] = m; });
  // recess = surface z interpolated between stations just outside the opening minus z inside it
  function recess(m, x, y, xa, xb) {
    function sec(q0) { return m.sections.reduce(function (b, q) { return Math.abs(q.x - q0) < Math.abs(b.x - q0) ? q : b; }); }
    function zAt(s) { var best = null; for (var j = 2; j <= 7; j++) if (best === null || Math.abs(s.ring[j][0] - y) < Math.abs(s.ring[best][0] - y)) best = j; return s.ring[best][1]; }
    var a = sec(xa), b = sec(xb), c = sec(x), t = (c.x - a.x) / (b.x - a.x);
    return zAt(a) + (zAt(b) - zAt(a)) * t - zAt(c);
  }
  var bxR = recess(byId['porsche-718-boxster-982'], -0.72, 0.58, -0.52, -0.88), z4R = recess(byId['bmw-z4-g29'], 0.72, 0.62, 0.55, 0.86);
  near(bxR, 0.03, 0.008, 'Boxster side intake carved 0.03 m into the 3D body');
  near(z4R, 0.015, 0.006, 'Z4 Air Breather carved 0.015 m into the 3D body');
});

test('roadster: rounded tails in plan, undercut tails in profile, tucked lower corners front/rear', function () {
  var under = { 'mazda-mx5-nd': [-1.87, 0.28], 'bmw-z4-g29': [-2.06, 0.25], 'porsche-718-boxster-982': [-2.07, 0.25] };
  MODELS.forEach(function (m) {
    var hw = m.ref.width / 2, tail = -(m.ref.wheelbase / 2 + m.ref.rearOverhang);
    function halfAt(x) {   // plan half-width at x from the sampled outline
      var best = 0; m.top.body.forEach(function (sg) { var q = sg.p[sg.p.length - 1]; if (q && Math.abs(q[0] - x) < 0.006) best = Math.max(best, Math.abs(q[1])); });
      return best;
    }
    var k = hw / 0.8675;
    near(halfAt(tail + 0.08), 0.62 * k, 0.03, m.id + ' plan half-width at tail + 0.08');
    near(halfAt(tail + 0.16), 0.76 * k, 0.03, m.id + ' plan half-width at tail + 0.16');
    near(halfAt(tail + 0.25), 0.83 * k, 0.03, m.id + ' plan half-width at tail + 0.25');
    var u = under[m.id], hit = false;
    m.side.body.forEach(function (sg) { var q = sg.p[sg.p.length - 1]; if (q && Math.abs(q[0] - u[0]) < 0.005 && Math.abs(q[1] - u[1]) < 0.005) hit = true; });
    assert.ok(hit, m.id + ' rear bumper undercut point');
    ['front', 'rear'].forEach(function (v) {
      var zs = []; m[v].bumper.forEach(function (sg) { var q = sg.p[sg.p.length - 1]; if (q && Math.abs(q[1] - 0.20) < 0.008 && q[0] > 0) zs.push(q[0]); });
      assert.ok(zs.length && Math.max.apply(null, zs) < (m.ref.trackF / 2 + 0.03), m.id + ' ' + v + ' bumper lower corner tucked (' + zs + ')');
    });
    var ck = curveBounds([m.top.cockpit]);
    assert.ok(ck.maxB < 0.69, m.id + ' cockpit plan width (' + ck.maxB.toFixed(3) + ')');
    var wb = curveBounds(m.side.windows);
    assert.ok(wb.maxB - 1.06 > 0 && wb.maxB < m.side.windows[0][1].p[0][1] + 0.01, m.id + ' DLO top falls rearward');
  });
});

test('roadster: critique-2 fixes (soft DLO, distinct rear bumpers, framed screens, tyre cover, lamps)', function () {
  var byId = {}; MODELS.forEach(function (m) { byId[m.id] = m; });
  var dlo = { 'mazda-mx5-nd': 1.10, 'bmw-z4-g29': 1.17, 'porsche-718-boxster-982': 1.15 };
  var bump = { 'mazda-mx5-nd': 0.58, 'bmw-z4-g29': 0.62, 'porsche-718-boxster-982': 0.60 };
  MODELS.forEach(function (m) {
    var r = m.ref, wb = curveBounds(m.side.windows);
    near(wb.maxB, dlo[m.id], 0.012, m.id + ' windows-down DLO top');
    // rear edge raked: bottom-rear corner sits ~0.06 m behind the top-rear corner
    var pts = []; eachPoint(m.side.windows[0], function (q) { pts.push(q); });
    var lowRear = wb.minA;   // rearmost point = bottom-rear corner
    var hiRear = pts.filter(function (q) { return q[1] > wb.maxB - 0.08; }).reduce(function (a, q) { return Math.min(a, q[0]); }, 9);
    assert.ok(hiRear - lowRear > 0.04, m.id + ' raked DLO rear edge (' + (hiRear - lowRear).toFixed(3) + ')');
    near(curveBounds([m.rear.bumper]).maxB, bump[m.id], 0.006, m.id + ' rear bumper top');
    ['front', 'rear'].forEach(function (v) {
      assert.ok(m.details.some(function (d) { return d.view === v && d.role === 'trim' && bounds([d.path]).maxB > bounds([m[v].greenhouse]).maxB + 0.02; }), m.id + ' ' + v + ' windscreen frame');
    });
    var pb = curveBounds([m.top.body]);
    [[r.wheelbase / 2, r.trackF, r.tireF], [-r.wheelbase / 2, r.trackR, r.tireR]].forEach(function (a) {
      var need = a[1] / 2 + (+a[2].split('/')[0]) / 2000 + 0.005, got = 0;
      m.top.body.forEach(function (sg) { var q = sg.p[sg.p.length - 1]; if (q && Math.abs(q[0] - a[0]) < 0.01) got = Math.max(got, q[1]); });
      assert.ok(got >= need - 1e-4, m.id + ' plan covers the tyre at x ' + a[0] + ' (' + got + ' vs ' + need.toFixed(4) + ')');
      var ax = m.sections.reduce(function (b, q) { return Math.abs(q.x - a[0]) < Math.abs(b.x - a[0]) ? q : b; });
      assert.ok(Math.max.apply(null, ax.ring.map(function (q) { return q[1]; })) >= need - 0.002, m.id + ' 3D arch lip covers the tyre');
    });
    void pb;
    for (var i = 1; i < m.sections.length; i++) assert.ok(m.sections[i].x - m.sections[i - 1].x <= 0.0451, m.id + ' station pitch <= 0.045');
  });
  var mx = byId['mazda-mx5-nd'], z4 = byId['bmw-z4-g29'], bx = byId['porsche-718-boxster-982'];
  near(bounds(mx.side.rollHoops).maxB, 1.06, 0.005, 'MX-5 hoops reach 1.06');
  function sideLamp(m) { return curveBounds([m.details.filter(function (d) { return d.view === 'side' && d.role === 'light'; })[0].path]); }
  near(sideLamp(z4).minA, 1.60, 0.01, 'Z4 side lamp runs back to x 1.60');
  near(sideLamp(bx).minA, 1.62, 0.01, 'Boxster side lamp runs back to x 1.62');
  near(sideLamp(bx).maxB, 0.80, 0.01, 'Boxster side lamp top');
  near(bounds([z4.front.headlights[0]]).minA, 0.47, 0.03, 'Z4 lamp inner edge reaches toward the kidneys');
  var vb = curveBounds([z4.details.filter(function (d) { return d.role === 'vent'; })[0].path]);
  near(vb.maxA - vb.minA, 0.30, 0.01, 'Z4 Air Breather length'); near(vb.maxB - vb.minB, 0.087, 0.01, 'Z4 Air Breather height');
  var bar = bx.details.filter(function (d) { return d.view === 'rear' && d.paint === 'gloss-black' && d.role === 'trim'; }).map(function (d) { return bounds([d.path]); })[0];
  near(bar.maxB - bar.minB, 0.03, 0.003, 'Boxster lettering bar 0.03 tall'); near(bar.maxA, 0.38, 0.01, 'Boxster bar reaches the lamps');
  var fr = bx.details.filter(function (d) { return d.view === 'top' && d.role === 'fairing' && d.paint === 'body'; });
  assert.equal(fr.length, 2, 'Boxster hoop fairings in plan');
  near(bounds([fr[0].path]).minA, -1.55, 0.01, 'Boxster fairing tapers back to x -1.55');
});

// Optional integration with core.js when present.
var corePath = path.join(ROOT, 'core.js');
if (fs.existsSync(corePath)) {
  test('roadster: core.js integration (fit / toSvgPath / modelsByStyle)', function () {
    var core = require(corePath);
    var S = CB.shapes;
    if (typeof S.registerModel !== 'function') return;
    // core drains _pending on load; make sure ours are registered either way
    MODELS.forEach(function (m) { if (!S.models || !S.models[m.id]) S.registerModel(m); });
    if (typeof S.modelsByStyle === 'function') {
      var ids = S.modelsByStyle('roadster').map(function (m) { return m.id; });
      IDS.forEach(function (id) { assert.ok(ids.indexOf(id) >= 0, 'modelsByStyle has ' + id); });
    }
    if (typeof S.toSvgPath === 'function') {
      MODELS.forEach(function (m) {
        var d = S.toSvgPath(m.side.body, { scale: 100, flipY: true, ox: 0, oy: 0 });
        assert.ok(typeof d === 'string' && /^M/.test(d.trim()) && !/NaN|undefined/.test(d), m.id + ' svg path');
      });
    }
    if (typeof S.fit === 'function') {
      MODELS.forEach(function (m) {
        if (typeof S.refBuild === 'function') {
          var f0 = S.fit(m, S.refBuild(m));
          near(f0.side.archF.x, m.side.archF.x, 1e-6, m.id + ' refBuild keeps front axle');
          near(f0.side.archR.r, m.side.archR.r, 1e-3, m.id + ' refBuild keeps rear arch');
          near(f0.dims.wheelbase, m.ref.wheelbase, 1e-6, m.id + ' refBuild wheelbase');
        }
        var build = { body: { style: 'roadster', model: m.id, wheelbase_mm: Math.round(m.ref.wheelbase * 1000) + 100, trackWidth_mm: 1560 },
          suspension: { rideHeight_mm: 110 }, wheels: { diameter_in: m.ref.wheelDiameter_in + 1 }, tires: {} };
        var f = S.fit(m, build);
        near(f.side.archF.x - f.side.archR.x, m.ref.wheelbase + 0.1, 1e-3, m.id + ' fitted wheelbase');
        assert.ok(f && f.side && f.side.body, m.id + ' fitted');
        collectPaths({ side: f.side, top: f.top, front: f.front, rear: f.rear }).forEach(function (p) {
          eachPoint(p, function (q) { assert.ok(isFinite(q[0]) && isFinite(q[1]), m.id + ' fitted finite'); });
        });
        if (f.dims) Object.keys(f.dims).forEach(function (k) { if (typeof f.dims[k] === 'number') assert.ok(isFinite(f.dims[k]), m.id + ' dims.' + k); });
      });
    }
    void core;
  });
}

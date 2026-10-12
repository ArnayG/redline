/* Node tests for js/shapes/models/pack-jdm.js (JDM drift pack) — run: node tests/run.js shapes-jdm */
'use strict';
var path = require('path');
var MODEL_FILE = path.join(__dirname, '..', 'js', 'shapes', 'models', 'pack-jdm.js');

/* Load the pack standalone (registerModel hidden) so the models land on _pending, then restore. */
function loadStandalone() {
  var CB = (globalThis.CB = globalThis.CB || {});
  CB.shapes = CB.shapes || {};
  var savedReg = CB.shapes.registerModel, savedPending = CB.shapes._pending;
  delete CB.shapes.registerModel;
  CB.shapes._pending = [];
  delete require.cache[require.resolve(MODEL_FILE)];
  var exported = require(MODEL_FILE);
  var pending = CB.shapes._pending;
  if (savedReg) CB.shapes.registerModel = savedReg;
  CB.shapes._pending = savedPending;
  return { exported: exported, pending: pending };
}
var loaded = loadStandalone();
var models = loaded.exported.models;
var IDS = ['nissan-silvia-s15', 'nissan-skyline-gtr-r34', 'toyota-sprinter-trueno-ae86', 'mazda-rx7-fd3s', 'nissan-gtr-r35'];
var STYLE = { 'nissan-silvia-s15': 'coupe', 'nissan-skyline-gtr-r34': 'coupe', 'toyota-sprinter-trueno-ae86': 'hatchback', 'mazda-rx7-fd3s': 'coupe', 'nissan-gtr-r35': 'coupe' };
function byId(id) { return models[IDS.indexOf(id)]; }

function isPath(v) { return Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && typeof v[0].t === 'string' && Array.isArray(v[0].p); }
function itemPaths(slot) {
  if (!slot) return [];
  if (isPath(slot)) return [slot];
  if (Array.isArray(slot)) return slot.reduce(function (a, s) { return a.concat(itemPaths(s)); }, []);
  if (slot.path) return [slot.path];
  return [];
}
function walkPaths(v, cb, where) {
  if (isPath(v)) return cb(v, where);
  if (Array.isArray(v)) return v.forEach(function (e, i) { walkPaths(e, cb, where + '[' + i + ']'); });
  if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { walkPaths(v[k], cb, where + '.' + k); });
}
function samples(p) {
  var out = [], cur = [0, 0], start = [0, 0];
  p.forEach(function (s) {
    if (s.t === 'M') { cur = s.p[0]; start = cur; out.push(cur); }
    else if (s.t === 'L') { cur = s.p[0]; out.push(cur); }
    else if (s.t === 'Z') { cur = start; }
    else {
      for (var i = 1; i <= 16; i++) {
        var t = i / 16, u = 1 - t, q;
        if (s.t === 'C') { var a = s.p[0], b = s.p[1], c = s.p[2]; q = [0, 1].map(function (k) { return u * u * u * cur[k] + 3 * u * u * t * a[k] + 3 * u * t * t * b[k] + t * t * t * c[k]; }); }
        else { var a2 = s.p[0], c2 = s.p[1]; q = [0, 1].map(function (k) { return u * u * cur[k] + 2 * u * t * a2[k] + t * t * c2[k]; }); }
        out.push(q);
      }
      cur = s.p[s.p.length - 1];
    }
  });
  return out;
}
function bounds(p) {
  var b = { minA: Infinity, maxA: -Infinity, minB: Infinity, maxB: -Infinity };
  (isPath(p) ? [p] : itemPaths(p)).forEach(function (pp) {
    samples(pp).forEach(function (q) { b.minA = Math.min(b.minA, q[0]); b.maxA = Math.max(b.maxA, q[0]); b.minB = Math.min(b.minB, q[1]); b.maxB = Math.max(b.maxB, q[1]); });
  });
  return b;
}
function tireDia(s) { var m = String(s).match(/(\d{3})\/(\d{2})Z?R(\d{2})/); return +m[3] * 0.0254 + 2 * (+m[1]) * (+m[2]) / 100000; }
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, msg + ': ' + a.toFixed(4) + ' vs ' + b.toFixed(4) + ' (tol ' + tol + ')'); }
function crossings(p, x) {
  var ys = [], pts = samples(p);
  for (var i = 1; i < pts.length; i++) {
    var a = pts[i - 1], b = pts[i];
    if ((a[0] - x) * (b[0] - x) <= 0 && a[0] !== b[0]) ys.push(a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]));
  }
  return ys;
}
function topAt(p, x) { return Math.max.apply(null, crossings(p, x).concat([-Infinity])); }
function halfW(p, x) { return Math.max.apply(null, crossings(p, x).map(Math.abs).concat([0])); }

test('shapes-jdm: exports and queues the five real JDM drift cars with required fields', function () {
  assert.deepEqual(models.map(function (m) { return m.id; }), IDS);
  assert.deepEqual(loaded.pending.map(function (m) { return m.id; }), IDS, 'queued on CB.shapes._pending when core.js is absent');
  models.forEach(function (m) {
    assert.equal(m.style, STYLE[m.id], m.id + ' style');
    assert.ok(!m.default, m.id + ' must not be a style default');
    ['make', 'name', 'gen', 'years', 'enginePosition', 'drivetrain', 'powertrain'].forEach(function (k) { assert.ok(m[k], m.id + ' ' + k); });
    assert.ok(['front', 'mid', 'rear'].indexOf(m.enginePosition) >= 0, m.id + ' enginePosition in data vocabulary');
    ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR', 'frontOverhang', 'rearOverhang', 'cd', 'curbWeight_kg', 'rideHeight', 'groundClearance'].forEach(function (k) {
      assert.ok(typeof m.ref[k] === 'number' && m.ref[k] > 0, m.id + ' ref.' + k);
    });
    near(m.ref.frontOverhang + m.ref.wheelbase + m.ref.rearOverhang, m.ref.length, 0.002, m.id + ' overhangs+wb = length');
    ['body', 'greenhouse', 'sill'].forEach(function (k) { assert.ok(isPath(m.side[k]), m.id + ' side.' + k); });
    ['windows', 'pillars', 'doorCuts', 'panelLines', 'characterLines', 'lowerTrim'].forEach(function (k) { assert.ok(m.side[k].length > 0, m.id + ' side.' + k); });
    ['body', 'greenhouse', 'hood', 'roof', 'deck'].forEach(function (k) { assert.ok(isPath(m.top[k]), m.id + ' top.' + k); });
    assert.equal(m.top.mirrors.length, 2);
    ['body', 'greenhouse', 'bumper', 'plateArea', 'badgeArea'].forEach(function (k) { assert.ok(isPath(m.front[k]), m.id + ' front.' + k); });
    assert.ok(m.front.headlights.length >= 2 && m.front.drl.length >= 2 && m.front.grille.length >= 1 && m.front.intakes.length >= 1, m.id + ' front lamps/grille');
    ['body', 'greenhouse', 'bumper', 'diffuser', 'plateArea', 'badgeArea'].forEach(function (k) { assert.ok(isPath(m.rear[k]), m.id + ' rear.' + k); });
    assert.ok(m.rear.taillights.length >= 2 && m.rear.exhaust.length >= 1, m.id + ' tail lamps / exhaust');
    m.rear.exhaust.forEach(function (e) { assert.ok(['round', 'oval', 'trapezoid', 'hidden'].indexOf(e.shape) >= 0 && e.w > 0 && e.h > 0, m.id + ' exhaust'); });
    m.details.forEach(function (d) { assert.ok(['side', 'top', 'front', 'rear'].indexOf(d.view) >= 0 && d.role && d.paint && isPath(d.path), m.id + ' detail'); });
    ['headlights', 'taillights', 'grille', 'notes'].forEach(function (k) { assert.ok(m.signature[k], m.id + ' signature.' + k); });
    assert.ok(m.wheel && /^#[0-9a-f]{6}$/i.test(m.wheel.caliper) && m.wheel.style, m.id + ' wheel');
    assert.ok(/^#[0-9a-f]{6}$/i.test(m.color) && m.colorName, m.id + ' launch colour');
  });
});

test('shapes-jdm: published dimensions (catalogue values)', function () {
  var P = {
    'nissan-silvia-s15': [4.445, 1.695, 1.285, 2.525, 1.480, 1.470, '205/55R16'],
    'nissan-skyline-gtr-r34': [4.600, 1.785, 1.360, 2.665, 1.480, 1.490, '245/40ZR18'],
    'toyota-sprinter-trueno-ae86': [4.205, 1.625, 1.335, 2.400, 1.355, 1.345, '185/60R14'],
    'mazda-rx7-fd3s': [4.285, 1.760, 1.230, 2.425, 1.460, 1.460, '235/45ZR17'],
    'nissan-gtr-r35': [4.710, 1.895, 1.370, 2.780, 1.590, 1.600, '255/40ZR20']
  };
  models.forEach(function (m) {
    var p = P[m.id], r = m.ref;
    ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR'].forEach(function (k, i) { near(r[k], p[i], 1e-6, m.id + ' ' + k); });
    assert.equal(r.tireF, p[6], m.id + ' front tyre');
  });
  assert.equal(byId('nissan-gtr-r35').ref.tireR, '285/35ZR20', 'R35 staggered rear tyre');
  assert.equal(byId('nissan-skyline-gtr-r34').drivetrain, 'awd');
  assert.equal(byId('nissan-gtr-r35').drivetrain, 'awd');
  ['nissan-silvia-s15', 'toyota-sprinter-trueno-ae86', 'mazda-rx7-fd3s'].forEach(function (id) { assert.equal(byId(id).drivetrain, 'rwd', id + ' rwd'); });
});

test('shapes-jdm: every path is finite and well-formed', function () {
  var counts = { M: 1, L: 1, C: 3, Q: 2, Z: 0 };
  models.forEach(function (m) {
    var n = 0;
    walkPaths({ side: m.side, top: m.top, front: m.front, rear: m.rear, details: m.details }, function (p, where) {
      n++;
      assert.equal(p[0].t, 'M', m.id + where + ' starts with M');
      p.forEach(function (s) {
        assert.ok(s.t in counts, m.id + where + ' bad seg ' + s.t);
        assert.equal(s.p.length, counts[s.t], m.id + where + ' arity');
        s.p.forEach(function (q) { assert.ok(q.length === 2 && isFinite(q[0]) && isFinite(q[1]), m.id + where + ' finite'); });
      });
    }, '');
    assert.ok(n > 60, m.id + ' has ' + n + ' paths');
  });
});

test('shapes-jdm: side body matches published length, height, overhangs (1%)', function () {
  models.forEach(function (m) {
    var b = bounds(m.side.body), r = m.ref;
    near(b.maxA - b.minA, r.length, r.length * 0.01, m.id + ' length');
    near(b.maxB, r.height, r.height * 0.01, m.id + ' height');
    near(b.maxA, r.wheelbase / 2 + r.frontOverhang, r.length * 0.01, m.id + ' front bumper x');
    near(b.minA, -(r.wheelbase / 2 + r.rearOverhang), r.length * 0.01, m.id + ' rear bumper x');
    assert.ok(b.minB > 0.08 && b.minB < 0.25, m.id + ' body clears the ground: ' + b.minB);
  });
});

test('shapes-jdm: wheel arches centred on axles and sized for the real tyres', function () {
  models.forEach(function (m) {
    var r = m.ref;
    [['archF', r.tireF, 1], ['archR', r.tireR, -1]].forEach(function (a) {
      var arch = m.side[a[0]], tr = tireDia(a[1]) / 2;
      near(arch.x, a[2] * r.wheelbase / 2, 0.002, m.id + ' ' + a[0] + ' x');
      near(arch.y, tr, 0.005, m.id + ' ' + a[0] + ' centre height = tyre radius');
      assert.ok(arch.r >= tr + 0.015 && arch.r <= tr + 0.08, m.id + ' ' + a[0] + ' radius ' + arch.r + ' for tyre r ' + tr);
      samples(m.side.body).forEach(function (q) {
        assert.ok(Math.hypot(q[0] - arch.x, q[1] - arch.y) >= tr + 0.01, m.id + ' body point inside ' + a[0] + ' tyre at ' + q);
      });
    });
  });
});

test('shapes-jdm: top view width/length to scale; mirrors outside the body', function () {
  models.forEach(function (m) {
    var b = bounds(m.top.body);
    near(b.maxB - b.minB, m.ref.width, m.ref.width * 0.01, m.id + ' plan width');
    near(b.maxB, -b.minB, 0.002, m.id + ' plan symmetric');
    near(b.maxA - b.minA, m.ref.length, m.ref.length * 0.01, m.id + ' plan length');
    assert.ok(bounds(m.top.mirrors[0]).maxB > m.ref.width / 2 + 0.05, m.id + ' mirror sticks out');
    assert.ok(m.top.roof.some(function (s) { return s.t === 'L'; }), m.id + ' roof sides are straight');
    var g = bounds(m.top.greenhouse);
    assert.ok(g.maxB < m.ref.width / 2 - 0.1, m.id + ' plan greenhouse inset (tumblehome)');
  });
});

test('shapes-jdm: front & rear views symmetric about z=0 and to scale', function () {
  models.forEach(function (m) {
    ['front', 'rear'].forEach(function (v) {
      var b = bounds(m[v].body);
      near(b.maxA, -b.minA, 0.002, m.id + ' ' + v + ' body symmetric');
      near(b.maxA - b.minA, m.ref.width, m.ref.width * 0.01, m.id + ' ' + v + ' width');
      near(b.maxB, m.ref.height, m.ref.height * 0.01, m.id + ' ' + v + ' height');
      ['greenhouse', 'bumper', 'plateArea', 'badgeArea'].forEach(function (k) {
        var bb = bounds(m[v][k]);
        near(bb.maxA, -bb.minA, 0.003, m.id + ' ' + v + '.' + k + ' symmetric');
      });
      ['headlights', 'drl', 'intakes', 'grille', 'taillights', 'fogLights'].forEach(function (k) {
        if (!m[v][k]) return;
        var bb = bounds(m[v][k]);
        near(bb.maxA, -bb.minA, 0.003, m.id + ' ' + v + '.' + k + ' symmetric');
        assert.ok(bb.maxA <= m.ref.width / 2 + 0.002, m.id + ' ' + v + '.' + k + ' inside the body width');
      });
    });
    // lamps sit inside the outline
    var fb = bounds(m.front.headlights), rb = bounds(m.rear.taillights);
    assert.ok(fb.maxB < m.ref.height * 0.7 && rb.maxB < m.ref.height * 0.8, m.id + ' lamps below the glass');
  });
});

test('shapes-jdm: side greenhouse is the daylight opening only, with a gloss-black B-pillar', function () {
  models.forEach(function (m) {
    var g = bounds(m.side.greenhouse), H = m.ref.height;
    samples(m.side.greenhouse).forEach(function (q) { assert.ok(q[1] < topAt(m.side.body, q[0]) - 0.012, m.id + ' greenhouse point ' + q + ' under the roof skin'); });
    m.side.windows.forEach(function (w) { var b = bounds(w); assert.ok(b.minA >= g.minA - 0.03 && b.maxA <= g.maxA + 0.03, m.id + ' window inside DLO'); });
    assert.ok(H - g.maxB > 0.02 && H - g.maxB < 0.08, m.id + ' DLO top just under the roof');
    assert.ok(m.details.some(function (d) { return d.view === 'side' && d.paint === 'gloss-black' && bounds(d.path).maxB > H - 0.1; }), m.id + ' gloss-black B-pillar');
  });
});

test('shapes-jdm: explicit 3D sections (wing crowns, arch cut-outs, glass) stay inside the silhouette', function () {
  models.forEach(function (m) {
    assert.ok(m.sections && m.sections.length >= 60, m.id + ' sections');
    var n = m.sections[0].ring.length;
    m.sections.forEach(function (s, i) {
      assert.equal(s.ring.length, n, m.id + ' ring size');
      assert.ok(s.ring.every(function (q) { return isFinite(q[0]) && isFinite(q[1]); }), m.id + ' finite ring');
      if (i) assert.ok(s.x > m.sections[i - 1].x, m.id + ' stations ascending');
      if (s.glass) assert.equal(s.glass.length, n, m.id + ' glass flags');
      var yTop = Math.max.apply(null, s.ring.map(function (q) { return q[0]; }));
      assert.ok(yTop <= topAt(m.side.body, s.x) + 0.012, m.id + ' ring top above silhouette at x=' + s.x);
      // ring symmetric (right half mirrored)
      for (var k = 1; k < n / 2; k++) near(s.ring[k][1], -s.ring[n - k][1], 1e-4, m.id + ' ring symmetric');
      var zMax = Math.max.apply(null, s.ring.map(function (q) { return Math.abs(q[1]); }));
      assert.ok(zMax <= m.ref.width / 2 + 0.005, m.id + ' ring inside plan width');
    });
    function sec(x) { return m.sections.reduce(function (a, s) { return Math.abs(s.x - x) < Math.abs(a.x - x) ? s : a; }); }
    var sF = sec(m.ref.wheelbase / 2 + 0.25);
    var yMid = Math.max.apply(null, sF.ring.filter(function (q) { return Math.abs(q[1]) < 0.05; }).map(function (q) { return q[0]; }));
    var yWing = Math.max.apply(null, sF.ring.filter(function (q) { return Math.abs(q[1]) > 0.45; }).map(function (q) { return q[0]; }));
    assert.ok(yWing > yMid + 0.02, m.id + ' wing crown ' + yWing.toFixed(3) + ' above bonnet ' + yMid.toFixed(3));
    var sA = sec(m.ref.wheelbase / 2), zLow = Math.max.apply(null, sA.ring.filter(function (q) { return q[0] < 0.4; }).map(function (q) { return q[1]; }));
    assert.ok(zLow < m.ref.trackF / 2, m.id + ' arch cut-out at the front axle');
    assert.ok(m.sections.some(function (s) { return s.glass && s.glass.some(Boolean); }), m.id + ' glass flagged');
  });
});

test('shapes-jdm: signature features', function () {
  var s15 = byId('nissan-silvia-s15'), r34 = byId('nissan-skyline-gtr-r34'), ae = byId('toyota-sprinter-trueno-ae86'), fd = byId('mazda-rx7-fd3s'), r35 = byId('nissan-gtr-r35');
  // S15: swept lamps, tall outer end, thin inner end; wedge bonnet climbing to the scuttle; Spec-R boot wing
  var hl = samples(s15.front.headlights[0]);
  function hAt(pts, z) { var ys = pts.filter(function (q) { return Math.abs(q[0] - z) < 0.03; }).map(function (q) { return q[1]; }); return Math.max.apply(null, ys) - Math.min.apply(null, ys); }
  assert.ok(hAt(hl, 0.80) > hAt(hl, 0.34) + 0.04, 'S15 lamp taller at the outer end');
  assert.ok(topAt(s15.side.body, 1.95) < topAt(s15.side.body, 1.30) && topAt(s15.side.body, 1.30) < topAt(s15.side.body, 0.90), 'S15 rising wedge bonnet');
  assert.ok(s15.rear.spoiler && bounds(s15.rear.spoiler).maxB > topAt(s15.side.body, -2.1) + 0.03, 'S15 boot wing above the deck');
  assert.equal(s15.rear.exhaust.length, 1); assert.ok(s15.rear.exhaust[0].cx < 0, 'S15 single tailpipe on the left');
  // R34: four round tail lamps, tall wing, wing vents, upright tall nose
  assert.equal(r34.rear.taillights.length, 4, 'R34 four round lamps');
  r34.rear.taillights.forEach(function (p) { var b = bounds(p); near(b.maxA - b.minA, b.maxB - b.minB, 0.002, 'R34 round lamp'); });
  assert.ok(bounds(r34.rear.spoiler).maxB > 1.12, 'R34 tall wing');
  assert.ok(r34.details.some(function (d) { return d.view === 'side' && d.role === 'vent' && bounds(d.path).minA > r34.ref.wheelbase / 2 - 0.6; }), 'R34 wing vent behind the front wheel');
  assert.ok(topAt(r34.side.body, 2.25) > 0.70, 'R34 tall blunt nose');
  // AE86: hatchback, pop-up headlamps, liftback slope, slats instead of a grille, long rear overhang
  assert.equal(ae.style, 'hatchback'); assert.equal(ae.doors, 3); assert.ok(ae.popUpHeadlights);
  assert.ok(itemPaths(ae.front.popupLamps).length >= 4 && itemPaths(ae.side.popupLamps).length >= 2 && itemPaths(ae.top.popupLamps).length === 2, 'AE86 pop-up pods');
  assert.ok(bounds(ae.front.popupLamps).maxB > bounds(ae.front.headlights).maxB + 0.1, 'AE86 raised pods stand above the parking lamps');
  assert.ok(ae.ref.rearOverhang > ae.ref.frontOverhang + 0.12, 'AE86 long rear overhang');
  var slope = (topAt(ae.side.body, -1.0) - topAt(ae.side.body, -2.0)) / 1.0;
  assert.ok(slope > 0.25 && slope < 0.45, 'AE86 liftback slope ' + slope.toFixed(3));
  assert.ok(ae.details.filter(function (d) { return d.view === 'front' && d.role === 'vent'; }).length >= 3, 'AE86 nose slats');
  // FD: low nose, front-wing hump above the bonnet line, double-bubble roof, triple round lamps per side
  assert.ok(topAt(fd.side.body, 2.10) < 0.48, 'FD very low nose');
  assert.ok(topAt(fd.side.body, 1.21) > topAt(fd.side.body, 0.85) + 0.005, 'FD wing hump');
  var fb = samples(fd.front.body), mid = Math.max.apply(null, fb.filter(function (q) { return Math.abs(q[0]) < 0.02; }).map(function (q) { return q[1]; }));
  assert.ok(fd.ref.height - mid > 0.012, 'FD double-bubble roof dip');
  assert.equal(fd.rear.taillights.length, 4);
  assert.equal(fd.details.filter(function (d) { return d.view === 'rear' && d.paint === 'light-amber'; }).length, 2, 'FD inner amber discs');
  assert.ok(fd.popUpHeadlights && itemPaths(fd.front.popupLamps).length >= 4, 'FD pop-ups');
  assert.ok(halfW(fd.top.body, 1.21) - halfW(fd.top.body, 0.20) > 0.03 && halfW(fd.top.body, -1.21) - halfW(fd.top.body, 0.20) > 0.03, 'FD coke-bottle plan');
  // R35: quad round tailpipes, four ring lamps, V-motion grille wider at the bottom, quarter glass kink
  assert.equal(r35.rear.exhaust.length, 4); assert.ok(r35.rear.exhaust.every(function (e) { return e.shape === 'round'; }));
  assert.equal(r35.rear.taillights.length, 4);
  var gp = samples(r35.front.grille[0]);
  function wAt(y) { return Math.max.apply(null, gp.filter(function (q) { return Math.abs(q[1] - y) < 0.02; }).map(function (q) { return Math.abs(q[0]); })); }
  assert.ok(wAt(0.32) > wAt(0.68) + 0.06, 'R35 V-motion grille flares toward the bottom');
  var qg = samples(r35.side.windows[1]), qMin = Math.min.apply(null, qg.map(function (q) { return q[0]; }));
  assert.ok(qMin < -1.42, 'R35 quarter-glass blade kink');
  // every pack exhaust set is either single (JDM left exit) or symmetric
  models.forEach(function (m) {
    var ex = m.rear.exhaust;
    if (ex.length > 1) near(ex.reduce(function (s, e) { return s + e.cx; }, 0), 0, 1e-6, m.id + ' exhausts symmetric');
  });
});

test('shapes-jdm: integrates with core.js (register / fit / svg / loft), never a style default', function () {
  var S = require(path.join(__dirname, '..', 'js', 'shapes', 'core.js'));
  require(path.join(__dirname, '..', 'js', 'shapes', 'models', 'coupe.js'));
  require(path.join(__dirname, '..', 'js', 'shapes', 'models', 'hatchback.js'));
  models.forEach(function (m) { S.registerModel(m); });
  assert.equal(S.defaultModel('coupe').id, 'porsche-911-992', 'coupe default unchanged');
  assert.notEqual(S.defaultModel('hatchback').id, 'toyota-sprinter-trueno-ae86', 'hatchback default unchanged');
  IDS.forEach(function (id) {
    var m = S.models[id];
    assert.ok(m && S.modelsByStyle(STYLE[id]).indexOf(m) >= 0, id + ' registered under its style');
    assert.equal(S.getModel({ body: { style: STYLE[id], model: id } }, { strict: true }), m);
    var f0 = S.fit(m, S.refBuild(m));
    near(S.bounds(f0.side.body).w, m.ref.length, m.ref.length * 0.01, id + ' fit at ref keeps length');
    var f = S.fit(m, { body: { style: STYLE[id], model: id, wheelbase_mm: 2600, trackWidth_mm: 1550 }, suspension: { rideHeight_mm: 100 },
      wheels: { diameter_in: 18 }, tires: { widthFront_mm: 235, widthRear_mm: 265, profileFront: 40, profileRear: 35 } });
    near(f.dims.wheelbase, 2.60, 0.01, id + ' fitted wheelbase');
    assert.ok(f.front.popupLamps === undefined || itemPaths(f.front.popupLamps).length > 0, id + ' popup slot survives fit');
    ['side', 'top', 'front', 'rear'].forEach(function (v) {
      var svg = S.toSvgPath(f[v].body, { scale: 100, flipY: v !== 'top', flipX: v === 'front' });
      assert.ok(/^M [-\d.]+ [-\d.]+/.test(svg) && svg.indexOf('NaN') < 0, id + ' ' + v + ' svg');
    });
    var hi = S.loftToMesh(S.sectionsFromViews(f));
    assert.ok(hi.triangleCount > 3000 && hi.glass.indices.length > 0, id + ' full-detail loft with glass');
    for (var i = 0; i < hi.positions.length; i++) assert.ok(isFinite(hi.positions[i]), id + ' mesh finite');
    var lo = S.loftToMesh(S.sectionsFromViews(f, { stations: 16, maxStations: 16, ringVerts: 12 }));
    assert.ok(lo.triangleCount > 0 && lo.triangleCount < 400, id + ' low LOD ' + lo.triangleCount);
  });
});

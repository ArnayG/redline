/* Node tests for js/shapes/models/pack-sport.js (Euro sports-car pack) — run: node tests/run.js shapes-euro-sport */
'use strict';
var path = require('path');
// Allow `node tests/shapes-euro-sport.test.js` on its own (tests/run.js normally provides test/assert).
if (typeof globalThis.test !== 'function') {
  globalThis.assert = require('node:assert/strict');
  var _q = []; globalThis.test = function (n, fn) { _q.push([n, fn]); };
  setTimeout(function () {
    var bad = 0;
    _q.forEach(function (t) { try { t[1](); console.log('  ok  ' + t[0]); } catch (e) { bad++; console.log('  FAIL ' + t[0] + '\n    ' + e.message); } });
    console.log(_q.length - bad + ' passed, ' + bad + ' failed'); if (bad) process.exitCode = 1;
  }, 0);
}
var FILE = path.join(__dirname, '..', 'js', 'shapes', 'models', 'pack-sport.js');
var IDS = ['bmw-m2-g87', 'bmw-m3-e46', 'alpine-a110', 'aston-martin-vantage-2018'];
// Loaded lazily (inside the tests) so the pack does not join the shared registry while other suites run.
var _models = null;
// The pack also carries later additions (Lotus Emira, the AWD sedans); this suite covers the four original drift coupes.
function models() { if (!_models) _models = require(FILE).models.filter(function (m) { return IDS.indexOf(m.id) >= 0; }); return _models; }
function byId(id) { return models().filter(function (m) { return m.id === id; })[0]; }

function isPath(v) { return Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && typeof v[0].t === 'string' && Array.isArray(v[0].p); }
function walkPaths(v, cb, where) {
  if (isPath(v)) return cb(v, where);
  if (Array.isArray(v)) return v.forEach(function (e, i) { walkPaths(e, cb, where + '[' + i + ']'); });
  if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { walkPaths(v[k], cb, where + '.' + k); });
}
/* Sampled points of a path (flattening béziers). */
function samples(p) {
  var out = [], cur = [0, 0], start = [0, 0];
  p.forEach(function (s) {
    if (s.t === 'M') { cur = s.p[0]; start = cur; out.push(cur); }
    else if (s.t === 'L') { cur = s.p[0]; out.push(cur); }
    else if (s.t === 'Z') { cur = start; }
    else if (s.t === 'C' || s.t === 'Q') {
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
  samples(p).forEach(function (q) { b.minA = Math.min(b.minA, q[0]); b.maxA = Math.max(b.maxA, q[0]); b.minB = Math.min(b.minB, q[1]); b.maxB = Math.max(b.maxB, q[1]); });
  return b;
}
function unionBounds(list) {
  var b = { minA: Infinity, maxA: -Infinity, minB: Infinity, maxB: -Infinity };
  list.forEach(function (p) { var q = bounds(p); b.minA = Math.min(b.minA, q.minA); b.maxA = Math.max(b.maxA, q.maxA); b.minB = Math.min(b.minB, q.minB); b.maxB = Math.max(b.maxB, q.maxB); });
  return b;
}
function tireDia(s) { var m = String(s).match(/(\d{3})\/(\d{2})Z?R(\d{2})/); return +m[3] * 0.0254 + 2 * (+m[1]) * (+m[2]) / 100000; }
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, msg + ': ' + a.toFixed(4) + ' vs ' + b.toFixed(4) + ' (tol ' + tol + ')'); }
/* Top of the side body silhouette at x. */
function topAt(p, x) {
  var hi = -Infinity, pts = samples(p);
  for (var i = 1; i < pts.length; i++) {
    var a = pts[i - 1], b = pts[i];
    if ((a[0] - x) * (b[0] - x) <= 0 && a[0] !== b[0]) hi = Math.max(hi, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]));
  }
  return hi;
}
/* Plan-view half width at x. */
function halfW(m, x) {
  var hi = 0, pts = samples(m.top.body);
  for (var i = 1; i < pts.length; i++) { var a = pts[i - 1], c = pts[i]; if ((a[0] - x) * (c[0] - x) <= 0 && a[0] !== c[0]) hi = Math.max(hi, Math.abs(a[1] + (c[1] - a[1]) * (x - a[0]) / (c[0] - a[0]))); }
  return hi;
}
function details(m, view, role, paint) { return m.details.filter(function (d) { return d.view === view && (!role || d.role === role) && (!paint || d.paint === paint); }); }

test('shapes-euro-sport: exports the four real Euro sports cars with required fields (none is a style default)', function () {
  assert.deepEqual(models().map(function (m) { return m.id; }), IDS);
  models().forEach(function (m) {
    assert.equal(m.style, 'coupe');
    assert.ok(!m.default, m.id + ' must not claim the coupe default');
    assert.equal(m.drivetrain, 'rwd', m.id + ' rear-wheel drive (drift pack)');
    ['make', 'name', 'gen', 'years', 'enginePosition', 'powertrain'].forEach(function (k) { assert.ok(m[k], m.id + ' ' + k); });
    ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR', 'frontOverhang', 'rearOverhang', 'cd', 'curbWeight_kg', 'rideHeight'].forEach(function (k) {
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
    m.details.forEach(function (d) { assert.ok(['side', 'top', 'front', 'rear'].indexOf(d.view) >= 0 && d.role && d.paint && isPath(d.path), m.id + ' detail'); });
    ['headlights', 'taillights', 'grille', 'notes'].forEach(function (k) { assert.ok(m.signature[k], m.id + ' signature.' + k); });
    assert.ok(m.wheel && /^#[0-9a-f]{6}$/i.test(m.wheel.caliper) && m.wheel.style, m.id + ' wheel style + caliper colour');
  });
});

test('shapes-euro-sport: published reference figures', function () {
  var R = {
    'bmw-m2-g87': [4.580, 1.887, 1.403, 2.747, 1.617, 1.605, '275/35ZR19', '285/30ZR20'],
    'bmw-m3-e46': [4.492, 1.780, 1.372, 2.731, 1.508, 1.525, '225/45ZR18', '255/40ZR18'],
    'alpine-a110': [4.180, 1.798, 1.252, 2.419, 1.557, 1.552, '205/40R18', '235/40R18'],
    'aston-martin-vantage-2018': [4.465, 1.942, 1.273, 2.704, null, null, '255/40ZR20', '295/35ZR20']
  };
  IDS.forEach(function (id) {
    var m = byId(id), e = R[id];
    ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR'].forEach(function (k, i) { if (e[i] != null) near(m.ref[k], e[i], 0.0015, id + ' ' + k); });
    assert.equal(m.ref.tireF, e[6], id + ' front tyre'); assert.equal(m.ref.tireR, e[7], id + ' rear tyre');
    assert.ok(m.ref.trackF < m.ref.width && m.ref.trackR < m.ref.width, id + ' tracks inside the body');
  });
  near(byId('alpine-a110').ref.frontOverhang, 0.911, 0.001, 'A110 front overhang');
  near(byId('alpine-a110').ref.rearOverhang, 0.850, 0.001, 'A110 rear overhang');
  assert.equal(byId('alpine-a110').enginePosition, 'mid');
  assert.ok(byId('alpine-a110').ref.curbWeight_kg < 1150, 'A110 is the lightweight');
});

test('shapes-euro-sport: every path is finite and well-formed', function () {
  var counts = { M: 1, L: 1, C: 3, Q: 2, Z: 0 };
  models().forEach(function (m) {
    var n = 0;
    walkPaths(m, function (p, where) {
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

test('shapes-euro-sport: side body matches published length, height, overhangs (1%)', function () {
  models().forEach(function (m) {
    var b = bounds(m.side.body), r = m.ref;
    near(b.maxA - b.minA, r.length, r.length * 0.01, m.id + ' length');
    near(b.maxB, r.height, r.height * 0.01, m.id + ' height');
    near(b.maxA, r.wheelbase / 2 + r.frontOverhang, r.length * 0.01, m.id + ' front bumper x');
    near(b.minA, -(r.wheelbase / 2 + r.rearOverhang), r.length * 0.01, m.id + ' rear bumper x');
    assert.ok(b.minB > 0.08 && b.minB < 0.25, m.id + ' body clears the ground: ' + b.minB);
  });
});

test('shapes-euro-sport: wheel arches centred on axles and sized for the real tyres', function () {
  models().forEach(function (m) {
    var r = m.ref;
    [['archF', r.tireF, 1], ['archR', r.tireR, -1]].forEach(function (a) {
      var arch = m.side[a[0]], tr = tireDia(a[1]) / 2;
      near(arch.x, a[2] * r.wheelbase / 2, 0.002, m.id + ' ' + a[0] + ' x');
      near(arch.y, tr, 0.005, m.id + ' ' + a[0] + ' centre height = tyre radius');
      assert.ok(arch.r >= tr + 0.015 && arch.r <= tr + 0.08, m.id + ' ' + a[0] + ' radius ' + arch.r + ' for tyre r ' + tr);
      samples(m.side.body).forEach(function (q) {
        var d = Math.hypot(q[0] - arch.x, q[1] - arch.y);
        assert.ok(d >= tr + 0.01, m.id + ' body point inside ' + a[0] + ' tyre at ' + q);
      });
    });
  });
});

test('shapes-euro-sport: top view width/length match, plan symmetric, mirrors outside', function () {
  models().forEach(function (m) {
    var b = bounds(m.top.body);
    near(b.maxB - b.minB, m.ref.width, m.ref.width * 0.01, m.id + ' plan width');
    near(b.maxB, -b.minB, 0.002, m.id + ' plan symmetric');
    near(b.maxA - b.minA, m.ref.length, m.ref.length * 0.01, m.id + ' plan length');
    var mb = bounds(m.top.mirrors[0]);
    assert.ok(mb.maxB > m.ref.width / 2 + 0.05, m.id + ' mirror sticks out');
    // greenhouse, hood, deck and roof stay inside the plan outline
    ['greenhouse', 'hood', 'deck', 'roof'].forEach(function (k) {
      samples(m.top[k]).forEach(function (q) { assert.ok(Math.abs(q[1]) <= halfW(m, q[0]) + 0.005, m.id + ' top.' + k + ' inside plan at ' + q); });
    });
  });
});

test('shapes-euro-sport: front & rear views symmetric about z=0 and to scale', function () {
  models().forEach(function (m) {
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
        var u = unionBounds(m[v][k]);
        near(u.maxA, -u.minA, 0.003, m.id + ' ' + v + '.' + k + ' symmetric');
        assert.ok(u.maxA <= m.ref.width / 2 + 0.002, m.id + ' ' + v + '.' + k + ' inside the body width');
      });
    });
    var ex = m.rear.exhaust.reduce(function (s, e) { return s + e.cx; }, 0);
    near(ex, 0, 1e-6, m.id + ' exhausts symmetric');
  });
});

test('shapes-euro-sport: side greenhouse is the daylight opening only (body-colour roof)', function () {
  models().forEach(function (m) {
    var g = bounds(m.side.greenhouse), pts = samples(m.side.greenhouse);
    var bodyPts = []; (function () { var sp = samples(m.side.body); for (var i = 1; i < sp.length; i++) for (var k = 0; k < 8; k++) bodyPts.push([sp[i - 1][0] + (sp[i][0] - sp[i - 1][0]) * k / 8, sp[i - 1][1] + (sp[i][1] - sp[i - 1][1]) * k / 8]); })();
    pts.forEach(function (q) {
      if (q[1] < g.minB + 0.12 || (q[1] < g.maxB - 0.06 && q[0] > g.minA + 0.35)) return;
      var t = topAt(m.side.body, q[0]);
      assert.ok(q[1] < t, m.id + ' greenhouse point ' + q + ' above the roof line');
      var d = Math.min.apply(null, bodyPts.map(function (r) { return Math.hypot(r[0] - q[0], r[1] - q[1]); }));
      assert.ok(d >= 0.012, m.id + ' greenhouse point ' + q + ' only ' + d.toFixed(4) + ' m from the roof skin');
    });
    m.side.windows.forEach(function (w) { var b = bounds(w); assert.ok(b.minA >= g.minA - 0.03 && b.maxA <= g.maxA + 0.03, m.id + ' window inside DLO'); });
    var qg = bounds(m.side.windows[m.side.windows.length - 1]);
    assert.ok(g.minA >= qg.minA - 0.03, m.id + ' DLO stops at the rearmost glass');
    assert.ok(details(m, 'side', null, 'gloss-black').some(function (d) { return bounds(d.path).maxB > m.ref.height - 0.12; }), m.id + ' gloss-black B-pillar');
  });
});

test('shapes-euro-sport: plan-view roof has straight, rearward-tapering sides', function () {
  models().forEach(function (m) {
    var b = bounds(m.top.roof);
    assert.ok(m.top.roof.some(function (s) { return s.t === 'L'; }), m.id + ' roof sides are straight lines');
    assert.ok(b.maxB > 0.45 && b.maxB < 0.62, m.id + ' roof half-width ' + b.maxB);
    var gb = bounds(m.top.greenhouse);
    assert.ok(b.minA > gb.minA && b.maxA < gb.maxA, m.id + ' roof between windscreen and backlight');
  });
});

test('shapes-euro-sport: explicit 3D sections (wing crowns, arch cut-outs, side glass)', function () {
  models().forEach(function (m) {
    assert.ok(m.sections && m.sections.length >= 60, m.id + ' sections');
    var n = m.sections[0].ring.length;
    m.sections.forEach(function (s, i) {
      assert.equal(s.ring.length, n, m.id + ' ring size');
      assert.ok(s.ring.every(function (q) { return isFinite(q[0]) && isFinite(q[1]); }), m.id + ' finite ring');
      if (i) assert.ok(s.x > m.sections[i - 1].x, m.id + ' stations ascending');
      if (s.glass) assert.equal(s.glass.length, n, m.id + ' glass flags');
      var yTop = Math.max.apply(null, s.ring.map(function (q) { return q[0]; }));
      assert.ok(yTop <= topAt(m.side.body, s.x) + 0.012, m.id + ' ring top ' + yTop.toFixed(3) + ' above silhouette at x=' + s.x);
      var zMax = Math.max.apply(null, s.ring.map(function (q) { return Math.abs(q[1]); }));
      assert.ok(zMax <= m.ref.width / 2 + 0.01, m.id + ' ring inside the plan width at x=' + s.x);
    });
    function sec(x) { return m.sections.reduce(function (a, s) { return Math.abs(s.x - x) < Math.abs(a.x - x) ? s : a; }); }
    var sF = sec(m.ref.wheelbase / 2 + 0.25), yMid = Math.max.apply(null, sF.ring.filter(function (q) { return Math.abs(q[1]) < 0.05; }).map(function (q) { return q[0]; }));
    var yWing = Math.max.apply(null, sF.ring.filter(function (q) { return Math.abs(q[1]) > 0.5; }).map(function (q) { return q[0]; }));
    assert.ok(yWing > yMid + 0.02, m.id + ' wing crown ' + yWing.toFixed(3) + ' above bonnet ' + yMid.toFixed(3));
    var sA = sec(m.ref.wheelbase / 2), zLow = Math.max.apply(null, sA.ring.filter(function (q) { return q[0] < 0.4; }).map(function (q) { return q[1]; }));
    assert.ok(zLow < m.ref.trackF / 2, m.id + ' arch cut-out at the front axle');
    var sB = sec(-m.ref.wheelbase / 2), zLowR = Math.max.apply(null, sB.ring.filter(function (q) { return q[0] < 0.4; }).map(function (q) { return q[1]; }));
    assert.ok(zLowR < m.ref.trackR / 2, m.id + ' arch cut-out at the rear axle');
    assert.ok(m.sections.some(function (s) { return s.glass && s.glass.some(Boolean); }), m.id + ' glass flagged');
  });
});

test('shapes-euro-sport: registers with core.js, fits builds and lofts a mesh', function () {
  var S;
  try { S = require(path.join(__dirname, '..', 'js', 'shapes', 'core.js')); } catch (e) { return; }
  if (!S || typeof S.fit !== 'function') return;
  require(path.join(__dirname, '..', 'js', 'shapes', 'models', 'coupe.js'));   // cached when the suite already loaded it
  IDS.forEach(function (id, i) {
    if (!S.models[id]) S.registerModel(models()[i]);
    var m = S.models[id];
    assert.ok(m, id + ' registered');
    assert.ok(S.modelsByStyle('coupe').indexOf(m) >= 0);
    assert.equal(S.defaultModel('coupe').id, 'porsche-911-992', id + ' leaves the 911 as the coupe default');
    var f0 = S.fit(m, S.refBuild(m)), b0 = S.bounds(f0.side.body);
    near(b0.w, m.ref.length, m.ref.length * 0.01, id + ' fit at ref keeps length');
    var f = S.fit(m, { body: { style: 'coupe', model: id, wheelbase_mm: 2650, trackWidth_mm: 1580 }, suspension: { rideHeight_mm: 100 },
      wheels: { diameter_in: 19 }, tires: { widthFront_mm: 255, widthRear_mm: 285, profileFront: 35, profileRear: 30 } });
    near(f.dims.wheelbase, 2.65, 0.01, id + ' fitted wheelbase');
    var svg = S.toSvgPath(f.side.body, { scale: 100, flipY: true });
    assert.ok(/^M [-\d.]+ [-\d.]+/.test(svg) && svg.indexOf('NaN') < 0, id + ' svg');
    var mesh = S.loftToMesh(S.sectionsFromViews(f));
    assert.ok(mesh.indices.length > 0 && mesh.glass.indices.length > 0, id + ' body + glass mesh');
    for (var k = 0; k < mesh.positions.length; k++) assert.ok(isFinite(mesh.positions[k]), id + ' mesh finite');
    var low = S.loftToMesh(S.sectionsFromViews(f, { stations: 16, maxStations: 16, ringVerts: 12 }));
    assert.ok(low.triangleCount < 600, id + ' low LOD ' + low.triangleCount);
    assert.equal(S.getModel({ body: { style: 'coupe', model: id } }), m);
  });
});

test('shapes-euro-sport: signature features', function () {
  var m2 = byId('bmw-m2-g87'), e46 = byId('bmw-m3-e46'), a110 = byId('alpine-a110'), v = byId('aston-martin-vantage-2018');
  // M2: frameless kidneys in a wide horizontal format, quad tailpipes, box-flared rear hips
  var k = bounds(m2.front.grille[0]);
  assert.ok(k.maxA - k.minA > (k.maxB - k.minB) * 1.05, 'M2 horizontal kidneys');
  assert.equal(m2.rear.exhaust.length, 4, 'M2 quad tailpipes');
  assert.ok(halfW(m2, -1.37) - halfW(m2, 0) > 0.035, 'M2 rear box flares');
  assert.ok(Math.abs(topAt(m2.side.body, 1.9) - topAt(m2.side.body, 1.2)) < 0.12, 'M2 flat bonnet');
  // E46 M3: small upright kidneys, twin round lamps with angel-eye rings, chrome side gill, quad pipes
  var ek = bounds(e46.front.grille[0]);
  assert.ok(ek.maxB - ek.minB < 0.2 && ek.maxA - ek.minA < 0.2, 'E46 small kidneys');
  assert.equal(e46.front.drl.length, 4, 'E46 four angel-eye rings');
  assert.ok(e46.front.fogLights && e46.front.fogLights.length === 2, 'E46 round fog lamps');
  assert.ok(details(e46, 'side', 'vent', 'chrome').length === 1, 'E46 chrome M side gill');
  assert.equal(e46.rear.exhaust.length, 4, 'E46 quad tailpipes');
  // A110: four round-ish front lamps, single central tailpipe, side intake ahead of the rear wheel, screen far forward
  assert.equal(a110.front.headlights.length, 4, 'A110 four front lamps');
  assert.equal(a110.rear.exhaust.length, 1, 'A110 single tailpipe'); assert.equal(a110.rear.exhaust[0].cx, 0);
  var si = details(a110, 'side', 'intake')[0]; assert.ok(si, 'A110 side intake');
  var sb = bounds(si.path); assert.ok(sb.minA > a110.side.archR.x && sb.maxA < a110.side.archR.x + a110.side.archR.r + 0.05 && sb.minB > 0.4, 'A110 intake just ahead of the rear arch');
  assert.ok(a110.ref.wheelbase / 2 - bounds(a110.side.pillars[0]).maxA < 0.65, 'A110 cab-forward windscreen');
  // Vantage: huge low trapezoid mouth, cab-rearward, ducktail, twin outboard tailpipes, side strake behind the front wheel
  var g = bounds(v.front.grille[0]);
  assert.ok(g.maxA - g.minA > 1.2 && g.minB < 0.2 && g.maxB < 0.55, 'Vantage low wide mouth');
  assert.ok(v.ref.wheelbase / 2 - bounds(v.side.pillars[0]).maxA > 0.95, 'Vantage cab-rearward');
  assert.ok(topAt(v.side.body, -2.15) > topAt(v.side.body, -2.07) + 0.008, 'Vantage ducktail');
  assert.ok(v.rear.exhaust.length === 2 && v.rear.exhaust.every(function (e) { return Math.abs(e.cx) > 0.5; }), 'Vantage twin outboard pipes');
  var st = details(v, 'side', 'vent')[0], stb = bounds(st.path);
  assert.ok(stb.minA > v.side.doorCuts.map(bounds)[0].maxA - 0.01 && stb.maxA < v.side.archF.x - v.side.archF.r + 0.04, 'Vantage strake between the door and front arch');
});

test('shapes-euro-sport: brand names are text only (no logo artwork paths)', function () {
  models().forEach(function (m) {
    m.details.forEach(function (d) { assert.ok(!/logo|emblem|roundel/i.test(d.role), m.id + ' no logo detail role ' + d.role); });
    assert.ok(typeof m.make === 'string' && m.make.length > 2);
  });
});

/* ---- renderer look signatures, badges and refinements across both Euro packs (pack-sport + pack-exotic) ---- */
var EXOTIC = path.join(__dirname, '..', 'js', 'shapes', 'models', 'pack-exotic.js');
function allPack() { return require(FILE).models.concat(require(EXOTIC)); }
function packModel(id) { return allPack().filter(function (m) { return m.id === id; })[0]; }
var LOOK_VOCAB = {
  head: ['oval-4pt', 'c-clamp', 'y-blade', 'round-halo', 'slim-led', 'projector-twin', 'quad-round', 'blade'],
  tail: ['light-bar', 'c-ring', 'round-ring', 'slim', 'full-width', 'y-shape', 'vertical', 'quad-round'],
  grille: ['kidney', 'slats', 'honeycomb', 'mesh', 'blanked', 'seven-slot', 'hex', 'horseshoe', 'split-v', 'bar']
};

test('shapes-euro-sport: every Euro pack model carries a real-car look { head, tail, grille }', function () {
  var want = {
    'lamborghini-huracan-evo': ['y-blade', 'y-shape', 'hex'], 'ferrari-296-gtb': ['slim-led', 'slim', 'mesh'],
    'porsche-918-spyder': ['slim-led', 'light-bar', 'mesh'], 'koenigsegg-jesko': ['slim-led', 'c-ring', 'mesh'],
    'audi-r8-v10-gen2': ['blade', 'slim', 'hex'], 'bmw-m2-g87': ['slim-led', 'slim', 'kidney'],
    'bmw-m3-e46': ['projector-twin', 'slim', 'kidney'], 'alpine-a110': ['round-halo', 'slim', 'mesh'],
    'aston-martin-vantage-2018': ['slim-led', 'light-bar', 'mesh'], 'lotus-emira': ['blade', 'c-ring', 'mesh'],
    'subaru-wrx-sti-va': ['c-clamp', 'c-ring', 'hex'], 'mitsubishi-lancer-evo-x': ['projector-twin', 'round-ring', 'split-v']
  };
  var all = allPack();
  assert.equal(all.length, 12);
  all.forEach(function (m) {
    assert.deepEqual(Object.keys(m.look).sort(), ['grille', 'head', 'tail'], m.id + ' look keys');
    Object.keys(LOOK_VOCAB).forEach(function (k) { assert.ok(LOOK_VOCAB[k].indexOf(m.look[k]) >= 0, m.id + ' look.' + k + ' ' + m.look[k]); });
    assert.deepEqual([m.look.head, m.look.tail, m.look.grille], want[m.id], m.id + ' look matches the real car');
  });
});

test('shapes-euro-sport: text-only front/rear badges and side + plan mirror outlines on every Euro pack model', function () {
  allPack().forEach(function (m) {
    ['front', 'rear'].forEach(function (v) {
      var t = m[v].badgeText;
      assert.ok(typeof t === 'string' && /^[A-Z0-9 .\-]{2,16}$/.test(t), m.id + ' ' + v + '.badgeText ' + t);
      assert.ok(isPath(m[v].badgeArea), m.id + ' ' + v + '.badgeArea');
    });
    var sm = details(m, 'side', 'mirror');
    assert.ok(sm.length >= 1, m.id + ' side mirror');
    var b = unionBounds(sm.map(function (d) { return d.path; }));
    assert.ok(b.maxB - b.minB > 0.06 && b.maxA - b.minA > 0.08 && b.maxA - b.minA < 0.35, m.id + ' side mirror size');
    assert.equal(m.top.mirrors.length, 2, m.id + ' plan mirrors');
  });
});

test('shapes-euro-sport: refined R8 / Emira / Evo X silhouettes and crisp 3D tails', function () {
  var r8 = packModel('audi-r8-v10-gen2'), em = packModel('lotus-emira'), evo = packModel('mitsubishi-lancer-evo-x');
  // R8: cab-forward mid-engine stance — screen base close to the front axle, short high engine deck, tall tail
  assert.ok(r8.ref.wheelbase / 2 - bounds(r8.side.pillars[0]).maxA < 0.40, 'R8 cab-forward windscreen');
  assert.ok(topAt(r8.side.body, -1.9) > 1.06, 'R8 high engine deck ' + topAt(r8.side.body, -1.9).toFixed(3));
  assert.ok(topAt(r8.side.body, 2.2) > 0.60, 'R8 tall blunt nose');
  // Emira: blunt nose, not a low point
  var eb = bounds(em.side.body);
  assert.ok(topAt(em.side.body, eb.maxA - 0.06) > 0.60, 'Emira nose height ' + topAt(em.side.body, eb.maxA - 0.06).toFixed(3));
  // Evo X: the shark nose leans forward — most forward point high up, face raked back underneath
  var xb = bounds(evo.side.body), pts = samples(evo.side.body), top = pts.reduce(function (a, q) { return q[0] > a[0] ? q : a; });
  assert.ok(top[1] > 0.65, 'Evo X leading edge high (' + top[1].toFixed(3) + ')');
  var lowX = Math.max.apply(null, pts.filter(function (q) { return Math.abs(q[1] - 0.30) < 0.02; }).map(function (q) { return q[0]; }));
  assert.ok(xb.maxA - lowX > 0.12, 'Evo X face raked back ' + (xb.maxA - lowX).toFixed(3) + ' m under the leading edge');
  // crisp tails: the rearmost full ring (behind it only the two flat-face rings) is still a broad flat panel, not a pinched cap
  [r8, em, packModel('subaru-wrx-sti-va'), evo].forEach(function (m) {
    var s0 = m.sections.filter(function (s) { return s.x - m.sections[0].x > 0.002; })[0], zMax = Math.max.apply(null, s0.ring.map(function (q) { return Math.abs(q[1]); }));
    var ys = s0.ring.map(function (q) { return q[0]; }), h = Math.max.apply(null, ys) - Math.min.apply(null, ys);
    assert.ok(zMax > 0.3 && h > 0.2, m.id + ' tail panel ' + (2 * zMax).toFixed(2) + ' x ' + h.toFixed(2));
  });
});

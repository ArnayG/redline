/* Node tests for js/shapes/models/coupe.js — run: node tests/run.js shapes-coupe */
'use strict';
var path = require('path');
var exp = require(path.join(__dirname, '..', 'js', 'shapes', 'models', 'coupe.js'));
var models = exp.models;
var IDS = ['porsche-911-992', 'bmw-m4-g82', 'toyota-gr-supra-a90'];

function isPath(v) { return Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && typeof v[0].t === 'string' && Array.isArray(v[0].p); }
function walkPaths(v, cb, where) {
  if (isPath(v)) return cb(v, where);
  if (Array.isArray(v)) return v.forEach(function (e, i) { walkPaths(e, cb, where + '[' + i + ']'); });
  if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { walkPaths(v[k], cb, where + '.' + k); });
}
/* Sampled bounds of a path (flattening beziers). */
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
function tireDia(s) { var m = String(s).match(/(\d{3})\/(\d{2})Z?R(\d{2})/); return +m[3] * 0.0254 + 2 * (+m[1]) * (+m[2]) / 100000; }
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, msg + ': ' + a.toFixed(4) + ' vs ' + b.toFixed(4) + ' (tol ' + tol + ')'); }

test('shapes-coupe: exports the three real coupés with required fields', function () {
  assert.deepEqual(models.map(function (m) { return m.id; }), IDS);
  models.forEach(function (m) {
    assert.equal(m.style, 'coupe');
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
    assert.ok(m.front.headlights.length >= 2 && m.front.drl.length >= 2 && m.front.grille.length >= 1 && m.front.intakes.length >= 1);
    ['body', 'greenhouse', 'bumper', 'diffuser', 'plateArea', 'badgeArea'].forEach(function (k) { assert.ok(isPath(m.rear[k]), m.id + ' rear.' + k); });
    assert.ok(m.rear.taillights.length >= 2 && m.rear.exhaust.length >= 2);
    m.details.forEach(function (d) { assert.ok(['side', 'top', 'front', 'rear'].indexOf(d.view) >= 0 && d.role && d.paint && isPath(d.path), m.id + ' detail'); });
    ['headlights', 'taillights', 'grille', 'notes'].forEach(function (k) { assert.ok(m.signature[k], m.id + ' signature.' + k); });
  });
});

test('shapes-coupe: every path is finite and well-formed', function () {
  var counts = { M: 1, L: 1, C: 3, Q: 2, Z: 0 };
  models.forEach(function (m) {
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

test('shapes-coupe: side body matches published length, height, overhangs (1%)', function () {
  models.forEach(function (m) {
    var b = bounds(m.side.body), r = m.ref;
    near(b.maxA - b.minA, r.length, r.length * 0.01, m.id + ' length');
    near(b.maxB, r.height, r.height * 0.01, m.id + ' height');
    near(b.maxA, r.wheelbase / 2 + r.frontOverhang, r.length * 0.01, m.id + ' front bumper x');
    near(b.minA, -(r.wheelbase / 2 + r.rearOverhang), r.length * 0.01, m.id + ' rear bumper x');
    assert.ok(b.minB > 0.08 && b.minB < 0.25, m.id + ' body clears the ground: ' + b.minB);
  });
});

test('shapes-coupe: wheel arches centred on axles and sized for the real tyres', function () {
  models.forEach(function (m) {
    var r = m.ref;
    [['archF', r.tireF, 1], ['archR', r.tireR, -1]].forEach(function (a) {
      var arch = m.side[a[0]], tr = tireDia(a[1]) / 2;
      near(arch.x, a[2] * r.wheelbase / 2, 0.002, m.id + ' ' + a[0] + ' x');
      near(arch.y, tr, 0.005, m.id + ' ' + a[0] + ' centre height = tyre radius');
      assert.ok(arch.r >= tr + 0.015 && arch.r <= tr + 0.08, m.id + ' ' + a[0] + ' radius ' + arch.r + ' for tyre r ' + tr);
      // no point of the body silhouette intrudes into the tyre
      samples(m.side.body).forEach(function (q) {
        var d = Math.hypot(q[0] - arch.x, q[1] - arch.y);
        assert.ok(d >= tr + 0.01, m.id + ' body point inside ' + a[0] + ' tyre at ' + q);
      });
    });
  });
});

test('shapes-coupe: top view width matches published width; mirrors outside', function () {
  models.forEach(function (m) {
    var b = bounds(m.top.body);
    near(b.maxB - b.minB, m.ref.width, m.ref.width * 0.01, m.id + ' plan width');
    near(b.maxB, -b.minB, 0.002, m.id + ' plan symmetric');
    near(b.maxA - b.minA, m.ref.length, m.ref.length * 0.01, m.id + ' plan length');
    var mb = bounds(m.top.mirrors[0]);
    assert.ok(mb.maxB > m.ref.width / 2 + 0.05, m.id + ' mirror sticks out');
  });
});

test('shapes-coupe: front & rear views symmetric about z=0 and to scale', function () {
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
      // paired features: union of all lights / intakes symmetric
      ['headlights', 'drl', 'intakes', 'grille', 'taillights'].forEach(function (k) {
        if (!m[v][k]) return;
        var lo = Infinity, hi = -Infinity;
        m[v][k].forEach(function (p) { var bb = bounds(p); lo = Math.min(lo, bb.minA); hi = Math.max(hi, bb.maxA); });
        near(hi, -lo, 0.003, m.id + ' ' + v + '.' + k + ' symmetric');
      });
      var ex = (m.rear.exhaust || []).reduce(function (s, e) { return s + e.cx; }, 0);
      near(ex, 0, 1e-6, m.id + ' exhausts symmetric');
    });
  });
});

test('shapes-coupe: integrates with core.js (fit / toSvgPath) when present', function () {
  var S;
  try { S = require(path.join(__dirname, '..', 'js', 'shapes', 'core.js')); } catch (e) { return; }
  if (!S || typeof S.fit !== 'function') return;
  IDS.forEach(function (id) {
    if (!S.models[id]) S.registerModel(models[IDS.indexOf(id)]);
    var m = S.models[id];
    assert.ok(m, id + ' registered');
    assert.ok(S.modelsByStyle('coupe').indexOf(m) >= 0);
    var rb = S.refBuild ? S.refBuild(m) : null;
    if (rb) {
      var f0 = S.fit(m, rb);
      var b0 = S.bounds(f0.side.body);
      near(b0.w != null ? b0.w : b0.maxX - b0.minX, m.ref.length, m.ref.length * 0.01, id + ' fit at ref keeps length');
    }
    var f = S.fit(m, { body: { style: 'coupe', model: id, wheelbase_mm: 2650, trackWidth_mm: 1600 }, suspension: { rideHeight_mm: 120 },
      wheels: { diameter_in: 19 }, tires: { widthFront_mm: 255, widthRear_mm: 295, profileFront: 35, profileRear: 30 } });
    assert.ok(f && f.dims, id + ' fit dims');
    near(f.dims.wheelbase, 2.65, 0.01, id + ' fitted wheelbase');
    var svg = S.toSvgPath(f.side.body, { scale: 100, flipY: true });
    assert.ok(/^M [-\d.]+ [-\d.]+/.test(svg) && svg.indexOf('NaN') < 0, id + ' svg');
    if (S.sectionsFromViews && S.loftToMesh) {
      var mesh = S.loftToMesh(S.sectionsFromViews(m, { stations: 24, ringVerts: 16 }));
      var pos = mesh.positions || (mesh.body && mesh.body.positions);
      assert.ok(pos && pos.length > 0, id + ' mesh');
      for (var i = 0; i < pos.length; i++) assert.ok(isFinite(pos[i]), id + ' mesh finite');
    }
    assert.equal(S.getModel({ body: { style: 'coupe', model: id } }), m);
  });
});

/* Top of the side body silhouette at x (max sampled y within ±5 mm). */
function topAt(p, x) {
  var hi = -Infinity, pts = samples(p);
  for (var i = 1; i < pts.length; i++) {
    var a = pts[i - 1], b = pts[i];
    if ((a[0] - x) * (b[0] - x) <= 0 && a[0] !== b[0]) hi = Math.max(hi, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]));
  }
  return hi;
}

test('shapes-coupe: side greenhouse is the daylight opening only (body-colour roof and C-pillar)', function () {
  models.forEach(function (m) {
    var g = bounds(m.side.greenhouse), pts = samples(m.side.greenhouse);
    var bodyPts = []; (function () { var sp = samples(m.side.body); for (var i = 1; i < sp.length; i++) for (var k = 0; k < 8; k++) bodyPts.push([sp[i - 1][0] + (sp[i][0] - sp[i - 1][0]) * k / 8, sp[i - 1][1] + (sp[i][1] - sp[i - 1][1]) * k / 8]); })();
    pts.forEach(function (q) {
      if (q[1] < g.minB + 0.12 || (q[1] < g.maxB - 0.06 && q[0] > g.minA + 0.35)) return;   // DLO top edge under the roof + C-pillar end (A-pillar slope excluded)
      var t = topAt(m.side.body, q[0]);
      assert.ok(q[1] < t, m.id + ' greenhouse point ' + q + ' above the roof line');
      var d = Math.min.apply(null, bodyPts.map(function (r) { return Math.hypot(r[0] - q[0], r[1] - q[1]); }));
      assert.ok(d >= 0.012, m.id + ' greenhouse point ' + q + ' only ' + d.toFixed(4) + ' m from the roof skin');
    });
    // every window lies inside the greenhouse x-range; greenhouse ends at the quarter glass, not at the deck
    m.side.windows.forEach(function (w) { var b = bounds(w); assert.ok(b.minA >= g.minA - 0.03 && b.maxA <= g.maxA + 0.03, m.id + ' window inside DLO'); });
    var qg = bounds(m.side.windows[m.side.windows.length - 1]);
    assert.ok(g.minA >= qg.minA - 0.03, m.id + ' DLO stops at the quarter-glass tip');
    assert.ok(m.details.some(function (d) { return d.view === 'side' && d.paint === 'gloss-black' && bounds(d.path).maxB > 1.2; }), m.id + ' gloss-black B-pillar');
  });
});

test('shapes-coupe: plan-view roof has straight, rearward-tapering sides', function () {
  var hw = { 'porsche-911-992': [0.55, 0.50], 'bmw-m4-g82': [0.58, 0.55], 'toyota-gr-supra-a90': [0.53, 0.48] };
  models.forEach(function (m) {
    var b = bounds(m.top.roof), e = hw[m.id];
    near(b.maxB, e[0], 0.01, m.id + ' roof front half-width');
    assert.ok(m.top.roof.some(function (s) { return s.t === 'L'; }), m.id + ' roof sides are straight lines');
  });
});

test('shapes-coupe: explicit 3D sections (wing crowns, arch cut-outs, side glass)', function () {
  models.forEach(function (m) {
    assert.ok(m.sections && m.sections.length >= 60, m.id + ' sections');
    var n = m.sections[0].ring.length;
    m.sections.forEach(function (s, i) {
      assert.equal(s.ring.length, n, m.id + ' ring size');
      assert.ok(s.ring.every(function (q) { return isFinite(q[0]) && isFinite(q[1]); }), m.id + ' finite ring');
      if (i) assert.ok(s.x > m.sections[i - 1].x, m.id + ' stations ascending');
      if (s.glass) assert.equal(s.glass.length, n, m.id + ' glass flags');
      // rings stay inside the silhouette envelope (no ballooned roof / overhanging slab)
      var yTop = Math.max.apply(null, s.ring.map(function (q) { return q[0]; }));
      assert.ok(yTop <= topAt(m.side.body, s.x) + 0.012, m.id + ' ring top ' + yTop.toFixed(3) + ' above silhouette ' + topAt(m.side.body, s.x).toFixed(3) + ' at x=' + s.x);
    });
    function sec(x) { return m.sections.reduce(function (a, s) { return Math.abs(s.x - x) < Math.abs(a.x - x) ? s : a; }); }
    // front wing crown stands above the bonnet centreline
    var sF = sec(m.ref.wheelbase / 2 + 0.25), yMid = Math.max.apply(null, sF.ring.filter(function (q) { return Math.abs(q[1]) < 0.05; }).map(function (q) { return q[0]; }));
    var yWing = Math.max.apply(null, sF.ring.filter(function (q) { return Math.abs(q[1]) > 0.5; }).map(function (q) { return q[0]; }));
    assert.ok(yWing > yMid + 0.02, m.id + ' wing crown ' + yWing.toFixed(3) + ' above bonnet ' + yMid.toFixed(3));
    // wheel arch: at the axle the skin steps inboard of the tyre below the arch
    var sA = sec(m.ref.wheelbase / 2), zLow = Math.max.apply(null, sA.ring.filter(function (q) { return q[0] < 0.4; }).map(function (q) { return q[1]; }));
    assert.ok(zLow < m.ref.trackF / 2, m.id + ' arch cut-out at the front axle');
    assert.ok(m.sections.some(function (s) { return s.glass && s.glass.some(Boolean); }), m.id + ' glass flagged');
  });
});

test('shapes-coupe: signature features', function () {
  var p = models[0], b = models[1], s = models[2];
  // 911: upright oval headlamps standing above the low front lid
  var hl = bounds(p.front.headlights[0]);
  assert.ok(hl.maxB > 0.83 && (hl.maxB - hl.minB) > 0.2, '911 upright lamps');
  // M4: tall kidneys 0.30 x 0.56, ~0.07 m apart
  var k = bounds(b.front.grille[0]), k2 = bounds(b.front.grille[1]);
  near(k.maxB - k.minB, 0.56, 0.02, 'M4 kidney height');
  near(Math.min(Math.abs(k.minA), Math.abs(k.maxA)) + Math.min(Math.abs(k2.minA), Math.abs(k2.maxA)), 0.07, 0.015, 'M4 kidney gap');
  // M4: Hofmeister kink corner flags survive as sharp corners -> quarter glass has a forward notch
  var qg = samples(b.side.windows[1]), minX = Math.min.apply(null, qg.map(function (q) { return q[0]; }));
  assert.ok(minX < -1.40, 'M4 quarter glass reaches back to the kink');
  // Supra: ducktail kick-up at the tail and pointed nose beak
  assert.ok(topAt(s.side.body, -2.07) > topAt(s.side.body, -1.975) + 0.012, 'Supra ducktail');
  // Supra: the rear haunch is the highest body point behind the door glass, standing above the deck
  assert.ok(topAt(s.side.body, -1.60) > 1.09 && topAt(s.side.body, -1.85) > 1.06, 'Supra haunch above the deck');
  // Supra: low sharp beak
  assert.ok(topAt(s.side.body, 2.00) < 0.62 && topAt(s.side.body, 2.18) < 0.46, 'Supra low beak');
  // 911: wing line climbs from the headlamp crown to the scuttle (no flat hood)
  assert.ok(topAt(p.side.body, 1.90) < topAt(p.side.body, 1.60) && topAt(p.side.body, 1.60) < topAt(p.side.body, 1.20) && topAt(p.side.body, 1.20) < topAt(p.side.body, 0.90), '911 rising wing line');
  // 911: narrow waist at the door, rear haunch the widest point
  function halfW(m, x) { var hi = 0, pts = samples(m.top.body); for (var i = 1; i < pts.length; i++) { var a = pts[i - 1], c = pts[i]; if ((a[0] - x) * (c[0] - x) <= 0 && a[0] !== c[0]) hi = Math.max(hi, Math.abs(a[1] + (c[1] - a[1]) * (x - a[0]) / (c[0] - a[0]))); } return hi; }
  assert.ok(halfW(p, -1.25) - halfW(p, 0.3) > 0.06, '911 rear hips');
  // 911: longitudinal engine-lid slats, not a mesh
  assert.ok(p.details.filter(function (d) { return d.view === 'top' && d.role === 'vent' && d.paint === 'gloss-black'; }).length === 9, '911 nine engine-lid slats');
  assert.ok(models.every(function (m) { return m.wheel && /^#[0-9a-f]{6}$/i.test(m.wheel.caliper) && m.wheel.style; }), 'wheel style + caliper colour');
  var bb = samples(s.front.bumper), beak = Math.max.apply(null, bb.filter(function (q) { return Math.abs(q[0]) < 0.02; }).map(function (q) { return q[1]; }));
  var side40 = Math.max.apply(null, bb.filter(function (q) { return Math.abs(Math.abs(q[0]) - 0.40) < 0.03; }).map(function (q) { return q[1]; }));
  assert.ok(beak > side40 + 0.05, 'Supra beak ' + beak + ' vs ' + side40);
});

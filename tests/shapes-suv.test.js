/* Node tests for js/shapes/models/suv.js — run: node tests/run.js shapes-suv
   Loads the model file standalone (models queue on CB.shapes._pending when core.js is absent),
   then checks geometry against each car's published dimensions. */
'use strict';
var path = require('path');
var fs = require('fs');
var MOD = require(path.join(__dirname, '..', 'js', 'shapes', 'models', 'suv.js'));
var CB = globalThis.CB;

var IDS = ['porsche-cayenne-e3', 'range-rover-sport-l461', 'lamborghini-urus'];
var models = MOD.models;
var NPTS = { M: 1, L: 1, C: 3, Q: 2, Z: 0 };

function isPath(v) { return Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && typeof v[0].t === 'string'; }
function eachPath(v, fn, where) {
  if (isPath(v)) return fn(v, where);
  if (Array.isArray(v)) return v.forEach(function (e, i) { eachPath(e, fn, where + '[' + i + ']'); });
  if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { eachPath(v[k], fn, where + '.' + k); });
}
function bez(p0, p1, p2, p3, t) {
  var u = 1 - t;
  return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
          u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
}
/* sampled points along the true curve (not the control polygon) */
function sample(p) {
  var out = [], cur = null, start = null;
  p.forEach(function (s) {
    if (s.t === 'M') { cur = s.p[0]; start = cur; out.push(cur); }
    else if (s.t === 'L') { cur = s.p[0]; out.push(cur); }
    else if (s.t === 'C') { for (var i = 1; i <= 24; i++) out.push(bez(cur, s.p[0], s.p[1], s.p[2], i / 24)); cur = s.p[2]; }
    else if (s.t === 'Q') { var c1 = [cur[0] + 2 / 3 * (s.p[0][0] - cur[0]), cur[1] + 2 / 3 * (s.p[0][1] - cur[1])];
      var c2 = [s.p[1][0] + 2 / 3 * (s.p[0][0] - s.p[1][0]), s.p[1][1] + 2 / 3 * (s.p[0][1] - s.p[1][1])];
      for (var j = 1; j <= 24; j++) out.push(bez(cur, c1, c2, s.p[1], j / 24)); cur = s.p[1]; }
    else if (s.t === 'Z') { cur = start; }
  });
  return out;
}
function bb(p) {
  var b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  sample(p).forEach(function (q) {
    b.minX = Math.min(b.minX, q[0]); b.maxX = Math.max(b.maxX, q[0]);
    b.minY = Math.min(b.minY, q[1]); b.maxY = Math.max(b.maxY, q[1]);
  });
  return b;
}
function tireRadius(s) {
  var m = /^(\d+)\/(\d+)\s*Z?R\s*(\d+)/i.exec(s);
  return (+m[3] * 0.0254 + 2 * (+m[1]) * (+m[2]) / 100000) / 2;
}
function close(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, msg + ': ' + a.toFixed(4) + ' vs ' + b.toFixed(4)); }
function byId(id) { return models.filter(function (m) { return m.id === id; })[0]; }

test('shapes-suv: three real SUVs exported and queued/registered', function () {
  assert.equal(models.length, 3);
  IDS.forEach(function (id) {
    var m = byId(id);
    assert.ok(m, id);
    assert.equal(m.style, 'suv');
    assert.equal(m.enginePosition, 'front');
    ['make', 'name', 'gen', 'years'].forEach(function (k) { assert.equal(typeof m[k], 'string', id + ' ' + k); });
    ['headlights', 'taillights', 'grille', 'notes'].forEach(function (k) { assert.ok(m.signature[k].length > 20, id + ' signature.' + k); });
    var registered = (CB.shapes.models && CB.shapes.models[id]) ||
      (Array.isArray(CB.shapes._pending) && CB.shapes._pending.indexOf(m) >= 0);
    assert.ok(registered, id + ' registered or pending');
  });
});

test('shapes-suv: every path well-formed and finite; all views present', function () {
  models.forEach(function (m) {
    var n = 0;
    ['side', 'top', 'front', 'rear', 'details'].forEach(function (view) {
      eachPath(m[view], function (p, where) {
        n++;
        assert.equal(p[0].t, 'M', m.id + where + ' starts with M');
        p.forEach(function (s, i) {
          assert.ok(s.t in NPTS, m.id + where + ' bad seg ' + s.t);
          assert.equal(s.p.length, NPTS[s.t], m.id + where + ' seg ' + i + ' point count');
          s.p.forEach(function (q) { assert.ok(isFinite(q[0]) && isFinite(q[1]), m.id + where + ' finite'); });
        });
      }, view);
    });
    assert.ok(n > 60, m.id + ' has a rich set of paths (' + n + ')');
    ['body', 'greenhouse', 'windows', 'pillars', 'doorCuts', 'panelLines', 'characterLines', 'sill', 'lowerTrim'].forEach(function (k) { assert.ok(m.side[k], m.id + ' side.' + k); });
    ['body', 'greenhouse', 'hood', 'roof', 'deck', 'mirrors'].forEach(function (k) { assert.ok(m.top[k], m.id + ' top.' + k); });
    ['body', 'greenhouse', 'bumper', 'grille', 'intakes', 'headlights', 'drl', 'plateArea', 'badgeArea'].forEach(function (k) { assert.ok(m.front[k], m.id + ' front.' + k); });
    ['body', 'greenhouse', 'bumper', 'taillights', 'diffuser', 'exhaust', 'plateArea', 'badgeArea'].forEach(function (k) { assert.ok(m.rear[k], m.id + ' rear.' + k); });
    m.rear.exhaust.forEach(function (e) {
      assert.ok(['round', 'oval', 'trapezoid', 'hidden'].indexOf(e.shape) >= 0);
      ['cx', 'cy', 'w', 'h'].forEach(function (k) { assert.ok(isFinite(e[k])); });
    });
    m.details.forEach(function (d) {
      assert.ok(['side', 'top', 'front', 'rear'].indexOf(d.view) >= 0, m.id + ' detail view');
      assert.ok(isPath(d.path), m.id + ' detail path ' + d.role);
      assert.equal(typeof d.paint, 'string');
    });
  });
});

test('shapes-suv: ref figures self-consistent', function () {
  models.forEach(function (m) {
    var r = m.ref;
    close(r.frontOverhang + r.wheelbase + r.rearOverhang, r.length, 0.002, m.id + ' overhangs + wb = length');
    ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR', 'groundClearance', 'rideHeight', 'cd', 'curbWeight_kg'].forEach(function (k) {
      assert.ok(r[k] > 0, m.id + ' ref.' + k);
    });
    assert.ok(tireRadius(r.tireF) > 0.3 && tireRadius(r.tireR) > 0.3);
  });
});

test('shapes-suv: side body matches real length and height within 1%', function () {
  models.forEach(function (m) {
    var r = m.ref, b = bb(m.side.body);
    close(b.maxX - b.minX, r.length, r.length * 0.01, m.id + ' length');
    close(b.maxY, r.height, r.height * 0.01, m.id + ' height');
    close(b.maxX, r.wheelbase / 2 + r.frontOverhang, 0.02, m.id + ' front bumper position');
    close(b.minX, -(r.wheelbase / 2 + r.rearOverhang), 0.02, m.id + ' rear bumper position');
    assert.ok(b.minY > 0.15 && b.minY < 0.4, m.id + ' body clears the ground');
    // greenhouse sits inside the silhouette
    var g = bb(m.side.greenhouse);
    assert.ok(g.maxY < b.maxY && g.maxX < b.maxX && g.minX > b.minX, m.id + ' greenhouse inside body');
  });
});

test('shapes-suv: wheel arches on the axles, sized for the real tyres', function () {
  models.forEach(function (m) {
    var r = m.ref, aF = m.side.archF, aR = m.side.archR;
    var tF = tireRadius(r.tireF), tR = tireRadius(r.tireR);
    close(aF.x, r.wheelbase / 2, 0.003, m.id + ' front arch x');
    close(aR.x, -r.wheelbase / 2, 0.003, m.id + ' rear arch x');
    close(aF.y, tF, 0.01, m.id + ' front wheel centre height');
    close(aR.y, tR, 0.01, m.id + ' rear wheel centre height');
    assert.ok(aF.r - tF > 0.015 && aF.r - tF < 0.1, m.id + ' front arch gap ' + (aF.r - tF).toFixed(3));
    assert.ok(aR.r - tR > 0.015 && aR.r - tR < 0.1, m.id + ' rear arch gap ' + (aR.r - tR).toFixed(3));
    // no body outline point intrudes into the tyre circle (+5 mm)
    sample(m.side.body).forEach(function (q) {
      [[aF, tF], [aR, tR]].forEach(function (a) {
        var d = Math.hypot(q[0] - a[0].x, q[1] - a[0].y);
        assert.ok(d > a[1] + 0.005, m.id + ' body point inside tyre at ' + q.map(function (v) { return v.toFixed(3); }));
      });
    });
  });
});

test('shapes-suv: plan view width matches published width and is symmetric', function () {
  models.forEach(function (m) {
    var b = bb(m.top.body);
    close(b.maxY, m.ref.width / 2, m.ref.width * 0.005, m.id + ' top half-width');
    close(b.minY, -m.ref.width / 2, m.ref.width * 0.005, m.id + ' top half-width (left)');
    close(b.maxX - b.minX, m.ref.length, m.ref.length * 0.01, m.id + ' top length');
  });
});

function symCheck(m, view, getPts, axis) {
  var pts = [];
  getPts(function (p) { sample(p).forEach(function (q) { pts.push(q); }); });
  var key = function (a, b) { return Math.round(a * 1000) + ',' + Math.round(b * 1000); };
  var set = {};
  pts.forEach(function (q) { set[key(q[0], q[1])] = 1; });
  var bad = 0;
  pts.forEach(function (q) {
    var mq = axis === 0 ? [-q[0], q[1]] : [q[0], -q[1]];
    var k0 = Math.round(mq[0] * 1000), k1 = Math.round(mq[1] * 1000), hit = false;
    for (var da = -1; da <= 1 && !hit; da++) for (var db = -1; db <= 1 && !hit; db++) if (set[(k0 + da) + ',' + (k1 + db)]) hit = true;
    if (!hit) bad++;
  });
  assert.equal(bad, 0, m.id + ' ' + view + ' symmetric about z=0 (' + bad + ' unmatched of ' + pts.length + ')');
}

test('shapes-suv: front and rear views symmetric about z = 0 and full width', function () {
  models.forEach(function (m) {
    ['front', 'rear'].forEach(function (view) {
      symCheck(m, view, function (cb) {
        eachPath(m[view], cb, view);
        m.details.forEach(function (d) { if (d.view === view) cb(d.path); });
      }, 0);
      var b = bb(m[view].body);
      close(b.maxX, m.ref.width / 2, m.ref.width * 0.005, m.id + ' ' + view + ' half-width');
      close(b.maxY, m.ref.height, m.ref.height * 0.01, m.id + ' ' + view + ' height');
    });
    var ex = m.rear.exhaust;
    ex.forEach(function (e) { assert.ok(ex.some(function (f) { return Math.abs(f.cx + e.cx) < 1e-9 && f.cy === e.cy; }), m.id + ' exhaust mirrored'); });
    symCheck(m, 'top', function (cb) { ['body', 'greenhouse', 'hood', 'roof', 'deck', 'mirrors'].forEach(function (k) { eachPath(m.top[k], cb, k); }); }, 1);
  });
});

test('shapes-suv: models are distinct, recognisable silhouettes', function () {
  var cay = byId('porsche-cayenne-e3'), rrs = byId('range-rover-sport-l461'), urus = byId('lamborghini-urus');
  // Urus: low coupe roofline — rear of roof drops far more than the upright Range Rover
  function roofDrop(m) {
    var pts = sample(m.side.body).filter(function (q) { return q[1] > 1.0; });
    var peak = Math.max.apply(null, pts.map(function (q) { return q[1]; }));
    var x = -m.ref.wheelbase / 2 - 0.5;
    var near = pts.filter(function (q) { return Math.abs(q[0] - x) < 0.05; }).map(function (q) { return q[1]; });
    return peak - Math.max.apply(null, near);
  }
  assert.ok(roofDrop(urus) > roofDrop(cay) && roofDrop(cay) > roofDrop(rrs), 'roofline taper order Urus > Cayenne > RRS');
  assert.equal(urus.side.archF.shape, 'hex');
  assert.equal(cay.side.archF.shape, 'round');
  assert.ok(cay.rear.lightBar, 'Cayenne full-width light bar');
  assert.equal(cay.front.drl.length, 8, 'Porsche four-point DRL (4 per side)');
});

var corePath = path.join(__dirname, '..', 'js', 'shapes', 'core.js');
if (fs.existsSync(corePath)) {
  test('shapes-suv: core fit() and toSvgPath() work on the SUV models', function () {
    var core = require(corePath);
    require(path.join(__dirname, '..', 'js', 'shapes', 'models', 'suv.js'));
    IDS.forEach(function (id) {
      var m = core.models[id];
      assert.ok(m, id + ' registered with core');
      // identity fit reproduces reference dims
      var f0 = core.fit(m, core.refBuild(m));
      close(f0.dims.length, m.ref.length, 0.005, id + ' identity fit length');
      close(f0.side.archF.x, m.ref.wheelbase / 2, 0.003, id + ' identity arch');
      // stretched fit
      var f = core.fit(m, { body: { style: 'suv', model: id, wheelbase_mm: 3100, trackWidth_mm: 1720 },
        suspension: { rideHeight_mm: 250 }, wheels: { diameter_in: 22 }, tires: { widthFront_mm: 285, profileFront: 40, widthRear_mm: 285, profileRear: 40 } });
      close(f.dims.wheelbase, 3.1, 1e-6, id + ' wheelbase');
      close(f.side.archF.x - f.side.archR.x, 3.1, 0.003, id + ' arches follow wheelbase');
      assert.ok(f.side.archF.r > f.dims.wheelRadius, id + ' arch clears new tyre');
      var s = core.toSvgPath(f.side.body, { scale: 100, flipY: true, ox: 300, oy: 200 });
      assert.ok(/^M [-\d.]+ [-\d.]+ C /.test(s), id + ' svg path');
      assert.ok(!/NaN|Infinity/.test(s), id + ' svg finite');
      ['side', 'top', 'front', 'rear'].forEach(function (v) {
        eachPath(f[v], function (p) { assert.ok(!/NaN/.test(core.toSvgPath(p, { scale: 100 })), id + ' ' + v); }, v);
      });
      assert.equal(core.getModel({ body: { style: 'suv', model: id } }).id, id);
    });
    assert.equal(core.defaultModel('suv').id, 'porsche-cayenne-e3');
    // 3D loft from views
    var secs = core.sectionsFromViews(core.models['lamborghini-urus'], { stations: 32, ringVerts: 24 });
    var mesh = core.loftToMesh(secs);
    assert.ok(mesh.positions.length > 0 && mesh.indices.length > 0);
    for (var i = 0; i < mesh.positions.length; i++) assert.ok(isFinite(mesh.positions[i]));
  });
}

/* ---- second-critique regressions ---- */
function zAtY(p, y) {   // max |z| where the outline crosses height y
  var pts = sample(p), best = -Infinity;
  for (var i = 0; i + 1 < pts.length; i++) {
    var a = pts[i], b = pts[i + 1];
    if ((a[1] - y) * (b[1] - y) <= 0 && a[1] !== b[1]) best = Math.max(best, Math.abs(a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1])));
  }
  return best;
}
test('shapes-suv: front/rear mirrors are rooted on the body (no floating gap)', function () {
  models.forEach(function (m) {
    ['front', 'rear'].forEach(function (view) {
      var mirrors = m.details.filter(function (d) { return d.view === view && d.role === 'mirror'; });
      assert.equal(mirrors.length, 2, m.id + ' ' + view + ' mirror pair');
      mirrors.forEach(function (d) {
        var b = bb(d.path), inner = Math.min(Math.abs(b.minX), Math.abs(b.maxX));
        var bodyZ = zAtY(m[view].body, b.minY + 0.02);   // at the mirror's root
        assert.ok(inner <= bodyZ + 0.005, m.id + ' ' + view + ' mirror inner edge ' + inner.toFixed(3) + ' vs body ' + bodyZ.toFixed(3));
      });
    });
  });
});
test('shapes-suv: badge text, flanks and roofs follow the real cars', function () {
  var cay = byId('porsche-cayenne-e3'), rrs = byId('range-rover-sport-l461'), urus = byId('lamborghini-urus');
  assert.equal(cay.badgeText.rear, 'PORSCHE');
  assert.equal(urus.badgeText.rear, 'LAMBORGHINI');
  assert.equal(urus.badgeText.front, '');
  // no full-length shoulder strip through the doors on Cayenne / RRS
  [cay, rrs].forEach(function (m) {
    m.side.characterLines.forEach(function (l) {
      var b = bb(l);
      assert.ok(!(b.maxX > 0.9 && b.minX < -0.9 && b.minY > 0.8), m.id + ' no full-length shoulder line');
    });
  });
  // top-view roofs: half-width never decreases moving rearward until past the widest point (no front-corner pinch)
  models.forEach(function (m) {
    // walk the right half from the front centre: |z| rises monotonically to the widest point, then
    // falls monotonically to the rear centre (single peak: no front-corner pinch, no wave)
    var pts = sample(m.top.roof), half = [];
    for (var n = 0; n < pts.length && pts[n][1] >= -1e-9; n++) half.push(pts[n]);
    var iPk = 0;
    half.forEach(function (q, i) { if (q[1] > half[iPk][1] + 1e-9) iPk = i; });
    assert.ok(half[iPk][0] < -0.3, m.id + ' roof widest behind the windscreen header');
    for (var i = 1; i <= iPk; i++) assert.ok(half[i][1] >= half[i - 1][1] - 0.002, m.id + ' roof widens smoothly at x ' + half[i][0].toFixed(2));
    for (var j = iPk + 1; j < half.length; j++) assert.ok(half[j][1] <= half[j - 1][1] + 0.001, m.id + ' roof has no wave at x ' + half[j][0].toFixed(2));
  });
  // RRS: no waistline strip at all (clean L461 flanks)
  assert.ok(!rrs.side.characterLines.some(function (l) { var b = bb(l); return b.minY > 0.8; }), 'RRS has no waistline');
  // Urus rear door cut: no hard L-step (consecutive landmarks never run flat for > 0.1 m above the sill)
  var dc = sample(urus.side.doorCuts[1]);
  for (var k = 1; k < dc.length; k++) {
    if (dc[k][1] > 0.5 && dc[k - 1][1] > 0.5) assert.ok(Math.abs(dc[k][1] - dc[k - 1][1]) > 1e-4 || Math.abs(dc[k][0] - dc[k - 1][0]) < 0.1, 'Urus rear door cut smooth');
  }
  // Cayenne shark-fin sits on the roof
  var fin = cay.details.filter(function (d) { return d.view === 'side' && d.role === 'antenna'; })[0];
  assert.ok(bb(fin.path).minY <= 1.646, 'Cayenne antenna rests on the roof');
  // RRS: top-view black roof stays inside the roof outline
  var rb = bb(rrs.top.roof);
  rrs.details.filter(function (d) { return d.view === 'top' && d.paint === 'gloss-black'; }).forEach(function (d) {
    var b = bb(d.path);
    assert.ok(b.maxX <= rb.maxX + 1e-6 && b.minX >= rb.minX - 1e-6 && b.maxY <= rb.maxY + 1e-6, 'RRS black roof inside roof outline');
  });
});
test('shapes-suv: rear-view details sized like the real cars', function () {
  var cay = byId('porsche-cayenne-e3'), rrs = byId('range-rover-sport-l461'), urus = byId('lamborghini-urus');
  var ug = bb(urus.rear.greenhouse);
  assert.ok(ug.maxX >= 0.515 && ug.maxY >= 1.495, 'Urus rear glass widened and lifted');
  var ut = bb(urus.rear.taillights[0]);
  assert.ok(Math.max(Math.abs(ut.minX), Math.abs(ut.maxX)) > 0.955, 'Urus lamps reach the haunch');
  assert.ok(bb(urus.rear.spoiler).minY <= 1.245, 'Urus spoiler lowered');
  var rg = bb(rrs.rear.greenhouse);
  close(rg.maxX, 0.58, 0.005, 'RRS rear glass base half-width');
  assert.ok(rrs.details.filter(function (d) { return d.view === 'rear' && d.paint === 'gloss-black'; }).length >= 4, 'RRS floating-roof D-pillars + roof cap from behind');
  var cg = bb(cay.front.greenhouse);
  assert.ok(cg.maxX <= 0.725, 'Cayenne windscreen leaves an A-pillar');
  assert.ok(cay.front.characterLines && urus.front.panelLines, 'front-view wing crests / bonnet creases');
});
test('shapes-suv: critique round 2 (3D bumper faces, D-pillar glass line, lamps, Urus haunch)', function () {
  var cay = byId('porsche-cayenne-e3'), rrs = byId('range-rover-sport-l461'), urus = byId('lamborghini-urus');
  function endW(m, i) { return Math.max.apply(0, m.sections[i].ring.map(function (q) { return q[1]; })); }
  // end sections are full bumper faces, not shrunken blobs
  [[cay, 0.715, 0.795], [rrs, 0.715, 0.795], [urus, 0.595, 0.795]].forEach(function (e) {
    var s = e[0].sections;
    assert.ok(endW(e[0], s.length - 1) >= e[1], e[0].id + ' front end section width ' + endW(e[0], s.length - 1));
    assert.ok(endW(e[0], 0) >= e[2], e[0].id + ' rear end section width ' + endW(e[0], 0));
    assert.ok(s[s.length - 1].x <= e[0].ref.length - e[0].ref.rearOverhang - e[0].ref.wheelbase / 2 && s[0].x >= -(e[0].ref.rearOverhang + e[0].ref.wheelbase / 2), e[0].id + ' end stations inside the bumper tips');
    if (CB.shapes.sectionsFromViews) {
      var rs = CB.shapes.sectionsFromViews(e[0], { stations: 48, ringVerts: 32 });
      assert.ok(rs.every(function (r) { return r.ring.length === 32; }), e[0].id + ' 32-vertex rings');
    }
    // glass line never stair-steps through the D-pillar: max belt change per station tracks the edge slope
    var g = s.filter(function (r) { return r.x < -1.6 && r.x > -2.25 && r.belt != null; });
    for (var i = 1; i < g.length; i++) {
      var slope = Math.abs(g[i].belt - g[i - 1].belt) / (g[i].x - g[i - 1].x);
      assert.ok(Math.abs(g[i].belt - g[i - 1].belt) < 0.08 && slope < 5, e[0].id + ' belt jump at x ' + g[i].x);
    }
  });
  // Cayenne: bonnet shut line close under the nose outline; gloss-black shark fin; straight quarter-glass rear edge
  var bl = sample(cay.side.panelLines[0]);
  close(bl[0][1], 0.93, 0.005, 'Cayenne bonnet line starts high at the nose');
  var fin = cay.details.filter(function (d) { return d.view === 'side' && d.role === 'antenna'; })[0];
  assert.equal(fin.paint, 'gloss-black', 'Cayenne shark fin gloss black');
  assert.ok(bb(fin.path).maxY >= 1.70, 'Cayenne fin stands proud of the roof');
  var qw = cay.side.windows[2];
  var edge = qw.filter(function (sg) { return sg.t === 'C'; }).map(function (sg) { return sg.p; });
  var straight = edge.some(function (p) {   // a segment from (-2.00,1.52) to (-1.93,1.215) with collinear handles
    var a = [-2.00, 1.52], b = [-1.93, 1.215];
    if (Math.abs(p[2][0] - b[0]) > 1e-4 || Math.abs(p[2][1] - b[1]) > 1e-4) return false;
    return [p[0], p[1]].every(function (h) { return Math.abs((b[0] - a[0]) * (h[1] - a[1]) - (b[1] - a[1]) * (h[0] - a[0])) < 1e-4; });
  });
  assert.ok(straight, 'Cayenne quarter-glass rear edge is straight');
  assert.ok(cay.details.filter(function (d) { return d.view === 'front' && d.paint === 'black' && d.role === 'trim'; }).length >= 8, 'Cayenne DRL points framed in black');
  // RRS: headlamps ~0.08 m tall; side tail lamp wraps ~0.15 m onto the flank
  var hl = bb(rrs.front.headlights[0]);
  assert.ok(hl.maxY - hl.minY >= 0.075, 'RRS headlamp height');
  var st = bb(rrs.details.filter(function (d) { return d.view === 'side' && d.paint === 'light-red'; })[0].path);
  assert.ok(st.maxX - st.minX >= 0.15, 'RRS side tail lamp wraps the corner');
  // Urus: shoulder crease starts below the bonnet edge; plan view covers the rear tyres; wide upper haunches
  var sh = sample(urus.side.characterLines[0]);
  assert.ok(sh[0][1] <= 0.81, 'Urus shoulder crease starts on the body');
  var tyreZ = urus.ref.trackR / 2 + 0.315 / 2, rt = sample(urus.top.body).filter(function (q) { return q[1] > 0 && q[0] < -1.15 && q[0] > -1.85; });
  assert.ok(rt.length && rt.every(function (q) { return q[1] >= tyreZ - 1e-3; }), 'Urus rear tyres hidden in plan');
  var rb = sample(urus.rear.body).filter(function (q) { return q[0] > 0 && Math.abs(q[1] - 1.17) < 0.01; });
  assert.ok(rb.some(function (q) { return q[0] >= 0.99; }), 'Urus upper rear haunch width');
  var tl = bb(urus.rear.taillights[0]);
  assert.ok(Math.max(Math.abs(tl.minX), Math.abs(tl.maxX)) >= 0.98, 'Urus lamps reach z 0.985');
});
test('shapes-suv: 3D side-glass lower edge stays on one vertex row along the doors', function () {
  var core;
  try { core = require(path.join(__dirname, '..', 'js', 'shapes', 'core.js')); } catch (e) { return; }
  var S = (globalThis.CB && globalThis.CB.shapes) || core;
  if (!S || !S.sectionsFromViews) return;
  [32, 40].forEach(function (NV) {
    models.forEach(function (m) {
      var rs = S.sectionsFromViews(m, { stations: 64, ringVerts: NV }), first = {};
      rs.forEach(function (r) {
        if (r.belt == null || r.x < -1.6 || r.x > 0.4) return;
        for (var j = 0; j <= NV / 2; j++) if (r.ring[j][0] > r.belt + 0.02) { first[j] = (first[j] || 0) + 1; break; }
      });
      var keys = Object.keys(first);
      assert.ok(keys.length === 1, m.id + ' ringVerts ' + NV + ': first glass row varies ' + JSON.stringify(first));
    });
  });
});

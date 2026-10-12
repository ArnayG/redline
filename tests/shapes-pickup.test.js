/* Node tests for js/shapes/models/pickup.js — run: node tests/run.js shapes-pickup
   Loads the model file standalone (models queue on CB.shapes._pending when core.js is absent),
   then checks geometry against each car's published dimensions. */
'use strict';
var path = require('path');
var fs = require('fs');
var MOD = require(path.join(__dirname, '..', 'js', 'shapes', 'models', 'pickup.js'));
var CB = globalThis.CB;

var IDS = ['ford-f150-raptor-gen3', 'toyota-tacoma-trdpro-2024', 'tesla-cybertruck'];
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
  var m = /(\d{3})\/(\d{2})\s*Z?R\s*(\d+)/i.exec(s);
  return (+m[3] * 0.0254 + 2 * (+m[1]) * (+m[2]) / 100000) / 2;
}
function close(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, msg + ': ' + a.toFixed(4) + ' vs ' + b.toFixed(4)); }
function byId(id) { return models.filter(function (m) { return m.id === id; })[0]; }

test('shapes-pickup: three real pickups exported and queued/registered', function () {
  assert.equal(models.length, 3);
  IDS.forEach(function (id) {
    var m = byId(id);
    assert.ok(m, id);
    assert.equal(m.style, 'pickup');
    assert.equal(m.enginePosition, 'front');
    ['make', 'name', 'gen', 'years'].forEach(function (k) { assert.equal(typeof m[k], 'string', id + ' ' + k); });
    ['headlights', 'taillights', 'grille', 'notes'].forEach(function (k) { assert.ok(m.signature[k].length > 20, id + ' signature.' + k); });
    var registered = (CB.shapes.models && CB.shapes.models[id]) ||
      (Array.isArray(CB.shapes._pending) && CB.shapes._pending.indexOf(m) >= 0);
    assert.ok(registered, id + ' registered or pending');
  });
});

test('shapes-pickup: every path well-formed and finite; all views present', function () {
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
    ['body', 'greenhouse', 'bumper', 'grille', 'intakes', 'headlights', 'drl', 'plateArea'].forEach(function (k) { assert.ok(m.front[k], m.id + ' front.' + k); });
    if (m.id === 'tesla-cybertruck') assert.equal(m.front.badgeArea, null, 'production Cybertruck has no front badge');
    else assert.ok(m.front.badgeArea, m.id + ' front.badgeArea');
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

test('shapes-pickup: ref figures self-consistent', function () {
  models.forEach(function (m) {
    var r = m.ref;
    close(r.frontOverhang + r.wheelbase + r.rearOverhang, r.length, 0.002, m.id + ' overhangs + wb = length');
    ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR', 'groundClearance', 'rideHeight', 'cd', 'curbWeight_kg'].forEach(function (k) {
      assert.ok(r[k] > 0, m.id + ' ref.' + k);
    });
    assert.ok(tireRadius(r.tireF) > 0.3 && tireRadius(r.tireR) > 0.3);
  });
});

test('shapes-pickup: side body matches real length and height within 1%', function () {
  models.forEach(function (m) {
    var r = m.ref, b = bb(m.side.body);
    close(b.maxX - b.minX, r.length, r.length * 0.01, m.id + ' length');
    close(b.maxY, r.height, r.height * 0.01, m.id + ' height');
    close(b.maxX, r.wheelbase / 2 + r.frontOverhang, 0.02, m.id + ' front bumper position');
    close(b.minX, -(r.wheelbase / 2 + r.rearOverhang), 0.02, m.id + ' rear bumper position');
    assert.ok(b.minY > 0.25 && b.minY < 0.6, m.id + ' body clears the ground');
    // greenhouse sits inside the silhouette
    var g = bb(m.side.greenhouse);
    assert.ok(g.maxY < b.maxY && g.maxX < b.maxX && g.minX > b.minX, m.id + ' greenhouse inside body');
  });
});

test('shapes-pickup: wheel arches on the axles, sized for the real tyres', function () {
  models.forEach(function (m) {
    var r = m.ref, aF = m.side.archF, aR = m.side.archR;
    var tF = tireRadius(r.tireF), tR = tireRadius(r.tireR);
    close(aF.x, r.wheelbase / 2, 0.003, m.id + ' front arch x');
    close(aR.x, -r.wheelbase / 2, 0.003, m.id + ' rear arch x');
    close(aF.y, tF, 0.01, m.id + ' front wheel centre height');
    close(aR.y, tR, 0.01, m.id + ' rear wheel centre height');
    assert.ok(aF.r - tF > 0.015 && aF.r - tF < 0.14, m.id + ' front arch gap ' + (aF.r - tF).toFixed(3));
    assert.ok(aR.r - tR > 0.015 && aR.r - tR < 0.14, m.id + ' rear arch gap ' + (aR.r - tR).toFixed(3));
    // no body outline point intrudes into the tyre circle (+5 mm)
    sample(m.side.body).forEach(function (q) {
      [[aF, tF], [aR, tR]].forEach(function (a) {
        var d = Math.hypot(q[0] - a[0].x, q[1] - a[0].y);
        assert.ok(d > a[1] + 0.005, m.id + ' body point inside tyre at ' + q.map(function (v) { return v.toFixed(3); }));
      });
    });
  });
});

test('shapes-pickup: plan view width matches published width and is symmetric', function () {
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

test('shapes-pickup: front and rear views symmetric about z = 0 and full width', function () {
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
    ex.forEach(function (e) { if (e.shape === 'hidden') return; assert.ok(ex.some(function (f) { return Math.abs(f.cx + e.cx) < 1e-9 && f.cy === e.cy; }), m.id + ' exhaust mirrored'); });
    symCheck(m, 'top', function (cb) { ['body', 'greenhouse', 'hood', 'roof', 'deck', 'mirrors'].forEach(function (k) { eachPath(m.top[k], cb, k); }); }, 1);
  });
});

test('shapes-pickup: models are distinct, recognisable silhouettes', function () {
  var rap = byId('ford-f150-raptor-gen3'), taco = byId('toyota-tacoma-trdpro-2024'), cyber = byId('tesla-cybertruck');
  // Cybertruck: every side-body segment is straight except tiny fillets (flat-faceted exoskeleton)
  var curved = 0, total = 0;
  cyber.side.body.forEach(function (s, i) {
    if (s.t !== 'C') return;
    var prev = cyber.side.body[i - 1], p0 = prev.p[prev.p.length - 1], p3 = s.p[2];
    total++; if (Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) > 0.06 && s.p !== undefined && !/arc/.test('')) curved++;
  });
  assert.ok(curved <= 2, 'Cybertruck has no large curves (' + curved + ')');
  assert.equal(cyber.side.archF.shape, 'hexagonal');
  assert.equal(taco.side.archF.shape, 'squared');
  // open bed: cab back sits well ahead of the tail and the bed rail is far below the roof
  [rap, taco].forEach(function (m) {
    var xr = -(m.ref.wheelbase / 2 + m.ref.rearOverhang);
    var tail = sample(m.side.body).filter(function (q) { return q[0] < xr + 0.3; });
    var tailTop = Math.max.apply(null, tail.map(function (q) { return q[1]; }));
    assert.ok(m.ref.height - tailTop > 0.4, m.id + ' bed rail well below roof');
  });
  // Cybertruck roof apex then a straight sail sloping to the tail
  var cs = sample(cyber.side.body), xrc = -(cyber.ref.wheelbase / 2 + cyber.ref.rearOverhang);
  var cTail = Math.max.apply(null, cs.filter(function (q) { return q[0] < xrc + 0.05; }).map(function (q) { return q[1]; }));
  assert.ok(cyber.ref.height - cTail > 0.3 && cyber.ref.height - cTail < 0.6, 'Cybertruck sail tail drop');
  // Raptor is the biggest; full-width Cybertruck light bars front and rear
  assert.ok(rap.ref.width > taco.ref.width && rap.ref.length > cyber.ref.length && cyber.ref.length > taco.ref.length);
  assert.ok(bb(cyber.front.drl[0]).maxX > 0.9 && bb(cyber.rear.lightBar).maxX > 0.9, 'Cybertruck full-width light bars');
  assert.equal(rap.front.drl.length, 2, 'Raptor C-clamp DRL per side');
  assert.equal(core0().defaultId, 'ford-f150-raptor-gen3');
});
test('shapes-pickup: explicit box-section / faceted 3D sections', function () {
  IDS.forEach(function (id) {
    var m = byId(id);
    assert.ok(Array.isArray(m.sections) && m.sections.length >= 30, id + ' has explicit sections');
    var xs = m.sections.map(function (s) { return s.x; });
    for (var i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], id + ' stations ascending');
    m.sections.forEach(function (s) {
      assert.equal(s.ring.length, 40, id + ' ring verts');
      s.ring.forEach(function (q) { assert.ok(isFinite(q[0]) && isFinite(q[1]), id + ' finite ring'); });
      for (var j = 1; j < 20; j++) assert.ok(Math.abs(s.ring[j][1] + s.ring[40 - j][1]) < 1e-4, id + ' ring symmetric');
      assert.ok(Math.max.apply(null, s.ring.map(function (q) { return q[0]; })) <= m.ref.height + 0.02, id + ' under roof');
    });
  });
  // open beds: centreline top of a mid-bed ring sits at the bed floor, well below the rail
  [['ford-f150-raptor-gen3', -2.0, 0.95, 1.40], ['toyota-tacoma-trdpro-2024', -1.8, 0.90, 1.30]].forEach(function (c) {
    var m = byId(c[0]), s = m.sections.reduce(function (b, q) { return Math.abs(q.x - c[1]) < Math.abs(b.x - c[1]) ? q : b; });
    close(s.ring[20][0], c[2], 0.02, c[0] + ' bed floor');
    assert.ok(Math.max.apply(null, s.ring.map(function (q) { return q[0]; })) > c[3] - 0.03, c[0] + ' bed rail');
  });
  // arch stations step in so the tyre shows: min |z| of the lower chain near the axle <= track/2 - tireW/2
  IDS.forEach(function (id) {
    var m = byId(id), a = m.ref.wheelbase / 2;
    var s = m.sections.reduce(function (b, q) { return Math.abs(q.x - a) < Math.abs(b.x - a) ? q : b; });
    var tw = +/(\d{3})\//.exec(m.ref.tireF)[1] / 1000;
    var zIn = Math.min.apply(null, s.ring.slice(3, 8).map(function (q) { return Math.abs(q[1]); }));
    assert.ok(zIn <= m.ref.trackF / 2 - tw / 2 + 1e-6, id + ' arch steps in (' + zIn.toFixed(3) + ')');
  });
  // Cybertruck creases are doubled vertices (flat facets)
  var cy = byId('tesla-cybertruck'), mid = cy.sections.reduce(function (b, q) { return Math.abs(q.x - 0.12) < Math.abs(b.x - 0.12) ? q : b; });
  var dup = 0; for (var k = 1; k < 20; k++) if (Math.hypot(mid.ring[k][0] - mid.ring[k - 1][0], mid.ring[k][1] - mid.ring[k - 1][1]) < 1e-6) dup++;
  assert.ok(dup >= 5, 'Cybertruck crisp creases (' + dup + ')');
  close(Math.max.apply(null, mid.ring.map(function (q) { return q[0]; })), cy.ref.height, 0.02, 'Cybertruck apex ring height');
});
test('shapes-pickup: critique-2 fixes (wells, rear cab glass, lamps, badges, Cybertruck vault)', function () {
  var rap = byId('ford-f150-raptor-gen3'), taco = byId('toyota-tacoma-trdpro-2024'), cyber = byId('tesla-cybertruck');
  // dark well circle hugs the tyre (no ring hanging below the body): gap 15-70 mm
  models.forEach(function (m) {
    var gap = m.side.archF.r - tireRadius(m.ref.tireF);
    assert.ok(gap > 0.015 && gap < 0.07, m.id + ' well gap ' + gap.toFixed(3));
  });
  // pickups with a cab back wall get a raked rear window: glass-flagged rings between cab and bed
  [[rap, -1.075, -1.035, 1.60, 1.93, 0.72], [taco, -0.995, -0.955, 1.47, 1.83, 0.66]].forEach(function (c) {
    var m = c[0], lo = m.sections.filter(function (s) { return Math.abs(s.x - c[1]) < 1e-6; })[0],
      hi = m.sections.filter(function (s) { return Math.abs(s.x - c[2]) < 1e-6; })[0];
    assert.ok(lo && hi && lo.glass && hi.glass, m.id + ' rear-window rings');
    assert.equal(hi.ring[20][0], c[4], m.id + ' rear glass top');
    assert.equal(lo.ring[20][0], c[3], m.id + ' rear glass bottom (raked)');
    assert.ok(Math.abs(Math.max.apply(null, hi.ring.filter(function (q) { return q[0] > c[3] + 0.01; }).map(function (q) { return q[1]; })) - c[5]) < 1e-6, m.id + ' rear glass half-width');
    // no full-height solid ring between the window and the bed
    m.sections.forEach(function (s) { if (s.x < c[1] - 1e-6 && s.x > c[1] - 0.2) assert.ok(s.ring[20][0] < c[3] - 0.1, m.id + ' bed behind cab at ' + s.x); });
  });
  // roof-rail crease: doubled vertex on full cab rings
  var cabRing = rap.sections.reduce(function (b, q) { return Math.abs(q.x) < Math.abs(b.x) ? q : b; });
  assert.ok(Math.hypot(cabRing.ring[16][0] - cabRing.ring[17][0], cabRing.ring[16][1] - cabRing.ring[17][1]) < 1e-9, 'Raptor roof-rail crease');
  // Raptor: lamps flush with the grille top, big FORD badge, exhaust in the bumper edge, stray stroke gone
  var hl = bb(rap.front.headlights[0]);
  close(hl.maxY, 1.42, 0.003, 'Raptor lamp top = grille top'); close(hl.minX, 0.62, 0.003, 'Raptor lamp inner edge');
  var fb = bb(rap.front.badgeArea); close(fb.maxX - fb.minX, 0.84, 0.005, 'FORD badge width'); close(fb.maxY - fb.minY, 0.13, 0.005, 'FORD badge height');
  rap.rear.exhaust.forEach(function (e) { assert.ok(e.cy - e.h / 2 > 0.5 && e.cy < 0.6, 'Raptor tips in bumper'); });
  rap.side.characterLines.forEach(function (l) { var b = bb(l); assert.ok(b.maxX - b.minX > 0.2, 'no stray short stroke'); });
  // Tacoma: rising hood shut line, fender cut, rail notch, bigger badges, raised bumper
  var hood = bb(taco.side.panelLines[0]); assert.ok(hood.maxY - hood.minY > 0.06, 'Tacoma hood line rises');
  assert.ok(sample(taco.side.body).some(function (q) { return q[0] < -2.81 && q[0] > -2.85 && Math.abs(q[1] - 1.26) < 0.003; }), 'Tacoma rail notch');
  close(bb(taco.front.badgeArea).maxX, 0.36, 0.003, 'TOYOTA badge'); close(bb(taco.rear.badgeArea).maxX, 0.62, 0.003, 'TACOMA badge');
  close(bb(taco.front.bumper.path).minY, 0.46, 0.003, 'Tacoma bumper bottom'); close(bb(taco.front.splitter.path).minY, 0.46, 0.003, 'Tacoma skid bottom');
  // Cybertruck: mirror straddles the beltline with a stalk; 14 mm light bars; carbon vault in top view and 3D
  var mir = bb(cyber.details.filter(function (d) { return d.view === 'side' && d.role === 'mirror' && d.paint === 'body'; })[0].path);
  assert.ok(mir.minY < 1.345 && mir.maxY > 1.345, 'Cybertruck mirror on the beltline');
  assert.ok(cyber.details.some(function (d) { return d.view === 'front' && d.role === 'mirrorArm' && d.paint === 'black'; }), 'front mirror stalk');
  var db = bb(cyber.front.drl[0]), lb = bb(cyber.rear.lightBar);
  close(db.maxY - db.minY, 0.014, 0.001, 'front light bar height'); close(lb.maxY - lb.minY, 0.014, 0.001, 'rear light bar height');
  assert.ok(cyber.details.some(function (d) { return d.view === 'top' && d.role === 'tonneau' && d.paint === 'black'; }), 'top-view matte-black vault');
  var vault = cyber.sections.filter(function (s) { return s.x < -1.5 && s.x > -2.5; });
  assert.ok(vault.length && vault.every(function (s) { return s.paint && s.paint.length === 40 && s.paint[20] === 'black' && s.paint[30] === 'body'; }), '3D vault material');
  var sail = cyber.sections.filter(function (s) { return Math.abs(s.x + 1.2) < 0.06; })[0];
  assert.ok(sail && Math.abs(sail.ring[13][0] - 1.55) < 0.005 && Math.abs(sail.ring[13][1] - 0.80) < 0.01, 'Cybertruck sail facet');
  [1.70, 1.62].forEach(function (x) { assert.ok(cyber.sections.some(function (s) { return Math.abs(s.x - x) < 1e-6; }), 'windscreen-base station ' + x); });
});
test('shapes-pickup: critique-3 fixes (3D bed/arches/flares/paint, Tacoma features, Cybertruck materials)', function () {
  var rap = byId('ford-f150-raptor-gen3'), taco = byId('toyota-tacoma-trdpro-2024'), cyber = byId('tesla-cybertruck');
  function near(m, x) { return m.sections.reduce(function (b, q) { return Math.abs(q.x - x) < Math.abs(b.x - x) ? q : b; }); }
  [[rap, 1.10, 0.95, -1.12], [taco, 1.02, 0.90, -1.04]].forEach(function (c) {
    var m = c[0], r = m.ref, a = r.wheelbase / 2, xf = a + r.frontOverhang, xr = -a - r.rearOverhang, R = tireRadius(r.tireF);
    var tw = +/(\d{3})\//.exec(r.tireF)[1] / 1000, hw = r.width / 2;
    // the open bed is lofted along its whole length (not one quad from the cab to the tailgate)
    var bed = m.sections.filter(function (s) { return s.x > xr + 0.1 && s.x < c[3] - 0.05; });
    assert.ok(bed.length >= 12, m.id + ' bed stations (' + bed.length + ')');
    bed.forEach(function (s) { assert.ok(Math.abs(s.ring[20][0] - c[2]) < 0.02, m.id + ' bed floor at ' + s.x); });
    [a, -a].forEach(function (ax) {
      var s = near(m, ax), arch = m.sections.filter(function (q) { return Math.abs(q.x - ax) < 0.45; });
      assert.ok(arch.length >= 9, m.id + ' >= 9 stations per arch');
      // opening cut: tub wall inboard of the tyre, arch top above the tyre
      assert.ok(Math.abs(s.ring[4][1]) <= (ax > 0 ? r.trackF : r.trackR) / 2 - tw / 2 + 1e-6, m.id + ' tub wall inboard at ' + ax.toFixed(2));
      assert.ok(s.ring[4][0] > 2 * R + 0.03, m.id + ' arch top clears the tyre at ' + ax.toFixed(2));
      // flare: outer z step to the full published width, black lower-trim paint, top band over the arch
      assert.ok(Math.abs(s.ring[6][1] - hw) < 0.01, m.id + ' flare at full width');
      assert.ok(s.ring[8][0] > c[1] - 0.06, m.id + ' flare top ' + s.ring[8][0]);
      for (var k = 5; k <= 9; k++) assert.equal(s.paint[k], 'black', m.id + ' flare paint ' + k);
    });
    // crisp ledge above the flare: doubled vertex everywhere (no saw-tooth normal blending)
    m.sections.forEach(function (s) { assert.ok(Math.hypot(s.ring[10][0] - s.ring[11][0], s.ring[10][1] - s.ring[11][1]) < 1e-9, m.id + ' ledge crease at ' + s.x); });
    // black rear step bumper and proud black front bumper ahead of the recessed grille
    assert.equal(near(m, xr + 0.15).paint[0], 'black'); assert.equal(near(m, xr + 0.15).paint[6], 'black', m.id + ' rear bumper black');
    m.sections.filter(function (s) { return s.x > xf - 0.033; }).forEach(function (s) {
      assert.ok(Math.max.apply(null, s.ring.map(function (q) { return q[0]; })) < 0.9, m.id + ' only the bumper ahead of the grille plane');
    });
    assert.ok(m.sections.some(function (s) { return s.paint && s.paint.indexOf('grille') >= 0; }), m.id + ' 3D grille paint');
    // no plan-view pinch at the cowl corner
    var cw = m.sections.filter(function (s) { return s.x < (m === rap ? 1.32 : 1.18) && s.x > (m === rap ? 1.27 : 1.13); });
    cw.forEach(function (s) { assert.ok(s.ring[13][1] > 0.85, m.id + ' cowl ring belt width at ' + s.x); });
  });
  // Raptor: shut-line groove, stronger power dome, open C-clamp, fuel door between cab and arch
  var ra = rap.ref.wheelbase / 2, rxf = ra + rap.ref.frontOverhang;
  var shut = near(rap, rxf - 0.10), ahead = near(rap, rxf - 0.092), behind = near(rap, rxf - 0.108);
  assert.ok(Math.abs(shut.x - (rxf - 0.10)) < 1e-4 && shut.ring[20][0] < Math.min(ahead.ring[20][0], behind.ring[20][0]) - 0.012, 'Raptor hood shut-line groove');
  var crown = near(rap, 2.0);
  assert.ok(crown.ring[20][0] - crown.ring[13][0] > 0.03, 'Raptor power dome');
  rap.front.drl.forEach(function (p) { close(Math.min.apply(null, sample(p).map(function (q) { return Math.abs(q[0]); })), 0.72, 0.003, 'C-clamp open end'); });
  assert.ok(rap.details.some(function (d) { return d.view === 'front' && d.paint === 'gloss-black' && Math.abs(bb(d.path).maxX - 0.70) < 0.003; }), 'Raptor gloss-black lens strip');
  var fd = bb(rap.side.panelLines[4]); close(fd.minX, -1.30, 0.003, 'fuel door front'); close(fd.maxX, -1.16, 0.003, 'fuel door rear');
  assert.ok(fd.minX > -ra + 0.53, 'fuel door clear of the rear arch');
  // Tacoma: roof spoiler, tailgate lip, air guides, shark fin, three LED blades
  var tH = taco.ref.height, ta = taco.ref.wheelbase / 2, txf = ta + taco.ref.frontOverhang, txr = -ta - taco.ref.rearOverhang;
  assert.ok(sample(taco.side.body).some(function (q) { return q[0] < -1.025 && q[1] > tH - 0.05; }), 'Tacoma roof spoiler overhangs the cab back');
  function det(view, role) { return taco.details.filter(function (d) { return d.view === view && d.role === role; }); }
  assert.ok(det('side', 'spoiler').some(function (d) { var b = bb(d.path); return Math.abs(b.minX - (txr - 0.005)) < 0.003 && Math.abs(b.maxY - 1.285) < 0.003; }), 'tailgate lip (side)');
  assert.ok(det('rear', 'spoiler').some(function (d) { var b = bb(d.path); return Math.abs(b.maxX - 0.78) < 0.003 && Math.abs(b.minY - 1.27) < 0.003; }), 'tailgate lip (rear)');
  assert.ok(det('side', 'vent').some(function (d) { var b = bb(d.path); return Math.abs(b.minX - (txf - 0.10)) < 0.003 && Math.abs(b.maxY - 0.84) < 0.003; }), 'air guide (side)');
  assert.ok(det('front', 'vent').some(function (d) { var b = bb(d.path); return Math.abs(b.maxX - 0.95) < 0.003 && Math.abs(b.minX + 0.95) < 0.003; }), 'air guides (front)');
  var fin = bb(det('side', 'antenna')[0].path); assert.ok(fin.maxY - tH > 0.04 && fin.maxX - fin.minX > 0.15, 'Tacoma shark-fin antenna');
  var blades = taco.rear.lightBar[0].filter(function (sg) { return sg.t === 'M'; }).length;
  assert.equal(blades, 4, 'Tacoma: three blades + outer stroke');
  // Cybertruck: black cladding below 0.74, light bars on the nose crease and tailgate top, matte-black vault
  var cx = cyber.ref.wheelbase / 2, cxf = cx + cyber.ref.frontOverhang, cxr = -cx - cyber.ref.rearOverhang;
  cyber.sections.forEach(function (s) { s.ring.forEach(function (q, i) { if (q[0] < 0.74) assert.equal(s.paint[i], 'black', 'Cybertruck cladding at ' + s.x); }); });
  var nose = cyber.sections[cyber.sections.length - 1], tailS = cyber.sections[0];
  assert.ok(nose.paint.indexOf('light') >= 0 && tailS.paint.indexOf('light-red') >= 0, 'Cybertruck 3D light bars');
  var v = near(cyber, -2.0); assert.ok(v.ring[15][0] - v.ring[16][0] > 0.01 && v.ring[15][1] > v.ring[16][1], 'Cybertruck sail tops stand above the tonneau');
  var ws0 = near(cyber, 1.785 + 0.04), ws1 = near(cyber, 1.785 - 0.003);
  assert.ok(Math.abs(ws1.x - 1.782) < 1e-3 && ws0.glass.every(function (g) { return !g; }) && ws1.glass[20] === 1, 'Cybertruck windscreen base break');
  assert.ok(near(cyber, cxf - 0.03).ring[0][0] > near(cyber, 0).ring[0][0] + 0.02, 'Cybertruck underbody upsweep');
  assert.ok(!cyber.details.some(function (d) { return d.paint === 'carbon'; }), 'Cybertruck tonneau is matte black, not carbon');
});
function core0() { return { defaultId: models.filter(function (m) { return m['default']; })[0].id }; }

var corePath = path.join(__dirname, '..', 'js', 'shapes', 'core.js');
if (fs.existsSync(corePath)) {
  test('shapes-pickup: core fit() and toSvgPath() work on the pickup models', function () {
    var core = require(corePath);
    require(path.join(__dirname, '..', 'js', 'shapes', 'models', 'pickup.js'));
    IDS.forEach(function (id) {
      var m = core.models[id];
      assert.ok(m, id + ' registered with core');
      // identity fit reproduces reference dims
      var f0 = core.fit(m, core.refBuild(m));
      close(f0.dims.length, m.ref.length, 0.005, id + ' identity fit length');
      close(f0.side.archF.x, m.ref.wheelbase / 2, 0.003, id + ' identity arch');
      // stretched fit
      var f = core.fit(m, { body: { style: 'pickup', model: id, wheelbase_mm: 3500, trackWidth_mm: 1800 },
        suspension: { rideHeight_mm: 280 }, wheels: { diameter_in: 20 }, tires: { widthFront_mm: 285, profileFront: 60, widthRear_mm: 285, profileRear: 60 } });
      close(f.dims.wheelbase, 3.5, 1e-6, id + ' wheelbase');
      close(f.side.archF.x - f.side.archR.x, 3.5, 0.003, id + ' arches follow wheelbase');
      assert.ok(f.side.archF.r > f.dims.wheelRadius, id + ' arch clears new tyre');
      var s = core.toSvgPath(f.side.body, { scale: 100, flipY: true, ox: 300, oy: 200 });
      assert.ok(/^M [-\d.]+ [-\d.]+ [LC] /.test(s), id + ' svg path');
      assert.ok(!/NaN|Infinity/.test(s), id + ' svg finite');
      ['side', 'top', 'front', 'rear'].forEach(function (v) {
        eachPath(f[v], function (p) { assert.ok(!/NaN/.test(core.toSvgPath(p, { scale: 100 })), id + ' ' + v); }, v);
      });
      assert.equal(core.getModel({ body: { style: 'pickup', model: id } }).id, id);
    });
    assert.equal(core.defaultModel('pickup').id, 'ford-f150-raptor-gen3');
    // 3D loft from views
    var secs = core.sectionsFromViews(core.models['tesla-cybertruck'], { stations: 32, ringVerts: 24 });
    var mesh = core.loftToMesh(secs);
    assert.ok(mesh.positions.length > 0 && mesh.indices.length > 0);
    for (var i = 0; i < mesh.positions.length; i++) assert.ok(isFinite(mesh.positions[i]));
  });
}

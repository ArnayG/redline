/* Node tests for js/shapes/models/sedan.js — run: node tests/run.js shapes-sedan
   Loads the model file standalone (registerModel stubbed away so models queue on CB.shapes._pending),
   then checks geometry against each car's published reference dimensions. */
'use strict';
var path = require('path');
var ROOT = path.join(__dirname, '..', 'js', 'shapes');
var CB = (globalThis.CB = globalThis.CB || {});
CB.shapes = CB.shapes || {};

function loadStandalone() {
  var file = path.join(ROOT, 'models', 'sedan.js');
  var savedReg = CB.shapes.registerModel, savedPending = CB.shapes._pending;
  delete require.cache[require.resolve(file)];
  CB.shapes.registerModel = undefined;
  CB.shapes._pending = [];
  require(file);
  var queued = CB.shapes._pending.slice();
  CB.shapes.registerModel = savedReg;
  CB.shapes._pending = savedPending;
  return queued;
}
var models = loadStandalone();
var IDS = ['bmw-m3-g80', 'mercedes-amg-c63-w206', 'tesla-model-s-2021'];

/* ---- path helpers ---- */
function isPath(p) { return Array.isArray(p) && p.length > 0 && p[0] && typeof p[0].t === 'string'; }
function eachPath(obj, fn, where) {
  if (isPath(obj)) return fn(obj, where);
  if (Array.isArray(obj)) obj.forEach(function (o, i) { eachPath(o, fn, where + '[' + i + ']'); });
  else if (obj && typeof obj === 'object') Object.keys(obj).forEach(function (k) { eachPath(obj[k], fn, where + '.' + k); });
}
/* Exact-ish bounds: samples every cubic/quadratic so bulging curves are measured, not just control points. */
function bounds(p) {
  var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, cur = null, start = null;
  function add(q) { b.minX = Math.min(b.minX, q[0]); b.maxX = Math.max(b.maxX, q[0]); b.minY = Math.min(b.minY, q[1]); b.maxY = Math.max(b.maxY, q[1]); }
  p.forEach(function (s) {
    if (s.t === 'M' || s.t === 'L') { cur = s.p[0]; if (s.t === 'M') start = cur; add(cur); }
    else if (s.t === 'C' || s.t === 'Q') {
      for (var i = 1; i <= 32; i++) {
        var t = i / 32, u = 1 - t, q;
        if (s.t === 'C') q = [0, 1].map(function (k) { return u * u * u * cur[k] + 3 * u * u * t * s.p[0][k] + 3 * u * t * t * s.p[1][k] + t * t * t * s.p[2][k]; });
        else q = [0, 1].map(function (k) { return u * u * cur[k] + 2 * u * t * s.p[0][k] + t * t * s.p[1][k]; });
        add(q);
      }
      cur = s.p[s.p.length - 1];
    } else if (s.t === 'Z') cur = start;
  });
  return b;
}
/* Union bounds of a path or an array of paths. */
function ubounds(o) {
  var u = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  eachPath(o, function (p) { var b = bounds(p); u.minX = Math.min(u.minX, b.minX); u.minY = Math.min(u.minY, b.minY); u.maxX = Math.max(u.maxX, b.maxX); u.maxY = Math.max(u.maxY, b.maxY); }, '');
  return u;
}
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, msg + ': ' + a.toFixed(4) + ' vs ' + b.toFixed(4) + ' (tol ' + tol + ')'); }
function tyreR(s) { var m = /(\d+)\/(\d+)\s*Z?R\s*(\d+)/.exec(s); return (+m[3] * 25.4 + 2 * m[1] * m[2] / 100) / 2000; }

test('shapes-sedan: queues 3 sedan models on _pending when core is absent', function () {
  assert.equal(models.length, 3);
  assert.deepEqual(models.map(function (m) { return m.id; }), IDS);
  models.forEach(function (m) {
    assert.equal(m.style, 'sedan');
    assert.equal(m.enginePosition, 'front');
    ['make', 'name', 'gen', 'years', 'drivetrain', 'powertrain'].forEach(function (k) { assert.ok(m[k], m.id + ' ' + k); });
    ['headlights', 'taillights', 'grille', 'notes'].forEach(function (k) { assert.ok(typeof m.signature[k] === 'string' && m.signature[k].length > 20, m.id + ' signature.' + k); });
    ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR', 'frontOverhang', 'rearOverhang', 'wheelDiameter_in',
      'groundClearance', 'rideHeight', 'cd', 'curbWeight_kg'].forEach(function (k) { assert.ok(Number.isFinite(m.ref[k]) && m.ref[k] > 0, m.id + ' ref.' + k); });
    near(m.ref.frontOverhang + m.ref.wheelbase + m.ref.rearOverhang, m.ref.length, 0.002, m.id + ' overhangs + wheelbase = length');
  });
});

test('shapes-sedan: every view and detail is present, well-formed and finite', function () {
  models.forEach(function (m) {
    var req = {
      side: ['body', 'greenhouse', 'windows', 'pillars', 'doorCuts', 'panelLines', 'characterLines', 'sill', 'lowerTrim'],
      top: ['body', 'greenhouse', 'hood', 'roof', 'deck', 'mirrors'],
      front: ['body', 'greenhouse', 'bumper', 'grille', 'intakes', 'headlights', 'drl', 'plateArea', 'badgeArea'],
      rear: ['body', 'greenhouse', 'bumper', 'taillights', 'diffuser', 'exhaust', 'plateArea', 'badgeArea']
    };
    Object.keys(req).forEach(function (v) { req[v].forEach(function (k) { assert.ok(m[v][k], m.id + ' ' + v + '.' + k); }); });
    assert.equal(m.side.windows.length, 3, m.id + ' three side glass areas');
    var n = 0;
    eachPath(m, function (p, where) {
      n++;
      assert.equal(p[0].t, 'M', m.id + where + ' starts with M');
      p.forEach(function (s) {
        assert.ok(/^[MLCQZ]$/.test(s.t), m.id + where + ' bad seg ' + s.t);
        var want = { M: 1, L: 1, C: 3, Q: 2, Z: 0 }[s.t];
        assert.equal(s.p.length, want, m.id + where + ' ' + s.t + ' arity');
        s.p.forEach(function (q) { assert.ok(Number.isFinite(q[0]) && Number.isFinite(q[1]), m.id + where + ' non-finite'); });
      });
    }, '');
    assert.ok(n > 60, m.id + ' has rich geometry (' + n + ' paths)');
    var paints = { body: 1, black: 1, 'gloss-black': 1, chrome: 1, glass: 1, light: 1, 'light-red': 1, 'light-amber': 1, carbon: 1, grille: 1 };
    m.details.forEach(function (d, i) {
      assert.ok(['side', 'top', 'front', 'rear'].indexOf(d.view) >= 0, m.id + ' detail ' + i + ' view');
      assert.ok(paints[d.paint], m.id + ' detail ' + i + ' paint ' + d.paint);
      assert.ok(typeof d.role === 'string' && isPath(d.path), m.id + ' detail ' + i);
    });
    m.rear.exhaust.forEach(function (e) {
      assert.ok(['round', 'oval', 'trapezoid', 'hidden'].indexOf(e.shape) >= 0);
      ['cx', 'cy', 'w', 'h'].forEach(function (k) { assert.ok(Number.isFinite(e[k]), m.id + ' exhaust ' + k); });
    });
  });
});

test('shapes-sedan: side body matches published length/height within 1% and sits on the axle landmarks', function () {
  models.forEach(function (m) {
    var b = bounds(m.side.body), R = m.ref;
    near(b.maxX - b.minX, R.length, R.length * 0.01, m.id + ' side length');
    near(b.maxY, R.height, R.height * 0.01, m.id + ' side height');
    near(b.maxX, R.wheelbase / 2 + R.frontOverhang, 0.02, m.id + ' front bumper x');
    near(b.minX, -(R.wheelbase / 2 + R.rearOverhang), 0.02, m.id + ' rear bumper x');
    assert.ok(b.minY > 0.08 && b.minY < 0.25, m.id + ' body underside above ground: ' + b.minY);
  });
});

test('shapes-sedan: wheel arches centred on the axles and sized for the real tyres', function () {
  models.forEach(function (m) {
    var R = m.ref;
    [['archF', R.wheelbase / 2, R.tireF], ['archR', -R.wheelbase / 2, R.tireR]].forEach(function (a) {
      var ar = m.side[a[0]], r = tyreR(a[2]);
      near(ar.x, a[1], 0.001, m.id + ' ' + a[0] + '.x');
      near(ar.y, r, 0.003, m.id + ' ' + a[0] + '.y = tyre radius');
      assert.ok(ar.r > r + 0.02 && ar.r < r + 0.08, m.id + ' ' + a[0] + '.r clears the tyre: ' + ar.r + ' vs ' + r);
      assert.ok(Number.isFinite(ar.flare) && ar.flare >= 0, m.id + ' ' + a[0] + '.flare');
    });
    // the arch cut-outs must actually be in the body outline: no body point inside the tyre circle
    var rF = tyreR(R.tireF), cx = R.wheelbase / 2;
    m.side.body.forEach(function (s) {
      s.p.forEach(function (q) {
        [[cx, rF], [-cx, tyreR(R.tireR)]].forEach(function (w) {
          var d = Math.hypot(q[0] - w[0], q[1] - w[1]);
          assert.ok(d > w[1] + 0.01 || q[1] < 0.01, m.id + ' body point intrudes into wheel at ' + q);
        });
      });
    });
  });
});

test('shapes-sedan: plan view width matches published width; mirrors stick out beyond it', function () {
  models.forEach(function (m) {
    var b = bounds(m.top.body), R = m.ref;
    near(b.maxY - b.minY, R.width, R.width * 0.01, m.id + ' top width');
    near(b.maxY, -b.minY, 0.001, m.id + ' top symmetric');
    near(b.maxX - b.minX, R.length, R.length * 0.01, m.id + ' top length');
    var mb = ubounds(m.top.mirrors);
    near(mb.minY, -mb.maxY, 0.002, m.id + ' mirrors symmetric');
    assert.ok(mb.maxY > R.width / 2 && mb.maxY < R.width / 2 + 0.16, m.id + ' mirrors beyond body');
  });
});

test('shapes-sedan: front and rear views are symmetric about z = 0 and match width/height', function () {
  models.forEach(function (m) {
    ['front', 'rear'].forEach(function (v) {
      var bb = bounds(m[v].body);
      near(bb.maxX - bb.minX, m.ref.width, m.ref.width * 0.01, m.id + ' ' + v + ' width');
      near(bb.maxY, m.ref.height, m.ref.height * 0.01, m.id + ' ' + v + ' height');
      // each feature (a path, or a left/right set of paths) must be symmetric as a whole
      Object.keys(m[v]).forEach(function (k) {
        var o = m[v][k];
        if (k === 'badgeArea' || k === 'exhaust' || !o || typeof o !== 'object') return;
        var paths = isPath(o) ? [o] : (Array.isArray(o) ? o : []);
        if (!paths.length) return;
        var b = ubounds(paths);
        near(b.minX, -b.maxX, 0.002, m.id + ' ' + v + '.' + k + ' symmetric');
        assert.ok(b.maxX <= m.ref.width / 2 + 0.005, m.id + ' ' + v + '.' + k + ' within body width');
        // paired features: every path has a mirror twin (or is itself symmetric)
        paths.forEach(function (p, i) {
          var pb = bounds(p);
          if (Math.abs(pb.minX + pb.maxX) < 0.002) return;
          var twin = paths.some(function (q) { var qb = bounds(q); return Math.abs(qb.minX + pb.maxX) < 0.002 && Math.abs(qb.maxX + pb.minX) < 0.002 && Math.abs(qb.minY - pb.minY) < 0.002; });
          assert.ok(twin, m.id + ' ' + v + '.' + k + '[' + i + '] has a mirror twin');
        });
      });
      var ex = m[v].exhaust;
      if (ex) {
        var s = ex.reduce(function (acc, e) { return acc + e.cx; }, 0);
        near(s, 0, 0.001, m.id + ' exhaust layout symmetric');
      }
    });
    ['front', 'rear'].forEach(function (v) {
      var ds = m.details.filter(function (d) { return d.view === v && d.role !== 'chargePort'; });
      ds.forEach(function (d, i) {
        var pb = bounds(d.path);
        if (Math.abs(pb.minX + pb.maxX) < 0.002) return;
        var twin = ds.some(function (e) { var qb = bounds(e.path); return e.role === d.role && Math.abs(qb.minX + pb.maxX) < 0.002 && Math.abs(qb.maxX + pb.minX) < 0.002 && Math.abs(qb.minY - pb.minY) < 0.002; });
        assert.ok(twin, m.id + ' ' + v + ' detail ' + d.role + ' #' + i + ' has a mirror twin');
      });
    });
  });
});

test('shapes-sedan: greenhouse and windows sit inside the body silhouette', function () {
  models.forEach(function (m) {
    var body = bounds(m.side.body), gh = bounds(m.side.greenhouse);
    assert.ok(gh.maxY < body.maxY && gh.minY > 0.9, m.id + ' greenhouse above beltline, below roof');
    m.side.windows.forEach(function (w, i) {
      var b = bounds(w);
      assert.ok(b.minX >= gh.minX - 0.005 && b.maxX <= gh.maxX + 0.005 && b.minY >= gh.minY - 0.005 && b.maxY <= gh.maxY + 0.005, m.id + ' window ' + i + ' inside DLO');
    });
  });
});

test('shapes-sedan: each car keeps its own signature geometry', function () {
  var by = {}; models.forEach(function (m) { by[m.id] = m; });
  var bmw = by['bmw-m3-g80'], amg = by['mercedes-amg-c63-w206'], tes = by['tesla-model-s-2021'];
  // near-vertical rear faces: x between deck lip and y=0.45 varies <= 0.025 for all three
  models.forEach(function (m) {
    var xs = [];
    m.side.body.forEach(function (sg) { sg.p.forEach(function (q) { if (q[0] < -2.3 && q[1] >= 0.45 && q[1] <= 1.0) xs.push(q[0]); }); });
    assert.ok(xs.length && Math.max.apply(null, xs) - Math.min.apply(null, xs) <= 0.03, m.id + ' rear face near-vertical');
  });
  // AMG Panamericana trapezoid is clearly wider at the bottom
  var g = amg.front.grille[0], top = -Infinity, bot = -Infinity;
  g.forEach(function (sg) { sg.p.forEach(function (q) { if (q[1] > 0.72) top = Math.max(top, q[0]); if (q[1] < 0.43) bot = Math.max(bot, q[0]); }); });
  assert.ok(bot - top > 0.1, 'AMG grille bottom wider than top: ' + top + ' / ' + bot);
  // AMG roof peaks further forward than the BMW, screen base set further back
  function peakX(m) { var best = [0, -1]; m.side.body.forEach(function (sg) { var q = sg.p[sg.p.length - 1]; if (q && q[1] > best[1]) best = q; }); return best[0]; }
  assert.ok(peakX(amg) > peakX(bmw), 'AMG roof peak forward of M3');
  // Tesla: body-colour rocker, no grille, hidden exhaust; BMW/AMG: black sills about 0.05 tall
  assert.equal(tes.side.sill.paint, 'gloss-black');
  assert.equal(tes.front.grille.length, 0);
  assert.equal(tes.rear.exhaust[0].shape, 'hidden');
  [bmw, amg].forEach(function (m) { var b = bounds(m.side.sill); assert.ok(b.maxY - b.minY <= 0.055, m.id + ' slim sill'); });
  // BMW Hofmeister kink: DLO has a point near (-1.60, 1.12) and hooks forward to ~(-1.50, 1.045)
  var pts = []; bmw.side.greenhouse.forEach(function (sg) { sg.p.forEach(function (q) { pts.push(q); }); });
  assert.ok(pts.some(function (q) { return Math.abs(q[0] + 1.60) < 0.02 && Math.abs(q[1] - 1.115) < 0.02; }), 'M3 kink corner');
  assert.ok(pts.some(function (q) { return Math.abs(q[0] + 1.505) < 0.02 && Math.abs(q[1] - 1.045) < 0.01; }), 'M3 kink hook');
});

/* Integration with the shared core (only once js/shapes/core.js exists). */
var core = null;
try { core = require(path.join(ROOT, 'core.js')); } catch (e) { core = null; }
if (core && CB.shapes && typeof CB.shapes.registerModel === 'function') {
  test('shapes-sedan: registers with core and fits to builds', function () {
    var S = CB.shapes;
    if (!S.models || !S.models[IDS[0]]) loadStandalone().forEach(function (m) { S.registerModel(m); });
    IDS.forEach(function (id) { assert.ok(S.models[id], id + ' registered'); });
    var list = S.modelsByStyle('sedan').map(function (m) { return m.id; });
    IDS.forEach(function (id) { assert.ok(list.indexOf(id) >= 0, id + ' in modelsByStyle'); });
    IDS.forEach(function (id) {
      var m = S.models[id];
      var build = { body: { style: 'sedan', model: id, wheelbase_mm: Math.round(m.ref.wheelbase * 1000) + 100, trackWidth_mm: 1650 },
        suspension: { rideHeight_mm: 110 }, wheels: { diameter_in: 21, widthFront_in: 10, widthRear_in: 10.5 },
        tires: { widthFront_mm: 285, widthRear_mm: 295, profileFront: 30, profileRear: 30 } };
      assert.equal(S.getModel(build).id, id);
      var f = S.fit(m, build);
      assert.ok(f && f.dims, id + ' fit dims');
      ['length', 'width', 'height', 'wheelbase', 'wheelRadius'].forEach(function (k) { assert.ok(Number.isFinite(f.dims[k]), id + ' dims.' + k); });
      near(f.dims.wheelbase, m.ref.wheelbase + 0.1, 0.01, id + ' fitted wheelbase');
      var svg = S.toSvgPath(f.side.body, { scale: 100, flipY: true, ox: 0, oy: 0 });
      assert.ok(/^M[\s\d.\-]/.test(svg) && svg.indexOf('NaN') < 0, id + ' toSvgPath');
    });
  });
}

/* Second-critique regressions: tyres inside the plan body, tapered tails, distinct faces, mirror/spoiler/camera placement. */
function sampleZAt(p, x) {
  var best = 0, cur = null;
  p.forEach(function (s) {
    if (s.t === 'Z') return;
    var e = s.p[s.p.length - 1];
    if (s.t === 'C' && cur) {
      for (var i = 0; i <= 400; i++) {
        var t = i / 400, u = 1 - t;
        var px = u * u * u * cur[0] + 3 * u * u * t * s.p[0][0] + 3 * u * t * t * s.p[1][0] + t * t * t * e[0];
        var pz = u * u * u * cur[1] + 3 * u * u * t * s.p[0][1] + 3 * u * t * t * s.p[1][1] + t * t * t * e[1];
        if (Math.abs(px - x) < 0.006) best = Math.max(best, pz);
      }
    }
    cur = e;
  });
  return best;
}
test('shapes-sedan: tyres sit inside the plan body; tails taper in plan', function () {
  models.forEach(function (m) {
    var R = m.ref, ax = R.wheelbase / 2;
    function tw(t) { return +/^(\d+)/.exec(t)[1] / 1000; }
    assert.ok(R.trackF / 2 + tw(R.tireF) / 2 < sampleZAt(m.top.body, ax), m.id + ' front tyre inside body in plan');
    assert.ok(R.trackR / 2 + tw(R.tireR) / 2 < sampleZAt(m.top.body, -ax), m.id + ' rear tyre inside body in plan');
    var tail = sampleZAt(m.top.body, -ax - R.rearOverhang + 0.06);
    assert.ok(tail > 0.70 && tail < 0.80, m.id + ' tail half-width 6 cm in from the tail: ' + tail);
  });
});
test('shapes-sedan: second-critique details', function () {
  var by = {}; models.forEach(function (m) { by[m.id] = m; });
  var bmw = by['bmw-m3-g80'], amg = by['mercedes-amg-c63-w206'], tes = by['tesla-model-s-2021'];
  // BMW: taller lamp (outer end >= 0.12) with an inner hook below the kidney top; plate low; gurney lip; mirror behind A-pillar base
  var hl = bounds(bmw.front.headlights[0]);
  assert.ok(hl.maxY - hl.minY >= 0.12 && hl.maxY <= 0.82 && hl.minX <= 0.365, 'M3 headlight ~0.12-0.14 tall, inner tip at z 0.36: ' + (hl.maxY - hl.minY));
  var ab = bounds(amg.front.headlights[0]);
  assert.ok(ab.maxY >= 0.828, 'AMG headlight raised outer corner');
  assert.ok(Math.abs(hl.minX - ab.minX) > 0.02 || Math.abs(hl.minY - ab.minY) > 0.01, 'M3 and AMG lamps differ');
  assert.ok(bounds(bmw.front.plateArea).maxY <= 0.44, 'M3 plate below the kidney slats');
  var sp = bounds(bmw.rear.spoiler);
  assert.ok(sp.maxY - sp.minY >= 0.018 && sp.maxX >= 0.54, 'M3 gurney lip spans the boot lid');
  var mir = bmw.details.filter(function (d) { return d.view === 'side' && d.role === 'mirror'; })[0];
  var mb = bounds(mir.path);
  assert.ok(mb.minX <= 0.48 && mb.maxX <= 0.74, 'M3 mirror on the door-glass corner: ' + mb.minX + '..' + mb.maxX);
  // AMG: no separate flare band; flares front and rear similar; grille top narrower
  assert.ok(Math.abs(amg.side.archF.flare - amg.side.archR.flare) <= 0.005, 'AMG arch flares match');
  assert.ok(!amg.details.some(function (d) { return d.view === 'side' && d.role === 'trim' && d.paint === 'body'; }), 'AMG no body-colour flare band');
  // Tesla: quarter glass ends near -1.89; small gloss-black side camera; thin rocker
  assert.ok(bounds(tes.side.greenhouse).minX > -1.92, 'Model S DLO tail: ' + bounds(tes.side.greenhouse).minX);
  var cam = tes.details.filter(function (d) { return d.view === 'side' && d.paint === 'gloss-black' && bounds(d.path).minX > 1.0; })[0];
  assert.ok(cam && bounds(cam.path).maxX - bounds(cam.path).minX <= 0.045, 'Model S side camera small');
  var sb = bounds(tes.side.sill.path); assert.ok(sb.maxY - sb.minY <= 0.015, 'Model S rocker merged into body');
  // per-model wheel styles all differ
  var types = models.map(function (m) { return m.wheelStyle && m.wheelStyle.type; });
  assert.deepEqual(types, ['y-spoke', 'multi-spoke', 'aero-cover']);
});

/* Third-critique regressions: view agreement, mirror feet, per-car details. */
test('shapes-sedan: top and side greenhouses agree on cabin length; mirrors have black feet', function () {
  models.forEach(function (m) {
    var sg = bounds(m.side.greenhouse), tg = bounds(m.top.greenhouse);
    near(tg.maxX, sg.maxX, 0.03, m.id + ' windscreen base x');
    near(tg.minX, sg.minX, 0.03, m.id + ' backlight base x');
    var feet = m.details.filter(function (d) { return d.view === 'side' && d.role === 'mirrorArm' && d.paint === 'black'; });
    assert.ok(feet.length >= 1, m.id + ' black mirror foot');
    var fb = bounds(feet[0].path);
    assert.ok(fb.maxX - fb.minX <= 0.10 && fb.maxY - fb.minY <= 0.07, m.id + ' foot ~0.08 x 0.05');
    near((fb.minX + fb.maxX) / 2, sg.maxX, 0.04, m.id + ' foot on the A-pillar base');
  });
});
test('shapes-sedan: third-critique details', function () {
  var by = {}; models.forEach(function (m) { by[m.id] = m; });
  var bmw = by['bmw-m3-g80'], amg = by['mercedes-amg-c63-w206'], tes = by['tesla-model-s-2021'];
  // BMW: twin-stalk mirror, 2 L DRLs per lamp, tall kidneys with 2 bold bars, low plate, wrapped side lamp, lip kick
  assert.ok(bmw.details.filter(function (d) { return d.view === 'side' && d.role === 'mirrorArm' && d.paint === 'black'; }).length >= 3, 'M3 twin stalks');
  assert.equal(bmw.front.drl.length, 4);
  assert.ok(bounds(bmw.front.grille[0]).maxY >= 0.825, 'M3 kidney top');
  var bars = bmw.details.filter(function (d) { return d.view === 'front' && d.role === 'grille' && d.paint === 'gloss-black'; });
  assert.equal(bars.length, 4, 'M3 two bars per kidney');
  var pb = bounds(bmw.front.plateArea); assert.ok(pb.minY >= 0.21 && pb.maxY <= 0.34, 'M3 plate on lower bar');
  var shl = bmw.details.filter(function (d) { return d.view === 'side' && d.role === 'headlight'; })[0];
  assert.ok(bounds(shl.path).minX <= 1.97, 'M3 side lamp wraps along the fender');
  var lip = bmw.details.filter(function (d) { return d.view === 'side' && d.role === 'spoiler'; })[0];
  assert.ok(lip && bounds(lip.path).maxY >= 1.06, 'M3 lip kick');
  // AMG: no BMW lower swage, B-pillar further back, sharp DLO tail, bigger front flare, plate clear of intake, 3 fins, wedge lamps
  assert.ok(!amg.side.characterLines.some(function (c) { var b = bounds(c); return b.maxY < 0.6 && b.maxX - b.minX > 1.0; }), 'AMG no lower crease');
  assert.ok(bounds(amg.side.pillars[0]).maxX < bounds(bmw.side.pillars[0]).maxX - 0.04, 'AMG B-pillar behind the M3');
  near(bounds(amg.side.greenhouse).minX, -1.75, 0.01, 'AMG DLO tail point');
  assert.ok(amg.side.archF.flare >= 0.034, 'AMG widened front wings');
  var ai = bounds(amg.front.intakes[2]), ap = bounds(amg.front.plateArea);
  assert.ok(ai.maxY <= ap.minY, 'AMG plate clear of lower intake');
  assert.equal(amg.details.filter(function (d) { return d.view === 'front' && d.role === 'intake' && d.paint === 'gloss-black'; }).length, 6);
  var tl = bounds(amg.rear.taillights[0]), ti = bounds(amg.rear.taillights[2]);
  assert.ok(tl.minY <= 0.842 && tl.maxY >= 0.988, 'AMG outer lamp 0.84-0.99');
  assert.ok(ti.minX <= 0.321, 'AMG inner tip at z 0.32');
  // Tesla: tucked chin, featureless side, glass roof in plan, rounded front corners
  var nose = []; tes.side.body.forEach(function (sg) { sg.p.forEach(function (q) { if (Math.abs(q[1] - 0.21) < 0.005) nose.push(q[0]); }); });
  assert.ok(nose.length && Math.max.apply(null, nose) <= 2.37, 'Model S tucked chin');
  assert.equal(tes.side.characterLines.filter(function (c) { return bounds(c).maxY < 1.0; }).length, 1, 'Model S single shoulder');
  assert.equal(tes.top.roof.paint, 'glass');
  assert.ok(bounds(tes.front.body).minY >= 0.11 && bounds(tes.front.bumper).maxX < 0.98, 'Model S front');
});

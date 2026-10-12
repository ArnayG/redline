/* Node tests for js/shapes/models/wagon.js — run: node tests/run.js shapes-wagon
   Loads the model file standalone (registerModel stubbed away so models queue on CB.shapes._pending),
   then checks geometry against each car's published reference dimensions. */
'use strict';
var path = require('path');
var ROOT = path.join(__dirname, '..', 'js', 'shapes');
var CB = (globalThis.CB = globalThis.CB || {});
CB.shapes = CB.shapes || {};

function loadStandalone() {
  var file = path.join(ROOT, 'models', 'wagon.js');
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
var IDS = ['audi-rs6-avant-c8', 'mercedes-amg-e63s-estate-s213', 'volvo-v60-polestar-engineered'];

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
/* Dense polyline of a path (cubics sampled 16x). */
function flatten(p) {
  var o = [], cur = null, start = null;
  p.forEach(function (s) {
    if (s.t === 'M' || s.t === 'L') { cur = s.p[0]; if (s.t === 'M') start = cur; o.push(cur); }
    else if (s.t === 'C') {
      for (var i = 1; i <= 16; i++) { var t = i / 16, u = 1 - t;
        o.push([0, 1].map(function (k) { return u * u * u * cur[k] + 3 * u * u * t * s.p[0][k] + 3 * u * t * t * s.p[1][k] + t * t * t * s.p[2][k]; })); }
      cur = s.p[2];
    } else if (s.t === 'Z' && start) { o.push(start); cur = start; }
  });
  return o;
}
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, msg + ': ' + a.toFixed(4) + ' vs ' + b.toFixed(4) + ' (tol ' + tol + ')'); }
function tyreR(s) { var m = /(\d+)\/(\d+)\s*Z?R\s*(\d+)/.exec(s); return (+m[3] * 25.4 + 2 * m[1] * m[2] / 100) / 2000; }

test('shapes-wagon: queues 3 wagon models on _pending when core is absent', function () {
  assert.equal(models.length, 3);
  assert.deepEqual(models.map(function (m) { return m.id; }), IDS);
  models.forEach(function (m) {
    assert.equal(m.style, 'wagon');
    assert.equal(m.enginePosition, 'front');
    ['make', 'name', 'gen', 'years', 'drivetrain', 'powertrain'].forEach(function (k) { assert.ok(m[k], m.id + ' ' + k); });
    ['headlights', 'taillights', 'grille', 'notes'].forEach(function (k) { assert.ok(typeof m.signature[k] === 'string' && m.signature[k].length > 20, m.id + ' signature.' + k); });
    ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR', 'frontOverhang', 'rearOverhang', 'wheelDiameter_in',
      'groundClearance', 'rideHeight', 'cd', 'curbWeight_kg'].forEach(function (k) { assert.ok(Number.isFinite(m.ref[k]) && m.ref[k] > 0, m.id + ' ref.' + k); });
    near(m.ref.frontOverhang + m.ref.wheelbase + m.ref.rearOverhang, m.ref.length, 0.002, m.id + ' overhangs + wheelbase = length');
  });
});

test('shapes-wagon: every view and detail is present, well-formed and finite', function () {
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

test('shapes-wagon: side body matches published length/height within 1% and sits on the axle landmarks', function () {
  models.forEach(function (m) {
    var b = bounds(m.side.body), R = m.ref;
    near(b.maxX - b.minX, R.length, R.length * 0.01, m.id + ' side length');
    near(b.maxY, R.height, R.height * 0.01, m.id + ' side height');
    near(b.maxX, R.wheelbase / 2 + R.frontOverhang, 0.02, m.id + ' front bumper x');
    near(b.minX, -(R.wheelbase / 2 + R.rearOverhang), 0.02, m.id + ' rear bumper x');
    assert.ok(b.minY > 0.08 && b.minY < 0.25, m.id + ' body underside above ground: ' + b.minY);
  });
});

test('shapes-wagon: wheel arches centred on the axles and sized for the real tyres', function () {
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

test('shapes-wagon: plan view width matches published width; mirrors stick out beyond it', function () {
  models.forEach(function (m) {
    var b = bounds(m.top.body), R = m.ref;
    near(b.maxY - b.minY, R.width, R.width * 0.01, m.id + ' top width');
    near(b.maxY, -b.minY, 0.001, m.id + ' top symmetric');
    near(b.maxX - b.minX, R.length, R.length * 0.01, m.id + ' top length');
    var mb = bounds((function (v) { return Array.isArray(v[0]) ? [].concat.apply([], v) : v; })(m.top.mirrors));
    assert.ok(mb.maxY > R.width / 2 && mb.maxY < R.width / 2 + 0.16, m.id + ' mirrors beyond body');
  });
});

test('shapes-wagon: front and rear views are symmetric about z = 0 and match width/height', function () {
  models.forEach(function (m) {
    ['front', 'rear'].forEach(function (v) {
      var bb = bounds(m[v].body);
      near(bb.maxX - bb.minX, m.ref.width, m.ref.width * 0.01, m.id + ' ' + v + ' width');
      near(bb.maxY, m.ref.height, m.ref.height * 0.01, m.id + ' ' + v + ' height');
      eachPath(m[v], function (p, where) {
        if (where === '.badgeArea') return;   // model lettering is deliberately offset (e.g. "RS 6" right of the tailgate)
        var b = bounds(p);
        near(b.minX, -b.maxX, 0.002, m.id + ' ' + v + where + ' symmetric');
        assert.ok(b.maxX <= m.ref.width / 2 + 0.005, m.id + ' ' + v + where + ' within body width');
      }, '');
      var ex = m[v].exhaust;
      if (ex) {
        var s = ex.reduce(function (acc, e) { return acc + e.cx; }, 0);
        near(s, 0, 0.001, m.id + ' exhaust layout symmetric');
      }
    });
    m.details.filter(function (d) { return d.view === 'front' || d.view === 'rear'; }).forEach(function (d) {
      var b = bounds(d.path);
      near(b.minX, -b.maxX, 0.002, m.id + ' ' + d.view + ' detail ' + d.role + ' symmetric');
    });
  });
});

test('shapes-wagon: greenhouse and windows sit inside the body silhouette', function () {
  models.forEach(function (m) {
    var body = bounds(m.side.body), gh = bounds(m.side.greenhouse);
    assert.ok(gh.maxY < body.maxY && gh.minY > 0.9, m.id + ' greenhouse above beltline, below roof');
    m.side.windows.forEach(function (w, i) {
      var b = bounds(w);
      assert.ok(b.minX >= gh.minX - 0.005 && b.maxX <= gh.maxX + 0.005 && b.minY >= gh.minY - 0.005 && b.maxY <= gh.maxY + 0.005, m.id + ' window ' + i + ' inside DLO');
    });
  });
});

/* Integration with the shared core (only once js/shapes/core.js exists). */
var core = null;
try { core = require(path.join(ROOT, 'core.js')); } catch (e) { core = null; }
if (core && CB.shapes && typeof CB.shapes.registerModel === 'function') {
  test('shapes-wagon: registers with core and fits to builds', function () {
    var S = CB.shapes;
    if (!S.models || !S.models[IDS[0]]) loadStandalone().forEach(function (m) { S.registerModel(m); });
    IDS.forEach(function (id) { assert.ok(S.models[id], id + ' registered'); });
    var list = S.modelsByStyle('wagon').map(function (m) { return m.id; });
    IDS.forEach(function (id) { assert.ok(list.indexOf(id) >= 0, id + ' in modelsByStyle'); });
    IDS.forEach(function (id) {
      var m = S.models[id];
      var build = { body: { style: 'wagon', model: id, wheelbase_mm: Math.round(m.ref.wheelbase * 1000) + 100, trackWidth_mm: 1650 },
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

/* ---- recognizability landmarks (critique pass) ---- */
function sideSlice(p, x) {   // [minY, maxY] of a path at x (sampled)
  var pts = [], cur = null, st = null;
  p.forEach(function (s) {
    if (s.t === 'M' || s.t === 'L') { cur = s.p[0]; if (s.t === 'M') st = cur; pts.push(cur); }
    else if (s.t === 'C') { for (var i = 1; i <= 24; i++) { var t = i / 24, u = 1 - t; pts.push([0, 1].map(function (k) { return u * u * u * cur[k] + 3 * u * u * t * s.p[0][k] + 3 * u * t * t * s.p[1][k] + t * t * t * s.p[2][k]; })); } cur = s.p[2]; }
    else if (s.t === 'Z') { pts.push(st); cur = st; }
  });
  var lo = Infinity, hi = -Infinity;
  for (var i = 0; i + 1 < pts.length; i++) {
    var a = pts[i], b = pts[i + 1]; if ((a[0] - x) * (b[0] - x) > 0 || a[0] === b[0]) continue;
    var y = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); lo = Math.min(lo, y); hi = Math.max(hi, y);
  }
  return [lo, hi];
}

test('shapes-wagon: flat wide wagon crown and visible A-pillars in front/rear views', function () {
  models.forEach(function (m) {
    ['front', 'rear'].forEach(function (v) {
      var top = sideSlice(m[v].body, 0.5)[1];
      assert.ok(top > m.ref.height - 0.012, m.id + ' ' + v + ' roof still full height at z=0.5: ' + top);
    });
    var g = bounds(m.front.greenhouse);
    assert.ok(g.maxX <= 0.67, m.id + ' windscreen leaves A-pillars (half width ' + g.maxX + ')');
  });
});

test('shapes-wagon: windscreen rake, tight arch gaps, blunt nose', function () {
  models.forEach(function (m) {
    ['archF', 'archR'].forEach(function (k) { near(m.side[k].r - m.side[k].y, 0.028, 0.002, m.id + ' ' + k + ' gap'); });
    // windscreen angle from horizontal between the cowl region and the header
    var ys = [0.7, 0.3].map(function (x) { return sideSlice(m.side.body, x)[1]; });
    var deg = Math.atan2(ys[1] - ys[0], 0.4) * 180 / Math.PI;
    assert.ok(deg > 25 && deg < 33, m.id + ' windscreen rake ' + deg.toFixed(1));
    var xF = m.ref.wheelbase / 2 + m.ref.frontOverhang, s = sideSlice(m.side.body, xF - 0.03);
    assert.ok(s[1] - s[0] > 0.35, m.id + ' blunt face, 3 cm behind the tip spans ' + (s[1] - s[0]).toFixed(3));
  });
});

test('shapes-wagon: explicit 3D sections keep full-width ends and loft watertight', function () {
  models.forEach(function (m) {
    assert.ok(Array.isArray(m.sections) && m.sections.length >= 8, m.id + ' sections');
    var W = m.ref.width / 2;
    m.sections.forEach(function (s) {
      assert.ok(s.ringHalf && s.ring.length >= 10, m.id + ' half ring');
      s.ring.forEach(function (q) { assert.ok(Number.isFinite(q[0]) && Number.isFinite(q[1]) && q[1] >= 0 && q[1] <= W + 0.001, m.id + ' ring point ' + q); });
    });
    var xs = m.sections.map(function (s) { return s.x; });
    for (var i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], m.id + ' stations ascending');
    // bumper ends follow the rounded plan outline: soft cap rings, no 88 % floor beyond the arches
    var zOf = function (s) { return Math.max.apply(null, s.ring.map(function (q) { return q[1]; })); };
    var first = m.sections[0], last = m.sections[m.sections.length - 1];
    [first, last].forEach(function (s) {
      var z = zOf(s);
      assert.ok(z > 0.08 * W && z < 0.35 * W, m.id + ' cap ring at x ' + s.x + ' closes softly: ' + (z / W).toFixed(2));
    });
    var tb = flatten(m.top.body);
    m.sections.slice(1, -1).forEach(function (s) {
      var inEnds = s.x > m.side.archF.x + m.side.archF.r || s.x < m.side.archR.x - m.side.archR.r;
      var z = zOf(s), pz = 0;
      for (var i = 0; i + 1 < tb.length; i++) {
        var a = tb[i], b = tb[i + 1];
        if ((a[0] - s.x) * (b[0] - s.x) > 0 || a[0] === b[0]) continue;
        pz = Math.max(pz, Math.abs(a[1] + (b[1] - a[1]) * (s.x - a[0]) / (b[0] - a[0])));
      }
      if (inEnds) assert.ok(z <= Math.max(pz, 0.45 * W) + 0.01, m.id + ' end ring at ' + s.x + ' inside plan width: ' + z.toFixed(3) + ' vs ' + pz.toFixed(3));
      else assert.ok(z >= 0.85 * W, m.id + ' cabin ring at ' + s.x + ' keeps width');
    });
    // tailgate glass band starts right behind the quarter-window tip: no step, no gap
    var tg = m.sections.filter(function (s) { return s.belt != null && s.x < -2.0; }).sort(function (p, q) { return q.x - p.x; });
    for (var j = 1; j < tg.length; j++) assert.ok(Math.abs(tg[j].belt - tg[j - 1].belt) < 0.09, m.id + ' glass band continuous at ' + tg[j].x);
    assert.ok(m.sections.some(function (s) { return s.belt != null; }), m.id + ' glass band flagged');
  });
  if (core && CB.shapes && CB.shapes.loftToMesh) {
    models.forEach(function (m) {
      var secs = CB.shapes.sectionsFromViews(m, { ringVerts: 32 });
      var mesh = CB.shapes.loftToMesh(secs);
      assert.ok(mesh.indices.length > 1000 && mesh.glass.indices.length > 0, m.id + ' mesh + glass');
      var edges = {};
      for (var t = 0; t < mesh.indices.length; t += 3) for (var e = 0; e < 3; e++) {
        var a = mesh.indices[t + e], b = mesh.indices[t + (e + 1) % 3], k = a < b ? a + ',' + b : b + ',' + a;
        edges[k] = (edges[k] || 0) + 1;
      }
      Object.keys(edges).forEach(function (k) { assert.equal(edges[k], 2, m.id + ' watertight edge ' + k); });
      // glass runs down to the cowl and back over the tailgate
      var gx = [], gp = mesh.glass.positions;
      for (var i = 0; i < gp.length; i += 3) gx.push(gp[i]);
      var cowl = { 'audi-rs6-avant-c8': 1.05, 'mercedes-amg-e63s-estate-s213': 0.98, 'volvo-v60-polestar-engineered': 0.88 }[m.id];
      assert.ok(Math.max.apply(null, gx) > cowl - 0.04, m.id + ' windscreen glass reaches the cowl: ' + Math.max.apply(null, gx).toFixed(3));
      assert.ok(Math.min.apply(null, gx) < -2.28, m.id + ' tailgate glass: ' + Math.min.apply(null, gx).toFixed(3));
    });
  }
});

/* ---- critique round 2 ---- */
var byId = {}; models.forEach(function (m) { byId[m.id] = m; });
function frontSlice(p, y) {   // [minZ, maxZ] of a front/rear-view path at height y
  var sw = p.map(function (s) { return { t: s.t, p: s.p.map(function (q) { return [q[1], q[0]]; }) }; });
  return sideSlice(sw, y);
}

test('shapes-wagon: plan view deck and greenhouse stay inside the body and taper at the tail', function () {
  var ghEnd = { 'audi-rs6-avant-c8': -2.40, 'mercedes-amg-e63s-estate-s213': -2.48, 'volvo-v60-polestar-engineered': -2.35 };
  models.forEach(function (m) {
    var body = bounds(m.top.body), deck = bounds(m.top.deck), gh = bounds(m.top.greenhouse);
    assert.ok(deck.minX >= body.minX + 0.009, m.id + ' deck inside tail: ' + deck.minX.toFixed(3) + ' vs ' + body.minX.toFixed(3));
    near(gh.minX, ghEnd[m.id], 0.012, m.id + ' greenhouse rear end');
    var dfront = deck.maxX, z = sideSlice(m.top.greenhouse, dfront - 0.05)[1];
    assert.ok(z <= 0.72, m.id + ' greenhouse tapers to ~0.70 at the deck: ' + z.toFixed(3));
  });
});

test('shapes-wagon: rear-view tailgate glass heights', function () {
  var want = { 'audi-rs6-avant-c8': [1.00, 1.30], 'mercedes-amg-e63s-estate-s213': [1.05, 1.31], 'volvo-v60-polestar-engineered': [1.03, 1.30] };
  models.forEach(function (m) {
    var b = bounds(m.rear.greenhouse), w = want[m.id];
    near(b.minY, w[0], 0.006, m.id + ' rear glass bottom'); near(b.maxY, w[1], 0.006, m.id + ' rear glass top');
    near(b.maxX, 0.62, 0.01, m.id + ' rear glass bottom half-width');
    near(frontSlice(m.rear.greenhouse, w[1] - 0.012)[1], 0.52, 0.02, m.id + ' rear glass top half-width');
  });
  var rs = byId['audi-rs6-avant-c8'].rear.greenhouse;   // single convex lower arc
  var prev = -1;
  [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].forEach(function (z) {
    var y = sideSlice(rs, z)[0]; assert.ok(y >= prev - 1e-4, 'RS6 rear glass bottom rises monotonically outboard at z=' + z); prev = y;
  });
});

test('shapes-wagon: front views flare at the arches and plates clear the grilles', function () {
  models.forEach(function (m) {
    var W = m.ref.width / 2, fb = m.front.body;
    near(frontSlice(fb, 0.575)[1], W, 0.004, m.id + ' full width across the arch band');
    var z85 = frontSlice(fb, 0.85)[1];
    assert.ok(z85 < W - 0.02 && z85 > W - 0.05, m.id + ' eased in at y 0.85: ' + z85.toFixed(3));
    var plate = bounds(m.front.plateArea), gr = bounds(m.front.grille[0].path || m.front.grille[0]);
    if (m.make !== 'Audi') assert.ok(plate.maxY < gr.minY - 0.01, m.id + ' plate below grille: ' + plate.maxY.toFixed(3) + ' / ' + gr.minY.toFixed(3));
  });
  var g = byId['audi-rs6-avant-c8'].front.grille[0].path;
  near(frontSlice(g, 0.43)[1], 0.50, 0.006, 'RS6 grille keeps full width at 0.42');
  near(frontSlice(g, 0.26)[1], 0.40, 0.02, 'RS6 grille chamfers to 0.40 at 0.25');
  near(bounds(g).maxY, 0.73, 0.004, 'RS6 grille top under the lamps');
  var e = byId['mercedes-amg-e63s-estate-s213'].front.grille[0];
  assert.ok(frontSlice(e, 0.44)[1] > frontSlice(e, 0.66)[1] + 0.05, 'E63 Panamericana wider at the bottom');
});

test('shapes-wagon: side profiles are individual (corner vents, bonnet edge, lamps inside the tail)', function () {
  function vents(m) { return m.details.filter(function (d) { return d.view === 'side' && d.role === 'intake'; }); }
  assert.equal(vents(byId['volvo-v60-polestar-engineered']).length, 0, 'V60 smooth bumper corner');
  var ev = bounds(vents(byId['mercedes-amg-e63s-estate-s213'])[0].path);
  near(ev.minY, 0.24, 0.01, 'E63 vent bottom'); near(ev.maxY, 0.52, 0.01, 'E63 vent top');
  near(ev.minX, 2.10, 0.015, 'E63 vent front'); near(ev.maxX, 2.36, 0.015, 'E63 vent rear');
  near(sideSlice(byId['volvo-v60-polestar-engineered'].side.body, 2.20)[1], 0.83, 0.006, 'V60 high bonnet leading edge');
  models.forEach(function (m) {
    m.details.filter(function (d) { return d.view === 'side' && d.paint === 'light-red'; }).forEach(function (d) {
      var b = bounds(d.path);
      [0.25, 0.5, 0.75].forEach(function (f) {
        var y = b.minY + (b.maxY - b.minY) * f, lamp = sideSlice(d.path.map(function (s) { return { t: s.t, p: s.p.map(function (q) { return [q[1], q[0]]; }) }; }), y);
        var bodyX = sideSlice(m.side.body.map(function (s) { return { t: s.t, p: s.p.map(function (q) { return [q[1], q[0]]; }) }; }), y)[0];
        assert.ok(lamp[0] >= bodyX + 0.003, m.id + ' tail lamp inside body at y=' + y.toFixed(3) + ': ' + lamp[0].toFixed(3) + ' vs ' + bodyX.toFixed(3));
      });
    });
  });
  var rl = bounds(byId['audi-rs6-avant-c8'].details.filter(function (d) { return d.view === 'side' && d.paint === 'light-red'; })[0].path);
  near(rl.minY, 0.895, 0.006, 'RS6 tail lamp wrap bottom'); near(rl.maxY, 1.020, 0.006, 'RS6 tail lamp wrap top');
  assert.ok(byId['mercedes-amg-e63s-estate-s213'].ref.estimated.indexOf('rearOverhang') >= 0, 'E63 overhangs flagged estimated');
});

test('shapes-wagon: RS 6 honeycomb cells leave the front number plate clear', function () {
  var m = models[0], pb = bounds(m.front.plateArea), hits = 0;
  m.details.filter(function (d) { return d.view === 'front' && d.role === 'grille'; }).forEach(function (d) {
    d.path.forEach(function (s) {
      s.p.forEach(function (q) { if (q[0] > pb.minX && q[0] < pb.maxX && q[1] > pb.minY && q[1] < pb.maxY) hits++; });
    });
  });
  assert.equal(hits, 0, 'honeycomb vertices inside the plate area');
});

/* ---- critique round 3 ---- */
test('shapes-wagon: round-3 details (RS 6 D-pillar rake, AMG lamps clear the glass, PE black slats, flap inboard)', function () {
  var rs6 = byId['audi-rs6-avant-c8'], amg = byId['mercedes-amg-e63s-estate-s213'], v60 = byId['volvo-v60-polestar-engineered'];
  // RS 6 tailgate: ~30 deg from vertical between the spoiler and the lamp shoulder
  var rake = Math.atan2(2.410 - 2.290, 1.350 - 1.100) * 180 / Math.PI;
  assert.ok(rake > 24 && rake < 36, 'RS 6 tailgate rake ' + rake.toFixed(1));
  assert.ok(bounds(rs6.side.body).minX < -2.45, 'RS 6 tail still reaches the bumper');
  // AMG: tail lamps sit clear below the tailgate glass
  var lampTop = Math.max.apply(null, amg.rear.taillights.map(function (p) { return bounds(p).maxY; }));
  var glassBot = bounds(amg.rear.greenhouse).minY;
  assert.ok(glassBot - lampTop > 0.012, 'AMG lamp/glass gap ' + (glassBot - lampTop).toFixed(3));
  assert.ok(amg.front.headlights[0].paint === 'gloss-black', 'AMG smoked lens');
  assert.ok(!amg.details.some(function (d) { return d.role === 'scoop'; }), 'AMG domes are highlights, not scoops');
  // Volvo PE black-chrome slats; charge flap inside the plan outline
  assert.ok(v60.details.some(function (d) { return d.view === 'front' && d.role === 'grille' && d.paint === 'gloss-black'; }), 'V60 black slats');
  var flap = v60.details.filter(function (d) { return d.role === 'chargePort'; })[0];
  assert.ok(bounds(flap.path).minY > -0.9, 'V60 charge flap inboard');
  // side tail-lamp wraps inset from the tail outline
  [rs6, amg, v60].forEach(function (m) {
    var lamp = m.details.filter(function (d) { return d.view === 'side' && d.paint === 'light-red'; })[0];
    assert.ok(bounds(lamp.path).minX > bounds(m.side.body).minX + 0.008, m.id + ' tail lamp inset');
  });
});

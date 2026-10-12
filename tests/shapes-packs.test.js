/* Node tests for the four CB.shapes model packs (pack-jdm, pack-usa, pack-exotic, pack-sport) loaded together with
   core.js and every per-style model file, the way index.html loads them — run: node tests/run.js shapes-packs
   Checks: every path finite / well-formed; side bounds match ref length + height (1%); arches centred on the axles
   and sized for the real tyres; plan width matches ref width (1%); fit() + toSvgPath() + loftToMesh(sectionsFromViews())
   produce no NaN; no pack model is a style default (and the style defaults are unchanged).
   The packs are registered at load time so every later suite (and the preset tests) sees the full catalogue,
   exactly as in the browser. */
'use strict';
var path = require('path');
var assert = require('node:assert/strict');
var test = globalThis.test || function (name, fn) { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } };

var ROOT = path.join(__dirname, '..');
var STYLES = ['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van'];
var S = require(path.join(ROOT, 'js', 'shapes', 'core.js'));
STYLES.forEach(function (s) { require(path.join(ROOT, 'js', 'shapes', 'models', s + '.js')); });
var BASE_DEFAULTS = {};
STYLES.forEach(function (s) { var d = S.defaultModel(s); BASE_DEFAULTS[s] = d && d.id; });

var PACKS = {
  'pack-jdm': ['nissan-silvia-s15', 'nissan-skyline-gtr-r34', 'toyota-sprinter-trueno-ae86', 'mazda-rx7-fd3s', 'nissan-gtr-r35'],
  'pack-usa': ['ford-mustang-gt-s650', 'chevrolet-camaro-zl1-2019', 'dodge-challenger-srt-hellcat', 'chevrolet-corvette-c8', 'ford-gt-2017', 'jeep-wrangler-rubicon-jl'],
  'pack-exotic': ['lamborghini-huracan-evo', 'ferrari-296-gtb', 'porsche-918-spyder', 'koenigsegg-jesko', 'audi-r8-v10-gen2'],
  'pack-sport': ['bmw-m2-g87', 'bmw-m3-e46', 'alpine-a110', 'aston-martin-vantage-2018', 'lotus-emira', 'subaru-wrx-sti-va', 'mitsubishi-lancer-evo-x']
};
/* Raw (authored) pack models. A pack's require() may be cached by another suite that loaded it standalone, so
   register the exported models explicitly (re-registering an id just replaces it). */
var RAW = {};
Object.keys(PACKS).forEach(function (f) {
  var exp = require(path.join(ROOT, 'js', 'shapes', 'models', f + '.js'));
  var list = Array.isArray(exp) ? exp : exp.models;
  list.forEach(function (m) { RAW[m.id] = m; if (!S.models[m.id] || S.models[m.id] !== m) S.registerModel(m); });
});
var ALL = [].concat.apply([], Object.keys(PACKS).map(function (f) { return PACKS[f]; }));

function isPath(v) { return Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && typeof v[0].t === 'string' && Array.isArray(v[0].p); }
function walkPaths(v, cb, where) {
  if (isPath(v)) return cb(v, where);
  if (Array.isArray(v)) return v.forEach(function (e, i) { walkPaths(e, cb, where + '[' + i + ']'); });
  if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { if (k !== 'sections') walkPaths(v[k], cb, where + '.' + k); });
}
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
function firstPath(slot) { var it = S.items(slot); return it.length ? it[0].path : null; }
function bounds(p) {
  var b = { minA: Infinity, maxA: -Infinity, minB: Infinity, maxB: -Infinity };
  samples(p).forEach(function (q) { b.minA = Math.min(b.minA, q[0]); b.maxA = Math.max(b.maxA, q[0]); b.minB = Math.min(b.minB, q[1]); b.maxB = Math.max(b.maxB, q[1]); });
  return b;
}
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, msg + ': ' + (+a).toFixed(4) + ' vs ' + (+b).toFixed(4) + ' (tol ' + tol + ')'); }
function noNaN(arr, msg) { for (var i = 0; i < arr.length; i++) if (!isFinite(arr[i])) assert.fail(msg + ' at ' + i); }

test('shapes-packs: all 19 pack models register with core.js under a real body style', function () {
  ALL.forEach(function (id) {
    var m = S.models[id];
    assert.ok(m, id + ' registered');
    assert.ok(STYLES.indexOf(m.style) >= 0, id + ' style ' + m.style);
    assert.ok(S.modelsByStyle(m.style).indexOf(m) >= 0, id + ' listed under ' + m.style);
    ['make', 'name', 'gen', 'years', 'enginePosition', 'drivetrain', 'powertrain'].forEach(function (k) { assert.ok(m[k], id + ' ' + k); });
    ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR', 'cd', 'curbWeight_kg', 'rideHeight'].forEach(function (k) {
      assert.ok(typeof m.ref[k] === 'number' && m.ref[k] > 0 && isFinite(m.ref[k]), id + ' ref.' + k);
    });
    assert.equal(S.getModel({ body: { style: m.style, model: id } }, { strict: true }), m, id + ' getModel strict');
  });
});

test('shapes-packs: no pack model is a style default; style defaults unchanged', function () {
  ALL.forEach(function (id) { assert.ok(!RAW[id].default && !S.models[id].default, id + ' must not be a style default'); });
  STYLES.forEach(function (s) { assert.equal(S.defaultModel(s) && S.defaultModel(s).id, BASE_DEFAULTS[s], s + ' default'); });
});

test('shapes-packs: every authored path is finite and well-formed', function () {
  var arity = { M: 1, L: 1, C: 3, Q: 2, Z: 0 };
  ALL.forEach(function (id) {
    var m = RAW[id], n = 0;
    walkPaths(m, function (p, where) {
      n++;
      assert.equal(p[0].t, 'M', id + where + ' starts with M');
      p.forEach(function (s) {
        assert.ok(s.t in arity, id + where + ' bad segment ' + s.t);
        assert.equal(s.p.length, arity[s.t], id + where + ' arity');
        s.p.forEach(function (q) { assert.ok(q.length >= 2 && isFinite(q[0]) && isFinite(q[1]), id + where + ' finite'); });
      });
    }, '');
    assert.ok(n > 30, id + ' has ' + n + ' paths');
    (m.sections || []).forEach(function (sec, i) {
      assert.ok(isFinite(sec.x), id + ' section ' + i + ' x');
      sec.ring.forEach(function (q) { assert.ok(isFinite(q[0]) && isFinite(q[1]), id + ' section ' + i + ' ring finite'); });
    });
  });
});

test('shapes-packs: side body matches ref length and height (1%) and clears the ground', function () {
  ALL.forEach(function (id) {
    var m = S.models[id], r = m.ref, b = bounds(firstPath(m.side.body));
    near(b.maxA - b.minA, r.length, r.length * 0.01, id + ' length');
    // open cars quote the height hood-up (roadster convention: body + greenhouse + soft top)
    var top = m.side.softTop ? Math.max(b.maxB, S.bounds(S.items(m.side.softTop).map(function (i) { return i.path; })).maxY) : b.maxB;
    near(top, r.height, r.height * 0.01, id + ' height');
    near(b.maxA, r.wheelbase / 2 + r.frontOverhang, r.length * 0.01, id + ' front bumper x');
    near(b.minA, -(r.wheelbase / 2 + r.rearOverhang), r.length * 0.01, id + ' rear bumper x');
    assert.ok(b.minB > 0.04 && b.minB < 0.3, id + ' body clears the ground: ' + b.minB);
  });
});

test('shapes-packs: wheel arches centred on the axles and sized for the real tyres', function () {
  ALL.forEach(function (id) {
    var m = S.models[id], r = m.ref;
    [['archF', r.tireF, 1], ['archR', r.tireR, -1]].forEach(function (a) {
      var arch = m.side[a[0]], tr = S.tireDiameter(S.parseTire(a[1])) / 2;
      assert.ok(arch && isFinite(arch.x) && isFinite(arch.y) && isFinite(arch.r), id + ' ' + a[0]);
      near(arch.x, a[2] * r.wheelbase / 2, 0.005, id + ' ' + a[0] + ' x on the axle');
      near(arch.y, tr, 0.012, id + ' ' + a[0] + ' centre height = tyre radius');
      assert.ok(arch.r >= tr + 0.01 && arch.r <= tr + 0.1, id + ' ' + a[0] + ' radius ' + arch.r + ' for tyre r ' + tr);
    });
  });
});

test('shapes-packs: plan view width matches ref width (1%) and is symmetric', function () {
  ALL.forEach(function (id) {
    var m = S.models[id], b = bounds(firstPath(m.top.body));
    near(b.maxB - b.minB, m.ref.width, m.ref.width * 0.01, id + ' plan width');
    near(b.maxB, -b.minB, 0.003, id + ' plan symmetric');
    near(b.maxA - b.minA, m.ref.length, m.ref.length * 0.01, id + ' plan length');
    ['front', 'rear'].forEach(function (v) {
      var bb = bounds(firstPath(m[v].body));
      near(bb.maxA, -bb.minA, 0.003, id + ' ' + v + ' symmetric');
      near(bb.maxA - bb.minA, m.ref.width, m.ref.width * 0.012, id + ' ' + v + ' width');
    });
  });
});

test('shapes-packs: fit() + toSvgPath() + loftToMesh(sectionsFromViews()) are NaN-free', function () {
  ALL.forEach(function (id) {
    var m = S.models[id];
    var f0 = S.fit(m, S.refBuild(m));
    near(S.bounds(f0.side.body).w, m.ref.length, m.ref.length * 0.01, id + ' fit at ref keeps length');
    var f = S.fit(m, { body: { style: m.style, model: id, wheelbase_mm: Math.round(m.ref.wheelbase * 1000) + 60, trackWidth_mm: 1600 },
      suspension: { rideHeight_mm: 90 }, wheels: { diameter_in: 19 }, tires: { widthFront_mm: 255, widthRear_mm: 285, profileFront: 35, profileRear: 30 } });
    ['length', 'width', 'height', 'wheelbase', 'track', 'wheelRadius', 'wheelRadiusR', 'xFront', 'xRear'].forEach(function (k) { assert.ok(isFinite(f.dims[k]), id + ' dims.' + k); });
    ['side', 'top', 'front', 'rear'].forEach(function (v) {
      Object.keys(f[v]).forEach(function (slot) {
        S.items(f[v][slot]).forEach(function (it) {
          if (!it || !S.isPath(it.path)) return;
          var d = S.toSvgPath(it.path, { scale: 100, ox: 300, oy: 200, flipY: v !== 'top', flipX: v === 'front' });
          assert.ok(d.indexOf('NaN') < 0 && d.indexOf('Infinity') < 0, id + ' ' + v + '.' + slot + ' svg');
        });
      });
    });
    [S.loftToMesh(S.sectionsFromViews(f)), S.loftToMesh(S.sectionsFromViews(f, { stations: 16, maxStations: 16, ringVerts: 12 }))].forEach(function (mesh, i) {
      assert.ok(mesh.triangleCount > 0 && mesh.indices.length > 0, id + ' mesh ' + i);
      noNaN(mesh.positions, id + ' mesh ' + i + ' positions');
      noNaN(mesh.normals, id + ' mesh ' + i + ' normals');
      noNaN(mesh.glass.positions, id + ' mesh ' + i + ' glass');
      for (var k = 0; k < mesh.indices.length; k++) assert.ok(mesh.indices[k] < mesh.vertexCount, id + ' index in range');
    });
  });
});

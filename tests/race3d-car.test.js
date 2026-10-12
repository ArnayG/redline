/* FORGE Atelier — CB.gl.car (js/race/gl/car-mesh.js) tests: pure geometry + pose, no GL.
   Every body style x LOD builds without NaN / bad indices within the triangle budget, wheels touch the ground,
   dims match the build (and the race engine's collision box), styles are visibly distinct, aero / wheel / paint
   options change the model, pose() drives roll / pitch / spin / steer / lights correctly, cache shares models.
   The procedural-loft tests pass { shapes: false } (CB.shapes may already be loaded by other test files); the
   "car (real model)" tests at the end load js/shapes/ and check the manufacturer-model path. */
'use strict';
var assert = require('assert');
var path = require('path');

require(path.join(__dirname, '..', 'js', 'data.js'));
var CAR = require(path.join(__dirname, '..', 'js', 'race', 'gl', 'car-mesh.js'));
var D = globalThis.CB.data;

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var test = standalone
  ? function (name, fn) {
    try { fn(); console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
  }
  : globalThis.test;

var OVERHANG = { coupe: 1.85, sedan: 2.05, hatchback: 1.5, wagon: 2.1, suv: 2.0, roadster: 1.6, pickup: 2.6, hypercar: 1.95, 'shooting-brake': 2.0, van: 2.3 };

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function deep(a, b) { for (var k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) { a[k] = a[k] || {}; deep(a[k], b[k]); } else a[k] = b[k]; } return a; }
function styleBuild(style, extra) {
  var b = D.defaultBuild(), bs = D.bodyStyles.find(function (x) { return x.id === style; });
  b.body.style = style; b.body.wheelbase_mm = bs.defaultWheelbase; b.body.doors = bs.doorOptions[0]; b.body.seats = bs.seatOptions[0];
  if (extra) deep(b, extra);
  return b;
}
function presetBuild(p) { return deep(clone(D.defaultBuild()), clone(p.build)); }
var cache = {};
function geomOf(style, lod, extra, opts) {
  var k = style + lod + JSON.stringify(extra || {}) + JSON.stringify(opts || {});
  if (!cache[k]) { var o = Object.assign({ lod: lod, shapes: false }, opts || {}); cache[k] = CAR.buildGeometry(styleBuild(style, extra), o); }
  return cache[k];
}
function finishParts(g) { return g.parts.map(function (p) { return { p: p, f: p.geo.finish ? p.geo.finish() : p.geo }; }); }
function partByKind(model, kind) { return model.parts.filter(function (p) { return p.kind === kind; })[0]; }
function checkGeo(f, label) {
  var nv = f.positions.length / 3;
  assert.ok(nv > 0, label + ': has vertices');
  assert.strictEqual(f.normals.length, f.positions.length, label + ': normals');
  assert.strictEqual(f.uvs.length, nv * 2, label + ': uvs');
  assert.strictEqual(f.colors.length, nv * 4, label + ': colours');
  assert.strictEqual(f.indices.length % 3, 0, label + ': triangles');
  for (var i = 0; i < f.positions.length; i++) if (!isFinite(f.positions[i]) || !isFinite(f.normals[i])) assert.fail(label + ': NaN at ' + i);
  for (i = 0; i < f.colors.length; i++) if (!isFinite(f.colors[i])) assert.fail(label + ': NaN colour');
  for (i = 0; i < f.uvs.length; i++) if (!isFinite(f.uvs[i])) assert.fail(label + ': NaN uv');
  for (i = 0; i < f.indices.length; i++) if (f.indices[i] >= nv) assert.fail(label + ': index out of range');
  for (i = 0; i < f.normals.length; i += 3) {
    var l = Math.hypot(f.normals[i], f.normals[i + 1], f.normals[i + 2]);
    if (Math.abs(l - 1) > 0.02) assert.fail(label + ': non-unit normal ' + l);
  }
}
function xf(m, x, y, z) { return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]; }

test('car: API surface', function () {
  assert.strictEqual(globalThis.CB.gl.car, CAR);
  ['build', 'pose', 'buildGeometry', 'resolve'].forEach(function (k) { assert.strictEqual(typeof CAR[k], 'function', k); });
  ['get', 'clear', 'size', 'key'].forEach(function (k) { assert.strictEqual(typeof CAR.cache[k], 'function', 'cache.' + k); });
  assert.deepStrictEqual(CAR.STYLES.slice().sort(), D.bodyStyles.map(function (b) { return b.id; }).sort());
});

test('car: every body style x LOD builds cleanly within the triangle budget', function () {
  CAR.STYLES.forEach(function (st) {
    ['high', 'low'].forEach(function (lod) {
      var g = geomOf(st, lod);
      finishParts(g).forEach(function (x) { checkGeo(x.f, st + '/' + lod + '/' + x.p.kind); });
      var t = g.stats.triangles;
      if (lod === 'low') assert.ok(t < 400, st + ' low LOD ' + t + ' tris');
      else assert.ok(t >= 8000 && t <= 30000, st + ' high LOD ' + t + ' tris');
      ['cockpitEye', 'hoodCam', 'bumperCam'].forEach(function (k) {
        assert.ok(g[k].length === 3 && g[k].every(isFinite), st + ' ' + k);
      });
    });
  });
});

test('car: high LOD has every required part kind', function () {
  var g = geomOf('coupe', 'high');
  var kinds = g.parts.map(function (p) { return p.kind; });
  ['body', 'glass', 'light-head', 'light-brake', 'light-rev', 'wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr',
    'caliper-fl', 'caliper-fr', 'caliper-rl', 'caliper-rr', 'tire-fl', 'interior', 'driver', 'trim', 'chrome'].forEach(function (k) {
    assert.ok(kinds.indexOf(k) >= 0, 'missing part ' + k);
  });
  assert.ok(partByKind(g, 'glass').transparent, 'glass is transparent');
  assert.ok(partByKind(g, 'glass').material.opacity < 1);
  var low = geomOf('coupe', 'low').parts.map(function (p) { return p.kind; });
  ['body', 'wheels', 'light-head', 'light-brake'].forEach(function (k) { assert.ok(low.indexOf(k) >= 0, 'low missing ' + k); });
});

test('car: wheels touch the ground and sit on the axle lines', function () {
  CAR.STYLES.forEach(function (st) {
    ['high', 'low'].forEach(function (lod) {
      var m = CAR.build(null, styleBuild(st), { lod: lod, shapes: false });
      var items = CAR.pose(m, { x: 0, y: 0, heading: 0, speed: 0 }, 1 / 60, {});
      var minY = Infinity;
      items.forEach(function (it) {
        if (!/^tire-|^wheels$/.test(it.kind)) return;
        var P = it.mesh.geometry.positions;
        for (var i = 0; i < P.length; i += 3) { var w = xf(it.model, P[i], P[i + 1], P[i + 2]); if (w[1] < minY) minY = w[1]; }
      });
      assert.ok(Math.abs(minY) < 0.012, st + '/' + lod + ' lowest tyre point ' + minY);
      // body never dips below the ground
      var body = items.filter(function (it) { return it.kind === 'body'; })[0], by = Infinity;
      var BP = body.mesh.geometry.positions;
      for (var k = 1; k < BP.length; k += 3) if (BP[k] < by) by = BP[k];
      assert.ok(by > 0.03, st + '/' + lod + ' body clears the ground (' + by + ')');
    });
  });
});

test('car: dims match the build and the engine collision box', function () {
  CAR.STYLES.forEach(function (st) {
    var b = styleBuild(st), g = geomOf(st, 'high');
    var d = g.dims, wb = b.body.wheelbase_mm / 1000;
    assert.ok(Math.abs(d.wheelbase - wb) < 1e-9, st + ' wheelbase');
    assert.ok(Math.abs(d.track - b.body.trackWidth_mm / 1000) < 1e-9, st + ' track');
    assert.ok(Math.abs(d.rideHeight - b.suspension.rideHeight_mm / 1000) < 1e-9, st + ' ride height');
    assert.ok(Math.abs(d.length - (wb + OVERHANG[st])) < 1e-9, st + ' length = engine L');
    assert.ok(Math.abs(d.width - (b.body.trackWidth_mm / 1000 + 0.32)) < 1e-9, st + ' width = engine W');
    var rf = b.wheels.diameter_in * 0.0254 / 2 + b.tires.widthFront_mm / 1000 * b.tires.profileFront / 100;
    var rr = b.wheels.diameter_in * 0.0254 / 2 + b.tires.widthRear_mm / 1000 * b.tires.profileRear / 100;
    assert.ok(Math.abs(d.wheelRadiusFront - rf) < 1e-9 && Math.abs(d.wheelRadiusRear - rr) < 1e-9, st + ' wheel radius');
    assert.ok(Math.abs(d.frontAxle - d.rearAxle - wb) < 1e-9, st + ' axle spacing');
    // the body mesh spans the declared length / width / height
    var f = partByKind(g, 'body').geo.finish(), bb = f.bounds;
    assert.ok(Math.abs((bb.max[0] - bb.min[0]) - d.length) < 0.03, st + ' body length ' + (bb.max[0] - bb.min[0]));
    assert.ok(Math.abs(bb.max[0] + bb.min[0]) < 0.03, st + ' body centred on the origin');
    // lower body width (below the beltline: excludes the body-coloured mirrors, which stick out beyond the box)
    var zmax = 0;
    for (var q = 0; q < f.positions.length; q += 3) if (f.positions[q + 1] < d.belt - 0.01) zmax = Math.max(zmax, Math.abs(f.positions[q + 2]));
    var w = 2 * zmax;
    assert.ok(w > d.width - 0.02 && w < d.width + 0.16, st + ' body width ' + w);
    assert.ok(bb.max[2] - bb.min[2] < d.width + 0.5, st + ' mirrors stay close to the body');
    assert.ok(Math.abs(bb.max[1] - d.height) < 0.12, st + ' body height ' + bb.max[1] + ' vs ' + d.height);
    // wheels within the body's footprint
    g.parts.filter(function (p) { return p.wheel; }).forEach(function (p) {
      assert.ok(Math.abs(Math.abs(p.wheel.z) - d.track / 2) < 1e-9, st + ' wheel on track line');
    });
  });
});

test('car: dims follow the engine-provided length/width and build changes', function () {
  var g = CAR.buildGeometry(styleBuild('sedan'), { length_m: 5.1, width_m: 1.95, shapes: false });
  assert.strictEqual(g.dims.length, 5.1); assert.strictEqual(g.dims.width, 1.95);
  var lo = geomOf('coupe', 'high', { suspension: { rideHeight_mm: 70 } }), hi = geomOf('coupe', 'high', { suspension: { rideHeight_mm: 200 } });
  assert.ok(hi.dims.height - lo.dims.height > 0.1, 'ride height raises the body');
  var big = geomOf('coupe', 'high', { wheels: { diameter_in: 22 } }), small = geomOf('coupe', 'high', { wheels: { diameter_in: 16 } });
  assert.ok(big.dims.wheelRadius > small.dims.wheelRadius + 0.05, 'wheel diameter');
  var longWb = geomOf('sedan', 'high', { body: { wheelbase_mm: 3100 } });
  assert.ok(Math.abs(longWb.dims.wheelbase - 3.1) < 1e-9);
});

test('car: all 10 body styles are visibly distinct', function () {
  var sig = CAR.STYLES.map(function (st) {
    var g = geomOf(st, 'high'), S = g.S, gh = CAR._;
    var prof = [];
    for (var k = 0; k <= 12; k++) {
      var x = S.xF - S.L * k / 12, y = gh.topAt(S, x, 0, true);
      prof.push(y === null ? 0 : y);
    }
    return { st: st, prof: prof, open: S.openTop, tub: S.tub && S.tub.kind };
  });
  for (var i = 0; i < sig.length; i++) {
    for (var j = i + 1; j < sig.length; j++) {
      var a = sig[i].prof, b = sig[j].prof, diff = 0;
      for (var k = 0; k < a.length; k++) diff = Math.max(diff, Math.abs(a[k] - b[k]));
      assert.ok(diff > 0.06, sig[i].st + ' vs ' + sig[j].st + ' side profiles too similar (' + diff.toFixed(3) + ')');
    }
  }
  assert.ok(sig.filter(function (s) { return s.open; }).map(function (s) { return s.st; }).join() === 'roadster', 'only the roadster is open');
  assert.strictEqual(sig.filter(function (s) { return s.tub === 'bed'; })[0].st, 'pickup');
  // roadster: no roof over the cockpit; pickup: bed floor well below the bed rails
  var R = geomOf('roadster', 'high').S, Rx = (R.tub.x0 + R.tub.x1) / 2;
  assert.ok(CAR._.topAt(R, Rx, 0, true) < R.beltY - 0.2, 'roadster cockpit is open');
  var P = geomOf('pickup', 'high').S, Px = (P.tub.x0 + P.tub.x1) / 2;
  assert.ok(CAR._.topAt(P, Px, 0, true) < P.deckY - 0.15, 'pickup bed is open');
  // hypercar is the lowest hard-top, van / pickup / suv the tallest
  var hs = CAR.STYLES.filter(function (st) { return !geomOf(st, 'high').S.openTop; }).map(function (st) { return [st, geomOf(st, 'high').dims.roof]; }).sort(function (a, b) { return a[1] - b[1]; });
  assert.strictEqual(hs[0][0], 'hypercar');
  assert.ok(['van', 'pickup', 'suv'].indexOf(hs[hs.length - 1][0]) >= 0);
});

test('car: lower body faces outward (consistent winding + normals)', function () {
  CAR.STYLES.forEach(function (st) {
    var f = partByKind(geomOf(st, 'high'), 'body').geo.finish();
    var P = f.positions, N = f.normals, I = f.indices, agree = 0, total = 0, vol = 0;
    for (var t = 0; t < I.length; t += 3) {
      var a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      var e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      var n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      var area = Math.hypot(n[0], n[1], n[2]);
      if (area < 1e-9) continue;
      total += area;
      if (n[0] * N[a] + n[1] * N[a + 1] + n[2] * N[a + 2] > 0) agree += area;
      vol += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    }
    assert.ok(agree / total > 0.97, st + ' winding agrees with normals ' + (agree / total).toFixed(3));
    assert.ok(vol > 0, st + ' body encloses positive volume (outward)');
  });
});

test('car: cockpit eye / cameras sit inside the car', function () {
  CAR.STYLES.forEach(function (st) {
    var g = geomOf(st, 'high'), e = g.cockpitEye, d = g.dims;
    assert.ok(Math.abs(e[0]) < d.length / 2 && Math.abs(e[2]) < d.width / 2, st + ' eye in footprint');
    assert.ok(e[1] > d.belt + 0.05 && e[1] < d.roof + 0.3, st + ' eye between belt and roof');
    assert.ok(e[2] <= 0, st + ' driver on the left (-Z) or centre');
    assert.ok(g.bumperCam[0] > d.length / 2 - 0.01, st + ' bumper cam at the nose');
    assert.ok(g.hoodCam[1] > d.nose, st + ' hood cam above the nose');
  });
  assert.strictEqual(geomOf('hypercar', 'high', { body: { seats: 1 } }).cockpitEye[2], 0, 'single seater on the centre line');
});

test('car: aero options add the right parts', function () {
  var base = geomOf('coupe', 'high', { aero: { wing: 'none', splitter: 'none', diffuser: 'none', canards: false, sideSkirts: false } });
  assert.ok(!partByKind(base, 'wing'));
  ['swan-neck', 'gt-wing', 'active', 'biplane'].forEach(function (w) {
    var g = geomOf('coupe', 'high', { aero: { wing: w, wingAngle_deg: 12 } }), p = partByKind(g, 'wing');
    assert.ok(p && p.geo.tris() > 50, w + ' wing part');
    var bb = p.geo.finish().bounds;
    assert.ok(bb.max[1] > g.S.deckY + 0.1 && bb.min[0] < 0, w + ' wing above the rear deck');
    assert.strictEqual(!!p.wing.active, w === 'active');
  });
  var bi = partByKind(geomOf('coupe', 'high', { aero: { wing: 'biplane' } }), 'wing').geo.tris(), gt = partByKind(geomOf('coupe', 'high', { aero: { wing: 'gt-wing' } }), 'wing').geo.tris();
  assert.ok(bi > gt, 'biplane has two elements');
  // wing angle changes the element
  var a0 = partByKind(geomOf('coupe', 'high', { aero: { wing: 'gt-wing', wingAngle_deg: 0 } }), 'wing').geo.finish().bounds;
  var a20 = partByKind(geomOf('coupe', 'high', { aero: { wing: 'gt-wing', wingAngle_deg: 20 } }), 'wing').geo.finish().bounds;
  assert.ok(Math.abs((a20.max[1] - a20.min[1]) - (a0.max[1] - a0.min[1])) > 0.01 || Math.abs(a20.max[1] - a0.max[1]) > 0.01, 'wing angle');
  // integrated spoilers grow the body
  ['ducktail', 'lip-spoiler'].forEach(function (w) {
    var g = geomOf('coupe', 'high', { aero: { wing: w } });
    assert.ok(!partByKind(g, 'wing'));
    assert.ok(partByKind(g, 'body').geo.tris() > partByKind(base, 'body').geo.tris(), w + ' adds body panels');
  });
  var full = geomOf('coupe', 'high', { aero: { splitter: 'race', diffuser: 'race', canards: true, sideSkirts: true, wing: 'none' } });
  assert.ok(partByKind(full, 'carbon').geo.tris() > 100, 'race splitter / diffuser / skirts / canards in carbon');
  var mild = geomOf('coupe', 'high', { aero: { splitter: 'none', diffuser: 'mild', canards: false, sideSkirts: false, wing: 'none' } });
  assert.ok(partByKind(mild, 'trim').geo.tris() > partByKind(base, 'trim').geo.tris(), 'mild diffuser');
});

test('car: wheel designs, exhausts, lights, roof and stripes change the model', function () {
  var counts = {};
  D.wheelDesigns.forEach(function (w) {
    counts[w.id] = partByKind(geomOf('coupe', 'high', { wheels: { design: w.id } }), 'wheel-fl').geo.tris();
  });
  var uniq = {};
  Object.keys(counts).forEach(function (k) { uniq[counts[k]] = 1; });
  assert.ok(Object.keys(uniq).length >= 8, 'wheel designs produce distinct rims: ' + JSON.stringify(counts));
  // exhaust tips per type (EV: none)
  var ch = function (ex) { return partByKind(geomOf('coupe', 'high', { engine: { exhaust: ex } }), 'chrome').geo.tris(); };
  assert.ok(ch('titanium') > ch('sport') && ch('sport') > ch('straight-pipe'), 'tip counts 4 > 2 > 1');
  var ev = geomOf('coupe', 'high', { engine: { type: 'ev', exhaust: 'titanium' } });
  assert.strictEqual(ev.anchors.exhaust.length, 0, 'EV has no exhaust');
  assert.strictEqual(geomOf('coupe', 'high', { engine: { exhaust: 'titanium' } }).anchors.exhaust.length, 4);
  // headlights and brake lights on both sides
  var g = geomOf('sedan', 'high');
  assert.strictEqual(g.anchors.headlights.length, 2); assert.ok(g.anchors.brakeLights.length >= 2);
  assert.ok(g.anchors.headlights[0][2] * g.anchors.headlights[1][2] < 0, 'headlights mirrored');
  // roof options
  ['black', 'contrast'].forEach(function (r) { assert.ok(partByKind(geomOf('coupe', 'high', { exterior: { roof: r } }), 'roof'), r + ' roof part'); });
  assert.ok(partByKind(geomOf('coupe', 'high', { exterior: { roof: 'carbon' } }), 'carbon').geo.tris() > 50, 'carbon roof');
  assert.ok(partByKind(geomOf('coupe', 'high', { exterior: { roof: 'glass' } }), 'glass').geo.tris() > partByKind(geomOf('coupe', 'high'), 'glass').geo.tris(), 'panoramic roof');
  // stripes
  var plain = partByKind(geomOf('coupe', 'high'), 'body').geo.tris();
  D.stripes.filter(function (s) { return s.id !== 'none'; }).forEach(function (s) {
    var gg = geomOf('coupe', 'high', { exterior: { stripe: s.id, stripeColor: '#ffffff' } });
    var more = partByKind(gg, 'body').geo.tris() + partByKind(gg, 'trim').geo.tris() - plain - partByKind(geomOf('coupe', 'high'), 'trim').geo.tris();
    assert.ok(more > 10, s.id + ' stripe adds geometry (' + more + ')');
  });
  // number roundels (texture-less fallback geometry in Node)
  var n0 = partByKind(geomOf('coupe', 'high', { exterior: { livery_number: '' } }, { isPlayer: true }), 'trim').geo.tris();
  var n1 = partByKind(geomOf('coupe', 'high', { exterior: { livery_number: '27' } }, { isPlayer: true }), 'trim').geo.tris();
  assert.ok(n1 > n0, 'race number decals');
  // the paint colour lands in the body vertex colours (linear)
  var red = partByKind(geomOf('coupe', 'high', { exterior: { paint: '#ff0000' } }), 'body').geo;
  assert.ok(red.c[0] > 0.9 && red.c[1] < 0.01, 'paint vertex colour');
});

test('car: paint finish -> material', function () {
  function mat(fin) { return partByKind(geomOf('coupe', 'high', { exterior: { finish: fin } }), 'body').material; }
  assert.ok(mat('chrome').metallic === 1 && mat('chrome').roughness <= 0.06);
  assert.ok(mat('matte').roughness > 0.7 && mat('matte').clearcoat === 0);
  assert.ok(mat('metallic').flake > 0 && mat('metallic').uFlake === mat('metallic').flake);
  assert.ok(mat('chameleon').hueShift > 0.2 && mat('chameleon').uHueShift === mat('chameleon').hueShift);
  assert.ok(mat('solid').metallic < mat('metallic').metallic);
  var m = mat('pearl');
  assert.strictEqual(m.uBaseColor, m.baseColor); assert.strictEqual(m.uRoughness, m.roughness);
  var tint0 = partByKind(geomOf('coupe', 'high', { exterior: { windowTint_pct: 0 } }), 'glass').material.opacity;
  var tint85 = partByKind(geomOf('coupe', 'high', { exterior: { windowTint_pct: 85 } }), 'glass').material.opacity;
  assert.ok(tint85 > tint0 + 0.3, 'window tint');
  var cal = partByKind(geomOf('coupe', 'high', { exterior: { caliperColor: '#00ff00' } }), 'caliper-fl').geo;
  assert.ok(cal.c[1] > 0.9 && cal.c[0] < 0.05, 'caliper colour');
});

test('car: every preset builds at both LODs within budget', function () {
  D.presets.forEach(function (p) {
    ['high', 'low'].forEach(function (lod) {
      var g = CAR.buildGeometry(presetBuild(p), { lod: lod, number: '12', color: '#3355aa', accent: '#ffcc00', shapes: false });
      finishParts(g).forEach(function (x) { checkGeo(x.f, p.id + '/' + lod + '/' + x.p.kind); });
      if (lod === 'low') assert.ok(g.stats.triangles < 400, p.id + ' low ' + g.stats.triangles);
      else assert.ok(g.stats.triangles <= 30000, p.id + ' high ' + g.stats.triangles);
    });
  });
  // garbage in, sane car out
  var g = CAR.buildGeometry({ body: { style: 'tank', wheelbase_mm: 'x' }, wheels: { diameter_in: 99 } }, { shapes: false });
  assert.strictEqual(g.S.style, 'coupe');
  finishParts(g).forEach(function (x) { checkGeo(x.f, 'garbage/' + x.p.kind); });
  finishParts(CAR.buildGeometry(null, { lod: 'low', shapes: false })).forEach(function (x) { checkGeo(x.f, 'null/' + x.p.kind); });
});

test('car: pose — world transform, wheel spin, steering, lights', function () {
  var m = CAR.build(null, styleBuild('coupe'), { lod: 'high', shapes: false }), st = {};
  var items = CAR.pose(m, { x: 10, y: 20, heading: Math.PI / 2, speed: 0 }, 0, st);
  assert.strictEqual(items.length, m.parts.length);
  items.forEach(function (it) { for (var i = 0; i < 16; i++) assert.ok(isFinite(it.model[i]), it.kind + ' finite'); assert.ok(it.mesh && it.material); });
  var body = items.filter(function (it) { return it.kind === 'body'; })[0];
  // car-local +X maps to the sim heading (+y sim = GL -z); origin at (x, 0, -y)
  assert.ok(Math.abs(body.model[12] - 10) < 1e-3 && Math.abs(body.model[14] + 20) < 1e-3);
  var fwd = xf(body.model, 1, 0, 0);
  assert.ok(Math.abs(fwd[0] - 10) < 1e-3 && Math.abs(fwd[2] + 21) < 1e-3, 'local +X -> sim heading');
  // steering: front wheels rotate about Y, rear do not
  st = {};
  CAR.pose(m, { x: 0, y: 0, heading: 0, steerAngle: 0.3 }, 0, st);
  var fl = st.items.filter(function (i) { return i.kind === 'wheel-fl'; })[0], rl = st.items.filter(function (i) { return i.kind === 'wheel-rl'; })[0];
  var ax = function (it) { return Math.atan2(-it.model[2], it.model[0]); };   // yaw of the wheel's local X
  assert.ok(Math.abs(ax(fl) - 0.3) < 0.02, 'front wheel steers left for +steer (' + ax(fl) + ')');
  assert.ok(Math.abs(ax(rl)) < 0.02, 'rear wheel straight');
  var cal = st.items.filter(function (i) { return i.kind === 'caliper-fl'; })[0];
  assert.ok(Math.abs(ax(cal) - 0.3) < 0.02, 'caliper steers with the wheel');
  // spin: rolling forward 1 m turns the wheel by 1/r (top moves forward)
  st = {};
  var r = m.dims.wheelRadiusRear;
  CAR.pose(m, { x: 0, y: 0, heading: 0, speed: 10, vx: 10, vy: 0 }, 0, st);
  CAR.pose(m, { x: 0.1, y: 0, heading: 0, speed: 10, vx: 10, vy: 0 }, 0.01, st);
  var rr = st.items.filter(function (i) { return i.kind === 'wheel-rr'; })[0];
  var top = xf(rr.model, 0, 0.3, 0), ctr = xf(rr.model, 0, 0, 0);
  assert.ok(top[0] - ctr[0] > 0, 'top of the wheel rolls forward');
  assert.ok(Math.abs(st.spinR + 0.1 / r) < 1e-6, 'spin angle = distance / radius');
  // calipers do not spin
  var cr = st.items.filter(function (i) { return i.kind === 'caliper-rr'; })[0];
  assert.ok(Math.abs(cr.model[1]) < 1e-6, 'caliper does not rotate with the wheel');
  // brake / head / reverse lights
  st = {};
  CAR.pose(m, { x: 0, y: 0, heading: 0, brake: 0 }, 1 / 60, st);
  var bl = st.items.filter(function (i) { return i.kind === 'light-brake'; })[0];
  var off = bl.material.emissive[0];
  CAR.pose(m, { x: 0, y: 0, heading: 0, brake: 1 }, 1 / 60, st);
  assert.ok(bl.material.emissive[0] > off + 2, 'brake lights glow under braking');
  assert.notStrictEqual(bl.material, partByKind(m, 'light-brake').material, 'per-car light material (shared models stay untouched)');
  var hl = st.items.filter(function (i) { return i.kind === 'light-head'; })[0];
  var drl = hl.material.emissive[0];
  CAR.pose(m, { x: 0, y: 0, heading: 0, headlights: true }, 1 / 60, st);
  assert.ok(hl.material.emissive[0] > drl + 2, 'headlights');
  var rv = st.items.filter(function (i) { return i.kind === 'light-rev'; })[0];
  CAR.pose(m, { x: 0, y: 0, heading: 0, gear: -1 }, 1 / 60, st);
  assert.ok(rv.material.emissive[0] > 1, 'reverse light');
  CAR.pose(m, { x: 0, y: 0, heading: 0, gear: 2 }, 1 / 60, st);
  assert.strictEqual(rv.material.emissive[0], 0);
});

test('car: pose — body roll and pitch from accelerations (spring-damper)', function () {
  var m = CAR.build(null, styleBuild('coupe'), { lod: 'high', shapes: false });
  function run(fn, n) {
    var st = {}, s = { x: 0, y: 0, heading: 0, speed: 20 }, dt = 1 / 60;
    for (var i = 0; i < n; i++) { fn(s, i, dt); CAR.pose(m, s, dt, st); }
    return st;
  }
  // steady left turn: heading increases -> body rolls to the right (+Z): local up gains +z
  var st = run(function (s, i, dt) { s.heading += 0.5 * dt; s.x += Math.cos(s.heading) * 20 * dt; s.y += Math.sin(s.heading) * 20 * dt; s.vx = Math.cos(s.heading) * 20; s.vy = Math.sin(s.heading) * 20; }, 120);
  assert.ok(st.roll > 0.005 && st.roll < 0.1, 'roll outward in a left turn: ' + st.roll);
  // accelerating: nose up (pitch > 0); braking: nose dive
  var acc = run(function (s, i, dt) { s.speed += 6 * dt; s.vx = s.speed; s.vy = 0; s.x += s.speed * dt; }, 90);
  assert.ok(acc.pitch > 0.002, 'squat under acceleration: ' + acc.pitch);
  var brk = run(function (s, i, dt) { s.speed = Math.max(0, 40 - 9 * i * dt); s.vx = s.speed; s.vy = 0; s.x += s.speed * dt; s.brake = 1; }, 90);
  assert.ok(brk.pitch < -0.002, 'dive under braking: ' + brk.pitch);
  var body = brk.items.filter(function (i) { return i.kind === 'body'; })[0];
  assert.ok(body.model[1] < 0, 'body X axis tilts down under braking');
  // wheels stay on the ground while the body pitches
  var tyre = brk.items.filter(function (i) { return i.kind === 'tire-fl'; })[0];
  assert.ok(Math.abs(tyre.model[13] - m.dims.wheelRadiusFront) < 1e-6, 'wheel centre height unaffected');
  // teleports (resets) don't kick the suspension
  var stT = {};
  CAR.pose(m, { x: 0, y: 0, heading: 0, speed: 0 }, 1 / 60, stT);
  CAR.pose(m, { x: 500, y: 300, heading: 2, speed: 0 }, 1 / 60, stT);
  assert.ok(Math.abs(stT.aLat) < 1e-6 && Math.abs(stT.aLong) < 1e-6, 'teleport ignored');
  // stable under a long dt
  var stL = {};
  for (var k = 0; k < 20; k++) CAR.pose(m, { x: k * 5, y: 0, heading: k * 0.3, speed: 50, vx: 50, vy: 0 }, 0.1, stL);
  assert.ok(isFinite(stL.roll) && Math.abs(stL.roll) < 0.2 && isFinite(stL.pitch));
});

test('car: pose — active aero wing deploys as an air brake', function () {
  var m = CAR.build(null, styleBuild('hypercar', { aero: { wing: 'active', wingAngle_deg: 8 } }), { lod: 'high', shapes: false }), st = {};
  CAR.pose(m, { x: 0, y: 0, heading: 0, speed: 40, brake: 0 }, 0, st);
  var w = st.items.filter(function (i) { return i.kind === 'wing'; })[0];
  var a0 = st.wingAng;
  for (var i = 0; i < 60; i++) CAR.pose(m, { x: 0, y: 0, heading: 0, speed: 40, brake: 1 }, 1 / 60, st);
  assert.ok(st.wingAng > a0 + 0.3, 'wing tilts up under braking');
  assert.ok(isFinite(w.model[0]));
});

test('car: cache shares models by build hash; low LOD separate', function () {
  var ctx = { fake: true }, b = styleBuild('wagon');
  var a = CAR.build(ctx, b, { lod: 'high', number: '5' }), a2 = CAR.build(ctx, clone(b), { lod: 'high', number: '5' });
  assert.strictEqual(a, a2, 'same build -> same model');
  var lo = CAR.build(ctx, b, { lod: 'low', number: '5' });
  assert.notStrictEqual(a, lo);
  var other = CAR.build(ctx, b, { lod: 'high', number: '6' });
  assert.notStrictEqual(a, other, 'number is part of the key');
  assert.strictEqual(CAR.cache.size(ctx), 3);
  assert.strictEqual(CAR.cache.get(ctx, a.key), a);
  a.destroy();
  assert.strictEqual(CAR.cache.get(ctx, a.key), a, 'still referenced once');
  a2.destroy();
  assert.strictEqual(CAR.cache.get(ctx, a.key), null, 'released when the last user destroys it');
  CAR.cache.clear(ctx);
  assert.strictEqual(CAR.cache.size(ctx), 0);
  // the model contract
  assert.ok(lo.parts.every(function (p) { return p.mesh && p.material && p.local && p.local.length === 16 && typeof p.kind === 'string'; }));
  ['length', 'width', 'height', 'wheelbase', 'track', 'wheelRadius', 'rideHeight'].forEach(function (k) { assert.ok(isFinite(lo.dims[k]), 'dims.' + k); });
  assert.strictEqual(typeof lo.destroy, 'function');
});

/* ---------------------------------------------------------------- real manufacturer models (CB.shapes) */
var SH = require(path.join(__dirname, '..', 'js', 'shapes', 'core.js'));
// the shipped models (js/shapes/README.md); other test files may register fixtures in the same registry
var REAL_IDS = ['porsche-911-992', 'bmw-m4-g82', 'toyota-gr-supra-a90', 'bmw-m3-g80', 'mercedes-amg-c63-w206', 'tesla-model-s-2021',
  'vw-golf-gti-mk8', 'honda-civic-type-r-fl5', 'toyota-gr-yaris', 'audi-rs6-avant-c8', 'mercedes-amg-e63s-estate-s213',
  'volvo-v60-polestar-engineered', 'porsche-cayenne-e3', 'range-rover-sport-l461', 'lamborghini-urus', 'mazda-mx5-nd', 'bmw-z4-g29',
  'porsche-718-boxster-982', 'ford-f150-raptor-gen3', 'toyota-tacoma-trdpro-2024', 'tesla-cybertruck', 'ferrari-sf90-stradale',
  'mclaren-p1', 'bugatti-chiron', 'porsche-taycan-cross-turismo', 'ferrari-gtc4lusso', 'mercedes-cls-shooting-brake-x218',
  'mercedes-sprinter-vs30', 'vw-id-buzz', 'ford-transit-hr'];
SH.STYLES.forEach(function (st) { require(path.join(__dirname, '..', 'js', 'shapes', 'models', st + '.js')); });
function realModels() { return REAL_IDS.map(function (id) { return SH.models[id]; }).filter(function (m) { return m && CAR.STYLES.indexOf(m.style) >= 0; }); }
function modelBuild(m, extra) { var b = styleBuild(m.style, extra); b.body.model = m.id; return b; }
var rcache = {};
function realGeom(id, lod, extra, opts) {
  var k = id + lod + JSON.stringify(extra || {}) + JSON.stringify(opts || {});
  if (!rcache[k]) rcache[k] = CAR.buildGeometry(modelBuild(SH.models[id], extra), Object.assign({ lod: lod, carStyle: 'detailed' }, opts || {}));   // detailed mesh (low-poly: tests/lowpoly.test.js)
  return rcache[k];
}

test('car (real model): every model builds cleanly at both LODs within budget', function () {
  assert.ok(realModels().length >= 24, 'shipped models registered: ' + realModels().length);
  realModels().forEach(function (m) {
    ['high', 'low'].forEach(function (lod) {
      var g = realGeom(m.id, lod);
      assert.ok(g.model && g.model.id === m.id, m.id + ' uses its model');
      finishParts(g).forEach(function (x) { checkGeo(x.f, m.id + '/' + lod + '/' + x.p.kind); });
      if (lod === 'low') assert.ok(g.stats.triangles < 400, m.id + ' low ' + g.stats.triangles);
      else assert.ok(g.stats.triangles >= 8000 && g.stats.triangles <= 40000, m.id + ' high ' + g.stats.triangles);
    });
  });
});

test('car (real model): dims, wheels and body follow the fitted model', function () {
  realModels().forEach(function (m) {
    var b = modelBuild(m), f = SH.fit(m, b), g = realGeom(m.id, 'high'), d = g.dims;
    assert.strictEqual(d.model, m.id);
    assert.ok(Math.abs(d.length - f.dims.length) < 0.02, m.id + ' length ' + d.length + ' vs ' + f.dims.length);
    assert.ok(Math.abs(d.wheelbase - f.dims.wheelbase) < 1e-9, m.id + ' wheelbase');
    var bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };   // painted body + black cladding
    ['body', 'trim'].forEach(function (k) {
      var q = partByKind(g, k); if (!q) return;
      var fb = q.geo.finish().bounds;
      for (var c = 0; c < 3; c++) { bb.min[c] = Math.min(bb.min[c], fb.min[c]); bb.max[c] = Math.max(bb.max[c], fb.max[c]); }
    });
    assert.ok(Math.abs(bb.max[0] + bb.min[0]) < 0.03, m.id + ' body centred on the length');
    assert.ok(Math.abs((bb.max[0] - bb.min[0]) - d.length) < 0.05, m.id + ' body spans the length');
    assert.ok(bb.min[1] > 0.03, m.id + ' body clears the ground');
    // wheels at the fitted axles / tracks, on the ground
    g.parts.filter(function (p) { return p.wheel; }).forEach(function (p) {
      var W = p.wheel.front ? f.wheels.front : f.wheels.rear;
      assert.ok(Math.abs(p.wheel.x - (W.x - f.dims.centerX)) < 1e-6, m.id + ' wheel x');
      assert.ok(Math.abs(Math.abs(p.wheel.z) - W.track / 2) < 1e-6, m.id + ' wheel track');
      assert.ok(Math.abs(p.wheel.y - p.wheel.r) < 1e-9, m.id + ' wheel on the ground');
    });
    // cameras inside the real greenhouse
    var e = g.cockpitEye;
    assert.ok(Math.abs(e[0]) < d.length / 2 && Math.abs(e[2]) < d.width / 2, m.id + ' eye in footprint');
    assert.ok(e[1] > d.belt + 0.05 && e[1] < d.roof + 0.3, m.id + ' eye between belt and roof');
    assert.ok(g.bumperCam[0] > d.length / 2 - 0.01 && g.hoodCam[1] > d.nose, m.id + ' bumper / hood cams');
    // lamps on both sides, glass, lights
    assert.strictEqual(g.anchors.headlights.length, 2); assert.ok(g.anchors.brakeLights.length >= 2);
    assert.ok(g.anchors.headlights[0][2] * g.anchors.headlights[1][2] < 0, m.id + ' headlights mirrored');
    ['glass', 'light-head', 'light-brake', 'trim'].forEach(function (k) { assert.ok(partByKind(g, k), m.id + ' has ' + k); });
  });
});

test('car (real model): models in a style differ; body.model selects; procedural fallback', function () {
  ['coupe', 'suv', 'hypercar'].forEach(function (st) {
    var ms = SH.modelsByStyle(st), L = ms.map(function (m) { return realGeom(m.id, 'high').dims.length; });
    var tris = ms.map(function (m) { return partByKind(realGeom(m.id, 'high'), 'body').geo.tris(); });
    assert.ok(L.some(function (v) { return Math.abs(v - L[0]) > 0.02; }) || tris.some(function (v) { return v !== tris[0]; }), st + ' models differ');
  });
  // style default when no model given; wrong-style model ignored
  var def = CAR.buildGeometry(styleBuild('coupe'), { lod: 'high' });
  assert.strictEqual(def.model.id, SH.defaultModel('coupe').id);
  var wrong = styleBuild('coupe'); wrong.body.model = 'ford-f150-raptor-gen3';
  assert.strictEqual(CAR.buildGeometry(wrong, { lod: 'low' }).model.id, SH.defaultModel('coupe').id);
  // shapes: false -> the procedural loft (dims = engine collision box)
  var proc = CAR.buildGeometry(styleBuild('coupe'), { lod: 'high', shapes: false });
  assert.strictEqual(proc.model, null);
  assert.ok(Math.abs(proc.dims.length - (2.65 + OVERHANG.coupe)) < 1e-9);
});

test('car (real model): AI opponents get deterministic varied models; cache key carries the model', function () {
  var b = styleBuild('coupe'), ids = {};
  for (var i = 1; i <= 7; i++) {
    var g = CAR.buildGeometry(b, { lod: 'low', isPlayer: false, id: 'ai-' + i, number: String(i) });
    ids[g.model.id] = 1;
    assert.strictEqual(CAR.buildGeometry(b, { lod: 'low', isPlayer: false, id: 'ai-' + i }).model.id, g.model.id, 'deterministic');
  }
  assert.ok(Object.keys(ids).length >= 2, 'opponents use several real models: ' + Object.keys(ids));
  assert.strictEqual(CAR.buildGeometry(b, { lod: 'low', isPlayer: true, id: 'player' }).model.id, SH.defaultModel('coupe').id, 'player keeps the default');
  var pinned = styleBuild('coupe'); pinned.body.model = 'bmw-m4-g82';
  assert.strictEqual(CAR.buildGeometry(pinned, { lod: 'low', isPlayer: false, id: 'ai-1' }).model.id, 'bmw-m4-g82', 'explicit model wins');
  var k1 = CAR.cache.key(b, { lod: 'high', isPlayer: false, id: 'ai-1' }), keys = {};
  for (i = 1; i <= 7; i++) keys[CAR.cache.key(b, { lod: 'high', isPlayer: false, id: 'ai-' + i })] = 1;
  assert.ok(Object.keys(keys).length >= 2 && typeof k1 === 'string', 'model id in the cache key');
  var ctx = { fake: true }, m1 = CAR.build(ctx, pinned, { lod: 'high' }), m2 = CAR.build(ctx, JSON.parse(JSON.stringify(pinned)), { lod: 'high' });
  assert.strictEqual(m1, m2, 'shared by build hash'); assert.strictEqual(m1.modelId, 'bmw-m4-g82');
  CAR.cache.clear(ctx);
});

test('car (real model): build options still drive aero, exhaust, roof, numbers and lights', function () {
  var id = 'porsche-911-992';
  var base = realGeom(id, 'high', { aero: { wing: 'none', splitter: 'none', diffuser: 'none', canards: false, sideSkirts: false } });
  ['gt-wing', 'swan-neck', 'active'].forEach(function (w) {
    var g = realGeom(id, 'high', { aero: { wing: w } }), p = partByKind(g, 'wing');
    assert.ok(p && p.geo.tris() > 50, w);
    var bb = p.geo.finish().bounds, deck = CAR._.topAt(g.S, (bb.min[0] + bb.max[0]) / 2, 0);
    assert.ok(bb.min[1] > deck - 0.01 && bb.max[0] < 0, w + ' wing above the real rear deck');
  });
  var full = realGeom(id, 'high', { aero: { splitter: 'race', diffuser: 'race', canards: true, sideSkirts: true, wing: 'none' } });
  assert.ok(partByKind(full, 'carbon').geo.tris() > (partByKind(base, 'carbon') ? partByKind(base, 'carbon').geo.tris() : 0) + 100, 'carbon aero on the real body');
  assert.strictEqual(realGeom(id, 'high', { engine: { type: 'ev' } }).anchors.exhaust.length, 0, 'EV: no tips');
  assert.ok(realGeom(id, 'high').anchors.exhaust.length >= 1, 'model exhaust tips');
  assert.ok(partByKind(realGeom(id, 'high', { exterior: { roof: 'black' } }), 'roof'), 'black roof part');
  var n0 = partByKind(realGeom(id, 'high', { exterior: { livery_number: '' } }, { isPlayer: true }), 'trim').geo.tris();
  var n1 = partByKind(realGeom(id, 'high', { exterior: { livery_number: '27' } }, { isPlayer: true }), 'trim').geo.tris();
  assert.ok(n1 > n0, 'race number decals on the real flank');
  var m = CAR.build(null, modelBuild(SH.models[id]), { lod: 'high' }), st = {};
  CAR.pose(m, { x: 0, y: 0, heading: 0, brake: 0 }, 1 / 60, st);
  var bl = st.items.filter(function (i) { return i.kind === 'light-brake'; })[0], off = bl.material.emissive[0];
  CAR.pose(m, { x: 0, y: 0, heading: 0, brake: 1 }, 1 / 60, st);
  assert.ok(bl.material.emissive[0] > off + 2, 'brake lights glow');
});

test('car (real model): loft stations are smoothed (mirror-exact, bumper faces kept, moves capped) with fitted slopes', function () {
  var m = SH.models['porsche-911-992'], f = SH.fit(m, modelBuild(m)), raw = SH.sectionsFromViews(f, { stations: 64, maxStations: 0 });
  var sm = CAR._.smoothStations(raw), N = raw[0].ring.length, H = N >> 1, worst = 0;
  assert.strictEqual(sm.length, raw.length);
  sm.forEach(function (s, i) {
    assert.strictEqual(s.x, raw[i].x);
    assert.ok(s.dxd && s.dxd.length === N, 'slopes per vertex');
    assert.strictEqual(s.ring[0][1], 0); assert.strictEqual(s.ring[H][1], 0);
    for (var j = 1; j < H; j++) { assert.strictEqual(s.ring[j][0], s.ring[N - j][0]); assert.strictEqual(s.ring[j][1], -s.ring[N - j][1]); }
    for (j = 0; j < N; j++) worst = Math.max(worst, Math.hypot(s.ring[j][0] - raw[i].ring[j][0], s.ring[j][1] - raw[i].ring[j][1]));
  });
  [0, 1, sm.length - 2, sm.length - 1].forEach(function (i) { assert.deepStrictEqual(sm[i].ring, raw[i].ring, 'bumper face station ' + i + ' kept'); });
  assert.ok(worst <= 0.0036, 'moves capped: ' + worst);
  // analytic loft normals are unit length and point out of the body (away from the ring centre on the flanks)
  var AN = CAR._.loftNormals(sm), i0 = sm.length >> 1, r = sm[i0].ring, k = (i0 * N + (H >> 1)) * 3;
  assert.ok(AN && Math.abs(Math.hypot(AN[k], AN[k + 1], AN[k + 2]) - 1) < 1e-4);
  assert.ok(AN[k + 2] * r[H >> 1][1] > 0, 'flank normal points outward');
});

test('car (real model): front lamps are lamp units (interior + domed lens with clean uvs); low LOD lamps carry uvs + glow maps', function () {
  ['porsche-911-992', 'vw-golf-gti-mk8', 'mercedes-amg-c63-w206'].forEach(function (id) {
    var g = realGeom(id, 'high');
    assert.ok(g.S.lampUnits >= 2, id + ' lamp units ' + g.S.lampUnits);
    var head = g.parts.filter(function (p) { return p.kind === 'light-head' && !p.lightKey; })[0];
    assert.ok(head && head.maps && head.maps.fam === 'headlight', id + ' headlight maps');
    var T = head.geo.t;
    for (var i = 0; i < T.length; i++) assert.ok(T[i] >= 0 && T[i] <= 1, id + ' lamp uv in [0, 1]');
    var lo = realGeom(id, 'low'), lh = partByKind(lo, 'light-head'), lb = partByKind(lo, 'light-brake');
    assert.ok(lh && lh.maps && lh.maps.fam === 'headlight' && lb && lb.maps && lb.maps.fam === 'taillight', id + ' low LOD lamp maps');
    var us = lh.geo.t.filter(function (v, k) { return k % 2 === 0; });
    assert.ok(Math.min.apply(null, us) === 0 && Math.max.apply(null, us) === 1, id + ' low LOD lamp uvs span the map');
  });
});

if (standalone && require.main === module) console.log(process.exitCode ? 'FAILED' : 'all car tests passed');

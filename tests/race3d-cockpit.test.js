/* FORGE Atelier — CB.gl.cockpit (js/race/gl/cockpit.js) tests: pure layout / geometry / animation helpers + a mock-GL
   build. Every preset x body style x steering type x cage builds clean geometry (finite, valid indices, within the
   triangle budget); the cabin is laid out sanely around CB.gl.car's cockpitEye (wheel ahead and below the eye, rear-view
   mirror inside the cockpit camera's frustum, HUD ahead); the hood humps over the car-mesh front tyres; steering /
   head-motion signs; build() wires items, mirror texture, update and drawItems without a DOM. */
'use strict';
var assert = require('assert');
var path = require('path');

require(path.join(__dirname, '..', 'js', 'data.js'));
var CK = require(path.join(__dirname, '..', 'js', 'race', 'gl', 'cockpit.js'));
var CAR = null;
try { CAR = require(path.join(__dirname, '..', 'js', 'race', 'gl', 'car-mesh.js')); } catch (e) { CAR = null; }
var D = globalThis.CB.data;

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var test = standalone
  ? function (name, fn) {
    try { fn(); console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
  }
  : globalThis.test;

var STYLES = ['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van'];
var STEER = ['round', 'flat-bottom', 'yoke', 'race-quick-release'];
var DEG = Math.PI / 180;

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function deep(a, b) { for (var k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) { a[k] = a[k] || {}; deep(a[k], b[k]); } else a[k] = b[k]; } return a; }
function styleBuild(style, extra) {
  var b = D.defaultBuild();
  var bs = (D.bodyStyles || []).find(function (x) { return x.id === style; });
  b.body.style = style;
  if (bs) { if (bs.defaultWheelbase) b.body.wheelbase_mm = bs.defaultWheelbase; if (bs.seatOptions) b.body.seats = bs.seatOptions[0]; }
  if (extra) deep(b, extra);
  return b;
}
function presetBuild(p) {
  if (typeof D.presetBuild === 'function') { var b = D.presetBuild(p.id); if (b) return b; }
  return deep(D.defaultBuild(), clone(p.build || {}));
}
/** car-mesh eye + dims for a build (what renderer3d passes), or undefined when car-mesh is unavailable */
function carInfo(b) {
  if (!CAR) return {};
  try { var m = CAR.build(null, b, { lod: 'high' }); return { eye: m.cockpitEye, dims: m.dims }; } catch (e) { return {}; }
}
function checkGeo(g, label) {
  var n = g.P.length / 3, i;
  for (i = 0; i < g.P.length; i++) assert.ok(isFinite(g.P[i]), label + ': non-finite position');
  for (i = 0; i < g.N.length; i++) assert.ok(isFinite(g.N[i]), label + ': non-finite normal');
  for (i = 0; i < g.T.length; i++) assert.ok(isFinite(g.T[i]), label + ': non-finite uv');
  assert.strictEqual(g.I.length % 3, 0, label + ': index count not a multiple of 3');
  for (i = 0; i < g.I.length; i++) assert.ok(g.I[i] >= 0 && g.I[i] < n && (g.I[i] | 0) === g.I[i], label + ': bad index');
  return g.I.length / 3;
}
function allTris(G, label) {
  var t = 0, k;
  for (k in G.groups) t += checkGeo(G.groups[k], label + ':' + k);
  for (k in G.wheel) t += checkGeo(G.wheel[k], label + ':wheel-' + k);
  G.hands.forEach(function (h, i) { t += checkGeo(h, label + ':hand' + i); });
  for (k in G.panels) if (G.panels[k]) checkGeo(G.panels[k], label + ':panel-' + k);
  return t;
}
function elev(L, p) { return Math.atan2(p[1] - L.ey, p[0] - L.ex); }
function azim(L, p) { return Math.atan2(p[2] - L.ez, p[0] - L.ex); }

/* ------------------------------------------------------------------ geometry sweep */
test('cockpit: every preset x style x steering x cage builds finite geometry within budget', function () {
  var n = 0, maxT = 0;
  (D.presets || []).forEach(function (p, pi) {
    STYLES.forEach(function (st, si) {
      var steer = STEER[(pi + si) % 4], cage = ['none', 'half', 'full'][(pi + si) % 3];
      var b = presetBuild(p);
      b.body.style = st; b.interior.steering = steer; b.weight.rollCage = cage; b.interior.harness = cage !== 'none';
      b.tech.hud = (pi + si) % 2 === 0; b.tech.screen_in = [0, 8, 10, 12, 15, 17][(pi + si) % 6];
      var L = CK.layout(b, {}), P = CK.palette(b, {}), G = CK.buildGeometry(b, L, P);
      var t = allTris(G, p.id + '/' + st + '/' + steer + '/' + cage);
      assert.ok(t > 4000, 'interior should be detailed (' + t + ' tris)');
      maxT = Math.max(maxT, t); n++;
    });
  });
  assert.ok(n >= 10);
  assert.ok(maxT < 45000, 'triangle budget exceeded: ' + maxT);
});

test('cockpit: all steering types produce a wheel, hands and arms', function () {
  STEER.forEach(function (s) {
    var b = styleBuild('coupe', { interior: { steering: s } });
    var L = CK.layout(b, {}), G = CK.buildGeometry(b, L, CK.palette(b, {}));
    assert.strictEqual(L.wheel.type, s);
    var wt = 0; for (var k in G.wheel) wt += G.wheel[k].tris();
    assert.ok(wt > 300, s + ' wheel too simple: ' + wt);
    assert.strictEqual(G.hands.length, 2);
    assert.ok(G.hands[0].tris() > 50 && G.hands[1].tris() > 50);
    assert.ok(G.arms.upper.tris() > 0 && G.arms.fore.tris() > 0);
    assert.strictEqual(G.wrists.length, 2);
  });
});

test('cockpit: options change the interior (cage, harness, screen, hud, digital cluster)', function () {
  function tri(extra) { var b = styleBuild('coupe', extra), L = CK.layout(b, {}); var G = CK.buildGeometry(b, L, CK.palette(b, {})); var t = 0; for (var k in G.groups) t += G.groups[k].tris(); return { t: t, G: G, L: L }; }
  var base = tri({ weight: { rollCage: 'none' }, interior: { harness: false } });
  var cage = tri({ weight: { rollCage: 'full' }, interior: { harness: false } });
  var harn = tri({ weight: { rollCage: 'none' }, interior: { harness: true } });
  assert.ok(cage.t > base.t + 500, 'full cage adds tubes');
  assert.ok(harn.t > base.t + 200, 'harness adds straps');
  assert.ok(base.G.groups.cage == null || base.G.groups.cage.tris() < cage.G.groups.cage.tris());
  assert.strictEqual(tri({ tech: { screen_in: 0 } }).L.screen, null, 'screen delete -> no centre screen');
  var s15 = tri({ tech: { screen_in: 15 } }).L.screen;
  assert.ok(s15 && s15.portrait, '15" screen is portrait');
  assert.ok(tri({ tech: { hud: true } }).L.hud, 'hud panel when tech.hud');
  assert.strictEqual(tri({ tech: { hud: false } }).L.hud, null);
  assert.ok(tri({ tech: { hud: true } }).G.panels.hud, 'hud geometry');
});

/* ------------------------------------------------------------------ layout sanity with car-mesh eye/dims */
test('cockpit: cabin layout is sane around the car-mesh eye for every body style', function () {
  STYLES.forEach(function (st) {
    var b = styleBuild(st), ci = carInfo(b);
    var L = CK.layout(b, { eye: ci.eye, dims: ci.dims });
    if (ci.eye) assert.deepStrictEqual(L.eye.map(function (v) { return +v.toFixed(6); }), ci.eye.slice(0, 3).map(function (v) { return +v.toFixed(6); }), st + ': uses cockpitEye');
    // steering wheel ahead of and below the eye, on the driver's centreline
    assert.ok(L.wheel.c[0] > L.ex + 0.3 && L.wheel.c[0] < L.ex + 0.7, st + ': wheel x');
    assert.ok(L.wheel.c[1] < L.ey - 0.2 && L.wheel.c[1] > L.ey - 0.5, st + ': wheel y');
    assert.ok(Math.abs(L.wheel.c[2] - L.ez) < 1e-9, st + ': wheel on the driver axis');
    // dash in front of the wheel, windscreen base ahead of the dash, header above the eye
    assert.ok(L.xd > L.wheel.c[0] && L.xb > L.xd, st + ': dash / screen order');
    assert.ok(L.yR > L.ey + 0.05, st + ': header above the eye');
    assert.ok(L.floorY < L.ey - 0.5, st + ': floor well below the eye');
    // rear-view mirror inside a 62 deg vertical / 16:9 cockpit frustum (pitched down ~2 deg) and above the horizon
    var e = elev(L, L.mirror.pos), a = azim(L, L.mirror.pos);
    assert.ok(e > 4 * DEG && e < 24 * DEG, st + ': mirror elevation ' + (e / DEG).toFixed(1) + ' deg');
    assert.ok(Math.abs(a) < 45 * DEG, st + ': mirror azimuth ' + (a / DEG).toFixed(1) + ' deg');
    assert.ok(L.mirror.pos[0] > L.ex + 0.2, st + ': mirror ahead of the eye');
    assert.ok(Math.abs(Math.hypot.apply(null, L.mirror.normal) - 1) < 1e-6, st + ': mirror normal unit');
    assert.ok(L.mirror.normal[0] < 0, st + ': mirror faces back toward the driver');
    // side mirrors either side, outside the cabin
    assert.strictEqual(L.sideMirrors.length, 2);
    assert.ok(L.sideMirrors[0].pos[2] < -L.W / 2 + 0.05 && L.sideMirrors[1].pos[2] > L.W / 2 - 0.05, st + ': side mirrors outside');
    // instrument cluster below the eye line, in front of the wheel
    assert.ok(L.cluster.c[1] < L.ey && L.cluster.c[0] > L.wheel.c[0], st + ': cluster');
  });
});

test('cockpit: roadster windscreen header leaves the horizon clear', function () {
  var b = styleBuild('roadster'), ci = carInfo(b), L = CK.layout(b, { eye: ci.eye, dims: ci.dims });
  assert.ok(L.open, 'roadster is open-top');
  assert.ok(elev(L, [L.xh, L.yR, L.ez]) > 10 * DEG, 'header at least 10 deg above the eye line');
});

test('cockpit: hood humps over the car-mesh front tyres (exterior body is hidden in cockpit view)', function () {
  STYLES.forEach(function (st) {
    var b = styleBuild(st), ci = carInfo(b);
    if (!ci.dims) return;
    var L = CK.layout(b, { eye: ci.eye, dims: ci.dims }), G = CK.buildGeometry(b, L, CK.palette(b, {}));
    var paint = G.groups.paint, top = 2 * L.wheelR, zT = L.trackF / 2, worst = Infinity, seen = 0;
    for (var i = 0; i < paint.P.length; i += 3) {
      var x = paint.P[i], y = paint.P[i + 1], z = Math.abs(paint.P[i + 2]);
      if (Math.abs(x - L.axleF) < 0.06 && Math.abs(z - zT) < L.tireW * 0.25) { worst = Math.min(worst, y); seen++; }
    }
    if (seen) assert.ok(worst >= top - 0.01, st + ': hood ' + worst.toFixed(3) + ' below tyre top ' + top.toFixed(3));
  });
  ['tire-fl', 'tire-fr', 'wheel-fl', 'wheel-fr', 'caliper-fl', 'body', 'glass', 'driver'].forEach(function (k) {
    assert.ok(CK.HIDE_KINDS.indexOf(k) >= 0, 'hideKinds includes ' + k);
  });
});

/* ------------------------------------------------------------------ animation helpers */
test('cockpit: steering wheel rotation follows steerAngle with the ratio and limits', function () {
  assert.ok(CK.steerWheelAngle(0, 'round', 12) === 0);
  assert.ok(Math.abs(CK.steerWheelAngle(0.1, 'round', 12) + 1.2) < 1e-9, 'left steer (+) -> negative rot, x12');
  assert.ok(CK.steerWheelAngle(-0.1, 'round', 12) > 0);
  assert.ok(Math.abs(CK.steerWheelAngle(5, 'round', 12)) <= 7.6 + 1e-9, 'round lock limit');
  assert.ok(Math.abs(CK.steerWheelAngle(5, 'yoke', 7)) <= 2.9 + 1e-9, 'yoke never beyond ~165 deg');
  assert.ok(Math.abs(CK.steerWheelAngle(5, 'race-quick-release', 9.5)) <= 4.4 + 1e-9);
  assert.ok(CK.steerWheelAngle(NaN, 'round', 12) === 0);
});

test('cockpit: head model leans with g-forces and settles', function () {
  var h = CK.headModel({}), o;
  for (var i = 0; i < 240; i++) o = h.update({ latG: 1.5, longG: 0, speed: 40 }, 1 / 60, i / 60);
  assert.ok(o.offset[2] > 0.01, 'lateral g pushes the head sideways (+Z for +latG)');
  assert.ok(o.roll < 0, 'roll opposes lateral g');
  var h2 = CK.headModel({});
  for (i = 0; i < 240; i++) o = h2.update({ latG: 0, longG: 1, speed: 20 }, 1 / 60, i / 60);
  assert.ok(o.offset[0] < -0.01, 'acceleration pushes the head back');
  for (i = 0; i < 600; i++) o = h2.update({ latG: 0, longG: 0, speed: 0 }, 1 / 60, 10 + i / 60);
  assert.ok(Math.abs(o.offset[0]) < 0.004 && Math.abs(o.offset[2]) < 0.004, 'settles when g goes away');
  h2.impulse(1);
  o = h2.update({}, 1 / 60, 30);
  [o.offset[0], o.offset[1], o.offset[2], o.yaw, o.pitch, o.roll].forEach(function (v) { assert.ok(isFinite(v)); });
  assert.ok(Math.abs(o.offset[0]) <= 0.09 && Math.abs(o.offset[2]) <= 0.09, 'offsets clamped');
});

test('cockpit: viewBasis is orthonormal and forward is +X at rest', function () {
  var b = CK.viewBasis(0, 0, 0);
  assert.ok(Math.abs(b.forward[0] - 1) < 1e-9 && Math.abs(b.up[1] - 1) < 1e-9);
  var q = CK.viewBasis(0.2, -0.1, 0.05);
  function dot(a, c) { return a[0] * c[0] + a[1] * c[1] + a[2] * c[2]; }
  assert.ok(Math.abs(dot(q.forward, q.up)) < 1e-9 && Math.abs(dot(q.forward, q.forward) - 1) < 1e-9 && Math.abs(dot(q.up, q.up) - 1) < 1e-9);
});

test('cockpit: gauge helpers', function () {
  assert.strictEqual(CK.fmtTime(83.456), '1:23.456');
  assert.strictEqual(CK.gearLabel({ gear: 0 }), 'N');
  assert.strictEqual(CK.gearLabel({ gear: 3 }), '3');
  assert.strictEqual(CK.gearLabel({ reverse: true, gear: -1 }), 'R');
  // dash gear matches the race HUD: '1' on the grid (not 'N'), 'D' for single-speed EVs
  assert.strictEqual(CK.gearLabel({ gear: 1, speed: 0, throttle: 0, phase: 'grid' }), '1');
  assert.strictEqual(CK.gearLabel({ gear: 1, maxGear: 1 }), 'D');
  assert.strictEqual(CK.gearLabel({ gear: null }), 'N');
  var mm = CK.minimapFrom({ samples: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }, { x: -10, y: 25 }] });
  assert.ok(mm, 'minimap from samples');
});

/* ------------------------------------------------------------------ mock-GL build */
function mockGL() {
  var n = 0, calls = { tex: 0, buffers: 0, deleted: 0 };
  var gl = {
    calls: calls,
    ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3, TEXTURE_2D: 4, RGBA: 5, UNSIGNED_BYTE: 6, UNSIGNED_SHORT: 7, UNSIGNED_INT: 8,
    TEXTURE_MAG_FILTER: 9, TEXTURE_MIN_FILTER: 10, LINEAR: 11, LINEAR_MIPMAP_LINEAR: 12, TEXTURE_WRAP_S: 13, TEXTURE_WRAP_T: 14,
    REPEAT: 15, CLAMP_TO_EDGE: 16, UNPACK_FLIP_Y_WEBGL: 17,
    createBuffer: function () { calls.buffers++; return { id: ++n }; }, bindBuffer: function () {}, bufferData: function () {},
    deleteBuffer: function () { calls.deleted++; },
    createTexture: function () { calls.tex++; return { id: ++n }; }, bindTexture: function () {}, texImage2D: function () {}, texSubImage2D: function () {},
    texParameteri: function () {}, texParameterf: function () {}, pixelStorei: function () {}, generateMipmap: function () {}, deleteTexture: function () {},
    getExtension: function () { return null; }, getParameter: function () { return 1; }
  };
  return gl;
}

test('cockpit: build() with a mock GL context exposes the contract', function () {
  var saved = globalThis.CB.gl.createMesh;
  delete globalThis.CB.gl.createMesh;     // force the self-contained mesh path
  try {
    var b = styleBuild('coupe', { interior: { steering: 'flat-bottom', harness: true, ambientLighting: true }, weight: { rollCage: 'half' }, tech: { hud: true, screen_in: 12 } });
    var ci = carInfo(b), gl = mockGL();
    var ck = CK.build({ gl: gl, isWebGL2: true }, b, { eye: ci.eye, dims: ci.dims, geom: { samples: [{ x: 0, y: 0, s: 0 }, { x: 50, y: 0, s: 50 }, { x: 50, y: 50, s: 100 }, { x: 0, y: 50, s: 150 }, { x: -5, y: 25, s: 180 }], length: 200 } });
    assert.ok(Array.isArray(ck.items) && ck.items.length > 10, 'items');
    ck.items.forEach(function (it) {
      assert.ok(it.mesh && it.material && it.local && it.model, 'item shape ' + it.name);
      assert.strictEqual(it.castShadow, false);
    });
    assert.ok(ck.items.some(function (it) { return it.kind === 'cockpit-steering'; }), 'steering items');
    assert.ok(ck.items.some(function (it) { return it.kind === 'cockpit-hands'; }), 'hands');
    assert.ok(ck.items.some(function (it) { return it.kind === 'cockpit-mirror'; }), 'mirror');
    assert.ok(ck.items.some(function (it) { return it.kind === 'cockpit-glass' && it.transparent; }), 'transparent glass');
    assert.ok(ck.eye && ck.eye.length === 3 && ck.mirror && ck.mirror.pos && ck.sideMirrors.length === 2, 'pose data');
    assert.ok(ck.nearPlane > 0 && ck.nearPlane < 0.1);
    assert.ok(Array.isArray(ck.hideKinds) && ck.hideKinds.indexOf('body') >= 0);
    ['update', 'drawItems', 'setMirrorTexture', 'setTrack', 'setUnits', 'setQuality', 'attach', 'impulse', 'getViewMatrix', 'getCameraLocal', 'destroy', 'draw']
      .forEach(function (f) { assert.strictEqual(typeof ck[f], 'function', f); });

    // mirror texture
    var tex = { rt: 1 }, mirror = ck.items.find(function (it) { return it.kind === 'cockpit-mirror'; });
    ck.setMirrorTexture(tex);
    assert.strictEqual(mirror.material.map, tex);
    assert.strictEqual(mirror.material.uUseMap, 1);
    ck.setMirrorTexture(null);
    assert.strictEqual(mirror.material.uUseMap, 0);

    // steering wheel rotates with steerAngle; head responds to g
    var wheel = ck.items.find(function (it) { return it.name === 'wheel-rim'; });
    var before = Array.prototype.slice.call(wheel.local);
    for (var i = 0; i < 60; i++) ck.update({ speed: 30, rpm: 6000, gear: 3, steerAngle: 0.12, latG: 1.2, longG: 0.3, heading: 0 }, 1 / 60, i / 60, { t: i / 60, cars: [], timeOfDay: 'night' });
    var after = Array.prototype.slice.call(wheel.local);
    assert.ok(before.some(function (v, k) { return Math.abs(v - after[k]) > 1e-3; }), 'wheel matrix animated');
    assert.ok(Math.abs(ck.camera.eye[2] - ck.eye[2]) > 0.005, 'head moved with lateral g');
    var glow = ck.items.find(function (it) { return it.name === 'glow'; });
    if (glow) assert.ok(glow.material.emissive[0] + glow.material.emissive[1] + glow.material.emissive[2] > 0, 'ambient strip glows at night');

    // look-back hides the driver seat
    ck.update({ speed: 30, lookBack: true }, 1 / 60, 2, { t: 2 });
    assert.ok(ck.items.filter(function (it) { return it.driverSeat; }).every(function (it) { return it.visible === false; }));
    ck.update({ speed: 30, lookBack: false }, 1 / 60, 2.1, { t: 2.1 });

    // drawItems composes car world matrices without allocating new item objects
    var W = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, -5, 1]), out = [];
    ck.drawItems(W, out);
    assert.ok(out.length > 10);
    var it0 = out.find(function (it) { return it.local === out[0].local; });
    assert.ok(Math.abs(it0.model[12] - (it0.local[12] + 10)) < 1e-5 && Math.abs(it0.model[14] - (it0.local[14] - 5)) < 1e-5);
    var V = ck.getViewMatrix(W);
    assert.ok(Array.prototype.every.call(V, isFinite));

    // attach() re-anchors on a different eye
    var n0 = gl.calls.buffers;
    ck.attach({ cockpitEye: [ck.eye[0] - 0.1, ck.eye[1] + 0.05, ck.eye[2]], dims: ci.dims });
    assert.ok(gl.calls.buffers > n0, 'rebuilt on attach');
    assert.ok(Math.abs(ck.eye[1] - (ci.eye ? ci.eye[1] + 0.05 : ck.eye[1])) < 1e-6 || !ci.eye);
    ck.destroy();
    assert.strictEqual(ck.items.length, 0);
  } finally {
    if (saved) globalThis.CB.gl.createMesh = saved;
  }
});

if (standalone && require.main === module) console.log(process.exitCode ? 'FAILED' : 'all cockpit tests passed');

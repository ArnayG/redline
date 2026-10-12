/* Node tests for js/race/gl/post.js (pure helpers + mock-GL smoke test of the whole chain).
   Run: node tests/race3d-post.test.js   (or via node tests/run.js) */
'use strict';
var assert = require('assert');
var path = require('path');
var POST = require(path.join(__dirname, '..', 'js', 'race', 'gl', 'post.js'));
var I = POST._;
var test = typeof globalThis.test === 'function' ? globalThis.test : function (name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
};
function close(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-5); }

/* ---------------------------------------------------------------- mock GL (records calls) */
function mockGL(o) {
  o = o || {};
  var calls = [], n = 0, bound = { fb: null };
  var K = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 7, STATIC_DRAW: 9, FLOAT: 18,
    TRIANGLES: 19, FRAMEBUFFER: 30, READ_FRAMEBUFFER: 31, DRAW_FRAMEBUFFER: 32, FRAMEBUFFER_COMPLETE: 33, RENDERBUFFER: 34,
    COLOR_ATTACHMENT0: 35, DEPTH_ATTACHMENT: 36, TEXTURE_2D: 37, TEXTURE0: 100, MAX_SAMPLES: 40, NO_ERROR: 0,
    FRAMEBUFFER_BINDING: 41, RGBA: 42, RGBA8: 43, RGBA16F: 44, HALF_FLOAT: 45, UNSIGNED_BYTE: 46, UNSIGNED_INT: 47,
    DEPTH_COMPONENT: 48, DEPTH_COMPONENT24: 49, DEPTH_COMPONENT16: 50, LINEAR: 51, NEAREST: 52, CLAMP_TO_EDGE: 53,
    TEXTURE_MIN_FILTER: 54, TEXTURE_MAG_FILTER: 55, TEXTURE_WRAP_S: 56, TEXTURE_WRAP_T: 57, COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x100, DEPTH_TEST: 60, BLEND: 61, CULL_FACE: 62, SCISSOR_TEST: 63, ONE: 64
  };
  var t = {
    calls: calls, drawingBufferWidth: 1280, drawingBufferHeight: 720,
    getExtension: function (name) {
      if (o.noExt) return null;
      if (name === 'OES_texture_half_float') return { HALF_FLOAT_OES: 0x8D61 };
      return o.webgl1 && name === 'WEBGL_depth_texture' && o.noDepth ? null : {};
    },
    getParameter: function (k) { return k === K.MAX_SAMPLES ? 4 : k === K.FRAMEBUFFER_BINDING ? bound.fb : 0; },
    createShader: function () { return { id: ++n }; }, createProgram: function () { return { id: ++n }; },
    getShaderParameter: function () { return true; }, getProgramParameter: function () { return true; },
    getUniformLocation: function (p, name) { return { name: name }; },
    checkFramebufferStatus: function () { return o.incomplete ? 0 : K.FRAMEBUFFER_COMPLETE; },
    getError: function () { return 0; }, isContextLost: function () { return !!o.lost; },
    bindFramebuffer: function (tg, fb) { bound.fb = fb; calls.push(['bindFramebuffer', fb]); }
  };
  ['createTexture', 'createFramebuffer', 'createRenderbuffer', 'createBuffer', 'createVertexArray'].forEach(function (f) {
    t[f] = function () { return { id: ++n, kind: f }; };
  });
  return new Proxy(t, {
    get: function (tg, k) {
      if (k in tg) return tg[k];
      if (k === 'gl' || k === 'then') return undefined;
      if (k in K) return K[k];
      if (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k)) return 999;
      return function () { calls.push([k].concat([].slice.call(arguments))); };
    }
  });
}
function count(gl, name) { return gl.calls.filter(function (c) { return c[0] === name; }).length; }
function camera() {
  // simple perspective (fov 60, aspect 16/9, near 0.1, far 2000) looking down -Z from (0, 1.5, 6)
  var f = 1 / Math.tan(Math.PI / 6), n = 0.1, fa = 2000, a = 16 / 9;
  var proj = new Float32Array(16); proj[0] = f / a; proj[5] = f; proj[10] = (fa + n) / (n - fa); proj[11] = -1; proj[14] = 2 * fa * n / (n - fa);
  var view = new Float32Array(16); view[0] = view[5] = view[10] = view[15] = 1; view[13] = -1.5; view[14] = -6;
  return { view: view, proj: proj };
}

/* ---------------------------------------------------------------- pure helpers */
test('post: quality tiers degrade with capabilities', function () {
  var hi = I.qualityConfig('high', { isGL2: true, maxSamples: 4, depthTexture: true, hdr: true });
  assert.strictEqual(hi.enabled, true); assert.strictEqual(hi.msaa, 4); assert.ok(hi.ssao > 0); assert.strictEqual(hi.hdr, true);
  assert.strictEqual(hi.fxaa, false, 'FXAA is off when MSAA is available');
  var gl1 = I.qualityConfig('high', { isGL2: false, depthTexture: false, hdr: false });
  assert.strictEqual(gl1.msaa, 0); assert.strictEqual(gl1.ssao, 0); assert.strictEqual(gl1.contacts, false);
  assert.strictEqual(gl1.fxaa, true); assert.strictEqual(gl1.motion, 1); assert.strictEqual(gl1.hdr, false);
  var low = I.qualityConfig('low', { isGL2: true, maxSamples: 4, depthTexture: true, hdr: true });
  assert.strictEqual(low.enabled, false); assert.strictEqual(low.bloomLevels, 0);
  assert.strictEqual(I.normQuality('med'), 'medium'); assert.strictEqual(I.normQuality('epic'), 'ultra'); assert.strictEqual(I.normQuality('x'), null);
  assert.ok(I.qualityConfig('ultra', { isGL2: true, maxSamples: 4, depthTexture: true, hdr: true }).ssao > hi.ssao);
});

test('post: grade presets per time of day + weather', function () {
  var d = POST.gradeFor('day'), n = POST.gradeFor('night'), k = POST.gradeFor('dusk'), w = POST.gradeFor('day', 'wet');
  assert.ok(k.temperature > d.temperature, 'dusk is warmer');
  assert.ok(n.temperature < d.temperature, 'night is cooler');
  assert.ok(n.threshold < d.threshold && n.bloomStrength > d.bloomStrength, 'night blooms more');
  assert.ok(w.saturation < d.saturation, 'wet desaturates');
  assert.strictEqual(POST.gradeFor('bogus').timeOfDay, 'day');
  d.lift[0] = 9; assert.notStrictEqual(POST.gradeFor('day').lift[0], 9, 'presets are copied');
  var wb = I.whiteBalance(0.5, 0);
  assert.ok(wb[0] > 1 && wb[2] < 1);
  assert.ok(close(0.2126 * wb[0] + 0.7152 * wb[1] + 0.0722 * wb[2], 1, 1e-9), 'luma preserved');
});

test('post: ACES curves are monotonic, bounded and roughly matched', function () {
  var prev = -1;
  for (var x = 0; x <= 16; x += 0.05) {
    var v = I.acesFitted([x * 1.8, x * 1.8, x * 1.8])[1];
    assert.ok(v >= prev - 1e-6 && v <= 1, 'fitted monotone at ' + x); prev = v;
  }
  // with the default exposure match (1.8) mid-grey lands near the fast curve the scene shaders use
  assert.ok(Math.abs(I.acesFitted([0.18 * 1.8, 0.18 * 1.8, 0.18 * 1.8])[0] - I.acesFast(0.18)) < 0.05);
  assert.strictEqual(I.acesFast(0), 0);
});

test('post: mat4 helpers + near/far + camera position', function () {
  var c = camera(), inv = new Float32Array(16), id = new Float32Array(16);
  assert.ok(I.invert4(inv, c.view));
  I.mul4(id, c.view, inv);
  for (var i = 0; i < 16; i++) assert.ok(close(id[i], i % 5 === 0 ? 1 : 0, 1e-5));
  var nf = I.nearFar(c.proj);
  assert.ok(close(nf[0], 0.1, 1e-4) && Math.abs(nf[1] - 2000) < 1);
  var p = I.camPos(c.view);
  assert.ok(close(p[0], 0) && close(p[1], 1.5) && close(p[2], 6));
  assert.strictEqual(I.invert4(new Float32Array(16), new Float32Array(16)), null);
});

test('post: contacts pack + sim car conversion', function () {
  var A = new Float32Array(32), B = new Float32Array(32);
  var n = I.packContacts([{ x: 1, z: 2, y: 0.5, heading: 0, length: 4, width: 2 }, null, { x: NaN, z: 0 }, { x: 0, z: 0, dirX: 0, dirZ: 3 }], A, B);
  assert.strictEqual(n, 2);
  assert.deepStrictEqual([A[0], A[1], A[2], A[3]], [1, 2, 0.5, 1]);
  assert.ok(close(B[0], 1) && close(B[1], 0) && close(B[2], 2) && close(B[3], 1));
  assert.ok(close(B[4], 0) && close(B[5], 1), 'direction normalised');
  var many = []; for (var i = 0; i < 20; i++) many.push({ x: i, z: 0 });
  assert.strictEqual(I.packContacts(many, A, B), POST.MAX_CONTACTS);
  var cs = POST.contactsFromCars([{ x: 10, y: 5, heading: Math.PI / 2, elev: 1 }, { x: 500, y: 0, heading: 0 }, { x: 2, y: 0, heading: 0 }], { camPos: [0, 2, 0] });
  assert.strictEqual(cs.length, 2, 'far cars dropped');
  assert.strictEqual(cs[0].x, 2, 'nearest first');
  assert.strictEqual(cs[1].z, -5); assert.strictEqual(cs[1].y, 1);
  I.packContacts(cs, A, B);
  // heading pi/2 (sim +y) -> GL forward (0, -1)
  assert.ok(close(B[4], 0, 1e-6) && close(B[5], -1, 1e-6));
});

test('post: contacts carry the wheel layout for wheel-arch occlusion', function () {
  var A = new Float32Array(32), B = new Float32Array(32), C = new Float32Array(32);
  var n = I.packContacts([{ x: 0, z: 0, heading: 0, length: 4.4, width: 1.8, wheelbase: 2.6, track: 1.5, wheelRadius: 0.32 }, { x: 5, z: 0, heading: 0, length: 4, width: 2 }], A, B, C);
  assert.strictEqual(n, 2);
  assert.ok(close(C[0], 1.3) && close(C[1], 0.75) && close(C[2], 0.32) && C[3] === 1);
  // defaults derived from the footprint when the car dims are unknown
  assert.ok(close(C[4], 1.2) && close(C[5], 0.84) && close(C[6], 0.33) && C[7] === 1);
  for (var j = 8; j < 32; j++) assert.strictEqual(C[j], 0);
  // a 3-array call still works (C optional)
  assert.strictEqual(I.packContacts([{ x: 0, z: 0 }], A, B), 1);
});

test('post: bloom pyramid sizes', function () {
  var s = I.bloomSizes(1920, 1080, 6);
  assert.deepStrictEqual(s[0], [960, 540]);
  assert.strictEqual(s.length, 6);
  assert.ok(I.bloomSizes(64, 32, 6).length < 6, 'stops before tiny levels');
});

test('post: shaders are GLSL ES 1.00 friendly', function () {
  var S = I.shaders;
  Object.keys(S).forEach(function (k) {
    assert.ok(!/#version/.test(S[k]), k + ' has no #version');
    assert.ok(!/\btexture\(/.test(S[k]), k + ' uses texture2D');
    if (k !== 'VS') assert.ok(/gl_FragColor/.test(S[k]) && /precision/.test(S[k]), k);
  });
});

/* ---------------------------------------------------------------- mock-GL smoke */
test('post: full chain on WebGL2 (mock)', function () {
  var gl = mockGL();
  var p = POST.create({ gl: gl, isWebGL2: true }, { quality: 'high' });
  p.resize(1280, 720);
  var t = p.begin();
  assert.strictEqual(t.direct, false); assert.strictEqual(t.hdr, true); assert.strictEqual(t.linearOutput, true);
  assert.strictEqual(t.samples, 4); assert.strictEqual(t.width, 1280);
  var c = camera();
  assert.strictEqual(p.end({ camera: c, contacts: [{ x: 0, z: 0, heading: 0 }], timeOfDay: 'dusk' }), true);
  var st = p.stats();
  assert.strictEqual(st.ssao, true); assert.strictEqual(st.contacts, 1); assert.ok(st.bloomLevels >= 4); assert.strictEqual(st.fxaa, false);
  assert.ok(count(gl, 'blitFramebuffer') >= 1, 'MSAA resolve');
  var draws1 = count(gl, 'drawArrays');
  assert.ok(draws1 >= 1 + 3 + 1 + 2 * (st.bloomLevels - 1) + 1 - 1, 'ao + blur + bloom + composite passes: ' + draws1);
  // second frame: reprojection motion blur kicks in
  p.begin(); c.view[12] = 0.4; p.end({ camera: c });
  assert.strictEqual(p.stats().motion, 2);
  // state restored
  var last = gl.calls.slice(-12).map(function (x) { return x[0]; });
  assert.ok(last.indexOf('enable') >= 0 && last.indexOf('depthMask') >= 0 && last.indexOf('viewport') >= 0);
  // quality change -> low = passthrough
  p.setQuality('low');
  var d = p.begin();
  assert.strictEqual(d.direct, true); assert.strictEqual(d.linearOutput, false);
  assert.strictEqual(p.end({}), false);
  p.setQuality('medium');
  assert.strictEqual(p.begin().samples, 2);
  assert.strictEqual(p.end({ camera: c }), true);
  assert.strictEqual(p.stats().ssao, false);
  p.destroy();
  assert.strictEqual(p.begin().direct, true);
});

test('post: WebGL1 without depth textures / float buffers degrades', function () {
  var gl = mockGL({ webgl1: true, noExt: true });
  var p = POST.create({ gl: gl, isWebGL2: false }, { quality: 'ultra' });
  var t = p.begin();
  assert.strictEqual(t.direct, false); assert.strictEqual(t.hdr, false); assert.strictEqual(t.linearOutput, false);
  assert.strictEqual(t.samples, 0); assert.strictEqual(t.depth, false);
  assert.strictEqual(p.end({ camera: camera(), speedBlur: 0.5 }), true);
  var st = p.stats();
  assert.strictEqual(st.fxaa, true); assert.strictEqual(st.ssao, false); assert.strictEqual(st.motion, 1);
  assert.strictEqual(count(gl, 'blitFramebuffer'), 0);
});

test('post: incomplete framebuffers / lost context fall back to passthrough', function () {
  var gl = mockGL({ incomplete: true });
  var p = POST.create(gl, { quality: 'high' });
  var _w = console.warn; console.warn = function () {};
  try { assert.strictEqual(p.begin().direct, true); } finally { console.warn = _w; }
  assert.strictEqual(p.stats().broken, true);
  var lostOpts = { lost: true };
  var gl2 = mockGL(lostOpts);
  var p2 = POST.create({ gl: gl2, isWebGL2: true }, { quality: 'high' });
  assert.strictEqual(p2.begin().direct, true);
  assert.strictEqual(p2.end({}), false);
  lostOpts.lost = false; // restored -> rebuilds
  assert.strictEqual(p2.begin().direct, false);
  assert.strictEqual(p2.end({ camera: camera() }), true);
});

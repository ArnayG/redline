/* FORGE Atelier — renderer3d lite-core fallback (Node, stubbed DOM + no-op WebGL).
   Regression: when gl-core is loaded but fails to initialise (weak GPU / WebGL1), renderer3d switches to its
   built-in lite core. The sub-module builds (track, scenery, car, cockpit) must then receive the lite mesh
   factory, not gl-core's createMesh (which needs ctx.bindVAO and threw for every mesh => no cars, bare road). */
'use strict';
var assert = require('assert');
var path = require('path');

var ROOT = path.join(__dirname, '..');
function load(rel) { return require(path.join(ROOT, rel)); }
load('js/data.js');
var T = load('js/race/tracks.js');
['js/race/gl/gl-core.js', 'js/race/gl/textures.js', 'js/race/gl/track-mesh.js', 'js/race/gl/scenery.js',
  'js/race/gl/car-mesh.js', 'js/race/gl/cockpit.js', 'js/race/gl/effects.js', 'js/race/gl/renderer3d.js'].forEach(load);
var CB = globalThis.CB, GL = CB.gl, R3 = CB.race.renderer3d;

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var test = standalone
  ? function (name, fn) {
    try { fn(); console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
  }
  : globalThis.test;

/** WebGL1-ish context where every method is a no-op that returns a truthy handle / success. */
function fakeGL() {
  var consts = {};
  var target = {
    drawingBufferWidth: 320, drawingBufferHeight: 180,
    getExtension: function () { return null; },
    getSupportedExtensions: function () { return []; },
    getParameter: function () { return 16; },
    getShaderParameter: function () { return true; },
    getProgramParameter: function () { return true; },
    getShaderInfoLog: function () { return ''; },
    getProgramInfoLog: function () { return ''; },
    getUniformLocation: function () { return {}; },
    getActiveUniform: function () { return null; }, getActiveAttrib: function () { return null; },
    getAttribLocation: function () { return 0; },
    checkFramebufferStatus: function () { return 0x8CD5; },
    isContextLost: function () { return false; },
    FRAMEBUFFER_COMPLETE: 0x8CD5
  };
  return new Proxy(target, {
    get: function (t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string' && /^[A-Z0-9_]+$/.test(k)) return consts[k] || (consts[k] = Object.keys(consts).length + 1);
      if (typeof k === 'string') return function () { return {}; };
      return undefined;
    }
  });
}
function fakeCanvas(doc) {
  var c = {
    width: 320, height: 180, clientWidth: 320, clientHeight: 180, className: '', style: {}, parentNode: null, ownerDocument: doc,
    setAttribute: function () {}, addEventListener: function () {}, removeEventListener: function () {},
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 320, height: 180 }; },
    getContext: function (type) { return type === '2d' ? null : fakeGL(); }
  };
  return c;
}
function fakeDoc() {
  var win = {
    devicePixelRatio: 1, addEventListener: function () {}, removeEventListener: function () {},
    getComputedStyle: function () { return { position: 'relative', zIndex: 'auto' }; }
  };
  var doc = { defaultView: win, createElement: function () { return fakeCanvas(doc); } };
  return doc;
}

test('lite fallback: gl-core init failure still builds track / scenery / cars with the lite mesh factory', function () {
  var def = T.list[0]; def = T.get ? T.get(def.id) : def;
  var geom = T.build(def);
  var doc = fakeDoc(), canvas = fakeCanvas(doc);
  var origShaders = GL.shaders, origCreateMesh = GL.createMesh;
  var warns = [], origWarn = console.warn;
  console.warn = function () { warns.push(Array.prototype.join.call(arguments, ' ')); };
  var r;
  try {
    GL.shaders = function () { throw new Error('sim'); };
    r = R3.create(canvas, geom, def, { camera: 'chase', quality: 'low', optionalModules: false, autoQuality: false });
  } finally { GL.shaders = origShaders; console.warn = origWarn; }
  try {
    assert.strictEqual(r._debug().G.lite, true, 'switched to the lite core');
    assert.strictEqual(GL.createMesh, origCreateMesh, 'gl-core createMesh restored after the builds');
    var bad = warns.filter(function (w) { return /bindVAO/.test(w); });
    assert.deepStrictEqual(bad, [], 'gl-core createMesh was handed the lite context');
    // render a few chase frames with the player car: car.build must go through the lite factory too
    var p0 = geom.points ? geom.points[0] : null;
    var x = p0 ? (p0.x != null ? p0.x : p0[0]) : 0, y = p0 ? (p0.y != null ? p0.y : p0[1]) : 0;
    var snap = { t: 0, playerId: 'player', cars: [{ id: 'player', isPlayer: true, build: CB.data.defaultBuild(), x: x, y: y, heading: 0, speed: 0, color: '#c03030' }] };
    console.warn = function () { warns.push(Array.prototype.join.call(arguments, ' ')); };
    try { r.setCamera('chase'); for (var i = 0; i < 3; i++) { snap.t = i / 60; r.render(snap, 1); } }
    finally { console.warn = origWarn; }
    assert.strictEqual(GL.createMesh, origCreateMesh, 'gl-core createMesh restored after car builds');
    assert.deepStrictEqual(warns.filter(function (w) { return /bindVAO|car\.build/.test(w); }), [], 'car build warnings');
    var e = r._debug().S.cars.player;
    assert.ok(e, 'player car entry');
    var models = Object.keys(e.models).map(function (k) { return e.models[k]; }).filter(Boolean);
    assert.ok(models.length && models.every(function (m) { return !m._fallback; }), 'player car uses car-mesh, not the fallback box');
    var st = r.stats();
    assert.ok(st.modules && st.modules.track, 'track module built (stats().modules.track)');
  } finally { if (r && r.destroy) try { r.destroy(); } catch (e) { /* ignore */ } }
});

function liteSnap(geom) {
  var c0 = geom.centerline[0], c1 = geom.centerline[3];
  var hd = Math.atan2(c1.y - c0.y, c1.x - c0.x);
  return { t: 0, playerId: 'player', cars: [
    { id: 'player', isPlayer: true, build: CB.data.defaultBuild(), x: c0.x, y: c0.y, heading: hd, speed: 0, color: '#c03030' },
    { id: 'ai1', build: CB.data.defaultBuild(), x: c1.x, y: c1.y + 3, heading: hd, speed: 0, color: '#3050d0' }] };
}
function carMeshesOk(r) {
  var cars = r._debug().S.cars;
  return ['player', 'ai1'].every(function (id) {
    var e = cars[id]; if (!e) return false;
    var ms = Object.keys(e.models || {}).map(function (k) { return e.models[k]; }).filter(Boolean);
    return ms.length > 0 && ms.every(function (m) { return !m._fallback; });
  });
}

test('lite fallback: gl-core createContext failure still draws the track and every car (player + AI)', function () {
  var def = T.list[1]; def = T.get ? T.get(def.id) : def;
  var geom = T.build(def), doc = fakeDoc(), canvas = fakeCanvas(doc);
  var origCtx = GL.createContext, warns = [], origWarn = console.warn, r;
  console.warn = function () { warns.push(Array.prototype.join.call(arguments, ' ')); };
  try {
    GL.createContext = function () { throw new Error('sim ctx'); };
    r = R3.create(canvas, geom, def, { camera: 'chase', quality: 'high', optionalModules: false, autoQuality: false });
    GL.createContext = origCtx;
    var snap = liteSnap(geom);
    ['chase', 'cockpit', 'tv', 'chase'].forEach(function (c) { r.setCamera(c); for (var i = 0; i < 3; i++) { snap.t += 1 / 60; r.render(snap, 1); } });
  } finally { GL.createContext = origCtx; console.warn = origWarn; }
  try {
    assert.strictEqual(r.stats().lite, true, 'stats().lite');
    assert.ok(carMeshesOk(r), 'player + AI cars built with car-mesh');
    assert.ok(r._debug().S.world.staticItems.length > 10, 'track / scenery items present');
    assert.ok(r.stats().drawn > 10, 'items drawn');
    assert.ok(warns.length <= 3, 'only a handful of warnings, got ' + warns.length + ': ' + warns.slice(0, 5).join(' | '));
  } finally { if (r && r.destroy) try { r.destroy(); } catch (e) { /* ignore */ } }
});

test('lite fallback: gl-core drawList failing every frame switches to the lite core at runtime', function () {
  var def = T.list[0]; def = T.get ? T.get(def.id) : def;
  var geom = T.build(def), doc = fakeDoc(), canvas = fakeCanvas(doc);
  var origDraw = GL.drawList, warns = [], origWarn = console.warn, r;
  console.warn = function () { warns.push(Array.prototype.join.call(arguments, ' ')); };
  try {
    r = R3.create(canvas, geom, def, { camera: 'chase', quality: 'low', optionalModules: false, autoQuality: false });
    assert.strictEqual(r.stats().lite, false, 'starts on gl-core');
    GL.drawList = function () { throw new Error('sim draw failure'); };
    var snap = liteSnap(geom);
    for (var i = 0; i < 8; i++) { snap.t += 1 / 60; r.render(snap, 1); }
  } finally { GL.drawList = origDraw; console.warn = origWarn; }
  try {
    assert.strictEqual(r.stats().lite, true, 'switched to lite after repeated draw failures');
    assert.ok(warns.some(function (w) { return /switching to built-in lite core/.test(w); }), 'switch is reported once');
    assert.ok(carMeshesOk(r), 'cars rebuilt on the lite core');
    assert.ok(r.stats().modules.track, 'track rebuilt');
    assert.ok(r._debug().S.world.staticItems.length > 10, 'world rebuilt');
  } finally { if (r && r.destroy) try { r.destroy(); } catch (e) { /* ignore */ } }
});

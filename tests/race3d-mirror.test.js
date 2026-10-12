/* FORGE — rear-view mirror material regression (final 3D pass).
   The "white mirror" reports came from screenshots of an occluded / background window, where Chrome showed an
   old composited frame while readPixels on the drawing buffer showed the correct mirror image every frame. These
   tests pin the parts of the mirror path that CAN be checked without a GPU: the material that gl-core resolves
   (uBaseColor wins over baseColor, so the two must stay one array) is dark glass until a render target is bound,
   and bright + textured once it is. */
'use strict';
var assert = require('assert');
var path = require('path');
require(path.join(__dirname, '..', 'js', 'data.js'));
var CK = require(path.join(__dirname, '..', 'js', 'race', 'gl', 'cockpit.js'));

function mockGL() {
  var n = 0;
  return {
    ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3, TEXTURE_2D: 4, RGBA: 5, UNSIGNED_BYTE: 6, UNSIGNED_SHORT: 7, UNSIGNED_INT: 8,
    TEXTURE_MAG_FILTER: 9, TEXTURE_MIN_FILTER: 10, LINEAR: 11, LINEAR_MIPMAP_LINEAR: 12, TEXTURE_WRAP_S: 13, TEXTURE_WRAP_T: 14,
    REPEAT: 15, CLAMP_TO_EDGE: 16, UNPACK_FLIP_Y_WEBGL: 17,
    createBuffer: function () { return { id: ++n }; }, bindBuffer: function () {}, bufferData: function () {}, deleteBuffer: function () {},
    createTexture: function () { return { id: ++n }; }, bindTexture: function () {}, texImage2D: function () {}, texSubImage2D: function () {},
    texParameteri: function () {}, texParameterf: function () {}, pixelStorei: function () {}, generateMipmap: function () {}, deleteTexture: function () {},
    getExtension: function () { return null; }, getParameter: function () { return 1; }
  };
}

function buildCockpit() {
  var CBg = globalThis.CB;
  var b = CBg.data && typeof CBg.data.defaultBuild === 'function' ? CBg.data.defaultBuild() : {};
  var saved = CBg.gl && CBg.gl.createMesh;
  if (CBg.gl) delete CBg.gl.createMesh;   // self-contained mesh path (no real GL)
  try {
    return CK.build({ gl: mockGL(), isWebGL2: true }, b, {
      geom: { samples: [{ x: 0, y: 0, s: 0 }, { x: 50, y: 0, s: 50 }, { x: 50, y: 50, s: 100 }, { x: 0, y: 50, s: 150 }], length: 200 }
    });
  } finally { if (CBg.gl && saved) CBg.gl.createMesh = saved; }
}

/** What gl-core's resolveMaterial picks: uBaseColor before baseColor before color. */
function resolvedColor(mt) { return mt.uBaseColor || mt.baseColor || mt.color; }
function lum(c) { return (c[0] + c[1] + c[2]) / 3; }

test('mirror: dark glass until a render target is bound, never a bright untextured quad', function () {
  var ck = buildCockpit();
  var mirror = ck.items.find(function (it) { return it.kind === 'cockpit-mirror'; });
  assert.ok(mirror, 'cockpit has a mirror item');
  var mt = mirror.material;
  assert.strictEqual(mt.unlit, true, 'mirror glass is unlit (shows the RT as-is)');
  assert.strictEqual(mt.uBaseColor, mt.baseColor, 'uBaseColor and baseColor are the same array');
  assert.ok(!mt.uUseMap, 'no map before the first mirror pass');
  assert.ok(lum(resolvedColor(mt)) < 0.3, 'untextured mirror is dark glass');

  var tex = { rt: 1 };
  ck.setMirrorTexture(tex, { flipU: false });
  assert.strictEqual(mt.uMap, tex);
  assert.strictEqual(mt.uUseMap, 1);
  assert.ok(lum(resolvedColor(mt)) > 0.7, 'textured mirror passes the RT through near 1:1');

  ck.setMirrorTexture(null, { flipU: false });
  assert.ok(!mt.uUseMap && !mt.uMap, 'map dropped');
  assert.ok(lum(resolvedColor(mt)) < 0.3, 'back to dark glass when the RT goes away (resize / quality change)');
  ck.destroy();
});

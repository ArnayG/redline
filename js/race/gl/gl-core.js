/* ==========================================================================
   FORGE Atelier — js/race/gl/gl-core.js
   CB.gl : hand-written WebGL core for the 3D race renderer (docs/RACE3D-SPEC.md). Zero dependencies.

   Contents
     * Math        CB.gl.mat4 / mat3 / vec3 / quat (column-major Float32Array, gl-matrix compatible signatures:
                   out first, e.g. mat4.multiply(out, a, b)), CB.gl.frustum (planes + sphere tests).
     * Geometry    CB.gl.geometry: box, roundedBox, cylinder, cone, torus, sphere, plane, disc, extrudeProfile,
                   tube, lathe, loft, merge, computeNormals, transform, colorize, computeBounds, toNonIndexed,
                   triangulate2D. All builders return plain {positions, normals, uvs, indices[, colors, colorSize]}
                   (counter-clockwise front faces, outward normals) and never touch WebGL / the DOM.
     * Context     CB.gl.createContext(canvas, opts) -> ctx {gl, isWebGL2, ext, caps, resize(cssW, cssH, dpr),
                   lost, onLost(fn), onRestored(fn), destroy()}; CB.gl.isSupported().
     * Meshes      CB.gl.createMesh(ctx, geo) -> mesh {draw(program), update(geo), destroy(), bounds};
                   CB.gl.createInstanced(ctx, mesh, data: mat4 + vec4 color per instance, 20 floats).
     * Shaders     GLSL written once, preprocessed for GLSL ES 1.0 (WebGL1) or 3.0 (WebGL2) by CB.gl.preprocess.
                   CB.gl.createProgram(ctx, vs, fs, opts) (with line-numbered error logs);
                   CB.gl.shaders(ctx) -> {standard, unlit, sky, particles, shadow, post (+ instanced / helper
                   variants: standardInstanced, unlitInstanced, shadowInstanced, postBright, postBlur)}.
     * Rendering   CB.gl.drawList(ctx, items, camera, env) (opaque front-to-back, transparent back-to-front,
                   self-drawing items by `order`), CB.gl.createShadowMap(ctx, size), CB.gl.renderShadows,
                   CB.gl.createRenderTarget(ctx, w, h, opts), CB.gl.createPostFX(ctx), CB.gl.drawSky,
                   CB.gl.createParticles(ctx, max), CB.gl.createTexture / whiteTexture.

   Shading conventions (match the renderer3d lighting presets)
     * Lighting is computed in linear space; textures (uMap) are sRGB and decoded in the shader; normal maps linear.
     * Output: ACES filmic + gamma 2.2 in-shader, unless env.linearOutput is true (then linear HDR for a post
       pass that tonemaps). CB.gl.linearOutput is intentionally NOT set: renderer3d's post targets are RGBA8.
     * Directional sun: radiance = uSunColor (Lambert diffuse without 1/PI, GGX specular scaled by PI).
     * Point/spot lights: uLightParams[i] = (range, cosInner, cosOuter, type) type 0 point, 1 spot, -1 off;
       attenuation (1 - d / range)^2, spot cone smoothstep(cosOuter, cosInner, cos).
     * Transparent standard/unlit materials are drawn premultiplied (ONE, ONE_MINUS_SRC_ALPHA) so reflections
       on glass survive low opacity; `additive: true` uses the same blend with alpha 0.
     * Face culling is OFF unless material.cull === true (or side: 'front'); back faces get flipped normals.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.gl = CB.gl || {};

(function (G) {
  'use strict';

  var PI = Math.PI, TAU = PI * 2;
  var EPS = 1e-6;
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ======================================================================
     vec3
     ====================================================================== */
  var vec3 = {
    create: function () { return new Float32Array(3); },
    fromValues: function (x, y, z) { var o = new Float32Array(3); o[0] = x; o[1] = y; o[2] = z; return o; },
    clone: function (a) { var o = new Float32Array(3); o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
    copy: function (o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
    set: function (o, x, y, z) { o[0] = x; o[1] = y; o[2] = z; return o; },
    add: function (o, a, b) { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; },
    sub: function (o, a, b) { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
    mul: function (o, a, b) { o[0] = a[0] * b[0]; o[1] = a[1] * b[1]; o[2] = a[2] * b[2]; return o; },
    scale: function (o, a, s) { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; },
    scaleAndAdd: function (o, a, b, s) { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o; },
    negate: function (o, a) { o[0] = -a[0]; o[1] = -a[1]; o[2] = -a[2]; return o; },
    dot: function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
    cross: function (o, a, b) {
      var ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
      o[0] = ay * bz - az * by; o[1] = az * bx - ax * bz; o[2] = ax * by - ay * bx; return o;
    },
    length: function (a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); },
    squaredLength: function (a) { return a[0] * a[0] + a[1] * a[1] + a[2] * a[2]; },
    distance: function (a, b) { var x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2]; return Math.sqrt(x * x + y * y + z * z); },
    squaredDistance: function (a, b) { var x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2]; return x * x + y * y + z * z; },
    normalize: function (o, a) {
      var x = a[0], y = a[1], z = a[2], l = x * x + y * y + z * z;
      if (l > 0) l = 1 / Math.sqrt(l);
      o[0] = x * l; o[1] = y * l; o[2] = z * l; return o;
    },
    lerp: function (o, a, b, t) { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; },
    min: function (o, a, b) { o[0] = Math.min(a[0], b[0]); o[1] = Math.min(a[1], b[1]); o[2] = Math.min(a[2], b[2]); return o; },
    max: function (o, a, b) { o[0] = Math.max(a[0], b[0]); o[1] = Math.max(a[1], b[1]); o[2] = Math.max(a[2], b[2]); return o; },
    /** Point transform (w = 1, with perspective divide like gl-matrix). */
    transformMat4: function (o, a, m) {
      var x = a[0], y = a[1], z = a[2];
      var w = m[3] * x + m[7] * y + m[11] * z + m[15]; w = w || 1;
      o[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
      o[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      o[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
      return o;
    },
    /** Direction transform by the upper 3x3 of a mat4 (w = 0). */
    transformDirection: function (o, a, m) {
      var x = a[0], y = a[1], z = a[2];
      o[0] = m[0] * x + m[4] * y + m[8] * z; o[1] = m[1] * x + m[5] * y + m[9] * z; o[2] = m[2] * x + m[6] * y + m[10] * z;
      return o;
    },
    transformMat3: function (o, a, m) {
      var x = a[0], y = a[1], z = a[2];
      o[0] = x * m[0] + y * m[3] + z * m[6]; o[1] = x * m[1] + y * m[4] + z * m[7]; o[2] = x * m[2] + y * m[5] + z * m[8];
      return o;
    },
    equals: function (a, b, eps) {
      eps = eps == null ? 1e-6 : eps;
      return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;
    }
  };
  vec3.subtract = vec3.sub; vec3.len = vec3.length; vec3.dist = vec3.distance; vec3.multiply = vec3.mul;

  /* ======================================================================
     mat4 (column-major: m[col * 4 + row])
     ====================================================================== */
  var mat4 = {};
  mat4.create = function () { var o = new Float32Array(16); o[0] = o[5] = o[10] = o[15] = 1; return o; };
  mat4.identity = function (o) {
    o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0; o[4] = 0; o[5] = 1; o[6] = 0; o[7] = 0;
    o[8] = 0; o[9] = 0; o[10] = 1; o[11] = 0; o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1; return o;
  };
  mat4.clone = function (a) { var o = new Float32Array(16); for (var i = 0; i < 16; i++) o[i] = a[i]; return o; };
  mat4.copy = function (o, a) { for (var i = 0; i < 16; i++) o[i] = a[i]; return o; };
  mat4.fromValues = function () { var o = new Float32Array(16); for (var i = 0; i < 16; i++) o[i] = arguments[i]; return o; };
  mat4.multiply = function (o, a, b) {
    var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    var b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
    o[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; o[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    o[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; o[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
    o[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; o[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    o[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; o[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
    o[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; o[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    o[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; o[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
    o[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; o[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    o[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; o[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    return o;
  };
  mat4.mul = mat4.multiply;
  /** Right-handed perspective, depth -1..1 (GL). far may be Infinity. */
  mat4.perspective = function (o, fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    o[0] = f / aspect; o[1] = 0; o[2] = 0; o[3] = 0; o[4] = 0; o[5] = f; o[6] = 0; o[7] = 0;
    o[8] = 0; o[9] = 0; o[11] = -1; o[12] = 0; o[13] = 0; o[15] = 0;
    if (far != null && far !== Infinity) {
      var nf = 1 / (near - far);
      o[10] = (far + near) * nf; o[14] = 2 * far * near * nf;
    } else { o[10] = -1; o[14] = -2 * near; }
    return o;
  };
  mat4.ortho = function (o, l, r, b, t, n, f) {
    var lr = 1 / (l - r), bt = 1 / (b - t), nf = 1 / (n - f);
    o[0] = -2 * lr; o[1] = 0; o[2] = 0; o[3] = 0; o[4] = 0; o[5] = -2 * bt; o[6] = 0; o[7] = 0;
    o[8] = 0; o[9] = 0; o[10] = 2 * nf; o[11] = 0;
    o[12] = (l + r) * lr; o[13] = (t + b) * bt; o[14] = (f + n) * nf; o[15] = 1;
    return o;
  };
  mat4.lookAt = function (o, eye, center, up) {
    var ex = eye[0], ey = eye[1], ez = eye[2];
    var z0 = ex - center[0], z1 = ey - center[1], z2 = ez - center[2];
    var len = z0 * z0 + z1 * z1 + z2 * z2;
    if (len < EPS * EPS) return mat4.identity(o);
    len = 1 / Math.sqrt(len); z0 *= len; z1 *= len; z2 *= len;
    var ux = up[0], uy = up[1], uz = up[2];
    var x0 = uy * z2 - uz * z1, x1 = uz * z0 - ux * z2, x2 = ux * z1 - uy * z0;
    len = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
    if (len < EPS) {
      // up parallel to view direction: pick any perpendicular axis
      if (Math.abs(z1) < 0.9) { x0 = z2; x1 = 0; x2 = -z0; } else { x0 = 0; x1 = -z2; x2 = z1; }
      len = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
    }
    len = 1 / len; x0 *= len; x1 *= len; x2 *= len;
    var y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
    o[0] = x0; o[1] = y0; o[2] = z0; o[3] = 0;
    o[4] = x1; o[5] = y1; o[6] = z1; o[7] = 0;
    o[8] = x2; o[9] = y2; o[10] = z2; o[11] = 0;
    o[12] = -(x0 * ex + x1 * ey + x2 * ez); o[13] = -(y0 * ex + y1 * ey + y2 * ez); o[14] = -(z0 * ex + z1 * ey + z2 * ez); o[15] = 1;
    return o;
  };
  /** Inverse; returns null (and leaves `o` untouched) when singular, like gl-matrix. */
  mat4.invert = function (o, a) {
    var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    var b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    var b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    var b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    var b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null;
    det = 1 / det;
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  };
  mat4.determinant = function (a) {
    var b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4];
    var b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
    var b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12];
    var b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
    return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  };
  mat4.transpose = function (o, a) {
    if (o === a) {
      var t;
      t = a[1]; o[1] = a[4]; o[4] = t; t = a[2]; o[2] = a[8]; o[8] = t; t = a[3]; o[3] = a[12]; o[12] = t;
      t = a[6]; o[6] = a[9]; o[9] = t; t = a[7]; o[7] = a[13]; o[13] = t; t = a[11]; o[11] = a[14]; o[14] = t;
      return o;
    }
    o[0] = a[0]; o[1] = a[4]; o[2] = a[8]; o[3] = a[12]; o[4] = a[1]; o[5] = a[5]; o[6] = a[9]; o[7] = a[13];
    o[8] = a[2]; o[9] = a[6]; o[10] = a[10]; o[11] = a[14]; o[12] = a[3]; o[13] = a[7]; o[14] = a[11]; o[15] = a[15];
    return o;
  };
  /** o = a * T(v) */
  mat4.translate = function (o, a, v) {
    var x = v[0], y = v[1], z = v[2];
    if (o !== a) for (var i = 0; i < 12; i++) o[i] = a[i];
    o[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
    o[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
    o[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
    o[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
    return o;
  };
  /** o = a * S(v) */
  mat4.scale = function (o, a, v) {
    var x = v[0], y = v[1], z = v[2];
    for (var i = 0; i < 4; i++) { o[i] = a[i] * x; o[4 + i] = a[4 + i] * y; o[8 + i] = a[8 + i] * z; o[12 + i] = a[12 + i]; }
    return o;
  };
  function rotAxes(o, a, i0, i1, rad) {
    // o = a * R where R rotates basis columns i0, i1 (shared helper for rotateX/Y/Z)
    var s = Math.sin(rad), c = Math.cos(rad);
    var c0 = i0 * 4, c1 = i1 * 4;
    var a0 = a[c0], a1 = a[c0 + 1], a2 = a[c0 + 2], a3 = a[c0 + 3];
    var b0 = a[c1], b1 = a[c1 + 1], b2 = a[c1 + 2], b3 = a[c1 + 3];
    if (o !== a) for (var i = 0; i < 16; i++) o[i] = a[i];
    o[c0] = a0 * c + b0 * s; o[c0 + 1] = a1 * c + b1 * s; o[c0 + 2] = a2 * c + b2 * s; o[c0 + 3] = a3 * c + b3 * s;
    o[c1] = b0 * c - a0 * s; o[c1 + 1] = b1 * c - a1 * s; o[c1 + 2] = b2 * c - a2 * s; o[c1 + 3] = b3 * c - a3 * s;
    return o;
  }
  mat4.rotateX = function (o, a, rad) { return rotAxes(o, a, 1, 2, rad); };
  mat4.rotateY = function (o, a, rad) { return rotAxes(o, a, 2, 0, rad); };
  mat4.rotateZ = function (o, a, rad) { return rotAxes(o, a, 0, 1, rad); };
  /** o = a * R(axis, rad) */
  mat4.rotate = function (o, a, rad, axis) {
    var x = axis[0], y = axis[1], z = axis[2], len = Math.sqrt(x * x + y * y + z * z);
    if (len < EPS) return o === a ? o : mat4.copy(o, a);
    x /= len; y /= len; z /= len;
    var r = mat4.fromRotation(new Float32Array(16), rad, [x, y, z]);
    return mat4.multiply(o, a, r);
  };
  mat4.fromTranslation = function (o, v) { mat4.identity(o); o[12] = v[0]; o[13] = v[1]; o[14] = v[2]; return o; };
  mat4.fromScaling = function (o, v) { mat4.identity(o); o[0] = v[0]; o[5] = v[1]; o[10] = v[2]; return o; };
  mat4.fromRotation = function (o, rad, axis) {
    var x = axis[0], y = axis[1], z = axis[2], len = Math.sqrt(x * x + y * y + z * z);
    if (len < EPS) return mat4.identity(o);
    x /= len; y /= len; z /= len;
    var s = Math.sin(rad), c = Math.cos(rad), t = 1 - c;
    o[0] = x * x * t + c; o[1] = y * x * t + z * s; o[2] = z * x * t - y * s; o[3] = 0;
    o[4] = x * y * t - z * s; o[5] = y * y * t + c; o[6] = z * y * t + x * s; o[7] = 0;
    o[8] = x * z * t + y * s; o[9] = y * z * t - x * s; o[10] = z * z * t + c; o[11] = 0;
    o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1;
    return o;
  };
  mat4.fromXRotation = function (o, r) { return mat4.rotateX(o, mat4.identity(o), r); };
  mat4.fromYRotation = function (o, r) { return mat4.rotateY(o, mat4.identity(o), r); };
  mat4.fromZRotation = function (o, r) { return mat4.rotateZ(o, mat4.identity(o), r); };
  /** Unit quaternion q = [x, y, z, w] + translation v. */
  mat4.fromRotationTranslation = function (o, q, v) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var x2 = x + x, y2 = y + y, z2 = z + z;
    var xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    o[0] = 1 - (yy + zz); o[1] = xy + wz; o[2] = xz - wy; o[3] = 0;
    o[4] = xy - wz; o[5] = 1 - (xx + zz); o[6] = yz + wx; o[7] = 0;
    o[8] = xz + wy; o[9] = yz - wx; o[10] = 1 - (xx + yy); o[11] = 0;
    o[12] = v ? v[0] : 0; o[13] = v ? v[1] : 0; o[14] = v ? v[2] : 0; o[15] = 1;
    return o;
  };
  mat4.fromQuat = function (o, q) { return mat4.fromRotationTranslation(o, q, null); };
  mat4.fromRotationTranslationScale = function (o, q, v, s) {
    mat4.fromRotationTranslation(o, q, v);
    for (var i = 0; i < 3; i++) { o[i] *= s[0]; o[4 + i] *= s[1]; o[8 + i] *= s[2]; }
    return o;
  };
  mat4.getTranslation = function (o, m) { o[0] = m[12]; o[1] = m[13]; o[2] = m[14]; return o; };
  mat4.getMaxScale = function (m) {
    var sx = m[0] * m[0] + m[1] * m[1] + m[2] * m[2], sy = m[4] * m[4] + m[5] * m[5] + m[6] * m[6], sz = m[8] * m[8] + m[9] * m[9] + m[10] * m[10];
    return Math.sqrt(Math.max(sx, sy, sz));
  };
  mat4.transformPoint = function (o, m, p) { return vec3.transformMat4(o, p, m); };
  mat4.equals = function (a, b, eps) {
    eps = eps == null ? 1e-6 : eps;
    for (var i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > eps * Math.max(1, Math.abs(a[i]), Math.abs(b[i]))) return false;
    return true;
  };

  /* ======================================================================
     mat3 (normal matrices)
     ====================================================================== */
  var mat3 = {
    create: function () { var o = new Float32Array(9); o[0] = o[4] = o[8] = 1; return o; },
    identity: function (o) { o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0; o[4] = 1; o[5] = 0; o[6] = 0; o[7] = 0; o[8] = 1; return o; },
    fromMat4: function (o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = a[4]; o[4] = a[5]; o[5] = a[6]; o[6] = a[8]; o[7] = a[9]; o[8] = a[10]; return o; },
    /** Inverse-transpose of the upper 3x3 of a mat4 (falls back to the plain 3x3 if singular). */
    normalFromMat4: function (o, a) {
      var a00 = a[0], a01 = a[1], a02 = a[2], a10 = a[4], a11 = a[5], a12 = a[6], a20 = a[8], a21 = a[9], a22 = a[10];
      var b01 = a22 * a11 - a12 * a21, b11 = -a22 * a10 + a12 * a20, b21 = a21 * a10 - a11 * a20;
      var det = a00 * b01 + a01 * b11 + a02 * b21;
      if (!det) return mat3.fromMat4(o, a);
      det = 1 / det;
      o[0] = b01 * det; o[1] = b11 * det; o[2] = b21 * det;
      o[3] = (-a22 * a01 + a02 * a21) * det; o[4] = (a22 * a00 - a02 * a20) * det; o[5] = (-a21 * a00 + a01 * a20) * det;
      o[6] = (a12 * a01 - a02 * a11) * det; o[7] = (-a12 * a00 + a02 * a10) * det; o[8] = (a11 * a00 - a01 * a10) * det;
      return o;
    }
  };

  /* ======================================================================
     quat [x, y, z, w]
     ====================================================================== */
  var quat = {
    create: function () { var q = new Float32Array(4); q[3] = 1; return q; },
    identity: function (o) { o[0] = 0; o[1] = 0; o[2] = 0; o[3] = 1; return o; },
    setAxisAngle: function (o, axis, rad) {
      var l = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]) || 1;
      var s = Math.sin(rad / 2) / l;
      o[0] = axis[0] * s; o[1] = axis[1] * s; o[2] = axis[2] * s; o[3] = Math.cos(rad / 2); return o;
    },
    multiply: function (o, a, b) {
      var ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
      o[0] = ax * bw + aw * bx + ay * bz - az * by; o[1] = ay * bw + aw * by + az * bx - ax * bz;
      o[2] = az * bw + aw * bz + ax * by - ay * bx; o[3] = aw * bw - ax * bx - ay * by - az * bz;
      return o;
    },
    normalize: function (o, a) {
      var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]) || 1;
      o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l; o[3] = a[3] / l; return o;
    },
    /** Euler angles in RADIANS applied in X, then Y, then Z order (q = qz * qy * qx). */
    fromEuler: function (o, x, y, z) {
      var sx = Math.sin(x / 2), cx = Math.cos(x / 2), sy = Math.sin(y / 2), cy = Math.cos(y / 2), sz = Math.sin(z / 2), cz = Math.cos(z / 2);
      o[0] = sx * cy * cz - cx * sy * sz; o[1] = cx * sy * cz + sx * cy * sz;
      o[2] = cx * cy * sz - sx * sy * cz; o[3] = cx * cy * cz + sx * sy * sz;
      return o;
    },
    slerp: function (o, a, b, t) {
      var ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
      var cos = ax * bx + ay * by + az * bz + aw * bw;
      if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
      var s0, s1;
      if (1 - cos > 1e-6) { var om = Math.acos(cos), so = Math.sin(om); s0 = Math.sin((1 - t) * om) / so; s1 = Math.sin(t * om) / so; }
      else { s0 = 1 - t; s1 = t; }
      o[0] = s0 * ax + s1 * bx; o[1] = s0 * ay + s1 * by; o[2] = s0 * az + s1 * bz; o[3] = s0 * aw + s1 * bw;
      return o;
    }
  };

  /* ======================================================================
     frustum: planes (a, b, c, d) normalized, inside when a x + b y + c z + d >= 0
     ====================================================================== */
  var frustum = {
    fromMatrix: function (m, out) {
      out = out || new Float32Array(24);
      var r = [
        [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],   // left
        [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],   // right
        [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],   // bottom
        [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],   // top
        [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],  // near
        [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]]   // far
      ];
      for (var i = 0; i < 6; i++) {
        var p = r[i], l = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) || 1;
        out[i * 4] = p[0] / l; out[i * 4 + 1] = p[1] / l; out[i * 4 + 2] = p[2] / l; out[i * 4 + 3] = p[3] / l;
      }
      return out;
    },
    sphereVisible: function (planes, x, y, z, r) {
      for (var i = 0; i < 24; i += 4) if (planes[i] * x + planes[i + 1] * y + planes[i + 2] * z + planes[i + 3] < -r) return false;
      return true;
    }
  };

  /* ======================================================================
     Geometry builders (pure)
     ====================================================================== */
  function idxArray(list, nverts) {
    return nverts > 65535 ? new Uint32Array(list) : new Uint16Array(list);
  }
  function finish(pos, nrm, uv, idx, extra) {
    var nv = pos.length / 3;
    var g = {
      positions: new Float32Array(pos),
      normals: new Float32Array(nrm),
      uvs: new Float32Array(uv && uv.length ? uv : new Array(nv * 2).fill(0)),
      indices: idxArray(idx, nv)
    };
    if (extra) for (var k in extra) g[k] = extra[k];
    return g;
  }
  /** Rotate a Y-axis geometry onto axis 'x' or 'z' (keeps winding: proper rotations). */
  function orientAxis(g, axis) {
    if (!axis || axis === 'y') return g;
    var m = mat4.create();
    if (axis === 'x') mat4.fromZRotation(m, -PI / 2);       // +Y -> +X
    else if (axis === 'z') mat4.fromXRotation(m, PI / 2);   // +Y -> +Z
    else if (axis === '-x') mat4.fromZRotation(m, PI / 2);
    else if (axis === '-z') mat4.fromXRotation(m, -PI / 2);
    else if (axis === '-y') mat4.fromXRotation(m, PI);
    else return g;
    return transform(g, m);
  }
  function translateGeo(g, c) {
    if (!c || (!c[0] && !c[1] && !c[2])) return g;
    var p = g.positions;
    for (var i = 0; i < p.length; i += 3) { p[i] += c[0]; p[i + 1] += c[1]; p[i + 2] += c[2]; }
    return g;
  }

  /** box(width, height, depth, opts{center, segments}) or box({width, height, depth, center}). 24 verts, flat faces. */
  function box(w, h, d, opts) {
    if (w && typeof w === 'object' && !Array.isArray(w)) { opts = w; w = opts.width; h = opts.height; d = opts.depth; }
    else if (Array.isArray(w)) { opts = h; d = w[2]; h = w[1]; w = w[0]; }
    opts = opts || {};
    w = num(w, 1); h = num(h, w); d = num(d, w);
    var hx = w / 2, hy = h / 2, hz = d / 2;
    var pos = [], nrm = [], uv = [], idx = [];
    // [normal, uAxis, vAxis] with u x v = n
    var faces = [
      [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]
    ];
    var ext = [hx, hy, hz];
    for (var f = 0; f < 6; f++) {
      var n = faces[f][0], u = faces[f][1], v = faces[f][2];
      var base = pos.length / 3;
      var corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      // world-size UVs (1 unit = 1 m) when opts.worldUV, else 0..1
      var su = Math.abs(u[0]) * w + Math.abs(u[1]) * h + Math.abs(u[2]) * d, sv = Math.abs(v[0]) * w + Math.abs(v[1]) * h + Math.abs(v[2]) * d;
      for (var c = 0; c < 4; c++) {
        var cu = corners[c][0], cv = corners[c][1];
        for (var k = 0; k < 3; k++) pos.push((n[k] + u[k] * cu + v[k] * cv) * ext[k]);
        nrm.push(n[0], n[1], n[2]);
        if (opts.worldUV) uv.push((cu * 0.5 + 0.5) * su, (cv * 0.5 + 0.5) * sv);
        else uv.push(cu * 0.5 + 0.5, cv * 0.5 + 0.5);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return translateGeo(finish(pos, nrm, uv, idx), opts.center);
  }

  /** Box with rounded edges/corners (radius r, `segments` steps per 45 degrees of rounding on each face). */
  function roundedBox(w, h, d, r, segments, opts) {
    opts = opts || {};
    w = num(w, 1); h = num(h, w); d = num(d, w);
    r = clamp(num(r, Math.min(w, h, d) * 0.1), 0, Math.min(w, h, d) / 2 - 1e-5);
    var seg = Math.max(1, Math.round(num(segments, 3)));
    var hx = w / 2, hy = h / 2, hz = d / 2;
    var ext = [hx, hy, hz], inner = [hx - r, hy - r, hz - r];
    var pos = [], nrm = [], uv = [], idx = [];
    var faces = [
      [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]
    ];
    var steps = seg * 2 + 1, row = steps + 1;
    // face-plane coordinate of grid index i along an axis with inner half-extent `ie`: arcs sampled at even angles
    function param(i, ie) {
      if (i <= seg) return -(ie + r * Math.tan((1 - i / seg) * PI / 4));
      return ie + r * Math.tan(((i - seg - 1) / seg) * PI / 4);
    }
    for (var f = 0; f < 6; f++) {
      var n = faces[f][0], u = faces[f][1], v = faces[f][2];
      var base = pos.length / 3;
      var ue = Math.abs(u[0]) * hx + Math.abs(u[1]) * hy + Math.abs(u[2]) * hz;
      var ve = Math.abs(v[0]) * hx + Math.abs(v[1]) * hy + Math.abs(v[2]) * hz;
      var ui = ue - r, vi = ve - r;
      for (var j = 0; j <= steps; j++) {
        for (var i = 0; i <= steps; i++) {
          var pu = param(i, ui), pv = param(j, vi);
          var p = [0, 0, 0];
          for (var k = 0; k < 3; k++) p[k] = n[k] * (ext[k] - r) + u[k] * pu + v[k] * pv + n[k] * r;
          var c = [clamp(p[0], -inner[0], inner[0]), clamp(p[1], -inner[1], inner[1]), clamp(p[2], -inner[2], inner[2])];
          var ox = p[0] - c[0], oy = p[1] - c[1], oz = p[2] - c[2], ol = Math.sqrt(ox * ox + oy * oy + oz * oz) || 1;
          ox /= ol; oy /= ol; oz /= ol;
          pos.push(c[0] + ox * r, c[1] + oy * r, c[2] + oz * r);
          nrm.push(ox, oy, oz);
          uv.push(clamp(pu / ue, -1, 1) * 0.5 + 0.5, clamp(pv / ve, -1, 1) * 0.5 + 0.5);
        }
      }
      for (j = 0; j < steps; j++) for (i = 0; i < steps; i++) {
        var a0 = base + j * row + i, a1 = a0 + 1, a2 = a0 + row + 1, a3 = a0 + row;
        idx.push(a0, a1, a2, a0, a2, a3);
      }
    }
    return translateGeo(finish(pos, nrm, uv, idx), opts.center);
  }

  /** cylinder(radiusTop, radiusBottom, height, radialSegments, opts{heightSegments, caps=true, thetaStart,
      thetaLength, axis:'y'|'x'|'z', center}) — centred on the origin along the axis. */
  function cylinder(rTop, rBottom, height, radialSegments, opts) {
    if (rTop && typeof rTop === 'object') { opts = rTop; rTop = opts.radiusTop != null ? opts.radiusTop : opts.radius; rBottom = opts.radiusBottom != null ? opts.radiusBottom : opts.radius; height = opts.height; radialSegments = opts.segments || opts.radialSegments; }
    opts = opts || {};
    rTop = num(rTop, 0.5); rBottom = num(rBottom, rTop); height = num(height, 1);
    var rs = Math.max(3, Math.round(num(radialSegments, 16))), hs = Math.max(1, Math.round(num(opts.heightSegments, 1)));
    var caps = opts.caps !== false && opts.openEnded !== true;
    var t0 = num(opts.thetaStart, 0), tl = num(opts.thetaLength, TAU);
    var pos = [], nrm = [], uv = [], idx = [];
    var half = height / 2, slope = (rBottom - rTop) / height;
    var grid = [];
    for (var y = 0; y <= hs; y++) {
      var row = [], v = y / hs, r = v * (rBottom - rTop) + rTop;
      for (var x = 0; x <= rs; x++) {
        var u = x / rs, th = u * tl + t0, s = Math.sin(th), c = Math.cos(th);
        pos.push(r * s, -v * height + half, r * c);
        var nx = s, ny = slope, nz = c, nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nrm.push(nx / nl, ny / nl, nz / nl);
        uv.push(u, 1 - v);
        row.push(pos.length / 3 - 1);
      }
      grid.push(row);
    }
    for (x = 0; x < rs; x++) for (y = 0; y < hs; y++) {
      var a = grid[y][x], b = grid[y + 1][x], cc = grid[y + 1][x + 1], d = grid[y][x + 1];
      idx.push(a, b, d, b, cc, d);
    }
    function cap(top) {
      var r = top ? rTop : rBottom, sign = top ? 1 : -1;
      if (r <= 0) return;
      var center = pos.length / 3;
      // one centre vertex per segment for nicer UVs
      for (var x = 1; x <= rs; x++) { pos.push(0, half * sign, 0); nrm.push(0, sign, 0); uv.push(0.5, 0.5); }
      var start = pos.length / 3;
      for (x = 0; x <= rs; x++) {
        var u = x / rs, th = u * tl + t0, s = Math.sin(th), c = Math.cos(th);
        pos.push(r * s, half * sign, r * c); nrm.push(0, sign, 0); uv.push(c * 0.5 + 0.5, s * 0.5 * sign + 0.5);
      }
      for (x = 0; x < rs; x++) {
        var ci = center + x, i0 = start + x, i1 = start + x + 1;
        if (top) idx.push(i0, i1, ci); else idx.push(i1, i0, ci);
      }
    }
    if (caps) { cap(true); cap(false); }
    var g = finish(pos, nrm, uv, idx);
    g = orientAxis(g, opts.axis);
    return translateGeo(g, opts.center);
  }
  function cone(radius, height, segments, opts) { return cylinder(0, radius, height, segments, opts); }

  /** torus(radius, tube, radialSegments, tubularSegments, arc, opts{axis}) — ring in the XY plane, axis +Z
      (wheel-friendly: car-local wheel axis is Z). */
  function torus(R, r, radialSegments, tubularSegments, arc, opts) {
    if (R && typeof R === 'object') { opts = R; R = opts.radius; r = opts.tube; radialSegments = opts.radialSegments; tubularSegments = opts.tubularSegments; arc = opts.arc; }
    opts = opts || {};
    R = num(R, 1); r = num(r, 0.3);
    var rad = Math.max(3, Math.round(num(radialSegments, 12))), tub = Math.max(3, Math.round(num(tubularSegments, 32)));
    arc = num(arc, TAU);
    var pos = [], nrm = [], uv = [], idx = [];
    for (var j = 0; j <= rad; j++) {
      for (var i = 0; i <= tub; i++) {
        var u = (i / tub) * arc, v = (j / rad) * TAU;
        var cx = R * Math.cos(u), cy = R * Math.sin(u);
        var x = (R + r * Math.cos(v)) * Math.cos(u), y = (R + r * Math.cos(v)) * Math.sin(u), z = r * Math.sin(v);
        pos.push(x, y, z);
        var nx = x - cx, ny = y - cy, nz = z, nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nrm.push(nx / nl, ny / nl, nz / nl);
        uv.push(i / tub, j / rad);
      }
    }
    for (j = 1; j <= rad; j++) for (i = 1; i <= tub; i++) {
      var a = (tub + 1) * j + i - 1, b = (tub + 1) * (j - 1) + i - 1, c = (tub + 1) * (j - 1) + i, d = (tub + 1) * j + i;
      idx.push(a, b, d, b, c, d);
    }
    var g = finish(pos, nrm, uv, idx);
    if (opts.axis && opts.axis !== 'z') {
      var m = mat4.create();
      if (opts.axis === 'x') mat4.fromYRotation(m, PI / 2); else if (opts.axis === 'y') mat4.fromXRotation(m, -PI / 2);
      g = transform(g, m);
    }
    return translateGeo(g, opts.center);
  }

  /** sphere(radius, widthSegments, heightSegments, opts{phiStart, phiLength, thetaStart, thetaLength, center}) */
  function sphere(radius, ws, hs, opts) {
    if (radius && typeof radius === 'object') { opts = radius; radius = opts.radius; ws = opts.widthSegments; hs = opts.heightSegments; }
    opts = opts || {};
    radius = num(radius, 1);
    ws = Math.max(3, Math.round(num(ws, 24))); hs = Math.max(2, Math.round(num(hs, 16)));
    var p0 = num(opts.phiStart, 0), pl = num(opts.phiLength, TAU), t0 = num(opts.thetaStart, 0), tl = num(opts.thetaLength, PI);
    var tEnd = Math.min(t0 + tl, PI);
    var pos = [], nrm = [], uv = [], idx = [], grid = [];
    for (var iy = 0; iy <= hs; iy++) {
      var row = [], v = iy / hs;
      for (var ix = 0; ix <= ws; ix++) {
        var u = ix / ws;
        var x = -Math.cos(p0 + u * pl) * Math.sin(t0 + v * tl);
        var y = Math.cos(t0 + v * tl);
        var z = Math.sin(p0 + u * pl) * Math.sin(t0 + v * tl);
        pos.push(radius * x, radius * y, radius * z); nrm.push(x, y, z); uv.push(u, 1 - v);
        row.push(pos.length / 3 - 1);
      }
      grid.push(row);
    }
    for (iy = 0; iy < hs; iy++) for (ix = 0; ix < ws; ix++) {
      var a = grid[iy][ix + 1], b = grid[iy][ix], c = grid[iy + 1][ix], d = grid[iy + 1][ix + 1];
      if (iy !== 0 || t0 > 0) idx.push(a, b, d);
      if (iy !== hs - 1 || tEnd < PI) idx.push(b, c, d);
    }
    return translateGeo(finish(pos, nrm, uv, idx), opts.center);
  }

  /** plane(width, depth, segW, segD, opts{uvScale, center}) — XZ plane facing +Y. */
  function plane(w, d, sw, sd, opts) {
    if (w && typeof w === 'object') { opts = w; w = opts.width; d = opts.depth; sw = opts.segmentsW; sd = opts.segmentsD; }
    opts = opts || {};
    w = num(w, 1); d = num(d, w);
    sw = Math.max(1, Math.round(num(sw, 1))); sd = Math.max(1, Math.round(num(sd, 1)));
    var us = opts.uvScale == null ? [1, 1] : (typeof opts.uvScale === 'number' ? [opts.uvScale, opts.uvScale] : opts.uvScale);
    var pos = [], nrm = [], uv = [], idx = [];
    for (var iz = 0; iz <= sd; iz++) for (var ix = 0; ix <= sw; ix++) {
      pos.push(-w / 2 + (ix / sw) * w, 0, -d / 2 + (iz / sd) * d); nrm.push(0, 1, 0); uv.push((ix / sw) * us[0], (1 - iz / sd) * us[1]);
    }
    var row = sw + 1;
    for (iz = 0; iz < sd; iz++) for (ix = 0; ix < sw; ix++) {
      var a = iz * row + ix, b = (iz + 1) * row + ix, c = b + 1, e = a + 1;
      idx.push(a, b, e, b, c, e);
    }
    return translateGeo(finish(pos, nrm, uv, idx), opts.center);
  }

  /** disc(radius, segments, opts{innerRadius, center}) facing +Y (annulus when innerRadius > 0). */
  function disc(radius, segments, opts) {
    opts = opts || {};
    radius = num(radius, 1);
    var n = Math.max(3, Math.round(num(segments, 24))), ri = Math.max(0, num(opts.innerRadius, 0));
    var pos = [], nrm = [], uv = [], idx = [];
    for (var i = 0; i <= n; i++) {
      var a = (i / n) * TAU, s = Math.sin(a), c = Math.cos(a);
      pos.push(c * radius, 0, -s * radius); nrm.push(0, 1, 0); uv.push(c * 0.5 + 0.5, s * 0.5 + 0.5);
      var rr = ri / radius;
      pos.push(c * ri, 0, -s * ri); nrm.push(0, 1, 0); uv.push(c * 0.5 * rr + 0.5, s * 0.5 * rr + 0.5);
    }
    for (i = 0; i < n; i++) {
      var o0 = i * 2, i0 = i * 2 + 1, o1 = i * 2 + 2, i1 = i * 2 + 3;
      idx.push(o0, o1, i0); if (ri > 0) idx.push(i0, o1, i1);
    }
    return translateGeo(finish(pos, nrm, uv, idx), opts.center);
  }

  /* ---------------- 2D polygon helpers */
  function signedArea2D(pts) {
    var a = 0;
    for (var i = 0, n = pts.length; i < n; i++) { var p = pts[i], q = pts[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
    return a / 2;
  }
  /** Ear-clipping triangulation of a simple polygon [[x, y], ...]; returns CCW-oriented index triples. */
  function triangulate2D(pts) {
    var n = pts.length, out = [];
    if (n < 3) return out;
    var V = [];
    var ccw = signedArea2D(pts) > 0;
    for (var i = 0; i < n; i++) V.push(ccw ? i : n - 1 - i);
    function area(a, b, c) { return (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[c][0] - pts[a][0]) * (pts[b][1] - pts[a][1]); }
    function inside(a, b, c, p) {
      var P = pts[p];
      var d1 = (pts[b][0] - pts[a][0]) * (P[1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (P[0] - pts[a][0]);
      var d2 = (pts[c][0] - pts[b][0]) * (P[1] - pts[b][1]) - (pts[c][1] - pts[b][1]) * (P[0] - pts[b][0]);
      var d3 = (pts[a][0] - pts[c][0]) * (P[1] - pts[c][1]) - (pts[a][1] - pts[c][1]) * (P[0] - pts[c][0]);
      // points on an edge count as inside (prevents ears that cut through a touching reflex vertex)
      var e = -1e-12;
      return d1 >= e && d2 >= e && d3 >= e;
    }
    var guard = n * n + 10;
    while (V.length > 3 && guard-- > 0) {
      var found = false;
      for (i = 0; i < V.length; i++) {
        var a = V[(i + V.length - 1) % V.length], b = V[i], c = V[(i + 1) % V.length];
        if (area(a, b, c) <= 1e-12) continue;
        var ok = true;
        for (var j = 0; j < V.length; j++) {
          var p = V[j];
          if (p === a || p === b || p === c) continue;
          var Pp = pts[p];
          if ((Pp[0] === pts[a][0] && Pp[1] === pts[a][1]) || (Pp[0] === pts[b][0] && Pp[1] === pts[b][1]) || (Pp[0] === pts[c][0] && Pp[1] === pts[c][1])) continue;
          if (inside(a, b, c, p)) { ok = false; break; }
        }
        if (!ok) continue;
        out.push(a, b, c);
        V.splice(i, 1);
        found = true;
        break;
      }
      if (!found) break; // degenerate: fan the remainder
    }
    if (V.length >= 3) for (i = 1; i < V.length - 1; i++) out.push(V[0], V[i], V[i + 1]);
    return out;
  }

  function toPts3(path) {
    if (!path) return [];
    if (path.length && typeof path[0] === 'number') {
      var o = [];
      for (var i = 0; i + 2 < path.length; i += 3) o.push([path[i], path[i + 1], path[i + 2]]);
      return o;
    }
    return path;
  }
  function toPts2(pr) {
    if (!pr) return [];
    if (pr.length && typeof pr[0] === 'number') {
      var o = [];
      for (var i = 0; i + 1 < pr.length; i += 2) o.push([pr[i], pr[i + 1]]);
      return o;
    }
    return pr.map(function (p) { return Array.isArray(p) || ArrayBuffer.isView(p) ? [p[0], p[1]] : [p.x, p.y]; });
  }

  /** extrudeProfile(profile2D, path3D, opts) — sweep a 2D profile [[x(side), y(up)], ...] along a 3D path.
      opts: closed (profile is a loop; default true when > 2 points), closedPath, up ([0, 1, 0]), smooth
      (share vertices across profile corners; default false = hard edges), caps (closed profile, open path),
      uvScale ([along, around] metres per UV unit; default [1, 1]), scales (per path point profile scale),
      twist? (no) — frames use a fixed up vector with parallel transport fallback, so roads/barriers never roll. */
  function extrudeProfile(profile, path, opts) {
    opts = opts || {};
    var P2 = toPts2(profile), P3 = toPts3(path);
    var np = P2.length, nq = P3.length;
    if (np < 2 || nq < 2) return finish([], [], [], []);
    var closed = opts.closed != null ? !!opts.closed : np > 2;
    var closedPath = !!opts.closedPath;
    var smooth = !!opts.smooth;
    var up = opts.up || [0, 1, 0];
    var us = opts.uvScale == null ? [1, 1] : (typeof opts.uvScale === 'number' ? [opts.uvScale, opts.uvScale] : opts.uvScale);
    // profile orientation: make normals point outward (CCW profile => outward = (dy, -dx))
    var orient = closed ? (signedArea2D(P2) >= 0 ? 1 : -1) : (opts.flip ? -1 : 1);
    // frames
    var T = [], S = [], U = [], dist = [0];
    for (var i = 0; i < nq; i++) {
      var a = P3[i > 0 ? i - 1 : (closedPath ? nq - 1 : 0)], b = P3[i < nq - 1 ? i + 1 : (closedPath ? 0 : nq - 1)];
      var t = vec3.normalize([0, 0, 0], [b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      if (vec3.length(t) < 0.5) t = T.length ? T[T.length - 1].slice() : [1, 0, 0];
      var s = vec3.cross([0, 0, 0], t, up);
      if (vec3.length(s) < 1e-4) s = S.length ? S[S.length - 1].slice() : vec3.cross([0, 0, 0], t, [1, 0, 0]);
      vec3.normalize(s, s);
      var u = vec3.normalize([0, 0, 0], vec3.cross([0, 0, 0], s, t));
      T.push(t); S.push(s); U.push(u);
      if (i > 0) dist.push(dist[i - 1] + vec3.distance(P3[i - 1], P3[i]));
    }
    var scales = opts.scales;
    // profile segment list (with closing segment) and around-distance
    var segs = closed ? np : np - 1;
    var around = [0];
    for (i = 0; i < segs; i++) { var p = P2[i], q = P2[(i + 1) % np]; around.push(around[i] + Math.hypot(q[0] - p[0], q[1] - p[1])); }
    var pos = [], nrm = [], uv = [], idx = [];
    var rings = closedPath ? nq + 1 : nq;
    function place(qi, px, py, out) {
      var k = qi % nq, sc = scales ? num(scales[k], 1) : 1, c = P3[k];
      out[0] = c[0] + (S[k][0] * px + U[k][0] * py) * sc;
      out[1] = c[1] + (S[k][1] * px + U[k][1] * py) * sc;
      out[2] = c[2] + (S[k][2] * px + U[k][2] * py) * sc;
      return out;
    }
    var tmp = [0, 0, 0];
    var totalLen = dist[nq - 1] + (closedPath ? vec3.distance(P3[nq - 1], P3[0]) : 0);
    function along(qi) { return qi < nq ? dist[qi] : totalLen; }
    if (smooth) {
      // shared vertices per profile point (seam duplicated for UV when closed); vertex normal = avg of edge normals
      var cols = closed ? np + 1 : np;
      var pn = [];
      for (var j = 0; j < np; j++) {
        var nx = 0, ny = 0;
        var e0 = closed || j > 0 ? [P2[(j - 1 + np) % np], P2[j]] : null, e1 = closed || j < np - 1 ? [P2[j], P2[(j + 1) % np]] : null;
        [e0, e1].forEach(function (e) {
          if (!e) return;
          var dx = e[1][0] - e[0][0], dy = e[1][1] - e[0][1], l = Math.hypot(dx, dy) || 1;
          nx += (dy / l) * orient; ny += (-dx / l) * orient;
        });
        var nl = Math.hypot(nx, ny) || 1; pn.push([nx / nl, ny / nl]);
      }
      for (var qi = 0; qi < rings; qi++) {
        var k = qi % nq;
        for (j = 0; j < cols; j++) {
          var pj = P2[j % np], nj = pn[j % np];
          place(qi, pj[0], pj[1], tmp); pos.push(tmp[0], tmp[1], tmp[2]);
          nrm.push(S[k][0] * nj[0] + U[k][0] * nj[1], S[k][1] * nj[0] + U[k][1] * nj[1], S[k][2] * nj[0] + U[k][2] * nj[1]);
          uv.push(along(qi) / us[0], around[j] / us[1]);
        }
      }
      for (qi = 0; qi < rings - 1; qi++) for (j = 0; j < cols - 1; j++) {
        var a0 = qi * cols + j, a1 = a0 + 1, b0 = a0 + cols, b1 = b0 + 1;
        idx.push(a0, b0, a1, a1, b0, b1);
      }
    } else {
      // hard edges: 2 vertices per profile segment per ring
      for (var sgi = 0; sgi < segs; sgi++) {
        var p0 = P2[sgi], p1 = P2[(sgi + 1) % np];
        var dx = p1[0] - p0[0], dy = p1[1] - p0[1], l = Math.hypot(dx, dy) || 1;
        var n2x = (dy / l) * orient, n2y = (-dx / l) * orient;
        var base = pos.length / 3;
        for (qi = 0; qi < rings; qi++) {
          k = qi % nq;
          var nx3 = S[k][0] * n2x + U[k][0] * n2y, ny3 = S[k][1] * n2x + U[k][1] * n2y, nz3 = S[k][2] * n2x + U[k][2] * n2y;
          place(qi, p0[0], p0[1], tmp); pos.push(tmp[0], tmp[1], tmp[2]); nrm.push(nx3, ny3, nz3); uv.push(along(qi) / us[0], around[sgi] / us[1]);
          place(qi, p1[0], p1[1], tmp); pos.push(tmp[0], tmp[1], tmp[2]); nrm.push(nx3, ny3, nz3); uv.push(along(qi) / us[0], around[sgi + 1] / us[1]);
        }
        for (qi = 0; qi < rings - 1; qi++) {
          var c0 = base + qi * 2, c1 = c0 + 1, d0 = c0 + 2, d1 = c0 + 3;
          idx.push(c0, d0, c1, c1, d0, d1);
        }
      }
    }
    // winding: make the first triangle's geometric normal agree with its vertex normal
    fixWinding(pos, nrm, idx);
    if (opts.caps && closed && !closedPath) {
      var tri = triangulate2D(P2);
      [0, nq - 1].forEach(function (qi, e) {
        var k = qi, base = pos.length / 3, sgn = e === 0 ? -1 : 1;
        for (var j = 0; j < np; j++) {
          place(qi, P2[j][0], P2[j][1], tmp); pos.push(tmp[0], tmp[1], tmp[2]);
          nrm.push(T[k][0] * sgn, T[k][1] * sgn, T[k][2] * sgn);
          uv.push(P2[j][0] / us[1], P2[j][1] / us[1]);
        }
        var start = idx.length;
        for (var t = 0; t < tri.length; t += 3) idx.push(base + tri[t], base + tri[t + 1], base + tri[t + 2]);
        fixWinding(pos, nrm, idx, start);
      });
    }
    return finish(pos, nrm, uv, idx);
  }

  /** Flip all triangles from index `start` if the majority disagree with the vertex normals. */
  function fixWinding(pos, nrm, idx, start) {
    start = start || 0;
    var agree = 0, total = 0;
    for (var t = start; t + 2 < idx.length; t += 3) {
      var a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      var vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      var gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
      var d = gx * (nrm[a] + nrm[b] + nrm[c]) + gy * (nrm[a + 1] + nrm[b + 1] + nrm[c + 1]) + gz * (nrm[a + 2] + nrm[b + 2] + nrm[c + 2]);
      if (Math.abs(d) < 1e-14) continue;
      total++; if (d > 0) agree++;
    }
    if (total && agree * 2 < total) {
      for (t = start; t + 2 < idx.length; t += 3) { var tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
      return true;
    }
    return false;
  }

  /** tube(path3D, radius, radialSegments, opts{closedPath, caps, uvScale}) — smooth round pipe along a path. */
  function tube(path, radius, radialSegments, opts) {
    opts = opts || {};
    var n = Math.max(3, Math.round(num(radialSegments, 8))), r = num(radius, 0.05), prof = [];
    for (var i = 0; i < n; i++) { var a = (i / n) * TAU; prof.push([Math.cos(a) * r, Math.sin(a) * r]); }
    return extrudeProfile(prof, path, { closed: true, smooth: true, closedPath: opts.closedPath, caps: opts.caps, up: opts.up, uvScale: opts.uvScale || [1, TAU * r] });
  }

  /** lathe(profile [[radius, y], ...], segments, opts{phiStart, phiLength}) — revolve around +Y.
      Profile ordered bottom -> top gives outward normals (orientation is auto-detected otherwise). */
  function lathe(profile, segments, opts) {
    opts = opts || {};
    var P = toPts2(profile), n = P.length;
    var seg = Math.max(3, Math.round(num(segments, 24)));
    var p0 = num(opts.phiStart, 0), pl = clamp(num(opts.phiLength, TAU), 0, TAU);
    if (n < 2) return finish([], [], [], []);
    // 2D profile normals (smooth); outward = (dy, -dx) for a profile traversed bottom -> top at positive radius
    var pn = [], vlen = [0];
    for (var j = 0; j < n; j++) {
      var a = P[Math.max(0, j - 1)], b = P[Math.min(n - 1, j + 1)];
      var dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      pn.push([dy / l, -dx / l]);
      if (j > 0) vlen.push(vlen[j - 1] + Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]));
    }
    var pos = [], nrm = [], uv = [], idx = [];
    for (var i = 0; i <= seg; i++) {
      var phi = p0 + (i / seg) * pl, s = Math.sin(phi), c = Math.cos(phi);
      for (j = 0; j < n; j++) {
        pos.push(P[j][0] * s, P[j][1], P[j][0] * c);
        nrm.push(pn[j][0] * s, pn[j][1], pn[j][0] * c);
        uv.push(i / seg, vlen[j] / (vlen[n - 1] || 1));
      }
    }
    for (i = 0; i < seg; i++) for (j = 0; j < n - 1; j++) {
      var base = j + i * n, a0 = base, b0 = base + n, c0 = base + n + 1, d0 = base + 1;
      idx.push(a0, b0, d0, c0, d0, b0);
    }
    fixWinding(pos, nrm, idx);
    // profiles traversed top -> bottom produce inward normals: flip normals if most point toward the axis
    var outward = 0, inward = 0;
    for (var v = 0; v < pos.length; v += 3) {
      var rd = pos[v] * nrm[v] + pos[v + 2] * nrm[v + 2];
      if (rd > 1e-9) outward++; else if (rd < -1e-9) inward++;
    }
    if (inward > outward && opts.keepNormals !== true) {
      for (v = 0; v < nrm.length; v++) nrm[v] = -nrm[v];
      fixWinding(pos, nrm, idx);
    }
    return finish(pos, nrm, uv, idx);
  }

  /** loft(sections, opts{closed=true (rings are loops), closeEnds=false, flip, uvScale, smooth=true})
      sections: array of rings, every ring = array of [x, y, z] (or flat number arrays) with EQUAL vertex count.
      Smooth normals across rings and around the loop (seam duplicated for UVs); orientation is auto-detected so
      normals point away from each ring's centroid (car bodies, nose cones, exhausts…). End caps are flat fans. */
  function loft(sections, opts) {
    opts = opts || {};
    var R = (sections || []).map(toPts3).filter(function (r) { return r.length >= 2; });
    var nr = R.length;
    if (nr < 2) return finish([], [], [], []);
    var m = R[0].length;
    for (var i = 1; i < nr; i++) if (R[i].length !== m) throw new Error('CB.gl.geometry.loft: all sections need the same vertex count (' + m + ' vs ' + R[i].length + ' at ' + i + ')');
    var closed = opts.closed !== false;
    // topology on a wrapped grid (no seam duplicate) -> smooth normals
    var P = new Float32Array(nr * m * 3), I = [];
    for (i = 0; i < nr; i++) for (var j = 0; j < m; j++) { var p = R[i][j], o = (i * m + j) * 3; P[o] = p[0]; P[o + 1] = p[1]; P[o + 2] = p[2]; }
    var jm = closed ? m : m - 1;
    for (i = 0; i < nr - 1; i++) for (j = 0; j < jm; j++) {
      var a = i * m + j, b = i * m + (j + 1) % m, c = (i + 1) * m + j, d = (i + 1) * m + (j + 1) % m;
      I.push(a, c, b, b, c, d);
    }
    var N = computeNormalsRaw(P, I);
    // orientation: normals should point away from ring centroids
    var cent = R.map(function (r) { var cx = 0, cy = 0, cz = 0; r.forEach(function (q) { cx += q[0]; cy += q[1]; cz += q[2]; }); return [cx / r.length, cy / r.length, cz / r.length]; });
    var score = 0;
    for (i = 0; i < nr; i++) for (j = 0; j < m; j++) {
      o = (i * m + j) * 3;
      score += (P[o] - cent[i][0]) * N[o] + (P[o + 1] - cent[i][1]) * N[o + 1] + (P[o + 2] - cent[i][2]) * N[o + 2];
    }
    var flip = (score < 0) !== !!opts.flip;
    if (flip) { for (i = 0; i < I.length; i += 3) { var t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; } for (i = 0; i < N.length; i++) N[i] = -N[i]; }
    if (opts.smooth === false) return toFlat(finish(Array.prototype.slice.call(P), Array.prototype.slice.call(N), new Array(nr * m * 2).fill(0), I));
    // expand: duplicate the seam column for UVs
    var cols = closed ? m + 1 : m;
    var us = opts.uvScale == null ? [1, 1] : (typeof opts.uvScale === 'number' ? [opts.uvScale, opts.uvScale] : opts.uvScale);
    var alongD = [0];
    for (i = 1; i < nr; i++) alongD.push(alongD[i - 1] + vec3.distance(cent[i - 1], cent[i]));
    var pos = [], nrm = [], uv = [], idx = [];
    for (i = 0; i < nr; i++) {
      var ar = [0];
      for (j = 1; j < cols; j++) ar.push(ar[j - 1] + vec3.distance(R[i][(j - 1) % m], R[i][j % m]));
      var tot = ar[cols - 1] || 1;
      for (j = 0; j < cols; j++) {
        o = (i * m + (j % m)) * 3;
        pos.push(P[o], P[o + 1], P[o + 2]); nrm.push(N[o], N[o + 1], N[o + 2]);
        uv.push(opts.uvScale ? alongD[i] / us[0] : i / (nr - 1), opts.uvScale ? ar[j] / us[1] : ar[j] / tot);
      }
    }
    for (i = 0; i < nr - 1; i++) for (j = 0; j < cols - 1; j++) {
      a = i * cols + j; b = a + 1; c = a + cols; d = c + 1;
      if (flip) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
    }
    if (opts.closeEnds && closed) {
      [0, nr - 1].forEach(function (ri, e) {
        var ring = R[ri], cc = cent[ri], other = cent[e === 0 ? 1 : nr - 2];
        var ax = [cc[0] - other[0], cc[1] - other[1], cc[2] - other[2]];
        if (vec3.length(ax) < 1e-9) return;
        vec3.normalize(ax, ax);
        // degenerate ring (all points ~ centroid) needs no cap
        var spread = 0; ring.forEach(function (q) { spread = Math.max(spread, vec3.distance(q, cc)); });
        if (spread < 1e-6) return;
        var base = pos.length / 3;
        pos.push(cc[0], cc[1], cc[2]); nrm.push(ax[0], ax[1], ax[2]); uv.push(0.5, 0.5);
        for (var j = 0; j < m; j++) { var q = ring[j]; pos.push(q[0], q[1], q[2]); nrm.push(ax[0], ax[1], ax[2]); uv.push(0.5 + (q[2] - cc[2]) * 0.5, 0.5 + (q[1] - cc[1]) * 0.5); }
        var st = idx.length;
        for (j = 0; j < m; j++) idx.push(base, base + 1 + j, base + 1 + (j + 1) % m);
        fixWinding(pos, nrm, idx, st);
      });
    }
    return finish(pos, nrm, uv, idx);
  }

  function computeNormalsRaw(P, I) {
    var N = new Float32Array(P.length);
    for (var t = 0; t + 2 < I.length; t += 3) {
      var a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      var ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      var vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; // area weighted
      N[a] += nx; N[a + 1] += ny; N[a + 2] += nz; N[b] += nx; N[b + 1] += ny; N[b + 2] += nz; N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
    }
    for (var i = 0; i < N.length; i += 3) {
      var l = Math.sqrt(N[i] * N[i] + N[i + 1] * N[i + 1] + N[i + 2] * N[i + 2]);
      if (l > 1e-20) { N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; } else { N[i] = 0; N[i + 1] = 1; N[i + 2] = 0; }
    }
    return N;
  }
  /** computeNormals(geo, opts{flat}) — area-weighted smooth vertex normals from the triangles (mutates + returns geo).
      flat: true de-indexes first so every triangle gets its face normal. */
  function computeNormals(geo, opts) {
    opts = opts || {};
    if (opts.flat) geo = toNonIndexed(geo);
    var P = geo.positions, I = geo.indices;
    if (!I || !I.length) { I = []; for (var i = 0; i < P.length / 3; i++) I.push(i); }
    geo.normals = computeNormalsRaw(P, I);
    return geo;
  }
  function toFlat(g) { return computeNormals(toNonIndexed(g)); }
  /** Expand indexed geometry to unique vertices per triangle corner (keeps uvs/colors). */
  function toNonIndexed(g) {
    var I = g.indices;
    if (!I || !I.length) return g;
    var cs = g.colors ? (g.colorSize || Math.round(g.colors.length / (g.positions.length / 3)) || 4) : 0;
    var n = I.length, P = new Float32Array(n * 3), Nn = g.normals ? new Float32Array(n * 3) : null, U = g.uvs ? new Float32Array(n * 2) : null, C = cs ? new Float32Array(n * cs) : null;
    for (var i = 0; i < n; i++) {
      var v = I[i];
      P[i * 3] = g.positions[v * 3]; P[i * 3 + 1] = g.positions[v * 3 + 1]; P[i * 3 + 2] = g.positions[v * 3 + 2];
      if (Nn) { Nn[i * 3] = g.normals[v * 3]; Nn[i * 3 + 1] = g.normals[v * 3 + 1]; Nn[i * 3 + 2] = g.normals[v * 3 + 2]; }
      if (U) { U[i * 2] = g.uvs[v * 2]; U[i * 2 + 1] = g.uvs[v * 2 + 1]; }
      if (C) for (var k = 0; k < cs; k++) C[i * cs + k] = g.colors[v * cs + k];
    }
    var out = { positions: P, normals: Nn || new Float32Array(n * 3), uvs: U || new Float32Array(n * 2), indices: idxArray(Array.from({ length: n }, function (_, i) { return i; }), n) };
    if (C) { out.colors = C; out.colorSize = cs; }
    return out;
  }

  /** Transform a geometry in place by a mat4 (normals by the inverse transpose; winding flipped on mirror). */
  function transform(g, m) {
    var P = g.positions, Nn = g.normals, nm = mat3.normalFromMat4(new Float32Array(9), m);
    var t = [0, 0, 0];
    for (var i = 0; i < P.length; i += 3) {
      t[0] = P[i]; t[1] = P[i + 1]; t[2] = P[i + 2]; vec3.transformMat4(t, t, m);
      P[i] = t[0]; P[i + 1] = t[1]; P[i + 2] = t[2];
      if (Nn && Nn.length === P.length) {
        t[0] = Nn[i]; t[1] = Nn[i + 1]; t[2] = Nn[i + 2]; vec3.transformMat3(t, t, nm); vec3.normalize(t, t);
        Nn[i] = t[0]; Nn[i + 1] = t[1]; Nn[i + 2] = t[2];
      }
    }
    if (mat4.determinant(m) < 0 && g.indices) for (i = 0; i + 2 < g.indices.length; i += 3) { var x = g.indices[i + 1]; g.indices[i + 1] = g.indices[i + 2]; g.indices[i + 2] = x; }
    return g;
  }

  /** Add/replace a per-vertex RGBA color (colorSize 4). */
  function colorize(g, color) {
    var n = g.positions.length / 3, c = color || [1, 1, 1, 1], C = new Float32Array(n * 4);
    for (var i = 0; i < n; i++) { C[i * 4] = c[0]; C[i * 4 + 1] = c[1]; C[i * 4 + 2] = c[2]; C[i * 4 + 3] = c.length > 3 ? c[3] : 1; }
    g.colors = C; g.colorSize = 4;
    return g;
  }

  /** merge(list) — list entries are geometries or {geometry|geo, transform|matrix (mat4), color ([r,g,b(,a)])}.
      Returns one geometry with positions/normals/uvs/colors (RGBA, colorSize 4, white default)/indices
      (Uint32 when > 65535 vertices). Mirrored transforms flip winding. */
  function merge(list) {
    var parts = [];
    (list || []).forEach(function (e) {
      if (!e) return;
      var g = e.positions ? e : (e.geometry || e.geo);
      if (!g || !g.positions || !g.positions.length) return;
      parts.push({ g: g, m: e.positions ? null : (e.transform || e.matrix || null), c: e.positions ? null : (e.color || null) });
    });
    var nv = 0, ni = 0;
    parts.forEach(function (p) { nv += p.g.positions.length / 3; ni += p.g.indices && p.g.indices.length ? p.g.indices.length : p.g.positions.length / 3; });
    var P = new Float32Array(nv * 3), Nn = new Float32Array(nv * 3), U = new Float32Array(nv * 2), C = new Float32Array(nv * 4);
    var I = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    var vo = 0, io = 0, t = [0, 0, 0], nm = new Float32Array(9);
    parts.forEach(function (p) {
      var g = p.g, n = g.positions.length / 3, m = p.m;
      if (m) mat3.normalFromMat4(nm, m);
      var gn = g.normals && g.normals.length === g.positions.length ? g.normals : null;
      if (!gn) gn = computeNormalsRaw(g.positions, g.indices && g.indices.length ? g.indices : Array.from({ length: n }, function (_, i) { return i; }));
      var cs = g.colors && g.colors.length ? (g.colorSize || Math.round(g.colors.length / n) || 4) : 0;
      for (var i = 0; i < n; i++) {
        t[0] = g.positions[i * 3]; t[1] = g.positions[i * 3 + 1]; t[2] = g.positions[i * 3 + 2];
        if (m) vec3.transformMat4(t, t, m);
        P[(vo + i) * 3] = t[0]; P[(vo + i) * 3 + 1] = t[1]; P[(vo + i) * 3 + 2] = t[2];
        t[0] = gn[i * 3]; t[1] = gn[i * 3 + 1]; t[2] = gn[i * 3 + 2];
        if (m) { vec3.transformMat3(t, t, nm); vec3.normalize(t, t); }
        Nn[(vo + i) * 3] = t[0]; Nn[(vo + i) * 3 + 1] = t[1]; Nn[(vo + i) * 3 + 2] = t[2];
        if (g.uvs && g.uvs.length >= n * 2) { U[(vo + i) * 2] = g.uvs[i * 2]; U[(vo + i) * 2 + 1] = g.uvs[i * 2 + 1]; }
        var r = 1, gg = 1, b = 1, a = 1;
        if (cs) { r = g.colors[i * cs]; gg = g.colors[i * cs + 1]; b = g.colors[i * cs + 2]; a = cs > 3 ? g.colors[i * cs + 3] : 1; }
        if (p.c) { r *= p.c[0]; gg *= p.c[1]; b *= p.c[2]; a *= p.c.length > 3 ? p.c[3] : 1; }
        C[(vo + i) * 4] = r; C[(vo + i) * 4 + 1] = gg; C[(vo + i) * 4 + 2] = b; C[(vo + i) * 4 + 3] = a;
      }
      var flip = m && mat4.determinant(m) < 0;
      if (g.indices && g.indices.length) {
        for (i = 0; i < g.indices.length; i += 3) {
          I[io++] = g.indices[i] + vo;
          if (flip) { I[io++] = g.indices[i + 2] + vo; I[io++] = g.indices[i + 1] + vo; }
          else { I[io++] = g.indices[i + 1] + vo; I[io++] = g.indices[i + 2] + vo; }
        }
      } else {
        for (i = 0; i < n; i += 3) { I[io++] = vo + i; I[io++] = vo + (flip ? i + 2 : i + 1); I[io++] = vo + (flip ? i + 1 : i + 2); }
      }
      vo += n;
    });
    return { positions: P, normals: Nn, uvs: U, colors: C, colorSize: 4, indices: I };
  }

  /** Axis-aligned bounds + bounding sphere of a position array. */
  function computeBounds(positions) {
    var P = positions && positions.positions ? positions.positions : positions;
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i + 2 < (P ? P.length : 0); i += 3) {
      for (var c = 0; c < 3; c++) { var v = P[i + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
    }
    if (mn[0] === Infinity) return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 0, empty: true };
    var ce = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2], r2 = 0;
    for (i = 0; i + 2 < P.length; i += 3) {
      var dx = P[i] - ce[0], dy = P[i + 1] - ce[1], dz = P[i + 2] - ce[2], d = dx * dx + dy * dy + dz * dz;
      if (d > r2) r2 = d;
    }
    return { min: mn, max: mx, center: ce, radius: Math.sqrt(r2) };
  }

  var geometry = {
    box: box, roundedBox: roundedBox, cylinder: cylinder, cone: cone, torus: torus, sphere: sphere, plane: plane, disc: disc,
    extrudeProfile: extrudeProfile, tube: tube, lathe: lathe, loft: loft, merge: merge,
    computeNormals: computeNormals, transform: transform, colorize: colorize, computeBounds: computeBounds,
    toNonIndexed: toNonIndexed, triangulate2D: triangulate2D, signedArea2D: signedArea2D, fixWinding: fixWinding
  };

  /* ======================================================================
     GLSL preprocessor: shaders are written once in a GLSL ES 1.0 flavoured dialect (attribute / varying /
     texture2D / gl_FragColor) and rewritten to GLSL ES 3.00 on WebGL2. Code that only makes sense on one
     version is fenced with #ifdef WEBGL2 / WEBGL1. Defines are injected after the version line.
     ====================================================================== */
  var ATTRIB_LOCATIONS = {
    aPos: 0, aNormal: 1, aUv: 2, aColor: 3,
    aInstM0: 4, aInstM1: 5, aInstM2: 6, aInstM3: 7, aInstColor: 8,
    aParams: 1, aCorner: 2
  };
  function definesBlock(defines) {
    var out = '';
    if (!defines) return out;
    for (var k in defines) {
      if (!Object.prototype.hasOwnProperty.call(defines, k)) continue;
      var v = defines[k];
      if (v === false || v === null || v === undefined) continue;
      out += '#define ' + k + (v === true ? '' : ' ' + v) + '\n';
    }
    return out;
  }
  /**
   * preprocess(src, stage 'vertex'|'fragment', {isWebGL2, defines, derivatives}) -> GLSL string.
   * WebGL2: '#version 300 es', attribute->in, varying->out/in, texture2D/textureCube->texture,
   *         texture2DLodEXT->textureLod, gl_FragColor->forge_FragColor (declared out), #extension lines dropped.
   * WebGL1: optional GL_OES_standard_derivatives (defines HAS_DERIVATIVES), mediump fallback precision.
   */
  function preprocess(src, stage, opts) {
    opts = opts || {};
    var gl2 = !!opts.isWebGL2, frag = stage === 'fragment' || stage === 'fs' || stage === 'frag';
    var head = '', body = String(src || '');
    // strip any user #version line
    body = body.replace(/^\s*#version[^\n]*\n/, '');
    if (gl2) {
      head += '#version 300 es\n#define WEBGL2 1\n#define HAS_DERIVATIVES 1\n';
      head += definesBlock(opts.defines);
      if (frag) head += 'precision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision mediump sampler2DShadow;\nout vec4 forge_FragColor;\n';
      else head += 'precision highp float;\nprecision highp int;\n';
      body = body.replace(/^\s*#extension[^\n]*$/gm, '');
      body = body.replace(/\battribute\b/g, 'in');
      body = body.replace(/\bvarying\b/g, frag ? 'in' : 'out');
      body = body.replace(/\btexture2DLodEXT\b/g, 'textureLod');
      body = body.replace(/\btexture2D\b/g, 'texture');
      body = body.replace(/\btextureCube\b/g, 'texture');
      body = body.replace(/\bgl_FragColor\b/g, 'forge_FragColor');
    } else {
      if (frag && opts.derivatives) head += '#extension GL_OES_standard_derivatives : enable\n';
      head += '#define WEBGL1 1\n';
      if (frag && opts.derivatives) head += '#define HAS_DERIVATIVES 1\n';
      head += definesBlock(opts.defines);
      if (frag) head += '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\nprecision highp int;\n#else\nprecision mediump float;\nprecision mediump int;\n#endif\n';
      else head += 'precision highp float;\n';
      body = body.replace(/^\s*#extension[^\n]*$/gm, '');
    }
    return head + body;
  }

  /* ======================================================================
     Shader library (shared chunks)
     ====================================================================== */
  var CHUNK_COMMON = [
    'const float PI = 3.14159265359;',
    'float saturate(float x) { return clamp(x, 0.0, 1.0); }',
    'vec3 saturate3(vec3 x) { return clamp(x, 0.0, 1.0); }',
    'float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }',
    'float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }',
    'vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }',
    'float vnoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y); }',
    '/* exact sRGB transfer functions (piecewise, IEC 61966-2-1) */',
    'vec3 srgbToLinear(vec3 c) { c = max(c, vec3(0.0)); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }',
    'vec3 linearToSrgb(vec3 c) { c = max(c, vec3(0.0)); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }',
    'vec3 acesFilm(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }',
    'vec3 outputColor(vec3 c, float linearOut, float exposure) {',
    '  if (linearOut > 0.5) return c;',
    '  return linearToSrgb(acesFilm(c * exposure));',
    '}',
    'float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }'
  ].join('\n');

  /* procedural environment used for reflections / fresnel (sky gradient + soft treeline silhouettes + sun glow) */
  var CHUNK_ENV = [
    'uniform vec3 uEnvTop; uniform vec3 uEnvHorizon; uniform vec3 uEnvBottom;',
    'vec3 envGradient(vec3 d) {',
    '  float y = d.y;',
    '  vec3 sky = mix(uEnvHorizon, uEnvTop, pow(saturate(y), 0.55));',
    '  vec3 gnd = mix(uEnvHorizon * 0.6 + uEnvBottom * 0.4, uEnvBottom, pow(saturate(-y), 0.35));',
    '  return y >= 0.0 ? sky : gnd;',
    '}',
    'vec3 envColor(vec3 d, float rough, vec3 sunDir, vec3 sunColor) {',
    '  vec3 base = envGradient(d);',
    '  // fake trackside skyline: trees / stands / buildings as a dark band just above the horizon',
    '  float az = atan(d.z, d.x);',
    '  float h = 0.035 + 0.075 * vnoise(vec2(az * 7.0, 1.3)) + 0.05 * vnoise(vec2(az * 23.0, 7.1));',
    '  float w = 0.004 + rough * 0.12;',
    '  float band = (1.0 - smoothstep(h - w, h + w, d.y)) * smoothstep(-0.06 - w, 0.0, d.y);',
    '  vec3 sil = mix(uEnvBottom, uEnvHorizon, 0.35) * 0.55;',
    '  base = mix(base, sil, band * 0.85 * (1.0 - rough * 0.6));',
    '  // sun glow in the reflection (wider + dimmer with roughness)',
    '  float sd = max(dot(d, sunDir), 0.0);',
    '  float glowPow = mix(900.0, 6.0, rough);',
    '  base += sunColor * pow(sd, glowPow) * mix(3.0, 0.15, rough) * step(0.0, sunDir.y + 0.05);',
    '  // roughness pre-filter approximation: converge to the hemisphere average',
    '  vec3 avg = mix(uEnvBottom, mix(uEnvHorizon, uEnvTop, 0.5), saturate(d.y * 0.5 + 0.5));',
    '  return mix(base, avg, rough * rough * 0.85);',
    '}'
  ].join('\n');

  var CHUNK_BRDF = [
    'float D_GGX(float NoH, float a) { float a2 = a * a; float f = (NoH * a2 - NoH) * NoH + 1.0; return a2 / (PI * f * f + 1e-7); }',
    'float V_SmithFast(float NoV, float NoL, float a) { return 0.5 / max(mix(2.0 * NoL * NoV, NoL + NoV, a), 1e-5); }',
    'vec3 F_Schlick(vec3 F0, float VoH) { float f = pow(1.0 - VoH, 5.0); return F0 + (vec3(1.0) - F0) * f; }',
    'float F_Schlick1(float F0, float VoH) { return F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0); }',
    'vec3 envBRDFApprox(vec3 F0, float rough, float NoV) {',
    '  vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022); vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);',
    '  vec4 r = rough * c0 + c1;',
    '  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;',
    '  vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw;',
    '  return F0 * AB.x + AB.y;',
    '}',
    'vec2 envBRDFApproxAB(float rough, float NoV) {',
    '  vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022); vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);',
    '  vec4 r = rough * c0 + c1;',
    '  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;',
    '  return vec2(-1.04, 1.04) * a004 + r.zw;',
    '}',
    '/* anisotropic GGX (Burley) + height-correlated Smith visibility (Heitz); at / ab = alpha along tangent / bitangent */',
    'float D_GGXAniso(float NoH, float ToH, float BoH, float at, float ab) {',
    '  float a2 = at * ab; vec3 d = vec3(ab * ToH, at * BoH, a2 * NoH); float d2 = dot(d, d);',
    '  float b2 = a2 / max(d2, 1e-7); return a2 * b2 * b2 / PI;',
    '}',
    'float V_SmithAniso(float at, float ab, float ToV, float BoV, float ToL, float BoL, float NoV, float NoL) {',
    '  float lV = NoL * length(vec3(at * ToV, ab * BoV, NoV)); float lL = NoV * length(vec3(at * ToL, ab * BoL, NoL));',
    '  return 0.5 / max(lV + lL, 1e-5);',
    '}',
    'float V_Kelemen(float LoH) { return 0.25 / max(LoH * LoH, 1e-4); }',
    '/* specular occlusion from ambient occlusion (Lagarde & de Rousiers) */',
    'float specOcclusion(float NoV, float ao, float a) { return saturate(pow(NoV + ao, exp2(-16.0 * a - 1.0)) - 1.0 + ao); }',
    'vec3 hueRotate(vec3 c, float ang) {',
    '  vec3 k = vec3(0.57735); float cs = cos(ang);',
    '  return c * cs + cross(k, c) * sin(ang) + k * dot(k, c) * (1.0 - cs);',
    '}'
  ].join('\n');

  var CHUNK_SHADOW = [
    'uniform float uUseShadow; uniform mat4 uShadowMatrix; uniform vec4 uShadowParams;',
    '#ifdef SHADOW_HW',
    'uniform sampler2DShadow uShadowMap;',
    '#else',
    'uniform sampler2D uShadowMap;',
    'float unpackDepth(vec4 c) { return dot(c, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0)); }',
    'float shadowTap(vec2 uv, float d) { return step(d, unpackDepth(texture2D(uShadowMap, uv))); }',
    '#endif',
    '/* returns 1 = lit, 0 = shadowed. uShadowParams = (texel, depthBias, normalBias, strength) */',
    'float farShadow(vec3 wp, vec3 N, float NoL) {',
    '  if (uUseShadow < 0.5) return 1.0;',
    '  vec3 p = wp + N * (uShadowParams.z * (1.5 - NoL));',
    '  vec4 sc = uShadowMatrix * vec4(p, 1.0);',
    '  vec3 c = sc.xyz / sc.w;',
    '  if (c.x <= 0.0 || c.x >= 1.0 || c.y <= 0.0 || c.y >= 1.0 || c.z >= 1.0) return 1.0;',
    '  float d = c.z - uShadowParams.y;',
    '  float t = uShadowParams.x;',
    '  float s = 0.0;',
    '#ifdef SHADOW_HW',
    '  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) s += texture(uShadowMap, vec3(c.xy + vec2(float(i), float(j)) * t * 1.25, d));',
    '  s /= 9.0;',
    '#else',
    '  vec2 f = fract(c.xy / t + 0.5);',
    '  vec2 b = (floor(c.xy / t + 0.5) - 0.5) * t;',
    '  // 2x2 bilinear PCF taps (16 fetches) spread over a 3x3 texel footprint',
    '  for (int i = 0; i < 2; i++) for (int j = 0; j < 2; j++) {',
    '    vec2 o = b + (vec2(float(i), float(j)) * 2.0 - 1.0) * t;',
    '    float s00 = shadowTap(o, d), s10 = shadowTap(o + vec2(t, 0.0), d), s01 = shadowTap(o + vec2(0.0, t), d), s11 = shadowTap(o + vec2(t, t), d);',
    '    s += mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);',
    '  }',
    '  s *= 0.25;',
    '#endif',
    '  vec2 e = abs(c.xy * 2.0 - 1.0);',
    '  float fade = smoothstep(0.82, 0.98, max(e.x, e.y));',
    '  return mix(1.0, mix(s, 1.0, fade), uShadowParams.w);',
    '}',
    /* near cascade (WebGL2): a tight sun map around the camera target (the cars) with PCSS contact hardening —
       8-tap blocker search on the raw depth (sampler object, compare off) -> penumbra from the blocker distance and
       the sun's (exaggerated) angular size -> 12-tap golden-spiral hardware-PCF. uShadowNearSoft = (penumbra
       texels per metre of receiver-blocker distance, max radius texels, depth range m, min radius texels). */
    '#ifdef SHADOW_HW',
    'uniform float uUseShadowNear; uniform mat4 uShadowNearMatrix; uniform vec4 uShadowNearParams; uniform vec4 uShadowNearSoft;',
    'uniform sampler2DShadow uShadowNear; uniform sampler2D uShadowNearRaw;',
    'float nearShadow(vec3 wp, vec3 N, float NoL, out float w) {',
    '  w = 0.0;',
    '  if (uUseShadowNear < 0.5) return 1.0;',
    '  vec3 p = wp + N * (uShadowNearParams.z * (1.5 - NoL));',
    '  vec4 sc = uShadowNearMatrix * vec4(p, 1.0);',
    '  vec3 c = sc.xyz / sc.w;',
    '  vec2 e = abs(c.xy * 2.0 - 1.0);',
    '  float m = max(e.x, e.y);',
    '  if (m >= 0.97 || c.z >= 1.0) return 1.0;',
    '  w = 1.0 - smoothstep(0.78, 0.95, m);',
    '  float d = c.z - uShadowNearParams.y;',
    '  float t = uShadowNearParams.x;',
    '  float sr = uShadowNearSoft.y * t;',
    '  float bs = 0.0; float bn = 0.0;',
    '  for (int i = 0; i < 8; i++) {',
    '    float fi = float(i); float a = fi * 2.39996 + 0.6; float r = sqrt((fi + 0.5) / 8.0) * sr;',
    '    float z = textureLod(uShadowNearRaw, c.xy + vec2(cos(a), sin(a)) * r, 0.0).r;',
    '    if (z < d) { bs += z; bn += 1.0; }',
    '  }',
    '  if (bn < 0.5) return 1.0;',
    '  float db = bs / bn;',
    '  float pr = clamp((d - db) * uShadowNearSoft.z * uShadowNearSoft.x, uShadowNearSoft.w, uShadowNearSoft.y) * t;',
    '  float s = 0.0;',
    '  for (int i = 0; i < 12; i++) {',
    '    float fi = float(i); float a = fi * 2.39996; float r = sqrt((fi + 0.5) / 12.0) * pr;',
    '    s += texture(uShadowNear, vec3(c.xy + vec2(cos(a), sin(a)) * r, d));',
    '  }',
    '  s /= 12.0;',
    '  return mix(1.0, s, uShadowNearParams.w);',
    '}',
    '#endif',
    'float sunShadow(vec3 wp, vec3 N, float NoL) {',
    '#ifdef SHADOW_HW',
    '  float wN; float sN = nearShadow(wp, N, NoL, wN);',
    '  if (wN > 0.999) return sN;',
    '  if (wN > 0.0) return mix(farShadow(wp, N, NoL), sN, wN);',
    '#endif',
    '  return farShadow(wp, N, NoL);',
    '}'
  ].join('\n');

  /* ---------------- standard (lit) */
  var STANDARD_VS = [
    'attribute vec3 aPos; attribute vec3 aNormal; attribute vec2 aUv; attribute vec4 aColor;',
    '#ifdef INSTANCED',
    'attribute vec4 aInstM0; attribute vec4 aInstM1; attribute vec4 aInstM2; attribute vec4 aInstM3;',
    '#ifndef NO_INST_COLOR',
    'attribute vec4 aInstColor;',
    '#endif',
    '#endif',
    'uniform mat4 uModel; uniform mat4 uView; uniform mat4 uProj; uniform mat3 uNormalMat; uniform vec4 uUvTransform;',
    'uniform vec4 uAnisoAxis;',
    'varying vec3 vWorld; varying vec3 vNormal; varying vec2 vUv; varying vec4 vColor; varying vec3 vLocal; varying float vViewZ; varying vec3 vAnisoT;',
    'void main() {',
    '  mat4 M = uModel; mat3 NM = uNormalMat;',
    '#ifdef INSTANCED',
    '  mat4 IM = mat4(aInstM0, aInstM1, aInstM2, aInstM3);',
    '  M = uModel * IM;',
    '  NM = uNormalMat * mat3(IM[0].xyz, IM[1].xyz, IM[2].xyz);',
    '#ifdef NO_INST_COLOR',
    '  vColor = aColor;',
    '#else',
    '  vColor = aColor * aInstColor;',
    '#endif',
    '  vLocal = aPos + IM[3].xyz * 0.37;',
    '#else',
    '  vColor = aColor;',
    '  vLocal = aPos;',
    '#endif',
    '  vec4 w = M * vec4(aPos, 1.0);',
    '  vWorld = w.xyz;',
    '  vNormal = NM * aNormal;',
    '  // circular brushing tangent around a local axis (wheels / discs); unused unless uAnisoAxis.w = 1',
    '  vAnisoT = uAnisoAxis.w > 0.5 ? mat3(M[0].xyz, M[1].xyz, M[2].xyz) * cross(uAnisoAxis.xyz, aPos) : vec3(0.0);',
    '  vUv = aUv * uUvTransform.xy + uUvTransform.zw;',
    '  vec4 vp = uView * w;',
    '  vViewZ = -vp.z;',
    '  gl_Position = uProj * vp;',
    '}'
  ].join('\n');

  /* environment probe: prefiltered cubemap (mip = sqrt(roughness) * uEnvMapMaxLod) with the procedural env as fallback;
     optional 9-coefficient SH irradiance (premultiplied basis * cosine lobe / PI, see CB.gl.computeSH) */
  var CHUNK_PROBE = [
    'uniform samplerCube uEnvMap; uniform float uUseEnvMap; uniform float uEnvMapMaxLod; uniform float uEnvMapRGBM; uniform float uEnvMapIntensity;',
    'uniform vec3 uSH[9]; uniform float uUseSH;',
    // mip k of a probe holds roughness (k / maxLod)^2, so lod = maxLod * sqrt(rough): more mips for glossy coats
    'vec3 envSampleC(vec3 d, float rough, float lodCap, vec3 sunDir, vec3 sunColor) {',
    '  if (uUseEnvMap > 0.5) {',
    '    float lod = min(uEnvMapMaxLod * sqrt(saturate(rough)), lodCap);',
    '#ifdef WEBGL2',
    '    vec4 e = textureLod(uEnvMap, d, lod);',
    '#else',
    '    vec4 e = textureCube(uEnvMap, d, lod);',
    '#endif',
    '    vec3 c = uEnvMapRGBM > 0.5 ? e.rgb * e.a * 8.0 : e.rgb;',
    '    return c * uEnvMapIntensity;',
    '  }',
    '  return envColor(d, rough, sunDir, sunColor);',
    '}',
    'vec3 envSample(vec3 d, float rough, vec3 sunDir, vec3 sunColor) { return envSampleC(d, rough, 99.0, sunDir, sunColor); }',
    // ground parallax for the dynamic probe (captured ~1 m above the player car): downward reflections are re-aimed
    // at where the ray really meets the ground plane (uProbePos.w), so sills / doors / lower bumpers mirror the road
    // and kerbs right beside the car instead of the patch under the probe. Fades out away from the probe.
    'uniform vec4 uProbePos; uniform float uProbeParallax;',
    'vec3 probeDir(vec3 P, vec3 R) {',
    '  if (uProbeParallax < 0.5 || R.y > -0.02) return R;',
    '  float k = 1.0 - smoothstep(6.0, 14.0, length(P - uProbePos.xyz));',
    '  if (k <= 0.0) return R;',
    '  float t = min((uProbePos.w - P.y) / R.y, 80.0);',
    '  if (t <= 0.0) return R;',
    '  vec3 H = P + R * t - uProbePos.xyz;',
    '  return normalize(mix(R, normalize(H), k * (1.0 - smoothstep(40.0, 80.0, t))));',
    '}',
    'vec3 shIrradiance(vec3 n) {',
    '  vec3 r = uSH[0] + uSH[1] * n.y + uSH[2] * n.z + uSH[3] * n.x + uSH[4] * (n.x * n.y) + uSH[5] * (n.y * n.z)',
    '    + uSH[6] * (3.0 * n.z * n.z - 1.0) + uSH[7] * (n.x * n.z) + uSH[8] * (n.x * n.x - n.y * n.y);',
    '  return max(r, vec3(0.0));',
    '}'
  ].join('\n');

  /* ---------------- standard (lit) fragment
     Physically based: GGX D / Smith-GGX V (height-correlated approx) / Schlick F, multi-scatter energy
     compensation, energy-conserving diffuse (1 - F) / ambient (1 - envBRDF), clear coat layer (own roughness,
     Kelemen visibility, Fresnel-weighted base attenuation), stable object-space metallic flakes (resolved glints
     near the camera, energy-preserving lobe broadening once sub-pixel), optional anisotropy (uAnisotropy, tangent
     from UVs or circular around uAnisoAxis.xyz when uAnisoAxis.w = 1), prefiltered env cubemap + SH ambient,
     specular occlusion (AO map + horizon), metallic-roughness (G = roughness, B = metallic) / AO (R) / emissive
     (sRGB) map slots, HDR emissive. uMaterialType: 0 standard, 1 thin glass (two-interface Fresnel, reflections
     raise coverage), 2 rubber (low spec, dusty sheen; brighter uMap texels = smoother sidewall lettering). */
  var STANDARD_FS = [
    CHUNK_COMMON, CHUNK_ENV, CHUNK_BRDF, CHUNK_SHADOW, CHUNK_PROBE,
    'varying vec3 vWorld; varying vec3 vNormal; varying vec2 vUv; varying vec4 vColor; varying vec3 vLocal; varying float vViewZ; varying vec3 vAnisoT;',
    'uniform vec4 uBaseColor; uniform sampler2D uMap; uniform float uUseMap;',
    'uniform sampler2D uNormalMap; uniform float uUseNormalMap; uniform float uNormalScale;',
    'uniform sampler2D uRoughnessMap; uniform float uUseRoughnessMap; uniform sampler2D uAoMap; uniform float uUseAoMap; uniform float uAoStrength;',
    'uniform sampler2D uEmissiveMap; uniform float uUseEmissiveMap;',
    // large-scale macro variation sampled in WORLD xz (road asphaltMottle: breaks the visible repeat of the base tile)
    'uniform sampler2D uMottleMap; uniform vec4 uMottle;',
    'uniform float uMetallic; uniform float uRoughness; uniform float uClearcoat; uniform float uClearcoatRough;',
    'uniform float uFlake; uniform float uHueShift; uniform float uAlphaTest; uniform float uEnvIntensity; uniform float uReceiveShadow;',
    'uniform float uAnisotropy; uniform vec4 uAnisoAxis; uniform float uMaterialType;',
    'uniform vec3 uEmissive;',
    'uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uAmbientSky; uniform vec3 uAmbientGround;',
    'uniform vec3 uFogColor; uniform float uFogDensity; uniform vec3 uCamPos;',
    'uniform float uWetness; uniform float uExposure; uniform float uLinearOut; uniform float uTime; uniform float uBlendMode; uniform float uFogEnabled;',
    'uniform int uLightCount;',
    'uniform vec3 uLightPos[8]; uniform vec3 uLightDir[8]; uniform vec3 uLightColor[8]; uniform vec4 uLightParams[8];',
    '#ifdef HAS_DERIVATIVES',
    'vec3 perturbNormal(vec3 N, vec3 p, vec2 uv, vec3 mapN) {',
    '  vec3 dp1 = dFdx(p); vec3 dp2 = dFdy(p); vec2 duv1 = dFdx(uv); vec2 duv2 = dFdy(uv);',
    '  vec3 dp2perp = cross(dp2, N); vec3 dp1perp = cross(N, dp1);',
    '  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x; vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;',
    '  float invmax = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));',
    '  return normalize(mat3(T * invmax, B * invmax, N) * mapN);',
    '}',
    '#endif',
    'void main() {',
    '  vec4 base = uBaseColor * vColor;',
    '  if (uUseMap > 0.5) { vec4 t = texture2D(uMap, vUv); base *= vec4(srgbToLinear(t.rgb), t.a); }',
    '  if (base.a < uAlphaTest) discard;',
    '  bool isGlass = uMaterialType > 0.5 && uMaterialType < 1.5;',
    '  bool isRubber = uMaterialType > 1.5;',
    '  vec3 V = normalize(uCamPos - vWorld);',
    '  vec3 Ng = normalize(vNormal);',
    '  if (!gl_FrontFacing) Ng = -Ng;',
    '  vec3 N = Ng;',
    '#ifdef HAS_DERIVATIVES',
    '  if (uUseNormalMap > 0.5) {',
    '    vec3 mn = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0;',
    '    mn.xy *= uNormalScale;',
    '    N = perturbNormal(N, vWorld, vUv, normalize(mn));',
    '  }',
    '#endif',
    '  float metallic = saturate(uMetallic);',
    '  float rough = clamp(uRoughness, 0.03, 1.0);',
    '  float ao = 1.0;',
    '  if (uUseRoughnessMap > 0.5) { vec4 rm = texture2D(uRoughnessMap, vUv); rough = clamp(rough * rm.g, 0.03, 1.0); metallic *= rm.b; }',
    '  if (uUseAoMap > 0.5) ao = mix(1.0, texture2D(uAoMap, vUv).r, uAoStrength);',
    '  vec3 albedo = base.rgb;',
    '  if (uMottle.y > 0.0) { vec4 mo = texture2D(uMottleMap, vWorld.xz * uMottle.x + uMottle.zw); albedo *= mix(1.0 - 0.16 * uMottle.y, 1.0 + 0.16 * uMottle.y, mo.r) * (1.0 - 0.12 * uMottle.y * mo.b); rough = clamp(rough + ((mo.g - 0.5) * 0.12 - 0.05 * mo.b) * uMottle.y, 0.03, 1.0); }',
    '  float cc = saturate(uClearcoat); float flakeIn = uFlake; float envScale = 1.0; float sheen = 0.0;',
    '  if (isGlass) { metallic = 0.0; cc = 0.0; flakeIn = 0.0; }',
    '  if (isRubber) {',
    '    // vulcanised rubber: dielectric, broad dull lobe; moulded sidewall lettering (lighter rubber texels) is smoother',
    '    float letter = uUseMap > 0.5 ? smoothstep(0.012, 0.026, luma(albedo)) : 0.0;',
    '    metallic = 0.0; cc = 0.0; flakeIn = 0.0;',
    '    rough = mix(max(rough, 0.62), 0.42, letter);',
    '    envScale = mix(0.45, 0.6, letter); sheen = 0.07 * (1.0 - letter);',
    '  }',
    '  float NoV0 = saturate(dot(N, V));',
    '  // chameleon: hue rotates toward grazing angles; pearl / candy (small shifts) only a hint right at the silhouette',
    '  // (a red pearl must stay red, not drift to salmon across the panel)',
    '  if (abs(uHueShift) > 0.0001) {',
    '    float hsA = abs(uHueShift) < 0.1 ? clamp(uHueShift, -0.015, 0.015) * pow(1.0 - NoV0, 3.0) : uHueShift * pow(1.0 - NoV0, 1.4);',
    '    albedo = max(hueRotate(albedo, hsA * 6.2831853), vec3(0.0));',
    '  }',
    '  // clear-coated paint gets deeper toward the silhouette (absorption through a longer coat path)',
    '  if (cc > 0.0) albedo *= mix(1.0, 0.82, cc * (1.0 - NoV0) * (1.0 - NoV0));',
    '  float ccRough = clamp(uClearcoatRough, 0.03, 1.0);',
    '  // wet surfaces: darkened albedo, glossy puddles on up-facing areas. Clear-coated paint instead turns glossier',
    '  // (water film levels the coat) and carries rain beads on up-facing panels.',
    '  float wet = 0.0; float puddle = 0.0; float beadGlint = 0.0;',
    '  if (uWetness > 0.001) {',
    '    float up = smoothstep(0.55, 0.95, Ng.y);',
    '    bool paintWet = cc > 0.5;',
    '    float nz = vnoise(vWorld.xz * 0.16) * 0.65 + vnoise(vWorld.xz * 0.85 + 3.7) * 0.35;',
    '    puddle = paintWet ? 0.0 : smoothstep(0.5, 0.72, nz) * up * saturate(uWetness * 1.4 - 0.2);',
    '    wet = saturate(uWetness) * mix(0.25, 1.0, up);',
    '    if (paintWet) {',
    '      ccRough = 0.03;',
    '      vec2 bp = vLocal.xz * 90.0; vec2 bc = floor(bp); vec2 bo = vec2(hash12(bc + 5.3), hash12(bc + 11.7)) * 0.4 + 0.3;',
    '      vec2 bf = fract(bp) - bo; float br = 0.18 + 0.14 * hash12(bc + 2.1);',
    '#ifdef HAS_DERIVATIVES',
    '      float beadLod = 1.0 - smoothstep(0.25, 0.7, length(fwidth(vLocal)) * 90.0);',
    '#else',
    '      float beadLod = 1.0 - smoothstep(3.0, 9.0, vViewZ);',
    '#endif',
    // sparse beads (not a speckle over the whole panel), faded out beyond ~4-12 m: each a lens (bent normal), a
    // slightly darker refracted core and one tight sun glint (below)
    '      float beads = step(0.96, hash12(bc + 7.9)) * smoothstep(br, br * 0.75, length(bf)) * up * saturate(uWetness) * beadLod * (1.0 - smoothstep(4.0, 12.0, vViewZ));',
    '      if (beads > 0.0) { N = normalize(N + vec3(bf.x, 0.0, bf.y) / br * 0.5 * beads); albedo *= 1.0 - 0.35 * beads * smoothstep(br * 0.6, 0.0, length(bf)); beadGlint = beads; }',
    '    } else {',
    '      albedo *= mix(1.0, 0.5, wet * (1.0 - metallic) * (0.6 + 0.4 * up));',
    '    }',
    '    rough = mix(rough, 0.18, wet * up * 0.75);',
    '    rough = mix(rough, 0.035, puddle);',
    '    N = normalize(mix(N, Ng, puddle));',
    '    // rain ripples in puddles',
    '    if (puddle > 0.05) {',
    '      vec2 rp = vWorld.xz * 3.0; vec2 cell = floor(rp); vec2 fr = fract(rp) - 0.5;',
    '      float ph = fract(uTime * 0.9 + hash12(cell)); float rr = length(fr);',
    '      float ring = sin((rr - ph * 0.5) * 60.0) * (1.0 - ph) * smoothstep(0.5, 0.0, rr) * step(rr, ph * 0.5 + 0.05);',
    '      N = normalize(N + vec3(fr.x, 0.0, fr.y) * ring * 0.35 * puddle * saturate(uWetness));',
    '    }',
    '  }',
    '#ifdef HAS_DERIVATIVES',
    '  // geometric specular anti-aliasing (Kaplanyan / Tokuyoshi): widen lobes by the screen-space normal variance',
    '  // (the clear coat only a little, so curved panels keep crisp reflections)',
    '  vec3 dndu = dFdx(N); vec3 dndv = dFdy(N);',
    '  float variance = 0.25 * (dot(dndu, dndu) + dot(dndv, dndv));',
    '  float kr = min(2.0 * variance, 0.18);',
    '  float krc = min(2.0 * variance, 0.03);',
    '  rough = sqrt(sqrt(clamp(rough * rough * rough * rough + kr, 0.0, 1.0)));',
    '  ccRough = sqrt(sqrt(clamp(ccRough * ccRough * ccRough * ccRough + krc, 0.0, 1.0)));',
    '#endif',
    '  float a = rough * rough;',
    '  float ca = ccRough * ccRough;',
    '  // metallic flakes under the clear coat: object-space ~4 mm cells so they stick to the car. Resolved flakes',
    '  // tilt the base normal and glint when their own normal meets the half vector (view dependent, time-stable);',
    '  // once a pixel covers several cells they are replaced by a slightly broader, brighter lobe (no aliasing).',
    '  vec3 Nf = N; vec3 flakeN = N; float sparkle = 0.0;',
    '  float flakeAmt = flakeIn * (1.0 - smoothstep(6.0, 40.0, vViewZ));',
    '#ifdef HAS_DERIVATIVES',
    '  float flakeLod = smoothstep(0.12, 0.4, length(fwidth(vLocal)) * 260.0);',
    '#else',
    '  float flakeLod = smoothstep(2.0, 7.0, vViewZ);',
    '#endif',
    '  if (flakeIn > 0.001) {',
    '    float fres = flakeAmt * (1.0 - flakeLod);',
    '    if (fres > 0.001) {',
    '      vec3 cell = floor(vLocal * 260.0);',
    '      vec3 rnd = hash33(cell) * 2.0 - 1.0;',
    '      Nf = normalize(N + rnd * 0.22 * fres);',
    '      flakeN = normalize(N + rnd * 0.5);',
    // sparse (10 %) glints, faded out well before a cell drops under a pixel; the twinkle depends on the view
    // direction only, so a still frame is stable and an orbit makes individual flakes flash
    '      sparkle = step(0.9, hash13(cell + 17.0)) * flakeAmt * (1.0 - flakeLod) * (1.0 - flakeLod) * (0.5 + 0.5 * sin(dot(rnd, V) * 40.0));',
    '    }',
    '    a = mix(a, min(1.0, a + 0.035), flakeIn * flakeLod);',
    '  }',
    '  vec3 diffC = albedo * (1.0 - metallic);',
    '  vec3 F0 = mix(vec3(isRubber ? 0.035 : 0.04), albedo, metallic);',
    '  float NoV = max(dot(N, V), 1e-4);',
    '  vec2 AB = envBRDFApproxAB(rough, NoV);',
    '  vec3 envB = F0 * AB.x + AB.y;',
    '  // multi-scatter energy compensation: rough metals keep their energy instead of darkening',
    '  vec3 energyComp = vec3(1.0) + F0 * (1.0 / max(AB.x + AB.y, 0.05) - 1.0);',
    '  // anisotropy frame (brushed metal)',
    '  float aniso = (isGlass || isRubber) ? 0.0 : clamp(uAnisotropy, -0.95, 0.95);',
    '  vec3 Ta = vec3(1.0, 0.0, 0.0); vec3 Ba = vec3(0.0, 0.0, 1.0); bool hasAniso = abs(aniso) > 0.01;',
    '  if (hasAniso) {',
    '    vec3 t0 = vAnisoT;',
    '#ifdef HAS_DERIVATIVES',
    '    if (uAnisoAxis.w < 0.5) { vec3 dp1 = dFdx(vWorld); vec3 dp2 = dFdy(vWorld); vec2 duv1 = dFdx(vUv); vec2 duv2 = dFdy(vUv); t0 = dp1 * duv2.y - dp2 * duv1.y; }',
    '#endif',
    '    vec3 tp = t0 - N * dot(N, t0); float tl = length(tp);',
    '    if (tl < 1e-6) hasAniso = false; else { Ta = tp / tl; Ba = cross(N, Ta); }',
    '  }',
    '  float at = max(a * (1.0 + aniso), 0.002); float ab = max(a * (1.0 - aniso), 0.002);',
    '  vec3 L = normalize(uSunDir);',
    '  float NoL = saturate(dot(N, L));',
    '  float NgoL = dot(Ng, L);',
    '  float sh = 1.0;',
    '  if (uReceiveShadow > 0.5) sh = sunShadow(vWorld, Ng, saturate(NgoL));',
    '  sh *= smoothstep(-0.05, 0.08, NgoL) * 0.85 + 0.15 * step(0.0, NgoL);',
    '  vec3 diffuse = vec3(0.0); vec3 spec = vec3(0.0);',
    '  // --- sun',
    '  if (NoL > 0.0) {',
    '    vec3 H = normalize(L + V);',
    '    float NoH = saturate(dot(Nf, H)); float VoH = saturate(dot(V, H));',
    '    float NfoL = saturate(dot(Nf, L));',
    '    vec3 F = F_Schlick(F0, VoH);',
    '    float DV;',
    '    if (hasAniso) DV = D_GGXAniso(saturate(dot(N, H)), dot(Ta, H), dot(Ba, H), at, ab) * V_SmithAniso(at, ab, dot(Ta, V), dot(Ba, V), dot(Ta, L), dot(Ba, L), NoV, NoL);',
    '    else DV = D_GGX(NoH, a) * V_SmithFast(NoV, NfoL, a);',
    '    vec3 sp = DV * F * PI * energyComp;',
    '    if (sparkle > 0.0) sp += mix(F0, vec3(1.0), 0.25) * sparkle * pow(saturate(dot(flakeN, H)), 600.0) * 14.0;',
    '    if (beadGlint > 0.0) sp += vec3(beadGlint * pow(saturate(dot(N, H)), 2000.0) * 8.0);',
    '    vec3 radiance = uSunColor * sh;',
    '    diffuse += diffC * (vec3(1.0) - F) * radiance * NoL;',
    '    spec += sp * radiance * (hasAniso ? NoL : NfoL);',
    '    if (cc > 0.0) {',
    '      float cNoH = saturate(dot(N, H));',
    '      float Fc = F_Schlick1(0.04, VoH) * cc;',
    '      spec = spec * (1.0 - Fc) + vec3(D_GGX(cNoH, ca) * V_Kelemen(VoH) * Fc * PI) * radiance * NoL;',
    '      diffuse *= (1.0 - Fc);',
    '    }',
    '  }',
    '  // --- point / spot lights (headlights, lamp posts)',
    '  for (int i = 0; i < 8; i++) {',
    '    if (i >= uLightCount) break;',
    '    vec4 P = uLightParams[i];',
    '    if (P.w < -0.5) continue;',
    '    vec3 dl = uLightPos[i] - vWorld; float dist = length(dl); vec3 l = dl / max(dist, 0.001);',
    // windowed inverse-square falloff (Karis), normalised to the old linear-window level at 20 m (or half the
    // range) so the overall light pools keep their tuning; capped so near surfaces do not blow out, and capped
    // lower on clear-coated paint so a car lit from behind keeps its shape
    '    float rng = max(P.x, 0.1); float dr = dist / rng; float w = saturate(1.0 - dr * dr * dr * dr);',
    '    float dref = min(20.0, 0.5 * rng); float rr = dref / rng; float wref = 1.0 - rr * rr * rr * rr;',
    '    float att = w * w / (dist * dist + 1.0) * (1.0 - rr) * (1.0 - rr) * (dref * dref + 1.0) / max(wref * wref, 1e-3);',
    '    att = min(att, cc > 0.5 ? 0.55 : 0.9);',
    '    if (P.w > 0.5) {',
    '      att *= smoothstep(P.z, P.y, dot(-l, normalize(uLightDir[i])));',
    '      // near-field soften: headlights meet car tails / walls 2-5 m away head-on but the road at a glancing',
    '      // angle; without this the close surfaces blow out while the road stays dim',
    '      att *= smoothstep(0.0, 4.0, dist) * 0.6 + 0.4;',
    '    }',
    '    if (att <= 0.0) continue;',
    '    float nl = saturate(dot(N, l));',
    '    vec3 h = normalize(l + V);',
    '    float nh = saturate(dot(Nf, h)); float vh = saturate(dot(V, h));',
    '    vec3 Fl = F_Schlick(F0, vh);',
    '    vec3 rad = uLightColor[i] * att;',
    '    float al = max(a, 0.02);',
    '    float cFl = cc * F_Schlick1(0.04, vh);',
    '    diffuse += diffC * (vec3(1.0) - Fl) * rad * nl * (1.0 - cFl);',
    '    spec += D_GGX(nh, al) * V_SmithFast(NoV, nl, al) * Fl * energyComp * PI * rad * nl * (1.0 - cFl);',
    '    if (cc > 0.0) spec += vec3(D_GGX(saturate(dot(N, h)), ca) * V_Kelemen(vh) * cFl * PI) * rad * nl;',
    '    // wet road: stretched light reflections',
    '    if (wet > 0.0) { vec3 R0 = reflect(-V, N); spec += rad * wet * 0.22 * pow(saturate(dot(R0, l)), 16.0) * (0.4 + puddle); }',
    '  }',
    '  // --- ambient (SH irradiance or sky / ground hemisphere), energy-conserving against the specular layer',
    '  vec3 amb = uUseSH > 0.5 ? shIrradiance(N) : mix(uAmbientGround, uAmbientSky, N.y * 0.5 + 0.5);',
    '  diffuse += diffC * amb * (vec3(1.0) - envB) * ao;',
    '  if (sheen > 0.0) diffuse += amb * sheen * pow(1.0 - NoV, 3.0) * ao;',
    '  // --- environment reflections',
    '  vec3 R = reflect(-V, Nf);',
    '  if (hasAniso) {',
    '    vec3 adir = aniso >= 0.0 ? Ba : Ta;',
    '    vec3 aT = cross(adir, V); vec3 aN = cross(aT, adir);',
    '    R = reflect(-V, normalize(mix(Nf, aN, abs(aniso) * saturate(rough * 3.0 + 0.25))));',
    '  }',
    '  float horizon = saturate(1.0 + 1.1 * dot(R, Ng)); horizon *= horizon;',
    '  vec3 envS = envSample(probeDir(vWorld, R), rough, L, uSunColor);',
    '  float ambLum = max(luma(uAmbientSky) * 1.6, 0.04);',
    '  float envK = uEnvIntensity * mix(0.55, 1.0, sh) * min(1.0, ambLum * 2.2 + 0.25);',
    '  spec += envS * envB * energyComp * horizon * envK * envScale * specOcclusion(NoV, ao, a);',
    '  if (cc > 0.0) {',
    '    vec3 Rc = reflect(-V, N);',
    '    float hc = saturate(1.0 + 1.1 * dot(Rc, Ng)); hc *= hc;',
    '    float Fc = F_Schlick1(0.04, NoV) * cc;',
    '    vec3 envC = envSampleC(probeDir(vWorld, Rc), ccRough, ccRough < 0.06 ? 1.0 : 99.0, L, uSunColor);',
    '    spec = spec * (1.0 - Fc) + envC * Fc * hc * envK * specOcclusion(NoV, ao, ca);',
    '    diffuse *= (1.0 - Fc);',
    '  }',
    '  if (puddle > 0.0) spec += envSample(reflect(-V, Ng), 0.02, L, uSunColor) * puddle * F_Schlick1(0.02, NoV) * envK;',
    '  // --- compose',
    '  float alpha = base.a;',
    '  if (isGlass) {',
    '    // thin glass: two interfaces reflect 2F / (1 + F); reflected light also hides what is behind the pane',
    '    float Fg = F_Schlick1(0.04, NoV); float Ft = 2.0 * Fg / (1.0 + Fg);',
    // vertex alpha = pane coverage (car glass shells fade out where the screen decals take over): reflections fade too
    '    float gCov = saturate(vColor.a);',
    '    spec *= 2.0 / (1.0 + Fg) * gCov;',
    '    alpha = 1.0 - (1.0 - alpha) * (1.0 - Ft * gCov);',
    // seen from the cabin side the pane mirrors the dark interior, not the probe (ground / start line below the car)
    '    if (!gl_FrontFacing) { spec *= 0.12; alpha = mix(base.a, alpha, 0.12); }',
    '  }',
    '  vec3 emis = uEmissive;',
    '  if (uUseEmissiveMap > 0.5) emis *= srgbToLinear(texture2D(uEmissiveMap, vUv).rgb);',
    '  vec3 col;',
    '  if (uBlendMode > 0.5) col = diffuse * alpha + spec + emis;',   // premultiplied (glass keeps reflections)
    '  else col = diffuse + spec + emis;',
    '  // --- fog (exponential, with sun in-scatter)',
    '  if (uFogEnabled > 0.5) {',
    '    float dist = length(uCamPos - vWorld);',
    '    float fog = saturate(1.0 - exp(-dist * uFogDensity));',
    '    float sunAmt = pow(saturate(dot(-V, L)), 8.0) * step(0.0, L.y);',
    '    vec3 fogC = uFogColor + uSunColor * sunAmt * 0.12;',
    '    if (uBlendMode > 1.5) col *= (1.0 - fog);',
    '    else if (uBlendMode > 0.5) col = mix(col, fogC * alpha, fog);',
    '    else col = mix(col, fogC, fog);',
    '  }',
    '  col = outputColor(col, uLinearOut, uExposure);',
    '  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;',
    '  gl_FragColor = vec4(col, uBlendMode > 1.5 ? 0.0 : (uBlendMode > 0.5 ? alpha : 1.0));',
    '}'
  ].join('\n');

  /* ---------------- unlit */
  var UNLIT_FS = [
    CHUNK_COMMON,
    'varying vec3 vWorld; varying vec3 vNormal; varying vec2 vUv; varying vec4 vColor; varying vec3 vLocal; varying float vViewZ;',
    'uniform vec4 uBaseColor; uniform sampler2D uMap; uniform float uUseMap; uniform float uAlphaTest; uniform vec3 uEmissive;',
    'uniform vec3 uFogColor; uniform float uFogDensity; uniform vec3 uCamPos; uniform float uFogEnabled;',
    'uniform float uExposure; uniform float uLinearOut; uniform float uBlendMode;',
    'void main() {',
    '  vec4 base = uBaseColor * vColor;',
    '  if (uUseMap > 0.5) { vec4 t = texture2D(uMap, vUv); base *= vec4(srgbToLinear(t.rgb), t.a); }',
    '  if (base.a < uAlphaTest) discard;',
    '  float alpha = base.a;',
    '  vec3 col = base.rgb + uEmissive;',
    '  if (uBlendMode > 0.5 && uBlendMode < 1.5) col = base.rgb * alpha + uEmissive;',
    '  if (uFogEnabled > 0.5) {',
    '    float fog = saturate(1.0 - exp(-length(uCamPos - vWorld) * uFogDensity));',
    '    if (uBlendMode > 1.5) col *= (1.0 - fog);',
    '    else if (uBlendMode > 0.5) col = mix(col, uFogColor * alpha, fog);',
    '    else col = mix(col, uFogColor, fog);',
    '  }',
    '  col = outputColor(col, uLinearOut, uExposure);',
    '  gl_FragColor = vec4(col, uBlendMode > 1.5 ? 0.0 : (uBlendMode > 0.5 ? alpha : 1.0));',
    '}'
  ].join('\n');

  /* ---------------- shadow depth */
  var SHADOW_VS = [
    'attribute vec3 aPos; attribute vec2 aUv;',
    '#ifdef INSTANCED',
    'attribute vec4 aInstM0; attribute vec4 aInstM1; attribute vec4 aInstM2; attribute vec4 aInstM3;',
    '#endif',
    'uniform mat4 uModel; uniform mat4 uLightViewProj; uniform vec4 uUvTransform;',
    'varying vec2 vUv;',
    'void main() {',
    '  mat4 M = uModel;',
    '#ifdef INSTANCED',
    '  M = uModel * mat4(aInstM0, aInstM1, aInstM2, aInstM3);',
    '#endif',
    '  vUv = aUv * uUvTransform.xy + uUvTransform.zw;',
    '  gl_Position = uLightViewProj * (M * vec4(aPos, 1.0));',
    '}'
  ].join('\n');
  var SHADOW_FS = [
    'varying vec2 vUv;',
    'uniform sampler2D uMap; uniform float uUseMap; uniform float uAlphaTest; uniform float uBaseAlpha;',
    'vec4 packDepth(float v) {',
    '  vec4 r = fract(vec4(1.0, 255.0, 65025.0, 16581375.0) * v);',
    '  r -= r.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);',
    '  return r;',
    '}',
    'void main() {',
    '  if (uAlphaTest > 0.0) {',
    '    float a = uBaseAlpha;',
    '    if (uUseMap > 0.5) a *= texture2D(uMap, vUv).a;',
    '    if (a < uAlphaTest) discard;',
    '  }',
    '#ifdef SHADOW_HW',
    '  gl_FragColor = vec4(1.0);',
    '#else',
    '  gl_FragColor = packDepth(gl_FragCoord.z);',
    '#endif',
    '}'
  ].join('\n');

  /* ---------------- sky (full-screen triangle at the far plane) */
  var SKY_VS = [
    'attribute vec3 aPos;',
    'uniform mat4 uInvViewProjRot;',
    'varying vec3 vDir;',
    'void main() {',
    '  vec4 p = uInvViewProjRot * vec4(aPos.xy, 1.0, 1.0);',
    '  vDir = p.xyz / p.w;',
    '  gl_Position = vec4(aPos.xy, 1.0, 1.0);',
    '}'
  ].join('\n');
  var SKY_FS = [
    CHUNK_COMMON,
    'varying vec3 vDir;',
    'uniform vec3 uEnvTop; uniform vec3 uEnvHorizon; uniform vec3 uEnvBottom; uniform vec3 uSunDir; uniform vec3 uSunColor;',
    'uniform float uTime; uniform float uCloudCover; uniform float uNight; uniform float uExposure; uniform float uLinearOut; uniform float uSunSize;',
    'float fbm(vec2 p) { float s = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return s; }',
    'void main() {',
    '  vec3 d = normalize(vDir);',
    '  vec3 L = normalize(uSunDir);',
    '  float y = d.y;',
    '  vec3 col = y >= 0.0 ? mix(uEnvHorizon, uEnvTop, pow(saturate(y), 0.5)) : mix(uEnvHorizon, uEnvBottom, pow(saturate(-y * 3.0), 0.5));',
    '  float mu = dot(d, L);',
    '  // Mie-ish forward scatter halo + horizon glow toward the sun',
    '  float halo = pow(saturate(mu), 12.0) * 0.35 + pow(saturate(mu), 180.0) * 1.2;',
    '  col += uSunColor * halo * (1.0 - uNight * 0.7) * smoothstep(-0.2, 0.05, y);',
    '  col += uSunColor * 0.12 * pow(1.0 - abs(y), 6.0) * pow(saturate(mu * 0.5 + 0.5), 3.0);',
    '  // sun (or moon) disc',
    '  float disc = smoothstep(uSunSize, uSunSize * 1.08, mu);',
    '  col += uSunColor * disc * mix(40.0, 3.0, uNight) * smoothstep(-0.02, 0.02, y);',
    '  // clouds on a virtual plane',
    '  if (y > 0.0 && uCloudCover > 0.001) {',
    '    vec2 cp = d.xz / (y + 0.08) * 1.4 + vec2(uTime * 0.008, uTime * 0.003);',
    '    float n = fbm(cp);',
    '    float cov = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.35, n);',
    '    float lit = 0.75 + 0.5 * pow(saturate(mu), 4.0);',
    '    vec3 cloudCol = mix(uEnvHorizon * 1.15 + uSunColor * 0.08, uEnvTop * 0.6 + uSunColor * 0.25, saturate(n)) * lit;',
    '    cloudCol = mix(cloudCol, cloudCol * 0.25, uNight);',
    '    col = mix(col, cloudCol, cov * smoothstep(0.0, 0.12, y) * 0.92);',
    '  }',
    '  // stars',
    '  if (uNight > 0.01 && y > 0.0) {',
    '    vec3 sc = floor(d * 420.0);',
    '    float st = step(0.9975, hash13(sc));',
    '    float tw = 0.6 + 0.4 * sin(uTime * 3.0 + hash13(sc + 3.1) * 40.0);',
    '    col += vec3(0.9, 0.95, 1.0) * st * tw * uNight * smoothstep(0.02, 0.25, y) * 1.6;',
    '  }',
    '  col = outputColor(col, uLinearOut, uExposure);',
    '  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* ---------------- particles (point sprites, premultiplied; additive when alpha out = 0) */
  var PARTICLES_VS = [
    'attribute vec3 aPos; attribute vec4 aColor; attribute vec4 aParams;',   // params: size (m), rotation, softness, additive(0/1)
    'uniform mat4 uView; uniform mat4 uProj; uniform float uPointScale; uniform float uMaxPointSize;',
    'varying vec4 vColor; varying vec4 vParams; varying float vDist;',
    'void main() {',
    '  vec4 vp = uView * vec4(aPos, 1.0);',
    '  vDist = -vp.z;',
    '  gl_Position = uProj * vp;',
    '  float size = aParams.x * uPointScale / max(-vp.z, 0.05);',
    '  gl_PointSize = clamp(size, 1.0, uMaxPointSize);',
    '  vColor = aColor;',
    '  // fade sprites that would exceed the max point size (camera inside smoke) instead of popping',
    '  vColor.a *= clamp(uMaxPointSize / max(size, 1.0), 0.0, 1.0);',
    '  vParams = aParams;',
    '}'
  ].join('\n');
  var PARTICLES_FS = [
    CHUNK_COMMON,
    'varying vec4 vColor; varying vec4 vParams; varying float vDist;',
    'uniform sampler2D uMap; uniform float uUseMap; uniform vec3 uFogColor; uniform float uFogDensity; uniform float uExposure; uniform float uLinearOut;',
    'void main() {',
    '  vec2 pc = gl_PointCoord - 0.5;',
    '  float cs = cos(vParams.y), sn = sin(vParams.y);',
    '  pc = vec2(cs * pc.x - sn * pc.y, sn * pc.x + cs * pc.y);',
    '  float r = length(pc) * 2.0;',
    '  float soft = max(vParams.z, 0.01);',
    '  float a = 1.0 - smoothstep(1.0 - soft, 1.0, r);',
    '  vec4 c = vColor;',
    '  if (uUseMap > 0.5) { vec4 t = texture2D(uMap, pc + 0.5); c *= vec4(srgbToLinear(t.rgb), t.a); }',
    '  c.a *= a;',
    '  if (c.a < 0.003) discard;',
    '  float fog = saturate(1.0 - exp(-vDist * uFogDensity));',
    '  vec3 col = c.rgb;',
    '  if (vParams.w > 0.5) col *= (1.0 - fog); else col = mix(col, uFogColor, fog);',
    '  col = outputColor(col, uLinearOut, uExposure);',
    '  gl_FragColor = vec4(col * c.a, vParams.w > 0.5 ? 0.0 : c.a);',
    '}'
  ].join('\n');

  /* ---------------- post */
  var POST_VS = [
    'attribute vec3 aPos;',
    'varying vec2 vUv;',
    'void main() { vUv = aPos.xy * 0.5 + 0.5; gl_Position = vec4(aPos.xy, 0.0, 1.0); }'
  ].join('\n');
  var POST_BRIGHT_FS = [
    'varying vec2 vUv;',
    'uniform sampler2D uTex; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee;',
    'void main() {',
    '  vec3 c = texture2D(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb',
    '         + texture2D(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;',
    '  c *= 0.25;',
    '  float br = max(c.r, max(c.g, c.b));',
    '  float knee = max(uKnee, 1e-4);',
    '  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);',
    '  soft = soft * soft / (4.0 * knee + 1e-4);',
    '  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);',
    '  gl_FragColor = vec4(c * contrib, 1.0);',
    '}'
  ].join('\n');
  var POST_BLUR_FS = [
    'varying vec2 vUv;',
    'uniform sampler2D uTex; uniform vec2 uDir;',
    'void main() {',
    '  vec3 c = texture2D(uTex, vUv).rgb * 0.2270270270;',
    '  c += texture2D(uTex, vUv + uDir * 1.3846153846).rgb * 0.3162162162;',
    '  c += texture2D(uTex, vUv - uDir * 1.3846153846).rgb * 0.3162162162;',
    '  c += texture2D(uTex, vUv + uDir * 3.2307692308).rgb * 0.0702702703;',
    '  c += texture2D(uTex, vUv - uDir * 3.2307692308).rgb * 0.0702702703;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');
  var POST_FS = [
    CHUNK_COMMON,
    'varying vec2 vUv;',
    'uniform sampler2D uScene; uniform sampler2D uBloom; uniform vec2 uTexel; uniform float uAspect;',
    'uniform float uBloomStrength; uniform float uVignette; uniform float uSpeedBlur; uniform vec2 uBlurCenter;',
    'uniform float uTonemap; uniform float uExposure; uniform float uChromatic; uniform float uGrain; uniform float uTime;',
    'uniform float uSaturation; uniform float uContrast;',
    'vec3 sampleScene(vec2 uv) { return texture2D(uScene, uv).rgb; }',
    'void main() {',
    '  vec2 uv = vUv;',
    '  vec2 toC = uv - uBlurCenter;',
    '  float edge = length(toC * vec2(uAspect, 1.0));',
    '  vec3 col;',
    '  // chromatic aberration grows toward the edges (and with speed)',
    '  float ca = (uChromatic + uSpeedBlur * 0.6) * edge * edge * 0.006;',
    '  if (ca > 0.00002) col = vec3(sampleScene(uv - toC * ca * 1.0).r, sampleScene(uv).g, sampleScene(uv + toC * ca).b);',
    '  else col = sampleScene(uv);',
    '  // radial speed blur: stronger at the screen edges, centre stays sharp',
    '  if (uSpeedBlur > 0.001) {',
    '    float k = uSpeedBlur * smoothstep(0.15, 0.85, edge) * 0.055;',
    '    vec3 acc = col; float wsum = 1.0;',
    '    for (int i = 1; i <= 8; i++) {',
    '      float t = float(i) / 8.0; float w = 1.0 - t * 0.6;',
    '      acc += sampleScene(uv - toC * k * t) * w; wsum += w;',
    '    }',
    '    col = acc / wsum;',
    '  }',
    '  if (uBloomStrength > 0.0) col += texture2D(uBloom, uv).rgb * uBloomStrength;',
    '  if (uTonemap > 0.5) col = pow(acesFilm(col * uExposure), vec3(1.0 / 2.2));',
    '  // grade',
    '  float l = luma(col);',
    '  col = mix(vec3(l), col, uSaturation);',
    '  col = (col - 0.5) * uContrast + 0.5;',
    '  // vignette',
    '  float vig = smoothstep(0.35, 1.25, edge);',
    '  col *= 1.0 - vig * uVignette;',
    '  // film grain + dither',
    '  float g = hash12(gl_FragCoord.xy + fract(uTime * 13.17) * 391.0) - 0.5;',
    '  col += g * (uGrain + 1.0 / 255.0);',
    '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');

  /* ---------------- environment cube bake (CB.gl.createEnvMap): one face / mip per draw. Evaluates the procedural
     trackside environment (sky gradient, sun halo, skyline band, ground) and prefilters it for the mip's roughness
     with a cosine-weighted spiral of taps around the lookup direction. Output linear HDR (RGBM when uRGBM = 1). */
  var ENV_BAKE_FS = [
    CHUNK_COMMON, CHUNK_ENV,
    'varying vec2 vUv;',
    'uniform float uFace; uniform float uRough; uniform float uRGBM; uniform vec3 uSunDir; uniform vec3 uSunColor;',
    'vec3 faceDir(float f, vec2 st) {',
    '  if (f < 0.5) return vec3(1.0, -st.y, -st.x);',
    '  if (f < 1.5) return vec3(-1.0, -st.y, st.x);',
    '  if (f < 2.5) return vec3(st.x, 1.0, st.y);',
    '  if (f < 3.5) return vec3(st.x, -1.0, -st.y);',
    '  if (f < 4.5) return vec3(st.x, -st.y, 1.0);',
    '  return vec3(-st.x, -st.y, -1.0);',
    '}',
    'vec3 bakeEnv(vec3 d, float r) {',
    '  vec3 L = normalize(uSunDir);',
    '  vec3 c = envColor(d, r, L, uSunColor);',
    '  // atmospheric forward scatter around the sun (matches the sky shader halo), broad horizon brightening',
    '  float mu = saturate(dot(d, L));',
    '  c += uSunColor * (pow(mu, 12.0) * 0.3 + pow(mu, 180.0) * 0.8 * (1.0 - r)) * smoothstep(-0.2, 0.05, d.y);',
    '  c += uEnvHorizon * 0.12 * pow(1.0 - abs(d.y), 8.0);',
    '  return c;',
    '}',
    'void main() {',
    '  vec3 N = normalize(faceDir(uFace, vUv * 2.0 - 1.0));',
    '  vec3 col;',
    '  if (uRough < 0.02) col = bakeEnv(N, 0.0);',
    '  else {',
    '    vec3 up = abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);',
    '    vec3 T = normalize(cross(up, N)); vec3 B = cross(N, T);',
    '    float spread = min(uRough * uRough * 1.6 + uRough * 0.25, 1.45);',
    '    vec3 acc = vec3(0.0); float wsum = 0.0;',
    '    for (int i = 0; i < 48; i++) {',
    '      float fi = float(i) + 0.5;',
    '      float rr = sqrt(fi / 48.0); float ph = fi * 2.39996323;',
    '      float th = rr * spread;',
    '      vec3 dir = normalize(N * cos(th) + (T * cos(ph) + B * sin(ph)) * sin(th));',
    '      float w = exp(-2.0 * rr * rr) * max(dot(dir, N), 0.0);',
    '      acc += bakeEnv(dir, uRough * 0.6) * w; wsum += w;',
    '    }',
    '    col = acc / max(wsum, 1e-4);',
    '  }',
    '  if (uRGBM > 0.5) {',
    '    float m = clamp(max(max(col.r, col.g), max(col.b, 1e-6)) / 8.0, 1.0 / 255.0, 1.0);',
    '    m = ceil(m * 255.0) / 255.0;',
    '    gl_FragColor = vec4(col / (m * 8.0), m);',
    '  } else gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var SOURCES = {
    STANDARD_VS: STANDARD_VS, STANDARD_FS: STANDARD_FS, UNLIT_FS: UNLIT_FS, SHADOW_VS: SHADOW_VS, SHADOW_FS: SHADOW_FS,
    SKY_VS: SKY_VS, SKY_FS: SKY_FS, PARTICLES_VS: PARTICLES_VS, PARTICLES_FS: PARTICLES_FS,
    POST_VS: POST_VS, POST_FS: POST_FS, POST_BRIGHT_FS: POST_BRIGHT_FS, POST_BLUR_FS: POST_BLUR_FS,
    ENV_BAKE_FS: ENV_BAKE_FS
  };

  /* ======================================================================
     Context
     ====================================================================== */
  var hasWeakMap = typeof WeakMap !== 'undefined';
  var wrapCache = hasWeakMap ? new WeakMap() : null;
  function isGLContext(x) { return !!(x && typeof x.createBuffer === 'function' && typeof x.drawArrays === 'function'); }
  /** Accept a CB.gl ctx or a raw WebGL(2)RenderingContext (wrapped once, cached). */
  function toCtx(x) {
    if (!x) return null;
    if (x.gl && isGLContext(x.gl)) return x;
    if (isGLContext(x)) {
      var c = wrapCache && wrapCache.get(x);
      if (!c) {
        c = baseCtx(x, x.canvas || null, isWebGL2Context(x));
        if (wrapCache) wrapCache.set(x, c);
      }
      return c;
    }
    return null;
  }
  function getGL(x) { var c = toCtx(x); return c ? c.gl : null; }
  function isWebGL2Context(gl) {
    return (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) ||
      (typeof gl.texStorage2D === 'function' && typeof gl.bindVertexArray === 'function');
  }

  function setupExtensions(ctx) {
    var gl = ctx.gl, gl2 = ctx.isWebGL2;
    function ext(name) { try { return gl.getExtension(name); } catch (e) { return null; } }
    var E = ctx.ext = {};
    E.uint = gl2 || !!ext('OES_element_index_uint');
    E.instExt = gl2 ? null : ext('ANGLE_instanced_arrays');
    E.instancing = gl2 || !!E.instExt;
    E.vaoExt = gl2 ? null : ext('OES_vertex_array_object');
    E.vao = gl2 || !!E.vaoExt;
    E.derivativesExt = gl2 ? null : ext('OES_standard_derivatives');
    E.derivatives = gl2 || !!E.derivativesExt;
    E.aniso = ext('EXT_texture_filter_anisotropic') || ext('WEBKIT_EXT_texture_filter_anisotropic') || ext('MOZ_EXT_texture_filter_anisotropic');
    E.maxAniso = 1;
    if (E.aniso) { try { E.maxAniso = gl.getParameter(E.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1; } catch (e) { E.maxAniso = 1; } }
    E.depthTextureExt = gl2 ? null : ext('WEBGL_depth_texture');
    E.depthTexture = gl2 || !!E.depthTextureExt;
    E.colorBufferFloat = gl2 ? !!ext('EXT_color_buffer_float') : false;
    E.halfFloatExt = gl2 ? null : ext('OES_texture_half_float');
    E.colorBufferHalfFloat = gl2 ? E.colorBufferFloat : !!(E.halfFloatExt && ext('EXT_color_buffer_half_float'));
    E.floatLinear = !!ext('OES_texture_float_linear');
    E.halfFloatLinear = gl2 || !!ext('OES_texture_half_float_linear');
    E.parallelCompile = ext('KHR_parallel_shader_compile');
    E.loseContext = ext('WEBGL_lose_context');
    E.fragDepth = gl2 || !!ext('EXT_frag_depth');
    var C = ctx.caps = {};
    function p(n, d) { try { var v = gl.getParameter(n); return v == null ? d : v; } catch (e) { return d; } }
    C.maxTextureSize = p(gl.MAX_TEXTURE_SIZE, 4096);
    C.maxRenderbufferSize = p(gl.MAX_RENDERBUFFER_SIZE, 4096);
    C.maxAttribs = p(gl.MAX_VERTEX_ATTRIBS, 16);
    C.maxTextureUnits = p(gl.MAX_TEXTURE_IMAGE_UNITS, 16);
    C.maxVertexUniforms = p(gl.MAX_VERTEX_UNIFORM_VECTORS, 256);
    C.maxFragmentUniforms = p(gl.MAX_FRAGMENT_UNIFORM_VECTORS, 224);
    C.maxSamples = gl2 ? p(gl.MAX_SAMPLES, 0) : 0;
    var ps = p(gl.ALIASED_POINT_SIZE_RANGE, null);
    C.maxPointSize = ps && ps.length > 1 ? ps[1] : 64;
    C.renderer = String(p(gl.RENDERER, ''));
    C.instanceColor = C.maxAttribs >= 9;
    return ctx;
  }

  function baseCtx(gl, canvas, isGL2) {
    var ctx = {
      gl: gl, isWebGL2: !!isGL2, isWebGL1: !isGL2, canvas: canvas, colorSize: 4,
      width: gl.drawingBufferWidth || 1, height: gl.drawingBufferHeight || 1, cssWidth: 0, cssHeight: 0, dpr: 1,
      lost: false, generation: 0, stats: { drawCalls: 0, triangles: 0, instances: 0 }, _res: { programs: [], textures: [] },
      _lostCbs: [], _restoredCbs: []
    };
    setupExtensions(ctx);
    ctx.createVAO = function () {
      if (ctx.isWebGL2) return gl.createVertexArray();
      return ctx.ext.vaoExt ? ctx.ext.vaoExt.createVertexArrayOES() : null;
    };
    ctx.bindVAO = function (v) {
      if (ctx.isWebGL2) gl.bindVertexArray(v || null);
      else if (ctx.ext.vaoExt) ctx.ext.vaoExt.bindVertexArrayOES(v || null);
    };
    ctx.deleteVAO = function (v) {
      if (!v) return;
      if (ctx.isWebGL2) gl.deleteVertexArray(v); else if (ctx.ext.vaoExt) ctx.ext.vaoExt.deleteVertexArrayOES(v);
    };
    ctx.divisor = function (loc, d) {
      if (ctx.isWebGL2) gl.vertexAttribDivisor(loc, d);
      else if (ctx.ext.instExt) ctx.ext.instExt.vertexAttribDivisorANGLE(loc, d);
    };
    ctx.drawElementsInstanced = function (mode, count, type, offset, n) {
      if (ctx.isWebGL2) gl.drawElementsInstanced(mode, count, type, offset, n);
      else ctx.ext.instExt.drawElementsInstancedANGLE(mode, count, type, offset, n);
    };
    ctx.drawArraysInstanced = function (mode, first, count, n) {
      if (ctx.isWebGL2) gl.drawArraysInstanced(mode, first, count, n);
      else ctx.ext.instExt.drawArraysInstancedANGLE(mode, first, count, n);
    };
    /** Resize the drawing buffer to css size * dpr (capped by the max renderbuffer size). Returns true if changed. */
    ctx.resize = function (cssW, cssH, dpr) {
      var cv = ctx.canvas;
      dpr = num(dpr, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      if (cssW == null && cv) { cssW = cv.clientWidth || cv.width; cssH = cv.clientHeight || cv.height; }
      cssW = Math.max(1, num(cssW, 1)); cssH = Math.max(1, num(cssH, 1));
      var maxS = ctx.caps.maxRenderbufferSize || 4096;
      var w = Math.max(1, Math.min(maxS, Math.round(cssW * dpr))), h = Math.max(1, Math.min(maxS, Math.round(cssH * dpr)));
      var changed = false;
      if (cv) {
        if (cv.width !== w) { cv.width = w; changed = true; }
        if (cv.height !== h) { cv.height = h; changed = true; }
      }
      ctx.cssWidth = cssW; ctx.cssHeight = cssH; ctx.dpr = dpr;
      ctx.width = gl.drawingBufferWidth || w; ctx.height = gl.drawingBufferHeight || h;
      gl.viewport(0, 0, ctx.width, ctx.height);
      return changed;
    };
    ctx.onLost = function (fn) { if (typeof fn === 'function') ctx._lostCbs.push(fn); return ctx; };
    ctx.onRestored = function (fn) { if (typeof fn === 'function') ctx._restoredCbs.push(fn); return ctx; };
    ctx.isLost = function () { return ctx.lost || (gl.isContextLost && gl.isContextLost()); };
    return ctx;
  }

  /** Creates a WebGL2 (preferred) or WebGL1 context with the extensions the renderer uses.
      opts: {antialias, alpha, depth, stencil, powerPreference, preserveDrawingBuffer, webgl1 (force WebGL1)}. */
  function createContext(canvas, opts) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    opts = opts || {};
    var attrs = {
      antialias: opts.antialias !== false, alpha: !!opts.alpha, depth: opts.depth !== false, stencil: !!opts.stencil,
      premultipliedAlpha: opts.premultipliedAlpha !== false, preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
      powerPreference: opts.powerPreference || 'high-performance', failIfMajorPerformanceCaveat: !!opts.failIfMajorPerformanceCaveat,
      desynchronized: !!opts.desynchronized
    };
    var gl = null, gl2 = false;
    if (!opts.webgl1 && opts.webgl2 !== false) { try { gl = canvas.getContext('webgl2', attrs); gl2 = !!gl; } catch (e) { gl = null; } }
    if (!gl) { try { gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs); } catch (e2) { gl = null; } }
    if (!gl) return null;
    var ctx = baseCtx(gl, canvas, gl2);
    ctx.attributes = attrs;
    ctx._onLost = function (e) {
      if (e && e.preventDefault) e.preventDefault();   // allow restoration
      ctx.lost = true;
      ctx._lostCbs.forEach(function (fn) { try { fn(e); } catch (err) { warnOnce('lostcb', err); } });
    };
    ctx._onRestored = function (e) {
      ctx.lost = false;
      ctx.generation++;
      ctx._shaders = null; ctx._white = null; ctx._flatNormal = null; ctx._dummyShadow = null; ctx._dummyCube = null; ctx._envAuto = null; ctx._fsTri = null;
      ctx._res = { programs: [], textures: [] };
      setupExtensions(ctx);
      ctx._restoredCbs.forEach(function (fn) { try { fn(e); } catch (err) { warnOnce('restorecb', err); } });
    };
    if (canvas.addEventListener) {
      canvas.addEventListener('webglcontextlost', ctx._onLost, false);
      canvas.addEventListener('webglcontextrestored', ctx._onRestored, false);
    }
    ctx.destroy = function (keepContext) {
      if (ctx._destroyed) return;
      ctx._destroyed = true;
      if (canvas.removeEventListener) {
        canvas.removeEventListener('webglcontextlost', ctx._onLost, false);
        canvas.removeEventListener('webglcontextrestored', ctx._onRestored, false);
      }
      try {
        if (!gl.isContextLost()) {
          ctx._res.programs.forEach(function (p) { if (p && p.program) gl.deleteProgram(p.program); });
          ctx._res.textures.forEach(function (t) { if (t) gl.deleteTexture(t); });
          if (ctx._fsTri) ctx._fsTri.destroy();
        }
      } catch (e) { /* ignore */ }
      ctx._shaders = null;
      if (!keepContext && ctx.ext.loseContext && opts.loseOnDestroy !== false) { try { ctx.ext.loseContext.loseContext(); } catch (e3) { /* ignore */ } }
    };
    if (opts.width || opts.height) ctx.resize(opts.width, opts.height, opts.dpr);
    else { ctx.width = gl.drawingBufferWidth; ctx.height = gl.drawingBufferHeight; }
    return ctx;
  }

  var supportCache = null;
  function isSupported() {
    if (supportCache !== null) return supportCache;
    if (typeof document === 'undefined' || !document.createElement) return false;
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
      supportCache = !!gl;
      if (gl) { var lx = gl.getExtension('WEBGL_lose_context'); if (lx) lx.loseContext(); }
    } catch (e) { supportCache = false; }
    return supportCache;
  }

  var warned = {};
  function warnOnce(key, e) {
    if (warned[key]) return;
    warned[key] = true;
    if (typeof console !== 'undefined' && console.warn) console.warn('[CB.gl] ' + key + ':', e && (e.message || e));
  }

  /* ======================================================================
     Meshes
     ====================================================================== */
  var GLC = { // numeric constants so pure helpers work without a context
    FLOAT: 0x1406, UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, TRIANGLES: 0x0004, POINTS: 0x0000, LINES: 0x0001,
    ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88E4, DYNAMIC_DRAW: 0x88E8, STREAM_DRAW: 0x88E0
  };
  function modeOf(gl, m) {
    if (typeof m === 'number') return m;
    if (m === 'points') return gl.POINTS; if (m === 'lines') return gl.LINES; if (m === 'line-strip') return gl.LINE_STRIP;
    if (m === 'triangle-strip') return gl.TRIANGLE_STRIP; return gl.TRIANGLES;
  }
  function f32(a) { return a instanceof Float32Array ? a : new Float32Array(a || []); }

  function uploadAttrib(gl, mesh, name, loc, data, size, usage) {
    var b = mesh.buffers[name];
    if (!b) { b = mesh.buffers[name] = gl.createBuffer(); }
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    var found = null;
    for (var i = 0; i < mesh.attribs.length; i++) if (mesh.attribs[i].name === name) found = mesh.attribs[i];
    if (!found) { found = { name: name, loc: loc, buf: b, size: size, type: gl.FLOAT, stride: 0, offset: 0, divisor: 0 }; mesh.attribs.push(found); mesh._vaoDirty = true; }
    else if (found.size !== size) { found.size = size; mesh._vaoDirty = true; }
    return b;
  }
  function setupVAO(ctx, attribs, ibo) {
    var gl = ctx.gl, vao = ctx.createVAO();
    if (!vao) return null;
    ctx.bindVAO(vao);
    for (var i = 0; i < attribs.length; i++) {
      var a = attribs[i];
      gl.bindBuffer(gl.ARRAY_BUFFER, a.buf);
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, a.type, false, a.stride, a.offset);
      if (ctx.ext.instancing) ctx.divisor(a.loc, a.divisor || 0);
    }
    if (ibo) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    ctx.bindVAO(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return vao;
  }
  /* manual attribute binding (WebGL1 without OES_vertex_array_object) */
  function bindManual(ctx, attribs, ibo) {
    var gl = ctx.gl, en = ctx._enabled || (ctx._enabled = []);
    var want = {};
    for (var i = 0; i < attribs.length; i++) {
      var a = attribs[i];
      want[a.loc] = 1;
      gl.bindBuffer(gl.ARRAY_BUFFER, a.buf);
      if (!en[a.loc]) { gl.enableVertexAttribArray(a.loc); en[a.loc] = 1; }
      gl.vertexAttribPointer(a.loc, a.size, a.type, false, a.stride, a.offset);
      if (ctx.ext.instancing) ctx.divisor(a.loc, a.divisor || 0);
    }
    for (var l = 0; l < 9; l++) if (en[l] && !want[l]) { gl.disableVertexAttribArray(l); en[l] = 0; if (ctx.ext.instancing && l >= 4) ctx.divisor(l, 0); }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo || null);
  }
  function unbindManual(ctx) {
    var gl = ctx.gl, en = ctx._enabled;
    if (!en) return;
    for (var l = 1; l < 9; l++) if (en[l]) { gl.disableVertexAttribArray(l); en[l] = 0; if (ctx.ext.instancing && l >= 4) ctx.divisor(l, 0); }
  }
  /** Generic vertex attribute values used when a mesh lacks normals / uvs / colors (global GL state). */
  function setAttribDefaults(ctx) {
    var gl = ctx.gl;
    gl.vertexAttrib3f(1, 0, 1, 0);
    gl.vertexAttrib2f(2, 0, 0);
    gl.vertexAttrib4f(3, 1, 1, 1, 1);
    if (ctx.caps.maxAttribs > 8) gl.vertexAttrib4f(8, 1, 1, 1, 1);
  }

  /**
   * createMesh(ctx, geo, opts) -> mesh
   * geo: {positions, normals?, uvs?, colors? (RGB or RGBA; colorSize), indices? (Uint16/Uint32/array), mode?, dynamic?}
   * Missing normals are computed (opts.computeNormals !== false). 32-bit indices without OES_element_index_uint are
   * expanded to non-indexed triangles.
   */
  function createMesh(ctxIn, geo, opts) {
    var ctx = toCtx(ctxIn);
    if (!ctx) throw new Error('CB.gl.createMesh: no WebGL context');
    var gl = ctx.gl;
    opts = opts || {};
    geo = geo || {};
    var pos = f32(geo.positions);
    var nv = pos.length / 3;
    var idx = geo.indices && geo.indices.length ? geo.indices : null;
    var maxIndex = 0;
    if (idx) {
      if (!(idx instanceof Uint16Array) && !(idx instanceof Uint32Array)) { for (var i = 0; i < idx.length; i++) if (idx[i] > maxIndex) maxIndex = idx[i]; }
      else if (idx instanceof Uint32Array) { for (i = 0; i < idx.length; i++) if (idx[i] > maxIndex) maxIndex = idx[i]; }
      if ((maxIndex > 65535 || nv > 65535) && !ctx.ext.uint) {
        geo = toNonIndexed({ positions: pos, normals: geo.normals, uvs: geo.uvs, colors: geo.colors, colorSize: geo.colorSize, indices: idx });
        pos = geo.positions; nv = pos.length / 3; idx = null;
      }
    }
    var mode = modeOf(gl, geo.mode || opts.mode);
    var usage = (geo.dynamic || opts.dynamic) ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
    var mesh = {
      _forge: true, ctx: ctx, gl: gl, generation: ctx.generation, buffers: {}, attribs: [], ibo: null,
      count: 0, indexType: 0, vertexCount: nv, mode: mode, usage: usage, vao: null, _vaoDirty: true,
      colorSize: 4, hasNormals: false, hasUvs: false, hasColors: false, bounds: null, triangles: 0, kind: geo.kind || opts.kind
    };
    function setData(g, first) {
      var P = f32(g.positions);
      var n = P.length / 3;
      uploadAttrib(gl, mesh, 'aPos', 0, P, 3, usage);
      var N = g.normals && g.normals.length === P.length ? f32(g.normals) : null;
      if (!N && mode === gl.TRIANGLES && opts.computeNormals !== false && n >= 3 && (first || mesh.hasNormals)) {
        N = computeNormalsRaw(P, idx ? idx : Array.from({ length: n }, function (_, k) { return k; }));
      }
      if (N) { uploadAttrib(gl, mesh, 'aNormal', 1, N, 3, usage); mesh.hasNormals = true; }
      if (g.uvs && g.uvs.length >= n * 2) { uploadAttrib(gl, mesh, 'aUv', 2, f32(g.uvs), 2, usage); mesh.hasUvs = true; }
      if (g.colors && g.colors.length) {
        var cs = num(g.colorSize, 0) || Math.round(g.colors.length / Math.max(1, n));
        cs = cs === 3 ? 3 : 4;
        uploadAttrib(gl, mesh, 'aColor', 3, f32(g.colors), cs, usage);
        mesh.colorSize = cs; mesh.hasColors = true;
      }
      mesh.vertexCount = n;
      mesh.bounds = computeBounds(P);
      if (!idx) { mesh.count = n; mesh.triangles = mode === gl.TRIANGLES ? Math.floor(n / 3) : 0; }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    setData(geo, true);
    if (idx) {
      var big = maxIndex > 65535 || nv > 65535 || idx instanceof Uint32Array;
      var arr = big ? (idx instanceof Uint32Array ? idx : new Uint32Array(idx)) : (idx instanceof Uint16Array ? idx : new Uint16Array(idx));
      mesh.ibo = gl.createBuffer();
      ctx.bindVAO(null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, arr, usage);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      mesh.count = arr.length; mesh.indexType = big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      mesh.triangles = mode === gl.TRIANGLES ? Math.floor(arr.length / 3) : 0;
    }
    if (geo.bounds && geo.bounds.min && !opts.recomputeBounds) mesh.bounds = normBounds(geo.bounds) || mesh.bounds;
    mesh.bind = function () {
      if (ctx.ext.vao) {
        if (!mesh.vao || mesh._vaoDirty) { if (mesh.vao) ctx.deleteVAO(mesh.vao); mesh.vao = setupVAO(ctx, mesh.attribs, mesh.ibo); mesh._vaoDirty = false; }
        ctx.bindVAO(mesh.vao);
      } else bindManual(ctx, mesh.attribs, mesh.ibo);
    };
    mesh.drawRaw = function () {
      if (mesh.ibo) gl.drawElements(mesh.mode, mesh.count, mesh.indexType, 0);
      else gl.drawArrays(mesh.mode, 0, mesh.count);
      ctx.stats.drawCalls++; ctx.stats.triangles += mesh.triangles;
    };
    /** draw(program?) — binds the program (if given), the vertex state and issues the draw call. */
    mesh.draw = function (program) {
      if (mesh.generation !== ctx.generation || !mesh.count) return;
      if (program) gl.useProgram(program.program || program);
      mesh.bind();
      mesh.drawRaw();
      if (ctx.ext.vao) ctx.bindVAO(null);
    };
    /** update(geo) — re-upload attributes (and indices) e.g. for dynamic ribbons. */
    mesh.update = function (g) {
      if (!g) return mesh;
      if (g.indices && g.indices.length && mesh.ibo) {
        var I = g.indices;
        var big2 = mesh.indexType === gl.UNSIGNED_INT;
        var a2 = big2 ? (I instanceof Uint32Array ? I : new Uint32Array(I)) : (I instanceof Uint16Array ? I : new Uint16Array(I));
        ctx.bindVAO(null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, a2, usage);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        mesh.count = num(g.count, a2.length);
        mesh.triangles = Math.floor(mesh.count / 3);
        idx = a2;
      }
      if (g.positions) setData(g, false);
      if (g.count != null && !mesh.ibo) mesh.count = g.count;
      return mesh;
    };
    mesh.destroy = function () {
      if (mesh._destroyed) return;
      mesh._destroyed = true;
      if (mesh.generation === ctx.generation && !gl.isContextLost()) {
        for (var k in mesh.buffers) if (mesh.buffers[k]) gl.deleteBuffer(mesh.buffers[k]);
        if (mesh.ibo) gl.deleteBuffer(mesh.ibo);
        if (mesh.vao) ctx.deleteVAO(mesh.vao);
      }
      mesh.buffers = {}; mesh.attribs = []; mesh.ibo = null; mesh.vao = null; mesh.count = 0;
    };
    return mesh;
  }
  function normBounds(b) {
    if (!b) return null;
    if (b.min && b.max) {
      var c = b.center || [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      var r = num(b.radius, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2);
      return { min: b.min, max: b.max, center: c, radius: r };
    }
    return null;
  }

  /**
   * createInstanced(ctx, mesh, instanceData, opts) -> instanced mesh
   * instanceData: Float32Array with 20 floats per instance (mat4 column-major + RGBA color); 16-float stride
   * (matrix only) is accepted too. Uses WebGL2 instancing / ANGLE_instanced_arrays; falls back to one draw
   * per instance in drawList when neither is available.
   */
  function createInstanced(ctxIn, mesh, data, opts) {
    var ctx = toCtx(ctxIn);
    if (!ctx) throw new Error('CB.gl.createInstanced: no WebGL context');
    if (!mesh || !mesh._forge) mesh = createMesh(ctx, mesh || {});
    var gl = ctx.gl;
    opts = opts || {};
    data = f32(data);
    var stride = num(opts.stride, (data.length % 20 === 0) ? 20 : (data.length % 16 === 0 ? 16 : 20));
    var inst = {
      _forge: true, instanced: true, ctx: ctx, gl: gl, base: mesh, generation: ctx.generation, stride: stride,
      count: Math.floor(data.length / stride), capacity: Math.floor(data.length / stride), data: data,
      buffer: gl.createBuffer(), vao: null, _vaoDirty: true, bounds: null, attribs: null, kind: opts.kind || mesh.kind,
      get mode() { return mesh.mode; }, get indexType() { return mesh.indexType; }, get ibo() { return mesh.ibo; },
      get triangles() { return mesh.triangles * inst.count; }
    };
    inst.fallback = !ctx.ext.instancing;
    function buildAttribs() {
      var A = mesh.attribs.slice();
      var bytes = stride * 4;
      for (var c = 0; c < 4; c++) A.push({ name: 'aInstM' + c, loc: 4 + c, buf: inst.buffer, size: 4, type: gl.FLOAT, stride: bytes, offset: c * 16, divisor: 1 });
      if (stride >= 20 && ctx.caps.instanceColor) A.push({ name: 'aInstColor', loc: 8, buf: inst.buffer, size: 4, type: gl.FLOAT, stride: bytes, offset: 64, divisor: 1 });
      inst.attribs = A;
    }
    function computeInstBounds() {
      var mb = mesh.bounds || { center: [0, 0, 0], radius: 0 };
      var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], t = [0, 0, 0], m = new Float32Array(16);
      for (var i = 0; i < inst.count; i++) {
        var o = i * stride;
        for (var k = 0; k < 16; k++) m[k] = inst.data[o + k];
        vec3.transformMat4(t, mb.center, m);
        var r = mb.radius * mat4.getMaxScale(m);
        for (var c = 0; c < 3; c++) { if (t[c] - r < mn[c]) mn[c] = t[c] - r; if (t[c] + r > mx[c]) mx[c] = t[c] + r; }
      }
      inst.bounds = inst.count ? normBounds({ min: mn, max: mx }) : { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 0 };
    }
    /** update(data, count?) — replace instance data (grows the buffer if needed). */
    inst.update = function (d, count) {
      d = f32(d);
      inst.data = d;
      inst.count = count != null ? Math.min(count, Math.floor(d.length / stride)) : Math.floor(d.length / stride);
      gl.bindBuffer(gl.ARRAY_BUFFER, inst.buffer);
      if (d.length / stride > inst.capacity) { gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW); inst.capacity = Math.floor(d.length / stride); }
      else gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, inst.count * stride));
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      if (opts.bounds !== false) computeInstBounds();
      return inst;
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, inst.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, opts.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    buildAttribs();
    computeInstBounds();
    inst.bind = function () {
      if (mesh._vaoDirty || inst.attribs.length !== mesh.attribs.length + (stride >= 20 && ctx.caps.instanceColor ? 5 : 4)) { buildAttribs(); inst._vaoDirty = true; }
      if (ctx.ext.vao) {
        if (!inst.vao || inst._vaoDirty) { if (inst.vao) ctx.deleteVAO(inst.vao); inst.vao = setupVAO(ctx, inst.attribs, mesh.ibo); inst._vaoDirty = false; }
        ctx.bindVAO(inst.vao);
      } else bindManual(ctx, inst.attribs, mesh.ibo);
    };
    inst.drawRaw = function () {
      if (!inst.count) return;
      if (mesh.ibo) ctx.drawElementsInstanced(mesh.mode, mesh.count, mesh.indexType, 0, inst.count);
      else ctx.drawArraysInstanced(mesh.mode, 0, mesh.count, inst.count);
      ctx.stats.drawCalls++; ctx.stats.triangles += mesh.triangles * inst.count; ctx.stats.instances += inst.count;
    };
    inst.draw = function (program) {
      if (inst.generation !== ctx.generation || inst.fallback || !inst.count) return;
      if (program) gl.useProgram(program.program || program);
      inst.bind();
      inst.drawRaw();
      if (ctx.ext.vao) ctx.bindVAO(null); else unbindManual(ctx);
    };
    Object.defineProperty(inst, 'vertexCount', { get: function () { return mesh.vertexCount; } });
    inst.destroy = function (alsoBase) {
      if (inst._destroyed) return;
      inst._destroyed = true;
      if (inst.generation === ctx.generation && !gl.isContextLost()) {
        gl.deleteBuffer(inst.buffer);
        if (inst.vao) ctx.deleteVAO(inst.vao);
      }
      if (alsoBase || opts.ownsBase) mesh.destroy();
      inst.count = 0;
    };
    return inst;
  }

  /** Pack a list of {matrix|model (mat4), color} into a 20-float-per-instance Float32Array. */
  function packInstances(list, out) {
    var n = list.length;
    out = out && out.length >= n * 20 ? out : new Float32Array(n * 20);
    for (var i = 0; i < n; i++) {
      var e = list[i], m = e.matrix || e.model || e, c = e.color || [1, 1, 1, 1], o = i * 20;
      for (var k = 0; k < 16; k++) out[o + k] = m[k];
      out[o + 16] = c[0]; out[o + 17] = c[1]; out[o + 18] = c[2]; out[o + 19] = c.length > 3 ? c[3] : 1;
    }
    return out;
  }

  /* ======================================================================
     Programs
     ====================================================================== */
  var SAMPLER_UNITS = { uMap: 0, uTex: 0, uScene: 0, uShadowMap: 1, uBloom: 1, uNormalMap: 2, uEnvMap: 3, uRoughnessMap: 4, uAoMap: 5, uEmissiveMap: 6, uShadowNear: 7, uShadowNearRaw: 8, uMottleMap: 9 };
  var UT = {
    FLOAT: 0x1406, FLOAT_VEC2: 0x8B50, FLOAT_VEC3: 0x8B51, FLOAT_VEC4: 0x8B52, INT: 0x1404, INT_VEC2: 0x8B53,
    INT_VEC3: 0x8B54, INT_VEC4: 0x8B55, BOOL: 0x8B56, BOOL_VEC2: 0x8B57, BOOL_VEC3: 0x8B58, BOOL_VEC4: 0x8B59,
    FLOAT_MAT2: 0x8B5A, FLOAT_MAT3: 0x8B5B, FLOAT_MAT4: 0x8B5C, SAMPLER_2D: 0x8B5E, SAMPLER_CUBE: 0x8B60,
    SAMPLER_2D_SHADOW: 0x8B62, SAMPLER_3D: 0x8B5F, SAMPLER_2D_ARRAY: 0x8DC1, UNSIGNED_INT: 0x1405
  };
  function isSamplerType(t) { return t === UT.SAMPLER_2D || t === UT.SAMPLER_CUBE || t === UT.SAMPLER_2D_SHADOW || t === UT.SAMPLER_3D || t === UT.SAMPLER_2D_ARRAY; }

  /** Line-numbered error report: the log plus +-2 lines of source around each reported error line. */
  function formatShaderError(name, stage, src, log) {
    var lines = String(src).split('\n');
    var errLines = {};
    var re = /(?:ERROR|WARNING):\s*\d+:(\d+)/g, m;
    while ((m = re.exec(log || ''))) errLines[parseInt(m[1], 10)] = 1;
    var out = ['CB.gl: ' + stage + ' shader "' + name + '" failed to compile:', String(log || '(no log)').trim(), ''];
    var keys = Object.keys(errLines).map(Number).sort(function (a, b) { return a - b; });
    if (!keys.length) keys = [1];
    var shown = {};
    keys.forEach(function (ln) {
      for (var k = Math.max(1, ln - 2); k <= Math.min(lines.length, ln + 2); k++) {
        if (shown[k]) continue;
        shown[k] = 1;
        out.push((errLines[k] ? '>' : ' ') + ('     ' + k).slice(-5) + ' | ' + lines[k - 1]);
      }
      out.push('  ...');
    });
    return out.join('\n');
  }

  function compileShader(gl, type, src, name, stage) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      if (gl.isContextLost()) throw new Error('CB.gl: context lost while compiling "' + name + '"');
      throw new Error(formatShaderError(name, stage, src, log));
    }
    return sh;
  }

  /**
   * createProgram(ctx, vsSrc, fsSrc, opts{name, defines, raw (no preprocessing), attribLocations}) -> program
   * program: {program, u (name -> location), uniforms (name -> {loc, type, size, unit}), attribs, name,
   *           use(), set(name, value), setUniforms(obj), destroy()}
   * Attribute locations are fixed (aPos 0, aNormal 1, aUv 2, aColor 3, instance matrix 4-7, instance color 8)
   * so one VAO per mesh serves every program.
   */
  function createProgram(ctxIn, vsSrc, fsSrc, opts) {
    var ctx = toCtx(ctxIn);
    if (!ctx) throw new Error('CB.gl.createProgram: no WebGL context');
    var gl = ctx.gl;
    opts = opts || {};
    var name = opts.name || 'program';
    var raw = opts.raw || /^\s*#version/.test(vsSrc || '');
    var popts = { isWebGL2: ctx.isWebGL2, defines: opts.defines, derivatives: ctx.ext.derivatives };
    var vs = raw ? vsSrc : preprocess(vsSrc, 'vertex', popts);
    var fs = raw ? fsSrc : preprocess(fsSrc, 'fragment', popts);
    var v = compileShader(gl, gl.VERTEX_SHADER, vs, name, 'vertex');
    var f;
    try { f = compileShader(gl, gl.FRAGMENT_SHADER, fs, name, 'fragment'); }
    catch (e) { gl.deleteShader(v); throw e; }
    var p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f);
    var locs = opts.attribLocations || ATTRIB_LOCATIONS;
    for (var an in locs) if (Object.prototype.hasOwnProperty.call(locs, an)) gl.bindAttribLocation(p, locs[an], an);
    gl.linkProgram(p);
    gl.deleteShader(v); gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      if (gl.isContextLost()) throw new Error('CB.gl: context lost while linking "' + name + '"');
      throw new Error('CB.gl: program "' + name + '" failed to link: ' + log);
    }
    var prog = { _forge: true, program: p, gl: gl, ctx: ctx, name: name, u: {}, uniforms: {}, attribs: {}, generation: ctx.generation, _stamp: -1 };
    var nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0, nextUnit = 3;
    gl.useProgram(p);
    // fixed units used by this program are reserved so auto-assigned samplers never share a unit with them
    var reserved = {};
    for (var ri = 0; ri < nu; ri++) {
      var rInfo = gl.getActiveUniform(p, ri);
      if (rInfo && isSamplerType(rInfo.type) && SAMPLER_UNITS[rInfo.name.replace(/\[0\]$/, '')] != null) reserved[SAMPLER_UNITS[rInfo.name.replace(/\[0\]$/, '')]] = 1;
    }
    for (var i = 0; i < nu; i++) {
      var info = gl.getActiveUniform(p, i);
      if (!info) continue;
      var key = info.name.replace(/\[0\]$/, '');
      var loc = gl.getUniformLocation(p, info.name);
      var U = { loc: loc, type: info.type, size: info.size, name: key };
      if (isSamplerType(info.type)) {
        if (SAMPLER_UNITS[key] != null) U.unit = SAMPLER_UNITS[key];
        else { while (reserved[nextUnit]) nextUnit++; U.unit = nextUnit++; }
        gl.uniform1i(loc, U.unit);
      }
      prog.u[key] = loc; prog.uniforms[key] = U;
    }
    var na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES) || 0;
    for (i = 0; i < na; i++) { var ai = gl.getActiveAttrib(p, i); if (ai) prog.attribs[ai.name] = gl.getAttribLocation(p, ai.name); }
    prog.use = function () { gl.useProgram(p); return prog; };
    prog.has = function (n) { return !!prog.uniforms[n]; };
    prog.set = function (n, val) { setUniform(gl, prog.uniforms[n], val); return prog; };
    prog.setUniforms = function (obj) { if (obj) for (var k in obj) if (prog.uniforms[k]) setUniform(gl, prog.uniforms[k], obj[k]); return prog; };
    prog.destroy = function () { if (!gl.isContextLost()) gl.deleteProgram(p); prog.program = null; };
    ctx._res.programs.push(prog);
    return prog;
  }

  function texOf(v) {
    if (!v) return null;
    if (typeof WebGLTexture !== 'undefined' && v instanceof WebGLTexture) return v;
    if (v.texture && typeof WebGLTexture !== 'undefined' && v.texture instanceof WebGLTexture) return v.texture;
    if (v.tex && typeof WebGLTexture !== 'undefined' && v.tex instanceof WebGLTexture) return v.tex;
    if (typeof WebGLTexture === 'undefined' && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)) return v.texture || v.tex || v; // non-browser mocks
    return null;
  }
  function setUniform(gl, U, v) {
    if (!U || v === undefined || v === null) return;
    var t = U.type, L = U.loc;
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (isSamplerType(t)) {
      var tex = texOf(v);
      if (tex) { gl.activeTexture(gl.TEXTURE0 + U.unit); gl.bindTexture(t === UT.SAMPLER_CUBE ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D, tex); gl.activeTexture(gl.TEXTURE0); }
      else if (typeof v === 'number') gl.uniform1i(L, v);
      return;
    }
    switch (t) {
      case UT.FLOAT: if (U.size > 1) gl.uniform1fv(L, v); else gl.uniform1f(L, typeof v === 'number' ? v : v[0]); break;
      case UT.FLOAT_VEC2: gl.uniform2fv(L, v); break;
      case UT.FLOAT_VEC3: gl.uniform3fv(L, v); break;
      case UT.FLOAT_VEC4: gl.uniform4fv(L, v); break;
      case UT.INT: case UT.BOOL: if (U.size > 1) gl.uniform1iv(L, v); else gl.uniform1i(L, typeof v === 'number' ? v : v[0]); break;
      case UT.INT_VEC2: case UT.BOOL_VEC2: gl.uniform2iv(L, v); break;
      case UT.INT_VEC3: case UT.BOOL_VEC3: gl.uniform3iv(L, v); break;
      case UT.INT_VEC4: case UT.BOOL_VEC4: gl.uniform4iv(L, v); break;
      case UT.FLOAT_MAT2: gl.uniformMatrix2fv(L, false, v); break;
      case UT.FLOAT_MAT3: gl.uniformMatrix3fv(L, false, v); break;
      case UT.FLOAT_MAT4: gl.uniformMatrix4fv(L, false, v); break;
      default: if (typeof v === 'number') gl.uniform1f(L, v);
    }
  }

  /** Built-in programs (compiled once per context generation). 'standard' is required; others are optional. */
  function shaders(ctxIn) {
    var ctx = toCtx(ctxIn);
    if (!ctx) return null;
    if (ctx._shaders && ctx._shaders.generation === ctx.generation) return ctx._shaders;
    var base = ctx.isWebGL2 ? { SHADOW_HW: true } : {};
    function defs(extra) { var d = {}; var k; for (k in base) d[k] = base[k]; for (k in extra) d[k] = extra[k]; return d; }
    var instDefs = { INSTANCED: true };
    if (!ctx.caps.instanceColor) instDefs.NO_INST_COLOR = true;
    var lib = { generation: ctx.generation, errors: {} };
    function opt(key, vs, fs, d) {
      try { lib[key] = createProgram(ctx, vs, fs, { name: key, defines: d }); }
      catch (e) { lib[key] = null; lib.errors[key] = e.message; warnOnce('shader ' + key, e); if (typeof console !== 'undefined' && console.error) console.error(e.message); }
    }
    lib.standard = createProgram(ctx, STANDARD_VS, STANDARD_FS, { name: 'standard', defines: defs({}) });
    if (ctx.ext.instancing) opt('standardInstanced', STANDARD_VS, STANDARD_FS, defs(instDefs));
    opt('unlit', STANDARD_VS, UNLIT_FS, defs({}));
    if (ctx.ext.instancing) opt('unlitInstanced', STANDARD_VS, UNLIT_FS, defs(instDefs));
    opt('shadow', SHADOW_VS, SHADOW_FS, defs({}));
    if (ctx.ext.instancing) opt('shadowInstanced', SHADOW_VS, SHADOW_FS, defs({ INSTANCED: true }));
    opt('sky', SKY_VS, SKY_FS, {});
    opt('particles', PARTICLES_VS, PARTICLES_FS, {});
    opt('post', POST_VS, POST_FS, {});
    opt('postBright', POST_VS, POST_BRIGHT_FS, {});
    opt('postBlur', POST_VS, POST_BLUR_FS, {});
    if (ctx.isWebGL2) opt('envBake', POST_VS, ENV_BAKE_FS, {});
    ctx._shaders = lib;
    return lib;
  }

  /* ======================================================================
     Default textures
     ====================================================================== */
  function solidTexture(ctx, rgba) {
    var gl = ctx.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    ctx._res.textures.push(t);
    return t;
  }
  function whiteTexture(ctxIn) { var ctx = toCtx(ctxIn); return ctx._white || (ctx._white = solidTexture(ctx, [255, 255, 255, 255])); }
  function flatNormalTexture(ctx) { return ctx._flatNormal || (ctx._flatNormal = solidTexture(ctx, [128, 128, 255, 255])); }
  /** Texture bound to the shadow unit when shadows are off (WebGL2 needs a depth texture with compare mode for sampler2DShadow). */
  function dummyShadowTexture(ctx) {
    if (ctx._dummyShadow) return ctx._dummyShadow;
    var gl = ctx.gl;
    if (!ctx.isWebGL2) return (ctx._dummyShadow = whiteTexture(ctx));
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT16, 1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, new Uint16Array([65535]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindTexture(gl.TEXTURE_2D, null);
    ctx._res.textures.push(t);
    return (ctx._dummyShadow = t);
  }

  /** Near shadow cascade: the depth texture on unit 7 (hardware compare, sampler2DShadow) and again on unit 8 through
      a sampler object with compare off (raw depth for the PCSS blocker search). Units 7/8 always get a complete
      binding while a lit program may sample them; unbindNearShadow() releases the sampler object afterwards. */
  function bindNearShadow(ctx, sn) {
    var gl = ctx.gl;
    if (!ctx._rawSampler || ctx._rawSamplerGen !== ctx.generation) {
      try {
        var smp = gl.createSampler();
        gl.samplerParameteri(smp, gl.TEXTURE_COMPARE_MODE, gl.NONE);
        gl.samplerParameteri(smp, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.samplerParameteri(smp, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.samplerParameteri(smp, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.samplerParameteri(smp, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        ctx._rawSampler = smp; ctx._rawSamplerGen = ctx.generation;
      } catch (e) { ctx._rawSampler = null; ctx._rawSamplerGen = ctx.generation; }
    }
    var tex = sn ? sn.texture : dummyShadowTexture(ctx);
    gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, tex);
    if (ctx._rawSampler) gl.bindSampler(8, ctx._rawSampler);
    ctx._nearBound = true;
  }
  function unbindNearShadow(ctx) {
    var gl = ctx.gl;
    gl.bindSampler(8, null);
    gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, null);
    ctx._nearBound = false;
  }

  /** 1x1 neutral cube bound to the IBL unit when no environment map is in use (keeps samplerCube complete). */
  function dummyCubeTexture(ctx) {
    if (ctx._dummyCube) return ctx._dummyCube;
    var gl = ctx.gl, t = gl.createTexture(), px = new Uint8Array([128, 128, 128, 255]);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
    for (var f = 0; f < 6; f++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    ctx._res.textures.push(t);
    return (ctx._dummyCube = t);
  }

  /** createTexture(ctx, source, opts{wrap:'repeat'|'clamp'|'mirror', mipmaps=true, aniso=8, flipY=false, filter:'linear'|'nearest', linear (no colorspace conversion)})
      source: HTMLCanvasElement / image / ImageData / {width, height, data: Uint8Array}. */
  function createTexture(ctxIn, source, opts) {
    var ctx = toCtx(ctxIn), gl = ctx.gl;
    opts = opts || {};
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!opts.flipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!opts.premultiply);
    var w, h;
    if (source && source.data && source.width && !(typeof ImageData !== 'undefined' && source instanceof ImageData)) {
      w = source.width; h = source.height;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.data instanceof Uint8Array ? source.data : new Uint8Array(source.data));
    } else if (source) {
      w = source.width; h = source.height;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      w = h = 1;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    var pot = (w & (w - 1)) === 0 && (h & (h - 1)) === 0;
    var canMip = opts.mipmaps !== false && (ctx.isWebGL2 || pot);
    var wrap = opts.wrap === 'clamp' || (!ctx.isWebGL2 && !pot) ? gl.CLAMP_TO_EDGE : opts.wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.REPEAT;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    var nearest = opts.filter === 'nearest';
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, canMip ? (nearest ? gl.NEAREST_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR) : (nearest ? gl.NEAREST : gl.LINEAR));
    if (canMip) gl.generateMipmap(gl.TEXTURE_2D);
    if (ctx.ext.aniso && canMip && num(opts.aniso, 8) > 1) gl.texParameterf(gl.TEXTURE_2D, ctx.ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(ctx.ext.maxAniso, num(opts.aniso, 8)));
    gl.bindTexture(gl.TEXTURE_2D, null);
    ctx._res.textures.push(t);
    return t;
  }

  /* ======================================================================
     Materials (pure): normalise any material convention (uniform-style or plain keys)
     ====================================================================== */
  function mget(m, a, b, c) {
    if (!m) return undefined;
    if (m[a] !== undefined) return m[a];
    if (b && m[b] !== undefined) return m[b];
    if (c && m[c] !== undefined) return m[c];
    return undefined;
  }
  var WHITE4 = [1, 1, 1, 1], ZERO3 = [0, 0, 0];
  /** Shading model: 0 standard, 1 thin glass, 2 rubber. Explicit materialType / shading ('glass' | 'tyre' | 'tire' |
      'rubber' or the number) wins; otherwise `glass: true` or a material name starting with glass / tyre / tire / rubber. */
  var MATERIAL_TYPES = { standard: 0, glass: 1, tyre: 2, tire: 2, rubber: 2 };
  function materialTypeOf(mt) {
    var t = mget(mt, 'uMaterialType', 'materialType', 'shading');
    if (typeof t === 'number' && isFinite(t)) return clamp(Math.round(t), 0, 2);
    if (typeof t === 'string' && MATERIAL_TYPES[t.toLowerCase()] != null) return MATERIAL_TYPES[t.toLowerCase()];
    if (mt.glass === true) return 1;
    var n = typeof mt.name === 'string' ? mt.name.toLowerCase() : '';
    if (/^glass\b/.test(n)) return 1;
    if (/^(tyre|tire|rubber)\b/.test(n)) return 2;
    return 0;
  }
  /** resolveMaterial(material, out?) -> flat descriptor used by drawList (pure; no GL). */
  function resolveMaterial(mt, out) {
    mt = mt || {};
    out = out || {};
    var bc = mget(mt, 'uBaseColor', 'baseColor', 'color') || WHITE4;
    var alpha = bc.length > 3 ? bc[3] : num(mt.opacity, 1);
    out.r = num(bc[0], 1); out.g = num(bc[1], 1); out.b = num(bc[2], 1); out.a = num(alpha, 1);
    var map = mget(mt, 'uMap', 'map');
    var useMap = mget(mt, 'uUseMap', 'useMap');
    out.map = map && useMap !== 0 && useMap !== false ? texOf(map) : null;
    out.normalMap = texOf(mget(mt, 'uNormalMap', 'normalMap')) || null;
    out.normalScale = num(mget(mt, 'uNormalScale', 'normalScale'), 1);
    // metallic-roughness map (glTF layout: G = roughness, B = metallic, multiplied), AO map (R), emissive map (sRGB)
    out.roughnessMap = texOf(mget(mt, 'uRoughnessMap', 'roughnessMap', 'metallicRoughnessMap')) || null;
    out.aoMap = texOf(mget(mt, 'uAoMap', 'aoMap', 'occlusionMap')) || null;
    out.aoStrength = clamp(num(mget(mt, 'uAoStrength', 'aoStrength'), 1), 0, 1);
    out.emissiveMap = texOf(mget(mt, 'uEmissiveMap', 'emissiveMap')) || null;
    // macro mottle (world-space): mottle = [metres per tile, strength, offset x, offset z]
    out.mottleMap = texOf(mget(mt, 'uMottleMap', 'mottleMap')) || null;
    var mo = mt.mottle || null;
    out.mo0 = mo && mo[0] > 0 ? 1 / mo[0] : 0; out.mo1 = mo ? clamp(num(mo[1], 1), 0, 2) : 0; out.mo2 = mo ? num(mo[2], 0) : 0; out.mo3 = mo ? num(mo[3], 0) : 0;
    out.anisotropy = clamp(num(mget(mt, 'uAnisotropy', 'anisotropy'), 0), -1, 1);
    var ax = mget(mt, 'uAnisoAxis', 'anisotropyAxis', 'anisoAxis');
    if (ax && ax.length >= 3) { out.ax0 = num(ax[0], 0); out.ax1 = num(ax[1], 0); out.ax2 = num(ax[2], 1); out.ax3 = ax.length > 3 ? num(ax[3], 1) : 1; }
    else { out.ax0 = 0; out.ax1 = 0; out.ax2 = 1; out.ax3 = 0; }
    out.materialType = materialTypeOf(mt);
    out.metallic = clamp(num(mget(mt, 'uMetallic', 'metallic', 'metalness'), 0), 0, 1);
    out.roughness = clamp(num(mget(mt, 'uRoughness', 'roughness'), 0.7), 0.02, 1);
    out.clearcoat = clamp(num(mget(mt, 'uClearcoat', 'clearcoat'), 0), 0, 1);
    out.clearcoatRoughness = clamp(num(mget(mt, 'uClearcoatRough', 'clearcoatRoughness', 'clearcoatRough'), 0.06), 0.02, 1);
    out.flake = clamp(num(mget(mt, 'uFlake', 'flake'), 0), 0, 1);
    out.hueShift = num(mget(mt, 'uHueShift', 'hueShift'), 0);
    var em = mget(mt, 'uEmissive', 'emissive') || ZERO3, ei = num(mt.emissiveIntensity, 1);
    out.er = num(em[0], 0) * ei; out.eg = num(em[1], 0) * ei; out.eb = num(em[2], 0) * ei;
    out.alphaTest = num(mget(mt, 'uAlphaTest', 'alphaTest'), 0);
    out.envIntensity = num(mget(mt, 'uEnvIntensity', 'envIntensity'), 1);
    out.unlit = !!mt.unlit;
    out.additive = !!(mt.additive || mt.blend === 'additive' || mt.blending === 'additive');
    out.transparent = !!(mt.transparent || mt.blend || out.additive);
    out.depthWrite = out.transparent ? mt.depthWrite === true : mt.depthWrite !== false;
    out.depthTest = mt.depthTest !== false;
    out.fog = mt.fog !== false;
    out.receiveShadow = mt.receiveShadow !== false;
    out.wetness = num(mt.wetness, 1);
    out.cull = mt.doubleSided ? 0 : (mt.cull === true || mt.side === 'front') ? 1 : (mt.side === 'back' ? 2 : 0);
    var po = mt.polygonOffset;
    out.polygonOffset = po && po.length > 1 ? po : (mt.decal ? [-1, -2] : null);
    var us = mt.uvScale, uo = mt.uvOffset, ut = mt.uUvTransform || mt.uvTransform;
    if (ut && ut.length === 4) { out.uv0 = ut[0]; out.uv1 = ut[1]; out.uv2 = ut[2]; out.uv3 = ut[3]; }
    else {
      out.uv0 = typeof us === 'number' ? us : us && us.length ? us[0] : 1;
      out.uv1 = typeof us === 'number' ? us : us && us.length > 1 ? us[1] : out.uv0;
      out.uv2 = uo && uo.length ? uo[0] : 0; out.uv3 = uo && uo.length > 1 ? uo[1] : 0;
    }
    out.blendMode = out.transparent ? (out.additive ? 2 : 1) : 0;
    out.castShadow = mt.castShadow;
    return out;
  }

  /** Pure sort helper: opaque front-to-back, transparent back-to-front (by `depth`). */
  function sortItems(records) {
    var opaque = [], trans = [];
    for (var i = 0; i < records.length; i++) (records[i].transparent ? trans : opaque).push(records[i]);
    opaque.sort(function (a, b) { return a.depth - b.depth; });
    trans.sort(function (a, b) { return b.depth - a.depth; });
    return { opaque: opaque, transparent: trans };
  }
  /** Squared-ish view distance of an item: bounds centre transformed by the model matrix. */
  function itemDepth(it, mesh, camPos) {
    if (typeof it.sortDepth === 'number' && isFinite(it.sortDepth)) return it.sortDepth;
    var m = it.model || it.matrix, b = it.worldBounds ? normBounds(it.worldBounds) : null;
    var cx, cy, cz;
    if (b) { cx = b.center[0]; cy = b.center[1]; cz = b.center[2]; }
    else {
      var c = mesh && mesh.bounds ? mesh.bounds.center : ZERO3;
      if (m) { cx = m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12]; cy = m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13]; cz = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14]; }
      else { cx = c[0]; cy = c[1]; cz = c[2]; }
    }
    var dx = cx - camPos[0], dy = cy - camPos[1], dz = cz - camPos[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* ======================================================================
     drawList
     ====================================================================== */
  var IDENT4 = mat4.create();
  function dlScratch(ctx) {
    if (ctx._dl) return ctx._dl;
    return (ctx._dl = {
      pool: [], opaque: [], trans: [], pre: [], post: [], nm: new Float32Array(9), mat: {}, tmpM: new Float32Array(16), tmpC: new Float32Array(4),
      vp: new Float32Array(16), inv: new Float32Array(16), pos: new Float32Array(3),
      lp: new Float32Array(24), ld: new Float32Array(24), lc: new Float32Array(24), lq: new Float32Array(32), sp: new Float32Array(4),
      env: {}, stamp: 0
    });
  }
  function envVec(env, a, b, d) { var v = env[a] !== undefined ? env[a] : env[b]; return v && v.length >= 3 ? v : d; }
  function envNum(env, a, b, d) { var v = env[a] !== undefined ? env[a] : env[b]; return typeof v === 'number' && isFinite(v) ? v : d; }

  /** Resolve the per-frame environment once (pure-ish; writes into S.env). */
  function resolveEnv(env, S, cam) {
    var E = S.env;
    E.sunDir = envVec(env, 'sunDir', 'uSunDir', [0.4, 0.8, 0.35]);
    E.sunColor = envVec(env, 'sunColor', 'uSunColor', [1, 1, 1]);
    E.ambientSky = envVec(env, 'ambientSky', 'uAmbientSky', [0.4, 0.45, 0.55]);
    E.ambientGround = envVec(env, 'ambientGround', 'uAmbientGround', [0.2, 0.2, 0.18]);
    E.fogColor = envVec(env, 'fogColor', 'uFogColor', [0.7, 0.8, 0.9]);
    E.fogDensity = envNum(env, 'fogDensity', 'uFogDensity', 0.001);
    E.envTop = envVec(env, 'envTop', 'uEnvTop', [0.3, 0.5, 0.8]);
    E.envHorizon = envVec(env, 'envHorizon', 'uEnvHorizon', [0.8, 0.85, 0.9]);
    E.envBottom = envVec(env, 'envBottom', 'uEnvBottom', [0.25, 0.25, 0.22]);
    E.wetness = envNum(env, 'wetness', 'uWetness', envNum(env, 'wet', 'wet', 0));
    E.exposure = envNum(env, 'exposure', 'uExposure', 1);
    E.linearOut = env.linearOutput ? 1 : 0;
    E.time = envNum(env, 'time', 'uTime', 0) % 1000;
    // lights
    var n = 0;
    if (env.lightPos && env.lightPos.length >= 3) {
      n = Math.min(8, envNum(env, 'lightCount', 'uLightCount', envNum(env, 'numLights', 'numLights', Math.floor(env.lightPos.length / 3))));
      copyInto(S.lp, env.lightPos); copyInto(S.ld, env.lightDir); copyInto(S.lc, env.lightColor); copyInto(S.lq, env.lightParams);
    } else if (env.lights && env.lights.length) {
      n = Math.min(8, env.lights.length);
      for (var i = 0; i < 8; i++) {
        var l = i < n ? env.lights[i] : null, p = l && l.pos ? l.pos : ZERO3, d = l && l.dir ? l.dir : [0, -1, 0], c = l && l.color ? l.color : ZERO3;
        S.lp[i * 3] = p[0]; S.lp[i * 3 + 1] = p[1]; S.lp[i * 3 + 2] = p[2];
        S.ld[i * 3] = d[0]; S.ld[i * 3 + 1] = d[1]; S.ld[i * 3 + 2] = d[2];
        S.lc[i * 3] = c[0]; S.lc[i * 3 + 1] = c[1]; S.lc[i * 3 + 2] = c[2];
        S.lq[i * 4] = l ? num(l.range, 40) : 0; S.lq[i * 4 + 1] = l ? num(l.cosInner, 1) : 1; S.lq[i * 4 + 2] = l ? num(l.cosOuter, 0.9) : 0.9;
        S.lq[i * 4 + 3] = l ? num(l.type, l.dir ? 1 : 0) : -1;
      }
    }
    E.lightCount = n | 0;
    // shadows (only CB.gl shadow maps that have been rendered)
    var sm = env.shadow;
    E.shadow = sm && sm._forge && sm.valid && env.useShadow !== false && env.uUseShadow !== 0 ? sm : null;
    // optional near cascade (WebGL2 hardware maps only): env.shadowNear = a second CB.gl shadow map fitted tightly
    // around the camera target, env.shadowNearSoft = [penumbra texels per metre, max texels, min texels]
    var sn = env.shadowNear;
    E.shadowNear = E.shadow && sn && sn._forge && sn.valid && sn.mode === 'hw' ? sn : null;
    var sso = env.shadowNearSoft;
    E.shadowNearSoft = E.shadowNearSoft || new Float32Array(4);
    if (E.shadowNear) {
      E.shadowNearSoft[0] = sso && typeof sso[0] === 'number' ? sso[0] : 0.022 / Math.max(1e-4, num(sn.texelWorld, 0.02));
      E.shadowNearSoft[1] = sso && typeof sso[1] === 'number' ? sso[1] : 7;
      E.shadowNearSoft[2] = num(sn.depthRange, 300);
      E.shadowNearSoft[3] = sso && typeof sso[2] === 'number' ? sso[2] : 1;
    }
    // image-based lighting: env.envMap = prefiltered cube (WebGLTexture or {texture, maxLod, rgbm} e.g. from
    // CB.gl.createEnvMap); env.sh / irradianceSH = 27 floats from CB.gl.computeSH. Absent -> procedural env + hemisphere.
    var em = env.envMap !== undefined ? env.envMap : env.uEnvMap;
    E.envMapAuto = em === undefined && env.autoEnvMap !== false;
    E.envMap = em ? texOf(em) : null;
    E.envMapMaxLod = em && typeof em.maxLod === 'number' ? em.maxLod : envNum(env, 'envMapMaxLod', 'uEnvMapMaxLod', 5);
    E.envMapRGBM = em && em.rgbm ? 1 : (env.envMapRGBM ? 1 : 0);
    E.envMapIntensity = envNum(env, 'envMapIntensity', 'uEnvMapIntensity', 1);
    // dynamic probe position (xyz) + ground height (w) for the ground-parallax reflection lookup (probeDir)
    var pp = env.envProbePos;
    E.probePos = E.probePos || new Float32Array(4);
    E.probeParallax = !!(E.envMap && pp && pp.length >= 3 && typeof env.envProbeGround === 'number');
    if (E.probeParallax) { E.probePos[0] = pp[0]; E.probePos[1] = pp[1]; E.probePos[2] = pp[2]; E.probePos[3] = env.envProbeGround; }
    var shc = env.sh || env.irradianceSH || env.uSH;
    E.sh = shc && shc.length >= 27 ? shc : null;
    E.cam = cam;
    return E;
  }
  function copyInto(dst, src) { if (!src) return; var n = Math.min(dst.length, src.length); for (var i = 0; i < n; i++) dst[i] = src[i]; }

  function camInfo(camera, S) {
    camera = camera || {};
    var view = camera.view || camera.viewMatrix || camera.uView || null;
    var proj = camera.proj || camera.projMatrix || camera.projection || camera.uProj || null;
    var vp = camera.viewProj || camera.viewProjection || null;
    if (!vp && view && proj) vp = mat4.multiply(S.vp, proj, view);
    var pos = camera.position || camera.eye || camera.pos || camera.uCamPos || null;
    if ((!pos || pos.length < 3) && view) {
      if (mat4.invert(S.inv, view)) { S.pos[0] = S.inv[12]; S.pos[1] = S.inv[13]; S.pos[2] = S.inv[14]; }
      pos = S.pos;
    }
    if (!pos) pos = ZERO3;
    return { view: view || IDENT4, proj: proj || IDENT4, viewProj: vp || IDENT4, position: pos, raw: camera };
  }

  /** GL state cache (reset at the start of every drawList: other modules touch GL state between calls). */
  function stateCache(ctx) {
    var gl = ctx.gl;
    var st = { blend: -1, depthWrite: -1, depthTest: -1, cull: -1, po: null, poOn: -1 };
    st.setBlend = function (mode) {
      if (st.blend === mode) return;
      st.blend = mode;
      if (mode === 0) gl.disable(gl.BLEND);
      else { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
    };
    st.setDepth = function (test, write) {
      if (st.depthTest !== test) { st.depthTest = test; if (test) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); } else gl.disable(gl.DEPTH_TEST); }
      if (st.depthWrite !== write) { st.depthWrite = write; gl.depthMask(!!write); }
    };
    st.setCull = function (c) {
      if (st.cull === c) return;
      st.cull = c;
      if (!c) gl.disable(gl.CULL_FACE);
      else { gl.enable(gl.CULL_FACE); gl.cullFace(c === 2 ? gl.FRONT : gl.BACK); }
    };
    st.setPolygonOffset = function (po) {
      if (!po) { if (st.poOn !== 0) { gl.disable(gl.POLYGON_OFFSET_FILL); st.poOn = 0; st.po = null; } return; }
      if (st.poOn !== 1) { gl.enable(gl.POLYGON_OFFSET_FILL); st.poOn = 1; }
      if (st.po !== po) { gl.polygonOffset(po[0], po[1]); st.po = po; }
    };
    return st;
  }

  function uploadFrameUniforms(gl, prog, E, C, S, depthOnly) {
    var u = prog.u;
    if (depthOnly) {
      if (u.uLightViewProj) gl.uniformMatrix4fv(u.uLightViewProj, false, C.viewProj);
      return;
    }
    if (u.uView) gl.uniformMatrix4fv(u.uView, false, C.view);
    if (u.uProj) gl.uniformMatrix4fv(u.uProj, false, C.proj);
    if (u.uCamPos) gl.uniform3f(u.uCamPos, C.position[0], C.position[1], C.position[2]);
    if (u.uSunDir) gl.uniform3fv(u.uSunDir, E.sunDir);
    if (u.uSunColor) gl.uniform3fv(u.uSunColor, E.sunColor);
    if (u.uAmbientSky) gl.uniform3fv(u.uAmbientSky, E.ambientSky);
    if (u.uAmbientGround) gl.uniform3fv(u.uAmbientGround, E.ambientGround);
    if (u.uFogColor) gl.uniform3fv(u.uFogColor, E.fogColor);
    if (u.uFogDensity) gl.uniform1f(u.uFogDensity, E.fogDensity);
    if (u.uEnvTop) gl.uniform3fv(u.uEnvTop, E.envTop);
    if (u.uEnvHorizon) gl.uniform3fv(u.uEnvHorizon, E.envHorizon);
    if (u.uEnvBottom) gl.uniform3fv(u.uEnvBottom, E.envBottom);
    if (u.uExposure) gl.uniform1f(u.uExposure, E.exposure);
    if (u.uLinearOut) gl.uniform1f(u.uLinearOut, E.linearOut);
    if (u.uTime) gl.uniform1f(u.uTime, E.time);
    if (u.uLightCount) {
      gl.uniform1i(u.uLightCount, E.lightCount);
      if (E.lightCount > 0) {
        if (u.uLightPos) gl.uniform3fv(u.uLightPos, S.lp);
        if (u.uLightDir) gl.uniform3fv(u.uLightDir, S.ld);
        if (u.uLightColor) gl.uniform3fv(u.uLightColor, S.lc);
        if (u.uLightParams) gl.uniform4fv(u.uLightParams, S.lq);
      }
    }
    if (u.uUseEnvMap) {
      gl.uniform1f(u.uUseEnvMap, E.envMap ? 1 : 0);
      if (u.uEnvMapMaxLod) gl.uniform1f(u.uEnvMapMaxLod, E.envMapMaxLod);
      if (u.uEnvMapRGBM) gl.uniform1f(u.uEnvMapRGBM, E.envMapRGBM);
      if (u.uEnvMapIntensity) gl.uniform1f(u.uEnvMapIntensity, E.envMapIntensity);
    }
    if (u.uProbeParallax) {
      gl.uniform1f(u.uProbeParallax, E.probeParallax ? 1 : 0);
      if (E.probeParallax && u.uProbePos) gl.uniform4fv(u.uProbePos, E.probePos);
    }
    if (u.uUseSH) {
      gl.uniform1f(u.uUseSH, E.sh ? 1 : 0);
      if (E.sh && u.uSH) gl.uniform3fv(u.uSH, E.sh);
    }
    if (u.uUseShadow) {
      var sm = E.shadow;
      gl.uniform1f(u.uUseShadow, sm ? 1 : 0);
      if (sm && u.uShadowMatrix) gl.uniformMatrix4fv(u.uShadowMatrix, false, sm.matrix);
      if (sm && u.uShadowParams) gl.uniform4fv(u.uShadowParams, sm.params);
    }
    if (u.uUseShadowNear) {
      var sn = E.shadowNear;
      gl.uniform1f(u.uUseShadowNear, sn ? 1 : 0);
      if (sn && u.uShadowNearMatrix) gl.uniformMatrix4fv(u.uShadowNearMatrix, false, sn.matrix);
      if (sn && u.uShadowNearParams) gl.uniform4fv(u.uShadowNearParams, sn.params);
      if (sn && u.uShadowNearSoft) gl.uniform4fv(u.uShadowNearSoft, E.shadowNearSoft);
    }
  }

  /** After a context restore, textures cached by other modules (keyed by the same ctx object) may belong to the
      lost context: binding one is INVALID_OPERATION and leaves the previous texture bound. Treat them as absent. */
  var MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'aoMap', 'emissiveMap', 'mottleMap'];
  function dropStaleMaps(gl, M) {
    for (var i = 0; i < MAP_SLOTS.length; i++) {
      var t = M[MAP_SLOTS[i]];
      if (t && typeof WebGLTexture !== 'undefined' && t instanceof WebGLTexture && !gl.isTexture(t)) M[MAP_SLOTS[i]] = null;
    }
  }

  function uploadMaterial(gl, prog, M, E, depthOnly) {
    var u = prog.u;
    if (u.uUvTransform) gl.uniform4f(u.uUvTransform, M.uv0, M.uv1, M.uv2, M.uv3);
    if (depthOnly) {
      if (u.uAlphaTest) gl.uniform1f(u.uAlphaTest, M.alphaTest);
      if (u.uBaseAlpha) gl.uniform1f(u.uBaseAlpha, M.a);
      if (u.uUseMap) gl.uniform1f(u.uUseMap, M.map ? 1 : 0);
      return;
    }
    if (u.uBaseColor) gl.uniform4f(u.uBaseColor, M.r, M.g, M.b, M.a);
    if (u.uUseMap) gl.uniform1f(u.uUseMap, M.map ? 1 : 0);
    if (u.uAlphaTest) gl.uniform1f(u.uAlphaTest, M.alphaTest);
    if (u.uEmissive) gl.uniform3f(u.uEmissive, M.er, M.eg, M.eb);
    if (u.uBlendMode) gl.uniform1f(u.uBlendMode, M.blendMode);
    if (u.uFogEnabled) gl.uniform1f(u.uFogEnabled, M.fog ? 1 : 0);
    if (u.uMetallic) gl.uniform1f(u.uMetallic, M.metallic);
    if (u.uRoughness) gl.uniform1f(u.uRoughness, M.roughness);
    if (u.uClearcoat) gl.uniform1f(u.uClearcoat, M.clearcoat);
    if (u.uClearcoatRough) gl.uniform1f(u.uClearcoatRough, M.clearcoatRoughness);
    if (u.uFlake) gl.uniform1f(u.uFlake, M.flake);
    if (u.uHueShift) gl.uniform1f(u.uHueShift, M.hueShift);
    if (u.uEnvIntensity) gl.uniform1f(u.uEnvIntensity, M.envIntensity);
    if (u.uReceiveShadow) gl.uniform1f(u.uReceiveShadow, M.receiveShadow ? 1 : 0);
    if (u.uWetness) gl.uniform1f(u.uWetness, E.wetness * M.wetness);
    if (u.uUseNormalMap) gl.uniform1f(u.uUseNormalMap, M.normalMap ? 1 : 0);
    if (u.uNormalScale) gl.uniform1f(u.uNormalScale, M.normalScale);
    if (u.uUseRoughnessMap) gl.uniform1f(u.uUseRoughnessMap, M.roughnessMap ? 1 : 0);
    if (u.uUseAoMap) gl.uniform1f(u.uUseAoMap, M.aoMap ? 1 : 0);
    if (u.uAoStrength) gl.uniform1f(u.uAoStrength, M.aoStrength);
    if (u.uUseEmissiveMap) gl.uniform1f(u.uUseEmissiveMap, M.emissiveMap ? 1 : 0);
    if (u.uMottle) gl.uniform4f(u.uMottle, M.mottleMap ? M.mo0 : 0, M.mottleMap ? M.mo1 : 0, M.mo2, M.mo3);
    if (u.uAnisotropy) gl.uniform1f(u.uAnisotropy, M.anisotropy);
    if (u.uAnisoAxis) gl.uniform4f(u.uAnisoAxis, M.ax0, M.ax1, M.ax2, M.ax3);
    if (u.uMaterialType) gl.uniform1f(u.uMaterialType, M.materialType);
  }

  /**
   * drawList(ctx, items, camera, env) -> number of items drawn
   * items: {mesh, program?, material, model (mat4), castShadow, receiveShadow?, transparent?, instanced?, visible?,
   *         order?, sortDepth?, draw?(camera, env)}. Items with their own draw() (or a foreign mesh.draw) are
   *         self-drawing: order < 15 runs between the opaque and transparent passes, the rest after transparents.
   * camera: {view, proj, viewProj?, position?} (aliases accepted). For depth-only passes {viewProj} suffices.
   * env: lighting (sunDir, sunColor, ambientSky/Ground, fogColor/Density, envTop/Horizon/Bottom, wetness,
   *      exposure, linearOutput, time), lights (lightPos/lightDir/lightColor/lightParams + lightCount, or a
   *      `lights` list), shadow (a CB.gl shadow map, used when rendered and useShadow !== false),
   *      depthOnly / shadowPass (render into a shadow map with the depth programs), program (override).
   */
  function drawList(ctxIn, items, camera, env) {
    var ctx = toCtx(ctxIn);
    if (!ctx || ctx.lost || !items || !items.length) return 0;
    var gl = ctx.gl;
    if (gl.isContextLost && gl.isContextLost()) return 0;
    env = env || {};
    var lib = shaders(ctx);
    var S = dlScratch(ctx);
    var C = camInfo(camera, S);
    var depthOnly = !!(env.depthOnly || env.shadowPass);
    var E = resolveEnv(env, S, C);
    if (!depthOnly && E.envMapAuto && !E.envMap) autoEnvMap(ctx, E);
    var stamp = ++S.stamp;
    var pool = S.pool, used = 0;
    var opaque = S.opaque, trans = S.trans, pre = S.pre, post = S.post;
    opaque.length = trans.length = pre.length = post.length = 0;
    var i, it;
    for (i = 0; i < items.length; i++) {
      it = items[i];
      if (!it || it.visible === false || it.hidden) continue;
      var mesh = it.instanced && it.instanced._forge ? it.instanced : it.mesh;
      var custom = typeof it.draw === 'function' || (mesh && !mesh._forge && typeof mesh.draw === 'function');
      if (custom) { if (!depthOnly) (num(it.order, 50) < 15 ? pre : post).push(it); continue; }
      if (!mesh || !mesh._forge || mesh.generation !== ctx.generation || mesh._destroyed) continue;
      if (!mesh.count || (mesh.instanced && !mesh.count)) continue;
      if (mesh.instanced && mesh.base && !mesh.base.count) continue;
      var mt = it.material || {};
      var transparent = !!(it.transparent || mt.transparent || mt.blend || mt.additive);
      if (depthOnly) {
        if (it.castShadow === false || mt.castShadow === false) continue;
        if (transparent && !(num(mt.alphaTest, 0) > 0) && mt.castShadow !== true && it.castShadow !== true) continue;
      }
      var r = pool[used] || (pool[used] = { it: null, mesh: null, depth: 0, transparent: false });
      used++;
      r.it = it; r.mesh = mesh; r.transparent = transparent && !depthOnly;
      r.depth = itemDepth(it, mesh, C.position);
      (r.transparent ? trans : opaque).push(r);
    }
    opaque.sort(byDepthAsc);
    trans.sort(byDepthDesc);
    pre.sort(byOrder); post.sort(byOrder);

    var st = stateCache(ctx);
    var cur = { prog: null, mat: null, mesh: null, map: undefined, nmap: undefined, rmap: undefined, aomap: undefined, emap: undefined, mmap: undefined };
    function bindUnit(unit, key, tex) {
      if (cur[key] === tex) return;
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex || whiteTexture(ctx)); gl.activeTexture(gl.TEXTURE0);
      cur[key] = tex;
    }
    function bindPbrMaps(M) {
      bindUnit(4, 'rmap', M.roughnessMap || null);
      bindUnit(5, 'aomap', M.aoMap || null);
      bindUnit(6, 'emap', M.emissiveMap || null);
      bindUnit(9, 'mmap', M.mottleMap || null);
    }
    function begin() {
      st = stateCache(ctx);
      cur.prog = null; cur.mat = null; cur.mesh = null; cur.map = undefined; cur.nmap = undefined;
      cur.rmap = undefined; cur.aomap = undefined; cur.emap = undefined; cur.mmap = undefined;
      setAttribDefaults(ctx);
      if (!depthOnly) {
        // IBL cube on unit 3 (a 1x1 dummy keeps the sampler complete when absent); PBR map slots on 4-6
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, E.envMap || dummyCubeTexture(ctx));
        bindPbrMaps({});
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, !depthOnly && E.shadow ? E.shadow.texture : dummyShadowTexture(ctx));
      if (ctx.isWebGL2 && !depthOnly) bindNearShadow(ctx, E.shadowNear);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, flatNormalTexture(ctx));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, whiteTexture(ctx));
      gl.disable(gl.SCISSOR_TEST);
      st.setBlend(0); st.setDepth(1, 1); st.setCull(0);
      if (!depthOnly) st.setPolygonOffset(null);
    }
    var drawn = 0;
    var M = S.mat;
    function drawRecord(r) {
      var it = r.it, mesh = r.mesh, mt = it.material || {};
      var inst = !!mesh.instanced;
      if (inst && mesh.fallback) return drawInstFallback(r);
      var prog = null;
      if (it.program && it.program._forge && !depthOnly) prog = it.program;
      else if (depthOnly) prog = (env.program && env.program._forge && !inst) ? env.program : (inst ? lib.shadowInstanced : lib.shadow);
      else if (mt.unlit) prog = inst ? lib.unlitInstanced : lib.unlit;
      else prog = inst ? lib.standardInstanced : lib.standard;
      if (!prog || !prog.program) return;
      if (cur.prog !== prog) {
        gl.useProgram(prog.program);
        cur.prog = prog; cur.mat = null;
        if (prog._stamp !== stamp) { prog._stamp = stamp; uploadFrameUniforms(gl, prog, E, C, S, depthOnly); }
      }
      var model = it.model || it.matrix || IDENT4;
      var u = prog.u;
      if (u.uModel) gl.uniformMatrix4fv(u.uModel, false, model);
      if (u.uNormalMat) gl.uniformMatrix3fv(u.uNormalMat, false, mat3.normalFromMat4(S.nm, model));
      if (cur.mat !== mt) {
        resolveMaterial(mt, M);
        if (ctx.generation > 0) dropStaleMaps(gl, M);
        if (it.receiveShadow === false) M.receiveShadow = false;
        uploadMaterial(gl, prog, M, E, depthOnly);
        if (it.program && it.program._forge && !depthOnly) prog.setUniforms(mt);
        cur.mat = mt;
        var map = M.map || null;
        if (cur.map !== map) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, map || whiteTexture(ctx)); cur.map = map; }
        if (!depthOnly) {
          var nmap = M.normalMap || null;
          if (cur.nmap !== nmap) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, nmap || flatNormalTexture(ctx)); gl.activeTexture(gl.TEXTURE0); cur.nmap = nmap; }
          bindPbrMaps(M);
          st.setBlend(r.transparent ? 1 : 0);
          st.setDepth(M.depthTest ? 1 : 0, r.transparent ? (M.depthWrite ? 1 : 0) : (M.depthWrite ? 1 : 0));
          st.setCull(M.cull);
          st.setPolygonOffset(M.polygonOffset);
        }
      }
      if (cur.mesh !== mesh) { mesh.bind(); cur.mesh = mesh; }
      mesh.drawRaw();
      drawn++;
    }
    function drawInstFallback(r) {
      // no instancing support: one draw per instance (model * instance matrix, color * instance color)
      var it = r.it, inst = r.mesh, base = inst.base, mt = it.material || {};
      var prog = depthOnly ? lib.shadow : (mt.unlit ? lib.unlit : lib.standard);
      if (!prog) return;
      if (cur.prog !== prog) { gl.useProgram(prog.program); cur.prog = prog; if (prog._stamp !== stamp) { prog._stamp = stamp; uploadFrameUniforms(gl, prog, E, C, S, depthOnly); } }
      resolveMaterial(mt, M);
      if (ctx.generation > 0) dropStaleMaps(gl, M);
      var model = it.model || IDENT4, m = S.tmpM, u = prog.u, cr = M.r, cg = M.g, cb = M.b, ca = M.a;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, M.map || whiteTexture(ctx)); cur.map = M.map || null;
      if (!depthOnly) bindPbrMaps(M);
      if (!depthOnly) { st.setBlend(r.transparent ? 1 : 0); st.setDepth(M.depthTest ? 1 : 0, M.depthWrite ? 1 : 0); st.setCull(M.cull); st.setPolygonOffset(M.polygonOffset); }
      if (cur.mesh !== base) { base.bind(); cur.mesh = base; }
      for (var k = 0; k < inst.count; k++) {
        var o = k * inst.stride;
        for (var q = 0; q < 16; q++) S.inv[q] = inst.data[o + q];
        mat4.multiply(m, model, S.inv);
        if (inst.stride >= 20) { M.r = cr * inst.data[o + 16]; M.g = cg * inst.data[o + 17]; M.b = cb * inst.data[o + 18]; M.a = ca * inst.data[o + 19]; }
        uploadMaterial(gl, prog, M, E, depthOnly);
        if (u.uModel) gl.uniformMatrix4fv(u.uModel, false, m);
        if (u.uNormalMat) gl.uniformMatrix3fv(u.uNormalMat, false, mat3.normalFromMat4(S.nm, m));
        base.drawRaw();
      }
      cur.mat = null;
      drawn++;
    }
    function runCustom(list) {
      var raw = C.raw;
      for (var c = 0; c < list.length; c++) {
        var ci = list[c];
        try {
          if (ctx.ext.vao) ctx.bindVAO(null); else unbindManual(ctx);
          if (typeof ci.draw === 'function') ci.draw(raw, env);
          else ci.mesh.draw(null, raw, env);
          drawn++;
        } catch (e) { warnOnce('custom draw ' + (ci.kind || ''), e); }
      }
      begin();
    }
    begin();
    for (i = 0; i < opaque.length; i++) drawRecord(opaque[i]);
    if (pre.length) runCustom(pre);
    for (i = 0; i < trans.length; i++) drawRecord(trans[i]);
    if (post.length) runCustom(post);
    // leave clean state for other modules
    if (ctx.ext.vao) ctx.bindVAO(null); else unbindManual(ctx);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    if (ctx.isWebGL2 && !depthOnly && ctx._nearBound) unbindNearShadow(ctx);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null);
    for (i = 0; i < used; i++) { pool[i].it = null; pool[i].mesh = null; }
    return drawn;
  }
  function byDepthAsc(a, b) { return a.depth - b.depth; }
  function byDepthDesc(a, b) { return b.depth - a.depth; }
  function byOrder(a, b) { return num(a.order, 50) - num(b.order, 50); }

  /* ======================================================================
     Shadow map (directional sun, texel-snapped ortho fit around a centre)
     ====================================================================== */
  var BIAS_M = new Float32Array([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0.5, 0.5, 0.5, 1]);
  /** Pure: fill {view, proj, viewProj, matrix} for a sun direction (pointing TO the sun), centre and radius. */
  function fitShadow(out, center, sunDir, radius, size, depthExtra) {
    out = out || {};
    out.view = out.view || new Float32Array(16); out.proj = out.proj || new Float32Array(16);
    out.viewProj = out.viewProj || new Float32Array(16); out.matrix = out.matrix || new Float32Array(16);
    var L = vec3.normalize([0, 0, 0], sunDir && vec3.length(sunDir) > 0 ? sunDir : [0.3, 1, 0.2]);
    var up = Math.abs(L[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
    mat4.lookAt(out.view, L, [0, 0, 0], up);   // rotation (fixed origin) so texel snapping is stable
    var lc = vec3.transformMat4([0, 0, 0], center, out.view);
    var r = Math.max(1, num(radius, 100)), texel = (2 * r) / Math.max(16, size || 2048);
    var sx = Math.round(lc[0] / texel) * texel, sy = Math.round(lc[1] / texel) * texel;
    var zr = r + num(depthExtra, 140);
    mat4.ortho(out.proj, sx - r, sx + r, sy - r, sy + r, -lc[2] - zr, -lc[2] + zr);
    mat4.multiply(out.viewProj, out.proj, out.view);
    mat4.multiply(out.matrix, BIAS_M, out.viewProj);
    out.texelWorld = texel; out.depthRange = 2 * zr; out.radius = r;
    return out;
  }

  /**
   * createShadowMap(ctx, size, opts{radius, strength}) -> shadow map
   *   {texture, size, matrix (world -> shadow uv/depth), viewProj, params (texel, bias, normalBias, strength), valid,
   *    render(casters, {center, sunDir, radius}), begin(center, sunDir, radius) -> lightCamera, end(), resize(size), destroy()}
   * WebGL2: DEPTH_COMPONENT24 texture with hardware compare (sampler2DShadow, 3x3 bilinear PCF).
   * WebGL1: RGBA8 packed depth + 3x3 manual bilinear PCF.
   */
  function createShadowMap(ctxIn, size, opts) {
    var ctx = toCtx(ctxIn), gl = ctx.gl;
    opts = opts || {};
    var sm = {
      _forge: true, ctx: ctx, generation: ctx.generation, size: 0, mode: ctx.isWebGL2 ? 'hw' : 'packed',
      texture: null, fb: null, depthRb: null, valid: false, strength: num(opts.strength, 1),
      matrix: new Float32Array(16), viewProj: new Float32Array(16), view: new Float32Array(16), proj: new Float32Array(16),
      params: new Float32Array(4), radius: num(opts.radius, 100), center: [0, 0, 0], sunDir: [0.3, 1, 0.2]
    };
    sm.shadowMatrix = sm.matrix;
    sm.camera = { view: sm.view, proj: sm.proj, viewProj: sm.viewProj, position: [0, 0, 0] };
    function free() {
      if (gl.isContextLost()) return;
      if (sm.fb) gl.deleteFramebuffer(sm.fb);
      if (sm.texture) gl.deleteTexture(sm.texture);
      if (sm.depthRb) gl.deleteRenderbuffer(sm.depthRb);
      sm.fb = sm.texture = sm.depthRb = null;
    }
    function alloc(s) {
      free();
      s = Math.max(256, Math.min(Math.round(num(s, 2048)), ctx.caps.maxTextureSize || 4096, ctx.caps.maxRenderbufferSize || 4096, 8192));
      sm.size = s;
      sm.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, sm.texture);
      sm.fb = gl.createFramebuffer();
      if (sm.mode === 'hw') {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, s, s, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, s, s, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sm.fb);
      if (sm.mode === 'hw') {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, sm.texture, 0);
        gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
      } else {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sm.texture, 0);
        sm.depthRb = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, sm.depthRb);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, s, s);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, sm.depthRb);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      }
      sm.ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!sm.ok) warnOnce('shadow map framebuffer incomplete', sm.mode);
      sm.valid = false;
    }
    alloc(size);
    sm.fit = function (center, sunDir, radius) {
      if (center) { sm.center[0] = center[0]; sm.center[1] = center[1]; sm.center[2] = center[2]; }
      if (sunDir) { sm.sunDir[0] = sunDir[0]; sm.sunDir[1] = sunDir[1]; sm.sunDir[2] = sunDir[2]; }
      sm.radius = num(radius, sm.radius);
      fitShadow(sm, sm.center, sm.sunDir, sm.radius, sm.size, opts.depthExtra);
      vec3.scaleAndAdd(sm.camera.position, sm.center, vec3.normalize([0, 0, 0], sm.sunDir), sm.radius + 140);
      var texel = 1 / sm.size;
      sm.params[0] = texel;
      sm.params[1] = sm.mode === 'hw' ? 0.06 / sm.depthRange : 0.12 / sm.depthRange;   // depth bias (~6-12 cm)
      sm.params[2] = sm.texelWorld * 1.4;                                              // normal offset (world)
      sm.params[3] = sm.strength;
      return sm;
    };
    /** Bind for rendering; returns the light camera ({viewProj, ...}) for drawList({depthOnly: true}). */
    sm.begin = function (center, sunDir, radius) {
      if (sm.generation !== ctx.generation) { sm.generation = ctx.generation; alloc(sm.size); }
      sm.fit(center, sunDir, radius);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sm.fb);
      gl.viewport(0, 0, sm.size, sm.size);
      gl.disable(gl.SCISSOR_TEST);
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      if (sm.mode === 'packed') { gl.colorMask(true, true, true, true); gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); }
      else gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.2, 3.0);
      return sm.camera;
    };
    sm.end = function () {
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      sm.valid = !!sm.ok;
    };
    /** render(casters, {center, sunDir, radius}) — fit + depth pass in one call (what renderer3d uses). */
    sm.render = function (casters, o) {
      o = o || {};
      if (!sm.ok || ctx.lost) return false;
      var cam = sm.begin(o.center || sm.center, o.sunDir || sm.sunDir, o.radius != null ? o.radius : sm.radius);
      // keep the polygon offset active through drawList (it does not touch polygon offset in depth-only mode)
      drawList(ctx, casters || [], cam, { depthOnly: true });
      sm.end();
      return true;
    };
    sm.resize = function (s) { if (Math.round(s) !== sm.size) alloc(s); return sm; };
    sm.destroy = function () { free(); sm.valid = false; sm.ok = false; };
    return sm;
  }
  function renderShadows(ctx, sm, casters, opts) { return sm && typeof sm.render === 'function' ? sm.render(casters, opts) : false; }

  /* ======================================================================
     Render targets
     ====================================================================== */
  /**
   * createRenderTarget(ctx, w, h, opts{depth=true, samples=0 (WebGL2 MSAA, resolved by resolve()),
   *   type:'byte'|'half'|'float' (falls back to byte when not renderable), filter:'linear'|'nearest', wrap:'clamp'|'repeat'})
   * -> {w, h, fb, tex, texture, hdr, samples, ok, bind(), unbind(), resolve(), resize(w, h), destroy()}
   */
  function createRenderTarget(ctxIn, w, h, opts) {
    var ctx = toCtx(ctxIn), gl = ctx.gl;
    opts = opts || {};
    var t = { _forge: true, ctx: ctx, w: 0, h: 0, fb: null, tex: null, depthRb: null, msFb: null, msColor: null, msDepth: null, samples: 0, hdr: false, ok: false, generation: ctx.generation };
    function formats() {
      var type = opts.type || 'byte';
      if (type === 'half' || type === 'float') {
        if (ctx.isWebGL2 && ctx.ext.colorBufferFloat) {
          return type === 'float' && ctx.ext.floatLinear ? { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, rb: gl.RGBA32F, hdr: true }
            : { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, rb: gl.RGBA16F, hdr: true };
        }
        if (!ctx.isWebGL2 && ctx.ext.colorBufferHalfFloat && ctx.ext.halfFloatExt) {
          return { internal: gl.RGBA, format: gl.RGBA, type: ctx.ext.halfFloatExt.HALF_FLOAT_OES, rb: null, hdr: true };
        }
      }
      return { internal: ctx.isWebGL2 ? gl.RGBA8 : gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE, rb: ctx.isWebGL2 ? gl.RGBA8 : null, hdr: false };
    }
    function free() {
      if (gl.isContextLost()) return;
      [t.fb, t.msFb].forEach(function (f) { if (f) gl.deleteFramebuffer(f); });
      [t.depthRb, t.msColor, t.msDepth].forEach(function (r) { if (r) gl.deleteRenderbuffer(r); });
      if (t.tex) gl.deleteTexture(t.tex);
      t.fb = t.msFb = t.depthRb = t.msColor = t.msDepth = t.tex = null;
    }
    function alloc(W, H) {
      free();
      W = Math.max(1, Math.round(W)); H = Math.max(1, Math.round(H));
      t.w = W; t.h = H; t.width = W; t.height = H;
      var F = formats();
      t.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, F.internal, W, H, 0, F.format, F.type, null);
      var filt = opts.filter === 'nearest' || (F.hdr && !ctx.ext.halfFloatLinear) ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
      var wrap = opts.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      gl.bindTexture(gl.TEXTURE_2D, null);
      t.fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      if (opts.depth !== false) {
        t.depthRb = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, t.depthRb);
        gl.renderbufferStorage(gl.RENDERBUFFER, ctx.isWebGL2 ? gl.DEPTH_COMPONENT24 : gl.DEPTH_COMPONENT16, W, H);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.depthRb);
      }
      t.ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      if (!t.ok && F.hdr) {
        // HDR not renderable after all: retry as RGBA8
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        opts.type = 'byte';
        return alloc(W, H);
      }
      t.hdr = F.hdr;
      t.samples = 0;
      var want = ctx.isWebGL2 ? Math.min(num(opts.samples, 0), ctx.caps.maxSamples || 0) : 0;
      if (want > 0 && t.ok && F.rb) {
        try {
          t.msFb = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, t.msFb);
          t.msColor = gl.createRenderbuffer();
          gl.bindRenderbuffer(gl.RENDERBUFFER, t.msColor);
          gl.renderbufferStorageMultisample(gl.RENDERBUFFER, want, F.rb, W, H);
          gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, t.msColor);
          if (opts.depth !== false) {
            t.msDepth = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, t.msDepth);
            gl.renderbufferStorageMultisample(gl.RENDERBUFFER, want, gl.DEPTH_COMPONENT24, W, H);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.msDepth);
          }
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('msaa incomplete');
          t.samples = want;
        } catch (e) {
          if (t.msFb) gl.deleteFramebuffer(t.msFb);
          if (t.msColor) gl.deleteRenderbuffer(t.msColor);
          if (t.msDepth) gl.deleteRenderbuffer(t.msDepth);
          t.msFb = t.msColor = t.msDepth = null; t.samples = 0;
        }
      }
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      t.texture = t.tex;
      return t;
    }
    alloc(w, h);
    t.bind = function () {
      if (t.generation !== ctx.generation) { t.generation = ctx.generation; alloc(t.w, t.h); }
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.msFb || t.fb);
      gl.viewport(0, 0, t.w, t.h);
      return t;
    };
    t.unbind = function () { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); };
    t.resolve = function () {
      if (!t.msFb) return t;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.msFb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.fb);
      gl.blitFramebuffer(0, 0, t.w, t.h, 0, 0, t.w, t.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      return t;
    };
    t.resize = function (W, H) { if (Math.round(W) !== t.w || Math.round(H) !== t.h) alloc(W, H); return t; };
    t.destroy = function () { free(); t.ok = false; };
    return t;
  }

  /* ======================================================================
     Image-based lighting: environment cube bake + SH irradiance
     ====================================================================== */
  /**
   * createEnvMap(ctx, env, opts{size = 128, levels = 6}) -> probe {texture, maxLod, rgbm, size, update(env), destroy()}
   * Bakes the procedural environment (env: envTop/Horizon/Bottom, sunDir, sunColor) into a prefiltered cube:
   * mip k holds roughness (k / maxLod)^2 (the standard shader samples lod = sqrt(roughness) * maxLod). WebGL2 only (WebGL1
   * cannot render into cube mips) -> returns null; the shader then evaluates the procedural env per pixel.
   * Pass the probe as env.envMap to drawList. drawList bakes one automatically when env.envMap is undefined
   * (env.autoEnvMap = false to opt out), re-baking only when the lighting changes.
   */
  function createEnvMap(ctxIn, env, opts) {
    var ctx = toCtx(ctxIn);
    if (!ctx || !ctx.isWebGL2 || ctx.lost) return null;
    var gl = ctx.gl;
    opts = opts || {};
    var lib = shaders(ctx);
    if (!lib.envBake) return null;
    var size = Math.max(16, Math.min(512, Math.pow(2, Math.round(Math.log(num(opts.size, 128)) / Math.LN2))));
    var levels = Math.max(1, Math.min(Math.round(num(opts.levels, 6)), Math.floor(Math.log(size) / Math.LN2) + 1));
    var hdr = !!ctx.ext.colorBufferFloat;
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, levels, hdr ? gl.RGBA16F : gl.RGBA8, size, size);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAX_LEVEL, levels - 1);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    ctx._res.textures.push(tex);
    var fbo = gl.createFramebuffer();
    var probe = { _forge: true, texture: tex, maxLod: levels - 1, rgbm: !hdr, size: size, levels: levels, generation: ctx.generation, valid: false };
    probe.update = function (envIn) {
      if (probe.generation !== ctx.generation || gl.isContextLost()) return false;
      var e = envIn || {};
      var E = resolveEnv(e, { env: {}, lp: new Float32Array(24), ld: new Float32Array(24), lc: new Float32Array(24), lq: new Float32Array(32) }, null);
      var prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING), vp = gl.getParameter(gl.VIEWPORT);
      var scis = gl.isEnabled(gl.SCISSOR_TEST), dep = gl.isEnabled(gl.DEPTH_TEST), bl = gl.isEnabled(gl.BLEND), cu = gl.isEnabled(gl.CULL_FACE);
      gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      var prog = lib.envBake, u = prog.u;
      gl.useProgram(prog.program);
      gl.uniform3fv(u.uEnvTop, E.envTop); gl.uniform3fv(u.uEnvHorizon, E.envHorizon); gl.uniform3fv(u.uEnvBottom, E.envBottom);
      gl.uniform3fv(u.uSunDir, E.sunDir); gl.uniform3fv(u.uSunColor, E.sunColor);
      if (u.uRGBM) gl.uniform1f(u.uRGBM, probe.rgbm ? 1 : 0);
      var ok = true;
      for (var lv = 0; lv < levels && ok; lv++) {
        var s = Math.max(1, size >> lv);
        gl.viewport(0, 0, s, s);
        if (u.uRough) { var rl = levels > 1 ? lv / (levels - 1) : 0; gl.uniform1f(u.uRough, rl * rl); }
        for (var f = 0; f < 6; f++) {
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, tex, lv);
          if (lv === 0 && f === 0 && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { ok = false; break; }
          if (u.uFace) gl.uniform1f(u.uFace, f);
          drawFullscreen(ctx, prog, null);
        }
      }
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X, null, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
      gl.viewport(vp[0], vp[1], vp[2], vp[3]);
      if (scis) gl.enable(gl.SCISSOR_TEST); if (dep) gl.enable(gl.DEPTH_TEST); if (bl) gl.enable(gl.BLEND); if (cu) gl.enable(gl.CULL_FACE);
      probe.valid = ok;
      return ok;
    };
    probe.destroy = function () {
      if (probe.generation === ctx.generation && !gl.isContextLost()) { gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); }
      probe.valid = false; probe.texture = null;
    };
    if (env) probe.update(env);
    return probe;
  }

  function q8(v) { return Math.round(num(v, 0) * 64); }
  /** lighting fingerprint for the automatic probe (quantised so float noise never forces a re-bake) */
  function envKey(E) {
    var a = [E.envTop, E.envHorizon, E.envBottom, E.sunDir, E.sunColor], k = 17;
    for (var i = 0; i < a.length; i++) for (var j = 0; j < 3; j++) k = (k * 31 + q8(a[i][j])) | 0;
    return k;
  }
  /** drawList hook: keep one auto-baked probe per context in sync with the frame's lighting (cheap key check). */
  function autoEnvMap(ctx, E) {
    if (!ctx.isWebGL2 || G.autoEnvMap === false) return;
    var A = ctx._envAuto;
    if (!A || A.generation !== ctx.generation) {
      A = ctx._envAuto = { generation: ctx.generation, probe: null, key: null, failed: false, wait: 0 };
    }
    if (A.failed) return;
    var key = envKey(E);
    if (A.key !== key) {
      // lighting changed: re-bake at most every 30 drawList calls while it keeps moving
      if (A.probe && A.wait > 0) { A.wait--; }
      else {
        try {
          if (!A.probe) A.probe = createEnvMap(ctx, null, {});
          if (!A.probe || !A.probe.update(E)) { A.failed = true; return; }
          A.key = key; A.wait = 30;
        } catch (e) { A.failed = true; warnOnce('envmap', e); return; }
      }
    }
    if (A.probe && A.probe.valid) { E.envMap = A.probe.texture; E.envMapMaxLod = A.probe.maxLod; E.envMapRGBM = A.probe.rgbm ? 1 : 0; }
  }

  /**
   * computeSH(sample(dir[3]) -> [r, g, b], samples = 512) -> Float32Array(27): 9 RGB coefficients of the
   * irradiance / PI (basis constants and cosine-lobe convolution folded in) in the standard shader's order
   * (1, y, z, x, xy, yz, 3z^2 - 1, xz, x^2 - y^2). Pure (no GL). Pass as env.sh to drawList.
   * With a constant radiance c the result evaluates to c, matching the hemisphere ambient convention.
   */
  function computeSH(sample, samples) {
    var n = Math.max(16, Math.round(num(samples, 512))), L = new Float64Array(27), d = [0, 0, 0];
    var ga = Math.PI * (3 - Math.sqrt(5));
    for (var i = 0; i < n; i++) {
      var y = 1 - (2 * i + 1) / n, r = Math.sqrt(Math.max(0, 1 - y * y)), ph = i * ga;
      d[0] = Math.cos(ph) * r; d[1] = y; d[2] = Math.sin(ph) * r;
      var c = sample(d) || ZERO3, x = d[0], z = d[2];
      var b = [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z,
        0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
      for (var k = 0; k < 9; k++) { L[k * 3] += c[0] * b[k]; L[k * 3 + 1] += c[1] * b[k]; L[k * 3 + 2] += c[2] * b[k]; }
    }
    var w = 4 * Math.PI / n, out = new Float32Array(27);
    // A_l / PI (cosine lobe: PI, 2PI/3, PI/4) times the basis constant used again at evaluation
    var K = [1 * 0.282095, (2 / 3) * 0.488603, (2 / 3) * 0.488603, (2 / 3) * 0.488603, 0.25 * 1.092548, 0.25 * 1.092548,
      0.25 * 0.315392, 0.25 * 1.092548, 0.25 * 0.546274];
    for (var m = 0; m < 9; m++) for (var ch = 0; ch < 3; ch++) out[m * 3 + ch] = L[m * 3 + ch] * w * K[m];
    return out;
  }
  /** SH of the procedural env gradient (envTop / envHorizon / envBottom), a convenience for env.sh. */
  function shFromEnv(env) {
    var E = resolveEnv(env || {}, { env: {}, lp: [], ld: [], lc: [], lq: [] }, null);
    function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
    return computeSH(function (d) {
      var yv = d[1];
      if (yv >= 0) return mix3(E.envHorizon, E.envTop, Math.pow(yv, 0.55));
      return mix3(mix3(E.envBottom, E.envHorizon, 0.6), E.envBottom, Math.pow(-yv, 0.35));
    }, 256);
  }

  /* ======================================================================
     Full-screen helpers, sky, post FX, particles
     ====================================================================== */
  function fsTriangle(ctx) {
    if (ctx._fsTri && ctx._fsTri.generation === ctx.generation) return ctx._fsTri;
    return (ctx._fsTri = createMesh(ctx, { positions: new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]) }, { computeNormals: false }));
  }
  function drawFullscreen(ctx, prog, setup) {
    var gl = ctx.gl;
    gl.useProgram(prog.program);
    if (setup) setup(prog.u, prog);
    var tri = fsTriangle(ctx);
    tri.bind(); tri.drawRaw();
    if (ctx.ext.vao) ctx.bindVAO(null); else unbindManual(ctx);
  }

  /**
   * drawSky(ctx, camera, env, opts{cloudCover (0..1), night (0..1), sunSize (cos of disc radius)}) — draws the
   * procedural sky behind everything (depth 1, no depth write). Call right after clearing.
   */
  function drawSky(ctxIn, camera, env, opts) {
    var ctx = toCtx(ctxIn), gl = ctx.gl;
    var lib = shaders(ctx);
    if (!lib.sky) return false;
    env = env || {}; opts = opts || {};
    var S = dlScratch(ctx), C = camInfo(camera, S);
    var rot = S.tmpM;
    mat4.copy(rot, C.view); rot[12] = 0; rot[13] = 0; rot[14] = 0;
    var vp = mat4.multiply(new Float32Array(16), C.proj, rot);
    var inv = mat4.invert(new Float32Array(16), vp) || mat4.create();
    var E = resolveEnv(env, S, C);
    var night = num(opts.night, env.timeOfDay === 'night' ? 1 : env.timeOfDay === 'dusk' ? 0.25 : 0);
    var weather = env.weather;
    var cloud = num(opts.cloudCover, num(env.cloudCover, weather === 'wet' ? 0.85 : weather === 'damp' ? 0.6 : 0.32));
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
    drawFullscreen(ctx, lib.sky, function (u) {
      gl.uniformMatrix4fv(u.uInvViewProjRot, false, inv);
      gl.uniform3fv(u.uEnvTop, E.envTop); gl.uniform3fv(u.uEnvHorizon, E.envHorizon); gl.uniform3fv(u.uEnvBottom, E.envBottom);
      gl.uniform3fv(u.uSunDir, E.sunDir); gl.uniform3fv(u.uSunColor, E.sunColor);
      gl.uniform1f(u.uTime, E.time); gl.uniform1f(u.uCloudCover, cloud); gl.uniform1f(u.uNight, night);
      gl.uniform1f(u.uExposure, E.exposure); gl.uniform1f(u.uLinearOut, E.linearOut);
      gl.uniform1f(u.uSunSize, num(opts.sunSize, 0.99965));
    });
    gl.depthMask(true);
    return true;
  }

  /**
   * createPostFX(ctx, opts{hdr=true, samples=4, bloomScale=0.25}) -> post
   *   begin(w?, h?) binds the (MSAA) scene target and returns {linearOutput} for the scene's env;
   *   end(params) runs bright-pass -> 2x separable blur (x2 iterations) -> composite to the default framebuffer
   *   params: {bloom, bloomStrength, threshold, knee, vignette, speedBlur (0..1), blurCenter [u, v], chromatic,
   *            grain, exposure, tonemap (default: when the scene is HDR), saturation, contrast, time, target (render target)}.
   */
  function createPostFX(ctxIn, opts) {
    var ctx = toCtx(ctxIn), gl = ctx.gl;
    opts = opts || {};
    var lib = shaders(ctx);
    var P = { ctx: ctx, scene: null, bloomA: null, bloomB: null, w: 0, h: 0 };
    var wantHdr = opts.hdr !== false && (ctx.ext.colorBufferFloat || ctx.ext.colorBufferHalfFloat);
    P.resize = function (w, h) {
      w = Math.max(1, Math.round(w || gl.drawingBufferWidth)); h = Math.max(1, Math.round(h || gl.drawingBufferHeight));
      if (w === P.w && h === P.h && P.scene) return P;
      P.w = w; P.h = h;
      if (P.scene) P.scene.resize(w, h); else P.scene = createRenderTarget(ctx, w, h, { depth: true, samples: num(opts.samples, 4), type: wantHdr ? 'half' : 'byte' });
      var s = num(opts.bloomScale, 0.25), bw = Math.max(1, Math.round(w * s)), bh = Math.max(1, Math.round(h * s));
      var bt = P.scene.hdr ? 'half' : 'byte';
      if (P.bloomA) { P.bloomA.resize(bw, bh); P.bloomB.resize(bw, bh); }
      else { P.bloomA = createRenderTarget(ctx, bw, bh, { depth: false, type: bt }); P.bloomB = createRenderTarget(ctx, bw, bh, { depth: false, type: bt }); }
      P.hdr = P.scene.hdr;
      return P;
    };
    P.begin = function (w, h) {
      P.resize(w, h);
      P.scene.bind();
      return { linearOutput: !!P.hdr };
    };
    P.end = function (p) {
      p = p || {};
      if (!lib.post) { P.scene.resolve(); return false; }
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.depthMask(false);
      P.scene.resolve();
      var bloom = p.bloom !== false && lib.postBright && lib.postBlur;
      if (bloom) {
        P.bloomA.bind();
        drawFullscreen(ctx, lib.postBright, function (u) {
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, P.scene.tex);
          gl.uniform2f(u.uTexel, 1 / P.scene.w, 1 / P.scene.h);
          gl.uniform1f(u.uThreshold, num(p.threshold, P.hdr ? 1.0 : 0.78));
          gl.uniform1f(u.uKnee, num(p.knee, 0.3));
        });
        var iters = Math.max(1, Math.round(num(p.bloomIterations, 2)));
        for (var k = 0; k < iters; k++) {
          var spread = 1 + k;
          P.bloomB.bind();
          drawFullscreen(ctx, lib.postBlur, function (u) { gl.bindTexture(gl.TEXTURE_2D, P.bloomA.tex); gl.uniform2f(u.uDir, spread / P.bloomA.w, 0); });
          P.bloomA.bind();
          drawFullscreen(ctx, lib.postBlur, function (u) { gl.bindTexture(gl.TEXTURE_2D, P.bloomB.tex); gl.uniform2f(u.uDir, 0, spread / P.bloomA.h); });
        }
      }
      if (p.target && p.target.bind) p.target.bind();
      else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); }
      var bc = p.blurCenter || [0.5, 0.5];
      drawFullscreen(ctx, lib.post, function (u) {
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bloom ? P.bloomA.tex : P.scene.tex);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, P.scene.tex);
        gl.uniform2f(u.uTexel, 1 / P.scene.w, 1 / P.scene.h);
        gl.uniform1f(u.uAspect, P.scene.w / Math.max(1, P.scene.h));
        gl.uniform1f(u.uBloomStrength, bloom ? num(p.bloomStrength, 0.55) : 0);
        gl.uniform1f(u.uVignette, num(p.vignette, 0.35));
        gl.uniform1f(u.uSpeedBlur, clamp(num(p.speedBlur, 0), 0, 1.5));
        gl.uniform2f(u.uBlurCenter, bc[0], bc[1]);
        gl.uniform1f(u.uTonemap, p.tonemap != null ? (p.tonemap ? 1 : 0) : (P.hdr ? 1 : 0));
        gl.uniform1f(u.uExposure, num(p.exposure, 1));
        gl.uniform1f(u.uChromatic, num(p.chromatic, 0.15));
        gl.uniform1f(u.uGrain, num(p.grain, 0));
        gl.uniform1f(u.uTime, num(p.time, 0) % 100);
        gl.uniform1f(u.uSaturation, num(p.saturation, 1));
        gl.uniform1f(u.uContrast, num(p.contrast, 1));
      });
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
      return true;
    };
    P.destroy = function () { ['scene', 'bloomA', 'bloomB'].forEach(function (k) { if (P[k]) P[k].destroy(); P[k] = null; }); P.w = P.h = 0; };
    return P;
  }

  /**
   * createParticles(ctx, max) -> particle buffer for the 'particles' program (GPU point sprites)
   *   data: Float32Array(max * 11) = per particle [x, y, z, r, g, b, a, size (m), rotation, softness (0..1), additive (0/1)]
   *   set(i, x, y, z, r, g, b, a, size, rot, soft, additive), upload(count), draw(camera, env, {map, viewportHeight})
   */
  function createParticles(ctxIn, max) {
    var ctx = toCtx(ctxIn), gl = ctx.gl;
    max = Math.max(1, Math.round(num(max, 1024)));
    var STR = 11;
    var ps = { ctx: ctx, max: max, count: 0, data: new Float32Array(max * STR), buffer: gl.createBuffer(), vao: null, generation: ctx.generation };
    gl.bindBuffer(gl.ARRAY_BUFFER, ps.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, ps.data.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    var attribs = [
      { name: 'aPos', loc: 0, buf: ps.buffer, size: 3, type: gl.FLOAT, stride: STR * 4, offset: 0, divisor: 0 },
      { name: 'aColor', loc: 3, buf: ps.buffer, size: 4, type: gl.FLOAT, stride: STR * 4, offset: 12, divisor: 0 },
      { name: 'aParams', loc: 1, buf: ps.buffer, size: 4, type: gl.FLOAT, stride: STR * 4, offset: 28, divisor: 0 }
    ];
    ps.set = function (i, x, y, z, r, g, b, a, size, rot, soft, additive) {
      var o = i * STR, d = ps.data;
      d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = r; d[o + 4] = g; d[o + 5] = b; d[o + 6] = a;
      d[o + 7] = size; d[o + 8] = rot || 0; d[o + 9] = soft == null ? 0.6 : soft; d[o + 10] = additive ? 1 : 0;
    };
    ps.upload = function (count) {
      ps.count = Math.min(max, Math.max(0, count | 0));
      if (!ps.count) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, ps.buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, ps.data.subarray(0, ps.count * STR));
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    };
    ps.draw = function (camera, env, o) {
      var lib = shaders(ctx);
      if (!lib.particles || !ps.count || ps.generation !== ctx.generation) return;
      env = env || {}; o = o || {};
      var S = dlScratch(ctx), C = camInfo(camera, S), E = resolveEnv(env, S, C);
      var prog = lib.particles, u = prog.u;
      gl.useProgram(prog.program);
      gl.uniformMatrix4fv(u.uView, false, C.view); gl.uniformMatrix4fv(u.uProj, false, C.proj);
      var vh = num(o.viewportHeight, gl.drawingBufferHeight);
      gl.uniform1f(u.uPointScale, vh * C.proj[5] * 0.5);
      gl.uniform1f(u.uMaxPointSize, Math.min(ctx.caps.maxPointSize || 64, num(o.maxPointSize, 512)));
      gl.uniform3fv(u.uFogColor, E.fogColor); gl.uniform1f(u.uFogDensity, E.fogDensity);
      gl.uniform1f(u.uExposure, E.exposure); gl.uniform1f(u.uLinearOut, E.linearOut);
      var map = texOf(o.map);
      gl.uniform1f(u.uUseMap, map ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, map || whiteTexture(ctx));
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE);
      if (ctx.ext.vao) { if (!ps.vao) ps.vao = setupVAO(ctx, attribs, null); ctx.bindVAO(ps.vao); }
      else bindManual(ctx, attribs, null);
      gl.drawArrays(gl.POINTS, 0, ps.count);
      ctx.stats.drawCalls++;
      if (ctx.ext.vao) ctx.bindVAO(null); else unbindManual(ctx);
      gl.depthMask(true); gl.disable(gl.BLEND);
      gl.bindTexture(gl.TEXTURE_2D, null);
    };
    ps.destroy = function () {
      if (ps.generation === ctx.generation && !gl.isContextLost()) { gl.deleteBuffer(ps.buffer); if (ps.vao) ctx.deleteVAO(ps.vao); }
      ps.count = 0;
    };
    return ps;
  }

  /* ======================================================================
     Exports
     ====================================================================== */
  var api = {
    version: '1.0.0',
    COLOR_SIZE: 4,
    mat4: mat4, mat3: mat3, vec3: vec3, quat: quat, frustum: frustum, geometry: geometry,
    preprocess: preprocess, SOURCES: SOURCES, ATTRIB_LOCATIONS: ATTRIB_LOCATIONS, formatShaderError: formatShaderError,
    isSupported: isSupported, createContext: createContext, toContext: toCtx,
    createMesh: createMesh, createInstanced: createInstanced, packInstances: packInstances,
    createProgram: createProgram, shaders: shaders,
    createTexture: createTexture, whiteTexture: whiteTexture,
    resolveMaterial: resolveMaterial, sortItems: sortItems, itemDepth: itemDepth,
    drawList: drawList,
    fitShadow: fitShadow, createShadowMap: createShadowMap, renderShadows: renderShadows,
    createRenderTarget: createRenderTarget, createPostFX: createPostFX, drawSky: drawSky, drawFullscreen: drawFullscreen,
    createParticles: createParticles,
    createEnvMap: createEnvMap, computeSH: computeSH, shFromEnv: shFromEnv, MATERIAL_TYPES: MATERIAL_TYPES,
    _GLC: GLC
  };
  for (var k in api) if (Object.prototype.hasOwnProperty.call(api, k)) G[k] = api[k];

  if (typeof module !== 'undefined' && module.exports) module.exports = G;
})(CB.gl);

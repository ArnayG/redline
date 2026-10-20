/* ==========================================================================
   FORGE Atelier — js/race/gl/cockpit.js
   CB.gl.cockpit : the first-person interior for the 3D race renderer (zero dependencies, classic script).

   CB.gl.cockpit.build(ctx, build, opts?) -> cockpit
     ctx   CB.gl context ({gl, isWebGL2, ...}) or a raw WebGL(2)RenderingContext
     build docs/SPEC.md Build object (body, interior, tech, weight, exterior, transmission, engine)
     opts  { eye: vec3 (carModel.cockpitEye, car-local), dims: carModel.dims, geom: track geometry (minimap / HUD nav),
             units: 'kph'|'mph', quality: 'low'|'medium'|'high'|'ultra', color: suit/team colour,
             gammaVertexColors: bool (default true -> vertex colours are linearised), mirrorFlipU: bool }

   cockpit = {
     items / parts   draw items in CAR-LOCAL space: [{ mesh, material, local: mat4, model: mat4, kind, transparent,
                     doubleSided, depthWrite, castShadow:false, noCull, visible }]  (`local` matrices animate in place)
     drawItems(carWorld, out?) -> visible items with `model` = carWorld * local (matrices reused, no GC)
     update(carSnap, dt, time, snap?)   steering wheel / hands / arms / lever / gauges / screen / HUD / head motion
                                        (carSnap may carry latG / longG / lookBack from the renderer)
     setMirrorTexture(tex, {flipU})     rear-view render-target colour texture supplied by renderer3d (also used by
                                        the side mirrors, left / right halves)
     setTrack(geom), setUnits(u), setQuality(q), attach(carModel)   (re-anchors on carModel.cockpitEye / dims)
     impulse(strength)                  head jolt (collisions / kerbs)
     eye             vec3 car-local driver eye the interior is built around
     camera          { eye (incl. head motion), forward, up, yaw, pitch, roll } car-local
     getCameraLocal(out?), getViewMatrix(carWorld, out?)
     mirror          { pos, normal, up, width, height, fovY } car-local rear-view mirror pose for the RT camera
     sideMirrors     [{ pos, normal, width, height, side }]
     hideKinds       carModel part kinds the renderer should skip in cockpit view (the interior replaces them)
     nearPlane       suggested near clip (m)
     draw(view, proj, carWorld, env)   self-contained fallback renderer (own shader) if no drawList / createMesh
     destroy()
   }
   Car-local axes: +X forward, +Y up, +Z right (same as CB.gl.car). Driver on the left (-Z) unless the eye says
   otherwise. Canvas textures are uploaded with UNPACK_FLIP_Y, so panel uv v=1 is the top edge, u=1 the right edge.

   Pure helpers (Node-testable, no DOM at load): layout, palette, buildGeometry, Geo, headModel, viewBasis,
   steerWheelAngle, rimPath, drawCluster / drawCenterScreen / drawHud / drawLeds / drawWheelDisplay / drawTrim.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});

(function () {
  'use strict';
  CB.gl = CB.gl || {};

  var PI = Math.PI, TAU = PI * 2, DEG = PI / 180;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function num(v, d) { v = +v; return isFinite(v) ? v : d; }
  function smoothstep(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  // modulo, not a while loop: a huge / non-finite heading must never spin the frame forever
  function wrapPi(a) { if (!isFinite(a)) return 0; a = (a + PI) % TAU; if (a < 0) a += TAU; return a - PI; }

  /* ------------------------------------------------------------------ colour */
  function hexRgb(hex, fb) {
    if (Array.isArray(hex)) return hex.slice(0, 3);
    var s = String(hex == null ? '' : hex).trim();
    if (s[0] === '#') s = s.slice(1);
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return fb ? hexRgb(fb) : [0.5, 0.5, 0.5];
    var n = parseInt(s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function rgbHex(c) {
    function h(v) { var x = Math.round(clamp(v, 0, 1) * 255).toString(16); return x.length < 2 ? '0' + x : x; }
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  }
  function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function scl(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function luma(c) { return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722; }
  function rgba(c, a) { return 'rgba(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ',' + (a == null ? 1 : a) + ')'; }

  /* ------------------------------------------------------------------ vec3 */
  function v3(x, y, z) { return [x, y, z]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function norm(a) { var l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function madd(a, b, s) { return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]; }
  function vlerp(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function anyPerp(d) { return Math.abs(d[1]) < 0.9 ? norm(cross(d, [0, 1, 0])) : norm(cross(d, [1, 0, 0])); }

  /* ------------------------------------------------------------------ mat4 (column-major, gl-matrix layout) */
  var M4 = {
    create: function () { var m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
    identity: function (o) { for (var i = 0; i < 16; i++) o[i] = (i % 5 === 0) ? 1 : 0; return o; },
    copy: function (o, a) { for (var i = 0; i < 16; i++) o[i] = a[i]; return o; },
    mul: function (o, a, b) {
      var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
        a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      for (var i = 0; i < 4; i++) {
        var b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
        o[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        o[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        o[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        o[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      }
      return o;
    },
    translation: function (o, x, y, z) { M4.identity(o); o[12] = x; o[13] = y; o[14] = z; return o; },
    rotX: function (o, a) { var c = Math.cos(a), s = Math.sin(a); M4.identity(o); o[5] = c; o[6] = s; o[9] = -s; o[10] = c; return o; },
    rotY: function (o, a) { var c = Math.cos(a), s = Math.sin(a); M4.identity(o); o[0] = c; o[2] = -s; o[8] = s; o[10] = c; return o; },
    rotZ: function (o, a) { var c = Math.cos(a), s = Math.sin(a); M4.identity(o); o[0] = c; o[1] = s; o[4] = -s; o[5] = c; return o; },
    /** columns X, Y, Z (unit axes) and translation T */
    basis: function (o, X, Y, Z, T) {
      o[0] = X[0]; o[1] = X[1]; o[2] = X[2]; o[3] = 0;
      o[4] = Y[0]; o[5] = Y[1]; o[6] = Y[2]; o[7] = 0;
      o[8] = Z[0]; o[9] = Z[1]; o[10] = Z[2]; o[11] = 0;
      o[12] = T ? T[0] : 0; o[13] = T ? T[1] : 0; o[14] = T ? T[2] : 0; o[15] = 1;
      return o;
    },
    point: function (m, p) {
      var x = p[0], y = p[1], z = p[2];
      return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    },
    dir: function (m, p) {
      var x = p[0], y = p[1], z = p[2];
      return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
    },
    invert: function (o, a) {
      var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
        a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      var b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11,
        b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30,
        b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
      var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      if (!det) return M4.identity(o);
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
    },
    perspective: function (o, fovy, aspect, near, far) {
      var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      for (var i = 0; i < 16; i++) o[i] = 0;
      o[0] = f / aspect; o[5] = f; o[10] = (far + near) * nf; o[11] = -1; o[14] = 2 * far * near * nf;
      return o;
    },
    lookAt: function (o, eye, target, up) {
      var z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
      o[0] = x[0]; o[1] = y[0]; o[2] = z[0]; o[3] = 0;
      o[4] = x[1]; o[5] = y[1]; o[6] = z[1]; o[7] = 0;
      o[8] = x[2]; o[9] = y[2]; o[10] = z[2]; o[11] = 0;
      o[12] = -dot(x, eye); o[13] = -dot(y, eye); o[14] = -dot(z, eye); o[15] = 1;
      return o;
    }
  };

  /* ==================================================================
     Geo — tiny CPU mesh builder (positions, normals, uvs, RGBA colours, indices)
     All primitives are emitted through an optional current transform (rigid only).
     ================================================================== */
  function Geo() {
    this.P = []; this.N = []; this.T = []; this.C = []; this.I = [];
    this.color = [1, 1, 1, 1];
    this.xf = null;
  }
  Geo.prototype.count = function () { return this.P.length / 3; };
  Geo.prototype.tris = function () { return this.I.length / 3; };
  Geo.prototype.setColor = function (c, a) { this.color = [c[0], c[1], c[2], a == null ? (c.length > 3 ? c[3] : 1) : a]; return this; };
  Geo.prototype.setTransform = function (m) { this.xf = m || null; return this; };
  Geo.prototype.v = function (p, n, u, vv) {
    var m = this.xf, x = p[0], y = p[1], z = p[2], nx = n[0], ny = n[1], nz = n[2];
    if (m) {
      var X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13], Z = m[2] * x + m[6] * y + m[10] * z + m[14];
      var NX = m[0] * nx + m[4] * ny + m[8] * nz, NY = m[1] * nx + m[5] * ny + m[9] * nz, NZ = m[2] * nx + m[6] * ny + m[10] * nz;
      x = X; y = Y; z = Z; nx = NX; ny = NY; nz = NZ;
    }
    var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    this.P.push(x, y, z); this.N.push(nx / l, ny / l, nz / l); this.T.push(u || 0, vv || 0);
    var c = this.color; this.C.push(c[0], c[1], c[2], c[3]);
    return this.P.length / 3 - 1;
  };
  Geo.prototype.tri = function (a, b, c) { this.I.push(a, b, c); };
  Geo.prototype.quad = function (a, b, c, d) { this.I.push(a, b, c, a, c, d); };

  /** Flat quad from 4 corners (CCW seen from the front); normal from the corners. */
  Geo.prototype.quad4 = function (p0, p1, p2, p3, uv, twoSided) {
    var n = norm(cross(sub(p1, p0), sub(p3, p0)));
    uv = uv || [0, 0, 1, 1];
    var a = this.v(p0, n, uv[0], uv[3]), b = this.v(p1, n, uv[2], uv[3]), c = this.v(p2, n, uv[2], uv[1]), d = this.v(p3, n, uv[0], uv[1]);
    this.quad(a, b, c, d);
    if (twoSided) {
      var m = mul(n, -1);
      var e = this.v(p0, m, uv[0], uv[3]), f = this.v(p1, m, uv[2], uv[3]), g = this.v(p2, m, uv[2], uv[1]), h = this.v(p3, m, uv[0], uv[1]);
      this.quad(e, h, g, f);
    }
  };

  /** Oriented box: centre c, unit axes X/Y/Z, half extents hx/hy/hz. uvScale maps metres -> uv. */
  Geo.prototype.obox = function (c, X, Y, Z, hx, hy, hz, uvScale, skip) {
    var s = uvScale || 1, self = this;
    var faces = [
      [X, Z, Y, hx, hz, hy, 'px'], [mul(X, -1), mul(Z, -1), Y, hx, hz, hy, 'nx'],
      [Y, X, Z, hy, hx, hz, 'py'], [mul(Y, -1), X, mul(Z, -1), hy, hx, hz, 'ny'],
      [Z, mul(X, -1), Y, hz, hx, hy, 'pz'], [mul(Z, -1), X, Y, hz, hx, hy, 'nz']
    ];
    faces.forEach(function (f) {
      if (skip && skip.indexOf(f[6]) >= 0) return;
      var n = f[0], u = f[1], w = cross(n, u), ctr = madd(c, n, f[3]), hu = f[4], hv = f[5];
      // ensure w aligns with the provided "up" so uvs are sane
      if (dot(w, f[2]) < 0) { w = mul(w, -1); u = mul(u, -1); }
      var p0 = madd(madd(ctr, u, -hu), w, -hv), p1 = madd(madd(ctr, u, hu), w, -hv), p2 = madd(madd(ctr, u, hu), w, hv), p3 = madd(madd(ctr, u, -hu), w, hv);
      var a = self.v(p0, n, 0, 0), b = self.v(p1, n, 2 * hu * s, 0), cc = self.v(p2, n, 2 * hu * s, 2 * hv * s), d = self.v(p3, n, 0, 2 * hv * s);
      // CCW seen from outside requires u x w == n
      if (dot(cross(u, w), n) > 0) self.quad(a, b, cc, d); else self.quad(a, d, cc, b);
    });
  };
  Geo.prototype.box = function (cx, cy, cz, sx, sy, sz, uvScale, skip) {
    this.obox([cx, cy, cz], [1, 0, 0], [0, 1, 0], [0, 0, 1], sx / 2, sy / 2, sz / 2, uvScale, skip);
  };
  /** Rectangular beam from p0 to p1 (w across, h along `up`). */
  Geo.prototype.beam = function (p0, p1, w, h, up, uvScale) {
    var d = sub(p1, p0), L = len(d); if (L < 1e-6) return;
    var X = mul(d, 1 / L), Z = norm(cross(X, up || anyPerp(X)));
    if (!isFinite(Z[0]) || len(cross(X, up || [0, 1, 0])) < 1e-4) Z = anyPerp(X);
    var Y = cross(Z, X);
    this.obox(vlerp(p0, p1, 0.5), X, Y, Z, L / 2, h / 2, w / 2, uvScale);
  };

  /** Recompute smooth normals for vertices [v0, end) from triangles [i0, end). Optional outward hint. */
  Geo.prototype.smooth = function (v0, i0, inside) {
    var P = this.P, N = this.N, I = this.I, nv = this.count(), k, acc = new Float64Array((nv - v0) * 3);
    for (k = i0; k < I.length; k += 3) {
      var a = I[k], b = I[k + 1], c = I[k + 2];
      var ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
      var e1x = P[b * 3] - ax, e1y = P[b * 3 + 1] - ay, e1z = P[b * 3 + 2] - az;
      var e2x = P[c * 3] - ax, e2y = P[c * 3 + 1] - ay, e2z = P[c * 3 + 2] - az;
      var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      [a, b, c].forEach(function (vi) { if (vi >= v0) { var o = (vi - v0) * 3; acc[o] += nx; acc[o + 1] += ny; acc[o + 2] += nz; } });
    }
    // orientation check against the inside hint (flip all triangles of the chunk if they face inward)
    if (inside) {
      var votes = 0;
      for (k = v0; k < nv; k++) {
        var o2 = (k - v0) * 3, ip = typeof inside === 'function' ? inside(k) : inside;
        var dx = P[k * 3] - ip[0], dy = P[k * 3 + 1] - ip[1], dz = P[k * 3 + 2] - ip[2];
        votes += (acc[o2] * dx + acc[o2 + 1] * dy + acc[o2 + 2] * dz) >= 0 ? 1 : -1;
      }
      if (votes < 0) {
        for (k = i0; k < I.length; k += 3) { var t = I[k + 1]; I[k + 1] = I[k + 2]; I[k + 2] = t; }
        for (k = 0; k < acc.length; k++) acc[k] = -acc[k];
      }
    }
    for (k = v0; k < nv; k++) {
      var o3 = (k - v0) * 3, l = Math.sqrt(acc[o3] * acc[o3] + acc[o3 + 1] * acc[o3 + 1] + acc[o3 + 2] * acc[o3 + 2]);
      if (l > 1e-12) { N[k * 3] = acc[o3] / l; N[k * 3 + 1] = acc[o3 + 1] / l; N[k * 3 + 2] = acc[o3 + 2] / l; }
    }
  };

  /**
   * Loft between rings (arrays of points, equal length). Points are given in the CURRENT transform space.
   * opts: { closed (ring closed, default true), capStart, capEnd, inside: point|fn|'centroid', uScale, vScale, colors: fn(r,j)->rgba }
   */
  Geo.prototype.loft = function (rings, opts) {
    opts = opts || {};
    var closed = opts.closed !== false, R = rings.length, m = rings[0].length;
    if (R < 2 || m < 2) return;
    var v0 = this.count(), i0 = this.I.length, m1 = closed ? m + 1 : m, r, j;
    // world-space ring centroids for orientation
    var cents = [];
    var vAcc = 0, prevC = null;
    for (r = 0; r < R; r++) {
      var ring = rings[r], cx = 0, cy = 0, cz = 0;
      for (j = 0; j < m; j++) { cx += ring[j][0]; cy += ring[j][1]; cz += ring[j][2]; }
      var cc = [cx / m, cy / m, cz / m];
      if (prevC) vAcc += len(sub(cc, prevC));
      prevC = cc;
      cents.push(this.xf ? M4.point(this.xf, cc) : cc);
      var perim = 0;
      for (j = 0; j < m1; j++) {
        var p = ring[j % m];
        if (j > 0) perim += len(sub(p, ring[(j - 1) % m]));
        if (opts.colors) this.setColor(opts.colors(r, j % m));
        this.v(p, [0, 1, 0], perim * (opts.uScale || 1), vAcc * (opts.vScale || 1));
      }
    }
    for (r = 0; r < R - 1; r++) for (j = 0; j < m1 - 1; j++) {
      var a = v0 + r * m1 + j, b = a + 1, c = v0 + (r + 1) * m1 + j + 1, d = v0 + (r + 1) * m1 + j;
      this.quad(a, b, c, d);
    }
    var inside = opts.inside;
    if (inside == null || inside === 'centroid') {
      inside = function (k) { return cents[Math.floor((k - v0) / m1)] || cents[0]; };
    } else if (Array.isArray(inside) && this.xf) inside = M4.point(this.xf, inside);
    this.smooth(v0, i0, inside);
    if (opts.capStart || opts.capEnd) {
      var lc = rings.map(function (rg) { var q = [0, 0, 0]; rg.forEach(function (pp) { q = add(q, pp); }); return mul(q, 1 / rg.length); });
      if (opts.capStart) this._cap(rings[0], sub(lc[0], lc[1]), opts.capColor);
      if (opts.capEnd) this._cap(rings[R - 1], sub(lc[R - 1], lc[R - 2]), opts.capColor);
    }
  };
  /** Planar fan cap over a ring; `out` is the desired facing direction (pre-transform space). */
  Geo.prototype._cap = function (ring, out, color) {
    var m = ring.length, c = [0, 0, 0], j;
    for (j = 0; j < m; j++) c = add(c, ring[j]);
    c = mul(c, 1 / m);
    var n = norm(out);
    if (!isFinite(n[0]) || len(out) < 1e-9) n = norm(cross(sub(ring[1], ring[0]), sub(ring[2 % m], ring[0])));
    if (color) this.setColor(color);
    var ci = this.v(c, n, 0.5, 0.5), base = this.count();
    for (j = 0; j < m; j++) this.v(ring[j], n, 0.5 + 0.5 * Math.cos(j / m * TAU), 0.5 + 0.5 * Math.sin(j / m * TAU));
    // winding: CCW seen from n
    var wn = cross(sub(ring[0], c), sub(ring[1 % m], c)), rev = dot(wn, n) < 0;
    for (j = 0; j < m; j++) {
      var a = base + j, b = base + (j + 1) % m;
      if (rev) this.tri(ci, b, a); else this.tri(ci, a, b);
    }
  };

  /* LOW-POLY style (docs/LOWPOLY-SPEC.md): the interior is deliberately faceted like the cars — every round section,
     ring, ellipsoid and spline is built with roughly half the segments and the meshes are emitted FLAT shaded
     (unwelded, per-face normals, subtle per-face value jitter), in flat build.interior colours with no textures
     except the live gauge / screen canvases. */
  var LOWPOLY = true;
  function lpSides(n, min) { return LOWPOLY ? Math.max(min || 4, Math.round(n * 0.5)) : n; }
  /** Circle / ellipse cross-section helper (in frame normal,binormal) */
  function ellipseShape(rx, ry, sides) {
    sides = lpSides(sides || 10, 5);
    var s = [];
    for (var i = 0; i < sides; i++) { var a = i / sides * TAU; s.push([Math.cos(a) * rx, Math.sin(a) * ry]); }
    return s;
  }
  function rectShape(w, h, r, seg) {
    // rounded rectangle, CCW, w along normal axis, h along binormal axis
    var s = [], hw = w / 2, hh = h / 2;
    r = Math.min(r || 0, hw * 0.99, hh * 0.99); seg = LOWPOLY ? 1 : seg || 2;
    var cs = [[hw - r, hh - r, 0], [-hw + r, hh - r, 1], [-hw + r, -hh + r, 2], [hw - r, -hh + r, 3]];
    cs.forEach(function (c) {
      for (var i = 0; i <= seg; i++) {
        var a = (c[2] + i / seg) * PI / 2;
        s.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
      }
    });
    return s;
  }

  /**
   * Sweep a cross-section along a 3D path.
   * opts: { radius, sides, shape: [[a,b]...], scale: fn(t)->number|[sa,sb], up: vec|fn(i,t)->vec, closed (path loop),
   *         capStart, capEnd, colors }
   */
  Geo.prototype.sweep = function (path, opts) {
    opts = opts || {};
    var n = path.length; if (n < 2) return;
    var closed = !!opts.closed;
    var shape = opts.shape || ellipseShape(opts.radius || 0.02, opts.radius || 0.02, opts.sides || 10);
    var tangents = [], i;
    for (i = 0; i < n; i++) {
      var pa = path[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], pb = path[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
      tangents.push(norm(sub(pb, pa)));
    }
    // frames
    var normals = [], prevN = null;
    for (i = 0; i < n; i++) {
      var T = tangents[i], N;
      var up = typeof opts.up === 'function' ? opts.up(i, i / (n - 1)) : opts.up;
      if (up) {
        var B0 = cross(T, up);
        if (len(B0) < 1e-6) B0 = anyPerp(T);
        N = norm(cross(norm(B0), T));
      } else if (!prevN) N = anyPerp(T);
      else { N = sub(prevN, mul(T, dot(prevN, T))); N = len(N) < 1e-6 ? anyPerp(T) : norm(N); }
      normals.push(N); prevN = N;
    }
    var rings = [], total = closed ? n + 1 : n;
    for (i = 0; i < total; i++) {
      var k = i % n, t = i / (total - 1);
      var Tk = tangents[k], Nk = normals[k], Bk = cross(Tk, Nk);
      var sc = opts.scale ? opts.scale(t, k) : 1, sa = Array.isArray(sc) ? sc[0] : sc, sb = Array.isArray(sc) ? sc[1] : sc;
      var ring = [];
      for (var j = 0; j < shape.length; j++) ring.push(madd(madd(path[k], Nk, shape[j][0] * sa), Bk, shape[j][1] * sb));
      rings.push(ring);
    }
    this.loft(rings, { closed: true, capStart: !closed && opts.capStart, capEnd: !closed && opts.capEnd, colors: opts.colors, uScale: opts.uScale, vScale: opts.vScale });
  };
  /** Cylinder / cone between two points. */
  Geo.prototype.cyl = function (p0, p1, r0, r1, sides, caps, up) {
    var r1v = r1 == null ? r0 : r1;
    this.sweep([p0, p1], { shape: ellipseShape(1, 1, sides || 12), scale: function (t) { return lerp(r0, r1v, t); }, capStart: caps !== false, capEnd: caps !== false, up: up });
  };
  /** Ellipsoid with radii along X/Y/Z axes (car-local unless transformed). */
  Geo.prototype.ellipsoid = function (c, rx, ry, rz, seg) {
    seg = lpSides(seg || 12, 6);
    var rings = [], lat = Math.max(4, Math.round(seg / 2));
    for (var i = 0; i <= lat; i++) {
      var th = -PI / 2 + i / lat * PI, cy = Math.sin(th), cr = Math.max(Math.cos(th), 0.002), ring = [];
      for (var j = 0; j < seg; j++) { var a = j / seg * TAU; ring.push([c[0] + Math.cos(a) * cr * rx, c[1] + cy * ry, c[2] + Math.sin(a) * cr * rz]); }
      rings.push(ring);
    }
    this.loft(rings, { inside: c });
  };
  /** Flat rounded-rectangle panel (fan), centre c, unit axes U (width), V (height); uv maps the panel to uvRect. */
  Geo.prototype.rrect = function (c, U, V, w, h, r, seg, uvRect, twoSided) {
    var n = norm(cross(U, V)), shape = rectShape(w, h, r, seg || 3), uv = uvRect || [0, 0, 1, 1], self = this;
    function emit(nn, rev) {
      var ci = self.v(c, nn, (uv[0] + uv[2]) / 2, (uv[1] + uv[3]) / 2), base = self.count();
      shape.forEach(function (s) {
        var p = madd(madd(c, U, s[0]), V, s[1]);
        self.v(p, nn, lerp(uv[0], uv[2], s[0] / w + 0.5), lerp(uv[3], uv[1], s[1] / h + 0.5));
      });
      for (var j = 0; j < shape.length; j++) {
        var a = base + j, b = base + (j + 1) % shape.length;
        if (rev) self.tri(ci, b, a); else self.tri(ci, a, b);
      }
    }
    emit(n, false);
    if (twoSided) emit(mul(n, -1), true);
  };
  /** Thin flat ribbon along a path (straps, strips). width along cross(T, up), thickness along up. */
  Geo.prototype.ribbon = function (path, w, t, up, opts) {
    opts = opts || {};
    this.sweep(path, { shape: rectShape(t, w, Math.min(t, w) * 0.4, 1), up: up, capStart: true, capEnd: true, scale: opts.scale, closed: opts.closed });
  };
  /** Torus-like ring (e.g. vent bezels) centred c, axis A, major radius R, minor r. */
  Geo.prototype.ring = function (c, A, R, r, seg, sides) {
    var U = anyPerp(A), W = cross(A, U), path = [];
    seg = lpSides(seg || 20, 8);
    for (var i = 0; i < seg; i++) { var a = i / seg * TAU; path.push(madd(madd(c, U, Math.cos(a) * R), W, Math.sin(a) * R)); }
    this.sweep(path, { closed: true, radius: r, sides: sides || 8, up: A });
  };
  /** Append another Geo (optionally transformed by matrix m). */
  Geo.prototype.append = function (g, m) {
    var base = this.count(), i;
    for (i = 0; i < g.count(); i++) {
      var p = [g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]], n = [g.N[i * 3], g.N[i * 3 + 1], g.N[i * 3 + 2]];
      if (m) { p = M4.point(m, p); n = M4.dir(m, n); }
      this.P.push(p[0], p[1], p[2]); this.N.push(n[0], n[1], n[2]);
      this.T.push(g.T[i * 2], g.T[i * 2 + 1]); this.C.push(g.C[i * 4], g.C[i * 4 + 1], g.C[i * 4 + 2], g.C[i * 4 + 3]);
    }
    for (i = 0; i < g.I.length; i++) this.I.push(g.I[i] + base);
  };
  /** Low-poly copy: every triangle gets its own three vertices + face normal; colour value jittered a few % per face
      (deterministic) so planar facets read even under flat light. */
  Geo.prototype.toFlat = function (jitter) {
    var out = new Geo(), P = this.P, T = this.T, C = this.C, I = this.I, j = jitter == null ? 0.05 : jitter, seed = 1234567;
    for (var k = 0; k < I.length; k += 3) {
      var a = I[k], b = I[k + 1], c = I[k + 2];
      var ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
      var e1 = [P[b * 3] - ax, P[b * 3 + 1] - ay, P[b * 3 + 2] - az], e2 = [P[c * 3] - ax, P[c * 3 + 1] - ay, P[c * 3 + 2] - az];
      var n = cross(e1, e2), nl = len(n);
      if (nl < 1e-14) continue;                                   // degenerate (cap centre slivers): drop
      n = [n[0] / nl, n[1] / nl, n[2] / nl];
      seed = (seed * 1664525 + 1013904223) >>> 0;
      var f = 1 + (seed / 4294967296 - 0.5) * 2 * j;
      [a, b, c].forEach(function (vi) {
        out.P.push(P[vi * 3], P[vi * 3 + 1], P[vi * 3 + 2]); out.N.push(n[0], n[1], n[2]); out.T.push(T[vi * 2], T[vi * 2 + 1]);
        out.C.push(C[vi * 4] * f, C[vi * 4 + 1] * f, C[vi * 4 + 2] * f, C[vi * 4 + 3]);
      });
      var base = out.P.length / 3 - 3;
      out.I.push(base, base + 1, base + 2);
    }
    return out;
  };
  Geo.prototype.bounds = function () {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < this.P.length; i += 3) for (var k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], this.P[i + k]); mx[k] = Math.max(mx[k], this.P[i + k]); }
    return { min: mn, max: mx };
  };
  Geo.prototype.toArrays = function () {
    var nv = this.count(), big = nv > 65535;
    return {
      positions: new Float32Array(this.P), normals: new Float32Array(this.N), uvs: new Float32Array(this.T),
      colors: new Float32Array(this.C), indices: big ? new Uint32Array(this.I) : new Uint16Array(this.I),
      vertexCount: nv, triangleCount: this.I.length / 3
    };
  };

  /* ==================================================================
     Build -> interior palette + cabin layout (pure)
     ================================================================== */
  var STYLE_FALLBACK = {
    coupe: { length_mm: 4550, height_mm: 1300, width_mm: 1930, beltline: 0.68, noseHeight: 0.46, windshieldRake_deg: 62, archStyle: 'flared' },
    sedan: { length_mm: 4950, height_mm: 1440, width_mm: 1900, beltline: 0.66, noseHeight: 0.50, windshieldRake_deg: 60, archStyle: 'round' },
    hatchback: { length_mm: 4250, height_mm: 1450, width_mm: 1800, beltline: 0.64, noseHeight: 0.52, windshieldRake_deg: 58, archStyle: 'flared' },
    wagon: { length_mm: 4980, height_mm: 1470, width_mm: 1950, beltline: 0.65, noseHeight: 0.50, windshieldRake_deg: 60, archStyle: 'flared' },
    suv: { length_mm: 4950, height_mm: 1760, width_mm: 2000, beltline: 0.62, noseHeight: 0.56, windshieldRake_deg: 54, archStyle: 'square' },
    roadster: { length_mm: 4100, height_mm: 1240, width_mm: 1780, beltline: 0.70, noseHeight: 0.44, windshieldRake_deg: 64, archStyle: 'flared', openTop: true },
    pickup: { length_mm: 5900, height_mm: 1960, width_mm: 2080, beltline: 0.60, noseHeight: 0.58, windshieldRake_deg: 52, archStyle: 'square' },
    hypercar: { length_mm: 4700, height_mm: 1150, width_mm: 2050, beltline: 0.70, noseHeight: 0.38, windshieldRake_deg: 68, archStyle: 'flared' },
    'shooting-brake': { length_mm: 4800, height_mm: 1360, width_mm: 1950, beltline: 0.67, noseHeight: 0.46, windshieldRake_deg: 62, archStyle: 'flared' },
    van: { length_mm: 5300, height_mm: 1950, width_mm: 2000, beltline: 0.55, noseHeight: 0.50, windshieldRake_deg: 40, archStyle: 'round' }
  };
  function styleSvg(id) {
    var st = null;
    try { if (CB.data && typeof CB.data.find === 'function') st = CB.data.find('bodyStyles', id); } catch (e) { st = null; }
    var fb = STYLE_FALLBACK[id] || STYLE_FALLBACK.coupe, svg = (st && st.svg) || {}, out = {};
    var k;
    for (k in fb) out[k] = fb[k];
    for (k in svg) if (svg[k] != null) out[k] = svg[k];
    return out;
  }

  /** sRGB hex/array -> linear rgb (vertex colours are fed straight into linear lighting). */
  function lin(c, gamma) { var g = gamma === false ? 1 : 2.2; return [Math.pow(c[0], g), Math.pow(c[1], g), Math.pow(c[2], g)]; }

  var UPHOLSTERY = {
    cloth: { rough: 0.95, sheen: 0, perf: 0 }, tartan: { rough: 0.92, sheen: 0, perf: 0 }, vegan: { rough: 0.9, sheen: 0, perf: 0 },
    leather: { rough: 0.55, sheen: 0.06, perf: 0 }, alcantara: { rough: 0.97, sheen: 0, perf: 0 }, nappa: { rough: 0.5, sheen: 0.08, perf: 1 },
    'carbon-weave': { rough: 0.5, sheen: 0.06, perf: 0 }, 'semi-aniline': { rough: 0.46, sheen: 0.1, perf: 0 }
  };
  /** trim id -> look: texture kind + material response + uv scale (uv per metre) */
  var TRIMS = {
    aluminum: { tex: 'knurl', color: '#b9bcc0', metallic: 1, rough: 0.34, clear: 0, uv: 14 },
    'piano-black': { tex: null, color: '#050506', metallic: 0, rough: 0.08, clear: 1, uv: 1 },
    'gloss-walnut': { tex: 'burl', color: '#ffffff', metallic: 0, rough: 0.18, clear: 1, uv: 2.2 },
    'open-pore-wood': { tex: 'ash', color: '#ffffff', metallic: 0, rough: 0.62, clear: 0, uv: 2.6 },
    carbon: { tex: 'carbon', color: '#ffffff', metallic: 0.25, rough: 0.28, clear: 0.9, uv: 22 },
    'forged-carbon': { tex: 'forged', color: '#ffffff', metallic: 0.2, rough: 0.3, clear: 0.9, uv: 7 },
    'brushed-titanium': { tex: 'brushed', color: '#9a958e', metallic: 1, rough: 0.4, clear: 0, uv: 6 }
  };
  /** Flat (untextured) colour per trim for the low-poly interior. */
  var TRIM_FLAT = { aluminum: '#b9bcc0', 'piano-black': '#050506', 'gloss-walnut': '#5e3418', 'open-pore-wood': '#a88a66', carbon: '#23262b',
    'forged-carbon': '#2e3034', 'brushed-titanium': '#8f8a84' };
  var SEATS = {
    comfort: { bolster: 0.035, shell: false, wing: 0, back: 0.62, head: 'separate' },
    sport: { bolster: 0.07, shell: false, wing: 0.02, back: 0.64, head: 'separate' },
    lounge: { bolster: 0.03, shell: false, wing: 0, back: 0.66, head: 'separate' },
    bucket: { bolster: 0.1, shell: false, wing: 0.04, back: 0.7, head: 'integrated' },
    'carbon-bucket': { bolster: 0.12, shell: true, wing: 0.06, back: 0.72, head: 'integrated' },
    'race-shell': { bolster: 0.14, shell: true, wing: 0.1, back: 0.76, head: 'halo' }
  };

  function palette(build, opts) {
    build = build || {}; opts = opts || {};
    var I = build.interior || {}, X = build.exterior || {}, Wt = build.weight || {};
    var gam = opts.gammaVertexColors !== false;
    var prim = hexRgb(I.primaryColor, '#1a1a1a'), acc = hexRgb(I.accentColor, '#b3121f'), stitch = hexRgb(I.stitchColor, I.accentColor || '#b3121f');
    var amb = hexRgb(I.ambientColor, '#ff3344'), paint = hexRgb(X.paint, '#b3121f');
    var up = UPHOLSTERY[I.upholstery] || UPHOLSTERY.leather;
    var trim = TRIMS[I.trim] || TRIMS.aluminum;
    var liner = I.headliner === 'leather' ? mix(prim, [0.12, 0.12, 0.12], 0.3) : I.headliner === 'alcantara' ? mix(prim, [0.09, 0.09, 0.095], 0.65) : [0.42, 0.41, 0.39];
    // the dash top pad is darker than the seats to avoid windscreen reflections; doors take the primary colour
    var dashTop = luma(prim) > 0.35 ? mix(prim, [0.06, 0.06, 0.065], 0.72) : mix(prim, [0.04, 0.04, 0.045], 0.35);
    var suit = hexRgb(opts.color || X.paint, '#b3121f');
    var cage = Wt.rollCage === 'full' ? [0.86, 0.86, 0.84] : [0.2, 0.205, 0.215];
    var mirrorCol = X.mirrors === 'black' ? [0.03, 0.03, 0.033] : X.mirrors === 'carbon' ? [1, 1, 1] : paint;
    function L(c) { return gam ? lin(c) : c.slice(0, 3); }
    return {
      gamma: gam, L: L,
      primary: L(prim), primaryS: prim, accent: L(acc), accentS: acc, stitch: L(stitch), stitchS: stitch,
      ambient: amb, ambientOn: !!I.ambientLighting,
      dashTop: L(dashTop), door: L(mix(prim, [0.05, 0.05, 0.05], 0.15)), insert: L(mix(prim, acc, 0.18)),
      liner: L(liner), linerRough: I.headliner === 'leather' ? 0.6 : I.headliner === 'cloth' ? 0.98 : 0.96,
      plastic: L([0.055, 0.056, 0.06]), plasticHi: L([0.11, 0.112, 0.118]), rubber: L([0.025, 0.025, 0.027]), carpet: L([0.05, 0.05, 0.052]),
      metal: L([0.72, 0.73, 0.75]), metalDark: L([0.3, 0.31, 0.33]), chrome: L([0.92, 0.92, 0.93]),
      paint: L(paint), paintS: paint, mirror: L(mirrorCol), mirrorCarbon: X.mirrors === 'carbon',
      suit: L(mix(suit, [0.05, 0.05, 0.06], 0.72)), glove: L([0.2, 0.2, 0.215]), gloveAccent: L(acc), gloveCuff: L(mix(acc, [0.9, 0.9, 0.9], 0.2)),
      cage: L(cage), pad: L([0.03, 0.03, 0.032]), harness: L(mix(acc, [0.7, 0.05, 0.05], 0.15)),
      upholstery: up, upholsteryId: UPHOLSTERY[I.upholstery] ? I.upholstery : 'leather', trim: trim, trimId: I.trim || 'aluminum', trimColor: L(hexRgb(trim.color)),
      tint: clamp(num(X.windowTint_pct, 20) / 100, 0, 0.85),
      finish: X.finish || 'metallic'
    };
  }

  function paintResponse(finish) {
    switch (finish) {
      case 'matte': case 'satin-matte': return { metallic: 0.15, rough: 0.62, clear: 0 };
      case 'satin': return { metallic: 0.35, rough: 0.4, clear: 0.2 };
      case 'chrome': return { metallic: 1, rough: 0.05, clear: 0.3 };
      case 'gloss': case 'solid': return { metallic: 0, rough: 0.25, clear: 1 };
      case 'pearl': return { metallic: 0.45, rough: 0.28, clear: 1 };
      case 'chameleon': return { metallic: 0.8, rough: 0.22, clear: 1 };
      default: return { metallic: 0.6, rough: 0.3, clear: 1 };
    }
  }

  /**
   * Cabin layout around the driver's eye (car-local). Everything the geometry, the gauges and the camera need.
   * opts: { eye, dims: {length,width,height,wheelbase,rideHeight,belt,roof} }
   */
  function layout(build, opts) {
    build = build || {}; opts = opts || {};
    var B = build.body || {}, I = build.interior || {}, T = build.tech || {}, Wt = build.weight || {}, Tr = build.transmission || {};
    var style = String(B.style || 'coupe'), svg = styleSvg(style), dims = opts.dims || {};
    var Lc = clamp(num(dims.length, num(svg.length_mm, 4550) / 1000), 2.8, 7.5);
    var Wc = clamp(num(dims.width, num(svg.width_mm, 1930) / 1000), 1.4, 2.6);
    var Hc = clamp(num(dims.height, num(svg.height_mm, 1300) / 1000), 0.9, 2.4);
    var ride = clamp(num(dims.rideHeight, num((build.suspension || {}).rideHeight_mm, 120) / 1000), 0.03, 0.4);
    var wb = clamp(num(dims.wheelbase, num(B.wheelbase_mm, 2650) / 1000), 2, 4.2);
    var open = !!svg.openTop || style === 'roadster';
    var seats = clamp(Math.round(num(B.seats, 2)), 1, 9);
    var upright = style === 'suv' || style === 'van' || style === 'pickup';
    var eye = opts.eye && opts.eye.length >= 3 && isFinite(opts.eye[0]) && isFinite(opts.eye[1]) && isFinite(opts.eye[2])
      ? [+opts.eye[0], +opts.eye[1], +opts.eye[2]]
      : [-Lc * 0.06 + (style === 'hypercar' ? 0.15 : 0), Math.min(ride + Hc * 0.74, Hc - 0.17), seats === 1 ? 0 : -Wc * 0.2];
    var ex = eye[0], ey = eye[1], ez = eye[2];
    var sd = ez < -0.02 ? -1 : ez > 0.02 ? 1 : -1;             // driver side sign (-1: left-hand drive)
    var Wi = Wc / 2 - 0.115;                                     // inner half width at the shoulder
    var floorY = Math.max(ride + 0.1, ey - clamp(0.66 + (Hc - 1.25) * 0.55, 0.6, 1.02));
    // dashboard
    var xd = ex + (upright ? 0.62 : 0.66), yd = ey - (upright ? 0.33 : 0.3);
    var yb = yd + 0.005;
    var yR = open ? ey + 0.12 : clamp(num(dims.roof, Hc) - 0.05, ey + 0.15, ey + 0.36);
    var rake = clamp(num(svg.windshieldRake_deg, 60), 30, 72) * DEG, tr = Math.tan(rake);
    var xh = ex + (upright ? 0.5 : 0.42), xb = xh + (yR - yb) * tr;
    var xbMax = ex + 1.48, xbMin = xd + 0.22;
    if (xb > xbMax) { xb = xbMax; xh = Math.max(ex + 0.1, xb - (yR - yb) * tr); }
    if (xb < xbMin) { xb = xbMin; }
    var yBelt = clamp(num(svg.beltline, 0.66) * Hc, ey - 0.44, ey - 0.17);
    if (open) yBelt = Math.min(yBelt, ey - 0.24);
    var xBp = ex - 0.36;                                         // B-pillar
    var twoRows = seats > 2 && Wt.rearSeats !== false && Wt.rollCage !== 'full';
    var xRear = Math.max(-Lc / 2 + 0.55, twoRows ? ex - (upright ? 1.65 : 1.4) : ex - 0.72);
    var xRoofRear = Math.min(xBp - 0.15, xRear + (upright ? 0.12 : 0.34));
    // steering wheel
    var stype = I.steering === 'flat-bottom' || I.steering === 'yoke' || I.steering === 'race-quick-release' ? I.steering : 'round';
    var wR = stype === 'race-quick-release' ? 0.152 : stype === 'yoke' ? 0.172 : stype === 'flat-bottom' ? 0.182 : 0.188;
    var tilt = upright ? 0.5 : stype === 'race-quick-release' ? 0.26 : 0.36;
    var wc = [ex + (stype === 'race-quick-release' ? 0.45 : 0.48), ey - 0.345, ez];
    // instrument cluster (in the binnacle recess)
    var digital = T.digitalCluster !== false;
    var cl = { c: [xd + 0.065, yd - 0.04, ez], w: digital ? 0.31 : 0.3, h: 0.118, px: [1024, 390] };
    // centre screen
    var sIn = num(T.screen_in, 12), scr = null;
    if (sIn > 0) {
      var portrait = sIn >= 15, wide = sIn >= 12 && !portrait;
      var asp = portrait ? 0.78 : wide ? 2.55 : 16 / 9;
      var diag = (sIn === 12 ? 12.3 : sIn) * 0.0254;
      var sw = diag * asp / Math.sqrt(1 + asp * asp), sh = diag / Math.sqrt(1 + asp * asp);
      var top = yd - 0.018;
      scr = { c: [xd - 0.004 - (portrait ? 0.02 : 0), top - sh / 2, sd * -0.012], w: sw, h: sh, portrait: portrait, size: sIn,
        px: portrait ? [400, Math.round(400 / asp)] : [Math.round(Math.min(1024, 360 * asp)), 360] };
      scr.px[0] = Math.round(scr.px[0]); scr.px[1] = Math.round(scr.px[1]);
    }
    var hud = T.hud ? { c: [ex + 2.3, ey - 0.21, ez], w: 0.6, h: 0.244, px: [512, 208] } : null;   // ~5 deg below the eye line
    // rear-view mirror (centre, below the header)
    // Hang it ~15 deg above the eye line (solved against the windshield plane x(y) = xh + (yR - y) * tan(rake)) so it
    // stays inside the cockpit camera's frustum instead of hiding in the header band; never above the old spot.
    var tanA = Math.tan(15 * DEG);
    var ymA = (ey + tanA * (xh + yR * tr - 0.075 - ex)) / (1 + tanA * tr);
    var ym = clamp(ymA, Math.max(ey + 0.05, yR - 0.24), yR - (open ? 0.02 : 0.08)), xmGlass = xh + (yR - ym) * tr - 0.075;
    var mpos = [open ? Math.min(xmGlass, xb - 0.12) : xmGlass, ym, 0];
    // Inboard toward the driver: hung on the car centreline with a LHD/RHD eye ~0.38 m off-axis, the mirror lands
    // 35-45 deg to the side, i.e. at the screen's top corner under the HUD timing tower (and half off-screen for
    // cab-forward cars). Offset it so its centre sits <= ~17 deg off the view axis (the stalk angles back to the
    // centreline mount), and shrink it when the glass is close so it never subtends more than ~21 deg.
    var mdx = Math.max(0.2, mpos[0] - ex), mOff = Math.min(Math.abs(ez), Math.max(0, Math.abs(ez) - mdx * Math.tan(17 * DEG)));
    mpos[2] = ez < 0 ? -mOff : ez > 0 ? mOff : 0;
    var mDist = len(sub(mpos, eye)), mW = clamp(2 * mDist * Math.tan(10.5 * DEG), 0.15, 0.25);
    var toEye = norm(sub(eye, mpos)), mn = norm(add(toEye, [-1, 0, 0]));
    var mirror = { pos: mpos, normal: mn, up: [0, 1, 0], width: mW, height: mW * 0.288, fovY: 17, mount: [mpos[0], ym, mpos[2] * 0.45] };
    // side mirrors (outside, behind the A-pillar base)
    function sideMirror(s) {
      var p = [xb - 0.16, yBelt + 0.1, s * (Wc / 2 + 0.085)];
      var n = norm(add(norm(sub(eye, p)), [-1.2, 0, 0]));
      return { pos: p, normal: n, width: 0.18, height: 0.1, side: s };
    }
    var cage = Wt.rollCage === 'full' || Wt.rollCage === 'half' ? Wt.rollCage : 'none';
    if (open && cage === 'none') cage = 'hoops';
    var trans = Tr.type || 'dct';
    var paddles = trans === 'dct' || trans === 'auto' || trans === 'sequential' || trans === 'cvt';
    var shoulders = [[ex - 0.1, ey - 0.3, ez - 0.2], [ex - 0.1, ey - 0.3, ez + 0.2]];
    return {
      style: style, svg: svg, open: open, upright: upright, seats: seats, twoRows: twoRows,
      eye: eye, ex: ex, ey: ey, ez: ez, sd: sd, L: Lc, W: Wc, H: Hc, ride: ride, wb: wb, Wi: Wi, floorY: floorY,
      xd: xd, yd: yd, xb: xb, yb: yb, xh: xh, yR: yR, rake: rake, yBelt: yBelt, xBp: xBp, xRear: xRear, xRoofRear: xRoofRear,
      wheel: { type: stype, c: wc, R: wR, tilt: tilt, ratio: stype === 'race-quick-release' ? 9.5 : stype === 'yoke' ? 7 : 12 },
      cluster: cl, digital: digital, screen: scr, hud: hud, mirror: mirror, sideMirrors: [sideMirror(-1), sideMirror(1)],
      cage: cage, harness: !!I.harness, seatType: SEATS[I.seatType] ? I.seatType : 'sport', trans: trans, paddles: paddles,
      manual: trans === 'manual', sequential: trans === 'sequential', ev: (build.engine || {}).type === 'ev',
      shoulders: shoulders, sunroof: (build.exterior || {}).roof === 'glass' && !open,
      starlight: I.headliner === 'leather' && !!I.ambientLighting && !open,
      // front wheel arch (car-local; from CB.gl.car dims when supplied) so the hood can hump over the tyres
      axleF: clamp(num(dims.frontAxle, wb / 2), 0.6, Lc / 2 - 0.3),
      wheelR: clamp(num(dims.wheelRadiusFront, num(dims.wheelRadius, 0.33)), 0.22, 0.6),
      trackF: clamp(num(dims.track, Wc - 0.32), 1.1, Wc),
      tireW: clamp(num(dims.tireWidthFront, 0.245), 0.15, 0.4),
      // rear wheel arch (for the trimmed arch humps in the rear cabin; the car-mesh arch liner pokes through otherwise)
      axleR: clamp(num(dims.rearAxle, -wb / 2), -Lc / 2 + 0.3, 0),
      wheelRR: clamp(num(dims.wheelRadiusRear, num(dims.wheelRadius, 0.33)), 0.22, 0.6),
      tireWR: clamp(num(dims.tireWidthRear, num(dims.tireWidthFront, 0.265)), 0.15, 0.45),
      nearPlane: 0.03
    };
  }

  /** steerAngle (rad, + = left) -> steering wheel rotation about the column (rad, + = top of rim to +Z / right). */
  function steerWheelAngle(steerAngle, type, ratio) {
    var a = num(steerAngle, 0), r = num(ratio, 12);
    var rot;
    if (type === 'yoke') {
      // steer-by-wire: quicker ratio near centre falling off, never beyond ~165 deg
      rot = -2.9 * Math.tanh(a * r / 2.9);
    } else rot = -a * r;
    var lim = type === 'yoke' ? 2.9 : type === 'race-quick-release' ? 4.4 : 7.6;
    return clamp(rot, -lim, lim);
  }

  /* ==================================================================
     Geometry (pure): buildGeometry(build, layout, palette) -> {
       groups: {name: Geo}  static car-local groups (one material each)
       wheel:  {name: Geo}  wheel-local groups (rim in the YZ plane, driver face toward -X)
       hands:  [Geo, Geo]   wheel-local gloves (left, right) + wrist anchors
       arms:   {upper: Geo, fore: Geo} unit sleeves along +X (radius 1)
       lever:  Geo|null     gear lever in pivot-local space, leverPivot
       panels: {cluster, screen, hud, mirror, wheelDisplay}: textured quads
     }
     ================================================================== */
  function catmull(pts, seg, closed) {
    seg = lpSides(seg || 4, 2);
    var out = [], n = pts.length, i, k;
    if (n < 3) return pts.slice();
    var last = closed ? n : n - 1;
    for (i = 0; i < last; i++) {
      var p0 = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[closed ? (i + 2) % n : Math.min(n - 1, i + 2)];
      for (k = 0; k < seg; k++) {
        var t = k / seg, t2 = t * t, t3 = t2 * t, q = [];
        for (var c = 0; c < p1.length; c++) {
          q.push(0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3));
        }
        out.push(q);
      }
    }
    if (!closed) out.push(pts[n - 1].slice());
    return out;
  }
  /** Display-style frame facing `toward` with a level top edge: {n, right, up}. */
  function faceFrame(c, toward, blendBack) {
    var n = norm(sub(toward, c));
    if (blendBack) n = norm(vlerp(n, norm([-1, 0.3, 0]), blendBack));
    var right = norm(cross([0, 1, 0], n));
    if (!isFinite(right[0]) || len(cross([0, 1, 0], n)) < 1e-4) right = [0, 0, 1];
    return { n: n, right: right, up: cross(n, right) };
  }
  /** Textured panel: u=1 toward `right`, v=1 at the top (matches canvas textures uploaded with FLIP_Y). */
  function panel(g, c, F, w, h, uv) {
    var r = mul(F.right, w / 2), u = mul(F.up, h / 2);
    uv = uv || [0, 0, 1, 1];   // [u0, v0, u1, v1]
    g.quad4(sub(sub(c, r), u), sub(add(c, r), u), add(add(c, r), u), add(sub(c, r), u), [uv[0], uv[3], uv[2], uv[1]]);
  }
  function frameMat(F, c) { return M4.basis(mul(F.n, -1), F.up, F.right, c); }   // local +X into the panel, +Y up, +Z right

  function buildGeometry(build, Lay, P) {
    build = build || {};
    Lay = Lay || layout(build, {}); P = P || palette(build, {});
    var groups = {}, wheel = {};
    function G(name) { return groups[name] || (groups[name] = new Geo()); }
    function WG(name) { return wheel[name] || (wheel[name] = new Geo()); }
    var Lx = Lay, ex = Lx.ex, ey = Lx.ey, ez = Lx.ez, sd = Lx.sd, Wi = Lx.Wi, xd = Lx.xd, yd = Lx.yd, xb = Lx.xb, yb = Lx.yb;
    var xh = Lx.xh, yR = Lx.yR, yBelt = Lx.yBelt, floorY = Lx.floorY, xBp = Lx.xBp, eye = Lx.eye, tr = Math.tan(Lx.rake);
    var trimUV = P.trim.uv || 4;
    var rng = (function (seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; })(9137);

    /* ---------------- dashboard profile (10 points, top-front -> footwell), blended per z */
    var wsHalfBase = Wi - 0.005, wsHalfTop = Wi - 0.075;
    function wB(z) { return 1 - smoothstep(0.165, 0.235, Math.abs(z - ez)); }
    function wC(z) { return Lx.seats === 1 ? 0 : 1 - smoothstep(0.13, 0.2, Math.abs(z)); }
    function dashProfile(z) {
      var b = wB(z), c = wC(z) * (1 - b), az = Math.abs(z) / Wi, endK = smoothstep(0.86, 1, az);
      var xA = xb - 0.03 - endK * 0.05, yA = yb - 0.008;
      var N = [[xA, yA], [lerp(xd, xA, 0.45), yd + 0.024], [xd + 0.06, yd + 0.02], [xd, yd], [xd + 0.008, yd - 0.03], [xd + 0.02, yd - 0.08],
        [xd + 0.045, yd - 0.16], [xd + 0.03, yd - 0.26], [xd - 0.04, yd - 0.4], [xd + 0.22, Math.max(floorY + 0.12, yd - 0.52)]];
      var Bn = [[xA, yA], [lerp(xd, xA, 0.4), yd + 0.075], [xd + 0.02, yd + 0.088], [xd - 0.032, yd + 0.074], [xd - 0.012, yd + 0.05], [xd + 0.072, yd + 0.036],
        [xd + 0.078, yd - 0.115], [xd - 0.0, yd - 0.165], [xd - 0.035, yd - 0.33], [xd + 0.22, Math.max(floorY + 0.12, yd - 0.52)]];
      var Cn = [[xA, yA], [lerp(xd, xA, 0.45), yd + 0.02], [xd + 0.05, yd + 0.016], [xd - 0.006, yd - 0.002], [xd - 0.004, yd - 0.04], [xd - 0.006, yd - 0.1],
        [xd - 0.012, yd - 0.2], [xd - 0.04, yd - 0.29], [xd - 0.13, yd - 0.39], [xd + 0.1, Math.max(floorY + 0.12, yd - 0.5)]];
      var out = [];
      for (var i = 0; i < 10; i++) {
        var x = N[i][0] + b * (Bn[i][0] - N[i][0]) + c * (Cn[i][0] - N[i][0]);
        var y = N[i][1] + b * (Bn[i][1] - N[i][1]) + c * (Cn[i][1] - N[i][1]);
        if (i > 0 && i < 8) { y -= endK * 0.03; x += endK * 0.02; }
        out.push([x, y, z]);
      }
      return out;
    }
    function faceXAt(z, y) {
      var p = dashProfile(z);
      for (var i = 3; i < 9; i++) {
        var a = p[i], b = p[i + 1];
        if ((y <= a[1] && y >= b[1]) || (y >= a[1] && y <= b[1])) return lerp(a[0], b[0], (y - a[1]) / ((b[1] - a[1]) || 1e-6));
      }
      return p[5][0];
    }
    // z stations: dense around the binnacle and the centre stack edges
    var zs = [], nz = LOWPOLY ? 20 : 44;
    for (var i = 0; i <= nz; i++) zs.push(lerp(-Wi * 0.995, Wi * 0.995, i / nz));
    [ez - 0.235, ez - 0.2, ez - 0.165, ez + 0.165, ez + 0.2, ez + 0.235, -0.2, -0.165, -0.13, 0.13, 0.165, 0.2].forEach(function (z) { if (Math.abs(z) < Wi * 0.99) zs.push(z); });
    zs.sort(function (a, b) { return a - b; });
    zs = zs.filter(function (z, k) { return k === 0 || z - zs[k - 1] > 0.008; });
    var dashRings = zs.map(dashProfile);
    var soft = G('soft');
    soft.loft(dashRings, {
      closed: false, uScale: 3.5, vScale: 3.5, inside: function (k) { return [xd + 0.34, yd - 0.12, soft.P[k * 3 + 2]]; },
      colors: function (r, j) {
        var z = zs[r], b = wB(z);
        if (j <= 3) return P.dashTop.concat(1);
        if (b > 0.5 && j >= 4 && j <= 6) return P.plastic.concat(1);
        if (j >= 9) return P.carpet.concat(1);
        if (j === 4) return P.dashTop.concat(1);
        return P.door.concat(1);
      }
    });
    // dash-end caps toward the doors
    [-1, 1].forEach(function (s) {
      var ring = dashProfile(s * Wi * 0.995), ctr = [xd + 0.25, yd - 0.15, s * Wi * 0.995];
      soft.setColor(P.door);
      var ci = soft.v(ctr, [0, 0, s], 0, 0), base = soft.count();
      ring.forEach(function (p) { soft.v(p, [0, 0, s], 0, 0); });
      for (var j = 0; j < ring.length - 1; j++) { if (s > 0) soft.tri(ci, base + j, base + j + 1); else soft.tri(ci, base + j + 1, base + j); }
    });

    /* ---------------- stitching along the dash lip (dashes) + binnacle hood */
    function stitchLine(g, pts, color, dash, gap, size) {
      g.setColor(color);
      var acc = 0, on = true;
      for (var k = 0; k < pts.length - 1; k++) {
        var a = pts[k], b = pts[k + 1], d = len(sub(b, a)), t = 0;
        while (t < d) {
          var step = Math.max(1e-4, Math.min(on ? dash : gap, d - t));
          if (on && step > dash * 0.4) {
            var p0 = vlerp(a, b, t / d), p1 = vlerp(a, b, (t + step) / d);
            if (LOWPOLY) {
              // one flat facet per stitch, turned to the driver (2 tris instead of a 12-tri beam)
              var dd = norm(sub(p1, p0)), wv = cross(dd, norm(sub(eye, p0)));
              wv = len(wv) < 1e-6 ? anyPerp(dd) : mul(norm(wv), size * 0.5);
              g.quad4(sub(p0, wv), sub(p1, wv), add(p1, wv), add(p0, wv));
            } else g.beam(p0, p1, size, size * 0.7, [0, 1, 0]);
          }
          t += step; acc += step;
          if (step >= (on ? dash : gap) - 1e-9) on = !on;
        }
      }
    }
    var lipPts = zs.filter(function (z) { return Math.abs(z) < Wi - 0.06; }).map(function (z) { var p = dashProfile(z)[3]; return [p[0] - 0.0015, p[1] + 0.006, z]; });
    stitchLine(G('soft'), lipPts, P.stitch, 0.007, 0.0055, 0.0024);

    /* ---------------- dash trim insert band + ambient strip (both sides of the binnacle / stack) */
    var bandTop = yd - 0.07, bandBot = yd - 0.118;
    function bandRange(z0, z1) {
      if (z1 - z0 < 0.05) return;
      var ringsT = [], ringsG = [], ringsM = [], n = Math.max(2, Math.ceil((z1 - z0) / 0.03));
      for (var k = 0; k <= n; k++) {
        var z = lerp(z0, z1, k / n);
        var xt = faceXAt(z, bandTop) - 0.007, xbm = faceXAt(z, bandBot) - 0.007;
        ringsT.push([[xt, bandTop, z], [xbm, bandBot, z]]);
        ringsG.push([[xt - 0.002, bandTop + 0.007, z], [xt - 0.001, bandTop + 0.0015, z]]);
        ringsM.push([[xbm - 0.001, bandBot - 0.001, z], [xbm + 0.001, bandBot - 0.006, z]]);
      }
      G('trim').loft(ringsT, { closed: false, inside: [xd + 0.5, yd - 0.1, 0], uScale: trimUV, vScale: trimUV });
      if (P.ambientOn) G('glow').loft(ringsG, { closed: false, inside: [xd + 0.5, yd - 0.1, 0] });
      G('metal').setColor(P.metal);
      G('metal').loft(ringsM, { closed: false, inside: [xd + 0.5, yd - 0.1, 0] });
    }
    var bL = ez - 0.25, bR = ez + 0.25, cL = -0.21, cR = 0.21;
    var segs = [[-Wi + 0.04, Math.min(bL, cL)]];
    if (bR < cL) segs.push([bR, cL]);
    segs.push([Math.max(bR, cR), Wi - 0.04]);
    if (cR < bL) segs.splice(1, 0, [cR, bL]);
    segs.forEach(function (sg) { bandRange(sg[0], sg[1]); });

    /* ---------------- binnacle: cluster panel + surround + hood stitching */
    var panels = {};
    var cl = Lx.cluster, clF = faceFrame(cl.c, eye, 0.15);
    panels.cluster = new Geo(); panel(panels.cluster, cl.c, clF, cl.w, cl.h);
    G('plastic').setColor(P.rubber);
    G('plastic').obox(madd(cl.c, clF.n, -0.012), clF.right, clF.up, clF.n, cl.w / 2 + 0.012, cl.h / 2 + 0.012, 0.01, 1, ['pz']);
    var hoodPts = [];
    for (var hz = -0.15; hz <= 0.1501; hz += 0.01) { var hp = dashProfile(ez + hz)[3]; hoodPts.push([hp[0] - 0.002, hp[1] + 0.004, ez + hz]); }
    stitchLine(G('soft'), hoodPts, P.stitch, 0.007, 0.005, 0.0024);
    // lit instrument bezel: a satin trim frame round the cluster glass with a thin backlit edge (gauge glow) inside it,
    // and a soft-touch visor lip under the hood edge so the binnacle reads as a sculpted pod, not a slot
    (function () {
      var fr = rectShape(cl.w + 0.022, cl.h + 0.022, 0.018, 4).map(function (q) { return madd(madd(madd(cl.c, clF.right, q[0]), clF.up, q[1]), clF.n, 0.003); });
      fr.push(fr[0]);
      G('trim').sweep(fr, { radius: 0.0034, sides: 6, uScale: trimUV, vScale: trimUV });
      var gl2 = rectShape(cl.w + 0.008, cl.h + 0.008, 0.012, 4).map(function (q) { return madd(madd(madd(cl.c, clF.right, q[0]), clF.up, q[1]), clF.n, 0.0015); });
      gl2.push(gl2[0]);
      var lit = P.L(mix(hexRgb(rgbHex(P.ambient)), [1, 1, 1], 0.35)).map(function (v) { return v * 0.55 + 0.05; });
      G('leds').setColor(lit);
      G('leds').sweep(gl2, { radius: 0.0011, sides: 4 });
      var lip = [];
      for (var lz = -0.5; lz <= 0.5001; lz += 0.0625) {
        var lc = madd(madd(madd(cl.c, clF.right, lz * (cl.w + 0.05)), clF.up, cl.h / 2 + 0.02 - 0.012 * lz * lz * 4), clF.n, 0.018);
        lip.push(lc);
      }
      G('soft').setColor(P.dashTop);
      G('soft').sweep(lip, { shape: rectShape(0.03, 0.012, 0.005, 2), up: clF.up, capStart: true, capEnd: true, uScale: 3.5, vScale: 3.5 });
      stitchLine(G('soft'), lip.map(function (q) { return madd(madd(q, clF.up, 0.0065), clF.n, 0.004); }), P.stitch, 0.006, 0.0045, 0.002);
    })();

    /* ---------------- centre screen + bezel, vents, climate panel */
    var scr = Lx.screen, ventY = yd - 0.085, stackTop = yd - 0.12;
    if (scr) {
      var sF = faceFrame(scr.c, eye, 0.45);
      scr.c[0] = Math.min(scr.c[0], faceXAt(scr.c[2], scr.c[1]) - 0.012);
      panels.screen = new Geo(); panel(panels.screen, scr.c, sF, scr.w, scr.h);
      G('plastic').setColor(P.rubber);
      G('plastic').obox(madd(scr.c, sF.n, -0.011), sF.right, sF.up, sF.n, scr.w / 2 + 0.008, scr.h / 2 + 0.008, 0.009, 1);
      G('metal').setColor(P.metalDark);
      G('metal').obox(madd(madd(scr.c, sF.up, -scr.h / 2 - 0.009), sF.n, -0.006), sF.right, sF.up, sF.n, scr.w / 2 + 0.008, 0.0025, 0.012, 1);
      scr.frame = sF;
      stackTop = scr.c[1] - scr.h / 2 - 0.02;
    }
    function roundVent(c, axis, r) {
      var met = G('metal'), pl = G('plastic');
      met.setColor(P.metal);
      met.ring(c, axis, r, 0.0055, 24, 8);
      pl.setColor(P.rubber);
      pl.cyl(madd(c, axis, -0.03), madd(c, axis, -0.002), r * 0.97, r * 0.97, 18, true);
      var F = faceFrame(c, add(c, axis));
      pl.setColor(P.plasticHi);
      for (var k = -1; k <= 1; k++) {
        var yc = madd(madd(c, F.up, k * r * 0.5), axis, -0.008);
        var hw = Math.sqrt(Math.max(0, r * r - (k * r * 0.5) * (k * r * 0.5))) * 0.95;
        pl.obox(yc, F.right, F.up, F.n, hw, 0.0018, 0.006, 1);
      }
      met.setColor(P.chrome);
      met.cyl(madd(c, axis, -0.006), madd(c, axis, 0.004), 0.0075, 0.0075, 12, true);
    }
    function ventAt(z, y, faceK) {
      // seat the bezel on the cabin-most (lowest x) point of the dash face under the ring so no part of the torus
      // sinks into a curved / bending face (outboard vents sit where the dash rolls into the door)
      var r = 0.034, x = Infinity;
      for (var a = 0; a < 8; a++) x = Math.min(x, faceXAt(z + Math.cos(a * PI / 4) * (r + 0.006), y + Math.sin(a * PI / 4) * (r + 0.006)));
      x -= 0.004;
      var c = [x, y, z];
      roundVent(c, norm(vlerp(norm(sub(eye, c)), [-1, 0, 0], faceK == null ? 0.5 : faceK)), r);
    }
    // outboard vents: inboard of the dash-end roll-off (endK ramps from 0.86 Wi) and facing mostly straight back, so
    // the bezel is not tilted into the door-side dash face
    var zVo = Math.min(Wi - 0.16, Wi * 0.86 - 0.045);
    ventAt(sd * zVo, ventY, 0.8);
    ventAt(-sd * zVo, ventY, 0.8);
    if (Lx.seats !== 1) {
      var cvY = scr && !scr.portrait ? Math.min(ventY, stackTop - 0.04) : ventY;
      if (scr && scr.portrait) { ventAt(-0.15 * -sd, yd - 0.06); }
      else { ventAt(-0.075, cvY); ventAt(0.075, cvY); stackTop = cvY - 0.045; }
      // climate / switch panel (trim) with knobs + toggles + hazard
      var cpY0 = stackTop, cpY1 = Math.max(stackTop - 0.11, yd - 0.3), rgs = [];
      for (var cz = -0.12; cz <= 0.1201; cz += 0.04) {
        rgs.push([[faceXAt(cz, cpY0) - 0.006, cpY0, cz], [faceXAt(cz, cpY1) - 0.006, cpY1, cz]]);
      }
      if (cpY0 - cpY1 > 0.03) {
        G('trim').loft(rgs, { closed: false, inside: [xd + 0.5, yd - 0.2, 0], uScale: trimUV, vScale: trimUV });
        var ky = lerp(cpY0, cpY1, 0.42);
        [-0.075, 0, 0.075].forEach(function (kz, ki) {
          var c = [faceXAt(kz, ky) - 0.008, ky, kz], ax = norm(vlerp(norm(sub(eye, c)), [-1, 0, 0], 0.4));
          G('metal').setColor(P.metal);
          G('metal').cyl(c, madd(c, ax, ki === 1 ? 0.012 : 0.02), ki === 1 ? 0.012 : 0.017, ki === 1 ? 0.012 : 0.016, 18, true);
          if (ki !== 1) { G('leds').setColor(P.L(P.ambient).map(function (v) { return v * 0.8 + 0.1; })); G('leds').ring(madd(c, ax, 0.0005), ax, 0.0185, 0.0012, 18, 4); }
        });
        // toggle row
        var ty = lerp(cpY0, cpY1, 0.82);
        for (var tz = -0.08; tz <= 0.0801; tz += 0.032) {
          var tc = [faceXAt(tz, ty) - 0.008, ty, tz], ta = norm(vlerp(norm(sub(eye, tc)), [-1, 0, 0], 0.4));
          G('metal').setColor(P.chrome);
          G('metal').cyl(tc, madd(madd(tc, ta, 0.018), [0, 1, 0], 0.006), 0.0028, 0.0022, 8, true);
          G('plastic').setColor(P.plasticHi);
          G('plastic').cyl(madd(tc, ta, -0.002), madd(tc, ta, 0.002), 0.008, 0.008, 12, true);
        }
        var hzc = [faceXAt(0, lerp(cpY0, cpY1, 0.12)) - 0.008, lerp(cpY0, cpY1, 0.12), 0];
        G('leds').setColor([0.85, 0.06, 0.03]);
        G('leds').obox(hzc, [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.004, 0.007, 0.012, 1);
      }
    }

    /* ---------------- steering column + stalks (static) */
    var W0 = Lx.wheel, wc = W0.c, ax = [Math.cos(W0.tilt), -Math.sin(W0.tilt), 0];
    G('plastic').setColor(P.plastic);
    G('plastic').cyl(madd(wc, ax, 0.05), madd(wc, ax, 0.36), 0.04, 0.058, 16, true);
    G('plastic').setColor(P.plasticHi);
    [-1, 1].forEach(function (s) {
      var b0 = add(madd(wc, ax, 0.075), [0, 0.01, s * 0.035]);
      G('plastic').cyl(b0, add(b0, [-0.02, -0.012, s * 0.13]), 0.0075, 0.0055, 8, true);
    });

    /* ---------------- console */
    var ycTop = Math.max(floorY + 0.2, ey - 0.62), cw = Lx.seats === 1 ? 0 : 0.125;
    var consoleX0 = xd - 0.1, consoleX1 = ex - 0.45;
    function consoleTopAt(x) {
      var t = clamp((x - (ex + 0.12)) / (consoleX0 - (ex + 0.12)), 0, 1);
      var y = lerp(ycTop, yd - 0.33, t * t * (3 - 2 * t));
      if (x < ex - 0.18) y += 0.06 * smoothstep(ex - 0.18, ex - 0.26, x);
      return y;
    }
    if (cw > 0) {
      var crings = [];
      for (var k2 = 0; k2 <= 14; k2++) {
        var x = lerp(consoleX0, consoleX1, k2 / 14), yt = consoleTopAt(x), ring = [];
        var shape = [[-1, 0], [-1, 0.75], [-0.92, 0.97], [-0.7, 1], [0, 1.01], [0.7, 1], [0.92, 0.97], [1, 0.75], [1, 0]];
        shape.forEach(function (sp) { ring.push([x, lerp(floorY, yt, sp[1]), sp[0] * cw]); });
        crings.push(ring);
      }
      G('soft').loft(crings, { closed: false, capEnd: true, uScale: 3.5, vScale: 3.5, inside: function () { return [ex, floorY - 1, 0]; }, colors: function (r, j) { return (j >= 3 && j <= 5 ? P.primary : P.door).concat(1); } });
      // stitched top seams along both console edges (knee pads)
      [-1, 1].forEach(function (s) {
        var seam = [];
        for (var k8 = 0; k8 <= 14; k8++) { var x8 = lerp(consoleX0 + 0.03, consoleX1 + 0.02, k8 / 14); seam.push([x8, lerp(floorY, consoleTopAt(x8), 0.985) + 0.0015, s * cw * 0.84]); }
        stitchLine(G('soft'), seam, P.stitch, 0.007, 0.005, 0.0022);
      });
      // top trim plate
      var tr2 = [];
      for (var k3 = 0; k3 <= 10; k3++) {
        var x2 = lerp(consoleX0 + 0.04, ex - 0.17, k3 / 10), yt2 = consoleTopAt(x2) + 0.004;
        tr2.push([[x2, yt2, -cw * 0.62], [x2, yt2 + 0.002, cw * 0.62]]);
      }
      G('trim').loft(tr2, { closed: false, inside: [ex, floorY - 1, 0], uScale: trimUV, vScale: trimUV });
      if (P.ambientOn) {
        [-1, 1].forEach(function (s) {
          var pts = [];
          for (var k4 = 0; k4 <= 10; k4++) { var x3 = lerp(consoleX0 + 0.04, ex - 0.17, k4 / 10); pts.push([x3, consoleTopAt(x3) - 0.012, s * (cw + 0.002)]); }
          G('glow').sweep(pts, { shape: rectShape(0.004, 0.003, 0.001, 1), up: [0, 1, 0], capStart: true, capEnd: true });
        });
      }
      // start button (red ring), drive-mode dial, cup holder
      var sb = [ex + 0.3, consoleTopAt(ex + 0.3) + 0.006, sd * -0.06];
      G('metal').setColor(P.chrome); G('metal').cyl(sb, add(sb, [0, 0.012, 0]), 0.017, 0.016, 18, true);
      G('leds').setColor([0.95, 0.08, 0.04]); G('leds').ring(add(sb, [0, 0.0125, 0]), [0, 1, 0], 0.0172, 0.0016, 20, 4);
      var dm = [ex + 0.05, consoleTopAt(ex + 0.05) + 0.006, 0];
      G('metal').setColor(P.metal); G('metal').cyl(dm, add(dm, [0, 0.022, 0]), 0.026, 0.024, 24, true);
      G('plastic').setColor(P.rubber); G('plastic').cyl(add(dm, [-0.09, -0.004, 0]), add(add(dm, [-0.09, -0.004, 0]), [0, 0.006, 0]), 0.036, 0.036, 18, true);
    }
    var leverPivot = [ex + 0.2, consoleTopAt(ex + 0.2) + 0.004, cw > 0 ? 0 : -sd * 0.25];
    if (Lx.sequential) leverPivot = [ex + 0.16, consoleTopAt(ex + 0.16) + 0.004, -sd * 0.0 + (cw > 0 ? sd * -0.02 : -sd * 0.25)];
    // handbrake
    if (Lx.manual && cw > 0) {
      var hb0 = [ex - 0.02, consoleTopAt(ex - 0.02) + 0.01, sd * -0.0 + 0.0];
      G('metal').setColor(P.metalDark); G('metal').beam(hb0, add(hb0, [-0.2, 0.05, 0]), 0.03, 0.025, [0, 1, 0]);
      G('soft').setColor(P.primary); G('soft').beam(add(hb0, [-0.1, 0.026, 0]), add(hb0, [-0.22, 0.055, 0]), 0.034, 0.03, [0, 1, 0]);
    } else if (Lx.sequential) {
      var hh0 = [ex + 0.12, ycTop, ez + -sd * 0.23];
      G('metal').setColor(P.metal); G('metal').cyl(hh0, add(hh0, [-0.06, 0.3, 0]), 0.012, 0.01, 10, true);
      G('soft').setColor(P.rubber); G('soft').cyl(add(hh0, [-0.045, 0.22, 0]), add(hh0, [-0.065, 0.33, 0]), 0.018, 0.017, 10, true);
    }

    /* ---------------- floor, firewall, pedals */
    var mat = G('matte');
    mat.setColor(P.carpet);
    mat.box((xd + 0.45 + Lx.xRear) / 2, floorY - 0.012, 0, xd + 0.45 - Lx.xRear, 0.024, Wi * 2 + 0.06, 1);
    mat.box(xd + 0.46, (floorY + yd - 0.3) / 2, 0, 0.03, yd - 0.3 - floorY, Wi * 2, 1);
    G('metal').setColor(P.metal);
    var pz = Lx.manual ? [-0.1, 0, 0.1] : [-0.05, 0.07];
    pz.forEach(function (oz, k) {
      var big = !Lx.manual && k === 0;
      G('metal').obox([xd + 0.3, floorY + 0.14, ez + oz], norm([0.35, 1, 0]), norm([-1, 0.35, 0]), [0, 0, 1], 0.05, 0.006, big ? 0.055 : 0.035, 1);
    });

    /* ---------------- doors */
    var yArm = Math.max(floorY + 0.3, yBelt - 0.2);
    var doorX0 = Lx.twoRows ? xBp - 0.02 : xBp - 0.2, doorX1 = xd + 0.3;
    [-1, 1].forEach(function (s) {
      var zs0 = s * (Wi + 0.035);
      function dz(d) { return zs0 - s * d; }
      var prof = [[floorY + 0.02, 0.0], [floorY + 0.2, 0.025], [floorY + 0.24, 0.05], [yArm - 0.07, 0.035], [yArm - 0.02, 0.098], [yArm + 0.018, 0.104],
        [yArm + 0.036, 0.046], [yBelt - 0.07, 0.03], [yBelt - 0.025, 0.046], [yBelt + 0.006, 0.032], [yBelt + 0.012, -0.012]];
      var rings = [], nx = 14;
      for (var k = 0; k <= nx; k++) {
        var x = lerp(doorX0, doorX1, k / nx);
        var armK = smoothstep(doorX1 - 0.02, doorX1 - 0.25, x) * smoothstep(doorX0 + 0.02, doorX0 + 0.2, x);
        var pocketK = smoothstep(doorX1 - 0.05, doorX1 - 0.3, x) * smoothstep(doorX0, doorX0 + 0.15, x);
        rings.push(prof.map(function (pp, j) {
          var d = pp[1];
          if (j >= 4 && j <= 5) d = lerp(0.04, d, armK);
          if (j === 2) d = lerp(0.028, d, pocketK);
          return [x, pp[0], dz(d)];
        }));
      }
      var dg = G('soft');
      dg.loft(rings, {
        closed: false, uScale: 3.5, vScale: 3.5, inside: function () { return [ex, yBelt - 0.2, s * (Wi + 1)]; },
        colors: function (r, j) { return (j <= 3 ? P.door : j <= 6 ? P.primary : P.dashTop).concat(1); }
      });
      // stitching along the armrest and the door top
      var st1 = [], st2 = [];
      for (var k5 = 0; k5 <= 12; k5++) {
        var xs = lerp(doorX0 + 0.08, doorX1 - 0.1, k5 / 12);
        st1.push([xs, yBelt - 0.024, dz(0.0475)]);
        var aK = smoothstep(doorX1 - 0.02, doorX1 - 0.25, xs) * smoothstep(doorX0 + 0.02, doorX0 + 0.2, xs);
        if (aK > 0.95) st2.push([xs, yArm + 0.021, dz(0.1045)]);
      }
      stitchLine(dg, st1, P.stitch, 0.007, 0.005, 0.0022);
      if (st2.length > 1) stitchLine(dg, st2, P.stitch, 0.007, 0.005, 0.0022);
      // trim insert panel + ambient strip above it
      var iy0 = yArm + 0.06, iy1 = yBelt - 0.085, ins = [], gl1 = [];
      for (var k6 = 0; k6 <= 8; k6++) {
        var xi = lerp(Math.max(doorX0 + 0.1, xBp + 0.08), doorX1 - 0.18, k6 / 8);
        ins.push([[xi, iy1, dz(0.0335)], [xi, iy0, dz(0.0405)]]);
        gl1.push([xi, iy1 + 0.006, dz(0.034)]);
      }
      if (iy1 - iy0 > 0.03) {
        G('trim').loft(ins, { closed: false, inside: [ex, yBelt, s * (Wi + 1)], uScale: trimUV, vScale: trimUV });
        if (P.ambientOn) G('glow').sweep(gl1, { shape: rectShape(0.0035, 0.004, 0.001, 1), up: [0, 0, -s], capStart: true, capEnd: true });
      }
      // handle + pull, window switches, speaker
      G('metal').setColor(P.metalDark);
      var hx = doorX1 - 0.26, hy = yArm + 0.1;
      G('metal').beam([hx, hy, dz(0.05)], [hx - 0.13, hy, dz(0.05)], 0.012, 0.022, [0, 0, s]);
      G('metal').beam([hx, hy, dz(0.05)], [hx + 0.005, hy, dz(0.035)], 0.01, 0.018, [0, 1, 0]);
      G('plastic').setColor(P.plasticHi);
      for (var w2 = 0; w2 < 2; w2++) G('plastic').box(doorX1 - 0.32 - w2 * 0.045, yArm + 0.024, dz(0.085), 0.03, 0.008, 0.022, 1);
      var spk = [doorX1 - 0.3, floorY + 0.14, dz(0.032)];
      G('metal').setColor(P.metal); G('metal').ring(spk, [0, 0, -s], 0.075, 0.004, 28, 6);
      G('matte').setColor(P.rubber); G('matte').cyl(spk, add(spk, [0, 0, -s * 0.004]), 0.072, 0.072, 24, true);
      // door top outer skin (paint) + window seal
      var skin = [], seal = [];
      for (var k7 = 0; k7 <= 10; k7++) {
        var xk = lerp(Math.min(xBp - (Lx.twoRows ? 0.9 : 0.35), Lx.xRear + 0.01), xb + 0.05, k7 / 10);
        skin.push([[xk, yBelt + 0.013, dz(-0.012)], [xk, yBelt + 0.004, dz(-0.05)], [xk, yBelt - 0.035, dz(-0.085)], [xk, yBelt - 0.16, dz(-0.1)]]);
        seal.push([xk, yBelt + 0.016, dz(0.008)]);
      }
      G('paint').loft(skin, { closed: false, inside: [ex, yBelt - 0.5, 0] });
      G('matte').setColor(P.rubber);
      G('matte').sweep(seal, { shape: rectShape(0.008, 0.022, 0.003, 1), up: [0, 1, 0], capStart: true, capEnd: true });

      // rear door card (two rows) / rear quarter trim (two seats): closes the cabin side between the rear bulkhead
      // and the front door so look-back shows a trimmed cabin instead of the road through the sides
      var rx0 = Lx.xRear + 0.005, rx1 = doorX0 + 0.012;
      if (rx1 - rx0 > 0.03) {
        var rArm = Lx.twoRows ? Math.max(floorY + 0.3, yArm - 0.02) : yArm;
        var rprof = Lx.twoRows
          ? [[floorY + 0.02, 0.0], [floorY + 0.18, 0.022], [floorY + 0.22, 0.045], [rArm - 0.07, 0.035], [rArm - 0.02, 0.085], [rArm + 0.018, 0.09],
            [rArm + 0.036, 0.042], [yBelt - 0.07, 0.03], [yBelt - 0.025, 0.044], [yBelt + 0.006, 0.032], [yBelt + 0.012, -0.012]]
          : [[floorY + 0.02, 0.0], [floorY + 0.2, 0.02], [yArm - 0.05, 0.03], [yArm + 0.03, 0.05], [yBelt - 0.07, 0.04], [yBelt - 0.025, 0.046],
            [yBelt + 0.006, 0.032], [yBelt + 0.012, -0.012]];
        var rRings = [], nrx = Math.max(3, Math.round((rx1 - rx0) / 0.08));
        for (var kr = 0; kr <= nrx; kr++) {
          var xr = lerp(rx0, rx1, kr / nrx);
          var rK = Lx.twoRows ? smoothstep(rx1 - 0.01, rx1 - 0.18, xr) * smoothstep(rx0 + 0.02, rx0 + 0.2, xr) : 1;
          rRings.push(rprof.map(function (pp, j) {
            var d = pp[1];
            if (Lx.twoRows && j >= 4 && j <= 5) d = lerp(0.04, d, rK);
            return [xr, pp[0], dz(d)];
          }));
        }
        dg.loft(rRings, {
          closed: false, inside: function () { return [ex, yBelt - 0.2, s * (Wi + 1)]; },
          colors: function (r, j) { var c0 = Lx.twoRows ? 3 : 2, c1 = Lx.twoRows ? 6 : 4; return (j <= c0 ? P.door : j <= c1 ? P.primary : P.dashTop).concat(1); }
        });
        // end caps against the bulkhead / B-pillar so the card has thickness, not a paper edge
        [rx0, rx1].forEach(function (xe, ie) {
          var cap = rprof.map(function (pp) { return [xe, pp[0], dz(pp[1])]; });
          var back = rprof.map(function (pp) { return [xe, pp[0], dz(-0.03)]; });
          dg.setColor(P.door);
          dg.loft(ie ? [back, cap] : [cap, back], { closed: false, inside: [ie ? xe - 1 : xe + 1, yBelt - 0.2, s * Wi] });
        });
        if (Lx.twoRows) {
          stitchLine(dg, [[rx0 + 0.08, yBelt - 0.024, dz(0.0455)], [rx1 - 0.08, yBelt - 0.024, dz(0.0455)]], P.stitch, 0.007, 0.005, 0.0022);
          G('metal').setColor(P.metalDark);
          var rhx = rx1 - 0.2, rhy = rArm + 0.1;
          G('metal').beam([rhx, rhy, dz(0.045)], [rhx - 0.11, rhy, dz(0.045)], 0.011, 0.02, [0, 0, s]);
          var rspk = [lerp(rx0, rx1, 0.5), floorY + 0.14, dz(0.03)];
          G('metal').setColor(P.metal); G('metal').ring(rspk, [0, 0, -s], 0.06, 0.0035, 24, 6);
          G('matte').setColor(P.rubber); G('matte').cyl(rspk, add(rspk, [0, 0, -s * 0.004]), 0.058, 0.058, 20, true);
          // rear door seal against the B-pillar
          G('matte').setColor(P.rubber);
          G('matte').box(rx1 - 0.006, (floorY + yBelt) / 2, dz(0.012), 0.012, yBelt - floorY, 0.02, 1);
        } else {
          // seatbelt anchor + trim seam on the quarter panel
          G('metal').setColor(P.metalDark);
          G('metal').box(lerp(rx0, rx1, 0.55), yBelt - 0.06, dz(0.05), 0.03, 0.05, 0.012, 1);
        }
      }
    });
    // rear wheel-arch humps: where the rear tyres sit under the rear seats / quarter, wrap them in a trimmed hump
    // (door-card material) so the exterior arch liner and tyre (drawn again in look-back) never poke into the cabin
    (function () {
      var aR = Lx.wheelRR + 0.07, ax = Lx.axleR, ay = Lx.wheelRR;
      var zIn = Lx.trackF / 2 - Lx.tireWR / 2 - 0.045, zOut = Wi + 0.03;
      var hx0 = Math.max(Lx.xRear + 0.01, ax - aR), hx1 = Math.min(xBp - 0.03, ax + aR);
      if (hx1 - hx0 < 0.05 || ay + aR < floorY + 0.03 || zOut - zIn < 0.03) return;
      var sg = G('soft');
      [-1, 1].forEach(function (s) {
        var rows = [], nA = 14;
        for (var k = 0; k <= nA; k++) {
          var x = lerp(hx0, hx1, k / nA), dx = x - ax, h = Math.sqrt(Math.max(0, aR * aR - dx * dx));
          var y = Math.max(floorY + 0.004, ay + h);
          // rounded inboard shoulder: inner edge drops to the floor over ~6 cm
          rows.push([[x, floorY + 0.002, s * (zIn - 0.06)], [x, lerp(floorY, y, 0.7), s * (zIn - 0.035)], [x, y - 0.012, s * (zIn - 0.006)], [x, y, s * (zIn + 0.03)], [x, y, s * zOut]]);
        }
        sg.setColor(P.door);
        sg.loft(rows, { closed: false, inside: [ax, ay, s * zIn] });
        // end walls
        [0, nA].forEach(function (ke) {
          var r = rows[ke];
          sg.loft([[r[0], r[1], r[2], r[3], r[4]], r.map(function (p) { return [p[0], floorY + 0.002, p[2]]; })], { closed: false, inside: [ax, ay, s * zIn] });
        });
      });
    })();
    // rear footwell tunnel + sill trims so the rear floor isn't a bare slab
    if (Lx.twoRows) {
      G('matte').setColor(P.carpet);
      G('matte').box((xBp + Lx.xRear) / 2, floorY + 0.045, 0, xBp - Lx.xRear, 0.09, 0.2, 1);
      G('plastic').setColor(P.plastic);
      [-1, 1].forEach(function (s) { G('plastic').box((xd + Lx.xRear) / 2, floorY + 0.02, s * (Wi + 0.005), xd - Lx.xRear, 0.04, 0.07, 1); });
    }

    /* ---------------- windscreen, A-pillars, header, headliner, B/C pillars */
    var liner = G('liner'), glass = G('glass'), gside = G('glassSide');
    function wsPoint(t, u) {          // t: 0 bottom..1 top, u: -1 left..1 right
      var hw = lerp(wsHalfBase, wsHalfTop, t), bow = 0.05 * (1 - u * u) * (1 - t * 0.6);
      return [lerp(xb, xh, t) + bow, lerp(yb - 0.01, yR, t), u * hw];
    }
    var wsr = [];
    for (var a = 0; a <= 6; a++) { var row = []; for (var b = 0; b <= 12; b++) row.push(wsPoint(a / 6, -1 + b / 6)); wsr.push(row); }
    glass.setColor([1, 1, 1]);
    glass.loft(wsr, { closed: false, inside: [xb + 2, yb, 0] });
    // black frit bands (top + sides) just inside the glass
    var frit = G('matte'), fr = [];
    frit.setColor([0.008, 0.008, 0.009]);
    var fritT = clamp(1 - (Lx.open ? 0.03 : 0.045) / Math.max(0.1, yR - yb), 0.86, 0.97);   // ~3-4.5 cm frit band
    for (var b2 = 0; b2 <= 12; b2++) {
      var u2 = -1 + b2 / 6, pT = wsPoint(1, u2), pB = wsPoint(fritT, u2);
      fr.push([add(pT, [-0.004, -0.002, 0]), add(pB, [-0.004, 0, 0])]);
    }
    frit.loft(fr, { closed: false, inside: [xb + 2, yb, 0] });
    [-1, 1].forEach(function (s) {
      var sr = [];
      for (var a2 = 0; a2 <= 6; a2++) { var t2 = a2 / 6; sr.push([add(wsPoint(t2, s), [-0.004, 0, 0]), add(wsPoint(t2, s * 0.955), [-0.004, 0, 0])]); }
      frit.loft(sr, { closed: false, inside: [xb + 2, yb, 0] });
    });
    // A-pillars (rounded, liner material), tapering
    liner.setColor(P.liner);
    [-1, 1].forEach(function (s) {
      var path = [];
      for (var k = 0; k <= 8; k++) { var t = k / 8, p = wsPoint(t, s); path.push(add(p, [-0.03, -0.004, -s * 0.012])); }
      liner.sweep(path, {
        shape: rectShape(0.065, 0.118, 0.028, 3), up: function (i) { return sub(eye, path[i]); },
        scale: function (t) { return [1, lerp(1.15, 0.9, t)]; }, capStart: true, capEnd: true
      });
      // wrapped-pillar seam (stitched) on the cabin face
      var seamA = path.map(function (q) { return madd(q, norm(sub(eye, q)), 0.0345); });
      stitchLine(liner, seamA.slice(1, -1), P.stitch, 0.007, 0.005, 0.002);
      liner.setColor(P.liner);
      // grab handle-ish trim / tweeter on the pillar base
      G('metal').setColor(P.metal);
      var tw = add(wsPoint(0.1, s * 0.98), [-0.06, 0.01, -s * 0.03]);
      G('metal').ring(tw, norm(sub(eye, tw)), 0.018, 0.0025, 16, 5);
    });
    if (Lx.open) {
      // roadster: windscreen frame top bar (body colour) + no roof
      G('paint').setColor([1, 1, 1]);
      var fb = [];
      for (var b3 = 0; b3 <= 12; b3++) fb.push(add(wsPoint(1, -1 + b3 / 6), [-0.01, 0.012, 0]));
      G('paint').sweep(fb, { shape: rectShape(0.034, 0.026, 0.009, 2), up: [0, 1, 0], capStart: true, capEnd: true });
    } else {
      var hdr = [];
      for (var b4 = 0; b4 <= 12; b4++) hdr.push(add(wsPoint(1, (-1 + b4 / 6) * 0.98), [-0.035, -0.012, 0]));
      liner.sweep(hdr, { shape: rectShape(0.06, 0.045, 0.018, 2), up: [0, 1, 0], capStart: true, capEnd: true });
      // headliner (optionally with a glass roof opening)
      var Wt = wsHalfTop + 0.005, xL0 = xh - 0.05, xL1 = Lx.xRoofRear;
      var linerAt = function (x, z) { var u = z / Wt; return [x, yR + 0.02 * (1 - u * u) - 0.035 * Math.pow(Math.abs(u), 8) + 0.002, z]; };
      var headPart = function (x0, x1, z0, z1, nxp, nzp) {
        if (x0 - x1 < 0.01 || z1 - z0 < 0.01) return;
        var rr = [];
        for (var i2 = 0; i2 <= nxp; i2++) { var xx = lerp(x0, x1, i2 / nxp), ring = []; for (var j2 = 0; j2 <= nzp; j2++) ring.push(linerAt(xx, lerp(z0, z1, j2 / nzp))); rr.push(ring); }
        liner.loft(rr, { closed: false, inside: [ex, yR + 2, 0] });
      };
      if (Lx.sunroof) {
        var xs0 = xh - 0.14, xs1 = Math.max(xL1 + 0.12, ex - 0.6), zsr = Wt * 0.7;
        headPart(xL0, xs0, -Wt, Wt, 3, 14);
        headPart(xs1, xL1, -Wt, Wt, 3, 14);
        headPart(xs0, xs1, -Wt, -zsr, 6, 3);
        headPart(xs0, xs1, zsr, Wt, 6, 3);
        var sr2 = [];
        for (var i3 = 0; i3 <= 4; i3++) { var xq = lerp(xs0, xs1, i3 / 4); sr2.push([add(linerAt(xq, -zsr), [0, 0.03, 0]), add(linerAt(xq, zsr), [0, 0.03, 0])]); }
        G('glassRoof').setColor([1, 1, 1]);
        G('glassRoof').loft(sr2, { closed: false, inside: [ex, yR + 2, 0] });
        G('plastic').setColor(P.rubber);
        [[xs0, xs0, -zsr, zsr], [xs1, xs1, -zsr, zsr]].forEach(function (e) {
          var p0 = linerAt(e[0], e[2]), p1 = linerAt(e[1], e[3]);
          G('plastic').beam(add(p0, [0, -0.004, 0]), add(p1, [0, -0.004, 0]), 0.018, 0.012, [0, 1, 0]);
        });
        [-zsr, zsr].forEach(function (z) { G('plastic').beam(add(linerAt(xs0, z), [0, -0.004, 0]), add(linerAt(xs1, z), [0, -0.004, 0]), 0.018, 0.012, [0, 1, 0]); });
      } else headPart(xL0, xL1, -Wt, Wt, 8, 16);
      // starlight
      if (Lx.starlight) {
        var stg = G('stars');
        for (var q = 0; q < 160; q++) {
          var sx = lerp(xL0 + 0.05, xL1 - 0.02, rng()), szz = lerp(-Wt * 0.88, Wt * 0.88, rng());
          if (Lx.sunroof && sx < xh - 0.14 && sx > Math.max(xL1 + 0.12, ex - 0.6) && Math.abs(szz) < Wt * 0.72) continue;
          var sp = add(linerAt(sx, szz), [0, -0.0015, 0]), sz = 0.0016 + rng() * 0.0022, br = 0.5 + rng() * 0.8;
          stg.setColor([br, br * 0.95, br * 0.82]);
          stg.quad4([sp[0] - sz, sp[1], sp[2] - sz], [sp[0] - sz, sp[1], sp[2] + sz], [sp[0] + sz, sp[1], sp[2] + sz], [sp[0] + sz, sp[1], sp[2] - sz]);
        }
      }
      // sun visors + overhead console
      [-1, 1].forEach(function (s) {
        var vz = s * Wt * 0.5, vc = add(linerAt(xh - 0.12, vz), [0, -0.016, 0]);
        liner.setColor(mix(P.liner, [0, 0, 0], 0.08));
        liner.obox(vc, norm([1, tr > 0 ? 0.08 : 0, 0]), [0, 1, 0], [0, 0, 1], 0.095, 0.011, 0.18, 1);
        G('plastic').setColor(P.plasticHi);
        G('plastic').box(vc[0], vc[1] + 0.004, vz - s * 0.2, 0.025, 0.012, 0.02, 1);
      });
      var oc = add(linerAt(xh - 0.14, 0), [0, -0.018, 0]);
      G('plastic').setColor(P.plastic);
      G('plastic').obox(oc, [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.085, 0.017, 0.11, 1);
      G('leds').setColor([0.22, 0.2, 0.17]);
      [-0.055, 0.055].forEach(function (z) { G('leds').obox(add(oc, [-0.01, -0.0175, z]), [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.03, 0.0012, 0.03, 1); });
      G('leds').setColor([0.75, 0.05, 0.02]);
      G('leds').obox(add(oc, [-0.07, -0.0175, 0]), [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.008, 0.0012, 0.016, 1);
      // B pillars, C pillars, rear window, rear deck
      liner.setColor(P.liner);
      [-1, 1].forEach(function (s) {
        liner.sweep([[xBp, yBelt - 0.08, s * (Wi + 0.01)], [xBp + 0.02, yR - 0.012, s * (Wt - 0.005)]], { shape: rectShape(0.05, 0.12, 0.02, 2), up: [0, 0, -s], capStart: true, capEnd: true });
        liner.sweep([[Lx.xRear + 0.06, yBelt - 0.02, s * (Wi - 0.01)], [xL1 + 0.03, yR - 0.015, s * (Wt - 0.01)]], { shape: rectShape(0.05, 0.2, 0.02, 2), up: [0, 0, -s], capStart: true, capEnd: true });
        // side windows (front + rear quarter)
        gside.setColor([1, 1, 1]);
        gside.quad4([wsPoint(0.02, s)[0] - 0.02, yBelt + 0.02, s * (Wi + 0.02)], [xBp + 0.03, yBelt + 0.02, s * (Wi + 0.02)], [xBp + 0.04, yR - 0.02, s * (Wt + 0.0)], [xh - 0.02, yR - 0.02, s * (Wt + 0.0)], null, true);
        gside.quad4([xBp - 0.05, yBelt + 0.02, s * (Wi + 0.02)], [Lx.xRear + 0.1, yBelt + 0.02, s * (Wi + 0.02)], [xL1 + 0.04, yR - 0.02, s * Wt], [xBp - 0.04, yR - 0.02, s * Wt], null, true);
      });
      gside.quad4([Lx.xRear + 0.02, yBelt + 0.03, -Wi * 0.92], [Lx.xRear + 0.02, yBelt + 0.03, Wi * 0.92], [xL1 + 0.01, yR - 0.01, Wt * 0.9], [xL1 + 0.01, yR - 0.01, -Wt * 0.9], null, true);
    }
    // rear bulkhead / parcel shelf
    G('soft').setColor(P.door);
    G('soft').box(Lx.xRear - 0.02, (floorY + yBelt) / 2, 0, 0.04, yBelt - floorY, Wi * 2, 1);
    G('matte').setColor(P.carpet);
    G('matte').box(Lx.xRear - 0.16, yBelt + 0.01, 0, 0.28, 0.02, Wi * 2, 1);
    if (Lx.open) {
      // roadster rear deck in body colour behind the seats
      var deck = [];
      for (var b5 = 0; b5 <= 12; b5++) {
        var zz = lerp(-Wi - 0.08, Wi + 0.08, b5 / 12);
        deck.push([[xBp - 0.1, yBelt + 0.02 + 0.02 * (1 - Math.pow(zz / Wi, 2)), zz], [Lx.xRear - 0.6, yBelt - 0.02, zz]]);
      }
      G('paint').loft(deck, { closed: false, inside: [ex, yBelt - 1, 0] });
    }

    /* ---------------- hood + cowl + wipers (paint, seen through the windscreen) */
    var svg = Lx.svg || {}, xf = Lx.L / 2 - 0.1, yf = lerp(yb, clamp(num(svg.noseHeight, 0.46) * Lx.H + 0.1, Lx.ride + 0.32, yb - 0.08), 0.75);
    var hwH = Lx.W / 2 - 0.035, flared = svg.archStyle === 'flared', xAx = Lx.wb / 2;
    var hoodRings = [], nxH = 16, nzH = 22;
    for (var hi = 0; hi <= nxH; hi++) {
      var t3 = hi / nxH, xx2 = lerp(xb + 0.07, xf, t3), yy = lerp(yb + 0.004, yf, Math.pow(t3, 1.5)), ring2 = [];
      for (var hj = 0; hj <= nzH; hj++) {
        var u3 = -1 + 2 * hj / nzH, zq = u3 * hwH * lerp(1, 0.9, t3 * t3);
        var y3 = yy + 0.03 * (1 - u3 * u3);
        if (flared) y3 += 0.065 * Math.exp(-Math.pow((Math.abs(zq) - (Lx.W / 2 - 0.22)) / 0.14, 2)) * Math.exp(-Math.pow((xx2 - xAx) / 0.55, 2));
        y3 -= 0.13 * Math.pow(smoothstep(0.86, 1, Math.abs(u3)), 1.5);
        // wheel-arch hump: keep the paint at least 6 cm over the tyre's top arc (the exterior body is hidden in cockpit)
        var adx = xx2 - Lx.axleF, aR = Lx.wheelR + 0.06;
        if (Math.abs(adx) < aR + 0.12) {
          var archY = Lx.wheelR + Math.sqrt(Math.max(0, aR * aR - adx * adx)) - 0.04 * smoothstep(aR, aR + 0.12, Math.abs(adx));
          var zIn = Lx.trackF / 2 - Lx.tireW / 2 - 0.05, wz = smoothstep(zIn - 0.12, zIn, Math.abs(zq));
          if (archY > y3) y3 = lerp(y3, archY, wz);
        }
        ring2.push([xx2, y3, zq]);
      }
      hoodRings.push(ring2);
    }
    G('paint').loft(hoodRings, { closed: false, inside: function (k) { var gp = G('paint').P; return [gp[k * 3], -5, gp[k * 3 + 2]]; } });
    G('plastic').setColor(P.rubber);
    G('plastic').box(xb + 0.035, yb - 0.006, 0, 0.09, 0.012, (wsHalfBase + 0.02) * 2, 1);
    G('matte').setColor(P.rubber);
    [[-wsHalfBase * 0.9, -0.03], [-0.02, wsHalfBase * 0.8]].forEach(function (seg) {
      G('matte').beam([xb + 0.03, yb + 0.006, seg[0]], [xb + 0.005, yb + 0.012, seg[1]], 0.012, 0.01, [0, 1, 0]);
    });

    /* ---------------- side mirrors (housings + arms; glass in the mirror panel) */
    panels.mirror = new Geo();
    Lx.sideMirrors.forEach(function (sm) {
      var F = faceFrame(sm.pos, add(sm.pos, sm.normal)), grp = P.mirrorCarbon ? G('carbon') : (Lx.svg && (build.exterior || {}).mirrors === 'black') ? G('plastic') : G('paint');
      grp.setColor(P.mirrorCarbon ? [1, 1, 1] : P.mirror);
      grp.setTransform(M4.basis(mul(F.n, -1), F.up, F.right, madd(sm.pos, F.n, -0.035)));
      grp.ellipsoid([0, 0, 0], 0.045, 0.066, 0.112, 16);
      grp.setTransform(null);
      grp.beam(madd(sm.pos, F.n, -0.04), [sm.pos[0] + 0.02, yBelt + 0.01, sm.side * (Lx.W / 2 - 0.03)], 0.05, 0.03, [0, 1, 0]);
      G('plastic').setColor(P.rubber);
      G('plastic').obox(madd(sm.pos, F.n, -0.004), F.right, F.up, F.n, sm.width / 2 + 0.006, sm.height / 2 + 0.006, 0.004, 1);
      var uvs = sm.side < 0 ? [0.0, 0.08, 0.58, 0.92] : [0.42, 0.08, 1.0, 0.92];
      panel(panels.mirror, madd(sm.pos, F.n, 0.0015), F, sm.width, sm.height, uvs);
      sm.frame = F;
    });
    // rear-view mirror housing + stalk + rain-sensor pod
    var M0 = Lx.mirror, mF = faceFrame(M0.pos, add(M0.pos, M0.normal));
    G('plastic').setColor(P.plastic);
    G('plastic').obox(madd(M0.pos, mF.n, -0.013), mF.right, mF.up, mF.n, M0.width / 2 + 0.008, M0.height / 2 + 0.008, 0.012, 1);
    G('plastic').setColor(P.rubber);
    var mzM = M0.mount ? M0.mount[2] : 0, wsHalfM = Math.max(0.2, wsHalfTop);
    var tM = clamp((M0.pos[1] + 0.06 - yb) / (yR - yb), 0, 0.97), gTop = wsPoint(tM, clamp(mzM / wsHalfM, -0.9, 0.9));
    // ball-joint stalk from the back of the housing up / across to the glass mount
    var stA = madd(M0.pos, mF.n, -0.024), stB = add(gTop, [-0.012, 0, 0]);
    G('plastic').beam(stA, stB, 0.014, 0.012, [0, 1, 0]);
    G('plastic').setColor(P.plastic);
    G('plastic').ellipsoid(stA, 0.012, 0.012, 0.012, 10);
    if (!Lx.open) {
      // slim rain-sensor / camera pod bonded to the glass, inside a black dotted frit patch that runs up into the
      // header frit band, so the mount reads as attached even when the header itself is above the frame
      var gN = norm([-1, tr, 0]), gU = norm([tr, 1, 0]), uM = clamp(mzM / wsHalfM, -0.9, 0.9);
      G('plastic').setColor(P.rubber);
      G('plastic').obox(madd(add(gTop, [-0.008, 0, 0]), gN, 0.004), gU, gN, [0, 0, 1], 0.03, 0.008, 0.032, 1);
      var fz = 0.075, fritC = G('matte');
      fritC.setColor([0.008, 0.008, 0.009]);
      var tF0 = clamp(tM - 0.07 / Math.max(0.1, yR - yb), 0, 0.97), fRows = [];
      for (var fi = 0; fi <= 3; fi++) {
        var tf = lerp(tF0, 0.995, fi / 3), wz = lerp(0.62, 1, fi / 3) * fz;
        var pa = wsPoint(tf, clamp((mzM - wz) / wsHalfM, -1, 1)), pb = wsPoint(tf, clamp((mzM + wz) / wsHalfM, -1, 1));
        fRows.push([add(pa, [-0.0045, 0, 0]), add(pb, [-0.0045, 0, 0])]);
      }
      fritC.loft(fRows, { closed: false, inside: [xb + 2, yb, 0] });
      // dot-matrix fade under the patch
      for (var di = 0; di < 3; di++) for (var dj = -4; dj <= 4; dj++) {
        var tdd = tF0 - (di + 1) * 0.012 / Math.max(0.1, yR - yb), dzz = mzM + dj * fz * 0.62 / 4.5, dp = add(wsPoint(tdd, clamp(dzz / wsHalfM, -1, 1)), [-0.0045, 0, 0]);
        fritC.obox(dp, gU, gN, [0, 0, 1], 0.0032 - di * 0.0008, 0.0006, 0.0032 - di * 0.0008, 1);
      }
    }
    panel(panels.mirror, madd(M0.pos, mF.n, 0.0015), mF, M0.width, M0.height);
    M0.frame = mF;

    /* ---------------- seats */
    var hipY = Math.max(floorY + 0.12, ey - 0.74), hipX = ex - 0.17;
    var sType = SEATS[Lx.seatType] || SEATS.sport;
    function seat(cz, isDriver) {
      var sg = isDriver ? G('seatD') : G('soft'), shellG = isDriver ? G('seatDc') : G('carbon');
      var rec = sType.shell ? 0.34 : 0.27, bol = sType.bolster, wing = sType.wing, backL = sType.back + (sType.head === 'separate' ? 0 : 0.18);
      var upv = [-Math.sin(rec), Math.cos(rec), 0], fwd = [Math.cos(rec), Math.sin(rec), 0];
      var base = [hipX - 0.1, hipY + 0.03, cz];
      var front = [[-0.27, 0.06 + bol], [-0.235, 0.075 + bol], [-0.2, 0.035], [-0.12, 0.004], [0, -0.004], [0.12, 0.004], [0.2, 0.035], [0.235, 0.075 + bol], [0.27, 0.06 + bol]];
      var back = [[0.26, -0.06], [0.12, -0.085], [-0.12, -0.085], [-0.26, -0.06]];
      var shape = front.concat(back);
      var rings = [], nb = 12;
      for (var k = 0; k <= nb; k++) {
        var t = k / nb, w = 1 - 0.18 * smoothstep(0.55, 0.85, t) + (sType.head === 'separate' ? 0 : 0.0);
        var bolK = 1 - smoothstep(0.6, 0.95, t) * 0.6, top = t > 0.8 && sType.head !== 'separate' ? 0.8 : 1;
        var c = madd(base, upv, t * backL);
        rings.push(shape.map(function (p, j) {
          var n = p[1]; if (j <= 8 && (j <= 1 || j >= 7)) n = 0.035 + (n - 0.035) * bolK + (t > 0.75 ? wing : 0);
          var zz = p[0] * w * top;
          return madd(add(c, [0, 0, zz]), fwd, n);
        }));
      }
      sg.loft(rings, {
        closed: true, capEnd: true, capStart: true, inside: function (k2) { return madd(base, upv, clamp(dot(sub([sg.P[k2 * 3], sg.P[k2 * 3 + 1], sg.P[k2 * 3 + 2]], base), upv), 0, backL)); },
        colors: function (r, j) { var ctr = j >= 2 && j <= 6; return (ctr ? mix(P.primary, P.accent, Lx.seatType === 'race-shell' ? 0 : 0.12) : (sType.shell && j > 8 ? [0.02, 0.02, 0.02] : P.door)).concat(1); }
      });
      // cushion
      var crings = [];
      for (var k3 = 0; k3 <= 8; k3++) {
        var t3 = k3 / 8, x = lerp(hipX - 0.08, hipX + 0.42, t3), yTop = hipY + 0.035 + 0.05 * t3 * t3;
        crings.push([[-0.26, yTop + bol * 0.9], [-0.2, yTop + 0.01], [-0.1, yTop - 0.005], [0.1, yTop - 0.005], [0.2, yTop + 0.01], [0.26, yTop + bol * 0.9], [0.26, hipY - 0.1], [-0.26, hipY - 0.1]]
          .map(function (p) { return [x, p[1], cz + p[0]]; }));
      }
      sg.loft(crings, { closed: true, capStart: true, capEnd: true, inside: [hipX + 0.17, hipY - 0.04, cz], colors: function (r, j) { return (j >= 1 && j <= 4 ? mix(P.primary, P.accent, 0.08) : P.door).concat(1); } });
      if (sType.shell) {
        // carbon shell back: offset outer surface of the back and sides
        var sh = rings.map(function (rg) { return rg.slice(8, 13).concat([rg[0]]).map(function (p, j) { var c2 = rg[4]; return add(p, mul(norm(sub(p, c2)), 0.006)); }); });
        shellG.loft(sh, { closed: false, inside: madd(base, upv, backL * 0.5), uScale: 22, vScale: 22 });
      }
      if (sType.head === 'separate') {
        var hc = madd(madd(base, upv, backL + 0.12), fwd, 0.01);
        sg.setColor(P.door);
        sg.setTransform(M4.basis(fwd, upv, [0, 0, 1], add(hc, [0, 0, cz - hc[2]])));
        sg.ellipsoid([0, 0, 0], 0.05, 0.09, 0.13, 14);
        sg.setTransform(null);
        G('metal').setColor(P.chrome);
        [-0.06, 0.06].forEach(function (oz) { G('metal').cyl(add(madd(base, upv, backL - 0.02), [0, 0, oz]), add(madd(base, upv, backL + 0.06), [0, 0, oz]), 0.006, 0.006, 8, true); });
      } else {
        // harness slots
        G('matte').setColor([0.005, 0.005, 0.005]);
        [-0.075, 0.075].forEach(function (oz) {
          var hs = madd(madd(base, upv, backL * 0.78), fwd, 0.0);
          G('matte').obox(add(hs, [0, 0, oz]), fwd, upv, [0, 0, 1], 0.004, 0.035, 0.022, 1);
        });
      }
      return { base: base, upv: upv, fwd: fwd, backL: backL };
    }
    var dSeat = seat(ez, true), pSeat = Lx.seats > 1 ? seat(-ez, false) : null;
    if (Lx.twoRows) {
      var rx = Lx.xRear + 0.38, ry = Math.max(floorY + 0.12, hipY - 0.02);
      [-1, 1].forEach(function (s) {
        G('soft').setColor(P.door);
        G('soft').box(rx + 0.2, ry, s * Wi * 0.45, 0.42, 0.16, Wi * 0.8, 1);
        // seat base / riser down to the floor (the cushion used to hover over the carpet)
        var rb = ry - 0.08;
        if (rb > floorY + 0.005) {
          G('matte').setColor(P.carpet);
          G('matte').box(rx + 0.18, (floorY + rb) / 2, s * Wi * 0.45, 0.4, rb - floorY + 0.004, Wi * 0.78, 1);
        }
        // backrest foot down onto the cushion's rear edge + seatbelt buckles
        G('soft').setColor(P.door);
        G('soft').box(rx - 0.04, ry + 0.06, s * Wi * 0.45, 0.1, 0.1, Wi * 0.78, 1);
        G('metal').setColor(P.metalDark);
        [-0.12, 0.12].forEach(function (oz) { G('metal').box(rx + 0.0, ry + 0.1, s * Wi * 0.45 + oz, 0.03, 0.05, 0.02, 1); });
        G('soft').obox([rx - 0.02, ry + 0.33, s * Wi * 0.45], norm([0.25, 1, 0]), norm([-1, 0.25, 0]), [0, 0, 1], 0.3, 0.06, Wi * 0.4, 1);
        G('soft').setColor(mix(P.primary, P.accent, 0.1));
        G('soft').obox([rx + 0.03, ry + 0.36, s * Wi * 0.45], norm([0.25, 1, 0]), norm([-1, 0.25, 0]), [0, 0, 1], 0.24, 0.061, Wi * 0.3, 1);
      });
    }

    /* ---------------- roll cage / hoops */
    var cg = G('cage'), tube = 0.021;
    function tubePath(pts, r, grp, seg) { (grp || cg).sweep(catmull(pts, seg || 4, false), { radius: r || tube, sides: 10, capStart: true, capEnd: true }); }
    var xm = xBp - 0.07, zw = Wi - 0.03, yTop = (Lx.open ? ey + 0.06 : yR - 0.05);
    cg.setColor(P.cage);
    if (Lx.cage === 'half' || Lx.cage === 'full') {
      tubePath([[xm, floorY, -zw], [xm, yBelt, -zw], [xm, yTop - 0.12, -(zw - 0.03)], [xm, yTop - 0.015, -(zw - 0.14)], [xm, yTop, 0], [xm, yTop - 0.015, zw - 0.14], [xm, yTop - 0.12, zw - 0.03], [xm, yBelt, zw], [xm, floorY, zw]], tube, cg, 5);
      [-1, 1].forEach(function (s) { tubePath([[xm, yTop - 0.03, s * (zw - 0.1)], [Lx.xRear - 0.35, yBelt - 0.05, s * (zw - 0.12)]]); });
      tubePath([[xm, yTop - 0.05, -(zw - 0.1)], [xm, floorY + 0.12, zw - 0.02]]);
      tubePath([[xm, ey - 0.2, -(zw - 0.01)], [xm, ey - 0.2, zw - 0.01]]);
      if (Lx.cage === 'full') {
        [-1, 1].forEach(function (s) {
          var aBar = [[xd + 0.15, floorY, s * (zw - 0.02)], [xd - 0.02, yd - 0.12, s * (zw - 0.02)], add(wsPoint(0.3, s * 0.93), [-0.07, 0, 0]), add(wsPoint(0.85, s * 0.9), [-0.07, -0.01, 0]), [xh - 0.1, yTop, s * (zw - 0.16)], [xm + 0.05, yTop, s * (zw - 0.15)]];
          tubePath(aBar, tube, cg, 5);
          // door X bars
          var zd = s * (Wi - 0.05);
          tubePath([[xd + 0.02, floorY + 0.12, zd], [xm, yBelt - 0.1, zd]]);
          tubePath([[xd + 0.02, yBelt - 0.12, zd], [xm, floorY + 0.12, zd]]);
          // padding on the bars near the driver
          if (s === sd) {
            var pad = [lerp(xd + 0.02, xm, 0.25), lerp(yBelt - 0.12, floorY + 0.12, 0.25), zd];
            G('matte').setColor(P.pad);
            G('matte').cyl(add([xd + 0.02, yBelt - 0.12, zd], [0, 0, 0]), pad, 0.034, 0.034, 12, true);
          }
        });
        tubePath([[xh - 0.1, yTop, -(zw - 0.16)], [xh - 0.1, yTop + 0.006, 0], [xh - 0.1, yTop, zw - 0.16]]);
        tubePath([[xh - 0.1, yTop, -(zw - 0.17)], [xm + 0.05, yTop, zw - 0.16]]);
        tubePath([[xd - 0.03, yd - 0.13, -(zw - 0.03)], [xd - 0.03, yd - 0.13, zw - 0.03]], tube * 1.2);
        G('matte').setColor(P.pad);
        G('matte').cyl([xm, yTop - 0.005, ez - 0.2], [xm, yTop - 0.005, ez + 0.2], 0.036, 0.036, 12, true);
      }
    } else if (Lx.cage === 'hoops') {
      var hg = G('metal');
      hg.setColor(P.chrome);
      [ez, -ez].forEach(function (zc) {
        var pts = [];
        for (var k = 0; k <= 12; k++) { var a3 = PI * k / 12; pts.push([xBp - 0.1, yBelt + Math.sin(a3) * (ey + 0.05 - yBelt), zc + Math.cos(a3) * 0.2]); }
        hg.sweep(pts, { radius: 0.024, sides: 12, capStart: true, capEnd: true });
      });
    }

    /* ---------------- harness */
    if (Lx.harness) {
      [[dSeat, true], [pSeat, false]].forEach(function (ps) {
        var st = ps[0]; if (!st) return;
        var hg2 = ps[1] ? G('harnessD') : G('harness');
        hg2.setColor(P.harness);
        var cz = st.base[2], bar = Lx.cage !== 'none' && Lx.cage !== 'hoops' ? xm : xBp - 0.05;
        var buckle = [hipX + 0.28, hipY + 0.12, cz];
        [-1, 1].forEach(function (s) {
          var sh0 = [bar, ey - 0.19, cz + s * 0.08], sh1 = madd(madd(st.base, st.upv, st.backL * 0.82), st.fwd, 0.06);
          sh1 = [sh1[0], sh1[1], cz + s * 0.085];
          var chest = [hipX + 0.26, hipY + 0.32, cz + s * 0.07];
          hg2.sweep(catmull([sh0, add(sh1, [0.03, 0.03, 0]), chest, buckle], 4, false), { shape: rectShape(0.004, 0.048, 0.0015, 1), up: [0, 0, 1], capStart: true, capEnd: true });
          hg2.sweep(catmull([[hipX - 0.02, hipY + 0.04, cz + s * 0.22], [hipX + 0.12, hipY + 0.13, cz + s * 0.13], buckle], 4, false), { shape: rectShape(0.004, 0.048, 0.0015, 1), up: [1, 1, 0], capStart: true, capEnd: true });
          G('metal').setColor(P.chrome);
          G('metal').obox(vlerp(sh1, chest, 0.35), [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.012, 0.008, 0.03, 1);
        });
        hg2.sweep([[hipX + 0.16, hipY + 0.02, cz], buckle], { shape: rectShape(0.004, 0.048, 0.0015, 1), up: [0, 0, 1], capStart: true, capEnd: true });
        G('metal').setColor(P.metal);
        G('metal').cyl(add(buckle, [0.005, 0, 0]), add(buckle, [0.02, 0.01, 0]), 0.04, 0.04, 20, true);
      });
    }

    /* ---------------- AO bake: darken low / deep geometry (sun has no roof occlusion in a forward renderer) */
    ['soft', 'liner', 'plastic', 'trim', 'metal', 'cage', 'matte', 'carbon', 'seatD', 'seatDc', 'harness', 'harnessD'].forEach(function (k) {
      var gq = groups[k]; if (!gq) return;
      for (var vi = 0; vi < gq.count(); vi++) {
        var y = gq.P[vi * 3 + 1], x = gq.P[vi * 3];
        var ao = 0.38 + 0.62 * smoothstep(floorY - 0.02, yd + 0.04, y);
        if (x > xd + 0.12 && y < yd - 0.15) ao *= 0.6;
        if (k === 'liner') ao = 0.82;
        gq.C[vi * 4] *= ao; gq.C[vi * 4 + 1] *= ao; gq.C[vi * 4 + 2] *= ao;
      }
    });

    var wheelOut = buildWheel(Lx, P, WG);
    var lever = buildLever(Lx, P);
    var hud = null;
    if (Lx.hud) { panels.hud = new Geo(); panel(panels.hud, Lx.hud.c, faceFrame(Lx.hud.c, eye), Lx.hud.w, Lx.hud.h); }
    return {
      groups: groups, wheel: wheel, hands: wheelOut.hands, wrists: wheelOut.wrists, panels: (function () { if (wheelOut.display) panels.wheelDisplay = wheelOut.display; return panels; })(),
      arms: buildArms(P), lever: lever, leverPivot: leverPivot, seatDriver: dSeat, hud: hud
    };
  }

  /* ---------------- steering wheel (wheel-local: rim in the YZ plane at x=0, driver on -X) */
  /** Resample a polyline to `count` points evenly spaced by arc length. */
  function resample(pts, closed, count) {
    var seg = [], tot = 0, n = pts.length, m = closed ? n : n - 1, i;
    for (i = 0; i < m; i++) { var d = len(sub(pts[(i + 1) % n], pts[i])); seg.push(d); tot += d; }
    var out = [], k = 0, acc = 0, steps = closed ? count : count - 1;
    for (i = 0; i < count; i++) {
      var target = tot * i / steps;
      while (k < m - 1 && acc + seg[k] < target) { acc += seg[k]; k++; }
      var t = seg[k] > 0 ? clamp((target - acc) / seg[k], 0, 1) : 0;
      out.push(vlerp(pts[k], pts[(k + 1) % n], t));
    }
    return out;
  }
  function rimPath(type, R) {
    var rp = rimPathRaw(type, R);
    return { pts: resample(rp.pts, rp.closed, LOWPOLY ? (rp.closed ? 32 : 22) : (rp.closed ? 96 : 64)), closed: rp.closed };
  }
  function rimPathRaw(type, R) {
    var pts = [], i, n = 144;
    if (type === 'race-quick-release') {
      var hw = R * 1.2, hh = R * 0.8, ex2 = 2 / 5;              // superellipse: flat top / bottom, rounded grips
      for (i = 0; i < n; i++) {
        var t = i / n * TAU, c = Math.cos(t), s2 = Math.sin(t);
        pts.push([0, hh * (c < 0 ? -1 : 1) * Math.pow(Math.abs(c), ex2), hw * (s2 < 0 ? -1 : 1) * Math.pow(Math.abs(s2), ex2)]);
      }
      return { pts: pts, closed: true };
    }
    if (type === 'yoke') {
      var yk = [[0.075, -R * 0.93], [0.02, -R * 1.02], [-0.045, -R * 1.0], [-0.09, -R * 0.78], [-0.108, -R * 0.35], [-0.112, 0], [-0.108, R * 0.35], [-0.09, R * 0.78], [-0.045, R * 1.0], [0.02, R * 1.02], [0.075, R * 0.93]];
      return { pts: catmull(yk.map(function (p) { return [0, p[0], p[1]]; }), 6, false), closed: false };
    }
    for (i = 0; i < n; i++) {
      var a = i / n * TAU, y = Math.cos(a) * R, z = Math.sin(a) * R;
      if (type === 'flat-bottom' && y < -R * 0.8) y = -R * 0.8 + (y + R * 0.8) * 0.12;
      pts.push([0, y, z]);
    }
    return { pts: pts, closed: true };
  }

  function buildWheel(Lx, P, WG) {
    var type = Lx.wheel.type, R = Lx.wheel.R, race = type === 'race-quick-release', yoke = type === 'yoke', sd2 = Lx.sd || -1;
    var rp = rimPath(type, R), pts = rp.pts, n = pts.length;
    var rimG = WG('rim');
    var suede = race || (P.upholstery && P.upholstery.rough > 0.9);
    var rimCol = suede ? mix(P.primary, [0.02, 0.02, 0.02], 0.5) : P.primary;
    var gripCol = suede ? mix(rimCol, [0, 0, 0], 0.25) : mix(P.primary, [0.008, 0.008, 0.009], 0.38);
    var shape = ellipseShape(1, 1, 12);
    // marker band at 12 o'clock, thicker grips at 9/3
    function sideOf(p) { return Math.atan2(p[2], p[1]); }
    var thick = race ? 0.02 : yoke ? 0.019 : 0.0165;
    var path = pts.slice(), pathClosed = rp.closed;
    rimG.sweep(path, {
      shape: shape, closed: pathClosed, up: function (i2) { var p = path[i2 % path.length]; return [0, p[1], p[2]]; },
      scale: function (t, k) {
        var p = path[k % path.length], a = Math.abs(sideOf(p));
        var grip = Math.exp(-Math.pow((a - PI / 2) / 0.45, 2));
        return [thick * (1 + 0.22 * grip), thick * (1.18 + 0.3 * grip)];
      },
      capStart: !pathClosed, capEnd: !pathClosed, uScale: 5, vScale: 5,
      colors: function (r) {
        var p = path[r % path.length], a = sideOf(p);
        if ((type !== 'round') && Math.abs(a) < (race ? 0.1 : 0.06) && p[1] > 0) return P.accent.concat(1);
        if (race && Math.abs(Math.abs(a) - PI / 2) < 0.5) return mix(P.primary, [0, 0, 0], 0.6).concat(1);
        // two-tone road rims: perforated / suede grip zones at 9 and 3 o'clock, smooth leather crown + base
        if (!race && Math.abs(Math.abs(a) - PI / 2) < 0.62) return gripCol.concat(1);
        return rimCol.concat(1);
      }
    });
    // grip seams: contrast stitching where the grip zone meets the smooth leather (round / flat-bottom / yoke)
    if (!race) {
      [-1, 1].forEach(function (sz) {
        [PI / 2 - 0.62, PI / 2 + 0.62].forEach(function (aa) {
          var ring = [], y0 = Math.cos(aa) * R, z0 = sz * Math.sin(aa) * R, best = 0, bd = Infinity;
          for (var q = 0; q < path.length; q++) { var dd = Math.pow(path[q][1] - y0, 2) + Math.pow(path[q][2] - z0, 2); if (dd < bd) { bd = dd; best = q; } }
          var c0 = path[best], rad = norm([0, c0[1], c0[2]]), rr0 = thick * 1.32;
          for (var k0 = 0; k0 <= 10; k0++) {
            var ph = (k0 / 10) * TAU;
            ring.push(add(c0, add(mul([1, 0, 0], Math.cos(ph) * rr0), mul(rad, Math.sin(ph) * rr0))));
          }
          rimG.setColor(P.stitch);
          rimG.sweep(ring, { radius: 0.0011, sides: 3, closed: true });
        });
      });
    }
    // stitch line on the inner face (toward the driver), contrasting thread
    if (!race) {
      var st = [];
      for (var i = 0; i < n; i++) { var p = path[i], rr = len([0, p[1], p[2]]) || 1; st.push([-thick * 1.1, p[1] * (1 - 0.012 / rr), p[2] * (1 - 0.012 / rr)]); }
      if (pathClosed) st.push(st[0]);
      rimG.setColor(P.stitch);
      rimG.sweep(st, { radius: 0.0016, sides: 4 });
    }
    var hard = WG('hard'), trim = WG('trim'), metal = WG('metal'), leds = WG('leds');
    var display = null;
    if (race) {
      // carbon centre plate, quick-release hub, buttons, rotaries, big paddles, display
      var cp = WG('carbon');
      cp.setColor([1, 1, 1]);
      cp.rrect([0.006, -0.005, 0], [0, 0, 1], [0, 1, 0], R * 2.2, R * 1.5, 0.05, 4, [0, 0, 5, 4], true);
      metal.setColor(P.metalDark);
      metal.cyl([0.012, 0, 0], [0.09, 0, 0], 0.032, 0.03, 18, true);
      metal.setColor(P.metal);
      metal.cyl([0.04, 0, 0], [0.055, 0, 0], 0.042, 0.042, 6, true);
      display = new Geo();
      var dF = { n: [-1, 0, 0], right: [0, 0, 1], up: [0, 1, 0] };
      panel(display, [-0.002, 0.04, 0], dF, 0.105, 0.05);
      hard.setColor(P.rubber);
      hard.obox([0.002, 0.04, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.004, 0.03, 0.058, 1);
      var btnCols = [[0.85, 0.05, 0.03], [0.95, 0.65, 0.02], [0.05, 0.35, 0.9], [0.1, 0.75, 0.2], [0.9, 0.9, 0.9], [0.6, 0.1, 0.8]];
      for (var b = 0; b < 8; b++) {
        var side = b < 4 ? -1 : 1, row = b % 4, by = 0.05 - row * 0.03, bz = side * (0.085 + (row % 2) * 0.012);
        leds.setColor(btnCols[(b + row) % btnCols.length].map(function (v) { return v * 0.75; }));
        leds.cyl([0.0, by, bz], [-0.008, by, bz], 0.0085, 0.0085, 12, true);
        hard.setColor(P.rubber); hard.cyl([0.004, by, bz], [-0.001, by, bz], 0.011, 0.011, 12, true);
      }
      [-0.05, 0.05].forEach(function (z) {
        metal.setColor(P.metal);
        metal.cyl([0.0, -0.06, z], [-0.016, -0.06, z], 0.014, 0.014, 16, true);
        leds.setColor([0.95, 0.95, 0.95]); leds.cyl([-0.0165, -0.06, z], [-0.017, -0.06, z], 0.0035, 0.0035, 8, true);
      });
      // thumb encoders + funky switch
      metal.setColor(P.chrome); metal.cyl([0, -0.025, 0], [-0.02, -0.025, 0], 0.011, 0.01, 12, true);
    } else if (yoke) {
      hard.setColor(P.plastic);
      hard.setTransform(M4.translation(M4.create(), 0.012, -0.02, 0));
      hard.ellipsoid([0, 0, 0], 0.025, 0.05, R * 0.85, 18);
      hard.setTransform(null);
      trim.setColor([1, 1, 1]);
      trim.rrect([-0.0135, -0.02, 0], [0, 0, 1], [0, 1, 0], R * 1.3, 0.05, 0.022, 4, [0, 0, 4, 1], false);
      [-1, 1].forEach(function (s) { leds.setColor([0.35, 0.35, 0.4]); leds.cyl([-0.015, -0.005, s * R * 0.62], [-0.019, -0.005, s * R * 0.62], 0.01, 0.01, 12, true); });
    } else {
      // three-spoke road wheel with an airbag hub
      hard.setColor(P.plastic);
      [-1, 1].forEach(function (s) {
        var a0 = [0.008, -0.005, s * 0.05], a1 = [0.0, -0.02, s * (R - 0.004)];
        hard.sweep([a0, vlerp(a0, a1, 0.5), a1], { shape: rectShape(0.018, 0.04, 0.008, 2), up: [1, 0, 0], capStart: true, capEnd: true });
        trim.setColor([1, 1, 1]);
        var t0 = [-0.0105, -0.012, s * 0.07], t1 = [-0.0085, -0.018, s * (R - 0.03)];
        trim.sweep([t0, t1], { shape: rectShape(0.003, 0.016, 0.001, 1), up: [1, 0, 0], capStart: true, capEnd: true, uScale: 20, vScale: 20 });
        // spoke buttons
        for (var k = 0; k < 3; k++) {
          var bz2 = s * (0.085 + k * 0.022);
          hard.setColor(P.plasticHi); hard.cyl([-0.009, 0.004, bz2], [-0.0135, 0.004, bz2], 0.0065, 0.0065, 10, true);
          leds.setColor([0.55, 0.55, 0.6]); leds.cyl([-0.0137, 0.004, bz2], [-0.014, 0.004, bz2], 0.0018, 0.0018, 6, true);
        }
      });
      var bot = type === 'flat-bottom' ? [-0.02, 0.02] : [0];
      bot.forEach(function (oz) {
        hard.setColor(P.plastic);
        hard.sweep([[0.008, -0.04, oz], [0.0, -R * (type === 'flat-bottom' ? 0.78 : 0.98), oz]], { shape: rectShape(0.016, oz ? 0.016 : 0.036, 0.006, 2), up: [1, 0, 0], capStart: true, capEnd: true });
      });
      // airbag cushion (leather-wrapped, rounded trapezoid) + trim bezel + badge
      hard.setColor(mix(P.primary, P.plastic, 0.5));
      hard.setTransform(M4.translation(M4.create(), 0.008, -0.002, 0));
      hard.ellipsoid([0, 0, 0], 0.026, 0.058, 0.072, 18);
      hard.setTransform(null);
      var bez = rectShape(0.15, 0.118, 0.04, 4).map(function (q) { return [-0.003, q[1] - 0.002, q[0]]; });
      bez.push(bez[0]);
      trim.setColor([1, 1, 1]);
      trim.sweep(bez, { radius: 0.0032, sides: 6, uScale: 20, vScale: 20 });
      if (type === 'flat-bottom') {
        // drive-mode rotary + engine-start button on the lower spokes (sport wheels)
        metal.setColor(P.metal);
        metal.cyl([-0.006, -0.062, sd2 * 0.052], [-0.02, -0.062, sd2 * 0.052], 0.0135, 0.0125, 16, true);
        leds.setColor(P.accent); leds.ring([-0.0205, -0.062, sd2 * 0.052], [-1, 0, 0], 0.0128, 0.0013, 16, 4);
        leds.setColor([0.85, 0.08, 0.04]);
        leds.cyl([-0.006, -0.062, -sd2 * 0.052], [-0.017, -0.062, -sd2 * 0.052], 0.009, 0.009, 14, true);
      }
      metal.setColor(P.chrome);
      metal.cyl([-0.016, 0.0, 0], [-0.0185, 0.0, 0], 0.014, 0.014, 20, true);
      metal.setColor(P.accent);
      metal.cyl([-0.0186, 0.0, 0], [-0.019, 0.0, 0], 0.009, 0.009, 20, true);
    }
    // paddles (rotate with the wheel)
    if (Lx.paddles) {
      var pg = race ? WG('carbon') : (P.trimId === 'carbon' || P.trimId === 'forged-carbon') ? WG('carbon') : metal;
      pg.setColor(race || pg !== metal ? [1, 1, 1] : P.metal);
      [-1, 1].forEach(function (s) {
        // curved blade behind the rim: root at the hub mount, tip just past the rim, gently swept up + back
        var z0 = s * (race ? R * 0.62 : R * 0.42), z1 = s * (race ? R * 1.12 : R * 0.98), yb2 = race ? -0.005 : 0.02;
        var blade = catmull([[0.034, yb2, z0], [0.04, yb2 + 0.012, (z0 + z1) / 2], [0.05, yb2 + 0.004, z1]], 4, false);
        pg.sweep(blade, { shape: rectShape(0.0055, race ? 0.085 : 0.05, 0.002, 1), up: [1, 0, 0], capStart: true, capEnd: true, uScale: 18, vScale: 18,
          scale: function (t) { return [1, lerp(1, 0.78, t * t)]; } });
        // mount boss + upshift / downshift markers on the driver face
        metal.setColor(P.metalDark);
        metal.cyl([0.012, yb2, z0 * 0.92], [0.034, yb2, z0], 0.008, 0.007, 10, true);
        leds.setColor([0.42, 0.42, 0.44]);
        var mz = lerp(z0, z1, 0.62);
        leds.obox([0.0365, yb2 + 0.012, mz], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.0006, s > 0 ? 0.0015 : 0.0015, 0.007, 1);
        if (s > 0) leds.obox([0.0365, yb2 + 0.012, mz], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.0006, 0.007, 0.0015, 1);
      });
    }
    // gloves at roughly 9:15 / 2:45
    var hands = [], wrists = [];
    [-1, 1].forEach(function (s) {
      // grip = rim point with the largest |z| on this side near y ~ 0
      var best = null, bi = 0, yT = race || yoke ? 0.015 : R * 0.22;
      for (var i2 = 0; i2 < pts.length; i2++) {
        var p2 = pts[i2];
        if (p2[2] * s <= 0 || Math.abs(p2[1] - yT) > 0.035) continue;
        if (!best || p2[2] * s > best[2] * s) { best = p2; bi = i2; }
      }
      best = best || [0, 0, s * R];
      var nb = pts[(bi + 1) % pts.length], pb = pts[(bi - 1 + pts.length) % pts.length];
      var tv = norm(sub(nb, pb)); if (tv[1] < 0) tv = mul(tv, -1);
      var rv = race || yoke ? [0, 0, s] : norm([0, best[1], best[2]]), nv = [-1, 0, 0];
      var g = new Geo(), gc = best, rimT = thick * 1.25;
      g.setColor(P.glove);
      g.setTransform(M4.basis(tv, rv, cross(tv, rv), madd(madd(gc, nv, 0.03), rv, 0.016)));
      g.ellipsoid([0, 0, 0], 0.05, 0.03, 0.024, 14);
      g.setTransform(null);
      // fingers wrap the rim from the driver side over the outside to the back
      for (var f = 0; f < 4; f++) {
        var off = (f - 1.5) * 0.0205 + 0.006, fl = f === 3 ? 0.8 : f === 0 ? 0.92 : 1;
        var c0 = madd(gc, tv, off), fp = [];
        for (var q = 0; q <= 6; q++) {
          var ph = lerp(65, -175 * fl, q / 6) * DEG, rho = rimT + 0.0105;
          fp.push(add(c0, add(mul(rv, Math.cos(ph) * rho), mul(nv, Math.sin(ph) * rho))));
        }
        fp[0] = madd(madd(c0, nv, 0.028), rv, 0.02);
        g.setColor(P.glove);
        g.sweep(fp, { radius: 0.0098, sides: 8, scale: function (t) { return lerp(1.08, 0.82, t); }, capStart: true, capEnd: true });
      }
      // thumb along the inner side of the rim
      g.sweep(catmull([madd(madd(madd(gc, nv, 0.03), rv, -0.004), tv, 0.026), madd(madd(madd(gc, nv, 0.022), rv, -0.03), tv, 0.03), madd(madd(madd(gc, nv, 0.015), rv, -0.052), tv, 0.018)], 3, false),
        { radius: 0.0115, sides: 8, scale: function (t) { return lerp(1, 0.85, t); }, capStart: true, capEnd: true });
      // accent stripe on the back of the hand + cuff
      g.setColor(P.gloveAccent);
      g.setTransform(M4.basis(tv, rv, cross(tv, rv), madd(madd(gc, nv, 0.05), rv, 0.022)));
      g.box(0, 0.0, 0, 0.06, 0.006, 0.012, 1);
      g.setTransform(null);
      var wdir = norm(add(add(mul(nv, 1), mul(rv, 0.35)), mul(tv, -0.45)));
      var w0 = madd(madd(gc, nv, 0.05), rv, 0.026), w1 = madd(w0, wdir, 0.075);
      g.setColor(P.glove); g.cyl(w0, madd(w0, wdir, 0.045), 0.026, 0.029, 12, true);
      g.setColor(P.gloveCuff); g.cyl(madd(w0, wdir, 0.045), w1, 0.0305, 0.032, 12, true);
      hands.push(g); wrists.push(w1);
    });
    return { hands: hands, wrists: wrists, display: display };
  }

  /** Unit sleeves: along +X from 0 to 1, radius 1 (upper arm, forearm with a cuff stripe). */
  function buildArms(P) {
    var up = new Geo(), fo = new Geo();
    up.setColor(P.suit);
    up.sweep([[0, 0, 0], [0.5, 0, 0], [1, 0, 0]], { radius: 1, sides: 12, scale: function (t) { return lerp(1, 0.86, t); }, capStart: true, capEnd: true, up: [0, 1, 0] });
    // suit sleeve with a narrow accent cuff stripe near the wrist (rings 2..3 only, so no long colour gradient)
    var fx = [0, 0.76, 0.775, 0.86, 0.875, 1];
    fo.sweep(fx.map(function (x) { return [x, 0, 0]; }), {
      radius: 1, sides: 12, scale: function (t, k) { return lerp(1, 0.8, fx[k]); }, capStart: true, capEnd: true, up: [0, 1, 0],
      colors: function (r) { return (r === 2 || r === 3 ? P.gloveAccent : P.suit).concat(1); }
    });
    return { upper: up, fore: fo };
  }

  /** Gear selector in pivot-local space (+Y up, +X forward). */
  function buildLever(Lx, P) {
    var g = new Geo();
    if (Lx.manual) {
      g.setColor(P.primary); g.cyl([0, 0, 0], [0, 0.07, 0], 0.048, 0.014, 14, true);
      g.setColor(P.chrome); g.cyl([0, 0.06, 0], [0, 0.135, 0], 0.0065, 0.0065, 10, true);
      g.setColor(P.metal); g.ellipsoid([0, 0.155, 0], 0.026, 0.024, 0.026, 16);
      g.setColor(P.rubber); g.box(0, 0.178, 0, 0.022, 0.002, 0.022, 1);
    } else if (Lx.sequential) {
      g.setColor(P.metalDark); g.box(0, 0.01, 0, 0.12, 0.02, 0.06, 1);
      g.setColor(P.chrome); g.cyl([0, 0.0, 0], [-0.05, 0.24, 0], 0.008, 0.008, 10, true);
      g.setColor(P.rubber); g.cyl([-0.05, 0.24, -0.045], [-0.05, 0.24, 0.045], 0.015, 0.015, 12, true);
    } else if (Lx.ev || Lx.trans === 'single-speed') {
      g.setColor(P.metal); g.cyl([0, 0, 0], [0, 0.028, 0], 0.03, 0.028, 24, true);
      g.setColor(P.rubber); g.cyl([0, 0.028, 0], [0, 0.03, 0], 0.024, 0.024, 24, true);
    } else {
      g.setColor(P.plastic); g.setTransform(M4.translation(M4.create(), -0.01, 0.035, 0));
      g.ellipsoid([0, 0, 0], 0.055, 0.03, 0.03, 16);
      g.setTransform(null);
      g.setColor(P.metal); g.box(0.0, 0.064, 0, 0.05, 0.004, 0.026, 1);
      g.setColor(P.chrome); g.box(-0.035, 0.05, 0, 0.012, 0.012, 0.03, 1);
    }
    return g;
  }

  /* ==================================================================
     Head model (pure): g-force lean, braking nod, look-into-corner, road buzz, impulses
     ================================================================== */
  function headModel(opts) {
    opts = opts || {};
    function S(w, z) { return { x: 0, v: 0, w: w, z: z }; }
    var st = { x: S(8.5, 0.62), y: S(11, 0.55), z: S(8, 0.6), yaw: S(5, 0.9), pitch: S(9, 0.7), roll: S(7, 0.75), t: 0, kick: 0 };
    var out = { offset: [0, 0, 0], yaw: 0, pitch: -0.04, roll: 0 };
    var basePitch = num(opts.basePitch, -0.085);
    function step(s, target, dt) {
      var n = Math.max(1, Math.ceil(dt / (1 / 240))), h = dt / n;
      for (var i = 0; i < n; i++) {
        var a = s.w * s.w * (target - s.x) - 2 * s.z * s.w * s.v;
        s.v += a * h; s.x += s.v * h;
      }
      if (!isFinite(s.x) || !isFinite(s.v)) { s.x = target; s.v = 0; }
      return s.x;
    }
    function noise(t, f, ph) { return Math.sin(t * f + ph) * 0.5 + Math.sin(t * f * 1.73 + ph * 2.1) * 0.3 + Math.sin(t * f * 2.91 + ph * 0.7) * 0.2; }
    return {
      state: st, out: out,
      reset: function () { ['x', 'y', 'z', 'yaw', 'pitch', 'roll'].forEach(function (k) { st[k].x = 0; st[k].v = 0; }); },
      impulse: function (k) {
        k = clamp(num(k, 0.5), 0, 1.5);
        var sgn = (Math.floor(st.t * 7.3) & 1) ? 1 : -1;
        st.x.v += 0.55 * k; st.z.v += sgn * 0.6 * k; st.y.v += 0.35 * k; st.roll.v += sgn * 0.5 * k; st.pitch.v -= 0.3 * k;
      },
      update: function (v, dt, time) {
        v = v || {}; dt = clamp(num(dt, 1 / 60), 0, 0.1);
        st.t = num(time, st.t + dt);
        var latG = clamp(num(v.latG, 0), -3.5, 3.5), longG = clamp(num(v.longG, 0), -3, 3), sp = Math.abs(num(v.speed, 0));
        var surf = v.surface || 'asphalt';
        var rough = surf === 'kerb' ? 1 : (surf === 'grass' || surf === 'gravel' || surf === 'sand') ? 1.6 : 0;
        var buzz = (0.0007 + 0.0009 * smoothstep(5, 70, sp)) + rough * 0.0045 * smoothstep(2, 20, sp);
        var t = st.t, f = rough ? 38 : 21;
        var bob = noise(t, f, 0.3) * buzz, sway = noise(t, f * 0.8, 1.9) * buzz * 0.5;
        var ox = step(st.x, -longG * 0.03, dt);
        var oy = step(st.y, -Math.abs(latG) * 0.004 - Math.max(0, -longG) * 0.006, dt) + bob;
        var oz = step(st.z, latG * 0.024, dt) + sway;
        var yaw = step(st.yaw, clamp(num(v.steerAngle, 0) * 0.5, -0.2, 0.2), dt);
        var pitch = step(st.pitch, basePitch + clamp(longG, -2, 2) * 0.011, dt) + bob * 1.4;
        var roll = step(st.roll, -latG * 0.011, dt);
        out.offset[0] = clamp(ox, -0.09, 0.09); out.offset[1] = clamp(oy, -0.06, 0.05); out.offset[2] = clamp(oz, -0.09, 0.09);
        out.yaw = clamp(yaw, -0.3, 0.3); out.pitch = clamp(pitch, -0.25, 0.15); out.roll = clamp(roll, -0.08, 0.08);
        return out;
      }
    };
  }
  /** yaw (+ = left), pitch (+ = up), roll (+ = top toward +Z) -> forward / up unit vectors (car-local). */
  function viewBasis(yaw, pitch, roll) {
    var cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    var f = [cp * cy, sp, -cp * sy], u0 = [-sp * cy, cp, sp * sy], r = cross(f, u0);
    var cr = Math.cos(roll), sr = Math.sin(roll);
    return { forward: f, up: [u0[0] * cr + r[0] * sr, u0[1] * cr + r[1] * sr, u0[2] * cr + r[2] * sr], right: r };
  }

  /* ==================================================================
     Canvas painters (pure: any CanvasRenderingContext2D-like object)
     ================================================================== */
  var FONT = '"SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif';
  var MONO = '"SF Mono", Menlo, Consolas, monospace';
  function fmtTime(s) {
    if (!(s > 0) || !isFinite(s)) return '-:--.---';
    var m = Math.floor(s / 60), r = s - m * 60, w = Math.floor(r), ms = Math.floor((r - w) * 1000);
    return m + ':' + (w < 10 ? '0' : '') + w + '.' + (ms < 100 ? (ms < 10 ? '00' : '0') : '') + ms;
  }
  /** Same rule as the race HUD gear box (js/race/hud.js) so the dash and the HUD never disagree (e.g. '1' on the grid):
      null / 0 -> N, negative or reverse -> R, single-speed (EV) first gear -> D, else the gear number. */
  function gearLabel(st) {
    if (st.gear == null || st.gear === '') return st.reverse ? 'R' : 'N';
    if (st.reverse || num(st.gear, 1) < 0) return 'R';
    var g = Math.round(num(st.gear, 1));
    if (g <= 0) return 'N';
    if (g === 1 && st.maxGear != null && num(st.maxGear, 2) <= 1) return 'D';
    return String(g);
  }
  function speedVal(st) { return Math.abs(num(st.speed, 0)) * (st.units === 'mph' ? 2.23694 : 3.6); }
  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r); g.lineTo(x + w, y + h - r);
    g.arcTo(x + w, y + h, x + w - r, y + h, r); g.lineTo(x + r, y + h); g.arcTo(x, y + h, x, y + h - r, r); g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r); g.closePath();
  }
  function grad(g, kind, a, b, c, d, stops) {
    var gr = kind === 'r' ? g.createRadialGradient(a, b, 0, a, b, c) : g.createLinearGradient(a, b, c, d);
    if (gr && gr.addColorStop) stops.forEach(function (s) { gr.addColorStop(s[0], s[1]); });
    return gr;
  }
  function shiftColor(i, n) { var f = i / (n - 1); return f < 0.4 ? '#36e06a' : f < 0.75 ? '#ffb020' : f < 0.95 ? '#ff3826' : '#4ea8ff'; }

  /** Shift-light LED row (also used on the race wheel display). */
  function drawLeds(g, x, y, w, h, frac, n, blink) {
    n = n || 15;
    var r = Math.min(h * 0.42, w / n * 0.38), gap = w / n;
    for (var i = 0; i < n; i++) {
      var on = frac >= 0.8 + (i / (n - 1)) * 0.17, cx = x + gap * (i + 0.5), cy = y + h / 2;
      var col = blink ? '#4ea8ff' : shiftColor(i, n);
      g.fillStyle = on || blink ? col : '#15181c';
      if (on || blink) { g.globalAlpha = 0.28; g.beginPath(); g.arc(cx, cy, r * 1.9, 0, TAU); g.fill(); g.globalAlpha = 1; }
      g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
    }
  }

  /** Instrument cluster. st: {speed, rpm, redline, gear, units, needle (0..1 smoothed), throttle, brake, lap, lapsTotal, position,
      count, lapTime, lastLap, bestLap, latG, longG, digital, phase, limiter, time}; theme {accent, ambient} css colours. */
  function drawCluster(g, W, H, st, theme) {
    st = st || {}; theme = theme || {};
    var acc = theme.accent || '#c8a24a', red = Math.max(1000, num(st.redline, 7500)), rpm = clamp(num(st.rpm, 0), 0, red * 1.08);
    var f = clamp(num(st.needle, rpm / red), 0, 1.08), spd = speedVal(st), gear = gearLabel(st);
    var limiter = f > 0.985 && (Math.floor(num(st.time, 0) * 12) & 1) === 0;
    g.save();
    g.fillStyle = grad(g, 'r', W / 2, H * 0.6, W * 0.62, 0, [[0, '#0d1117'], [0.6, '#06080b'], [1, '#020304']]) || '#05070a';
    g.fillRect(0, 0, W, H);
    if (st.digital !== false) {
      // ---- digital: central 270 deg tach, side panels
      var cx = W / 2, cy = H * 0.6, R = H * 0.46;
      var a0 = PI * 0.75, a1 = PI * 2.25, aR = a0 + (a1 - a0) * Math.min(1, 1);
      g.lineCap = 'butt';
      g.lineWidth = R * 0.12; g.strokeStyle = '#141920';
      g.beginPath(); g.arc(cx, cy, R * 0.9, a0, a1); g.stroke();
      // redline zone
      var redF = clamp((red - 500) / red, 0.6, 0.98);
      g.strokeStyle = '#4a0d0b'; g.beginPath(); g.arc(cx, cy, R * 0.9, a0 + (a1 - a0) * redF, a1); g.stroke();
      // progress
      var pf = clamp(f, 0, 1);
      g.strokeStyle = grad(g, 'l', cx - R, 0, cx + R, 0, [[0, acc], [0.7, '#f4efe6'], [1, '#ff3826']]) || acc;
      g.beginPath(); g.arc(cx, cy, R * 0.9, a0, a0 + (a1 - a0) * pf); g.stroke();
      // ticks + numerals
      var kmax = Math.ceil(red / 1000);
      g.fillStyle = '#c9c4ba'; g.font = '600 ' + Math.round(R * 0.13) + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (var k = 0; k <= kmax * 2; k++) {
        var rf = (k * 500) / (kmax * 1000), a = a0 + (a1 - a0) * rf, major = k % 2 === 0;
        var r0 = R * (major ? 0.74 : 0.79), r1 = R * 0.83;
        g.strokeStyle = rf * kmax * 1000 >= red - 500 ? '#ff4b3a' : major ? '#d8d2c6' : '#6c6a66';
        g.lineWidth = major ? 3 : 1.5;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.stroke();
        if (major) g.fillText(String(k / 2), cx + Math.cos(a) * R * 0.62, cy + Math.sin(a) * R * 0.62);
      }
      // needle sweep with glow
      var an = a0 + (a1 - a0) * Math.min(f, 1.04) * (kmax * 1000 > 0 ? red / (kmax * 1000) : 1);
      an = a0 + (a1 - a0) * clamp(rpm / (kmax * 1000), 0, 1);
      if (isFinite(st.needle)) an = a0 + (a1 - a0) * clamp(st.needle * red / (kmax * 1000), 0, 1);
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(255,80,40,0.25)'; g.lineWidth = 12;
      g.beginPath(); g.moveTo(cx + Math.cos(an) * R * 0.3, cy + Math.sin(an) * R * 0.3); g.lineTo(cx + Math.cos(an) * R * 0.97, cy + Math.sin(an) * R * 0.97); g.stroke();
      g.strokeStyle = '#ff5a2a'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(cx + Math.cos(an) * R * 0.3, cy + Math.sin(an) * R * 0.3); g.lineTo(cx + Math.cos(an) * R * 0.97, cy + Math.sin(an) * R * 0.97); g.stroke();
      // hub: gear + speed
      g.fillStyle = '#07090c'; g.beginPath(); g.arc(cx, cy, R * 0.42, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 2; g.stroke();
      g.fillStyle = limiter ? '#4ea8ff' : f > 0.93 ? '#ff4b3a' : '#f4efe6';
      g.font = '700 ' + Math.round(R * 0.5) + 'px ' + FONT; g.fillText(gear, cx, cy - R * 0.04);
      g.fillStyle = '#f4efe6'; g.font = '600 ' + Math.round(R * 0.2) + 'px ' + MONO; g.fillText(String(Math.round(spd)), cx, cy + R * 0.58);
      g.fillStyle = '#7d7a74'; g.font = '600 ' + Math.round(R * 0.08) + 'px ' + FONT; g.fillText(st.units === 'mph' ? 'MPH' : 'KM/H', cx, cy + R * 0.75);
      g.fillText('x1000 RPM', cx, cy - R * 0.62);
      // shift lights
      drawLeds(g, W * 0.3, H * 0.02, W * 0.4, H * 0.075, f, 15, limiter);
      // left panel: lap data
      var lx = W * 0.035, lw = W * 0.25;
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      g.fillStyle = acc; g.font = '700 ' + Math.round(H * 0.065) + 'px ' + FONT;
      g.fillText('P' + (st.position || '-') + (st.count ? '/' + st.count : ''), lx, H * 0.2);
      g.textAlign = 'right'; g.fillStyle = '#c9c4ba';
      g.fillText('LAP ' + Math.min(num(st.lap, 0) + 1, num(st.lapsTotal, 99)) + (st.lapsTotal ? '/' + st.lapsTotal : ''), lx + lw, H * 0.2);
      g.textAlign = 'left';
      g.fillStyle = '#f4efe6'; g.font = '600 ' + Math.round(H * 0.11) + 'px ' + MONO; g.fillText(fmtTime(st.lapTime), lx, H * 0.37);
      g.font = '500 ' + Math.round(H * 0.055) + 'px ' + FONT; g.fillStyle = '#7d7a74';
      g.fillText('LAST', lx, H * 0.5); g.fillText('BEST', lx, H * 0.62);
      g.font = '600 ' + Math.round(H * 0.06) + 'px ' + MONO; g.fillStyle = '#d8d2c6';
      g.textAlign = 'right'; g.fillText(fmtTime(st.lastLap), lx + lw, H * 0.5);
      g.fillStyle = '#b892ff'; g.fillText(fmtTime(st.bestLap), lx + lw, H * 0.62);
      // gap ahead / delta bar
      g.textAlign = 'left'; g.fillStyle = '#7d7a74'; g.font = '500 ' + Math.round(H * 0.055) + 'px ' + FONT;
      g.fillText('GAP', lx, H * 0.74);
      g.textAlign = 'right'; g.fillStyle = '#d8d2c6'; g.font = '600 ' + Math.round(H * 0.06) + 'px ' + MONO;
      g.fillText(isFinite(st.gapAhead) && st.gapAhead > 0 ? '+' + st.gapAhead.toFixed(2) : '--', lx + lw, H * 0.74);
      // pedals
      var by = H * 0.82, bh = H * 0.05;
      g.fillStyle = '#141920'; g.fillRect(lx, by, lw, bh); g.fillRect(lx, by + bh * 1.5, lw, bh);
      g.fillStyle = '#36e06a'; g.fillRect(lx, by, lw * clamp(num(st.throttle, 0), 0, 1), bh);
      g.fillStyle = '#ff3826'; g.fillRect(lx, by + bh * 1.5, lw * clamp(num(st.brake, 0), 0, 1), bh);
      // right panel: g-meter + temps
      var gx = W * 0.83, gy = H * 0.42, gr2 = H * 0.24;
      g.strokeStyle = '#2a2f37'; g.lineWidth = 2;
      g.beginPath(); g.arc(gx, gy, gr2, 0, TAU); g.stroke();
      g.beginPath(); g.arc(gx, gy, gr2 * 0.5, 0, TAU); g.stroke();
      g.beginPath(); g.moveTo(gx - gr2, gy); g.lineTo(gx + gr2, gy); g.moveTo(gx, gy - gr2); g.lineTo(gx, gy + gr2); g.stroke();
      var dx = clamp(num(st.latG, 0) / 2, -1, 1) * gr2, dy = clamp(-num(st.longG, 0) / 2, -1, 1) * gr2;
      g.fillStyle = acc; g.beginPath(); g.arc(gx - dx, gy + dy, H * 0.025, 0, TAU); g.fill();
      g.textAlign = 'center'; g.fillStyle = '#7d7a74'; g.font = '500 ' + Math.round(H * 0.05) + 'px ' + FONT;
      g.fillText((Math.hypot(num(st.latG, 0), num(st.longG, 0))).toFixed(1) + ' G', gx, gy + gr2 + H * 0.09);
      var tyres = st.tyres || [0.5, 0.5, 0.5, 0.5];
      for (var ti = 0; ti < 4; ti++) {
        var tx = W * 0.745 + (ti % 2) * W * 0.17, ty = H * 0.86 + Math.floor(ti / 2) * H * 0.0;
        if (ti >= 2) continue;
        var tv = clamp(tyres[ti], 0, 1);
        g.fillStyle = tv > 0.75 ? '#ff6a3a' : tv > 0.45 ? '#36e06a' : '#4ea8ff';
        rr(g, tx - W * 0.03, ty - H * 0.04, W * 0.06, H * 0.08, 6); g.fill();
      }
    } else {
      // ---- analogue: tach + speedo with chrome bezels, LCD between
      function dial(cx2, cy2, R2, maxV, step2, val, label, redFrom) {
        g.fillStyle = grad(g, 'r', cx2, cy2 - R2 * 0.3, R2 * 1.2, 0, [[0, '#1c2026'], [1, '#07080a']]) || '#0b0d10';
        g.beginPath(); g.arc(cx2, cy2, R2, 0, TAU); g.fill();
        g.lineWidth = R2 * 0.06; g.strokeStyle = grad(g, 'l', cx2 - R2, cy2 - R2, cx2 + R2, cy2 + R2, [[0, '#f2f2f2'], [0.5, '#6d7078'], [1, '#d9d9d9']]) || '#aaa';
        g.beginPath(); g.arc(cx2, cy2, R2 * 1.0, 0, TAU); g.stroke();
        var b0 = PI * 0.72, b1 = PI * 2.28;
        if (redFrom != null) { g.strokeStyle = '#b3121f'; g.lineWidth = R2 * 0.07; g.beginPath(); g.arc(cx2, cy2, R2 * 0.84, b0 + (b1 - b0) * redFrom / maxV, b1); g.stroke(); }
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '600 ' + Math.round(R2 * 0.15) + 'px ' + FONT;
        for (var v2 = 0; v2 <= maxV + 1e-6; v2 += step2 / 2) {
          var a2 = b0 + (b1 - b0) * v2 / maxV, maj = Math.abs((v2 / step2) - Math.round(v2 / step2)) < 1e-6;
          g.strokeStyle = maj ? '#f1ece2' : '#8a867e'; g.lineWidth = maj ? 3 : 1.5;
          g.beginPath(); g.moveTo(cx2 + Math.cos(a2) * R2 * (maj ? 0.76 : 0.82), cy2 + Math.sin(a2) * R2 * (maj ? 0.76 : 0.82)); g.lineTo(cx2 + Math.cos(a2) * R2 * 0.9, cy2 + Math.sin(a2) * R2 * 0.9); g.stroke();
          if (maj) { g.fillStyle = '#f1ece2'; g.fillText(String(Math.round(label === 'rpm' ? v2 / 1000 : v2)), cx2 + Math.cos(a2) * R2 * 0.6, cy2 + Math.sin(a2) * R2 * 0.6); }
        }
        g.fillStyle = '#8a867e'; g.font = '500 ' + Math.round(R2 * 0.09) + 'px ' + FONT;
        g.fillText(label === 'rpm' ? 'x1000 r/min' : (st.units === 'mph' ? 'MPH' : 'km/h'), cx2, cy2 + R2 * 0.35);
        var an2 = b0 + (b1 - b0) * clamp(val / maxV, 0, 1.02);
        g.strokeStyle = '#ff6a1a'; g.lineCap = 'round'; g.lineWidth = R2 * 0.035;
        g.beginPath(); g.moveTo(cx2 - Math.cos(an2) * R2 * 0.14, cy2 - Math.sin(an2) * R2 * 0.14); g.lineTo(cx2 + Math.cos(an2) * R2 * 0.88, cy2 + Math.sin(an2) * R2 * 0.88); g.stroke();
        g.fillStyle = '#1d1f23'; g.beginPath(); g.arc(cx2, cy2, R2 * 0.09, 0, TAU); g.fill();
        g.strokeStyle = '#555'; g.lineWidth = 2; g.stroke();
      }
      var R3 = H * 0.46, maxR = Math.ceil(red / 1000) * 1000 + 1000;
      dial(W * 0.3, H * 0.5, R3, maxR, 1000, clamp(num(st.needle, rpm / red), 0, 1.1) * red, 'rpm', red);
      var maxS = st.units === 'mph' ? 220 : 340;
      dial(W * 0.7, H * 0.5, R3, maxS, st.units === 'mph' ? 20 : 40, spd, 'spd', null);
      // LCD
      g.fillStyle = '#0d1a14'; rr(g, W * 0.455, H * 0.62, W * 0.09, H * 0.3, 8); g.fill();
      g.fillStyle = f > 0.93 ? '#ff5a3a' : '#9dffc7'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = '700 ' + Math.round(H * 0.17) + 'px ' + MONO; g.fillText(gear, W / 2, H * 0.72);
      g.font = '600 ' + Math.round(H * 0.055) + 'px ' + MONO; g.fillText(fmtTime(st.lapTime), W / 2, H * 0.86);
      g.fillStyle = '#c9c4ba'; g.font = '600 ' + Math.round(H * 0.07) + 'px ' + FONT;
      g.fillText('P' + (st.position || '-'), W / 2, H * 0.2);
      g.fillStyle = '#7d7a74'; g.font = '500 ' + Math.round(H * 0.05) + 'px ' + FONT;
      g.fillText('LAP ' + Math.min(num(st.lap, 0) + 1, num(st.lapsTotal, 99)) + (st.lapsTotal ? '/' + st.lapsTotal : ''), W / 2, H * 0.3);
      // shift light
      if (f > 0.9) { g.fillStyle = limiter ? '#4ea8ff' : '#ff3826'; g.beginPath(); g.arc(W / 2, H * 0.47, H * 0.04, 0, TAU); g.fill(); }
    }
    // glass sheen
    g.fillStyle = grad(g, 'l', 0, 0, 0, H, [[0, 'rgba(255,255,255,0.05)'], [0.35, 'rgba(255,255,255,0)'], [1, 'rgba(255,255,255,0)']]) || 'rgba(0,0,0,0)';
    g.fillRect(0, 0, W, H);
    g.restore();
  }

  /** Precompute a normalised minimap polyline from track geometry. */
  function minimapFrom(geom) {
    var S = geom && (geom.samples || geom.points);
    if (!S || !S.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, step = Math.max(1, Math.floor(S.length / 360)), pts = [];
    for (var i = 0; i < S.length; i += step) {
      var p = S[i], x = num(p.x, 0), y = num(p.y, 0);
      pts.push([x, y]);
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    var sc = 1 / Math.max(maxX - minX, maxY - minY, 1);
    return { pts: pts, minX: minX, minY: minY, sx: maxX - minX, sy: maxY - minY, sc: sc, name: geom.name || (geom.def && geom.def.name) || '', length: num(geom.length, 0) };
  }
  function mapXY(mm, x, y, ox, oy, size) {
    var cxm = (mm.minX + mm.sx / 2), cym = (mm.minY + mm.sy / 2);
    return [ox + size / 2 + (x - cxm) * mm.sc * size * 0.9, oy + size / 2 - (y - cym) * mm.sc * size * 0.9];
  }

  /** Centre screen: header, minimap with all cars, standings, big speed + lap tiles. */
  function drawCenterScreen(g, W, H, st, theme, mm, cars) {
    st = st || {}; theme = theme || {};
    var acc = theme.accent || '#c8a24a', portrait = H > W;
    g.save();
    g.fillStyle = grad(g, 'l', 0, 0, 0, H, [[0, '#0b0f15'], [1, '#040507']]) || '#07090c';
    g.fillRect(0, 0, W, H);
    var hh = Math.round(Math.min(W, H) * 0.11);
    g.fillStyle = 'rgba(255,255,255,0.04)'; g.fillRect(0, 0, W, hh);
    g.fillStyle = acc; g.font = '800 ' + Math.round(hh * 0.5) + 'px ' + FONT; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText('REDLINE', hh * 0.4, hh / 2);
    g.fillStyle = '#c9c4ba'; g.font = '500 ' + Math.round(hh * 0.4) + 'px ' + FONT;
    g.textAlign = 'center'; g.fillText((mm && mm.name ? String(mm.name).toUpperCase() : 'RACE') + (st.weather ? '  ·  ' + String(st.weather).toUpperCase() : ''), W / 2, hh / 2);
    g.textAlign = 'right'; g.fillText('LAP ' + Math.min(num(st.lap, 0) + 1, num(st.lapsTotal, 99)) + (st.lapsTotal ? '/' + st.lapsTotal : ''), W - hh * 0.4, hh / 2);
    // minimap
    var ms = portrait ? Math.min(W * 0.92, H * 0.5) : Math.min(H - hh * 1.4, W * 0.48);
    var mx = portrait ? (W - ms) / 2 : hh * 0.3, my = hh * 1.15;
    g.fillStyle = 'rgba(255,255,255,0.025)'; rr(g, mx, my, ms, ms, 14); g.fill();
    if (mm && mm.pts.length > 2) {
      g.lineJoin = 'round'; g.lineCap = 'round';
      [[ms * 0.05, '#1d232c'], [ms * 0.026, '#59606b']].forEach(function (pass) {
        g.strokeStyle = pass[1]; g.lineWidth = pass[0]; g.beginPath();
        mm.pts.forEach(function (p, i) { var q = mapXY(mm, p[0], p[1], mx, my, ms); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); });
        g.closePath(); g.stroke();
      });
      var s0 = mapXY(mm, mm.pts[0][0], mm.pts[0][1], mx, my, ms);
      g.fillStyle = '#f4efe6'; g.fillRect(s0[0] - 3, s0[1] - 3, 6, 6);
      (cars || []).forEach(function (c) {
        if (!c || c.dnf) return;
        var q = mapXY(mm, num(c.x, 0), num(c.y, 0), mx, my, ms), me = c.isPlayer;
        g.fillStyle = me ? '#ffffff' : (c.color || '#888');
        g.beginPath(); g.arc(q[0], q[1], me ? ms * 0.022 : ms * 0.014, 0, TAU); g.fill();
        if (me) { g.strokeStyle = acc; g.lineWidth = 3; g.stroke(); }
      });
    }
    // tiles / standings
    var tx = portrait ? W * 0.04 : mx + ms + hh * 0.4, ty = portrait ? my + ms + hh * 0.3 : my, tw = portrait ? W * 0.92 : W - tx - hh * 0.3;
    var th = portrait ? H - ty - hh * 0.3 : ms;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillStyle = '#f4efe6'; g.font = '700 ' + Math.round(th * 0.2) + 'px ' + MONO;
    g.fillText(String(Math.round(speedVal(st))), tx, ty + th * 0.2);
    g.fillStyle = '#7d7a74'; g.font = '600 ' + Math.round(th * 0.06) + 'px ' + FONT;
    g.fillText(st.units === 'mph' ? 'MPH' : 'KM/H', tx, ty + th * 0.28);
    g.textAlign = 'right'; g.fillStyle = acc; g.font = '800 ' + Math.round(th * 0.2) + 'px ' + FONT;
    g.fillText('P' + (st.position || '-'), tx + tw, ty + th * 0.2);
    g.fillStyle = '#7d7a74'; g.font = '600 ' + Math.round(th * 0.06) + 'px ' + FONT; g.fillText(st.count ? 'OF ' + st.count : '', tx + tw, ty + th * 0.28);
    var list = (cars || []).slice().filter(function (c) { return c && !c.dnf; }).sort(function (a, b) { return num(a.position, 99) - num(b.position, 99); });
    var rows = Math.min(list.length, portrait ? 6 : 5), rh = th * 0.115;
    for (var i = 0; i < rows; i++) {
      var c = list[i], y = ty + th * 0.4 + i * rh;
      if (c.isPlayer) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(tx, y - rh * 0.78, tw, rh * 0.95); }
      g.fillStyle = c.color || '#888'; g.fillRect(tx, y - rh * 0.68, 5, rh * 0.75);
      g.textAlign = 'left'; g.fillStyle = c.isPlayer ? '#ffffff' : '#c9c4ba'; g.font = '600 ' + Math.round(rh * 0.55) + 'px ' + FONT;
      g.fillText((c.position || i + 1) + '  ' + String(c.name || ('Car ' + (c.number || ''))).slice(0, 14), tx + 14, y);
      g.textAlign = 'right'; g.fillStyle = '#8a867e'; g.font = '500 ' + Math.round(rh * 0.5) + 'px ' + MONO;
      g.fillText(i === 0 ? 'LEADER' : (isFinite(c.gapLeader_s) ? '+' + num(c.gapLeader_s, 0).toFixed(1) : ''), tx + tw, y);
    }
    g.textAlign = 'left'; g.fillStyle = '#7d7a74'; g.font = '500 ' + Math.round(th * 0.05) + 'px ' + FONT;
    g.fillText('BEST ' + fmtTime(st.bestLap) + '    LAST ' + fmtTime(st.lastLap), tx, ty + th * 0.98);
    g.restore();
  }

  /** Windscreen head-up display (transparent background). */
  function drawHud(g, W, H, st, theme) {
    st = st || {}; theme = theme || {};
    var col = theme.hud || '#9dffd0', red = Math.max(1000, num(st.redline, 7500)), f = clamp(num(st.needle, num(st.rpm, 0) / red), 0, 1.05);
    g.save();
    if (g.clearRect) g.clearRect(0, 0, W, H);
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillStyle = col; g.globalAlpha = 0.92;
    g.font = '700 ' + Math.round(H * 0.42) + 'px ' + FONT; g.fillText(String(Math.round(speedVal(st))), W * 0.5, H * 0.55);
    g.font = '600 ' + Math.round(H * 0.1) + 'px ' + FONT; g.globalAlpha = 0.7; g.fillText(st.units === 'mph' ? 'MPH' : 'KM/H', W * 0.5, H * 0.7);
    g.globalAlpha = 0.95; g.font = '700 ' + Math.round(H * 0.32) + 'px ' + FONT;
    g.fillStyle = f > 0.93 ? '#ff6a4a' : col; g.fillText(gearLabel(st), W * 0.8, H * 0.52);
    // rpm bar
    var bx = W * 0.25, bw = W * 0.5, by = H * 0.8, bh = H * 0.05;
    g.globalAlpha = 0.3; g.fillStyle = col; g.fillRect(bx, by, bw, bh);
    g.globalAlpha = 0.9; g.fillStyle = f > 0.93 ? '#ff6a4a' : col; g.fillRect(bx, by, bw * clamp(f, 0, 1), bh);
    // nav arrow toward the next corner
    if (st.nextTurn) {
      var dir = st.nextTurn.dir, ax = W * 0.18, ay = H * 0.42, s = H * 0.16;
      g.globalAlpha = 0.85; g.fillStyle = col; g.strokeStyle = col; g.lineWidth = H * 0.035; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(ax, ay + s); g.lineTo(ax, ay); g.lineTo(ax + dir * s * 0.8, ay - s * 0.5); g.stroke();
      g.beginPath(); g.moveTo(ax + dir * s * 1.05, ay - s * 0.65); g.lineTo(ax + dir * s * 0.45, ay - s * 0.7); g.lineTo(ax + dir * s * 0.8, ay - s * 0.15); g.closePath(); g.fill();
      g.font = '600 ' + Math.round(H * 0.11) + 'px ' + FONT; g.fillText(Math.round(st.nextTurn.dist) + ' m', ax, ay + s + H * 0.14);
    }
    g.globalAlpha = 0.8; g.fillStyle = col; g.font = '600 ' + Math.round(H * 0.11) + 'px ' + FONT;
    g.fillText('P' + (st.position || '-') + (st.count ? '/' + st.count : ''), W * 0.8, H * 0.72);
    if (f > 0.96) { g.globalAlpha = (Math.floor(num(st.time, 0) * 10) & 1) ? 0.9 : 0.4; g.fillStyle = '#ff5a3a'; g.fillRect(bx, H * 0.06, bw, H * 0.04); }
    g.restore();
  }

  /** Race wheel display: LED row + gear + lap delta. */
  function drawWheelDisplay(g, W, H, st, theme) {
    st = st || {}; theme = theme || {};
    var red = Math.max(1000, num(st.redline, 7500)), f = clamp(num(st.needle, num(st.rpm, 0) / red), 0, 1.05);
    var lim = f > 0.985 && (Math.floor(num(st.time, 0) * 12) & 1) === 0;
    g.save();
    g.fillStyle = '#030405'; g.fillRect(0, 0, W, H);
    drawLeds(g, W * 0.03, H * 0.02, W * 0.94, H * 0.2, f, 12, lim);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = f > 0.93 ? '#ff4b3a' : '#ffffff'; g.font = '800 ' + Math.round(H * 0.56) + 'px ' + FONT;
    g.fillText(gearLabel(st), W / 2, H * 0.6);
    g.font = '600 ' + Math.round(H * 0.17) + 'px ' + MONO; g.fillStyle = theme.accent || '#c8a24a';
    g.textAlign = 'left'; g.fillText(String(Math.round(speedVal(st))), W * 0.05, H * 0.55);
    g.fillStyle = '#8a867e'; g.font = '600 ' + Math.round(H * 0.11) + 'px ' + FONT; g.fillText(st.units === 'mph' ? 'MPH' : 'KPH', W * 0.05, H * 0.75);
    g.textAlign = 'right'; g.fillStyle = '#c9c4ba'; g.font = '600 ' + Math.round(H * 0.15) + 'px ' + MONO;
    g.fillText('P' + (st.position || '-'), W * 0.95, H * 0.5);
    var d = num(st.delta, NaN);
    g.fillStyle = isFinite(d) ? (d <= 0 ? '#36e06a' : '#ff4b3a') : '#8a867e'; g.font = '600 ' + Math.round(H * 0.13) + 'px ' + MONO;
    g.fillText(isFinite(d) ? (d > 0 ? '+' : '') + d.toFixed(2) : fmtTime(st.lapTime).slice(0, 6), W * 0.95, H * 0.75);
    g.restore();
  }

  /** Trim swatch textures (procedural): carbon twill, forged carbon, burl walnut, open-pore ash, knurled alu, brushed titanium. */
  function drawTrim(g, S, kind, seed) {
    var rnd = (function (s) { return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })(seed || 1234);
    g.save();
    if (kind === 'carbon') {
      var n = 8, c = S / n;
      for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
        var horiz = ((i + j) >> 1) % 2 === 0 ? ((Math.floor((i + (j % 2)) / 1)) % 2 === 0) : false;
        horiz = (Math.floor((i + j) / 2) % 2) === 0;
        var gr = horiz ? g.createLinearGradient(i * c, j * c, i * c, j * c + c) : g.createLinearGradient(i * c, j * c, i * c + c, j * c);
        gr.addColorStop(0, '#0b0c0e'); gr.addColorStop(0.5, horiz ? '#3a3e45' : '#262a30'); gr.addColorStop(1, '#0b0c0e');
        g.fillStyle = gr; g.fillRect(i * c, j * c, c, c);
        g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 1; g.strokeRect(i * c + 0.5, j * c + 0.5, c - 1, c - 1);
      }
    } else if (kind === 'forged') {
      g.fillStyle = '#0e0f11'; g.fillRect(0, 0, S, S);
      for (var k = 0; k < 420; k++) {
        var x = rnd() * S, y = rnd() * S, w = 6 + rnd() * 28, h = 2 + rnd() * 6, a = rnd() * PI;
        var l = 20 + Math.floor(rnd() * 50);
        g.save(); g.translate(x, y); g.rotate(a); g.fillStyle = 'rgb(' + l + ',' + l + ',' + (l + 4) + ')';
        g.fillRect(-w / 2, -h / 2, w, h); g.restore();
      }
    } else if (kind === 'burl' || kind === 'ash') {
      var burl = kind === 'burl';
      g.fillStyle = burl ? '#5a2e14' : '#b59a78'; g.fillRect(0, 0, S, S);
      for (var r = 0; r < (burl ? 140 : 90); r++) {
        var y0 = rnd() * S, amp = burl ? 10 + rnd() * 20 : 2 + rnd() * 4, fr = (burl ? 2 + rnd() * 3 : 1) * TAU / S, ph = rnd() * TAU;
        g.strokeStyle = burl ? 'rgba(' + (30 + rnd() * 40 | 0) + ',' + (12 + rnd() * 18 | 0) + ',4,' + (0.25 + rnd() * 0.4) + ')' : 'rgba(80,60,40,' + (0.15 + rnd() * 0.35) + ')';
        g.lineWidth = 0.6 + rnd() * (burl ? 2.2 : 1.4);
        g.beginPath();
        for (var x2 = 0; x2 <= S; x2 += 4) { var yy = y0 + Math.sin(x2 * fr + ph) * amp + Math.sin(x2 * fr * 3.1 + ph) * amp * 0.3; if (x2) g.lineTo(x2, yy); else g.moveTo(x2, yy); }
        g.stroke();
      }
      if (burl) for (var e = 0; e < 26; e++) { g.fillStyle = 'rgba(25,10,3,' + (0.2 + rnd() * 0.4) + ')'; g.beginPath(); g.arc(rnd() * S, rnd() * S, 1 + rnd() * 4, 0, TAU); g.fill(); }
    } else if (kind === 'knurl') {
      g.fillStyle = '#9a9ea4'; g.fillRect(0, 0, S, S);
      var st2 = S / 16;
      for (var a2 = -S; a2 < S * 2; a2 += st2) {
        g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(a2, 0); g.lineTo(a2 + S, S); g.stroke();
        g.strokeStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.moveTo(a2 + S, 0); g.lineTo(a2, S); g.stroke();
      }
    } else {
      // brushed
      g.fillStyle = '#8f8b85'; g.fillRect(0, 0, S, S);
      for (var b = 0; b < S * 1.5; b++) {
        var yb = rnd() * S, l2 = 110 + Math.floor(rnd() * 70);
        g.strokeStyle = 'rgba(' + l2 + ',' + l2 + ',' + (l2 - 4) + ',0.35)'; g.lineWidth = 0.5 + rnd();
        g.beginPath(); g.moveTo(0, yb); g.lineTo(S, yb + (rnd() - 0.5) * 2); g.stroke();
      }
    }
    g.restore();
  }

  /** Upholstery detail maps (near-white, multiplied over the vertex colours so build.interior colours are kept):
      leather family = pebbled grain, nappa adds perforation, alcantara / vegan = fine suede nap, cloth / tartan =
      woven threads, carbon-weave = 2x2 twill. kind -> upholstery id. Tiles seamlessly (wrap-around draws). */
  function upholsteryKind(id) {
    if (id === 'alcantara' || id === 'vegan') return 'suede';
    if (id === 'cloth' || id === 'tartan') return 'cloth';
    if (id === 'carbon-weave') return 'twill';
    if (id === 'nappa') return 'nappa';
    return 'leather';
  }
  function drawUpholstery(g, S, kind, seed) {
    var rnd = (function (s) { return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })(seed || 4242);
    g.save();
    g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, S, S);
    function dotWrap(x, y, r, col) {
      g.fillStyle = col;
      for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) {
        var px = x + ox * S, py = y + oy * S;
        if (px < -r || py < -r || px > S + r || py > S + r) continue;
        g.beginPath(); g.arc(px, py, r, 0, TAU); g.fill();
      }
    }
    var i;
    if (kind === 'leather' || kind === 'nappa') {
      // pebbled grain: irregular light cells separated by darker creases
      for (i = 0; i < S * S / 10; i++) { var l = 228 + Math.floor(rnd() * 27); dotWrap(rnd() * S, rnd() * S, 0.8 + rnd() * 1.8, 'rgb(' + l + ',' + l + ',' + l + ')'); }
      g.strokeStyle = 'rgba(150,150,150,0.16)'; g.lineWidth = 0.7;
      for (i = 0; i < 70; i++) {
        var x0 = rnd() * S, y0 = rnd() * S, a = rnd() * TAU, L2 = 6 + rnd() * 18;
        g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(x0 + Math.cos(a + 0.6) * L2 * 0.5, y0 + Math.sin(a + 0.6) * L2 * 0.5, x0 + Math.cos(a) * L2, y0 + Math.sin(a) * L2); g.stroke();
      }
      if (kind === 'nappa') {
        var st = S / 16;
        for (var px2 = 0; px2 < 16; px2++) for (var py2 = 0; py2 < 16; py2++) dotWrap((px2 + (py2 % 2) * 0.5) * st, py2 * st, st * 0.14, 'rgba(70,70,70,0.55)');
      }
    } else if (kind === 'suede') {
      for (i = 0; i < S * S / 3; i++) { var l3 = 222 + Math.floor(rnd() * 33); g.fillStyle = 'rgb(' + l3 + ',' + l3 + ',' + l3 + ')'; g.fillRect(Math.floor(rnd() * S), Math.floor(rnd() * S), 1 + Math.floor(rnd() * 2), 1); }
      // soft directional nap patches
      for (i = 0; i < 12; i++) { var gr = g.createRadialGradient(rnd() * S, rnd() * S, 0, S / 2, S / 2, S * 0.6); gr.addColorStop(0, 'rgba(255,255,255,0.05)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, S, S); }
    } else if (kind === 'cloth') {
      var t = S / 64;
      for (i = 0; i < 64; i++) {
        g.fillStyle = i % 2 ? 'rgba(160,160,160,0.28)' : 'rgba(255,255,255,0.35)';
        g.fillRect(i * t, 0, t * 0.6, S);
        g.fillStyle = i % 2 ? 'rgba(170,170,170,0.22)' : 'rgba(255,255,255,0.25)';
        g.fillRect(0, i * t, S, t * 0.6);
      }
    } else {
      // carbon-weave: 2x2 twill, every tow a soft cylinder highlight
      var n = 8, c = S / n;
      for (var a2 = 0; a2 < n; a2++) for (var b2 = 0; b2 < n; b2++) {
        var horiz = (Math.floor((a2 + b2) / 2) % 2) === 0;
        var lg = horiz ? g.createLinearGradient(0, b2 * c, 0, b2 * c + c) : g.createLinearGradient(a2 * c, 0, a2 * c + c, 0);
        lg.addColorStop(0, '#9a9a9a'); lg.addColorStop(0.5, horiz ? '#ffffff' : '#e2e2e2'); lg.addColorStop(1, '#9a9a9a');
        g.fillStyle = lg; g.fillRect(a2 * c, b2 * c, c, c);
      }
    }
    g.restore();
  }

  /* ==================================================================
     GL assembly
     ================================================================== */
  var IDENT = M4.create();
  var HIDE_KINDS = ['body', 'roof', 'glass', 'window', 'windows', 'mirror', 'mirrors', 'mirror-l', 'mirror-r', 'mirror-glass', 'interior',
    'driver', 'helmet', 'wiper', 'wipers', 'hood', 'bonnet', 'cabin', 'pillar', 'dash', 'seat', 'decal', 'chrome', 'trim', 'carbon', 'bed',
    // the exterior body is hidden in cockpit view, so the player's own tyres / rims / calipers would float through the
    // dash and doors; the interior hood humps over the front wheels instead
    'tire-fl', 'tire-fr', 'tire-rl', 'tire-rr', 'wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr',
    'caliper-fl', 'caliper-fr', 'caliper-rl', 'caliper-rr', 'wheels',
    // car-mesh's emissive lamp parts + rear wing would otherwise float over the hood / behind the cabin once the body
    // around them is removed
    'light-head', 'light-brake', 'light-rev', 'wing'];
  /** Look-back (camera turned to the rear window): the cabin shell is the cockpit's own geometry, but everything
      behind it (boot / bed / deck, tail lamps, wing) comes from the car-mesh exterior again, so the bed
      and tail lights are attached to a body instead of floating. Parts that wrap the eye or sit ahead of it stay
      hidden. (The renderer re-reads cockpit.hideKinds every frame.) */
  var LOOKBACK_SHOW = ['body', 'trim', 'carbon', 'bed', 'light-brake', 'light-rev', 'wing'];
  function lookBackHideKinds(open) {
    var show = open ? LOOKBACK_SHOW : LOOKBACK_SHOW.concat(['chrome']);   // open cars: car-mesh chrome = its own roll hoops
    return HIDE_KINDS.filter(function (k) { return show.indexOf(k) < 0; });
  }

  function material(o) {
    var c = o.color || [1, 1, 1, 1];
    if (c.length === 3) c = [c[0], c[1], c[2], 1];
    var m = {
      baseColor: c, color: c, metallic: num(o.metallic, 0), roughness: num(o.roughness, 0.7), clearcoat: num(o.clearcoat, 0),
      emissive: o.emissive || [0, 0, 0], unlit: !!o.unlit, transparent: !!o.transparent, opacity: c[3], doubleSided: true,
      depthWrite: o.depthWrite != null ? o.depthWrite : !o.transparent, flake: 0, envIntensity: num(o.envIntensity, 1), uEnvIntensity: num(o.envIntensity, 1), uFlake: 0, uHueShift: 0, alphaTest: num(o.alphaTest, 0)
    };
    m.uBaseColor = m.baseColor; m.uMetallic = m.metallic; m.uRoughness = m.roughness; m.uClearcoat = m.clearcoat; m.uEmissive = m.emissive;
    setMap(m, o.map || null);
    return m;
  }
  function setMap(m, tex) { m.map = m.uMap = tex || null; m.useMap = m.uUseMap = tex ? 1 : 0; }

  function makeCanvas(w, h) {
    try {
      if (typeof document !== 'undefined' && document.createElement) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
      if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    } catch (e) { /* no canvas */ }
    return null;
  }
  function isPOT(n) { return (n & (n - 1)) === 0; }
  function texFromCanvas(gl, isGL2, canvas, repeat, aniso) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas); } finally { gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); }
    var mip = isGL2 || (isPOT(canvas.width) && isPOT(canvas.height));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    var wrap = repeat && mip ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (aniso && aniso.ext) { try { gl.texParameterf(gl.TEXTURE_2D, aniso.ext.TEXTURE_MAX_ANISOTROPY_EXT, aniso.max); } catch (e) { /* ignore */ } }
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { tex: t, mip: mip };
  }
  /** Dynamic canvas texture re-uploaded with texSubImage2D. */
  function dynTex(gl, isGL2, w, h, aniso) {
    var c = makeCanvas(w, h); if (!c) return null;
    var g = c.getContext('2d'); if (!g) return null;
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    var T = texFromCanvas(gl, isGL2, c, false, aniso);
    return {
      canvas: c, g: g, tex: T.tex, w: w, h: h, mip: T.mip, acc: 0, key: '',
      upload: function () {
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        try { gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, c); } finally { gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); }
        if (this.mip) gl.generateMipmap(gl.TEXTURE_2D);
        gl.bindTexture(gl.TEXTURE_2D, null);
      },
      destroy: function () { if (this.tex) gl.deleteTexture(this.tex); this.tex = null; }
    };
  }

  /* -------- self-contained mesh + shader (only when CB.gl.createMesh is unavailable) */
  var OWN_VS = [
    'attribute vec3 aPos; attribute vec3 aNormal; attribute vec2 aUv; attribute vec4 aColor;',
    'uniform mat4 uModel, uView, uProj;',
    'varying vec3 vW; varying vec3 vN; varying vec2 vUv; varying vec4 vC;',
    'void main(){ vec4 w = uModel * vec4(aPos,1.0); vW = w.xyz; vN = mat3(uModel) * aNormal; vUv = aUv; vC = aColor; gl_Position = uProj * uView * w; }'
  ].join('\n');
  var OWN_FS = [
    'precision mediump float;',
    'varying vec3 vW; varying vec3 vN; varying vec2 vUv; varying vec4 vC;',
    'uniform vec4 uBase; uniform sampler2D uMap; uniform float uUseMap, uUnlit, uRough, uMetal; uniform vec3 uEmis, uSun, uSunCol, uSky, uGround, uCam;',
    'void main(){',
    '  vec4 b = uBase * vC; if (uUseMap > 0.5) { vec4 t = texture2D(uMap, vUv); t.rgb = pow(t.rgb, vec3(2.2)); b *= t; }',
    '  vec3 col;',
    '  if (uUnlit > 0.5) col = b.rgb + uEmis; else {',
    '    vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N; vec3 V = normalize(uCam - vW); vec3 L = normalize(uSun);',
    '    float sh = pow(max(dot(N, normalize(L + V)), 0.0), mix(200.0, 4.0, uRough));',
    '    col = b.rgb * (1.0 - uMetal * 0.7) * (mix(uGround, uSky, N.y * 0.5 + 0.5) + uSunCol * max(dot(N, L), 0.0)) + uSunCol * sh * (1.0 - uRough) * 0.5 + uEmis;',
    '  }',
    '  col = col / (col + vec3(1.0)) * 1.25; gl_FragColor = vec4(pow(col, vec3(1.0/2.2)), b.a);',
    '}'
  ].join('\n');

  /* ---------------- Formula 1 onboard (docs/F1-SPEC.md) */
  function f1CockpitBuild(b) {
    var o = {};
    for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k];
    o.body = Object.assign({}, b.body || {}, { style: 'roadster', seats: 1 });
    o.interior = Object.assign({}, b.interior || {}, { steering: 'race-quick-release', harness: true });
    o.transmission = Object.assign({}, b.transmission || {}, { type: 'sequential' });
    o.tech = Object.assign({}, b.tech || {}, { screen_in: 0, hud: false });
    return o;
  }
  /** F1 driving position: the wheel close in front of the chest, nearly upright; mirror glasses on the sidepod pods */
  function f1Layout(L, dims) {
    var e = L.eye, ex = e[0], ey = e[1];
    L.wheel.c = [ex + 0.42, ey - 0.21, 0];
    L.wheel.R = 0.125; L.wheel.tilt = 0.24; L.wheel.ratio = 8;
    L.shoulders = [[ex - 0.06, ey - 0.3, -0.19], [ex - 0.06, ey - 0.3, 0.19]];
    var mp = dims && Array.isArray(dims.mirrors) && dims.mirrors.length ? dims.mirrors : [{ pos: [0.47, 0.8, 0.53], side: 1 }, { pos: [0.47, 0.8, -0.53], side: -1 }];
    L.sideMirrors = mp.map(function (m) {
      var p = [m.pos[0] - 0.052, m.pos[1] + 0.012, m.pos[2]];
      return { pos: p, normal: norm(add(norm(sub(e, p)), [-1.4, 0, 0])), width: 0.15, height: 0.055, side: m.side < 0 ? -1 : 1 };
    });
    // rear-view render target: a camera on the halo looking back over the car (both glasses sample its halves)
    L.mirror = { pos: [ex + 0.3, ey + 0.1, 0], normal: norm([-1, -0.2, 0]), up: [0, 1, 0], width: 0.2, height: 0.06, fovY: 24 };
    L.open = true; L.nearPlane = 0.03;
  }

  function build(ctx, buildObj, opts) {
    opts = opts || {};
    var gl = ctx && ctx.gl ? ctx.gl : ctx;
    if (!gl || typeof gl.createBuffer !== 'function') throw new Error('CB.gl.cockpit.build: no WebGL context');
    var isGL2 = !!(ctx && ctx.isWebGL2) || (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext);
    var aniso = null;
    try { var ae = (ctx && ctx.ext && ctx.ext.aniso) || gl.getExtension('EXT_texture_filter_anisotropic'); if (ae) aniso = { ext: ae, max: Math.min(8, gl.getParameter(ae.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1) }; } catch (e) { aniso = null; }
    var quality = opts.quality || 'high';
    var units = opts.units === 'mph' || opts.units === 'imperial' ? 'mph' : 'kph';
    var flipU = !!opts.mirrorFlipU;
    var self = {}, Lay, Pal, geo, meshes = [], items = [], tex = {}, mats = {}, ownProg = null;
    var redlineDefault = num(((buildObj || {}).engine || {}).redline_rpm, 7500);
    var theme = {};
    var minimap = null, turns = null;

    function core() { return CB.gl && typeof CB.gl.createMesh === 'function' ? CB.gl.createMesh : null; }
    function mkMesh(g, smooth) {
      if (!g || !g.count()) return null;
      if (LOWPOLY && !smooth) g = g.toFlat(0.05);
      var arr = g.toArrays(); arr.colorSize = 4;
      var cm = core(), m = null;
      if (cm) { m = cm(ctx, arr); if (m && !m.bounds) { var b = g.bounds(); m.bounds = b; } }
      else m = ownMesh(arr);
      if (m) meshes.push(m);
      return m;
    }
    function ownMesh(arr) {
      function buf(d) { var b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW); return b; }
      var m = { _own: true, buffers: { pos: buf(arr.positions), nrm: buf(arr.normals), uv: buf(arr.uvs), col: buf(arr.colors) } };
      m.ibo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, arr.indices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      m.count = arr.indices.length; m.indexType = arr.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      if (arr.indices instanceof Uint32Array && !isGL2) gl.getExtension('OES_element_index_uint');
      var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], P = arr.positions;
      for (var i = 0; i < P.length; i += 3) for (var k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i + k]); mx[k] = Math.max(mx[k], P[i + k]); }
      m.bounds = { min: mn, max: mx };
      m.destroy = function () { for (var k2 in m.buffers) gl.deleteBuffer(m.buffers[k2]); gl.deleteBuffer(m.ibo); m.count = 0; };
      return m;
    }

    /* ---------- textures (built once; survive rebuilds) */
    function trimTexture(kind, seed) {
      if (!kind) return null;
      var key = 'trim:' + kind;
      if (tex[key] !== undefined) return tex[key];
      var c = makeCanvas(256, 256), t = null;
      if (c && c.getContext) { var g = c.getContext('2d'); if (g) { drawTrim(g, 256, kind, seed); t = texFromCanvas(gl, isGL2, c, true, aniso).tex; } }
      tex[key] = t;
      return t;
    }
    function upholsteryTexture(kind) {
      var key = 'uph:' + kind;
      if (tex[key] !== undefined) return tex[key];
      var c = makeCanvas(256, 256), t = null;
      if (c && c.getContext) { var g = c.getContext('2d'); if (g) { drawUpholstery(g, 256, kind, 4242); t = texFromCanvas(gl, isGL2, c, true, aniso).tex; } }
      tex[key] = t;
      return t;
    }
    function ensureDyn() {
      var cl = Lay.cluster.px;
      if (!tex.cluster) tex.cluster = dynTex(gl, isGL2, cl[0], cl[1], aniso);
      if (Lay.screen && (!tex.screen || tex.screen.w !== Lay.screen.px[0] || tex.screen.h !== Lay.screen.px[1])) {
        if (tex.screen) tex.screen.destroy();
        tex.screen = dynTex(gl, isGL2, Lay.screen.px[0], Lay.screen.px[1], aniso);
      }
      if (Lay.hud && !tex.hud) tex.hud = dynTex(gl, isGL2, Lay.hud.px[0], Lay.hud.px[1], null);
      if (Lay.wheel.type === 'race-quick-release' && !tex.wheel) tex.wheel = dynTex(gl, isGL2, 256, 122, null);
      [tex.cluster, tex.screen, tex.hud, tex.wheel].forEach(function (t) { if (t) t.key = ''; });
    }

    /* ---------- materials */
    function makeMaterials() {
      var up = Pal.upholstery, tr = Pal.trim, pr = paintResponse(Pal.finish);
      // low-poly: flat material colours only (no weave / grain / wood maps); the old texture painters stay for the
      // non-low-poly path
      var carbonTex = LOWPOLY ? null : trimTexture(Pal.trimId === 'forged-carbon' ? 'forged' : 'carbon', 77);
      var trimTex = LOWPOLY ? null : trimTexture(tr.tex, 31);
      var uk = upholsteryKind(Pal.upholsteryId), uphTex = LOWPOLY ? null : upholsteryTexture(uk === 'nappa' ? 'leather' : uk), seatTex = LOWPOLY ? null : upholsteryTexture(uk);
      var trimFlat = LOWPOLY ? Pal.L(hexRgb(TRIM_FLAT[Pal.trimId] || tr.color)).concat(1) : Pal.trimColor.concat(1);
      var carbonFlat = LOWPOLY ? Pal.L(hexRgb(Pal.trimId === 'forged-carbon' ? '#2a2c30' : '#1d2024')).concat(1) : null;
      mats = {
        // the upholstery map averages ~0.92 (sRGB) -> base colour lifted slightly so build.interior colours read true
        soft: material({ color: uphTex ? [1.12, 1.12, 1.12, 1] : null, map: uphTex, roughness: up.rough, clearcoat: up.sheen }),
        seatD: material({ color: seatTex ? [1.12, 1.12, 1.12, 1] : null, map: seatTex, roughness: up.rough, clearcoat: up.sheen }),
        liner: material({ roughness: Pal.linerRough }),
        plastic: material({ roughness: 0.5, clearcoat: 0.05 }),
        matte: material({ roughness: 0.96 }),
        trim: material({ color: trimFlat, map: trimTex, metallic: tr.metallic, roughness: tr.rough, clearcoat: tr.clear }),
        carbon: material({ color: carbonFlat, map: carbonTex, metallic: 0.2, roughness: 0.3, clearcoat: 0.9 }),
        seatDc: material({ color: carbonFlat, map: carbonTex, metallic: 0.2, roughness: 0.3, clearcoat: 0.9 }),
        metal: material({ metallic: 1, roughness: 0.27 }),
        paint: material({ color: Pal.paint.concat(1), metallic: pr.metallic * 0.5, roughness: Math.max(pr.rough, 0.42), clearcoat: pr.clear * 0.25, envIntensity: 0.45 }),
        cage: material({ metallic: 0.3, roughness: 0.4, clearcoat: 0.2 }),
        harness: material({ roughness: 0.85 }), harnessD: material({ roughness: 0.85 }),
        glove: material({ roughness: 0.82 }), sleeve: material({ roughness: 0.8 }),
        glow: material({ color: [0, 0, 0, 1], unlit: true, emissive: [0, 0, 0] }),
        leds: material({ color: [1.2, 1.2, 1.2, 1], unlit: true }),
        stars: material({ color: [1.4, 1.4, 1.4, 1], unlit: true }),
        glass: material({ color: [0.62, 0.7, 0.72, 0.055], transparent: true, roughness: 0.04, clearcoat: 1 }),
        glassSide: material({ color: [0.05, 0.07, 0.08, clamp(0.05 + Pal.tint * 0.55, 0.05, 0.6)], transparent: true, roughness: 0.04, clearcoat: 1 }),
        glassRoof: material({ color: [0.02, 0.025, 0.035, 0.62], transparent: true, roughness: 0.04, clearcoat: 1 }),
        cluster: material({ color: [1.05, 1.05, 1.05, 1], unlit: true, map: tex.cluster && tex.cluster.tex }),
        screen: material({ color: [1.1, 1.1, 1.1, 1], unlit: true, map: tex.screen && tex.screen.tex }),
        hud: material({ color: [0.72, 0.72, 0.72, 0.8], unlit: true, transparent: true, depthWrite: false, map: tex.hud && tex.hud.tex }),
        wheelDisplay: material({ color: [1.1, 1.1, 1.1, 1], unlit: true, map: tex.wheel && tex.wheel.tex }),
        mirror: material({ color: [0.1, 0.12, 0.15, 1], unlit: true })
      };
      if (Pal.mirrorCarbon && mats.carbon) { /* housings use the carbon group */ }
      if (self.mirrorTexture) { setMap(mats.mirror, self.mirrorTexture); mats.mirror.baseColor[0] = mats.mirror.baseColor[1] = 0.86; mats.mirror.baseColor[2] = 0.88; }
      theme = { accent: rgbHex(hexRgb((buildObj && buildObj.interior && buildObj.interior.accentColor) || '#c8a24a')), ambient: rgbHex(Pal.ambient), hud: '#9dffd0' };
      if (luma(hexRgb(theme.accent)) < 0.12) theme.accent = '#c8a24a';
    }

    /* ---------- matrices animated per frame */
    var wheelM = M4.create(), handM = [M4.create(), M4.create()], armM = [M4.create(), M4.create(), M4.create(), M4.create()], leverM = M4.create();
    function wheelMatrix(o, rot) {
      var t = -Lay.wheel.tilt, ct = Math.cos(t), st = Math.sin(t), cr = Math.cos(rot), sr = Math.sin(rot), c = Lay.wheel.c;
      // T(c) * Rz(t) * Rx(rot)
      o[0] = ct; o[1] = st; o[2] = 0; o[3] = 0;
      o[4] = -st * cr; o[5] = ct * cr; o[6] = sr; o[7] = 0;
      o[8] = st * sr; o[9] = -ct * sr; o[10] = cr; o[11] = 0;
      o[12] = c[0]; o[13] = c[1]; o[14] = c[2]; o[15] = 1;
      return o;
    }
    function segMatrix(o, a, b, r) {
      var d = sub(b, a), L = len(d) || 1e-4, X = mul(d, 1 / L), Y = anyPerp(X), Z = cross(X, Y);
      o[0] = X[0] * L; o[1] = X[1] * L; o[2] = X[2] * L; o[3] = 0;
      o[4] = Y[0] * r; o[5] = Y[1] * r; o[6] = Y[2] * r; o[7] = 0;
      o[8] = Z[0] * r; o[9] = Z[1] * r; o[10] = Z[2] * r; o[11] = 0;
      o[12] = a[0]; o[13] = a[1]; o[14] = a[2]; o[15] = 1;
      return o;
    }

    function addItem(name, mesh, mat, local, kind, extra) {
      if (!mesh || !mat) return null;
      var it = { mesh: mesh, material: mat, local: local || IDENT, model: M4.create(), kind: kind || ('cockpit-' + name), name: name,
        transparent: !!mat.transparent, doubleSided: true, castShadow: false, noCull: true, depthWrite: mat.depthWrite, visible: true, order: 50 };
      if (extra) for (var k in extra) it[k] = extra[k];
      items.push(it);
      return it;
    }

    function assemble() {
      meshes.forEach(function (m) { if (m && m.destroy) m.destroy(); });
      meshes = []; items = []; glowK = -1;
      // F1 car (docs/F1-SPEC.md): the onboard view keeps the car's own bodywork (nose, halo, sidepod mirrors) and adds
      // only a race steering wheel with its display, gloves / arms and the two mirror glasses on the sidepod pods
      var F1 = !!(CB.gl.f1car && typeof CB.gl.f1car.isF1 === 'function' && CB.gl.f1car.isF1(buildObj));
      var cbObj = F1 ? f1CockpitBuild(buildObj) : buildObj;
      Lay = layout(cbObj, { eye: opts.eye, dims: opts.dims });
      if (F1) f1Layout(Lay, opts.dims);
      hideBack = null; lookBackState = false; if (hideFwd) self.hideKinds = hideFwd;
      Pal = palette(buildObj, { gammaVertexColors: opts.gammaVertexColors, color: opts.color });
      ensureDyn();
      makeMaterials();
      geo = buildGeometry(cbObj, Lay, Pal);
      if (F1) { assembleF1(); return; }
      var G = geo.groups, kindOf = { seatD: 'seat-driver-cockpit', seatDc: 'seat-driver-cockpit', harnessD: 'seat-driver-cockpit' };
      ['soft', 'liner', 'plastic', 'matte', 'trim', 'carbon', 'metal', 'paint', 'cage', 'harness', 'seatD', 'seatDc', 'harnessD', 'glow', 'leds', 'stars'].forEach(function (k) {
        if (G[k]) addItem(k, mkMesh(G[k]), mats[k], IDENT, kindOf[k], k === 'seatD' || k === 'seatDc' || k === 'harnessD' ? { driverSeat: true } : null);
      });
      var W = geo.wheel;
      if (W.rim) addItem('wheel-rim', mkMesh(W.rim), mats.soft, wheelM, 'cockpit-steering');
      if (W.hard) addItem('wheel-hard', mkMesh(W.hard), mats.plastic, wheelM, 'cockpit-steering');
      if (W.trim) addItem('wheel-trim', mkMesh(W.trim), mats.trim, wheelM, 'cockpit-steering');
      if (W.carbon) addItem('wheel-carbon', mkMesh(W.carbon), mats.carbon, wheelM, 'cockpit-steering');
      if (W.metal) addItem('wheel-metal', mkMesh(W.metal), mats.metal, wheelM, 'cockpit-steering');
      if (W.leds) addItem('wheel-leds', mkMesh(W.leds), mats.leds, wheelM, 'cockpit-steering');
      var Pn = geo.panels;
      if (Pn.wheelDisplay && tex.wheel) addItem('wheel-display', mkMesh(Pn.wheelDisplay, true), mats.wheelDisplay, wheelM, 'cockpit-steering');
      geo.hands.forEach(function (h, i) { addItem('hand-' + i, mkMesh(h), mats.glove, handM[i], 'cockpit-hands'); });
      var up = mkMesh(geo.arms.upper), fo = mkMesh(geo.arms.fore);
      for (var a = 0; a < 2; a++) { addItem('arm-upper-' + a, up, mats.sleeve, armM[a * 2], 'cockpit-arms'); addItem('arm-fore-' + a, fo, mats.sleeve, armM[a * 2 + 1], 'cockpit-arms'); }
      if (geo.lever && geo.lever.count()) addItem('lever', mkMesh(geo.lever), mats.metal, leverM, 'cockpit-lever');
      if (Pn.cluster) addItem('cluster', mkMesh(Pn.cluster, true), mats.cluster, IDENT, 'cockpit-gauges');
      if (Pn.screen) addItem('screen', mkMesh(Pn.screen, true), mats.screen, IDENT, 'cockpit-screen');
      self._mirrorItem = addItem('mirror', mkMesh(mirrorGeo(), true), mats.mirror, IDENT, 'cockpit-mirror');
      if (G.glass) addItem('glass', mkMesh(G.glass, true), mats.glass, IDENT, 'cockpit-glass', { order: 60 });
      if (G.glassSide) addItem('glass-side', mkMesh(G.glassSide, true), mats.glassSide, IDENT, 'cockpit-glass', { order: 60 });
      if (G.glassRoof) addItem('glass-roof', mkMesh(G.glassRoof, true), mats.glassRoof, IDENT, 'cockpit-glass', { order: 60 });
      if (Pn.hud && tex.hud) addItem('hud', mkMesh(Pn.hud, true), mats.hud, IDENT, 'cockpit-hud', { order: 70 });
      // public pose data
      self.eye = Lay.eye.slice(); self.cockpitEye = self.eye;
      self.mirror = { pos: Lay.mirror.pos.slice(), normal: Lay.mirror.normal.slice(), up: Lay.mirror.frame ? Lay.mirror.frame.up.slice() : [0, 1, 0], width: Lay.mirror.width, height: Lay.mirror.height, fovY: Lay.mirror.fovY };
      self.sideMirrors = Lay.sideMirrors.map(function (s) { return { pos: s.pos.slice(), normal: s.normal.slice(), width: s.width, height: s.height, side: s.side }; });
      self.nearPlane = Lay.nearPlane; self.layout = Lay;
      self.items = items; self.parts = items;
      self.stats = { items: items.length, triangles: meshesTris() };
      wheelMatrix(wheelM, steer.rot); poseHands(); poseArms(); poseLever(0);
    }
    /** F1 onboard: wheel + display + hands + arms + sidepod mirror glasses only (the car body stays visible) */
    function assembleF1() {
      var W = geo.wheel;
      if (W.rim) addItem('wheel-rim', mkMesh(W.rim), mats.carbon || mats.soft, wheelM, 'cockpit-steering');
      if (W.hard) addItem('wheel-hard', mkMesh(W.hard), mats.plastic, wheelM, 'cockpit-steering');
      if (W.trim) addItem('wheel-trim', mkMesh(W.trim), mats.trim, wheelM, 'cockpit-steering');
      if (W.carbon) addItem('wheel-carbon', mkMesh(W.carbon), mats.carbon, wheelM, 'cockpit-steering');
      if (W.metal) addItem('wheel-metal', mkMesh(W.metal), mats.metal, wheelM, 'cockpit-steering');
      if (W.leds) addItem('wheel-leds', mkMesh(W.leds), mats.leds, wheelM, 'cockpit-steering');
      if (geo.panels.wheelDisplay && tex.wheel) addItem('wheel-display', mkMesh(geo.panels.wheelDisplay, true), mats.wheelDisplay, wheelM, 'cockpit-steering');
      geo.hands.forEach(function (h, i) { addItem('hand-' + i, mkMesh(h), mats.glove, handM[i], 'cockpit-hands'); });
      var up = mkMesh(geo.arms.upper), fo = mkMesh(geo.arms.fore);
      for (var a = 0; a < 2; a++) { addItem('arm-upper-' + a, up, mats.sleeve, armM[a * 2], 'cockpit-arms'); addItem('arm-fore-' + a, fo, mats.sleeve, armM[a * 2 + 1], 'cockpit-arms'); }
      var mg = new Geo();
      Lay.sideMirrors.forEach(function (sm) {
        var F = faceFrame(sm.pos, add(sm.pos, sm.normal));
        panel(mg, sm.pos, F, sm.width, sm.height, sm.side < 0 ? [0.0, 0.08, 0.58, 0.92] : [0.42, 0.08, 1.0, 0.92]);
      });
      geo.panels.mirror = mg;
      self._mirrorItem = addItem('mirror', mkMesh(mirrorGeo(), true), mats.mirror, IDENT, 'cockpit-mirror');
      self.eye = Lay.eye.slice(); self.cockpitEye = self.eye;
      self.mirror = { pos: Lay.mirror.pos.slice(), normal: Lay.mirror.normal.slice(), up: [0, 1, 0], width: Lay.mirror.width, height: Lay.mirror.height, fovY: Lay.mirror.fovY };
      self.sideMirrors = Lay.sideMirrors.map(function (s) { return { pos: s.pos.slice(), normal: s.normal.slice(), width: s.width, height: s.height, side: s.side }; });
      self.nearPlane = Lay.nearPlane; self.layout = Lay; self.f1 = true;
      hideFwd = hideBack = ['driver', 'helmet'];
      self.hideKinds = hideFwd;
      self.items = items; self.parts = items;
      var t = 0; for (var w in geo.wheel) t += geo.wheel[w].tris();
      self.stats = { items: items.length, triangles: Math.round(t) };
      wheelMatrix(wheelM, steer.rot); poseHands(); poseArms(); poseLever(0);
    }
    function meshesTris() { var t = 0; for (var k in geo.groups) t += geo.groups[k].tris(); for (var w in geo.wheel) t += geo.wheel[w].tris(); return Math.round(t); }
    function mirrorGeo() {
      var g = geo.panels.mirror;
      if (!flipU) return g;
      var c = new Geo(); c.append(g);
      for (var i = 0; i < c.T.length; i += 2) c.T[i] = 1 - c.T[i];
      return c;
    }

    /* ---------- animation state */
    var steer = { rot: 0 }, head = headModel({}), lever = { a: 0, va: 0, b: 0, vb: 0, gear: null, kick: 0 };
    var hist = { t: null, speed: 0, heading: 0, latG: 0, longG: 0 };
    var gauge = { needle: 0, time: 0, lapTime: 0 };
    var glowK = -1;
    self.camera = { eye: [0, 0, 0], forward: [1, 0, 0], up: [0, 1, 0], yaw: 0, pitch: 0, roll: 0, fov: undefined };
    var hideFwd = HIDE_KINDS.slice(), hideBack = null, lookBackState = false;
    self.hideKinds = hideFwd;

    function poseHands() {
      // hands follow the rim up to ~70 deg, then the (round-ish) rim slides under the gloves so the forearms never cross
      // the view centre at parking-speed full lock; yoke grips are fixed to the horns (its rotation is capped ~165 deg)
      var lim = Lay.wheel.type === 'yoke' ? 3 : 1.22;
      for (var i = 0; i < 2; i++) wheelMatrix(handM[i], clamp(steer.rot, -lim, lim));
    }
    function poseArms() {
      for (var i = 0; i < 2; i++) {
        var s = Lay.shoulders[i], w = M4.point(handM[i], geo.wrists[i]), side = i === 0 ? -1 : 1;
        var d = sub(w, s), L = len(d), a = 0.31, b = 0.3, dir = mul(d, 1 / (L || 1));
        var Lc = clamp(L, 0.05, a + b - 0.002);
        var ca = clamp((a * a + Lc * Lc - b * b) / (2 * a * Lc), -1, 1), sa = Math.sqrt(1 - ca * ca);
        var pole = norm([-0.15, -1, side * 0.75]), pp = norm(sub(pole, mul(dir, dot(pole, dir))));
        var elbow = add(s, add(mul(dir, a * ca), mul(pp, a * sa)));
        segMatrix(armM[i * 2], s, elbow, 0.05);
        segMatrix(armM[i * 2 + 1], elbow, w, 0.04);
      }
    }
    function poseLever(dt) {
      var tgtA = 0, tgtB = 0, g = Math.round(num(lever.gear, 1));
      if (Lay.manual) {
        if (g >= 1) { var col = Math.floor((g - 1) / 2), row = (g - 1) % 2; tgtB = (col - 1) * 0.17; tgtA = row === 0 ? -0.26 : 0.26; }
        else if (g < 0) { tgtB = 0.3; tgtA = 0.26; }
      }
      if (dt > 0) {
        var k = 120, c = 2 * Math.sqrt(k) * 0.55, n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
        for (var i = 0; i < n; i++) {
          lever.va += (k * (tgtA + lever.kick - lever.a) - c * lever.va) * h; lever.a += lever.va * h;
          lever.vb += (k * (tgtB - lever.b) - c * lever.vb) * h; lever.b += lever.vb * h;
          lever.kick *= Math.exp(-h * 14);
        }
      }
      // T(pivot) * Rz(a) * Rx(b)
      var p = geo.leverPivot, ca = Math.cos(lever.a), sa = Math.sin(lever.a), cb = Math.cos(lever.b), sb = Math.sin(lever.b), o = leverM;
      o[0] = ca; o[1] = sa; o[2] = 0; o[3] = 0;
      o[4] = -sa * cb; o[5] = ca * cb; o[6] = sb; o[7] = 0;
      o[8] = sa * sb; o[9] = -ca * sb; o[10] = cb; o[11] = 0;
      o[12] = p[0]; o[13] = p[1]; o[14] = p[2]; o[15] = 1;
    }

    /* ---------- track helpers: minimap + next turn */
    function setTrack(g) {
      minimap = minimapFrom(g);
      turns = null;
      var S = g && g.samples;
      if (S && S.length > 4) {
        var L = num(g.length, num(S[S.length - 1].s, S.length * 2));
        turns = { S: S, L: L, ds: L / S.length };
      }
    }
    function nextTurn(s) {
      if (!turns || !isFinite(s) || !(turns.ds > 0.05) || !(turns.L > 0)) return null;
      var S = turns.S, n = S.length, i0 = Math.floor((((s % turns.L) + turns.L) % turns.L) / turns.ds);
      for (var d = 15; d < 260; d += turns.ds) {
        var k = S[(i0 + Math.round(d / turns.ds)) % n], c = num(k && k.curvature, 0);
        if (Math.abs(c) > 1 / 140) return { dir: c > 0 ? -1 : 1, dist: d };
      }
      return null;
    }

    /* ---------- per-frame */
    function gaugeState(v, snap) {
      var cars = snap && snap.cars;
      return {
        speed: num(v.speed, 0), rpm: num(v.rpm, 0), redline: num(v.redline, redlineDefault), gear: v.gear, maxGear: v.maxGear, reverse: v.reverse, units: units,
        needle: gauge.needle, throttle: num(v.throttle, 0), brake: num(v.brake, 0), lap: num(v.lap, 0), lapsTotal: snap ? snap.lapsTotal : 0,
        position: v.position, count: cars ? cars.length : 0, lapTime: num(v.currentLap_s, 0), lastLap: v.lastLap_s, bestLap: v.bestLap_s,
        gapAhead: num(v.gapAhead_s, NaN), latG: hist.latG, longG: hist.longG, digital: Lay.digital, phase: snap ? snap.phase : 'racing',
        time: gauge.time, weather: snap && snap.weather, tyres: [0.45 + num(v.skidding, 0) * 0.45, 0.45 + num(v.wheelspin, 0) * 0.5],
        nextTurn: nextTurn(num(v.s, NaN))
      };
    }
    function refresh(t, dt, rate, keyFn, drawFn) {
      if (!t) return;
      t.acc += dt;
      if (t.acc < 1 / rate) return;
      t.acc = t.acc % (1 / rate);
      var key = keyFn();
      if (key === t.key) return;
      t.key = key;
      drawFn(t.g, t.w, t.h);
      t.upload();
    }
    self.update = function (v, dt, time, snap) {
      v = v || {}; dt = clamp(num(dt, 1 / 60), 0, 0.1);
      gauge.time = num(time, gauge.time + dt);
      // g-forces (renderer supplies latG/longG; derive from the snapshot otherwise)
      var t = num(snap && snap.t, gauge.time);
      if (hist.t !== null && t > hist.t && t - hist.t < 0.5) {
        var ds = t - hist.t, dv = num(v.speed, 0) - hist.speed;
        var dh = wrapPi(num(v.heading, 0) - hist.heading);
        var rl = clamp(dv / ds / 9.81, -3, 3), rlat = clamp(num(v.speed, 0) * dh / ds / 9.81, -3.5, 3.5);
        var kk = 1 - Math.exp(-ds * 8);
        hist.longG += (rl - hist.longG) * kk; hist.latG += (rlat - hist.latG) * kk;
      }
      if (hist.t === null || t !== hist.t) { hist.t = t; hist.speed = num(v.speed, 0); hist.heading = num(v.heading, 0); }
      if (isFinite(v.latG)) hist.latG = +v.latG;
      if (isFinite(v.longG)) hist.longG = +v.longG;
      // head
      var h = head.update({ latG: hist.latG, longG: hist.longG, speed: v.speed, steerAngle: v.steerAngle, surface: v.surface }, dt, gauge.time);
      var cam = self.camera, e = Lay.eye;
      cam.eye[0] = e[0] + h.offset[0]; cam.eye[1] = e[1] + h.offset[1]; cam.eye[2] = e[2] + h.offset[2];
      var vb = viewBasis(h.yaw, h.pitch, h.roll);
      cam.forward = vb.forward; cam.up = vb.up; cam.yaw = h.yaw; cam.pitch = h.pitch; cam.roll = h.roll;
      // steering + hands + arms
      var target = steerWheelAngle(v.steerAngle, Lay.wheel.type, Lay.wheel.ratio);
      steer.rot += (target - steer.rot) * clamp(dt * 26, 0, 1);
      wheelMatrix(wheelM, steer.rot); poseHands(); poseArms();
      // lever
      var g = v.gear == null ? null : Math.round(num(v.gear, 1));
      if (lever.gear !== null && g !== null && g !== lever.gear && (Lay.sequential || !Lay.manual)) lever.kick += (g > lever.gear ? 0.22 : -0.22) * (Lay.sequential ? 1 : 0.25);
      lever.gear = g; poseLever(dt);
      // look-back hides the driver's seat (camera sits in the headrest)
      var lb = !!v.lookBack;
      for (var i = 0; i < items.length; i++) {
        if (items[i].driverSeat) items[i].visible = !lb;
        else if (items[i].frontOnly) items[i].visible = !lb;
      }
      if (lb !== lookBackState) { lookBackState = lb; self.hideKinds = lb ? (hideBack || (hideBack = lookBackHideKinds(!!(Lay && Lay.open)))) : hideFwd; }
      // ambient glow by time of day
      var tod = snap && snap.timeOfDay, k = Pal.ambientOn ? (tod === 'night' ? 2.4 : tod === 'dusk' ? 1.3 : 0.55) : 0;
      if (k !== glowK && mats.glow) {
        glowK = k;
        var a = Pal.L(Pal.ambient);
        mats.glow.emissive[0] = a[0] * k; mats.glow.emissive[1] = a[1] * k; mats.glow.emissive[2] = a[2] * k;
        mats.glow.baseColor[0] = a[0] * 0.3; mats.glow.baseColor[1] = a[1] * 0.3; mats.glow.baseColor[2] = a[2] * 0.3;
      }
      // gauges
      var red = Math.max(1000, num(v.redline, redlineDefault)), rf = clamp(num(v.rpm, 0) / red, 0, 1.08);
      gauge.needle += (rf - gauge.needle) * clamp(dt * 16, 0, 1);
      var hz = quality === 'low' ? 20 : 30, gs = null;
      function GS() { return gs || (gs = gaugeState(v, snap)); }
      refresh(tex.cluster, dt, hz, function () { var q = GS(); return Math.round(q.needle * 400) + '|' + Math.round(speedVal(q)) + '|' + gearLabel(q) + '|' + Math.round(q.lapTime * 20) + '|' + q.position + '|' + Math.round(q.throttle * 20) + Math.round(q.brake * 20) + '|' + Math.round(q.latG * 20) + Math.round(q.longG * 20) + (q.needle > 0.985 ? Math.floor(q.time * 12) : ''); },
        function (g2, W2, H2) { drawCluster(g2, W2, H2, GS(), theme); });
      refresh(tex.screen, dt, quality === 'low' ? 6 : 12, function () { return String(Math.floor(gauge.time * 12)); },
        function (g2, W2, H2) { drawCenterScreen(g2, W2, H2, GS(), theme, minimap, snap && snap.cars); });
      refresh(tex.hud, dt, hz, function () { var q = GS(); return Math.round(speedVal(q)) + '|' + gearLabel(q) + '|' + Math.round(q.needle * 100) + '|' + (q.nextTurn ? q.nextTurn.dir + ':' + Math.round(q.nextTurn.dist / 5) : '') + '|' + q.position + (q.needle > 0.96 ? Math.floor(q.time * 10) : ''); },
        function (g2, W2, H2) { drawHud(g2, W2, H2, GS(), theme); });
      refresh(tex.wheel, dt, hz, function () { var q = GS(); return Math.round(q.needle * 200) + '|' + gearLabel(q) + '|' + Math.round(speedVal(q)) + '|' + Math.round(q.lapTime * 10) + (q.needle > 0.985 ? Math.floor(q.time * 12) : ''); },
        function (g2, W2, H2) { drawWheelDisplay(g2, W2, H2, GS(), theme); });
    };
    self.impulse = function (k) { head.impulse(k); };
    self.setMirrorTexture = function (t, o) {
      self.mirrorTexture = t || null;
      var wantFlip = !!(o && o.flipU);
      if (wantFlip !== flipU && self._mirrorItem) {
        flipU = wantFlip;
        var old = self._mirrorItem.mesh, nm = mkMesh(mirrorGeo());
        if (nm) { self._mirrorItem.mesh = nm; if (old && old.destroy) { old.destroy(); meshes.splice(meshes.indexOf(old), 1); } }
      }
      if (!mats.mirror) return;
      setMap(mats.mirror, t || null);
      var bc = mats.mirror.baseColor;
      if (t) { bc[0] = 0.86; bc[1] = 0.86; bc[2] = 0.88; } else { bc[0] = 0.1; bc[1] = 0.12; bc[2] = 0.15; }
    };
    self.setTrack = setTrack;
    self.setUnits = function (u) { units = u === 'mph' || u === 'imperial' ? 'mph' : 'kph'; [tex.cluster, tex.screen, tex.hud, tex.wheel].forEach(function (t) { if (t) t.key = ''; }); };
    self.setQuality = function (q) { quality = q || quality; };
    self.attach = function (model) {
      if (!model) return;
      var ne = model.cockpitEye, nd = model.dims;
      var moved = ne && ne.length >= 3 && (!opts.eye || Math.abs(ne[0] - opts.eye[0]) + Math.abs(ne[1] - opts.eye[1]) + Math.abs(ne[2] - opts.eye[2]) > 0.005);
      var dimsChanged = nd && (!opts.dims || ['length', 'width', 'height'].some(function (k) { return Math.abs(num(nd[k], 0) - num(opts.dims[k], 0)) > 0.01; }));
      if (!moved && !dimsChanged) return;
      if (ne && ne.length >= 3) opts.eye = [ne[0], ne[1], ne[2]];
      if (nd) opts.dims = nd;
      assemble();
    };
    self.getItems = function () { return items.filter(function (it) { return it.visible !== false; }); };
    self.drawItems = function (carWorld, out) {
      out = out || []; out.length = 0;
      var W = carWorld || IDENT;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.visible === false) continue;
        M4.mul(it.model, W, it.local);
        out.push(it);
      }
      return out;
    };
    self.getCameraLocal = function (out) {
      out = out || {}; var c = self.camera;
      out.eye = c.eye.slice(); out.forward = c.forward.slice(); out.up = c.up.slice(); out.yaw = c.yaw; out.pitch = c.pitch; out.roll = c.roll;
      return out;
    };
    self.getViewMatrix = function (carWorld, out) {
      out = out || M4.create(); var c = self.camera, W = carWorld || IDENT;
      var e = M4.point(W, c.eye), f = M4.dir(W, c.forward), u = M4.dir(W, c.up);
      return M4.lookAt(out, e, add(e, f), u);
    };
    /** Fallback renderer: draws every item with a small built-in shader (when no drawList is available). */
    self.draw = function (view, proj, carWorld, env) {
      env = env || {};
      if (!ownProg) ownProg = compileOwn();
      if (!ownProg) return;
      var P = ownProg, u = P.u, list = self.drawItems(carWorld);
      gl.useProgram(P.p);
      gl.uniformMatrix4fv(u.uView, false, view); gl.uniformMatrix4fv(u.uProj, false, proj);
      var inv = M4.invert(M4.create(), view);
      gl.uniform3f(u.uCam, inv[12], inv[13], inv[14]);
      gl.uniform3fv(u.uSun, env.sunDir || [0.4, 0.8, 0.3]); gl.uniform3fv(u.uSunCol, env.sunColor || [1, 0.97, 0.9]);
      gl.uniform3fv(u.uSky, env.ambientSky || [0.35, 0.4, 0.5]); gl.uniform3fv(u.uGround, env.ambientGround || [0.15, 0.14, 0.12]);
      gl.uniform1i(u.uMap, 0);
      gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
      for (var pass = 0; pass < 2; pass++) {
        if (pass === 1) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); }
        for (var i = 0; i < list.length; i++) {
          var it = list[i], m = it.mesh, mt = it.material;
          if (!!mt.transparent !== (pass === 1) || !m || !m._own) continue;
          gl.uniformMatrix4fv(u.uModel, false, it.model);
          var bc = mt.baseColor; gl.uniform4f(u.uBase, bc[0], bc[1], bc[2], bc[3]);
          gl.uniform1f(u.uUnlit, mt.unlit ? 1 : 0); gl.uniform1f(u.uRough, mt.roughness); gl.uniform1f(u.uMetal, mt.metallic);
          gl.uniform3fv(u.uEmis, mt.emissive);
          gl.uniform1f(u.uUseMap, mt.map ? 1 : 0);
          if (mt.map) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, mt.map); }
          var B = m.buffers;
          [[B.pos, 3, 0], [B.nrm, 3, 1], [B.uv, 2, 2], [B.col, 4, 3]].forEach(function (a) { gl.bindBuffer(gl.ARRAY_BUFFER, a[0]); gl.enableVertexAttribArray(a[2]); gl.vertexAttribPointer(a[2], a[1], gl.FLOAT, false, 0, 0); });
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
          gl.drawElements(gl.TRIANGLES, m.count, m.indexType, 0);
        }
      }
      gl.disable(gl.BLEND); gl.depthMask(true);
      for (var a2 = 0; a2 < 4; a2++) gl.disableVertexAttribArray(a2);
      gl.bindBuffer(gl.ARRAY_BUFFER, null); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null); gl.bindTexture(gl.TEXTURE_2D, null);
    };
    function compileOwn() {
      try {
        function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
        var p = gl.createProgram();
        gl.attachShader(p, sh(gl.VERTEX_SHADER, OWN_VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, OWN_FS));
        ['aPos', 'aNormal', 'aUv', 'aColor'].forEach(function (n, i) { gl.bindAttribLocation(p, i, n); });
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        var u = {};
        ['uModel', 'uView', 'uProj', 'uBase', 'uMap', 'uUseMap', 'uUnlit', 'uRough', 'uMetal', 'uEmis', 'uSun', 'uSunCol', 'uSky', 'uGround', 'uCam'].forEach(function (n) { u[n] = gl.getUniformLocation(p, n); });
        return { p: p, u: u };
      } catch (e) { if (typeof console !== 'undefined') console.warn('[cockpit] shader', e); return null; }
    }
    self.destroy = function () {
      meshes.forEach(function (m) { if (m && m.destroy) m.destroy(); });
      meshes = []; items = []; self.items = self.parts = items;
      Object.keys(tex).forEach(function (k) { var t = tex[k]; if (!t) return; if (t.destroy) t.destroy(); else gl.deleteTexture(t); });
      tex = {};
      if (ownProg) { gl.deleteProgram(ownProg.p); ownProg = null; }
    };

    setTrack(opts.geom);
    assemble();
    return self;
  }

  CB.gl.cockpit = {
    build: build,
    layout: layout, palette: palette, buildGeometry: buildGeometry, Geo: Geo, M4: M4,
    headModel: headModel, viewBasis: viewBasis, steerWheelAngle: steerWheelAngle, rimPath: rimPath,
    drawCluster: drawCluster, drawCenterScreen: drawCenterScreen, drawHud: drawHud, drawLeds: drawLeds, drawWheelDisplay: drawWheelDisplay, drawTrim: drawTrim,
    minimapFrom: minimapFrom, fmtTime: fmtTime, gearLabel: gearLabel, upholsteryKind: upholsteryKind, drawUpholstery: drawUpholstery, HIDE_KINDS: HIDE_KINDS, lookBackHideKinds: lookBackHideKinds,
    wrapPi: wrapPi, f1CockpitBuild: f1CockpitBuild, f1Layout: f1Layout
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.gl.cockpit;
})();

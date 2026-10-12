/* ==========================================================================
   FORGE Atelier — js/race/gl/car-mesh.js
   CB.gl.car : procedural 3D car models generated from a docs/SPEC.md Build object (the hero asset).

   Contract (docs/RACE3D-SPEC.md)
     CB.gl.car.build(ctx, build, {number, color, accent, lod:'high'|'low', length_m?, width_m?, isPlayer?})
       -> carModel { parts: [{mesh, material, local: mat4, kind, castShadow, transparent}],
                     dims: {length, width, height, wheelbase, track, wheelRadius, rideHeight, ...},
                     cockpitEye, hoodCam, bumperCam (vec3, car-local), anchors, lod, key, stats, destroy() }
     CB.gl.car.pose(carModel, carSnap, dt, prevState) -> draw items [{mesh, material, model (world mat4), kind, ...}]
     CB.gl.car.cache   { get(ctx,key), clear(ctx), size(ctx), key(build, opts) }   (models shared by build hash)
   Car-local axes: +X forward, +Y up (ground at y = 0), +Z right. Origin = centre of the overall length, on the
   centre line, on the ground. World matrix = T(x, 0, -y) * Ry(heading) (same as renderer3d's carMatrix).

   How the car is made
   -------------------
   * Every body is a LOFT: an analytic cross-section ring(x) (bottom centre -> well notch -> sill -> curved flank with a
     character crease -> rounded shoulder -> crowned hood/deck -> optional tub (roadster cockpit / pickup bed)) swept
     along x samples that are dense around the caps and the wheel arches (the arch is a notch in the ring that
     follows the arch circle, so arches are real openings with dark wheel wells). The plan view is a super-ellipse
     at nose and tail (per noseStyle / tailStyle), with waist and flares over the tyres.
   * The greenhouse is a second loft on top (windscreen / roof / rear glass zones, tumblehome, crowned roof); every
     quad is classified into glass, pillars (thin/thick/floating), roof material (body/black/carbon/glass/contrast),
     frames and trims.
   * Proportions come from data.js bodyStyles[].svg hints, remapped piecewise onto the build's wheelbase, track,
     ride height and wheel/tyre size (overall length/width identical to the race engine's collision box).
   * Details are projected onto the analytic surface (ray casts against the ring): lights per lights type,
     grilles/intakes, badges, door shut lines, handles, mirrors, number roundels (textures.carNumber), stripes
     (8 types), splitter/diffuser/skirts/canards/wings (7 types, angle), exhaust tips (per exhaust), roof rails,
     wipers, bed, roll hoops, interior + driver, roll cage.
   * Wheels: tyre lathe with sidewall bulge, tread grooves by compound and sidewall lettering texture; rims per
     wheelDesigns style (y / split / mesh / turbine / monoblock / dish / centerlock / aero-disc) with spoke count,
     concavity, polished lips, hub, lug nuts or centre-lock nut; brake discs (material) and calipers (piston count,
     caliperColor). Mirrored for the left side.
   * Real manufacturer models: when js/shapes/ (CB.shapes) is loaded, the body is the fitted production-car loft of
     build.body.model (or the style default; AI opponents without a model get a deterministic per-opponent model of
     their style) with its greenhouse glass, black cladding / grille paint groups, the model's lamps, grilles,
     intakes, plates and trims projected on as decals, plan-view mirrors, model exhaust tips and wheels at the fitted
     axles / tracks; dims and cameras come from the real dimensions and greenhouse (see "real manufacturer models"
     below). opts.shapes === false (or no model for the style) keeps the procedural loft.
     Loft quality: the dense authored stations are smoothed along x (robust local quadric fit, 3.5 mm cap, wheel-well
     notches / flag boundaries / vertex hand-overs never blended: smoothStations), decimated, faired, ring-refined
     (Catmull-Rom), and shaded with analytic normals (ring tangent x fitted station slope: loftNormals) so decimated
     spans reflect like the dense curved surface. Front / rear lamps are lamp units (lampUnit: filtered face fitted
     under the outline, lamp interior with clean lamp-map / glow-mask uvs, black housing wall, domed cover lens);
     outlines a unit cannot carry stay decals. Low LOD lamp quads carry uvs + the same lamp maps.
   * LOD 'high' ~10-25k triangles, LOD 'low' < 400 triangles (merged, vertex coloured).
   Pure geometry (resolve / buildGeometry / pose maths) needs no DOM or GL and runs in Node.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});

(function () {
  'use strict';
  CB.gl = CB.gl || {};

  var PI = Math.PI, TAU = PI * 2, DEG = PI / 180;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function smooth(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function sstep(a, b, x) { return smooth((x - a) / (b - a)); }
  function wrapPi(a) { a = (a + PI) % TAU; if (a < 0) a += TAU; return a - PI; }
  function bell(d) { d = Math.abs(d); return d >= 1 ? 0 : 0.5 + 0.5 * Math.cos(d * PI); }

  /* ================================================================ colour */
  function hexRgb(hex, fb) {
    if (Array.isArray(hex) && hex.length >= 3) return [num(+hex[0], 0.5), num(+hex[1], 0.5), num(+hex[2], 0.5)];
    var s = typeof hex === 'string' ? hex.trim() : '';
    if (s[0] === '#') s = s.slice(1);
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return fb != null ? hexRgb(fb) : [0.5, 0.5, 0.5];
    var n = parseInt(s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function toLin(c) { return [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)]; }
  function lhex(hex, fb) { return toLin(hexRgb(hex, fb)); }
  function cmix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function cscale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function luma(c) { return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722; }

  /* ================================================================ mat4 (column-major) */
  function m4() { var m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
  function m4copy(o, a) { for (var i = 0; i < 16; i++) o[i] = a[i]; return o; }
  function m4mul(o, a, b) {
    var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
      a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    for (var c = 0; c < 4; c++) {
      var b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      o[c * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      o[c * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      o[c * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      o[c * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    }
    return o;
  }
  function m4translate(o, x, y, z) { m4ident(o); o[12] = x; o[13] = y; o[14] = z; return o; }
  function m4ident(o) { for (var i = 0; i < 16; i++) o[i] = (i % 5 === 0) ? 1 : 0; return o; }
  /** T(x, elev, -y) * Ry(heading) * Rz(pitch) * Rx(roll) — identical to renderer3d.carMatrix */
  function carMatrix(o, x, y, elev, heading, pitch, roll) {
    var ch = Math.cos(heading), sh = Math.sin(heading);
    var cp = Math.cos(pitch || 0), sp = Math.sin(pitch || 0);
    var cr = Math.cos(roll || 0), sr = Math.sin(roll || 0);
    var X0 = cp, X1 = sp, X2 = 0;
    var Y0 = -sp * cr, Y1 = cp * cr, Y2 = sr;
    var Z0 = sp * sr, Z1 = -cp * sr, Z2 = cr;
    o[0] = X0 * ch + X2 * sh; o[1] = X1; o[2] = -X0 * sh + X2 * ch; o[3] = 0;
    o[4] = Y0 * ch + Y2 * sh; o[5] = Y1; o[6] = -Y0 * sh + Y2 * ch; o[7] = 0;
    o[8] = Z0 * ch + Z2 * sh; o[9] = Z1; o[10] = -Z0 * sh + Z2 * ch; o[11] = 0;
    o[12] = x; o[13] = elev || 0; o[14] = -y; o[15] = 1;
    return o;
  }
  /** local wheel frame: T(px,py,pz) * Ry(steer) * Rx(camber) * Rz(spin) */
  function wheelLocal(o, px, py, pz, steer, camber, spin) {
    var cy = Math.cos(steer), sy = Math.sin(steer), cx = Math.cos(camber), sx = Math.sin(camber), cz = Math.cos(spin), sz = Math.sin(spin);
    // Rx*Rz columns
    var A0 = cz, A1 = sz * cx, A2 = sz * sx;          // image of X
    var B0 = -sz, B1 = cz * cx, B2 = cz * sx;         // image of Y
    var C0 = 0, C1 = -sx, C2 = cx;                    // image of Z
    // Ry maps (a,b,c) -> (a*cy + c*sy, b, -a*sy + c*cy)
    o[0] = A0 * cy + A2 * sy; o[1] = A1; o[2] = -A0 * sy + A2 * cy; o[3] = 0;
    o[4] = B0 * cy + B2 * sy; o[5] = B1; o[6] = -B0 * sy + B2 * cy; o[7] = 0;
    o[8] = C0 * cy + C2 * sy; o[9] = C1; o[10] = -C0 * sy + C2 * cy; o[11] = 0;
    o[12] = px; o[13] = py; o[14] = pz; o[15] = 1;
    return o;
  }
  /** body motion: rotate by pitch (Rz) and roll (Rx) about the point (0, py, 0), then lift by heave */
  function bodyLocal(o, pitch, roll, heave, py) {
    carMatrix(o, 0, 0, 0, 0, pitch, roll);
    o[12] = -o[4] * py; o[13] = py + heave - o[5] * py; o[14] = -o[6] * py;
    return o;
  }
  function rotZabout(o, ang, px, py) {
    var c = Math.cos(ang), s = Math.sin(ang);
    m4ident(o); o[0] = c; o[1] = s; o[4] = -s; o[5] = c;
    o[12] = px - (c * px - s * py); o[13] = py - (s * px + c * py);
    return o;
  }
  function xform(m, p) {
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  }
  function matFromBasis(o, X, Y, Z, T) {
    o[0] = X[0]; o[1] = X[1]; o[2] = X[2]; o[3] = 0; o[4] = Y[0]; o[5] = Y[1]; o[6] = Y[2]; o[7] = 0;
    o[8] = Z[0]; o[9] = Z[1]; o[10] = Z[2]; o[11] = 0; o[12] = T[0]; o[13] = T[1]; o[14] = T[2]; o[15] = 1; return o;
  }

  /* ================================================================ vec3 */
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vsc(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function vcross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vlen(a) { return Math.sqrt(vdot(a, a)); }
  function vnorm(a) { var l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function vlerp(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }

  /* ================================================================ geometry builder */
  var WHITE = [1, 1, 1, 1];
  function Geo() { this.p = []; this.n = []; this.t = []; this.c = []; this.i = []; }
  Geo.prototype.vert = function (x, y, z, nx, ny, nz, u, v, col) {
    var k = this.p.length / 3;
    col = col || WHITE;
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.t.push(u || 0, v || 0);
    this.c.push(col[0], col[1], col[2], col.length > 3 ? col[3] : 1);
    return k;
  };
  Geo.prototype.tri = function (a, b, c) { this.i.push(a, b, c); };
  Geo.prototype.quad = function (a, b, c, d) { this.i.push(a, b, c, a, c, d); };
  Geo.prototype.tris = function () { return this.i.length / 3; };
  Geo.prototype.verts = function () { return this.p.length / 3; };
  /** append another Geo transformed by mat4 m (normals by the 3x3; negative determinant flips winding) */
  Geo.prototype.append = function (g, m, colorOverride) {
    var base = this.verts(), p = g.p, n = g.n, i, flip = false;
    if (m) {
      var det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
      flip = det < 0;
    }
    for (i = 0; i < p.length; i += 3) {
      var x = p[i], y = p[i + 1], z = p[i + 2], nx = n[i], ny = n[i + 1], nz = n[i + 2];
      if (m) {
        var X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13], Z = m[2] * x + m[6] * y + m[10] * z + m[14];
        var NX = m[0] * nx + m[4] * ny + m[8] * nz, NY = m[1] * nx + m[5] * ny + m[9] * nz, NZ = m[2] * nx + m[6] * ny + m[10] * nz;
        var l = Math.sqrt(NX * NX + NY * NY + NZ * NZ) || 1;   // (mirrors keep outward normals; winding flips below)
        x = X; y = Y; z = Z; nx = NX / l; ny = NY / l; nz = NZ / l;
      }
      this.p.push(x, y, z); this.n.push(nx, ny, nz);
    }
    for (i = 0; i < g.t.length; i++) this.t.push(g.t[i]);
    if (colorOverride) for (i = 0; i < g.c.length; i += 4) this.c.push(colorOverride[0], colorOverride[1], colorOverride[2], colorOverride.length > 3 ? colorOverride[3] : 1);
    else for (i = 0; i < g.c.length; i++) this.c.push(g.c[i]);
    for (i = 0; i < g.i.length; i += 3) {
      if (flip) this.i.push(base + g.i[i], base + g.i[i + 2], base + g.i[i + 1]);
      else this.i.push(base + g.i[i], base + g.i[i + 1], base + g.i[i + 2]);
    }
    return this;
  };
  /** Orient every triangle so its winding agrees with its (averaged) vertex normals. gl-core shades back faces with
      the flipped normal and culls by winding, so a reversed triangle (e.g. a closed spoiler's underside) would be
      lit from the wrong side or vanish under face culling. Deterministic; degenerate triangles are left alone. */
  Geo.prototype.orient = function () {
    var P = this.p, N = this.n, I = this.i, flipped = 0;
    for (var t = 0; t < I.length; t += 3) {
      var a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      var ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      var vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      var fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      var fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (fl < 1e-9) continue;
      var nx = N[a] + N[b] + N[c], ny = N[a + 1] + N[b + 1] + N[c + 1], nz = N[a + 2] + N[b + 2] + N[c + 2];
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-6) continue;
      // only flip clear disagreements (> ~95 deg) so creased edges with blended normals keep their winding
      if ((fx * nx + fy * ny + fz * nz) / (fl * nl) < -0.08) { var k = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = k; flipped++; }
    }
    return flipped;
  };
  Geo.prototype.finish = function () {
    this.orient();
    var nv = this.verts();
    var idx = nv > 65535 ? new Uint32Array(this.i) : new Uint16Array(this.i);
    var pos = new Float32Array(this.p), mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < pos.length; i += 3) for (var c = 0; c < 3; c++) { var v = pos[i + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
    return {
      positions: pos, normals: new Float32Array(this.n), uvs: new Float32Array(this.t), colors: new Float32Array(this.c),
      indices: idx, colorSize: 4, vertexCount: nv, triangleCount: this.i.length / 3, bounds: nv ? { min: mn, max: mx } : null
    };
  };

  /**
   * Emit a quad grid. rows[i][j] = [x,y,z]. Normals = area-weighted face normals over the whole grid (so bucket
   * borders stay smooth; duplicate neighbouring points to make a crease). Options:
   *   wrapI / wrapJ   closed in that direction        flip      reverse orientation
   *   bucket(i,j)     -> key into geos (null = skip) for the quad (i,j)-(i+1,j+1)
   *   geos            {key: Geo}   (or `geo` for a single bucket)
   *   color(key,i,j)  -> rgba      uv(key,i,j) -> [u,v]
   *   outward         [x,y,z] hint: orientation chosen so the mean normal points this way
   */
  function emitGrid(rows, o) {
    var I = rows.length, J = rows[0].length;
    if (I < 2 || J < 2) return;
    var nI = o.wrapI ? I : I - 1, nJ = o.wrapJ ? J : J - 1;
    var N = new Float64Array(I * J * 3);
    var i, j, k;
    function acc(ii, jj, x, y, z) { k = ((ii % I) * J + (jj % J)) * 3; N[k] += x; N[k + 1] += y; N[k + 2] += z; }
    var sx = 0, sy = 0, sz = 0;
    for (i = 0; i < nI; i++) {
      var r0 = rows[i], r1 = rows[(i + 1) % I];
      for (j = 0; j < nJ; j++) {
        var j1 = (j + 1) % J;
        var a = r0[j], b = r1[j], c = r1[j1], d = r0[j1];
        var e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2], e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2], e3x = d[0] - a[0], e3y = d[1] - a[1], e3z = d[2] - a[2];
        var n1x = e1y * e2z - e1z * e2y, n1y = e1z * e2x - e1x * e2z, n1z = e1x * e2y - e1y * e2x;
        var n2x = e2y * e3z - e2z * e3y, n2y = e2z * e3x - e2x * e3z, n2z = e2x * e3y - e2y * e3x;
        acc(i, j, n1x + n2x, n1y + n2y, n1z + n2z); acc(i + 1, j, n1x, n1y, n1z); acc(i + 1, j1, n1x + n2x, n1y + n2y, n1z + n2z); acc(i, j1, n2x, n2y, n2z);
        sx += n1x + n2x; sy += n1y + n2y; sz += n1z + n2z;
      }
    }
    var flip = !!o.flip;
    if (o.outward) flip = (sx * o.outward[0] + sy * o.outward[1] + sz * o.outward[2]) < 0;
    var sgn = flip ? -1 : 1;
    for (k = 0; k < N.length; k += 3) {
      var l = Math.sqrt(N[k] * N[k] + N[k + 1] * N[k + 1] + N[k + 2] * N[k + 2]);
      if (l > 1e-12) { N[k] = N[k] / l * sgn; N[k + 1] = N[k + 1] / l * sgn; N[k + 2] = N[k + 2] / l * sgn; }
      else { N[k] = 0; N[k + 1] = 1; N[k + 2] = 0; }
    }
    var geos = o.geos || { g: o.geo }, maps = {};
    var bucket = o.bucket || function () { return 'g'; };
    function vid(key, ii, jj) {
      ii %= I; jj %= J;
      var mp = maps[key] || (maps[key] = new Int32Array(I * J).fill(-1));
      var q = ii * J + jj;
      if (mp[q] >= 0) return mp[q];
      var P = rows[ii][jj], kk = q * 3, g = geos[key];
      var uv = o.uv ? o.uv(key, ii, jj) : null;
      var col = o.color ? o.color(key, ii, jj) : null;
      mp[q] = g.vert(P[0], P[1], P[2], N[kk], N[kk + 1], N[kk + 2], uv ? uv[0] : 0, uv ? uv[1] : 0, col);
      return mp[q];
    }
    for (i = 0; i < nI; i++) {
      for (j = 0; j < nJ; j++) {
        var key = bucket(i, j);
        if (key == null || !geos[key]) continue;
        var A = vid(key, i, j), B = vid(key, i + 1, j), C = vid(key, i + 1, j + 1), D = vid(key, i, j + 1);
        if (flip) geos[key].quad(A, D, C, B); else geos[key].quad(A, B, C, D);
      }
    }
  }

  /** surface of revolution about +Z. profile [[r, z], ...]; rows = angle steps (CCW). opts: a0, a1, color(i,j), uv(i,j), outward */
  function lathe(geo, profile, seg, o) {
    o = o || {};
    var a0 = num(o.a0, 0), a1 = num(o.a1, TAU), full = Math.abs(a1 - a0 - TAU) < 1e-6;
    var rows = [], n = full ? seg : seg + 1;
    for (var s = 0; s < n; s++) {
      var a = a0 + (a1 - a0) * s / seg, ca = Math.cos(a), sa = Math.sin(a), row = [];
      for (var j = 0; j < profile.length; j++) row.push([profile[j][0] * ca, profile[j][0] * sa, profile[j][1]]);
      rows.push(row);
    }
    emitGrid(rows, {
      wrapI: full, flip: !!o.flip, geo: geo,
      color: function (k, i, j) { return o.color ? o.color(i, j) : (profile[j][2] || WHITE); },
      uv: o.uv ? function (k, i, j) { return o.uv(i, j); } : null
    });
    return rows;
  }
  /** flat-shaded axis aligned box, then transformed by m (optional) */
  var BOX_F = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  function box(geo, x0, y0, z0, x1, y1, z1, col, m) {
    var g = new Geo();
    var P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    var F = [[1, 2, 6, 5], [0, 4, 7, 3], [3, 7, 6, 2], [0, 1, 5, 4], [4, 5, 6, 7], [0, 3, 2, 1]];
    for (var f = 0; f < 6; f++) {
      var nn = BOX_F[f], q = F[f], b = g.verts();
      for (var k = 0; k < 4; k++) g.vert(P[q[k]][0], P[q[k]][1], P[q[k]][2], nn[0], nn[1], nn[2], k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0, col);
      g.quad(b, b + 1, b + 2, b + 3);
    }
    geo.append(g, m || null);
  }
  /** square/round tube along a 3D path (n sides), optionally capped. */
  function tube(geo, path, radius, sides, col, o) {
    o = o || {};
    if (path.length < 2) return;
    var rows = [], up = o.up || [0, 1, 0];
    for (var i = 0; i < path.length; i++) {
      var p = path[i], tng = vnorm(vsub(path[Math.min(path.length - 1, i + 1)], path[Math.max(0, i - 1)]));
      var ref = Math.abs(vdot(tng, up)) > 0.95 ? [1, 0, 0] : up;
      var bx = vnorm(vcross(tng, ref)), by = vcross(bx, tng);
      var rr = typeof radius === 'function' ? radius(i / (path.length - 1)) : radius;
      var ry = o.aspect ? rr * o.aspect : rr;
      var row = [];
      for (var s = 0; s < sides; s++) {
        var a = (s + (o.rot || 0.5)) / sides * TAU;
        row.push(vadd(p, vadd(vsc(bx, Math.cos(a) * rr), vsc(by, Math.sin(a) * ry))));
      }
      rows.push(row);
    }
    emitGrid(rows, { wrapJ: true, geo: geo, color: function () { return col; } });
    // orientation fix: make sure the first ring's normal points away from the axis
    if (o.caps) {
      [0, rows.length - 1].forEach(function (ri) {
        var ring = rows[ri], c = path[ri], b = geo.verts(), nrm = vnorm(vsub(path[ri === 0 ? 0 : ri], path[ri === 0 ? 1 : ri - 1]));
        geo.vert(c[0], c[1], c[2], nrm[0], nrm[1], nrm[2], 0, 0, col);
        for (var s2 = 0; s2 < ring.length; s2++) geo.vert(ring[s2][0], ring[s2][1], ring[s2][2], nrm[0], nrm[1], nrm[2], 0, 0, col);
        for (s2 = 0; s2 < ring.length; s2++) {
          var a1 = b + 1 + s2, a2 = b + 1 + (s2 + 1) % ring.length;
          if (ri === 0) geo.tri(b, a2, a1); else geo.tri(b, a1, a2);
        }
      });
    }
  }
  /** smooth ellipsoid (lat/long), centre c, radii r, then optional matrix */
  function ellipsoid(geo, c, r, segU, segV, colFn, m) {
    var g = new Geo(), rows = [];
    for (var i = 0; i <= segV; i++) {
      var v = i / segV, phi = -PI / 2 + v * PI, row = [];
      for (var j = 0; j < segU; j++) {
        var th = j / segU * TAU;
        row.push([c[0] + r[0] * Math.cos(phi) * Math.cos(th), c[1] + r[1] * Math.sin(phi), c[2] + r[2] * Math.cos(phi) * Math.sin(th)]);
      }
      rows.push(row);
    }
    emitGrid(rows, {
      wrapJ: true, geo: g, outward: null, flip: true,
      color: function (k, i, j) { return colFn ? colFn(rows[i][j]) : WHITE; }
    });
    geo.append(g, m || null);
  }

  /* ================================================================ catalog / style tables */
  var SVG_FALLBACK = {
    coupe: { wb: 2650, length_mm: 4550, height_mm: 1300, width_mm: 1930, frontOverhang_mm: 930, rearOverhang_mm: 970, noseHeight: 0.46, hoodLength: 0.40, cabinStart: 0.40, roofStart: 0.52, roofEnd: 0.66, cabinEnd: 0.84, roofHeight: 1.0, beltline: 0.68, deckHeight: 0.72, tailHeight: 0.60, windshieldRake_deg: 62, tailStyle: 'fastback', noseStyle: 'long', archStyle: 'flared', openTop: false, sideWindows: 2, pillarStyle: 'thin' },
    sedan: { wb: 2900, length_mm: 4950, height_mm: 1440, width_mm: 1900, frontOverhang_mm: 960, rearOverhang_mm: 1090, noseHeight: 0.50, hoodLength: 0.33, cabinStart: 0.33, roofStart: 0.45, roofEnd: 0.66, cabinEnd: 0.80, roofHeight: 1.0, beltline: 0.66, deckHeight: 0.70, tailHeight: 0.62, windshieldRake_deg: 60, tailStyle: 'notchback', noseStyle: 'long', archStyle: 'round', openTop: false, sideWindows: 3, pillarStyle: 'thin' },
    hatchback: { wb: 2600, length_mm: 4250, height_mm: 1450, width_mm: 1800, frontOverhang_mm: 880, rearOverhang_mm: 770, noseHeight: 0.52, hoodLength: 0.27, cabinStart: 0.27, roofStart: 0.40, roofEnd: 0.80, cabinEnd: 0.94, roofHeight: 1.0, beltline: 0.64, deckHeight: 0.66, tailHeight: 0.62, windshieldRake_deg: 58, tailStyle: 'hatch', noseStyle: 'short', archStyle: 'flared', openTop: false, sideWindows: 3, pillarStyle: 'thick' },
    wagon: { wb: 2880, length_mm: 4980, height_mm: 1470, width_mm: 1950, frontOverhang_mm: 960, rearOverhang_mm: 1140, noseHeight: 0.50, hoodLength: 0.32, cabinStart: 0.32, roofStart: 0.44, roofEnd: 0.88, cabinEnd: 0.96, roofHeight: 1.0, beltline: 0.65, deckHeight: 0.66, tailHeight: 0.62, windshieldRake_deg: 60, tailStyle: 'wagon', noseStyle: 'long', archStyle: 'flared', openTop: false, sideWindows: 4, pillarStyle: 'floating' },
    suv: { wb: 2950, length_mm: 4950, height_mm: 1760, width_mm: 2000, frontOverhang_mm: 930, rearOverhang_mm: 1070, noseHeight: 0.56, hoodLength: 0.30, cabinStart: 0.30, roofStart: 0.40, roofEnd: 0.90, cabinEnd: 0.97, roofHeight: 1.0, beltline: 0.62, deckHeight: 0.62, tailHeight: 0.58, windshieldRake_deg: 54, tailStyle: 'box', noseStyle: 'tall', archStyle: 'squared', openTop: false, sideWindows: 3, pillarStyle: 'thick' },
    roadster: { wb: 2450, length_mm: 4100, height_mm: 1240, width_mm: 1780, frontOverhang_mm: 820, rearOverhang_mm: 830, noseHeight: 0.44, hoodLength: 0.42, cabinStart: 0.42, roofStart: 0.50, roofEnd: 0.62, cabinEnd: 0.70, roofHeight: 0.92, beltline: 0.70, deckHeight: 0.72, tailHeight: 0.62, windshieldRake_deg: 64, tailStyle: 'open', noseStyle: 'long', archStyle: 'round', openTop: true, sideWindows: 1, pillarStyle: 'thin' },
    pickup: { wb: 3400, length_mm: 5900, height_mm: 1960, width_mm: 2080, frontOverhang_mm: 1000, rearOverhang_mm: 1500, noseHeight: 0.58, hoodLength: 0.24, cabinStart: 0.24, roofStart: 0.32, roofEnd: 0.52, cabinEnd: 0.56, roofHeight: 1.0, beltline: 0.60, deckHeight: 0.58, tailHeight: 0.58, windshieldRake_deg: 52, tailStyle: 'bed', noseStyle: 'blunt', archStyle: 'squared', openTop: false, bedLength_mm: 1700, sideWindows: 2, pillarStyle: 'thick' },
    hypercar: { wb: 2700, length_mm: 4700, height_mm: 1150, width_mm: 2050, frontOverhang_mm: 1000, rearOverhang_mm: 1000, noseHeight: 0.38, hoodLength: 0.26, cabinStart: 0.26, roofStart: 0.42, roofEnd: 0.54, cabinEnd: 0.70, roofHeight: 1.0, beltline: 0.70, deckHeight: 0.80, tailHeight: 0.68, windshieldRake_deg: 68, tailStyle: 'longtail', noseStyle: 'wedge', archStyle: 'flared', openTop: false, sideWindows: 1, pillarStyle: 'floating' },
    'shooting-brake': { wb: 2750, length_mm: 4800, height_mm: 1360, width_mm: 1950, frontOverhang_mm: 940, rearOverhang_mm: 1110, noseHeight: 0.46, hoodLength: 0.38, cabinStart: 0.38, roofStart: 0.50, roofEnd: 0.84, cabinEnd: 0.95, roofHeight: 1.0, beltline: 0.67, deckHeight: 0.68, tailHeight: 0.60, windshieldRake_deg: 62, tailStyle: 'kammback', noseStyle: 'long', archStyle: 'flared', openTop: false, sideWindows: 2, pillarStyle: 'floating' },
    van: { wb: 3300, length_mm: 5300, height_mm: 1950, width_mm: 2000, frontOverhang_mm: 880, rearOverhang_mm: 1120, noseHeight: 0.50, hoodLength: 0.14, cabinStart: 0.12, roofStart: 0.22, roofEnd: 0.96, cabinEnd: 0.99, roofHeight: 1.0, beltline: 0.55, deckHeight: 0.50, tailHeight: 0.48, windshieldRake_deg: 40, tailStyle: 'box', noseStyle: 'blunt', archStyle: 'round', openTop: false, sideWindows: 4, pillarStyle: 'thin' }
  };
  var STYLES = Object.keys(SVG_FALLBACK);
  // engine.js OVERHANG (overall length = wheelbase + overhang) — keeps the 3D body identical to the collision box
  var OVERHANG = { coupe: 1.85, sedan: 2.05, hatchback: 1.5, wagon: 2.1, suv: 2.0, roadster: 1.6, pickup: 2.6, hypercar: 1.95, 'shooting-brake': 2.0, van: 2.3 };
  // sculpting parameters per style (beyond the svg hints)
  var STYLE = {
    coupe: { fender: 0.025, rh0: 0.12, crown: 0.04, gCrown: 0.04, tuck: 0.075, tumble: 0.075, tg: 0.42, noseR: 0.62, noseP: 2.5, tailR: 0.5, tailP: 3.4, noseNarrow: 0.035, waist: 0.018, flare: 0.022, approach: 0.07, departure: 0.09, sideEnd: 0.38, hipH: 0.10, wsBulge: 0.12 },
    sedan: { fender: 0.008, rh0: 0.13, crown: 0.035, gCrown: 0.035, tuck: 0.06, tumble: 0.06, tg: 0.36, noseR: 0.55, noseP: 2.8, tailR: 0.42, tailP: 4.2, noseNarrow: 0.03, waist: 0.01, flare: 0.0, approach: 0.07, departure: 0.08, sideEnd: 0.26, hipH: 0.15, wsBulge: 0.1 },
    hatchback: { fender: 0.012, rh0: 0.13, crown: 0.032, gCrown: 0.032, tuck: 0.06, tumble: 0.055, tg: 0.32, noseR: 0.5, noseP: 3.0, tailR: 0.34, tailP: 3.6, noseNarrow: 0.03, waist: 0.008, flare: 0.024, approach: 0.07, departure: 0.07, sideEnd: 0.6, hipH: 0.18, wsBulge: 0.08 },
    wagon: { fender: 0.008, rh0: 0.13, crown: 0.033, gCrown: 0.03, tuck: 0.06, tumble: 0.055, tg: 0.3, noseR: 0.55, noseP: 2.8, tailR: 0.32, tailP: 3.8, noseNarrow: 0.03, waist: 0.008, flare: 0.016, approach: 0.07, departure: 0.07, sideEnd: 0.8, hipH: 0.16, wsBulge: 0.1 },
    suv: { fender: 0.01, rh0: 0.2, crown: 0.028, gCrown: 0.025, tuck: 0.04, tumble: 0.045, tg: 0.24, noseR: 0.42, noseP: 4.0, tailR: 0.3, tailP: 4.6, noseNarrow: 0.02, waist: 0.0, flare: 0.02, approach: 0.15, departure: 0.14, sideEnd: 0.82, hipH: 0.3, wsBulge: 0.06 },
    roadster: { fender: 0.035, rh0: 0.115, crown: 0.04, gCrown: 0.0, tuck: 0.08, tumble: 0.08, tg: 0.3, noseR: 0.62, noseP: 2.4, tailR: 0.5, tailP: 2.8, noseNarrow: 0.04, waist: 0.02, flare: 0.012, approach: 0.06, departure: 0.08, sideEnd: 0.0, hipH: 0.08, wsBulge: 0.1 },
    pickup: { fender: 0.0, rh0: 0.23, crown: 0.02, gCrown: 0.02, tuck: 0.03, tumble: 0.035, tg: 0.2, noseR: 0.36, noseP: 5.0, tailR: 0.14, tailP: 6.0, noseNarrow: 0.015, waist: 0.0, flare: 0.03, approach: 0.16, departure: 0.15, sideEnd: 0.0, hipH: 0.34, wsBulge: 0.05 },
    hypercar: { fender: 0.06, rh0: 0.095, crown: -0.012, gCrown: 0.06, tuck: 0.1, tumble: 0.1, tg: 0.62, noseR: 0.85, noseP: 2.1, tailR: 0.55, tailP: 2.4, noseNarrow: 0.07, waist: 0.05, flare: 0.04, approach: 0.05, departure: 0.12, sideEnd: 0.3, hipH: 0.06, wsBulge: 0.16 },
    'shooting-brake': { fender: 0.022, rh0: 0.12, crown: 0.038, gCrown: 0.034, tuck: 0.07, tumble: 0.07, tg: 0.36, noseR: 0.6, noseP: 2.6, tailR: 0.34, tailP: 4.0, noseNarrow: 0.035, waist: 0.015, flare: 0.02, approach: 0.07, departure: 0.08, sideEnd: 0.72, hipH: 0.11, wsBulge: 0.12 },
    van: { fender: 0.0, rh0: 0.15, crown: 0.022, gCrown: 0.02, tuck: 0.03, tumble: 0.05, tg: 0.12, noseR: 0.46, noseP: 3.2, tailR: 0.22, tailP: 5.0, noseNarrow: 0.02, waist: 0.0, flare: 0.0, approach: 0.12, departure: 0.12, sideEnd: 0.9, hipH: 0.42, wsBulge: 0.06 }
  };
  var FINISH = {
    solid: { m: 0.0, r: 0.3, cc: 0.75, fl: 0, hue: 0 },
    metallic: { m: 0.55, r: 0.3, cc: 1.0, fl: 0.22, hue: 0 },
    pearl: { m: 0.35, r: 0.24, cc: 1.0, fl: 0.16, hue: 0.03 },
    matte: { m: 0.12, r: 0.82, cc: 0.0, fl: 0, hue: 0 },
    satin: { m: 0.3, r: 0.52, cc: 0.25, fl: 0.1, hue: 0 },
    chrome: { m: 1.0, r: 0.05, cc: 0.4, fl: 0, hue: 0 },
    candy: { m: 0.5, r: 0.14, cc: 1.0, fl: 0.14, hue: 0.02 },
    chameleon: { m: 0.6, r: 0.18, cc: 1.0, fl: 0.2, hue: 0.45 }
  };
  var WHEEL_FALLBACK = {
    'y-spoke': { spokes: 5, style: 'y', concavity: 0.4 }, 'split-10': { spokes: 10, style: 'split', concavity: 0.7 },
    'twin-7': { spokes: 7, style: 'split', concavity: 0.5 }, 'mesh-bbs': { spokes: 20, style: 'mesh', concavity: 0.3 },
    'multi-spoke': { spokes: 20, style: 'mesh', concavity: 0.45 }, turbine: { spokes: 12, style: 'turbine', concavity: 0.35 },
    'fan-blade': { spokes: 9, style: 'turbine', concavity: 0.2 }, 'monoblock-5': { spokes: 5, style: 'monoblock', concavity: 0.25 },
    'monoblock-6': { spokes: 6, style: 'monoblock', concavity: 0.3 }, 'classic-5': { spokes: 5, style: 'monoblock', concavity: 0.15 },
    'deep-dish': { spokes: 8, style: 'dish', concavity: 0.9 }, beadlock: { spokes: 8, style: 'dish', concavity: 0.6 },
    'centerlock-race': { spokes: 10, style: 'centerlock', concavity: 0.6 }, 'aero-disc': { spokes: 0, style: 'aero-disc', concavity: 0 },
    'aero-blade': { spokes: 5, style: 'aero-disc', concavity: 0.1 }
  };
  var EXHAUST_FALLBACK = {
    stock: { tipStyle: 'hidden', tipCount: 2 }, sport: { tipStyle: 'round', tipCount: 2 }, titanium: { tipStyle: 'blued', tipCount: 4 },
    'straight-pipe': { tipStyle: 'center', tipCount: 1 }, valvetronic: { tipStyle: 'oval', tipCount: 4 }
  };

  function dataFind(coll, id) {
    var D = CB.data;
    if (!D || id == null) return null;
    try {
      if (typeof D.find === 'function') { var r = D.find(coll, id); if (r) return r; }
      var arr = coll.indexOf('.') > 0 ? (D[coll.split('.')[0]] || {})[coll.split('.')[1]] : D[coll];
      if (Array.isArray(arr)) for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i];
    } catch (e) { /* ignore */ }
    return null;
  }
  function styleSvg(style) {
    var fb = SVG_FALLBACK[style] || SVG_FALLBACK.coupe, out = {}, k;
    for (k in fb) out[k] = fb[k];
    var bs = dataFind('bodyStyles', style);
    if (bs && bs.svg) for (k in bs.svg) if (bs.svg[k] != null) out[k] = bs.svg[k];
    if (bs && isNum(bs.defaultWheelbase)) out.wb = bs.defaultWheelbase;
    return out;
  }

  /* ================================================================ resolve the build into a geometric spec */
  function resolve(build, opts) {
    build = build && typeof build === 'object' ? build : {};
    opts = opts || {};
    var body = build.body || {}, susp = build.suspension || {}, wh = build.wheels || {}, ti = build.tires || {}, ae = build.aero || {},
      ex = build.exterior || {}, en = build.engine || {}, br = build.brakes || {}, wt = build.weight || {}, it = build.interior || {};
    var style = String(body.style || body.type || opts.bodyStyle || 'coupe');
    if (!STYLE[style]) style = 'coupe';
    var st = STYLE[style], svg = styleSvg(style);
    var S = { style: style, st: st, svg: svg, lod: opts.lod === 'low' ? 'low' : 'high' };
    S.tailStyle = svg.tailStyle || 'fastback'; S.noseStyle = svg.noseStyle || 'long'; S.archStyle = svg.archStyle || 'round';
    S.openTop = !!svg.openTop;

    var wbDef = num(svg.wb, svg.length_mm - svg.frontOverhang_mm - svg.rearOverhang_mm);
    S.wb = clamp(num(body.wheelbase_mm, wbDef), 1800, 4500) / 1000;
    S.track = clamp(num(body.trackWidth_mm, 1600), 1200, 2000) / 1000;
    S.L = clamp(num(opts.length_m, S.wb + (OVERHANG[style] || 1.9)), 2.8, 6.5);
    S.W = clamp(num(opts.width_m, S.track + 0.32), 1.4, 2.4);
    var ovh = Math.max(0.8, S.L - S.wb);
    S.wb = S.L - ovh;
    var frac = svg.frontOverhang_mm / (svg.frontOverhang_mm + svg.rearOverhang_mm);
    S.fo = ovh * frac; S.ro = ovh - S.fo;
    S.xF = S.L / 2; S.xR = -S.L / 2; S.xFA = S.xF - S.fo; S.xRA = S.xR + S.ro;
    S.hw = S.W / 2;
    S.rh = clamp(num(susp.rideHeight_mm, st.rh0 * 1000), 40, 320) / 1000;

    // ---- wheels & tyres
    var rimR = clamp(num(wh.diameter_in, 18), 13, 24) * 0.0254 / 2;
    var twF = clamp(num(ti.widthFront_mm, 245), 145, 375) / 1000, twR = clamp(num(ti.widthRear_mm, num(ti.widthFront_mm, 245)), 145, 375) / 1000;
    var pF = clamp(num(ti.profileFront, 40), 20, 80) / 100, pR = clamp(num(ti.profileRear, num(ti.profileFront, 40)), 20, 80) / 100;
    var wd = dataFind('wheelDesigns', wh.design) || WHEEL_FALLBACK[wh.design] || WHEEL_FALLBACK['y-spoke'];
    S.wheelDesign = { id: wh.design || 'y-spoke', spokes: clamp(Math.round(num(wd.spokes, 5)), 0, 24), style: wd.style || 'y', concavity: clamp(num(wd.concavity, 0.3), 0, 1) };
    S.wheelMaterial = wh.material || 'cast';
    S.wheelFinish = lhex(wh.finish, '#2b2b2b');
    S.compound = ti.compound || 'performance';
    S.front = { tw: twF, r: rimR + twF * pF, rim: rimR, rotor: clamp(num(br.frontRotor_mm, 340), 220, 460) / 2000, pistons: num(br.frontPistons, 4), camber: clamp(num(susp.camberFront_deg, -1), -5, 2) * DEG };
    S.rear = { tw: twR, r: rimR + twR * pR, rim: rimR, rotor: clamp(num(br.rearRotor_mm, 320), 220, 460) / 2000, pistons: num(br.rearPistons, 2), camber: clamp(num(susp.camberRear_deg, -1), -5, 2) * DEG };
    S.brakeMat = br.material || 'iron';
    S.caliper = lhex(ex.caliperColor, '#c0c0c0');
    var gapBase = 0.022 + (S.archStyle === 'squared' ? 0.025 : 0) + Math.max(0, S.rh - st.rh0) * 0.5;
    S.front.Ra = S.front.r + gapBase; S.rear.Ra = S.rear.r + gapBase;
    S.front.x = S.xFA; S.rear.x = S.xRA;
    S.wi = Math.max(0.3, S.track / 2 - Math.max(twF, twR) / 2 - 0.045);
    // flares must cover the tyres
    var needF = (S.track / 2 + twF / 2 + 0.012) / (1 - st.tuck * 0.35) - S.hw;
    var needR = (S.track / 2 + twR / 2 + 0.012) / (1 - st.tuck * 0.35) - S.hw;
    S.front.flare = Math.max(st.flare, needF, 0); S.rear.flare = Math.max(st.flare, needR, 0);

    // ---- vertical layout
    var H0 = svg.height_mm / 1000;
    var shift = S.rh - st.rh0;
    S.H0 = H0;
    var fo0 = svg.frontOverhang_mm / 1000, ro0 = svg.rearOverhang_mm / 1000, wb0 = wbDef / 1000, L0 = fo0 + wb0 + ro0;
    S.xOf = function (f) {
      var m = f * L0, d;
      if (m <= fo0) d = m / fo0 * S.fo;
      else if (m <= fo0 + wb0) d = S.fo + (m - fo0) / wb0 * S.wb;
      else d = S.fo + S.wb + (m - fo0 - wb0) / ro0 * S.ro;
      return S.xF - d;
    };
    function setHeights(sh) {
      S.shift = sh;
      S.Y = function (f) { return f * H0 + sh; };
      S.noseY = S.Y(svg.noseHeight); S.beltY = S.Y(svg.beltline); S.deckY = S.Y(svg.deckHeight);
      S.tailY = S.Y(svg.tailHeight); S.roofY = S.Y(svg.roofHeight); S.cowlY = S.beltY - 0.012;
      S.H = H0 + sh;
    }
    setHeights(shift);
    // ---- longitudinal key stations
    S.xA = Math.min(S.xOf(svg.hoodLength), S.xF - 0.5);
    S.xR0 = Math.min(S.xOf(svg.roofStart), S.xA - 0.25);
    S.xR1 = Math.min(S.xOf(svg.roofEnd), S.xR0 - 0.1);
    S.xC = clamp(S.xOf(svg.cabinEnd), S.xR + 0.04, S.xR1 - 0.06);
    S.rN = Math.min(st.noseR, S.fo * 0.9); S.rT = Math.min(st.tailR, S.ro * 0.9, Math.max(0.12, S.xC - S.xR - 0.02) + 0.3);
    // body must clear the arches: lift the whole body if the wheels are huge
    var need = 0;
    [S.front, S.rear].forEach(function (a) {
      var top = a.r + a.Ra + 0.075;
      var ye = edgeY(S, a.x);
      need = Math.max(need, top - ye);
    });
    if (need > 0) setHeights(shift + need);

    // ---- tub (roadster cockpit / pickup bed)
    S.tub = null;
    if (S.openTop) {
      S.tub = { x0: S.xA - 0.32, x1: Math.max(S.xC + 0.02, S.xRA + S.rear.Ra + 0.12), floor: S.rh + 0.24, rim: 0.8, kind: 'cockpit' };
    } else if (S.tailStyle === 'bed') {
      var archTop = Math.max(S.rear.r + S.rear.Ra);
      S.tub = { x0: S.xC - 0.05, x1: S.xR + 0.07, floor: Math.max(S.deckY - 0.52, archTop + 0.03), rim: 0.92, kind: 'bed' };
    }
    // ---- power dome (big front engines)
    var frontEngine = (en.position || 'front') === 'front' && en.type !== 'ev';
    var bigEngine = /V8|V10|V12|W16/.test(String(en.layout || '')) || /supercharged|twincharged/.test(String(en.aspiration || ''));
    S.dome = frontEngine && bigEngine && S.style !== 'van' ? { x0: S.xA - 0.06, x1: S.xF - S.rN * 0.9, h: S.style === 'suv' || S.style === 'pickup' ? 0.02 : 0.03, w: 0.42 } : null;

    // ---- doors / pillars / side glass
    S.doors = clamp(Math.round(num(body.doors, style === 'sedan' ? 4 : 2)), 2, 5);
    S.seats = clamp(Math.round(num(body.seats, 2)), 1, 9);
    S.pillarStyle = svg.pillarStyle || 'thin';
    S.sideWindows = clamp(Math.round(num(svg.sideWindows, 2)), 1, 4);
    S.xSG0 = S.xA - 0.05;
    S.xSG1 = lerp(S.xR1, S.xC, st.sideEnd);
    if (S.xSG1 > S.xSG0 - 0.3) S.xSG1 = S.xSG0 - 0.3;
    var wts = [1.25, 1.0, 0.8, 0.65].slice(0, S.sideWindows), wsum = wts.reduce(function (a, b) { return a + b; }, 0);
    S.pillars = [];
    var acc = 0, glassLen = S.xSG0 - S.xSG1;
    for (var k = 0; k < S.sideWindows - 1; k++) {
      acc += wts[k];
      var pc = S.xSG0 - glassLen * acc / wsum;
      var last = k === S.sideWindows - 2;
      var pw = S.pillarStyle === 'thick' ? 0.1 : 0.06;
      if (last && S.pillarStyle === 'floating') pw = 0.13;
      S.pillars.push({ x: pc, w: pw, black: S.pillarStyle === 'floating' || k === 0 });
    }
    // door shut lines
    var dFront = Math.min(S.xA - 0.03, S.xFA - S.front.Ra - 0.07);
    var dRear1 = S.pillars.length ? S.pillars[0].x - S.pillars[0].w * 0.25 : Math.max(S.xC + 0.1, dFront - 1.2);
    if (dRear1 > dFront - 0.6) dRear1 = dFront - Math.min(1.2, Math.max(0.6, dFront - (S.xRA + S.rear.Ra + 0.05)));
    S.shut = [dFront, dRear1];
    if (S.doors >= 4) {
      var dRear2 = Math.max(S.xRA + S.rear.Ra + 0.04, S.pillars.length > 1 ? S.pillars[1].x : dRear1 - 0.9);
      if (dRear2 < dRear1 - 0.25) S.shut.push(dRear2);
    }
    S.doorMid = (S.shut[0] + S.shut[1]) / 2;

    // ---- exterior
    var fin = FINISH[ex.finish] || FINISH.metallic;
    S.finish = fin; S.finishId = FINISH[ex.finish] ? ex.finish : 'metallic';
    var paintSrgb = hexRgb(opts.color || ex.paint, '#b3121f');
    if (S.finishId === 'candy') paintSrgb = paintSrgb.map(function (v) { return Math.pow(v, 1.25); });
    S.paint = toLin(paintSrgb);
    S.stripe = ex.stripe && ex.stripe !== 'none' ? ex.stripe : null;
    S.stripeColor = lhex(ex.stripe && ex.stripe !== 'none' ? (opts.isPlayer === false && opts.accent ? opts.accent : ex.stripeColor) : (opts.accent || ex.stripeColor), '#ffffff');
    S.accent = lhex(opts.accent || ex.stripeColor, '#ffffff');
    S.roof = ['body', 'black', 'carbon', 'glass', 'contrast'].indexOf(ex.roof) >= 0 ? ex.roof : 'body';
    if (S.openTop) S.roof = 'body';
    S.roofColor = S.roof === 'contrast' ? lhex(ex.roofColor, '#111111') : S.roof === 'black' ? [0.006, 0.006, 0.007] : S.paint;
    S.tint = clamp(num(ex.windowTint_pct, 20), 0, 90) / 100;
    S.lights = ['halogen', 'led', 'matrix', 'laser'].indexOf(ex.lights) >= 0 ? ex.lights : 'led';
    S.mirrors = ['body', 'black', 'carbon'].indexOf(ex.mirrors) >= 0 ? ex.mirrors : 'body';
    S.badge = ['chrome', 'black', 'delete'].indexOf(ex.badge) >= 0 ? ex.badge : 'chrome';
    var numStr = ex.livery_number != null && String(ex.livery_number).trim() !== '' ? String(ex.livery_number).trim().slice(0, 3)
      : (opts.isPlayer !== true && opts.number != null && String(opts.number).trim() !== '' ? String(opts.number).trim().slice(0, 3) : '');
    if (S.stripe === 'le-mans' && !numStr && opts.number != null) numStr = String(opts.number).slice(0, 3);
    S.number = numStr;
    S.numberColor = opts.accent || ex.stripeColor || '#d01818';
    S.glassType = wt.glass || 'standard';
    S.rollCage = wt.rollCage === 'half' || wt.rollCage === 'full' ? wt.rollCage : 'none';
    S.harness = !!it.harness;
    S.interiorColor = lhex(it.primaryColor, '#1a1a1a');
    S.interiorAccent = lhex(it.accentColor, '#b3121f');
    // ---- aero
    S.splitter = ['lip', 'carbon', 'race'].indexOf(ae.splitter) >= 0 ? ae.splitter : null;
    S.wing = ['ducktail', 'lip-spoiler', 'swan-neck', 'gt-wing', 'active', 'biplane'].indexOf(ae.wing) >= 0 ? ae.wing : null;
    S.wingAngle = clamp(num(ae.wingAngle_deg, 6), -5, 25) * DEG;
    S.diffuser = ['mild', 'carbon', 'race'].indexOf(ae.diffuser) >= 0 ? ae.diffuser : null;
    S.canards = !!ae.canards; S.sideSkirts = !!ae.sideSkirts; S.activeAero = !!ae.activeAero;
    S.carbonAero = S.splitter === 'carbon' || S.splitter === 'race' || S.diffuser === 'carbon' || S.diffuser === 'race';
    // ---- powertrain cues
    S.ev = en.type === 'ev';
    S.enginePos = en.position || 'front';
    var exd = dataFind('exhausts', en.exhaust) || EXHAUST_FALLBACK[en.exhaust] || EXHAUST_FALLBACK.sport;
    S.exhaust = S.ev ? null : { style: exd.tipStyle || 'round', count: clamp(Math.round(num(exd.tipCount, 2)), 1, 4) };
    S.driven = (build.drivetrain && build.drivetrain.layout) || 'rwd';
    S.damping = clamp(num(susp.damping, 5), 1, 10);
    S.springs = (clamp(num(susp.springFront_nmm, 60), 15, 300) + clamp(num(susp.springRear_nmm, 70), 15, 300)) / 2;
    S.arb = (clamp(num(susp.arbFront, 5), 1, 10) + clamp(num(susp.arbRear, 4), 1, 10)) / 2;
    S.drl = S.lights === 'halogen' ? 0.0 : S.lights === 'led' ? 0.45 : S.lights === 'matrix' ? 0.55 : 0.65;

    // ---- driver & cameras
    var single = S.seats === 1 || (style === 'hypercar' && S.seats <= 1);
    S.zDrv = single ? 0 : -Math.min(0.38, S.hw * 0.4);
    var eyeX = S.openTop ? S.xR0 - 0.42 : S.xR0 - Math.min(0.42, Math.max(0.22, (S.xR0 - S.xR1) * 0.35));
    if (style === 'van' || style === 'suv' || style === 'pickup') eyeX = S.xR0 - 0.3;
    var hip = S.rh + 0.05 + st.hipH;
    var eyeY = hip + 0.7;
    var roofAtEye = S.openTop ? S.roofY + 0.25 : gTop(S, eyeX) - 0.1;
    eyeY = clamp(eyeY, S.beltY + 0.1, roofAtEye - 0.02);
    S.eye = [eyeX, eyeY, S.zDrv];
    S.hip = hip;
    // closed cars: the lower body's top is opened into a trimmed cabin well under the glasshouse so seats, dash,
    // driver and cage are visible through the (tinted) glass instead of a painted lid
    S.cabin = S.openTop ? null : { x0: S.xA - 0.03, x1: S.xC + 0.04, floor: Math.max(S.rh + 0.1, hip - 0.1), rim: S.tub ? S.tub.rim : 0.82, kind: 'cabin' };
    if (S.cabin && S.tub && S.cabin.x1 < S.tub.x0 + 0.03) S.cabin.x1 = S.tub.x0 + 0.03;
    if (S.cabin && S.cabin.x0 - S.cabin.x1 < 0.4) S.cabin = null;
    return S;
  }

  /* ---------------------------------------------------------------- profile functions */
  function hoodEase(S, u) {
    switch (S.noseStyle) {
      case 'blunt': case 'tall': return 1 - Math.pow(1 - u, 3.4);
      case 'short': return 1 - Math.pow(1 - u, 2.6);
      case 'wedge': return 0.55 * u + 0.45 * (1 - Math.pow(1 - u, 2));
      case 'low': return 0.4 * u + 0.6 * (1 - Math.pow(1 - u, 2));
      default: return 1 - Math.pow(1 - u, 2.1);
    }
  }
  /** height of the body's side top edge (shoulder / beltline / hood edge / deck edge) */
  function edgeY(S, x) {
    if (S.shape) return shapeEdge(S, x);
    var f = S.st.fender ? S.st.fender * (bell((x - S.xFA) / (S.front.Ra * 1.7)) + bell((x - S.xRA) / (S.rear.Ra * 1.7))) : 0;
    return edgeY0(S, x) + f;
  }
  function edgeY0(S, x) {
    if (x >= S.xA) {
      var u = clamp01((S.xF - x) / Math.max(0.05, S.xF - S.xA));
      return lerp(S.noseY, S.cowlY, hoodEase(S, u));
    }
    if (x >= S.xC) {
      var t = (S.xA - x) / Math.max(0.05, S.xA - S.xC);
      var y = lerp(S.cowlY, S.beltY, sstep(0, 0.18, t));
      return lerp(y, S.deckY, sstep(0.3, 1.0, t));
    }
    var r = (S.xC - x) / Math.max(0.05, S.xC - S.xR);
    var dropStart = S.tailStyle === 'box' || S.tailStyle === 'bed' || S.tailStyle === 'wagon' ? 0.2 : 0.55;
    return lerp(S.deckY, S.tailY, sstep(dropStart, 1.0, r));
  }
  function floorY(S, x) {
    if (S.shape) { var yb = S.shape.bottom(x); return yb === null ? S.rh : yb; }
    var y = S.rh;
    if (x > S.xFA) y += S.st.approach * Math.pow(sstep(S.xFA, S.xF, x), 1.3);
    if (x < S.xRA) y += S.st.departure * Math.pow(sstep(S.xRA, S.xR, x), 1.3);
    return y;
  }
  function superE(d, p) { d = clamp01(d); return Math.pow(Math.max(0, 1 - Math.pow(d, p)), 1 / p); }
  function halfW(S, x) {
    if (S.shape) return S.shape.halfW(x);
    var st = S.st, hw = S.hw;
    if (x > S.xF - S.rN) hw *= superE((x - (S.xF - S.rN)) / S.rN, st.noseP);
    if (x < S.xR + S.rT) hw *= superE(((S.xR + S.rT) - x) / S.rT, st.tailP);
    hw *= 1 - st.noseNarrow * sstep(S.xFA, S.xF, x);
    if (x < S.xFA && x > S.xRA) hw *= 1 - st.waist * Math.sin(PI * (S.xFA - x) / (S.xFA - S.xRA)) * (1 - bell((x - S.xFA) / (S.front.Ra * 1.6)) - bell((x - S.xRA) / (S.rear.Ra * 1.6)));
    hw += S.front.flare * bell((x - S.xFA) / (S.front.Ra * 1.45)) + S.rear.flare * bell((x - S.xRA) / (S.rear.Ra * 1.45));
    return Math.max(0, hw);
  }
  function archY(S, x) {
    var best = -1;
    for (var k = 0; k < 2; k++) {
      var a = k === 0 ? S.front : S.rear, dx = Math.abs(x - a.x), y = -1;
      if (S.archStyle === 'squared') {
        var top = a.r + a.Ra * 0.94;
        if (dx < a.Ra * 0.5) y = top; else y = top - (dx - a.Ra * 0.5) * 1.5;
        if (dx > a.Ra * 1.15) y = -1;
      } else if (dx < a.Ra) y = a.r + Math.sqrt(a.Ra * a.Ra - dx * dx);
      if (y > best) best = y;
    }
    return best;
  }
  function sideF(st, t) {
    return t < 0.5 ? 1 - st.tuck * Math.pow(1 - t / 0.5, 2) : 1 - st.tumble * Math.pow((t - 0.5) / 0.5, 2);
  }
  function domeAt(S, x, z, hwT) {
    var D = S.dome;
    if (!D || x > D.x1 + 0.3 || x < D.x0 - 0.2) return 0;
    var along = sstep(D.x0, D.x0 - 0.0001 + 0.12, D.x0 - (D.x0 - x)) ; // placeholder (kept smooth below)
    along = sstep(D.x1 + 0.0, D.x1 - 0.25, x) * sstep(D.x0 + 0.05, D.x0 - 0.1, x);
    var w = D.w * hwT;
    return D.h * along * bell(z / Math.max(0.05, w));
  }
  /** the tub (roadster cockpit / pickup bed / closed-car cabin well) covering x, or null */
  function tubAt(S, x, primaryOnly) {
    var T = S.tub;
    if (T && x <= T.x0 && x >= T.x1) return T;
    T = primaryOnly ? null : S.cabin;
    return T && x <= T.x0 && x >= T.x1 ? T : null;
  }
  function tubDip(S, x, primaryOnly) {
    var T = tubAt(S, x, primaryOnly);
    if (!T) return 0;
    var ramp = 0.012;
    if (x > T.x0 || x < T.x1) return 0;
    return Math.min(clamp01((T.x0 - x) / ramp), clamp01((x - T.x1) / ramp));
  }
  /** top surface height (crowned) of the lower body at lateral z, ignoring the tub */
  function crownY(S, x, z, yE, hwT) {
    var f = hwT > 1e-6 ? clamp01(Math.abs(z) / hwT) : 0;
    return yE + S.st.crown * (1 - f * f) * (hwT / Math.max(1e-6, S.hw * (1 - S.st.tumble))) + domeAt(S, x, z, hwT);
  }

  /* ---------------------------------------------------------------- lower body ring (one side, z >= 0) */
  // index layout (high)
  var LR = { BC: 0, WI0: 1, WI1: 2, SILL: 3, SILL2: 4, S0: 5 };
  var SIDE_T = [0.07, 0.17, 0.31, 0.46, 0.585, 0.585, 0.7, 0.83, 0.93];
  LR.S_END = LR.S0 + SIDE_T.length - 1;     // 13
  LR.E0 = LR.S_END + 1; LR.E1 = LR.E0 + 1;  // 14, 15
  LR.R = LR.E1 + 1; LR.R2 = LR.R + 1; LR.WB = LR.R2 + 1; LR.WB2 = LR.WB + 1; LR.M = LR.WB2 + 1; LR.C = LR.M + 1; // 16..21
  LR.N = LR.C + 1;   // 22 points per side
  /** bumper-corner relief in the overhangs: outboard of the valance (|z| > wi) the body bottom is lifted to y, so the
      tyres show below / beside the bumper corners from straight behind (chase cam) or ahead instead of being hidden
      by a full-width slab down to ride height. c ramps 0 -> 1 just past each wheel arch. */
  function endCut(S, x) {
    var A = null, c = 0, y = 0, wi = S.wi;
    if (x < S.xRA) {
      A = S.rear; c = sstep(A.x - A.Ra * 0.8, A.x - A.Ra * 1.12, x);
      // long overhangs (pickups, wagons) rise further toward the tail, like a step bumper
      y = A.r * 1.02 + (0.04 + 0.07 * clamp01((S.ro - 0.85) / 0.6)) * sstep(A.x - A.Ra, S.xR, x);
    } else if (x > S.xFA && !S.splitter && !S.canards) {
      A = S.front; c = sstep(A.x + A.Ra * 0.8, A.x + A.Ra * 1.12, x);
      y = A.r * 0.86;
    }
    if (!A || c <= 0) return null;
    var inner = S.track / 2 - A.tw / 2;
    return { c: c, y: y, wi: lerp(wi, Math.max(0.28, Math.min(wi, inner * 0.84)), c) };
  }
  function ringInfo(S, x) {
    var hw = halfW(S, x), yF = floorY(S, x), yE = edgeY(S, x);
    if (yE < yF + 0.1) yE = yF + 0.1;
    var arch = archY(S, x), yW = Math.max(yF, Math.min(arch, yE - 0.07));
    var hwT = hw * (1 - S.st.tumble) - 0.022 * (hw / S.hw);
    var E = endCut(S, x), cut = 0, wi = S.wi;
    if (E) {
      var yc = Math.min(lerp(yF, Math.max(yF, E.y), E.c), yE - 0.17);
      if (yc > yW) yW = yc;
      cut = E.c; wi = E.wi;
    }
    return { hw: hw, yF: yF, yE: yE, yW: yW, hwT: Math.max(0, hwT), cut: cut, wi: wi };
  }
  function ringHigh(S, x, out) {
    var R = ringInfo(S, x), hw = R.hw, yF = R.yF, yE = R.yE, yW = R.yW, hwT = R.hwT, st = S.st;
    var sc = hw / S.hw;
    var wi = Math.min(R.wi, hw * 0.82);
    // rounded tumblehome on the lifted bumper corners (up to 5.5 cm inboard right at the lower edge)
    var tk = R.cut * 0.055 * sc, tkH = 0.2;
    var zs = Math.max(wi + 0.01, hw * (1 - st.tuck) * 0.985 - tk);
    var p = out || [];
    p.length = 0;
    p.push([0, yF], [wi, yF], [wi, yW], [zs, yW], [zs, yW]);
    for (var k = 0; k < SIDE_T.length; k++) {
      var t = SIDE_T[k], y = Math.max(lerp(yF, yE, t), yW + 0.001 * k), z = hw * sideF(st, t);
      if (tk > 0) { var q = 1 - clamp01((y - yW) / tkH); z = Math.max(zs, z - tk * q * q); }
      if (k === 4) z += 0.0045 * sc;     // character crease ledge
      p.push([z, Math.min(y, yE - 0.01)]);
    }
    var zEdge = hw * (1 - st.tumble);
    p.push([lerp(zEdge, hwT, 0.25), yE - 0.012]);
    p.push([hwT, yE]);
    var dip = tubDip(S, x), T = tubAt(S, x) || S.tub;
    var fr = S.tub ? S.tub.rim : 0.82, fw = fr - 0.025;
    var yR = crownY(S, x, fr * hwT, yE, hwT);
    p.push([fr * hwT, yR], [fr * hwT, yR]);
    var floorYv = T ? T.floor : 0;
    var cw = crownY(S, x, fw * hwT, yE, hwT), cm = crownY(S, x, 0.45 * hwT, yE, hwT), cc = crownY(S, x, 0, yE, hwT);
    p.push([fw * hwT, lerp(cw, floorYv, dip)], [fw * hwT, lerp(cw, floorYv, dip)]);
    p.push([0.45 * hwT, lerp(cm, floorYv, dip)], [0, lerp(cc, floorYv, dip)]);
    return p;
  }
  // low LOD ring: bottom centre, arch underside, flank, shoulder, crown
  function ringLow(S, x) {
    var R = ringInfo(S, x), st = S.st;
    return [[0, R.yF], [R.hw * 0.92, R.yW], [R.hw * (1 - st.tuck * 0.3), Math.max(lerp(R.yF, R.yE, 0.5), R.yW + 0.03)], [R.hwT, R.yE], [0, R.yE + st.crown]];
  }

  /* ---------------------------------------------------------------- greenhouse */
  function rearEaseExp(S) {
    switch (S.tailStyle) {
      case 'fastback': case 'longtail': return 1.55;
      case 'notchback': return 1.1;
      case 'hatch': return 1.2;
      default: return 1.0;
    }
  }
  /** greenhouse top-centre height profile */
  function gTop(S, x) {
    var R0 = ringInfo(S, S.xA), cA = crownY(S, S.xA, 0, R0.yE, R0.hwT);
    if (x >= S.xA) return cA;
    if (x >= S.xR0) {
      var u = (S.xA - x) / Math.max(0.05, S.xA - S.xR0);
      var e = u + S.st.wsBulge * u * (1 - u) * 2;
      return lerp(cA, S.roofY, clamp01(e));
    }
    if (x >= S.xR1) {
      var v = (S.xR0 - x) / Math.max(0.05, S.xR0 - S.xR1);
      var drop = S.tailStyle === 'fastback' ? 0.035 : S.tailStyle === 'longtail' ? 0.04 : 0.01;
      return S.roofY + 0.012 * Math.sin(PI * v) - drop * v * v;
    }
    var Rc = ringInfo(S, S.xC), cC = crownY(S, S.xC, 0, Rc.yE, Rc.hwT);
    var top = gTop(S, S.xR1 + 1e-6);
    var w = clamp01((S.xR1 - x) / Math.max(0.05, S.xR1 - S.xC));
    return lerp(top, cC, Math.pow(w, rearEaseExp(S)));
  }
  var GR = { G0: 0, G1: 1, G2: 2, G2b: 3, G3: 4, G4: 5, G5: 6, G6: 7, G7: 8, G8: 9, N: 10 };
  function ghInfo(S, x) {
    if (S.shape) return shapeGh(S, x);
    var R = ringInfo(S, x);
    var zb = R.hwT * 0.955;
    var yb = crownY(S, x, zb, R.yE, R.hwT) - 0.006;
    var total = Math.max(0, gTop(S, x) - yb);
    var gc = Math.min(S.st.gCrown, total * 0.45);
    var h = total - gc;
    var gzr = Math.max(zb * 0.55, zb - h * S.st.tg);
    return { zb: zb, yb: yb, h: h, gc: gc, gzr: gzr };
  }
  function ringGH(S, x, out) {
    var G = ghInfo(S, x), zb = G.zb, yb = G.yb, h = G.h, gc = G.gc, gzr = G.gzr;
    var rr = Math.min(0.05, h * 0.22), fw = Math.min(0.055, gzr * 0.12);
    var p = out || [];
    p.length = 0;
    var g1 = [zb - 0.003, yb + Math.min(0.02, h * 0.12)];
    var g3 = [gzr + rr * 0.45, yb + h - rr];
    function mid(t, bulge) { return [lerp(g1[0], g3[0], t) + bulge * h, lerp(g1[1], g3[1], t)]; }
    function roofY(z) { var f = gzr > 1e-6 ? clamp01(z / gzr) : 0; return yb + h + gc * (1 - f * f); }
    p.push([zb, yb], g1, mid(0.38, 0.03), mid(0.72, 0.022), g3, [gzr + rr * 0.08, yb + h - rr * 0.3], [gzr - rr * 0.35, roofY(gzr - rr * 0.35)],
      [gzr - rr * 0.35 - fw, roofY(gzr - rr * 0.35 - fw)], [gzr * 0.45, roofY(gzr * 0.45)], [0, roofY(0)]);
    return p;
  }
  function ghZone(S, x) { return x > S.xR0 ? 'ws' : x >= S.xR1 ? 'roof' : 'rear'; }

  /* ---------------------------------------------------------------- surface queries */
  function polyDown(pts, z) {      // max y of a one-side polyline at lateral |z|
    z = Math.abs(z);
    var best = null;
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1], z0 = Math.min(a[0], b[0]), z1 = Math.max(a[0], b[0]);
      if (z < z0 - 1e-9 || z > z1 + 1e-9) continue;
      var y = z1 - z0 < 1e-9 ? Math.max(a[1], b[1]) : lerp(a[1], b[1], (z - a[0]) / (b[0] - a[0]));
      if (best === null || y > best) best = y;
    }
    return best;
  }
  function polyOut(pts, y) {       // max z of a one-side polyline at height y
    var best = null;
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1], y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
      if (y < y0 - 1e-9 || y > y1 + 1e-9) continue;
      var z = y1 - y0 < 1e-9 ? Math.max(a[0], b[0]) : lerp(a[0], b[0], (y - a[1]) / (b[1] - a[1]));
      if (best === null || z > best) best = z;
    }
    return best;
  }
  function inPoly(pts, z, y) {     // one-side polygon closed along the z = 0 axis
    z = Math.abs(z);
    var inside = false, n = pts.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var a = pts[i], b = pts[j];
      if ((a[1] > y) !== (b[1] > y) && z < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1] + 1e-12) + a[0]) inside = !inside;
    }
    return inside;
  }
  var _ringTmp = [], _ghTmp = [];
  function insideCar(S, x, y, z, withGH) {
    if (S.shape) return S.shape.inside(x, y, z);
    if (x > S.xF || x < S.xR) return false;
    if (inPoly(ringHigh(S, x, _ringTmp), z, y)) return true;
    if (withGH && !S.openTop && x <= S.xA && x >= S.xC && inPoly(ringGH(S, x, _ghTmp), z, y)) return true;
    return false;
  }
  function topAt(S, x, z, withGH) {
    if (S.shape) return S.shape.top(x, z);
    var y = polyDown(ringHigh(S, x, _ringTmp), z);
    if (withGH && !S.openTop && x <= S.xA && x >= S.xC) { var g = polyDown(ringGH(S, x, _ghTmp), z); if (g !== null && (y === null || g > y)) y = g; }
    return y;
  }
  function sideAt(S, x, y) { if (S.shape) return S.shape.side(x, y); return polyOut(ringHigh(S, x, _ringTmp), y); }
  /** first surface hit marching from origin o along direction d (unit), up to maxT. returns point or null */
  function cast(S, o, d, maxT, withGH) {
    var step = 0.025, t = 0, prev = 0;
    if (insideCar(S, o[0], o[1], o[2], withGH)) return null;
    while (t < maxT) {
      t += step;
      if (insideCar(S, o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t, withGH)) {
        var lo = prev, hi = t;
        for (var k = 0; k < 14; k++) { var m = (lo + hi) / 2; if (insideCar(S, o[0] + d[0] * m, o[1] + d[1] * m, o[2] + d[2] * m, withGH)) hi = m; else lo = m; }
        return [o[0] + d[0] * lo, o[1] + d[1] * lo, o[2] + d[2] * lo];
      }
      prev = t;
    }
    return null;
  }
  /** grid patch projected along d. originFn(u,v) -> outside point; returns rows (null rows skipped) */
  function projPatch(S, nu, nv, originFn, d, offset, maxT, withGH) {
    var hits = [], i, j;
    for (i = 0; i <= nu; i++) {
      var row = [];
      for (j = 0; j <= nv; j++) {
        var o = originFn(i / nu, j / nv), h = cast(S, o, d, maxT || 1.2, withGH);
        if (!h) return null;
        row.push(h);
      }
      hits.push(row);
    }
    // offset along the local surface normal (estimated from the hit grid), facing back against the ray
    var rows = [];
    for (i = 0; i <= nu; i++) {
      var out = [];
      for (j = 0; j <= nv; j++) {
        var du = vsub(hits[Math.min(nu, i + 1)][j], hits[Math.max(0, i - 1)][j]), dvv = vsub(hits[i][Math.min(nv, j + 1)], hits[i][Math.max(0, j - 1)]);
        var n = vcross(du, dvv), l = vlen(n);
        n = l > 1e-9 ? vsc(n, 1 / l) : vsc(d, -1);
        if (vdot(n, d) > 0) n = vsc(n, -1);
        if (vdot(n, d) > -0.25) n = vnorm(vadd(n, vsc(d, -0.6)));
        var P = hits[i][j];
        out.push([P[0] + n[0] * offset, P[1] + n[1] * offset, P[2] + n[2] * offset]);
      }
      rows.push(out);
    }
    return rows;
  }

  /* ================================================================ body generation */
  function xSamplesHigh(S) {
    var xs = [];
    function add(x, f) { xs.push({ x: x, f: f || 0 }); }
    var k, n;
    n = 9; for (k = 0; k <= n; k++) add(S.xF - S.rN + S.rN * Math.sin(k / n * PI / 2));
    n = 9; for (k = 0; k <= n; k++) add(S.xR + S.rT - S.rT * Math.sin(k / n * PI / 2));
    var a = S.xF - S.rN, b = S.xR + S.rT;
    n = Math.max(8, Math.round((a - b) / 0.14));
    for (k = 1; k < n; k++) add(lerp(a, b, k / n));
    [S.front, S.rear].forEach(function (ax) {
      var m = 14;
      for (var q = 0; q <= m; q++) add(ax.x + ax.Ra * 1.04 * Math.cos(q / m * PI));
      add(ax.x + ax.Ra * 1.25); add(ax.x - ax.Ra * 1.25);
      if (ax === S.rear) add(ax.x - ax.Ra * 1.12);                                 // bumper-corner ramp ends (endCut)
      else if (!S.splitter && !S.canards) add(ax.x + ax.Ra * 1.12);
    });
    add(S.xA); add(S.xC);
    S.shut.forEach(function (x) { add(x, 1); add(x - 0.006, 2); });
    [S.tub, S.cabin].forEach(function (T) { if (T) { add(T.x0); add(T.x0 - 0.012); add(T.x1 + 0.012); add(T.x1); } });
    xs.sort(function (p, q) { return q.x - p.x; });
    var out = [];
    for (k = 0; k < xs.length; k++) {
      var s = xs[k];
      if (s.x > S.xF) s.x = S.xF;
      if (s.x < S.xR) s.x = S.xR;
      var last = out[out.length - 1];
      if (last && Math.abs(last.x - s.x) < 0.0035) { last.f = last.f || s.f; continue; }
      out.push(s);
    }
    return out;
  }
  function inShut(S, x0, x1) {
    for (var i = 0; i < S.shut.length; i++) { var s = S.shut[i]; if (x0 <= s + 1e-5 && x1 >= s - 0.006 - 1e-5 && x0 - x1 < 0.02) return true; }
    return false;
  }

  function lowerBodyHigh(S, G) {
    var xs = xSamplesHigh(S), N = LR.N, rows = [], tmp = [];
    for (var i = 0; i < xs.length; i++) {
      var p = ringHigh(S, xs[i].x, tmp), x = xs[i].x, row = new Array(2 * N - 2);
      for (var j = 0; j < N; j++) row[j] = [x, p[j][1], p[j][0]];
      for (j = N - 2; j >= 1; j--) row[2 * N - 2 - j] = [x, p[j][1], -p[j][0]];
      rows.push(row);
    }
    var clad = S.archStyle === 'squared';
    var dips = xs.map(function (s) { return tubDip(S, s.x); });
    var tubKeys = xs.map(function (s, i) {
      var T = tubAt(S, i + 1 < xs.length ? (s.x + xs[i + 1].x) / 2 : s.x) || tubAt(S, s.x);
      return T ? (T.kind === 'bed' ? 'bed' : 'tub') : null;
    });
    function seg(j) { return j < N - 1 ? j : 2 * N - 3 - j; }
    var under = [0.012, 0.012, 0.013, 1], cladC = [0.03, 0.031, 0.033, 1], shutC = [0.004, 0.004, 0.004, 1];
    var bedC = [0.02, 0.02, 0.021, 1], tubC = S.interiorColor.concat([1]);
    var JN = 2 * N - 2, QN = [0, 0, 0, 0, 0, 0];
    var cxMid = (xs[0].x + xs[xs.length - 1].x) / 2, cyMid = S.rh + 0.45;
    function quadN(i, j) {
      var a = rows[i][j], b = rows[i + 1] ? rows[i + 1][j] : null, c = rows[i][(j + 1) % JN], d = rows[i + 1] ? rows[i + 1][(j + 1) % JN] : null;
      if (!b || !c || !d) return null;
      var ux = d[0] - a[0], uy = d[1] - a[1], uz = d[2] - a[2], vx = c[0] - b[0], vy = c[1] - b[1], vz = c[2] - b[2];
      QN[0] = uy * vz - uz * vy; QN[1] = uz * vx - ux * vz; QN[2] = ux * vy - uy * vx;
      QN[3] = (a[0] + b[0] + c[0] + d[0]) / 4; QN[4] = (a[1] + b[1] + c[1] + d[1]) / 4; QN[5] = (a[2] + b[2] + c[2] + d[2]) / 4;
      return QN;
    }
    // the grid's winding is uniform, so its normals are either all outward or all inward: find which
    var sigma = 0;
    for (var qi = 0; qi + 1 < rows.length; qi++) for (var qj = 0; qj < JN; qj++) {
      var q = quadN(qi, qj);
      if (q) sigma += q[0] * (q[3] - cxMid) + q[1] * (q[4] - cyMid) + q[2] * q[5];
    }
    sigma = sigma < 0 ? -1 : 1;
    /** quad (i,j) is on the OUTSIDE of the nose / tail cap (faces fore / aft, away from the car), where the ring
        closes and every flank strip (clad, sill underside, bed dip) would otherwise sweep across the face: a pickup's
        whole tailgate came out in the trim / bed colours. Inner faces (the bed side of the tailgate) are excluded. */
    function capQuad(i, j) {
      var q = quadN(i, j);
      if (!q) return false;
      var l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
      if (!(l > 1e-9) || Math.abs(q[0]) / l < 0.7) return false;
      return sigma * q[0] * (q[3] - cxMid) > 0;
    }
    function axialQuad(i, j) { return capQuad(i, j); }
    var xTail = xs[xs.length - 1].x;
    function tailFaceHigh(i, j) { return capQuad(i, j) && QN[3] < xTail + 0.25 && QN[4] > S.rh + 0.2; }
    emitGrid(rows, {
      wrapJ: true, flip: true, geos: G,
      bucket: function (i, j) {
        var s = seg(j);
        if (s <= LR.SILL2 - 1 + 0) return tailFaceHigh(i, j) ? 'paint' : 'under';
        if (s === LR.SILL2) return clad && !axialQuad(i, j) ? 'clad' : 'paint';
        if (s >= LR.R2 && (dips[i] > 0 || dips[i + 1] > 0) && tubKeys[i]) return tubKeys[i] === 'bed' && tailFaceHigh(i, j) ? 'paint' : tubKeys[i];
        if (s >= LR.S0 && s < LR.S_END && inShut(S, xs[i].x, xs[i + 1].x)) return 'shut';
        if (clad && s <= LR.S0 + 1 && !axialQuad(i, j)) return 'clad';
        return 'paint';
      },
      color: function (key) {
        return key === 'paint' ? S.paintRGBA : key === 'under' ? under : key === 'clad' ? cladC : key === 'shut' ? shutC : key === 'bed' ? bedC : tubC;
      }
    });
    // End caps. Rounded noses / tails close themselves (the ring shrinks to nothing), but square tails (pickup
    // tailgate, van / SUV / wagon boxes) end on a full-size ring and were left open: from behind you looked into
    // the shell and saw the bed's inner wall in the bed colour. Fan-fill the end rings (paint), inset 4 mm so
    // any existing tail panel / lamp face in front of it wins the depth test. Near-degenerate caps are skipped.
    endCap(rows[rows.length - 1], -1);
    endCap(rows[0], 1);
    function endCap(ring, dir) {
      if (!ring || ring.length < 3) return;
      var cy = 0, cz = 0, x = ring[0][0], k, area = 0;
      for (k = 0; k < ring.length; k++) { cy += ring[k][1]; cz += ring[k][2]; }
      cy /= ring.length; cz /= ring.length;
      for (k = 0; k < ring.length; k++) {
        var a = ring[k], b = ring[(k + 1) % ring.length];
        area += Math.abs((a[1] - cy) * (b[2] - cz) - (a[2] - cz) * (b[1] - cy)) / 2;
      }
      if (area < 0.02) return;
      var xi = x - dir * 0.004, g = G.paint, col = S.paintRGBA;
      var c0 = g.vert(xi, cy, cz, dir, 0, 0, 0, 0, col), first = -1, prev = -1;
      for (k = 0; k < ring.length; k++) {
        var v = g.vert(xi, ring[k][1], ring[k][2], dir, 0, 0, 0, 0, col);
        if (prev >= 0) g.tri(c0, prev, v); else first = v;
        prev = v;
      }
      if (prev >= 0 && first >= 0) g.tri(c0, prev, first);
    }
    return { rows: rows, xs: xs };
  }

  function ghSamples(S) {
    var xs = [], k;
    function add(x) { xs.push(x); }
    add(S.xA); add(S.xA - 0.016);
    for (k = 1; k < 6; k++) add(lerp(S.xA, S.xR0, k / 6));
    add(S.xR0 + 0.055); add(S.xR0);
    var nr = Math.max(2, Math.round((S.xR0 - S.xR1) / 0.16));
    for (k = 1; k < nr; k++) add(lerp(S.xR0, S.xR1, k / nr));
    add(S.xR1); add(S.xR1 - 0.03);
    for (k = 1; k < 6; k++) add(lerp(S.xR1, S.xC, k / 6));
    add(S.xC + 0.02); add(S.xC);
    add(S.xSG0); add(S.xSG1);
    S.pillars.forEach(function (p) { add(p.x + p.w / 2); add(p.x - p.w / 2); });
    xs.sort(function (a, b) { return b - a; });
    var out = [];
    for (k = 0; k < xs.length; k++) {
      var x = clamp(xs[k], S.xC, S.xA);
      if (out.length && Math.abs(out[out.length - 1] - x) < 0.004) continue;
      out.push(x);
    }
    return out;
  }
  function greenhouseHigh(S, G) {
    var xs = ghSamples(S), N = GR.N, rows = [], tmp = [];
    for (var i = 0; i < xs.length; i++) {
      var p = ringGH(S, xs[i], tmp), x = xs[i], row = new Array(2 * N - 1);
      for (var j = 0; j < N; j++) row[j] = [x, p[j][1], p[j][0]];
      for (j = N - 2; j >= 0; j--) row[2 * N - 2 - j] = [x, p[j][1], -p[j][0]];
      rows.push(row);
    }
    function seg(j) { return j < N - 1 ? j : 2 * N - 3 - j; }
    var roofKey = S.roof === 'body' ? 'paint' : S.roof === 'glass' ? 'glass' : S.roof === 'carbon' ? 'carbon' : 'roof';
    var floatingA = S.pillarStyle === 'floating' || S.style === 'hypercar';
    var aKey = S.roof === 'black' || S.roof === 'contrast' ? 'roof' : S.roof === 'carbon' ? 'carbon' : floatingA ? 'trimG' : 'paint';
    var trimC = [0.008, 0.008, 0.009, 1];
    var rearGlass = true;
    var classes = [];
    function cls(i, j) {
      var x0 = xs[i], x1 = xs[i + 1], xm = (x0 + x1) / 2, s = seg(j), z = ghZone(S, xm);
      if (s === 0) return 'trimG';                                   // belt moulding
      if (s <= 3) {                                                  // side glass band
        if (xm > S.xSG0 || xm < S.xSG1) return z === 'ws' ? aKey : (S.roof === 'black' || S.roof === 'contrast' ? 'paint' : 'paint');
        for (var k = 0; k < S.pillars.length; k++) {
          var P = S.pillars[k];
          if (xm < P.x + P.w / 2 && xm > P.x - P.w / 2) return P.black ? 'trimG' : 'paint';
        }
        return 'glass';
      }
      if (s <= 5) return z === 'ws' ? aKey : z === 'roof' ? (S.roof === 'glass' ? 'paint' : roofKey) : (S.roof === 'black' || S.roof === 'contrast' ? 'roof' : 'paint');
      if (s === 6) return z === 'roof' ? (S.roof === 'glass' ? 'trimG' : roofKey) : 'trimG';
      // top centre
      if (z === 'ws') return xm > S.xA - 0.016 || xm < S.xR0 + 0.055 ? 'trimG' : 'glass';
      if (z === 'roof') return roofKey === 'glass' ? (xm > S.xR0 - 0.08 || xm < S.xR1 + 0.08 ? 'trimG' : 'glass') : roofKey;
      if (S.tailStyle === 'longtail') return xm > S.xR1 - 0.03 ? roofKey : 'glass';
      if (xm > S.xR1 - 0.03) return roofKey === 'glass' ? 'trimG' : roofKey;
      if (xm < S.xC + 0.02) return 'trimG';
      return rearGlass ? 'glass' : 'paint';
    }
    emitGrid(rows, {
      flip: true, geos: G,
      bucket: function (i, j) { var c = cls(i, j); if (c === 'glass') classes.push([i, j]); return c; },
      color: function (key) {
        return key === 'paint' ? S.paintRGBA : key === 'roof' ? S.roofColor.concat([1]) : key === 'trimG' ? trimC : key === 'carbon' ? [1, 1, 1, 1] : WHITE;
      },
      uv: function (key, i, j) { var P = rows[i][j]; return [P[0] * 2.2, P[2] * 2.2]; }
    });
    return { rows: rows, xs: xs, cls: cls };
  }

  /** roadster windscreen: a curved sheet with a black frame (open top) */
  function windscreenOpen(S, G) {
    var xs = [], k, n = 6;
    for (k = 0; k <= n; k++) xs.push(lerp(S.xA, S.xR0, k / n));
    var rows = [], cols = 9;
    for (var i = 0; i < xs.length; i++) {
      var x = xs[i], R = ringInfo(S, x), zb = R.hwT * 0.9, yb0 = crownY(S, x, zb, R.yE, R.hwT);
      var top = gTop(S, x), row = [];
      for (var j = 0; j <= cols; j++) {
        var f = j / cols * 2 - 1, z = f * zb * (1 - 0.06 * (i / xs.length));
        var y = lerp(yb0, top, 1) - 0.02 * f * f + (yb0 - yb0);
        if (i === 0) y = crownY(S, x, z, R.yE, R.hwT);
        row.push([x - 0.0 * f * f, y, z]);
      }
      rows.push(row);
    }
    emitGrid(rows, {
      geos: G, outward: [1, 1, 0],
      bucket: function (i, j) { return j === 0 || j === cols - 1 || i === rows.length - 2 || i === 0 ? 'trimG' : 'glass'; },
      color: function (key) { return key === 'trimG' ? [0.01, 0.01, 0.011, 1] : WHITE; }
    });
  }

  /* ---------------------------------------------------------------- detail parts */
  function patch(G, key, rows, color, outward) {
    if (!rows) return false;
    emitGrid(rows, { geos: G, bucket: function () { return key; }, color: function () { return color; }, outward: outward });
    return true;
  }
  function frontLights(S, G, A) {
    var hwN = S.hw, yc = S.noseY - 0.055, kind = S.lights;
    var hgt = kind === 'halogen' ? 0.095 : kind === 'led' ? 0.066 : kind === 'matrix' ? 0.06 : 0.054;
    if (S.style === 'suv' || S.style === 'pickup' || S.style === 'van') { hgt *= 1.35; yc -= 0.02; }
    var z0 = hwN * 0.42, z1 = hwN * (S.noseStyle === 'wedge' ? 0.84 : 0.8);
    var slant = S.noseStyle === 'wedge' ? 0.04 : 0.018;
    A.headlights = [];
    for (var side = -1; side <= 1; side += 2) {
      var sd = side;
      var org = function (pad) {
        return function (u, v) {
          var z = lerp(z0 - pad, z1 + pad, u) * sd, y = yc - hgt / 2 - pad + (hgt + 2 * pad) * v + slant * u;
          if (kind === 'halogen') y += 0.012 * Math.sin(u * PI);
          return [S.xF + 0.3, y, z];
        };
      };
      var dir = vnorm([-1, 0, -0.32 * sd]);
      var housing = projPatch(S, 6, 2, org(0.012), dir, 0.002, 1.6);
      patch(G, 'trimG', housing, [0.012, 0.012, 0.014, 1], [1, 0, 0]);
      var lens = projPatch(S, 6, 2, org(0), dir, 0.006, 1.6);
      if (patch(G, 'head', lens, [0.85, 0.87, 0.9, 1], [1, 0, 0])) {
        var mid = lens[3][1];
        A.headlights.push([mid[0], mid[1], mid[2]]);
      }
      // DRL / projector accents for led / matrix / laser
      if (kind !== 'halogen') {
        var drl = projPatch(S, 6, 1, function (u, v) { return [S.xF + 0.3, yc - hgt / 2 - 0.016 + 0.008 * v + slant * u, lerp(z0 + 0.01, z1 - 0.005, u) * sd]; }, dir, 0.0075, 1.6);
        patch(G, 'head', drl, [1, 1, 1, 1], [1, 0, 0]);
      }
      if (kind === 'laser') {
        var blue = projPatch(S, 2, 1, function (u, v) { return [S.xF + 0.3, yc - hgt * 0.2 + hgt * 0.4 * v + slant * 0.2, lerp(z0 + 0.05, z0 + 0.1, u) * sd]; }, dir, 0.0085, 1.6);
        patch(G, 'chrome', blue, [0.15, 0.35, 1.0, 1], [1, 0, 0]);
      }
      // amber indicator
      var ind = projPatch(S, 2, 1, function (u, v) { return [S.xF + 0.3, yc - hgt / 2 + hgt * 0.6 * v + slant * 0.95, lerp(z1 - 0.06, z1, u) * sd]; }, dir, 0.0078, 1.6);
      patch(G, 'chrome', ind, [0.9, 0.35, 0.02, 1], [1, 0, 0]);
    }
  }
  function grilleAndIntakes(S, G) {
    var hw = S.hw, yN = S.noseY, yFf = floorY(S, S.xF);
    var trim = [0.01, 0.01, 0.011, 1];
    // main grille (ICE) / closed panel (EV)
    var gw = S.style === 'suv' || S.style === 'pickup' ? 0.5 : S.style === 'van' ? 0.42 : S.style === 'hypercar' ? 0.0 : 0.34;
    var gTopY = yN - (S.style === 'suv' || S.style === 'pickup' ? 0.06 : 0.09), gBot = Math.max(yFf + 0.16, gTopY - (S.style === 'suv' || S.style === 'pickup' ? 0.24 : 0.12));
    if (gw > 0 && gTopY > gBot + 0.03) {
      var grow = projPatch(S, 12, 5, function (u, v) { return [S.xF + 0.3, lerp(gBot, gTopY, v), (u * 2 - 1) * hw * gw * (1 - 0.12 * (1 - v))]; }, [-1, 0, 0], 0.008, 1.2);
      patch(G, 'trimG', grow, S.ev ? cscale(S.paint, 0.55).concat([1]) : trim, [1, 0, 0]);
      if (!S.ev && grow) {
        var nb = S.style === 'suv' || S.style === 'pickup' ? 4 : 3;
        for (var b = 0; b < nb; b++) {
          var yb = lerp(gBot + 0.02, gTopY - 0.02, (b + 0.5) / nb);
          var bar = projPatch(S, 6, 1, function (u, v) { return [S.xF + 0.3, yb - 0.006 + 0.012 * v, (u * 2 - 1) * hw * gw * 0.92 * (1 - 0.12 * (1 - (yb - gBot) / (gTopY - gBot)))]; }, [-1, 0, 0], 0.012, 1.2);
          patch(G, S.badge === 'chrome' ? 'chrome' : 'trimG', bar, S.badge === 'chrome' ? [0.8, 0.8, 0.82, 1] : [0.03, 0.03, 0.032, 1], [1, 0, 0]);
        }
      }
    }
    // lower intake
    var iw = S.style === 'hypercar' ? 0.78 : 0.6, iTop = yFf + (S.style === 'hypercar' ? 0.17 : 0.13), iBot = yFf + 0.035;
    var low = projPatch(S, 24, 5, function (u, v) { return [S.xF + 0.3, lerp(iBot, iTop, v), (u * 2 - 1) * hw * iw]; }, [-1, 0, 0], 0.009, 1.2);
    patch(G, 'trimG', low, [0.003, 0.003, 0.0035, 1], [1, 0, 0]);   // reads as an opening
    // corner brake ducts
    for (var s = -1; s <= 1; s += 2) {
      var sd = s;
      var duct = projPatch(S, 3, 3, function (u, v) { return [S.xF + 0.3, lerp(iBot + 0.02, iTop + 0.03, v), lerp(0.66, 0.8, u) * hw * sd]; }, vnorm([-1, 0, -0.25 * sd]), 0.003, 1.4);
      patch(G, 'trimG', duct, trim, [1, 0, 0]);
    }
    // hypercar / mid-engine side intakes
    if (S.style === 'hypercar' || (S.enginePos === 'mid' && S.style !== 'van')) {
      var x0 = S.xRA + S.rear.Ra * 1.15, x1 = Math.min(S.shut[1] - 0.05, x0 + 0.55);
      if (x1 > x0 + 0.1) {
        var yLo = S.rh + 0.18, yHi = Math.max(yLo + 0.12, lerp(yLo, S.beltY, 0.62));
        var rowsI = [];
        for (var i = 0; i <= 5; i++) {
          var x = lerp(x1, x0, i / 5), row = [];
          for (var j = 0; j <= 3; j++) {
            var yy = lerp(yLo + 0.05 * (1 - i / 5), yHi - 0.04 * (i / 5), j / 3), z = sideAt(S, x, yy);
            if (z === null) { rowsI = null; break; }
            row.push([x, yy, z + 0.004]);
          }
          if (!rowsI) break;
          rowsI.push(row);
        }
        if (rowsI) {
          patch(G, 'trimG', rowsI, trim, [0, 0, 1]);
          patch(G, 'trimG', rowsI.map(function (r) { return r.map(function (p) { return [p[0], p[1], -p[2]]; }); }), trim, [0, 0, -1]);
        }
      }
    }
  }
  function rearLights(S, G, A) {
    var yE = edgeY(S, S.xR + 0.05), box = S.tailStyle === 'box' || S.tailStyle === 'wagon' || S.tailStyle === 'kammback' || S.tailStyle === 'hatch';
    var bar = S.style === 'hypercar' || S.style === 'shooting-brake' || S.style === 'coupe';
    var hw = S.hw, red = [0.5, 0.02, 0.02, 1];
    A.brakeLights = [];
    var dir = [1, 0, 0];
    var yc = Math.min(S.deckY, yE) - (box ? 0.13 : 0.085), hgt = box ? 0.17 : 0.095;
    if (S.style === 'van' || S.style === 'suv') { yc = S.beltY - 0.04; hgt = 0.3; }
    if (S.style === 'pickup') { yc = S.deckY - 0.18; hgt = 0.28; }
    for (var side = -1; side <= 1; side += 2) {
      var sd = side;
      var z0 = (S.style === 'van' || S.style === 'suv' || S.style === 'pickup') ? 0.8 : 0.44, z1 = 0.93;
      var org = function (pad) { return function (u, v) { return [S.xR - 0.3, yc - hgt / 2 - pad + (hgt + 2 * pad) * v, lerp(z0 - pad * 2, z1 + pad, u) * hw * sd]; }; };
      var d = vnorm([1, 0, -0.3 * sd]);
      patch(G, 'trimG', projPatch(S, 5, 2, org(0.01), d, 0.002, 1.6), [0.02, 0.005, 0.005, 1], [-1, 0, 0]);
      var lamp = projPatch(S, 5, 2, org(0), d, 0.006, 1.6);
      if (patch(G, 'brake', lamp, red, [-1, 0, 0])) A.brakeLights.push(lamp[2][1].slice());
      var rev = projPatch(S, 1, 1, function (u, v) { return [S.xR - 0.3, yc - hgt / 2 + hgt * 0.45 * v, lerp(z0 + 0.0, z0 + 0.07, u) * hw * sd]; }, d, 0.0085, 1.6);
      patch(G, 'rev', rev, [0.85, 0.85, 0.85, 1], [-1, 0, 0]);
    }
    if (bar) {
      var lb = projPatch(S, 8, 1, function (u, v) { return [S.xR - 0.3, yc - 0.012 + 0.024 * v, (u * 2 - 1) * hw * 0.5]; }, dir, 0.006, 1.6);
      patch(G, 'brake', lb, red, [-1, 0, 0]);
    }
    // centre high-mounted stop lamp
    if (!S.openTop && S.tailStyle !== 'longtail') {
      var xm = S.tailStyle === 'notchback' || S.tailStyle === 'fastback' ? S.xC + 0.05 : S.xR1 - 0.035;
      var R = ghInfo(S, xm), y = R.yb + R.h + R.gc * 0.9;
      if (S.tailStyle !== 'notchback' && S.tailStyle !== 'fastback') {
        box3(G, 'brake', xm - 0.01, y - 0.015, -0.18, xm + 0.004, y + 0.004, 0.18, red);
      }
    }
    // badge on the tail
    if (S.badge !== 'delete') {
      var bt = projPatch(S, 3, 1, function (u, v) { return [S.xR - 0.3, yc + hgt / 2 + 0.035 + 0.03 * v, (u * 2 - 1) * 0.06]; }, dir, 0.004, 1.6);
      patch(G, S.badge === 'chrome' ? 'chrome' : 'trimG', bt, S.badge === 'chrome' ? [0.9, 0.9, 0.92, 1] : [0.02, 0.02, 0.02, 1], [-1, 0, 0]);
    }
  }
  function box3(G, key, x0, y0, z0, x1, y1, z1, col, m) { box(G[key], x0, y0, z0, x1, y1, z1, col, m); }

  function frontBadge(S, G) {
    if (S.badge === 'delete') return;
    var y = S.noseY - 0.035;
    var b = projPatch(S, 4, 2, function (u, v) { var a = u * TAU; return [S.xF + 0.3, y + Math.sin(a) * 0.022 * v, Math.cos(a) * 0.035 * v]; }, [-1, 0, 0], 0.005, 1.2);
    if (b) {
      // polar patch: rows of rings -> emit as fan-like grid
      patch(G, S.badge === 'chrome' ? 'chrome' : 'trimG', b, S.badge === 'chrome' ? [0.92, 0.92, 0.94, 1] : [0.02, 0.02, 0.02, 1], [1, 0, 0]);
    }
  }
  function mirrors(S, G, A) {
    var key = S.mirrors === 'body' ? 'paint' : S.mirrors === 'carbon' ? 'carbon' : 'trimG';
    var col = S.mirrors === 'body' ? S.paintRGBA : S.mirrors === 'carbon' ? [1, 1, 1, 1] : [0.01, 0.01, 0.011, 1];
    var armC = S.mirrors === 'body' ? [0.012, 0.012, 0.013, 1] : col, armKey = S.mirrors === 'body' ? 'trimG' : key;
    var x = S.xA - (S.style === 'van' ? 0.05 : 0.14), R = ringInfo(S, x), yb = R.yE;
    var zs = sideAt(S, x, yb - 0.04) || R.hw;
    var yRoot = yb - 0.03, zRoot = sideAt(S, x + 0.01, yRoot) || zs;    // door skin just below the shoulder
    var size = S.style === 'suv' || S.style === 'pickup' || S.style === 'van' ? 1.25 : 1;
    var rx = 0.075 * size, ry = 0.055 * size, rz = 0.1 * size, back = -rx * 0.5;
    var cy = yb + 0.075 * size, cz = zs + rz * 0.95;
    // housing: ellipsoid with a flat rear face that carries the glass
    var hRows = [];
    for (var i = 0; i <= 5; i++) {
      var phi = -PI / 2 + i / 5 * PI, row = [];
      for (var j = 0; j < 10; j++) {
        var th = j / 10 * TAU;
        row.push([Math.max(back, rx * Math.cos(phi) * Math.cos(th)), ry * Math.sin(phi), rz * Math.cos(phi) * Math.sin(th)]);
      }
      hRows.push(row);
    }
    var housing = new Geo();
    emitGrid(hRows, { wrapJ: true, geo: housing, flip: true, color: function () { return col; } });
    // glass: elliptical disc just proud of the flat back
    var sec = Math.sqrt(1 - (back / rx) * (back / rx)) * 0.84, gRows = [[], []];
    for (j = 0; j < 10; j++) {
      var a = j / 10 * TAU;
      gRows[0].push([back - 0.003, 0, 0]);
      gRows[1].push([back - 0.003, Math.sin(a) * ry * sec, Math.cos(a) * rz * sec]);
    }
    var glassG = new Geo();
    emitGrid(gRows, { wrapJ: true, geo: glassG, outward: [-1, 0, 0], color: function () { return [0.7, 0.72, 0.75, 1]; } });
    A.mirrors = [];
    for (var side = -1; side <= 1; side += 2) {
      var m = m4(); m[12] = x; m[13] = cy; m[14] = cz * side;
      G[key].append(housing, m);
      G.chrome.append(glassG, m);
      // arm: flat aero blade from the door skin (root buried 1.2 cm inside it) up into the housing, plus a sail foot
      var p0 = [x + 0.012, yRoot, (zRoot - 0.012) * side], p2 = [x - 0.004, cy - ry * 0.35, (cz - rz * 0.45) * side];
      var p1 = [lerp(p0[0], p2[0], 0.5), lerp(p0[1], p2[1], 0.35) + 0.008, lerp(p0[2], p2[2], 0.6)];
      tube(G[armKey], [p0, p1, p2], 0.011 * size, 6, armC, { aspect: 2.4, up: [1, 0, 0] });
      var fm = m4(); fm[12] = x + 0.01; fm[13] = yRoot + 0.004; fm[14] = (zRoot - 0.006) * side;
      ellipsoid(G[armKey], [0, 0, 0], [0.055 * size, 0.024 * size, 0.016], 6, 3, function () { return armC; }, fm);
      A.mirrors.push([x, cy, cz * side]);
    }
  }
  function doorHandles(S, G) {
    var key = S.badge === 'chrome' ? 'chrome' : 'trimG', col = key === 'chrome' ? [0.85, 0.85, 0.87, 1] : [0.015, 0.015, 0.016, 1];
    var y = S.beltY - 0.075, xs = [S.shut[1] + 0.12];
    if (S.shut.length > 2) xs.push(S.shut[2] + 0.12);
    xs.forEach(function (x) {
      var z = sideAt(S, x, y);
      if (z === null) return;
      for (var side = -1; side <= 1; side += 2) box3(G, key, x, y - 0.012, side > 0 ? z - 0.004 : -z - 0.012, x + 0.13, y + 0.012, side > 0 ? z + 0.012 : -z + 0.004, col);
    });
  }
  function wipers(S, G) {
    if (S.openTop) return;
    var x = S.xA - 0.06, G0 = ghInfo(S, x);
    var y = G0.yb + 0.03;
    for (var k = -1; k <= 1; k += 2) {
      var z0 = k * 0.05 - 0.15, len = Math.min(0.55, G0.zb * 0.8);
      var p0 = [x + 0.01, y, z0], p1 = [x - 0.08, y + 0.05, z0 + len * 0.95];
      tube(G.trimG, [p0, vlerp(p0, p1, 0.5), p1], 0.007, 4, [0.01, 0.01, 0.01, 1]);
    }
    if (S.tailStyle === 'hatch' || S.tailStyle === 'wagon' || S.tailStyle === 'box' || S.tailStyle === 'kammback') {
      var xr = lerp(S.xR1, S.xC, 0.75), Gr = ghInfo(S, xr), yr = Gr.yb + Gr.h * 0.3;
      tube(G.trimG, [[xr - 0.02, yr, 0], [xr + 0.04, yr + 0.18, 0.12], [xr + 0.08, yr + 0.3, 0.22]], 0.006, 4, [0.01, 0.01, 0.01, 1]);
    }
  }
  function roofExtras(S, G) {
    if (S.openTop) return;
    // roof rails (SUV / wagon)
    if (S.style === 'suv' || S.style === 'wagon') {
      var col = [0.02, 0.02, 0.022, 1];
      for (var side = -1; side <= 1; side += 2) {
        var path = [];
        for (var k = 0; k <= 8; k++) {
          var x = lerp(S.xR0 - 0.08, S.xR1 + 0.04, k / 8), Gi = ghInfo(S, x), z = (Gi.gzr - 0.06) * side;
          path.push([x, Gi.yb + Gi.h + Gi.gc * 0.4 + 0.045, z]);
        }
        tube(G.trimG, path, 0.014, 6, col, { aspect: 0.7 });
        [0, 4, 8].forEach(function (q) { var p = path[q]; box3(G, 'trimG', p[0] - 0.04, p[1] - 0.05, p[2] - 0.015, p[0] + 0.04, p[1], p[2] + 0.015, col); });
      }
    }
    // shark-fin antenna
    if (S.style !== 'hypercar' && S.style !== 'van') {
      var xa = S.xR1 + 0.08, Ga = ghInfo(S, xa), ya = Ga.yb + Ga.h + Ga.gc - 0.005;
      var fin = new Geo();
      var prof = [[0, 0], [0.13, 0], [0.04, 0.055], [0.0, 0.05]];
      var rowsF = [prof.map(function (p) { return [xa + 0.06 - p[0], ya + p[1], -0.025]; }), prof.map(function (p) { return [xa + 0.06 - p[0], ya + p[1] + 0.002, 0]; }), prof.map(function (p) { return [xa + 0.06 - p[0], ya + p[1], 0.025]; })];
      emitGrid([rowsF[0], rowsF[1], rowsF[2]].map(function (r) { return r; }), { geo: fin, wrapJ: true, outward: [0, 1, 0], color: function () { return S.roof === 'body' ? S.paintRGBA : [0.01, 0.01, 0.012, 1]; } });
      G.trimG.append(fin);
    }
    // hypercar roof snorkel (ICE)
    if (S.style === 'hypercar' && !S.ev) {
      var x0 = S.xR0 - 0.05, x1 = S.xC + 0.05, rows = [];
      for (var i = 0; i <= 8; i++) {
        var xx = lerp(x0, x1, i / 8), Gs = ghInfo(S, Math.min(xx, S.xR0)), base = xx < S.xR1 ? gTop(S, xx) : Gs.yb + Gs.h + Gs.gc;
        var hgt = 0.09 * Math.sin(Math.min(1, i / 2) * PI / 2) * (1 - 0.3 * i / 8), w = 0.11 * (1 - 0.35 * i / 8);
        rows.push([[xx, base - 0.01, -w], [xx, base + hgt * 0.8, -w * 0.9], [xx, base + hgt, 0], [xx, base + hgt * 0.8, w * 0.9], [xx, base - 0.01, w]]);
      }
      emitGrid(rows, { geos: G, bucket: function () { return 'carbon'; }, outward: [0, 1, 0], color: function () { return WHITE; } });
      var Gi0 = gTop(S, x0);
      box3(G, 'trimG', x0 - 0.004, Gi0 + 0.005, -0.08, x0 + 0.002, Gi0 + 0.07, 0.08, [0.005, 0.005, 0.005, 1]);
    }
  }
  function engineDeck(S, G) {
    // louvres on mid/rear-engine long decks
    if (!(S.style === 'hypercar' || (S.enginePos !== 'front' && S.tailStyle !== 'box'))) return;
    var x0 = S.xC - 0.06, x1 = Math.max(S.xR + 0.35, S.xC - 0.9), n = 7;
    for (var k = 0; k < n; k++) {
      var x = lerp(x0, x1, (k + 0.5) / n), yTop = topAt(S, x, 0);
      if (yTop === null) continue;
      var w = ringInfo(S, x).hwT * 0.42;
      var rows = [];
      for (var i = 0; i <= 1; i++) {
        var xx = x + (i ? -0.035 : 0.0), row = [];
        for (var j = 0; j <= 4; j++) { var z = (j / 4 * 2 - 1) * w, y = topAt(S, xx, z); row.push([xx, (y === null ? yTop : y) + 0.004 + (i ? 0.012 : 0), z]); }
        rows.push(row);
      }
      patch(G, 'trimG', rows, [0.01, 0.01, 0.011, 1], [0, 1, 0]);
    }
  }
  function bedDetails(S, G) {
    if (!S.tub || S.tub.kind !== 'bed') return;
    var T = S.tub, col = [0.015, 0.015, 0.016, 1];
    // rail caps
    for (var side = -1; side <= 1; side += 2) {
      var path = [];
      for (var k = 0; k <= 6; k++) { var x = lerp(T.x0 - 0.01, T.x1 + 0.01, k / 6), R = ringInfo(S, x); path.push([x, crownY(S, x, R.hwT * T.rim, R.yE, R.hwT) + 0.012, side * R.hwT * (T.rim + 0.035)]); }
      tube(G.trimG, path, 0.022, 4, col, { aspect: 0.55 });
    }
    // floor ribs
    var w = ringInfo(S, (T.x0 + T.x1) / 2).hwT * 0.85;
    for (var r = -3; r <= 3; r++) box3(G, 'trimG', T.x1 + 0.05, T.floor, r * w / 3.6 - 0.012, T.x0 - 0.05, T.floor + 0.012, r * w / 3.6 + 0.012, [0.035, 0.035, 0.037, 1]);
    // tailgate handle + hitch
    box3(G, 'trimG', S.xR - 0.012, S.deckY - 0.12, -0.12, S.xR + 0.004, S.deckY - 0.07, 0.12, col);
    box3(G, 'chrome', S.xR - 0.16, S.rh + 0.08, -0.04, S.xR + 0.02, S.rh + 0.13, 0.04, [0.3, 0.3, 0.32, 1]);
  }
  function rollHoops(S, G) {
    if (!S.openTop) return;
    var x = S.eye[0] - 0.32, R = ringInfo(S, x), y0 = R.yE - 0.02, top = S.eye[1] + 0.08;
    var zs = S.zDrv === 0 ? [0] : [S.zDrv, -S.zDrv];
    zs.forEach(function (zc) {
      var path = [];
      for (var k = 0; k <= 8; k++) { var a = k / 8 * PI; path.push([x, y0 + (top - y0) * Math.sin(a), zc + Math.cos(a) * 0.2]); }
      tube(G.chrome, path, 0.022, 8, [0.75, 0.76, 0.78, 1]);
      // headrest fairing on the deck behind the seat
      var rows = [];
      for (var i = 0; i <= 7; i++) {
        var xx = x - 0.02 - i * 0.12, Ri = ringInfo(S, xx), base = crownY(S, xx, zc, Ri.yE, Ri.hwT) - 0.01, h = 0.13 * (1 - Math.pow(i / 7, 1.4)), w = 0.16 * (1 - 0.4 * i / 7), row = [];
        for (var j = 0; j <= 6; j++) { var a2 = j / 6 * PI; row.push([xx, base + h * Math.sin(a2), zc + Math.cos(a2) * w]); }
        rows.push(row);
      }
      emitGrid(rows, { geos: G, bucket: function () { return 'paint'; }, color: function () { return S.paintRGBA; }, outward: [0, 1, 0] });
    });
  }
  function exhausts(S, G, A) {
    A.exhaust = [];
    if (!S.exhaust) return;
    var E = S.exhaust, yb = floorY(S, S.xR) + 0.05, hw = S.hw;
    var tips = [];
    if (E.style === 'hidden') { tips.push({ z: -hw * 0.45, r: 0.028, y: yb - 0.03, sx: 1, hidden: true }); if (E.count > 1) tips.push({ z: hw * 0.45, r: 0.028, y: yb - 0.03, hidden: true }); }
    else if (E.style === 'center') tips.push({ z: 0, r: 0.065, y: yb + 0.04 });
    else if (E.style === 'round') { tips.push({ z: -hw * 0.6, r: 0.045, y: yb + 0.02 }); tips.push({ z: hw * 0.6, r: 0.045, y: yb + 0.02 }); }
    else if (E.style === 'blued') { [-1, 1].forEach(function (s) { tips.push({ z: s * hw * 0.5 - 0.055, r: 0.04, y: yb + 0.02, blued: true }); tips.push({ z: s * hw * 0.5 + 0.055, r: 0.04, y: yb + 0.02, blued: true }); }); }
    else { [-1, 1].forEach(function (s) { tips.push({ z: s * hw * 0.55 - 0.06, r: 0.042, y: yb + 0.02, oval: true }); tips.push({ z: s * hw * 0.55 + 0.06, r: 0.042, y: yb + 0.02, oval: true }); }); }
    var zMax = tailValance(S, 0.2) - 0.012;
    [-1, 1].forEach(function (sd) {   // slide each side's tip group inboard together so twin tips never overlap
      var ex = 0;
      tips.forEach(function (t) { if (t.z * sd > 0) ex = Math.max(ex, Math.abs(t.z) + t.r * (t.oval ? 1.25 : 1) - zMax); });
      if (ex > 0) tips.forEach(function (t) { if (t.z * sd > 0) t.z -= sd * ex; });
    });
    tips.forEach(function (t) {
      var hit = cast(S, [S.xR - 0.4, t.y, t.z], [1, 0, 0], 1.2) || [S.xR, t.y, t.z];
      var xEnd = hit[0] - (t.hidden ? -0.05 : 0.025);
      var len = 0.16, sy = t.oval ? 0.62 : 1, szz = t.oval ? 1.25 : 1;
      var g = new Geo();
      var prof = [[t.r * 0.86, len * 0.7], [t.r, len * 0.72], [t.r * 1.04, len * 0.15], [t.r, 0], [t.r * 0.86, 0.004], [t.r * 0.84, 0.02]];
      lathe(g, prof, 16, {
        color: function (i, j) {
          if (t.hidden) return [0.03, 0.03, 0.03, 1];
          if (j >= 4) return [0.08, 0.07, 0.065, 1];
          if (t.blued) { var f = j / 3; return [lerp(0.25, 0.75, f), lerp(0.18, 0.65, f), lerp(0.55, 0.6, f), 1]; }
          return [0.9, 0.9, 0.92, 1];
        }
      });
      var cap = new Geo();
      lathe(cap, [[0, 0.03], [t.r * 0.84, 0.03]], 12, { color: function () { return [0.01, 0.01, 0.01, 1]; } });
      g.append(cap);
      // map lathe +Z axis -> -X (pointing backwards), scale for oval
      var m = m4();
      m[0] = 0; m[1] = 0; m[2] = szz; m[4] = 0; m[5] = sy; m[6] = 0; m[8] = 1; m[9] = 0; m[10] = 0;
      m[12] = xEnd; m[13] = t.y; m[14] = t.z;
      // the mapping X->+Z? use rows: lathe X (r cos) -> world Z, lathe Y (r sin) -> world Y, lathe Z (length) -> world -X
      G.chrome.append(g, m);
      A.exhaust.push([xEnd, t.y, t.z]);
    });
  }
  function splitter(S, G) {
    if (!S.splitter) return;
    var ext = S.splitter === 'lip' ? 0.03 : S.splitter === 'carbon' ? 0.065 : 0.12;
    var th = S.splitter === 'lip' ? 0.022 : 0.014;
    var key = S.splitter === 'lip' ? 'paint' : 'carbon', col = key === 'paint' ? S.paintRGBA : WHITE;
    var y = floorY(S, S.xF) + (S.splitter === 'lip' ? 0.0 : -0.01), n = 14, inner = [], outer = [];
    for (var k = 0; k <= n; k++) {
      var z = (k / n * 2 - 1) * S.hw * 0.96;
      var hit = cast(S, [S.xF + 0.3, y + 0.03, z], [-1, 0, 0], Math.min(1.0, S.fo + 0.25));
      if (!hit || hit[0] < S.xFA + 0.05) continue;
      inner.push([hit[0] - 0.12, z]); outer.push([Math.min(S.xF + 0.012, hit[0] + ext * (1 - 0.5 * Math.pow(Math.abs(k / n * 2 - 1), 6))), z * (1 + ext * 0.2)]);   // stays inside the collision box (+1 cm)
    }
    var rows = [];
    n = inner.length - 1;
    if (n < 3) return;
    // ring around the plate cross-section along z: top inner -> top outer -> bottom outer -> bottom inner
    for (k = 0; k <= n; k++) {
      var a = inner[k], b = outer[k];
      rows.push([[a[0], y + th, a[1]], [b[0] - 0.008, y + th, b[1]], [b[0], y + th * 0.4, b[1]], [b[0] - 0.006, y, b[1]], [a[0], y, a[1]]]);
    }
    emitGrid(rows, { geos: G, bucket: function () { return key; }, color: function () { return col; }, outward: [0, 1, 0], uv: function (kk, i, j) { var P = rows[i][j]; return [P[2] * 2, P[0] * 2]; } });
    if (S.splitter !== 'lip') {
      for (var s = -1; s <= 1; s += 2) {
        var o = outer[s < 0 ? 0 : n];
        box3(G, 'carbon', o[0] - 0.22, y, o[1] - 0.006 * s - 0.003, o[0] - 0.01, y + 0.07, o[1] - 0.006 * s + 0.003, WHITE);
      }
      if (S.splitter === 'race') [-0.35, 0.35].forEach(function (z) { box3(G, 'chrome', outer[n >> 1][0] - 0.12, y + th, z - 0.006, outer[n >> 1][0] - 0.1, y + 0.12, z + 0.006, [0.5, 0.5, 0.52, 1]); });
    }
  }
  /** half-width of the lower rear valance (inboard of the lifted bumper corners), minimum over the last `len` metres */
  function tailValance(S, len) {
    var w = Infinity;
    for (var k = 0; k <= 4; k++) {
      var x = S.xR + 0.03 + (len || 0.3) * k / 4, R = ringInfo(S, x);
      w = Math.min(w, Math.min(R.wi, R.hw * 0.82));
    }
    return w;
  }
  function diffuser(S, G) {
    if (!S.diffuser) return;
    var key = S.diffuser === 'mild' ? 'trimG' : 'carbon', col = key === 'trimG' ? [0.02, 0.02, 0.022, 1] : WHITE;
    var len = S.diffuser === 'mild' ? 0.32 : S.diffuser === 'carbon' ? 0.45 : 0.62;
    var ang = S.diffuser === 'race' ? 14 * DEG : 10 * DEG, n = 10;
    var y0 = floorY(S, S.xR + len) - 0.004, rows = [];
    // stays inside the valance between the lifted bumper corners (endCut) so it never pokes out beside the tyres
    var w = Math.min(S.hw * (S.diffuser === 'race' ? 0.8 : 0.66), tailValance(S, len) - 0.012);
    var yLip = floorY(S, S.xR + 0.02);    // the bumper's lower edge at the tail
    for (var i = 0; i <= 3; i++) {
      var x = S.xR + len - len * i / 3, y = y0 + Math.tan(ang) * (len * i / 3), row = [];
      for (var k = 0; k <= n; k++) row.push([x + 0.02 * (i === 3 ? 1 : 0), y, (k / n * 2 - 1) * w]);
      rows.push(row);
    }
    emitGrid(rows, { geos: G, bucket: function () { return key; }, color: function () { return col; }, outward: [0, -1, 0], uv: function (kk, i, j) { var P = rows[i][j]; return [P[2] * 2, P[0] * 2]; } });
    var strakes = S.diffuser === 'mild' ? 3 : S.diffuser === 'carbon' ? 5 : 7;
    for (var s = 0; s < strakes; s++) {
      var z = ((s + 0.5) / strakes * 2 - 1) * w * 0.95, hS = S.diffuser === 'race' ? 0.13 : 0.08;
      // fins live inside the diffuser tunnel: the trailing bottom stays flush with the bumper lip (no comb of teeth)
      var yTopS = y0 + Math.tan(ang) * len, yBotS = Math.min(yTopS - 0.025, Math.max(yTopS - hS, yLip - 0.006));
      var p = [[S.xR + len, y0], [S.xR + 0.02, yTopS], [S.xR + 0.02, yBotS]];
      var g = new Geo(), rowsS = [[], []];
      for (var q = 0; q < 3; q++) { rowsS[0].push([p[q][0], p[q][1], z - 0.004]); rowsS[1].push([p[q][0], p[q][1], z + 0.004]); }
      rowsS[0].push(rowsS[0][0]); rowsS[1].push(rowsS[1][0]);
      emitGrid(rowsS, { geo: g, outward: null, color: function () { return col; } });
      // the strake sides
      var b = g.verts();
      [[z - 0.004, -1], [z + 0.004, 1]].forEach(function (zz) {
        var bb = g.verts();
        for (var q2 = 0; q2 < 3; q2++) g.vert(p[q2][0], p[q2][1], zz[0], 0, 0, zz[1], 0, 0, col);
        if (zz[1] > 0) g.tri(bb, bb + 1, bb + 2); else g.tri(bb, bb + 2, bb + 1);
      });
      void b;
      G[key].append(g);
    }
  }
  function skirts(S, G) {
    if (!S.sideSkirts) return;
    var key = S.carbonAero ? 'carbon' : 'trimG', col = key === 'carbon' ? WHITE : [0.015, 0.015, 0.016, 1];
    var x0 = S.xFA - S.front.Ra * 1.02, x1 = S.xRA + S.rear.Ra * 1.02, n = 8;
    for (var side = -1; side <= 1; side += 2) {
      var rows = [];
      for (var i = 0; i <= n; i++) {
        var x = lerp(x0, x1, i / n), yF = floorY(S, x), z = sideAt(S, x, yF + 0.05);
        if (z === null) z = halfW(S, x) * 0.92;
        var zz = z * side, o = side;
        rows.push([[x, yF + 0.075, (z - 0.01) * o], [x, yF + 0.05, (z + 0.012) * o], [x, yF - 0.008, (z + 0.042) * o], [x, yF - 0.02, (z + 0.03) * o], [x, yF - 0.02, (z - 0.05) * o]]);
        void zz;
      }
      emitGrid(rows, { geos: G, bucket: function () { return key; }, color: function () { return col; }, outward: [0, 0, side], uv: function (kk, i, j) { var P = rows[i][j]; return [P[0] * 2, P[1] * 4]; } });
    }
  }
  function canards(S, G) {
    if (!S.canards) return;
    var x = S.xF - Math.min(0.2, S.rN * 0.4);
    for (var side = -1; side <= 1; side += 2) {
      [0.11, 0.2].forEach(function (dy, k) {
        var y = floorY(S, x) + dy, z = sideAt(S, x, y);
        if (z === null) return;
        var g = new Geo(), L = 0.22 - k * 0.04, Wd = 0.07 - k * 0.012;
        var rows = [[[0, 0, 0], [-L, 0, 0]], [[0, 0, Wd * 0.4], [-L, 0, Wd]]];
        emitGrid(rows, { geo: g, outward: [0, 1, 0], color: function () { return WHITE; } });
        var m = m4(), c = Math.cos(-0.22), s = Math.sin(-0.22);
        // rotate about x (dive plane angle), mirror for left side
        m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
        if (side < 0) { m[8] = -m[8]; m[9] = -m[9]; m[10] = -m[10]; }
        m[12] = x + 0.05; m[13] = y; m[14] = (z - 0.012) * side;
        G.carbon.append(g, m);
        // thickness: duplicate offset slightly
        var m2 = m4copy(m4(), m); m2[13] += 0.004;
        G.carbon.append(g, m2);
      });
    }
  }
  /** airfoil (downforce: inverted camber), chord along -x from leading edge at 0 */
  function airfoil(chord, n, thick) {
    var up = [], lo = [];
    for (var i = 0; i <= n; i++) {
      var t = 0.5 - 0.5 * Math.cos(i / n * PI);
      var yt = 5 * thick * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t * t * t - 0.1036 * t * t * t * t);
      var yc = -0.055 * Math.sin(PI * t) * (1 - 0.3 * t);
      up.push([-t * chord, (yc + yt) * chord]); lo.push([-t * chord, (yc - yt) * chord]);
    }
    var ring = [];
    for (i = n; i >= 0; i--) ring.push(up[i]);
    for (i = 1; i < n; i++) ring.push(lo[i]);
    return ring;   // closed (wrap): TE -> upper -> LE -> lower
  }
  function wingElement(geo, xLE, y, span, chord, angle, n, col, gurney) {
    var prof = airfoil(chord, n, 0.12), rows = [], c = Math.cos(-angle), s = Math.sin(-angle);
    var zs = [-span / 2, -span / 2 + 0.02, 0, span / 2 - 0.02, span / 2];
    for (var i = 0; i < zs.length; i++) {
      var row = [];
      for (var j = 0; j < prof.length; j++) { var px = prof[j][0], py = prof[j][1]; row.push([xLE + px * c - py * s, y + px * s + py * c, zs[i] * (i === 0 || i === 4 ? 1 : 1)]); }
      rows.push(row);
    }
    emitGrid(rows, { geo: geo, wrapJ: true, flip: false, outward: null, color: function () { return col; }, uv: function (k, i, j) { var P = rows[i][j]; return [P[2] * 1.5, P[0] * 3]; } });
    if (gurney) {
      var te = [xLE - chord * c, y - chord * s];
      box(geo, te[0] - 0.006, te[1], -span / 2 + 0.02, te[0] + 0.002, te[1] + 0.018 + chord * 0.0, span / 2 - 0.02, col);
    }
    return { te: [xLE - chord * c, y - chord * s] };
  }
  function wing(S, G, parts) {
    if (!S.wing) return null;
    var roofMount = S.tailStyle === 'hatch' || S.tailStyle === 'wagon' || S.tailStyle === 'box' || S.tailStyle === 'kammback';
    var deckX = S.tailStyle === 'bed' ? S.xR + 0.25 : S.xR + Math.min(0.32, Math.max(0.18, (S.xC - S.xR) * 0.3));
    var deckY = topAt(S, deckX, 0) || S.deckY;
    var span = S.W * (S.wing === 'biplane' ? 0.94 : 0.9);
    if (S.wing === 'ducktail' || S.wing === 'lip-spoiler') {
      if (roofMount) {
        // roof spoiler over the rear glass
        var xr = S.xR1, Gr = ghInfo(S, xr), y = Gr.yb + Gr.h + Gr.gc * 0.5;
        var g0 = new Geo(), L = S.wing === 'ducktail' ? 0.26 : 0.16, rowsR = [];
        for (var k = 0; k <= 8; k++) {
          var z = (k / 8 * 2 - 1) * Gr.gzr * 0.98, yy = y + Gr.gc * (1 - Math.pow(k / 8 * 2 - 1, 2)) * 0.5;
          rowsR.push([[xr + 0.02, yy - 0.004, z], [xr - L, yy + 0.01 - L * Math.tan(S.wing === 'ducktail' ? 0.05 : 0.12), z], [xr - L - 0.01, yy - 0.012, z], [xr - L * 0.5, yy - 0.03, z]]);
        }
        emitGrid(rowsR, { geo: g0, wrapJ: true, outward: null, color: function () { return S.paintRGBA; } });
        G.paint.append(g0);
        return null;
      }
      var duck = S.wing === 'ducktail', len = duck ? 0.34 : 0.13, rise = duck ? 0.075 : 0.045, n = 10, rows = [];
      var xEnd = S.xR + 0.03 + (duck ? 0.0 : 0.02);
      for (var i = 0; i <= n; i++) {
        var zf = i / n * 2 - 1, row = [];
        var xa = xEnd + len, xb = xEnd;
        var zA = zf * (ringInfo(S, xa).hwT * 0.96), zB = zf * (ringInfo(S, xb).hwT * 0.9);
        var ya = topAt(S, xa, zA), yb = topAt(S, xb, zB);
        if (ya === null || yb === null) continue;
        var yTip = yb + rise + (duck ? 0 : len * Math.tan(S.wingAngle * 0.5));
        row.push([xa, ya - 0.004, zA], [lerp(xa, xb, 0.5), lerp(ya, yTip, 0.38) + 0.004, lerp(zA, zB, 0.5)], [xb + 0.004, yTip, zB], [xb - 0.006, yTip - 0.008, zB], [xb, yb - 0.04, zB]);
        rows.push(row);
      }
      if (rows.length > 2) emitGrid(rows, { geos: G, bucket: function () { return 'paint'; }, outward: [0, 1, 0], color: function () { return S.paintRGBA; } });
      return null;
    }
    // ---- free-standing wings: own part (animated for active aero)
    var g = new Geo(), col = WHITE, mountC = [0.05, 0.05, 0.055, 1];
    var mx = roofMount ? S.xR1 - 0.02 : deckX - 0.02, baseY, chord = 0.3, y;
    var Gm = roofMount ? ghInfo(S, S.xR1) : null;
    baseY = roofMount ? Gm.yb + Gm.h + Gm.gc * 0.6 : deckY;
    var h = S.wing === 'gt-wing' ? 0.3 : S.wing === 'swan-neck' ? 0.32 : S.wing === 'active' ? 0.13 : 0.24;
    if (roofMount) h = Math.min(h, 0.12);
    if (S.style === 'pickup') h += 0.05;
    y = baseY + h;
    var ang = S.wing === 'active' ? 0 : S.wingAngle;
    var xLE = mx + chord * 0.5;
    var spanW = roofMount ? Math.min(span, (Gm.gzr + 0.1) * 2) : span;
    if (!roofMount) {   // endplates (outer face +4 mm) stay inside the body's plan outline under the wing
      var bw = Math.min(halfW(S, xLE - chord * 0.3), halfW(S, xLE - chord * 0.75));
      spanW = Math.max(0.6, Math.min(spanW, bw * 2 - 0.02));
    }
    var el = wingElement(g, xLE, y, spanW, chord, ang, 10, col, S.wing === 'gt-wing' || S.wing === 'biplane');
    if (S.wing === 'biplane') wingElement(g, xLE - 0.05, y + 0.15, spanW * 0.98, chord * 0.78, ang + 4 * DEG, 10, col, true);
    // endplates
    var epH = S.wing === 'biplane' ? 0.32 : 0.2, epL = chord + 0.12, epC = [0.45, 0.45, 0.47, 1];
    for (var sd = -1; sd <= 1; sd += 2) {
      var ez = sd * spanW / 2;
      var ep = [[xLE + 0.04, y + 0.04], [xLE + 0.04, y - epH * 0.55], [xLE - epL, y - epH * 0.45], [xLE - epL, y + epH - 0.1 + (S.wing === 'biplane' ? 0.1 : 0)]];
      var bb = g.verts();
      var nrm = [0, 0, sd];
      for (var q = 0; q < 4; q++) g.vert(ep[q][0], ep[q][1], ez + sd * 0.004, nrm[0], nrm[1], nrm[2], ep[q][0] * 3, ep[q][1] * 3, epC);
      if (sd > 0) g.quad(bb, bb + 1, bb + 2, bb + 3); else g.quad(bb, bb + 3, bb + 2, bb + 1);
      var bb2 = g.verts();
      for (q = 0; q < 4; q++) g.vert(ep[q][0], ep[q][1], ez - sd * 0.002, -nrm[0], -nrm[1], -nrm[2], ep[q][0] * 3, ep[q][1] * 3, epC);
      if (sd > 0) g.quad(bb2, bb2 + 3, bb2 + 2, bb2 + 1); else g.quad(bb2, bb2 + 1, bb2 + 2, bb2 + 3);
    }
    // mounts (go into a separate geometry so they stay with the body when the active wing pivots)
    var mounts = new Geo(), mz = Math.min(0.42, spanW * 0.28);
    for (var s2 = -1; s2 <= 1; s2 += 2) {
      var zc = s2 * mz;
      if (S.wing === 'swan-neck') {
        var base = [mx + 0.02, baseY - 0.01, zc], top = [xLE - chord * 0.45, y + 0.035, zc];
        var path = [];
        for (var k2 = 0; k2 <= 10; k2++) {
          var t = k2 / 10;
          var p0 = base, p1 = [base[0] - 0.02, y + 0.12, zc], p2 = [top[0] + 0.12, y + 0.14, zc], p3 = top;
          var a = (1 - t) * (1 - t) * (1 - t), b = 3 * (1 - t) * (1 - t) * t, c = 3 * (1 - t) * t * t, d = t * t * t;
          path.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1], zc]);
        }
        tube(mounts, path, 0.014, 4, mountC, { aspect: 2.2, up: [0, 0, 1] });
      } else if (S.wing === 'active') {
        box(mounts, mx - 0.06, baseY - 0.01, zc - 0.012, mx + 0.04, y - 0.01, zc + 0.012, mountC);
        tube(mounts, [[mx - 0.12, baseY, zc], [xLE - chord * 0.7, y - 0.012, zc]], 0.008, 6, [0.6, 0.6, 0.62, 1]);
      } else {
        var w0 = S.wing === 'biplane' ? 0.14 : 0.11;
        var gm = new Geo();
        var prof = [[mx + w0 * 0.5, baseY - 0.01], [mx - w0 * 0.5, baseY - 0.01], [mx - w0 * 0.25, y - 0.01], [mx + w0 * 0.35, y - 0.01]];
        var rowsM = [prof.map(function (p) { return [p[0], p[1], zc - 0.007]; }), prof.map(function (p) { return [p[0], p[1], zc + 0.007]; })];
        rowsM.forEach(function (r) { r.push(r[0]); });
        emitGrid(rowsM, { geo: gm, outward: null, color: function () { return mountC; } });
        [[zc - 0.007, -1], [zc + 0.007, 1]].forEach(function (zz) {
          var b0 = gm.verts();
          for (var q3 = 0; q3 < 4; q3++) gm.vert(prof[q3][0], prof[q3][1], zz[0], 0, 0, zz[1], 0, 0, mountC);
          if (zz[1] > 0) gm.quad(b0, b0 + 1, b0 + 2, b0 + 3); else gm.quad(b0, b0 + 3, b0 + 2, b0 + 1);
        });
        mounts.append(gm);
      }
    }
    G.chrome.append(mounts);
    void el;
    // CHMSL on the wing for race cars
    return { geo: g, pivot: [xLE - chord * 0.35, y], active: S.wing === 'active', base: S.wingAngle };
  }
  function stripes(S, G) {
    if (!S.stripe) return;
    var col = S.stripeColor.concat([1]), off = 0.0032;
    function topStripe(z0, z1, xa, xb, key, colFn, nz) {
      var rows = [], xs = [], k;
      // sample along x: lower body hood, greenhouse roof, deck (skip glass)
      var nx = Math.max(4, Math.round(Math.abs(xa - xb) / 0.08));
      for (k = 0; k <= nx; k++) xs.push(lerp(xa, xb, k / nx));
      var segs = [], cur = [];
      xs.forEach(function (x) {
        var z = ghZone(S, x), onGlass = !S.openTop && x < S.xA - 0.01 && x > S.xC + 0.01 && (z === 'ws' || (z === 'rear' && S.tailStyle !== 'longtail') || (z === 'roof' && S.roof === 'glass'));
        var hwT = ringInfo(S, x).hwT, gh = !S.openTop && x <= S.xA && x >= S.xC;
        var lim = gh ? ghInfo(S, x).gzr * 0.92 : hwT * 0.97;
        if (onGlass || Math.max(Math.abs(z0), Math.abs(z1)) > lim || tubDip(S, x, true) > 0) { if (cur.length > 1) segs.push(cur); cur = []; return; }
        var row = [];
        for (var j = 0; j <= (nz || 6); j++) {
          var zz = lerp(z0, z1, j / (nz || 6)), y = topAt(S, x, zz, gh);
          if (y === null) { row = null; break; }
          row.push([x, y + off, zz]);
        }
        if (!row) { if (cur.length > 1) segs.push(cur); cur = []; return; }
        cur.push(row);
      });
      if (cur.length > 1) segs.push(cur);
      segs.forEach(function (r) { emitGrid(r, { geos: G, bucket: function () { return key || 'paint'; }, outward: [0, 1, 0], color: function (kk, i, j) { return colFn ? colFn(r[i][j]) : col; } }); });
    }
    function sideStripe(x0, x1, y0, y1, colFn, key) {
      for (var side = -1; side <= 1; side += 2) {
        var rows = [], nx = Math.max(3, Math.round((x0 - x1) / 0.08)), ny = Math.max(1, Math.round((y1 - y0) / 0.05));
        for (var i = 0; i <= nx; i++) {
          var x = lerp(x0, x1, i / nx), row = [], yW = ringInfo(S, x).yW;
          for (var j = 0; j <= ny; j++) {
            var y = Math.max(lerp(y0, y1, j / ny), yW + 0.03), z = sideAt(S, x, y);
            if (z === null) { row = null; break; }
            row.push([x, y, (z + off) * side]);
          }
          if (row) rows.push(row);
        }
        if (rows.length > 1) emitGrid(rows, { geos: G, bucket: function () { return key || 'paint'; }, outward: [0, 0, side], color: function (k, i, j) { return colFn ? colFn(rows[i][j]) : col; } });
      }
    }
    var xa = S.xF - S.rN * 0.55, xb = S.xR + S.rT * 0.5;
    switch (S.stripe) {
      case 'racing-dual': topStripe(-0.31, -0.1, xa, xb); topStripe(0.1, 0.31, xa, xb); break;
      case 'center': topStripe(-0.17, 0.17, xa, xb); break;
      case 'le-mans': topStripe(-0.36, -0.12, xa, xb); topStripe(-0.08, -0.05, xa, xb, null, null, 1); break;
      case 'hood': topStripe(-ringInfo(S, S.xA).hwT * 0.5, ringInfo(S, S.xA).hwT * 0.5, S.xA - 0.03, S.xA + (S.xF - S.xA) * 0.62, 'trimG', function () { return col; }); break;
      case 'side-skirt': sideStripe(S.xFA - S.front.Ra * 1.1, S.xRA + S.rear.Ra * 1.1, S.rh + 0.04, S.rh + 0.11); break;
      case 'pinstripe': {
        var yp = lerp(S.rh, S.beltY, 0.62);
        sideStripe(S.xF - S.rN * 0.8, S.xR + S.rT * 0.8, yp - 0.004, yp + 0.0, null);
        sideStripe(S.xF - S.rN * 0.8, S.xR + S.rT * 0.8, yp - 0.014, yp - 0.01, null);
        break;
      }
      case 'gradient': {
        var gx0 = S.xFA - S.front.Ra * 1.05, gx1 = S.xRA + S.rear.Ra * 1.05;
        sideStripe(gx0, gx1, S.rh + 0.03, S.beltY - 0.04, function (p) {
          var t = clamp01((gx0 - p[0]) / (gx0 - gx1)), v = clamp01((p[1] - S.rh) / (S.beltY - S.rh));
          var f = Math.pow(1 - t, 1.6) * (1 - 0.4 * v);
          return cmix(S.paint, S.stripeColor, f).concat([1]);
        });
        break;
      }
    }
  }
  function numberDecals(S, G, hasTex) {
    if (!S.number) return false;
    var size = clamp((S.beltY - S.rh) * 0.62, 0.26, 0.46), xc = S.doorMid, yc = lerp(S.rh, S.beltY, 0.55);
    var drawn = false;
    function sideDecal(side) {
      var rows = [], n = 6;
      for (var i = 0; i <= n; i++) {
        var x = xc + size / 2 - size * i / n, row = [];
        for (var j = 0; j <= n; j++) {
          var y = yc + size / 2 - size * j / n, z = sideAt(S, x, y);
          if (z === null) return;
          row.push([x, y, (z + 0.004) * side]);
        }
        rows.push(row);
      }
      if (hasTex) {
        emitGrid(rows, {
          geos: G, bucket: function () { return 'decal'; }, outward: [0, 0, side], color: function () { return WHITE; },
          uv: function (k, i, j) { var u = i / n; return [side > 0 ? 1 - u : u, j / n]; }
        });
      } else {
        // texture-less fallback: white roundel with a coloured ring
        emitGrid(rows, {
          geos: G, bucket: function (i, j) { var u = (i + 0.5) / n * 2 - 1, v = (j + 0.5) / n * 2 - 1; return u * u + v * v < 1.05 ? 'trimG' : null; }, outward: [0, 0, side],
          color: function (k, i, j) { var u = i / n * 2 - 1, v = j / n * 2 - 1, r = Math.sqrt(u * u + v * v); return r > 0.82 ? lhex(S.numberColor, '#d01818').concat([1]) : [0.92, 0.92, 0.9, 1]; }
        });
      }
      drawn = true;
    }
    sideDecal(1); sideDecal(-1);
    // roof / hood roundel (readable from above, top of the number towards the nose)
    var xr = S.openTop ? S.xA + (S.xF - S.xA) * 0.4 : (S.xR0 + S.xR1) / 2, sz = Math.min(size, S.openTop ? 0.4 : (S.xR0 - S.xR1) * 0.8);
    if (hasTex && sz > 0.18) {
      var rows2 = [], n2 = 5, ok = true;
      for (var i2 = 0; i2 <= n2 && ok; i2++) {
        var x = xr + sz / 2 - sz * i2 / n2, row2 = [];
        for (var j2 = 0; j2 <= n2; j2++) {
          var z2 = -sz / 2 + sz * j2 / n2, y2 = topAt(S, x, z2, !S.openTop);
          if (y2 === null) { ok = false; break; }
          row2.push([x, y2 + 0.004, z2]);
        }
        rows2.push(row2);
      }
      if (ok && S.roof !== 'glass') emitGrid(rows2, { geos: G, bucket: function () { return 'decal'; }, outward: [0, 1, 0], color: function () { return WHITE; }, uv: function (k, i, j) { return [j / n2, i / n2]; } });
    }
    return drawn;
  }

  /* ---------------------------------------------------------------- interior + driver */
  function interior(S, G, D) {
    var col = S.interiorColor.concat([1]), dark = [0.02, 0.02, 0.022, 1], acc = S.interiorAccent.concat([1]);
    var eye = S.eye, hip = S.hip;
    var seatsZ = S.zDrv === 0 ? [0] : [S.zDrv, -S.zDrv];
    var xSeat = eye[0] - 0.12;
    seatsZ.forEach(function (z) {
      box3(G, 'interior', xSeat - 0.05, hip - 0.04, z - 0.25, xSeat + 0.4, hip + 0.06, z + 0.25, col);
      var m = m4(), a = 0.32;
      m[0] = Math.cos(a); m[1] = Math.sin(a); m[4] = -Math.sin(a); m[5] = Math.cos(a); m[12] = xSeat - 0.02; m[13] = hip + 0.02;
      box(G.interior, -0.1, 0, z - 0.24, 0.0, 0.62, z + 0.24, col, m);
      box(G.interior, -0.11, 0.16, z - 0.245, -0.09, 0.5, z - 0.2, acc, m);
      box(G.interior, -0.11, 0.16, z + 0.2, -0.09, 0.5, z + 0.245, acc, m);
    });
    // dashboard
    if (!S.openTop || true) {
      var xd0 = S.xA - 0.02, xd1 = Math.max(eye[0] + 0.42, S.xA - 0.55), R = ghInfo(S, (xd0 + xd1) / 2);
      box3(G, 'interior', xd1, R.yb - 0.16, -R.zb * 0.94, xd0, R.yb + 0.04, R.zb * 0.94, dark);
    }
    // steering wheel
    var sw = [eye[0] + 0.46, eye[1] - 0.3, S.zDrv], g = new Geo();
    var prof = [];
    for (var k = 0; k <= 6; k++) { var a2 = k / 6 * TAU; prof.push([0.175 + Math.cos(a2) * 0.016, Math.sin(a2) * 0.016]); }
    lathe(g, prof, 14, { color: function () { return [0.03, 0.03, 0.03, 1]; } });
    box(g, -0.02, -0.03, -0.012, 0.02, 0.03, 0.012, [0.05, 0.05, 0.05, 1]);
    box(g, -0.17, -0.012, -0.006, 0.17, 0.012, 0.006, [0.05, 0.05, 0.05, 1]);
    var m2 = m4(), tilt = -0.42;
    // wheel plane faces the driver (-X): map lathe Z -> -X, X -> Z, Y -> Y, then tilt about Z
    var c = Math.cos(tilt), s = Math.sin(tilt);
    var ax = [0, 0, 1], ay = [s * 0 + 0, 1, 0], az = [-c, -s, 0];
    void ay;
    matFromBasis(m2, ax, [-s, c, 0], az, sw);
    m2[0] = 0; m2[1] = 0; m2[2] = 1;
    G.interior.append(g, m2);
    // cabin floor / door cards (cover the body's top surface inside the glasshouse)
    if (!S.openTop && !S.cabin) {
      var rows = [], xa = S.xA - 0.02, xb = S.xC + 0.03;
      for (var i = 0; i <= 6; i++) {
        var x = lerp(xa, xb, i / 6), Gi = ghInfo(S, x), row = [];
        for (var j = 0; j <= 6; j++) { var zz = (j / 6 * 2 - 1) * Gi.zb * 0.985; row.push([x, Gi.yb + 0.012 - 0.004 * (1 - Math.pow(j / 6 * 2 - 1, 2)), zz]); }
        rows.push(row);
      }
      patch(G, 'interior', rows, [0.025, 0.025, 0.027, 1], [0, 1, 0]);
    }
    // roll cage
    if (S.rollCage !== 'none' && !S.openTop) {
      var cageC = [0.08, 0.08, 0.085, 1], xh = xSeat - 0.18, Gh = ghInfo(S, xh), r = 0.02;
      var hoop = [], zt = Gh.gzr - 0.07;
      hoop.push([xh, Gh.yb - 0.08, -Gh.zb + 0.08], [xh, Gh.yb + Gh.h - 0.08, -zt], [xh, Gh.yb + Gh.h - 0.05, 0], [xh, Gh.yb + Gh.h - 0.08, zt], [xh, Gh.yb - 0.08, Gh.zb - 0.08]);
      tube(G.interior, hoop, r, 6, cageC);
      tube(G.interior, [[xh, Gh.yb + Gh.h - 0.08, -zt], [xh, Gh.yb - 0.06, Gh.zb - 0.12]], r * 0.8, 6, cageC);
      tube(G.interior, [[xh, Gh.yb + Gh.h - 0.08, zt * 0.8], [Math.max(S.xC + 0.15, xh - 0.7), Gh.yb - 0.02, zt * 0.8]], r * 0.8, 6, cageC);
      tube(G.interior, [[xh, Gh.yb + Gh.h - 0.08, -zt * 0.8], [Math.max(S.xC + 0.15, xh - 0.7), Gh.yb - 0.02, -zt * 0.8]], r * 0.8, 6, cageC);
      if (S.rollCage === 'full') {
        var xf = S.xA - 0.12, Gf = ghInfo(S, S.xR0 + 0.05);
        [-1, 1].forEach(function (sd) {
          tube(G.interior, [[xh, Gh.yb + Gh.h - 0.08, sd * zt], [S.xR0 - 0.02, Gf.yb + Gf.h - 0.07, sd * (Gf.gzr - 0.07)], [xf, Gf.yb - 0.02, sd * (Gf.zb - 0.1)]], r, 6, cageC);
          tube(G.interior, [[xh, Gh.yb - 0.02, sd * (Gh.zb - 0.1)], [xf, Gf.yb - 0.1, sd * (Gf.zb - 0.1)]], r * 0.8, 6, cageC);
        });
      }
    }
    // driver: helmet + shoulders + arms (kind 'driver')
    var hc = S.accent, visor = [0.01, 0.012, 0.02, 1];
    var hp = [eye[0] - 0.02, eye[1] + 0.03, S.zDrv];
    ellipsoid(D, hp, [0.135, 0.14, 0.125], 12, 8, function (p) {
      var dx = p[0] - hp[0], dy = p[1] - hp[1];
      if (dx > 0.06 && dy > -0.06 && dy < 0.045) return visor;
      if (dy > 0.11 || (dx < -0.1 && dy > 0.02)) return cscale(hc, 0.6).concat([1]);
      return hc.concat([1]);
    });
    var suit = S.harness ? cmix(S.paint, [0.05, 0.05, 0.05], 0.3).concat([1]) : [0.05, 0.05, 0.06, 1];
    box(D, eye[0] - 0.2, eye[1] - 0.55, S.zDrv - 0.22, eye[0] + 0.05, eye[1] - 0.16, S.zDrv + 0.22, suit);
    [-1, 1].forEach(function (sd) {
      tube(D, [[eye[0] - 0.05, eye[1] - 0.22, S.zDrv + sd * 0.19], [eye[0] + 0.2, eye[1] - 0.36, S.zDrv + sd * 0.2], [sw[0] - 0.03, sw[1] + 0.02, S.zDrv + sd * 0.16]], 0.045, 6, suit);
    });
  }

  /* ---------------------------------------------------------------- wheels */
  function rimStyle(S) { return S.wheelDesign; }
  /** build tyre + rim/disc + caliper geometry for one axle (right side, outer face +Z) */
  function wheelGeos(S, A, isFront) {
    var W = isFront ? S.front : S.rear, tw = W.tw, r = W.r, rimR = W.rim, h = r - rimR;
    var D = rimStyle(S), high = S.lod === 'high';
    var tyre = new Geo(), rim = new Geo(), cal = new Geo(), tread = S.hasTex && high ? new Geo() : null, disc = S.hasTex && high ? new Geo() : null;
    // ---- tyre (sidewalls + shoulders; with textures the crown is its own tread part carrying the tread maps)
    var grooves = tread ? 0 : S.compound === 'slick' ? 0 : S.compound === 'track' ? 2 : S.compound === 'winter' || S.compound === 'all-season' ? 4 : 3;
    var rub = S.hasTex ? [0.92, 0.92, 0.92, 1] : [0.035, 0.035, 0.038, 1], groove = S.hasTex ? [0.35, 0.35, 0.35, 1] : [0.012, 0.012, 0.013, 1];
    var zt = tw * 0.4;
    var sideIn = [[rimR + 0.004, -tw * 0.44, rub, 1], [rimR + h * 0.1, -tw * 0.46, rub, 0.92], [rimR + h * 0.45, -tw * 0.505, rub, 0.5], [r - h * 0.13, -tw * 0.485, rub, 0], [r - h * 0.015, -tw * 0.42, rub, 0], [r, -zt, rub, 0]];
    var crown = [];
    for (var gk = 0; gk < grooves; gk++) {
      var zc = lerp(-zt, zt, (gk + 1) / (grooves + 1)), gw = tw * 0.025;
      crown.push([r, zc - gw, rub, 0], [r - 0.007, zc, groove, 0], [r, zc + gw, rub, 0]);
    }
    var sideOut = [[r, zt, rub, 0], [r - h * 0.015, tw * 0.42, rub, 0], [r - h * 0.13, tw * 0.485, rub, 0], [rimR + h * 0.45, tw * 0.505, rub, 0.55], [rimR + h * 0.1, tw * 0.46, rub, 0.92], [rimR + 0.004, tw * 0.44, rub, 1]];
    var tseg = high ? 40 : 8, A1 = TAU - 2e-6;      // open seam (duplicated column): the uvs wrap without a backwards quad
    function tyreLathe(geo, prof, uvFn) {
      lathe(geo, prof.map(function (p) { return [p[0], p[1]]; }), tseg, { a1: high ? A1 : TAU, color: function (i, j) { return prof[j][2]; }, uv: uvFn });
    }
    if (tread) {
      tyreLathe(tyre, sideIn, function (i, j) { return [1 - i / tseg, sideIn[j][3]]; });
      tyreLathe(tyre, sideOut, function (i, j) { return [1 - i / tseg, sideOut[j][3]]; });
      // crown: u around (tile = 2 tread widths), v across (0 outer shoulder .. 1 inner)
      var rep = Math.max(1, Math.round(TAU * r / (4 * zt))), tp = [[r, -zt], [r + 0.002, -zt * 0.5], [r + 0.003, 0], [r + 0.002, zt * 0.5], [r, zt]];
      lathe(tread, tp, tseg, { a1: A1, color: function () { return rub; }, uv: function (i, j) { return [i / tseg * rep, clamp01((zt - tp[j][1]) / (2 * zt))]; } });
    } else {
      var prof = sideIn.concat(crown, sideOut);
      tyreLathe(tyre, prof, function (i, j) { return [1 - i / tseg, prof[j][3]]; });   // reads left-to-right on the outer (+Z) wall
    }
    // ---- rim
    var fin = S.wheelFinish, lipPol = D.style === 'mesh' || D.style === 'dish' || D.style === 'split';
    // machined (diamond-cut) outer lip on every design: a bright bare-alloy ring catching the brushed highlight
    var finC = fin.concat([1]), lipC = lipPol ? [0.8, 0.8, 0.82, 1] : [lerp(fin[0], 0.66, 0.7), lerp(fin[1], 0.66, 0.7), lerp(fin[2], 0.68, 0.7), 1], barrel = cscale(fin, 0.35).concat([1]);
    var lipR = rimR + 0.013, zo = tw * 0.43;
    var dish = D.style === 'dish' ? 0.03 + D.concavity * 0.06 : 0;
    var rFace = dish ? rimR * 0.84 : rimR - 0.012;
    var rp = [[lipR, zo - 0.014, lipC], [lipR, zo, lipC], [rimR - 0.004, zo + 0.002, lipC]];
    if (dish) rp.push([rFace, zo + 0.004, lipC], [rFace - 0.004, zo - dish, finC], [rFace - 0.006, zo - dish - 0.012, barrel]);
    else rp.push([rimR - 0.012, zo - 0.012, finC]);
    rp.push([rimR - 0.016, -tw * 0.38, barrel], [lipR - 0.004, -tw * 0.44, barrel]);
    var rseg = high ? 36 : 8;
    lathe(rim, rp.map(function (p) { return [p[0], p[1]]; }), rseg, { color: function (i, j) { return rp[j][2]; } });
    if (!high) return { tyre: tyre, rim: rim, cal: null, tread: null, disc: null };
    // spoke face
    var zFace = zo - 0.004 - dish, rHub = rimR * (D.style === 'centerlock' ? 0.27 : 0.23), conc = D.concavity;
    var depth = 0.025 + conc * 0.065;
    function zAt(rr) { var u = clamp01((rr - rHub) / Math.max(0.01, rFace - rHub)); return zFace - depth * Math.pow(1 - u, 1.35); }
    var zHub = zAt(rHub);
    function spoke(r0, r1, a0, a1, w0, w1, th, ridge, ns, col) {
      var rows = [];
      for (var i = 0; i <= ns; i++) {
        var t = i / ns, rr = lerp(r0, r1, t), a = lerp(a0, a1, t), w = lerp(w0, w1, t);
        var c = [rr * Math.cos(a), rr * Math.sin(a)], tg = [-Math.sin(a), Math.cos(a)], z = zAt(rr) + 0.002;
        rows.push([
          [c[0] - tg[0] * w / 2, c[1] - tg[1] * w / 2, z - th], [c[0] - tg[0] * w / 2, c[1] - tg[1] * w / 2, z],
          [c[0], c[1], z + ridge], [c[0] + tg[0] * w / 2, c[1] + tg[1] * w / 2, z], [c[0] + tg[0] * w / 2, c[1] + tg[1] * w / 2, z - th]
        ]);
      }
      emitGrid(rows, { geo: rim, outward: [0, 0, 1], color: function () { return col || finC; } });
    }
    var N = D.spokes, rOut = rFace + 0.004, k;
    switch (D.style) {
      case 'y':
        for (k = 0; k < N; k++) {
          var a = k / N * TAU, tw2 = 0.12, rMid = lerp(rHub, rOut, 0.42), spread = PI / N * 0.5;
          spoke(rHub * 0.9, rMid, a, a + tw2 * 0.4, 0.05, 0.04, 0.03, 0.006, 3);
          spoke(rMid - 0.01, rOut, a + tw2 * 0.4, a + tw2 - spread, 0.03, 0.022, 0.026, 0.004, 3);
          spoke(rMid - 0.01, rOut, a + tw2 * 0.4, a + tw2 + spread, 0.03, 0.022, 0.026, 0.004, 3);
        }
        break;
      case 'split': {
        var pairs = N >= 10 ? Math.round(N / 2) : N;
        for (k = 0; k < pairs; k++) {
          var a3 = k / pairs * TAU, d = PI / pairs * 0.22;
          spoke(rHub * 0.9, rOut, a3 - d * 0.25, a3 - d, 0.022, 0.016, 0.026, 0.004, 3);
          spoke(rHub * 0.9, rOut, a3 + d * 0.25, a3 + d, 0.022, 0.016, 0.026, 0.004, 3);
        }
        break;
      }
      case 'mesh':
        for (k = 0; k < N / 2; k++) {
          var a4 = k / (N / 2) * TAU;
          spoke(rHub * 0.9, rOut, a4, a4 + 0.35, 0.014, 0.012, 0.02, 0.003, 4);
          spoke(rHub * 0.9, rOut, a4, a4 - 0.35, 0.014, 0.012, 0.02, 0.003, 4);
        }
        break;
      case 'turbine':
        for (k = 0; k < N; k++) {
          var a5 = k / N * TAU, rows = [];
          spokeCurve(a5, 0.55);
        }
        break;
      case 'dish':
        for (k = 0; k < N; k++) { var a6 = k / N * TAU; spoke(rHub * 0.9, rOut, a6, a6, 0.04, 0.03, 0.03, 0.005, 2); }
        if (S.wheelDesign.id === 'beadlock') {
          // bolted beadlock ring
          var ring = [[lipR + 0.006, zo + 0.012], [rimR - 0.01, zo + 0.012]];
          lathe(rim, ring, 28, { color: function () { return [0.15, 0.15, 0.16, 1]; } });
          for (var b = 0; b < 16; b++) { var ab = b / 16 * TAU, rb = rimR + 0.002; box(rim, rb * Math.cos(ab) - 0.005, rb * Math.sin(ab) - 0.005, zo + 0.012, rb * Math.cos(ab) + 0.005, rb * Math.sin(ab) + 0.005, zo + 0.02, [0.75, 0.75, 0.77, 1]); }
        }
        break;
      case 'centerlock':
        for (k = 0; k < N; k++) { var a7 = k / N * TAU; spoke(rHub * 0.9, rOut, a7, a7 + 0.05, 0.03, 0.02, 0.028, 0.005, 3); }
        break;
      case 'aero-disc': {
        var discP = [[rOut, zFace + 0.0], [lerp(rHub, rOut, 0.5), zFace + 0.008], [rHub, zFace + 0.012]];
        lathe(rim, discP, 28, { color: function () { return S.wheelMaterial === 'carbon' ? [0.05, 0.05, 0.055, 1] : finC; } });
        for (k = 0; k < N; k++) { var a8 = k / N * TAU; spoke(rHub, rOut, a8, a8 + 0.5, 0.02, 0.05, 0.004, 0.003, 4, cscale(fin, 0.7).concat([1])); }
        if (N === 0) for (k = 0; k < 18; k++) { var a9 = k / 18 * TAU; spoke(rOut * 0.78, rOut * 0.95, a9, a9 + 0.1, 0.01, 0.014, 0.002, 0.002, 1, [0.02, 0.02, 0.02, 1]); }
        break;
      }
      default: // monoblock
        for (k = 0; k < N; k++) {
          var a10 = k / N * TAU, star = S.wheelDesign.id === 'classic-5';
          spoke(rHub * 0.85, rOut, a10, a10, star ? 0.085 : 0.075, star ? 0.035 : 0.06, 0.035, 0.008, 3);
        }
    }
    function spokeCurve(a0, sweep) {
      var ns = 5, rows2 = [];
      for (var i = 0; i <= ns; i++) {
        var t = i / ns, rr = lerp(rHub * 0.9, rOut, t), a = a0 + sweep * Math.pow(t, 1.2), w = lerp(0.03, 0.055, t);
        var c = [rr * Math.cos(a), rr * Math.sin(a)], tg = [-Math.sin(a), Math.cos(a)], z = zAt(rr) + 0.002;
        var tilt = 0.012;
        rows2.push([[c[0] - tg[0] * w / 2, c[1] - tg[1] * w / 2, z - 0.014], [c[0] - tg[0] * w / 2, c[1] - tg[1] * w / 2, z + tilt], [c[0] + tg[0] * w / 2, c[1] + tg[1] * w / 2, z - tilt], [c[0] + tg[0] * w / 2, c[1] + tg[1] * w / 2, z - 0.026]]);
      }
      emitGrid(rows2, { geo: rim, outward: [0, 0, 1], color: function () { return finC; } });
    }
    // hub + cap
    var hubP = [[rHub, zHub - 0.03], [rHub, zHub + 0.012], [rHub * 0.6, zHub + 0.02], [0, zHub + 0.024]];
    lathe(rim, hubP, 16, { color: function (i, j) { return j >= 2 ? (S.badge === 'chrome' ? [0.55, 0.55, 0.57, 1] : [0.02, 0.02, 0.02, 1]) : cscale(fin, 0.85).concat([1]); } });
    if (D.style === 'centerlock') {
      var nut = [[rHub * 0.62, zHub + 0.01], [rHub * 0.62, zHub + 0.045], [rHub * 0.3, zHub + 0.05], [0, zHub + 0.052]];
      lathe(rim, nut, 6, { color: function () { return [0.75, 0.06, 0.05, 1]; } });
    } else {
      var nl = D.spokes === 6 ? 6 : 5;
      for (k = 0; k < nl; k++) {
        var an = k / nl * TAU + PI / nl, rn = rHub * 0.62, ng = new Geo();
        lathe(ng, [[0.0105, 0], [0.0105, 0.018], [0.006, 0.022], [0, 0.023]], 6, { color: function () { return [0.5, 0.5, 0.52, 1]; } });
        var mn = m4(); mn[12] = rn * Math.cos(an); mn[13] = rn * Math.sin(an); mn[14] = zHub + 0.012;
        rim.append(ng, mn);
      }
    }
    // ---- brake disc (+ hat) — spins with the rim
    var rotor = Math.min(W.rotor, rimR - 0.05), th = 0.03;
    var zD = Math.min(zHub - 0.05, zAt(rotor) - 0.035 - 0.045) - th / 2;
    zD = Math.max(zD, -tw * 0.3);
    var ccm = S.brakeMat === 'carbon-ceramic';
    var discC = ccm ? [0.09, 0.09, 0.095, 1] : [0.33, 0.33, 0.34, 1], slotC = ccm ? [0.05, 0.05, 0.05, 1] : [0.16, 0.16, 0.17, 1];
    var drilled = S.brakeMat === 'drilled-slotted' || S.brakeMat === 'two-piece' || ccm;
    var rIn = rotor * 0.58;
    if (!disc) lathe(rim, [[rIn, zD - th / 2], [rotor, zD - th / 2], [rotor, zD + th / 2], [rIn, zD + th / 2]], 36, {
      color: function (i) { return drilled && i % 3 === 0 ? slotC : discC; }
    });
    // textured: the friction ring is its own part (polar uv = the brakeDisc map, alpha-tested drilled holes)
    if (disc) {
      var ns = 36, rings = [rIn * 0.97, lerp(rIn, rotor, 0.5), rotor], kU = 0.4925 / rotor;
      [[zD + th / 2, 1], [zD - th / 2, -1]].forEach(function (fc) {
        var b0 = disc.verts();
        for (var s = 0; s <= ns; s++) {
          var a = s / ns * TAU, ca = Math.cos(a), sa = Math.sin(a);
          rings.forEach(function (rr) { disc.vert(rr * ca, rr * sa, fc[0], 0, 0, fc[1], 0.5 + rr * ca * kU, 0.5 - rr * sa * kU, WHITE); });
        }
        for (s = 0; s < ns; s++) for (var q = 0; q < 2; q++) {
          var v = b0 + s * 3 + q;
          if (fc[1] > 0) disc.quad(v, v + 3, v + 4, v + 1); else disc.quad(v, v + 1, v + 4, v + 3);
        }
      });
      // outer edge band (dark machined steel)
      var eb = disc.verts();
      for (var s2 = 0; s2 <= ns; s2++) {
        var a2 = s2 / ns * TAU, c2 = Math.cos(a2), s3 = Math.sin(a2);
        disc.vert(rotor * c2, rotor * s3, zD - th / 2, c2, s3, 0, 0.5 + 0.495 * c2, 0.5 - 0.495 * s3, WHITE);
        disc.vert(rotor * c2, rotor * s3, zD + th / 2, c2, s3, 0, 0.5 + 0.495 * c2, 0.5 - 0.495 * s3, WHITE);
      }
      for (s2 = 0; s2 < ns; s2++) { var e0 = eb + s2 * 2; disc.quad(e0, e0 + 2, e0 + 3, e0 + 1); }
    }
    lathe(rim, [[rIn, zD + th / 2], [rIn * 0.92, zHub - 0.02], [0.02, zHub - 0.02]], 16, { color: function () { return ccm ? cscale(S.caliper, 0.4).concat([1]) : [0.22, 0.22, 0.23, 1]; } });
    // ---- caliper (does not spin)
    var pist = isFront ? S.front.pistons : S.rear.pistons;
    var span = (pist >= 8 ? 70 : pist >= 6 ? 58 : pist >= 4 ? 46 : 34) * DEG;
    var ac = isFront ? PI * 0.88 : PI * 0.12, r0c = rotor - 0.055, r1c = Math.min(rotor + 0.022, rimR - 0.022);
    var z0c = zD - th / 2 - 0.028, z1c = Math.min(zD + th / 2 + 0.034, zAt(r1c) - 0.006);
    var cp = [[r0c, z1c], [r1c, z1c], [r1c, z0c], [r0c, z0c], [r0c, z1c]];
    // textured (caliper map: painted body, bevels, lettering on the outboard face): white vertex colour, the map's
    // colour is the build's caliper colour; plain: vertex colour + a logo plate
    var calC = S.hasTex ? WHITE : S.caliper.concat([1]), cseg = 10, cv = [1, 0, 0, 1, 1];
    lathe(cal, cp, cseg, { a0: ac - span / 2, a1: ac + span / 2, color: function () { return calC; }, uv: function (i, j) { return [i / cseg, cv[j]]; } });
    [ac - span / 2, ac + span / 2].forEach(function (aa, e) {
      var ca = Math.cos(aa), sa = Math.sin(aa), b2 = cal.verts(), nx = -sa * (e ? -1 : 1), ny = ca * (e ? -1 : 1);
      cp.slice(0, 4).forEach(function (p, j) { cal.vert(p[0] * ca, p[0] * sa, p[1], -nx, -ny, 0, e ? 0.98 : 0.02, cv[j] * 0.9 + 0.05, calC); });
      if (e) cal.quad(b2, b2 + 1, b2 + 2, b2 + 3); else cal.quad(b2, b2 + 3, b2 + 2, b2 + 1);
    });
    if (!S.hasTex) {     // caliper logo plate
      var la = ac, lr = (r0c + r1c) / 2;
      box(cal, lr * Math.cos(la) - 0.03, lr * Math.sin(la) - 0.012, z1c, lr * Math.cos(la) + 0.03, lr * Math.sin(la) + 0.012, z1c + 0.002, luma(S.caliper) > 0.3 ? [0.02, 0.02, 0.02, 1] : [0.9, 0.9, 0.9, 1], null);
    }
    return { tyre: tyre, rim: rim, cal: cal, tread: tread && tread.tris() ? tread : null, disc: disc && disc.tris() ? disc : null };
  }

  /* ================================================================ low LOD */
  function buildLow(S, G) {
    var xs = [S.xF, S.xF - S.rN * 0.45, S.xF - S.rN, S.xFA + S.front.Ra, S.xFA, S.xFA - S.front.Ra, (S.xFA + S.xRA) / 2, S.xRA + S.rear.Ra, S.xRA, S.xRA - S.rear.Ra, S.xR + S.rT, S.xR + S.rT * 0.45, S.xR];
    xs.sort(function (a, b) { return b - a; });
    var rows = [];
    xs.forEach(function (x) {
      var p = ringLow(S, x), n = p.length, row = [];
      for (var j = 0; j < n; j++) row.push([x, p[j][1], p[j][0]]);
      for (j = n - 2; j >= 1; j--) row.push([x, p[j][1], -p[j][0]]);
      rows.push(row);
    });
    var under = [0.015, 0.015, 0.016, 1], glassC = [0.025, 0.03, 0.04, 1];
    emitGrid(rows, {
      wrapJ: true, flip: true, geos: G,
      bucket: function () { return 'paint'; },
      color: function (k, i, j) { return (j === 0 || j === 1 || j === 7) ? under : S.paintRGBA; }
    });
    // greenhouse
    if (!S.openTop) {
      var gx = [S.xA, S.xR0, S.xR1, S.xC], grows = [];
      gx.forEach(function (x) {
        var g = ghInfo(S, x);
        grows.push([[x, g.yb, g.zb], [x, g.yb + g.h, g.gzr], [x, g.yb + g.h + g.gc, 0], [x, g.yb + g.h, -g.gzr], [x, g.yb, -g.zb]]);
      });
      emitGrid(grows, {
        flip: true, geos: G, bucket: function () { return 'paint'; },
        color: function (k, i, j) {
          var zone = i === 0 ? 'ws' : i === 1 ? 'roof' : 'rear';
          if (j === 2 && zone === 'roof') return S.roof === 'glass' ? glassC : S.roof === 'carbon' ? [0.03, 0.03, 0.035, 1] : S.roofColor.concat([1]);
          return glassC;
        }
      });
      // opaque roof panel (vertex colours interpolate, so the roof gets its own few quads just above the glass shell)
      if (S.roof !== 'glass') {
        var rc = S.roof === 'carbon' ? [0.03, 0.03, 0.035, 1] : S.roofColor.concat([1]), rrows = [];
        [S.xR0 + 0.02, S.xR1 - 0.02].forEach(function (x) {
          var g = ghInfo(S, x), y = g.yb + g.h;
          rrows.push([[x, y - 0.01, g.gzr * 1.02], [x, y + g.gc * 0.75 + 0.006, g.gzr * 0.5], [x, y + g.gc + 0.006, 0], [x, y + g.gc * 0.75 + 0.006, -g.gzr * 0.5], [x, y - 0.01, -g.gzr * 1.02]]);
        });
        emitGrid(rrows, { outward: [0, 1, 0], geos: G, bucket: function () { return 'paint'; }, color: function () { return rc; } });
      }
    } else {
      var xw = S.xA - 0.05, R = ringInfo(S, xw), y0 = R.yE, z = R.hwT * 0.85;
      var b = G.paint.verts();
      G.paint.vert(S.xA, y0, -z, 0.6, 0.8, 0, 0, 0, glassC); G.paint.vert(S.xA, y0, z, 0.6, 0.8, 0, 0, 0, glassC);
      G.paint.vert(S.xR0, S.roofY, z * 0.9, 0.6, 0.8, 0, 0, 0, glassC); G.paint.vert(S.xR0, S.roofY, -z * 0.9, 0.6, 0.8, 0, 0, 0, glassC);
      G.paint.quad(b, b + 1, b + 2, b + 3);
    }
    // wing as a slab
    if (S.wing && S.wing !== 'ducktail' && S.wing !== 'lip-spoiler') {
      var wx = S.xR + 0.3, wy = (topAt(S, wx, 0) || S.deckY) + (S.wing === 'active' ? 0.13 : 0.26);
      box(G.paint, wx - 0.3, wy - 0.02, -S.W * 0.44, wx, wy + 0.02, S.W * 0.44, [0.03, 0.03, 0.035, 1]);
    }
    // lights: simple quads
    var hl = [], bl = [];
    [-1, 1].forEach(function (sd) {
      var y = S.noseY - 0.055, x = cast(S, [S.xF + 0.3, y, sd * S.hw * 0.62], [-1, 0, 0], 1.2) || [S.xF - 0.05, y, sd * S.hw * 0.62];
      var bh = G.head.verts();
      G.head.vert(x[0] + 0.012, y - 0.03, sd * S.hw * 0.42, 1, 0, 0, 0, 0, WHITE); G.head.vert(x[0] + 0.012, y - 0.03, sd * S.hw * 0.8, 1, 0, 0, 0, 0, WHITE);
      G.head.vert(x[0] + 0.006, y + 0.03, sd * S.hw * 0.8, 1, 0, 0, 0, 0, WHITE); G.head.vert(x[0] + 0.006, y + 0.03, sd * S.hw * 0.42, 1, 0, 0, 0, 0, WHITE);
      if (sd > 0) G.head.quad(bh, bh + 1, bh + 2, bh + 3); else G.head.quad(bh, bh + 3, bh + 2, bh + 1);
      hl.push([x[0], y, sd * S.hw * 0.62]);
      var yt = Math.min(S.deckY, edgeY(S, S.xR + 0.05)) - 0.08, xt = cast(S, [S.xR - 0.3, yt, sd * S.hw * 0.7], [1, 0, 0], 1.2) || [S.xR + 0.05, yt, 0];
      var bb = G.brake.verts();
      G.brake.vert(xt[0] - 0.012, yt - 0.035, sd * S.hw * 0.5, -1, 0, 0, 0, 0, WHITE); G.brake.vert(xt[0] - 0.012, yt - 0.035, sd * S.hw * 0.88, -1, 0, 0, 0, 0, WHITE);
      G.brake.vert(xt[0] - 0.012, yt + 0.035, sd * S.hw * 0.88, -1, 0, 0, 0, 0, WHITE); G.brake.vert(xt[0] - 0.012, yt + 0.035, sd * S.hw * 0.5, -1, 0, 0, 0, 0, WHITE);
      if (sd > 0) G.brake.quad(bb, bb + 3, bb + 2, bb + 1); else G.brake.quad(bb, bb + 1, bb + 2, bb + 3);
      bl.push([xt[0], yt, sd * S.hw * 0.7]);
    });
    return { headlights: hl, brakeLights: bl };
  }
  function lowWheels(S, geo) {
    [S.front, S.rear].forEach(function (W) {
      [-1, 1].forEach(function (sd) {
        var g = new Geo(), n = 8, rows = [], rr = W.r / Math.cos(PI / 8);
        var zo = W.tw / 2, zi = -W.tw / 2;
        for (var k = 0; k < n; k++) { var a = (k + 0.5) / n * TAU, c = Math.cos(a) * rr, s = Math.sin(a) * rr; rows.push([[c, s, zi], [c, s, zo]]); }
        emitGrid(rows, { geo: g, wrapI: true, outward: null, color: function () { return [0.03, 0.03, 0.033, 1]; } });
        // outer face (rim colour)
        var b = g.verts(), rc = S.wheelFinish.concat([1]);
        g.vert(0, 0, zo, 0, 0, 1, 0, 0, rc);
        for (k = 0; k < n; k++) { var a2 = (k + 0.5) / n * TAU; g.vert(Math.cos(a2) * W.r * 0.97, Math.sin(a2) * W.r * 0.97, zo + 0.002, 0, 0, 1, 0, 0, k % 2 ? rc : cscale(S.wheelFinish, 0.6).concat([1])); }
        for (k = 0; k < n - 2; k++) g.tri(b + 1, b + 2 + k, b + 3 + k);
        var m = m4();
        if (sd < 0) m[10] = -1;
        m[12] = W.x; m[13] = W.r; m[14] = sd * S.track / 2;
        geo.append(g, m);
      });
    });
  }

  /* ================================================================ materials */
  function material(o) {
    var c = o.color || [1, 1, 1, 1];
    if (c.length === 3) c = [c[0], c[1], c[2], 1];
    var m = {
      baseColor: c, color: c, metallic: num(o.metallic, 0), roughness: num(o.roughness, 0.7), clearcoat: num(o.clearcoat, 0),
      flake: num(o.flake, 0), hueShift: num(o.hueShift, 0), emissive: o.emissive || [0, 0, 0], transparent: !!o.transparent,
      opacity: c[3], unlit: !!o.unlit, doubleSided: !!o.doubleSided, name: o.name || ''
    };
    if (o.alphaTest) m.alphaTest = o.alphaTest;
    if (o.polygonOffset) m.polygonOffset = o.polygonOffset;
    if (o.transparent) m.depthWrite = false;
    m.uBaseColor = m.baseColor; m.uMetallic = m.metallic; m.uRoughness = m.roughness; m.uClearcoat = m.clearcoat;
    m.uEmissive = m.emissive; m.uFlake = m.flake; m.uHueShift = m.hueShift; m.useMap = 0; m.uUseMap = 0;
    return m;
  }
  function setMap(m, tex) { if (!tex) return; m.map = tex; m.uMap = tex; m.useMap = 1; m.uUseMap = 1; }
  // clear-coat gloss per paint finish (the coat's own roughness: candy / pearl deepest, satin a soft sheen)
  var COAT_ROUGH = { solid: 0.04, metallic: 0.035, pearl: 0.03, matte: 0.5, satin: 0.22, chrome: 0.05, candy: 0.025, chameleon: 0.03 };
  function buildMaterials(S) {
    var F = S.finish, gl = S.glassType;
    var tintA = lerp(0.5, 0.93, S.tint), tintC = lerp(0.07, 0.008, S.tint);
    var rimMat = { cast: [0.85, 0.32], 'flow-formed': [0.88, 0.28], forged: [0.92, 0.22], magnesium: [0.8, 0.36], steel: [0.7, 0.45], carbon: [0.15, 0.3] }[S.wheelMaterial] || [0.85, 0.3];
    // rim finish: bright silver / grey reads as machined (brushed) alloy; dark or coloured finishes are painted
    // (dielectric base under a clear coat; metallic paints keep a little metalness)
    var wf = S.wheelFinish, wl = luma(wf), wsat = Math.max(wf[0], wf[1], wf[2]) - Math.min(wf[0], wf[1], wf[2]);
    var rimO = { name: 'rim', metallic: rimMat[0], roughness: rimMat[1], clearcoat: 0.2 };
    if (S.wheelMaterial === 'carbon') rimO = { name: 'rim', metallic: rimMat[0], roughness: rimMat[1], clearcoat: 1, clearcoatRoughness: 0.04 };
    else if (wl < 0.12 || wsat > 0.12) rimO = { name: 'rim', metallic: wsat > 0.12 && wl > 0.05 ? 0.45 : 0.15, roughness: wl < 0.02 ? 0.42 : 0.3, clearcoat: 1, clearcoatRoughness: 0.06 };
    var paint = material({ name: 'paint', metallic: F.m, roughness: F.r, clearcoat: F.cc, flake: F.fl, hueShift: F.hue });
    paint.clearcoatRoughness = COAT_ROUGH[S.finishId] || 0.035;
    var roof = material({ name: 'roof', metallic: S.roof === 'contrast' ? F.m : 0.2, roughness: S.roof === 'contrast' ? F.r : 0.15, clearcoat: 1 });
    roof.clearcoatRoughness = 0.035;
    var rim = material(rimO);
    if (rimO.clearcoatRoughness) rim.clearcoatRoughness = rimO.clearcoatRoughness;
    // bare machined / forged alloy: lathe-turned micro grooves -> anisotropic highlight circling the hub
    if (rimO.clearcoat < 0.5 && S.wheelMaterial !== 'carbon') { rim.anisotropy = S.wheelMaterial === 'steel' ? 0.3 : 0.55; rim.anisoAxis = [0, 0, 1, 1]; }
    var glass = material({ name: 'glass', color: [tintC, tintC * 1.08, tintC * 1.2, tintA], roughness: gl === 'polycarbonate' ? 0.12 : 0.03, metallic: 0.1, clearcoat: 1, transparent: true, doubleSided: true });
    glass.materialType = 'glass';
    var caliper = material({ name: 'caliper', roughness: 0.32, metallic: 0.1, clearcoat: 0.9 });
    // headlamp cover: thin clear polycarbonate (glass shading: two-interface Fresnel, reflections raise coverage)
    // (dark tint, low base alpha: a light tint scatters the ambient into a milky film over the lamp interior)
    var lens = material({ name: 'glass-lens', color: [0.02, 0.021, 0.024, 0.06], roughness: 0.02, metallic: 0, clearcoat: 1, transparent: true });
    lens.materialType = 'glass'; lens.envIntensity = 0.85;
    caliper.clearcoatRoughness = 0.08;
    return {
      paint: paint, roof: roof, glass: glass, lens: lens,
      trim: material({ name: 'trim', roughness: 0.55, metallic: 0.05, clearcoat: 0.12 }),
      carbon: material({ name: 'carbon', color: [0.06, 0.06, 0.065, 1], roughness: 0.32, metallic: 0.15, clearcoat: 1 }),
      chrome: material({ name: 'chrome', metallic: 1, roughness: 0.08, clearcoat: 0.3 }),
      head: material({ name: 'light-head', roughness: 0.08, metallic: 0.85, clearcoat: 1, emissive: [0, 0, 0], alphaTest: 0.5 }),
      brake: material({ name: 'light-brake', roughness: 0.12, metallic: 0.2, clearcoat: 1, emissive: [0, 0, 0], alphaTest: 0.5 }),
      rev: material({ name: 'light-rev', roughness: 0.12, metallic: 0.4, clearcoat: 1, emissive: [0, 0, 0], alphaTest: 0.5 }),
      drl: material({ name: 'light-drl', roughness: 0.1, metallic: 0, clearcoat: 1, emissive: [0, 0, 0], alphaTest: 0.5 }),
      grille: material({ name: 'grille', roughness: 0.5, metallic: 0.1, clearcoat: 0.1 }),
      interior: material({ name: 'interior', roughness: 0.85, metallic: 0 }),
      driver: material({ name: 'driver', roughness: 0.35, metallic: 0.1, clearcoat: 0.8 }),
      decal: material({ name: 'decal', roughness: 0.3, clearcoat: 1, alphaTest: 0.5, polygonOffset: [-1, -2] }),
      // number plate (textured plates only): semi-gloss laminated plate, the albedo lives in the map (~0.62 linear)
      plate: material({ name: 'plate', roughness: 0.35, metallic: 0, clearcoat: 0.5 }),
      tyre: material({ name: 'tyre', color: [0.66, 0.66, 0.66, 1], roughness: 0.9, metallic: 0 }),
      tread: material({ name: 'tyre-tread', roughness: 0.92, metallic: 0 }),
      disc: (function () { var d = material({ name: 'brake-disc', roughness: 0.5, metallic: 0.9, alphaTest: 0.5 }); d.anisotropy = 0.6; d.anisoAxis = [0, 0, 1, 1]; return d; })(),
      rim: rim,
      caliper: caliper,
      wing: material({ name: 'wing', color: [0.06, 0.06, 0.065, 1], roughness: 0.32, metallic: 0.15, clearcoat: 1 }),
      wheelsLow: material({ name: 'wheels', roughness: 0.6, metallic: 0.3 })
    };
  }

  /* ================================================================ real manufacturer models (CB.shapes) */
  // When js/shapes/ is loaded, the body is the fitted, lofted production-car shape (build.body.model or the style
  // default; AI opponents without an explicit model get a deterministic per-opponent model of their style). Lights,
  // grilles, intakes, plates, trims and markers are the model's 2D view items projected onto the loft as decals;
  // mirrors and exhaust tips come from the model's plan/rear views. S.shape (a section sampler) makes the analytic
  // surface queries (insideCar / topAt / sideAt / floorY / halfW / edgeY / ghInfo) answer on the real body, so the
  // build-driven aero (splitter, diffuser, skirts, canards, wings), stripes and number roundels mount on its surface.
  // Without CB.shapes (or a model for the style) the procedural loft above is used unchanged.
  var MIRROR_Z = (function () { var mm = new Float32Array(16); mm[0] = mm[5] = mm[15] = 1; mm[10] = -1; return mm; })();
  function shapeLib() { var SH = CB.shapes; return SH && typeof SH.getModel === 'function' && typeof SH.fit === 'function' && typeof SH.loftToMesh === 'function' ? SH : null; }
  function modelIdHash(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0; return h; }
  /** the CB.shapes model for a build (null = procedural). Explicit body.model must match the body style. */
  function shapeModelFor(build, opts) {
    opts = opts || {};
    var SH = shapeLib();
    if (!SH || opts.shapes === false || opts.realModel === false) return null;
    var body = (build && typeof build === 'object' && build.body) || {};
    var style = String(body.style || body.type || opts.bodyStyle || 'coupe');
    if (!STYLE[style]) style = 'coupe';
    try {
      var reg = SH.models || {}, m = body.model && reg[body.model];
      if (m && m.style === style) return m;
      if (!body.model && opts.isPlayer === false && (opts.id != null || opts.number != null)) {
        var list = (typeof SH.modelsByStyle === 'function' && SH.modelsByStyle(style)) || [];
        if (list.length) return list[modelIdHash(opts.id != null ? opts.id : opts.number) % list.length];
      }
      return SH.getModel({ body: { style: style } }) || null;
    } catch (e) { return null; }
  }
  function shapeBounds(SH, slot) {
    var it = SH.items(slot || null).filter(function (i) { return i && i.path; });
    if (!it.length) return null;
    var b = SH.bounds(it.map(function (i) { return i.path; }));
    return b && !b.empty && isFinite(b.minX) ? b : null;
  }
  /** section sampler: half rings as [z, y] (bottom centre -> roof centre) at shifted stations */
  function shapeSampler(secs, dx) {
    var N = secs[0].ring.length, H = N >> 1, xs = [], half = [];
    secs.forEach(function (s) {
      var hr = [];
      for (var j = 0; j <= H; j++) { var q = s.ring[j % N]; hr.push([Math.max(0, q[1]), q[0]]); }
      xs.push(s.x + dx); half.push(hr);
    });
    var n = xs.length, tmp = [];
    for (var t = 0; t <= H; t++) tmp.push([0, 0]);
    function ringAt(x) {
      if (!(x >= xs[0] && x <= xs[n - 1])) return null;
      var lo = 0, hi = n - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (xs[mid] > x) hi = mid; else lo = mid; }
      var a = half[lo], b = half[hi], d = xs[hi] - xs[lo], u = d > 1e-9 ? (x - xs[lo]) / d : 0;
      for (var j = 0; j <= H; j++) { tmp[j][0] = a[j][0] + (b[j][0] - a[j][0]) * u; tmp[j][1] = a[j][1] + (b[j][1] - a[j][1]) * u; }
      return tmp;
    }
    var api = {
      xs: xs, half: half, N: N, x0: xs[0], x1: xs[n - 1],
      ringAt: ringAt,
      inside: function (x, y, z) { var r = ringAt(x); return !!r && inPoly(r, z, y); },
      top: function (x, z) { var r = ringAt(x); return r ? polyDown(r, z) : null; },
      side: function (x, y) { var r = ringAt(x); return r ? polyOut(r, y) : null; },
      bottom: function (x) {
        var r = ringAt(clamp(x, xs[0] + 0.12, xs[n - 1] - 0.12)), m = Infinity;
        if (!r) return null;
        for (var j = 0; j <= H; j++) if (r[j][1] < m) m = r[j][1];
        return m;
      },
      halfW: function (x) { var r = ringAt(x), m = 0; if (!r) return 0; for (var j = 0; j <= H; j++) if (r[j][0] > m) m = r[j][0]; return m; },
      /** outward unit surface normal at a (near-)surface point: gradient of the slice signed distance */
      normal: function (x, y, z, eps) {
        var e = eps || 0.008, az = Math.abs(z), sz = z < 0 ? -1 : 1;
        function d(xx, zz, yy) { var r = ringAt(xx); return r ? sliceDist(r, Math.abs(zz), yy) : null; }
        var d0 = d(x, az, y);
        if (d0 === null) return null;
        var xp = d(x + e, az, y), xm = d(x - e, az, y);
        if (xp === null) xp = d0 + e; if (xm === null) xm = d0 + e;
        var gx = (xp - xm) / (2 * e), gy = (d(x, az, y + e) - d(x, az, y - e)) / (2 * e), gz = (d(x, az + e, y) - d(x, az - e, y)) / (2 * e);
        var l = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (!(l > 1e-6)) return null;
        return [gx / l, gy / l, gz / l * sz];
      },
      /** first body x hit by a ray along x at (y, z): dir -1 = from ahead of the nose, +1 = from behind the tail */
      castX: function (y, z, dir, lim) {
        var i, start = dir < 0 ? n - 1 : 0, step = dir < 0 ? -1 : 1;
        for (i = start; i >= 0 && i < n; i += step) {
          if (!inPoly(half[i], z, y)) { if (lim != null && (dir < 0 ? xs[i] < lim : xs[i] > lim)) return null; continue; }
          if (i === start) return xs[i];
          var aX = xs[i - step], bX = xs[i];     // aX outside, bX inside
          for (var k = 0; k < 10; k++) { var m = (aX + bX) / 2, r = ringAt(m); if (r && inPoly(r, z, y)) bX = m; else aX = m; }
          return (aX + bX) / 2;
        }
        return null;
      },
      /** castX limited to `depth` metres behind the bumper extreme; points outside the silhouette there are wrapped
          onto the nearest flank (corner-wrapping lamps) instead of landing on a fender far up the body */
      projX: function (y, z, dir, depth) {
        var end = dir < 0 ? xs[n - 1] : xs[0], lim = end + dir * (depth || 0.75), x = api.castX(y, z, dir, lim - dir * 0.05);
        if (x !== null && (dir < 0 ? x >= lim : x <= lim)) return [x, y, z];
        var best = -1, cand = [], i;
        for (i = dir < 0 ? n - 1 : 0; i >= 0 && i < n && (dir < 0 ? xs[i] >= lim : xs[i] <= lim); i += dir < 0 ? -1 : 1) {
          var zs = polyOut(half[i], y);
          cand.push([i, zs === null ? -1 : zs]);
          if (zs !== null && zs > best) best = zs;
        }
        if (!cand.length) return null;
        if (best <= 0.02) return null;     // above the tail / nose at this height: no upright surface (never smear onto the hood / deck)
        if (Math.abs(z) > best + 0.05) return null;     // well outside the silhouette at this height: no wrap (no torn spikes)
        for (i = 0; i < cand.length; i++) if (cand[i][1] >= Math.min(Math.abs(z), best) - 0.004) break;
        var c = cand[Math.min(i, cand.length - 1)], zc = Math.max(0, Math.min(Math.abs(z), c[1] - 0.002));
        return [xs[c[0]], y, z < 0 ? -zc : zc];
      },
      /** lamp projection: castX limited to `depth`; where the ray grazes past that limit (lamps on a fender crown /
          a wrapped corner) the point is re-projected onto the body at the limit station, from above (top surface)
          or from the side (flank), instead of smearing along the panel or tearing round the corner */
      projXL: function (y, z, dir, depth) {
        var end = dir < 0 ? xs[n - 1] : xs[0], lim = end + dir * depth, x = api.castX(y, z, dir, lim - dir * 0.02);
        if (x !== null && (dir < 0 ? x >= lim : x <= lim)) return [x, y, z];
        // only re-project points that lie near the surface there: a point far above the crown / beyond the flank is
        // outside the body silhouette in this view, and dropping it onto the surface would tear a spike
        var ty = api.top(lim, Math.abs(z));
        if (ty !== null && y - ty > 0.05) {      // above the crown at the limit: the lamp sits further back on the panel
          var lim2 = end + dir * Math.min(1.2, depth * 2.5), x2 = api.castX(y, z, dir, lim2);
          return x2 !== null && (dir < 0 ? x2 >= lim2 : x2 <= lim2) ? [x2, y, z] : null;
        }
        if (ty !== null && y >= ty - 0.03) return [lim, ty, z];
        var zs = api.side(lim, y);
        if (zs !== null && zs > 0.02) { var zc = Math.min(Math.abs(z), zs); return [lim, y, z < 0 ? -zc : zc]; }     // wrapped corner
        return null;
      }
    };
    return api;
  }
  /** signed distance from (z, y) to a one-side half ring (closed along z = 0); negative inside */
  function sliceDist(r, z, y) {
    var best = Infinity;
    for (var j = 0; j < r.length - 1; j++) {
      var ax = r[j][0], ay = r[j][1], ex = r[j + 1][0] - ax, ey = r[j + 1][1] - ay, l2 = ex * ex + ey * ey;
      var t = l2 > 1e-12 ? clamp01(((z - ax) * ex + (y - ay) * ey) / l2) : 0, qx = z - ax - ex * t, qy = y - ay - ey * t, dd = qx * qx + qy * qy;
      if (dd < best) best = dd;
    }
    best = Math.sqrt(best);
    return inPoly(r, z, y) ? -best : best;
  }
  function earClip(P) {
    var n = P.length, idx = [], out = [], i;
    if (n < 3) return out;
    for (i = 0; i < n; i++) idx.push(i);
    var area = 0;
    for (i = 0; i < n; i++) { var p = P[i], q = P[(i + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
    var sg = area >= 0 ? 1 : -1;
    function cr(a, b, c) { return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * sg; }
    var guard = 0;
    while (idx.length > 3 && guard++ < 4000) {
      var m = idx.length, found = false;
      for (var k = 0; k < m; k++) {
        var ia = idx[(k + m - 1) % m], ib = idx[k], ic = idx[(k + 1) % m], A = P[ia], B = P[ib], C = P[ic];
        if (cr(A, B, C) <= 1e-12) continue;
        var ok = true;
        for (var t = 0; t < m && ok; t++) {
          var it = idx[t];
          if (it === ia || it === ib || it === ic) continue;
          var X = P[it];
          if ((X[0] === A[0] && X[1] === A[1]) || (X[0] === B[0] && X[1] === B[1]) || (X[0] === C[0] && X[1] === C[1])) continue;     // hole-bridge duplicates
          if (cr(A, B, X) >= 0 && cr(B, C, X) >= 0 && cr(C, A, X) >= 0) ok = false;
        }
        if (!ok) continue;
        out.push([ia, ib, ic]); idx.splice(k, 1); found = true; break;
      }
      if (!found) { for (k = 1; k < idx.length - 1; k++) out.push([idx[0], idx[k], idx[k + 1]]); idx = []; break; }
    }
    if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
    return out;
  }
  /** Lawson edge flips on an ear-clipped polygon triangulation (constrained: outline edges stay) -> near-Delaunay
      triangles instead of the long fans of slivers ear-clipping leaves (far fewer subdivisions afterwards) */
  function flipImprove(P, T) {
    function ccw(a, b, c) { return (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]); }
    function inCircle(a, b, c, d) {      // d inside the circumcircle of the ccw triangle a b c
      var ax = P[a][0] - P[d][0], ay = P[a][1] - P[d][1], bx = P[b][0] - P[d][0], by = P[b][1] - P[d][1], cx = P[c][0] - P[d][0], cy = P[c][1] - P[d][1];
      return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay) > 1e-14;
    }
    var i, t, k;
    for (t = 0; t < T.length; t++) if (ccw(T[t][0], T[t][1], T[t][2]) < 0) { k = T[t][1]; T[t][1] = T[t][2]; T[t][2] = k; }
    for (var pass = 0; pass < 8; pass++) {
      var edges = {}, flipped = 0;
      for (t = 0; t < T.length; t++) for (i = 0; i < 3; i++) {
        var a = T[t][i], b = T[t][(i + 1) % 3], key = a < b ? a + '_' + b : b + '_' + a;
        (edges[key] = edges[key] || []).push(t);
      }
      for (var e in edges) {
        var ts = edges[e];
        if (ts.length !== 2) continue;
        var t1 = T[ts[0]], t2 = T[ts[1]], ab = e.split('_').map(Number), A = ab[0], B = ab[1];
        var c = t1[0] !== A && t1[0] !== B ? t1[0] : t1[1] !== A && t1[1] !== B ? t1[1] : t1[2];
        var d = t2[0] !== A && t2[0] !== B ? t2[0] : t2[1] !== A && t2[1] !== B ? t2[1] : t2[2];
        if (c === d || (t1.indexOf(A) < 0 || t1.indexOf(B) < 0 || t2.indexOf(A) < 0 || t2.indexOf(B) < 0)) continue;   // stale after an earlier flip
        // orient so (A, B, c) is ccw
        if (ccw(A, B, c) < 0) { var q = A; A = B; B = q; }
        if (!inCircle(A, B, c, d)) continue;
        if (ccw(c, d, B) <= 1e-14 || ccw(d, c, A) <= 1e-14) continue;       // quad not convex: flip would fold
        T[ts[0]] = [c, A, d]; T[ts[1]] = [d, B, c];
        if (ccw(c, A, d) < 0) T[ts[0]] = [c, d, A];
        if (ccw(d, B, c) < 0) T[ts[1]] = [d, c, B];
        flipped++;
      }
      if (!flipped) break;
    }
    return T;
  }
  /** ear-clip + Lawson flips, unless the flips change the covered area (self-overlapping / double-loop outlines,
      whose nonzero fill only the plain ear-clip keeps): then the ear-clip triangles are used as they are */
  function flipSafe(P) {
    var E = earClip(P);
    function area(T) {
      var s = 0;
      for (var i = 0; i < T.length; i++) { var A = P[T[i][0]], B = P[T[i][1]], C = P[T[i][2]]; s += Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])); }
      return s;
    }
    var a0 = area(E), F = flipImprove(P, E.map(function (t) { return t.slice(); }));
    return Math.abs(area(F) - a0) <= a0 * 0.005 + 1e-9 ? F : E;
  }
  /** closed polygons ([a, b] point lists) of a view path */
  function shapePolys(SH, path, steps, maxE, tol, strokeW) {
    var out = [];
    try {
      SH.flatten(path, steps || 5).forEach(function (pl) {
        var pts = [];
        (pl.pts || []).forEach(function (q) {
          var l = pts[pts.length - 1];
          if (!l || Math.abs(l[0] - q[0]) + Math.abs(l[1] - q[1]) > 1e-5) pts.push([q[0], q[1]]);
        });
        if (pl.closed === false && strokeW !== 0) {      // open polyline (shut / panel / trim line): a thin stroke ribbon, never a filled crack
          if (pts.length >= 2) { var rb = strokeRibbon(pts, strokeW || 0.004); if (rb) out.push(densify(rb, maxE || 0.12)); }
          return;
        }
        if (pts.length > 3) { var f0 = pts[0], fl = pts[pts.length - 1]; if (Math.abs(f0[0] - fl[0]) + Math.abs(f0[1] - fl[1]) < 1e-5) pts.pop(); }
        if (pts.length >= 3) out.push(densify(dpSimplify(pts, tol || 0.003), maxE || 0.12));
      });
    } catch (e) { /* malformed path: skip */ }
    out = out.filter(function (q) { return q.length >= 3; });
    return out.length > 1 ? bridgeHoles(out) : out;
  }
  function polyArea(p) { var a = 0; for (var i = 0; i < p.length; i++) { var q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; }
  /** view-plane bounds of a point list in the SH.bounds shape ({minX, maxX, minY, maxY, w, h}) */
  function polyBounds(p) {
    var b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    p.forEach(function (q) { b.minX = Math.min(b.minX, q[0]); b.maxX = Math.max(b.maxX, q[0]); b.minY = Math.min(b.minY, q[1]); b.maxY = Math.max(b.maxY, q[1]); });
    b.w = b.maxX - b.minX; b.h = b.maxY - b.minY;
    return b;
  }
  function ptInPoly(pt, poly) {
    var c = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) { var p = poly[i], q = poly[j]; if ((p[1] > pt[1]) !== (q[1] > pt[1]) && pt[0] < (q[0] - p[0]) * (pt[1] - p[1]) / (q[1] - p[1]) + p[0]) c = !c; }
    return c;
  }
  /** contours of one path lying wholly inside another (a chrome horseshoe round its grille, lamp rings) are holes
      (SVG even-odd look): bridged into the outer contour so ear-clipping leaves them open. A bridge whose
      triangulation does not cover |outer| - |hole| is discarded (contours kept as separate fills, as before). */
  function bridgeHoles(polys) {
    var list = polys.map(function (q) { return { q: q, a: Math.abs(polyArea(q)) }; }).sort(function (u, v) { return v.a - u.a; }), res = [];
    list.forEach(function (h) {
      for (var k = 0; k < res.length; k++) {
        var o = res[k];
        if (o.a <= h.a || !h.q.every(function (p) { return ptInPoly(p, o.q0 || o.q); })) continue;
        var hq = h.q.slice(), oq = o.q;
        if ((polyArea(hq) > 0) === (polyArea(oq) > 0)) hq.reverse();
        var j = 0, i, bi = 0, bd = Infinity;
        for (i = 1; i < hq.length; i++) if (hq[i][0] > hq[j][0]) j = i;
        for (i = 0; i < oq.length; i++) { var d = Math.hypot(oq[i][0] - hq[j][0], oq[i][1] - hq[j][1]); if (d < bd) { bd = d; bi = i; } }
        var m = oq.slice(0, bi + 1);
        for (i = 0; i <= hq.length; i++) m.push(hq[(j + i) % hq.length]);
        m.push(oq[bi]);
        m = m.concat(oq.slice(bi + 1));
        var T = earClip(m), ta = 0, want = o.a - h.a;
        T.forEach(function (t) { var A = m[t[0]], B = m[t[1]], C = m[t[2]]; ta += Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) / 2; });
        if (Math.abs(ta - want) > want * 0.03 + 1e-7) continue;
        o.q0 = o.q0 || o.q; o.q = m; o.a = want;
        return;
      }
      res.push({ q: h.q, a: h.a });
    });
    return res.map(function (r) { return r.q; });
  }
  /** open polyline -> closed ribbon polygon of width w (left side forward, right side back) */
  function strokeRibbon(pts, w) {
    var n = pts.length, L = [], R = [], h = w / 2;
    if (n < 2) return null;
    for (var i = 0; i < n; i++) {
      var a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty);
      if (tl < 1e-9) continue;
      var nx = -ty / tl, ny = tx / tl;
      L.push([pts[i][0] + nx * h, pts[i][1] + ny * h]); R.push([pts[i][0] - nx * h, pts[i][1] - ny * h]);
    }
    if (L.length < 2) return null;
    return L.concat(R.reverse());
  }
  /** Douglas-Peucker on a closed polygon (keeps the two farthest-apart anchors) */
  function dpSimplify(pts, tol) {
    var n = pts.length;
    if (n <= 8) return pts;
    var far = 0, fd = -1;
    for (var i = 1; i < n; i++) { var d0 = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d0 > fd) { fd = d0; far = i; } }
    var keep = new Uint8Array(n);
    keep[0] = keep[far] = 1;
    function rec(a, b) {      // indices along the ring from a to b (b may wrap)
      var len = (b - a + n) % n;
      if (len < 2) return;
      var A = pts[a], B = pts[b % n], ex = B[0] - A[0], ey = B[1] - A[1], el = Math.hypot(ex, ey), best = -1, bi = -1;
      for (var k = 1; k < len; k++) {
        var P = pts[(a + k) % n], dd = el > 1e-9 ? Math.abs(ex * (P[1] - A[1]) - ey * (P[0] - A[0])) / el : Math.hypot(P[0] - A[0], P[1] - A[1]);
        if (dd > best) { best = dd; bi = (a + k) % n; }
      }
      if (best > tol) { keep[bi] = 1; rec(a, bi); rec(bi, b); }
    }
    rec(0, far); rec(far, n);
    var out = [];
    for (i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
    return out.length >= 3 ? out : pts;
  }
  /** split polygon edges longer than maxE (keeps projected outlines on curved panels) */
  function densify(pts, maxE) {
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.min(24, Math.ceil(l / maxE));
      out.push(a);
      for (var j = 1; j < k; j++) out.push([lerp(a[0], b[0], j / k), lerp(a[1], b[1], j / k)]);
    }
    return out;
  }
  var SHAPE_PAINT = {
    black: ['trimG', [0.02, 0.02, 0.022, 1]], 'gloss-black': ['trimG', [0.006, 0.006, 0.007, 1]], grille: ['trimG', [0.004, 0.004, 0.005, 1]],
    chrome: ['chrome', [0.86, 0.87, 0.89, 1]], light: ['head', [0.92, 0.93, 0.95, 1]], 'light-red': ['brake', [0.32, 0.01, 0.015, 1]],
    'light-amber': ['trimG', [0.85, 0.36, 0.03, 1]], carbon: ['carbon', WHITE], plate: ['trimG', [0.62, 0.62, 0.6, 1]]
  };
  /**
   * Project a view item onto the body as a decal (ear-clipped, subdivided, offset along the surface normal).
   * view: 'front' (z, y) | 'rear' (z, y) | 'side' (x, y; mirrored to the left flank) | 'top' (x, z). Returns the
   * centroid of the first projected polygon (car-local) or null.
   */
  function shapeDecal(S, G, path, view, key, col, off, o) {
    var SH = shapeLib(), smp = S.shape;
    if (!SH || !smp || !G[key]) return null;
    o = o || {};
    var dx = S.shapeDx, maxE = o.maxEdge || (view === 'front' || view === 'rear' ? 0.12 : 0.16), depth = o.depth == null ? 5 : o.depth, centre = null;
    if (S.decalBudget != null && S.decalTris > S.decalBudget && !o.force) return null;
    var g0 = G[key].tris();
    // stretch: a projected 3D edge longer than stretch x its 2D edge is subdivided further (never dropped);
    // minDot: only triangles that are (almost) edge-on to the view are skipped (invisible from that view anyway)
    var stretch = o.stretch || 2.5, minDot = o.minDot != null ? o.minDot : view === 'top' ? 0.2 : 0.05;
    var maxLvl = depth + (o.extraDepth == null ? 4 : o.extraDepth), maxE3Opt = o.maxEdge3;
    var yPad = o.bottomPad == null ? (view === 'side' ? 0.01 : 0.03) : o.bottomPad;
    var capE = o.capEdge || Math.max(maxE * 6, 0.35), sagTol = o.sagTol || 0.0025, maxE3 = maxE3Opt || capE * 1.6;
    var yEnd = view === 'front' ? smp.bottom(smp.x1) : view === 'rear' ? smp.bottom(smp.x0) : null;
    var holes = o.holes || null, lastZ = null, lastY = null, xClip = o.xClip || null, yClip = o.yClip || null;
    var endView = view === 'front' || view === 'rear';
    // fade: per-vertex alpha = smoothstep(fade[0], fade[1], |n . view axis|) instead of keeping / dropping whole
    // grazing triangles (alpha-tested / blended materials cut the decal smoothly inside the triangle)
    var fadeA = o.fade || null;
    var nrmDev = endView && o.nrmDev != null ? o.nrmDev : null, maxSpread = o.maxSpread || 0.06;
    // side casts: every corner must still face sideways (|n.z|), else the cast has slid over the roof crown / onto
    // the windscreen (saw-tooth roof rails, paint shards on the glass)
    var sideNz = view === 'side' && o.sideNz != null ? o.sideNz : null;
    function proj(a, b, sd) {
      var x, y, z, p;
      if (view === 'front' || view === 'rear') {
        if (yEnd !== null) b = Math.max(b, yEnd + yPad);      // points below the loft bottom: clamp (no sawtooth on bumpers)
        var dir = view === 'front' ? -1 : 1;
        var pj = o.reproject ? smp.projXL : smp.projX;
        p = pj(b, a, dir, curD3);
        // above the nose / tail at this height (lamp tops on a fender crown): slide down onto the upright face
        for (var k = 1, kN = o.reproject ? 3 : 10; !p && k <= kN; k++) p = pj(b - k * 0.012, a, dir, curD3);     // (re-projecting lamps already land on crowns: short slide only)
        if (!p) return null;
      }
      else if (view === 'side') {
        x = a + dx; var yb0 = smp.bottom(x); y = yb0 === null ? b : Math.max(b, yb0 + yPad);
        z = smp.side(x, y);
        for (var k2 = 1; z === null && k2 <= 6; k2++) z = smp.side(x, y + k2 * 0.015);   // inside a wheel well: the lip above
        if (z === null) { if (lastZ === null) return null; z = lastZ; }
        else lastZ = z;
        p = [x, y, z * sd];
      }
      else {
        // top view: a missing height sample (sampler gap between stations) keeps the last good height instead of
        // dropping the whole triangle (stair-stepped vent outlines)
        x = a + dx; z = b; y = smp.top(x, z);
        if (y === null) { if (lastY === null || !(smp.halfW(x) > Math.abs(z) - 0.04)) return null; y = lastY; }
        else lastY = y;
        p = [x, y, z];
      }
      return p;
    }
    var hint = view === 'front' ? [1, 0, 0] : view === 'rear' ? [-1, 0, 0] : view === 'side' ? [0, 0, 1] : [0, 1, 0];
    var curD3 = o.depth3 || 0.35;
    /** autoDepth (end-view fills): cast as deep as this outline's own interior reaches into the nose / tail (+3 cm),
        at least depth3, at most o.autoDepth: a tall kidney grille runs up the sloping nose, a bumper intake stays
        shallow (no wrap onto the bumper corners) */
    function fitDepth(pts) {
      if (!o.autoDepth || !endView || !smp.castX) return o.depth3 || 0.35;
      var b0 = Infinity, b1 = -Infinity, c0 = Infinity, c1 = -Infinity, dir = view === 'front' ? -1 : 1, end = dir < 0 ? smp.x1 : smp.x0, dm = 0;
      pts.forEach(function (q) { b0 = Math.min(b0, q[0]); b1 = Math.max(b1, q[0]); c0 = Math.min(c0, q[1]); c1 = Math.max(c1, q[1]); });
      for (var iu = 0; iu <= 8; iu++) for (var iv = 0; iv <= 8; iv++) {
        var qa = lerp(b0, b1, (iu + 0.5) / 9.5), qb = lerp(c0, c1, (iv + 0.5) / 9.5);
        if (!ptInPoly([qa, qb], pts)) continue;
        var hx = smp.castX(qb, qa, dir, end + dir * o.autoDepth);
        if (hx === null) continue;
        // only where the hit surface still looks along the car (a nose / tail face, not the bonnet / deck the ray
        // grazes further back: a low intake must not reach onto a sloping hypercar bonnet)
        var hn = smp.normal ? smp.normal(hx, qb, qa) : null;
        if (hn && Math.abs(hn[0]) < 0.5) continue;
        dm = Math.max(dm, Math.abs(hx - end));
      }
      return clamp(dm + 0.03, o.depth3 || 0.12, o.autoDepth);
    }
    function vertex(a, b, sd, cache) {
      var k = a.toFixed(5) + ',' + b.toFixed(5);
      if (cache[k] !== undefined) return cache[k];
      var P = proj(a, b, sd);
      if (!P) { cache[k] = null; return null; }
      // decal normals from a wider (2.2 cm) gradient: the slice-distance gradient at 8 mm follows every ring kink and
      // station step (crumpled reflections on side glass / lamp lenses); the offset direction barely changes
      var h = view === 'side' ? [0, 0, sd] : hint, nrm = smp.normal ? (smp.normal(P[0], P[1], P[2], 0.022) || smp.normal(P[0], P[1], P[2])) : null;
      if (!nrm) {
        nrm = h;
        var e = 0.012, pa = proj(a + e, b, sd), pb = proj(a, b + e, sd);
        if (pa && pb) {
          var nn = vcross(vsub(pa, P), vsub(pb, P)), l = vlen(nn);
          if (l > 1e-12) { nn = vsc(nn, 1 / l); if (vdot(nn, h) < 0) nn = vsc(nn, -1); if (vdot(nn, h) > 0.15) nrm = nn; }
        }
      }
      var g = G[key], id = g.verts(), vc = col;
      // body-colour decals (pillars, panel-line bevels) on a two-tone body take the colour of the panel under them
      if (S.ttAt && key === 'paint' && S.ttAt(P[0], P[1], P[2], nrm[0])) vc = o.ttCol || (col === S.paintRGBA ? S.ttRGBA : col);
      if (fadeA && vc[3] !== undefined) {
        var fa = sstep(fadeA[0], fadeA[1], Math.abs(vdot(nrm, hint)));
        if (fa < 1) vc = [vc[0], vc[1], vc[2], (vc.length > 3 ? vc[3] : 1) * fa];
      }
      g.vert(P[0] + nrm[0] * off, P[1] + nrm[1] * off, P[2] + nrm[2] * off, nrm[0], nrm[1], nrm[2], a, b, vc);
      cache[k] = { id: id, p: P, n: nrm };
      return cache[k];
    }
    // view-plane holes (wheel arches): points inside are pushed radially onto the circle
    function inHole(q) { for (var i = 0; i < holes.length; i++) { var H = holes[i]; if (Math.hypot(q[0] - H[0], q[1] - H[1]) < H[2] - 1e-6) return true; } return false; }
    function nearHole(q, d) { for (var i = 0; i < holes.length; i++) { var H = holes[i]; if (Math.abs(Math.hypot(q[0] - H[0], q[1] - H[1]) - H[2]) < d) return true; } return false; }
    function snap(q) {
      if (!holes) return q;
      for (var i = 0; i < holes.length; i++) {
        var H = holes[i], ddx = q[0] - H[0], ddy = q[1] - H[1], d = Math.hypot(ddx, ddy);
        if (d < H[2] && d > 1e-6) q = [H[0] + ddx / d * H[2], H[1] + ddy / d * H[2]];
      }
      return q;
    }
    function pos(a, b, sd, cache) {
      var k = 'p' + a.toFixed(5) + ',' + b.toFixed(5);
      if (cache[k] === undefined) { var c = cache[a.toFixed(5) + ',' + b.toFixed(5)]; cache[k] = c ? c.p : (c === null ? null : proj(a, b, sd)); }
      return cache[k];
    }
    function sagged(ta, tb, tc, sd, cache) {
      var q = [snap(ta), snap(tb), snap(tc)], P = q.map(function (t) { return pos(t[0], t[1], sd, cache); });
      if (!P[0] || !P[1] || !P[2]) return true;
      for (var i = 0; i < 3; i++) {
        var u = q[i], v = q[(i + 1) % 3], M = pos((u[0] + v[0]) / 2, (u[1] + v[1]) / 2, sd, cache), A = P[i], B = P[(i + 1) % 3];
        if (!M) return true;
        if (Math.hypot(M[0] - (A[0] + B[0]) / 2, M[1] - (A[1] + B[1]) / 2, M[2] - (A[2] + B[2]) / 2) > sagTol) return true;
        if (vlen(vsub(A, B)) > Math.hypot(u[0] - v[0], u[1] - v[1]) * stretch + 0.01) return true;
      }
      return false;
    }
    /** a flat triangle whose edge midpoints / centroid lie deeper than ~the decal offset under the surface (concave
        side is harmless: the decal floats there) */
    var sinkTol = o.sinkTol || Math.max(0.0035, Math.abs(off)), sinkOn = o.sink != null ? !!o.sink : (view === 'front' || view === 'rear');
    function sunk(ta, tb, tc, sd, cache) {
      var q = [snap(ta), snap(tb), snap(tc)], P = q.map(function (t) { return pos(t[0], t[1], sd, cache); });
      if (!P[0] || !P[1] || !P[2]) return false;
      var pts2 = [[(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2, 0, 1], [(q[1][0] + q[2][0]) / 2, (q[1][1] + q[2][1]) / 2, 1, 2], [(q[2][0] + q[0][0]) / 2, (q[2][1] + q[0][1]) / 2, 2, 0]];
      for (var i = 0; i < 3; i++) {
        var M = pos(pts2[i][0], pts2[i][1], sd, cache), A = P[pts2[i][2]], B = P[pts2[i][3]];
        if (!M) continue;
        if (Math.hypot(M[0] - (A[0] + B[0]) / 2, M[1] - (A[1] + B[1]) / 2, M[2] - (A[2] + B[2]) / 2) > sinkTol) return true;
      }
      var C = pos((q[0][0] + q[1][0] + q[2][0]) / 3, (q[0][1] + q[1][1] + q[2][1]) / 3, sd, cache);
      return !!C && Math.hypot(C[0] - (P[0][0] + P[1][0] + P[2][0]) / 3, C[1] - (P[0][1] + P[1][1] + P[2][1]) / 3, C[2] - (P[0][2] + P[1][2] + P[2][2]) / 3) > sinkTol;
    }
    function split(ta, tb, tc, sd, cache, lvl, which) {
      if (which === 0) { var m1 = [(ta[0] + tb[0]) / 2, (ta[1] + tb[1]) / 2]; emit(ta, m1, tc, sd, cache, lvl + 1); emit(m1, tb, tc, sd, cache, lvl + 1); }
      else if (which === 1) { var m2 = [(tb[0] + tc[0]) / 2, (tb[1] + tc[1]) / 2]; emit(ta, tb, m2, sd, cache, lvl + 1); emit(ta, m2, tc, sd, cache, lvl + 1); }
      else { var m3 = [(tc[0] + ta[0]) / 2, (tc[1] + ta[1]) / 2]; emit(ta, tb, m3, sd, cache, lvl + 1); emit(m3, tb, tc, sd, cache, lvl + 1); }
    }
    function emit(ta, tb, tc, sd, cache, lvl) {
      var e1 = Math.hypot(ta[0] - tb[0], ta[1] - tb[1]), e2 = Math.hypot(tb[0] - tc[0], tb[1] - tc[1]), e3 = Math.hypot(tc[0] - ta[0], tc[1] - ta[1]);
      var em = Math.max(e1, e2, e3), longest = e1 >= e2 && e1 >= e3 ? 0 : e2 >= e3 ? 1 : 2;
      // longest-edge bisection down to maxE, stopping early where the surface is flat enough (chord sag < sagTol)
      if (lvl < depth && em > maxE * 1.5 && (em > capE || sagged(ta, tb, tc, sd, cache))) { split(ta, tb, tc, sd, cache, lvl, longest); return; }
      // below maxE too: a flat triangle on a curved panel sinks under the paint (the body pokes through as holes)
      if (sinkOn && lvl < maxLvl && em > 0.012 && em <= maxE * 1.5 && sunk(ta, tb, tc, sd, cache)) { split(ta, tb, tc, sd, cache, lvl, longest); return; }
      if (holes) {
        var ia = inHole(ta), ib = inHole(tb), ic = inHole(tc);
        if (ia && ib && ic) return;                                                      // wholly inside an arch
        var cen = [(ta[0] + tb[0] + tc[0]) / 3, (ta[1] + tb[1] + tc[1]) / 3];
        if (lvl < maxLvl && em > 0.04 && (ia || ib || ic || nearHole(cen, em))) { split(ta, tb, tc, sd, cache, lvl, longest); return; }
        if (inHole(cen) && (ia || ib || ic)) return;
      }
      var sa = snap(ta), sb = snap(tb), sc = snap(tc);
      var A = vertex(sa[0], sa[1], sd, cache), B = vertex(sb[0], sb[1], sd, cache), C = vertex(sc[0], sc[1], sd, cache);
      if (!A || !B || !C) { if (lvl < maxLvl && em > 0.01) split(ta, tb, tc, sd, cache, lvl, longest); return; }
      // x clip (lamps: the side-view depth of the lamp). Front / rear projections of a lamp set into a sloping fender
      // otherwise run on along the grazing crown as a long smear; straddling triangles refine to ~1 cm, then the
      // centroid decides
      if (xClip) {
        var oa = (A.p[0] - xClip[0]) * xClip[1] < 0, ob = (B.p[0] - xClip[0]) * xClip[1] < 0, oc = (C.p[0] - xClip[0]) * xClip[1] < 0;
        if (oa && ob && oc) return;
        if (oa || ob || oc) {
          if (lvl < maxLvl + 2 && em > 0.01) { split(ta, tb, tc, sd, cache, lvl, longest); return; }
          if (((A.p[0] + B.p[0] + C.p[0]) / 3 - xClip[0]) * xClip[1] < 0) return;
        }
      }
      // height clip (side glass / greenhouse: never over the roof crown), same refine-then-centroid rule
      if (yClip) {
        var ya = (A.p[1] - yClip[0]) * yClip[1] < 0, yb = (B.p[1] - yClip[0]) * yClip[1] < 0, yc = (C.p[1] - yClip[0]) * yClip[1] < 0;
        if (ya && yb && yc) return;
        if (ya || yb || yc) {
          if (lvl < maxLvl + 2 && em > 0.01) { split(ta, tb, tc, sd, cache, lvl, longest); return; }
          if (((A.p[1] + B.p[1] + C.p[1]) / 3 - yClip[0]) * yClip[1] < 0) return;
        }
      }
      // projected edges much longer than their 2D edges (corner wraps, raked / grazing panels): subdivide in 3D
      var l1 = vlen(vsub(A.p, B.p)), l2 = vlen(vsub(B.p, C.p)), l3 = vlen(vsub(C.p, A.p)), lim = em * stretch + 0.01;
      if (lvl < maxLvl && em > 0.006 && (Math.max(l1, l2, l3) > lim || Math.max(l1, l2, l3) > maxE3)) {
        split(ta, tb, tc, sd, cache, lvl, l1 >= l2 && l1 >= l3 ? 0 : l2 >= l3 ? 1 : 2);
        return;
      }
      // still stretched after the subdivision limit: a projection discontinuity (neighbours on different panels), not
      // a curved panel. Frame rings skip it (an outline gap is invisible, a spike is not); fills only skip real jumps
      var l3m = Math.max(l1, l2, l3);
      if (l3m > lim * 2 && (o.ring || (l3m > 0.08 && l3m > em * 20))) return;
      // front / rear casts: a triangle whose corners hit surfaces facing different ways (> ~40 deg) or lying at very
      // different depths straddles a panel break / grazing deck: refine to ~2 cm, then drop it (no torn shards)
      if (nrmDev != null && A.n && B.n && C.n) {
        var dmin = Math.min(vdot(A.n, B.n), vdot(B.n, C.n), vdot(C.n, A.n));
        var spread = Math.max(A.p[0], B.p[0], C.p[0]) - Math.min(A.p[0], B.p[0], C.p[0]);
        if (dmin < nrmDev || spread > maxSpread) {
          if (lvl < maxLvl && em > 0.02) { split(ta, tb, tc, sd, cache, lvl, longest); return; }
          // opaque fills (grilles / intakes) keep a small bent triangle over a crease (a hole shows the paint
          // through); only a real depth jump is dropped
          if (!o.nrmKeep || spread > Math.min(maxSpread, 0.03)) return;
        }
      }
      if (sideNz != null && A.n && B.n && C.n) {
        var nzMin = Math.min(Math.abs(A.n[2]), Math.abs(B.n[2]), Math.abs(C.n[2]));
        if (nzMin < sideNz) {
          if (lvl < maxLvl + 1 && em > 0.012) { split(ta, tb, tc, sd, cache, lvl, longest); return; }
          if ((Math.abs(A.n[2]) + Math.abs(B.n[2]) + Math.abs(C.n[2])) / 3 < sideNz) return;
        }
      }
      if (fadeA && A.n && B.n && C.n) {
        var fh = view === 'side' ? [0, 0, sd] : hint, faMax = Math.max(Math.abs(vdot(A.n, fh)), Math.abs(vdot(B.n, fh)), Math.abs(vdot(C.n, fh)));
        if (faMax < (fadeA[0] + fadeA[1]) / 2) return;      // wholly faded out
      } else if (minDot > 0) {
        var fn = vcross(vsub(B.p, A.p), vsub(C.p, A.p)), fl = vlen(fn), h = view === 'side' ? [0, 0, sd] : hint;
        if (fl > 1e-12 && Math.abs(vdot(fn, h)) / fl < minDot) {
          // refine along the turn-away edge before dropping (fine 8 mm steps instead of big saw teeth)
          if (o.edgeRefine && lvl < maxLvl + 1 && em > 0.008) { split(ta, tb, tc, sd, cache, lvl, longest); return; }
          return;
        }
      }
      G[key].tri(A.id, B.id, C.id);
    }
    // outlines only lightly densified before ear-clipping (dense outlines -> fans of slivers); the longest-edge
    // bisection below refines every edge, the outline included, down to maxE
    var maxO = Math.max(maxE * 3, 0.12);
    var polys = o.polys ? o.polys.map(function (q) { return densify(dpSimplify(q, o.tol || 0.003), maxO); }) : shapePolys(SH, path, o.steps, maxO, o.tol, o.strokeW);
    if (o.ring) {      // outline ring only (lamp frames): strip between the outline and its offset, never under the lamp
      polys = polys.map(function (q) {
        var r = offsetPoly(q, o.ring);
        return r ? { ring: true, pts: q.concat(r) } : null;
      }).filter(function (q) { return q; });
    } else if (o.offset2d) polys = polys.map(function (q) { return offsetPoly(q, o.offset2d); }).filter(function (q) { return q && q.length >= 3; });
    polys.forEach(function (pts) {
      var tris;
      if (pts.ring) {
        var nr = pts.pts.length / 2;
        pts = pts.pts; tris = [];
        for (var ri = 0; ri < nr; ri++) { var rj = (ri + 1) % nr; tris.push([ri, nr + ri, nr + rj], [ri, nr + rj, rj]); }
      } else tris = pts.length > 4 ? flipSafe(pts) : earClip(pts);
      curD3 = fitDepth(pts);
      (view === 'side' ? [1, -1] : [1]).forEach(function (sd) {
        var cache = {};
        lastZ = null; lastY = null;
        tris.forEach(function (t) { emit(pts[t[0]], pts[t[1]], pts[t[2]], sd, cache, 0); });
      });
      if (!centre) {
        var ca = 0, cb = 0;
        pts.forEach(function (q) { ca += q[0]; cb += q[1]; });
        ca /= pts.length; cb /= pts.length;
        lastZ = null;
        centre = proj(ca, cb, 1) || null;
      }
    });
    S.decalTris = (S.decalTris || 0) + G[key].tris() - g0;
    if (typeof process !== 'undefined' && process.env && process.env.DECAL_DEBUG) console.log('  decal', view, key, (o.polys ? 'polys' : ''), G[key].tris() - g0, JSON.stringify(Object.keys(o)));
    return centre;
  }
  /** closed polygon grown (d > 0) or shrunk (d < 0) by d along its vertex normals (miter-limited) */
  function offsetPoly(pts, d) {
    var n = pts.length, area = 0, out = [], i;
    if (n < 3) return null;
    for (i = 0; i < n; i++) { var p = pts[i], q = pts[(i + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
    var sg = area >= 0 ? 1 : -1;      // CCW: outward normal of edge (ex, ey) is (ey, -ex)
    for (i = 0; i < n; i++) {
      var a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
      var e0x = b[0] - a[0], e0y = b[1] - a[1], l0 = Math.hypot(e0x, e0y) || 1, e1x = c[0] - b[0], e1y = c[1] - b[1], l1 = Math.hypot(e1x, e1y) || 1;
      var n0x = e0y / l0 * sg, n0y = -e0x / l0 * sg, n1x = e1y / l1 * sg, n1y = -e1x / l1 * sg;
      var mx = n0x + n1x, my = n0y + n1y, ml = Math.hypot(mx, my);
      if (ml < 1e-6) { mx = n1x; my = n1y; ml = 1; }
      mx /= ml; my /= ml;
      var cosH = mx * n1x + my * n1y, s = d / Math.max(0.5, cosH);
      out.push([b[0] + mx * s, b[1] + my * s]);
    }
    return out;
  }
  /** per ring vertex j: 1 where the surface breaks between stations k and k+1 (glass / paint flag change, or a
      jump far steeper than both neighbouring spans: wheel-well notch, cabin / bonnet vertex hand-over) */
  function stationBreaks(secs, j) {
    var n = secs.length, br = new Uint8Array(n), sl = new Float64Array(n), dd = new Float64Array(n), k;
    for (k = 0; k < n - 1; k++) {
      var A = secs[k].ring[j], B = secs[k + 1].ring[j], hx = Math.max(1e-4, secs[k + 1].x - secs[k].x);
      dd[k] = Math.hypot(B[0] - A[0], B[1] - A[1]); sl[k] = dd[k] / hx;
      var ga = secs[k].glass, gb = secs[k + 1].glass, pa = secs[k].paint, pb = secs[k + 1].paint;
      if ((ga ? ga[j] : 0) !== (gb ? gb[j] : 0) || (pa ? pa[j] : 'body') !== (pb ? pb[j] : 'body')) br[k] = 1;
    }
    for (k = 0; k < n - 1; k++) {
      var ref = Math.max(k > 0 ? sl[k - 1] : 0, k < n - 2 ? sl[k + 1] : 0, 0.1);
      if (dd[k] > 0.006 && sl[k] > 4 * ref) br[k] = 1;
    }
    return br;
  }
  /** weighted local quadratic fit in x of ring vertex j around station i (within its unbroken run) ->
      [y, z, dy/dx, dz/dx] or null; w0 = optional per-station robustness weights */
  function stationFit(secs, j, i, lo, hi, sig, rw) {
    var xi = secs[i].x, S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, Ty = [0, 0, 0], Tz = [0, 0, 0], cnt = 0;
    for (var k = lo; k <= hi; k++) {
      var d = secs[k].x - xi;
      if (Math.abs(d) > 2.5 * sig) continue;
      var w = Math.exp(-0.5 * d * d / (sig * sig)) * (rw ? rw[k] : 1);
      if (!(w > 1e-6)) continue;
      var q = secs[k].ring[j], d2 = d * d;
      S0 += w; S1 += w * d; S2 += w * d2; S3 += w * d2 * d; S4 += w * d2 * d2;
      Ty[0] += w * q[0]; Ty[1] += w * q[0] * d; Ty[2] += w * q[0] * d2;
      Tz[0] += w * q[1]; Tz[1] += w * q[1] * d; Tz[2] += w * q[1] * d2;
      cnt++;
    }
    if (cnt < 4) return null;
    // 3x3 normal equations [S0 S1 S2; S1 S2 S3; S2 S3 S4] [a b c] = T (Cramer)
    var det = S0 * (S2 * S4 - S3 * S3) - S1 * (S1 * S4 - S3 * S2) + S2 * (S1 * S3 - S2 * S2);
    if (!(Math.abs(det) > 1e-18)) return null;
    function solve(T) {
      var a = (T[0] * (S2 * S4 - S3 * S3) - S1 * (T[1] * S4 - S3 * T[2]) + S2 * (T[1] * S3 - S2 * T[2])) / det;
      var b = (S0 * (T[1] * S4 - T[2] * S3) - T[0] * (S1 * S4 - S3 * S2) + S2 * (S1 * T[2] - T[1] * S2)) / det;
      return [a, b];
    }
    var fy = solve(Ty), fz = solve(Tz);
    return [fy[0], fz[0], fy[1], fz[1]];
  }
  /** smooth the authored stations along x before decimation: the authored rings are slices of flattened (piecewise
      linear) view outlines, so every ring vertex wobbles by 0.5-3 mm from station to station, which at 1-3 cm
      station spacing tilts the normals by several degrees (lumpy, wavy reflections on the doors / wings / bonnet).
      Each vertex is replaced by a robust (Tukey-reweighted) gaussian-weighted local quadratic fit along x within its
      unbroken run (wheel-well notches, glass / paint boundaries and vertex hand-overs are never blended), the move
      capped at 3.5 mm so real features and the model outline survive. Also stores the fitted slope dP/dx per vertex
      (s.dxd) for the analytic loft normals. End stations (bumper faces) are kept. */
  function smoothStations(secs) {
    var n = secs.length, N = secs[0].ring.length, i, j, k;
    for (i = 0; i < n; i++) if (!secs[i].ring || secs[i].ring.length !== N) return secs;
    if (n < 6) return secs;
    var out = secs.map(function (s) { return Object.assign({}, s, { ring: s.ring.map(function (q) { return [q[0], q[1]]; }), dxd: [] }); });
    var CAP = 0.0035, TUK = 0.004;
    for (j = 0; j < N; j++) {
      var br = stationBreaks(secs, j), run = new Int32Array(n), r = 0;
      for (i = 0; i < n; i++) { run[i] = r; if (br[i]) r++; }
      var lo = 0;
      for (i = 0; i < n; i++) {
        if (i > 0 && run[i] !== run[i - 1]) lo = i;
        var hi = i; while (hi < n - 1 && run[hi + 1] === run[i]) hi++;
        var hx = Math.max(secs[Math.min(n - 1, i + 1)].x - secs[i].x, secs[i].x - secs[Math.max(0, i - 1)].x, 0.004);
        var sig = Math.max(0.035, 1.6 * hx), P = secs[i].ring[j], f = stationFit(secs, j, i, lo, hi, sig, null);
        if (f) {
          // two Tukey passes: neighbours off the first fit by > 4 mm (a crisp profile kink) drop out
          for (var it = 0; it < 2; it++) {
            var rw = new Float64Array(n), any = false;
            for (k = lo; k <= hi; k++) {
              var d = secs[k].x - secs[i].x;
              if (Math.abs(d) > 2.5 * sig) continue;
              var q = secs[k].ring[j], ey = q[0] - (f[0] + f[2] * d), ez = q[1] - (f[1] + f[3] * d), e = Math.sqrt(ey * ey + ez * ez) / TUK;
              rw[k] = e < 1 ? (1 - e * e) * (1 - e * e) : 0; if (rw[k] > 0) any = true;
            }
            var f2 = any ? stationFit(secs, j, i, lo, hi, sig, rw) : null;
            if (f2) f = f2; else break;
          }
        }
        out[i].dxd[j] = f ? [f[2], f[3]] : null;
        if (!f || i < 2 || i > n - 3) continue;
        var my = f[0] - P[0], mz = f[1] - P[1], ml = Math.sqrt(my * my + mz * mz);
        if (ml > CAP) { my *= CAP / ml; mz *= CAP / ml; }
        out[i].ring[j][0] = P[0] + my; out[i].ring[j][1] = P[1] + mz;
      }
    }
    // keep the bottom / top centre on the centre line and the left / right halves exact mirrors
    var H = N >> 1;
    out.forEach(function (s) {
      s.ring[0][1] = 0; s.ring[H][1] = 0;
      for (j = 1; j < H; j++) { var a = s.ring[j], b = s.ring[N - j]; var y = (a[0] + b[0]) / 2, z = (a[1] - b[1]) / 2; a[0] = b[0] = y; a[1] = z; b[1] = -z; }
      for (j = 0; j < N; j++) if (!s.dxd[j]) s.dxd[j] = null;
    });
    return out;
  }
  /** analytic loft normals: ring tangent (one-sided at doubled crease vertices) x the fitted station slope dP/dx
      (s.dxd, from smoothStations on the dense authored stations) -> per ring vertex unit normals (Float32Array
      S2 * N * 3), or null when the sections carry no slopes. Vertices without a slope keep a zero normal (caller
      falls back to the mesh normal there). */
  function loftNormals(secs) {
    var S2 = secs.length, N = secs[0].ring.length, out = new Float32Array(S2 * N * 3), i, j, ok = false;
    if (!secs.every(function (s) { return s.dxd && s.dxd.length === N && s.ring.length === N; })) return null;
    for (i = 0; i < S2; i++) {
      var R = secs[i].ring, area = 0;
      for (j = 0; j < N; j++) { var p = R[j], q = R[(j + 1) % N]; area += p[0] * q[1] - q[0] * p[1]; }
      var sg = area <= 0 ? 1 : -1;     // bottom centre -> +z flank -> roof centre (clockwise in (y, z)): as is
      for (j = 0; j < N; j++) {
        var D = secs[i].dxd[j];
        if (!D) continue;
        var A = R[(j + N - 1) % N], P = R[j], B = R[(j + 1) % N];
        var la = Math.hypot(P[0] - A[0], P[1] - A[1]), lb = Math.hypot(B[0] - P[0], B[1] - P[1]), ty, tz;
        if (lb < 1.5e-3 && la >= 1.5e-3) { ty = P[0] - A[0]; tz = P[1] - A[1]; }
        else if (la < 1.5e-3 && lb >= 1.5e-3) { ty = B[0] - P[0]; tz = B[1] - P[1]; }
        else {
          // chord-length weighted central tangent (unit segment directions: uneven spacing does not tilt it)
          ty = (P[0] - A[0]) / (la || 1) + (B[0] - P[0]) / (lb || 1); tz = (P[1] - A[1]) / (la || 1) + (B[1] - P[1]) / (lb || 1);
        }
        var tl = Math.hypot(ty, tz);
        if (!(tl > 1e-9)) continue;
        ty /= tl; tz /= tl;
        // (1, dy, dz) x (0, ty, tz) = (dy tz - dz ty, -tz, ty); the ring winding picks the outward side
        var nx = D[0] * tz - D[1] * ty, ny = -tz * sg, nz = ty * sg;
        nx *= sg;
        var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (!(nl > 1e-9)) continue;
        out[(i * N + j) * 3] = nx / nl; out[(i * N + j) * 3 + 1] = ny / nl; out[(i * N + j) * 3 + 2] = nz / nl;
        ok = true;
      }
    }
    return ok ? out : null;
  }
  /** fair the lofted stations: station-to-station ripples of a few mm (interpolated / decimated rings) read as
      wobbling reflections on a clear-coated body. Each ring vertex is pulled toward the x-linear interpolation of its
      neighbouring stations when it deviates by < 6 mm; real features (arch notches, cap curvature, creases, all >> 6 mm)
      are untouched. Sampler and mesh share the faired sections, so the decals still sit on the surface. */
  function fairSections(secs) {
    var n = secs.length, N = secs[0].ring.length, it, i, j;
    for (i = 0; i < n; i++) if (!secs[i].ring || secs[i].ring.length !== N) return;
    for (it = 0; it < 3; it++) {
      var moved = [];
      for (i = 2; i < n - 2; i++) {
        var a = secs[i - 1], b = secs[i], c = secs[i + 1], dxs = c.x - a.x;
        if (!(dxs > 1e-6)) continue;
        var t = (b.x - a.x) / dxs, row = [];
        for (j = 0; j < N; j++) {
          var A = a.ring[j], B = b.ring[j], C = c.ring[j];
          var py = A[0] + (C[0] - A[0]) * t, pz = A[1] + (C[1] - A[1]) * t, ey = py - B[0], ez = pz - B[1], d = Math.sqrt(ey * ey + ez * ez);
          row.push(d > 1e-7 && d < 0.006 ? [B[0] + ey * 0.5, B[1] + ez * 0.5] : null);
        }
        moved.push([i, row]);
      }
      moved.forEach(function (mv) {
        var r = secs[mv[0]].ring;
        for (var k = 0; k < N; k++) if (mv[1][k]) { r[k] = r[k].slice(); r[k][0] = mv[1][k][0]; r[k][1] = mv[1][k][1]; }
      });
    }
  }
  /** Taubin (lambda | mu) fairing of the station grid: every ring vertex moves (in its station plane) toward the
      distance-weighted mean of its ring and station neighbours, then back by mu (no shrinkage). Removes the
      centimetre-scale lumps between stations / around the rings (crumpled bonnets, wavy flanks) that survive the
      per-vertex x fit. Pinned: the bumper-face stations (2 each end), crease vertices (doubled ring vertices or ring
      turns sharper than ~35 deg), glass / paint flag boundaries; station neighbours across a break (wheel-well
      notch, flag change, vertex hand-over) are ignored. Total move capped at `cap`; mirror symmetry kept. */
  function fairGrid(secs, iters, cap) {
    var n = secs.length, N = secs[0].ring.length, H = N >> 1, i, j, it;
    for (i = 0; i < n; i++) if (!secs[i].ring || secs[i].ring.length !== N) return secs;
    if (n < 8) return secs;
    var cosC = Math.cos(60 * DEG), pin = new Uint8Array(n * N), brk = [];
    for (j = 0; j < N; j++) brk.push(stationBreaks(secs, j));
    function flag(s, k) { return (s.glass ? s.glass[k] : 0) + '|' + (s.paint ? s.paint[k] : 'body'); }
    for (i = 0; i < n; i++) {
      var R = secs[i].ring;
      for (j = 0; j < N; j++) {
        if (i < 2 || i > n - 3) { pin[i * N + j] = 1; continue; }
        var A = R[(j + N - 1) % N], P = R[j], B = R[(j + 1) % N];
        var ay = P[0] - A[0], az = P[1] - A[1], by = B[0] - P[0], bz = B[1] - P[1], la = Math.hypot(ay, az), lb = Math.hypot(by, bz);
        if (la < 2e-3 || lb < 2e-3 || (ay * by + az * bz) / (la * lb) < cosC) { pin[i * N + j] = 1; continue; }
        var f0 = flag(secs[i], j);
        if (f0 !== flag(secs[i], (j + 1) % N) || f0 !== flag(secs[i], (j + N - 1) % N) || f0 !== flag(secs[i - 1], j) || f0 !== flag(secs[i + 1], j)) pin[i * N + j] = 1;
      }
    }
    var orig = secs.map(function (s) { return s.ring.map(function (q) { return [q[0], q[1]]; }); });
    var cur = secs.map(function (s) { return s.ring.map(function (q) { return [q[0], q[1]]; }); });
    function step(fac) {
      var nxt = cur.map(function (r) { return r.map(function (q) { return [q[0], q[1]]; }); });
      for (var i2 = 2; i2 < n - 2; i2++) {
        var x0 = secs[i2].x;
        for (var j2 = 0; j2 <= H; j2++) {
          if (pin[i2 * N + j2]) continue;
          var P2 = cur[i2][j2], sw = 0, sy = 0, sz = 0;
          var nb = [[i2, (j2 + N - 1) % N], [i2, (j2 + 1) % N]];
          if (!brk[j2][i2 - 1]) nb.push([i2 - 1, j2]);
          if (!brk[j2][i2]) nb.push([i2 + 1, j2]);
          for (var k = 0; k < nb.length; k++) {
            var Q = cur[nb[k][0]][nb[k][1]], ddx = secs[nb[k][0]].x - x0, d = Math.sqrt(ddx * ddx + (Q[0] - P2[0]) * (Q[0] - P2[0]) + (Q[1] - P2[1]) * (Q[1] - P2[1]));
            if (!(d > 1e-4)) continue;
            var w = 1 / d;
            sw += w; sy += w * (Q[0] - P2[0]); sz += w * (Q[1] - P2[1]);
          }
          if (!(sw > 0)) continue;
          var ny = P2[0] + fac * sy / sw, nz = P2[1] + fac * sz / sw;
          if (j2 === 0 || j2 === H) nz = 0;
          var O = orig[i2][j2], my = ny - O[0], mz = nz - O[1], ml = Math.hypot(my, mz);
          if (ml > cap) { ny = O[0] + my * cap / ml; nz = O[1] + mz * cap / ml; }
          nxt[i2][j2][0] = ny; nxt[i2][j2][1] = nz;
          if (j2 > 0 && j2 < H) { nxt[i2][N - j2][0] = ny; nxt[i2][N - j2][1] = -nz; }
        }
      }
      cur = nxt;
    }
    for (it = 0; it < iters; it++) { step(0.5); step(-0.53); }
    return secs.map(function (s, k) { return Object.assign({}, s, { ring: cur[k] }); });
  }
  /** error-driven station decimation (authored models: ~100-220 stations): repeatedly drop the station whose removal
      moves the surface least (largest ring deviation of any original station in the span from the linear blend of
      the kept neighbours), never opening a gap wider than maxGap. Straight door / roof runs thin out, the nose,
      tail, arches and screen bases keep their stations (the old evenly spaced subset did the opposite). */
  function decimateStations(secs, target, maxGap) {
    var n = secs.length, N = secs[0].ring.length, i;
    if (n <= target) return secs;
    for (i = 0; i < n; i++) if (!secs[i].ring || secs[i].ring.length !== N) return secs;
    var prev = [], next = [], alive = [], cost = new Float64Array(n);
    for (i = 0; i < n; i++) { prev.push(i - 1); next.push(i + 1); alive.push(true); }
    function spanErr(a, b) {
      var A = secs[a], B = secs[b], dxs = B.x - A.x, worst = 0;
      if (dxs > maxGap) return Infinity;
      for (var k = a + 1; k < b; k++) {
        if (flagJump(A, secs[k], B)) return Infinity;
        var t = dxs > 1e-9 ? (secs[k].x - A.x) / dxs : 0.5, R = secs[k].ring;
        for (var j = 0; j < N; j++) {
          var ey = A.ring[j][0] + (B.ring[j][0] - A.ring[j][0]) * t - R[j][0], ez = A.ring[j][1] + (B.ring[j][1] - A.ring[j][1]) * t - R[j][1];
          var e = ey * ey + ez * ez;
          if (e > worst) worst = e;
        }
      }
      return worst;
    }
    // a dropped station must not carry a glass / paint flag pattern of its own (the flag boundaries would jump)
    function flagJump(A, K, B) {
      var fl = ['glass', 'paint'];
      for (var q = 0; q < 2; q++) {
        var fa = A[fl[q]], fk = K[fl[q]], fb = B[fl[q]];
        if (!fa && !fk && !fb) continue;
        if (!fa || !fk || !fb) return true;
        for (var j = 0; j < N; j++) if (fk[j] !== fa[j] && fk[j] !== fb[j]) return true;
      }
      return false;
    }
    function upd(k) { cost[k] = k <= 0 || k >= n - 1 || !alive[k] ? Infinity : spanErr(prev[k], next[k]); }
    for (i = 0; i < n; i++) upd(i);
    for (var left = n; left > target; left--) {
      var best = -1, bc = Infinity;
      for (i = 1; i < n - 1; i++) if (alive[i] && cost[i] < bc) { bc = cost[i]; best = i; }
      if (best < 0 || bc === Infinity) break;
      alive[best] = false;
      var p = prev[best], q = next[best];
      next[p] = q; prev[q] = p;
      upd(p); upd(q);
    }
    return secs.filter(function (s, k) { return alive[k]; });
  }
  /** subdivide every station ring once (N -> 2N): Catmull-Rom midpoints on smooth runs, plain midpoints across
      creases (doubled vertices, wheel-well notches, turns sharper than ~55 deg). The authored rings are coarse
      (~20 vertices per flank, 12-22 cm apart): faceted shoulders and wobbling reflections on the doors / haunches.
      Ring j stays at 2j, so the bottom / top centre (0, N/2) and the left / right mirror symmetry are kept;
      glass flags AND, paint flags prefer the non-body paint (mirror-consistent). */
  function refineRings(secs) {
    var N = secs[0].ring.length, i, j;
    for (i = 0; i < secs.length; i++) if (!secs[i].ring || secs[i].ring.length !== N) return secs;
    var cosC = Math.cos(55 * DEG);
    function dir(a, b) { var y = b[0] - a[0], z = b[1] - a[1], l = Math.sqrt(y * y + z * z); return l < 2e-3 ? null : [y / l, z / l]; }
    return secs.map(function (s) {
      var r = s.ring, out = [], g = s.glass, p = s.paint, g2 = g ? [] : null, p2 = p ? [] : null;
      var D = s.dxd && s.dxd.length === N ? s.dxd : null, D2 = D ? [] : null;
      for (j = 0; j < N; j++) {
        var P0 = r[(j + N - 1) % N], P1 = r[j], P2 = r[(j + 1) % N], P3 = r[(j + 2) % N];
        out.push([P1[0], P1[1]]);
        var d01 = dir(P0, P1), d12 = dir(P1, P2), d23 = dir(P2, P3), m;
        var smooth1 = d01 && d12 && d01[0] * d12[0] + d01[1] * d12[1] > cosC, smooth2 = d12 && d23 && d12[0] * d23[0] + d12[1] * d23[1] > cosC;
        if (!d12) m = [(P1[0] + P2[0]) / 2, (P1[1] + P2[1]) / 2];
        else {
          // tangents: Catmull-Rom on smooth runs, the chord itself at a crease (no overshoot past a corner)
          var T1 = smooth1 ? [(P2[0] - P0[0]) / 2, (P2[1] - P0[1]) / 2] : [P2[0] - P1[0], P2[1] - P1[1]];
          var T2 = smooth2 ? [(P3[0] - P1[0]) / 2, (P3[1] - P1[1]) / 2] : [P2[0] - P1[0], P2[1] - P1[1]];
          m = [(P1[0] + P2[0]) / 2 + (T1[0] - T2[0]) / 8, (P1[1] + P2[1]) / 2 + (T1[1] - T2[1]) / 8];
        }
        // never cross the centre line (the sampler's half rings are closed along z = 0)
        if ((P1[1] >= 0 && P2[1] >= 0 && m[1] < 0) || (P1[1] <= 0 && P2[1] <= 0 && m[1] > 0)) m[1] = 0;
        out.push(m);
        if (g2) { g2.push(g[j]); g2.push(g[j] && g[(j + 1) % N] ? 1 : 0); }
        if (p2) { var pa = p[j], pb = p[(j + 1) % N]; p2.push(pa); p2.push(pa === pb ? pa : (!pa || pa === 'body' ? pb : pa)); }
        if (D2) { var da = D[j], db = D[(j + 1) % N]; D2.push(da); D2.push(da && db ? [(da[0] + db[0]) / 2, (da[1] + db[1]) / 2] : da || db); }
      }
      var o = Object.assign({}, s, { ring: out, glass: g2 });
      if (D2) o.dxd = D2; else delete o.dxd;
      if (p2) o.paint = p2; else delete o.paint;
      return o;
    });
  }
  /** set up S from the fitted model: sampler, key stations, wheels, dims, cameras. Returns false on failure. */
  function shapeSetup(S, model, build, lod) {
    var SH = shapeLib();
    var f = SH.fit(model, build || {});
    if (!f || !f.dims || !f.wheels) return false;
    // high: authored rings (keeps the creases), decimated stations; low: a coarse sampler only (shapeLowBody)
    // high: authored rings at up to 96 stations (80 for the big SUV / pickup / van bodies: the decals need the headroom),
    // derived rings at 72 stations (smooth reflections); low: a 32-station sampler for shapeLowBody
    var nAuth = model.sections && model.sections.length && model.sections[0] && model.sections[0].ring ? model.sections[0].ring.length * (model.sections[0].ringHalf ? 2 : 1) : 0;
    // high: every authored station, then error-driven decimation to ~2600 ring quads (the rings are subdivided x2
    // below: ~10.4k loft triangles), so the curved nose / tail / arches keep their stations
    var secs = SH.sectionsFromViews(f, lod === 'low' ? { stations: 32, maxStations: 40 } : { stations: 64, maxStations: 0 });
    if (!secs || secs.length < 4) return false;
    if (lod !== 'low') { try { secs = smoothStations(secs); } catch (eS) { /* keep the authored stations */ } }
    // hero (the player's own car, high LOD): ~3x the stations (the decimation keeps the curved nose / tail / arch
    // stations first) and rings subdivided twice (N -> 4N): no faceted shoulders, clean reflections up close
    var hero = !!S.hero && lod !== 'low';
    if (lod !== 'low' && secs[0] && secs[0].ring) {
      var nTarget = hero ? clamp(Math.round(HERO_LOFT * (S.loftScale || 1) / secs[0].ring.length), 60, 200)
        : clamp(Math.round(2600 * (S.loftScale || 1) / secs[0].ring.length), 40, 96);
      if (secs.length > nTarget) { try { secs = decimateStations(secs, nTarget, hero ? 0.08 : 0.16); } catch (eD) { /* keep */ } }
    }
    if (lod !== 'low') { try { fairSections(secs); } catch (eF) { /* keep the raw sections */ } }
    // Taubin fairing of the station grid (hero: more passes on the denser grid): no crumpled bonnets / wavy flanks
    if (lod !== 'low') { try { secs = fairGrid(secs, hero ? 10 : 6, 0.012); } catch (eG) { /* keep the sections */ } }
    if (lod !== 'low') { try { secs = refineRings(secs); } catch (eR) { /* keep the authored rings */ } }
    if (hero && secs[0] && secs[0].ring.length <= 96) { try { secs = refineRings(secs); } catch (eR2) { /* keep */ } }
    var mesh = lod === 'low' ? null : SH.loftToMesh(secs);
    if (lod !== 'low' && (!mesh || !mesh.triangleCount)) return false;
    var d = f.dims, dx = -num(d.centerX, 0);
    S.shapeModel = model; S.shapeFit = f; S.shapeSecs = secs; S.shapeMesh = mesh; S.shapeDx = dx;
    S.shape = shapeSampler(secs, dx);
    var smp = S.shape;
    // ---- key stations from the model views
    S.xF = d.xFront + dx; S.xR = d.xRear + dx; S.L = S.xF - S.xR;
    S.W = num(d.width, S.W); S.hw = S.W / 2;
    S.wb = d.wheelbase; S.track = d.track; S.xFA = d.axleF + dx; S.xRA = d.axleR + dx;
    S.fo = S.xF - S.xFA; S.ro = S.xRA - S.xR;
    S.rh = num(d.rideHeight, S.rh);
    var aF = f.side.archF || {}, aR = f.side.archR || {}, wF = f.wheels.front, wR = f.wheels.rear;
    S.front.x = S.xFA; S.front.r = wF.r; S.front.rim = Math.min(wF.rimR, wF.r - 0.03); S.front.tw = wF.width; S.front.track = wF.track; S.front.Ra = num(aF.r, wF.r + 0.03);
    S.rear.x = S.xRA; S.rear.r = wR.r; S.rear.rim = Math.min(wR.rimR, wR.r - 0.03); S.rear.tw = wR.width; S.rear.track = wR.track; S.rear.Ra = num(aR.r, wR.r + 0.03);
    S.archF = { x: num(aF.x, d.axleF) + dx, y: num(aF.y, wF.r), r: S.front.Ra };
    S.archR = { x: num(aR.x, d.axleR) + dx, y: num(aR.y, wR.r), r: S.rear.Ra };
    S.wi = Math.max(0.3, S.track / 2 - Math.max(S.front.tw, S.rear.tw) / 2 - 0.045);
    S.openTop = !!(model.openTop || f.openTop || S.style === 'roadster');
    var ex0 = (build && build.exterior) || {};
    S.twoToneColor = model.twoTone ? (S.roof === 'contrast' && ex0.roofColor ? S.roofColor : [0.86, 0.86, 0.84]) : null;
    // no wheel design in the build: a rim that suits the vehicle (all-terrain beadlock pickups, plain disc vans / EV trucks)
    var wh0 = (build && build.wheels) || {}, ti0 = (build && build.tires) || {};
    if (!wh0.design && (model.style === 'pickup' || model.style === 'van')) {
      var dId = model.style === 'van' || model.powertrain === 'ev' ? 'aero-disc' : 'beadlock';
      var wdd = dataFind('wheelDesigns', dId) || WHEEL_FALLBACK[dId];
      if (wdd) S.wheelDesign = { id: dId, spokes: clamp(Math.round(num(wdd.spokes, 5)), 0, 24), style: wdd.style || 'y', concavity: clamp(num(wdd.concavity, 0.3), 0, 1) };
      if (!wh0.material && dId === 'beadlock') S.wheelMaterial = 'forged';
    }
    if (!ti0.compound && model.style === 'pickup') S.compound = 'all-season';     // chunky all-terrain tread
    S.tub = null; S.cabin = null; S.dome = null;
    var gh = shapeBounds(SH, f.side.greenhouse) || shapeBounds(SH, f.side.windows);
    var sb = shapeBounds(SH, f.side.body);
    var roof = shapeBounds(SH, f.top.roof), ws = shapeBounds(SH, f.side.windshield);
    var H = sb ? sb.maxY : num(d.height, 1.3);
    S.beltY = gh ? gh.minY : lerp(S.rh, H, 0.62);
    S.xA = gh ? Math.min(S.xF - 0.3, gh.maxX + dx) : S.xF - S.fo - 0.3;
    S.xC = gh ? Math.max(S.xR + 0.1, gh.minX + dx) : S.xRA;
    if (S.openTop) { S.xR0 = ws ? ws.minX + dx : S.xA - 0.45; S.xR1 = S.xR0 - 0.1; }
    else if (roof) { S.xR0 = roof.maxX + dx; S.xR1 = roof.minX + dx; }
    else { S.xR0 = lerp(S.xA, S.xC, 0.3); S.xR1 = lerp(S.xA, S.xC, 0.75); }
    S.xR0 = Math.min(S.xR0, S.xA - 0.1); S.xR1 = Math.min(S.xR1, S.xR0 - 0.1); S.xC = Math.min(S.xC, S.xR1);
    S.H = H;
    S.roofY = S.openTop ? (gh ? gh.maxY : H) : (smp.top((S.xR0 + S.xR1) / 2, 0) || H);
    S.noseY = smp.top(S.xF - Math.min(0.15, S.fo * 0.2), 0) || lerp(S.rh, H, 0.45);
    S.deckY = smp.top(S.xR + Math.min(0.3, S.ro * 0.35), 0) || S.noseY;
    S.tailY = S.deckY; S.cowlY = S.beltY;
    S.rN = Math.min(0.5, S.fo * 0.6); S.rT = Math.min(0.5, S.ro * 0.6);
    S.doorMid = ((S.xFA - S.front.Ra) + (S.xRA + S.rear.Ra)) / 2;
    S.shut = [S.xFA - S.front.Ra - 0.05, S.doorMid - 0.5];
    S.pillars = [];
    // ---- driver & cameras from the real greenhouse
    var st = S.st, single = S.seats === 1;
    S.zDrv = single ? 0 : -Math.min(0.38, S.hw * 0.4);
    var eyeX = S.openTop ? S.xR0 - 0.42 : S.xR0 - Math.min(0.42, Math.max(0.22, (S.xR0 - S.xR1) * 0.35));
    if (S.style === 'van' || S.style === 'suv' || S.style === 'pickup') eyeX = S.xR0 - 0.3;
    eyeX = clamp(eyeX, S.xRA + 0.2, S.xFA - 0.3);
    var hip = Math.max(S.rh + 0.05 + st.hipH, S.beltY - 0.62);
    var roofAtEye = S.openTop ? S.roofY + 0.25 : (smp.top(eyeX, Math.abs(S.zDrv)) || S.roofY) - 0.1;
    var lo = S.beltY + 0.1, hi = Math.max(lo, roofAtEye - 0.02);
    S.eye = [eyeX, clamp(hip + 0.7, lo, hi), S.zDrv];
    S.hip = hip;
    return true;
  }
  /** low LOD body (< 250 tris): 12 stations x 10-vertex rings sampled from the real sections' outer silhouette
      (wheel wells ignored), capped, vertex coloured (paint / dark glass / underside) */
  function shapeLowBody(S, G) {
    var smp = S.shape, n = 14, x0 = smp.x0 + 0.004, x1 = smp.x1 - 0.004, rows = [], i, k;
    var glassC = [0.025, 0.03, 0.04, 1], under = [0.015, 0.015, 0.016, 1];
    var xA = clamp(S.xA, x0 + 0.6, x1 - 0.2), xC = clamp(S.xC, x0 + 0.2, xA - 0.4);
    var xsL = [x0, x0 + 0.08, lerp(x0, xC, 0.4), lerp(x0, xC, 0.75), xC, lerp(xC, xA, 0.25), lerp(xC, xA, 0.5), lerp(xC, xA, 0.75), xA,
      lerp(xA, x1, 0.3), lerp(xA, x1, 0.62), lerp(xA, x1, 0.85), x1 - 0.08, x1];
    n = xsL.length;
    for (i = 0; i < n; i++) {
      var x = xsL[i], r = smp.ringAt(x);
      if (!r) continue;
      var yb = Infinity, yt = smp.top(x, 0);
      for (k = 0; k < r.length; k++) if (r[k][1] < yb) yb = r[k][1];
      if (yt === null) yt = yb + 0.3;
      var h = Math.max(0.05, yt - yb), hw = smp.halfW(x), half = [[0, yb]];
      var yB = Math.min(S.beltY - 0.005, yb + 0.8 * h);
      var hs = [yb + 0.12 * h, yb + 0.55 * (yB - yb), yB, yB + 0.62 * (yt - yB)];
      for (k = 0; k < hs.length; k++) {
        var zz = smp.side(x, hs[k]);
        half.push([zz === null ? hw * (k === hs.length - 1 ? 0.5 : 0.95) : zz, hs[k]]);
      }
      half.push([0, yt]);
      var row = [];
      for (k = 0; k < half.length; k++) row.push([x, half[k][1], half[k][0]]);
      for (k = half.length - 2; k >= 1; k--) row.push([x, half[k][1], -half[k][0]]);
      rows.push(row);
    }
    if (rows.length < 3) return;
    var J = rows[0].length;
    function colOf(P, j) {
      if (j === 0) return under;
      var jj = j > J >> 1 ? J - j : j;
      if (!S.openTop && jj >= 4 && P[1] > S.beltY + 0.02 && P[0] < S.xA + 0.02 && P[0] > S.xC - 0.02 && (jj !== (J >> 1) || (P[0] > S.xR0 || P[0] < S.xR1))) return glassC;
      return S.paintRGBA;
    }
    emitGrid(rows, { wrapJ: true, outward: null, flip: true, geos: G, bucket: function () { return 'paint'; }, color: function (key, ii, jj) { return colOf(rows[ii][jj], jj); } });
    // end caps (fans)
    [0, rows.length - 1].forEach(function (ri) {
      var ring = rows[ri], c = [0, 0, 0], dir = ri === 0 ? -1 : 1;
      ring.forEach(function (p) { c[0] += p[0] / J; c[1] += p[1] / J; c[2] += p[2] / J; });
      var b = G.paint.verts();
      G.paint.vert(c[0] + dir * 0.004, c[1], c[2], dir, 0, 0, 0, 0, S.paintRGBA);
      for (k = 0; k < J; k++) G.paint.vert(ring[k][0], ring[k][1], ring[k][2], dir, 0, 0, 0, 0, k === 0 ? under : S.paintRGBA);
      for (k = 0; k < J; k++) G.paint.tri(b, b + 1 + k, b + 1 + (k + 1) % J);
    });
  }
  /** closed polygons of a view slot as point lists, a-axis shifted by da (side view: car-local x) */
  function slotPolys(SH, slot, da, mapFn) {
    var out = [];
    try {
      SH.items(slot || null).forEach(function (it) {
        if (!it || !it.path) return;
        SH.flatten(it.path, 6).forEach(function (pl) {
          if (pl.closed === false || !pl.pts || pl.pts.length < 3) return;
          out.push(pl.pts.map(function (q) { if (mapFn) q = mapFn([q[0], q[1]]) || q; return [q[0] + (da || 0), q[1]]; }));
        });
      });
    } catch (e) { /* malformed path */ }
    return out;
  }
  function inPolys(polys, a, b) {
    for (var k = 0; k < polys.length; k++) {
      var pts = polys[k], inside = false;
      for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        var p = pts[i], q = pts[j];
        if ((p[1] > b) !== (q[1] > b) && a < (q[0] - p[0]) * (b - p[1]) / (q[1] - p[1] + 1e-12) + p[0]) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }
  /** smooth the loft normals (two passes over the ring and station neighbours) before they are emitted: removes the
      crumpled-foil reflections between decimated stations. Crease vertices (doubled ring vertices, i.e. a ring
      neighbour at the same position) only smooth along x; any neighbour more than 35 deg off is ignored. */
  function smoothLoftNormals(m, S2, N) {
    var Pp = m.positions, cosLim = Math.cos(35 * DEG), i, j, c, pass;
    var crease = new Uint8Array(S2 * N);
    for (i = 0; i < S2; i++) for (j = 0; j < N; j++) {
      var v0 = (i * N + j) * 3;
      for (c = -1; c <= 1; c += 2) {
        var w0 = (i * N + (j + c + N) % N) * 3;
        if (Math.abs(Pp[v0] - Pp[w0]) + Math.abs(Pp[v0 + 1] - Pp[w0 + 1]) + Math.abs(Pp[v0 + 2] - Pp[w0 + 2]) < 1e-5) crease[i * N + j] = 1;
      }
    }
    var src = m.normals, out = null;
    // wide kernel along x (stations are where the waviness lives), narrow around the ring (keeps the shoulders crisp)
    var nb = [[-1, 0, 0.55], [1, 0, 0.55], [-2, 0, 0.32], [2, 0, 0.32], [-3, 0, 0.14], [3, 0, 0.14], [0, -1, 0.4], [0, 1, 0.4]];
    for (pass = 0; pass < 3; pass++) {
      out = new Float32Array(src.length);
      out.set(src);
      for (i = 0; i < S2; i++) {
        for (j = 0; j < N; j++) {
          var v = (i * N + j) * 3, nx = src[v], ny = src[v + 1], nz = src[v + 2], l0 = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (l0 < 0.5) continue;
          var ax = nx / l0, ay = ny / l0, az = nz / l0, sx = ax, sy = ay, sz = az, cr = crease[i * N + j];
          for (c = 0; c < nb.length; c++) {
            var ii = i + nb[c][0], jj = j + nb[c][1];
            if (ii < 0 || ii >= S2) continue;
            if (nb[c][1] !== 0) { if (cr) continue; jj = (jj + N) % N; if (crease[ii * N + jj]) continue; }
            var w = ((ii * N) + jj) * 3, bx = src[w], by = src[w + 1], bz = src[w + 2], l1 = Math.sqrt(bx * bx + by * by + bz * bz);
            if (l1 < 0.5) continue;
            bx /= l1; by /= l1; bz /= l1;
            if (ax * bx + ay * by + az * bz < cosLim) continue;
            sx += bx * nb[c][2]; sy += by * nb[c][2]; sz += bz * nb[c][2];
          }
          var l2 = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
          out[v] = sx / l2; out[v + 1] = sy / l2; out[v + 2] = sz / l2;
        }
      }
      src = out;
    }
    return out;
  }
  /** final loft normals: the analytic surface normals (loftNormals: exact ring tangent x fitted station slope, so a
      decimated 10-16 cm span still shades like the dense curved surface) where they agree with the faceted mesh
      normal within ~70 deg, the mesh normal elsewhere and on the two bumper-face stations (their cap fans); then the
      crease-aware smoothing pass (smoothLoftNormals) only where no analytic normal exists. */
  function shapeNormals(m, secs) {
    var S2 = secs.length, N = m.ringVerts || secs[0].ring.length, AN = null;
    try { AN = loftNormals(secs); } catch (e) { AN = null; }
    if (!AN) return smoothLoftNormals(m, S2, N);
    var raw = m.normals, mix = new Float32Array(raw.length), lim = Math.cos(70 * DEG);
    mix.set(raw);
    for (var i = 1; i < S2 - 1; i++) for (var j = 0; j < N; j++) {
      var v = (i * N + j) * 3, ax = AN[v], ay = AN[v + 1], az = AN[v + 2];
      if (ax * ax + ay * ay + az * az < 0.5) continue;
      var rx = raw[v], ry = raw[v + 1], rz = raw[v + 2], rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
      if ((ax * rx + ay * ry + az * rz) / rl < lim) continue;     // twisted span (vertex hand-over): keep the facet normal
      mix[v] = ax; mix[v + 1] = ay; mix[v + 2] = az;
    }
    return smoothLoftNormals({ positions: m.positions, normals: mix }, S2, N);
  }
  /** lofted body -> vertex-coloured buckets (paint / roof / trim / carbon / lights), glass shell -> G.glass */
  function shapeBodyMesh(S, G, low) {
    var m = S.shapeMesh, secs = S.shapeSecs, dx = S.shapeDx, P = m.positions, Nn = m.normals, U = m.uvs;
    if (!low && !m._smoothed && m.normals && m.normals.length >= secs.length * (m.ringVerts || secs[0].ring.length) * 3) {
      try { m.normals = shapeNormals(m, secs); m._smoothed = true; Nn = m.normals; } catch (e) { /* keep the loft normals */ }
    }
    var SHL = shapeLib(), fitS = S.shapeFit.side || {};
    // side glass from the model's greenhouse / window outline (crisp, unlike the per-quad loft flags)
    var ghPolys = low ? [] : slotPolys(SHL, fitS.greenhouse, dx);
    if (!ghPolys.length && !low) ghPolys = slotPolys(SHL, fitS.windows, dx);
    S.sideGlassPolys = ghPolys;
    // closed cars: windscreen and backlight come from the front / rear greenhouse as decals (shapeDetails)
    S.endGlassDecals = !low && !S.openTop && !!G.glass && SHL.items((S.shapeFit.front || {}).greenhouse || null).length > 0 && SHL.items((S.shapeFit.rear || {}).greenhouse || null).length > 0;
    S.screenDecal = !low && S.openTop && !!G.glass && SHL.items((S.shapeFit.front || {}).greenhouse || null).length > 0;     // open tops: the windscreen only
    // open tops: roll hoops / seat-back humps behind the cabin in black trim (side-view rollHoops + rollHoop details)
    var hoopPolys = [];
    if (!low && S.openTop) {
      hoopPolys = slotPolys(SHL, fitS.rollHoops, dx);
      (S.shapeFit.details || []).forEach(function (dt) { if (dt && dt.view === 'side' && dt.role === 'rollHoop' && dt.path) hoopPolys = hoopPolys.concat(slotPolys(SHL, dt.path, dx)); });
    }
    // two-tone (ID. Buzz style): the region above model.twoTone.side in the contrast colour
    // (model.twoTone is authored in reference coordinates: map it through the fit like any attachment)
    var tt = (S.shapeModel && S.shapeModel.twoTone) || null, fm = S.shapeFit._map || {};
    var ttSide = tt && !low ? slotPolys(SHL, tt.side, dx, fm.side) : [], ttFront = tt && !low ? slotPolys(SHL, tt.front, 0, fm.front) : [], ttRear = tt && !low ? slotPolys(SHL, tt.rear, 0, fm.rear) : [];
    // the contrast upper body is painted on the loft itself, split exactly along the two-tone line (per-vertex classes
    // + bisected boundary below): no decal shards on the screen pillars / roof rails
    var ttCol = ttSide.length || ttFront.length ? (S.twoToneColor || [0.86, 0.86, 0.84]).concat([1]) : null;
    S.twoToneBody = !!ttCol;
    if (ttCol) {
      S.ttRGBA = ttCol;
      S.ttAt = ttAt;
    }
    // above the front / rear two-tone panels (screen surround, cowl, tailgate header): the upper colour too
    var ttFTop = -Infinity, ttRTop = -Infinity;
    ttFront.forEach(function (q) { q.forEach(function (p) { ttFTop = Math.max(ttFTop, p[1]); }); });
    ttRear.forEach(function (q) { q.forEach(function (p) { ttRTop = Math.max(ttRTop, p[1]); }); });
    function ttAt(x, y, z, nx) {
      return inPolys(ttSide, x, y) || (nx > 0.45 && inPolys(ttFront, z, y)) || (nx < -0.45 && inPolys(ttRear, z, y)) ||
        (nx > 0.1 && y > ttFTop - 0.01 && x > S.xR0 - 0.05) || (nx < -0.1 && y > ttRTop - 0.01 && x < S.xR1 + 0.05);
    }
    var N = m.ringVerts || secs[0].ring.length, S2 = secs.length, flagged = secs.some(function (s) { return s.glass; });
    var roofB = shapeBounds(shapeLib(), S.shapeFit.top.roof);
    var under = [0.015, 0.015, 0.016, 1], well = [0.02, 0.02, 0.022, 1], glassUnder = [0.012, 0.013, 0.016, 1];
    var roofKey = null, roofCol = null;
    if (!low && !S.openTop && roofB && S.roof !== 'body') {
      if (S.roof === 'carbon') { roofKey = 'carbon'; roofCol = WHITE; }
      else if (S.roof === 'glass') { roofKey = 'glassroof'; roofCol = glassUnder; }
      else { roofKey = 'roof'; roofCol = S.roofColor.concat([1]); }
    }
    var maps = {};
    function vid(key, tag, col, v) {
      var mk = key + '|' + tag, mp = maps[mk] || (maps[mk] = {});
      if (mp[v] !== undefined) return mp[v];
      var g = G[key], nx = Nn[v * 3], ny = Nn[v * 3 + 1], nz = Nn[v * 3 + 2], nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 0.5) { nx = P[v * 3] > 0 ? 1 : -1; ny = 0; nz = 0; } else { nx /= nl; ny /= nl; nz /= nl; }   // degenerate (cap) vertices
      mp[v] = g.vert(P[v * 3] + dx, P[v * 3 + 1], P[v * 3 + 2], nx, ny, nz, U[v * 2] * 4, U[v * 2 + 1] * 4, col);
      return mp[v];
    }
    var archs = [S.archF, S.archR], smpW = function (x) { return S.shape.halfW(x); };
    var roofTris = [];
    // Per-VERTEX surface classes (glass backing / underside / wheel well / section paint flags / roll hoop / roof /
    // two-tone / paint); a triangle whose corners disagree is split exactly along the class boundary: the crossing
    // on each edge is found by bisection of the classifier along the edge, so polygon masks (window outline, two-tone
    // split line, arch circle) cut the loft along the real outline instead of a saw-tooth of whole triangles. Discrete
    // section flags switch at the edge midpoint (the old marching-triangle split).
    var hasPF = secs.some(function (s) { return s.paint && s.paint.length === N; });
    var VP = Array.prototype.slice.call(P), VN = Array.prototype.slice.call(Nn), VU = Array.prototype.slice.call(U);
    var nv0 = VP.length / 3, vPk = [], vGf = [], vBelt = [], vCls = [], I0 = m.indices, v;
    for (v = 0; v < nv0; v++) {
      if (v < S2 * N) {
        var sv = secs[(v / N) | 0];
        vPk.push(hasPF && sv.paint ? sv.paint[v % N] || 'body' : 'body'); vGf.push(sv.glass ? (sv.glass[v % N] ? 1 : 0) : 0); vBelt.push(sv.belt == null ? null : sv.belt);
      } else { vPk.push('body'); vGf.push(0); vBelt.push(null); }
    }
    // loft groups without per-section paint flags (no window outline): the group paint per vertex
    if (!hasPF && !ghPolys.length && m.groups && m.groups.length > 1) {
      m.groups.forEach(function (grp) {
        if (!grp.paint || grp.paint === 'body') return;
        for (var t = 0; t < grp.indices.length; t++) vPk[grp.indices[t]] = grp.paint;
      });
    }
    function clsAt(x, y, z, nx, ny, nz, pk, gf, belt) {
      var X = x + dx, az = Math.abs(z), glass;
      if (ghPolys.length && Math.abs(nz) > 0.35 && y > S.beltY - 0.15) glass = inPolys(ghPolys, X, y);
      else if (flagged) glass = !!gf;
      else glass = belt != null && y > belt + 0.02 && ny <= 0.93;
      if (glass) return 'g';
      if (ny < -0.82 && y < S.rh + 0.1) return 'u';
      for (var k = 0; k < 2; k++) {
        var A = archs[k];
        if (ny < 0.35 && Math.hypot(X - A.x, y - A.y) < A.r * 1.04 && az > 0.05 && nz * (z < 0 ? -1 : 1) < 0.2 && az < smpW(X) - 0.05) return 'w';
      }
      if (SHAPE_PAINT[pk]) return 'P:' + pk;
      if (hoopPolys.length && y > S.beltY - 0.04 && inPolys(hoopPolys, X, y)) return 'h';
      if (roofKey && ny > 0.6 && y > S.beltY + 0.08 && X < roofB.maxX + dx - 0.04 && X > roofB.minX + dx + 0.04 && az < roofB.maxY * 0.94) return 'r';
      if (ttCol && ttAt(X, y, z, nx)) return 't';
      return 'b';
    }
    function cls(v) {
      if (vCls[v] === undefined) vCls[v] = clsAt(VP[v * 3], VP[v * 3 + 1], VP[v * 3 + 2], VN[v * 3], VN[v * 3 + 1], VN[v * 3 + 2], vPk[v], vGf[v], vBelt[v]);
      return vCls[v];
    }
    function clsLerp(a, b, t) {
      var nx = lerp(VN[a * 3], VN[b * 3], t), ny = lerp(VN[a * 3 + 1], VN[b * 3 + 1], t), nz = lerp(VN[a * 3 + 2], VN[b * 3 + 2], t), nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl > 1e-6) { nx /= nl; ny /= nl; nz /= nl; }
      var s = t < 0.5 ? a : b;
      return clsAt(lerp(VP[a * 3], VP[b * 3], t), lerp(VP[a * 3 + 1], VP[b * 3 + 1], t), lerp(VP[a * 3 + 2], VP[b * 3 + 2], t), nx, ny, nz, vPk[s], vGf[s], vBelt[s]);
    }
    function newVert(a, b, t) {
      var id = VP.length / 3, s = t < 0.5 ? a : b;
      for (var c = 0; c < 3; c++) VP.push(lerp(VP[a * 3 + c], VP[b * 3 + c], t));
      var nx = lerp(VN[a * 3], VN[b * 3], t), ny = lerp(VN[a * 3 + 1], VN[b * 3 + 1], t), nz = lerp(VN[a * 3 + 2], VN[b * 3 + 2], t), nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      VN.push(nx / nl, ny / nl, nz / nl);
      VU.push(lerp(VU[a * 2], VU[b * 2], t), lerp(VU[a * 2 + 1], VU[b * 2 + 1], t));
      vPk.push(vPk[s]); vGf.push(vGf[s]); vBelt.push(vBelt[s]);
      return id;
    }
    var xmap = {};
    /** the class boundary on edge a-b (canonical direction, shared by both triangles of the edge) */
    function cross(a, b) {
      var lo0 = Math.min(a, b), hi0 = Math.max(a, b), k = lo0 + '_' + hi0;
      if (xmap[k] !== undefined) return xmap[k];
      var c0 = cls(lo0), lo = 0, hi = 1;
      // discrete flags only: the midpoint (exactly the old split); masks: bisection to ~1/256 of the edge
      for (var it = 0; it < 8; it++) { var t = (lo + hi) / 2; if (clsLerp(lo0, hi0, t) === c0) lo = t; else hi = t; }
      return (xmap[k] = newVert(lo0, hi0, (lo + hi) / 2));
    }
    var mmap = {};
    function midV(a, b) { var k = Math.min(a, b) + '_' + Math.max(a, b); if (mmap[k] === undefined) mmap[k] = newVert(Math.min(a, b), Math.max(a, b), 0.5); return mmap[k]; }
    var out = {};
    function put(c, a, b, d) { (out[c] = out[c] || []).push(a, b, d); }
    function proc(a, b, c, ca, cb, cc, depth) {
      if (ca === cb && cb === cc) { put(ca, a, b, c); return; }
      if (ca !== cb && cb !== cc && ca !== cc) {
        if (depth < 2) {
          var ab = midV(a, b), bc = midV(b, c), caM = midV(c, a), kab = cls(ab), kbc = cls(bc), kca = cls(caM);
          proc(a, ab, caM, ca, kab, kca, depth + 1); proc(ab, b, bc, kab, cb, kbc, depth + 1);
          proc(caM, bc, c, kca, kbc, cc, depth + 1); proc(ab, bc, caM, kab, kbc, kca, depth + 1);
        } else put(ca !== 'b' ? ca : cb, a, b, c);
        return;
      }
      // rotate so the odd corner is first: (odd, x, y) with x / y sharing a class; winding kept
      var o0 = a, o1 = b, o2 = c, po = ca, pr = cb;
      if (cb !== ca && cb !== cc) { o0 = b; o1 = c; o2 = a; po = cb; pr = ca; }
      else if (cc !== ca && cc !== cb) { o0 = c; o1 = a; o2 = b; po = cc; pr = ca; }
      var m1 = cross(o0, o1), m2 = cross(o0, o2);
      put(po, o0, m1, m2);
      put(pr, m1, o1, o2); put(pr, m1, o2, m2);
    }
    if (!low) for (var ti = 0; ti < I0.length; ti += 3) proc(I0[ti], I0[ti + 1], I0[ti + 2], cls(I0[ti]), cls(I0[ti + 1]), cls(I0[ti + 2]), 0);
    else out.b = Array.prototype.slice.call(I0);
    P = VP; Nn = VN; U = VU;
    var lowDark = [0.02, 0.02, 0.022, 1];
    Object.keys(out).forEach(function (c) {
      var I = out[c], key = 'paint', tag = 'p', col = S.paintRGBA, isRoofGlass = false;
      if (c === 'g') { key = low ? 'paint' : 'trimG'; tag = 'g'; col = low ? [0.025, 0.03, 0.04, 1] : glassUnder; }
      else if (c === 'u') { key = low ? 'paint' : 'trimG'; tag = 'u'; col = under; }
      else if (c === 'w') { key = low ? 'paint' : 'trimG'; tag = 'w'; col = well; }
      else if (c.indexOf('P:') === 0) {
        var pk = c.slice(2), pm = SHAPE_PAINT[pk];
        if (!low) { key = pm[0]; tag = pk; col = pm[1]; } else { tag = pk; col = pm[0] === 'trimG' || pm[0] === 'carbon' ? lowDark : pm[1]; }
      }
      else if (c === 'h') { key = 'trimG'; tag = 'h'; col = [0.018, 0.018, 0.02, 1]; }
      else if (c === 'r') {
        if (roofKey === 'glassroof') { key = 'trimG'; tag = 'g'; col = glassUnder; isRoofGlass = true; }
        else { key = roofKey; tag = 'r'; col = roofCol; }
      }
      else if (c === 't') { tag = 't'; col = ttCol; }
      if (!G[key]) { key = 'paint'; col = S.paintRGBA; }
      for (var t = 0; t < I.length; t += 3) {
        G[key].tri(vid(key, tag, col, I[t]), vid(key, tag, col, I[t + 1]), vid(key, tag, col, I[t + 2]));
        if (isRoofGlass) roofTris.push(I[t], I[t + 1], I[t + 2]);
      }
    });
    if (low) return;
    // greenhouse glass shell (4 mm proud) + panoramic roof glass
    // where the screen / backlight decals take over (faces looking along the car), the shell's coverage fades out
    // per vertex (vertex alpha scales the glass coverage in the shader) instead of whole triangles being dropped
    // (stair-stepped cut where the windscreen meets the roof)
    var gm = m.glass, gp = gm.positions, gn = gm.normals, gi = gm.indices, base = G.glass.verts(), gA = new Float32Array(gp.length / 3);
    for (var i = 0; i < gp.length; i += 3) {
      var gl0 = Math.sqrt(gn[i] * gn[i] + gn[i + 1] * gn[i + 1] + gn[i + 2] * gn[i + 2]);
      var vnx = gl0 < 0.5 ? 0 : gn[i] / gl0, ga = 1;
      if (S.endGlassDecals || S.screenDecal) ga = 1 - sstep(0.18, 0.34, S.endGlassDecals ? Math.abs(vnx) : vnx);
      // side windows come from the model outline (shapeDetails): the shell fades out on side-facing faces too
      // (inside the side window outline the decals own every face turned >= ~20 deg sideways: no second glass layer)
      if (ghPolys.length && gl0 >= 0.5) {
        var vnz = Math.abs(gn[i + 2] / gl0);
        if (inPolys(ghPolys, gp[i] + dx, gp[i + 1])) ga *= 1 - sstep(0.2, 0.34, vnz);
        else ga *= 1 - sstep(0.22, 0.36, vnz) * (1 - sstep(0.5, 0.65, gn[i + 1] / gl0));
      }
      gA[i / 3] = ga;
      G.glass.vert(gp[i] + dx, gp[i + 1], gp[i + 2], vnx, gl0 < 0.5 ? 1 : gn[i + 1] / gl0, gl0 < 0.5 ? 0 : gn[i + 2] / gl0, 0, 0, ga >= 1 ? WHITE : [1, 1, 1, ga]);
    }
    for (i = 0; i < gi.length; i += 3) {
      if (gA[gi[i]] + gA[gi[i + 1]] + gA[gi[i + 2]] < 0.02) continue;
      G.glass.tri(base + gi[i], base + gi[i + 1], base + gi[i + 2]);
    }
    if (roofTris.length) {
      var rm = {};
      for (i = 0; i < roofTris.length; i += 3) {
        var ids = [roofTris[i], roofTris[i + 1], roofTris[i + 2]].map(function (v) {
          if (rm[v] === undefined) rm[v] = G.glass.vert(P[v * 3] + dx + Nn[v * 3] * 0.004, P[v * 3 + 1] + Nn[v * 3 + 1] * 0.004, P[v * 3 + 2] + Nn[v * 3 + 2] * 0.004, Nn[v * 3], Nn[v * 3 + 1], Nn[v * 3 + 2], 0, 0, WHITE);
          return rm[v];
        });
        G.glass.tri(ids[0], ids[1], ids[2]);
      }
    }
  }
  /* ---------------------------------------------------------------- showroom details on the real body */
  /** remap the uvs of the vertices v0.. of geo g into a lamp texture box (view-plane bounds b: u inboard..outboard,
      v top..bottom). Side views run u along x. */
  function lampUV(g, v0, b, view) {
    if (!b || !(b.w > 1e-4) || !(b.h > 1e-4)) return;
    var T = g.t, c = (b.minX + b.maxX) / 2;
    for (var k = v0 * 2; k < T.length; k += 2) {
      var a = T[k], y = T[k + 1], u;
      if (view === 'side') u = (a - b.minX) / b.w;
      else u = c >= 0 ? (a - b.minX) / b.w : (b.maxX - a) / b.w;
      T[k] = clamp01(u); T[k + 1] = clamp01((b.maxY - y) / b.h);
    }
  }
  /** number plate uvs from the raw view-plane coords: the plate map reads upright and left to right from the
      viewer's side (independent of which side of the centre line the outline's centre falls, unlike lampUV) */
  function plateUV(g, v0, b, view) {
    if (!b || !(b.w > 1e-4) || !(b.h > 1e-4)) return;
    var T = g.t;
    for (var k = v0 * 2; k < T.length; k += 2) {
      var u = clamp01((T[k] - b.minX) / b.w), v = clamp01((b.maxY - T[k + 1]) / b.h);
      T[k] = view === 'front' ? 1 - u : u; T[k + 1] = v;      // seen from ahead, +z runs right to left
    }
  }
  /** strip polygons (view plane) of a stroke path: open polylines -> ribbons, closed outlines -> centred rings */
  function strokePolys(SH, path, w) {
    var out = [];
    try {
      SH.flatten(path, 5).forEach(function (pl) {
        var pts = [];
        (pl.pts || []).forEach(function (q) { var l = pts[pts.length - 1]; if (!l || Math.abs(l[0] - q[0]) + Math.abs(l[1] - q[1]) > 1e-5) pts.push([q[0], q[1]]); });
        if (pts.length < 2) return;
        if (pl.closed === false || pts.length < 3) { var rb = strokeRibbon(pts, w); if (rb) out.push({ pts: rb }); return; }
        var f0 = pts[0], fl = pts[pts.length - 1];
        if (Math.abs(f0[0] - fl[0]) + Math.abs(f0[1] - fl[1]) < 1e-5) pts.pop();
        var inner = pts.length >= 3 ? offsetPoly(pts, -w / 2) : null;
        if (inner) out.push({ pts: inner, ring: w });
      });
    } catch (e) { /* malformed path */ }
    return out;
  }
  /** panel gaps as recessed strips: a near-black core over a wider darkened-paint bevel (the shadowed edges) */
  function shapePanelLines(S, G) {
    var SH = shapeLib(), f = S.shapeFit, base = 0.0045;
    var core = [0.003, 0.003, 0.0035, 1], bevel = cscale(S.paint, 0.3).concat([1]);
    var O = { minDot: 0.1, stretch: 3, maxEdge: 0.06, force: true, depth: 3, extraDepth: 2, tol: 0.0004 };
    function lines(slot, view) {
      SH.items(slot || null).forEach(function (it) {
        if (!it || !it.path) return;
        [[0.0085, 'paint', bevel, base - 0.0014], [0.0032, 'trimG', core, base - 0.0007]].forEach(function (L) {
          strokePolys(SH, it.path, L[0]).forEach(function (sp) {
            shapeDecal(S, G, null, view, L[1], L[2], L[3], Object.assign({ polys: [sp.pts], ttCol: S.ttRGBA && L[1] === 'paint' ? cscale(S.ttRGBA, 0.3).concat([1]) : null }, O, sp.ring ? { ring: sp.ring } : null));
          });
        });
      });
    }
    var sd = f.side || {};
    lines(sd.doorCuts, 'side'); lines(sd.panelLines, 'side');
    lines((f.front || {}).panelLines, 'front'); lines((f.rear || {}).panelLines, 'rear');
    lines((f.top || {}).panelLines, 'top');
  }
  /** 3D door handles (side-view `handle` details): a dark recess pocket on the skin + a raised pull bar */
  function shapeHandles(S, G) {
    var SH = shapeLib(), f = S.shapeFit, smp = S.shape, dx = S.shapeDx, base = 0.0045;
    (f.details || []).forEach(function (dt) {
      if (!dt || dt.view !== 'side' || dt.role !== 'handle' || !dt.path) return;
      var b = SH.bounds(dt.path);
      if (!b || b.empty || b.w < 0.03 || b.w > 0.45 || b.h > 0.12) return;
      var p = dt.paint || 'body', key = p === 'chrome' ? 'chrome' : p === 'body' ? 'paint' : 'trimG';
      var col = key === 'paint' ? S.paintRGBA : key === 'chrome' ? [0.86, 0.87, 0.89, 1] : [0.012, 0.012, 0.014, 1];
      var cx = (b.minX + b.maxX) / 2 + dx, cy = (b.minY + b.maxY) / 2, hw = b.w / 2, hh = Math.max(0.008, Math.min(0.02, b.h / 2));
      var z = smp.side(cx, cy);
      if (z === null) return;
      // recess pocket (slightly larger than the bar, dark) as a decal
      var pk = hw * 1.05, ph = hh * 1.9;
      shapeDecal(S, G, null, 'side', 'trimG', [0.01, 0.01, 0.011, 1], base - 0.0004, { polys: [[[cx - dx - pk, cy - ph], [cx - dx + pk, cy - ph], [cx - dx + pk, cy + ph], [cx - dx - pk, cy + ph]]], minDot: 0.05, stretch: 3, maxEdge: 0.05, force: true });
      [1, -1].forEach(function (sd) {
        var n = smp.normal ? smp.normal(cx, cy, z * sd) : null;
        if (!n) n = [0, 0, sd];
        ellipsoid(G[key], [cx + n[0] * 0.006, cy + n[1] * 0.006, z * sd + n[2] * 0.006], [hw * 0.92, hh * 0.85, 0.0085], 10, 4, function () { return col; });
      });
    });
  }
  /** 3D wiper arms + blades on the windscreen from the top-view `wiper` details */
  function shapeWipers(S, G) {
    if (S.openTop) return;
    var SH = shapeLib(), f = S.shapeFit, smp = S.shape, dx = S.shapeDx, col = [0.008, 0.008, 0.009, 1];
    (f.details || []).forEach(function (dt) {
      if (!dt || dt.view !== 'top' || dt.role !== 'wiper' || !dt.path) return;
      var pts = [];
      slotPolys(SH, dt.path, dx).forEach(function (q) { pts = pts.concat(q); });
      if (pts.length < 2) return;
      var A = pts[0], B = pts[0], best = -1, i, j;
      for (i = 0; i < pts.length; i++) for (j = i + 1; j < pts.length; j++) { var d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]); if (d > best) { best = d; A = pts[i]; B = pts[j]; } }
      if (best < 0.15 || best > 1.3) return;
      if (A[0] < B[0]) { var t = A; A = B; B = t; }      // A = pivot end (forward, at the cowl)
      var path = [], blade = [];
      for (i = 0; i <= 6; i++) {
        var x = lerp(A[0], B[0], i / 6), z = lerp(A[1], B[1], i / 6), y = smp.top(x, Math.abs(z));
        if (y === null) continue;
        var n = (smp.normal && smp.normal(x, y, z)) || [0, 1, 0];
        path.push([x + n[0] * 0.022, y + n[1] * 0.022, z + n[2] * 0.022]);
        blade.push([x + n[0] * 0.01, y + n[1] * 0.01, z + n[2] * 0.01]);
      }
      if (path.length < 3) return;
      tube(G.trimG, path, 0.0055, 5, col, { aspect: 1.6 });
      tube(G.trimG, blade.slice(1), 0.006, 4, col, { aspect: 0.6 });
    });
  }
  /** window trim: a bright-metal (chrome badge on saloons / estates / SUVs) or gloss-black frame round each side window */
  function shapeWindowTrim(S, G) {
    var SH = shapeLib(), f = S.shapeFit, sd = f.side || {};
    if (S.openTop || !SH.items(sd.windows || null).length) return;
    var chrome = S.badge === 'chrome' && /^(sedan|wagon|suv|shooting-brake)$/.test(S.style);
    var key = chrome ? 'chrome' : 'trimG', col = chrome ? [0.8, 0.81, 0.83, 1] : [0.004, 0.004, 0.005, 1];
    SH.items(sd.windows).forEach(function (it) {
      if (!it || !it.path) return;
      shapeDecal(S, G, it.path, 'side', key, col, 0.0045 + 1.15 * 0.003, { minDot: 0.05, stretch: 3, maxEdge: 0.06, ring: chrome ? 0.007 : 0.005, force: true, sideNz: 0.35, yClip: [S.roofY - 0.015, -1] });
    });
  }
  /** model view items -> projected decals (lights, grille, intakes, plates, trims, markers); fills anchors */
  var LAMP_DEPTH = 0.25;     // deepest a front / rear lamp cast reaches into the nose / tail (m)
  /* ---------------------------------------------------------------- lamp units
     Front / rear lamps as real geometry instead of body-following decals: a decal cast onto a sloping wing crown
     inherits every ripple of the loft (blotchy lens reflections, a stretched lamp interior, torn outline tops where
     the ray grazes the crown). A lamp unit fits a smooth quadric face x = F(z, y) through the body under the lamp's
     front / rear-view outline (robust least squares), lifts it just proud of the paint, and builds on it:
       * the lamp interior (lamp map + emissive glow mask, uvs u = inboard..outboard, v = top..bottom of the outline),
       * a black housing wall from the body skin round the outline up to the lamp face,
       * a domed clear cover lens with analytic normals (one clean highlight),
       * DRL / reverse graphics lying inside the outline, emitted on the lamp face.
     Outlines the fit cannot carry (wrapping round a corner, non star-shaped, mostly beyond the silhouette) return
     null and keep the decal path. */
  /** closed polygon resampled to n points evenly by arc length */
  function resampleLoop(pts, n) {
    var m = pts.length, L = [0], i;
    for (i = 1; i <= m; i++) L.push(L[i - 1] + Math.hypot(pts[i % m][0] - pts[i - 1][0], pts[i % m][1] - pts[i - 1][1]));
    var tot = L[m], out = [], j = 0;
    if (!(tot > 1e-6)) return null;
    for (var k = 0; k < n; k++) {
      var d = tot * k / n;
      while (j < m - 1 && L[j + 1] < d) j++;
      var t = (d - L[j]) / ((L[j + 1] - L[j]) || 1), a = pts[j], b = pts[(j + 1) % m];
      out.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t)]);
    }
    return out;
  }
  /** fit a lamp face under a front / rear-view outline (pts: [z, y]); depth = how far behind the bumper extreme the
      lamp may sit. The face is the body under the outline, low-pass filtered (robust gaussian over a ~1.2 cm grid of
      body hits, sigma 2.5 cm): it keeps the wing's large-scale curve but none of the loft's ripples, then is lifted
      just proud of the paint. Returns the face or null (decal fallback). */
  function lampFace(S, pts, view, depth, sigma) {
    function fail() { return null; }      // (one exit for every rejection reason: the caller keeps the decal)
    var smp = S.shape;
    if (!smp || !smp.castX || !pts || pts.length < 3) return fail('input');
    var dir = view === 'front' ? -1 : 1, sg = -dir, end = dir < 0 ? smp.x1 : smp.x0, lim = end + dir * depth, i, j, k;
    var area = polyArea(pts);
    if (!(Math.abs(area) > 3e-4)) return fail('area ' + area);
    var cz = 0, cy = 0;
    for (i = 0; i < pts.length; i++) {
      var p = pts[i], q = pts[(i + 1) % pts.length], cr = p[0] * q[1] - q[0] * p[1];
      cz += (p[0] + q[0]) * cr; cy += (p[1] + q[1]) * cr;
    }
    cz /= 6 * area; cy /= 6 * area;
    if (!ptInPoly([cz, cy], pts)) return fail('centroid');
    function hit(z, y) { return smp.castX(y, z, dir, lim); }
    var per = 0;
    for (i = 0; i < pts.length; i++) per += Math.hypot(pts[(i + 1) % pts.length][0] - pts[i][0], pts[(i + 1) % pts.length][1] - pts[i][1]);
    var M = clamp(Math.round(per / 0.024), 24, 36), ring = resampleLoop(pts, M);
    if (!ring) return fail('ring');
    if (polyArea(ring) < 0) ring.reverse();
    // body hits on a grid over the outline (+1.5 cm), robust gaussian low-pass
    var bb = polyBounds(ring), pad = 0.015, Z0 = bb.minX - pad, Y0 = bb.minY - pad, WZ = bb.w + 2 * pad, WY = bb.h + 2 * pad;
    var nz = clamp(Math.ceil(WZ / 0.012) + 1, 6, 30), ny = clamp(Math.ceil(WY / 0.012) + 1, 6, 30), hz = WZ / (nz - 1), hy = WY / (ny - 1);
    var Hh = new Float64Array(nz * ny), Hs = new Float64Array(nz * ny), ok = new Uint8Array(nz * ny), nok = 0;
    for (j = 0; j < ny; j++) for (i = 0; i < nz; i++) {
      var xg = hit(Z0 + i * hz, Y0 + j * hy);
      if (xg !== null) { Hh[j * nz + i] = xg; ok[j * nz + i] = 1; nok++; }
    }
    if (nok < 12) return fail('grid ' + nok);
    var sig = sigma || 0.025, rI = Math.ceil(2 * sig / hz), rJ = Math.ceil(2 * sig / hy), use = ok.slice(), pass;
    /** |n.x| of the filtered face at grid cell k (1 = facing straight along the car) */
    function cellNx(k) {
      var ci = k % nz, cj = (k / nz) | 0, a0 = Hs[cj * nz + Math.max(0, ci - 1)], a1 = Hs[cj * nz + Math.min(nz - 1, ci + 1)];
      var b0 = Hs[Math.max(0, cj - 1) * nz + ci], b1 = Hs[Math.min(ny - 1, cj + 1) * nz + ci];
      var gz = isFinite(a0) && isFinite(a1) ? (a1 - a0) / (hz * (Math.min(nz - 1, ci + 1) - Math.max(0, ci - 1))) : 0;
      var gy = isFinite(b0) && isFinite(b1) ? (b1 - b0) / (hy * (Math.min(ny - 1, cj + 1) - Math.max(0, cj - 1))) : 0;
      return 1 / Math.sqrt(1 + gz * gz + gy * gy);
    }
    for (pass = 0; pass < 3; pass++) {
      for (j = 0; j < ny; j++) for (i = 0; i < nz; i++) {
        var sw = 0, sx = 0;
        for (var jj = Math.max(0, j - rJ); jj <= Math.min(ny - 1, j + rJ); jj++) for (var ii = Math.max(0, i - rI); ii <= Math.min(nz - 1, i + rI); ii++) {
          var kk = jj * nz + ii;
          if (!use[kk]) continue;
          var ddz = (ii - i) * hz, ddy = (jj - j) * hy, wgt = Math.exp(-0.5 * (ddz * ddz + ddy * ddy) / (sig * sig));
          sw += wgt; sx += wgt * Hh[kk];
        }
        Hs[j * nz + i] = sw > 1e-6 ? sx / sw : NaN;
      }
      if (pass === 2) break;
      // grazing hits (the ray slid along a crown / round the wing side): > 1.2 cm off the filtered face, measured
      // along its normal (a steep wing front moves x a lot for a small normal distance) -> excluded
      for (k = 0; k < nz * ny; k++) use[k] = ok[k] && isFinite(Hs[k]) && Math.abs(Hh[k] - Hs[k]) * cellNx(k) < 0.012 ? 1 : 0;
    }
    // upper envelope: the filtered face is pushed out over every body bump inside it (local max, re-filtered at
    // 1.2 cm) so the paint never pokes through the lamp, without lifting the whole lamp off the wing
    var E = new Float64Array(nz * ny), sig2 = 0.012, rI2 = Math.ceil(2 * sig2 / hz), rJ2 = Math.ceil(2 * sig2 / hy);
    for (pass = 0; pass < 4; pass++) {
      for (k = 0; k < nz * ny; k++) E[k] = ok[k] && isFinite(Hs[k]) ? (sg > 0 ? Math.max(Hs[k], Hh[k]) : Math.min(Hs[k], Hh[k])) : Hs[k];
      for (j = 0; j < ny; j++) for (i = 0; i < nz; i++) {
        if (!isFinite(Hs[j * nz + i])) continue;
        var sw2 = 0, sx2 = 0;
        for (var j2 = Math.max(0, j - rJ2); j2 <= Math.min(ny - 1, j + rJ2); j2++) for (var i2 = Math.max(0, i - rI2); i2 <= Math.min(nz - 1, i + rI2); i2++) {
          var k2 = j2 * nz + i2;
          if (!isFinite(E[k2])) continue;
          var e1 = (i2 - i) * hz, e2 = (j2 - j) * hy, w2 = Math.exp(-0.5 * (e1 * e1 + e2 * e2) / (sig2 * sig2));
          sw2 += w2; sx2 += w2 * E[k2];
        }
        if (sw2 > 1e-6) Hs[j * nz + i] = sx2 / sw2;
      }
    }
    function fx(z, y) {
      var u = clamp((z - Z0) / hz, 0, nz - 1.0001), v = clamp((y - Y0) / hy, 0, ny - 1.0001), i0 = Math.floor(u), j0 = Math.floor(v), tu = u - i0, tv = v - j0;
      var a00 = Hs[j0 * nz + i0], a10 = Hs[j0 * nz + i0 + 1], a01 = Hs[(j0 + 1) * nz + i0], a11 = Hs[(j0 + 1) * nz + i0 + 1];
      if (!isFinite(a00) || !isFinite(a10) || !isFinite(a01) || !isFinite(a11)) return NaN;
      return lerp(lerp(a00, a10, tu), lerp(a01, a11, tu), tv);
    }
    var out = [], xh = [], miss = 0, tk = [], nR = ring.length;
    /** body hit at (z, y) when the filtered face is usable there (hit within 1.2 cm of it, face defined around) */
    function valid(z, y) {
      var x = hit(z, y), f = fx(z, y);
      return x !== null && isFinite(f) && Math.abs(x - f) * Math.abs(nrm(z, y)[0]) < 0.012 && isFinite(fx(z + 0.006, y)) && isFinite(fx(z - 0.006, y)) && isFinite(fx(z, y + 0.006)) && isFinite(fx(z, y - 0.006)) ? x : null;
    }
    // march out from the centre toward every outline point while the face stays usable: a star-shaped, contiguous
    // lamp region (never an island of grazing hits far up the crown); then a cone erosion + 1-2-1 pass so no point
    // sticks out past its neighbours (no spikes, no notches)
    if (valid(cz, cy) === null) {      // centroid on a grazing patch: the nearest usable point inside the outline seeds the fan
      var seed = null, sd2 = Infinity;
      for (j = 0; j < ny; j++) for (i = 0; i < nz; i++) {
        var gz2 = Z0 + i * hz, gy2 = Y0 + j * hy, dd2 = (gz2 - cz) * (gz2 - cz) + (gy2 - cy) * (gy2 - cy);
        if (dd2 < sd2 && use[j * nz + i] && ptInPoly([gz2, gy2], ring) && valid(gz2, gy2) !== null) { sd2 = dd2; seed = [gz2, gy2]; }
      }
      if (!seed || Math.sqrt(sd2) > 0.35 * Math.sqrt(Math.abs(area))) return fail('centre');
      cz = seed[0]; cy = seed[1];
    }
    ring.forEach(function (q0) {
      var sOk = 0;
      for (var s1 = 0.04; s1 <= 1.0001; s1 += 0.04) { if (valid(lerp(cz, q0[0], s1), lerp(cy, q0[1], s1)) === null) break; sOk = s1; }
      tk.push(Math.min(1, sOk));
    });
    var tc = tk.map(function (t0, k3) {
      var m = t0;
      for (var d = 1; d <= 5; d++) m = Math.min(m, tk[(k3 + d) % nR] + 0.1 * d, tk[(k3 - d + nR) % nR] + 0.1 * d);
      return m;
    });
    tc = tc.map(function (t0, k3) { return Math.min(t0, Math.max(0, (tc[(k3 + nR - 1) % nR] + 2 * t0 + tc[(k3 + 1) % nR]) / 4 + 0.01)); });
    ring.forEach(function (q0, k3) {
      var z = lerp(cz, q0[0], tc[k3]), y = lerp(cy, q0[1], tc[k3]), x = tc[k3] >= 0.3 ? hit(z, y) : null;
      if (x === null) { miss++; return; }
      out.push([z, y]); xh.push(x);
    });
    if (miss > M * 0.5 || out.length < 12) return fail('miss ' + miss + '/' + M);
    if (!isFinite(fx(cz, cy))) return fail('centre');
    for (i = 0; i < out.length; i++) {      // star-shaped about the centre (the radial fan needs it)
      var a = out[i], b = out[(i + 1) % out.length];
      if ((a[0] - cz) * (b[1] - cy) - (a[1] - cy) * (b[0] - cz) <= 1e-8) return fail('star');
    }
    // lift (along the face normal): the body may not poke through the face anywhere inside the outline
    var lift = 0, inl = 0, tot = 0;
    for (j = 0; j < ny; j++) for (i = 0; i < nz; i++) {
      k = j * nz + i;
      if (!ok[k] || !ptInPoly([Z0 + i * hz, Y0 + j * hy], out)) continue;
      tot++;
      if (use[k]) inl++;
      lift = Math.max(lift, sg * (Hh[k] - Hs[k]) * cellNx(k));
    }
    if (tot && inl < tot * 0.8) return fail('inliers ' + inl + '/' + tot);
    out.forEach(function (q0, k2) { var f = fx(q0[0], q0[1]); if (isFinite(f)) lift = Math.max(lift, sg * (xh[k2] - f) * Math.abs(nrm(q0[0], q0[1])[0])); });
    if (lift > 0.016) return fail('lift ' + lift.toFixed(4));
    lift += 0.0015;
    function nrm(z, y) {
      var e = 0.006, gz = (fx(z + e, y) - fx(z - e, y)) / (2 * e), gy = (fx(z, y + e) - fx(z, y - e)) / (2 * e);
      if (!isFinite(gz)) gz = 0; if (!isFinite(gy)) gy = 0;
      return vnorm([sg, -sg * gy, -sg * gz]);      // (x, y, z) order: x = f(z, y)
    }
    var n0 = nrm(cz, cy);
    if (Math.abs(n0[0]) < 0.25) return fail('tilt ' + n0[0].toFixed(2));      // a lamp lying on a deck / flank: the decal follows it better
    var face = {
      view: view, sg: sg, cz: cz, cy: cy, pts: out, xh: xh, lift: lift,
      x: function (z, y) { var f = fx(z, y); if (!isFinite(f)) f = fx(lerp(z, cz, 0.3), lerp(y, cy, 0.3)); if (!isFinite(f)) f = fx(cz, cy); return f; },
      n: nrm,
      /** point on the face at (z, y), raised lift + `off` along the face normal */
      at: function (z, y, off) { var nn = nrm(z, y), o2 = off + face.lift; return [face.x(z, y) + nn[0] * o2, y + nn[1] * o2, z + nn[2] * o2]; },
      /** radial fraction of (z, y) between the centre (0) and the outline (1) */
      rad: function (z, y) {
        var dz = z - cz, dy = y - cy, best = Infinity;
        if (Math.abs(dz) + Math.abs(dy) < 1e-9) return 0;
        for (var e2 = 0; e2 < out.length; e2++) {
          var P0 = out[e2], P1 = out[(e2 + 1) % out.length], ex = P1[0] - P0[0], ey = P1[1] - P0[1];
          var den = dz * ey - dy * ex;
          if (Math.abs(den) < 1e-12) continue;
          var t = ((P0[0] - cz) * ey - (P0[1] - cy) * ex) / den, s2 = ((P0[0] - cz) * dy - (P0[1] - cy) * dz) / den;
          if (t > 0 && s2 >= -1e-6 && s2 <= 1 + 1e-6 && t < best) best = t;
        }
        return best === Infinity ? 1 : clamp(1 / best, 0, 1.2);
      }
    };
    return face;
  }
  /** emit 2D triangles (view plane [z, y]) onto a lamp face, uniformly subdivided so long slivers follow the curved
      face; uv from the lamp box b (lampUV convention); offFn(z, y) -> offset along the face normal */
  function faceEmit(face, g, tris, offFn, col, b, maxE, nrmFn) {
    var cache = {}, n0 = g.tris(), c = b ? (b.minX + b.maxX) / 2 : 0;
    function V(z, y) {
      var key = z.toFixed(5) + ',' + y.toFixed(5);
      if (cache[key] !== undefined) return cache[key];
      var off = offFn(z, y), P = face.at(z, y, off), N = nrmFn ? nrmFn(z, y, off) : face.n(z, y), u = 0, v = 0;
      if (b && b.w > 1e-4 && b.h > 1e-4) { u = clamp01(c >= 0 ? (z - b.minX) / b.w : (b.maxX - z) / b.w); v = clamp01((b.maxY - y) / b.h); }
      return (cache[key] = g.vert(P[0], P[1], P[2], N[0], N[1], N[2], u, v, col));
    }
    tris.forEach(function (t) {
      var A = t[0], B = t[1], Cc = t[2];
      var em = Math.max(Math.hypot(A[0] - B[0], A[1] - B[1]), Math.hypot(B[0] - Cc[0], B[1] - Cc[1]), Math.hypot(Cc[0] - A[0], Cc[1] - A[1]));
      var k = clamp(Math.ceil(em / (maxE || 0.04)), 1, 3), i, j;
      function P(i2, j2) { var a = i2 / k, bb = j2 / k; return V(A[0] + (B[0] - A[0]) * a + (Cc[0] - A[0]) * bb, A[1] + (B[1] - A[1]) * a + (Cc[1] - A[1]) * bb); }
      for (i = 0; i < k; i++) for (j = 0; j < k - i; j++) {
        g.tri(P(i, j), P(i + 1, j), P(i, j + 1));
        if (j < k - i - 1) g.tri(P(i + 1, j), P(i + 1, j + 1), P(i, j + 1));
      }
    });
    return g.tris() - n0;
  }
  /** radial fan triangles of a face's outline (rings at the given radial fractions; t = 0 is the centre) */
  function faceFan(face, rings) {
    var out = face.pts, n = out.length, T = [], C = [face.cz, face.cy];
    function P(t, k) { var q = out[k % n]; return [lerp(C[0], q[0], t), lerp(C[1], q[1], t)]; }
    for (var r = 1; r < rings.length; r++) {
      for (var k = 0; k < n; k++) {
        var a0 = P(rings[r - 1], k), a1 = P(rings[r - 1], k + 1), b0 = P(rings[r], k), b1 = P(rings[r], k + 1);
        if (r === 1 && rings[0] === 0) T.push([a0, b0, b1]);
        else { T.push([a0, b0, b1]); T.push([a0, b1, a1]); }
      }
    }
    return T;
  }
  /** the lamp unit of one outline: interior (key), housing wall (trimG), cover lens (lens). Returns the face. */
  function lampUnit(S, G, pts, view, key, col, b, depth, lensOn, extra) {
    // a tightly curved wing (911 / sports-car lamps on the wing front) gets a second, finer filter
    var face = lampFace(S, pts, view, depth, 0.025) || lampFace(S, pts, view, depth, 0.013);
    if (!face || !G[key]) return null;
    if (extra) face.lift += extra;      // stacked units (a light bar over the tail lamps) sit a little prouder
    var smp = S.shape, n = face.pts.length, frameC = [0.008, 0.008, 0.009, 1], RINGS = [0, 0.5, 0.85, 1];
    var t0 = (G[key].tris() + G.trimG.tris() + (G.lens ? G.lens.tris() : 0));
    faceEmit(face, G[key], faceFan(face, RINGS), function () { return 0.003; }, col, b, 1);      // (the rings carry the curvature: no extra split)
    // housing wall: body skin (frame-ring height) round the outline -> lamp face edge
    var g = G.trimG, ids = [];
    for (var k = 0; k < n; k++) {
      var q = face.pts[k], hx = face.xh[k], nb = smp.normal ? smp.normal(hx, q[1], q[0], 0.02) : null;
      if (!nb) nb = [face.sg, 0, 0];
      var bot = [hx + nb[0] * 0.006, q[1] + nb[1] * 0.006, q[0] + nb[2] * 0.006], top = face.at(q[0], q[1], 0.003);
      var rz = q[0] - face.cz, ry = q[1] - face.cy, rl = Math.hypot(rz, ry) || 1, fn = face.n(q[0], q[1]);
      var wn = vnorm([fn[0] * 0.35, ry / rl * 0.8 + fn[1] * 0.35, rz / rl * 0.8 + fn[2] * 0.35]);
      // the wall never dips below the skin: where the face sits under the body skin it is skipped (skin covers it)
      var gap = vdot(vsub(top, bot), fn);
      ids.push(gap > 0.0008 ? [g.vert(bot[0], bot[1], bot[2], wn[0], wn[1], wn[2], 0, 0, frameC), g.vert(top[0], top[1], top[2], wn[0], wn[1], wn[2], 0, 0, frameC)] : null);
    }
    for (k = 0; k < n; k++) {
      var A = ids[k], B = ids[(k + 1) % n];
      if (A && B) { g.tri(A[0], B[0], B[1]); g.tri(A[0], B[1], A[1]); }
    }
    // cover lens: domed (height H at the centre, 0 at the rim), analytic normals from the dome
    if (lensOn && G.lens) {
      var bw = 1e9;
      face.pts.forEach(function (p) { bw = Math.min(bw, Math.hypot(p[0] - face.cz, p[1] - face.cy)); });
      var H = clamp(bw * 0.06, 0.0015, 0.005);      // a gentle crown: a tall dome mirrors half the sky (chrome-ball look)
      var lensOff = function (z, y) { var r = face.rad(z, y); return 0.0068 + H * Math.max(0, 1 - r * r); };
      var lensN = function (z, y) {
        var e = 0.004, Pz1 = face.at(z + e, y, lensOff(z + e, y)), Pz0 = face.at(z - e, y, lensOff(z - e, y));
        var Py1 = face.at(z, y + e, lensOff(z, y + e)), Py0 = face.at(z, y - e, lensOff(z, y - e));
        var nn = vcross(vsub(Pz1, Pz0), vsub(Py1, Py0)), fn2 = face.n(z, y), l = vlen(nn);
        if (!(l > 1e-12)) return fn2;
        nn = vsc(nn, 1 / l);
        return vdot(nn, fn2) < 0 ? vsc(nn, -1) : nn;
      };
      faceEmit(face, G.lens, faceFan(face, [0, 0.45, 0.75, 0.92, 1]), lensOff, WHITE, b, 1, lensN);
    }
    S.decalTris = (S.decalTris || 0) + (G[key].tris() + G.trimG.tris() + (G.lens ? G.lens.tris() : 0)) - t0;
    face.centre = face.at(face.cz, face.cy, 0.003);
    face.src = pts;
    return face;
  }
  /** the lamp face whose outline contains every point of a view-plane polygon (DRL / reverse graphics), or null */
  function faceOf(faces, poly) {
    for (var i = 0; i < faces.length; i++) {
      var fc = faces[i];
      if (poly.every(function (p) { return ptInPoly(p, fc.pts) || fc.rad(p[0], p[1]) <= 1.02; })) return fc;
    }
    return null;
  }
  function shapeDetails(S, G, A) {
    var SH = shapeLib(), f = S.shapeFit, fr = f.front || {}, re = f.rear || {}, sd = f.side || {}, dx = S.shapeDx;
    var base = 0.0045, L = 0.003;
    S.decalTris = 0; S.decalBudget = 9500;     // lamps / grille / plates / glass first; fine details stop at the budget
    // how deep the lamps reach into the nose / tail: from the side-view lamp items (re-projection limit)
    var dF = 0, dR = 0, xFm = f.dims.xFront, xRm = f.dims.xRear;
    (f.details || []).forEach(function (dt) {
      if (!dt || !dt.path || dt.view !== 'side' || !/^light/.test(dt.paint || '')) return;
      var b = SH.bounds(dt.path);
      if (!b || b.empty) return;
      if (b.maxX > xFm - 0.6 && dt.paint === 'light') dF = Math.max(dF, xFm - b.minX);
      if (b.minX < xRm + 0.6 && dt.paint === 'light-red') dR = Math.max(dR, b.maxX - xRm);
    });
    // lamp x clip: as deep as the side view shows the lamp (+4 cm; >= 28 cm so a small side marker never trims a
    // wrap-around lamp); without side-view lamps a generous 60 cm
    var cF = dF ? Math.max(dF + 0.04, 0.28) : 0.6, cR = dR ? Math.max(dR + 0.04, 0.28) : 0.6;
    dF = clamp(dF ? dF + 0.03 : 0.25, 0.12, LAMP_DEPTH); dR = clamp(dR ? dR + 0.03 : 0.25, 0.1, LAMP_DEPTH);
    // end-view casts only land on surfaces that really face the view (minDot), never deeper than a lamp / grille is
    // set into the nose (depth3), and drop triangles straddling panel breaks (nrmDev): no shards on decks / haunches
    var LAMP = { minDot: 0.25, fade: [0.15, 0.35], stretch: 3, maxEdge: 0.04, reproject: true, force: true, nrmDev: 0.77 }, OPEN = { minDot: 0.3, stretch: 3, force: true, depth3: 0.12, nrmDev: 0.77, maxEdge: 0.08, nrmKeep: true, edgeRefine: true, autoDepth: 0.45, sinkTol: 0.0022 };     // lamps / grilles always (the budget trims fine details)
    var FRAME = { minDot: 0.25, stretch: 3, maxEdge: 0.06, ring: 0.012, reproject: true, nrmDev: 0.77 }, frameC = [0.008, 0.008, 0.009, 1];
    function lampO(o, view) {
      return Object.assign({}, o, { depth3: view === 'rear' ? dR : dF, xClip: view === 'rear' ? [S.xR + cR, -1] : view === 'front' ? [S.xF - cF, 1] : null });
    }
    function slot(v, view, slotName, defPaint, layer, skipBody, o) {
      var cs = [];
      SH.items(v || null).forEach(function (it) {
        if (!it || !it.path) return;
        var pn = it.paint || defPaint, pm = SHAPE_PAINT[pn];
        if (pn === 'body' && !skipBody) pm = ['paint', S.paintRGBA];
        if (!pm || (skipBody && pn === 'body')) return;
        // mixed-paint slots (chrome horseshoe / lamp inside a black grille): the non-grille items sit half a layer up
        var bias = (slotName === 'grille' || slotName === 'intakes') && pn !== 'grille' && pn !== 'black' ? 0.5 : 0;
        var key = pm[0], col = pm[1];
        if (pn === 'grille' && G.grille) { key = 'grille'; if (S.hasTex) col = WHITE; }       // textured grille mesh part
        if (pn === 'plate' && G.plate) { key = 'plate'; col = WHITE; }                          // textured number plate
        if (slotName === 'drl' && G.drl && /^light/.test(pn)) { key = 'drl'; col = [0.95, 0.97, 1, 1]; }
        if (S.hasTex && (key === 'head' || key === 'brake')) col = WHITE;                       // the lamp maps carry the look
        // graphics inside a lamp unit's outline (DRL guides, blacked-out lamp masks) sit on the lamp face
        if (o && o.faces && o.faces.length && G[key]) {
          if (onFace(it.path, key, col, o.faces, 0.0042 + 0.0004 * layer)) { cs.push(null); return; }
          // inside a lamp's authored outline but off the (trimmed) lamp face: dropped, never a decal floating beside it
          if (inSrc(it.path, o.faces)) return;
        }
        // front / rear lamps: lamp units (real face + housing + lens); outlines the fit cannot carry stay decals
        if (o && o.units && (key === 'head' || key === 'brake') && (view === 'front' || view === 'rear')) {
          shapePolys(SH, it.path, 6, 0.03, 0.002).forEach(function (q) {
            var bq = polyBounds(q);
            // the same lamp authored twice (a light bar drawn over the tail lamps it joins): one unit only
            if (o.units.some(function (u) { var ub = polyBounds(u.src); return Math.min(ub.maxX, bq.maxX) - Math.max(ub.minX, bq.minX) > 0.8 * Math.max(ub.w, bq.w) && Math.min(ub.maxY, bq.maxY) - Math.max(ub.minY, bq.minY) > 0.8 * Math.max(ub.h, bq.h); })) return;
            // radial lamp units suit compact outlines; long thin strips (light bars, DRL blades) stay decals
            var fc = bq.w > 4.5 * bq.h || bq.h > 4.5 * bq.w ? null : lampUnit(S, G, q, view, key, col, bq, Math.max(0.45, 1.6 * (view === 'rear' ? cR : cF)), !!G.lens, slotName === 'lightBar' ? 0.0025 : 0);
            if (fc) { o.units.push(fc); cs.push(fc.centre); return; }
            var v1 = G[key].verts();
            var c1 = shapeDecal(S, G, null, view, key, col, base + (layer + bias) * L, Object.assign({}, o, { polys: [q], units: null }));
            lampUV(G[key], v1, bq, view);
            if (o.fallback) o.fallback.push(q);
            if (c1) cs.push(c1);
          });
          return;
        }
        var v0 = G[key] ? G[key].verts() : 0;
        var c = shapeDecal(S, G, it.path, view, key, col, base + (layer + bias) * L, o);
        if (key === 'head' || key === 'brake') lampUV(G[key], v0, SH.bounds(it.path), view);
        if (key === 'plate') plateUV(G.plate, v0, SH.bounds(it.path), view);
        if (c) cs.push(c);
      });
      return cs.filter(function (c) { return c; });
    }
    /** every outline of a view item lies within the authored outline of one of the lamp units */
    function inSrc(path, faces) {
      var ps = shapePolys(SH, path, 6, 0.02, 0.001);
      return ps.length > 0 && ps.every(function (q) { return faces.some(function (fc) { return fc.src && q.filter(function (pp) { return ptInPoly(pp, fc.src); }).length >= q.length * 0.5; }); });
    }
    /** a view item emitted on the lamp face that contains it (all of its outlines), else false */
    function onFace(path, key, col, faces, off) {
      var ps = shapePolys(SH, path, 6, 0.02, 0.001), fcs = ps.map(function (q) { return faceOf(faces, q); });
      if (!ps.length || fcs.some(function (fc) { return !fc; })) return false;
      ps.forEach(function (q, k) {
        var T = (q.length > 4 ? flipSafe(q) : earClip(q)).map(function (t) { return [q[t[0]], q[t[1]], q[t[2]]]; });
        faceEmit(fcs[k], G[key], T, function () { return off; }, col, polyBounds(q), 0.03);
      });
      return true;
    }
    // two-tone (ID. Buzz): the contrast upper body as body-material decals with a crisp split line
    var tt = S.shapeModel && S.shapeModel.twoTone, fm = f._map || {};
    S.twoToneDecals = false;
    if (tt && S.twoToneColor && !S.twoToneBody) {
      var ttc = S.twoToneColor.concat([1]), ttO = { minDot: 0.05, stretch: 3, maxEdge: 0.1, force: true, depth3: S.L * 0.5 };     // full-depth cast: the split line runs up the screen pillars
      var tS = slotPolys(SH, tt.side, 0, fm.side), tF = slotPolys(SH, tt.front, 0, fm.front), tR = slotPolys(SH, tt.rear, 0, fm.rear);
      // front / rear: only below the screen / backlight (the glass covers the rest; the side decal does the pillars)
      function clipBelow(polys, slotV) {
        var gb = shapeBounds(SH, slotV);
        if (!gb) return polys;
        var Yc = gb.minY + 0.03;
        return polys.map(function (q) {
          var out = [];
          for (var i = 0; i < q.length; i++) {
            var A = q[i], B = q[(i + 1) % q.length], ia = A[1] <= Yc, ib = B[1] <= Yc;
            if (ia) out.push(A);
            if (ia !== ib) { var t = (Yc - A[1]) / (B[1] - A[1]); out.push([A[0] + (B[0] - A[0]) * t, Yc]); }
          }
          return out;
        }).filter(function (q) { return q.length >= 3 && Math.abs(polyArea(q)) > 1e-4; });
      }
      tF = clipBelow(tF, fr.greenhouse); tR = clipBelow(tR, re.greenhouse);
      if (tS.length) { shapeDecal(S, G, null, 'side', 'paint', ttc, base - 0.3 * L, Object.assign({ polys: tS }, ttO, { minDot: -1, stretch: 6 })); S.twoToneDecals = true; }
      // the roof panel itself (grazing from the side view): plan-view roof in the contrast colour
      var tTop = slotPolys(SH, (f.top || {}).roof, 0);
      if (tTop.length) shapeDecal(S, G, null, 'top', 'paint', ttc, base - 0.3 * L, { polys: tTop, minDot: 0.2, stretch: 3, maxEdge: 0.16, force: true });
      if (tF.length) shapeDecal(S, G, null, 'front', 'paint', ttc, base - L * 0.5, Object.assign({ polys: tF }, ttO));
      if (tR.length) shapeDecal(S, G, null, 'rear', 'paint', ttc, base - L * 0.5, Object.assign({ polys: tR }, ttO));
    }
    // front
    slot(fr.grille, 'front', 'grille', 'grille', 0, false, OPEN);
    slot(fr.intakes, 'front', 'intakes', 'grille', 0, false, OPEN);
    slot(fr.splitter, 'front', 'splitter', 'carbon', 0, true, { minDot: -1, stretch: 4, maxEdge: 0.08 });
    var headFaces = [], headFb = [];
    var heads = slot(fr.headlights, 'front', 'headlights', 'light', 2, false, Object.assign(lampO(LAMP, 'front'), { units: headFaces, fallback: headFb }));
    S.lampUnits = headFaces.length;
    headFb.forEach(function (q) { shapeDecal(S, G, null, 'front', 'trimG', frameC, base + L, Object.assign({ polys: [q] }, lampO(FRAME, 'front'))); });     // decal lamps: gloss-black frame ring
    var drlN = G.drl ? G.drl.tris() : 0;
    slot(fr.drl, 'front', 'drl', 'light', 3, false, Object.assign(lampO(LAMP, 'front'), { faces: headFaces }));
    // no authored DRL: a light-guide contour just inside each headlight outline (the modern lamp signature)
    if (G.drl && G.drl.tris() === drlN) {
      SH.items(fr.headlights || null).forEach(function (it) {
        if (!it || !it.path) return;
        slotPolys(SH, it.path, 0).forEach(function (q) {
          var inner = offsetPoly(q, -0.011);
          if (!inner || !(Math.abs(polyArea(inner)) > 2e-4)) return;
          var fc = faceOf(headFaces, inner), outer = fc ? offsetPoly(inner, 0.0055) : null;
          if (fc && outer) {
            var T = [], nr = inner.length;
            for (var ri = 0; ri < nr; ri++) { var rj = (ri + 1) % nr; T.push([inner[ri], outer[ri], outer[rj]], [inner[ri], outer[rj], inner[rj]]); }
            faceEmit(fc, G.drl, T, function () { return 0.0048; }, [0.95, 0.97, 1, 1], null, 0.03);
          } else shapeDecal(S, G, null, 'front', 'drl', [0.95, 0.97, 1, 1], base + 3 * L, Object.assign({ polys: [inner], ring: 0.0055 }, lampO(LAMP, 'front')));
        });
      });
    }
    slot(fr.fogLights, 'front', 'fogLights', 'light', 2, false, LAMP);
    // cover glass over the decal lamps (lamp units carry their own domed lens): the headlamp outline once more, a layer
    // above the interior / DRL, in the clear lens material (sharp Fresnel reflections on top, depth under it)
    if (G.lens) headFb.forEach(function (q) { shapeDecal(S, G, null, 'front', 'lens', WHITE, base + 4.6 * L, Object.assign(lampO(LAMP, 'front'), { force: false, polys: [q] })); });
    // rear
    slot(re.diffuser, 'rear', 'diffuser', 'black', 0, true, { minDot: -1, stretch: 4, maxEdge: 0.08 });     // tucked-under valance: never drop triangles (no sawtooth)
    var tailFaces = [], tailFb = [];
    var tails = slot(re.taillights, 'rear', 'taillights', 'light-red', 2, false, Object.assign(lampO(LAMP, 'rear'), { units: tailFaces, fallback: tailFb }));
    var bar = slot(re.lightBar, 'rear', 'lightBar', 'light-red', 3, false, Object.assign(lampO(LAMP, 'rear'), { units: tailFaces, fallback: tailFb }));
    S.lampUnits += tailFaces.length;
    tailFb.forEach(function (q) { shapeDecal(S, G, null, 'rear', 'trimG', frameC, base + L, Object.assign({ polys: [q] }, lampO(FRAME, 'rear'))); });
    // reverse lamps: a small clear segment at the inboard bottom of each tail lamp
    SH.items(re.taillights || null).forEach(function (it) {
      if (!it || !it.path) return;
      var b = SH.bounds(it.path);
      if (!b || b.empty || b.w < 0.08 || b.h < 0.025) return;
      var c = (b.minX + b.maxX) / 2, inb = c >= 0 ? b.minX : b.maxX, s = c >= 0 ? 1 : -1;
      var w = Math.min(0.07, b.w * 0.3), h = Math.min(0.03, b.h * 0.4), y0 = b.minY + b.h * 0.12;
      var z0 = inb + s * b.w * 0.08, z1 = z0 + s * w, rp = [[z0, y0], [z1, y0], [z1, y0 + h], [z0, y0 + h]], fcR = faceOf(tailFaces, rp);
      if (fcR) faceEmit(fcR, G.rev, [[rp[0], rp[1], rp[2]], [rp[0], rp[2], rp[3]]], function () { return 0.0052; }, [0.85, 0.85, 0.87, 1], null, 0.02);
      else shapeDecal(S, G, [{ t: 'M', p: [[z0, y0]] }, { t: 'L', p: [[z1, y0]] }, { t: 'L', p: [[z1, y0 + h]] }, { t: 'L', p: [[z0, y0 + h]] }, { t: 'Z', p: [] }], 'rear', 'rev', [0.85, 0.85, 0.87, 1], base + 4 * L, Object.assign(lampO(LAMP, 'rear'), { depth: 2 }));
    });
    // smoked cover lens over the decal tail lamps / light bar (lamp units carry their own domed lens)
    if (G.lens) tailFb.forEach(function (q) { shapeDecal(S, G, null, 'rear', 'lens', WHITE, base + 4.6 * L, Object.assign(lampO(LAMP, 'rear'), { force: false, polys: [q] })); });
    // side: sills / lower cladding (arches cut out in 2D, never dropped on the tucked-under rocker)
    var holes = [S.archF, S.archR].map(function (a) { return [a.x - dx, a.y, a.r + 0.02]; });
    var SILL = { minDot: -1, stretch: 4, maxEdge: 0.05, bottomPad: 0.03, holes: holes };
    slot(sd.sill, 'side', 'sill', 'black', 0, true, SILL);
    slot(sd.lowerTrim, 'side', 'lowerTrim', 'black', 0, true, SILL);
    // side glass: DLO surround (black), the model's window outlines as real glass, then the pillars on top
    S.sideGlassDecals = false;
    // side casts stay on the flank: faces turned >= ~20 deg sideways, never over the roof crown (no saw-tooth rail)
    var ghClip = S.openTop ? null : [S.roofY - 0.015, -1];
    var GLASSO = { minDot: 0.25, stretch: 3, maxEdge: 0.05, force: true, sideNz: 0.35, yClip: ghClip, edgeRefine: true };
    if (SH.items(sd.windows || null).length && G.glass) {
      if (!S.openTop) slot(sd.greenhouse, 'side', 'greenhouse', 'black', 0.7, true, { minDot: 0.25, stretch: 3, maxEdge: 0.08, force: true, sideNz: 0.35, yClip: ghClip });
      SH.items(sd.windows || null).forEach(function (it) {
        if (!it || !it.path) return;
        if (shapeDecal(S, G, it.path, 'side', 'glass', WHITE, base + 1.4 * L, GLASSO)) S.sideGlassDecals = true;
      });
    }
    slot(sd.pillars, 'side', 'pillars', 'body', 2, false, { minDot: 0.05, stretch: 3, maxEdge: 0.06, force: true, sideNz: 0.35, yClip: ghClip });
    // windscreen / backlight: the front / rear greenhouse inset to the glass (pillars stay body / trim), dark backing
    if (S.endGlassDecals || S.screenDecal) {
      (S.screenDecal ? [['front', fr.greenhouse]] : [['front', fr.greenhouse], ['rear', re.greenhouse]]).forEach(function (e) {
        var ps = slotPolys(SH, e[1], 0);
        if (!ps.length) return;
        // cast only as deep as the glass runs (nose -> roof front / tail -> roof rear), on faces that really look
        // along the car, clipped at the roof edge: no shards on the roof / A-pillars
        var front = e[0] === 'front';
        var EO = { polys: ps, offset2d: -0.055, depth3: (front ? S.xF - S.xR0 : S.xR1 - S.xR) + 0.06, minDot: front ? 0.25 : 0.12, nrmDev: 0.85, maxSpread: 10,
          stretch: 4, maxEdge: 0.14, force: true, sinkTol: 0.007, edgeRefine: true, xClip: front ? [S.xR0 - 0.01, 1] : [S.xR1 + 0.01, -1] };
        shapeDecal(S, G, null, e[0], 'trimG', [0.012, 0.013, 0.016, 1], base, EO);
        shapeDecal(S, G, null, e[0], 'glass', WHITE, base + 1.4 * L, EO);
      });
    }
    var aero = [];
    (f.details || []).forEach(function (dt) {
      if (!dt || !dt.path || dt.role === 'mirror' || dt.role === 'glass') return;
      if (dt.role === 'spoiler' || dt.role === 'wing') { aero.push(dt); return; }       // extruded (shapeSpoilers)
      var p = dt.paint || 'black', pm = SHAPE_PAINT[p];
      if (!pm || p === 'body') return;
      if (dt.view === 'top' && /^light/.test(p)) return;          // lamps come from the front / rear views
      if (dt.view === 'top' && dt.role !== 'wiper' && dt.role !== 'vent' && dt.role !== 'trim' && dt.role !== 'antenna') return;
      if (dt.view === 'front' && dt.role === 'wiper') return;
      if (['front', 'rear', 'side', 'top'].indexOf(dt.view) < 0) return;
      var lamp = /^light/.test(p);
      // side-view lamp wraps duplicate a lamp unit's housing (they would stick out of it as a flat decal)
      if (lamp && dt.view === 'side' && ((p === 'light' && headFaces.length) || (p === 'light-red' && tailFaces.length))) return;
      // front / rear details inside a lamp unit (lamp graphics, black masks) sit on its face under the lens
      var dFaces = dt.view === 'front' ? headFaces : dt.view === 'rear' ? tailFaces : null;
      if (dFaces && dFaces.length && SHAPE_PAINT[p]) {
        var fKey = SHAPE_PAINT[p][0], fCol = SHAPE_PAINT[p][1];
        if (S.hasTex && (fKey === 'head' || fKey === 'brake')) fCol = WHITE;
        if (G[fKey] && onFace(dt.path, fKey, fCol, dFaces, 0.0044)) return;
      }
      if (lamp && dt.view !== 'top') shapeDecal(S, G, dt.path, dt.view, 'trimG', frameC, base + 2 * L, dt.view === 'side' ? { minDot: 0.05, stretch: 3, maxEdge: 0.06, ring: 0.012 } : lampO(FRAME, dt.view));
      if (dt.view === 'top' && dt.role === 'wiper' && S.wipers3d) return;          // 3D arms (shapeWipers)
      var dKey = pm[0], dCol = pm[1];
      if (p === 'grille' && G.grille) { dKey = 'grille'; if (S.hasTex) dCol = WHITE; }
      if (S.hasTex && (dKey === 'head' || dKey === 'brake')) dCol = WHITE;
      var dv0 = G[dKey] ? G[dKey].verts() : 0;
      // deck vents / louvres (top view): a near-black cavity tone laid almost flush (3 mm), not a slab floating
      // 16 mm above the engine lid
      var topVent = dt.view === 'top' && dt.role === 'vent';
      if (topVent && dKey === 'trimG') dCol = [0.004, 0.004, 0.0045, 1];
      shapeDecal(S, G, dt.path, dt.view, dKey, dCol, topVent ? 0.003 : base + (lamp ? 3 : 4) * L, lamp ? Object.assign({ depth: 3 }, dt.view === 'side' ? { minDot: 0.05, stretch: 3, maxEdge: 0.04 } : lampO(LAMP, dt.view)) : (dt.view === 'front' || dt.view === 'rear' ? Object.assign({}, OPEN, { depth: 2, force: false }) : { depth: dt.view === 'top' ? 1 : 2, minDot: dt.view === 'top' ? 0.2 : 0.05 }));
      if (dKey === 'head' || dKey === 'brake') lampUV(G[dKey], dv0, SH.bounds(dt.path), dt.view);
    });
    S.shapeAeroDetails = aero;
    if (S.screenDecal) screenFrame(S, G, slotPolys(SH, fr.greenhouse, 0));
    // number plates last, on their own layer, never cut by the other decals
    slot(fr.plateArea, 'front', 'plateArea', 'plate', 5, false, { minDot: 0.05, stretch: 3, maxEdge: 0.06, force: true });
    slot(re.plateArea, 'rear', 'plateArea', 'plate', 5, false, { minDot: 0.05, stretch: 3, maxEdge: 0.06, force: true });
    // anchors (effects: lamp glows / flares), mirrored pairs
    function pairs(list, fbX, fbY, fbZ) {
      var out = list.slice(0, 2);
      if (out.length === 1) out.push([out[0][0], out[0][1], -out[0][2]]);
      if (!out.length) out = [[fbX, fbY, -fbZ], [fbX, fbY, fbZ]];
      if (out[0][2] * out[1][2] >= 0) out[1] = [out[0][0], out[0][1], -out[0][2] || fbZ];
      return out;
    }
    A.headlights = pairs(heads, S.xF - 0.05, S.noseY - 0.05, S.hw * 0.62);
    A.brakeLights = pairs(tails.length ? tails : bar, S.xR + 0.05, S.deckY - 0.08, S.hw * 0.7);
  }
  /** open tops: a 3 cm black frame tube along the top and the sides of the windscreen (front-view greenhouse) */
  function screenFrame(S, G, polys) {
    if (!polys.length) return;
    var smp = S.shape, y0 = Infinity, y1 = -Infinity;
    polys.forEach(function (q) { q.forEach(function (p) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }); });
    function halfAt(y) {
      var m = 0;
      polys.forEach(function (q) {
        for (var i = 0, j = q.length - 1; i < q.length; j = i++) {
          var a = q[i], b = q[j];
          if ((a[1] > y) !== (b[1] > y)) { var t = (y - a[1]) / (b[1] - a[1]); m = Math.max(m, Math.abs(a[0] + (b[0] - a[0]) * t)); }
        }
      });
      return m;
    }
    var path = [], n = 5, k, hT = halfAt(y1 - 0.02), yT = y1 - 0.012;
    function at(z, y) {
      var x = smp.castX(y, z, -1);
      if (x === null) return null;
      return [x + 0.004, y, z];
    }
    for (k = 0; k <= n; k++) { var yl = lerp(y0 + 0.03, yT, k / n), p = at(-(halfAt(yl) - 0.012), yl); if (p) path.push(p); }
    for (k = 1; k < 6; k++) { var p2 = at(lerp(-hT + 0.012, hT - 0.012, k / 6), yT); if (p2) path.push(p2); }
    for (k = n; k >= 0; k--) { var yr = lerp(y0 + 0.03, yT, k / n), p3 = at(halfAt(yr) - 0.012, yr); if (p3) path.push(p3); }
    if (path.length >= 4) tube(G.trimG, path, 0.015, 6, [0.01, 0.01, 0.011, 1]);
  }
  /** mirrors: housings from the plan view (top.mirrors), heights from the side-view mirror detail */
  function shapeMirrors(S, G, A) {
    var SH = shapeLib(), f = S.shapeFit, dx = S.shapeDx, smp = S.shape;
    var sideM = null;
    (f.details || []).forEach(function (dt) { if (!sideM && dt && dt.view === 'side' && dt.role === 'mirror' && dt.path) { var b = SH.bounds(dt.path); if (b && !b.empty) sideM = b; } });
    var key = S.mirrors === 'black' ? 'trimG' : S.mirrors === 'carbon' ? 'carbon' : 'paint';
    var col = key === 'paint' ? S.paintRGBA : key === 'carbon' ? WHITE : [0.012, 0.012, 0.014, 1];
    A.mirrors = [];
    SH.items(f.top && f.top.mirrors || null).forEach(function (it) {
      if (!it || !it.path) return;
      var b = SH.bounds(it.path);
      if (!b || b.empty || b.w < 0.02) return;
      var sdz = (b.minY + b.maxY) >= 0 ? 1 : -1, zOut = Math.max(Math.abs(b.minY), Math.abs(b.maxY)), zIn = Math.min(Math.abs(b.minY), Math.abs(b.maxY));
      var cx = (b.minX + b.maxX) / 2 + dx, y0 = sideM ? sideM.minY : S.beltY + 0.02, y1 = sideM ? sideM.maxY : S.beltY + 0.14;
      if (y1 - y0 < 0.04) y1 = y0 + 0.1;
      var cy = (y0 + y1) / 2, ry = Math.max(0.04, (y1 - y0) / 2), rx = Math.max(0.055, b.w / 2);
      var tall = S.style === 'pickup' || S.style === 'van';
      // housing hugs the door: inboard face just off the body skin, short arm (no ball on a stalk)
      var zBody = smp.side(cx, cy);
      if (zBody === null) zBody = smp.side(cx, y0 + 0.02);
      if (zBody === null) zBody = zIn;
      var zInF = zBody + 0.03, hz = clamp(zOut - zInF, 0.14, 0.22);     // 3 cm gap: the stalk reads in profile
      if (tall) { ry *= 1.6; hz *= 1.3; }
      var cz = zInF + hz / 2;
      ellipsoid(G[key], [cx, cy, cz * sdz], [rx, ry, hz / 2], 10, 6, function () { return col; });
      // glass on the rear face
      // mirror glass on the rear face: a real reflector (chrome material, slightly dark silvering) in a black bezel
      ellipsoid(G.trimG, [cx - rx * 0.6, cy, cz * sdz], [rx * 0.44, ry * 0.8, hz / 2 * 0.88], 10, 4, function () { return [0.01, 0.01, 0.011, 1]; });
      ellipsoid(G.chrome, [cx - rx * 0.63, cy, cz * sdz], [rx * 0.42, ry * 0.72, hz / 2 * 0.8], 10, 4, function () { return [0.62, 0.64, 0.68, 1]; });
      // door sail (mount plate on the skin) + a rounded, slightly raked stalk out to the housing
      var z1 = cz - hz / 2 + 0.02, z0 = Math.max(0, zBody - 0.012), armC = [0.012, 0.012, 0.014, 1];
      box(G.trimG, cx - rx * 0.55, cy - ry * 0.75, z0, cx + rx * 0.35, cy - ry * 0.75 + Math.min(0.05, ry * 1.1), zBody + 0.006, armC, sdz < 0 ? MIRROR_Z : null);
      if (z1 > z0) tube(key === 'paint' ? G.paint : G.trimG, [[cx - rx * 0.05, cy - ry * 0.55, z0 * sdz], [cx - rx * 0.1, cy - ry * 0.45, lerp(z0, z1, 0.5) * sdz], [cx - rx * 0.15, cy - ry * 0.3, z1 * sdz]], Math.min(0.016, ry * 0.32), 6, key === 'paint' ? col : armC, { aspect: 0.6 });
      A.mirrors.push([cx, cy, cz * sdz]);
    });
  }
  /** black arch liners: a 6 cm deep band inside each wheel-arch circle so the well reads as an opening (a dark void
      above the tyre) instead of painted inner fender */
  function shapeArchLiners(S, G) {
    var smp = S.shape, col = [0.012, 0.012, 0.013, 1], g = G.trimG;
    [[S.archF, S.front], [S.archR, S.rear]].forEach(function (aw) {
      var A = aw[0], W = aw[1], R = A.r + 0.004, n = 22, a0 = -0.12, a1 = PI + 0.12, ring = [];
      for (var i = 0; i <= n; i++) {
        var a = lerp(a0, a1, i / n), x = A.x + Math.cos(a) * R, y = A.y + Math.sin(a) * R;
        if (y < S.rh + 0.015) continue;
        var zo = smp.side(x, y + 0.01);
        if (zo === null) zo = smp.side(x, y + 0.04);
        if (zo === null) continue;
        ring.push([x, y, Math.min(zo - 0.004, W.track / 2 + W.tw / 2 + 0.06), -Math.cos(a), -Math.sin(a)]);
      }
      if (ring.length < 3) return;
      [1, -1].forEach(function (sd) {
        var b0 = g.verts();
        ring.forEach(function (q) {
          g.vert(q[0], q[1], q[2] * sd, q[3], q[4], 0, 0, 0, col);
          g.vert(q[0], q[1], (q[2] - 0.06) * sd, q[3], q[4], 0, 0, 0, col);
        });
        for (var k = 0; k < ring.length - 1; k++) { var v = b0 + k * 2; g.tri(v, v + 1, v + 3); g.tri(v, v + 3, v + 2); }
      });
    });
  }
  /** model spoilers / wings (skipped when the build fits its own wing): side-view spoiler / wing details are extruded
      across the z range of the rear-view part at the same height (top-view part by x, else the deck width); models
      without side-view parts get rear.spoiler as a lip on the deck / roof trailing edge */
  function shapeSpoilers(S, G) {
    if (S.wing || !S.shape) return;
    var SH = shapeLib(), f = S.shapeFit, smp = S.shape, dx = S.shapeDx, aero = S.shapeAeroDetails || [];
    function paintOf(p) {
      p = p || 'body';
      if (p === 'body') return ['paint', S.paintRGBA];
      if (p === 'carbon') return ['carbon', WHITE];
      var pm = SHAPE_PAINT[p];
      return pm && G[pm[0]] ? pm : ['trimG', [0.012, 0.012, 0.014, 1]];
    }
    function bb(q) {
      var b = [Infinity, Infinity, -Infinity, -Infinity];
      q.forEach(function (p) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); });
      return b;
    }
    var rearC = [], topC = [];
    SH.items((f.rear && f.rear.spoiler) || null).forEach(function (it) { if (it && it.path) slotPolys(SH, it.path, 0).forEach(function (q) { rearC.push(bb(q)); }); });
    aero.forEach(function (dt) {
      if (dt.view === 'rear') slotPolys(SH, dt.path, 0).forEach(function (q) { rearC.push(bb(q)); });
      else if (dt.view === 'top') slotPolys(SH, dt.path, dx).forEach(function (q) { topC.push(bb(q)); });
    });
    /** prism: side polygon q (car-local x, y) between z0 and z1, flat walls, ear-clipped caps */
    function prism(g, q, z0, z1, col) {
      var n = q.length, area = 0, i;
      for (i = 0; i < n; i++) area += q[i][0] * q[(i + 1) % n][1] - q[(i + 1) % n][0] * q[i][1];
      var sg = area >= 0 ? 1 : -1;
      for (i = 0; i < n; i++) {
        var a = q[i], b = q[(i + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1], el = Math.hypot(ex, ey);
        if (el < 1e-6) continue;
        var nx = ey / el * sg, ny = -ex / el * sg, v = g.verts();
        g.vert(a[0], a[1], z0, nx, ny, 0, 0, 0, col); g.vert(b[0], b[1], z0, nx, ny, 0, 0, 0, col);
        g.vert(b[0], b[1], z1, nx, ny, 0, 0, 0, col); g.vert(a[0], a[1], z1, nx, ny, 0, 0, 0, col);
        g.quad(v, v + 1, v + 2, v + 3);
      }
      var T = earClip(q);
      [[z0, -1], [z1, 1]].forEach(function (c) {
        var v0 = g.verts();
        q.forEach(function (p) { g.vert(p[0], p[1], c[0], 0, 0, c[1], 0, 0, col); });
        T.forEach(function (t) { g.tri(v0 + t[0], v0 + t[1], v0 + t[2]); });
      });
    }
    var sideParts = aero.filter(function (dt) { return dt.view === 'side'; });
    if (sideParts.length) {
      sideParts.forEach(function (dt) {
        var pm = paintOf(dt.paint), g = G[pm[0]];
        slotPolys(SH, dt.path, dx).forEach(function (q) {
          if (q.length > 3) { var q0 = q[0], ql = q[q.length - 1]; if (Math.abs(q0[0] - ql[0]) + Math.abs(q0[1] - ql[1]) < 1e-5) q = q.slice(0, -1); }
          if (q.length < 3) return;
          var b = bb(q), h = b[3] - b[1], xm = (b[0] + b[2]) / 2, lim = Math.max(0.2, Math.min(S.hw, smp.halfW(clamp(xm, smp.x0, smp.x1)) + 0.03));
          var best = 0, sc = rearC.map(function (c) { var ov = Math.min(b[3], c[3]) - Math.max(b[1], c[1]), s = ov > 0 ? ov / Math.max(h, c[3] - c[1], 1e-3) : 0; if (s > best) best = s; return s; });
          var spans = [];
          if (best >= 0.4) rearC.forEach(function (c, k) { if (sc[k] >= best * 0.8) spans.push([c[0], c[2]]); });
          if (!spans.length) topC.forEach(function (c) { if (Math.min(b[2], c[2]) - Math.max(b[0], c[0]) > 0) spans.push([c[1], c[3]]); });
          if (!spans.length) spans.push([-lim * 0.92, lim * 0.92]);
          var seen = {};
          spans.forEach(function (sp) {
            var z0 = clamp(Math.min(sp[0], sp[1]), -lim, lim), z1 = clamp(Math.max(sp[0], sp[1]), -lim, lim), k = z0.toFixed(3) + ',' + z1.toFixed(3);
            if (seen[k] || z1 - z0 < 0.008) return;
            seen[k] = 1;
            prism(g, q, z0, z1, pm[1]);
          });
        });
      });
      return;
    }
    // rear.spoiler lip: the widest rear-view part, trailing edge just behind the station where the deck / roof reaches it
    var best0 = null, paint0 = null;
    SH.items((f.rear && f.rear.spoiler) || null).forEach(function (it) {
      if (!it || !it.path) return;
      slotPolys(SH, it.path, 0).forEach(function (q) { var c = bb(q); if (!best0 || c[2] - c[0] > best0[2] - best0[0]) { best0 = c; paint0 = it.paint; } });
    });
    aero.forEach(function (dt) { if (dt.view === 'top' && dt.paint) paint0 = paint0 || dt.paint; });
    if (!best0 || best0[2] - best0[0] < 0.3) return;
    var y0 = best0[1], y1 = best0[3], hwR = Math.max(Math.abs(best0[0]), Math.abs(best0[2])), xs = null, x;
    for (x = smp.x0 + 0.005; x < smp.x0 + Math.min(1.2, S.ro + 0.6); x += 0.01) { var t0 = smp.top(x, 0); if (t0 !== null && t0 >= y1 - 0.012) { xs = x; break; } }
    if (xs === null) return;
    // roof spoilers (hatch / wagon / SUV / van tailgates) overhang the rear glass; deck lips stay short and flush so they
    // never shade the tail lamps on the rounded tail below
    var tS = smp.top(xs, 0), tB = smp.top(Math.max(smp.x0 + 0.002, xs - 0.08), 0);
    var steep = /^(hatchback|wagon|suv|van|shooting-brake)$/.test(S.style) && (tB === null || tS - tB > 0.06);
    var over = steep ? 0.1 : 0.015, chord = steep ? 0.16 : 0.12, rise = steep ? clamp((y1 - y0) * 0.3, 0.008, 0.02) : 0.012, th = steep ? clamp((y1 - y0) * 0.5, 0.02, 0.045) : 0.012;
    var xt = Math.max(xs - over, smp.x0 + 0.004), xf = Math.min(xs + chord, smp.x1 - 0.1);
    var zS = 0, tz;      // lip span: as far out as the deck / roof stays near the spoiler height
    while (zS < hwR && (tz = smp.top(xs, zS + 0.02)) !== null && tz >= y0 - 0.04) zS += 0.02;
    var hw = Math.min(hwR, zS);
    if (!(hw > 0.2)) return;
    var pm0 = paintOf(paint0), rows = [], n = 16, prev = null, k;
    for (k = 0; k <= n; k++) {
      var z = lerp(-hw, hw, k / n), az = Math.abs(z), tf = smp.top(xf, az), ts = smp.top(xs, az);
      if (tf === null || ts === null) { if (!prev) continue; tf = prev[0]; ts = prev[1]; }
      prev = [tf, ts];
      var yT = steep ? Math.max(ts + rise, y1 + 0.004 - (tS - ts)) : ts + rise;
      rows.push([[xf, tf - 0.004, z], [xt + 0.006, yT - th, z], [xt, yT, z], [lerp(xf, xs, 0.5), Math.max(ts, tf) + rise * 0.5, z]]);
      rows[rows.length - 1].splice(1, 0, [xs + 0.01, ts - 0.006, z]);
    }
    if (rows.length < 3) return;
    // closed ends: the end profiles pulled to their centroid
    [0, rows.length - 1].forEach(function (ri, e) {
      var r = rows[ri], c = [0, 0, 0];
      r.forEach(function (p) { c[0] += p[0] / r.length; c[1] += p[1] / r.length; c[2] += p[2] / r.length; });
      var cap = r.map(function () { return [c[0], c[1], c[2] + (e ? -0.004 : 0.004)]; });
      if (e) rows.push(cap); else rows.unshift(cap);
    });
    var pr = rows[1], ar = 0;
    for (k = 0; k < pr.length; k++) ar += pr[k][0] * pr[(k + 1) % pr.length][1] - pr[(k + 1) % pr.length][0] * pr[k][1];
    var g0 = new Geo();
    emitGrid(rows, { geo: g0, wrapJ: true, flip: ar > 0, color: function () { return pm0[1]; } });
    G[pm0[0]].append(g0);
  }
  /** exhaust tips at the model's rear.exhaust positions (build exhaust picks the finish); hidden / none -> build tips */
  function shapeExhausts(S, G, A) {
    A.exhaust = [];
    if (!S.exhaust) return;
    var SH = shapeLib(), f = S.shapeFit, list = ((f.rear && f.rear.exhaust) || []).filter(function (e) { return e && e.shape !== 'hidden' && isNum(e.cx) && isNum(e.cy); });
    if (!list.length || S.exhaust.style === 'hidden') {
      if (S.exhaust.style === 'hidden') return;
      exhausts(S, G, A);
      return;
    }
    void SH;
    var smp = S.shape, blued = S.exhaust.style === 'blued';
    list.forEach(function (t) {
      var w = clamp(num(t.w, 0.09), 0.03, 0.4), h = clamp(num(t.h, w), 0.02, 0.3), r = Math.min(w, h) / 2;
      var hit = smp.castX(t.cy + h * 0.6, t.cx, 1);
      var hit2 = smp.castX(t.cy, t.cx, 1);
      var xb = hit2 === null ? S.xR + 0.02 : hit2;
      if (hit !== null) xb = Math.min(xb, hit + 0.04);
      var xEnd = xb - 0.025, len = 0.16, trap = t.shape === 'trapezoid';
      var g = new Geo(), seg = trap ? 4 : 16;
      var prof = [[r * 0.86, len * 0.7], [r, len * 0.72], [r * 1.04, len * 0.15], [r, 0], [r * 0.86, 0.004], [r * 0.84, 0.02]];
      lathe(g, prof, seg, {
        a0: trap ? PI / 4 : 0, a1: trap ? PI / 4 + TAU : TAU,
        color: function (i, j) {
          if (j >= 4) return [0.08, 0.07, 0.065, 1];
          if (blued) { var q = j / 3; return [lerp(0.25, 0.75, q), lerp(0.18, 0.65, q), lerp(0.55, 0.6, q), 1]; }
          return [0.9, 0.9, 0.92, 1];
        }
      });
      var cap = new Geo();
      lathe(cap, [[0, 0.03], [r * 0.84, 0.03]], trap ? 4 : 12, { a0: trap ? PI / 4 : 0, a1: trap ? PI / 4 + TAU : TAU, color: function () { return [0.01, 0.01, 0.01, 1]; } });
      g.append(cap);
      var rr = trap ? r / Math.SQRT2 : r, sz = (w / 2) / rr, sy = (h / 2) / rr;
      var m = m4();
      m[0] = 0; m[1] = 0; m[2] = sz; m[4] = 0; m[5] = sy; m[6] = 0; m[8] = 1; m[9] = 0; m[10] = 0;
      m[12] = xEnd; m[13] = t.cy; m[14] = t.cx;
      G.chrome.append(g, m);
      A.exhaust.push([xEnd, t.cy, t.cx]);
    });
  }
  /** low LOD lamps: one projected quad per model head / tail lamp (bounds) */
  function shapeLowLights(S, G, A) {
    var SH = shapeLib(), f = S.shapeFit, smp = S.shape;
    function quads(slot, view, key, fbList) {
      var out = [];
      SH.items(slot || null).slice(0, 4).forEach(function (it) {
        if (!it || !it.path || out.length >= 2) return;
        var b = SH.bounds(it.path);
        if (!b || b.empty) return;
        var yc = (b.minY + b.maxY) / 2, zc = (b.minX + b.maxX) / 2, dir = view === 'front' ? -1 : 1;
        // (projXL: lamps set into a sloping wing, 911-style, land on the wing instead of being dropped)
        var hit = smp.projX(yc, zc, dir, 0.5) || smp.projXL(yc, zc, dir, 0.45);
        if (!hit) return;
        var x = hit[0], g = G[key], nx = view === 'front' ? 1 : -1;
        var hy = Math.max(0.012, b.h / 2), zw = Math.max(0.05, (smp.side(x, yc) || S.hw) - 0.01);
        var za = clamp(b.minX, -zw, zw), zb = clamp(b.maxX, -zw, zw);
        if (zb - za < 0.04) { za = clamp(zc - 0.03, -zw, zw); zb = za + 0.06; }
        // textured: white vertex colour, the lamp map / glow mask carry the look (uv u = inboard..outboard, v = top..bottom)
        var lc = S.hasTex ? WHITE : key === 'brake' ? [0.7, 0.02, 0.025, 1] : [0.92, 0.93, 0.95, 1];
        // lamps set high into a sloping wing (911): corners above the crown fail to project -> shrink the quad toward
        // the lamp centre / reach deeper along the wing until all four corners land on the body
        var c2 = null, cs = null;
        for (var sh = 0; sh < 4 && !cs; sh++) {
          var s0 = [1, 0.7, 0.45, 0.25][sh], hy2 = hy * s0, zA = lerp(zc, za, s0), zB = lerp(zc, zb, s0), dp = 0.45 + sh * 0.2;
          c2 = [[zA, yc - hy2], [zB, yc - hy2], [zB, yc + hy2], [zA, yc + hy2]];
          cs = c2.map(function (q) { return smp.projX(q[1], q[0], dir, 0.6) || smp.projXL(q[1], q[0], dir, dp); });
          if (cs.some(function (q) { return !q; })) cs = null;
          else { za = zA; zb = zB; }
        }
        if (!cs) return;
        var bb = g.verts(), zm = (za + zb) / 2;
        cs.forEach(function (q, k) {
          var u = (c2[k][0] - za) / Math.max(1e-4, zb - za);
          g.vert(q[0] + nx * 0.012, q[1] + 0.004, q[2], nx * 0.6, 0.8, 0, zm >= 0 ? u : 1 - u, k < 2 ? 1 : 0, lc);
        });
        g.quad(bb, bb + 1, bb + 2, bb + 3);
        zc = (za + zb) / 2;
        out.push([x, yc, zc]);
      });
      if (out.length === 1) out.push([out[0][0], out[0][1], -out[0][2]]);
      return out.length ? out : fbList;
    }
    A.headlights = quads(f.front && f.front.headlights, 'front', 'head', [[S.xF - 0.05, S.noseY - 0.05, -S.hw * 0.62], [S.xF - 0.05, S.noseY - 0.05, S.hw * 0.62]]);
    var tl = f.rear && (SH.items(f.rear.taillights || null).length ? f.rear.taillights : f.rear.lightBar);
    A.brakeLights = quads(tl, 'rear', 'brake', [[S.xR + 0.05, S.deckY - 0.08, -S.hw * 0.7], [S.xR + 0.05, S.deckY - 0.08, S.hw * 0.7]]);
    if (S.wing && S.wing !== 'ducktail' && S.wing !== 'lip-spoiler') {
      var wx = S.xR + 0.3, wy = (smp.top(wx, 0) || S.deckY) + (S.wing === 'active' ? 0.13 : 0.26);
      box(G.paint, wx - 0.3, wy - 0.02, -S.W * 0.44, wx, wy + 0.02, S.W * 0.44, [0.03, 0.03, 0.035, 1]);
    }
  }
  /** shape-path answers for the analytic surface queries */
  function shapeGh(S, x) {
    var smp = S.shape, top = smp.top(x, 0);
    var yb = S.beltY;
    if (top === null) top = S.roofY;
    var zb = smp.side(x, yb + 0.01);
    if (zb === null) zb = smp.halfW(x) * 0.9;
    var gc = Math.min(0.03, Math.max(0, top - yb) * 0.2), h = Math.max(0, top - yb - gc);
    var gzr = smp.side(x, top - Math.min(0.05, Math.max(0.005, (top - yb) * 0.2)));
    if (gzr === null) gzr = zb * 0.6;
    return { zb: zb, yb: yb, h: h, gc: gc, gzr: Math.max(0.05, gzr) };
  }
  function shapeEdge(S, x) {
    var smp = S.shape, hw = smp.halfW(x), y = smp.top(x, hw * 0.8);
    return y === null ? S.beltY : y;
  }

  /** PBR map specs for the wheel parts: tread (per compound), brake disc (per brake material), caliper (build colour) */
  function wheelMaps(S) {
    var pat = { slick: 'slick', track: 'semi', winter: 'wet', 'all-season': S.style === 'pickup' ? 'offroad' : 'wet', street: 'sport', performance: 'sport' }[S.compound] || 'sport';
    var dt = { iron: 'plain', 'drilled-slotted': 'drilledSlotted', 'two-piece': 'drilled', 'carbon-ceramic': 'ceramic' }[S.brakeMat] || 'slotted';
    var cc = S.caliper.map(function (v) { return Math.round(clamp01(Math.pow(v, 1 / 2.2)) * 255); });
    var stripe = S.compound === 'slick' ? '#f2c200' : S.compound === 'track' ? '#d01818' : undefined;
    return {
      // sidewall: lettering albedo + relief normal (bulge, rim protector, raised letters) + ORM (moulding AO)
      sidewall: { fam: 'tireSidewall', o: { stripe: stripe }, rough: 1, metal: 0.001, ao: 0.85, normalScale: 1 },
      tread: { fam: 'tyreTread', o: { pattern: pat, wear: 0.3 }, rough: 1, metal: 1, ao: 0.8, normalScale: 1, fallback: [0.035, 0.035, 0.038, 1] },
      disc: { fam: 'brakeDisc', o: { type: dt }, rough: 1, metal: 1, ao: 0.7, normalScale: 0.8 },
      caliper: { fam: 'caliper', o: { color: 'rgb(' + cc.join(',') + ')', text: 'REDLINE', sub: S.brakeMat === 'carbon-ceramic' ? 'CERAMIC' : undefined, finish: 'gloss' }, rough: 1, metal: 1, ao: 0.7, normalScale: 0.7, fallback: S.caliper.concat([1]) }
    };
  }
  /** PBR map specs (CB.gl.textures car families) for the real-model lamps / grille; realize() resolves them */
  function lampMaps(S) {
    var sm = S.shapeModel || {}, f = S.shapeFit || {}, SH = shapeLib(), h = modelIdHash(sm.id || S.style);
    var hs = { halogen: 'reflector', led: 'projector', matrix: 'matrix', laser: 'laser' }[S.lights] || 'projector';
    var bar = SH && f.rear && SH.items(f.rear.lightBar || null).length > 0;
    var ts = bar ? 'bar' : /ferrari/i.test(sm.make || '') ? 'ring' : /^(hypercar|coupe)$/.test(S.style) ? 'blade' : 'cluster';
    var pats = { hypercar: ['honeycomb', 'mesh'], coupe: ['honeycomb', 'mesh', 'diamond'], roadster: ['honeycomb', 'mesh'], sedan: ['mesh', 'honeycomb', 'slats'],
      wagon: ['mesh', 'honeycomb'], 'shooting-brake': ['honeycomb', 'diamond'], suv: ['diamond', 'slats', 'honeycomb'], pickup: ['slats', 'vertical'], van: ['slats', 'honeycomb'], hatchback: ['honeycomb', 'mesh'] }[S.style] || ['honeycomb'];
    return {
      // interior under the cover glass: reflector cups half-metallic (a full mirror blows out into the sky reflection)
      head: { fam: 'headlight', o: { style: hs }, rough: 1, metal: 0.5, ao: 0.7, normalScale: 0.6, mask: 0 },
      tail: { fam: 'taillight', o: { style: ts, smoked: S.style === 'hypercar' || undefined }, rough: 1, metal: 1, ao: 0.6, normalScale: 0.8, mask: 0, fallback: [0.32, 0.01, 0.015, 1] },
      grille: { fam: 'grille', o: { pattern: pats[h % pats.length], finish: 'black' }, rough: 1, metal: 1, ao: 1, normalScale: 1, uvScale: 1 / 0.11, fallback: [0.004, 0.004, 0.005, 1] }
    };
  }
  /* ================================================================ model description (pure, Node-testable) */
  /** high-LOD real models stay under ~39k triangles: a model whose decals came out heavy is rebuilt once with a
      coarser loft (75 % of the stations) */
  var TRI_CAP_HIGH = 39000, TRI_CAP_HERO = 120000, HERO_LOFT = 6400;
  /* ================================================================ low-poly delegation (docs/LOWPOLY-SPEC.md) */
  // graphics.carStyle 'lowpoly' (default) builds the faceted CB.lowpoly model of the real car; 'detailed' (or no
  // CB.lowpoly / no CB.shapes model) keeps the detailed loft below. The low-poly model reuses this module's
  // resolve() + shapeSetup() so dims, cameras, suspension and pose() behave exactly like the detailed real model.
  function lowpolyOn(opts) {
    var LP = CB.lowpoly;
    if (!LP || typeof LP.build !== 'function' || opts.shapes === false || opts.realModel === false) return false;
    return (typeof LP.carStyle === 'function' ? LP.carStyle(opts) : 'lowpoly') !== 'detailed';
  }
  function geoFromArrays(p) {
    var g = new Geo();
    g.p = Array.prototype.slice.call(p.positions); g.n = Array.prototype.slice.call(p.normals);
    g.c = Array.prototype.slice.call(p.colors); g.i = Array.prototype.slice.call(p.indices);
    g.t = p.uvs ? Array.prototype.slice.call(p.uvs) : new Array(g.p.length / 3 * 2).fill(0);
    return g;
  }
  function lowpolyGeometry(build, opts, shapeModel) {
    var S = resolve(build, opts);
    S.hasTex = !!opts.hasTextures; S.paintRGBA = S.paint.concat([1]); S.hero = false;
    if (!shapeSetup(S, shapeModel, build, 'low')) return null;
    var lp = CB.lowpoly.build(build, { lod: S.lod, model: shapeModel.id, S: S, isPlayer: opts.isPlayer, id: opts.id, number: opts.number, color: opts.color, accent: opts.accent });
    if (!lp || !lp.parts || !lp.parts.length) return null;
    var parts = [], tris = 0;
    lp.parts.forEach(function (q) {
      var p = { geo: geoFromArrays(q), material: q.material, kind: q.kind, local: m4(), castShadow: q.castShadow !== false, transparent: !!q.transparent, attach: q.attach || 'body' };
      if (q.wheel) {
        p.wheel = q.wheel;
        p.local[12] = q.wheel.x; p.local[13] = q.wheel.y; p.local[14] = q.wheel.z - q.wheel.side * (q.wheel.inset || 0);
      }
      if (q.lightKey) p.lightKey = q.lightKey;
      if (q.wing) p.wing = q.wing;
      tris += q.triangles;
      parts.push(p);
    });
    var A = lp.anchors || {};
    A.wheels = A.wheels || [];
    var d = lp.dims, sm = shapeModel;
    var dims = {
      length: S.L, width: S.W, height: S.H, wheelbase: S.wb, track: S.track, wheelRadius: Math.max(S.front.r, S.rear.r),
      wheelRadiusFront: S.front.r, wheelRadiusRear: S.rear.r, rideHeight: S.rh, frontOverhang: S.fo, rearOverhang: S.ro,
      frontAxle: S.xFA, rearAxle: S.xRA, belt: S.beltY, roof: S.openTop ? S.roofY : (topAt(S, (S.xR0 + S.xR1) / 2, 0) || S.roofY), deck: S.deckY, nose: S.noseY,
      tireWidthFront: S.front.tw, tireWidthRear: S.rear.tw, style: S.style, trackFront: S.front.track, trackRear: S.rear.track,
      model: sm.id, make: sm.make, modelName: sm.name, lowpoly: true, authored: !lp.auto
    };
    void d;
    var hoodX = S.xA + Math.min(0.1, (S.xF - S.xA) * 0.15), hoodTop = topAt(S, hoodX, 0) || S.noseY;
    return {
      S: S, parts: parts, dims: dims, lod: S.lod, lowpoly: true,
      cockpitEye: S.eye.slice(), hoodCam: [hoodX, hoodTop + 0.21, 0], bumperCam: [S.xF + 0.04, Math.max(0.35, S.noseY - 0.12), 0],
      anchors: A, stats: { triangles: tris, parts: parts.length },
      susp: suspensionParams(S),
      model: { id: sm.id, make: sm.make, name: sm.name, style: sm.style }
    };
  }
  function buildGeometry(build, opts) {
    opts = opts || {};
    if (lowpolyOn(opts)) {
      var sm0 = shapeModelFor(build, opts);
      if (sm0) {
        try { var lg = lowpolyGeometry(build, opts, sm0); if (lg) return lg; }
        catch (eLP) { if (typeof console !== 'undefined' && console.warn) console.warn('[car-mesh] low-poly', sm0.id, eLP && eLP.message); }
      }
    }
    var g = buildGeometryOnce(build, opts);
    var cap = g && g.S && g.S.hero ? TRI_CAP_HERO : TRI_CAP_HIGH;
    if (g && g.model && g.lod !== 'low' && g.stats.triangles > cap && !opts._loftScale) {
      var g2 = buildGeometryOnce(build, Object.assign({}, opts, { _loftScale: 0.75 }));
      if (g2 && g2.model && g2.stats.triangles < g.stats.triangles) return g2;
    }
    return g;
  }
  function buildGeometryOnce(build, opts) {
    var S = resolve(build, opts);
    S.hasTex = !!opts.hasTextures;
    S.loftScale = opts._loftScale || 1;
    // hero mesh: the player's own car at high LOD (dense loft, ~120k triangle budget); AI cars keep the 39k budget
    S.hero = opts.isPlayer === true && S.lod !== 'low' && opts.hero !== false;
    S.paintRGBA = S.paint.concat([1]);
    var shapeModel = shapeModelFor(build, opts), useShape = false;
    if (shapeModel) {
      try { useShape = shapeSetup(S, shapeModel, build, S.lod); }
      catch (e) { useShape = false; if (typeof console !== 'undefined' && console.warn) console.warn('[car-mesh] shape model', shapeModel.id, e && e.message); }
      if (!useShape) { var S0 = resolve(build, opts); S0.hasTex = S.hasTex; S0.paintRGBA = S.paintRGBA; S = S0; }
    }
    var M = buildMaterials(S), parts = [], A = { wheels: [] };
    function part(geo, mat, kind, o) {
      if (!geo || !geo.tris()) return null;
      var p = { geo: geo, material: mat, kind: kind, local: m4(), castShadow: true, transparent: !!mat.transparent, attach: 'body' };
      if (o) for (var k in o) p[k] = o[k];
      parts.push(p);
      return p;
    }
    var G = { paint: new Geo(), roof: new Geo(), glass: new Geo(), trimG: new Geo(), under: null, carbon: new Geo(), chrome: new Geo(), head: new Geo(), brake: new Geo(), rev: new Geo(), interior: new Geo(), decal: new Geo() };
    G.under = G.trimG; G.clad = G.trimG; G.shut = G.trimG; G.bed = G.trimG; G.tub = G.interior;
    var D = new Geo();
    if (useShape && S.lod === 'low') {
      shapeLowBody(S, G);
      shapeLowLights(S, G, A);
      var swl = new Geo();
      lowWheels(S, swl);
      part(G.paint, M.paint, 'body');
      part(swl, M.wheelsLow, 'wheels', { attach: 'car' });
      var LML = lampMaps(S);      // low LOD lamps carry uvs too: the same lamp maps + emissive glow masks as the high LOD
      part(G.head, M.head, 'light-head', { castShadow: false, maps: LML.head });
      part(G.brake, M.brake, 'light-brake', { castShadow: false, maps: LML.tail });
    } else if (useShape) {
      G.drl = new Geo(); G.grille = new Geo(); G.lens = new Geo(); G.plate = S.hasTex ? new Geo() : null;
      shapeBodyMesh(S, G, false);
      S.wipers3d = !S.openTop;
      shapeDetails(S, G, A);
      try { shapePanelLines(S, G); } catch (ePL) { /* body without shut lines */ }
      try { shapeWindowTrim(S, G); shapeHandles(S, G); shapeWipers(S, G); } catch (eHW) { /* body without the extra hardware */ }
      shapeMirrors(S, G, A);
      shapeArchLiners(S, G);
      try { shapeSpoilers(S, G); } catch (eSp) { /* body without the model spoiler */ }
      shapeExhausts(S, G, A);
      splitter(S, G);
      diffuser(S, G);
      skirts(S, G);
      canards(S, G);
      stripes(S, G);
      numberDecals(S, G, S.hasTex);
      if (S.openTop) { try { interior(S, G, D); } catch (eI) { /* keep the body without a cabin */ } }
      var SW = wing(S, G, parts);
      part(G.paint, M.paint, 'body');
      part(G.roof, M.roof, 'roof');
      part(G.trimG, M.trim, 'trim');
      part(G.carbon, M.carbon, 'carbon', { texture: 'carbon' });
      part(G.chrome, M.chrome, 'chrome');
      part(G.glass, M.glass, 'glass', { castShadow: false, transparent: true });
      var LM = lampMaps(S);
      part(G.head, M.head, 'light-head', { castShadow: false, maps: LM.head });
      part(G.brake, M.brake, 'light-brake', { castShadow: false, maps: LM.tail });
      part(G.rev, M.rev, 'light-rev', { castShadow: false });
      // DRL light guides: their own emissive part (kind light-head so cockpit views hide it; pose key light-drl)
      part(G.drl, M.drl, 'light-head', { castShadow: false, lightKey: 'light-drl' });
      // clear headlamp cover glass over the lamp interior map (kind glass: hidden with the body in cockpit views)
      part(G.lens, M.lens, 'glass', { castShadow: false, transparent: true });
      part(G.grille, M.grille, 'trim', { castShadow: false, maps: LM.grille });
      if (G.plate) part(G.plate, M.plate, 'trim', { castShadow: false, texture: 'plate' });
      part(G.decal, M.decal, 'decal', { castShadow: false, texture: 'number' });
      if (S.openTop) { part(G.interior, M.interior, 'interior', { castShadow: false }); part(D, M.driver, 'driver', { castShadow: false }); }
      if (SW) part(SW.geo, M.wing, 'wing', { texture: 'carbon', wing: { pivot: SW.pivot, active: SW.active, base: SW.base } });
    } else if (S.lod === 'low') {
      var LA = buildLow(S, G);
      var wl = new Geo();
      lowWheels(S, wl);
      part(G.paint, M.paint, 'body');
      part(wl, M.wheelsLow, 'wheels', { attach: 'car' });
      part(G.head, M.head, 'light-head', { castShadow: false });
      part(G.brake, M.brake, 'light-brake', { castShadow: false });
      A.headlights = LA.headlights; A.brakeLights = LA.brakeLights;
    } else {
      lowerBodyHigh(S, G);
      if (S.openTop) windscreenOpen(S, G); else greenhouseHigh(S, G);
      frontLights(S, G, A);
      grilleAndIntakes(S, G);
      frontBadge(S, G);
      rearLights(S, G, A);
      mirrors(S, G, A);
      doorHandles(S, G);
      wipers(S, G);
      roofExtras(S, G);
      engineDeck(S, G);
      bedDetails(S, G);
      rollHoops(S, G);
      exhausts(S, G, A);
      splitter(S, G);
      diffuser(S, G);
      skirts(S, G);
      canards(S, G);
      stripes(S, G);
      numberDecals(S, G, S.hasTex);
      interior(S, G, D);
      var W = wing(S, G, parts);
      part(G.paint, M.paint, 'body');
      part(G.roof, M.roof, 'roof');
      part(G.trimG, M.trim, 'trim');
      part(G.carbon, M.carbon, 'carbon', { texture: 'carbon' });
      part(G.chrome, M.chrome, 'chrome');
      part(G.glass, M.glass, 'glass', { castShadow: false, transparent: true });
      part(G.head, M.head, 'light-head', { castShadow: false });
      part(G.brake, M.brake, 'light-brake', { castShadow: false });
      part(G.rev, M.rev, 'light-rev', { castShadow: false });
      part(G.interior, M.interior, 'interior', { castShadow: false });
      part(D, M.driver, 'driver', { castShadow: false });
      part(G.decal, M.decal, 'decal', { castShadow: false, texture: 'number' });
      if (W) part(W.geo, M.wing, 'wing', { texture: 'carbon', wing: { pivot: W.pivot, active: W.active, base: W.base } });
    }
    // wheels
    var wheelDefs = [['fl', true, -1], ['fr', true, 1], ['rl', false, -1], ['rr', false, 1]];
    var axleGeo = {}, WM = wheelMaps(S);
    wheelDefs.forEach(function (wd) {
      var W = wd[1] ? S.front : S.rear, side = wd[2];
      var info = { id: wd[0], front: wd[1], side: side, x: W.x, y: W.r, z: side * (useShape && W.track ? W.track : S.track) / 2, r: W.r, width: W.tw, camber: W.camber * side };
      // real models: tuck the tyre's outer face under the fender (outer face <= fender skin above the hub - 5 mm);
      // info.z stays the fitted track (physics / anchors), the visual wheel is drawn info.inset further inboard
      if (useShape && S.shape) {
        var zf = S.shape.side(W.x, W.r + 0.6 * W.r);
        if (zf !== null) {
          var over = Math.abs(info.z) + W.tw / 2 - (zf - 0.005);
          if (over > 0) info.inset = Math.min(over, 0.08);
        }
      }
      A.wheels.push(info);
      if (S.lod === 'low') return;
      var ak = wd[1] ? 'f' : 'r';
      var src = axleGeo[ak] || (axleGeo[ak] = wheelGeos(S, A, wd[1]));
      var mirror = m4();
      if (side < 0) mirror[10] = -1;
      var ty = new Geo().append(src.tyre, side < 0 ? mirror : null);
      if (side < 0) for (var tu = 0; tu < ty.t.length; tu += 2) ty.t[tu] = 1 - ty.t[tu];   // un-mirror the sidewall lettering
      var rimG = new Geo().append(src.rim, side < 0 ? mirror : null);
      var base = { attach: 'wheel', wheel: info };
      var lt = m4(); lt[12] = info.x; lt[13] = info.y; lt[14] = info.z - side * (info.inset || 0);
      part(rimG, M.rim, 'wheel-' + wd[0], Object.assign({ local: m4copy(m4(), lt), texture: S.wheelMaterial === 'carbon' ? 'carbon' : null }, base));
      part(ty, M.tyre, 'tire-' + wd[0], Object.assign({ local: m4copy(m4(), lt), texture: 'tire', maps: S.hasTex ? WM.sidewall : null }, base));
      if (src.tread) {     // crown with the tread maps (same kind: hidden / spun with its tyre)
        var trG = new Geo().append(src.tread, side < 0 ? mirror : null);
        part(trG, M.tread, 'tire-' + wd[0], Object.assign({ local: m4copy(m4(), lt), castShadow: false, maps: WM.tread }, base));
      }
      if (src.disc) part(new Geo().append(src.disc, side < 0 ? mirror : null), M.disc, 'wheel-' + wd[0], Object.assign({ local: m4copy(m4(), lt), castShadow: false, maps: WM.disc }, base));
      if (src.cal) part(new Geo().append(src.cal, side < 0 ? mirror : null), M.caliper, 'caliper-' + wd[0], { attach: 'caliper', wheel: info, local: m4copy(m4(), lt), maps: S.hasTex ? WM.caliper : null });
    });
    var tris = 0;
    parts.forEach(function (p) { tris += p.geo.tris(); });
    var dims = {
      length: S.L, width: S.W, height: S.openTop ? Math.max(S.roofY, S.eye[1] + 0.1) : S.H, wheelbase: S.wb, track: S.track, wheelRadius: Math.max(S.front.r, S.rear.r),
      wheelRadiusFront: S.front.r, wheelRadiusRear: S.rear.r, rideHeight: S.rh, frontOverhang: S.fo, rearOverhang: S.ro,
      frontAxle: S.xFA, rearAxle: S.xRA, belt: S.beltY, roof: S.openTop ? S.roofY : gTop(S, (S.xR0 + S.xR1) / 2), deck: S.deckY, nose: S.noseY,
      tireWidthFront: S.front.tw, tireWidthRear: S.rear.tw, style: S.style
    };
    if (useShape) {
      var sm = S.shapeModel;
      dims.height = S.H; dims.roof = S.openTop ? S.roofY : (topAt(S, (S.xR0 + S.xR1) / 2, 0) || S.roofY);
      dims.trackFront = S.front.track; dims.trackRear = S.rear.track;
      dims.model = sm.id; dims.make = sm.make; dims.modelName = sm.name;
    }
    var hoodX = S.xA + Math.min(0.1, (S.xF - S.xA) * 0.15);
    var hoodTop = topAt(S, hoodX, 0) || S.noseY;
    return {
      S: S, parts: parts, dims: dims, lod: S.lod,
      cockpitEye: S.eye.slice(), hoodCam: [hoodX, hoodTop + 0.21, 0], bumperCam: [S.xF + 0.04, Math.max(0.35, S.noseY - 0.12), 0],
      anchors: A, stats: { triangles: tris, parts: parts.length },
      susp: suspensionParams(S),
      model: useShape ? { id: S.shapeModel.id, make: S.shapeModel.make, name: S.shapeModel.name, style: S.shapeModel.style } : null
    };
  }
  function suspensionParams(S) {
    var stiff = clamp((S.springs - 20) / 180, 0, 1), arb = (S.arb - 1) / 9;
    return {
      omega: TAU * lerp(1.1, 2.4, stiff * 0.7 + arb * 0.3),
      zeta: lerp(0.25, 0.85, (S.damping - 1) / 9),
      rollGain: lerp(0.05, 0.018, stiff * 0.6 + arb * 0.4) * (S.style === 'suv' || S.style === 'van' || S.style === 'pickup' ? 1.5 : 1),
      pitchGain: lerp(0.03, 0.012, stiff),
      pivotY: S.rh + 0.25
    };
  }

  /* ================================================================ GL realisation + cache */
  function hasTextures(ctx) {
    return !!(ctx && CB.gl.textures && typeof CB.gl.textures.carNumber === 'function' && typeof document !== 'undefined');
  }
  function descriptorMesh(geo) {
    return { geometry: geo, count: geo.indices.length, vertexCount: geo.vertexCount, bounds: geo.bounds, draw: function () {}, destroy: function () {}, _descriptor: true };
  }
  function realize(ctx, desc, key, opts) {
    var canMesh = !!(ctx && ctx.gl && typeof CB.gl.createMesh === 'function');   // fake / headless ctx -> CPU descriptors
    var T = hasTextures(ctx) ? CB.gl.textures : null;
    var texCache = {};
    function tex(name) {
      if (!T) return null;
      if (texCache[name] !== undefined) return texCache[name];
      var t = null;
      try {
        if (name === 'carbon') t = T.carbonWeave(ctx);
        else if (name === 'carbonN') t = typeof T.carbonNormal === 'function' ? T.carbonNormal(ctx) : null;
        else if (name === 'carbonO') t = typeof T.carbonOrm === 'function' ? T.carbonOrm(ctx) : null;
        else if (name === 'tire') t = T.tireSidewall(ctx, { stripe: desc.S.compound === 'slick' || desc.S.compound === 'track' ? (desc.S.compound === 'slick' ? '#f2c200' : '#d01818') : undefined });
        else if (name === 'number') t = T.carNumber(ctx, desc.S.number, desc.S.numberColor);
        else if (name === 'plate' && typeof T.numberPlate === 'function') t = T.numberPlate(ctx, 'FG ' + ('00' + String(desc.S.number || 7).replace(/[^0-9A-Za-z]/g, '')).slice(-3));
      } catch (e) { t = null; }
      texCache[name] = t || null;
      return texCache[name];
    }
    /** PBR map set of a part (p.maps = {fam, o, rough, metal, ao, normalScale, mask}); null when unavailable */
    function mapSet(spec) {
      if (!T || typeof T.carSet !== 'function' || !spec) return null;
      var k = 'set:' + spec.fam + JSON.stringify(spec.o || {});
      if (texCache[k] !== undefined) return texCache[k];
      var set = null;
      try {
        set = T.carSet(ctx, spec.fam, spec.o || {});
        if (set && spec.mask != null && typeof T.generate === 'function' && typeof T.upload === 'function') set.emissiveMask = emissiveMask(spec);
      } catch (e) { set = null; }
      texCache[k] = set && set.map ? set : null;
      return texCache[k];
    }
    /** grey emissive mask from one channel of a lamp family's emissive map (R = beams / tail + brake), so only the
        lit elements glow (the shader multiplies the emissive colour by the map) */
    function emissiveMask(spec) {
      var c = maskCache(ctx), k = spec.fam + JSON.stringify(spec.o || {}) + spec.mask;
      if (c[k] !== undefined) return c[k];
      var res = T.generate(spec.fam + 'Emissive', spec.o || {}), src = res && res.source;
      if (!src || !src.data) return (c[k] = null);
      var d = src.data, out = new Uint8Array(d.length), ch = spec.mask, lift = spec.maskFloor || 0;
      for (var i = 0; i < d.length; i += 4) { var v = Math.max(d[i + ch], lift); out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = 255; }
      return (c[k] = T.upload(ctx, { width: src.width, height: src.height, data: out }, { wrapS: 'clamp', wrapT: 'clamp', aniso: 4 }));
    }
    var parts = [];
    desc.parts.forEach(function (p) {
      var geo = p.geo.finish(), mesh;
      if (canMesh) {
        try { mesh = CB.gl.createMesh(ctx, geo); } catch (e) { mesh = null; if (typeof console !== 'undefined') console.warn('[car-mesh] createMesh', p.kind, e && e.message); }
        if (!mesh) mesh = descriptorMesh(geo);   // keep the part (draw() is a no-op) so the model stays complete
      } else mesh = descriptorMesh(geo);
      var mat = p.material;
      if (p.texture) {
        var t = tex(p.texture);
        if (t) {
          // per-part copy so the shared material objects stay texture-free
          var mm = {}; for (var k in mat) mm[k] = mat[k];
          setMap(mm, t);
          if (p.texture === 'carbon') {
            mm.baseColor = mm.uBaseColor = mm.color = [1, 1, 1, 1];
            var cn = tex('carbonN'), co = tex('carbonO');
            if (cn) { mm.normalMap = cn; mm.normalScale = 0.6; }
            if (co) { mm.roughnessMap = co; mm.aoMap = co; mm.aoStrength = 0.5; }
          }
          mat = mm;
        } else if (p.texture === 'number') return;   // no texture -> the decal part is useless
        else if (p.texture === 'plate') {           // no plate map: plain plate grey instead of the white vertex colour
          var mp = {}; for (var kp in mat) mp[kp] = mat[kp];
          mp.baseColor = mp.uBaseColor = mp.color = [0.62, 0.62, 0.6, 1];
          mat = mp;
        }
      }
      if (p.maps) {
        var set = mapSet(p.maps), sp = p.maps, m2 = {}, k2;
        for (k2 in mat) m2[k2] = mat[k2];
        if (set) {
          setMap(m2, set.map);
          if (set.normalMap) { m2.normalMap = set.normalMap; m2.normalScale = num(sp.normalScale, 1); }
          if (set.ormMap) {
            m2.roughnessMap = set.ormMap; m2.aoMap = set.ormMap; m2.aoStrength = num(sp.ao, 0.8);
            if (sp.rough) m2.roughness = m2.uRoughness = sp.rough;
            if (sp.metal) m2.metallic = m2.uMetallic = sp.metal;
          }
          if (set.emissiveMask) m2.emissiveMap = set.emissiveMask;
          if (sp.uvScale) m2.uvScale = [sp.uvScale, sp.uvScale];
          mat = m2;
        } else if (sp.fallback && T) {      // maps unavailable: the white-vertex part gets its plain colour back
          m2.baseColor = m2.uBaseColor = m2.color = sp.fallback.slice();
          mat = m2;
        }
      }
      parts.push({
        mesh: mesh, material: mat, local: p.local, kind: p.kind, castShadow: p.castShadow, transparent: p.transparent,
        attach: p.attach, wheel: p.wheel, wing: p.wing, lightKey: p.lightKey, triangles: geo.triangleCount, geometry: canMesh ? undefined : geo
      });
    });
    var model = {
      parts: parts, dims: desc.dims, cockpitEye: desc.cockpitEye, hoodCam: desc.hoodCam, bumperCam: desc.bumperCam,
      anchors: desc.anchors, lod: desc.lod, key: key, stats: desc.stats, _susp: desc.susp, style: desc.S.style,
      number: desc.S.number, modelId: desc.model ? desc.model.id : null, realModel: desc.model, _refs: 1, _ctx: ctx, _driven: desc.S.driven, _drl: desc.S.drl, _laser: desc.S.lights === 'laser'
    };
    model.destroy = function () {
      model._refs--;
      if (model._refs > 0) return;
      parts.forEach(function (p) { if (p.mesh && typeof p.mesh.destroy === 'function') { try { p.mesh.destroy(); } catch (e) { /* ignore */ } } });
      parts.length = 0;
      var c = cacheOf(ctx, false);
      if (c && c.map[key] === model) delete c.map[key];
    };
    return model;
  }
  var ctxCaches = typeof WeakMap !== 'undefined' ? new WeakMap() : null, nullCache = { map: {} };
  var maskCaches = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function maskCache(ctx) {
    if (!maskCaches || !ctx || typeof ctx !== 'object') return {};
    var c = maskCaches.get(ctx);
    if (!c) { c = {}; maskCaches.set(ctx, c); }
    return c;
  }
  function cacheOf(ctx, create) {
    if (!ctx || typeof ctx !== 'object') return nullCache;
    if (ctxCaches) {
      var c = ctxCaches.get(ctx);
      if (!c && create) { c = { map: {} }; ctxCaches.set(ctx, c); }
      return c || null;
    }
    if (!ctx.__carCache && create) ctx.__carCache = { map: {} };
    return ctx.__carCache || null;
  }
  function hashStr(s) {
    var h1 = 0x811c9dc5, h2 = 5381;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = (Math.imul(h2, 33) + c) | 0; }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }
  function cacheKey(build, opts) {
    opts = opts || {};
    var b = build || {};
    var pick = {
      body: b.body, suspension: b.suspension && { rideHeight_mm: b.suspension.rideHeight_mm, camberFront_deg: b.suspension.camberFront_deg, camberRear_deg: b.suspension.camberRear_deg, damping: b.suspension.damping, springFront_nmm: b.suspension.springFront_nmm, springRear_nmm: b.suspension.springRear_nmm, arbFront: b.suspension.arbFront, arbRear: b.suspension.arbRear },
      wheels: b.wheels, tires: b.tires, brakes: b.brakes, aero: b.aero, exterior: b.exterior,
      engine: b.engine && { type: b.engine.type, layout: b.engine.layout, aspiration: b.engine.aspiration, exhaust: b.engine.exhaust, position: b.engine.position },
      weight: b.weight && { rollCage: b.weight.rollCage, glass: b.weight.glass }, interior: b.interior && { primaryColor: b.interior.primaryColor, accentColor: b.interior.accentColor, harness: b.interior.harness },
      drivetrain: b.drivetrain && b.drivetrain.layout,
      o: [opts.number, opts.color, opts.accent, opts.lod === 'low' ? 'low' : 'high', opts.length_m, opts.width_m, opts.isPlayer === true ? 1 : 0, opts.bodyStyle, lowpolyOn(opts) ? 'lp' : 'dt'],
      m: (function () { var sm = shapeModelFor(b, opts); return sm ? sm.id : null; })()
    };
    var s;
    try { s = JSON.stringify(pick); } catch (e) { s = String(Math.random()); }
    return 'car_' + hashStr(s) + '_' + (opts.lod === 'low' ? 'low' : 'high');
  }
  function build(ctx, buildObj, opts) {
    opts = opts || {};
    var key = cacheKey(buildObj, opts);
    var cache = cacheOf(ctx, true);
    var hit = cache && cache.map[key];
    if (hit && hit.parts && hit.parts.length) { hit._refs++; return hit; }
    var desc = buildGeometry(buildObj, { lod: opts.lod, number: opts.number, color: opts.color, accent: opts.accent, length_m: opts.length_m, width_m: opts.width_m, isPlayer: opts.isPlayer, bodyStyle: opts.bodyStyle, id: opts.id, shapes: opts.shapes, hasTextures: hasTextures(ctx) });
    var model = realize(ctx, desc, key, opts);
    if (cache) cache.map[key] = model;
    return model;
  }
  var cacheAPI = {
    key: cacheKey,
    get: function (ctx, key) { var c = cacheOf(ctx, false); return c ? c.map[key] || null : null; },
    size: function (ctx) { var c = cacheOf(ctx, false); return c ? Object.keys(c.map).length : 0; },
    clear: function (ctx) {
      var c = cacheOf(ctx, false);
      if (!c) return;
      Object.keys(c.map).forEach(function (k) {
        var m = c.map[k];
        if (m && m.parts) m.parts.forEach(function (p) { if (p.mesh && typeof p.mesh.destroy === 'function') { try { p.mesh.destroy(); } catch (e) { /* ignore */ } } });
      });
      c.map = {};
    }
  };

  /* ================================================================ pose */
  function initPose(model, st) {
    st._model = model;
    st.items = [];
    st.mW = m4(); st.mB = m4(); st.mT = m4(); st.mP = m4();
    st.roll = 0; st.rollV = 0; st.pitch = 0; st.pitchV = 0; st.heave = 0; st.heaveV = 0;
    st.spinF = 0; st.spinR = 0; st.steer = 0; st.has = false; st.aLong = 0; st.aLat = 0; st.bump = 0; st.wingAng = null;
    st.mats = {};
    model.parts.forEach(function (p) {
      var mat = p.material;
      if (/^light-/.test(p.kind)) {
        var mm = {}; for (var k in mat) mm[k] = mat[k];
        mm.emissive = [0, 0, 0]; mm.uEmissive = mm.emissive;
        st.mats[p.lightKey || p.kind] = mm; mat = mm;
      }
      st.items.push({ mesh: p.mesh, material: mat, model: m4(), kind: p.kind, castShadow: p.castShadow !== false, transparent: !!p.transparent, part: p });
    });
  }
  var SURF_BUMP = { kerb: 0.011, grass: 0.009, gravel: 0.012, sand: 0.008, dirt: 0.01, offtrack: 0.009 };
  function pose(model, c, dt, st) {
    if (!model || !model.parts) return [];
    st = st || {};
    c = c || {};
    if (st._model !== model || !st.items || st.items.length !== model.parts.length) initPose(model, st);
    dt = clamp(num(dt, 1 / 60), 0, 0.1);
    var P = model._susp || { omega: 9, zeta: 0.5, rollGain: 0.03, pitchGain: 0.02, pivotY: 0.4 };
    var x = num(c.x, 0), y = num(c.y, 0), h = num(c.heading, 0);
    var spd = Math.abs(num(c.speed, 0)), fwd = spd;
    if (isNum(c.vx) && isNum(c.vy)) {
      var dv = c.vx * Math.cos(h) + c.vy * Math.sin(h);
      if (Math.abs(dv) > 0.3) fwd = dv >= 0 ? spd : -spd;
      else if (num(c.gear, 1) < 0) fwd = -spd;
    } else if (num(c.gear, 1) < 0 || c.reverse) fwd = -spd;
    // ---- accelerations from the pose history
    if (st.has && dt > 1e-4) {
      var teleport = Math.hypot(x - st.x, y - st.y) > 80 * dt + 3;
      var aLong = teleport ? 0 : (fwd - st.v) / dt, yr = teleport ? 0 : wrapPi(h - st.h) / dt, aLat = fwd * yr;
      var k = 1 - Math.exp(-dt * 9);
      st.aLong += (clamp(aLong, -30, 30) - st.aLong) * k;
      st.aLat += (clamp(aLat, -35, 35) - st.aLat) * k;
    }
    if (dt > 0 || !st.has) { st.x = x; st.y = y; st.h = h; st.v = fwd; st.has = true; }
    // ---- spring-damper body motion
    var rollT = clamp(st.aLat / 9.81 * P.rollGain, -0.1, 0.1), pitchT = clamp(st.aLong / 9.81 * P.pitchGain, -0.065, 0.065);
    var surf = String(c.surface || (c.offTrack ? 'offtrack' : '')).toLowerCase(), amp = SURF_BUMP[surf] || 0;
    st.bump += dt * Math.max(spd, 0);
    var heaveT = amp ? amp * (Math.sin(st.bump * 4.1) * 0.55 + Math.sin(st.bump * 9.7 + 1.3) * 0.3 + Math.sin(st.bump * 17.3 + 0.4) * 0.15) * Math.min(1, spd / 6) : 0;
    var w = P.omega, z = P.zeta, n = Math.max(1, Math.ceil(dt / (1 / 240))), hs = dt / n;
    for (var i = 0; i < n; i++) {
      st.rollV += (w * w * (rollT - st.roll) - 2 * z * w * st.rollV) * hs; st.roll += st.rollV * hs;
      st.pitchV += (w * w * (pitchT - st.pitch) - 2 * z * w * st.pitchV) * hs; st.pitch += st.pitchV * hs;
      var wh = w * 2.2;
      st.heaveV += (wh * wh * (heaveT - st.heave) - 2 * 0.4 * wh * st.heaveV) * hs; st.heave += st.heaveV * hs;
    }
    if (!isFinite(st.roll + st.pitch + st.heave)) { st.roll = st.pitch = st.heave = st.rollV = st.pitchV = st.heaveV = 0; }
    // ---- wheels
    var dims = model.dims || {};
    var rF = num(dims.wheelRadiusFront, num(dims.wheelRadius, 0.33)), rR = num(dims.wheelRadiusRear, rF);
    var ws = clamp01(num(c.wheelspin, 0)), lay = model._driven || 'rwd';
    var extra = ws * 28 * dt * (fwd >= 0 ? 1 : -1);
    var lock = num(c.brake, 0) > 0.85 && num(c.skidding, 0) > 0.6 && spd > 4 ? 1 : 0;
    st.spinF = (st.spinF - (lock ? 0 : fwd * dt / rF) - (lay === 'fwd' || lay === 'awd' ? extra : 0)) % TAU;
    st.spinR = (st.spinR - fwd * dt / rR - (lay !== 'fwd' ? extra : 0)) % TAU;
    var steerT = clamp(num(c.steerAngle, 0), -0.75, 0.75);
    st.steer += (steerT - st.steer) * (1 - Math.exp(-dt * 30));
    if (dt === 0) st.steer = steerT;
    // ---- lights
    var brake = clamp01(num(c.brake, 0)), head = !!(c.headlights || c.lightsOn);
    var M = st.mats, e;
    if (M['light-brake']) {
      var be = head ? 0.7 : 0.3;     // small idle glow: the smoked lenses still read as red lamps in daylight
      if (brake > 0.03) be = 1.5 + 1.9 * brake;
      e = M['light-brake'].emissive; e[0] = be; e[1] = be * 0.018; e[2] = be * 0.012;   // stays saturated red through ACES
    }
    var drl = num(model._drl, 0.4);
    if (M['light-head']) {
      // with separate DRL light guides the lamp interior only glows with the beams on (emissive map = beam mask)
      var he = head ? 3.4 : M['light-drl'] ? 0.03 : drl;
      e = M['light-head'].emissive; e[0] = he; e[1] = he * 0.97; e[2] = he * (model._laser ? 1.05 : 0.9);
    }
    if (M['light-drl']) {      // daytime running lights: always on (halogen cars: only with the headlights)
      var de = drl > 0 ? 2.4 + drl * 2 + (head ? 0.6 : 0) : head ? 2.2 : 0.02;
      e = M['light-drl'].emissive; e[0] = de * 0.95; e[1] = de * 0.97; e[2] = de;
    }
    if (M['light-rev']) {
      var rev = num(c.gear, 1) < 0 || c.reverse ? 2.2 : 0;
      e = M['light-rev'].emissive; e[0] = rev; e[1] = rev; e[2] = rev;
    }
    // ---- matrices
    carMatrix(st.mW, x, y, 0, h, 0, 0);
    bodyLocal(st.mT, st.pitch, st.roll, st.heave, P.pivotY);
    m4mul(st.mB, st.mW, st.mT);
    var items = st.items;
    for (var q = 0; q < items.length; q++) {
      var it = items[q], p = it.part, W = p.wheel;
      if (p.attach === 'wheel' || p.attach === 'caliper') {
        var steer = W.front ? st.steer : 0;
        wheelLocal(st.mP, W.x, W.y, W.z - (W.side || (W.z < 0 ? -1 : 1)) * (W.inset || 0), steer, W.camber || 0, p.attach === 'wheel' ? (W.front ? st.spinF : st.spinR) : 0);
        m4mul(it.model, st.mW, st.mP);
      } else if (p.attach === 'car') {
        m4copy(it.model, st.mW);
      } else if (p.wing && p.wing.active) {
        var tgt = p.wing.base;
        if (spd > 22 && brake > 0.55) tgt = 48 * DEG; else if (spd > 58) tgt = p.wing.base * 0.3;
        if (st.wingAng === null || dt === 0) st.wingAng = tgt;
        st.wingAng += clamp(tgt - st.wingAng, -2.5 * dt, 2.5 * dt);
        rotZabout(st.mP, -st.wingAng, p.wing.pivot[0], p.wing.pivot[1]);
        m4mul(it.model, st.mB, st.mP);
      } else {
        m4copy(it.model, st.mB);
      }
    }
    st.bodyMatrix = st.mB;
    return items;
  }

  /* ================================================================ API */
  var API = {
    build: build,
    pose: pose,
    cache: cacheAPI,
    buildGeometry: buildGeometry,
    resolve: resolve,
    STYLES: STYLES.slice(),
    _: {
      ringHigh: ringHigh, ringLow: ringLow, ringGH: ringGH, ghInfo: ghInfo, insideCar: insideCar, topAt: topAt, sideAt: sideAt, cast: cast,
      edgeY: edgeY, floorY: floorY, halfW: halfW, archY: archY, gTop: gTop, carMatrix: carMatrix, wheelLocal: wheelLocal,
      bodyLocal: bodyLocal, m4mul: m4mul, xform: xform, emitGrid: emitGrid, Geo: Geo, airfoil: airfoil, cacheKey: cacheKey,
      suspensionParams: suspensionParams, LR: LR, GR: GR, smoothStations: smoothStations, stationBreaks: stationBreaks, loftNormals: loftNormals
    }
  };
  CB.gl.car = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();

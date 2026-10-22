/* ==========================================================================
   Redline — js/race/gl/drag-strip-mesh.js
   CB.gl.dragStrip : static geometry for Drag Racing (docs/DRAG-SPEC.md §1).

     CB.gl.dragStrip.buildGeometry(opts {venue 'strip'|'street', night, length (m, finish line), quality, seed})
        -> PURE (no GL): { groups: {name: geo}, dynamic: {...}, stats, opts }
        groups (vertex-coloured, linear colours, 4-component):
          ground   grass / pavement around the venue (no shadows)
          surface  the drivable strip / road (concrete launch pad, asphalt)
          decal    paint and rubber on the surface (lane lines, grooves, start / finish lines, crosswalks)
          water    the wet burnout box (glossy)
          wall     guard walls (Jersey barriers), kerbs
          struct   poles, the tree housing, grandstands, tower, buildings, stands, nets' posts, parked cars
          crowd    spectators (LOD by quality)
          glow     emissive bits (lamp heads at night, lit windows, tower windows)
          glass    tower glass (transparent)
          net      catch net (transparent)
          scenery  distant hills, trees
        dynamic: { tree: {x, bulbs: [{lane, kind, row, pos (GL), r}]}, boards: [{lane, pos, w, h, nrm}], winLights: [...],
                   lamps: [{pos (GL), dir}], flagger: {pos, shoulderL, shoulderR}|null, length, venue, night, signs: [...] }
     CB.gl.dragStrip.featureMeshGeos() -> { bulb, chute, line, bar, wheel, arm, flag, box } unit geometries (pure)
     CB.gl.dragStrip.build(ctx, opts) -> { items [draw items], dyn, meshes (feature meshes), stats, signTexture, destroy() }
   Sim axes: x down the strip, y left, z up; GL world = [x, z, -y] (as derby). Deterministic (seeded).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.gl = CB.gl || {};

(function () {
  'use strict';

  var PI = Math.PI, TAU = PI * 2;
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function madd(a, b, s) { return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.sqrt(dot(a, a)) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function hex(h, k) {
    h = String(h || '#ffffff').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16); k = num(k, 1);
    return [Math.pow(((n >> 16) & 255) / 255, 2.2) * k, Math.pow(((n >> 8) & 255) / 255, 2.2) * k, Math.pow((n & 255) / 255, 2.2) * k, 1];
  }
  function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(num(a[3], 1), num(b[3], 1), t)]; }
  function shade(c, k) { return [c[0] * k, c[1] * k, c[2] * k, num(c[3], 1)]; }
  function rng(seed) { var s = (seed >>> 0) || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  /** sim (x, y, z) -> GL [x, z, -y] */
  function P(x, y, z) { return [x, num(z, 0), -y]; }

  /* ---------------------------------------------------------------- geometry accumulator */
  function Geo() { this.p = []; this.n = []; this.c = []; this.i = []; this.uv = null; }
  Geo.prototype.v = function (p, n, c, uv) {
    this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.c.push(c[0], c[1], c[2], c[3] == null ? 1 : c[3]);
    if (uv) { if (!this.uv) this.uv = []; this.uv.push(uv[0], uv[1]); } else if (this.uv) this.uv.push(0, 0);
    return this.p.length / 3 - 1;
  };
  Geo.prototype.quad = function (a, b, c, d, col, n, uvs) {
    n = n || norm(cross(sub(b, a), sub(d, a)));
    var i0 = this.v(a, n, col, uvs && uvs[0]), i1 = this.v(b, n, col, uvs && uvs[1]), i2 = this.v(c, n, col, uvs && uvs[2]), i3 = this.v(d, n, col, uvs && uvs[3]);
    this.i.push(i0, i1, i2, i0, i2, i3);
  };
  /** GL box: centre, unit axes, half sizes */
  Geo.prototype.box = function (c, ax, ay, az, sx, sy, sz, col, colTop) {
    var X = mul(ax, sx), Y = mul(ay, sy), Z = mul(az, sz);
    function Q(i, j, k) { return add(add(add(c, mul(X, i)), mul(Y, j)), mul(Z, k)); }
    this.quad(Q(1, -1, -1), Q(1, 1, -1), Q(1, 1, 1), Q(1, -1, 1), col, ax);
    this.quad(Q(-1, -1, 1), Q(-1, 1, 1), Q(-1, 1, -1), Q(-1, -1, -1), col, mul(ax, -1));
    this.quad(Q(-1, 1, -1), Q(-1, 1, 1), Q(1, 1, 1), Q(1, 1, -1), colTop || col, ay);
    this.quad(Q(-1, -1, 1), Q(-1, -1, -1), Q(1, -1, -1), Q(1, -1, 1), col, mul(ay, -1));
    this.quad(Q(-1, -1, 1), Q(1, -1, 1), Q(1, 1, 1), Q(-1, 1, 1), col, az);
    this.quad(Q(1, -1, -1), Q(-1, -1, -1), Q(-1, 1, -1), Q(1, 1, -1), col, mul(az, -1));
  };
  /** sim-axis aligned box x0..x1, y0..y1, z0..z1 */
  Geo.prototype.sbox = function (x0, x1, y0, y1, z0, z1, col, colTop) {
    this.box(P((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), [1, 0, 0], [0, 1, 0], [0, 0, 1], Math.abs(x1 - x0) / 2, Math.abs(z1 - z0) / 2, Math.abs(y1 - y0) / 2, col, colTop);
  };
  /** flat ground rectangle (sim) at height z, facing up */
  Geo.prototype.flat = function (x0, x1, y0, y1, z, col, col2) {
    var c2 = col2 || col;
    var i0 = this.v(P(x0, y0, z), [0, 1, 0], col), i1 = this.v(P(x1, y0, z), [0, 1, 0], c2), i2 = this.v(P(x1, y1, z), [0, 1, 0], c2), i3 = this.v(P(x0, y1, z), [0, 1, 0], col);
    this.i.push(i0, i1, i2, i0, i2, i3);
  };
  Geo.prototype.cyl = function (p0, p1, r0, r1, seg, col, caps) {
    var ax = norm(sub(p1, p0)), t = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    var u = norm(cross(ax, t)), w = cross(ax, u), base = this.p.length / 3, k;
    for (k = 0; k <= seg; k++) {
      var a = k / seg * TAU, d = add(mul(u, Math.cos(a)), mul(w, Math.sin(a)));
      this.v(madd(p0, d, r0), d, col); this.v(madd(p1, d, r1), d, col);
    }
    for (k = 0; k < seg; k++) { var q = base + k * 2; this.i.push(q, q + 2, q + 3, q, q + 3, q + 1); }
    if (caps) {
      var c0 = this.v(p1, ax, col), c1 = this.v(p0, mul(ax, -1), col), b2 = this.p.length / 3;
      for (k = 0; k <= seg; k++) { var a2 = k / seg * TAU, d2 = add(mul(u, Math.cos(a2)), mul(w, Math.sin(a2))); this.v(madd(p1, d2, r1), ax, col); this.v(madd(p0, d2, r0), mul(ax, -1), col); }
      for (k = 0; k < seg; k++) { var q2 = b2 + k * 2; this.i.push(c0, q2, q2 + 2); this.i.push(c1, q2 + 3, q2 + 1); }
    }
  };
  Geo.prototype.sphere = function (c, r, segs, rings, col, sy) {
    var base = this.p.length / 3; sy = sy || 1;
    for (var i = 0; i <= rings; i++) {
      var v = i / rings * PI, y = Math.cos(v), rr = Math.sin(v);
      for (var j = 0; j <= segs; j++) {
        var u = j / segs * TAU, n = [Math.cos(u) * rr, y, Math.sin(u) * rr];
        this.v([c[0] + n[0] * r, c[1] + n[1] * r * sy, c[2] + n[2] * r], n, col);
      }
    }
    var row = segs + 1;
    for (i = 0; i < rings; i++) for (j = 0; j < segs; j++) { var q = base + i * row + j; this.i.push(q, q + row, q + row + 1, q, q + row + 1, q + 1); }
  };
  /** cone (GL), apex up from base centre */
  Geo.prototype.cone = function (b, r, h, seg, col) { this.cyl(b, add(b, [0, h, 0]), r, 0.001, seg, col, false); };
  Geo.prototype.tris = function () { return this.i.length / 3; };
  Geo.prototype.out = function () {
    var n = this.p.length / 3;
    var o = { positions: new Float32Array(this.p), normals: new Float32Array(this.n), colors: new Float32Array(this.c), colorSize: 4, indices: n > 65535 ? new Uint32Array(this.i) : new Uint16Array(this.i), triangles: this.i.length / 3 };
    if (this.uv) o.uvs = new Float32Array(this.uv);
    return o;
  };

  /* ---------------------------------------------------------------- constants */
  function GEO() {
    var g = CB.drag && CB.drag.strip && CB.drag.strip.GEO;
    return {
      LANE_Y: num(g && g.LANE_Y, 3.1), WALL_Y: num(g && g.WALL_Y, 7.6), PRESTAGE_X: num(g && g.PRESTAGE_X, -0.178), STAGE_X: num(g && g.STAGE_X, 0),
      BURNOUT_X0: num(g && g.BURNOUT_X0, -30), BURNOUT_X1: num(g && g.BURNOUT_X1, -14), START_X: num(g && g.START_X, -22), TREE_X: num(g && g.TREE_X, 6),
      SHUTDOWN: num(g && g.SHUTDOWN, 700), RETURN_Y: num(g && g.RETURN_Y, -24)
    };
  }
  var FT = 0.3048, MILE = 1609.344;
  /** marker positions along the strip for a finish distance L (m) */
  function markers(L) {
    var out = [{ x: 60 * FT, label: "60'" }, { x: 330 * FT, label: "330'" }, { x: MILE / 8, label: '1/8' }];
    if (L > 1000 * FT + 5) out.push({ x: 1000 * FT, label: "1000'" });
    if (L > MILE / 4 + 5) out.push({ x: MILE / 4, label: '1/4' });
    if (L > 1000 + 1 && L > MILE / 2 - 5) out.push({ x: MILE / 2, label: '1/2' });
    out = out.filter(function (m) { return m.x < L - 2; });
    out.push({ x: L, label: 'FINISH' });
    return out;
  }
  /** Christmas tree bulb layout (pure). Rows top -> bottom; lane 0 = left (+y), lane 1 = right (-y). Facing -x. */
  var TREE_ROWS = [
    { kind: 'preStage', z: 2.80, r: 0.055, pair: true },
    { kind: 'stage', z: 2.64, r: 0.055, pair: true },
    { kind: 'amber0', z: 2.40, r: 0.085 },
    { kind: 'amber1', z: 2.18, r: 0.085 },
    { kind: 'amber2', z: 1.96, r: 0.085 },
    { kind: 'green', z: 1.72, r: 0.085 },
    { kind: 'red', z: 1.48, r: 0.085 }
  ];
  function treeLayout(treeX) {
    var x = num(treeX, 6) - 0.17, bulbs = [];
    for (var lane = 0; lane < 2; lane++) {
      var yc = lane === 0 ? 0.2 : -0.2;
      for (var r = 0; r < TREE_ROWS.length; r++) {
        var row = TREE_ROWS[r];
        if (row.pair) for (var k = -1; k <= 1; k += 2) bulbs.push({ lane: lane, kind: row.kind, row: r, sim: [x, yc + k * 0.075, row.z], pos: P(x, yc + k * 0.075, row.z), r: row.r });
        else bulbs.push({ lane: lane, kind: row.kind, row: r, sim: [x, yc, row.z], pos: P(x, yc, row.z), r: row.r });
      }
    }
    return bulbs;
  }
  /** is a bulb lit for the tree lights object of its lane ({preStage, stage, amber[3], green, red}) */
  function bulbLit(kind, L) {
    if (!L) return false;
    if (kind === 'preStage') return !!L.preStage;
    if (kind === 'stage') return !!L.stage;
    if (kind === 'green') return !!L.green;
    if (kind === 'red') return !!L.red;
    if (kind.indexOf('amber') === 0) { var i = +kind.slice(5); return !!(L.amber && L.amber[i]); }
    return false;
  }

  /* ---------------------------------------------------------------- palettes */
  var C = {
    grass: hex('#5d8f3e'), grass2: hex('#6e9a45'), dirt: hex('#8a7556'), concrete: hex('#a7a59f'), concreteD: hex('#8e8c86'),
    asphalt: hex('#3b3c3f'), asphaltL: hex('#4a4b4e'), rubber: hex('#121212'), white: hex('#f2f2ee'), yellow: hex('#f3c613'),
    water: hex('#202428'), wall: hex('#d9d7d0'), wallStripe: hex('#d8262e'), steel: hex('#7c828a'), black: hex('#121315'),
    blue: hex('#1d4f9a'), red: hex('#c8202a'), sand: hex('#c9ad7c'), roof: hex('#b8bcc3'), seat: hex('#2a5fa8'), seat2: hex('#d6dadf'),
    tower: hex('#e6e2da'), hill: hex('#5f7a5a'), hill2: hex('#6d8a73'), tree: hex('#2f5a2e'), trunk: hex('#5a4030'),
    sidewalk: hex('#9b9a95'), kerb: hex('#bdbbb5'), lamp: hex('#fff3d6')
  };
  var CROWD = ['#d8262e', '#f2f2ee', '#1d4f9a', '#262626', '#f3c613', '#3a8a4a', '#8a3ab0', '#e07a20', '#5f6b78', '#a8c8e8'].map(function (h) { return hex(h); });
  var SKIN = ['#f1c9a5', '#d9a47c', '#a86f4c', '#6e4630', '#e8b88f'].map(function (h) { return hex(h); });
  var BUILD = ['#8c7f72', '#a89b8a', '#6f7782', '#b5aea2', '#5d6670', '#9a8070', '#c2b8a6', '#4f5660', '#7d6b5e'].map(function (h) { return hex(h); });
  var CARS = ['#c8202a', '#1d4f9a', '#f2f2ee', '#262626', '#7c828a', '#3a8a4a', '#e0a020', '#5a2a6a'].map(function (h) { return hex(h); });

  /* ---------------------------------------------------------------- builders */
  function person(g, x, y, z, R, lowQ, faceX) {
    var body = CROWD[Math.floor(R() * CROWD.length)], skin = SKIN[Math.floor(R() * SKIN.length)];
    var h = 0.55 + R() * 0.12;
    g.sbox(x - 0.16, x + 0.16, y - 0.22, y + 0.22, z, z + h, body);
    if (!lowQ) g.sbox(x - 0.11 + faceX * 0.02, x + 0.11 + faceX * 0.02, y - 0.1, y + 0.1, z + h, z + h + 0.24, skin);
  }
  function standingPerson(g, x, y, R, lowQ) {
    var body = CROWD[Math.floor(R() * CROWD.length)], legs = R() < 0.5 ? hex('#2a3448') : hex('#3a3a3a'), skin = SKIN[Math.floor(R() * SKIN.length)];
    g.sbox(x - 0.12, x + 0.12, y - 0.17, y + 0.17, 0, 0.85, legs);
    g.sbox(x - 0.15, x + 0.15, y - 0.24, y + 0.24, 0.85, 1.45, body);
    if (!lowQ) g.sbox(x - 0.11, x + 0.11, y - 0.1, y + 0.1, 1.45, 1.7, skin);
  }
  function lightPole(groups, x, y, h, night, side) {
    var st = groups.struct;
    st.cyl(P(x, y, 0), P(x, y, h), 0.16, 0.1, 6, C.steel);
    // lamp bank: a frame with 3x2 heads facing the strip
    var hy = y - side * 0.6, head = night ? hex('#fff6dc', 6) : hex('#d8dde2');
    st.sbox(x - 1.3, x + 1.3, hy - 0.15, hy + 0.15, h - 0.2, h + 1.4, C.steel);
    for (var i = 0; i < 3; i++) for (var j = 0; j < 2; j++) {
      var cx = x - 0.85 + i * 0.85, cz = h + 0.15 + j * 0.62;
      (night ? groups.glow : groups.struct).sbox(cx - 0.32, cx + 0.32, hy - side * 0.18 - 0.03, hy - side * 0.18 + 0.03, cz - 0.24, cz + 0.24, head);
    }
  }
  function bleachers(groups, x0, x1, y0, side, rows, R, crowdK, lowQ) {
    var st = groups.struct, cr = groups.crowd, depth = 1.35, rise = 0.55;
    for (var r = 0; r < rows; r++) {
      var yy0 = y0 + side * r * depth, yy1 = yy0 + side * depth, z1 = 0.9 + r * rise;
      st.sbox(x0, x1, Math.min(yy0, yy1), Math.max(yy0, yy1), z1 - 0.18, z1, r % 2 ? C.seat : C.seat2);
      st.sbox(x0, x1, Math.min(yy0, yy1) + (side > 0 ? 0 : depth - 0.12), Math.min(yy0, yy1) + (side > 0 ? 0.12 : depth), z1 - rise, z1 - 0.18, C.concreteD);
      if (crowdK > 0) for (var x = x0 + 0.4; x < x1 - 0.3; x += 0.62) {
        if (R() > crowdK) continue;
        person(cr, x + (R() - 0.5) * 0.14, yy0 + side * depth * 0.55, z1, R, lowQ, 0);
      }
    }
    var top = 0.9 + rows * rise, yb = y0 + side * rows * depth;
    // back wall, canopy roof on posts
    st.sbox(x0, x1, Math.min(yb, yb + side * 0.3), Math.max(yb, yb + side * 0.3), 0, top + 3.2, C.concreteD);
    st.sbox(x0 - 1, x1 + 1, Math.min(y0 - side * 1.5, yb + side * 0.3), Math.max(y0 - side * 1.5, yb + side * 0.3), top + 3.2, top + 3.45, C.roof);
    for (var px = x0; px <= x1 + 0.1; px += 12) st.cyl(P(px, y0 - side * 1.2, 0), P(px, y0 - side * 1.2, top + 3.2), 0.12, 0.12, 6, C.steel);
    // front rail
    st.sbox(x0, x1, Math.min(y0 - side * 0.05, y0 + side * 0.05), Math.max(y0 - side * 0.05, y0 + side * 0.05), 0, 1.0, C.white);
  }
  function jersey(g, x0, x1, y, side) {
    // Jersey-barrier profile extruded along x (sim). side: +1 = left wall (strip side is -y), -1 = right wall
    var prof = [[0, 0.32], [0.08, 0.32], [0.26, 0.2], [0.95, 0.09], [0.95, -0.09], [0.26, -0.2], [0.08, -0.32], [0, -0.32]];
    for (var seg = x0; seg < x1; seg += 40) {
      var a = seg, b = Math.min(x1, seg + 40), col = Math.floor(seg / 40) % 2 ? C.wall : shade(C.wall, 0.94);
      for (var k = 0; k < prof.length - 1; k++) {
        var p0 = prof[k], p1 = prof[k + 1];
        var A = P(a, y + p0[1], p0[0]), B = P(b, y + p0[1], p0[0]), Cc = P(b, y + p1[1], p1[0]), D = P(a, y + p1[1], p1[0]);
        g.quad(A, B, Cc, D, col);
      }
      // red band on top
      g.sbox(a, b, y - 0.1, y + 0.1, 0.95, 1.0, C.wallStripe);
    }
  }
  function hills(g, cx, R0, R) {
    var n = 40;
    for (var i = 0; i < n; i++) {
      var a0 = i / n * TAU, a1 = (i + 1) / n * TAU;
      var h0 = 40 + 70 * Math.abs(Math.sin(a0 * 3.1 + 1)) + 30 * R(), h1 = 40 + 70 * Math.abs(Math.sin(a1 * 3.1 + 1)) + 30 * R();
      var r0 = R0, r1 = R0 * 1.08;
      var A = [cx + Math.cos(a0) * r0, 0, Math.sin(a0) * r0], B = [cx + Math.cos(a1) * r0, 0, Math.sin(a1) * r0];
      var Cc = [cx + Math.cos(a1) * r1, h1, Math.sin(a1) * r1], D = [cx + Math.cos(a0) * r1, h0, Math.sin(a0) * r1];
      g.quad(A, B, Cc, D, i % 2 ? C.hill : C.hill2);
    }
  }
  function treeAt(g, x, y, s) {
    g.cyl(P(x, y, 0), P(x, y, 2 * s), 0.25 * s, 0.2 * s, 5, C.trunk);
    g.cone(P(x, y, 1.6 * s), 2.2 * s, 6 * s, 7, C.tree);
    g.cone(P(x, y, 4.2 * s), 1.6 * s, 4.2 * s, 7, shade(C.tree, 1.15));
  }
  function simpleCar(g, x, y, heading, col) {
    var c = Math.cos(heading), s = Math.sin(heading);
    var ctr = P(x, y, 0.62), ax = [c, 0, -s], az = [s, 0, c];
    g.box(ctr, ax, [0, 1, 0], az, 2.2, 0.34, 0.88, col);
    g.box(add(P(x, y, 1.12), mul(ax, -0.25)), ax, [0, 1, 0], az, 1.15, 0.2, 0.78, shade(col, 0.35));
    for (var i = -1; i <= 1; i += 2) for (var j = -1; j <= 1; j += 2) g.box(add(add(P(x, y, 0.33), mul(ax, i * 1.35)), mul(az, j * 0.86)), ax, [0, 1, 0], az, 0.33, 0.33, 0.12, C.black);
  }

  /* ---------------------------------------------------------------- strip venue */
  function buildStrip(G, groups, dyn, o, R) {
    var L = o.length, night = o.night, q = o.quality, lowQ = q === 'low';
    var X0 = -70, X1 = L + G.SHUTDOWN, WY = G.WALL_Y, LY = G.LANE_Y;
    var sf = groups.surface, dc = groups.decal, k;
    // ground (grass with tone noise), big
    var gx0 = -500, gx1 = X1 + 700, gy = 700, cell = 60;
    for (var gxx = gx0; gxx < gx1; gxx += cell) for (var gyy = -gy; gyy < gy; gyy += cell) {
      var t = R();
      groups.ground.flat(gxx, gxx + cell, gyy, gyy + cell, -0.02, mix(C.grass, C.grass2, t), mix(C.grass, C.grass2, R()));
    }
    // apron around the start (paved) and the pits on the right
    groups.ground.flat(-90, 60, -60, WY + 0.4, -0.005, shade(C.asphalt, 1.15));
    groups.ground.flat(-90, 60, WY + 0.4, 10.2, -0.005, shade(C.concreteD, 0.9));
    // surface: 10 m segments; staging lanes asphalt, launch pad concrete, then asphalt
    for (var x = X0; x < X1; x += 10) {
      var x2 = Math.min(X1, x + 10), mid = (x + x2) / 2;
      var col = mid < -35 ? C.asphaltL : mid < 100 ? mix(C.concrete, C.concreteD, R() * 0.5) : mix(C.asphalt, C.asphaltL, R() * 0.4);
      if (mid > 100 && mid < 130) col = mix(C.concreteD, C.asphalt, (mid - 100) / 30);
      sf.flat(x, x2, -WY, WY, 0, col);
    }
    // rubber grooves: two tyre tracks per lane, darkest past the burnout box, fading out by ~250 m
    for (var lane = 0; lane < 2; lane++) {
      var ly = lane === 0 ? LY : -LY;
      for (var tk = -1; tk <= 1; tk += 2) {
        var ty = ly + tk * 0.78;
        for (x = G.BURNOUT_X0; x < 260; x += 5) {
          var xm = x + 2.5, base = xm < 100 ? C.concrete : C.asphalt;
          var dark = xm < 0 ? 0.62 : xm < 30 ? 0.92 : clamp(0.92 - (xm - 30) / 230 * 0.8, 0.08, 0.92);
          dc.flat(x, x + 5, ty - 0.3, ty + 0.3, 0.004, mix(base, C.rubber, dark));
        }
      }
    }
    // lines: centre (white), lane edges (yellow), start lines, staging guide marks, finish (checker), split marks
    dc.flat(X0, X1, -0.07, 0.07, 0.006, C.white);
    for (var sgn = -1; sgn <= 1; sgn += 2) dc.flat(X0, X1, sgn * (LY + 3.05) - 0.06, sgn * (LY + 3.05) + 0.06, 0.006, C.yellow);
    for (lane = 0; lane < 2; lane++) {
      ly = lane === 0 ? LY : -LY;
      dc.flat(-0.05, 0.05, ly - 2.8, ly + 2.8, 0.007, C.white);
      dc.flat(G.PRESTAGE_X - 0.03, G.PRESTAGE_X + 0.03, ly - 2.8, ly + 2.8, 0.007, shade(C.white, 0.7));
      // burnout-box outline
      dc.flat(G.BURNOUT_X0, G.BURNOUT_X1, ly - 2.95, ly - 2.82, 0.007, C.white);
      dc.flat(G.BURNOUT_X0, G.BURNOUT_X1, ly + 2.82, ly + 2.95, 0.007, C.white);
      dc.flat(G.BURNOUT_X1 - 0.12, G.BURNOUT_X1, ly - 2.9, ly + 2.9, 0.007, C.white);
      groups.water.flat(G.BURNOUT_X0 + 0.2, G.BURNOUT_X1 - 1.2, ly - 2.7, ly + 2.7, 0.008, C.water);
      // finish line: checker band
      for (var ci = 0; ci < 12; ci++) for (var cj = 0; cj < 2; cj++) {
        var cy0 = ly - 3 + ci * 0.5;
        dc.flat(L - 0.5 + cj * 0.5, L + cj * 0.5, cy0, cy0 + 0.5, 0.007, (ci + cj) % 2 ? C.black : C.white);
      }
    }
    var MK = markers(L);
    MK.forEach(function (m) { if (m.label !== 'FINISH') for (var s2 = -1; s2 <= 1; s2 += 2) dc.flat(m.x - 0.15, m.x + 0.15, s2 * (LY + 2.6), s2 * (LY + 3.0), 0.007, C.white); });
    // walls (both sides), timing blocks at each marker
    jersey(groups.wall, -45, X1 - 80, WY, 1);
    jersey(groups.wall, -45, X1 - 80, -WY, -1);
    MK.forEach(function (m) {
      for (var s3 = -1; s3 <= 1; s3 += 2) {
        groups.struct.sbox(m.x - 0.15, m.x + 0.15, s3 * (WY - 0.45) - 0.12, s3 * (WY - 0.45) + 0.12, 0, 0.35, C.black);
        dyn.signs.push({ label: m.label, x: m.x, y: s3 * (WY + 0.35), z: 1.95, side: s3 });
        groups.struct.cyl(P(m.x - 0.7, s3 * (WY + 0.35), 0), P(m.x - 0.7, s3 * (WY + 0.35), 1.4), 0.05, 0.05, 5, C.steel);
        groups.struct.cyl(P(m.x + 0.7, s3 * (WY + 0.35), 0), P(m.x + 0.7, s3 * (WY + 0.35), 1.4), 0.05, 0.05, 5, C.steel);
      }
    });
    // staging beams: photo-eye boxes on both sides of each lane at the pre-stage and stage beams
    for (lane = 0; lane < 2; lane++) {
      ly = lane === 0 ? LY : -LY;
      for (var bs = -1; bs <= 1; bs += 2) {
        var by = ly + bs * 2.55;
        groups.struct.sbox(-0.35, 0.2, by - 0.09, by + 0.09, 0, 0.06, C.black);
        groups.struct.sbox(G.PRESTAGE_X - 0.05, G.PRESTAGE_X + 0.05, by - 0.06, by + 0.06, 0.06, 0.24, hex('#2a2a2a'));
        groups.struct.sbox(-0.05, 0.05, by - 0.06, by + 0.06, 0.06, 0.24, hex('#2a2a2a'));
        groups.glow.sbox(G.PRESTAGE_X - 0.02, G.PRESTAGE_X + 0.02, by - bs * 0.065 - 0.01, by - bs * 0.065 + 0.01, 0.15, 0.19, hex('#ff2010', 3));
        groups.glow.sbox(-0.02, 0.02, by - bs * 0.065 - 0.01, by - bs * 0.065 + 0.01, 0.15, 0.19, hex('#ff2010', 3));
      }
    }
    // the tree: pole, housing, visors; bulbs are dynamic
    var TX = G.TREE_X;
    groups.wall.sbox(TX - 0.5, TX + 0.5, -0.5, 0.5, 0, 0.35, C.wall);
    groups.struct.cyl(P(TX, 0, 0.3), P(TX, 0, 1.36), 0.075, 0.075, 8, C.black);
    groups.struct.sbox(TX - 0.13, TX + 0.13, -0.42, 0.42, 1.34, 2.95, C.black);
    groups.struct.sbox(TX - 0.11, TX + 0.11, -0.07, 0.07, 2.95, 3.25, C.black);   // centre stem / top
    var yf = hex('#f3c613');   // yellow border round the black face
    groups.struct.sbox(TX - 0.145, TX - 0.125, -0.41, 0.41, 2.88, 2.93, yf);
    groups.struct.sbox(TX - 0.145, TX - 0.125, -0.41, 0.41, 1.36, 1.41, yf);
    groups.struct.sbox(TX - 0.145, TX - 0.125, 0.36, 0.41, 1.36, 2.93, yf);
    groups.struct.sbox(TX - 0.145, TX - 0.125, -0.41, -0.36, 1.36, 2.93, yf);
    groups.struct.sbox(TX - 0.145, TX - 0.125, -0.012, 0.012, 1.41, 2.88, yf);
    var bl = treeLayout(TX);
    bl.forEach(function (b) {
      // visor over each bulb (sticks out toward the drivers)
      groups.struct.sbox(b.sim[0] - 0.12, b.sim[0] + 0.01, b.sim[1] - b.r * 1.25, b.sim[1] + b.r * 1.25, b.sim[2] + b.r * 1.05, b.sim[2] + b.r * 1.3, C.black);
    });
    dyn.tree = { x: TX, bulbs: bl };
    // finish: gantry + timing boards on both outer sides (facing the start), win lights
    var BX = L + 28;
    for (lane = 0; lane < 2; lane++) {
      var side = lane === 0 ? 1 : -1, yC = side * (WY + 6.5);
      groups.struct.cyl(P(BX, yC - 2.6, 0), P(BX, yC - 2.6, 6.2), 0.16, 0.16, 6, C.steel);
      groups.struct.cyl(P(BX, yC + 2.6, 0), P(BX, yC + 2.6, 6.2), 0.16, 0.16, 6, C.steel);
      groups.struct.sbox(BX - 0.1, BX + 0.35, yC - 3.3, yC + 3.3, 4.0, 9.0, C.black);
      dyn.boards.push({ lane: lane, pos: P(BX - 0.12, yC, 6.5), w: 6.2, h: 4.6, sim: [BX - 0.12, yC, 6.5] });
      dyn.winLights.push({ lane: lane, pos: P(BX - 0.15, yC, 9.4), sim: [BX - 0.15, yC, 9.4] });
      groups.struct.sbox(BX - 0.05, BX + 0.25, yC - 0.55, yC + 0.55, 9.0, 9.8, C.black);
    }
    // finish-line photocell gantry over the strip
    groups.struct.cyl(P(L, WY + 0.6, 0), P(L, WY + 0.6, 7), 0.14, 0.14, 6, C.steel);
    groups.struct.cyl(P(L, -WY - 0.6, 0), P(L, -WY - 0.6, 7), 0.14, 0.14, 6, C.steel);
    groups.struct.sbox(L - 0.25, L + 0.25, -WY - 0.8, WY + 0.8, 6.6, 7.3, hex('#1a1a1c'));
    // grandstands on the left (near the start) + a second stand mid-strip
    var crowdK = q === 'low' ? 0.28 : q === 'medium' ? 0.55 : 0.8;
    bleachers(groups, -60, 190, WY + 3.0, 1, lowQ ? 7 : 11, R, crowdK, lowQ);
    if (L > 300) bleachers(groups, 250, Math.min(L - 20, 380), WY + 3.0, 1, 6, R, crowdK * 0.8, lowQ);
    // spectators along the fence behind the wall on the right near the start
    for (x = -40; x < 120; x += 1.3) if (R() < crowdK * 0.6) standingPerson(groups.crowd, x + R() * 0.5, -WY - 3 - R() * 2.5, R, lowQ);
    // fence on the right
    for (x = -60; x < X1 - 80; x += 3) groups.struct.cyl(P(x, -WY - 1.8, 0), P(x, -WY - 1.8, 1.9), 0.035, 0.035, 4, C.steel);
    groups.net.flat(-60, X1 - 80, -WY - 1.8, -WY - 1.8, 0, hex('#999999'));
    groups.net.quad(P(-60, -WY - 1.8, 0), P(X1 - 80, -WY - 1.8, 0), P(X1 - 80, -WY - 1.8, 1.9), P(-60, -WY - 1.8, 1.9), [0.25, 0.27, 0.3, 0.35], [0, 0, 1]);
    // control tower on the right at the start line
    var tw = groups.struct;
    tw.sbox(-16, -2, -WY - 9, -WY - 4, 0, 7.5, C.tower);
    tw.sbox(-16.4, -1.6, -WY - 9.4, -WY - 3.6, 7.5, 8.0, C.roof);
    tw.sbox(-15, -3, -WY - 8.6, -WY - 4.4, 8.0, 10.8, C.tower);
    groups.glass.sbox(-14.6, -3.4, -WY - 4.45, -WY - 4.35, 8.5, 10.4, [0.12, 0.2, 0.26, 0.55]);
    groups.glass.sbox(-14.6, -3.4, -WY - 7.9, -WY - 7.8, 8.5, 10.4, [0.12, 0.2, 0.26, 0.55]);
    tw.sbox(-15.6, -2.4, -WY - 9.2, -WY - 3.8, 10.8, 11.2, C.roof);
    if (night) groups.glow.sbox(-14.5, -3.5, -WY - 4.5, -WY - 4.47, 8.6, 10.3, hex('#ffe9b8', 1.5));
    // pits: trailers / haulers behind the right fence
    for (var pk = 0; pk < (lowQ ? 6 : 14); pk++) {
      var px0 = -80 + pk * 13 + R() * 3, py0 = -WY - 22 - R() * 30, hc = CARS[Math.floor(R() * CARS.length)];
      groups.struct.sbox(px0, px0 + 11, py0 - 1.25, py0 + 1.25, 0.4, 3.6, shade(hc, 0.85), C.roof);
      groups.struct.sbox(px0 + 11, px0 + 13.5, py0 - 1.2, py0 + 1.2, 0.4, 3.2, shade(hc, 0.6));
    }
    // return road on the right, with turn-offs at both ends
    var RY = G.RETURN_Y;
    groups.surface.flat(-90, X1 - 40, RY - 3.2, RY + 3.2, -0.004, C.asphaltL);
    groups.surface.flat(X1 - 90, X1 - 40, RY, -WY, -0.004, C.asphaltL);
    groups.decal.flat(-90, X1 - 40, RY - 0.06, RY + 0.06, 0.002, C.yellow);
    // shutdown: sand trap and catch net at the end
    groups.ground.flat(X1 - 80, X1, -WY - 2, WY + 2, 0.003, C.sand);
    for (var ny = -WY - 2; ny <= WY + 2.01; ny += 2.5) groups.struct.cyl(P(X1 - 2, ny, 0), P(X1 - 2, ny, 4), 0.06, 0.06, 5, C.steel);
    groups.net.quad(P(X1 - 2, WY + 2, 0), P(X1 - 2, -WY - 2, 0), P(X1 - 2, -WY - 2, 4), P(X1 - 2, WY + 2, 4), [0.3, 0.3, 0.32, 0.45], [-1, 0, 0]);
    // light towers (lit at night)
    var dl = lowQ ? 90 : 60;
    for (x = -40; x < L + 240; x += dl) {
      lightPole(groups, x, WY + 2.2, 16, night, 1);
      lightPole(groups, x + dl / 2, -WY - 1.0, 16, night, -1);
      dyn.lamps.push({ pos: P(x, WY + 1.4, 15.8), sim: [x, WY + 1.4, 15.8] });
      dyn.lamps.push({ pos: P(x + dl / 2, -WY - 0.2, 15.8), sim: [x + dl / 2, -WY - 0.2, 15.8] });
    }
    // banner over the start line: REDLINE DRAGWAY (texture sign)
    groups.struct.cyl(P(-12, WY + 0.8, 0), P(-12, WY + 0.8, 7.6), 0.18, 0.18, 6, C.steel);
    groups.struct.cyl(P(-12, -WY - 0.8, 0), P(-12, -WY - 0.8, 7.6), 0.18, 0.18, 6, C.steel);
    groups.struct.sbox(-12.3, -11.7, -WY - 1, WY + 1, 7.6, 9.4, hex('#141416'));
    dyn.signs.push({ label: 'REDLINE DRAGWAY', x: -12.32, y: 0, z: 8.5, side: 0, w: 12, h: 1.4, faceX: -1 });
    // horizon: hills + trees
    hills(groups.scenery, L / 2, 1700, R);
    var nT = lowQ ? 60 : 180;
    for (k = 0; k < nT; k++) {
      var tx = -300 + R() * (X1 + 600), tyy = (R() < 0.5 ? 1 : -1) * (70 + R() * 420);
      treeAt(groups.scenery, tx, tyy, 0.8 + R() * 0.9);
    }
    // billboards far left
    for (k = 0; k < 4; k++) {
      var bx = 60 + k * Math.max(80, L / 4);
      groups.struct.cyl(P(bx, 60, 0), P(bx, 60, 8), 0.3, 0.3, 6, C.steel);
      groups.struct.sbox(bx - 7, bx + 7, 59.6, 60.2, 8, 13, [CARS[k % CARS.length][0], CARS[k % CARS.length][1], CARS[k % CARS.length][2], 1]);
    }
  }

  /* ---------------------------------------------------------------- street venue */
  function buildStreet(G, groups, dyn, o, R) {
    var L = o.length, night = o.night, lowQ = o.quality === 'low';
    var X0 = -260, X1 = L + G.SHUTDOWN, x, k;
    var RW = 9.4, SW = 14.5;   // road half width (incl. parking lanes), sidewalk outer edge
    groups.ground.flat(X0 - 300, X1 + 300, -700, 700, -0.03, hex('#5a5c58'));
    for (x = X0; x < X1; x += 20) groups.surface.flat(x, Math.min(X1, x + 20), -RW, RW, 0, mix(C.asphalt, C.asphaltL, R() * 0.6));
    var dc = groups.decal;
    // dashed centre line, solid lane edges, the racers' spray-painted start and finish lines
    for (x = X0; x < X1; x += 9) dc.flat(x, x + 4.5, -0.07, 0.07, 0.005, C.white);
    for (var s = -1; s <= 1; s += 2) dc.flat(X0, X1, s * 6.4 - 0.07, s * 6.4 + 0.07, 0.005, shade(C.white, 0.85));
    dc.flat(-0.12, 0.12, -6.3, 6.3, 0.006, hex('#f4f4f4'));
    dc.flat(L - 0.15, L + 0.15, -6.3, 6.3, 0.006, hex('#f4f4f4'));
    // tyre marks of earlier races at the line
    for (var lane = 0; lane < 2; lane++) {
      var ly = lane === 0 ? G.LANE_Y : -G.LANE_Y;
      for (var tk = -1; tk <= 1; tk += 2) for (x = -6; x < 70; x += 4) dc.flat(x, x + 4, ly + tk * 0.78 - 0.28, ly + tk * 0.78 + 0.28, 0.004, mix(C.asphalt, C.rubber, clamp(0.85 - x / 80, 0.05, 0.85)));
    }
    // kerbs + sidewalks
    for (s = -1; s <= 1; s += 2) {
      groups.wall.sbox(X0, X1, Math.min(s * RW, s * (RW + 0.3)), Math.max(s * RW, s * (RW + 0.3)), 0, 0.15, C.kerb);
      groups.surface.flat(X0, X1, Math.min(s * (RW + 0.3), s * SW), Math.max(s * (RW + 0.3), s * SW), 0.15, C.sidewalk);
    }
    // blocks of buildings with cross streets every ~150 m
    var blockLen = 150, street = 16;
    for (var bx = X0; bx < X1; bx += blockLen) {
      var b0 = bx + street / 2, b1 = bx + blockLen - street / 2;
      // crosswalks at the intersection
      for (var zz = -RW + 0.5; zz < RW - 0.5; zz += 1.2) dc.flat(bx - 3, bx + 1, zz, zz + 0.6, 0.005, shade(C.white, 0.9));
      groups.surface.flat(bx - street / 2, bx + street / 2, RW, 120, -0.001, C.asphaltL);
      groups.surface.flat(bx - street / 2, bx + street / 2, -120, -RW, -0.001, C.asphaltL);
      for (s = -1; s <= 1; s += 2) {
        var cx = b0;
        while (cx < b1 - 4) {
          var w = 10 + R() * 22; if (cx + w > b1) w = b1 - cx;
          var d = 14 + R() * 14, h = 8 + Math.pow(R(), 1.6) * (lowQ ? 40 : 70), col = BUILD[Math.floor(R() * BUILD.length)];
          var y0 = s * (SW + 0.5), y1 = s * (SW + 0.5 + d);
          groups.struct.sbox(cx, cx + w - 0.6, Math.min(y0, y1), Math.max(y0, y1), 0, h, col, shade(col, 0.8));
          // windows on the facade facing the road: bands of glass (lit at night)
          var fy = s * (SW + 0.48);
          for (var fz = 3.2; fz < h - 1.2; fz += 3.2) {
            for (var wx = cx + 0.8; wx < cx + w - 1.6; wx += 2.4) {
              var lit = night && R() < 0.42;
              (lit ? groups.glow : groups.struct).sbox(wx, wx + 1.5, Math.min(fy, fy - s * 0.04), Math.max(fy, fy - s * 0.04), fz, fz + 1.6, lit ? hex(R() < 0.5 ? '#ffd9a0' : '#cfe4ff', 1.6 + R()) : hex('#2c3540'));
            }
            if (lowQ) fz += 3.2;
          }
          // shop front at street level
          (night ? groups.glow : groups.struct).sbox(cx + 0.5, cx + w - 1.1, Math.min(fy, fy - s * 0.05), Math.max(fy, fy - s * 0.05), 0.4, 2.6, night ? hex(R() < 0.5 ? '#ffb070' : '#a0e0ff', 1.2) : hex('#3a4550'));
          cx += w;
        }
      }
    }
    // street lights both sides, alternating
    var dl = lowQ ? 55 : 35;
    for (x = X0 + 10; x < X1; x += dl) {
      s = Math.floor(x / dl) % 2 ? 1 : -1;
      var py = s * (RW + 1.0);
      groups.struct.cyl(P(x, py, 0.15), P(x, py, 8.5), 0.11, 0.08, 6, hex('#3a3d42'));
      groups.struct.sbox(x - 0.1, x + 0.1, Math.min(py, py - s * 2.2), Math.max(py, py - s * 2.2), 8.4, 8.6, hex('#3a3d42'));
      (night ? groups.glow : groups.struct).sbox(x - 0.4, x + 0.4, py - s * 2.2 - 0.25, py - s * 2.2 + 0.25, 8.25, 8.4, night ? hex('#ffd59a', 6) : hex('#c9ccd0'));
      dyn.lamps.push({ pos: P(x, py - s * 2.2, 8.2), sim: [x, py - s * 2.2, 8.2] });
    }
    // parked cars along the kerbs (clear of the start and finish areas)
    for (x = X0 + 6; x < X1 - 10; x += 6.5) {
      if (x > -45 && x < 40) continue;
      if (Math.abs(x - L) < 25) continue;
      for (s = -1; s <= 1; s += 2) if (R() < 0.55) simpleCar(groups.struct, x + R(), s * (RW - 1.15), R() < 0.5 ? 0 : PI, CARS[Math.floor(R() * CARS.length)]);
    }
    // crowd on the sidewalks around the start and the finish
    var ck = lowQ ? 0.3 : 0.7;
    for (x = -40; x < 45; x += 0.9) for (s = -1; s <= 1; s += 2) if (R() < ck) standingPerson(groups.crowd, x + R() * 0.4, s * (RW + 1.2 + R() * 3.5), R, lowQ);
    for (x = L - 20; x < L + 30; x += 1.1) for (s = -1; s <= 1; s += 2) if (R() < ck * 0.7) standingPerson(groups.crowd, x + R() * 0.4, s * (RW + 1.2 + R() * 3.5), R, lowQ);
    // the flagger (body static, arms dynamic) at the tree position
    var FX = G.TREE_X;
    groups.struct.sbox(FX - 0.12, FX + 0.12, 0.05, 0.2, 0, 0.88, hex('#2a3448'));
    groups.struct.sbox(FX - 0.12, FX + 0.12, -0.2, -0.05, 0, 0.88, hex('#2a3448'));
    groups.struct.sbox(FX - 0.15, FX + 0.15, -0.25, 0.25, 0.88, 1.5, hex('#f3c613'));   // hi-vis vest
    groups.struct.sbox(FX - 0.11, FX + 0.11, -0.1, 0.1, 1.5, 1.75, SKIN[1]);
    groups.struct.sbox(FX - 0.13, FX + 0.13, -0.12, 0.12, 1.72, 1.8, hex('#1a1a1a'));
    dyn.flagger = { pos: P(FX, 0, 0), shoulderL: P(FX, 0.29, 1.43), shoulderR: P(FX, -0.29, 1.43), sim: [FX, 0, 0] };
    // finish: a pair of cones and a phone-light "board" is the HUD's job; add traffic lights at the intersections
    for (bx = X0; bx < X1; bx += blockLen) for (s = -1; s <= 1; s += 2) {
      var tlx = bx + s * 6, tly = s * (RW + 0.6);
      groups.struct.cyl(P(tlx, tly, 0.15), P(tlx, tly, 4.2), 0.08, 0.08, 5, hex('#2a2c30'));
      groups.struct.sbox(tlx - 0.2, tlx + 0.2, tly - 0.18, tly + 0.18, 3.2, 4.3, hex('#1a1b1e'));
      groups.glow.sbox(tlx - 0.22, tlx - 0.2, tly - 0.1, tly + 0.1, 3.4, 3.6, hex('#ffb000', 3));
    }
    // signs: START / FINISH painted text
    dyn.signs.push({ label: 'START', x: -2.4, y: G.LANE_Y, z: 0.012, flat: true, w: 3.2, h: 1.0 });
    dyn.signs.push({ label: 'START', x: -2.4, y: -G.LANE_Y, z: 0.012, flat: true, w: 3.2, h: 1.0 });
    dyn.signs.push({ label: 'FINISH', x: L + 2.4, y: G.LANE_Y, z: 0.012, flat: true, w: 3.2, h: 1.0, back: true });
    dyn.signs.push({ label: 'FINISH', x: L + 2.4, y: -G.LANE_Y, z: 0.012, flat: true, w: 3.2, h: 1.0, back: true });
    // end of the road: barriers
    for (s = -1; s <= 1; s += 2) groups.wall.sbox(X1 - 2, X1 - 1, Math.min(0, s * RW), Math.max(0, s * RW), 0, 1.0, C.wallStripe);
    hills(groups.scenery, L / 2, 1900, R);
  }

  /* ---------------------------------------------------------------- public: pure geometry */
  var GROUPS = ['ground', 'surface', 'decal', 'water', 'wall', 'struct', 'crowd', 'glow', 'glass', 'net', 'scenery'];
  function normOpts(opts) {
    opts = opts || {};
    var L = opts.length;
    if (!(L > 0)) {
      var d = opts.distance;
      if (typeof d === 'number') L = d;
      else if (d && typeof d === 'object') L = d.m || d.stripM;
      else if (typeof d === 'string' && CB.drag && CB.drag.strip) L = CB.drag.strip.stripLength(d);
    }
    if (!(L > 0)) L = 402.336;
    return { venue: opts.venue === 'street' ? 'street' : 'strip', night: !!opts.night, length: clamp(L, 50, 3000), quality: ['low', 'medium', 'high', 'ultra'].indexOf(opts.quality) >= 0 ? opts.quality : 'high', seed: num(opts.seed, 7) };
  }
  function buildGeometry(opts) {
    var o = normOpts(opts), G = GEO(), R = rng(o.seed * 2654435761 + (o.venue === 'street' ? 99 : 1));
    var groups = {};
    GROUPS.forEach(function (k) { groups[k] = new Geo(); });
    var dyn = { tree: null, boards: [], winLights: [], lamps: [], flagger: null, signs: [], length: o.length, venue: o.venue, night: o.night };
    if (o.venue === 'street') buildStreet(G, groups, dyn, o, R); else buildStrip(G, groups, dyn, o, R);
    if (!dyn.tree) dyn.tree = { x: G.TREE_X, bulbs: o.venue === 'street' ? [] : treeLayout(G.TREE_X) };
    var out = {}, total = 0;
    GROUPS.forEach(function (k) { var g = groups[k]; if (g.tris()) { out[k] = g.out(); total += out[k].triangles; } });
    return { groups: out, dynamic: dyn, stats: { total: total }, opts: o };
  }

  /* ---------------------------------------------------------------- feature meshes (unit, local) */
  function featureMeshGeos() {
    var fg = {};
    // bulb: a lens (half sphere toward -X) on a short cylinder, unit radius
    var b = new Geo();
    b.sphere([0, 0, 0], 1, 10, 6, [1, 1, 1, 1], 1);
    fg.bulb = b.out();
    // glow halo: flat disc facing -X (additive), radius 1
    var h = new Geo(), n = 18, c0 = h.v([0, 0, 0], [-1, 0, 0], [1, 1, 1, 1]);
    for (var i = 0; i <= n; i++) { var a = i / n * TAU; h.v([0, Math.cos(a), Math.sin(a)], [-1, 0, 0], [0, 0, 0, 0]); }
    for (i = 0; i < n; i++) h.i.push(c0, c0 + 1 + i, c0 + 2 + i);
    fg.halo = h.out();
    // parachute canopy: dome opening toward +X (the car), apex at -X; red/white gores; unit radius / depth
    var ch = new Geo(), gores = 12, rings = 5;
    function cp(t, ang) { var rad = Math.sin(t * PI / 2), xx = -Math.cos(t * PI / 2) * 0.8; return [xx, Math.cos(ang) * rad, Math.sin(ang) * rad]; }
    for (var g = 0; g < gores; g++) {
      var col = g % 2 ? hex('#f2f2ee') : hex('#d8262e'), a0 = g / gores * TAU, a1 = (g + 1) / gores * TAU;
      for (var r = 0; r < rings; r++) {
        var t0 = r / rings, t1 = (r + 1) / rings;
        var A = cp(t0, a0), B = cp(t1, a0), Cq = cp(t1, a1), D = cp(t0, a1);
        ch.quad(A, B, Cq, D, col, norm(add(add(A, Cq), [-0.6, 0, 0])));
      }
    }
    fg.chute = ch.out();
    // a line: unit cylinder along +Y from 0 to 1
    var l = new Geo(); l.cyl([0, 0, 0], [0, 1, 0], 1, 1, 4, [1, 1, 1, 1]); fg.line = l.out();
    // generic unit box (half sizes 1)
    var bx = new Geo(); bx.box([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 1, 1, 1, [1, 1, 1, 1]); fg.box = bx.out();
    // small wheel (wheelie bar): cylinder along Z
    var wh = new Geo(); wh.cyl([0, 0, -1], [0, 0, 1], 1, 1, 10, [0.05, 0.05, 0.05, 1], true); fg.wheel = wh.out();
    // flagger arm: box from the shoulder (origin) down -Y, length 1
    var ar = new Geo(); ar.box([0, -0.5, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.06, 0.5, 0.06, hex('#f3c613')); ar.box([0, -1.02, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.05, 0.06, 0.05, SKIN[1]); fg.arm = ar.out();
    // flag: a cloth quad hanging from the hand (origin) along +Y up / +X
    var fl = new Geo(); fl.quad([0, 0, 0], [0.55, 0, 0], [0.55, 0.38, 0], [0, 0.38, 0], [1, 1, 1, 1], [0, 0, 1]); fg.flag = fl.out();
    return fg;
  }

  /* ---------------------------------------------------------------- textures (DOM) */
  /** Draw a sign atlas: one row per label, returns {canvas, cells {label: [u0, v0, u1, v1]}} or null without a DOM. */
  function signAtlas(labels, doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.createElement) return null;
    var uniq = []; labels.forEach(function (l) { if (uniq.indexOf(l) < 0) uniq.push(l); });
    var W = 512, rowH = 64, H = 1; while (H < rowH * Math.max(1, uniq.length)) H *= 2;
    var cv = doc.createElement('canvas'); cv.width = W; cv.height = H;
    var g = cv.getContext && cv.getContext('2d');
    if (!g) return null;
    var cells = {};
    uniq.forEach(function (lab, i) {
      var y = i * rowH, banner = lab.length > 8;
      g.fillStyle = banner ? '#141416' : '#f4f2ea'; g.fillRect(0, y, W, rowH);
      g.fillStyle = banner ? '#d8262e' : '#141416'; g.fillRect(0, y, W, 5); g.fillRect(0, y + rowH - 5, W, 5);
      g.fillStyle = banner ? '#ffffff' : '#141416';
      g.font = '900 ' + (banner ? 40 : 46) + 'px "Arial Black", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(banner ? lab : lab, W / 2, y + rowH / 2 + 2, W - 20);
      cells[lab] = [0, (y + 2) / H, 1, (y + rowH - 2) / H];
    });
    return { canvas: cv, cells: cells };
  }
  /** textured quads for the signs (geometry with uvs) */
  function signGeometry(signs, cells) {
    var g = new Geo(); g.uv = [];
    signs.forEach(function (s) {
      var c = cells[s.label]; if (!c) return;
      var w = s.w || (s.label.length > 4 ? 2.6 : 1.8), h = s.h || 0.75, col = [1, 1, 1, 1];
      var uv = [[c[0], c[3]], [c[2], c[3]], [c[2], c[1]], [c[0], c[1]]];   // bottom-left, bottom-right, top-right, top-left
      if (s.flat) {
        // painted on the road, readable from the start (text up = +x); back: readable looking back
        var dir = s.back ? -1 : 1;
        var A = P(s.x - dir * h / 2, s.y + dir * w / 2, s.z), B = P(s.x - dir * h / 2, s.y - dir * w / 2, s.z), Cc = P(s.x + dir * h / 2, s.y - dir * w / 2, s.z), D = P(s.x + dir * h / 2, s.y + dir * w / 2, s.z);
        g.quad(A, B, Cc, D, col, [0, 1, 0], uv);
      } else if (s.faceX) {
        // facing -x (toward the start): left edge at +y
        g.quad(P(s.x, s.y + w / 2, s.z - h / 2), P(s.x, s.y - w / 2, s.z - h / 2), P(s.x, s.y - w / 2, s.z + h / 2), P(s.x, s.y + w / 2, s.z + h / 2), col, [-1, 0, 0], uv);
      } else {
        // wall marker: two-sided board along the wall facing the strip and the outside (normal along y)
        var nIn = s.side > 0 ? [0, 0, 1] : [0, 0, -1];   // toward the strip (sim -y for the left wall = GL +z)
        // facing the strip: reading direction +x
        if (s.side > 0) g.quad(P(s.x - w / 2, s.y, s.z - h / 2), P(s.x + w / 2, s.y, s.z - h / 2), P(s.x + w / 2, s.y, s.z + h / 2), P(s.x - w / 2, s.y, s.z + h / 2), col, nIn, uv);
        else g.quad(P(s.x - w / 2, s.y, s.z - h / 2), P(s.x + w / 2, s.y, s.z - h / 2), P(s.x + w / 2, s.y, s.z + h / 2), P(s.x - w / 2, s.y, s.z + h / 2), col, nIn, uv);
      }
    });
    return g.tris() ? g.out() : null;
  }

  /* ---------------------------------------------------------------- GL build */
  function build(ctx, opts) {
    var G = CB.gl, res = buildGeometry(opts), items = [], meshes = [];
    function mk(geo) { if (!geo || !geo.triangles) return null; var m = G.createMesh(ctx, geo); meshes.push(m); return m; }
    var night = res.opts.night;
    var MAT = {
      ground: { name: 'drag-ground', color: [1, 1, 1, 1], roughness: 0.95, castShadow: false },
      surface: { name: 'drag-surface', color: [1, 1, 1, 1], roughness: 0.82, castShadow: false },
      decal: { name: 'drag-decal', color: [1, 1, 1, 1], roughness: 0.7, castShadow: false, polygonOffset: [-1, -3] },
      water: { name: 'drag-water', color: [1, 1, 1, 1], roughness: 0.06, metallic: 0.1, clearcoat: 1, envIntensity: 1.2, castShadow: false, polygonOffset: [-2, -5] },
      wall: { name: 'drag-wall', color: [1, 1, 1, 1], roughness: 0.75 },
      struct: { name: 'drag-struct', color: [1, 1, 1, 1], roughness: 0.55, metallic: 0.15, clearcoat: 0.15 },
      crowd: { name: 'drag-crowd', color: [1, 1, 1, 1], roughness: 0.85, castShadow: false },
      glow: { name: 'drag-glow', color: [1, 1, 1, 1], unlit: true, castShadow: false },
      glass: { name: 'glass-drag', color: [1, 1, 1, 1], roughness: 0.05, transparent: true, depthWrite: false, castShadow: false },
      net: { name: 'drag-net', color: [1, 1, 1, 1], unlit: true, transparent: true, depthWrite: false, castShadow: false, doubleSided: true },
      scenery: { name: 'drag-scenery', color: [1, 1, 1, 1], roughness: 0.9, castShadow: false }
    };
    Object.keys(res.groups).forEach(function (k) {
      var m = mk(res.groups[k]);
      if (!m) return;
      items.push({ mesh: m, material: MAT[k], kind: 'drag-' + k, castShadow: MAT[k].castShadow !== false, transparent: k === 'glass' || k === 'net' });
    });
    var fg = featureMeshGeos(), fm = {};
    Object.keys(fg).forEach(function (k) { fm[k] = mk(fg[k]); });
    // signs (canvas atlas texture)
    var signTex = null;
    try {
      var atlas = signAtlas(res.dynamic.signs.map(function (s) { return s.label; }));
      if (atlas && typeof G.createTexture === 'function') {
        signTex = G.createTexture(ctx, atlas.canvas, { wrap: 'clamp', mipmaps: true });
        var sg = signGeometry(res.dynamic.signs, atlas.cells), sm = mk(sg);
        if (sm) items.push({ mesh: sm, material: { name: 'drag-signs', color: [1, 1, 1, 1], map: signTex, roughness: 0.6, castShadow: false, polygonOffset: [-1, -4] }, kind: 'drag-signs', castShadow: false });
      }
    } catch (e) { /* signs optional */ }
    void night;
    return {
      items: items, dyn: res.dynamic, stats: res.stats, meshes: fm, opts: res.opts, signTexture: signTex,
      destroy: function () { meshes.forEach(function (m) { try { m.destroy(); } catch (e) { /* ignore */ } }); meshes = []; }
    };
  }

  CB.gl.dragStrip = {
    buildGeometry: buildGeometry, build: build, featureMeshGeos: featureMeshGeos, treeLayout: treeLayout, bulbLit: bulbLit, markers: markers,
    signAtlas: signAtlas, signGeometry: signGeometry, TREE_ROWS: TREE_ROWS, GROUPS: GROUPS, hex: hex,
    _: { Geo: Geo, P: P, normOpts: normOpts, GEO: GEO }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.gl.dragStrip;
})();

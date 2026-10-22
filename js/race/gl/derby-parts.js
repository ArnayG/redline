/* ==========================================================================
   Redline — js/race/gl/derby-parts.js
   CB.gl.derbyParts : Demolition Derby accessory meshes (docs/DERBY-SPEC.md §6, §9), shared by the derby renderer
   and the setup-garage preview. Also the small geometry accumulator (Geo) the derby arena meshes use.

     Geo                                    vertex-coloured geometry accumulator (box, obox, cyl, cone, sphere, quad, tri)
     hex(color, k?) -> linear rgba          (× k for emissive / unlit glow)
     dimsOf(model|dims) -> {L, W, H, nose, deck, belt, fA, rA, track, wr, tw}
     buildGeometry(ids, dims) -> PURE { groups {metal, dark, glow}, hammer {geo, pivot}|null, anchors {flame, magnet,
                                    hitch, hammerPivot, shield, nitro[]}, stats }
     ballGeometry(), chainLinkGeometry(), bubbleGeometry(), debrisGeometry(kind)     PURE unit shapes
     build(ctx, ids, dims) -> { items [{mesh, material, kind, local?}], hammer {mesh, material, pivot}|null, anchors, destroy() }
     MAT  shared material presets

   Car-local GL frame: +X forward, +Y up, +Z right, origin on the ground under the car centre.
   Classic script, zero dependencies (CB.gl only inside build()), Node-loadable.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.gl = CB.gl || {};

(function () {
  'use strict';
  var PI = Math.PI, TAU = PI * 2;
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
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
    if (!isFinite(n)) n = 0xffffff;
    return [Math.pow(((n >> 16) & 255) / 255, 2.2) * k, Math.pow(((n >> 8) & 255) / 255, 2.2) * k, Math.pow((n & 255) / 255, 2.2) * k, 1];
  }
  function rng(seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

  /* ---------------------------------------------------------------- geometry accumulator */
  function Geo() { this.p = []; this.n = []; this.c = []; this.i = []; }
  Geo.prototype.v = function (p, n, c) { this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.c.push(c[0], c[1], c[2], c[3] == null ? 1 : c[3]); return this.p.length / 3 - 1; };
  Geo.prototype.tri = function (a, b, c, col, n) {
    n = n || norm(cross(sub(b, a), sub(c, a)));
    var i0 = this.v(a, n, col), i1 = this.v(b, n, col), i2 = this.v(c, n, col);
    this.i.push(i0, i1, i2);
  };
  Geo.prototype.quad = function (a, b, c, d, col, n) {
    n = n || norm(cross(sub(b, a), sub(d, a)));
    var i0 = this.v(a, n, col), i1 = this.v(b, n, col), i2 = this.v(c, n, col), i3 = this.v(d, n, col);
    this.i.push(i0, i1, i2, i0, i2, i3);
  };
  /** oriented box: centre, unit axes, half sizes */
  Geo.prototype.box = function (c, ax, ay, az, sx, sy, sz, col, skipBottom) {
    var X = mul(ax, sx), Y = mul(ay, sy), Z = mul(az, sz);
    function P(i, j, k) { return add(add(add(c, mul(X, i)), mul(Y, j)), mul(Z, k)); }
    this.quad(P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), col, ax);
    this.quad(P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), P(-1, -1, -1), col, mul(ax, -1));
    this.quad(P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), col, ay);
    if (!skipBottom) this.quad(P(-1, -1, 1), P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), col, mul(ay, -1));
    this.quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), col, az);
    this.quad(P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), col, mul(az, -1));
  };
  Geo.prototype.aabb = function (c, sx, sy, sz, col, skipBottom) { this.box(c, [1, 0, 0], [0, 1, 0], [0, 0, 1], sx, sy, sz, col, skipBottom); };
  /** box rotated about the vertical axis by rot (GL yaw: rot is the SIM heading, so axis x = (cos, 0, -sin)) */
  Geo.prototype.ybox = function (c, rot, sx, sy, sz, col, skipBottom) {
    var ax = [Math.cos(rot), 0, -Math.sin(rot)], az = [Math.sin(rot), 0, Math.cos(rot)];
    this.box(c, ax, [0, 1, 0], az, sx, sy, sz, col, skipBottom);
  };
  /** box from p0 to p1 (a beam) with half thickness t (and optional up hint) */
  Geo.prototype.beam = function (p0, p1, t, col, upHint) {
    var d = sub(p1, p0), l = Math.sqrt(dot(d, d)) || 1e-6, ax = mul(d, 1 / l);
    var h = upHint || (Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
    var az = norm(cross(ax, h)), ay = cross(az, ax);
    this.box(mul(add(p0, p1), 0.5), ax, ay, az, l / 2, t, t, col);
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
  Geo.prototype.cone = function (p0, p1, r, seg, col) { this.cyl(p0, p1, r, 0.001, seg, col, false); };
  Geo.prototype.sphere = function (c, r, segs, rings, col, sy, jit) {
    var base = this.p.length / 3, R0 = jit ? rng(jit) : null;
    sy = sy || 1;
    for (var i = 0; i <= rings; i++) {
      var v = i / rings * PI, y = Math.cos(v), rr = Math.sin(v);
      for (var j = 0; j <= segs; j++) {
        var u = j / segs * TAU, n = [Math.cos(u) * rr, y, Math.sin(u) * rr];
        var k = R0 && i > 0 && i < rings && j < segs ? 0.8 + R0() * 0.35 : 1;
        this.v([c[0] + n[0] * r * k, c[1] + n[1] * r * sy * k, c[2] + n[2] * r * k], n, col);
      }
    }
    if (R0) for (var i2 = 1; i2 < rings; i2++) { var a = base + i2 * (segs + 1), b = a + segs; this.p[b * 3] = this.p[a * 3]; this.p[b * 3 + 1] = this.p[a * 3 + 1]; this.p[b * 3 + 2] = this.p[a * 3 + 2]; }
    var row = segs + 1;
    for (i = 0; i < rings; i++) for (j = 0; j < segs; j++) { var q = base + i * row + j; this.i.push(q, q + row, q + row + 1, q, q + row + 1, q + 1); }
  };
  /** flat horizontal disc (decal) at height y */
  Geo.prototype.disc = function (c, r, seg, col, jit) {
    var R0 = jit ? rng(jit) : null, ctr = this.v(c, [0, 1, 0], col), first = this.p.length / 3;
    for (var k = 0; k < seg; k++) { var a = k / seg * TAU, rr = r * (R0 ? 0.75 + R0() * 0.4 : 1); this.v([c[0] + Math.cos(a) * rr, c[1], c[2] + Math.sin(a) * rr], [0, 1, 0], col); }
    for (k = 0; k < seg; k++) this.i.push(ctr, first + (k + 1) % seg, first + k);
  };
  Geo.prototype.tris = function () { return this.i.length / 3; };
  Geo.prototype.out = function () {
    var n = this.p.length / 3;
    return { positions: new Float32Array(this.p), normals: new Float32Array(this.n), colors: new Float32Array(this.c), colorSize: 4, indices: n > 65535 ? new Uint32Array(this.i) : new Uint16Array(this.i), triangles: this.i.length / 3 };
  };

  /* ---------------------------------------------------------------- dims */
  function dimsOf(m) {
    var d = (m && m.dims) || m || {};
    var L = num(d.length, 4.5), W = num(d.width, 1.9), H = num(d.roof, num(d.height, 1.35));
    var fA = num(d.frontAxle, L * 0.3), rA = num(d.rearAxle, -L * 0.3);
    return { L: L, W: W, H: H, nose: num(d.nose, H * 0.55), deck: num(d.deck, H * 0.78), belt: num(d.belt, H * 0.72), fA: fA, rA: rA,
      track: num(d.track, W - 0.3), wr: num(d.wheelRadius, 0.34), tw: num(d.tireWidthFront, 0.26) };
  }

  var C = {
    steel: hex('#8e939a'), dark: hex('#2a2c30'), iron: hex('#4a4440'), rust: hex('#7a4a2a'), yellow: hex('#f2c200'), black: hex('#141414'),
    red: hex('#b8221a'), chrome: hex('#d8dce2'), blue: hex('#2a6fe0'), green: hex('#2ea85a'), white: hex('#f2f2f2'), copper: hex('#b06a2a'),
    flameGlow: hex('#ff7a1a', 3), cyanGlow: hex('#7ad7ff', 3), greenGlow: hex('#5fd18b', 2.5), redGlow: hex('#ff3020', 3)
  };

  /* ---------------------------------------------------------------- accessory geometry (pure) */
  function buildGeometry(ids, dims) {
    ids = Array.isArray(ids) ? ids : [];
    var D = dimsOf(dims), L2 = D.L / 2, W2 = D.W / 2, H = D.H;
    var metal = new Geo(), dark = new Geo(), glow = new Geo();
    var anchors = { nitro: [] }, hammer = null;
    function has(id) { return ids.indexOf(id) >= 0; }
    var X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
    // roof rack shared by roof / util items
    var roofItems = ['flamethrower', 'magnet', 'hammer', 'shield', 'repair'].filter(has).length;
    if (roofItems) {
      metal.beam([-0.55, H + 0.05, -W2 * 0.62], [0.35, H + 0.05, -W2 * 0.62], 0.025, C.dark);
      metal.beam([-0.55, H + 0.05, W2 * 0.62], [0.35, H + 0.05, W2 * 0.62], 0.025, C.dark);
      metal.beam([-0.5, H + 0.05, -W2 * 0.62], [-0.5, H + 0.05, W2 * 0.62], 0.025, C.dark);
      metal.beam([0.3, H + 0.05, -W2 * 0.62], [0.3, H + 0.05, W2 * 0.62], 0.025, C.dark);
    }
    if (has('flamethrower')) {
      // twin napalm tanks, pipe and a flared nozzle on the roof's leading edge
      var ty = H + 0.2;
      metal.cyl([-0.65, ty, -0.18], [0.1, ty, -0.18], 0.13, 0.13, 12, C.red, true);
      metal.cyl([-0.65, ty, 0.18], [0.1, ty, 0.18], 0.13, 0.13, 12, C.red, true);
      metal.beam([-0.3, H + 0.06, 0], [-0.3, ty, 0], 0.04, C.dark);
      metal.cyl([0.05, ty + 0.05, 0], [0.75, ty + 0.02, 0], 0.05, 0.05, 8, C.chrome, false);
      metal.cyl([0.72, ty + 0.02, 0], [0.98, ty, 0], 0.06, 0.12, 10, C.dark, false);
      glow.cyl([0.97, ty, 0], [0.99, ty, 0], 0.07, 0.07, 10, C.flameGlow, true);
      anchors.flame = [1.0, ty, 0];
    }
    if (has('ramp')) {
      // steel wedge on the nose: top edge at bonnet height, toe on the ground ahead
      var x0 = L2 - 0.2, x1 = L2 + 0.55, yT = Math.max(0.5, D.nose + 0.02), yB = 0.06, w = W2 * 0.96;
      var a = [x0, yT, -w], b = [x0, yT, w], c2 = [x1, yB, w], d2 = [x1, yB, -w];
      metal.quad(a, b, c2, d2, C.steel);
      // hazard stripes on the slope
      for (var s = 0; s < 6; s++) {
        var z0 = -w + (s * 2) * w / 6, z1 = z0 + w / 6;
        var lift = 0.006;
        var p0 = [x0 + 0.02, yT + lift, z0], p1 = [x0 + 0.02, yT + lift, z1], p2 = [x1 - 0.03, yB + lift, z1 + 0.15], p3 = [x1 - 0.03, yB + lift, z0 + 0.15];
        metal.quad(p0, p1, p2, p3, C.yellow);
      }
      metal.tri([x0, yB, -w], [x0, yT, -w], [x1, yB, -w], C.dark);
      metal.tri([x0, yB, w], [x1, yB, w], [x0, yT, w], C.dark);
      metal.quad([x0, yB, -w], [x0, yB, w], [x0, yT, w], [x0, yT, -w], C.dark);
    }
    if (has('bullbar')) {
      var bx = L2 + 0.14;
      [0.32, 0.62].forEach(function (y) { metal.cyl([bx, y, -W2 * 0.85], [bx, y, W2 * 0.85], 0.045, 0.045, 8, C.chrome, true); });
      [-0.6, -0.2, 0.2, 0.6].forEach(function (z) { metal.cyl([bx, 0.18, z * W2], [bx, 0.75, z * W2], 0.04, 0.04, 6, C.chrome, true); metal.beam([bx, 0.5, z * W2], [L2 - 0.15, 0.45, z * W2], 0.03, C.dark); });
      for (var k = 0; k < 7; k++) { var zz = -W2 * 0.78 + k * (W2 * 1.56 / 6); [0.32, 0.62].forEach(function (y) { metal.cone([bx, y, zz], [bx + 0.28, y, zz], 0.05, 6, C.steel); }); }
    }
    if (has('ram')) {
      metal.aabb([L2 + 0.35, 0.5, 0], 0.65, 0.13, 0.13, C.iron);
      metal.box([L2 + 1.05, 0.5, 0], X, Y, Z, 0.1, 0.22, 0.3, C.dark);
      metal.cone([L2 + 1.12, 0.5, 0], [L2 + 1.45, 0.5, 0], 0.2, 8, C.steel);
      metal.beam([L2 - 0.2, 0.42, -W2 * 0.7], [L2 + 0.75, 0.5, -0.1], 0.05, C.iron);
      metal.beam([L2 - 0.2, 0.42, W2 * 0.7], [L2 + 0.75, 0.5, 0.1], 0.05, C.iron);
      metal.aabb([L2 - 0.05, 0.42, 0], 0.08, 0.16, W2 * 0.85, C.dark);
    }
    if (has('armour')) {
      var ya = Math.max(0.55, D.belt * 0.62), hh = Math.max(0.18, D.belt * 0.32);
      [-1, 1].forEach(function (sd) {
        metal.box([0, ya, sd * (W2 + 0.04)], X, Y, Z, D.L * 0.34, hh, 0.025, C.steel);
        for (var r = -3; r <= 3; r++) dark.aabb([r * D.L * 0.1, ya + hh * 0.75, sd * (W2 + 0.07)], 0.025, 0.025, 0.012, C.dark);
        // window mesh
        for (var g = -2; g <= 2; g++) dark.beam([g * 0.25, D.belt + 0.04, sd * (W2 * 0.86)], [g * 0.25 + 0.05, H - 0.12, sd * (W2 * 0.7)], 0.012, C.dark);
      });
      metal.box([L2 - 0.02, 0.42, 0], X, Y, Z, 0.03, 0.17, W2 * 0.8, C.steel);
      metal.box([-L2 + 0.02, 0.45, 0], X, Y, Z, 0.03, 0.17, W2 * 0.8, C.steel);
    }
    if (has('nitro')) {
      var ny = Math.min(D.deck, H) + 0.12, nx0 = -L2 + 0.35, nx1 = nx0 + 0.75;
      [-0.28, 0.28].forEach(function (z) { metal.cyl([nx0, ny, z], [nx1, ny, z], 0.11, 0.11, 12, C.blue, true); metal.cyl([nx1, ny, z], [nx1 + 0.12, ny, z], 0.04, 0.04, 6, C.chrome, true); });
      metal.beam([nx1 + 0.1, ny, -0.28], [nx1 + 0.1, ny, 0.28], 0.02, C.chrome);
      anchors.nitro = [[-L2 - 0.05, 0.35, -0.35], [-L2 - 0.05, 0.35, 0.35]];
    }
    if (has('caltrops')) {
      metal.aabb([-L2 - 0.12, 0.5, 0], 0.16, 0.2, W2 * 0.55, C.dark);
      metal.box([-L2 - 0.12, 0.74, 0], X, Y, Z, 0.2, 0.04, W2 * 0.6, C.steel);
      for (var t2 = 0; t2 < 5; t2++) metal.cone([-L2 - 0.22, 0.32, -W2 * 0.4 + t2 * W2 * 0.2], [-L2 - 0.3, 0.22, -W2 * 0.4 + t2 * W2 * 0.2], 0.04, 4, C.steel);
    }
    if (has('oil')) {
      metal.cyl([-L2 - 0.25, 0.62, -W2 * 0.55], [-L2 - 0.25, 0.62, W2 * 0.55], 0.25, 0.25, 14, C.black, true);
      dark.cyl([-L2 - 0.25, 0.62, -W2 * 0.3], [-L2 - 0.25, 0.62, -W2 * 0.28], 0.26, 0.26, 14, C.yellow, false);
      dark.cyl([-L2 - 0.25, 0.62, W2 * 0.28], [-L2 - 0.25, 0.62, W2 * 0.3], 0.26, 0.26, 14, C.yellow, false);
      metal.beam([-L2 + 0.05, 0.42, -W2 * 0.4], [-L2 - 0.3, 0.42, -W2 * 0.4], 0.03, C.dark);
      metal.beam([-L2 + 0.05, 0.42, W2 * 0.4], [-L2 - 0.3, 0.42, W2 * 0.4], 0.03, C.dark);
      metal.cyl([-L2 - 0.4, 0.42, 0], [-L2 - 0.5, 0.3, 0], 0.04, 0.05, 6, C.dark, true);
    }
    if (has('magnet')) {
      var mx = 0.2;
      metal.cyl([-0.25, H + 0.06, 0], [-0.25, H + 0.2, 0], 0.16, 0.16, 10, C.dark, true);
      metal.beam([-0.25, H + 0.2, 0], [mx + 0.45, H + 0.95, 0], 0.06, C.yellow);
      metal.beam([mx + 0.45, H + 0.95, 0], [mx + 0.6, H + 0.75, 0], 0.03, C.dark);
      metal.cyl([mx + 0.6, H + 0.75, 0], [mx + 0.6, H + 0.6, 0], 0.42, 0.42, 16, C.red, true);
      dark.cyl([mx + 0.6, H + 0.6, 0], [mx + 0.6, H + 0.58, 0], 0.36, 0.36, 16, C.steel, true);
      anchors.magnet = [mx + 0.6, H + 0.58, 0];
    }
    if (has('hammer')) {
      // turret on the roof (static) + an animated boom: arm along +Y from the pivot, head at the end
      var pv = [-0.15, H + 0.22, 0];
      metal.cyl([pv[0], H + 0.04, 0], [pv[0], pv[1], 0], 0.2, 0.17, 12, C.dark, true);
      metal.cyl([pv[0], pv[1], -0.22], [pv[0], pv[1], 0.22], 0.1, 0.1, 10, C.yellow, true);
      var hg = new Geo();
      hg.beam([0, 0, 0], [0, 1.7, 0], 0.07, C.yellow, [1, 0, 0]);
      hg.beam([0.12, 0.2, 0], [0.12, 1.15, 0], 0.03, C.chrome, [1, 0, 0]);
      hg.box([0, 1.85, 0], X, Y, Z, 0.36, 0.22, 0.22, C.iron);
      hg.box([0, 1.85, 0], X, Y, Z, 0.4, 0.16, 0.16, C.dark);
      hammer = { geo: hg, pivot: pv };
      anchors.hammerPivot = pv;
    }
    if (has('wrecking-ball')) {
      metal.beam([-L2 + 0.1, 0.42, -0.3], [-L2 - 0.3, 0.5, 0], 0.035, C.dark);
      metal.beam([-L2 + 0.1, 0.42, 0.3], [-L2 - 0.3, 0.5, 0], 0.035, C.dark);
      metal.cyl([-L2 - 0.3, 0.42, 0], [-L2 - 0.3, 0.6, 0], 0.07, 0.07, 8, C.steel, true);
      anchors.hitch = [-L2 - 0.3, 0.55, 0];
    }
    if (has('saws')) {
      var sr = D.wr * 1.18;
      [[D.fA, -1], [D.fA, 1], [D.rA, -1], [D.rA, 1]].forEach(function (w) {
        var zc = w[1] * (D.track / 2 + D.tw / 2 + 0.06), y = D.wr;
        metal.cyl([w[0], y, zc - 0.012 * w[1]], [w[0], y, zc + 0.012 * w[1]], sr * 0.82, sr * 0.82, 16, C.chrome, true);
        for (var k = 0; k < 12; k++) {
          var a = k / 12 * TAU, a2 = a + 0.26;
          var p0 = [w[0] + Math.cos(a) * sr * 0.8, y + Math.sin(a) * sr * 0.8, zc], p1 = [w[0] + Math.cos(a2) * sr * 0.8, y + Math.sin(a2) * sr * 0.8, zc], p2 = [w[0] + Math.cos(a + 0.05) * sr * 1.05, y + Math.sin(a + 0.05) * sr * 1.05, zc];
          metal.tri(p0, p1, p2, C.steel, [0, 0, w[1]]);
        }
        dark.cyl([w[0], y, zc], [w[0], y, zc + 0.05 * w[1]], 0.08, 0.08, 8, C.dark, true);
      });
    }
    if (has('shield')) {
      metal.cyl([0.05, H + 0.06, 0], [0.05, H + 0.14, 0], 0.15, 0.15, 12, C.dark, true);
      glow.sphere([0.05, H + 0.22, 0], 0.1, 10, 6, C.cyanGlow);
      metal.cyl([0.05, H + 0.2, -0.18], [0.05, H + 0.2, 0.18], 0.02, 0.02, 6, C.chrome, true);
      anchors.shield = [0, H * 0.55, 0];
    }
    if (has('repair')) {
      metal.aabb([-0.35, H + 0.17, 0.32], 0.2, 0.1, 0.13, C.green);
      glow.aabb([-0.35, H + 0.28, 0.32], 0.12, 0.004, 0.03, C.white);
      glow.aabb([-0.35, H + 0.28, 0.32], 0.03, 0.004, 0.1, C.white);
    }
    if (has('spikes')) {
      metal.aabb([-L2 - 0.08, 0.38, 0], 0.07, 0.1, W2 * 0.9, C.dark);
      for (var q = 0; q < 6; q++) { var zq = -W2 * 0.78 + q * W2 * 1.56 / 5; metal.cone([-L2 - 0.12, 0.38, zq], [-L2 - 0.5, 0.36, zq], 0.07, 6, C.steel); }
    }
    var groups = { metal: metal, dark: dark, glow: glow };
    var tris = 0; Object.keys(groups).forEach(function (k) { tris += groups[k].tris(); });
    if (hammer) tris += hammer.geo.tris();
    return { groups: groups, hammer: hammer, anchors: anchors, stats: { triangles: tris, ids: ids.slice() } };
  }

  function ballGeometry() {
    var g = new Geo();
    g.sphere([0, 0, 0], 0.45, 14, 9, C.dark);
    for (var k = 0; k < 10; k++) {
      var a = k / 10 * TAU, b = (k % 2 ? 0.45 : -0.45);
      var d = norm([Math.cos(a) * Math.cos(b), Math.sin(b), Math.sin(a) * Math.cos(b)]);
      g.cone(mul(d, 0.38), mul(d, 0.66), 0.08, 5, C.steel);
    }
    g.cyl([0, 0.4, 0], [0, 0.56, 0], 0.06, 0.06, 6, C.steel, true);
    return g.out();
  }
  /** a chain link along +X (length 1, scaled per segment) */
  function chainLinkGeometry() {
    var g = new Geo();
    g.box([0.5, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.5, 0.035, 0.06, C.steel);
    return g.out();
  }
  function bubbleGeometry() { var g = new Geo(); g.sphere([0, 0, 0], 1, 20, 12, [1, 1, 1, 1]); return g.out(); }
  /** unit cube (beams, flashes) */
  function cubeGeometry(col) { var g = new Geo(); g.aabb([0, 0, 0], 0.5, 0.5, 0.5, col || [1, 1, 1, 1]); return g.out(); }
  /** debris pieces: 'panel' (bumper / bonnet, painted by material), 'chunk', 'wheel' */
  function debrisGeometry(kind) {
    var g = new Geo();
    if (kind === 'wheel') {
      g.cyl([0, 0, -0.13], [0, 0, 0.13], 0.34, 0.34, 14, C.black, true);
      g.cyl([0, 0, 0.13], [0, 0, 0.14], 0.22, 0.22, 10, C.chrome, true);
    } else if (kind === 'panel') {
      g.aabb([0, 0, 0], 0.45, 0.04, 0.8, [1, 1, 1, 1]);
      g.box([0.42, -0.08, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.05, 0.08, 0.78, [1, 1, 1, 1]);
    } else if (kind === 'hood') {
      // bonnet / boot lid: a bent, creased sheet (~1.2 x 1.5 m) with a dark underside
      var nx = 6, nz = 6, LX = 0.62, LZ = 0.74, pts = [];
      var Rh = rng(31);
      for (var ix = 0; ix <= nx; ix++) {
        pts[ix] = [];
        for (var iz = 0; iz <= nz; iz++) {
          var u = ix / nx * 2 - 1, w = iz / nz * 2 - 1;
          pts[ix][iz] = [u * LX, 0.06 * (1 - w * w) + Math.max(0, u) * 0.16 * Math.sin((w + 1) * 1.7) + (Rh() - 0.5) * 0.05, w * LZ];
        }
      }
      for (var a1 = 0; a1 < nx; a1++) for (var b1 = 0; b1 < nz; b1++) {
        var p00 = pts[a1][b1], p10 = pts[a1 + 1][b1], p11 = pts[a1 + 1][b1 + 1], p01 = pts[a1][b1 + 1];
        g.quad(p00, p01, p11, p10, [1, 1, 1, 1]);
        g.quad(add(p00, [0, -0.025, 0]), add(p10, [0, -0.025, 0]), add(p11, [0, -0.025, 0]), add(p01, [0, -0.025, 0]), [0.12, 0.12, 0.13, 1]);
      }
    } else if (kind === 'door') {
      // door: skin + dark inner frame + window frame stub; outer face = -Z (left door; the renderer mirrors right doors)
      g.box([0, 0, -0.03], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.55, 0.32, 0.03, [1, 1, 1, 1]);
      g.box([0, 0, 0.03], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.5, 0.28, 0.035, [0.1, 0.1, 0.11, 1]);
      g.beam([-0.5, 0.32, 0], [0.42, 0.32, 0], 0.035, [0.05, 0.05, 0.05, 1]);
      g.beam([-0.5, 0.32, 0], [-0.4, 0.68, 0], 0.035, [0.05, 0.05, 0.05, 1]);
      g.beam([-0.4, 0.68, 0], [0.32, 0.64, 0], 0.035, [0.05, 0.05, 0.05, 1]);
      g.box([0.12, 0.08, -0.07], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.07, 0.02, 0.025, C.chrome || [0.7, 0.7, 0.72, 1]);
    } else if (kind === 'bumper') {
      // bumper: a long bent beam with black lower grille
      var segs = 5, half = 0.85, prev = null, prevL = null;
      for (var s1 = 0; s1 <= segs; s1++) {
        var zz = s1 / segs * 2 * half - half, xx = -0.12 * (zz / half) * (zz / half) + (s1 === 2 ? 0.05 : 0);
        var cur = [xx, 0, zz], curL = [xx - 0.02, -0.14, zz];
        if (prev) { g.beam(prev, cur, 0.11, [1, 1, 1, 1]); g.beam(prevL, curL, 0.06, [0.05, 0.05, 0.05, 1]); }
        prev = cur; prevL = curL;
      }
    } else {
      // a torn, bent scrap of sheet metal / plastic (two plates at an angle, ~30 cm) instead of a rock
      g.box([-0.07, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.08, 0.012, 0.11, [1, 1, 1, 1]);
      var ca = Math.cos(0.5), sa = Math.sin(0.5);
      g.box([0.06, 0.03, 0.01], [ca, sa, 0], [-sa, ca, 0], [0, 0, 1], 0.07, 0.012, 0.09, [0.85, 0.85, 0.86, 1]);
    }
    return g.out();
  }
  /** caltrop patch (unit radius ~3.2 m): scattered tetra spikes */
  function caltropGeometry() {
    var g = new Geo(), R = rng(99);
    for (var k = 0; k < 42; k++) {
      var a = R() * TAU, r = Math.sqrt(R()) * 3.0, c = [Math.cos(a) * r, 0.06, Math.sin(a) * r];
      var h = 0.12 + R() * 0.06;
      g.cone(c, add(c, [(R() - 0.5) * 0.08, h, (R() - 0.5) * 0.08]), 0.07, 3, C.steel);
    }
    return g.out();
  }

  var MAT = {
    metal: { name: 'derby-acc-metal', color: [1, 1, 1, 1], roughness: 0.42, metallic: 0.55, clearcoat: 0.2 },
    dark: { name: 'derby-acc-dark', color: [1, 1, 1, 1], roughness: 0.65, metallic: 0.2 },
    glow: { name: 'derby-acc-glow', color: [1, 1, 1, 1], unlit: true, castShadow: false }
  };

  function build(ctx, ids, dims) {
    var G = CB.gl, res = buildGeometry(ids, dims), items = [], meshes = [];
    Object.keys(res.groups).forEach(function (k) {
      var g = res.groups[k];
      if (!g.tris()) return;
      var m = G.createMesh(ctx, g.out()); meshes.push(m);
      items.push({ mesh: m, material: MAT[k], kind: 'derby-acc-' + k, castShadow: k !== 'glow' });
    });
    var hammer = null;
    if (res.hammer) { var hm = G.createMesh(ctx, res.hammer.geo.out()); meshes.push(hm); hammer = { mesh: hm, material: MAT.metal, pivot: res.hammer.pivot }; }
    return { items: items, hammer: hammer, anchors: res.anchors, stats: res.stats, destroy: function () { meshes.forEach(function (m) { try { m.destroy(); } catch (e) { /* ignore */ } }); meshes = []; } };
  }

  CB.gl.derbyParts = {
    Geo: Geo, hex: hex, rng: rng, dimsOf: dimsOf, buildGeometry: buildGeometry, build: build, MAT: MAT, COLORS: C,
    ballGeometry: ballGeometry, chainLinkGeometry: chainLinkGeometry, bubbleGeometry: bubbleGeometry, cubeGeometry: cubeGeometry,
    debrisGeometry: debrisGeometry, caltropGeometry: caltropGeometry,
    _: { add: add, sub: sub, mul: mul, madd: madd, dot: dot, cross: cross, norm: norm }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.gl.derbyParts;
})();

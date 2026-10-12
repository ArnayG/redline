/* ==========================================================================
   Redline — js/race/gl/stunt-mesh.js
   CB.gl.stunt : geometry for the Arcade STUNT tracks (js/arcade/stunt-track.js) — bright plastic Hot-Wheels look.

     CB.gl.stunt.buildGeometry(track, opts {quality}) -> PURE (no GL): { groups: {name: geo}, dynamic: {...}, stats }
        groups (vertex-coloured, linear colours, 4-component):
          track   orange/blue plastic channel: lane stripes, chevrons, dashed centre, guard rails, underside
          glow    emissive strips (neon edges, boost-pad chevrons, start lights housing, arrow signs)
          support pylons / stilts to the ground plane, loop frames, corkscrew hoops
          ground  big tiled ground plane
          scenery theme props (stadium stands + floodlights, canyon mesas + cacti, toybox blocks + crayons,
                  neon towers with window strips, volcano cones + lava)
          deco    start/finish arch, flags, hazard lips at gaps, arrow boards
        dynamic: { boxes [{pos, up, fwd, id}], cans [...], coins [...], rings [{pos, fwd, up, r}], pads [{pos, fwd, up,
                   left, len, w}], lights [{pos}] (countdown lamps), featureIds }
     CB.gl.stunt.build(ctx, track, opts) -> { items [draw items], dyn (instances for the renderer), stats, destroy() }
   World axes: +Y up, metres (same as CB.arcade.stunt). Every geometry builder here is deterministic.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.gl = CB.gl || {};

(function () {
  'use strict';

  var PI = Math.PI, TAU = PI * 2, DEG = PI / 180;
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
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
  function rng(seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

  /* ---------------------------------------------------------------- palettes per theme */
  var THEMES = {
    stadium: { track: '#ff6a13', rail: '#ff8c2e', under: '#33343d', edge: '#ffffff', centre: '#ffd23f', chevron: '#ffe14a', pylon: '#e6e9ef', ground: ['#3d9c4c', '#358c43'], glow: '#ffb000', sky: 'day', neon: false },
    canyon: { track: '#ff5a1f', rail: '#ff7c3a', under: '#3a2a22', edge: '#fff4dc', centre: '#ffd23f', chevron: '#ffe14a', pylon: '#7a4a2e', ground: ['#c8793e', '#bd6f37'], glow: '#ffb000', sky: 'day', neon: false },
    toybox: { track: '#2f8bff', rail: '#1f6fe0', under: '#20304a', edge: '#ffffff', centre: '#ffd23f', chevron: '#ffe14a', pylon: '#ff3b30', ground: ['#e8c48a', '#dcb57a'], glow: '#ffd23f', sky: 'day', neon: false },
    neon: { track: '#2a1856', rail: '#3a1f7a', under: '#0d0a1c', edge: '#ff2fd6', centre: '#30e3ff', chevron: '#30e3ff', pylon: '#1a1530', ground: ['#0c0b1d', '#121034'], glow: '#ff2fd6', sky: 'night', neon: true },
    volcano: { track: '#ff8a1f', rail: '#ffb02e', under: '#2a1d1a', edge: '#ffffff', centre: '#ffd23f', chevron: '#ffe14a', pylon: '#4a4648', ground: ['#2d201c', '#382621'], glow: '#ff5a1a', sky: 'dusk', neon: false },
    glacier: { track: '#30c8ff', rail: '#1ea8e0', under: '#2a3a4a', edge: '#ffffff', centre: '#ff3b8a', chevron: '#ffffff', pylon: '#dfe8f0', ground: ['#e8f2ff', '#dbe9fb'], glow: '#7ae0ff', sky: 'day', neon: false }
  };
  function theme(track) { return THEMES[track.theme] || THEMES.stadium; }

  /* ---------------------------------------------------------------- geometry accumulator */
  function Geo() { this.p = []; this.n = []; this.c = []; this.i = []; }
  Geo.prototype.v = function (p, n, c) { this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.c.push(c[0], c[1], c[2], c[3] == null ? 1 : c[3]); return this.p.length / 3 - 1; };
  Geo.prototype.tri = function (a, b, c) { this.i.push(a, b, c); };
  /** Quad a-b-c-d (counter-clockwise seen from the normal side). n optional (flat). */
  Geo.prototype.quad = function (a, b, c, d, col, n) {
    n = n || norm(cross(sub(b, a), sub(d, a)));
    var i0 = this.v(a, n, col), i1 = this.v(b, n, col), i2 = this.v(c, n, col), i3 = this.v(d, n, col);
    this.i.push(i0, i1, i2, i0, i2, i3);
  };
  /** Smooth-normal quad strip piece: two edges (a0,a1) at ring A and (b0,b1) at ring B with per-vertex normals. */
  Geo.prototype.quadN = function (a0, a1, b1, b0, na, nb, col) {
    var i0 = this.v(a0, na, col), i1 = this.v(a1, na, col), i2 = this.v(b1, nb, col), i3 = this.v(b0, nb, col);
    this.i.push(i0, i1, i2, i0, i2, i3);
  };
  Geo.prototype.box = function (c, ax, ay, az, sx, sy, sz, col) {   // centre, unit axes, half sizes
    var X = mul(ax, sx), Y = mul(ay, sy), Z = mul(az, sz);
    function P(i, j, k) { return add(add(add(c, mul(X, i)), mul(Y, j)), mul(Z, k)); }
    this.quad(P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), col, ax);
    this.quad(P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), P(-1, -1, -1), col, mul(ax, -1));
    this.quad(P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), col, ay);
    this.quad(P(-1, -1, 1), P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), col, mul(ay, -1));
    this.quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), col, az);
    this.quad(P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), col, mul(az, -1));
  };
  Geo.prototype.aabb = function (c, sx, sy, sz, col) { this.box(c, [1, 0, 0], [0, 1, 0], [0, 0, 1], sx, sy, sz, col); };
  /** Cylinder between p0 and p1 (radius r0 at p0, r1 at p1), seg sides, optional caps. */
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
  /** Torus centred at c in the plane spanned by (u, w) (unit), major R, minor r. */
  Geo.prototype.torus = function (c, u, w, R, r, segR, segr, col) {
    var nrm = cross(u, w), base = this.p.length / 3;
    for (var i = 0; i <= segR; i++) {
      var a = i / segR * TAU, d = add(mul(u, Math.cos(a)), mul(w, Math.sin(a)));
      for (var j = 0; j <= segr; j++) {
        var b = j / segr * TAU, nn = add(mul(d, Math.cos(b)), mul(nrm, Math.sin(b)));
        this.v(add(add(c, mul(d, R)), mul(nn, r)), nn, col);
      }
    }
    var row = segr + 1;
    for (i = 0; i < segR; i++) for (j = 0; j < segr; j++) { var q = base + i * row + j; this.i.push(q, q + row, q + row + 1, q, q + row + 1, q + 1); }
  };
  Geo.prototype.tris = function () { return this.i.length / 3; };
  Geo.prototype.out = function () {
    var n = this.p.length / 3;
    return { positions: new Float32Array(this.p), normals: new Float32Array(this.n), colors: new Float32Array(this.c), colorSize: 4, indices: n > 65535 ? new Uint32Array(this.i) : new Uint16Array(this.i), triangles: this.i.length / 3 };
  };

  /* ---------------------------------------------------------------- track channel */
  var RAIL_H = 0.75, RAIL_W = 0.35, THICK = 0.55;
  function ringSamples(track, q) {
    // adaptive: new ring when the frame turns > maxAng or the distance exceeds maxD
    var maxAng = (q === 'low' ? 5 : 2.6) * DEG, maxD = q === 'low' ? 6 : 3.5, minD = 0.75;
    var out = [], L = track.length, s = 0, last = null;
    var F = track.FLAGS;
    for (s = 0; s < L; s += 0.5) {
      var sm = track.sample(s);
      var keep = !last;
      if (last) {
        var dd = s - last.s;
        var turn = Math.acos(clamp(dot(sm.tangent, last.tangent), -1, 1)) + Math.acos(clamp(dot(sm.up, last.up), -1, 1));
        var gapChange = ((sm.flags & F.gap) ? 1 : 0) !== ((last.flags & F.gap) ? 1 : 0);
        keep = gapChange || (dd >= minD && (turn > maxAng || dd >= maxD));
      }
      if (keep) { last = { s: s, pos: sm.pos.slice(), tangent: sm.tangent.slice(), up: sm.up.slice(), left: sm.left.slice(), hw: sm.halfWidth, flags: sm.flags }; out.push(last); }
    }
    return out;
  }
  function P(r, lat, h) { return [r.pos[0] + r.left[0] * lat + r.up[0] * h, r.pos[1] + r.left[1] * lat + r.up[1] * h, r.pos[2] + r.left[2] * lat + r.up[2] * h]; }

  function buildTrack(track, th, q, G, glow, deco) {
    var rings = ringSamples(track, q), F = track.FLAGS, n = rings.length;
    var cTrack = hex(th.track), cRail = hex(th.rail), cUnder = hex(th.under), cEdge = hex(th.edge), cCentre = hex(th.centre), cChev = hex(th.chevron, 1);
    var cTrackDark = hex(th.track, 0.82);
    var eGlow = hex(th.glow, th.neon ? 3.2 : 2.2), eCentre = hex(th.centre, th.neon ? 2.8 : 1);
    for (var i = 0; i < n; i++) {
      var A = rings[i], B = rings[(i + 1) % n];
      if ((A.flags & F.gap) || (B.flags & F.gap)) continue;
      if (i === n - 1 && track.length - A.s > 6) continue;
      var ha = A.hw, hb = B.hw, ua = A.up, ub = B.up, la = A.left, lb = B.left;
      var dash = Math.floor(A.s / 4) % 2 === 0;
      var band = Math.floor(A.s / 12) % 2 === 0 ? cTrack : cTrackDark;
      // top surface strips (left edge stripe, lane, centre dash, lane, right edge stripe)
      var strips = [[ha, ha - 0.55, hb, hb - 0.55, th.neon ? null : cEdge, th.neon ? eGlow : null],
        [ha - 0.55, 0.18, hb - 0.55, 0.18, band], [0.18, -0.18, 0.18, -0.18, dash ? (th.neon ? null : cCentre) : band, dash && th.neon ? eCentre : null],
        [-0.18, -(ha - 0.55), -0.18, -(hb - 0.55), band], [-(ha - 0.55), -ha, -(hb - 0.55), -hb, th.neon ? null : cEdge, th.neon ? eGlow : null]];
      for (var k = 0; k < strips.length; k++) {
        var st = strips[k];
        var tgt = st[4] ? G : glow, col = st[4] || st[5];
        tgt.quadN(P(A, st[0], 0), P(A, st[1], 0), P(B, st[3], 0), P(B, st[2], 0), ua, ub, col);
      }
      // rails: inner face, top, outer face (left then right)
      for (var sd = -1; sd <= 1; sd += 2) {
        var ia = sd * ha, ib = sd * hb, oa = sd * (ha + RAIL_W), ob = sd * (hb + RAIL_W);
        var inA = mul(la, -sd), inB = mul(lb, -sd);
        if (sd > 0) {
          G.quadN(P(A, ia, RAIL_H), P(A, ia, 0), P(B, ib, 0), P(B, ib, RAIL_H), inA, inB, cRail);
          G.quadN(P(A, oa, RAIL_H), P(A, ia, RAIL_H), P(B, ib, RAIL_H), P(B, ob, RAIL_H), ua, ub, th.neon ? cRail : cEdge);
          G.quadN(P(A, oa, -THICK), P(A, oa, RAIL_H), P(B, ob, RAIL_H), P(B, ob, -THICK), la, lb, cRail);
        } else {
          G.quadN(P(A, ia, 0), P(A, ia, RAIL_H), P(B, ib, RAIL_H), P(B, ib, 0), inA, inB, cRail);
          G.quadN(P(A, ia, RAIL_H), P(A, oa, RAIL_H), P(B, ob, RAIL_H), P(B, ib, RAIL_H), ua, ub, th.neon ? cRail : cEdge);
          G.quadN(P(A, oa, RAIL_H), P(A, oa, -THICK), P(B, ob, -THICK), P(B, ob, RAIL_H), mul(la, -1), mul(lb, -1), cRail);
        }
        if (th.neon) glow.quadN(P(A, sd * (ha + RAIL_W + 0.01), RAIL_H * 0.75), P(A, sd * (ha + RAIL_W + 0.01), RAIL_H * 0.45), P(B, sd * (hb + RAIL_W + 0.01), RAIL_H * 0.45), P(B, sd * (hb + RAIL_W + 0.01), RAIL_H * 0.75), mul(la, sd), mul(lb, sd), hex(sd > 0 ? th.glow : th.centre, 3));
      }
      // underside
      G.quadN(P(A, -(ha + RAIL_W), -THICK), P(A, ha + RAIL_W, -THICK), P(B, hb + RAIL_W, -THICK), P(B, -(hb + RAIL_W), -THICK), mul(ua, -1), mul(ub, -1), cUnder);
    }
    // hazard lips at every gap edge (yellow/black), chevrons on ramps leading to a lip
    track.gaps.forEach(function (g) {
      [[g.takeoffS, 1], [g.landS, -1]].forEach(function (e) {
        var sm = track.sample(e[0]), r = { pos: sm.pos, left: sm.left, up: sm.up }, hw = sm.halfWidth + RAIL_W, f = mul(sm.tangent, e[1]);
        var nStripe = 10;
        for (var k2 = 0; k2 < nStripe; k2++) {
          var l0 = -hw + 2 * hw * k2 / nStripe, l1 = -hw + 2 * hw * (k2 + 1) / nStripe;
          var col2 = k2 % 2 ? hex('#111111') : hex('#ffd200');
          deco.quad(P(r, l1, 0.06), P(r, l0, 0.06), P(r, l0, -THICK - 0.1), P(r, l1, -THICK - 0.1), col2, f);
          deco.quad(madd(P(r, l1, 0.07), sm.tangent, -1.2 * e[1]), madd(P(r, l0, 0.07), sm.tangent, -1.2 * e[1]), P(r, l0, 0.07), P(r, l1, 0.07), col2, sm.up);
        }
      });
      for (var d = 6; d < 30; d += 6) {   // run-up chevrons
        var sm2 = track.sample(g.takeoffS - d), r2 = { pos: sm2.pos, left: sm2.left, up: sm2.up };
        chevron(glow, r2, sm2.tangent, 0, 2.6, hex(th.chevron, 2.2));
      }
    });
    return rings;
  }
  function chevron(G, r, fwd, lat, w, col) {
    var h = 0.05, a = P(r, lat + w / 2, h), b = P(r, lat, h), c = P(r, lat - w / 2, h);
    var t = 1.1;
    var b2 = madd(b, fwd, t), a2 = madd(a, fwd, -0.2), c2 = madd(c, fwd, -0.2);
    var a3 = madd(a2, fwd, 0.7), c3 = madd(c2, fwd, 0.7), b3 = madd(b2, fwd, 0.7);
    G.quad(a2, a3, b3, b2, col, r.up); G.quad(b2, b3, c3, c2, col, r.up);
  }

  /* ---------------------------------------------------------------- supports */
  function buildSupports(track, th, q, G, rings) {
    var F = track.FLAGS, gy = track.groundY, cP = hex(th.pylon), cFoot = hex(th.under), every = q === 'low' ? 24 : 14, lastS = -1e9;
    var seg = q === 'low' ? 5 : 8;
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      if (r.s - lastS < every) continue;
      if (r.flags & (F.gap | F.loop | F.cork)) continue;
      if (r.up[1] < 0.55) continue;
      var under = P(r, 0, -THICK);
      var hgt = under[1] - gy;
      if (hgt < 0.8) continue;
      // something else (another track level) right below? -> skip this pylon
      var blocked = false;
      for (var y = under[1] - 3; y > gy + 1; y -= 4) {
        var pr = track.project([under[0], y, under[2]], { maxDist: 3.5, lateralMargin: 1.5, surfaceOnly: true });
        if (pr && Math.abs(CB.arcade.stunt._vec.wrapD(pr.s - r.s, track.length)) > 30) { blocked = true; break; }
      }
      if (blocked) continue;
      lastS = r.s;
      var wide = r.hw > 7 || hgt > 14;
      var offs = wide ? [-r.hw * 0.55, r.hw * 0.55] : [0];
      for (var k = 0; k < offs.length; k++) {
        var top = P(r, offs[k], -THICK + 0.05), bot = [top[0], gy, top[2]];
        var rad = clamp(0.35 + hgt * 0.012, 0.35, 0.8);
        G.cyl(bot, top, rad * 1.15, rad, seg, cP, false);
        G.cyl(bot, [bot[0], gy + 0.5, bot[2]], rad * 2.2, rad * 2.2, seg, cFoot, true);
      }
      if (wide) G.box(P(r, 0, -THICK - 0.35), r.left, r.up, cross(r.left, r.up), r.hw * 0.7, 0.3, 0.4, cP);
    }
    // loops: two side towers + top beam; corkscrews: hoops
    track.pieces.forEach(function (pc) {
      if (pc.type === 'loop') {
        var s0 = pc.s0, Lp = pc.length, top = null, topY = -1e9, ent = track.sample(s0 + 2);
        for (var d = 0; d < Lp; d += 2) { var sm = track.sample(s0 + d); if (sm.pos[1] > topY) { topY = sm.pos[1]; top = sm; } }
        if (!top) return;
        var side = cross(ent.tangent, [0, 1, 0]); side = norm(side);
        var mid = mul(add(ent.pos, track.sample(s0 + Lp - 2).pos), 0.5), half = 0.5 * Math.abs(dot(sub(track.sample(s0 + Lp - 2).pos, ent.pos), side)) + ent.halfWidth + 3;
        var cx = [top.pos[0], 0, top.pos[2]];
        var hY = topY + 2.5;
        [-1, 1].forEach(function (sg) {
          var base = madd([mid[0], gy, mid[2]], side, sg * half);
          base = [base[0] + (cx[0] - mid[0]) * 0, gy, base[2]];
          var tp = [base[0], hY, base[2]];
          G.cyl(base, tp, 0.9, 0.7, seg, cP, true);
          G.cyl(base, [base[0], gy + 0.6, base[2]], 1.8, 1.8, seg, cFoot, true);
        });
        var a = madd([mid[0], hY, mid[2]], side, -half), b = madd([mid[0], hY, mid[2]], side, half);
        G.box(mul(add(a, b), 0.5), side, [0, 1, 0], norm(cross(side, [0, 1, 0])), half, 0.45, 0.6, cP);
      } else if (pc.type === 'corkscrew') {
        for (var d2 = 6; d2 < pc.length - 4; d2 += 9) {
          var sm3 = track.sample(pc.s0 + d2), ax = sm3.tangent;
          var c = add(sm3.pos, mul(sm3.up, 7));
          var u = norm(cross(ax, [0, 1, 0])), w = cross(ax, u);
          G.torus(c, u, w, 7 + 1.4, 0.25, q === 'low' ? 16 : 28, 5, cP);
        }
      }
    });
  }

  /* ---------------------------------------------------------------- deco: arch, flags, arrow boards */
  function buildDeco(track, th, q, deco, glow, dyn) {
    var sm = track.sample(0), hw = sm.halfWidth + RAIL_W, r = { pos: sm.pos, left: sm.left, up: sm.up };
    var fwd = sm.tangent, H = 8.5;
    // checkered start line
    var cells = 16, cw = 2 * hw / cells;
    for (var row = 0; row < 3; row++) for (var k = 0; k < cells; k++) {
      var l0 = -hw + k * cw, l1 = l0 + cw, s0 = -1.5 + row * 1, col = (k + row) % 2 ? hex('#111111') : hex('#ffffff');
      var ra = track.sample(s0), rb = track.sample(s0 + 1);
      deco.quad(P(ra, l1, 0.04), P(ra, l0, 0.04), P(rb, l0, 0.04), P(rb, l1, 0.04), col, sm.up);
    }
    // arch pillars + checker banner
    [-1, 1].forEach(function (sd) {
      var base = P(r, sd * (hw + 1.2), -THICK);
      deco.box(madd(base, sm.up, H / 2), fwd, sm.up, cross(fwd, sm.up), 0.7, H / 2, 0.7, hex(th.pylon));
      deco.cyl(madd(base, sm.up, H), madd(base, sm.up, H + 3), 0.06, 0.06, 4, hex('#dddddd'), false);
      glow.quad(madd(madd(base, sm.up, H + 3), fwd, 0), madd(madd(base, sm.up, H + 1.8), fwd, 0), madd(madd(madd(base, sm.up, H + 1.8), fwd, 0), sm.left, sd * 1.6), madd(madd(madd(base, sm.up, H + 3), fwd, 0), sm.left, sd * 1.6), hex(sd > 0 ? th.glow : th.centre, 1.6), mul(fwd, -1));
    });
    var bc = 20, bw = 2 * (hw + 1.2) / bc;
    for (var j = 0; j < bc; j++) for (var rr = 0; rr < 2; rr++) {
      var a0 = -(hw + 1.2) + j * bw, a1 = a0 + bw, y0 = H - 1.6 + rr * 0.8, y1 = y0 + 0.8, cc = (j + rr) % 2 ? hex('#111111') : hex('#ffffff');
      deco.quad(P(r, a1, y0), P(r, a0, y0), P(r, a0, y1), P(r, a1, y1), cc, mul(fwd, -1));
      deco.quad(P(r, a0, y0), P(r, a1, y0), P(r, a1, y1), P(r, a0, y1), cc, fwd);
    }
    deco.box(P(r, 0, H + 0.25), fwd, sm.up, cross(fwd, sm.up), 0.5, 0.35, hw + 1.9, hex(th.rail));
    // countdown lights (5) under the banner: positions for the renderer's emissive lamps
    dyn.lights = [];
    for (var li = 0; li < 5; li++) dyn.lights.push({ pos: madd(P(r, -3 + li * 1.5, H - 2.3), fwd, -0.4) });
    // flags along the start straight
    var flagCols = ['#ff3b30', '#ffd23f', '#2f8bff', '#30e3a0', '#ff2fd6'];
    for (var fi = 0; fi < 8; fi++) {
      var fs = 12 + fi * 14, fm = track.sample(fs);
      if (!track.isSafe(fs)) continue;
      for (var sd2 = -1; sd2 <= 1; sd2 += 2) {
        var fr = { pos: fm.pos, left: fm.left, up: fm.up }, base2 = P(fr, sd2 * (fm.halfWidth + RAIL_W + 0.2), RAIL_H);
        var topF = madd(base2, fm.up, 3.2);
        deco.cyl(base2, topF, 0.05, 0.05, 4, hex('#eeeeee'), false);
        var fc = hex(flagCols[(fi + (sd2 > 0 ? 2 : 0)) % flagCols.length]);
        deco.quad(madd(topF, fm.up, -0.9), topF, madd(topF, fm.tangent, -1.4), madd(madd(topF, fm.tangent, -1.4), fm.up, -0.9), fc, fm.left);
        deco.quad(madd(madd(topF, fm.tangent, -1.4), fm.up, -0.9), madd(topF, fm.tangent, -1.4), topF, madd(topF, fm.up, -0.9), fc, mul(fm.left, -1));
      }
    }
    // big arrow boards (features 'arrow'): on the outside of the bend, facing the driver
    track.features.forEach(function (f) {
      if (f.type !== 'arrow') return;
      var am = track.sample(f.s + 25), ar = { pos: am.pos, left: am.left, up: am.up }, side = f.side < 0 ? -1 : 1;
      var c0 = P(ar, side * (am.halfWidth + 2.6), RAIL_H + 2.2), back = am.tangent;
      deco.cyl(P(ar, side * (am.halfWidth + 2.6), -THICK), madd(c0, am.up, -1.2), 0.12, 0.12, 5, hex('#cccccc'), false);
      var wv = am.left, hgt = 1.4, wd = 4.2;
      deco.quad(madd(madd(c0, wv, -wd / 2), am.up, -hgt / 2), madd(madd(c0, wv, wd / 2), am.up, -hgt / 2), madd(madd(c0, wv, wd / 2), am.up, hgt / 2), madd(madd(c0, wv, -wd / 2), am.up, hgt / 2), hex('#111111'), mul(back, -1));
      // three chevrons pointing toward the turn direction (= -side? turn left: arrows point left)
      var dirv = mul(wv, -side);   // arrow points across the board toward the inside of the bend
      for (var a = -1; a <= 1; a++) {
        var cc2 = madd(madd(c0, wv, a * 1.2), back, -0.05), tip = madd(cc2, dirv, 0.45);
        var t1 = madd(madd(cc2, dirv, -0.25), am.up, 0.5), t2 = madd(madd(cc2, dirv, -0.25), am.up, -0.5);
        glow.quad(t1, madd(t1, dirv, 0.3), madd(tip, dirv, 0.3), tip, hex(th.chevron, 2.4), mul(back, -1));
        glow.quad(tip, madd(tip, dirv, 0.3), madd(t2, dirv, 0.3), t2, hex(th.chevron, 2.4), mul(back, -1));
      }
    });
  }

  /* ---------------------------------------------------------------- dynamic feature anchors */
  function featureAnchors(track, dyn) {
    dyn.boxes = []; dyn.cans = []; dyn.coins = []; dyn.rings = []; dyn.pads = [];
    track.features.forEach(function (f) {
      var sm = track.sample(f.s), pos = track.pointAt(f.s, f.lat, 0);
      var o = { id: f.id, s: f.s, lat: f.lat, pos: pos, fwd: sm.tangent.slice(), up: sm.up.slice(), left: sm.left.slice() };
      if (f.type === 'box') { o.pos = madd(pos, sm.up, num(f.z, 1.0)); dyn.boxes.push(o); }
      else if (f.type === 'can') { o.pos = madd(pos, sm.up, 0.9); dyn.cans.push(o); }
      else if (f.type === 'coin') { o.pos = madd(pos, sm.up, num(f.z, 0.9)); dyn.coins.push(o); }
      else if (f.type === 'ring') { o.r = num(f.r, 2.8); o.pos = madd(pos, sm.up, num(f.z, 0.5) + o.r); dyn.rings.push(o); }
      else if (f.type === 'pad') { o.len = num(f.len, 7); o.w = num(f.w, 3.4); dyn.pads.push(o); }
    });
  }
  function padGeo(track, th, glow, dyn) {
    // boost pads: glowing plate with chevrons (static geometry; the renderer pulses the material)
    var G = new Geo();
    dyn.pads.forEach(function (p) {
      var n = 6;
      for (var k = 0; k < n; k++) {
        var s0 = p.s - p.len / 2 + k * p.len / n, sm = track.sample(s0), r = { pos: sm.pos, left: sm.left, up: sm.up };
        var sm1 = track.sample(s0 + p.len / n), r1 = { pos: sm1.pos, left: sm1.left, up: sm1.up };
        G.quadN(P(r, p.lat + p.w / 2, 0.035), P(r, p.lat - p.w / 2, 0.035), P(r1, p.lat - p.w / 2, 0.035), P(r1, p.lat + p.w / 2, 0.035), sm.up, sm1.up, hex(th.neon ? '#30e3ff' : '#ff3b1a', 1.0));
        chevron(G, { pos: sm.pos, left: sm.left, up: sm.up }, sm.tangent, p.lat, p.w * 0.8, hex('#ffe14a', 1.6));
      }
    });
    return G;
  }

  /* ---------------------------------------------------------------- ground + scenery */
  function trackNear2D(track) {
    var cell = 20, grid = {};
    var P0 = track.P, N = track.N;
    for (var i = 0; i < N; i += 2) {
      var k = Math.floor(P0[i * 3] / cell) + ',' + Math.floor(P0[i * 3 + 2] / cell);
      grid[k] = true;
    }
    return function (x, z, r) {
      var n = Math.ceil(r / cell);
      var cx = Math.floor(x / cell), cz = Math.floor(z / cell);
      for (var a = -n; a <= n; a++) for (var b = -n; b <= n; b++) if (grid[(cx + a) + ',' + (cz + b)]) return true;
      return false;
    };
  }
  function buildGround(track, th, q, G) {
    var b = track.bounds, pad = 420, gy = track.groundY;
    var x0 = b.min[0] - pad, x1 = b.max[0] + pad, z0 = b.min[2] - pad, z1 = b.max[2] + pad, tile = q === 'low' ? 80 : 40;
    var c0 = hex(th.ground[0]), c1 = hex(th.ground[1]), up = [0, 1, 0];
    var nx = Math.ceil((x1 - x0) / tile), nz = Math.ceil((z1 - z0) / tile);
    for (var i = 0; i < nx; i++) for (var j = 0; j < nz; j++) {
      var ax = x0 + i * tile, az = z0 + j * tile;
      G.quad([ax, gy, az + tile], [ax + tile, gy, az + tile], [ax + tile, gy, az], [ax, gy, az], (i + j) % 2 ? c0 : c1, up);
    }
    // far skirt (horizon fill)
    var far = 4000, cf = hex(th.ground[0], 0.9);
    G.quad([x0 - far, gy - 0.05, z1 + far], [x1 + far, gy - 0.05, z1 + far], [x1 + far, gy - 0.05, z0 - far], [x0 - far, gy - 0.05, z0 - far], cf, up);
  }
  function buildScenery(track, th, q, G, glow) {
    var R = rng(0x5eed ^ (track.length | 0)), b = track.bounds, gy = track.groundY, near = trackNear2D(track);
    var count = q === 'low' ? 26 : q === 'medium' ? 50 : 80, placed = 0, tries = 0;
    var x0 = b.min[0] - 260, x1 = b.max[0] + 260, z0 = b.min[2] - 260, z1 = b.max[2] + 260;
    var t = track.theme;
    var cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2, rad = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2 + 160;
    // ring of landmarks around the play area (stands / mesas / towers)
    var ringN = q === 'low' ? 10 : 18;
    for (var i = 0; i < ringN; i++) {
      var a = i / ringN * TAU + 0.2, px = cx + Math.cos(a) * rad, pz = cz + Math.sin(a) * rad;
      if (near(px, pz, 40)) continue;
      landmark(t, G, glow, [px, gy, pz], a, R, th);
    }
    while (placed < count && tries < count * 12) {
      tries++;
      var x = x0 + R() * (x1 - x0), z = z0 + R() * (z1 - z0);
      if (near(x, z, 30)) continue;
      prop(t, G, glow, [x, gy, z], R, th);
      placed++;
    }
  }
  function landmark(t, G, glow, p, a, R, th) {
    var face = [-Math.cos(a), 0, -Math.sin(a)], side = [-face[2], 0, face[0]];
    if (t === 'stadium') {
      // grandstand: stepped tiers with crowd colours + roof + floodlight
      for (var k = 0; k < 5; k++) {
        var tierC = madd(madd(p, face, -k * 3), [0, 1, 0], 1.5 + k * 2.2);
        G.box(tierC, side, [0, 1, 0], face, 26, 1.1 + k * 1.1, 1.6, hex(['#c43a3a', '#e6e6e6', '#2f6fd8', '#e6e6e6', '#ffd23f'][k]));
      }
      G.box(madd(madd(p, face, -6), [0, 1, 0], 14), side, [0, 1, 0], face, 27, 0.4, 8, hex('#d8dbe2'));
      var fl = madd(p, side, 30);
      G.cyl(fl, madd(fl, [0, 1, 0], 34), 0.6, 0.4, 6, hex('#aab0bb'), false);
      glow.box(madd(fl, [0, 1, 0], 35), side, [0, 1, 0], face, 3, 1.2, 0.4, hex('#fff4d8', 3));
    } else if (t === 'canyon') {
      var h = 30 + R() * 50, w = 30 + R() * 30;
      G.box(madd(p, [0, 1, 0], h / 2), side, [0, 1, 0], face, w, h / 2, w * 0.7, hex(['#b5582c', '#c8693a', '#9e4a26'][Math.floor(R() * 3)]));
      G.box(madd(p, [0, 1, 0], h + 1.5), side, [0, 1, 0], face, w * 0.82, 1.5, w * 0.6, hex('#d9875a'));
    } else if (t === 'neon') {
      var h2 = 60 + R() * 120, w2 = 18 + R() * 16;
      G.box(madd(p, [0, 1, 0], h2 / 2), side, [0, 1, 0], face, w2, h2 / 2, w2, hex('#141228'));
      for (var y = 8; y < h2 - 4; y += 7) glow.box(madd(madd(p, [0, 1, 0], y), face, w2 + 0.05), side, [0, 1, 0], face, w2 * 0.9, 0.35, 0.05, hex(R() < 0.5 ? '#ff2fd6' : '#30e3ff', 2.2));
      glow.box(madd(p, [0, 1, 0], h2 + 1), side, [0, 1, 0], face, w2 * 0.6, 0.6, w2 * 0.6, hex('#ffe14a', 2));
    } else if (t === 'volcano') {
      var h3 = 60 + R() * 90, r3 = 50 + R() * 40;
      G.cyl(p, madd(p, [0, 1, 0], h3), r3, r3 * 0.22, 9, hex('#3a2a26'), false);
      glow.cyl(madd(p, [0, 1, 0], h3 - 0.5), madd(p, [0, 1, 0], h3 + 0.4), r3 * 0.2, r3 * 0.12, 9, hex('#ff5a1a', 3.2), true);
    } else {   // toybox: giant ABC blocks stacked
      var s = 10 + R() * 8, cols = ['#ff3b30', '#2f8bff', '#ffd23f', '#30e3a0', '#b64dff'];
      for (var k2 = 0; k2 < 3; k2++) G.box(madd(p, [0, 1, 0], s * (k2 + 0.5) * 1.02), side, [0, 1, 0], face, s / 2, s / 2, s / 2, hex(cols[Math.floor(R() * cols.length)]));
    }
  }
  function prop(t, G, glow, p, R, th) {
    var up = [0, 1, 0];
    if (t === 'canyon') {
      if (R() < 0.5) { var h = 3 + R() * 5; G.cyl(p, madd(p, up, h), 0.5, 0.4, 6, hex('#3f8f3a'), true); G.cyl(madd(p, up, h * 0.55), madd(madd(p, up, h * 0.55), [1, 0, 0], 1.4), 0.3, 0.3, 5, hex('#3f8f3a'), true); }
      else G.aabb(madd(p, up, 1.5), 2 + R() * 4, 1.5 + R() * 2, 2 + R() * 4, hex('#a2502a'));
    } else if (t === 'neon') {
      var h2 = 20 + R() * 50, w = 8 + R() * 10;
      G.aabb(madd(p, up, h2 / 2), w, h2 / 2, w, hex('#17142e'));
      glow.aabb(madd(p, up, h2 + 0.2), w * 0.98, 0.25, w * 0.98, hex(R() < 0.5 ? '#ff2fd6' : '#30e3ff', 2));
    } else if (t === 'volcano') {
      if (R() < 0.35) glow.cyl(madd(p, up, -0.3), madd(p, up, 0.05), 6 + R() * 10, 6 + R() * 10, 10, hex('#ff4a10', 2.4), true);
      else { var hr = 2 + R() * 6; G.cyl(p, madd(p, up, hr), hr * 0.9, 0.4, 6, hex('#2a201d'), false); }
    } else if (t === 'toybox') {
      var cols = ['#ff3b30', '#2f8bff', '#ffd23f', '#30e3a0', '#b64dff', '#ff8a1f'], c = hex(cols[Math.floor(R() * cols.length)]);
      var k = R();
      if (k < 0.45) { var s = 2 + R() * 4; G.aabb(madd(p, up, s), s, s, s, c); }
      else if (k < 0.75) { var len = 14 + R() * 10, dir = norm([R() - 0.5, 0, R() - 0.5]); G.cyl(madd(p, up, 1.2), madd(madd(p, up, 1.2), dir, len), 1.2, 1.2, 6, c, true); G.cyl(madd(madd(p, up, 1.2), dir, len), madd(madd(p, up, 1.2), dir, len + 2.5), 1.2, 0.05, 6, c, false); }
      else { G.cyl(p, madd(p, up, 4), 2.2, 0.15, 10, hex('#ff8a1f'), false); G.cyl(p, madd(p, up, 0.3), 2.8, 2.8, 4, hex('#ffffff'), true); }
    } else {   // stadium: cones, tyre stacks, ad boards
      var k3 = R();
      if (k3 < 0.4) { G.cyl(p, madd(p, up, 3.5), 1.6, 0.1, 10, hex('#ff6a13'), false); G.cyl(madd(p, up, 1.4), madd(p, up, 1.9), 1.0, 0.9, 10, hex('#ffffff'), false); }
      else if (k3 < 0.7) { for (var j = 0; j < 4; j++) G.cyl(madd(p, up, j * 0.55), madd(p, up, j * 0.55 + 0.5), 0.9, 0.9, 8, hex(j % 2 ? '#ffffff' : '#222222'), true); }
      else { var dir2 = norm([R() - 0.5, 0, R() - 0.5]), side = [-dir2[2], 0, dir2[0]]; G.box(madd(p, up, 2), side, up, dir2, 6, 2, 0.15, hex(['#ffd23f', '#2f8bff', '#ff3b30'][Math.floor(R() * 3)])); }
    }
  }

  /* ---------------------------------------------------------------- public: pure geometry */
  function buildGeometry(track, opts) {
    opts = opts || {};
    var q = opts.quality || 'high', th = theme(track);
    var G = new Geo(), glow = new Geo(), support = new Geo(), ground = new Geo(), scen = new Geo(), sglow = new Geo(), deco = new Geo();
    var dyn = {};
    var rings = buildTrack(track, th, q, G, glow, deco);
    buildSupports(track, th, q, support, rings);
    buildDeco(track, th, q, deco, glow, dyn);
    featureAnchors(track, dyn);
    var pads = padGeo(track, th, glow, dyn);
    buildGround(track, th, q, ground);
    if (opts.scenery !== false) buildScenery(track, th, q, scen, sglow);
    var groups = { track: G.out(), glow: glow.out(), support: support.out(), ground: ground.out(), scenery: scen.out(), sceneryGlow: sglow.out(), deco: deco.out(), pads: pads.out() };
    var tris = 0, stats = {};
    Object.keys(groups).forEach(function (k) { stats[k] = groups[k].triangles; tris += groups[k].triangles; });
    stats.total = tris; stats.rings = rings.length;
    return { groups: groups, dynamic: dyn, stats: stats, theme: th };
  }

  /* ---------------------------------------------------------------- shared small meshes for dynamic features */
  function featureMeshGeos() {
    var box = new Geo(), cols = ['#ff3b30', '#ffd23f', '#2f8bff', '#30e3a0', '#b64dff', '#ff8a1f'];
    var axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    // item box: rainbow faces with a white "?" bar
    var h = 0.75;
    [[0, 1, 2], [1, 2, 0], [2, 0, 1]].forEach(function (o, k) {
      [-1, 1].forEach(function (sg, j) {
        var n = mul(axes[o[0]], sg), u = axes[o[1]], w = axes[o[2]], c = mul(n, h);
        var col = hex(cols[k * 2 + j], 1.4); col[3] = 0.82;
        box.quad(add(add(c, mul(u, -h)), mul(w, -h)), add(add(c, mul(u, h)), mul(w, -h)), add(add(c, mul(u, h)), mul(w, h)), add(add(c, mul(u, -h)), mul(w, h)), col, n);
        var q0 = mul(n, h + 0.01), wc = hex('#ffffff', 2);
        box.quad(add(add(q0, mul(u, -0.12)), mul(w, -0.1)), add(add(q0, mul(u, 0.12)), mul(w, -0.1)), add(add(q0, mul(u, 0.12)), mul(w, 0.45)), add(add(q0, mul(u, -0.12)), mul(w, 0.45)), wc, n);
        box.quad(add(add(q0, mul(u, -0.12)), mul(w, -0.45)), add(add(q0, mul(u, 0.12)), mul(w, -0.45)), add(add(q0, mul(u, 0.12)), mul(w, -0.25)), add(add(q0, mul(u, -0.12)), mul(w, -0.25)), wc, n);
      });
    });
    var can = new Geo();
    can.cyl([0, -0.55, 0], [0, 0.55, 0], 0.42, 0.42, 12, hex('#2f7bff', 1.3), true);
    can.cyl([0, 0.1, 0], [0, 0.3, 0], 0.44, 0.44, 12, hex('#ffffff', 1.8), false);
    can.cyl([0, 0.55, 0], [0, 0.8, 0], 0.16, 0.16, 8, hex('#c0c6d0'), true);
    var coin = new Geo();
    coin.cyl([0, 0, -0.08], [0, 0, 0.08], 0.55, 0.55, 14, hex('#ffcf2a', 1.8), true);
    var ring = new Geo();
    ring.torus([0, 0, 0], [0, 1, 0], [0, 0, 1], 1, 0.06, 32, 6, hex('#ffe14a', 2.6));
    var lamp = new Geo();
    lamp.cyl([0, 0, -0.15], [0, 0, 0.15], 0.38, 0.38, 10, hex('#ffffff'), true);
    var flame = new Geo();
    flame.cyl([0, 0, 0], [-1, 0, 0], 0.2, 0.02, 8, hex('#ffffff'), false);
    return { box: box.out(), can: can.out(), coin: coin.out(), ring: ring.out(), lamp: lamp.out(), flame: flame.out() };
  }

  /* ---------------------------------------------------------------- GL wrap */
  function build(ctx, track, opts) {
    opts = opts || {};
    var G = CB.gl, res = buildGeometry(track, opts), items = [], meshes = [];
    function mk(geo) { if (!geo.triangles) return null; var m = G.createMesh(ctx, geo); meshes.push(m); return m; }
    var neon = res.theme.neon;
    var MAT = {
      track: { name: 'stunt-plastic', color: [1, 1, 1, 1], roughness: 0.5, metallic: 0, clearcoat: 0.18, clearcoatRoughness: 0.2, envIntensity: 0.55 },
      glow: { name: 'stunt-glow', color: [1, 1, 1, 1], unlit: true, castShadow: false },
      support: { name: 'stunt-pylon', color: [1, 1, 1, 1], roughness: 0.45, metallic: 0.15 },
      ground: { name: 'stunt-ground', color: [1, 1, 1, 1], roughness: 0.9, castShadow: false },
      scenery: { name: 'stunt-scenery', color: [1, 1, 1, 1], roughness: 0.6, clearcoat: neon ? 0 : 0.2 },
      sceneryGlow: { name: 'stunt-glow', color: [1, 1, 1, 1], unlit: true, castShadow: false },
      deco: { name: 'stunt-deco', color: [1, 1, 1, 1], roughness: 0.4, clearcoat: 0.4 },
      pads: { name: 'stunt-pad', color: [1, 1, 1, 1], unlit: true, castShadow: false, polygonOffset: [-1, -2] }
    };
    Object.keys(res.groups).forEach(function (k) {
      var m = mk(res.groups[k]);
      if (!m) return;
      items.push({ mesh: m, material: MAT[k], kind: 'stunt-' + k, castShadow: k !== 'ground' && k !== 'glow' && k !== 'pads' && k !== 'sceneryGlow' });
    });
    var fg = featureMeshGeos(), fm = {};
    Object.keys(fg).forEach(function (k) { fm[k] = mk(fg[k]); });
    return {
      items: items, dyn: res.dynamic, stats: res.stats, meshes: fm, theme: res.theme, padMaterial: MAT.pads,
      destroy: function () { meshes.forEach(function (m) { try { m.destroy(); } catch (e) { /* ignore */ } }); meshes = []; }
    };
  }

  CB.gl.stunt = { buildGeometry: buildGeometry, build: build, featureMeshGeos: featureMeshGeos, THEMES: THEMES, hex: hex, _: { Geo: Geo, ringSamples: ringSamples } };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.gl.stunt;
})();

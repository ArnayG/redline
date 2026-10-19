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
    glacier: { track: '#30c8ff', rail: '#1ea8e0', under: '#2a3a4a', edge: '#ffffff', centre: '#ff3b8a', chevron: '#ffffff', pylon: '#dfe8f0', ground: ['#eef6ff', '#e2eefc'], glow: '#7ae0ff', sky: 'day', neon: false },
    lab: { track: '#22c8a8', rail: '#e8eef2', under: '#7a8a9a', edge: '#ffffff', centre: '#ffd23f', chevron: '#7ffcff', pylon: '#cfd8e0', ground: ['#b9c3cc', '#aeb8c2'], glow: '#38f2ff', sky: 'day', neon: false },
    pinball: { track: '#2c0f52', rail: '#4a1a80', under: '#16081f', edge: '#ffe14a', centre: '#30e3ff', chevron: '#ffe14a', pylon: '#2a1440', ground: ['#1d0b33', '#240e3e'], glow: '#ff2fd6', sky: 'night', neon: true },
    sky: { track: '#ff9a1f', rail: '#ffb84a', under: '#4a3a5a', edge: '#ffffff', centre: '#ffffff', chevron: '#ffe14a', pylon: '#8a6a4a', ground: ['#dfeaf8', '#d6e3f5'], glow: '#ffd23f', sky: 'day', neon: false, noPylons: true, groundDrop: 70 },
    bedroom: { track: '#ff6a0a', rail: '#ff8a2a', under: '#3a2a20', edge: '#ffe14a', centre: '#ffffff', chevron: '#ffe14a', pylon: '#2f8bff', ground: ['#a8743f', '#9c6a38'], glow: '#ffd23f', sky: 'dusk', neon: false },
    rooftops: { track: '#e8a800', rail: '#f2c640', under: '#22262e', edge: '#ffffff', centre: '#ff3b30', chevron: '#ffe14a', pylon: '#5a606c', ground: ['#3a3f4a', '#343944'], glow: '#ff7a1a', sky: 'dusk', neon: false }
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
  /** UV sphere (low poly), centre c, radius r (sy: vertical squash), seg around, rings */
  Geo.prototype.sphere = function (c, r, segs, rings, col, sy, jit) {
    var base = this.p.length / 3, R0 = jit ? rng(jit) : null;
    sy = sy || 1;
    for (var i = 0; i <= rings; i++) {
      var v = i / rings * PI, y = Math.cos(v), rr = Math.sin(v);
      for (var j = 0; j <= segs; j++) {
        var u = j / segs * TAU, n = [Math.cos(u) * rr, y, Math.sin(u) * rr];
        var k = R0 && i > 0 && i < rings && j < segs ? 0.82 + R0() * 0.3 : 1;
        this.v([c[0] + n[0] * r * k, c[1] + n[1] * r * sy * k, c[2] + n[2] * r * k], n, col);
      }
    }
    if (R0) {   // close the seam of the jittered rock
      for (var i2 = 1; i2 < rings; i2++) { var a = base + i2 * (segs + 1), b = a + segs; this.p[b * 3] = this.p[a * 3]; this.p[b * 3 + 1] = this.p[a * 3 + 1]; this.p[b * 3 + 2] = this.p[a * 3 + 2]; }
    }
    var row = segs + 1;
    for (i = 0; i < rings; i++) for (j = 0; j < segs; j++) { var q = base + i * row + j; this.i.push(q, q + row, q + row + 1, q, q + row + 1, q + 1); }
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
    var maxAng = (q === 'low' ? 5 : 3.0) * DEG, maxD = q === 'low' ? 6 : 4, minD = 0.75;
    var out = [], L = track.length, s = 0, last = null;
    var F = track.FLAGS;
    var prevS = null;
    for (s = 0; s < L; s += 0.5) {
      var sm = track.sample(s);
      var keep = !last;
      if (prevS && Math.abs(sm.pos[0] - prevS.pos[0]) + Math.abs(sm.pos[1] - prevS.pos[1]) + Math.abs(sm.pos[2] - prevS.pos[2]) > 4) {
        // warp seam between prevS and sm: close the strip at the entrance mouth, restart at the exit mouth
        if (last && last.s !== prevS.s) { last = { s: prevS.s, pos: prevS.pos.slice(), tangent: prevS.tangent.slice(), up: prevS.up.slice(), left: prevS.left.slice(), hw: prevS.halfWidth, flags: prevS.flags }; out.push(last); }
        keep = true;
      }
      prevS = { s: s, pos: sm.pos.slice(), tangent: sm.tangent, up: sm.up, left: sm.left, halfWidth: sm.halfWidth, flags: sm.flags };
      if (last && !keep) {
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
      if (Math.abs(A.pos[0] - B.pos[0]) + Math.abs(A.pos[1] - B.pos[1]) + Math.abs(A.pos[2] - B.pos[2]) > 12) continue;   // warp seam
      var ha = A.hw, hb = B.hw, ua = A.up, ub = B.up, la = A.left, lb = B.left;
      var dash = Math.floor(A.s / 4) % 2 === 0;
      var band = Math.floor(A.s / 12) % 2 === 0 ? cTrack : cTrackDark;
      // top surface strips (left edge stripe, lane, centre dash, lane, right edge stripe)
      var strips = [[ha, ha - 0.55, hb, hb - 0.55, th.neon ? null : cEdge, th.neon ? eGlow : null],
        [ha - 0.55, 0.18, hb - 0.55, 0.18, band], [0.18, -0.18, 0.18, -0.18, dash ? (th.neon ? null : cCentre) : band, dash && th.neon ? eCentre : null],
        [-0.18, -(ha - 0.55), -0.18, -(hb - 0.55), band], [-(ha - 0.55), -ha, -(hb - 0.55), -hb, th.neon ? null : cEdge, th.neon ? eGlow : null]];
      if (q === 'low') strips = [strips[0], [ha - 0.55, -(ha - 0.55), hb - 0.55, -(hb - 0.55), band], strips[4]];
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
    var seg = q === 'low' ? 4 : 6;
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      if (r.s - lastS < every) continue;
      if (r.flags & (F.gap | F.loop | F.cork | (F.warp || 0))) continue;
      if (th.noPylons) continue;
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
        G.cyl(bot, [bot[0], gy + 0.5, bot[2]], rad * 2.2, rad * 2.0, seg, cFoot, false);
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
    var b = track.bounds, pad = 420, gy = track.groundY - num(th.groundDrop, 0);   // sky: a cloud sea far below the fall plane
    var x0 = b.min[0] - pad, x1 = b.max[0] + pad, z0 = b.min[2] - pad, z1 = b.max[2] + pad, tile = q === 'low' ? 90 : 60;
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
    var gyS = gy - num(th.groundDrop, 0);
    themeExtras(track, t, q, G, glow, R, th, near, { cx: cx, cz: cz, rad: rad, gy: gy });
    for (var i = 0; i < ringN; i++) {
      var a = i / ringN * TAU + 0.2, px = cx + Math.cos(a) * rad, pz = cz + Math.sin(a) * rad;
      if (near(px, pz, 40)) continue;
      if (!landmark2(t, G, glow, [px, gyS, pz], a, R, th, q, { cx: cx, cz: cz, rad: rad, b: b })) landmark(t, G, glow, [px, gyS, pz], a, R, th);
    }
    while (placed < count && tries < count * 12) {
      tries++;
      var x = x0 + R() * (x1 - x0), z = z0 + R() * (z1 - z0);
      if (near(x, z, 30)) continue;
      if (!prop2(t, G, glow, [x, gyS, z], R, th, q)) prop(t, G, glow, [x, gyS, z], R, th);
      placed++;
    }
  }
  /* ---- new themes: lab, pinball, sky, bedroom, rooftops, glacier (+ volcano extras) */
  var UPV = [0, 1, 0];
  function landmark2(t, G, glow, p, a, R, th, q, W) {
    var face = [-Math.cos(a), 0, -Math.sin(a)], side = [-face[2], 0, face[0]], low = q === 'low', k, h;
    if (t === 'lab') {
      h = 40 + R() * 50; var r = 9 + R() * 6;
      G.cyl(p, madd(p, UPV, h), r, r, low ? 10 : 18, hex('#e8eef2'), false);
      G.sphere(madd(p, UPV, h), r, low ? 10 : 18, low ? 4 : 7, hex('#dfe6ec'), 0.6);
      for (k = 1; k < 4; k++) glow.cyl(madd(p, UPV, h * k / 4), madd(p, UPV, h * k / 4 + 1.2), r + 0.08, r + 0.08, low ? 10 : 18, hex('#38f2ff', 2.4), false);
      G.box(madd(madd(p, face, r + 4), UPV, 3), side, UPV, face, 6, 3, 4, hex('#9aa6b2'));
      return true;
    }
    if (t === 'pinball') {
      if (R() < 0.5) {   // giant bumper
        var br = 10 + R() * 8;
        G.cyl(p, madd(p, UPV, br * 1.2), br, br * 0.9, low ? 12 : 22, hex('#ffffff'), false);
        G.cyl(madd(p, UPV, br * 0.4), madd(p, UPV, br * 0.75), br + 0.6, br + 0.6, low ? 12 : 22, hex(['#ff2f6d', '#2f8bff', '#ffd23f'][Math.floor(R() * 3)]), false);
        glow.cyl(madd(p, UPV, br * 1.2), madd(p, UPV, br * 1.45), br * 0.9, br * 0.55, low ? 12 : 22, hex('#ff2fd6', 2.8), true);
      } else {   // slingshot triangle with a glowing rubber band + score lights
        var L1 = 30 + R() * 20;
        G.box(madd(p, UPV, 6), side, UPV, face, L1 / 2, 6, 3, hex('#2a1440'));
        glow.box(madd(madd(p, UPV, 12.4), face, 0), side, UPV, face, L1 / 2, 0.4, 3.2, hex('#30e3ff', 2.8));
        for (k = 0; k < 5; k++) glow.cyl(madd(madd(p, side, (k - 2) * L1 / 6), face, -3.4), madd(madd(madd(p, side, (k - 2) * L1 / 6), face, -3.4), UPV, 0.4), 1.6, 1.6, 10, hex(k % 2 ? '#ffe14a' : '#ff2fd6', 2.6), true);
      }
      return true;
    }
    if (t === 'sky') {   // floating islands around the course, at track height-ish
      var ir = 30 + R() * 30, iy = W.b.min[1] + R() * Math.max(10, W.b.max[1] - W.b.min[1]) - 10;
      island(G, glow, [p[0], iy, p[2]], ir, R, low);
      return true;
    }
    if (t === 'bedroom') return true;   // the room furniture is placed by themeExtras
    if (t === 'rooftops') {
      h = 70 + R() * 140; var w = 22 + R() * 18;
      G.box(madd(p, UPV, h / 2), side, UPV, face, w, h / 2, w, hex(['#2e3440', '#3b4252', '#262b35'][Math.floor(R() * 3)]));
      for (var y = 6; y < h - 4; y += low ? 14 : 7) glow.box(madd(madd(p, UPV, y), face, w + 0.05), side, UPV, face, w * 0.85, 0.5, 0.05, hex(R() < 0.6 ? '#ffd88a' : '#7fd4ff', 1.6));
      glow.box(madd(p, UPV, h + 2), side, UPV, face, 0.3, 2, 0.3, hex('#ff3b30', 3));
      if (R() < 0.5) {   // billboard on the roof
        G.box(madd(madd(p, UPV, h + 6), face, w * 0.4), side, UPV, face, w * 0.7, 4, 0.3, hex('#111111'));
        glow.box(madd(madd(madd(p, UPV, h + 6), face, w * 0.4), face, 0.32), side, UPV, face, w * 0.65, 3.6, 0.02, hex(['#ff2fd6', '#30e3ff', '#ffd23f'][Math.floor(R() * 3)], 1.8));
      }
      return true;
    }
    if (t === 'glacier') {
      if (R() < 0.6) {   // snowy peak
        h = 80 + R() * 120; var r2 = 70 + R() * 60;
        G.cyl(p, madd(p, UPV, h * 0.62), r2, r2 * 0.38, low ? 7 : 11, hex('#7f93a8'), false);
        G.cyl(madd(p, UPV, h * 0.62), madd(p, UPV, h), r2 * 0.38, 0.5, low ? 7 : 11, hex('#ffffff'), false);
      } else {   // iceberg
        var ib = 20 + R() * 20;
        G.box(madd(p, UPV, ib * 0.5), side, norm([0.12, 1, 0.08]), face, ib, ib * 0.8, ib * 0.7, hex('#bfe8ff'));
        G.box(madd(p, UPV, ib * 1.3), norm([1, 0.25, 0]), UPV, face, ib * 0.5, ib * 0.5, ib * 0.45, hex('#d8f3ff'));
      }
      return true;
    }
    if (t === 'volcano') {
      var h3 = 70 + R() * 100, r3 = 55 + R() * 45;
      G.cyl(p, madd(p, UPV, h3), r3, r3 * 0.22, low ? 8 : 12, hex('#3a2a26'), false);
      glow.cyl(madd(p, UPV, h3 - 0.5), madd(p, UPV, h3 + 0.4), r3 * 0.2, r3 * 0.12, low ? 8 : 12, hex('#ff5a1a', 3.4), true);
      // lava runs down the flank
      for (k = 0; k < (low ? 1 : 3); k++) {
        var ang = R() * TAU, dv = [Math.cos(ang), 0, Math.sin(ang)], tp = madd(madd(p, UPV, h3 - 1), dv, r3 * 0.2), bt = madd(madd(p, UPV, 1), dv, r3 * 0.95);
        glow.cyl(tp, bt, 1.6, 3.2, 4, hex('#ff4a10', 3), false);
      }
      return true;
    }
    return false;
  }
  function island(G, glow, c, r, R, low) {
    G.cyl(madd(c, UPV, -r * 1.1), c, 1.5, r, low ? 7 : 11, hex('#7a5a40'), false);                      // rock underside (cone)
    G.cyl(c, madd(c, UPV, 2.2), r, r * 0.97, low ? 7 : 11, hex('#4caf50'), true);                         // grass top
    for (var k = 0; k < (low ? 2 : 5); k++) {   // trees
      var a = R() * TAU, d = R() * r * 0.7, tp = [c[0] + Math.cos(a) * d, c[1] + 2.2, c[2] + Math.sin(a) * d];
      G.cyl(tp, madd(tp, UPV, 3), 0.5, 0.4, 5, hex('#6b4a2a'), false);
      G.cyl(madd(tp, UPV, 2.5), madd(tp, UPV, 9 + R() * 4), 3 + R() * 1.5, 0.2, 6, hex('#2e8b3e'), false);
    }
    void glow;
  }
  function prop2(t, G, glow, p, R, th, q) {
    var k = R(), c;
    if (t === 'lab') {
      if (k < 0.4) { var s = 2 + R() * 3; G.aabb(madd(p, UPV, s), s, s, s, hex('#f2f5f7')); glow.aabb(madd(p, UPV, s), s * 1.01, 0.2, s * 1.01, hex('#38f2ff', 2)); }
      else if (k < 0.7) { G.cyl(p, madd(p, UPV, 8), 0.8, 0.6, 6, hex('#9aa6b2'), false); glow.sphere(madd(p, UPV, 9), 1.6, 8, 5, hex('#7ffcff', 2.6)); }
      else { var d = norm([R() - 0.5, 0, R() - 0.5]); G.cyl(madd(p, UPV, 1.5), madd(madd(p, UPV, 1.5), d, 20 + R() * 20), 1.4, 1.4, 8, hex('#cfd8e0'), true); }
      return true;
    }
    if (t === 'pinball') {
      if (k < 0.55) glow.cyl(madd(p, UPV, 0.02), madd(p, UPV, 0.12), 2 + R() * 3, 2 + R() * 3, 12, hex(['#ff2fd6', '#30e3ff', '#ffe14a', '#62f0b5'][Math.floor(R() * 4)], 1.8), true);   // lane lights
      else if (k < 0.8) { G.cyl(p, madd(p, UPV, 3.5), 1.2, 1.2, 8, hex('#e6e6e6'), false); glow.cyl(madd(p, UPV, 3.5), madd(p, UPV, 3.9), 1.1, 0.6, 8, hex('#ff2f6d', 2.6), true); }
      else { G.sphere(madd(p, UPV, 3), 3, 12, 8, hex('#d8dde4')); }   // a giant steel ball
      return true;
    }
    if (t === 'sky') {   // cloud puffs on the cloud sea
      c = madd(p, UPV, 2 + R() * 6);
      for (var j = 0; j < 2; j++) glow.sphere(madd(c, [R() - 0.5, 0, R() - 0.5], 8), 6 + R() * 6, q === 'low' ? 5 : 7, 4, hex('#f6f9ff', 0.95), 0.55);
      return true;
    }
    if (t === 'bedroom') {
      var cols = ['#ff3b30', '#2f8bff', '#ffd23f', '#30e3a0', '#b64dff', '#ff8a1f'];
      c = hex(cols[Math.floor(R() * cols.length)]);
      if (k < 0.3) { var bs = 2.5 + R() * 3; G.aabb(madd(p, UPV, bs), bs, bs, bs, c); }                                         // toy block
      else if (k < 0.5) { G.sphere(madd(p, UPV, 3.2), 3.2, 12, 8, c); }                                                         // ball
      else if (k < 0.75) { for (var b2 = 0; b2 < 4; b2++) G.aabb(madd(p, UPV, 0.5 + b2 * 1.05), 5 - b2 * 0.4, 0.5, 3.6, hex(cols[(b2 + 1) % cols.length])); }   // book stack
      else { var dd = norm([R() - 0.5, 0, R() - 0.5]); G.cyl(madd(p, UPV, 0.8), madd(madd(p, UPV, 0.8), dd, 18), 0.8, 0.8, 6, c, true); G.cyl(madd(madd(p, UPV, 0.8), dd, 18), madd(madd(p, UPV, 0.8), dd, 20.5), 0.8, 0.05, 6, hex('#f2d9a0'), false); }   // crayon / pencil
      return true;
    }
    if (t === 'rooftops') {
      if (k < 0.4) { G.aabb(madd(p, UPV, 1.4), 2.4, 1.4, 1.8, hex('#9aa0a8')); G.cyl(madd(p, UPV, 2.8), madd(p, UPV, 3.0), 1.2, 1.2, 8, hex('#3a3f48'), true); }   // AC unit
      else if (k < 0.65) {   // water tower
        for (var l = 0; l < 4; l++) G.cyl(madd(p, [Math.cos(l * PI / 2), 0, Math.sin(l * PI / 2)], 2), madd(madd(p, [Math.cos(l * PI / 2), 0, Math.sin(l * PI / 2)], 1.6), UPV, 6), 0.2, 0.2, 4, hex('#5a4030'), false);
        G.cyl(madd(p, UPV, 6), madd(p, UPV, 11), 2.6, 2.6, 10, hex('#8a5a3a'), false); G.cyl(madd(p, UPV, 11), madd(p, UPV, 12.5), 2.8, 0.2, 10, hex('#5a3a2a'), false);
      } else if (k < 0.85) { G.cyl(p, madd(p, UPV, 14), 0.15, 0.1, 4, hex('#aaaaaa'), false); glow.aabb(madd(p, UPV, 14.2), 0.3, 0.3, 0.3, hex('#ff3b30', 3)); }   // antenna
      else { G.aabb(madd(p, UPV, 0.4), 6, 0.4, 6, hex('#2a2e36')); glow.aabb(madd(p, UPV, 0.82), 3.5, 0.02, 0.4, hex('#ffd23f', 1.6)); }   // helipad-ish
      return true;
    }
    if (t === 'glacier') {
      if (k < 0.4) G.cyl(p, madd(p, UPV, 4 + R() * 8), 1 + R() * 1.5, 0.1, 5, hex('#cfefff'), false);                              // ice spike
      else if (k < 0.75) { G.cyl(p, madd(p, UPV, 1.5), 0.4, 0.4, 5, hex('#5a4030'), false); G.cyl(madd(p, UPV, 1.2), madd(p, UPV, 9), 2.6, 0.2, 7, hex('#2d5a3a'), false); G.cyl(madd(p, UPV, 6.5), madd(p, UPV, 9.2), 1.0, 0.1, 7, hex('#ffffff'), false); }   // snowy pine
      else G.sphere(madd(p, UPV, 0.2), 3 + R() * 3, 8, 4, hex('#ffffff'), 0.35);                                                       // snow mound
      return true;
    }
    return false;
  }
  /** big theme set pieces: the bedroom's furniture + walls, sky islands under the track, volcano lava rivers */
  function themeExtras(track, t, q, G, glow, R, th, near, W) {
    var low = q === 'low', b = track.bounds, gy = track.groundY;
    if (t === 'bedroom') {
      var cx = W.cx, cz = W.cz, ex = (b.max[0] - b.min[0]) / 2 + 230, ez = (b.max[2] - b.min[2]) / 2 + 230, H = 380;
      // walls with wallpaper stripes, a window, skirting
      [[0, -1], [0, 1], [1, 0], [-1, 0]].forEach(function (d, wi) {
        var nrm = [-d[0], 0, -d[1]], c = [cx + d[0] * ex, gy + H / 2, cz + d[1] * ez], half = d[0] ? ez : ex, along = d[0] ? [0, 0, 1] : [1, 0, 0];
        var nS = low ? 6 : 14;
        for (var k = 0; k < nS; k++) {
          var a0 = -half + 2 * half * k / nS, a1 = a0 + 2 * half / nS;
          G.quad(add(madd(c, along, a0), [0, -H / 2, 0]), add(madd(c, along, a1), [0, -H / 2, 0]), add(madd(c, along, a1), [0, H / 2, 0]), add(madd(c, along, a0), [0, H / 2, 0]), hex(k % 2 ? '#8fb6d8' : '#a9c8e4'), nrm);
        }
        G.box(add(c, [0, -H / 2 + 4, 0]), along, UPV, nrm, half, 4, 1.5, hex('#ffffff'));
        if (wi === 0) {   // window with daylight
          glow.box(add(madd(c, nrm, 0.6), [0, 40, 0]), along, UPV, nrm, 110, 70, 0.1, hex('#fff2c8', 2.2));
          G.box(add(madd(c, nrm, 1.0), [0, 40, 0]), along, UPV, nrm, 4, 72, 0.6, hex('#ffffff'));
          G.box(add(madd(c, nrm, 1.0), [0, 40, 0]), along, UPV, nrm, 112, 4, 0.6, hex('#ffffff'));
        }
      });
      // rug under the course
      G.quad([b.min[0] - 60, gy + 0.05, b.max[2] + 60], [b.max[0] + 60, gy + 0.05, b.max[2] + 60], [b.max[0] + 60, gy + 0.05, b.min[2] - 60], [b.min[0] - 60, gy + 0.05, b.min[2] - 60], hex('#c43a3a'), UPV);
      G.quad([b.min[0] - 40, gy + 0.08, b.max[2] + 40], [b.max[0] + 40, gy + 0.08, b.max[2] + 40], [b.max[0] + 40, gy + 0.08, b.min[2] - 40], [b.min[0] - 40, gy + 0.08, b.min[2] - 40], hex('#2f4f8b'), UPV);
      // giant bed (corner), desk + lamp, wardrobe
      var bed = [cx - ex + 90, gy, cz - ez + 120];
      G.aabb(add(bed, [0, 14, 0]), 70, 14, 110, hex('#6b4a2a'));
      G.aabb(add(bed, [0, 34, 0]), 66, 6, 106, hex('#f4f4f4'));
      G.aabb(add(bed, [0, 41, 20]), 67, 3, 80, hex('#3a7bd5'));
      G.aabb(add(bed, [0, 44, -84]), 40, 6, 16, hex('#ffffff'));
      G.aabb(add(bed, [0, 50, -112]), 70, 50, 4, hex('#6b4a2a'));
      var desk = [cx + ex - 70, gy, cz + ez - 140];
      G.aabb(add(desk, [0, 60, 0]), 60, 3, 110, hex('#c8955a'));
      [[-55, -100], [55, -100], [-55, 100], [55, 100]].forEach(function (o) { G.aabb(add(desk, [o[0], 30, o[1]]), 3, 30, 3, hex('#8a5a30')); });
      G.cyl(add(desk, [0, 63, 40]), add(desk, [0, 110, 40]), 2, 2, 8, hex('#222222'), false);
      G.cyl(add(desk, [0, 105, 40]), add(desk, [0, 125, 52]), 18, 6, 12, hex('#ffd23f'), false);
      glow.cyl(add(desk, [0, 104.5, 39]), add(desk, [0, 105.5, 39]), 17, 17, 12, hex('#fff2c8', 2.6), true);
      var ward = [cx + ex - 60, gy, cz - ez + 70];
      G.aabb(add(ward, [0, 120, 0]), 50, 120, 40, hex('#d8b78a'));
      return;
    }
    if (t === 'sky') {   // islands right under some track sections (no pylons in the sky)
      var every = low ? 420 : 260;
      for (var s = 60; s < track.length; s += every) {
        var sm = track.sample(s);
        if (sm.up[1] < 0.9 || (sm.flags & track.FLAGS.gap)) continue;
        var c = [sm.pos[0], sm.pos[1] - 4.5, sm.pos[2]];
        var pr = track.project([c[0], c[1] - 12, c[2]], { maxDist: 14, surfaceOnly: true, lateralMargin: 4 });
        if (pr && Math.abs(CB.arcade.stunt._vec.wrapD(pr.s - s, track.length)) > 30) continue;
        island(G, glow, c, sm.halfWidth + 9 + R() * 8, R, low);
      }
      return;
    }
    if (t === 'volcano') {   // glowing lava rivers across the plain
      var nR = low ? 2 : 4;
      for (var r = 0; r < nR; r++) {
        var x = b.min[0] - 200 + R() * (b.max[0] - b.min[0] + 400), z = b.min[2] - 200, dirz = 1;
        var px = x, pz = z;
        for (var k2 = 0; k2 < (low ? 10 : 22); k2++) {
          var nx = px + (R() - 0.5) * 70, nz = pz + dirz * 50;
          if (!near((px + nx) / 2, (pz + nz) / 2, 18)) {
            var d2 = norm([nx - px, 0, nz - pz]), sd = [-d2[2], 0, d2[0]], w = 4 + R() * 3;
            glow.quad(madd([px, gy + 0.06, pz], sd, -w), madd([px, gy + 0.06, pz], sd, w), madd([nx, gy + 0.06, nz], sd, w), madd([nx, gy + 0.06, nz], sd, -w), hex('#ff4a10', 2.6), UPV);
          }
          px = nx; pz = nz;
        }
      }
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

  /* ================================================================ SPECIAL FEATURES (stunt-features.js pieces)
     Static geometry for tubes, zero-g runs, half-pipes, cannons, warp portals, split dividers, booster tunnels, hazards'
     gantries + telegraph stripes, bumpers, springs, belts, drift zones; anchors for the animated parts (dyn.*). */
  var FONT = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'], D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'], H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'], K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'], M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'], O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'], R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'], T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'], W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
    Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'], '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'], ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
  };
  /** Pixel text: origin = bottom-left corner, right / up unit vectors, px = pixel size (m). Runs are merged per row. */
  function pixText(G, origin, right, up, text, px, col) {
    var nrm = norm(cross(right, up)), x0 = 0;
    for (var ci = 0; ci < text.length; ci++) {
      var g = FONT[text.charAt(ci)] || FONT[' '];
      for (var r = 0; r < 7; r++) {
        var row = g[r], c = 0;
        while (c < 5) {
          if (row.charAt(c) !== '1') { c++; continue; }
          var c1 = c; while (c1 < 5 && row.charAt(c1) === '1') c1++;
          var y = (6 - r) * px, xa = (x0 + c) * px, xb = (x0 + c1) * px;
          var a = madd(madd(origin, right, xa), up, y), b = madd(madd(origin, right, xb), up, y);
          G.quad(a, b, madd(b, up, px), madd(a, up, px), col, nrm);
          c = c1;
        }
      }
      x0 += 6;
    }
    return x0 * px;
  }
  function textWidth(text, px) { return text.length * 6 * px - px; }
  /** Sign board facing `face` (toward the approaching driver): board + border + centred pixel text. */
  function signBoard(deco, glow, centre, face, up, text, px, bg, fg) {
    var right = norm(cross(up, face)), w = textWidth(text, px) + 2 * px * 2, h = 7 * px + 4 * px;
    deco.box(madd(centre, face, -0.12), right, up, face, w / 2, h / 2, 0.1, hex(bg || '#111111'));
    var org = madd(madd(madd(centre, right, -textWidth(text, px) / 2), up, -3.5 * px), face, 0.02);
    pixText(glow, org, right, up, text, px, fg);
  }
  function sampleR(track, s) { var sm = track.sample(s); return { s: s, pos: sm.pos, left: sm.left, up: sm.up, tangent: sm.tangent, hw: sm.halfWidth, flags: sm.flags }; }
  /** a strip of road-plane quads between lateral a..b over [s0, s1] (lifted by h; decal group) */
  function roadBand(G, track, s0, s1, la, lb, h, col, step) {
    step = step || 2;
    for (var s = s0; s < s1 - 1e-6; s += step) {
      var A = sampleR(track, s), B = sampleR(track, Math.min(s1, s + step));
      if (Math.abs(A.pos[0] - B.pos[0]) + Math.abs(A.pos[2] - B.pos[2]) > step * 3) continue;
      G.quadN(P(A, la, h), P(A, lb, h), P(B, lb, h), P(B, la, h), A.up, B.up, typeof col === 'function' ? col(s) : col);
    }
  }
  function arcPoints(cx, ax, ay, rx, ry, a0, a1, n) {   // ellipse arc in the plane (ax, ay) around cx
    var out = [];
    for (var i = 0; i <= n; i++) { var a = a0 + (a1 - a0) * i / n; out.push(add(add(cx, mul(ax, Math.cos(a) * rx)), mul(ay, Math.sin(a) * ry))); }
    return out;
  }
  function polyTube(G, pts, r, seg, col) { for (var i = 0; i < pts.length - 1; i++) G.cyl(pts[i], pts[i + 1], r, r, seg, col, false); }

  /** piece record + its builder info (axis / ceiling ends …); derived from the solved piece when the track omits it */
  function pieceInfo(track, pc) {
    var o = {}, k;
    for (k in pc) o[k] = pc[k];
    var def = track.solvedPieces && pc.index >= 0 ? track.solvedPieces[pc.index] : null;
    if (!def) return o;
    var sm = track.sample(pc.s0);
    if (pc.type === 'tube' && !o.axisStart) {
      o.radius = num(def.radius, 7); o.turns = num(def.turns, 1); o.axisLen = num(def.len, 80);
      o.axisStart = madd(sm.pos, sm.up, o.radius); o.axisDir = sm.tangent.slice();
    } else if (pc.type === 'zerog' && !o.ceilStart) {
      o.radius = Math.max(8, num(def.radius, 14)); o.ceilLen = Math.max(0, num(def.len, 60));
      o.ceilStart = track.sample(pc.s0 + Math.PI * o.radius).pos; o.ceilEnd = track.sample(pc.s0 + Math.PI * o.radius + o.ceilLen).pos;
    } else if (pc.type === 'cannon' && o.rampLen == null) { o.rampLen = num(def.ramp, 26); o.angle = num(def.angle, 30); }
    else if (pc.type === 'loop' && o.radius == null) o.radius = num(def.radius, 13);
    else if (pc.type === 'halfpipe' && o.bank == null) { o.bank = num(def.bank, 55); o.waves = num(def.waves, 1.5); }
    return o;
  }
  function buildSpecial(track, th, q, grp, dyn) {
    var F = track.FLAGS, low = q === 'low', seg = low ? 4 : 6, L = track.length, gy = track.groundY;
    var G = grp.track, glow = grp.glow, sup = grp.support, deco = grp.deco, decal = grp.decal, glass = grp.glass;
    var cGlow = hex(th.glow, 2.4), cCentre = hex(th.centre, 2.2), cMetal = hex('#3a3f4a'), cGold = hex('#ffcf3a', 1.2), cP = hex(th.pylon);
    dyn.portals = []; dyn.hazards = []; dyn.bumpers = []; dyn.flippers = []; dyn.stars = []; dyn.belts = []; dyn.fire = {}; dyn.springs = []; dyn.tubes = [];
    var FT = (CB.arcade && CB.arcade.stunt && CB.arcade.stunt.features) || null;

    track.pieces.forEach(function (pc0) {
      var pc = pieceInfo(track, pc0);
      /* ---- barrel-roll tube: see-through cage (rings + ribs) around the helix axis, faint glass shell, neon mouths */
      if (pc.type === 'tube' && pc.axisStart && pc.axisDir) {
        var A0 = pc.axisStart, AD = norm(pc.axisDir), R = num(pc.radius, 7) + 0.9, LA = num(pc.axisLen, 80);
        var u = norm(cross(AD, Math.abs(AD[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), w = cross(AD, u);
        var nR = Math.max(3, Math.round(LA / (low ? 14 : 8)));
        for (var k = 0; k <= nR; k++) {
          var c0 = madd(A0, AD, LA * k / nR), endRing = k === 0 || k === nR;
          (endRing ? glow : sup).torus(c0, u, w, R, endRing ? 0.32 : 0.2, low ? 14 : 26, low ? 3 : 4, endRing ? cGlow : cP);
        }
        var nRib = low ? 4 : 8;
        for (var rb = 0; rb < nRib; rb++) {
          var ang = rb / nRib * TAU, d = add(mul(u, Math.cos(ang) * R), mul(w, Math.sin(ang) * R));
          sup.cyl(add(A0, d), add(madd(A0, AD, LA), d), 0.12, 0.12, low ? 3 : 4, rb % 2 ? cP : hex(th.glow, 1.4), false);
        }
        if (!low) {   // faint glass shell (transparent, never occludes: the camera inside / outside sees through it)
          var nA = 16, nL = Math.max(4, Math.round(LA / 5)), cg = hex(th.glow, 0.9); cg[3] = 0.1;
          for (var i = 0; i < nL; i++) for (var j = 0; j < nA; j++) {
            var a0 = j / nA * TAU, a1 = (j + 1) / nA * TAU, z0 = LA * i / nL, z1 = LA * (i + 1) / nL;
            var d0 = add(mul(u, Math.cos(a0)), mul(w, Math.sin(a0))), d1 = add(mul(u, Math.cos(a1)), mul(w, Math.sin(a1)));
            glass.quadN(madd(madd(A0, AD, z0), d0, R + 0.3), madd(madd(A0, AD, z0), d1, R + 0.3), madd(madd(A0, AD, z1), d1, R + 0.3), madd(madd(A0, AD, z1), d0, R + 0.3), mul(d0, -1), mul(d1, -1), cg);
          }
        }
        // two support frames to the ground
        [0.2, 0.8].forEach(function (fr) {
          var c1 = madd(A0, AD, LA * fr), side = norm(cross(AD, [0, 1, 0]));
          if (th.noPylons) return;
          [-1, 1].forEach(function (sg) { var top = madd(c1, side, sg * (R + 0.4)); sup.cyl([top[0], gy, top[2]], top, 0.5, 0.4, seg, cP, false); });
          sup.cyl(madd(c1, side, -(R + 0.4)), madd(c1, side, R + 0.4), 0.3, 0.3, seg, cP, false);
        });
        dyn.tubes.push({ s0: pc.s0, s1: pc.s1, axisStart: A0, axisDir: AD, radius: R });
      }
      /* ---- zero-g stretch loop: gantries over the inverted ceiling run */
      if (pc.type === 'zerog' && pc.ceilStart && pc.ceilEnd) {
        var cs = pc.ceilStart, ce = pc.ceilEnd, dir = sub(ce, cs), Lc = Math.sqrt(dot(dir, dir)) || 1; dir = mul(dir, 1 / Lc);
        var side2 = norm(cross(dir, [0, 1, 0])), hwz = track.sample(pc.s0 + Math.PI * num(pc.radius, 14)).halfWidth + 1.4;
        var nG = Math.max(2, Math.round(Lc / (low ? 30 : 16)));
        for (var g2 = 0; g2 <= nG; g2++) {
          var cc = madd(cs, dir, Lc * g2 / nG), topY = cc[1] + 3.2;
          [-1, 1].forEach(function (sg) {
            var base = madd(cc, side2, sg * hwz);
            if (!th.noPylons) sup.cyl([base[0], gy, base[2]], [base[0], topY, base[2]], 0.55, 0.45, seg, cP, false);
            else sup.cyl([base[0], cc[1] - 1.5, base[2]], [base[0], topY, base[2]], 0.4, 0.4, seg, cP, false);
          });
          var bA = madd(cc, side2, -hwz), bB = madd(cc, side2, hwz);
          sup.box([cc[0], topY, cc[2]], side2, [0, 1, 0], dir, hwz, 0.35, 0.45, cP);
          glow.box([cc[0], topY - 0.4, cc[2]], side2, [0, 1, 0], dir, hwz * 0.92, 0.06, 0.12, cCentre);
          void bA; void bB;
        }
        // "ZERO-G" board on the far gantry, facing the approaching (inverted) driver
        if (!low) signBoard(deco, glow, madd(madd(ce, dir, 2), [0, 1, 0], 4.6), mul(dir, -1), [0, 1, 0], 'ZERO-G', 0.42, '#111111', hex('#b9a8ff', 2.4));
      }
      /* ---- half-pipe: flared lips continuing the cross-section upward beyond the rails */
      if (pc.type === 'halfpipe') {
        var stp = low ? 4 : 2, flare = low ? 2 : 4, cT = hex(th.track, 0.9), cE = hex(th.edge);
        for (var s = pc.s0; s < pc.s0 + pc.length - 1e-6; s += stp) {
          var Ra = sampleR(track, s), Rb = sampleR(track, s + stp);
          for (var sd = -1; sd <= 1; sd += 2) {
            for (var f2 = 0; f2 < flare; f2++) {
              var d0f = f2 / flare * 4, d1f = (f2 + 1) / flare * 4;
              var la0 = sd * (Ra.hw + RAIL_W + d0f), la1 = sd * (Ra.hw + RAIL_W + d1f), lb0 = sd * (Rb.hw + RAIL_W + d0f), lb1 = sd * (Rb.hw + RAIL_W + d1f);
              var h0 = RAIL_H + d0f * d0f / 2.4, h1 = RAIL_H + d1f * d1f / 2.4, colf = f2 === flare - 1 ? cE : cT;
              G.quad(P(Ra, la0, h0), P(Ra, la1, h1), P(Rb, lb1, h1), P(Rb, lb0, h0), colf);
            }
            if (!low) glow.quadN(P(Ra, sd * (Ra.hw + RAIL_W + 4), RAIL_H + 6.7), P(Ra, sd * (Ra.hw + RAIL_W + 4), RAIL_H + 6.95), P(Rb, sd * (Rb.hw + RAIL_W + 4), RAIL_H + 6.95), P(Rb, sd * (Rb.hw + RAIL_W + 4), RAIL_H + 6.7), Ra.up, Rb.up, cGlow);
          }
        }
      }
      /* ---- cannon: half barrel around the ramp, muzzle ring at the lip, carriage wheels; landing bullseye */
      if (pc.type === 'cannon') {
        var gp = null;
        for (var gi = 0; gi < track.gaps.length; gi++) if (track.gaps[gi].cannon && Math.abs(CB.arcade.stunt._vec.wrapD(track.gaps[gi].takeoffS - (pc.s0 + num(pc.rampLen, 26)), L)) < 6) gp = track.gaps[gi];
        var lipS = gp ? gp.takeoffS : pc.s0 + num(pc.rampLen, 26), rl = Math.min(18, num(pc.rampLen, 26) - 2);
        var cBar = hex('#2b2f36'), cBand = hex('#c8962a', 1.2), nB = low ? 8 : 16;
        for (var bs = lipS - rl; bs < lipS - 0.5; bs += 2) {
          var A1 = sampleR(track, bs), B1 = sampleR(track, Math.min(lipS, bs + 2)), Rr = A1.hw + 1.4;
          for (var bj = 0; bj < nB; bj++) {   // lower half barrel (open on top: the camera never looks through a wall)
            var t0 = Math.PI + bj / nB * Math.PI, t1 = Math.PI + (bj + 1) / nB * Math.PI;
            var pa0 = P(A1, Math.cos(t0) * Rr, Math.sin(t0) * Rr * 0.75 + 0.2), pa1 = P(A1, Math.cos(t1) * Rr, Math.sin(t1) * Rr * 0.75 + 0.2);
            var pb0 = P(B1, Math.cos(t0) * Rr, Math.sin(t0) * Rr * 0.75 + 0.2), pb1 = P(B1, Math.cos(t1) * Rr, Math.sin(t1) * Rr * 0.75 + 0.2);
            sup.quad(pa0, pb0, pb1, pa1, Math.floor(bs / 4) % 3 === 0 ? cBand : cBar);
          }
          [-1, 1].forEach(function (sd2) {   // barrel side walls up to rail height + 1
            sup.quad(P(A1, sd2 * Rr, 0.2), P(B1, sd2 * Rr, 0.2), P(B1, sd2 * Rr, RAIL_H + 1.4), P(A1, sd2 * Rr, RAIL_H + 1.4), cBar);
          });
        }
        var Lp = sampleR(track, lipS - 0.5), Rm = Lp.hw + 2.2, cm = P(Lp, 0, Rm * 0.5);
        deco.torus(cm, Lp.left, Lp.up, Rm, low ? 0.5 : 0.7, low ? 16 : 32, low ? 4 : 8, cBand);
        glow.torus(madd(cm, Lp.tangent, 0.4), Lp.left, Lp.up, Rm - 0.6, 0.12, low ? 16 : 32, 3, hex('#ff7a1a', 3));
        var Wc = sampleR(track, lipS - rl * 0.55);
        [-1, 1].forEach(function (sd3) {
          var wc = P(Wc, sd3 * (Wc.hw + 2.6), -0.6);
          deco.cyl(madd(wc, Wc.left, -sd3 * 0.6), madd(wc, Wc.left, sd3 * 0.6), 3.4, 3.4, low ? 8 : 14, hex('#6a3a1a'), true);
          deco.cyl(madd(wc, Wc.left, -sd3 * 0.7), madd(wc, Wc.left, sd3 * 0.7), 0.8, 0.8, 8, cBand, true);
        });
        if (!low) signBoard(deco, glow, P(sampleR(track, lipS - rl - 14), 0, 8.5), mul(sampleR(track, lipS - rl - 14).tangent, -1), [0, 1, 0], 'CANNON', 0.5, '#2b0a00', hex('#ff8a1f', 2.6));
        if (gp) {   // bullseye on the landing deck (annuli, one layer: no z-fighting)
          var bc = gp.landS + 14, radii = [5.2, 4.0, 2.8, 1.6, 0], cols = ['#ffffff', '#ff3b30', '#ffffff', '#ff3b30'], nn = low ? 14 : 28, Rc = sampleR(track, bc);
          for (var ri = 0; ri < 4; ri++) for (var k2 = 0; k2 < nn; k2++) {
            var a0b = k2 / nn * TAU, a1b = (k2 + 1) / nn * TAU, ro = radii[ri], rin = radii[ri + 1];
            var q00 = P(Rc, Math.sin(a0b) * ro, 0.03), q01 = P(Rc, Math.sin(a1b) * ro, 0.03);
            q00 = madd(q00, Rc.tangent, Math.cos(a0b) * ro); q01 = madd(q01, Rc.tangent, Math.cos(a1b) * ro);
            var q10 = madd(P(Rc, Math.sin(a0b) * rin, 0.03), Rc.tangent, Math.cos(a0b) * rin), q11 = madd(P(Rc, Math.sin(a1b) * rin, 0.03), Rc.tangent, Math.cos(a1b) * rin);
            decal.quadN(q10, q00, q01, q11, Rc.up, Rc.up, hex(cols[ri]));
          }
        }
      }
    });
    /* ---- warp portals: a glowing frame at both mouths (the swirl disc is a dynamic item) */
    (track.warps || []).forEach(function (wp, wi) {
      [[wp.from, wp.fromFwd, wp.s - 0.6, false], [wp.to, wp.toFwd, wp.s + 0.6, true]].forEach(function (m) {
        var sm = sampleR(track, m[2]), R = sm.hw + 1.6, up = sm.up, fwd = norm(m[1]), left = norm(cross(up, fwd));
        var c = madd(m[0], up, R * 0.62);
        var col = m[3] ? hex('#30e3ff', 3) : hex('#d77bff', 3);
        glow.torus(c, left, up, R, low ? 0.35 : 0.45, low ? 18 : 40, low ? 4 : 6, col);
        deco.torus(madd(c, fwd, m[3] ? 0.5 : -0.5), left, up, R + 0.7, 0.35, low ? 18 : 40, 4, hex('#2a2440'));
        [-1, 1].forEach(function (sd) { deco.box(madd(madd(m[0], left, sd * (R + 0.6)), up, R * 0.3), left, up, fwd, 0.6, R * 0.55, 0.6, hex('#2a2440')); });
        if (!m[3] && !low) signBoard(deco, glow, madd(madd(c, up, R + 1.6), fwd, -0.6), mul(fwd, -1), up, 'WARP', 0.5, '#120a24', hex('#d77bff', 2.8));
        dyn.portals.push({ pos: c, fwd: fwd, up: up, left: left, r: R, exit: m[3], s: m[2] });
      });
    });
    /* ---- split lanes: divider wall + nose wedge + glowing top + SHORTCUT sign */
    (track.splits || []).forEach(function (sp) {
      var st = low ? 4 : 2, cDiv = hex(th.rail), hgt = RAIL_H * 1.6;
      for (var s = sp.s0 - sp.nose; s < sp.s0 + sp.len - 1e-6; s += st) {
        var A = sampleR(track, s), B = sampleR(track, Math.min(sp.s0 + sp.len, s + st));
        var da = s < sp.s0 ? sp.dw * clamp((s - sp.s0 + sp.nose) / sp.nose, 0, 1) : sp.dw, db = s + st < sp.s0 ? sp.dw * clamp((s + st - sp.s0 + sp.nose) / sp.nose, 0, 1) : sp.dw;
        var dv = sp.div;
        G.quadN(P(A, dv + da, 0), P(B, dv + db, 0), P(B, dv + db, hgt), P(A, dv + da, hgt), A.left, B.left, cDiv);
        G.quadN(P(A, dv - da, hgt), P(B, dv - db, hgt), P(B, dv - db, 0), P(A, dv - da, 0), mul(A.left, -1), mul(B.left, -1), cDiv);
        G.quadN(P(A, dv + da, hgt), P(B, dv + db, hgt), P(B, dv - db, hgt), P(A, dv - da, hgt), A.up, B.up, hex(th.edge));
        glow.quadN(P(A, dv + da + 0.01, hgt * 0.7), P(B, dv + db + 0.01, hgt * 0.7), P(B, dv + db + 0.01, hgt * 0.5), P(A, dv + da + 0.01, hgt * 0.5), A.left, B.left, hex('#62f0b5', 2.6));
        glow.quadN(P(A, dv - da - 0.01, hgt * 0.5), P(B, dv - db - 0.01, hgt * 0.5), P(B, dv - db - 0.01, hgt * 0.7), P(A, dv - da - 0.01, hgt * 0.7), mul(A.left, -1), mul(B.left, -1), hex(th.glow, 2.4));
      }
      var N0 = sampleR(track, sp.s0 - sp.nose - 1);
      for (var c3 = 0; c3 < 3; c3++) chevron(glow, N0, N0.tangent, sp.div, 1.4, hex('#ffe14a', 2.4));
      // sign above the nose: SHORTCUT with an arrow toward the inner lane
      var Sg = sampleR(track, sp.s0 - sp.nose - 4), sc = P(Sg, sp.div, 5.2), fc = mul(Sg.tangent, -1);
      if (sp.shortcut !== false) {
        signBoard(deco, glow, sc, fc, Sg.up, 'SHORTCUT', low ? 0.32 : 0.28, '#06281a', hex('#62f0b5', 2.6));
        var ar = madd(sc, Sg.left, sp.inner * (textWidth('SHORTCUT', 0.28) / 2 + 1.2));
        for (var a3 = 0; a3 < 2; a3++) {
          var tip = madd(ar, Sg.left, sp.inner * (0.6 + a3 * 0.7)), tb = madd(tip, Sg.left, -sp.inner * 0.6);
          glow.quad(madd(tb, Sg.up, 0.7), madd(tip, Sg.up, 0), madd(madd(tip, Sg.left, -sp.inner * 0.3), Sg.up, 0), madd(madd(tb, Sg.left, -sp.inner * 0.3), Sg.up, 0.7), hex('#62f0b5', 2.6), fc);
          glow.quad(madd(tip, Sg.up, 0), madd(tb, Sg.up, -0.7), madd(madd(tb, Sg.left, -sp.inner * 0.3), Sg.up, -0.7), madd(madd(tip, Sg.left, -sp.inner * 0.3), Sg.up, 0), hex('#62f0b5', 2.6), fc);
        }
        if (!th.noPylons) [-1, 1].forEach(function (sd) { deco.cyl(P(Sg, sp.div + sd * 3.4, 0), P(Sg, sp.div + sd * 3.4, 4.4), 0.12, 0.12, 4, hex('#cccccc'), false); });
      }
    });
    /* ---- booster tunnels: neon arches + glow strips on the arch feet (no occluding shell) */
    (track.tunnels || []).forEach(function (tq) {
      var every = low ? 12 : 6, n2 = low ? 8 : 12, k3 = 0;
      for (var s = tq.s0; s <= tq.s0 + tq.len; s += every, k3++) {
        var A = sampleR(track, s), rx = A.hw + RAIL_W + 0.6, ry = Math.max(6.2, num(tq.r, 7.5));
        var pts = arcPoints(P(A, 0, RAIL_H * 0.5), A.left, A.up, rx, ry, 0, Math.PI, n2);
        polyTube(glow, pts, low ? 0.16 : 0.2, low ? 3 : 4, k3 % 2 ? hex(th.glow, 3) : hex('#7fe3ff', 3));
      }
      // side light bars (vertical glow quads on the rail outer faces)
      for (var s2 = tq.s0; s2 < tq.s0 + tq.len; s2 += low ? 6 : 3) {
        var A2 = sampleR(track, s2), B2 = sampleR(track, s2 + 1.5);
        [-1, 1].forEach(function (sd) { glow.quadN(P(A2, sd * (A2.hw + 0.02), 0.15), P(B2, sd * (B2.hw + 0.02), 0.15), P(B2, sd * (B2.hw + 0.02), RAIL_H - 0.1), P(A2, sd * (A2.hw + 0.02), RAIL_H - 0.1), mul(A2.left, -sd), mul(B2.left, -sd), hex('#7fe3ff', 3)); });
      }
      if (!low) { var Ts = sampleR(track, tq.s0 - 2); signBoard(deco, glow, P(Ts, 0, num(tq.r, 7.5) + 1.6), mul(Ts.tangent, -1), Ts.up, 'BOOST', 0.5, '#04202a', hex('#7fe3ff', 2.8)); }
    });
    /* ---- feature records */
    track.features.forEach(function (f) {
      var sm = sampleR(track, f.s), hw = sm.hw;
      if (f.type === 'hazard') {
        var kind = f.kind || 'pendulum', H, hs0 = FT ? FT.hazardState(f, 0, hw) : null;
        // telegraph stripes (red / white diagonals) over the swept band
        var band = kind === 'hammer' ? [f.lat - num(f.w, 2.8), f.lat + num(f.w, 2.8)] : kind === 'piston' ? (f.side < 0 ? [-hw, -hw + num(f.ext, hw * 0.55)] : [hw - num(f.ext, hw * 0.55), hw]) : [-hw + 0.2, hw - 0.2];
        var sh = kind === 'piston' ? num(f.len, 5) / 2 + 0.5 : kind === 'hammer' ? 2.4 : 2.6;
        var nStr = low ? 3 : 6;
        for (var k = 0; k < nStr; k++) {
          var s0 = f.s - sh + 2 * sh * k / nStr, s1 = f.s - sh + 2 * sh * (k + 0.55) / nStr;
          roadBand(decal, track, s0, s1, band[1], band[0], 0.04, hex(k % 2 ? '#ffffff' : '#e8202a'), s1 - s0);
        }
        if (kind === 'pendulum' || kind === 'windmill') {   // gantry
          H = kind === 'pendulum' ? num(f.h, 13) : (hs0 ? hs0.h : hw) + 0.9;
          [-1, 1].forEach(function (sd) {
            var b0 = P(sm, sd * (hw + 1.6), -THICK), b1 = P(sm, sd * (hw + 1.6), H + 0.6);
            sup.cyl(b0, b1, 0.45, 0.38, seg, cP, false);
            if (!th.noPylons && b0[1] - gy > 1) sup.cyl([b0[0], gy, b0[2]], b0, 0.5, 0.45, seg, cP, false);
          });
          sup.box(P(sm, 0, H + 0.6), sm.left, sm.up, sm.tangent, hw + 1.9, 0.4, 0.5, kind === 'pendulum' ? hex('#ffd23f') : cP);
          glow.box(P(sm, 0, H + 0.12), sm.left, sm.up, sm.tangent, hw + 1.2, 0.05, 0.52, hex('#ff3b30', 2.4));
        } else if (kind === 'hammer') {   // hinge housing at the near rail
          var side = f.lat >= 0 ? 1 : -1;
          deco.box(P(sm, side * (hw + 1.8), 1.0), sm.left, sm.up, sm.tangent, 1.3, 1.6, 1.6, hex('#4a4f5a'));
        } else if (kind === 'piston') {
          var sdp = f.side < 0 ? -1 : 1;
          deco.box(P(sm, sdp * (hw + 2.4), 1.2), sm.left, sm.up, sm.tangent, 1.8, 2.0, num(f.len, 5) / 2 + 1.0, hex('#4a4f5a'));
          glow.box(P(sm, sdp * (hw + 2.4), 3.3), sm.left, sm.up, sm.tangent, 1.6, 0.12, num(f.len, 5) / 2 + 0.6, hex('#ffb000', 2.6));
        } else if (kind === 'boulder') {   // chute ramps on both sides
          [-1, 1].forEach(function (sd) { deco.box(P(sm, sd * (hw + 4.0), 0.8), sm.left, sm.up, sm.tangent, 3.0, 1.2, num(f.r, 2.1) + 1.2, hex('#6a5040')); });
        }
        dyn.hazards.push({ f: f, s: f.s, hw: hw });
      } else if (f.type === 'bumper') {
        var br = num(f.r, 1.2), base = P(sm, f.lat, 0), top = P(sm, f.lat, 1.5);
        sup.cyl(base, top, br, br * 0.92, low ? 8 : 16, hex('#ffffff'), false);
        sup.cyl(madd(base, sm.up, 0.45), madd(base, sm.up, 0.95), br + 0.08, br + 0.08, low ? 8 : 16, hex('#ff2f6d'), false);
        glow.cyl(top, madd(top, sm.up, 0.35), br * 0.95, br * 0.6, low ? 8 : 16, hex('#ff2fd6', 3), true);
        glow.torus(madd(base, sm.up, 0.06), sm.left, cross(sm.tangent, sm.left), br + 0.5, 0.1, low ? 10 : 20, 3, hex('#ffe14a', 2.4));
        dyn.bumpers.push({ id: f.id, pos: madd(top, sm.up, 0.2), up: sm.up, fwd: sm.tangent, r: br });
      } else if (f.type === 'flipper') {
        var sdF = f.side < 0 ? -1 : 1, fl = num(f.len, 6), pv = sampleR(track, f.s - fl / 2);
        deco.cyl(P(pv, sdF * (pv.hw - 0.5), 0), P(pv, sdF * (pv.hw - 0.5), 0.9), 0.55, 0.55, 10, hex('#ffe14a'), true);
        dyn.flippers.push({ f: f, s: f.s, side: sdF, len: fl });
        roadBand(decal, track, f.s - fl / 2, f.s + fl / 2, sdF * (hw - 0.2), sdF * (hw - fl * 0.85), 0.03, function (s) { return Math.floor(s / 1.5) % 2 ? hex('#ffe14a') : hex('#e8202a'); }, fl / 4);
      } else if (f.type === 'spring') {
        var sl = num(f.len, 4), sw = num(f.w, 4);
        roadBand(decal, track, f.s - sl / 2, f.s + sl / 2, f.lat + sw / 2, f.lat - sw / 2, 0.05, function (s) { return Math.floor((s - f.s) / 0.8) % 2 ? hex('#2a6a10') : hex('#7ad82a'); }, 0.8);
        for (var k4 = 0; k4 < (low ? 1 : 3); k4++) {
          var cs2 = sampleR(track, f.s - sl / 2 + sl * (k4 + 0.5) / 3);
          chevron(glow, cs2, cs2.tangent, f.lat, Math.min(3.2, sw * 0.7), hex('#ffffff', 2.2));
        }
        dyn.springs.push({ id: f.id, s: f.s, lat: f.lat, w: sw, len: sl });
      } else if (f.type === 'star') {
        dyn.stars.push({ id: f.id, s: f.s, lat: f.lat, z: num(f.z, 1.3) });
      } else if (f.type === 'ring' && f.fire) {
        dyn.fire[Math.round(f.s * 10) + '|' + Math.round(num(f.lat, 0) * 10)] = true;
      } else if (f.type === 'belt') {
        var bl = num(f.len, 40), bw = num(f.w, 2 * hw), lc = num(f.lat, 0);
        roadBand(decal, track, f.s, f.s + bl, lc + bw / 2, lc - bw / 2, 0.035, hex('#1b1f27'), low ? 6 : 3);
        [-1, 1].forEach(function (sd) { roadBand(glow, track, f.s, f.s + bl, lc + sd * (bw / 2 - 0.05), lc + sd * (bw / 2 - 0.35), 0.05, hex('#7fe3ff', 2.4), low ? 6 : 3); });
        dyn.belts.push({ s: f.s, len: bl, lat: lc, w: bw });
      } else if (f.type === 'driftZone') {
        var zl = num(f.len, 120);
        [-1, 1].forEach(function (sd) {
          roadBand(decal, track, f.s, f.s + zl, sd * (hw - 0.6), sd * (hw - 1.3), 0.035, function (s) { return Math.floor(s / 3) % 2 ? hex('#ffffff') : hex('#ff2fd6'); }, low ? 6 : 3);
        });
        var zs = sampleR(track, f.s - 4);
        [-1, 1].forEach(function (sd) { deco.cyl(P(zs, sd * (zs.hw + 1.2), -THICK), P(zs, sd * (zs.hw + 1.2), 7.4), 0.25, 0.25, 6, hex('#dddddd'), false); });
        deco.box(P(zs, 0, 7.6), zs.left, zs.up, zs.tangent, zs.hw + 1.5, 0.25, 0.3, hex('#dddddd'));
        signBoard(deco, glow, P(zs, 0, 6.2), mul(zs.tangent, -1), zs.up, 'DRIFT ZONE', low ? 0.3 : 0.24, '#2a0626', hex('#ff2fd6', 2.6));
        for (var zc = 8; zc < zl - 4; zc += low ? 24 : 12) { var zr = sampleR(track, f.s + zc); chevron(decal, zr, zr.tangent, 0, 2.2, hex('#ff7ad9')); }
      }
    });
  }

  /* ---------------------------------------------------------------- public: pure geometry */
  function buildGeometry(track, opts) {
    opts = opts || {};
    var q = opts.quality || 'high', th = theme(track);
    var G = new Geo(), glow = new Geo(), support = new Geo(), ground = new Geo(), scen = new Geo(), sglow = new Geo(), deco = new Geo();
    var decal = new Geo(), glass = new Geo();
    var dyn = {};
    var rings = buildTrack(track, th, q, G, glow, deco);
    buildSupports(track, th, q, support, rings);
    buildDeco(track, th, q, deco, glow, dyn);
    featureAnchors(track, dyn);
    var pads = padGeo(track, th, glow, dyn);
    buildSpecial(track, th, q, { track: G, glow: glow, support: support, deco: deco, decal: decal, glass: glass, pads: pads }, dyn);
    buildGround(track, th, q, ground);
    if (opts.scenery !== false) buildScenery(track, th, q, scen, sglow);
    var groups = { track: G.out(), glow: glow.out(), support: support.out(), ground: ground.out(), scenery: scen.out(), sceneryGlow: sglow.out(), deco: deco.out(), pads: pads.out(), decal: decal.out(), glass: glass.out() };
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
    /* special features (local frame: +X along the track / object forward, +Y up, +Z right) */
    var ball = new Geo(); ball.sphere([0, 0, 0], 1, 16, 10, hex('#3a3f48')); ball.cyl([0, 0.85, 0], [0, 1.25, 0], 0.3, 0.3, 8, hex('#ffd23f'), true);
    var rock = new Geo(); rock.sphere([0, 0, 0], 1, 9, 6, hex('#7a6050'), 1, 0x5eed); rock.sphere([0.3, 0.2, 0.2], 0.55, 6, 4, hex('#8a7060'), 1, 0x1234);
    var rod = new Geo(); rod.cyl([0, 0, 0], [0, 1, 0], 1, 1, 6, hex('#9aa0a8'), false);
    var head = new Geo();
    head.cyl([-1.7, 0, 0], [1.7, 0, 0], 1.15, 1.15, 16, hex('#8a5a30'), true);
    head.cyl([-1.75, 0, 0], [-1.3, 0, 0], 1.2, 1.2, 16, hex('#e8202a'), true); head.cyl([1.3, 0, 0], [1.75, 0, 0], 1.2, 1.2, 16, hex('#e8202a'), true);
    var blade = new Geo();
    blade.box([0, 0.55, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.12, 0.45, 0.05, hex('#dddddd'));
    blade.quad([0, 0.12, -0.02], [0, 1, -0.02], [0, 1, 0.42], [0, 0.12, 0.3], hex('#ffffff'), [1, 0, 0]);
    var hub = new Geo(); hub.cyl([-0.6, 0, 0], [0.6, 0, 0], 0.9, 0.9, 12, hex('#ffd23f'), true); hub.cyl([0.6, 0, 0], [1.0, 0, 0], 0.5, 0.2, 10, hex('#ff3b30'), true);
    var block = new Geo();   // unit cube; the -Z face (toward the road centre once oriented) striped yellow/black
    block.box([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 1, 1, 1, hex('#5a606c'));
    for (var sb = 0; sb < 6; sb++) block.quad([-1 + sb / 3, -1, 1.01], [-1 + (sb + 1) / 3, -1, 1.01], [-1 + (sb + 1) / 3 - 0.3, 1, 1.01], [-1 + sb / 3 - 0.3, 1, 1.01], hex(sb % 2 ? '#111111' : '#ffd200', 1.2), [0, 0, 1]);
    var star = new Geo(), cs = hex('#ffd23f', 2.6), ce = hex('#fff2a8', 3);
    for (var si = 0; si < 10; si++) {
      var a0 = si / 10 * TAU + PI / 2, a1 = (si + 1) / 10 * TAU + PI / 2, r0 = si % 2 ? 0.45 : 1, r1 = si % 2 ? 1 : 0.45;
      var p0 = [0, Math.sin(a0) * r0, Math.cos(a0) * r0], p1 = [0, Math.sin(a1) * r1, Math.cos(a1) * r1];
      star.quad([0.22, 0, 0], madd(p0, [1, 0, 0], 0), madd(p1, [1, 0, 0], 0), [0.22, 0, 0], si % 2 ? cs : ce, [1, 0, 0]);
      star.quad([-0.22, 0, 0], madd(p1, [1, 0, 0], 0), madd(p0, [1, 0, 0], 0), [-0.22, 0, 0], si % 2 ? ce : cs, [-1, 0, 0]);
    }
    var swirl = new Geo();   // portal disc in the local YZ plane (facing +X), spiral arms, alpha in vertex colours
    for (var sw = 0; sw < 3; sw++) for (var sk = 0; sk < 24; sk++) {
      var t0 = sk / 24, t1 = (sk + 1) / 24, aa0 = sw * TAU / 3 + t0 * 4.5, aa1 = sw * TAU / 3 + t1 * 4.5, w0 = 0.16 * (1 - t0) + 0.04;
      var q0 = [0, Math.sin(aa0) * t0, Math.cos(aa0) * t0], q1 = [0, Math.sin(aa1) * t1, Math.cos(aa1) * t1];
      var q2 = [0, Math.sin(aa1 + w0 * 3) * t1, Math.cos(aa1 + w0 * 3) * t1], q3 = [0, Math.sin(aa0 + w0 * 3) * t0, Math.cos(aa0 + w0 * 3) * t0];
      var cc = hex(sw === 1 ? '#30e3ff' : '#d77bff', 2.4); cc[3] = 0.85 * (1 - t0 * 0.6);
      swirl.quad(q0, q1, q2, q3, cc, [1, 0, 0]);
    }
    var cdisc = hex('#6a2aff', 1.2); cdisc[3] = 0.35;
    for (var sd = 0; sd < 24; sd++) { var b0 = sd / 24 * TAU, b1 = (sd + 1) / 24 * TAU; swirl.quad([0, 0, 0], [0, Math.sin(b0), Math.cos(b0)], [0, Math.sin(b1), Math.cos(b1)], [0, 0, 0], cdisc, [1, 0, 0]); }
    var fireRing = new Geo(); fireRing.torus([0, 0, 0], [0, 1, 0], [0, 0, 1], 1, 0.14, 32, 6, hex('#ff6a10', 4)); fireRing.torus([0, 0, 0], [0, 1, 0], [0, 0, 1], 1.0, 0.07, 32, 4, hex('#ffe08a', 4)); fireRing.torus([0, 0, 0], [0, 1, 0], [0, 0, 1], 1.17, 0.05, 32, 4, hex('#3a1a10'));
    var cap = new Geo(); cap.cyl([0, 0, 0], [0, 0.5, 0], 1.3, 0.8, 16, hex('#ffffff', 3), true);
    var flip = new Geo();
    flip.box([0.5, 0.28, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.5, 0.28, 0.36, hex('#e8202a'));
    flip.box([0.5, 0.57, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.5, 0.02, 0.37, hex('#ffffff'));
    flip.box([0.5, 0.6, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.42, 0.02, 0.12, hex('#ffe14a', 2.4));
    var chev = new Geo(); chevron(chev, { pos: [0, 0, 0], left: [0, 0, -1], up: [0, 1, 0] }, [1, 0, 0], 0, 1, hex('#7fe3ff', 2.6));
    var warn = new Geo(); warn.quad([-1, 0, -1], [-1, 0, 1], [1, 0, 1], [1, 0, -1], hex('#ff2020', 2.5), [0, 1, 0]);
    return { box: box.out(), can: can.out(), coin: coin.out(), ring: ring.out(), lamp: lamp.out(), flame: flame.out(),
      ball: ball.out(), rock: rock.out(), rod: rod.out(), head: head.out(), blade: blade.out(), hub: hub.out(), block: block.out(), star: star.out(),
      swirl: swirl.out(), fireRing: fireRing.out(), cap: cap.out(), flipper: flip.out(), chevron: chev.out(), warn: warn.out() };
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
      pads: { name: 'stunt-pad', color: [1, 1, 1, 1], unlit: true, castShadow: false, polygonOffset: [-1, -2] },
      decal: { name: 'stunt-decal', color: [1, 1, 1, 1], roughness: 0.55, castShadow: false, polygonOffset: [-1, -3] },
      glass: { name: 'stunt-glass', color: [1, 1, 1, 1], unlit: true, transparent: true, depthWrite: false, castShadow: false, doubleSided: true, fog: true }
    };
    Object.keys(res.groups).forEach(function (k) {
      var m = mk(res.groups[k]);
      if (!m) return;
      items.push({ mesh: m, material: MAT[k], kind: 'stunt-' + k, castShadow: k !== 'ground' && k !== 'glow' && k !== 'pads' && k !== 'sceneryGlow' && k !== 'decal' && k !== 'glass', transparent: k === 'glass' });
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

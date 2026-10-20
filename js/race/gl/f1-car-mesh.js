/* ==========================================================================
   Redline — js/race/gl/f1-car-mesh.js
   CB.gl.f1car : the single-spec Formula 1 car as a hand-authored, deliberately faceted low-poly model
   (docs/F1-SPEC.md §2, docs/LOWPOLY-SPEC.md look). Pure geometry, no DOM / GL at load: runs in Node.

   CB.gl.f1car.isF1(build)                 true for CB.f1.teams builds (build.f1 or body.model 'f1-2026')
   CB.gl.f1car.build(build, opts)          -> { parts:[{kind, mat, material, positions, normals, colors, uvs, indices,
                                                attach, wheel?, wing?, stripe?, texture?, castShadow, transparent, triangles}],
                                                dims, cockpitEye, hoodCam, bumperCam, anchors, lod, stats, S }
        opts { lod: 'high' | 'low', number, color, accent, isPlayer, id }
        Same part format as CB.lowpoly.build, so CB.gl.car (car-mesh.js routes F1 builds here) realises, caches and
        poses it like every other car: wheel parts spin / steer (attach 'wheel'), the rain light is kind 'light-brake',
        the DRS flap is a 'wing' part with wing.drs (car-mesh pose() opens it while carSnap.endurance.f1.drs.open /
        carSnap.drsOpen), tyre sidewall stripes carry stripe:true (pose() tints them by carSnap.endurance.f1.compound).
   CB.gl.f1car.livery(build)               resolved livery { primary, secondary, accent, number, halo, wheel, helmet, pattern }
   CB.gl.f1car.badgeTexture(ctx, S, key)   team-name text badge texture (no logo artwork), cached per GL context
   CB.gl.f1car.DIMS                        { length 5.6, width 2.0, height 0.97, wheelbase 3.6, ... }
   CB.gl.f1car.COMPOUND_COLORS             soft / medium / hard / inter / wet sidewall colours (sRGB hex)

   Car-local metres: +x forward, +y up (ground 0), +z right, origin = centre of the overall length (same as CB.gl.car).
   Budgets: high ≈ 2.5–3.5k triangles, low ≤ 420 (one merged body + one merged wheel part: 3 draw calls).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});

(function () {
  'use strict';
  CB.gl = CB.gl || {};

  var PI = Math.PI, TAU = PI * 2, DEG = PI / 180;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function scl(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function norm(a) { var l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function hash(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  /* ================================================================ colour */
  function hexRgb(hex, fb) {
    var s = typeof hex === 'string' ? hex.trim() : '';
    if (s[0] === '#') s = s.slice(1);
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return fb ? hexRgb(fb) : [0.5, 0.5, 0.5];
    var n = parseInt(s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function lin(c) { return [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)]; }
  function lhex(h, fb) { return lin(hexRgb(h, fb)); }
  function luma(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

  var MODEL_ID = 'f1-2026';
  var DIMS = { length: 5.6, width: 2.0, height: 0.97, wheelbase: 3.6, frontAxle: 1.7, rearAxle: -1.9, trackFront: 1.6, trackRear: 1.55,
    wheelRadius: 0.36, rim: 0.229, tireWidthFront: 0.305, tireWidthRear: 0.405, rideHeight: 0.035 };
  var COMPOUND_COLORS = { soft: '#e8121c', medium: '#ffd21f', hard: '#f2f2f2', inter: '#2fbf4a', wet: '#2475e8' };
  var CARBON = [0.014, 0.015, 0.017], CARBON2 = [0.03, 0.031, 0.034], BLACK = [0.008, 0.008, 0.009], TYRE = [0.028, 0.028, 0.03];

  function isF1(b) {
    if (!b || typeof b !== 'object') return false;
    if (CB.f1 && CB.f1.teams && typeof CB.f1.teams.isF1Build === 'function') { try { return !!CB.f1.teams.isF1Build(b); } catch (e) { /* fall through */ } }
    return !!(b.f1 || (b.body && b.body.model === MODEL_ID));
  }

  /* ================================================================ livery patterns
     Where each team's colours go (flat colours only; team names are text badges). Keys: 'p' primary, 's' secondary,
     'a' accent, 'k' carbon black. rearX: engine cover / sidepods behind this x take the secondary colour (split
     liveries); low: sidepod undercut + nose underside in the secondary; stripe: a thin accent band on the sidepod
     shoulder / engine cover. */
  var PATTERNS = {
    mclaren:     { rearX: null, low: 's', nose: 'p', tip: 's', halo: 's', fw: 'p', fwEnd: 's', rwEnd: 's', rw: 'p', fin: 's', stripe: null, mirror: 's', cover: 'p', coverRear: 's', coverRearX: -1.3 },
    ferrari:     { rearX: null, low: 'k', nose: 'p', tip: 'p', halo: 'p', fw: 'p', fwEnd: 'p', rwEnd: 'p', rw: 'p', fin: 'p', stripe: 's', mirror: 'p', cover: 'p' },
    redbull:     { rearX: null, low: 'p', nose: 'p', tip: 'a', halo: 'p', fw: 'p', fwEnd: 's', rwEnd: 'p', rw: 'p', fin: 'p', stripe: 's', mirror: 'p', cover: 'p', badgeOnCover: 'a' },
    mercedes:    { rearX: -0.35, low: 's', nose: 'p', tip: 's', halo: 's', fw: 's', fwEnd: 'p', rwEnd: 's', rw: 's', fin: 's', stripe: 'a', mirror: 's', cover: 'p' },
    astonmartin: { rearX: null, low: 's', nose: 'p', tip: 'a', halo: 'a', fw: 'p', fwEnd: 'a', rwEnd: 'p', rw: 'p', fin: 'p', stripe: 'a', mirror: 'p', cover: 'p' },
    alpine:      { rearX: -1.15, low: 's', nose: 'p', tip: 'a', halo: 's', fw: 'p', fwEnd: 'a', rwEnd: 'a', rw: 'p', fin: 'a', stripe: null, mirror: 'p', cover: 'p', rearKey: 'a' },
    williams:    { rearX: null, low: 's', nose: 'p', tip: 'a', halo: 's', fw: 'p', fwEnd: 's', rwEnd: 's', rw: 'p', fin: 's', stripe: 'a', mirror: 'p', cover: 'p', coverRear: 's', coverRearX: -1.35 },
    racingbulls: { rearX: -0.55, low: 's', nose: 'p', tip: 's', halo: 's', fw: 'p', fwEnd: 's', rwEnd: 's', rw: 's', fin: 's', stripe: 'a', mirror: 's', cover: 'p' },
    audi:        { rearX: -0.7, low: 's', nose: 'p', tip: 'a', halo: 's', fw: 'p', fwEnd: 'a', rwEnd: 'a', rw: 's', fin: 's', stripe: 'a', mirror: 's', cover: 'p' },
    haas:        { rearX: -0.6, low: 's', nose: 'p', tip: 's', halo: 's', fw: 'p', fwEnd: 's', rwEnd: 'a', rw: 's', fin: 's', stripe: 'a', mirror: 's', cover: 'p' },
    cadillac:    { rearX: -0.5, low: 'p', nose: 'p', tip: 's', halo: 'p', fw: 'p', fwEnd: 's', rwEnd: 's', rw: 'p', fin: 's', stripe: 'a', mirror: 'p', cover: 'p', rearKey: 's' },
    _default:    { rearX: null, low: 's', nose: 'p', tip: 'a', halo: 's', fw: 'p', fwEnd: 's', rwEnd: 's', rw: 'p', fin: 's', stripe: 'a', mirror: 'p', cover: 'p' }
  };

  function livery(build, opts) {
    opts = opts || {};
    var f = (build && build.f1) || {}, ex = (build && build.exterior) || {};
    var TT = CB.f1 && CB.f1.teams, team = f.teamId && TT && TT.get ? TT.get(f.teamId) : null;
    // a normalised build (CB.state.normalize drops build.f1) still finds its team by the livery paint
    if (!team && TT && Array.isArray(TT.list)) {
      var pc = String(ex.paint || opts.color || '').toLowerCase();
      for (var ti = 0; ti < TT.list.length && !team; ti++) if (TT.list[ti].livery && TT.list[ti].livery.primary.toLowerCase() === pc) team = TT.list[ti];
      if (team) f = { teamId: team.id, seat: String(ex.livery_number) === String(team.drivers[1] && team.drivers[1].number) ? 1 : 0, teamName: team.name };
    }
    var L = f.livery || {}, TL = team ? team.livery : {};
    var primary = L.primary || TL.primary || opts.color || ex.paint || '#c8102e';
    var secondary = L.secondary || TL.secondary || opts.accent || ex.stripeColor || '#1a1a1a';
    var accent = L.accent || TL.accent || '#ffffff';
    var helmet = '#f2f2f2';
    if (team && team.drivers) { var d = team.drivers[f.seat === 1 ? 1 : 0]; if (d && d.helmet) helmet = d.helmet; }
    if (f.helmet) helmet = f.helmet;
    return {
      teamId: f.teamId || null, teamName: f.teamName || (team && team.name) || '', primary: primary, secondary: secondary, accent: accent,
      number: L.number || TL.number || (luma(hexRgb(primary)) > 0.5 ? '#111111' : '#ffffff'),
      halo: L.halo || TL.halo || secondary, helmet: helmet,
      // wheel covers: the team colour, but never a near-white disc (reads as a hubcap at speed)
      wheel: (function (w) { return luma(hexRgb(w)) > 0.6 ? '#2a2b2e' : w; })(L.wheel || TL.wheel || '#1a1a1a'),
      pattern: PATTERNS[f.teamId] || PATTERNS._default
    };
  }

  /* ================================================================ geometry accumulator (flat shaded) */
  function Acc() { this.p = []; this.n = []; this.c = []; this.t = []; this.i = []; }
  Acc.prototype.tri = function (a, b, c, col, hint, uv) {
    var n = cross(sub(b, a), sub(c, a)), l = len(n);
    if (!(l > 1e-10)) return false;
    n = [n[0] / l, n[1] / l, n[2] / l];
    var ua = uv ? uv[0] : [0, 0], ub = uv ? uv[1] : [0, 0], uc = uv ? uv[2] : [0, 0];
    if (hint && dot(n, hint) < 0) { var t = b; b = c; c = t; t = ub; ub = uc; uc = t; n = [-n[0], -n[1], -n[2]]; }
    var k = this.p.length / 3;
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (var q = 0; q < 3; q++) { this.n.push(n[0], n[1], n[2]); this.c.push(col[0], col[1], col[2], 1); }
    this.t.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    this.i.push(k, k + 1, k + 2);
    return true;
  };
  Acc.prototype.quad = function (a, b, c, d, col, hint, uv) {
    this.tri(a, b, c, col, hint, uv ? [uv[0], uv[1], uv[2]] : null);
    this.tri(a, c, d, col, hint, uv ? [uv[0], uv[2], uv[3]] : null);
  };
  /** convex-ish planar polygon as a fan around its centroid-nearest vertex */
  Acc.prototype.poly = function (pts, col, hint) {
    for (var i = 1; i < pts.length - 1; i++) this.tri(pts[0], pts[i], pts[i + 1], col, hint);
  };
  Acc.prototype.tris = function () { return this.i.length / 3; };
  Acc.prototype.append = function (o) {
    var k = this.p.length / 3;
    Array.prototype.push.apply(this.p, o.p); Array.prototype.push.apply(this.n, o.n);
    Array.prototype.push.apply(this.c, o.c); Array.prototype.push.apply(this.t, o.t);
    for (var i = 0; i < o.i.length; i++) this.i.push(o.i[i] + k);
    return this;
  };
  function mirrorZ(acc) {
    var o = new Acc();
    o.p = acc.p.slice(); o.n = acc.n.slice(); o.c = acc.c.slice(); o.t = acc.t.slice(); o.i = [];
    for (var v = 0; v < o.p.length; v += 3) { o.p[v + 2] = -o.p[v + 2]; o.n[v + 2] = -o.n[v + 2]; }
    for (var i = 0; i < acc.i.length; i += 3) o.i.push(acc.i[i], acc.i[i + 2], acc.i[i + 1]);
    return o;
  }
  function translate(acc, x, y, z) {
    var o = new Acc().append(acc);
    for (var v = 0; v < o.p.length; v += 3) { o.p[v] += x; o.p[v + 1] += y; o.p[v + 2] += z; }
    return o;
  }
  function jit(col, seed, amt) { var j = 1 + (hash(seed) - 0.5) * (amt == null ? 0.07 : amt); return [col[0] * j, col[1] * j, col[2] * j]; }

  /* ---------------- primitives */
  /** side-profile polygon (x, y) extruded across z0..z1 (wings, endplates, fins) */
  function prismZ(acc, prof, z0, z1, col, seed) {
    var n = prof.length, cx = 0, cy = 0, i;
    for (i = 0; i < n; i++) { cx += prof[i][0] / n; cy += prof[i][1] / n; }
    var zc = (z0 + z1) / 2;
    for (i = 0; i < n; i++) {
      var p = prof[i], q = prof[(i + 1) % n];
      var mx = (p[0] + q[0]) / 2 - cx, my = (p[1] + q[1]) / 2 - cy;
      acc.quad([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1], jit(col, (seed || 0) + i), [mx, my, 0]);
    }
    var A = prof.map(function (p) { return [p[0], p[1], z1]; }), B = prof.map(function (p) { return [p[0], p[1], z0]; });
    acc.poly(A, col, [0, 0, z1 >= zc ? 1 : -1]);
    acc.poly(B, col, [0, 0, z0 <= zc ? -1 : 1]);
  }
  /** plan-view polygon (x, z) extruded across y0..y1 (floor, plank) */
  function prismY(acc, plan, y0, y1, col, seed) {
    var n = plan.length, cx = 0, cz = 0, i;
    for (i = 0; i < n; i++) { cx += plan[i][0] / n; cz += plan[i][1] / n; }
    for (i = 0; i < n; i++) {
      var p = plan[i], q = plan[(i + 1) % n];
      acc.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], jit(col, (seed || 0) + i), [(p[0] + q[0]) / 2 - cx, 0, (p[1] + q[1]) / 2 - cz]);
    }
    acc.poly(plan.map(function (p) { return [p[0], y1, p[1]]; }), col, [0, 1, 0]);
    acc.poly(plan.map(function (p) { return [p[0], y0, p[1]]; }), col, [0, -1, 0]);
  }
  /** 4-sided beam from a to b (suspension arms, halo, mirror stalks) */
  function beam(acc, a, b, w, h, col, upHint) {
    var d = norm(sub(b, a)), up = upHint || [0, 1, 0];
    if (Math.abs(dot(d, up)) > 0.95) up = [1, 0, 0];
    var s = norm(cross(d, up)), u = norm(cross(s, d));
    var hw = w / 2, hh = h / 2;
    function ring(c) { return [add(add(c, scl(s, hw)), scl(u, hh)), add(add(c, scl(s, -hw)), scl(u, hh)), add(add(c, scl(s, -hw)), scl(u, -hh)), add(add(c, scl(s, hw)), scl(u, -hh))]; }
    var A = ring(a), B = ring(b), outs = [u, scl(s, -1), scl(u, -1), s];
    for (var i = 0; i < 4; i++) {
      var j = (i + 1) % 4, o = add(outs[i], outs[j]);
      acc.quad(A[i], A[j], B[j], B[i], col, o);
    }
    acc.poly(A, col, scl(d, -1)); acc.poly(B, col, d);
  }
  function box(acc, c, s, col) {
    var x0 = c[0] - s[0] / 2, x1 = c[0] + s[0] / 2;
    prismZ(acc, [[x0, c[1] - s[1] / 2], [x1, c[1] - s[1] / 2], [x1, c[1] + s[1] / 2], [x0, c[1] + s[1] / 2]], c[2] - s[2] / 2, c[2] + s[2] / 2, col);
  }
  /** low-poly ellipsoid (helmet / mirror pods) */
  function ellipsoid(acc, c, r, seg, rings, colFn) {
    for (var i = 0; i < rings; i++) {
      var t0 = -PI / 2 + PI * i / rings, t1 = -PI / 2 + PI * (i + 1) / rings;
      for (var k = 0; k < seg; k++) {
        var a0 = TAU * k / seg, a1 = TAU * (k + 1) / seg;
        function P(t, a) { return [c[0] + r[0] * Math.cos(t) * Math.cos(a), c[1] + r[1] * Math.sin(t), c[2] + r[2] * Math.cos(t) * Math.sin(a)]; }
        var A = P(t0, a0), B = P(t0, a1), C = P(t1, a1), D = P(t1, a0);
        var mid = [Math.cos((t0 + t1) / 2) * Math.cos((a0 + a1) / 2), Math.sin((t0 + t1) / 2), Math.cos((t0 + t1) / 2) * Math.sin((a0 + a1) / 2)];
        var col = colFn(mid, i, k);
        if (i === 0) acc.tri(A, C, D, col, mid); else if (i === rings - 1) acc.tri(A, B, C, col, mid); else acc.quad(A, B, C, D, col, mid);
      }
    }
  }

  /* ---------------- body loft
     stations: [{ x, pts: [[y, z], ...] }] half rings (+z side) from the bottom centre (z = 0) round to the top
     centre (z = 0), same point count per station; mirrored for -z. colFn(face centre [x, y, z], i, j) -> rgb. */
  function loft(acc, st, colFn, caps) {
    var n = st.length, m = st[0].pts.length;
    for (var i = 0; i < n - 1; i++) {
      var s0 = st[i], s1 = st[i + 1];
      var yAx = 0;
      for (var q = 0; q < m; q++) yAx += (s0.pts[q][0] + s1.pts[q][0]) / (2 * m);
      for (var j = 0; j < m - 1; j++) {
        var A = [s0.x, s0.pts[j][0], s0.pts[j][1]], B = [s1.x, s1.pts[j][0], s1.pts[j][1]];
        var C = [s1.x, s1.pts[j + 1][0], s1.pts[j + 1][1]], D = [s0.x, s0.pts[j + 1][0], s0.pts[j + 1][1]];
        var fc = scl(add(add(A, B), add(C, D)), 0.25);
        var hint = [0, fc[1] - yAx, fc[2]];
        if (len(hint) < 1e-4) hint = [0, 1, 0];
        var col0 = colFn(fc, i, j);
        if (!col0) continue;   // hole (cockpit opening)
        var col = jit(col0, i * 31 + j * 7, 0.06);
        acc.quad(A, B, C, D, col, hint);
        var Am = [A[0], A[1], -A[2]], Bm = [B[0], B[1], -B[2]], Cm = [C[0], C[1], -C[2]], Dm = [D[0], D[1], -D[2]];
        acc.quad(Am, Bm, Cm, Dm, jit(colFn([fc[0], fc[1], -fc[2]], i, j), i * 31 + j * 7 + 3, 0.06), [hint[0], hint[1], -hint[2]]);
      }
    }
    function cap(s, dir, col) {
      var ring = s.pts.map(function (p) { return [s.x, p[0], p[1]]; });
      for (var k = s.pts.length - 2; k >= 1; k--) ring.push([s.x, s.pts[k][0], -s.pts[k][1]]);
      acc.poly(ring, col, [dir, 0, 0]);
    }
    if (caps && caps.front) cap(st[0], 1, caps.front);
    if (caps && caps.back) cap(st[n - 1], -1, caps.back);
  }
  function ell(yc, ry, rz, n) {
    var out = [];
    n = n || 9;
    for (var k = 0; k < n; k++) { var a = -PI / 2 + PI * k / (n - 1); out.push([yc + ry * Math.sin(a), Math.max(0, rz * Math.cos(a))]); }
    out[0][1] = 0; out[n - 1][1] = 0;
    return out;
  }
  /** body stations: nose cone -> survival cell -> sidepods with undercut -> airbox / roll hoop -> coke-bottle -> gearbox */
  function bodyStations() {
    return [
      { x: 2.74, pts: ell(0.215, 0.045, 0.055) },
      { x: 2.45, pts: ell(0.25, 0.075, 0.085) },
      { x: 2.1, pts: ell(0.295, 0.105, 0.115) },
      { x: 1.7, pts: ell(0.35, 0.14, 0.15) },
      { x: 1.25, pts: [[0.17, 0], [0.18, 0.16], [0.24, 0.215], [0.34, 0.235], [0.45, 0.23], [0.54, 0.2], [0.59, 0.15], [0.61, 0.08], [0.615, 0]] },
      { x: 0.75, pts: [[0.07, 0], [0.08, 0.24], [0.2, 0.29], [0.38, 0.3], [0.53, 0.29], [0.62, 0.26], [0.665, 0.19], [0.68, 0.1], [0.68, 0]] },
      { x: 0.5, pts: [[0.05, 0], [0.06, 0.3], [0.21, 0.44], [0.4, 0.62], [0.58, 0.62], [0.65, 0.46], [0.675, 0.3], [0.685, 0.15], [0.685, 0]] },
      { x: 0.3, pts: [[0.05, 0], [0.06, 0.3], [0.24, 0.5], [0.44, 0.78], [0.57, 0.75], [0.63, 0.62], [0.67, 0.32], [0.685, 0.17], [0.685, 0]] },
      { x: -0.15, pts: [[0.05, 0], [0.06, 0.3], [0.24, 0.48], [0.43, 0.765], [0.54, 0.73], [0.6, 0.58], [0.68, 0.3], [0.76, 0.15], [0.8, 0]] },
      { x: -0.45, pts: [[0.05, 0], [0.06, 0.3], [0.22, 0.45], [0.4, 0.72], [0.5, 0.68], [0.56, 0.52], [0.7, 0.24], [0.9, 0.12], [0.97, 0]] },
      { x: -0.8, pts: [[0.05, 0], [0.06, 0.28], [0.2, 0.4], [0.35, 0.63], [0.46, 0.58], [0.53, 0.42], [0.69, 0.21], [0.85, 0.1], [0.9, 0]] },
      { x: -1.25, pts: [[0.05, 0], [0.06, 0.26], [0.15, 0.36], [0.3, 0.46], [0.42, 0.42], [0.5, 0.32], [0.62, 0.18], [0.72, 0.08], [0.75, 0]] },
      { x: -1.7, pts: [[0.06, 0], [0.07, 0.2], [0.13, 0.24], [0.25, 0.27], [0.35, 0.25], [0.44, 0.2], [0.53, 0.13], [0.6, 0.06], [0.615, 0]] },
      { x: -2.15, pts: [[0.09, 0], [0.1, 0.13], [0.16, 0.16], [0.25, 0.17], [0.33, 0.16], [0.4, 0.13], [0.46, 0.09], [0.5, 0.04], [0.51, 0]] },
      { x: -2.42, pts: [[0.15, 0], [0.155, 0.08], [0.19, 0.1], [0.25, 0.11], [0.3, 0.1], [0.35, 0.08], [0.38, 0.05], [0.4, 0.025], [0.41, 0]] }
    ];
  }
  function decimate(st, keepSt, keepPts) {
    return keepSt.map(function (i) { var s = st[i]; return { x: s.x, pts: keepPts.map(function (j) { return s.pts[j]; }) }; });
  }

  /* ================================================================ the car */
  function buildCar(build, opts) {
    opts = opts || {};
    var low = opts.lod === 'low';
    var LV = livery(build, opts), P = LV.pattern;
    var C = { p: lhex(LV.primary), s: lhex(LV.secondary), a: lhex(LV.accent), k: CARBON, halo: lhex(LV.halo), wheel: lhex(LV.wheel), helmet: lhex(LV.helmet) };
    function key(k) { return C[k] || C.p; }
    var D = DIMS, xFA = D.frontAxle, xRA = D.rearAxle;
    var dark = new Acc(), body = new Acc(), carbon = new Acc(), wing = new Acc(), drs = new Acc(), driver = new Acc(), rain = new Acc(), decal = new Acc(), badge = new Acc();

    /* ---- body colour by region (face centre) */
    function bodyCol(fc, i) {
      var x = fc[0], y = fc[1], z = Math.abs(fc[2]);
      if (y < 0.075) return CARBON2;                                                     // plank / chassis floor
      if (i === 5 && z > 0.31 && y > 0.1 && y < 0.64) return BLACK;                      // sidepod inlet mouth
      if (x < 0.6 && x > -0.2 && z < 0.27 && y > 0.6) return low ? BLACK : null;         // cockpit opening (high: open, tub below)
      if (x < -0.33 && x > -0.52 && z < 0.11 && y > 0.82) return BLACK;                  // airbox intake
      if (x > 2.3) return key(P.tip);
      if (x > 1.0) return y < 0.24 && P.low ? key(P.low) : key(P.nose);
      if (P.low && y < 0.24 && z > 0.25) return key(P.low);                              // sidepod undercut
      if (P.stripe && z > 0.5 && y > 0.53 && y < 0.6 && x < 0.3 && x > -0.9) return key(P.stripe);   // shoulder stripe
      if (P.rearX != null && x < P.rearX) return key(P.rearKey || 's');
      if (P.coverRear && x < P.coverRearX) return key(P.coverRear);
      return key(P.cover);
    }
    var ST = bodyStations();
    if (low) loft(body, decimate(ST, [0, 3, 5, 7, 9, 11, 13, 14], [0, 2, 3, 6, 8]), bodyCol, { front: key(P.tip), back: CARBON });
    else loft(body, ST, bodyCol, { front: key(P.tip), back: CARBON });
    var tgt = low ? body : carbon;   // low LOD: everything in the one merged part (floor / diffuser in the matte wheel part)

    /* ---- cockpit tub (inward-facing: seen through the opening and from the onboard camera) */
    if (!low) (function tub() {
      var x0 = -0.15, x1 = 0.5, zw = 0.3, yb = 0.14, yt = 0.7, t = low ? body : carbon;
      var c0 = [0.018, 0.019, 0.022], c1 = [0.035, 0.036, 0.04];
      var cen = [(x0 + x1) / 2, (yb + yt) / 2, 0];
      function inward(a, b, c, d, col) { var fc = scl(add(add(a, b), add(c, d)), 0.25); t.quad(a, b, c, d, col, sub(cen, fc)); }
      inward([x0, yb, -zw], [x1, yb, -zw], [x1, yb, zw], [x0, yb, zw], c0);                       // floor / seat
      inward([x0, yb, zw], [x1, yb, zw], [x1, yt, zw], [x0, yt, zw], c1);                         // side walls
      inward([x0, yb, -zw], [x1, yb, -zw], [x1, yt, -zw], [x0, yt, -zw], c1);
      inward([x1, yb, -zw], [x1, yb, zw], [x1, yt, zw], [x1, yt, -zw], c0);                       // front bulkhead
      inward([x0, yb, -zw], [x0, yb, zw], [x0, yt + 0.1, zw], [x0, yt + 0.1, -zw], c1);           // headrest
    })();

    /* ---- floor, plank, edges, diffuser (carbon) */
    if (low) prismY(dark, [[1.05, 0.3], [0.2, 0.86], [-1.55, 0.86], [-1.55, -0.86], [0.2, -0.86], [1.05, -0.3]], 0.03, 0.055, CARBON, 11);
    else prismY(carbon, [[1.05, 0.28], [0.75, 0.62], [0.2, 0.86], [-1.45, 0.88], [-1.6, 0.6], [-1.6, -0.6], [-1.45, -0.88], [0.2, -0.86], [0.75, -0.62], [1.05, -0.28]], 0.03, 0.055, CARBON, 11);
    if (!low) {
      // floor edge wings ahead of the rear tyres + scroll lip
      [1, -1].forEach(function (sd) {
        prismZ(carbon, [[0.2, 0.055], [-1.45, 0.055], [-1.45, 0.1], [0.0, 0.09]], sd * 0.86, sd * 0.89, CARBON, 21);
        // bargeboard-like floor fences
        prismZ(carbon, [[0.95, 0.05], [0.55, 0.05], [0.6, 0.2], [0.85, 0.17]], sd * 0.5, sd * 0.52, CARBON2, 23);
      });
    }
    // diffuser: ramp from the floor to the crash structure + side fences
    prismZ(low ? dark : carbon, [[-1.55, 0.03], [-2.55, 0.33], [-2.55, 0.37], [-1.55, 0.06]], -0.52, 0.52, CARBON, 31);
    if (!low) [1, -1].forEach(function (sd) { prismZ(carbon, [[-1.55, 0.03], [-2.55, 0.3], [-2.55, 0.42], [-1.5, 0.08]], sd * 0.52, sd * 0.545, CARBON2, 33); });

    /* ---- front wing: 3 elements (inner low, outer swept up), endplates, nose pillars */
    function fwElement(x0, x1, y0, t, zIn, zOut, zMid, rise, col, seed) {
      // inner span (|z| < zMid) flat at y0, outer span rising by `rise` toward the endplate
      [1, -1].forEach(function (sd) {
        var a = [[x0, y0], [x1, y0 + t * 0.3], [x1, y0 + t], [x0 - (x0 - x1) * 0.15, y0 + t]];
        prismZ(tgt, a, sd * zIn, sd * zMid, col, seed);
        if (!low) {
          var b = a.map(function (p) { return [p[0] - 0.04, p[1] + rise]; });
          // outer: twisted plate between the inner end and the endplate
          var pIn = a.map(function (p) { return [p[0], p[1], sd * zMid]; }), pOut = b.map(function (p) { return [p[0], p[1], sd * zOut]; });
          for (var i = 0; i < 4; i++) {
            var j = (i + 1) % 4, mid = add(scl(add(pIn[i], pIn[j]), 0.5), scl(add(pOut[i], pOut[j]), 0.5));
            var cen = scl(add(add(pIn[0], pIn[2]), add(pOut[0], pOut[2])), 0.5);
            tgt.quad(pIn[i], pIn[j], pOut[j], pOut[i], jit(col, seed + i + 9), sub(scl(mid, 0.5), scl(cen, 0.5)));
          }
        }
      });
    }
    if (low) {
      fwElement(2.82, 2.36, 0.06, 0.05, 0, 0.97, 0.97, 0, key(P.fw), 41);
    } else {
      fwElement(2.82, 2.42, 0.06, 0.035, 0, 0.96, 0.42, 0.03, CARBON, 41);
      fwElement(2.66, 2.36, 0.105, 0.03, 0.12, 0.96, 0.42, 0.08, key(P.fw), 51);
      fwElement(2.5, 2.26, 0.15, 0.028, 0.16, 0.96, 0.42, 0.12, key(P.fw), 61);
      fwElement(2.36, 2.16, 0.19, 0.024, 0.2, 0.96, 0.42, 0.13, key(P.fwEnd), 71);
      // nose pillars down to the mainplane
      [1, -1].forEach(function (sd) { prismZ(carbon, [[2.62, 0.08], [2.42, 0.08], [2.4, 0.22], [2.55, 0.2]], sd * 0.06, sd * 0.075, CARBON, 81); });
    }
    [1, -1].forEach(function (sd) {   // endplates (with a small outwash foot)
      if (low) prismZ(body, [[2.84, 0.04], [2.2, 0.04], [2.2, 0.32], [2.84, 0.14]], sd * 0.955, sd * 0.975, key(P.fwEnd), 91);
      else prismZ(tgt, [[2.84, 0.04], [2.2, 0.04], [2.14, 0.3], [2.3, 0.34], [2.6, 0.2], [2.84, 0.14]], sd * 0.955, sd * 0.975, key(P.fwEnd), 91);
    });

    /* ---- rear wing: mainplane, DRS flap (own part), endplates, beam wing, swan-neck pylon */
    var rwZ = 0.5;
    prismZ(low ? body : wing, low ? [[-2.44, 0.79], [-2.79, 0.78], [-2.79, 0.82], [-2.48, 0.83]] : [[-2.44, 0.79], [-2.78, 0.78], [-2.79, 0.81], [-2.66, 0.835], [-2.48, 0.83]], -rwZ, rwZ, key(P.rw), 101);
    var flapProf = [[-2.5, 0.865], [-2.8, 0.87], [-2.81, 0.9], [-2.7, 0.955], [-2.55, 0.94]];
    prismZ(low ? body : drs, low ? [[-2.5, 0.865], [-2.81, 0.87], [-2.81, 0.9], [-2.6, 0.95]] : flapProf, -rwZ + 0.005, rwZ - 0.005, key(P.rw), 111);
    [1, -1].forEach(function (sd) {
      prismZ(low ? body : wing, low ? [[-2.4, 0.6], [-2.84, 0.58], [-2.86, 0.98], [-2.42, 0.94]] : [[-2.42, 0.62], [-2.62, 0.56], [-2.84, 0.58], [-2.86, 0.97], [-2.62, 1.0], [-2.43, 0.93]], sd * rwZ, sd * (rwZ + 0.02), key(P.rwEnd), 121);
    });
    if (!low) {
      prismZ(wing, [[-2.5, 0.43], [-2.72, 0.425], [-2.73, 0.46], [-2.55, 0.475]], -0.42, 0.42, CARBON, 131);   // beam wing
      prismZ(wing, [[-2.3, 0.38], [-2.62, 0.4], [-2.6, 0.79], [-2.45, 0.8]], -0.018, 0.018, CARBON, 141);       // pylon
      prismZ(wing, [[-2.42, 0.36], [-2.56, 0.36], [-2.6, 0.5], [-2.46, 0.5]], -0.04, 0.04, CARBON2, 145);         // crash structure tip
    }
    // rain light (centre, under the beam wing)
    box(rain, [-2.6, 0.38, 0], low ? [0.03, 0.05, 0.12] : [0.03, 0.06, 0.14], [0.42, 0.012, 0.014]);

    /* ---- shark fin + airbox lip */
    prismZ(tgt, [[-0.55, 0.96], [-2.25, 0.55], [-2.3, 0.62], [-1.0, 0.92]], -0.012, 0.012, key(P.fin), 151);
    if (!low) {
      // roll hoop / airbox inlet frame (black)
      prismZ(carbon, [[-0.33, 0.83], [-0.42, 0.83], [-0.44, 0.985], [-0.34, 0.98]], -0.12, 0.12, BLACK, 155);
    }

    /* ---- halo (titanium, team colour) */
    var haloCol = key(P.halo);
    var hw = low ? 0.06 : 0.044;
    var front = [0.52, 0.66, 0], top = [0.33, 0.935, 0];
    var hoop = [[0.33, 0.935, 0], [0.22, 0.935, 0.16], [0.02, 0.92, 0.25], [-0.2, 0.89, 0.27], [-0.34, 0.84, 0.25], [-0.42, 0.72, 0.24]];
    beam(tgt === carbon ? body : body, front, top, hw, hw * 0.7, haloCol, [-1, 1, 0]);
    [1, -1].forEach(function (sd) {
      var stepK = low ? 5 : 1;
      for (var i = 0; i < hoop.length - 1; i += stepK) {
        var a = hoop[i], b = hoop[Math.min(hoop.length - 1, i + stepK)];
        beam(body, [a[0], a[1], a[2] * sd], [b[0], b[1], b[2] * sd], hw, hw * 0.75, haloCol);
      }
    });

    /* ---- mirrors on the sidepod shoulders */
    var mirrorPos = [];
    [1, -1].forEach(function (sd) {
      var mp = [0.47, 0.8, sd * 0.53];
      mirrorPos.push({ pos: mp, side: sd });
      if (low) return;
      beam(body, [0.44, 0.64, sd * 0.42], [0.46, 0.77, sd * 0.5], 0.02, 0.02, key(P.mirror));
      prismZ(body, [[0.5, 0.765], [0.44, 0.77], [0.42, 0.835], [0.49, 0.835]], sd * 0.45, sd * 0.61, key(P.mirror), 161);
      // mirror glass (dark) facing back
      decalQuad(body, [0.418, 0.775, sd * 0.47], [0.418, 0.775, sd * 0.595], [0.418, 0.83, sd * 0.595], [0.418, 0.83, sd * 0.47], [-1, 0, 0], [0.05, 0.06, 0.08]);
    });

    /* ---- suspension: wishbones + push rods (carbon black) */
    if (!low) {
      [1, -1].forEach(function (sd) {
        var hubF = [xFA, 0.36, sd * 0.64], hubR = [xRA, 0.36, sd * 0.57];
        // front: upper / lower wishbones (two legs each) + pushrod + track rod
        beam(carbon, [xFA + 0.22, 0.47, sd * 0.16], [hubF[0], 0.46, hubF[2]], 0.035, 0.018, CARBON);
        beam(carbon, [xFA - 0.25, 0.47, sd * 0.2], [hubF[0], 0.46, hubF[2]], 0.035, 0.018, CARBON);
        beam(carbon, [xFA + 0.25, 0.27, sd * 0.15], [hubF[0], 0.25, hubF[2]], 0.035, 0.018, CARBON);
        beam(carbon, [xFA - 0.3, 0.25, sd * 0.2], [hubF[0], 0.25, hubF[2]], 0.035, 0.018, CARBON);
        beam(carbon, [hubF[0] - 0.03, 0.26, sd * 0.6], [xFA - 0.1, 0.52, sd * 0.13], 0.025, 0.025, CARBON2);
        // rear
        beam(carbon, [xRA + 0.3, 0.44, sd * 0.2], [hubR[0], 0.45, hubR[2]], 0.035, 0.018, CARBON);
        beam(carbon, [xRA - 0.2, 0.44, sd * 0.16], [hubR[0], 0.45, hubR[2]], 0.035, 0.018, CARBON);
        beam(carbon, [xRA + 0.35, 0.22, sd * 0.2], [hubR[0], 0.24, hubR[2]], 0.035, 0.018, CARBON);
        beam(carbon, [xRA - 0.15, 0.22, sd * 0.18], [hubR[0], 0.24, hubR[2]], 0.035, 0.018, CARBON);
        // brake ducts / uprights (small dark blocks inside the wheels)
        box(carbon, [xFA, 0.36, sd * 0.585], [0.24, 0.26, 0.05], CARBON2);
        box(carbon, [xRA, 0.36, sd * 0.51], [0.26, 0.28, 0.06], CARBON2);
      });
    }

    /* ---- driver helmet (kind 'driver': hidden in the onboard view) */
    var helm = [-0.12, 0.79, 0];
    ellipsoid(driver, helm, [0.15, 0.135, 0.125], low ? 5 : 10, low ? 2 : 6, function (m, i) {
      if (m[0] > 0.35 && m[1] > -0.25 && m[1] < 0.35) return [0.01, 0.012, 0.016];              // visor
      return i >= (low ? 2 : 4) ? jit(C.helmet, i * 3, 0.1) : jit(C.helmet, i, 0.05);
    });
    if (low) body.append(driver), driver = new Acc();

    /* ---- decals: number on the nose + fin sides, team badge on the sidepods + rear wing endplates */
    var hasDecals = !low;
    function noseTop(x) {
      for (var i = 0; i < ST.length - 1; i++) {
        var a = ST[i], b = ST[i + 1];
        if (x <= a.x && x >= b.x) { var t = (a.x - x) / (a.x - b.x); return lerp(a.pts[a.pts.length - 1][0], b.pts[b.pts.length - 1][0], t); }
      }
      return 0.4;
    }
    if (hasDecals) {
      // nose number: flat on the nose top, readable from the front / above (uv v = 0 at the image top)
      var nx0 = 2.12, nx1 = 1.86, w = 0.1, y0 = noseTop(nx0) + 0.004, y1 = noseTop(nx1) + 0.004;
      decal.quad([nx0, y0, -w], [nx1, y1, -w], [nx1, y1, w], [nx0, y0, w], [1, 1, 1], [0, 1, 0], [[1, 1], [1, 0], [0, 0], [0, 1]]);
      // fin numbers (both sides)
      [1, -1].forEach(function (sd) {
        var zz = sd * 0.0135, a = [-1.15, 0.67], b = [-1.6, 0.6];
        var uv = sd > 0 ? [[0, 1], [1, 1], [1, 0], [0, 0]] : [[1, 1], [0, 1], [0, 0], [1, 0]];
        decal.quad([a[0], a[1] - 0.06, zz], [b[0], b[1] - 0.06, zz], [b[0], b[1] + 0.17, zz], [a[0], a[1] + 0.17, zz], [1, 1, 1], [0, 0, sd], [uv[1], uv[0], uv[3], uv[2]]);
      });
      // team-name badges on the sidepod flanks and the rear wing endplates (text only)
      [1, -1].forEach(function (sd) {
        var z = sd * 0.792, xa = 0.05, xb = -0.6, ya = 0.33, yb = 0.48;
        var uvS = sd > 0 ? [[1, 1], [0, 1], [0, 0], [1, 0]] : [[0, 1], [1, 1], [1, 0], [0, 0]];
        badge.quad([xa, ya, z * (0.775 / 0.792)], [xb, ya, z * (0.745 / 0.792)], [xb, yb, z * (0.74 / 0.792)], [xa, yb, z * (0.79 / 0.792)], [1, 1, 1], [0, 0, sd], uvS);
        var ze = sd * (rwZ + 0.023);
        badge.quad([-2.42, 0.62, ze], [-2.8, 0.62, ze], [-2.8, 0.72, ze], [-2.42, 0.72, ze], [1, 1, 1], [0, 0, sd], uvS);
      });
    }

    /* ---- wheels: 18" rims with wheel covers, wide slicks, compound stripe */
    var wheelInfo = [];
    [['fl', true, -1], ['fr', true, 1], ['rl', false, -1], ['rr', false, 1]].forEach(function (wd) {
      var f = wd[1], sd = wd[2];
      wheelInfo.push({ id: wd[0], front: f, side: sd, x: f ? xFA : xRA, y: D.wheelRadius, z: sd * (f ? D.trackFront : D.trackRear) / 2,
        r: D.wheelRadius, width: f ? D.tireWidthFront : D.tireWidthRear, camber: 0, inset: 0 });
    });
    function wheelGeo(W, sides) {
      var R = W.r, rr = D.rim, hw = W.width / 2, tyre = new Acc(), rim = new Acc(), stripe = new Acc(), N = sides;
      function ring(rad, z, a) { return [Math.cos(a) * rad, Math.sin(a) * rad, z]; }
      // profile: outer sidewall (rim -> stripe -> shoulder), tread, inner sidewall
      var prof = low ? [[R, hw], [R, -hw]] :
        [[rr + 0.01, hw * 0.95], [rr + 0.045, hw], [R - 0.03, hw], [R, hw * 0.78], [R, -hw * 0.78], [R - 0.03, -hw], [rr + 0.01, -hw * 0.95]];
      for (var k = 0; k < N; k++) {
        var a0 = k / N * TAU, a1 = (k + 1) / N * TAU, mid = (a0 + a1) / 2;
        for (var s = 0; s < prof.length - 1; s++) {
          var p = prof[s], q = prof[s + 1];
          var A = ring(p[0], p[1], a0), B = ring(q[0], q[1], a0), Cc = ring(q[0], q[1], a1), Dd = ring(p[0], p[1], a1);
          var cen = scl(add(add(A, B), add(Cc, Dd)), 0.25), hint = sub(cen, [Math.cos(mid) * (rr + R) / 2, Math.sin(mid) * (rr + R) / 2, 0]);
          var target = (!low && s === 1) ? stripe : tyre;
          var col = target === stripe ? [1, 1, 1] : jit(TYRE, k * 5 + s, 0.1);
          target.quad(A, B, Cc, Dd, col, hint);
        }
      }
      // wheel cover: shallow cone (team / black) + hub nut
      // wheel cover: an outer ring in the team's wheel colour round a dark, slightly recessed centre disc
      var face = [], inner = [], wc = C.wheel, dark = [0.025, 0.026, 0.03], zf = hw * 0.95;
      for (var k2 = 0; k2 < N; k2++) { var aa = (k2 + 0.5) / N * TAU; face.push(ring(rr + 0.012, zf, aa)); inner.push(ring(rr * 0.62, zf - 0.012, aa)); }
      var hub = [0, 0, zf - 0.03];
      if (low) {   // far LOD: a flat sidewall disc (tyre black, team-coloured hub) on the outer face only
        var lf = [];
        for (var kl = 0; kl < N; kl++) lf.push(ring(R, hw, (kl + 0.5) / N * TAU));
        for (var kq = 0; kq < N; kq++) rim.tri(lf[kq], lf[(kq + 1) % N], [0, 0, hw], kq % 2 ? TYRE : jit(wc, kq, 0.1), [0, 0, 1]);
      } else for (var k3 = 0; k3 < N; k3++) {
        var k3n = (k3 + 1) % N;
        rim.quad(face[k3], face[k3n], inner[k3n], inner[k3], jit(wc, k3, 0.08), [0, 0, 1]);
        rim.tri(inner[k3], inner[k3n], hub, jit(dark, k3 + 40, 0.15), [0, 0, 1]);
      }
      if (!low) {
        var nut = [];
        for (var k4 = 0; k4 < 6; k4++) nut.push(ring(0.04, hw * 0.95 - 0.02, k4 / 6 * TAU));
        rim.poly(nut, [0.55, 0.5, 0.1], [0, 0, 1]);
        // inner face (dark brake drum)
        var back = [];
        for (var k5 = 0; k5 < N; k5++) back.push(ring(rr, -hw * 0.9, (k5 + 0.5) / N * TAU));
        rim.poly(back, [0.02, 0.02, 0.022], [0, 0, -1]);
      }
      return { tyre: tyre, rim: rim, stripe: stripe };
    }
    var wgeo = {};
    function wg(front) { var k = front ? 'f' : 'r'; return wgeo[k] || (wgeo[k] = wheelGeo(wheelInfo[front ? 0 : 2], low ? 6 : 16)); }

    /* ---- output parts (CB.lowpoly part format) */
    var M = materialsFor();
    var out = [];
    function push(acc, kind, matKey, extra) {
      if (!acc || !acc.i.length) return null;
      var nv = acc.p.length / 3;
      var p = {
        kind: kind, mat: matKey, material: M[matKey] || M.body,
        positions: new Float32Array(acc.p), normals: new Float32Array(acc.n), colors: new Float32Array(acc.c), uvs: new Float32Array(acc.t),
        indices: nv > 65535 ? new Uint32Array(acc.i) : new Uint16Array(acc.i), attach: 'body', castShadow: true, transparent: false,
        triangles: acc.i.length / 3, vertexCount: nv
      };
      if (extra) for (var k in extra) p[k] = extra[k];
      out.push(p);
      return p;
    }
    if (low) {
      push(body, 'body', 'low');
      var wl = new Acc().append(dark);
      wheelInfo.forEach(function (W) {
        var g = wg(W.front), t = new Acc().append(g.tyre).append(g.rim);
        if (W.side < 0) t = mirrorZ(t);
        wl.append(translate(t, W.x, W.y, W.z));
      });
      push(wl, 'wheels', 'wheelsLow', { attach: 'car' });
      push(rain, 'light-brake', 'tail', { castShadow: false });
    } else {
      push(body, 'body', 'body');
      push(carbon, 'carbon', 'carbon');
      push(wing, 'wing', 'wing');
      // DRS flap: pivots about its trailing edge; car-mesh pose() lifts the leading edge (slot opens) while DRS is open
      push(drs, 'wing', 'wing', { wing: { drs: true, active: false, pivot: [-2.8, 0.885], base: 0, open: 26 * DEG } });
      push(driver, 'driver', 'gloss', { castShadow: true });
      push(rain, 'light-brake', 'tail', { castShadow: false });
      if (decal.i.length) push(decal, 'decal', 'decal', { castShadow: false, texture: 'number' });
      if (badge.i.length) push(badge, 'decal', 'decal', { castShadow: false, texture: 'f1badge:' + (LV.teamId || 'team') });
      wheelInfo.forEach(function (W) {
        var g = wg(W.front), base = { attach: 'wheel', wheel: W };
        function mz(a) { return W.side < 0 ? mirrorZ(a) : a; }
        push(mz(g.rim), 'wheel-' + W.id, 'rim', base);
        push(mz(g.tyre), 'tire-' + W.id, 'tyre', base);
        push(mz(g.stripe), 'tire-' + W.id, 'stripe', { attach: 'wheel', wheel: W, stripe: true, castShadow: false });
      });
    }
    var tris = 0;
    out.forEach(function (p) { tris += p.triangles; });
    var number = String(opts.number != null ? opts.number : (build && build.f1 && build.f1.number) || (build && build.exterior && build.exterior.livery_number) || '1');
    var dims = {
      length: D.length, width: D.width, height: D.height, wheelbase: D.wheelbase, track: D.trackFront, trackFront: D.trackFront, trackRear: D.trackRear,
      wheelRadius: D.wheelRadius, wheelRadiusFront: D.wheelRadius, wheelRadiusRear: D.wheelRadius, rideHeight: D.rideHeight,
      frontOverhang: D.length / 2 - xFA, rearOverhang: xRA + D.length / 2, frontAxle: xFA, rearAxle: xRA,
      tireWidthFront: D.tireWidthFront, tireWidthRear: D.tireWidthRear, belt: 0.62, roof: 0.97, deck: 0.6, nose: 0.3,
      style: 'formula', model: MODEL_ID, make: LV.teamName, modelName: 'Formula 1', lowpoly: true, authored: true, f1: true,
      mirrors: mirrorPos
    };
    return {
      parts: out, dims: dims,
      // driver eye just under the halo top bar; T-cam above the airbox; nose camera low on the nose
      cockpitEye: [-0.06, 0.8, 0], hoodCam: [-0.5, 1.07, 0], bumperCam: [2.05, 0.5, 0],
      anchors: { wheels: wheelInfo, headlights: [[2.7, 0.2, 0.05], [2.7, 0.2, -0.05]], brakeLights: [[-2.62, 0.38, 0.05], [-2.62, 0.38, -0.05]], mirrors: mirrorPos },
      lod: low ? 'low' : 'high', stats: { triangles: tris, parts: out.length }, livery: LV,
      S: { style: 'hypercar', number: number, numberColor: LV.number, numberStyle: 'plain', compound: 'slick', driven: 'rwd', drl: 0, lights: 'none', lod: low ? 'low' : 'high', f1: LV }
    };
  }

  function decalQuad(acc, a, b, c, d, n, col) { acc.quad(a, b, c, d, col, n); }

  /* ================================================================ materials */
  function material(o) {
    var c = o.color || [1, 1, 1, 1];
    var m = { baseColor: c, color: c, metallic: num(o.metallic, 0), roughness: num(o.roughness, 0.6), clearcoat: num(o.clearcoat, 0), flake: 0, hueShift: 0,
      emissive: [0, 0, 0], transparent: false, opacity: 1, unlit: false, doubleSided: false, name: o.name || '', lowpoly: true };
    if (o.clearcoatRoughness != null) m.clearcoatRoughness = o.clearcoatRoughness;
    if (o.alphaTest) m.alphaTest = o.alphaTest;
    if (o.polygonOffset) m.polygonOffset = o.polygonOffset;
    if (o.env != null) { m.envIntensity = o.env; m.uEnvIntensity = o.env; }
    m.uBaseColor = m.baseColor; m.uMetallic = m.metallic; m.uRoughness = m.roughness; m.uClearcoat = m.clearcoat;
    m.uEmissive = m.emissive; m.uFlake = 0; m.uHueShift = 0; m.useMap = 0; m.uUseMap = 0;
    return m;
  }
  var MATS = null;
  function materialsFor() {
    if (MATS) return MATS;
    var base = null;
    try { if (CB.lowpoly && typeof CB.lowpoly.materials === 'function') base = CB.lowpoly.materials({ finishId: 'solid' }); } catch (e) { base = null; }
    base = base || {};
    MATS = {
      // gloss livery paint (F1 paint is mostly gloss, a few satin areas)
      body: material({ name: 'paint', roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.08 }),
      carbon: base.carbon || material({ name: 'carbon', roughness: 0.5, clearcoat: 0.15, env: 0.25 }),
      wing: base.wing || material({ name: 'wing', roughness: 0.45, clearcoat: 0.3, env: 0.35 }),
      gloss: base.gloss || material({ name: 'trim-gloss', roughness: 0.22, clearcoat: 1, env: 0.5 }),
      tail: base.tail || material({ name: 'light-brake', roughness: 0.15, clearcoat: 1, polygonOffset: [-1, -2] }),
      tyre: base.tyre || material({ name: 'tyre', roughness: 0.88 }),
      rim: material({ name: 'f1-wheel-cover', roughness: 0.35, metallic: 0.1, clearcoat: 0.6 }),
      stripe: material({ name: 'f1-tyre-stripe', color: [1, 1, 1, 1], roughness: 0.7 }),
      low: base.low || material({ name: 'paint', roughness: 0.35, clearcoat: 0.6 }),
      wheelsLow: base.wheelsLow || material({ name: 'wheels', roughness: 0.65, metallic: 0.25 }),
      decal: material({ name: 'decal', roughness: 0.3, clearcoat: 1, alphaTest: 0.5, polygonOffset: [-1, -2] })
    };
    return MATS;
  }

  /* ================================================================ team badge texture (text only, no logos) */
  var badgeCaches = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function badgeTexture(ctx, S, key) {
    var T = CB.gl && CB.gl.textures;
    if (!T || typeof T.upload !== 'function' || typeof document === 'undefined') return null;
    var LV = (S && S.f1) || {};
    var cache = badgeCaches ? badgeCaches.get(ctx) : null;
    if (badgeCaches && !cache) { cache = {}; badgeCaches.set(ctx, cache); }
    var ck = key + '|' + LV.primary + '|' + LV.teamName;
    if (cache && cache[ck] !== undefined) return cache[ck];
    var tex = null;
    try {
      var W = 512, H = 128, c = document.createElement('canvas');
      c.width = W; c.height = H;
      var g = c.getContext('2d');
      var text = String(LV.teamName || 'TEAM').toUpperCase();
      var pc = hexRgb(LV.primary || '#333333'), sc = hexRgb(LV.secondary || '#ffffff');
      // the badge sits on the primary (sidepod) colour: white text on dark liveries, near-black on light ones
      var ink = luma(pc) > 0.55 ? '#111216' : '#ffffff';
      var accentInk = LV.accent || '#ffffff';
      g.clearRect(0, 0, W, H);
      var fs = 96;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      do { g.font = 'italic 900 ' + fs + 'px "Barlow Condensed","Arial Narrow","Helvetica Neue",Arial,sans-serif'; fs -= 4; } while (g.measureText(text).width > W * 0.9 && fs > 20);
      g.lineJoin = 'round';
      g.strokeStyle = luma(pc) > 0.55 ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.55)'; g.lineWidth = 8;
      g.strokeText(text, W / 2, H / 2 + 4);
      g.fillStyle = ink; g.fillText(text, W / 2, H / 2 + 4);
      // thin accent underline
      var tw = Math.min(W * 0.9, g.measureText(text).width);
      g.fillStyle = accentInk === LV.primary ? (luma(sc) > 0.5 ? '#ffffff' : '#000000') : accentInk;
      g.fillRect(W / 2 - tw / 2, H - 16, tw, 6);
      var img = g.getImageData(0, 0, W, H);
      var I = T._internal || {};
      if (typeof I.dilateRGB === 'function') I.dilateRGB(img.data, W, H, 4);
      var src = { width: W, height: H, data: img.data };
      if (typeof I.buildMips === 'function') src.levels = I.buildMips(img.data, W, H);
      tex = T.upload(ctx, src, { wrapS: 'clamp', wrapT: 'clamp', aniso: 8 });
    } catch (e) { tex = null; }
    if (cache) cache[ck] = tex;
    return tex;
  }

  CB.gl.f1car = {
    MODEL_ID: MODEL_ID, DIMS: DIMS, COMPOUND_COLORS: COMPOUND_COLORS, PATTERNS: PATTERNS,
    isF1: isF1, build: buildCar, livery: livery, badgeTexture: badgeTexture,
    compoundColor: function (id) { return lhex(COMPOUND_COLORS[id] || COMPOUND_COLORS.medium); },
    _: { Acc: Acc, loft: loft, bodyStations: bodyStations, lhex: lhex }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.gl.f1car;
})();

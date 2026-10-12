/* ==========================================================================
   FORGE Atelier — js/race/tracks.js
   CB.race.tracks : track catalog + geometry builder (pure, no DOM).

   Catalog
     CB.race.tracks.list            -> array of track definitions (see docs/RACE-SPEC.md)
     CB.race.tracks.get(id)         -> definition | null
     CB.race.tracks.ids             -> ['forge-speedway', ...]

   Geometry
     CB.race.tracks.build(def)      -> geom (cached per definition object)
     CB.race.tracks.geometry(id)    -> build(get(id))
     CB.race.tracks.project(geom, x, y, hintIndex)
     CB.race.tracks.speedProfile(geom, maxLatG, maxBrakeG, accelFn, opts)
     CB.race.tracks.pointAt(geom, s, lateral)
     CB.race.tracks.validate(geom)  -> { selfIntersections, crossings, minClearance, ... }
     CB.race.tracks.turtle(layout)  -> { points, segments, length } (to author new tracks)

   Track definitions are authored as "turtle" layouts (straights + constant-radius arcs, the
   way real circuits are surveyed) and converted at load time into closed centripetal
   Catmull-Rom control points in meters. Two straights per layout are flagged `auto`; their
   lengths are solved analytically so every circuit closes exactly.

   Geometry conventions (shared with engine / renderer / AI):
     - world meters, +x east, +y "north"; heading in radians, 0 = +x, CCW positive
     - lateral is meters from the centerline, +left (left normal n = (-sin h, cos h))
     - curvature is signed 1/m, + = left-hand (CCW) turn
     - s = 0 at the start/finish line, increasing in race direction, wraps at geom.length
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};

CB.race.tracks = (function () {
  'use strict';

  var PI = Math.PI;
  var TAU = PI * 2;
  var DEG = PI / 180;
  var G = 9.81;
  var SAMPLE_SPACING = 2;      // target meters between centerline samples
  var GRID_CELL = 16;          // spatial hash cell (m)

  /* ------------------------------------------------------------------ utils */

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function wrapAngle(a) {
    a = a % TAU;
    if (a > PI) a -= TAU; else if (a < -PI) a += TAU;
    return a;
  }
  function round2(v) { return Math.round(v * 100) / 100; }
  function hashStr(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function rngFor(seed) {
    var a = (typeof seed === 'string' ? hashStr(seed) : seed >>> 0) || 0x9e3779b9;
    function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    next.range = function (lo, hi) { return lo + (hi - lo) * next(); };
    next.int = function (lo, hi) { return Math.floor(lo + (hi - lo + 1) * next()); };
    next.pick = function (arr) { return arr[Math.floor(next() * arr.length) % arr.length]; };
    next.chance = function (p) { return next() < p; };
    return next;
  }
  function mod(a, n) { return ((a % n) + n) % n; }
  function arcDist(sa, sb, L) { var d = Math.abs(sa - sb) % L; return d > L / 2 ? L - d : d; }

  /* ================================================================ TURTLE
     layout: array of segments
       ['S', length, opts?]                straight
       ['L', radius, degrees, opts?]       left (CCW) arc
       ['R', radius, degrees, opts?]       right (CW) arc
     opts: { auto: true  (length solved for closure, straights only),
             w: width override (m), name: 'Corner name', sand: bool, kerb: scale }
     Starts at (0,0) heading `heading0` (deg). Total turning must be ±360 (or 0 for a figure-8).
  ======================================================================== */

  function normSeg(raw) {
    var kind = raw[0];
    if (kind === 'S') return { kind: 'S', len: raw[1], opts: raw[2] || {} };
    if (kind === 'L' || kind === 'R') {
      return { kind: kind, r: raw[1], deg: raw[2], opts: raw[3] || {}, len: raw[1] * raw[2] * DEG };
    }
    throw new Error('tracks.turtle: bad segment ' + JSON.stringify(raw));
  }

  function walkTurtle(segs, h0) {
    var x = 0, y = 0, h = h0, s = 0;
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var g = segs[i];
      var st = { x: x, y: y, h: h, s: s };
      if (g.kind === 'S') {
        x += Math.cos(h) * g.len; y += Math.sin(h) * g.len;
      } else {
        var sg = g.kind === 'L' ? 1 : -1;
        var cx = x - Math.sin(h) * g.r * sg, cy = y + Math.cos(h) * g.r * sg;
        h += sg * g.deg * DEG;
        x = cx + Math.sin(h) * g.r * sg; y = cy - Math.cos(h) * g.r * sg;
        st.cx = cx; st.cy = cy;
      }
      s += g.len;
      out.push(st);
    }
    return { starts: out, x: x, y: y, h: h, length: s };
  }

  function turtle(layout, options) {
    options = options || {};
    var h0 = (options.heading0 || 0) * DEG;
    var segs = layout.map(normSeg);
    var turn = 0;
    segs.forEach(function (g) { if (g.kind === 'L') turn += g.deg; else if (g.kind === 'R') turn -= g.deg; });
    var at = Math.abs(turn);
    if (Math.abs(at - 360) > 1e-6 && at > 1e-6) {
      throw new Error('tracks.turtle: total turning must be ±360° (or 0° for a figure-8), got ' + turn);
    }
    // closure: weighted minimum-norm adjustment of straight lengths. Straights flagged `auto`
    // absorb most of the correction; `fixed` ones never change. Exact (linear in the lengths).
    var w0 = walkTurtle(segs, h0);
    var gx = -w0.x, gy = -w0.y;
    var m11 = 0, m12 = 0, m22 = 0, wts = [];
    segs.forEach(function (g, i) {
      var wt = 0;
      if (g.kind === 'S' && !g.opts.fixed) wt = g.len * (g.opts.auto ? 6 : 1);
      var dx = Math.cos(w0.starts[i].h), dy = Math.sin(w0.starts[i].h);
      wts.push([wt, dx, dy]);
      m11 += wt * dx * dx; m12 += wt * dx * dy; m22 += wt * dy * dy;
    });
    var det = m11 * m22 - m12 * m12;
    var delta = [];
    if (Math.hypot(gx, gy) > 1e-9) {
      if (Math.abs(det) < 1e-9) throw new Error('tracks.turtle: cannot close layout (straights all parallel)');
      var lx = (m22 * gx - m12 * gy) / det, ly = (m11 * gy - m12 * gx) / det;
      segs.forEach(function (g, i) {
        var wv = wts[i];
        if (!wv[0]) return;
        var d = wv[0] * (wv[1] * lx + wv[2] * ly);
        if (g.len + d < Math.max(4, g.len * 0.25)) {
          throw new Error('tracks.turtle: closure shrinks straight #' + i + ' too far (' + round2(g.len) + ' -> ' + round2(g.len + d) + ')');
        }
        g.len += d;
        delta.push([i, round2(d)]);
      });
    }
    var w = walkTurtle(segs, h0);
    var gap = Math.hypot(w.x, w.y);
    // emit control points
    var points = [], meta = [];
    for (var i = 0; i < segs.length; i++) {
      var g = segs[i], st = w.starts[i];
      var n, k, t;
      if (g.kind === 'S') {
        n = Math.max(1, Math.ceil(g.len / 34));
        for (k = 0; k < n; k++) {
          t = k / n;
          points.push([st.x + Math.cos(st.h) * g.len * t, st.y + Math.sin(st.h) * g.len * t]);
        }
      } else {
        var sg = g.kind === 'L' ? 1 : -1;
        n = Math.max(2, Math.ceil(g.deg / 11), Math.ceil(g.len / 20));
        for (k = 0; k < n; k++) {
          t = k / n;
          var hh = st.h + sg * g.deg * DEG * t;
          points.push([st.cx + Math.sin(hh) * g.r * sg, st.cy - Math.cos(hh) * g.r * sg]);
        }
      }
      meta.push({
        kind: g.kind, s0: st.s, s1: st.s + g.len, len: g.len, r: g.r || Infinity, deg: g.deg || 0,
        dir: g.kind === 'L' ? 1 : g.kind === 'R' ? -1 : 0, opts: g.opts, name: g.opts.name || null,
        heading0: st.h, x0: st.x, y0: st.y
      });
    }
    return {
      points: points.map(function (p) { return [round2(p[0]), round2(p[1])]; }),
      segments: meta, length: w.length, closureGap: gap, autoDelta: delta, turning: turn
    };
  }

  /* ======================================================== CATMULL-ROM */

  // Centripetal Catmull-Rom (alpha = 0.5) on a closed control polygon -> dense polyline.
  function sampleCentripetal(pts, step) {
    var n = pts.length;
    var xs = [], ys = [];
    function knot(ti, a, b) {
      var d = Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1]));
      return ti + Math.max(d, 1e-4);
    }
    for (var i = 0; i < n; i++) {
      var p0 = pts[mod(i - 1, n)], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      var t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
      var chord = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      var m = Math.max(4, Math.ceil(chord / step));
      for (var k = 0; k < m; k++) {
        var t = t1 + (t2 - t1) * (k / m);
        var a1x = ((t1 - t) * p0[0] + (t - t0) * p1[0]) / (t1 - t0);
        var a1y = ((t1 - t) * p0[1] + (t - t0) * p1[1]) / (t1 - t0);
        var a2x = ((t2 - t) * p1[0] + (t - t1) * p2[0]) / (t2 - t1);
        var a2y = ((t2 - t) * p1[1] + (t - t1) * p2[1]) / (t2 - t1);
        var a3x = ((t3 - t) * p2[0] + (t - t2) * p3[0]) / (t3 - t2);
        var a3y = ((t3 - t) * p2[1] + (t - t2) * p3[1]) / (t3 - t2);
        var b1x = ((t2 - t) * a1x + (t - t0) * a2x) / (t2 - t0);
        var b1y = ((t2 - t) * a1y + (t - t0) * a2y) / (t2 - t0);
        var b2x = ((t3 - t) * a2x + (t - t1) * a3x) / (t3 - t1);
        var b2y = ((t3 - t) * a2y + (t - t1) * a3y) / (t3 - t1);
        xs.push(((t2 - t) * b1x + (t - t1) * b2x) / (t2 - t1));
        ys.push(((t2 - t) * b1y + (t - t1) * b2y) / (t2 - t1));
      }
    }
    var cum = [0];
    for (var j = 1; j <= xs.length; j++) {
      var a = j - 1, b = j % xs.length;
      cum.push(cum[j - 1] + Math.hypot(xs[b] - xs[a], ys[b] - ys[a]));
    }
    return { xs: xs, ys: ys, cum: cum, length: cum[xs.length] };
  }

  function splineLength(points) {
    return sampleCentripetal(points, 1).length;
  }

  /* ====================================================== SPATIAL HASH */

  function makeGrid(samples, cell) {
    var map = new Map();
    for (var i = 0; i < samples.length; i++) {
      var k = cellKey(Math.floor(samples[i].x / cell), Math.floor(samples[i].y / cell));
      var arr = map.get(k);
      if (!arr) { arr = []; map.set(k, arr); }
      arr.push(i);
    }
    return { cell: cell, map: map };
  }
  function cellKey(cx, cy) { return cx * 73856093 ^ cy * 19349663; }
  function gridQueryBox(grid, x0, y0, x1, y1, cb) {
    var c = grid.cell;
    var ax = Math.floor(Math.min(x0, x1) / c), bx = Math.floor(Math.max(x0, x1) / c);
    var ay = Math.floor(Math.min(y0, y1) / c), by = Math.floor(Math.max(y0, y1) / c);
    for (var cx = ax; cx <= bx; cx++) {
      for (var cy = ay; cy <= by; cy++) {
        var arr = grid.map.get(cellKey(cx, cy));
        if (arr) for (var k = 0; k < arr.length; k++) cb(arr[k]);
      }
    }
  }
  function nearestSample(geom, x, y, maxRadius) {
    var S = geom.samples, grid = geom._grid, c = grid.cell;
    var cx = Math.floor(x / c), cy = Math.floor(y / c);
    var best = -1, bd = Infinity;
    var maxRing = Math.ceil((maxRadius || 400) / c);
    for (var r = 0; r <= maxRing; r++) {
      for (var ix = cx - r; ix <= cx + r; ix++) {
        for (var iy = cy - r; iy <= cy + r; iy++) {
          if (Math.max(Math.abs(ix - cx), Math.abs(iy - cy)) !== r) continue;
          var arr = grid.map.get(cellKey(ix, iy));
          if (!arr) continue;
          for (var k = 0; k < arr.length; k++) {
            var p = S[arr[k]], dx = p.x - x, dy = p.y - y, d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = arr[k]; }
          }
        }
      }
      if (best >= 0 && Math.sqrt(bd) < (r - 0.5) * c) break;
    }
    if (best < 0 && maxRadius == null) {
      for (var i = 0; i < S.length; i++) {
        var q = S[i], ex = q.x - x, ey = q.y - y, e = ex * ex + ey * ey;
        if (e < bd) { bd = e; best = i; }
      }
    }
    return { index: best, dist: Math.sqrt(bd) };
  }

  /* ============================================================= BUILD */

  var cache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function build(def, options) {
    if (!def || !def.points || def.points.length < 4) throw new Error('tracks.build: invalid track definition');
    options = options || {};
    if (cache && !options.noCache && cache.has(def)) return cache.get(def);
    var t0 = Date.now();

    var baseW = def.width_m || 12;
    var style = def.style || {};
    var kerbCfg = Object.assign({ width: 1.2, radius: 230, outside: true, exitLen: 22, entryLen: 10 }, def.kerbs || {});
    var runoff = Object.assign({ left: 'grass', right: 'grass' }, def.runoff || {});
    var barrier = Object.assign({ left: 12, right: 12 }, def.barrier || {});
    var gravel = def.gravel !== false && style.street !== true;

    // 1. rotate control points so the start/finish line is the first point
    var start = mod(def.pitStraight | 0, def.points.length);
    var pts = def.points.slice(start).concat(def.points.slice(0, start));

    // 2. dense centripetal Catmull-Rom, then uniform resample
    var dense = sampleCentripetal(pts, 0.5);
    var L = dense.length;
    var N = Math.max(48, Math.round(L / SAMPLE_SPACING));
    var ds = L / N;
    var samples = new Array(N);
    var seg = 0, D = dense.xs.length;
    for (var i = 0; i < N; i++) {
      var s = i * ds;
      while (seg < D - 1 && dense.cum[seg + 1] < s) seg++;
      var a = seg, b = (seg + 1) % D;
      var sl = dense.cum[seg + 1] - dense.cum[seg];
      var tt = sl > 0 ? (s - dense.cum[seg]) / sl : 0;
      samples[i] = {
        i: i, s: s,
        x: lerp(dense.xs[a], dense.xs[b], tt),
        y: lerp(dense.ys[a], dense.ys[b], tt),
        heading: 0, curvature: 0, width: baseW, hw: baseW / 2,
        tx: 1, ty: 0, nx: 0, ny: 1,
        leftKerb: 0, rightKerb: 0, sandL: 0, sandR: 0, wallL: 30, wallR: 30,
        racingLine: 0, sector: 0, layer: 0, corner: -1
      };
    }

    // 3. heading, tangent, normal, curvature
    var rawK = new Array(N);
    for (i = 0; i < N; i++) {
      var p = samples[mod(i - 1, N)], q = samples[(i + 1) % N], c = samples[i];
      var hdg = Math.atan2(q.y - p.y, q.x - p.x);
      c.heading = hdg;
      c.tx = Math.cos(hdg); c.ty = Math.sin(hdg);
      c.nx = -c.ty; c.ny = c.tx;
    }
    for (i = 0; i < N; i++) {
      var hp = samples[mod(i - 1, N)].heading, hn = samples[(i + 1) % N].heading;
      rawK[i] = wrapAngle(hn - hp) / (2 * ds);
    }
    var curv = smoothCircular(smoothCircular(rawK, 2), 2);
    for (i = 0; i < N; i++) samples[i].curvature = curv[i];

    // 4. width: keys from layout + smoothing + subtle surveyed irregularity
    var wk = def.widthKeys && def.widthKeys.length ? def.widthKeys : null;
    var wr = rngFor((def.id || 'track') + ':width');
    var ph1 = wr() * TAU, ph2 = wr() * TAU, f1 = 3 + Math.floor(wr() * 5), f2 = 11 + Math.floor(wr() * 9);
    var widths = new Array(N);
    for (i = 0; i < N; i++) {
      var u = i / N;
      var w = wk ? widthFromKeys(wk, u) : baseW;
      widths[i] = w;
    }
    var smoothW = Math.max(3, Math.round(14 / ds));
    widths = smoothCircular(smoothCircular(widths, smoothW), smoothW);
    var noiseAmp = style.street ? 0.18 : 0.32;
    for (i = 0; i < N; i++) {
      var uu = i / N;
      var wv = widths[i] + noiseAmp * Math.sin(TAU * uu * f1 + ph1) + noiseAmp * 0.55 * Math.sin(TAU * uu * f2 + ph2);
      // tracks open up slightly through slow corners (realistic: hairpins are wider)
      var rr = 1 / Math.max(Math.abs(samples[i].curvature), 1e-4);
      if (rr < 40) wv += (40 - rr) / 40 * (style.street ? 0.8 : 1.6);
      samples[i].width = Math.max(5, wv);
      samples[i].hw = samples[i].width / 2;
    }

    // 5. corners
    var corners = detectCorners(samples, ds, L, kerbCfg.radius, def.corners || []);
    corners.forEach(function (cn, ci) {
      for (var k = cn.start; k !== mod(cn.end + 1, N); k = (k + 1) % N) samples[k].corner = ci;
    });

    // 6. kerbs (inside along the corner + apex emphasis, outside on exit / entry)
    var kerbL = new Array(N).fill(0), kerbR = new Array(N).fill(0);
    corners.forEach(function (cn) {
      var sharp = clamp(60 / cn.minRadius, 0.6, 1.4);
      var kw = kerbCfg.width * sharp * (cn.kerbScale || 1);
      var inside = cn.dir > 0 ? kerbL : kerbR;
      var outside = cn.dir > 0 ? kerbR : kerbL;
      var pad = Math.round(4 / ds);
      forRange(cn.start - pad, cn.end + pad, N, function (k) { inside[k] = Math.max(inside[k], kw); });
      if (kerbCfg.outside) {
        var ex = Math.round(kerbCfg.exitLen / ds), en = Math.round(kerbCfg.entryLen / ds);
        var exitFrom = cn.apex + Math.round((cn.end - cn.apex + (cn.end < cn.apex ? N : 0)) * 0.45);
        forRange(exitFrom, cn.end + ex, N, function (k) { outside[k] = Math.max(outside[k], kw * 0.9); });
        forRange(cn.start - en, cn.start + Math.round(en / 2), N, function (k) { outside[k] = Math.max(outside[k], kw * 0.75); });
      }
    });
    // round kerb lengths: remove fragments shorter than 6 m
    pruneShortRuns(kerbL, Math.round(6 / ds)); pruneShortRuns(kerbR, Math.round(6 / ds));
    for (i = 0; i < N; i++) { samples[i].leftKerb = round2(kerbL[i]); samples[i].rightKerb = round2(kerbR[i]); }

    // 7. gravel traps on corner exits (outside), sized by corner speed
    var sandL = new Array(N).fill(0), sandR = new Array(N).fill(0);
    if (gravel) {
      corners.forEach(function (cn) {
        if (cn.minRadius > 260 || cn.noSand) return;
        var sw = clamp(5 + Math.sqrt(cn.minRadius) * 1.15, 6, 22);
        var arr = cn.dir > 0 ? sandR : sandL;
        var a0 = cn.start + Math.round(((cn.apex - cn.start + N) % N) * 0.3);
        var a1 = cn.end + Math.round(40 / ds);
        var len = mod(a1 - a0, N) + 1, taper = Math.max(2, Math.round(12 / ds)), k = 0;
        forRange(a0, a1, N, function (idx) {
          var f = Math.min(1, k / taper, (len - 1 - k) / taper);
          arr[idx] = Math.max(arr[idx], sw * smoothstep(f));
          k++;
        });
      });
    }

    // 8. spatial hash + crossings (figure-8 bridge)
    var grid = makeGrid(samples, GRID_CELL);
    var crossings = findCrossings(samples, grid, L);
    if (crossings.length && def.crossing === 'bridge') {
      crossings.forEach(function (cr) {
        var upper = def.bridgeUpper === 'first' ? cr.indexA : cr.indexB;
        var lower = upper === cr.indexA ? cr.indexB : cr.indexA;
        cr.upperIndex = upper; cr.lowerIndex = lower; cr.type = 'bridge';
        var span = Math.round((samples[lower].hw + 22) / ds);
        forRange(upper - span, upper + span, N, function (k) { samples[k].layer = 1; });
        cr.bridgeStart = mod(upper - span, N); cr.bridgeEnd = mod(upper + span, N);
      });
    } else {
      crossings.forEach(function (cr) { cr.type = 'grade'; });
    }

    // 9. barriers: base distance per side, clamped to half the free space to other track parts
    var free = freeSpace(samples, grid, L, ds);
    var wallL = new Array(N), wallR = new Array(N);
    for (i = 0; i < N; i++) {
      var sm = samples[i];
      var edgeL = sm.hw + kerbL[i], edgeR = sm.hw + kerbR[i];
      var wl = edgeL + sandL[i] + barrier.left;
      var wr2 = edgeR + sandR[i] + barrier.right;
      if (isFinite(free.left[i])) wl = Math.min(wl, sm.hw + Math.max(0.6, (free.left[i] - sm.hw) / 2));
      if (isFinite(free.right[i])) wr2 = Math.min(wr2, sm.hw + Math.max(0.6, (free.right[i] - sm.hw) / 2));
      wallL[i] = Math.max(sm.hw + 0.6, wl);
      wallR[i] = Math.max(sm.hw + 0.6, wr2);
    }
    var wwin = Math.max(2, Math.round(6 / ds));
    wallL = smoothCircular(runningMin(wallL, wwin), wwin);
    wallR = smoothCircular(runningMin(wallR, wwin), wwin);
    for (i = 0; i < N; i++) {
      var sx = samples[i];
      sx.wallL = round2(Math.max(sx.hw + 0.5, wallL[i]));
      sx.wallR = round2(Math.max(sx.hw + 0.5, wallR[i]));
      // keep kerb + gravel inside the barrier
      sx.leftKerb = Math.min(sx.leftKerb, Math.max(0, sx.wallL - sx.hw - 0.3));
      sx.rightKerb = Math.min(sx.rightKerb, Math.max(0, sx.wallR - sx.hw - 0.3));
      sx.sandL = round2(clamp(sandL[i], 0, Math.max(0, sx.wallL - sx.hw - sx.leftKerb - 1.0)));
      sx.sandR = round2(clamp(sandR[i], 0, Math.max(0, sx.wallR - sx.hw - sx.rightKerb - 1.0)));
      sx.runoffL = runoff.left; sx.runoffR = runoff.right;
    }

    // 10. racing line
    var rl = computeRacingLine(samples, ds, def.racingLine || {});
    for (i = 0; i < N; i++) samples[i].racingLine = rl.offset[i];

    // 11. start line, sectors, grid
    var startLine = {
      index: 0, s: 0, x: samples[0].x, y: samples[0].y, heading: samples[0].heading,
      nx: samples[0].nx, ny: samples[0].ny, halfWidth: samples[0].hw,
      a: { x: samples[0].x + samples[0].nx * samples[0].hw, y: samples[0].y + samples[0].ny * samples[0].hw },
      b: { x: samples[0].x - samples[0].nx * samples[0].hw, y: samples[0].y - samples[0].ny * samples[0].hw }
    };
    var sectors = computeSectors(samples, ds, L, def.sectors);
    sectors.forEach(function (sc, si) { forRange(sc.startIndex, sc.endIndex - 1, N, function (k) { samples[k].sector = si; }); });

    var geom = {
      id: def.id, name: def.name, def: def,
      samples: samples, centerline: samples, n: N, count: N, ds: ds,
      length: L, length_m: L,
      startLine: startLine, finishLine: startLine,
      sectors: sectors, sectorStarts: sectors.map(function (x) { return x.start; }),
      sectorBoundaries: sectors.map(function (x) { return x.start; }),
      corners: corners, crossings: crossings,
      racingLine: rl.offset, racingLineXY: rl.xy, racingLineCurvature: rl.curvature, racingLineDs: rl.ds,
      racingLineLength: rl.length,
      theme: def.theme, surface: def.surface, width_m: baseW,
      _grid: grid
    };
    geom.gridSlots = computeGrid(geom, def.gridSlots || 24);
    geom.grid = geom.gridSlots;
    geom.scenery = resolveScenery(geom, def.scenery || []);
    geom.bounds = computeBounds(geom);
    geom.minimap = decimate(samples, Math.max(2, Math.round(10 / ds)));

    // methods (bound helpers so consumers can call geom.project(x, y, hint))
    geom.project = function (x, y, hint) { return project(geom, x, y, hint); };
    geom.speedProfile = function (maxLatG, maxBrakeG, accelFn, opts) {
      return speedProfile(geom, maxLatG, maxBrakeG, accelFn, opts);
    };
    geom.pointAt = function (s, lateral) { return pointAt(geom, s, lateral); };
    geom.indexAt = function (s) { return indexAt(geom, s); };
    geom.sampleAt = function (s) { return samples[indexAt(geom, s)]; };
    geom.lapTime = function (profile) { return lapTime(geom, profile); };
    geom.wrapS = function (s) { return mod(s, L); };
    geom.deltaS = function (a, b) { var d = mod(b - a, L); return d > L / 2 ? d - L : d; };
    geom.buildMs = Date.now() - t0;

    if (cache && !options.noCache) cache.set(def, geom);
    return geom;
  }

  /* ---------------------------------------------------------- build parts */

  function forRange(a, b, N, fn) {
    var len = mod(b - a, N) + 1;
    if (b - a >= N) len = N;
    for (var k = 0; k < len; k++) fn(mod(a + k, N));
  }

  function smoothCircular(arr, half) {
    var N = arr.length, out = new Array(N), wsum = 0, k;
    for (k = -half; k <= half; k++) wsum += half + 1 - Math.abs(k);
    for (var i = 0; i < N; i++) {
      var acc = 0;
      for (k = -half; k <= half; k++) acc += arr[mod(i + k, N)] * (half + 1 - Math.abs(k));
      out[i] = acc / wsum;
    }
    return out;
  }

  function runningMin(arr, half) {
    var N = arr.length, out = new Array(N);
    for (var i = 0; i < N; i++) {
      var m = Infinity;
      for (var k = -half; k <= half; k++) m = Math.min(m, arr[mod(i + k, N)]);
      out[i] = m;
    }
    return out;
  }

  function pruneShortRuns(arr, minLen) {
    var N = arr.length, i;
    var startAt = -1;
    for (i = 0; i < N; i++) if (!arr[i]) { startAt = i; break; }
    if (startAt < 0) return;
    var run = [];
    for (var k = 1; k <= N; k++) {
      var idx = (startAt + k) % N;
      if (arr[idx] > 0) run.push(idx);
      else {
        if (run.length && run.length < minLen) run.forEach(function (r) { arr[r] = 0; });
        run = [];
      }
    }
  }

  function widthFromKeys(keys, u) {
    // keys: [[u, w], ...] sorted by u in [0,1)
    var n = keys.length;
    if (n === 1) return keys[0][1];
    for (var i = 0; i < n; i++) {
      var a = keys[i], b = keys[(i + 1) % n];
      var ua = a[0], ub = b[0] + (i === n - 1 ? 1 : 0);
      var uq = u < ua && i === n - 1 ? u + 1 : u;
      if (uq >= ua && uq <= ub) return ub > ua ? lerp(a[1], b[1], (uq - ua) / (ub - ua)) : a[1];
    }
    // u before first key: interpolate last -> first
    var last = keys[n - 1], first = keys[0];
    var span = first[0] + 1 - last[0];
    return span > 0 ? lerp(last[1], first[1], (u + 1 - last[0]) / span) : first[1];
  }

  function detectCorners(samples, ds, L, rThresh, named) {
    var N = samples.length, kTh = 1 / rThresh;
    var flags = new Array(N);
    for (var i = 0; i < N; i++) {
      var k = samples[i].curvature;
      flags[i] = Math.abs(k) > kTh ? (k > 0 ? 1 : -1) : 0;
    }
    // find a starting point outside any corner
    var st = -1;
    for (i = 0; i < N; i++) if (!flags[i]) { st = i; break; }
    if (st < 0) st = 0;
    var regions = [], cur = null;
    for (var j = 1; j <= N; j++) {
      var idx = (st + j) % N, f = flags[idx];
      if (f && cur && cur.dir === f) { cur.end = idx; cur.len++; }
      else {
        if (cur) regions.push(cur);
        cur = f ? { dir: f, start: idx, end: idx, len: 1 } : null;
      }
    }
    if (cur) regions.push(cur);
    // merge same-direction regions separated by tiny gaps (compound corners)
    var gapMax = Math.round(8 / ds);
    var merged = [];
    regions.forEach(function (r) {
      var prev = merged[merged.length - 1];
      if (prev && prev.dir === r.dir && mod(r.start - prev.end, N) <= gapMax) {
        prev.end = r.end; prev.len = mod(prev.end - prev.start, N) + 1;
      } else merged.push(r);
    });
    if (merged.length > 1) {
      var f0 = merged[0], fl = merged[merged.length - 1];
      if (f0.dir === fl.dir && mod(f0.start - fl.end, N) <= gapMax) {
        fl.end = f0.end; fl.len = mod(fl.end - fl.start, N) + 1; merged.shift();
      }
    }
    var minLen = Math.max(3, Math.round(6 / ds));
    var corners = [];
    merged.forEach(function (r) {
      if (r.len < minLen) return;
      var apex = r.start, kmax = 0, turn = 0;
      forRange(r.start, r.end, N, function (k) {
        var a = Math.abs(samples[k].curvature);
        turn += samples[k].curvature * ds;
        if (a > kmax) { kmax = a; apex = k; }
      });
      if (Math.abs(turn) < 8 * DEG) return;
      corners.push({
        start: r.start, end: r.end, apex: apex, dir: r.dir,
        sStart: samples[r.start].s, sApex: samples[apex].s, sEnd: samples[r.end].s,
        minRadius: Math.round(1 / Math.max(kmax, 1e-6) * 10) / 10,
        angle_deg: Math.round(turn / DEG), name: null, number: 0
      });
    });
    corners.sort(function (a, b) { return a.sApex - b.sApex; });
    corners.forEach(function (cn, i) {
      cn.number = i + 1;
      cn.name = 'Turn ' + (i + 1);
    });
    // named corners from the layout: [{u, name, kerbScale, noSand}]
    named.forEach(function (nm) {
      var s = nm.u * L, best = null, bd = Infinity;
      corners.forEach(function (cn) {
        var d = arcDist(cn.sApex, s, L);
        if (d < bd) { bd = d; best = cn; }
      });
      if (best && bd < Math.max(60, nm.span || 0)) {
        if (!best._named) { best.name = nm.name; best._named = true; }
        if (nm.kerbScale) best.kerbScale = nm.kerbScale;
        if (nm.noSand) best.noSand = true;
      }
    });
    corners.forEach(function (cn) { delete cn._named; });
    return corners;
  }

  function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    var rX = bx - ax, rY = by - ay, sX = dx - cx, sY = dy - cy;
    var den = rX * sY - rY * sX;
    if (Math.abs(den) < 1e-12) return null;
    var t = ((cx - ax) * sY - (cy - ay) * sX) / den;
    var u = ((cx - ax) * rY - (cy - ay) * rX) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { t: t, u: u, x: ax + rX * t, y: ay + rY * t };
  }

  function findCrossings(samples, grid, L) {
    var N = samples.length, out = [];
    for (var i = 0; i < N; i++) {
      var a = samples[i], b = samples[(i + 1) % N];
      gridQueryBox(grid, Math.min(a.x, b.x) - 4, Math.min(a.y, b.y) - 4, Math.max(a.x, b.x) + 4, Math.max(a.y, b.y) + 4, function (j) {
        if (j <= i + 1 || (i === 0 && j === N - 1)) return;
        var c = samples[j], d = samples[(j + 1) % N];
        if (arcDist(a.s, c.s, L) < 10) return;
        var hit = segIntersect(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
        if (!hit) return;
        for (var q = 0; q < out.length; q++) {
          if (Math.hypot(out[q].x - hit.x, out[q].y - hit.y) < 6) return;
        }
        out.push({
          x: hit.x, y: hit.y, indexA: i, indexB: j, sA: a.s, sB: c.s,
          angle_deg: Math.round(Math.abs(wrapAngle(a.heading - c.heading)) / DEG)
        });
      });
    }
    return out;
  }

  // For each sample and side: lateral distance from this centerline to the nearest asphalt edge of a
  // *different* part of the track (Infinity when nothing within reach).
  function freeSpace(samples, grid, L, ds) {
    var N = samples.length, reach = 90;
    var left = new Array(N).fill(Infinity), right = new Array(N).fill(Infinity);
    for (var i = 0; i < N; i++) {
      var p = samples[i];
      for (var side = -1; side <= 1; side += 2) {
        var ex = p.x + p.nx * side * reach, ey = p.y + p.ny * side * reach;
        var best = Infinity;
        gridQueryBox(grid, Math.min(p.x, ex) - 6, Math.min(p.y, ey) - 6, Math.max(p.x, ex) + 6, Math.max(p.y, ey) + 6, function (j) {
          var q = samples[j];
          var dx = q.x - p.x, dy = q.y - p.y;
          var lat = (dx * p.nx + dy * p.ny) * side;
          if (lat <= 0) return;
          var lon = dx * p.tx + dy * p.ty;
          if (Math.abs(lon) > Math.max(4, q.hw * 0.6)) return;
          var e = Math.hypot(dx, dy);
          if (arcDist(p.s, q.s, L) < 1.25 * e + 3) return;          // same stretch of road
          var f = lat - q.hw - Math.max(q.leftKerb, q.rightKerb);
          if (f < p.hw + 0.5) return;                                 // overlapping: a crossing
          if (f < best) best = f;
        });
        if (side < 0) right[i] = best; else left[i] = best;
      }
    }
    return { left: left, right: right };
  }

  /* --------------------------------------------------------- racing line
     Minimum-curvature line: iterative relaxation of lateral offsets toward the midpoint of
     neighbours at several stencil widths (multigrid), constrained to the usable width
     (track width minus car margin, plus part of the kerbs). Converges to the classic
     outside-apex-outside geometry. */
  /* ---------------------------------------------------- min-curvature QP
     The line is p_j = c_j + n_j o_j (offsets along the fixed centerline normals). We minimise the
     arc-length weighted bending energy  sum_j kappa_j(o)^2 ds_j  + mu sum (o[j+1]-o[j])^2  subject to
     lo <= o <= hi with sequential quadratic programming:
       step 0  linearised model kappa ~= kappa_c + o'' + kappa_c^2 o (good global initial guess)
       step t  exact discrete (Menger) curvature of the current line, Jacobian by finite differences
               (tridiagonal: kappa_j depends on o[j-1], o[j], o[j+1]); damped step.
     Each QP is a cyclic banded least-squares problem: H = A'A + mu D1'D1 (pentadiagonal SPD), bounds
     by a primal active-set loop (fix violators, release bound variables whose multiplier has the wrong
     sign), each iteration one O(N) direct solve. The active set is warm-started across SQP steps. */

  function bandedBoxLSQ(P, Q, R, B, mu, lo, hi, state) {
    // minimise |A x + B|^2 + mu |D1 x|^2,  A tridiagonal cyclic (row j: P_j x[j-1] + Q_j x[j] + R_j x[j+1])
    var N = Q.length, i;
    var H0 = new Float64Array(N), H1 = new Float64Array(N), H2 = new Float64Array(N), g = new Float64Array(N);
    for (i = 0; i < N; i++) {
      var im = (i - 1 + N) % N, ip = (i + 1) % N;
      H0[i] = R[im] * R[im] + Q[i] * Q[i] + P[ip] * P[ip] + 2 * mu + 1e-10;
      H1[i] = Q[i] * R[i] + P[ip] * Q[ip] - mu;
      H2[i] = P[ip] * R[ip];
      g[i] = -(R[im] * B[im] + Q[i] * B[i] + P[ip] * B[ip]);
    }
    function hget(r, q) {
      var d = ((q - r) % N + N) % N;
      if (d === 0) return H0[r];
      if (d === 1) return H1[r];
      if (d === 2) return H2[r];
      if (d === N - 1) return H1[q];
      if (d === N - 2) return H2[q];
      return 0;
    }
    var x = new Float64Array(N);
    var M0 = new Float64Array(N), M1 = new Float64Array(N), M2 = new Float64Array(N), rhs = new Float64Array(N);
    function bound(k) { return state[k] > 0 ? hi[k] : lo[k]; }
    function solve() {
      var r, d, q;
      for (r = 0; r < N; r++) { M0[r] = H0[r]; M1[r] = H1[r]; M2[r] = H2[r]; rhs[r] = g[r]; }
      for (r = 0; r < N; r++) {
        if (!state[r]) continue;
        var bv = bound(r);
        for (d = -2; d <= 2; d++) {
          if (!d) continue;
          q = (r + d + N) % N;
          if (!state[q]) rhs[q] -= hget(q, r) * bv;
        }
      }
      for (r = 0; r < N; r++) {
        if (!state[r]) continue;
        M0[r] = 1; rhs[r] = bound(r); M1[r] = 0; M2[r] = 0;
        M1[(r - 1 + N) % N] = 0; M2[(r - 2 + N) % N] = 0;
      }
      cyclicPentaSolve(M0, M1, M2, rhs, x);
    }
    // primal-dual active set (semismooth Newton): lambda = g - Hx on the bound set,
    // A+ = {lambda + cp (x - hi) > 0}, A- = {lambda + cp (x - lo) < 0}; stop when the sets settle.
    var cp = 0;
    for (i = 0; i < N; i++) cp += H0[i];
    cp /= N;
    var lam = new Float64Array(N);
    for (var it = 0; it < 80; it++) {
      solve();
      for (i = 0; i < N; i++) {
        if (!state[i]) { lam[i] = 0; continue; }
        var hx = 0;
        for (var d = -2; d <= 2; d++) { var q = (i + d + N) % N; hx += hget(i, q) * x[q]; }
        lam[i] = g[i] - hx;                           // >0 pushes up (against hi), <0 pushes down (against lo)
      }
      var changed = 0;
      for (i = 0; i < N; i++) {
        var ns = lam[i] + cp * (x[i] - hi[i]) > 1e-12 ? 1 : lam[i] + cp * (x[i] - lo[i]) < -1e-12 ? -1 : 0;
        if (ns !== state[i]) { state[i] = ns; changed++; }
      }
      if (!changed) break;
    }
    for (i = 0; i < N; i++) x[i] = clamp(x[i], lo[i], hi[i]);
    return x;
  }

  function minCurvatureOffsets(cx, cy, nx, ny, kap, ds, lo, hi, opts) {
    var N = kap.length, mu = (opts && opts.lengthWeight) || 0, steps = opts && opts.sqpSteps != null ? opts.sqpSteps : 8;
    var c = 1 / (ds * ds), i;
    var P = new Float64Array(N), Q = new Float64Array(N), R = new Float64Array(N), B = new Float64Array(N);
    var state = new Int8Array(N);
    // step 0: linearised model about the centerline
    for (i = 0; i < N; i++) { P[i] = c; R[i] = c; Q[i] = -2 * c + kap[i] * kap[i]; B[i] = kap[i]; }
    var o = bandedBoxLSQ(P, Q, R, B, mu, lo, hi, state);
    function px(j, v) { return cx[j] + nx[j] * v; }
    function py(j, v) { return cy[j] + ny[j] * v; }
    function kAt(j, om, oj, op) {
      var a = (j - 1 + N) % N, b = (j + 1) % N;
      var ax = px(a, om), ay = py(a, om), bx = px(j, oj), by = py(j, oj), qx = px(b, op), qy = py(b, op);
      var abx = bx - ax, aby = by - ay, bcx = qx - bx, bcy = qy - by, cax = ax - qx, cay = ay - qy;
      var den = Math.sqrt((abx * abx + aby * aby) * (bcx * bcx + bcy * bcy) * (cax * cax + cay * cay));
      return den > 1e-12 ? 2 * (abx * bcy - aby * bcx) / den : 0;
    }
    function energy(v) {
      var e = 0;
      for (var j = 0; j < N; j++) {
        var jm = (j - 1 + N) % N, jp = (j + 1) % N, k = kAt(j, v[jm], v[j], v[jp]);
        var sj = 0.5 * (Math.hypot(px(jp, v[jp]) - px(jm, v[jm]), py(jp, v[jp]) - py(jm, v[jm])));
        e += k * k * sj + mu * (v[jp] - v[j]) * (v[jp] - v[j]);
      }
      return e;
    }
    var h = 1e-3, e0 = energy(o);
    for (var st = 0; st < steps; st++) {
      for (i = 0; i < N; i++) {
        var im = (i - 1 + N) % N, ip = (i + 1) % N;
        var k0 = kAt(i, o[im], o[i], o[ip]);
        var sw = Math.sqrt(Math.max(0.2, 0.5 * Math.hypot(px(ip, o[ip]) - px(im, o[im]), py(ip, o[ip]) - py(im, o[im])) / ds));
        P[i] = sw * (kAt(i, o[im] + h, o[i], o[ip]) - k0) / h;
        Q[i] = sw * (kAt(i, o[im], o[i] + h, o[ip]) - k0) / h;
        R[i] = sw * (kAt(i, o[im], o[i], o[ip] + h) - k0) / h;
        B[i] = sw * k0 - (P[i] * o[im] + Q[i] * o[i] + R[i] * o[ip]);
      }
      var cand = bandedBoxLSQ(P, Q, R, B, mu / ds, lo, hi, state);
      // damped step with backtracking on the true energy
      var alpha = 1, accepted = false;
      for (var bt = 0; bt < 6; bt++) {
        var trial = new Float64Array(N);
        for (i = 0; i < N; i++) trial[i] = o[i] + (cand[i] - o[i]) * alpha;
        var e1 = energy(trial);
        if (e1 < e0) { o = trial; accepted = e0 - e1 > e0 * 1e-4; e0 = e1; break; }
        alpha *= 0.5;
      }
      if (!accepted) break;
    }
    return o;
  }

  /** Solve a symmetric positive-definite cyclic pentadiagonal system (bands M0, M1: (i,i+1), M2: (i,i+2),
   *  indices mod N) in O(N): banded Cholesky of the leading (N-2) block + 2x2 Schur complement border. */
  function cyclicPentaSolve(M0, M1, M2, r, out) {
    var N = M0.length, n = N - 2, i, k;
    function hget(a, b) {
      var d = ((b - a) % N + N) % N;
      if (d === 0) return M0[a];
      if (d === 1) return M1[a];
      if (d === 2) return M2[a];
      if (d === N - 1) return M1[b];
      if (d === N - 2) return M2[b];
      return 0;
    }
    // banded Cholesky of B = H[0..n-1][0..n-1] (bandwidth 2): B = L L'
    var L0 = new Float64Array(n), L1 = new Float64Array(n), L2 = new Float64Array(n); // L[i][i], L[i][i-1], L[i][i-2]
    for (i = 0; i < n; i++) {
      var b2 = i >= 2 ? M2[i - 2] : 0, b1 = i >= 1 ? M1[i - 1] : 0;
      L2[i] = i >= 2 ? b2 / L0[i - 2] : 0;
      L1[i] = i >= 1 ? (b1 - (i >= 2 ? L2[i] * L1[i - 1] : 0)) / L0[i - 1] : 0;
      var dg = M0[i] - L1[i] * L1[i] - L2[i] * L2[i];
      L0[i] = Math.sqrt(Math.max(dg, 1e-14));
    }
    function bsolve(v) {                             // in place: v <- B^-1 v
      for (var a = 0; a < n; a++) {
        var t = v[a];
        if (a >= 1) t -= L1[a] * v[a - 1];
        if (a >= 2) t -= L2[a] * v[a - 2];
        v[a] = t / L0[a];
      }
      for (a = n - 1; a >= 0; a--) {
        var u = v[a];
        if (a + 1 < n) u -= L1[a + 1] * v[a + 1];
        if (a + 2 < n) u -= L2[a + 2] * v[a + 2];
        v[a] = u / L0[a];
      }
    }
    var y = new Float64Array(n), z0 = new Float64Array(n), z1 = new Float64Array(n);
    for (i = 0; i < n; i++) { y[i] = r[i]; z0[i] = hget(i, n); z1[i] = hget(i, n + 1); }
    var c0 = Float64Array.from(z0), c1 = Float64Array.from(z1);
    bsolve(y); bsolve(z0); bsolve(z1);
    var s00 = hget(n, n), s01 = hget(n, n + 1), s11 = hget(n + 1, n + 1), q0 = r[n], q1 = r[n + 1];
    for (k = 0; k < n; k++) {
      s00 -= c0[k] * z0[k]; s01 -= c0[k] * z1[k]; s11 -= c1[k] * z1[k];
      q0 -= c0[k] * y[k]; q1 -= c1[k] * y[k];
    }
    var det = s00 * s11 - s01 * s01;
    var xb0 = (s11 * q0 - s01 * q1) / det, xb1 = (s00 * q1 - s01 * q0) / det;
    for (i = 0; i < n; i++) out[i] = y[i] - z0[i] * xb0 - z1[i] * xb1;
    out[n] = xb0; out[n + 1] = xb1;
    return out;
  }

  function computeRacingLine(samples, ds, cfg) {
    var N = samples.length;
    var margin = cfg.margin != null ? cfg.margin : 1.2;
    var kerbUse = cfg.kerbUse != null ? cfg.kerbUse : 0.6;
    var off = new Float64Array(N), limL = new Float64Array(N), limR = new Float64Array(N);
    var cx = new Float64Array(N), cy = new Float64Array(N), nx = new Float64Array(N), ny = new Float64Array(N);
    var i;
    for (i = 0; i < N; i++) {
      var sm = samples[i];
      cx[i] = sm.x; cy[i] = sm.y; nx[i] = sm.nx; ny[i] = sm.ny;
      limL[i] = Math.max(0, sm.hw - margin + kerbUse * sm.leftKerb);
      limR[i] = Math.max(0, sm.hw - margin + kerbUse * sm.rightKerb);
    }
    // limits must vary gradually (kerbs start abruptly): erode then blur, so the line never steps
    var win = Math.max(2, Math.round(10 / ds)), blur = Math.max(2, Math.round(8 / ds));
    var sL = smoothCircular(runningMin(Array.prototype.slice.call(limL), win), blur);
    var sR = smoothCircular(runningMin(Array.prototype.slice.call(limR), win), blur);
    for (i = 0; i < N; i++) { limL[i] = Math.max(0, Math.min(limL[i], sL[i])); limR[i] = Math.max(0, Math.min(limR[i], sR[i])); }
    // Constrained minimum-curvature line: box-constrained QP in the lateral offsets, solved directly
    // (active set + cyclic banded Cholesky) -> see minCurvatureOffsets().
    var kap = new Float64Array(N);
    for (i = 0; i < N; i++) kap[i] = samples[i].curvature;
    var lo = new Float64Array(N);
    for (i = 0; i < N; i++) lo[i] = -limR[i];
    var sol = minCurvatureOffsets(cx, cy, nx, ny, kap, ds, lo, limL, {
      lengthWeight: cfg.lengthWeight != null ? cfg.lengthWeight : 2e-4, sqpSteps: cfg.sqpSteps
    });
    for (i = 0; i < N; i++) off[i] = sol[i];
    // final light smoothing to remove any stencil artefacts, re-clamped
    var offA = Array.prototype.slice.call(off);
    offA = smoothCircular(offA, 2);
    for (i = 0; i < N; i++) offA[i] = round2(clamp(offA[i], -limR[i], limL[i]));
    var xy = new Array(N);
    for (i = 0; i < N; i++) xy[i] = { x: cx[i] + nx[i] * offA[i], y: cy[i] + ny[i] * offA[i] };
    var dsl = new Array(N), len = 0;
    for (i = 0; i < N; i++) {
      var q = xy[(i + 1) % N];
      dsl[i] = Math.hypot(q.x - xy[i].x, q.y - xy[i].y);
      len += dsl[i];
    }
    var kk = new Array(N);
    for (i = 0; i < N; i++) {
      var p0 = xy[mod(i - 2, N)], p1 = xy[i], p2 = xy[(i + 2) % N];
      kk[i] = mengerCurvature(p0, p1, p2);
    }
    kk = smoothCircular(kk, 2);
    for (i = 0; i < N; i++) { xy[i].heading = Math.atan2(xy[(i + 1) % N].y - xy[mod(i - 1, N)].y, xy[(i + 1) % N].x - xy[mod(i - 1, N)].x); }
    return { offset: offA, xy: xy, curvature: kk, ds: dsl, length: len };
  }

  function mengerCurvature(a, b, c) {
    var abx = b.x - a.x, aby = b.y - a.y, bcx = c.x - b.x, bcy = c.y - b.y, cax = a.x - c.x, cay = a.y - c.y;
    var cross = abx * bcy - aby * bcx;
    var d = Math.hypot(abx, aby) * Math.hypot(bcx, bcy) * Math.hypot(cax, cay);
    return d > 1e-9 ? 2 * cross / d : 0;
  }

  function computeSectors(samples, ds, L, cfg) {
    var N = samples.length;
    var us = cfg && cfg.length === 2 ? cfg : [1 / 3, 2 / 3];
    var idx = [0];
    us.forEach(function (u) {
      var c = Math.round(u * N), best = c, bk = Infinity, win = Math.round(60 / ds);
      for (var k = -win; k <= win; k++) {
        var j = mod(c + k, N), v = Math.abs(samples[j].curvature) + Math.abs(k) * 1e-5;
        if (v < bk) { bk = v; best = j; }
      }
      idx.push(best);
    });
    var out = [];
    for (var i = 0; i < 3; i++) {
      var a = idx[i], b = i < 2 ? idx[i + 1] : N;
      out.push({
        id: i + 1, name: 'S' + (i + 1), startIndex: a, endIndex: b % N,
        start: samples[a].s, end: i < 2 ? samples[b].s : L, s: samples[a].s,
        length: (i < 2 ? samples[b].s : L) - samples[a].s
      });
    }
    return out;
  }

  function computeGrid(geom, count) {
    var S = geom.samples, N = S.length;
    // pole position sits on the inside of turn 1
    var first = geom.corners.length ? geom.corners[0] : null;
    var poleSide = first ? first.dir : 1;
    var slots = [];
    var hw0 = S[0].hw;
    var lat = clamp(hw0 * 0.42, 1.6, 3.4);
    for (var k = 0; k < count; k++) {
      var s = -(7 + k * 5.5);
      var side = k % 2 === 0 ? poleSide : -poleSide;
      var pa = pointAt(geom, s, side * lat);
      slots.push({ slot: k, position: k + 1, row: Math.floor(k / 2), s: mod(s, geom.length), sRel: s, lateral: side * lat,
        x: pa.x, y: pa.y, heading: pa.heading, index: pa.index });
    }
    return slots;
  }

  /* ---------------------------------------------------------- scenery */

  var SCENERY_SHAPES = { tree: 'circle', bush: 'circle', rock: 'circle', lamp: 'circle', cone: 'circle', water: 'circle',
    grandstand: 'rect', building: 'rect', tyres: 'rect', marshal: 'rect', billboard: 'rect', tent: 'rect',
    pits: 'rect', tower: 'rect', bridge: 'rect', barrier: 'rect' };

  function sideBarrier(sm, side) { return side > 0 ? sm.wallL : sm.wallR; }

  function resolveScenery(geom, items) {
    var S = geom.samples, N = S.length, L = geom.length, ds = geom.ds;
    var out = [];
    for (var n = 0; n < items.length; n++) {
      var it = items[n];
      var s = it.s != null ? it.s : (it.u || 0) * L;
      s = mod(s, L);
      var idx = Math.round(s / ds) % N;
      var sm = S[idx];
      var shape = it.shape || SCENERY_SHAPES[it.type] || 'rect';
      var along = shape === 'circle' ? (it.r || 1) * 2 : (it.l || 4);
      var depth = shape === 'circle' ? (it.r || 1) * 2 : (it.w || 4);
      var lateral;
      var side = it.side || (it.lat != null ? (it.lat >= 0 ? 1 : -1) : 1);
      if (it.lat != null) lateral = it.lat;
      else {
        // barrier distance over the item's footprint
        var span = Math.ceil((along / 2 + 2) / ds), wmax = 0;
        for (var k = -span; k <= span; k++) wmax = Math.max(wmax, sideBarrier(S[mod(idx + k, N)], side));
        lateral = side * (wmax + (it.off != null ? it.off : 2) + depth / 2);
      }
      var x = sm.x + sm.nx * lateral, y = sm.y + sm.ny * lateral;
      var rot = sm.heading + (it.rot || 0);
      var o = {
        type: it.type, shape: shape, x: round2(x), y: round2(y), rot: rot,
        l: round2(along), w: round2(depth), r: shape === 'circle' ? (it.r || 1) : round2(Math.hypot(along, depth) / 2),
        h: it.h != null ? it.h : defaultHeight(it.type), s: round2(s), lat: round2(lateral), side: side
      };
      ['color', 'accent', 'variant', 'text', 'lit', 'seats', 'flip', 'name'].forEach(function (key) {
        if (it[key] != null) o[key] = it[key];
      });
      if (sceneryClear(geom, o)) out.push(o);
    }
    // painter order: low/flat things first, tall things last
    var order = { water: 0, rock: 1, bush: 2, tyres: 3, barrier: 3, cone: 3, marshal: 4, tent: 5, billboard: 6, lamp: 7,
      grandstand: 8, pits: 8, tree: 9, building: 10, tower: 11, bridge: 12 };
    out.sort(function (a, b) { return (order[a.type] || 5) - (order[b.type] || 5) || a.s - b.s; });
    return out;
  }

  function defaultHeight(type) {
    return { tree: 12, bush: 1.5, rock: 2, lamp: 9, grandstand: 14, building: 24, tyres: 1, marshal: 3,
      billboard: 6, tent: 4, pits: 8, tower: 30, water: 0, cone: 0.7, bridge: 6, barrier: 1 }[type] || 3;
  }

  function footprintPoints(o) {
    if (o.shape === 'circle') {
      var pts = [[o.x, o.y]];
      for (var a = 0; a < 8; a++) pts.push([o.x + Math.cos(a * PI / 4) * o.r, o.y + Math.sin(a * PI / 4) * o.r]);
      return pts;
    }
    var c = Math.cos(o.rot), s = Math.sin(o.rot), hl = o.l / 2, hw = o.w / 2;
    var res = [[o.x, o.y]];
    for (var fx = -1; fx <= 1; fx += 0.5) {
      for (var fy = -1; fy <= 1; fy += 0.5) {
        if (Math.abs(fx) !== 1 && Math.abs(fy) !== 1) continue;
        res.push([o.x + c * hl * fx - s * hw * fy, o.y + s * hl * fx + c * hw * fy]);
      }
    }
    return res;
  }

  // true when no part of the footprint lies inside any barrier (i.e. on asphalt, kerb, gravel or run-off)
  function sceneryClear(geom, o) {
    var pts = footprintPoints(o);
    var S = geom.samples;
    for (var k = 0; k < pts.length; k++) {
      var px = pts[k][0], py = pts[k][1];
      var bad = false;
      gridQueryBox(geom._grid, px - 48, py - 48, px + 48, py + 48, function (j) {
        if (bad) return;
        var q = S[j], dx = px - q.x, dy = py - q.y;
        var lon = dx * q.tx + dy * q.ty;
        if (Math.abs(lon) > geom.ds * 0.75 + 0.5) return;
        var lat = dx * q.nx + dy * q.ny;
        var lim = lat >= 0 ? q.wallL : q.wallR;
        if (Math.abs(lat) < Math.max(lim, q.hw + 2) + 0.4) bad = true;
      });
      if (bad) return false;
      // corner insides: also reject points simply too close to any centerline sample
      var ns = nearestSample(geom, px, py, 48);
      if (ns.index >= 0 && ns.dist < S[ns.index].hw + 1.5) return false;
    }
    return true;
  }

  function computeBounds(geom) {
    var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    function add(x, y) { if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x; if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y; }
    geom.samples.forEach(function (p) {
      add(p.x + p.nx * p.wallL, p.y + p.ny * p.wallL);
      add(p.x - p.nx * p.wallR, p.y - p.ny * p.wallR);
    });
    var track = { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
    geom.scenery.forEach(function (o) { add(o.x - o.r, o.y - o.r); add(o.x + o.r, o.y + o.r); });
    b.width = b.maxX - b.minX; b.height = b.maxY - b.minY;
    b.cx = (b.minX + b.maxX) / 2; b.cy = (b.minY + b.maxY) / 2;
    track.width = track.maxX - track.minX; track.height = track.maxY - track.minY;
    b.track = track;
    return b;
  }

  function decimate(samples, step) {
    var out = [];
    for (var i = 0; i < samples.length; i += step) out.push([round2(samples[i].x), round2(samples[i].y)]);
    return out;
  }

  /* ============================================================ QUERIES */

  function indexAt(geom, s) {
    return Math.round(mod(s, geom.length) / geom.ds) % geom.n;
  }

  function pointAt(geom, s, lateral) {
    var S = geom.samples, N = S.length;
    var ss = mod(s, geom.length), f = ss / geom.ds;
    var i0 = Math.floor(f) % N, i1 = (i0 + 1) % N, t = f - Math.floor(f);
    var a = S[i0], b = S[i1];
    var h = a.heading + wrapAngle(b.heading - a.heading) * t;
    var x = lerp(a.x, b.x, t), y = lerp(a.y, b.y, t);
    var lat = lateral || 0;
    return { x: x - Math.sin(h) * lat, y: y + Math.cos(h) * lat, heading: h, index: t < 0.5 ? i0 : i1, s: ss,
      width: lerp(a.width, b.width, t), curvature: lerp(a.curvature, b.curvature, t) };
  }

  /**
   * project(geom, x, y, hintIndex) -> { index, s, lateral, onTrack, surface, ... }
   * With a hint: windowed scan (+-24 samples) then hill-climb; falls back to a spatial-hash
   * global search if the hint is missing/stale. Lateral is +left of the race direction.
   */
  function project(geom, x, y, hintIndex) {
    var S = geom.samples, N = S.length;
    var best = -1, bd = Infinity, i, d, dx, dy;
    if (hintIndex != null && isFinite(hintIndex)) {
      var h = mod(Math.round(hintIndex), N), W = 24;
      for (var k = -W; k <= W; k++) {
        i = mod(h + k, N); dx = S[i].x - x; dy = S[i].y - y; d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      // hill-climb beyond the window if the car moved far
      for (var guard = 0; guard < N; guard++) {
        var moved = false;
        for (var dir = -1; dir <= 1; dir += 2) {
          var j = mod(best + dir, N);
          dx = S[j].x - x; dy = S[j].y - y; d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = j; moved = true; }
        }
        if (!moved) break;
      }
      var lim = Math.max(S[best].wallL, S[best].wallR) + 60;
      if (bd > lim * lim) best = -1;
    }
    if (best < 0) {
      var ns = nearestSample(geom, x, y);
      best = ns.index;
    }
    // refine on the adjacent segments
    var res = refineOnSegment(geom, best, x, y);
    var sm = S[res.index];
    var lat = res.lateral, side = lat >= 0 ? 1 : -1, al = Math.abs(lat);
    var kerb = side > 0 ? sm.leftKerb : sm.rightKerb;
    var sand = side > 0 ? sm.sandL : sm.sandR;
    var wall = side > 0 ? sm.wallL : sm.wallR;
    var run = side > 0 ? sm.runoffL : sm.runoffR;
    var surface;
    if (al <= sm.hw) surface = 'asphalt';
    else if (al >= wall) surface = 'wall';
    else if (al <= sm.hw + kerb) surface = 'kerb';
    else if (sand > 0 && al <= sm.hw + kerb + sand) surface = 'sand';
    else surface = run === 'tarmac' ? 'asphalt' : run === 'sand' ? 'sand' : 'grass';
    return {
      index: res.index, s: res.s, lateral: lat, onTrack: al <= sm.hw + kerb,
      surface: surface, distance: res.dist, halfWidth: sm.hw, width: sm.width,
      edgeDist: sm.hw - al, wallDist: wall - al, heading: res.heading, layer: sm.layer,
      sector: sm.sector, racingLine: sm.racingLine
    };
  }

  function refineOnSegment(geom, i, x, y) {
    var S = geom.samples, N = S.length, L = geom.length;
    var bestR = null;
    for (var o = -1; o <= 0; o++) {
      var a = S[mod(i + o, N)], b = S[mod(i + o + 1, N)];
      var ex = b.x - a.x, ey = b.y - a.y, el2 = ex * ex + ey * ey;
      var t = el2 > 0 ? clamp(((x - a.x) * ex + (y - a.y) * ey) / el2, 0, 1) : 0;
      var fx = a.x + ex * t, fy = a.y + ey * t;
      var dd = Math.hypot(x - fx, y - fy);
      if (!bestR || dd < bestR.dist) {
        var hdg = a.heading + wrapAngle(b.heading - a.heading) * t;
        var nx = -Math.sin(hdg), ny = Math.cos(hdg);
        bestR = { dist: dd, t: t, a: mod(i + o, N), lateral: (x - fx) * nx + (y - fy) * ny, heading: hdg,
          s: mod(a.s + t * geom.ds, L) };
      }
    }
    bestR.index = bestR.t < 0.5 ? bestR.a : (bestR.a + 1) % N;
    return bestR;
  }

  /**
   * speedProfile(geom, maxLatG, maxBrakeG, accelFn, opts) -> Array(n) of target speeds (m/s)
   *   maxLatG    number or fn(v) -> lateral grip in g (fn lets downforce raise grip with speed)
   *   maxBrakeG  number or fn(v) -> braking decel in g
   *   accelFn    fn(v) -> available forward acceleration in m/s² at speed v (net of drag); optional
   *   opts       { line: 'racing'|'center' (default racing), vMax (m/s, default 110), gripMult (1),
   *                startSpeed: ignored (closed-loop profile) }
   * Friction-circle aware forward (traction) and backward (braking) passes on the closed loop.
   */
  function speedProfile(geom, maxLatG, maxBrakeG, accelFn, opts) {
    opts = opts || {};
    var N = geom.n, center = opts.line === 'center';
    var K = center ? geom.samples.map(function (p) { return p.curvature; }) : geom.racingLineCurvature;
    var DS = center ? null : geom.racingLineDs;
    var vMax = opts.vMax || 110, gm = opts.gripMult != null ? opts.gripMult : 1;
    var latFn = typeof maxLatG === 'function' ? maxLatG : function () { return maxLatG || 1; };
    var brkFn = typeof maxBrakeG === 'function' ? maxBrakeG : function () { return maxBrakeG || 1; };
    var acc = typeof accelFn === 'function' ? accelFn : function (v) { return Math.max(0.4, 6.5 - v * 0.055); };
    var limit = new Array(N), i, k;
    for (i = 0; i < N; i++) {
      var kk = Math.max(Math.abs(K[i]), 1e-6), v = vMax;
      for (k = 0; k < 4; k++) v = Math.min(vMax, Math.sqrt(Math.max(0.05, latFn(v) * gm) * G / kk));
      limit[i] = v;
    }
    var vel = limit.slice();
    var m = 0;
    for (i = 1; i < N; i++) if (limit[i] < limit[m]) m = i;
    function dsAt(j) { return DS ? Math.max(0.2, DS[j]) : geom.ds; }
    function ratio(j, v) {
      var lat = v * v * Math.abs(K[j]), max = Math.max(0.05, latFn(v) * gm) * G;
      var r = lat / max;
      return Math.sqrt(Math.max(0.02, 1 - r * r));
    }
    for (var pass = 0; pass < 2; pass++) {
      for (k = 0; k < N; k++) {                       // forward: traction-limited
        i = (m + k) % N; var j = (i + 1) % N, vi = vel[i];
        var a = Math.max(0, acc(vi)) * ratio(i, vi);
        var vn = Math.sqrt(vi * vi + 2 * a * dsAt(i));
        if (vn < vel[j]) vel[j] = vn;
      }
      for (k = 0; k < N; k++) {                       // backward: braking-limited
        i = mod(m - k, N); var p = mod(i - 1, N), vb = vel[i];
        var b = Math.max(0.05, brkFn(vb) * gm) * G * ratio(i, vb);
        var vp = Math.sqrt(vb * vb + 2 * b * dsAt(p));
        if (vp < vel[p]) vel[p] = vp;
      }
    }
    return vel;
  }

  function lapTime(geom, profile) {
    var t = 0, N = geom.n, DS = geom.racingLineDs;
    for (var i = 0; i < N; i++) {
      var v = (profile[i] + profile[(i + 1) % N]) / 2;
      t += (DS ? DS[i] : geom.ds) / Math.max(0.5, v);
    }
    return t;
  }

  /* ============================================================ VALIDATE */

  function validate(geom) {
    var S = geom.samples, N = S.length, L = geom.length;
    var crossings = geom.crossings || [];
    var intentional = geom.def && geom.def.crossing ? (geom.def.crossings || 1) : 0;
    var minClear = Infinity, where = null;
    for (var i = 0; i < N; i += 1) {
      var p = S[i];
      gridQueryBox(geom._grid, p.x - 60, p.y - 60, p.x + 60, p.y + 60, function (j) {
        if (j <= i) return;
        var q = S[j], e = Math.hypot(q.x - p.x, q.y - p.y);
        if (arcDist(p.s, q.s, L) < 1.25 * e + 3 + p.hw + q.hw) return;
        // ignore the intentional crossing neighbourhood
        for (var c = 0; c < crossings.length; c++) {
          var cr = crossings[c];
          if (Math.hypot(p.x - cr.x, p.y - cr.y) < 60 && Math.hypot(q.x - cr.x, q.y - cr.y) < 60) return;
        }
        var cl = e - p.hw - q.hw;
        if (cl < minClear) { minClear = cl; where = { a: i, b: j, x: p.x, y: p.y }; }
      });
    }
    var maxStep = 0, maxTurn = 0;
    for (i = 0; i < N; i++) {
      var a = S[i], b = S[(i + 1) % N];
      maxStep = Math.max(maxStep, Math.hypot(b.x - a.x, b.y - a.y));
      maxTurn = Math.max(maxTurn, Math.abs(wrapAngle(b.heading - a.heading)));
    }
    return {
      length: L, samples: N, crossings: crossings.length, intentionalCrossings: intentional,
      selfIntersections: Math.max(0, crossings.length - intentional),
      minClearance: minClear, minClearanceAt: where, maxStep: maxStep, maxHeadingStep_deg: maxTurn / DEG
    };
  }

  /* ============================================================= CATALOG
     Each track: layout (turtle), metadata, theme, scenery recipe.
  ======================================================================== */

  function makeTrack(o) {
    var layout = o.layout;
    if (o.scale && o.scale !== 1) {
      // uniform layout scale (straight lengths + arc radii); segments flagged noScale keep their
      // authored geometry (e.g. a hairpin or chicane that must stay tight). Auto straights re-close.
      layout = o.layout.map(function (sg) {
        var c = sg.slice(), op = (sg[0] === 'S' ? sg[2] : sg[3]) || {};
        if (!op.noScale) c[1] = round2(sg[1] * o.scale);
        return c;
      });
    }
    var t = turtle(layout, { heading0: o.heading0 || 0 });
    var Lt = t.length;
    // width keys from per-segment overrides
    var keys = [];
    t.segments.forEach(function (sg) {
      var w = sg.opts.w || o.width_m;
      keys.push([sg.s0 / Lt + 1e-6, w]);
      keys.push([Math.max(sg.s0 / Lt + 2e-6, sg.s1 / Lt - 1e-6), w]);
    });
    var named = [];
    t.segments.forEach(function (sg) {
      if (sg.kind !== 'S' && (sg.name || sg.opts.kerbScale || sg.opts.noSand)) {
        named.push({ u: (sg.s0 + sg.len / 2) / Lt, name: sg.name || null, span: sg.len / 2 + 20,
          kerbScale: sg.opts.kerbScale, noSand: sg.opts.noSand });
      }
    });
    named = named.filter(function (n) { return n.name || n.kerbScale || n.noSand; });
    var def = {
      id: o.id, name: o.name, short: o.short || o.name, country: o.country, city: o.city || '',
      desc: o.desc, difficulty: o.difficulty, surface: o.surface, theme: o.theme,
      width_m: o.width_m, points: t.points, pitStraight: 0, length_m: 0,
      style: o.style || {}, kerbs: o.kerbs, runoff: o.runoff, barrier: o.barrier, gravel: o.gravel,
      wallType: o.wallType || 'armco', crossing: o.crossing || null, crossings: o.crossing ? 1 : 0,
      bridgeUpper: o.bridgeUpper, defaultLaps: o.defaultLaps || 3, timeOfDay: o.timeOfDay || 'day',
      tags: o.tags || [], record: o.record || null, widthKeys: dedupeKeys(keys),
      corners: named.filter(function (n) { return n.name; }).map(function (n) { return n; }),
      sectors: o.sectors, layout: layout, layoutScale: o.scale || 1, layoutLength: Lt, elevation_m: o.elevation_m || 0,
      scenery: []
    };
    // scenery recipe works in layout meters, stored as fractions u of the lap
    var ctx = sceneryContext(def, t, rngFor(o.id + ':scenery'));
    if (o.scenery) o.scenery(ctx);
    def.scenery = ctx.items;
    def.length_m = Math.round(splineLength(t.points));
    return def;
  }

  function dedupeKeys(keys) {
    keys.sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    keys.forEach(function (k) {
      var u = clamp(k[0], 0, 0.999999);
      if (!out.length || u - out[out.length - 1][0] > 1e-7) out.push([u, k[1]]);
    });
    return out;
  }

  function sceneryContext(def, t, rng) {
    var Lt = t.length;
    var segs = t.segments;
    var corners = segs.filter(function (s) { return s.kind !== 'S'; }).map(function (s) {
      return { s0: s.s0, s1: s.s1, mid: (s.s0 + s.s1) / 2, r: s.r, deg: s.deg, dir: s.dir, name: s.name,
        inside: s.dir, outside: -s.dir, len: s.len };
    });
    var straights = segs.filter(function (s) { return s.kind === 'S'; }).map(function (s) {
      return { s0: s.s0, s1: s.s1, len: s.len, name: s.name };
    });
    var ctx = {
      L: Lt, rng: rng, items: [], corners: corners, straights: straights, segments: segs,
      add: function (type, s, side, off, props) {
        var it = Object.assign({ type: type, u: mod(s, Lt) / Lt, side: side, off: off }, props || {});
        ctx.items.push(it);
        return it;
      },
      // repeated items along [s0, s1]
      row: function (type, s0, s1, side, spacing, off, props, jitter) {
        for (var s = s0; s <= s1; s += spacing) {
          var p = typeof props === 'function' ? props(s) : props;
          ctx.add(type, s + (jitter ? rng.range(-jitter, jitter) : 0), side, off, p);
        }
      },
      trees: function (s0, s1, side, o) {
        o = o || {};
        var sp = o.spacing || 14, depth = o.depth || 1, kinds = o.variants || ['oak'];
        for (var s = s0; s <= s1; s += sp * rng.range(0.6, 1.4)) {
          for (var d = 0; d < depth; d++) {
            if (o.density != null && !rng.chance(o.density)) continue;
            ctx.add('tree', s + rng.range(-sp / 2, sp / 2), side, (o.off || 3) + d * (o.rowGap || 9) + rng.range(0, o.scatter || 6), {
              r: rng.range(o.rMin || 2.2, o.rMax || 4.2), variant: rng.pick(kinds),
              color: o.colors ? rng.pick(o.colors) : undefined
            });
          }
        }
      },
      buildings: function (s0, s1, side, o) {
        o = o || {};
        var s = s0;
        while (s < s1) {
          var l = rng.range(o.lMin || 18, o.lMax || 42);
          var w = rng.range(o.wMin || 14, o.wMax || 30);
          if (s + l > s1 + 10) break;
          ctx.add('building', s + l / 2, side, (o.off || 3) + rng.range(0, o.offJitter || 2), {
            l: l, w: w, h: rng.range(o.hMin || 10, o.hMax || 40), color: o.colors ? rng.pick(o.colors) : undefined,
            accent: o.accents ? rng.pick(o.accents) : undefined, lit: o.lit || undefined,
            variant: o.variants ? rng.pick(o.variants) : undefined
          });
          s += l + rng.range(o.gapMin || 3, o.gapMax || 9);
        }
      },
      marshals: function (spacing, off) {
        var k = 0;
        for (var s = 60; s < Lt - 40; s += spacing) {
          ctx.add('marshal', s, k++ % 2 ? 1 : -1, off != null ? off : 1.0, { l: 2.6, w: 2.2, h: 2.8, text: String(k) });
        }
      },
      // tyre walls on the outside of slow corners, billboards in the braking zones
      cornerFurniture: function (o) {
        o = o || {};
        corners.forEach(function (c) {
          if (c.r <= (o.tyreR || 70)) {
            var len = Math.max(12, c.len * 0.9);
            ctx.add('tyres', c.s0 + c.len * 0.55, c.outside, 0.2, { l: Math.min(len, 60), w: 1.4, h: 1.0, color: o.tyreColor });
          }
          if (c.r <= (o.boardR || 120) && c.deg >= 35) {
            var before = c.s0 - (o.boardDist || 90);
            ctx.add('billboard', before, c.outside, 1.5, { l: 14, w: 1.2, h: 6, text: rng.pick(o.brands || BRANDS), rot: 0 });
            if (o.countdownBoards !== false) {
              [150, 100, 50].forEach(function (d) {
                ctx.add('billboard', c.s0 - d, c.outside, 0.6, { l: 1.4, w: 0.4, h: 2, text: String(d), variant: 'distance' });
              });
            }
          }
        });
      }
    };
    return ctx;
  }

  var BRANDS = ['REDLINE', 'RPM WORKS', 'HELIX OIL', 'NOVA TYRES', 'VOLTA', 'KESTREL', 'ORBITAL', 'MERIDIAN', 'APEX FUEL', 'CARBONWERK'];

  var defs = [];

  /* ---------------- 1. Redline Motor Speedway — fast tri-oval ---------------- */
  defs.push(makeTrack({
    id: 'forge-speedway', name: 'Redline Motor Speedway', short: 'Speedway', country: 'USA', city: 'Bakersfield, CA',
    desc: 'A 3.0 km banked tri-oval. Flat-out for the brave: long sweeping turns, a kinked front stretch and slipstream battles.',
    difficulty: 1, surface: { grip: 1.0, type: 'asphalt' }, width_m: 18, defaultLaps: 6,
    theme: { grass: '#5a7f37', asphalt: '#393b3f', kerbA: '#d42a2a', kerbB: '#f4f4f4', sand: '#cfb680', sky: '#86b9e8',
      line: '#f5f5f0', wall: '#dedede', barrier: '#9aa1a8', tree: '#355f2c', ground: '#5a7f37', accent: '#ffb21e', night: false },
    style: { oval: true }, wallType: 'safer', gravel: false,
    kerbs: { width: 1.4, radius: 330, outside: false },
    runoff: { left: 'grass', right: 'tarmac' }, barrier: { left: 26, right: 3.5 },
    tags: ['high-speed', 'slipstream', 'banked'],
    layout: [
      ['L', 640, 18, { name: 'Tri-Oval', w: 19 }],
      ['S', 250, { auto: true, w: 19 }],
      ['L', 245, 162, { name: 'Turns 1–2' }],
      ['S', 720, { auto: true, name: 'Back Stretch' }],
      ['L', 245, 162, { name: 'Turns 3–4' }],
      ['S', 250, { auto: true, w: 19 }],
      ['L', 640, 18, { w: 19 }]
    ],
    sectors: [0.36, 0.7],
    scenery: function (c) {
      var r = c.rng, L = c.L;
      // giant main grandstands outside the front stretch & tri-oval (right side = outside)
      for (var s = L - 520; s < L + 260; s += 64) {
        c.add('grandstand', s, -1, 4, { l: 60, w: 34, h: 26, seats: 9000, color: '#c9ced6', accent: '#d42a2a' });
      }
      c.add('tower', L - 40, -1, 44, { l: 16, w: 16, h: 60, text: 'REDLINE', variant: 'scoring-pylon' });
      // grandstands outside turn 1-2 and 3-4
      c.corners.forEach(function (cn) {
        for (var k = 0.15; k < 0.9; k += 0.18) c.add('grandstand', cn.s0 + cn.len * k, -1, 6, { l: 52, w: 22, h: 16, color: '#b9c0c8', accent: '#1e5aa8' });
      });
      // infield: pit garages, media centre, lake, fan zone tents
      c.add('pits', L - 140, 1, 4, { l: 260, w: 18, h: 9, text: 'PIT GARAGES', color: '#e6e6e6', accent: '#d42a2a' });
      c.add('building', L - 140, 1, 34, { l: 70, w: 30, h: 14, variant: 'media', color: '#d8dde3' });
      c.add('water', 760, 1, 70, { r: 48, variant: 'lake', color: '#3f7fb3' });
      c.add('water', 880, 1, 95, { r: 30, variant: 'lake', color: '#3f7fb3' });
      for (var t = 0; t < 10; t++) c.add('tent', 1300 + t * 26, 1, 40 + (t % 2) * 14, { l: 12, w: 12, h: 5, color: r.pick(['#ffffff', '#ffb21e', '#d42a2a', '#1e5aa8']) });
      // billboards on the outer SAFER wall all the way round the back
      for (var b = 330; b < 1700; b += 60) c.add('billboard', b, -1, 0.6, { l: 22, w: 1.0, h: 4, text: r.pick(BRANDS) });
      // parking lots & trees beyond
      c.trees(260, 1750, -1, { spacing: 18, off: 30, depth: 3, rowGap: 12, variants: ['oak', 'pine'], density: 0.75 });
      c.trees(1200, 2000, 1, { spacing: 30, off: 120, depth: 2, variants: ['oak'], density: 0.5 });
      c.row('lamp', 0, L, -1, 80, 2.0, { r: 0.4, h: 30, variant: 'stadium' });
      c.marshals(230, 0.8);
    }
  }));

  /* ---------------- 2. Porto Vecchio — tight harbour street circuit ---------------- */
  defs.push(makeTrack({
    id: 'porto-vecchio', name: 'Porto Vecchio Street Circuit', short: 'Porto Vecchio', country: 'Italy', city: 'Porto Vecchio',
    desc: 'Concrete walls millimetres from the apex. Ninety-degree corners through the old town, a harbour chicane and zero margin for error.',
    difficulty: 4, surface: { grip: 0.96, type: 'street' }, width_m: 11, defaultLaps: 5,
    theme: { grass: '#b3a790', asphalt: '#45474b', kerbA: '#c8102e', kerbB: '#f4f4f4', sand: '#d8c7a0', sky: '#9fd0f5',
      line: '#f0f0f0', wall: '#e8e4dc', barrier: '#c8c2b6', tree: '#4d6b2f', ground: '#b3a790', water: '#2f78a8', accent: '#c8102e', night: false },
    style: { street: true }, wallType: 'concrete', gravel: false,
    kerbs: { width: 0.7, radius: 120, outside: false },
    runoff: { left: 'tarmac', right: 'tarmac' }, barrier: { left: 0.9, right: 0.9 },
    tags: ['walls', 'technical', 'street'],
    layout: [
      ['S', 280, { w: 12 }],
      ['R', 16, 90, { name: 'Curva Duomo' }],
      ['S', 170, { name: 'Via Garibaldi' }],
      ['L', 22, 90, { name: 'Piazza Nuova' }],
      ['S', 150],
      ['R', 15, 90, { name: 'Via Roma' }],
      ['S', 230],
      ['R', 24, 90, { name: 'Fontana' }],
      ['S', 130],
      ['L', 14, 90, { name: 'Mercato', w: 12 }],
      ['S', 110],
      ['R', 18, 90, { name: 'Faro' }],
      ['S', 110],
      ['L', 32, 26, { name: 'Harbour Chicane' }],
      ['R', 32, 52],
      ['L', 32, 26],
      ['S', 357, { auto: true, name: 'Lungomare' }],
      ['R', 20, 90, { name: 'Porto' }],
      ['S', 260, { auto: true, name: 'Galleria' }],
      ['L', 45, 22, { name: 'Tunnel Kink' }],
      ['R', 45, 22],
      ['S', 280, { auto: true }],
      ['R', 26, 90, { name: 'Ultima' }],
      ['S', 220, { w: 12 }]
    ],
    scenery: function (c) {
      var L = c.L;
      var stone = ['#d9cbb0', '#e3d3b8', '#cbb08a', '#e8dcc6', '#d4a77a', '#c98d6a', '#e2c79a', '#f0e4cf'];
      var roofs = ['#b5562f', '#a8492a', '#c06a3e', '#9c4a33'];
      // old town blocks lining both sides of every street
      c.straights.forEach(function (st) {
        c.buildings(st.s0 + 6, st.s1 - 6, 1, { off: 3, lMin: 16, lMax: 34, wMin: 14, wMax: 26, hMin: 9, hMax: 24, colors: stone, accents: roofs, gapMin: 1.5, gapMax: 5 });
        c.buildings(st.s0 + 6, st.s1 - 6, -1, { off: 3, lMin: 16, lMax: 34, wMin: 14, wMax: 26, hMin: 9, hMax: 24, colors: stone, accents: roofs, gapMin: 1.5, gapMax: 5 });
      });
      // grandstands on the start straight & at Curva Duomo
      c.add('grandstand', L - 120, 1, 1.5, { l: 110, w: 14, h: 12, color: '#d0d5dc', accent: '#c8102e' });
      c.add('pits', L - 120, -1, 1.5, { l: 140, w: 12, h: 7, text: 'BOX', color: '#efefef', accent: '#c8102e' });
      c.add('grandstand', 230, -1, 1.5, { l: 50, w: 12, h: 10, color: '#d0d5dc', accent: '#1d5fa0' });
      // harbour: water and yachts beyond the Lungomare + chicane
      var chic = c.corners.filter(function (k) { return k.name === 'Harbour Chicane'; })[0];
      if (chic) {
        for (var s = chic.s0 - 60; s < chic.s0 + 300; s += 45) c.add('water', s, -1, 6, { r: 26, variant: 'harbour', color: '#2f78a8' });
        for (var y = 0; y < 7; y++) c.add('building', chic.s0 + y * 38, -1, 14, { l: 16, w: 5, h: 3, variant: 'yacht', color: '#f7f7f7', accent: '#1d3557' });
      }
      // street furniture
      c.row('lamp', 10, L - 10, 1, 38, 0.4, { r: 0.3, h: 8, variant: 'street' });
      c.row('lamp', 29, L - 10, -1, 38, 0.4, { r: 0.3, h: 8, variant: 'street' });
      c.row('tree', 20, L - 20, 1, 55, 1.2, function () { return { r: c.rng.range(1.6, 2.6), variant: c.rng.pick(['palm', 'cypress']) }; }, 6);
      c.cornerFurniture({ tyreR: 30, boardR: 30, boardDist: 70, countdownBoards: false });
      c.marshals(160, 0.4);
    }
  }));

  /* ---------------- 3. Redline Ring — the 5.8 km Grand Prix circuit ---------------- */
  defs.push(makeTrack({
    id: 'forge-ring', name: 'Redline Ring Grand Prix Circuit', short: 'Redline Ring', country: 'Germany', city: 'Eisenwald',
    desc: 'The home of Redline. 5.8 km of flowing GP circuit: Anvil T1, the Esses, the Hammer hairpin, a 1.1 km back straight into the Foundry chicane and the flat-out Bellows.',
    difficulty: 3, surface: { grip: 1.0, type: 'asphalt' }, width_m: 14, defaultLaps: 3,
    theme: { grass: '#3f7a2f', asphalt: '#35373b', kerbA: '#e10600', kerbB: '#f6f6f6', sand: '#d9c48f', sky: '#8ec5f2',
      line: '#f7f7f7', wall: '#d7d7d7', barrier: '#a2a8ae', tree: '#2c5a26', ground: '#3f7a2f', accent: '#ff6a00', night: false },
    style: {}, wallType: 'armco', gravel: true,
    kerbs: { width: 1.3, radius: 230, outside: true, exitLen: 26, entryLen: 10 },
    runoff: { left: 'grass', right: 'grass' }, barrier: { left: 14, right: 14 },
    tags: ['grand-prix', 'hairpin', 'chicane', 'balanced'],
    scale: 1.33,
    layout: [
      ['S', 420, { w: 15 }],
      ['R', 48, 100, { name: 'Anvil', w: 15 }],
      ['S', 150],
      ['L', 85, 50, { name: 'Esses' }],
      ['R', 80, 75],
      ['L', 95, 45],
      ['S', 330],
      ['R', 165, 55, { name: 'Crucible' }],
      ['S', 520, { auto: true }],
      ['R', 18, 168, { name: 'Hammer Hairpin', w: 16, kerbScale: 1.2, noScale: true }],
      ['S', 240],
      ['L', 42, 90, { name: 'Stadium' }],
      ['S', 170],
      ['R', 34, 95, { name: 'Kessel' }],
      ['S', 150],
      ['L', 60, 96, { name: 'Glut' }],
      ['S', 860, { auto: true, name: 'Long Straight' }],
      ['L', 20, 52, { name: 'Foundry Chicane', w: 14.5, noScale: true }],
      ['R', 20, 52, { noScale: true }],
      ['S', 200],
      ['R', 240, 70, { name: 'Bellows' }],
      ['S', 150, { auto: true }],
      ['R', 78, 78, { name: 'Quench' }],
      ['S', 400, { w: 15 }]
    ],
    sectors: [0.3, 0.64],
    scenery: function (c) {
      var r = c.rng, L = c.L;
      // main grandstands both sides of start/finish, pit building on the right (inside of the loop)
      c.add('pits', L - 160, -1, 4, { l: 300, w: 22, h: 10, text: 'REDLINE RING', color: '#eceff2', accent: '#ff6a00' });
      c.add('tower', L - 30, -1, 30, { l: 14, w: 14, h: 40, variant: 'control-tower', text: 'RACE CONTROL' });
      for (var s = L - 300; s < L + 60; s += 70) c.add('grandstand', s, 1, 3, { l: 64, w: 26, h: 20, color: '#c8cdd4', accent: '#ff6a00', seats: 6000 });
      // spectator grandstands at the big braking zones
      c.corners.forEach(function (cn) {
        if (cn.name === 'Anvil' || cn.name === 'Hammer Hairpin' || cn.name === 'Foundry Chicane' || cn.name === 'Stadium') {
          c.add('grandstand', cn.mid, cn.outside, 4, { l: 70, w: 22, h: 16, color: '#c8cdd4', accent: '#1f4e9a' });
          c.add('grandstand', cn.s0 - 50, cn.outside, 4, { l: 50, w: 18, h: 12, color: '#bfc5cc', accent: '#ff6a00' });
        }
      });
      // forest ("Eisenwald") everywhere else
      c.straights.forEach(function (st) {
        c.trees(st.s0, st.s1, 1, { spacing: 16, off: 6, depth: 3, rowGap: 10, variants: ['pine', 'oak', 'birch'], density: 0.7 });
        c.trees(st.s0, st.s1, -1, { spacing: 16, off: 6, depth: 3, rowGap: 10, variants: ['pine', 'oak', 'birch'], density: 0.7 });
      });
      c.corners.forEach(function (cn) {
        c.trees(cn.s0, cn.s1, cn.outside, { spacing: 18, off: 10, depth: 2, rowGap: 12, variants: ['pine', 'oak'], density: 0.6 });
        c.trees(cn.s0, cn.s1, cn.inside, { spacing: 22, off: 8, depth: 1, variants: ['oak', 'birch'], density: 0.5 });
      });
      c.cornerFurniture({ tyreR: 90, boardR: 130 });
      c.marshals(220, 1.0);
      // hospitality & paddock
      for (var k = 0; k < 6; k++) c.add('tent', L - 260 + k * 34, -1, 36, { l: 24, w: 14, h: 6, color: r.pick(['#ffffff', '#ff6a00', '#20242a']) });
      c.row('billboard', 100, 420, 1, 70, 1.2, function () { return { l: 18, w: 1.0, h: 5, text: r.pick(BRANDS) }; });
    }
  }));

  /* ---------------- 4. Akagane Pass — mountain touge ---------------- */
  defs.push(makeTrack({
    id: 'akagane-pass', name: 'Akagane Pass', short: 'Akagane', country: 'Japan', city: 'Gunma',
    desc: 'A narrow mountain road with guardrails, four hairpin switchbacks up the ridge and a fast, blind descent through the cedars. Precision over power.',
    difficulty: 5, surface: { grip: 0.94, type: 'road' }, width_m: 8.5, defaultLaps: 3,
    theme: { grass: '#3a5f2c', asphalt: '#3b3b3e', kerbA: '#e8e8e8', kerbB: '#c8202a', sand: '#7d6b4f', sky: '#c6d7e6',
      line: '#e9e3c8', wall: '#c9ccd0', barrier: '#b7bcc2', tree: '#23452a', ground: '#3a5f2c', rock: '#7c7468', accent: '#c8202a', night: false },
    style: { touge: true }, wallType: 'guardrail', gravel: false,
    kerbs: { width: 0.6, radius: 70, outside: false },
    runoff: { left: 'grass', right: 'grass' }, barrier: { left: 1.6, right: 1.6 },
    elevation_m: 210, tags: ['narrow', 'hairpins', 'guardrails', 'technical'],
    layout: [
      ['S', 160, { w: 9.5 }],
      ['R', 70, 30],
      ['L', 50, 120, { name: 'Ichi-no-Kawa' }],
      ['S', 130],
      ['L', 28, 90, { name: 'Torii' }],
      ['S', 150],
      ['R', 18, 180, { name: 'Hairpin 1', w: 10 }],
      ['S', 170],
      ['L', 18, 180, { name: 'Hairpin 2', w: 10 }],
      ['S', 170],
      ['R', 18, 180, { name: 'Hairpin 3', w: 10 }],
      ['S', 120],
      ['L', 60, 40],
      ['R', 90, 50, { name: 'Summit Sweep' }],
      ['L', 40, 100, { name: 'Tenbo' }],
      ['S', 90],
      ['R', 22, 180, { name: 'Summit Hairpin', w: 10 }],
      ['S', 80],
      ['R', 80, 40, { name: 'Sugi' }],
      ['L', 60, 80, { name: 'Kaminari' }],
      ['R', 50, 60],
      ['L', 70, 40],
      ['S', 140],
      ['R', 60, 110, { name: 'Kawa' }],
      ['S', 516, { auto: true }],
      ['R', 27.5, 180, { name: 'Shimo Hairpin', w: 10 }],
      ['S', 120, { w: 9.5 }]
    ],
    scenery: function (c) {
      var L = c.L;
      // dense cedar / pine forest on both sides, rocks on the mountain side
      c.trees(0, L, 1, { spacing: 9, off: 1.5, depth: 3, rowGap: 7, variants: ['cedar', 'pine'], density: 0.85, rMin: 2, rMax: 3.6 });
      c.trees(0, L, -1, { spacing: 9, off: 1.5, depth: 3, rowGap: 7, variants: ['cedar', 'pine', 'maple'], density: 0.85, rMin: 2, rMax: 3.6 });
      for (var s = 30; s < L; s += 70) c.add('rock', s + c.rng.range(-20, 20), c.rng.chance(0.5) ? 1 : -1, c.rng.range(1, 6), { r: c.rng.range(1.2, 3.2) });
      // hairpin chevron boards & lamp posts
      c.corners.forEach(function (cn) {
        if (cn.r <= 30) {
          c.add('billboard', cn.mid, cn.outside, 0.4, { l: 12, w: 0.5, h: 1.5, variant: 'chevron', text: '>>>' });
          c.add('lamp', cn.mid, cn.outside, 1.2, { r: 0.3, h: 7, variant: 'road' });
        }
      });
      // start area: tea house, parking and a small torii gate
      c.add('building', L - 60, -1, 4, { l: 22, w: 12, h: 6, variant: 'teahouse', color: '#6b4a32', accent: '#2b2b2b' });
      c.add('building', 70, 1, 4, { l: 30, w: 18, h: 2, variant: 'parking', color: '#55585c' });
      c.add('tower', L - 10, 1, 1.5, { l: 6, w: 1.2, h: 6, variant: 'torii', color: '#c8202a' });
      c.add('tent', L - 110, 1, 3, { l: 8, w: 6, h: 3, color: '#ffffff' });
      c.marshals(260, 0.6);
    }
  }));

  /* ---------------- 5. Little Anvil Kartodromo — short karting track ---------------- */
  defs.push(makeTrack({
    id: 'little-anvil', name: 'Little Anvil Kartodromo', short: 'Little Anvil', country: 'Italy', city: 'Lonato',
    desc: 'A tiny, tight 770 m karting circuit. Hairpins, a double-apex left and constant direction changes — every tenth counts.',
    difficulty: 2, surface: { grip: 1.04, type: 'asphalt' }, width_m: 9, defaultLaps: 8,
    theme: { grass: '#5d9b3d', asphalt: '#2f3134', kerbA: '#d4202a', kerbB: '#f2f2f2', sand: '#cbbb8e', sky: '#9cc9ef',
      line: '#ffffff', wall: '#3a3a3a', barrier: '#2b2b2b', tree: '#3d6f2c', ground: '#5d9b3d', accent: '#ffd400', night: false },
    style: { kart: true }, wallType: 'tyres', gravel: true,
    kerbs: { width: 1.0, radius: 60, outside: true, exitLen: 10, entryLen: 4 },
    runoff: { left: 'grass', right: 'grass' }, barrier: { left: 5, right: 5 },
    tags: ['short', 'tight', 'kart'],
    layout: [
      ['S', 130, { w: 10 }],
      ['R', 12, 120, { name: 'Prima' }],
      ['S', 45],
      ['L', 15, 90, { name: 'Esse' }],
      ['S', 60],
      ['R', 10, 150, { name: 'Tornante', w: 10 }],
      ['S', 75],
      ['L', 14, 60],
      ['R', 14, 90, { name: 'Doppia' }],
      ['S', 55, { auto: true }],
      ['R', 22, 60],
      ['L', 11, 120, { name: 'Cappio' }],
      ['S', 45],
      ['R', 13, 120, { name: 'Ruota' }],
      ['S', 60, { auto: true }],
      ['R', 18, 90, { name: 'Finale' }],
      ['S', 70, { w: 10 }]
    ],
    scenery: function (c) {
      var L = c.L, r = c.rng;
      // tyre wall along all slow corners, kart paddock, clubhouse
      c.cornerFurniture({ tyreR: 25, boardR: 0, countdownBoards: false, tyreColor: '#1d1d1d' });
      c.add('pits', L - 60, 1, 3, { l: 90, w: 12, h: 5, text: 'KART PADDOCK', color: '#f2f2f2', accent: '#ffd400' });
      c.add('building', L - 60, 1, 20, { l: 34, w: 16, h: 7, variant: 'clubhouse', color: '#e9e1d2', accent: '#b5562f' });
      c.add('grandstand', 60, -1, 2, { l: 40, w: 10, h: 6, color: '#cfd4da', accent: '#ffd400' });
      c.add('tower', L - 15, -1, 2, { l: 5, w: 5, h: 8, variant: 'timing', text: 'TIMING' });
      for (var k = 0; k < 8; k++) c.add('tent', L - 110 + k * 13, 1, 16, { l: 9, w: 9, h: 3, color: r.pick(['#ffd400', '#e10600', '#2a6fdb', '#ffffff']) });
      c.trees(0, L, 1, { spacing: 20, off: 6, depth: 1, variants: ['poplar', 'oak'], density: 0.6 });
      c.trees(0, L, -1, { spacing: 20, off: 6, depth: 1, variants: ['poplar', 'oak'], density: 0.6 });
      c.row('billboard', 20, 120, -1, 30, 0.5, function () { return { l: 8, w: 0.6, h: 2, text: r.pick(BRANDS) }; });
    }
  }));

  /* ---------------- 6. Neon Harbour — night city circuit ---------------- */
  defs.push(makeTrack({
    id: 'neon-harbour', name: 'Neon Harbour Night Circuit', short: 'Neon Harbour', country: 'Singapore', city: 'Marina Bay',
    desc: 'Floodlit boulevards between glass towers, a sweeping bayfront section and walls everywhere. Built for night racing.',
    difficulty: 4, surface: { grip: 0.98, type: 'street' }, width_m: 12.5, defaultLaps: 4, timeOfDay: 'night',
    theme: { grass: '#1a1e29', asphalt: '#2b2d34', kerbA: '#ff2bd6', kerbB: '#f0f0f8', sand: '#3a3f4f', sky: '#070914',
      line: '#e8f4ff', wall: '#c9ccd6', barrier: '#5b6070', tree: '#1f3b2f', ground: '#1a1e29', water: '#0b2440',
      glow: '#2bf3ff', accent: '#ff2bd6', night: true },
    style: { street: true, night: true }, wallType: 'concrete', gravel: false,
    kerbs: { width: 0.8, radius: 140, outside: false },
    runoff: { left: 'tarmac', right: 'tarmac' }, barrier: { left: 1.1, right: 1.1 },
    tags: ['night', 'walls', 'street', 'city'],
    layout: [
      ['S', 480, { w: 13.5, name: 'Neon Boulevard' }],
      ['L', 18, 90, { name: 'Casino' }],
      ['S', 220],
      ['R', 22, 90, { name: 'Raffles' }],
      ['S', 180],
      ['L', 24, 90, { name: 'Esplanade' }],
      ['S', 300, { auto: true }],
      ['L', 32, 90, { name: 'Bayfront' }],
      ['S', 200],
      ['R', 120, 50, { name: 'Marina Sweep' }],
      ['L', 95, 50],
      ['S', 478, { auto: true, name: 'Harbour Drive' }],
      ['L', 20, 90, { name: 'Lantern' }],
      ['S', 160],
      ['R', 18, 90, { name: 'Pagoda' }],
      ['S', 150],
      ['L', 26, 90, { name: 'Skyline' }],
      ['S', 424, { auto: true }],
      ['L', 45, 90, { name: 'Neon Curve' }],
      ['S', 320, { w: 13.5 }]
    ],
    scenery: function (c) {
      var L = c.L, r = c.rng;
      var glass = ['#1b2333', '#202b40', '#151b28', '#26324a', '#1d2638', '#2a2140'];
      var neon = ['#2bf3ff', '#ff2bd6', '#ffd23f', '#7cff6b', '#9b5cff', '#ff6b3d'];
      c.straights.forEach(function (st) {
        c.buildings(st.s0 + 8, st.s1 - 8, 1, { off: 4, lMin: 22, lMax: 55, wMin: 20, wMax: 45, hMin: 40, hMax: 220, colors: glass, accents: neon, lit: true, gapMin: 4, gapMax: 12 });
        c.buildings(st.s0 + 8, st.s1 - 8, -1, { off: 4, lMin: 22, lMax: 55, wMin: 20, wMax: 45, hMin: 40, hMax: 220, colors: glass, accents: neon, lit: true, gapMin: 4, gapMax: 12 });
      });
      // floodlights both sides every 32 m (alternating)
      c.row('lamp', 0, L, 1, 32, 0.5, { r: 0.35, h: 16, variant: 'flood', lit: true, color: '#fff4d6' });
      c.row('lamp', 16, L, -1, 32, 0.5, { r: 0.35, h: 16, variant: 'flood', lit: true, color: '#fff4d6' });
      // bay water outside the bayfront / marina sweep
      var bay = c.corners.filter(function (k) { return k.name === 'Marina Sweep'; })[0];
      if (bay) for (var s = bay.s0 - 220; s < bay.s1 + 380; s += 50) c.add('water', s, 1, 8, { r: 30, variant: 'bay', color: '#0b2440' });
      // grandstands + pit complex on the boulevard
      c.add('pits', L - 200, 1, 2, { l: 260, w: 16, h: 9, text: 'NEON HARBOUR', color: '#1d2333', accent: '#2bf3ff', lit: true });
      for (var g = 0; g < 4; g++) c.add('grandstand', L - 330 + g * 62, -1, 2, { l: 56, w: 16, h: 14, color: '#2a3042', accent: '#ff2bd6', lit: true });
      c.add('tower', L - 40, -1, 26, { l: 30, w: 30, h: 165, variant: 'observation-wheel', color: '#c9ccd6', accent: '#2bf3ff', lit: true });
      // LED billboards on the walls
      for (var b = 120; b < L; b += 140) c.add('billboard', b, r.chance(0.5) ? 1 : -1, 0.4, { l: 24, w: 1, h: 6, text: r.pick(BRANDS), lit: true, color: r.pick(neon) });
      c.row('tree', 40, L - 40, -1, 75, 1.3, function () { return { r: r.range(1.6, 2.4), variant: 'palm' }; }, 8);
      c.cornerFurniture({ tyreR: 30, boardR: 0, countdownBoards: false, tyreColor: '#ff2bd6' });
      c.marshals(200, 0.4);
    }
  }));

  /* ---------------- 7. Ouroboros — figure-8 with a bridge ---------------- */
  defs.push(makeTrack({
    id: 'ouroboros', name: 'Ouroboros Figure-8', short: 'Ouroboros', country: 'United Kingdom', city: 'Wolds',
    desc: 'A figure-8 that crosses itself on a steel bridge. A left-handed loop and a right-handed loop: tyres wear evenly, drivers do not.',
    difficulty: 2, surface: { grip: 1.0, type: 'asphalt' }, width_m: 13, defaultLaps: 5,
    theme: { grass: '#4c7c34', asphalt: '#3a3c40', kerbA: '#f2c200', kerbB: '#1b1b1b', sand: '#d2bd88', sky: '#a9c9e8',
      line: '#ffffff', wall: '#d6d6d6', barrier: '#9aa0a6', tree: '#2e5a2a', ground: '#4c7c34', bridge: '#7d848c', accent: '#f2c200', night: false },
    style: { figure8: true }, wallType: 'armco', gravel: true, crossing: 'bridge', bridgeUpper: 'second',
    kerbs: { width: 1.2, radius: 160, outside: true },
    runoff: { left: 'grass', right: 'grass' }, barrier: { left: 9, right: 9 },
    tags: ['figure-8', 'bridge', 'flowing'],
    layout: [
      ['S', 160, { w: 14 }],
      ['L', 55, 90, { name: 'Coil' }],
      ['S', 130],
      ['L', 50, 90, { name: 'Scale' }],
      ['S', 312, { auto: true }],
      ['L', 65, 45],
      ['S', 300, { auto: true, name: 'Bridge Straight' }],
      ['R', 50, 90, { name: 'Fang' }],
      ['S', 150],
      ['R', 55, 90, { name: 'Tail' }],
      ['S', 110],
      ['R', 65, 90],
      ['S', 348, { auto: true, name: 'Underpass' }],
      ['L', 65, 45, { name: 'Return' }],
      ['S', 120, { w: 14 }]
    ],
    heading0: 0,
    scenery: function (c) {
      var L = c.L, r = c.rng;
      c.add('pits', L - 90, -1, 4, { l: 150, w: 16, h: 8, text: 'OUROBOROS', color: '#e9e9e9', accent: '#f2c200' });
      c.add('grandstand', L - 90, 1, 3, { l: 120, w: 20, h: 14, color: '#c8cdd4', accent: '#f2c200' });
      c.corners.forEach(function (cn) {
        c.trees(cn.s0, cn.s1, cn.outside, { spacing: 16, off: 6, depth: 2, rowGap: 10, variants: ['oak', 'ash'], density: 0.7 });
      });
      c.straights.forEach(function (st) {
        c.trees(st.s0, st.s1, 1, { spacing: 22, off: 8, depth: 1, variants: ['oak', 'ash'], density: 0.5 });
        c.trees(st.s0, st.s1, -1, { spacing: 22, off: 8, depth: 1, variants: ['oak', 'ash'], density: 0.5 });
      });
      c.cornerFurniture({ tyreR: 60, boardR: 70 });
      c.marshals(200, 0.9);
      for (var k = 0; k < 5; k++) c.add('tent', L - 200 + k * 22, -1, 26, { l: 16, w: 12, h: 5, color: r.pick(['#ffffff', '#f2c200', '#1b1b1b']) });
    }
  }));

  var byId = {};
  defs.forEach(function (d) { byId[d.id] = d; });

  function get(id) { return byId[id] || null; }
  function geometry(id) { var d = get(id); return d ? build(d) : null; }

  /** Canvas-space preview polyline for track cards: fits the circuit into w×h with padding. */
  function previewPath(defOrGeom, w, h, pad) {
    var geom = defOrGeom && defOrGeom.samples ? defOrGeom : build(defOrGeom);
    pad = pad == null ? 6 : pad;
    var b = geom.bounds.track;
    var sc = Math.min((w - pad * 2) / b.width, (h - pad * 2) / b.height);
    var ox = (w - b.width * sc) / 2, oy = (h - b.height * sc) / 2;
    return geom.minimap.map(function (p) {
      return [round2(ox + (p[0] - b.minX) * sc), round2(h - (oy + (p[1] - b.minY) * sc))];
    });
  }

  return {
    list: defs,
    ids: defs.map(function (d) { return d.id; }),
    byId: byId,
    get: get,
    build: build,
    geometry: geometry,
    project: project,
    speedProfile: speedProfile,
    lapTime: lapTime,
    pointAt: pointAt,
    indexAt: indexAt,
    validate: validate,
    previewPath: previewPath,
    turtle: turtle,
    makeTrack: makeTrack,
    splineLength: splineLength,
    SAMPLE_SPACING: SAMPLE_SPACING
  };
})();

if (typeof module !== 'undefined') module.exports = CB.race.tracks;

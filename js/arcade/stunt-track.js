/* ==========================================================================
   Redline — js/arcade/stunt-track.js
   CB.arcade.stunt : 3D STUNT TRACK format + builder (Hot-Wheels style: loops, corkscrews, wall-rides, banked bowls,
   drops, kickers and GAPS). Pure logic (no DOM / GL), Node-loadable, deterministic.

   World axes = the GL renderer's: +Y up, metres. Heading 0 = +X, positive yaw = LEFT (counter-clockwise from above).

   Track definition (authored in js/arcade/stunt-maps.js)
     { id, name, theme 'stadium'|'canyon'|'neon'|'toybox'|..., laps, width (m, default 12), startAt (m into the
       piece list where the start line sits, default 80), blurb, difficulty,
       start { pos [x,y,z], heading (rad) },
       pieces: [ piece... ]   — turtle-graphics pieces; the builder appends an automatic C1 closing piece
                               (Hermite position + rotation-minimising frame with the residual roll spread out)
     }
   Pieces (every piece may carry width, bank (deg, + = up vector leans LEFT), flags [names], features [...]):
     straight {len}                      turn {angle (deg, + = left), radius, bank?, rise? (m gained over the turn)}
     hill {len, height}  (cosine bump)   drop {len, height}  climb {len, height}  (smooth S-shaped height change)
     pitchTo {angle (deg), len}          (eased pitch change: kickers, landing run-outs)
     kicker {len, angle}                 (= pitchTo, flagged ramp: launch lip at its end)
     gap {len (horizontal m), drop (m, + = land lower)}  ballistic arc for the design speed (no surface; flag gap)
     loop {radius, shift (m sideways, + = right; default width + 2)}
     corkscrew {len, radius, turns (default 1), dir (+1 roll right / -1 left)}
     wall {len, bank (deg), side (+1 left wall up / -1 right)} (straight wall-ride with a lifted lower edge)
   Piece features (s is relative to the piece: `at` 0..1 of its length, or `s` metres):
     {type:'pad', at, lat, len?, w?}  boost pad        {type:'ring', at, lat, z?, r?}  boost ring (z = height above)
     {type:'box', at, lats:[...]|count} item-box row   {type:'can', at, lat}           nitro canister
     {type:'coin', at, lat, n?, spacing?}              {type:'checkpoint', at}         {type:'arrow', at, side}

   Built track (CB.arcade.stunt.build(def) / get(id); cached):
     { id, name, theme, def, length L, N, DS (1 m sample spacing), laps,
       sample(s, out?) -> {s, pos, tangent, right, up, left, width, halfWidth, bank, flags, kLeft, kNormal, index}
       pointAt(s, lateral, height, out?) -> [x,y,z]   (lateral + = LEFT, like CB.race.tracks)
       project(worldPos, opts {hintS, window, maxDist, surfaceOnly}) -> {s, lateral, height, index, dist} | null
       has(s, flagName) -> bool, flagsAt(s) -> int, designSpeedAt(s), features [], checkpoints [{s, index}],
       gaps [{s0, s1, designSpeed, takeoffS, landS}], pieces [{type, s0, s1}], groundY, bounds {min, max},
       minimap {points [[x, y]...] (top-down, y = -z), bounds}, thumbnail() -> SVG string,
       geom2D (CB.race.hud / 2D minimap compatible: {samples [{x, y, heading, s, width, curvature}], length, start}) }
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.arcade = CB.arcade || {};
CB.arcade.stunt = CB.arcade.stunt || {};

(function (S) {
  'use strict';

  var PI = Math.PI, TAU = PI * 2, DEG = PI / 180;
  var DS = 1;                 // uniform sample spacing (m)
  var RAW = 0.25;             // turtle micro-step (m)
  var G = 9.81;
  var G_AIR = 1.45 * G;       // arcade flight gravity (shared with stunt-physics)

  var FLAG_NAMES = ['gap', 'ramp', 'landing', 'loop', 'cork', 'wall', 'bowl', 'jump', 'boost', 'start', 'checkpoint', 'rails', 'noRespawn', 'tunnel',
    'tube', 'zerog', 'halfpipe', 'warp', 'cannon', 'split', 'belt', 'hazard'];
  var FLAGS = {};
  FLAG_NAMES.forEach(function (n, i) { FLAGS[n] = 1 << i; });
  // flags that make a spot unsafe for respawns / grid / AI braking
  var UNSAFE = FLAGS.gap | FLAGS.ramp | FLAGS.landing | FLAGS.loop | FLAGS.cork | FLAGS.wall | FLAGS.jump | FLAGS.noRespawn | FLAGS.warp | FLAGS.cannon | FLAGS.split | FLAGS.hazard;

  /* ---------------------------------------------------------------- tiny vec3 (plain arrays) */
  function v3(x, y, z) { return [x, y, z]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function madd(a, b, s) { return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
  function norm(a) { var l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  /** Rodrigues rotation of v about unit axis k by angle a. */
  function rot(v, k, a) {
    var c = Math.cos(a), s = Math.sin(a), kv = cross(k, v), kd = dot(k, v) * (1 - c);
    return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
  }
  /** Orthonormalise u against unit t. */
  function ortho(u, t) { return norm(madd(u, t, -dot(u, t))); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function smooth(u) { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); }
  function smoother(u) { u = clamp(u, 0, 1); return u * u * u * (u * (u * 6 - 15) + 10); }
  function wrapS(s, L) { s = s % L; return s < 0 ? s + L : s; }
  function wrapD(d, L) { d = wrapS(d, L); return d > L / 2 ? d - L : d; }
  var WY = [0, 1, 0];

  /* ======================================================================
     Turtle: position p, forward t, base up n (no authored roll). Records raw samples.
     ====================================================================== */
  function Turtle(pos, heading) {
    this.p = pos.slice();
    this.t = [Math.cos(heading), 0, -Math.sin(heading)];
    this.n = [0, 1, 0];
    this.raw = [];
    this.piece = -1;
    this.width = 12;
    this.bank = 0;
    this.flags = 0;
    this.lift = 0;
    this.design = 0;
  }
  Turtle.prototype.right = function () { return cross(this.t, this.n); };
  Turtle.prototype.rec = function () {
    this.raw.push({ p: this.p.slice(), n: this.n.slice(), t: this.t.slice(), w: this.width, bank: this.bank, flags: this.flags, piece: this.piece, lift: this.lift, design: this.design, jump: this.jumpNext || false });
    this.jumpNext = false;
  };
  /** Advance ds with rotations split around the move (midpoint rule). yawW = yaw about WORLD up (rad),
      pitch about the right axis, twist about the forward axis. */
  Turtle.prototype.step = function (ds, yawW, pitch, twist, shift) {
    this.rotate(yawW * 0.5, pitch * 0.5, twist * 0.5);
    this.p = madd(this.p, this.t, ds);
    if (shift) this.p = madd(this.p, this.right(), shift);
    this.rotate(yawW * 0.5, pitch * 0.5, twist * 0.5);
    this.rec();
  };
  Turtle.prototype.rotate = function (yawW, pitch, twist) {
    if (yawW) { this.t = rot(this.t, WY, yawW); this.n = rot(this.n, WY, yawW); }
    if (pitch) { var b = this.right(); this.t = rot(this.t, b, pitch); this.n = rot(this.n, b, pitch); }
    if (twist) { this.n = rot(this.n, this.t, twist); }
    this.n = ortho(this.n, this.t);
  };
  Turtle.prototype.pitchAngle = function () { return Math.asin(clamp(this.t[1], -1, 1)); };

  /* ======================================================================
     Pieces
     ====================================================================== */
  function nSteps(L) { return Math.max(1, Math.ceil(L / RAW)); }

  var PIECES = {
    straight: function (T, pc) {
      var L = num(pc.len, 20), n = nSteps(L);
      for (var i = 0; i < n; i++) T.step(L / n, 0, 0, 0);
      return L;
    },
    turn: function (T, pc) {
      var ang = num(pc.angle, 90) * DEG, R = Math.max(4, num(pc.radius, 40)), L = Math.abs(ang) * R, n = nSteps(L);
      var rise = num(pc.rise, 0), p0 = T.pitchAngle();
      var pmax = rise ? Math.asin(clamp(rise * PI / (2 * L), -0.6, 0.6)) : 0;
      var prev = 0;
      for (var i = 0; i < n; i++) {
        var u = (i + 1) / n, want = pmax * Math.sin(PI * u), dp = want - prev;
        prev = want;
        T.step(L / n, ang / n, dp, 0);
      }
      if (rise) T.rotate(0, p0 - T.pitchAngle(), 0);
      return L;
    },
    pitchTo: function (T, pc) {
      var L = num(pc.len, 30), n = nSteps(L), a0 = T.pitchAngle(), a1 = num(pc.angle, 0) * DEG, prev = a0;
      for (var i = 0; i < n; i++) {
        var want = a0 + (a1 - a0) * smooth((i + 1) / n), dp = want - prev;
        prev = want;
        T.step(L / n, 0, dp, 0);
      }
      return L;
    },
    hill: function (T, pc) { return heightProfile(T, num(pc.len, 40), function (u) { return num(pc.height, 4) * (1 - Math.cos(TAU * u)) / 2; }); },
    drop: function (T, pc) { return heightProfile(T, num(pc.len, 60), function (u) { return -num(pc.height, 10) * (1 - Math.cos(PI * u)) / 2; }); },
    climb: function (T, pc) { return heightProfile(T, num(pc.len, 60), function (u) { return num(pc.height, 10) * (1 - Math.cos(PI * u)) / 2; }); },
    loop: function (T, pc) {
      var R = Math.max(6, num(pc.radius, 13)), L = TAU * R, n = nSteps(L);
      var shift = num(pc.shift, T.width + 2);
      for (var i = 0; i < n; i++) {
        // lateral shift eased so the loop entry / exit stay tangent-continuous
        var u0 = i / n, u1 = (i + 1) / n, dsh = shift * (smooth(u1) - smooth(u0));
        T.step(L / n, 0, TAU / n, 0, dsh);
      }
      T.info = { radius: R };
      return L;
    },
    corkscrew: function (T, pc) {
      // helix around an axis ABOVE the car (radius r): the surface faces the axis (inside of a tube), so the car is
      // upside down halfway. Twist eased (zero rate at both ends) => curvature-continuous entry / exit.
      var Lx = num(pc.len, 70), r = num(pc.radius, 7), turns = num(pc.turns, 1), dir = pc.dir < 0 ? -1 : 1;
      var A = T.t.slice(), n0 = T.n.slice(), C = madd(T.p, T.n, r), p0 = T.p.slice();
      var phiTot = TAU * turns * dir, steps = nSteps(Lx * 1.6), total = 0, prevP = T.p.slice();
      for (var i = 1; i <= steps; i++) {
        var u = i / steps, phi = phiTot * (u - Math.sin(TAU * u) / TAU);
        var rel = rot(sub(p0, C), A, phi);
        var p = add(add(C, rel), mul(A, Lx * u));
        var nn = rot(n0, A, phi);
        var tt = norm(sub(p, prevP));
        total += len(sub(p, prevP));
        prevP = p;
        T.p = p; T.t = tt; T.n = ortho(nn, tt);
        T.rec();
      }
      T.t = A.slice(); T.n = ortho(rot(n0, A, phiTot), A);
      return total;
    },
    gap: function (T, pc) {
      // ballistic arc for the design speed: horizontal distance D, landing `drop` metres below the lip
      var D = Math.max(4, num(pc.len, 25)), drop = num(pc.drop, 2);
      var a = T.pitchAngle(), ca = Math.cos(a), denom = 2 * ca * ca * (D * Math.tan(a) + drop);
      var v = denom > 0.01 ? Math.sqrt(G_AIR * D * D / denom) : 40;
      if (pc.speed) v = num(pc.speed, v);
      var h = norm([T.t[0], 0, T.t[2]]), b = norm(cross(h, WY)), vh = v * ca, vy = v * Math.sin(a);
      var tEnd = D / vh, steps = Math.max(8, Math.ceil(D / RAW)), p0 = T.p.slice(), total = 0, prev = p0;
      T.design = v;
      for (var i = 1; i <= steps; i++) {
        var t = tEnd * i / steps;
        var p = add(p0, add(mul(h, vh * t), [0, vy * t - 0.5 * G_AIR * t * t, 0]));
        var vel = add(mul(h, vh), [0, vy - G_AIR * t, 0]);
        var tt = norm(vel);
        total += len(sub(p, prev)); prev = p;
        T.p = p; T.t = tt; T.n = norm(cross(b, tt));
        T.rec();
      }
      return total;
    },
    wall: function (T, pc) {
      var L = num(pc.len, 60), n = nSteps(L);
      for (var i = 0; i < n; i++) T.step(L / n, 0, 0, 0);
      return L;
    },
    /** barrel-roll tube: a corkscrew (helix inside a tube of radius r around an axis above the car) with a rendered tube
        cage; turns 1 or 2 (double barrel roll). Info for the renderer: axisStart, axisDir, radius, turns. */
    tube: function (T, pc) {
      var r = num(pc.radius, 7), A = T.t.slice(), C = madd(T.p, T.n, r);
      var Lt = PIECES.corkscrew(T, { len: num(pc.len, 80), radius: r, turns: num(pc.turns, 1), dir: pc.dir });
      T.info = { axisStart: C, axisDir: A, radius: r, turns: num(pc.turns, 1), axisLen: num(pc.len, 80) };
      return Lt;
    },
    /** zero-g stretch loop: half loop up, an inverted ceiling run of `len` m (upside down at 2R), half loop down; the
        lateral `shift` is eased over the whole piece (like a loop) so the exit runs beside the entry. */
    zerog: function (T, pc) {
      var R = Math.max(8, num(pc.radius, 14)), Ls = Math.max(0, num(pc.len, 60)), shift = num(pc.shift, T.width + 2);
      var L1 = PI * R, tot = 2 * L1 + Ls, n1 = nSteps(L1), n2 = nSteps(Ls), a = 0, i;
      function sh(x) { return shift * smooth(x / tot); }
      var p0 = T.p.slice(), t0 = T.t.slice(), n0 = T.n.slice();
      for (i = 0; i < n1; i++) { T.step(L1 / n1, 0, PI / n1, 0, sh(a + L1 / n1) - sh(a)); a += L1 / n1; }
      var cs = T.p.slice();
      for (i = 0; i < n2; i++) { T.step(Ls / n2, 0, 0, 0, sh(a + Ls / n2) - sh(a)); a += Ls / n2; }
      var ce = T.p.slice();
      for (i = 0; i < n1; i++) { T.step(L1 / n1, 0, PI / n1, 0, sh(a + L1 / n1) - sh(a)); a += L1 / n1; }
      T.info = { radius: R, ceilLen: Ls, ceilStart: cs, ceilEnd: ce, entry: p0, entryFwd: t0, entryUp: n0 };
      return tot;
    },
    /** half-pipe slalom: a wide channel whose bank swings ±bank `waves` times (the car rides up alternate walls); the
        centre line is lifted like a wall-ride so the low edge stays near the base height. */
    halfpipe: function (T, pc) {
      var L = num(pc.len, 160), n = nSteps(L), B = num(pc.bank, 55), wv = num(pc.waves, 1.5), sg = pc.dir < 0 ? -1 : 1;
      for (var i = 0; i < n; i++) {
        var u = (i + 0.5) / n, env = smooth(Math.min(1, u * 6)) * smooth(Math.min(1, (1 - u) * 6));
        T.bank = sg * B * Math.sin(TAU * wv * u) * (0.35 + 0.65 * env);
        T.step(L / n, 0, 0, 0);
      }
      T.bank = 0;
      T.info = { bank: B, waves: wv };
      return L;
    },
    /** cannon: a steep launcher ramp (`angle` deg over `ramp` m) firing the car on a FIXED ballistic arc (every car leaves
        at exactly the design speed: crawling or Mega Nitro) over `len` m to a landing deck `drop` m lower. */
    cannon: function (T, pc) {
      var f0 = T.flags, a0 = 0;
      T.flags = f0 | FLAGS.ramp | FLAGS.cannon;
      a0 = PIECES.pitchTo(T, { len: num(pc.ramp, 26), angle: num(pc.angle, 30) });
      T.flags = f0 | FLAGS.gap | FLAGS.cannon;
      var g = PIECES.gap(T, { len: num(pc.len, 110), drop: num(pc.drop, 0), speed: pc.speed });
      T.flags = f0;
      T.info = { rampLen: num(pc.ramp, 26), angle: num(pc.angle, 30), designSpeed: T.design };
      return a0 + g;
    },
    /** warp portal: a 3 m portal mouth, then the road continues at `to` (absolute [x,y,z]) or `by` (relative offset),
        heading `heading` (deg, default: unchanged), level. Track space stays continuous (s += ~1 m); only the world
        position jumps. */
    warp: function (T, pc) {
      var f0 = T.flags;
      T.flags = f0 | FLAGS.warp;
      for (var i = 0; i < 12; i++) T.step(0.25, 0, 0, 0);
      var from = T.p.slice(), fromT = T.t.slice();
      var to = Array.isArray(pc.to) ? pc.to.slice() : add(T.p, Array.isArray(pc.by) ? pc.by : [0, 0, 0]);
      var hd = pc.heading != null ? num(pc.heading, 0) * DEG : Math.atan2(-T.t[2], T.t[0]);
      T.p = to; T.t = [Math.cos(hd), 0, -Math.sin(hd)]; T.n = [0, 1, 0];
      T.jumpNext = true;
      T.rec();
      for (i = 0; i < 12; i++) T.step(0.25, 0, 0, 0);
      T.flags = f0;
      T.info = { from: from, fromFwd: fromT, to: to.slice(), toFwd: T.t.slice() };
      return 6;
    }
  };
  PIECES.kicker = PIECES.pitchTo;
  function heightProfile(T, L, h) {
    var n = nSteps(L), prev = T.pitchAngle(), base = prev;
    for (var i = 0; i < n; i++) {
      var u = (i + 1) / n, du = 1e-3;
      var slope = (h(Math.min(1, u + du)) - h(Math.max(0, u - du))) / (L * (Math.min(1, u + du) - Math.max(0, u - du)));
      var want = base + Math.atan(slope), dp = want - prev;
      prev = want;
      T.step(L / n, 0, dp, 0);
    }
    T.rotate(0, base - T.pitchAngle(), 0);
    return L;
  }
  var PIECE_FLAGS = { gap: FLAGS.gap, kicker: FLAGS.ramp, loop: FLAGS.loop, corkscrew: FLAGS.cork, wall: FLAGS.wall, hill: FLAGS.jump,
    tube: FLAGS.cork | FLAGS.tube, zerog: FLAGS.loop | FLAGS.zerog, halfpipe: FLAGS.wall | FLAGS.halfpipe };

  /* ======================================================================
     Closing piece: cubic Hermite from the turtle's end pose to the start pose (C1), rotation-minimising frames
     (double reflection, Wang et al. 2008) with the residual roll mismatch distributed linearly.
     ====================================================================== */
  function closeLoop(T, p1, t1, n1) {
    var p0 = T.p.slice(), t0 = T.t.slice(), d = len(sub(p1, p0));
    if (d < 0.5) return 0;
    var k = d * 1.0, m0 = mul(t0, k), m1 = mul(t1, k);
    function H(u) {
      var u2 = u * u, u3 = u2 * u;
      return add(add(mul(p0, 2 * u3 - 3 * u2 + 1), mul(m0, u3 - 2 * u2 + u)), add(mul(p1, -2 * u3 + 3 * u2), mul(m1, u3 - u2)));
    }
    var steps = Math.max(8, Math.ceil(d * 1.6 / RAW)), pts = [], i;
    for (i = 0; i <= steps; i++) pts.push(H(i / steps));
    var tans = pts.map(function (p, j) { return norm(sub(pts[Math.min(steps, j + 1)], pts[Math.max(0, j - 1)])); });
    tans[0] = t0; tans[steps] = t1;
    // double-reflection RMF
    var ups = [T.n.slice()];
    for (i = 0; i < steps; i++) {
      var v1 = sub(pts[i + 1], pts[i]), c1 = dot(v1, v1) || 1e-9;
      var rL = madd(ups[i], v1, -2 / c1 * dot(v1, ups[i])), tL = madd(tans[i], v1, -2 / c1 * dot(v1, tans[i]));
      var v2 = sub(tans[i + 1], tL), c2 = dot(v2, v2) || 1e-9;
      ups.push(ortho(madd(rL, v2, -2 / c2 * dot(v2, rL)), tans[i + 1]));
    }
    // residual twist vs the start frame
    var nEnd = ups[steps], tw = Math.atan2(dot(cross(nEnd, n1), t1), dot(nEnd, n1)), total = 0;
    for (i = 1; i <= steps; i++) {
      var u = i / steps;
      total += len(sub(pts[i], pts[i - 1]));
      T.p = pts[i]; T.t = tans[i]; T.n = ortho(rot(ups[i], tans[i], tw * u), tans[i]);
      T.rec();
    }
    return total;
  }

  /* ======================================================================
     Build
     ====================================================================== */
  var cache = {};

  /** Turtle-only pass (no resampling): end pose of the piece list. */
  function endPose(def, pieces) {
    var st = def.start || {};
    var T = new Turtle(st.pos || [0, 0, 0], num(st.heading, 0));
    T.width = num(def.width, 12);
    T.rec = function () {};
    pieces.forEach(function (pc) { T.width = num(pc.width, num(def.width, 12)); PIECES[pc.type](T, pc); });
    return { p: T.p, t: T.t };
  }
  /**
   * Auto-closure (authoring aid, deterministic): def.solve = { vars: [[pieceIndex, 'len'|'radius'|'rise'|'height'], ...]
   * (1..3 of them), gap (m, default 50) }. Newton iterations on the turtle end pose so the last piece ends `gap`
   * metres before the start line pose, laterally aligned (and level when 3 vars are given). Returns solved pieces.
   */
  function solvePieces(def) {
    var pieces = def.pieces.map(function (p) { var o = {}; for (var k in p) o[k] = p[k]; return o; });
    var sv = def.solve;
    if (!sv || !Array.isArray(sv.vars) || !sv.vars.length) return pieces;
    var vars = sv.vars.slice(0, 3), gap = num(sv.gap, 50), st = def.start || {}, sp = st.pos || [0, 0, 0], hd = num(st.heading, 0);
    var fwd = [Math.cos(hd), 0, -Math.sin(hd)], left = [-Math.sin(hd), 0, -Math.cos(hd)];
    function err() {
      var e = endPose(def, pieces), rel = sub(sp, e.p);
      return [dot(rel, fwd) - gap, dot(rel, left), rel[1]].slice(0, vars.length);
    }
    var lo = { len: 5, radius: 8, rise: -60, height: -80 }, hi = { len: 1500, radius: 400, rise: 60, height: 80 };
    for (var it = 0; it < 14; it++) {
      var f = err(), e2 = 0, k, j;
      for (k = 0; k < f.length; k++) e2 += f[k] * f[k];
      if (e2 < 1e-4) break;
      var n = vars.length, A = [], h = 0.5;
      for (k = 0; k < n; k++) A.push(new Array(n + 1));
      for (j = 0; j < n; j++) {
        var pc = pieces[vars[j][0]], key = vars[j][1];
        pc[key] = num(pc[key], 0) + h;
        var f2 = err();
        pc[key] -= h;
        for (k = 0; k < n; k++) A[k][j] = (f2[k] - f[k]) / h;
      }
      for (k = 0; k < n; k++) A[k][n] = -f[k];
      for (var c = 0; c < n; c++) {
        var pv = c;
        for (var r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
        var tmp = A[c]; A[c] = A[pv]; A[pv] = tmp;
        if (Math.abs(A[c][c]) < 1e-9) continue;
        for (r = 0; r < n; r++) if (r !== c) { var m = A[r][c] / A[c][c]; for (var q = c; q <= n; q++) A[r][q] -= m * A[c][q]; }
      }
      for (j = 0; j < n; j++) {
        if (Math.abs(A[j][j]) < 1e-9) continue;
        var pc2 = pieces[vars[j][0]], key2 = vars[j][1];
        pc2[key2] = clamp(num(pc2[key2], 0) + clamp(A[j][n] / A[j][j], -120, 120), lo[key2] != null ? lo[key2] : -1e4, hi[key2] != null ? hi[key2] : 1e4);
      }
    }
    return pieces;
  }

  function build(def, opts) {
    opts = opts || {};
    if (!def || !Array.isArray(def.pieces) || !def.pieces.length) throw new Error('stunt.build: invalid track definition');
    if (def.id && cache[def.id] && cache[def.id].def === def && !opts.noCache) return cache[def.id];
    var pieces = solvePieces(def);
    var st = def.start || {};
    var T = new Turtle(st.pos || [0, 0, 0], num(st.heading, 0));
    var W0 = num(def.width, 12);
    T.width = W0;
    T.rec();
    var pieceInfo = [], rawFeatures = [], arcAt = [0];
    function rawLen() {
      var r = T.raw, a = arcAt[arcAt.length - 1];
      for (var j = arcAt.length; j < r.length; j++) { a += r[j].jump ? RAW : len(sub(r[j].p, r[j - 1].p)); arcAt.push(a); }
      return a;
    }
    pieces.forEach(function (pc, idx) {
      var fn = PIECES[pc.type];
      if (!fn) throw new Error('stunt.build: unknown piece ' + pc.type);
      var s0 = rawLen();
      T.piece = idx;
      T.width = num(pc.width, W0);
      var bank = num(pc.bank, 0);
      if (pc.type === 'turn' && pc.bank != null && pc.bankAuto !== false) bank = Math.abs(bank) * (num(pc.angle, 90) >= 0 ? 1 : -1);
      if (pc.type === 'wall') bank = Math.abs(num(pc.bank, 80)) * (pc.side < 0 ? -1 : 1);
      T.bank = bank;
      T.lift = pc.type === 'wall' ? 1 : pc.type === 'halfpipe' ? num(pc.lift, 0.8) : 0;
      T.info = null;
      var f = PIECE_FLAGS[pc.type] || 0;
      if (pc.type === 'turn' && Math.abs(bank) >= 40) f |= FLAGS.bowl;
      (pc.flags || []).forEach(function (n) { if (FLAGS[n]) f |= FLAGS[n]; });
      T.flags = f;
      T.design = 0;
      fn(T, pc);
      var s1 = rawLen();
      var info = { type: pc.type, index: idx, s0: s0, s1: s1, flags: f };
      if (pc.type === 'gap' || pc.type === 'cannon') info.designSpeed = T.design;
      if (T.info) { for (var ik in T.info) info[ik] = T.info[ik]; T.info = null; }
      if (pc.name) info.name = pc.name;
      pieceInfo.push(info);
      (pc.features || []).forEach(function (fe) {
        var at = fe.s != null ? s0 + num(fe.s, 0) : s0 + (s1 - s0) * num(fe.at, 0.5);
        rawFeatures.push(Object.assign({}, fe, { _s: at, _piece: idx }));
      });
    });
    // close back to the start pose
    T.piece = -1; T.width = W0; T.bank = 0; T.flags = 0; T.lift = 0; T.design = 0;
    var startPos = st.pos || [0, 0, 0], h0 = num(st.heading, 0);
    var sClose = rawLen();
    closeLoop(T, startPos, [Math.cos(h0), 0, -Math.sin(h0)], [0, 1, 0]);
    var rawTotal = rawLen();
    pieceInfo.push({ type: 'close', index: -1, s0: sClose, s1: rawTotal, flags: 0 });
    // drop the duplicated final point (== first)
    var raw = T.raw;
    if (len(sub(raw[raw.length - 1].p, raw[0].p)) < 0.05) { raw.pop(); arcAt.pop(); }
    var Lraw = rawTotal;

    /* ---- uniform resample (DS), rotated so s = 0 sits at startAt ---- */
    var N = Math.max(16, Math.round(Lraw / DS)), dsU = Lraw / N;
    var startAt = clamp(num(def.startAt, 80), 0, Lraw - 1);
    var P = new Float64Array(N * 3), Up = new Float64Array(N * 3), Wd = new Float64Array(N), Bk = new Float64Array(N);
    var Fl = new Int32Array(N), Pc = new Int16Array(N), Lift = new Float64Array(N), Dsg = new Float64Array(N);
    var j = 0, i;
    var nr = raw.length;
    function rawAt(a) {   // arc length a in [0, Lraw) -> interpolated raw record (wraps)
      a = wrapS(a, Lraw);
      while (j > 0 && arcAt[j] > a) j--;
      while (j < nr - 1 && arcAt[j + 1] <= a) j++;
      var a0 = arcAt[j], r0 = raw[j], r1 = raw[(j + 1) % nr], a1 = j + 1 < nr ? arcAt[j + 1] : Lraw;
      var f = a1 > a0 ? (a - a0) / (a1 - a0) : 0;
      if (r1.jump) f = f < 0.5 ? 0 : 1;   // warp seam: never interpolate between the portal mouths
      var near = f < 0.5 ? r0 : r1;
      return { p: lerp3(r0.p, r1.p, f), n: lerp3(r0.n, r1.n, f), w: r0.w + (r1.w - r0.w) * f, bank: near.bank, flags: near.flags, piece: near.piece, lift: near.lift, design: Math.max(r0.design, r1.design) };
    }
    for (i = 0; i < N; i++) {
      var r = rawAt(startAt + i * dsU);
      P[i * 3] = r.p[0]; P[i * 3 + 1] = r.p[1]; P[i * 3 + 2] = r.p[2];
      Up[i * 3] = r.n[0]; Up[i * 3 + 1] = r.n[1]; Up[i * 3 + 2] = r.n[2];
      Wd[i] = r.w; Bk[i] = r.bank; Fl[i] = r.flags; Pc[i] = r.piece; Lift[i] = r.lift; Dsg[i] = r.design;
    }
    var L = Lraw;
    function idx(k) { return ((k % N) + N) % N; }
    // smooth bank / width / lift (moving average ±win samples), never across gaps
    function smoothArr(arr, win) {
      var out = new Float64Array(N);
      for (var q = 0; q < N; q++) {
        var acc = 0, wsum = 0;
        for (var o = -win; o <= win; o++) { var wt = win + 1 - Math.abs(o); acc += arr[idx(q + o)] * wt; wsum += wt; }
        out[q] = acc / wsum;
      }
      return out;
    }
    var bankWin = Math.round(num(def.bankBlend, 14) / dsU);
    Bk = smoothArr(smoothArr(Bk, bankWin), bankWin);
    Wd = smoothArr(smoothArr(Wd, Math.round(num(def.widthBlend, 8) / dsU)), def.widthBlend ? Math.round(num(def.widthBlend, 8) / dsU) : 0);   // def.widthBlend: gentler width tapers (wide split bends)
    Lift = smoothArr(smoothArr(Lift, bankWin), bankWin);
    // wall-rides: lift the centreline so the lower edge stays near the base height
    // (half-pipes swing the bank through zero: their lift uses the smooth 1 - cos(bank) so the centre line has no kink)
    var HPw = new Float64Array(N);
    for (i = 0; i < N; i++) HPw[i] = Pc[i] >= 0 && pieces[Pc[i]] && pieces[Pc[i]].type === 'halfpipe' ? 1 : 0;
    HPw = smoothArr(smoothArr(HPw, bankWin), bankWin);
    for (i = 0; i < N; i++) {
      if (Lift[i] > 1e-3) {
        var lb = Math.abs(Bk[i]) * DEG, hw0 = HPw[i];
        P[i * 3 + 1] += Lift[i] * (Wd[i] / 2) * (hw0 * 1.4 * (1 - Math.cos(lb)) + (1 - hw0) * Math.sin(lb));
      }
    }
    /* ---- frames: T by central differences, up = turtle up orthonormalised then rolled by bank ---- */
    var Tg = new Float64Array(N * 3), Nn = new Float64Array(N * 3), Rt = new Float64Array(N * 3);
    function Pv(k) { k = idx(k); return [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]]; }
    // warp seams: the segment i -> i+1 jumps through a portal (world positions far apart, track space continuous)
    var Wp = new Uint8Array(N), warps = [];
    for (i = 0; i < N; i++) if (len(sub(Pv(i + 1), Pv(i))) > dsU * 3) Wp[i] = 1;
    for (i = 0; i < N; i++) {
      var t = Wp[i] ? norm(sub(Pv(i), Pv(i - 1))) : Wp[idx(i - 1)] ? norm(sub(Pv(i + 1), Pv(i))) : norm(sub(Pv(i + 1), Pv(i - 1)));
      var nb = ortho([Up[i * 3], Up[i * 3 + 1], Up[i * 3 + 2]], t);
      var b = Bk[i] * DEG;
      if (b) nb = norm(madd(mul(nb, Math.cos(b)), cross(t, nb), -Math.sin(b)));   // + bank: up leans toward LEFT (-right)
      var rr = cross(t, nb);
      Tg[i * 3] = t[0]; Tg[i * 3 + 1] = t[1]; Tg[i * 3 + 2] = t[2];
      Nn[i * 3] = nb[0]; Nn[i * 3 + 1] = nb[1]; Nn[i * 3 + 2] = nb[2];
      Rt[i * 3] = rr[0]; Rt[i * 3 + 1] = rr[1]; Rt[i * 3 + 2] = rr[2];
    }
    /* ---- curvatures (per metre): kLeft = in-surface turn rate (+ left), kNormal = toward up (+ concave / loop) ---- */
    var KL = new Float64Array(N), KN = new Float64Array(N);
    for (i = 0; i < N; i++) {
      var ta = [Tg[idx(i - 1) * 3], Tg[idx(i - 1) * 3 + 1], Tg[idx(i - 1) * 3 + 2]], tb = [Tg[idx(i + 1) * 3], Tg[idx(i + 1) * 3 + 1], Tg[idx(i + 1) * 3 + 2]];
      var dT = mul(sub(tb, ta), 1 / (2 * dsU));
      KL[i] = -dot(dT, [Rt[i * 3], Rt[i * 3 + 1], Rt[i * 3 + 2]]);
      KN[i] = dot(dT, [Nn[i * 3], Nn[i * 3 + 1], Nn[i * 3 + 2]]);
    }
    for (i = 0; i < N; i++) if (Wp[i]) for (var wq = -2; wq <= 3; wq++) { KL[idx(i + wq)] = 0; KN[idx(i + wq)] = 0; }
    KL = smoothArr(KL, 2); KN = smoothArr(KN, 2);
    // gaps never carry curvature (no surface)
    for (i = 0; i < N; i++) if (Fl[i] & FLAGS.gap) { KL[i] = 0; KN[i] = 0; }
    // landing run-out: the 25 m after every gap are flagged landing (no respawn, AI keeps throttle)
    for (i = 0; i < N; i++) if ((Fl[i] & FLAGS.gap) && !(Fl[idx(i + 1)] & FLAGS.gap)) for (var q = 1; q <= Math.round(25 / dsU); q++) Fl[idx(i + q)] |= FLAGS.landing;
    // every segment has guard rails except gaps
    for (i = 0; i < N; i++) if (!(Fl[i] & FLAGS.gap)) Fl[i] |= FLAGS.rails;
    Fl[0] |= FLAGS.start;

    /* ---- features (absolute s) ---- */
    function absS(rawS) { return wrapS(rawS - startAt, L); }
    var features = [], fid = 1;
    rawFeatures.forEach(function (fe) {
      var s = absS(fe._s);
      if (fe.type === 'box') {
        var lats = Array.isArray(fe.lats) ? fe.lats : null;
        if (!lats) {
          var cnt = Math.max(1, num(fe.count, 4)), hw = Wd[idx(Math.round(s / dsU))] / 2 - 1.6, sp = cnt > 1 ? (2 * hw) / (cnt - 1) : 0;
          lats = []; for (var c = 0; c < cnt; c++) lats.push(+(-hw + c * sp).toFixed(2));
        }
        lats.forEach(function (lt, k) { features.push({ id: 'f' + fid++, type: 'box', s: s, lat: lt, row: fe._piece * 10 + k, z: 1.0 }); });
      } else if (fe.type === 'coin') {
        var nC = Math.max(1, num(fe.n, 5)), spc = num(fe.spacing, 6);
        for (var cc = 0; cc < nC; cc++) features.push({ id: 'f' + fid++, type: 'coin', s: wrapS(s + cc * spc, L), lat: num(fe.lat, 0), z: num(fe.z, 0.9) });
      } else {
        var o = { id: 'f' + fid++, type: fe.type, s: s, lat: num(fe.lat, 0) };
        for (var fk in fe) if (fk !== 'type' && fk !== 'at' && fk !== 's' && fk !== 'lat' && fk.charAt(0) !== '_') o[fk] = fe[fk];
        o.piece = fe._piece;
        features.push(o);
      }
    });
    features.sort(function (a, b) { return a.s - b.s; });
    // boost flag under pads (for the fallback boost logic and the renderer)
    features.forEach(function (fe) {
      if (fe.type !== 'pad') return;
      var half = num(fe.len, 7) / 2;
      for (var a = -half; a <= half; a += dsU) Fl[idx(Math.round((fe.s + a) / dsU))] |= FLAGS.boost;
    });
    // ranged special features (stunt-features.js): splits, booster tunnels, speed belts, hazards flag their samples
    var splits = [], tunnels = [], belts = [], hazards = [];
    function flagRange(s0, ln, bit) { for (var a = 0; a <= ln; a += dsU) Fl[idx(Math.round((s0 + a) / dsU))] |= bit; }
    features.forEach(function (fe) {
      if (fe.type === 'split') {
        var sl = num(fe.len, 120);
        splits.push({ id: fe.id, s0: fe.s, s1: wrapS(fe.s + sl, L), len: sl, div: num(fe.div, 0), dw: num(fe.dw, 0.55), inner: fe.inner < 0 ? -1 : 1, nose: num(fe.nose, 6), shortcut: fe.shortcut !== false });
        flagRange(fe.s - 6, sl + 6, FLAGS.split);
      } else if (fe.type === 'tunnel') {
        var tl = num(fe.len, 120);
        tunnels.push({ id: fe.id, s0: fe.s, s1: wrapS(fe.s + tl, L), len: tl, push: num(fe.push, 7), top: num(fe.top, 1.14), r: num(fe.r, 7.5) });
        flagRange(fe.s, tl, FLAGS.tunnel);
      } else if (fe.type === 'belt') {
        flagRange(fe.s, num(fe.len, 40), FLAGS.belt); belts.push(fe);
      } else if (fe.type === 'hazard') {
        flagRange(fe.s - 8, 16, FLAGS.hazard); hazards.push(fe);
      }
    });

    /* ---- gaps ---- */
    var gaps = [];
    for (i = 0; i < N; i++) {
      if ((Fl[i] & FLAGS.gap) && !(Fl[idx(i - 1)] & FLAGS.gap)) {
        var k2 = i, cnt2 = 0, dmax = 0;
        while ((Fl[idx(k2)] & FLAGS.gap) && cnt2 < N) { dmax = Math.max(dmax, Dsg[idx(k2)]); k2++; cnt2++; }
        gaps.push({ s0: i * dsU, s1: idx(k2) * dsU, takeoffS: wrapS((i - 1) * dsU, L), landS: idx(k2) * dsU, designSpeed: dmax, length: cnt2 * dsU, cannon: !!(Fl[i] & FLAGS.cannon) });
      }
    }
    /* ---- checkpoints: authored + automatic every ~220 m on safe ground ---- */
    var cps = [];
    features.forEach(function (fe) { if (fe.type === 'checkpoint') cps.push(fe.s); });
    var autoEvery = num(def.checkpointEvery, 220);
    for (var sa = autoEvery; sa < L - 60; sa += autoEvery) {
      // nearest safe spot ahead (up to 120 m)
      for (var dd = 0; dd < 120; dd += dsU) {
        var ii = idx(Math.round((sa + dd) / dsU)), safe = true;
        for (var w2 = -8; w2 <= 8; w2++) if (Fl[idx(ii + w2)] & UNSAFE) { safe = false; break; }
        if (safe && Nn[ii * 3 + 1] > 0.85) { cps.push(ii * dsU); break; }
      }
    }
    cps.push(0);
    cps.sort(function (a, b) { return a - b; });
    var checkpoints = [];
    cps.forEach(function (c) { if (!checkpoints.length || c - checkpoints[checkpoints.length - 1].s > 40) checkpoints.push({ s: c, index: checkpoints.length }); });
    checkpoints.forEach(function (c) { Fl[idx(Math.round(c.s / dsU))] |= FLAGS.checkpoint; });

    /* ---- bounds / ground ---- */
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (i = 0; i < N; i++) for (var a3 = 0; a3 < 3; a3++) { var vv = P[i * 3 + a3]; if (vv < mn[a3]) mn[a3] = vv; if (vv > mx[a3]) mx[a3] = vv; }
    // ground plane below the LOWEST road edge (a 50° bowl's low edge sits hw·sin(bank) under its centre line)
    var edgeMin = mn[1];
    for (i = 0; i < N; i++) { var ey2 = P[i * 3 + 1] - Math.abs(Rt[i * 3 + 1]) * (Wd[i] / 2 + 0.4); if (ey2 < edgeMin) edgeMin = ey2; }
    var groundY = num(def.groundY, edgeMin - num(def.stilts, 6));

    /* ---- spatial hash for project() ---- */
    var CELL = 12, hash = new Map();
    function ckey(ix, iy, iz) { return ((ix + 2048) * 4096 + (iy + 2048)) * 4096 + (iz + 2048); }
    for (i = 0; i < N; i++) {
      var kk = ckey(Math.floor(P[i * 3] / CELL), Math.floor(P[i * 3 + 1] / CELL), Math.floor(P[i * 3 + 2] / CELL));
      var bucket = hash.get(kk);
      if (!bucket) hash.set(kk, bucket = []);
      bucket.push(i);
    }

    var trk = {
      id: def.id, name: def.name, theme: def.theme || 'stadium', def: def, solvedPieces: pieces, length: L, L: L, N: N, DS: dsU, laps: num(def.laps, 3),
      P: P, T: Tg, U: Nn, R: Rt, W: Wd, B: Bk, F: Fl, KL: KL, KN: KN, piece: Pc, design: Dsg,
      FLAGS: FLAGS, features: features, checkpoints: checkpoints, gaps: gaps, pieces: pieceInfo.map(function (p) {
        var o = { type: p.type, index: p.index, s0: absS(p.s0), s1: absS(p.s1), length: p.s1 - p.s0, designSpeed: p.designSpeed };
        for (var pk in p) if (!(pk in o) && pk !== 'flags') o[pk] = p[pk];   // piece info (radius, tube axis, zero-g ceiling, warp mouths …)
        return o;
      }),
      groundY: groundY, bounds: { min: mn, max: mx }, startAt: startAt, WARP: Wp, warps: warps, splits: splits, tunnels: tunnels, belts: belts, hazards: hazards
    };
    for (i = 0; i < N; i++) if (Wp[i]) warps.push({ s: (i + 0.5) * dsU, i: i, from: Pv(i), to: Pv(i + 1), fromFwd: [Tg[i * 3], Tg[i * 3 + 1], Tg[i * 3 + 2]], toFwd: [Tg[idx(i + 1) * 3], Tg[idx(i + 1) * 3 + 1], Tg[idx(i + 1) * 3 + 2]] });

    /* ---- sampling ---- */
    trk.sample = function (s, out) {
      out = out || { pos: [0, 0, 0], tangent: [0, 0, 0], up: [0, 0, 0], right: [0, 0, 0], left: [0, 0, 0] };
      s = wrapS(s, L);
      var x = s / dsU, i0 = Math.floor(x), f = x - i0, a = idx(i0), b2 = idx(i0 + 1), k3;
      if (Wp[a]) f = f < 0.5 ? 0 : 1;   // warp seam: snap to a portal mouth
      var g = 1 - f;
      var pp = out.pos, tt = out.tangent, uu = out.up, rr2 = out.right, ll = out.left;
      for (k3 = 0; k3 < 3; k3++) {
        pp[k3] = P[a * 3 + k3] * g + P[b2 * 3 + k3] * f;
        tt[k3] = Tg[a * 3 + k3] * g + Tg[b2 * 3 + k3] * f;
        uu[k3] = Nn[a * 3 + k3] * g + Nn[b2 * 3 + k3] * f;
      }
      var tl = Math.sqrt(tt[0] * tt[0] + tt[1] * tt[1] + tt[2] * tt[2]) || 1;
      tt[0] /= tl; tt[1] /= tl; tt[2] /= tl;
      var du = uu[0] * tt[0] + uu[1] * tt[1] + uu[2] * tt[2];
      uu[0] -= tt[0] * du; uu[1] -= tt[1] * du; uu[2] -= tt[2] * du;
      var ul = Math.sqrt(uu[0] * uu[0] + uu[1] * uu[1] + uu[2] * uu[2]) || 1;
      uu[0] /= ul; uu[1] /= ul; uu[2] /= ul;
      rr2[0] = tt[1] * uu[2] - tt[2] * uu[1]; rr2[1] = tt[2] * uu[0] - tt[0] * uu[2]; rr2[2] = tt[0] * uu[1] - tt[1] * uu[0];
      ll[0] = -rr2[0]; ll[1] = -rr2[1]; ll[2] = -rr2[2];
      var near = f < 0.5 ? a : b2;
      out.s = s;
      out.index = near;
      out.width = Wd[a] * g + Wd[b2] * f;
      out.halfWidth = out.width / 2;
      out.bank = Bk[a] * g + Bk[b2] * f;
      out.kLeft = KL[a] * g + KL[b2] * f;
      out.kNormal = KN[a] * g + KN[b2] * f;
      out.flags = Fl[near];
      return out;
    };
    trk.pointAt = function (s, lat, h, out) {
      var sm = trk.sample(s, trk._tmp || (trk._tmp = null));
      trk._tmp = sm;
      out = out || [0, 0, 0];
      lat = lat || 0; h = h || 0;
      for (var k4 = 0; k4 < 3; k4++) out[k4] = sm.pos[k4] + sm.left[k4] * lat + sm.up[k4] * h;
      return out;
    };
    trk.flagsAt = function (s) { return Fl[idx(Math.round(wrapS(s, L) / dsU))]; };
    trk.has = function (s, name) { return !!(trk.flagsAt(s) & (FLAGS[name] || 0)); };
    trk.isSafe = function (s) { return !(trk.flagsAt(s) & UNSAFE); };
    trk.designSpeedAt = function (s) { return Dsg[idx(Math.round(wrapS(s, L) / dsU))]; };
    trk.gapAt = function (s) {
      for (var q2 = 0; q2 < gaps.length; q2++) { var gq = gaps[q2], d0 = wrapD(s - gq.s0, L); if (d0 >= -2 && d0 <= gq.length + 1) return gq; }
      return null;
    };
    /** Nearest gap ahead of s within `range` metres (or null). */
    trk.gapAhead = function (s, range) {
      var best = null, bd = Infinity;
      for (var q2 = 0; q2 < gaps.length; q2++) { var d0 = wrapS(gaps[q2].s0 - s, L); if (d0 < range && d0 < bd) { bd = d0; best = gaps[q2]; } }
      return best ? { gap: best, dist: bd } : null;
    };
    /**
     * project(worldPos, opts) -> nearest track-surface point {s, lateral (+left), height (along up), index, dist, along}
     * opts.hintS + opts.window (m) restrict the search to |s - hintS| <= window; opts.surfaceOnly skips gaps;
     * opts.maxDist (default 30) ignores farther samples; opts.lateralMargin (default 2) beyond the half width.
     */
    trk.project = function (p, o) {
      o = o || {};
      var maxD = num(o.maxDist, 30), margin = num(o.lateralMargin, 2), hint = o.hintS, win = num(o.window, 0);
      var cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL), cz = Math.floor(p[2] / CELL);
      var rc = Math.ceil(maxD / CELL);
      var best = null, bestScore = Infinity;
      for (var ix = cx - rc; ix <= cx + rc; ix++) for (var iy = cy - rc; iy <= cy + rc; iy++) for (var iz = cz - rc; iz <= cz + rc; iz++) {
        var bk = hash.get(ckey(ix, iy, iz));
        if (!bk) continue;
        for (var q3 = 0; q3 < bk.length; q3++) {
          var k5 = bk[q3];
          if (o.surfaceOnly && (Fl[k5] & FLAGS.gap)) continue;
          if (hint != null && win > 0 && Math.abs(wrapD(k5 * dsU - hint, L)) > win) continue;
          var dx = p[0] - P[k5 * 3], dy = p[1] - P[k5 * 3 + 1], dz = p[2] - P[k5 * 3 + 2];
          var along = dx * Tg[k5 * 3] + dy * Tg[k5 * 3 + 1] + dz * Tg[k5 * 3 + 2];
          if (Math.abs(along) > dsU * 0.75) continue;
          var hgt = dx * Nn[k5 * 3] + dy * Nn[k5 * 3 + 1] + dz * Nn[k5 * 3 + 2];
          var lat2 = -(dx * Rt[k5 * 3] + dy * Rt[k5 * 3 + 1] + dz * Rt[k5 * 3 + 2]);
          var over = Math.max(0, Math.abs(lat2) - Wd[k5] / 2);
          if (over > margin) continue;
          var score = hgt * hgt + over * over * 4 + along * along * 0.01;
          if (Math.sqrt(score) > maxD) continue;
          if (score < bestScore) { bestScore = score; best = { s: wrapS(k5 * dsU + along, L), lateral: lat2, height: hgt, index: k5, along: along, dist: Math.sqrt(score) }; }
        }
      }
      // refine against the INTERPOLATED frame (the surface sample() / pose() / the mesh use): the per-sample planes are
      // discontinuous at the outer lanes of banked / twisting sections (0.2–0.3 m steps at 6 m lateral), which let a
      // landing car step from just above one plane to below the next without ever "crossing" the road
      if (best) {
        var sr = best.s, smr = null;
        for (var it = 0; it < 2; it++) {
          smr = trk.sample(sr, _pj);
          _pj = smr;
          var ex = p[0] - smr.pos[0], ey = p[1] - smr.pos[1], ez = p[2] - smr.pos[2];
          var al = ex * smr.tangent[0] + ey * smr.tangent[1] + ez * smr.tangent[2];
          if (Math.abs(al) < 1e-4) break;
          sr = wrapS(sr + clamp(al, -dsU, dsU), L);
        }
        smr = trk.sample(sr, _pj); _pj = smr;
        var fx = p[0] - smr.pos[0], fy = p[1] - smr.pos[1], fz = p[2] - smr.pos[2];
        best.s = sr;
        best.lateral = fx * smr.left[0] + fy * smr.left[1] + fz * smr.left[2];
        best.height = fx * smr.up[0] + fy * smr.up[1] + fz * smr.up[2];
      }
      return best;
    };
    var _pj = null;

    /* ---- minimap / thumbnail / 2D geom ---- */
    var mm = [], step2 = Math.max(1, Math.round(4 / dsU));
    for (i = 0; i < N; i += step2) mm.push([P[i * 3], -P[i * 3 + 2], P[i * 3 + 1]]);
    trk.minimap = { points: mm, bounds: { minX: mn[0], maxX: mx[0], minY: -mx[2], maxY: -mn[2], minZ: mn[1], maxZ: mx[1] } };
    trk.thumbnail = function (o2) { return thumbnailSVG(trk, o2); };
    var g2 = [];
    for (i = 0; i < N; i++) {
      var hx = Tg[i * 3], hz = Tg[i * 3 + 2];
      g2.push({ x: P[i * 3], y: -P[i * 3 + 2], z: P[i * 3 + 1], heading: Math.atan2(-hz, hx), s: i * dsU, width: Wd[i], curvature: KL[i], elevation: P[i * 3 + 1] });
    }
    trk.geom2D = { samples: g2, length: L, totalLength: L, start: { x: P[0], y: -P[2], heading: Math.atan2(-Tg[2], Tg[0]) }, sectorBoundaries: [L / 3, 2 * L / 3], stunt: true };
    if (def.id && !opts.noCache) cache[def.id] = trk;
    return trk;
  }

  /* ---------------------------------------------------------------- thumbnail (top-down SVG with feature dots) */
  var THEME_COLORS = {
    stadium: { track: '#ff6b1a', bg: '#1f6b3a', edge: '#ffd23f' },
    canyon: { track: '#ff5a1f', bg: '#b5652d', edge: '#ffe2a8' },
    neon: { track: '#ff2fd6', bg: '#120a2a', edge: '#30e3ff' },
    toybox: { track: '#2f8bff', bg: '#f2d9a0', edge: '#ffd23f' },
    glacier: { track: '#30c8ff', bg: '#dfefff', edge: '#ffffff' },
    volcano: { track: '#ff8a1f', bg: '#2a1410', edge: '#ffcf4a' },
    lab: { track: '#2ef2c8', bg: '#0e1a24', edge: '#ffffff' },
    pinball: { track: '#ff2f6d', bg: '#1a0830', edge: '#ffe14a' },
    sky: { track: '#ffb21f', bg: '#7fc6ff', edge: '#ffffff' },
    bedroom: { track: '#ff7a10', bg: '#6b4a8a', edge: '#ffe14a' },
    rooftops: { track: '#ffd21f', bg: '#2a3140', edge: '#ff3b30' }
  };
  var DOT_TYPES = { loop: 1, corkscrew: 1, gap: 1, tube: 1, zerog: 1, cannon: 1, warp: 1, halfpipe: 1 };
  function thumbnailSVG(trk, o) {
    o = o || {};
    var Wpx = num(o.width, 160), Hpx = num(o.height, 100), pad = 8, b = trk.minimap.bounds;
    var sx = (Wpx - 2 * pad) / Math.max(1, b.maxX - b.minX), sy = (Hpx - 2 * pad) / Math.max(1, b.maxY - b.minY), sc = Math.min(sx, sy);
    var ox = (Wpx - (b.maxX - b.minX) * sc) / 2, oy = (Hpx - (b.maxY - b.minY) * sc) / 2;
    function X(x) { return (ox + (x - b.minX) * sc).toFixed(1); }
    function Y(y) { return (Hpx - (oy + (y - b.minY) * sc)).toFixed(1); }
    var c = THEME_COLORS[trk.theme] || THEME_COLORS.stadium;
    var pts = trk.minimap.points, d = pts.map(function (p, i) {
      var jump = i && Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 20;   // warp portals: no line across the seam
      return (i && !jump ? 'L' : 'M') + X(p[0]) + ' ' + Y(p[1]);
    }).join('') + (trk.warps && trk.warps.length ? '' : 'Z');
    var dots = '';
    trk.pieces.forEach(function (pc) {
      if (!DOT_TYPES[pc.type]) return;
      var sm = trk.sample(pc.s0 + Math.max(0, pc.length) / 2), col = pc.type === 'gap' || pc.type === 'cannon' ? '#ffffff' : pc.type === 'warp' ? '#b64dff' : '#ffd23f';
      dots += '<circle cx="' + X(sm.pos[0]) + '" cy="' + Y(-sm.pos[2]) + '" r="3.2" fill="' + col + '" stroke="#000" stroke-width="0.8"/>';
    });
    var st = trk.sample(0);
    dots += '<rect x="' + (+X(st.pos[0]) - 3) + '" y="' + (+Y(-st.pos[2]) - 3) + '" width="6" height="6" fill="#fff" stroke="#000" stroke-width="0.8"/>';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + Wpx + ' ' + Hpx + '" width="' + Wpx + '" height="' + Hpx + '">' +
      '<rect width="100%" height="100%" rx="8" fill="' + c.bg + '"/>' +
      '<path d="' + d + '" fill="none" stroke="#000" stroke-opacity="0.35" stroke-width="7" stroke-linejoin="round"/>' +
      '<path d="' + d + '" fill="none" stroke="' + c.track + '" stroke-width="4.5" stroke-linejoin="round"/>' +
      '<path d="' + d + '" fill="none" stroke="' + c.edge + '" stroke-width="0.9" stroke-dasharray="3 3"/>' + dots + '</svg>';
  }

  /* ======================================================================
     Registry
     ====================================================================== */
  var DEFS = S._defs || (S._defs = []);
  function register(def) {
    if (!def || !def.id) return;
    for (var i = 0; i < DEFS.length; i++) if (DEFS[i].id === def.id) { DEFS[i] = def; delete cache[def.id]; return; }
    DEFS.push(def);
  }
  function getDef(id) { for (var i = 0; i < DEFS.length; i++) if (DEFS[i].id === id) return DEFS[i]; return null; }
  function get(id) {
    var d = typeof id === 'object' ? id : getDef(id);
    return d ? build(d) : null;
  }
  /** list() -> [{id, name, theme, length, laps, blurb, difficulty, features, thumbnail (SVG string), minimap}] */
  function list() {
    return DEFS.map(function (d) {
      var t = null;
      try { t = build(d); } catch (e) { t = null; }
      var counts = {};
      if (t) t.pieces.forEach(function (p) { counts[p.type] = (counts[p.type] || 0) + 1; });
      return {
        id: d.id, name: d.name, theme: d.theme || 'stadium', length: t ? Math.round(t.length) : 0, length_m: t ? Math.round(t.length) : 0, laps: num(d.laps, 3), blurb: d.blurb || '',
        desc: d.blurb || '', tagline: d.tagline || tagline(counts), stunt: true, timeOfDay: d.timeOfDay || (d.theme === 'neon' ? 'night' : 'day'),
        features: t ? t.features.filter(function (f) { return f.type !== 'coin'; }).length : 0, stuntCount: stuntCount(counts),
        special: t ? specialList(t, counts) : [],
        difficulty: ({ easy: 2, normal: 3, hard: 4, expert: 5 })[d.difficulty] || 3, difficultyName: d.difficulty || 'normal', stuntBreakdown: { loops: counts.loop || 0, corkscrews: counts.corkscrew || 0, gaps: counts.gap || 0, walls: counts.wall || 0,
          tubes: counts.tube || 0, zerog: counts.zerog || 0, halfpipes: counts.halfpipe || 0, cannons: counts.cannon || 0, warps: counts.warp || 0,
          hazards: t ? t.hazards.length : 0, splits: t ? t.splits.length : 0 },
        estLap_s: d.estLap_s || null, kind: 'stunt',
        thumbnail: t ? t.thumbnail() : '', minimap: t ? t.minimap : null,
        // 2D outline for race-ui's generic track maps (catmull-rom of [x, y] points, y = -z) + headline stats
        points: t ? t.minimap.points.filter(function (p, i) { return i % 4 === 0; }).map(function (p) { return [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]; }) : [],
        corners: counts.turn || 0, width_m: num(d.width, 12), stunts: stuntCount(counts) + (counts.hill || 0) + (counts.drop || 0)
      };
    });
  }

  function stuntCount(c) {
    return (c.loop || 0) + (c.corkscrew || 0) + (c.gap || 0) + (c.wall || 0) + (c.tube || 0) + (c.zerog || 0) + (c.halfpipe || 0) + (c.cannon || 0) + (c.warp || 0);
  }
  /** headline special features of a built track (setup-screen chips) */
  function specialList(t, c) {
    var out = [], ft = {};
    t.features.forEach(function (f) { ft[f.type === 'hazard' ? 'hazard:' + f.kind : f.type === 'ring' && f.fire ? 'fireRing' : f.type] = 1; });
    if (c.tube) out.push('barrel roll');
    if (c.zerog) out.push('zero-g');
    if (c.halfpipe) out.push('half-pipe');
    if (c.cannon) out.push('cannon');
    if (c.warp) out.push('warp portals');
    if (t.splits.length) out.push('shortcut');
    if (t.tunnels.length) out.push('boost tunnel');
    if (t.hazards.length) out.push('hazards');
    if (ft.bumper || ft.flipper) out.push('pinball bumpers');
    if (ft.fireRing) out.push('fire hoops');
    if (ft.star) out.push('stars');
    return out;
  }
  function tagline(c) {
    var p = [];
    if (c.loop) p.push(c.loop + (c.loop > 1 ? ' loops' : ' loop'));
    if (c.corkscrew) p.push('corkscrew');
    if (c.tube) p.push('barrel roll');
    if (c.zerog) p.push('zero-g');
    if (c.cannon) p.push(c.cannon > 1 ? c.cannon + ' cannons' : 'cannon');
    if (c.warp) p.push('warp portals');
    if (c.gap) p.push(c.gap + (c.gap > 1 ? ' gaps' : ' gap'));
    if (c.wall) p.push('wall-rides');
    if (c.halfpipe) p.push('half-pipe');
    if (p.length < 3) p.push('boost pads');
    return p.slice(0, 4).join(' · ');
  }
  /** Draw a track thumbnail (top-down, theme colours, stunt markers) into a 2D canvas. def = list() entry / id / def. */
  function drawThumb(canvas, def, o) {
    o = o || {};
    var t = get(def && def.id ? def.id : def);
    if (!t || !canvas || !canvas.getContext) return false;
    var c = canvas.getContext('2d'), dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    var W = canvas.clientWidth || canvas.width, H = canvas.clientHeight || canvas.height;
    if (canvas.clientWidth && canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    c.setTransform(canvas.width / Math.max(1, W), 0, 0, canvas.height / Math.max(1, H), 0, 0);
    c.clearRect(0, 0, W, H);
    var b = t.minimap.bounds, pad = num(o.pad, 8), col = THEME_COLORS[t.theme] || THEME_COLORS.stadium;
    var sc = Math.min((W - 2 * pad) / Math.max(1, b.maxX - b.minX), (H - 2 * pad) / Math.max(1, b.maxY - b.minY));
    var ox = (W - (b.maxX - b.minX) * sc) / 2, oy = (H - (b.maxY - b.minY) * sc) / 2;
    function X(x) { return ox + (x - b.minX) * sc; }
    function Y(y) { return H - (oy + (y - b.minY) * sc); }
    var pts = t.minimap.points;
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.beginPath(); pts.forEach(function (p, i) { if (i && Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) <= 20) c.lineTo(X(p[0]), Y(p[1])); else c.moveTo(X(p[0]), Y(p[1])); });
    if (!(t.warps && t.warps.length)) c.closePath();
    c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = Math.max(4, Math.min(W, H) * 0.06); c.stroke();
    c.strokeStyle = o.color || col.track; c.lineWidth = Math.max(2.5, Math.min(W, H) * 0.035); c.stroke();
    t.pieces.forEach(function (pc) {
      if (!DOT_TYPES[pc.type]) return;
      var sm = t.sample(pc.s0 + Math.max(0, pc.length) / 2);
      c.fillStyle = pc.type === 'gap' || pc.type === 'cannon' ? '#ffffff' : pc.type === 'warp' ? '#b64dff' : col.edge; c.strokeStyle = '#000'; c.lineWidth = 1;
      c.beginPath(); c.arc(X(sm.pos[0]), Y(-sm.pos[2]), Math.max(2.5, Math.min(W, H) * 0.035), 0, Math.PI * 2); c.fill(); c.stroke();
    });
    var st = t.sample(0);
    c.fillStyle = '#fff'; c.fillRect(X(st.pos[0]) - 3, Y(-st.pos[2]) - 3, 6, 6);
    return true;
  }
  S.drawThumb = drawThumb;
  S.FLAGS = FLAGS;
  S.FLAG_NAMES = FLAG_NAMES;
  S.UNSAFE = UNSAFE;
  S.G_AIR = G_AIR;
  S.DS = DS;
  S.build = build;
  S.register = register;
  S.get = get;
  S.getDef = getDef;
  S.list = list;
  S.trackList = list;
  S.ids = function () { return DEFS.map(function (d) { return d.id; }); };
  S.isStunt = function (id) { return !!getDef(id); };
  S.clearCache = function () { cache = {}; };
  S._vec = { add: add, sub: sub, mul: mul, madd: madd, dot: dot, cross: cross, len: len, norm: norm, rot: rot, ortho: ortho, lerp3: lerp3, wrapS: wrapS, wrapD: wrapD, clamp: clamp, num: num, smooth: smooth, smoother: smoother };
  S.THEME_COLORS = THEME_COLORS;

  if (typeof module !== 'undefined' && module.exports) module.exports = S;
})(CB.arcade.stunt);

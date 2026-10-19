/* ==========================================================================
   FORGE Atelier — js/race/engine.js
   CB.race.engine : the race session. Pure logic, no DOM.

     createSession(cfg) -> session
       cfg: { trackId | track (def), laps 1..50, opponents (array from ai.createGrid | count), opponentCount,
              difficulty, field, playerBuild, weather 'dry'|'damp'|'wet', timeOfDay, mode 'race'|'time-trial'|'practice',
              assists {abs, tc, autoShift, racingLine, steeringAssist}, seed, playerName, playerTeam,
              startPosition (1-based | 'front'|'middle'|'back'|'random'), rubberBanding, playerAutopilot,
              ghost (preloaded ghost data), storage (localStorage-like), persistGhost,
              jumpStartPenalty_s 5, trackLimitsWarnings 3, trackLimitsPenalty_s 5, stuckDnf_s 30, aiAutoRecover_s 9 }

     session.geom / session.config / session.trackDef
     session.update(dt, playerInput) -> substeps run      (fixed 1/120 s substeps, internal accumulator)
     session.snapshot()                                   (plain object; drains the events queue)
     session.results()
     session.restart()                                    (same seed -> identical replay of AI behaviour)
     session.resetPlayerToTrack()
     extras: setAssists(a), setPlayerAutopilot(bool), simulate(seconds, input), simulateToEnd(maxSeconds),
             end(), getGhost(), clearGhost(), time(), getPhase(), alpha()

   Game hooks (GAME-SPEC § Engine hook contract):
     cfg.extras = { endurance, wear, fuel, damage, pitStops (bool | mandatory count), challenge, onEvent(e), autoPit }
     cfg.hooks  = hook object | array of hook objects, each optionally providing
                  carCreated(car), preStep(car, input, dt) -> input?, postStep(car, dt), modifiers(car) -> mods,
                  vehicleParams(car, params) -> params, vehicleEnv(car, env) -> env, onImpact(car, impulse, localDir, opts),
                  snapshot(car) -> object (snapshot cars gain `endurance`), pitStop(car, request), advice(car, ctx)
     When extras ask for wear / fuel / damage / pit stops and no hook supplies vehicleParams, CB.game.endurance.createHooks
     is attached automatically. Mods from hooks without vehicleParams are baked in via CB.game.endurance.applyToParams
     (aero drag is a parameter change — CB.race.vehicle's env.dragMult is a surface term and is never touched).
     session.requestPit(carId?, request?) / session.cancelPit(carId?) / session.pitInfo; player input.pit also requests a stop.

   Determinism: every random decision comes from a seeded PRNG (mulberry32). While the session steps (and while it
   asks ai.createGrid / ai.createDriver for things) Math.random is temporarily swapped for a seeded stream, so even
   sibling modules that use Math.random stay reproducible (disable with cfg.sandboxRandom = false).

   Soft dependencies (feature-detected, internal fallbacks for every one):
     CB.race.tracks (list/get/build/project), CB.race.vehicle (fromBuild/createState/step),
     CB.race.ai (createGrid/createDriver), CB.physics.compute, CB.state.normalize, CB.data.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};

(function () {
  'use strict';

  /* ======================================================================
     Constants
     ====================================================================== */

  var STEP = 1 / 120;
  var GRAV = 9.81;
  var TAU = Math.PI * 2;
  var MAX_SUBSTEPS = 60;          // at most 0.5 s of simulation per update() call (spiral-of-death guard)
  var GAP_BUCKET = 4;             // m — resolution of the distance->time history used for time gaps
  var GAP_OFFSET = 1500;          // m — distance before the start line representable in the history
  var TRACE_BUCKET = 10;          // m — resolution of the live delta-to-best trace
  var GHOST_EVERY = 3;            // substeps between ghost samples (40 Hz)
  var GHOST_KEY = 'forge.race.ghost.v1';
  var ARC_YAW_CAP = 1.6;          // rad/s: max yaw kick an arcade car keeps after a wall / car contact
  var TL_MARGIN = 0.5;            // m beyond the track edge (+ kerb) a wheel may be before it counts as "off"
  var TL_WIDE_S = 0.6;            // s a run-wide excursion (outside of a corner / on a straight) must last to count
  var MAX_EVENTS = 256;

  var SURFACES = {
    asphalt: { grip: 1.00, decel: 0.0, decelV: 0.000 },
    kerb:    { grip: 0.93, decel: 0.2, decelV: 0.002 },
    grass:   { grip: 0.58, decel: 1.4, decelV: 0.030 },
    sand:    { grip: 0.45, decel: 3.8, decelV: 0.090 },
    gravel:  { grip: 0.45, decel: 3.8, decelV: 0.090 },
    wall:    { grip: 0.80, decel: 1.0, decelV: 0.020 },
    pit:     { grip: 0.97, decel: 0.0, decelV: 0.000 }
  };
  var WEATHER = {
    dry:  { grip: 1.00, wet: false, wetness: 0 },
    damp: { grip: 0.90, wet: false, wetness: 0.5 },
    wet:  { grip: 0.80, wet: true,  wetness: 1 }
  };

  /* ======================================================================
     Small helpers
     ====================================================================== */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function firstNum() { for (var i = 0; i < arguments.length; i++) if (isNum(arguments[i])) return arguments[i]; return undefined; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function wrapAngle(a) {
    if (!isFinite(a)) return 0;
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  }
  function wrapS(s, L) { s = s % L; return s < 0 ? s + L : s; }
  function round(v, d) { if (!isNum(v)) return v; var p = Math.pow(10, d || 0); return Math.round(v * p) / p; }
  function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  function deepClone(o) {
    if (o == null || typeof o !== 'object') return o;
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; }
  }
  function hashString(str) {
    str = String(str);
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function stableStringify(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    var keys = Object.keys(v).sort(), out = [];
    for (var i = 0; i < keys.length; i++) {
      var val = v[keys[i]];
      if (val === undefined || typeof val === 'function') continue;
      out.push(JSON.stringify(keys[i]) + ':' + stableStringify(val));
    }
    return '{' + out.join(',') + '}';
  }
  /** Hash of the performance-relevant build (meta excluded) — used for ghost / record keys. */
  function buildHash(build) {
    if (!build || typeof build !== 'object') return '0';
    var b = {};
    Object.keys(build).forEach(function (k) { if (k !== 'meta') b[k] = build[k]; });
    return hashString(stableStringify(b)).toString(36);
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeRng(seed) {
    var r = mulberry32(seed);
    var f = function () { return r(); };
    f.range = function (a, b) { return a + (b - a) * r(); };
    f.int = function (a, b) { return a + Math.floor(r() * (b - a + 1)); };
    f.pick = function (arr) { return arr[Math.floor(r() * arr.length)]; };
    f.gauss = function () { var u = 1 - r(), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); };
    return f;
  }
  function seedFrom(v) {
    if (isNum(v)) return (Math.floor(Math.abs(v)) % 4294967296) >>> 0;
    if (typeof v === 'string' && v.length) return hashString(v);
    return null;
  }
  function boolish(v, d) { return v === undefined || v === null ? d : !!v; }
  function catalogFind(coll, id) {
    var D = CB.data;
    if (!D || id == null) return undefined;
    try {
      if (typeof D.find === 'function') return D.find(coll, id);
      var arr = D[coll];
      if (Array.isArray(arr)) for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i];
    } catch (e) { /* ignore */ }
    return undefined;
  }

  /* ======================================================================
     Fallback track (used when CB.race.tracks is missing or returns nothing)
     ====================================================================== */

  var FALLBACK_TRACK = {
    id: 'forge-test-loop', name: 'Redline Test Loop', country: 'Workshop', difficulty: 2,
    desc: 'Built-in proving loop used when the track catalog is unavailable.',
    width_m: 13, surface: { grip: 1 },
    theme: { grass: '#2f5d2a', asphalt: '#3a3a3e', kerbA: '#d22', kerbB: '#fff', sand: '#d8c38a', sky: '#8ab' },
    points: [[0, 0], [260, 0], [430, 12], [510, 85], [505, 180], [430, 238], [330, 222], [262, 262],
             [222, 334], [120, 352], [0, 332], [-82, 252], [-92, 122], [-62, 38]],
    pitStraight: 0, scenery: []
  };

  function catmullRomCentripetal(p0, p1, p2, p3, u) {
    function d(a, b) { return Math.max(1e-4, Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5)); }
    var t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    var t = t1 + (t2 - t1) * u;
    function L(a, b, ta, tb) { var w = (t - ta) / (tb - ta); return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]; }
    var A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
    var B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
    return L(B1, B2, t1, t2);
  }

  /** Minimal geometry builder with the same shape as tracks.build() output. */
  function buildFallbackGeom(def) {
    def = def && Array.isArray(def.points) && def.points.length >= 4 ? def : FALLBACK_TRACK;
    var P = def.points.map(function (p) { return Array.isArray(p) ? p : [p.x, p.y]; });
    var n = P.length, dense = [], SUB = 24, i, j;
    for (i = 0; i < n; i++) {
      var p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
      for (j = 0; j < SUB; j++) dense.push(catmullRomCentripetal(p0, p1, p2, p3, j / SUB));
    }
    var cum = [0], total = 0;
    for (i = 1; i <= dense.length; i++) {
      var a = dense[i - 1], b = dense[i % dense.length];
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
      cum.push(total);
    }
    var N = Math.max(16, Math.round(total / 2)), ds = total / N, pts = [], k = 0;
    for (i = 0; i < N; i++) {
      var target = i * ds;
      while (k < dense.length - 1 && cum[k + 1] < target) k++;
      var aa = dense[k], bb = dense[(k + 1) % dense.length], seg = cum[k + 1] - cum[k];
      var w = seg > 0 ? (target - cum[k]) / seg : 0;
      pts.push([aa[0] + (bb[0] - aa[0]) * w, aa[1] + (bb[1] - aa[1]) * w]);
    }
    var width = num(def.width_m, 12), samples = [];
    for (i = 0; i < N; i++) {
      var pp = pts[(i - 1 + N) % N], pn = pts[(i + 1) % N];
      samples.push({ x: pts[i][0], y: pts[i][1], heading: Math.atan2(pn[1] - pp[1], pn[0] - pp[0]), curvature: 0, s: i * ds, width: width });
    }
    for (i = 0; i < N; i++) {
      var hp = samples[(i - 1 + N) % N].heading, hn = samples[(i + 1) % N].heading;
      samples[i].curvature = wrapAngle(hn - hp) / (2 * ds);
    }
    for (i = 0; i < N; i++) {
      var kk = samples[i].curvature;
      samples[i].leftKerb = kk > 1 / 160;   // inside of a left-hander
      samples[i].rightKerb = kk < -1 / 160;
    }
    // racing line: iterative "string pulling" (curvature minimisation) within the track width
    var off = new Float64Array(N), lim = width / 2 - 1.6;
    for (var it = 0; it < 90; it++) {
      for (i = 0; i < N; i++) {
        var ia = (i - 4 + N) % N, ib = (i + 4) % N, sa = samples[ia], sb = samples[ib], si = samples[i];
        var ax = sa.x - Math.sin(sa.heading) * off[ia], ay = sa.y + Math.cos(sa.heading) * off[ia];
        var bx = sb.x - Math.sin(sb.heading) * off[ib], by = sb.y + Math.cos(sb.heading) * off[ib];
        var mx = (ax + bx) / 2, my = (ay + by) / 2;
        var o = (mx - si.x) * -Math.sin(si.heading) + (my - si.y) * Math.cos(si.heading);
        off[i] = clamp(lerp(off[i], o, 0.6), -lim, lim);
      }
    }
    return {
      id: def.id, def: def, samples: samples, length: total, width: width,
      sectors: [{ start: 0, end: total / 3 }, { start: total / 3, end: 2 * total / 3 }, { start: 2 * total / 3, end: total }],
      startLine: { s: 0, index: 0, x: samples[0].x, y: samples[0].y, heading: samples[0].heading },
      grid: [], racingLine: Array.prototype.slice.call(off), walls: !!def.walls, fallback: true
    };
  }

  /* ======================================================================
     Geometry adapter — normalises whatever tracks.build() returns into typed arrays
     ====================================================================== */

  function adaptGeom(raw, def) {
    def = def || {};
    var src = (raw && (raw.samples || raw.centerline || raw.center || raw.points || raw.pts || raw.nodes)) || [];
    var n = src.length;
    if (n < 8) throw new Error('CB.race.engine: track geometry has too few samples');
    var X = new Float64Array(n), Y = new Float64Array(n), H = new Float64Array(n), K = new Float64Array(n),
        S = new Float64Array(n), W = new Float64Array(n), TX = new Float64Array(n), TY = new Float64Array(n),
        SEG = new Float64Array(n), WL = new Float64Array(n), WR = new Float64Array(n),
        KL = new Float64Array(n), KR = new Float64Array(n), SL = new Uint8Array(n), SR = new Uint8Array(n),
        RL = new Float64Array(n), i, p;
    function px(p) { return Array.isArray(p) ? +p[0] : num(p.x, 0); }
    function py(p) { return Array.isArray(p) ? +p[1] : num(p.y, 0); }
    for (i = 0; i < n; i++) { X[i] = px(src[i]); Y[i] = py(src[i]); }
    for (i = 0; i < n; i++) { var j = (i + 1) % n; SEG[i] = Math.hypot(X[j] - X[i], Y[j] - Y[i]); }
    var haveS = true;
    for (i = 0; i < n; i++) { p = src[i]; if (Array.isArray(p) || !isNum(p.s)) { haveS = false; break; } }
    var acc = 0;
    for (i = 0; i < n; i++) { S[i] = haveS ? src[i].s : acc; acc += SEG[i]; }
    var L = firstNum(raw.length, raw.length_m, raw.totalLength, raw.total, raw.lapLength);
    if (!(L > S[n - 1])) L = S[n - 1] + SEG[n - 1];
    var defW = firstNum(raw.width, raw.width_m, def.width_m, 12);
    for (i = 0; i < n; i++) {
      p = src[i];
      var ip = (i - 1 + n) % n, inx = (i + 1) % n;
      var hh = !Array.isArray(p) && isNum(p.heading) ? p.heading : Math.atan2(Y[inx] - Y[ip], X[inx] - X[ip]);
      H[i] = hh; TX[i] = Math.cos(hh); TY[i] = Math.sin(hh);
      W[i] = Array.isArray(p) ? defW : firstNum(p.width, p.width_m, p.w, defW);
      if (!(W[i] > 2)) W[i] = defW;
    }
    for (i = 0; i < n; i++) {
      p = src[i];
      if (!Array.isArray(p) && isNum(p.curvature)) K[i] = p.curvature;
      else {
        var a0 = (i - 1 + n) % n, a1 = (i + 1) % n;
        K[i] = wrapAngle(H[a1] - H[a0]) / Math.max(0.1, SEG[a0] + SEG[i]);
      }
    }
    // street detection & barrier offsets
    var tag = [def.type, def.kind, def.category, def.style, def.id, def.name, raw.type, raw.kind,
               def.surface && def.surface.type, raw.surface && raw.surface.type].join(' ').toLowerCase();
    var street = def.walls === true || raw.walls === true || raw.hasWalls === true || def.street === true ||
                 raw.surfaceOutside === 'wall' || def.surfaceOutside === 'wall' || /street|city|urban|harbou?r/.test(tag);
    var wallGap = firstNum(def.wallGap_m, raw.wallGap_m, raw.wallGap, def.wallOffset_m, 1.2);
    var runoff = firstNum(def.runoff_m, raw.runoff_m, raw.runoff, 26);
    var maxHalfW = 0;
    for (i = 0; i < n; i++) {
      p = src[i];
      var hw = W[i] / 2;
      if (hw > maxHalfW) maxHalfW = hw;
      var o = Array.isArray(p) ? {} : p;
      var kl = o.leftKerb, kr = o.rightKerb;
      KL[i] = kl ? (isNum(kl) && kl > 0.2 && kl < 4 ? kl : (kl && isNum(kl.width) ? kl.width : 1.0)) : 0;
      KR[i] = kr ? (isNum(kr) && kr > 0.2 && kr < 4 ? kr : (kr && isNum(kr.width) ? kr.width : 1.0)) : 0;
      var wl = firstNum(o.wallLeft, o.leftWall, o.wallL, o.barrierLeft);
      var wr = firstNum(o.wallRight, o.rightWall, o.wallR, o.barrierRight);
      WL[i] = wl > hw ? wl : (street ? hw + wallGap : hw + runoff);
      WR[i] = wr > hw ? wr : (street ? hw + wallGap : hw + runoff);
      var outside = K[i] > 1 / 140 ? 'R' : K[i] < -1 / 140 ? 'L' : '';
      SL[i] = (o.leftRunoff === 'sand' || o.runoffL === 'sand' || o.runoffL === 'gravel' || o.sandL > 0 || o.sandLeft || o.gravelLeft || (!street && outside === 'L')) ? 1 : 0;
      SR[i] = (o.rightRunoff === 'sand' || o.runoffR === 'sand' || o.runoffR === 'gravel' || o.sandR > 0 || o.sandRight || o.gravelRight || (!street && outside === 'R')) ? 1 : 0;
    }
    // racing line offsets (+left)
    var rl = raw.racingLine;
    if (rl && !Array.isArray(rl) && typeof rl === 'object') rl = rl.offsets || rl.offset || rl.points || rl.samples || null;
    if (rl && (Array.isArray(rl) || ArrayBuffer.isView(rl)) && rl.length === n) {
      for (i = 0; i < n; i++) {
        var r = rl[i], v = 0;
        if (isNum(r)) v = r;
        else if (r && typeof r === 'object') {
          if (isNum(r.offset)) v = r.offset;
          else if (isNum(r.lateral)) v = r.lateral;
          else if (isNum(r.x) && isNum(r.y)) v = (r.x - X[i]) * -TY[i] + (r.y - Y[i]) * TX[i];
          else if (Array.isArray(r)) v = (r[0] - X[i]) * -TY[i] + (r[1] - Y[i]) * TX[i];
        } else if (Array.isArray(r)) v = (r[0] - X[i]) * -TY[i] + (r[1] - Y[i]) * TX[i];
        RL[i] = clamp(v, -W[i] / 2, W[i] / 2);
      }
    }
    // start line offset
    var sl = raw.startLine || raw.startFinish || raw.start || null, s0 = 0;
    if (sl && isNum(sl.s)) s0 = sl.s;
    else if (sl && isNum(sl.index) && sl.index >= 0 && sl.index < n) s0 = S[sl.index | 0];
    else if (isNum(raw.startS)) s0 = raw.startS;
    s0 = wrapS(s0, L);

    var A = {
      raw: raw, def: def, n: n, L: L, s0: s0, X: X, Y: Y, H: H, K: K, S: S, W: W, TX: TX, TY: TY, SEG: SEG,
      WL: WL, WR: WR, KL: KL, KR: KR, SL: SL, SR: SR, RL: RL, street: street, maxHalfW: maxHalfW,
      ds: L / n, win: 0, grip: firstNum(def.surface && def.surface.grip, raw.surface && raw.surface.grip, raw.grip, 1)
    };
    A.win = Math.max(12, Math.ceil(60 / Math.max(0.5, A.ds)));
    A.b = parseSectors(raw, A);
    A.slots = parseGrid(raw, A);
    return A;
  }

  function parseSectors(raw, A) {
    var L = A.L, list = raw.sectors || raw.sectorBounds || raw.sectorBoundaries || null, vals = [];
    if (list && !Array.isArray(list) && typeof list === 'object') list = list.boundaries || list.bounds || list.list || null;
    if (Array.isArray(list)) {
      list.forEach(function (it) {
        if (isNum(it)) vals.push(it);
        else if (it && typeof it === 'object') {
          var v = firstNum(it.end, it.endS, it.s_end, it.s, it.start, it.startS);
          if (v === undefined) {
            var ix = firstNum(it.endIndex, it.index, it.startIndex);
            if (ix !== undefined && ix >= 0 && ix < A.n) v = A.S[ix | 0];
          }
          if (v !== undefined) vals.push(v);
        }
      });
    }
    if (vals.length && vals.every(function (v) { return v >= 0 && v <= 1.0001; }) && L > 10) vals = vals.map(function (v) { return v * L; });
    vals = vals.map(function (v) { return wrapS(v - A.s0, L); })
               .filter(function (v) { return v > 0.04 * L && v < 0.96 * L; })
               .sort(function (a, b) { return a - b; });
    var uniq = [];
    vals.forEach(function (v) { if (!uniq.length || v - uniq[uniq.length - 1] > 5) uniq.push(v); });
    if (uniq.length >= 2) return [uniq[0], uniq[1]];
    if (uniq.length === 1) return uniq[0] < L / 2 ? [uniq[0], (uniq[0] + L) / 2] : [uniq[0] / 2, uniq[0]];
    return [L / 3, 2 * L / 3];
  }

  function parseGrid(raw, A) {
    var g = raw.grid || raw.gridSlots || null;
    if (g && !Array.isArray(g) && typeof g === 'object') g = g.slots || g.list || null;
    var out = [];
    if (Array.isArray(g)) {
      g.forEach(function (sl) {
        if (!sl) return;
        var x = Array.isArray(sl) ? sl[0] : sl.x, y = Array.isArray(sl) ? sl[1] : sl.y;
        if (!isNum(x) || !isNum(y)) return;
        var h = Array.isArray(sl) ? sl[2] : firstNum(sl.heading, sl.angle, sl.h);
        if (!isNum(h)) h = A.H[projectA(A, x, y, -1).index];
        out.push({ x: x, y: y, heading: h });
      });
    }
    return out;
  }

  /** Index of the sample whose S is the last <= sAbs (binary search). */
  function indexAtAbsS(A, sAbs) {
    var S = A.S, lo = 0, hi = A.n - 1;
    sAbs = wrapS(sAbs, A.L);
    if (sAbs >= S[hi]) return hi;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (S[mid] <= sAbs) lo = mid; else hi = mid - 1; }
    return lo;
  }
  /** Pose at lap-distance s (relative to the start line) and lateral offset (+left). */
  function poseAt(A, lapS, lateral) {
    var sAbs = wrapS(lapS + A.s0, A.L), i = indexAtAbsS(A, sAbs), j = (i + 1) % A.n;
    var segS = (j === 0 ? A.L : A.S[j]) - A.S[i], w = segS > 0 ? clamp((sAbs - A.S[i]) / segS, 0, 1) : 0;
    var x = lerp(A.X[i], A.X[j], w), y = lerp(A.Y[i], A.Y[j], w);
    var h = A.H[i] + wrapAngle(A.H[j] - A.H[i]) * w;
    lateral = lateral || 0;
    return { x: x - Math.sin(h) * lateral, y: y + Math.cos(h) * lateral, heading: wrapAngle(h), index: i };
  }

  /** Closest-point projection with local search from a hint index (falls back to a global scan). */
  function projectA(A, x, y, hint) {
    var n = A.n, X = A.X, Y = A.Y, best = -1, bd = Infinity, i, k, dx, dy, d;
    if (hint >= 0 && hint < n) {
      var lo = -A.win, hi = A.win;
      for (k = lo; k <= hi; k++) {
        i = hint + k; if (i < 0) i += n; else if (i >= n) i -= n;
        dx = x - X[i]; dy = y - Y[i]; d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      var lim = A.maxHalfW + 45;
      if (bd > lim * lim) best = -1;
    }
    if (best < 0) {
      bd = Infinity;
      for (i = 0; i < n; i++) { dx = x - X[i]; dy = y - Y[i]; d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
    }
    // refine onto the neighbouring segments
    var ia = (best - 1 + n) % n, segA = ia, segB = best, bestT = 0, bestD = Infinity, bestSeg = best;
    for (var pass = 0; pass < 2; pass++) {
      var a = pass === 0 ? segA : segB, b = (a + 1) % n;
      var ex = X[b] - X[a], ey = Y[b] - Y[a], len2 = ex * ex + ey * ey;
      var t = len2 > 0 ? clamp(((x - X[a]) * ex + (y - Y[a]) * ey) / len2, 0, 1) : 0;
      var qx = X[a] + ex * t - x, qy = Y[a] + ey * t - y, qd = qx * qx + qy * qy;
      if (qd < bestD) { bestD = qd; bestT = t; bestSeg = a; }
    }
    var a2 = bestSeg, b2 = (a2 + 1) % n;
    var sAbs = A.S[a2] + A.SEG[a2] * bestT;
    var ex2 = X[b2] - X[a2], ey2 = Y[b2] - Y[a2], el = Math.hypot(ex2, ey2) || 1;
    var tx = ex2 / el, ty = ey2 / el;
    var bx = X[a2] + ex2 * bestT, by = Y[a2] + ey2 * bestT;
    var lateral = tx * (y - by) - ty * (x - bx);
    var idx = bestT > 0.5 ? b2 : a2;
    return { index: idx, seg: a2, s: wrapS(sAbs, A.L), lateral: lateral, dist: Math.sqrt(bestD) };
  }

  function surfaceFromLateral(A, i, lat) {
    var hw = A.W[i] / 2, al = Math.abs(lat), left = lat >= 0;
    if (left ? lat > A.WL[i] : -lat > A.WR[i]) return 'wall';
    if (al <= hw) return 'asphalt';
    var kw = left ? A.KL[i] : A.KR[i];
    if (kw > 0 && al <= hw + kw) return 'kerb';
    if (!kw && al <= hw + 0.5) return 'kerb';         // painted strip / tolerance
    if ((left ? A.SL[i] : A.SR[i]) && al > hw + 6) return 'sand';
    return 'grass';
  }

  /* ======================================================================
     Fallback vehicle model (planar dynamic bicycle, used if CB.race.vehicle is missing)
     ====================================================================== */

  var COMPOUND_MU = { eco: 0.82, 'all-season': 0.88, winter: 0.84, touring: 0.92, performance: 1.02, 'super-sport': 1.1, track: 1.2, slick: 1.35 };
  var COMPOUND_WET = { eco: 0.62, 'all-season': 0.7, winter: 0.72, touring: 0.68, performance: 0.66, 'super-sport': 0.6, track: 0.5, slick: 0.35 };
  var ASP_MULT = { na: 1, turbo: 1.35, 'twin-turbo': 1.45, 'quad-turbo': 1.6, supercharged: 1.3, twincharged: 1.5, 'electric-turbo': 1.42 };
  var TUNE_MULT = { eco: 0.9, stock: 1, stage1: 1.1, stage2: 1.2, stage3: 1.32, 'time-attack': 1.45 };
  var SHIFT_T = { manual: 0.35, dct: 0.08, auto: 0.22, cvt: 0.0, sequential: 0.1, 'single-speed': 0 };
  var OVERHANG = { coupe: 1.85, sedan: 2.05, hatchback: 1.5, wagon: 2.1, suv: 2.0, roadster: 1.6, pickup: 2.6, hypercar: 1.95, 'shooting-brake': 2.0, van: 2.3 };

  function estimatePower_kw(build) {
    var e = build.engine || {}, kw;
    if (e.type === 'ev') kw = num(e.motors, 2) * num(e.motorPower_kw, 200);
    else {
      var na = num(e.displacement_l, 3) * 62;
      kw = na * (ASP_MULT[e.aspiration] || 1) * (TUNE_MULT[e.tune] || 1) * (1 + Math.max(0, num(e.boost_bar, 0) - 1) * 0.15);
      if (e.type === 'hybrid') kw += num(e.motors, 1) * num(e.motorPower_kw, 80) * 0.6;
    }
    return clamp(kw, 40, 1500);
  }
  function estimateMass(build) {
    var bs = catalogFind('bodyStyles', build.body && build.body.style);
    var m = num(bs && bs.baseWeight_kg, 1400);
    var e = build.engine || {};
    if (e.type === 'ev') m += num(e.battery_kwh, 80) * 5.5 - 120;
    else m += num(e.displacement_l, 3) * 22;
    if (build.weight) { if (build.weight.rollCage === 'full') m += 45; m += num(build.weight.ballast_kg, 0); }
    return clamp(m, 600, 3500);
  }

  var FallbackVehicle = {
    isFallback: true,
    velocityFrame: 'body',
    fromBuild: function (build, metrics) {
      build = build || {};
      var body = build.body || {}, eng = build.engine || {}, tr = build.transmission || {}, dtn = build.drivetrain || {},
          ti = build.tires || {}, wh = build.wheels || {}, br = build.brakes || {}, ae = build.aero || {};
      metrics = metrics || {};
      var mass = firstNum(metrics.weight_kg, estimateMass(build));
      var power = firstNum(metrics.power_kw, estimatePower_kw(build));
      var ev = eng.type === 'ev';
      var redline = ev ? 16000 : firstNum(metrics.redlineRpm, eng.redline_rpm, 7000);
      var peakTorque = firstNum(metrics.torque_nm, power * 1000 / ((redline * 0.6) * TAU / 60) * 1.25);
      var wb = num(body.wheelbase_mm, 2650) / 1000;
      var wf = isNum(metrics.weightFront_pct) ? metrics.weightFront_pct / 100 :
        (eng.position === 'mid' ? 0.43 : eng.position === 'rear' ? 0.39 : 0.55);
      var a = wb * (1 - wf), b = wb * wf;
      var comp = catalogFind('tireCompounds', ti.compound);
      var mu = firstNum(comp && comp.mu, COMPOUND_MU[ti.compound], 1.0);
      var wetMu = firstNum(comp && comp.wetMu, COMPOUND_WET[ti.compound], mu * 0.65);
      var rw = num(wh.diameter_in, 19) * 0.0254 / 2 + num(ti.widthRear_mm, 255) * num(ti.profileRear, 35) / 100 / 1000;
      var ratios = Array.isArray(tr.ratios) && tr.ratios.length ? tr.ratios.slice() : [3.6, 2.4, 1.8, 1.4, 1.12, 0.92];
      var fin = num(tr.finalDrive, 3.4);
      if (ev || ratios.length === 1) {   // single-speed: pick overall ratio so redline ~ 270 km/h
        ratios = [1];
        fin = (redline * TAU / 60) * rw / 75;
      }
      var layout = dtn.layout || 'rwd';
      var split = layout === 'fwd' ? 1 : layout === 'awd' ? clamp(num(dtn.torqueSplitFront_pct, 40) / 100, 0.1, 0.9) : 0;
      var cda = firstNum(metrics.cda, num(metrics.cd, 0.32) * num(metrics.frontalArea_m2, 2.05), 0.66);
      var df = firstNum(metrics.downforce_kg_200, 0);
      if (!isNum(metrics.downforce_kg_200)) {
        ['splitters', 'wings', 'diffusers'].forEach(function (k, ix) {
          var id = [ae.splitter, ae.wing, ae.diffuser][ix];
          var o = CB.data && CB.data.aero && Array.isArray(CB.data.aero[k]) ? CB.data.aero[k].filter(function (q) { return q.id === id; })[0] : null;
          if (o) df += num(o.downforce_kg_at_200, 0);
        });
      }
      var wF = num(ti.widthFront_mm, 245) / 245, wR = num(ti.widthRear_mm, 265) / 245;
      var prF = 1 - (num(ti.profileFront, 40) - 35) / 160, prR = 1 - (num(ti.profileRear, 40) - 35) / 160;
      var bm = catalogFind('brakeMaterials', br.material);
      return Object.freeze({
        fallback: true, mass: mass, Iz: mass * a * b * 1.05, a: a, b: b, wb: wb, cgH: firstNum(metrics.cgHeight_mm, 500) / 1000,
        track: num(body.trackWidth_mm, 1600) / 1000, power: power, peakTorque: peakTorque, redline: redline, idle: ev ? 0 : 900,
        ratios: ratios, final: fin, rw: rw, eff: 0.88, shiftTime: firstNum(SHIFT_T[tr.type], 0.15), ev: ev,
        frontSplit: split, mu: mu, wetMu: wetMu, CaF: 88000 * wF * prF * mu, CaR: 98000 * wR * prR * mu,
        kDrag: 0.5 * 1.225 * cda, kDown: df * GRAV / (55.556 * 55.556), rollRes: 0.013,
        brakeForce: mass * GRAV * 1.3 * firstNum(bm && bm.frictionMult, 1), brakeBias: 0.63,
        maxSteer: 0.58, abs: br.abs !== 'off', tc: num(dtn.tractionControl, 2) > 0, redlineRpm: redline,
        gears: ratios.length, maxGear: ratios.length
      });
    },
    createState: function (p, pose) {
      pose = pose || {};
      return {
        x: num(pose.x, 0), y: num(pose.y, 0), heading: num(pose.heading, 0), vx: num(pose.speed, 0), vy: 0, yawRate: 0,
        speed: num(pose.speed, 0), rpm: p.idle, gear: 1, slipAngleF: 0, slipAngleR: 0, wheelspin: 0, skidding: 0,
        steerAngle: 0, shiftT: 0, reverse: false, revHold: 0, axLong: 0, redline: p.redline
      };
    },
    step: function (p, st, inp, dt, env) {
      inp = inp || {}; env = env || {};
      var throttle = clamp01(num(inp.throttle, 0)), brake = clamp01(num(inp.brake, 0));
      var steerIn = clamp(num(inp.steer, 0), -1, 1), hb = !!inp.handbrake;
      var gm = num(env.gripMult, 1), mu = (env.wet ? p.wetMu : p.mu) * gm;
      var vx = st.vx, vy = st.vy, r = st.yawRate;
      var speed = Math.sqrt(vx * vx + vy * vy);
      // steering (speed sensitive, slew limited)
      var q = speed / 24, maxSt = p.maxSteer * (0.28 + 0.72 / (1 + q * q));
      var tgt = steerIn * maxSt, rate = 3.0 * dt;
      st.steerAngle += clamp(tgt - st.steerAngle, -rate, rate);
      var d = st.steerAngle;
      // reverse handling (hold brake at standstill, or explicit reverse request)
      if (!st.reverse && ((brake > 0.6 && throttle < 0.05 && vx < 0.3 && speed < 0.8) || (inp.reverse && speed < 1.5))) {
        st.revHold += dt; if (st.revHold > 0.35 || inp.reverse) st.reverse = true;
      } else if (!st.reverse) st.revHold = 0;
      if (st.reverse && !inp.reverse && throttle > 0.1 && vx > -0.8) { st.reverse = false; st.revHold = 0; }
      var drive = st.reverse ? (inp.reverse ? Math.max(throttle, brake) : brake) : throttle;
      var brakeP = st.reverse ? (inp.reverse ? 0 : throttle) : brake;
      // gearbox
      if (st.shiftT > 0) st.shiftT -= dt;
      var nG = p.ratios.length, autoShift = env.autoShift !== false;
      if (!autoShift && st.shiftT <= 0) {
        if (inp.shiftUp && st.gear < nG) { st.gear++; st.shiftT = p.shiftTime; }
        else if (inp.shiftDown && st.gear > 1) { st.gear--; st.shiftT = p.shiftTime; }
      }
      var wheelW = Math.abs(vx) / p.rw;
      var ratio = p.ratios[(st.reverse ? 1 : st.gear) - 1] * p.final;
      var rpm = Math.max(p.idle, wheelW * ratio * 60 / TAU);
      if (autoShift && !st.reverse && st.shiftT <= 0) {
        if (rpm > p.redline * 0.95 && st.gear < nG) { st.gear++; st.shiftT = p.shiftTime; }
        else if (st.gear > 1) {
          var lowR = p.ratios[st.gear - 2] * p.final, rpmLow = wheelW * lowR * 60 / TAU;
          if (rpmLow < p.redline * 0.78 && rpm < p.redline * 0.52) { st.gear--; st.shiftT = p.shiftTime * 0.6; }
        }
      }
      ratio = p.ratios[(st.reverse ? 1 : st.gear) - 1] * p.final;
      rpm = Math.max(p.idle, wheelW * ratio * 60 / TAU);
      if (!st.reverse && speed < 4 && drive > 0.2) rpm = Math.max(rpm, p.ev ? rpm : p.redline * 0.45 * drive);
      // torque & drive force
      var rn = clamp(rpm / p.redline, 0, 1.1);
      var shape = p.ev ? 1 : clamp(0.72 + 0.28 * (1 - Math.pow((rn - 0.62) / 0.62, 2)), 0.45, 1);
      var F = drive * p.peakTorque * shape * ratio * p.eff / p.rw;
      F = Math.min(F, drive * p.power * 1000 * p.eff / Math.max(Math.abs(vx), 2.5));
      if (!st.reverse && rpm >= p.redline * 1.01) F = 0;
      if (st.shiftT > 0) F *= 0.12;
      if (st.reverse) F = -Math.min(F, p.mass * 3.2);
      // loads
      var down = p.kDown * speed * speed, Fz = p.mass * GRAV + down;
      var dz = p.mass * st.axLong * p.cgH / p.wb;
      var Fzf = Math.max(0.12 * Fz, Fz * p.b / p.wb - dz), Fzr = Math.max(0.12 * Fz, Fz * p.a / p.wb + dz);
      var capF = mu * Fzf, capR = mu * Fzr;
      var FxF = F * p.frontSplit, FxR = F * (1 - p.frontSplit), spin = 0, skid = 0;
      var tc = env.tc !== undefined ? !!env.tc : p.tc;
      // traction control is friction-circle aware: it keeps the lateral force the axle used last step available
      var resR = tc ? Math.sqrt(Math.max(0.06, 1 - 0.92 * Math.pow(Math.min(1, num(st.fyRatioR, 0)), 2))) : 1;
      var resF = tc ? Math.sqrt(Math.max(0.06, 1 - 0.92 * Math.pow(Math.min(1, num(st.fyRatioF, 0)), 2))) : 1;
      if (Math.abs(FxR) > capR * resR) { spin = Math.max(spin, 1 - capR * resR / Math.abs(FxR)); FxR = sign(FxR) * capR * resR * (tc ? 0.97 : 0.86); }
      if (Math.abs(FxF) > capF * resF) { spin = Math.max(spin, 1 - capF * resF / Math.abs(FxF)); FxF = sign(FxF) * capF * resF * (tc ? 0.97 : 0.86); }
      if (tc) spin *= 0.25;
      // brakes
      var sgnx = vx >= 0 ? 1 : -1, lockF = false, lockR = false;
      if (brakeP > 0 || hb) {
        var Fb = brakeP * p.brakeForce, BF = Fb * p.brakeBias, BR = Fb * (1 - p.brakeBias);
        var abs = env.abs !== undefined ? !!env.abs : p.abs;
        if (abs) {   // ABS + EBD: keep lateral reserve (rear especially) for stability under trail-braking
          var rF = Math.sqrt(Math.max(0.1, 1 - 0.85 * Math.pow(Math.min(1, num(st.fyRatioF, 0)), 2)));
          var rR = Math.sqrt(Math.max(0.1, 1 - 0.95 * Math.pow(Math.min(1, num(st.fyRatioR, 0)), 2)));
          BF = Math.min(BF, capF * 0.92 * rF); BR = Math.min(BR, capR * 0.78 * rR);
        }
        if (BF > capF) { lockF = true; BF = capF * 0.82; }
        if (hb) { BR = Math.max(BR, capR * 0.9); lockR = true; }
        if (BR > capR) { lockR = true; BR = capR * 0.82; }
        if (Math.abs(vx) > 0.05) { FxF -= sgnx * BF; FxR -= sgnx * BR; }
        if (lockF || lockR) skid = Math.min(1, speed / 20);
      }
      // lateral tyre forces (combined slip via friction circle)
      var vxs = Math.max(Math.abs(vx), 3.0);
      var aF = Math.atan2(vy + p.a * r, vxs) - d * sgnx, aR = Math.atan2(vy - p.b * r, vxs);
      var latF = Math.sqrt(Math.max(0, capF * capF - FxF * FxF)), latR = Math.sqrt(Math.max(0, capR * capR - FxR * FxR));
      if (lockF) latF *= 0.4;
      if (lockR) latR *= hb ? 0.32 : 0.45;
      // brush-like saturation; the front falls off past the peak, the rear holds on (stable, understeer at the limit
      // like a road car's setup) unless it is locked/handbraked or overpowered (latR shrinks via the friction circle)
      function tyre(alpha, C, cap, fall) {
        if (cap < 1) return 0;
        var x = C * alpha / cap, y = Math.tanh(x), ax = Math.abs(x);
        if (ax > 2) y *= 1 - fall * Math.min(ax - 2, 3);
        return cap * y;
      }
      var FyF = -tyre(aF, p.CaF, latF, 0.07), FyR = -tyre(aR, p.CaR, latR * (lockR ? 1 : 1.06), lockR ? 0.07 : 0.0);
      st.fyRatioF = capF > 1 ? Math.abs(FyF) / capF : 0; st.fyRatioR = capR > 1 ? Math.abs(FyR) / capR : 0;
      if (Math.abs(aR) > 0.12 && speed > 8) skid = Math.max(skid, clamp((Math.abs(aR) - 0.12) * 4, 0, 1));
      var cd = Math.cos(d), sd = Math.sin(d);
      var Fdx = -p.kDrag * speed * vx, Fdy = -p.kDrag * speed * vy;
      var Frx = -p.rollRes * p.mass * GRAV * clamp(vx / 0.5, -1, 1);
      var Fx = FxR + FxF * cd - FyF * sd + Fdx + Frx;
      var Fy = FyR + FyF * cd + FxF * sd + Fdy;
      var Mz = p.a * (FyF * cd + FxF * sd) - p.b * FyR;
      var axb = Fx / p.mass, ayb = Fy / p.mass;
      st.axLong = lerp(st.axLong, clamp(axb, -15, 15), 0.15);
      var pvx = vx;
      vx += (axb + vy * r) * dt;
      vy += (ayb - vx * r) * dt;
      r += Mz / p.Iz * dt;
      // never let braking/rolling resistance reverse the direction of travel
      if (!st.reverse && pvx >= 0 && vx < 0 && F <= 0) vx = 0;
      if (st.reverse && pvx <= 0 && vx > 0 && F >= 0) vx = 0;
      // low-speed blending to a kinematic model (stable at standstill)
      var sp2 = Math.sqrt(vx * vx + vy * vy), w = clamp((sp2 - 0.6) / 3.4, 0, 1);
      var rk = vx * Math.tan(d) / p.wb;
      r = w * r + (1 - w) * rk;
      vy *= w + (1 - w) * 0.8;
      if (sp2 < 0.25 && brakeP > 0.1 && drive < 0.05) { vx = 0; vy = 0; r = 0; }
      st.heading = wrapAngle(st.heading + r * dt);
      var c = Math.cos(st.heading), s = Math.sin(st.heading);
      st.x += (vx * c - vy * s) * dt;
      st.y += (vx * s + vy * c) * dt;
      st.vx = vx; st.vy = vy; st.yawRate = r;
      st.speed = Math.sqrt(vx * vx + vy * vy) * (vx < -0.05 ? -1 : 1);
      st.rpm = clamp(rpm, 0, p.redline * 1.02);
      st.slipAngleF = aF; st.slipAngleR = aR; st.wheelspin = clamp01(spin); st.skidding = clamp01(skid);
      st.gearDisplay = st.reverse ? -1 : st.gear;
      return st;
    }
  };

  /* ======================================================================
     Fallback AI driver (pure pursuit on the racing line + speed profile)
     ====================================================================== */

  function FallbackDriver(sess, car, opp) {
    this.A = sess.A; this.car = car;
    this.skill = clamp01(num(opp && opp.skill, 0.75));
    this.aggr = clamp01(num(opp && opp.aggression, 0.5));
    this.offset = 0; this.steerSign = 1; this.signAcc = 0; this.signN = 0; this.lastSteer = 0;
    var p = car.params || {}, A = this.A, n = A.n;
    var mu = num(p.mu, 1.0) * num(sess.weather.grip, 1) * num(A.grip, 1) * (sess.weather.wet ? 0.75 : 1);
    var kd = num(p.kDown, 0) / num(p.mass, 1400);
    var useLat = 0.82 + 0.13 * this.skill, aBrake = mu * GRAV * (0.68 + 0.18 * this.skill);
    var v = new Float64Array(n), i, k;
    for (i = 0; i < n; i++) {
      var kmax = 0;
      for (k = -3; k <= 3; k++) kmax = Math.max(kmax, Math.abs(A.K[(i + k + n) % n]));
      var den = kmax - mu * useLat * kd;
      v[i] = den > 1e-5 ? Math.min(88, Math.sqrt(mu * useLat * GRAV / den)) : 88;
    }
    for (var pass = 0; pass < 2; pass++) {
      for (i = n - 1; i >= 0; i--) {
        var j = (i + 1) % n;
        v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * aBrake * A.SEG[i]));
      }
    }
    this.prof = v;
  }
  FallbackDriver.prototype.control = function (st, ctx) {
    var A = this.A, me = ctx.self || {}, i = num(me.index, 0), speed = Math.abs(num(st.speed, 0));
    var input = { throttle: 0, brake: 0, steer: 0, handbrake: false, shiftUp: false, shiftDown: false };
    var phase = ctx.phase;
    if (phase === 'grid' || phase === 'countdown') { input.brake = 1; return input; }
    // steering convention is fixed by the vehicle contract: +steer = left (CCW yaw). (Learning it online proved
    // fragile — a collision-induced yaw kick can flip the estimate.)
    var Ld = 6 + speed * 0.5;
    var ahead = Math.round(Ld / A.ds), idx = (i + ahead) % A.n;
    var want = A.RL[idx];
    var lim = A.W[idx] / 2 - 1.3, brakeFor = 0;
    var near = ctx.nearby || [];
    for (var k = 0; k < near.length; k++) {
      var o = near[k];
      if (o.ahead > 0 && o.ahead < 32 && Math.abs(o.side) < 2.6 && o.speed < speed + 1.5) {
        want = o.lateral + (o.lateral > num(me.lateral, 0) ? -3.2 : 3.2);
        if (o.ahead < 9 + speed * 0.12 && o.speed < speed - 1) brakeFor = Math.max(brakeFor, clamp((speed - o.speed) / 10, 0, 0.6));
      }
    }
    this.offset += clamp(want - this.offset, -2.5 / 120, 2.5 / 120);
    var off = clamp(this.offset, -lim, lim);
    var tx = A.X[idx] - A.TY[idx] * off, ty = A.Y[idx] + A.TX[idx] * off;
    var alpha = wrapAngle(Math.atan2(ty - st.y, tx - st.x) - st.heading);
    var wb = num(this.car.params && this.car.params.wb, 2.65);
    var delta = Math.atan2(2 * wb * Math.sin(alpha), Ld);
    var q = speed / 24, maxSt = 0.58 * (0.28 + 0.72 / (1 + q * q));
    input.steer = clamp(delta / maxSt, -1, 1) * this.steerSign;
    this.lastSteer = input.steer * this.steerSign;
    var vt = this.prof[(i + Math.round((2 + speed * 0.15) / A.ds)) % A.n] * (0.9 + 0.1 * this.skill);
    if (ctx.surface === 'grass' || ctx.surface === 'sand') vt *= 0.6;
    if (Math.abs(alpha) > 1.1) vt = Math.min(vt, 9);
    if (ctx.finished) vt *= 0.6;
    var err = vt - speed;
    input.throttle = err > 0 ? clamp(0.35 + err * 0.3, 0, 1) : 0;
    // progressive throttle out of corners; lift if the rear steps out (yaw-stability "feel")
    input.throttle *= 1 - 0.55 * Math.min(1, Math.abs(input.steer));
    var aR = Math.abs(num(st.slipAngleR, 0));
    if (speed > 6 && aR > 0.09) input.throttle *= clamp(1 - (aR - 0.09) * 9, 0, 1);
    input.brake = Math.max(err < -0.8 ? clamp(-err * 0.2, 0, 1) : 0, brakeFor);
    if (input.brake > 0.05) input.throttle = 0;
    return input;
  };

  /* ======================================================================
     Fallback opponent grid (used when CB.race.ai is missing)
     ====================================================================== */

  var FALLBACK_NAMES = [
    ['Luca Ferrand', 'Scuderia Vela'], ['Mika Halvorsen', 'Nordlys Racing'], ['Ines Carvalho', 'Atlântico Motorsport'],
    ['Kenji Arakawa', 'Kurogane Works'], ['Sofia Lindqvist', 'Polar Engineering'], ['Theo Marchetti', 'Officina Rossa'],
    ['Amara Okafor', 'Lagos Velocity'], ['Jonas Brenner', 'Eisenwerk GP'], ['Chloé Delacroix', 'Équipe Céleste'],
    ['Rafael Ortega', 'Sierra Competición'], ['Priya Raman', 'Monsoon Dynamics']
  ];
  var FALLBACK_COLORS = [['#1f4fd1', '#ffffff'], ['#f2c200', '#111111'], ['#0f8a5f', '#f5f5f5'], ['#e8e8e8', '#c8102e'],
    ['#ff6a00', '#1a1a1a'], ['#6b2fb5', '#f2c200'], ['#00a7c7', '#0b1f3a'], ['#222222', '#ff3344'], ['#c8102e', '#ffffff'],
    ['#8a9a5b', '#2b2b2b'], ['#ff4fa3', '#141414']];

  function fallbackGrid(playerBuild, count, cfg, rng) {
    var presets = CB.data && Array.isArray(CB.data.presets) ? CB.data.presets : [];
    var out = [], diff = { rookie: 0.45, amateur: 0.65, pro: 0.82, alien: 0.96 }[cfg.difficulty] || 0.65;
    for (var i = 0; i < count; i++) {
      var b = deepClone(playerBuild);
      var usePreset = presets.length && (cfg.field === 'presets' || (cfg.field === 'mixed' && i % 2 === 1));
      if (usePreset) {
        var pr = presets[i % presets.length];
        var base = CB.data.defaultBuild ? CB.data.defaultBuild() : deepClone(playerBuild);
        b = deepMergeSimple(base, pr.build || {});
      } else if (b && b.engine) {
        b.engine = Object.assign({}, b.engine);
        if (b.engine.type === 'ev') b.engine.motorPower_kw = Math.round(num(b.engine.motorPower_kw, 200) * rng.range(0.9, 1.08));
        else b.engine.displacement_l = round(num(b.engine.displacement_l, 3) * rng.range(0.9, 1.1), 1);
      }
      var nm = FALLBACK_NAMES[i % FALLBACK_NAMES.length], col = FALLBACK_COLORS[i % FALLBACK_COLORS.length];
      if (b && b.exterior) { b.exterior = Object.assign({}, b.exterior, { paint: col[0], stripeColor: col[1] }); }
      out.push({
        id: 'ai-' + (i + 1), name: nm[0], team: nm[1], number: String(2 + i * 3 % 97), color: col[0], accent: col[1],
        build: b, skill: clamp01(diff + rng.range(-0.08, 0.06)), aggression: rng.range(0.2, 0.8), consistency: rng.range(0.6, 0.95)
      });
    }
    return out;
  }
  function deepMergeSimple(a, b) {
    if (CB.util && typeof CB.util.deepMerge === 'function') { try { return CB.util.deepMerge(a, b); } catch (e) { /* fallthrough */ } }
    var out = deepClone(a) || {};
    Object.keys(b || {}).forEach(function (k) {
      var v = b[k];
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? deepMergeSimple(out[k], v) : deepClone(v);
    });
    return out;
  }

  var FALLBACK_BUILD = {
    version: 1, meta: { name: 'Race Build', id: 'b_race', presetId: null },
    body: { style: 'coupe', chassisMaterial: 'aluminum', wheelbase_mm: 2650, trackWidth_mm: 1600, doors: 2, seats: 2 },
    engine: { type: 'ice', layout: 'V8', displacement_l: 4.0, aspiration: 'twin-turbo', boost_bar: 1.2, compression: 10, fuel: 'premium',
      redline_rpm: 7500, position: 'front', tune: 'stock', exhaust: 'sport', cooling: 'standard', motors: 2, motorPower_kw: 200,
      battery_kwh: 85, chemistry: 'nmc', voltage: 800, regen: 2 },
    transmission: { type: 'dct', gears: 7, ratios: [3.8, 2.6, 1.9, 1.45, 1.15, 0.95, 0.78], finalDrive: 3.42, launchControl: true },
    drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: false, tractionControl: 2 },
    suspension: { type: 'double-wishbone', springFront_nmm: 60, springRear_nmm: 70, damping: 5, rideHeight_mm: 120, camberFront_deg: -1.5,
      camberRear_deg: -1, toeFront_deg: 0, toeRear_deg: 0.1, arbFront: 5, arbRear: 4 },
    brakes: { material: 'iron', frontRotor_mm: 360, rearRotor_mm: 330, frontPistons: 6, rearPistons: 4, abs: 'sport' },
    wheels: { design: 'y-spoke', material: 'cast', diameter_in: 19, widthFront_in: 9, widthRear_in: 10.5, finish: '#2b2b2b', staggered: true },
    tires: { compound: 'performance', widthFront_mm: 255, widthRear_mm: 295, profileFront: 35, profileRear: 30 },
    aero: { splitter: 'lip', wing: 'none', wingAngle_deg: 6, diffuser: 'mild', canards: false, sideSkirts: true, activeAero: false },
    weight: { soundDeadening: true, rearSeats: true, spareTire: false, glass: 'standard', battery: 'lead', rollCage: 'none', ballast_kg: 0, ballastPosition: 'center' },
    exterior: { paint: '#b3121f', finish: 'metallic', roof: 'body', roofColor: '#111111', stripe: 'none', stripeColor: '#ffffff',
      caliperColor: '#f2c200', windowTint_pct: 20, lights: 'led', mirrors: 'body', badge: 'chrome', livery_number: '' },
    interior: {}, tech: {}
  };

  /* ======================================================================
     Lap tracker — anti-cut: sectors must be passed in order, line crossings with "debt"
     ====================================================================== */

  function LapTracker(L, b1, b2, behindLine) {
    this.L = L; this.b = [b1, b2]; this.cp = 0; this.debt = behindLine ? 1 : 0; this.lap = 0;
  }
  /** Advance from sOld to sNew (lap-s). Returns an array of crossing records (usually empty). */
  LapTracker.prototype.advance = function (sOld, sNew) {
    var L = this.L, d = sNew - sOld, out = null, k;
    if (d < -L / 2) {                         // forward over the line
      var dist = (L - sOld) + sNew, frac = dist > 0 ? (L - sOld) / dist : 1;
      out = [this._lineForward(frac)];
    } else if (d > L / 2) {                   // backwards over the line
      if (this.debt === 0 && this.cp > 0) this.cp = 0;
      this.debt++;
    } else if (d > 0) {
      if (this.debt === 0) {
        for (k = 0; k < 2; k++) {
          var b = this.b[k];
          if (this.cp === k && sOld < b && sNew >= b) {
            this.cp = k + 1;
            (out || (out = [])).push({ kind: 'sector', k: k, frac: (b - sOld) / d });
          }
        }
      }
    } else if (d < 0) {
      if (this.debt === 0) {
        for (k = 1; k >= 0; k--) {
          var bb = this.b[k];
          if (this.cp === k + 1 && sNew < bb && sOld >= bb) { this.cp = k; (out || (out = [])).push({ kind: 'unsector', k: k }); }
        }
      }
    }
    return out;
  };
  LapTracker.prototype._lineForward = function (frac) {
    if (this.debt > 0) { this.debt--; this.cp = 0; return { kind: this.debt === 0 ? 'arm' : 'debt', frac: frac }; }
    if (this.cp === 2) { this.lap++; this.cp = 0; return { kind: 'lap', frac: frac }; }
    var missed = this.cp; this.cp = 0;
    return { kind: 'cut', frac: frac, missed: missed };
  };
  /** Continuous race distance (m) for positions: negative before the first crossing. */
  LapTracker.prototype.distance = function (lapS) { return (this.lap - this.debt) * this.L + lapS; };

  /* ======================================================================
     Oriented boxes / SAT
     ====================================================================== */

  function obbOf(x, y, h, halfL, halfW) {
    var c = Math.cos(h), s = Math.sin(h);
    var ux = c, uy = s, vx = -s, vy = c;
    return {
      x: x, y: y, ux: ux, uy: uy, vx: vx, vy: vy, hl: halfL, hw: halfW,
      corners: [
        [x + ux * halfL + vx * halfW, y + uy * halfL + vy * halfW],
        [x + ux * halfL - vx * halfW, y + uy * halfL - vy * halfW],
        [x - ux * halfL - vx * halfW, y - uy * halfL - vy * halfW],
        [x - ux * halfL + vx * halfW, y - uy * halfL + vy * halfW]
      ]
    };
  }
  function pointInObb(b, px, py, slop) {
    var dx = px - b.x, dy = py - b.y;
    return Math.abs(dx * b.ux + dy * b.uy) <= b.hl + slop && Math.abs(dx * b.vx + dy * b.vy) <= b.hw + slop;
  }
  /** SAT between two OBBs. Returns null or {depth, nx, ny (unit, from A to B), px, py (contact point)}. */
  function satObb(A, B) {
    var axes = [[A.ux, A.uy], [A.vx, A.vy], [B.ux, B.uy], [B.vx, B.vy]];
    var dx = B.x - A.x, dy = B.y - A.y, minO = Infinity, nx = 0, ny = 0;
    for (var i = 0; i < 4; i++) {
      var ax = axes[i][0], ay = axes[i][1];
      var rA = A.hl * Math.abs(A.ux * ax + A.uy * ay) + A.hw * Math.abs(A.vx * ax + A.vy * ay);
      var rB = B.hl * Math.abs(B.ux * ax + B.uy * ay) + B.hw * Math.abs(B.vx * ax + B.vy * ay);
      var dist = dx * ax + dy * ay, o = rA + rB - Math.abs(dist);
      if (o <= 0) return null;
      if (o < minO) { minO = o; var sg = dist >= 0 ? 1 : -1; nx = ax * sg; ny = ay * sg; }
    }
    var sx = 0, sy = 0, cnt = 0, k;
    for (k = 0; k < 4; k++) if (pointInObb(A, B.corners[k][0], B.corners[k][1], 0.02)) { sx += B.corners[k][0]; sy += B.corners[k][1]; cnt++; }
    for (k = 0; k < 4; k++) if (pointInObb(B, A.corners[k][0], A.corners[k][1], 0.02)) { sx += A.corners[k][0]; sy += A.corners[k][1]; cnt++; }
    var px = cnt ? sx / cnt : (A.x + B.x) / 2, py = cnt ? sy / cnt : (A.y + B.y) / 2;
    return { depth: minO, nx: nx, ny: ny, px: px, py: py };
  }

  /**
   * Impulse response between two rigid bodies in the plane.
   * a/b: {m, I, vx, vy, w, x, y}; contact {nx, ny (A->B), px, py}; returns {jn, vn} (mutates velocities).
   */
  function resolveImpulse(a, b, c, restitution, friction) {
    var rax = c.px - a.x, ray = c.py - a.y, rbx = c.px - b.x, rby = c.py - b.y;
    var vax = a.vx - a.w * ray, vay = a.vy + a.w * rax;
    var vbx = b.vx - b.w * rby, vby = b.vy + b.w * rbx;
    var rvx = vbx - vax, rvy = vby - vay;
    var vn = rvx * c.nx + rvy * c.ny;
    if (vn >= 0) return { jn: 0, vn: vn };
    var raN = rax * c.ny - ray * c.nx, rbN = rbx * c.ny - rby * c.nx;
    var invA = 1 / a.m, invB = 1 / b.m, invIA = 1 / a.I, invIB = 1 / b.I;
    var kn = invA + invB + raN * raN * invIA + rbN * rbN * invIB;
    var jn = -(1 + restitution) * vn / kn;
    var tx = -c.ny, ty = c.nx, vt = rvx * tx + rvy * ty;
    var raT = rax * ty - ray * tx, rbT = rbx * ty - rby * tx;
    var kt = invA + invB + raT * raT * invIA + rbT * rbT * invIB;
    var jt = clamp(-vt / kt, -friction * jn, friction * jn);
    var Px = c.nx * jn + tx * jt, Py = c.ny * jn + ty * jt;
    a.vx -= Px * invA; a.vy -= Py * invA; a.w -= (rax * Py - ray * Px) * invIA;
    b.vx += Px * invB; b.vy += Py * invB; b.w += (rbx * Py - rby * Px) * invIB;
    return { jn: jn, vn: vn };
  }

  /* ======================================================================
     Session
     ====================================================================== */

  function normalizeConfig(cfgIn) {
    var c = Object.assign({}, cfgIn || {});
    c.mode = c.mode === 'time-trial' || c.mode === 'practice' ? c.mode : 'race';
    c.laps = clamp(Math.round(num(c.laps, c.mode === 'race' ? 3 : (c.mode === 'time-trial' ? 5 : 0))), c.mode === 'practice' ? 0 : 1, c.mode === 'race' ? 50 : 999);
    c.weather = WEATHER[c.weather] ? c.weather : 'dry';
    c.timeOfDay = c.timeOfDay === 'dusk' || c.timeOfDay === 'night' ? c.timeOfDay : 'day';
    c.difficulty = ['rookie', 'amateur', 'pro', 'alien'].indexOf(c.difficulty) >= 0 ? c.difficulty : 'amateur';
    c.field = ['similar', 'presets', 'mixed'].indexOf(c.field) >= 0 ? c.field : 'mixed';
    // ARCADE-SPEC: 'arcade' = every car (player + AI) on the arcade vehicle model; anything else = the simulation
    c.handling = c.handling === 'arcade' ? 'arcade' : 'sim';
    var a = c.assists || {};
    c.assists = {
      abs: boolish(a.abs, true), tc: boolish(a.tc, true), autoShift: boolish(a.autoShift, true),
      racingLine: boolish(a.racingLine, false), steeringAssist: boolish(a.steeringAssist, false)
    };
    var sd = seedFrom(c.seed);
    c.seed = sd === null ? (Math.floor(Math.random() * 4294967296) >>> 0) : sd;   // creation-time only, never in the sim
    c.jumpStartPenalty_s = num(c.jumpStartPenalty_s, 5);
    c.trackLimitsWarnings = Math.max(0, Math.round(num(c.trackLimitsWarnings, 3)));
    c.trackLimitsPenalty_s = num(c.trackLimitsPenalty_s, 5);
    c.stuckDnf_s = num(c.stuckDnf_s, 30);
    c.aiAutoRecover_s = num(c.aiAutoRecover_s, 9);
    c.rubberBanding = !!c.rubberBanding;
    c.sandboxRandom = c.sandboxRandom !== false;
    c.persistGhost = c.persistGhost !== false;
    c.playerName = c.playerName || 'You';
    c.playerTeam = c.playerTeam || 'Redline Garage';
    return c;
  }

  var geomCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function resolveModules(cfg) {
    var R = CB.race || {}, f = cfg._forceFallback, all = f === true;
    f = f || {};
    var T = R.tracks, V = R.vehicle, I = R.ai;
    return {
      tracks: !all && !f.tracks && T && typeof T.build === 'function' ? T : null,
      vehicle: !all && !f.vehicle && V && typeof V.fromBuild === 'function' && typeof V.createState === 'function' && typeof V.step === 'function' ? V : FallbackVehicle,
      ai: !all && !f.ai && I && typeof I.createDriver === 'function' ? I : null,
      aiGrid: !all && !f.ai && I && typeof I.createGrid === 'function' ? I : null
    };
  }

  function trackList(T) {
    if (!T) return [];
    var l = T.list;
    if (typeof l === 'function') { try { l = l(); } catch (e) { l = null; } }
    if (!Array.isArray(l) && Array.isArray(T.tracks)) l = T.tracks;
    return Array.isArray(l) ? l : [];
  }

  function resolveTrack(cfg, mods) {
    var T = mods.tracks, def = cfg.track && typeof cfg.track === 'object' ? cfg.track : null;
    if (!def && T) {
      if (cfg.trackId && typeof T.get === 'function') { try { def = T.get(cfg.trackId) || null; } catch (e) { def = null; } }
      var list = trackList(T);
      if (!def && cfg.trackId) def = list.filter(function (t) { return t && t.id === cfg.trackId; })[0] || null;
      if (!def) def = list[0] || null;
    }
    if (!def) def = FALLBACK_TRACK;
    var raw = cfg.geom || null;
    if (!raw && geomCache && geomCache.has(def)) raw = geomCache.get(def);
    if (!raw && T && def !== FALLBACK_TRACK) { try { raw = T.build(def); } catch (e) { raw = null; } }
    var ok = raw && (raw.samples || raw.centerline || raw.center || raw.points || raw.pts || raw.nodes);
    if (!ok || (ok.length || 0) < 8) raw = buildFallbackGeom(def);
    if (geomCache && !cfg.geom) geomCache.set(def, raw);
    return { def: def, raw: raw };
  }

  function createSession(cfgIn) {
    var cfg = normalizeConfig(cfgIn);
    var mods = resolveModules(cfg);
    var tr = resolveTrack(cfg, mods);
    var A = adaptGeom(tr.raw, tr.def);
    var trackDef = tr.def;
    var trackId = trackDef.id || cfg.trackId || 'track';
    var weather = WEATHER[cfg.weather];
    var storage = cfg.storage || null;
    if (!storage) { try { storage = typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { storage = null; } }

    var sess = null;            // mutable session state (rebuilt by restart)
    var persistentGhost = null; // best ghost survives restarts

    /* ---------------- game hooks (endurance, challenges, ...) ---------------- */
    var extras = cfg.extras && typeof cfg.extras === 'object' ? cfg.extras : {};
    var hookList = [];
    var ENDU = CB.game && CB.game.endurance && typeof CB.game.endurance.createHooks === 'function' ? CB.game.endurance : null;
    function buildHookList() {
      var list = [];
      var raw = Array.isArray(cfg.hooks) ? cfg.hooks : (cfg.hooks ? [cfg.hooks] : []);
      raw.forEach(function (h) { if (h && typeof h === 'object') list.push(h); });
      var ch = extras.challenge;
      if (ch && typeof ch === 'object' && ch.hooks && typeof ch.hooks === 'object' && list.indexOf(ch.hooks) < 0) list.push(ch.hooks);
      var wants = !!(extras.endurance || extras.wear || extras.fuel || extras.damage || extras.pitStops);
      var hasParams = list.some(function (h) { return typeof h.vehicleParams === 'function'; });
      if (wants && !hasParams && ENDU && cfg.autoEndurance !== false) {
        try {
          list.push(ENDU.createHooks({
            extras: { endurance: !!extras.endurance || (extras.wear ? undefined : false), wear: extras.wear ? undefined : false,
                      fuel: extras.fuel ? undefined : false, damage: extras.damage ? undefined : false },
            weather: cfg.weather, timeOfDay: cfg.timeOfDay, seed: cfg.seed,
            wearMult: isNum(extras.wear) ? extras.wear : undefined, fuelMult: isNum(extras.fuel) ? extras.fuel : undefined,
            onEvent: function (ev) { onHookEvent(ev); }
          }));
        } catch (e) { /* endurance is optional */ }
      }
      return list;
    }
    function hookFail() { if (sess) sess.hookErrors = (sess.hookErrors || 0) + 1; }
    function callHooks(name, args) {
      var out;
      for (var i = 0; i < hookList.length; i++) {
        var h = hookList[i];
        if (typeof h[name] !== 'function') continue;
        try { var r = h[name].apply(h, args); if (r !== undefined && r !== null) out = r; } catch (e) { hookFail(); }
      }
      return out;
    }
    function onHookEvent(ev) {
      if (!sess || !ev) return;
      var car = null;
      for (var i = 0; i < sess.cars.length; i++) if (sess.cars[i].id === ev.carId) { car = sess.cars[i]; break; }
      if (!car) return;
      emit('endurance', car, ev.severity != null ? ev.severity : 0.5, ev.value != null ? ev.value : null, ev.text || ev.type, { kind: ev.type, wheel: ev.wheel });
    }
    function neutralMods(m) {
      if (!m || typeof m !== 'object') return true;
      var g = m.gripMult, gOk = g == null || (Array.isArray(g) ? g.every(function (v) { return !isNum(v) || v === 1; }) : g === 1);
      var wOk = !Array.isArray(m.wheelGrip) || m.wheelGrip.every(function (v) { return !isNum(v) || v === 1; });
      return gOk && wOk && ['powerMult', 'dragMult', 'downforceMult', 'brakeMult', 'rollingMult'].every(function (k) { return !isNum(m[k]) || m[k] === 1; }) && !m.steerPull;
    }
    /** vehicle params + env for this substep with every hook's effects merged in */
    function hookedVehicle(car, env, inp) {
      var params = car.params;
      if (!hookList.length) return { params: params, env: env, input: inp };
      for (var i = 0; i < hookList.length; i++) {
        var h = hookList[i];
        try {
          if (typeof h.preStep === 'function') {
            var r = h.preStep(car, inp, STEP);
            if (r && typeof r === 'object') inp = r;
          }
          if (typeof h.vehicleParams === 'function') {
            var p = h.vehicleParams(car, params);
            if (p && typeof p === 'object') params = p;
            if (typeof h.vehicleEnv === 'function') { var e = h.vehicleEnv(car, env); if (e && typeof e === 'object') env = e; }
          } else if (typeof h.modifiers === 'function') {
            var m = h.modifiers(car);
            if (!neutralMods(m)) {
              if (ENDU && typeof ENDU.applyToParams === 'function') {
                car._hookCache = car._hookCache || {};
                var key = 'h' + i;
                car._hookCache[key] = car._hookCache[key] || {};
                params = ENDU.applyToParams(params, m, { cache: car._hookCache[key] }) || params;
                env = ENDU.vehicleEnv(m, env) || env;
              } else {
                var g = Array.isArray(m.gripMult) ? (num(m.gripMult[0], 1) + num(m.gripMult[1], 1)) / 2 : num(m.gripMult, 1);
                env = Object.assign({}, env, { gripMult: num(env.gripMult, 1) * g });
                if (isNum(m.powerMult) && m.powerMult !== 1) inp = Object.assign({}, inp, { throttle: clamp01(inp.throttle * m.powerMult) });
              }
            }
          }
          // env-only hooks (ARCADE-SPEC §3: boost / push / speed classes via env.arcade) — no params copy needed
          if (typeof h.vehicleEnv === 'function' && typeof h.vehicleParams !== 'function') { var e2 = h.vehicleEnv(car, env); if (e2 && typeof e2 === 'object') env = e2; }
        } catch (err) { hookFail(); }
      }
      return { params: params, env: env, input: inp };
    }
    function bodyDir(car, wx, wy) {
      var h = car.state.heading, c = Math.cos(h), s = Math.sin(h);
      return { x: c * wx + s * wy, y: -s * wx + c * wy };
    }
    function impact(car, jn, wx, wy, opts) {
      if (!hookList.length || !(jn > 0)) return;
      callHooks('onImpact', [car, jn, bodyDir(car, wx, wy), opts || {}]);
    }
    function hookSnapshot(car) {
      if (!hookList.length) return undefined;
      var o = callHooks('snapshot', [car]);
      return o && typeof o === 'object' ? o : undefined;
    }

    /* ---------------- pit stops ---------------- */
    var pitCfg = null;
    function pitsEnabled() { return !!extras.pitStops && hookList.some(function (h) { return typeof h.pitStop === 'function'; }); }
    function mandatoryStops() { return isNum(extras.mandatoryPitStops) ? extras.mandatoryPitStops : (isNum(extras.pitStops) ? extras.pitStops : 0); }
    function pitLane() {
      if (pitCfg) return pitCfg;
      var info = null;
      if (ENDU && typeof ENDU.pitLaneInfo === 'function') { try { info = ENDU.pitLaneInfo({ length_m: A.L, def: trackDef, samples: tr.raw && Array.isArray(tr.raw.samples) && tr.raw.samples.length > 10 && isNum(tr.raw.samples[0].curvature) ? tr.raw.samples : undefined }); } catch (e) { info = null; } }
      if (!info) { var len = clamp(A.L * 0.07, 250, 550); info = { entry_s: A.L - len * 0.6, exit_s: len * 0.4, length_m: len, trackLength_m: A.L, speedLimit_ms: 60 / 3.6 }; }
      info.trackLength_m = A.L;
      info.box_s = wrapS(info.entry_s + info.length_m * 0.55, A.L);
      pitCfg = info;
      return info;
    }
    function inLane(s, info) {
      s = wrapS(s, A.L);
      return info.exit_s >= info.entry_s ? (s >= info.entry_s && s <= info.exit_s) : (s >= info.entry_s || s <= info.exit_s);
    }
    function passed(prev, cur, mark) {
      var d0 = wrapS(mark - prev, A.L), d1 = wrapS(cur - prev, A.L);
      return d1 < A.L / 2 && d0 <= d1;
    }
    function defaultPitRequest(car) {
      var adv = callHooks('advice', [car, { lapsRemaining: Math.max(0, cfg.laps - car.tracker.lap), trackLength_m: A.L }]);
      var req = adv && adv.request && typeof adv.request === 'object' ? Object.assign({}, adv.request) : { tires: true, repair: true };
      // a stop with nothing to do is wasted: a called stop always takes at least fresh tyres
      if (!req.tires && !(req.fuel_l > 0) && !(req.fuelTo_l > 0) && !(req.charge_kwh > 0) && !req.repair) req.tires = true;
      return req;
    }
    function requestPit(car, request) {
      if (!car || car.dnf || car.finished) return false;
      car.pitRequest = request && typeof request === 'object' ? request : defaultPitRequest(car);
      emit('pitRequest', car, 0.4, null, car.isPlayer ? 'Box, box — pit this lap' : car.name + ' is coming in');
      return true;
    }
    function pitLogic(car) {
      if (!pitsEnabled() || car.dnf) return;
      var info = pitLane(), s = car.lapS, prev = car.prevLapS;
      var lapsLeft = Math.max(0, cfg.laps - car.tracker.lap);
      if (cfg.mode === 'race' && sess.phase === 'racing' && !car.pitRequest && !car.pitPhase && !car.finished && lapsLeft > 0) {
        var owe = mandatoryStops() - (car.pitStops || 0);
        var autoPit = !car.isPlayer || extras.autoPit !== false;
        if (autoPit && car.tracker.lap !== car.lastAdviceLap && wrapS(info.entry_s - s, A.L) < 400) {
          car.lastAdviceLap = car.tracker.lap;
          var adv = callHooks('advice', [car, { lapsRemaining: lapsLeft, trackLength_m: A.L }]);
          if ((adv && adv.box) || (owe > 0 && lapsLeft >= 2 && lapsLeft <= owe + 1 + (car.isPlayer ? 0 : Math.floor(car.idx % 3)))) requestPit(car, defaultPitRequest(car));
        }
      }
      if (!car.pitPhase) {
        // the box sits past the start/finish line on lanes that span it: entering on the final lap would take the flag first
        var boxAfterLine = info.box_s < info.entry_s;
        if (car.pitRequest && passed(prev, s, info.entry_s) && !car.finished && !(cfg.mode === 'race' && boxAfterLine && lapsLeft <= 1)) {
          car.pitPhase = 'lane'; car.pitLimiter = true; car.pitEnterT = sess.t;
          emit('pitEntry', car, 0.5, null, car.name + ' enters the pit lane');
        }
        return;
      }
      if (car.pitPhase === 'lane' && passed(prev, s, info.box_s)) {
        var r = callHooks('pitStop', [car, car.pitRequest || {}]) || {};
        var dur = clamp(num(r.duration_s, 8), 2, 120);
        car.pitPhase = 'stopped'; car.frozenUntil = sess.t + dur; car.pitDuration = dur;
        setWorldVel(car, 0, 0);
        if (isNum(car.state.speed)) car.state.speed = 0;
        if (isNum(car.state.yawRate)) car.state.yawRate = 0;
        car.pitStops = (car.pitStops || 0) + 1;
        car.pitLog = car.pitLog || [];
        car.pitLog.push({ lap: car.tracker.lap, t: round(sess.t, 3), duration_s: round(dur, 2), breakdown: r.breakdown || null });
        emit('pitStop', car, 0.6, round(dur, 2), (car.isPlayer ? 'Pit stop ' : car.name + ' pits · ') + dur.toFixed(1) + ' s');
        car.pitRequest = null;
        return;
      }
      if (car.pitPhase === 'stopped' && sess.t >= car.frozenUntil) car.pitPhase = 'exit';
      if ((car.pitPhase === 'exit' || car.pitPhase === 'lane') && !inLane(s, info) && !inLane(prev, info)) {
        car.pitPhase = null; car.pitLimiter = false;
        emit('pitExit', car, 0.4, null, car.name + ' rejoins');
      }
    }

    /* ---------------- randomness sandbox ---------------- */
    function sandboxed(fn) {
      if (!cfg.sandboxRandom || !sess) return fn();
      var orig = Math.random;
      Math.random = sess.rngExt;
      try { return fn(); } finally { Math.random = orig; }
    }

    /* ---------------- events ---------------- */
    function emit(type, car, intensity, value, text, extra) {
      var e = { type: type, carId: car ? car.id : null, x: car ? round(car.state.x, 2) : 0, y: car ? round(car.state.y, 2) : 0,
                intensity: clamp01(num(intensity, 0.5)), t: round(sess.t, 3) };
      if (value !== undefined && value !== null) e.value = value;
      if (text) e.text = text;
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
      sess.events.push(e);
      if (sess.events.length > MAX_EVENTS) sess.events.shift();
      sess.eventLog.push({ type: type, carId: e.carId, t: e.t, value: e.value, text: e.text });
      if (sess.eventLog.length > 2000) sess.eventLog.shift();
      if (typeof extras.onEvent === 'function') { try { extras.onEvent(e); } catch (err) { /* listeners never break the sim */ } }
    }

    /* ---------------- builds / metrics ---------------- */
    function normBuild(b) {
      b = deepClone(b);
      if (CB.state && typeof CB.state.normalize === 'function') { try { var nb = CB.state.normalize(b); if (nb && typeof nb === 'object') b = nb; } catch (e) { /* keep */ } }
      return b;
    }
    function metricsOf(b) {
      if (!CB.physics || typeof CB.physics.compute !== 'function') return null;
      try { return CB.physics.compute(b) || null; } catch (e) { return null; }
    }
    function resolvePlayerBuild() {
      var b = cfg.playerBuild || cfg.build || null;
      if (!b && CB.state && typeof CB.state.get === 'function') { try { b = CB.state.get(); } catch (e) { b = null; } }
      if (!b && CB.data && typeof CB.data.defaultBuild === 'function') { try { b = CB.data.defaultBuild(); } catch (e) { b = null; } }
      if (!b && CB.data && Array.isArray(CB.data.presets) && CB.data.presets[0]) b = deepMergeSimple(FALLBACK_BUILD, CB.data.presets[0].build || {});
      return normBuild(b || FALLBACK_BUILD);
    }

    function resolveOpponents(playerBuild) {
      if (cfg.mode === 'time-trial') return [];
      var o = cfg.opponents;
      if (Array.isArray(o)) return o.slice(0, 11);
      var count = isNum(o) ? o : isNum(cfg.opponentCount) ? cfg.opponentCount : (cfg.mode === 'practice' ? 0 : 5);
      count = clamp(Math.round(count), 0, 11);
      if (!count) return [];
      if (mods.aiGrid) {
        try {
          var g = sandboxed(function () {
            return mods.aiGrid.createGrid(playerBuild, { count: count, difficulty: cfg.difficulty, field: cfg.field, seed: cfg.seed, rng: sess.rngExt });
          });
          if (Array.isArray(g) && g.length) return g.slice(0, count);
        } catch (e) { /* fallback below */ }
      }
      return fallbackGrid(playerBuild, count, cfg, sess.rng);
    }

    /* ---------------- grid slots ---------------- */
    function gridSlot(k) {
      if (A.slots[k]) return A.slots[k];
      // extend the provided slots by their own pattern, or build a 2-wide staggered grid behind the line
      var n0 = A.slots.length;
      if (n0 >= 2) {
        var last = A.slots[n0 - 1], prev = A.slots[n0 - 2], pp = projectA(A, last.x, last.y, -1);
        var lastS = wrapS(pp.s - A.s0, A.L), pv = projectA(A, prev.x, prev.y, -1), prevS = wrapS(pv.s - A.s0, A.L);
        var spacing = Math.max(5, Math.abs(wrapAngle((lastS - prevS) / A.L * TAU) / TAU * A.L)) || 8;
        var extra = k - n0 + 1, refLat = (k - n0) % 2 === 0 ? pv.lateral : pp.lateral;
        var refS = (k - n0) % 2 === 0 ? prevS : lastS;
        var s = refS - spacing * 2 * Math.ceil(extra / 2);
        return poseAt(A, s, refLat);
      }
      var hw = A.W[indexAtAbsS(A, A.s0)] / 2, lat = Math.min(hw * 0.45, 3.0) * (k % 2 === 0 ? 1 : -1);
      return poseAt(A, -8 - k * 8, lat);
    }

    /* ---------------- car construction ---------------- */
    function dimsOf(build, params) {
      var body = build.body || {};
      var wb = num(body.wheelbase_mm, 2650) / 1000;
      var L = firstNum(params && params.length_m, params && params.length, wb + (OVERHANG[body.style] || 1.9));
      var W = firstNum(params && params.width_m, params && params.width, num(body.trackWidth_mm, 1600) / 1000 + 0.32);
      return { L: clamp(L, 2.8, 6.5), W: clamp(W, 1.4, 2.4) };
    }

    function makeCar(idx, entrant, isPlayer, slot) {
      var build = normBuild(entrant.build || sess.playerBuild);
      var metrics = isPlayer && cfg.playerMetrics && typeof cfg.playerMetrics === 'object' ? cfg.playerMetrics : metricsOf(build);
      var V = mods.vehicle, params = null;
      try { params = V.fromBuild(build, metrics, { assists: isPlayer ? cfg.assists : null, isPlayer: isPlayer, handling: cfg.handling }); } catch (e) { params = null; }
      var vehicleImpl = V;
      if (!params || typeof params !== 'object') { vehicleImpl = FallbackVehicle; params = FallbackVehicle.fromBuild(build, metrics); }
      var pose = { x: slot.x, y: slot.y, heading: slot.heading, speed: 0 };
      var state;
      try { state = vehicleImpl.createState(params, pose, { autoShift: isPlayer ? cfg.assists.autoShift : true }); } catch (e) { state = null; }
      if (!state || !isNum(state.x)) { vehicleImpl = FallbackVehicle; params = FallbackVehicle.fromBuild(build, metrics); state = FallbackVehicle.createState(params, pose); }
      var dims = dimsOf(build, params);
      var mass = firstNum(params.mass, params.mass_kg, params.m, metrics && metrics.weight_kg, 1450);
      var wb = firstNum(params.wheelbase, params.wb, params.wheelbase_m, num(build.body && build.body.wheelbase_mm, 2650) / 1000);
      var axA = firstNum(params.a, params.lf, wb / 2), axB = firstNum(params.b, params.lr, wb / 2);
      var trk = firstNum(params.track, params.trackWidth, params.trackWidth_m, num(build.body && build.body.trackWidth_mm, 1600) / 1000);
      var Iz = firstNum(params.Iz, params.yawInertia, params.inertia, params.I, mass * (dims.L * dims.L + dims.W * dims.W) / 12 * 1.1);
      var ext = build.exterior || {};
      var color = isPlayer ? (ext.paint || '#b3121f') : (entrant.color || (entrant.livery && (entrant.livery.primary || entrant.livery.color)) || ext.paint || '#888888');
      var accent = isPlayer ? (ext.stripeColor || '#ffffff') : (entrant.accent || (entrant.livery && (entrant.livery.accent || entrant.livery.secondary)) || ext.stripeColor || '#ffffff');
      var redline = firstNum(params.redline, params.redline_rpm, params.redlineRpm, state.redline, metrics && metrics.redlineRpm, build.engine && build.engine.redline_rpm, 7000);
      var maxGear = firstNum(params.maxGear, params.gears && params.gears.length, params.gearRatios && params.gearRatios.length,
                             params.ratios && params.ratios.length, build.transmission && build.transmission.gears, 6);
      var proj = projectA(A, state.x, state.y, -1);
      var lapS = wrapS(proj.s - A.s0, A.L);
      var behind = lapS > A.L / 2;
      var car = {
        id: isPlayer ? 'player' : String(entrant.id != null ? entrant.id : 'ai-' + idx), idx: idx, isPlayer: isPlayer,
        name: isPlayer ? cfg.playerName : (entrant.name || 'Driver ' + idx),
        team: isPlayer ? cfg.playerTeam : (entrant.team || (entrant.livery && entrant.livery.team) || ''),
        number: String(isPlayer ? (ext.livery_number || entrant.number || '1') : (entrant.number != null ? entrant.number : idx + 1)),
        color: color, accent: accent, build: build, bodyStyle: (build.body && build.body.style) || 'coupe',
        params: params, metrics: metrics, V: vehicleImpl, state: state, entrant: entrant,
        length_m: dims.L, width_m: dims.W, halfL: dims.L / 2, halfW: dims.W / 2, mass: mass, Iz: Iz,
        axA: axA, axB: axB, halfTrack: trk / 2, redline: redline, maxGear: maxGear,
        input: { throttle: 0, brake: 0, steer: 0, handbrake: false }, smSteer: 0,
        proj: proj, hint: proj.index, lapS: lapS, prevLapS: lapS, lateral: proj.lateral, surface: 'asphalt', onTrack: true,
        tracker: new LapTracker(A.L, A.b[0], A.b[1], behind),
        lapStartT: 0, sectorStartT: 0, armed: !behind, curSectors: [null, null, null], lastSectors: [null, null, null],
        bestSectors: [null, null, null], lapTimes: [], lastLap: null, bestLap: null, lapValid: true,
        raceDist: 0, prevDist: 0, finished: false, finishT: null, finishRaceT: null, finishDist: null, finishLaps: 0,
        penalties: 0, penaltyLog: [], dnf: false, dnfReason: null, wrongWay: false, wrongT: 0, dsdt: 0,
        tlCount: 0, tlLog: [], offTrack: false, exc: null, progressMark: -Infinity, progressT: 0, resets: 0, lastResetT: -100,
        pass: [], gapAhead: 0, gapLeader: 0, lapsDown: 0, position: idx + 1, gridPosition: idx + 1, lapPositions: [],
        jumpStart: false, gridShunt: false, reaction: null, frozenUntil: -1, wallCool: 0, collisions: 0, wallHits: 0,
        gridPose: { x: slot.x, y: slot.y }, maxSpeed: 0, driver: null, autopilot: null,
        wvx: 0, wvy: 0, prevX: state.x, prevY: state.y, prevH: state.heading, lastGood: { x: state.x, y: state.y, heading: state.heading },
        ghostRec: [], trace: [], bestTrace: null, deltaBest: null, topSpeedLap: 0, ghostLap: false
      };
      car.raceDist = car.prevDist = car.tracker.distance(lapS);
      initPass(car);
      return car;
    }

    function makeDriver(car, entrant, isAutopilot) {
      var drv = null;
      if (mods.ai) {
        try {
          drv = sandboxed(function () {
            return mods.ai.createDriver(entrant, tr.raw, car.params, {
              id: car.id, metrics: car.metrics, rubberBand: cfg.rubberBanding && !isAutopilot, seed: (cfg.seed + car.idx * 7919) >>> 0,
              rng: sess.rngExt, autopilot: !!isAutopilot
            });
          });
        } catch (e) { drv = null; }
        if (drv && typeof drv !== 'function' && typeof drv.control !== 'function') drv = null;
      }
      return drv || new FallbackDriver(sess, car, entrant);
    }

    function playerAutopilot() {
      var p = sess.player;
      if (!p.autopilot) {
        p.autopilot = makeDriver(p, { id: p.id, name: p.name, build: p.build, skill: 0.86, aggression: 0.25, consistency: 0.97, number: p.number }, true);
      }
      return p.autopilot;
    }

    /* ---------------- gap history ---------------- */
    function initPass(car) {
      car.pass = [];
      var upto = Math.floor((car.raceDist + GAP_OFFSET) / GAP_BUCKET);
      for (var k = 0; k <= upto; k++) car.pass.push(-Infinity);
    }
    function recordPass(car, tPrev) {
      var d = car.raceDist, pd = car.prevDist, guard = 0;
      while (guard++ < 400) {
        var k = car.pass.length, target = k * GAP_BUCKET - GAP_OFFSET;
        if (target > d) break;
        var frac = d > pd ? clamp((target - pd) / (d - pd), 0, 1) : 1;
        car.pass.push(tPrev + frac * STEP);
      }
    }
    function timeAt(car, d) {
      var k = (d + GAP_OFFSET) / GAP_BUCKET;
      if (k < 0) return sess.goT === null ? sess.t : sess.goT;
      var i = Math.floor(k), P = car.pass;
      if (i >= P.length) return null;
      var a = P[i] === -Infinity ? (sess.goT === null ? sess.t : sess.goT) : P[i];
      if (i + 1 >= P.length) return a;
      var b = P[i + 1] === -Infinity ? (sess.goT === null ? sess.t : sess.goT) : P[i + 1];
      return a + (b - a) * (k - i);
    }
    function timeGap(b, a) {
      if (a === b) return 0;
      var dB = b.finished && b.finishDist !== null ? b.finishDist : b.raceDist;
      var tB = b.finished && b.finishT !== null ? b.finishT : sess.t;
      // no real gap yet: the car ahead was already past this point when the lights went out (the grid at the start),
      // so the "gap" would just be the race clock. null = unknown; the HUD shows a dash until a timing point gives one
      var k = (dB + GAP_OFFSET) / GAP_BUCKET, P = a.pass, ki = Math.floor(k);
      if (!b.finished && (k < 0 || P[ki] === -Infinity || (ki + 1 < P.length && P[ki + 1] === -Infinity))) return null;
      var tA = timeAt(a, dB);
      if (tA === null) return 0;
      return Math.max(0, tB - tA);
    }

    /* ---------------- velocity frame helpers ---------------- */
    function frame(car) {
      var V = car.V;
      if (V && (V.velocityFrame === 'world' || V.velocityFrame === 'body')) return V.velocityFrame;
      return sess.velFrame || 'body';
    }
    function worldVel(car) {
      var st = car.state, vx = num(st.vx, 0), vy = num(st.vy, 0);
      if (frame(car) === 'world') return [vx, vy];
      var c = Math.cos(st.heading), s = Math.sin(st.heading);
      return [vx * c - vy * s, vx * s + vy * c];
    }
    function setWorldVel(car, wx, wy) {
      var st = car.state;
      if (frame(car) === 'world') { st.vx = wx; st.vy = wy; }
      else {
        var c = Math.cos(st.heading), s = Math.sin(st.heading);
        st.vx = wx * c + wy * s; st.vy = -wx * s + wy * c;
      }
      var fwd = wx * Math.cos(st.heading) + wy * Math.sin(st.heading);
      if ('speed' in st) st.speed = Math.sqrt(wx * wx + wy * wy) * (fwd < -0.05 && num(st.speed, 0) < 0 ? -1 : 1);
      car.wvx = wx; car.wvy = wy;
    }
    function detectFrame(car, mx, my) {
      if (sess.frameDecided || car.V !== mods.vehicle || (car.V.velocityFrame === 'world' || car.V.velocityFrame === 'body')) return;
      var st = car.state, sp = Math.hypot(mx, my);
      if (sp < 3 || !isNum(st.vx) || !isNum(st.vy)) return;
      var c = Math.cos(st.heading), s = Math.sin(st.heading);
      var bx = st.vx * c - st.vy * s, by = st.vx * s + st.vy * c;
      sess.frameErrBody += Math.hypot(bx - mx, by - my) / sp;
      sess.frameErrWorld += Math.hypot(st.vx - mx, st.vy - my) / sp;
      if (++sess.frameVotes >= 90) {
        sess.velFrame = sess.frameErrWorld < sess.frameErrBody * 0.7 ? 'world' : 'body';
        sess.frameDecided = true;
      }
    }

    /* ---------------- environment per car ---------------- */
    function envFor(car) {
      var sf = SURFACES[car.surface] || SURFACES.asphalt;
      var g = sf.grip;
      if (car.surface === 'kerb' && weather.wet) g *= 0.82;
      var assists = car.isPlayer && !car.autopilotActive ? cfg.assists : { abs: undefined, tc: undefined, autoShift: true };
      return {
        gripMult: g * weather.grip * A.grip, wet: weather.wet, wetness: weather.wetness, weather: cfg.weather,
        surface: car.surface, onTrack: car.onTrack, abs: assists.abs, tc: assists.tc, autoShift: assists.autoShift,
        assists: assists, timeOfDay: cfg.timeOfDay
      };
    }

    /* ---------------- AI race context ---------------- */
    function carInfo(c) {
      var wv = [c.wvx, c.wvy];
      return {
        id: c.id, isPlayer: c.isPlayer, x: c.state.x, y: c.state.y, heading: c.state.heading,
        speed: Math.abs(num(c.state.speed, Math.hypot(wv[0], wv[1]))), vx: wv[0], vy: wv[1], vxWorld: wv[0], vyWorld: wv[1],
        s: c.lapS, lapS: c.lapS, lateral: c.lateral, lap: c.tracker.lap, raceDist: c.raceDist, position: c.position,
        index: c.proj.index, length_m: c.length_m, width_m: c.width_m, finished: c.finished, dnf: c.dnf, surface: c.surface
      };
    }
    function buildContexts() {
      var infos = sess.cars.map(carInfo);
      var cd = countdownObj();
      for (var i = 0; i < sess.cars.length; i++) {
        var car = sess.cars[i], me = infos[i], nearby = [];
        var c = Math.cos(me.heading), s = Math.sin(me.heading);
        for (var j = 0; j < infos.length; j++) {
          if (j === i) continue;
          var o = infos[j], dx = o.x - me.x, dy = o.y - me.y, d2 = dx * dx + dy * dy;
          if (d2 > 90 * 90 || o.dnf) continue;
          var ds = o.s - me.s; if (ds > A.L / 2) ds -= A.L; else if (ds < -A.L / 2) ds += A.L;
          nearby.push({ id: o.id, isPlayer: o.isPlayer, x: o.x, y: o.y, heading: o.heading, speed: o.speed, vx: o.vx, vy: o.vy,
            s: o.s, lateral: o.lateral, length_m: o.length_m, width_m: o.width_m, dist: Math.sqrt(d2),
            ahead: dx * c + dy * s, side: -dx * s + dy * c, ds: ds, dLat: o.lateral - me.lateral });
        }
        nearby.sort(function (a, b) { return a.dist - b.dist; });
        car.ctx = {
          t: sess.t, dt: STEP, phase: sess.phase, countdown: cd, mode: cfg.mode, lapsTotal: cfg.laps, selfId: car.id,
          self: me, me: me, cars: infos, nearby: nearby, others: nearby, weather: cfg.weather,
          env: envFor(car), gripMult: envFor(car).gripMult, surface: car.surface, onTrack: car.onTrack,
          lap: car.tracker.lap, position: car.position, s: car.lapS, lateral: car.lateral, index: car.proj.index,
          finished: car.finished, rubberBand: cfg.rubberBanding && !car.isPlayer, geom: tr.raw, track: trackDef,
          playerId: 'player', trackLength: A.L
        };
      }
    }

    /* ---------------- phase / countdown ---------------- */
    function countdownObj() {
      if (cfg.mode === 'practice') return { lightsOn: 0, lightsOut: true, goTime: sess.goT };
      var on = 0;
      if (sess.phase === 'countdown') on = clamp(Math.floor((sess.t - sess.gridEndT) / sess.lightInterval) + 1, 0, 5);
      return { lightsOn: on, lightsOut: sess.goT !== null, goTime: sess.goT };
    }
    function updatePhase() {
      if (sess.phase === 'grid' && sess.t >= sess.gridEndT) { sess.phase = 'countdown'; sess.lastLights = 0; }
      if (sess.phase === 'countdown') {
        var on = clamp(Math.floor((sess.t - sess.gridEndT) / sess.lightInterval) + 1, 0, 5);
        if (on !== sess.lastLights) { sess.lastLights = on; emit('light', null, 0.4, on, String(on)); }
        if (sess.t >= sess.lightsOutT) startRace(sess.lightsOutT);
      }
    }
    function startRace(tGo) {
      sess.phase = 'racing'; sess.goT = tGo;
      for (var i = 0; i < sess.cars.length; i++) {
        var c = sess.cars[i];
        c.lapStartT = tGo; c.sectorStartT = tGo; c.progressT = tGo; c.progressMark = c.raceDist;
        if (cfg.mode === 'time-trial' && !c.armed) c.lapValid = true;
      }
      emit('start', null, 1, tGo, cfg.mode === 'race' ? 'Lights out' : 'Go');
    }

    /* ---------------- input ---------------- */
    function cleanInput(inp) {
      inp = inp || {};
      return {
        throttle: clamp01(num(+inp.throttle, 0)), brake: clamp01(num(+inp.brake, 0)), steer: clamp(num(+inp.steer, 0), -1, 1),
        handbrake: !!inp.handbrake, shiftUp: !!inp.shiftUp, shiftDown: !!inp.shiftDown, reverse: !!inp.reverse,
        requestReset: !!inp.requestReset, pit: !!inp.pit
      };
    }
    // NOTE: the vehicle model selects reverse when the brake is held at a standstill, so "holding" a car only uses the
    // service brake while it is still rolling and the handbrake (rear lock) once stopped.
    function carSpeed(car) { return Math.abs(num(car.state.speed, Math.hypot(car.wvx || 0, car.wvy || 0))); }
    function holdFor(car, rev) {
      var moving = carSpeed(car) > 0.6;
      return { throttle: rev || 0, brake: moving ? 1 : 0, steer: 0, handbrake: true, shiftUp: false, shiftDown: false };
    }

    // On the grid (and through an AI's reaction time after lights-out) every car is HELD on the line: brakes + clutch
    // (vehicle input.hold). Revving is allowed — launch control holds its launch rpm and pre-spools, automatics load
    // the converter — but the car cannot creep, so throttle before lights-out is never a jump start.
    function gridHold(car, rev) {
      var o = holdFor(car, rev);
      o.hold = true;
      if (!car.V || car.V.isFallback) { o.throttle = 0; return o; }   // the fallback vehicle has no hold: brakes only, no revs
      o.brake = 0; o.handbrake = false;
      return o;
    }
    function aiGridRev(car) {
      if (sess.phase === 'grid') return 0;
      var V = car.V;
      return V && typeof V.launchHoldThrottle === 'function' ? num(sandboxed(function () { return V.launchHoldThrottle(car.params); }), 0) : 0;
    }

    function callDriver(drv, car) {
      var out;
      try {
        out = sandboxed(function () { return typeof drv === 'function' ? drv(car.state, car.ctx, STEP) : drv.control(car.state, car.ctx, STEP); });
      } catch (e) { out = null; if (!sess.aiErrors) sess.aiErrors = 0; sess.aiErrors++; }
      if (!out && drv && !(drv instanceof FallbackDriver)) {    // AI module broken -> permanently fall back for this car
        car.driver = new FallbackDriver(sess, car, car.entrant);
        out = car.driver.control(car.state, car.ctx, STEP);
      }
      return cleanInput(out);
    }

    function computeInput(car, pin) {
      var t = sess.t, ph = sess.phase;
      if (car.dnf) return holdFor(car, 0);
      if (car.frozenUntil > t) return holdFor(car, 0);
      var preStart = ph === 'grid' || ph === 'countdown';
      if (car.isPlayer) {
        var auto = cfg.playerAutopilot || sess.autopilot || car.finished || ph === 'finished';
        car.autopilotActive = auto;
        if (auto) {
          var ai = callDriver(playerAutopilot(), car);
          if (preStart) return gridHold(car, aiGridRev(car));
          if (car.finished || ph === 'finished') ai.throttle *= 0.7;
          return ai;
        }
        // every mode: rev freely, the car is held until lights-out (no throttle-based jump start)
        if (preStart) return gridHold(car, clamp01(num(+(pin && pin.throttle), 0)));
        var u = cleanInput(pin);
        if (cfg.assists.steeringAssist) {
          var sp = Math.abs(num(car.state.speed, 0));
          var target = u.steer / (1 + Math.pow(sp / 45, 2) * 0.6);
          car.smSteer += clamp(target - car.smSteer, -5 * STEP, 5 * STEP);
          u.steer = car.smSteer;
        } else car.smSteer = u.steer;
        if (u.throttle > 0.2 && car.reaction === null && sess.goT !== null && t >= sess.goT) car.reaction = t - sess.goT;
        return u;
      }
      var drv = car.driver;
      var out = callDriver(drv, car);
      if (preStart) return gridHold(car, aiGridRev(car));
      if (ph === 'racing' && sess.goT !== null && t < sess.goT + num(car.launchDelay, 0) && carSpeed(car) < 0.6) return gridHold(car, aiGridRev(car));
      if (out.requestReset && ph === 'racing' && t - car.lastResetT > 6) { resetCar(car, false, 'request'); return holdFor(car, 0); }
      if (car.reaction === null && sess.goT !== null && out.throttle > 0.2) car.reaction = t - sess.goT;
      return out;
    }

    /* ---------------- integration ---------------- */
    function integrate(car, inp) {
      var st = car.state, px = st.x, py = st.y;
      car.prevX = px; car.prevY = py; car.prevH = st.heading;
      var env = envFor(car), V = car.V, res, stepParams = car.params;
      if (hookList.length) {
        var held = inp && inp.hold;
        var hv = hookedVehicle(car, env, inp); env = hv.env; inp = hv.input; stepParams = hv.params;
        if (held && inp && !inp.hold) inp = Object.assign({}, inp, { hold: true });   // hooks keep the grid hold
      }
      try { res = V.step(stepParams, st, inp, STEP, env); } catch (e) { res = null; sess.vehicleErrors = (sess.vehicleErrors || 0) + 1; }
      if (res && res !== st && typeof res === 'object' && isNum(res.x)) car.state = st = res;
      if (!isNum(st.x) || !isNum(st.y) || !isNum(st.heading) || !isNum(num(st.vx, 0)) || !isNum(num(st.vy, 0))) {
        // numerical blow-up: rebuild a clean state at the last good pose
        sess.nanRecoveries++;
        var lg = car.lastGood;
        try { car.state = st = V.createState(car.params, { x: lg.x, y: lg.y, heading: lg.heading, speed: 0 }); }
        catch (e2) { car.state = st = FallbackVehicle.createState(FallbackVehicle.fromBuild(car.build, car.metrics), lg); car.V = FallbackVehicle; }
        car.wvx = car.wvy = 0;
        return;
      }
      var mx = (st.x - px) / STEP, my = (st.y - py) / STEP;
      detectFrame(car, mx, my);
      car.wvx = mx; car.wvy = my;
      // off-track rolling drag (grass / sand) — applied on top of the vehicle model
      var sf = SURFACES[car.surface] || SURFACES.asphalt;
      if (sf.decel > 0) {
        var wv = worldVel(car), v = Math.hypot(wv[0], wv[1]);
        if (v > 0.1) {
          // The constant part fades out at a crawl: the vehicle model already applies the surface's rolling
          // resistance, and stacking both would beach a car for good in a gravel trap (no way to drive out).
          var crawl = v < 6 ? v / 6 : 1;
          var dec = (sf.decel * crawl * crawl + sf.decelV * v) * (inp.throttle > 0.1 ? 1 : 1.25);
          var f = Math.max(0, 1 - dec * STEP / v);
          setWorldVel(car, wv[0] * f, wv[1] * f);
          if (isNum(st.yawRate)) st.yawRate *= 1 - (car.surface === 'sand' ? 1.2 : 0.4) * STEP;
        }
      }
      car.input = inp;
      if (hookList.length) callHooks('postStep', [car, STEP]);
    }

    /* ---------------- projection & surface ---------------- */
    function projectCar(car) {
      var st = car.state, p = projectA(A, st.x, st.y, car.hint);
      car.proj = p; car.hint = p.index; car.lateral = p.lateral;
      car.prevLapS = car.lapS;
      car.lapS = wrapS(p.s - A.s0, A.L);
      var surf = null, onTrack = null, T = mods.tracks;
      if (T && typeof T.project === 'function' && !tr.raw.fallback) {
        try {
          var r = T.project(tr.raw, st.x, st.y, isNum(car.thint) ? car.thint : p.index);
          if (r) {
            if (isNum(r.index)) car.thint = r.index;
            if (typeof r.surface === 'string') surf = r.surface;
            if (typeof r.onTrack === 'boolean') onTrack = r.onTrack;
          }
        } catch (e) { /* internal classification below */ }
      }
      if (!surf || !SURFACES[surf]) surf = surfaceFromLateral(A, p.index, p.lateral);
      car.surface = surf;
      car.onTrack = onTrack !== null ? onTrack : (surf === 'asphalt' || surf === 'kerb' || surf === 'pit');
      car.lastGood.x = st.x; car.lastGood.y = st.y; car.lastGood.heading = st.heading;
    }

    /* ---------------- walls ---------------- */
    function walls(car) {
      if (car.dnf) return;
      var st = car.state, i = car.proj.index, nx = -A.TY[i], ny = A.TX[i];
      var c = Math.cos(st.heading), s = Math.sin(st.heading);
      var maxLat = -Infinity, minLat = Infinity, cmax = null, cmin = null;
      for (var k = 0; k < 4; k++) {
        var lx = (k < 2 ? 1 : -1) * car.halfL, ly = (k === 0 || k === 3 ? 1 : -1) * car.halfW;
        var ox = c * lx - s * ly, oy = s * lx + c * ly;
        var lat = car.lateral + ox * nx + oy * ny;
        if (lat > maxLat) { maxLat = lat; cmax = [ox, oy]; }
        if (lat < minLat) { minLat = lat; cmin = [ox, oy]; }
      }
      var penL = maxLat - A.WL[i], penR = -minLat - A.WR[i];
      var pen = 0, Nx = 0, Ny = 0, r = null;
      if (penL > 0) { pen = penL; Nx = -nx; Ny = -ny; r = cmax; }
      else if (penR > 0) { pen = penR; Nx = nx; Ny = ny; r = cmin; }
      if (pen <= 0) return;
      st.x += Nx * (pen + 0.002); st.y += Ny * (pen + 0.002);
      car.lateral += (Nx * nx + Ny * ny) * (pen + 0.002);
      var wv = worldVel(car), w = num(st.yawRate, 0);
      var vcx = wv[0] - w * r[1], vcy = wv[1] + w * r[0];
      var vn = vcx * Nx + vcy * Ny;
      if (vn < 0) {
        var body = { m: car.mass, I: car.Iz, vx: wv[0], vy: wv[1], w: w, x: st.x, y: st.y };
        var wall = { m: 1e12, I: 1e12, vx: 0, vy: 0, w: 0, x: st.x + r[0] + Nx, y: st.y + r[1] + Ny };
        // contact normal must point from A (wall) to B (car) — wall is A here
        var arcW = cfg.handling === 'arcade';   // arcade: soft bounce, the car scrapes along instead of being spun
        var wr = resolveImpulse(wall, body, { nx: Nx, ny: Ny, px: st.x + r[0], py: st.y + r[1] }, arcW ? 0.25 : 0.3, arcW ? 0.12 : 0.45);
        if (-vn > 1.0) impact(car, wr.jn, r[0], r[1], { wall: true, speed: -vn });
        body.w = arcW ? clamp(body.w, -ARC_YAW_CAP, ARC_YAW_CAP) : clamp(body.w, -4, 4);
        setWorldVel(car, body.vx, body.vy);
        if (isNum(st.yawRate)) st.yawRate = body.w;
        var inten = clamp01(-vn / 18);
        car.wallHits++;
        if (sess.t >= car.wallCool && -vn > 1.2) {
          car.wallCool = sess.t + 0.3;
          emit('wall', car, inten, round(-vn, 2), null, { x: round(st.x + r[0], 2), y: round(st.y + r[1], 2) });
        }
      }
    }

    /* ---------------- car vs car ---------------- */
    function collisions() {
      var cars = sess.cars, n = cars.length;
      if (n < 2 || cfg.mode === 'time-trial') return;
      var boxes = new Array(n);
      for (var i = 0; i < n; i++) {
        var c = cars[i];
        boxes[i] = c.dnf || c.noCollide ? null : obbOf(c.state.x, c.state.y, c.state.heading, c.halfL, c.halfW);   // noCollide: arcade Ghost item
      }
      for (var iter = 0; iter < 2; iter++) {
        for (i = 0; i < n; i++) {
          if (!boxes[i]) continue;
          for (var j = i + 1; j < n; j++) {
            if (!boxes[j]) continue;
            var a = cars[i], b = cars[j];
            var dx = b.state.x - a.state.x, dy = b.state.y - a.state.y, rr = a.halfL + b.halfL + 0.3;
            if (dx * dx + dy * dy > rr * rr) continue;
            var hit = satObb(boxes[i], boxes[j]);
            if (!hit) continue;
            // positional correction split by inverse mass
            var invA = 1 / a.mass, invB = 1 / b.mass, corr = Math.max(0, hit.depth - 0.005) * 0.85 / (invA + invB);
            a.state.x -= hit.nx * corr * invA; a.state.y -= hit.ny * corr * invA;
            b.state.x += hit.nx * corr * invB; b.state.y += hit.ny * corr * invB;
            var wa = worldVel(a), wb = worldVel(b);
            var ba = { m: a.mass, I: a.Iz, vx: wa[0], vy: wa[1], w: num(a.state.yawRate, 0), x: a.state.x, y: a.state.y };
            var bb = { m: b.mass, I: b.Iz, vx: wb[0], vy: wb[1], w: num(b.state.yawRate, 0), x: b.state.x, y: b.state.y };
            var res = resolveImpulse(ba, bb, hit, 0.22, 0.32);
            var yc = cfg.handling === 'arcade' ? ARC_YAW_CAP : 5;
            ba.w = clamp(ba.w, -yc, yc); bb.w = clamp(bb.w, -yc, yc);
            setWorldVel(a, ba.vx, ba.vy); setWorldVel(b, bb.vx, bb.vy);
            if (isNum(a.state.yawRate)) a.state.yawRate = ba.w;
            if (isNum(b.state.yawRate)) b.state.yawRate = bb.w;
            boxes[i] = obbOf(a.state.x, a.state.y, a.state.heading, a.halfL, a.halfW);
            boxes[j] = obbOf(b.state.x, b.state.y, b.state.heading, b.halfL, b.halfW);
            if (res.jn > 0 && iter === 0 && -res.vn > 0.8) {
              impact(a, res.jn, hit.px - a.state.x, hit.py - a.state.y, { otherId: b.id, speed: -res.vn });
              impact(b, res.jn, hit.px - b.state.x, hit.py - b.state.y, { otherId: a.id, speed: -res.vn });
            }
            if (res.jn > 0 && (sess.phase === 'grid' || sess.phase === 'countdown')) {
              // a car shunted out of its grid box by someone else is not jumping the start
              a.gridShunt = true; b.gridShunt = true;
            }
            if (res.jn > 0 && iter === 0) {
              var key = a.idx + ':' + b.idx, until = sess.pairCool[key] || 0;
              if (sess.t >= until && -res.vn > 0.8) {
                sess.pairCool[key] = sess.t + 0.35;
                a.collisions++; b.collisions++;
                emit('collision', a, clamp01(-res.vn / 14), round(-res.vn, 2), null,
                  { otherId: b.id, x: round(hit.px, 2), y: round(hit.py, 2) });
              }
            }
          }
        }
      }
    }

    /* ---------------- timing ---------------- */
    function penalize(car, secs, reason) {
      if (!(secs > 0) || car.finished && cfg.mode !== 'race') return;
      car.penalties += secs;
      car.penaltyLog.push({ t: round(sess.t, 3), s: secs, reason: reason });
      emit('penalty', car, 0.8, secs, '+' + secs + 's ' + reason);
    }

    function timing(car, tPrev) {
      var tracker = car.tracker;
      var evs = tracker.advance(car.prevLapS, car.lapS);
      var racing = sess.goT !== null && sess.phase !== 'grid' && sess.phase !== 'countdown';
      if (evs) {
        for (var e = 0; e < evs.length; e++) {
          var ev = evs[e], tc = tPrev + clamp(num(ev.frac, 1), 0, 1) * STEP;
          if (!racing) { if (ev.kind === 'arm') car.armed = true; continue; }
          if (car.finished && cfg.mode === 'race') continue;
          if (ev.kind === 'sector') onSector(car, ev.k, tc);
          else if (ev.kind === 'arm') onArm(car, tc);
          else if (ev.kind === 'lap') onLap(car, tc);
          else if (ev.kind === 'cut') onCut(car, tc, ev.missed);
          else if (ev.kind === 'unsector') car.curSectors[ev.k] = null;
        }
      }
      car.prevDist = car.raceDist;
      car.raceDist = tracker.distance(car.lapS);
      recordPass(car, tPrev);
      // live delta trace (player)
      if (car.isPlayer && racing && car.armed && !car.finished) {
        var tl = sess.t - car.lapStartT, k = Math.floor(car.lapS / TRACE_BUCKET);
        if (tracker.debt === 0) {
          while (car.trace.length <= k && car.trace.length < 100000) car.trace.push(tl);
          if (car.bestTrace) {
            var kk = car.lapS / TRACE_BUCKET, i0 = Math.floor(kk);
            if (i0 + 1 < car.bestTrace.length) {
              var ref = lerp(car.bestTrace[i0], car.bestTrace[i0 + 1], kk - i0);
              car.deltaBest = tl - ref;
            }
          }
        }
      }
    }

    function onSector(car, k, tc) {
      var time = tc - car.sectorStartT;
      car.curSectors[k] = time;
      car.sectorStartT = tc;
      if (!car.armed) return;
      emit('sector', car, 0.3, round(time, 3), 'S' + (k + 1), { sector: k + 1, lapValid: car.lapValid });
    }

    function onArm(car, tc) {
      car.armed = true;
      if (cfg.mode !== 'race') {           // flying lap starts now
        car.lapStartT = tc; car.sectorStartT = tc; car.curSectors = [null, null, null];
        car.lapValid = true; car.ghostRec = []; car.trace = [];
      }
    }

    function onCut(car, tc, missed) {
      car.lapValid = false;
      emit('trackLimits', car, 0.7, missed, 'Lap not counted — missed sector ' + (missed + 1), { cut: true });
      if (cfg.mode !== 'race') {
        car.lapStartT = tc; car.sectorStartT = tc; car.curSectors = [null, null, null];
        car.lapValid = true; car.ghostRec = []; car.trace = [];
      }
    }

    function onLap(car, tc) {
      var lapTime = tc - car.lapStartT;
      car.curSectors[2] = tc - car.sectorStartT;
      var secs = car.curSectors.slice();
      var valid = car.lapValid;
      car.lapTimes.push({ lap: car.tracker.lap, time: lapTime, valid: valid, sectors: secs, penalties: car.penalties });
      car.lastLap = lapTime; car.lastSectors = secs;
      if (valid) {
        var improved = car.bestLap === null || lapTime < car.bestLap;
        if (improved) {
          car.bestLap = lapTime;
          if (car.isPlayer && car.trace.length) { car.trace.push(lapTime); car.bestTrace = car.trace.slice(); }
        }
        for (var k = 0; k < 3; k++) {
          if (secs[k] !== null && (car.bestSectors[k] === null || secs[k] < car.bestSectors[k])) car.bestSectors[k] = secs[k];
          if (secs[k] !== null && (sess.bestSectors[k] === null || secs[k] < sess.bestSectors[k])) sess.bestSectors[k] = secs[k];
        }
        if (!sess.fastestLap || lapTime < sess.fastestLap.time) {
          var hadPrev = !!sess.fastestLap;
          sess.fastestLap = { carId: car.id, time: lapTime, lap: car.tracker.lap, name: car.name };
          if (cfg.mode === 'race' || hadPrev) emit('fastestLap', car, 0.9, round(lapTime, 3), 'Fastest lap ' + fmtTime(lapTime));
        }
        if (car.isPlayer && cfg.mode === 'time-trial') maybeSaveGhost(car, lapTime);
      }
      emit('lap', car, 0.5, round(lapTime, 3), 'Lap ' + car.tracker.lap + (valid ? '' : ' (invalid)'),
        { lap: car.tracker.lap, valid: valid, sectors: secs.map(function (v) { return round(v, 3); }) });
      car.lapPositions.push(car.position);
      // new lap
      car.lapStartT = tc; car.sectorStartT = tc; car.curSectors = [null, null, null]; car.lapValid = true;
      car.ghostRec = []; car.trace = []; car.deltaBest = null;
      // finish handling
      if (cfg.mode === 'race') {
        if (sess.flagT === null && car.tracker.lap >= cfg.laps) {
          sess.flagT = tc;
          sess.leaderAvgLap = (tc - sess.goT) / Math.max(1, car.tracker.lap);
          emit('finish', car, 1, 1, 'Chequered flag', { leader: true });
          finishCar(car, tc);
        } else if (sess.flagT !== null) finishCar(car, tc);
      } else if (cfg.mode === 'time-trial' && car.isPlayer && cfg.laps > 0) {
        var timed = car.lapTimes.length;
        if (timed >= cfg.laps) { finishCar(car, tc); endSession(); }
      }
    }

    function finishCar(car, tc) {
      if (car.finished) return;
      if (cfg.mode === 'race' && pitsEnabled()) {
        var missing = mandatoryStops() - (car.pitStops || 0);
        if (missing > 0) penalize(car, 30 * missing, 'missed mandatory pit stop' + (missing > 1 ? 's' : ''));
      }
      car.finished = true; car.finishT = tc; car.finishRaceT = tc - (sess.goT || 0);
      car.finishDist = car.raceDist; car.finishLaps = car.tracker.lap;
      sess.finishOrder.push(car.id);
      car.finishPos = sess.finishOrder.length;
      car.gapLeaderFinal = sess.finishOrder.length === 1 ? 0 : timeGap(car, sess.cars.filter(function (c) { return c.id === sess.finishOrder[0]; })[0]);
      emit('finish', car, car.isPlayer ? 1 : 0.6, car.finishPos, 'P' + car.finishPos + ' — ' + car.name);
    }

    function endSession() {
      if (sess.phase === 'finished') return;
      sess.phase = 'finished'; sess.endT = sess.t;
      emit('sessionEnd', null, 1, round(sess.t, 3), 'Session complete');
    }

    /* ---------------- rules: track limits, wrong way, stuck/DNF ---------------- */
    function rules(car) {
      var t = sess.t, racing = sess.phase === 'racing' && sess.goT !== null;
      var st = car.state, i = car.proj.index, nx = -A.TY[i], ny = A.TX[i];
      // all four wheels off? The white line is the track edge; kerbs are part of the track (as in real track-limit rules).
      var edgeL = A.W[i] / 2 + A.KL[i] + TL_MARGIN, edgeR = A.W[i] / 2 + A.KR[i] + TL_MARGIN;
      var c = Math.cos(st.heading), s = Math.sin(st.heading), off = 0, offSide = 0;
      for (var k = 0; k < 4; k++) {
        var lx = k < 2 ? car.axA : -car.axB, ly = (k % 2 ? -1 : 1) * car.halfTrack;
        var lat = car.lateral + (c * lx - s * ly) * nx + (s * lx + c * ly) * ny;
        if (lat > edgeL) { off++; offSide += 1; } else if (lat < -edgeR) { off++; offSide -= 1; }
      }
      car.offTrack = off === 4;
      // inside of the corner (= cutting it, gaining an advantage) vs running wide (losing time on the run-off)
      var kk = A.K[i], inside = car.offTrack && Math.abs(kk) > 1 / 400 && sign(offSide) === sign(kk);
      var sp = Math.abs(num(st.speed, Math.hypot(car.wvx, car.wvy)));
      if (sp > car.maxSpeed) car.maxSpeed = sp;
      if (racing && !car.finished && !car.dnf && car.armed) {
        if (car.offTrack) {
          if (!car.exc) car.exc = { t0: t, counted: false, inside: false, d0: car.raceDist };
          if (inside) car.exc.inside = true;
          // a cut counts quickly; running wide only once it is a sustained excursion that keeps the car going
          var dur = t - car.exc.t0, need = car.exc.inside ? 0.15 : TL_WIDE_S;
          if (!car.exc.counted && dur > need && sp > 6 && car.raceDist - car.exc.d0 > (car.exc.inside ? 3 : 25)) {
            car.exc.counted = true; trackLimitsViolation(car, car.exc.inside);
          }
        } else car.exc = null;
      } else if (!car.offTrack) car.exc = null;
      // wrong way
      var ds = car.lapS - car.prevLapS;
      if (ds > A.L / 2) ds -= A.L; else if (ds < -A.L / 2) ds += A.L;
      car.dsdt = lerp(car.dsdt, ds / STEP, 0.04);
      var fwdDot = c * A.TX[i] + s * A.TY[i];
      if (fwdDot < -0.25 && car.dsdt < -1.5) car.wrongT += STEP; else car.wrongT = Math.max(0, car.wrongT - STEP * 2);
      var ww = car.wrongT > 1.0;
      if (ww && !car.wrongWay && car.isPlayer) emit('wrongWay', car, 0.6, null, 'Wrong way');
      car.wrongWay = ww;
      // stuck / DNF / AI recovery
      if (racing && !car.finished && !car.dnf) {
        // a car stationary in the pit box (or otherwise frozen) is not stuck: a long stop must never trigger recovery or a DNF
        if (car.pitPhase === 'stopped' || car.frozenUntil > t) { car.progressT = t; car.progressMark = car.raceDist; }
        else if (car.raceDist > car.progressMark + 3) { car.progressMark = car.raceDist; car.progressT = t; }
        var stuck = t - car.progressT;
        var botDriven = !car.isPlayer || car.autopilotActive;
        if (botDriven && car.pitPhase !== 'stopped' && cfg.aiAutoRecover_s > 0 && stuck > cfg.aiAutoRecover_s && t - car.lastResetT > cfg.aiAutoRecover_s && car.resets < 6) {
          resetCar(car, false, 'stuck');
        } else if (botDriven && car.pitPhase !== 'stopped' && car.wrongT > 6 && t - car.lastResetT > 6) {
          resetCar(car, false, 'wrongWay');
        }
        if (cfg.mode === 'race' && cfg.stuckDnf_s > 0 && stuck > cfg.stuckDnf_s) {
          car.dnf = true; car.dnfReason = 'stuck'; car.dnfT = t;
          emit('dnf', car, 0.8, round(car.raceDist, 1), car.name + ' — DNF');
        }
      }
    }

    function trackLimitsViolation(car, cut) {
      car.tlLog.push({ t: round(sess.t, 3), lap: car.tracker.lap + 1, s: round(car.lapS, 1), cut: !!cut });
      car.tlCount++;
      car.lapValid = false;
      if (cfg.mode === 'race') {
        var warn = cfg.trackLimitsWarnings;
        if (car.tlCount <= warn) emit('trackLimits', car, 0.5, car.tlCount, 'Track limits — warning ' + car.tlCount + '/' + warn);
        else {
          emit('trackLimits', car, 0.8, car.tlCount, 'Track limits — penalty');
          penalize(car, cfg.trackLimitsPenalty_s, 'track limits');
        }
      } else emit('trackLimits', car, 0.5, car.tlCount, 'Track limits — lap invalidated');
    }

    /* ---------------- reset to track ---------------- */
    function resetCar(car, manual, reason) {
      var back = manual ? 4 : 10, pose = null, tries = 0;
      while (tries++ < 8) {
        var s = car.lapS - back;
        var idx = indexAtAbsS(A, wrapS(s + A.s0, A.L));
        var cand = poseAt(A, s, clamp(A.RL[idx], -A.W[idx] / 2 + 1.5, A.W[idx] / 2 - 1.5));
        var clear = true;
        for (var j = 0; j < sess.cars.length; j++) {
          var o = sess.cars[j];
          if (o === car || o.dnf) continue;
          if (Math.hypot(o.state.x - cand.x, o.state.y - cand.y) < 9) { clear = false; break; }
        }
        pose = cand;
        if (clear) break;
        back += 10;
      }
      var st;
      try { st = car.V.createState(car.params, { x: pose.x, y: pose.y, heading: pose.heading, speed: 0 }, { autoShift: car.isPlayer ? cfg.assists.autoShift : true }); }
      catch (e) { st = null; }
      if (!st || !isNum(st.x)) { car.V = FallbackVehicle; car.params = FallbackVehicle.fromBuild(car.build, car.metrics); st = FallbackVehicle.createState(car.params, pose); }
      car.state = st; car.wvx = car.wvy = 0;
      car.hint = pose.index; car.thint = undefined;
      car.frozenUntil = sess.t + (manual ? 1.0 : 0.6);
      car.lastResetT = sess.t; car.resets++;
      car.wrongT = 0; car.exc = null; car.smSteer = 0;
      if (cfg.mode === 'time-trial' && car.isPlayer) car.lapValid = false;
      if (car.driver && typeof car.driver.reset === 'function') { try { car.driver.reset(); } catch (e2) { /* ignore */ } }
      emit('reset', car, 0.4, null, manual ? 'Reset to track' : 'Recovered', { reason: reason });
    }

    /* ---------------- positions & gaps ---------------- */
    function compareRace(a, b) {
      if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
      if (a.dnf && b.dnf) return b.raceDist - a.raceDist || a.idx - b.idx;
      if (a.finished && b.finished) return (b.finishLaps - a.finishLaps) || (a.finishT - b.finishT) || a.idx - b.idx;
      if (a.finished || b.finished) {
        var f = a.finished ? a : b, o = a.finished ? b : a;
        var fFirst = f.finishLaps >= o.tracker.lap;
        return fFirst ? (a.finished ? -1 : 1) : (a.finished ? 1 : -1);
      }
      return (b.raceDist - a.raceDist) || a.idx - b.idx;
    }
    function compareTimed(a, b) {
      var ab = a.bestLap, bb = b.bestLap;
      if (ab !== null && bb !== null) return ab - bb || a.idx - b.idx;
      if (ab !== null) return -1;
      if (bb !== null) return 1;
      return (b.raceDist - a.raceDist) || a.idx - b.idx;
    }
    function updatePositions(doGaps) {
      var order = sess.cars.slice().sort(cfg.mode === 'race' ? compareRace : compareTimed);
      for (var i = 0; i < order.length; i++) order[i].position = i + 1;
      sess.order = order;
      if (!doGaps) return;
      var leader = order[0];
      for (i = 0; i < order.length; i++) {
        var c = order[i];
        if (cfg.mode !== 'race') {
          c.gapLeader = c.bestLap !== null && leader.bestLap !== null ? c.bestLap - leader.bestLap : 0;
          c.gapAhead = i > 0 && c.bestLap !== null && order[i - 1].bestLap !== null ? c.bestLap - order[i - 1].bestLap : 0;
          c.lapsDown = 0;
          continue;
        }
        if (c.finished && c.gapLeaderFinal !== undefined) c.gapLeader = c.gapLeaderFinal;
        else c.gapLeader = i === 0 ? 0 : timeGap(c, leader);
        c.gapAhead = i === 0 ? 0 : timeGap(c, order[i - 1]);
        var ld = leader.finished ? leader.finishDist : leader.raceDist, cd = c.finished ? c.finishDist : c.raceDist;
        c.lapsDown = Math.max(0, Math.floor((ld - cd) / A.L));
      }
    }

    /* ---------------- ghost ---------------- */
    function playerHash() { return typeof cfg.buildHash === 'string' && cfg.buildHash ? cfg.buildHash : buildHash(sess.player.build); }
    function ghostKey() { return GHOST_KEY + ':' + (cfg.handling === 'arcade' ? 'arcade:' : '') + trackId + ':' + playerHash(); }
    function loadGhost() {
      if (cfg.ghost && Array.isArray(cfg.ghost.samples)) return cfg.ghost;
      if (!storage || !cfg.persistGhost) return null;
      try {
        var raw = storage.getItem(ghostKey());
        if (!raw) return null;
        var g = JSON.parse(raw);
        return g && Array.isArray(g.samples) && isNum(g.time) ? g : null;
      } catch (e) { return null; }
    }
    function maybeSaveGhost(car, lapTime) {
      if (!car.ghostRec.length) return;
      var cur = sess.ghost;
      if (cur && cur.time <= lapTime) return;
      var flat = [];
      for (var i = 0; i < car.ghostRec.length; i++) {
        var r = car.ghostRec[i];
        flat.push(round(r[0], 3), round(r[1], 2), round(r[2], 2), round(r[3], 3));
      }
      flat.push(round(lapTime, 3), round(car.state.x, 2), round(car.state.y, 2), round(car.state.heading, 3));
      var g = { v: 1, trackId: trackId, hash: playerHash(), time: lapTime, samples: flat, stride: 4, created: sess.ghostStamp };
      sess.ghost = g; persistentGhost = g; sess.ghostImproved = true;
      emit('ghost', car, 0.6, round(lapTime, 3), 'New ghost ' + fmtTime(lapTime));
      if (storage && cfg.persistGhost) { try { storage.setItem(ghostKey(), JSON.stringify(g)); } catch (e) { /* quota */ } }
    }
    function ghostPose() {
      var g = sess.ghost, p = sess.player;
      if (!g || cfg.mode !== 'time-trial' || !p.armed || sess.goT === null || p.finished) return null;
      var tl = sess.t - p.lapStartT, S = g.samples, n = (S.length / 4) | 0;
      if (n < 2 || tl < 0 || tl > S[(n - 1) * 4]) return null;
      var lo = 0, hi = n - 1;
      while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (S[mid * 4] <= tl) lo = mid; else hi = mid; }
      var t0 = S[lo * 4], t1 = S[hi * 4], w = t1 > t0 ? clamp((tl - t0) / (t1 - t0), 0, 1) : 0;
      var h0 = S[lo * 4 + 3], h1 = S[hi * 4 + 3];
      return { x: lerp(S[lo * 4 + 1], S[hi * 4 + 1], w), y: lerp(S[lo * 4 + 2], S[hi * 4 + 2], w), heading: wrapAngle(h0 + wrapAngle(h1 - h0) * w) };
    }
    function recordGhost(car) {
      if (cfg.mode !== 'time-trial' || !car.isPlayer || !car.armed || sess.goT === null || car.finished) return;
      if (sess.stepCount % GHOST_EVERY !== 0) return;
      if (car.ghostRec.length > 40 * 60 * 30) return;   // 30 min cap
      car.ghostRec.push([sess.t - car.lapStartT, car.state.x, car.state.y, car.state.heading]);
    }

    /* ---------------- race end ---------------- */
    function checkEnd() {
      if (sess.phase !== 'racing') return;
      if (cfg.mode === 'race') {
        var allDone = true;
        for (var i = 0; i < sess.cars.length; i++) { var c = sess.cars[i]; if (!c.finished && !c.dnf) { allDone = false; break; } }
        if (allDone) { endSession(); return; }
        if (sess.flagT !== null) {
          var limit = isNum(cfg.finishTimeout_s) ? cfg.finishTimeout_s : Math.max(60, sess.leaderAvgLap * 1.3 + 20);
          if (sess.t - sess.flagT > limit) endSession();
        }
      } else if (cfg.mode === 'time-trial' && cfg.maxTime_s && sess.t > cfg.maxTime_s) endSession();
    }

    /* ---------------- one fixed step ---------------- */
    function stepOnce(pin) {
      var tPrev = sess.t;
      sess.t += STEP;
      updatePhase();
      var cars = sess.cars, i, inputs = new Array(cars.length);
      buildContexts();
      for (i = 0; i < cars.length; i++) inputs[i] = computeInput(cars[i], pin);
      for (i = 0; i < cars.length; i++) integrate(cars[i], inputs[i]);
      for (i = 0; i < cars.length; i++) projectCar(cars[i]);
      for (i = 0; i < cars.length; i++) walls(cars[i]);
      collisions();
      for (i = 0; i < cars.length; i++) {
        var c = cars[i];
        if (Math.abs(c.state.x - c.lastGood.x) + Math.abs(c.state.y - c.lastGood.y) > 1e-6) {
          var keepPrev = c.prevLapS;
          projectCar(c);
          c.prevLapS = keepPrev;
        }
      }
      // jump start detection (race: car moved off its grid box before lights out)
      if (cfg.mode === 'race' && (sess.phase === 'grid' || sess.phase === 'countdown')) {
        for (i = 0; i < cars.length; i++) {
          var jc = cars[i];
          if (jc.jumpStart) continue;
          // only actual movement counts (cars are held on the line, so revving can never move one); a car shunted
          // out of its box by someone else is not jumping the start
          var selfPropelled = !jc.gridShunt;
          if (selfPropelled && Math.hypot(jc.state.x - jc.gridPose.x, jc.state.y - jc.gridPose.y) > 0.8) {
            jc.jumpStart = true;
            emit('jumpstart', jc, 0.9, cfg.jumpStartPenalty_s, 'Jump start — ' + jc.name);
            penalize(jc, cfg.jumpStartPenalty_s, 'jump start');
          }
        }
      }
      for (i = 0; i < cars.length; i++) timing(cars[i], tPrev);
      if (hookList.length) {
        if (pin && pin.pit && sess.player && !sess.player.pitPhase) { if (sess.player.pitRequest) { sess.player.pitRequest = null; emit('pitCancel', sess.player, 0.3, null, 'Pit call cancelled'); } else requestPit(sess.player); }
        for (i = 0; i < cars.length; i++) pitLogic(cars[i]);
      }
      for (i = 0; i < cars.length; i++) { rules(cars[i]); recordGhost(cars[i]); }
      updatePositions(sess.stepCount % 4 === 0);
      checkEnd();
      sess.stepCount++;
    }

    /* ---------------- init ---------------- */
    // Session setup also runs with a seeded Math.random so sibling modules (ai.createGrid, state.normalize ids, ...)
    // produce the same field for the same seed — restart() is an exact replay.
    function initSeeded() {
      if (!cfg.sandboxRandom) return init();
      var orig = Math.random;
      Math.random = makeRng((cfg.seed ^ 0x5bd1e995) >>> 0);
      try { init(); } finally { Math.random = orig; }
    }
    function init() {
      sess = {
        t: 0, stepCount: 0, phase: 'grid', goT: null, flagT: null, endT: null, leaderAvgLap: 60,
        rng: makeRng(cfg.seed), rngExt: makeRng((cfg.seed ^ 0x9e3779b9) >>> 0),
        events: [], eventLog: [], cars: [], order: [], pairCool: {}, finishOrder: [],
        bestSectors: [null, null, null], fastestLap: null, acc: 0, autopilot: !!cfg.playerAutopilot,
        velFrame: 'body', frameDecided: false, frameErrBody: 0, frameErrWorld: 0, frameVotes: 0,
        nanRecoveries: 0, ghost: null, ghostImproved: false, ghostStamp: cfg.seed, weather: weather, A: A, lastLights: 0
      };
      hookList = buildHookList();
      pitCfg = null;
      sess.playerBuild = resolvePlayerBuild();
      var opps = resolveOpponents(sess.playerBuild);
      // grid order: AI by estimated pace (power-to-weight × skill, seeded noise), player inserted at startPosition
      var scored = opps.map(function (o, k) {
        var m = metricsOf(normBuild(o.build || sess.playerBuild));
        var pw = m && isNum(m.powerToWeight_hpPerTon) ? m.powerToWeight_hpPerTon : 300;
        return { o: o, k: k, score: Math.sqrt(pw) * (0.6 + 0.4 * num(o.skill, 0.7)) * (1 + (sess.rng() - 0.5) * 0.08) };
      });
      if (cfg.gridOrder !== 'given') scored.sort(function (a, b) { return b.score - a.score || a.k - b.k; });
      var N = scored.length + 1, sp = cfg.startPosition, pIdx;
      if (isNum(sp)) pIdx = clamp(Math.round(sp) - 1, 0, N - 1);
      else if (sp === 'front' || cfg.mode !== 'race') pIdx = 0;
      else if (sp === 'back') pIdx = N - 1;
      else if (sp === 'random') pIdx = Math.floor(sess.rng() * N);
      else pIdx = Math.floor((N - 1) / 2);
      var entrants = scored.map(function (s) { return s.o; });
      entrants.splice(pIdx, 0, { id: 'player', name: cfg.playerName, build: sess.playerBuild, isPlayer: true });
      var ttSlot = cfg.mode === 'time-trial' ? poseAt(A, -Math.min(140, A.L * 0.08), 0) : null;
      for (var k = 0; k < entrants.length; k++) {
        var en = entrants[k], isP = !!en.isPlayer;
        var slot = isP && ttSlot ? ttSlot : gridSlot(k);
        var car = makeCar(k, en, isP, slot);
        sess.cars.push(car);
        if (isP) sess.player = car;
      }
      if (hookList.length) for (var hq = 0; hq < sess.cars.length; hq++) callHooks('carCreated', [sess.cars[hq]]);
      sandboxed(function () {
        for (var q = 0; q < sess.cars.length; q++) { var cc = sess.cars[q]; if (!cc.isPlayer) cc.driver = makeDriver(cc, cc.entrant, false); }
      });
      // AI reaction to lights-out: human-like 0.14..0.5 s, quicker for skilled drivers (seeded)
      for (var q2 = 0; q2 < sess.cars.length; q2++) {
        var c2 = sess.cars[q2], sk = clamp01(num(c2.entrant && c2.entrant.skill, 0.7));
        c2.launchDelay = c2.isPlayer ? 0 : 0.14 + sess.rng() * 0.24 * (1.35 - sk);
      }
      sess.order = sess.cars.slice();
      // countdown schedule
      if (cfg.mode === 'practice') { startRace(0); }
      else {
        sess.gridEndT = num(cfg.gridTime_s, cfg.mode === 'race' ? 1.5 : 0.8);
        sess.lightInterval = num(cfg.lightInterval_s, cfg.mode === 'race' ? 1.0 : 0.55);
        var hold = cfg.mode === 'race' ? sess.rng.range(0.4, 2.8) : 0.45;
        if (isNum(cfg.lightsOutDelay_s)) hold = cfg.lightsOutDelay_s;
        sess.lightsOutHold = hold;
        sess.lightsOutT = sess.gridEndT + 4 * sess.lightInterval + hold;
      }
      sess.ghost = persistentGhost || (cfg.mode === 'time-trial' ? loadGhost() : null);
      updatePositions(true);
    }

    /* ---------------- public API ---------------- */
    function update(dt, playerInput) {
      if (!isNum(dt) || dt <= 0) return 0;
      sess.acc += Math.min(dt, MAX_SUBSTEPS * STEP);
      var steps = 0, pin = cleanInput(playerInput);
      while (sess.acc >= STEP - 1e-9 && steps < MAX_SUBSTEPS) {
        sess.acc -= STEP;
        if (sess.acc < 0) sess.acc = 0;
        stepOnce(pin);
        if (steps === 0) { pin.shiftUp = false; pin.shiftDown = false; pin.requestReset = false; pin.pit = false; }  // edge-triggered
        steps++;
      }
      return steps;
    }

    function snapCar(c) {
      var st = c.state, wv = [c.wvx, c.wvy];
      var spd = Math.abs(num(st.speed, Math.hypot(wv[0], wv[1])));
      var gear = firstNum(st.gearDisplay, st.gear, 1);
      var racing = sess.goT !== null && sess.phase !== 'grid' && sess.phase !== 'countdown';
      var cur = racing && !c.finished && (c.armed || cfg.mode === 'race') ? sess.t - c.lapStartT : 0;
      return {
        id: c.id, isPlayer: c.isPlayer, name: c.name, team: c.team, number: c.number, color: c.color, accent: c.accent,
        build: c.build, bodyStyle: c.bodyStyle, length_m: c.length_m, width_m: c.width_m,
        x: st.x, y: st.y, heading: st.heading, prevX: c.prevX, prevY: c.prevY, prevHeading: c.prevH,
        speed: spd, vx: wv[0], vy: wv[1], rpm: num(st.rpm, 0), redline: c.redline, gear: gear, maxGear: c.maxGear,
        steerAngle: num(st.steerAngle, 0), throttle: num(c.input.throttle, 0), brake: num(c.input.brake, 0),
        handbrake: !!c.input.handbrake, slipF: num(st.slipAngleF, 0), slipR: num(st.slipAngleR, 0),
        skidding: clamp01(typeof st.skidding === 'boolean' ? (st.skidding ? 1 : 0) : num(st.skidding, 0)),
        wheelspin: clamp01(typeof st.wheelspin === 'boolean' ? (st.wheelspin ? 1 : 0) : num(st.wheelspin, 0)),
        surface: c.surface, lap: c.tracker.lap, s: c.lapS, lateral: c.lateral, raceDist: c.raceDist, position: c.position,
        gridPosition: c.gridPosition, currentLap_s: cur, lastLap_s: c.lastLap, bestLap_s: c.bestLap,
        sectors: c.curSectors.slice(), lastSectors: c.lastSectors.slice(), bestSectors: c.bestSectors.slice(),
        sector: c.tracker.cp + 1, gapAhead_s: c.gapAhead, gapLeader_s: c.gapLeader, lapsDown: c.lapsDown,
        finished: c.finished, finishTime_s: c.finishRaceT, finishPosition: c.finishPos || null,
        penalties_s: c.penalties, dnf: c.dnf, wrongWay: c.wrongWay, trackLimits: c.tlCount, lapValid: c.lapValid,
        offTrack: c.offTrack, onTrack: c.onTrack, jumpStart: c.jumpStart, reaction_s: c.reaction, deltaBest_s: c.isPlayer ? c.deltaBest : null,
        autopilot: !!c.autopilotActive, frozen: c.frozenUntil > sess.t, collisions: c.collisions, armed: c.armed,
        endurance: hookSnapshot(c), pitPhase: c.pitPhase || null, pitRequested: !!c.pitRequest, pitStops: c.pitStops || 0,
        pitLimiter: !!c.pitLimiter
      };
    }

    function snapshot() {
      var ev = sess.events;
      sess.events = [];
      return {
        t: sess.t, phase: sess.phase, countdown: countdownObj(), lapsTotal: cfg.laps, mode: cfg.mode, handling: cfg.handling,
        weather: cfg.weather, timeOfDay: cfg.timeOfDay, playerId: 'player', trackId: trackId,
        trackLength: A.L, sectorBounds: [A.b[0], A.b[1]], alpha: clamp01(sess.acc / STEP),
        raceTime: sess.goT !== null ? Math.max(0, (sess.endT !== null ? sess.endT : sess.t) - sess.goT) : 0,
        fastestLap: sess.fastestLap ? { carId: sess.fastestLap.carId, time: sess.fastestLap.time, lap: sess.fastestLap.lap } : null,
        sessionBestSectors: sess.bestSectors.slice(), flag: sess.flagT !== null, leaderId: sess.order[0] ? sess.order[0].id : null,
        cars: sess.cars.map(snapCar), order: sess.order.map(function (c) { return c.id; }),
        events: ev, ghost: ghostPose(), ghostBest_s: sess.ghost ? sess.ghost.time : null, assists: Object.assign({}, cfg.assists)
      };
    }

    function fmtTime(s) {
      if (!isNum(s)) return '—';
      var m = Math.floor(s / 60), r = s - m * 60;
      return (m ? m + ':' + (r < 10 ? '0' : '') : '') + r.toFixed(3);
    }

    function results() {
      var race = cfg.mode === 'race';
      var rows = sess.cars.map(function (c) {
        var status = c.dnf ? 'dnf' : c.finished ? 'finished' : 'running';
        return { c: c, status: status, total: c.finishRaceT !== null ? c.finishRaceT + c.penalties : null };
      });
      rows.sort(function (a, b) {
        var ra = a.status === 'finished' ? 0 : a.status === 'running' ? 1 : 2, rb = b.status === 'finished' ? 0 : b.status === 'running' ? 1 : 2;
        if (!race) return compareTimed(a.c, b.c);
        if (ra !== rb) {
          if (ra === 0 && rb === 1 && b.c.tracker.lap > a.c.finishLaps) return 1;
          if (ra === 1 && rb === 0 && a.c.tracker.lap > b.c.finishLaps) return -1;
          return ra - rb;
        }
        if (ra === 0) return (b.c.finishLaps - a.c.finishLaps) || (a.total - b.total) || a.c.idx - b.c.idx;
        return (b.c.raceDist - a.c.raceDist) || a.c.idx - b.c.idx;
      });
      var winner = rows[0];
      var classification = rows.map(function (r, i) {
        var c = r.c, gap = null, gapText = '';
        if (race) {
          if (i === 0) gapText = r.status === 'finished' ? fmtTime(r.total) : 'Leader';
          else if (r.status === 'dnf') gapText = 'DNF';
          else {
            var lapsDown = 0;
            if (winner.status === 'finished') {
              if (r.status === 'finished') lapsDown = winner.c.finishLaps - c.finishLaps;
              // a running car is only lapped once the winner's finishing distance is a full lap or more ahead of it
              else if (winner.c.finishDist !== null && A.L > 0) lapsDown = Math.max(0, Math.floor((winner.c.finishDist - c.raceDist) / A.L));
              else lapsDown = Math.max(0, winner.c.finishLaps - 1 - c.tracker.lap);
            }
            if (r.status === 'finished' && lapsDown <= 0 && winner.total !== null) { gap = r.total - winner.total; gapText = '+' + fmtTime(gap); }
            else if (lapsDown > 0) gapText = '+' + lapsDown + (lapsDown === 1 ? ' Lap' : ' Laps');
            else { gap = c.gapLeader; gapText = '+' + fmtTime(gap); }
          }
        } else {
          gap = c.bestLap !== null && winner.c.bestLap !== null ? c.bestLap - winner.c.bestLap : null;
          gapText = c.bestLap === null ? 'No time' : i === 0 ? fmtTime(c.bestLap) : '+' + fmtTime(gap);
        }
        // position-by-lap chart: the last entry is the classified position (time penalties applied), as in the table
        var pbl = c.lapPositions.slice();
        if (race && r.status === 'finished' && pbl.length) pbl[pbl.length - 1] = i + 1;
        return {
          position: i + 1, id: c.id, name: c.name, team: c.team, number: c.number, color: c.color, accent: c.accent,
          isPlayer: c.isPlayer, bodyStyle: c.bodyStyle, status: r.status, laps: c.finished ? c.finishLaps : c.tracker.lap,
          raceTime_s: c.finishRaceT, totalTime_s: r.total, penalties_s: c.penalties, penaltyLog: c.penaltyLog.slice(),
          gap_s: gap, gapText: gapText, bestLap_s: c.bestLap, lastLap_s: c.lastLap,
          lapTimes: c.lapTimes.map(function (l) { return l.time; }), laps_detail: c.lapTimes.map(function (l) { return { lap: l.lap, time: l.time, valid: l.valid, sectors: l.sectors.slice() }; }),
          bestSectors: c.bestSectors.slice(), trackLimits: c.tlCount, jumpStart: c.jumpStart, collisions: c.collisions,
          gridPosition: c.gridPosition, positionsByLap: pbl, reaction_s: c.reaction,
          topSpeed_kph: round(c.maxSpeed * 3.6, 1), dnfReason: c.dnfReason, fastestLap: !!(sess.fastestLap && sess.fastestLap.carId === c.id),
          pitStops: c.pitStops || 0, pitLog: c.pitLog ? c.pitLog.slice() : [], endurance: hookSnapshot(c)
        };
      });
      var player = classification.filter(function (r) { return r.isPlayer; })[0] || null;
      return {
        mode: cfg.mode, handling: cfg.handling, trackId: trackId, trackName: trackDef.name || trackId, trackLength_m: A.L, lapsTotal: cfg.laps,
        weather: cfg.weather, timeOfDay: cfg.timeOfDay, seed: cfg.seed, complete: sess.phase === 'finished',
        phase: sess.phase, raceTime_s: sess.goT !== null ? (sess.endT !== null ? sess.endT : sess.t) - sess.goT : 0,
        fastestLap: sess.fastestLap ? Object.assign({}, sess.fastestLap) : null, sessionBestSectors: sess.bestSectors.slice(),
        classification: classification, player: player, playerId: 'player', buildHash: playerHash(),
        ghost: sess.ghost ? { time: sess.ghost.time, improved: sess.ghostImproved } : null,
        lightsOutDelay_s: sess.lightsOutHold || 0, events: sess.eventLog.slice(-400), diagnostics: {
          nanRecoveries: sess.nanRecoveries, aiErrors: sess.aiErrors || 0, vehicleErrors: sess.vehicleErrors || 0,
          velocityFrame: sess.velFrame, vehicle: mods.vehicle === FallbackVehicle ? 'fallback' : 'CB.race.vehicle',
          ai: mods.ai ? 'CB.race.ai' : 'fallback', tracks: tr.raw.fallback ? 'fallback' : 'CB.race.tracks'
        }
      };
    }

    /**
     * Player vehicle state for CB.race.assist (DRIFT-SPEC §1): car frame (+x forward, +y left), SI units.
     * { speed, vxLocal, vyLocal, yawRate, heading, steerAngle, slipAngleF, slipAngleR, rpm, gear, maxSteer, maxSteer_rad,
     *   beta, angle_deg, x, y, vx, vy (world), s, lateral, onTrack, offTrack, surface, redline, maxGear, throttle, brake }.
     * Returns null before the session has a player car.
     */
    function playerState() {
      var c = sess && sess.player;
      if (!c || !c.state) return null;
      var st = c.state, p = c.params || {};
      var h = num(st.heading, 0), wv = worldVel(c);
      var cs = Math.cos(h), sn = Math.sin(h);
      var vxL = cs * wv[0] + sn * wv[1], vyL = -sn * wv[0] + cs * wv[1];
      var speed = Math.abs(num(st.speed, Math.hypot(wv[0], wv[1])));
      var beta = speed > 0.5 && Math.abs(vxL) > 0.05 ? Math.atan2(vyL, Math.abs(vxL)) : 0;
      var maxSteer = num(p.maxSteer, num(p.lockAngle, 0.6));
      return {
        id: c.id, x: num(st.x, 0), y: num(st.y, 0), heading: h, speed: speed, vxLocal: vxL, vyLocal: vyL, vx: wv[0], vy: wv[1],
        yawRate: num(st.yawRate, 0), steerAngle: num(st.steerAngle, 0), slipAngleF: num(st.slipAngleF, 0), slipAngleR: num(st.slipAngleR, 0),
        rpm: num(st.rpm, 0), gear: firstNum(st.gearDisplay, st.gear, 1), maxGear: c.maxGear, redline: c.redline,
        maxSteer: maxSteer, maxSteer_rad: maxSteer, beta: beta, angle_deg: Math.abs(beta) * 180 / Math.PI,
        throttle: num(c.input && c.input.throttle, 0), brake: num(c.input && c.input.brake, 0),
        s: num(c.lapS, 0), lateral: num(c.lateral, 0), onTrack: c.onTrack !== false, offTrack: !!c.offTrack,
        surface: c.surface || 'asphalt', wrongWay: !!c.wrongWay, length_m: c.length_m, width_m: c.width_m
      };
    }

    function simulate(seconds, input) {
      var n = Math.round(num(seconds, 0) / STEP), done = 0;
      while (done < n) { done += update(Math.min(n - done, MAX_SUBSTEPS) * STEP, input); }
      return done;
    }

    var api = {
      geom: tr.raw, trackDef: trackDef, track: trackDef, config: cfg, STEP: STEP,
      update: update, snapshot: snapshot, results: results, playerState: playerState,
      restart: function () { initSeeded(); return api; },
      resetPlayerToTrack: function () { if (sess.player && !sess.player.dnf) resetCar(sess.player, true, 'manual'); },
      setAssists: function (a) { Object.keys(a || {}).forEach(function (k) { if (k in cfg.assists) cfg.assists[k] = !!a[k]; }); },
      setPlayerAutopilot: function (on) { sess.autopilot = !!on; },
      requestPit: function (carId, request) {
        if (carId && typeof carId === 'object') { request = carId; carId = null; }
        var car = carId == null ? sess.player : sess.cars.filter(function (c) { return c.id === carId; })[0];
        return pitsEnabled() ? requestPit(car, request) : false;
      },
      cancelPit: function (carId) { var car = carId == null ? sess.player : sess.cars.filter(function (c) { return c.id === carId; })[0]; if (car && !car.pitPhase) car.pitRequest = null; },
      pitInfo: function () { return pitsEnabled() ? Object.assign({ mandatory: mandatoryStops() }, pitLane()) : null; },
      hooks: function () { return hookList.slice(); },
      simulate: simulate,
      simulateToEnd: function (maxSeconds) {
        var prev = sess.autopilot; sess.autopilot = true;
        var lim = num(maxSeconds, 3600), t0 = sess.t;
        while (sess.phase !== 'finished' && sess.t - t0 < lim) simulate(1);
        sess.autopilot = prev;
        return results();
      },
      end: function () { endSession(); },
      getGhost: function () { return sess.ghost; },
      clearGhost: function () {
        sess.ghost = null; persistentGhost = null;
        if (storage) { try { storage.removeItem(ghostKey()); } catch (e) { /* ignore */ } }
      },
      time: function () { return sess.t; },
      getPhase: function () { return sess.phase; },
      alpha: function () { return clamp01(sess.acc / STEP); },
      fmtTime: fmtTime,
      _debug: function () { return sess; }
    };
    initSeeded();
    return api;
  }

  CB.race.engine = {
    createSession: createSession,
    STEP: STEP,
    buildHash: buildHash,
    _internal: {
      mulberry32: mulberry32, makeRng: makeRng, hashString: hashString, LapTracker: LapTracker, obbOf: obbOf, satObb: satObb,
      resolveImpulse: resolveImpulse, adaptGeom: adaptGeom, projectA: projectA, poseAt: poseAt, buildFallbackGeom: buildFallbackGeom,
      FallbackVehicle: FallbackVehicle, FallbackDriver: FallbackDriver, FALLBACK_TRACK: FALLBACK_TRACK, surfaceFromLateral: surfaceFromLateral
    }
  };
})();

if (typeof module !== 'undefined') module.exports = CB.race.engine;

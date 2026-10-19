/* ==========================================================================
   Redline — js/arcade/stunt-ai.js
   CB.arcade.stunt.ai : AI drivers for the 3D stunt tracks. Pure logic, deterministic, Node-loadable.

   Everything is in track space (s, lateral + = left, psi): a precomputed speed profile (arcade corner limits with the
   bank bonus + braking pass, minimum speeds into loops / corkscrews / gaps), a smoothed racing line (inside of corners,
   centred through loops / walls / gaps, pulled onto boost pads), pure-pursuit steering, simple overtaking offsets.
   Jumps are made reliable by the physics jump assist (assist mode 'ai').

     plan = CB.arcade.stunt.ai.plan(track)                 cached per track: { speed Float32Array, line Float32Array }
     drv  = CB.arcade.stunt.ai.createDriver(opts {skill 0..1, laneBias m, seed})
     input = CB.arcade.stunt.ai.drive(drv, car, track, ctx {cars, dt, phase, drive (model state, for wheelbase)})
             -> {throttle, brake, steer, nitro}
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.arcade = CB.arcade || {};
CB.arcade.stunt = CB.arcade.stunt || {};

(function (S) {
  'use strict';

  var V = S._vec, clamp = V.clamp, num = V.num, wrapS = V.wrapS, wrapD = V.wrapD;
  var BRAKE = 17;            // m/s² the profile assumes for braking
  var plans = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function plan(track) {
    var cached = plans && plans.get(track);
    if (cached) return cached;
    var P = S.physics, F = track.FLAGS, N = track.N, DS = track.DS;
    var sp = new Float32Array(N), line = new Float32Array(N), i;
    for (i = 0; i < N; i++) {
      var k = Math.abs(track.KL[i]), bank = track.B[i];
      var lim = k > 1e-4 ? Math.sqrt(P.latMaxAt(bank, 0.94) / k) : 200;
      var f = track.F[i];
      if (f & (F.loop | F.cork)) lim = Math.max(lim, (f & F.zerog) ? 30 : 26);
      sp[i] = Math.min(200, lim);
    }
    // braking pass (two sweeps around the loop handle the wrap)
    for (var sweep = 0; sweep < 2; sweep++) {
      for (i = N - 1; i >= 0; i--) {
        var nx = sp[(i + 1) % N];
        var cap = Math.sqrt(nx * nx + 2 * BRAKE * DS);
        if (sp[i] > cap) sp[i] = cap;
      }
    }
    // gaps: never brake into a lip — hold at least the design speed for the run-up
    track.gaps.forEach(function (g) {
      if (g.cannon) return;   // a cannon fires every car on the same arc: no run-up speed needed
      var i0 = Math.round(g.s0 / DS);
      for (var d = 0; d < 120; d++) { var j = ((i0 - d) % N + N) % N; sp[j] = Math.max(sp[j], g.designSpeed * 1.05); }
    });
    // racing line: inside of corners (+ = left), centred on stunt pieces
    var raw = new Float32Array(N);
    for (i = 0; i < N; i++) {
      var kl = track.KL[i], hw = track.W[i] / 2 - 2;
      var f2 = track.F[i];
      if (f2 & (F.loop | F.cork | F.wall | F.gap | F.ramp | F.landing | F.warp)) { raw[i] = 0; continue; }
      raw[i] = clamp(kl * 60, -1, 1) * Math.max(0, hw) * 0.8;
    }
    var win = Math.round(30 / DS);
    for (i = 0; i < N; i++) {
      var acc = 0, ws = 0;
      for (var o = -win; o <= win; o += 2) { var w = win + 1 - Math.abs(o); acc += raw[((i + o) % N + N) % N] * w; ws += w; }
      line[i] = acc / ws;
    }
    var out = { speed: sp, line: line };
    if (plans) plans.set(track, out);
    return out;
  }

  function createDriver(o) {
    o = o || {};
    var skill = clamp(num(o.skill, 0.75), 0, 1);
    return {
      skill: skill, laneBias: num(o.laneBias, 0), latMult: 0.86 + 0.12 * skill, pace: 0.93 + 0.07 * skill,
      seed: (o.seed >>> 0) || 1, wobble: 0, avoid: 0, padTarget: null, dodge: 0
    };
  }
  /** deterministic 0..1 hash (split lane choices per lap) */
  function hash01(a, b, c) {
    var h = (a ^ Math.imul(b | 0, 0x9E3779B1) ^ Math.imul(c | 0, 0x85EBCA77)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0; h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  /** the split ahead (or under) the car: {sp, d (m to its nose)} */
  function splitAhead(track, s, range) {
    var sp = track.splits || [], L = track.length;
    for (var i = 0; i < sp.length; i++) {
      var q = sp[i], d = wrapD(q.s0 - s, L);
      if (d > -q.len && d < range) return { sp: q, d: d };
    }
    return null;
  }
  /** lane centre of a split side (+1 = lat above the divider) */
  function laneCentre(q, side, hw) { return side > 0 ? (q.div + q.dw + hw) / 2 : (q.div - q.dw - hw) / 2; }

  function at(arr, track, s) { var i = Math.round(wrapS(s, track.length) / track.DS) % track.N; return arr[i]; }

  function drive(drv, c, track, ctx) {
    ctx = ctx || {};
    var pl = plan(track), F = track.FLAGS;
    if (c.mode !== 'ground') return { throttle: 1, brake: 0, steer: 0, nitro: false };
    var v = c.v, s = c.s;
    // target speed: the minimum of the profile over the next few metres
    var vt = 200;
    for (var d = 0; d <= 24; d += 6) vt = Math.min(vt, at(pl.speed, track, s + d + v * 0.15));
    vt *= drv.pace * (0.97 + 0.03 * drv.skill);
    var throttle = 1, brake = 0;
    if (v > vt + 1.5) { throttle = 0; brake = clamp((v - vt) / 8, 0.15, 1); }
    else if (v > vt) throttle = 0.4;
    // lateral target: racing line + lane bias, boost pads ahead, avoidance
    var la = clamp(7 + 0.42 * Math.abs(v), 9, 34);
    var sm = track.sample(s + la);
    var hw = sm.halfWidth - 1.6;
    var tl = at(pl.line, track, s + la) + drv.laneBias;
    var stunt = sm.flags & (F.loop | F.cork | F.wall | F.gap | F.ramp);
    if (stunt) tl = drv.laneBias * 0.3;
    if (ctx.pads && ctx.pads.length) {
      for (var p = 0; p < ctx.pads.length; p++) {
        var dp = wrapD(ctx.pads[p].s - s, track.length);
        if (dp > 8 && dp < 75) { tl = ctx.pads[p].lat; break; }
      }
    }
    // avoidance: a car just ahead in our lane -> pick the freer side
    var cars = ctx.cars || [];
    drv.avoid *= 0.97;
    for (var k = 0; k < cars.length; k++) {
      var o = cars[k];
      if (o === c || o.mode !== 'ground') continue;
      var ds = wrapD(o.s - s, track.length);
      if (ds > 1 && ds < 16 && Math.abs(o.lat - (c.lat + drv.avoid)) < 2.4 && o.v < v + 1) {
        drv.avoid = (o.lat > 0 ? -3.2 : 3.2);
      }
    }
    // split lanes: commit to a lane before the divider nose (shortcut odds grow with skill, re-rolled every lap)
    var spA = splitAhead(track, s, 90), lane = 0, laneLo = -hw, laneHi = hw;
    if (spA) {
      var q = spA.sp, lap = Math.floor(num(c.dist, 0) / track.length);
      lane = c.lane || (hash01(drv.seed, Math.round(q.s0), lap) < 0.2 + 0.65 * drv.skill ? q.inner : -q.inner);
      var hwq = track.sample(q.s0 + Math.max(0, -spA.d) + 10).halfWidth - 1.6;
      tl = laneCentre(q, lane, hwq) + drv.laneBias * 0.2;
      if (lane > 0) laneLo = q.div + q.dw + 1.3; else laneHi = q.div - q.dw - 1.3;
    }
    // moving hazards / bumpers: dodge to the free side of whatever will be there when we arrive (better drivers read
    // the timing better; a miss is harmless anyway)
    var Fe = S.features;
    if (Fe && ctx.t != null) {
      var hz = Fe.hazardsNear(track, s, 45 + Math.abs(v) * 0.8, ctx.t, v), dodge = null, best = 1e9;
      for (var h = 0; h < hz.length; h++) {
        var st = hz[h].state;
        if (!st.active || hz[h].d < 2 || hash01(drv.seed, Math.round(hz[h].f.s), Math.floor(ctx.t)) > 0.35 + 0.65 * drv.skill) continue;
        if (tl + 1.4 < st.lat0 || tl - 1.4 > st.lat1) continue;
        var up = st.lat1 + 1.8, dn = st.lat0 - 1.8, pick = Math.abs(up - tl) < Math.abs(dn - tl) ? up : dn;
        if (pick > laneHi || pick < laneLo) pick = pick === up ? dn : up;
        if (hz[h].d < best) { best = hz[h].d; dodge = pick; }
      }
      var bm = Fe.index(track).by.bumper;
      for (var b = 0; b < bm.length; b++) {
        var db = wrapD(bm[b].s - s, track.length);
        if (db < 3 || db > 40 || Math.abs(tl - bm[b].lat) > 2.6) continue;
        var pb = bm[b].lat + (tl >= bm[b].lat ? 2.8 : -2.8);
        if (pb > laneHi || pb < laneLo) pb = bm[b].lat + (tl >= bm[b].lat ? -2.8 : 2.8);
        if (db < best) { best = db; dodge = pb; }
      }
      if (dodge !== null) tl = dodge;
    }
    tl = clamp(tl + drv.avoid, Math.max(-hw, laneLo), Math.min(hw, laneHi));
    // pure pursuit in track space
    var psiDes = Math.atan2(tl - c.lat, la);
    var kAhead = track.sample(s + la * 0.5).kLeft;
    var yawDes = kAhead * v + (psiDes - c.psi) * 3.2;
    var M = ctx.driveModel, steer;
    if (M && typeof M.steerFor === 'function') steer = M.steerFor(c.drive, yawDes, v, { bank: sm.bank });
    else {
      var wb = (c.drive && c.drive.wheelbase) || 2.65, av = Math.max(3, Math.abs(v)), lock = 0.62 / (1 + av / 18);
      steer = clamp(Math.atan(yawDes * wb / av) / lock, -1, 1);
    }
    // nitro (fallback only; the gameplay layer runs its own AI nitro): long straight, nothing tight ahead
    var nitro = v > 25 && at(pl.speed, track, s + 120) > v + 15 && drv.skill > 0.3;
    return { throttle: throttle, brake: brake, steer: steer, nitro: nitro };
  }

  S.ai = { plan: plan, createDriver: createDriver, drive: drive, splitAhead: splitAhead, laneCentre: laneCentre, hash01: hash01 };
  if (typeof module !== 'undefined' && module.exports) module.exports = S.ai;
})(CB.arcade.stunt);

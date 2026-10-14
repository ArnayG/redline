/* ==========================================================================
   Redline — js/arcade/stunt-physics.js
   CB.arcade.stunt.physics : TRACK-SPACE car motion for the 3D stunt tracks (js/arcade/stunt-track.js).
   Pure logic (no DOM), Node-loadable, deterministic, every car state is a plain JSON-serialisable object.

   Modes
     'ground'  integrated in track coordinates: s (m along the lap), lat (m, + = left), psi (heading relative to the
               track tangent, + = left), v (signed forward speed). The car is glued to the surface frame through loops,
               corkscrews, banks and wall-rides while the "magnet" holds:  press = v²·kNormal + g·up_y + magnet > 0,
               magnet = 0.4 g everywhere, +2.5 g on loop / corkscrew / wall / bowl segments while |v| >= 35 km/h
               (so a loop holds at > 35 km/h at the top and you drop out below that). Crests at speed (press < 0)
               and gap lips launch the car.
     'air'     world-space ballistic flight with arcade gravity 1.45 g, mild air steering, automatic pitch / roll / yaw
               stabilisation toward the surface below (landings are nearly always clean), jump assist (launch speed
               topped up to the gap's design speed, lateral drift nudged back over the landing). Re-attaches on ANY
               track surface it falls onto from above (within the s-window of the jump); falls below the ground plane,
               or > 8 s air, trigger a respawn.
     'respawn' short fade: teleport to the last checkpoint at a safe rolling speed, brief no-collide.

   Drive model adapter (docs/ARCADE-SPEC.md § Stunt tracks): the longitudinal / yaw response comes from a pluggable model
     model.create(build, opts) -> driveState
     model.step(driveState, input {throttle, brake, steer (+1 left), handbrake, nitro}, ctx) -> {accel, yawRate,
        steerAngle?, rpm?, gear?, vTop?}
     ctx { dt, speed (signed m/s), slope (m/s² along the car's nose from gravity, already applied by us — informative),
           topMult, push (extra m/s² toward vTarget), vTarget, throttleMult, latMax (m/s², arcade grip incl. bank bonus),
           bank (deg), onGround true }
   resolveDrive(cfg) picks, in order: cfg.drive (object with create/step), CB.arcade.drive (create/step),
   CB.race.vehicle when it advertises arcade handling (planar adapter: the 2D vehicle is stepped in the local
   tangent plane every substep), else the built-in fallback model (FALLBACK below).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.arcade = CB.arcade || {};
CB.arcade.stunt = CB.arcade.stunt || {};

(function (S) {
  'use strict';

  var G = 9.81, PI = Math.PI, TAU = PI * 2, DEG = PI / 180;
  var G_AIR = S.G_AIR || 1.45 * G;
  var SLOPE_K = 0.55;            // arcade: gravity along the track is softened (loops are climbable)
  var MAG_BASE = 0.4 * G;
  var MAG_STUNT = 2.5 * G;
  var V_ADHERE = 35 / 3.6;       // loop / wall adhesion threshold (m/s)
  var LAT_G = 2.3;               // arcade lateral grip (g) on a flat surface
  var HALF_W = 1.0;              // car half width (rails)
  var AIR_MAX = 8;               // s
  var LAND_MARGIN = HALF_W + 0.5; // landing capture beyond the road edge (car centre): a car half over the edge still lands
  var CREST_VY = 9;              // m/s: a hill crest only throws the car once its climb rate is below this (<= ~3 m hops)
  var GAP_FLAT = 1.06;           // faster than this x the design speed: launch on the flat ballistic solution to the deck
  var MERCY_FALLS = 2;           // mercy rule: falls in a row before the next jumps get guided help (until a clean landing)
  var RESPAWN_T = 0.9, RESPAWN_SWAP = 0.42;

  var V = S._vec;
  var add = V.add, sub = V.sub, mul = V.mul, madd = V.madd, dot = V.dot, cross = V.cross, len = V.len, norm = V.norm, ortho = V.ortho;
  var clamp = V.clamp, num = V.num, wrapS = V.wrapS, wrapD = V.wrapD;
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function wrapA(a) { a = (a + PI) % TAU; if (a < 0) a += TAU; return a - PI; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function FL() { return S.FLAGS; }

  /* ======================================================================
     Built-in arcade drive model (grip never breaks)
     ====================================================================== */
  function perfOf(build) {
    var pw = 250, top = 230;
    try {
      if (build && CB.physics && typeof CB.physics.compute === 'function') {
        var m = CB.physics.compute(CB.state && CB.state.normalize ? CB.state.normalize(build) : build);
        if (m && isNum(m.powerToWeight_hpPerTon)) pw = m.powerToWeight_hpPerTon;
        else if (m && isNum(m.power_hp) && isNum(m.weight_kg)) pw = m.power_hp / (m.weight_kg / 1000);
        if (m && isNum(m.topSpeed_kph)) top = m.topSpeed_kph;
      }
    } catch (e) { /* defaults */ }
    var wb = build && build.body && isNum(build.body.wheelbase_mm) ? build.body.wheelbase_mm / 1000 : 2.65;
    return { pw: pw, top: top, wheelbase: clamp(wb, 2.1, 3.4) };
  }
  var FALLBACK = {
    id: 'stunt-fallback',
    create: function (build, opts) {
      opts = opts || {};
      var p = opts.perf || perfOf(build);
      var k = clamp01((p.pw - 120) / 480);
      return {
        vmax: num(opts.vmax, 50 + 10 * k),             // 180..216 km/h — arcade classes stay close
        accel0: num(opts.accel0, 10 + 5 * k),
        brake: 26, wheelbase: p.wheelbase, steer: 0, gearN: 6
      };
    },
    step: function (st, inp, ctx) {
      var dt = ctx.dt, v = ctx.speed, thr = clamp01(num(inp.throttle, 0)) * num(ctx.throttleMult, 1), brk = clamp01(num(inp.brake, 0));
      var vTop = st.vmax * num(ctx.topMult, 1), a = 0;
      if (thr > 0.02 && v >= -0.5) {
        if (v < vTop) a += thr * st.accel0 * Math.max(0.12, 1 - Math.pow(Math.max(0, v) / vTop, 2.2));
        else a -= (v - vTop) * 0.7;
      } else a -= (v > 0 ? 1 : -1) * Math.min(Math.abs(v) / dt, 0.35 + 0.008 * Math.abs(v));
      if (brk > 0.02) {
        if (v > 0.8) a -= brk * st.brake;
        else if (v > -9) a -= brk * 7;          // reverse
      }
      if (ctx.push > 0 && v < num(ctx.vTarget, vTop) && v > -1) a += ctx.push;
      // steering: smoothed input, speed-sensitive lock, grip-limited yaw (never slides)
      var steer = clamp(num(inp.steer, 0), -1, 1);
      st.steer += (steer - st.steer) * Math.min(1, dt * 9);
      var av = Math.abs(v), lock = 0.62 / (1 + av / 18);
      var delta = st.steer * lock;
      var yaw = v * Math.tan(delta) / st.wheelbase;
      var latMax = num(ctx.latMax, LAT_G * G), cap = latMax / Math.max(4, av);
      yaw = clamp(yaw, -cap, cap);
      var fr = clamp01(av / Math.max(1, vTop)), gear = v < -0.3 ? -1 : 1 + Math.min(st.gearN - 1, Math.floor(fr * st.gearN * 0.999));
      var band = fr * st.gearN - (gear - 1);
      return { accel: a, yawRate: yaw, steerAngle: delta, rpm: 1800 + 5600 * clamp01(gear < 0 ? av / 9 : band), gear: gear, vTop: vTop };
    },
    /** Inverse steering map (AI): the steer input that yields yaw rate `yawDes` at speed v. */
    steerFor: function (st, yawDes, v) {
      var av = Math.max(3, Math.abs(v)), lock = 0.62 / (1 + av / 18);
      return clamp(Math.atan(yawDes * st.wheelbase / av) / lock, -1, 1);
    }
  };

  /**
   * Stateless adapter around CB.race.vehicle.arcadeResponse (ARCADE-SPEC §1.1): the build's real drive force / gearing /
   * drag / brakes and the arcade curvature-command steering; the stunt track adds its grip bonus (banks, a 2.3 g base)
   * through env.gripMult and caps the top speed at STUNT_VMAX (the maps are tuned around 180–230 km/h + boosts).
   */
  var STUNT_VMAX = 58;
  function responseAdapter(Vh) {
    function stuntGrip(D, bank) {
      var bonus = (1 + 1.3 * Math.sin(Math.min(80, Math.abs(num(bank, 0))) * DEG)) * (LAT_G / Math.max(0.8, D.latG));
      return clamp((bonus - 0.7) / 0.3, 1, 9);
    }
    return {
      id: 'race-vehicle-arcadeResponse',
      create: function (build, opts) {
        var p = null, metrics = null;
        try {
          var b = build || (CB.data && CB.data.defaultBuild ? CB.data.defaultBuild() : null);
          if (b && CB.physics && typeof CB.physics.compute === 'function') metrics = CB.physics.compute(CB.state && CB.state.normalize ? CB.state.normalize(b) : b);
          p = Vh.fromBuild(b, metrics, { handling: 'arcade' });
          if (p && typeof Vh.isArcade === 'function' && !Vh.isArcade(p) && typeof Vh.withHandling === 'function') p = Vh.withHandling(p, 'arcade');
        } catch (e) { p = null; }
        if (!p) return { fb: FALLBACK.create(build, opts), broken: true, vmax: 55, wheelbase: 2.65 };
        var top = num(p.capabilities && p.capabilities.topSpeed_mps, num(p.topSpeed_ms, 60));
        return { p: p, steer: 0, top: top, vmax: Math.min(top, STUNT_VMAX), wheelbase: num(p.wheelbase, 2.65), latG: num(p.arcade && p.arcade.latG, 1.4), gearN: num(p.maxGear, 6) };
      },
      step: function (D, inp, ctx) {
        if (D.broken) return FALLBACK.step(D.fb, inp, ctx);
        var dt = ctx.dt, v = ctx.speed, av = Math.abs(v);
        var steer = clamp(num(inp.steer, 0), -1, 1);
        // the circuit arcade model's steer slew (V.ARCADE): snappy in, quicker back to centre / through a flip
        var AR = Vh.ARCADE || {}, bigger = Math.abs(steer) > Math.abs(D.steer) && steer * D.steer >= 0;
        var rS = (bigger ? num(AR.steerRateIn, 14) : num(AR.steerRateOut, 18)) * dt;
        D.steer = D.steer < steer ? Math.min(D.steer + rS, steer) : Math.max(D.steer - rS, steer);
        var grip = stuntGrip(D, ctx.bank), topMult = num(ctx.topMult, 1) * (D.vmax / Math.max(10, D.top));
        var push = ctx.push > 0 && v < num(ctx.vTarget, 1e9) ? ctx.push : 0;
        var thr = clamp01(num(inp.throttle, 0)) * num(ctx.throttleMult, 1), brk = clamp01(num(inp.brake, 0));
        var r;
        try { r = Vh.arcadeResponse(D.p, av, { throttle: v >= -0.5 ? thr : 0, brake: v > 0.8 ? brk : 0, steer: D.steer }, { gripMult: grip, arcade: { push: push, topSpeedMult: topMult } }); }
        catch (e) { D.broken = true; D.fb = FALLBACK.create(null, {}); return FALLBACK.step(D.fb, inp, ctx); }
        var a = num(r.accelLong, 0);
        // stunt speed envelope: the build's own governor would let hypercars run away from the map design
        var capV = D.vmax * num(ctx.topMult, 1);
        if (push > 0) capV = Math.max(capV, Math.min(num(ctx.vTarget, capV), D.vmax * 1.45));
        if (v > capV) a = Math.min(a, -(v - capV) * 0.7);
        if (v <= 0.8 && brk > 0.02 && v > -9) a = -brk * 7;                       // reverse
        if (v < -0.3 && thr > 0.02) a = Math.max(a, 12);
        var fr = clamp01(av / Math.max(1, D.vmax * num(ctx.topMult, 1))), gear = v < -0.3 ? -1 : 1 + Math.min(D.gearN - 1, Math.floor(fr * D.gearN * 0.999));
        return { accel: a, yawRate: (v >= 0 ? 1 : -1) * num(r.yawRate, 0), steerAngle: num(r.steerAngle, 0), rpm: 1800 + 5600 * clamp01(fr * D.gearN - (gear - 1)), gear: gear, vTop: D.vmax * num(ctx.topMult, 1) };
      },
      steerFor: function (D, yawDes, v, ctx) {
        if (D.broken) return FALLBACK.steerFor(D.fb, yawDes, v);
        var av = Math.max(1, Math.abs(v)), k = 0;
        try { k = Vh.arcadeCurvatureLimit(D.p, av, stuntGrip(D, ctx && ctx.bank)); } catch (e) { k = 0; }
        return k > 1e-6 ? clamp(yawDes / (av * k), -1, 1) : 0;
      }
    };
  }

  /** Planar adapter around CB.race.vehicle (used only when it advertises arcade handling). */
  function vehicleAdapter(Vh) {
    return {
      id: 'race-vehicle-arcade',
      create: function (build, opts) {
        var params = Vh.fromBuild(build, null, { handling: 'arcade' });
        if (params && params.handling !== 'arcade') params.handling = 'arcade';
        var st = Vh.createState(params, { x: 0, y: 0, heading: 0, autoShift: true });
        return { params: params, st: st, fb: FALLBACK.create(build, opts) };
      },
      step: function (D, inp, ctx) {
        var st = D.st, v = ctx.speed;
        st.x = 0; st.y = 0; st.heading = 0;
        st.vx = v; if (isNum(st.vy)) st.vy *= 0.5;
        try {
          Vh.step(D.params, st, { throttle: num(inp.throttle, 0) * num(ctx.throttleMult, 1), brake: num(inp.brake, 0), steer: num(inp.steer, 0), handbrake: false }, ctx.dt, { gripMult: 1.2, surface: 'asphalt', assists: { abs: true, tc: true, autoShift: true } });
        } catch (e) { return FALLBACK.step(D.fb, inp, ctx); }
        var a = (num(st.vx, v) - v) / ctx.dt;
        if (ctx.push > 0 && v < num(ctx.vTarget, 1e9)) a += ctx.push;
        var latMax = num(ctx.latMax, LAT_G * G), cap = latMax / Math.max(4, Math.abs(v));
        return { accel: a, yawRate: clamp(num(st.yawRate, 0), -cap, cap), steerAngle: num(st.steerAngle, 0), rpm: num(st.rpm, 3000), gear: num(st.gearDisplay, num(st.gear, 1)) };
      }
    };
  }
  function vehicleAdvertisesArcade(Vh) {
    if (!Vh || typeof Vh.fromBuild !== 'function' || typeof Vh.createState !== 'function' || typeof Vh.step !== 'function') return false;
    if (Vh.arcade === true) return true;
    var modes = Vh.HANDLING_MODES || Vh.handlingModes || Vh.HANDLING;
    if (Array.isArray(modes)) return modes.indexOf('arcade') >= 0;
    if (modes && typeof modes === 'object') return !!modes.arcade;
    return typeof Vh.supportsHandling === 'function' ? !!Vh.supportsHandling('arcade') : false;
  }
  function resolveDrive(cfg) {
    cfg = cfg || {};
    var d = cfg.drive;
    if (d && typeof d === 'object' && typeof d.create === 'function' && typeof d.step === 'function') return d;
    if (d === 'builtin' || d === 'fallback') return FALLBACK;
    var A = CB.arcade.drive;
    if (A && typeof A.create === 'function' && typeof A.step === 'function') return A;
    var Vh = CB.race && CB.race.vehicle;
    if (Vh && typeof Vh.arcadeResponse === 'function' && typeof Vh.fromBuild === 'function' && typeof Vh.arcadeCurvatureLimit === 'function') return responseAdapter(Vh);
    if (d === 'vehicle' || (d !== 'builtin' && vehicleAdvertisesArcade(CB.race && CB.race.vehicle))) {
      if (vehicleAdvertisesArcade(CB.race && CB.race.vehicle) || d === 'vehicle') return vehicleAdapter(CB.race.vehicle);
    }
    return FALLBACK;
  }

  /* ======================================================================
     Car state
     ====================================================================== */
  function createCar(o) {
    o = o || {};
    return {
      id: o.id || 'car', mode: 'ground', s: wrapS(num(o.s, 0), o.L || 1e9), lat: num(o.lat, 0), psi: 0, v: num(o.v, 0),
      dist: num(o.dist, num(o.s, 0)),
      // air
      px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, fx: 1, fy: 0, fz: 0, ux: 0, uy: 1, uz: 0,
      airT: 0, airS: 0, takeoffS: 0, prevH: 0, lastAir: 0, assisted: false, airHd: null, fallStreak: 0,
      // visuals / timers
      susp: 0, suspV: 0, steerAngle: 0, rpm: 900, gear: 1, yawRate: 0, spinT: 0, spinDur: 1, spinDir: 1,
      respawnT: 0, fade: 0, ghostT: 0, stuckT: 0, wrongT: 0, railT: 0, boostT: 0, boostTop: 1, boostAccel: 0,
      throttle: 0, brake: 0, steer: 0, events: null, landings: 0, bestAir: 0, falls: 0, airTotal: 0
    };
  }

  /** World pose of a car: {pos, fwd, up, right} (pos = contact point at the surface, i.e. wheel bottoms). */
  var _sm = null;
  function pose(track, c, out) {
    out = out || { pos: [0, 0, 0], fwd: [1, 0, 0], up: [0, 1, 0], right: [0, 0, 1] };
    if (c.mode === 'air' || (c.mode === 'respawn' && c._air)) {
      out.pos[0] = c.px; out.pos[1] = c.py; out.pos[2] = c.pz;
      out.fwd[0] = c.fx; out.fwd[1] = c.fy; out.fwd[2] = c.fz;
      out.up[0] = c.ux; out.up[1] = c.uy; out.up[2] = c.uz;
    } else {
      _sm = track.sample(c.s, _sm);
      var cp = Math.cos(c.psi), sp = Math.sin(c.psi);
      for (var k = 0; k < 3; k++) {
        out.pos[k] = _sm.pos[k] + _sm.left[k] * c.lat;
        out.fwd[k] = _sm.tangent[k] * cp + _sm.left[k] * sp;
        out.up[k] = _sm.up[k];
      }
    }
    var r = cross(out.fwd, out.up);
    out.right[0] = r[0]; out.right[1] = r[1]; out.right[2] = r[2];
    return out;
  }

  function emit(c, type, data) {
    (c.events || (c.events = [])).push(Object.assign({ type: type, carId: c.id }, data || {}));
  }

  /** Arcade lateral grip incl. bank bonus (m/s²). */
  function latMaxAt(bankDeg, mult) { return LAT_G * G * (1 + 1.3 * Math.sin(Math.min(80, Math.abs(bankDeg)) * DEG)) * num(mult, 1); }
  /** Corner speed limit at a sample (m/s). */
  function cornerSpeed(track, s, mult) {
    var sm = track.sample(s, _cs || (_cs = null)); _cs = sm;
    var k = Math.abs(sm.kLeft);
    if (k < 1e-4) return 200;
    return Math.sqrt(latMaxAt(sm.bank, mult) / k);
  }
  var _cs = null;

  /* ======================================================================
     Step (one fixed substep)
     ctx { track, dt, drive (model), input {throttle, brake, steer, handbrake}, fx (gameplay effects or null),
           help 'player'|'guided'|'ai'|'off', jumpAssist (bool), respawnPoint(car) -> {s, dist}, latMult, paceMult }
     help = the internal stunt safety helpers (NOT a steering assist — the player's steering is never touched on the ground):
       'player' every human (one arcade feel): jump launch topped up to 1.02 x the gap's design speed, mild air guidance
                (flight pulled back over the road, heading follows the road below), softened landings;
       'guided' the mercy rule (after MERCY_FALLS falls in a row, until a clean landing): loop / gap speed top-up on the
                ground, 1.05 x launches, strong air guidance;  'ai' = guided for AI cars;  'off' raw physics (tests).
       Always on, any level: loop / wall adhesion, swept landing capture, guard rails (also in the air), over-speed gap arcs.
       Legacy ctx.assist values map: heavy -> guided, light / medium -> player, off -> off.
     ====================================================================== */
  var _a = null, _b = null;
  function step(c, ctx) {
    var tr = ctx.track, dt = ctx.dt, F = tr.FLAGS;
    c.ghostT = Math.max(0, c.ghostT - dt);
    c.spinT = Math.max(0, c.spinT - dt);
    if (c.boostT > 0) { c.boostT -= dt; if (c.boostT <= 0) { c.boostT = 0; c.boostTop = 1; c.boostAccel = 0; } }
    // suspension visual spring
    c.suspV += (-140 * c.susp - 16 * c.suspV) * dt; c.susp += c.suspV * dt;
    c.susp = clamp(c.susp, -0.35, 0.25);
    if (c.mode === 'respawn') return respawnStep(c, ctx);
    if (c.mode === 'air') return airStep(c, ctx);
    return groundStep(c, ctx);
  }

  function driveCtx(c, ctx, sm) {
    var fx = ctx.fx, boostTop = c.boostT > 0 ? c.boostTop : 1, push = c.boostT > 0 ? c.boostAccel : 0, vTarget = 0;
    var throttleMult = 1;
    if (fx) {
      if (fx.push > push) push = fx.push;
      throttleMult *= num(fx.throttleMult, 1);
      if (isNum(fx.vTarget) && fx.vTarget > 0) vTarget = fx.vTarget;
    }
    var pace = num(ctx.paceMult, 1);
    return {
      dt: ctx.dt, speed: c.v, topMult: boostTop * pace, push: push * (c.spinT > 0 ? 0 : 1), vTarget: vTarget || 1e9,
      throttleMult: throttleMult * (c.spinT > 0 ? 0.15 : 1), latMax: latMaxAt(sm.bank, ctx.latMult), bank: sm.bank, onGround: true, slope: 0
    };
  }

  function groundStep(c, ctx) {
    var tr = ctx.track, dt = ctx.dt, F = tr.FLAGS, L = tr.length;
    var sm = _a = tr.sample(c.s, _a);
    var cp = Math.cos(c.psi), sp = Math.sin(c.psi);
    // car nose direction (world) and gravity along it
    var fy = sm.tangent[1] * cp + sm.left[1] * sp;
    var slope = -G * fy * SLOPE_K;
    var inp = ctx.input || {};
    var dc = driveCtx(c, ctx, sm);
    dc.slope = slope;
    var r = ctx.drive.step(c.drive, inp, dc) || {};
    var accel = num(r.accel, 0) + slope;
    var fx = ctx.fx;
    if (fx && fx.brakeTo != null && c.v > fx.brakeTo) accel = Math.min(accel, -num(fx.brakeDecel, 20));
    var yaw = num(r.yawRate, 0);
    if (fx && fx.steer != null && isNum(fx.steer)) yaw = clamp(fx.steer, -1, 1) * Math.min(Math.abs(c.v), 40) * 0.012 + yaw * 0.3;
    c.steerAngle = num(r.steerAngle, 0); c.rpm = num(r.rpm, c.rpm); c.gear = num(r.gear, c.gear);
    c.vTop = num(r.vTop, c.vTop || 55);
    // no steering help on the ground (arcade handling: the player steers, nothing auto-aligns the nose)
    // loop / jump speed top-up (guided = the mercy rule, and AI): approaching a loop or a gap
    var help = helpOf(c, ctx);
    if ((help === 'guided' || help === 'ai') && c.v > 5) {
      var need = stuntNeed(tr, c.s, 90);
      if (need && c.v < need) accel = Math.max(accel, Math.min(9, (need - c.v) * 0.8 + 3));
    }
    c.v += accel * dt;
    if (c.v > 95) c.v = 95;
    c.yawRate = yaw;
    var denom = Math.max(0.35, 1 - sm.kLeft * c.lat);
    var sdot = c.v * Math.cos(c.psi) / denom;
    c.psi = wrapA(c.psi + (yaw - sm.kLeft * sdot) * dt);
    if (c.spinT > 0) c.psi *= 1 - Math.min(1, dt * 1.5);
    var nlat = c.lat + c.v * Math.sin(c.psi) * dt;
    var ns = c.s + sdot * dt;
    // gap lip -> launch (from the current point, before moving into the gap)
    var nflags = tr.flagsAt(ns);
    if ((nflags & F.gap) && sdot > 0) return launch(c, ctx, tr.gapAt(ns), sm);
    c.s = wrapS(ns, L);
    c.dist += sdot * dt;
    c.lat = nlat;
    // guard rails: clamp, scrape speed, turn the nose back along the rail
    var hw = sm.halfWidth - HALF_W;
    if (Math.abs(c.lat) > hw) {
      var side = c.lat > 0 ? 1 : -1;
      c.lat = side * hw;
      var into = Math.sin(c.psi) * side;
      if (into > 0) {
        var hit = Math.abs(c.v) * into;
        c.psi *= 0.25;
        c.v *= 1 - Math.min(0.18, into * 0.35);
        if (hit > 2 && c.railT <= 0) { emit(c, 'rail', { side: side, impact: hit, s: c.s }); c.railT = 0.25; }
      }
    }
    c.railT = Math.max(0, c.railT - dt);
    // adhesion
    var sm2 = _b = tr.sample(c.s, _b);
    var stunt = sm2.flags & (F.loop | F.cork | F.wall | F.bowl);
    var mag = MAG_BASE + (stunt && Math.abs(c.v) >= V_ADHERE ? MAG_STUNT : 0);
    var press = c.v * c.v * sm2.kNormal + G * sm2.up[1] + mag;
    // fast on a loop / corkscrew / wall / bowl the magnet always holds: the convex roll-in of a wall (v²·kNormal < 0) must
    // not throw a Mega-Nitro car off the entry (only a too-slow car drops out of a loop, via up_y at the top)
    if (stunt && Math.abs(c.v) >= V_ADHERE && press < 0) press = 0.1;
    // hill crests: still climbing steeply (a Mega Nitro car on the up-slope) the car stays glued over the shoulder and is
    // released near the top — a short hop instead of a 20 m moon shot that flies past the next bend / into a gap
    if (!stunt && press < 0 && c.v * sm2.tangent[1] > CREST_VY) press = 0.1;
    if (press < 0) return detach(c, ctx, sm2, stunt ? 'drop' : 'crest');
    // stuck / wrong way
    if (Math.abs(c.v) < 1.2 && !(ctx.input && ctx.input.throttle > 0.5 && c.v > -0.5)) c.stuckT += dt; else c.stuckT = Math.max(0, c.stuckT - dt * 2);
    if (c.v < -1 || Math.cos(c.psi) < -0.2) c.wrongT += dt; else c.wrongT = 0;
    if ((c.stuckT > 3 && ctx.autoRecover !== false) || c.wrongT > 4) startRespawn(c, ctx, c.stuckT > 3 ? 'stuck' : 'wrongWay');
    return c;
  }

  /** Minimum speed wanted at the next loop / gap within `range` m (null when none). */
  function stuntNeed(tr, s, range) {
    var F = tr.FLAGS, best = null;
    for (var d = 0; d < range; d += 4) {
      var f = tr.flagsAt(s + d);
      if (f & F.gap) { var g = tr.gapAt(s + d); if (g) return Math.max(best || 0, g.designSpeed * 1.04); }
      if (f & (F.loop | F.cork)) { best = Math.max(best || 0, 27); break; }
    }
    return best;
  }

  /** Base helper level of a step context ('player' default; legacy ctx.assist mapped). */
  function baseHelp(ctx) {
    var a = ctx.help || ctx.assist;
    if (a === 'player' || a === 'guided' || a === 'ai' || a === 'off') return a;
    if (a === 'heavy' || a === 'auto') return 'guided';
    return 'player';   // light / medium / undefined
  }
  /** Effective helper level incl. the mercy rule: after MERCY_FALLS falls in a row the next jumps get one level more help
   *  (off -> player, player -> guided) until a clean landing, so nobody is stuck in a respawn loop in front of a gap. */
  function helpOf(c, ctx) {
    var a = baseHelp(ctx);
    if (c.fallStreak >= MERCY_FALLS) return a === 'off' ? 'player' : a === 'player' ? 'guided' : a;
    return a;
  }
  function launch(c, ctx, gap, sm) {
    var tr = ctx.track;
    var P = pose(tr, c);
    var v = c.v;
    var help = helpOf(c, ctx);
    var ja = (ctx.jumpAssist !== false || c.fallStreak >= MERCY_FALLS) && help !== 'off';
    if (gap && ja) {
      var want = gap.designSpeed * (help === 'player' ? 1.02 : 1.05);   // the design arc lands exactly on the lip: aim past it
      if (v < want) { v = want; c.assisted = true; }
      if (help !== 'player') c.psi *= 0.2;
      P = pose(tr, c);
    }
    var vel = mul(P.fwd, v);
    if (gap && v > gap.designSpeed * GAP_FLAT) vel = flatLaunch(tr, gap, P, v) || vel;
    toAir(c, P.pos, vel, P.fwd, P.up, sm.s);
    emit(c, 'takeoff', { s: c.s, speed: v, gap: !!gap });
    return c;
  }
  /**
   * Over-speed gap launch (nitro / Mega Nitro / boost chains, any assist level): the lip's design arc would carry the car
   * far past the landing deck into whatever follows it (a bend, a drop) and off the world. Instead the car leaves on the
   * flat root of the ballistic equation that still hits the deck 6 m past the landing lip — same speed, flatter arc.
   */
  function flatLaunch(tr, gap, P, v) {
    var lp = tr.sample(gap.landS + 6).pos, d = sub(lp, P.pos), D = Math.hypot(d[0], d[2]), dy = d[1];
    var hx = P.fwd[0], hz = P.fwd[2], hl = Math.hypot(hx, hz);
    if (D < 2 || hl < 0.3) return null;
    var a = G_AIR * D * D / (2 * v * v), disc = D * D - 4 * a * (a + dy);
    if (disc < 0) return null;
    var thR = Math.asin(clamp(P.fwd[1], -1, 1));
    var th = Math.atan((D - Math.sqrt(disc)) / (2 * a));
    th = clamp(th, thR - 25 * DEG, thR);
    var ch = Math.cos(th) / hl;
    return [hx * ch * v, Math.sin(th) * v, hz * ch * v];
  }
  function detach(c, ctx, sm, why) {
    var P = pose(ctx.track, c);
    toAir(c, P.pos, mul(P.fwd, c.v), P.fwd, P.up, c.s);
    emit(c, why === 'drop' ? 'drop' : 'takeoff', { s: c.s, speed: c.v, crest: why === 'crest' });
    return c;
  }
  function toAir(c, pos, vel, fwd, up, s) {
    c.mode = 'air';
    c.px = pos[0]; c.py = pos[1]; c.pz = pos[2];
    c.vx = vel[0]; c.vy = vel[1]; c.vz = vel[2];
    c.fx = fwd[0]; c.fy = fwd[1]; c.fz = fwd[2];
    c.ux = up[0]; c.uy = up[1]; c.uz = up[2];
    c.airT = 0; c.airS = s; c.takeoffS = s; c.takeoffDist = c.dist; c.prevH = 0.05; c.airHd = null;
  }

  function airStep(c, ctx) {
    var tr = ctx.track, dt = ctx.dt, inp = ctx.input || {}, help = helpOf(c, ctx), L = tr.length;
    var guided = help === 'ai' || help === 'guided';
    c.airT += dt;
    var vel = [c.vx, c.vy, c.vz];
    vel[1] -= G_AIR * dt;
    // where are we over the track? (s-window around the jump)
    var pos = [c.px, c.py, c.pz];
    var near = tr.project(pos, { hintS: c.airS, window: 320, maxDist: 40, lateralMargin: 30 });
    var st = clamp(num(inp.steer, 0), -1, 1);
    var smN = null, hd = null;
    if (near) {
      smN = tr.sample(near.s);
      var dA = wrapD(near.s - c.takeoffS, L);
      if (dA > -90 && dA < 420) {   // progress along the track while flying (positions, laps, floating rings)
        c.airS = near.s; c.s = near.s; c.dist = num(c.takeoffDist, c.dist) + dA;
      }
      var thl = Math.hypot(smN.tangent[0], smN.tangent[2]);
      // follow the plan-view heading change of the track below (every level: a crest hop or a long gap in a bend carries
      // the car round with the road instead of straight off the outside of it; 'off' follows 80 %)
      if (thl > 0.3) {
        hd = Math.atan2(-smN.tangent[2], smN.tangent[0]);
        if (c.airHd !== null && isNum(c.airHd)) {
          var dh = wrapA(hd - c.airHd);
          if (Math.abs(dh) < 0.25) {
            var kf = help === 'off' ? 0.8 : 1, ph = dh * kf, cph = Math.cos(ph), sph = Math.sin(ph), ux = vel[0], uz = vel[2];
            vel[0] = ux * cph + uz * sph; vel[2] = -ux * sph + uz * cph;
          }
        }
      }
      var latV = dot(vel, smN.left);
      // edge guard (the guard rails, extended into the air): past the usable width the car cannot be steered further out
      // and its outward drift is damped — a flight that started over the road lands on it (edge landings included).
      // Over a gap (no rails) 'off' only loses the outward air steering.
      var overGap = !!(smN.flags & tr.FLAGS.gap);
      var edge = smN.halfWidth - HALF_W - (help === 'off' ? -0.3 : 0.4), over = Math.abs(near.lateral) - edge;
      var guard = over > 0, guardDamp = guard && !(overGap && help === 'off');
      // air steering: a lateral nudge in the track frame to aim the landing (bounded, so holding a key through a long
      // flight cannot carry the car metres off the road)
      if (st) {
        var aSt = st * 3.5;
        if (!(aSt > 0 && latV > 4.5) && !(aSt < 0 && latV < -4.5) && !(guard && aSt * near.lateral > 0)) { vel = madd(vel, smN.left, aSt * dt); latV += aSt * dt; }
      }
      // guidance: pull the flight back over the track centre (guided / AI strong, player mild)
      var kAs = guided ? 1 : help === 'player' ? 0.4 : 0.12;
      var target = clamp(near.lateral, -smN.halfWidth, smN.halfWidth);
      var aLat = clamp(-target * 1.6 * kAs - latV * 1.4 * kAs, -9, 9);
      vel = madd(vel, smN.left, aLat * dt);
      latV += aLat * dt;
      if (guardDamp && latV * near.lateral > 0) vel = madd(vel, smN.left, -latV * Math.min(1, dt * 8));
      // entering a gap while already airborne (crest jump before the lip): top the carry speed up to the design speed
      if ((smN.flags & tr.FLAGS.gap) && guided && ctx.jumpAssist !== false) {
        var gq = tr.gapAt(near.s), hs = Math.hypot(vel[0], vel[2]);
        if (gq && hs > 1 && hs < gq.designSpeed * 0.98) { var kk = gq.designSpeed * 0.98 / hs; vel[0] *= kk; vel[2] *= kk; if (vel[1] < 0 && near.height < 3) vel[1] *= 0.5; c.assisted = true; }
      }
      // ... and align the horizontal flight direction with the track below (corrects a launch heading)
      var th = [smN.tangent[0], 0, smN.tangent[2]], hv = Math.hypot(vel[0], vel[2]);
      if (thl > 0.3 && hv > 2 && help !== 'off') {
        var ang = Math.atan2((vel[2] * th[0] - vel[0] * th[2]) / thl, (vel[0] * th[0] + vel[2] * th[2]) / thl);
        if (Math.abs(ang) < 1.4) {
          var rate = (guided ? 1.3 : 0.6) * dt;
          var rotA = clamp(ang, -rate, rate), cr = Math.cos(rotA), sr = Math.sin(rotA), wx = vel[0], wz = vel[2];
          vel[0] = wx * cr + wz * sr; vel[2] = -wx * sr + wz * cr;
        }
      }
    }
    c.airHd = hd;
    // orientation: nose follows the trajectory, up follows the surface below (stabilised => clean landings)
    var f0 = [c.fx, c.fy, c.fz], u0 = [c.ux, c.uy, c.uz];
    var vt = norm(vel);
    var upT = smN ? smN.up.slice() : [0, 1, 0];
    var fT = vt;
    if (smN && near.height < 12) {
      var tPlane = norm(madd(vt, upT, -dot(vt, upT)));
      fT = norm(V.lerp3(vt, tPlane, clamp01(1 - near.height / 12)));
    }
    var kr = 1 - Math.exp(-dt * 5.5);
    var f1 = norm(V.lerp3(f0, fT, kr));
    var u1 = ortho(V.lerp3(u0, upT, 1 - Math.exp(-dt * 4)), f1);
    c.fx = f1[0]; c.fy = f1[1]; c.fz = f1[2]; c.ux = u1[0]; c.uy = u1[1]; c.uz = u1[2];
    // move
    c.px += vel[0] * dt; c.py += vel[1] * dt; c.pz += vel[2] * dt;
    c.vx = vel[0]; c.vy = vel[1]; c.vz = vel[2];
    c.v = len(vel);
    // landing — swept: the segment from the previous to the new position crossed a road surface from above (the previous
    // point is measured against the SAME surface plane, so no speed / frame rate can tunnel through a deck), or the car
    // slid in from beside the road just under the surface level (landing half over the edge)
    var npos = [c.px, c.py, c.pz];
    var pr = tr.project(npos, { hintS: c.airS, window: 320, surfaceOnly: true, maxDist: 14, lateralMargin: LAND_MARGIN });
    if (pr) {
      var sm = tr.sample(pr.s);
      var dS = wrapD(pr.s - c.takeoffS, L);
      var vn = dot(vel, sm.up);
      var hPrev = dot(sub(pos, sm.pos), sm.up);
      var crossed = pr.height <= 0.02 && hPrev >= -0.08;
      // came in from beside the road (or from over a gap, onto the landing lip) just under the surface level: pop up onto
      // it — an arcade "lip save" instead of clipping into the deck and falling through
      var nearLip = false;
      for (var gi = 0; gi < tr.gaps.length; gi++) { var gL = wrapD(pr.s - tr.gaps[gi].landS, L); if (gL > -1 && gL < 5) { nearLip = true; break; } }
      var tol = nearLip ? -1.8 : -0.9;
      var slidIn = pr.height <= 0.02 && pr.height > tol && (c.prevH === 1 || (c.prevH <= 0.02 && c.prevH > tol));
      if (((crossed && vn < 0.5) || slidIn) && c.airT > 0.06 && dS > -90 && dS < 420) return land(c, ctx, pr, sm, vel, dS);
      c.prevH = pr.height;
    } else c.prevH = 1;
    // below the ground plane — unless a road surface is right there (low bowl edges sit near the ground plane)
    if (c.py < tr.groundY + 0.4 && !(pr && pr.height > -0.5)) { c.falls++; emit(c, 'fall', { s: c.airS }); return startRespawn(c, ctx, 'fall'); }
    if (c.airT > AIR_MAX) { c.falls++; return startRespawn(c, ctx, 'lost'); }
    return c;
  }

  function land(c, ctx, pr, sm, vel, dS) {
    var vn = -dot(vel, sm.up);
    var vp = madd(vel, sm.up, vn);
    var ft = dot(vp, sm.tangent), fl = dot(vp, sm.left), sp = Math.sqrt(ft * ft + fl * fl);
    var psi, v;
    if (ft >= 0) { psi = Math.atan2(fl, ft); v = sp; }
    else { psi = Math.atan2(-fl, -ft); v = -sp; }
    // the nose decides where we roll: if it points along the track keep going forward
    var noseT = c.fx * sm.tangent[0] + c.fy * sm.tangent[1] + c.fz * sm.tangent[2];
    if (noseT > 0.2 && v < 0) { v = -v * 0.5; psi = 0; }
    psi = clamp(psi, -0.9, 0.9);
    if (helpOf(c, ctx) !== 'off') psi *= 0.5;
    c.mode = 'ground';
    c.s = pr.s; c.lat = clamp(pr.lateral, -(sm.halfWidth - HALF_W), sm.halfWidth - HALF_W);
    c.psi = psi;
    c.v = v * (1 - clamp(vn * 0.003, 0, 0.08));
    c.dist = num(c.takeoffDist, c.dist) + dS;
    c.suspV -= clamp(vn * 0.11, 0, 2.6);
    var air = c.airT;
    c.lastAir = air; c.airTotal += air; c.landings++; if (air > c.bestAir) c.bestAir = air;
    emit(c, 'land', { s: c.s, impact: vn, air: air, speed: c.v, assisted: c.assisted });
    c.assisted = false; c.airT = 0; c.airHd = null;
    if (air > 0.25) c.fallStreak = 0;
    return c;
  }

  function startRespawn(c, ctx, why) {
    if (why === 'fall' || why === 'lost') c.fallStreak = (c.fallStreak | 0) + 1;
    c._air = c.mode === 'air';
    c.mode = 'respawn';
    c.respawnT = 0;
    c.respawnWhy = why;
    emit(c, 'respawnStart', { why: why });
    return c;
  }
  function respawnStep(c, ctx) {
    var dt = ctx.dt;
    c.respawnT += dt;
    if (c._air) {   // keep falling while fading out
      c.vy -= G_AIR * dt; c.px += c.vx * dt; c.py += c.vy * dt; c.pz += c.vz * dt;
      if (c.py < ctx.track.groundY + 0.4) { c.py = ctx.track.groundY + 0.4; c.vx *= 0.5; c.vy = 0; c.vz *= 0.5; }
    } else c.v *= Math.max(0, 1 - dt * 3);
    c.fade = c.respawnT < RESPAWN_SWAP ? clamp01(c.respawnT / RESPAWN_SWAP) : clamp01(1 - (c.respawnT - RESPAWN_SWAP) / (RESPAWN_T - RESPAWN_SWAP));
    if (!c._swapped && c.respawnT >= RESPAWN_SWAP) {
      c._swapped = true;
      var rp = (ctx.respawnPoint && ctx.respawnPoint(c)) || { s: c.s, dist: c.dist };
      c._air = false;
      c.s = wrapS(rp.s, ctx.track.length); c.dist = num(rp.dist, c.dist); c.lat = num(rp.lat, 0); c.psi = 0;
      c.v = num(rp.speed, 16); c.airT = 0; c.stuckT = 0; c.wrongT = 0; c.spinT = 0;
      c.ghostT = 1.6;
      emit(c, 'respawn', { s: c.s, why: c.respawnWhy });
    }
    if (c.respawnT >= RESPAWN_T) { c.mode = 'ground'; c._swapped = false; c.fade = 0; c.respawnT = 0; }
    return c;
  }

  /** Apply a speed boost (pads / items / nitro): top speed multiplier for `secs` plus a push acceleration. */
  function boost(c, secs, top, accel) {
    c.boostT = Math.max(c.boostT, num(secs, 1));
    c.boostTop = Math.max(c.boostT > 0 ? c.boostTop : 1, num(top, 1.25));
    c.boostAccel = Math.max(c.boostAccel, num(accel, 14));
  }
  function spinOut(c, secs) { c.spinT = Math.max(c.spinT, num(secs, 1)); c.spinDur = Math.max(0.3, c.spinT); c.v *= 0.7; }

  S.physics = {
    G_AIR: G_AIR, SLOPE_K: SLOPE_K, MAG_BASE: MAG_BASE, MAG_STUNT: MAG_STUNT, V_ADHERE: V_ADHERE, LAT_G: LAT_G, HALF_W: HALF_W,
    RESPAWN_T: RESPAWN_T, RESPAWN_SWAP: RESPAWN_SWAP, LAND_MARGIN: LAND_MARGIN, GAP_FLAT: GAP_FLAT, MERCY_FALLS: MERCY_FALLS, CREST_VY: CREST_VY,
    FALLBACK: FALLBACK, resolveDrive: resolveDrive, vehicleAdapter: vehicleAdapter, responseAdapter: responseAdapter, STUNT_VMAX: STUNT_VMAX, perfOf: perfOf,
    createCar: createCar, step: step, pose: pose, boost: boost, spinOut: spinOut, startRespawn: startRespawn,
    latMaxAt: latMaxAt, cornerSpeed: cornerSpeed, stuntNeed: stuntNeed, helpOf: helpOf, HELP_LEVELS: ['player', 'guided', 'ai', 'off']
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = S.physics;
})(CB.arcade.stunt);

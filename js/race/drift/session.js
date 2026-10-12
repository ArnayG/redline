/* ==========================================================================
   FORGE Atelier — js/race/drift/session.js
   CB.race.drift.createSession : drift (and assisted race) sessions wrapping CB.race.engine.

   Pure logic (no DOM). Classic <script> in browsers, require()-able in Node.

   createSession(cfg) -> session
     cfg: { trackId | track (def), mode 'free'|'trial'|'tandem'|'race' (default 'free'),
            build | playerBuild, assist | assistLevel 'off'|'light'|'medium'|'heavy' (default 'heavy'),
            tune | tuneLevel 'grip'|'street'|'pro'|'competition' (default 'street'; 'race' mode is never tuned),
            timeOfDay, weather, duration_s (trial 90, tandem 120, free 0 = endless), startDelay_s (trial/tandem 3),
            seed, difficulty, laps / opponents / field / startPosition (race mode), engine (inject a CB.race.engine),
            engineCfg (extra fields merged into the engine cfg), leadBuild (tandem lead car build), storage }

     DRIFT modes ('free' / 'trial' / 'tandem') run an engine *practice* session (no AI; tandem = one AI lead car that
     starts ahead of the player and is driven by CB.race.drift.ai when present). RACE mode runs a normal engine race
     with an AI field; the player gets CB.race.assist in 'race' mode and no drift tune / scorer.

   Session surface (same as engine sessions, plus drift extras):
     update(dt, rawInput) -> substeps        rawInput = keyboard intent {left,right,up,down,handbrake,shiftUp,shiftDown,
                                             steerAxis?,throttleAxis?,brakeAxis?} OR an engine input {throttle,brake,steer}
     snapshot()                              engine snapshot + snap.drift = { mode, scorer, assist, elapsed_s, timeLeft_s,
                                             countdown_s, finished, tandem: {leadId, gap_m, dist_m, ahead}, assistLevel, tuneLevel }
     results()                               engine results + { drift: scorer.results(), driftMode, assistLevel, tuneLevel, tandem }
     restart(), resetPlayerToTrack(), end(), scorerState(), assistDebug(), playerState(),
     setAssistLevel(level), setTuneLevel(level) (re-applied on next restart), setPlayerAutopilot(bool),
     time(), getPhase(), elapsed(), simulate(seconds, rawInput), geom, trackDef, config, engine (inner session)

   Hookup (via the engine's cfg.hooks contract, see js/race/engine.js):
     carCreated  -> tune.apply(car.params) for the player (and the tandem lead)
     preStep     -> player: assist.filter(rawIntent, playerState, ctx) replaces the input (unless autopilot / frozen);
                    countdown hold; tandem lead: drift AI control + soft leash
     postStep    -> scorer.update(car, STEP, events) for the player every substep
     onImpact    -> wall / contact events queued for the scorer

   Every collaborator is optional: missing CB.race.assist / drift.tune / drift.scoring / drift.ai fall back to small
   built-in versions (simple assist, identity tune, CB.game.challenges.createDriftScorer adapter or a tiny scorer).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};
CB.race.drift = CB.race.drift || {};

(function () {
  'use strict';

  var STEP = 1 / 120;
  var DEG = Math.PI / 180;
  var KPH = 3.6;
  var ASSIST_LEVELS = ['off', 'light', 'medium', 'heavy', 'auto'];
  var TUNE_LEVELS = ['grip', 'street', 'pro', 'competition'];
  var MODES = ['free', 'trial', 'tandem', 'race'];
  var LEAD_AI_OPTS = {};                 // extra CB.race.drift.ai options for the tandem lead (cfg.leadAi overrides)
  var LEAD_PACE_MAX = 1.3;
  var TANDEM_FOLLOW_M = 16;            // tandem heavy/auto: anti-ram speed cap inside this gap (m)
  var TANDEM_HOLD_M = 7.5;             // tandem heavy/auto: closing speed falls to 0 at this centre gap when the cars overlap sideways
  var TANDEM_HOLD_SIDE_M = 5;          //   ... and at this gap when the player runs a clear lane beside the lead's line
  var TANDEM_TOUCH_MAX = 9;            // tandem heavy/auto: contact with the lead below this speed (m/s) banks instead of wiping the drift
  var TANDEM_TOUCH_SOFT = 1.5;         //   ... and below this speed it is just a rub (ignored)
  var DEFAULT_DURATION = { free: 0, trial: 90, tandem: 120, race: 0 };
  var DEFAULT_DELAY = { free: 0, trial: 3, tandem: 3, race: 0 };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  function wrapAngle(a) { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; }
  function assign(t) { for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k]; } return t; }
  function pick(list, v, d) { return list.indexOf(v) >= 0 ? v : d; }
  function R() { return CB.race || {}; }
  function D() { return CB.race.drift || {}; }

  /* ======================================================================
     Input normalisation
     ====================================================================== */

  /** Accepts keyboard intent or an engine-style input and returns a complete intent object. */
  function toIntent(raw) {
    raw = raw || {};
    var digital = 'left' in raw || 'right' in raw || 'up' in raw || 'down' in raw;
    var it = {
      left: !!raw.left, right: !!raw.right, up: !!raw.up, down: !!raw.down, handbrake: !!raw.handbrake,
      shiftUp: !!raw.shiftUp, shiftDown: !!raw.shiftDown, requestReset: !!raw.requestReset
    };
    if (isNum(raw.steerAxis)) it.steerAxis = clamp(raw.steerAxis, -1, 1);
    if (raw.steerAnalog && isNum(raw.steerAxis)) it.steerAnalog = true;      // phone wheel / tilt: proportional steer
    if (isNum(raw.throttleAxis)) it.throttleAxis = clamp01(raw.throttleAxis);
    if (isNum(raw.brakeAxis)) it.brakeAxis = clamp01(raw.brakeAxis);
    if (!digital) {
      // engine-style {throttle, brake, steer}: present it as analog intent
      if (isNum(raw.steer) && it.steerAxis === undefined) it.steerAxis = clamp(raw.steer, -1, 1);
      if (isNum(raw.throttle) && it.throttleAxis === undefined) it.throttleAxis = clamp01(raw.throttle);
      if (isNum(raw.brake) && it.brakeAxis === undefined) it.brakeAxis = clamp01(raw.brake);
      it.up = num(it.throttleAxis, 0) > 0.5; it.down = num(it.brakeAxis, 0) > 0.5;
      it.left = num(it.steerAxis, 0) > 0.5; it.right = num(it.steerAxis, 0) < -0.5;
    }
    return it;
  }
  /** Direct (unassisted) mapping intent -> engine input. +steer = left. */
  function directInput(it) {
    var steer = isNum(it.steerAxis) && Math.abs(it.steerAxis) > 0.02 ? it.steerAxis : (it.left ? 1 : 0) - (it.right ? 1 : 0);
    return {
      throttle: isNum(it.throttleAxis) && it.throttleAxis > 0 ? it.throttleAxis : (it.up ? 1 : 0),
      brake: isNum(it.brakeAxis) && it.brakeAxis > 0 ? it.brakeAxis : (it.down ? 1 : 0),
      steer: clamp(steer, -1, 1), handbrake: !!it.handbrake, shiftUp: !!it.shiftUp, shiftDown: !!it.shiftDown
    };
  }
  function cleanOut(o, fb) {
    o = o && typeof o === 'object' ? o : fb;
    return {
      throttle: clamp01(num(+o.throttle, 0)), brake: clamp01(num(+o.brake, 0)), steer: clamp(num(+o.steer, 0), -1, 1),
      handbrake: !!o.handbrake, shiftUp: !!o.shiftUp, shiftDown: !!o.shiftDown, slideRack: !!o.slideRack
    };
  }

  /* ======================================================================
     Vehicle state for the assist / scorer (spec §1 "car")
     ====================================================================== */

  /** From the engine's internal car object (reachable through hooks). */
  function stateFromInternal(car) {
    var st = car.state || {}, p = car.params || {};
    var vx = num(st.vx, 0), vy = num(st.vy, 0);
    var speed = Math.abs(num(st.speed, Math.hypot(vx, vy)));
    var beta = speed > 0.5 && Math.abs(vx) > 0.05 ? Math.atan2(vy, Math.abs(vx)) : 0;
    return {
      x: num(st.x, 0), y: num(st.y, 0), heading: num(st.heading, 0), speed: speed, vxLocal: vx, vyLocal: vy,
      vx: num(car.wvx, 0), vy: num(car.wvy, 0), yawRate: num(st.yawRate, 0), steerAngle: num(st.steerAngle, 0),
      slipAngleF: num(st.slipAngleF, 0), slipAngleR: num(st.slipAngleR, 0), rpm: num(st.rpm, 0), gear: num(st.gear, 1),
      maxGear: num(st.maxGear, num(car.maxGear, 6)), redline: num(car.redline, num(p.redline, 7000)),
      maxSteer_rad: num(p.maxSteer, num(p.lockAngle, 0.6)), beta: beta, angle_deg: Math.abs(beta) / DEG,
      throttle: num(st.throttle, num(car.input && car.input.throttle, 0)), brake: num(st.brake, 0),
      s: num(car.lapS, 0), lateral: num(car.lateral, 0), onTrack: car.onTrack !== false, surface: car.surface || 'asphalt',
      offTrack: !!car.offTrack, wrongWay: !!car.wrongWay, lap: car.tracker ? car.tracker.lap : 0, id: car.id, isPlayer: !!car.isPlayer,
      length_m: num(car.length_m, 4.5), width_m: num(car.width_m, 1.9)
    };
  }
  /** From a snapshot car (fallback when the engine internals are unreachable). */
  function stateFromSnap(sc, prev, dt) {
    if (!sc) return null;
    var h = num(sc.heading, 0), c = Math.cos(h), s = Math.sin(h);
    var wvx = num(sc.vx, 0), wvy = num(sc.vy, 0);
    var vxL = c * wvx + s * wvy, vyL = -s * wvx + c * wvy;
    var speed = Math.abs(num(sc.speed, Math.hypot(wvx, wvy)));
    var beta = speed > 0.5 && Math.abs(vxL) > 0.05 ? Math.atan2(vyL, Math.abs(vxL)) : 0;
    var yaw = prev && dt > 0 ? wrapAngle(h - prev.heading) / dt : 0;
    return {
      x: sc.x, y: sc.y, heading: h, speed: speed, vxLocal: vxL, vyLocal: vyL, vx: wvx, vy: wvy, yawRate: yaw,
      steerAngle: num(sc.steerAngle, 0), slipAngleF: num(sc.slipF, 0), slipAngleR: num(sc.slipR, 0), rpm: num(sc.rpm, 0),
      gear: num(sc.gear, 1), maxGear: num(sc.maxGear, 6), redline: num(sc.redline, 7000), maxSteer_rad: 0.6, beta: beta,
      angle_deg: Math.abs(beta) / DEG, throttle: num(sc.throttle, 0), brake: num(sc.brake, 0), s: num(sc.s, 0),
      lateral: num(sc.lateral, 0), onTrack: sc.onTrack !== false, surface: sc.surface || 'asphalt', offTrack: !!sc.offTrack,
      wrongWay: !!sc.wrongWay, lap: num(sc.lap, 0), id: sc.id, isPlayer: !!sc.isPlayer
    };
  }

  /* ======================================================================
     Fallback assist (used only when CB.race.assist is missing / throws)
     ====================================================================== */
  var LEVEL_K = { off: 0, light: 0.35, medium: 0.65, heavy: 1, auto: 1 };
  function createFallbackAssist(opts) {
    opts = opts || {};
    var level = pick(ASSIST_LEVELS, opts.level, 'heavy'), mode = opts.mode === 'race' ? 'race' : 'drift';
    var sm = 0, flick = 0, dbg = { target: 0, beta: 0, counter: 0, level: level, fallback: true };
    return {
      fallback: true,
      setLevel: function (l) { level = pick(ASSIST_LEVELS, l, level); dbg.level = level; },
      debug: function () { return assign({}, dbg); },
      reset: function () { sm = 0; flick = 0; },
      filter: function (raw, car, ctx) {
        var it = toIntent(raw), dt = num(ctx && ctx.dt, STEP), k = LEVEL_K[level];
        var out = directInput(it);
        if (!k || !car) { sm = out.steer; return out; }
        var v = num(car.speed, 0), vx = num(car.vxLocal, v), maxS = Math.max(0.2, num(car.maxSteer_rad, 0.6));
        var beta = v > 3 && vx > 0.5 ? Math.atan2(num(car.vyLocal, 0), vx) : 0;
        var yaw = num(car.yawRate, 0), intent = out.steer;
        var lock = mode === 'race' ? Math.max(0.25, 1 / (1 + Math.pow(v / 26, 2) * 1.1 * k)) : Math.max(0.45, 1 / (1 + Math.pow(v / 40, 2) * 0.6 * k));
        var target = intent * lock, counter = 0;
        if (v > 4) {
          // counter-steer: point the front wheels along the velocity (beta > 0 = velocity left of the nose -> steer left)
          var auto = clamp(beta / maxS, -1, 1);
          var share = (mode === 'drift' ? 0.85 : 0.6) * k;
          counter = auto * share;
          target = counter + intent * lock * (1 - 0.35 * k * Math.min(1, Math.abs(auto) * 2));
          // yaw stabilisation: damp rotation beyond a speed-dependent band unless the player asks for it
          var band = mode === 'drift' ? 1.9 : 1.2;
          var excess = Math.abs(yaw) - band;
          if (excess > 0 && sign(intent) !== sign(yaw)) target -= sign(yaw) * clamp(excess * 0.35 * k, 0, 0.6);
          if (Math.abs(beta) > 0.9 && k > 0.4) out.throttle *= 0.35;           // catching a spin: lift
        }
        // race extras: off-track recovery toward the tarmac
        if (mode === 'race' && ctx && ctx.proj && ctx.proj.onTrack === false && !intent && v > 3) target += -sign(num(ctx.proj.lateral, 0)) * 0.25 * k;
        // drift initiation helper: a short handbrake flick when turning in with throttle above ~40 km/h
        if (mode === 'drift' && k >= 0.5 && intent && out.throttle > 0.5 && v * KPH > 40 && Math.abs(beta) < 0.12 && flick <= 0) flick = 0.18;
        if (flick > 0) { flick -= dt; out.handbrake = out.handbrake || flick > 0.04; }
        target = clamp(target, -1, 1);
        var rIn = 2.4 + 3.2 * k, rOut = 4.5 + 4 * k;
        var rate = Math.abs(target) < Math.abs(sm) || sign(target) !== sign(sm) ? rOut : rIn;
        sm += clamp(target - sm, -rate * dt, rate * dt);
        out.steer = clamp(sm, -1, 1);
        dbg = { target: target, beta: beta, beta_deg: beta / DEG, counter: counter, level: level, fallback: true };
        return out;
      }
    };
  }
  function makeAssist(level, mode) {
    var A = R().assist;
    if (A && typeof A.create === 'function') {
      try { var a = A.create({ level: level, mode: mode }); if (a && typeof a.filter === 'function') return a; } catch (e) { /* fall back */ }
    }
    return createFallbackAssist({ level: level, mode: mode });
  }

  /** The arcade "drift lock" (js/race/drift/arcade.js) drives heavy / auto assist in the drift modes. */
  function arcadeApplies(level, isRace) {
    var A = D().arcade;
    if (!A || typeof A.create !== 'function') return false;
    if (typeof A.appliesTo === 'function') { try { return !!A.appliesTo(level, isRace ? 'race' : 'drift'); } catch (e) { return false; } }
    return !isRace && (level === 'heavy' || level === 'auto');
  }
  function makeArcade(level, geom, params) {
    try { var a = D().arcade.create({ level: level, geom: geom, params: params }); return a && typeof a.control === 'function' ? a : null; } catch (e) { return null; }
  }

  /* ======================================================================
     Fallback scorer (adapter around CB.game.challenges.createDriftScorer, else tiny built-in)
     ====================================================================== */
  var GRADES = [[0, 'C'], [1500, 'B'], [4000, 'A'], [9000, 'S'], [20000, 'SS']];
  function gradeOf(p) { var g = 'C'; for (var i = 0; i < GRADES.length; i++) if (p >= GRADES[i][0]) g = GRADES[i][1]; return g; }
  function medalOf(total, targets) {
    var m = null;
    ['bronze', 'silver', 'gold', 'platinum'].forEach(function (k) { if (targets && total >= targets[k]) m = k; });
    return m;
  }
  function fallbackTargets(trackDef, duration) {
    var sc = Math.max(0.5, (duration || 90) / 90);
    var t = trackDef && trackDef.driftTargets;
    if (t && isNum(t.gold)) return t;
    return { bronze: Math.round(8000 * sc), silver: Math.round(20000 * sc), gold: Math.round(40000 * sc), platinum: Math.round(70000 * sc) };
  }
  function createFallbackScorer(geom, trackDef, opts) {
    opts = opts || {};
    var CH = CB.game && CB.game.challenges;
    var targets = fallbackTargets(trackDef, opts.duration_s);
    var inner = null;
    if (CH && typeof CH.createDriftScorer === 'function') { try { inner = CH.createDriftScorer({}); } catch (e) { inner = null; } }
    var lastEvent = null, t = 0, popSeen = 0;
    if (inner) {
      return {
        fallback: true, targets: targets,
        update: function (car, dt, events) {
          t += dt;
          var crash = null;
          (events || []).forEach(function (e) { if (e && (e.type === 'wall' || e.type === 'collision') && num(e.speed, 3) > 2.5) crash = e.type === 'wall' ? 'Wall' : 'Contact'; if (e && e.type === 'reset') crash = 'Reset'; });
          var S = inner.update(car, dt, { crash: crash, offTrack: car && car.onTrack === false, wallDist_m: car && car.wallDist });
          var pops = S.popups || [];
          if (pops.length) {
            var p = pops[pops.length - 1];
            if (p.t !== popSeen) { popSeen = p.t; lastEvent = { text: p.text, points: p.value || 0, t: t }; }
          }
          return S;
        },
        state: function () {
          var S = inner.state;
          return {
            total: Math.round(inner.total()), banked: S.score, current: S.chainPoints, combo: S.chains, multiplier: S.multiplier,
            meter: S.meter, drifting: S.drifting, angle_deg: S.angle_deg, speed: 0, grade: S.chainPoints > 0 ? gradeOf(S.chainPoints) : (S.lastBank ? gradeOf(S.lastBank.points) : null),
            zones: [], lastEvent: lastEvent, popups: S.popups, targets: targets, fallback: 'challenges'
          };
        },
        results: function () {
          var S = inner.state, total = Math.round(inner.total());
          return {
            total: total, bestDrift: S.bestChain, longestDrift_s: S.longestDrift_s, maxAngle_deg: S.maxAngle_deg, maxCombo: S.bestCombo,
            zonesHitPct: 0, medal: medalOf(total, targets), targets: targets, drifts: S.chains, crashes: S.crashes
          };
        },
        finish: function () { inner.finish(); },
        reset: function () { inner.reset(); lastEvent = null; t = 0; popSeen = 0; }
      };
    }
    // tiny built-in scorer
    var S0;
    function reset() { S0 = { total: 0, current: 0, multiplier: 1, held: 0, idle: 0, best: 0, longest: 0, dur: 0, maxAngle: 0, maxMult: 1, drifts: 0 }; lastEvent = null; }
    reset();
    function bank() {
      if (S0.current > 0) {
        var p = Math.round(S0.current); S0.total += p; S0.drifts++; if (p > S0.best) S0.best = p;
        lastEvent = { text: gradeOf(p) + ' DRIFT', points: p, t: t };
      }
      S0.current = 0; S0.dur = 0;
    }
    return {
      fallback: true, targets: targets,
      update: function (car, dt, events) {
        t += dt;
        var hit = (events || []).some(function (e) { return e && (e.type === 'wall' || e.type === 'reset'); });
        if (hit) { if (S0.current > 0) lastEvent = { text: 'COMBO LOST', points: -Math.round(S0.current), t: t }; S0.current = 0; S0.multiplier = 1; S0.held = 0; S0.dur = 0; return; }
        var a = num(car && car.angle_deg, 0), v = num(car && car.speed, 0);
        if (a > 110 && v > 3) { S0.current = 0; S0.multiplier = 1; S0.dur = 0; lastEvent = { text: 'SPIN', points: 0, t: t }; return; }
        if (a >= 15 && a <= 90 && v * KPH > 25) {
          var af = a < 30 ? (a - 15) / 15 * 0.7 + 0.3 : a <= 50 ? 1 : Math.max(0.3, 1 - (a - 50) / 40);
          S0.current += 60 * af * (v / 20) * S0.multiplier * dt * (car.onTrack === false ? 0.5 : 1);
          S0.held += dt; S0.dur += dt; S0.idle = 0;
          if (S0.held >= 2) { S0.held = 0; S0.multiplier = Math.min(5, S0.multiplier + 0.1); }
          if (a > S0.maxAngle) S0.maxAngle = a;
          if (S0.dur > S0.longest) S0.longest = S0.dur;
          if (S0.multiplier > S0.maxMult) S0.maxMult = S0.multiplier;
        } else {
          S0.idle += dt;
          if (S0.idle > 0.6) bank();
          if (S0.idle > 1.5) S0.multiplier = Math.max(1, S0.multiplier - dt);
        }
      },
      state: function () {
        return { total: Math.round(S0.total + S0.current), banked: S0.total, current: Math.round(S0.current), combo: S0.drifts, multiplier: Math.round(S0.multiplier * 10) / 10,
                 angle_deg: S0.maxAngle, speed: 0, grade: S0.current > 0 ? gradeOf(S0.current) : null, zones: [], lastEvent: lastEvent, targets: targets, fallback: 'builtin' };
      },
      results: function () {
        var total = Math.round(S0.total + S0.current);
        return { total: total, bestDrift: S0.best, longestDrift_s: S0.longest, maxAngle_deg: S0.maxAngle, maxCombo: S0.maxMult, zonesHitPct: 0, medal: medalOf(total, targets), targets: targets, drifts: S0.drifts };
      },
      finish: bank, reset: reset
    };
  }
  function makeScorer(geom, trackDef, opts) {
    var SC = D().scoring;
    if (SC && typeof SC.createScorer === 'function') {
      try {
        var s = SC.createScorer(geom, trackDef, opts);
        if (s && typeof s.update === 'function' && typeof s.state === 'function') return s;
      } catch (e) { /* fall back */ }
    }
    return createFallbackScorer(geom, trackDef, opts);
  }

  /* ======================================================================
     Tune + drift preset
     ====================================================================== */
  function tuneParams(params, level, build) {
    var T = D().tune;
    if (!T || typeof T.apply !== 'function' || !params) return params;
    try { var p = T.apply(params, { level: level, build: build }); return p && typeof p === 'object' ? p : params; } catch (e) { return params; }
  }
  /** A RWD drift car: the 'muscle' preset (supercharged V8, LSD) + the tune's recommended drift setup. */
  function driftPresetBuild() {
    var data = CB.data, b = null;
    if (data && typeof data.presetBuild === 'function') {
      ['muscle', 'track-weapon', 'hot-hatch'].some(function (id) { try { b = data.presetBuild(id) || null; } catch (e) { b = null; } return !!b; });
    }
    if (!b && data && typeof data.defaultBuild === 'function') { try { b = data.defaultBuild(); } catch (e) { b = null; } }
    if (!b) return null;
    var T = D().tune;
    if (T && typeof T.recommendedBuildPatch === 'function') {
      try {
        var patch = T.recommendedBuildPatch(b);
        if (patch && typeof patch === 'object') b = CB.util && CB.util.deepMerge ? CB.util.deepMerge(b, patch) : deepMergeLite(b, patch);
      } catch (e) { /* keep */ }
    }
    if (CB.state && typeof CB.state.normalize === 'function') { try { b = CB.state.normalize(b) || b; } catch (e) { /* keep */ } }
    return b;
  }
  function deepMergeLite(a, b) {
    var out = Array.isArray(a) ? a.slice() : assign({}, a);
    Object.keys(b || {}).forEach(function (k) {
      var v = b[k];
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? deepMergeLite(out[k], v) : v;
    });
    return out;
  }

  /* ======================================================================
     Track helpers
     ====================================================================== */
  function isDriftTrack(def) {
    if (!def) return false;
    var tags = def.tags || [];
    return !!(def.driftZones || (def.style && def.style.drift) || def.drift || tags.indexOf('drift') >= 0);
  }
  function trackList() {
    var T = R().tracks, l = T && T.list;
    if (typeof l === 'function') { try { l = l(); } catch (e) { l = null; } }
    return Array.isArray(l) ? l.slice() : [];
  }
  /** Tracks ordered for a mode: drift-focused tracks first in drift mode (stable otherwise). */
  function tracksFor(mode) {
    var l = trackList();
    if (mode === 'race') return l;
    return l.filter(isDriftTrack).concat(l.filter(function (t) { return !isDriftTrack(t); }));
  }

  /* ======================================================================
     Session
     ====================================================================== */
  function createSession(cfgIn) {
    var cfg = assign({}, cfgIn || {});
    var E = cfg.engine || R().engine;
    if (!E || typeof E.createSession !== 'function') throw new Error('CB.race.drift.createSession: CB.race.engine is not loaded');
    var mode = pick(MODES, cfg.mode, 'free');
    var isRace = mode === 'race';
    var assistLevel = pick(ASSIST_LEVELS, cfg.assist || cfg.assistLevel, 'heavy');
    var tuneLevel = pick(TUNE_LEVELS, cfg.tune || cfg.tuneLevel, 'street');
    var duration = Math.max(0, num(cfg.duration_s, DEFAULT_DURATION[mode]));
    var startDelay = Math.max(0, num(cfg.startDelay_s, DEFAULT_DELAY[mode]));
    var build = cfg.build || cfg.playerBuild || null;
    if (!build && !isRace) build = driftPresetBuild();
    var leadBuild = cfg.leadBuild || null;
    if (mode === 'tandem' && !leadBuild) leadBuild = driftPresetBuild() || build;

    // run state (rebuilt by restart)
    var assist = null, scorer = null, rawIntent = toIntent(null), pendingEv = [], lastPState = null;
    var finished = false, finishedAt = null, leadDriver = null, leadDriverTried = false, leadPace = 1, leadCar = null, playerCar = null;
    var lastResets = 0, tandemStats = null, hookErrors = 0, inner = null;
    var fallbackPrev = null, pendingSnapEvents = [], stuckT = 0, wantReset = false, autoResets = 0;
    var arcade = null, arcadeErrors = 0, pendingTouch = 0, touchCool = -99;

    function resetRun() {
      assist = makeAssist(assistLevel, isRace ? 'race' : 'drift');
      arcade = null;                                         // (re)built lazily once the geometry + player params exist
      scorer = isRace ? null : makeScorer(null, null, null);   // replaced once the geometry is known (below)
      rawIntent = toIntent(null); pendingEv = []; lastPState = null; finished = false; finishedAt = null;
      leadDriver = null; leadDriverTried = false; leadPace = 1; leadCar = null; playerCar = null; lastResets = 0; fallbackPrev = null;
      stuckT = 0; wantReset = false; autoResets = 0; pendingTouch = 0; touchCool = -99;
      tandemStats = { samples: 0, sumGap: 0, close_s: 0, minGap: Infinity, lastGap: null, lastDist: null, ahead: false, touches: 0, touchBanks: 0 };
    }
    function elapsed() { return inner ? Math.max(0, inner.time() - startDelay) : 0; }
    function inCountdown() { return inner ? inner.time() < startDelay : startDelay > 0; }

    function playerCtx(car) {
      var geom = inner ? inner.geom : null, T = R().tracks, proj = null;
      if (geom && T && typeof T.project === 'function' && geom.samples) {
        try { proj = T.project(geom, car.state.x, car.state.y, car._dHint); if (proj) car._dHint = proj.index; } catch (e) { proj = null; }
      }
      if (!proj) proj = { index: car.proj ? car.proj.index : 0, s: car.lapS, lateral: car.lateral, onTrack: car.onTrack !== false, surface: car.surface };
      return { dt: STEP, geom: geom, proj: proj, params: car.params, mode: isRace ? 'race' : 'drift', t: car.ctx ? car.ctx.t : 0, track: inner ? inner.trackDef : null,
               phase: car.ctx ? car.ctx.phase : null, race: car.ctx || null };
    }
    /** Arcade drift lock for the player (heavy / auto in drift modes), created lazily. */
    function arcadeFor(car) {
      if (arcadeErrors > 3 || !arcadeApplies(assistLevel, isRace)) return null;
      if (!arcade && inner && inner.geom) arcade = makeArcade(assistLevel, inner.geom, car && car.params);
      else if (arcade && typeof arcade.setLevel === 'function' && arcade.level !== assistLevel) { try { arcade.setLevel(assistLevel); } catch (e) { /* ignore */ } }
      return arcade;
    }
    function holdInput(car) {
      var moving = Math.abs(num(car.state && car.state.speed, 0)) > 0.6;
      return { throttle: 0, brake: moving ? 1 : 0, steer: 0, handbrake: true, shiftUp: false, shiftDown: false };
    }

    /** Tandem chase on heavy / auto: the assist feathers the player's throttle when it is about to rear-end the lead,
        so an arrow-keys-only chase stays a close tandem instead of a bump-and-pass (lower levels: the player's job). */
    function tandemFollow(car, out) {
      var ar = arcade;
      var cap = null;
      if (mode === 'tandem' && leadCar && !leadCar.dnf && (assistLevel === 'heavy' || assistLevel === 'auto') && cfg.tandemFollow !== false) {
        var L = num(car.ctx && car.ctx.trackLength, 0);
        if (L) {
          var gap = leadCar.lapS - car.lapS;
          if (gap > L / 2) gap -= L; else if (gap < -L / 2) gap += L;
          // behind or alongside the lead: allowed closing speed falls to 0 at ~7.5 m back (two drifting cars at 40 deg
          // swing their tails ~2 m each, so a 5 m centre gap is bumper-to-tail); a clear lane beside the lead's line
          // may close to ~5 m (door to door). Alongside / ahead: drop back a little.
          if (gap > -4 && gap < TANDEM_FOLLOW_M) {
            var dLat = Math.abs(num(leadCar.lateral, 0) - num(car.lateral, 0));
            var hold = dLat > 3.2 ? TANDEM_HOLD_SIDE_M : dLat < 2.2 ? TANDEM_HOLD_M : TANDEM_HOLD_M - (dLat - 2.2) * (TANDEM_HOLD_M - TANDEM_HOLD_SIDE_M);
            cap = num(leadCar.state && leadCar.state.speed, 0) + clamp((gap - hold) * 0.6, -3, 6);
          }
        }
      }
      if (ar && typeof ar.setSpeedCap === 'function') { try { ar.setSpeedCap(cap); } catch (e) { /* ignore */ } }
      else if (cap != null && num(car.state && car.state.speed, 0) > cap) out.throttle *= 0.6;
      return out;
    }

    function tandemLeadInput(car, inp) {
      var AI = D().ai;
      if (!leadDriverTried) {
        leadDriverTried = true;
        if (AI && typeof AI.createDriftDriver === 'function') {
          try { leadDriver = AI.createDriftDriver(car.entrant || {}, inner.geom, car.params, assign({}, LEAD_AI_OPTS, cfg.leadAi || {})); } catch (e) { leadDriver = null; }
          if (leadDriver && typeof leadDriver.control !== 'function' && typeof leadDriver !== 'function') leadDriver = null;
        }
      }
      var out = inp;
      if (leadDriver && playerCar && typeof leadDriver.setPace === 'function') {
        // tandem pace: the lead pushes harder while the player is close / alongside so a fast heavy-assist chase
        // stays a chase instead of an overtake (target gap ~12 m; rate-limited so the lead's drift stays smooth)
        var Lp = num(car.ctx && car.ctx.trackLength, 0), gp = Lp ? (car.lapS - playerCar.lapS) : 0;
        if (Lp) { if (gp > Lp / 2) gp -= Lp; else if (gp < -Lp / 2) gp += Lp; }
        var want = clamp(1 + (12 - gp) * 0.02, 0.92, LEAD_PACE_MAX);
        leadPace += clamp(want - leadPace, -0.15 * STEP, 0.3 * STEP);
        try { leadDriver.setPace(leadPace); } catch (e) { /* ignore */ }
      }
      if (leadDriver) {
        try {
          var r = typeof leadDriver === 'function' ? leadDriver(car.state, car.ctx, STEP) : leadDriver.control(car.state, car.ctx, STEP);
          if (r && typeof r === 'object') out = cleanOut(r, inp);
        } catch (e) { leadDriver = null; hookErrors++; }
      }
      // soft leash: the lead waits for the player when it is far ahead (gentle so it never kills a drift)
      if (playerCar && inner) {
        var L = num(car.ctx && car.ctx.trackLength, 0);
        var gap = L ? (car.lapS - playerCar.lapS) : 0;
        if (L) { if (gap > L / 2) gap -= L; else if (gap < -L / 2) gap += L; }
        if (gap > 40) out = assign({}, out, { throttle: out.throttle * clamp(1 - (gap - 40) / 75, 0.2, 1),
                                              brake: Math.max(out.brake, gap > 130 ? 0.25 : 0) });
        else if (gap > 0 && gap < 6 && num(playerCar.state.speed, 0) < 3) out = assign({}, out, { throttle: Math.min(out.throttle, 0.25) });
      }
      return out;
    }

    var hooks = {
      carCreated: function (car) {
        if (car.isPlayer) {
          playerCar = car;
          if (!isRace) car.params = tuneParams(car.params, tuneLevel, car.build);
        } else if (mode === 'tandem' && !leadCar) {
          leadCar = car;
          car.params = tuneParams(car.params, tuneLevel === 'grip' ? 'street' : tuneLevel, car.build);
        }
      },
      preStep: function (car, inp) {
        if (car.isPlayer) {
          playerCar = car;
          if (inCountdown()) return holdInput(car);
          if (car.autopilotActive || car.dnf || finished) return inp;
          if (car.ctx && car.frozenUntil > car.ctx.t) return inp;            // engine reset hold
          var ph = car.ctx && car.ctx.phase;
          if (isRace && (ph === 'grid' || ph === 'countdown')) {
            // heavier assist levels protect against jump starts; light/off leave the clutch to the player
            return assistLevel === 'heavy' || assistLevel === 'medium' ? holdInput(car) : inp;
          }
          var ps = stateFromInternal(car);
          lastPState = ps;
          var it = assign({}, rawIntent, { shiftUp: !!inp.shiftUp, shiftDown: !!inp.shiftDown });
          var out = null, ar = arcadeFor(car);
          if (ar) {
            try { out = ar.control(it, car, STEP); } catch (e) { arcadeErrors++; hookErrors++; out = null; arcade = null; }
            if (out) return tandemFollow(car, cleanOut(out, inp));
          }
          try { out = assist.filter(it, ps, playerCtx(car)); } catch (e) { hookErrors++; out = null; }
          if (!out) {
            if (!assist.fallback) assist = createFallbackAssist({ level: assistLevel, mode: isRace ? 'race' : 'drift' });
            try { out = assist.filter(it, ps, playerCtx(car)); } catch (e2) { out = directInput(it); }
          }
          return cleanOut(out, inp);
        }
        if (car === leadCar) {
          if (inCountdown()) return holdInput(car);
          if (car.ctx && car.frozenUntil > car.ctx.t) return inp;
          return tandemLeadInput(car, inp);
        }
        return inp;
      },
      onImpact: function (car, jn, dir, opts) {
        if (!car.isPlayer) return;
        opts = opts || {};
        var spd = num(opts.speed, num(jn, 0) / Math.max(1, num(car.mass, 1400)));
        if (!opts.wall && tandemForgiving() && leadCar && opts.otherId === leadCar.id && spd < TANDEM_TOUCH_MAX) {
          // tandem on heavy / auto: a touch with the lead (it slides across the chase line now and then) banks the
          // open drift instead of wiping a whole-run arcade drift; a light rub is ignored
          pendingTouch = Math.max(pendingTouch, spd);
          return;
        }
        pendingEv.push({ type: opts.wall ? 'wall' : 'collision', carId: car.id, intensity: clamp01(spd / 18), value: spd, speed: spd,
                         impulse: jn, dir: dir, other: opts.other || null });
        if (pendingEv.length > 64) pendingEv.shift();
      },
      postStep: function (car) {
        if (!car.isPlayer || finished || inCountdown()) return;
        if (arcade && !car.autopilotActive && !car.dnf && !(car.ctx && car.frozenUntil > car.ctx.t) && arcadeApplies(assistLevel, isRace)) {
          try { if (typeof arcade.shape === 'function') arcade.shape(car, STEP); } catch (e) { arcadeErrors++; hookErrors++; arcade = null; }
        }
        // stuck helper (medium / heavy assist): pinned against a wall or beached for 2.5 s -> auto reset after this update
        var inpNow = car.input || {};
        if (Math.abs(num(car.state.speed, 0)) < 1 && (num(inpNow.throttle, 0) > 0.5 || num(inpNow.brake, 0) > 0.5) && !(car.ctx && car.frozenUntil > car.ctx.t)) stuckT += STEP;
        else stuckT = 0;
        if (stuckT > 2.5 && (assistLevel === 'heavy' || assistLevel === 'medium') && cfg.autoRecover !== false) { wantReset = true; stuckT = 0; }
        if (!scorer) return;
        if (car.resets !== lastResets) { lastResets = car.resets; pendingEv.push({ type: 'reset', carId: car.id, intensity: 0.4 }); }
        var sc = stateFromInternal(car);
        if (lastPState) sc.steerInput = num(car.input && car.input.steer, 0);
        var T = R().tracks, geom = inner && inner.geom;
        if (car._dHint !== undefined && T && typeof T.project === 'function' && geom && geom.samples) {
          try { var pr = T.project(geom, sc.x, sc.y, car._dHint); if (pr) { sc.wallDist = pr.wallDist; sc.edgeDist = pr.edgeDist; sc.proj = pr; sc.index = pr.index; } } catch (e) { /* ignore */ }
        }
        sc.t = elapsed();
        if (leadCar) {
          var dx = leadCar.state.x - sc.x, dy = leadCar.state.y - sc.y, dist = Math.hypot(dx, dy);
          var L = num(car.ctx && car.ctx.trackLength, 0), gap = leadCar.lapS - car.lapS;
          if (L) { if (gap > L / 2) gap -= L; else if (gap < -L / 2) gap += L; }
          sc.lead = { id: leadCar.id, x: leadCar.state.x, y: leadCar.state.y, heading: leadCar.state.heading, speed: Math.abs(num(leadCar.state.speed, 0)),
                      s: leadCar.lapS, dist: dist, gap_m: gap };
          sc.tandem = sc.lead;
          tandemStats.samples++; tandemStats.sumGap += dist; tandemStats.lastGap = gap; tandemStats.lastDist = dist; tandemStats.ahead = gap < 0;
          if (dist < tandemStats.minGap) tandemStats.minGap = dist;
          if (dist < 12 && gap > 0) tandemStats.close_s += STEP;
        }
        var evs = pendingEv; pendingEv = [];
        if (pendingTouch > 0) {
          var tnow = car.ctx ? num(car.ctx.t, 0) : 0;
          if (tnow >= touchCool) {
            tandemStats.touches++;
            if (pendingTouch >= TANDEM_TOUCH_SOFT && typeof scorer.bank === 'function') {
              var stB = null; try { stB = typeof scorer.state === 'function' ? scorer.state() : null; } catch (e) { stB = null; }
              if (!stB || stB.drifting || num(stB.current, 0) > 0) { try { if (scorer.bank() > 0) tandemStats.touchBanks++; } catch (e) { hookErrors++; } }
            }
            touchCool = tnow + 0.6;
          }
          pendingTouch = 0;
        }
        try { scorer.update(sc, STEP, evs); } catch (e) {
          hookErrors++;
          if (!scorer.fallback) scorer = createFallbackScorer(inner && inner.geom, inner && inner.trackDef, { duration_s: duration });
        }
      }
    };

    var ecfg = assign({
      trackId: cfg.trackId, track: cfg.track, weather: cfg.weather, timeOfDay: cfg.timeOfDay, seed: cfg.seed,
      playerBuild: build || undefined, difficulty: cfg.difficulty || 'amateur', storage: cfg.storage, persistGhost: false,
      playerName: cfg.playerName, hooks: [hooks]
    }, isRace ? {
      mode: 'race', laps: num(cfg.laps, 3), opponents: cfg.opponents !== undefined ? cfg.opponents : 7, field: cfg.field || 'mixed',
      startPosition: cfg.startPosition || 'back', assists: { abs: true, tc: true, autoShift: true, racingLine: !!cfg.racingLine, steeringAssist: false }
    } : {
      mode: 'practice', laps: 0,
      opponents: mode === 'tandem' ? [{ id: 'lead', name: cfg.leadName || 'Lead · Kaito', build: leadBuild, skill: 0.92, aggression: 0.1, consistency: 0.95, number: '86' }] : 0,
      startPosition: mode === 'tandem' ? 2 : 1, gridOrder: 'given', aiAutoRecover_s: 5, stuckDnf_s: 0, trackLimitsWarnings: 0,
      assists: { abs: true, tc: false, autoShift: true, racingLine: false, steeringAssist: false }
    }, cfg.engineCfg || {});
    if (Array.isArray(cfg.hooks)) ecfg.hooks = ecfg.hooks.concat(cfg.hooks); else if (cfg.hooks) ecfg.hooks = ecfg.hooks.concat([cfg.hooks]);
    if (!ecfg.track) delete ecfg.track;
    if (!ecfg.playerBuild) delete ecfg.playerBuild;

    resetRun();
    inner = E.createSession(ecfg);
    function scorerOpts() {
      var def = inner.trackDef || {};
      var dd = { rookie: 'easy', amateur: 'normal', pro: 'hard', alien: 'pro' }[cfg.difficulty] || cfg.driftDifficulty || 'normal';
      var o = { difficulty: dd, mode: mode, tandem: mode === 'tandem', duration_s: duration || 120, trackId: def.id, playerId: 'player', assistLevel: assistLevel };
      if (Array.isArray(cfg.zones)) o.zones = cfg.zones;            // explicit zones only; else the scorer reads trackDef.driftZones
      if (mode === 'tandem') o.lead = leadInfo;
      return o;
    }
    if (!isRace) scorer = makeScorer(inner.geom, inner.trackDef, scorerOpts());

    function checkEnd() {
      if (finished) return;
      var ph = inner.getPhase ? inner.getPhase() : null;
      if (ph === 'finished') { finish(); return; }
      if (!isRace && duration > 0 && elapsed() >= duration) { finish(); if (inner.end) inner.end(); }
    }
    function finish() {
      if (finished) return;
      finished = true; finishedAt = elapsed();
      if (scorer && typeof scorer.finish === 'function') { try { scorer.finish(); } catch (e) { hookErrors++; } }
    }

    /** Tandem lead car (snapshot-like) for the scorer's proximity bonus. */
    function leadInfo() {
      if (!leadCar) return null;
      var st = leadCar.state;
      return { id: leadCar.id, x: st.x, y: st.y, heading: st.heading, speed: Math.abs(num(st.speed, 0)), vx: leadCar.wvx, vy: leadCar.wvy,
               s: leadCar.lapS, lateral: leadCar.lateral, length_m: leadCar.length_m, width_m: leadCar.width_m };
    }
    function playerState() {
      if (playerCar) return stateFromInternal(playerCar);
      return fallbackPrev;    // derived from snapshots when the engine never called our hooks
    }
    function scorerState() {
      if (!scorer) return null;
      try { return scorer.state(); } catch (e) { return null; }
    }
    function assistDebug() {
      if (arcade && arcadeApplies(assistLevel, isRace) && typeof arcade.debug === 'function') {
        try { return assign({ level: assistLevel }, arcade.debug(), { level: assistLevel }); } catch (e) { /* fall through */ }
      }
      if (!assist || typeof assist.debug !== 'function') return null;
      try { var d = assist.debug(); return d ? assign({ level: assistLevel }, d) : { level: assistLevel }; } catch (e) { return { level: assistLevel }; }
    }
    /** Cosmetic drive for smoke / squeal / camera / meter glow (0..1 values; arcade hints when the lock runs). */
    function fxInfo() {
      var ps = playerCar ? stateFromInternal(playerCar) : fallbackPrev;
      if (!ps) return null;
      var c = null;
      if (arcade && typeof arcade.cosmetics === 'function') { try { c = arcade.cosmetics(); } catch (e) { c = null; } }
      var ang = c ? num(c.angle_deg, ps.angle_deg) : ps.angle_deg, v = ps.speed;
      var drifting = c ? !!c.drifting : (ang > 10 && v > 8);
      var slip = c ? num(c.slip, 0) : clamp01((ang - 6) / 28) * (v > 6 ? 1 : 0);
      var spin = playerCar ? num(playerCar.state.wheelspin, 0) : 0;
      return {
        drifting: drifting, slip: clamp01(Math.max(slip, clamp01(spin) * 0.6) * clamp01(v / 6)), angle_deg: ang, dir: c ? num(c.dir, 0) : sign(-ps.beta),
        swing: !!(c && c.swing), throttle: c ? num(c.throttle, ps.throttle) : ps.throttle, speed: v, rpm: ps.rpm, redline: ps.redline,
        limiter: !!(playerCar && playerCar.state.limiter), sweet: drifting && ang >= 30 && ang <= 50, governor: !!(c && c.governor)
      };
    }
    /** Tandem contact with the lead is forgiven (banked) on heavy / auto: the chase is the assist's job there. */
    function tandemForgiving() {
      return mode === 'tandem' && (assistLevel === 'heavy' || assistLevel === 'auto') && cfg.tandemForgive !== false;
    }
    function tandemInfo() {
      if (mode !== 'tandem') return null;
      return { leadId: leadCar ? leadCar.id : 'lead', gap_m: tandemStats.lastGap, dist_m: tandemStats.lastDist, ahead: tandemStats.ahead,
               avgDist_m: tandemStats.samples ? tandemStats.sumGap / tandemStats.samples : null, close_s: tandemStats.close_s,
               minDist_m: isFinite(tandemStats.minGap) ? tandemStats.minGap : null, driftAi: !!leadDriver,
               touches: tandemStats.touches, touchBanks: tandemStats.touchBanks };
    }

    var api = {
      mode: mode, isRace: isRace, STEP: STEP,
      get geom() { return inner.geom; },
      get trackDef() { return inner.trackDef; },
      get track() { return inner.trackDef; },
      get config() { return inner.config; },
      get engine() { return inner; },
      driftConfig: { mode: mode, assistLevel: assistLevel, tuneLevel: tuneLevel, duration_s: duration, startDelay_s: startDelay },
      update: function (dt, raw) {
        rawIntent = toIntent(raw);
        var pin = { shiftUp: rawIntent.shiftUp, shiftDown: rawIntent.shiftDown, requestReset: rawIntent.requestReset, pit: !!(raw && raw.pit) };
        // the engine input still matters for the edge-triggered fields and for autopilot / pre-start revs
        var d = directInput(rawIntent);
        pin.throttle = d.throttle; pin.brake = d.brake; pin.steer = d.steer; pin.handbrake = d.handbrake;
        var n = inner.update(dt, pin);
        if (wantReset) { wantReset = false; autoResets++; api.resetPlayerToTrack(); }
        if (!playerCar && !finished) {
          // hooks never ran (foreign engine without hook support): derive the player state from snapshots
          try {
            var sn = inner.snapshot(), pc = sn.cars.filter(function (c) { return c.isPlayer; })[0];
            if (sn.events && sn.events.length) pendingSnapEvents = pendingSnapEvents.concat(sn.events);
            var ps = stateFromSnap(pc, fallbackPrev, dt);
            fallbackPrev = ps;
            if (scorer && ps && !inCountdown()) scorer.update(ps, dt, (sn.events || []).filter(function (e) { return e.carId === 'player'; }));
          } catch (e) { hookErrors++; }
        }
        checkEnd();
        return n;
      },
      snapshot: function () {
        var snap = inner.snapshot();
        // drift sessions run an engine 'practice' session; report the drift mode so the base HUD labels the
        // panels FREE RUN / SCORE ATTACK / TANDEM instead of PRACTICE (engine mode kept in snap.engineMode)
        if (!isRace) { snap.engineMode = snap.mode; snap.mode = mode; }
        if (pendingSnapEvents.length) { snap.events = pendingSnapEvents.concat(snap.events || []); pendingSnapEvents = []; }
        var el = elapsed();
        snap.drift = {
          mode: mode, isRace: isRace, assistLevel: assistLevel, tuneLevel: tuneLevel,
          scorer: scorerState(), assist: assistDebug(), player: playerCar ? stateFromInternal(playerCar) : fallbackPrev,
          elapsed_s: el, duration_s: duration, timeLeft_s: duration > 0 ? Math.max(0, duration - el) : null,
          countdown_s: inCountdown() ? startDelay - inner.time() : 0, finished: finished, tandem: tandemInfo(),
          fx: fxInfo(), arcade: !!(arcade && arcadeApplies(assistLevel, isRace))
        };
        return snap;
      },
      results: function () {
        var r = inner.results();
        r.driftMode = mode; r.assistLevel = assistLevel; r.tuneLevel = isRace ? null : tuneLevel;
        r.duration_s = duration; r.elapsed_s = finished ? finishedAt : elapsed(); r.finished = finished;
        var dr = null;
        if (scorer) { try { dr = typeof scorer.results === 'function' ? scorer.results() : null; } catch (e) { dr = null; } }
        if (scorer && !dr) { var st = scorerState(); dr = st ? { total: st.total } : null; }
        r.drift = dr;
        r.tandem = tandemInfo();
        r.hookErrors = hookErrors; r.autoResets = autoResets;
        return r;
      },
      restart: function () {
        resetRun();
        pendingSnapEvents = [];
        inner.restart();
        if (!isRace) scorer = makeScorer(inner.geom, inner.trackDef, scorerOpts());
        return api;
      },
      resetPlayerToTrack: function () {
        if (inner.resetPlayerToTrack) inner.resetPlayerToTrack();
        if (assist && assist.reset) { try { assist.reset(); } catch (e) { /* ignore */ } }
        if (arcade && arcade.reset) { try { arcade.reset(); } catch (e) { /* ignore */ } }
      },
      end: function () { finish(); if (inner.end) inner.end(); },
      scorerState: scorerState,
      assistDebug: assistDebug,
      playerState: playerState,
      getAssistLevel: function () { return assistLevel; },
      getTuneLevel: function () { return tuneLevel; },
      setAssistLevel: function (l) {
        assistLevel = pick(ASSIST_LEVELS, l, assistLevel);
        api.driftConfig.assistLevel = assistLevel;
        if (scorer && typeof scorer.setAssistLevel === 'function') { try { scorer.setAssistLevel(assistLevel); } catch (e) { /* ignore */ } }
        if (!arcadeApplies(assistLevel, isRace)) arcade = null;      // heavy/auto <-> lower levels: drop / lazily rebuild the lock
        if (assist && typeof assist.setLevel === 'function') { try { assist.setLevel(assistLevel); return assistLevel; } catch (e) { /* recreate */ } }
        assist = makeAssist(assistLevel, isRace ? 'race' : 'drift');
        return assistLevel;
      },
      /** Takes effect on the next restart() (params are baked at car creation). */
      setTuneLevel: function (l) { tuneLevel = pick(TUNE_LEVELS, l, tuneLevel); api.driftConfig.tuneLevel = tuneLevel; return tuneLevel; },
      setPlayerAutopilot: function (on) { if (inner.setPlayerAutopilot) inner.setPlayerAutopilot(on); },
      setAssists: function (a) { if (inner.setAssists) inner.setAssists(a); },
      defaultCamera: 'chase',
      time: function () { return inner.time(); },
      elapsed: elapsed,
      getPhase: function () { return finished ? 'finished' : (inCountdown() ? 'countdown' : (inner.getPhase ? inner.getPhase() : 'racing')); },
      isFinished: function () { return finished; },
      alpha: function () { return inner.alpha ? inner.alpha() : 0; },
      simulate: function (seconds, raw) {
        var n = Math.round(num(seconds, 0) / STEP), done = 0;
        while (done < n && !finished) { var k = api.update(Math.min(n - done, 60) * STEP, raw); if (!k) break; done += k; }
        return done;
      },
      fmtTime: inner.fmtTime,
      _hooks: hooks,
      _debug: function () { return { inner: inner, playerCar: playerCar, leadCar: leadCar, assist: assist, scorer: scorer, leadDriver: leadDriver }; }
    };
    return api;
  }

  CB.race.drift.createSession = createSession;
  CB.race.drift.session = {
    createSession: createSession, tracksFor: tracksFor, isDriftTrack: isDriftTrack, driftPresetBuild: driftPresetBuild,
    ASSIST_LEVELS: ASSIST_LEVELS, TUNE_LEVELS: TUNE_LEVELS, MODES: MODES,
    _internal: { toIntent: toIntent, directInput: directInput, stateFromInternal: stateFromInternal, stateFromSnap: stateFromSnap,
                 createFallbackAssist: createFallbackAssist, createFallbackScorer: createFallbackScorer, gradeOf: gradeOf }
  };
})();
if (typeof module !== 'undefined') module.exports = CB.race.drift.session;

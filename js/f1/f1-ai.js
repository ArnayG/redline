/* ==========================================================================
   Redline — js/f1/f1-ai.js
   CB.f1.ai : Formula 1 racecraft on top of the adaptive race AI (docs/F1-SPEC.md §5). Pure logic, no DOM, Node-loadable.

   The base driver (CB.race.ai.createDriver, built by the engine from the car's F1 params, so its speed plan is already
   downforce-aware) keeps doing the driving: racing line, braking points, traffic corridor, one-move defending,
   overtakes, recovery. The wrapper adds what F1 needs on top:

     wrapDriver(base, car, entrant, opts?) -> driver   (engine hook wrapDriver; same { control(state, ctx, dt) } contract)
       - pit lane: when the car has a pit request (approach) or is in the lane (car.pitPhase), it drives itself down the
         pit lane (pitLaneInput): lines up on the pit side, turns in after the entry line, holds the limiter, stops in its
         team box, leaves at the limiter and rejoins; cars in the pit lane are hidden from the cars racing on track
         (and vice versa) so nobody squeezes or brakes for them
       - DRS / ERS intent: car.f1Intent = { drs, ersBoost, ersMode } every step (the hooks apply the rules: DRS opens only
         where and when it is allowed; the intent is "wants it"): DRS on straights, ERS boost to attack / defend / on
         lap 1, harvest when the store is empty or under blue flags
       - tyre management: per lap compares tyre wear with the strategy's stint plan (car.f1Strategy) and drives a touch
         under the limit when the tyres are wearing too fast or running hot (skill offset via base.setSkill)
       - lap-1 restraint: slightly earlier braking for the first corners while the pack is tight (clean T1)
       - blue flags: a car about to be lapped lifts on the straight and holds its line
     pitLaneInput(car, ctx, dt, opts) -> input | null   the pit-lane controller on its own (hooks can drive the player with it)
     profile(difficulty, teamPace, seat, rng?) -> { skill, aggression, consistency, mistakeMult, reaction_s }
     DIFFICULTY                                         per-level pace / racecraft (rookie .. alien)
     laneMeta(ctx|track) -> { side, entry_s, exit_s, offset_m, width_m, speedLimit_ms, box_s(teamIdx) } | null

   Pit lane geometry comes from CB.f1.circuits.meta(def).pit when loaded, else def.f1.pit / def.pitEntry_s etc.; the
   box s is the engine hook pitBox's (car.f1.box_s / car.pitBox_s) or the meta's box_s(teamIndex).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.f1 = CB.f1 || {};

(function () {
  'use strict';

  var TAU = Math.PI * 2;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function wrapAngle(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

  /* ------------------------------------------------------------ difficulty */
  /* skill drives the base AI's grip usage (0.80..0.93 of the limit) and braking confidence; Pro is tuned to be
     competitive with a good player on the assists, Alien drives on the limit every lap. */
  var DIFFICULTY = {
    rookie:  { skill: 0.52, spread: 0.06, aggression: 0.25, consistency: 0.70, mistakeMult: 1.4 },
    amateur: { skill: 0.67, spread: 0.05, aggression: 0.40, consistency: 0.82, mistakeMult: 1.0 },
    pro:     { skill: 0.82, spread: 0.04, aggression: 0.55, consistency: 0.92, mistakeMult: 0.6 },
    alien:   { skill: 0.98, spread: 0.02, aggression: 0.65, consistency: 0.98, mistakeMult: 0.25 }
  };
  function profile(difficulty, teamPace, seat, rng) {
    var d = DIFFICULTY[difficulty] || DIFFICULTY.pro;
    var r = typeof rng === 'function' ? rng() : 0.5;
    var tp = num(teamPace, 0.9);
    // team pace (0.82 .. 0.97) spreads the field like a real grid; the second seat is a hair slower on average
    var sk = d.skill + (tp - 0.9) * d.spread * 6 + (r - 0.5) * d.spread * 0.6 - (seat === 1 ? d.spread * 0.15 : 0);
    return {
      skill: clamp(sk, 0.3, 1), aggression: clamp(d.aggression + (r - 0.5) * 0.2, 0, 1),
      consistency: clamp(d.consistency + (tp - 0.9) * 0.3, 0, 1), mistakeMult: d.mistakeMult,
      reaction_s: lerp(0.45, 0.16, clamp(sk, 0, 1))
    };
  }

  var LAP1 = { m: 1400, pace: 0.92, skill: null };
  /** Pace factor on the speed plan for a base-AI skill (F1 entrants: rookie ~0.57 .. alien ~0.97). */
  function paceOf(skill) { return clamp(lerp(0.80, 1.0, (num(skill, 0.8) - 0.45) / 0.53), 0.8, 1.0); }   // rookie ~0.86, amateur ~0.92, pro ~0.965, alien ~1

  /* ------------------------------------------------------------ pit lane geometry */
  var metaCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function laneMeta(src) {
    var def = src && (src.track || src.trackDef || src.def) ? (src.track || src.trackDef || src.def) : src;
    if (!def || typeof def !== 'object') return null;
    if (metaCache && metaCache.has(def)) return metaCache.get(def);
    var out = null, C = CB.f1 && CB.f1.circuits;
    try {
      if (C && typeof C.meta === 'function') {
        var m = C.meta(def);
        if (m && m.pit && isNum(m.pit.entry_s)) out = Object.assign({ length_m: m.length_m }, m.pit);
      }
    } catch (e) { out = null; }
    if (!out) {
      var p = (def.f1 && def.f1.pit) || def.pitLane || null;
      if (p && isNum(def.pitEntry_s)) out = { side: num(p.side, -1), entry_s: def.pitEntry_s, exit_s: def.pitExit_s, offset_m: num(p.offset_m, 14), width_m: num(p.width_m, 7), speedLimit_kph: num(p.speedLimit_kph, 80) };
    }
    if (out) {
      out.side = out.side >= 0 ? 1 : -1;
      out.speedLimit_ms = num(out.speedLimit_ms, num(out.speedLimit_kph, 80) / 3.6);
      out.offset_m = num(out.offset_m, 14);
    }
    if (metaCache) metaCache.set(def, out);
    return out;
  }

  function geomOf(ctx) { return ctx && ctx.geom && Array.isArray(ctx.geom.samples) ? ctx.geom : null; }
  function wrapS(s, L) { s = s % L; return s < 0 ? s + L : s; }
  function ahead(from, to, L) { return wrapS(to - from, L); }    // distance forward from `from` to `to`
  function inRange(s, a, b, L) { s = wrapS(s, L); return b >= a ? s >= a && s <= b : s >= a || s <= b; }
  function pointAt(geom, s, lat) {
    var T = CB.race && CB.race.tracks;
    if (T && typeof T.pointAt === 'function') return T.pointAt(geom, s, lat);
    var S = geom.samples, N = S.length, ds = geom.length / N, i = Math.floor(wrapS(s, geom.length) / ds) % N, a = S[i];
    return { x: a.x - Math.sin(a.heading) * lat, y: a.y + Math.cos(a.heading) * lat, heading: a.heading, width: a.width };
  }
  function boxOf(car, lm) {
    if (car) {
      if (isNum(car.pitBox_s)) return car.pitBox_s;
      if (car.f1 && isNum(car.f1.box_s)) return car.f1.box_s;
    }
    if (lm && typeof lm.box_s === 'function') { try { var b = lm.box_s(car && car.f1 && isNum(car.f1.teamIndex) ? car.f1.teamIndex : 0); if (isNum(b)) return b; } catch (e) { /* below */ } }
    if (lm && isNum(lm.box_s)) return lm.box_s;
    if (lm && isNum(lm.box0_s)) return lm.box0_s;
    return lm ? wrapS(lm.entry_s + ahead(lm.entry_s, lm.exit_s, lm.length_m || 1e9) * 0.55, lm.length_m || 1e9) : 0;
  }

  /**
   * The pit-lane controller. Returns an input for a car that is approaching the pit entry with a stop called, in the
   * lane, stopped, or rejoining; null when the car has nothing to do with the pit lane.
   * opts { state (per-car scratch object), wheelbase, maxSteer }
   */
  function pitLaneInput(car, ctx, dt, opts) {
    opts = opts || {};
    var geom = geomOf(ctx), lm = laneMeta(ctx);
    if (!car || !geom || !lm) return null;
    var L = geom.length, st = car.state || {}, s = num(car.lapS, num(ctx.s, 0)), lat = num(car.lateral, num(ctx.lateral, 0));
    var S = opts.state || (car._f1Pit = car._f1Pit || {});
    var phase = car.pitPhase || null;
    var dEntry = ahead(s, lm.entry_s, L);
    var approaching = !phase && car.pitRequest && dEntry < 320 && !car.finished;
    if (phase) S.active = true;
    var rejoin = !phase && S.active;
    if (!phase && !approaching && !rejoin) { S.active = false; return null; }
    var hw = num(pointAt(geom, s, 0).width, 12) / 2;
    var side = lm.side, laneLat = side * lm.offset_m;
    var v = Math.abs(num(st.speed, 0));
    var lim = lm.speedLimit_ms * 0.97;
    var exitLen = 90;
    // lateral reference along s
    function latRef(sq) {
      var dE = ahead(sq, lm.entry_s, L), inLane = inRange(sq, lm.entry_s, lm.exit_s, L), pastExit = ahead(lm.exit_s, sq, L);
      if (inLane) {
        var into = ahead(lm.entry_s, sq, L);
        var sw = lerp(side * (hw - 1.6), laneLat, smooth(into / 70));
        return sw;
      }
      if (rejoin || (phase && pastExit < exitLen + 40)) {
        return lerp(laneLat, side * Math.max(0, hw - 3), smooth(pastExit / exitLen));
      }
      // approach: move over to the pit side of the track over the last ~250 m
      return lerp(lat, side * (hw - 1.6), smooth(1 - (dE - 60) / 200));
    }
    var Ld = clamp(v * 0.55 + 5, 6, 26);
    var sT = s + Ld, lt = latRef(sT);
    var p = pointAt(geom, sT, lt);
    var dx = p.x - num(st.x, 0), dy = p.y - num(st.y, 0);
    var alpha = wrapAngle(Math.atan2(dy, dx) - num(st.heading, 0));
    var wb = num(opts.wheelbase, 3.6), maxSteer = num(opts.maxSteer, 0.42);
    var delta = Math.atan2(2 * wb * Math.sin(alpha), Math.max(4, Math.hypot(dx, dy)));
    var steer = clamp(delta / maxSteer, -1, 1);
    // speed reference
    var vT = 90;
    if (approaching) vT = Math.sqrt(lim * lim + 2 * 14 * Math.max(0, dEntry - 10));
    if (phase === 'lane') {
      vT = lim;
      var dBox = ahead(s, boxOf(car, lm), L);
      if (dBox < L / 2) vT = Math.min(vT, Math.max(1.6, Math.sqrt(2 * 7 * Math.max(0, dBox - 0.6))));
    }
    if (phase === 'stopped') return { throttle: 0, brake: 1, steer: 0, handbrake: true };
    if (phase === 'exit') vT = lim;
    if (rejoin) {
      var pe = ahead(lm.exit_s, s, L);
      if (pe > exitLen + 60 || Math.abs(lat) < hw - 0.5 || pe > L / 2) { S.active = false; return null; }
      vT = 90;
    }
    var err = vT - v;
    var thr = clamp(err * 0.35 + (vT > 5 ? 0.08 : 0), 0, 1), brk = clamp(-err * 0.3, 0, 1);
    if (phase === 'lane' || phase === 'exit') { if (v > lm.speedLimit_ms) { thr = 0; } }
    return { throttle: thr, brake: brk, steer: steer, handbrake: false };
  }

  /* ------------------------------------------------------------ helpers on the F1 car state */
  function f1Of(car) { return (car && car.f1) || {}; }
  function ersSoc(car) {
    var e = f1Of(car).ers;
    return e && isNum(e.soc) ? e.soc : (isNum(f1Of(car).soc) ? f1Of(car).soc : 0.6);
  }
  function drsAllowed(car) {
    var d = f1Of(car).drs;
    if (!d) return true;
    if (d.available === false && d.eligible === false) return false;
    return true;
  }

  /* ------------------------------------------------------------ the wrapper */
  function wrapDriver(base, car, entrant, opts) {
    if (!base || typeof base.control !== 'function') return base;
    opts = opts || {};
    var baseSkill = num(entrant && entrant.skill, num(base.opponent && base.opponent.skill, 0.8));
    var aggression = num(entrant && entrant.aggression, 0.5);
    var S = { lap: -1, manage: 0, skillNow: baseSkill, startT: null, pit: {}, intent: { drs: false, ersBoost: false, ersMode: 'auto' }, filt: { nearby: [], cars: [] } };
    var params = car && car.params || {};

    /** Hand the intent to the hooks: car.f1Intent (contract) + the CB.f1.hooks per-car flags (aiDrs / aiBoost). */
    function publish() {
      if (!car) return;
      car.f1Intent = S.intent;
      var f = car.f1;
      if (f && !car.isPlayer || (f && opts.isAutopilot)) {
        f.aiDrs = !!S.intent.drs;
        f.aiBoost = !!S.intent.ersBoost;
        if (f.ers && (f.ers.mode === 'auto' || f.ers.mode === 'harvest')) f.ers.mode = S.intent.ersMode === 'harvest' ? 'harvest' : 'auto';
      }
    }
    // difficulty -> pace on the speed plan. The base AI's own skill only moves its grip usage a couple of percent, and its
    // online learning pulls a driver on the limit back to the same place, so the F1 field is spread with a pace factor
    // applied after the learning: Alien ~1.0, Pro ~0.98, Amateur ~0.95, Rookie ~0.92 of the corner speeds.
    var paceBase = num(entrant && entrant.paceScale, paceOf(baseSkill));
    S.paceNow = -1;
    function setPaceFactor(k) {
      var p = clamp(paceBase * k, 0.5, 1.1);
      if (Math.abs(p - S.paceNow) < 0.0005) return;
      S.paceNow = p;
      if (typeof base.setPace === 'function') base.setPace(p);
    }

    function onTrackOnly(list, selfInPit) {
      if (!Array.isArray(list)) return list;
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c) continue;
        var inPit = c.surface === 'pit';
        if (c.id === (car && car.id)) { out.push(c); continue; }
        if (inPit === !!selfInPit) out.push(c);
      }
      return out;
    }

    var tyreT = -1, tyreG = 1;
    function tyreScale(ctx) {
      var t = num(ctx.t, 0);
      if (t - tyreT < 0.25 && tyreT >= 0) return tyreG;
      tyreT = t;
      var f = car && car.f1, C = CB.f1 && CB.f1.car;
      if (!f || !f.tyres || !C || typeof C.tyreGrip !== 'function') { tyreG = 1; return 1; }
      var wet = num(ctx.env && ctx.env.wetness, 0), g;
      try { g = C.tyreGrip(f.tyres, wet); } catch (e) { g = null; }
      if (!Array.isArray(g) || g.length < 4) { tyreG = 1; return 1; }
      // relative to a warm, fresh medium (the params' mu is quoted for that tyre): fresh softs > 1
      var ref = typeof C.tyreFactor === 'function' ? C.tyreFactor('medium', 100, 0, 0) : 1;
      var fr = (g[0] + g[1]) / 2, rr = (g[2] + g[3]) / 2;
      // quantise (the base driver caches one speed plan per 0.02 of grip scale)
      tyreG = Math.round(clamp(Math.min(fr, rr) / Math.max(0.3, ref), 0.4, 1.15) * 100) / 100;
      return tyreG;
    }
    function perLap(ctx) {
      var lap = num(ctx.lap, 0);
      if (lap === S.lap) return;
      S.lap = lap;
      // tyre management: wear ahead of the stint plan (or tyres overheating) -> drive a touch under the limit
      var ST = CB.f1 && CB.f1.strategy, ti = ST ? ST.tyreInfo(car) : null, plan = car && car.f1Strategy;
      var manage = 0;
      if (ti && plan && ST.stintAt) {
        var stint = ST.stintAt(plan, lap + 1);
        if (stint) {
          var age = Math.max(1, num(ti.age, lap + 1 - stint.fromLap + 1));
          var expected = age / Math.max(1, num(plan.life && plan.life[stint.compound], stint.laps)) * 0.85;
          if (ti.wear > expected + 0.08) manage = 0.025;
          var remaining = stint.toLap - lap;
          if (ti.wear > 0.6 && remaining > 2) manage = Math.max(manage, 0.035);
        }
      }
      if (ti && Array.isArray(ti.temp) && ti.temp.length) {
        var hot = Math.max.apply(null, ti.temp);
        if (hot > 118) manage = Math.max(manage, 0.02);
      }
      S.manage = manage;
    }

    function control(vs, ctx, dt) {
      ctx = ctx || {};
      var racing = ctx.phase === 'racing';
      if (racing && S.startT === null) S.startT = num(ctx.t, 0);
      // 1) pit lane (CB.f1.hooks drive every car down the lane in their preStep; this controller is the fallback)
      var pin = car && !opts.hooks ? pitLaneInput(car, ctx, dt, { state: S.pit, wheelbase: num(params.wheelbase, 3.6), maxSteer: num(params.maxSteer, num(params.lockAngle, 0.42)) }) : null;
      if (pin) {
        S.intent.drs = false; S.intent.ersBoost = false; S.intent.ersMode = 'harvest';
        publish();
        return pin;
      }

      // 2) the race: base driver with pit-lane cars filtered out of its traffic picture
      var selfInPit = car && car.surface === 'pit';
      var c2 = ctx;
      if (Array.isArray(ctx.nearby) && ctx.nearby.some(function (c) { return c && (c.surface === 'pit') !== selfInPit; })) {
        c2 = Object.assign({}, ctx);
        c2.nearby = c2.others = onTrackOnly(ctx.nearby, selfInPit);
        if (Array.isArray(ctx.cars)) c2.cars = onTrackOnly(ctx.cars, selfInPit);
      } else if (Array.isArray(ctx.cars) && ctx.cars.some(function (c) { return c && c.surface === 'pit' && c.id !== (car && car.id); })) {
        c2 = Object.assign({}, ctx);
        c2.cars = onTrackOnly(ctx.cars, selfInPit);
      }
      perLap(ctx);
      // tyre-aware plan: the hooks feed per-wheel grip (compound, temperature, wear, wetness) into the vehicle; give the
      // base driver the weaker axle's factor as its grip scale, so it brakes earlier on cold / worn tyres instead of
      // finding out at the apex (and needs no permanent grip-learning cut afterwards)
      var tg = tyreScale(ctx);
      if (tg !== 1) {
        if (c2 === ctx) c2 = Object.assign({}, ctx);
        var env0 = ctx.env || {};
        var gm = num(env0.gripMult, num(ctx.gripMult, 1)) * tg;
        c2.env = Object.assign({}, env0, { gripMult: gm });
        c2.gripMult = gm;
      }
      // lap-1 restraint: the first ~1.4 km after lights-out, a little more margin in the braking zones
      // lap-1 restraint: until the field has strung out through the first corners (~1.4 km) every car runs the same
      // cautious pace (same braking points for the whole pack: contacts at T1 come from cars braking at different
      // points, not from the pace itself), then each driver goes back to its own
      var lap1 = racing && num(ctx.lap, 0) === 0 && car && num(car.raceDist, 0) < LAP1.m;
      if (lap1) {
        var lp = Math.min(paceBase, LAP1.pace);
        if (Math.abs(lp - S.paceNow) > 0.0005) { S.paceNow = lp; if (typeof base.setPace === 'function') base.setPace(lp); }
        // ...and the same grip / braking confidence (base skill), so braking points line up through the pack
        if (LAP1.skill != null && !S.lap1Skill && typeof base.setSkill === 'function') { S.lap1Skill = true; base.setSkill(Math.min(baseSkill, LAP1.skill)); }
      } else {
        if (S.lap1Skill) { S.lap1Skill = false; if (typeof base.setSkill === 'function') base.setSkill(baseSkill); }
        setPaceFactor(1 - (S.manage || 0));
      }
      var out = base.control(vs, c2, dt) || {};
      // 3) traffic around us (for DRS / ERS / blue flags)
      var near = Array.isArray(c2.nearby) ? c2.nearby : [];
      var me = ctx.self || ctx.me || null, myDist = car ? num(car.raceDist, 0) : 0, L = num(ctx.trackLength, 5000);
      var aheadCar = null, behindCar = null, blue = false;
      var v = Math.abs(num(vs && vs.speed, me ? me.speed : 0));
      for (var i = 0; i < near.length; i++) {
        var o = near[i];
        if (!o || o.surface === 'pit') continue;
        if (o.ds > 0 && o.ds < 90 && (!aheadCar || o.ds < aheadCar.ds)) aheadCar = o;
        if (o.ds < 0 && o.ds > -60 && (!behindCar || o.ds > behindCar.ds)) behindCar = o;
      }
      if (behindCar && ctx.cars && car) {
        for (var j = 0; j < ctx.cars.length; j++) {
          var oc = ctx.cars[j];
          if (oc && oc.id === behindCar.id && num(oc.raceDist, 0) > myDist + L * 0.5 && behindCar.ds > -45) blue = true;
        }
      }
      // 4) DRS / ERS intent (the hooks enforce the rules)
      var straight = Math.abs(num(out.steer, 0)) < 0.22 && num(out.brake, 0) < 0.05 && num(out.throttle, 0) > 0.85;
      S.intent.drs = straight && v > 30 && drsAllowed(car);
      var soc = ersSoc(car);
      var gapAhead_s = aheadCar ? aheadCar.ds / Math.max(10, v) : 99;
      var gapBehind_s = behindCar ? -behindCar.ds / Math.max(10, v) : 99;
      var attack = gapAhead_s < 0.9 && straight, defend = gapBehind_s < 0.6 && straight;
      var lap1Boost = racing && num(ctx.lap, 0) === 0 && straight;
      var reserve = lerp(0.35, 0.15, aggression);
      S.intent.ersBoost = !blue && (attack || defend || lap1Boost) && soc > reserve;
      S.intent.ersMode = blue || soc < 0.1 ? 'harvest' : 'auto';
      publish();
      // 5) blue flag: lift on the straight and hold the line
      if (blue && straight) { out.throttle = Math.min(num(out.throttle, 1), 0.82); car && (car.blueFlag = true); }
      else if (car) car.blueFlag = false;
      return out;
    }

    var w = {
      f1: true, base: base, opponent: base.opponent, id: base.id, limits: base.limits,
      control: control,
      reset: function () { S.lap = -1; S.manage = 0; S.startT = null; S.pit = {}; if (typeof base.reset === 'function') base.reset(); },
      setRubberBand: function (on) { if (typeof base.setRubberBand === 'function') base.setRubberBand(on); },
      setSkill: function (v) { baseSkill = clamp(v, 0, 1); paceBase = paceOf(baseSkill); if (typeof base.setSkill === 'function') base.setSkill(baseSkill); S.paceNow = -1; setPaceFactor(1 - (S.manage || 0)); },
      setPace: function (k) { paceBase = clamp(num(k, 1), 0.5, 1.1); S.paceNow = -1; setPaceFactor(1 - (S.manage || 0)); },
      profile: function (g) { return typeof base.profile === 'function' ? base.profile(g) : null; },
      debug: function () { var d = typeof base.debug === 'function' ? base.debug() : {}; d.f1 = { manage: S.manage, skill: baseSkill, pace: S.paceNow, intent: S.intent }; return d; },
      intent: function () { return S.intent; }
    };
    Object.defineProperty(w, 'mode', { get: function () { return base.mode; } });
    Object.defineProperty(w, 'wantsReset', { get: function () { return base.wantsReset; } });
    return w;
  }

  CB.f1.ai = {
    wrapDriver: wrapDriver, LAP1: LAP1, pitLaneInput: pitLaneInput, profile: profile, paceOf: paceOf, laneMeta: laneMeta, DIFFICULTY: DIFFICULTY
  };
})();

if (typeof module !== 'undefined') module.exports = CB.f1.ai;

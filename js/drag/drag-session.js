/* ==========================================================================
   Redline — js/drag/drag-session.js
   CB.drag.session : one drag run — two lanes, burnout box, staging beams, the tree, the pass, shutdown — on the
   real race vehicle model (CB.race.vehicle) at a fixed 1/120 s step (docs/DRAG-SPEC.md §5).

     create(cfg) -> { update(dtReal, input), step(), setLaneInput(lane, input), snapshot(), results(), restart(),
                      destroy(), lane(i), cfg, getTrace(lane) }
     simulate(cfg) -> results            headless: every lane AI / ghost / none

   Pure logic (no DOM). Seeded, no Math.random: the same cfg + input stream reproduces the run exactly.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.drag = CB.drag || {};

(function () {
  'use strict';
  var DT = 1 / 120, MAX_STEPS = 8, MPH = 2.2369363;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { var n = Number(v); return v != null && isFinite(n) ? n : d; }
  function V() { return CB.race.vehicle; }
  function ST() { return CB.drag.strip; }
  function TR() { return CB.drag.tree; }
  function TM() { return CB.drag.timing; }
  function LA() { return CB.drag.launch; }
  function AI() { return CB.drag.ai; }

  var ROLL_START_X = -160;

  function defaultBuild() {
    try { if (CB.data && typeof CB.data.defaultBuild === 'function') return CB.data.defaultBuild(); } catch (e) { /* none */ }
    return {};
  }

  function create(cfgIn) {
    var cfg = Object.assign({ seed: 1, distanceId: 'quarter', venue: 'strip', surface: 'prepped', night: false, treeType: 'pro',
      bracket: false, class: 'street', playerLane: 0, skipBurnout: false }, cfgIn || {});
    if (cfg.venue === 'street' && cfgIn && cfgIn.treeType == null) cfg.treeType = 'flag';
    var dist = ST().get(cfg.distanceId), surf = ST().surface(cfg.surface), G = ST().GEO;
    var roll = !!dist.roll;
    var finishX = dist.m || dist.stripM || 1000;
    var S;   // session state

    function init() {
      var entries = (cfg.lanes || []).slice(0, 2);
      while (entries.length < 2) entries.push({ kind: 'none' });
      // bracket: the slower dial starts first (handicap = dial difference)
      var dials = entries.map(function (e) { return e && e.kind !== 'none' && cfg.bracket ? num(e.dial, null) : null; });
      var hc = [0, 0];
      if (cfg.bracket && dials[0] != null && dials[1] != null) { var mx = Math.max(dials[0], dials[1]); hc = [mx - dials[0], mx - dials[1]]; }
      S = {
        t: 0, phase: roll ? 'tree' : 'burnout', tree: TR().create({ type: roll ? (cfg.treeType === 'flag' ? 'flag' : 'pro') : cfg.treeType, seed: (num(cfg.seed, 1) * 2654435761) >>> 0, handicap: hc }),
        lanes: entries.map(function (e, i) { return makeLane(e || { kind: 'none' }, i, dials[i]); }),
        events: [], evSeq: 0, decision: null, decidedT: null, doneT: null, stagedT: null
      };
      if (roll) TR().arm(S.tree, 1.2);
    }

    function makeLane(e, i, dial) {
      var L = { lane: i, kind: e.kind || 'none', entry: e, name: e.name || (e.kind === 'player' ? 'You' : 'Lane ' + (i + 1)), carName: e.carName || '',
        color: e.color || null, modelId: e.modelId || null, isPlayer: e.kind === 'player', dial: dial, events: 0 };
      if (L.kind === 'none') return L;
      L.build = e.build || defaultBuild();
      L.timer = TM().createLane(dist);
      L.bo = LA().burnout.create();
      L.assists = Object.assign({ autoShift: true, launchControl: true, tc: 'car', autoStage: false }, e.assists || {});
      L.preStaged = L.staged = L.deep = L.left = L.red = L.finished = false; L.dq = null;
      L.rt = null; L.chute = 0; L.wheelie = 0; L.smoke = 0; L.limiterT = 0; L.lastShift = null;
      L.shifts = { perfect: 0, good: 0, early: 0, late: 0 }; L.trace = []; L.traceT = 0; L.holdThr = 0; L.held = false;
      L.launchRpm = null; L.launchT = null; L.bogged = false; L.spun = false; L.inputs = {}; L.prev = {};
      L.burning = false; L.burnT = 0; L.finishedT = null; L.nitroLeft = 6; L.nitroOn = false;
      if (L.kind === 'remote') {
        // a networked opponent (js/net/netdrag.js): posed from its own simulation's state packets (setRemote)
        L.p = safeParams(L.build); L.frontOff = L.p.a + L.p.radiusF;
        L.gx = (cfg.skipBurnout || cfg.venue === 'street' ? -6 - L.frontOff : G.START_X) + L.frontOff; L.gv = 0; L.x = L.gx - L.frontOff; L.y = ST().laneY(i);
        L.rs = { xFront: L.gx, vx: 0, rpm: L.p.idle, gear: 1 }; L.rsT = 0;
        return L;
      }
      if (L.kind === 'ghost') {
        L.ghost = e.ghost;
        L.p = safeParams(L.build);
        L.frontOff = L.p.a + L.p.radiusF;
        L.gx = 0; L.gv = 0; L.x = -L.frontOff + 0.04; L.y = ST().laneY(i);
        L.preStaged = L.staged = true; L.bo.temp = 85;
        return L;
      }
      var base = safeParams(L.build);
      base = LA().withAssists(base, { tc: L.assists.tc, launchControl: L.assists.launchControl });
      L.baseP = base;
      L.lc = !!base.launchControl;
      L.pN2O = cfg.class === 'pro-mod' && num(e.nitrous_hp, 0) > 0 ? LA().nitrousParams(base, e.nitrous_hp) : null;
      L.p = base;
      L.frontOff = base.a + base.radiusF;
      var autoShift = L.kind === 'ai' ? (base.isEV || base.isCVT || base.maxGear <= 1 || roll) : L.assists.autoShift !== false;
      L.autoShift = autoShift;
      var x0 = roll ? ROLL_START_X : cfg.skipBurnout || cfg.venue === 'street' ? -6 - L.frontOff : G.START_X;
      L.s = V().createState(base, { x: x0, y: ST().laneY(i), heading: 0, autoShift: autoShift, speed: roll ? dist.fromV : 0 });
      if (roll || cfg.skipBurnout) { L.bo.temp = 60; }
      L.envBase = { gripMult: surf.grip, wetness: surf.wetness, assists: { autoShift: autoShift } };
      L.band = LA().sweetSpot(base, { gripMult: surf.grip * (1 + LA().burnout.bonus(85, surf)), wetness: surf.wetness });
      if (L.kind === 'ai') {
        L.driver = AI().createDriver({ difficulty: e.difficulty, seed: (num(cfg.seed, 1) * 977 + i * 131) >>> 0, deep: e.deep });
        var envR = { gripMult: surf.grip * 1.06, wetness: surf.wetness };
        L.roll0 = LA().rolloutTime(base, envR, L.band.best || null, 0.02); L.roll1 = LA().rolloutTime(base, envR, L.band.best || null, 0.16);
      }
      return L;
    }
    function safeParams(build) {
      try { return V().fromBuild(build); } catch (e) { return V().fromBuild(defaultBuild()); }
    }
    function rolloutEst(p) {
      // time for a hard launch to move the 0.29 m rollout (≈ √(2·d/a) at ~0.9 g, plus clutch take-up)
      var g = clamp(p.powerKw / p.mass * 1.6, 0.6, 1.3);
      return Math.sqrt(2 * 0.27 / (g * 9.81)) + (p.converter ? 0.06 : 0.03);
    }

    function emit(type, lane, extra) {
      var ev = Object.assign({ id: ++S.evSeq, type: type, lane: lane, t: S.t }, extra || {});
      S.events.push(ev);
      if (S.events.length > 200) S.events.splice(0, S.events.length - 200);
      return ev;
    }
    function puppet(L) { return L.kind === 'ghost' || L.kind === 'remote'; }
    function xFront(L) { return puppet(L) ? L.gx : L.s.x + L.frontOff; }
    function active(L) { return L.kind !== 'none'; }

    /* ---------------------------------------------------------- per-lane view (AI + HUD helpers) */
    function view(L) {
      var s = L.s, p = L.p, xf = xFront(L);
      var other = S.lanes[1 - L.lane];
      return { phase: S.phase, t: S.t, xFront: xf, vx: s.vx, rpm: s.rpm, gear: s.gear, maxGear: p.maxGear, idle: p.idle, redline: p.redline,
        staged: L.staged, deep: L.deep, preStaged: L.preStaged, left: L.left, finished: L.finished, limiter: !!s.limiter, shifting: !!s.shifting, clutchLocked: !!s.clutchLocked,
        inBox: s.x >= G.BURNOUT_X0 && s.x <= G.BURNOUT_X1, tyreTemp: L.bo.temp, street: cfg.venue === 'street' || roll,
        otherStaged: !active(other) || other.staged, greenT: S.tree.armed ? S.tree.greenT[L.lane] : null, autoShift: L.autoShift,
        optShift: LA().optimalShift(p, s.gear), launchBand: L.band, ev: !!p.isEV, converter: !!p.converter, lc: L.lc,
        finishX: finishX, roll: roll, cruiseThrottle: L.cruiseThr || 0.3, nitrousArmed: !!L.pN2O && L.nitroLeft > 0,
        stageTarget: cfg.venue === 'street' ? -0.25 : null,
        rolloutT: L.roll0 != null ? L.roll0 + (L.roll1 - L.roll0) * clamp((xf - 0.02) / 0.14, 0, 1) : null };
    }

    /* ---------------------------------------------------------- one lane step */
    function stepLane(L) {
      if (!active(L)) return;
      if (L.kind === 'ghost') return stepGhost(L);
      if (L.kind === 'remote') return stepRemote(L);
      var s = L.s, p = L.baseP;
      var raw = L.kind === 'ai' ? L.driver.control(view(L), DT) : (L.inputs || {});
      if (L.kind === 'player' && L.assists.autoStage && !L.left && !roll && (S.phase === 'staging' || S.phase === 'tree' || (S.phase === 'burnout' && !(raw.brake > 0.5 && raw.throttle > 0.5) && L.leftBox))) {
        // auto-stage assist: the stager drives until staged; the player only revs / launches
        if (!L.staged) { var sc = AI().stageControl(view(L), false); raw = Object.assign({}, raw, { throttle: sc.throttle, brake: sc.brake }); }
      }
      var thr = clamp(num(raw.throttle, 0), 0, 1), brk = clamp(num(raw.brake, 0), 0, 1);
      var up = !!raw.shiftUp && !L.prev.shiftUp, down = !!raw.shiftDown && !L.prev.shiftDown;
      L.prev = { shiftUp: !!raw.shiftUp, shiftDown: !!raw.shiftDown };
      var xf = xFront(L);

      // after the finish: lift, brake, chute (automatic shutdown)
      if (L.finished || L.dqStop) {
        var since = S.t - (L.finishedT != null ? L.finishedT : S.t);
        thr = 0; up = down = false;
        brk = since > 1.2 ? clamp((since - 1.2) * 0.4, 0, 0.6) : 0;
        if (s.vx < 3) brk = 1;
      }

      var inp = { throttle: thr, brake: brk, steer: laneSteer(L), shiftUp: false, shiftDown: false };
      var stopped = Math.abs(s.vx) < 0.35;
      var holding = stopped && brk >= 0.5 && !roll;   // held on the brake (also stops the auto reverse-select)
      // roll race: cruise at the rolling speed until the green
      if (roll && !L.left) {
        L.cruiseThr = clamp(0.25 + (dist.fromV - s.vx) * 0.6, 0, 1);
        if (thr >= 0.9 && S.tree.armed && L.kind === 'player') { /* the driver's own throttle */ }
        else inp.throttle = L.cruiseThr;
        inp.brake = 0;
      }
      // staging governor (players): approaching the beams the car only creeps (≤ ~1 m/s at the line)
      if (L.kind === 'player' && !roll && !L.left && !L.staged && xf > -4 && xf < G.STAGE_X && !holding) {
        var cap = 0.9 + (-xf) * 0.55;
        if (s.vx > cap) { inp.throttle = 0; inp.brake = Math.max(inp.brake, clamp((s.vx - cap) * 0.6, 0.15, 0.8)); }
        else inp.throttle = Math.min(inp.throttle, 0.5);
      }
      // creep help before the tree is armed: a slow roll past the beams stops itself at deep stage
      if (!roll && !L.left && !S.tree.armed && xf >= G.ROLLOUT - 0.08 && thr < 0.9) { inp.brake = 1; inp.throttle = Math.min(inp.throttle, 0.05); }

      // burnout in the box: brake + throttle while stopped
      var inBox = s.x >= G.BURNOUT_X0 && s.x <= G.BURNOUT_X1;
      var burning = holding && !L.left && inBox && thr > 0.5 && cfg.venue !== 'street';
      if (burning && !L.burning) emit('burnout-start', L.lane);
      if (!burning && L.burning) emit('burnout-end', L.lane, { temp: L.bo.temp });
      L.burning = burning;
      if (!inBox && s.x > G.BURNOUT_X1) L.leftBox = true;
      var rpmFrac = p.isEV ? 0.8 : clamp((s.rpm - p.idle) / (p.redline - p.idle), 0, 1);
      var wasOver = L.bo.overheated;
      LA().burnout.step(L.bo, DT, { spinning: burning, throttle: thr, rpmFrac: rpmFrac, powerFactor: p.powerKw / 300, gain: surf.burnoutGain, moving: s.vx > 3 });
      if (L.bo.overheated && !wasOver) emit('overheat', L.lane, { temp: L.bo.temp });
      if (burning) L.burnT += DT;

      // held on the brake: the revs follow the throttle (digital keys: climb while held, fall when released)
      if (holding) {
        if (raw.analog || p.converter || p.isEV || L.lc) L.holdThr = thr;
        else L.holdThr = clamp(L.holdThr + (thr > 0.5 ? 0.62 : -1.0) * DT, 0, 1);
        inp.hold = true; inp.throttle = burning ? Math.max(thr, 0.85) : L.holdThr;
        L.held = !L.left;
      } else {
        if (L.held && !L.left && !holding && xf >= G.PRESTAGE_X - 0.3) {
          // release from the hold: the launch takes the held revs
          L.launchRpm = s.rpm; L.launchT = S.t;
          if (!L.lc) L.p = LA().withLaunchRpm(p, s.rpm);
          emit('launch', L.lane, { rpm: s.rpm, inBand: s.rpm >= L.band.lo && s.rpm <= L.band.hi });
        }
        L.held = false;
        if (!stopped || brk < 0.5) L.holdThr = Math.max(0, L.holdThr - 1.5 * DT);
      }

      // manual shifting + grading
      if (up && s.gear >= 1 && s.gear < p.maxGear && !s.shifting) {
        var gr = L.left ? LA().grade(s.rpm, s.gear, p, L.limiterT) : null;
        inp.shiftUp = true;
        if (gr) { L.shifts[gr]++; L.lastShift = { grade: gr, gear: s.gear, rpm: s.rpm, t: S.t }; emit('shift', L.lane, { gear: s.gear + 1, rpm: s.rpm, grade: gr }); emit('bang', L.lane, { gear: s.gear }); }
      }
      if (down) inp.shiftDown = true;

      // N2O (Pro Mod): held button, after the launch, from 2nd gear or 30 m
      var nitro = !!raw.nitrous && !!L.pN2O && L.left && L.nitroLeft > 0 && thr > 0.9 && !L.finished && (s.gear >= 2 || xf > 30);
      if (nitro !== L.nitroOn) emit(nitro ? 'nitrous-on' : 'nitrous-off', L.lane);
      L.nitroOn = nitro;
      if (nitro) L.nitroLeft = Math.max(0, L.nitroLeft - DT);
      var useP = nitro ? Object.assign({}, L.pN2O, { launchRpm: L.p.launchRpm }) : L.p;

      var gearBefore = s.gear;
      var warm = LA().burnout.warm(L.bo);
      if (warm > s.tyreWarm) s.tyreWarm = warm;
      L.env = L.env || { gripMult: 1, wetness: surf.wetness, assists: { autoShift: L.autoShift } };
      L.env.gripMult = surf.grip * (1 + LA().burnout.bonus(L.bo, surf));
      V().step(useP, s, inp, DT, L.env);
      if (s.gear > gearBefore && L.autoShift && L.left) { emit('shift', L.lane, { gear: s.gear, rpm: s.rpm, grade: null, auto: true }); emit('bang', L.lane, { gear: gearBefore }); }
      L.limiterT = s.limiter ? L.limiterT + DT : Math.max(0, L.limiterT - DT * 2);

      // launch feedback (first second)
      if (L.launchT != null && S.t - L.launchT < 1.2) {
        if (!L.spun && s.wheelspin > 0.35 && s.vx > 0.5) { L.spun = true; emit('wheelspin', L.lane, { spin: s.wheelspin }); }
        if (!L.bogged && !p.isEV && S.t - L.launchT > 0.25 && s.rpm < Math.max(p.idle * 1.4, p.peakNmRpm * 0.5) && s.vx < 10) { L.bogged = true; emit('bog', L.lane, { rpm: s.rpm }); }
      }
      postLane(L);
    }

    function laneSteer(L) {
      var s = L.s, yT = ST().laneY(L.lane), v = Math.max(1, Math.abs(s.vx));
      var e = s.y - yT;
      return clamp((-e * 0.25 - s.heading * 2.2 - s.yawRate * 0.25) / (1 + v / 15), -0.4, 0.4);
    }

    function stepGhost(L) {
      var gT = S.tree.armed ? S.tree.greenT[L.lane] : null, x0 = 0.04;
      var g = L.ghost, x;
      if (gT == null || S.t < gT) x = x0;
      else x = Math.max(x0, TM().ghostX(g, S.t - gT));
      L.gv = (x - L.gx) / DT; L.gx = x; L.x = x - L.frontOff;
      if (L.finished) { L.gvSlow = (L.gvSlow == null ? L.gv : L.gvSlow) * Math.exp(-DT / 3); L.gx = L.prevGx + L.gvSlow * DT; L.x = L.gx - L.frontOff; L.gv = L.gvSlow; }
      L.prevGx = L.gx;
      postLane(L);
    }

    function stepRemote(L) {
      var r = L.rs, age = clamp(S.t - L.rsT, 0, 0.25);
      var target = r.xFront + (r.vx || 0) * age;
      // smooth toward the extrapolated position (snaps on big errors)
      var x = Math.abs(target - L.gx) > 8 ? target : L.gx + (target - L.gx) * (1 - Math.exp(-DT / 0.08));
      L.gv = r.vx || 0; L.gx = x; L.x = x - L.frontOff;
      var was = { pre: L.preStaged, st: L.staged, deep: L.deep, left: L.left, fin: L.finished };
      L.preStaged = !!r.preStaged; L.staged = !!r.staged; L.deep = !!r.deep; L.left = !!r.left;
      L.burning = !!r.burnout; L.smoke = num(r.smoke, 0); L.wheelie = num(r.wheelie, 0); L.chute = num(r.chute, 0); L.bo.temp = num(r.tyreTemp, L.bo.temp);
      L.nitroOn = !!r.nitro;
      if (L.staged && !was.st) emit('stage', L.lane);
      if (r.rt != null) L.rt = r.rt;
      if (r.red && !L.red) { L.red = true; TR().foul(S.tree, L.lane, S.t); emit('red', L.lane, { rt: L.rt }); }
      if (r.dq && !L.dq) { L.dq = r.dq; L.finishedT = S.t; }
      if (Array.isArray(r.splits)) r.splits.forEach(function (sp, i) {
        var mine = L.timer.splits[i];
        if (mine && mine.t == null && sp && sp.t != null) { mine.t = sp.t; mine.v = sp.v; emit('split', L.lane, { id: mine.id, t: sp.t, v: sp.v }); }
      });
      if (r.finished && !L.finished) {
        L.finished = true; L.finishedT = S.t; L.timer.finished = true; L.timer.et = r.et; L.timer.trap = r.trap;
        emit('finish', L.lane, { et: r.et, trap: r.trap });
      }
    }

    /** Beams, timing, red lights, trace, visuals. */
    function postLane(L) {
      var xf = xFront(L), v = L.kind === 'ghost' ? L.gv : L.s.vx;
      if (!roll && !L.left) {
        var wasPre = L.preStaged, wasSt = L.staged, wasDeep = L.deep;
        L.preStaged = xf >= G.PRESTAGE_X;
        L.staged = xf >= G.STAGE_X && xf < G.ROLLOUT;
        L.deep = xf >= G.DEEP_X && xf < G.ROLLOUT;
        if (cfg.venue === 'street') { L.preStaged = xf >= -1.2; L.staged = xf >= -0.4 && xf < G.ROLLOUT; L.deep = false; }
        if (L.preStaged && !wasPre) emit('prestage', L.lane);
        if (L.staged && !wasSt) emit('stage', L.lane);
        if (L.deep && !wasDeep) emit('deep', L.lane);
      }
      var news = TM().update(L.timer, S.t, roll ? xf - ROLL_START_X : xf, v);
      if (!L.left && (L.timer.started || (roll && L.kind !== 'ghost' && L.rtT != null))) {
        L.left = true; L.staged = false; L.preStaged = false;
        var tLeave = roll ? L.rtT : L.timer.tLeave;
        if (!S.tree.armed && cfg.treeAuthority !== 'remote') { TR().arm(S.tree, S.t); }
        L.rt = TR().reaction(S.tree, L.lane, tLeave);
        if (L.rt == null || L.rt < 0) { L.red = true; TR().foul(S.tree, L.lane, S.t); emit('red', L.lane, { rt: L.rt }); }
      }
      news.forEach(function (id) { var sp = TM().split(L.timer, id); emit('split', L.lane, { id: id, t: sp.t, v: sp.v }); });
      if (L.timer.finished && !L.finished) {
        L.finished = true; L.finishedT = S.t;
        emit('finish', L.lane, { et: L.timer.et, trap: L.timer.trap });
        if ((L.timer.trap || v) * MPH > 140 && L.kind !== 'ghost') L.chuteAt = S.t + 0.6;
      }
      if (!L.finished && L.left && (xf > finishX + 5 || S.t - (S.tree.greenT[L.lane] || S.t) > 60) && dist.speed) {
        L.dq = 'too slow'; L.dqStop = true; L.finishedT = S.t; emit('dq', L.lane, { reason: L.dq });
      }
      if (L.chuteAt != null && S.t >= L.chuteAt) { if (L.chute === 0) emit('chute', L.lane); L.chute = Math.min(1, L.chute + DT / 0.6); }
      // ghost recording (x from the line at 10 Hz from this lane's green)
      var gT = S.tree.armed ? S.tree.greenT[L.lane] : null;
      if (gT != null && S.t >= gT && L.kind !== 'ghost' && (!L.finished || S.t - L.finishedT < 0.6)) {
        while (L.traceT <= S.t - gT + 1e-9) { L.trace.push(xf); L.traceT += 0.1; }
      }
      // visuals
      if (L.kind !== 'ghost') {
        var s = L.s, p = L.baseP;
        var spin = L.burning ? 1 : clamp(s.wheelspin * 1.6, 0, 1);
        L.smoke = clamp(L.smoke + ((L.burning ? 1 : spin > 0.25 ? spin : 0) - L.smoke) * (1 - Math.exp(-DT / (L.burning ? 0.25 : 0.4))), 0, 1);
        var big = p.layout !== 'fwd' && s.gLong > 0.9 && s.vx < 30 ? clamp((s.gLong - 0.9) / 0.5, 0, 1) : 0;
        L.wheelie += (big - L.wheelie) * (1 - Math.exp(-DT / (big > L.wheelie ? 0.08 : 0.25)));
      }
    }

    /* ---------------------------------------------------------- global step */
    function step() {
      S.t += DT;
      var lanes = S.lanes.filter(active);
      // roll race: player reaction = first full throttle after (or before: red) the green
      if (roll) lanes.forEach(function (L) {
        if (L.kind === 'player' && L.rtT == null && num((L.inputs || {}).throttle, 0) >= 0.9 && S.t > 1.2) L.rtT = S.t;
        if (L.kind === 'ai' && L.rtT == null && S.tree.armed && S.t >= S.tree.greenT[L.lane] + L.driver.plan.rt * 0.6 + 0.12) L.rtT = S.t;
        if (L.rtT != null && !L.timer.started) TM().startAt(L.timer, Math.max(L.rtT, S.tree.greenT[L.lane]));
      });
      lanes.forEach(stepLane);
      if (roll) lanes.forEach(function (L) { if (L.left && L.kind !== 'ghost' && S.tree.greenT[L.lane] != null && L.timer.tStart > S.tree.greenT[L.lane]) L.timer.tStart = S.tree.greenT[L.lane]; });
      // phases
      if (!roll) {
        var allStaged = lanes.every(function (L) { return L.staged || L.left; });
        var anyBox = lanes.some(function (L) { return !L.left && xFront(L) < G.BURNOUT_X1 + 2; });
        if (!S.tree.armed) {
          if (cfg.treeAuthority !== 'remote' && allStaged && lanes.every(function (L) { return puppet(L) || Math.abs(L.s.vx) < 0.3; })) {
            S.stagedT = S.stagedT == null ? S.t : S.stagedT;
            if (S.t - S.stagedT > 0.35) { TR().arm(S.tree, S.t); emit('tree', null, { greenT: S.tree.greenT.slice() }); }
          } else S.stagedT = null;
          S.phase = S.tree.armed ? 'tree' : anyBox ? 'burnout' : 'staging';
        } else if (S.phase === 'burnout' || S.phase === 'staging') S.phase = 'tree';
      }
      if (S.tree.armed) {
        // amber / green events
        lanes.forEach(function (L) {
          var g = S.tree.greenT[L.lane];
          if (!L.amberEv && S.tree.type !== 'flag' && S.t >= TR().amberT(S.tree, L.lane, 0)) { L.amberEv = true; emit('amber', L.lane); }
          if (!L.greenEv && S.t >= g) { L.greenEv = true; if (!L.red) emit('green', L.lane); }
        });
        if (S.phase === 'tree' && lanes.every(function (L) { return S.t >= S.tree.greenT[L.lane] || L.left; })) S.phase = 'run';
        if (S.phase === 'run' || S.phase === 'tree') {
          var resolved = lanes.every(function (L) { return L.finished || L.dq || (L.red && L.left && lanes.length > 1 && otherDone(L)); });
          if (S.decision == null && resolved) decideNow();
        }
      }
      if (S.decision && S.phase !== 'done') {
        S.phase = 'shutdown';
        var slow = lanes.every(function (L) { return puppet(L) || L.s.vx < 12; });
        if (S.t - S.decidedT > (slow ? 2.5 : 7)) { S.phase = 'done'; S.doneT = S.t; }
      }
      // hard cap
      if (S.t > 180 && S.phase !== 'done') { if (!S.decision) decideNow(); S.phase = 'done'; }
    }
    function otherDone(L) { var o = S.lanes[1 - L.lane]; return !active(o) || o.finished || o.dq || o.red; }
    function laneResult(L) {
      if (!active(L)) return { none: true };
      return { rt: L.rt, et: L.timer.et, red: L.red, redT: S.tree.redT[L.lane], dq: L.dq, finished: L.finished, dial: L.dial };
    }
    function decideNow() {
      var a = laneResult(S.lanes[0]), b = laneResult(S.lanes[1]);
      if (roll) { if (a.rt != null) a = Object.assign({}, a, { rt: 0 }); if (b.rt != null) b = Object.assign({}, b, { rt: 0 }); }
      var d = TR().decide(a.none ? b : a, a.none ? null : b.none ? null : b, { bracket: cfg.bracket });
      if (a.none && d.winner === 0) d.winner = 1;
      S.decision = d; S.decidedT = S.t;
      emit('win', d.winner, { winner: d.winner, reason: d.reason, margin_s: d.margin_s, holeshot: d.holeshot });
    }

    /* ---------------------------------------------------------- snapshot / results */
    function laneSnap(L) {
      if (!active(L)) return { lane: L.lane, kind: 'none' };
      var ghost = puppet(L), rs = L.kind === 'remote' ? L.rs : null, s = L.s, p = ghost ? L.p : L.baseP;
      var x = ghost ? L.x : s.x, xf = xFront(L), vx = ghost ? L.gv : s.vx;
      var rpm = rs ? num(rs.rpm, p.idle) : ghost ? p.idle + (p.redline - p.idle) * clamp(0.35 + (vx % 15) / 25, 0, 0.95) : s.rpm, gear = rs ? num(rs.gear, 1) : ghost ? 1 : s.gear;
      var sl = ghost ? { level: 0, flash: false, target: null } : LA().shiftLight(rpm, gear, p);
      var drvR = p.layout === 'fwd' ? p.radiusF : p.radiusR;
      return {
        lane: L.lane, kind: L.kind, name: L.name, carName: L.carName, color: L.color, build: L.build, modelId: L.modelId, isPlayer: L.isPlayer,
        x: x, y: ghost ? L.y : s.y, z: 0, heading: ghost ? 0 : s.heading, pitch: ghost ? 0 : clamp(-(s.gLong || 0) * 0.012, -0.03, 0.03) + L.wheelie * 0.09, roll: 0,
        vx: vx, speed: Math.abs(vx), xFront: xf, rpm: rpm, idle: p.idle, redline: p.redline, gear: gear, maxGear: p.maxGear, autoShift: !!L.autoShift,
        throttle: rs ? num(rs.throttle, 0) : ghost ? (L.left ? 1 : 0) : s.throttle, brake: rs ? num(rs.brake, 0) : ghost ? 0 : s.brake, wheelspin: rs ? num(rs.wheelspin, 0) : ghost ? 0 : s.wheelspin,
        wheelOmega: ghost ? vx / drvR : (L.burning ? Math.max(60, s.rpm / 60 * 2 * Math.PI / Math.max(1, V().gearRatio(p, 1))) : (s.wheels[p.layout === 'fwd' ? 0 : 2] || {}).omega || 0),
        smoke: rs ? L.smoke : ghost ? 0 : L.smoke, burnout: !!L.burning, tyreTemp: L.bo.temp, tyreLabel: LA().burnout.label(L.bo), gripBonus: LA().burnout.bonus(L.bo, surf),
        preStaged: L.preStaged, staged: L.staged, deep: L.deep, left: L.left, red: L.red, rt: L.rt, et: L.timer.et, trap: L.timer.trap,
        splits: L.timer.splits.map(function (x) { return { id: x.id, label: x.label, t: x.t, v: x.v }; }),
        finished: L.finished, finishT: L.finishedT, dq: L.dq,
        launch: { held: !!L.held, rpm: L.launchRpm != null && L.left ? L.launchRpm : rpm, lo: L.band ? L.band.lo : 0, hi: L.band ? L.band.hi : 0, best: L.band ? L.band.best : 0,
          ev: !!p.isEV, lc: !!L.lc, converter: !!p.converter, holdThr: L.holdThr || 0 },
        shiftLight: { level: sl.level, flash: sl.flash }, shiftRpm: sl.target, lastShift: L.lastShift, shifts: Object.assign({}, L.shifts || {}),
        limiter: ghost ? false : !!s.limiter, boost: ghost ? 0 : s.boost || 0,
        nitrous: { armed: !!L.pN2O, active: !!L.nitroOn, left_s: L.nitroLeft, shot_hp: L.pN2O ? num(L.entry.nitrous_hp, 0) : 0 },
        chute: L.chute, wheelie: L.wheelie, dial: L.dial, gLong: ghost ? 0 : s.gLong || 0, layout: p.layout, frontOff: L.frontOff,
        length: p.length || 4.6
      };
    }
    function snapshot() {
      var ev = S.events; S.events = [];
      var tr = S.tree;
      return {
        t: S.t, phase: S.phase, venue: cfg.venue, night: !!cfg.night, surface: surf.id, distance: dist, finishX: finishX, treeType: tr.type,
        bracket: !!cfg.bracket, roll: roll,
        tree: { armed: tr.armed, startT: tr.startT, greenT: tr.greenT.slice(), flag: TR().flagState(tr, S.t),
          lanes: S.lanes.map(function (L) { return active(L) ? TR().lights(tr, S.t, L.lane, { preStaged: L.preStaged && !L.left, staged: L.staged && !L.left, deep: L.deep && !L.left }) : { preStage: false, stage: false, amber: [false, false, false], green: false, red: false }; }) },
        lanes: S.lanes.map(laneSnap), playerLane: cfg.playerLane, winner: S.decision ? S.decision.winner : null, decision: S.decision, events: ev
      };
    }
    function results() {
      var d = S.decision || { winner: null, reason: 'none', margin_s: null, holeshot: false };
      var out = { distance: dist.id, distanceName: dist.name, winner: d.winner, reason: d.reason, margin_s: d.margin_s, holeshot: d.holeshot,
        bracket: !!cfg.bracket, venue: cfg.venue, surface: surf.id, treeType: S.tree.type, roll: roll, lanes: [] };
      S.lanes.forEach(function (L) {
        if (!active(L)) { out.lanes.push({ kind: 'none' }); return; }
        out.lanes.push({ lane: L.lane, kind: L.kind, name: L.name, carName: L.carName, modelId: L.modelId, color: L.color, isPlayer: L.isPlayer,
          rt: L.rt, et: L.timer.et, trap: L.timer.trap, splits: L.timer.splits.map(function (x) { return { id: x.id, label: x.label, t: x.t, v: x.v }; }),
          red: L.red, dq: L.dq, breakout: !!(cfg.bracket && L.dial != null && L.timer.et != null && L.timer.et < L.dial), dial: L.dial,
          won: d.winner === L.lane, shifts: Object.assign({ perfect: 0, good: 0, early: 0, late: 0 }, L.shifts || {}),
          burnout: { temp: L.bo.temp, bonus: LA().burnout.bonus(L.bo, surf), time: L.burnT || 0 },
          launch: { rpm: L.launchRpm, lo: L.band ? L.band.lo : null, hi: L.band ? L.band.hi : null, lc: !!L.lc, ev: !!(L.baseP && L.baseP.isEV), bog: !!L.bogged, spin: !!L.spun },
          nitrous_hp: L.pN2O ? num(L.entry.nitrous_hp, 0) : 0 });
      });
      // margin in feet at the finish (winner's trap speed × time margin)
      if (d.margin_s != null && d.winner != null && out.lanes[d.winner] && out.lanes[d.winner].trap) out.marginFt = d.margin_s * out.lanes[d.winner].trap / 0.3048;
      return out;
    }

    init();
    var acc = 0;
    var api = {
      cfg: cfg,
      update: function (dtReal, input) {
        if (input) api.setLaneInput(cfg.playerLane, input);
        acc += clamp(num(dtReal, 0), 0, 0.25);
        var n = 0;
        while (acc >= DT && n < MAX_STEPS) { step(); acc -= DT; n++; }
        if (n >= MAX_STEPS) acc = Math.min(acc, DT);
        return n;
      },
      step: step,
      setLaneInput: function (lane, input) { var L = S.lanes[lane]; if (L && active(L)) L.inputs = input || {}; },
      /** Networked opponent state (js/net/netdrag.js): { xFront, vx, rpm, gear, throttle, brake, wheelspin, smoke, burnout, tyreTemp,
       *  preStaged, staged, deep, left, red, rt, splits, finished, et, trap, dq, wheelie, chute, nitro }. */
      setRemote: function (lane, st) { var L = S.lanes[lane]; if (L && L.kind === 'remote' && st) { L.rs = st; L.rsT = S.t; } },
      /** The host's tree (treeAuthority 'remote'): times relative to now (s). */
      setTree: function (o) {
        if (!o || S.tree.armed) return;
        S.tree.armed = true; S.tree.armT = S.t; S.tree.startT = S.t + num(o.startIn, 0);
        S.tree.greenT = [S.t + num(o.greenIn && o.greenIn[0], 1), S.t + num(o.greenIn && o.greenIn[1], 1)];
        S.phase = 'tree'; emit('tree', null, { greenT: S.tree.greenT.slice() });
      },
      /** Tree timing relative to now (for the host to send). */
      treeRel: function () { return S.tree.armed ? { startIn: S.tree.startT - S.t, greenIn: [S.tree.greenT[0] - S.t, S.tree.greenT[1] - S.t] } : null; },
      /** Packet of a locally simulated lane (the inverse of setRemote). */
      netState: function (lane) {
        var L = S.lanes[lane]; if (!L || !active(L) || puppet(L)) return null;
        var s = L.s, r3 = function (v) { return v == null ? null : Math.round(v * 1000) / 1000; };
        return { xFront: r3(xFront(L)), vx: r3(s.vx), rpm: Math.round(s.rpm), gear: s.gear, throttle: r3(s.throttle), brake: r3(s.brake), wheelspin: r3(s.wheelspin),
          smoke: r3(L.smoke), burnout: !!L.burning, tyreTemp: Math.round(L.bo.temp), preStaged: L.preStaged, staged: L.staged, deep: L.deep, left: L.left,
          red: L.red, rt: r3(L.rt), splits: L.timer.splits.map(function (x) { return x.t == null ? null : { t: r3(x.t), v: r3(x.v) }; }),
          finished: L.finished, et: r3(L.timer.et), trap: r3(L.timer.trap), dq: L.dq, wheelie: r3(L.wheelie), chute: r3(L.chute), nitro: !!L.nitroOn };
      },
      /** Force the decision (the host's, on a guest). */
      setDecision: function (d) { if (d) { S.decision = d; S.decidedT = S.decidedT == null ? S.t : S.decidedT; } },
      snapshot: snapshot, results: results,
      restart: function () { init(); acc = 0; },
      destroy: function () { S = null; },
      lane: function (i) { return S.lanes[i]; },
      phase: function () { return S.phase; },
      time: function () { return S.t; },
      tree: function () { return S.tree; },
      view: function (i) { return view(S.lanes[i]); },
      /** Ghost run of a lane (for encodeGhost), after it finished. */
      ghostRun: function (i) {
        var L = S.lanes[i]; if (!L || !L.finished || L.kind === 'ghost') return null;
        return { name: L.name, carName: L.carName, modelId: L.modelId, color: L.color, distanceId: dist.id, rt: L.rt, et: L.timer.et, trap: L.timer.trap, trace: L.trace.slice() };
      },
      DT: DT
    };
    return api;
  }

  /** Headless run (all lanes AI / ghost / none) -> results. */
  function simulate(cfg, opts) {
    opts = opts || {};
    var s = create(cfg), guard = 0, maxSteps = (opts.maxTime_s || 120) / DT;
    while (s.phase() !== 'done' && guard++ < maxSteps) { s.step(); if (guard % 240 === 0) s.snapshot(); }
    var r = s.results(); s.destroy();
    return r;
  }

  CB.drag.session = { create: create, simulate: simulate, DT: DT };
})();

if (typeof module !== 'undefined') module.exports = CB.drag.session;

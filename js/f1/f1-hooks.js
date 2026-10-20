/* ==========================================================================
   Redline — js/f1/f1-hooks.js
   CB.f1.hooks : the CB.race.engine hook object that turns an engine session into an F1 session
   (docs/F1-SPEC.md §4). Pure logic, no DOM, Node-loadable. Deterministic (seeded; no Math.random).

     var H = CB.f1.hooks.create(opts)   opts {
         circuit | track (def) | trackId, meta (CB.f1.circuits.meta(def); derived from the geometry when missing),
         mode 'race'|'qualifying'|'practice' (engine 'time-trial' = qualifying), weather 'dry'|'damp'|'wet', laps,
         playerTeam, playerNumber, playerName, seed, assists { abs, tc, autoShift, ersAuto },
         tyreStart { [carId | 'player' | 'default']: compound }, wearMult (≥1 scales wear for short races),
         requireTwoCompounds (dry races: two dry compounds or +10 s), trackTemp_c, collisionPenalties (bool) }
     cfg.hooks = [H]   (engine hooks used: carCreated, preStep, vehicleParams, vehicleEnv, postStep, snapshot, pitStop,
                        pitBox, advice, wrapDriver)
     H.setPlayerControls({ drs (bool: pressed / held), ersBoost (bool, held), ersMode 'auto'|'boost'|'harvest',
                           cycleErs (edge), pitCompound 'soft'|... })
     H.drainMessages() -> [{ t, kind 'drs'|'flag'|'penalty'|'radio'|'pit'|'info', text, carId, player? }]
     H.state() -> { meta, mode, cars: { id: car.f1 }, drsEnabled, messages (pending count) }
     H.attach(session)                 optional: lets the hooks read session.pitInfo() / geom
     H.carF1(car) -> the per-car F1 state

   Snapshot cars gain endurance.f1 = { team, teamName, number, driver, compound, letter, tyreWear [4], tyreTemp [4],
     avgWear, tyreAge, compoundsUsed [], drs { zone, eligible, open, available }, ers { soc, mode, deploying, harvesting },
     pitLimiter, inPitLane, pitStops, pitCompound, blueFlag, yellow, penalties_s, warnings, livery }.

   Pit lane: a car that has a pit request (engine requestPit / player input.pit / strategy advice) is driven by these
   hooks from ~250 m before the pit entry: it moves onto the pit lane (meta.pit.side · offset_m), slows to the limiter
   (80 km/h, Monaco 60), stops in its team box (pitBox hook), gets new tyres (pitStop hook, ≈ 2.5 s stationary) and
   accelerates out, blending back onto the circuit after the exit. The player is auto-driven in the lane.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.f1 = CB.f1 || {};

(function () {
  'use strict';

  var TAU = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function wrapS(s, L) { s = s % L; return s < 0 ? s + L : s; }
  function wrapAngle(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
  function smooth(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function mulberry(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function req(rel) { if (typeof require === 'function') { try { return require(rel); } catch (e) { /* ignore */ } } return null; }
  function F() { return CB.f1.car || req('./f1-car.js'); }
  function TM() { return CB.f1.teams || req('./f1-teams.js'); }
  function TR() { return (CB.race && CB.race.tracks) || req('../race/tracks.js'); }
  function VEH() { return CB.race && CB.race.vehicle; }

  var MODES = { race: 'race', qualifying: 'qualifying', quali: 'qualifying', 'time-trial': 'qualifying', practice: 'practice' };
  var WETNESS = { dry: 0, damp: 0.5, wet: 1 };

  /* ---------------------------------------------------------------- meta */
  /** Derived F1 metadata for circuits without CB.f1.circuits meta (any CB.race.tracks geometry). */
  function deriveMeta(geom, def) {
    var L = geom.length, S = geom.samples, N = S.length, ds = L / N;
    // straights = runs of low curvature; DRS on the two longest (>= 350 m)
    var runs = [], i0 = -1;
    for (var k = 0; k <= N * 2; k++) {
      var i = k % N, straight = Math.abs(num(S[i].curvature, 0)) < 1 / 700;
      if (straight && i0 < 0) i0 = k;
      if ((!straight || k === N * 2) && i0 >= 0) {
        if (i0 < N) runs.push({ a: i0 * ds, len: (k - i0) * ds });
        i0 = -1;
      }
    }
    runs = runs.filter(function (r) { return r.len < L * 0.9; }).sort(function (a, b) { return b.len - a.len; });
    var used = [], zones = [];
    runs.forEach(function (r) {
      if (zones.length >= 2 || r.len < 350) return;
      var st = r.a + 40;
      if (used.some(function (u) { return Math.abs(wrapS(u - st + L / 2, L) - L / 2) < 300; })) return;
      used.push(st);
      zones.push({ detect_s: wrapS(st - 180, L), start_s: wrapS(st, L), end_s: wrapS(r.a + r.len - 90, L) });
    });
    var info = null, ENDU = CB.game && CB.game.endurance;
    if (def && isNum(def.pitEntry_s) && isNum(def.pitExit_s)) info = { entry_s: def.pitEntry_s, exit_s: def.pitExit_s };
    else if (ENDU && typeof ENDU.pitLaneInfo === 'function') { try { info = ENDU.pitLaneInfo({ length_m: L, def: def, samples: S }); } catch (e) { info = null; } }
    if (!info) { var len = clamp(L * 0.07, 250, 550); info = { entry_s: L - len * 0.6, exit_s: len * 0.4 }; }
    var laneLen = wrapS(info.exit_s - info.entry_s, L);
    var hw = num(def && def.width_m, num(geom.width_m, 12)) / 2;
    var box0 = wrapS(info.entry_s + laneLen * 0.3, L), spacing = Math.min(14, laneLen * 0.45 / 11);
    return {
      length_m: L, derived: true,
      drs: zones,
      sectors_s: [L / 3, 2 * L / 3],
      pit: { side: -1, entry_s: info.entry_s, exit_s: info.exit_s, offset_m: hw + 6, width_m: 8, speedLimit_ms: 80 / 3.6,
        box0_s: box0, boxSpacing_m: spacing, box_s: function (ti) { return wrapS(box0 + clamp(num(ti, 0), 0, 10) * spacing, L); } },
      real: null
    };
  }
  function normaliseMeta(m, geom) {
    if (!m) return null;
    var L = num(m.length_m, geom.length);
    var pit = m.pit || {};
    if (typeof pit.box_s !== 'function') {
      var b0 = num(pit.box0_s, isNum(pit.box_s) ? pit.box_s : wrapS(num(pit.entry_s, L - 200) + 80, L)), sp = num(pit.boxSpacing_m, 12);
      pit = Object.assign({}, pit, { box_s: function (ti) { return wrapS(b0 + clamp(num(ti, 0), 0, 10) * sp, L); } });
    }
    if (!isNum(pit.speedLimit_ms)) pit.speedLimit_ms = num(pit.speedLimit_kph, 80) / 3.6;
    if (!isNum(pit.side)) pit.side = -1;
    if (!isNum(pit.offset_m)) pit.offset_m = num(geom.width_m, 12) / 2 + 6;
    return Object.assign({}, m, { length_m: L, pit: pit, drs: Array.isArray(m.drs) ? m.drs : [] });
  }

  /* ---------------------------------------------------------------- create */
  function create(opts) {
    opts = opts || {};
    var C = F(), T = TM(), Tr = TR();
    var mode = MODES[opts.mode] || 'race';
    var weather = WETNESS[opts.weather] != null ? opts.weather : 'dry';
    var wetness = WETNESS[weather];
    var rng = mulberry((num(opts.seed, 1) ^ 0xF1F1) >>> 0);
    var def = opts.circuit || opts.track || (opts.trackId && Tr && Tr.get ? Tr.get(opts.trackId) : null);
    var geom = null, meta = null, session = null;
    var wearMult = Math.max(0.2, num(opts.wearMult, 1));
    var playerCtl = { drs: false, drsEdge: false, ersBoost: false, ersMode: null, cycleErs: false, pitCompound: null };
    var msgs = [], carsById = {}, teamIdx = {}, firstCar = null, drsLog = [];
    if (T) T.list.forEach(function (t, i) { teamIdx[t.id] = i; });
    var detect = [];   // per DRS zone: { carId: last crossing time }
    var drsEnabledSent = false, lapsTotal = num(opts.laps, 0);

    function ensureGeom(car) {
      if (geom) return geom;
      if (car && car.ctx && car.ctx.geom) geom = car.ctx.geom;
      if (!geom && session && session.geom) geom = session.geom;
      if (!geom && def && Tr) geom = Tr.build(def);
      if (geom && !meta) {
        var m = opts.meta || null;
        if (!m && def && CB.f1.circuits && typeof CB.f1.circuits.meta === 'function') { try { m = CB.f1.circuits.meta(def); } catch (e) { m = null; } }
        meta = normaliseMeta(m, geom) || deriveMeta(geom, def || geom.def);
        detect = meta.drs.map(function () { return {}; });
      }
      return geom;
    }
    function msg(kind, text, car, extra) {
      var m = { t: car && car.ctx ? Math.round(car.ctx.t * 100) / 100 : 0, kind: kind, text: text, carId: car ? car.id : null, player: !!(car && car.isPlayer) };
      if (extra) Object.assign(m, extra);
      msgs.push(m);
      if (msgs.length > 200) msgs.splice(0, msgs.length - 200);
    }
    function short(car) { return car.f1 ? car.f1.short : (car.name || car.id); }

    function startCompound(car) {
      var ts = opts.tyreStart || {};
      var c = ts[car.id] || (car.isPlayer ? ts.player : null) || (car.entrant && car.entrant.f1 && car.entrant.f1.compound) || ts['default'];
      if (C.COMPOUNDS[c]) return c;
      if (wetness >= 0.75) return 'wet';
      if (wetness >= 0.4) return 'inter';
      if (mode !== 'race') return 'soft';
      // race default: a spread of starting compounds (deterministic per car)
      var h = 0, id = String(car.id);
      for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
      return ['medium', 'medium', 'soft', 'hard'][h % 4];
    }

    /* ---------------- carCreated: every car becomes the spec F1 car ---------------- */
    function carCreated(car) {
      ensureGeom(car);
      var V = VEH();
      var en = car.entrant || {}, ef = en.f1 || {};
      var teamId = car.isPlayer ? (opts.playerTeam || ef.teamId) : (ef.teamId || (en.build && en.build.f1 && en.build.f1.teamId));
      var team = T && T.get(teamId) ? T.get(teamId) : (T ? T.list[car.idx % T.list.length] : null);
      var seat = car.isPlayer ? 0 : (ef.seat === 1 ? 1 : ef.seat === 0 ? 0 : car.idx % 2);
      var number = car.isPlayer ? (opts.playerNumber != null ? opts.playerNumber : (ef.number || (team && team.drivers[0].number) || car.number)) : (ef.number || en.number || car.number);
      var driver = car.isPlayer ? (opts.playerName || car.name) : (ef.driver || en.name || car.name);
      var build = T && team ? T.buildFor(team.id, { seat: seat, number: number, driverName: driver, isPlayer: car.isPlayer }) : car.build;
      var p = C.params();
      var auto = car.state && car.state.autoShift != null ? car.state.autoShift : true;
      car.params = p;
      if (V && typeof V.createState === 'function') car.state = V.createState(p, { x: car.state.x, y: car.state.y, heading: car.state.heading, speed: 0 }, { autoShift: auto });
      car.build = build; car.bodyStyle = 'f1';
      car.length_m = C.SPEC.length_m; car.width_m = C.SPEC.width_m; car.halfL = car.length_m / 2; car.halfW = car.width_m / 2;
      car.mass = p.mass; car.Iz = p.Iz; car.axA = p.a; car.axB = p.b; car.halfTrack = p.track / 2; car.redline = p.redline; car.maxGear = p.maxGear;
      if (team) {
        car.color = team.livery.primary; car.accent = team.livery.secondary;
        car.team = team.name; car.number = String(number);
        if (!car.isPlayer) car.name = driver;
      }
      var comp = startCompound(car);
      car.f1 = {
        teamId: team ? team.id : null, teamName: team ? team.name : '', teamIndex: team ? teamIdx[team.id] : car.idx % 11,
        seat: seat, number: String(number), driver: driver, short: (build && build.f1 && build.f1.driverShort && !car.isPlayer) ? build.f1.driverShort : String(driver).slice(0, 3).toUpperCase(),
        livery: team ? team.livery : null,
        tyres: C.createTyres(comp, { wearMult: wearMult, trackTemp_c: num(opts.trackTemp_c, 35 - wetness * 12), temp_c: wetness > 0.4 ? 55 : undefined }),
        compoundsUsed: [comp], ers: C.ers.create({ soc: 0.9 }),
        drs: { zone: -1, eligible: meta ? meta.drs.map(function () { return false; }) : [], open: false, available: false },
        lastLap: car.tracker ? car.tracker.lap : 0, pitCompound: null, lane: null, rejoin: null,
        blueFlag: false, yellow: false, warnings: 0, lastTl: 0, lastPen: 0, aiDrs: true, compoundPenalty: false,
        lastSector: -1, lastBlueMsg: -100
      };
      carsById[car.id] = car;
      if (!firstCar) firstCar = car;
    }

    /* ---------------- pit-lane driving ---------------- */
    /** Fast lane (track side of the pit lane) and box lane (garage side): a stopped car never blocks the cars passing. */
    function laneLat() { var P = meta.pit, w = num(P.width_m, 8); return P.side * (P.offset_m - w / 4); }
    function boxLat() { var P = meta.pit, w = num(P.width_m, 8); return P.side * (P.offset_m + w / 4); }
    /** Keep a gap to a car ahead in the lane (queues in the pit lane). */
    function followCap(car, vT) {
      var nb = car.ctx && car.ctx.nearby;
      if (!nb) return vT;
      for (var i = 0; i < nb.length; i++) {
        var o = nb[i];
        if (o.ahead > 0 && o.ahead < 35 && Math.abs(o.side) < 2.3) vT = Math.min(vT, Math.max(0, o.speed + (o.ahead - 9) * 0.7));
      }
      return vT;
    }
    function steerTo(car, lat, look) {
      var g = geom, st = car.state, v = Math.abs(num(st.vx, 0));
      var Ld = Math.max(7, (look || 0.9) * v + 5);
      var P = Tr.pointAt(g, car.lapS + Ld, lat);
      var dx = P.x - st.x, dy = P.y - st.y, c = Math.cos(st.heading), s = Math.sin(st.heading);
      var lx = dx * c + dy * s, ly = -dx * s + dy * c;
      var alpha = Math.atan2(ly, Math.max(0.5, lx));
      var p = car.params, delta = Math.atan(2 * p.wheelbase * Math.sin(alpha) / Ld);
      // the vehicle's speed-sensitive rack limit (CB.race.vehicle substep)
      var lim = p.lockAngle / (1 + Math.pow(v / 21, 1.6));
      var lat_ = VEH() && VEH().latAccelAt ? VEH().latAccelAt(p, v, 1) : 20;
      var phys = v > 1 ? Math.atan(p.wheelbase * lat_ / (v * v)) + Math.atan(p.tanAlphaPeakF) * 1.25 : p.lockAngle;
      var maxSteer = clamp(Math.max(lim, Math.min(phys, p.lockAngle)), 0.045, p.lockAngle);
      return clamp(delta / maxSteer, -1, 1);
    }
    function speedTo(car, vT, inp) {
      var v = Math.abs(num(car.state.vx, 0)), e = vT - v;
      inp.throttle = e > 0 ? clamp01(0.25 + e * 0.35) : 0;
      inp.brake = e < -0.6 ? clamp01(-e * 0.18) : 0;
      return inp;
    }
    /** Returns a replacement input while the car is in a pit-lane phase, else null. */
    function pitDrive(car, inp, ph) {
      var f = car.f1, L = geom.length, s = car.lapS, P = meta.pit, vLim = P.speedLimit_ms;
      var lapsLeft = lapsTotal ? lapsTotal - car.tracker.lap : 99;
      var boxS = P.box_s(f.teamIndex);
      var dEntry = wrapS(P.entry_s - s, L);
      var out = null;
      if (car.pitPhase === 'stopped' || car.frozenUntil > car.ctx.t) return null;
      if (!car.pitPhase && car.pitRequest && ph === 'racing' && dEntry < 260 && !(mode === 'race' && lapsLeft <= 1)) {
        if (!f.lane) f.lane = { lat0: car.lateral };
        var u = 1 - dEntry / 260;
        var lat = f.lane.lat0 + (laneLat() - f.lane.lat0) * smooth((u - 0.15) / 0.85);
        out = { throttle: 0, brake: 0, steer: steerTo(car, lat), handbrake: false };
        speedTo(car, followCap(car, Math.sqrt(vLim * vLim + 2 * 16 * Math.max(0, dEntry - 10))), out);
        // the driver (AI / autopilot / player) still owns the corners before the entry: never faster than it asks
        if (inp) { out.throttle = Math.min(out.throttle, clamp01(num(inp.throttle, 0))); out.brake = Math.max(out.brake, clamp01(num(inp.brake, 0))); }
      } else if (car.pitPhase === 'lane') {
        var dBox = wrapS(boxS - s, L);
        if (dBox > L / 2) dBox = 0;
        var latL = laneLat() + (boxLat() - laneLat()) * smooth(1 - (dBox - 6) / 40);
        out = { throttle: 0, brake: 0, steer: steerTo(car, latL, 0.6), handbrake: false };
        speedTo(car, followCap(car, Math.min(vLim, 1.2 + Math.sqrt(2 * 9 * Math.max(0, dBox - 0.3)))), out);
        f.lane = f.lane || { lat0: laneLat() };
      } else if (car.pitPhase === 'exit') {
        if (!f.boxOut) f.boxOut = s;
        var latX = boxLat() + (laneLat() - boxLat()) * smooth(wrapS(s - f.boxOut, L) / 35);
        out = { throttle: 0, brake: 0, steer: steerTo(car, latX, 0.6), handbrake: false };
        speedTo(car, followCap(car, vLim), out);
        f.rejoin = { s0: P.exit_s };
      } else if (f.rejoin) {
        var d = wrapS(s - f.rejoin.s0, L);
        if (d > 220 || d > L / 2) { f.rejoin = null; f.lane = null; f.boxOut = null; car.pitLaneDrive = false; return null; }
        var latR = laneLat() * (1 - smooth(d / 200));
        out = { throttle: inp ? clamp01(num(inp.throttle, 1)) : 1, brake: inp ? clamp01(num(inp.brake, 0)) : 0, steer: steerTo(car, latR), handbrake: false };   // pedals stay the driver's (a corner may follow the exit)
      } else if (f.lane && !car.pitRequest) f.lane = null;
      car.pitLaneDrive = !!out || !!car.pitPhase;   // engine: no track-limits excursion while entering / leaving the lane
      if (out) { out.shiftUp = false; out.shiftDown = false; if (inp && inp.pit) out.pit = false; }
      return out;
    }

    /* ---------------- preStep: DRS / ERS / limiter / pit lane ---------------- */
    function preStep(car, inp) {
      var f = car.f1; if (!f || !inp) return inp;
      ensureGeom(car);
      var ctx = car.ctx || {}, ph = ctx.phase;
      if (isNum(ctx.lapsTotal)) lapsTotal = ctx.lapsTotal;
      if (!meta) return inp;
      if (ph === 'grid' || ph === 'countdown' || inp.hold) return inp;
      var pd = pitDrive(car, inp, ph);
      if (pd) inp = pd;
      // pit limiter (also for a player who drives in the lane himself)
      if (car.pitPhase === 'lane' || car.pitPhase === 'exit') {
        var v = Math.abs(num(car.state.vx, 0)), vL = meta.pit.speedLimit_ms;
        if (v > vL - 0.3) inp = Object.assign({}, inp, { throttle: Math.min(inp.throttle, v > vL ? 0 : 0.3) });
        if (v > vL + 1.5) inp = Object.assign({}, inp, { brake: Math.max(inp.brake || 0, 0.4) });
      }
      // DRS open / close
      var d = f.drs;
      if (d.open && ((inp.brake || 0) > 0.05 || d.zone < 0 || car.pitPhase)) { d.open = false; }
      if (!d.open && d.available && !car.pitPhase && (inp.brake || 0) <= 0.05) {
        var want = car.isPlayer && !car.autopilotActive ? (playerCtl.drs || playerCtl.drsEdge || (opts.assists && opts.assists.autoDrs)) : (f.aiDrs !== false && inp.throttle > 0.8);
        if (want) { d.open = true; d.uses = (d.uses || 0) + 1; }
      }
      if (car.isPlayer) playerCtl.drsEdge = false;
      return inp;
    }

    function vehicleParams(car) {
      var f = car.f1; if (!f) return null;
      return C.variant(f.drs.open, f.ers.deploying);
    }
    function vehicleEnv(car, env) {
      var f = car.f1; if (!f) return env;
      var e = Object.assign({}, env);
      e.wheelGrip = C.tyreGrip(f.tyres, num(env.wetness, wetness));
      return e;
    }

    /* ---------------- postStep: tyres, ERS, DRS detection, flags, race control ---------------- */
    function passed(prev, cur, mark, L) { var d0 = wrapS(mark - prev, L), d1 = wrapS(cur - prev, L); return d1 < L / 2 && d0 <= d1 && d1 > 0; }
    function postStep(car, dt) {
      var f = car.f1; if (!f) return;
      ensureGeom(car);
      if (!meta) return;
      if (f.drs.eligible.length !== meta.drs.length) f.drs.eligible = meta.drs.map(function () { return false; });
      var ctx = car.ctx || {}, t = num(ctx.t, 0), st = car.state, L = geom.length;
      var racing = ctx.phase === 'racing';
      var wetE = num(ctx.env && ctx.env.wetness, wetness);
      if (car.pitPhase !== 'stopped') C.stepTyres(f.tyres, st, dt, { wetness: wetE });
      // lap bookkeeping
      var lapNow = car.tracker ? car.tracker.lap : 0, lapStart = false;
      if (lapNow !== f.lastLap) { lapStart = true; f.lastLap = lapNow; f.tyres.age++; onLap(car, lapNow); }
      // ERS
      var es = f.ers;
      if (car.isPlayer) {
        if (playerCtl.ersMode && C.ers.MODES.indexOf(playerCtl.ersMode) >= 0) es.mode = playerCtl.ersMode;
        if (playerCtl.cycleErs) { es.mode = C.ers.MODES[(C.ers.MODES.indexOf(es.mode) + 1) % C.ers.MODES.length]; playerCtl.cycleErs = false; msg('info', 'ERS mode: ' + es.mode.toUpperCase(), car); }
      }
      var inp = car.input || {};
      C.ers.step(es, dt, { throttle: racing ? num(inp.throttle, 0) : 0, brake: num(inp.brake, 0), speed: st.vx, gear: st.gear, mass: car.mass,
        boostHeld: car.isPlayer ? playerCtl.ersBoost : !!f.aiBoost, lapStart: lapStart });
      if (car.pitPhase) es.deploying = false;
      // DRS detection / zones
      var s = car.lapS, prev = car.prevLapS;
      var drsOn = drsAllowed();
      for (var z = 0; z < meta.drs.length; z++) {
        var Z = meta.drs[z];
        if (passed(prev, s, Z.detect_s, L)) {
          var log = detect[z], gap = Infinity;
          for (var id in log) if (id !== car.id && t - log[id] < gap && t - log[id] >= 0) gap = t - log[id];
          log[car.id] = t;
          f.drs.eligible[z] = C.drs.eligibleAt({ gap_s: gap, lap: lapNow + 1, mode: mode, weather: weather, enabled: drsOn });
          drsLog.push({ t: Math.round(t * 1000) / 1000, carId: car.id, zone: z, lap: lapNow + 1, gap_s: isFinite(gap) ? Math.round(gap * 1000) / 1000 : null, eligible: f.drs.eligible[z] });
          if (drsLog.length > 400) drsLog.splice(0, drsLog.length - 400);
          if (car.isPlayer && mode === 'race' && drsOn && lapNow + 1 >= C.drs.FROM_LAP) {
            if (f.drs.eligible[z]) msg('drs', 'DRS available · ' + gap.toFixed(2) + ' s to the car ahead', car);
          }
        }
      }
      var zi = C.drs.zoneAt(meta.drs, s, L);
      if (zi !== f.drs.zone) { f.drs.zone = zi; if (zi < 0) { f.drs.open = false; } }
      f.drs.available = zi >= 0 && racing && !car.pitPhase && drsOn && (mode !== 'race' ? true : !!f.drs.eligible[zi]);
      if (!f.drs.available) f.drs.open = false;
      // race control: track limits & penalties
      if (car.tlCount > f.lastTl) { f.lastTl = car.tlCount; f.warnings = car.tlCount; msg('penalty', 'Car ' + f.number + ' (' + short(car) + ') · track limits ' + car.tlCount, car); }
      // two dry compounds in a dry race, or +10 s at the flag
      if (car.finished && !f.cpDone && opts.requireTwoCompounds && mode === 'race' && wetness < 0.4 && !twoDry(f)) {
        f.cpDone = true; car.penalties = (car.penalties || 0) + 10;
        if (Array.isArray(car.penaltyLog)) car.penaltyLog.push({ t: Math.round(t * 1000) / 1000, s: 10, reason: 'one dry compound' });
      }
      if (car.penalties > f.lastPen) { msg('penalty', 'Car ' + f.number + ' (' + short(car) + ') · ' + (car.penalties - f.lastPen) + ' s time penalty', car); f.lastPen = car.penalties; }
    }
    function drsAllowed() { return weather !== 'wet' && !opts.drsOff; }

    function onLap(car, lap) {
      var f = car.f1;
      if (mode === 'race' && !drsEnabledSent && lap + 1 >= C.drs.FROM_LAP && drsAllowed() && meta.drs.length) {
        drsEnabledSent = true; msg('drs', 'DRS enabled', null);
      }
      if (!car.isPlayer) return;
      var sm = C.tyreSummary(f.tyres);
      if (mode === 'race') {
        if (sm.avgWear > 0.62 && !car.pitRequest && lapsTotal - lap > 1 && !f.radioWear) { f.radioWear = true; msg('radio', 'Tyres are going off. Box when ready (I).', car); }
        if (car.gapAhead > 0 && car.gapAhead < 1.2 && car.position > 1) msg('radio', 'Gap ahead ' + car.gapAhead.toFixed(1) + ' s. DRS range, push.', car);
        if (f.ers.soc < 0.15) msg('radio', 'Battery low. Harvest a little.', car);
        if (lapsTotal && lapsTotal - lap === 1) msg('radio', 'Last lap. Bring it home.', car);
        if (opts.requireTwoCompounds && lapsTotal && lapsTotal - lap === 1 && wetness < 0.4 && !twoDry(f)) {
          msg('radio', 'We still need the second compound — box this lap or take a penalty.', car);
        }
      } else if (mode === 'qualifying' && lap > 0 && car.lastLap) {
        msg('radio', 'Lap time ' + fmt(car.lastLap) + (car.bestLap ? ' · best ' + fmt(car.bestLap) : ''), car);
      }
    }
    function fmt(t) { if (!isNum(t)) return '—'; var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3); }
    function twoDry(f) { var d = f.compoundsUsed.filter(function (c) { return !C.COMPOUNDS[c].wet; }); return d.length >= 2 || f.compoundsUsed.some(function (c) { return C.COMPOUNDS[c].wet; }); }

    /* ---------------- flags (per frame, all cars: cheap enough per substep at 1/8 rate) ---------------- */
    var flagTick = 0;
    function flags(cars, t) {
      // yellow: a car stopped / crawling off line during the race -> the 300 m behind it is under yellow
      var slow = [];
      for (var i = 0; i < cars.length; i++) {
        var c = cars[i];
        if (c.f1 && !c.pitPhase && !c.finished && !c.dnf && Math.abs(num(c.state.vx, 0)) < 12 && c.ctx && c.ctx.phase === 'racing') slow.push(c);
      }
      var L = geom.length;
      for (var j = 0; j < cars.length; j++) {
        var a = cars[j], f = a.f1; if (!f) continue;
        var y = false;
        for (var k = 0; k < slow.length; k++) { if (slow[k] === a) continue; var d = wrapS(slow[k].lapS - a.lapS, L); if (d < 300) { y = true; break; } }
        if (y && !f.yellow && a.isPlayer) msg('flag', 'Yellow flag ahead', a);
        f.yellow = y;
        // blue flag: a car at least a lap up within 1.2 s behind
        var blue = false;
        if (mode === 'race') for (var b = 0; b < cars.length; b++) {
          var o = cars[b]; if (o === a || !o.f1) continue;
          if (o.raceDist - a.raceDist > L * 0.5) { var gap = wrapS(a.lapS - o.lapS, L); if (gap < 50 && gap > 0) { blue = true; break; } }
        }
        if (blue && !f.blueFlag && a.isPlayer && t - f.lastBlueMsg > 10) { f.lastBlueMsg = t; msg('flag', 'Blue flag · let the leaders through', a); }
        f.blueFlag = blue;
      }
    }

    /* ---------------- pit stop / box / advice / driver ---------------- */
    function pitStop(car, request) {
      var f = car.f1; if (!f) return { duration_s: 3 };
      request = request || {};
      var comp = request.compound || (car.isPlayer ? (playerCtl.pitCompound || f.pitCompound) : f.pitCompound) || nextCompound(car);
      if (!C.COMPOUNDS[comp]) comp = nextCompound(car);
      var dur = C.pitStopTime(rng, { crew: 0.8 + 0.2 * (1 - f.teamIndex / 11) });
      f.tyres = C.createTyres(comp, { wearMult: wearMult, trackTemp_c: f.tyres.trackTemp_c, temp_c: wetness > 0.4 ? 55 : undefined });
      if (f.compoundsUsed.indexOf(comp) < 0) f.compoundsUsed.push(comp);
      f.pitCompound = null; f.radioWear = false;
      if (car.isPlayer) { playerCtl.pitCompound = null; msg('pit', 'Stationary ' + dur.toFixed(1) + ' s · ' + C.COMPOUNDS[comp].name + 's fitted', car); }
      else msg('pit', short(car) + ' pits · ' + C.COMPOUNDS[comp].letter + ' · ' + dur.toFixed(1) + ' s', car);
      return { duration_s: dur, breakdown: { tyres: dur, compound: comp } };
    }
    function nextCompound(car) {
      var f = car.f1, w = wetness;
      if (w >= 0.75) return 'wet';
      if (w >= 0.4) return 'inter';
      var cur = f.tyres.compound, left = lapsTotal ? lapsTotal - car.tracker.lap : 10;
      var usedDry = f.compoundsUsed.filter(function (c) { return !C.COMPOUNDS[c].wet; });
      if (left <= 6) return usedDry.indexOf('soft') < 0 || usedDry.length >= 2 ? 'soft' : (cur === 'soft' ? 'medium' : 'soft');
      if (cur === 'hard') return 'medium';
      return 'hard';
    }
    function pitBox(car) { return car.f1 && meta ? meta.pit.box_s(car.f1.teamIndex) : null; }
    function advice(car, ctx2) {
      var S = CB.f1.strategy;
      if (S && typeof S.advice === 'function') {
        try { var a = S.advice(car, Object.assign({ meta: meta, mode: mode, weather: weather, wetness: wetness, lapsTotal: lapsTotal, wearMult: wearMult, requireTwoCompounds: !!opts.requireTwoCompounds, hooks: api }, ctx2 || {})); if (a) return a; } catch (e) { /* fallback */ }
      }
      return fallbackAdvice(car, ctx2 || {});
    }
    function fallbackAdvice(car, ctx2) {
      var f = car.f1; if (!f || mode !== 'race') return null;
      var left = num(ctx2.lapsRemaining, 99), sm = C.tyreSummary(f.tyres), c = C.COMPOUNDS[f.tyres.compound];
      var box = false;
      var maxW = Math.max.apply(null, f.tyres.wear);
      if (left >= 2 && (sm.avgWear > 0.62 || maxW > 0.78)) box = true;
      if (wetness >= 0.4 && !c.wet && left >= 2) box = true;
      if (wetness < 0.25 && c.wet && left >= 2) box = true;
      if (opts.requireTwoCompounds && wetness < 0.4 && !twoDry(f) && left >= 2 && left <= 4) box = true;
      if (!box) return { box: false };
      var comp = nextCompound(car);
      f.pitCompound = comp;
      return { box: true, request: { tires: true, compound: comp } };
    }
    function wrapDriver(drv, car, entrant, isAutopilot) {
      ensureGeom(car);
      var A = CB.f1.ai;
      if (A && typeof A.wrapDriver === 'function') {
        try { return A.wrapDriver(drv, car, entrant, { meta: meta, mode: mode, weather: weather, hooks: api, isAutopilot: !!isAutopilot }) || drv; } catch (e) { return drv; }
      }
      return drv;
    }

    /* ---------------- snapshot ---------------- */
    function snapshot(car) {
      var f = car.f1; if (!f) return undefined;
      // flags are updated here (once per snapshot = per rendered frame), using every car the hooks know
      if (car === firstCar) {
        var list = []; for (var id in carsById) list.push(carsById[id]);
        if (geom && list.length) flags(list, num(car.ctx && car.ctx.t, 0));
      }
      var sm = C.tyreSummary(f.tyres);
      return { f1: {
        team: f.teamId, teamName: f.teamName, number: f.number, driver: f.driver, short: f.short, livery: f.livery,
        compound: sm.compound, letter: sm.letter, compoundColor: sm.color, tyreWear: sm.wear, tyreTemp: sm.temp, avgWear: sm.avgWear,
        tyreAge: f.tyres.age, inWindow: sm.inWindow, compoundsUsed: f.compoundsUsed.slice(),
        drs: { uses: f.drs.uses || 0, zone: f.drs.zone, eligible: f.drs.zone >= 0 ? !!f.drs.eligible[f.drs.zone] : false, open: f.drs.open, available: f.drs.available, enabled: drsAllowed() },
        ers: { soc: Math.round(f.ers.soc * 1000) / 1000, mode: f.ers.mode, deploying: f.ers.deploying, harvesting: f.ers.harvesting },
        pitLimiter: car.pitPhase === 'lane' || car.pitPhase === 'exit', inPitLane: !!car.pitPhase || !!f.lane, pitPhase: car.pitPhase || null,
        pitRequested: !!car.pitRequest, pitStops: car.pitStops || 0, pitCompound: car.isPlayer ? (playerCtl.pitCompound || f.pitCompound) : f.pitCompound,
        blueFlag: f.blueFlag, yellow: f.yellow, penalties_s: car.penalties || 0, warnings: car.tlCount || 0
      } };
    }

    var api = {
      id: 'f1',
      carCreated: carCreated, preStep: preStep, vehicleParams: vehicleParams, vehicleEnv: vehicleEnv, postStep: postStep,
      snapshot: snapshot, pitStop: pitStop, pitBox: pitBox, advice: advice, wrapDriver: wrapDriver,
      setPlayerControls: function (c) {
        c = c || {};
        if (c.drs != null) { if (c.drs && !playerCtl.drs) playerCtl.drsEdge = true; playerCtl.drs = !!c.drs; }
        if (c.drsPress) playerCtl.drsEdge = true;
        if (c.ersBoost != null) playerCtl.ersBoost = !!c.ersBoost;
        if (c.ersMode) playerCtl.ersMode = c.ersMode;
        if (c.cycleErs) playerCtl.cycleErs = true;
        if (c.pitCompound !== undefined) playerCtl.pitCompound = C.COMPOUNDS[c.pitCompound] ? c.pitCompound : null;
      },
      drsLog: function () { return drsLog.slice(); },
      drainMessages: function () { var o = msgs; msgs = []; return o; },
      state: function () { var cs = {}; for (var id in carsById) cs[id] = carsById[id].f1; return { meta: meta, mode: mode, weather: weather, cars: cs, drsEnabled: drsEnabledSent, messages: msgs.length }; },
      attach: function (sess) { session = sess; if (sess && sess.geom) geom = sess.geom; ensureGeom(null); if (sess && sess.config && isNum(sess.config.laps)) lapsTotal = sess.config.laps; },
      carF1: function (car) { return car && car.f1; },
      meta: function () { ensureGeom(null); return meta; },
      nextCompound: nextCompound,
      opts: opts
    };
    return api;
  }

  CB.f1.hooks = { VERSION: 1, create: create, deriveMeta: deriveMeta, normaliseMeta: normaliseMeta };
})();

if (typeof module !== 'undefined') module.exports = CB.f1.hooks;

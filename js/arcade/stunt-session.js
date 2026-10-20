/* ==========================================================================
   Redline — js/arcade/stunt-session.js
   CB.arcade.stunt.createSession(cfg) : a self-contained arcade race on a 3D STUNT track (grid, countdown, laps,
   positions, finish, results) with the same surface CB.race.engine sessions expose to race-ui / HUD / results:
     update(dt, input) -> substeps       fixed 1/120 s substeps, internal accumulator (spiral-of-death guarded)
     snapshot()                          engine-shaped snapshot (cars[] with 2D x/y/heading for HUD minimaps) + 3D extras
     results()                           engine-shaped classification + stunt stats (air time, landings, falls)
     restart(), end(), resetPlayerToTrack(), simulate(seconds, input), time(), getPhase(), alpha(),
     setPlayerAutopilot(bool), setAssist() (no-op: arcade has no assist), getState() / setState(state)  (JSON; replays / future netcode),
     applyBoost(id, secs, top, accel), spinOut(id, secs), addNitro(id, amount), spawn(entity), despawn(id), entities()
     geom (2D HUD geometry), track (built stunt track), trackDef, config, gameplay (CB.arcade.gameplay instance|null)

   cfg { trackId | track (def or built), laps, opponents (count | [{name, build, color, number, skill}]), difficulty,
         build | playerBuild, playerName, seed, (no steering assist: humans always drive the arcade 'player' helpers), jumpAssist (true),
         mode 'race'|'time-trial'|'practice', rubberBanding (true), items (true: CB.arcade.gameplay when loaded),
         gameplay {extra CB.arcade.gameplay.create opts}, hooks (object | array), drive (see stunt-physics),
         playerAutopilot, countdown (true), startPosition (1-based | 'back'|'front'|'middle'), timeOfDay }

   Hooks (docs/ARCADE-SPEC.md § Stunt tracks): each optional — carCreated(car, api), preStep(car, input, dt, api) -> input?,
   postStep(car, dt, api), onEvent(event, api), snapshot(car, api) -> object (snapshot car.hook), plus
   cfg.hooks[i].session(api) -> object merged into snapshot.hooks. `api` = session.hookApi.

   Determinism: no Math.random anywhere; the fallback items use a seeded serialisable PRNG; the same cfg + inputs
   produce bit-identical snapshots (tests/arcade-stunt.test.js).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.arcade = CB.arcade || {};
CB.arcade.stunt = CB.arcade.stunt || {};

(function (S) {
  'use strict';

  var STEP = 1 / 120, MAX_SUB = 60;
  var V = S._vec, clamp = V.clamp, num = V.num, wrapS = V.wrapS, wrapD = V.wrapD;
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function round(v, d) { var p = Math.pow(10, d || 0); return Math.round(v * p) / p; }
  function mulberry(seed) {
    var r = { s: seed >>> 0 || 1 };
    var f = function () { r.s = (r.s + 0x6D2B79F5) | 0; var t = r.s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    f.state = function () { return r.s; }; f.setState = function (s) { r.s = s | 0; };
    return f;
  }

  var NAMES = ['Blaze', 'Turbo Tess', 'Max Volt', 'Rico Ramp', 'Nitro Nia', 'Duke Drift', 'Sky Loop', 'Jet Jansen', 'Pixie Fang', 'Rex Rally', 'Zia Zoom'];
  var COLORS = ['#ff3b30', '#2f8bff', '#ffd23f', '#30e3a0', '#b64dff', '#ff8a1f', '#00c8ff', '#ff2fd6', '#9bff3a', '#ffffff', '#ff5a7a'];
  var DIFF = { easy: 0.55, rookie: 0.55, normal: 0.75, amateur: 0.75, medium: 0.75, hard: 0.88, pro: 0.88, expert: 0.97, alien: 0.97 };

  /** Keyboard intent / engine input -> {throttle, brake, steer (+1 left), nitro, item, aimBack, drift, handbrake, reset}. */
  function normInput(raw) {
    raw = raw || {};
    var o = {};
    if ('left' in raw || 'right' in raw || 'up' in raw || 'down' in raw) {
      o.throttle = isNum(raw.throttleAxis) ? clamp01(raw.throttleAxis) : raw.up ? 1 : 0;
      o.brake = isNum(raw.brakeAxis) ? clamp01(raw.brakeAxis) : raw.down ? 1 : 0;
      o.steer = isNum(raw.steerAxis) ? clamp(raw.steerAxis, -1, 1) : (raw.left ? 1 : 0) - (raw.right ? 1 : 0);
    } else {
      o.throttle = clamp01(num(raw.throttle, 0)); o.brake = clamp01(num(raw.brake, 0)); o.steer = clamp(num(raw.steer, 0), -1, 1);
    }
    o.nitro = !!(raw.nitro || raw.boost || raw.shiftUp && raw.nitroOnShift);
    o.item = !!(raw.item || raw.fire || raw.useItem);
    o.aimBack = !!raw.aimBack;
    o.drift = !!(raw.drift || raw.handbrake);
    o.handbrake = !!raw.handbrake;
    o.reset = !!(raw.requestReset || raw.reset);
    return o;
  }

  function resolveTrack(cfg) {
    var t = cfg.track;
    if (t && typeof t.sample === 'function' && typeof t.project === 'function') return t;
    if (t && Array.isArray(t.pieces)) return S.build(t);
    var tr = S.get(cfg.trackId || (S.ids()[0]));
    if (!tr) throw new Error('stunt session: unknown track ' + cfg.trackId);
    return tr;
  }

  function createSession(cfgIn) {
    var cfg = Object.assign({}, cfgIn || {});
    var track = resolveTrack(cfg);
    var P = S.physics, AI = S.ai, F = track.FLAGS, L = track.length;
    cfg.laps = Math.max(1, Math.round(num(cfg.laps, track.laps || 3)));
    cfg.mode = cfg.mode === 'time-trial' || cfg.mode === 'practice' ? cfg.mode : 'race';
    cfg.seed = (num(cfg.seed, 1234) >>> 0) || 1;
    // arcade handling has no steering assist: every human drives the one tuned arcade model ('player' safety helpers +
    // the mercy rule, stunt-physics.js); cfg.assist / steerAssist from older callers are ignored
    cfg.assist = 'player';
    var driveModel = P.resolveDrive(cfg);
    var hooks = [].concat(cfg.hooks || []).filter(function (h) { return h && typeof h === 'object'; });
    // an arcade gameplay layer delivered as engine hooks (CB.arcade.mode extension) replaces our own instance
    var extGameplay = hooks.some(function (h) { return h.name === 'arcade-gameplay'; });
    var hasVehicleEnv = hooks.some(function (h) { return typeof h.vehicleEnv === 'function'; });
    var pads = track.features.filter(function (f) { return f.type === 'pad'; });
    var sess, gp = null, boundGp = null;   // boundGp: the CB.arcade.mode gameplay extension's instance (bindGameplay)
    var Fe = S.features || null;
    var session = { track: track, trackDef: track.def, geom: track.geom2D, config: cfg, STEP: STEP };

    /* ---------------- entrants ---------------- */
    function opponents() {
      if (cfg.mode !== 'race') return [];
      var o = cfg.opponents;
      if (Array.isArray(o)) return o.slice(0, 11);
      var n = Math.round(clamp(num(o, 5), 0, 11));
      var list = [];
      var grid = null;
      try {
        if (n > 0 && CB.race && CB.race.ai && typeof CB.race.ai.createGrid === 'function') {
          var orig = Math.random, rr = mulberry(cfg.seed ^ 0x51ed);
          Math.random = rr;
          try { grid = CB.race.ai.createGrid(cfg.build || cfg.playerBuild || null, { count: n, difficulty: cfg.difficulty || 'amateur', field: 'mixed', seed: cfg.seed }); }
          finally { Math.random = orig; }
        }
      } catch (e) { grid = null; }
      var base = num(DIFF[cfg.difficulty], 0.75);
      for (var i = 0; i < n; i++) {
        var g = grid && grid[i] || {};
        list.push({ name: g.name || NAMES[i % NAMES.length], build: g.build || null, color: g.color || COLORS[i % COLORS.length], accent: g.accent, number: g.number || (i + 2), team: g.team,
          skill: clamp(base + (i / Math.max(1, n - 1) - 0.5) * 0.16, 0.3, 1), bodyStyle: g.bodyStyle });
      }
      return list;
    }

    function makeCar(k, en, isP) {
      var row = Math.floor(k / 2), side = k % 2 === 0 ? 1 : -1;
      var s0 = -12 - row * 10;
      var c = P.createCar({ id: isP ? 'player' : (en.id != null ? String(en.id) : 'ai' + k), s: wrapS(s0, L), L: L, dist: s0, lat: side * 3.2 * (cfg.mode === 'race' ? 1 : 0) });
      c.isPlayer = isP; c.idx = k;
      c.name = en.name || (isP ? (cfg.playerName || 'You') : 'Driver');
      c.color = en.color || (isP ? '#ff6b1a' : COLORS[k % COLORS.length]);
      c.accent = en.accent || '#ffffff';
      c.number = en.number || (isP ? 1 : k + 1);
      c.team = en.team || '';
      c.build = en.build || null;
      c.bodyStyle = en.bodyStyle || (c.build && c.build.body && c.build.body.style) || null;
      c.drive = driveModel.create(c.build, { seed: cfg.seed + k });
      c.ai = isP ? null : AI.createDriver({ skill: num(en.skill, 0.75), laneBias: side * 1.2 * ((k % 3) / 2), seed: cfg.seed + k * 977 });
      c.lastCp = { s: 0, dist: Math.min(0, s0), lat: 0 };
      c.finished = false; c.finishT = null; c.finishPos = null; c.lapStartT = null; c.lapTimes = []; c.bestLap = null; c.lastLap = null;
      c.position = k + 1; c.gridPosition = k + 1; c.maxSpeed = 0; c.nitro = 0; c.nitroOn = false; c.collisions = 0;
      c.hookData = null; c.inputState = { throttle: 0, brake: 0, steer: 0 };
      return c;
    }

    /* ---------------- gameplay layer (nitro / items / pads / rings / coins) ---------------- */
    function gameplayLayout() {
      return track.features.filter(function (f) { return /^(box|pad|ring|can|coin)$/.test(f.type); }).map(function (f) {
        var o = { type: f.type, s: f.s, lat: f.lat };
        if (f.z != null && f.type === 'ring') o.z = f.z;
        if (f.len != null) o.len = f.len; if (f.w != null) o.w = f.w; if (f.r != null) o.r = f.r; if (f.row != null) o.row = f.row;
        return o;
      });
    }
    function makeGameplay() {
      var GP = CB.arcade.gameplay;
      if (extGameplay || cfg.items === false || cfg.gameplay === false || !GP || typeof GP.create !== 'function') return null;
      try {
        var o = Object.assign({
          seed: cfg.seed ^ 0xa11ce, difficulty: cfg.difficulty || 'normal', rubberBand: cfg.rubberBanding !== false,
          timeTrial: cfg.mode !== 'race', layout: gameplayLayout(),
          track: {
            length: L,
            halfWidth: function (s) { return track.sample(s).halfWidth; },
            curvature: function (s) { return track.sample(s).kLeft; },
            pose: function (s, lat) { var p = track.pointAt(s, lat, 0); return { x: p[0], y: -p[2], z: p[1] }; }
          }
        }, typeof cfg.gameplay === 'object' ? cfg.gameplay : {});
        return GP.create(o);
      } catch (e) { if (typeof console !== 'undefined') console.warn('[stunt] gameplay layer failed', e); return null; }
    }

    /* ---------------- init ---------------- */
    function init() {
      sess = {
        t: 0, steps: 0, acc: 0, phase: cfg.countdown === false || cfg.mode === 'practice' ? 'racing' : 'grid', goT: null, endT: null,
        cars: [], order: [], events: [], log: [], finishOrder: [], fastestLap: null, rng: mulberry(cfg.seed ^ 0xbeef), autopilot: !!cfg.playerAutopilot,
        pickups: {}, entities: [], nextEnt: 1, assist: cfg.assist, input: normInput({}), lastLights: 0, prevReset: false
      };
      if (sess.phase === 'racing') sess.goT = 0;
      var opps = opponents(), N = opps.length + 1;
      var sp = cfg.startPosition, pIdx;
      if (isNum(sp)) pIdx = clamp(Math.round(sp) - 1, 0, N - 1);
      else if (sp === 'front' || cfg.mode !== 'race') pIdx = 0;
      else if (sp === 'middle') pIdx = Math.floor((N - 1) / 2);
      else pIdx = N - 1;   // arcade default: start at the back and fight through
      var entrants = opps.slice();
      entrants.splice(pIdx, 0, { name: cfg.playerName, build: cfg.build || cfg.playerBuild || null, color: cfg.playerColor, isPlayer: true, number: cfg.playerNumber });
      for (var k = 0; k < entrants.length; k++) {
        var c = makeCar(k, entrants[k], !!entrants[k].isPlayer);
        sess.cars.push(c);
        if (c.isPlayer) sess.player = c;
      }
      sess.order = sess.cars.slice();
      gp = makeGameplay();
      session.gameplay = gp;
      for (var h = 0; h < sess.cars.length; h++) callHooks('carCreated', [sess.cars[h], api]);
      updatePositions();
    }

    /* ---------------- hooks API ---------------- */
    function carById(id) { if (id && typeof id === 'object') return id; for (var i = 0; i < sess.cars.length; i++) if (sess.cars[i].id === id) return sess.cars[i]; return null; }
    var api = {
      get t() { return sess.t; }, get phase() { return sess.phase; }, get cars() { return sess.cars; }, get player() { return sess.player; },
      track: track, STEP: STEP,
      applyBoost: function (id, secs, top, accel) { var c = carById(id); if (c) { P.boost(c, secs, top, accel); evt('boost', c, { secs: secs, source: 'hook' }); } },
      spinOut: function (id, secs) { var c = carById(id); if (c) { P.spinOut(c, secs); evt('spin', c, { secs: secs }); } },
      addNitro: function (id, amount) { var c = carById(id); if (gp) gp.addNitro(c ? c.id : id, amount, 'hook'); else if (c) c.nitro = clamp01(c.nitro + num(amount, 0.3)); },
      spawn: function (e) { return spawn(e); }, despawn: function (id) { return despawn(id); }, entities: function () { return sess.entities; },
      emit: function (type, car, data) { evt(type, carById(car), data); },
      rng: function () { return sess.rng(); }, pose: function (id) { var c = carById(id); return c ? P.pose(track, c) : null; }
    };
    session.hookApi = api;
    function callHooks(name, args) {
      var out;
      for (var i = 0; i < hooks.length; i++) {
        var h = hooks[i];
        if (typeof h[name] !== 'function') continue;
        try { var r = h[name].apply(h, args); if (r !== undefined) out = r; } catch (e) { sess && (sess.hookErrors = (sess.hookErrors || 0) + 1); }
      }
      return out;
    }
    function spawn(e) {
      e = Object.assign({ type: 'entity', s: 0, lat: 0, z: 0, life: -1 }, e || {});
      e.id = e.id || 'x' + (sess.nextEnt++);
      sess.entities.push(e);
      return e.id;
    }
    function despawn(id) { for (var i = 0; i < sess.entities.length; i++) if (sess.entities[i].id === id) { sess.entities.splice(i, 1); return true; } return false; }

    function evt(type, c, data) {
      var e = Object.assign({ type: type, t: round(sess.t, 3), carId: c ? c.id : null, isPlayer: !!(c && c.isPlayer) }, data || {});
      sess.events.push(e); if (sess.events.length > 300) sess.events.shift();
      sess.log.push(e); if (sess.log.length > 600) sess.log.shift();
      callHooks('onEvent', [e, api]);
    }

    /* ---------------- phases ---------------- */
    var GRID_T = 0.8, LIGHT_DT = 0.6, HOLD = 0.4;
    function lightsOutT() { return GRID_T + 5 * LIGHT_DT + HOLD; }
    function updatePhase() {
      if (sess.phase === 'grid' && sess.t >= GRID_T) sess.phase = 'countdown';
      if (sess.phase === 'countdown') {
        var on = clamp(Math.floor((sess.t - GRID_T) / LIGHT_DT) + 1, 0, 5);
        if (on !== sess.lastLights) { sess.lastLights = on; evt('light', null, { lights: on }); }
        if (sess.t >= lightsOutT()) { sess.phase = 'racing'; sess.goT = sess.t; evt('go', null, {}); sess.cars.forEach(function (c) { c.lapStartT = sess.t; }); }
      }
    }
    function countdownObj() {
      if (sess.goT !== null && sess.phase !== 'grid' && sess.phase !== 'countdown') return { lightsOn: 0, lightsOut: true, goTime: sess.goT };
      var on = sess.phase === 'countdown' ? clamp(Math.floor((sess.t - GRID_T) / LIGHT_DT) + 1, 0, 5) : 0;
      return { lightsOn: on, lightsOut: false, goTime: null, remaining_s: Math.max(0, lightsOutT() - sess.t) };
    }

    /* ---------------- per-step ---------------- */
    function respawnPoint(c) {
      var cp = c.lastCp || { s: 0, dist: 0 };
      var pl = AI.plan(track), i = Math.round(wrapS(cp.s, L) / track.DS) % track.N;
      return { s: cp.s, dist: cp.dist, lat: 0, speed: Math.min(22, Math.max(14, pl.speed[i] * 0.45)) };
    }
    function views() {
      return sess.cars.map(function (c) {
        return { id: c.id, isPlayer: c.isPlayer, s: c.s, lap: Math.max(0, Math.floor(c.dist / L)), dist: c.dist, lat: c.mode === 'ground' ? c.lat : 0,
          speed: Math.abs(c.v), position: c.position, vTop: c.vTop || num(c.drive && c.drive.vmax, 55), halfW: P.HALF_W,
          throttle: c.inputState.throttle, steer: c.inputState.steer, airborne: c.mode !== 'ground', finished: c.finished, onTrack: c.mode !== 'respawn' };
      });
    }
    function fallbackPickups(c) {
      // pads / rings / cans / boxes without the gameplay layer: pads boost, rings boost + nitro, cans nitro, boxes a random boost
      if (c.mode === 'respawn') return;
      var feats = track.features;
      for (var i = 0; i < feats.length; i++) {
        var f = feats[i];
        if (f.type === 'arrow' || f.type === 'checkpoint') continue;
        var ds = wrapD(f.s - c.s, L);
        if (Math.abs(ds) > 4) continue;
        var key = f.id + '|' + c.id;
        if (sess.pickups[key] > sess.t) continue;
        var lat = c.mode === 'ground' ? c.lat : (track.project([c.px, c.py, c.pz], { hintS: c.s, window: 20 }) || { lateral: 99 }).lateral;
        var rl = f.type === 'pad' ? num(f.w, 3.4) / 2 + 0.6 : f.type === 'ring' ? num(f.r, 2.8) : 1.9;
        if (Math.abs(lat - f.lat) > rl) continue;
        if (Math.abs(ds) > (f.type === 'pad' ? num(f.len, 7) / 2 + 1 : 1.8)) continue;
        sess.pickups[key] = sess.t + (f.type === 'pad' || f.type === 'ring' ? 0.8 : f.type === 'coin' ? 9 : 4);
        if (f.type === 'pad') { P.boost(c, 1.0, 1.24, 16); evt('boostPad', c, { feature: f.id }); }
        else if (f.type === 'ring') { P.boost(c, 1.2, 1.2, 14); c.nitro = clamp01(c.nitro + 0.1); evt('boostRing', c, { feature: f.id }); }
        else if (f.type === 'can') { c.nitro = clamp01(c.nitro + 0.34); evt('canister', c, { feature: f.id }); }
        else if (f.type === 'box') { if (sess.rng() < 0.5) P.boost(c, 1.4, 1.22, 14); else c.nitro = clamp01(c.nitro + 0.4); evt('itemBox', c, { feature: f.id }); }
        else if (f.type === 'coin') evt('coin', c, { feature: f.id });
      }
    }
    function collide() {
      var cs = sess.cars;
      for (var i = 0; i < cs.length; i++) {
        var a = cs[i];
        if (a.mode !== 'ground' || a.ghostT > 0 || a.noCollide) continue;
        for (var j = i + 1; j < cs.length; j++) {
          var b = cs[j];
          if (b.mode !== 'ground' || b.ghostT > 0 || b.noCollide) continue;
          var ds = wrapD(b.s - a.s, L);
          if (Math.abs(ds) > 4.4) continue;
          var dl = b.lat - a.lat;
          if (Math.abs(dl) > 2.0) continue;
          // lateral separation (side-by-side) or longitudinal bump (nose to tail)
          if (Math.abs(ds) < 3.4) {
            var push = (2.0 - Math.abs(dl)) / 2 + 0.01, sg = dl >= 0 ? 1 : -1;
            a.lat -= sg * push; b.lat += sg * push;
            a.psi *= 0.85; b.psi *= 0.85;
          } else {
            var back = ds > 0 ? a : b, front = ds > 0 ? b : a;
            if (back.v > front.v) { var dv = back.v - front.v; back.v -= dv * 0.55; front.v += dv * 0.45; }
          }
          if (!a._touch || sess.t - a._touch > 0.5) { a.collisions++; b.collisions++; evt('contact', a, { other: b.id }); a._touch = sess.t; }
        }
      }
    }

    function stepOnce(pin) {
      sess.t += STEP;
      updatePhase();
      var racing = sess.phase === 'racing' || sess.phase === 'finished';
      // gameplay layer first: effects for this substep
      if (gp) {
        try {
          gp.setInput(sess.player.id, { nitro: pin.nitro, item: pin.item, aimBack: pin.aimBack, drift: pin.drift });
          gp.step(STEP, { t: sess.t, phase: sess.phase, trackLength: L, cars: views() });
          var ge = gp.takeEvents ? gp.takeEvents() : [];
          for (var q = 0; q < ge.length; q++) { var g = ge[q]; evt('arcade:' + g.type, carById(g.carId), { data: g }); }
        } catch (e) { sess.gpErrors = (sess.gpErrors || 0) + 1; if (sess.gpErrors > 20) gp = session.gameplay = null; }
      }
      var cars = sess.cars;
      for (var i = 0; i < cars.length; i++) {
        var c = cars[i];
        if (c.external) {   // multiplayer puppet (js/net/netarcade.js): its pose comes from the network, no AI / physics here
          if (hooks.length) { c.ctx = { t: sess.t, phase: sess.phase, trackLength: L, dt: STEP, position: c.position }; c.lap = Math.max(0, Math.floor(c.dist / L)); }
          callHooks('externalStep', [c, STEP, api]);
          continue;
        }
        // netarcade host (js/net/netarcade.js): a remote player's car steps 0 or 2 times in one tick to grow / shrink its
        // input delay WITHOUT breaking the one-input-per-physics-step replay of that player's own prediction
        var reps = c.netSteps === 0 || c.netSteps === 2 ? c.netSteps : 1;
        if (c.netSteps !== undefined) c.netSteps = 1;
        for (var rep = 0; rep < reps; rep++) { if (reps !== 1 || c.netRep) c.netRep = rep; stepCar(c); }
      }
      function stepCar(c) {
        var inp;
        if (c.isPlayer && !sess.autopilot && !c.finished) inp = { throttle: pin.throttle, brake: pin.brake, steer: pin.steer, nitro: pin.nitro };
        else inp = AI.drive(c.ai || (c.ai = AI.createDriver({ skill: 0.9 })), c, track, { cars: cars, pads: pads, driveModel: driveModel, t: sess.t - num(c.clockOffset, 0) });
        if (c.finished && !c.isPlayer) inp.throttle *= 0.6;
        // engine-hook contract mirror (ARCADE-SPEC §3/§4): car.ctx / car.input / car.state / car.params
        if (hooks.length) {
          c.ctx = { t: sess.t, phase: sess.phase, trackLength: L, dt: STEP, position: c.position };
          c.input = inp; c.lap = Math.max(0, Math.floor(c.dist / L));
          c.params = c.params || { handling: 'arcade', arcade: {}, capabilities: { topSpeed_mps: num(c.drive && c.drive.vmax, 55) } };
          c.state = { vx: c.v, vy: 0, speed: Math.abs(c.v), mode: c.mode, airborne: c.mode === 'air', s: c.s, lat: c.lat, dist: c.dist };
          c.airborne = c.mode === 'air';
        }
        // chained like CB.race.engine: each hook gets the previous hook's input (net replay -> gameplay effects)
        for (var hp = 0; hp < hooks.length; hp++) {
          if (typeof hooks[hp].preStep !== 'function') continue;
          try { var hk = hooks[hp].preStep(c, inp, STEP, api); if (hk && typeof hk === 'object') inp = hk; } catch (eH) { sess.hookErrors = (sess.hookErrors || 0) + 1; }
        }
        if (hooks.length) c.input = inp;
        c.inputState = inp;
        c.throttle = num(inp.throttle, 0); c.brake = num(inp.brake, 0); c.steer = num(inp.steer, 0);
        if (!racing) {   // grid / countdown: hold position (gameplay rocket-start gauge reads the throttle)
          c.v = 0; c.rpm = 1000 + 5500 * c.throttle;
          return;
        }
        var fx = gp ? gp.effects(c.id) : null;
        if (hasVehicleEnv) {   // extension boosts via env.arcade { push, topSpeedMult }
          var envA = null;
          for (var hv = 0; hv < hooks.length; hv++) if (typeof hooks[hv].vehicleEnv === 'function') { try { var en2 = hooks[hv].vehicleEnv(c, envA || { arcade: {} }); if (en2) envA = en2; } catch (eV) { /* hook */ } }
          var ar = envA && envA.arcade;
          if (ar && (num(ar.push, 0) > 0 || num(ar.topSpeedMult, 1) > 1)) {
            var vt0 = num(c.drive && c.drive.vmax, 55);
            fx = { push: num(ar.push, 0), vTarget: vt0 * Math.max(1, num(ar.topSpeedMult, 1)), throttleMult: 1, boostKind: 'ext' };
            c.extBoost = true;
          } else c.extBoost = false;
        }
        // fallback nitro (no gameplay layer)
        if (!gp && !extGameplay) {
          var wantN = c.isPlayer && !sess.autopilot ? !!inp.nitro : !!inp.nitro && c.nitro > 0.5;
          c.nitroOn = wantN && c.nitro > 0.02 && c.mode === 'ground';
          if (c.nitroOn) { c.nitro = Math.max(0, c.nitro - 0.27 * STEP); P.boost(c, 0.1, 1.17, 9.5); }
          if (c.mode === 'air') c.nitro = clamp01(c.nitro + 0.11 * STEP);
        } else c.nitroOn = !!(fx && (fx.nitroOn || fx.boostKind === 'nitro'));
        c.noCollide = !!(fx && fx.noCollide);
        // humanAssist: a remote player's car (netarcade host). cfg.netPlayer (netarcade): the own car keeps the human helpers on
        // autopilot too, exactly like the host's copy of it (else an autopiloted guest predicted 'ai' launches / air guidance
        // while the host flew the same inputs with the 'player' ones)
        var human = c.isPlayer ? !sess.autopilot || !!cfg.netPlayer : !!c.humanAssist && !c.finished;
        var help = human ? 'player' : 'ai';
        var pace = 1;
        if (!c.isPlayer && !gp && cfg.rubberBanding !== false && cfg.mode === 'race' && sess.player) {
          var gap = sess.player.dist - c.dist;
          pace = gap > 30 ? 1 + 0.08 * clamp01((gap - 30) / 200) : gap < -50 ? 1 - 0.06 * clamp01((-gap - 50) / 250) : 1;
        }
        if (!c.isPlayer && c.ai && !c.humanAssist) pace *= c.ai.pace;   // a remote player's car (netarcade host) drives like a player car
        var prevDist = c.dist;
        P.step(c, {
          track: track, dt: STEP, drive: driveModel, input: inp, fx: fx, help: help, jumpAssist: cfg.jumpAssist !== false || help === 'ai',
          respawnPoint: respawnPoint, paceMult: pace, latMult: c.ai && !c.humanAssist ? c.ai.latMult : 1
        });
        if (Fe) {   // special features (hazards, bumpers, belts, stars, callouts …): stunt-features.js
          var fctx = featureCtx(c, inp);
          if (c.events) for (var e0 = 0; e0 < c.events.length; e0++) Fe.onPhysicsEvent(c, c.events[e0], fctx);
          drainEvents(c);
          Fe.step(c, fctx);
        }
        drainEvents(c);
        if (!gp && !extGameplay) fallbackPickups(c);
        if (Math.abs(c.v) > c.maxSpeed) c.maxSpeed = Math.abs(c.v);
        timing(c, prevDist);
        if (hooks.length) {
          c.state.vx = c.v; c.state.speed = Math.abs(c.v); c.state.mode = c.mode; c.state.s = c.s; c.state.lat = c.lat; c.state.dist = c.dist;
          c.airborne = c.mode === 'air';
          var vBefore = c.v;
          callHooks('postStep', [c, STEP, api]);
          if (c.state.vx !== vBefore && isNum(c.state.vx) && c.mode === 'ground') c.v = c.state.vx;
        } else callHooks('postStep', [c, STEP, api]);
    }
      if (racing) collide();
      // hook entities with a life time
      for (var k = sess.entities.length - 1; k >= 0; k--) { var en = sess.entities[k]; if (en.life > 0) { en.life -= STEP; if (en.life <= 0) sess.entities.splice(k, 1); } }
      if (sess.steps % 6 === 0) updatePositions();
      checkEnd();
      sess.steps++;
    }

    function drainEvents(c) { if (c.events) { var list = c.events; c.events = null; for (var e = 0; e < list.length; e++) evt(list[e].type, c, list[e]); } }
    function featureCtx(c, inp) {
      return {
        track: track, t: sess.t - num(c.clockOffset, 0), dt: STEP, input: inp, gp: gp || boundGp,
        emit: function (kind, data) { evt('stuntFx', c, Object.assign({ kind: kind }, data || {})); }
      };
    }
    function playerStars() {
      var pl = sess.player, out = [];
      if (!pl || !pl.feat || !pl.feat.st) return out;
      var lap = Math.max(0, Math.floor(pl.dist / L));
      for (var k in pl.feat.st) if (pl.feat.st[k] === lap) out.push(k);
      return out;
    }
    function timing(c, prevDist) {
      // checkpoints (unwrapped): remember the last one passed for respawns
      var lapBase = Math.floor(c.dist / L) * L, cps = track.checkpoints;
      for (var i = 0; i < cps.length; i++) {
        var cd = lapBase + cps[i].s;
        if (prevDist < cd && c.dist >= cd && cd > c.lastCp.dist) c.lastCp = { s: cps[i].s, dist: cd, lat: 0 };
      }
      var lapsNow = Math.floor(c.dist / L), lapsPrev = Math.floor(prevDist / L);
      if (lapsNow > lapsPrev && c.dist > 0 && !c.finished) {
        var lt = c.lapStartT !== null ? sess.t - c.lapStartT : null;
        if (lapsNow >= 1 && lt !== null && lapsPrev >= 0) {
          c.lapTimes.push({ lap: lapsNow, time: lt });
          c.lastLap = lt;
          if (c.bestLap === null || lt < c.bestLap) c.bestLap = lt;
          if (!sess.fastestLap || lt < sess.fastestLap.time) sess.fastestLap = { carId: c.id, time: lt, lap: lapsNow };
          evt('lap', c, { lap: lapsNow, time: lt });
        }
        c.lapStartT = sess.t;
        if (cfg.mode === 'race' && lapsNow >= cfg.laps) {
          c.finished = true; c.finishT = sess.t - sess.goT; sess.finishOrder.push(c); c.finishPos = sess.finishOrder.length;
          evt('finish', c, { position: c.finishPos, time: c.finishT });
        }
      }
    }
    function updatePositions() {
      var fin = sess.finishOrder;
      var rest = sess.cars.filter(function (c) { return !c.finished; }).sort(function (a, b) { return b.dist - a.dist || a.idx - b.idx; });
      sess.order = fin.concat(rest);
      for (var i = 0; i < sess.order.length; i++) sess.order[i].position = i + 1;
    }
    function checkEnd() {
      if (sess.phase === 'finished') { if (sess.endT === null && sess.t - sess.flagT > 12) sess.endT = sess.t; return; }
      if (cfg.mode !== 'race') return;
      var p = sess.player;
      if (p && p.finished) { sess.phase = 'finished'; sess.flagT = sess.t; updatePositions(); evt('flag', p, {}); }
    }

    /* ---------------- public API ---------------- */
    function update(dt, input) {
      if (!isNum(dt) || dt <= 0) return 0;
      var pin = normInput(input);
      if (pin.reset && !sess.prevReset && sess.player && sess.player.mode !== 'respawn') P.startRespawn(sess.player, {}, 'manual');
      sess.prevReset = pin.reset;
      sess.acc += Math.min(dt, MAX_SUB * STEP);
      var n = 0;
      while (sess.acc >= STEP - 1e-9 && n < MAX_SUB) {
        sess.acc -= STEP;
        if (!(sess.acc >= STEP - 1e-9) || n + 1 >= MAX_SUB) capturePrevPoses();   // the last substep of this frame
        stepOnce(pin); n++;
      }
      return n;
    }
    /** Pose of every car BEFORE the last substep: the snapshot interpolates prev -> current with alpha = acc / STEP (one
        substep), so the drawn car moves with the clock however many substeps a frame ran (1, 2, 3 … at 60 Hz on a guest
        whose race clock follows the host's). It used to be the pose of the previous snapshot() call (the previous frame),
        lerped by a one-substep alpha: every 1- or 3-substep frame showed as a 0.4-1.5 m jump of every car. */
    function capturePrevPoses() {
      for (var i = 0; i < sess.cars.length; i++) {
        var c = sess.cars[i], pp = c._pp || (c._pp = { pos: [0, 0, 0], fwd: [1, 0, 0], up: [0, 1, 0], right: [0, 0, 1] });
        P.pose(track, c, pp);
        pp.t = sess.t;
      }
    }
    var _pose = { pos: [0, 0, 0], fwd: [1, 0, 0], up: [0, 1, 0], right: [0, 0, 1] };
    function snapCar(c) {
      var p = P.pose(track, c, _pose);
      var x = p.pos[0], y = -p.pos[2], heading = Math.atan2(-p.fwd[2], p.fwd[0]);
      // previous substep's pose (capturePrevPoses); none yet / a teleport (warp, respawn swap) -> no interpolation
      var pp = c._pp && Math.abs(c._pp.t + STEP - sess.t) < 1e-6 ? c._pp : null;
      if (pp && Math.hypot(pp.pos[0] - p.pos[0], pp.pos[1] - p.pos[1], pp.pos[2] - p.pos[2]) > 12) pp = null;
      var px0 = pp ? pp.pos[0] : x, py0 = pp ? -pp.pos[2] : y, ph0 = pp ? Math.atan2(-pp.fwd[2], pp.fwd[0]) : heading;
      var racing = sess.goT !== null;
      var o = {
        id: c.id, isPlayer: c.isPlayer, name: c.name, team: c.team, number: c.number, color: c.color, accent: c.accent, build: c.build, bodyStyle: c.bodyStyle,
        x: x, y: y, heading: heading, prevX: px0, prevY: py0, prevHeading: ph0,
        speed: Math.abs(c.v), vSigned: c.v, rpm: c.rpm, gear: c.gear, maxGear: 6, redline: 7400, steerAngle: c.steerAngle,
        throttle: c.throttle, brake: c.brake, lap: Math.max(0, Math.min(cfg.laps, Math.floor(c.dist / L))), s: c.s, lateral: c.mode === 'ground' ? c.lat : 0,
        raceDist: c.dist, position: c.position, gridPosition: c.gridPosition, currentLap_s: racing && c.lapStartT !== null && !c.finished ? sess.t - c.lapStartT : 0,
        lastLap_s: c.lastLap, bestLap_s: c.bestLap, finished: c.finished, finishTime_s: c.finishT, finishPosition: c.finishPos,
        onTrack: c.mode !== 'respawn', offTrack: false, surface: 'asphalt', wrongWay: c.wrongT > 1.5, collisions: c.collisions,
        // 3D stunt extras
        pos: p.pos.slice(), fwd: p.fwd.slice(), up: p.up.slice(), right: p.right.slice(), mode: c.mode,
        prevPos: pp ? pp.pos.slice() : p.pos.slice(), prevFwd: pp ? pp.fwd.slice() : p.fwd.slice(), prevUp: pp ? pp.up.slice() : p.up.slice(), airborne: c.mode === 'air', airTime_s: c.airT,
        lastAir_s: c.lastAir, fade: c.fade, susp: c.susp, ghost: c.ghostT > 0, boosting: c.boostT > 0 || c.nitroOn || !!c.extBoost, nitroOn: c.nitroOn, nitro: c.nitro,
        spin: c.spinT, yawRate: c.yawRate, psi: c.psi, height: 0
      };
      // (no per-car prevX / prevH writes here: c.prevH is stunt-physics' height-above-surface memory for the swept landing
      //  test — writing the heading into it from snapshot() made landings depend on WHEN the renderer asked for a snapshot,
      //  so a guest's prediction and the host's copy of the same car could land a tick apart or not at all)
      if (gp) { var fx = gp.effects(c.id); o.visualYaw = num(fx.yaw, 0) + num(fx.slide, 0); o.hop = num(fx.hop, 0); o.boostKind = fx.boostKind; o.boosting = o.boosting || !!fx.boostKind; o.shielded = !!fx.shielded; }
      else o.visualYaw = c.spinT > 0 ? Math.PI * 2 * (1 - c.spinT / c.spinDur) : 0;
      var hd = callHooks('snapshot', [c, api]);
      if (hd !== undefined) o.hook = hd;
      return o;
    }
    function snapshot() {
      var ev = sess.events; sess.events = [];
      var snap = {
        t: sess.t, phase: sess.phase, countdown: countdownObj(), lapsTotal: cfg.laps, mode: cfg.mode, weather: 'dry', timeOfDay: track.theme === 'neon' ? 'night' : (cfg.timeOfDay && cfg.timeOfDay !== 'day' ? cfg.timeOfDay : track.def.timeOfDay || 'day'),
        playerId: 'player', trackId: track.id, trackLength: L, sectorBounds: [L / 3, 2 * L / 3], alpha: clamp01(sess.acc / STEP),
        raceTime: sess.goT !== null ? Math.max(0, (sess.endT !== null ? sess.endT : sess.t) - sess.goT) : 0,
        fastestLap: sess.fastestLap ? Object.assign({}, sess.fastestLap) : null, leaderId: sess.order[0] ? sess.order[0].id : null,
        cars: sess.cars.map(snapCar), order: sess.order.map(function (c) { return c.id; }), events: ev,
        stunt: { trackId: track.id, theme: track.theme, assist: sess.assist, entities: sess.entities.slice(), pickupsHidden: hiddenPickups(), fade: sess.player ? sess.player.fade : 0,
          starsTaken: playerStars(), clock: sess.t - num(sess.player && sess.player.clockOffset, 0) },
        kind: 'stunt'
      };
      var extra = {};
      hooks.forEach(function (h) { if (typeof h.session === 'function') { try { Object.assign(extra, h.session(api) || {}); } catch (e) { /* hook */ } } });
      snap.hooks = extra;
      if (gp && typeof gp.decorate === 'function') {
        // decorate() adds snap.arcade and nudges the 2D heading for the spin visual; keep our 3D frames untouched
        try { gp.decorate(snap); } catch (e) { /* optional */ }
      }
      return snap;
    }
    function hiddenPickups() {
      var out = [];
      if (gp) return out;
      var pl = sess.player;
      if (!pl) return out;
      for (var k in sess.pickups) if (sess.pickups[k] > sess.t && k.slice(-(pl.id.length + 1)) === '|' + pl.id) out.push(k.split('|')[0]);
      return out;
    }
    function fmt(s) { if (!isNum(s)) return '—'; var m = Math.floor(s / 60), r = s - m * 60; return (m ? m + ':' + (r < 10 ? '0' : '') : '') + r.toFixed(3); }
    function results() {
      var rows = sess.order.slice();
      var win = rows[0];
      var cls = rows.map(function (c, i) {
        var status = c.finished ? 'finished' : 'running';
        var gapText = i === 0 ? (c.finished ? fmt(c.finishT) : 'Leader') : c.finished && win.finished ? '+' + fmt(c.finishT - win.finishT) : '+' + Math.max(0, Math.round(win.dist - c.dist)) + ' m';
        return {
          position: i + 1, id: c.id, name: c.name, team: c.team, number: c.number, color: c.color, accent: c.accent, isPlayer: c.isPlayer, bodyStyle: c.bodyStyle,
          status: status, laps: Math.max(0, Math.min(cfg.laps, Math.floor(c.dist / L))), raceTime_s: c.finishT, totalTime_s: c.finishT, penalties_s: 0, penaltyLog: [],
          gap_s: c.finished && win.finished ? c.finishT - win.finishT : null, gapText: gapText, bestLap_s: c.bestLap, lastLap_s: c.lastLap,
          lapTimes: c.lapTimes.map(function (l) { return l.time; }), gridPosition: c.gridPosition, topSpeed_kph: round(c.maxSpeed * 3.6, 1),
          collisions: c.collisions, fastestLap: !!(sess.fastestLap && sess.fastestLap.carId === c.id),
          stunt: { airTime_s: round(c.airTotal, 2), bestAir_s: round(c.bestAir, 2), landings: c.landings, falls: c.falls,
            stars: c.feat ? c.feat.stars : 0, starsTotal: Fe ? Fe.index(track).starTotal * cfg.laps : 0, hazardHits: c.feat ? c.feat.hz : 0,
            bumpers: c.feat ? c.feat.bumps : 0, shortcuts: c.feat ? c.feat.cuts : 0, fireRings: c.feat ? c.feat.fire : 0, warps: c.feat ? c.feat.warps : 0 }
        };
      });
      var player = cls.filter(function (r) { return r.isPlayer; })[0] || null;
      return {
        mode: cfg.mode, kind: 'stunt', trackId: track.id, trackName: track.name, trackLength_m: L, lapsTotal: cfg.laps, seed: cfg.seed,
        complete: sess.phase === 'finished', phase: sess.phase, raceTime_s: sess.goT !== null ? sess.t - sess.goT : 0,
        fastestLap: sess.fastestLap ? Object.assign({}, sess.fastestLap) : null, classification: cls, player: player, playerId: 'player',
        events: sess.log.slice(-300), diagnostics: { drive: driveModel.id || 'custom', gameplay: !!gp, hookErrors: sess.hookErrors || 0 },
        arcade: gp && gp.stats ? gp.stats('player') : null
      };
    }
    /** Serialisable state (track-space per car) — restoring and stepping the same inputs reproduces the run exactly. */
    function getState() {
      var cars = sess.cars.map(function (c) {
        var o = {};
        for (var k in c) {
          if (k === 'ctx' || k === 'input' || k === 'state' || k === 'params' || k === 'build' || k === '_pp') continue;
          if (k === 'drive') { o.drive = driveState(c.drive); continue; }
          if (k === 'ai' || k === 'drive' || k === 'lastCp' || k === 'lapTimes' || k === 'inputState' || k === 'feat') o[k] = JSON.parse(JSON.stringify(c[k])); else if (typeof c[k] !== 'function' && k !== 'events') o[k] = c[k]; }
        return o;
      });
      return {
        v: 1, trackId: track.id, cfg: { laps: cfg.laps, seed: cfg.seed, mode: cfg.mode, assist: sess.assist },
        t: sess.t, steps: sess.steps, acc: sess.acc, phase: sess.phase, goT: sess.goT, endT: sess.endT, flagT: sess.flagT, lastLights: sess.lastLights,
        rng: sess.rng.state(), pickups: Object.assign({}, sess.pickups), entities: JSON.parse(JSON.stringify(sess.entities)), nextEnt: sess.nextEnt,
        fastestLap: sess.fastestLap, finishOrder: sess.finishOrder.map(function (c) { return c.id; }), autopilot: sess.autopilot,
        cars: cars, gameplay: gp && gp.serialize ? gp.serialize() : null
      };
    }
    /** Drive-model state without its (rebuildable, non-JSON) vehicle params. */
    function driveState(d) {
      var o = {};
      if (d) for (var k in d) if (k !== 'p' && k !== 'params' && typeof d[k] !== 'function') o[k] = (d[k] && typeof d[k] === 'object') ? JSON.parse(JSON.stringify(d[k])) : d[k];
      return o;
    }
    function setState(st) {
      if (!st || !Array.isArray(st.cars)) return false;
      ['t', 'steps', 'acc', 'phase', 'goT', 'endT', 'flagT', 'lastLights', 'nextEnt', 'fastestLap', 'autopilot'].forEach(function (k) { if (k in st) sess[k] = st[k]; });
      sess.rng.setState(st.rng);
      sess.pickups = Object.assign({}, st.pickups || {});
      sess.entities = JSON.parse(JSON.stringify(st.entities || []));
      st.cars.forEach(function (o) {
        var c = carById(o.id);
        if (!c) return;
        for (var k in o) {
          if (k === 'drive' && c.drive && o.drive) { Object.assign(c.drive, JSON.parse(JSON.stringify(o.drive))); continue; }   // keep the model's params
          c[k] = (o[k] && typeof o[k] === 'object') ? JSON.parse(JSON.stringify(o[k])) : o[k];
        }
      });
      sess.finishOrder = (st.finishOrder || []).map(carById).filter(Boolean);
      if (gp && st.gameplay && gp.load) gp.load(st.gameplay);
      updatePositions();
      return true;
    }

    session.update = update;
    session.snapshot = snapshot;
    session.results = results;
    session.restart = function () { init(); };
    session.end = function () { if (sess.phase !== 'finished') { sess.phase = 'finished'; sess.flagT = sess.t; sess.endT = sess.t; updatePositions(); } };
    session.resetPlayerToTrack = function () { if (sess.player) P.startRespawn(sess.player, {}, 'manual'); };
    session.simulate = function (seconds, input) { var n = Math.round(num(seconds, 1) / STEP), done = 0; while (done < n) done += update(Math.min(n - done, MAX_SUB) * STEP, typeof input === 'function' ? input(session) : input); return done; };
    /** netarcade client re-prediction: one bare physics substep of `car` (drive model + stunt physics with the player
        helpers and the car's current gameplay effects; no hooks, features, timing or events). */
    session.netPredict = function (car, input) {
      var c = carById(car);
      if (!c) return null;
      var fx = gp ? gp.effects(c.id) : null;
      P.step(c, { track: track, dt: STEP, drive: driveModel, input: input || {}, fx: fx, help: 'player', jumpAssist: cfg.jumpAssist !== false,
                  respawnPoint: respawnPoint, paceMult: 1, latMult: 1 });
      c.events = null;
      return c;
    };
    session.time = function () { return sess.t; };
    session.getPhase = function () { return sess.phase; };
    session.alpha = function () { return clamp01(sess.acc / STEP); };
    session.setPlayerAutopilot = function (b) { sess.autopilot = !!b; };
    session.setAssist = function () { return 'player'; };    // no steering assist in arcade (kept for callers; no-op)
    session.setAssists = function () {};
    /** CB.arcade.mode's gameplay extension hands its CB.arcade.gameplay instance over (arcade-layer attach): special
        features award nitro through it (stars, rings of fire, bumpers, drift zones). */
    session.bindGameplay = function (g) { boundGp = g && typeof g.addNitro === 'function' ? g : null; return !!boundGp; };
    session.features = Fe;
    session.getState = getState;
    session.setState = setState;
    session.cars = function () { return sess.cars; };
    session.player = function () { return sess.player; };
    session.applyBoost = api.applyBoost; session.spinOut = api.spinOut; session.addNitro = api.addNitro;
    session.spawn = spawn; session.despawn = despawn; session.entities = function () { return sess.entities; };
    session.playerState = function () {
      var c = sess.player; if (!c) return null;
      return { speed: Math.abs(c.v), s: c.s, lateral: c.lat, psi: c.psi, mode: c.mode, airborne: c.mode === 'air', onTrack: c.mode !== 'respawn', heading: 0, steerAngle: c.steerAngle, rpm: c.rpm, gear: c.gear };
    };
    init();
    return session;
  }

  /** ARCADE-SPEC §4: race-ui asks CB.arcade.stunt.createRenderer(canvas, session, opts) for stunt tracks. */
  function createRenderer(canvas, session, opts) {
    var Rn = S.renderer;
    if (!Rn || typeof Rn.create !== 'function' || (typeof Rn.isSupported === 'function' && !Rn.isSupported())) return null;
    opts = Object.assign({}, opts || {});
    if (!opts.quality || opts.quality === 'auto') {
      var Dv = CB.device;
      opts.quality = Dv && typeof Dv.autoTier === 'function' ? Dv.autoTier() : 'high';
    }
    return Rn.create(canvas, session, opts);
  }
  S.createRenderer = createRenderer;
  S.createSession = createSession;
  S.normInput = normInput;
  S.STEP = STEP;
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
})(CB.arcade.stunt);

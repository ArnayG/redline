/* ==========================================================================
   Redline — js/derby/derby-session.js
   CB.derby.session : one Demolition Derby match (docs/DERBY-SPEC.md §7).

     create(cfg) -> session { cfg, arena, update(dt, input), step(input), snapshot(), results(), getState(), setState(st),
                              restart(), destroy(), setPlayerAutopilot(on), spectateTargets(), world, _cars }
     DIFFICULTY, AI_NAMES, makeGrid(cfg) (pure), DT

   Fixed 1/120 s steps, seeded mulberry32 RNG, no Math.random: the same cfg + input stream reproduces a match exactly,
   and getState() / setState() round-trip it as JSON. Node-loadable (needs derby-arenas / physics / damage /
   accessories; derby-ai optional — without it AI cars just charge at the player).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.derby = CB.derby || {};

(function () {
  'use strict';
  var DT = 1 / 120, MAX_STEPS = 10;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function mulberry(seed) {
    var st = { s: (seed >>> 0) || 0x9e3779b9 };
    var f = function () {
      st.s = (st.s + 0x6D2B79F5) >>> 0;
      var t = st.s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.state = st;
    return f;
  }
  var PH = function () { return CB.derby.physics; };
  var DM = function () { return CB.derby.damage; };
  var AC = function () { return CB.derby.accessories; };
  var AR = function () { return CB.derby.arenas; };

  var DIFFICULTY = {
    rookie: { label: 'Rookie', playerTaken: 0.55, aimAssist: 1, aiDealt: 0.75, aiSkill: 0.45, aiAggro: 0.75 },
    amateur: { label: 'Amateur', playerTaken: 0.68, aimAssist: 0.8, aiDealt: 0.9, aiSkill: 0.65, aiAggro: 0.88 },
    pro: { label: 'Pro', playerTaken: 0.88, aimAssist: 0.45, aiDealt: 1, aiSkill: 0.82, aiAggro: 1 },
    alien: { label: 'Alien', playerTaken: 1.1, aimAssist: 0, aiDealt: 1.12, aiSkill: 1, aiAggro: 1.15 }
  };
  var AI_NAMES = ['Dmitri "Dozer" Kowalski', 'Rusty "Rivets" Mendez', 'Kofi "Crash" Okafor', 'Freya "Brick" Lindqvist', 'Kaito "Moose" Tanaka', 'Jill "Scrapper" Jensen',
    'Ivan "Smash" Petrov', 'Rhea "Wrecker" Vance', 'Lou "Tank" Ferriday', 'Hana "Tinman" Haas', 'Diego "Nails" Romero', 'Mei "Bumper" Bao', 'Grace "Grinder" Holt', 'Bastien "Dent" Dubois'];
  var SHORT = function (n) { var m = /"([^"]+)"/.exec(n); return m ? m[1].toUpperCase() : String(n).split(' ')[0].toUpperCase().slice(0, 8); };
  var COLORS = ['#d23a2a', '#2a6fd2', '#e0b21a', '#2aa860', '#8a3ad2', '#e06a1a', '#1ab0c0', '#c0c0c0', '#d23a8a', '#5a8a2a', '#c07a3a', '#3a3a3a'];

  function presetIds() { var D = CB.data; return D && Array.isArray(D.presets) ? D.presets.map(function (p) { return p.id; }) : []; }
  function presetBuild(id) {
    var D = CB.data;
    if (!D) return null;
    try { if (typeof D.presetBuild === 'function') return D.presetBuild(id); } catch (e) { /* ignore */ }
    return typeof D.defaultBuild === 'function' ? D.defaultBuild() : null;
  }
  function presetName(id) { var D = CB.data, p = D && D.presets ? D.presets.filter(function (x) { return x.id === id; })[0] : null; return p ? p.name : id; }

  /** deterministic AI grid: presets + loadouts picked by the seed (pure) */
  function makeGrid(cfg) {
    var rng = mulberry((num(cfg.seed, 1) ^ 0x5bd1e995) >>> 0);
    var n = clamp(Math.round(num(cfg.opponents, 7)), 1, 11);
    var ids = presetIds(), out = [];
    var pool = ids.filter(function (id) { return id !== (cfg.player && cfg.player.presetId); });
    var names = AI_NAMES.slice(), loads = AC() ? AC().PRESETS.filter(function (p) { return p.items.length; }) : [];
    for (var i = 0; i < n; i++) {
      var given = cfg.ai && cfg.ai[i];
      if (!pool.length) pool = ids.slice();
      var pid = given && given.presetId ? given.presetId : pool.splice(Math.floor(rng() * pool.length), 1)[0];
      var nm = given && given.name ? given.name : names.splice(Math.floor(rng() * names.length), 1)[0] || ('Driver ' + (i + 2));
      var lo = given && given.accessories ? given.accessories : loads.length ? loads[Math.floor(rng() * loads.length)].items.slice() : [];
      // rookies get lighter loadouts
      if (!given && cfg.difficulty === 'rookie' && lo.length > 2) lo = lo.slice(0, 2);
      out.push({ presetId: pid, name: nm, color: given && given.color || COLORS[(i + 1) % COLORS.length], accessories: lo, build: given && given.build || null });
    }
    return out;
  }

  /* ================================================================== create */
  function create(cfg) {
    cfg = Object.assign({ arenaId: 'mud-bowl', seed: 1, difficulty: 'pro', opponents: 7, rules: {}, countdown_s: 3 }, cfg || {});
    cfg.rules = Object.assign({ timeLimit_s: 0, lives: 1, teams: false }, cfg.rules || {});
    var arena = AR().get(cfg.arenaId) || AR().get(AR().DEFAULT);
    var diff = DIFFICULTY[cfg.difficulty] || DIFFICULTY.pro;
    var S = { cfg: cfg, arena: arena };
    var specCache = {};
    var world, cars, brains, autopilot = !!cfg.playerAutopilot, pendingInput = null, acc = 0;

    function specFor(build, key, accIds) {
      var base = key && specCache[key];
      if (!base) { base = PH().specFromBuild(build); if (key) specCache[key] = base; }
      return PH().withMass(base, AC().massOf(accIds), AC().reachOf(accIds));
    }
    function makeCar(i, ent) {
      var build = ent.build || presetBuild(ent.presetId) || (CB.data && CB.data.defaultBuild ? CB.data.defaultBuild() : {});
      var car = {
        id: i === 0 ? 'player' : 'ai' + i, idx: i, isPlayer: i === 0, name: ent.name || ('Driver ' + (i + 1)), presetId: ent.presetId || null,
        color: ent.color || COLORS[i % COLORS.length], accent: ent.accent || '#111111', number: i + 1, build: build, team: cfg.rules.teams ? (i % 2) : null,
        accIds: AC().sanitize(ent.accessories || [])
      };
      car.short = car.isPlayer ? 'YOU' : SHORT(car.name);
      car.spec = specFor(build, (ent.presetId || 'b' + i) + '|' + (ent.build ? i : ''), car.accIds);
      resetCar(car, i);
      car.lives = Math.max(1, Math.round(num(cfg.rules.lives, 1)));
      car.stats = { dealt: 0, taken: 0, hits: 0, bigHits: 0, kills: 0, tbones: 0, rams: 0, wallHits: 0, flameDmg: 0, maxImpact: 0, airTime: 0, survived_s: 0, launches: 0, score: 0, sandwiches: 0, revenge: 0, boostHits: 0, bestCombo: 0, pickups: 0 };
      return car;
    }
    function resetCar(car, i) {
      var sp = arena.spawns[i % arena.spawns.length];
      PH().createBody(car, { x: sp.x, y: sp.y, heading: sp.heading, z: 0 });
      car.dmg = DM().create();
      car.alive = true; car.out = false; car.elimReason = null; car.elimT = null; car.immobileT = 0; car.flippedT = 0;
      car.lastHitBy = null; car.lastHitT = -99; car.respawnT = 0; car.invulnT = 0; car.input = { throttle: 0, brake: 0, steer: 0, handbrake: false, action1: false, action2: false };
      car.contactT = {}; car.hazT = 0; car.crushT = 0;
      car.ram = { charge: 1, active: false };
      car.lastActT = world ? world.t : 0; car.idle = false; car.idleT = 0; car.wedgeT = 0; car.wedgeX = car.x; car.wedgeY = car.y; car.wedgeN = 0; car.resetT = 0; car.resetCd = 0;
      car.combo = 0; car.comboT = -9; car.lastWallT = -9; car.touch = {}; car.kickSeen = {}; car.stallT = 0; car.pickupArmorT = 0; car.bombT = 0; car.ringT = 0;
      AC().create(car, car.accIds);
    }

    function init() {
      var rng = mulberry(num(cfg.seed, 1));
      var grid = makeGrid(cfg);
      var pl = cfg.player || {};
      var ents = [{ presetId: pl.presetId || (presetIds()[0] || null), build: pl.build || null, name: pl.name || 'You', color: pl.color || null, accessories: pl.accessories || [] }].concat(grid);
      if (!ents[0].color) {
        var b0 = ents[0].build || presetBuild(ents[0].presetId);
        ents[0].color = (b0 && b0.exterior && b0.exterior.paint) || '#d23a2a';
      }
      world = null;
      cars = ents.map(function (e, i) { return makeCar(i, e); });
      world = {
        t: 0, tick: 0, arena: arena, cars: cars, rng: rng, phase: 'countdown', countdown: num(cfg.countdown_s, 3), events: [], feed: [], entities: [],
        evId: 0, entId: 0, pairT: {}, pairGhost: {}, elimOrder: [], winnerId: null, overT: 0, slowmo: 0, lastCount: -1, damage: DM(), diff: diff, tauntT: -9, sd: safeScaleAt(0, cfg.rules)
      };
      world.emit = function (ev) {
        ev.id = ++world.evId; ev.t = r3(world.t); world.events.push(ev); if (world.events.length > 400) world.events.splice(0, world.events.length - 400);
        if (ev.type === 'launch' && ev.carId) { var lc = world.byId(ev.carId), lv = world.byId(ev.otherId); if (lc) { lc.stats.launches++; award(lc, lv, 'LAUNCHED', 200); } }
        return ev;
      };
      world.feedLine = function (text, kind, a, b) { var f = { t: r3(world.t), text: text, kind: kind || 'info', carId: a || null, otherId: b || null }; world.feed.push(f); if (world.feed.length > 30) world.feed.shift(); return f; };
      world.feed_ = world.feedLine;
      world.addEntity = function (e) { e.id = 'e' + (++world.entId); world.entities.push(e); return e; };
      world.byId = function (id) { for (var i = 0; i < cars.length; i++) if (cars[i].id === id) return cars[i]; return null; };
      world.impulse = function (c, jx, jy, px, py) { PH().applyImpulse(c, jx, jy, px, py); };
      world.pointVel = function (c, px, py) { return PH().pointVel(c, px, py); };
      world.hurt = hurt;
      world.surfaceAt = function (x, y) { return PH().surfaceAt(arena, x, y, world.t); };
      world.raycast = function (x, y, dx, dy, md, ign) { return PH().raycast(world, x, y, dx, dy, md, ign); };
      world.edgeInfo = function (x, y) { return PH().edgeInfo(arena, x, y); };
      // accessories call world.feed(...)
      world.feed = world.feed;   // array (snapshot); the function lives on world.say
      brains = {};
      var AI = CB.derby.ai;
      cars.forEach(function (c) {
        if (AI && typeof AI.create === 'function' && (!c.isPlayer || autopilot)) brains[c.id] = AI.create(c, { difficulty: cfg.difficulty, rng: mulberry((num(cfg.seed, 1) * 31 + c.idx * 977) >>> 0), skill: diff.aiSkill, aggro: diff.aiAggro });
      });
      world.emit({ type: 'countdown', n: Math.ceil(world.countdown) });
      var PK = CB.derby.pickups;
      pkRng = mulberry((num(cfg.seed, 1) * 131 + 17) >>> 0);
      pickups = PK && typeof PK.create === 'function' && cfg.pickups !== false ? PK.create(arena, pkRng) : null;
    }
    var pickups = null, pkRng = null, pkCache = [], pkCacheTick = -1;
    // accessories expect world.feed(text, kind, a, b) as a function: give them a facade
    function facade() {
      return {
        get t() { return world.t; }, arena: arena, get cars() { return cars; }, rng: world.rng, emit: world.emit, feed: world.feedLine, addEntity: world.addEntity,
        get entities() { return world.entities; }, hurt: hurt, impulse: world.impulse, pointVel: world.pointVel, damage: DM(), byId: world.byId,
        get suddenDeath() { return world.sd; }, get phase() { return world.phase; }, get pickups() { if (!pickups) return []; if (pkCacheTick !== world.tick) { pkCacheTick = world.tick; pkCache = pickups.entities(); } return pkCache; }, get fightT() { return world.fightT0 != null ? world.t - world.fightT0 : 0; },
        raycast: world.raycast, edgeInfo: world.edgeInfo, surfaceAt: world.surfaceAt, safeAt: function (x, y, margin) { return safeDist(x, y) > num(margin, 0); }
      };
    }
    var F = null;

    /** damage from accessories / hazards: returns health lost. byCar credited. */
    function hurt(target, zone, amount, byCar, kind, opts) {
      if (!target || target.out || !(amount > 0)) return 0;
      if (target.invulnT > 0 || world.phase !== 'fight') return 0;
      var m = AC().modifier(target, zone === 'all' || zone === 'wheels' ? 'all' : zone, 'taken');
      if (byCar && byCar !== target) m *= byCar.isPlayer ? 1 : diff.aiDealt;
      if (target.isPlayer) m *= diff.playerTaken;
      m *= suddenDeath();
      if (target.pickupArmorT > 0) m *= 0.5;
      if (!(m > 0)) return 0;
      var lost = DM().addZone(target, zone, amount * m, opts);
      target.stats.taken += lost;
      if (byCar && byCar !== target) { byCar.stats.dealt += lost; target.lastHitBy = byCar.id; target.lastHitT = world.t; if (lost > 0.01) { byCar.lastActT = world.t; target.lastActT = world.t; world.lastSigT = world.t; } }
      return lost;
    }

    /* ---------------------------------------------------------------- per-step */
    function stepOnce(playerInput) {
      var W = world, dt = DT;
      if (!F) F = facade();
      W.tick++;
      W.t = W.tick * DT;
      if (W.phase === 'countdown') {
        W.countdown -= dt;
        var n = Math.ceil(W.countdown);
        if (n !== W.lastCount && n > 0) { W.lastCount = n; if (W.tick > 1) W.emit({ type: 'countdown', n: n }); }
        if (W.countdown <= 0) { W.phase = 'fight'; W.fightT0 = W.t; W.emit({ type: 'go' }); W.feedLine('Last car standing wins!', 'info'); }
      }
      var fighting = W.phase === 'fight' || W.phase === 'over';
      // inputs
      cars.forEach(function (c) {
        var inp;
        if (c.out) inp = { throttle: 0, brake: 0.12, steer: 0, handbrake: false, action1: false, action2: false };   // wrecks are pushable shells
        else if (c.isPlayer && !autopilot) inp = playerInput || pendingInput || c.input;
        else if (cfg.aiDisabled && !c.isPlayer) inp = c.scriptInput || { throttle: 0, brake: 0, steer: 0, handbrake: false, action1: false, action2: false };   // tests
        else if (brains[c.id]) inp = brains[c.id].think(F, c, dt);
        else inp = fallbackAI(c);
        if (!fighting) inp = { throttle: inp.throttle || 0, brake: 0, steer: inp.steer || 0, handbrake: true, action1: false, action2: false, hold: true };
        c.input = inp;
      });
      // drive
      cars.forEach(function (c) {
        var mods = c.out ? { noDrive: true, gripMult: [0.9, 0.9, 0.9, 0.9] } : DM().effects(c);
        // post-hit slide: the shoved car's tyres let go for a moment, so knock-back carries it metres away (and spins it)
        if (c.slideT > 0) {
          c.slideT -= dt;
          var gS = mods.gripMult || [1, 1, 1, 1], kS = c.slideT > 0.15 ? 0.22 : 0.6;
          mods.gripMult = [gS[0] * kS, gS[1] * kS, gS[2] * kS, gS[3] * kS];
        }
        // humans keep punchy acceleration: >= 75 % power until 25 % health (then 50 %); top speed / handling still degrade
        if (c.isPlayer && !c.out && !mods.noDrive) mods.powerMult = Math.max(num(mods.powerMult, 1), c.dmg.health > 0.25 ? 0.75 : 0.5);
        // launch kick: every car pulls hard out of a standstill after a crash (the scrum clears, run-ups happen)
        if (!c.out && Math.abs(num(c.u, 0)) < 12) mods.accelMult = num(mods.accelMult, 1) * (c.isPlayer ? 1.4 : 1.25);
        if (!c.out) AC().driveMods(c, mods);
        if (c.input.hold) { mods.noDrive = true; c.vx = 0; c.vy = 0; c.w = 0; c.gear = 1; }
        ramBoost(c, mods, dt, fighting);
        // oil slicks / caltrops under the car
        entityEffects(c, mods, dt);
        PH().drive(F, c, c.input, mods, dt);
        if (c.isPlayer && !autopilot && fighting && !c.out) { ramAssist(c, dt); humanFeel(c, dt); }
        if (fighting && !c.out) lowSpeedPivot(c, dt);
        if (c.justLanded) {
          var lv = c.justLanded; c.justLanded = 0;
          // big air (the player): airborne > 0.7 s and landed upright
          if (c.isPlayer && fighting && !c.out && !c.flipped && num(c.airT, 0) > 0.7) { var huge = c.airT > 1.3; award(c, null, huge ? 'HUGE AIR' : 'BIG AIR', huge ? 250 : 100, true); W.emit({ type: 'big-air', carId: c.id, air: +c.airT.toFixed(2), x: c.x, y: c.y, z: c.z }); }
          if (lv > 7 && fighting && !c.out) {
            var l = DM().addZone(c, 'wheels', (lv - 7) * 0.04, {});
            c.stats.taken += l;
            W.emit({ type: 'land', carId: c.id, x: c.x, y: c.y, z: c.z, energy: lv, big: lv > 9 });
          }
          if (c.flipped) { W.emit({ type: 'flip', carId: c.id, x: c.x, y: c.y }); if (c.isPlayer && W.t - num(c.roofMsgT, -99) > 12) { c.roofMsgT = W.t; W.feedLine('On your roof!', 'info', c.id); } }
        }
        if (c.airborne) c.stats.airTime += dt;
      });
      // contacts: car-car (each pair once), then the arena
      for (var i = 0; i < cars.length; i++) {
        for (var j = i + 1; j < cars.length; j++) {
          var a = cars[i], b = cars[j], pk = a.id + '|' + b.id;
          if (a.ghostT > 0 || b.ghostT > 0 || num(W.pairGhost[pk], -1) > W.t) continue;
          var ct = PH().collideCars(a, b, { restitution: 0.3, friction: 0.3, massMultA: a.shieldT > 0 ? 3 : 1, massMultB: b.shieldT > 0 ? 3 : 1 });
          if (ct) {
            carContact(ct, dt);
            // ARCADE BOUNCE: ricochet apart, attacker keeps its momentum, victim shoved / spun / hopped; a pair that
            // stays in contact > 0.22 s (wedged, both pushing) is popped apart and ghosted for 0.35 s
            var pt = W.pairT[pk];
            if (pt && W.t - pt.t < 0.03) pt.dur += dt; else pt = W.pairT[pk] = { t: W.t, dur: 0 };
            pt.t = W.t;
            var attA = ct.aIn >= ct.bIn, att0 = attA ? a : b, grind = pt.dur > 0.22 && a.speed < 4.5 && b.speed < 4.5;
            var follow = !!(att0.ram && att0.ram.active);
            var vic0 = att0 === a ? b : a;
            if (ct.vn > 3) { a.hitSpinT = W.t; b.hitSpinT = W.t; }
            if (ct.vn > 3) {
              // human hits send the victim flying (room for the next run-up); a hit human slides briefly but keeps control
              var sl = clamp(0.3 + ct.vn * 0.035, 0.3, 1.0) + (att0.isPlayer ? 0.35 : 0);
              vic0.slideT = Math.max(num(vic0.slideT, 0), vic0.isPlayer ? Math.min(0.35, sl) : sl); att0.slideT = Math.max(num(att0.slideT, 0), 0.1);
            }
            PH().arcadeBounce(a, b, ct, { attacker: att0, e: 0.55, minSep: grind ? 6.5 : ct.vn > 1.5 ? 4.6 + Math.min(3, ct.vn * 0.12) + (att0.isPlayer ? 3 : 0) : 0.25, attMass: 2.6, follow: follow, hop: fighting, spin: 1.6 });
            // follow-through: when YOU ram, you keep ~80 % of your speed and punch through (the victim flies off)
            if (ct.vn > 4 && !grind && !att0.out) {   // AI attackers carry through too (55 %): they bounce off and come again
              var human = att0.isPlayer && !autopilot;
              var hc = Math.cos(att0.heading), hs = Math.sin(att0.heading), uNow = att0.vx * hc + att0.vy * hs, uWant = (human ? 0.8 : 0.55) * num(att0.u, 0);
              if (uWant > uNow && uWant > 0) { att0.vx += hc * (uWant - uNow); att0.vy += hs * (uWant - uNow); }
              W.pairGhost[pk] = W.t + (human ? 0.3 : 0.2);
            }
            if (grind) { W.pairGhost[pk] = W.t + 0.35; pt.dur = 0; W.emit({ type: 'unstick', carId: a.id, otherId: b.id, pair: true, x: ct.px, y: ct.py, z: a.z + 0.4 }); }
            else if (follow && ct.vn > 8) W.pairGhost[pk] = W.t + 0.22;
          }
        }
      }
      cars.forEach(function (c) {
        var cts = PH().collideArena(F, c);
        cts.forEach(function (ct) { arenaContact(c, ct); });
      });
      // accessories, damage ticks, hazards, elimination
      cars.forEach(function (c) {
        AC().step(F, c, fighting ? c.input : {}, dt);
        if (c.invulnT > 0) c.invulnT -= dt;
        if (c.ghostT > 0) c.ghostT -= dt;
        if (!c.out && fighting) {
          var evs = DM().tick(c, dt, { throttle: c.throttle, rng: W.rng });
          evs.forEach(function (e) { e.carId = c.id; e.x = c.x; e.y = c.y; e.z = c.z + 0.9; W.emit(e); if (c.isPlayer && e.type === 'stall') W.feedLine('Engine dead! You are a sitting duck…', 'info', c.id); if (c.isPlayer && e.type === 'fire') W.feedLine('You are on fire!', 'info', c.id); });
          hazards(c, dt);
          flipRecovery(c, dt);
          unwedge(c, dt);
          idleCheck(c, dt);
          if (c.pickupArmorT > 0) c.pickupArmorT -= dt;
          if (c.bombT > 0) c.bombT -= dt;
          c.stats.survived_s = W.t - (W.fightT0 || 0);
          checkElim(c, dt);
        } else if (c.out) {
          c.dmg.engine.smoke = Math.max(c.dmg.engine.smoke, 0.6);
          if (c.respawnT > 0 && c.lives > 0) { c.respawnT -= dt; if (c.respawnT <= 0) respawn(c); }
        }
      });
      if (pickups && W.phase === 'fight') pickups.step(F, dt);
      // entities age
      for (var k = W.entities.length - 1; k >= 0; k--) { var e = W.entities[k]; e.life -= dt; if (e.armT > 0) e.armT -= dt; if (e.life <= 0) W.entities.splice(k, 1); }
      if (W.slowmo > 0) W.slowmo = Math.max(0, W.slowmo - dt * 1.5);
      // near misses (the player): flash past a car within ~1 m at > 12 m/s relative without touching it
      var NP = cars[0];
      if (W.phase === 'fight' && !NP.out && W.tick % 6 === 0) cars.forEach(function (o) {
        if (o === NP || o.out) return;
        var dx = o.x - NP.x, dy = o.y - NP.y, d = Math.hypot(dx, dy), gap = d - (NP.spec.width + o.spec.width) / 2;
        if (gap > 1.1 || gap < 0.15 || d > (NP.spec.length + o.spec.length) / 2) return;
        var rv = Math.hypot(o.vx - NP.vx, o.vy - NP.vy);
        if (rv < 12 || W.t - num(NP.touch && NP.touch[o.id], -9) < 0.6 || W.t - num(NP.nearMissT, -9) < 2) return;
        NP.nearMissT = W.t; NP.pendingNear = { id: o.id, t: W.t };
      });
      if (NP.pendingNear && W.t - NP.pendingNear.t > 0.4) {   // confirmed only if no contact followed
        var pn = NP.pendingNear; NP.pendingNear = null;
        if (W.t - num(NP.touch && NP.touch[pn.id], -9) > 0.45) { var oN = W.byId(pn.id); award(NP, oN, 'NEAR MISS', 50, true); W.emit({ type: 'near-miss', carId: NP.id, otherId: pn.id, x: NP.x, y: NP.y, z: NP.z }); }
      }
      // lonely player failsafe: nobody within 25 m of the player for 5 s -> the nearest AI is sent at them
      var P0 = cars[0];
      if (W.phase === 'fight' && !P0.out && W.tick % 12 === 0) {
        var nearest = null, nd = 1e9, crowd = false;
        cars.forEach(function (o) { if (o === P0 || o.out) return; var d = Math.hypot(o.x - P0.x, o.y - P0.y); if (d < 25) crowd = true; if (d < nd && brains[o.id]) { nd = d; nearest = o; } });
        W.lonelyT = crowd ? 0 : num(W.lonelyT, 0) + 0.1;
        if (W.lonelyT > 4 && nearest) { var nb = brains[nearest.id]; nb.target = P0.id; nb.retargetT = 5; nearest.aiTarget = P0.id; if (nb.mode === 'ambush') nb.mode = 'hunt'; W.lonelyT = 2; }
        // action director: no crunch at / near the player for 3 s -> the nearest free AI comes for the player
        // (a second one after 5 s), retargeted for 5 s with a fresh ram meter, boosting + leading the intercept
        W.pQuietT = num(W.pQuietT, 0) + 0.1;
        if (W.pQuietT > 2.6) {
          var want = W.pQuietT > 5 ? 2 : 1, have = 0, pool = [];
          cars.forEach(function (o) { if (o === P0 || o.out || !brains[o.id]) return; if (o.aiTarget === P0.id && W.t - num(o.directT, -9) < 5) have++; else pool.push(o); });
          pool.sort(function (x, y) { return Math.hypot(x.x - P0.x, x.y - P0.y) - Math.hypot(y.x - P0.x, y.y - P0.y); });
          for (var q = 0; q < pool.length && have < want; q++) {
            var o2 = pool[q], b2 = brains[o2.id];
            b2.target = P0.id; b2.retargetT = 5; o2.aiTarget = P0.id; o2.directT = W.t; b2.engageT = 0; b2.pickT = 99;
            if (b2.mode === 'ambush' || b2.mode === 'backoff') b2.mode = 'hunt';
            o2.ram.charge = Math.max(o2.ram.charge, 1);
            have++;
          }
        }
      }
      // lull failsafe: 9 s without a real hit anywhere after 35 s of fighting -> sudden death starts now
      if (W.phase === 'fight' && cfg.rules.suddenDeath !== false && W.sdStart == null) {
        var ftL = W.t - (W.fightT0 || 0);
        if (ftL > 35 && W.t - num(W.lastSigT, W.fightT0 || 0) > 9 && ftL < num(cfg.rules.suddenDeathAt, 75)) { W.sdStart = ftL; W.feedLine('The crowd is bored — SUDDEN DEATH comes early!', 'info'); }
      }
      W.sd = safeScaleAt(W.phase === 'countdown' ? 0 : W.t - (W.fightT0 || 0), cfg.rules, W.sdStart);
      rules(dt);
    }

    /** human ram assist (arcade derby games all do this): while charging at a car ahead, the travel direction bends
        toward it a little, so a human's wobbly approach still lands the hit. Scaled by difficulty (none on Alien). */
    function ramAssist(c, dt) {
      var k = num(diff.aimAssist, 0.5) * num(cfg.aimAssist, 1);
      if (!(k > 0) || c.airborne || c.flipped) return;
      var sp = Math.hypot(c.vx, c.vy);
      if (sp < 6 || num(c.u, 0) < 4 || !(c.input && (c.input.throttle > 0.4 || c.input.boost))) return;
      var vx = c.vx / sp, vy = c.vy / sp, best = null, bs = 0;
      cars.forEach(function (o) {
        if (o === c || o.out) return;
        var dx = o.x - c.x, dy = o.y - c.y, d = Math.hypot(dx, dy);
        if (d > 22 || d < 2.5) return;
        var cosA = (dx * vx + dy * vy) / d;
        if (cosA < 0.82) return;
        var sc = cosA * (1 - d / 26);
        if (sc > bs) { bs = sc; best = o; }
      });
      if (!best) return;
      var tx = best.x + best.vx * 0.25 - c.x, ty = best.y + best.vy * 0.25 - c.y;
      var err = PH()._.wrap(Math.atan2(ty, tx) - Math.atan2(vy, vx));
      var rot = clamp(err, -1, 1) * Math.min(1, 1.6 * k * dt * 3) * 0.5;
      var cr = Math.cos(rot), sr = Math.sin(rot);
      var nvx = c.vx * cr - c.vy * sr, nvy = c.vx * sr + c.vy * cr;
      c.vx = nvx; c.vy = nvy; c.heading = PH()._.wrap(c.heading + rot * 0.8);
    }

    /** human feel: J-turn assist (handbrake + steer swings the car round fast), post-hit spin settles within ~0.5 s,
        strong instant reverse when nose-in against something */
    function humanFeel(c, dt) {
      var inp = c.input || {}, sp = Math.hypot(c.vx, c.vy), st = num(inp.steer, 0);
      if (c.airborne || c.flipped) return;
      if (inp.handbrake && Math.abs(st) > 0.35 && sp > 4) {
        c.jturnT = num(c.jturnT, 0) + dt;
        if (c.jturnT < 0.75) {
          var wT = (st > 0 ? 1 : -1) * 3.6;
          c.w += clamp(wT - c.w, -10 * dt, 10 * dt);
          // keep the speed through the swing (no scrub to a standstill)
          var k = 1 - 0.6 * dt; c.vx *= k + (1 - k) * 0.4; c.vy *= k + (1 - k) * 0.4;
        }
      } else c.jturnT = 0;
      // spin from a hit settles quickly once the player steers / accelerates again
      var sinceHit = world.t - num(c.hitSpinT, -9);
      if (sinceHit > 0.3 && sinceHit < 1.5 && Math.abs(c.w) > 2.2 && !inp.handbrake) c.w *= 1 - 3.5 * dt;
    }

    /** arcade pivot: below ~8 m/s a car can still swing its nose round on the throttle (real cars barely turn when slow,
        which is what made post-crash recovery feel stuck); the velocity turns with the nose so it carves, not slides */
    function lowSpeedPivot(c, dt) {
      var inp = c.input || {}, st = num(inp.steer, 0), u = num(c.u, 0), sp = Math.hypot(c.vx, c.vy);
      if (c.airborne || c.flipped || sp > 8 || Math.abs(st) < 0.25) return;
      var pushing = num(inp.throttle, 0) > 0.3 || num(inp.brake, 0) > 0.3;
      if (!pushing) return;
      var dir = c.gear < 0 ? -1 : 1, k = 1 - sp / 8;
      var wT = st * 2.6 * dir * (0.55 + 0.45 * k) * (c.isPlayer ? 1.15 : 1);
      var dw = clamp(wT - c.w, -9 * dt, 9 * dt) * k;
      c.w += dw;
      var rot = dw * dt * 0.0 + c.w * dt * 0.35 * k, cr = Math.cos(rot), sr = Math.sin(rot);
      var vx = c.vx * cr - c.vy * sr, vy = c.vx * sr + c.vy * cr; c.vx = vx; c.vy = vy;
      void u;
    }

    function fallbackAI(c) {
      var p = cars[0], dx = p.x - c.x, dy = p.y - c.y;
      var want = Math.atan2(dy, dx), err = PH()._.wrap(want - c.heading);
      return { throttle: 0.9, brake: 0, steer: clamp(err * 2, -1, 1), handbrake: false, action1: false, action2: false };
    }

    function entityEffects(c, mods, dt) {
      var E = world.entities;
      for (var i = 0; i < E.length; i++) {
        var e = E[i];
        if (e.type !== 'oil' && e.type !== 'caltrops') continue;
        if (Math.hypot(c.x - e.x, c.y - e.y) > e.r + c.spec.length * 0.3 || Math.abs(c.z - e.z) > 1 || c.airborne) continue;
        if (e.owner === c.id && e.armT > 0) continue;
        if (e.type === 'oil') {
          var g = mods.gripMult || [1, 1, 1, 1];
          mods.gripMult = [g[0] * 0.18, g[1] * 0.18, g[2] * 0.18, g[3] * 0.18];
          if (!e.hit[c.id]) { e.hit[c.id] = 1; c.w += (world.rng() < 0.5 ? -1 : 1) * clamp(c.speed * 0.06, 0.4, 1.8); world.emit({ type: 'oil', carId: c.id, slip: true, x: c.x, y: c.y }); if (c.isPlayer) world.feedLine('Oil! You hit a slick', 'info', c.id); }
        } else if (!e.hit[c.id] && !c.out) {
          e.hit[c.id] = 1;
          var owner = world.byId(e.owner);
          // the two wheels that roll over it first
          var lost = 0;
          for (var w = 0; w < 4; w++) if (world.rng() < 0.55 || w === 0) lost += hurt(c, 'wheels', 0.8, owner, 'caltrops', { wheel: w });
          world.emit({ type: 'puncture', carId: c.id, otherId: e.owner, x: c.x, y: c.y, caltrops: true });
          if (c.isPlayer) world.feedLine('Caltrops! Tyres punctured', 'info', c.id);
          void lost;
        }
      }
    }

    function hazards(c, dt) {
      var s = PH().surfaceAt(arena, c.x, c.y, world.t);
      if (s.dps > 0 && !c.airborne) { hurt(c, 'all', s.dps * dt * 2.4, null, 'fire'); if (c.dmg.onFire < 0.5 && c.shieldT <= 0) { c.dmg.onFire = 0.5; c.dmg.burnT = 3; world.emit({ type: 'fire', carId: c.id, x: c.x, y: c.y }); } }
      if (s.crush > 0.6) {
        c.crushT += dt;
        if (c.crushT > 0.2) { var l = hurt(c, 'all', 1.4 * dt, null, 'crusher'); if (!c.crushEv || world.t - c.crushEv > 0.8) { c.crushEv = world.t; world.emit({ type: 'impact', carId: c.id, x: c.x, y: c.y, z: c.z + 1.2, energy: 90000, big: true, crusher: true }); if (c.isPlayer) world.feedLine('THE CRUSHER! Get out!', 'info', c.id); } void l; }
        c.vx *= 0.97; c.vy *= 0.97;
      } else c.crushT = 0;
      // pusher pads: one shove per firing
      if (s.kick && !c.airborne && c.kickSeen[s.kick.id] !== s.kick.cycle) {
        c.kickSeen[s.kick.id] = s.kick.cycle;
        var ks = num(s.kick.strength, 8) * Math.sqrt(1500 / c.spec.mass);
        c.vx += num(s.kick.x, 0) * ks; c.vy += num(s.kick.y, 0) * ks; c.w += (world.rng() - 0.5) * 1.6; c.vz = Math.max(c.vz, 2.2); c.airborne = true; c.airT = 0;
        world.emit({ type: 'kick', carId: c.id, x: c.x, y: c.y, z: c.z, hazard: s.kick.id });
      }
      // sudden-death ring of fire: outside the shrinking safe area you burn and get pushed back in
      var sd = world.sd;
      if (sd && sd.on && sd.safeScale < 0.999) {
        var dIn = safeDist(c.x, c.y);
        if (dIn < 0) {
          c.ringT += dt;
          var lr = hurt(c, 'all', (0.07 + 0.07 * sd.level) * dt / DM().ZONE_HPP, null, 'ring'); void lr;
          if (c.dmg.onFire < 0.5 && c.shieldT <= 0) { c.dmg.onFire = 0.55; c.dmg.burnT = Math.max(c.dmg.burnT, 1.2); }
          var cl = Math.hypot(c.x, c.y) || 1;
          c.vx += -c.x / cl * 7 * dt; c.vy += -c.y / cl * 7 * dt;
          if (c.ringT > 0.5 && (!c.ringEv || world.t - c.ringEv > 2)) { c.ringEv = world.t; world.emit({ type: 'ring', carId: c.id, x: c.x, y: c.y }); if (c.isPlayer) world.feedLine('Get inside the ring — you are burning!', 'info', c.id); }
        } else c.ringT = 0;
      }
    }
    function flipRecovery(c, dt) {
      if (c.flipped) {
        c.flippedT += dt;
        if (c.flippedT > (c.isPlayer ? 0.8 : 1.2) || (c.input && c.input.reset && c.flippedT > 0.3)) {
          c.flipped = false; c.roll = 0; c.rollV = 0; c.pitch = 0; c.vz = 3; c.airborne = true; c.flippedT = 0; c.z += 0.3;
          var l = DM().addZone(c, 'all', 0.06 / DM().ZONE_HPP, {}); c.stats.taken += l;
          world.emit({ type: 'unflip', carId: c.id, x: c.x, y: c.y });
        }
      }
    }
    function checkElim(c, dt) {
      var reason = null;
      if (c.dmg.health <= 0) reason = 'wrecked';
      if (c.z < -6 || (c.overOpen && c.z < -2)) reason = 'fell';
      var moving = c.speed > 1.0;
      var trying = c.input && (c.input.throttle > 0.3 || c.input.brake > 0.3);
      if (c.dmg.engine.stalled && !moving) c.immobileT += dt * 1.0;
      else if (!moving && trying && !c.flipped) c.immobileT += dt * 0.6;
      else c.immobileT = Math.max(0, c.immobileT - dt * 2);
      if (c.dmg.engine.stalled) c.stallT += dt; else c.stallT = 0;
      if (c.dmg.engine.stalled && (c.stallT > 2.5 || c.immobileT > 2)) reason = reason || 'engine';
      if (c.immobileT > 10) reason = reason || 'immobile';
      if (reason) eliminate(c, reason);
    }
    function eliminate(c, reason) {
      if (c.out) return;
      c.out = true; c.alive = false; c.elimReason = reason; c.elimT = world.t; c.lives--;
      c.dmg.engine.smoke = 1; c.dmg.engine.black = Math.max(c.dmg.engine.black, 0.8);
      var killer = c.lastHitBy && world.t - c.lastHitT < 8 ? world.byId(c.lastHitBy) : null;
      if (killer && killer !== c) { killer.stats.kills++; award(killer, c, 'TAKEDOWN', 500); if (c.isPlayer) taunt(killer, 'kill'); }
      world.elimOrder.push(c.id);
      var why = { wrecked: 'wrecked', fell: 'fell off the edge', engine: 'engine died', immobile: 'stuck', fire: 'burned out' }[reason] || reason;
      var text;
      if (c.isPlayer) text = killer ? 'You were wrecked by ' + killer.short + '!' : 'You are out — ' + why + '!';
      else if (killer && killer.isPlayer) text = 'You eliminated ' + c.short + '!';
      else text = c.short + ' is out' + (killer ? ' (' + killer.short + ')' : ' — ' + why);
      world.feedLine(text, 'kill', killer ? killer.id : null, c.id);
      world.emit({ type: 'eliminated', carId: c.id, otherId: killer ? killer.id : null, reason: reason, x: c.x, y: c.y, z: c.z + 1, big: true });
      if (reason === 'wrecked' || reason === 'fire') world.emit({ type: 'explode', carId: c.id, x: c.x, y: c.y, z: c.z + 0.8, big: true });
      world.slowmo = Math.max(world.slowmo, c.isPlayer || (killer && killer.isPlayer) ? 1 : 0.5);
      if (c.lives > 0) c.respawnT = 3;
    }
    function respawn(c) {
      // farthest spawn from every live car
      var best = 0, bd = -1;
      arena.spawns.forEach(function (sp, i) {
        var d = 1e9; cars.forEach(function (o) { if (o !== c && !o.out) d = Math.min(d, Math.hypot(o.x - sp.x, o.y - sp.y)); });
        if (d > bd) { bd = d; best = i; }
      });
      var lives = c.lives, stats = c.stats;
      resetCar(c, best);
      c.lives = lives; c.stats = stats; c.invulnT = 2.5;
      var idx = world.elimOrder.indexOf(c.id); if (idx >= 0) world.elimOrder.splice(idx, 1);
      world.emit({ type: 'respawn', carId: c.id, x: c.x, y: c.y });
      world.feedLine((c.isPlayer ? 'You are' : c.short + ' is') + ' back in (' + c.lives + (c.lives === 1 ? ' life' : ' lives') + ' left)', 'info', c.id);
    }

    function teamsAlive() {
      var t = {}; cars.forEach(function (c) { if (!c.out || c.respawnT > 0) t[cfg.rules.teams ? c.team : c.id] = 1; }); return Object.keys(t).length;
    }
    /** sudden death damage multiplier (see safeScaleAt): 1 -> 2 over the shrink */
    function suddenDeath() {
      var W = world;
      if (W.phase !== 'fight' || !W.sd || !W.sd.on) return 1;
      return W.sd.mult;
    }
    /** distance inside the sudden-death safe ring (> 0 inside; the arena boundary scaled about the origin) */
    function safeDist(x, y) {
      var sc = world && world.sd ? world.sd.safeScale : 1;
      if (sc >= 0.999) return 99;
      return AR().sdBoundary(arena, x / sc, y / sc).d * sc;
    }

    /* ---------------------------------------------------------------- ram boost (every car, input.boost held) */
    var RAM = { drain: 0.5, refill: 0.24, accel: 1.9, top: 1.28, push: 3.6, hitRefill: 0.3, dealt: 1.4 };
    function ramBoost(c, mods, dt, fighting) {
      var R = c.ram;
      var want = !!(c.input && c.input.boost) && fighting && !c.out && !c.flipped && !c.input.hold;
      if (want && R.charge > (R.active ? 0.01 : 0.12)) {
        if (!R.active) world.emit({ type: 'ram-boost', carId: c.id, x: c.x, y: c.y });
        R.active = true; R.charge = Math.max(0, R.charge - RAM.drain * dt);
        mods.accelMult = num(mods.accelMult, 1) * RAM.accel; mods.topMult = num(mods.topMult, 1) * RAM.top; mods.push = num(mods.push, 0) + RAM.push;
        // the shove works even with a crippled engine (it is the fun button)
        if (num(mods.powerMult, 1) < 0.7) mods.powerMult = 0.7;
      } else { R.active = false; R.charge = Math.min(1, R.charge + RAM.refill * dt); }
    }

    /* ---------------------------------------------------------------- anti-stalemate */
    /** wedged (pushing but not moving: pinned on a car / wreck / wall / deck side) -> push-off impulse */
    function unwedge(c, dt) {
      if (c.airborne || c.flipped || c.out) { c.wedgeT = 0; return; }
      var inp = c.input || {};
      var pushing = num(inp.throttle, 0) > 0.3 || num(inp.brake, 0) > 0.3 || !!inp.boost;
      if (c.resetCd > 0) c.resetCd -= dt;
      // R held on a stuck (not flipped) car: pop + nudge after 1 s
      if (inp.reset && c.speed < 2) c.resetT += dt; else c.resetT = 0;
      // car-on-car pin: touching another car, both slow, for a while (grinding) counts as wedged too
      var pinned = false;
      for (var id in c.touch) { if (world.t - c.touch[id] < 0.1) { var o = world.byId(id); if (o && o.speed < 3.5 && c.speed < 3.5) pinned = true; } }
      if (Math.hypot(c.x - c.wedgeX, c.y - c.wedgeY) > 1.1 && !pinned) { c.wedgeX = c.x; c.wedgeY = c.y; c.wedgeT = 0; }
      else if ((pushing && c.speed < 2) || pinned) c.wedgeT += dt * (pinned ? 0.85 : 1);
      else c.wedgeT = Math.max(0, c.wedgeT - dt);
      var force = c.resetT > 1 && c.resetCd <= 0;
      if (c.wedgeT < (c.isPlayer ? 0.7 : 1.1) && !force) return;
      // direction: away from everything touching us (cars, wrecks, walls, obstacles, deck sides) + toward the centre
      var dx = 0, dy = 0, L = c.spec.length;
      cars.forEach(function (o) {
        if (o === c) return;
        var ox = c.x - o.x, oy = c.y - o.y, d = Math.hypot(ox, oy);
        if (d < (L + o.spec.length) / 2 + 0.8 && d > 1e-3) { dx += ox / d; dy += oy / d; }
      });
      var b = AR().sdBoundary(arena, c.x, c.y);
      if (b.d < L) { dx += b.nx * 1.2; dy += b.ny * 1.2; }
      arena.obstacles.forEach(function (o) { var q = AR().sdObstacle(o, c.x, c.y); if (q.d < L * 0.75) { dx += q.nx; dy += q.ny; } });
      var hz = AR().heightAt(arena, c.x + Math.cos(c.heading) * L * 0.6, c.y + Math.sin(c.heading) * L * 0.6);
      if (hz.src && hz.z - c.z > 0.5) { dx -= Math.cos(c.heading); dy -= Math.sin(c.heading); }
      var cl = Math.hypot(c.x, c.y) || 1; dx += -c.x / cl * 0.6; dy += -c.y / cl * 0.6;
      var l = Math.hypot(dx, dy);
      if (l < 1e-3) { dx = -Math.cos(c.heading); dy = -Math.sin(c.heading); l = 1; }
      var k = (force ? 6.5 : 4.2 + Math.min(3, c.wedgeN) * 1.2);
      c.vx += dx / l * k; c.vy += dy / l * k;
      c.w += (world.rng() < 0.5 ? -1 : 1) * (force ? 1.6 : 1.0);
      c.vz = Math.max(c.vz, force ? 3.2 : 1.8); c.airborne = true; c.airT = 0;
      c.wedgeT = 0; c.wedgeN++; c.wedgeX = c.x; c.wedgeY = c.y; c.ghostT = 0.5;
      if (force) { c.resetT = 0; c.resetCd = 3; var lh = DM().addZone(c, 'all', 0.02 / DM().ZONE_HPP, {}); c.stats.taken += lh; }
      world.emit({ type: 'unstick', carId: c.id, x: c.x, y: c.y, z: c.z + 0.4, forced: force });
    }
    /** camping: no damage dealt or taken for IDLE_S -> flagged (AI hunts it) and slowly burns */
    var IDLE_S = 15;
    function idleCheck(c, dt) {
      if (world.phase !== 'fight' || cfg.rules.idlePenalty === false) { c.idle = false; return; }
      var idle = world.t - c.lastActT > IDLE_S && world.t - (world.fightT0 || 0) > IDLE_S;
      if (idle && !c.idle) { world.emit({ type: 'idle', carId: c.id, x: c.x, y: c.y }); if (c.isPlayer || world.t - num(world.campMsgT, -99) > 20) { world.campMsgT = world.t; world.feedLine(c.isPlayer ? 'No camping! Go hit someone!' : c.short + ' is camping!', 'info', c.id); } }
      c.idle = idle;
      if (idle) {
        c.idleT += dt;
        var lost = DM().addZone(c, 'all', 0.028 * dt / DM().ZONE_HPP * (1 + Math.min(2, c.idleT / 10)), {});
        c.stats.taken += lost;
        if (c.dmg.onFire < 0.35) { c.dmg.onFire = 0.35; c.dmg.burnT = Math.max(c.dmg.burnT, 0.6); }
      } else c.idleT = 0;
    }

    /* ---------------------------------------------------------------- scoring / taunts */
    var TAUNTS = {
      hit: ['Felt that one?', 'Ding! Insurance won\'t cover that.', 'Nice paint. Was.', 'Stay still, I missed a spot!', 'Is that a dent or a design choice?', 'Bumper cars, baby!', 'You drive like my nan. She\'d win.'],
      kill: ['Scrap metal!', 'Tow truck’s on its way.', 'Next!', 'GG — get good.', 'Another one for the crusher.', 'Sit down, rookie.']
    };
    function taunt(car, kind) {
      if (!car || car.isPlayer || world.t - world.tauntT < 6) return;
      if (kind === 'hit' && world.rng() > 0.4) return;
      var L = TAUNTS[kind] || TAUNTS.hit;
      world.tauntT = world.t;
      world.feedLine(car.short + ': “' + L[Math.floor(world.rng() * L.length)] + '”', 'taunt', car.id, 'player');
    }
    /** award score points; combo x1.25 per extra hit within 3 s (max x3) */
    function award(car, other, label, pts, bonus) {
      if (!car || !world) return 0;
      if (!bonus) {
        if (world.t - car.comboT < 3) car.combo++; else car.combo = 1;
        car.comboT = world.t; car.stats.bestCombo = Math.max(car.stats.bestCombo, car.combo);
      }
      var mult = Math.min(3, 1 + 0.25 * Math.max(0, car.combo - 1));
      var p = Math.round(pts * mult);
      car.stats.score += p;
      car.ram.charge = Math.min(1, car.ram.charge + RAM.hitRefill * Math.min(2, pts / 200));
      world.emit({ type: 'score', carId: car.id, otherId: other ? other.id : null, label: label, points: p, combo: car.combo, x: other ? other.x : car.x, y: other ? other.y : car.y, z: (other ? other.z : car.z) + 1.6 });
      return p;
    }

    function rules(dt) {
      var W = world;
      if (W.phase === 'fight') {
        var aliveN = cars.filter(function (c) { return !c.out || (c.respawnT > 0 && c.lives > 0); }).length;
        var timeUp = cfg.rules.timeLimit_s > 0 && W.t - W.fightT0 >= cfg.rules.timeLimit_s;
        if (!W.sdAnnounced && W.sd && W.sd.on) { W.sdAnnounced = true; W.emit({ type: 'sudden-death' }); W.feedLine('SUDDEN DEATH — the ring of fire is closing in!', 'info'); }
        if (aliveN <= 1 || teamsAlive() <= 1 || timeUp) {
          var alive = cars.filter(function (c) { return !c.out; });
          alive.sort(function (a, b) { return b.dmg.health - a.dmg.health; });
          var win = alive[0] || world.byId(W.elimOrder[W.elimOrder.length - 1]);
          W.winnerId = win ? win.id : null;
          W.phase = 'over'; W.overT = 0; W.endReason = timeUp ? 'time' : 'last-standing';
          if (win && !win.out) award(win, null, 'LAST CAR STANDING', 1000, true);
          W.emit({ type: 'win', carId: W.winnerId, reason: W.endReason });
          W.feedLine(win ? (win.isPlayer ? 'YOU WIN! Last car standing!' : win.short + ' wins the derby') : 'Draw', 'kill', W.winnerId);
          W.slowmo = 1;
        }
        // the player is out for good: keep the match going (spectate) but the UI may end early
      } else if (W.phase === 'over') W.overT += dt;
    }

    /* ---------------------------------------------------------------- contacts -> damage */
    function carContact(ct, dt) {
      var a = ct.a, b = ct.b, W = world;
      var key = a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id;
      var fighting = W.phase === 'fight';
      var Dm = DM();
      var za = Dm.zoneOf(a, ct.px, ct.py), zb = Dm.zoneOf(b, ct.px, ct.py);
      a.touch[b.id] = W.t; b.touch[a.id] = W.t;
      // accessories (ramp launch, saws, spikes, shield) for both sides
      if (fighting) {
        AC().onContact(F, a, b, { contact: ct, myZone: za.zone, otherZone: zb.zone, attacker: ct.aIn >= ct.bIn, vn: ct.vn, vt: ct.vt, nx: ct.nx, ny: ct.ny });
        AC().onContact(F, b, a, { contact: ct, myZone: zb.zone, otherZone: za.zone, attacker: ct.bIn > ct.aIn, vn: ct.vn, vt: ct.vt, nx: -ct.nx, ny: -ct.ny });
      }
      if (!fighting || ct.vn < DM().V0) {
        if (ct.vn > 1 && ct.vt > 3 && (!a.scrapeT || W.t - a.scrapeT > 0.25)) { a.scrapeT = W.t; W.emit({ type: 'scrape', carId: a.id, otherId: b.id, x: ct.px, y: ct.py, z: a.z + 0.5 }); }
        return;
      }
      // debounce: one damage event per pair per 0.12 s (contacts persist over several steps)
      var last = a.contactT[key] || -9;
      if (W.t - last < 0.12 && ct.vn < 6) return;
      a.contactT[key] = W.t;
      var ma = a.spec.mass, mb = b.spec.mass;
      var attackerA = ct.aIn >= ct.bIn;
      var att = attackerA ? a : b, vic = attackerA ? b : a, zAtt = attackerA ? za : zb, zVic = attackerA ? zb : za;
      function dmgFor(car, other, z, oz, share, isAtt) {
        var mult = AC().modifier(car, z.zone, 'taken') * AC().modifier(other, oz.zone, 'dealt');
        if (car.invulnT > 0) mult = 0;
        if (car.pickupArmorT > 0) mult *= 0.5;
        if (other.ram && other.ram.active) mult *= RAM.dealt;
        if (car.isPlayer) mult *= diff.playerTaken;
        else if (other.isPlayer) mult *= 1; else mult *= 0.92;
        mult *= suddenDeath();
        if (!other.isPlayer && car !== other) mult *= diff.aiDealt;
        // the car that drives in takes much less (it chose the angle, bumper + momentum) — the victim more: attacking pays
        mult *= isAtt ? 0.62 : 1.1;
        var normalOut = car === a ? { nx: ct.nx, ny: ct.ny } : { nx: -ct.nx, ny: -ct.ny };
        var r = Dm.apply(car, { px: ct.px, py: ct.py, nx: normalOut.nx, ny: normalOut.ny, vn: ct.vn }, { share: share, mult: mult, rng: W.rng, hitZ: 0.5 });
        return r;
      }
      // remember who hit whom BEFORE this hit (revenge) and whether the victim is pinned (sandwich)
      var revenge = att.lastHitBy === vic.id && W.t - att.lastHitT < 6;
      var sandwich = W.t - vic.lastWallT < 0.35 || Object.keys(vic.touch).some(function (id) { return id !== att.id && W.t - vic.touch[id] < 0.35; });
      var ra = dmgFor(a, b, za, zb, mb / (ma + mb), attackerA);
      var rb = dmgFor(b, a, zb, za, ma / (ma + mb), !attackerA);
      var lostA = num(ra.healthLoss, 0), lostB = num(rb.healthLoss, 0);
      if (lostA > 0.004 || lostB > 0.004 || ct.vn > 6) { a.lastActT = W.t; b.lastActT = W.t; }
      if (lostA + lostB > 0.03 || ct.vn > 7) {
        W.lastSigT = W.t;
        var P1 = cars[0];
        if (ct.vn > 7 && (a === P1 || b === P1 || Math.hypot(ct.px - P1.x, ct.py - P1.y) < 15)) W.pQuietT = 0;
      }
      a.stats.taken += lostA; b.stats.taken += lostB;
      a.stats.dealt += lostB; b.stats.dealt += lostA;
      if (lostB > 0.005) { b.lastHitBy = a.id; b.lastHitT = W.t; }
      if (lostA > 0.005) { a.lastHitBy = b.id; a.lastHitT = W.t; }
      var big = ct.vn > 8 || lostA + lostB > 0.09;
      att.stats.hits++; if (big) att.stats.bigHits++;
      att.stats.maxImpact = Math.max(att.stats.maxImpact, ct.vn); vic.stats.maxImpact = Math.max(vic.stats.maxImpact, ct.vn);
      // classify: T-bone = attacker's front into the victim's side
      var kind = 'hit';
      if (zAtt.zone === 'front' && (zVic.zone === 'left' || zVic.zone === 'right') && ct.vn > 7) { kind = 'tbone'; att.stats.tbones++; }
      else if (zAtt.zone === 'front' && zVic.zone === 'front') kind = 'headon';
      else if (zAtt.zone === 'rear') { kind = 'reverse'; att.stats.rams++; }
      else if (zVic.zone === 'rear') kind = 'rear';
      if (kind === 'hit' && (zAtt.zone === 'left' || zAtt.zone === 'right') && (zVic.zone === 'left' || zVic.zone === 'right')) kind = 'sideswipe';
      W.emit({ type: 'impact', carId: att.id, otherId: vic.id, x: ct.px, y: ct.py, z: Math.max(a.z, b.z) + 0.55, nx: ct.nx, ny: ct.ny, energy: Math.round(ct.energy), vn: r3(ct.vn), zone: zVic.zone, attZone: zAtt.zone, kind: kind, big: big, boost: !!att.ram.active });
      // knock-back: big hits shove + spin the victim (light cars fly further)
      var vLost = attackerA ? lostB : lostA;
      if (ct.vn > 6) {
        var nxv = attackerA ? ct.nx : -ct.nx, nyv = attackerA ? ct.ny : -ct.ny;
        var dv = clamp((ct.vn - 6) * 0.2, 0, 4.5) * Math.sqrt(1500 / vic.spec.mass) * (att.ram.active ? 1.35 : 1);
        PH().applyImpulse(vic, nxv * dv * vic.spec.mass, nyv * dv * vic.spec.mass, ct.px, ct.py);
        vic.w += (zVic.lx >= 0 ? 1 : -1) * (zVic.zone === 'left' || zVic.zone === 'right' ? 1 : 0.4) * dv * 0.28 * (world.rng() < 0.5 ? 1 : 1);
        if (ct.vn > 13 && !vic.airborne) { vic.vz = Math.max(vic.vz, 1.2 + (ct.vn - 13) * 0.12); vic.airborne = true; vic.airT = 0; vic.rollV += (zVic.ly >= 0 ? -1 : 1) * clamp((ct.vn - 13) * 0.18, 0, 2.2) * (zVic.zone === 'left' || zVic.zone === 'right' ? 1 : 0.3); }
      }
      // sticky bomb pickup: the next car you hit takes a blast
      if (att.bombT > 0 && ct.vn > 3) {
        att.bombT = 0;
        var lb = hurt(vic, 'all', 0.55 / DM().ZONE_HPP * 0.42, att, 'bomb'); void lb;
        var bnx = attackerA ? ct.nx : -ct.nx, bny = attackerA ? ct.ny : -ct.ny;
        vic.vx += bnx * 9; vic.vy += bny * 9; vic.vz = 5.5; vic.airborne = true; vic.airT = 0; vic.rollV += (world.rng() - 0.5) * 6;
        W.emit({ type: 'explode', carId: vic.id, otherId: att.id, x: vic.x, y: vic.y, z: vic.z + 0.8, big: true, bomb: true });
        award(att, vic, 'STICKY BOMB!', 250);
        if (vic.isPlayer) W.feedLine(att.short + ' stuck a bomb on you!', 'hit', att.id, vic.id);
      }
      // score labels (only hits that did real damage)
      if (W.phase === 'fight' && vLost > 0.012 && ct.vn > 4) {
        var lab, pts;
        if (att.airborne && num(att.airT, 0) > 0.25) { lab = 'AIRBORNE HIT'; pts = 300; }
        else if (sandwich) { lab = 'SANDWICH'; pts = 300; att.stats.sandwiches++; }
        else if (kind === 'tbone') { lab = 'T-BONE'; pts = 250; }
        else if (kind === 'rear') { lab = 'REAR-ENDER'; pts = 150; }
        else if (kind === 'reverse') { lab = 'REVERSE RAM'; pts = 150; }
        else if (kind === 'headon') { lab = 'HEAD-ON'; pts = 120; }
        else if (kind === 'sideswipe') { lab = 'SIDESWIPE'; pts = 80; }
        else { lab = 'SMASH'; pts = 60; }
        if (!big) pts = Math.round(pts * 0.5);
        award(att, vic, lab, pts);
        if (revenge) { award(att, vic, 'REVENGE!', 100, false); att.stats.revenge++; }
        if (att.ram.active) { award(att, vic, 'RAM BOOST HIT', 100, true); att.stats.boostHits++; }
        if (vic.isPlayer && big) taunt(att, 'hit');
      }
      [ra, rb].forEach(function (r, k) {
        var c = k === 0 ? a : b;
        (r.events || []).forEach(function (e) { e.carId = c.id; e.x = ct.px; e.y = ct.py; e.z = c.z + 0.5; W.emit(e); if (c.isPlayer && e.type === 'wheel-off') W.feedLine('You lost a wheel!', 'info', c.id); });
      });
      // the kill-feed loves big hits involving the player
      if (big && (att.isPlayer || vic.isPlayer)) {
        var label = { tbone: 'T-boned', headon: 'head-butted', reverse: 'reverse-rammed', rear: 'rear-ended', hit: 'smashed' }[kind];
        if (att.isPlayer) W.feedLine('You ' + label + ' ' + vic.short + '!', 'hit', att.id, vic.id);
        else W.feedLine(att.short + ' ' + label + ' you!', 'hit', att.id, vic.id);
        W.slowmo = Math.max(W.slowmo, ct.vn > 16 ? 0.6 : 0.3);
      }
    }
    function arenaContact(c, ct) {
      var W = world;
      c.lastWallT = W.t;
      if (ct.vn < 2.5) {
        if (ct.vt > 5 && (!c.scrapeT || W.t - c.scrapeT > 0.2)) { c.scrapeT = W.t; W.emit({ type: 'scrape', carId: c.id, x: ct.px, y: ct.py, z: c.z + 0.4, wall: true }); }
        return;
      }
      if (W.phase !== 'fight') return;
      var key = 'w' + (ct.obstacleId || ct.kind);
      var last = c.contactT[key] || -9;
      if (W.t - last < 0.15 && ct.vn < 6) return;
      c.contactT[key] = W.t;
      // walls hurt less than cars (fun pass: knock-back throws cars into walls a lot; the cars are the weapons)
      var soft = (ct.obstacleKind === 'tyres' || ct.obstacleKind === 'island' ? 0.45 : ct.obstacleKind === 'barrel' ? 0.6 : 1) * 0.68;
      var z = DM().zoneOf(c, ct.px, ct.py);
      var mult = AC().modifier(c, z.zone, 'taken') * soft * (c.isPlayer ? diff.playerTaken : 1) * suddenDeath();
      if (c.invulnT > 0) mult = 0;
      var r = DM().apply(c, { px: ct.px, py: ct.py, nx: ct.nx, ny: ct.ny, vn: ct.vn }, { wall: true, mult: mult, rng: W.rng, hitZ: 0.45 });
      c.stats.taken += num(r.healthLoss, 0);
      c.stats.wallHits++;
      c.lastActT = W.t;
      // walls credit the last car that hit you within 1.5 s (pinned / shoved into the wall)
      if (c.lastHitBy && W.t - c.lastHitT < 1.5) { var k = W.byId(c.lastHitBy); if (k) k.stats.dealt += num(r.healthLoss, 0); }
      if (ct.vn > 4) W.emit({ type: 'wall', carId: c.id, x: ct.px, y: ct.py, z: c.z + 0.5, nx: ct.nx, ny: ct.ny, energy: Math.round(ct.energy), vn: r3(ct.vn), zone: z.zone, big: ct.vn > 13, obstacle: ct.obstacleKind || null });
      (r.events || []).forEach(function (e) { e.carId = c.id; e.x = ct.px; e.y = ct.py; e.z = c.z + 0.5; W.emit(e); });
    }

    /* ---------------------------------------------------------------- public */
    function update(dtReal, input) {
      if (input) pendingInput = input;
      acc += clamp(num(dtReal, 0), 0, 0.25);
      var n = 0;
      while (acc >= DT && n < MAX_STEPS) { stepOnce(pendingInput); acc -= DT; n++; }
      if (n >= MAX_STEPS) acc = 0;
      S.alpha = acc / DT;
      return n;
    }
    function snapCar(c) {
      var d = c.dmg;
      return {
        id: c.id, idx: c.idx, name: c.name, short: c.short, isPlayer: c.isPlayer, number: c.number, color: c.color, accent: c.accent, build: c.build, presetId: c.presetId,
        x: c.x, y: c.y, z: c.z, heading: c.heading, pitch: c.pitch, roll: c.roll, vx: c.vx, vy: c.vy, speed: c.speed || 0, vSigned: num(c.u, 0), w: c.w,
        steer: c.steer, steerAngle: c.steer, throttle: c.throttle, brake: c.brake, gear: c.gear, airborne: c.airborne, flipped: c.flipped, alive: !c.out, out: c.out,
        elimReason: c.elimReason, health: d.health, zones: { front: d.zones.front, rear: d.zones.rear, left: d.zones.left, right: d.zones.right },
        wheels: d.wheels.slice(), wheelLost: d.wheelLost.slice(), punct: d.punct.slice(),
        engine: { temp: d.engine.temp, fire: d.engine.fire, stalled: d.engine.stalled, smoke: d.engine.smoke, black: d.engine.black, hp: d.engine.hp },
        onFire: d.onFire, fuelLeak: d.fuelLeak, parts: Object.assign({}, d.parts), dents: d.dents, dentSeq: d.dentSeq,
        acc: AC().view(c), shield: c.shieldT, boosting: !!c.boosting || !!c.ram.active, ram: { charge: +c.ram.charge.toFixed(3), active: !!c.ram.active }, idle: !!c.idle,
        combo: world.t - c.comboT < 3 ? c.combo : 0, score: c.stats.score, armorT: c.pickupArmorT > 0 ? c.pickupArmorT : 0, bomb: c.bombT > 0, ringOut: c.ringT > 0, magnet: c.magnetT > 0, invuln: c.invulnT > 0, stats: Object.assign({}, c.stats), lives: c.lives, team: c.team,
        target: brains[c.id] && brains[c.id].target ? brains[c.id].target : null, spec: { length: c.spec.length, width: c.spec.width, height: c.spec.height, mass: c.spec.mass, enginePos: c.spec.enginePos, drive: c.spec.drive },
        surface: c.surf, slip: c.slip, respawnT: c.respawnT, mods: c.out ? null : DM().effects(c)
      };
    }
    function snapshot() {
      var W = world;
      var evs = W.events; W.events = [];
      var aliveN = cars.filter(function (c) { return !c.out; }).length;
      return {
        t: W.t, tick: W.tick, phase: W.phase, countdown_s: Math.max(0, W.countdown), timeLeft_s: cfg.rules.timeLimit_s > 0 ? Math.max(0, cfg.rules.timeLimit_s - (W.phase === 'countdown' ? 0 : W.t - (W.fightT0 || 0))) : null,
        arenaId: arena.id, arena: arena, playerId: 'player', aliveCount: aliveN, total: cars.length, winnerId: W.winnerId, endReason: W.endReason || null, overT: W.overT,
        slowmo: W.slowmo, alpha: S.alpha || 0, suddenDeath: Object.assign({}, W.sd), damageMult: +suddenDeath().toFixed(3), cars: cars.map(snapCar), events: evs,
        entities: W.entities.map(function (e) { return { id: e.id, type: e.type, x: e.x, y: e.y, z: e.z, r: e.r, heading: e.heading, life: e.life, owner: e.owner }; }).concat(ballEntities()).concat(pickups ? pickups.entities() : []),
        feed: W.feed.slice(-8), difficulty: cfg.difficulty, rules: cfg.rules
      };
    }
    function ballEntities() {
      var out = [];
      cars.forEach(function (c) { var st = AC().get(c, 'wrecking-ball'); if (st) out.push({ id: 'ball-' + c.id, type: 'ball', x: st.ball.x, y: st.ball.y, z: st.ball.z, r: 0.45, owner: c.id, ax: st.anchor ? st.anchor.x : c.x, ay: st.anchor ? st.anchor.y : c.y, az: c.z + 0.55 }); });
      return out;
    }
    function results() {
      var W = world;
      var order = cars.slice().sort(function (a, b) {
        if (a.id === W.winnerId) return -1; if (b.id === W.winnerId) return 1;
        if (!a.out && b.out) return -1; if (a.out && !b.out) return 1;
        if (!a.out && !b.out) return b.dmg.health - a.dmg.health;
        return W.elimOrder.indexOf(b.id) - W.elimOrder.indexOf(a.id);
      });
      var mvp = cars.slice().sort(function (a, b) { return score(b) - score(a) || b.stats.dealt - a.stats.dealt; })[0];
      var rows = order.map(function (c, i) {
        return { id: c.id, name: c.name, short: c.short, isPlayer: c.isPlayer, presetId: c.presetId, presetName: presetName(c.presetId), position: i + 1, alive: !c.out, elimReason: c.elimReason,
          elimT: c.elimT != null ? r3(c.elimT - (W.fightT0 || 0)) : null, health: r3(c.dmg.health), accessories: c.accIds.slice(), color: c.color,
          stats: { dealt: r3(c.stats.dealt), taken: r3(c.stats.taken), hits: c.stats.hits, bigHits: c.stats.bigHits, kills: c.stats.kills, tbones: c.stats.tbones, rams: c.stats.rams, wallHits: c.stats.wallHits,
            flameDmg: r3(c.stats.flameDmg), maxImpact_kph: Math.round(c.stats.maxImpact * 3.6), airTime: r3(c.stats.airTime), survived_s: r3(c.stats.survived_s),
            launches: c.stats.launches, sandwiches: c.stats.sandwiches, revenge: c.stats.revenge, boostHits: c.stats.boostHits, bestCombo: c.stats.bestCombo, pickups: c.stats.pickups },
          score: Math.round(score(c)), coins: Math.round(score(c) / 20) };
      });
      var me = rows.filter(function (r) { return r.isPlayer; })[0];
      return { discipline: 'derby', derby: true, arenaId: arena.id, arenaName: arena.name, difficulty: cfg.difficulty, rules: cfg.rules, duration_s: r3(W.t - (W.fightT0 || 0)),
        winnerId: W.winnerId, won: W.winnerId === 'player', endReason: W.endReason || null, classification: rows, player: me, mvpId: mvp ? mvp.id : null, mvpName: mvp ? mvp.short : null, seed: cfg.seed };
    }
    function score(c) { return c.stats.score; }

    var SKIP = { build: 1, spec: 1, accIndex: 1, surf: 1 };
    function getState() {
      var W = world;
      return JSON.parse(JSON.stringify({
        v: 1, rng: W.rng.state.s, t: W.t, tick: W.tick, phase: W.phase, countdown: W.countdown, evId: W.evId, entId: W.entId, entities: W.entities,
        elimOrder: W.elimOrder, winnerId: W.winnerId, overT: W.overT, fightT0: W.fightT0, slowmo: W.slowmo, lastCount: W.lastCount, feed: W.feed, endReason: W.endReason || null, sdAnnounced: !!W.sdAnnounced,
        cars: cars.map(function (c) { var o = {}; for (var k in c) if (!SKIP[k] && typeof c[k] !== 'function') o[k] = c[k]; return o; }),
        brains: Object.keys(brains).reduce(function (o, id) { o[id] = brains[id].serialize ? brains[id].serialize() : null; return o; }, {}),
        acc: acc, autopilot: autopilot, tauntT: W.tauntT, sd: W.sd, sdStart: W.sdStart == null ? null : W.sdStart, lastSigT: num(W.lastSigT, 0), lonelyT: num(W.lonelyT, 0), pQuietT: num(W.pQuietT, 0), pairT: W.pairT, pairGhost: W.pairGhost, pickups: pickups && pickups.serialize ? pickups.serialize() : null, pkRng: pkRng ? pkRng.state.s : null
      }));
    }
    function setState(st) {
      if (!st || !st.cars) return false;
      var W = world;
      W.rng.state.s = st.rng >>> 0; W.t = st.t; W.tick = st.tick; W.phase = st.phase; W.countdown = st.countdown; W.evId = st.evId; W.entId = st.entId;
      W.entities = JSON.parse(JSON.stringify(st.entities)); W.elimOrder = st.elimOrder.slice(); W.winnerId = st.winnerId; W.overT = st.overT; W.fightT0 = st.fightT0;
      W.slowmo = st.slowmo; W.lastCount = st.lastCount; W.feed = JSON.parse(JSON.stringify(st.feed || [])); W.endReason = st.endReason; W.sdAnnounced = !!st.sdAnnounced; W.events = []; W.pairT = JSON.parse(JSON.stringify(st.pairT || {})); W.pairGhost = JSON.parse(JSON.stringify(st.pairGhost || {}));
      st.cars.forEach(function (o, i) {
        var c = cars[i];
        for (var k in o) c[k] = JSON.parse(JSON.stringify(o[k]));
        c.accIndex = {}; c.acc.forEach(function (a, j) { c.accIndex[a.id] = j; });
      });
      Object.keys(st.brains || {}).forEach(function (id) { if (brains[id] && brains[id].restore) brains[id].restore(st.brains[id]); });
      acc = num(st.acc, 0); autopilot = !!st.autopilot; W.tauntT = num(st.tauntT, -9); W.sd = st.sd || safeScaleAt(0, cfg.rules); W.sdStart = st.sdStart == null ? null : st.sdStart; W.lastSigT = num(st.lastSigT, 0); W.lonelyT = num(st.lonelyT, 0); W.pQuietT = num(st.pQuietT, 0);
      if (pickups && st.pickups && pickups.restore) pickups.restore(st.pickups);
      if (pkRng && st.pkRng != null) pkRng.state.s = st.pkRng >>> 0;
      return true;
    }

    init();
    S.update = update;
    S.step = function (input) { stepOnce(input || pendingInput); };
    S.snapshot = snapshot;
    S.results = results;
    S.getState = getState;
    S.setState = setState;
    S.restart = function () { acc = 0; pendingInput = null; F = null; init(); };
    S.destroy = function () { cars = []; brains = {}; };
    S.setPlayerAutopilot = function (on) {
      autopilot = on !== false;
      var AI = CB.derby.ai;
      if (autopilot && !brains.player && AI) brains.player = AI.create(cars[0], { difficulty: cfg.difficulty, rng: mulberry((num(cfg.seed, 1) * 31 + 7) >>> 0), skill: diff.aiSkill, aggro: diff.aiAggro });
    };
    S.spectateTargets = function () { return cars.filter(function (c) { return !c.out; }).map(function (c) { return c.id; }); };
    S.setInput = function (inp) { pendingInput = inp; };
    Object.defineProperty(S, 'world', { get: function () { return world; } });
    Object.defineProperty(S, '_cars', { get: function () { return cars; } });
    S.DT = DT;
    return S;
  }

  /**
   * Sudden death (pure): from rules.suddenDeathAt (default 75 s of fighting) the safe area — the arena outline scaled
   * about the origin — shrinks from 1 to 0.5 over 60 s; outside it cars burn (ring of fire) and every hit hurts more
   * (damage x1 -> x2). rules.suddenDeath === false turns it off. t = seconds since GO.
   */
  function safeScaleAt(t, rules, startOverride) {
    rules = rules || {};
    var start = Math.min(num(rules.suddenDeathAt, 75), num(startOverride, 1e9)), dur = 60;
    if (rules.suddenDeath === false || !(t >= start)) return { on: false, t: 0, level: 0, safeScale: 1, ringFire: false, mult: 1, startsIn: rules.suddenDeath === false ? null : Math.max(0, start - (t || 0)), start: start };
    var lvl = clamp((t - start) / dur, 0, 1);
    return { on: true, t: t - start, level: lvl, safeScale: 1 - 0.5 * lvl, ringFire: true, mult: 1 + lvl, startsIn: 0, start: start };
  }
  CB.derby.session = { create: create, safeScaleAt: safeScaleAt, DIFFICULTY: DIFFICULTY, AI_NAMES: AI_NAMES, makeGrid: makeGrid, DT: DT, mulberry: mulberry, presetName: presetName };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.derby.session;
})();

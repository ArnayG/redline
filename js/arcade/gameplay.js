/* ==========================================================================
   Redline — js/arcade/gameplay.js
   CB.arcade.gameplay : the ARCADE GAMEPLAY LAYER — nitro, rocket starts, powerslide mini-turbos, slipstream, boost
   pads / rings, item boxes + power-ups, coins, AI item / nitro use and rubber-banding. Pure logic (no DOM),
   Node-loadable, deterministic (own serialisable seeded PRNG, fixed-step friendly).

   Everything lives in TRACK SPACE: s (m along the lap, 0 = start line), lateral (m, + = left), race distance.
   That makes one implementation work for flat circuits (CB.race.engine) and the 3D stunt tracks (CB.arcade.stunt),
   which only need to report each car's s / lateral / speed and apply the returned per-car effects.

     var gp = CB.arcade.gameplay.create(opts)
       opts { seed, items true, itemFrequency 'off'|'low'|'normal'|'high'|'frantic', nitro true, coins true,
              speedClass 'street'|'pro'|'mayhem', timeTrial false, difficulty 'easy'|'normal'|'hard'|'expert'
              (race-ui ids rookie/amateur/pro/alien accepted), rubberBand true,
              track { length, halfWidth(s)?, curvature(s)?, pose(s, lat)? }   (attachEngine fills this),
              layout 'auto' | [entity specs {type:'box'|'pad'|'ring'|'coin'|'can', s, lat, ...}] , extraEntities [] }

     --- generic interface (any session type; docs/ARCADE-SPEC.md § Gameplay hook interface) ---
       gp.step(dt, ctx)   ctx { t, phase 'grid'|'countdown'|'racing'|'finished', cars: [view] }
                          view { id, isPlayer, s, lap, dist, lat, speed, position, vTop?, halfW?, throttle, steer,
                                 airborne?, finished?, onTrack? }
       gp.effects(id) -> { push m/s², vTarget m/s, brakeTo m/s|null, brakeDecel m/s², throttleMult, steer|null,
                           stripHandbrake, yaw rad (visual), slide rad (visual), hop m (visual), noCollide, shielded,
                           ghost, boostKind|null, nitroOn }
       gp.setInput(id, { nitro, item, aimBack, drift })   (held states; item is edge-detected)
       gp.applyBoost(id, kind, seconds, topMult?, accel?)  gp.addNitro(id, amount, source?)  gp.hitCar(id, kind, byId?)
       gp.addEntity(spec) / gp.entities() / gp.kart(id) / gp.karts() / gp.takeEvents() / gp.stats(id)
       gp.serialize() / gp.load(state)   (replays + future host-authoritative multiplayer)
       gp.decorate(snap)  adds snap.arcade + per-car visual offsets (heading += yaw + slide, car.arcadeHop)

     --- CB.race.engine sessions ---
       cfg.hooks = [gp.hooks]  then  gp.attachEngine(session)  (track from the session geometry, auto layout,
       snapshot() decorated). The hook runs gp.step once per 1/120 s substep and applies the effects to the vehicle
       state (body-frame vx with wheel speeds kept consistent, so the tyre model does not fight the boost).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.arcade = CB.arcade || {};

(function () {
  'use strict';

  var TAU = Math.PI * 2;
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function wrapS(s, L) { s = s % L; return s < 0 ? s + L : s; }
  function wrapD(d, L) { d = wrapS(d, L); return d > L / 2 ? d - L : d; }
  function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  function round(v, d) { var p = Math.pow(10, d || 0); return Math.round(v * p) / p; }

  function items() { return CB.arcade.items; }
  function NZ() { return CB.arcade.nitro; }

  /* ---------------- serialisable PRNG (mulberry32 with exposed state) ---------------- */
  function makeRng(seed) {
    var r = { s: (seed >>> 0) || 0x1234567 };
    var f = function () {
      r.s = (r.s + 0x6D2B79F5) | 0;
      var t = r.s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.range = function (a, b) { return a + (b - a) * f(); };
    f.state = function () { return r.s; };
    f.setState = function (s) { r.s = s | 0; };
    return f;
  }

  /* ---------------- tuning tables ---------------- */
  var SPEED_CLASSES = {
    street: { id: 'street', name: 'Street', top: 1.0, accel: 0, aiAgg: 0.9, desc: 'Real-world pace' },
    pro: { id: 'pro', name: 'Pro', top: 1.12, accel: 1.8, aiAgg: 1.0, desc: '+12% top speed, sharper AI' },
    mayhem: { id: 'mayhem', name: 'Mayhem', top: 1.28, accel: 3.6, aiAgg: 1.15, desc: '+28% top speed, ruthless AI' }
  };
  var DIFFICULTY = {
    easy: { react: [2.5, 6], passive: 0.016, nitroMin: 0.75, startGood: 0.25, startPerfect: 0.05, rbAhead: 0.2, rbBehind: 1.4, smart: 0.45 },
    normal: { react: [1.4, 4], passive: 0.026, nitroMin: 0.55, startGood: 0.45, startPerfect: 0.15, rbAhead: 0.13, rbBehind: 2.0, smart: 0.7 },
    hard: { react: [0.8, 2.6], passive: 0.036, nitroMin: 0.4, startGood: 0.65, startPerfect: 0.3, rbAhead: 0.07, rbBehind: 2.5, smart: 0.86 },
    expert: { react: [0.35, 1.6], passive: 0.048, nitroMin: 0.3, startGood: 0.8, startPerfect: 0.5, rbAhead: 0.03, rbBehind: 3.0, smart: 0.97 }
  };
  var DIFF_ALIAS = { rookie: 'easy', amateur: 'normal', pro: 'hard', alien: 'expert', medium: 'normal', beginner: 'easy' };
  var FREQ_ROWS = { off: 0, low: 2, normal: 3, high: 4, frantic: 6 };

  var NITRO_TOP = 1.17, NITRO_ACCEL = 9.5;
  var PAD = { boost_s: 1.0, top: 1.22, accel: 16, len: 7, w: 3.4 };
  var RING = { boost_s: 1.2, top: 1.2, accel: 14, r: 2.8 };
  var BOX_R = 1.6, BOX_RESPAWN = 2.6, COIN_R = 1.2, COIN_RESPAWN = 9, CAN_R = 1.5, CAN_RESPAWN = 7, COIN_CAP = 10;
  var ROULETTE_PLAYER = 1.7, ROULETTE_AI = 1.1;

  function normOpts(o) {
    o = o || {};
    var tt = !!o.timeTrial;
    var freq = FREQ_ROWS[o.itemFrequency] != null ? o.itemFrequency : 'normal';
    var diff = DIFFICULTY[o.difficulty] ? o.difficulty : (DIFF_ALIAS[o.difficulty] || 'normal');
    return {
      seed: (num(o.seed, 1) >>> 0) || 1,
      items: !tt && o.items !== false && freq !== 'off',
      itemFrequency: freq,
      nitro: o.nitro !== false,
      coins: o.coins !== false,
      speedClass: SPEED_CLASSES[o.speedClass] ? o.speedClass : 'street',
      timeTrial: tt,
      difficulty: diff,
      rubberBand: !tt && o.rubberBand !== false,
      layout: o.layout || 'auto',
      extraEntities: Array.isArray(o.extraEntities) ? o.extraEntities : [],
      ttTurbos: o.ttTurbos !== false
    };
  }

  /* ======================================================================
     Auto layout for flat circuits
     ====================================================================== */
  /** track { length, halfWidth(s), curvature(s) } -> entity specs (lap-s coordinates). Deterministic. */
  function autoLayout(track, opts) {
    opts = opts || {};
    var L = num(track && track.length, 0);
    if (!(L > 200)) return [];
    var hwAt = typeof track.halfWidth === 'function' ? track.halfWidth : function () { return 6; };
    var kAt = typeof track.curvature === 'function' ? track.curvature : function () { return 0; };
    var STEPS = 5, n = Math.floor(L / STEPS), K = new Array(n), i;
    for (i = 0; i < n; i++) K[i] = num(kAt(i * STEPS), 0);
    // straights: runs with |k| < 1/350
    var straight = [], cur = null;
    for (i = 0; i < n; i++) {
      var st = Math.abs(K[i]) < 1 / 350;
      if (st && !cur) cur = { a: i * STEPS, b: i * STEPS };
      else if (st && cur) cur.b = i * STEPS;
      else if (!st && cur) { straight.push(cur); cur = null; }
    }
    if (cur) {
      if (straight.length && straight[0].a === 0) straight[0].a = cur.a - L;   // wraps across the line
      else straight.push(cur);
    }
    straight.forEach(function (r) { r.len = r.b - r.a; });
    var longest = straight.slice().sort(function (a, b) { return b.len - a.len; });
    var out = [];
    var rows = FREQ_ROWS[opts.itemFrequency] != null ? FREQ_ROWS[opts.itemFrequency] : 3;
    if (opts.items === false) rows = 0;
    rows = rows ? Math.max(1, Math.round(rows * clamp(L / 3600, 0.7, 1.7))) : 0;
    for (var r = 0; r < rows; r++) {
      var s = wrapS(L * (0.16 + 0.8 * (r + 0.5) / rows), L);
      // nudge onto a straight-ish bit within +-70 m (boxes in a braking zone feel unfair)
      var best = s, bk = Infinity;
      for (var d = -70; d <= 70; d += 5) {
        var ss = wrapS(s + d, L), kk = Math.abs(K[Math.floor(ss / STEPS) % n] || 0) + Math.abs(d) * 1e-5;
        if (kk < bk) { bk = kk; best = ss; }
      }
      var hw = num(hwAt(best), 6), nb = hw >= 5.5 ? 4 : 3, span = hw * 0.62;
      for (var b = 0; b < nb; b++) out.push({ type: 'box', s: best, lat: -span + 2 * span * b / (nb - 1), row: r });
    }
    // boost pads on the 3 longest straights (one side, alternating), a ring on the longest
    longest.slice(0, 3).forEach(function (st2, k) {
      if (st2.len < 90) return;
      var s0 = wrapS(st2.a + 25, L), hw2 = num(hwAt(s0), 6);
      out.push({ type: 'pad', s: s0, lat: (k % 2 ? -1 : 1) * hw2 * 0.38 });
      if (st2.len > 220) out.push({ type: 'pad', s: wrapS(st2.a + 25 + st2.len * 0.45, L), lat: (k % 2 ? 1 : -1) * hw2 * 0.38 });
      if (k === 0) out.push({ type: 'ring', s: wrapS(st2.a + st2.len * 0.7, L), lat: 0 });
    });
    // coin lines on the 2nd and 4th longest straights
    if (opts.coins !== false) {
      [1, 3, 0].forEach(function (k, j) {
        var st3 = longest[k];
        if (!st3 || st3.len < 80 || (j === 2 && out.filter(function (e) { return e.type === 'coin'; }).length >= 10)) return;
        var s1 = st3.a + st3.len * 0.35, hw3 = num(hwAt(wrapS(s1, L)), 6), side = j % 2 ? -1 : 1;
        for (var c = 0; c < 5; c++) out.push({ type: 'coin', s: wrapS(s1 + c * 6, L), lat: side * hw3 * 0.42 });
      });
    }
    // nitro canisters on the inside of the 3 tightest corners (reward a tight line)
    var corners = [];
    for (i = 0; i < n; i++) {
      var k0 = K[i], kp = K[(i - 1 + n) % n], kn = K[(i + 1) % n];
      if (Math.abs(k0) > 1 / 180 && Math.abs(k0) >= Math.abs(kp) && Math.abs(k0) >= Math.abs(kn)) corners.push({ s: i * STEPS, k: k0 });
    }
    corners.sort(function (a, b) { return Math.abs(b.k) - Math.abs(a.k); });
    var picked = [];
    for (i = 0; i < corners.length && picked.length < 3; i++) {
      var cs = corners[i].s;
      if (cs < 120 || cs > L - 60) continue;
      if (picked.some(function (p) { return Math.abs(wrapD(p.s - cs, L)) < 200; })) continue;
      picked.push(corners[i]);
    }
    picked.forEach(function (c2) { out.push({ type: 'can', s: c2.s, lat: sign(c2.k) * num(hwAt(c2.s), 6) * 0.55 }); });
    return out;
  }

  /* ======================================================================
     create()
     ====================================================================== */
  function create(optsIn) {
    var O = normOpts(optsIn);
    var I = items(), N = NZ();
    if (!I || !N) throw new Error('CB.arcade.gameplay needs js/arcade/items.js and js/arcade/nitro.js');
    var CLS = SPEED_CLASSES[O.speedClass], DIFF = DIFFICULTY[O.difficulty];
    var track = (optsIn && optsIn.track) || null;
    var W = null;
    var PIN = { nitro: false, item: false, aimBack: false, aimForward: false, drift: false, rev: null };   // the local player's buttons
    // multiplayer (js/net/netarcade.js, ARCADE-SPEC §6): survives reset(); see setNet()
    var NET = { role: null, humans: {}, extLaunch: false, onEvent: null };
    function human(K) { return K.isPlayer || K.human; }
    function follower() { return NET.role === 'follower'; }

    function trackLen() { return W && W.L > 0 ? W.L : num(track && track.length, 4000); }

    function newKart(v) {
      var K = {
        id: String(v.id), isPlayer: !!v.isPlayer, s: 0, lap: 0, dist: 0, lat: 0, speed: 0, pos: 1, lastPos: 1, vTop: 60,
        halfW: 0.95, airborne: false, airT: 0, finished: false, throttle: 0, steer: 0,
        nitro: N.createMeter(0), boost: null, item: null, roulette: null,
        shieldT: 0, ghostT: 0, magnetT: 0, spinT: 0, spinDur: 1, spinDir: 1, hopT: 0, hopDur: 1, hopH: 1.4,
        slowT: 0, slowTo: 0.6, slowRef: 0, bogT: 0, hitCool: 0, coins: 0, padCool: 0, overtakeCool: 0,
        drift: { on: false, dir: 0, charge: 0, tier: 0 }, slip: { charge: 0, target: null }, rev: N.createRev(), startGrade: null,
        input: v.isPlayer ? PIN : { nitro: false, item: false, aimBack: false, drift: false, itemSeq: 0 }, itemPrev: false, itemDone: 0, human: !!NET.humans[String(v.id)],
        prevDs: {}, ai: { holdT: 0, maxHold: 0, nitroOn: false, startPlan: null },
        st: { itemsUsed: 0, hitsLanded: 0, hitsTaken: 0, blocked: 0, nitroUsed_s: 0, boosts: 0, nearMisses: 0, coins: 0, bestDrift: 0, startGrade: null, boxes: 0 },
        fx: null
      };
      if (O.timeTrial && O.ttTurbos && K.isPlayer) K.item = { id: 'turbo', uses: 3 };
      K.fx = neutralFx();
      return K;
    }
    function neutralFx() {
      return { push: 0, vTarget: 0, brakeTo: null, brakeDecel: 0, throttleMult: 1, steer: null, stripHandbrake: false,
        yaw: 0, slide: 0, hop: 0, noCollide: false, shielded: false, ghost: false, boostKind: null, nitroOn: false, spinReq: null };
    }

    function reset() {
      W = {
        t: 0, L: num(track && track.length, 0), rng: makeRng(O.seed), nextId: 1, nextEvt: 1, events: [], log: [],
        karts: {}, list: [], ents: [], phase: 'grid', started: false, steps: 0
      };
      buildLayout();
    }
    function buildLayout() {
      W.ents = [];
      var specs = [];
      if (Array.isArray(O.layout)) specs = O.layout.slice();
      else if (track && W.L > 0) specs = autoLayout(track, O);
      specs = specs.concat(O.extraEntities);
      specs.forEach(function (sp) { addEntity(sp, true); });
    }
    function addEntity(sp, quiet) {
      if (!sp || !sp.type) return null;
      if (sp.type === 'box' && !O.items) return null;
      if (sp.type === 'coin' && !O.coins) return null;
      if (sp.type === 'can' && !O.nitro) return null;
      var e = { id: 'e' + (W.nextId++), type: sp.type, s: wrapS(num(sp.s, 0), Math.max(1, trackLen())), lat: num(sp.lat, 0),
        respawn: 0, life: num(sp.life, -1), owner: sp.owner || null, z: num(sp.z, 0) };
      if (sp.len != null) e.len = sp.len;
      if (sp.w != null) e.w = sp.w;
      if (sp.r != null) e.r = sp.r;
      if (sp.row != null) e.row = sp.row;
      if (sp.type === 'rocket') { e.dir = sp.dir || 1; e.speed = sp.speed; e.target = sp.target || null; e.d = sp.d; e.age = 0; }
      if (sp.type === 'oil') e.age = 0;
      W.ents.push(e);
      if (!quiet) evt('spawn', sp.owner, { entity: e.id, kind: e.type });
      return e;
    }

    function evt(type, carId, extra) {
      var e = { id: W.nextEvt++, t: round(W.t, 3), type: type, carId: carId == null ? null : carId };
      if (extra) for (var k in extra) e[k] = extra[k];
      W.events.push(e);
      if (W.events.length > 400) W.events.shift();
      if (NET.onEvent) { try { NET.onEvent(e); } catch (eN) { /* net tap must never break the sim */ } }
      return e;
    }

    function kart(id) { return W.karts[String(id)] || null; }

    /* ---------------- effects on karts ---------------- */
    function boost(K, kind, secs, top, accel) {
      if (!K) return;
      var b = K.boost;
      top = num(top, 1.2); accel = num(accel, 12);
      if (b && b.t > 0) { b.t = Math.max(b.t, secs); b.top = Math.max(b.top, top); b.accel = Math.max(b.accel, accel); b.kind = kind; }
      else K.boost = { t: secs, dur: secs, top: top, accel: accel, kind: kind };
      K.st.boosts++;
      evt('boost', K.id, { kind: kind, secs: round(secs, 2) });
    }
    function hit(K, kind, byId) {
      if (!K || K.finished) return false;
      if (K.ghostT > 0) { evt('immune', K.id, { kind: kind, by: byId }); return false; }
      if (K.hitCool > 0) return false;
      if (K.shieldT > 0) {
        K.shieldT = 0; K.st.blocked++;
        evt('blocked', K.id, { kind: kind, by: byId });
        return false;
      }
      var D = I.get(kind) || {};
      K.hitCool = 1.3;
      K.slowRef = Math.max(K.speed, 8);
      K.drift.on = false; K.drift.charge = 0; K.drift.tier = 0;
      K.boost = null; K.nitro.burning = false; K.ai.nitroOn = false; K.magnetT = 0;
      if (kind === 'oil') { K.spinT = K.spinDur = num(D.spin_s, 0.95); K.spinDir = K.lat >= 0 ? 1 : -1; K.slowT = 0.95; K.slowTo = num(D.slowTo, 0.55); }
      else if (kind === 'rocket') { K.hopT = K.hopDur = num(D.hop_s, 1); K.hopH = num(D.hopH, 1.5); K.spinT = K.spinDur = num(D.hop_s, 1); K.spinDir = 1; K.slowT = 1.0; K.slowTo = num(D.slowTo, 0.42); }
      if (K.spinT > 0) K.spinReqStep = W.steps;
      if (K.spinT > 0) K.spinReq = { duration: K.spinDur, dir: K.spinDir, speedLoss: 1 - K.slowTo, turns: 1 };   // for integrators with a native spin (V.spinOut)
      else if (kind === 'emp') { K.slowT = num(D.slow_s, 1.3); K.slowTo = num(D.slowTo, 0.68); }
      else if (kind === 'lightning') { K.slowT = num(D.slow_s, 2.3); K.slowTo = num(D.slowTo, 0.64); K.hopT = K.hopDur = 0.35; K.hopH = 0.35; }
      else { K.slowT = 0.8; K.slowTo = 0.6; }
      var lost = Math.min(K.coins, kind === 'emp' ? 1 : 3);
      K.coins -= lost;
      K.st.hitsTaken++;
      var by = byId ? kart(byId) : null;
      if (by && by !== K) by.st.hitsLanded++;
      evt('hit', K.id, { kind: kind, by: byId || null, coinsLost: lost });
      return true;
    }

    function startRoulette(K) {
      var n = W.list.length;
      var frac = n > 1 ? (K.pos - 1) / (n - 1) : 0.5;
      var final = I.roll(W.rng, frac, { nCars: n });
      var dur = human(K) ? ROULETTE_PLAYER : ROULETTE_AI;
      K.roulette = { t: 0, dur: dur, final: final, strip: human(K) ? I.rouletteStrip(W.rng, final, 16) : null };
      evt('roulette', K.id, { item: final });
    }
    function finishRoulette(K) {
      var id = K.roulette.final, D = I.get(id);
      K.roulette = null;
      K.item = { id: id, uses: D ? D.uses : 1 };
      if (!human(K)) {
        var a = DIFF.react;
        K.ai.holdT = W.rng.range(a[0], a[1]);
        K.ai.maxHold = K.ai.holdT + W.rng.range(4, 10);
        K.ai.held = 0;
      }
      evt('itemGot', K.id, { item: id });
    }

    function carAhead(K) {
      var best = null, bd = Infinity;
      for (var i = 0; i < W.list.length; i++) {
        var o = W.list[i];
        if (o === K || o.finished) continue;
        var d = o.dist - K.dist;
        if (d > 0 && d < bd) { bd = d; best = o; }
      }
      return best;
    }
    function carBehind(K) {
      var best = null, bd = Infinity;
      for (var i = 0; i < W.list.length; i++) {
        var o = W.list[i];
        if (o === K || o.finished) continue;
        var d = K.dist - o.dist;
        if (d > 0 && d < bd) { bd = d; best = o; }
      }
      return best;
    }
    function trackDist(a, b) { var ds = wrapD(b.s - a.s, trackLen()); return Math.sqrt(ds * ds + (b.lat - a.lat) * (b.lat - a.lat)); }

    function useItem(K, aimBack) {
      if (!K.item || K.roulette) return false;
      var id = K.item.id, D = I.get(id) || {}, L = trackLen();
      K.st.itemsUsed++;
      if (id === 'turbo') boost(K, 'turbo', D.boost_s, D.boostTop, D.boostAccel);
      else if (id === 'oil') {
        var fwd = !aimBack && K.input && K.input.aimForward;
        addEntity({ type: 'oil', s: K.s + (fwd ? D.throwFwd : -D.dropBack), lat: K.lat, life: D.life_s, owner: K.id });
      } else if (id === 'emp') {
        evt('emp', K.id, { radius: D.radius, s: round(K.s, 2), lat: round(K.lat, 2) });
        for (var i = 0; i < W.list.length; i++) { var o = W.list[i]; if (o !== K && trackDist(K, o) < D.radius) hit(o, 'emp', K.id); }
      } else if (id === 'rocket') {
        var tgt = aimBack ? carBehind(K) : carAhead(K), dir = aimBack ? -1 : 1;
        var spd = Math.max(D.speed, K.speed + D.minSpeedOver);
        if (aimBack) spd = Math.max(25, D.speed * 0.6);
        addEntity({ type: 'rocket', s: K.s + dir * 3, lat: K.lat, d: K.dist + dir * 3, dir: dir, speed: spd, target: tgt ? tgt.id : null, life: D.life_s, owner: K.id });
      } else if (id === 'shield') K.shieldT = D.life_s;
      else if (id === 'magnet') K.magnetT = D.life_s;
      else if (id === 'ghost') K.ghostT = D.life_s;
      else if (id === 'mega') { if (O.nitro) N.gain(K.nitro, 'mega', 1); boost(K, 'mega', D.boost_s, D.boostTop, D.boostAccel); }
      else if (id === 'lightning') {
        evt('lightning', K.id, {});
        for (var j = 0; j < W.list.length; j++) { var p = W.list[j]; if (p !== K && p.pos < K.pos) hit(p, 'lightning', K.id); }
      }
      evt('itemUse', K.id, { item: id, aimBack: !!aimBack });
      K.item.uses--;
      if (K.item.uses <= 0) K.item = null;
      return true;
    }

    /* ---------------- AI decisions ---------------- */
    function aiItems(K, dt) {
      if (!K.item || K.roulette) return;
      var A = K.ai;
      A.held = (A.held || 0) + dt;
      if (A.holdT > 0) { A.holdT -= dt; return; }
      var id = K.item.id, smart = W.rng() < DIFF.smart, go = false, back = false;
      var ahead = carAhead(K), behind = carBehind(K);
      var dA = ahead ? ahead.dist - K.dist : Infinity, dB = behind ? K.dist - behind.dist : Infinity;
      var straight = Math.abs(K.steer) < 0.2;
      switch (id) {
        case 'turbo': case 'mega': go = straight || !smart; break;
        case 'oil': go = dB < 30 || !smart; break;
        case 'rocket':
          if (ahead && dA < 160) go = true;
          else if (behind && dB < 45) { go = true; back = true; }
          break;
        case 'emp': go = (ahead && dA < 16) || (behind && dB < 16); break;
        case 'shield': go = !smart || W.ents.some(function (e) { return e.type === 'rocket' && e.target === K.id; }) || A.held > 3; break;
        case 'magnet': go = ahead && dA < 110 && dA > 8; break;
        case 'ghost': go = (ahead && dA < 14) || W.ents.some(function (e) { return e.type === 'rocket' && e.target === K.id; }); break;
        case 'lightning': go = true; break;
        default: go = true;
      }
      if (A.held > A.maxHold) go = true;
      if (go) { useItem(K, back); A.holdT = 0.6; }
      else A.holdT = 0.25;   // re-evaluate a few times a second (cheap + not frame-perfect)
    }
    function aiNitro(K) {
      if (!O.nitro) return false;
      var A = K.ai, m = K.nitro.level;
      var P = leadHuman();
      if (A.nitroOn) {
        if (m <= 0.02 || Math.abs(K.steer) > 0.38) A.nitroOn = false;
      } else if (m >= DIFF.nitroMin && Math.abs(K.steer) < 0.16 && K.speed > 18) {
        var farAhead = O.rubberBand && P && K.dist - P.dist > 140;
        if (!farAhead) A.nitroOn = true;
      }
      return A.nitroOn;
    }

    /* ---------------- per-step ---------------- */
    function syncViews(cars) {
      var seen = {};
      for (var i = 0; i < cars.length; i++) {
        var v = cars[i]; if (!v || v.id == null) continue;
        var id = String(v.id), K = W.karts[id];
        if (!K) { K = W.karts[id] = newKart(v); W.list.push(K); }
        seen[id] = 1;
        syncKart(K, v);
      }
      if (W.list.length !== Object.keys(seen).length) {
        W.list = W.list.filter(function (k) { return seen[k.id]; });
        Object.keys(W.karts).forEach(function (id) { if (!seen[id]) delete W.karts[id]; });
      }
    }
    function syncKart(K, v) {
      K.isPlayer = !!v.isPlayer;
      K.human = !K.isPlayer && !!NET.humans[K.id];
      K.s = num(v.s, K.s); K.lap = num(v.lap, K.lap); K.dist = num(v.dist, K.s); K.lat = num(v.lat, 0);
      K.speed = Math.abs(num(v.speed, 0)); K.lastPos = K.pos; K.pos = num(v.position, K.pos);
      if (isNum(v.vTop) && v.vTop > 5) K.vTop = v.vTop;
      if (isNum(v.halfW)) K.halfW = v.halfW;
      K.wasAir = K.airborne; K.airborne = !!v.airborne;
      K.finished = !!v.finished; K.throttle = num(v.throttle, 0); K.steer = num(v.steer, 0);
      K.onTrack = v.onTrack !== false;
      K.nativeSlide = v.powerslide !== undefined && v.powerslide !== null;
      K.slideOn = !!v.powerslide; K.slideDir = num(v.slideDir, 0);
      K.nativeSpin = !!v.nativeSpin;
      if (K.isPlayer) W.player = K;
    }

    function preStart(K, dt) {
      if (human(K)) N.revStep(K.rev, dt, K.input.rev != null ? K.input.rev : K.throttle);
      else if (!K.ai.startPlan) {
        var r = W.rng();
        K.ai.startPlan = r < DIFF.startPerfect ? 'perfect' : r < DIFF.startGood ? 'good' : 'none';
      }
    }
    function launch(K, grade) {
      var res;
      if (K.human && NET.extLaunch && grade == null) { K.launchPending = true; return; }   // the client reports its own start (netarcade)
      K.launchPending = false;
      if (grade != null) res = { grade: grade, boost_s: grade === 'perfect' ? 1.6 : grade === 'good' ? 0.95 : 0, bog_s: grade === 'over' ? 0.7 : 0 };
      else if (human(K)) res = N.revResult(K.rev);
      else res = { grade: K.ai.startPlan || 'none', boost_s: K.ai.startPlan === 'perfect' ? 1.6 : K.ai.startPlan === 'good' ? 0.95 : 0 };
      K.startGrade = K.st.startGrade = res.grade;
      if (res.boost_s > 0) boost(K, 'start', res.boost_s, 1.15, res.grade === 'perfect' ? 15 : 11);
      if (res.grade === 'over') K.bogT = num(res.bog_s, 0.7);
      evt('start', K.id, { grade: res.grade });
    }

    function driftStep(K, dt) {
      var D = K.drift, inp = K.input;
      var want = !!inp.drift;
      if (K.nativeSlide) {
        // the vehicle runs the slide itself (arcade handling: handbrake + steer = powerslide, s.powerslide);
        // we only charge the mini-turbo while it lasts and release it when the slide ends
        if (!D.on && K.slideOn && K.spinT <= 0) { D.on = true; D.dir = K.slideDir || sign(K.steer) || 1; D.charge = 0; D.tier = 0; evt('driftStart', K.id, { dir: D.dir }); }
        // grace: the slide may flicker for a few steps (assist trimming the steer) — keep charging while the button is held
        K.slideOffT = K.slideOn ? 0 : num(K.slideOffT, 0) + dt;
        want = (K.slideOn || (D.on && inp.drift && K.slideOffT < 0.35 && K.speed > 8)) && !(K.spinT > 0 || K.hitCool > 1);
        if (D.on && !want) {
          var tierN = D.tier, specN = tierN ? N.DRIFT_TIERS[tierN - 1] : null;
          D.on = false;
          if (specN && K.speed >= 8 && K.spinT <= 0) {
            boost(K, 'drift' + tierN, specN.boost_s, 1.12 + tierN * 0.04, 10 + tierN * 2);
            if (O.nitro) N.gain(K.nitro, 'driftRelease', N.GAIN.driftRelease * tierN);
            K.st.bestDrift = Math.max(K.st.bestDrift, tierN);
          }
          evt('driftEnd', K.id, { tier: tierN });
          D.charge = 0; D.tier = 0;
        } else if (D.on) {
          var intoN = clamp(K.steer * D.dir, -1, 1);
          D.charge += dt * (0.8 + 0.45 * Math.max(0, intoN));
          var tN = N.driftTier(D.charge);
          if (tN !== D.tier) { D.tier = tN; evt('driftTier', K.id, { tier: tN }); }
          if (O.nitro) N.gain(K.nitro, 'drift', N.GAIN.drift * dt);
        }
        K.prevDriftWant = inp.drift;
        return;
      }
      if (!D.on) {
        if (want && !K.prevDriftWant && K.speed > 13 && Math.abs(K.steer) > 0.2 && !K.airborne && K.spinT <= 0) {
          D.on = true; D.dir = sign(K.steer); D.charge = 0; D.tier = 0;
          evt('driftStart', K.id, { dir: D.dir });
        }
      } else if (!want || K.speed < 8 || K.spinT > 0 || K.hitCool > 1) {
        var tier = D.tier, spec = tier ? N.DRIFT_TIERS[tier - 1] : null;
        D.on = false;
        if (want === false && spec && K.speed >= 8) {
          boost(K, 'drift' + tier, spec.boost_s, 1.12 + tier * 0.04, 10 + tier * 2);
          if (O.nitro) N.gain(K.nitro, 'driftRelease', N.GAIN.driftRelease * tier);
          K.st.bestDrift = Math.max(K.st.bestDrift, tier);
        }
        evt('driftEnd', K.id, { tier: tier });
        D.charge = 0; D.tier = 0;
      } else {
        var into = clamp(K.steer * D.dir, -1, 1);
        D.charge += dt * (0.8 + 0.45 * Math.max(0, into));
        var t2 = N.driftTier(D.charge);
        if (t2 !== D.tier) { D.tier = t2; evt('driftTier', K.id, { tier: t2 }); }
        if (O.nitro) N.gain(K.nitro, 'drift', N.GAIN.drift * dt);
      }
      K.prevDriftWant = want;
    }

    function slipAndPasses(K, dt) {
      var L = trackLen(), S = N.SLIP, best = null, bestDs = Infinity;
      for (var i = 0; i < W.list.length; i++) {
        var o = W.list[i];
        if (o === K) continue;
        var ds = wrapD(o.s - K.s, L), dl = o.lat - K.lat;
        // slipstream candidate: directly ahead
        if (ds > S.minDs && ds < S.maxDs && Math.abs(dl) < S.maxLat && K.speed > S.minSpeed && ds < bestDs) { best = o; bestDs = ds; }
        // near miss: o moved from ahead to behind (we passed it) close alongside without contact
        var prev = K.prevDs[o.id];
        if (prev != null && prev > 0 && ds <= 0 && Math.abs(ds) < 8 && Math.abs(dl) > K.halfW + o.halfW + 0.05 && Math.abs(dl) < K.halfW + o.halfW + 1.3 &&
            K.speed - o.speed > 3 && O.nitro) {
          N.gain(K.nitro, 'nearMiss'); K.st.nearMisses++;
          evt('nearMiss', K.id, { other: o.id });
        }
        K.prevDs[o.id] = Math.abs(ds) < 40 ? ds : null;
      }
      var sl = K.slip;
      if (best && !K.boost) {
        if (sl.target !== best.id) { sl.target = best.id; sl.charge = Math.min(sl.charge, 0.3); }
        sl.charge += dt / S.charge_s * (1 - bestDs / S.maxDs * 0.5);
        if (sl.charge >= 1) {
          sl.charge = 0; sl.target = null;
          boost(K, 'slip', S.boost_s, 1.1, 6);
          if (O.nitro) N.gain(K.nitro, 'slipstream');
          evt('slipstream', K.id, { other: best.id });
        }
      } else {
        sl.charge = Math.max(0, sl.charge - dt * 0.8);
        if (sl.charge === 0) sl.target = null;
      }
      // overtakes
      K.overtakeCool = Math.max(0, K.overtakeCool - dt);
      if (K.pos < K.lastPos && W.started && O.nitro) {
        if (K.overtakeCool <= 0) { N.gain(K.nitro, 'overtake', N.GAIN.overtake * (K.lastPos - K.pos)); evt('overtake', K.id, { pos: K.pos }); }
        K.overtakeCool = 1.2;
      }
    }

    function airStep(K, dt) {
      if (K.airborne) { K.airT += dt; if (O.nitro) N.gain(K.nitro, 'air', N.GAIN.air * dt); return; }
      if (K.wasAir && K.airT > 0) {
        var at = K.airT;
        K.airT = 0;
        if (at >= 0.45) {
          if (O.nitro) N.gain(K.nitro, 'landing');
          evt('landing', K.id, { air: round(at, 2), big: at >= 0.9 });
          if (at >= 0.9) boost(K, 'trick', 0.6, 1.12, 9);
        }
      } else K.airT = 0;
    }

    function overlaps(K, e, rS, rL) {
      var ds = wrapD(e.s - K.s, trackLen());
      return Math.abs(ds) < rS && Math.abs(e.lat - K.lat) < rL;
    }

    /** a kart over a static pickup (box / pad / ring / coin / can) */
    function pickup(K, e) {
      if (e.type === 'box') {
        if (overlaps(K, e, BOX_R + 0.6, BOX_R + K.halfW)) {
          e.respawn = BOX_RESPAWN; K.st.boxes++;
          evt('itemBox', K.id, { entity: e.id });
          if (!K.item && !K.roulette && O.items) startRoulette(K);
        }
      } else if (e.type === 'pad') {
        if (K.padCool <= 0 && overlaps(K, e, num(e.len, PAD.len) / 2 + 1, num(e.w, PAD.w) / 2 + K.halfW * 0.5)) {
          K.padCool = 0.6; boost(K, 'pad', PAD.boost_s, PAD.top, PAD.accel);
        }
      } else if (e.type === 'ring') {
        if (K.padCool <= 0 && overlaps(K, e, 1.5, num(e.r, RING.r))) {
          K.padCool = 0.6; boost(K, 'ring', RING.boost_s, RING.top, RING.accel);
          if (O.nitro) N.gain(K.nitro, 'ring');
        }
      } else if (e.type === 'coin') {
        if (overlaps(K, e, COIN_R + 0.5, COIN_R + K.halfW)) {
          e.respawn = COIN_RESPAWN;
          if (K.coins < COIN_CAP) { K.coins++; K.st.coins++; }
          evt('coin', K.id, { entity: e.id, coins: K.coins });
        }
      } else if (e.type === 'can') {
        if (overlaps(K, e, CAN_R + 0.6, CAN_R + K.halfW)) {
          e.respawn = CAN_RESPAWN;
          N.gain(K.nitro, 'canister');
          evt('canister', K.id, { entity: e.id });
        }
      }
    }
    /** netarcade host, the 2nd physics step of a remote player's copy in one tick (input-delay catch-up): the layer
        steps that kart once more, from where its first step left it — timers, nitro, pickups, effects — exactly what the
        player's own session did before its own step of that input */
    function netExtraStep(car) {
      var K = car && kart(car.id);
      if (!K || !W.started || W.phase === 'grid' || W.phase === 'countdown' || follower()) return false;
      syncKart(K, engineView(car));
      kartStep(K, 1 / 120);
      if (!K.finished) for (var i = 0; i < W.ents.length; i++) { var e = W.ents[i]; if (!(e.respawn > 0)) pickup(K, e); }
      computeFx(K);
      return true;
    }

    function entityStep(dt) {
      var L = trackLen(), list = W.list, i, j, e, K;
      for (i = W.ents.length - 1; i >= 0; i--) {
        e = W.ents[i];
        if (e.respawn > 0) { e.respawn = Math.max(0, e.respawn - dt); continue; }
        if (e.life > 0) { e.life -= dt; if (e.life <= 0) { W.ents.splice(i, 1); evt('despawn', null, { entity: e.id, kind: e.type }); continue; } }
        if (e.type === 'rocket') {
          e.age += dt;
          var tgt = e.target ? kart(e.target) : null;
          if (tgt && !tgt.finished) {
            var gap = (tgt.dist - e.d) * e.dir;
            if (e.dir > 0) e.speed = Math.max(e.speed, tgt.speed + 12);
            if (gap < 90) e.lat += clamp(tgt.lat - e.lat, -9 * dt, 9 * dt);
          }
          e.d += e.dir * e.speed * dt;
          e.s = wrapS(e.d, L);
        }
        if (e.type === 'oil') e.age += dt;
        for (j = 0; j < list.length; j++) {
          K = list[j];
          if (K.finished && e.type !== 'box') continue;
          if (K.netHeld) continue;   // a remote copy holding its physics step this tick (netarcade): it did not move
          switch (e.type) {
            case 'box': case 'pad': case 'ring': case 'coin': case 'can': pickup(K, e); break;
            case 'oil':
              if (K.ghostT <= 0 && (e.owner !== K.id || e.age > 1.2) && overlaps(K, e, 1.9 + 1.2, 1.9 + K.halfW * 0.6)) {
                hit(K, 'oil', e.owner);   // a shield / hit cool-down still soaks the slick up
                W.ents.splice(i, 1); evt('despawn', null, { entity: e.id, kind: 'oil' }); j = list.length;
              }
              break;
            case 'rocket':
              if ((e.owner !== K.id || e.age > 1.5) && overlaps(K, e, 2.6, 1.8 + K.halfW * 0.5)) {
                hit(K, 'rocket', e.owner);
                evt('explode', K.id, { entity: e.id, s: round(e.s, 2), lat: round(e.lat, 2) });
                W.ents.splice(i, 1); j = list.length;
              }
              break;
            default: break;
          }
          if (W.ents[i] !== e) break;
        }
      }
    }

    function timers(K, dt) {
      if (K.spinReq && W.steps - K.spinReqStep > 1) K.spinReq = null;   // one-shot: engine postStep consumes it, effects() shows it for a step
      if (K.boost) { K.boost.t -= dt; if (K.boost.t <= 0) K.boost = null; }
      K.shieldT = Math.max(0, K.shieldT - dt); K.ghostT = Math.max(0, K.ghostT - dt); K.magnetT = Math.max(0, K.magnetT - dt);
      K.spinT = Math.max(0, K.spinT - dt); K.hopT = Math.max(0, K.hopT - dt); K.slowT = Math.max(0, K.slowT - dt);
      K.bogT = Math.max(0, K.bogT - dt); K.hitCool = Math.max(0, K.hitCool - dt); K.padCool = Math.max(0, K.padCool - dt);
      if (K.roulette) { K.roulette.t += dt; if (K.roulette.t >= K.roulette.dur) finishRoulette(K); }
    }

    function computeFx(K) {
      var f = K.fx;
      var vTop = K.vTop * CLS.top * (1 + 0.01 * K.coins);
      f.push = 0; f.vTarget = vTop; f.brakeTo = null; f.brakeDecel = 0; f.throttleMult = 1; f.steer = null; f.stripHandbrake = false;
      f.boostKind = null; f.nitroOn = !!K.nitro.burning;
      if (W.started && CLS.accel > 0 && K.throttle > 0.3) { f.push = CLS.accel * K.throttle; f.vTarget = vTop; }
      function want(top, accel) { var vt = vTop * top; if (accel > f.push) f.push = accel; if (vt > f.vTarget) f.vTarget = vt; }
      if (K.boost) { want(K.boost.top, K.boost.accel); f.boostKind = K.boost.kind; }
      if (K.nitro.burning) { want(NITRO_TOP, NITRO_ACCEL); f.boostKind = f.boostKind || 'nitro'; }
      if (K.slip.charge > 0.05) want(1.03, N.SLIP.push * K.slip.charge);
      if (K.magnetT > 0) {
        var A = carAhead(K), D = I.get('magnet');
        if (A && A.dist - K.dist < D.range) want(D.top, D.accel);
      }
      if (K.ghostT > 0) want(I.get('ghost').top, 2);
      // AI rubber band
      var P = leadHuman();
      if (O.rubberBand && !human(K) && P && P !== K && W.started) {
        var gap = P.dist - K.dist;
        var agg = CLS.aiAgg;
        if (gap > 15) { var g = Math.min(1, (gap - 15) / 180); want(1 + 0.07 * g * agg, DIFF.rbBehind * g * agg); }
        else if (gap < -25) f.throttleMult *= 1 - DIFF.rbAhead * Math.min(1, (-gap - 25) / 220) / agg;
      }
      if (K.slowT > 0) { f.throttleMult *= 0.25; f.push = 0; if (!(K.nativeSpin && K.spinT > 0)) { f.brakeTo = K.slowRef * K.slowTo; f.brakeDecel = 26; } }
      if (K.bogT > 0) { f.throttleMult *= 0.2; f.push = 0; }
      if (K.spinT > 0) f.throttleMult *= 0.15;
      // drift steering: stylised slide that never spins (handbrake never reaches the tyres)
      if (K.drift.on && !K.nativeSlide) {
        var into = clamp(K.steer * K.drift.dir, -1, 1);
        f.stripHandbrake = true;
        f.steer = K.drift.dir * clamp(0.5 + 0.42 * into, 0.06, 0.95);
        f.slide = K.drift.dir * (0.3 + 0.12 * Math.max(0, into));
      } else f.slide *= 0.85;   // ease the visual slide angle back out
      if (Math.abs(f.slide) < 0.002) f.slide = 0;
      if (human(K) && K.input.drift && !K.drift.on && !K.nativeSlide) f.stripHandbrake = K.speed > 13;   // tap-hop before the slide starts
      // visuals
      if (K.spinT > 0 && !K.nativeSpin) { var p = 1 - K.spinT / K.spinDur; f.yaw = K.spinDir * TAU * (p * p * (3 - 2 * p)); } else f.yaw = 0;
      f.spinReq = K.spinReq || null;
      if (K.hopT > 0) { var q = 1 - K.hopT / K.hopDur; f.hop = 4 * K.hopH * q * (1 - q); } else f.hop = 0;
      f.noCollide = K.ghostT > 0; f.ghost = K.ghostT > 0; f.shielded = K.shieldT > 0;
      return f;
    }

    /** Rubber-band / AI nitro reference: the human furthest along (single player: the player). */
    function leadHuman() {
      var best = W.player || null;
      for (var i = 0; i < W.list.length; i++) { var K = W.list[i]; if (K.human && !K.finished && (!best || K.dist > best.dist)) best = K; }
      return best;
    }

    /* ---------------- multiplayer follower (client mirror of a host-authoritative race) ----------------
       No random decisions and no hits: the host owns boxes, rolls, items, hits, coins and canisters (netApply / applyHit
       bring them in). Only the local player's deterministic, self-caused effects are predicted (nitro burn, powerslide
       mini-turbo, landing / trick boosts, boost pads + rings) so the own car responds at once. */
    function followerStep(dt) {
      var list = W.list, i, j, K, e, L = trackLen();
      for (i = 0; i < list.length; i++) {
        K = list[i];
        timers(K, dt);
        if (!K.isPlayer || K.finished) continue;
        var was = K.nitro.burning;
        N.burn(K.nitro, dt, !!K.input.nitro && O.nitro && K.spinT <= 0 && K.slowT <= 0);
        if (K.nitro.burning && !was) evt('nitroStart', K.id, {});
        else if (!K.nitro.burning && was) evt('nitroEnd', K.id, {});
        driftStep(K, dt);
        airStep(K, dt);
      }
      for (i = 0; i < W.ents.length; i++) {
        e = W.ents[i];
        if (e.respawn > 0) { e.respawn = Math.max(0, e.respawn - dt); continue; }
        if (e.type === 'rocket') { e.age += dt; e.d += e.dir * num(e.speed, 60) * dt; e.s = wrapS(e.d, L); continue; }
        if (e.type === 'oil') { e.age += dt; continue; }
        if (e.type !== 'pad' && e.type !== 'ring') continue;
        for (j = 0; j < list.length; j++) {
          K = list[j];
          if (!K.isPlayer || K.finished || K.padCool > 0) continue;
          if (e.type === 'pad' && overlaps(K, e, num(e.len, PAD.len) / 2 + 1, num(e.w, PAD.w) / 2 + K.halfW * 0.5)) { K.padCool = 0.6; boost(K, 'pad', PAD.boost_s, PAD.top, PAD.accel); }
          else if (e.type === 'ring' && overlaps(K, e, 1.5, num(e.r, RING.r))) { K.padCool = 0.6; boost(K, 'ring', RING.boost_s, RING.top, RING.accel); if (O.nitro) N.gain(K.nitro, 'ring'); }
        }
      }
      for (i = 0; i < list.length; i++) computeFx(list[i]);
    }
    /** Host-decided hit on a car (follower: the host already checked shields / ghosts / cool-downs). */
    function applyHit(K, kind) {
      if (!K) return;
      var D = I.get(kind) || {};
      K.slowRef = Math.max(K.speed, 8);
      K.drift.on = false; K.drift.charge = 0; K.drift.tier = 0;
      K.boost = null; K.nitro.burning = false; K.magnetT = 0; K.hitCool = 1.3;
      K.spinT = 0;
      if (kind === 'oil') { K.spinT = K.spinDur = num(D.spin_s, 0.95); K.spinDir = K.lat >= 0 ? 1 : -1; K.slowT = 0.95; K.slowTo = num(D.slowTo, 0.55); }
      else if (kind === 'rocket') { K.hopT = K.hopDur = num(D.hop_s, 1); K.hopH = num(D.hopH, 1.5); K.spinT = K.spinDur = num(D.hop_s, 1); K.spinDir = 1; K.slowT = 1.0; K.slowTo = num(D.slowTo, 0.42); }
      else if (kind === 'emp') { K.slowT = num(D.slow_s, 1.3); K.slowTo = num(D.slowTo, 0.68); }
      else if (kind === 'lightning') { K.slowT = num(D.slow_s, 2.3); K.slowTo = num(D.slowTo, 0.64); K.hopT = K.hopDur = 0.35; K.hopH = 0.35; }
      else { K.slowT = 0.8; K.slowTo = 0.6; }
      if (K.spinT > 0) { K.spinReqStep = W.steps; K.spinReq = { duration: K.spinDur, dir: K.spinDir, speedLoss: 1 - K.slowTo, turns: 1 }; }
      computeFx(K);
    }

    /* ---------------- multiplayer state transfer (compact, quantised) ---------------- */
    function q(v, k) { return Math.round(num(v, 0) * k); }
    var PREDICTED_BOOSTS = { pad: 1, ring: 1, drift1: 1, drift2: 1, drift3: 1, trick: 1, start: 1, nitro: 1 };
    /** Host -> clients: every kart's power-up state + moving / respawning entities. JSON-able, ~40 B per kart. */
    function netPack() {
      var ks = W.list.map(function (K) {
        var b = K.boost, r = K.roulette;
        return [K.id, q(K.nitro.level, 1000), K.nitro.burning ? 1 : 0,
          b ? [b.kind, q(b.t, 1000), q(b.dur, 1000), q(b.top, 1000), q(b.accel, 10)] : 0,
          K.item ? [K.item.id, K.item.uses] : 0, r ? [r.final, q(r.t, 1000), q(r.dur, 1000)] : 0,
          q(K.shieldT, 1000), q(K.ghostT, 1000), q(K.magnetT, 1000),
          [q(K.spinT, 1000), q(K.spinDur, 1000), K.spinDir, q(K.slowT, 1000), q(K.slowTo, 1000), q(K.slowRef, 10), q(K.hopT, 1000), q(K.hopDur, 1000), q(K.hopH, 100), q(K.hitCool, 1000)],
          K.coins, K.drift.on ? K.drift.tier + 1 : 0, K.startGrade || 0, K.itemDone | 0, q(K.slip.charge, 1000)];
      });
      var dyn = [], off = {};
      W.ents.forEach(function (e) {
        if (e.type === 'rocket') dyn.push([e.id, 'rocket', q(e.s, 100), q(e.lat, 100), q(e.d, 100), e.dir, q(e.speed, 10), e.target, q(e.age, 100), q(e.life, 100), e.owner]);
        else if (e.type === 'oil') dyn.push([e.id, 'oil', q(e.s, 100), q(e.lat, 100), 0, 0, 0, null, q(e.age, 100), q(e.life, 100), e.owner]);
        else if (e.respawn > 0) off[e.id] = q(e.respawn, 100);
      });
      return { v: 1, t: Math.round(W.t * 1000), k: ks, d: dyn, o: off, n: W.nextId };
    }
    /** Client: merge the host's state. opts { map(hostId) -> local id, self: local player id, age: seconds since the host
        took it }. The own kart keeps its predicted nitro / drift / self-caused boosts; everything else comes from the host. */
    function netApply(P, opts) {
      if (!P || P.v !== 1) return false;
      opts = opts || {};
      var map = typeof opts.map === 'function' ? opts.map : function (id) { return id; };
      var age = clamp(num(opts.age, 0), 0, 1), self = opts.self == null ? 'player' : String(opts.self);
      (P.k || []).forEach(function (a) {
        var K = kart(map(a[0]));
        if (!K) return;
        var mine = K.id === self, b = a[3], it = a[4], r = a[5], h = a[9] || [];
        var hb = b ? { kind: b[0], t: Math.max(0, b[1] / 1000 - age), dur: b[2] / 1000, top: b[3] / 1000, accel: b[4] / 10 } : null;
        K.item = it ? { id: it[0], uses: it[1] } : null;
        if (r) {
          var keep = K.roulette && K.roulette.final === r[0] ? K.roulette.strip : null;
          K.roulette = { t: r[1] / 1000 + age, dur: r[2] / 1000, final: r[0], strip: keep || (K.isPlayer ? I.rouletteStrip(makeRng(a[0].length * 977 + r[2]), r[0], 16) : null) };
        } else K.roulette = null;
        K.shieldT = Math.max(0, a[6] / 1000 - age); K.ghostT = Math.max(0, a[7] / 1000 - age); K.magnetT = Math.max(0, a[8] / 1000 - age);
        K.coins = a[10] | 0; K.itemDone = a[13] | 0;
        if (a[12] && !K.startGrade) K.startGrade = a[12];
        if (!mine) {
          K.nitro.level = a[1] / 1000; K.nitro.burning = !!a[2]; K.boost = hb;
          K.spinT = Math.max(0, h[0] / 1000 - age); K.spinDur = h[1] / 1000 || 1; K.spinDir = h[2] || 1; K.slowT = Math.max(0, h[3] / 1000 - age);
          K.slowTo = h[4] / 1000; K.slowRef = h[5] / 10; K.hopT = Math.max(0, h[6] / 1000 - age); K.hopDur = h[7] / 1000 || 1; K.hopH = h[8] / 100; K.hitCool = h[9] / 1000;
          K.drift.on = a[11] > 0; K.drift.tier = Math.max(0, a[11] - 1); K.slip.charge = a[14] / 1000;
        } else {
          var hl = a[1] / 1000;
          if (Math.abs(hl - K.nitro.level) > 0.15) K.nitro.level = hl; else K.nitro.level += (hl - K.nitro.level) * 0.2;
          if (hb && !PREDICTED_BOOSTS[hb.kind] && hb.t > 0.05 && (!K.boost || K.boost.kind !== hb.kind)) K.boost = hb;
          K.slip.charge = a[14] / 1000;
        }
        computeFx(K);
      });
      var L = Math.max(1, trackLen()), seen = {};
      (P.d || []).forEach(function (a) {
        seen[a[0]] = 1;
        var e = null;
        for (var i = 0; i < W.ents.length; i++) if (W.ents[i].id === a[0]) { e = W.ents[i]; break; }
        if (!e) { e = { id: a[0], type: a[1], respawn: 0, z: 0 }; W.ents.push(e); }
        e.lat = a[3] / 100; e.age = a[8] / 100 + age; e.life = a[9] / 100 - age; e.owner = a[10] != null ? map(a[10]) : null;
        if (a[1] === 'rocket') { e.dir = a[5]; e.speed = a[6] / 10; e.target = a[7] != null ? map(a[7]) : null; e.d = a[4] / 100 + e.dir * e.speed * age; e.s = wrapS(e.d, L); }
        else e.s = a[2] / 100;
      });
      var off = P.o || {};
      W.ents = W.ents.filter(function (e) {
        if (e.type === 'rocket' || e.type === 'oil') return !!seen[e.id];
        e.respawn = off[e.id] ? Math.max(0, off[e.id] / 100 - age) : 0;
        return true;
      });
      if (isNum(P.n) && P.n > W.nextId) W.nextId = P.n;
      return true;
    }
    /** Client: host events (HUD callouts / FX / SFX), carIds already mapped to local ids. */
    function pushEvents(list) {
      (list || []).forEach(function (e) {
        if (!e || !e.type) return;
        var o = {}; for (var k in e) o[k] = e[k];
        o.id = W.nextEvt++; o.net = true;
        W.events.push(o);
        if (W.events.length > 400) W.events.shift();
      });
    }

    function kartStep(K, dt) {
      timers(K, dt);
      if (K.finished) { K.nitro.burning = false; K.drift.on = false; return; }
      if (!human(K) && O.nitro) N.gain(K.nitro, 'passive', DIFF.passive * dt);
      var held = human(K) ? !!K.input.nitro : aiNitro(K);
      var was = K.nitro.burning;
      N.burn(K.nitro, dt, held && O.nitro && K.spinT <= 0 && K.slowT <= 0);
      if (K.nitro.burning) K.st.nitroUsed_s += dt;
      if (K.nitro.burning && !was) evt('nitroStart', K.id, {});
      else if (!K.nitro.burning && was) evt('nitroEnd', K.id, {});
      if (human(K)) driftStep(K, dt);
      slipAndPasses(K, dt);
      airStep(K, dt);
    }
    function step(dt, ctx) {
      if (!(dt > 0) || !ctx) return;
      if (isNum(ctx.trackLength) && ctx.trackLength > 0 && !(W.L > 0)) { W.L = ctx.trackLength; buildLayout(); }
      W.t = num(ctx.t, W.t + dt);
      syncViews(ctx.cars || []);
      var ph = ctx.phase || 'racing', list = W.list, i, K;
      W.phase = ph;
      W.steps++;
      if (ph === 'grid' || ph === 'countdown') {
        for (i = 0; i < list.length; i++) preStart(list[i], dt);
        for (i = 0; i < list.length; i++) computeFx(list[i]);
        return;
      }
      if (!W.started && (ph === 'racing' || ph === 'finished')) {
        W.started = true;
        for (i = 0; i < list.length; i++) if (!follower() || list[i].isPlayer) launch(list[i]);
      }
      if (follower()) { followerStep(dt); return; }
      for (i = 0; i < list.length; i++) {
        K = list[i];
        // netarcade host: a remote player's copy that holds its physics step this tick (input-delay re-timing) holds its
        // timers / nitro / pickups too (else boosts and bogs ended a tick off its player's own prediction); a doubled
        // step gets its second layer step from netExtraStep
        K.netHeld = K.netSteps === 0;
        K.netSteps = 1;
        if (!K.netHeld) kartStep(K, dt);
      }
      entityStep(dt);
      for (i = 0; i < list.length; i++) {
        K = list[i];
        if (K.finished) continue;
        if (K.isPlayer) {
          var pressed = !!K.input.item && !K.itemPrev;
          K.itemPrev = !!K.input.item;
          if (pressed) useItem(K, !!K.input.aimBack);
        } else if (K.human) {
          var seq = K.input.itemSeq | 0;   // remote buttons arrive as a press counter (no lost or doubled presses)
          if (seq > K.itemDone) { K.itemDone = seq; useItem(K, !!K.input.aimBack); }
        } else if (O.items || K.item) aiItems(K, dt);
      }
      for (i = 0; i < list.length; i++) computeFx(list[i]);
    }

    /* ---------------- engine adapter (CB.race.engine cfg.hooks) ---------------- */
    var eng = { cars: [], lastT: -1, session: null, A: null, poseAt: null };
    function vTopOf(car) {
      var p = car.params || {};
      var v = num(p.capabilities && p.capabilities.topSpeed_mps, num(p.topSpeed_ms, NaN));
      if (!(v > 10)) v = num(car.metrics && car.metrics.topSpeed_kph, 220) / 3.6;
      return clamp(v, 25, 120);
    }
    function isArc(car) { return !!(car && car.params && car.params.handling === 'arcade' && car.params.arcade); }
    function engineView(car) {
      var st = car.state || {}, inp = car.input || {};
      // engine cars carry lapS / lateral / raceDist / tracker; stunt cars (track-space motion) s / lat / dist / lap / v
      return {
        id: car.id, isPlayer: !!car.isPlayer, s: num(car.lapS, num(car.s, num(st.s, 0))), lap: car.tracker ? car.tracker.lap : num(car.lap, num(st.lap, 0)),
        dist: num(car.raceDist, num(car.dist, num(st.dist, 0))), lat: num(car.lateral, num(car.lat, num(st.lat, 0))),
        speed: Math.abs(num(st.speed, num(st.vx, num(st.v, num(car.v, 0))))),
        position: num(car.position, 1), vTop: car._arcVTop || (car._arcVTop = vTopOf(car)), halfW: num(car.halfW, 0.95),
        throttle: num(inp.throttle, 0), steer: num(inp.steer, 0), finished: !!car.finished || !!car.dnf, onTrack: car.onTrack !== false,
        airborne: !!(car.airborne || st.airborne || st.mode === 'air' || car.mode === 'air'),
        powerslide: isArc(car) && 'powerslide' in st ? !!st.powerslide : undefined, slideDir: num(st.slideDir, 0), nativeSpin: !!(car.V && typeof car.V.spinOut === 'function')
      };
    }
    function engineStep(car) {
      var ctx = car.ctx || {};
      var t = num(ctx.t, num(car.t, NaN));
      if (!isNum(t)) t = (eng.lastT > 0 ? eng.lastT : 0) + (car.idx === 0 || car === eng.cars[0] ? 1 / 120 : 0);
      if (t === eng.lastT) return;
      eng.lastT = t;
      if (!(W.L > 0) && isNum(ctx.trackLength)) { W.L = ctx.trackLength; if (!track) track = { length: W.L }; buildLayout(); }
      var views = new Array(eng.cars.length);
      for (var i = 0; i < eng.cars.length; i++) views[i] = engineView(eng.cars[i]);
      step(1 / 120, { t: t, phase: ctx.phase, cars: views });
    }
    function applyVel(car, f, dt) {
      var st = car.state, p = car.params || {};
      if (!st || !isNum(st.vx)) return;
      var v = st.vx, dv = 0;
      if (f.push > 0 && v < f.vTarget && v > -1 && !isArc(car)) dv = Math.min(f.push * dt, f.vTarget - v);
      if (f.brakeTo != null && v > f.brakeTo) dv = -Math.min(v - f.brakeTo, f.brakeDecel * dt);
      if (!dv) return;
      var k = v > 0.5 ? (v + dv) / v : 1;
      st.vx = v + dv;
      if (dv < 0 && isNum(st.vy)) st.vy *= k;
      if (Array.isArray(st.wheels)) {
        var rF = num(p.radiusF, 0.33), rR = num(p.radiusR, rF);
        for (var w = 0; w < st.wheels.length; w++) if (st.wheels[w] && isNum(st.wheels[w].omega)) st.wheels[w].omega += dv / (w < 2 ? rF : rR);
      }
      if ('speed' in st) st.speed = Math.sqrt(st.vx * st.vx + num(st.vy, 0) * num(st.vy, 0));
    }
    var hooks = {
      name: 'arcade-gameplay',
      carCreated: function (car) {
        if (!car) return;
        if (car.idx === 0 || !eng.cars.length) { eng.cars = []; eng.lastT = -1; reset(); }
        eng.cars.push(car);
      },
      preStep: function (car, inp, dt) {
        engineStep(car);
        var K = kart(car.id);
        if (!K) return inp;
        var ph = car.ctx && car.ctx.phase;
        if (K.isPlayer) { K.input.drift = !!inp.handbrake; K.input.rev = Math.max(num(inp.throttle, 0), num(PIN.revExt, 0)); }
        else if (K.human) { K.input.drift = !!inp.handbrake; K.input.rev = num(inp.throttle, 0); }
        if (ph === 'grid' || ph === 'countdown') {
          // rev freely on the grid without creeping (the brakes hold the car; the rev gauge reads the pedal)
          // (service brake only while rolling: held at a standstill the vehicle would select reverse and creep = jump start)
          var rolling = Math.abs(num(car.state && car.state.speed, num(car.state && car.state.vx, 0))) > 0.6;
          return { throttle: 0, brake: rolling ? 1 : 0, steer: 0, handbrake: true, shiftUp: false, shiftDown: false, reverse: false, requestReset: false, pit: false };
        }
        var f = K.fx, out = inp;
        car.arcadeFx = f;   // full per-car effects for track-space integrators (stunt sessions): brakeTo, spinReq, yaw, hop ...
        if (f.throttleMult !== 1 || f.steer != null || (f.stripHandbrake && inp.handbrake)) {
          out = {};
          for (var k in inp) out[k] = inp[k];
          out.throttle = clamp01(num(inp.throttle, 0) * f.throttleMult);
          if (f.steer != null) out.steer = f.steer;
          if (f.stripHandbrake) out.handbrake = false;
        }
        car.noCollide = !!f.noCollide;
        return out;
      },
      /** arcade handling: boosts go through the vehicle's own env.arcade { push, topSpeedMult } (ARCADE-SPEC §1) */
      vehicleEnv: function (car, env) {
        var K = kart(car.id);
        if (!K || !W.started || !isArc(car)) return env;
        var f = K.fx, st = car.state || {}, v = num(st.vx, 0);
        var push = f.push > 0 && v < f.vTarget ? Math.min(f.push, (f.vTarget - v) * 120) : 0;
        var topM = K.vTop > 0 ? Math.max(1, f.vTarget / K.vTop) : 1;
        if (!push && topM === 1) return env;
        var prev = env.arcade || {};
        var ar = {};
        for (var k in prev) ar[k] = prev[k];
        ar.push = num(prev.push, 0) + push;
        ar.topSpeedMult = Math.max(num(prev.topSpeedMult, 1), topM);
        var out = {};
        for (var k2 in env) out[k2] = env[k2];
        out.arcade = ar;
        return out;
      },
      postStep: function (car, dt) {
        var K = kart(car.id);
        if (!K || !W.started) return;
        if (K.spinReq) {
          var V = car.V;
          if (V && typeof V.spinOut === 'function' && car.state) { try { V.spinOut(car.params, car.state, K.spinReq); K.nativeSpin = true; } catch (e) { /* visual fallback */ } }
          K.spinReq = null;
        }
        applyVel(car, K.fx, dt);
      }
    };

    /** The CB.race.engine session inside wrappers (assist / drift session: .engine or _debug().inner; arcade mode wrap). */
    function findEngineDebug(sess) {
      var seen = [], q = [sess];
      while (q.length && seen.length < 12) {
        var x = q.shift();
        if (!x || typeof x !== 'object' || seen.indexOf(x) >= 0) continue;
        seen.push(x);
        var d = null;
        try { d = typeof x._debug === 'function' ? x._debug() : null; } catch (e) { d = null; }
        if (d && d.A && d.A.L > 0) return d;
        q.push(x.engine, x.inner, x.session, d && d.inner, d && d.engine);
      }
      return null;
    }
    function attachEngine(session, aopt) {
      eng.session = session;
      var dbg = findEngineDebug(session);
      var A = dbg && dbg.A;
      var poseAt = CB.race && CB.race.engine && CB.race.engine._internal && CB.race.engine._internal.poseAt;
      if (A && A.L > 0) {
        eng.A = A; eng.poseAt = poseAt;
        var idxAt = function (s) {
          var sa = wrapS(s + A.s0, A.L), lo = 0, hi = A.n - 1;
          while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (A.S[mid] <= sa) lo = mid; else hi = mid - 1; }
          return lo;
        };
        track = {
          length: A.L,
          halfWidth: function (s) { return A.W[idxAt(s)] / 2; },
          curvature: function (s) { return A.K[idxAt(s)]; },
          pose: function (s, lat) { return poseAt ? poseAt(A, s, lat) : null; }
        };
        if (W.L !== A.L || !W.ents.length) { W.L = A.L; buildLayout(); }
      }
      if (!(aopt && aopt.wrapSnapshot === false) && session && typeof session.snapshot === 'function' && !session._arcadeWrapped) {
        var orig = session.snapshot;
        session.snapshot = function () { return decorate(orig.apply(session, arguments)); };
        session._arcadeWrapped = true;
      }
      return api;
    }

    /* ---------------- public / snapshot decoration ---------------- */
    function publicKart(K) {
      var b = K.boost;
      return {
        id: K.id, isPlayer: K.isPlayer, nitro: round(K.nitro.level, 4), nitroOn: !!K.nitro.burning,
        boost: b ? { kind: b.kind, t: round(b.t, 3), dur: round(b.dur, 3) } : null,
        item: K.item ? { id: K.item.id, uses: K.item.uses } : null,
        roulette: K.roulette ? { t: round(K.roulette.t, 3), dur: K.roulette.dur, final: K.roulette.final, strip: K.roulette.strip } : null,
        shield: round(K.shieldT, 2), ghost: round(K.ghostT, 2), magnet: round(K.magnetT, 2), spin: round(K.spinT, 2), hop: round(K.fx.hop, 3),
        slow: round(K.slowT, 2), coins: K.coins, drift: K.drift.on ? { dir: K.drift.dir, charge: round(K.drift.charge, 2), tier: K.drift.tier } : null,
        slip: round(K.slip.charge, 3), rev: round(K.rev.v, 3), flooded: !!K.rev.flooded, startGrade: K.startGrade, airT: round(K.airT, 2),
        position: K.pos, s: K.s, lat: K.lat
      };
    }
    function publicEnt(e) {
      var o = { id: e.id, type: e.type, s: e.s, lat: e.lat, active: !(e.respawn > 0), respawn: round(e.respawn, 2) };
      if (e.type === 'rocket') { o.dir = e.dir; o.target = e.target; o.age = round(e.age, 2); }
      if (e.type === 'oil') o.age = round(e.age, 2);
      if (e.z) o.z = e.z;
      if (e.len) o.len = e.len; if (e.w) o.w = e.w; if (e.r) o.r = e.r;
      return o;
    }
    function state() {
      var ks = {};
      W.list.forEach(function (K) { ks[K.id] = publicKart(K); });
      return {
        t: W.t, phase: W.phase, started: W.started, karts: ks, player: W.player ? ks[W.player.id] : null,
        entities: W.ents.map(publicEnt), options: Object.assign({}, O, { layout: Array.isArray(O.layout) ? 'custom' : O.layout, extraEntities: undefined }),
        speedClass: CLS, trackLength: trackLen()
      };
    }
    /** decorate(snap) -> snap with snap.arcade = state;  decorate(snap, {key: null}) -> state (snap.arcade untouched,
        for CB.arcade.mode extension snapshots where the wrapper owns snap.arcade). Drains the event queue. */
    function decorate(snap, dopt) {
      var keyless = dopt && dopt.key === null;
      if (!snap || !Array.isArray(snap.cars)) return keyless ? null : snap;
      var st = state();
      st.events = takeEvents();
      if (!keyless) snap.arcade = st;
      for (var i = 0; i < snap.cars.length; i++) {
        var c = snap.cars[i], K = kart(c.id);
        if (!K) continue;
        var f = K.fx, off = f.yaw + f.slide;
        if (off) { c.heading += off; if (isNum(c.prevHeading)) c.prevHeading += off; }
        c.arcadeHop = f.hop;
        c.arcade = st.karts[c.id];
      }
      return keyless ? st : snap;
    }
    function takeEvents() { var e = W.events; W.events = []; return e; }

    function serialize() {
      return JSON.parse(JSON.stringify({
        v: 1, t: W.t, L: W.L, rng: W.rng.state(), nextId: W.nextId, nextEvt: W.nextEvt, phase: W.phase, started: W.started,
        ents: W.ents,
        karts: W.list.map(function (K) {
          var o = {};
          for (var k in K) if (k !== 'fx') o[k] = K[k];
          return o;
        })
      }));
    }
    function load(s) {
      if (!s || s.v !== 1) return false;
      reset();
      W.t = s.t; W.L = s.L; W.rng.setState(s.rng); W.nextId = s.nextId; W.nextEvt = s.nextEvt; W.phase = s.phase; W.started = s.started;
      W.ents = JSON.parse(JSON.stringify(s.ents));
      W.list = s.karts.map(function (o) {
        var K = JSON.parse(JSON.stringify(o)); K.fx = neutralFx(); W.karts[K.id] = K;
        if (K.isPlayer) { W.player = K; if (K.input) for (var pk in K.input) PIN[pk] = K.input[pk]; K.input = PIN; }   // keep the live button object
        return K;
      });
      W.list.forEach(computeFx);
      return true;
    }

    var api = {
      options: O, speedClass: CLS, hooks: hooks,
      step: step, effects: function (id) { var K = kart(id); return K ? K.fx : neutralFx(); },
      setInput: function (id, inp) {
        if (id && typeof id === 'object') { inp = id; id = null; }
        var K = id == null ? null : kart(id);
        var target = !K || K.isPlayer ? PIN : K.input;
        inp = inp || {};
        ['nitro', 'item', 'aimBack', 'aimForward', 'drift'].forEach(function (k) { if (k in inp) target[k] = !!inp[k]; });
        if ('itemSeq' in inp) target.itemSeq = Math.max(0, num(+inp.itemSeq, 0) | 0);
        if ('rev' in inp) target.revExt = clamp01(num(+inp.rev, 0));   // raw pedal for the rocket-start gauge (wrappers may hold the grid input at 0)
      },
      applyBoost: function (id, kind, secs, top, accel) { boost(kart(id), kind || 'pad', num(secs, 1), top, accel); },
      addNitro: function (id, amount, source) { var K = kart(id); return K ? N.gain(K.nitro, source || 'canister', amount) : 0; },
      hitCar: function (id, kind, byId) { return hit(kart(id), kind || 'oil', byId); },
      giveItem: function (id, itemId, uses) { var K = kart(id); if (K) { K.roulette = null; K.item = { id: itemId, uses: uses || (I.get(itemId) || {}).uses || 1 }; } },
      useItem: function (id, aimBack) { var K = kart(id); return K ? useItem(K, aimBack) : false; },
      addEntity: function (sp) { return addEntity(sp, false); },
      entities: function () { return W.ents; },
      kart: kart, karts: function () { return W.list; },
      state: state, decorate: decorate, takeEvents: takeEvents,
      stats: function (id) { var K = kart(id == null ? 'player' : id); return K ? Object.assign({ coins: K.coins, nitro: K.nitro.level }, K.st) : null; },
      serialize: serialize, load: load, reset: function () { eng.lastT = -1; reset(); },
      attachEngine: attachEngine, findEngineDebug: findEngineDebug,
      track: function () { return track; },
      /** setTrack(track, layoutSpecs?) — e.g. a stunt track: { length, pose(s, lat), halfWidth? } + its built features */
      /** multiplayer: o { role 'host'|'follower'|null, humans [ids] (remote players: input via setInput, no AI),
          externalLaunch (humans' rocket starts come from launchKart), onEvent(e) (every new event, host relay) } */
      setNet: function (o) {
        o = o || {};
        if ('role' in o) NET.role = o.role || null;
        if (Array.isArray(o.humans)) { NET.humans = {}; o.humans.forEach(function (id) { NET.humans[String(id)] = true; }); W.list.forEach(function (K) { K.human = !K.isPlayer && !!NET.humans[K.id]; }); }
        if ('externalLaunch' in o) NET.extLaunch = !!o.externalLaunch;
        if ('onEvent' in o) NET.onEvent = typeof o.onEvent === 'function' ? o.onEvent : null;
        return { role: NET.role, humans: Object.keys(NET.humans), externalLaunch: NET.extLaunch };
      },
      /** host: a remote player's own start grade ('perfect'|'good'|'none'|'over'), applied once */
      netExtraStep: netExtraStep,
      launchKart: function (id, grade) { var K = kart(id); if (!K || !K.launchPending || !W.started) return false; launch(K, String(grade || 'none')); return true; },
      applyHit: function (id, kind) { applyHit(kart(id), kind || 'oil'); },
      netPack: netPack, netApply: netApply, pushEvents: pushEvents,
      setTrack: function (t, specs) { track = t || null; if (Array.isArray(specs)) O.layout = specs; W.L = num(track && track.length, 0); buildLayout(); },
      _world: function () { return W; }
    };
    reset();
    return api;
  }

  CB.arcade.gameplay = {
    create: create, autoLayout: autoLayout, makeRng: makeRng,
    SPEED_CLASSES: SPEED_CLASSES, DIFFICULTY: DIFFICULTY, FREQ_ROWS: FREQ_ROWS, normOpts: normOpts,
    NITRO_TOP: NITRO_TOP, NITRO_ACCEL: NITRO_ACCEL
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.arcade.gameplay;

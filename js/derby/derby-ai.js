/* ==========================================================================
   Redline — js/derby/derby-ai.js
   CB.derby.ai : aggressive Demolition Derby AI (docs/DERBY-SPEC.md §8).

     create(car, {difficulty, rng, skill 0..1, aggro}) -> brain
     brain.think(world, car, dt) -> input {throttle, brake, steer (+1 left), handbrake, action1, action2}
     brain.target (id), brain.mode, brain.serialize(), brain.restore(o)

   A small mode machine, re-evaluated at the driver's reaction rate, steering every step:
     hunt        drive to an attack point (target's flank -> T-bones; intercept lead), dodge walls / hazards
     charge      committed straight run at the target (full throttle, nitro), ends on contact or when it slips past
     backoff     after a hit: reverse a short way with the nose kept on the target -> room for the next charge
     reposition  target close but behind / beside: reverse while swinging the nose round, then charge
     reverse     engine zone (front) wrecked: back into the target with the rear (derby veteran trick)
     recover     stuck (pinned on a wall / car / obstacle): drive the other way with opposite lock
     (navigation) target on another level (rooftop deck): go to the deck ramp entry, then up
   Overlays: edge / pit / crusher / brazier avoidance (always), flank protection, accessory use.
   Deterministic (seeded rng, state is plain JSON).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.derby = CB.derby || {};

(function () {
  'use strict';
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function wrap(a) { if (!(a > -Math.PI && a <= Math.PI)) { if (!isFinite(a)) return 0; a = a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI)); } return a; }
  var LEVEL = {
    rookie: { react: 0.42, noise: 0.2, aggro: 0.78, player: 0.3, lead: 0.4, charge: 0.85, backoff: 0.6 },
    amateur: { react: 0.24, noise: 0.09, aggro: 0.97, player: 0.4, lead: 0.85, charge: 1, backoff: 0.8 },
    pro: { react: 0.18, noise: 0.06, aggro: 1.04, player: 0.42, lead: 0.85, charge: 1, backoff: 1 },
    alien: { react: 0.12, noise: 0.035, aggro: 1.08, player: 0.4, lead: 1.0, charge: 1, backoff: 1.1 }
  };

  function create(car, opts) {
    opts = opts || {};
    var L = LEVEL[opts.difficulty] || LEVEL.pro;
    var rng = opts.rng || function () { return 0.5; };
    var B = {
      target: null, mode: 'hunt', modeT: 0, thinkT: 0, retargetT: 0, stuckT: 0, recoverDir: -1, recoverSteer: 1, recoverN: 0,
      aimNoise: 0, avoid: 0, avoidSide: 0, edge: null, danger: null, threat: null, press: [0, 0], cool: [0, 0], want: [false, false],
      lastHits: 0, lastHitT: -9, runOutT: 0, escape: false, stuckX: null, stuckY: 0, pickT: 0, pickId: null, pickBan: {}, engageT: 0, aliveN: 8,
      out: { throttle: 0, brake: 0, steer: 0, handbrake: false, action1: false, action2: false }
    };
    var D = function () { return CB.derby.damage; };
    var Ph = function () { return CB.derby.physics; };

    function alive(c) { return c && !c.out; }
    function local(c, x, y) { var co = Math.cos(c.heading), s = Math.sin(c.heading), dx = x - c.x, dy = y - c.y; return { lx: dx * co + dy * s, ly: -dx * s + dy * co }; }
    function setMode(m, t) { if (m !== B.mode) { B.stuckX = null; B.stuckT = 0; } B.mode = m; B.modeT = m === 'backoff' ? Math.max(t || 0, 3.2) : t || 0; }   // back-offs end on the run-up distance
    function level(c) { return c.z > 1.6 ? 1 : 0; }

    function pickTarget(world, me) {
      var best = null, bs = -1e9, mz = level(me);
      world.cars.forEach(function (o) {
        if (o === me || !alive(o)) return;
        if (me.team != null && o.team === me.team) return;
        var d = Math.hypot(o.x - me.x, o.y - me.y);
        var s = -d;
        if (level(o) !== mz) s -= 25;                                          // other deck: long way round
        s += (1 - o.dmg.health) * 24;                                          // finish off the weak
        if (me.lastHitBy === o.id && world.t - me.lastHitT < 5) s += 20;      // revenge
        if (o.isPlayer) s += 42 * L.player * num(opts.aggro, 1);             // the crowd wants the player hit
        if (o.isPlayer && !world.cars.some(function (h) { return h !== o && !h.out && Math.abs(h.x - o.x) < 25 && Math.abs(h.y - o.y) < 25; })) s += 34;   // nobody is on the player: go
        if (o.id === B.target) s += 14;                                        // hysteresis
        var q = local(o, me.x, me.y);
        if (Math.abs(q.ly) > Math.abs(q.lx)) s += 9;                           // we are at its side: T-bone chance
        if (o.flipped || o.dmg.engine.stalled) s += 8;
        if (o.stats && o.stats.dealt > 0.6) s += 6;                            // the leader
        if (o.idle) s += 34;                                                   // campers get hunted
        if (o.wedgeT > 0.5 || o.speed < 2) s += 6;                             // sitting ducks
        // spread out a bit (no 7-car conga line), but 2 hunters on one car is fine — that is the party
        var hunters = 0; world.cars.forEach(function (h) { if (h !== me && !h.out && h.aiTarget === o.id) hunters++; });
        if (hunters >= 2) s -= 10 * (hunters - 1);
        s += ((me.idx * 7 + (o.idx || 0) * 13) % 11) * 0.7;                   // deterministic spread
        if (s > bs) { bs = s; best = o; }
      });
      return best;
    }

    /* ---------------------------------------------------------------- sensing (reaction rate) */
    function sense(world, me, tgt, speed, fwdSpeed) {
      var P = Ph(), arena = world.arena;
      var back = fwdSpeed < -0.5;
      var h = me.heading + (back ? Math.PI : 0);
      var look = Math.max(6, Math.abs(speed) * 0.85 + 5);
      var dist = Math.hypot(tgt.x - me.x, tgt.y - me.y);
      var r0 = P.raycast(world, me.x, me.y, Math.cos(h), Math.sin(h), look, me.id, me.z);
      B.avoid = 0; B.avoidSide = 0;
      if (r0.kind && !(r0.kind === 'car' && r0.id === tgt.id)) {
        var lethal = r0.kind === 'edge' || r0.kind === 'pit' || r0.kind === 'crusher';
        // a wall with the target pinned in front of it is the plan, not a problem
        var pinning = r0.kind !== 'car' && !lethal && dist < r0.dist + 3 && Math.abs(wrap(Math.atan2(tgt.y - me.y, tgt.x - me.x) - h)) < 0.4;
        if (!pinning && (r0.kind !== 'car' || speed > 6)) {
          var rl = P.raycast(world, me.x, me.y, Math.cos(h + 0.75), Math.sin(h + 0.75), look, me.id, me.z).dist;
          var rr = P.raycast(world, me.x, me.y, Math.cos(h - 0.75), Math.sin(h - 0.75), look, me.id, me.z).dist;
          B.avoidSide = (rl >= rr ? 1 : -1) * (back ? -1 : 1);
          B.avoid = clamp(1.15 - r0.dist / look, 0, 1) * (lethal ? 2.5 : r0.kind === 'car' ? 0.5 : 1);
        }
      }
      var rb = P.raycast(world, me.x, me.y, -Math.cos(me.heading), -Math.sin(me.heading), 4.5, me.id, me.z);
      B.backBlocked = !!rb.kind && rb.dist < 3.6;
      // open edges: never drive off the roof
      var e = P.edgeInfo(arena, me.x, me.y);
      B.edge = e.open && e.dist < 14 ? { nx: e.nx, ny: e.ny, k: clamp(1 - e.dist / 14, 0, 1) } : null;
      if (!B.edge && r0.kind === 'edge') { var e2 = P.edgeInfo(arena, me.x + Math.cos(h) * r0.dist * 0.9, me.y + Math.sin(h) * r0.dist * 0.9); B.edge = { nx: e2.nx, ny: e2.ny, k: clamp(1 - r0.dist / look, 0.3, 1) }; }
      // hazards to steer round: braziers, pits, a crusher about to close
      B.danger = null;
      var hz = arena.hazards || [], ca = Math.cos(h), sa = Math.sin(h);
      for (var i = 0; i < hz.length; i++) {
        var z = hz[i], rad;
        if (z.type === 'fire' || z.type === 'pit') rad = z.r + 2.2;
        else if (z.type === 'crusher') { var per = z.period || 9, ph = ((world.t % per) + per) % per; if (ph < per - (z.closed || 2) - 2.6) continue; rad = z.r + 1.5; }
        else continue;
        var dx = z.x - me.x, dy = z.y - me.y, along = dx * ca + dy * sa, lat = -dx * sa + dy * ca;
        var inside = Math.hypot(dx, dy) < rad;
        if ((along > -1 && along < look + rad && Math.abs(lat) < rad) || inside) {
          if (!B.danger || along < B.danger.along) B.danger = { along: along, side: lat > 0 ? -1 : 1, inside: inside, back: back };
        }
      }
      // threats: a fast car heading at us
      B.threat = null;
      world.cars.forEach(function (o) {
        if (o === me || o.out) return;
        var rx = me.x - o.x, ry = me.y - o.y, rd = Math.hypot(rx, ry);
        if (rd > 16) return;
        var closing = (o.vx * rx + o.vy * ry) / (rd || 1);
        if (closing > 9 && (!B.threat || rd < B.threat.d)) B.threat = { id: o.id, d: rd, closing: closing };
      });
    }

    /** detour round a big obstacle (island, container, statue, a raised deck seen from below) blocking the line to (px, py) */
    function segHitsBox(ax, ay, bx, by, b, infl) {
      // Liang-Barsky in the box frame
      var c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0);
      function loc(x, y) { var dx = x - b.x, dy = y - b.y; return [dx * c + dy * s, -dx * s + dy * c]; }
      var p0 = loc(ax, ay), p1 = loc(bx, by), d = [p1[0] - p0[0], p1[1] - p0[1]], t0 = 0, t1 = 1;
      var lim = [b.hw + infl, b.hh + infl];
      for (var k = 0; k < 2; k++) {
        if (Math.abs(d[k]) < 1e-9) { if (Math.abs(p0[k]) > lim[k]) return -1; continue; }
        var ta = (-lim[k] - p0[k]) / d[k], tb = (lim[k] - p0[k]) / d[k];
        if (ta > tb) { var tt = ta; ta = tb; tb = tt; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) return -1;
      }
      return t0;
    }
    function blockers(world, me) {
      var A = world.arena, list = [];
      A.obstacles.forEach(function (o) { if (o.br >= 1.4) list.push(o); });
      if (me.z < 1.6) {
        (A.floors || []).forEach(function (f) { list.push({ id: f.id, type: 'box', x: f.x, y: f.y, hw: f.hw, hh: f.hh, rot: f.rot || 0, br: Math.hypot(f.hw, f.hh), deck: true }); });
        (A.ramps || []).forEach(function (r) { if (r.kind === 'deck') list.push({ id: r.id, type: 'box', x: r.x + Math.cos(r.rot || 0) * r.hw * 0.25, y: r.y + Math.sin(r.rot || 0) * r.hw * 0.25, hw: r.hw * 0.75, hh: r.hh, rot: r.rot || 0, br: Math.hypot(r.hw, r.hh), deck: true }); });
      }
      return list;
    }
    function detour(world, me, px, py, skipId) {
      var ex = px - me.x, ey = py - me.y, L2 = ex * ex + ey * ey;
      if (L2 < 4) return null;
      var infl = me.spec.width * 0.5 + 0.9, best = null, bt = 2;
      blockers(world, me).forEach(function (o) {
        if (o.id === skipId) return;
        var t;
        if (o.type === 'circle') {
          t = ((o.x - me.x) * ex + (o.y - me.y) * ey) / L2;
          if (t <= 0 || t >= 1) return;
          if (Math.hypot(o.x - (me.x + ex * t), o.y - (me.y + ey * t)) >= o.r + infl) return;
        } else {
          t = segHitsBox(me.x, me.y, px, py, o, infl);
          if (t < 0 || t >= 1) return;
          if (t === 0) t = 0.001;
        }
        if (t < bt) { bt = t; best = o; }
      });
      if (!best) return null;
      var o2 = best, r = me.spec.width + 2.6;
      if (o2.type === 'circle') {
        var L = Math.sqrt(L2), nx = -ey / L, ny = ex / L, rr = o2.r + r;
        var mx = me.x + ex * bt, my = me.y + ey * bt;
        var side = ((mx - o2.x) * nx + (my - o2.y) * ny) >= 0 ? 1 : -1;
        return { x: o2.x + nx * side * rr, y: o2.y + ny * side * rr, id: o2.id };
      }
      // box: the inflated corner that gives the shortest way round (and is itself reachable)
      var c = Math.cos(o2.rot || 0), s = Math.sin(o2.rot || 0), bestC = null, bl = 1e9;
      [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(function (q) {
        var lx = q[0] * (o2.hw + r), ly = q[1] * (o2.hh + r);
        var cx = o2.x + lx * c - ly * s, cy = o2.y + lx * s + ly * c;
        if (segHitsBox(me.x, me.y, cx, cy, o2, infl * 0.6) >= 0 && Math.hypot(cx - me.x, cy - me.y) > 3) return;
        var len = Math.hypot(cx - me.x, cy - me.y) + Math.hypot(px - cx, py - cy);
        if (A_bounds(world, cx, cy) && len < bl) { bl = len; bestC = { x: cx, y: cy, id: o2.id }; }
      });
      return bestC;
    }
    function A_bounds(world, x, y) { var AR = CB.derby.arenas; return AR.sdBoundary(world.arena, x, y).d > 2.5; }

    /** waypoint toward a target on another level (rooftop deck ramps) */
    function navPoint(world, me, tgt) {
      var mz = level(me), tz = level(tgt);
      if (mz === tz || mz === 1) return null;   // up there: just drive at them (the deck edge is a drop, not an elimination)
      var best = null, bd = 1e9;
      (world.arena.ramps || []).forEach(function (r) {
        if (r.kind !== 'deck') return;
        var c = Math.cos(r.rot || 0), s = Math.sin(r.rot || 0);
        var ex = r.x - c * (r.hw + 5), ey = r.y - s * (r.hw + 5);
        var d = Math.hypot(ex - me.x, ey - me.y) + Math.hypot(tgt.x - (r.x + c * r.hw), tgt.y - (r.y + s * r.hw));
        if (d < bd) { bd = d; best = { r: r, ex: ex, ey: ey, c: c, s: s }; }
      });
      if (!best) return null;
      var q = local({ x: best.r.x, y: best.r.y, heading: best.r.rot || 0 }, me.x, me.y);
      if (Math.abs(q.ly) < best.r.hh * 0.8 && q.lx > -best.r.hw - 6) return { x: best.r.x + best.c * (best.r.hw + 6), y: best.r.y + best.s * (best.r.hw + 6) };
      return { x: best.ex, y: best.ey };
    }

    /* ---------------------------------------------------------------- think */
    function think(world, me, dt) {
      var out = B.out;
      B.thinkT -= dt; B.retargetT -= dt; B.modeT -= dt;
      if (B.cool[0] > 0) B.cool[0] -= dt; if (B.cool[1] > 0) B.cool[1] -= dt;
      if (me.out) { out.throttle = 0; out.brake = 1; out.steer = 0; out.handbrake = false; out.action1 = out.action2 = false; return out; }
      var tgt = B.target != null ? world.byId(B.target) : null;
      if (!alive(tgt) || B.retargetT <= 0) {
        var nt = pickTarget(world, me);
        if (nt && (!tgt || nt.id !== tgt.id) && B.mode === 'charge') setMode('hunt');
        tgt = nt; B.target = tgt ? tgt.id : null; B.retargetT = 1.4 + rng() * 1.4;
        me.aiTarget = B.target;
      }
      if (!tgt) { out.throttle = 0.3; out.brake = 0; out.steer = 0; out.action1 = out.action2 = false; return out; }
      var ch = Math.cos(me.heading), sh = Math.sin(me.heading);
      var speed = Math.hypot(me.vx, me.vy), fwd = me.vx * ch + me.vy * sh;
      var dx = tgt.x - me.x, dy = tgt.y - me.y, dist = Math.hypot(dx, dy);
      var reach = (me.spec.length + tgt.spec.length) / 2 + num(me.spec.reachF, 0);
      var hitNow = me.stats.hits > B.lastHits;
      B.lastHits = me.stats.hits;
      if (hitNow) { B.lastHitT = world.t; B.retargetT = Math.min(B.retargetT, 0.8 + rng() * 0.8); }

      if (B.thinkT <= 0) {
        B.thinkT = L.react * (0.75 + rng() * 0.5);
        B.aimNoise = (rng() - 0.5) * 2 * L.noise;
        sense(world, me, tgt, speed, fwd);
        decideAccessories(world, me, tgt, dist);
        // engine protection (front-engined, wrecked nose, healthy tail)
        var Z = me.dmg.zones;
        var revRam = D().engineZone(me) === 'front' && Z.front > 0.6 && Z.rear < 0.55 && me.dmg.health > 0.1;
        var clearLine = !detour(world, me, tgt.x, tgt.y) && !navPoint(world, me, tgt);
        revRam = revRam && clearLine && dist < 24;
        if (revRam && B.mode !== 'recover' && B.mode !== 'reverse') setMode('reverse', 0);
        if (!revRam && B.mode === 'reverse') setMode('hunt');
      }
      var err = wrap(Math.atan2(dy, dx) - me.heading);
      // ---- stuck detection: pushing for a while but not getting anywhere (displacement over a window, not speed:
      // a full-lock start from rest is slow but makes progress)
      var pushing = out.throttle > 0.3 || out.brake > 0.3;
      if (B.mode !== 'recover' && pushing && speed < 1.6 && !me.airborne && !me.flipped && world.t > 0.5) {
        if (B.stuckX == null) { B.stuckX = me.x; B.stuckY = me.y; B.stuckT = 0; }
        B.stuckT += dt;
        if (Math.hypot(me.x - B.stuckX, me.y - B.stuckY) > 0.8) { B.stuckX = me.x; B.stuckY = me.y; B.stuckT = 0; }
      } else { B.stuckX = null; B.stuckT = 0; }
      if (B.stuckT > 1.1 + L.react) {
        B.stuckT = 0; B.stuckX = null; B.recoverN++;
        var wasRev = me.gear < 0 || out.brake > out.throttle;
        B.recoverDir = wasRev ? 1 : -1;
        // swing the nose toward the target while getting out (reversing turns the other way)
        B.recoverSteer = B.recoverDir > 0 ? (err >= 0 ? 1 : -1) : (err >= 0 ? -1 : 1);
        if (B.recoverN % 3 === 0) B.recoverSteer = -B.recoverSteer;
        setMode('recover', 0.9 + rng() * 0.5);
      }

      var thr = 0, brk = 0, steer = 0, hb = false;
      // too close to build speed (grinding / nudging at walking pace): reverse out for a run-up, then charge
      if (dist < reach + 3 && speed < 5 && B.mode !== 'backoff' && B.mode !== 'recover' && B.mode !== 'reverse' && B.mode !== 'charge' && !B.backBlocked) B.closeT = num(B.closeT, 0) + dt;
      else B.closeT = 0;
      if (B.closeT > 0.8) { B.closeT = 0; setMode('backoff', 2.2); }
      var nav = navPoint(world, me, tgt);
      // lead / intercept, with a flank offset when we are in front of it (aim beside the nose -> hit the side)
      var directed = me.directT != null && world.t - me.directT < 5 && B.target === me.aiTarget;
      var lead = clamp(dist / Math.max(9, speed + 7), 0, directed ? 2.4 : 1.5) * L.lead;
      // directed at the human: commit to a ram run instead of circling (humans move unpredictably)
      if (directed && tgt.isPlayer && B.mode === 'hunt' && dist > 6 && dist < 48) setMode('charge', 2.6);
      var px = tgt.x + tgt.vx * lead, py = tgt.y + tgt.vy * lead;
      var tq = local(tgt, me.x, me.y);
      if (tq.lx > 0 && Math.abs(tq.lx) > Math.abs(tq.ly) * 0.8 && dist > 9 && B.mode !== 'charge') {
        var sg = tq.ly >= 0 ? 1 : -1, tc = Math.cos(tgt.heading), ts = Math.sin(tgt.heading);
        var fo = 3.2 * clamp((dist - 8) / 14, 0, 1);   // curve in toward its flank, converge on the car itself up close
        px += -ts * sg * fo; py += tc * sg * fo;
      }
      if (nav) { px = nav.x; py = nav.y; }
      // pickups: repair when hurt, boost when nothing is close (they sit in the middle -> everybody crosses it)
      B.goPick = null;
      var pk = world.pickups, few = 0;
      world.cars.forEach(function (o) { if (!o.out) few++; });
      B.aliveN = few;
      if (pk && pk.length && B.mode !== 'charge' && !nav && (few > 3 || me.dmg.health < 0.35)) {
        var bestP = null, bpd = 1e9;
        pk.forEach(function (p) {
          if (!p.active) return;
          if (B.pickBan[p.id] > world.t) return;
          var useful = p.kind === 'repair' ? me.dmg.health < 0.5 : p.kind === 'boost' ? me.ram && me.ram.charge < 0.5 : p.kind === 'ammo' || p.kind === 'armor' || p.kind === 'bomb';
          if (!useful) return;
          var pd = Math.hypot(p.x - me.x, p.y - me.y);
          var lim = p.kind === 'repair' ? 45 : dist > 20 ? 22 : 9;
          if (pd < lim && pd < bpd && Math.abs((p.z || 0) - me.z) < 1.2) { bpd = pd; bestP = p; }
        });
        if (bestP) {
          // give up on a pickup we cannot reach in 4 s (somebody else is circling it too)
          if (B.pickId !== bestP.id) { B.pickId = bestP.id; B.pickT = 0; }
          B.pickT += dt;
          if (B.pickT > 4) { B.pickBan[bestP.id] = world.t + 8; B.pickId = null; }
          else { px = bestP.x; py = bestP.y; B.goPick = bestP.id; }
        }
      }
      // never-meeting duels (two cars chasing each other round a deck / island): the junior one waits and lets the
      // other come to it, nose on, then charges
      if (hitNow) B.engageT = 0; else B.engageT += dt;
      var mutual = !tgt.isPlayer && tgt.aiTarget === me.id;
      if (B.mode === 'hunt' && mutual && B.engageT > 6 && dist > 16 && dist < 90 && me.idx > tgt.idx && !B.goPick) setMode('ambush', 4 + rng() * 2);
      // sudden-death ring: stay inside
      if (world.safeAt && !world.safeAt(me.x, me.y, 3)) { px = me.x * 0.3; py = me.y * 0.3; B.goPick = 'ring'; }
      var dt0 = detour(world, me, px, py);
      if (dt0) { px = dt0.x; py = dt0.y; nav = nav || dt0; }
      var aimErr = wrap(Math.atan2(py - me.y, px - me.x) - me.heading + B.aimNoise);

      switch (B.mode) {
        case 'recover':
          thr = B.recoverDir > 0 ? 1 : 0; brk = B.recoverDir > 0 ? 0 : 1; steer = B.recoverSteer;
          if (B.modeT <= 0) setMode(dist < 12 && Math.abs(err) > 1.2 ? 'reposition' : 'hunt', 1.6);
          break;
        case 'reverse': {
          // back into the target with the rear; after a hit drive forward out for a run-up
          if (hitNow && B.runOutT <= 0) B.runOutT = 1.2 + rng() * 0.5;
          if (B.runOutT > 0) {
            B.runOutT -= dt;
            thr = 1; brk = 0; steer = clamp(-wrap(Math.atan2(me.y - tgt.y, me.x - tgt.x) - me.heading) * 1.2, -1, 1) * 0;
            if (dist > 16) B.runOutT = 0;
            break;
          }
          var wantR = wrap(Math.atan2(me.y - py, me.x - px) - me.heading);
          if (Math.abs(wantR) < 1.1) { brk = L.aggro; thr = 0; steer = clamp(-wantR * 2.6, -1, 1); }
          else { thr = 0.85; brk = 0; steer = clamp(wantR * 2.2, -1, 1); }
          break;
        }
        case 'backoff': {
          // reverse away for a run-up, nose kept on the target; stop early when the way back is blocked
          brk = 1; thr = 0; steer = clamp(-err * 2.2, -1, 1);
          var runup = (9 + 4 * L.backoff) * (num(me.surfGrip, 1) < 0.5 ? 1.35 : 1);
          if (B.backBlocked || B.modeT <= 0 || dist > runup) setMode(Math.abs(err) < 0.9 ? 'charge' : 'hunt', 3.5);
          break;
        }
        case 'reposition':
          brk = 1; thr = 0; steer = err >= 0 ? -1 : 1;
          if (Math.abs(err) < 0.55 || dist > 32 || B.modeT <= 0 || B.backBlocked) setMode(Math.abs(err) < 0.7 ? 'charge' : 'hunt', 3);
          break;
        case 'ambush':
          // face the target (nose on) and wait for it; charge when it is close or lined up
          steer = clamp(err * 2.4, -1, 1); thr = Math.abs(err) > 0.5 ? 0.45 : 0.12; brk = speed > 6 ? 0.6 : 0;
          if (dist < 18 && Math.abs(err) < 0.6) setMode('charge', 3);
          else if (B.modeT <= 0 || hitNow) { B.engageT = 0; setMode('hunt'); }
          break;
        case 'charge':
          steer = clamp(aimErr * (2.4 + speed * 0.04), -1, 1);
          thr = L.charge; brk = 0;
          var touching = me.touch && world.t - num(me.touch[tgt.id], -9) < 0.15;
          if (touching && speed < 4.5) B.grindT = num(B.grindT, 0) + dt; else B.grindT = 0;
          if (B.grindT > 0.9) { B.grindT = 0; setMode('backoff', 1.2 + rng() * 0.5); break; }
          if (hitNow || (dist < reach + 0.4 && speed < 4)) setMode(rng() < 0.65 ? 'backoff' : 'hunt', (1.1 + rng() * 0.6) * L.backoff);
          else if (Math.abs(err) > 1.9 && dist < 12) setMode('reposition', 1.8);
          else if (B.modeT <= 0) setMode('hunt');
          break;
        default: // hunt
          steer = clamp(aimErr * (2.2 + speed * 0.05), -1, 1);
          thr = L.aggro * (Math.abs(aimErr) < 0.6 ? 1 : 0.85);
          var slick = num(me.surfGrip, 1) < 0.5;
          if (Math.abs(aimErr) > (slick ? 0.9 : 1.5) && speed > (slick ? 7 : 11)) { thr = 0.25; brk = 0.35; hb = L.react < 0.25 && rng() < 0.08 && !slick; }
          // handbrake U-turn: a big direction change at medium speed swings the tail round (derby staple)
          if (!slick && Math.abs(aimErr) > 1.3 && fwd > 4 && fwd < 15 && L.react < 0.35) { hb = true; thr = 0.6; }
          if (!nav) {
            if (Math.abs(err) < 0.55 && dist > 4 && dist < 60 && !B.goPick) setMode('charge', Math.min(4.5, dist / 8 + 1.5));
            else if ((dist < 10 && Math.abs(err) > 1.4 && speed < 9) || (dist < 28 && Math.abs(err) > 2.1 && speed < 8 && !B.backBlocked)) setMode('reposition', 1.8);
            else if (hitNow) setMode('backoff', 1.8 * L.backoff);
          }
          break;
      }
      // ---- corner speed: the radius needed to reach the aim point vs what the tyres can do at this speed
      if ((B.mode === 'hunt' || B.mode === 'charge') && fwd > 3) {
        var aimD = Math.hypot(px - me.x, py - me.y), se = Math.abs(Math.sin(Math.min(Math.abs(aimErr), 1.5)));
        if (se > 0.12 && aimD < 45) {
          var rReq = Math.max(3, aimD / (2 * se));
          var vOk = Math.sqrt(0.85 * 9.81 * clamp(num(me.surfGrip, 1), 0.3, 1.2) * rReq) + 1.5;
          if (fwd > vOk) { thr = 0; brk = Math.max(brk, clamp((fwd - vOk) / 4, 0.3, 1)); }
        }
      }
      // ---- flank protection: a fast car heading for our crumpled side -> turn to take it on an end
      var th = B.threat ? world.byId(B.threat.id) : null;
      if (th && B.mode !== 'recover' && B.mode !== 'charge') {
        var tz = local(me, th.x, th.y), side = tz.ly > 0 ? 'left' : 'right';
        if (Math.abs(tz.ly) > Math.abs(tz.lx) && me.dmg.zones[side] > 0.4) {
          var fe = wrap(Math.atan2(th.y - me.y, th.x - me.x) - me.heading);
          steer = clamp(fe * 2.6, -1, 1); thr = 0.9; brk = 0;
        }
      }
      // ---- avoidance overlays
      var moving = fwd < -0.5 || brk > thr ? -1 : 1;
      if (B.avoid > 0 && B.mode !== 'recover' && !(B.mode === 'charge' && B.avoid < 1.2)) {
        var k = Math.min(1, B.avoid);
        steer = clamp(steer * (1 - k) + B.avoidSide * moving * Math.min(1, B.avoid * 1.5), -1, 1);
        if (B.avoid > 0.75 && speed > 13 && moving > 0) { thr = Math.min(thr, 0.35); brk = Math.max(brk, 0.4); }
      }
      if (B.danger) {
        steer = clamp(steer + B.danger.side * (B.danger.back ? -1 : 1) * 0.9, -1, 1);
        if (B.danger.inside) { if (moving > 0) { thr = 1; brk = 0; } else { thr = 0; brk = 1; } }
      }
      if (B.edge) {
        var inward = Math.atan2(B.edge.ny, B.edge.nx), ie = wrap(inward - me.heading);
        var travel = Math.atan2(me.vy, me.vx), te = speed > 1 ? Math.cos(wrap(inward - travel)) : 1;
        if ((te < 0.25 && B.edge.k > 0.12) || B.edge.k > 0.75) B.escape = true;
        if (B.edge.k < 0.55) B.escape = false;
        if (B.escape) {
          // get away from the drop: forward if the nose points inward, else straight back (reversing moves inward)
          if (Math.cos(ie) > 0) { steer = clamp(ie * 2.6, -1, 1); thr = 1; brk = 0; }
          else { steer = clamp(-ie * 0.6, -0.4, 0.4) * 0; thr = 0; brk = 1; }
        }
      } else B.escape = false;
      out.throttle = clamp(thr, 0, 1); out.brake = clamp(brk, 0, 1); out.steer = clamp(steer, -1, 1); out.handbrake = hb;
      // ram boost: on a lined-up run, or to get off a wall / out of the ring
      var R = me.ram, ang = Math.abs(aimErr);
      if (R) {
        if (!B.boosting && R.charge > 0.55 && thr > 0.8 && ang < 0.22 && ((B.mode === 'charge' && dist > 6 && dist < 34) || B.goPick === 'ring' || (directed && dist > 12))) B.boosting = true;
        if (B.boosting && (R.charge < 0.04 || ang > 0.5 || thr < 0.5 || dist < reach * 0.6 || (B.mode !== 'charge' && B.goPick !== 'ring' && !directed))) B.boosting = false;
        out.boost = !!B.boosting && !B.escape;
      }
      applyPress(out, dt);
      return out;
    }

    /** accessory decisions (run at the think rate) */
    function decideAccessories(world, me, tgt, dist) {
      if (!me.acc || !me.actives) return;
      me.actives.forEach(function (ai, k) {
        var st = me.acc[ai]; if (!st) return;
        var q = local(me, tgt.x, tgt.y), ang = Math.atan2(q.ly, q.lx);
        var want = false;
        switch (st.id) {
          case 'flamethrower':
            want = st.charge > 0.04 && world.cars.some(function (o) { if (o === me || o.out) return false; var l = local(me, o.x, o.y), d = Math.hypot(l.lx, l.ly); return d < 11.5 && l.lx > 0 && Math.abs(Math.atan2(l.ly, l.lx)) < 0.5; });
            break;
          case 'hammer':
            want = st.cooldown <= 0 && world.cars.some(function (o) { if (o === me || o.out) return false; var l = local(me, o.x, o.y); return Math.abs(l.ly) > 1.1 && Math.abs(l.ly) < 5.4 && Math.abs(l.lx) < 3.6; });
            break;
          case 'nitro': want = (B.mode === 'charge' || B.mode === 'hunt') && Math.abs(ang) < 0.2 && dist > 7 && dist < 42 && st.charge > 0.25; break;
          case 'magnet': want = dist > 7 && dist < 20 && Math.abs(ang) < 0.6 && st.cooldown <= 0; break;
          case 'shield': want = !!B.threat && B.threat.d < 8 && st.cooldown <= 0; break;
          case 'repair': want = me.dmg.health < 0.32 && st.ammo > 0; break;
          case 'oil': case 'caltrops':
            want = st.ammo > 0 && st.cooldown <= 0 && world.cars.some(function (o) { if (o === me || o.out) return false; var l = local(me, o.x, o.y); return l.lx < -2 && l.lx > -18 && Math.abs(l.ly) < 4.5; });
            break;
          default: break;
        }
        if (st.id === 'flamethrower' || st.id === 'nitro') B.want[k] = want;   // held
        else { B.want[k] = false; if (want && B.cool[k] <= 0) { B.press[k] = 0.1; B.cool[k] = 0.45; } }
      });
    }
    function applyPress(out, dt) {
      for (var k = 0; k < 2; k++) if (B.press[k] > 0) B.press[k] -= dt;
      out.action1 = !!B.want[0] || B.press[0] > 0;
      out.action2 = !!B.want[1] || B.press[1] > 0;
    }

    B.think = think;
    B.serialize = function () {
      var o = {}; for (var k in B) if (typeof B[k] !== 'function') o[k] = B[k];
      o = JSON.parse(JSON.stringify(o));
      if (rng.state && typeof rng.state.s === 'number') o._rng = rng.state.s;   // the session's seeded mulberry32
      return o;
    };
    B.restore = function (o) {
      if (!o) return;
      for (var k in o) if (k !== '_rng') B[k] = JSON.parse(JSON.stringify(o[k]));
      if (o._rng != null && rng.state) rng.state.s = o._rng >>> 0;
    };
    return B;
  }

  CB.derby.ai = { create: create, LEVEL: LEVEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.derby.ai;
})();

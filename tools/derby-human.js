#!/usr/bin/env node
/* Redline — tools/derby-human.js : the derby from a HUMAN's point of view (docs/DERBY-SPEC.md).
   A scripted "human" drives straight at the nearest car at full throttle (ram boost when lined up), keeps trying to
   drive after every crash (no clever reversing: only what a frustrated player does — hold gas, steer at the next car,
   tap reverse when it is obviously stuck nose-first in a wall). Every collision involving the player is logged:
   speed before / after, time to get back above 50 % of the pre-hit speed, contact duration, peak spin, wall pins,
   power after 1 / 2 / 3 crashes. Usage: node tools/derby-human.js [arena|all] [seeds=2] [difficulty=amateur] [maxSeconds=150]
   Exports runHuman(opts) -> stats for tests. */
'use strict';
var path = require('path'), root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/vehicle.js', 'js/derby/derby-arenas.js', 'js/derby/derby-physics.js', 'js/derby/derby-damage.js',
 'js/derby/derby-accessories.js', 'js/derby/derby-pickups.js', 'js/derby/derby-ai.js', 'js/derby/derby-session.js'].forEach(function (f) { try { require(path.join(root, f)); } catch (e) { if (!/pickups/.test(f)) throw e; } });
var CB = globalThis.CB, PH = CB.derby.physics;

function wrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

function runHuman(o) {
  o = Object.assign({ arena: 'mud-bowl', seed: 1, opponents: 7, difficulty: 'amateur', maxSeconds: 150, preset: 'muscle', accessories: ['ram', 'armour', 'nitro'] }, o || {});
  var S = CB.derby.session.create({ arenaId: o.arena, seed: o.seed, opponents: o.opponents, difficulty: o.difficulty, player: { presetId: o.preset, accessories: o.accessories } });
  var DT = S.DT || 1 / 120;
  // contact log through the solver
  var orig = PH.collideCars, touching = {}, stepNo = 0;
  var contacts = [];   // {other, t0, t1, vPre, ...}
  PH.collideCars = function (a, b, opts) {
    var ct = orig.apply(this, arguments);
    if (ct && (a.isPlayer || b.isPlayer)) { var other = a.isPlayer ? b : a; touching[other.id] = stepNo; }
    return ct;
  };
  var me = S._cars[0], hist = [], open = {}, crashes = [], t = 0, below5 = 0, fightT = 0, air = 0, wasAir = false, bigNear = 0, lastAction = 0, gapMax = 0, pinT = 0, pins = 0, pinMax = 0;
  var slowWhy = {}; function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  var revT = 0, inp = { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false, action1: false, action2: false };
  try {
    for (stepNo = 0; stepNo < o.maxSeconds / DT; stepNo++) {
      var snapPhase = S.world.phase;
      if (me.out || snapPhase === 'over') break;
      // human control
      var best = null, bd = 1e9;
      S._cars.forEach(function (c) { if (c === me || c.out) return; var d = Math.hypot(c.x - me.x, c.y - me.y); if (d < bd) { bd = d; best = c; } });
      var sp = Math.hypot(me.vx, me.vy);
      if (best) {
        var err = wrap(Math.atan2(best.y - me.y, best.x - me.x) - me.heading);
        if (revT > 0) { revT -= DT; inp = { throttle: 0, brake: 1, steer: -Math.sign(err), handbrake: false, boost: false }; }
        else {
          inp = { throttle: 1, brake: 0, steer: Math.max(-1, Math.min(1, err * 2.5)), handbrake: false, boost: Math.abs(err) < 0.3 && bd < 35 && me.ram && me.ram.charge > 0.6 };
          if (o.jturn !== false && Math.abs(err) > 2.0 && sp > 6) { inp.handbrake = true; inp.steer = err > 0 ? 1 : -1; }   // a player swings it round with the J-turn
          // a human notices being stuck nose-in after ~1.5 s and backs up for 0.8 s
          if (snapPhase === 'fight' && sp < 1 && fightT > 2) { pinT += DT; if (pinT > 1.5 && o.humanReverse !== false) { revT = 0.8; pinT = 0; } } else pinT = 0;
        }
      }
      S.step(inp);
      t = stepNo * DT;
      if (S.world.phase !== 'fight') continue;
      fightT += DT;
      if (sp < 5) {
        below5 += DT;
        var crowdN = S._cars.filter(function (c) { return c !== me && Math.hypot(c.x - me.x, c.y - me.y) < me.spec.length + 1.5; }).length;
        var why = me.flipped ? 'flipped' : me.airborne ? 'air' : S.world.t - num(me.lastHitT, -9) < 0.6 ? 'justHit' : crowdN ? 'touching' : PH.edgeInfo(S.arena, me.x, me.y).dist < me.spec.length * 0.6 ? 'wall' : revT > 0 ? 'reversing' : Math.abs(inp.steer) > 0.8 ? 'turning' : 'accel';
        slowWhy[why] = (slowWhy[why] || 0) + DT;
      }
      if (me.airborne && !wasAir) air++;
      wasAir = me.airborne;
      hist.push(sp); if (hist.length > 40) hist.shift();
      // contact episodes
      Object.keys(touching).forEach(function (id) {
        var on = touching[id] === stepNo;
        if (on && !open[id]) open[id] = { other: id, t0: fightT, vPre: Math.max.apply(null, hist.slice(0, Math.max(1, hist.length - 2))), spin: 0, recovered: null, vMin: sp, pow: null };
        if (!on && open[id] && open[id].t1 == null) open[id].t1 = fightT;
      });
      Object.keys(open).forEach(function (id) {
        var c = open[id];
        c.spin = Math.max(c.spin, Math.abs(me.w)); c.vMin = Math.min(c.vMin, sp);
        if (c.t1 != null && c.recovered == null && sp > c.vPre * 0.5) c.recovered = fightT - c.t0;
        if (c.t1 != null && (c.recovered != null || fightT - c.t0 > 6)) {
          if (c.recovered == null) c.recovered = 6;
          c.contact = c.t1 - c.t0;
          c.pow = CB.derby.damage.effects(me).powerMult;
          if (c.vPre > 6) crashes.push(c);
          delete open[id];
        }
      });
      // wall pins: slow next to a wall / obstacle for > 1 s
      var wallNear = PH.edgeInfo(S.arena, me.x, me.y).dist < me.spec.length * 0.7;
      if (sp < 2 && wallNear) { pinMax = Math.max(pinMax, (me._pinT = (me._pinT || 0) + DT)); if (me._pinT > 1 && !me._pinCounted) { pins++; me._pinCounted = true; } }
      else { me._pinT = 0; me._pinCounted = false; }
      var sn = S.snapshot();
      sn.events.forEach(function (e) {
        var mine = e.carId === 'player' || e.otherId === 'player';
        if ((e.type === 'impact' || e.type === 'hammer' || e.type === 'launch') && mine) { if (e.big) bigNear++; gapMax = Math.max(gapMax, fightT - lastAction); lastAction = fightT; }
      });
    }
  } finally { PH.collideCars = orig; }
  gapMax = Math.max(gapMax, fightT - lastAction);
  var normal = crashes.filter(function (c) { return c.vPre > 6; });
  function med(a) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.floor(b.length / 2)]; }
  return {
    arena: o.arena, seed: o.seed, fight_s: fightT, alive: !me.out, crashes: normal.length,
    recoverMed: med(normal.map(function (c) { return c.recovered; })), recoverP90: normal.length ? normal.map(function (c) { return c.recovered; }).sort(function (a, b) { return a - b; })[Math.floor(normal.length * 0.9)] : 0,
    contactMed: med(normal.map(function (c) { return c.contact; })), contactMax: Math.max.apply(null, normal.map(function (c) { return c.contact; }).concat([0])),
    spinMed: med(normal.map(function (c) { return c.spin; })), slowPct: fightT ? below5 / fightT * 100 : 0, bigPerMin: fightT ? bigNear / (fightT / 60) : 0,
    airPerMin: fightT ? air / (fightT / 60) : 0, gapMax: gapMax, pins: pins, pinMax: pinMax,
    pow: [1, 2, 3].map(function (k) { return normal[k - 1] ? +normal[k - 1].pow.toFixed(2) : null; }), health: me.dmg.health, elim: me.elimReason, slowWhy: Object.keys(slowWhy).map(function (k) { return k + ' ' + (slowWhy[k] / Math.max(1e-9, fightT) * 100).toFixed(0) + '%'; }).join(', ')
  };
}

if (require.main === module) {
  var arg = process.argv.slice(2), ar = arg[0] || 'all', seeds = +(arg[1] || 2), diff = arg[2] || 'amateur', maxS = +(arg[3] || 150);
  var list = ar === 'all' ? CB.derby.arenas.ids() : [ar];
  console.log('arena       seed  fight  crash  recMed recP90  conMed conMax  spin  slow%  big/m  air/m  gap   pins pinMax  pow1/2/3        alive');
  list.forEach(function (a) {
    for (var s = 1; s <= seeds; s++) {
      var r = runHuman({ arena: a, seed: s, difficulty: diff, maxSeconds: maxS });
      console.log(a.padEnd(11), String(s).padStart(4), r.fight_s.toFixed(0).padStart(6), String(r.crashes).padStart(6), r.recoverMed.toFixed(2).padStart(7), r.recoverP90.toFixed(2).padStart(6),
        r.contactMed.toFixed(2).padStart(7), r.contactMax.toFixed(2).padStart(6), r.spinMed.toFixed(1).padStart(5), r.slowPct.toFixed(1).padStart(6), r.bigPerMin.toFixed(1).padStart(6), r.airPerMin.toFixed(1).padStart(6),
        r.gapMax.toFixed(1).padStart(5), String(r.pins).padStart(6), r.pinMax.toFixed(1).padStart(6), ('  ' + r.pow.join('/')).padEnd(16), r.alive ? 'yes' : 'out ' + r.elim + ' ' + r.health.toFixed(2), '|', r.slowWhy);
    }
  });
}
module.exports = { runHuman: runHuman };

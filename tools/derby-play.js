#!/usr/bin/env node
/* Redline — tools/derby-play.js : Demolition Derby "fun metrics" with player-like bots (docs/DERBY-SPEC.md §12).
   The player car is driven by a simple scripted bot (not the AI) and the session is measured like a real match:
     chaser  drives at the nearest car, full throttle + ram boost, reverses out when stuck
     holder  holds the gas and steers gently in circles
     idle    does nothing
   Usage: node tools/derby-play.js [arena|all] [seeds=3] [bots=chaser,holder,idle] [opponents=7] [difficulty=pro] [maxSeconds=240]
   Metrics per match: length, car-car impacts / min, big hits (vn > 11) / min, time to first hit, longest gap without a
   significant hit (a crunch: car-car impact with vn > 7 m/s, or > 0.03 health lost in one 0.1 s sample) anywhere / near
   the player (within 15 m, incl. the player),
   longest time with no other car within 15 m of the player, stuck %, self-falls, player result. */
'use strict';
var path = require('path');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/vehicle.js', 'js/derby/derby-arenas.js', 'js/derby/derby-pickups.js', 'js/derby/derby-physics.js',
 'js/derby/derby-damage.js', 'js/derby/derby-accessories.js', 'js/derby/derby-ai.js', 'js/derby/derby-session.js'].forEach(function (f) { try { require(path.join(root, f)); } catch (e) { if (f.indexOf('pickups') < 0) throw e; } });
var CB = globalThis.CB;

function wrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
function makeBot(kind) {
  var st = { stuckT: 0, revT: 0, t: 0 };
  return function (S, me, dt) {
    st.t += dt;
    if (kind === 'idle') return { throttle: 0, brake: 0, steer: 0, handbrake: false, action1: false, action2: false, boost: false };
    if (kind === 'holder') return { throttle: 1, brake: 0, steer: 0.35 * Math.sin(st.t * 0.25) + 0.25, handbrake: false, action1: false, action2: false, boost: false };
    // chaser
    var best = null, bd = 1e9;
    S._cars.forEach(function (o) { if (o === me || o.out) return; var d = Math.hypot(o.x - me.x, o.y - me.y); if (d < bd) { bd = d; best = o; } });
    if (!best) return { throttle: 0, brake: 0, steer: 0 };
    if (me.speed < 1 && st.t > 4) st.stuckT += dt; else st.stuckT = 0;
    if (st.stuckT > 1) { st.revT = 1; st.stuckT = 0; }
    var err = wrap(Math.atan2(best.y - me.y, best.x - me.x) - me.heading);
    if (st.revT > 0) { st.revT -= dt; return { throttle: 0, brake: 1, steer: -Math.sign(err), handbrake: false, action1: false, action2: false, boost: false }; }
    return { throttle: 1, brake: 0, steer: Math.max(-1, Math.min(1, err * 2.5)), handbrake: false, action1: bd < 10, action2: bd < 6, boost: Math.abs(err) < 0.3 && bd < 30, reset: st.stuckT > 0.6 };
  };
}

function run(o) {
  var S = CB.derby.session.create({ arenaId: o.arena, seed: o.seed, opponents: o.opponents, difficulty: o.difficulty,
    player: { presetId: o.presetId || 'muscle', accessories: o.accessories || ['ram', 'nitro'] } });
  var bot = makeBot(o.bot), cars = S._cars, me = cars[0];
  var dt = 1 / 120, maxSteps = 120 * (o.maxSeconds + 3);
  var m = { impacts: 0, big: 0, firstHit: null, lastSig: 0, lastSigNear: 0, gapAny: 0, gapNear: 0, lonely: 0, lonelyMax: 0, stuck: 0, alive: 0, selfFalls: 0, len: 0, nan: false, scores: 0, pickups: 0 };
  var prevH = {}, hist = {};
  var t0 = process.hrtime.bigint();
  for (var i = 0; i < maxSteps; i++) {
    var inp = bot(S, me, dt);
    S.step(me.out ? null : inp);
    if (i % 12 !== 0) continue;
    var sn = S.snapshot(), W = S.world;
    if (W.phase !== 'fight' && W.phase !== 'over') { cars.forEach(function (c) { prevH[c.id] = c.dmg.health; }); continue; }
    var ft = W.t - W.fightT0;
    sn.events.forEach(function (e) {
      if (e.type === 'impact' && !e.ball && !e.crusher) { m.impacts++; if (e.vn > 11) m.big++; if (m.firstHit == null && e.vn > 2.2) m.firstHit = ft; }
      if (e.type === 'eliminated' && e.reason === 'fell' && !e.otherId) m.selfFalls++;
      if (e.type === 'score') m.scores++;
      if (e.type === 'pickup') m.pickups++;
    });
    var sig = false, sigNear = false;
    sn.events.forEach(function (e) {
      if (e.type !== 'impact' || e.ball || e.crusher || !(e.vn > 7)) return;
      sig = true;
      if (e.carId === me.id || e.otherId === me.id || Math.hypot(e.x - me.x, e.y - me.y) < 15) sigNear = true;
    });
    cars.forEach(function (c) {
      if (!isFinite(c.x + c.y + c.vx + c.vy + c.dmg.health)) m.nan = true;
      var dh = (prevH[c.id] == null ? c.dmg.health : prevH[c.id]) - c.dmg.health;
      prevH[c.id] = c.dmg.health;
      if (dh > 0.03) { sig = true; if (c === me || Math.hypot(c.x - me.x, c.y - me.y) < 15) sigNear = true; }
      if (c.out) return;
      m.alive += 0.1;
      var h = hist[c.id] || (hist[c.id] = []); h.push(c.speed); if (h.length > 21) h.shift();
      if (h.length === 21 && !c.flipped && !c.airborne && Math.max.apply(null, h) < 1.5) m.stuck += 0.1;
    });
    if (W.phase === 'fight') {
      if (sig) m.lastSig = ft; else m.gapAny = Math.max(m.gapAny, ft - m.lastSig);
      if (!me.out) {
        if (sigNear) m.lastSigNear = ft; else m.gapNear = Math.max(m.gapNear, ft - m.lastSigNear);
        var near = cars.some(function (c) { return c !== me && !c.out && Math.hypot(c.x - me.x, c.y - me.y) < 15; });
        if (near) m.lonely = 0; else { m.lonely += 0.1; m.lonelyMax = Math.max(m.lonelyMax, m.lonely); }
      }
      m.len = ft;
    }
    if (sn.phase === 'over') break;
  }
  m.ms = Number(process.hrtime.bigint() - t0) / 1e6;
  var r = S.results();
  m.won = r.won; m.place = r.player ? r.player.position : null; m.ended = S.world.phase === 'over';
  m.playerOutT = me.elimT != null ? me.elimT - S.world.fightT0 : null;
  return m;
}

function main() {
  var argv = process.argv.slice(2);
  var arenas = !argv[0] || argv[0] === 'all' ? CB.derby.arenas.ids() : argv[0].split(',');
  var seeds = +argv[1] || 3, bots = (argv[2] || 'chaser,holder,idle').split(','), opp = +argv[3] || 7, diff = argv[4] || 'pro', maxS = +argv[5] || 240;
  var rows = [];
  function f(v, d) { return v == null ? '  -  ' : (+v).toFixed(d == null ? 1 : d); }
  console.log('arena        bot     len   imp/m  big/m  1stHit gapAny gapNear lonely stuck% selfF place pAlive');
  arenas.forEach(function (a) {
    bots.forEach(function (b) {
      var acc = { pOut: 0, len: 0, ipm: 0, bpm: 0, fh: 0, ga: 0, gn: 0, lo: 0, st: 0, sf: 0, pl: 0, n: 0, nan: false, ms: 0, ended: 0, gnMax: 0 };
      for (var s = 1; s <= seeds; s++) {
        var m = run({ arena: a, seed: s * 7 + 1, bot: b, opponents: opp, difficulty: diff, maxSeconds: maxS });
        var mins = Math.max(0.1, m.len / 60);
        acc.len += m.len; acc.ipm += m.impacts / mins; acc.bpm += m.big / mins; acc.fh += m.firstHit == null ? 99 : m.firstHit;
        acc.ga += m.gapAny; acc.gn += m.gapNear; acc.gnMax = Math.max(acc.gnMax, m.gapNear); acc.lo += m.lonelyMax; acc.st += m.alive ? m.stuck / m.alive * 100 : 0; acc.sf += m.selfFalls; acc.pl += m.place || 0;
        acc.pOut += m.playerOutT == null ? m.len : m.playerOutT; acc.n++; acc.nan = acc.nan || m.nan; acc.ms += m.ms; acc.ended += m.ended ? 1 : 0;
      }
      var n = acc.n;
      var row = { arena: a, bot: b, len: acc.len / n, ipm: acc.ipm / n, bpm: acc.bpm / n, firstHit: acc.fh / n, gapAny: acc.ga / n, gapNear: acc.gn / n, gapNearMax: acc.gnMax, lonely: acc.lo / n, stuck: acc.st / n, selfFalls: acc.sf, place: acc.pl / n, playerAlive_s: acc.pOut / n, nan: acc.nan, ended: acc.ended + '/' + n };
      rows.push(row);
      console.log(a.padEnd(12), b.padEnd(7), f(row.len).padStart(5), f(row.ipm).padStart(6), f(row.bpm).padStart(6), f(row.firstHit).padStart(6), f(row.gapAny).padStart(6),
        (f(row.gapNear) + '/' + f(row.gapNearMax, 0)).padStart(8), f(row.lonely).padStart(6), f(row.stuck).padStart(6), String(row.selfFalls).padStart(5), f(row.place).padStart(5), f(row.playerAlive_s).padStart(6), row.nan ? 'NaN!' : '', row.ended, (acc.ms / n).toFixed(0) + 'ms');
    });
  });
  return rows;
}
if (require.main === module) main();
module.exports = { run: run, makeBot: makeBot };

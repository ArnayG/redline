#!/usr/bin/env node
/* Redline — tools/derby-sim.js : headless Demolition Derby match runner (docs/DERBY-SPEC.md).
   Usage: node tools/derby-sim.js [arena|all] [seeds=3] [opponents=7] [difficulty=pro] [maxSeconds=300]
   Prints per-match + per-arena stats: car-car impacts per car-minute, big hits / min, match length, stuck %,
   orbit %, self-falls vs pushed falls, ms CPU per simulated second. */
'use strict';
var path = require('path');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/vehicle.js', 'js/derby/derby-arenas.js', 'js/derby/derby-pickups.js', 'js/derby/derby-physics.js',
 'js/derby/derby-damage.js', 'js/derby/derby-accessories.js', 'js/derby/derby-ai.js', 'js/derby/derby-session.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB;

function runMatch(o) {
  var S = CB.derby.session.create({ arenaId: o.arena, seed: o.seed, opponents: o.opponents, difficulty: o.difficulty || 'pro', playerAutopilot: true,
    player: { presetId: o.presetId || 'muscle', accessories: o.accessories || ['ram', 'armour', 'nitro'] } });
  var cars = S._cars, n = cars.length;
  var st = { fast: 0, impacts: 0, big: 0, carMin: 0, stuck: 0, alive: 0, orbit: 0, selfFalls: 0, pushedFalls: 0, nan: false, steps: 0, walls: 0, accEv: {} };
  var prevDist = {}, orbitAcc = {}, posHist = {};
  var t0 = process.hrtime.bigint();
  var maxSteps = 120 * (o.maxSeconds || 300);
  for (var i = 0; i < maxSteps; i++) {
    S.step();
    st.steps++;
    if (i % 12 === 0) {
      var sn = S.snapshot();
      sn.events.forEach(function (e) {
        if (e.type === 'impact' && !e.ball && !e.crusher) { st.impacts++; if (e.vn > 11) st.big++; }
        else if (e.type === 'wall') st.walls++;
        else if (e.type === 'eliminated' && e.reason === 'fell') { if (e.otherId) st.pushedFalls++; else st.selfFalls++; }
        if (['flame', 'hammer', 'launch', 'magnet', 'oil', 'caltrops', 'shield', 'repair', 'nitro'].indexOf(e.type) >= 0) st.accEv[e.type] = (st.accEv[e.type] || 0) + 1;
      });
      var W = S.world;
      if (W.phase === 'fight') {
        cars.forEach(function (c) {
          if (!isFinite(c.x + c.y + c.vx + c.vy + c.w + c.z + c.heading + c.dmg.health)) st.nan = true;
          if (c.out) return;
          st.alive += 0.1; st.carMin += 0.1 / 60;
          // stuck: never faster than 1.5 m/s during the last 2 s (not flipped / airborne)
          var hist = posHist[c.id] || (posHist[c.id] = []);
          hist.push(c.speed); if (hist.length > 21) hist.shift();
          if (hist.length === 21 && !c.flipped && !c.airborne && Math.max.apply(null, hist) < 1.5) st.stuck += 0.1;
          var br = S.getBrain ? null : null; void br;
          if (c.speed > 8) st.fast += 0.1;
          // orbit: within 25 m of target and not closing in
          var b = S._cars && c.id && CB.derby && null;
          var tg = sn.cars.filter(function (x) { return x.id === c.id; })[0].target;
          var T = tg ? W.byId(tg) : null;
          if (T && !T.out) {
            var d = Math.hypot(T.x - c.x, T.y - c.y);
            var k = c.id;
            if (d < 25 && prevDist[k] != null && d >= prevDist[k] - 0.05) { orbitAcc[k] = (orbitAcc[k] || 0) + 0.1; if (orbitAcc[k] > 2.5) st.orbit += 0.1; }
            else orbitAcc[k] = 0;
            prevDist[k] = d;
          }
        });
      }
      if (sn.phase === 'over' && sn.overT > 0.5) break;
    }
  }
  var ms = Number(process.hrtime.bigint() - t0) / 1e6;
  var r = S.results();
  st.duration = r.duration_s; st.winner = r.winnerId; st.ms = ms; st.msPerSimS = ms / (st.steps / 120);
  st.ended = S.world.phase === 'over';
  st.impPerCarMin = st.impacts * 2 / Math.max(0.01, st.carMin);   // each impact involves 2 cars
  st.bigPerMin = st.big / Math.max(0.01, r.duration_s / 60);
  st.stuckPct = st.stuck / Math.max(0.01, st.alive) * 100;
  st.orbitPct = st.orbit / Math.max(0.01, st.alive) * 100;
  st.fastPct = st.fast / Math.max(0.01, st.alive) * 100;
  st.results = r;
  return st;
}

module.exports = { runMatch: runMatch };

if (require.main === module) {
  var a = process.argv.slice(2);
  var arenas = !a[0] || a[0] === 'all' ? CB.derby.arenas.ids() : [a[0]];
  var seeds = +a[1] || 3, opp = +a[2] || 7, diff = a[3] || 'pro', maxS = +a[4] || 300;
  arenas.forEach(function (ar) {
    var agg = { imp: 0, big: 0, dur: 0, stuck: 0, orbit: 0, self: 0, pushed: 0, ms: 0, ended: 0, nan: 0 };
    for (var s = 1; s <= seeds; s++) {
      var st = runMatch({ arena: ar, seed: s, opponents: opp, difficulty: diff, maxSeconds: maxS });
      console.log(ar.padEnd(10), 'seed', s, 'dur', st.duration.toFixed(0).padStart(4) + 's', st.ended ? 'END' : 'TIMEOUT', 'win', String(st.winner).padEnd(7),
        'imp/car-min', st.impPerCarMin.toFixed(1), 'big/min', st.bigPerMin.toFixed(1), 'stuck%', st.stuckPct.toFixed(1), 'orbit%', st.orbitPct.toFixed(1), 'fast%', st.fastPct.toFixed(0),
        'falls self/push', st.selfFalls + '/' + st.pushedFalls, 'ms/simS', st.msPerSimS.toFixed(1), st.nan ? 'NaN!' : '', JSON.stringify(st.accEv));
      agg.imp += st.impPerCarMin; agg.big += st.bigPerMin; agg.dur += st.duration; agg.stuck += st.stuckPct; agg.orbit += st.orbitPct; agg.self += st.selfFalls; agg.pushed += st.pushedFalls; agg.ms += st.msPerSimS; agg.ended += st.ended ? 1 : 0; agg.nan += st.nan ? 1 : 0;
    }
    console.log('==', ar.padEnd(10), 'avg imp/car-min', (agg.imp / seeds).toFixed(1), 'big/min', (agg.big / seeds).toFixed(1), 'dur', (agg.dur / seeds).toFixed(0), 'stuck%', (agg.stuck / seeds).toFixed(1), 'orbit%', (agg.orbit / seeds).toFixed(1), 'self/push', agg.self + '/' + agg.pushed, 'ended', agg.ended + '/' + seeds, 'ms/simS', (agg.ms / seeds).toFixed(1), agg.nan ? 'NaN' : '');
  });
}

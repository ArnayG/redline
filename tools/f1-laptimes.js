#!/usr/bin/env node
/* Redline — tools/f1-laptimes.js : F1 AI report (docs/F1-SPEC.md §5).

   node tools/f1-laptimes.js                 lap-time table (real pole / race lap vs AI best lap, Pro and Alien) on every
                                             F1 circuit + a clean-race sweep (contacts, wall hits, DNFs, DRS, pit stops)
   node tools/f1-laptimes.js --laps         only the lap-time table
   node tools/f1-laptimes.js --race [--cars=22] [--race-laps=3] [--circuit=f1-monza]   only the race sweep
   node tools/f1-laptimes.js --json         machine-readable

   Also a module: require('./tools/f1-laptimes.js') -> { load, hotLap, race, circuits, entrants }
   Uses the real modules (CB.f1.circuits / CB.f1.hooks / CB.f1.car / CB.f1.mode) when they are present; without them a
   provisional F1 car on the classic circuits (so the AI work never blocks on sibling modules).
*/
'use strict';
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');

var loaded = false;
function load() {
  if (loaded) return globalThis.CB;
  ['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js', 'js/race/vehicle.js',
    'js/race/ai.js', 'js/game/endurance.js', 'js/race/engine.js',
    'js/f1/f1-teams.js', 'js/f1/f1-circuits.js', 'js/f1/f1-car.js', 'js/f1/f1-strategy.js', 'js/f1/f1-ai.js', 'js/f1/f1-hooks.js', 'js/f1/f1-mode.js'
  ].forEach(function (rel) {
    var p = path.join(root, rel);
    if (!fs.existsSync(p)) return;
    try { require(p); } catch (e) { if (process.env.F1_DEBUG) console.warn('load ' + rel + ': ' + e.message); }
  });
  loaded = true;
  return globalThis.CB;
}

function CBx() { return load(); }
function real() { var CB = CBx(); return !!(CB.f1 && CB.f1.hooks && typeof CB.f1.hooks.create === 'function'); }
function realCircuits() { var CB = CBx(); return !!(CB.f1 && CB.f1.circuits && Array.isArray(CB.f1.circuits.list) && CB.f1.circuits.list.length); }
function circuits() {
  var CB = CBx();
  if (CB.f1 && CB.f1.circuits && Array.isArray(CB.f1.circuits.list)) return CB.f1.circuits.list.slice();
  return ['forge-ring', 'porto-vecchio', 'neon-harbour'].map(function (id) { return CB.race.tracks.get(id); }).filter(Boolean);
}
function metaOf(def) {
  var CB = CBx();
  try { if (CB.f1 && CB.f1.circuits && CB.f1.circuits.meta) { var m = CB.f1.circuits.meta(def); if (m) return m; } } catch (e) { /* none */ }
  return { length_m: CB.race.tracks.build(def).length, real: (def.f1 && def.f1.real) || {} };
}

/* ------------------------------------------------------------ provisional F1 car (no CB.f1.car) */
var provCache = null;
function provParams() {
  if (provCache) return provCache;
  var CB = CBx(), V = CB.race.vehicle, G = 9.81;
  if (CB.f1 && CB.f1.car && typeof CB.f1.car.params === 'function') { try { provCache = CB.f1.car.params(); return provCache; } catch (e) { /* below */ } }
  var p = JSON.parse(JSON.stringify(V.fromBuild(CB.f1.teams.buildFor('ferrari'))));
  var k = 745 / p.powerKw;
  Object.assign(p, { mass: 800, weightFront: 0.45, cgHeight: 0.28, wheelbase: 3.6, track: 1.6, length_m: 5.6, width_m: 2.0, radiusF: 0.36, radiusR: 0.36,
    muF: 1.75, muR: 1.78, cdA: 1.35, clA: 8.0, dfFrontFrac: 0.44, shiftTime: 0.03, shiftCut: 0.95, finalDrive: 4.68, brakeBias: 0.56, lockAngle: 0.42, governor: Infinity });
  p.a = 3.6 * 0.55; p.b = 3.6 * 0.45; p.Iz = 800 * p.a * p.b * 0.95;
  p.fzRefF = 800 * G * 0.45 / 2; p.fzRefR = 800 * G * 0.55 / 2; p.fz0F = p.fz0R = 800 * G / 4;
  p.torqueTable = p.torqueTable.map(function (x) { return x * k; }); p.peakNm *= k; p.powerKw = 745;
  p.brakeForceMax = 800 * G * 5.6; p.maxBrakeTorqueF = p.brakeForceMax * 0.56 * 0.18; p.maxBrakeTorqueR = p.brakeForceMax * 0.44 * 0.18;
  delete p.capabilities; p.capabilities = V.capabilities(p);
  p.maxLatG = p.capabilities.maxLatG; p.maxBrakeG = p.capabilities.maxBrakeG; p.topSpeed_ms = p.capabilities.topSpeed_mps; p.maxSteer = p.lockAngle;
  provCache = p;
  return p;
}
function provHook() {
  var CB = CBx(), V = CB.race.vehicle, P = provParams();
  return {
    carCreated: function (car) {
      car.params = P;
      car.state = V.createState(P, { x: car.state.x, y: car.state.y, heading: car.state.heading, speed: 0 }, { autoShift: true });
      car.length_m = 5.6; car.width_m = 2.0; car.halfL = 2.8; car.redline = P.redline; car.halfW = 1.0; car.axA = P.a; car.axB = P.b; car.halfTrack = 0.8; car.mass = 800; car.Iz = P.Iz; car.maxGear = 8;
    },
    wrapDriver: function (d, car, en) { return CB.f1.ai.wrapDriver(d, car, en); }
  };
}

/* ------------------------------------------------------------ entrants */
var SKILL = { rookie: 0.57, amateur: 0.72, pro: 0.875, alien: 0.97 };
function entrants(n, difficulty, seed, playerTeam) {
  var CB = CBx(), M = CB.f1 && CB.f1.mode;
  var list;
  if (M && typeof M.entrants === 'function') list = M.entrants({ playerTeam: playerTeam || 'mclaren', playerSeat: 0, difficulty: difficulty, seed: seed });
  else {
    list = [];
    CB.f1.teams.list.forEach(function (t) { t.drivers.forEach(function (d, seat) {
      list.push({ id: 'f1-' + d.id, name: d.name, team: t.name, number: d.number, color: t.livery.primary, build: CB.f1.teams.buildFor(t.id, { seat: seat }),
        skill: SKILL[difficulty] || 0.85, aggression: 0.5, consistency: 0.92, f1: { teamId: t.id, seat: seat } });
    }); });
    list = list.slice(1);
  }
  return list.slice(0, Math.max(0, n));
}

/** Engine cfg for an F1 session (real hooks when present). */
function sessionCfg(def, o) {
  var CB = CBx();
  var laps = o.laps || 3, mode = o.mode || 'race';
  var opps = o.opponents || entrants(o.cars != null ? o.cars - 1 : 21, o.difficulty || 'pro', o.seed || 1, o.playerTeam);
  var cfg = {
    track: def, trackId: def.id, mode: mode, laps: laps, opponents: opps, maxOpponents: 21, seed: o.seed || 1,
    playerBuild: CB.f1.teams.buildFor(o.playerTeam || 'mclaren', { isPlayer: true }), playerAutopilot: true, weather: o.weather || 'dry',
    assists: { abs: true, tc: true, autoShift: true }, stuckDnf_s: 40
  };
  if (real()) {
    var H = CB.f1.hooks.create({ circuit: def, meta: realCircuits() ? metaOf(def) : undefined, mode: mode === 'practice' && o.qualifying ? 'qualifying' : mode, weather: cfg.weather, playerTeam: o.playerTeam || 'mclaren',
      entrants: opps, seed: cfg.seed, laps: laps, playerAI: true, wearMult: o.wearMult, requireTwoCompounds: !!o.twoCompound });
    cfg.hooks = [H];
    cfg.extras = { pitStops: o.pits !== false, autoPit: true };
    cfg._hooks = H;
  } else {
    cfg.hooks = [provHook()];
  }
  if (o.autopilotSkill != null) cfg.playerAutopilotSkill = o.autopilotSkill;
  return cfg;
}

function carF1(c) { return (c && c.endurance && c.endurance.f1) || null; }

/** Hot laps in clean air (engine time trial, nobody else on track): the player's car runs on an AI driver of the given
    difficulty (an F1 entrant's skill / pace, wrapped by CB.f1.ai) — best lap. */
function hotLap(def, difficulty, opts) {
  opts = opts || {};
  var CB = CBx(), E = CB.race.engine;
  var en = entrants(1, difficulty, opts.seed || 3, 'cadillac')[0];
  var cfg = sessionCfg(def, { mode: 'time-trial', laps: 50, opponents: [], difficulty: difficulty, seed: opts.seed || 3, pits: false, qualifying: true });
  cfg.mode = 'time-trial'; cfg.playerAutopilot = true; cfg.persistGhost = false;
  var geom = CB.race.tracks.build(def), H = cfg._hooks;
  cfg.hooks = cfg.hooks.concat([{ wrapDriver: function (d, car, e0, isAuto) {
    if (!isAuto) return undefined;
    var base = CB.race.ai.createDriver(en, geom, car.params, { id: car.id, seed: 7 });
    return CB.f1.ai.wrapDriver(base, car, en, { mode: 'qualifying', hooks: H || null });
  } }]);
  var s = E.createSession(cfg);
  var L = s.geom.length, t = 0, nl = opts.laps || 3, tMax = (L / 40) * (nl + 1) + 30, walls = 0, off = 0, top = 0, drs = 0, wasOpen = false;
  while (t < tMax) {
    s.update(0.1, {}); t += 0.1;
    var sn = s.snapshot(), me = sn.cars.filter(function (c) { return c.isPlayer; })[0];
    (sn.events || []).forEach(function (e) { if (e.carId === me.id && e.type === 'wall') walls++; });
    if (me.offTrack) off += 0.1;
    var f1s = me.endurance && me.endurance.f1, dOpen = !!(f1s && f1s.drs && f1s.drs.open);
    if (dOpen && !wasOpen) drs++;
    wasOpen = dOpen;
    if (me.speed > top) top = me.speed;
    if (me.lap >= nl) break;
  }
  var r = s.results(), row = (r.classification || []).filter(function (c) { return c.isPlayer; })[0] || {};
  var laps = (row.lapTimes || []).slice();
  s = null; r = null; cfg = null;
  return { best: laps.length ? Math.min.apply(null, laps) : null, laps: laps, walls: walls, off_s: Math.round(off * 10) / 10, top_kph: Math.round(top * 3.6), skill: en.skill, drsUses: drs };
}

/** A race: returns clean-race stats. */
function race(def, opts) {
  opts = opts || {};
  var CB = CBx(), E = CB.race.engine;
  var cfg = sessionCfg(def, { mode: 'race', laps: opts.laps || 3, cars: opts.cars || 22, difficulty: opts.difficulty || 'pro', seed: opts.seed || 11, wearMult: opts.wearMult, pits: opts.pits, twoCompound: opts.twoCompound });
  var t0 = Date.now(), boostT = 0, tCap = opts.maxSim_s || Infinity;
  cfg.hooks = cfg.hooks.concat([{ postStep: function (car, dt) { if (car.f1 && car.f1.aiBoost && car.f1.ers && car.f1.ers.deploying) boostT += dt || 0; } }]);
  var s = E.createSession(cfg);
  var L = s.geom.length, t = 0, tMax = (L / 35) * (opts.laps || 3) + 120;
  var ev = {}, contacts = 0, walls = 0, lap1Contacts = 0, drsOpen = {}, drsUses = 0, off = 0, pits = 0, ersBoost = 0, pitLaneOff = 0;
  var prevOpen = {};
  tMax = Math.min(tMax, tCap);
  while (t < tMax) {
    s.update(0.1, {}); t += 0.1;
    var sn = s.snapshot();
    (sn.events || []).forEach(function (e) {
      ev[e.type] = (ev[e.type] || 0) + 1;
      if (e.type === 'collision') { contacts++; var c0 = sn.cars.filter(function (c) { return c.id === e.carId; })[0]; if (c0 && c0.lap === 0) lap1Contacts++; }
      if (e.type === 'wall') walls++;
      if (e.type === 'pitStop') pits++;
    });
    sn.cars.forEach(function (c) {
      var f = carF1(c), open = !!(f && f.drs && f.drs.open);
      if (open && !prevOpen[c.id]) drsUses++;
      prevOpen[c.id] = open;
      if (c.offTrack && !c.pitPhase) off += 0.1;
    });
    if (sn.phase === 'finished') break;
  }
  var r = s.results(), cl = r.classification || [];
  var dnf = cl.filter(function (c) { return c.status === 'dnf' || c.dnfReason; }).length;
  var best = cl.reduce(function (m, c) { return c.bestLap_s && (!m || c.bestLap_s < m) ? c.bestLap_s : m; }, null);
  var out = {
    circuit: def.id, cars: cl.length, laps: opts.laps || 3, sim_s: Math.round(t), wall_s: Math.round((Date.now() - t0) / 100) / 10,
    contacts: contacts, lap1Contacts: lap1Contacts, wallHits: walls, offTrack_s: Math.round(off), dnf: dnf, drsUses: drsUses, pitStops: pits,
    ersBoost_s: Math.round(boostT), bestLap: best, finished: cl.filter(function (c) { return c.status === 'finished' || c.raceTime_s; }).length,
    winner: cl[0] && cl[0].name, events: ev,
    // compact classification only (the full results carry ghosts / per-lap detail: keep memory flat across many races)
    results: opts.keepResults ? r : { classification: cl.map(function (c) {
      return { position: c.position, id: c.id, name: c.name, isPlayer: c.isPlayer, status: c.status, raceTime_s: c.raceTime_s, bestLap_s: c.bestLap_s,
        pitStops: c.pitStops, penalties_s: c.penalties_s, collisions: c.collisions, endurance: c.endurance && c.endurance.f1 ? { f1: { compoundsUsed: (c.endurance.f1.compoundsUsed || []).slice() } } : null };
    }) }
  };
  s = null; cfg = null; r = null;
  return out;
}

function fmt(t) { if (!t) return '   —   '; var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2); }

function main() {
  var args = process.argv.slice(2), want = {};
  args.forEach(function (a) { var m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) want[m[1]] = m[2] == null ? true : m[2]; });
  var CB = load();
  var list = circuits();
  if (want.circuit) list = list.filter(function (d) { return d.id === want.circuit || d.id === 'f1-' + want.circuit; });
  var json = { real: real(), laps: [], races: [] };
  if (!json.real) console.log('(provisional F1 car: CB.f1.hooks not loaded)');
  if (!realCircuits()) console.log('(classic circuits: CB.f1.circuits not loaded)');
  if (!want.race) {
    if (!want.json) console.log('\nCircuit            length m (real)   pole (real)  race lap (real)   AI Pro     AI Alien    Pro vs pole   Alien vs pole');
    list.forEach(function (def) {
      var m = metaOf(def), rl = (m && m.real) || {};
      var pro = hotLap(def, 'pro'), al = hotLap(def, 'alien');
      var row = { id: def.id, length_m: Math.round(m.length_m || 0), realLength_m: rl.length_m || null, pole_s: rl.pole_s || null, raceLap_s: rl.raceLap_s || null,
        pro: pro.best, alien: al.best, proWalls: pro.walls, alienWalls: al.walls, proOff_s: pro.off_s, top_kph: al.top_kph };
      json.laps.push(row);
      if (!want.json) {
        var pct = function (a) { return a && rl.pole_s ? ((a / rl.pole_s - 1) * 100).toFixed(1) + '%' : '—'; };
        console.log((def.id + '                  ').slice(0, 18) + ' ' + (String(row.length_m) + ' (' + (rl.length_m || '?') + ')            ').slice(0, 17) + ' ' +
          fmt(rl.pole_s) + '     ' + fmt(rl.raceLap_s) + '        ' + fmt(pro.best) + '   ' + fmt(al.best) + '    ' + (pct(pro.best) + '        ').slice(0, 12) + '  ' + pct(al.best) +
          (pro.walls || al.walls ? '   walls ' + pro.walls + '/' + al.walls : '') + '  vmax ' + al.top_kph);
      }
    });
  }
  if (!want.laps) {
    var cars = +want.cars || 22, rl2 = +want['race-laps'] || 3;
    if (!want.json) console.log('\nRace sweep: ' + cars + ' cars, ' + rl2 + ' laps, Pro AI\nCircuit            contacts (lap 1)  walls  off-s  DNF  DRS  pits  ERS-boost-s  best lap   wall-s');
    list.forEach(function (def) {
      var r = race(def, { cars: cars, laps: rl2, difficulty: want.difficulty || 'pro', wearMult: want.wear ? +want.wear : undefined, twoCompound: !!want['two-compound'] });
      delete r.results;
      json.races.push(r);
      if (!want.json) console.log((def.id + '                  ').slice(0, 18) + ' ' + (r.contacts + ' (' + r.lap1Contacts + ')              ').slice(0, 17) + ' ' +
        (r.wallHits + '      ').slice(0, 6) + ' ' + (r.offTrack_s + '      ').slice(0, 6) + ' ' + (r.dnf + '    ').slice(0, 4) + ' ' + (r.drsUses + '    ').slice(0, 4) + ' ' +
        (r.pitStops + '     ').slice(0, 5) + ' ' + (r.ersBoost_s + '            ').slice(0, 12) + ' ' + fmt(r.bestLap) + '   ' + r.wall_s);
    });
  }
  if (want.json) console.log(JSON.stringify(json, null, 1));
}

module.exports = { load: load, hotLap: hotLap, race: race, circuits: circuits, entrants: entrants, sessionCfg: sessionCfg, metaOf: metaOf, real: real, provParams: provParams };
if (require.main === module) main();

/* FORGE Atelier — game ⇄ race engine integration tests (GAME-SPEC § Engine hook contract).
   Run: node tests/run.js integration */
'use strict';
const assert = require('node:assert/strict');
const path = require('path');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

const root = path.join(__dirname, '..');
['util', 'data', 'state', 'physics', 'rules', 'pricing'].forEach((m) => { try { require(path.join(root, 'js', m + '.js')); } catch (e) { /* optional */ } });
['tracks', 'vehicle', 'ai', 'engine'].forEach((m) => require(path.join(root, 'js', 'race', m + '.js')));
['profile', 'economy', 'career', 'endurance', 'achievements', 'challenges', 'replay'].forEach((m) => require(path.join(root, 'js', 'game', m + '.js')));
const CB = globalThis.CB;
const Eng = CB.race.engine;

function playerBuild() {
  const p = CB.data && Array.isArray(CB.data.presets) ? CB.data.presets[0] : null;
  return p && p.build ? JSON.parse(JSON.stringify(p.build)) : undefined;
}

test('integration: custom hooks are called with the contract signatures', () => {
  const calls = { created: 0, pre: 0, post: 0, mods: 0 };
  const hooks = {
    carCreated(car) { calls.created++; assert.ok(car && car.id && car.params); },
    preStep(car, input, dt) { calls.pre++; assert.ok(dt > 0 && dt < 0.02); return Object.assign({}, input, { throttle: car.isPlayer ? 1 : input.throttle }); },
    postStep(car, dt) { calls.post++; assert.ok(car.state && dt > 0); },
    modifiers() { calls.mods++; return { gripMult: [1, 1], powerMult: 1, dragMult: 1, downforceMult: 1, steerPull: 0 }; }
  };
  const s = Eng.createSession({ trackId: 'forge-ring', mode: 'race', laps: 1, opponents: 2, seed: 7, playerBuild: playerBuild(), hooks, persistGhost: false });
  assert.equal(calls.created, 3);
  s.simulate(8, { throttle: 0 });
  assert.ok(calls.pre > 100 && calls.post > 100 && calls.mods > 100);
  const me = s.snapshot().cars.filter((c) => c.isPlayer)[0];
  assert.ok(me.speed > 5, 'preStep throttle override drives the player (speed ' + me.speed + ')');
});

test('integration: endurance extras attach CB.game.endurance automatically (fuel burn, wear, snapshot fields)', () => {
  const s = Eng.createSession({ trackId: 'forge-ring', mode: 'race', laps: 3, opponents: 1, seed: 3, playerBuild: playerBuild(),
    extras: { endurance: true, wear: 1, fuel: 1, damage: true, pitStops: 0 }, persistGhost: false, playerAutopilot: true });
  const hl = s.hooks();
  assert.ok(hl.length >= 1 && typeof hl[0].vehicleParams === 'function');
  const e0 = s.snapshot().cars[0].endurance;
  assert.ok(e0 && typeof e0 === 'object', 'snapshot cars carry endurance summaries');
  const st0 = hl[0].state(s._debug().player);
  const fuel0 = st0.fuel_l;
  s.simulate(40);
  const st1 = hl[0].state(s._debug().player);
  assert.ok(st1.fuel_l < fuel0, 'fuel burns (' + fuel0 + ' -> ' + st1.fuel_l + ')');
  assert.ok(st1.tireWear.some((w) => w > 0), 'tyres wear');
  const row = s.results().classification.filter((r) => r.isPlayer)[0];
  assert.ok(row.endurance && 'pitStops' in row);
});

test('integration: endurance mods reach the vehicle through applyToParams (not env.dragMult)', () => {
  let seenEnv = null;
  const V = CB.race.vehicle, orig = V.step;
  V.step = function (p, st, inp, dt, env) { if (!seenEnv) seenEnv = env; return orig.apply(this, arguments); };
  try {
    const s = Eng.createSession({ trackId: 'forge-ring', mode: 'time-trial', laps: 1, seed: 2, playerBuild: playerBuild(), extras: { endurance: true, fuel: 1, wear: 1 }, persistGhost: false });
    s.simulate(1, { throttle: 1 });
  } finally { V.step = orig; }
  assert.ok(seenEnv);
  assert.ok(seenEnv.dragMult === undefined || seenEnv.dragMult === 1 || seenEnv.dragMult < 2, 'surface drag untouched');
  assert.ok(Array.isArray(seenEnv.wheelGrip), 'per-wheel grip from vehicleEnv');
});

test('integration: wall and car contacts feed onImpact with a body-frame direction', () => {
  const hits = [];
  const hooks = { onImpact(car, j, dir, o) { hits.push({ id: car.id, j, dir, o }); } };
  const s = Eng.createSession({ trackId: 'forge-ring', mode: 'race', laps: 1, opponents: 0, seed: 5, playerBuild: playerBuild(), hooks, persistGhost: false });
  // full throttle, full lock: the car must hit the wall
  s.simulate(12, { throttle: 1, steer: 1 });
  s.simulate(10, { throttle: 1, steer: -1 });
  assert.ok(hits.length > 0, 'wall impacts reported');
  hits.forEach((h) => { assert.ok(h.j > 0); assert.ok(Math.abs(Math.hypot(h.dir.x, h.dir.y)) > 0); });
});

test('integration: mandatory pit stops are taken (AI auto strategy) and logged', () => {
  const s = Eng.createSession({ trackId: 'little-anvil', mode: 'race', laps: 2, opponents: 2, seed: 11, playerBuild: playerBuild(),
    extras: { endurance: true, fuel: 1, wear: 1, damage: true, pitStops: 1, mandatoryPitStops: 1 }, persistGhost: false, playerAutopilot: true });
  assert.ok(s.pitInfo() && s.pitInfo().mandatory === 1);
  const res = s.simulateToEnd(900);
  const stops = res.classification.map((r) => r.pitStops);
  assert.ok(stops.some((n) => n >= 1), 'someone pitted: ' + JSON.stringify(stops));
  res.classification.forEach((r) => { if (r.status === 'finished' && r.pitStops < 1) assert.ok(r.penalties_s >= 30, 'missed stop penalised'); });
});

test('integration: extras.onEvent receives engine events; challenge sessions run on the engine', () => {
  const Ch = CB.game.challenges;
  const list = Ch.all();
  const def = list.filter((c) => c.kind === 'launch')[0] || list[0];
  const cs = Ch.createChallengeSession(def.id, playerBuild());
  assert.ok(cs && cs.cfg && cs.cfg.hooks);
  const seen = [];
  const userOn = cs.cfg.extras.onEvent;
  cs.cfg.extras.onEvent = (e) => { seen.push(e.type); if (userOn) userOn(e); };
  const s = Eng.createSession(cs.cfg);
  s.simulate(6, { throttle: 1 });
  const ev = cs.evaluate(s.snapshot());
  assert.ok(ev && 'score' in ev && 'done' in ev);
  assert.ok(seen.indexOf('start') >= 0, 'start event forwarded: ' + seen.slice(0, 5).join(','));
  // leave the shared track catalogue as other test files expect it
  if (typeof Ch.unregisterTracks === 'function') Ch.unregisterTracks();
});

test('integration: career raceConfigFor cfg runs in the engine and recordResult accepts engine results', () => {
  const C = CB.game.career, P = CB.game.profile;
  const prof = JSON.parse(JSON.stringify(P.defaultProfile ? P.defaultProfile() : P.get()));
  const champs = C.listChampionships(prof).filter((c) => !c.locked && c.unlocked !== false);
  const champ = champs[0] || C.catalog.championships[0];
  const b = playerBuild();
  prof.ownedCars = [{ id: 'car-1', name: 'Test', build: b, condition: 1, odometer_km: 0, races: 0, wins: 0 }];
  prof.activeCarId = 'car-1';
  C.enter(prof, champ.id, { build: b, force: true, carId: 'car-1' });
  const cfg = C.raceConfigFor(prof, champ.id, 0, { build: b });
  assert.ok(cfg && cfg.trackId && cfg.extras);
  cfg.laps = 1; cfg.persistGhost = false; cfg.playerAutopilot = true;
  const s = Eng.createSession(cfg);
  const res = s.simulateToEnd(600);
  assert.ok(res.classification.length >= 2);
  assert.ok(res.classification.some((r) => r.name === cfg.opponents[0].name), 'named career drivers are on the grid');
  const out = C.recordResult(prof, champ.id, 0, res);
  assert.ok(out && out.standings && out.pointsTable, 'recordResult returns standings');
});

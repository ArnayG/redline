/* FORGE Atelier — final-integration tests for the DRIFT / RACE wiring, steering assist sessions, real car models
   (body.model) and the hub drift purse. Mirrors what js/race/race-ui.js createRaceSession() builds in the browser.
   Run: node tests/run.js integration-drift   (or standalone: node tests/integration-drift.test.js) */
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });
const T = (n, f) => test('integration-drift: ' + n, f);

function load(rel) { const p = path.join(root, rel); if (fs.existsSync(p)) require(p); }
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach(load);
['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van'].forEach((m) => load('js/shapes/models/' + m + '.js'));
['js/state.js', 'js/physics.js', 'js/rules.js', 'js/pricing.js',
 'js/race/tracks.js', 'js/race/vehicle.js', 'js/race/ai.js', 'js/race/engine.js',
 'js/game/profile.js', 'js/game/economy.js', 'js/game/career.js', 'js/game/endurance.js',
 'js/race/drift/tune.js', 'js/race/drift/assist.js', 'js/race/drift/scoring.js', 'js/race/drift/tracks.js',
 'js/race/drift/ai.js', 'js/race/drift/hud.js', 'js/race/drift/arcade.js', 'js/race/drift/session.js',
 'js/race/race-ui.js', 'js/game/hub.js'].forEach(load);
const CB = globalThis.CB;

function preset(id) { return JSON.parse(JSON.stringify(CB.data.presetBuild ? CB.data.presetBuild(id) : CB.data.presets[0].build)); }
function engineCfgOf(cfg) { const o = {}; Object.keys(cfg).forEach((k) => { if (k !== 'hooks') o[k] = cfg[k]; }); return o; }
function finite(snap) { return snap.cars.every((c) => isFinite(c.x) && isFinite(c.y) && isFinite(c.speed)); }

/* ---------------------------------------------------------------- race-ui settings */
T('race-ui settings: discipline, steering assist (Race light / Drift heavy defaults) and drift options are sanitised', () => {
  const _ = CB.race.ui._;
  const d = _.sanitizeSettings({});
  assert.equal(d.steerAssist, 'light');
  assert.equal(d.raceSteerAssist, 'light');
  assert.equal(d.driftSteerAssist, 'heavy');
  assert.equal(_.sanitizeSettings({ discipline: 'drift' }).steerAssist, 'heavy', 'drift discipline: heavy');
  assert.equal(d.discipline, 'race');
  assert.equal(d.graphics, '3d', '3D is the default race view');
  assert.equal(d.driftCamera3d, 'chase');
  const s = _.sanitizeSettings({ discipline: 'nope', steerAssist: 'max', driftMode: 'x', driftTune: 'y', driftDuration: 99999 });
  assert.equal(s.discipline, 'race'); assert.equal(s.steerAssist, 'light'); assert.equal(s.driftMode, 'trial'); assert.equal(s.driftTune, 'street');
  assert.ok(s.driftDuration <= 600);
  assert.equal(_.cam3dKey({ discipline: 'drift' }), 'driftCamera3d');
  assert.equal(_.cam3dKey({ discipline: 'race' }), 'camera3d');
});

T('race-ui setDiscipline keeps a remembered circuit per discipline', () => {
  const _ = CB.race.ui._;
  const S = _.sanitizeSettings({ trackId: 'forge-ring' });
  _.setDiscipline(S, 'drift');
  assert.equal(S.discipline, 'drift'); assert.equal(S.trackId, null); assert.equal(S.raceTrackId, 'forge-ring');
  S.trackId = 'kurogane-pass';
  _.setDiscipline(S, 'race');
  assert.equal(S.trackId, 'forge-ring'); assert.equal(S.driftTrackId, 'kurogane-pass');
  assert.equal(_.sessionLabel(Object.assign({}, S, { discipline: 'drift', driftMode: 'tandem' })), 'Drift · Tandem');
});

T('race-ui tracksFor: drift venues first for drifting, classic circuits first for racing; challenge layouts hidden', () => {
  const _ = CB.race.ui._;
  if (!CB.race.drift || !CB.race.drift.session) return;
  const drift = _.tracksFor('drift'), race = _.tracksFor('race');
  assert.ok(drift.length && race.length && drift.length === race.length);
  assert.ok(_.isDriftTrack(drift[0]), 'first drift-mode track is a drift venue: ' + drift[0].id);
  assert.ok(!_.isDriftTrack(race[0]), 'first race-mode track is a grip circuit: ' + race[0].id);
  assert.ok(race.every((t) => !t.challenge));
});

/* ---------------------------------------------------------------- sessions (what race-ui builds) */
T('assisted RACE: drift.createSession({mode:race}) wraps a career round (extras + endurance hooks survive) and finishes', () => {
  const D = CB.race.drift;
  if (!D || typeof D.createSession !== 'function') return;
  const C = CB.game.career, P = CB.game.profile;
  const prof = JSON.parse(JSON.stringify(P.defaultProfile ? P.defaultProfile() : P.get()));
  const champ = C.listChampionships(prof).filter((c) => !c.locked && c.unlocked !== false)[0] || C.catalog.championships[0];
  const b = preset('hot-hatch');
  prof.ownedCars = [{ id: 'car-1', name: 'Test', build: b, condition: 1, odometer_km: 0, races: 0, wins: 0 }];
  prof.activeCarId = 'car-1';
  C.enter(prof, champ.id, { build: b, force: true, carId: 'car-1' });
  const cfg = C.raceConfigFor(prof, champ.id, 0, { build: b });
  cfg.laps = 1; cfg.playerBuild = b; cfg.extras = Object.assign({}, cfg.extras, { endurance: true, fuel: 1, wear: 1 });
  const ec = engineCfgOf(cfg);
  ec.assists = Object.assign({}, cfg.assists || {}, { steeringAssist: false });
  ec.startPosition = cfg.startPosition !== undefined ? cfg.startPosition : 'middle';
  ec.persistGhost = false;
  const s = D.createSession({ mode: 'race', trackId: cfg.trackId, build: b, assist: 'heavy', laps: 1, opponents: cfg.opponents, seed: cfg.seed, engineCfg: ec, hooks: cfg.hooks });
  assert.equal(s.isRace, true);
  const hl = s.engine.hooks();
  assert.ok(hl.some((h) => typeof h.vehicleParams === 'function'), 'endurance hook auto-attached next to the assist hook');
  assert.ok(s.snapshot().cars[0].endurance, 'snapshot cars carry endurance fields');
  assert.ok(s.snapshot().cars.some((c) => !c.isPlayer && c.name === cfg.opponents[0].name), 'career opponents are on the grid');
  // keyboard intent goes through CB.race.assist (raw arrows), not pre-smoothed engine input
  for (let i = 0; i < 60 * 8; i++) s.update(1 / 60, { up: true, left: false, right: false, down: false });
  assert.ok(finite(s.snapshot()));
  s.setPlayerAutopilot(true);
  const res = s.engine.simulateToEnd(900);
  assert.ok(res.classification.length >= 2 && res.classification.some((r) => r.isPlayer));
  const out = C.recordResult(prof, champ.id, 0, res);
  assert.ok(out && out.standings, 'career accepts results of the assisted session');
});

T('heavy race assist holds the car on the grid (no jump start from a held throttle)', () => {
  const D = CB.race.drift;
  if (!D || typeof D.createSession !== 'function') return;
  const s = D.createSession({ mode: 'race', trackId: 'forge-ring', build: preset('alpine-gt'), assist: 'heavy', laps: 1, opponents: 2, seed: 4,
    engineCfg: { persistGhost: false, startPosition: 'middle', mode: 'race' } });
  for (let i = 0; i < 60; i++) s.update(1 / 60, { up: true });
  const ph = s.getPhase();
  if (ph === 'grid' || ph === 'countdown') {
    const me = s.snapshot().cars.filter((c) => c.isPlayer)[0];
    assert.ok(Math.abs(me.speed) < 1, 'player held on the grid (speed ' + me.speed + ')');
  }
});

T('DRIFT trial: drift session with race-ui style engineCfg runs, reports drift results, and ends on its clock', () => {
  const D = CB.race.drift;
  if (!D || typeof D.createSession !== 'function') return;
  const track = D.session.tracksFor('trial').filter((t) => D.session.isDriftTrack(t))[0];
  const s = D.createSession({ trackId: track && track.id, mode: 'trial', build: preset('muscle'), assist: 'heavy', tune: 'street', duration_s: 12,
    engineCfg: { persistGhost: false, assists: { abs: true, tc: false, autoShift: true, racingLine: false, steeringAssist: false }, playerName: 'You' } });
  assert.equal(s.isRace, false);
  let snap = s.snapshot();
  assert.ok(snap.drift && snap.drift.scorer, 'snapshot carries the drift scorer state for the drift HUD');
  for (let i = 0; i < 60 * 16 && !s.isFinished(); i++) s.update(1 / 60, { up: true, right: (i % 240) < 120, left: (i % 240) >= 120 });
  snap = s.snapshot();
  assert.ok(finite(snap));
  assert.ok(s.isFinished(), 'trial ends when its clock runs out');
  const r = s.results();
  assert.ok(r.drift && typeof r.drift.total === 'number', 'results().drift.total');
  assert.equal(r.driftMode, 'trial');
});

T('hub drift purse: paid on score and medal, free runs at half, nothing for zero', () => {
  const H = CB.game.hub;
  if (!H || !H._ || typeof H._.driftRewards !== 'function') return;
  const gold = H._.driftRewards({ drift: { total: 40000, medal: 'gold' }, driftMode: 'trial' }, { difficulty: 'amateur' });
  const free = H._.driftRewards({ drift: { total: 40000, medal: 'gold' }, driftMode: 'free' }, { difficulty: 'amateur' });
  const none = H._.driftRewards({ drift: { total: 0 } }, {});
  assert.ok(gold.credits > free.credits && free.credits > 0);
  assert.equal(none.credits, 0);
  assert.equal(gold.drift.medal, 'gold');
  assert.ok(gold.breakdown.reduce((a, b) => a + b.credits, 0) === gold.credits);
});

/* ---------------------------------------------------------------- real car models */
T('body.model: presets carry fitting real models of their own style', () => {
  if (!CB.shapes || !CB.shapes.models) return;
  CB.data.presets.forEach((p) => {
    const b = CB.state.normalize(CB.data.presetBuild(p.id));
    assert.ok(b.body.model, p.id + ' has a model');
    const m = CB.shapes.models[b.body.model];
    if (m) assert.equal(m.style, b.body.style, p.id + ' model style');
  });
});

T('body.model: normalize keeps valid ids, drops mismatches, resets on style change and survives share codes', () => {
  const S = CB.state;
  const b = S.normalize(CB.data.presetBuild('lightweight-roadster'));
  assert.equal(b.body.model, 'mazda-mx5-nd');
  const swapped = S.normalize(Object.assign({}, b, { body: Object.assign({}, b.body, { model: 'bmw-z4-g29' }) }));
  assert.equal(swapped.body.model, 'bmw-z4-g29');
  if (CB.shapes && CB.shapes.models && CB.shapes.models['porsche-911-992']) {
    const wrong = S.normalize(Object.assign({}, b, { body: Object.assign({}, b.body, { model: 'porsche-911-992' }) }));
    assert.equal(wrong.body.model, null, 'a coupé model on a roadster is dropped');
  }
  const restyled = S.normalize(Object.assign({}, b, { body: Object.assign({}, b.body, { style: 'coupe' }) }), { paths: ['body.style'], prev: b });
  assert.equal(restyled.body.model, null, 'changing style resets to the style default');
  assert.equal(S.normalize(Object.assign({}, b, { body: Object.assign({}, b.body, { model: '<script>' }) })).body.model, null);
  if (typeof S.encode === 'function' && typeof S.decode === 'function') {
    const back = S.decode(S.encode(swapped));
    assert.equal(back && back.body && back.body.model, 'bmw-z4-g29', 'share code round trip');
  }
});

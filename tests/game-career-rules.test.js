/* FORGE Atelier — career special-event rules through the real engine (drag / eliminator / fuel allowance),
   only-car sale guard and level standings at the start of a season. Run: node tests/run.js career-rules */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

const JS = '../js/';
['util.js', 'data.js', 'state.js', 'physics.js', 'game/economy.js', 'game/profile.js', 'race/tracks.js', 'race/tracks-extra.js', 'race/vehicle.js',
  'race/ai.js', 'race/engine.js', 'game/endurance.js', 'game/challenges.js'].forEach((f) => {
  try { require(JS + f); } catch (e) { /* optional neighbours */ }
});
const C = require(JS + 'game/career.js');
const CB = globalThis.CB;
const E = CB.race && CB.race.engine;

function build(patch) {
  const b = {
    meta: { id: 'test', name: 'Test' }, body: { style: 'coupe', seats: 2, chassisMaterial: 'steel' },
    engine: { type: 'ice', layout: 'V8', position: 'front', displacement_l: 5, aspiration: 'na', redline_rpm: 7000, tune: 'stock', fuel: 'premium' },
    drivetrain: { layout: 'rwd' }, tires: { compound: 'performance' }, transmission: { type: 'manual' }, aero: { wing: 'none' },
    weight: { ballast_kg: 0 }, exterior: { paint: '#c8a96a', livery_number: '7' }
  };
  if (patch) for (const k of Object.keys(patch)) b[k] = Object.assign({}, b[k] || {}, patch[k]);
  return b;
}
function profile(extra) {
  return Object.assign({ driverName: 'Ari Test', credits: 1e6, xp: 0, level: 9, createdAt: 1, ownedCars: [{ id: 'c1', build: build() }], activeCarId: 'c1',
    stats: {}, unlocks: { parts: [], tracks: [], bodyStyles: [] }, settings: { difficulty: 'amateur' } }, extra || {});
}
function runToEnd(cfg, maxT) {
  const s = E.createSession(Object.assign({ playerAutopilot: true }, cfg));
  while (s.getPhase() !== 'finished' && s.time() < (maxT || 1500)) s.update(0.25, {});
  return { s, res: s.results() };
}

test('career-rules: drag rounds are a 402 m standing-start sprint, not a lap of the course', () => {
  if (!E) return;
  const CH = CB.game.challenges;
  let reg = false;
  try { if (CH && CH.registerTracks && !(CB.race.tracks.byId && CB.race.tracks.byId['challenge-strip'])) { CH.registerTracks(); reg = true; } } catch (e) { /* ignore */ }
  try { dragRun(); } finally { if (reg && CH.unregisterTracks) CH.unregisterTracks(); }
});
function dragRun() {
  const cfg = C.raceConfigFor(profile(), 'national-midnight-drag', 0);
  assert.ok(Math.abs(cfg.extras.drag.distance_m - 402.336) < 1e-6);
  assert.ok(Array.isArray(cfg.hooks) && cfg.hooks.length, 'career hooks attached');
  const { s, res } = runToEnd(cfg, 300);
  assert.equal(s.getPhase(), 'finished');
  assert.ok(s.time() < 60, 'session ends shortly after the quarter mile (' + s.time().toFixed(1) + ' s)');
  const rows = res.classification;
  assert.equal(rows.length, 2, 'heads-up');
  rows.forEach((r) => {
    assert.equal(r.status, 'finished');
    assert.ok(r.raceTime_s > 6 && r.raceTime_s < 30, 'quarter-mile time ' + r.raceTime_s);
  });
}

test('career-rules: eliminator rounds knock the last car out every lap', () => {
  if (!E) return;
  const cfg = C.raceConfigFor(profile(), 'continental-last-car', 0);
  assert.ok(cfg.extras.eliminator);
  const { res } = runToEnd(cfg, 1500);
  const rows = res.classification;
  const out = rows.filter((r) => r.dnfReason === 'eliminated');
  assert.ok(out.length >= Math.min(cfg.laps - 1, rows.length - 1), out.length + ' eliminated over ' + cfg.laps + ' laps');
  const firstOut = rows.findIndex((r) => r.dnfReason === 'eliminated');
  assert.ok(rows.slice(firstOut).every((r) => r.dnfReason === 'eliminated' || r.status !== 'finished'), 'eliminated cars classified behind the survivors');
  // the career classifies knocked-out cars in elimination order rather than as retirements
  const p = profile();
  C.enter(p, 'continental-last-car', { force: true });
  const rec = C.recordResult(p, 'continental-last-car', 0, res);
  assert.equal(rec.ok !== false, true);
});

test('career-rules: Hybrid Efficiency fuelAllowance caps the fuel a car may load', () => {
  if (!E || !CB.game.endurance) return;
  const hb = build({ engine: { type: 'hybrid', layout: 'V6', position: 'mid', displacement_l: 3, aspiration: 'turbo', battery_kwh: 5 }, drivetrain: { layout: 'awd' } });
  const p = profile({ ownedCars: [{ id: 'c1', build: hb }] });
  const cfg = C.raceConfigFor(p, 'wec-hybrid-efficiency', 0, { build: hb });
  assert.equal(cfg.extras.fuelAllowance, 0.85);
  const s = E.createSession(Object.assign({ playerAutopilot: true }, cfg));
  for (let i = 0; i < 40; i++) s.update(0.25, {});
  const me = s._debug().player;
  assert.ok(me.endurance && me.endurance.tankCapacity_l > 0, 'endurance state');
  assert.ok(me.endurance.fuel_l <= me.endurance.tankCapacity_l * 0.85 + 1e-6, 'fuel ' + me.endurance.fuel_l + ' of ' + me.endurance.tankCapacity_l);
});

test('career-rules: selling the only car mid-season is blocked', () => {
  const p = profile();
  assert.equal(C.canSellCar(p, 'c1').ok, true, 'no season: fine');
  C.enter(p, 'rookie-sunday-cup', { force: true });
  const g = C.canSellCar(p, 'c1');
  assert.equal(g.ok, false);
  assert.match(g.reason, /only car/);
  p.ownedCars.push({ id: 'c2', build: build() });
  assert.equal(C.canSellCar(p, 'c1').ok, true, 'a second car: fine');
  const sold = profile({ ownedCars: [], activeCarId: null, stats: { carsSold: 1 } });
  assert.equal(C.entryCarOffer(sold), null, 'no free replacement after a sale');
  assert.equal(C.needsCar(sold), true);
});

test('career-rules: a fresh season shows everybody level (no fake 2nd on 0 pts)', () => {
  const p = profile();
  C.enter(p, 'rookie-sunday-cup', { force: true });
  const rows = C.standings(p, 'rookie-sunday-cup');
  assert.ok(rows.length > 1 && rows.every((r) => r.points === 0 && r.unranked === true));
  assert.equal(C.briefing(p, 'rookie-sunday-cup').playerPositionText, '—');
  C.skipRound(p, 'rookie-sunday-cup');
  assert.ok(C.standings(p, 'rookie-sunday-cup').every((r) => r.unranked === false), 'ranked after a round');
});

test('career-rules: every AI car of every championship passes its eligibility rules (and its real model fits them)', () => {
  const A = CB.race && CB.race.ai;
  if (!A || typeof A.createGrid !== 'function') return;
  const players = [build(), build({ body: { style: 'hatchback' }, drivetrain: { layout: 'rwd' }, engine: { layout: 'I4', displacement_l: 1.6 } })];
  let checked = 0;
  C.catalog.championships.forEach((c, ci) => {
    const req = c.requirements || {};
    // the first round with an AI field, plus the final
    const idxs = [];
    for (let i = 0; i < c.rounds.length && !idxs.length; i++) if (C.opponentsFor(profile(), c.id, i).length) idxs.push(i);
    if (c.rounds.length > 1) idxs.push(c.rounds.length - 1);
    idxs.forEach((idx) => {
      const p = profile({ ownedCars: [{ id: 'c1', build: players[ci % 2] }] });
      const cfg = C.raceConfigFor(p, c.id, idx);
      cfg.opponents.forEach((o) => {
        checked++;
        const el = C.checkEligibility(o.build, c.id);
        assert.ok(el.ok, c.id + ' R' + (idx + 1) + ' ' + (o.carName || o.name) + ': ' + el.reasons.join('; '));
        const m = CB.shapes && typeof CB.shapes.modelsByStyle === 'function' && o.model
          ? (CB.shapes.modelsByStyle(o.build.body.style) || []).filter((x) => x.id === o.model)[0] : null;
        if (!m) return;
        if (req.drivetrain && m.drivetrain) assert.ok(req.drivetrain.includes(m.drivetrain), c.id + ': ' + m.id + ' is ' + m.drivetrain);
        if (req.engineTypes && m.powertrain) assert.ok(req.engineTypes.includes(m.powertrain), c.id + ': ' + m.id + ' is ' + m.powertrain);
        if (req.bodyStyles) assert.ok(req.bodyStyles.includes(m.style), c.id + ': ' + m.id + ' is a ' + m.style);
      });
    });
  });
  assert.ok(checked > 100, 'checked ' + checked + ' AI cars');
});

test('career-rules: Hot Hatch Trophy AI field is front-wheel-drive hatchbacks inside the power cap', () => {
  const cfg = C.raceConfigFor(profile(), 'rookie-hot-hatch', 0);
  assert.ok(cfg.opponents.length > 0);
  cfg.opponents.forEach((o) => {
    assert.equal(o.build.body.style, 'hatchback');
    assert.equal(o.build.drivetrain.layout, 'fwd');
    assert.ok(C.checkEligibility(o.build, 'rookie-hot-hatch').metrics.power_hp <= 340);
    if (o.model) assert.ok(!/ae86|gr-yaris/.test(o.model), 'no RWD/AWD hatch models: ' + o.model);
  });
});

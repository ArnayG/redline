/* FORGE Atelier — CB.game.career tests. Run: node tests/run.js career */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

const JS = '../js/';
['data.js', 'game/economy.js', 'game/profile.js', 'race/tracks.js', 'race/vehicle.js', 'race/ai.js', 'race/engine.js'].forEach((f) => {
  try { require(JS + f); } catch (e) { /* optional neighbours: career has fallbacks for every one */ }
});
const C = require(JS + 'game/career.js');
const CB = globalThis.CB;

/* ------------------------------------------------------------------ fixtures */
function build(patch) {
  const b = {
    meta: { id: 'test', name: 'Test' },
    body: { style: 'hatchback', seats: 4, chassisMaterial: 'steel' },
    engine: { type: 'ice', layout: 'I4', position: 'front', displacement_l: 1.6, aspiration: 'na', redline_rpm: 7000, tune: 'stock', fuel: 'premium' },
    drivetrain: { layout: 'fwd' }, tires: { compound: 'performance' }, transmission: { type: 'manual' }, aero: { wing: 'none' },
    weight: { ballast_kg: 0 }, exterior: { paint: '#c8a96a', livery_number: '7' }
  };
  if (patch) for (const k of Object.keys(patch)) b[k] = Object.assign({}, b[k] || {}, patch[k]);
  return b;
}
const METRICS = (hp, kg) => ({ power_hp: hp, weight_kg: kg });
function profile(extra) {
  return Object.assign({ driverName: 'Ari Test', credits: 200000, xp: 0, level: 1, createdAt: 1, ownedCars: [{ id: 'c1', build: build() }], activeCarId: 'c1',
    stats: {}, unlocks: { parts: [], tracks: [], bodyStyles: [] }, settings: { difficulty: 'amateur' } }, extra || {});
}
/** Engine-like results for a round with the player finishing at `pos` (AI rows in field order fill the rest). */
function fakeResults(p, champId, roundIdx, pos, extra) {
  const cfg = C.raceConfigFor(p, champId, roundIdx);
  const ai = cfg.opponents.map((o) => ({ id: o.id, name: o.name, isPlayer: false, status: 'finished', bestLap_s: 60 + Math.random(), gridPosition: 0 }));
  const rows = ai.slice();
  rows.splice(Math.min(pos - 1, rows.length), 0, Object.assign({ id: 'player', isPlayer: true, status: 'finished', bestLap_s: 59, gridPosition: 3, collisions: 0, penalties_s: 0 }, extra || {}));
  rows.forEach((r, i) => { r.position = i + 1; r.totalTime_s = 300 + i * 2; if (!r.gridPosition) r.gridPosition = i + 1; });
  return { mode: cfg.mode, trackId: cfg.trackId, lapsTotal: cfg.laps, complete: true, playerId: 'player', classification: rows,
    fastestLap: { carId: 'player', time: 59 } };
}
const sumPts = (row) => row.pointsByRound.reduce((s, x) => s + (x || 0), 0);

/* ------------------------------------------------------------------ API & catalog */
test('career: API surface per GAME-SPEC', () => {
  ['state', 'nextRound', 'raceConfigFor', 'recordResult', 'checkEligibility', 'enter', 'withdraw', 'restart', 'calendar', 'briefing', 'standings',
    'trophies', 'skipRound', 'simulateRound', 'simulateSeason', 'pointsFor', 'sortStandings', 'estimateLapTime', 'rivalLine', 'resolveTrackId',
    'isUnlocked', 'isTierUnlocked', 'getTier', 'getChampionship', 'getRival', 'listChampionships', 'defaultState', 'simulateSession', 'commit']
    .forEach((k) => assert.equal(typeof C[k], 'function', k));
  assert.equal(CB.game.career, C);
  assert.ok(C.catalog && Array.isArray(C.catalog.tiers) && Array.isArray(C.catalog.championships) && Array.isArray(C.catalog.events));
});

test('career: catalog has 5 tiers × 3-5 championships × 3-6 rounds', () => {
  const names = C.catalog.tiers.map((t) => t.name);
  assert.deepEqual(names, ['Rookie Cup', 'National GT', 'Continental Series', 'World Endurance', 'Hypercar Masters']);
  C.catalog.tiers.forEach((t) => {
    assert.ok(t.championships.length >= 3 && t.championships.length <= 5, t.id + ' has ' + t.championships.length);
    t.championships.forEach((c) => {
      assert.ok(c.rounds.length >= 3 && c.rounds.length <= 6, c.id + ' rounds ' + c.rounds.length);
      assert.equal(c.tierId, t.id);
      assert.ok(c.entryFee >= 0 && c.prize.purse > 0, c.id + ' prize');
      c.rounds.forEach((r) => { assert.ok(r.laps >= 1 && r.laps <= 50); assert.ok(C.EVENT_TYPES[r.eventType]); });
    });
  });
  const ids = C.catalog.championships.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
});

test('career: special events of every type exist', () => {
  const types = new Set();
  C.catalog.championships.forEach((c) => c.eventTypes.forEach((t) => types.add(t)));
  ['race', 'time-attack', 'drag', 'drift', 'eliminator', 'endurance', 'manufacturer', 'rivals'].forEach((t) => assert.ok(types.has(t), t));
  const evTypes = new Set(C.catalog.events.map((e) => e.eventType));
  ['rivals', 'manufacturer', 'eliminator', 'time-attack', 'drag', 'drift', 'endurance'].forEach((t) => assert.ok(evTypes.has(t), 'event ' + t));
  C.catalog.events.filter((e) => e.eventType === 'rivals').forEach((e) => {
    assert.equal(e.opponents, 1); assert.ok(C.getRival(e.rival)); assert.equal(e.duelTarget, Math.floor(e.rounds.length / 2) + 1);
  });
  C.catalog.championships.filter((c) => c.eventType === 'manufacturer').forEach((c) => assert.ok(c.brief && c.brief.text, c.id + ' brief'));
});

test('career: every track id resolves to a registered track', () => {
  const T = CB.race && CB.race.tracks;
  const list = T ? (typeof T.list === 'function' ? T.list() : T.list) : [];
  const known = new Set((list || []).map((t) => t.id));
  C.catalog.championships.forEach((c) => c.rounds.forEach((r) => {
    const id = C.resolveTrackId(r.trackId);
    if (known.size) assert.ok(known.has(id), r.trackId + ' -> ' + id);
    assert.ok(typeof id === 'string' && id.length);
  }));
  assert.ok(C.resolveTrackId('drag-strip'));
});

test('career: rivals have dialog for every situation and lines fill templates', () => {
  const sits = ['intro', 'preRace', 'preFinale', 'playerLeads', 'rivalLeads', 'playerWon', 'rivalWon', 'playerBeatRival', 'rivalBeatPlayer',
    'playerDnf', 'rivalDnf', 'titlePlayer', 'titleRival', 'duelChallenge', 'duelWin', 'duelLoss', 'rain', 'comeback', 'respect', 'farewell'];
  assert.ok(C.RIVALS.length >= 5);
  C.RIVALS.forEach((r) => sits.forEach((s) => assert.ok(r.lines[s] && r.lines[s].length, r.id + ' ' + s)));
  const line = C.rivalLine('rival-kade', 'intro', { player: 'Ari', seed: 3 });
  assert.ok(line.length > 10 && line.indexOf('{') < 0, line);
  assert.equal(C.rivalLine('rival-kade', 'preRace', { seed: 9, round: 2 }), C.rivalLine('rival-kade', 'preRace', { seed: 9, round: 2 }), 'deterministic');
  assert.equal(C.rivalLine('nobody', 'intro'), '');
});

/* ------------------------------------------------------------------ points & tiebreakers */
test('career: points systems (F1 25-18-15, fastest lap, double finale, DNF/DNS)', () => {
  assert.equal(C.pointsFor('f1', 1), 25);
  assert.equal(C.pointsFor('f1', 2), 18);
  assert.equal(C.pointsFor('f1', 10), 1);
  assert.equal(C.pointsFor('f1', 11), 0);
  assert.equal(C.pointsFor('f1', 1, { fastestLap: true }), 26);
  assert.equal(C.pointsFor('f1', 11, { fastestLap: true }), 0, 'fastest lap only for top ten');
  assert.equal(C.pointsFor('f1', 1, { dnf: true }), 0);
  assert.equal(C.pointsFor('f1', 1, { dns: true, pole: true }), 0);
  assert.equal(C.pointsFor('masters', 1, { isFinal: true, pole: true }), 52);
  assert.equal(C.pointsFor('rookie', 5), 9, 'rookie finish point');
  assert.equal(C.pointsFor('endurance', 1, { pole: true }), 39);
  assert.equal(C.pointsFor('duel', 1), 1);
  assert.equal(C.pointsFor('duel', 2), 0);
});

test('career: standings tiebreak by countback then most recent result', () => {
  const rows = [
    { id: 'a', points: 43, finishes: [2, 1, 3] },
    { id: 'b', points: 43, finishes: [1, 1, 5] },
    { id: 'c', points: 50, finishes: [1, 1, 1] },
    { id: 'd', points: 43, finishes: [2, 1, 4] }
  ];
  const s = C.sortStandings(rows);
  assert.deepEqual(s.map((r) => r.id), ['c', 'b', 'a', 'd']);
  assert.equal(s[1].tiebreak, null, 'b is behind c on points');
  assert.equal(s[2].tiebreak, 'more wins');
  assert.equal(s[3].gapToLeader, 7);
});

/* ------------------------------------------------------------------ eligibility & unlocks */
test('career: eligibility checks with reasons', () => {
  const hatch = build({ engine: { displacement_l: 1.6 } });
  const ok = C.checkEligibility(hatch, 'rookie-hot-hatch', { metrics: METRICS(220, 1200) });
  assert.equal(ok.ok, true, ok.reasons.join('; '));
  const rwd = C.checkEligibility(build({ drivetrain: { layout: 'rwd' }, body: { style: 'coupe' } }), 'rookie-hot-hatch', { metrics: METRICS(400, 1300) });
  assert.equal(rwd.ok, false);
  assert.equal(rwd.reasons.length, 3, rwd.reasons.join('; '));
  assert.ok(rwd.reasons.some((r) => /hatchback/i.test(r)));
  assert.ok(rwd.reasons.some((r) => /FWD/.test(r)));
  assert.ok(rwd.reasons.some((r) => /340 hp/.test(r)));
  const ev = C.checkEligibility(hatch, 'rookie-volt-academy', { metrics: METRICS(200, 1200) });
  assert.equal(ev.ok, false);
  assert.ok(/Electric/.test(ev.reasons[0]));
  const light = C.checkEligibility(build({ body: { style: 'coupe' } }), 'national-gt4', { metrics: METRICS(400, 1000) });
  assert.ok(light.reasons.some((r) => /ballast/.test(r)), 'min weight reason suggests ballast');
  const none = C.checkEligibility(null, 'rookie-sunday-cup');
  assert.equal(none.ok, false);
  assert.ok(Array.isArray(ok.checks) && ok.checks.every((c) => typeof c.ok === 'boolean' && c.label));
});

test('career: tier unlocks require trophies and level', () => {
  const p = profile();
  assert.equal(C.isTierUnlocked(p, 'rookie'), true);
  assert.equal(C.isTierUnlocked(p, 'national'), false);
  const u = C.isUnlocked(p, 'national-gt4');
  assert.equal(u.ok, false);
  assert.ok(u.reasons.length >= 1 && /National GT/.test(u.reasons[0]));
  assert.equal(C.isUnlocked(p, 'rookie-sunday-cup').ok, true);
  const duel = C.isUnlocked(p, 'duel-kade');
  assert.equal(duel.ok, false);
  assert.ok(duel.reasons.some((r) => /Sunday Club Cup/.test(r)));
  assert.equal(C.isUnlocked(p, 'rookie-volt-academy').ok, false, 'needs level 2');
});

/* ------------------------------------------------------------------ simulation */
test('career: fields are deterministic, include rivals and persist driver identities', () => {
  const f1 = C.fieldFor('rookie-sunday-cup', 123, 1), f2 = C.fieldFor('rookie-sunday-cup', 123, 1);
  assert.deepEqual(f1, f2);
  assert.equal(f1.length, C.getChampionship('rookie-sunday-cup').opponents);
  assert.equal(f1[0], 'rival-kade');
  f1.forEach((id) => assert.ok(C.getDriver(id), id));
  const d = C.getDriver(f1[1]);
  assert.equal(C.getDriver(f1[1]).talent, d.talent, 'stable identity');
  assert.equal(new Set(f1).size, f1.length);
  const masters = C.fieldFor('hyper-masters', 123, 1).map((id) => C.getDriver(id).talent);
  const rookies = C.fieldFor('rookie-sunday-cup', 123, 1).slice(1).map((id) => C.getDriver(id).talent);
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  assert.ok(avg(masters) > avg(rookies), 'higher tiers draw more talented drivers');
});

test('career: simulateRound is deterministic for every event type', () => {
  const field = C.fieldFor('national-gt4', 7, 1);
  [['national-gt4', 0], ['national-midnight-drag', 0], ['rookie-drift-initiation', 0], ['national-time-attack', 0], ['wec-gt', 0], ['continental-last-car', 0]].forEach(([id, r]) => {
    const a = C.simulateRound(id, r, field, 99), b = C.simulateRound(id, r, field, 99);
    assert.deepEqual(a, b, id);
    assert.equal(a.length, field.length);
    assert.deepEqual(a.map((x) => x.position), a.map((_, i) => i + 1));
  });
  const seeds = [1, 2, 3, 4, 5].map((sd) => C.simulateRound('national-gt4', 0, field, sd).map((x) => x.id).join());
  assert.ok(new Set(seeds).size > 1, 'different seeds give different races');
  const drag = C.simulateRound('national-midnight-drag', 0, field, 5);
  const fin = drag.filter((x) => x.status === 'finished');
  assert.ok(fin.every((x) => x.et_s > 5 && x.et_s < 20 && x.reaction_s > 0), 'quarter-mile ETs');
  const drift = C.simulateRound('rookie-drift-initiation', 0, field, 5);
  for (let i = 1; i < drift.length; i++) assert.ok(drift[i - 1].score >= drift[i].score, 'drift sorted by score');
  const ta = C.simulateRound('national-time-attack', 0, field, 5).filter((x) => x.status === 'finished');
  for (let i = 1; i < ta.length; i++) assert.ok(ta[i - 1].bestLap_s <= ta[i].bestLap_s, 'time attack sorted by best lap');
  const endu = C.simulateRound('wec-gt', 0, field, 5);
  assert.ok(endu.some((x) => x.pitStops >= 1), 'endurance pit stops');
  assert.equal(endu.filter((x) => x.fastestLap).length <= 1, true);
});

test('career: simulateSeason accumulates points consistently', () => {
  const s = C.simulateSeason('continental-gt3', 2024);
  const s2 = C.simulateSeason('continental-gt3', 2024);
  assert.deepEqual(s.standings.map((r) => [r.id, r.points]), s2.standings.map((r) => [r.id, r.points]));
  assert.equal(s.rounds.length, 6);
  s.standings.forEach((r) => assert.equal(r.points, sumPts(r)));
  const total = s.rounds.reduce((acc, rd) => acc + rd.order.reduce((x, o) => x + o.points, 0), 0);
  assert.equal(total, s.standings.reduce((x, r) => x + r.points, 0));
  for (let i = 1; i < s.standings.length; i++) assert.ok(s.standings[i - 1].points >= s.standings[i].points);
  assert.ok(s.champion && s.champion.name);
});

test('career: estimateLapTime responds to power and grip', () => {
  const slow = C.estimateLapTime('forge-ring', { power_hp: 200, weight_kg: 1400, mu: 0.95 });
  const fast = C.estimateLapTime('forge-ring', { power_hp: 700, weight_kg: 1300, mu: 1.2, downforce_kg_200: 300 });
  assert.ok(slow > fast && fast > 30 && slow < 600, slow + ' vs ' + fast);
  const wet = C.estimateLapTime('forge-ring', { power_hp: 200, weight_kg: 1400, mu: 0.95 }, { wet: true });
  assert.ok(wet > slow);
});

/* ------------------------------------------------------------------ race configs */
test('career: raceConfigFor produces an engine session cfg with career extras', () => {
  const p = profile();
  const cfg = C.raceConfigFor(p, 'rookie-sunday-cup', 0);
  assert.equal(cfg.mode, 'race');
  assert.equal(cfg.laps, 6);
  assert.ok(typeof cfg.trackId === 'string');
  assert.equal(cfg.opponents.length, C.getChampionship('rookie-sunday-cup').opponents);
  cfg.opponents.forEach((o) => { assert.ok(o.id && o.name && o.build && o.skill > 0 && o.skill < 1); assert.equal(o.build.exterior.paint, o.color); });
  assert.equal(cfg.opponents[0].id, 'rival-kade');
  assert.ok(['rookie', 'amateur', 'pro', 'alien'].includes(cfg.difficulty));
  assert.ok(cfg.extras && cfg.extras.eventType === 'race' && cfg.extras.wear === false);
  assert.equal(cfg.career.champId, 'rookie-sunday-cup');
  assert.equal(cfg.context.kind, 'career');
  assert.deepEqual(C.raceConfigFor(p, 'rookie-sunday-cup', 0).opponents.map((o) => o.id), cfg.opponents.map((o) => o.id), 'deterministic grid');

  const endu = C.raceConfigFor(p, 'wec-prototype', 4);
  assert.equal(endu.extras.endurance, true);
  assert.equal(endu.extras.pitStops, 3);
  assert.ok(endu.extras.wear > 1 && endu.extras.fuel > 1 && endu.extras.damage === true);
  const ta = C.raceConfigFor(p, 'national-time-attack', 0);
  assert.equal(ta.mode, 'time-trial');
  assert.equal(ta.opponents.length, 0);
  const drag = C.raceConfigFor(p, 'national-midnight-drag', 0);
  assert.equal(drag.opponents.length, 1, 'heads-up');
  assert.ok(drag.extras.drag && drag.extras.drag.distance_m > 400);
  const eighth = C.raceConfigFor(p, 'national-midnight-drag', 2);
  assert.ok(Math.abs(eighth.extras.drag.distance_m - 201.168) < 1e-6);
  const duel = C.raceConfigFor(p, 'duel-sable', 0);
  assert.deepEqual(duel.opponents.map((o) => o.id), ['rival-sable']);
  assert.ok(duel.extras.headsUp && duel.extras.headsUp.target === 3);
  const elim = C.raceConfigFor(p, 'rookie-hot-hatch', 2);
  assert.equal(elim.extras.eventType, 'eliminator');
  assert.ok(elim.extras.eliminator);
});

test('career: config drives the real race engine and results feed back', () => {
  if (!(CB.race && CB.race.engine && CB.race.engine.createSession)) return;
  const p = profile({ ownedCars: [{ id: 'c1', build: CB.data && CB.data.defaultBuild ? CB.data.defaultBuild() : build() }] });
  const cfg = C.raceConfigFor(p, 'rookie-sunday-cup', 0);
  cfg.laps = 1;
  const s = CB.race.engine.createSession(cfg);
  const res = s.simulateToEnd(400);
  const ids = res.classification.map((r) => r.id);
  cfg.opponents.forEach((o) => assert.ok(ids.includes(o.id), 'engine keeps career driver id ' + o.id));
  const out = C.recordResult(p, 'rookie-sunday-cup', 0, res);
  assert.equal(out.ok, true);
  assert.equal(out.pointsTable.length, cfg.opponents.length + 1);
  const me = out.pointsTable.find((r) => r.isPlayer);
  assert.equal(me.position, res.classification.find((r) => r.isPlayer).position);
});

/* ------------------------------------------------------------------ full championship */
test('career: full championship — entry fee, rounds, standings, trophy, prize, unlocks', () => {
  const p = profile();
  const champ = C.getChampionship('rookie-sunday-cup');
  const credits0 = p.credits;
  const e = C.enter(p, champ.id, { build: build(), metrics: METRICS(200, 1200) });
  assert.equal(e.ok, true, e.reason);
  assert.equal(p.credits, credits0 - champ.entryFee);
  assert.ok(e.events.some((x) => x.type === 'rival' && x.rival === 'rival-kade'), 'rival introduces himself');
  assert.equal(C.state(p).championships[champ.id].status, 'active');

  const finishes = [2, 1, 1, 1];
  let last = null, earned = 0;
  finishes.forEach((pos, i) => {
    const nr = C.nextRound(p, champ.id);
    assert.equal(nr.roundIdx, i);
    const brief = C.briefing(p, champ.id);
    assert.ok(brief.text.length > 10 && brief.stakes.length >= 1);
    const before = p.credits;
    last = C.recordResult(p, champ.id, i, fakeResults(p, champ.id, i, pos));
    assert.equal(last.ok, true);
    assert.equal(last.roundPosition, pos);
    const me = last.pointsTable.find((r) => r.isPlayer);
    assert.equal(me.points, C.pointsFor('rookie', pos, { fastestLap: true, pole: false }));
    assert.ok(last.rewards.credits > 0, 'round purse');
    assert.ok(p.credits > before);
    earned += p.credits - before;
    last.standings.forEach((r) => assert.equal(r.points, sumPts(r), r.id));
    assert.ok(last.rival && last.rival.id === 'rival-kade' && last.rival.text.length > 0, 'rival reacts');
    if (i < finishes.length - 1) { assert.equal(last.championshipComplete, false); assert.equal(last.nextRound.roundIdx, i + 1); }
  });
  assert.equal(last.championshipComplete, true);
  assert.equal(last.position, 1);
  assert.equal(last.trophy.medal, 'gold');
  assert.equal(last.trophy.name, champ.trophy.name);
  assert.ok(last.rewards.breakdown.some((b) => b.kind === 'championship'), 'championship prize line');
  assert.ok(last.rewards.breakdown.some((b) => b.kind === 'tier'), 'first rookie title pays the tier reward');
  assert.ok(p.unlocks.tracks.includes('ouroboros'), 'championship unlock granted');
  assert.ok(last.unlocked.some((u) => u.id === 'ouroboros'));
  assert.equal(C.nextRound(p, champ.id), null);
  const st = C.state(p);
  assert.equal(st.championships[champ.id].status, 'complete');
  assert.equal(st.championships[champ.id].titles, 1);
  assert.equal(st.trophies.length, 1);
  assert.equal(st.stats.wins, 3);
  assert.equal(st.stats.titles, 1);
  assert.ok(st.titles.includes('Club Racer'));
  assert.ok(C.trophies(p).slots.find((s) => s.champId === champ.id).won);
  const cal = C.calendar(p, champ.id);
  assert.equal(cal.length, 4);
  assert.ok(cal.every((c) => c.date && c.date.label));
  // replaying a late duplicate of the final round applies nothing twice
  const credits = p.credits;
  const dup = C.recordResult(p, champ.id, 3, fakeResults(p, champ.id, 3, 1));
  assert.equal(dup.duplicate, true);
  assert.equal(p.credits, credits);
  assert.equal(C.state(p).trophies.length, 1);
  // national tier opens once the level requirement is met as well
  assert.equal(C.isTierUnlocked(Object.assign({}, p, { level: 3, xp: 1e9 }), 'national'), true);
  // a second season can be entered and starts from zero
  const e2 = C.enter(p, champ.id, { build: build(), metrics: METRICS(200, 1200) });
  assert.equal(e2.ok, true);
  assert.equal(e2.season, 2);
  assert.ok(C.standings(p, champ.id).every((r) => r.points === 0));
});

test('career: same-round duplicates mid-season are idempotent', () => {
  const p = profile();
  C.enter(p, 'rookie-sunday-cup', { force: true });
  const r = fakeResults(p, 'rookie-sunday-cup', 0, 3);
  C.recordResult(p, 'rookie-sunday-cup', 0, r);
  const c = p.credits, pts = C.standings(p, 'rookie-sunday-cup').find((x) => x.isPlayer).points;
  const d = C.recordResult(p, 'rookie-sunday-cup', 0, r);
  assert.equal(d.duplicate, true);
  assert.equal(p.credits, c);
  assert.equal(C.standings(p, 'rookie-sunday-cup').find((x) => x.isPlayer).points, pts);
});

test('career: losing a championship gives no title; DNS via skipRound scores zero', () => {
  const p = profile();
  C.enter(p, 'rookie-volt-academy', { force: true });
  const s0 = C.skipRound(p, 'rookie-volt-academy');
  assert.equal(s0.roundStatus, 'dns');
  assert.equal(s0.roundPoints, 0);
  assert.equal(s0.rewards.credits, 0);
  assert.equal(s0.pointsTable[s0.pointsTable.length - 1].id, 'player');
  C.skipRound(p, 'rookie-volt-academy');
  const last = C.skipRound(p, 'rookie-volt-academy');
  assert.equal(last.championshipComplete, true);
  assert.ok(last.position > 3);
  assert.equal(last.trophy, null);
  assert.equal(C.state(p).stats.titles, 0);
  assert.equal(C.state(p).stats.dns, 3);
});

test('career: DNF in a round scores zero but the field still scores', () => {
  const p = profile();
  C.enter(p, 'rookie-hot-hatch', { force: true });
  const res = fakeResults(p, 'rookie-hot-hatch', 0, 1, { status: 'dnf', dnf: true });
  const out = C.recordResult(p, 'rookie-hot-hatch', 0, res);
  assert.equal(out.roundStatus, 'dnf');
  assert.equal(out.roundPoints, 0);
  assert.ok(out.pointsTable[0].points > 0);
  assert.notEqual(out.pointsTable[0].id, 'player', 'a DNF is classified behind the finishers');
});

test('career: drag, drift and time attack rounds rank the player by their mark', () => {
  const p = profile({ ownedCars: [{ id: 'c1', build: build({ engine: { displacement_l: 5, aspiration: 'supercharged', layout: 'V8' }, drivetrain: { layout: 'rwd' }, body: { style: 'coupe' } }) }] });
  C.enter(p, 'national-midnight-drag', { force: true });
  const cfg = C.raceConfigFor(p, 'national-midnight-drag', 0);
  const oppId = cfg.opponents[0].id;
  const win = C.recordResult(p, 'national-midnight-drag', 0, { mode: 'race', classification: [
    { id: 'player', isPlayer: true, position: 1, status: 'finished', reaction_s: 0.12 }, { id: oppId, position: 2, status: 'finished' }] });
  const me = win.pointsTable.find((r) => r.isPlayer);
  const opp = win.pointsTable.find((r) => r.id === oppId);
  assert.ok(me.et_s > 4 && me.et_s < 20, 'player ET ' + me.et_s);
  assert.ok(me.position < opp.position, 'winning the heads-up beats that opponent in the classification');
  assert.equal(win.pointsTable.length, C.getChampionship('national-midnight-drag').opponents + 1);

  C.enter(p, 'rookie-drift-initiation', { force: true });
  const huge = C.recordResult(p, 'rookie-drift-initiation', 0, { mode: 'time-trial', classification: [{ id: 'player', isPlayer: true, driftScore: 1e7, status: 'finished' }] });
  assert.equal(huge.roundPosition, 1);
  assert.equal(huge.roundPoints, 32, 'drift win + best-run bonus');
  const zero = C.recordResult(p, 'rookie-drift-initiation', 1, { mode: 'time-trial', classification: [{ id: 'player', isPlayer: true, driftScore: 0, status: 'finished' }] });
  assert.equal(zero.roundPosition, zero.pointsTable.length);

  C.enter(p, 'national-time-attack', { force: true });
  const fast = C.recordResult(p, 'national-time-attack', 0, { mode: 'time-trial', classification: [{ id: 'player', isPlayer: true, bestLap_s: 1, status: 'finished' }] });
  assert.equal(fast.roundPosition, 1);
  const none = C.recordResult(p, 'national-time-attack', 1, { mode: 'time-trial', classification: [{ id: 'player', isPlayer: true, bestLap_s: null, status: 'finished' }] });
  assert.equal(none.roundPoints, 0, 'no valid lap, no points');
});

test('career: rival duel ends at the majority and records the duel', () => {
  const p = profile();
  C.enter(p, 'duel-kade', { force: true });
  const r1 = C.recordResult(p, 'duel-kade', 0, { classification: [{ id: 'player', isPlayer: true, position: 1, status: 'finished' }, { id: 'rival-kade', position: 2, status: 'finished' }] });
  assert.equal(r1.pointsTable.length, 2);
  assert.equal(r1.championshipComplete, false);
  const r2 = C.recordResult(p, 'duel-kade', 1, { classification: [{ id: 'player', isPlayer: true, position: 1, status: 'finished' }, { id: 'rival-kade', position: 2, status: 'finished' }] });
  assert.equal(r2.championshipComplete, true, 'best of three decided after two wins');
  assert.equal(r2.position, 1);
  assert.ok(r2.events.some((e) => e.type === 'rival-defeated'));
  assert.ok(r2.events.some((e) => e.type === 'story' && e.beat.id === 'kade-3'), 'duel-win story beat');
  const rv = C.state(p).rivals.find((r) => r.id === 'rival-kade');
  assert.equal(rv.duels.won, 1);
  assert.ok(rv.respect > 20);
  assert.equal(C.state(p).stats.duelsWon, 1);
});

test('career: withdraw refunds unraced seasons, restart wipes results', () => {
  const p = profile();
  const fee = C.getChampionship('national-touring').entryFee;
  assert.ok(fee > 0);
  const c0 = p.credits;
  C.enter(p, 'national-touring', { force: true });
  const w = C.withdraw(p, 'national-touring');
  assert.equal(w.ok, true);
  assert.equal(p.credits, c0 - fee + Math.round(fee * 0.5 / 10) * 10);
  assert.notEqual(C.state(p).championships['national-touring'].status, 'active');
  C.enter(p, 'rookie-hot-hatch', { force: true });
  C.recordResult(p, 'rookie-hot-hatch', 0, fakeResults(p, 'rookie-hot-hatch', 0, 1));
  assert.equal(C.nextRound(p, 'rookie-hot-hatch').roundIdx, 1);
  const r = C.restart(p, 'rookie-hot-hatch');
  assert.equal(r.ok, true);
  assert.equal(C.nextRound(p, 'rookie-hot-hatch').roundIdx, 0);
  assert.ok(C.standings(p, 'rookie-hot-hatch').every((x) => x.points === 0));
});

test('career: enter refuses locked, ineligible or unaffordable entries', () => {
  const p = profile();
  const locked = C.enter(p, 'national-gt4');
  assert.equal(locked.ok, false);
  const inel = C.enter(p, 'rookie-sunday-cup', { build: build(), metrics: METRICS(600, 1400) });
  assert.equal(inel.ok, false);
  assert.ok(inel.reasons.some((r) => /250 hp/.test(r)));
  const broke = profile({ credits: 0 });
  assert.equal(C.getChampionship('rookie-hot-hatch').entryFee >= 0, true);
  const poor = C.enter(broke, 'national-touring', { force: true });
  assert.equal(poor.ok, false);
  assert.ok(/fee/i.test(poor.reason));
});

test('career: state() is read-only and exposes tiers, events, rivals and goals', () => {
  const p = profile();
  delete p.career;
  const s = C.state(p);
  assert.equal(p.career, undefined, 'state() must not create career data on the profile');
  assert.equal(s.tiers.length, 5);
  assert.equal(s.tiers[0].unlocked, true);
  assert.equal(s.tiers[1].unlocked, false);
  assert.ok(s.tiers[1].lockReason.length > 0);
  assert.ok(s.events.length >= 10);
  assert.equal(s.rivals.length, C.RIVALS.length);
  assert.ok(s.nextGoal && s.nextGoal.text);
  const v = s.championships['rookie-hot-hatch'];
  assert.equal(v.status, 'available');
  assert.equal(typeof v.eligible, 'boolean');
  assert.equal(v.rounds.length, 5);
});

test('career: simulateSession + recordResult({simulate}) keeps a career moving without the race module', () => {
  const p = profile();
  C.enter(p, 'rookie-sunday-cup', { force: true });
  const sim = C.simulateSession(p, 'rookie-sunday-cup', 0);
  assert.equal(sim.simulated, true);
  assert.equal(sim.classification.filter((r) => r.isPlayer).length, 1);
  const out = C.recordResult(p, 'rookie-sunday-cup', 0, null, { simulate: true });
  assert.equal(out.ok, true);
  assert.equal(out.simulated, true);
  assert.ok(out.roundPosition >= 1);
});

test('career: commit() saves through CB.game.profile.update when present', () => {
  const P = CB.game && CB.game.profile;
  if (!P || typeof P.update !== 'function' || typeof P.get !== 'function') return;
  if (typeof P.reset === 'function') P.reset({ keepSettings: true });
  P.update((p) => { p.credits = 500000; });
  const r = C.commit('enter', 'rookie-sunday-cup', { force: true });
  assert.equal(r.ok, true);
  const p = P.get();
  assert.equal(p.career.championships['rookie-sunday-cup'].status, 'active');
  assert.equal(p.credits, 500000 - C.getChampionship('rookie-sunday-cup').entryFee);
});

/* ------------------------------------------------------------------ early-closed sessions */
test('career: a session closed early (player retired) still classifies and scores the AI still running', () => {
  const p = profile();
  C.enter(p, 'rookie-sunday-cup', { force: true });
  const r = fakeResults(p, 'rookie-sunday-cup', 0, 7);
  r.complete = false;
  r.classification.forEach((row) => { row.status = 'running'; row.totalTime_s = null; });
  const out = C.recordResult(p, 'rookie-sunday-cup', 0, r);
  assert.equal(out.ok, true);
  const me = out.pointsTable.find((x) => x.isPlayer || x.id === 'player');
  assert.equal(me.status, 'dnf', 'the retiring player is out');
  assert.equal(me.points, 0);
  const ai = out.pointsTable.filter((x) => x !== me);
  assert.ok(ai.every((x) => x.status === 'finished'), 'AI cars still circulating are classified');
  const leader = ai.find((x) => x.position === 1);
  assert.ok(leader && leader.points > 0, 'the race leader scores points');
  assert.ok(C.standings(p, 'rookie-sunday-cup').some((x) => !x.isPlayer && x.points > 0), 'standings move');
});

/* FORGE Atelier — CB.game.economy tests. Run: node tests/run.js economy */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

require('../js/util.js');
const D = require('../js/data.js');
const E = require('../js/game/economy.js');
const CB = globalThis.CB;

const prof = (level, extra) => Object.assign({ level, xp: 0, credits: 150000, unlocks: { parts: [], tracks: [], bodyStyles: [] }, stats: { races: 0 }, driverName: 'Tester' }, extra || {});
function withPricing(stub, fn) {
  const prev = CB.pricing;
  CB.pricing = stub;
  try { return fn(); } finally { if (prev === undefined) delete CB.pricing; else CB.pricing = prev; }
}
function catalogCollections() {
  const out = [];
  for (const k of Object.keys(D)) if (k !== 'presets' && Array.isArray(D[k]) && D[k][0] && D[k][0].id !== undefined) out.push(k);
  if (D.aero) for (const k of Object.keys(D.aero)) if (Array.isArray(D.aero[k])) out.push('aero.' + k);
  return out;
}
const listOf = (c) => (c.startsWith('aero.') ? D.aero[c.slice(5)] : D[c]);

/* ------------------------------------------------------------------ unlocks */
test('economy: unlock table covers every catalog collection and id', () => {
  const colls = catalogCollections();
  assert.ok(colls.length >= 20, 'catalog has collections');
  for (const c of colls) {
    const t = E.UNLOCK_TABLE[c];
    assert.ok(t, 'table for ' + c);
    for (const o of listOf(c)) {
      assert.ok(Object.prototype.hasOwnProperty.call(t, String(o.id)), c + ':' + o.id + ' missing');
      const l = E.partUnlockLevel(c, o.id);
      assert.ok(Number.isInteger(l) && l >= 1 && l <= E.MAX_LEVEL, c + ':' + o.id + ' level ' + l);
    }
    // every collection has at least one level-1 option so a rookie can always build something
    assert.ok(listOf(c).some((o) => E.partUnlockLevel(c, o.id) === 1), c + ' has an L1 option');
  }
});

test('economy: spec anchor levels (W16 L20, carbon-monocoque L15, slicks L8, quad-turbo L12)', () => {
  assert.equal(E.partUnlockLevel('engineLayouts', 'W16'), 20);
  assert.equal(E.partUnlockLevel('chassisMaterials', 'carbon-monocoque'), 15);
  assert.equal(E.partUnlockLevel('tireCompounds', 'slick'), 8);
  assert.equal(E.partUnlockLevel('aspirations', 'quad-turbo'), 12);
  assert.equal(E.partUnlockLevel('engineLayouts', 'I4'), 1);
  // build paths resolve to collections
  assert.equal(E.partUnlockLevel('engine.layout', 'W16'), 20);
  assert.equal(E.partUnlockLevel('aero.wing', 'none'), 1);
  // unknown parts fall back to a sane level
  const l = E.partUnlockLevel('nonexistent', 'zzz');
  assert.ok(l >= 1 && l <= E.MAX_LEVEL);
});

test('economy: isUnlocked respects level and explicit grants', () => {
  assert.equal(E.isUnlocked(prof(1), 'engineLayouts', 'W16'), false);
  assert.equal(E.isUnlocked(prof(20), 'engineLayouts', 'W16'), true);
  assert.equal(E.isUnlocked(prof(1, { unlocks: { parts: ['engineLayouts:W16'], tracks: [], bodyStyles: [] } }), 'engineLayouts', 'W16'), true);
  assert.equal(E.isUnlocked(prof(1, { unlocks: { parts: ['engine.layout:W16'], tracks: [], bodyStyles: [] } }), 'engine.layout', 'W16'), true);
  assert.equal(E.isUnlocked(prof(1, { unlocks: { parts: [], tracks: [], bodyStyles: ['hypercar'] } }), 'bodyStyles', 'hypercar'), true);
  // level derived from xp when level missing
  assert.equal(E.profileLevel({ xp: 0 }), 1);
  assert.ok(E.profileLevel({ xp: 1e6 }) > 20);
});

test('economy: lockedOptions returns Sets that shrink as level rises', () => {
  const l1 = E.lockedOptions(prof(1));
  assert.ok(l1.engineLayouts instanceof Set);
  assert.ok(l1.engineLayouts.has('W16'));
  assert.ok(!l1.engineLayouts.has('I4'));
  assert.ok(l1['aero.wings'].has('active'));
  const count = (m) => Object.values(m).reduce((a, s) => a + s.size, 0);
  const c1 = count(l1), c10 = count(E.lockedOptions(prof(10))), c50 = count(E.lockedOptions(prof(50)));
  assert.ok(c1 > c10 && c10 > c50, `${c1} > ${c10} > ${c50}`);
  assert.equal(c50, 0);
  const lp = E.lockedPaths(prof(1));
  assert.ok(lp['engine.layout'].has('W16'));
  assert.ok(lp['drivetrain.rearDiff'] instanceof Set);
});

test('economy: tracks unlock progressively and features gate', () => {
  assert.equal(E.isTrackUnlocked(prof(1), 'forge-speedway'), true);
  assert.equal(E.isTrackUnlocked(prof(1), 'akagane-pass'), false);
  assert.equal(E.isTrackUnlocked(prof(1, { unlocks: { parts: [], tracks: ['akagane-pass'], bodyStyles: [] } }), 'akagane-pass'), true);
  assert.ok(E.lockedTracks(prof(1)).has('akagane-pass'));
  assert.equal(E.lockedTracks(prof(50)).size, 0);
  assert.equal(E.isFeatureUnlocked(prof(1), 'aero.activeAero'), false);
  assert.equal(E.isFeatureUnlocked(prof(15), 'aero.activeAero'), true);
  assert.ok('aero.activeAero' in E.lockedFeatures(prof(1)));
});

test('economy: clampBuildToUnlocks yields a violation-free build at L1', () => {
  const b = D.defaultBuild();
  b.engine.layout = 'W16'; b.engine.aspiration = 'quad-turbo'; b.tires.compound = 'slick'; b.aero.activeAero = true;
  const before = E.buildLockViolations(prof(1), b);
  assert.ok(before.length >= 4);
  assert.equal(before[0].level >= before[before.length - 1].level, true, 'sorted by level desc');
  const { build, changes } = E.clampBuildToUnlocks(prof(1), b);
  assert.ok(changes.length >= 4);
  assert.deepEqual(E.buildLockViolations(prof(1), build), []);
  assert.equal(build.aero.activeAero, false);
  assert.equal(b.engine.layout, 'W16', 'input not mutated');
  // L50: nothing to change
  assert.equal(E.buildLockViolations(prof(50), b).length, 0);
});

test('economy: unlock browsing helpers', () => {
  const at20 = E.unlocksAtLevel(20);
  assert.ok(at20.some((e) => e.collection === 'engineLayouts' && e.id === 'W16'));
  const next = E.nextUnlocks(prof(1), 5);
  assert.equal(next.length, 5);
  assert.ok(next.every((e) => e.level > 1));
  assert.ok(next[0].level <= next[4].level);
  const pr = E.unlockProgress(prof(1));
  assert.ok(pr.unlocked > 0 && pr.unlocked < pr.total && pr.pct > 0 && pr.pct < 1);
  assert.equal(E.unlockProgress(prof(50)).pct, 1);
  const lr = E.levelRewards(10);
  assert.ok(lr.credits > E.levelRewards(9).credits && lr.milestone);
});

/* ------------------------------------------------------------------ pricing */
test('economy: carCost uses CB.pricing total × 0.35 and falls back to estimate', () => {
  const b = D.defaultBuild();
  withPricing({ compute: () => ({ total: 200000, subtotal: 190000 }) }, () => {
    assert.equal(E.carCost(b), 70000);
    assert.equal(E.carQuote(b).source, 'pricing');
  });
  withPricing({ compute: () => { throw new Error('boom'); } }, () => {
    assert.equal(E.carQuote(b).source, 'estimate');
  });
  withPricing(undefined, () => {
    const est = E.estimateMsrp(b);
    assert.ok(est > 20000 && est < 2e6, 'estimate ' + est);
    assert.equal(E.carCost(b), Math.round(est * 0.35 / 100) * 100);
    // pricier specs cost more
    const hyper = D.defaultBuild(); hyper.body.style = 'hypercar'; hyper.engine.layout = 'W16'; hyper.body.chassisMaterial = 'carbon-monocoque';
    assert.ok(E.carCost(hyper) > E.carCost(b));
  });
});

test('economy: upgradeCost charges new parts, refunds 50% of removed parts', () => {
  withPricing(undefined, () => {
    const a = D.defaultBuild();
    assert.equal(E.upgradeCost(a, U(a)), 0);
    const b = U(a); b.brakes.material = 'carbon-ceramic';
    const q = E.upgradeQuote(a, b);
    const cc = D.find('brakeMaterials', 'carbon-ceramic').price, iron = D.find('brakeMaterials', a.brakes.material).price;
    const line = q.lines.find((l) => l.path === 'brakes.material');
    assert.equal(line.cost, Math.round(cc * 0.35));
    assert.equal(line.refund, Math.round(iron * 0.35 * 0.5));
    assert.ok(q.total > 0);
    // downgrading back nets a refund smaller than what was paid
    const back = E.upgradeCost(b, a);
    assert.ok(back < q.total);
    assert.ok(q.total + back > 0, 'round trip is never profitable');
    // meta changes are free
    const c = U(a); c.meta.name = 'Renamed';
    assert.equal(E.upgradeCost(a, c), 0);
  });
});
function U(b) { return JSON.parse(JSON.stringify(b)); }

test('economy: sellValue depreciates by odometer and condition; repairCost scales with wear', () => {
  const base = { purchasedFor: 100000, odometer_km: 0, condition: 1, wins: 0 };
  const fresh = E.sellValue(base);
  assert.ok(fresh > 0 && fresh < 100000);
  assert.ok(E.sellValue(Object.assign({}, base, { odometer_km: 30000 })) < fresh);
  assert.ok(E.sellValue(Object.assign({}, base, { condition: 0.5 })) < fresh);
  assert.ok(E.sellValue(Object.assign({}, base, { wins: 10 })) > fresh, 'race pedigree adds value');
  assert.equal(E.repairCost(base), 0);
  const r50 = E.repairCost(Object.assign({}, base, { condition: 0.5 }));
  const r20 = E.repairCost(Object.assign({}, base, { condition: 0.2 }));
  assert.ok(r50 > 0 && r20 > r50);
  const dmg = E.repairCost(Object.assign({}, base, { condition: 0.5, damage: { engine: 0.8 } }));
  assert.ok(dmg > r50);
  // partial repair is cheaper than full
  assert.ok(E.repairCost(Object.assign({}, base, { condition: 0.5 }), 0.75) < r50);
  const sq = E.sellQuote(base);
  assert.ok(Array.isArray(sq.lines) && sq.lines.length >= 3);
  assert.equal(E.formatCredits(12500), 'CR 12,500');
});

test('economy: entry fee and pit service costs', () => {
  assert.equal(E.entryFee({ tier: 0 }), 0);
  assert.ok(E.entryFee({ tier: 4, difficulty: 'alien' }) > E.entryFee({ tier: 2 }));
  const b = D.defaultBuild();
  const pit = E.pitServiceCost({ tires: true, fuel_l: 40, repair: true }, b);
  assert.equal(pit.lines.length, 3);
  assert.ok(pit.credits > 0);
});

/* ------------------------------------------------------------------ race rewards */
const sum = (r, k) => r.breakdown.reduce((a, l) => a + l[k], 0);

test('economy: raceRewards is monotonic in position and sums its breakdown', () => {
  let prev = Infinity;
  for (let p = 1; p <= 12; p++) {
    const r = E.raceRewards({ position: p, fieldSize: 12, difficulty: 'amateur', laps: 5, trackId: 'forge-ring' });
    assert.ok(r.credits <= prev, 'pos ' + p);
    assert.ok(r.credits > 0 && r.xp > 0);
    assert.ok(Math.abs(sum(r, 'credits') - r.credits) <= 5);
    prev = r.credits;
  }
});

test('economy: raceRewards bonuses and difficulty multiplier', () => {
  const plain = E.raceRewards({ position: 1, fieldSize: 10, difficulty: 'amateur', laps: 5 });
  const full = E.raceRewards({ position: 1, fieldSize: 10, difficulty: 'amateur', laps: 5, cleanRace: true, fastestLap: true, pole: true, overtakes: 4, lapsLed: 5, gridPosition: 6 });
  const labels = full.breakdown.map((l) => l.label).join('|');
  for (const k of ['Victory', 'Clean race', 'Fastest lap', 'Pole', 'Overtakes', 'Laps led', 'Led every lap', 'Positions gained']) assert.ok(labels.includes(k), k);
  assert.ok(full.credits > plain.credits && full.xp > plain.xp);
  const pro = E.raceRewards({ position: 1, fieldSize: 10, difficulty: 'pro', laps: 5 });
  const rookie = E.raceRewards({ position: 1, fieldSize: 10, difficulty: 'rookie', laps: 5 });
  assert.ok(pro.credits > plain.credits && plain.credits > rookie.credits);
  assert.ok(pro.breakdown.some((l) => l.kind === 'multiplier'));
  // bigger fields & longer races pay more
  assert.ok(E.raceRewards({ position: 1, fieldSize: 16, laps: 5 }).credits > E.raceRewards({ position: 1, fieldSize: 4, laps: 5 }).credits);
  assert.ok(E.raceRewards({ position: 1, fieldSize: 8, laps: 10 }).credits > E.raceRewards({ position: 1, fieldSize: 8, laps: 2 }).credits);
  // dnf small, penalties subtract, event multiplier applies
  const dnf = E.raceRewards({ position: 8, fieldSize: 8, laps: 5, dnf: true });
  assert.ok(dnf.credits < E.raceRewards({ position: 8, fieldSize: 8, laps: 5 }).credits);
  assert.ok(E.raceRewards({ position: 1, fieldSize: 8, laps: 5, penalties_s: 10 }).credits < E.raceRewards({ position: 1, fieldSize: 8, laps: 5 }).credits);
  const x2 = E.raceRewards({ position: 1, fieldSize: 8, laps: 5, multiplier: 2 });
  assert.ok(Math.abs(x2.credits - 2 * E.raceRewards({ position: 1, fieldSize: 8, laps: 5 }).credits) <= 20);
  // comeback
  assert.ok(E.raceRewards({ position: 1, fieldSize: 8, laps: 5, gridPosition: 8 }).breakdown.some((l) => /Comeback/.test(l.label)));
  // garbage input does not throw
  const g = E.raceRewards({});
  assert.ok(isFinite(g.credits) && g.credits >= 0);
  assert.ok(isFinite(E.raceRewards().credits));
});

test('economy: outcomeFromResults understands engine results() shape', () => {
  const results = {
    mode: 'race', trackId: 'forge-ring', trackLength_m: 5800, lapsTotal: 4, playerId: 'player',
    fastestLap: { carId: 'player', time: 90 },
    classification: [
      { position: 1, id: 'player', isPlayer: true, status: 'finished', gridPosition: 5, positionsByLap: [3, 1, 1, 1], collisions: 0, penalties_s: 0, bestLap_s: 90 },
      { position: 2, id: 'ai1', status: 'finished', gridPosition: 1, positionsByLap: [1, 2, 2, 2], collisions: 1, penalties_s: 0, bestLap_s: 91 },
      { position: 3, id: 'ai2', status: 'dnf', gridPosition: 2, positionsByLap: [2, 3], collisions: 2, penalties_s: 0, bestLap_s: 92 }
    ]
  };
  results.player = results.classification[0];
  const o = E.outcomeFromResults(results, { difficulty: 'pro' });
  assert.equal(o.position, 1);
  assert.equal(o.fieldSize, 3);
  assert.equal(o.laps, 4);
  assert.equal(o.lapsLed, 3);
  assert.equal(o.overtakes, 4); // 5 -> 3 -> 1
  assert.equal(o.fastestLap, true);
  assert.equal(o.cleanRace, true);
  assert.equal(o.pole, false);
  assert.equal(o.dnf, false);
  assert.equal(o.trackLength_m, 5800);
  const r = E.rewardsFromResults(results, { difficulty: 'pro' });
  assert.ok(r.credits > 0 && r.summary.distance_km === 23.2);
  // dnf via status
  const o2 = E.outcomeFromResults(results, { playerId: 'ai2' });
  assert.equal(o2.dnf, true);
  assert.equal(o2.cleanRace, false);
});

/* ------------------------------------------------------------------ sponsors */
test('economy: sponsor catalog has 3-5 sponsors with objectives', () => {
  assert.ok(E.SPONSORS.length >= 3 && E.SPONSORS.length <= 5);
  for (const s of E.SPONSORS) {
    assert.ok(s.id && s.name && s.icon.startsWith('<svg'));
    assert.ok(s.pool.length >= 3);
    for (const p of s.pool) assert.ok(E.OBJECTIVE_TYPES[p[0]], p[0]);
    assert.equal(E.getSponsor(s.id), s);
  }
});

test('economy: getSponsorOffers is deterministic and level-gated', () => {
  const p = prof(1);
  const a = E.getSponsorOffers(p), b = E.getSponsorOffers(p);
  assert.deepEqual(a, b);
  assert.ok(a.length >= 1);
  for (const o of a) {
    const s = E.getSponsor(o.sponsorId);
    assert.ok(s.minLevel <= 1);
    assert.ok(o.objectives.length >= 2 && o.signingBonus > 0 && o.races >= 3 && o.estimatedValue > 0);
    assert.equal(o.available, true);
  }
  const hi = E.getSponsorOffers(prof(20), { count: 5 });
  assert.equal(hi.length, 5);
  assert.ok(hi.find((o) => o.sponsorId === 'kestrel'));
  // higher level → richer contracts for the same sponsor
  const v1 = a.find((o) => o.sponsorId === 'vantor'), v20 = hi.find((o) => o.sponsorId === 'vantor');
  if (v1 && v20) assert.ok(v20.signingBonus > v1.signingBonus);
  // active sponsors are excluded and slots respected
  const c = E.createContract(a[0], 1000);
  const busy = prof(1, { sponsors: { active: [c] } });
  const offers = E.getSponsorOffers(busy);
  assert.ok(!offers.some((o) => o.sponsorId === c.sponsorId));
  assert.ok(offers.every((o) => o.available === false), 'L1 has a single slot');
  assert.equal(E.activeContracts(busy).length, 1);
  assert.equal(E.maxActiveContracts(1), 1);
  assert.equal(E.maxActiveContracts(12), 3);
});

function vantorContract() {
  const offer = E.getSponsorOffers(prof(5), { count: 5 }).find((o) => o.sponsorId === 'vantor');
  assert.ok(offer, 'vantor offered');
  return E.createContract(offer, 12345);
}
const win = { position: 1, fieldSize: 8, difficulty: 'amateur', cleanRace: true, overtakes: 5, lapsLed: 3, gridPosition: 4, fastestLap: true, pole: false, dnf: false, engineType: 'ice' };

test('economy: evaluateSponsor pays retainer + objectives and completes the contract', () => {
  let c = vantorContract();
  assert.equal(c.status, 'active');
  let total = 0, last;
  for (let i = 0; i < c.races; i++) {
    last = E.evaluateSponsor(c, win);
    assert.ok(last.eligible);
    assert.ok(last.breakdown.some((l) => l.kind === 'retainer'));
    total += last.credits;
    c = last.contract;
  }
  assert.equal(last.status, 'completed');
  assert.equal(last.completed, true);
  assert.ok(last.breakdown.some((l) => l.kind === 'completion'));
  assert.equal(c.earned.credits, total);
  // further evaluation is a no-op
  const again = E.evaluateSponsor(c, win);
  assert.equal(again.credits, 0);
  const sum = E.contractSummary(c);
  assert.equal(sum.racesLeft, 0);
  assert.ok(sum.objectives.length >= 2);
});

test('economy: sponsor contract terminates on too many DNFs and expires when goals unmet', () => {
  let c = vantorContract();
  const dnf = Object.assign({}, win, { dnf: true, position: 8, cleanRace: false, lapsLed: 0, overtakes: 0 });
  let r;
  for (let i = 0; i <= c.maxDnfs && c.status === 'active'; i++) { r = E.evaluateSponsor(c, dnf); c = r.contract; }
  assert.ok(['terminated', 'expired'].includes(c.status));
  if (c.maxDnfs + 1 < vantorContract().races) assert.equal(c.status, 'terminated');
  // poor results (no DNF) → expired when cumulative goals unmet
  let d = vantorContract();
  const meh = Object.assign({}, win, { position: 8, cleanRace: false, lapsLed: 0, overtakes: 0, fastestLap: false });
  for (let i = 0; i < d.races; i++) { r = E.evaluateSponsor(d, meh); d = r.contract; }
  assert.equal(d.status, 'expired');
});

test('economy: sponsor requirements (EV-only, difficulty) gate eligibility', () => {
  const ev = E.getSponsorOffers(prof(10), { count: 5 }).find((o) => o.sponsorId === 'aurora');
  assert.ok(ev);
  const c = E.createContract(ev, 1);
  const ice = E.evaluateSponsor(c, win);
  assert.equal(ice.eligible, false);
  assert.equal(ice.credits, 0);
  const evRes = E.evaluateSponsor(c, Object.assign({}, win, { engineType: 'ev' }));
  assert.equal(evRes.eligible, true);
  const hy = E.evaluateSponsor(c, Object.assign({}, win, { engineType: 'hybrid' }));
  assert.ok(hy.credits < evRes.credits, 'hybrids earn less');
  const k = E.createContract(E.getSponsorOffers(prof(20), { count: 5 }).find((o) => o.sponsorId === 'kestrel'), 1);
  assert.equal(E.evaluateSponsor(k, win).eligible, false);
  assert.equal(E.evaluateSponsor(k, Object.assign({}, win, { difficulty: 'pro' })).eligible, true);
  // batch evaluation
  const both = E.evaluateSponsors([c, k], Object.assign({}, win, { engineType: 'ev', difficulty: 'alien' }));
  assert.equal(both.contracts.length, 2);
  assert.ok(both.credits > 0);
});

test('economy: a race closed before the flag pays the player as a DNF (matches profile/career classification)', () => {
  const results = { complete: false, mode: 'race', fieldSize: 4, trackId: 'forge-ring', laps: 3, cars: [
    { id: 'a', position: 1, status: 'running' }, { id: 'p', isPlayer: true, position: 2, status: 'running', gridPosition: 4 },
    { id: 'b', position: 3, status: 'running' }, { id: 'c', position: 4, status: 'running' }] };
  const o = E.outcomeFromResults(results, {});
  assert.equal(o.dnf, true);
  const r = E.rewardsFromResults(results, {});
  assert.match(r.breakdown[0].label, /DNF/);
  const done = E.outcomeFromResults(Object.assign({}, results, { complete: true }), {});
  assert.equal(done.dnf, false, 'a completed session is a finish');
  const tt = E.outcomeFromResults(Object.assign({}, results, { mode: 'time-trial' }), {});
  assert.equal(tt.dnf, false, 'only race sessions count an early close as a DNF');
});

test('economy: levelForXp uses the cumulative curve and agrees with the profile module', () => {
  const prev = CB.game.profile;
  try {
    delete CB.game.profile; // exercise the local fallback curve
    assert.equal(E.levelForXp(0), 1);
    assert.equal(E.levelForXp(999), 1);
    assert.equal(E.levelForXp(1000), 2, 'L2 needs xpForLevel(1) = 1000 total');
    assert.equal(E.profileLevel({ xp: 100000 }), 8);
    assert.equal(E.profileLevel({ xp: 773000 }), 19);
    assert.equal(E.isUnlocked({ xp: 100000 }, 'engine.aspiration', 'quad-turbo'), false, 'quad-turbo is L12');
    if (prev) CB.game.profile = prev; else require('../js/game/profile.js');
    const P = CB.game.profile;
    for (const xp of [0, 999, 1000, 5000, 100000, 773000, 1e6, 5e6]) {
      assert.equal(E.levelForXp(xp), Math.min(E.MAX_LEVEL, P.levelForXp(xp)), 'xp ' + xp);
    }
  } finally { if (prev) CB.game.profile = prev; }
});

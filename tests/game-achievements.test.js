/* FORGE Atelier — achievements tests (CB.game.achievements). Run: node tests/run.js achievements */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

const path = require('path');
const root = path.join(__dirname, '..');
const tryReq = (p) => { try { return require(path.join(root, p)); } catch (e) { return null; } };
tryReq('js/util.js');
tryReq('js/data.js');
const PM = tryReq('js/game/profile.js');
tryReq('js/game/economy.js');
const A = require(path.join(root, 'js/game/achievements.js'));
const CB = globalThis.CB;

const NOW = Date.UTC(2026, 5, 15, 14, 0, 0); // mid-afternoon: never trips the night-shift secret
const opts = (o) => Object.assign({ toast: false, persist: false, now: NOW }, o || {});
const fresh = (extra) => Object.assign({ credits: 150000, xp: 0, level: 1, achievements: {}, stats: {}, ownedCars: [] }, extra || {});
const ids = (list) => list.map((a) => a.id);
const baseBuild = () => (CB.data && CB.data.defaultBuild ? CB.data.defaultBuild() : {
  meta: { presetId: null }, body: { style: 'coupe', seats: 4 }, engine: { type: 'ice', layout: 'V8', fuel: 'premium', redline_rpm: 7500, tune: 'stock', exhaust: 'sport' },
  drivetrain: { layout: 'rwd', tractionControl: 2 }, brakes: { abs: 'sport', material: 'iron' }, tires: { compound: 'performance' }, transmission: { type: 'dct' },
  exterior: { finish: 'metallic', stripe: 'none', badge: 'chrome', lights: 'led' }, interior: { seatType: 'sport', trim: 'aluminum' }, weight: { rollCage: 'none' }
});
const metrics = (o) => Object.assign({ power_hp: 400, weight_kg: 1500, zeroTo60_s: 4.5, topSpeed_kph: 290, downforce_kg_200: 40, lateralG: 1.0, ratings: { track: 60 } }, o || {});
const buildEv = (mods, m, price) => {
  const b = baseBuild();
  if (mods) mods(b);
  return { type: 'build-changed', build: b, metrics: metrics(m), price: price === undefined ? 120000 : price };
};

/* Engine-shaped results (js/race/engine.js results()). */
function raceResults(o) {
  o = o || {};
  const n = o.field || 8;
  const pos = o.position || 1;
  const grid = o.grid || pos;
  const laps = o.laps || 5;
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const isPlayer = i === pos;
    rows.push({
      position: i, id: isPlayer ? 'player' : 'ai' + i, name: isPlayer ? 'You' : 'AI ' + i, isPlayer,
      status: isPlayer && o.dnf ? 'dnf' : 'finished', laps, totalTime_s: 300 + i * (o.gap || 2), penalties_s: isPlayer ? (o.penalties || 0) : 0,
      bestLap_s: isPlayer && o.fastestLap ? 50 : 52 + i, collisions: isPlayer ? (o.collisions || 0) : 0, trackLimits: isPlayer ? (o.trackLimits || 0) : 0,
      gridPosition: isPlayer ? grid : (i === grid ? pos : i), topSpeed_kph: isPlayer ? (o.topSpeed || 250) : 240,
      positionsByLap: isPlayer ? (o.pbl || Array(laps).fill(pos)) : [], fastestLap: isPlayer && !!o.fastestLap, dnfReason: isPlayer && o.dnf ? 'retired' : null
    });
  }
  rows.sort((a, b) => (a.status === 'dnf') - (b.status === 'dnf') || a.position - b.position);
  return {
    mode: o.mode || 'race', trackId: o.trackId || 'forge-ring', trackLength_m: o.trackLength || 5000, lapsTotal: laps,
    weather: o.weather || 'dry', timeOfDay: o.timeOfDay || 'day', complete: true,
    fastestLap: o.fastestLap ? { carId: 'player', time: 50 } : { carId: 'ai2', time: 54 },
    classification: rows, player: rows.filter((r) => r.isPlayer)[0], playerId: 'player', events: []
  };
}
const raceEv = (o, cfg) => ({ type: 'race-finished', results: raceResults(o), config: Object.assign({ mode: (o && o.mode) || 'race', laps: (o && o.laps) || 5, difficulty: (o && o.difficulty) || 'amateur' }, cfg || {}) });

/* ------------------------------------------------------------------ catalogue */

test('achievements: 60+ definitions with unique ids, valid tiers, rewards and categories', () => {
  assert.ok(A.list.length >= 60, 'only ' + A.list.length);
  const seen = new Set();
  const cats = new Set(A.categories.map((c) => c.id));
  A.list.forEach((a) => {
    assert.ok(!seen.has(a.id), 'duplicate ' + a.id); seen.add(a.id);
    assert.match(a.id, /^[a-z0-9-]+$/);
    assert.ok(['bronze', 'silver', 'gold', 'platinum'].includes(a.tier), a.id + ' tier');
    assert.ok(typeof a.name === 'string' && a.name.length > 1, a.id + ' name');
    assert.ok(typeof a.desc === 'string' && a.desc.length > 5, a.id + ' desc');
    assert.ok(Number.isFinite(a.xp) && a.xp > 0, a.id + ' xp');
    assert.ok(Number.isFinite(a.credits) && a.credits >= 0, a.id + ' credits');
    assert.ok(cats.has(a.category), a.id + ' category ' + a.category);
  });
  ['configurator-ish:atelier', 'racing', 'career', 'drift', 'endurance', 'challenges', 'garage', 'media', 'meta'].forEach((c) => {
    const id = c.split(':').pop();
    assert.ok(A.list.some((a) => a.category === id), 'no achievements in ' + id);
  });
  ['bespoke', 'featherweight', 'thousand-horses', 'silent-running', 'first-win', 'grand-slam', 'clean-sweep', 'comeback', 'ton-up']
    .forEach((id) => assert.ok(A.get(id), 'spec achievement missing: ' + id));
  const tiers = new Set(A.list.map((a) => a.tier));
  assert.equal(tiers.size, 4);
  assert.ok(A.list.filter((a) => a.hidden).length >= 5, 'hidden achievements');
  A.list.filter((a) => a.hidden).forEach((a) => assert.ok(a.hint, a.id + ' hidden without hint'));
});

test('achievements: rewards scale with tier', () => {
  const avg = (t) => { const l = A.list.filter((a) => a.tier === t); return l.reduce((s, a) => s + a.xp, 0) / l.length; };
  assert.ok(avg('bronze') < avg('silver') && avg('silver') < avg('gold') && avg('gold') < avg('platinum'));
});

test('icons: every achievement has a well-formed inline SVG; locked + hidden variants render', () => {
  A.list.forEach((a) => {
    assert.match(a.icon, /^<svg[^>]+viewBox="0 0 64 64"/, a.id);
    assert.ok(a.icon.endsWith('</svg>'), a.id);
    assert.equal((a.icon.match(/<svg/g) || []).length, (a.icon.match(/<\/svg>/g) || []).length, a.id + ' svg nesting');
    assert.ok(!/NaN|undefined/.test(a.icon), a.id + ' icon contains NaN/undefined');
    assert.ok(a.icon.includes('gach-icon--' + a.tier), a.id + ' tier class');
  });
  A.glyphs.forEach((g) => {
    ['bronze', 'silver', 'gold', 'platinum', 'locked'].forEach((t) => {
      const s = A.icon(g, t, { label: 'X' });
      assert.ok(!/NaN|undefined/.test(s), g + '/' + t);
    });
  });
  const hid = A.icon('trophy', 'locked', { hidden: true });
  assert.ok(hid.includes('gach-icon--locked'));
  // distinct frames per tier
  const shapes = ['bronze', 'silver', 'gold', 'platinum'].map((t) => A.icon('star', t).replace(/id="[^"]+"|url\(#[^)]+\)|gach-icon--\w+/g, ''));
  assert.equal(new Set(shapes).size, 4);
});

/* ------------------------------------------------------------------ build events */

test('build-changed: spec configurator achievements unlock from metrics and price', () => {
  const P = fresh();
  let got = ids(A.check(P, buildEv((b) => { b.engine.type = 'ev'; }, { power_hp: 1050, weight_kg: 880 }, 650000), opts()));
  ['first-commission', 'bespoke', 'featherweight', 'thousand-horses', 'silent-running', 'half-thousand', 'power-density'].forEach((id) => assert.ok(got.includes(id), id + ' not in ' + got));
  assert.ok(!got.includes('seven-figures'));
  assert.ok(!got.includes('two-thousand'));
  assert.ok(P.achievements.bespoke.unlockedAt === NOW);
  // never unlock twice
  got = ids(A.check(P, buildEv((b) => { b.engine.type = 'ev'; }, { power_hp: 1050, weight_kg: 880 }, 650000), opts()));
  assert.ok(!got.includes('bespoke') && !got.includes('featherweight'));
});

test('build-changed: part-specific builds (W16, rotary, sleeper, homologation, no-nannies)', () => {
  const P = fresh();
  const got = new Set();
  const add = (ev) => ids(A.check(P, ev, opts())).forEach((i) => got.add(i));
  add(buildEv((b) => { b.engine.layout = 'W16'; }));
  add(buildEv((b) => { b.engine.layout = 'rotary-2'; }));
  add(buildEv((b) => { b.body.style = 'wagon'; b.exterior.stripe = 'none'; b.exterior.badge = 'delete'; b.exterior.livery_number = ''; }, { power_hp: 760 }));
  add(buildEv((b) => { b.tires.compound = 'slick'; b.weight.rollCage = 'full'; b.interior.seatType = 'race-shell'; b.interior.harness = true; }));
  add(buildEv((b) => { b.drivetrain.tractionControl = 0; b.brakes.abs = 'off'; }));
  ['sixteen', 'brap-brap', 'sleeper', 'homologation', 'no-nannies'].forEach((id) => assert.ok(got.has(id), id));
  // W16 on an EV build doesn't count
  const Q = fresh();
  assert.ok(!ids(A.check(Q, buildEv((b) => { b.engine.type = 'ev'; b.engine.layout = 'W16'; }), opts())).includes('sixteen'));
});

test('build-changed: price falls back to catalogue estimate when not supplied', () => {
  const b = baseBuild();
  const n = A._internal.normalizeBuild({ build: b, metrics: metrics() });
  if (CB.data && CB.data.find) assert.ok(n.price > 10000 && n.price < 2e6, 'estimate ' + n.price);
  else assert.ok(Number.isNaN(n.price) || n.price >= 0);
});

test('collections: body styles + presets tracked with progress', () => {
  const P = fresh();
  ['coupe', 'sedan', 'suv', 'coupe'].forEach((s) => A.check(P, buildEv((b) => { b.body.style = s; }), opts()));
  const pr = A.progress(P, 'body-collector');
  assert.equal(pr.cur, 3);
  assert.equal(pr.max, 10);
  assert.ok(pr.pct > 0.29 && pr.pct < 0.31);
  const all = (CB.data && CB.data.bodyStyles ? CB.data.bodyStyles.map((x) => x.id) : ['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van']);
  let unlockedNow = [];
  all.forEach((s) => { unlockedNow = unlockedNow.concat(ids(A.check(P, buildEv((b) => { b.body.style = s; }), opts()))); });
  assert.ok(unlockedNow.includes('body-collector'));
  assert.ok(A.progress(P, 'body-collector').unlocked);
});

test('tinkerer counter counts build events', () => {
  const P = fresh();
  for (let i = 0; i < 99; i++) A.check(P, buildEv(), opts());
  assert.equal(A.progress(P, 'tinkerer').cur, 99);
  assert.ok(!A.isUnlocked(P, 'tinkerer'));
  assert.ok(ids(A.check(P, buildEv(), opts())).includes('tinkerer'));
});

/* ------------------------------------------------------------------ race events */

test('race-finished: first win, podium, finish, pole from engine classification', () => {
  const P = fresh();
  const got = ids(A.check(P, raceEv({ position: 1, grid: 1, field: 8 }), opts()));
  ['lights-out', 'first-win', 'champagne', 'pole-sitter'].forEach((id) => assert.ok(got.includes(id), id + ' in ' + got));
  assert.ok(!got.includes('comeback'));
});

test('race-finished: Grand Slam needs pole + win + fastest lap + led every lap', () => {
  let P = fresh();
  let got = ids(A.check(P, raceEv({ position: 1, grid: 1, fastestLap: true, laps: 5, pbl: [1, 1, 1, 1, 1] }), opts()));
  assert.ok(got.includes('grand-slam'), got);
  assert.ok(got.includes('fastest-lap'));
  P = fresh();
  got = ids(A.check(P, raceEv({ position: 1, grid: 1, fastestLap: true, laps: 5, pbl: [2, 1, 1, 1, 1] }), opts()));
  assert.ok(!got.includes('grand-slam'), 'lost the lead on lap 1');
  P = fresh();
  got = ids(A.check(P, raceEv({ position: 1, grid: 2, fastestLap: true, laps: 5, pbl: [1, 1, 1, 1, 1] }), opts()));
  assert.ok(!got.includes('grand-slam'), 'no pole');
});

test('race-finished: Clean Sweep, Comeback, Ton-Up, Through the Field', () => {
  const P = fresh();
  let got = ids(A.check(P, raceEv({ position: 1, grid: 10, field: 10, topSpeed: 405 }), opts()));
  ['clean-sweep', 'comeback', 'ton-up', 'three-hundred', 'charge'].forEach((id) => assert.ok(got.includes(id), id + ' in ' + got));
  const Q = fresh();
  got = ids(A.check(Q, raceEv({ position: 1, grid: 1, field: 10, collisions: 2 }), opts()));
  assert.ok(!got.includes('clean-sweep'), 'contact disqualifies clean sweep');
  const R = fresh();
  got = ids(A.check(R, raceEv({ position: 1, grid: 1, field: 10, trackLimits: 1 }), opts()));
  assert.ok(!got.includes('clean-sweep'), 'track limits disqualify clean sweep');
});

test('race-finished: DNF unlocks the secret and nothing finish-related', () => {
  const P = fresh();
  const got = ids(A.check(P, raceEv({ position: 3, dnf: true, field: 6 }), opts()));
  assert.ok(got.includes('smoke-mirrors'));
  assert.ok(!got.includes('lights-out') && !got.includes('first-win') && !got.includes('champagne'));
});

test('race-finished: classification row still running (quit early) is not a finish', () => {
  const ev = raceEv({ position: 1 });
  ev.results.classification.forEach((r) => { r.status = 'running'; });
  ev.results.complete = false;
  const r = A._internal.normalizeRace(ev);
  assert.equal(r.finished, false);
  assert.equal(r.won, false);
});

test('race-finished: margin, difficulty, weather, night and EV conditions', () => {
  const P = fresh();
  const ev = raceEv({ position: 1, field: 6, gap: 12, weather: 'wet', timeOfDay: 'night', difficulty: 'alien' }, { playerBuild: { engine: { type: 'ev' } } });
  const got = ids(A.check(P, ev, opts()));
  ['dominant', 'pro-licence', 'alien-slayer', 'rain-master', 'night-owl', 'silent-assassin'].forEach((id) => assert.ok(got.includes(id), id + ' in ' + got));
  const Q = fresh();
  const close = ids(A.check(Q, raceEv({ position: 1, field: 4, gap: 0.05 }), opts()));
  assert.ok(close.includes('photo-finish'));
  assert.ok(!close.includes('dominant'));
});

test('race-finished: time trial lap does not count as a win', () => {
  const P = fresh();
  const got = ids(A.check(P, raceEv({ mode: 'time-trial', position: 1, field: 1 }), opts()));
  assert.ok(got.includes('hot-lapper'));
  assert.ok(!got.includes('first-win'));
});

test('streaks: hat-trick tracks consecutive wins and resets on a loss', () => {
  const P = fresh();
  A.check(P, raceEv({ position: 1 }), opts());
  A.check(P, raceEv({ position: 1 }), opts());
  assert.equal(A.progress(P, 'hat-trick').cur, 2);
  A.check(P, raceEv({ position: 4 }), opts());
  A.check(P, raceEv({ position: 1 }), opts());
  assert.ok(!A.isUnlocked(P, 'hat-trick'));
  A.check(P, raceEv({ position: 1 }), opts());
  assert.ok(ids(A.check(P, raceEv({ position: 1 }), opts())).includes('hat-trick'));
});

test('counters: race tallies and profile stats (max of both) drive milestones', () => {
  const P = fresh({ stats: { races: 24, wins: 9 } });
  const got = ids(A.check(P, raceEv({ position: 1 }), opts()));
  // tally only counts this event (1) but profile stats say 24 → still 24 < 25; stat events bump it
  assert.ok(!got.includes('veteran'));
  const got2 = ids(A.check(P, { type: 'stat', stats: { races: 25, wins: 10 } }, opts()));
  assert.ok(got2.includes('veteran') && got2.includes('serial-winner'), got2);
  // stat events never decrease
  A.check(P, { type: 'stat', key: 'races', value: 3 }, opts());
  assert.equal(P.stats.races, 25);
});

test('distance: derived from track length × laps completed', () => {
  const r = A._internal.normalizeRace(raceEv({ laps: 10, trackLength: 5000 }));
  assert.equal(Math.round(r.distance), 50);
  const P = fresh();
  for (let i = 0; i < 19; i++) A.check(P, raceEv({ laps: 10, trackLength: 5000, position: 5 }), opts());
  assert.equal(Math.round(A.progress(P, 'road-trip').cur), 950);
  assert.ok(ids(A.check(P, raceEv({ laps: 10, trackLength: 5000, position: 5 }), opts())).includes('road-trip'));
});

test('world tour: every circuit (filtered to real circuits when the track registry exists)', () => {
  const P = fresh();
  const tracks = A._internal.trackList();
  assert.ok(tracks.length >= 1);
  let got = [];
  tracks.forEach((t) => { got = got.concat(ids(A.check(P, raceEv({ trackId: t, position: 2 }), opts()))); });
  assert.ok(got.includes('world-tour'), got);
  assert.ok(!got.includes('conqueror'));
});

/* ------------------------------------------------------------------ career / drift / endurance / challenges */

test('career: rounds, championships per tier, perfect season, rivals', () => {
  const P = fresh();
  let got = ids(A.check(P, { type: 'career', action: 'round-complete', champId: 'rookie-cup', position: 1, pointsTable: [] }, opts()));
  assert.ok(got.includes('sign-contract') && got.includes('round-winner'));
  got = ids(A.check(P, { type: 'career', action: 'championship-complete', champId: 'rookie-cup', tierId: 'rookie', position: 1, wins: 4, rounds: 4 }, opts()));
  ['champion', 'rookie-champion', 'perfect-season'].forEach((id) => assert.ok(got.includes(id), id + ' in ' + got));
  got = ids(A.check(P, { type: 'career', action: 'championship-complete', champId: 'gt-sprint', tierIndex: 1, position: 2 }, opts()));
  assert.ok(got.includes('runner-up') && !got.includes('national-champion'));
  got = ids(A.check(P, { type: 'career', action: 'rival-defeated', rivalId: 'vex' }, opts()));
  assert.ok(got.includes('nemesis'));
  A.check(P, { type: 'career', action: 'rival-defeated', rivalId: 'vex' }, opts());
  assert.equal(A.progress(P, 'rivalry').cur, 1, 'same rival counted once');
  got = ids(A.check(P, { type: 'career', action: 'event-complete', eventType: 'drag', position: 1 }, opts()));
  assert.ok(got.includes('drag-king'));
});

test('career: grand champion across all five tiers', () => {
  const P = fresh();
  let got = [];
  ['rookie', 'national', 'continental', 'world', 'hypercar'].forEach((t, i) => {
    got = got.concat(ids(A.check(P, { type: 'career', action: 'championship-complete', champId: t + '-1', tierIndex: i, position: 1 }, opts())));
  });
  ['grand-champion', 'hypercar-master', 'endurance-champion', 'continental-champion', 'national-champion'].forEach((id) => assert.ok(got.includes(id), id));
});

test('drift: score thresholds + combo, from drift events and race stats', () => {
  const P = fresh();
  let got = ids(A.check(P, { type: 'drift', score: 60000, combo: 4 }, opts()));
  assert.ok(got.includes('sideways') && got.includes('angle-of-attack') && !got.includes('drift-king'));
  assert.equal(A.progress(P, 'combo-breaker').cur, 4);
  got = ids(A.check(P, { type: 'drift', score: 100, combo: 12 }, opts()));
  assert.ok(got.includes('combo-breaker'));
  const Q = fresh({ stats: { driftScoreBest: 160000 } });
  got = ids(A.check(Q, { type: 'stat' }, opts()));
  assert.ok(got.includes('drift-king'), 'profile best drift score counts');
});

test('endurance: pit stops, fuel, tyres, finishing', () => {
  const P = fresh();
  const ev = raceEv({ position: 1, laps: 30 }, { extras: { endurance: true, eventType: 'endurance' } });
  ev.stats = { pitStops: 1, fuelLeft_l: 0.4, tireWear: [0.3, 0.3, 0.4, 0.45] };
  ev.endurance = { enabled: true, pitStops: 1, fuelLeft_l: 0.4, tireWear: [0.3, 0.3, 0.4, 0.45], tireAge_laps: [30, 30, 30, 30], lastPit: { lap: 15, tires: 0, fuel_l: 40 } };
  const got = ids(A.check(P, ev, opts()));
  ['iron-man', 'on-fumes', 'tyre-whisperer', 'one-stop', 'pit-crew', 'marathon'].forEach((id) => assert.ok(got.includes(id), id + ' in ' + got));
  const Q = fresh();
  assert.ok(ids(A.check(Q, { type: 'pit', action: 'pit' }, opts())).includes('pit-crew'));
});

test('endurance: tyre-whisperer needs the original tyres (regression)', () => {
  const mk = (endur) => {
    const ev = raceEv({ position: 1, laps: 10 }, { eventType: 'endurance' });
    ev.endurance = Object.assign({ enabled: true, pitStops: 1, tireWear: [0.1, 0.1, 0.1, 0.1] }, endur);
    return ids(A.check(fresh(), ev, opts()));
  };
  let got = mk({ tireAge_laps: [3, 3, 3, 3], lastPit: { lap: 7, tires: 4 } });
  assert.ok(got.includes('one-stop') && got.includes('iron-man'), got);
  assert.ok(!got.includes('tyre-whisperer'), 'tyres changed on lap 7');
  assert.ok(!mk({ tireAge_laps: [3, 3, 10, 10], lastPit: { lap: 7, tires: 2 } }).includes('tyre-whisperer'), 'two tyres changed');
  assert.ok(!mk({ tireAge_laps: [3, 3, 3, 3] }).includes('tyre-whisperer'), 'young tyres without pit detail');
  assert.ok(!mk({ pitStops: 2, pits: [{ lap: 3, tires: 4 }, { lap: 7, tires: 0 }] }).includes('tyre-whisperer'), 'earlier stop changed tyres');
  assert.ok(!mk({}).includes('tyre-whisperer'), 'stop with no tyre data is not trusted');
  assert.ok(mk({ tireAge_laps: [10, 10, 10, 10], lastPit: { lap: 5, tires: 0 } }).includes('tyre-whisperer'), 'fuel-only stop');
  assert.ok(mk({ pitStops: 0, tireAge_laps: [10, 10, 10, 10] }).includes('tyre-whisperer'), 'no stops');
});

test('career: championship-complete payloads derive perfect season, duels and special events (regression)', () => {
  const rows = (wins, n) => [{ id: 'player', isPlayer: true, position: 1, points: 30, wins, starts: n, finishes: Array(n).fill(1).map((x, i) => (i < wins ? 1 : 2)) },
    { id: 'ai1', position: 2, points: 10, wins: n - wins, starts: n, finishes: Array(n).fill(2) }];
  const champ = (o) => Object.assign({ type: 'career', action: 'championship-complete', tierId: 'national', position: 1, trophy: { position: 1 } }, o);
  let P = fresh();
  let got = ids(A.check(P, champ({ champId: 'national-gt4', eventType: 'race', standings: rows(5, 6) }), opts()));
  assert.ok(got.includes('champion') && !got.includes('perfect-season'), got);
  got = ids(A.check(P, champ({ champId: 'national-touring', eventType: 'race', standings: rows(6, 6) }), opts()));
  assert.ok(got.includes('perfect-season'), got);
  P = fresh();
  got = ids(A.check(P, champ({ champId: 'duel-kade', eventType: 'rivals', standings: rows(2, 3) }), opts()));
  assert.ok(got.includes('nemesis') && !got.includes('perfect-season'), got);
  A.check(P, champ({ champId: 'duel-yuki', eventType: 'rivals', standings: rows(2, 3) }), opts());
  A.check(P, champ({ champId: 'duel-yuki', eventType: 'rivals', standings: rows(2, 3) }), opts());
  assert.equal(A.progress(P, 'rivalry').cur, 2, 'distinct rivals counted once each');
  got = ids(A.check(P, champ({ champId: 'duel-tomas', eventType: 'rivals', position: 2, trophy: { position: 2 }, standings: rows(1, 3).reverse() }), opts()));
  assert.ok(!got.includes('rivalry') && A.progress(P, 'rivalry').cur === 2, 'a lost duel is no defeat');
  got = ids(A.check(P, champ({ champId: 'special-quarter-mile-shootout', eventType: 'drag', standings: rows(1, 1) }), opts()));
  assert.ok(got.includes('drag-king') && !got.includes('perfect-season'), got);
  got = ids(A.check(P, champ({ champId: 'special-anvil-knockout', eventType: 'eliminator', standings: rows(1, 1) }), opts()));
  assert.ok(got.includes('last-one-standing'), got);
  got = ids(A.check(P, champ({ champId: 'mfr-hanzo-rotary', eventType: 'manufacturer', position: 2, trophy: { position: 2 } }), opts()));
  assert.ok(!got.includes('brand-ambassador'), 'P2 does not win');
  got = ids(A.check(P, champ({ champId: 'mfr-hanzo-rotary', eventType: 'manufacturer' }), opts()));
  assert.ok(got.includes('brand-ambassador'), got);
  got = ids(A.check(fresh(), { type: 'career', action: 'round-complete', champId: 'special-anvil-knockout', eventType: 'eliminator', position: 1, roundPosition: 1 }, opts()));
  assert.ok(!got.includes('last-one-standing'), 'a round win is not an event win');
});

test('challenges: medals per challenge, best medal kept, gold specials', () => {
  const P = fresh();
  let got = ids(A.check(P, { type: 'challenge', id: 'launch-control', medal: 'bronze', score: 9.1 }, opts()));
  assert.ok(got.includes('student'));
  got = ids(A.check(P, { type: 'challenge', id: 'launch-control', medal: 'gold', score: 7.0 }, opts()));
  assert.ok(got.includes('launch-perfect'));
  A.check(P, { type: 'challenge', id: 'launch-control', medal: 'silver' }, opts());
  assert.equal(P.achievements['honour-roll'].progress.medals['launch-control'], 3, 'best medal retained');
  ['braking-zone', 'slalom', 'elk-test', 'top-speed-run'].forEach((id) => A.check(P, { type: 'challenge', id, medal: 'gold' }, opts()));
  assert.ok(A.isUnlocked(P, 'honour-roll'));
  assert.ok(A.isUnlocked(P, 'gold-standard'));
  ['braking-perfect', 'slalom-perfect', 'elk-perfect', 'topspeed-perfect'].forEach((id) => assert.ok(A.isUnlocked(P, id), id));
});

test('garage + economy state achievements', () => {
  const P = fresh({ ownedCars: [{ id: 'c1', odometer_km: 1200 }] });
  let got = ids(A.check(P, { type: 'garage', action: 'buy' }, opts()));
  assert.ok(got.includes('keys-in-hand') && got.includes('high-mileage'));
  got = ids(A.check(P, { type: 'career', action: 'car-repaired' }, opts()));
  assert.ok(got.includes('grease-monkey'));
  got = ids(A.check(P, { type: 'garage', action: 'sold' }, opts()));
  assert.ok(got.includes('moving-on'));
  P.credits = 2000000;
  got = ids(A.check(P, { type: 'profile' }, opts()));
  assert.ok(got.includes('millionaire'));
});

test('career: championship type comes from the catalogue, not the final round format (regression)', () => {
  const C = tryReq('js/game/career.js') && CB.game.career;
  if (!C) return;
  const rows = [{ id: 'player', isPlayer: true, position: 1, points: 30, wins: 2, starts: 3, finishes: [1, 2, 1] }, { id: 'rival-tomas', position: 2, points: 20, wins: 1, starts: 3, finishes: [2, 1, 2] }];
  // duel-tomas ends on a drag round: the hub passes the round format, the duel must still count as a rival defeated
  const P = fresh();
  let got = ids(A.check(P, { type: 'career', action: 'championship-complete', champId: 'duel-tomas', eventType: 'drag', position: 1, trophy: { position: 1 }, standings: rows }, opts()));
  assert.ok(got.includes('nemesis'), got);
  assert.ok(!got.includes('drag-king'), 'a duel is not a drag event');
  assert.equal(A.progress(P, 'rivalry').cur, 1);
  // endurance-format duel
  A.check(P, { type: 'career', action: 'championship-complete', champId: 'duel-ines', eventType: 'endurance', position: 1, trophy: { position: 1 }, standings: rows }, opts());
  assert.equal(A.progress(P, 'rivalry').cur, 2);
  // a race championship whose last round is a drag special is not a drag event
  got = ids(A.check(fresh(), { type: 'career', action: 'championship-complete', champId: 'national-heritage-muscle', eventType: 'drag', position: 1, trophy: { position: 1 } }, opts()));
  assert.ok(got.includes('champion') && !got.includes('drag-king'), got);
  got = ids(A.check(fresh(), { type: 'career', action: 'championship-complete', champId: 'national-midnight-drag', eventType: 'drag', position: 1, perfect: true, trophy: { position: 1 } }, opts()));
  assert.ok(got.includes('drag-king') && got.includes('perfect-season'), got);
  got = ids(A.check(fresh(), { type: 'career', action: 'championship-complete', champId: 'continental-last-car', eventType: 'eliminator', position: 1, trophy: { position: 1 } }, opts()));
  assert.ok(got.includes('last-one-standing'), got);
  got = ids(A.check(fresh(), { type: 'career', action: 'championship-complete', champId: 'mfr-kestrel-featherweight', eventType: 'race', position: 1, trophy: { position: 1 } }, opts()));
  assert.ok(got.includes('brand-ambassador'), got);
});

test('endurance: tyre-whisperer reads the engine pitLog breakdown (regression)', () => {
  const mk = (pitLog, endur) => {
    const ev = raceEv({ position: 1, laps: 10 }, { eventType: 'endurance' });
    ev.results.player.pitLog = pitLog;
    ev.results.player.pitStops = pitLog.length;
    ev.endurance = Object.assign({ enabled: true, pitStops: pitLog.length, tireWear: [0.1, 0.1, 0.1, 0.1], tireAge_laps: [10, 10, 10, 10] }, endur || {});
    return ids(A.check(fresh(), ev, opts()));
  };
  const tyres = { lap: 2, breakdown: [{ label: 'Stop & release', seconds: 1.2 }, { label: '4 tyres (Medium)', seconds: 6 }, { label: 'Fuel +20 L', seconds: 5 }] };
  const fuel = { lap: 6, breakdown: [{ label: 'Stop & release', seconds: 1.2 }, { label: 'Fuel +20 L', seconds: 5 }] };
  // early tyre change, last stop fuel-only; tyre ages alone look plausible
  assert.ok(!mk([tyres, fuel], { lastPit: { lap: 6, tires: 0 } }).includes('tyre-whisperer'), 'tyres changed at the first stop');
  assert.ok(mk([fuel, fuel], { lastPit: { lap: 6, tires: 0 } }).includes('tyre-whisperer'), 'two fuel-only stops');
});

test('media: a photo event without an explicit export action does not count', () => {
  const P = fresh();
  assert.ok(!ids(A.check(P, { type: 'photo' }, opts())).includes('shutterbug'));
  assert.equal(A.progress(P, 'gallery-wall').cur, 0);
});

test('media: replay saves and photo exports', () => {
  const P = fresh();
  assert.ok(ids(A.check(P, { type: 'replay', action: 'saved' }, opts())).includes('directors-cut'));
  for (let i = 0; i < 3; i++) assert.ok(!ids(A.check(P, { type: 'photo', action: 'open' }, opts())).includes('shutterbug'), 'opening photo mode is not an export');
  assert.equal(A.progress(P, 'gallery-wall').cur, 0, 'opens do not count toward Gallery Wall');
  assert.ok(ids(A.check(P, { type: 'photo', action: 'exported' }, opts())).includes('shutterbug'));
  assert.equal(A.progress(P, 'gallery-wall').cur, 1);
  for (let i = 0; i < 9; i++) A.check(P, { type: 'replay', action: 'watched' }, opts());
  assert.equal(A.progress(P, 'cinephile').cur, 9);
});

test('secret night-shift unlocks only between 02:00 and 04:00 local', () => {
  const night = new Date(2026, 0, 1, 3, 0, 0).getTime();
  const day = new Date(2026, 0, 1, 15, 0, 0).getTime();
  const P = fresh();
  assert.ok(!ids(A.check(P, { type: 'session' }, opts({ now: day }))).includes('night-shift'));
  assert.ok(ids(A.check(P, { type: 'session' }, opts({ now: night }))).includes('night-shift'));
});

test('meta: collector achievements cascade in the same check', () => {
  const P = fresh();
  // grant 9 non-meta achievements, the 10th via an event should cascade 'collector-10'
  const nonMeta = A.list.filter((a) => a.category !== 'meta' && a.id !== 'first-commission').slice(0, 9);
  nonMeta.forEach((a) => A.unlock(P, a.id, { persist: false, toast: false, now: NOW }));
  const got = ids(A.check(P, buildEv(), opts()));
  assert.ok(got.includes('first-commission'));
  assert.ok(got.includes('collector-10'), got);
});

/* ------------------------------------------------------------------ rewards / persistence */

test('rewards applied directly to a plain profile (credits, xp, level, creditsEarned)', () => {
  const P = fresh();
  const got = A.check(P, raceEv({ position: 1, grid: 1 }), opts());
  const cr = got.reduce((s, a) => s + a.credits, 0), xp = got.reduce((s, a) => s + a.xp, 0);
  assert.equal(P.credits, 150000 + cr);
  assert.equal(P.xp, xp);
  assert.equal(P.stats.creditsEarned, cr);
  assert.ok(P.level >= 1);
  const Q = fresh({ xp: 0, level: 1 });
  // level curve: xpForLevel(l) = round(1000*l^1.6) is per-level, cumulative thresholds 1000, 4031, ...
  A.unlock(Q, 'two-thousand', { persist: false, toast: false });
  const plat = A.get('two-thousand').xp;
  const expected = plat >= 1000 + Math.round(1000 * Math.pow(2, 1.6)) ? 3 : plat >= 1000 ? 2 : 1;
  assert.ok(Q.level >= expected && Q.level <= expected + 1, 'level ' + Q.level + ' for ' + plat + ' xp');
});

test('evaluate() is a dry run; progress() and summary() are consistent', () => {
  const P = fresh();
  const snap = JSON.stringify(P);
  const would = A.evaluate(P, raceEv({ position: 1 }));
  assert.ok(would.includes('first-win'));
  assert.equal(JSON.stringify(P), snap);
  A.check(P, raceEv({ position: 1 }), opts());
  const s = A.summary(P);
  assert.equal(s.total, A.list.length);
  assert.equal(s.unlocked, A.list.filter((a) => A.isUnlocked(P, a.id)).length);
  assert.equal(Object.values(s.byTier).reduce((n, t) => n + t.total, 0), A.list.length);
  assert.ok(s.recent.length > 0 && s.recent[0].unlockedAt === NOW);
  assert.equal(A.progress(P, 'first-win').pct, 1);
  assert.equal(A.progress(P, 'nope'), null);
  // achievement objects expose progress(profile) per contract
  const vet = A.get('veteran');
  assert.equal(typeof vet.progress, 'function');
  assert.deepEqual(vet.progress(P), { cur: 1, max: 25 });
});

test('onUnlock listeners fire once per unlock; reset clears', () => {
  const P = fresh();
  const heard = [];
  const off = A.onUnlock((a) => heard.push(a.id));
  A.check(P, raceEv({ position: 1 }), opts());
  A.check(P, raceEv({ position: 1 }), opts());
  off();
  assert.equal(heard.filter((i) => i === 'first-win').length, 1);
  A.reset(P);
  assert.deepEqual(P.achievements, {});
});

test('robustness: junk events and missing data never throw', () => {
  const P = fresh();
  [null, undefined, {}, { type: 'race-finished' }, { type: 'race-finished', results: [] }, { type: 'race-finished', results: { classification: [null, 3, 'x'] } },
    { type: 'build-changed', build: null }, { type: 'build-changed', build: {}, metrics: { power_hp: 'abc' } }, { type: 'career' }, { type: 'stat', stats: null },
    { type: 'challenge' }, { type: 'drift', score: 'NaN' }, { type: 'wat' }].forEach((ev) => {
    assert.doesNotThrow(() => A.check(P, ev, opts()));
  });
  assert.doesNotThrow(() => A.check({}, raceEv(), opts()));
  assert.ok(Array.isArray(A.check(fresh(), { type: 'race-finished', results: [{ isPlayer: true, position: 1 }, { position: 2 }] }, opts())));
});

test('CB.game.profile integration: unlocks persist and rewards go through addCredits/addXp', () => {
  if (!PM || typeof PM.reset !== 'function') return;
  PM.reset();
  const before = PM.get();
  const got = A.check(null, raceEv({ position: 1, grid: 1 }), { toast: false, now: NOW });
  assert.ok(ids(got).includes('first-win'));
  const after = PM.get();
  const cr = got.reduce((s, a) => s + a.credits, 0);
  assert.equal(after.credits, before.credits + cr);
  assert.ok(after.xp > before.xp);
  assert.ok(after.achievements['first-win'].unlockedAt === NOW);
  assert.ok(after.ledger.some((t) => /Achievement: First Win/.test(t.reason)), 'ledger entry');
  // same profile object passed explicitly routes through the module as well
  const again = A.check(PM.get(), raceEv({ position: 1 }), { toast: false, now: NOW });
  assert.ok(!ids(again).includes('first-win'));
  assert.ok(A.isUnlocked(null, 'first-win'));
  PM.reset();
});

/* ------------------------------------------------------------------ UI (pure HTML) */

test('UI: toast + gallery HTML render, escape, conceal hidden, filter', () => {
  const I = A._internal;
  const t = I.toastHTML({ id: 'x', name: '<b>Bold</b>', desc: 'a & b', tier: 'gold', xp: 10, credits: 5, icon: A.icon('star', 'gold') });
  assert.ok(t.includes('&lt;b&gt;Bold&lt;/b&gt;') && t.includes('a &amp; b'));
  assert.ok(t.includes('gach-confetti'), 'gold toast has confetti');
  assert.ok(!I.toastHTML(A.get('first-win')).includes('gach-confetti'), 'bronze toast is calmer');
  const P = fresh();
  const html = I.galleryBodyHTML(P, { category: 'all', tier: 'all', status: 'all', q: '', sort: 'default', showHidden: false });
  assert.ok(html.includes('Hidden achievement'));
  assert.ok(!html.includes('Stampede'), 'hidden names concealed while locked');
  const shown = I.galleryBodyHTML(P, { category: 'all', tier: 'all', status: 'all', q: '', sort: 'default', showHidden: true });
  assert.ok(shown.includes('Stampede'));
  const gold = I.viewModel(P, { category: 'all', tier: 'gold', status: 'all', q: '', sort: 'default' });
  assert.ok(gold.length > 0 && gold.every((r) => r.d.tier === 'gold'));
  const racing = I.viewModel(P, { category: 'racing', tier: 'all', status: 'all', q: 'slam', sort: 'name' });
  assert.deepEqual(racing.map((r) => r.d.id), ['grand-slam']);
  A.check(P, raceEv({ position: 1 }), opts());
  A.check(P, raceEv({ position: 1 }), opts());
  const prog = I.viewModel(P, { category: 'all', tier: 'all', status: 'progress', q: '', sort: 'progress' });
  assert.ok(prog.some((r) => r.d.id === 'hat-trick'));
  assert.ok(prog.every((r) => !r.unlocked));
  const unl = I.viewModel(P, { category: 'all', tier: 'all', status: 'unlocked', q: '', sort: 'recent' });
  assert.ok(unl.every((r) => r.unlocked) && unl.some((r) => r.d.id === 'first-win'));
  assert.ok(I.detailHTML(P, 'hat-trick').includes('Progress 2 / 3'));
  assert.ok(I.CSS.length > 2000 && I.CSS.includes('prefers-reduced-motion'));
  assert.equal(A.toast(A.get('first-win')), null, 'toast is a no-op without a DOM');
  assert.equal(A.openGallery(), null, 'gallery is a no-op without a DOM');
});

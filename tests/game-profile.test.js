/* FORGE Atelier — CB.game.profile tests. Run: node tests/run.js game-profile */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

const P = require('../js/game/profile.js');

/* fake localStorage with optional quota / failure injection */
function fakeStorage(opts) {
  opts = opts || {};
  const m = {};
  return {
    data: m,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => {
      if (opts.fail) throw new Error('blocked');
      if (opts.quota && String(v).length > opts.quota) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      m[k] = String(v);
    },
    removeItem: (k) => { delete m[k]; },
  };
}
function fresh(store) {
  P._setStorage(store || fakeStorage());
  P.load();
  return P.reset();
}

/* ------------------------------------------------------------ xp curve */
test('profile: xp curve matches round(1000 * l^1.6)', () => {
  assert.equal(P.xpForLevel(1), 1000);
  assert.equal(P.xpForLevel(2), Math.round(1000 * Math.pow(2, 1.6)));
  assert.equal(P.xpForLevel(10), Math.round(1000 * Math.pow(10, 1.6)));
  assert.equal(P.totalXpForLevel(1), 0);
  assert.equal(P.totalXpForLevel(2), 1000);
  assert.equal(P.totalXpForLevel(3), 1000 + P.xpForLevel(2));
  assert.equal(P.levelForXp(0), 1);
  assert.equal(P.levelForXp(999), 1);
  assert.equal(P.levelForXp(1000), 2);
  assert.equal(P.levelForXp(1e15), P.MAX_LEVEL);
  for (let l = 1; l < 40; l++) assert.equal(P.levelForXp(P.totalXpForLevel(l)), l);
  const info = P.levelInfo(1500);
  assert.equal(info.level, 2);
  assert.equal(info.into, 500);
  assert.equal(info.needed, P.xpForLevel(2));
  assert.ok(info.progress > 0 && info.progress < 1);
  assert.equal(P.levelInfo(1e15).maxed, true);
  assert.equal(typeof P.levelTitle(1), 'string');
});

/* ------------------------------------------------------------ defaults */
test('profile: default profile matches contract shape', () => {
  const p = fresh();
  assert.equal(p.version, 1);
  assert.equal(p.credits, 150000);
  assert.equal(p.xp, 0);
  assert.equal(p.level, 1);
  assert.ok(Array.isArray(p.ownedCars));
  assert.equal(p.activeCarId, null);
  assert.deepEqual(p.unlocks, { parts: [], tracks: [], bodyStyles: [] });
  assert.ok(p.career && typeof p.career === 'object');
  for (const k of ['races', 'wins', 'podiums', 'poles', 'fastestLaps', 'distance_km', 'topSpeed_kph', 'crashes', 'creditsEarned', 'driftScoreBest']) {
    assert.equal(p.stats[k], 0, k);
  }
  const s = p.settings;
  assert.equal(s.units, 'kph');
  assert.ok(P.DIFFICULTIES.includes(s.difficulty));
  for (const k of ['master', 'engine', 'sfx', 'music']) assert.ok(s.audio[k] >= 0 && s.audio[k] <= 1);
  assert.ok(s.controls.bindings.throttle.includes('KeyW'));
  assert.ok(s.controls.bindings.handbrake.includes('Space'));
  assert.equal(typeof s.camera, 'string');
  assert.equal(typeof s.graphics.particles, 'boolean');
});

test('profile: default bindings are conflict-free and cover every action', () => {
  const b = P.defaultBindings();
  const seen = {};
  for (const a of P.ACTIONS) {
    assert.ok(Array.isArray(b[a.id]) && b[a.id].length > 0, a.id);
    for (const code of b[a.id]) { assert.ok(!seen[code], 'duplicate ' + code); seen[code] = a.id; }
  }
});

/* ------------------------------------------------------------ persistence */
test('profile: save/load roundtrip through storage', () => {
  const store = fakeStorage();
  fresh(store);
  P.update((p) => { p.driverName = 'Ayrton'; });
  const raw = JSON.parse(store.data[P.STORAGE_KEY]);
  assert.equal(raw.driverName, 'Ayrton');
  P._unload();
  assert.equal(P.get().driverName, 'Ayrton');
  assert.equal(P.isPersistent(), true);
});

test('profile: memory fallback when localStorage is blocked', () => {
  P._setStorage('memory');
  P.load();
  P.reset();
  assert.equal(P.isPersistent(), false);
  assert.ok(P.addCredits(100, 'test') > 150000);
  assert.equal(P.get().credits, 150100);
});

test('profile: save survives a throwing storage (falls back to memory)', () => {
  const store = fakeStorage({ fail: true });
  P._setStorage(store);
  P.load();
  assert.equal(P.save(), true);
  assert.equal(P.isPersistent(), false);
  P.addCredits(5, 'x');
  assert.equal(P.get().credits % 10, 5);
});

test('profile: corrupt JSON is backed up and replaced with a fresh profile', () => {
  const store = fakeStorage();
  store.data[P.STORAGE_KEY] = '{not json';
  P._setStorage(store);
  const p = P.load();
  assert.equal(p.credits, 150000);
  assert.equal(store.data[P.BACKUP_KEY], '{not json');
  assert.equal(p.meta.recoveredFromCorrupt, true);
});

test('profile: get() returns a deep clone', () => {
  fresh();
  const a = P.get();
  a.credits = 1; a.settings.audio.master = 0;
  const b = P.get();
  assert.equal(b.credits, 150000);
  assert.notEqual(b.settings.audio.master, 0);
});

/* ------------------------------------------------------------ migration */
test('profile: migrates legacy v0 saves', () => {
  const legacy = {
    money: 4200, name: 'Old Timer', cars: [{ id: 'c1', name: 'Relic', build: { meta: {} }, km: 1234, price: 90000, condition: 80 }],
    activeCar: 'c1', unlocks: ['parts:engine.types:w16', 'tracks:monza', 'bodyStyles:roadster', 'aero.wings:gt'],
    achievements: ['first-win'], settings: { units: 'imperial' }, stats: { distance_m: 5000, races: 3 },
  };
  const { profile, from, changed } = P.migrate(legacy);
  assert.equal(from, 0);
  assert.equal(changed, true);
  assert.equal(profile.version, 1);
  assert.equal(profile.credits, 4200);
  assert.equal(profile.driverName, 'Old Timer');
  assert.equal(profile.ownedCars.length, 1);
  assert.equal(profile.ownedCars[0].odometer_km, 1234);
  assert.equal(profile.ownedCars[0].purchasedFor, 90000);
  assert.equal(profile.ownedCars[0].condition, 0.8);
  assert.equal(profile.activeCarId, 'c1');
  assert.deepEqual(profile.unlocks.parts, ['engine.types:w16', 'aero.wings:gt']);
  assert.deepEqual(profile.unlocks.tracks, ['monza']);
  assert.deepEqual(profile.unlocks.bodyStyles, ['roadster']);
  assert.ok(profile.achievements['first-win']);
  assert.equal(profile.settings.units, 'mph');
  assert.equal(profile.stats.distance_km, 5);
  assert.equal(profile.stats.races, 3);
  assert.equal(profile.meta.migratedFrom, 0);
});

test('profile: normalize repairs garbage values and keeps unknown keys', () => {
  const p = P.normalize({
    version: 1, credits: -50, xp: 'abc', avatarColor: 'javascript:1', settings: { units: 'furlongs', audio: { master: 9 }, difficulty: 'god' },
    ownedCars: [null, { id: 'a' }, { id: 'a' }, 7], activeCarId: 'zzz', sponsors: { active: ['x'] },
    stats: { wins: -3, customStat: 12 },
  });
  assert.equal(p.credits, 0);
  assert.equal(p.xp, 0);
  assert.match(p.avatarColor, /^#/);
  assert.equal(p.settings.units, 'kph');
  assert.equal(p.settings.audio.master, 1);
  assert.equal(p.settings.difficulty, 'amateur');
  assert.equal(p.ownedCars.length, 1);
  assert.equal(p.activeCarId, 'a');
  assert.deepEqual(p.sponsors, { active: ['x'] });
  assert.equal(p.stats.wins, 0);
  assert.equal(p.stats.customStat, 12);
});

test('profile: newer-version saves are not destroyed', () => {
  const { profile } = P.migrate({ version: 7, credits: 999, futureThing: { a: 1 } });
  assert.equal(profile.credits, 999);
  assert.deepEqual(profile.futureThing, { a: 1 });
});

test('profile: importJSON / exportJSON roundtrip', () => {
  fresh();
  P.update((p) => { p.driverName = 'Export Me'; p.credits = 777; });
  const json = P.exportJSON();
  P.reset();
  assert.equal(P.importJSON('nope').ok, false);
  assert.equal(P.importJSON({ foo: 1 }).ok, false);
  const r = P.importJSON(json);
  assert.equal(r.ok, true);
  assert.equal(P.get().driverName, 'Export Me');
  assert.equal(P.get().credits, 777);
  assert.equal(typeof P.checksum(), 'string');
});

/* ------------------------------------------------------------ update / subscribe */
test('profile: update mutates a clone, saves, and emits', () => {
  fresh();
  const events = [];
  const off = P.subscribe((p, meta) => events.push([p.credits, meta.reason]));
  const before = P.peek();
  P.update((p) => { p.credits = 12345; });
  assert.equal(before.credits, 150000, 'previous live object untouched');
  assert.equal(P.get().credits, 12345);
  assert.deepEqual(events[events.length - 1], [12345, 'update']);
  off();
  P.update((p) => { p.credits = 1; });
  assert.equal(events.length, 1);
});

test('profile: update that throws leaves the profile unchanged', () => {
  fresh();
  assert.throws(() => P.update((p) => { p.credits = 1; throw new Error('boom'); }), /boom/);
  assert.equal(P.get().credits, 150000);
  // and the module is not stuck in a draft
  P.update((p) => { p.credits = 2; });
  assert.equal(P.get().credits, 2);
});

test('profile: nested updates commit once', () => {
  fresh();
  let n = 0;
  const off = P.subscribe(() => n++);
  P.update((p) => { p.driverName = 'Nest'; P.addCredits(50, 'inner'); });
  off();
  assert.equal(n, 1);
  const p = P.get();
  assert.equal(p.driverName, 'Nest');
  assert.equal(p.credits, 150050);
});

test('profile: subscriber errors do not break other subscribers', () => {
  fresh();
  const orig = console.error; console.error = () => {};
  let ok = false;
  const a = P.subscribe(() => { throw new Error('bad listener'); });
  const b = P.subscribe(() => { ok = true; });
  try { P.addCredits(1, 'x'); } finally { console.error = orig; a(); b(); }
  assert.equal(ok, true);
});

test('profile: subscribe immediate fires synchronously', () => {
  fresh();
  let got = null;
  const off = P.subscribe((p, m) => { got = m.reason; }, { immediate: true });
  off();
  assert.equal(got, 'subscribe');
});

test('profile: reset keeps settings / name on request', () => {
  fresh();
  P.setDriver('Keeper', '#3d7fd9');
  P.setSetting('units', 'mph');
  P.addCredits(1000, 'x');
  const r = P.reset({ keepSettings: true, keepName: true });
  assert.equal(r.credits, 150000);
  assert.equal(r.driverName, 'Keeper');
  assert.equal(r.settings.units, 'mph');
  assert.equal(P.reset().settings.units, 'kph');
});

/* ------------------------------------------------------------ credits & ledger */
test('profile: addCredits / spend with ledger entries', () => {
  fresh();
  assert.equal(P.addCredits(5000, 'Race win', 'race'), 155000);
  assert.equal(P.spend(10000, 'Turbo', 'upgrade'), true);
  assert.equal(P.get().credits, 145000);
  assert.equal(P.spend(1e9, 'Too much'), false);
  assert.equal(P.get().credits, 145000);
  assert.equal(P.spend(-5, 'neg'), false);
  assert.equal(P.spend(0, 'free'), true);
  const l = P.ledger;
  assert.equal(l.length, 2);
  assert.deepEqual(l.map((e) => e.amount), [5000, -10000]);
  assert.equal(l[1].balance, 145000);
  assert.equal(l[1].kind, 'debit');
  assert.equal(P.getLedger({ limit: 1 })[0].reason, 'Turbo');
  assert.equal(P.getLedger({ category: 'race' }).length, 1);
  const sum = P.ledgerSummary();
  assert.equal(sum.earned, 5000);
  assert.equal(sum.spent, 10000);
  assert.equal(sum.net, -5000);
  assert.equal(P.get().stats.creditsEarned, 5000);
  assert.equal(P.get().stats.creditsSpent, 10000);
  assert.equal(P.canAfford(145000), true);
  assert.equal(P.canAfford(145001), false);
});

test('profile: negative addCredits clamps at zero', () => {
  fresh();
  assert.equal(P.addCredits(-1e9, 'fine'), 0);
  assert.equal(P.ledger[0].amount, -150000);
});

test('profile: ledger capped at 200 entries', () => {
  fresh();
  P.update(() => { for (let i = 0; i < 250; i++) P.addCredits(1, 'tick ' + i); });
  const l = P.ledger;
  assert.equal(l.length, P.LEDGER_MAX);
  assert.equal(l[l.length - 1].reason, 'tick 249');
  assert.equal(l[0].reason, 'tick 50');
});

/* ------------------------------------------------------------ xp */
test('profile: addXp levels up and reports', () => {
  fresh();
  let r = P.addXp(500);
  assert.equal(r.levelUp, false);
  assert.equal(r.newLevel, 1);
  r = P.addXp(500);
  assert.equal(r.levelUp, true);
  assert.equal(r.newLevel, 2);
  r = P.addXp(P.totalXpForLevel(5) - 1000);
  assert.equal(r.newLevel, 5);
  assert.equal(r.levelsGained, 3);
  assert.equal(P.get().level, 5);
  assert.equal(P.addXp(0).levelUp, false);
  assert.equal(P.addXp(-50).gained, 0);
});

test('profile: award grants credits + xp in one commit', () => {
  fresh();
  let n = 0;
  const off = P.subscribe(() => n++);
  const r = P.award({ credits: 2500, xp: 1200, reason: 'P1 at Monza' });
  off();
  assert.equal(n, 1);
  assert.equal(r.credits, 152500);
  assert.equal(r.levelUp, true);
  assert.equal(r.newLevel, 2);
  assert.equal(P.ledger[0].reason, 'P1 at Monza');
});

/* ------------------------------------------------------------ cars */
test('profile: owned-car CRUD', () => {
  fresh();
  const a = P.addCar({ meta: { name: 'Alpha' } }, { name: 'Alpha', purchasedFor: 50000 });
  assert.ok(a.id);
  assert.equal(a.condition, 1);
  assert.equal(a.odometer_km, 0);
  assert.equal(P.get().activeCarId, a.id, 'first car becomes active');
  const b = P.addCar({ meta: {} }, { name: 'Beta' });
  assert.equal(P.get().activeCarId, a.id, 'second car does not steal active');
  const c = P.addCar({ meta: {} }, { name: 'Gamma', setActive: true });
  assert.equal(P.get().activeCarId, c.id);
  assert.equal(P.listCars().length, 3);
  assert.equal(P.get().stats.carsBought, 3);

  assert.equal(P.setActiveCar('nope'), false);
  assert.equal(P.setActiveCar(b.id), true);
  assert.equal(P.activeCar().name, 'Beta');

  const u = P.updateCar(b.id, { name: 'Beta Mk2', condition: 7, build: { meta: { v: 2 } }, id: 'hijack' });
  assert.equal(u.name, 'Beta Mk2');
  assert.equal(u.condition, 1, 'condition clamped');
  assert.equal(u.id, b.id, 'id immutable');
  assert.deepEqual(u.build, { meta: { v: 2 } });
  const u2 = P.updateCar(b.id, (car) => { car.odometer_km += 12.5; });
  assert.equal(u2.odometer_km, 12.5);
  assert.equal(P.updateCar('missing', { name: 'x' }), null);
  assert.equal(P.renameCar(a.id, 'Alpha Prime').name, 'Alpha Prime');

  const removed = P.removeCar(b.id, { sold: true });
  assert.equal(removed.name, 'Beta Mk2');
  assert.notEqual(P.get().activeCarId, b.id);
  assert.ok(P.getCar(P.get().activeCarId));
  assert.equal(P.get().stats.carsSold, 1);
  assert.equal(P.removeCar('missing'), null);
  P.removeCar(a.id); P.removeCar(c.id);
  assert.equal(P.get().activeCarId, null);
});

test('profile: addCar copies the build (no aliasing)', () => {
  fresh();
  const build = { meta: { name: 'Alias' }, engine: { type: 'v8' } };
  const car = P.addCar(build, { name: 'A' });
  build.engine.type = 'w16';
  assert.equal(P.getCar(car.id).build.engine.type, 'v8');
});

/* ------------------------------------------------------------ stats */
function engineResults(over) {
  const player = Object.assign({
    position: 1, id: 'player', isPlayer: true, status: 'finished', laps: 3, totalTime_s: 300, penalties_s: 0,
    bestLap_s: 98.5, trackLimits: 0, collisions: 0, gridPosition: 1, positionsByLap: [1, 1, 1], topSpeed_kph: 287.4, fastestLap: true,
  }, over || {});
  return {
    mode: 'race', trackId: 'monza', trackLength_m: 5000, lapsTotal: 3, complete: true, playerId: 'player',
    fastestLap: { carId: 'player', time: 98.5 },
    classification: [player, { position: 2, id: 'ai1', isPlayer: false, status: 'finished', laps: 3 }, { position: 3, id: 'ai2', status: 'finished', laps: 3 }],
    player,
  };
}

test('profile: recordRaceStats folds engine results (grand slam win)', () => {
  fresh();
  const car = P.addCar({ meta: {} }, { name: 'Racer' });
  const s = P.recordRaceStats(engineResults(), { trackId: 'monza', laps: 3, difficulty: 'pro' });
  assert.equal(s.valid, true);
  assert.equal(s.win, true);
  assert.equal(s.podium, true);
  assert.equal(s.pole, true);
  assert.equal(s.fastestLap, true);
  assert.equal(s.ledEveryLap, true);
  assert.equal(s.clean, true);
  assert.equal(s.distance_km, 15);
  const p = P.get();
  assert.equal(p.stats.races, 1);
  assert.equal(p.stats.wins, 1);
  assert.equal(p.stats.podiums, 1);
  assert.equal(p.stats.poles, 1);
  assert.equal(p.stats.fastestLaps, 1);
  assert.equal(p.stats.distance_km, 15);
  assert.equal(p.stats.topSpeed_kph, 287.4);
  assert.equal(p.stats.cleanRaces, 1);
  assert.equal(p.stats.tracks.monza.bestLap_s, 98.5);
  assert.equal(p.stats.tracks.monza.bestFinish, 1);
  assert.equal(p.stats.history.length, 1);
  assert.equal(p.stats.history[0].carId, car.id);
  const c = P.getCar(car.id);
  assert.equal(c.odometer_km, 15);
  assert.equal(c.races, 1);
  assert.equal(c.wins, 1);
  assert.ok(c.condition < 1);
});

test('profile: recordRaceStats handles DNF via engine status and crashes', () => {
  fresh();
  const s = P.recordRaceStats(engineResults({ position: 3, status: 'dnf', collisions: 4, gridPosition: 5, fastestLap: false, positionsByLap: [3, 4] }), { trackId: 'monza' });
  assert.equal(s.dnf, true);
  assert.equal(s.win, false);
  assert.equal(s.podium, false);
  assert.equal(s.pole, false);
  assert.equal(s.crashes, 4);
  const st = P.get().stats;
  assert.equal(st.dnfs, 1);
  assert.equal(st.crashes, 4);
  assert.equal(st.podiums, 0);
  assert.equal(st.tracks.monza.bestFinish, null);
});

test('profile: unfinished (quit) race counts as DNF', () => {
  fresh();
  const r = engineResults({ status: 'running' });
  r.complete = false;
  assert.equal(P.recordRaceStats(r, {}).dnf, true);
});

test('profile: win streaks, best lap records, and accepted shapes', () => {
  fresh();
  P.recordRaceStats(engineResults({ bestLap_s: 100 }), {});
  const s2 = P.recordRaceStats(engineResults({ bestLap_s: 99 }), {});
  assert.deepEqual(s2.newRecords.map((r) => r.type), ['bestLap']);
  P.recordRaceStats(engineResults({ position: 2, bestLap_s: 101 }), {});
  const st = P.get().stats;
  assert.equal(st.longestWinStreak, 2);
  assert.equal(st.currentWinStreak, 0);
  assert.equal(st.tracks.monza.bestLap_s, 99);

  // bare array + config.playerId
  const s = P.recordRaceStats([{ id: 'me', position: 2, laps: 2 }, { id: 'x', position: 1 }], { playerId: 'me', trackLength_m: 1000, mode: 'race' });
  assert.equal(s.position, 2);
  assert.equal(s.distance_km, 2);
  // no player → invalid, no change
  const races = P.get().stats.races;
  assert.equal(P.recordRaceStats({ cars: [{ id: 'a' }, { id: 'b' }] }, {}).valid, false);
  assert.equal(P.recordRaceStats(null).valid, false);
  assert.equal(P.get().stats.races, races);
});

test('profile: time-trial counts separately', () => {
  fresh();
  const r = engineResults();
  r.mode = 'time-trial';
  r.classification = [r.player];
  const s = P.recordRaceStats(r, {});
  assert.equal(s.win, false);
  const st = P.get().stats;
  assert.equal(st.races, 0);
  assert.equal(st.timeTrials, 1);
  assert.equal(st.modes['time-trial'], 1);
});

test('profile: recordStat / incStat / statsSummary', () => {
  fresh();
  assert.equal(P.recordStat('driftScoreBest', 500), 500);
  assert.equal(P.recordStat('driftScoreBest', 200), 500, 'max-stat');
  assert.equal(P.incStat('challengesCompleted'), 1);
  assert.equal(P.incStat('challengesCompleted', 2), 3);
  assert.equal(P.recordStat('bestZeroTo100_s', 4.2, 'min'), 4.2);
  assert.equal(P.recordStat('bestZeroTo100_s', 3.9, 'min'), 3.9);
  assert.equal(P.recordStat('bestZeroTo100_s', 5, 'min'), 3.9);
  P.recordRaceStats(engineResults(), {});
  P.recordRaceStats(engineResults({ position: 3 }), {});
  const sum = P.statsSummary();
  assert.equal(sum.races, 2);
  assert.equal(sum.winRate, 50);
  assert.equal(sum.podiumRate, 100);
  assert.equal(sum.avgFinish, 2);
  assert.equal(sum.favoriteTrack, 'monza');
  assert.deepEqual(sum.recentForm, [1, 3]);
});

/* ------------------------------------------------------------ settings & bindings */
test('profile: setSetting validates through normalize', () => {
  fresh();
  P.setSetting('audio.master', 0.25);
  assert.equal(P.getSetting('audio.master'), 0.25);
  P.setSetting('audio.master', 4);
  assert.equal(P.getSetting('audio.master'), 1);
  P.setSetting({ difficulty: 'alien', graphics: { shadows: false } });
  assert.equal(P.getSetting('difficulty'), 'alien');
  assert.equal(P.getSetting('graphics.shadows'), false);
  P.setSetting('difficulty', 'impossible');
  assert.equal(P.getSetting('difficulty'), 'amateur');
  assert.equal(P.getSetting('no.such.path', 'fb'), 'fb');
  P.resetSettings();
  assert.deepEqual(P.getSettings(), P.normalize({ settings: P.defaultSettings() }).settings);
});

test('profile: bindKey steals conflicting keys; unbind/reset work', () => {
  fresh();
  const r = P.bindKey('handbrake', 'KeyW');
  assert.equal(r.stolenFrom, 'throttle');
  assert.equal(r.bindings.handbrake[0], 'KeyW');
  assert.ok(!r.bindings.throttle.includes('KeyW'));
  assert.equal(P.actionForCode('KeyW'), 'handbrake');
  assert.equal(P.bindingMap().KeyW, 'handbrake');
  P.bindKey('camera', 'KeyV', { replace: true });
  assert.deepEqual(P.getSetting('controls.bindings.camera'), ['KeyV']);
  assert.equal(P.bindKey('notAnAction', 'KeyZ'), null);
  P.unbindKey('camera', 'KeyV');
  assert.deepEqual(P.getSetting('controls.bindings.camera'), []);
  const max = P.bindKey('pit', 'Digit1') && P.bindKey('pit', 'Digit2') && P.bindKey('pit', 'Digit3');
  assert.ok(max.bindings.pit.length <= 3);
  P.resetBindings();
  assert.deepEqual(P.getSetting('controls.bindings'), P.defaultBindings());
});

test('profile: keyLabel humanises codes', () => {
  assert.equal(P.keyLabel('KeyW'), 'W');
  assert.equal(P.keyLabel('Digit3'), '3');
  assert.equal(P.keyLabel('ArrowUp'), '↑');
  assert.equal(P.keyLabel('button0'), 'A');
  assert.equal(P.keyLabel('axis0'), 'Left stick X');
  assert.equal(P.keyLabel(''), '—');
});

test('profile: raceDefaults maps settings to a session cfg fragment', () => {
  fresh();
  P.setSetting({ units: 'mph', gameplay: { defaultLaps: 5 } });
  const d = P.raceDefaults();
  assert.equal(d.laps, 5);
  assert.equal(d.units, 'mph');
  assert.equal(typeof d.assists.abs, 'boolean');
});

/* ------------------------------------------------------------ unlocks & identity */
test('profile: unlock / hasUnlock', () => {
  fresh();
  assert.equal(P.unlock('parts', 'engine.types', 'w16'), true);
  assert.equal(P.unlock('parts', 'engine.types', 'w16'), false);
  assert.equal(P.hasUnlock('parts', 'engine.types', 'w16'), true);
  assert.deepEqual(P.get().unlocks.parts, ['engine.types:w16']);
  P.unlock('tracks', 'monza');
  assert.equal(P.hasUnlock('tracks', 'monza'), true);
  assert.equal(P.hasUnlock('bodyStyles', 'roadster'), false);
});

test('profile: setDriver sanitises identity', () => {
  fresh();
  const r = P.setDriver('  Lewis\u0007 Hamilton  ', 'not-a-color');
  assert.equal(r.driverName, 'Lewis Hamilton');
  assert.match(r.avatarColor, /^#/);
  assert.equal(P.initials(), 'LH');
  assert.equal(P.initials('max'), 'M');
});

test('profile: quota pressure sheds bulky data instead of failing', () => {
  const store = fakeStorage();
  fresh(store);
  P.addCar({ meta: {} }, { name: 'Big', thumbnail: 'x'.repeat(50000) });
  // now impose a quota smaller than the thumbnail
  const quota = fakeStorage({ quota: 20000 });
  Object.assign(quota.data, store.data);
  P._setStorage(quota);
  P.load();
  assert.equal(P.save(), true);
  assert.equal(P.get().ownedCars[0].thumbnail, null);
  assert.ok(quota.data[P.STORAGE_KEY].length < 20000);
});

/* leave the singleton in a clean memory-backed state for other test files */
test('profile: teardown', () => { P._setStorage('memory'); P.load(); P.reset(); });

test('profile: Contacts stat matches the results screen (session tally / intensity-filtered events, not raw engine bumps)', () => {
  // race UI tally on the results root wins over the raw per-car engine counter
  const r1 = engineResults({ collisions: 5 }); r1.collisions = 0;
  assert.equal(P.summarizeRace(r1, { trackId: 'monza' }).crashes, 0);
  // engine events: only the player's contacts with intensity >= 0.35 count, debounced
  const r2 = engineResults({ collisions: 6 });
  r2.events = [
    { type: 'collision', carId: 'player', intensity: 0.1, t: 1 }, { type: 'wall', carId: 'player', intensity: 0.2, t: 5 },
    { type: 'collision', carId: 'player', intensity: 0.5, t: 10 }, { type: 'collision', carId: 'player', intensity: 0.6, t: 10.3 },
    { type: 'wall', carId: 'player', intensity: 0.9, t: 20 }, { type: 'collision', carId: 'ai1', intensity: 0.9, t: 30 }
  ];
  assert.equal(P.summarizeRace(r2, { trackId: 'monza' }).crashes, 2);
  // no tally and no events: the engine counter is all there is
  assert.equal(P.summarizeRace(engineResults({ collisions: 3 }), { trackId: 'monza' }).crashes, 3);
});

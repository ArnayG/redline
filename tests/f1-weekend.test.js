/* F1 weekend / championship (docs/F1-SPEC.md §6): points 25-18-15-12-10-8-6-4-2-1 (+1 fastest lap in the top 10),
   DNFs score nothing, qualifying grid by best lap, weekend session flow, season standings with count-back, storage. */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
['js/f1/f1-teams.js', 'js/f1/f1-weekend.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, W = CB.f1.weekend, T = CB.f1.teams;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('f1-weekend: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

/** A finishing order of all 22 cars: the player at `pp`, AI ids from the teams module. */
function race(pp, opts) {
  opts = opts || {};
  var ids = [];
  T.list.forEach(function (t) { t.drivers.forEach(function (d, i) { if (!(t.id === 'ferrari' && i === 0)) ids.push('f1-' + d.id); }); });
  ids.splice(pp - 1, 0, 'player');
  return { classification: ids.map(function (id, i) {
    return { id: id, isPlayer: id === 'player', name: id === 'player' ? 'You' : id, position: i + 1, status: opts.dnf === id ? 'dnf' : 'finished',
      bestLap_s: 80 + i * 0.1 + (opts.fl === id ? -5 : 0), gridPosition: 22 - i, pitStops: 1 };
  }) };
}

test('points table and fastest-lap point', function () {
  assert.deepStrictEqual(W.POINTS, [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]);
  var r = race(1, { fl: 'player' });
  var s = W.score(r, { fastestLapPoint: true, playerTeam: 'ferrari' });
  assert.strictEqual(s.length, 22);
  assert.strictEqual(s[0].points, 26, 'win + fastest lap');
  assert.strictEqual(s[0].teamId, 'ferrari');
  assert.strictEqual(s[1].points, 18);
  assert.strictEqual(s[9].points, 1);
  assert.strictEqual(s[10].points, 0);
  var total = s.reduce(function (a, x) { return a + x.points; }, 0);
  assert.strictEqual(total, 101 + 1);
  // fastest lap outside the top 10 earns nothing; option off gives nothing
  var r2 = race(15, { fl: 'player' });
  assert.strictEqual(W.score(r2, { fastestLapPoint: true, playerTeam: 'ferrari' })[14].points, 0);
  assert.strictEqual(W.score(race(1, { fl: 'player' }), { fastestLapPoint: false, playerTeam: 'ferrari' })[0].points, 25);
});

test('DNF scores nothing; positions gained from the grid', function () {
  var r = race(3, { dnf: 'player' });
  var s = W.score(r, { playerTeam: 'ferrari' });
  assert.strictEqual(s[2].points, 0);
  var ok = W.score(race(5), { playerTeam: 'ferrari' })[4];
  assert.strictEqual(ok.gridPosition, 18);
  assert.strictEqual(ok.gained, 13);
});

test('qualifying grid by best lap, no-time cars at the back', function () {
  var rows = [
    { id: 'a', bestLap_s: 81.2, position: 1 }, { id: 'player', isPlayer: true, bestLap_s: 80.5, position: 2 },
    { id: 'b', bestLap_s: null, position: 3 }, { id: 'c', bestLap_s: 80.9, position: 4 }];
  assert.deepStrictEqual(W.gridFrom(rows), ['player', 'c', 'a', 'b']);
});

test('weekend: practice -> qualifying (sets the grid) -> race', function () {
  var w = W.createWeekend({ circuitId: 'f1-monza', format: 'weekend' });
  assert.deepStrictEqual(w.sessions.map(function (s) { return s.id; }), ['practice', 'qualifying', 'race']);
  assert.strictEqual(W.currentSession(w).id, 'practice');
  W.skipSession(w);
  assert.strictEqual(W.currentSession(w).id, 'qualifying');
  W.recordSession(w, 'qualifying', { classification: [{ id: 'f1-hale', bestLap_s: 79 }, { id: 'player', isPlayer: true, bestLap_s: 78.5 }] });
  assert.deepStrictEqual(w.grid, ['player', 'f1-hale']);
  assert.strictEqual(W.currentSession(w).id, 'race');
  assert.strictEqual(W.skipSession(w), w, 'the race cannot be skipped');
  assert.strictEqual(W.currentSession(w).id, 'race');
  W.recordSession(w, 'race', race(2));
  assert.ok(W.isComplete(w));
  var q = W.createWeekend({ circuitId: 'f1-monza', format: 'quick' });
  assert.deepStrictEqual(q.sessions.map(function (s) { return s.id; }), ['race']);
  assert.doesNotThrow(function () { JSON.stringify(w); });
});

test('season: points add up, standings sort, constructors combine both cars', function () {
  var s = W.createSeason({ rounds: ['f1-monza', 'f1-spa', 'f1-suzuka'] });
  assert.strictEqual(s.weekend.circuitId, 'f1-monza');
  W.applyRound(s, W.score(race(1), { playerTeam: 'ferrari' }));                          // win + fastest lap: 26
  W.applyRound(s, W.score(race(2), { playerTeam: 'ferrari', fastestLapPoint: false }));  // P2: 18
  assert.strictEqual(s.round, 2);
  assert.strictEqual(s.weekend.circuitId, 'f1-suzuka');
  var st = W.standings(s);
  var me = st.drivers.filter(function (d) { return d.isPlayer; })[0];
  assert.strictEqual(me.points, 44);
  assert.strictEqual(me.position, 1);
  assert.strictEqual(st.drivers.length, 22);
  assert.strictEqual(st.constructors.length, 11);
  var fer = st.constructors.filter(function (c) { return c.id === 'ferrari'; })[0];
  assert.ok(fer.points >= 44, 'player points count for the team');
  for (var i = 1; i < st.drivers.length; i++) assert.ok(st.drivers[i - 1].points >= st.drivers[i].points);
  W.applyRound(s, W.score(race(3), { playerTeam: 'ferrari' }));
  assert.ok(W.isSeasonOver(s));
  assert.strictEqual(s.weekend, null);
  assert.strictEqual(W.applyRound(s, []).round, 3, 'no round past the end');
});

test('count-back breaks ties on wins', function () {
  var tot = { drivers: {
    a: { id: 'a', name: 'A', points: 25, wins: 0, finishes: [2, 2, 99], best: 2 },
    b: { id: 'b', name: 'B', points: 25, wins: 1, finishes: [1, 99, 99], best: 1 } }, constructors: {} };
  assert.deepStrictEqual(W.standings(tot).drivers.map(function (d) { return d.id; }), ['b', 'a']);
});

test('storage round-trip on a fake localStorage', function () {
  var mem = {}, ls = { getItem: function (k) { return mem[k] || null; }, setItem: function (k, v) { mem[k] = String(v); }, removeItem: function (k) { delete mem[k]; } };
  var st = W.store(ls);
  assert.strictEqual(st.load(), null);
  var s = W.createSeason({ rounds: ['f1-monza', 'f1-spa'] });
  st.save(s);
  assert.strictEqual(st.load().rounds.length, 2);
  st.clear();
  assert.strictEqual(st.load(), null);
  st.saveSettings({ team: 'haas' });
  assert.strictEqual(st.loadSettings().team, 'haas');
  var stats = st.stats(); stats.races = 3; st.saveStats(stats);
  assert.strictEqual(st.stats().races, 3);
  assert.ok(mem['forge.f1.save.v1'] === undefined && mem['forge.f1.settings.v1']);
});

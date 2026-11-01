/* REDLINE — regressions from the race / drift / arcade / replay QA sweep (race-ui, audio, replay helpers). */
'use strict';
var path = require('path');
var fs = require('fs');
var JS = path.join(__dirname, '..', 'js');
var ui = require(path.join(JS, 'race', 'race-ui.js'));
var _ = ui._;
['race/tracks.js', 'race/drift/scoring.js'].forEach(function (f) { try { require(path.join(JS, f)); } catch (e) { /* optional */ } });
var CB = globalThis.CB;

test('race qa: a car with no gap yet (session ended on the grid) reads "—", not "+—*"', function () {
  var snap = { mode: 'race', cars: [
    { id: 'a', position: 1, finished: false, lap: 0 },
    { id: 'b', position: 2, finished: false, lap: 0 },
    { id: 'c', position: 3, finished: false, lap: 0, gapLeader_s: 1.5 }
  ] };
  var raw = { classification: [
    { id: 'a', status: 'running', gapText: 'Leader' },
    { id: 'b', status: 'running', gapText: '+--:--.---' },
    { id: 'c', status: 'running', gapText: '+0:01.500' }
  ] };
  var r = _.normalizeResults(raw, snap, { mode: 'race' });
  assert.equal(r.rows[1].gapText, '—');
  assert.equal(r.rows[2].gapText, '+1.500*');
});

test('race qa: a near-black team colour never becomes an invisible lap-chart series', function () {
  assert.equal(_.chartColor('#111111', '#ff3d00'), '#ff3d00');
  assert.equal(_.chartColor('#000', '#050505'), '#8a8f98');
  assert.equal(_.chartColor('#3fa9f5', '#000'), '#3fa9f5');
  assert.equal(_.chartColor(null, null), '#8a8f98');
});

test('race qa: the setup\'s drift-zone count is the scorer\'s real count (HUD "0/N"), not just the hints', function () {
  if (!CB.race || !CB.race.tracks || !CB.race.drift || !CB.race.drift.scoring) return;
  var T = CB.race.tracks, def = T.get('shuto-night-loop') || T.list()[0];
  var n = _.driftZoneCount(def);
  assert.equal(n, CB.race.drift.scoring.generateZones(T.build(def), def, {}).length);
  if (Array.isArray(def.driftZones)) assert.ok(n >= def.driftZones.length);
});

test('race qa: car-to-car contact counts for the player when the player is the event\'s other car', function () {
  var src = fs.readFileSync(path.join(JS, 'race', 'race-ui.js'), 'utf8');
  assert.match(src, /var mine = ev\.carId === myId \|\| \(ev\.type === 'collision' && ev\.otherId != null && ev\.otherId === myId\)/);
  var au = fs.readFileSync(path.join(JS, 'race', 'audio.js'), 'utf8');
  assert.match(au, /e\.type === 'collision' && e\.otherId != null && e\.otherId === pid/);
  // engine emits a contact once, for the lower-index car, with the other car's id
  var en = fs.readFileSync(path.join(JS, 'race', 'engine.js'), 'utf8');
  assert.match(en, /emit\('collision', a,[^\n]*\n\s*\{ otherId: b\.id/);
});

test('race qa: "Clean race" needs a finished race (not one abandoned on the grid)', function () {
  var src = fs.readFileSync(path.join(JS, 'race', 'race-ui.js'), 'utf8');
  assert.match(src, /!myRow\.dnf && \(myRow\.finished \|\| myRow\.status === 'finished'\)\) badge\('Clean race'/);
});

test('race qa: career / event intros are labelled with the event, not "Grand Prix"; the grid panel fits its field', function () {
  var src = fs.readFileSync(path.join(JS, 'race', 'race-ui.js'), 'utf8');
  assert.match(src, /text: loadingKicker\(def, S\)/);
  assert.match(src, /\.rx-grid-panel\{[^}]*align-self:start/);
});

test('replay qa: a drift run is labelled "Drift · …" (not "Practice"), and "1 car" is singular', function () {
  var rp = fs.readFileSync(path.join(JS, 'game', 'replay.js'), 'utf8');
  assert.match(rp, /modeLabel: M\.modeLabel \|\| null/);
  assert.match(rp, /function carsText\(n\) \{ n = n \|\| 0; return n \+ \(n === 1 \? ' car' : ' cars'\); \}/);
  assert.ok(!/inf\.cars \+ ' cars'|li\.cars \+ ' cars'/.test(rp), 'every replay label uses carsText');
  var src = fs.readFileSync(path.join(JS, 'race', 'race-ui.js'), 'utf8');
  assert.match(src, /rep\.meta\.modeLabel = R\.isArcade \? 'Arcade' : sessionLabel\(R\.settings\)/);
  assert.equal(_.sessionLabel({ discipline: 'drift', driftMode: 'score' }).indexOf('Drift · '), 0);
});

test('race-ui: the "Rotate your phone" card hides once the race is running (and comes back on a restart)', function () {
  var src = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'race', 'race-ui.js'), 'utf8');
  var i = src.indexOf('function updateRaceDom');
  assert.ok(/R\.rotateHidden[\s\S]{0,200}snap\.phase === 'racing'[\s\S]{0,200}classList\.add\('is-dismissed'\)/.test(src.slice(i, i + 900)));
  assert.ok(/R\.rotateHidden = false/.test(src));
  assert.ok(/rot\.classList\.remove\('is-dismissed'\)/.test(src));
});

test('audio: Settings > Audio sliders map onto every mode (race / derby / arcade read CB.race.audio.mix)', function () {
  var A = require(path.join(JS, 'race', 'audio.js'));
  assert.equal(typeof A.mix, 'function');
  var d = A.mix({ audio: { master: 0.8, engine: 0.9, sfx: 0.8 } });
  assert.equal(d.master, 0.8); assert.ok(Math.abs(d.engine - 1) < 1e-9); assert.ok(Math.abs(d.sfx - 1) < 1e-9);
  var q = A.mix({ audio: { master: 0.3, engine: 0, sfx: 0.4 } });
  assert.equal(q.master, 0.3); assert.equal(q.engine, 0); assert.ok(Math.abs(q.sfx - 0.5) < 1e-9);
  assert.equal(A.mix({}).master, 0.8, 'missing keys fall back to the defaults');
  var src = fs.readFileSync(path.join(JS, 'derby', 'derby-sfx.js'), 'utf8');
  assert.ok(/CB\.race\.audio\.mix\(\)/.test(src) && /S\.engBus/.test(src) && !/connect\(S\.master\)/.test(src));
  assert.ok(/CB\.race\.audio\.mix\(\)/.test(fs.readFileSync(path.join(JS, 'arcade', 'arcade-sfx.js'), 'utf8')));
});

test('race-ui: Settings difficulty is the default AI level (first visit and after changing it); a setup pick sticks until then', function () {
  var prevP = CB.game && CB.game.profile, store = {};
  var ls = globalThis.localStorage;
  globalThis.localStorage = { getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } };
  CB.game = CB.game || {};
  var diff = 'pro';
  CB.game.profile = { getSetting: function (k) { return k === 'difficulty' ? diff : undefined; } };
  try {
    assert.equal(_.loadSettings().difficulty, 'pro', 'first visit');
    var s = _.loadSettings(); s.difficulty = 'rookie'; _.saveSettings ? _.saveSettings(s) : store['forge.race.settings.v1'] = JSON.stringify(s);
    assert.equal(_.loadSettings().difficulty, 'rookie', 'a setup pick is remembered');
    diff = 'alien';
    assert.equal(_.loadSettings().difficulty, 'alien', 'changing Settings applies');
  } finally { CB.game.profile = prevP; globalThis.localStorage = ls; }
});

test('hud: numbered names stay whole on the tower ("DRIVER 2", not "D. 2"); real names still shorten', function () {
  var HUD = require(path.join(JS, 'race', 'hud.js'));
  var I = (HUD && HUD._internal) || (CB.race.hud && CB.race.hud._internal);
  assert.equal(I.surname('Driver 2'), 'DRIVER 2');
  assert.equal(I.surname('Hana Jelinek'), 'H. JELINEK');
  assert.equal(I.tla('Driver 2'), 'DR2');
  assert.equal(I.tla('Car 12'), 'C12');
  assert.equal(I.tla('Hana Jelinek'), 'JEL');
});

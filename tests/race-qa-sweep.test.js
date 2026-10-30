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

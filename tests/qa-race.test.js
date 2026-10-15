/* Redline — QA sweep regressions (race / drift / results flows). Run: node tests/run.js qa-race */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const tryReq = (p) => { try { return require(path.join(root, p)); } catch (e) { return null; } };
tryReq('js/util.js');
tryReq('js/data.js');
tryReq('js/game/profile.js');
tryReq('js/game/economy.js');
const A = require(path.join(root, 'js/game/achievements.js'));

const NOW = Date.UTC(2026, 5, 15, 14, 0, 0);
const fresh = () => ({ credits: 150000, xp: 0, level: 1, achievements: {}, stats: {}, ownedCars: [] });
function results(mode, pos) {
  const rows = [];
  for (let i = 1; i <= 8; i++) rows.push({ position: i, id: i === pos ? 'player' : 'ai' + i, name: 'D' + i, isPlayer: i === pos, status: 'finished', laps: 3,
    totalTime_s: 200 + i, penalties_s: 0, bestLap_s: 60 + i, collisions: 0, trackLimits: 0, gridPosition: i, topSpeed_kph: 240, positionsByLap: [i, i, i] });
  return { mode, trackId: 'forge-speedway', trackLength_m: 3000, lapsTotal: 3, complete: true, classification: rows, player: rows[pos - 1], playerId: 'player', events: [] };
}

test('achievements: a Practice session (ranked by best lap, grid order start) gives no win / podium / pole', () => {
  const got = A.check(fresh(), { type: 'race-finished', results: results('practice', 1), config: { mode: 'practice', laps: 3 } }, { toast: false, persist: false, now: NOW }).map((a) => a.id);
  ['first-win', 'champagne', 'pole-sitter', 'grand-slam'].forEach((id) => assert.ok(!got.includes(id), id + ' unlocked by practice: ' + got));
  const race = A.check(fresh(), { type: 'race-finished', results: results('race', 1), config: { mode: 'race', laps: 3 } }, { toast: false, persist: false, now: NOW }).map((a) => a.id);
  ['first-win', 'champagne', 'pole-sitter'].forEach((id) => assert.ok(race.includes(id), id + ' not unlocked by a race win: ' + race));
});

test('replay photo mode: syncs the Subject picker on first open and ignores a camera that is not aimed at the car', () => {
  const src = fs.readFileSync(path.join(root, 'js/game/replay.js'), 'utf8');
  const open = src.slice(src.indexOf('    function open() {\n      if (S.active) return;'));
  const body = open.slice(0, open.indexOf('    function close()'));
  assert.match(body, /if \(!S\.panel\) buildPanel\(\);[^\n]*\n\s*syncSliders\(\);/, 'panel must be synced after it is first built');
  assert.match(body, /Math\.hypot\(cs0\.target\[0\] - pz0\.x, -cs0\.target\[2\] - pz0\.y\) > 8\) cs0 = null/, 'stale camera fallback');
});

test('WebGL context restore: post and the GPU timer never delete objects of the lost context', () => {
  const post = fs.readFileSync(path.join(root, 'js/race/gl/post.js'), 'utf8');
  assert.match(post, /function stale\(\) \{ return lost\(\) \|\| num\(ctx\.generation, 0\) !== S\.gen; \}/);
  assert.match(post, /function freeTarget\(t\) \{\n\s*if \(!t \|\| stale\(\)\) return;/);
  assert.match(post, /post\.destroy = function \(\) \{\n\s*if \(!stale\(\)\) \{/);
  const r3 = fs.readFileSync(path.join(root, 'js/race/gl/renderer3d.js'), 'utf8');
  assert.match(r3, /if \(S\.gpuTimer && !reuse\) safe\('gpuTimer\.destroy'/);
});

test('results footer: the keyboard hint never wraps (hidden on narrow screens)', () => {
  const ui = fs.readFileSync(path.join(root, 'js/race/race-ui.js'), 'utf8');
  assert.equal((ui.match(/class: 'rx-dim rx-res-keys'/g) || []).length, 2);
  assert.match(ui, /\.rx-res-keys\{white-space:nowrap\}@media \(max-width:1360px\)\{#race-root \.rx-res-foot \.rx-res-keys\{display:none\}\}/);
});

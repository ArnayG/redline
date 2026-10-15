/* Redline — QA sweep regressions found while integrating (achievements + Garage). Run: node tests/run.js qa-integration */
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });
const root = path.join(__dirname, '..');
function load(rel) { const p = path.join(root, rel); if (fs.existsSync(p)) require(p); }
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach(load);
fs.readdirSync(path.join(root, 'js', 'shapes', 'models')).filter((f) => f.endsWith('.js')).sort().forEach((f) => load('js/shapes/models/' + f));
['js/shapes/stock-specs.js', 'js/state.js', 'js/physics.js', 'js/game/profile.js', 'js/game/economy.js', 'js/game/achievements.js'].forEach(load);
const CB = globalThis.CB, A = CB.game.achievements;
const opts = { toast: false, persist: false, now: Date.UTC(2026, 5, 15, 14, 0, 0) };
const fresh = () => ({ credits: 150000, xp: 0, level: 1, achievements: {}, stats: {}, ownedCars: [] });
const ids = (l) => l.map((a) => a.id);
const PAYING = ['first-commission', 'bespoke', 'seven-figures', 'half-thousand', 'thousand-horses', 'three-second-club', 'silent-running', 'best-of-both'];
const ev = (b) => ({ type: 'build-changed', build: b, metrics: CB.physics.compute(b) });

test('achievements: loading a preset unchanged pays no build achievements; showroom tour still counts', () => {
  const P = fresh(), got = new Set();
  CB.data.presets.forEach((p) => {
    const b = CB.state.normalize(CB.data.presetBuild(p.id));
    assert.equal(A._internal.normalizeBuild(ev(b)).unmodified, true, p.id);
    ids(A.check(P, ev(b), opts)).forEach((i) => got.add(i));
  });
  PAYING.forEach((id) => assert.ok(!got.has(id), id + ' unlocked from an untouched preset'));
  assert.ok(!got.has('body-collector') && !got.has('engine-sommelier'));
  assert.ok(got.has('showroom-tour'), 'loading 8 presets is the Showroom Tour');
  assert.equal(P.credits, 150000 + (A.get('showroom-tour').credits || 0));
});

test('achievements: Auto-config (stock spec) builds pay nothing until customised', () => {
  const ids0 = Object.keys(CB.stock.SPECS).slice(0, 6);
  const P = fresh();
  ids0.forEach((m) => {
    const r = CB.stock.build(m); if (!r) return;
    const b = CB.state.normalize(r.build);
    assert.equal(CB.stock.isStock(b), true, m);
    assert.deepEqual(ids(A.check(P, ev(b), opts)).filter((i) => PAYING.indexOf(i) >= 0), [], m);
  });
  assert.equal(P.credits, 150000);
});

test('achievements: a customised preset counts', () => {
  const P = fresh();
  const p = CB.data.presets[0];
  const b = CB.state.normalize(CB.data.presetBuild(p.id));
  b.exterior.paint = b.exterior.paint === '#123456' ? '#654321' : '#123456';
  assert.equal(A._internal.normalizeBuild(ev(b)).unmodified, false);
  assert.ok(ids(A.check(P, ev(b), opts)).includes('first-commission'));
});

/* source-level guards for browser-only fixes (verified in headless Chrome during the QA sweep) */
const src = (f) => fs.readFileSync(path.join(root, f), 'utf8');
test('webcam setup dialog is modal: aria-modal, Tab trap, focus returns to the opener', () => {
  const s = src('js/input/camwheel-ui.js');
  assert.match(s, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(s, /e\.key === 'Tab'\) trapTab\(e, ov\)/);
  assert.match(s, /d\.opener\.focus/);
});
test('3D car LOD uses on-screen size (fov-scaled distance), so zoomed replay / TV cameras show real models', () => {
  const s = src('js/race/gl/renderer3d.js');
  assert.match(s, /ce\.lodDist = ce\.dist \* lodScale/);
  assert.match(s, /oe\.lodDist < S\.Q\.lodNear/);
});
test('free-race player row uses the driver name, not "Untitled Build (you)"', () => {
  const s = src('js/race/race-ui.js');
  assert.match(s, /playerName: playerDriverName\(\)/);
});
test('showroom: a disabled Buy says why (title + locked heading); class chip has a text label', () => {
  const s = src('js/game/hub.js');
  assert.match(s, /title: locks\.length \? 'Locked: '/);
  assert.match(s, /Buy is locked: /);
  assert.match(s, /piBadge\(build, 'Your car'\)/);
  assert.match(s, /aria-label="' \+ esc\(\(label/);
});

test('race engine: no "+race clock" gaps off the grid; real gaps once cars reach the leader\'s points', () => {
  ['js/race/tracks.js', 'js/race/vehicle.js', 'js/race/ai.js'].forEach(load);
  const E = require(path.join(root, 'js/race/engine.js'));
  const mem = {}; const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; }, keys: () => Object.keys(mem) };
  const s = E.createSession({ laps: 2, opponents: 7, seed: 77, mode: 'race', storage, difficulty: 'pro', playerAutopilot: true });
  let early = null, later = null, earlyT = 0;
  while (s.getPhase() !== 'racing' && s.time() < 60) s.update(0.1, {});
  const go = s.time();
  while (s.time() < go + 40) {
    s.update(0.1, {});
    const sn = s.snapshot(), back = sn.cars.slice().sort((a, b) => a.position - b.position).slice(1);
    if (s.time() > go + 0.8 && s.time() < go + 1.2 && !early) { early = back; earlyT = s.time() - go; }
    if (s.time() > go + 35) later = back;
  }
  const clock = (c) => typeof c.gapLeader_s === 'number' && Math.abs(c.gapLeader_s - earlyT) < 0.05;
  assert.ok(early.some((c) => c.gapLeader_s === null), 'some cars behind have no gap yet just after the start');
  assert.ok(!early.some(clock), 'no gap equal to the race clock');
  assert.ok(later.every((c) => c.finished || typeof c.gapLeader_s === 'number'), 'everyone has a real gap later on');
});

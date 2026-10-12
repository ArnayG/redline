/* FORGE Atelier — game hub (js/game/hub.js) pure helpers. Runs under tests/run.js. */
'use strict';
const path = require('path');
const root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/game/profile.js', 'js/game/economy.js', 'js/game/career.js', 'js/game/hub.js']
  .forEach((f) => { try { require(path.join(root, f)); } catch (e) { if (/hub\.js$/.test(f)) throw e; } });
const HUB = globalThis.CB.game.hub;
const T = (n, f) => globalThis.test('hub: ' + n, f);

T('loads in Node without a DOM and lists every screen', () => {
  assert.equal(typeof HUB.open, 'function');
  ['title', 'menu', 'career', 'trophies', 'championship', 'event', 'briefing', 'rewards', 'quickrace', 'timetrial', 'challenges',
    'garage', 'showroom', 'workshop', 'achievements', 'replays', 'profile', 'settings'].forEach((s) => assert.ok(HUB.screens.includes(s), s));
  assert.equal(HUB.current, null);
});

T('xpSegments walks across level boundaries and ends on the right level', () => {
  const curve = (l) => 1000 * l;               // L1 1000, L2 2000, L3 3000
  const one = HUB._.xpSegments(600, 300, 1, curve);
  assert.equal(one.length, 1);
  assert.equal(one[0].level, 1);
  assert.ok(Math.abs(one[0].to - 0.9) < 1e-9);
  // 600 XP + 465 (race 165 + achievement XP granted during the race 300) crosses into level 2
  const two = HUB._.xpSegments(600, 465, 1, curve);
  assert.equal(two[0].levelUp, true);
  assert.equal(two[two.length - 1].level, 2);
  assert.ok(Math.abs(two[two.length - 1].to - 65 / 2000) < 1e-9);
  // multi-level jump
  const many = HUB._.xpSegments(0, 6500, 1, curve);
  assert.equal(many.filter((s) => s.levelUp).length, 3);
  assert.equal(many[many.length - 1].level, 4);
});

T('levelFromXp agrees with xpSegments', () => {
  const curve = (l) => 1000 * l;
  assert.equal(HUB._.levelFromXp(999, curve), 1);
  assert.equal(HUB._.levelFromXp(1000, curve), 2);
  assert.equal(HUB._.levelFromXp(3000, curve), 3);
  const segs = HUB._.xpSegments(0, 3000, 1, curve);
  assert.equal(segs[segs.length - 1].level, HUB._.levelFromXp(3000, curve));
});

T('formatters are stable', () => {
  assert.equal(HUB._.ordinal(1), '1st');
  assert.equal(HUB._.ordinal(2), '2nd');
  assert.equal(HUB._.ordinal(11), '11th');
  assert.equal(HUB._.ordinal(23), '23rd');
  assert.match(HUB._.fmtTime(83.456), /1:23\.45/);
});

T('route changes dismiss only transient UI opened under a different route', () => {
  const S = HUB._.staleOverlays;
  assert.deepEqual(S({}, '#/garage'), []);
  // Sell dialog on #/garage, then Back to #/menu: the dialog goes
  assert.deepEqual(S({ modal: '#/garage' }, '#/menu'), ['modal']);
  // same route (re-render / refresh): kept
  assert.deepEqual(S({ modal: '#/garage' }, '#/garage'), []);
  // a modal action that navigates itself is not cancelled under its own handler
  assert.deepEqual(S({ modal: '#/garage', inAction: true }, '#/career'), []);
  // replay viewer / library and the achievements gallery
  assert.deepEqual(S({ overlay: '#/replays', gallery: '#/achievements' }, '#/garage'), ['overlay', 'gallery']);
  assert.deepEqual(S({ overlay: '#/replays' }, '#/replays'), []);
});

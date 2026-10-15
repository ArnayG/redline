/* Redline — QA sweep regressions for the meta screens (hub dialogs, settings sliders, profile focus, achievements
   detail card, challenge results, replays empty state, storage warning). Runs under tests/run.js. */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/game/profile.js', 'js/game/economy.js', 'js/game/career.js',
  'js/game/achievements.js', 'js/game/hub.js'].forEach((f) => { try { require(path.join(root, f)); } catch (e) { if (/hub\.js$|achievements\.js$/.test(f)) throw e; } });
const CB = globalThis.CB;
const src = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const T = (n, f) => globalThis.test('qa-meta: ' + n, f);

T('settings sliders are named after their row (screen readers announced an unlabeled slider)', () => {
  const html = CB.game.hub._.rowHTML('Master volume', '', '<input type="range" class="gh-range" min="0" max="1">');
  assert.match(html, /<input type="range" aria-label="Master volume"/);
  // an explicit label is kept
  const own = CB.game.hub._.rowHTML('X', '', '<input type="range" aria-label="Own" min="0">');
  assert.ok(!/aria-label="X"/.test(own));
});

T('hub dialogs are modal dialogs and trap Tab', () => {
  const s = src('js/game/hub.js');
  assert.match(s, /card\.setAttribute\('role', 'dialog'\);\s*card\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(s, /k === 'Tab' && H\.modal && H\.modal\.card/);
});

T('automatic hub focus never puts the caret in a text field (phone keyboard popped on every Profile visit)', () => {
  const s = src('js/game/hub.js');
  assert.match(s, /!\(silent && textField\)/);
  assert.match(s, /data-key="name" maxlength="24" aria-label="Driver name"/);
});

T('the webcam setup dialog counts as a foreign modal (Esc there also navigated the hub back)', () => {
  assert.match(src('js/game/hub.js'), /querySelectorAll\('\[aria-modal="true"\], \.gach-overlay, \.cw-ov'\)/);
});

T('storage blocked / full shows a one-time warning', () => {
  assert.match(src('js/game/hub.js'), /Progress can’t be saved in this browser/);
});

T('replays empty state points at the real Save button', () => {
  const s = src('js/game/hub.js');
  assert.ok(!/press “Save replay” on the results screen/.test(s));
  assert.match(s, /press “Watch replay” on the results screen, then “Save”/);
});

T('achievement detail card is a modal dialog with its own Tab trap', () => {
  const A = CB.game.achievements;
  const html = A._internal.detailHTML(null, A._internal.DEFS[0].id);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(src('js/game/achievements.js'), /wrap\.querySelector\('\.gach-detail-card'\) \|\| modal/);
});

T('challenge launches get the one-shot "Continue · rewards" results and a challenge title', () => {
  const s = src('js/race/race-ui.js');
  assert.match(s, /k === 'career' \|\| k === 'event' \|\| k === 'challenge'/);
  assert.match(s, /chName \+ ' · ' \+ \(chEval\.failed/);
});

T('race setup brand mark is Redline, not the old FORGE "F"', () => {
  assert.ok(!/rx-brand-mark', text: 'F'/.test(src('js/race/race-ui.js')));
});

T('results subtitle names the real model when the build still has the default name', () => {
  assert.match(src('js/race/race-ui.js'), /function resultBuildName\(\)/);
});

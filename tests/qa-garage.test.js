/* Redline — Garage QA regressions (QA sweep, Oct 2026).
   1. CB.ui.modal's focus trap wraps Tab / Shift+Tab when focus sits on the dialog card itself (Saved builds,
      Compare, Spec sheet open with the card focused) or has left the dialog; Shift+Tab used to escape to the page.
   2. Ghost / danger buttons keep the keyboard focus ring (.cb-btn.ghost's box-shadow reset used to override
      .cb-btn:focus-visible, so Presets, Auto-config, Saved builds, the nav gear ... showed no focus at all).
   3. A broken or truncated #b= share link warns the player instead of silently keeping their build (boot) or
      announcing "Loaded shared build" for a code that did not decode (in-session hashchange). */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('qa-garage: modal focus trap wraps from the card itself and from outside the dialog', () => {
  const src = read('js/ui-kit.js');
  const i = src.indexOf("ev.key === 'Tab'");
  assert.ok(i > 0, 'Tab handler present');
  const body = src.slice(i, i + 1200);
  assert.match(body, /act === card \|\| !card\.contains\(act\)/, 'wraps when the card or an outside element has focus');
  assert.match(body, /getClientRects/, 'skips hidden focusables (a hidden footer button cannot take focus)');
});

test('qa-garage: ghost and danger buttons restore the keyboard focus ring after their box-shadow reset', () => {
  const css = read('css/styles.css');
  const reset = css.indexOf('.cb-btn.ghost.danger {');
  const ghost = css.indexOf('.cb-btn.ghost {');
  const fix = css.indexOf('.cb-btn.ghost:focus-visible');
  assert.ok(ghost > 0 && reset > 0, 'ghost rules present');
  assert.ok(fix > reset && fix > ghost, 'focus-visible override comes after the ghost / danger resets');
  assert.match(css.slice(fix, fix + 160), /box-shadow:\s*var\(--focus\)/);
});

test('qa-garage: broken share codes do not decode, and the Garage warns about them on boot and hashchange', () => {
  require('../js/util.js'); require('../js/data.js');
  const S = require('../js/state.js');
  assert.equal(S.decode('garbage!!!'), null);
  assert.equal(S.decode('v1.eyJib2R5Ijp7'), null, 'truncated code');
  const good = S.encode(S.get());
  assert.ok(S.decode(good), 'a full code still decodes');
  const app = read('js/app.js');
  assert.match(app, /else if \(params\.b\) \{ stripShareParam\(\); toast\(BAD_SHARE_MSG/, 'boot warns on an undecodable #b=');
  assert.match(app, /okCode \? 'Loaded shared build' : BAD_SHARE_MSG/, 'hashchange only claims success for a valid code');
});

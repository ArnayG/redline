/* Redline — keyboard / dialog accessibility regressions found in the QA sweep (static checks on the source). */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const HUB = src('js/game/hub.js');
const PW = src('js/input/input-ui.js');
const SS = src('js/input/sources.js');
const APP = src('js/app.js');

function body(code, sig) {
  const i = code.indexOf(sig); assert.ok(i >= 0, 'missing ' + sig);
  let j = code.indexOf('{', i) + 1, d = 1;
  while (d && j < code.length) { if (code[j] === '{') d++; else if (code[j] === '}') d--; j++; }
  return code.slice(i, j);
}

test('a11y: hub Enter / Space activate the keyboard-focused control, not the stale gamepad highlight', () => {
  const k = body(HUB, '  function onKey(e) {');
  const guard = k.indexOf("if (k === 'Enter' || k === ' ')"), act = k.indexOf('activateFocus()');
  assert.ok(guard > 0 && act > guard, 'Enter guard must run before activateFocus');
  assert.match(k.slice(guard, act), /document\.activeElement/);
  assert.match(k.slice(guard, act), /else return;/, 'non-hub controls (top nav, Buy a car) use native activation');
});

test('a11y: hub highlight follows Tab focus (focusin on data-nav elements)', () => {
  assert.match(HUB, /listen\(root, 'focusin'[\s\S]{0,200}hasAttribute\('data-nav'\)[\s\S]{0,80}setFocusEl\(t, true, true\)/);
});

test('a11y: phone-wheel pairing dialog is modal, traps Tab and restores focus', () => {
  const o = body(PW, '  function openPairing(opts) {');
  assert.match(o, /setAttribute\('aria-modal', 'true'\)/, 'aria-modal lets the hub skip its own Esc = back');
  assert.match(o, /e\.key === 'Tab'/);
  assert.match(o, /card\.focus\(/);
  const c = body(PW, '  function closePairing() {');
  assert.match(c, /prev\.focus\(/);
});

test('a11y: phone-wheel chip does not cover dialog footers', () => {
  assert.match(PW, /html\.cb-modal-open \.pw-chip\{display:none\}/);
});

test('a11y: steering-source picker keeps focus on the picked button across its re-render', () => {
  const r = body(SS, '  function renderInto(root) {');
  assert.match(r, /data-ss-pick/);
  assert.ok(r.indexOf('root.innerHTML') < r.lastIndexOf('.focus('), 'focus restored after the re-render');
});

test('a11y: Garage popover menus hand Tab back to their button (they live at the end of <body>)', () => {
  assert.match(APP, /ev\.key === 'Tab'\) \{ closePop\(\); anchor\.focus\(\); \}/);
});

const RUI = src('js/race/race-ui.js');
test('a11y: race keys stand aside while a dialog is open on top (Esc in phone pairing kept resuming the paused race)', () => {
  const k = body(RUI, '  function onKeyDown(e) {');
  const g = k.indexOf('.pw-overlay'), p = k.indexOf('resumeRace()');
  assert.ok(g > 0 && p > g, 'dialog guard before the pause / resume handling');
  assert.match(k.slice(0, p), /\.cw-ov/);
  assert.match(k.slice(0, p), /\.cb-modal\.is-open/);
});

test('a11y: race setup sliders and steppers have accessible names', () => {
  const f = body(RUI, '  function field(label, control, opts) {');
  assert.match(f, /setAttribute\('aria-label', label\)/);
  assert.match(f, /Decrease/);
});

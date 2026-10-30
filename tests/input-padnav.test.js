/* REDLINE — CB.input.padNav (js/input/input-ui.js): gamepad menu navigation for the screens hub.js does not drive
   (mode setups, results, lobby, Garage, dialogs). QA sweep: on #/race a gamepad could not move, select or go back. */
'use strict';
var path = require('path');
var fs = require('fs');
var assert = require('assert');
require(path.join(__dirname, '..', 'js', 'input', 'input-ui.js'));
var P = globalThis.CB.input.padNav;
function R(l, t, w, h) { return { left: l, top: t, width: w || 100, height: h || 40 }; }

test('padNav.pick: nearest candidate in the pressed direction, aligned ones first', function () {
  var from = R(100, 100);
  var c = [R(100, 200), R(400, 160), R(300, 100), R(100, 0), R(-200, 100)];
  assert.strictEqual(P.pick(from, c, 'down'), 0, 'straight below beats the nearer diagonal');
  assert.strictEqual(P.pick(from, c, 'right'), 2);
  assert.strictEqual(P.pick(from, c, 'up'), 3);
  assert.strictEqual(P.pick(from, c, 'left'), 4);
  assert.strictEqual(P.pick(from, [R(100, 0)], 'down'), -1, 'nothing below: stay');
  assert.strictEqual(P.pick(null, c, 'down'), 0, 'no focus yet: first candidate');
  assert.strictEqual(P.pick(from, [], 'down'), -1);
});

test('padNav: A clicks, B sends Esc, idle while driving / on hub screens / on the wheel page', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'js', 'input', 'input-ui.js'), 'utf8');
  var w = src.slice(src.indexOf('function wanted()'), src.indexOf('function candidates()'));
  assert.ok(/cb-driving/.test(w) && /claimsPage/.test(w) && /game-hub/.test(w) && /race-root/.test(w));
  assert.ok(/key: 'Escape'/.test(src) && /a\.click\(\)/.test(src));
});

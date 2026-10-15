/* Arcade UI regressions found in QA (js/race/race-ui.js):
   - the Arcade ITEM / NITRO touch buttons stayed on top of the results table (phones)
   - the camera index follows the camera the renderer actually uses (stunt tracks refuse the saved cockpit cam
     at the start), and C skips cameras the renderer does not take
   - js/arcade/arcade-layer.js: an ITEM key / touch tap shorter than one frame was lost (input is polled per frame) */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var src = fs.readFileSync(path.join(__dirname, '..', 'js', 'race', 'race-ui.js'), 'utf8');

var standalone = require.main === module || typeof globalThis.test !== 'function';
var passed = 0;
function test(name, fn) {
  if (!standalone) return globalThis.test('arcade-ui-qa: ' + name, fn);
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

test('ITEM / NITRO touch buttons are hidden outside the driving screen', function () {
  assert.ok(src.indexOf('#race-root:not([data-screen="race"]) .arc-touch{display:none}') >= 0);
});

test('camera index syncs to the renderer\'s actual camera; C skips refused cameras', function () {
  assert.ok(/camGotIdx >= 0\) R\.cameraIdx = camGotIdx/.test(src), 'start camera synced');
  assert.ok(/typeof gotCam !== 'string' \|\| gotCam === cam\.id\) break/.test(src), 'C skips refused cameras');
});

test('a sub-frame ITEM key or touch tap still fires (120 ms latch)', function () {
  var lay = fs.readFileSync(path.join(__dirname, '..', 'js', 'arcade', 'arcade-layer.js'), 'utf8');
  assert.ok(/L\.keys\.itemT = nowMs\(\)/.test(lay) && /T\[key \+ 'T'\] = nowMs\(\)/.test(lay) && /\|\| tapItem\)/.test(lay));
});

if (standalone) console.log(passed + ' arcade-ui-qa tests passed');

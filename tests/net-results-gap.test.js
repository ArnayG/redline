/* REDLINE — multiplayer results: a car that stops keeps losing time; gaps down the classification never shrink;
   a running car a lap+ behind an unfinished leader reads "+1 Lap" (QA sweep: an early-ended race showed a parked
   car at +22.9 s below a car at +1:25.5). */
'use strict';
var path = require('path');
var assert = require('assert');
var JS = path.join(__dirname, '..', 'js');
['util.js', 'net/netrace.js'].forEach(function (f) { try { require(path.join(JS, f)); } catch (e) { /* optional */ } });
var NR = globalThis.CB.net.race;

test('net results: gaps are monotonic and a stopped car keeps falling behind', function () {
  var RC = NR._internal.RaceControl;
  var rc = new RC({ mode: 'race', laps: 3, L: 800, entrants: [{ carId: 'a', kind: 'human' }, { carId: 'b', kind: 'human' }, { carId: 'c', kind: 'human' }] });
  rc.tick(0, 0, 'racing');
  // a drives on at 20 m/s; b drives 300 m then parks; c parks after 100 m
  for (var t = 0; t <= 60; t += 0.5) {
    rc.feedReported('a', { dist: 20 * t, speed: 20 }, t);
    rc.feedReported('b', { dist: Math.min(300, 20 * t), speed: 0 }, t);
    rc.feedReported('c', { dist: Math.min(100, 20 * t), speed: 0 }, t);
    rc.tick(t, 0, 'racing');
  }
  var res = rc.results(60, true), cls = res.classification;
  assert.deepStrictEqual(cls.map(function (r) { return r.id; }), ['a', 'b', 'c']);
  // b parked at 300 m (a passed it at t=15): ~45 s behind by t=60, not the 0 s it had when it stopped
  var gb = cls[1].gap_s, gc = cls[2].gap_s;
  if (gb !== null) assert.ok(gb > 30, 'parked car keeps losing time: ' + gb);
  if (gb !== null && gc !== null) assert.ok(gc >= gb, 'gaps never shrink down the order: ' + gb + ' / ' + gc);
  // a is 1200 m ahead of c on an 800 m lap: lapped
  assert.ok(/\+1 Lap/.test(cls[2].gapText), cls[2].gapText);
});

test('net lobby: Esc is the back action outside a room (home -> menu, error/connecting -> lobby home)', function () {
  var src = require('fs').readFileSync(path.join(JS, 'net', 'lobby.js'), 'utf8');
  var m = src.match(/function onDocKey\(e\) \{[\s\S]*?\n  \}\n/);
  assert.ok(m, 'document-level Esc handler exists');
  assert.ok(/document\.addEventListener\('keydown', onDocKey\)/.test(src), 'bound on the document (focus may be on body)');
  assert.ok(/view === 'room'\) return/.test(m[0]), 'never leaves a room on Esc');
  assert.ok(/A\.raceOpen/.test(m[0]) && /INPUT/.test(m[0]) && /aria-modal/.test(m[0]), 'skips racing, text fields and dialogs');
  assert.ok(/rt\.go\('menu'\)/.test(m[0]), 'home -> main menu');
});

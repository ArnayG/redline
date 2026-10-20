/* Demolition Derby collision feel from a human's point of view (docs/DERBY-SPEC.md §12): arcade bounce separates cars
   and keeps the attacker moving; a scripted human never stays wedged, recovers fast and is not knocked out by an early
   engine stall. */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
var H = require(path.join(root, 'tools/derby-human.js'));
var CB = globalThis.CB, PH = CB.derby.physics;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('derby feel: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
function car(id, x, y, h, v) {
  var spec = PH.specFromBuild(CB.data.presetBuild('muscle'));
  var c = { id: id, spec: spec };
  PH.createBody(c, { x: x, y: y, heading: h });
  c.vx = Math.cos(h) * v; c.vy = Math.sin(h) * v;
  return c;
}

test('arcade bounce: a T-bone separates the cars at speed, the attacker keeps moving (session follow-through adds more), the victim spins', function () {
  var a = car('a', -2.6, 0, 0, 16), b = car('b', 0, 1.1, Math.PI / 2, 0);
  var ct = PH.collideCars(a, b, { restitution: 0.3, friction: 0.3 });
  assert.ok(ct && ct.vn > 10, 'contact ' + (ct && ct.vn));
  PH.arcadeBounce(a, b, ct, { attacker: a, e: 0.55, minSep: 4.6, attMass: 2.6, spin: 1.6, hop: true });
  var sep = (b.vx - a.vx) * ct.nx + (b.vy - a.vy) * ct.ny;
  assert.ok(sep >= 4.5, 'separating at ' + sep.toFixed(2));
  assert.ok(Math.hypot(a.vx, a.vy) > 3, 'attacker keeps moving: ' + Math.hypot(a.vx, a.vy).toFixed(1));
  assert.ok(Math.abs(b.w) > 0.3, 'victim spins: ' + b.w.toFixed(2));
  assert.ok(PH.collideCars(a, b) === null || PH.collideCars(a, b).depth < 0.05, 'no longer interlocked');
});

test('a scripted human never stays wedged, gets going again fast and is not stalled out early', function () {
  ['mud-bowl', 'junkyard'].forEach(function (ar) {
    var r = H.runHuman({ arena: ar, seed: 1, maxSeconds: 70 });
    assert.ok(r.crashes >= 5, ar + ' crashes ' + r.crashes);
    assert.ok(r.contactMax < 0.25, ar + ' longest contact ' + r.contactMax.toFixed(2));
    assert.ok(r.recoverMed < 0.6, ar + ' median recovery ' + r.recoverMed.toFixed(2));
    assert.ok(r.slowPct < 50, ar + ' slow ' + r.slowPct.toFixed(0) + '%');
    assert.ok(r.bigPerMin >= 8, ar + ' big hits / min ' + r.bigPerMin.toFixed(1));
    assert.ok(r.alive || r.elim !== 'engine' || r.health < 0.12, ar + ' engine stall with ' + r.health.toFixed(2) + ' health');
  });
});

/* REDLINE — regressions from the F1 / Derby / Drag QA follow-up: F1 keeps its nav link lit on the race layer, the
   real season order, one-line circuit stats; Drag cards and "Your car" share one source, creep wording per gearbox,
   custom key bindings, a tach without overlaps, the Controls icon; Derby custom bindings and a de-duplicated feed. */
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach(function (f) { require(path.join(root, f)); });
['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van', 'pack-jdm', 'pack-usa', 'pack-exotic', 'pack-sport'].forEach(function (f) { require(path.join(root, 'js/shapes/models', f + '.js')); });
['js/shapes/stock-specs.js', 'js/state.js', 'js/physics.js', 'js/rules.js', 'js/race/vehicle.js', 'js/drag/drag-strip.js', 'js/drag/drag-tree.js', 'js/drag/drag-timing.js',
 'js/drag/drag-launch.js', 'js/drag/drag-ai.js', 'js/drag/drag-session.js', 'js/drag/drag-hud.js', 'js/drag/drag-sfx.js', 'js/drag/drag-ui.js', 'js/router.js', 'js/game/profile.js',
 'js/derby/derby-ui.js', 'js/f1/f1-ui.js']
  .forEach(function (f) { try { require(path.join(root, f)); } catch (e) { if (/drag-ui|derby-ui|router/.test(f)) throw e; } });
var CB = globalThis.CB, DX = CB.drag.ui._, BX = CB.derby.ui._;
var src = function (rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); };
var T = function (n, f) { return globalThis.test('qa modes: ' + n, f); };

T('router: a mode can own the nav highlight while its session runs on the race layer (F1 -> "F1", not "Race")', function () {
  assert.equal(typeof CB.router.setNavOwner, 'function');
  var r = src('js/router.js');
  assert.ok(/navOwner && \(r === 'race' \|\| r === 'drift' \|\| r === 'arcade'\) \? navOwner : r/.test(r));
  assert.ok(/if \(navOwner && !\(t\.route === 'race'/.test(r), 'cleared when the session layer is left');
  assert.ok(/setNavOwner\(r\)/.test(src('js/f1/f1-ui.js')) && /navOwn\('f1'\)/.test(src('js/f1/f1-ui.js')));
});

T('f1: the default calendar follows the real season order; circuit stats stay on one line on phones', function () {
  var U = CB.f1 && CB.f1.ui && CB.f1.ui._;
  if (!U) return;
  var all = ['f1-monza', 'f1-silverstone', 'f1-spa', 'f1-monaco', 'f1-suzuka', 'f1-bahrain', 'f1-montreal'].map(function (id) { return { id: id }; });
  assert.deepStrictEqual(U.calendar(all, null, 4), ['f1-suzuka', 'f1-bahrain', 'f1-montreal', 'f1-monaco']);
  assert.deepStrictEqual(U.calendar(all, ['f1-monza', 'f1-monaco'], 2), ['f1-monaco', 'f1-monza'], 'a chosen calendar is run in season order too');
  var css = typeof U.CSS === 'function' ? U.CSS() : String(U.CSS);
  assert.ok(/\.f1-circ \.st\{[^}]*white-space:nowrap/.test(css));
});

T('drag: a stock car shows the same factory figures on its card and in "Your car"; the card has two short lines', function () {
  var sp = CB.stock.SPECS['chevrolet-camaro-zl1'] || CB.stock.SPECS[Object.keys(CB.stock.SPECS)[0]];
  var id = CB.stock.SPECS['chevrolet-camaro-zl1'] ? 'chevrolet-camaro-zl1' : Object.keys(CB.stock.SPECS)[0];
  var f = DX.carFigures({ key: 'stock:' + id, modelId: id, tuned: false }, { power_hp: sp.hp + 5, weight_kg: sp.kg + 43, zeroTo100_s: sp.s + 0.2 });
  assert.equal(f.factory, true); assert.equal(f.hp, sp.hp); assert.equal(f.kg, sp.kg); assert.equal(f.s100, sp.s);
  var g = DX.carFigures({ key: 'current' }, { power_hp: 300, weight_kg: 1400, zeroTo100_s: 5 });
  assert.equal(g.factory, false); assert.equal(g.hp, 300);
  assert.ok(/meta2: c\.drive\.toUpperCase\(\) \+ ' · 0–100 '/.test(src('js/drag/drag-ui.js')));
});

T('drag: automatics / CVT / EVs are told to ease onto the throttle to creep, manuals to tap', function () {
  var body = 'Let go, then tap {thr} to creep forward.';
  assert.equal(DX.creepText(body, false), body);
  assert.ok(/ease onto \{thr\} with a light, steady touch to creep forward/.test(DX.creepText(body, true)));
  var H = CB.drag.hud, me = { x: -2, staged: false, preStaged: false };
  var snap = { phase: 'staging', lanes: [me], playerLane: 0 };
  var a = H.prompt(snap, me, { keys: { thr: 'W', brk: 'S', up: 'E', down: 'Q' }, auto: true });
  var m = H.prompt(snap, me, { keys: { thr: 'W', brk: 'S', up: 'E', down: 'Q' }, auto: false });
  assert.ok(a && /ease onto W/i.test(a.text), JSON.stringify(a));
  assert.ok(m && /tap W/i.test(m.text), JSON.stringify(m));
});

T('drag + derby: custom key bindings replace the rebound actions only', function () {
  var dk = DX.dragKeys({ throttle: ['KeyI'], shiftUp: ['KeyO'] });
  assert.equal(dk.held.KeyI, 'thr'); assert.equal(dk.held.KeyW, undefined, 'old throttle key dropped');
  assert.equal(dk.edge.KeyO, 'up'); assert.equal(dk.held.KeyS, 'brk', 'untouched actions keep the drag defaults');
  assert.equal(dk.action.Escape, 'pause');
  assert.equal(DX.keyFor(dk, 'thr', 'W'), 'I');
  var I = DX.createInput({ bindings: { throttle: ['KeyI'] } });
  assert.ok(I.handleKey('KeyI', true, false) && I.held.thr === true);
  var bk = BX.derbyKeys({ steerLeft: ['KeyJ'], brake: ['KeyK'] });
  assert.equal(bk.held.KeyJ, 'left'); assert.equal(bk.held.KeyA, undefined);
  assert.equal(bk.held.KeyK, 'down'); assert.equal(bk.held.KeyF, 'a1', 'derby-only keys stay');
  var DI = BX.createInput({ bindings: { throttle: ['KeyU'] } });
  assert.ok(DI.handleKey('KeyU', true, false) && DI.held.up === true);
  // profile defaults (never rebound) keep each mode's own defaults (drag shift up on Space / →)
  if (CB.game && CB.game.profile && CB.game.profile.defaultBindings) {
    var d0 = DX.dragKeys(CB.game.profile.defaultBindings());
    assert.equal(d0.edge.Space, 'up'); assert.equal(d0.edge.ArrowRight, 'up');
  }
});

T('drag tach: gear above the hub, RPM label below it (small dials drop it), no shared space', function () {
  var s = src('js/drag/drag-hud.js');
  assert.ok(/text\(ctx, g, cx, cy - R \* 0\.24, R \* 0\.34/.test(s));
  assert.ok(/else if \(R >= 55\) text\(ctx, 'RPM ×1000', cx, cy \+ R \* 0\.24/.test(s));
});

T('drag + derby: the Controls button uses the gamepad icon, not the camera', function () {
  assert.ok(/icon\('pad', 14\) \+ ' Controls'/.test(src('js/drag/drag-ui.js')));
  assert.ok(/icon\('pad', 16\) \+ '<span>Controls<\/span>'/.test(src('js/derby/derby-ui.js')));
  assert.ok(DX && /pad: '<path/.test(src('js/drag/drag-ui.js')));
});

T('derby: the same feed line within 2 s is one event (no duplicate "T-boned you!"); sideswipes have a verb', function () {
  var s = src('js/derby/derby-session.js');
  assert.ok(/world\.t - world\.feed\[i\]\.t < 2; i--\) if \(world\.feed\[i\]\.text === text\) return world\.feed\[i\]/.test(s));
  assert.ok(/sideswipe: 'sideswiped'/.test(s));
});

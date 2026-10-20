/* F1 UI / HUD / integration (docs/F1-SPEC.md §6-§7): HUD pure helpers (sectors, tower rows, codes), UI helpers, the
   #/f1 route + nav item, menu tile, index.html script order, race-ui plugin hooks, hud.js hide options, achievements. */
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');
var root = path.join(__dirname, '..');
['js/f1/f1-teams.js', 'js/f1/f1-hud.js', 'js/f1/f1-ui.js', 'js/router.js', 'js/game/achievements.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, X = CB.f1.hud._, UX = CB.f1.ui._;
function read(f) { return fs.readFileSync(path.join(root, f), 'utf8'); }

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('f1-ui: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

test('hud: sector colours, lap format, driver codes', function () {
  assert.strictEqual(X.sectorClass(30.0, 30.5, 30.0), 'purple');
  assert.strictEqual(X.sectorClass(30.2, 30.5, 30.0), 'green');
  assert.strictEqual(X.sectorClass(30.8, 30.5, 30.0), 'yellow');
  assert.strictEqual(X.sectorClass(null, 1, 1), null);
  assert.strictEqual(X.fmtLap(81.234), '1:21.234');
  assert.strictEqual(X.fmtLap(null), '-:--.---');
  assert.strictEqual(X.code({ name: 'Theo Marchetti' }), 'MAR');
  assert.strictEqual(X.code({ name: 'Driver', isPlayer: true }), 'YOU');
  assert.strictEqual(X.code({ name: 'X', endurance: { f1: { short: 'HAL' } } }), 'HAL');
});

test('hud: tower rows (race order / best laps) and compact rows keep the player', function () {
  var cars = [];
  for (var i = 0; i < 22; i++) cars.push({ id: 'c' + i, name: 'Car ' + i, position: i + 1, isPlayer: i === 14, gapAhead_s: 0.4, bestLap_s: 90 - i * 0.1,
    endurance: { f1: { compound: 'soft' } } });
  var r = X.towerRows({ cars: cars }, 'race');
  assert.strictEqual(r[0].text, 'Leader');
  assert.strictEqual(r[3].text, '+0.4');
  assert.strictEqual(r[0].compound, 'soft');
  var q = X.towerRows({ cars: cars }, 'qualifying');
  assert.strictEqual(q[0].id, 'c21', 'fastest lap first');
  var c = X.compactRows(r, 6);
  assert.ok(c.length <= 6 && c.some(function (x) { return x.isPlayer; }) && c[0].pos === 1);
});

test('ui helpers: simulated grid and calendar', function () {
  var ent = [{ id: 'a', skill: 0.9 }, { id: 'b', skill: 0.5 }, { id: 'c', skill: 0.7 }];
  var g = UX.simGrid(ent, 5, 2);
  assert.strictEqual(g.length, 4);
  assert.strictEqual(g[1], 'player');
  assert.strictEqual(g[0], 'a');
  var all = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
  assert.deepStrictEqual(UX.calendar(all, ['z', 'x'], 2), ['x', 'z'], 'catalogue order');
  assert.deepStrictEqual(UX.calendar(all, null, 2), ['x', 'y']);
});

test('router: #/f1 route, Formula 1 nav item and layer', function () {
  var R = CB.router, _ = R._;
  assert.ok(R.routes.indexOf('f1') >= 0);
  assert.strictEqual(R.labels.f1, 'Formula 1');
  assert.strictEqual(_.layerOf('f1'), 'f1');
  assert.ok(_.NAV.some(function (n) { return n.route === 'f1' && n.label === 'Formula 1'; }));
  assert.strictEqual(_.parse('#/f1?quick=1').route, 'f1');
});

test('integration: index.html scripts in order, menu tile, race-ui plugin hooks, hud options', function () {
  var html = read('index.html');
  assert.ok(/<section id="screen-f1"/.test(html));
  var order = ['js/race/tracks-extra.js', 'js/f1/f1-teams.js', 'js/f1/f1-circuits.js', 'js/race/engine.js', 'js/f1/f1-car.js', 'js/f1/f1-strategy.js', 'js/f1/f1-ai.js',
    'js/f1/f1-hooks.js', 'js/f1/f1-mode.js', 'js/f1/f1-weekend.js', 'js/race/gl/scenery.js', 'js/race/gl/f1-scenery.js', 'js/race/gl/car-mesh.js',
    'js/race/gl/f1-car-mesh.js', 'js/race/race-ui.js', 'js/f1/f1-hud.js', 'js/f1/f1-ui.js', 'js/router.js'];
  var last = -1;
  order.forEach(function (f) { var i = html.indexOf('src="' + f + '"'); assert.ok(i > last, f + ' in order'); last = i; });
  var hub = read('js/game/hub.js');
  assert.ok(/id: 'f1', label: 'Formula 1'/.test(hub) && /router\.go\('f1'\)/.test(hub));
  var ui = read('js/race/race-ui.js');
  ['findTrack', 'configure', 'attach', 'setRenderer', 'drawHud', 'results', 'resultsPanel', 'detach'].forEach(function (k) {
    assert.ok(ui.indexOf("pluginCall('" + k + "'") >= 0 || ui.indexOf('PLt.' + k) >= 0, 'plugin.' + k);
  });
  assert.ok(/L0\.maxOpponents/.test(ui), 'plugin grids lift the 11-opponent cap');
  var hud = read('js/race/hud.js');
  ['opts.timing === false', 'opts.tower !== false', 'opts.cluster === false'].forEach(function (k) { assert.ok(hud.indexOf(k) >= 0, k); });
});

test('achievements: F1 category and events', function () {
  var A = CB.game.achievements;
  var defs = (Array.isArray(A.list) ? A.list : A.list()).filter(function (d) { return d.category === 'f1'; });
  assert.ok(defs.length >= 10, defs.length + ' F1 achievements');
  assert.ok(defs.every(function (d) { return /^f1-[a-z0-9-]+$/.test(d.id); }));
});

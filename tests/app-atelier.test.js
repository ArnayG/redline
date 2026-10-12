/* Node tests for js/app.js pure helpers (frame-change merging, auto-fix filtering) and the
   severity-ordered resolver the "Fix N automatically" button uses — run: node tests/run.js app-atelier */
'use strict';
var path = require('path');
var fs = require('fs');
var vm = require('vm');
function load(f) { try { return require(path.join(__dirname, '..', 'js', f)); } catch (e) { return null; } }
load('util.js'); load('data.js'); load('state.js');
load('physics.js'); load('rules.js'); load('pricing.js');
var G = require(path.join(__dirname, '..', 'js', 'garage.js'));
var CB = globalThis.CB;

/* Evaluate app.js in a sandbox with a stub DOM that never fires DOMContentLoaded (so boot() never runs). */
function loadApp() {
  var noop = function () {};
  var doc = { readyState: 'loading', addEventListener: noop, removeEventListener: noop, getElementById: function () { return null; },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; }, documentElement: { setAttribute: noop, classList: { add: noop, remove: noop, toggle: noop } },
    createElement: function () { return { style: {}, setAttribute: noop, appendChild: noop, classList: { add: noop, remove: noop } }; }, body: null, hidden: false };
  var win = { CB: Object.assign({}, CB), matchMedia: function () { return { matches: false, addEventListener: noop }; }, addEventListener: noop, localStorage: null };
  var ctx = { window: win, document: doc, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, navigator: { userAgent: 'node' } };
  win.window = win; win.document = doc;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  win.CB.app._cb = win.CB;
  return win.CB.app;
}
var APP = null;
try { APP = loadApp(); } catch (e) { APP = { _loadError: e }; }

test('app: loads in a stub DOM and exposes _test helpers', function () {
  if (APP._loadError) throw APP._loadError;
  assert.equal(typeof APP._test.mergeChange, 'function');
});

test('app: a passive refresh never masks boot (no free achievements on page load)', function () {
  var m = APP._test.mergeChange, isEdit = APP._test.isUserEdit;
  var boot = { path: '*', type: 'boot' }, refresh = { path: '*', type: 'refresh' };
  assert.equal(m(boot, refresh).type, 'boot');
  assert.equal(m(refresh, boot).type, 'boot');
  assert.equal(isEdit(m(boot, refresh)), false);
  assert.equal(isEdit(m(null, refresh)), false);
  assert.equal(isEdit(m(null, null)), false);
  ['boot', 'refresh', undefined].forEach(function (t) { assert.equal(isEdit({ path: '*', type: t }), false, String(t)); });
  ['set', 'patch', 'replace', 'undo', 'redo'].forEach(function (t) { assert.equal(isEdit({ path: '*', type: t }), true, t); });
});

test('app: user edits survive coalescing with refresh / boot; same-path edits keep granularity', function () {
  var m = APP._test.mergeChange;
  var set = { path: 'engine.boost', type: 'set', label: 'Boost' }, refresh = { path: '*', type: 'refresh' };
  var a = m(set, refresh);
  assert.equal(a.type, 'set'); assert.equal(a.path, '*');
  assert.equal(m(refresh, set).type, 'set');
  assert.equal(m({ path: '*', type: 'boot' }, set).type, 'set');
  var set2 = { path: 'engine.boost', type: 'set', value: 2 };
  assert.equal(m(set, set2), set2, 'same path keeps the granular change');
  var other = m(set, { path: 'paint.color', type: 'set' });
  assert.equal(other.path, '*'); assert.equal(other.type, 'set');
});

test('app: auto-fix button only counts error / warning fixes (never info notes)', function () {
  var f = APP._test.autoFixable;
  var p = { patch: { a: 1 } };
  var list = [{ severity: 'error', fix: p }, { severity: 'warning', fix: p }, { severity: 'info', fix: p }, { severity: 'error' }];
  assert.equal(f(list).length, 2);
  assert.equal(f(null).length, 0);
});

test('garage: resolveIssues clears every fixable error on random builds (seeds 1-150)', function () {
  if (!CB.rules || !CB.rules.validate) return;
  var left = [];
  for (var s = 1; s <= 150; s++) {
    var b = CB.state && CB.state.normalize ? CB.state.normalize(G.randomBuild(s)) : G.randomBuild(s);
    var res = G.resolveIssues(b);
    var errs = (res.issues || []).filter(function (i) { return i.severity === 'error' && i.fix && i.fix.patch; });
    if (errs.length) left.push(s + ':' + errs.map(function (i) { return i.id; }).join(','));
  }
  assert.deepEqual(left, []);
});

test('app: free sessions started by URL (#/race, refresh, bookmark) are recorded once; owned sessions are not (B1)', function () {
  if (APP._loadError) throw APP._loadError;
  var C = APP._cb, t = APP._test, stats = [], checks = [], uiState = null;
  C.game = { profile: { recordRaceStats: function (r, cfg) { stats.push(cfg); }, get: function () { return { stats: {} }; } },
    achievements: { check: function (p, ev) { checks.push(ev.type); return []; } } };
  C.race = { ui: { open: function () {}, _dev: { state: function () { return uiState; } } } };
  var ev = function (r) { return { detail: { results: r } }; };
  // URL-started free race: no launcher callback, no context
  uiState = { opts: { settings: {} } };
  var free = { mode: 'race', trackId: 'forge-ring', settings: { laps: 3 }, classification: [] };
  assert.equal(t.onRaceFinished(ev(free)), true);
  assert.equal(stats.length, 1); assert.equal(stats[0].freeBuild, true); assert.equal(stats[0].trackId, 'forge-ring');
  assert.ok(checks.indexOf('race-finished') >= 0);
  // the same results object again (e.g. a duplicate event) never double counts
  assert.equal(t.onRaceFinished(ev(free)), false); assert.equal(stats.length, 1);
  // Atelier drive(): its onFinish records first, then the event fires with the same object -> one record
  var driven = { mode: 'race', settings: {} };
  uiState = { opts: { onFinish: function () {} } };
  t.recordFreeRace(driven, 'free');
  assert.equal(t.onRaceFinished(ev(driven)), false); assert.equal(stats.length, 2);
  // career / hub / challenge sessions record themselves
  uiState = { opts: { context: { kind: 'career' } } };
  assert.equal(t.onRaceFinished(ev({ mode: 'race' })), false);
  uiState = { opts: {} };
  assert.equal(t.onRaceFinished(ev({ mode: 'race', career: { round: 1 } })), false);
  assert.equal(t.onRaceFinished(ev({ mode: 'race', challenge: { id: 'x' } })), false);
  assert.equal(t.onRaceFinished(ev({ mode: 'race', launchSettings: { discipline: 'race' } })), false);
  assert.equal(stats.length, 2);
  // a second, distinct URL session counts again
  assert.equal(t.onRaceFinished(ev({ mode: 'race', settings: {} })), true); assert.equal(stats.length, 3);
  assert.equal(t.onRaceFinished(null), false);
  delete C.game; delete C.race;
});

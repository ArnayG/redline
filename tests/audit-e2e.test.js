/* FORGE — regressions found by the end-to-end browser audit (headless Chrome over CDP):
   - envmap: the SH read-back PBO is not a READ-usage buffer (Chrome logged a performance warning per probe refresh,
     then "WebGL: too many errors")
   - lobby: the driver name is per tab first, so two same-device tabs keep two names (the host raced as the guest's name)
   - netrace: a guest's own car carries the host's grid number (both cars showed #1)
   - app: confirming a career purchase / upgrade keeps an unsaved Atelier build in Saved builds
   - hub: the player's table row is one flat tint (the per-cell gradient looked stepped) */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var ROOT = path.join(__dirname, '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

var standalone = typeof globalThis.test !== 'function' || require.main === module;
var test = standalone
  ? function (name, fn) { try { fn(); console.log('  ok   ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; } }
  : globalThis.test;

test('audit: envmap SH read-back PBO uses a COPY usage, never STREAM_READ', function () {
  var s = src('js/race/gl/envmap.js');
  assert.ok(/bufferData\(gl\.PIXEL_PACK_BUFFER,[^;]*gl\.STREAM_COPY\)/.test(s), 'PBO allocated with STREAM_COPY');
  assert.ok(!/gl\.(STREAM|DYNAMIC|STATIC)_READ\b/.test(s), 'no READ-usage buffers');
});

function memStore() { var m = {}; return { getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } }; }

test('audit: lobby driver name is per tab (two same-device tabs keep two names)', function () {
  var L = require(path.join(ROOT, 'js/net/lobby.js'));
  var had = Object.prototype.hasOwnProperty.call(globalThis, 'window'), prev = globalThis.window;
  var shared = memStore(), tabA = memStore(), tabB = memStore();
  try {
    globalThis.window = { localStorage: shared, sessionStorage: tabA };
    L._.setName('HostA');
    assert.strictEqual(L._.myName(), 'HostA');
    globalThis.window = { localStorage: shared, sessionStorage: tabB };
    L._.setName('GuestB');
    assert.strictEqual(L._.myName(), 'GuestB');
    globalThis.window = { localStorage: shared, sessionStorage: tabA };
    assert.strictEqual(L._.myName(), 'HostA', 'tab A keeps its own name after tab B renamed');
    globalThis.window = { localStorage: shared, sessionStorage: memStore() };
    assert.strictEqual(L._.myName(), 'GuestB', 'a fresh tab falls back to the last browser-wide name');
  } finally { if (had) globalThis.window = prev; else delete globalThis.window; }
});

test('audit: netrace stamps the host grid number on the guest\'s own car', function () {
  var s = src('js/net/netrace.js');
  assert.ok(/c\.isPlayer\) \{ if \(spectator\) return; c\.netId = myCarId; c\.kind = 'human'; if \(e && e\.number != null\) c\.number = String\(e\.number\);/.test(s));
});

function loadApp(CB) {
  var noop = function () {};
  var doc = { readyState: 'loading', addEventListener: noop, removeEventListener: noop, dispatchEvent: noop, getElementById: function () { return null; },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; }, documentElement: { setAttribute: noop, removeAttribute: noop, classList: { add: noop, remove: noop, toggle: noop } },
    createElement: function () { return { style: {}, setAttribute: noop, appendChild: noop, classList: { add: noop, remove: noop } }; }, body: null, hidden: false };
  var win = { CB: CB, matchMedia: function () { return { matches: false, addEventListener: noop }; }, addEventListener: noop, localStorage: null };
  var ctx = { window: win, document: doc, console: { log: noop, warn: noop, error: noop }, setTimeout: setTimeout, clearTimeout: clearTimeout, navigator: { userAgent: 'node' }, CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; } };
  win.window = win; win.document = doc;
  vm.createContext(ctx);
  vm.runInContext(src('js/app.js'), ctx, { filename: 'app.js' });
  return win.CB.app;
}

test('audit: a confirmed career session keeps the unsaved pre-session Atelier build', function () {
  var saved = [];
  var dirty = true;
  ['util.js', 'data.js', 'state.js', 'physics.js', 'rules.js', 'pricing.js'].forEach(function (f) { require(path.join(ROOT, 'js', f)); });
  var CB = Object.assign({}, globalThis.CB);
  var APP = loadApp(CB);
  CB.state = Object.assign({}, CB.state, { saveLocal: function (b) { saved.push(b); return { id: b.meta.id, name: b.meta.name }; } });
  CB.garage = { isDirty: function () { return dirty; } };
  var keep = APP && APP._test && APP._test.keepPreSessionBuild;
  assert.strictEqual(typeof keep, 'function');
  var pre = { meta: { id: 'b_1', name: 'My V8 Silvia' } };
  keep(pre);
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0], pre);
  dirty = false;
  keep(pre);
  assert.strictEqual(saved.length, 1, 'an already-saved (clean) build is not saved twice');
  assert.ok(/keepPreSessionBuild\(s\.preSession\)/.test(src('js/app.js')), 'finish(confirm) calls it');
});

test('audit: hub player row tint is a flat per-cell colour (no per-cell gradient)', function () {
  var s = src('js/game/hub.js');
  var m = s.match(/tr\.is-player td\{([^}]*)\}/);
  assert.ok(m, 'rule exists');
  assert.ok(!/gradient/.test(m[1]), 'no gradient restarting in every cell');
});

/* Regression: "Race again" in Arcade lost nitro / item keys. The arcade session wrapper (CB.arcade.mode) inherited
   destroy() from the inner session, so its extensions (the gameplay layer) were never destroyed on teardown; the stale
   layer's capture-phase window key listener kept swallowing N / F in the next race. */
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
global.CB = global.CB || {};
require(path.join(root, 'js/arcade/mode.js'));

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('arcade: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + e.stack); process.exitCode = 1; }
}

test('destroying an arcade session destroys its extensions and the inner session', function () {
  var M = CB.arcade.mode, wrap = M._internal.wrap;
  var log = [];
  var inner = { config: {}, update: function () {}, snapshot: function () { return {}; }, destroy: function () { log.push('inner'); } };
  var ext = { _ext: { id: 'gameplay' }, destroy: function () { log.push('ext'); } };
  var s = wrap(inner, { arcade: {}, mode: 'race' }, 'circuit', [ext]);
  s.destroy();
  assert.deepStrictEqual(log, ['ext', 'inner']);
});

test('destroy works when the inner session has no destroy()', function () {
  var wrap = CB.arcade.mode._internal.wrap, n = 0;
  var s = wrap({ config: {}, update: function () {}, snapshot: function () { return {}; } }, { arcade: {}, mode: 'race' }, 'stunt',
    [{ _ext: { id: 'gameplay' }, destroy: function () { n++; } }]);
  assert.doesNotThrow(function () { s.destroy(); });
  assert.strictEqual(n, 1);
});

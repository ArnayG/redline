/* Node tests for the unified race screen (UNIFY-SPEC): engine session.playerState() (DRIFT-SPEC §1 shape)
   and the race-ui router wrapper surface. Run via node tests/run.js. */
'use strict';
var path = require('path');
var fs = require('fs');
var root = path.join(__dirname, '..');
function tryLoad(rel) {
  var p = path.join(root, rel);
  if (!fs.existsSync(p)) return false;
  try { require(p); return true; } catch (e) { return false; }
}
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/vehicle.js', 'js/race/ai.js'].forEach(tryLoad);
var E = require(path.join(root, 'js', 'race', 'engine.js'));
var CB = globalThis.CB;

function session(extra) {
  var cfg = { mode: 'practice', opponents: [], laps: 3, seed: 7 };
  var list = CB.race.tracks && (typeof CB.race.tracks.list === 'function' ? CB.race.tracks.list() : CB.race.tracks.list);
  if (Array.isArray(list) && list[0]) cfg.trackId = list[0].id;
  for (var k in (extra || {})) cfg[k] = extra[k];
  return E.createSession(cfg);
}

test('unify: engine session exposes playerState() with the assist contract fields', function () {
  var s = session();
  assert.strictEqual(typeof s.playerState, 'function');
  var ps = s.playerState();
  ['speed', 'vxLocal', 'vyLocal', 'yawRate', 'heading', 'steerAngle', 'slipAngleF', 'slipAngleR', 'rpm', 'gear', 'maxSteer', 'maxSteer_rad'].forEach(function (k) {
    assert.ok(typeof ps[k] === 'number' && isFinite(ps[k]), k + ' is a finite number');
  });
  assert.ok(ps.maxSteer > 0.1 && ps.maxSteer < 1.2, 'maxSteer in radians');
});

test('unify: playerState() car-frame velocity follows the car (forward speed ≈ vxLocal)', function () {
  var s = session();
  for (var i = 0; i < 600; i++) s.update(1 / 120, { throttle: 1, brake: 0, steer: 0 });
  var ps = s.playerState();
  assert.ok(ps.speed > 3, 'moving: ' + ps.speed);
  assert.ok(ps.vxLocal > 0, 'forward is +x');
  assert.ok(Math.abs(Math.hypot(ps.vxLocal, ps.vyLocal) - Math.hypot(ps.vx, ps.vy)) < 1e-6, 'frame change preserves |v|');
  assert.ok(Math.abs(ps.vyLocal) < ps.vxLocal, 'mostly forward on a straight launch');
});

test('unify: race-ui keeps open/close/isOpen and exposes router hooks without a DOM', function () {
  var ui = require(path.join(root, 'js', 'race', 'race-ui.js'));
  assert.strictEqual(typeof ui.open, 'function');
  assert.strictEqual(typeof ui.close, 'function');
  assert.strictEqual(typeof ui.isOpen, 'function');
  assert.strictEqual(ui.open({}), null);
  var S = ui._.sanitizeSettings({});
  assert.strictEqual(S.steerAssist, 'light', 'light steering assist by default for racing');
  assert.strictEqual(S.driftSteerAssist, 'heavy', 'heavy steering assist by default for drifting');
  assert.strictEqual(S.graphics, '3d', '3D is the default view');
  assert.strictEqual(S.driftCamera3d, 'chase', 'chase camera is the drift default');
});

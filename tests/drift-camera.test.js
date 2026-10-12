/* Node tests for js/race/drift/camera.js (drift chase camera) + js/race/drift/sfx.js (popup sounds, pure plan)
   run: node tests/drift-camera.test.js (or via node tests/run.js drift) */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
var CAM = require(path.join(root, 'js', 'race', 'drift', 'camera.js'));
var SFX = require(path.join(root, 'js', 'race', 'drift', 'sfx.js'));

var local = typeof globalThis.test !== 'function';
var queue = [];
function test(name, fn) {
  if (!local) return globalThis.test('drift-camera: ' + name, function () { fn(); });
  queue.push({ name: name, fn: fn });
}
var DEG = Math.PI / 180;
/** A car on a circle of radius R at speed v, sliding at beta (nose inside), with optional heading noise. */
function circleCtx(t, R, v, beta, noise, mode) {
  var w = v / R, a = w * t, x = R * Math.cos(a), y = R * Math.sin(a);
  var vDir = a + Math.PI / 2, h = vDir + beta + (noise ? noise(t) : 0);
  return { dt: 1 / 60, mode: mode || 'chase', pose: { x: x, y: y, heading: h, elev: 0 },
           player: { vx: Math.cos(vDir) * v, vy: Math.sin(vDir) * v, speed: v }, dims: { length: 4.5, width: 1.9, height: 1.3 } };
}
function yawOf(out) { return Math.atan2(-(out.target[2] - out.eye[2]), out.target[0] - out.eye[0]); }
function wrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

test('module surface + only drives chase cams (other modes / look-back keep the renderer camera)', function () {
  var c = CAM.create();
  assert.strictEqual(typeof c.controller, 'function');
  assert.strictEqual(c.update(circleCtx(0, 40, 15, 0, null, 'cockpit')), false);
  assert.strictEqual(c.update(Object.assign(circleCtx(0, 40, 15, 0), { lookBack: true })), false);
  var o = c.update(circleCtx(0, 40, 15, 0));
  assert.ok(o && o.eye.length === 3 && o.target.length === 3 && isFinite(o.fovDeg));
  assert.strictEqual(c.update(null), false);
});

test('follows the velocity direction (not the body) in a 35 deg slide, behind the car', function () {
  var c = CAM.create(), o;
  for (var i = 0; i < 600; i++) o = c.update(circleCtx(i / 60, 40, 16, 35 * DEG));
  var ctx = circleCtx(599 / 60, 40, 16, 35 * DEG);
  var vDir = Math.atan2(ctx.player.vy, ctx.player.vx), h = ctx.pose.heading;
  var camYaw = c.debug().yaw;
  var toVel = Math.abs(wrap(camYaw - vDir)) / DEG, toBody = Math.abs(wrap(camYaw - h)) / DEG;
  assert.ok(toVel < toBody, 'closer to the travel direction (' + toVel.toFixed(1) + ' vs body ' + toBody.toFixed(1) + ')');
  // eye is behind the car
  var ex = o.eye[0] - ctx.pose.x, ey = -o.eye[2] - ctx.pose.y;
  assert.ok(ex * Math.cos(vDir) + ey * Math.sin(vDir) < -3, 'behind the car');
});

test('SMOOTH: heading noise / a snap of the body does not make the camera jitter (rate limited, critically damped)', function () {
  var c = CAM.create(), prev = null, maxRateChange = 0, prevRate = null, maxRate = 0;
  var noise = function (t) { return Math.sin(t * 37) * 4 * DEG + (Math.floor(t * 7) % 2 ? 2 : -2) * DEG; };
  for (var i = 0; i < 900; i++) {
    var o = c.update(circleCtx(i / 60, 35, 15, 30 * DEG * (i > 300 && i < 600 ? -1 : 1), noise));
    var y = c.debug().yaw;
    if (prev != null) {
      var r = (y - prev) * 60;
      maxRate = Math.max(maxRate, Math.abs(r));
      if (prevRate != null && i > 30) maxRateChange = Math.max(maxRateChange, Math.abs(r - prevRate) * 60);
      prevRate = r;
    }
    prev = y;
    assert.ok(o.eye.every(isFinite) && o.target.every(isFinite));
  }
  assert.ok(maxRate <= CAM.TUNING.maxYawRate + 1e-6, 'yaw rate limited (' + maxRate.toFixed(2) + ')');
  assert.ok(maxRateChange < 12, 'no yaw-rate spikes from noise / left-right swing (' + maxRateChange.toFixed(2) + ' rad/s^2)');
});

test('FOV widens with speed and drift angle; kick() adds a decaying shake', function () {
  function fovAt(v, beta) { var c = CAM.create(), o; c.setFx({ slip: beta > 0 ? 1 : 0, angle_deg: beta / DEG }); for (var i = 0; i < 400; i++) o = c.update(circleCtx(i / 60, 80, v, beta)); return o.fovDeg; }
  var slow = fovAt(8, 0), fast = fovAt(35, 0), fastDrift = fovAt(35, 35 * DEG);
  assert.ok(fast > slow + 3, 'speed widens (' + slow.toFixed(1) + ' -> ' + fast.toFixed(1) + ')');
  assert.ok(fastDrift > fast + 2, 'angle widens (' + fast.toFixed(1) + ' -> ' + fastDrift.toFixed(1) + ')');
  assert.ok(fastDrift <= CAM.TUNING.fovMax);
  var c = CAM.create();
  for (var i = 0; i < 60; i++) c.update(circleCtx(i / 60, 80, 20, 0));
  c.kick(1);
  var a0 = c.update(circleCtx(1, 80, 20, 0)) && c.debug().amp;
  for (i = 0; i < 120; i++) c.update(circleCtx(1 + i / 60, 80, 20, 0));
  assert.ok(a0 > c.debug().amp * 3, 'trauma decays');
});

test('walls: safeFraction pulls the camera in; groundY keeps it above ground', function () {
  var c = CAM.create(), o;
  for (var i = 0; i < 120; i++) {
    var ctx = circleCtx(i / 60, 60, 15, 0);
    ctx.safeFraction = function () { return 0.4; };
    ctx.groundY = function () { return 5; };
    o = c.update(ctx);
  }
  var d = Math.hypot(o.eye[0] - ctx.pose.x, -o.eye[2] - ctx.pose.y);
  assert.ok(d < CAM.TUNING.dist * 0.6, 'pulled in (' + d.toFixed(2) + ' m)');
  assert.ok(o.eye[1] >= 5.5, 'above ground');
});

test('sfx.plan: combo arpeggios climb with the multiplier, banks / zones / scrapes have sounds', function () {
  var c2 = SFX.plan({ kind: 'combo', text: '×2 COMBO!' }), c4 = SFX.plan({ kind: 'combo', text: '×4 COMBO!' });
  assert.ok(c2.length >= 4 && c4[0].f > c2[0].f);
  assert.ok(SFX.plan({ kind: 'bank', points: 8000 }).length > SFX.plan({ kind: 'bank', points: 300 }).length - 1);
  ['zone', 'bonus', 'swing', 'scrape'].forEach(function (k) { assert.ok(SFX.plan({ kind: k }).length > 0, k); });
  assert.deepStrictEqual(SFX.plan(null), []);
  var fx = SFX.create();   // no AudioContext in Node: update just tracks seq
  assert.strictEqual(fx.update({ popups: [{ kind: 'combo', seq: 1 }] }), 1);
  assert.strictEqual(fx.update({ popups: [{ kind: 'combo', seq: 1 }] }), 0);
  assert.strictEqual(fx.update({ popups: [{ kind: 'combo', seq: 1 }, { kind: 'bank', seq: 2 }] }), 1);
});

if (local) {
  var passed = 0, failed = 0;
  queue.forEach(function (t) {
    try { t.fn(); passed++; console.log('  ✓ ' + t.name); }
    catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n    ')); }
  });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

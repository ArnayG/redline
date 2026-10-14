#!/usr/bin/env node
/* ==========================================================================
   Redline — tools/arcade-turn.js
   Arcade handling probe: steady full-lock yaw rate / turn radius vs speed and the steering response time
   (0 -> 90 % of the steady yaw rate) for keyboard, gamepad and phone / webcam analog input, on circuits
   (CB.race.vehicle.step, arcade handling) and on stunt tracks (CB.arcade.stunt.physics responseAdapter).
   The input path is the one the game uses: race-ui's arcade key shaping (CB.race.ui arcadeKeyShape, mirrored
   here as ARC_KEYS) -> vehicle. Speed is held constant while measuring.
   Usage: node tools/arcade-turn.js [--json]       As a module: require(...).measure(opts)
   ========================================================================== */
'use strict';
var path = require('path');
var ROOT = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/vehicle.js', 'js/arcade/stunt-track.js', 'js/arcade/stunt-maps.js',
  'js/arcade/stunt-physics.js'].forEach(function (f) { require(path.join(ROOT, f)); });
var CB = globalThis.CB, V = CB.race.vehicle, SP = CB.arcade.stunt.physics;
var STEP = 1 / 120, DEG = 180 / Math.PI;
var SPEEDS = [30, 60, 100, 150, 200, 250];
var BUILDS = { hatch: 3, gt: 0, hyper: 8, suv: 4, van: 13 };

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function approach(c, t, d) { return c < t ? Math.min(c + d, t) : Math.max(c - d, t); }
function buildOf(k) { var p = CB.data.presets[BUILDS[k]]; return JSON.parse(JSON.stringify(p.build || p)); }

/** Keyboard shaping for arcade sessions (must match race-ui I.sample's arcade branch). */
var ARC_KEYS = (CB.race.vehicle.ARCADE && CB.race.vehicle.ARCADE.keys) || null;
function keyShaper() {
  var st = 0;
  return function (target, dt) {
    var K = (CB.race.vehicle.ARCADE && CB.race.vehicle.ARCADE.keys) || { rateIn: 3.1, rateOut: 5.5, rateFlip: 9 };
    var rate = target === 0 ? K.rateOut : st !== 0 && (target > 0) !== (st > 0) ? K.rateFlip : K.rateIn;
    st = approach(st, target, rate * dt);
    return st;
  };
}

/** Circuit: arcade V.step at constant speed; device 'keys' | 'pad' | 'phone'. Returns { yaw, radius, t90 }. */
function circuitProbe(p, kph, device) {
  var v = kph / 3.6;
  var s = V.createState(p, { x: 0, y: 0, heading: 0, speed: v, autoShift: true });
  var shape = keyShaper(), env = { gripMult: 1, surface: 'asphalt' };
  var yaw = [], T = 2.0, n = Math.round(T / STEP);
  for (var i = 0; i < n; i++) {
    var steer = device === 'keys' ? shape(1, STEP) : 1;   // analog: the stick / wheel snaps to full
    V.step(p, s, { throttle: 0.4, brake: 0, steer: steer, handbrake: false }, STEP, env);
    var sp = Math.hypot(s.vx, s.vy) || 1; s.vx *= v / sp; s.vy *= v / sp;   // hold the speed
    yaw.push(Math.abs(s.yawRate));
  }
  var steady = yaw.slice(-30).reduce(function (a, b) { return a + b; }, 0) / 30;
  var t90 = null;
  for (var k = 0; k < yaw.length; k++) if (yaw[k] >= 0.9 * steady) { t90 = (k + 1) * STEP; break; }
  return { yaw: steady, radius: v / Math.max(steady, 1e-6), t90: t90 };
}

/** Stunt: the stunt drive model (responseAdapter) at constant speed, flat road. */
function stuntProbe(build, kph, device) {
  var v = kph / 3.6, drive = SP.resolveDrive({}), D = drive.create(build, {});
  var shape = keyShaper(), yaw = [], n = Math.round(2.0 / STEP);
  for (var i = 0; i < n; i++) {
    var steer = device === 'keys' ? shape(1, STEP) : 1;
    var r = drive.step(D, { throttle: 0.4, brake: 0, steer: steer }, { dt: STEP, speed: v, bank: 0, topMult: 1.3, push: 0, vTarget: 1e9, throttleMult: 1 });
    yaw.push(Math.abs(r.yawRate || 0));
  }
  var steady = yaw.slice(-30).reduce(function (a, b) { return a + b; }, 0) / 30, t90 = null;
  for (var k = 0; k < yaw.length; k++) if (yaw[k] >= 0.9 * steady) { t90 = (k + 1) * STEP; break; }
  return { yaw: steady, radius: v / Math.max(steady, 1e-6), t90: t90 };
}

/** Powerslide (handbrake + full lock) yaw on a circuit. */
function slideProbe(p, kph) {
  var v = kph / 3.6, s = V.createState(p, { x: 0, y: 0, heading: 0, speed: v, autoShift: true }), yaw = [];
  for (var i = 0; i < 240; i++) {
    V.step(p, s, { throttle: 0.6, brake: 0, steer: 1, handbrake: true }, STEP, { gripMult: 1 });
    var sp = Math.hypot(s.vx, s.vy) || 1; s.vx *= v / sp; s.vy *= v / sp;
    yaw.push(Math.abs(s.yawRate));
  }
  return yaw.slice(-30).reduce(function (a, b) { return a + b; }, 0) / 30;
}

function measure(opts) {
  opts = opts || {};
  var out = { circuit: {}, stunt: {}, slide: {} };
  Object.keys(BUILDS).forEach(function (bk) {
    var b = buildOf(bk), m = CB.physics.compute(CB.state.normalize(b)), p = V.fromBuild(b, m, { handling: 'arcade' });
    out.circuit[bk] = {}; out.stunt[bk] = {}; out.slide[bk] = {};
    SPEEDS.forEach(function (kph) {
      out.circuit[bk][kph] = { keys: circuitProbe(p, kph, 'keys'), pad: circuitProbe(p, kph, 'pad') };
      out.stunt[bk][kph] = { keys: stuntProbe(b, kph, 'keys'), pad: stuntProbe(b, kph, 'pad') };
      out.slide[bk][kph] = slideProbe(p, kph);
    });
  });
  return out;
}

if (require.main === module) {
  var r = measure();
  if (process.argv.indexOf('--json') >= 0) { console.log(JSON.stringify(r)); process.exit(0); }
  ['circuit', 'stunt'].forEach(function (kind) {
    console.log('\n' + kind.toUpperCase() + '  full-lock yaw deg/s (radius m) keys | pad  ·  t90 keys / pad ms');
    Object.keys(r[kind]).forEach(function (bk) {
      var row = bk.padEnd(6);
      SPEEDS.forEach(function (kph) {
        var e = r[kind][bk][kph];
        row += '  ' + String(kph).padStart(3) + ': ' + (e.keys.yaw * DEG).toFixed(0).padStart(3) + '/' + (e.pad.yaw * DEG).toFixed(0).padStart(3) +
          ' (' + e.pad.radius.toFixed(0) + 'm ' + Math.round(e.keys.t90 * 1000) + '/' + Math.round(e.pad.t90 * 1000) + ')';
      });
      console.log(row);
    });
  });
  console.log('\nPOWERSLIDE (circuit) yaw deg/s');
  Object.keys(r.slide).forEach(function (bk) {
    console.log(bk.padEnd(6) + SPEEDS.map(function (k) { return '  ' + k + ': ' + (r.slide[bk][k] * DEG).toFixed(0); }).join(''));
  });
}
module.exports = { measure: measure, circuitProbe: circuitProbe, stuntProbe: stuntProbe, slideProbe: slideProbe, SPEEDS: SPEEDS, BUILDS: BUILDS };

#!/usr/bin/env node
/* Redline — tools/f1-physics-report.js
   Measures the single-spec F1 car (js/f1/f1-car.js) on the real CB.race.vehicle model and prints a table:
   0–100 / 0–200 km/h, top speed (ERS + DRS, ERS, no ERS), 200→0 braking distance, peak braking g at 300 km/h,
   steady-state cornering g at 120 / 200 / 250 / 300 km/h.
   Usage: node tools/f1-physics-report.js      (also require()d by tests/f1-car.test.js: module.exports.measure()) */
'use strict';
var path = require('path');
var root = path.join(__dirname, '..');
function load(rel) { try { require(path.join(root, rel)); } catch (e) { /* optional */ } }
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/vehicle.js', 'js/f1/f1-teams.js', 'js/f1/f1-car.js'].forEach(load);
var CB = globalThis.CB, V = CB.race.vehicle, F = CB.f1.car;
var DT = 1 / 120;
var ENV = { gripMult: 1, wetness: 0, assists: { abs: true, tc: true, autoShift: true } };

function accelTo(p, kph) { var r = V.simulateLaunch(p, kph, { env: ENV }); return r.t; }
function topSpeed(p) {
  var s = V.createState(p, { x: 0, y: 0, heading: 0, autoShift: true, speed: 60 });
  var inp = { throttle: 1, brake: 0, steer: 0 }, best = 0, still = 0;
  for (var t = 0; t < 120; t += DT) {
    V.step(p, s, inp, DT, ENV);
    if (s.vx > best + 0.002) { best = s.vx; still = 0; } else if ((still += DT) > 4) break;
  }
  return best * 3.6;
}
function brakeFrom(p, kph) {
  var s = V.createState(p, { x: 0, y: 0, heading: 0, autoShift: true, speed: kph / 3.6 });
  var x0 = s.x, peak = 0, inp = { throttle: 0, brake: 1, steer: 0 };
  for (var t = 0; t < 30; t += DT) {
    var v0 = s.vx;
    V.step(p, s, inp, DT, ENV);
    peak = Math.max(peak, (v0 - s.vx) / DT / 9.81);
    if (s.vx < 0.3) break;
  }
  return { dist: s.x - x0, peakG: peak };
}
/** Steady-state cornering: hold speed with a throttle PI loop and ramp the steering until the car stops gaining
    lateral acceleration (or slides); returns the best sustained |ay| in g. */
function cornering(p, kph) {
  var vT = kph / 3.6, best = 0;
  for (var steer = 0.1; steer <= 1.0001; steer += 0.05) {
    var s = V.createState(p, { x: 0, y: 0, heading: 0, autoShift: true, speed: vT });
    var acc = [], ok = true;
    for (var t = 0; t < 4; t += DT) {
      var e = vT - s.vx;
      var thr = Math.max(0, Math.min(1, 0.35 + e * 0.8)), brk = e < -1 ? Math.min(1, -e * 0.2) : 0;
      V.step(p, s, { throttle: thr, brake: brk, steer: steer }, DT, ENV);
      if (Math.abs(s.beta || 0) > 0.2 || Math.abs(s.vx - vT) > 6) { ok = false; break; }
      if (t > 2.5) acc.push(Math.abs(s.yawRate * s.vx));
    }
    if (!ok || !acc.length) continue;
    var a = acc.reduce(function (x, y) { return x + y; }, 0) / acc.length / 9.81;
    if (a > best) best = a;
  }
  return best;
}

function measure() {
  var pE = F.params(), pD = F.params({ drsOpen: true }), pN = F.params({ ers: false });
  var b200 = brakeFrom(pE, 200), b300 = brakeFrom(pE, 300);
  return {
    power_hp: Math.round(pE.power_hp), mass_kg: pE.mass,
    zeroTo100_s: accelTo(pE, 100), zeroTo200_s: accelTo(pE, 200),
    top_ers_drs_kph: topSpeed(pD), top_ers_kph: topSpeed(pE), top_noErs_kph: topSpeed(pN),
    brake200_m: b200.dist, brakePeak300_g: b300.peakG, brake300_m: b300.dist,
    lat120_g: cornering(pE, 120), lat200_g: cornering(pE, 200), lat250_g: cornering(pE, 250), lat300_g: cornering(pE, 300),
    caps: pE.capabilities
  };
}
module.exports = { measure: measure, topSpeed: topSpeed, brakeFrom: brakeFrom, cornering: cornering, accelTo: accelTo, ENV: ENV };

if (require.main === module) {
  var m = measure();
  var f = function (v, d) { return typeof v === 'number' ? v.toFixed(d == null ? 2 : d) : String(v); };
  console.log('F1 car (single spec) — CB.race.vehicle measurements');
  console.log('  power ............. ' + m.power_hp + ' hp (ICE ' + F.SPEC.ice_kw + ' kW + ERS ' + F.SPEC.ers_kw + ' kW), ' + m.mass_kg + ' kg');
  console.log('  0–100 km/h ........ ' + f(m.zeroTo100_s) + ' s   (target ≈ 2.6)');
  console.log('  0–200 km/h ........ ' + f(m.zeroTo200_s) + ' s   (real ≈ 4.5–5)');
  console.log('  top, ERS + DRS .... ' + f(m.top_ers_drs_kph, 1) + ' km/h (target 340–350)');
  console.log('  top, ERS .......... ' + f(m.top_ers_kph, 1) + ' km/h');
  console.log('  top, ICE only ..... ' + f(m.top_noErs_kph, 1) + ' km/h');
  console.log('  200→0 ............. ' + f(m.brake200_m, 1) + ' m    (target ≈ 55)');
  console.log('  300→0 ............. ' + f(m.brake300_m, 1) + ' m, peak ' + f(m.brakePeak300_g) + ' g (target ≈ 5)');
  console.log('  cornering ......... 120: ' + f(m.lat120_g) + ' g · 200: ' + f(m.lat200_g) + ' g · 250: ' + f(m.lat250_g) + ' g · 300: ' + f(m.lat300_g) + ' g');
  console.log('  capabilities ...... maxLatG ' + f(m.caps.maxLatG) + ' · latG_200 ' + f(m.caps.latG_200) + ' · maxBrakeG ' + f(m.caps.maxBrakeG) + ' · vmax ' + f(m.caps.topSpeed_mps * 3.6, 0));
}

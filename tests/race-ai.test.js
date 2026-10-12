/* Node tests for js/race/ai.js — run: node tests/race-ai.test.js
   Uses the real CB.data / CB.state / CB.physics / CB.race.tracks / CB.race.vehicle when present and loadable,
   and always also runs against minimal local stubs (stub oval geometry + stub vehicle) so the AI is
   verifiable in isolation. */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
function tryLoad(rel) {
  var p = path.join(root, rel);
  if (!fs.existsSync(p)) return false;
  try { require(p); return true; } catch (e) { console.log('  (skip ' + rel + ': ' + e.message + ')'); return false; }
}
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js'].forEach(tryLoad);
var haveTracks = tryLoad('js/race/tracks.js');
var haveVehicle = tryLoad('js/race/vehicle.js');
var ai = require(path.join(root, 'js', 'race', 'ai.js'));
var CB = globalThis.CB;
var I = ai._internal;

// Standalone: run inline and print a summary. Under tests/run.js: register with the shared runner so a
// failure here fails the suite (a local harness would only set process.exitCode, which the runner overrides).
var standalone = require.main === module || typeof globalThis.test !== 'function';
var passed = 0, failed = 0;
function test(name, fn) {
  if (!standalone) return globalThis.test('race-ai: ' + name, fn);
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

/* ------------------------------------------------------------------ stubs */

/** Stadium oval: two straights + two semicircles, samples every ~2 m. */
function stubOval(straight, radius, width) {
  straight = straight || 320; radius = radius || 70; width = width || 14;
  var samples = [], s = 0, ds = 2;
  var L = 2 * straight + 2 * Math.PI * radius;
  var n = Math.round(L / ds);
  for (var i = 0; i < n; i++) {
    var d = i * L / n, x, y, h, k;
    if (d < straight) { x = -straight / 2 + d; y = -radius; h = 0; k = 0; }
    else if (d < straight + Math.PI * radius) {
      var a = (d - straight) / radius; x = straight / 2 + radius * Math.sin(a); y = -radius * Math.cos(a); h = a; k = 1 / radius;
    } else if (d < 2 * straight + Math.PI * radius) {
      var d2 = d - straight - Math.PI * radius; x = straight / 2 - d2; y = radius; h = Math.PI; k = 0;
    } else {
      var a2 = (d - 2 * straight - Math.PI * radius) / radius; x = -straight / 2 - radius * Math.sin(a2); y = radius * Math.cos(a2); h = Math.PI + a2; k = 1 / radius;
    }
    samples.push({ x: x, y: y, heading: h, curvature: k, s: d, width: width, leftKerb: false, rightKerb: false });
  }
  return { samples: samples, length: L, width: width, gridSlots: [{ x: -straight / 2 + 40, y: -radius, heading: 0 }] };
}

/** Simple planar vehicle: kinematic bicycle with a lateral-grip limit (slides wide when overdriven). */
var stubVehicle = {
  fromBuild: function (build, opts) {
    opts = opts || {};
    return { mass: opts.mass || 1450, wheelbase: 2.65, width: 1.9, length: 4.5, maxSteer: 0.55, mu: opts.mu || 1.05,
      power_kw: opts.power_kw || 300, cdA: 0.65, downforce_kg_200: opts.df || 60, maxBrakeG: (opts.mu || 1.05) * 0.95, abs: true };
  },
  createState: function (p, pose) {
    return { x: pose.x, y: pose.y, heading: pose.heading, vx: 0, vy: 0, speed: 0, yawRate: 0, steerAngle: 0, rpm: 1000, gear: 1,
      wheelspin: 0, skidding: 0, slipAngleF: 0, slipAngleR: 0 };
  },
  step: function (p, s, inp, dt, env) {
    var grip = (env && env.gripMult) || 1;
    var v = s.vx;
    var lock = p.maxSteer / (1 + Math.pow(Math.abs(v) / 45, 2) * 0.6);     // speed-sensitive steering
    var target = clamp(inp.steer || 0, -1, 1) * lock;
    s.steerAngle += clamp(target - s.steerAngle, -3 * dt, 3 * dt);
    var df = p.downforce_kg_200 * 9.81 * (v * v) / (55.56 * 55.56);
    var muN = p.mu * grip * (p.mass * 9.81 + df);
    var drag = 0.5 * 1.225 * p.cdA * v * v + 0.013 * p.mass * 9.81;
    var fDrive = inp.throttle * Math.min(p.power_kw * 1000 / Math.max(3, Math.abs(v)), muN * 0.6);
    var fBrake = inp.brake * muN * 0.95;
    var yawKin = v * Math.tan(s.steerAngle) / p.wheelbase;
    var aLat = v * yawKin;
    var latMax = muN / p.mass;
    s.skidding = 0;
    if (Math.abs(aLat) > latMax) { yawKin *= latMax / Math.abs(aLat); s.skidding = 1; aLat = sign(aLat) * latMax; }
    // friction circle on longitudinal
    var longMax = Math.sqrt(Math.max(0.05, 1 - Math.pow(aLat / latMax, 2))) * muN;
    var fx;
    if (inp.reverse && v < 0.5) fx = -0.3 * p.mass * 9.81 * (inp.brake || 1) - (v < 0 ? -drag : drag);
    else if (v <= 0.05 && inp.brake > 0 && inp.throttle < 0.05) { fx = 0; s.vx = Math.max(0, s.vx); }
    else fx = clamp(fDrive, -longMax, longMax) - Math.min(fBrake, longMax) * sign(v || 1) - drag * sign(v);
    s.vx += fx / p.mass * dt;
    if (!inp.reverse && s.vx < 0 && inp.brake > 0) s.vx = Math.min(0, s.vx + 5 * dt);
    if (inp.reverse) s.vx = Math.max(s.vx, -6);
    s.yawRate = yawKin;
    s.heading += yawKin * dt;
    s.x += Math.cos(s.heading) * s.vx * dt;
    s.y += Math.sin(s.heading) * s.vx * dt;
    s.vy = 0;
    s.speed = Math.abs(s.vx);
    s.wheelspin = fDrive > muN * 0.6 * 0.99 && inp.throttle > 0.9 ? 0.2 : 0;
    return s;
  },
};
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }

/* ------------------------------------------------------------------ sim harness */

function simulate(opts) {
  var geom = opts.geom, A = I.adaptGeom(geom), veh = opts.vehicle || stubVehicle;
  var entries = opts.cars.map(function (c, k) {
    var params = c.params;
    var driver = ai.createDriver(c.opponent, geom, params, c.driverOpts);
    var st = veh.createState(params, c.pose);
    return { id: c.opponent.id, driver: driver, params: params, state: st, hint: -1, lapS: 0, laps: 0, prevS: null,
      maxOff: 0, offT: 0, isPlayer: !!c.isPlayer, progress: 0 };
  });
  var dt = 1 / 120, t = 0, minDist = Infinity;
  var tMax = opts.time || 120;
  while (t < tMax) {
    var cars = entries.map(function (e) {
      return { id: e.id, x: e.state.x, y: e.state.y, heading: e.state.heading, speed: e.state.speed, vx: e.state.vx, vy: e.state.vy,
        s: e.prevS || 0, lap: e.laps, length_m: 4.5, width_m: 1.9, isPlayer: e.isPlayer };
    });
    var ctx = { t: t, phase: t < 0.5 ? 'countdown' : 'racing', countdown: { lightsOut: t >= 0.5 }, cars: cars, weather: opts.weather || 'dry' };
    entries.forEach(function (e) {
      var inp = e.driver.control(e.state, ctx, dt);
      ['throttle', 'brake', 'steer'].forEach(function (k) { assert.ok(isFinite(inp[k]), k + ' must be finite'); });
      assert.ok(inp.throttle >= 0 && inp.throttle <= 1 && inp.brake >= 0 && inp.brake <= 1 && Math.abs(inp.steer) <= 1);
      var pr = I.projectLocal(A, e.state.x, e.state.y, e.hint);
      e.hint = pr.index;
      // Off-track per the tracks contract: beyond asphalt + kerb on that side (riding kerbs is legal).
      var hw = A.hw[pr.index];
      var kerb = pr.lateral > 0 ? A.kerbL[pr.index] : A.kerbR[pr.index];
      var excess = Math.abs(pr.lateral) - hw - kerb;
      var asphaltExcess = Math.abs(pr.lateral) - hw;
      if (excess > e.maxOff) e.maxOff = excess;
      if (asphaltExcess > (e.maxAsphalt || 0)) e.maxAsphalt = asphaltExcess;
      if (excess > 0) e.offT += dt;
      veh.step(e.params, e.state, inp, dt, { gripMult: excess > 0.5 ? 0.6 : (opts.gripMult || 1), wet: false });
      if (e.prevS !== null) {
        var d = pr.s - e.prevS;
        if (d < -A.length / 2) { e.laps++; d += A.length; }
        else if (d > A.length / 2) { e.laps--; d -= A.length; }
        e.progress += d;
      }
      e.prevS = pr.s;
    });
    for (var a = 0; a < entries.length; a++) for (var b = a + 1; b < entries.length; b++) {
      var dd = Math.hypot(entries[a].state.x - entries[b].state.x, entries[a].state.y - entries[b].state.y);
      if (t > 3 && dd < minDist) minDist = dd;
    }
    t += dt;
    if (opts.untilLaps && entries.every(function (e) { return e.laps >= opts.untilLaps; })) break;
  }
  return { entries: entries, t: t, minDist: minDist };
}

function poseOn(geom, sMeters, lateral) {
  var A = I.adaptGeom(geom), i = Math.round(sMeters / A.ds) % A.n;
  return { x: A.xs[i] - Math.sin(A.hs[i]) * (lateral || 0), y: A.ys[i] + Math.cos(A.hs[i]) * (lateral || 0), heading: A.hs[i] };
}

/* ------------------------------------------------------------------ grid tests */

var playerBuild = CB.data && CB.data.defaultBuild ? CB.data.defaultBuild() : null;

test('createGrid returns requested count with complete fields', function () {
  var grid = ai.createGrid(playerBuild, { count: 7, difficulty: 'pro', field: 'similar', seed: 42 });
  assert.strictEqual(grid.length, 7);
  var names = {}, nums = {};
  grid.forEach(function (o) {
    assert.ok(o.name && o.team && o.id, 'name/team/id');
    assert.ok(/^#[0-9a-f]{6}$/i.test(o.color) && /^#[0-9a-f]{6}$/i.test(o.accent), 'livery colors');
    assert.ok(o.number >= 2 && o.number <= 99);
    assert.ok(!names[o.name] && !nums[o.number], 'unique names & numbers');
    names[o.name] = 1; nums[o.number] = 1;
    ['skill', 'aggression', 'consistency'].forEach(function (k) { assert.ok(o[k] >= 0 && o[k] <= 1, k); });
    assert.ok(o.build && o.build.engine && o.build.tires && o.build.exterior, 'build shape');
    assert.strictEqual(o.build.exterior.paint.toLowerCase(), o.color.toLowerCase());
  });
});

test('createGrid clamps count to 1..11 and has 40+ fictional drivers', function () {
  assert.strictEqual(ai.createGrid(playerBuild, { count: 50 }).length, 11);
  assert.strictEqual(ai.createGrid(playerBuild, { count: 0 }).length, 1);
  assert.ok(ai.DRIVERS.length >= 40);
  assert.ok(ai.TEAMS.length >= 12);
});

test('createGrid is deterministic for a seed', function () {
  var a = ai.createGrid(playerBuild, { count: 5, seed: 'abc' }), b = ai.createGrid(playerBuild, { count: 5, seed: 'abc' });
  assert.deepStrictEqual(a.map(function (o) { return [o.name, o.number, o.skill]; }), b.map(function (o) { return [o.name, o.number, o.skill]; }));
});

test('difficulty maps to skill ordering', function () {
  var mean = function (d) {
    var g = ai.createGrid(playerBuild, { count: 11, difficulty: d, seed: 7 });
    return g.reduce(function (s, o) { return s + o.skill; }, 0) / g.length;
  };
  var r = mean('rookie'), am = mean('amateur'), p = mean('pro'), al = mean('alien');
  assert.ok(r < am && am < p && p < al, [r, am, p, al].join(' '));
});

test('similar field is performance-matched to the player', function () {
  var player = playerBuild;
  var pi = ai.perfIndex(player);
  var g = ai.createGrid(player, { count: 8, difficulty: 'pro', field: 'similar', seed: 3 });
  g.forEach(function (o) { assert.ok(o.perfRatio > 0.85 && o.perfRatio < 1.15, 'ratio ' + o.perfRatio + ' (player ' + pi + ')'); });
});

test('presets / mixed fields work (or fall back gracefully)', function () {
  var g = ai.createGrid(playerBuild, { count: 9, field: 'presets', seed: 5 });
  assert.strictEqual(g.length, 9);
  if (CB.data && CB.data.presets && CB.data.presets.length) assert.ok(g.some(function (o) { return /^preset:/.test(o.origin); }));
  var m = ai.createGrid(playerBuild, { count: 6, field: 'mixed', seed: 5 });
  assert.strictEqual(m.length, 6);
});

test('createGrid works with no player build', function () {
  var g = ai.createGrid(null, { count: 3 });
  assert.strictEqual(g.length, 3);
});

/* ------------------------------------------------------------------ driver tests (stub geometry/vehicle) */

var oval = stubOval();
function makeOpp(id, skill, extra) {
  var o = { id: id, name: 'Test ' + id, skill: skill, consistency: 0.95, aggression: 0.6, reaction_s: 0.2, seed: 11 };
  for (var k in extra || {}) o[k] = extra[k];
  return o;
}

test('estimateLimits reads stub params', function () {
  var L = ai.estimateLimits(stubVehicle.fromBuild(null));
  assert.ok(Math.abs(L.mu - 1.05) < 0.08, 'mu ' + L.mu);
  assert.ok(L.power > 200000 && L.mass === 1450 && L.dfK > 0);
});

test('fallback racing line stays within track and uses width in corners', function () {
  var A = I.adaptGeom(oval);
  var maxOff = 0;
  for (var i = 0; i < A.n; i++) { assert.ok(Math.abs(A.lineOff[i]) <= A.hw[i]); maxOff = Math.max(maxOff, Math.abs(A.lineOff[i])); }
  assert.ok(maxOff > 2, 'line should use track width, max ' + maxOff);
});

test('solo driver completes 3 laps on stub oval without leaving the track', function () {
  var params = stubVehicle.fromBuild(null);
  var r = simulate({ geom: oval, time: 200, untilLaps: 3, cars: [{ opponent: makeOpp('ai-1', 0.9), params: params, pose: poseOn(oval, 40, 0) }] });
  var e = r.entries[0];
  assert.ok(e.laps >= 3, 'laps ' + e.laps + ' in ' + r.t.toFixed(1) + 's');
  assert.ok(e.maxOff < 0.3, 'max off-track excess ' + e.maxOff.toFixed(2) + ' m');
  var lapTime = r.t / 3;
  console.log('       stub oval lap ~' + lapTime.toFixed(1) + ' s, max excess ' + e.maxOff.toFixed(2) + ' m');
});

test('higher skill laps faster', function () {
  var params = stubVehicle.fromBuild(null);
  function lapsIn(skill) {
    var r = simulate({ geom: oval, time: 90, cars: [{ opponent: makeOpp('a', skill, { consistency: 1 }), params: params, pose: poseOn(oval, 40, 0) }] });
    return r.entries[0].progress;
  }
  var lo = lapsIn(0.5), hi = lapsIn(1.0);
  assert.ok(hi > lo * 1.03, 'progress hi ' + hi.toFixed(0) + ' vs lo ' + lo.toFixed(0));
});

test('wet conditions reduce pace but stay on track', function () {
  var params = stubVehicle.fromBuild(null);
  var dry = simulate({ geom: oval, time: 60, cars: [{ opponent: makeOpp('a', 0.9), params: params, pose: poseOn(oval, 40, 0) }] });
  var wet = simulate({ geom: oval, time: 60, weather: 'wet', gripMult: 0.72, cars: [{ opponent: makeOpp('a', 0.9), params: params, pose: poseOn(oval, 40, 0) }] });
  assert.ok(wet.entries[0].progress < dry.entries[0].progress);
  assert.ok(wet.entries[0].maxOff < 0.3, 'wet excess ' + wet.entries[0].maxOff);
});

test('faster car overtakes slower car ahead without contact', function () {
  var slow = stubVehicle.fromBuild(null, { power_kw: 160 });
  var fast = stubVehicle.fromBuild(null, { power_kw: 420 });
  var r = simulate({ geom: oval, time: 120, cars: [
    { opponent: makeOpp('slow', 0.8, { aggression: 0.5, personality: 'smooth' }), params: slow, pose: poseOn(oval, 70, 0) },
    { opponent: makeOpp('fast', 0.95, { aggression: 0.8, seed: 99 }), params: fast, pose: poseOn(oval, 40, 0) },
  ] });
  var s = r.entries[0], f = r.entries[1];
  assert.ok(f.progress > s.progress + 30, 'fast ' + f.progress.toFixed(0) + ' vs slow ' + s.progress.toFixed(0) + ' (start gap 30 m)');
  assert.ok(r.minDist > 1.6, 'min center distance ' + r.minDist.toFixed(2));
  assert.ok(f.maxOff < 0.6 && s.maxOff < 0.6, 'both stay on track');
});

test('a pack of 6 cars runs 2 minutes without contact or leaving the track', function () {
  var cars = [];
  for (var i = 0; i < 6; i++) {
    cars.push({ opponent: makeOpp('c' + i, 0.75 + i * 0.04, { seed: 100 + i, aggression: 0.3 + i * 0.1, consistency: 0.9 }),
      params: stubVehicle.fromBuild(null, { power_kw: 260 + i * 25 }), pose: poseOn(oval, 20 + (5 - i) * 12, i % 2 ? 3 : -3) });
  }
  var r = simulate({ geom: oval, time: 120, cars: cars });
  r.entries.forEach(function (e) { assert.ok(e.maxOff < 1.0, e.id + ' excess ' + e.maxOff.toFixed(2)); assert.ok(e.progress > 1000); });
  assert.ok(r.minDist > 1.2, 'min center distance ' + r.minDist.toFixed(2));
});

test('recovers from a spin facing backwards', function () {
  var params = stubVehicle.fromBuild(null);
  var pose = poseOn(oval, 100, 2);
  pose.heading += Math.PI;  // facing the wrong way
  var r = simulate({ geom: oval, time: 30, cars: [{ opponent: makeOpp('r', 0.8), params: params, pose: pose }] });
  var e = r.entries[0];
  assert.ok(e.progress > 300, 'progress after spin ' + e.progress.toFixed(0));
});

test('recovers from being off track on the grass', function () {
  var params = stubVehicle.fromBuild(null);
  var pose = poseOn(oval, 150, 13);  // 6 m beyond the left edge
  var r = simulate({ geom: oval, time: 30, cars: [{ opponent: makeOpp('g', 0.8), params: params, pose: pose }] });
  assert.ok(r.entries[0].progress > 400, 'progress ' + r.entries[0].progress.toFixed(0));
  var A = I.adaptGeom(oval), pr = I.projectLocal(A, r.entries[0].state.x, r.entries[0].state.y, -1);
  assert.ok(Math.abs(pr.lateral) < A.hw[pr.index], 'back on track');
});

test('holds the brakes on the grid until lights out', function () {
  var d = ai.createDriver(makeOpp('g', 0.9), oval, stubVehicle.fromBuild(null));
  var st = stubVehicle.createState(null, poseOn(oval, 40, 0));
  var inp = d.control(st, { phase: 'countdown', countdown: { lightsOut: false }, cars: [] }, 1 / 120);
  assert.strictEqual(inp.throttle, 0);
  assert.ok(inp.brake > 0);
});

test('mistakes occur more often for inconsistent drivers', function () {
  function count(cons) {
    var d = ai.createDriver(makeOpp('m', 0.8, { consistency: cons, seed: 5 }), oval, stubVehicle.fromBuild(null));
    var st = stubVehicle.createState(null, poseOn(oval, 40, 0)), n = 0, prev = null, p = stubVehicle.fromBuild(null);
    for (var i = 0; i < 120 * 240; i++) {
      var inp = d.control(st, { phase: 'racing', cars: [] }, 1 / 120);
      stubVehicle.step(p, st, inp, 1 / 120, {});
      var m = d.debug().mistake;
      if (m && m !== prev) n++;
      prev = m;
    }
    return n;
  }
  var hi = count(0.2), lo = count(0.99);
  assert.ok(hi > lo, 'inconsistent ' + hi + ' vs consistent ' + lo);
});

test('rubber band speeds up a trailing AI when enabled', function () {
  var p = stubVehicle.fromBuild(null);
  function prog(rb) {
    var d = ai.createDriver(makeOpp('rb', 0.8, { consistency: 1 }), oval, p, { rubberBand: rb });
    var st = stubVehicle.createState(p, poseOn(oval, 0, 0));
    var A = I.adaptGeom(oval), hint = -1, sum = 0, prevS = null;
    for (var i = 0; i < 120 * 40; i++) {
      var pr = I.projectLocal(A, st.x, st.y, hint); hint = pr.index;
      if (prevS !== null) { var dd = pr.s - prevS; if (dd < -A.length / 2) dd += A.length; sum += dd; }
      prevS = pr.s;
      var ctx = { phase: 'racing', cars: [{ id: 'rb', x: st.x, y: st.y, s: pr.s, lap: 0 }, { id: 'P', isPlayer: true, x: 1e5, y: 1e5, s: (pr.s + 500) % A.length, lap: 1 }] };
      stubVehicle.step(p, st, d.control(st, ctx, 1 / 120), 1 / 120, {});
    }
    return sum;
  }
  assert.ok(prog(true) > prog(false));
});

/* ------------------------------------------------------------------ integration with real modules */

test('a sideways slide at heading +-90 deg never flips the driver into world-frame velocities', function () {
  // Regression: a vehicle sliding sideways (body vy ~ speed) at heading pi/2 looks exactly like a world-frame
  // state driving straight; the driver used to latch "world" there and steer against phantom slip forever.
  var params = stubVehicle.fromBuild(null);
  var drv = ai.createDriver(makeOpp('slide', 0.9), oval, params);
  var A = I.adaptGeom(oval), idx = 0, best = 9;
  for (var i = 0; i < A.n; i++) { var dh = Math.abs(A.hs[i] - Math.PI / 2); if (dh < best) { best = dh; idx = i; } }
  var h = A.hs[idx], x = A.xs[idx], y = A.ys[idx];
  var ctx = function (st) { return { t: 10, phase: 'racing', countdown: { lightsOut: true }, cars: [{ id: 'slide', x: st.x, y: st.y, heading: st.heading, speed: st.speed, vx: st.vx, vy: st.vy, s: 0, lap: 0 }] }; };
  var slide = { x: x, y: y, heading: h, vx: 0.4, vy: 20, speed: 20, yawRate: 0.1, steerAngle: 0, rpm: 4000, gear: 3, slipAngleF: 1.2, slipAngleR: 1.4, wheelspin: 0, skidding: 1 };
  for (var k = 0; k < 120; k++) drv.control(slide, ctx(slide), 1 / 120);
  var clean = { x: x, y: y, heading: h, vx: 20, vy: 0, speed: 20, yawRate: 20 * (A.k ? A.k[idx] : 0), steerAngle: 0, rpm: 4000, gear: 3, slipAngleF: 0, slipAngleR: 0, wheelspin: 0, skidding: 0 };
  var inp;
  for (var m = 0; m < 120; m++) inp = drv.control(clean, ctx(clean), 1 / 120);
  var dbg = drv.debug();
  // A world-frame misread makes the clean state look like a 90 deg slide: the tracker winds on a huge
  // correction curvature and grip learning collapses. Read correctly, the car is simply off-line.
  assert.ok(Math.abs(dbg.kTrack) < 0.08, 'tracker curvature ' + dbg.kTrack + ' (steer ' + inp.steer + ')');
  assert.ok(!(dbg.gl < 0.95), 'grip estimate collapsed to ' + dbg.gl);
});

if (haveTracks && CB.race.tracks && typeof CB.race.tracks.build === 'function' && Array.isArray(CB.race.tracks.list)) {
  var useVehicle = haveVehicle && CB.race.vehicle && typeof CB.race.vehicle.fromBuild === 'function' &&
    typeof CB.race.vehicle.createState === 'function' && typeof CB.race.vehicle.step === 'function';
  CB.race.tracks.list.forEach(function (def) {
    test('real track "' + def.id + '": AI drives a lap (stub vehicle)', function () {
      var geom = CB.race.tracks.build(def);
      var A = I.adaptGeom(geom);
      var r = simulate({ geom: geom, time: Math.max(120, A.length / 15), untilLaps: 1,
        cars: [{ opponent: makeOpp('t', 0.9), params: stubVehicle.fromBuild(null), pose: poseOn(geom, 10, 0) }] });
      var e = r.entries[0];
      console.log('       ' + def.id + ': ' + Math.round(A.length) + ' m, lap ' + r.t.toFixed(1) + ' s, off-track ' + e.offT.toFixed(2) + ' s, max excess ' + e.maxOff.toFixed(2) + ' m');
      assert.ok(e.laps >= 1, 'completed lap');
      assert.ok(e.offT < 2.0, 'off-track time ' + e.offT.toFixed(2));
    });
    if (useVehicle) {
      // Both the default build (rear-engined 911 Carrera S) and the front-engined V8 reference coupe: the AI must
      // handle a rear-limited, oversteer-prone car as well as the calibration car (no pinning to the easy one).
      [['default 911', function () { return CB.data.defaultBuild(); }],
        ['reference V8', function () { return (CB.data.referenceBuild || CB.data.defaultBuild)(); }]].forEach(function (bc) {
        test('real track "' + def.id + '": AI drives a lap (real vehicle, ' + bc[0] + ')', function () {
          var geom = CB.race.tracks.build(def);
          var A = I.adaptGeom(geom);
          var build = bc[1]();
          var metrics = CB.physics && CB.physics.compute ? CB.physics.compute(build) : null;
          var params = CB.race.vehicle.fromBuild(build, metrics);
          var r = simulate({ geom: geom, vehicle: CB.race.vehicle, time: Math.max(150, A.length / 12), untilLaps: 1,
            cars: [{ opponent: makeOpp('t', 0.9, { build: build }), params: params, pose: poseOn(geom, 10, 0) }] });
          var e = r.entries[0];
          console.log('       ' + def.id + ' (' + bc[0] + '): lap ' + r.t.toFixed(1) + ' s, off-track ' + e.offT.toFixed(2) + ' s, max excess ' + e.maxOff.toFixed(2) + ' m');
          assert.ok(e.laps >= 1, 'completed lap (progress ' + e.progress.toFixed(0) + ' m of ' + A.length.toFixed(0) + ')');
          assert.ok(e.offT < 1.0, 'off-track time ' + e.offT.toFixed(2));
          assert.ok(e.maxOff < 0.5, 'max excess beyond the kerb ' + e.maxOff.toFixed(2) + ' m');
          var avg = A.length / r.t * 3.6;
          assert.ok(avg > 55 && avg < 260, 'plausible average speed ' + avg.toFixed(0) + ' km/h');
        });
      });
    }
  });
  if (useVehicle && CB.data && typeof CB.data.defaultBuild === 'function') {
    [['default 911', function () { return CB.data.defaultBuild(); }],
      ['reference V8', function () { return (CB.data.referenceBuild || CB.data.defaultBuild)(); }]].forEach(function (bc) {
    test('real track pack: a createGrid field of 6 (' + bc[0] + ' variations) races 90 s on the Redline Ring without contact', function () {
      var def = CB.race.tracks.get ? CB.race.tracks.get('forge-ring') : CB.race.tracks.list[0];
      var geom = CB.race.tracks.build(def || CB.race.tracks.list[0]);
      var grid = ai.createGrid(bc[1](), { count: 6, difficulty: 'pro', field: 'similar', seed: 21 });
      var slots = geom.gridSlots || [];
      var cars = grid.map(function (o, k) {
        var params = CB.race.vehicle.fromBuild(o.build, CB.physics && CB.physics.compute ? CB.physics.compute(o.build) : null);
        var sl = slots[k] || poseOn(geom, 10 + k * 12, k % 2 ? 2.5 : -2.5);
        return { opponent: o, params: params, pose: { x: sl.x, y: sl.y, heading: sl.heading } };
      });
      var r = simulate({ geom: geom, vehicle: CB.race.vehicle, time: 90, cars: cars });
      r.entries.forEach(function (e) {
        assert.ok(e.progress > 1500, e.id + ' progress ' + e.progress.toFixed(0));
        assert.ok(e.offT < 4, e.id + ' off-track ' + e.offT.toFixed(2));
      });
      console.log('       pack min centre distance ' + r.minDist.toFixed(2) + ' m, progress ' +
        r.entries.map(function (e) { return e.progress.toFixed(0); }).join('/'));
      assert.ok(r.minDist > 1.2, 'min center distance ' + r.minDist.toFixed(2));
    });
    });
  }
} else {
  console.log('  (CB.race.tracks not available yet — real-track integration tests skipped)');
}

if (standalone) console.log('\nrace-ai: ' + passed + ' passed, ' + failed + ' failed');

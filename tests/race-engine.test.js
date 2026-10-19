/* Node tests for js/race/engine.js — run: node tests/race-engine.test.js  (or via node tests/run.js)
   Runs every scenario against the engine's internal fallbacks (stub track / vehicle / driver, via cfg._forceFallback)
   so the engine is verifiable in isolation, and additionally against the real CB.race.tracks / vehicle / ai modules
   when they are present and loadable (they are built in parallel and may be missing). */
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
var haveAi = tryLoad('js/race/ai.js');
var E = require(path.join(root, 'js', 'race', 'engine.js'));
var CB = globalThis.CB;
var I = E._internal;
var REAL = haveTracks && haveVehicle && haveAi;

/* ------------------------------------------------------------------ runner (standalone or tests/run.js) */
var local = typeof globalThis.test !== 'function';
var passed = 0, failed = 0, queue = [];
function test(name, fn) {
  if (!local) return globalThis.test('engine: ' + name, function () { fn(); });
  queue.push({ name: name, fn: fn });
}

/* ------------------------------------------------------------------ helpers */
var EVENT_TYPES = ['collision', 'wall', 'lap', 'sector', 'penalty', 'finish', 'jumpstart', 'trackLimits', 'fastestLap',
  'light', 'start', 'dnf', 'reset', 'wrongWay', 'ghost', 'sessionEnd'];
var SURFACES = ['asphalt', 'kerb', 'grass', 'sand', 'gravel', 'wall', 'pit'];

function memStorage() {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; },
    keys: function () { return Object.keys(m); }
  };
}
function base(extra, fallback) {
  var c = { laps: 2, opponents: 5, seed: 1234, mode: 'race', storage: memStorage(), difficulty: 'pro' };
  if (fallback) c._forceFallback = true;
  return Object.assign(c, extra || {});
}
function finiteDeep(o, where, seen) {
  seen = seen || [];
  if (typeof o === 'number') { assert.ok(isFinite(o), 'non-finite number at ' + where); return; }
  if (!o || typeof o !== 'object' || seen.indexOf(o) >= 0) return;
  seen.push(o);
  if (where.indexOf('.build') >= 0) return;  // builds are configurator data, not sim state
  Object.keys(o).forEach(function (k) { finiteDeep(o[k], where + '.' + k, seen); });
}
function checkSnapshot(sn, nCars) {
  assert.ok(['grid', 'countdown', 'racing', 'finished'].indexOf(sn.phase) >= 0, 'phase ' + sn.phase);
  assert.ok(sn.countdown && typeof sn.countdown.lightsOn === 'number' && typeof sn.countdown.lightsOut === 'boolean');
  assert.ok(sn.countdown.lightsOn >= 0 && sn.countdown.lightsOn <= 5);
  assert.strictEqual(sn.playerId, 'player');
  assert.strictEqual(sn.cars.length, nCars);
  var pos = sn.cars.map(function (c) { return c.position; }).sort(function (a, b) { return a - b; });
  pos.forEach(function (p, i) { assert.strictEqual(p, i + 1, 'positions must be a permutation of 1..N'); });
  assert.strictEqual(sn.cars.filter(function (c) { return c.isPlayer; }).length, 1);
  sn.cars.forEach(function (c) {
    ['x', 'y', 'heading', 'speed', 'rpm', 'redline', 'gear', 'maxGear', 'steerAngle', 'throttle', 'brake', 'slipF', 'slipR',
      'skidding', 'wheelspin', 'lap', 's', 'position', 'currentLap_s', 'length_m', 'width_m', 'penalties_s', 'trackLimits']
      .forEach(function (k) { assert.ok(typeof c[k] === 'number' && isFinite(c[k]), 'car ' + c.id + '.' + k + ' = ' + c[k]); });
    ['finished', 'dnf', 'wrongWay', 'lapValid', 'offTrack', 'isPlayer'].forEach(function (k) {
      assert.strictEqual(typeof c[k], 'boolean', 'car ' + c.id + '.' + k);
    });
    assert.ok(/^#[0-9a-f]{3,8}$/i.test(c.color), 'color hex ' + c.color);
    assert.ok(/^#[0-9a-f]{3,8}$/i.test(c.accent), 'accent hex ' + c.accent);
    assert.ok(SURFACES.indexOf(c.surface) >= 0, 'surface ' + c.surface);
    assert.ok(Array.isArray(c.sectors) && c.sectors.length === 3);
    assert.ok(c.skidding >= 0 && c.skidding <= 1 && c.wheelspin >= 0 && c.wheelspin <= 1);
    assert.ok(c.s >= 0 && c.s <= sn.trackLength + 1e-6, 's in lap range');
    ['gapAhead_s', 'gapLeader_s'].forEach(function (k) { assert.ok(c[k] === null || (typeof c[k] === 'number' && isFinite(c[k])), k); });
  });
  sn.events.forEach(function (e) {
    assert.ok(EVENT_TYPES.indexOf(e.type) >= 0, 'unknown event type ' + e.type);
    if (e.intensity !== undefined) assert.ok(e.intensity >= 0 && e.intensity <= 1, 'intensity 0..1');
  });
  if (sn.ghost) ['x', 'y', 'heading'].forEach(function (k) { assert.ok(isFinite(sn.ghost[k])); });
}
/** Drives a full session with the player on autopilot; checks every snapshot. */
function runRace(cfg, opts) {
  opts = opts || {};
  var s = E.createSession(Object.assign({ playerAutopilot: true }, cfg));
  if (cfg.mode === 'race') assert.strictEqual(s.snapshot().cars.length, 1 + (cfg.opponents || 0));
  var n = s.snapshot().cars.length, snaps = 0, evCount = {}, lastPositions = null, maxT = opts.maxT || 1500;
  while (s.getPhase() !== 'finished' && s.time() < maxT) {
    s.update(0.25, {});
    var sn = s.snapshot();
    checkSnapshot(sn, n);
    sn.events.forEach(function (e) { evCount[e.type] = (evCount[e.type] || 0) + 1; });
    lastPositions = sn.cars.map(function (c) { return c.position; });
    snaps++;
  }
  return { s: s, res: s.results(), snaps: snaps, ev: evCount, last: s.snapshot(), positions: lastPositions };
}
function checkResults(r, laps, n) {
  assert.strictEqual(r.complete, true, 'race should complete');
  assert.strictEqual(r.classification.length, n);
  r.classification.forEach(function (row, i) {
    assert.strictEqual(row.position, i + 1);
    assert.ok(['finished', 'dnf', 'running'].indexOf(row.status) >= 0);
  });
  var fin = r.classification.filter(function (x) { return x.status === 'finished'; });
  assert.ok(fin.length >= Math.ceil(n / 2), 'most cars should finish (' + fin.length + '/' + n + ')');
  // finished cars come first and are ordered by (laps desc, total time asc)
  for (var i = 1; i < fin.length; i++) {
    var a = fin[i - 1], b = fin[i];
    assert.ok(a.laps > b.laps || (a.laps === b.laps && a.totalTime_s <= b.totalTime_s + 1e-9), 'finish order by time');
  }
  var dnfIdx = r.classification.map(function (x) { return x.status; }).indexOf('dnf');
  if (dnfIdx >= 0) r.classification.slice(dnfIdx).forEach(function (x) { assert.strictEqual(x.status, 'dnf', 'DNFs classified last'); });
  // the winner did all the laps, with lap times that add up to its race time
  var w = r.classification[0];
  assert.strictEqual(w.status, 'finished');
  assert.strictEqual(w.laps, laps);
  assert.strictEqual(w.lapTimes.length, laps);
  var sum = w.lapTimes.reduce(function (p, v) { return p + v; }, 0);
  assert.ok(Math.abs(sum - w.raceTime_s) < 0.05, 'lap times sum to race time (' + sum + ' vs ' + w.raceTime_s + ')');
  w.laps_detail.forEach(function (l) {
    var ss = l.sectors.reduce(function (p, v) { return p + (v || 0); }, 0);
    assert.ok(l.sectors.every(function (v) { return v > 0; }), 'all three sectors timed');
    assert.ok(Math.abs(ss - l.time) < 0.05, 'sectors sum to lap time');
  });
  // fastest lap is the minimum valid lap of the whole field
  var best = Infinity;
  r.classification.forEach(function (x) { x.laps_detail.forEach(function (l) { if (l.valid && l.time < best) best = l.time; }); });
  if (best < Infinity) { assert.ok(r.fastestLap); assert.ok(Math.abs(r.fastestLap.time - best) < 1e-9, 'fastest lap is field minimum'); }
  assert.strictEqual(r.classification.filter(function (x) { return x.fastestLap; }).length, r.fastestLap ? 1 : 0);
  finiteDeep(r.classification, 'results');
  assert.strictEqual(r.diagnostics.nanRecoveries, 0, 'no numerical blow-ups');
}
function stripVolatile(r) {
  return JSON.stringify(r.classification.map(function (x) {
    return [x.id, x.status, x.laps, x.totalTime_s, x.penalties_s, x.lapTimes, x.trackLimits, x.collisions, x.bestLap_s];
  })) + '|' + r.lightsOutDelay_s + '|' + r.raceTime_s;
}

/* ------------------------------------------------------------------ unit: internals */
test('mulberry32 is deterministic and uniform-ish', function () {
  var a = I.mulberry32(42), b = I.mulberry32(42), c = I.mulberry32(43), sum = 0;
  for (var i = 0; i < 1000; i++) { var x = a(); assert.strictEqual(x, b()); assert.ok(x >= 0 && x < 1); sum += x; }
  assert.notStrictEqual(I.mulberry32(42)(), c());
  assert.ok(Math.abs(sum / 1000 - 0.5) < 0.05);
});

test('SAT on oriented boxes: separation, overlap, rotated, normal direction', function () {
  var A = I.obbOf(0, 0, 0, 2.2, 0.95);
  assert.strictEqual(I.satObb(A, I.obbOf(6, 0, 0, 2.2, 0.95)), null);
  var h = I.satObb(A, I.obbOf(4.0, 0, 0, 2.2, 0.95));
  assert.ok(h && Math.abs(h.depth - 0.4) < 1e-9 && h.nx === 1 && h.ny === 0, 'nose-to-tail overlap along +x');
  var side = I.satObb(A, I.obbOf(0, -1.7, 0, 2.2, 0.95));
  assert.ok(side && side.ny < 0 && Math.abs(side.depth - 0.2) < 1e-9, 'side-by-side overlap, normal A->B');
  // rotated 45 deg box whose AABB would overlap but the OBBs do not
  var R = I.obbOf(3.9, 2.6, Math.PI / 4, 2.2, 0.95);
  assert.strictEqual(I.satObb(A, R), null, 'SAT must use the boxes\' own axes');
  assert.ok(I.satObb(A, I.obbOf(2.6, 1.0, Math.PI / 4, 2.2, 0.95)));
});

test('impulse response conserves momentum and separates bodies', function () {
  var a = { m: 1400, I: 2400, vx: 30, vy: 0, w: 0, x: 0, y: 0 };
  var b = { m: 1000, I: 1600, vx: 10, vy: 0, w: 0, x: 4.3, y: 0 };
  var p0x = a.m * a.vx + b.m * b.vx;
  var r = I.resolveImpulse(a, b, { nx: 1, ny: 0, px: 2.15, py: 0 }, 0.2, 0.3);
  assert.ok(r.jn > 0 && r.vn < 0);
  assert.ok(Math.abs(a.m * a.vx + b.m * b.vx - p0x) < 1e-6, 'linear momentum');
  assert.ok(b.vx - a.vx > 0, 'bodies separate');
  assert.ok(Math.abs((b.vx - a.vx) - 0.2 * 20) < 1e-6, 'restitution 0.2 on a central hit');
  var none = I.resolveImpulse({ m: 1, I: 1, vx: 0, vy: 0, w: 0, x: 0, y: 0 }, { m: 1, I: 1, vx: 5, vy: 0, w: 0, x: 1, y: 0 }, { nx: 1, ny: 0, px: 0.5, py: 0 }, 0.2, 0.3);
  assert.strictEqual(none.jn, 0, 'no impulse when already separating');
});

test('LapTracker: sectors in order count a lap, skipping a sector is a cut, reversing builds debt', function () {
  var L = 900, t = new I.LapTracker(L, 300, 600, false), ev = [];
  function drive(from, to, step) { for (var s = from; s < to; s += step) { var e = t.advance(s % L, (s + step) % L); if (e) ev = ev.concat(e); } }
  drive(0, 900, 5);
  assert.deepStrictEqual(ev.map(function (e) { return e.kind; }), ['sector', 'sector', 'lap']);
  assert.strictEqual(t.lap, 1);
  // shortcut: sector 1 passed (cp = 1) but the car reaches the line without passing the sector-2 boundary
  t = new I.LapTracker(L, 300, 600, false);
  drive(0, 320, 5);
  var cut = t.advance(895, 3);             // from (pretend) s=895 over the line, cp still 1
  assert.strictEqual(cut[0].kind, 'cut');
  assert.strictEqual(cut[0].missed, 1);
  assert.strictEqual(t.lap, 0, 'cut lap not counted');
  // reversing over the line creates debt that must be repaid before the next lap counts
  t = new I.LapTracker(L, 300, 600, false);
  t.advance(3, 897);                       // backwards over the line
  assert.strictEqual(t.debt, 1);
  assert.ok(t.distance(897) < 0, 'race distance goes negative behind the line');
  var arm = t.advance(897, 3);
  assert.strictEqual(arm[0].kind, 'arm');
  assert.strictEqual(t.lap, 0);
});

/* ------------------------------------------------------------------ session scenarios (fallback + real) */
var variants = [{ tag: 'fallback', fb: true }];
if (REAL) variants.push({ tag: 'real modules', fb: false });
else console.log('  (real tracks/vehicle/ai not all loadable — running fallback scenarios only)');

variants.forEach(function (V) {
  test('[' + V.tag + '] full 2-lap race with 5 AI completes, consistent positions, no NaN', function () {
    var out = runRace(base({ trackId: 'forge-ring' }, V.fb));
    assert.ok(out.snaps > 50);
    checkResults(out.res, 2, 6);
    assert.ok(out.ev.lap >= 6, 'lap events');
    assert.ok(out.ev.sector >= 12, 'sector events');
    assert.strictEqual(out.ev.light, 5, 'five red lights');
    assert.strictEqual(out.ev.start, 1, 'one lights-out');
    assert.ok(out.ev.finish >= 1, 'finish events');
    assert.strictEqual(out.last.phase, 'finished');
    // final snapshot ordering agrees with the classification
    var cls = out.res.classification.filter(function (x) { return x.status === 'finished'; });
    var finishPos = {};
    out.last.cars.forEach(function (c) { finishPos[c.id] = c.finishPosition; });
    cls.forEach(function (x, i) { if (x.penalties_s === 0 && cls.every(function (y) { return y.penalties_s === 0; })) assert.strictEqual(finishPos[x.id], i + 1); });
  });

  test('[' + V.tag + '] determinism: same seed -> identical results; different seed -> different race', function () {
    var a = runRace(base({ seed: 777, laps: 1, opponents: 5 }, V.fb)).res;
    var b = runRace(base({ seed: 777, laps: 1, opponents: 5 }, V.fb)).res;
    assert.strictEqual(stripVolatile(a), stripVolatile(b));
    var c = runRace(base({ seed: 778, laps: 1, opponents: 5 }, V.fb)).res;
    assert.notStrictEqual(stripVolatile(a), stripVolatile(c));
    assert.ok(a.lightsOutDelay_s >= 0.4 && a.lightsOutDelay_s <= 2.8, 'random lights-out hold within F1-ish range');
  });

  test('[' + V.tag + '] restart() replays identically; simulation never touches Math.random', function () {
    var orig = Math.random;
    var s = E.createSession(base({ seed: 99, laps: 1, opponents: 3, playerAutopilot: true }, V.fb));
    Math.random = function () { throw new Error('Math.random used in sim'); };
    try {
      // engine sandboxes Math.random with a seeded stream while stepping; if it leaks we fall back to throwing
      s.simulate(40);
      var snapA = s.snapshot().cars.map(function (c) { return [c.x, c.y, c.heading]; });
      s.restart();
      assert.strictEqual(s.time(), 0);
      assert.strictEqual(s.getPhase(), 'grid');
      s.simulate(40);
      var snapB = s.snapshot().cars.map(function (c) { return [c.x, c.y, c.heading]; });
      assert.deepStrictEqual(snapA, snapB);
    } finally { Math.random = orig; }
    assert.strictEqual(Math.random, orig, 'Math.random restored');
  });

  test('[' + V.tag + '] F1 countdown: 5 lights, random hold, lights out, phases in order', function () {
    var s = E.createSession(base({ seed: 5, opponents: 2 }, V.fb));
    var seen = [], maxLights = 0, goTime = null, lastOn = 0;
    while (s.time() < 15) {
      s.update(1 / 60, {});
      var sn = s.snapshot();
      if (seen[seen.length - 1] !== sn.phase) seen.push(sn.phase);
      if (sn.phase === 'countdown') { assert.ok(sn.countdown.lightsOn >= lastOn, 'lights only come on'); lastOn = sn.countdown.lightsOn; }
      maxLights = Math.max(maxLights, sn.countdown.lightsOn);
      if (sn.countdown.lightsOut && goTime === null) goTime = sn.countdown.goTime;
    }
    assert.deepStrictEqual(seen, ['grid', 'countdown', 'racing']);
    assert.strictEqual(maxLights, 5);
    assert.ok(goTime > 5, 'go after the fifth light + hold');
    assert.ok(s.snapshot().cars.every(function (c) { return !c.jumpStart; }), 'nobody jumps the start on their own');
  });

  test('[' + V.tag + '] throttle before lights out is no jump start: the car is held on the line', function () {
    var s = E.createSession(base({ seed: 8, opponents: 2, jumpStartPenalty_s: 5 }, V.fb));
    var evs = [], p0 = s.snapshot().cars.filter(function (c) { return c.isPlayer; })[0];
    while (s.getPhase() !== 'racing' && s.time() < 15) {
      s.update(1 / 60, { throttle: s.time() > 2.6 ? 1 : 0, steer: 0.4 });
      evs = evs.concat(s.snapshot().events);
    }
    var p = s.snapshot().cars.filter(function (c) { return c.isPlayer; })[0];
    assert.ok(!p.jumpStart, 'no jump start for revving');
    assert.ok(!p.penalties_s, 'no penalty');
    assert.ok(Math.hypot(p.x - p0.x, p.y - p0.y) < 0.3, 'held on the line');
    assert.ok(!evs.some(function (e) { return e.type === 'jumpstart'; }));
  });

  test('[' + V.tag + '] jump start: a car that actually leaves its box before lights out is penalised', function () {
    var s = E.createSession(base({ seed: 8, opponents: 2, jumpStartPenalty_s: 5 }, V.fb));
    var evs = [], moved = false, me = s._debug().player;
    while (s.getPhase() !== 'racing' && s.time() < 15) {
      if (!moved && s.getPhase() === 'countdown') { me.state.x += 1.5 * Math.cos(me.state.heading); me.state.y += 1.5 * Math.sin(me.state.heading); moved = true; }
      s.update(1 / 60, {});
      evs = evs.concat(s.snapshot().events);
    }
    var p = s.snapshot().cars.filter(function (c) { return c.isPlayer; })[0];
    assert.ok(p.jumpStart, 'jump start flagged');
    assert.strictEqual(p.penalties_s, 5);
    assert.ok(evs.some(function (e) { return e.type === 'jumpstart' && e.carId === 'player'; }));
    assert.ok(evs.some(function (e) { return e.type === 'penalty' && e.carId === 'player'; }));
  });

  test('[' + V.tag + '] holding the brake on the grid does not roll the car (no reverse creep)', function () {
    var s = E.createSession(base({ seed: 8, opponents: 3 }, V.fb));
    var p0 = s.snapshot().cars.filter(function (c) { return c.isPlayer; })[0];
    s.simulate(3, { brake: 1 });
    var p1 = s.snapshot().cars.filter(function (c) { return c.isPlayer; })[0];
    assert.ok(Math.hypot(p1.x - p0.x, p1.y - p0.y) < 0.3);
    assert.ok(!p1.jumpStart);
  });

  test('[' + V.tag + '] DNF when the player is stuck for > 30 s; others keep racing', function () {
    var s = E.createSession(base({ seed: 3, opponents: 2, laps: 3 }, V.fb));
    var evs = [];
    for (var i = 0; i < 50 * 4; i++) { s.update(0.25, {}); evs = evs.concat(s.snapshot().events); }
    var sn = s.snapshot(), p = sn.cars.filter(function (c) { return c.isPlayer; })[0];
    assert.ok(p.dnf, 'player DNF');
    assert.ok(evs.some(function (e) { return e.type === 'dnf' && e.carId === 'player'; }));
    assert.strictEqual(p.position, sn.cars.length, 'DNF classified last');
    assert.ok(sn.cars.some(function (c) { return !c.isPlayer && c.s > 0 && !c.dnf; }));
  });

  test('[' + V.tag + '] update(): fixed 1/120 substeps, accumulator, spiral-of-death guard', function () {
    var s = E.createSession(base({ seed: 1, opponents: 1 }, V.fb));
    assert.strictEqual(E.STEP, 1 / 120);
    assert.strictEqual(s.update(0.05, {}), 6);
    var n = 0; for (var i = 0; i < 12; i++) n += s.update(1 / 144, {});
    assert.ok(n === 9 || n === 10, 'accumulator carries fractions (' + n + ')');
    assert.ok(s.update(10, {}) <= 60, 'clamped');
    assert.strictEqual(s.update(NaN, {}), 0);
    assert.strictEqual(s.update(-1, {}), 0);
    assert.ok(s.alpha() >= 0 && s.alpha() <= 1);
  });

  test('[' + V.tag + '] time trial: solo, ghost recorded, persisted, played back', function () {
    var store = memStorage();
    var cfg = base({ mode: 'time-trial', laps: 3, opponents: 5, seed: 11, storage: store }, V.fb);
    // the stub driver's clean-lap check is tuned on the catalog default; don't depend on whatever build earlier test files left in CB.state
    if (V.fb && CB.data && CB.data.defaultBuild) cfg.playerBuild = (CB.data.referenceBuild || CB.data.defaultBuild)();
    var out = runRace(cfg, { maxT: 900 });
    assert.strictEqual(out.last.cars.length, 1, 'solo');
    var r = out.res;
    assert.ok(r.player.lapTimes.length >= 3);
    var anyValid = r.player.laps_detail.some(function (l) { return l.valid; });
    var g = out.s.getGhost(), hasKey = function () { return store.keys().some(function (k) { return k.indexOf('forge.race.ghost.v1') === 0; }); };
    if (V.fb) assert.ok(anyValid, 'fallback driver laps cleanly');
    if (anyValid) {
      assert.ok(g && g.samples.length > 40 && isFinite(g.time), 'ghost recorded from the best valid lap');
      var bestValid = Math.min.apply(null, r.player.laps_detail.filter(function (l) { return l.valid; }).map(function (l) { return l.time; }));
      assert.ok(Math.abs(g.time - bestValid) < 1e-6, 'ghost = best valid lap');
      assert.ok(hasKey(), 'persisted');
    } else {
      assert.strictEqual(g, null, 'invalid laps never become a ghost');
      console.log('    (note: no valid time-trial lap with the current AI autopilot; ghost recording checked on fallback)');
    }
    // playback: a stored ghost (here: synthetic, centerline at 30 m/s) is loaded for the same track + build and shown
    var geom = out.s._debug().A, flat = [];
    for (var k = 0; k < 400; k++) {
      var t = k * 0.1, d = (geom.s0 + 30 * t) % geom.L, ix = Math.floor(d / geom.L * geom.n) % geom.n;
      flat.push(t, geom.X[ix], geom.Y[ix], geom.H[ix]);
    }
    var key = 'forge.race.ghost.v1:' + out.res.trackId + ':' + out.res.buildHash;
    store.setItem(key, JSON.stringify({ v: 1, time: 39.9, samples: flat, stride: 4 }));
    var s2 = E.createSession(Object.assign({}, cfg, { playerAutopilot: true }));
    var sawGhost = false;
    for (var i = 0; i < 4 * 200 && !sawGhost; i++) { s2.update(0.25, {}); if (s2.snapshot().ghost) sawGhost = true; }
    assert.ok(sawGhost, 'ghost playback');
    s2.clearGhost();
    assert.ok(!hasKey(), 'clearGhost removes it');
  });

  test('[' + V.tag + '] practice mode: running immediately, laps timed, never finishes', function () {
    var s = E.createSession(base({ mode: 'practice', opponents: 0, seed: 2, playerAutopilot: true }, V.fb));
    assert.strictEqual(s.getPhase(), 'racing');
    var laps = 0;
    for (var i = 0; i < 4 * 400; i++) { s.update(0.25, {}); s.snapshot().events.forEach(function (e) { if (e.type === 'lap') laps++; }); }
    assert.ok(laps >= 2, 'laps in practice: ' + laps);
    assert.strictEqual(s.getPhase(), 'racing');
    var p = s.snapshot().cars[0];
    assert.ok(p.bestLap_s > 0 || p.lastLap_s > 0);
  });

  test('[' + V.tag + '] resetPlayerToTrack puts the car back on the asphalt', function () {
    var s = E.createSession(base({ mode: 'practice', opponents: 0, seed: 2 }, V.fb));
    s.simulate(5, { throttle: 1, steer: 1 });     // drive in circles off the track
    s.resetPlayerToTrack();
    s.update(1 / 120, {});
    var p = s.snapshot().cars[0];
    assert.ok(Math.abs(p.lateral) < s.geom.width_m || Math.abs(p.lateral) < 10, 'near centerline');
    assert.ok(p.speed < 1);
    assert.ok(['asphalt', 'kerb'].indexOf(p.surface) >= 0);
  });
});

/* ------------------------------------------------------------------ walls (street circuit) */
test('walls: a car driven into the barrier is pushed back and deflected, never passes through', function () {
  var cfg = { mode: 'practice', opponents: 0, seed: 4, storage: memStorage() };
  if (REAL) cfg.trackId = 'porto-vecchio';
  else { cfg._forceFallback = true; cfg.track = Object.assign({}, I.FALLBACK_TRACK, { id: 'street-test', walls: true, street: true }); }
  var s = E.createSession(cfg), A = s._debug().A, wallEvents = 0, maxPen = 0;
  for (var i = 0; i < 120 * 12; i++) {
    s.update(1 / 120, { throttle: 1, steer: i < 120 * 6 ? 0.35 : -0.35 });
    var c = s._debug().player, idx = c.proj.index;
    var lim = c.lateral >= 0 ? A.WL[idx] : A.WR[idx];
    maxPen = Math.max(maxPen, Math.abs(c.lateral) - lim);
    s.snapshot().events.forEach(function (e) { if (e.type === 'wall') wallEvents++; });
  }
  assert.ok(A.street || REAL, 'street detection');
  assert.ok(wallEvents > 0, 'wall contact happened');
  assert.ok(maxPen < 0.5, 'centre never beyond the barrier (pen ' + maxPen.toFixed(3) + ')');
});

/* ------------------------------------------------------------------ off-track drag */
test('off-track: grass/sand slow the car vs asphalt', function () {
  var s = E.createSession({ mode: 'practice', opponents: 0, seed: 4, _forceFallback: true, storage: memStorage() });
  var D = s._debug(), surfaces = {};
  for (var i = 0; i < 120 * 25; i++) {
    s.update(1 / 120, { throttle: 1, steer: 0.08 });
    surfaces[D.player.surface] = (surfaces[D.player.surface] || 0) + 1;
  }
  assert.ok(surfaces.grass || surfaces.sand, 'went off: ' + JSON.stringify(surfaces));
  var sn = s.snapshot().cars[0];
  assert.ok(isFinite(sn.x) && isFinite(sn.speed));
});

test('a car beached in the gravel trap can still drive itself out', function () {
  // Regression: the engine's constant off-track drag was stacked on the vehicle's own surface rolling
  // resistance, so a car that stopped in sand could never move again (AI cars DNF'd in the trap).
  if (!REAL) return;
  var s = E.createSession({ mode: 'practice', trackId: 'forge-ring', opponents: 0, seed: 4, storage: memStorage() });
  var D = s._debug(), car = D.player, g = s.geom, spot = null;
  for (var k = 0; k < g.samples.length && !spot; k += 7) {
    var q = g.samples[k];
    [['sandL', 'wallL', 1], ['sandR', 'wallR', -1]].forEach(function (c) {
      if (spot || !(q[c[0]] > 0)) return;
      var off = q.hw + 9;
      if (q[c[1]] && q[c[1]] < off + 6) return;
      spot = { x: q.x + q.nx * off * c[2], y: q.y + q.ny * off * c[2], heading: q.heading };
    });
  }
  assert.ok(spot, 'forge-ring has gravel traps');
  s.update(1 / 120, {});
  var st = car.state;
  st.x = spot.x; st.y = spot.y; st.heading = spot.heading; st.vx = st.vy = 0; st.speed = 0; st.yawRate = 0;
  car.wvx = car.wvy = 0;
  s.update(1 / 120, {});
  assert.strictEqual(car.surface, 'sand', 'test car sits in the gravel');
  var x0 = car.state.x, y0 = car.state.y;
  for (var i = 0; i < 120 * 6; i++) s.update(1 / 120, { throttle: 0.7, brake: 0, steer: 0 });
  var moved = Math.hypot(car.state.x - x0, car.state.y - y0);
  assert.ok(moved > 4, 'moved ' + moved.toFixed(2) + ' m in 6 s (now on ' + car.surface + ')');
});

/* ------------------------------------------------------------------ car-car collisions */
test('car-car collisions are detected and resolved (no lasting overlap)', function () {
  var s = E.createSession({ mode: 'race', opponents: 7, seed: 21, laps: 1, _forceFallback: true, storage: memStorage(), playerAutopilot: true });
  var D = s._debug(), worst = 0;
  for (var i = 0; i < 4 * 120; i++) {
    s.update(0.25, {});
    var cars = D.cars;
    for (var a = 0; a < cars.length; a++) for (var b = a + 1; b < cars.length; b++) {
      var A = cars[a], B = cars[b];
      if (A.dnf || B.dnf) continue;
      var h = I.satObb(I.obbOf(A.state.x, A.state.y, A.state.heading, A.halfL, A.halfW), I.obbOf(B.state.x, B.state.y, B.state.heading, B.halfL, B.halfW));
      if (h) worst = Math.max(worst, h.depth);
    }
    if (s.getPhase() === 'finished') break;
  }
  assert.ok(worst < 0.6, 'overlap stays small (' + worst.toFixed(3) + ')');
});

/* ------------------------------------------------------------------ classification while the field is still running */
test('results(): cars still on the final lap when the winner finishes are not classified "+1 Lap"', function () {
  var s = E.createSession(base({ laps: 1, opponents: 5, seed: 99, trackId: 'forge-ring' }, true));
  s.setPlayerAutopilot(true);
  var res = null;
  for (var i = 0; i < 400; i++) {
    s.simulate(1);
    res = s.results();
    if (res.classification[0].status === 'finished') break;
  }
  assert.strictEqual(res.classification[0].status, 'finished', 'someone took the flag');
  var running = res.classification.filter(function (r) { return r.status === 'running'; });
  running.forEach(function (r) {
    assert.ok(!/lap/i.test(r.gapText), r.name + ' is on the lead lap but shows ' + r.gapText);
    assert.ok(/^\+/.test(r.gapText), 'time gap for ' + r.name + ': ' + r.gapText);
  });
});

/* ------------------------------------------------------------------ long pit stops are not "stuck" */
[{ tag: 'fallback', fb: true }].concat(REAL ? [{ tag: 'real modules', fb: false }] : []).forEach(function (v) {
  test('long pit stop: no stuck DNF for a human, no auto-recover teleport for AI / autopilot (' + v.tag + ')', function () {
    var DUR = 60;
    var s = E.createSession(base({ laps: 5, opponents: 1, seed: 7, autoEndurance: false, extras: { pitStops: true, autoPit: false },
      hooks: { pitStop: function () { return { duration_s: DUR }; } } }, v.fb));
    var dbg = s._debug(), p = dbg.player, ai = dbg.cars.filter(function (c) { return !c.isPlayer; })[0];
    s.setPlayerAutopilot(true);
    s.simulate(12);
    assert.strictEqual(s.getPhase(), 'racing');
    assert.ok(s.requestPit(p.id, {}), 'player pit request accepted');
    assert.ok(s.requestPit(ai.id, {}), 'AI pit request accepted');
    var stopT = {}, stopDur = {}, bad = [];
    for (var i = 0; i < 20000 && !(stopT.player != null && stopT.ai != null && !p.pitPhase && !ai.pitPhase); i++) {
      s.update(0.05, {});
      var snap = s.snapshot();
      (snap.events || []).forEach(function (e) {
        var who = e.carId === p.id ? 'player' : e.carId === ai.id ? 'ai' : null;
        if (!who) return;
        if (e.type === 'pitStop') {
          stopT[who] = snap.t; stopDur[who] = e.value;   // other loaded hooks (CB.game.endurance) may set the duration
          if (who === 'player') s.setPlayerAutopilot(false);   // human takes over (and does nothing) while in the box
        }
        if ((e.type === 'reset' || e.type === 'dnf') && stopT[who] != null && snap.t < stopT[who] + stopDur[who]) bad.push(who + ' ' + e.type + ' at +' + (snap.t - stopT[who]).toFixed(1) + 's');
      });
      if (p.dnf && stopT.player == null) break;
    }
    assert.ok(stopT.player != null && stopT.ai != null, 'both cars made their stop');
    assert.deepStrictEqual(bad, [], 'no recovery / DNF during the stop');
    assert.ok(stopDur.player > 2 * 9 && stopDur.ai > 2 * 9, 'stops outlast the auto-recover window: ' + stopDur.player + ' / ' + stopDur.ai);
    assert.ok(!p.dnf || p.dnfT >= stopT.player + stopDur.player, 'player not DNF during the stop');
  });
});

/* ------------------------------------------------------------------ config normalisation */
test('config is normalised and exposed', function () {
  var s = E.createSession({ laps: 999, weather: 'snow', mode: 'nope', seed: 'abc', _forceFallback: true, opponents: 3, storage: memStorage() });
  assert.strictEqual(s.config.laps, 50);
  assert.strictEqual(s.config.weather, 'dry');
  assert.strictEqual(s.config.mode, 'race');
  assert.ok(typeof s.config.seed === 'number');
  assert.ok(s.geom && (s.geom.samples || s.geom.centerline));
  ['update', 'snapshot', 'results', 'restart', 'resetPlayerToTrack'].forEach(function (k) { assert.strictEqual(typeof s[k], 'function'); });
  var s2 = E.createSession({ laps: 2, seed: 'abc', _forceFallback: true, opponents: 3, storage: memStorage() });
  assert.strictEqual(s.config.seed, s2.config.seed, 'string seeds hash stably');
  assert.strictEqual(E.buildHash({ a: 1, b: { c: 2 } }), E.buildHash({ b: { c: 2 }, a: 1 }), 'build hash is key-order independent');
});

/* ------------------------------------------------------------------ run standalone */
if (local) {
  queue.forEach(function (t) {
    var t0 = Date.now();
    try { t.fn(); passed++; console.log('  ok  ' + t.name + ' (' + (Date.now() - t0) + 'ms)'); }
    catch (e) { failed++; console.error('  FAIL ' + t.name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
  });
  console.log('\nrace-engine: ' + passed + ' passed, ' + failed + ' failed');
}

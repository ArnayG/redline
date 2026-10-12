/* Node tests for js/race/drift/scoring.js (CB.race.drift.scoring)
   run: node tests/drift-scoring.test.js (or via node tests/run.js drift-scoring) */
'use strict';
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
function tryLoad(rel) {
  var p = path.join(root, rel);
  if (!fs.existsSync(p)) return false;
  try { require(p); return true; } catch (e) { return false; }
}
var haveTracks = tryLoad('js/race/tracks.js');
var haveDriftTracks = haveTracks && tryLoad('js/race/drift/tracks.js');
var SC = require(path.join(root, 'js', 'race', 'drift', 'scoring.js'));
var CB = globalThis.CB;

/* Use the shared runner's test() when present; otherwise queue and run locally (standalone `node tests/drift-scoring.test.js`). */
var local = typeof globalThis.test !== 'function';
var queue = [];
function T(name, fn) {
  if (!local) return globalThis.test('drift-scoring: ' + name, fn);
  queue.push({ name: 'drift-scoring: ' + name, fn: fn });
}

var DEG = Math.PI / 180;

/* ---------------------------------------------------------------- fixtures */
/** Closed rounded rectangle, counter-clockwise: straights of `straight` m and four LEFT 90° arcs of radius r. */
function makeLoop(opts) {
  opts = opts || {};
  var straight = opts.straight || 120, r = opts.r || 30, hw = opts.hw || 8, ds = 1, dir = opts.dir || 1;
  var pts = [], x = 0, y = 0, h = 0;
  function push(k) { pts.push({ x: x, y: y, heading: h, curvature: k }); }
  for (var q = 0; q < 4; q++) {
    for (var i = 0; i < straight / ds; i++) { push(0); x += Math.cos(h) * ds; y += Math.sin(h) * ds; }
    var n = Math.round(r * Math.PI / 2 / ds);
    for (i = 0; i < n; i++) { push(dir / r); h += dir * (Math.PI / 2) / n; x += Math.cos(h) * ds; y += Math.sin(h) * ds; }
  }
  var samples = pts.map(function (p, i) {
    return { i: i, s: i * ds, x: p.x, y: p.y, heading: p.heading, curvature: p.curvature, hw: hw, width: hw * 2,
      nx: -Math.sin(p.heading), ny: Math.cos(p.heading), wallL: hw + 3, wallR: hw + 3 };
  });
  return { id: 'loop', samples: samples, ds: ds, length: samples.length * ds, width_m: hw * 2, def: { id: 'loop' } };
}
/** One constant-radius circle (skidpad). */
function makeCircle(r, hw) {
  var n = Math.round(2 * Math.PI * r), samples = [];
  for (var i = 0; i < n; i++) {
    var a = i / n * 2 * Math.PI;
    samples.push({ i: i, s: i, x: r * Math.cos(a - Math.PI / 2), y: r * Math.sin(a - Math.PI / 2) + r, heading: a, curvature: 1 / r, hw: hw, width: hw * 2 });
  }
  return { id: 'pad', samples: samples, ds: 2 * Math.PI * r / n, length: 2 * Math.PI * r, def: { id: 'pad' } };
}

/** car in the assist/playerState shape: drift angle beta (deg, + = velocity left of nose), speed m/s, heading rad */
function car(betaDeg, v, extra) {
  var b = betaDeg * DEG, c = { speed: v, vxLocal: v * Math.cos(b), vyLocal: v * Math.sin(b), heading: 0, yawRate: 0, x: 0, y: 0 };
  for (var k in extra || {}) c[k] = extra[k];
  return c;
}
/** proj on a straight piece of track heading 0 (race direction +x) */
function proj(s, lat, extra) {
  var p = { s: s, lateral: lat || 0, heading: 0, onTrack: true, surface: 'asphalt', halfWidth: 8, wallDist: 30, index: Math.round(s) };
  for (var k in extra || {}) p[k] = extra[k];
  return p;
}
var DT = 1 / 60;
/** run n seconds of a constant state; ctxFn(t, i) may return the ctx/events arg; carFn(t) the car */
function run(sc, secs, carFn, ctxFn) {
  var n = Math.round(secs / DT), st = null;
  for (var i = 0; i < n; i++) {
    var t = i * DT;
    st = sc.update(typeof carFn === 'function' ? carFn(t, i) : carFn, DT, ctxFn ? (typeof ctxFn === 'function' ? ctxFn(t, i) : ctxFn) : undefined);
  }
  return st;
}
/** spec-baseline scorer (assistLevel 'off' = raw DEFAULTS timing); pass { assistLevel: 'heavy' } for the game default */
function bare(opts) { return SC.createScorer(null, null, Object.assign({ zones: [], assistLevel: 'off' }, opts || {})); }
/** constant drift on a straight with no proj (s/lateral unknown): pure rate scoring */
function driftScore(betaDeg, v, secs, opts) {
  var sc = bare(opts);
  run(sc, secs, car(betaDeg, v));
  run(sc, 1.2, car(0, v));
  return sc;
}
function hasEvent(st, re) { return st.popups.some(function (p) { return re.test(p.text); }) || (st.lastEvent && re.test(st.lastEvent.text)); }
/** wraps a scorer so every new event (popup) is collected, even several in one frame */
function recorder(sc) {
  var seen = [], last = 0;
  function update(a, b, c) {
    var st = sc.update(a, b, c);
    st.popups.forEach(function (p) { if (p.seq > last) { seen.push(p); last = p.seq; } });
    if (st.lastEvent && st.lastEvent.seq > last) { seen.push(st.lastEvent); last = st.lastEvent.seq; }
    return st;
  }
  return { sc: sc, seen: seen, update: update, state: sc.state, results: sc.results };
}
function texts(rec) { return rec.seen.map(function (e) { return e.text; }); }

/* ------------------------------------------------------------------ module */
T('module shape + global registration', function () {
  assert.equal(CB.race.drift.scoring, SC);
  ['createScorer', 'generateZones', 'medalTargets', 'medalFor', 'gradeFor', 'angleFactor', 'speedFactor', 'driftAngle'].forEach(function (k) {
    assert.equal(typeof SC[k], 'function', k);
  });
  assert.deepEqual(SC.GRADES.map(function (g) { return g.id; }), ['C', 'B', 'A', 'S', 'SS']);
  assert.deepEqual(SC.MEDALS, ['bronze', 'silver', 'gold', 'platinum']);
});

T('angle factor: 15-70° window, sweet spot 30-50°', function () {
  assert.equal(SC.angleFactor(10), 0);
  assert.ok(SC.angleFactor(15) > 0 && SC.angleFactor(15) < 0.5);
  assert.ok(SC.angleFactor(40) > SC.angleFactor(25));
  assert.ok(SC.angleFactor(40) > SC.angleFactor(60));
  [30, 35, 40, 45, 50].forEach(function (a) { assert.ok(SC.angleFactor(a) >= 1, 'sweet ' + a); });
  assert.ok(SC.angleFactor(65) < 1 && SC.angleFactor(65) > 0);
  assert.equal(SC.angleFactor(75), 0);
  assert.equal(SC.angleFactor(-40), SC.angleFactor(40), 'symmetric');
});

T('driftAngle from local, world and slip inputs', function () {
  assert.ok(Math.abs(SC.driftAngle(car(30, 20)) / DEG - 30) < 1e-9);
  var h = 0.7, b = -25 * DEG, v = 18;
  var w = { heading: h, vx: v * Math.cos(h + b), vy: v * Math.sin(h + b), speed: v };
  assert.ok(Math.abs(SC.driftAngle(w) / DEG + 25) < 1e-6, 'world-frame snapshot car');
  assert.equal(SC.driftAngle({ speed: 0.1, vxLocal: 0.1, vyLocal: 0 }), 0);
  assert.ok(Math.abs(SC.driftAngle({ speed: 15, slipR: 0.3 }) + 0.3) < 1e-9);
});

/* ---------------------------------------------------------------- basics */
T('a held drift scores, banks on exit with a grade and a "DRIFT ×" event', function () {
  var sc = bare();
  var st = run(sc, 3, car(35, 20));
  assert.ok(st.drifting);
  assert.ok(st.current > 200, 'current ' + st.current);
  assert.equal(st.total, 0, 'not banked yet');
  assert.ok(st.angle_deg > 34 && st.angle_deg < 36);
  assert.ok(st.rate > 0);
  var cur = st.current;
  st = run(sc, 1.2, car(0, 20));
  assert.equal(st.drifting, false);
  assert.equal(st.current, 0);
  assert.ok(Math.abs(st.total - cur) <= 2, 'banked ' + st.total + ' vs ' + cur);
  assert.ok(/DRIFT ×\d\.\d/.test(st.lastEvent.text), st.lastEvent.text);
  assert.ok(['C', 'B', 'A', 'S', 'SS'].indexOf(st.grade) >= 0);
  assert.equal(sc.results().drifts, 1);
});

T('no points below 30 km/h or under 15°; grace keeps a drift through a brief dip', function () {
  assert.equal(driftScore(35, 7, 3).state().total, 0, 'too slow');
  assert.equal(driftScore(12, 25, 3).state().total, 0, 'too straight');
  var sc = bare();
  run(sc, 2, car(35, 20));
  run(sc, 0.3, car(5, 20));
  var st = run(sc, 2, car(35, 20));
  assert.ok(st.drifting);
  assert.equal(sc.results().drifts, 1, 'still one drift');
});

T('sweet-spot angle, speed and smoothness all raise the rate', function () {
  var sweet = driftScore(40, 20, 4).state().total;
  assert.ok(sweet > driftScore(20, 20, 4).state().total, 'sweet > shallow');
  assert.ok(sweet > driftScore(65, 20, 4).state().total, 'sweet > over-angled');
  assert.ok(driftScore(40, 30, 4).state().total > sweet, 'faster scores more');
  // jittery angle (same mean) scores less than a steady one
  var steady = bare(), jitter = bare();
  run(steady, 4, car(38, 20));
  run(jitter, 4, function (t, i) { return car(i % 20 < 10 ? 28 : 48, 20); });
  assert.ok(steady.state().smoothness > jitter.state().smoothness);
  assert.ok(steady.state().current > jitter.state().current, steady.state().current + ' vs ' + jitter.state().current);
});

/* ----------------------------------------------------------------- combo */
T('combo multiplier: +0.1 per 2 s held, capped at ×5', function () {
  var sc = bare({ longDrift: [] });
  var st = run(sc, 10.05, car(35, 20));
  assert.ok(Math.abs(st.multiplier - 1.5) < 1e-9, 'x' + st.multiplier);
  assert.ok(st.multiplierProgress >= 0 && st.multiplierProgress <= 1);
  st = run(sc, 120, car(35, 20));
  assert.equal(st.multiplier, 5);
  assert.equal(sc.results().maxCombo, 5);
});

T('combo chains drifts and decays after 1.5 s without drifting', function () {
  var sc = bare();
  run(sc, 4.1, car(35, 20));
  assert.ok(sc.state().multiplier >= 1.2);
  run(sc, 1.0, car(0, 20));                    // ends the drift (grace 0.6 s) but chain still alive
  var st = run(sc, 1.5, car(35, 20));
  assert.equal(st.combo, 2, 'second drift chained');
  var m = st.multiplier;
  run(sc, 1.3, car(0, 20));                    // 1.3 s without a drift: not decaying yet
  assert.equal(sc.state().multiplier, m);
  st = run(sc, 3, car(0, 20));
  assert.equal(st.multiplier, 1, 'decayed back to ×1');
  assert.equal(st.combo, 0);
  st = run(sc, 1, car(35, 20));
  assert.equal(st.combo, 1, 'a fresh chain');
  assert.equal(sc.results().maxChain, 2);
});

T('points are multiplied live: same drift scores more at a higher multiplier', function () {
  var a = bare({ longDrift: [] });
  run(a, 1, car(35, 15)); var p1 = a.state().current;     // 54 km/h: no entry bonus
  var b = bare({ longDrift: [] });
  run(b, 20.05, car(35, 15));
  assert.equal(b.state().multiplier, 2);
  var before = b.state().current;
  run(b, 1, car(35, 15));
  assert.ok(b.state().current - before > (p1 * 1.8), 'x2 gain ' + (b.state().current - before) + ' vs ' + p1);
});

/* --------------------------------------------------------------- bonuses */
T('transition: left↔right swing bonus, 3 quick swings = MANJI', function () {
  var rec = recorder(bare());
  run(rec, 1.5, car(35, 20));
  var before = rec.state().current;
  run(rec, 0.1, car(-35, 20));
  var st = rec.state();
  assert.ok(texts(rec).indexOf('SWING!') >= 0, texts(rec).join('|'));
  assert.ok(st.current - before > 200, 'swing points');
  assert.equal(st.direction, -1);
  run(rec, 0.8, car(-35, 20)); run(rec, 0.8, car(35, 20)); run(rec, 0.8, car(-35, 20));
  assert.ok(texts(rec).some(function (t) { return /MANJI/.test(t); }), texts(rec).join('|'));
  var r = rec.results();
  assert.ok(r.transitions >= 3);
  assert.ok(r.manjis >= 1);
  assert.equal(r.drifts, 1, 'direct flicks stay one drift');
});

T('transition across a short straighten (within the window) still counts as a swing', function () {
  var rec = recorder(bare());
  run(rec, 2, car(35, 20));
  run(rec, 0.9, car(0, 20));                  // grace runs out → drift banked
  run(rec, 0.5, car(-35, 20));                 // other way within 1 s
  assert.ok(texts(rec).indexOf('SWING!') >= 0, texts(rec).join('|'));
  assert.equal(rec.results().transitions, 1);
});

T('long drift bonuses at 4 s / 8 s / 12 s', function () {
  var rec = recorder(bare());
  run(rec, 4.3, car(35, 20));
  assert.ok(texts(rec).indexOf('LONG DRIFT!') >= 0);
  run(rec, 8.3, car(35, 20));
  assert.ok(texts(rec).indexOf('MARATHON DRIFT!') >= 0);
  assert.ok(texts(rec).indexOf('ENDLESS DRIFT!') >= 0);
  var withB = rec.state().current;
  var noB = bare({ longDrift: [] });
  run(noB, 12.6, car(35, 20));
  assert.ok(withB - noB.state().current > 2000, 'bonus value');
  assert.ok(rec.results().longestDrift_s >= 12.5);
});

T('long drift bonuses are paid once per drift, not again after every swing', function () {
  var rec = recorder(bare());
  run(rec, 12.5, car(35, 20));                 // all three tiers reached
  for (var k = 0; k < 6; k++) run(rec, 0.8, car(k % 2 ? 35 : -35, 20));   // six quick flicks, same drift
  var t = texts(rec);
  ['LONG DRIFT!', 'MARATHON DRIFT!', 'ENDLESS DRIFT!'].forEach(function (name) {
    assert.equal(t.filter(function (x) { return x === name; }).length, 1, name + ' once: ' + t.join('|'));
  });
  assert.ok(rec.results().transitions >= 6);
  // a flick BEFORE a tier is reached keeps the clock: the tier still pays when the drift time gets there
  var r2 = recorder(bare());
  run(r2, 2, car(35, 20)); run(r2, 0.5, car(-35, 20)); run(r2, 2, car(-35, 20));
  assert.equal(texts(r2).filter(function (x) { return x === 'LONG DRIFT!'; }).length, 1, texts(r2).join('|'));
});

T('entry speed bonus scales with the speed the drift started at', function () {
  var fast = recorder(bare()), slow = recorder(bare());
  run(fast, 1, car(35, 35));     // 126 km/h
  run(slow, 1, car(35, 15));     // 54 km/h — below the 60 km/h floor
  var e = fast.seen.filter(function (x) { return x.kind === 'entry'; })[0];
  assert.ok(e, texts(fast).join('|'));
  assert.ok(/FAST ENTRY 126 KM\/H/.test(e.text), e.text);
  assert.ok(Math.abs(e.points - (126 - 60) * 8) < 5, 'points ' + e.points);
  assert.ok(!slow.seen.some(function (x) { return x.kind === 'entry'; }));
  assert.ok(fast.results().entryBonus > 0);
});

T('close-to-wall proximity raises the rate', function () {
  var near = recorder(bare()), far = bare();
  // wallDist 2.0 m from the centre, car broadside-ish → body very close to the wall
  run(near, 3, car(35, 20, { heading: 0 }), { proj: proj(50, 7, { wallDist: 1.2, heading: 0 }) });
  run(far, 3, car(35, 20, { heading: 0 }), { proj: proj(50, 0, { wallDist: 10, heading: 0 }) });
  var st = near.state();
  assert.ok(texts(near).indexOf('CLOSE TO WALL!') >= 0);
  assert.ok(st.wallGap_m !== null && st.wallGap_m < 1.5);
  assert.ok(st.current > far.state().current * 1.2, st.current + ' vs ' + far.state().current);
  assert.ok(near.results().wallTime_s > 2.5);
});

T('tandem proximity bonus when chasing a drifting lead car (ctx.lead, car.lead and snapshot forms)', function () {
  function lead(dist, beta) { var b = (beta == null ? 35 : beta) * DEG; return { id: 'lead', x: dist, y: 0, heading: 0, vx: 20 * Math.cos(b), vy: 20 * Math.sin(b), speed: 20 }; }
  var solo = bare(), tan = recorder(bare());
  run(solo, 3, car(35, 20));
  run(tan, 3, car(35, 20), { lead: lead(5) });
  assert.ok(texts(tan).indexOf('DOOR TO DOOR!') >= 0, texts(tan).join('|'));
  assert.ok(tan.state().current > solo.state().current * 1.3);
  assert.equal(tan.state().tandem, true);
  assert.equal(tan.state().tandemDist_m, 5);
  // too far: no bonus; lead not drifting: no bonus
  var far = bare(); run(far, 3, car(35, 20), { lead: lead(40) });
  assert.ok(Math.abs(far.state().current - solo.state().current) < 1);
  var straight = bare(); run(straight, 3, car(35, 20), { lead: lead(5, 0) });
  assert.ok(Math.abs(straight.state().current - solo.state().current) < 1);
  // position-only lead attached to the car (session feed): treated as drifting
  var viaCar = bare(); run(viaCar, 3, car(35, 20, { lead: { x: 8, y: 0 } }));
  assert.ok(viaCar.state().current > solo.state().current * 1.1);
  // full engine snapshot: nearest non-player car is the lead
  var snap = bare();
  run(snap, 3, car(35, 20, { id: 'player' }), { cars: [{ id: 'player', isPlayer: true, x: 0, y: 0 }, Object.assign(lead(9), { id: 'ai1' })], events: [] });
  assert.ok(snap.state().current > solo.state().current * 1.1);
  assert.ok(snap.results().tandemTime_s > 2);
  // setLead()
  var sl = bare(); sl.setLead(function () { return lead(6); });
  run(sl, 3, car(35, 20));
  assert.ok(sl.state().current > solo.state().current * 1.3);
});

/* -------------------------------------------------------------- penalties */
T('spin (>110°) loses the drift and halves the combo', function () {
  var rec = recorder(bare());
  run(rec, 6.1, car(35, 20));
  var m = rec.state().multiplier;
  assert.ok(m >= 1.3);
  var st = run(rec, 0.2, car(130, 15));
  assert.equal(st.current, 0);
  assert.equal(st.total, 0, 'nothing banked');
  assert.ok(texts(rec).some(function (t) { return /^SPIN! DRIFT LOST/.test(t); }));
  assert.ok(st.multiplier < m && st.multiplier >= 1);
  assert.ok(Math.abs(st.multiplier - (1 + (m - 1) * 0.5)) < 0.011);
  // must recover below 60° before a new drift can start
  st = run(rec, 1, car(80, 15));
  assert.equal(st.drifting, false);
  run(rec, 0.1, car(20, 15));
  st = run(rec, 1, car(35, 20));
  assert.equal(st.drifting, true);
  var r = rec.results();
  assert.equal(r.spins, 1);
  assert.ok(r.pointsLost > 0);
});

T('wall hit (engine "wall" event) loses the drift and the combo', function () {
  var rec = recorder(bare({ playerId: 'player' }));
  run(rec, 4.1, car(35, 20, { id: 'player' }));
  assert.ok(rec.state().multiplier > 1);
  // another car's wall hit and a tiny scrape are ignored
  rec.update(car(35, 20, { id: 'player' }), DT, [{ type: 'wall', carId: 'ai3', value: 9, intensity: 0.5 }, { type: 'wall', carId: 'player', value: 1.3, intensity: 0.07 }]);
  assert.ok(rec.state().current > 0);
  var st = rec.update(car(35, 20, { id: 'player' }), DT, [{ type: 'wall', carId: 'player', value: 6, intensity: 0.33 }]);
  assert.equal(st.current, 0);
  assert.equal(st.multiplier, 1);
  assert.equal(st.combo, 0);
  assert.equal(st.total, 0);
  assert.ok(/WALL HIT — COMBO LOST/.test(st.lastEvent.text));
  assert.ok(st.lastEvent.points < 0);
  assert.equal(rec.results().wallHits, 1);
});

T('car contact (engine "collision" event) also loses the combo; ctx.crash works too', function () {
  var sc = bare();
  run(sc, 3, car(35, 20));
  var st = sc.update(car(35, 20), DT, [{ type: 'collision', carId: 'player', otherId: 'lead', intensity: 0.5 }]);
  assert.equal(st.current, 0);
  assert.ok(/CONTACT/.test(st.lastEvent.text));
  var sc2 = bare();
  run(sc2, 3, car(35, 20));
  st = sc2.update(car(35, 20), DT, { crash: 'wall' });
  assert.equal(st.current, 0);
  assert.equal(sc2.results().wallHits, 1);
});

T('off-track: the drift is banked at half', function () {
  var sc = bare();
  run(sc, 3, car(35, 20), { proj: proj(20, 0) });
  var cur = sc.state().current;
  var st = sc.update(car(35, 20), DT, { proj: proj(25, 9, { surface: 'grass', onTrack: false }) });
  assert.ok(Math.abs(st.total - Math.round(cur * 0.5)) <= 3, st.total + ' vs ' + cur / 2);
  assert.ok(/OFF TRACK — HALF BANKED/.test(st.lastEvent.text));
  assert.equal(st.offTrack, true);
  // no scoring while off track
  st = run(sc, 1, car(35, 20), { proj: proj(30, 9, { surface: 'grass', onTrack: false }) });
  assert.equal(st.current, 0);
  // tarmac run-off just past the edge is still track (lenient)
  var sc2 = bare();
  st = run(sc2, 2, car(35, 20), { proj: proj(20, 9.5, { surface: 'asphalt', onTrack: false }) });
  assert.ok(st.current > 0 && !st.offTrack);
  // explicit flag / snapshot field fallback
  var sc3 = bare();
  run(sc3, 2, car(35, 20));
  st = sc3.update(car(35, 20, { offTrack: true }), DT);
  assert.ok(st.total > 0 && st.offTrack);
  assert.equal(sc3.results().offTracks, 1);
});

T('going backwards: combo lost and nothing scores', function () {
  var rec = recorder(bare());
  run(rec, 4.1, car(35, 20, { heading: 0 }), { proj: proj(50, 0, { heading: 0 }) });
  assert.ok(rec.state().multiplier > 1);
  // nose and velocity pointing against the race direction (track heading 0, car heading π)
  var st = run(rec, 1, car(30, 15, { heading: Math.PI }), { proj: proj(40, 0, { heading: 0 }) });
  assert.ok(texts(rec).some(function (t) { return /WRONG WAY/.test(t); }), texts(rec).join('|'));
  assert.equal(st.current, 0);
  assert.equal(st.multiplier, 1);
  assert.equal(st.total, 0);
  assert.equal(st.backwards, true);
  assert.equal(rec.results().backwards, 1);
  // wrongWay flag when no track heading is known
  var sc2 = bare();
  st = run(sc2, 1, car(35, 20, { wrongWay: true }));
  assert.equal(st.current, 0);
});

/* ---------------------------------------------------------------- zones */
T('zones auto-generated from curvature: inner apex on the inside, outer on the exit outside', function () {
  var g = makeLoop();
  var zones = SC.generateZones(g, g.def);
  var inner = zones.filter(function (z) { return z.kind === 'inner'; }), outer = zones.filter(function (z) { return z.kind === 'outer'; });
  assert.equal(inner.length, 4, 'one apex clip per corner');
  assert.equal(outer.length, 4, '90° corners also get an outer zone');
  inner.forEach(function (z) { assert.equal(z.side, 'left'); assert.ok(z.lateral > 0 && z.lateral <= 8); assert.equal(g.samples[Math.round(z.s)].curvature > 0, true, 'inside a corner'); });
  outer.forEach(function (z) { assert.equal(z.side, 'right'); assert.ok(z.lateral < 0); });
  zones.forEach(function (z) {
    ['id', 's', 's0', 's1', 'side', 'kind', 'hit', 'lat0', 'lat1', 'x', 'y', 'points', 'tolerance'].forEach(function (k) { assert.ok(z[k] !== undefined, k); });
    assert.ok(z.lat0 < z.lat1);
    assert.ok(z.points > 0);
  });
  // first corner apex ~ at 120 + 47/2 m
  assert.ok(Math.abs(inner[0].s - (120 + 47 / 2)) < 4, 'apex s ' + inner[0].s);
  assert.ok(outer[0].s > inner[0].s, 'outer after apex');
  // right-hand loop mirrors the sides
  var gr = makeLoop({ dir: -1 });
  SC.generateZones(gr, gr.def).forEach(function (z) { assert.equal(z.side, z.kind === 'inner' ? 'right' : 'left'); });
  // ids unique
  var ids = {}; zones.forEach(function (z) { assert.ok(!ids[z.id]); ids[z.id] = 1; });
});

T('skidpad: a full-circle corner is split into several clipping zones', function () {
  var g = makeCircle(40, 8);
  var zones = SC.generateZones(g, g.def);
  var inner = zones.filter(function (z) { return z.kind === 'inner'; });
  assert.ok(inner.length >= 3, 'inner ' + inner.length);
  inner.forEach(function (z) { assert.equal(z.side, 'left'); });
});

T('clipping zone: drifting through it near the target line pays a bonus, marks hit, counts %', function () {
  var g = makeLoop();
  var sc = SC.createScorer(g, g.def, {});
  var z = sc.zones.filter(function (q) { return q.kind === 'inner'; })[0];
  var rec = recorder(sc);
  // approach drifting on the centreline, then pass the zone hugging the inside edge
  var s = z.s0 - 30, st;
  for (var i = 0; s < z.s1 + 10; i++) {
    var inZ = s > z.s0 - 2 && s < z.s1 + 2;
    // β < 0 = nose pointing INTO the left-hand corner (the correct way round: no counter-direction penalty)
    st = rec.update(car(-35, 20), DT, { proj: { s: s, lateral: inZ ? z.lateral - 1 : 0, heading: 0, onTrack: true, halfWidth: 8, wallDist: 30 } });
    if (s > z.s0 + 0.5 && s < z.s1 - 0.5 && i % 10 === 0) assert.ok(st.zones.some(function (q) { return q.id === z.id && q.active; }));
    s += 20 * DT;
  }
  var zs = st.zones.filter(function (q) { return q.id === z.id; })[0];
  assert.equal(zs.hit, true);
  assert.ok(zs.quality > 0.8, 'quality ' + zs.quality);
  var ev = rec.seen.filter(function (e) { return e.kind === 'zone'; });
  assert.equal(ev.length, 1, texts(rec).join('|'));
  assert.ok(/CLIP/.test(ev[0].text));
  assert.ok(ev[0].points > z.points * 0.8, 'zone points ' + ev[0].points);
  var r = sc.results();
  assert.equal(r.zonesHit, 1);
  assert.equal(r.zonesPassed, 1);
  assert.equal(r.zonesHitPct, 100);
  assert.equal(r.perfectClips, 1);
});

T('clipping zone missed (wide line or not drifting) → no bonus, pass counted', function () {
  var g = makeLoop();
  function pass(lat, beta) {
    var sc = SC.createScorer(g, g.def, {});
    var z = sc.zones.filter(function (q) { return q.kind === 'inner'; })[0];
    for (var s = z.s0 - 20; s < z.s1 + 10; s += 20 * DT) sc.update(car(beta, 20), DT, { proj: { s: s, lateral: lat, heading: 0, onTrack: true, halfWidth: 8, wallDist: 30 } });
    return { r: sc.results(), z: sc.state().zones.filter(function (q) { return q.id === z.id; })[0] };
  }
  var wide = pass(-2, -35);                    // centre-ish line: misses the inner clip and the outer zone
  assert.equal(wide.z.hit, false);
  assert.equal(wide.r.zonesHit, 0);
  assert.equal(wide.r.zonesPassed, 1);
  assert.equal(wide.r.zonesHitPct, 0);
  var grip = pass(5, 2);
  assert.equal(grip.z.hit, false, 'gripping through does not count');
  var good = pass(5, -35);
  assert.ok(good.r.total > wide.r.total + 200, good.r.total + ' vs ' + wide.r.total);
  // nextZone points at the upcoming zone
  var sc = SC.createScorer(g, g.def, {});
  var st = sc.update(car(0, 20), DT, { proj: { s: 10, lateral: 0, heading: 0 } });
  assert.ok(st.nextZone && st.nextZone.dist_m > 0 && st.nextZone.id === sc.zones[0].id);
});

T('zone hit flag resets on the next lap pass', function () {
  var g = makeLoop();
  var sc = SC.createScorer(g, g.def, {});
  var z = sc.zones[0];
  function through(lat) { for (var s = z.s0 - 10; s < z.s1 + 10; s += 20 * DT) sc.update(car(35, 20), DT, { proj: { s: s, lateral: lat, heading: 0, halfWidth: 8 } }); }
  through(z.lateral);
  assert.equal(sc.state().zones[0].hit, true);
  through(-z.lateral);
  assert.equal(sc.state().zones[0].hit, false);
  var r = sc.results();
  assert.equal(r.zonesPassed, 2);
  assert.equal(r.zonesHitPct, 50);
});

T('outer zone uses the car body extent (rear swinging out)', function () {
  var g = makeLoop();
  var sc = SC.createScorer(g, g.def, {});
  var z = sc.zones.filter(function (q) { return q.kind === 'outer'; })[0];
  // centre 3.5 m inside the outer target line, but the car is at 45° to the track: body extent ≈ 2.2 m reaches it
  for (var s = z.s0 - 10; s < z.s1 + 5; s += 20 * DT) {
    sc.update(car(35, 20, { heading: 45 * DEG, length_m: 4.5, width_m: 1.9 }), DT, { proj: { s: s, lateral: z.lateral + 3.5, heading: 0, halfWidth: 8 } });
  }
  assert.equal(sc.results().zonesHit, 1);
});

T('explicit opts.zones and trackDef.driftZones hints (CB.race.drift.tracks shape) are honoured', function () {
  var g = makeLoop();
  var L = g.length;
  var sc = SC.createScorer(g, g.def, { zones: [{ id: 'my', kind: 'outer', s: 300, length: 20, side: 'right' }] });
  assert.equal(sc.zones.length, 1);
  assert.equal(sc.zones[0].id, 'my');
  assert.equal(sc.zones[0].side, 'right');
  var def = { id: 'loop', driftZones: [
    { id: 'h:z0', name: 'T1 apex', kind: 'clip', clip: 'inner', side: 1, u: 143 / L, u0: 137 / L, u1: 149 / L, s: 9999, lateral: 6.3, radius: 3.5, points: 600 },
    { id: 'h:z1', name: 'T1 outer zone', kind: 'zone', clip: 'outer', side: -1, u: 165 / L, u0: 150 / L, u1: 180 / L, lateral: -6, radius: 3, points: 300 },
    { id: 'h:z2', name: 'S swing', kind: 'swing', clip: null, side: 0, u: 200 / L, u0: 190 / L, u1: 210 / L, lateral: 0, radius: 8, points: 350 }
  ] };
  var zones = SC.generateZones(g, def);
  var byId = {}; zones.forEach(function (z) { byId[z.id] = z; });
  assert.ok(byId['h:z0'] && byId['h:z1'] && byId['h:z2']);
  assert.equal(byId['h:z0'].kind, 'inner');
  assert.ok(Math.abs(byId['h:z0'].s - 143) < 0.01, 'u wins over layout metres');
  assert.ok(Math.abs(byId['h:z0'].length - 12) < 0.01);
  assert.equal(byId['h:z0'].tolerance, 3.5);
  assert.equal(byId['h:z0'].points, 600);
  assert.equal(byId['h:z0'].label, 'T1 apex');
  assert.equal(byId['h:z1'].kind, 'outer');
  assert.equal(byId['h:z1'].side, 'right');
  assert.equal(byId['h:z2'].kind, 'swing');
  assert.equal(byId['h:z2'].side, 'both');
  // auto zones near the authored first corner are dropped, the other three corners keep theirs
  var auto = zones.filter(function (z) { return !/^h:/.test(z.id); });
  assert.ok(auto.every(function (z) { return Math.abs(z.s - 143) > 30; }));
  assert.ok(auto.length >= 6);
});

T('swing zone pays when a transition happens inside it', function () {
  var g = makeLoop();
  var L = g.length;
  var sc = SC.createScorer(g, null, { zones: [{ id: 'sw', kind: 'swing', u: 60 / L, u0: 40 / L, u1: 80 / L, radius: 8, points: 350 }] });
  var rec = recorder(sc);
  var s = 10;
  for (; s < 55; s += 20 * DT) rec.update(car(35, 20), DT, { proj: { s: s, lateral: 0, heading: 0, halfWidth: 8 } });
  for (; s < 95; s += 20 * DT) rec.update(car(-35, 20), DT, { proj: { s: s, lateral: 0, heading: 0, halfWidth: 8 } });
  assert.ok(texts(rec).indexOf('SWING ZONE!') >= 0, texts(rec).join('|'));
  assert.equal(sc.results().zonesHit, 1);
});

/* ---------------------------------------------------- grades, medals, results */
T('grades C/B/A/S/SS by drift points, scaled by difficulty', function () {
  assert.equal(SC.gradeFor(0).id, 'C');
  assert.equal(SC.gradeFor(999).id, 'C');
  assert.equal(SC.gradeFor(1000).id, 'B');
  assert.equal(SC.gradeFor(3000).id, 'A');
  assert.equal(SC.gradeFor(7000).id, 'S');
  assert.equal(SC.gradeFor(15000).id, 'SS');
  assert.equal(SC.gradeFor(3000, 'hard').id, 'B', 'harder thresholds');
  assert.equal(SC.gradeFor(2400, 'easy').id, 'A');
  // a long sweet drift grades higher than a short one
  var short = driftScore(35, 20, 1).results().bestDrift, long = driftScore(40, 25, 14).results().bestDrift;
  assert.ok(SC.GRADES.map(function (g) { return g.id; }).indexOf(long.grade) > SC.GRADES.map(function (g) { return g.id; }).indexOf(short.grade));
  assert.equal(long.label, SC.GRADES.filter(function (g) { return g.id === long.grade; })[0].label);
});

T('medal targets: monotonic, per track, difficulty-scaled, explicit targets honoured', function () {
  var g = makeLoop();
  var t = SC.medalTargets(g, g.def, {});
  assert.ok(t.bronze > 0 && t.bronze < t.silver && t.silver < t.gold && t.gold < t.platinum, JSON.stringify(t));
  var hard = SC.medalTargets(g, g.def, { difficulty: 'hard' });
  assert.ok(hard.gold > t.gold);
  var longer = SC.medalTargets(g, g.def, { duration_s: 240 });
  assert.ok(longer.gold > t.gold);
  var ex = SC.medalTargets(g, g.def, { targets: { bronze: 10, silver: 20, gold: 30, platinum: 40 } });
  assert.deepEqual([ex.bronze, ex.silver, ex.gold, ex.platinum], [10, 20, 30, 40]);
  assert.equal(SC.medalFor(5, ex), null);
  assert.equal(SC.medalFor(25, ex), 'silver');
  assert.equal(SC.medalFor(40, ex), 'platinum');
  // authored track medals on this scale are used; wildly off-scale ones fall back to the estimate
  var onScale = { id: 'loop', drift: { duration_s: 120, medals: { bronze: t.bronze, silver: t.silver, gold: Math.round(t.gold * 1.2), platinum: t.platinum * 2 } } };
  var a = SC.medalTargets(g, onScale, {});
  assert.equal(a.source, 'track');
  assert.equal(a.gold, Math.round(t.gold * 1.2));
  var offScale = { id: 'loop', drift: { duration_s: 120, medals: { bronze: t.bronze * 20, silver: t.silver * 20, gold: t.gold * 20, platinum: t.platinum * 20 } } };
  var b = SC.medalTargets(g, offScale, {});
  assert.equal(b.source, 'estimate');
  assert.ok(b.authored && b.authored.gold === t.gold * 20);
  assert.equal(SC.medalTargets(g, offScale, { calibrateTargets: false }).gold, t.gold * 20);
});

T('medal targets follow the assist level (heavy-scale authored medals scale down); explicit targets never do', function () {
  var g = makeLoop();
  var heavy = SC.medalTargets(g, g.def, { assistLevel: 'heavy' }), med = SC.medalTargets(g, g.def, { assistLevel: 'medium' });
  var light = SC.medalTargets(g, g.def, { assistLevel: 'light' }), off = SC.medalTargets(g, g.def, { assistLevel: 'off' });
  assert.deepEqual(SC.medalTargets(g, g.def, {}), heavy, 'default = heavy');
  assert.ok(heavy.gold > med.gold * 4 && med.gold > light.gold && light.gold > off.gold, [heavy.gold, med.gold, light.gold, off.gold].join(' '));
  var def = { id: 'loop', drift: { duration_s: 120, medals: { bronze: heavy.bronze, silver: heavy.silver, gold: heavy.gold, platinum: heavy.platinum } } };
  var ah = SC.medalTargets(g, def, { assistLevel: 'heavy' }), am = SC.medalTargets(g, def, { assistLevel: 'medium' });
  assert.equal(ah.source, 'track'); assert.equal(am.source, 'track');
  assert.equal(ah.gold, heavy.gold);
  assert.ok(am.gold < ah.gold / 4 && am.bronze < am.silver && am.gold < am.platinum, JSON.stringify(am));
  var ex = { bronze: 10, silver: 20, gold: 30, platinum: 40 };
  assert.equal(SC.medalTargets(g, def, { assistLevel: 'off', targets: ex }).gold, 30);
});

T('setAssistLevel / assist level carried by update() data retarget the medals in place', function () {
  var g = makeLoop();
  var sc = SC.createScorer(g, g.def, {});
  var ref = sc.targets, heavyGold = ref.gold;
  assert.equal(sc.options.assistLevel, 'heavy');
  sc.update(car(0, 10), DT, { assistLevel: 'medium' });   // ctx hint (opts had none)
  assert.equal(sc.options.assistLevel, 'medium');
  assert.ok(sc.targets === ref && ref.gold < heavyGold, 'same object, lower target');
  assert.equal(sc.options.grace_s, SC.FORGIVENESS.medium.grace_s, 'forgiveness follows');
  sc.update(car(0, 10, { assistLevel: 'heavy' }), DT);      // car hint
  assert.equal(sc.targets.gold, heavyGold);
  assert.equal(sc.setAssistLevel('light'), 'light');
  sc.update(car(0, 10), DT, { assistLevel: 'heavy' });      // explicit call wins over later hints
  assert.equal(sc.options.assistLevel, 'light');
  var fixed = SC.createScorer(g, g.def, { assistLevel: 'off' });
  fixed.update(car(0, 10), DT, { assistLevel: 'heavy' });   // explicit opts win over hints
  assert.equal(fixed.options.assistLevel, 'off');
  assert.equal(sc.results().assistLevel, 'light');
});

T('results(): all fields, banks the open drift, idempotent', function () {
  var sc = bare({ targets: { bronze: 100, silver: 400, gold: 1500, platinum: 99999 } });
  run(sc, 3, car(45, 22));
  var st = sc.state();
  assert.equal(st.total, 0);
  var r = sc.results();
  ['total', 'bestDrift', 'longestDrift_s', 'maxAngle_deg', 'maxCombo', 'zonesHitPct', 'medal', 'targets', 'drifts', 'transitions', 'spins', 'wallHits', 'offTracks', 'grade', 'next'].forEach(function (k) {
    assert.ok(k in r, k);
  });
  assert.ok(r.total > 0 && r.total === st.current);
  assert.equal(r.bestDrift.points, r.total);
  assert.ok(r.maxAngle_deg >= 44.9);
  assert.ok(r.longestDrift_s >= 2.9);
  assert.equal(r.medal, SC.medalFor(r.total, r.targets));
  assert.deepEqual(sc.results(), r, 'idempotent');
  assert.ok(r.next === null || r.next.missing > 0);
});

T('state() shape (spec §3) and reset()', function () {
  var g = makeLoop();
  var sc = SC.createScorer(g, g.def, { difficulty: 'normal' });
  var st = sc.update(car(35, 20), DT, { proj: proj(5, 0) });
  ['total', 'current', 'combo', 'multiplier', 'angle_deg', 'speed', 'grade', 'zones', 'lastEvent'].forEach(function (k) { assert.ok(k in st, k); });
  assert.ok(Array.isArray(st.zones) && st.zones.length === sc.zones.length);
  st.zones.forEach(function (z) { ['id', 's', 'side', 'kind', 'hit'].forEach(function (k) { assert.ok(k in z, k); }); });
  run(sc, 5, car(35, 20), function (t) { return { proj: proj(5 + t * 20, 0) }; });
  assert.ok(sc.state().current > 0 && sc.state().lastEvent);
  sc.reset();
  st = sc.state();
  assert.equal(st.total, 0); assert.equal(st.current, 0); assert.equal(st.multiplier, 1); assert.equal(st.lastEvent, null);
  assert.ok(st.zones.every(function (z) { return !z.hit; }));
  // degenerate inputs never throw
  sc.update(null, NaN, null); sc.update({}, 0.016, 'junk'); sc.update(car(35, 20), 5, {});
  assert.ok(isFinite(sc.state().total));
});

/* ------------------------------------------------------------ real tracks */
if (haveTracks) {
  T('real circuits: every catalog track gets zones + monotonic medal targets', function () {
    var TR = CB.race.tracks;
    TR.ids.forEach(function (id) {
      var g = TR.geometry(id);
      var sc = SC.createScorer(g, g.def, {});
      assert.ok(sc.zones.length >= 2, id + ' zones ' + sc.zones.length);
      sc.zones.forEach(function (z) {
        assert.ok(z.s >= 0 && z.s < g.length, id);
        assert.ok(Math.abs(z.lateral) <= g.samples[Math.round(z.s / g.ds) % g.samples.length].hw + 0.6, id + ' zone on asphalt');
        assert.ok(isFinite(z.x) && isFinite(z.y));
      });
      var t = sc.targets;
      assert.ok(t.bronze < t.silver && t.silver < t.gold && t.gold < t.platinum, id);
    });
  });
  T('real track: snapshot-shaped car (world velocity, auto project) drifting along the centreline scores', function () {
    var TR = CB.race.tracks;
    var g = TR.geometry('forge-ring');
    var sc = SC.createScorer(g, g.def, {});
    var s = 50, v = 20, st;
    for (var i = 0; i < 600; i++) {
      var p = g.pointAt(s, 0), h = p.heading;                // velocity along the track, nose 35° to the left
      st = sc.update({ id: 'player', x: p.x, y: p.y, heading: h + 35 * DEG, vx: v * Math.cos(h), vy: v * Math.sin(h), speed: v }, DT, []);
      s += v * DT;
    }
    assert.ok(st.drifting && st.current > 500, 'current ' + st.current);
    assert.ok(Math.abs(st.s - s) < 3, 'tracked s ' + st.s + ' vs ' + s);
    assert.equal(st.backwards, false);
    assert.equal(st.offTrack, false);
  });
}
if (haveDriftTracks) {
  T('drift tracks: authored driftZones are adopted', function () {
    var TR = CB.race.tracks;
    ['kurogane-pass', 'dockyard-sliders', 'circle-lab'].forEach(function (id) {
      var def = TR.get(id);
      if (!def) return;
      var g = TR.build(def);
      var sc = SC.createScorer(g, def, {});
      var authored = (def.driftZones || []).length;
      var hinted = sc.zones.filter(function (z) { return z.hint; }).length;
      assert.equal(hinted, authored, id);
      assert.ok(sc.zones.length >= authored);
    });
  });
}

/* ------------------------------------------- assisted-driver forgiveness (game default 'heavy') */
function heavy(opts) { return SC.createScorer(null, null, Object.assign({ zones: [] }, opts || {})); }

T('default forgiveness is heavy; grace never outlives the combo decay', function () {
  var sc = heavy();
  assert.equal(sc.options.assistLevel, 'heavy');
  assert.equal(sc.state().assistLevel, 'heavy');
  assert.ok(sc.options.grace_s > SC.DEFAULTS.grace_s);
  assert.ok(sc.options.endAngle_deg < SC.DEFAULTS.endAngle_deg);
  var silly = heavy({ grace_s: 9 });
  assert.ok(silly.options.grace_s < silly.options.comboDecayDelay_s, 'clamped ' + silly.options.grace_s);
  assert.equal(SC.assistLevelOf({ assist: { level: 'light' } }), 'light');
  assert.equal(SC.assistLevelOf({ assistLevel: 'bogus' }), 'heavy');
});

T('heavy: an assist wobble (1 s dip to 5°) keeps the drift alive; spec baseline banks it', function () {
  function wobble(sc) {
    run(sc, 3, car(35, 20));
    run(sc, 1.0, car(5, 20));
    return run(sc, 2, car(35, 20));
  }
  var h = heavy(), off = bare();
  var sh = wobble(h), so = wobble(off);
  assert.ok(sh.drifting && so.drifting);
  assert.equal(h.results().drifts, 1, 'heavy: still one drift');
  assert.equal(off.results().drifts, 2, 'off: drift was banked during the dip');
  // light sits in between: 0.8 s dip survives on heavy, banks on light
  var l = heavy({ assistLevel: 'light' }), h2 = heavy();
  [l, h2].forEach(function (sc) { run(sc, 2, car(35, 20)); run(sc, 0.8, car(3, 20)); run(sc, 1, car(35, 20)); });
  assert.equal(h2.results().drifts, 1);
  assert.equal(l.results().drifts, 2, 'light is less forgiving than heavy');
});

T('heavy: an established drift survives a speed dip below the start speed (but cannot start there)', function () {
  var h = heavy(), off = bare();
  [h, off].forEach(function (sc) { run(sc, 2, car(35, 15)); run(sc, 1.5, car(35, 5.5)); });   // 54 → 20 km/h
  assert.ok(h.state().drifting, 'heavy keeps it');
  assert.ok(h.state().rate > 0, 'and it still scores (slowly)');
  assert.equal(off.state().drifting, false, 'baseline: too slow → banked');
  assert.equal(heavy().update(car(35, 5.5), DT).drifting, false, 'cannot START a drift at 20 km/h');
});

T('heavy: a 1-frame β spike past 110° is not a spin, a sustained one is; baseline spins at once', function () {
  var h = recorder(heavy());
  run(h, 2, car(35, 20));
  h.update(car(125, 20), DT);
  var st = run(h, 1, car(35, 20));
  assert.equal(h.results().spins, 0, 'spike filtered');
  assert.ok(st.drifting);
  var h2 = heavy();
  run(h2, 2, car(35, 20)); run(h2, 0.4, car(125, 20));
  assert.equal(h2.results().spins, 1, 'sustained over-rotation = spin');
  var off = bare();
  run(off, 2, car(35, 20)); off.update(car(125, 20), DT);
  assert.equal(off.results().spins, 1);
});

T('SAVED! when a drift deep in its grace timer is caught again', function () {
  var rec = recorder(heavy());
  run(rec, 2, car(35, 20));
  var mid = run(rec, 0.6, car(4, 20));
  assert.ok(mid.drifting && mid.driftHealth < 0.6 && mid.driftHealth > 0, 'fuse burning ' + mid.driftHealth);
  assert.ok(mid.graceLeft_s > 0 && mid.graceLeft_s < rec.sc.options.grace_s);
  var before = rec.state().current;
  var st = run(rec, 0.2, car(35, 20));
  assert.ok(texts(rec).indexOf('SAVED!') >= 0, texts(rec).join('|'));
  assert.ok(st.current > before + 100, 'save bonus');
  assert.equal(st.driftHealth, 1);
  assert.equal(rec.results().saves, 1);
  // a short wiggle (not deep into grace) is not announced
  var r2 = recorder(heavy());
  run(r2, 2, car(35, 20)); run(r2, 0.1, car(4, 20)); run(r2, 0.2, car(35, 20));
  assert.equal(texts(r2).indexOf('SAVED!'), -1);
});

T('heavy: assist wobble costs less smoothness than on the baseline', function () {
  function jit(sc) { return run(sc, 4, function (t, i) { return car(i % 20 < 10 ? 28 : 48, 20); }).smoothness; }
  assert.ok(jit(heavy()) > jit(bare()) + 0.05);
});

T('feel-good popups: ×N COMBO!, PERFECT ANGLE (sweet spot only), live milestones', function () {
  var rec = recorder(heavy({ longDrift: [] }));
  run(rec, 21, car(40, 20));
  var tx = texts(rec);
  assert.ok(tx.indexOf('×2 COMBO!') >= 0, tx.join('|'));
  assert.ok(tx.some(function (t) { return /^PERFECT ANGLE 40°$/.test(t); }), tx.join('|'));
  assert.ok(tx.some(function (t) { return /^2,000 PTS/.test(t); }), tx.join('|'));
  assert.ok(rec.results().perfectAngles >= 5);
  assert.ok(rec.state().sweetProgress >= 0 && rec.state().sweetProgress <= 1);
  var wide = recorder(heavy({ longDrift: [] }));
  run(wide, 8, car(60, 20));
  assert.equal(texts(wide).filter(function (t) { return /PERFECT ANGLE/.test(t); }).length, 0, 'no perfect angle at 60°');
  // opt-out
  var quiet = recorder(heavy({ comboEvents: false, sweetHold_s: 0, milestones: [] }));
  run(quiet, 21, car(40, 20));
  assert.ok(!texts(quiet).some(function (t) { return /COMBO!|PERFECT|PTS/.test(t); }), texts(quiet).join('|'));
});

T('combo event on the ×5 cap reads MAX COMBO', function () {
  // (timeMultiplierCap 0: time alone may grow the combo all the way; heavy caps it — see the anti-exploit tests)
  var rec = recorder(heavy({ longDrift: [], timeMultiplierCap: 0 }));
  run(rec, 85, car(35, 20));
  assert.equal(rec.state().multiplier, 5);
  assert.ok(texts(rec).indexOf('MAX COMBO ×5!') >= 0, texts(rec).join('|'));
});

/* ------------------------------------------------------- anti-exploit (arrow mashing / rhythm / one held arrow) */
/** flick β between +amp and -amp every `period` s (a bot swapping Left/Right in a steady rhythm) */
function flick(amp, period) { return function (t) { return car(Math.floor(t / period) % 2 ? -amp : amp, 20); }; }

T('heavy: rhythmic Left/Right flicking on a STRAIGHT pays no swing bonus (the road never changed direction)', function () {
  var g = makeLoop({ straight: 400 });
  var sc = SC.createScorer(g, g.def, { zones: [], assistLevel: 'heavy' });
  run(sc, 16, flick(35, 0.8), function (t) { return { proj: proj(10 + t * 20, 0) }; });
  var r = sc.results();
  assert.ok(r.flicks >= 10, 'flicks ' + r.flicks);
  assert.equal(r.transitions, 0);
  assert.equal(r.manjis, 0);
});

T('off (no road gate): repeated MANJIs pay diminishing returns and swings add at most swingMultMax to the combo', function () {
  var rec = recorder(bare({ multiplierStepTime_s: 999 }));
  run(rec, 20, flick(35, 0.8));
  var r = rec.results();
  assert.ok(r.transitions >= 10 && r.manjis >= 5, r.transitions + ' / ' + r.manjis);
  assert.ok(r.maxMultiplier <= 1 + SC.DEFAULTS.swingMultMax + 1e-6, 'mult ' + r.maxMultiplier);
  var mj = rec.seen.filter(function (e) { return e.kind === 'manji'; }).map(function (e) { return e.points; });
  assert.ok(mj[mj.length - 1] < mj[0], mj.join(','));
});

T('shallow wiggles (old side below swingMinAngle_deg) are flicks, not paid swings', function () {
  var sc = bare();
  run(sc, 12, flick(19, 0.8));
  var r = sc.results();
  assert.ok(r.flicks >= 5, 'flicks ' + r.flicks);
  assert.equal(r.transitions, 0);
});

T('swing threshold follows the assist: heavy/auto pay ~23° assisted transitions, light/off still need 25°', function () {
  assert.equal(SC.FORGIVENESS.heavy.swingMinAngle_deg, 15);
  assert.equal(SC.FORGIVENESS.auto.swingMinAngle_deg, 15);
  assert.equal(SC.FORGIVENESS.medium.swingMinAngle_deg, 20);
  assert.equal(SC.FORGIVENESS.light.swingMinAngle_deg, 25);
  function swings(level, amp) {
    var sc = SC.createScorer(null, null, { zones: [], assistLevel: level });
    run(sc, 2, car(amp, 20)); run(sc, 1.2, car(-amp, 20)); run(sc, 1.2, car(amp, 20));
    return sc.results().transitions;
  }
  assert.ok(swings('heavy', 23) >= 2, 'heavy 23°');
  assert.ok(swings('auto', 23) >= 2, 'auto 23°');
  assert.ok(swings('medium', 23) >= 2, 'medium 23°');
  assert.equal(swings('light', 23), 0, 'light 23°');
  assert.equal(swings('off', 23), 0, 'off 23°');
});

T('heavy: one endless drift only grows the combo to timeMultiplierCap (zones / swings raise the ceiling)', function () {
  var sc = heavy({ longDrift: [] });
  var st = run(sc, 85, car(35, 20));
  assert.equal(st.multiplier, SC.FORGIVENESS.heavy.timeMultiplierCap);
});

T('sliding the wrong way round a corner scores less than the right way', function () {
  var g = makeLoop();
  function through(beta) {
    var sc = SC.createScorer(g, g.def, { zones: [], assistLevel: 'heavy' });
    var s0 = 100;   // straight → first left-hand 90° corner (s 120 … 167)
    run(sc, 4, car(beta, 20), function (t) { return { proj: proj(s0 + t * 20, 0) }; });
    return sc.results();
  }
  var right = through(-35), wrong = through(35);
  assert.equal(right.counterTime_s, 0);
  assert.ok(wrong.counterTime_s > 0.5, 'counter ' + wrong.counterTime_s);
  assert.ok(wrong.total < right.total * 0.8, wrong.total + ' vs ' + right.total);
});

/* ------------------------------------------------------- medal targets: run length + assist lock */
var AUTH = { id: 'auth', drift: { duration_s: 180, medals: { bronze: 25000, silver: 60000, gold: 120000, platinum: 200000 } } };
T('authored medals are scaled by the actual run length (180 s medals in a 90 s trial → half)', function () {
  var t90 = SC.medalTargets(null, AUTH, { duration_s: 90, calibrateTargets: false });
  var t180 = SC.medalTargets(null, AUTH, { duration_s: 180, calibrateTargets: false });
  assert.equal(t180.gold, 120000);
  assert.equal(t90.gold, 60000);
  assert.equal(t90.platinum, 100000);
});

T('lowering the assist level mid-run never lowers the medal targets (raising does)', function () {
  var sc = SC.createScorer(null, AUTH, { zones: [], assistLevel: 'heavy', duration_s: 180, calibrateTargets: false });
  run(sc, 6, car(35, 20)); run(sc, 2, car(0, 20));
  assert.ok(sc.state().total > 0);
  sc.setAssistLevel('light');
  assert.equal(sc.state().targets.gold, 120000, 'still heavy-scale');
  assert.equal(sc.results().medalAssistLevel, 'heavy');
  // before anything scores the new level simply applies
  var sc2 = SC.createScorer(null, AUTH, { zones: [], assistLevel: 'heavy', duration_s: 180, calibrateTargets: false });
  sc2.setAssistLevel('light');
  assert.ok(sc2.state().targets.gold < 120000 * 0.2, 'light scale ' + sc2.state().targets.gold);
  run(sc2, 6, car(35, 20));
  sc2.setAssistLevel('heavy');
  assert.equal(sc2.state().targets.gold, 120000, 'raised to heavy');
});

T('spin coach hint only promises an assist catch when an assist will catch it', function () {
  function hint(lvl) {
    var sc = SC.createScorer(null, null, { zones: [], assistLevel: lvl });
    run(sc, 2, car(35, 20)); run(sc, 0.5, car(140, 20));
    return sc.state().coach;
  }
  ['off', 'light'].forEach(function (l) { var h = hint(l); assert.equal(h.id, 'spin'); assert.ok(!/ASSIST/.test(h.text) && /COUNTER-STEER/.test(h.text), l + ': ' + h.text); });
  ['medium', 'heavy', 'auto'].forEach(function (l) { var h = hint(l); assert.equal(h.id, 'spin'); assert.ok(/ASSIST/.test(h.text), l + ': ' + h.text); });
});

if (local) {
  var passed = 0, failed = 0;
  queue.forEach(function (t) {
    try { t.fn(); passed++; console.log('  \u2713 ' + t.name); }
    catch (e) { failed++; console.log('  \u2717 ' + t.name + '\n    ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n    ')); }
  });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

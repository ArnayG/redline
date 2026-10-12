/* Node tests for js/race/drift/hud.js — run: node tests/drift-hud.test.js  (or node tests/run.js drift-hud) */
'use strict';
var assert = require('assert');
var path = require('path');
var hud = require(path.join(__dirname, '..', 'js', 'race', 'drift', 'hud.js'));
var I = hud._internal;

var standalone = typeof globalThis.test !== 'function';
var passed = 0;
var test = standalone ? function (name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
} : globalThis.test;

/** Canvas 2D context stub: accepts every call, records fillText strings. */
function fakeCtx() {
  var texts = [];
  var grad = { addColorStop: function () {} };
  var target = {
    texts: texts,
    measureText: function (s) { return { width: String(s).length * 7 }; },
    fillText: function (s) { texts.push(String(s)); },
    strokeText: function () {},
    createLinearGradient: function () { return grad; },
    createRadialGradient: function () { return grad; }
  };
  return new Proxy(target, {
    get: function (t, k) { return k in t ? t[k] : function () {}; },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}
function fakeCanvas(w, h) { return { clientWidth: w, clientHeight: h, width: w, height: h }; }

function snap(over) {
  var s = {
    t: 30, phase: 'running', mode: 'practice', playerId: 'player', trackLength: 1000, raceTime: 30,
    cars: [{ id: 'player', isPlayer: true, x: 0, y: 0, heading: 0, vx: 20, vy: -12, speed: 23.3, s: 100 },
           { id: 'ai1', isPlayer: false, name: 'Lead', x: 6, y: 0, heading: 0, vx: 20, vy: 0, speed: 20, s: 106, raceDist: 106 }]
  };
  return Object.assign(s, over || {});
}
function scorer(over) {
  return Object.assign({
    total: 12000, current: 1500, combo: 3, multiplier: 2.4, angle_deg: 36, speed: 23, grade: 'A', drifting: true,
    zones: [{ id: 'z1', s: 150, side: 'left', kind: 'inner', hit: false }, { id: 'z2', s: 400, side: 'right', kind: 'outer', hit: true }],
    lastEvent: null, targets: { bronze: 10000, silver: 25000, gold: 50000, platinum: 80000 }
  }, over || {});
}
function clockHud(opts) {
  var t = { ms: 0 };
  var h = hud.create(fakeCanvas(1366, 800), Object.assign({ now: function () { return t.ms; } }, opts || {}));
  h.tick = function (ctx, sn, st, dbg, dtMs) { t.ms += dtMs == null ? 16 : dtMs; h.draw(ctx, sn, st, dbg); };
  return h;
}

test('exports on CB namespace', function () {
  assert.strictEqual(globalThis.CB.race.drift.hud, hud);
  assert.strictEqual(typeof hud.create, 'function');
});

test('fmtInt / fmtShort / fmtClock / fmtMult', function () {
  assert.strictEqual(I.fmtInt(1234567.4), '1,234,567');
  assert.strictEqual(I.fmtInt(-2450), '-2,450');
  assert.strictEqual(I.fmtInt(undefined), '0');
  assert.strictEqual(I.fmtShort(12500), '12.5K');
  assert.strictEqual(I.fmtShort(250000), '250K');
  assert.strictEqual(I.fmtShort(2000000), '2M');
  assert.strictEqual(I.fmtClock(65.34), '1:05.3');
  assert.strictEqual(I.fmtClock(null), '--:--');
  assert.strictEqual(I.fmtClock(59.97), '1:00.0');
  assert.strictEqual(I.fmtMult(3.2), '×3.2');
});

test('gradeInfo', function () {
  assert.strictEqual(I.gradeInfo('ss').label, 'INSANE');
  assert.strictEqual(I.gradeInfo('A').label, 'GREAT');
  assert.ok(I.gradeInfo('SS').rank > I.gradeInfo('S').rank);
  assert.strictEqual(I.gradeInfo(null), null);
  assert.strictEqual(I.gradeInfo({ grade: 'B' }).code, 'B');
});

test('classifyEvent', function () {
  assert.strictEqual(I.classifyEvent('COMBO LOST').kind, 'bad');
  assert.strictEqual(I.classifyEvent('SPIN!').kind, 'bad');
  assert.strictEqual(I.classifyEvent('CLIPPING ZONE!', 500).kind, 'zone');
  assert.strictEqual(I.classifyEvent('SWING!', 300).kind, 'swing');
  assert.strictEqual(I.classifyEvent('CLOSE TO WALL', 200).kind, 'wall');
  assert.strictEqual(I.classifyEvent('GREAT DRIFT', 2450).kind, 'bank');
  assert.ok(I.classifyEvent('GREAT DRIFT').big);
  assert.strictEqual(I.classifyEvent('TANDEM BONUS', 100).kind, 'tandem');
  assert.strictEqual(I.classifyEvent('???', -50).kind, 'bad');
});

test('normalizeTargets accepts object, array of numbers and array of objects', function () {
  var a = I.normalizeTargets({ gold: 50, bronze: 10, silver: 25, platinum: 80 });
  assert.deepStrictEqual(a.map(function (m) { return m.medal; }), ['bronze', 'silver', 'gold', 'platinum']);
  var b = I.normalizeTargets([10, 20, 30]);
  assert.deepStrictEqual(b.map(function (m) { return m.score; }), [10, 20, 30]);
  assert.strictEqual(b[2].medal, 'gold');
  var c = I.normalizeTargets([{ medal: 'silver', score: 5 }, { id: 'bronze', points: 2 }]);
  assert.strictEqual(c[0].medal, 'bronze');
  assert.deepStrictEqual(I.normalizeTargets(null), []);
  var p = I.medalProgress(30, a);
  assert.strictEqual(p.current.medal, 'silver');
  assert.strictEqual(p.next.medal, 'gold');
  assert.strictEqual(p.toNext, 20);
  assert.strictEqual(I.medalProgress(100, a).next, null);
});

test('nextZone: nearest unhit ahead, wraps the lap, detects in-zone', function () {
  var zones = [{ id: 'a', s: 100, length: 30 }, { id: 'b', s: 300 }, { id: 'c', s: 950, hit: true }];
  var n = I.nextZone(zones, 50, 1000, 400);
  assert.strictEqual(n.zone.id, 'a'); assert.strictEqual(n.dist, 50); assert.ok(!n.inZone);
  n = I.nextZone(zones, 110, 1000, 400);
  assert.strictEqual(n.zone.id, 'a'); assert.ok(n.inZone); assert.ok(Math.abs(n.progress - 10 / 30) < 1e-9);
  n = I.nextZone(zones, 900, 1000, 400);   // c is hit -> skipped, wraps to a
  assert.strictEqual(n.zone.id, 'a'); assert.strictEqual(n.dist, 200);
  n = I.nextZone(zones, 955, 1000, 400);   // inside hit zone c still reports in-zone
  assert.strictEqual(n.zone.id, 'c'); assert.ok(n.inZone);
  assert.strictEqual(I.nextZone(zones, 500, 1000, 100), null);
  assert.strictEqual(I.nextZone(null, 0, 1000), null);
});

test('zoneSide / zoneKind', function () {
  assert.strictEqual(I.zoneSide({ side: 'left' }), -1);
  assert.strictEqual(I.zoneSide({ side: 'R' }), 1);
  assert.strictEqual(I.zoneSide({ side: 'inner', turn: 'right' }), 1);
  assert.strictEqual(I.zoneSide({ side: 'outer', turn: 'right' }), -1);
  assert.strictEqual(I.zoneSide({ lateral: 5 }), -1);
  assert.strictEqual(I.zoneSide({}), 0);
  assert.strictEqual(I.zoneKind({ kind: 'outer' }), 'outer');
  assert.strictEqual(I.zoneKind({ side: 'inner' }), 'inner');
  assert.strictEqual(I.zoneKind({ kind: 'weird' }), 'zone');
});

test('drift angle sign: velocity right of nose (left-hand drift) is negative', function () {
  var a = I.carDriftAngle({ heading: 0, vx: 20, vy: -20 });
  assert.ok(Math.abs(a + 45) < 1e-6);
  var b = I.carDriftAngle({ heading: Math.PI / 2, vx: 20, vy: 20 }); // nose +y, moving +x+y -> velocity right of nose
  assert.ok(Math.abs(b + 45) < 1e-6);
  assert.strictEqual(I.carDriftAngle({ heading: 0, vx: 0.5, vy: 0.5 }), 0);
  assert.strictEqual(I.carDriftAngle({ vxLocal: 10, vyLocal: 10 }), 45);
  // scorer magnitude + assist sign
  assert.strictEqual(I.signedAngle({ angle_deg: 30 }, null, I.readAssist({ beta: -0.5 })), -30);
  assert.strictEqual(I.signedAngle({ angle_deg: 30 }, { heading: 0, vx: 20, vy: 10 }, null), 30);
  assert.strictEqual(I.signedAngle({ angle_deg: -25 }, null, null), -25);
  assert.strictEqual(I.angleBand(40), 'sweet');
  assert.strictEqual(I.angleBand(-80), 'over');
  assert.strictEqual(I.angleBand(5), 'idle');
});

test('readAssist accepts radians or degrees', function () {
  var r = I.readAssist({ beta: -0.6, targetAngle: -0.7, counterSteer: 0.4, level: 'heavy' });
  assert.ok(Math.abs(r.beta + 0.6 * 180 / Math.PI) < 1e-9);
  assert.ok(Math.abs(r.target + 0.7 * 180 / Math.PI) < 1e-9);
  assert.strictEqual(r.counter, 0.4);
  assert.strictEqual(I.readAssist({ target_deg: 35 }).target, 35);
  assert.strictEqual(I.readAssist(null), null);
});

test('approach counts up monotonically, converges, snaps down on reset', function () {
  var d = 0, prev = 0;
  for (var i = 0; i < 120; i++) { d = I.approach(d, 10000, 1 / 60, 6); assert.ok(d >= prev); prev = d; }
  assert.strictEqual(d, 10000);
  assert.strictEqual(I.approach(5000, 0, 1 / 60), 0);
  assert.ok(I.approach(0, 1000, 1 / 60) < 1000);
});

test('tandemInfo: from scorer or derived from snapshot cars', function () {
  var sn = snap();
  var t1 = I.tandemInfo({ tandem: { distance_m: 3 } }, sn, sn.cars[0]);
  assert.strictEqual(t1.dist, 3); assert.strictEqual(t1.band, 'door');
  var t2 = I.tandemInfo({}, sn, sn.cars[0]);
  assert.strictEqual(t2.dist, 6); assert.strictEqual(t2.band, 'close'); assert.strictEqual(t2.leadName, 'Lead');
  assert.strictEqual(I.tandemInfo({}, { cars: [sn.cars[0]] }, sn.cars[0]), null);
});

test('timerInfo: remaining from scorer, from duration, or elapsed', function () {
  assert.deepStrictEqual(I.timerInfo({ timeLeft_s: 8 }, {}, {}).urgent, true);
  var t = I.timerInfo({}, { raceTime: 30 }, { duration_s: 90 });
  assert.strictEqual(t.t, 60); assert.ok(t.remaining); assert.ok(Math.abs(t.frac - 2 / 3) < 1e-9);
  var e = I.timerInfo({}, { raceTime: 12 }, {});
  assert.strictEqual(e.t, 12); assert.ok(!e.remaining);
});

test('draw is robust to missing / partial / garbage inputs', function () {
  var h = clockHud();
  var ctx = fakeCtx();
  h.tick(ctx, null, null, null);
  h.tick(ctx, {}, {}, {});
  h.tick(ctx, { cars: [] }, { zones: 'nope', targets: 7, total: NaN }, { beta: 'x' });
  h.tick(ctx, snap(), scorer(), { beta: -0.6, targetAngle: -0.65, counterSteer: 0.5, level: 'heavy' });
  h.tick(ctx, snap({ cars: [{ isPlayer: true }] }), { total: 5, zones: [null, { s: 'a' }, { s: 10 }], tandem: 4 }, null);
  assert.ok(ctx.texts.length > 0);
  var small = hud.create(fakeCanvas(400, 300), {});
  small.draw(fakeCtx(), snap(), scorer({ tandem: { distance: 9 } }), null);
});

test('draw renders score, angle, combo, timer, medals, tandem, zone text', function () {
  var h = clockHud({ mode: 'tandem', duration_s: 90 });
  var ctx = fakeCtx();
  for (var i = 0; i < 200; i++) h.tick(ctx, snap(), scorer(), { beta: -0.63 });
  ctx.texts.length = 0;
  h.tick(ctx, snap(), scorer(), { beta: -0.63 });
  var all = ctx.texts.join(' ');
  assert.ok(all.indexOf('12,000') >= 0, 'total');
  assert.ok(all.indexOf('1,500') >= 0, 'current');
  assert.ok(all.indexOf('36°') >= 0, 'angle');
  assert.ok(all.indexOf('×2.4') >= 0, 'multiplier');
  assert.ok(all.indexOf('1:00.0') >= 0, 'timer (90 - 30)');
  assert.ok(all.indexOf('SILVER IN') >= 0, 'next medal');
  assert.ok(all.indexOf('6.0 m') >= 0, 'tandem distance');
  assert.ok(all.indexOf('INNER CLIP') >= 0, 'zone arrow label');
  assert.ok(all.indexOf('1/2') >= 0, 'zones hit counter');
});

test('popups: events shown once, bank formatted, synthetic bank + combo lost', function () {
  var h = clockHud();
  var ctx = fakeCtx();
  var st = scorer({ lastEvent: { text: 'CLIPPING ZONE!', points: 500, t: 10 } });
  h.tick(ctx, snap(), st);
  h.tick(ctx, snap(), st);
  var pops = h.debugState().popups;
  assert.strictEqual(pops.filter(function (p) { return p.kind === 'zone'; }).length, 1, 'zone popup once');
  // bank via event
  h.tick(ctx, snap(), scorer({ total: 14450, current: 0, lastEvent: { text: 'GREAT DRIFT', points: 2450, t: 12 } }));
  pops = h.debugState().popups;
  var bank = pops.filter(function (p) { return p.big; })[0];
  assert.ok(bank && bank.points === 2450 && /GREAT DRIFT/.test(bank.text));
  ctx.texts.length = 0;
  h.tick(ctx, snap(), scorer({ total: 14450, current: 0, lastEvent: { text: 'GREAT DRIFT', points: 2450, t: 12 } }), null, 200);
  assert.ok(ctx.texts.indexOf('+2,450') >= 0, 'big points text');
  assert.ok(ctx.texts.some(function (s) { return /GREAT DRIFT\s+×2\.4/.test(s); }), 'sub line with multiplier: ' + ctx.texts.join('|'));
  // synthetic bank (no event)
  var h2 = clockHud(); var c2 = fakeCtx();
  h2.tick(c2, snap(), { total: 1000, current: 800, multiplier: 2, grade: 'S' });
  h2.tick(c2, snap(), { total: 1800, current: 0, multiplier: 1, grade: 'S' }, null, 500);
  var p2 = h2.debugState().popups;
  assert.ok(p2.some(function (p) { return p.big && p.points === 800 && /AWESOME/.test(p.text); }), JSON.stringify(p2));
  // combo lost synthesized
  var h3 = clockHud(); var c3 = fakeCtx();
  h3.tick(c3, snap(), { total: 1000, current: 900, multiplier: 2 });
  h3.tick(c3, snap(), { total: 1000, current: 0, multiplier: 1 }, null, 500);
  assert.ok(h3.debugState().popups.some(function (p) { return p.text === 'COMBO LOST' && p.kind === 'bad'; }));
  // events[] array dedupe by id
  var h4 = clockHud(); var c4 = fakeCtx();
  var evs = [{ id: 1, text: 'SWING!', points: 300 }, { id: 2, text: 'CLOSE TO WALL', points: 150 }];
  h4.tick(c4, snap(), { total: 0, events: evs });
  h4.tick(c4, snap(), { total: 0, events: evs });
  assert.strictEqual(h4.debugState().popups.length, 2);
});

test('popups expire and restart (total drop) clears state', function () {
  var h = clockHud(); var ctx = fakeCtx();
  h.tick(ctx, snap(), scorer({ lastEvent: { text: 'SWING!', points: 300 } }));
  assert.ok(h.debugState().popups.length >= 1);
  for (var i = 0; i < 40; i++) h.tick(ctx, snap(), scorer({ lastEvent: { text: 'SWING!', points: 300 } }), null, 100);
  assert.strictEqual(h.debugState().popups.length, 0);
  h.tick(ctx, snap(), scorer({ total: 0, current: 0 }));
  assert.strictEqual(h.debugState().dispTotal, 0);
});

test('score counter animates (count-up) rather than jumping', function () {
  var h = clockHud(); var ctx = fakeCtx();
  h.tick(ctx, snap(), { total: 0 });
  h.tick(ctx, snap(), { total: 10000 });
  var d1 = h.debugState().dispTotal;
  assert.ok(d1 > 0 && d1 < 10000, 'partial: ' + d1);
  for (var i = 0; i < 120; i++) h.tick(ctx, snap(), { total: 10000 });
  assert.strictEqual(h.debugState().dispTotal, 10000);
});

test('world markers use projector; manual popup; destroy stops drawing', function () {
  var calls = 0;
  var h = clockHud({ worldToScreen: function (x, y) { calls++; return { x: x, y: y, visible: true }; } });
  var ctx = fakeCtx();
  h.tick(ctx, snap(), scorer({ zones: [{ id: 'a', s: 150, x: 10, y: 20, kind: 'inner' }] }));
  assert.ok(calls >= 1);
  h.popup('PERFECT ENTRY', 400);
  assert.ok(h.debugState().popups.some(function (p) { return p.text === 'PERFECT ENTRY'; }));
  h.destroy();
  var c2 = fakeCtx();
  h.tick(c2, snap(), scorer());
  assert.strictEqual(c2.texts.length, 0);
});

test('spring needle: converges without overshoot and filters frame noise', function () {
  var sp = { x: 0, v: 0 }, maxX = 0;
  for (var i = 0; i < 120; i++) { sp = I.spring(sp, 40, 1 / 60, 13); maxX = Math.max(maxX, sp.x); }
  assert.ok(Math.abs(sp.x - 40) < 0.05, 'converged ' + sp.x);
  assert.ok(maxX <= 40.0001, 'no overshoot ' + maxX);
  // +-6 deg alternating noise around 35 -> displayed wobble much smaller than raw
  sp = { x: 35, v: 0 }; var lo = 99, hi = -99;
  for (var j = 0; j < 240; j++) { sp = I.spring(sp, 35 + (j % 2 ? 6 : -6), 1 / 60, 13); if (j > 60) { lo = Math.min(lo, sp.x); hi = Math.max(hi, sp.x); } }
  assert.ok(hi - lo < 3, 'wobble ' + (hi - lo));
  assert.deepStrictEqual(I.spring(null, 5, 0.016), { x: 5, v: 0 });
});

test('readAssist understands CB.race.assist.debug() (deg fields + phase) and assistPhase labels', function () {
  var r = I.readAssist({ phase: 'drift', targetAngle_deg: -35, beta_deg: -33, counterSteer_deg: -20, level: 'heavy', holdAngle_deg: 35 });
  assert.strictEqual(r.target, -35); assert.strictEqual(r.beta, -33); assert.strictEqual(r.counter, -0.5); assert.strictEqual(r.hold, 35);
  assert.strictEqual(I.assistPhase(r).id, 'hold');
  assert.strictEqual(I.assistPhase(I.readAssist({ phase: 'init' })).id, 'kick');
  assert.strictEqual(I.assistPhase(I.readAssist({ phase: 'drift', recovering: true })).id, 'catch');
  assert.strictEqual(I.assistPhase(I.readAssist({ phase: 'spin' })).id, 'spin');
  assert.strictEqual(I.assistPhase(null), null);
});

test('coachInfo + milestoneCrossed', function () {
  assert.strictEqual(I.coachInfo({ id: 'sweet', text: 'Sweet spot — hold it!', tone: 'good' }).text, 'SWEET SPOT — HOLD IT!');
  assert.strictEqual(I.coachInfo('tap left').tone, 'info');
  assert.strictEqual(I.coachInfo({}), null);
  assert.strictEqual(I.milestoneCrossed(900, 1100), 1000);
  assert.strictEqual(I.milestoneCrossed(1100, 1200), 0);
  assert.strictEqual(I.milestoneCrossed(900, 5200), 5000);
});

test('drifting label has hysteresis; grace "SAVE IT!" appears when the angle collapses mid-drift', function () {
  var h = clockHud(); var ctx = fakeCtx();
  for (var i = 0; i < 30; i++) h.tick(ctx, snap(), scorer({ drifting: true, angle_deg: 36 }));
  assert.strictEqual(h.debugState().drifting, true);
  h.tick(ctx, snap(), scorer({ drifting: false, angle_deg: 36 }), null, 100);
  assert.strictEqual(h.debugState().drifting, true, 'brief drop does not flicker the label');
  for (var j = 0; j < 5; j++) h.tick(ctx, snap(), scorer({ drifting: false, angle_deg: 36 }), null, 100);
  assert.strictEqual(h.debugState().drifting, false);
  var h2 = clockHud(); var c2 = fakeCtx();
  h2.tick(c2, snap(), scorer({ drifting: true, angle_deg: 36 }));
  for (var k = 0; k < 10; k++) h2.tick(c2, snap(), scorer({ drifting: true, angle_deg: 6 }), null, 30);
  assert.ok(h2.debugState().grace > 0.2);
  c2.texts.length = 0;
  h2.tick(c2, snap(), scorer({ drifting: true, angle_deg: 6 }));
  assert.ok(c2.texts.join('').indexOf('SAVE IT!') >= 0, 'tracked SAVE IT! label: ' + c2.texts.join(''));
});

test('coach hints are debounced and shown; repeated small popups stack', function () {
  var h = clockHud(); var ctx = fakeCtx();
  // (between drifts: the CHAIN IT tip is a between-slides hint, dropped while drifting)
  var a = { id: 'zone', text: 'OUTER ZONE ← — SWING THE REAR CLOSE', tone: 'info' }, b = { id: 'chain', text: 'CHAIN IT — FLICK THE OTHER WAY!', tone: 'warn' };
  for (var i = 0; i < 30; i++) h.tick(ctx, snap(), scorer({ coach: a, drifting: false }));
  assert.strictEqual(h.debugState().coach, a.text);
  // alternating hints every frame never replace the shown one (no flicker)
  for (var j = 0; j < 30; j++) h.tick(ctx, snap(), scorer({ coach: j % 2 ? a : b, drifting: false }));
  assert.strictEqual(h.debugState().coach, a.text);
  // a stable new hint takes over after the minimum display time
  for (var q = 0; q < 120; q++) h.tick(ctx, snap(), scorer({ coach: b, drifting: false }));
  assert.strictEqual(h.debugState().coach, b.text);
  // bad tone is instant
  h.tick(ctx, snap(), scorer({ coach: { id: 'spin', text: 'LET GO', tone: 'bad' } }));
  assert.strictEqual(h.debugState().coach, 'LET GO');
  var h2 = clockHud(); var c2 = fakeCtx();
  h2.tick(c2, snap(), scorer({ events: [{ id: 1, text: 'SWING!', points: 250 }] }));
  h2.tick(c2, snap(), scorer({ events: [{ id: 1, text: 'SWING!', points: 250 }, { id: 2, text: 'SWING!', points: 250 }] }), null, 300);
  var sw = h2.debugState().popups.filter(function (p) { return p.text === 'SWING!'; });
  assert.strictEqual(sw.length, 1); assert.strictEqual(sw[0].points, 500);
});

test('angle coach hints never contradict the meter (drop at once, fill scorer gaps)', function () {
  var sweet = { id: 'sweet', text: 'SWEET SPOT — HOLD IT!', tone: 'good' };
  var more = { id: 'more-angle', text: 'MORE ANGLE — HOLD THE ARROW + ↑', tone: 'info' };
  // pure helpers
  assert.strictEqual(I.angleHintValid('sweet', 40, true, false), true);
  assert.strictEqual(I.angleHintValid('sweet', 40, true, true), false, 'no SWEET SPOT while SAVE IT!');
  assert.strictEqual(I.angleHintValid('sweet', 4, true, false), false);
  assert.strictEqual(I.angleHintValid('more-angle', 33, true, false), false);
  assert.strictEqual(I.angleHintFor(27).id, 'more-angle', 'fills the scorer null range 25-30');
  assert.strictEqual(I.angleHintFor(54), null);
  assert.strictEqual(I.reconcileAngleHint(I.coachInfo(more), 33, true, false).id, 'sweet');
  assert.strictEqual(I.reconcileAngleHint(I.coachInfo({ id: 'zone', text: 'x' }), 33, true, false).id, 'zone');
  // (1) sweet spot shown, angle collapses to 4 deg -> hint gone well inside the 1.6 s minimum
  var h = clockHud(); var ctx = fakeCtx();
  for (var i = 0; i < 40; i++) h.tick(ctx, snap(), scorer({ angle_deg: 40, coach: sweet }));
  assert.strictEqual(h.debugState().coach, sweet.text);
  for (var j = 0; j < 12; j++) h.tick(ctx, snap(), scorer({ angle_deg: 4, coach: sweet }));
  assert.notStrictEqual(h.debugState().coach, sweet.text, 'stale SWEET SPOT dropped: ' + h.debugState().coach);
  // (2) scorer still says MORE ANGLE while the meter reads 33 deg -> HUD shows the sweet spot instead
  var h2 = clockHud(); var c2 = fakeCtx();
  for (var q = 0; q < 60; q++) h2.tick(c2, snap(), scorer({ angle_deg: 33, coach: more }));
  assert.strictEqual(h2.debugState().coach, sweet.text);
  // (3) scorer silent at 27 deg -> MORE ANGLE (never a leftover SWEET SPOT)
  var h3 = clockHud(); var c3 = fakeCtx();
  for (var r = 0; r < 40; r++) h3.tick(c3, snap(), scorer({ angle_deg: 40, coach: sweet }));
  for (var u = 0; u < 60; u++) h3.tick(c3, snap(), scorer({ angle_deg: 27, coach: null }));
  assert.strictEqual(h3.debugState().coach, more.text);
});

test('camera view classes, zone legend, zone state gated until moving', function () {
  assert.strictEqual(I.cameraView('cockpit'), 'interior');
  assert.strictEqual(I.cameraView('hood'), 'interior');
  assert.strictEqual(I.cameraView('chase-far'), 'chase');
  assert.strictEqual(I.cameraView('tv'), 'other');
  assert.strictEqual(I.cameraView(null), 'other');
  var lg = I.zoneLegend([{ kind: 'inner' }, { kind: 'outer' }, { kind: 'zone' }, { kind: 'swing' }, { kind: 'inner' }]);
  assert.deepStrictEqual(lg.map(function (e) { return e.label; }), ['OUTER', 'CLIP', 'ZONE/SWING']);
  // parked inside a zone during the countdown: no IN ZONE chip / IN ... ZONE label
  var h = clockHud(); var ctx = fakeCtx();
  var parked = snap({ cars: [{ id: 'player', isPlayer: true, x: 0, y: 0, heading: 0, vx: 0, vy: 0, speed: 0, s: 150 }] });
  var still = scorer({ drifting: false, current: 0, speed: 0, angle_deg: 0, total: 0, multiplier: 1 });
  for (var i = 0; i < 5; i++) h.tick(ctx, parked, still);
  var all = ctx.texts.join('|');
  assert.ok(all.indexOf('IN ZONE') < 0 && all.indexOf('IN INNER CLIP') < 0, all);
  assert.ok(all.indexOf('CLIP') >= 0, 'legend drawn');
  // moving through the same zone lights it up
  ctx.texts.length = 0;
  var rolling = snap({ cars: [{ id: 'player', isPlayer: true, x: 0, y: 0, heading: 0, vx: 20, vy: -12, speed: 23, s: 150 }] });
  h.tick(ctx, rolling, scorer());
  assert.ok(ctx.texts.join('|').indexOf('IN ZONE') >= 0);
  // cockpit / chase renderers do not break drawing
  ['cockpit', 'chase'].forEach(function (m) {
    var h2 = clockHud(); var c2 = fakeCtx();
    h2.attachRenderer({ getCamera: function () { return m; }, getCameraState: function () { return null; } });
    h2.tick(c2, snap(), scorer());
    assert.ok(c2.texts.length > 5, m);
  });
});

test('integration: real CB.race.drift.scoring state() drives the HUD (bank popup, zones, sign)', function () {
  var tracks, scoring;
  try {
    tracks = require(path.join(__dirname, '..', 'js', 'race', 'tracks.js'));
    scoring = require(path.join(__dirname, '..', 'js', 'race', 'drift', 'scoring.js'));
  } catch (e) { return; }  // modules built by other teams may be absent mid-integration
  if (!scoring || typeof scoring.createScorer !== 'function') return;
  var def = (tracks.list || tracks.all())[0], geom = tracks.build(def);
  var sc = scoring.createScorer(geom, def, {});
  var h = clockHud(); var ctx = fakeCtx();
  var smp = geom.samples, i = 0, beta = 35 * Math.PI / 180, v = 22;
  var sawBank = false, sawBadDouble = false;
  for (var step = 0; step < 60 * 14; step++) {
    var q = smp[Math.floor(i) % smp.length];
    var drifting = step < 60 * 9;
    var b = drifting ? beta : 0;
    // heading rotated left of velocity -> velocity right of nose -> left-hand drift (beta < 0)
    var hd = q.heading + b;
    var car = { id: 'player', isPlayer: true, x: q.x, y: q.y, heading: hd, vx: Math.cos(q.heading) * v, vy: Math.sin(q.heading) * v,
      speed: v, s: q.s, lateral: 0, onTrack: true, offTrack: false };
    i += v / 60 / geom.ds;
    var st = sc.update(car, 1 / 60, []) || sc.state();
    var sn = { t: step / 60, trackLength: geom.length, playerId: 'player', cars: [car] };
    h.tick(ctx, sn, st, null, 1000 / 60);
    var pops = h.debugState().popups;
    if (pops.some(function (p) { return p.big && p.points > 0 && !/^\+/.test(p.text) && !/×.*×/.test(p.text); })) sawBank = true;
  }
  var fin = sc.state();
  assert.ok(fin.total > 0, 'scorer produced points: ' + fin.total);
  assert.ok(sawBank, 'bank popup shown with cleaned text');
  assert.ok(h.debugState().dispTotal > 0);
  assert.ok(h.debugState().angle < 1 && h.debugState().angle > -40);
});

test('session snapshot (snap.drift) drives the timer, tandem gauge and assist fallback', function () {
  var sn = snap({ raceTime: 40, drift: { timeLeft_s: 54.2, duration_s: 90, elapsed_s: 35.8,
    tandem: { leadId: 'ai1', gap_m: 5.5, dist_m: 6.4, ahead: false }, assist: { level: 'heavy', phase: 'drift', beta_deg: -30, targetAngle_deg: -32 } } });
  var t = I.timerInfo({ t: 99 }, sn, { duration_s: 120 });
  assert.ok(t.remaining); assert.strictEqual(t.t, 54.2); assert.ok(Math.abs(t.frac - 54.2 / 90) < 1e-9);
  var free = I.timerInfo({}, snap({ drift: { timeLeft_s: null, duration_s: 0, elapsed_s: 12.5 } }), {});
  assert.ok(!free.remaining); assert.strictEqual(free.t, 12.5);
  var td = I.tandemInfo({ tandem: true, tandemDist_m: 9 }, sn, sn.cars[0]);
  assert.strictEqual(td.dist, 6.4); assert.strictEqual(td.ahead, true); assert.strictEqual(td.band, 'close');
  // session ahead:true = PLAYER ahead of the lead -> "passed" band
  var passed_ = I.tandemInfo({}, snap({ drift: { tandem: { gap_m: -3, dist_m: 3.5, ahead: true } } }), sn.cars[0]);
  assert.strictEqual(passed_.ahead, false); assert.strictEqual(passed_.band, 'ahead');
  var h = clockHud({ mode: 'tandem' }); var ctx = fakeCtx();
  h.tick(ctx, sn, scorer({ timeLeft_s: undefined }), null);
  assert.ok(ctx.texts.indexOf('0:54.2') >= 0, 'session time left shown');
  assert.ok(ctx.texts.indexOf('6.4 m') >= 0, 'session tandem distance shown');
  assert.ok(ctx.texts.some(function (x) { return /ANGLE HOLD/.test(x); }), 'assist chip from snap.drift.assist');
});

test('scorer driftHealth drives the SAVE IT fuse', function () {
  var h = clockHud(); var ctx = fakeCtx();
  for (var i = 0; i < 10; i++) h.tick(ctx, snap(), scorer({ driftHealth: 1, angle_deg: 35 }));
  assert.strictEqual(h.debugState().grace, 0);
  for (i = 0; i < 10; i++) h.tick(ctx, snap(), scorer({ driftHealth: 0.5, angle_deg: 35 }));
  assert.ok(h.debugState().grace > 0.08);
  var c2 = fakeCtx(); h.tick(c2, snap(), scorer({ driftHealth: 0.4, angle_deg: 35 }));
  assert.ok(c2.texts.join('').indexOf('SAVE IT!') >= 0);
});

test('event kinds from the real scorer (wall-close, scrape, combo) classify sensibly; MAX COMBO not doubled', function () {
  assert.strictEqual(I.classifyEvent('CLOSE TO WALL!', null, 'wall-close').kind, 'wall');
  assert.strictEqual(I.classifyEvent('WALL SCRAPE', null, 'scrape').kind, 'wall');
  assert.strictEqual(I.classifyEvent('×3 COMBO!', null, 'combo').kind, 'bonus');
  assert.strictEqual(I.classifyEvent('MANJI ×3!', 600, 'manji').kind, 'swing');
  var h = clockHud(); var ctx = fakeCtx();
  h.tick(ctx, snap(), scorer({ multiplier: 4.9 }));
  h.tick(ctx, snap(), scorer({ multiplier: 5, lastEvent: { text: 'MAX COMBO ×5!', kind: 'combo', seq: 9, t: 1 } }));
  var mc = h.debugState().popups.filter(function (p) { return /MAX COMBO/.test(p.text); });
  assert.strictEqual(mc.length, 1, JSON.stringify(mc));
});

test('small callouts are capped so the stack never covers the car', function () {
  var h = clockHud(); var ctx = fakeCtx();
  var evs = ['SWING!', 'TANDEM!', 'LONG DRIFT!', 'FAST ENTRY 90 KM/H', 'PERFECT ANGLE 40°', 'CLOSE TO WALL!'].map(function (t, i) { return { id: i + 1, text: t, points: 100 }; });
  h.tick(ctx, snap(), scorer({ events: evs }));
  var c2 = fakeCtx(); h.tick(c2, snap(), scorer({ events: evs }));
  var shown = evs.filter(function (e) { return c2.texts.some(function (x) { return x.indexOf(e.text.toUpperCase()) === 0; }); });
  assert.ok(shown.length <= 3 && shown.length >= 1, 'shown ' + shown.length);
});

test('projectThrough: pinhole projection in renderer3d GL axes; rendererProjector uses getCameraState', function () {
  // camera 10 m behind (sim -x) looking along +x, GL up +Y
  var cam = { eye: [-10, 2, 0], target: [0, 2, 0], up: [0, 1, 0], fov: 60, near: 0.1 };
  var c = I.projectThrough(cam, 1000, 500, 0, 0, 2);
  assert.ok(Math.abs(c.x - 500) < 1e-6 && Math.abs(c.y - 250) < 1e-6 && c.visible);
  var left = I.projectThrough(cam, 1000, 500, 0, 3, 2);    // sim +y = left of a car heading +x
  assert.ok(left.x < 500, 'sim +y projects left: ' + left.x);
  var up = I.projectThrough(cam, 1000, 500, 0, 0, 4);
  assert.ok(up.y < 250);
  assert.strictEqual(I.projectThrough(cam, 1000, 500, -20, 0, 2), null, 'behind camera');
  var near = I.projectThrough(cam, 1000, 500, 0, 0, 2), far = I.projectThrough(cam, 1000, 500, 90, 0, 2);
  assert.ok(near.scale > far.scale);
  var fakeR = { getCameraState: function () { return cam; }, _debug: function () { return { S: { world: { groundY: function () { return 1.7; } } } }; } };
  var proj = I.rendererProjector(fakeR, fakeCanvas(1000, 500));
  var p = proj(0, 0);
  assert.ok(Math.abs(p.x - 500) < 1e-6 && p.y < 250 + 1e-6, 'uses ground height');
  assert.strictEqual(I.rendererProjector({}, null), null);
  var h = clockHud(); assert.strictEqual(h.attachRenderer(fakeR), true);
  var ctx = fakeCtx();
  h.tick(ctx, snap(), scorer({ zones: [{ id: 'a', s: 150, length: 20, side: 'left', kind: 'inner', x: 30, y: 0 }] }));
  // the visible 3D marker replaces the screen-space chevrons (no "60 m" side label; marker shows distance instead)
  assert.ok(ctx.texts.indexOf('INNER CLIP') >= 0 && ctx.texts.indexOf('50 m') >= 0, ctx.texts.join('|'));
});


/* ---- drift-feel pass: stale pre-drift tips, cockpit docking, ASSIST BRAKING cue, tandem popups */
function posCtx() {
  var c = fakeCtx(), at = [];
  var base = c.fillText;
  c.at = at;
  c.fillText = function (s, x, y) { at.push({ s: String(s), x: x, y: y }); base(s); };
  return c;
}
test('pre-drift coach tips (KICK IT SIDEWAYS / speed / chain) drop the moment a drift starts', function () {
  assert.strictEqual(I.staleWhileDrifting({ id: 'start' }, true), true);
  assert.strictEqual(I.staleWhileDrifting({ id: 'start' }, false), false);
  assert.strictEqual(I.staleWhileDrifting({ id: 'zone' }, true), false);
  var h = clockHud(); var ctx = fakeCtx();
  var kick = { id: 'start', text: 'TAP ← OR → WITH ↑ TO KICK IT SIDEWAYS', tone: 'info' };
  for (var i = 0; i < 40; i++) h.tick(ctx, snap(), scorer({ coach: kick, drifting: false, current: 0, angle_deg: 2 }));
  assert.strictEqual(h.debugState().coachId, 'start');
  // the scorer still reports the tip for a frame or two after the slide starts: the HUD drops it at once
  h.tick(ctx, snap(), scorer({ coach: kick, drifting: true, angle_deg: 36 }));
  assert.notStrictEqual(h.debugState().coachId, 'start', 'stale tip still shown while drifting');
  // the session's live fx flag alone is enough (scorer lagging a frame)
  var h2 = clockHud(); var c2 = fakeCtx();
  for (var j = 0; j < 40; j++) h2.tick(c2, snap(), scorer({ coach: kick, drifting: false, current: 0, angle_deg: 2 }));
  h2.tick(c2, snap({ drift: { fx: { drifting: true } } }), scorer({ coach: kick, drifting: false, current: 0, angle_deg: 20 }));
  assert.notStrictEqual(h2.debugState().coachId, 'start');
});
test('cockpit camera: the drift panel docks at the top (steering wheel + cluster stay visible); setCameraMode', function () {
  function speedY(mode) {
    var h = clockHud(); var ctx = posCtx();
    if (mode) assert.strictEqual(h.setCameraMode(mode), mode === 'cockpit' ? 'interior' : 'chase');
    for (var i = 0; i < 5; i++) h.tick(ctx, snap(), scorer());
    var e = ctx.at.filter(function (a) { return /KM\/H/.test(a.s); }).pop();
    return { y: e ? e.y : null, view: h.debugState().view };
  }
  var ch = speedY('chase'), ck = speedY('cockpit');
  assert.strictEqual(ck.view, 'interior'); assert.strictEqual(ch.view, 'chase');
  assert.ok(ch.y > 800 * 0.6, 'chase panel at the bottom: ' + ch.y);
  assert.ok(ck.y < 800 * 0.45, 'cockpit panel docked up top: ' + ck.y);
  // the renderer's camera (attachRenderer) is still honoured when no explicit mode is set
  var h3 = clockHud(); h3.setCameraMode(null);
  h3.setProjector({ getCamera: function () { return 'hood'; } });
  h3.tick(fakeCtx(), snap(), scorer());
  assert.strictEqual(h3.debugState().view, 'interior');
});
test('ASSIST BRAKING cue when the lock brakes with Up held (not while drifting)', function () {
  var h = clockHud(); var ctx = fakeCtx();
  h.tick(ctx, snap(), scorer({ drifting: false, current: 0, angle_deg: 1 }), { level: 'heavy', phase: 'grip', assistBraking: true });
  assert.strictEqual(h.debugState().brakeCue, true);
  assert.ok(ctx.texts.join('').indexOf('ASSISTBRAKING') >= 0 || ctx.texts.join('|').indexOf('ASSIST BRAKING') >= 0, 'cue drawn');
  var h2 = clockHud();
  h2.tick(fakeCtx(), snap(), scorer({ drifting: true }), { level: 'heavy', phase: 'drift', assistBraking: true });
  assert.strictEqual(h2.debugState().brakeCue, false);
  assert.strictEqual(I.assistPhase(I.readAssist({ phase: 'grip', assistBraking: true })).id, 'brake');
  assert.strictEqual(I.assistPhase(I.readAssist({ phase: 'recover', exiting: true })).id, 'exit', 'a soft exit is not an ASSIST CATCH');
});
test('tandem: at most 2 popups visible, anchored to the side, faster fade', function () {
  var evs = [{ id: 1, text: 'GOOD DRIFT', points: 2246 }, { id: 2, text: 'KEEP IT LIT', points: 0 }, { id: 3, text: 'LONG DRIFT', points: 300 }, { id: 4, text: 'SWING ZONE', points: 500 }];
  function runPops(tandem) {
    var h = clockHud(tandem ? { mode: 'tandem' } : {}); var ctx = posCtx();
    var st = scorer(tandem ? { events: evs, tandem: { distance_m: 8 } } : { events: evs });
    h.tick(ctx, snap(), st);
    for (var i = 0; i < 20; i++) h.tick(ctx, snap(), st);
    var shown = h.debugState().popsShown;
    for (var j = 0; j < 80; j++) h.tick(ctx, snap(), st);       // ~1.6 s after the burst
    return { shown: shown, later: h.debugState().popsShown, ctx: ctx };
  }
  var td = runPops(true), fr = runPops(false);
  assert.ok(td.shown >= 1 && td.shown <= 2, 'tandem shown ' + td.shown);
  assert.ok(fr.shown >= td.shown, 'free run shows ' + fr.shown);
  assert.ok(td.later === 0 && fr.later > 0, 'tandem fades sooner: ' + td.later + ' vs ' + fr.later);
});

if (standalone) console.log(passed + ' drift-hud tests passed');

/* Node tests for js/race/hud.js — run: node tests/race-hud.test.js */
'use strict';
var assert = require('assert');
var path = require('path');
var hud = require(path.join(__dirname, '..', 'js', 'race', 'hud.js'));
var I = hud._internal;
var passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

/** A canvas 2D context stub that accepts every call and records fillText. */
function fakeCtx() {
  var texts = [];
  var grad = { addColorStop: function () {} };
  var target = {
    texts: texts,
    measureText: function (s) { return { width: String(s).length * 7 }; },
    fillText: function (s) { texts.push(String(s)); },
    createLinearGradient: function () { return grad; },
    createRadialGradient: function () { return grad; }
  };
  return new Proxy(target, {
    get: function (t, k) { return k in t ? t[k] : function () {}; },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}

function oval(n) {
  var pts = [];
  for (var i = 0; i < n; i++) {
    var a = i / n * Math.PI * 2;
    pts.push({ x: Math.cos(a) * 400, y: Math.sin(a) * 200, s: 0 });
  }
  var acc = 0;
  for (var j = 1; j < n; j++) { acc += Math.hypot(pts[j].x - pts[j - 1].x, pts[j].y - pts[j - 1].y); pts[j].s = acc; }
  return { samples: pts, length: acc + Math.hypot(pts[0].x - pts[n - 1].x, pts[0].y - pts[n - 1].y) };
}

function snap(over) {
  var cars = [];
  for (var i = 0; i < 8; i++) {
    cars.push({
      id: 'c' + i, isPlayer: i === 2, name: 'Driver Number' + i, number: 10 + i, color: '#ff' + (i * 11 % 100 + 10) + '20',
      x: Math.cos(i) * 400, y: Math.sin(i) * 200, heading: i, speed: 50, rpm: 6000 + i * 100, redline: 7500, gear: 4, maxGear: 7,
      throttle: 0.8, brake: 0, lap: 1, s: 900 - i * 40, position: i + 1, currentLap_s: 30.5, lastLap_s: 61.2, bestLap_s: 60.9,
      sectors: [20.1, null, null], lastSectors: [20.3, 20.5, 20.4], bestSectors: [20.1, 20.4, 20.2],
      gapAhead_s: i ? 0.8 : null, gapLeader_s: i * 0.8, penalties_s: 0, trackLimits: 0, lapValid: true,
      build: { tires: { compound: 'slick' } }
    });
  }
  var s = { t: 90, phase: 'racing', countdown: { lightsOn: 0, lightsOut: true }, lapsTotal: 3, mode: 'race', playerId: 'c2',
    fastestLap: { carId: 'c0', time: 60.1 }, cars: cars, events: [], ghost: null, assists: { abs: true, tc: true, autoShift: true } };
  return Object.assign(s, over || {});
}

test('fmtTime', function () {
  assert.strictEqual(I.fmtTime(92.456), '1:32.456');
  assert.strictEqual(I.fmtTime(5.04), '0:05.040');
  assert.strictEqual(I.fmtTime(5.04, { short: true }), '5.040');
  assert.strictEqual(I.fmtTime(null), '-:--.---');
});
test('fmtDelta / fmtGap', function () {
  assert.strictEqual(I.fmtDelta(-0.1234), '-0.123');
  assert.strictEqual(I.fmtDelta(1.5), '+1.500');
  assert.strictEqual(I.fmtGap(1.234, 0), '+1.234');
  assert.strictEqual(I.fmtGap(5, 2), '+2 LAPS');
});
test('sectorClass purple/green/yellow', function () {
  assert.strictEqual(I.sectorClass(20, 20, 20), 'purple');
  assert.strictEqual(I.sectorClass(20.5, 20.5, 20), 'green');
  assert.strictEqual(I.sectorClass(21, 20.5, 20), 'yellow');
  assert.strictEqual(I.sectorClass(null, 1, 1), null);
});
test('shiftLights progression and blue flash', function () {
  assert.strictEqual(I.shiftLights(1000, 7000, 10).lit, 0);
  var mid = I.shiftLights(6000, 7500, 10);
  assert.ok(mid.lit > 0 && mid.lit < 10 && !mid.flash);
  var top = I.shiftLights(7400, 7500, 10);
  assert.ok(top.flash && top.lit === 10 && top.colors.every(function (c) { return c === '#2f8bff'; }));
});
test('extractGeom handles sample objects, sectors and fallbacks', function () {
  var g = oval(300);
  var G = I.extractGeom(g, null);
  assert.strictEqual(G.pts.length, 300);
  assert.ok(Math.abs(G.sectors[1] - g.length / 3) < 1e-6);
  var G2 = I.extractGeom(Object.assign({}, g, { sectors: [{ start: 0, end: 500 }, { start: 500, end: 900 }, { start: 900, end: g.length }] }));
  assert.deepStrictEqual(G2.sectors, [0, 500, 900]);
  var G3 = I.extractGeom({}, { points: [[0, 0], [100, 0], [100, 100], [0, 100]] });
  assert.strictEqual(G3.pts.length, 4);
  assert.ok(G3.length > 390);
});
test('fitTransform keeps track inside box', function () {
  var G = I.extractGeom(oval(200));
  var T = I.fitTransform(G.pts, 200, 150, 10);
  G.pts.forEach(function (p) {
    var m = I.mapPoint(T, p[0], p[1]);
    assert.ok(m[0] >= 9 && m[0] <= 191 && m[1] >= 9 && m[1] <= 141, 'point out of box ' + m);
  });
});
test('traceAt interpolates', function () {
  assert.strictEqual(I.traceAt([[0, 0], [100, 10]], 50), 5);
});
test('draw runs for all phases/modes and shows key text', function () {
  var canvas = { clientWidth: 1280, clientHeight: 720 };
  var h = hud.create(canvas, oval(400), { name: 'Redline Ring' }, { units: 'kph' });
  var ctx = fakeCtx();
  h.draw(ctx, snap({ phase: 'countdown', countdown: { lightsOn: 3, lightsOut: false } }));
  h.draw(ctx, snap());
  assert.ok(ctx.texts.indexOf('P3') >= 0, 'position');
  assert.ok(ctx.texts.indexOf('/8') >= 0, 'field size');
  assert.ok(ctx.texts.indexOf('KM/H') >= 0, 'units');
  h.setUnits('mph');
  ['time-trial', 'practice'].forEach(function (m) {
    h.draw(ctx, snap({ mode: m, ghost: { x: 390, y: 20, heading: 1 } }));
  });
  assert.ok(ctx.texts.indexOf('MPH') >= 0);
  // mobile
  var small = hud.create({ clientWidth: 380, clientHeight: 700 }, oval(100), null, {});
  small.draw(fakeCtx(), snap());
  h.destroy();
});
test('short phone landscape: tach becomes a bottom bar clear of the car, inside the touch band; desktop unchanged', function () {
  var SL = I.stripLayout;
  // only on touch, short (H <= 500), landscape screens
  assert.strictEqual(SL(1366, 768, { touch: true }), null, 'desktop size');
  assert.strictEqual(SL(844, 390, { touch: false }), null, 'no touch -> normal layout');
  assert.strictEqual(SL(390, 844, { touch: true }), null, 'portrait');
  [[844, 390, 16 + 287, 610], [667, 375, 16 + 227, 455], [932, 430, 16 + 260, 718]].forEach(function (c) {
    var W = c[0], H = c[1], band = { l: c[2], r: c[3] };
    var r = SL(W, H, { touch: true, band: band, bottom: 10 });
    assert.ok(r, W + 'x' + H + ' strip');
    assert.ok(r.x >= band.l && r.x + r.w <= band.r, W + 'x' + H + ' inside the band ' + JSON.stringify(r));
    assert.strictEqual(r.y + r.h, H - 10, 'bottom aligned with the touch controls');
    assert.ok(r.y > H * 0.8, 'below the chase-cam car (bottom fifth)');
    assert.ok(r.h >= 34 && r.h <= 46 && r.w >= 132);
  });
  // drawing: the bar replaces the round tach (no 'x1000 RPM' label), lap sectors are dropped, speed still shown
  var phone = hud.create({ clientWidth: 844, clientHeight: 390 }, oval(200), null, { units: 'kph' });
  phone.setLayout({ touch: true, band: { l: 303, r: 610 }, bottom: 10 });
  var c1 = fakeCtx(); phone.draw(c1, snap());
  assert.ok(c1.texts.indexOf('x1000 RPM') < 0 && c1.texts.indexOf('KM/H') >= 0, 'bar cluster');
  assert.ok(c1.texts.indexOf('S2') < 0 && c1.texts.indexOf('LAST') < 0, 'slim timing');
  assert.ok(hud.strip && hud.strip.y + hud.strip.h === 380, 'strip rect published for the arcade nitro gauge');
  var desk = hud.create({ clientWidth: 844, clientHeight: 390 }, oval(200), null, { units: 'kph' });
  var c2 = fakeCtx(); desk.draw(c2, snap());
  assert.ok(c2.texts.indexOf('x1000 RPM') >= 0 && c2.texts.indexOf('LAST') >= 0 && c2.texts.indexOf('S2') >= 0, 'no touch: the classic compact cluster');
  assert.strictEqual(hud.strip, null);
});
test('banners fire from state diffs', function () {
  var h = hud.create({ clientWidth: 1280, clientHeight: 720 }, oval(400), null, {});
  var ctx = fakeCtx();
  h.draw(ctx, snap());
  var s2 = snap();
  s2.cars[2].trackLimits = 2; s2.cars[2].lap = 2; s2.cars[2].lastLap_s = 60.0; s2.cars[2].bestLap_s = 60.0;
  s2.cars[2].penalties_s = 5;
  s2.fastestLap = { carId: 'c2', time: 60.0 };
  h.draw(ctx, s2);
  var s3 = snap(); s3.cars[2].wrongWay = true; s3.cars[2].lap = 2; s3.cars[2].trackLimits = 2; s3.cars[2].penalties_s = 5;
  s3.fastestLap = s2.fastestLap;
  ctx = fakeCtx();
  h.draw(ctx, s3);
  var all = ctx.texts.join('|');
  ['TRACK LIMITS (2/3)', 'FINAL LAP', '+5s PENALTY', 'FASTEST LAP', 'WRONG WAY'].forEach(function (t) {
    assert.ok(all.indexOf(t) >= 0, 'missing banner ' + t + ' in ' + all);
  });
  var s4 = snap(); s4.cars[2].finished = true; s4.cars[2].lap = 3; s4.cars[2].trackLimits = 2; s4.cars[2].penalties_s = 5;
  s4.fastestLap = s2.fastestLap;
  ctx = fakeCtx(); h.draw(ctx, s4);
  assert.ok(ctx.texts.join('|').indexOf('FINISH — P3') >= 0);
});
test('events: jumpstart', function () {
  var h = hud.create({ clientWidth: 1280, clientHeight: 720 }, oval(400), null, {});
  var ctx = fakeCtx();
  h.draw(ctx, snap({ events: [{ type: 'jumpstart', carId: 'c2', value: 5 }] }));
  assert.ok(ctx.texts.indexOf('JUMP START') >= 0);
});
test('draw tolerates empty / garbage snapshots', function () {
  var h = hud.create({ clientWidth: 800, clientHeight: 600 }, null, null, {});
  h.draw(fakeCtx(), {});
  h.draw(fakeCtx(), { cars: [{ isPlayer: true }] });
  h.draw(fakeCtx(), null);
});

test('cockpit view hides the tach / speed cluster (the 3D dash shows it) and restores it after', function () {
  var h = hud.create({ clientWidth: 1366, clientHeight: 768 }, oval(400), null, { units: 'kph' });
  var a = fakeCtx(); h.draw(a, snap());
  assert.ok(a.texts.indexOf('KM/H') >= 0 && a.texts.indexOf('x1000 RPM') >= 0, 'cluster in chase view');
  h.setCockpit(true);
  assert.strictEqual(h.isCockpit(), true);
  var b = fakeCtx(); h.draw(b, snap());
  assert.ok(b.texts.indexOf('KM/H') < 0 && b.texts.indexOf('x1000 RPM') < 0, 'no cluster in cockpit');
  assert.ok(b.texts.indexOf('P3') >= 0, 'tower / position still drawn');
  h.setCockpit(false);
  var c = fakeCtx(); h.draw(c, snap());
  assert.ok(c.texts.indexOf('KM/H') >= 0, 'cluster back');
});

test('tower: position-swap animation never superimposes rows (FLIP order, gainer on top)', function () {
  var step = I.stepRowY, order = I.towerDrawOrder;
  assert.strictEqual(step(undefined, 3, 0.016), 3, 'new rows start in their slot');
  assert.strictEqual(step(0, 9, 0.016), 9, 'huge jumps snap');
  var v = step(4, 3, 0.016);
  assert.ok(v < 4 && v > 3, 'eases toward the slot');
  var x = 4; for (var i = 0; i < 120; i++) x = step(x, 3, 1 / 60);
  assert.strictEqual(x, 3, 'settles exactly (no endless sub-pixel drift)');
  // slots 2<->3 swapping mid-animation: car now in slot 2 came from 3 (gainer), car in slot 3 came from 2 (loser)
  var o = order([0, 1, 2.5, 2.5, 4]);
  assert.deepStrictEqual(Array.prototype.slice.call(o), [0, 1, 4, 3, 2], 'settled first, loser, then gainer last');
  assert.strictEqual(o.moving, 2);
  assert.strictEqual(order([0, 1, 2]).moving, 0);
  // drawing a swap: every moving row paints an opaque backing over the full row height
  var rects = [];
  var c = fakeCtx();
  var h = hud.create(null, oval(64), {}, {});
  var s1 = snap(); h.draw(c, s1);
  var s2 = snap(); s2.cars[3].position = 3; s2.cars[2].position = 4; s2.t = 90.1;
  var cc = fakeCtx();
  var ctx2 = new Proxy({}, { get: function (t, k) { if (k === 'fillRect') return function (x, y, w, hh) { rects.push({ fs: ctx2.fillStyle, y: y, h: hh }); }; return k in t ? t[k] : cc[k]; }, set: function (t, k, v) { t[k] = v; return true; } });
  h.draw(ctx2, s2);
  var opaque = rects.filter(function (r) { return r.fs === '#0c0d11'; });
  assert.strictEqual(opaque.length, 2, 'both swapping rows get an opaque backing');
  assert.ok(opaque[0].h === opaque[1].h && opaque[0].h > 0, 'fixed row height');
});

console.log(passed + ' hud tests passed');

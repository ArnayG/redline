/* Drag first-person cockpit (docs/DRAG-SPEC.md §9): the dash cluster / centre screen switch to drag readouts in drag
   sessions (race sessions keep the race cluster), the drag dash state from a snapshot, the rear-view mirror plan
   (live render target by tier, static tint fallback on low / without render targets), the mirror camera and the
   first-person HUD gauge placement. No WebGL needed. */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
['js/drag/drag-strip.js', 'js/race/gl/cockpit.js', 'js/race/gl/drag-strip-mesh.js', 'js/race/gl/drag-renderer.js', 'js/drag/drag-hud.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, CK = CB.gl.cockpit, DR = CB.drag.renderer, U = DR._, HUD = CB.drag.hud;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('drag-cockpit: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

/** 2D-context stand-in that records every string drawn */
function mockCtx() {
  var texts = [], grad = { addColorStop: function () {} };
  var g = { texts: texts, fillText: function (s) { texts.push(String(s)); }, createLinearGradient: function () { return grad; }, createRadialGradient: function () { return grad; } };
  ['save', 'restore', 'fillRect', 'beginPath', 'arc', 'fill', 'stroke', 'moveTo', 'lineTo', 'arcTo', 'closePath', 'clearRect', 'strokeRect'].forEach(function (k) { g[k] = function () {}; });
  return g;
}
function cluster(st) { var g = mockCtx(); CK.drawCluster(g, 1024, 390, st, { accent: '#c8a24a' }); return g.texts; }
function screen(st) { var g = mockCtx(); CK.drawCenterScreen(g, 900, 360, st, { accent: '#c8a24a' }, null, []); return g.texts; }

var DIST = { id: 'quarter', name: '1/4 mile', m: 402.336 };
function lane(o) {
  return Object.assign({ lane: 0, name: 'You', isPlayer: true, x: 0, speed: 0, rpm: 3000, redline: 7000, gear: 1, maxGear: 6, preStaged: true, staged: true, deep: false,
    red: false, rt: null, et: null, trap: null, left: false, finished: false, splits: [], launch: { held: true, rpm: 3000, lo: 2600, hi: 3400, best: 3000, ev: false, lc: false },
    shiftLight: { level: 0, flash: false } }, o || {});
}
function snap(o) {
  return Object.assign({ t: 10, phase: 'staging', distance: DIST, playerLane: 0, winner: null,
    tree: { armed: false, lanes: [{ preStage: true, stage: true, amber: [false, false, false], green: false, red: false }, {}], greenT: [null, null], flag: null } }, o || {});
}

test('race cluster unchanged: lap / best / gap readouts, no drag panels', function () {
  var t = cluster({ speed: 40, rpm: 5000, redline: 7500, gear: 3, lap: 1, lapsTotal: 5, position: 2, count: 8, lapTime: 61.2, lastLap: 62, bestLap: 60.5, gapAhead: 0.8 });
  ['LAST', 'BEST', 'GAP'].forEach(function (k) { assert.ok(t.indexOf(k) >= 0, 'race shows ' + k); });
  assert.ok(t.indexOf('STAGE') < 0 && t.indexOf('ELAPSED') < 0, 'no drag panels in race mode');
  assert.ok(screen({ lap: 1, lapsTotal: 5 }).indexOf('REDLINE') >= 0, 'race centre screen');
  assert.strictEqual(CK.dragKey(null, 0), '', 'race refresh keys untouched');
});

test('drag cluster while staged: staging lamps, tree status, launch band, gear + rpm; no lap readouts', function () {
  var s = snap(), d = U.dragDash(lane(), s, null);
  assert.ok(d.pre && d.preStage && d.stage && !d.green && !d.red);
  assert.deepStrictEqual(d.band && [d.band.lo, d.band.hi], [2600, 3400], 'launch band for a non-LC car');
  var t = cluster({ speed: 0, rpm: 3000, redline: 7000, gear: 1, maxGear: 6, drag: d });
  ['PRE', 'STAGE', 'STAGED', 'LAUNCH', '2.6–3.4k', '1', 'RPM'].forEach(function (k) { assert.ok(t.indexOf(k) >= 0, 'staged dash shows ' + k + ' (' + t.join(',') + ')'); });
  ['LAST', 'BEST', 'GAP', 'ELAPSED'].forEach(function (k) { assert.ok(t.indexOf(k) < 0, 'no ' + k + ' while staging'); });
  // tree running: status follows the lamps
  var s2 = snap({ phase: 'tree', tree: { armed: true, lanes: [{ preStage: true, stage: true, amber: [true, true, true], green: false, red: false }, {}], greenT: [10.4, 10.4] } });
  var d2 = U.dragDash(lane(), s2, null);
  assert.deepStrictEqual(d2.amber, [true, true, true]);
  assert.ok(cluster({ rpm: 3000, redline: 7000, gear: 1, drag: d2 }).indexOf('WATCH TREE') >= 0);
  // launch control / EV: no band, mode label instead
  var d3 = U.dragDash(lane({ launch: { held: true, lc: true, lo: 0, hi: 0 } }), s, null);
  assert.strictEqual(d3.band, null);
  assert.ok(cluster({ rpm: 4000, redline: 7000, gear: 1, drag: d3 }).indexOf('2-STEP ON') >= 0);
  assert.notStrictEqual(CK.dragKey(d, 0), CK.dragKey(d2, 0), 'refresh key follows the tree lamps');
});

test('drag cluster on the run: live elapsed ET from the green + RT, speed; after: ET / trap / result', function () {
  var gT = 10.4, s = snap({ t: 14.4, phase: 'run', tree: { armed: true, lanes: [{ stage: false, amber: [false, false, false], green: true }, {}], greenT: [gT, gT] } });
  var me = lane({ staged: false, preStaged: false, left: true, rt: 0.25, speed: 50, launch: { held: false, lo: 2600, hi: 3400 } });
  var d = U.dragDash(me, s, lane({ lane: 1, isPlayer: false }));
  assert.ok(!d.pre && d.live && !d.final);
  assert.ok(Math.abs(d.et - (14.4 - gT - 0.25)) < 1e-9, 'ET clock = t - green - RT');
  var t = cluster({ speed: 50, rpm: 6000, redline: 7000, gear: 3, units: 'mph', drag: d });
  ['ELAPSED', '3.75', 'R/T', '0.250', 'MPH', '112'].forEach(function (k) { assert.ok(t.indexOf(k) >= 0, 'run dash shows ' + k + ' (' + t.join(',') + ')'); });
  assert.ok(t.indexOf('PRE') < 0 && t.indexOf('LAST') < 0);
  // finished + decided
  var s2 = snap({ t: 22, phase: 'shutdown', winner: 0, tree: s.tree });
  var fin = lane({ left: true, finished: true, rt: 0.25, et: 11.012, trap: 58.1, splits: [{ id: '60ft', label: '60 ft', t: 1.75 }] });
  var opp = lane({ lane: 1, isPlayer: false, name: 'Rival', finished: true, rt: 0.3, et: 11.9, trap: 54, splits: [{ id: '60ft', label: '60 ft', t: 1.9 }] });
  var dw = U.dragDash(fin, s2, opp);
  assert.ok(dw.final && dw.result === 'win' && !dw.live);
  var tw = cluster({ speed: 20, rpm: 3000, redline: 7000, gear: 2, units: 'mph', drag: dw });
  ['ET', '11.012', 'TRAP MPH', '130.0', 'WIN'].forEach(function (k) { assert.ok(tw.indexOf(k) >= 0, 'post-run dash shows ' + k + ' (' + tw.join(',') + ')'); });
  assert.strictEqual(U.dragDash(opp, s2, fin).result, 'loss');
  assert.strictEqual(U.dragDash(fin, s2, null).result, 'solo', 'solo pass');
  assert.strictEqual(U.dragDash(fin, s2, null).opp, null);
  // centre screen: timeslip rows for both lanes
  var sc = screen({ units: 'mph', drag: dw });
  ['TIMESLIP', 'R/T', '60 FT', 'ET', '11.012', '11.900', 'RIVAL'].forEach(function (k) { assert.ok(sc.indexOf(k) >= 0, 'timeslip shows ' + k + ' (' + sc.join(',') + ')'); });
  // red light: the lamp + status
  var dr = U.dragDash(lane({ red: true }), snap({ phase: 'tree', tree: { armed: true, lanes: [{ red: true, amber: [true, false, false] }, {}], greenT: [11, 11] } }), null);
  assert.ok(dr.red && cluster({ rpm: 3000, redline: 7000, gear: 1, drag: dr }).indexOf('RED LIGHT') >= 0);
});

test('mirror plan: live by tier (size / cadence), static tint on low or without render targets', function () {
  var hi = U.mirrorPlan('high', { cockpit: true, fbo: true, aspect: 3.47 });
  assert.ok(hi.live && !hi.fallback && hi.every === 1 && hi.w === 256, JSON.stringify(hi));
  assert.ok(hi.h % 8 === 0 && hi.h >= 24 && hi.h <= 96, 'height from the glass aspect, multiple of 8: ' + hi.h);
  var med = U.mirrorPlan('medium', { cockpit: true, aspect: 3.47 });
  assert.ok(med.live && med.every === 2 && med.w < hi.w, JSON.stringify(med));
  var lo = U.mirrorPlan('low', { cockpit: true, fbo: true });
  assert.ok(!lo.live && lo.fallback && lo.reason === 'tier');
  var nofbo = U.mirrorPlan('high', { cockpit: true, fbo: false });
  assert.ok(!nofbo.live && nofbo.fallback && nofbo.reason === 'no-fbo');
  var off = U.mirrorPlan('high', { cockpit: false });
  assert.ok(!off.live && !off.fallback, 'no interior: nothing to do');
  assert.ok(U.mirrorPlan('bogus', { cockpit: true }).live, 'unknown tier = high');
  // every tier has a defined mirror config; render-target pixels stay small
  Object.keys(DR.QUALITY).forEach(function (q) { var p = U.mirrorPlan(q, { cockpit: true, aspect: 2.67 }); assert.ok(!p.live || p.w * p.h <= 320 * 120, q); });
  // cadence
  assert.ok(U.mirrorDue(hi, 7) && U.mirrorDue(hi, 8));
  assert.ok(U.mirrorDue(med, 8) && !U.mirrorDue(med, 9));
  assert.ok(!U.mirrorDue(lo, 0) && !U.mirrorDue(null, 0));
});

test('mirror camera reflects the eye -> glass ray (looks back), horizontally mirrored projection is the renderer\'s job', function () {
  // glass ahead of and above the eye, facing back toward it
  var eye = [0, 1.1, -0.35], m = { pos: [0.55, 1.25, 0], normal: [-0.9, -0.15, -0.4], up: [0, 1, 0], fovY: 17 };
  var v = U.mirrorView(m, eye);
  assert.ok(v.dir[0] < -0.8, 'looks rearward: ' + v.dir);
  assert.ok(Math.abs(Math.hypot(v.dir[0], v.dir[1], v.dir[2]) - 1) < 1e-9);
  assert.deepStrictEqual(v.pos, m.pos);
  assert.strictEqual(v.fov, 17);
  assert.strictEqual(U.mirrorView({ pos: m.pos, normal: m.normal, fovY: 0.3 }, eye).fov, 0.3 / (Math.PI / 180), 'radians accepted');
  var fb = U.mirrorView(null, eye);
  assert.ok(fb.dir[0] < 0 && fb.fov > 0, 'fallback pose still looks back');
});

test('first-person HUD keeps the launch / tyre gauges off the dash cluster (desktop, compact, touch)', function () {
  function overlap(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }
  [[1280, 720, false], [1920, 1080, false], [640, 400, false], [844, 390, true], [740, 360, true]].forEach(function (c) {
    var w = c[0], h = c[1], touch = c[2];
    var Lo = HUD.fpGauges(HUD.layout(w, h, { touch: touch }), w, h, { touch: touch });
    var clusterZone = { x: w * 0.36, y: h * 0.68, w: w * 0.28, h: h * 0.24 };
    ['launch', 'heat'].forEach(function (k) {
      var r = Lo[k];
      assert.ok(r && r.w > 100 && r.x >= 0 && r.x + r.w <= w && r.y >= 0 && r.y + r.h <= h, k + ' on screen at ' + w + 'x' + h);
      assert.ok(!overlap(r, clusterZone), k + ' clear of the cluster at ' + w + 'x' + h);
      if (touch) {
        var T = HUD.touchLayout(w, h, {});
        ['brake', 'throttle', 'up', 'down', 'pause', 'camera'].forEach(function (b) { assert.ok(!overlap(r, T[b]), k + ' clear of ' + b + ' at ' + w + 'x' + h); });
        assert.ok(!overlap(r, Lo.prompt), k + ' clear of the prompt at ' + w + 'x' + h);
      }
    });
    assert.ok(!overlap(Lo.launch, Lo.heat), 'gauges do not overlap each other');
  });
});

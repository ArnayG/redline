/* Drag Racing renderer pure parts (docs/DRAG-SPEC.md): strip / street geometry for every distance + quality, the tree
   bulb layout and light mapping, timing-board text, camera rigs, smoke / wheelie / flagger helpers, feature meshes.
   No WebGL needed. */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
['js/drag/drag-strip.js', 'js/race/gl/drag-strip-mesh.js', 'js/race/gl/drag-renderer.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, DS = CB.gl.dragStrip, DR = CB.drag.renderer, U = DR._, ST = CB.drag.strip;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('drag-render: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
function finite(arr) { for (var i = 0; i < arr.length; i++) if (!isFinite(arr[i])) return false; return true; }
function checkGeo(name, g) {
  assert.ok(g.triangles > 0, name + ' has triangles');
  assert.strictEqual(g.positions.length % 3, 0);
  assert.strictEqual(g.normals.length, g.positions.length, name + ' normals');
  assert.strictEqual(g.colors.length / 4, g.positions.length / 3, name + ' colours (rgba per vertex)');
  assert.ok(finite(g.positions) && finite(g.normals) && finite(g.colors), name + ' finite');
  var n = g.positions.length / 3;
  for (var i = 0; i < g.indices.length; i++) if (g.indices[i] >= n) throw new Error(name + ' index out of range');
  if (n > 65535) assert.ok(g.indices instanceof Uint32Array, name + ' uses 32-bit indices when needed');
}

test('strip + street geometry builds for every distance and quality (finite, indexed, deterministic)', function () {
  ['strip', 'street'].forEach(function (venue) {
    ST.list().forEach(function (d) {
      ['low', 'high'].forEach(function (q) {
        var r = DS.buildGeometry({ venue: venue, distance: d, quality: q, night: q === 'low' });
        assert.ok(r.stats.total > 1000, venue + ' ' + d.id + ' ' + q + ' has a scene');
        Object.keys(r.groups).forEach(function (k) { checkGeo(venue + '/' + d.id + '/' + q + '/' + k, r.groups[k]); });
        assert.strictEqual(r.opts.length, ST.stripLength(d), 'built to the strip length');
      });
    });
  });
  var a = DS.buildGeometry({ venue: 'strip', distance: 'quarter', quality: 'medium' }), b = DS.buildGeometry({ venue: 'strip', distance: 'quarter', quality: 'medium' });
  assert.strictEqual(a.stats.total, b.stats.total);
  assert.deepStrictEqual(Array.from(a.groups.crowd.positions.slice(0, 60)), Array.from(b.groups.crowd.positions.slice(0, 60)));
});

test('low quality is much lighter than high (crowd LOD) and stays under budget', function () {
  var lo = DS.buildGeometry({ venue: 'strip', distance: 'quarter', quality: 'low' }), hi = DS.buildGeometry({ venue: 'strip', distance: 'quarter', quality: 'high' });
  assert.ok(lo.stats.total < hi.stats.total * 0.4, lo.stats.total + ' vs ' + hi.stats.total);
  assert.ok(lo.stats.total < 60000, 'phone budget');
  assert.ok(hi.stats.total < 260000, 'desktop budget');
  var sl = DS.buildGeometry({ venue: 'street', distance: 'quarter', quality: 'low' });
  assert.ok(sl.stats.total < 90000, 'street phone budget ' + sl.stats.total);
});

test('strip dynamic: tree on the centre line past the start, boards past the finish on both sides, lamps, signs', function () {
  var r = DS.buildGeometry({ venue: 'strip', distance: 'quarter' }), D = r.dynamic, L = ST.get('quarter').m;
  assert.strictEqual(D.tree.x, ST.GEO.TREE_X);
  assert.strictEqual(D.tree.bulbs.length, 18, '2 lanes x (2 pre-stage + 2 stage + 3 amber + green + red)');
  assert.strictEqual(D.boards.length, 2);
  D.boards.forEach(function (b) { assert.ok(b.sim[0] > L && b.sim[0] < L + 60, 'board just past the finish'); assert.ok(b.lane === 0 ? b.sim[1] > ST.GEO.WALL_Y : b.sim[1] < -ST.GEO.WALL_Y, 'board outside its own lane wall'); });
  assert.strictEqual(D.winLights.length, 2);
  assert.ok(D.lamps.length >= 8);
  var labels = D.signs.map(function (s) { return s.label; });
  ["60'", "330'", '1/8', "1000'", 'FINISH'].forEach(function (l) { assert.ok(labels.indexOf(l) >= 0, 'marker ' + l); });
  assert.ok(D.flagger === null);
  var e = DS.buildGeometry({ venue: 'strip', distance: 'eighth' }).dynamic.signs.map(function (s) { return s.label; });
  assert.ok(e.indexOf("1000'") < 0 && e.indexOf('FINISH') >= 0, '1/8 mile strip stops at the 1/8');
});

test('street dynamic: a flagger between the lanes, no tree bulbs, painted START / FINISH, street lamps', function () {
  var D = DS.buildGeometry({ venue: 'street', distance: 'quarter', night: true }).dynamic;
  assert.ok(D.flagger && D.flagger.sim[0] === ST.GEO.TREE_X && D.flagger.sim[1] === 0);
  assert.ok(D.flagger.shoulderL[2] < 0 && D.flagger.shoulderR[2] > 0, 'left shoulder on sim +y (GL -z)');
  assert.strictEqual(D.tree.bulbs.length, 0);
  assert.ok(D.signs.some(function (s) { return s.label === 'START' && s.flat; }));
  assert.ok(D.lamps.length > 10);
});

test('tree layout: lane 0 column on the left (sim +y = GL -z), rows top to bottom, facing the drivers', function () {
  var bl = DS.treeLayout(6);
  bl.forEach(function (b) {
    assert.ok(b.lane === 0 ? b.sim[1] > 0 && b.pos[2] < 0 : b.sim[1] < 0 && b.pos[2] > 0);
    assert.ok(b.sim[0] < 6, 'bulbs on the start-facing side of the housing');
    assert.strictEqual(b.pos[1], b.sim[2]);
  });
  var z = function (k) { return bl.filter(function (b) { return b.lane === 0 && b.kind === k; })[0].sim[2]; };
  assert.ok(z('preStage') > z('stage') && z('stage') > z('amber0') && z('amber0') > z('amber1') && z('amber1') > z('amber2') && z('amber2') > z('green') && z('green') > z('red'));
});

test('bulbLit maps the tree lights object (pre-stage, stage, ambers, green, red)', function () {
  var L = { preStage: true, stage: false, amber: [true, false, true], green: false, red: true };
  assert.strictEqual(DS.bulbLit('preStage', L), true);
  assert.strictEqual(DS.bulbLit('stage', L), false);
  assert.strictEqual(DS.bulbLit('amber0', L), true);
  assert.strictEqual(DS.bulbLit('amber1', L), false);
  assert.strictEqual(DS.bulbLit('amber2', L), true);
  assert.strictEqual(DS.bulbLit('green', L), false);
  assert.strictEqual(DS.bulbLit('red', L), true);
  assert.strictEqual(DS.bulbLit('green', null), false);
  // with the real tree module, a pro tree's ambers and green light the right bulbs
  try { require(path.join(root, 'js/drag/drag-tree.js')); } catch (e) { /* optional */ }
  var T = CB.drag.tree;
  if (T && T.create) {
    var tr = T.create({ type: 'pro', seed: 3 });
    T.arm(tr, 0);
    var g = tr.greenT[0];
    var before = T.lights(tr, g - 0.2, 0, { preStaged: true, staged: true }), after = T.lights(tr, g + 0.01, 0, { preStaged: true, staged: true });
    assert.ok(DS.bulbLit('amber0', before) && DS.bulbLit('amber2', before) && !DS.bulbLit('green', before), 'pro: all ambers before green');
    assert.ok(DS.bulbLit('green', after) && !DS.bulbLit('amber1', after), 'green, ambers out');
  }
});

test('timing boards: placeholders before a pass, ET / MPH / RED / win after, key changes only on change', function () {
  var b0 = U.boardInfo({ lane: 0 }, null, 'mph');
  assert.strictEqual(b0.et, '--.---'); assert.strictEqual(b0.speed, '---.--'); assert.strictEqual(b0.title, 'LEFT LANE');
  var snap = { winner: 1, distance: ST.get('quarter') };
  var b1 = U.boardInfo({ lane: 1, name: 'Vega', et: 9.8765, trap: 67.5, rt: 0.012 }, snap, 'mph');
  assert.strictEqual(b1.et, '9.877'); assert.strictEqual(b1.speed, (67.5 * 2.236936).toFixed(2)); assert.ok(b1.win); assert.strictEqual(b1.title, 'RIGHT LANE'); assert.strictEqual(b1.rt, '0.012');
  assert.strictEqual(U.boardInfo({ lane: 1, et: 9.8765, trap: 67.5 }, snap, 'kph').speed, (67.5 * 3.6).toFixed(1));
  var red = U.boardInfo({ lane: 0, red: true, rt: -0.031 }, snap, 'mph');
  assert.ok(red.red && !red.win); assert.strictEqual(red.rt, '-0.031');
  assert.notStrictEqual(b0.key, b1.key);
  assert.strictEqual(U.boardInfo({ lane: 1, name: 'Vega', et: 9.8765, trap: 67.5, rt: 0.012 }, snap, 'mph').key, b1.key);
  assert.strictEqual(U.boardInfo({ lane: 0, et: 7.2 }, { distance: ST.get('dig') }, 'mph').speed, '', 'speed races show the time only');
  assert.strictEqual(U.fmtET(123.456), '123.46');
});

test('wheelie pitch, smoke rate, flagger arm, smoke axles', function () {
  assert.strictEqual(U.wheeliePitch(0), 0);
  assert.ok(Math.abs(U.wheeliePitch(1) - 6 * Math.PI / 180) < 1e-9);
  assert.strictEqual(U.wheeliePitch(5), U.wheeliePitch(1), 'clamped');
  assert.strictEqual(U.smokeRate({ smoke: 0 }), 0);
  assert.ok(U.smokeRate({ burnout: true }, 1) > U.smokeRate({ smoke: 0.5 }, 1), 'burnouts smoke hardest');
  assert.ok(U.smokeRate({ smoke: 1 }, 0.45) < U.smokeRate({ smoke: 1 }, 1), 'quality scales the budget');
  assert.ok(U.flagArm('ready') > 2 && U.flagArm('drop') < 1 && U.flagArm(null) < 0.5);
  assert.deepStrictEqual(U.smokeAxles('fwd', { frontAxle: 1.4, rearAxle: -1.3 }).map(function (a) { return a.x; }), [1.4]);
  assert.deepStrictEqual(U.smokeAxles('rwd', { frontAxle: 1.4, rearAxle: -1.3 }).map(function (a) { return a.x; }), [-1.3]);
  assert.strictEqual(U.smokeAxles('awd', null).length, 2);
});

test('chase rig: behind and above the car; staging frames the tree only while it is ahead', function () {
  var pose = { pos: [-2, 0, -3.1], fwd: [1, 0, 0], up: [0, 1, 0] }, tree = [6, 2.2, 0];
  var r0 = U.chaseEye(pose, {}, 0, tree, -1), r1 = U.chaseEye(pose, {}, 1, tree, -1);
  assert.ok(r0.eye[0] < pose.pos[0] - 5 && r0.eye[1] > 1.5);
  assert.ok(r1.target[2] > r0.target[2], 'staging pulls the aim toward the tree (centre line)');
  assert.ok(r1.eye[2] < r0.eye[2], 'left lane: eye swings to the outer (sim +y = GL -z) side');
  var far = { pos: [300, 0, -3.1], fwd: [1, 0, 0], up: [0, 1, 0] };
  var rf = U.chaseEye(far, {}, 1, tree, -1);
  assert.ok(rf.target[0] > far.pos[0], 'never looks back at the tree once past it');
});

test('side TV camera: on the dolly between the lane and its wall, framing both cars when side by side', function () {
  var st = {}, car = [50, 0, -3.1], opp = [52, 0, 3.1];
  var s = U.sideEye(st, car, 1, opp, 0.016, 3.1);
  assert.ok(-s.eye[2] > 3.1 && -s.eye[2] < 7.6, 'inside the left wall, outside the lane');
  assert.ok(s.target[2] > car[2] && s.target[2] < opp[2], 'aims between the cars');
  var s2 = U.sideEye({}, car, 1, [200, 0, 3.1], 0.016, 3.1);
  assert.ok(s2.fov < s.fov, 'tighter when alone');
  for (var i = 0; i < 300; i++) s = U.sideEye(st, [50 + i * 0.5, 0, -3.1], 1, null, 1 / 60, 3.1);
  assert.ok(Math.abs(s.eye[0] - (50 + 299 * 0.5)) < 12, 'dolly keeps up with the car');
});

test('feature meshes (bulb, halo, chute, line, box, wheel, arm, flag) are valid geometry', function () {
  var fg = DS.featureMeshGeos();
  ['bulb', 'halo', 'chute', 'line', 'box', 'wheel', 'arm', 'flag'].forEach(function (k) { assert.ok(fg[k], k); checkGeo(k, fg[k]); });
  // parachute canopy: opens toward +X (the car), apex at -X
  var p = fg.chute.positions, minX = 1e9, maxX = -1e9;
  for (var i = 0; i < p.length; i += 3) { minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]); }
  assert.ok(minX < -0.7 && maxX <= 0.01);
});

test('sign geometry carries uvs inside the atlas cells; no DOM -> no atlas (Node safe)', function () {
  assert.strictEqual(DS.signAtlas(['A'], null), null);
  var cells = { "60'": [0, 0, 1, 0.25], FINISH: [0, 0.25, 1, 0.5], START: [0, 0.5, 1, 0.75] };
  var g = DS.signGeometry([{ label: "60'", x: 18, y: 7.95, z: 2, side: 1 }, { label: 'FINISH', x: 400, y: -7.95, z: 2, side: -1 }, { label: 'START', x: -2, y: 3.1, z: 0.01, flat: true }], cells);
  checkGeo('signs', g);
  assert.strictEqual(g.uvs.length / 2, g.positions.length / 3);
  for (var i = 0; i < g.uvs.length; i++) assert.ok(g.uvs[i] >= 0 && g.uvs[i] <= 1);
});

test('renderer API surface and the camera list', function () {
  assert.deepStrictEqual(DR.MODES, ['chase', 'low', 'side', 'bumper', 'cockpit']);
  ['isSupported', 'create', 'createPreview'].forEach(function (k) { assert.strictEqual(typeof DR[k], 'function'); });
  assert.strictEqual(DR.isSupported(), false, 'no WebGL in Node');
});

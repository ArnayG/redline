/* Demolition Derby arenas (docs/DERBY-SPEC.md §2): spawns + pickup spots clear of obstacles / ramps / deadly hazards,
   moving-surface hazards (turntable carry = omega x r, conveyors, pusher kicks once per cycle), kicker ramps reachable,
   rooftop open edges unchanged, dynamic render spec (turntables, pads, pickups, sudden-death ring). */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
['js/derby/derby-arenas.js', 'js/race/gl/gl-core.js', 'js/race/gl/derby-parts.js', 'js/race/gl/derby-arena-mesh.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, A = CB.derby.arenas;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('derby arenas: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
function clearAt(def, x, y, margin) {
  var b = A.sdBoundary(def, x, y);
  if (!(b.d > margin)) return 'outside boundary (' + b.d.toFixed(2) + ')';
  for (var i = 0; i < def.obstacles.length; i++) { var o = def.obstacles[i]; if (A.sdObstacle(o, x, y).d < margin) return 'in obstacle ' + o.id; }
  for (var j = 0; j < def.ramps.length; j++) { var r = def.ramps[j]; if (A.sdBox(r.x, r.y, r.hw, r.hh, r.rot || 0, x, y).d < 0.3) return 'on ramp ' + r.id; }
  var hz = A.hazardAt(def, x, y, 0);
  if (hz.pit || hz.dps > 0) return 'in a deadly hazard';
  for (var k = 0; k < def.hazards.length; k++) { var h = def.hazards[k]; if (h.type === 'crusher' && A.sdBox(h.x, h.y, h.hw, h.hh, h.rot || 0, x, y).d < 1) return 'in the crusher'; }
  return null;
}

test('every arena: 12 spawns clear of walls, obstacles, ramps and deadly hazards', function () {
  A.list().forEach(function (def) {
    assert.ok(def.spawns.length >= 12, def.id);
    def.spawns.forEach(function (s, i) {
      var why = clearAt(def, s.x, s.y, 1.6);
      assert.strictEqual(why, null, def.id + ' spawn ' + i + ': ' + why);
    });
  });
});

test('every arena has >= 5 pickup spots, all reachable (clear) and mostly central', function () {
  A.list().forEach(function (def) {
    var sp = A.pickupSpots(def);
    assert.ok(sp.length >= 5, def.id + ' spots');
    var b = def.bounds, R = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2, central = 0;
    sp.forEach(function (p, i) {
      var why = clearAt(def, p.x, p.y, 1.2);
      assert.strictEqual(why, null, def.id + ' pickup ' + i + ': ' + why);
      if (Math.hypot(p.x, p.y) < R * 0.55) central++;
    });
    assert.ok(central >= sp.length / 2, def.id + ' mostly central (' + central + '/' + sp.length + ')');
  });
});

test('turntables: carry velocity = omega x r inside, zero outside / inside the hub', function () {
  var n = 0;
  A.list().forEach(function (def) {
    def.hazards.filter(function (h) { return h.type === 'turntable'; }).forEach(function (h) {
      n++;
      var rr = ((h.rIn || 0) + h.r) / 2, x = h.x + rr, y = h.y;
      var c = A.hazardAt(def, x, y, 0).carry;
      assert.ok(Math.abs(c.vx - 0) < 1e-9 && Math.abs(c.vy - h.omega * rr) < 1e-9, def.id + ' carry ' + JSON.stringify(c));
      var c2 = A.hazardAt(def, h.x, h.y + rr, 0).carry;
      assert.ok(Math.abs(c2.vx + h.omega * rr) < 1e-9, def.id + ' tangential');
      assert.strictEqual(A.hazardAt(def, h.x + h.r + 0.5, h.y, 0).carry.vy, 0, def.id + ' outside');
      if (h.rIn) assert.strictEqual(A.hazardAt(def, h.x + h.rIn * 0.5, h.y, 0).carry.vy, 0, def.id + ' hub');
    });
  });
  assert.ok(n >= 2, 'turntables in >= 2 arenas');
  ['mud-bowl', 'colosseum'].forEach(function (id) { assert.ok(A.get(id).hazards.some(function (h) { return h.type === 'turntable'; }), id); });
});

test('conveyor carries along its axis; pushers kick once per cycle in the right direction', function () {
  var J = A.get('junkyard'), belt = J.hazards.filter(function (h) { return h.type === 'conveyor'; })[0];
  assert.ok(belt, 'junkyard belt');
  var c = A.hazardAt(J, belt.x, belt.y, 0).carry;
  assert.ok(Math.abs(c.vx - Math.cos(belt.rot) * belt.speed) < 1e-9 && Math.abs(c.vy - Math.sin(belt.rot) * belt.speed) < 1e-9);
  var M = A.get('mud-bowl'), pw = M.hazards.filter(function (h) { return h.id === 'pw0'; })[0];
  var cycles = {}, onT = 0;
  for (var t = 0; t < pw.period * 3; t += 0.01) {
    var hz = A.hazardAt(M, pw.x, pw.y, t);
    if (hz.kick) { onT += 0.01; cycles[hz.kick.cycle] = 1; assert.ok(hz.kick.y < -0.99, 'pw0 pushes toward the centre'); assert.ok(hz.kick.strength > 5); }
  }
  assert.ok(Object.keys(cycles).length >= 3 && onT < pw.period * 3 * 0.15, 'fires briefly each cycle');
  var I = A.get('ice-rink'), zb = I.hazards.filter(function (h) { return h.id === 'zb'; })[0];
  var k = A.hazardAt(I, zb.x + 3, zb.y, 0).kick;
  assert.ok(k && k.x > 0.99, 'out pad pushes radially out');
});

test('kicker ramps: the low end is reachable and the lip is low enough to drive over from behind', function () {
  var n = 0;
  A.list().forEach(function (def) {
    def.ramps.filter(function (r) { return r.kind === 'kicker'; }).forEach(function (r) {
      n++;
      var c = Math.cos(r.rot || 0), s = Math.sin(r.rot || 0);
      var lx = r.x - c * (r.hw + 2), ly = r.y - s * (r.hw + 2);
      assert.strictEqual(clearAt(def, lx, ly, 0.8), null, def.id + ' ' + r.id + ' approach');
      var top = A.heightAt(def, r.x + c * (r.hw - 0.05), r.y + s * (r.hw - 0.05)).z;
      assert.ok(Math.abs(top - r.h) < 0.05, def.id + ' ' + r.id + ' height');
      assert.ok(A.heightAt(def, lx, ly).z === 0, 'ground before the ramp');
    });
  });
  assert.ok(n >= 6, 'kickers: ' + n);
  // centre-launch kickers point at the arena centre
  ['mud-bowl', 'figure-8'].forEach(function (id) {
    A.get(id).ramps.forEach(function (r) {
      var fx = Math.cos(r.rot), fy = Math.sin(r.rot);
      assert.ok(-(r.x * fx + r.y * fy) > 0, id + ' ' + r.id + ' faces the centre');
    });
  });
});

test('rooftop: open edges unchanged, upper deck reachable via the deck ramps', function () {
  var R = A.get('rooftop');
  assert.deepStrictEqual(R.boundary.open, [1, 3]);
  assert.ok(A.sdBoundary(R, 57, 0).open && A.sdBoundary(R, 1, -33).open);
  assert.ok(!A.sdBoundary(R, -57, 0).open);
  assert.ok(Math.abs(A.heightAt(R, -10.2, 20).z - 3.2) < 0.1 && Math.abs(A.heightAt(R, -2, 0).z - 3.2) < 1e-9);
});

test('hazardAt keeps its old fields and is deterministic', function () {
  A.list().forEach(function (def) {
    var h = A.hazardAt(def, 3, 4, 12.3);
    ['grip', 'drag', 'dps', 'ignite', 'crush', 'pit', 'kind', 'carry', 'kick'].forEach(function (k) { assert.ok(k in h, def.id + ' ' + k); });
    assert.deepStrictEqual(A.hazardAt(def, 3, 4, 12.3), h);
  });
  var J = A.get('junkyard'), cr = J.hazards[0], closes = 0;
  for (var t = 0; t < 12; t += 0.05) if (A.crusherClosed(cr, t) > 0.6) closes++;
  assert.ok(cr.period <= 6 && closes > 30, 'crusher is more active');
});

test('dynamic arena spec: turntables rotate, pads fire, pickups bob, sudden-death ring scales', function () {
  var DA = CB.gl.derbyArena, M = A.get('mud-bowl');
  var a = DA.dynamicSpec(M, { t: 0 }, 0), b = DA.dynamicSpec(M, { t: 1 }, 1);
  var ta = a.filter(function (d) { return d.type === 'turntable'; })[0], tb = b.filter(function (d) { return d.type === 'turntable'; })[0];
  assert.ok(Math.abs(tb.yaw - ta.yaw - 0.95) < 1e-9);
  var snap = { t: 2, entities: [{ type: 'pickup', id: 'pk0', kind: 'boost', x: 0, y: 13, z: 0, active: true }, { type: 'pickup', id: 'pk1', kind: 'bomb', x: 1, y: 1, active: false }], suddenDeath: { on: true, safeScale: 0.7, level: 1 } };
  var d = DA.dynamicSpec(M, snap, 2);
  assert.strictEqual(d.filter(function (x) { return x.type === 'pickup'; }).length, 1);
  var ring = d.filter(function (x) { return x.type === 'ring'; })[0];
  assert.ok(ring && Math.abs(ring.s - 0.7) < 1e-9);
  assert.ok(!DA.dynamicSpec(M, { t: 2, suddenDeath: { on: false } }, 2).some(function (x) { return x.type === 'ring'; }));
  // static geometry still builds for every arena with the new hazard decals
  A.list().forEach(function (def) { var g = DA.buildGeometry(def, { quality: 'low' }); assert.ok(g.stats.triangles > 1000 && g.stats.triangles < 120000, def.id); });
});

if (standalone && !process.exitCode) console.log('derby arenas: all ok');

/* Node tests for js/race/tracks.js — run standalone (`node tests/race-tracks.test.js`) or via tests/run.js.
   Checks every catalog circuit independently of tracks.validate(): closed-loop continuity, uniform resampling,
   no self-intersection (except the intentional figure-8 crossing), plausible lengths per circuit type, kerbs in
   corners, racing line inside the track and straighter than the centerline, sectors, grid slots, speed profile
   physics, project() round-trips (with and without hint) and scenery never sitting on the asphalt. */
'use strict';
var assert = require('assert');
var path = require('path');

var T = require(path.join(__dirname, '..', 'js', 'race', 'tracks.js'));
var CB = globalThis.CB;

var G = 9.81;
var standalone = typeof globalThis.test !== 'function' || require.main === module;
var passed = 0, failed = 0;
var test = standalone
  ? function (name, fn) {
    try { fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { failed++; console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
  }
  : globalThis.test;

/* ------------------------------------------------------------------ helpers */

var geoms = {};
function geomOf(def) { return geoms[def.id] || (geoms[def.id] = T.build(def)); }
function wrap(a) { a %= Math.PI * 2; if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; }
function mod(a, n) { return ((a % n) + n) % n; }
function arcDist(a, b, L) { var d = Math.abs(a - b) % L; return Math.min(d, L - d); }
function segX(ax, ay, bx, by, cx, cy, dx, dy) {
  var d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  var d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  var d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  var d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
/** Simple deterministic PRNG so failures are reproducible. */
function rng(seed) {
  var a = seed >>> 0;
  return function () { a = (a + 0x6d2b79f5) >>> 0; var t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Brute-force (bucketed) list of centerline segment crossings between non-adjacent parts of the lap. */
function crossingsOf(g) {
  var S = g.samples, N = S.length, cell = 40, buckets = {}, out = [];
  function key(x, y) { return Math.floor(x / cell) + ',' + Math.floor(y / cell); }
  for (var i = 0; i < N; i++) {
    var a = S[i], b = S[(i + 1) % N];
    var x0 = Math.floor(Math.min(a.x, b.x) / cell), x1 = Math.floor(Math.max(a.x, b.x) / cell);
    var y0 = Math.floor(Math.min(a.y, b.y) / cell), y1 = Math.floor(Math.max(a.y, b.y) / cell);
    for (var cx = x0; cx <= x1; cx++) for (var cy = y0; cy <= y1; cy++) (buckets[cx + ',' + cy] = buckets[cx + ',' + cy] || []).push(i);
  }
  var seen = {};
  Object.keys(buckets).forEach(function (k) {
    var list = buckets[k];
    for (var p = 0; p < list.length; p++) for (var q = p + 1; q < list.length; q++) {
      var i = list[p], j = list[q];
      if (arcDist(i, j, N) < 3) continue;
      var id = Math.min(i, j) + ':' + Math.max(i, j);
      if (seen[id]) continue;
      seen[id] = 1;
      var a = S[i], b = S[(i + 1) % N], c = S[j], d = S[(j + 1) % N];
      if (segX(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y)) out.push({ i: i, j: j, x: a.x, y: a.y });
    }
  });
  void key;
  return out;
}
/** Min distance from point to the centerline polyline, with the sample it belongs to. */
function nearestCenter(g, x, y) {
  var S = g.samples, N = S.length, best = Infinity, bi = -1;
  for (var i = 0; i < N; i++) {
    var a = S[i], b = S[(i + 1) % N];
    var ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey || 1;
    var t = Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey) / l2));
    var px = a.x + ex * t - x, py = a.y + ey * t - y, d = px * px + py * py;
    if (d < best) { best = d; bi = t < 0.5 ? i : (i + 1) % N; }
  }
  return { dist: Math.sqrt(best), index: bi };
}
function footprint(o) {
  if (o.shape === 'circle') {
    var pts = [[o.x, o.y]];
    for (var k = 0; k < 8; k++) pts.push([o.x + Math.cos(k * Math.PI / 4) * o.r, o.y + Math.sin(k * Math.PI / 4) * o.r]);
    return pts;
  }
  var c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0), hl = o.l / 2, hw = o.w / 2;
  return [[o.x, o.y], [o.x + c * hl - s * hw, o.y + s * hl + c * hw], [o.x - c * hl - s * hw, o.y - s * hl + c * hw],
    [o.x + c * hl + s * hw, o.y + s * hl - c * hw], [o.x - c * hl + s * hw, o.y - s * hl - c * hw]];
}

/* ------------------------------------------------------------------ catalog */

var list = T.list;

test('tracks: module shape and namespace', function () {
  assert.ok(CB && CB.race && CB.race.tracks === T, 'CB.race.tracks exported');
  ['build', 'project', 'speedProfile', 'get', 'pointAt', 'validate'].forEach(function (f) {
    assert.strictEqual(typeof T[f], 'function', f);
  });
  assert.ok(Array.isArray(list) && list.length >= 6, 'at least 6 circuits, got ' + list.length);
});

test('tracks: catalog entries follow RACE-SPEC fields', function () {
  var ids = {};
  list.forEach(function (d) {
    assert.ok(d.id && !ids[d.id], 'unique id ' + d.id); ids[d.id] = 1;
    assert.strictEqual(T.get(d.id), d);
    ['name', 'country', 'desc'].forEach(function (k) { assert.ok(typeof d[k] === 'string' && d[k].length > 1, d.id + '.' + k); });
    assert.ok(d.difficulty >= 1 && d.difficulty <= 5, d.id + ' difficulty');
    assert.ok(d.surface && d.surface.grip > 0.5 && d.surface.grip <= 1.3, d.id + ' surface.grip');
    ['grass', 'asphalt', 'kerbA', 'kerbB', 'sand', 'sky'].forEach(function (k) {
      assert.ok(/^#[0-9a-f]{6}$/i.test(d.theme[k]), d.id + ' theme.' + k + ' = ' + d.theme[k]);
    });
    assert.ok(d.width_m >= 7 && d.width_m <= 24, d.id + ' width_m');
    assert.ok(Array.isArray(d.points) && d.points.length >= 12, d.id + ' control points');
    d.points.forEach(function (p) { assert.ok(isFinite(p[0]) && isFinite(p[1])); });
    assert.ok(typeof d.pitStraight === 'number', d.id + ' pitStraight');
    assert.ok(Array.isArray(d.scenery) && d.scenery.length > 20, d.id + ' scenery');
    assert.ok(Math.abs(d.length_m - geomOf(d).length) < 1, d.id + ' length_m is the computed length');
  });
  assert.strictEqual(T.get('nope'), null);
});

test('tracks: required circuit archetypes are present', function () {
  var tags = list.map(function (d) { return (d.tags || []).concat([d.id, d.name.toLowerCase()]).join(' '); }).join(' | ');
  var ring = list.filter(function (d) { return d.id === 'forge-ring' && /redline ring/i.test(d.name); })[0];
  assert.ok(ring, 'Redline Ring present');
  var rl = geomOf(ring).length;
  assert.ok(rl > 5500 && rl < 6100, 'Redline Ring ~5.8 km, got ' + Math.round(rl));
  var names = ring.corners.map(function (c) { return c.name.toLowerCase(); }).join(',');
  assert.ok(/hairpin/.test(names) && /chicane/.test(names), 'Redline Ring has a hairpin and a chicane: ' + names);
  assert.ok(/speedway/.test(tags), 'speedway');
  assert.ok(list.some(function (d) { return d.style && d.style.street; }), 'street circuit with walls');
  assert.ok(list.some(function (d) { return d.difficulty === 5 || /touge|mountain|pass/.test(d.desc.toLowerCase()); }), 'mountain touge');
  assert.ok(list.some(function (d) { return geomOf(d).length < 1500; }), 'short kart track');
  assert.ok(list.some(function (d) { return d.crossing || d.timeOfDay === 'night' || (d.theme && d.theme.night); }), 'figure-8 or night circuit');
});

/* ------------------------------------------------------------------ geometry, per track */

list.forEach(function (def) {
  var id = def.id;

  test(id + ': closed, uniformly resampled centerline', function () {
    var g = geomOf(def), S = g.samples, N = S.length;
    assert.ok(N > 200, 'sample count');
    assert.ok(Math.abs(g.ds - 2) < 0.15, 'ds ~2 m, got ' + g.ds);
    assert.ok(Math.abs(S[0].s) < 1e-9, 's starts at 0');
    for (var i = 0; i < N; i++) {
      var a = S[i], b = S[(i + 1) % N];
      ['x', 'y', 'heading', 'curvature', 's', 'width', 'leftKerb', 'rightKerb'].forEach(function (k) {
        assert.ok(typeof a[k] === 'number' && isFinite(a[k]), id + ' sample ' + i + ' .' + k);
      });
      var step = Math.hypot(b.x - a.x, b.y - a.y);
      assert.ok(step > g.ds * 0.9 && step < g.ds * 1.1, id + ' step ' + i + ' = ' + step.toFixed(3) + (i === N - 1 ? ' (loop closure)' : ''));
      var dh = Math.abs(wrap(b.heading - a.heading));
      assert.ok(dh < 0.25, id + ' heading jump at ' + i + ': ' + dh.toFixed(3));
      // heading agrees with the chord direction
      var chord = Math.atan2(b.y - a.y, b.x - a.x);
      assert.ok(Math.abs(wrap(chord - a.heading)) < 0.2, id + ' heading vs chord at ' + i);
      if (i < N - 1) assert.ok(b.s > a.s, 's increasing');
    }
    assert.ok(Math.abs(g.length - (S[N - 1].s + Math.hypot(S[0].x - S[N - 1].x, S[0].y - S[N - 1].y))) < 0.5, 'length closes the loop');
  });

  test(id + ': signed curvature integrates to the total turning', function () {
    var g = geomOf(def), S = g.samples, tot = 0, hsum = 0;
    for (var i = 0; i < S.length; i++) {
      tot += S[i].curvature * g.ds;
      hsum += wrap(S[(i + 1) % S.length].heading - S[i].heading);
    }
    var expected = def.crossing ? 0 : 2 * Math.PI;
    assert.ok(Math.abs(Math.abs(hsum) - expected) < 0.05, id + ' heading winding ' + hsum.toFixed(3));
    assert.ok(Math.abs(Math.abs(tot) - expected) < 0.35, id + ' curvature integral ' + tot.toFixed(3));
    if (!def.crossing) assert.ok(Math.sign(tot) === Math.sign(hsum), 'curvature sign matches heading change');
  });

  test(id + ': no self-intersection' + (def.crossing ? ' (exactly one intentional crossing)' : ''), function () {
    var g = geomOf(def), cr = crossingsOf(g);
    assert.strictEqual(cr.length, def.crossing ? 1 : 0, id + ' centerline crossings: ' + JSON.stringify(cr.slice(0, 3)));
    var v = T.validate(g);
    assert.strictEqual(v.selfIntersections, 0);
    // asphalt of separate parts of the lap never overlaps (clearance between track edges)
    if (v.minClearance != null && isFinite(v.minClearance)) assert.ok(v.minClearance > 2, id + ' edge clearance ' + v.minClearance);
  });

  test(id + ': length plausible for its type', function () {
    var L = geomOf(def).length;
    // Nordschleife-style 'ring' circuits may run to ~14 km; everything else stays under 7 km.
    var maxL = /ring/i.test(def.id) && L > 7000 ? 14000 : 7000;
    assert.ok(L > 500 && L < maxL, id + ' length ' + L);
    if (/kart/i.test(def.name + (def.tags || []).join(' '))) assert.ok(L < 1500, 'kart track short: ' + L);
    if (/speedway/i.test(def.name)) assert.ok(L > 2000 && L < 4500, 'speedway: ' + L);
  });

  test(id + ': width variation and corner kerbs', function () {
    var g = geomOf(def), S = g.samples, minW = Infinity, maxW = 0, kerbCorner = 0, corner = 0, kerbStraight = 0, straight = 0;
    S.forEach(function (p) {
      minW = Math.min(minW, p.width); maxW = Math.max(maxW, p.width);
      assert.ok(Math.abs(p.hw * 2 - p.width) < 1e-6 || p.hw == null);
      assert.ok(p.leftKerb >= 0 && p.rightKerb >= 0 && p.leftKerb < 4 && p.rightKerb < 4, 'kerb widths sane');
      var k = Math.abs(p.curvature);
      if (k > 1 / 120) { corner++; if (p.leftKerb > 0 || p.rightKerb > 0) kerbCorner++; }
      else if (k < 1 / 2000) { straight++; if (p.leftKerb > 0 || p.rightKerb > 0) kerbStraight++; }
    });
    assert.ok(minW > def.width_m * 0.55 && maxW < def.width_m * 1.6, id + ' width range ' + minW.toFixed(1) + '..' + maxW.toFixed(1));
    assert.ok(maxW - minW > 0.3, id + ' width varies along the lap');
    if (corner > 20) assert.ok(kerbCorner / corner > 0.5, id + ' kerbs in tight corners ' + kerbCorner + '/' + corner);
    if (straight > 50) assert.ok(kerbStraight / straight < 0.5, id + ' mostly no kerbs on straights ' + kerbStraight + '/' + straight);
    // inside kerb: on the side the corner turns toward
    var insideOk = 0, insideN = 0;
    S.forEach(function (p) {
      if (Math.abs(p.curvature) > 1 / 60) { insideN++; if ((p.curvature > 0 ? p.leftKerb : p.rightKerb) > 0) insideOk++; }
    });
    if (insideN > 10) assert.ok(insideOk / insideN > 0.6, id + ' inside kerbs ' + insideOk + '/' + insideN);
  });

  test(id + ': racing line inside track and smoother than centerline', function () {
    var g = geomOf(def), S = g.samples, rl = g.racingLine;
    assert.strictEqual(rl.length, S.length);
    var kc = 0, kr = 0, used = 0;
    for (var i = 0; i < S.length; i++) {
      assert.ok(Math.abs(rl[i]) <= S[i].hw + Math.max(S[i].leftKerb, S[i].rightKerb) + 1e-6, id + ' line within width at ' + i);
      used = Math.max(used, Math.abs(rl[i]) / S[i].hw);
      kc += S[i].curvature * S[i].curvature;
      kr += g.racingLineCurvature[i] * g.racingLineCurvature[i];
    }
    assert.ok(used > 0.5, id + ' racing line uses the track width (' + used.toFixed(2) + ')');
    assert.ok(kr < kc * 0.92, id + ' racing line curvature energy ' + kr.toFixed(4) + ' < centerline ' + kc.toFixed(4));
    // and it is actually the faster way round: same car, same limits, line vs centerline
    var tLine = T.lapTime(g, T.speedProfile(g, 1.3, 1.1));
    var tCenter = T.lapTime(g, T.speedProfile(g, 1.3, 1.1, null, { line: 'center' }));
    assert.ok(tLine < tCenter, id + ' lap on the racing line ' + tLine.toFixed(2) + ' s < centerline ' + tCenter.toFixed(2) + ' s');
    // smooth: no offset jumps between samples
    // smooth: the driven path never kinks (offsets may change fast through a chicane, the path may not)
    var XY = g.racingLineXY, n = XY.length, kPeak = 0;
    for (i = 0; i < n; i++) kPeak = Math.max(kPeak, Math.abs(S[i].curvature));
    for (i = 0; i < n; i++) {
      var p0 = XY[(i - 1 + n) % n], p1 = XY[i], p2 = XY[(i + 1) % n];
      var turn = Math.abs(wrap(Math.atan2(p2.y - p1.y, p2.x - p1.x) - Math.atan2(p1.y - p0.y, p1.x - p0.x)));
      var kLoc = 0;
      for (var w = -8; w <= 8; w++) kLoc = Math.max(kLoc, Math.abs(S[(i + w + n) % n].curvature));
      // never sharper than the tightest nearby bit of the track itself (+ small numerical slack)
      assert.ok(turn < kLoc * g.ds * 1.1 + 0.03, id + ' racing line kink ' + turn.toFixed(3) + ' rad at ' + i + ' (track ' + (kLoc * g.ds).toFixed(3) + ')');
      assert.ok(Math.abs(g.racingLineCurvature[i]) <= kPeak, id + ' racing line curvature at ' + i + ' above the tightest point of the track');
    }
  });

  test(id + ': sectors and start/finish line', function () {
    var g = geomOf(def);
    assert.strictEqual(g.sectors.length, 3);
    assert.strictEqual(g.sectors[0].start, 0);
    for (var k = 0; k < 3; k++) {
      var sc = g.sectors[k];
      assert.ok(sc.length > g.length * 0.12, 'sector ' + (k + 1) + ' not degenerate');
      if (k < 2) assert.ok(Math.abs(sc.end - g.sectors[k + 1].start) < 1e-6, 'contiguous');
    }
    assert.ok(Math.abs(g.sectors[2].end - g.length) < 1e-6, 'covers the lap');
    var sl = g.startLine;
    assert.ok(sl && isFinite(sl.x) && isFinite(sl.y) && sl.a && sl.b, 'start line endpoints');
    assert.ok(Math.abs(Math.hypot(sl.a.x - sl.b.x, sl.a.y - sl.b.y) - g.samples[0].width) < 0.01);
  });

  test(id + ': grid slots staggered 2-wide behind the line on asphalt', function () {
    var g = geomOf(def), slots = g.grid;
    assert.ok(slots.length >= 12, 'at least 12 slots');
    var seen = {};
    slots.forEach(function (sl, k) {
      assert.ok(sl.sRel < 0, 'behind the line');
      if (k) {
        assert.ok(sl.sRel < slots[k - 1].sRel, 'each slot further back');
        assert.ok(Math.sign(sl.lateral) === -Math.sign(slots[k - 1].lateral), 'alternating sides');
      }
      var pr = T.project(g, sl.x, sl.y, sl.index);
      assert.strictEqual(pr.surface, 'asphalt', 'slot ' + k + ' on asphalt');
      assert.ok(Math.abs(pr.lateral - sl.lateral) < 0.05);
      assert.ok(Math.abs(wrap(sl.heading - g.samples[pr.index].heading)) < 0.1, 'facing race direction');
      slots.forEach(function (o, j) {
        if (j > k) assert.ok(Math.hypot(o.x - sl.x, o.y - sl.y) > 4, 'slots ' + k + '/' + j + ' do not overlap');
      });
      seen[sl.position] = 1;
    });
    assert.strictEqual(Object.keys(seen).length, slots.length);
  });

  test(id + ': speedProfile obeys lateral and braking limits', function () {
    var g = geomOf(def), latG = 1.3, brkG = 1.1;
    var accel = function (v) { return Math.max(0.3, 7 - v * 0.06); };
    var vel = T.speedProfile(g, latG, brkG, accel);
    assert.strictEqual(vel.length, g.n);
    var K = g.racingLineCurvature, DS = g.racingLineDs, N = g.n, vmin = Infinity, vmax = 0;
    for (var i = 0; i < N; i++) {
      var v = vel[i];
      assert.ok(isFinite(v) && v > 3, 'positive speed at ' + i);
      vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
      assert.ok(v * v * Math.abs(K[i]) <= latG * G * 1.02, 'lateral limit at ' + i);
      var vn = vel[(i + 1) % N];
      if (vn < v) assert.ok((v * v - vn * vn) / (2 * Math.max(0.2, DS[i])) <= brkG * G * 1.02, 'braking limit at ' + i);
      else assert.ok((vn * vn - v * v) / (2 * Math.max(0.2, DS[i])) <= accel(v) * 1.02, 'accel limit at ' + i);
    }
    assert.ok(vmax > vmin * 1.3, 'speed varies around the lap');
    // more grip -> faster lap, also via the geom shortcut
    var fast = T.speedProfile(g, 1.8, 1.4, accel);
    assert.ok(T.lapTime(g, fast) < T.lapTime(g, vel));
    if (typeof g.speedProfile === 'function') assert.strictEqual(g.speedProfile(latG, brkG, accel).length, N);
    var lt = T.lapTime(g, vel);
    assert.ok(lt > g.length / 95 && lt < g.length / 8, id + ' lap time plausible ' + lt.toFixed(1) + ' s');
  });

  test(id + ': project() round-trips with and without hint', function () {
    var g = geomOf(def), S = g.samples, r = rng(def.id.length * 7919), maxErr = 0;
    for (var t = 0; t < 400; t++) {
      var s = r() * g.length;
      var i0 = T.indexAt(g, s);
      var lat = (r() * 2 - 1) * S[i0].hw * 0.9;
      var p = T.pointAt(g, s, lat);
      var hint = mod(i0 + Math.round((r() - 0.5) * 30), g.n);
      var a = T.project(g, p.x, p.y, hint);
      var e = Math.abs(a.lateral - lat), ds = arcDist(a.s, s, g.length);
      maxErr = Math.max(maxErr, e);
      assert.ok(e < 0.25 && ds < 1.5, id + ' hinted projection s=' + s.toFixed(1) + ' lat=' + lat.toFixed(2) + ' -> ' + JSON.stringify({ s: a.s, lat: a.lateral }));
      assert.ok(a.onTrack && a.surface === 'asphalt', 'on asphalt');
      if (!def.crossing || t % 4 === 0) {
        var b = T.project(g, p.x, p.y);
        // without a hint the figure-8 crossing is ambiguous; elsewhere the answer must match
        if (!def.crossing) assert.ok(Math.abs(b.lateral - lat) < 0.25 && arcDist(b.s, s, g.length) < 1.5, 'unhinted projection');
        else assert.ok(Math.abs(Math.abs(b.lateral)) <= S[b.index].hw + 0.25, 'unhinted onto some branch');
      }
    }
    // stale hint on the opposite side of the lap still recovers
    var q = T.pointAt(g, g.length * 0.25, 0), far = T.project(g, q.x, q.y, T.indexAt(g, g.length * 0.75));
    assert.ok(arcDist(far.s, g.length * 0.25, g.length) < 2, 'stale hint recovers');
    // lateral sign: +left of the race direction
    var p0 = S[10], left = T.project(g, p0.x - Math.sin(p0.heading) * 2, p0.y + Math.cos(p0.heading) * 2, 10);
    assert.ok(left.lateral > 1.9 && left.lateral < 2.1, '+lateral is left');
    // far outside -> not on track
    var outside = T.project(g, p0.x - Math.sin(p0.heading) * (p0.wallL + 3), p0.y + Math.cos(p0.heading) * (p0.wallL + 3), 10);
    assert.ok(!outside.onTrack && outside.surface === 'wall', 'beyond the barrier is wall, got ' + outside.surface);
    var off = T.project(g, p0.x - Math.sin(p0.heading) * (p0.hw + p0.leftKerb + 0.5), p0.y + Math.cos(p0.heading) * (p0.hw + p0.leftKerb + 0.5), 10);
    assert.ok(!off.onTrack || p0.wallL <= p0.hw + p0.leftKerb + 0.5, 'just beyond the kerb is off track');
    assert.ok(['asphalt', 'kerb', 'grass', 'sand', 'wall'].indexOf(off.surface) >= 0);
  });

  test(id + ': scenery never sits on the track', function () {
    var g = geomOf(def), items = g.scenery;
    assert.ok(items.length > 20, 'scenery resolved: ' + items.length);
    items.forEach(function (o, n) {
      assert.ok(isFinite(o.x) && isFinite(o.y) && typeof o.type === 'string', 'item ' + n);
      footprint(o).forEach(function (pt) {
        var nc = nearestCenter(g, pt[0], pt[1]), sm = g.samples[nc.index];
        assert.ok(nc.dist > sm.hw + Math.max(sm.leftKerb, sm.rightKerb) + 0.3,
          id + ' ' + o.type + ' #' + n + ' at (' + o.x + ',' + o.y + ') is ' + nc.dist.toFixed(2) + ' m from centerline (hw ' + sm.hw.toFixed(2) + ')');
      });
    });
  });
});

/* ------------------------------------------------------------------ cross-catalog */

test('tracks: scenery vocabulary covers the spec', function () {
  var types = {};
  list.forEach(function (d) { geomOf(d).scenery.forEach(function (o) { types[o.type] = (types[o.type] || 0) + 1; }); });
  ['tree', 'grandstand', 'building', 'tyres', 'lamp', 'marshal', 'billboard'].forEach(function (t) {
    assert.ok(types[t] > 0, 'scenery type ' + t + ' used: ' + JSON.stringify(types));
  });
});

test('tracks: circuits are distinct', function () {
  var sig = list.map(function (d) {
    var g = geomOf(d), sharp = 0;
    g.samples.forEach(function (p) { if (Math.abs(p.curvature) > 1 / 40) sharp++; });
    return [Math.round(g.length / 50), Math.round(sharp * g.ds / 20), d.width_m].join('/');
  });
  var uniq = {}; sig.forEach(function (s) { uniq[s] = 1; });
  assert.strictEqual(Object.keys(uniq).length, list.length, 'signatures ' + sig.join(' '));
});

test('tracks: build is deterministic, cached and fast', function () {
  var d = list[0];
  assert.strictEqual(T.build(d), T.build(d), 'cached per definition');
  var fresh = T.build(d, { noCache: true });
  assert.strictEqual(fresh.samples.length, geomOf(d).samples.length);
  assert.strictEqual(fresh.scenery.length, geomOf(d).scenery.length);
  assert.ok(Math.abs(fresh.racingLine[123] - geomOf(d).racingLine[123]) < 1e-9);
  var t0 = Date.now();
  list.forEach(function (x) { T.build(x, { noCache: true }); });
  assert.ok(Date.now() - t0 < 8000, 'all tracks build quickly (' + (Date.now() - t0) + ' ms)');
  assert.throws(function () { T.build(null); });
  assert.throws(function () { T.build({ points: [[0, 0]] }); });
});

test('tracks: build() accepts a plain control-point definition', function () {
  var pts = [];
  for (var k = 0; k < 24; k++) { var a = k / 24 * Math.PI * 2; pts.push([Math.cos(a) * 300, Math.sin(a) * 160]); }
  var g = T.build({ id: 'ellipse', name: 'Ellipse', width_m: 12, points: pts, theme: {}, surface: { grip: 1 } });
  assert.ok(g.length > 1400 && g.length < 1600, 'ellipse perimeter ' + g.length);
  assert.strictEqual(crossingsOf(g).length, 0);
  var pr = T.project(g, 300, 0, 0);
  assert.ok(Math.abs(pr.lateral) < 0.2 && pr.onTrack);
});

if (standalone && require.main === module) {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
}

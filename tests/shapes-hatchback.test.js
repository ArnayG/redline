/* FORGE Atelier — tests for js/shapes/models/hatchback.js (Golf GTI Mk8, Civic Type R FL5, GR Yaris).
   Loads the model file standalone (registerModel stubbed via CB.shapes._pending), validates every path, checks the
   geometry against the published reference dimensions, and — when js/shapes/core.js is present — fit()/toSvgPath(). */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

// Standalone mode (`node tests/shapes-hatchback.test.js`): provide a minimal global test() when not run by tests/run.js.
const STANDALONE = typeof globalThis.test !== 'function';
const QUEUE = [];
const test = STANDALONE ? (name, fn) => QUEUE.push({ name, fn }) : globalThis.test;

const ROOT = path.join(__dirname, '..');
const MODEL_FILE = path.join(ROOT, 'js', 'shapes', 'models', 'hatchback.js');
const CORE_FILE = path.join(ROOT, 'js', 'shapes', 'core.js');

/** Load the model file in isolation: hide any existing registerModel so models land in _pending. */
function loadStandalone() {
  const CB = (globalThis.CB = globalThis.CB || {});
  CB.shapes = CB.shapes || {};
  const savedReg = CB.shapes.registerModel, savedPending = CB.shapes._pending;
  delete CB.shapes.registerModel;
  CB.shapes._pending = [];
  delete require.cache[require.resolve(MODEL_FILE)];
  const exported = require(MODEL_FILE);
  const pending = CB.shapes._pending;
  if (savedReg) CB.shapes.registerModel = savedReg;
  CB.shapes._pending = savedPending;
  return { exported, pending };
}
const { exported, pending } = loadStandalone();
const MODELS = pending;

/* ---------- geometry helpers (independent of core.js) ---------- */
function isPath(v) { return Array.isArray(v) && v.length > 0 && v.every((s) => s && typeof s.t === 'string' && Array.isArray(s.p)); }
function sample(pathv, steps) {
  steps = steps || 24;
  const out = []; let cur = null, start = null;
  for (const s of pathv) {
    if (s.t === 'M') { cur = s.p[0]; start = cur; out.push(cur); }
    else if (s.t === 'L') { cur = s.p[0]; out.push(cur); }
    else if (s.t === 'C') {
      const [a, b, c] = s.p, p0 = cur;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        out.push([u * u * u * p0[0] + 3 * u * u * t * a[0] + 3 * u * t * t * b[0] + t * t * t * c[0],
          u * u * u * p0[1] + 3 * u * u * t * a[1] + 3 * u * t * t * b[1] + t * t * t * c[1]]);
      }
      cur = c;
    } else if (s.t === 'Q') {
      const [a, c] = s.p, p0 = cur;
      for (let i = 1; i <= steps; i++) { const t = i / steps, u = 1 - t; out.push([u * u * p0[0] + 2 * u * t * a[0] + t * t * c[0], u * u * p0[1] + 2 * u * t * a[1] + t * t * c[1]]); }
      cur = c;
    } else if (s.t === 'Z') { cur = start; }
  }
  return out;
}
function bounds(pathv) {
  const pts = sample(pathv);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
}
function unionBounds(paths) {
  const b = paths.map(bounds);
  return { minX: Math.min(...b.map((q) => q.minX)), maxX: Math.max(...b.map((q) => q.maxX)), minY: Math.min(...b.map((q) => q.minY)), maxY: Math.max(...b.map((q) => q.maxY)) };
}
/** Collect every path in an arbitrary nested structure, with a label. */
function collectPaths(v, label, out) {
  out = out || [];
  if (isPath(v)) { out.push({ label, path: v }); return out; }
  if (Array.isArray(v)) v.forEach((e, i) => collectPaths(e, label + '[' + i + ']', out));
  else if (v && typeof v === 'object') Object.keys(v).forEach((k) => collectPaths(v[k], label + '.' + k, out));
  return out;
}
function tireRadius(spec, rim) { const m = /^(\d+)\/(\d+)/.exec(spec); return (rim * 25.4 + 2 * m[1] * m[2] / 100) / 2000; }
function within(actual, expected, rel, msg) {
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * rel, msg + ': expected ' + expected + ' ±' + (rel * 100) + '% got ' + actual.toFixed(4));
}
/** Signed area (shoelace on sampled points). */
function area(pathv) { const p = sample(pathv, 8); let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return a / 2; }
function contains(outer, pt) {
  const p = sample(outer, 12); let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i], b = p[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/* ---------- tests ---------- */
test('hatchback: file registers three real models via _pending and exports them', () => {
  assert.equal(MODELS.length, 3);
  assert.ok(Array.isArray(exported) && exported.length === 3);
  const ids = MODELS.map((m) => m.id).sort();
  assert.deepEqual(ids, ['honda-civic-type-r-fl5', 'toyota-gr-yaris', 'vw-golf-gti-mk8']);
  for (const m of MODELS) {
    assert.equal(m.style, 'hatchback');
    assert.ok(m.make && m.name && m.gen && m.years, m.id + ' identity');
    assert.ok(['front', 'mid', 'rear'].includes(m.enginePosition));
    assert.ok(['ice', 'ev', 'hybrid'].includes(m.powertrain));
    for (const k of ['headlights', 'taillights', 'grille', 'notes']) assert.ok(typeof m.signature[k] === 'string' && m.signature[k].length > 20, m.id + ' signature.' + k);
  }
});

test('hatchback: reference figures are published values and self-consistent', () => {
  const pub = {
    'vw-golf-gti-mk8': { length: 4.287, width: 1.789, wheelbase: 2.627, tire: '225/40R18' },
    'honda-civic-type-r-fl5': { length: 4.594, width: 1.890, height: 1.405, wheelbase: 2.735, tire: '265/30R19' },
    'toyota-gr-yaris': { length: 3.995, width: 1.805, height: 1.455, wheelbase: 2.560, trackF: 1.535, trackR: 1.565, tire: '225/40R18' }
  };
  for (const m of MODELS) {
    const r = m.ref, p = pub[m.id];
    for (const k of ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR']) if (p[k]) within(r[k], p[k], 0.001, m.id + ' ref.' + k);
    assert.equal(r.tireF, p.tire);
    within(r.frontOverhang + r.wheelbase + r.rearOverhang, r.length, 0.0005, m.id + ' overhangs + wheelbase = length');
    for (const k of ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR', 'frontOverhang', 'rearOverhang', 'groundClearance', 'rideHeight', 'cd', 'curbWeight_kg', 'wheelDiameter_in'])
      assert.ok(Number.isFinite(r[k]) && r[k] > 0, m.id + ' ref.' + k + ' finite');
    assert.ok(r.trackF < r.width && r.trackR < r.width, m.id + ' tracks inside body width');
  }
});

test('hatchback: every path is well-formed and finite', () => {
  for (const m of MODELS) {
    const all = collectPaths({ side: m.side, top: m.top, front: m.front, rear: m.rear }, m.id)
      .concat(m.details.map((d, i) => ({ label: m.id + '.details[' + i + '].' + d.role, path: d.path })));
    assert.ok(all.length > 60, m.id + ' has rich geometry (' + all.length + ' paths)');
    for (const { label, path: p } of all) {
      assert.ok(isPath(p), label + ' is a path');
      assert.equal(p[0].t, 'M', label + ' starts with M');
      const arity = { M: 1, L: 1, C: 3, Q: 2, Z: 0 };
      for (const s of p) {
        assert.ok(s.t in arity, label + ' segment type ' + s.t);
        assert.equal(s.p.length, arity[s.t], label + ' ' + s.t + ' point count');
        for (const q of s.p) assert.ok(q.length === 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]), label + ' finite point');
      }
    }
    for (const d of m.details) {
      assert.ok(['side', 'top', 'front', 'rear'].includes(d.view), m.id + ' detail view');
      assert.ok(typeof d.role === 'string' && typeof d.paint === 'string', m.id + ' detail role/paint');
    }
    for (const e of m.rear.exhaust) for (const k of ['cx', 'cy', 'w', 'h']) assert.ok(Number.isFinite(e[k]), m.id + ' exhaust.' + k);
  }
});

test('hatchback: side body matches ref length/height and overhangs within 1%', () => {
  for (const m of MODELS) {
    const b = bounds(m.side.body), r = m.ref;
    within(b.w, r.length, 0.01, m.id + ' side length');
    within(b.maxY, r.height, 0.01, m.id + ' side height');
    within(b.maxX, r.wheelbase / 2 + r.frontOverhang, 0.01, m.id + ' front bumper x');
    within(-b.minX, r.wheelbase / 2 + r.rearOverhang, 0.01, m.id + ' rear bumper x');
    assert.ok(b.minY >= r.groundClearance * 0.95 && b.minY <= r.groundClearance * 1.15, m.id + ' body bottom ≈ ground clearance (' + b.minY + ')');
    // all side elements lie inside the length envelope; greenhouse and windows inside the body outline
    for (const w of m.side.windows.concat([m.side.greenhouse])) {
      const wb = bounds(w);
      assert.ok(wb.maxY <= r.height + 1e-6 && wb.minX >= b.minX && wb.maxX <= b.maxX, m.id + ' window inside envelope');
      assert.ok(contains(m.side.body, [(wb.minX + wb.maxX) / 2, (wb.minY + wb.maxY) / 2]), m.id + ' window centre inside body');
    }
  }
});

test('hatchback: wheel arches centred on the axles and sized for the real tyre', () => {
  for (const m of MODELS) {
    const r = m.ref;
    for (const [key, sign, tire] of [['archF', 1, r.tireF], ['archR', -1, r.tireR]]) {
      const a = m.side[key], tr = tireRadius(tire, r.wheelDiameter_in);
      assert.ok(Math.abs(a.x - sign * r.wheelbase / 2) < 1e-6, m.id + ' ' + key + ' x on axle');
      assert.ok(Math.abs(a.y - tr) < 0.002, m.id + ' ' + key + ' centre at wheel centre height');
      assert.ok(a.r > tr + 0.02 && a.r < tr + 0.08, m.id + ' ' + key + ' radius clears tyre (' + a.r.toFixed(3) + ' vs tyre ' + tr.toFixed(3) + ')');
      assert.ok(a.flare >= 0 && a.flare < 0.08, m.id + ' ' + key + ' flare');
      // the arch top sits inside the body silhouette, and the tyre top is below the shoulder
      assert.ok(contains(m.side.body, [a.x, a.y + a.r]), m.id + ' ' + key + ' arch top inside body');
    }
  }
});

test('hatchback: top view width matches ref.width and length matches side view', () => {
  for (const m of MODELS) {
    const b = bounds(m.top.body), r = m.ref;
    within(b.h, r.width, 0.01, m.id + ' plan width');
    within(b.w, r.length, 0.01, m.id + ' plan length');
    assert.ok(Math.abs(b.minY + b.maxY) < 1e-3, m.id + ' plan symmetric');
    const g = bounds(m.top.greenhouse), mir = bounds((function (v) { return Array.isArray(v[0]) ? [].concat.apply([], v) : v; })(m.top.mirrors));
    assert.ok(g.h < b.h, m.id + ' greenhouse narrower than body');
    assert.ok(mir.h > b.h, m.id + ' mirrors stick out beyond body');
    for (const k of ['hood', 'roof', 'deck']) { const q = bounds(m.top[k]); assert.ok(q.minX >= b.minX && q.maxX <= b.maxX && q.h <= b.h, m.id + ' top.' + k + ' inside plan'); }
  }
});

test('hatchback: front and rear views are symmetric about z=0 and sized to width/height', () => {
  const symKeys = {
    front: ['body', 'greenhouse', 'bumper', 'grille', 'intakes', 'headlights', 'drl', 'fogLights', 'splitter', 'plateArea', 'badgeArea'],
    rear: ['body', 'greenhouse', 'bumper', 'taillights', 'lightBar', 'diffuser', 'plateArea', 'badgeArea', 'spoiler']
  };
  for (const m of MODELS) {
    for (const view of ['front', 'rear']) {
      const v = m[view];
      const bb = bounds(v.body);
      within(bb.maxX - bb.minX, m.ref.width, 0.01, m.id + ' ' + view + ' width');
      within(bb.maxY, m.ref.height, 0.01, m.id + ' ' + view + ' height');
      for (const k of symKeys[view]) {
        if (v[k] == null) continue;
        const paths = collectPaths(v[k], k).map((e) => e.path);
        assert.ok(paths.length > 0, m.id + ' ' + view + '.' + k + ' has paths');
        const u = unionBounds(paths);
        assert.ok(Math.abs(u.minX + u.maxX) < 1e-3, m.id + ' ' + view + '.' + k + ' symmetric (' + u.minX.toFixed(4) + '..' + u.maxX.toFixed(4) + ')');
        assert.ok(u.maxX <= m.ref.width / 2 + 0.01, m.id + ' ' + view + '.' + k + ' within body width');
      }
      // paired lamps: left/right mirror images with equal |area|
      const lamps = view === 'front' ? v.headlights : v.taillights;
      assert.equal(lamps.length, 2, m.id + ' two ' + view + ' lamps');
      within(Math.abs(area(lamps[0])), Math.abs(area(lamps[1])), 0.01, m.id + ' ' + view + ' lamp areas mirror');
    }
    const ex = m.rear.exhaust.map((e) => e.cx).sort((a, b) => a - b);
    for (let i = 0; i < ex.length; i++) assert.ok(Math.abs(ex[i] + ex[ex.length - 1 - i]) < 1e-6, m.id + ' exhaust layout symmetric');
  }
});

test('hatchback: signature features are present (GTI X-fogs + light bar, Type R triple exhaust + wing, GR Yaris 3-door + carbon roof)', () => {
  const by = Object.fromEntries(MODELS.map((m) => [m.id, m]));
  const golf = by['vw-golf-gti-mk8'], civic = by['honda-civic-type-r-fl5'], yaris = by['toyota-gr-yaris'];
  assert.equal(golf.front.fogLights.length, 10, 'GTI: two X-pattern 5-LED fog clusters');
  assert.ok(bounds(golf.front.drl[0]).w > 0.9, 'GTI: illuminated cross-bar spans the grille');
  assert.ok(golf.details.some((d) => d.role === 'stripe' && d.paint === 'light-red'), 'GTI red stripe');
  assert.equal(golf.side.windows.length, 3);
  assert.equal(civic.rear.exhaust.length, 3, 'Type R triple exhaust');
  assert.ok(civic.rear.exhaust[1].w < civic.rear.exhaust[0].w, 'Type R centre pipe smaller');
  assert.ok(civic.details.some((d) => d.view === 'side' && d.role === 'wing'), 'Type R wing');
  assert.ok(civic.details.some((d) => d.view === 'top' && d.role === 'vent'), 'Type R hood vent');
  assert.equal(yaris.doors, 3);
  assert.equal(yaris.side.windows.length, 2, 'GR Yaris: door glass + small quarter window');
  assert.ok(yaris.details.some((d) => d.role === 'roof' && d.paint === 'carbon'), 'GR Yaris carbon roof');
  // GR Yaris roof drops toward the rear more than the Golf's
  const drop = (m) => { const s = sample(m.side.body); const hAt = (x) => Math.max(...s.filter((q) => Math.abs(q[0] - x) < 0.03).map((q) => q[1])); return (m.ref.height - hAt(-m.ref.wheelbase / 2)) / m.ref.height; };
  assert.ok(drop(yaris) > drop(golf), 'GR Yaris tapered roof');
  // Civic fastback: hatch lip far lower than roof peak
  const cs = bounds(civic.side.body);
  const tail = sample(civic.side.body).filter((q) => q[0] < cs.minX + 0.25).reduce((a, q) => Math.max(a, q[1]), 0);
  assert.ok(tail < civic.ref.height * 0.82, 'Civic fastback tail height');
});

test('hatchback: explicit 3D sections — closed 40-vert rings, glass flags, carved wheel wells, plan-view hips', () => {
  for (const m of MODELS) {
    const S = m.sections, r = m.ref;
    assert.ok(Array.isArray(S) && S.length >= 40, m.id + ' has dense explicit sections (' + (S && S.length) + ')');
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      assert.equal(s.ring.length, 40, m.id + ' ring verts');
      assert.equal(s.glass.length, 40, m.id + ' glass flags per vert');
      if (i) assert.ok(s.x > S[i - 1].x, m.id + ' stations sorted');
      for (const [y, z] of s.ring) assert.ok(Number.isFinite(y) && Number.isFinite(z) && y > 0 && y <= r.height + 0.01 && Math.abs(z) <= r.width / 2 + 0.01, m.id + ' ring inside envelope');
      for (let j = 1; j < 20; j++) assert.ok(Math.abs(s.ring[j][1] + s.ring[40 - j][1]) < 1e-6 && s.ring[j][0] === s.ring[40 - j][0], m.id + ' ring mirrored');
    }
    // glass: windshield, side glass and backlight present; the bonnet is never glass
    assert.ok(S.some((s) => s.x > 0.3 && s.glass[18]), m.id + ' windshield glass');
    assert.ok(S.some((s) => s.x < -0.3 && s.glass[14]), m.id + ' side glass');
    assert.ok(S.filter((s) => s.x > r.wheelbase / 2).every((s) => s.glass.every((g) => !g)), m.id + ' no glass ahead of the front axle');
    // wheel wells: over each axle the lower body steps in to clear the tyre
    for (const ax of [r.wheelbase / 2, -r.wheelbase / 2]) {
      const s = S.reduce((a, b) => (Math.abs(b.x - ax) < Math.abs(a.x - ax) ? b : a));
      const low = Math.max(...s.ring.filter((q) => q[0] < 0.45).map((q) => Math.abs(q[1])));
      const tw = +/^(\d+)/.exec(r.tireF)[1] / 1000;
      assert.ok(low < Math.min(r.trackF, r.trackR) / 2 - tw / 2 + 0.03, m.id + ' wheel well carved at x=' + ax);
    }
    // the hips: max half-width over the rear axle exceeds the door waist
    const hw = (x) => { const s = S.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a)); return Math.max(...s.ring.map((q) => Math.abs(q[1]))); };
    assert.ok(hw(-r.wheelbase / 2) > hw(0) + 0.015, m.id + ' rear haunches wider than the doors');
  }
});

if (fs.existsSync(CORE_FILE)) {
  test('hatchback: core.js registration, fit() and toSvgPath()', () => {
    const CB = globalThis.CB;
    const S = require(CORE_FILE) || CB.shapes;
    const shapes = (S && S.registerModel) ? S : CB.shapes;
    MODELS.forEach((m) => shapes.registerModel(m));
    const list = shapes.modelsByStyle('hatchback');
    for (const id of ['vw-golf-gti-mk8', 'honda-civic-type-r-fl5', 'toyota-gr-yaris']) assert.ok(list.some((m) => m.id === id), id + ' registered');
    assert.ok(shapes.getModel({ body: { style: 'hatchback', model: 'toyota-gr-yaris' } }).id === 'toyota-gr-yaris');
    for (const id of ['vw-golf-gti-mk8', 'honda-civic-type-r-fl5', 'toyota-gr-yaris']) {
      const m = shapes.models[id];
      // identity fit reproduces the reference
      const f0 = shapes.fit(m, shapes.refBuild ? shapes.refBuild(m) : {});
      within(f0.dims.wheelbase, m.ref.wheelbase, 0.002, id + ' identity wheelbase');
      within(bounds(f0.side.body).w, m.ref.length, 0.01, id + ' identity length');
      // stretched build: +100 mm wheelbase, 19" wheels, lower ride
      const f = shapes.fit(m, {
        body: { style: 'hatchback', model: id, wheelbase_mm: Math.round(m.ref.wheelbase * 1000) + 100, trackWidth_mm: 1600 },
        suspension: { rideHeight_mm: 100 }, wheels: { diameter_in: 19 }, tires: { widthFront_mm: 245, widthRear_mm: 245, profileFront: 35, profileRear: 35 }
      });
      within(bounds(f.side.body).w, m.ref.length + 0.1, 0.01, id + ' fitted length');
      within(f.side.archF.x, f.dims.axleF, 0.001, id + ' fitted front arch on axle');
      assert.ok(f.side.archF.r > f.dims.wheelRadius, id + ' fitted arch clears tyre');
      const d = shapes.toSvgPath(f.side.body, { scale: 100, flipY: true, ox: 300, oy: 200 });
      assert.ok(/^M [-\d.]+ [-\d.]+ /.test(d) && !/NaN|undefined/.test(d), id + ' svg path string');
      for (const v of ['top', 'front', 'rear']) assert.ok(!/NaN/.test(shapes.toSvgPath(f[v].body, { scale: 100 })), id + ' ' + v + ' svg');
      if (shapes.sectionsFromViews && shapes.loftToMesh) {
        const secs = shapes.sectionsFromViews(m, { stations: 32, ringVerts: 24 });
        const mesh = shapes.loftToMesh(secs);
        const P = mesh.positions || (mesh.body && mesh.body.positions);
        assert.ok(P && P.length > 0, id + ' lofted mesh');
        for (let i = 0; i < P.length; i++) assert.ok(Number.isFinite(P[i]), id + ' finite mesh');
      }
    }
  });
}

test('hatchback: round-2 critique — dense backlight glass, clean wing fills, Golf tail, Civic hood/headlights, Yaris roof spoiler', () => {
  const by = Object.fromEntries(MODELS.map((m) => [m.id, m]));
  // backlight: glass-carrying rings spaced <= 0.03 m across the whole hatch, covering the real glass height
  for (const [id, x0, x1, y0, y1] of [['vw-golf-gti-mk8', -1.99, -1.86, 1.08, 1.36], ['toyota-gr-yaris', -1.74, -1.55, 1.05, 1.29], ['honda-civic-type-r-fl5', -2.03, -1.40, 1.12, 1.27]]) {
    const G = by[id].sections.filter((s) => s.x >= x0 - 0.005 && s.x <= x1 + 0.005 && s.glass.some((g, j) => g && s.ring[j][0] > 1.0));
    assert.ok(G.length >= 3, id + ' hatch glass rings');
    for (let i = 1; i < G.length; i++) assert.ok(G[i].x - G[i - 1].x <= (id.includes('civic') ? 0.075 : 0.031), id + ' backlight ring spacing at x=' + G[i].x);
    const ys = G.flatMap((s) => s.ring.filter((q, j) => s.glass[j] && Math.abs(q[1]) < 0.6).map((q) => q[0]));
    assert.ok(Math.min(...ys) <= y0 && Math.max(...ys) >= y1, id + ' backlight spans y ' + Math.min(...ys).toFixed(2) + '–' + Math.max(...ys).toFixed(2));
    // C-pillars stay body colour: no glass on the outer sides of hatch rings below the crown band
    for (const s of G) s.ring.forEach((q, j) => { if (s.glass[j] && x1 < -1.5) assert.ok(Math.abs(q[1]) <= 0.6, id + ' backlight width'); });
  }
  // Civic: the side wing is three separate gloss-black fills (no nonzero-winding cancellation)
  const wing = by['honda-civic-type-r-fl5'].details.filter((d) => d.view === 'side' && d.role === 'wing');
  assert.equal(wing.length, 3, 'Civic side wing: upright, endplate, blade');
  for (const d of wing) assert.equal(d.path.filter((sg) => sg.t === 'M').length, 1, 'one sub-path per wing fill');
  // rear-view compound wing/spoiler fills: every sub-path has the same winding
  const area = (sub) => { const P = sample(sub, 8); let a = 0; for (let i = 1; i < P.length; i++) a += P[i - 1][0] * P[i][1] - P[i][0] * P[i - 1][1]; return a; };
  for (const id of ['honda-civic-type-r-fl5', 'toyota-gr-yaris']) {
    const subs = []; let cur = null;
    by[id].rear.spoiler.path.forEach((sg) => { if (sg.t === 'M') { cur = []; subs.push(cur); } cur.push(sg); });
    const signs = new Set(subs.map((sb) => Math.sign(area(sb))));
    assert.equal(signs.size, 1, id + ' rear spoiler sub-paths share one winding');
  }
  // Golf: side fog patch is just the wrap-around; side taillight stays inside the body; shorter DLO
  const golf = by['vw-golf-gti-mk8'];
  const fogB = bounds(golf.details.find((d) => d.view === 'side' && d.role === 'grille').path);
  assert.ok(fogB.minX >= 2.10 && fogB.minY >= 0.25 && fogB.maxY <= 0.42, 'Golf side fog patch limited to the bumper wrap');
  const tl = golf.details.find((d) => d.view === 'side' && d.paint === 'light-red' && d.role === 'light');
  assert.ok(bounds(tl.path).minX >= -2.056, 'Golf side taillight inside the outline');
  assert.ok(bounds(golf.side.windows[2]).minX >= -1.365, 'Golf quarter glass ends at x -1.36');
  // Civic: headlights raised to y 0.655–0.757 under the raised hood edge
  const civic = by['honda-civic-type-r-fl5'];
  const hb = bounds(civic.front.headlights[0]);
  assert.ok(hb.minY > 0.65 && hb.maxY < 0.76, 'Civic headlights y ' + hb.minY.toFixed(3) + '–' + hb.maxY.toFixed(3));
  assert.ok(contains(civic.side.body, [2.13, 0.775]), 'Civic hood edge raised');
  // GR Yaris: plan greenhouse ends at -1.74, the roof spoiler ends ~0.05 m past the glass top (-1.62)
  const yaris = by['toyota-gr-yaris'];
  within(bounds(yaris.top.greenhouse).minX, -1.74, 0.003, 'Yaris top greenhouse rear end');
  within(bounds(yaris.details.find((d) => d.view === 'top' && d.role === 'spoiler').path).minX, -1.62, 0.003, 'Yaris top spoiler');
  // rounded 3D tails: the end cap spans most of the bumper height, the hood dips between the fender crowns
  for (const m of MODELS) {
    const cap = m.sections[0], ys = cap.ring.map((q) => q[0]);
    assert.ok(Math.max(...ys) - Math.min(...ys) > 0.3, m.id + ' tail cap height');
    const s = m.sections.reduce((a, b) => (Math.abs(b.x - 1.4) < Math.abs(a.x - 1.4) ? b : a));
    const crown = Math.max(...s.ring.map((q) => q[0]));
    assert.ok(crown - s.ring[20][0] > 0.01, m.id + ' hood dips at the centreline');
  }
});

test('hatchback: round-3 critique — plan-view sweep, flat waists, Golf rake, Civic wing/nose, Yaris hips, 3D surfacing', () => {
  const by = Object.fromEntries(MODELS.map((m) => [m.id, m]));
  const golf = by['vw-golf-gti-mk8'], civic = by['honda-civic-type-r-fl5'], yaris = by['toyota-gr-yaris'];
  within(golf.ref.height, 1.457, 0.001, 'GTI height');
  // plan view: ~0.10 m of sweep at z 0.60 at both ends; no lumps along the doors
  const zAt = (p, x) => { const P = sample(p, 32); let best = 0; for (let i = 1; i < P.length; i++) { const a = P[i - 1], b = P[i]; if ((a[0] - x) * (b[0] - x) <= 0 && a[0] !== b[0]) best = Math.max(best, Math.abs(a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]))); } return best; };
  for (const m of MODELS) {
    const b = bounds(m.top.body);
    assert.ok(zAt(m.top.body, b.maxX - 0.05) < 0.62, m.id + ' nose swept in plan (' + zAt(m.top.body, b.maxX - 0.05).toFixed(3) + ')');
    assert.ok(zAt(m.top.body, b.minX + 0.05) < 0.55, m.id + ' tail swept in plan');
    const zs = [-0.3, 0, 0.3, 0.6].map((x) => zAt(m.top.body, x));
    assert.ok(Math.max(...zs) - Math.min(...zs) < 0.012, m.id + ' door waist flat in plan (' + zs.map((z) => z.toFixed(3)).join(',') + ')');
  }
  // Golf: raked hatch (~0.2 m of run over the glass), roof spoiler proud of the falling roof
  const gs = sample(golf.side.body);
  const xAtY = (y) => Math.min(...gs.filter((q) => q[0] < -1.7 && Math.abs(q[1] - y) < 0.01).map((q) => q[0]));
  assert.ok(xAtY(1.30) - xAtY(1.02) > 0.13, 'Golf hatch rake (' + (xAtY(1.30) - xAtY(1.02)).toFixed(3) + ')');
  assert.ok(bounds(golf.top.greenhouse).minX >= -1.935 && bounds(golf.top.deck).minX >= -1.975, 'Golf plan greenhouse/deck end short of the tail');
  assert.equal(golf.front.grille[0].paint, 'gloss-black', 'Golf upper grille slot gloss-black');
  assert.ok(bounds(golf.front.grille[0].path).maxX >= 0.6, 'Golf upper slot spans to the lamps');
  assert.ok(bounds(golf.front.headlights[0]).maxX >= 0.875 || bounds(golf.front.headlights[1]).maxX >= 0.875, 'Golf headlamps wrap out to z 0.875');
  // Civic: thin endplate with daylight under it, upright standing on the hatch, blade flush behind the endplate
  const wing = civic.details.filter((d) => d.view === 'side' && d.role === 'wing').map((d) => bounds(d.path));
  const ep = wing.find((w) => w.h > 0.07 && w.w > 0.2), up = wing.find((w) => w.w < 0.06);
  assert.ok(ep && ep.minY >= 1.155 && ep.maxY <= 1.255, 'Civic endplate y 1.16–1.25');
  assert.ok(up && up.minY < 1.115 && up.maxY > 1.17, 'Civic upright stands on the hatch');
  assert.ok(contains(civic.side.body, [2.25, 0.765]) && !contains(civic.side.body, [2.30, 0.77]), 'Civic crisp hood leading edge');
  assert.ok(bounds(civic.front.bumper).maxX <= 0.91 && bounds(civic.front.body).maxX >= 0.94, 'Civic arch flares stand proud of the bumper');
  const vent = bounds(civic.details.find((d) => d.view === 'top' && d.role === 'vent').path);
  assert.ok(vent.w <= 0.125 && vent.h >= 0.55, 'Civic hood vent 0.55 × 0.12');
  // Yaris: haunches widest at y ~0.79, tucked under; shorter quarter glass; higher grille
  const rs = sample(yaris.rear.body).filter((q) => q[0] > 0);
  const peak = rs.reduce((a, q) => (q[0] > a[0] ? q : a));
  assert.ok(peak[1] > 0.74 && peak[1] < 0.84, 'Yaris rear haunch peak height ' + peak[1].toFixed(3));
  assert.ok(bounds(yaris.side.windows[1]).minX >= -0.985, 'Yaris quarter glass ends at -0.98');
  assert.ok(bounds(yaris.front.grille[0]).maxY >= 0.60, 'Yaris grille top raised');
  assert.ok(bounds(yaris.rear.greenhouse).minY >= 1.055, 'Yaris rear glass base raised');
  // 3D: widest ring height at the character line, ~0.025 m hood dip, square-ish tail corner
  for (const [m, wy] of [[golf, 0.88], [civic, 0.86], [yaris, 0.79]]) {
    const s = m.sections.reduce((a, b) => (Math.abs(b.x) < Math.abs(a.x) ? b : a));
    const half = s.ring.slice(0, 21), widest = half.reduce((a, q) => (q[1] > a[1] ? q : a));
    assert.ok(Math.abs(widest[0] - wy) < 0.09, m.id + ' widest z at y ' + widest[0].toFixed(3));
    assert.ok(widest[1] - half[2][1] > 0.03, m.id + ' tuck-under to the sill');
    const h = m.sections.reduce((a, b) => (Math.abs(b.x - 1.5) < Math.abs(a.x - 1.5) ? b : a));
    const crown = Math.max(...h.ring.map((q) => q[0]));
    assert.ok(crown - h.ring[20][0] > 0.015 && crown - h.ring[20][0] < 0.05, m.id + ' hood dip ' + (crown - h.ring[20][0]).toFixed(3));
    const tail = m.sections[1], wT = Math.max(...tail.ring.map((q) => Math.abs(q[1])));
    assert.ok(wT > 0.55, m.id + ' tail cap stays wide (corner radius ~0.12 m): ' + wT.toFixed(3));
  }
});

if (STANDALONE) {
  let pass = 0, fail = 0;
  for (const t of QUEUE) {
    try { t.fn(); pass++; console.log('  ok  ' + t.name); }
    catch (e) { fail++; console.log('  FAIL ' + t.name + '\n    ' + e.message); }
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}

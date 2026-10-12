/* FORGE Atelier — tests for js/shapes/models/hypercar.js (Ferrari SF90 Stradale, McLaren P1, Bugatti Chiron).
   Geometry sanity against the real cars' published dimensions, wheel arches on the axles sized for the real tire,
   symmetry of front/rear/top views, and (when js/shapes/core.js is present) fit() / toSvgPath(). */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');

const FILE = path.join(__dirname, '..', 'js', 'shapes', 'models', 'hypercar.js');
const CORE = path.join(__dirname, '..', 'js', 'shapes', 'core.js');
const SRC = fs.readFileSync(FILE, 'utf8');

/** Load the model file in a fresh context with no core: models must land in CB.shapes._pending. */
function loadIsolated() {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: FILE });
  return ctx.CB.shapes._pending || [];
}
const MODELS = loadIsolated();
const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]));

function isPath(v) { return Array.isArray(v) && v.length > 0 && v.every((s) => s && typeof s.t === 'string' && Array.isArray(s.p)); }
/** every path found anywhere in v (walks arrays and objects) */
function collectPaths(v, out) {
  out = out || [];
  if (isPath(v)) out.push(v);
  else if (Array.isArray(v)) v.forEach((e) => collectPaths(e, out));
  else if (v && typeof v === 'object') Object.keys(v).forEach((k) => collectPaths(v[k], out));
  return out;
}
/** sample a path into points, evaluating curves */
function sample(p, n) {
  n = n || 24;
  const pts = []; let cur = null, start = null;
  for (const s of p) {
    if (s.t === 'M') { cur = s.p[0]; start = cur; pts.push(cur); }
    else if (s.t === 'L') { cur = s.p[0]; pts.push(cur); }
    else if (s.t === 'C' || s.t === 'Q') {
      const c = [cur].concat(s.p);
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        let x, y;
        if (s.t === 'C') {
          x = u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0];
          y = u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1];
        } else {
          x = u * u * c[0][0] + 2 * u * t * c[1][0] + t * t * c[2][0];
          y = u * u * c[0][1] + 2 * u * t * c[1][1] + t * t * c[2][1];
        }
        pts.push([x, y]);
      }
      cur = s.p[s.p.length - 1];
    } else if (s.t === 'Z') { cur = start; }
  }
  return pts;
}
function bounds(paths) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  (isPath(paths) ? [paths] : paths).forEach((p) => sample(p).forEach((q) => {
    a = Math.min(a, q[0]); b = Math.max(b, q[0]); c = Math.min(c, q[1]); d = Math.max(d, q[1]);
  }));
  return { minA: a, maxA: b, minB: c, maxB: d, w: b - a, h: d - c };
}
function within(actual, expected, rel, msg) {
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * rel, `${msg}: expected ${expected} ±${rel * 100}% got ${actual.toFixed(4)}`);
}
function tireRadius(s) {
  const m = String(s).match(/(\d{3})\/(\d{2})Z?R(\d{2})/);
  return (+m[3] * 25.4 + 2 * +m[1] * +m[2] / 100) / 2000;
}
/** every control/anchor point of the given paths has a mirror image across the first coordinate = 0 */
function assertMirrorSymmetric(paths, msg) {
  const pts = [];
  paths.forEach((p) => p.forEach((s) => s.p.forEach((q) => pts.push(q))));
  const key = (a, b) => Math.round(a * 1e4) + ',' + Math.round(b * 1e4);
  const set = new Set(pts.map((q) => key(q[0], q[1])));
  const near = (a, b) => {
    for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) if (set.has((Math.round(a * 1e4) + da) + ',' + (Math.round(b * 1e4) + db))) return true;
    return false;
  };
  pts.forEach((q) => assert.ok(near(-q[0], q[1]), `${msg}: point (${q[0]}, ${q[1]}) has no mirror`));
}

test('hypercar: registers the 3 real models via _pending when core is absent', () => {
  assert.equal(MODELS.length, 3);
  ['ferrari-sf90-stradale', 'mclaren-p1', 'bugatti-chiron'].forEach((id) => assert.ok(byId[id], id));
  MODELS.forEach((m) => {
    assert.equal(m.style, 'hypercar');
    assert.equal(m.enginePosition, 'mid');
    assert.ok(m.make && m.name && m.years && m.signature && m.signature.headlights && m.signature.taillights && m.signature.grille);
    ['ice', 'ev', 'hybrid'].includes(m.powertrain) || assert.fail('powertrain');
  });
});

test('hypercar: published reference figures', () => {
  const exp = {
    'ferrari-sf90-stradale': { length: 4.710, width: 1.972, height: 1.186, wheelbase: 2.650, tireF: '255/35R20', tireR: '315/30R20' },
    'mclaren-p1': { length: 4.588, width: 1.946, height: 1.188, wheelbase: 2.670, tireF: '245/35R19', tireR: '315/30R20' },
    'bugatti-chiron': { length: 4.544, width: 2.038, height: 1.212, wheelbase: 2.711, tireF: '285/30R20', tireR: '355/25R21' }
  };
  MODELS.forEach((m) => {
    const e = exp[m.id], r = m.ref;
    Object.keys(e).forEach((k) => assert.equal(r[k], e[k], m.id + ' ref.' + k));
    within(r.frontOverhang + r.wheelbase + r.rearOverhang, r.length, 1e-6, m.id + ' overhangs + wheelbase = length');
    ['trackF', 'trackR', 'groundClearance', 'rideHeight', 'cd', 'curbWeight_kg', 'wheelDiameter_in'].forEach((k) => assert.ok(r[k] > 0, m.id + ' ' + k));
  });
});

test('hypercar: every path is well-formed and finite', () => {
  MODELS.forEach((m) => {
    const all = collectPaths([m.side, m.top, m.front, m.rear, m.details.map((d) => d.path)]);
    assert.ok(all.length > 60, m.id + ' has rich detail (' + all.length + ' paths)');
    all.forEach((p) => {
      assert.equal(p[0].t, 'M', m.id + ' path starts with M');
      p.forEach((s) => {
        assert.ok('MLCQZ'.includes(s.t), 'segment type ' + s.t);
        const need = { M: 1, L: 1, C: 3, Q: 2, Z: 0 }[s.t];
        assert.equal(s.p.length, need, m.id + ' ' + s.t + ' arity');
        s.p.forEach((q) => assert.ok(q.length === 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]), m.id + ' finite point'));
      });
    });
    m.details.forEach((d) => {
      assert.ok(['side', 'top', 'front', 'rear'].includes(d.view), 'detail view');
      assert.ok(typeof d.role === 'string' && typeof d.paint === 'string', 'detail role/paint');
    });
    m.rear.exhaust.forEach((e) => ['cx', 'cy', 'w', 'h'].forEach((k) => assert.ok(Number.isFinite(e[k]), 'exhaust ' + k)));
  });
});

test('hypercar: side body matches real length/height and sits on its axles', () => {
  MODELS.forEach((m) => {
    const r = m.ref, b = bounds(m.side.body);
    within(b.w, r.length, 0.01, m.id + ' side length');
    within(b.maxB, r.height, 0.01, m.id + ' side height');
    within(b.maxA, r.wheelbase / 2 + r.frontOverhang, 0.01, m.id + ' front bumper x');
    within(-b.minA, r.wheelbase / 2 + r.rearOverhang, 0.01, m.id + ' rear bumper x');
    assert.ok(Math.abs(b.minB - r.groundClearance) < 0.01, m.id + ' lowest body point = ground clearance');
    const gh = bounds(m.side.greenhouse);
    assert.ok(gh.maxB <= r.height + 1e-3 && gh.minB > 0.8, m.id + ' greenhouse in the upper body');
  });
});

test('hypercar: wheel arches centred on the axles and sized for the real tires', () => {
  MODELS.forEach((m) => {
    const r = m.ref, s = m.side, pts = sample(s.body, 48);
    [[s.archF, r.wheelbase / 2, r.tireF], [s.archR, -r.wheelbase / 2, r.tireR]].forEach(([a, x, tire]) => {
      const tr = tireRadius(tire);
      assert.ok(Math.abs(a.x - x) < 1e-6, m.id + ' arch x on axle');
      assert.ok(Math.abs(a.y - tr) < 0.002, m.id + ' arch centre at wheel-centre height');
      assert.ok(a.r > tr + 0.01 && a.r < tr + 0.06, m.id + ' arch radius clears the tire: ' + a.r + ' vs ' + tr);
      // the body outline actually traces the arch over the top of the wheel
      const onArch = pts.filter((q) => Math.abs(Math.hypot(q[0] - a.x, q[1] - a.y) - a.r) < 0.003 && q[1] > a.y);
      assert.ok(onArch.length > 10, m.id + ' body cut follows the arch');
      assert.ok(onArch.some((q) => Math.abs(q[0] - a.x) < 0.05 && q[1] > a.y + a.r - 0.005), m.id + ' arch apex present');
      // no body below the arch circle over the tire
      pts.forEach((q) => {
        if (Math.abs(q[0] - a.x) < tr * 0.9 && q[1] > 0.02) assert.ok(Math.hypot(q[0] - a.x, q[1] - a.y) >= a.r - 0.004, m.id + ' body intrudes into wheel');
      });
    });
  });
});

test('hypercar: top view width/length match, plan is symmetric', () => {
  MODELS.forEach((m) => {
    const r = m.ref, b = bounds(m.top.body);
    within(b.h, r.width, 0.01, m.id + ' top width');
    within(b.w, r.length, 0.01, m.id + ' top length');
    const flipped = (paths) => paths.map((p) => p.map((s) => ({ t: s.t, p: s.p.map((q) => [q[1], q[0]]) })));
    ['body', 'greenhouse', 'hood', 'roof', 'deck', 'mirrors'].forEach((k) =>
      assertMirrorSymmetric(flipped(collectPaths(m.top[k])), m.id + ' top.' + k));
    const mb = bounds(collectPaths(m.top.mirrors));
    assert.ok(mb.maxB > r.width / 2, m.id + ' mirrors stand proud of the body');
  });
});

test('hypercar: front and rear views symmetric about z = 0 and sized to the car', () => {
  MODELS.forEach((m) => {
    const r = m.ref;
    ['front', 'rear'].forEach((v) => {
      const b = bounds(m[v].body);
      within(b.w, r.width, 0.01, m.id + ' ' + v + ' width');
      within(b.maxB, r.height, 0.01, m.id + ' ' + v + ' height');
      Object.keys(m[v]).forEach((k) => {
        if (k === 'exhaust') return;
        assertMirrorSymmetric(collectPaths(m[v][k]), m.id + ' ' + v + '.' + k);
      });
      const vd = m.details.filter((d) => d.view === v).map((d) => d.path);
      assertMirrorSymmetric(vd, m.id + ' ' + v + ' details');
    });
    const xs = m.rear.exhaust.map((e) => Math.round(e.cx * 1e4)).sort((a, b) => a - b);
    assert.deepEqual(xs, xs.map((x) => 0 - x || 0).sort((a, b) => a - b), m.id + ' exhaust layout symmetric');
  });
});

test('hypercar: signature graphics present', () => {
  const sf = byId['ferrari-sf90-stradale'], p1 = byId['mclaren-p1'], ch = byId['bugatti-chiron'];
  assert.equal(sf.rear.taillights.length, 4, 'SF90 twin lamps per side');
  assert.equal(sf.rear.exhaust.length, 2, 'SF90 twin high exhausts');
  assert.equal(p1.rear.exhaust.length, 1, 'P1 single central exhaust');
  assert.ok(p1.details.some((d) => d.role === 'scoop' && d.view === 'top'), 'P1 roof snorkel');
  assert.ok(ch.rear.lightBar, 'Chiron full-width light bar');
  within(bounds(ch.rear.lightBar).w, 1.8, 0.05, 'Chiron light bar ~1.8 m');
  assert.equal(ch.front.drl.length, 8, 'Chiron quad projectors per lamp');
  assert.equal(ch.rear.exhaust.length, 4, 'Chiron quad tailpipes');
  assert.ok(ch.details.some((d) => d.view === 'side' && d.paint === 'chrome'), 'Chiron C-line');
});

if (fs.existsSync(CORE)) {
  test('hypercar: core fit() and toSvgPath() on the real models', () => {
    // fresh context: core first, then the model file
    const ctx = { console };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(CORE, 'utf8'), ctx, { filename: CORE });
    vm.runInContext(SRC, ctx, { filename: FILE });
    const S = ctx.CB.shapes;
    assert.equal(S.modelsByStyle('hypercar').length, 3);
    MODELS.forEach((src) => {
      const m = S.models[src.id];
      assert.ok(m, src.id + ' registered');
      assert.equal(S.getModel({ body: { style: 'hypercar', model: src.id } }).id, src.id);
      // reference build: real wheelbase, track and tires → identity-ish fit
      const r = m.ref, tf = S.parseTire(r.tireF);
      const same = S.fit(m, { body: { style: 'hypercar', wheelbase_mm: r.wheelbase * 1000 } });
      within(S.bounds(same.side.body).w, r.length, 0.01, src.id + ' fitted length');
      assert.ok(Math.abs(same.dims.wheelbase - r.wheelbase) < 1e-9);
      // longer wheelbase, bigger wheels, lower ride
      const f = S.fit(m, { body: { style: 'hypercar', wheelbase_mm: r.wheelbase * 1000 + 100 },
        wheels: { diameter_in: tf.rim_in + 1 }, suspension: { rideHeight_mm: r.rideHeight * 1000 - 20 } });
      within(f.dims.length, r.length + 0.1, 0.002, src.id + ' fitted dims.length');
      within(S.bounds(f.side.body).w, r.length + 0.1, 0.01, src.id + ' fitted body length');
      assert.ok(Math.abs(f.side.archF.x - f.dims.axleF) < 1e-6 && Math.abs(f.side.archR.x - f.dims.axleR) < 1e-6, 'arches follow axles');
      assert.ok(f.side.archF.r >= f.dims.wheelRadius, 'arch clears bigger wheel');
      const svg = S.toSvgPath(f.side.body, { scale: 100, flipY: true, ox: 300, oy: 200 });
      assert.match(svg, /^M [-\d.]+ [-\d.]+ /);
      assert.ok(!/NaN|undefined|Infinity/.test(svg), src.id + ' svg clean');
      ['top', 'front', 'rear'].forEach((v) => assert.ok(!/NaN/.test(S.toSvgPath(f[v].body, { scale: 100 })), v));
      const secs = S.sectionsFromViews(m, { stations: 32, ringVerts: 24 });
      assert.ok(secs.length >= 8, src.id + ' sections');
      const mesh = S.loftToMesh(secs);
      assert.ok(mesh.positions.length > 0 && Array.from(mesh.positions).every(Number.isFinite), src.id + ' mesh finite');
    });
  });
}

test('hypercar: explicit 3D sections carry the signature surfaces', () => {
  const near = (secs, x) => secs.reduce((b, s) => (Math.abs(s.x - x) < Math.abs(b.x - x) ? s : b));
  MODELS.forEach((m) => {
    const r = m.ref, secs = m.sections;
    assert.ok(Array.isArray(secs) && secs.length >= 60, m.id + ' has explicit sections');
    let prev = -Infinity;
    secs.forEach((s) => {
      assert.ok(s.x > prev, m.id + ' stations ascend'); prev = s.x;
      assert.equal(s.ring.length, 40, m.id + ' 40-vert rings');
      assert.equal(s.glass.length, 40, m.id + ' glass flags per vertex');
      s.ring.forEach((q) => {
        assert.ok(Number.isFinite(q[0]) && Number.isFinite(q[1]), m.id + ' finite ring');
        assert.ok(q[0] >= r.groundClearance - 0.01 && q[0] <= r.height + 0.005, m.id + ' ring inside the height envelope');
        assert.ok(Math.abs(q[1]) <= r.width / 2 + 0.005, m.id + ' ring inside the width envelope');
      });
      // mirror-symmetric ring
      for (let j = 1; j < 20; j++) {
        assert.ok(Math.abs(s.ring[j][0] - s.ring[40 - j][0]) < 1e-6 && Math.abs(s.ring[j][1] + s.ring[40 - j][1]) < 1e-6, m.id + ' ring symmetric');
      }
    });
    // twin front-wing domes over a low bonnet: crest (ring index 10) well above the bonnet centre (index 20)
    const fr = near(secs, 1.6);
    const dropF = fr.ring[10][0] - fr.ring[20][0];
    assert.ok(dropF > 0.08 && dropF < 0.18, m.id + ' wing domes above bonnet centre: ' + dropF.toFixed(3));
    assert.ok(Math.abs(fr.ring[10][1]) > 0.70 && Math.abs(fr.ring[10][1]) < 0.85, m.id + ' wing crest at z ~ ±0.78');
    // rear haunch crowns above the engine-cover valley
    const rr = near(secs, -1.8);
    const dropR = rr.ring[10][0] - rr.ring[20][0];
    assert.ok(dropR > 0.04 && dropR < 0.10, m.id + ' haunch crowns above the cover: ' + dropR.toFixed(3));
    // cabin: beltline half-width ~0.66–0.70, glass flagged on the side and on the windscreen
    const cb = near(secs, 0);
    assert.ok(cb.ring[13][1] >= 0.64 && cb.ring[13][1] <= 0.72, m.id + ' belt half-width ' + cb.ring[13][1]);
    assert.ok(cb.glass.slice(13, 17).every(Boolean), m.id + ' side glass flagged');
    assert.ok(near(secs, 0.5).glass[20] === 1, m.id + ' windscreen flagged');
    assert.ok(near(secs, 1.6).glass.every((g) => !g), m.id + ' no glass on the bonnet');
  });
});

test('hypercar: closed nose/tail, signature wheels, wing inside the plan', () => {
  const ext = (s) => { let lo = Infinity, hi = -Infinity, w = 0; s.ring.forEach((q) => { lo = Math.min(lo, q[0]); hi = Math.max(hi, q[0]); w = Math.max(w, Math.abs(q[1])); }); return { lo, hi, w }; };
  MODELS.forEach((m) => {
    const secs = m.sections, t0 = ext(secs[0]), n0 = ext(secs[secs.length - 1]);
    assert.ok(t0.w < 0.5 && t0.lo > 0.6, m.id + ' tail closes to a rounded cap: ' + JSON.stringify(t0));
    assert.ok(n0.w < 0.1, m.id + ' nose closes: ' + n0.w);
    // no 0.3 m jump in the tail lower edge between neighbouring stations
    for (let i = 0; i < 6; i++) assert.ok(Math.abs(ext(secs[i]).lo - ext(secs[i + 1]).lo) < 0.25, m.id + ' tail lower edge steps');
    assert.ok(m.wheel && m.wheel.spokes > 0 && /^#/.test(m.wheel.finish), m.id + ' wheel spec');
  });
  assert.equal(byId['ferrari-sf90-stradale'].wheel.spokes, 5);
  assert.equal(byId['mclaren-p1'].wheel.spokes, 10);
  assert.equal(byId['bugatti-chiron'].wheel.spokes, 5);
  assert.equal(byId['bugatti-chiron'].wheel.finish, '#c8ccd0', 'Chiron bright rim');
  assert.notDeepEqual([byId['bugatti-chiron'].wheel.spokes, byId['bugatti-chiron'].wheel.style],
    [byId['mclaren-p1'].wheel.spokes, byId['mclaren-p1'].wheel.style], 'Chiron and P1 rims differ');
  const p1 = byId['mclaren-p1'], wing = p1.details.find((d) => d.view === 'top' && d.role === 'spoiler');
  assert.ok(bounds(wing.path).maxB <= 0.81, 'P1 wing within the tail plan');
});

test('hypercar: critique round 2 (pointed plans, P1 lens depth, Chiron engine window, floor at ground clearance)', () => {
  const hwAt = (p, x) => { const P = sample(p, 24); let m = 0;
    for (let i = 0; i < P.length - 1; i++) { const a = P[i], b = P[i + 1];
      if (a[0] !== b[0] && (a[0] - x) * (b[0] - x) <= 0) m = Math.max(m, Math.abs(a[1] + (x - a[0]) / (b[0] - a[0]) * (b[1] - a[1]))); }
    return m; };
  const sf = byId['ferrari-sf90-stradale'], p1 = byId['mclaren-p1'], ch = byId['bugatti-chiron'];
  [[sf, [0.55, 0.75, 0.90]], [p1, [0.40, 0.58, 0.82]]].forEach(([m, want]) => {
    [2.3, 2.2, 2.0].forEach((x, i) => assert.ok(Math.abs(hwAt(m.top.body, x) - want[i]) < 0.03, m.id + ' plan half-width at ' + x));
  });
  // P1 swoosh: lens at least 0.07 m deep across its middle
  const hl = sample(p1.front.headlights[0], 24);
  [0.6, 0.7, 0.8].forEach((z) => { let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < hl.length - 1; i++) { const a = hl[i], b = hl[i + 1];
      if (a[0] !== b[0] && (a[0] - z) * (b[0] - z) <= 0) { const y = a[1] + (z - a[0]) / (b[0] - a[0]) * (b[1] - a[1]); lo = Math.min(lo, y); hi = Math.max(hi, y); } }
    assert.ok(hi - lo >= 0.068, 'P1 lens depth at z ' + z + ': ' + (hi - lo).toFixed(3)); });
  // Chiron: one tinted engine-cover window per side of the fin, x -1.2…-1.85, no black roof scoops on the deck
  const win = ch.details.filter((d) => d.view === 'top' && d.paint === 'glass');
  assert.equal(win.length, 2, 'Chiron engine-cover window halves');
  win.forEach((d) => { const b = bounds([d.path]); assert.ok(b.minA > -1.9 && b.maxA < -1.15, 'window x range'); });
  assert.ok(!ch.details.some((d) => d.view === 'top' && d.paint === 'black' && bounds([d.path]).maxA < -1.0), 'no Veyron roof scoops');
  // 3D floor between the axles sits at the published ground clearance
  [sf, p1, ch].forEach((m) => {
    const mid = m.sections.reduce((b, s) => (Math.abs(s.x) < Math.abs(b.x) ? s : b));
    const lo = Math.min.apply(null, mid.ring.map((q) => q[0]));
    assert.ok(Math.abs(lo - m.ref.groundClearance) < 0.006, m.id + ' floor at ground clearance: ' + lo);
  });
});

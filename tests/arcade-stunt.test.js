/* Redline — Arcade STUNT tracks (js/arcade/stunt-*.js, js/race/gl/stunt-mesh.js, js/race/gl/stunt-renderer.js).
   Frame continuity through loops (no flips), attachment / detachment rules, ballistic gap clearance, respawn,
   AI laps on every map, mesh triangle budgets, determinism + serialisable state, integration contract. */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = globalThis.test || ((n, f) => f());

const ROOT = path.join(__dirname, '..');
['js/arcade/stunt-track.js', 'js/arcade/stunt-maps.js', 'js/arcade/stunt-physics.js', 'js/arcade/stunt-ai.js', 'js/arcade/stunt-session.js',
  'js/race/gl/stunt-mesh.js', 'js/race/gl/stunt-renderer.js'].forEach((f) => require(path.join(ROOT, f)));
const CB = globalThis.CB;
const S = CB.arcade.stunt, P = S.physics, V = S._vec;
const IDS = ['loop-rush', 'canyon-leap', 'corkscrew-carnival', 'neon-wallride', 'mega-drop', 'figure-8'];
const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, V.dot(a, b))));

test('stunt: six authored maps register, build closed C1 tracks and list() carries the setup-screen data', () => {
  assert.deepEqual(S.ids().slice().sort(), IDS.slice().sort());
  const list = S.list();
  assert.equal(list.length, 6);
  list.forEach((e) => {
    assert.equal(e.kind, 'stunt'); assert.equal(e.stunt, true);
    ['id', 'name', 'theme', 'desc', 'tagline'].forEach((k) => assert.ok(typeof e[k] === 'string' && e[k].length, e.id + ' ' + k));
    assert.ok(e.length_m > 1800 && e.length_m < 4000, e.id + ' length ' + e.length_m);
    assert.ok(e.laps >= 2 && e.points.length > 50, e.id + ' laps / outline');
    assert.ok(/^<svg/.test(e.thumbnail) && e.thumbnail.indexOf('NaN') < 0, e.id + ' thumbnail');
  });
  IDS.forEach((id) => {
    const t = S.get(id), close = t.pieces.find((p) => p.type === 'close');
    assert.ok(Math.abs(close.length - 50) < 1, id + ' auto-closure solved to the 50 m run-in (' + close.length.toFixed(1) + ')');
    for (let i = 0; i < t.N; i++) {
      const j = (i + 1) % t.N;
      const T0 = [t.T[i * 3], t.T[i * 3 + 1], t.T[i * 3 + 2]], T1 = [t.T[j * 3], t.T[j * 3 + 1], t.T[j * 3 + 2]];
      const U0 = [t.U[i * 3], t.U[i * 3 + 1], t.U[i * 3 + 2]], U1 = [t.U[j * 3], t.U[j * 3 + 1], t.U[j * 3 + 2]];
      if (!(t.F[i] & t.FLAGS.gap)) assert.ok(ang(T0, T1) < 6 * Math.PI / 180, id + ' tangent kink at ' + i);
      assert.ok(ang(U0, U1) < 7 * Math.PI / 180, id + ' up-vector flip at ' + i);
      assert.ok(Math.abs(V.dot(T0, U0)) < 1e-6, id + ' frame orthonormal at ' + i);
    }
  });
});

test('stunt: loops really go upside down, the frame rotates continuously (rotation-minimising, no flips) and sample() interpolates', () => {
  const t = S.get('loop-rush'), loop = t.pieces.find((p) => p.type === 'loop');
  let minUp = 1, prev = t.sample(loop.s0).up, total = 0;
  for (let d = 0; d <= loop.length; d += 0.25) {
    const sm = t.sample(loop.s0 + d);
    minUp = Math.min(minUp, sm.up[1]);
    const a = ang(prev, sm.up);
    assert.ok(a < 0.08, 'smooth up at +' + d);
    total += a; prev = sm.up.slice();
    assert.ok(Math.abs(V.len(sm.up) - 1) < 1e-9 && Math.abs(V.dot(sm.up, sm.tangent)) < 1e-9);
  }
  assert.ok(minUp < -0.98, 'inverted at the top (' + minUp + ')');
  assert.ok(Math.abs(total - 2 * Math.PI) < 0.35, 'up turns one full revolution (' + total.toFixed(2) + ')');
  const top = t.sample(loop.s0 + loop.length / 2);
  assert.ok(top.kNormal > 0.05, 'concave loop curvature toward up');
  const cork = S.get('corkscrew-carnival').pieces.find((p) => p.type === 'corkscrew');
  const cs = S.get('corkscrew-carnival').sample(cork.s0 + cork.length / 2);
  assert.ok(cs.up[1] < -0.9, 'corkscrew is inverted halfway');
});

test('stunt: project() recovers (s, lateral, height) and picks the right level of stacked spiral track', () => {
  const t = S.get('mega-drop');
  [120, 700, 900, 1250, 1900].forEach((s) => {
    const p = t.pointAt(s, 2.5, 1.0);
    const pr = t.project(p, { hintS: s, window: 30 });
    assert.ok(pr && Math.abs(V.wrapD(pr.s - s, t.length)) < 0.6 && Math.abs(pr.lateral - 2.5) < 0.1 && Math.abs(pr.height - 1) < 0.1, 'project at ' + s);
  });
  // spiral: two levels 22 m apart share the same footprint
  const spiral = t.pieces.filter((p) => p.type === 'turn' && p.length > 300)[0];
  const lower = spiral.s0 + 100, pt = t.pointAt(lower, 0, 0.5);
  const pr2 = t.project(pt, { maxDist: 30 });
  assert.ok(Math.abs(V.wrapD(pr2.s - lower, t.length)) < 1, 'nearest level wins');
});

function makeCar(t, s, v) {
  const c = P.createCar({ id: 't', s: s, L: t.length, dist: s, v: v });
  c.drive = P.FALLBACK.create(null, {});
  return c;
}
function run(t, c, secs, input, extra) {
  const evs = [];
  for (let i = 0; i < Math.round(secs * 120); i++) {
    P.step(c, Object.assign({ track: t, dt: 1 / 120, drive: P.FALLBACK, input: input || { throttle: 0, brake: 0, steer: 0 }, assist: 'off', respawnPoint: () => ({ s: 5, dist: 5, speed: 15 }) }, extra || {}));
    if (c.events) { evs.push.apply(evs, c.events); c.events = null; }
  }
  return evs;
}

test('stunt physics: magnet adhesion — a fast car stays glued through the loop, a slow car drops out and respawns', () => {
  const t = S.get('loop-rush'), loop = t.pieces.find((p) => p.type === 'loop');
  const fast = makeCar(t, loop.s0 - 30, 32);
  const ev = run(t, fast, 5, { throttle: 1, brake: 0, steer: 0 });
  assert.ok(!ev.some((e) => e.type === 'drop' || e.type === 'fall'), 'no drop at speed');
  assert.ok(V.wrapD(fast.s - (loop.s0 + loop.length), t.length) > 0, 'made it round the loop');
  assert.equal(fast.mode, 'ground');
  // too slow at the top: coasting in at 15 m/s -> drops off (v < 35 km/h near the top), falls, lands / respawns
  const slow = makeCar(t, loop.s0 + loop.length * 0.4, 7);
  const ev2 = run(t, slow, 6, { throttle: 0, brake: 0, steer: 0 });
  assert.ok(ev2.some((e) => e.type === 'drop'), 'slow car detaches in the loop');
  assert.ok(ev2.some((e) => e.type === 'land' || e.type === 'respawnStart'), 'and comes back down');
});

test('stunt physics: ballistic gap at the design speed clears and lands on the far ramp; the jump assist rescues a slow launch', () => {
  const t = S.get('canyon-leap');
  t.gaps.forEach((g) => {
    const c = makeCar(t, g.s0 - 40, g.designSpeed * 1.02);
    const ev = run(t, c, 5, { throttle: 0.6, brake: 0, steer: 0 });
    const land = ev.find((e) => e.type === 'land');
    assert.ok(ev.find((e) => e.type === 'takeoff' && e.gap), 'takes off at the lip');
    assert.ok(land, 'lands (design ' + g.designSpeed.toFixed(1) + ' m/s)');
    assert.ok(V.wrapD(land.s - g.landS, t.length) > -1 && V.wrapD(land.s - g.landS, t.length) < 60, 'on the landing ramp');
    assert.ok(!ev.some((e) => e.type === 'fall'));
    assert.ok(land.air > 0.6 && land.air < 3.5, 'air time ' + land.air);
  });
  // assist: launch 30% under the design speed
  const g0 = t.gaps[0];
  const slow = makeCar(t, g0.s0 - 30, g0.designSpeed * 0.7);
  const evA = run(t, slow, 5, { throttle: 0, brake: 0, steer: 0 }, { assist: 'heavy' });
  assert.ok(evA.some((e) => e.type === 'land' && e.assisted), 'assisted landing');
  assert.ok(!evA.some((e) => e.type === 'fall'));
  // no assist and far too slow: falls into the canyon and respawns at the checkpoint
  const nope = makeCar(t, g0.s0 - 20, 12);
  const evN = run(t, nope, 6, { throttle: 0, brake: 0, steer: 0 }, { assist: 'off', jumpAssist: false });
  assert.ok(evN.some((e) => e.type === 'fall'), 'falls short');
  assert.ok(evN.some((e) => e.type === 'respawn'), 'respawns');
  assert.equal(nope.mode, 'ground');
  assert.ok(Math.abs(nope.s - 5) < 20, 'back at the checkpoint');
});

test('stunt physics: crests launch the car at speed, rails keep it on, landings compress the suspension', () => {
  const t = S.get('loop-rush'), hill = t.pieces.find((p) => p.type === 'hill');
  const c = makeCar(t, hill.s0 - 20, 40);
  const ev = run(t, c, 3, { throttle: 1, brake: 0, steer: 0 });
  assert.ok(ev.some((e) => e.type === 'takeoff' && e.crest), 'hill crest jump');
  const land = ev.find((e) => e.type === 'land');
  assert.ok(land && land.impact > 0);
  const r = makeCar(t, 40, 30);
  const evR = run(t, r, 3, { throttle: 1, brake: 0, steer: 1 });
  assert.ok(Math.abs(r.lat) <= t.sample(r.s).halfWidth - P.HALF_W + 1e-9, 'never leaves the rails');
  assert.ok(evR.some((e) => e.type === 'rail'), 'rail scrape event');
});

test('stunt AI: an AI car completes a lap on every stunt track without falling (and in a believable time)', () => {
  IDS.forEach((id) => {
    const s = S.createSession({ trackId: id, opponents: 2, laps: 1, seed: 3, playerAutopilot: true, items: false });
    s.simulate(130, {});
    const r = s.results();
    assert.equal(s.getPhase(), 'finished', id + ' finished');
    r.classification.forEach((c) => {
      assert.equal(c.status, 'finished', id + ' ' + c.name + ' finished');
      assert.equal(c.stunt.falls, 0, id + ' ' + c.name + ' never fell');
    });
    const t = r.classification[0].raceTime_s;
    assert.ok(t > 40 && t < 95, id + ' lap time ' + t);
  });
});

test('stunt AI: laps also complete on the built-in fallback drive model (no CB.race.vehicle)', () => {
  ['loop-rush', 'neon-wallride', 'mega-drop'].forEach((id) => {
    const s = S.createSession({ trackId: id, opponents: 2, laps: 1, seed: 8, playerAutopilot: true, items: false, drive: 'builtin' });
    s.simulate(130, {});
    assert.equal(s.getPhase(), 'finished', id);
    assert.equal(s.results().diagnostics.drive, 'stunt-fallback');
    s.results().classification.forEach((c) => { assert.equal(c.status, 'finished'); assert.equal(c.stunt.falls, 0, id + ' ' + c.name); });
  });
});

test('stunt session: engine-shaped snapshot / results, countdown, positions, hooks and the item API', () => {
  const seen = { pre: 0, post: 0, created: 0, ev: 0 };
  const hook = { carCreated: () => seen.created++, preStep: (c, inp) => { seen.pre++; return inp; }, postStep: () => seen.post++, onEvent: () => seen.ev++, snapshot: (c) => ({ tag: c.id }) };
  const s = S.createSession({ trackId: 'figure-8', opponents: 3, seed: 9, hooks: [hook], items: false });
  assert.equal(seen.created, 4);
  let snap = s.snapshot();
  assert.equal(snap.phase, 'grid'); assert.equal(snap.cars.length, 4); assert.equal(snap.kind, 'stunt');
  ['x', 'y', 'heading', 'speed', 'lap', 's', 'position', 'pos', 'fwd', 'up'].forEach((k) => assert.ok(k in snap.cars[0], 'car.' + k));
  assert.deepEqual(snap.cars[0].hook, { tag: snap.cars[0].id });
  s.simulate(2.5, {});
  assert.equal(s.snapshot().countdown.lightsOn > 0, true);
  s.simulate(3, { up: true });
  snap = s.snapshot();
  assert.equal(snap.phase, 'racing');
  const p = snap.cars.find((c) => c.isPlayer);
  assert.ok(p.speed > 5, 'player moving');
  s.applyBoost('player', 1, 1.3, 15);
  s.spinOut('ai1', 0.8);
  const id = s.spawn({ type: 'oil', s: 300, lat: 1, life: 2 });
  assert.ok(s.entities().some((e) => e.id === id));
  s.simulate(2.5, { up: true });
  assert.ok(!s.entities().some((e) => e.id === id), 'entity life expires');
  assert.ok(seen.pre > 100 && seen.post > 100 && seen.ev > 0);
  const r = s.results();
  assert.equal(r.kind, 'stunt'); assert.equal(r.classification.length, 4); assert.ok(r.player);
});

test('stunt session: deterministic replays — same cfg + inputs => identical runs; getState / setState continues bit-exactly', () => {
  const inputs = (k) => ({ up: true, left: k % 300 < 40, right: k % 500 > 460, nitro: k % 700 < 60 });
  function go(sess, from, to) { for (let k = from; k < to; k++) sess.update(1 / 60, inputs(k)); return JSON.stringify(sess.snapshot().cars.map((c) => [c.id, c.s, c.lateral, c.speed, c.mode, c.pos])); }
  const a = S.createSession({ trackId: 'canyon-leap', opponents: 3, seed: 21 }), b = S.createSession({ trackId: 'canyon-leap', opponents: 3, seed: 21 });
  assert.equal(go(a, 0, 1500), go(b, 0, 1500));
  const st = JSON.parse(JSON.stringify(a.getState()));
  const ca = go(a, 1500, 2600);
  const c = S.createSession({ trackId: 'canyon-leap', opponents: 3, seed: 21 });
  assert.ok(c.setState(st));
  assert.equal(go(c, 1500, 2600), ca, 'restored session continues identically');
});

test('stunt session: plugs into CB.arcade.mode-style engine hooks (arcade-gameplay contract: car.ctx / car.state / vehicleEnv)', () => {
  let views = 0, envCalls = 0;
  const gameplayLike = {
    name: 'arcade-gameplay',
    preStep: (car, inp) => { assert.ok(car.ctx && typeof car.ctx.t === 'number' && car.ctx.trackLength > 1000); assert.ok(typeof car.s === 'number' && typeof car.dist === 'number'); views++; return inp; },
    vehicleEnv: (car, env) => { envCalls++; return car.isPlayer ? Object.assign({}, env, { arcade: { push: 12, topSpeedMult: 1.3 } }) : env; },
    postStep: (car) => { assert.ok(car.state && typeof car.state.vx === 'number'); }
  };
  const s = S.createSession({ trackId: 'loop-rush', opponents: 1, seed: 4, hooks: [gameplayLike], handling: 'arcade' });
  assert.equal(s.gameplay, null, 'no second gameplay instance when the extension provides one');
  s.simulate(10, { up: true });
  assert.ok(views > 1000 && envCalls > 500);
  const p = s.snapshot().cars.find((c) => c.isPlayer);
  assert.ok(p.boosting, 'extension boost reaches the stunt drive');
});

test('stunt drive adapter: feature-detects CB.arcade.drive, falls back to the built-in grip-never-breaks model', () => {
  const auto = P.resolveDrive({}).id;
  assert.ok(auto === 'stunt-fallback' || auto === 'race-vehicle-arcadeResponse', auto);
  if (CB.race && CB.race.vehicle && CB.race.vehicle.arcadeResponse) assert.equal(auto, 'race-vehicle-arcadeResponse', 'uses the arcade vehicle model when loaded');
  assert.equal(P.resolveDrive({ drive: 'builtin' }).id, 'stunt-fallback');
  const custom = { id: 'x', create: () => ({}), step: () => ({ accel: 1, yawRate: 0 }) };
  assert.equal(P.resolveDrive({ drive: custom }), custom);
  CB.arcade.drive = custom;
  try { assert.equal(P.resolveDrive({}), custom); } finally { delete CB.arcade.drive; }
  const st = P.FALLBACK.create(null, {});
  const r = P.FALLBACK.step(st, { throttle: 1, steer: 1 }, { dt: 1 / 120, speed: 40, latMax: 20 });
  assert.ok(r.accel > 0 && Math.abs(r.yawRate * 40) <= 20 + 1e-9, 'yaw capped by the arcade lateral limit');
});

test('stunt mesh: triangle budgets per quality tier, no NaN, every group has geometry', () => {
  IDS.forEach((id) => {
    const t = S.get(id);
    const hi = CB.gl.stunt.buildGeometry(t, { quality: 'high' }), lo = CB.gl.stunt.buildGeometry(t, { quality: 'low' });
    assert.ok(hi.stats.total < 60000, id + ' high ' + hi.stats.total);
    assert.ok(lo.stats.total < 30000, id + ' low ' + lo.stats.total);
    assert.ok(lo.stats.total < hi.stats.total * 0.7);
    ['track', 'support', 'ground', 'deco'].forEach((k) => assert.ok(hi.groups[k].triangles > 0, id + ' ' + k));
    for (const k of Object.keys(hi.groups)) {
      const g = hi.groups[k];
      for (let i = 0; i < g.positions.length; i++) if (!Number.isFinite(g.positions[i])) throw new Error(id + ' NaN in ' + k);
      assert.equal(g.colors.length / 4, g.positions.length / 3);
    }
    assert.equal(hi.dynamic.lights.length, 5);
    assert.ok(hi.dynamic.boxes.length >= 8 && hi.dynamic.pads.length >= 2);
  });
});

test('stunt camera: the chase rig follows the track up-vector through a loop without flips', () => {
  const t = S.get('corkscrew-carnival'), rig = CB.arcade.stunt.renderer._.chaseRig;
  let st = {}, prevUp = null;
  const loop = t.pieces.find((p) => p.type === 'loop'), cork = t.pieces.find((p) => p.type === 'corkscrew');
  [[loop.s0 - 20, loop.s1 + 20], [cork.s0 - 20, cork.s1 + 20]].forEach(([a, b]) => {
    st = {}; prevUp = null;
    for (let s = a; s < b; s += 0.6) {
      const sm = t.sample(s);
      const r = rig(st, { pos: sm.pos, fwd: sm.tangent, up: sm.up }, 1 / 60, {});
      const f = V.norm(V.sub(r.target, r.eye));
      assert.ok(Math.abs(V.dot(f, r.up)) < 0.9, 'never looks along the up vector');
      if (prevUp) assert.ok(ang(prevUp, r.up) < 0.12, 'camera up never jumps');
      prevUp = r.up;
    }
  });
});

test('stunt integration: index.html loads the stunt modules before race-ui and the router', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  const order = ['js/arcade/stunt-track.js', 'js/arcade/stunt-maps.js', 'js/arcade/stunt-physics.js', 'js/arcade/stunt-ai.js', 'js/arcade/stunt-session.js', 'js/race/gl/stunt-mesh.js', 'js/race/gl/stunt-renderer.js'];
  let last = -1;
  order.forEach((f) => { const i = scripts.indexOf(f); assert.ok(i > last, f + ' in order'); last = i; });
  assert.ok(last < scripts.indexOf('js/race/race-ui.js') && last < scripts.indexOf('js/router.js'));
  assert.ok(scripts.indexOf('js/arcade/mode.js') < scripts.indexOf('js/arcade/stunt-track.js'));
  assert.equal(typeof S.createRenderer, 'function'); assert.equal(typeof S.drawThumb, 'function');
});

/* Redline — Arcade STUNT special features (js/arcade/stunt-track.js pieces tube / zerog / halfpipe / cannon / warp,
   js/arcade/stunt-features.js hazards, bumpers, flippers, belts, tunnels, springs, stars, rings of fire, drift zones,
   split lanes) on the 13 stunt maps: geometry, physics, callouts, AI, determinism and the authoring rules.
   Regression: "on the volcano cannon i fall through the ground after one of the ramps" — every gap / cannon lip hit from
   any lane, at an angle, crawling or at 90 m/s, steering in the air, lands on the deck (player helpers). */
'use strict';
const path = require('path');
const assert = require('node:assert/strict');
const test = globalThis.test || ((n, f) => f());

const SW = require(path.join(__dirname, '..', 'tools', 'stunt-sweep.js'));
const CB = SW.load();
const S = CB.arcade.stunt, P = S.physics, V = S._vec, Fe = S.features;
const NEW = ['tube-twister', 'volcano-cannon', 'pinball-wizard', 'sky-highway', 'toybox-bedroom', 'glacier-halfpipe', 'megacity-rooftops'];

function car(t, s, v, lat) {
  const c = P.createCar({ id: 'f', s: s, L: t.length, dist: s, v: v });
  c.drive = P.FALLBACK.create(null, {}); c.lat = lat || 0;
  return c;
}
function stepCar(t, c, n, o) {
  o = o || {};
  const ev = [];
  for (let i = 0; i < n; i++) {
    const inp = typeof o.input === 'function' ? o.input(c, i) : (o.input || { throttle: 1 });
    P.step(c, { track: t, dt: 1 / 120, drive: P.FALLBACK, input: inp, help: o.help || 'player', respawnPoint: () => ({ s: 0, dist: 0, speed: 15 }) });
    if (c.events) { ev.push.apply(ev, c.events); c.events = null; }
    if (o.features) Fe.step(c, { track: t, t: i / 120 + (o.t0 || 0), dt: 1 / 120, input: inp, emit: (k, d) => ev.push(Object.assign({ type: 'fx', kind: k }, d)) });
    if (c.events) { ev.push.apply(ev, c.events); c.events = null; }
    if (o.until && o.until(c, ev)) break;
  }
  return ev;
}
function session(id, o) {
  const fx = {}, resp = [];
  const obs = { name: 'obs', onEvent: (e) => { if (e.type === 'stuntFx') { const k = (e.isPlayer ? 'p:' : 'a:') + e.kind; fx[k] = (fx[k] || 0) + 1; } if (e.type === 'respawnStart') resp.push(e.carId + ':' + e.why); } };
  const s = CB.arcade.mode.createSession(Object.assign({ trackId: id, laps: 1, mode: 'race', opponents: 0, countdown: false, seed: 5, hooks: [obs], arcade: { options: { items: true, nitro: true } } }, o || {}));
  return { s, fx, resp };
}

test('stunt maps: 13 maps, the 7 new ones are 2-3 km with their headline features and themes', () => {
  const want = {
    'tube-twister': ['tube', 'zerog'], 'volcano-cannon': ['cannon'], 'pinball-wizard': ['loop'], 'sky-highway': ['warp', 'loop'],
    'toybox-bedroom': ['loop'], 'glacier-halfpipe': ['halfpipe', 'tube'], 'megacity-rooftops': ['cannon']
  };
  assert.equal(S.ids().length, 13);
  NEW.forEach((id) => {
    const t = S.get(id), e = S.list().find((x) => x.id === id);
    assert.ok(t.length > 2000 && t.length < 3100, id + ' length ' + t.length);
    want[id].forEach((ty) => assert.ok(t.pieces.some((p) => p.type === ty), id + ' has ' + ty));
    assert.ok(e.special.length >= 2 && e.thumbnail.indexOf('NaN') < 0 && S.THEME_COLORS[e.theme], id + ' setup entry');
  });
  assert.equal(S.get('tube-twister').pieces.filter((p) => p.type === 'tube' && p.turns === 2).length, 1, 'double barrel roll');
  assert.ok(S.get('sky-highway').warps.length >= 2 && S.get('sky-highway').pieces.some((p) => p.type === 'loop' && p.radius >= 20), 'warps + mega loop');
  assert.ok(S.get('sky-highway').gaps.some((g) => g.length >= 100), 'giant ski jump');
  assert.equal(S.get('volcano-cannon').gaps.filter((g) => g.cannon).length, 2, 'two cannons');
  ['pinball-wizard', 'toybox-bedroom', 'megacity-rooftops'].forEach((id) => assert.ok(S.get(id).splits.length >= 1, id + ' split'));
});

test('stunt maps: authoring rules — 3 stars, no hazard right before a stunt, no jump at a portal, no checkpoint in a split, no overlapping road', () => {
  S.ids().forEach((id) => {
    const t = S.get(id), L = t.length;
    assert.equal(t.features.filter((f) => f.type === 'star').length, 3, id + ' stars');
    const stunts = t.pieces.filter((p) => /loop|tube|zerog|corkscrew|gap|cannon|kicker/.test(p.type)).map((p) => p.s0);
    t.features.filter((f) => /hazard|bumper|spring|flipper/.test(f.type)).forEach((f) => {
      const d = Math.min.apply(null, stunts.map((s0) => V.wrapS(s0 - f.s, L)));
      assert.ok(d >= 100, id + ' ' + f.type + ' ' + (f.kind || '') + ' only ' + d.toFixed(0) + ' m before a stunt');
    });
    t.warps.forEach((w) => t.gaps.forEach((g) => assert.ok(Math.abs(V.wrapD(g.s0 - w.s, L)) > 30 && Math.abs(V.wrapD(g.landS - w.s, L)) > 30, id + ' jump at a portal')));
    t.checkpoints.forEach((c) => assert.ok(!(t.flagsAt(c.s) & t.FLAGS.split), id + ' checkpoint in a split'));
    // clearance: no two non-adjacent sections share space (loops / tubes / zero-g pass their own entry by design)
    for (let i = 0; i < t.N; i += 3) for (let j = i + 60; j < t.N; j += 3) {
      if (Math.abs(V.wrapD((j - i) * t.DS, L)) < 60) continue;
      if (t.piece[i] === t.piece[j] && t.piece[i] >= 0 && /loop|zerog|tube|corkscrew/.test(t.solvedPieces[t.piece[i]].type)) continue;
      const dx = t.P[i * 3] - t.P[j * 3], dy = t.P[i * 3 + 1] - t.P[j * 3 + 1], dz = t.P[i * 3 + 2] - t.P[j * 3 + 2];
      if (Math.abs(dy) >= 6.5) continue;
      const need = (t.W[i] + t.W[j]) / 2 + (id === 'figure-8' ? -1 : 0.5);
      assert.ok(Math.hypot(dx, dz) >= need, id + ' road overlaps itself at ' + i + ' / ' + j);
    }
  });
});

test('stunt pieces: barrel-roll tube and zero-g run go upside down smoothly; half-pipe swings both ways; warps jump in world, not in track space', () => {
  const tt = S.get('tube-twister'), ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, V.dot(a, b))));
  const dbl = tt.pieces.find((p) => p.type === 'tube' && p.turns === 2);
  let inv = 0, prev = tt.sample(dbl.s0).up;
  for (let d = 0; d < dbl.length; d += 0.5) { const sm = tt.sample(dbl.s0 + d); if (sm.up[1] < -0.9) inv++; assert.ok(ang(prev, sm.up) < 0.12, 'tube up continuous'); prev = sm.up; }
  assert.ok(inv > 10, 'double roll inverted twice');
  const zg = tt.pieces.find((p) => p.type === 'zerog'), c0 = zg.s0 + Math.PI * zg.radius;
  for (let d = 2; d < zg.ceilLen - 2; d += 2) assert.ok(tt.sample(c0 + d).up[1] < -0.97, 'ceiling run is upside down');
  const gh = S.get('glacier-halfpipe'), hp = gh.pieces.find((p) => p.type === 'halfpipe');
  let lo = 0, hi = 0;
  for (let d = 0; d < hp.length; d += 2) { const b = gh.sample(hp.s0 + d).bank; lo = Math.min(lo, b); hi = Math.max(hi, b); }
  assert.ok(lo < -30 && hi > 30, 'half-pipe banks both walls ' + lo.toFixed(0) + '/' + hi.toFixed(0));
  const sk = S.get('sky-highway');
  sk.warps.forEach((w) => {
    const a = sk.sample(w.s - 0.6), b = sk.sample(w.s + 0.6);
    assert.ok(V.len(V.sub(a.pos, b.pos)) > 100, 'portal mouths far apart');
    assert.ok(ang(a.tangent, b.tangent) < 0.05 && a.up[1] > 0.99 && b.up[1] > 0.99, 'level, same heading');
  });
});

test('stunt warp: a ground car goes through the portal keeping its speed, lane and progress; an airborne car is carried through too', () => {
  const t = S.get('sky-highway'), w = t.warps[0];
  const c = car(t, w.s - 30, 40, 2.5);
  const ev = stepCar(t, c, 240, { features: true, input: { throttle: 0.5 } });
  assert.equal(c.mode, 'ground');
  assert.ok(V.wrapD(c.s - w.s, t.length) > 20 && Math.abs(c.lat - 2.5) < 0.3 && c.v > 35, 'through, same lane and pace');
  assert.ok(ev.some((e) => e.type === 'fx' && e.kind === 'warp'), 'WARP! callout');
  // airborne at the mouth (a bump / hop right at the portal)
  const sm = t.sample(w.s - 3), p0 = t.pointAt(w.s - 3, 0, 1.2), a = car(t, w.s - 3, 40, 0);
  Object.assign(a, { mode: 'air', px: p0[0], py: p0[1], pz: p0[2], vx: sm.tangent[0] * 40, vy: 2, vz: sm.tangent[2] * 40, fx: sm.tangent[0], fy: 0, fz: sm.tangent[2], ux: 0, uy: 1, uz: 0, airT: 0.2, airS: w.s - 3, takeoffS: w.s - 6, takeoffDist: w.s - 6 });
  const ev2 = stepCar(t, a, 240, { until: (k) => k.mode !== 'air' });
  assert.equal(a.mode, 'ground', 'lands after the portal');
  assert.ok(ev2.some((e) => e.type === 'airWarp') && V.wrapD(a.s - w.s, t.length) > 0);
});

test('stunt cannon (regression "fell through the ground after a ramp"): every gap / cannon lip, any lane, angle, speed and air steering lands on the deck', () => {
  let n = 0;
  S.ids().forEach((id) => {
    const t = S.get(id);
    t.gaps.forEach((g) => {
      [8, 25, 45, 90].forEach((v0) => [-1, 0, 1].forEach((f) => [-0.4, 0.4].forEach((psi) => [-1, 1].forEach((st) => {
        if (!g.cannon && v0 < g.designSpeed) return;   // too slow for a plain gap is a genuine miss (mercy rule covers it)
        const c = car(t, g.s0 - 30, v0, 0);
        c.lat = f * (t.sample(c.s).halfWidth - 1.0); c.psi = psi;
        let took = false, land = null, fall = null;
        stepCar(t, c, 120 * 12, {
          input: (k) => ({ throttle: v0 < 20 ? 1 : 0.6, steer: k.mode === 'air' ? st : -k.psi * 2 }),
          until: (k, ev) => { ev.forEach((e) => { if (e.type === 'takeoff' && e.gap) took = true; if (e.type === 'land' && took && !land) land = e; if (e.type === 'fall') fall = e; }); ev.length = 0; return land || fall; }
        });
        n++;
        assert.ok(!fall, id + ' gap@' + g.s0.toFixed(0) + (g.cannon ? ' cannon' : '') + ' v' + v0 + ' lat' + f + ' psi' + psi + ' air' + st + ' fell');
        if (g.cannon && land) { const d = V.wrapD(land.s - g.landS, t.length); assert.ok(d > -0.5 && d < 40, 'cannon lands on the deck past the lip (' + d.toFixed(1) + ')'); }
      }))));
    });
  });
  assert.ok(n > 300, 'cases ' + n);
});

test('stunt cannon: crawling and Mega-Nitro cars leave on the same fixed arc', () => {
  const t = S.get('volcano-cannon'), g = t.gaps.find((q) => q.cannon);
  const speeds = [12, 70].map((v0) => {
    const c = car(t, g.s0 - 22, v0, 0);
    let v = null;
    stepCar(t, c, 120 * 8, { until: (k, ev) => { const e = ev.find((x) => x.type === 'takeoff' && x.cannon); if (e) v = e.speed; return v !== null; } });
    return v;
  });
  assert.ok(speeds[0] && Math.abs(speeds[0] - speeds[1]) < 1e-6 && speeds[0] > g.designSpeed, 'same launch speed ' + speeds);
});

test('stunt split lanes: the divider holds the lane, the inner lane of a bend is a real shortcut', () => {
  const t = S.get('megacity-rooftops'), q = t.splits.find((x) => x.len > 200);
  const run = (lat) => {
    const c = car(t, q.s0 - 20, 30, lat);
    let tm = 0, minRel = 1e9;
    stepCar(t, c, 120 * 20, {
      input: (k) => ({ throttle: k.v < 30 ? 1 : 0, steer: (lat > q.div ? -1 : 1) * 0.6 }),   // steer INTO the divider all the way
      until: (k) => { tm++; const si = P.splitInfo(t, k.s); if (k.lane && si && si.d >= 0 && k.mode === 'ground') minRel = Math.min(minRel, (k.lat - q.div) * k.lane); return V.wrapD(k.s - q.s1, t.length) > 0 && V.wrapD(k.s - q.s1, t.length) < 50; }
    });
    assert.ok(minRel >= q.dw + P.HALF_W - 1e-6, 'never crosses the divider (' + minRel.toFixed(2) + ')');
    return tm;
  };
  run(q.div + q.inner * 7); run(q.div - q.inner * 7);
  // a clean line through each lane at the same speed: the inner lane gains track progress (s) faster
  const lap = (lat) => {
    const c = car(t, q.s0 + 5, 30, lat);
    let tm = 0;
    stepCar(t, c, 120 * 20, {
      input: (k) => { const sm = t.sample(k.s), yaw = sm.kLeft * k.v + 3 * (0.2 * (lat - k.lat) - k.psi); return { throttle: k.v < 30 ? 1 : 0, steer: P.FALLBACK.steerFor(k.drive, yaw, k.v) }; },
      until: (k) => { tm++; return V.wrapD(k.s - (q.s1 - 5), t.length) > 0; }
    });
    return tm;
  };
  const inner = lap(q.div + q.inner * 6), outer = lap(q.div - q.inner * 6);
  assert.ok(inner < outer * 0.9, 'shortcut ' + inner + ' vs main line ' + outer + ' steps');
});

test('stunt hazards: pure functions of the race clock; a hit is a cartoon bump (spin / shove), never a fall or a stuck car', () => {
  const t = S.get('megacity-rooftops');
  t.hazards.forEach((f) => {
    const a = Fe.hazardState(f, 12.345, 7), b = Fe.hazardState(f, 12.345, 7), c = Fe.hazardState(f, 12.345 + (f.period || Fe.DEF_PERIOD[f.kind]), 7);
    assert.deepEqual(a, b); assert.ok(Math.abs(a.lat0 - c.lat0) < 1e-6 && a.active === c.active, f.kind + ' periodic');
  });
  let hits = 0;
  S.ids().forEach((id) => {
    const tr = S.get(id);
    tr.hazards.forEach((f) => {
      for (let k = 0; k < 6; k++) for (const lat of [-4, 0, 4]) {
        const c = car(tr, f.s - 40, 28, Math.max(-5, Math.min(5, lat + (f.lat || 0) * 0.2)));
        const ev = stepCar(tr, c, 120 * 4, { features: true, t0: k * 0.73, input: (q) => ({ throttle: 1, steer: -q.psi }) });
        hits += ev.filter((e) => e.type === 'fx' && e.kind === 'hazard').length;
        assert.ok(!ev.some((e) => e.type === 'fall' || e.type === 'drop' || e.type === 'respawnStart'), id + ' ' + f.kind + ' caused a fall / respawn');
        assert.equal(c.mode, 'ground'); assert.ok(c.v > 8, id + ' ' + f.kind + ' keeps rolling (' + c.v.toFixed(1) + ')');
        assert.ok(Math.abs(c.lat) <= tr.sample(c.s).halfWidth - P.HALF_W + 0.25, id + ' ' + f.kind + ' inside the rails');
      }
    });
  });
  assert.ok(hits > 20, 'hazards actually hit (' + hits + ')');
  // shielded / ghost cars are immune
  const f0 = t.hazards[0], g = car(t, f0.s - 30, 25, 0);
  g.arcadeFx = { shielded: true };
  const evS = stepCar(t, g, 120 * 6, { features: true, input: { throttle: 0.4 } });
  assert.ok(!evS.some((e) => e.type === 'fx' && e.kind === 'hazard'));
});

test('stunt features: bumpers bounce, flippers kick, belts / tunnels push, springs hop, stars and rings of fire pay nitro, drift zones too', () => {
  const pb = S.get('pinball-wizard'), bm = Fe.index(pb).by.bumper[2];
  const c = car(pb, bm.s - 30, 30, bm.lat);
  let ev = stepCar(pb, c, 240, { features: true, input: { throttle: 0.5 } });
  assert.ok(ev.some((e) => e.kind === 'bumper') && Math.abs(c.lat - bm.lat) > 1.5, 'bounced off the bumper');
  const fl = Fe.index(pb).by.flipper[0], hw = pb.sample(fl.s).halfWidth;
  let kicked = false;
  for (let k = 0; k < 12 && !kicked; k++) { const f2 = car(pb, fl.s - 12, 25, fl.side * (hw - 2.5)); kicked = stepCar(pb, f2, 120, { features: true, t0: k * 0.15, input: { throttle: 0.3 } }).some((e) => e.kind === 'flipper') && f2.boostT > 0; }
  assert.ok(kicked, 'flipper kick');
  const belt = Fe.index(pb).by.belt[0], b = car(pb, belt.s - 5, 20, 0), b2 = car(pb, belt.s - 5, 20, 0);
  stepCar(pb, b, 240, { features: true, input: { throttle: 0.3 } }); stepCar(pb, b2, 240, { input: { throttle: 0.3 } });
  assert.ok(b.v > b2.v + 2, 'belt pushes (' + b.v.toFixed(1) + ' vs ' + b2.v.toFixed(1) + ')');
  const tt = S.get('tube-twister'), tq = tt.tunnels[0], tc = car(tt, tq.s0 + 2, 25, 0);
  stepCar(tt, tc, 120, { features: true, input: { throttle: 0 } });
  assert.ok(tc.boostT > 0 && tc.v > 25, 'booster tunnel');
  const tb = S.get('toybox-bedroom'), sp = Fe.index(tb).by.spring[0], hc = car(tb, sp.s - 10, 30, sp.lat);
  ev = stepCar(tb, hc, 120 * 3, { features: true, input: { throttle: 0.5 } });
  assert.ok(ev.some((e) => e.kind === 'spring') && ev.some((e) => e.type === 'land') && hc.mode === 'ground', 'spring hop lands');
  const st = Fe.index(pb).by.star[0], sc = car(pb, st.s - 20, 25, st.lat);
  ev = stepCar(pb, sc, 120 * 2, { features: true, input: { throttle: 0.5, steer: 0 } });
  assert.ok(ev.some((e) => e.kind === 'star') && sc.feat.stars === 1 && sc.nitro > 0.1, 'star collected');
  const vr = S.get('volcano-cannon'), ring = Fe.index(vr).by.fire[0], rc = car(vr, ring.s - 20, 30, ring.lat);
  ev = stepCar(vr, rc, 120 * 2, { features: true, input: { throttle: 0.5 } });
  assert.ok(ev.some((e) => e.kind === 'fireRing') && rc.nitro > 0.15, 'ring of fire');
  const gh = S.get('glacier-halfpipe'), dz = Fe.index(gh).by.driftZone[0], dc = car(gh, dz.s - 5, 25, 0);
  stepCar(gh, dc, 120 * 3, { features: true, input: { throttle: 0.6, handbrake: true, steer: 0.5 } });
  assert.ok(dc.nitro > 0.1, 'drift zone nitro ' + dc.nitro);
});

test('stunt callouts: a full lap fires every headline callout (incl. mega loop, double barrel roll, shortcut, cannon, warp)', () => {
  const want = { 'tube-twister': ['barrelRoll', 'barrelRoll2', 'zeroG', 'tunnel'], 'sky-highway': ['warp', 'megaLoop', 'bigJump'], 'volcano-cannon': ['cannon', 'fireRing'],
    'glacier-halfpipe': ['halfpipe', 'driftZone'], 'megacity-rooftops': ['shortcut', 'mainLine', 'cannon'] };
  Object.keys(want).forEach((id) => {
    const r = session(id, { opponents: 3, difficulty: 'alien' });
    r.s.setPlayerAutopilot(true);
    r.s.simulate(100, {});
    want[id].forEach((k) => assert.ok(r.fx['p:' + k] || r.fx['a:' + k], id + ' ' + k + ' ' + JSON.stringify(r.fx)));
    assert.equal(r.resp.length, 0, id + ' respawns ' + r.resp);
  });
});

test('stunt AI: every new map finishes clean at rookie and alien; better drivers take more shortcuts', () => {
  const cuts = {};
  NEW.forEach((id) => ['rookie', 'alien'].forEach((d) => {
    const r = session(id, { opponents: 5, difficulty: d, laps: 1 });
    r.s.setPlayerAutopilot(true);
    r.s.simulate(140, {});
    assert.equal(r.s.getPhase(), 'finished', id + ' ' + d);
    const res = r.s.results();
    res.classification.forEach((c) => { assert.equal(c.status, 'finished', id + ' ' + d + ' ' + c.name); assert.equal(c.stunt.falls, 0, id + ' ' + d + ' ' + c.name + ' fell'); });
    assert.ok(res.classification[0].raceTime_s > 40 && res.classification[0].raceTime_s < 75, id + ' lap ' + res.classification[0].raceTime_s);
    cuts[d] = (cuts[d] || 0) + (r.fx['a:shortcut'] || 0) / Math.max(1, (r.fx['a:shortcut'] || 0) + (r.fx['a:mainLine'] || 0));
  }));
  assert.ok(cuts.alien > cuts.rookie, 'shortcut share alien ' + cuts.alien.toFixed(2) + ' > rookie ' + cuts.rookie.toFixed(2));
});

test('stunt features: determinism — getState / setState mid-hazard continues bit-exactly (feature state, cooldowns, stars)', () => {
  const inputs = (k) => ({ up: true, left: k % 400 < 50, right: k % 600 > 540, nitro: k % 900 < 80 });
  function go(sess, a, b) { for (let k = a; k < b; k++) sess.update(1 / 60, inputs(k)); return JSON.stringify(sess.snapshot().cars.map((c) => [c.id, c.s, c.lateral, c.speed, c.mode, c.spin])) + JSON.stringify(sess.results().classification.map((c) => c.stunt)); }
  ['megacity-rooftops', 'pinball-wizard'].forEach((id) => {
    const mk = () => S.createSession({ trackId: id, opponents: 3, seed: 31 });
    const a = mk(), b = mk();
    assert.equal(go(a, 0, 1800), go(b, 0, 1800), id + ' same inputs, same run');
    const st = JSON.parse(JSON.stringify(a.getState()));
    const ca = go(a, 1800, 3400), c = mk();
    assert.ok(c.setState(st));
    assert.equal(go(c, 1800, 3400), ca, id + ' restored session continues identically');
  });
});

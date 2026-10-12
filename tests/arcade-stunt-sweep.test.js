/* Redline — Arcade STUNT tracks as a HUMAN drives them (tools/stunt-sweep.js + targeted physics cases).
   Regression for "on one of the arcade maps I fall through the road after a ramp": project() measured heights against
   the per-sample planes, which step by 0.1–0.2 m at the outer lanes of banked / twisting sections (Corkscrew Carnival's
   bowl, Neon Wall-Ride's wall roll-ins), so a landing car could step from just above one plane to below the next and
   tunnel through the deck. Also covers: over-speed (Mega Nitro) gap launches, hill-crest moon shots, wall-entry drops at
   speed, edge landings, low bowl edges vs the ground plane, the respawn-loop mercy rule, and a full human input sweep
   (lateral offsets, speed / boost / item profiles, air inputs, car builds, assist levels, frame-rate profiles). */
'use strict';
const path = require('path');
const assert = require('node:assert/strict');
const test = globalThis.test || ((n, f) => f());

const SW = require(path.join(__dirname, '..', 'tools', 'stunt-sweep.js'));
const CB = SW.load();
const S = CB.arcade.stunt, P = S.physics, V = S._vec;

function airCar(t, s0, lat, h, fwd, sink) {
  const tg = t.sample(s0), p0 = t.pointAt(s0, lat, h);
  const c = P.createCar({ id: 'd', s: s0, L: t.length, dist: s0 });
  c.drive = P.FALLBACK.create(null, {});
  const vel = V.add(V.mul(tg.tangent, fwd), V.mul(tg.up, -sink));
  Object.assign(c, { mode: 'air', px: p0[0], py: p0[1], pz: p0[2], vx: vel[0], vy: vel[1], vz: vel[2], fx: tg.tangent[0], fy: tg.tangent[1], fz: tg.tangent[2],
    ux: tg.up[0], uy: tg.up[1], uz: tg.up[2], airT: 0.3, airS: s0, takeoffS: s0 - 10, takeoffDist: s0 - 10, prevH: h });
  return c;
}
function stepN(t, c, n, extra) {
  const ev = [];
  for (let i = 0; i < n; i++) {
    P.step(c, Object.assign({ track: t, dt: 1 / 120, drive: P.FALLBACK, input: {}, assist: 'off', jumpAssist: false, respawnPoint: () => ({ s: 0, dist: 0, speed: 15 }) }, extra || {}));
    if (c.events) { ev.push.apply(ev, c.events); c.events = null; }
    if (extra && extra.until && extra.until(c)) break;
  }
  return ev;
}

test('stunt project(): heights are continuous on the interpolated surface (no plane steps at the outer lanes of banks)', () => {
  SW.MAPS.forEach((id) => {
    const t = S.get(id);
    let worst = 0;
    for (let s = 0; s < t.length; s += 1.1) {
      const sm = t.sample(s);
      if (sm.flags & t.FLAGS.gap) continue;
      for (const f of [-0.95, -0.5, 0.5, 0.95]) {
        const pr = t.project(t.pointAt(s, f * sm.halfWidth, 0), { hintS: s, window: 30, surfaceOnly: true, maxDist: 5, lateralMargin: 1 });
        assert.ok(pr, id + ' projects at ' + s.toFixed(1));
        worst = Math.max(worst, Math.abs(pr.height));
      }
    }
    assert.ok(worst < 0.01, id + ' on-surface point off the surface by ' + worst.toFixed(3) + ' m');
  });
});

test('stunt landing: cars sinking onto the outer lanes anywhere on every map land (no tunnelling through banked decks)', () => {
  SW.MAPS.forEach((id) => {
    const t = S.get(id);
    let n = 0;
    for (let s = 3; s < t.length; s += 3.4) {
      const s0 = s - 4;
      let road = true;
      for (let q = s0 - 2; q <= s + 2; q += 0.5) if (t.flagsAt(q) & t.FLAGS.gap) road = false;
      if (!road || t.sample(s).up[1] < 0.3) continue;
      for (const f of [-1, 1]) for (const sink of [5, 9]) {
        const c = airCar(t, s0, f * (t.sample(s0).halfWidth - 1.1), 0.45, 40, sink);
        stepN(t, c, 120, { until: (k) => k.mode !== 'air' });
        n++;
        if (c.mode === 'air') {
          const pr = t.project([c.px, c.py, c.pz], { hintS: c.airS, window: 60, surfaceOnly: true, maxDist: 6, lateralMargin: 0 });
          assert.ok(!(pr && pr.height < -0.2), id + ' tunnelled under the deck at s ' + s.toFixed(1) + ' lat ' + f);
        } else assert.equal(c.mode, 'ground', id + ' fell through at s ' + s.toFixed(1) + ' lat ' + f + ' sink ' + sink);
      }
    }
    assert.ok(n > 500, id + ' cases ' + n);
  });
});

test('stunt landing: an edge landing (car centre beyond the road edge) is caught and pulled inside the rails', () => {
  const t = S.get('loop-rush'), s = 300, sm = t.sample(s);
  const c = airCar(t, s, sm.halfWidth + 1.2, 1.0, 30, 6);
  const ev = stepN(t, c, 120, { until: (k) => k.mode !== 'air' });
  assert.equal(c.mode, 'ground');
  assert.ok(Math.abs(c.lat) <= sm.halfWidth - P.HALF_W + 1e-9, 'inside the rails');
  assert.ok(ev.some((e) => e.type === 'land'));
});

test('stunt gaps: over-speed launches (nitro / Mega Nitro up to 2x the design speed) still land on the deck, every assist level', () => {
  SW.MAPS.forEach((id) => {
    const t = S.get(id);
    t.gaps.forEach((g) => {
      [1.3, 1.6, 2.0].forEach((k) => ['off', 'light', 'heavy'].forEach((assist) => {
        const c = P.createCar({ id: 'g', s: g.s0 - 12, L: t.length, dist: g.s0 - 12, v: Math.min(94, g.designSpeed * k) });
        c.drive = P.FALLBACK.create(null, {});
        const ev = stepN(t, c, 600, { assist: assist, input: { throttle: 1 }, until: (q) => q.landings > 0 || q.mode === 'respawn' });
        const land = ev.find((e) => e.type === 'land');
        assert.ok(land, id + ' gap@' + g.s0.toFixed(0) + ' x' + k + ' ' + assist + ' lands (no fall)');
        const d = V.wrapD(land.s - g.landS, t.length);
        assert.ok(d > -1 && d < 45, id + ' x' + k + ' lands on the deck (' + d.toFixed(1) + ' m past the lip)');
      }));
    });
  });
});

test('stunt crests: a Mega-Nitro car hops over a bunny hill instead of a 20 m moon shot; walls hold at 80 m/s', () => {
  const t = S.get('loop-rush'), hill = t.pieces.find((p) => p.type === 'hill');
  const c = P.createCar({ id: 'h', s: hill.s0 - 15, L: t.length, dist: hill.s0 - 15, v: 75 });
  c.drive = P.FALLBACK.create(null, {});
  let maxH = 0;
  for (let i = 0; i < 240; i++) {
    stepN(t, c, 1, { input: { throttle: 1 } });
    if (c.mode === 'air') { const pr = t.project([c.px, c.py, c.pz], { hintS: c.airS, window: 60, maxDist: 40, lateralMargin: 30 }); if (pr) maxH = Math.max(maxH, pr.height); }
  }
  assert.ok(maxH < 9, 'hop apex (above the road below; was ~20 m) ' + maxH.toFixed(1) + ' m');
  assert.notEqual(c.mode, 'respawn');
  const w = S.get('neon-wallride');
  w.pieces.filter((p) => p.type === 'wall').forEach((wall) => {
    const k = P.createCar({ id: 'w', s: wall.s0 - 20, L: w.length, dist: wall.s0 - 20, v: 80 });
    k.drive = P.FALLBACK.create(null, {});
    const ev = stepN(w, k, 240, { input: { throttle: 1 }, assist: 'heavy' });
    assert.ok(!ev.some((e) => e.type === 'drop'), 'no drop off the wall entry at 80 m/s');
  });
});

test('stunt ground plane sits below every road edge (a 50° bowl edge is road, not "fell off the world")', () => {
  SW.MAPS.forEach((id) => {
    const t = S.get(id);
    for (let i = 0; i < t.N; i++) {
      const y = t.P[i * 3 + 1] - Math.abs(t.R[i * 3 + 1]) * t.W[i] / 2;
      assert.ok(y > t.groundY + 2, id + ' road edge at ' + i + ' is ' + (y - t.groundY).toFixed(2) + ' m above the ground plane');
    }
  });
});

test('stunt mercy: assist Off, too slow for a gap twice -> the next attempt gets the light jump assist and lands', () => {
  const t = S.get('canyon-leap'), g = t.gaps[0];
  const c = P.createCar({ id: 'm', s: g.s0 - 20, L: t.length, dist: g.s0 - 20, v: 14 });
  c.drive = P.FALLBACK.create(null, {});
  const rp = () => ({ s: g.s0 - 20, dist: g.s0 - 20, speed: 14 });
  let falls = 0, landed = null;
  for (let i = 0; i < 120 * 40 && !landed; i++) {
    P.step(c, { track: t, dt: 1 / 120, drive: P.FALLBACK, input: { throttle: 0 }, assist: 'off', respawnPoint: rp });
    if (c.mode === 'ground' && c.v < 14) c.v = 14;
    (c.events || []).forEach((e) => { if (e.type === 'fall') falls++; if (e.type === 'land' && e.air > 0.5) landed = e; });
    c.events = null;
  }
  assert.equal(falls, P.MERCY_FALLS, 'falls ' + falls);
  assert.ok(landed && landed.assisted, 'third attempt is assisted and lands');
  assert.equal(c.fallStreak, 0);
});

test('stunt human sweep: lateral offsets x speeds / boosts / item hits x air inputs x builds x assists x frame rates — every map completes, no fall-through', () => {
  const res = SW.sweep(SW.MAPS, false);
  SW.MAPS.forEach((id) => {
    res[id].forEach((r) => {
      const p = r.profile, tag = id + ' ' + JSON.stringify(p);
      assert.equal(r.fallThrough.length, 0, 'fall-through ' + tag + ' ' + JSON.stringify(r.fallThrough));
      assert.equal(r.roadUnder.length, 0, 'respawned with the road under the car ' + tag);
      assert.equal(r.wrongAttach.length, 0, 'wrong re-attach ' + tag + ' ' + JSON.stringify(r.wrongAttach));
      assert.equal(r.launched.length, 0, 'launched off the world ' + tag);
      assert.equal(r.stuck.length, 0, 'stuck ' + tag);
      assert.equal(r.loopDrop.length, 0, 'dropped off a loop / wall at speed ' + tag);
      assert.ok(r.finished, 'lap completed ' + tag + ' progress ' + r.progress);
      if (p.assist !== 'off') assert.equal(r.falls, 0, 'no falls with assist ' + p.assist + ' ' + tag + ' ' + JSON.stringify(r.respawns));
      else assert.ok(r.falls <= 6, 'assist off: the mercy rule ends a respawn loop ' + tag + ' falls ' + r.falls);
    });
  });
});

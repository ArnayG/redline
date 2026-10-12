/* Per-discipline steering assist defaults (Race: light, Drift: heavy) + the keyboard drift steering model
   (js/race/drift/assist.js KB: 'off' self-aligning wheel, light / medium "steer relative to the slide").
   Run: node tests/run.js drift-keyboard   (or standalone: node tests/drift-keyboard.test.js) */
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });
const T = (n, f) => test('drift-keyboard: ' + n, f);

function load(rel) { const p = path.join(root, rel); if (fs.existsSync(p)) require(p); }
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/vehicle.js', 'js/race/ai.js', 'js/race/engine.js',
 'js/game/profile.js', 'js/game/challenges.js', 'js/race/drift/tune.js', 'js/race/drift/assist.js', 'js/race/drift/scoring.js', 'js/race/drift/tracks.js',
 'js/race/drift/ai.js', 'js/race/drift/arcade.js', 'js/race/drift/session.js', 'js/race/race-ui.js', 'js/game/hub.js'].forEach(load);
const CB = globalThis.CB;
const V = CB.race.vehicle, A = CB.race.assist, DEG = Math.PI / 180;

/* ------------------------------------------------------------ defaults + migration */
T('race-ui: Race defaults to light, Drift to heavy; the active level follows the discipline', () => {
  const _ = CB.race.ui._;
  const d = _.sanitizeSettings({});
  assert.equal(d.raceSteerAssist, 'light');
  assert.equal(d.driftSteerAssist, 'heavy');
  assert.equal(d.steerAssist, 'light');
  assert.equal(_.sanitizeSettings({ discipline: 'drift' }).steerAssist, 'heavy');
  assert.equal(_.sanitizeSettings({ discipline: 'drift', steerAssist: 'off' }).steerAssist, 'off', 'an explicit (launch) level is kept');
  const S = _.sanitizeSettings({});
  _.setDiscipline(S, 'drift');
  assert.equal(S.steerAssist, 'heavy', 'switching to drift picks the drift level');
  _.setAssist(S, 'light');
  assert.equal(S.driftSteerAssist, 'light'); assert.equal(S.raceSteerAssist, 'light');
  _.setDiscipline(S, 'race'); _.setAssist(S, 'off');
  assert.equal(S.raceSteerAssist, 'off'); assert.equal(S.driftSteerAssist, 'light', 'the other discipline keeps its own level');
  _.setDiscipline(S, 'drift');
  assert.equal(S.steerAssist, 'light');
  const arc = { discipline: 'arcade', steerAssist: 'heavy', raceSteerAssist: 'light', driftSteerAssist: 'heavy' };
  _.setAssist(arc, 'off');
  assert.equal(arc.raceSteerAssist, 'light'); assert.equal(arc.driftSteerAssist, 'heavy', 'arcade keeps its own store');
});

T('race-ui: old shared saves migrate — untouched (heavy) -> new defaults, an explicit pick is kept for both', () => {
  const _ = CB.race.ui._;
  const m = (o) => _.migrateAssist(Object.assign({}, o));
  let r = m({});
  assert.deepEqual([r.raceSteerAssist, r.driftSteerAssist, r.assistDefaultsV], ['light', 'heavy', 2]);
  r = m({ steerAssist: 'heavy' });
  assert.deepEqual([r.raceSteerAssist, r.driftSteerAssist], ['light', 'heavy'], 'the old default');
  r = m({ steerAssist: 'off' });
  assert.deepEqual([r.raceSteerAssist, r.driftSteerAssist], ['off', 'off'], 'explicitly chosen');
  r = m({ steerAssist: 'medium', raceSteerAssist: 'auto' });
  assert.deepEqual([r.raceSteerAssist, r.driftSteerAssist], ['auto', 'medium']);
  r = m({ assistDefaultsV: 2, steerAssist: 'off', raceSteerAssist: 'heavy', driftSteerAssist: 'light' });
  assert.deepEqual([r.raceSteerAssist, r.driftSteerAssist], ['heavy', 'light'], 'v2 saves are left alone');
  const s = _.syncAssist(_.sanitizeSettings(m({ steerAssist: 'heavy', discipline: 'drift' })));
  assert.equal(s.steerAssist, 'heavy');
});

T('hub: Settings → Driving / quick launches use the per-discipline level (race store, migration, setter)', () => {
  const H = CB.game && CB.game.hub && CB.game.hub._;
  if (!H || typeof H.steerAssistLevel !== 'function') return;
  const mem = {}, prev = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  try {
    assert.equal(H.steerAssistLevel('race'), 'light');
    assert.equal(H.steerAssistLevel('drift'), 'heavy');
    mem['forge.race.settings.v1'] = JSON.stringify({ steerAssist: 'heavy' });
    assert.equal(H.steerAssistLevel('race'), 'light', 'old untouched default');
    mem['forge.race.settings.v1'] = JSON.stringify({ steerAssist: 'medium' });
    assert.equal(H.steerAssistLevel('race'), 'medium'); assert.equal(H.steerAssistLevel('drift'), 'medium');
    H.setSteerAssistLevel('drift', 'light');
    const st = JSON.parse(mem['forge.race.settings.v1']);
    assert.equal(st.driftSteerAssist, 'light'); assert.equal(st.raceSteerAssist, 'medium', 'the other level is frozen as it was'); assert.equal(st.assistDefaultsV, 2);
    mem['forge.race.settings.v1'] = JSON.stringify({});
    assert.equal(H.raceSettings({ discipline: 'drift' }).steerAssist, 'heavy');
    assert.equal(H.raceSettings({ discipline: 'race' }).steerAssist, 'light');
    assert.equal(H.raceSettings({}).steerAssist, 'light');
  } finally { if (prev === undefined) delete globalThis.localStorage; else globalThis.localStorage = prev; }
});

T('career / challenges: no explicit assist -> the launch leaves the level to the discipline default', () => {
  const C = CB.game && CB.game.career;
  if (!C || typeof C.launchSpec !== 'function' || !C.championships) return;
  const champ = (C.championships || [])[0];
  if (!champ) return;
  const r = C.launchSpec({ settings: { steerAssist: 'heavy' } }, champ.id, 0, {});
  if (!r) return;
  assert.equal(r.params.assist, null);
  assert.ok(!r.params.settings.steerAssist, 'no shared profile level forced into the launch');
});

/* ------------------------------------------------------------ keyboard drift steering (physics) */
function params(id) {
  const b = id === 'ref' ? CB.data.referenceBuild() : id === 'def' ? CB.data.defaultBuild() : CB.data.presetBuild(id);
  const p = V.fromBuild(b);
  return CB.race.drift && CB.race.drift.tune ? CB.race.drift.tune.apply(p, { level: 'street', build: b }) : p;
}
function tarmac(level, id, kph, script, T0) {
  const p = params(id), a = A.create({ level: level, mode: 'drift' });
  const s = V.createState(p, { x: 0, y: 0, heading: 0, speed: kph / 3.6 }, { autoShift: true });
  const env = { assists: { tc: false, abs: true, autoShift: true } };
  const r = { beta: [], peak: 0, spun: false, inputs: [] };
  let t = 0;
  for (let i = 0; i < T0 * 60; i++) {
    const inp = a.filter(script(t), s, { dt: 1 / 60, params: p });
    r.inputs.push(inp);
    V.step(p, s, inp, 1 / 120, env); V.step(p, s, inp, 1 / 120, env); t += 1 / 60;
    const b = s.speed > 1.5 ? Math.atan2(s.vy, s.vx) / DEG : 0;
    r.beta.push(b); r.peak = Math.max(r.peak, Math.abs(b));
    if (Math.abs(b) > 85 || s.vx < -1) r.spun = true;
  }
  return r;
}

T('off (keyboard, drift mode): a quick arrow tap at speed on full throttle never spins (it did with raw steering)', () => {
  ['def', 'ref', 'muscle', 'hot-hatch'].forEach((id) => {
    [50, 80, 110].forEach((kph) => {
      [0.08, 0.15, 0.3].forEach((tap) => {
        const r = tarmac('off', id, kph, (t) => ({ up: true, left: t >= 0.5 && t < 0.5 + tap }), 4);
        assert.ok(!r.spun, id + ' @' + kph + ' km/h, ' + tap + ' s tap: spun (peak ' + r.peak.toFixed(0) + ' deg)');
      });
    });
  });
});

T('off: no key while sliding -> the wheel self-aligns (counter-steers); a held key still turns; gamepad / phone stay raw', () => {
  const p = params('def'), a = A.create({ level: 'off', mode: 'drift' });
  const car = { speed: 20, vxLocal: 20 * Math.cos(25 * DEG), vyLocal: -20 * Math.sin(25 * DEG), yawRate: 0.5, heading: 0, gear: 3 };
  let out;
  for (let i = 0; i < 20; i++) out = a.filter({ up: true }, car, { dt: 1 / 60, params: p });
  assert.ok(out.steer < -0.2, 'self-aligning counter-steer toward the travel direction (' + out.steer.toFixed(2) + ')');
  assert.equal(out.slideRack, true);
  for (let i = 0; i < 40; i++) out = a.filter({ up: true, left: true }, car, { dt: 1 / 60, params: p });
  assert.ok(out.steer > -0.2, 'holding left steers into the slide from there (' + out.steer.toFixed(2) + ')');
  const g = A.create({ level: 'off', mode: 'drift' });
  const og = g.filter({ steerAxis: 0.5, up: true }, car, { dt: 1 / 60, params: p });
  assert.ok(!og.slideRack && og.steer > 0.3, 'gamepad axis is proportional, no keyboard model');
  const ph = g.filter({ steerAxis: -0.25, steerAnalog: true, up: true }, car, { dt: 1 / 60, params: p });
  assert.equal(ph.steer, -0.25, 'phone wheel: linear');
  // race mode is untouched: off is raw digital
  assert.equal(A.create({ level: 'off', mode: 'race' }).filter({ right: true }, car, { dt: 1 / 60, params: p }).steer, -1);
});

T('light / medium: released arrow holds the slide; lifting ends it; a quick opposite tap swings into the other direction', () => {
  ['light', 'medium'].forEach((lv) => {
    const hold = tarmac(lv, 'def', 60, (t) => ({ up: true, left: t < 3 }), 5);
    const after = hold.beta.slice(Math.round(4.5 * 60));
    assert.ok(Math.min.apply(null, after.map(Math.abs)) > 12, lv + ': still sliding 1.5 s after releasing (' + after.map((b) => b.toFixed(0)).slice(-1) + ')');
    assert.ok(!hold.spun, lv + ': no spin');
    const lift = tarmac(lv, 'def', 60, (t) => ({ up: t < 3, left: t < 3 }), 6);
    assert.ok(Math.abs(lift.beta[lift.beta.length - 1]) < 6 && !lift.spun, lv + ': lifting straightens');
    const manji = tarmac(lv, 'def', 60, (t) => ({ up: true, left: t < 3, right: t >= 3 && t < 3.15 }), 6);
    const sideBefore = Math.sign(manji.beta[Math.round(2.9 * 60)]);
    const late = manji.beta.slice(Math.round(4.3 * 60), Math.round(5 * 60));
    assert.ok(late.every((b) => Math.sign(b) === -sideBefore && Math.abs(b) > 8), lv + ': switchback (' + late[0].toFixed(0) + ' deg)');
    assert.ok(!manji.spun, lv + ': switchback without a spin');
  });
});

T('vehicle: input.slideRack only widens the rack by the front axle sideslip (inert without the flag)', () => {
  const p = params('def');
  const mk = () => { const s = V.createState(p, { x: 0, y: 0, heading: 0, speed: 25 }, { autoShift: true }); s.vy = -6; s.yawRate = 0.4; return s; };
  const a = mk(), b = mk(), c = mk();
  const env = { assists: { tc: false, abs: true, autoShift: true } };
  V.step(p, a, { throttle: 0.5, steer: -1 }, 1 / 120, env);
  V.step(p, b, { throttle: 0.5, steer: -1, slideRack: false }, 1 / 120, env);
  V.step(p, c, { throttle: 0.5, steer: -1, slideRack: true }, 1 / 120, env);
  assert.equal(a.steerAngle, b.steerAngle);
  assert.ok(Math.abs(c.steerAngle) >= Math.abs(a.steerAngle), 'wider counter-steer authority while sliding');
});

/* ------------------------------------------------------------ novice keyboard drift runs (session) */
function curvAt(geom, s) {
  const S = geom.samples, L = geom.length; s = ((s % L) + L) % L;
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m].s <= s) lo = m; else hi = m; }
  return S[lo].curvature || 0;
}
/** Novice: Up held, the arrow toward each corner's inside (timing jitter), a handbrake stab on half the corners. */
function novice(trackId, level, seed, maxT) {
  const s = CB.race.drift.createSession({ trackId: trackId, mode: 'free', seed: seed, assist: level });
  let st = seed >>> 0 || 1; const rnd = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; };
  const R = { spins: 0, walls: 0, lap: 0 }; let t = 0, pend = 0, pendT = 0, cur = 0, last = 0, hbT = 0, spun = false;
  while (t < maxT) {
    let ps = s.playerState(); const raw = { up: true };
    const k = curvAt(s.geom, (ps.s || 0) + ps.speed * 0.6), want = k > 0.008 ? -1 : k < -0.008 ? 1 : 0;
    if (want !== pend) { pend = want; pendT = t + (rnd() * 0.8 - 0.4); }
    if (t >= pendT) cur = pend;
    if (cur !== last) { if (cur && rnd() < 0.5 && ps.speed > 11) hbT = t + 0.15; last = cur; }
    if (cur < 0) raw.left = true; else if (cur > 0) raw.right = true;
    if (t < hbT) raw.handbrake = true;
    s.update(1 / 60, raw); t += 1 / 60;
    const snap = s.snapshot();
    (snap.events || []).forEach((e) => { if (e.type === 'wall' && e.carId === 'player' && e.intensity > 0.05) R.walls++; });
    ps = s.playerState();
    const sp = ps.speed > 3 && (ps.angle_deg > 85 || ps.vxLocal < -1);
    if (sp && !spun) R.spins++;
    spun = sp;
    R.lap = snap.cars.filter((c) => c.isPlayer)[0].lap;
    const sc = snap.drift && snap.drift.scorer; if (sc) R.score = (sc.total || 0) + (sc.current || 0);
  }
  return R;
}

T('NOVICE light: Up + sloppy arrows + handbrake stabs drifts Dockyard Sliders and Circle Lab with real score, few spins / walls', () => {
  if (!CB.race.drift || !CB.race.drift.createSession) return;
  [['dockyard-sliders', 3], ['circle-lab', 7]].forEach(([tr, seed]) => {
    const R = novice(tr, 'light', seed, 200); if (process.env.DEBUG_KB) console.log(tr, JSON.stringify(R));
    assert.ok(R.spins <= 1, tr + ': spins ' + R.spins);
    assert.ok(R.walls <= 12, tr + ': walls ' + R.walls);
    assert.ok(R.lap >= 2, tr + ': at least one full lap in 200 s (lap ' + R.lap + ')');
    assert.ok(R.score > 4000, tr + ': real drift score (' + Math.round(R.score) + ')');
  });
});

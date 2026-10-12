/* FORGE Atelier — unified launch paths (UNIFY-SPEC § Router / Flow): career rounds, challenges, quick sessions and
   career Atelier sessions all go through CB.router.go(route, params); results come back via params.onFinish and the
   player returns to the originating screen. Run: node tests/run.js launch */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

const JS = '../js/';
['data.js', 'game/economy.js', 'game/profile.js', 'race/tracks.js', 'race/vehicle.js', 'race/ai.js', 'race/engine.js', 'race/drift/tracks.js',
  'game/achievements.js', 'game/career.js', 'game/challenges.js'].forEach((f) => { try { require(JS + f); } catch (e) { /* optional */ } });
const CB = globalThis.CB;
const C = CB.game.career, CH = CB.game.challenges;

function stubRouter(start) {
  const calls = [];
  let cur = { route: start || 'career', params: {} };
  const prev = CB.router, prevUI = CB.race && CB.race.ui, prevApp = CB.app;
  CB.router = { go(r, p) { calls.push([r, p]); cur = { route: r, params: p }; }, current() { return cur; } };
  if (CB.race) CB.race.ui = undefined;   // router-only path (the race-UI path is tested separately)
  CB.app = undefined;
  return { calls, restore() { CB.router = prev; if (CB.race) CB.race.ui = prevUI; CB.app = prevApp; }, set(r) { cur = { route: r, params: {} }; } };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('launch: career drift rounds route to #/drift with a CB.race.drift trial cfg; race rounds to #/race (3D)', () => {
  const d = C.launchSpec({}, 'rookie-drift-initiation', 0);
  assert.equal(d.route, 'drift');
  assert.equal(d.params.drift.mode, 'trial');
  assert.equal(d.params.settings.discipline, 'drift');
  assert.ok(d.params.drift.duration_s >= 90);
  const champ = C.listChampionships().find((c) => c.eventType === 'race');
  const r = C.launchSpec({}, champ.id, 0);
  assert.equal(r.route, 'race');
  assert.equal(r.params.settings.graphics, '3d');
  assert.equal(r.params.kind, 'career');
  assert.equal(r.params.assist, null, 'no explicit assist: the player\'s own level for the discipline applies');
  assert.equal(C.launchSpec({}, champ.id, 0, { assist: 'light' }).params.settings.steerAssist, 'light');
});

test('launch: career round goes through the router, records the drift result and returns to the origin', async () => {
  const R = stubRouter('career');
  try {
    if (CB.game.profile && CB.game.profile.reset) CB.game.profile.reset();
    assert.equal(C.launch('rookie-drift-initiation', 0), true);
    const [route, p] = R.calls[0];
    assert.equal(route, 'drift');
    assert.equal(p.returnTo, 'career');
    p.onFinish({ mode: 'practice', classification: [], drift: { total: 42000, bestDrift: 9000, maxCombo: 4, crashes: 0 } });
    p.onFinish({ mode: 'practice', classification: [], drift: { total: 1, bestDrift: 1 } });   // a second result is ignored
    if (CB.game.profile) {
      const cs = CB.game.profile.get().career.championships['rookie-drift-initiation'];
      assert.equal(cs.roundsCompleted, 1);
    }
    p.onClose();
    await tick();
    assert.equal(R.calls[1][0], 'career');
    assert.equal(R.calls[1][1]._from, 'drift');
  } finally { R.restore(); }
});

test('launch: navigating away before the session closes does not hijack the router', async () => {
  const R = stubRouter('career');
  try {
    C.launch(C.listChampionships().find((c) => c.eventType === 'race').id, 0, { record: false });
    const p = R.calls[0][1];
    R.set('garage');
    p.onClose();
    await tick();
    assert.equal(R.calls.length, 1);
  } finally { R.restore(); }
});

test('launch: drift challenges run on #/drift and are judged against the challenge ladder', async () => {
  const R = stubRouter('challenges');
  try {
    assert.equal(CH.launch('drift-trial'), true);
    const [route, p] = R.calls[0];
    assert.equal(route, 'drift');
    assert.equal(p.returnTo, 'challenges');
    const res = CH.resultFromSession(p.session, { drift: { total: 999999, maxCombo: 5, bestDrift: 12000 } });
    assert.equal(res.medal, 'platinum');
    assert.equal(CH.launch('launch-control'), true);
    assert.equal(R.calls[1][0], 'race');
    assert.equal(R.calls[1][1].kind, 'challenge');
  } finally { R.restore(); }
});

test('launch: career Atelier sessions route to #/atelier and open the configurator in the career mode', async () => {
  const R = stubRouter('career');
  try {
    let opened = null, confirmed = false;
    CB.app = { openAtelier(o) { opened = o; } };
    assert.equal(C.openAtelier('career-upgrade', { onConfirm() { confirmed = true; } }), true);
    assert.equal(R.calls[0][0], 'atelier');
    assert.equal(R.calls[0][1].mode, 'career-upgrade');
    assert.equal(opened.mode, 'career-upgrade');
    opened.onConfirm({});
    await tick();
    assert.ok(confirmed);
    assert.equal(R.calls[1][0], 'career');
  } finally { R.restore(); }
});

test('launch: with the race UI loaded, sessions go through CB.race.ui.open (which routes) carrying settings + callbacks', async () => {
  const R = stubRouter('career');
  try {
    let got = null;
    CB.race.ui = { open(build, cfg, cb) { got = { build, cfg, cb }; R.calls.push([cfg.discipline, cfg]); } };
    assert.equal(C.launch('rookie-drift-initiation', 0, { record: false }), true);
    assert.equal(got.cfg.discipline, 'drift');
    assert.equal(got.cfg.settings.discipline, 'drift');
    assert.equal(got.cfg.settings.driftMode, 'trial');
    assert.equal(got.cfg.context.kind, 'career');
    assert.equal(got.cfg.returnTo, 'career');
    assert.equal(typeof got.cb.onFinish, 'function');
    assert.equal(typeof got.cb.onClose, 'function');
  } finally { R.restore(); }
});

test('launch: quick race / drift use the current build and default to 3D', () => {
  const R = stubRouter('menu');
  try {
    assert.equal(C.launcher.race({ trackId: 'forge-ring' }), true);
    assert.equal(R.calls[0][0], 'race');
    assert.equal(R.calls[0][1].settings.graphics, '3d');
    assert.equal(R.calls[0][1].returnTo, 'menu');
    assert.equal(C.launcher.drift({ mode: 'tandem' }), true);
    assert.equal(R.calls[1][0], 'drift');
    assert.equal(R.calls[1][1].drift.mode, 'tandem');
  } finally { R.restore(); }
});

test('launch: cleanup (challenge layouts registered by the launches are removed again)', () => {
  if (typeof CH.unregisterTracks === 'function') CH.unregisterTracks();
  assert.ok(!CH.isRegistered());
});

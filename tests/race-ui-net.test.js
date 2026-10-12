/* Node tests for the multiplayer hook of js/race/race-ui.js (CB.race.ui.openNet): the pure net helpers driven with a
   fake CB.net.race session. Run: node tests/run.js race-ui-net */
'use strict';
const path = require('path');
const ui = require(path.join(__dirname, '..', 'js', 'race', 'race-ui.js'));
const _ = ui._;

function fakeSession(o) {
  o = o || {};
  const calls = { update: [], destroyed: 0, assists: null, level: null };
  let phase = o.phase || 'countdown', final = false, ended = null;
  const resultsFns = [], endFns = [];
  const s = {
    mode: o.mode || 'race',
    wantsRawInput: (o.mode || 'race') === 'drift',
    trackDef: { id: o.trackId || 'forge-ring', name: 'Redline Ring' },
    config: { trackId: o.trackId || 'forge-ring', laps: o.laps || 3, weather: o.weather || 'wet', timeOfDay: o.timeOfDay || 'night', net: true },
    geom: { L: 1000 },
    update(dt, input) { calls.update.push({ dt, input }); return 1; },
    snapshot() {
      return { phase: final || ended ? 'finished' : phase, cars: [], net: { battle: o.battle || null } };
    },
    results() { return { final, classification: [{ id: 'player', isPlayer: true, position: 1 }] }; },
    netState() {
      return { role: o.role || 'peer', connected: true, ping_ms: 42, players: [{ name: 'A', kind: 'human' }, { name: 'B', kind: 'human' }, { name: 'Bot', kind: 'ai' }],
               sync: { quality: 'good' }, final, ended };
    },
    playerState() { return { speed: 30, vxLocal: 30, vyLocal: 0, yawRate: 0, heading: 0 }; },
    setAssists(a) { calls.assists = a; },
    setAssistLevel(l) { calls.level = l; return l; },
    onResults(fn) { resultsFns.push(fn); return () => {}; },
    onEnd(fn) { endFns.push(fn); return () => {}; },
    destroy() { calls.destroyed++; },
    alpha() { return 0.5; },
    _calls: calls,
    _setPhase(p) { phase = p; },
    _final() { final = true; resultsFns.forEach((f) => f(s.results())); },
    _end(msg) { ended = { reason: 'host-left', message: msg }; endFns.forEach((f) => f(ended)); }
  };
  return s;
}

test('race-ui net: createRaceSession returns the provided net session first (rawInput from session.wantsRawInput)', () => {
  const race = fakeSession({ mode: 'race' });
  const R = { net: { session: race, cfg: {} } };
  assert.equal(_.netSessionFor(R), race);
  assert.equal(R.rawInput, false);
  const drift = fakeSession({ mode: 'drift' });
  const R2 = { net: { session: drift, cfg: {} } };
  assert.equal(_.netSessionFor(R2), drift);
  assert.equal(R2.rawInput, true);
  assert.equal(_.netSessionFor({}), null);
  assert.equal(_.netSessionFor({ net: {} }), null);
});

test('race-ui net: setup is locked to the session (track / mode / laps / conditions / drift format / assists)', () => {
  const s = fakeSession({ mode: 'race', trackId: 'gruenwald-ring', laps: 5 });
  const S = _.netSettings(s, { assists: { abs: false, tc: true }, maxSteerAssist: 'medium', trackId: 'other' }, { raceSteerAssist: 'heavy', assists: { abs: true } });
  assert.equal(S.discipline, 'race');
  assert.equal(S.trackId, 'gruenwald-ring');          // the session's track wins over the lobby cfg
  assert.equal(S.mode, 'race');
  assert.equal(S.laps, 5);
  assert.equal(S.weather, 'wet');
  assert.equal(S.timeOfDay, 'night');
  assert.equal(S.assists.abs, false);                 // forbidden by the host
  assert.equal(S.assists.steeringAssist, false);
  assert.equal(S.steerAssist, 'medium');              // heavy capped by the host's max
  const free = _.netSettings(fakeSession({ mode: 'free' }), {}, {});
  assert.equal(free.mode, 'practice');
  assert.equal(free.steerAssist, 'light');            // racing: light default
  const d = _.netSettings(fakeSession({ mode: 'drift', battle: { format: 'tandem' } }), { maxSteerAssist: 'auto' }, {});
  assert.equal(d.discipline, 'drift');
  assert.equal(d.driftMode, 'tandem');
  assert.equal(d.steerAssist, 'heavy');               // drift battle: heavy default (the player's drift level)
  assert.equal(_.netSettings(fakeSession({ mode: 'drift', battle: { format: 'tandem' } }), { maxSteerAssist: 'light' }, { driftSteerAssist: 'heavy' }).steerAssist, 'light', 'capped by the host');
  const atk = _.netSettings(fakeSession({ mode: 'drift', battle: { format: 'attack' } }), {}, {});
  assert.equal(atk.driftMode, 'trial');
  assert.equal(_.netSteerLevel('auto', 'light'), 'light');
  assert.equal(_.netSteerLevel('off', 'heavy'), 'off');
  assert.equal(_.netSteerLevel(undefined, undefined), 'heavy');
});

test('race-ui net: input gets the steering assist applied (heavy default) only while racing; drift feeds raw intent', () => {
  const s = fakeSession({ mode: 'race' });
  const seen = [];
  const assist = { filter(raw, car, ctx) { seen.push({ raw, car, ctx }); return { throttle: 0.7, brake: 0, steer: 0.25, handbrake: false }; } };
  const R = { net: { session: s }, session: s, netAssist: assist, rawInput: false,
              input: { lastIntent: { left: true, up: true } }, lastSnap: { phase: 'countdown' } };
  const engineIn = { throttle: 1, brake: 0, steer: 1, requestReset: true };
  assert.equal(_.netInput(R, engineIn), engineIn);    // grid / countdown: untouched (jump-start logic)
  R.lastSnap.phase = 'racing';
  const out = _.netInput(R, engineIn);
  assert.equal(out.steer, 0.25);
  assert.equal(out.throttle, 0.7);
  assert.equal(out.requestReset, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ctx.dt, _.STEP);
  assert.equal(seen[0].car.vxLocal, 30);            // session.playerState()
  // once the engine hook (CB.race.ui.netHooks via cfg.hooks) runs, no double application
  R.netHookSeen = true;
  assert.equal(_.netInput(R, engineIn), engineIn);
  // drift sessions run CB.race.assist themselves: raw key intent
  const Rd = { rawInput: true, input: { lastIntent: { right: true } } };
  assert.deepEqual(_.netInput(Rd, engineIn), { right: true });
});

test('race-ui net: netHooks preStep runs the active race assist for the player car only', () => {
  const hooks = ui.netHooks();
  assert.ok(Array.isArray(hooks) && typeof hooks[0].preStep === 'function');
  const R = { netAssist: { filter() { return { throttle: 0.5, brake: 0, steer: -0.3 }; } }, rawInput: false, input: { lastIntent: { right: true } } };
  _.netHookTarget.R = R;
  const inp = { throttle: 1, steer: 0 };
  assert.equal(hooks[0].preStep({ isPlayer: false }, inp, _.STEP), inp);
  assert.equal(hooks[0].preStep({ isPlayer: true, ctx: { phase: 'countdown', t: 0 } }, inp, _.STEP), inp);
  const o = hooks[0].preStep({ isPlayer: true, ctx: { phase: 'racing', t: 5 }, frozenUntil: 0, state: {} }, inp, _.STEP);
  assert.equal(o.steer, -0.3);
  assert.equal(R.netHookSeen, true);
  _.netHookTarget.R = null;
  assert.equal(hooks[0].preStep({ isPlayer: true, ctx: { phase: 'racing' } }, inp, _.STEP), inp);
});

test('race-ui net: results wait for the host (final) or the end of the session', () => {
  const s = fakeSession({ mode: 'race' });
  s._setPhase('racing');
  assert.equal(_.netFinished(s.snapshot(), s), false);
  s._final();
  assert.equal(_.netFinished(s.snapshot(), s), true);
  const s2 = fakeSession({ mode: 'race' });
  let msg = null;
  s2.onEnd((e) => { msg = e.message; });
  s2._end('The host left — session ended');
  assert.equal(msg, 'The host left — session ended');
  assert.equal(_.netFinished({ phase: 'racing' }, s2), true);
});

test('race-ui net: HUD status line from session.netState()', () => {
  const st = _.netStatusLine(fakeSession().netState());
  assert.equal(st.text, '42 ms · 2 drivers · sync good');
  assert.equal(st.quality, 'good');
  assert.match(_.netStatusLine(fakeSession({ role: 'host' }).netState()).text, /^Host · 2 drivers/);
  assert.equal(_.netStatusLine(null).quality, 'poor');
  assert.match(_.netStatusLine({ connected: false, players: [], sync: { quality: 'good' } }).text, /^Reconnecting/);
});

test('race-ui net: name tags for remote cars only, projected through the 3D camera', () => {
  const cam = { eye: [0, 2, 10], target: [0, 1.5, 0], up: [0, 1, 0], fov: 60, near: 0.1 };
  const project = (x, y) => _.projectThrough(cam, 1280, 720, x, y, 1.75);
  const snap = { cars: [
    { id: 'player', isPlayer: true, x: 0, y: -5, name: 'Me' },
    { id: 'p2', remote: true, kind: 'human', x: 0, y: 0, name: 'Alice', position: 2, color: '#ff0000' },
    { id: 'p3', remote: true, kind: 'human', x: 0, y: -40, name: 'Behind cam' },     // behind the camera (GL z = 40 > eye 10)
    { id: 'ai1', kind: 'ai', x: 3, y: 20, name: 'Bot' }
  ] };
  const tags = _.netTags(snap, project);
  const ids = tags.map((t) => t.id);
  assert.deepEqual(ids.sort(), ['ai1', 'p2']);
  const a = tags.find((t) => t.id === 'p2');
  assert.equal(a.text, 'Alice'); assert.equal(a.sub, 'P2');
  assert.ok(Math.abs(a.x - 640) < 1, 'centred');
  assert.ok(a.y < 360, 'above the horizon (tag height above the car)');
  assert.deepEqual(_.netTags(null, project), []);
});

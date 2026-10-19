/* Redline — Arcade stunt special features as the player sees / hears them: 'stuntFx' events from the stunt session
   (js/arcade/stunt-features.js) reach the announcer (arcade-hud.js), the SFX map (arcade-sfx.js) and the 2D FX through
   arcade-layer.js; the layer binds its gameplay instance into the session (stars / fire rings award nitro through it). */
'use strict';
const path = require('path');
const assert = require('node:assert/strict');
const test = globalThis.test || ((n, f) => f());
const ROOT = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/vehicle.js', 'js/race/ai.js', 'js/race/engine.js',
  'js/arcade/mode.js', 'js/arcade/stunt-track.js', 'js/arcade/stunt-maps.js', 'js/arcade/stunt-physics.js', 'js/arcade/stunt-features.js',
  'js/arcade/stunt-ai.js', 'js/arcade/stunt-session.js', 'js/arcade/items.js', 'js/arcade/nitro.js', 'js/arcade/gameplay.js', 'js/arcade/arcade-hud.js',
  'js/race/gl/arcade-fx.js', 'js/arcade/arcade-sfx.js', 'js/arcade/arcade-layer.js'].forEach((f) => require(path.join(ROOT, f)));
const CB = globalThis.CB;
if (CB.arcade.layer && CB.arcade.layer.register) CB.arcade.layer.register();

// an unregistered test map (passed as cfg.track) with one of every callout-worthy feature
const DEF = { id: 'hud-features-test', kind: 'stunt', stunt: true, name: 'HUD test', theme: 'lab', width: 13, startAt: 60, laps: 1, start: { pos: [0, 0, 0], heading: 0 },
  solve: { vars: [[9, 'len'], [8, 'radius'], [7, 'height']], gap: 50 },
  pieces: [
    { type: 'straight', len: 220, features: [{ type: 'bumper', at: 0.55, lat: 0 }, { type: 'star', at: 0.8, lat: 0 }, { type: 'ring', fire: true, at: 0.9, lat: 0, z: 0.5 }] },
    { type: 'tube', len: 90, radius: 7, turns: 1 },
    { type: 'straight', len: 80, features: [{ type: 'tunnel', at: 0.1, len: 60 }] },
    { type: 'zerog', radius: 14, len: 40 },
    { type: 'straight', len: 80, features: [{ type: 'pad', at: 0.7, lat: 0 }] },
    { type: 'warp', by: [0, 20, 120] },
    { type: 'straight', len: 100 },
    { type: 'climb', len: 90, height: -20 },
    { type: 'turn', angle: 180, radius: 60, bank: 20 },
    { type: 'straight', len: 300 },
    { type: 'turn', angle: 180, radius: 60, bank: 20 }
  ] };

test('stunt HUD: every special-feature kind has an announcer callout and a sound', () => {
  const kinds = Object.keys(CB.arcade.stunt.features.CALLOUTS);
  assert.ok(kinds.length >= 20);
  const sfx = CB.arcade.sfx.create({ muted: true });
  kinds.forEach((k) => {
    const c = CB.arcade.hud.calloutFor({ type: 'stuntFx', kind: k, carId: 'player', dist: 120, count: 2, total: 3, hz: 'pendulum' }, 'player');
    assert.ok(c && typeof c[0] === 'string' && c[0].length > 2, 'callout for ' + k);
    assert.equal(CB.arcade.hud.calloutFor({ type: 'stuntFx', kind: k, carId: 'ai1' }, 'player'), null, 'only the own car is announced (' + k + ')');
    const snd = CB.arcade.sfx.stuntSound(k);
    if (snd) assert.ok(sfx.SOUNDS.indexOf(snd) >= 0, 'sound ' + snd + ' for ' + k + ' exists');
  });
  assert.equal(CB.arcade.hud.calloutFor({ type: 'stuntFx', kind: 'bigJump', carId: 'p', dist: 142 }, 'p')[2], '142 m');
  assert.equal(CB.arcade.hud.calloutFor({ type: 'stuntFx', kind: 'mainLine', carId: 'p' }, 'p'), null, 'the safe main line stays quiet');
  // merging: a bumper chain is one callout with a counter
  const hud = CB.arcade.hud.create({});
  for (let i = 0; i < 4; i++) hud.events([{ type: 'stuntFx', kind: 'bumper', carId: 'player' }], 'player');
  const calls = hud._state.calls.filter((c) => c.text === 'BOING!');
  assert.equal(calls.length, 1); assert.ok(/×4/.test(calls[0].sub), calls[0].sub);
  hud.events([{ type: 'stuntFx', kind: 'star', carId: 'player', count: 2, total: 3 }], 'player');
  assert.equal(hud._state.stars, 2);
  sfx.destroy();
});

function stubCtx() {
  const noop = () => {};
  const grad = { addColorStop: noop };
  return new Proxy({ canvas: { clientWidth: 1280, clientHeight: 720 } }, {
    get(t, k) { if (k in t) return t[k]; if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => grad; if (k === 'measureText') return () => ({ width: 10 }); return noop; },
    set(t, k, v) { t[k] = v; return true; }
  });
}

test('stunt HUD: a raced lap feeds BARREL ROLL / ZERO-G / WARP / BOOST TUNNEL / RING OF FIRE callouts; nitro goes through the bound gameplay layer', () => {
  const sess = CB.arcade.mode.createSession({ track: DEF, trackId: DEF.id, laps: 1, mode: 'race', opponents: 0, countdown: false, seed: 5, arcade: { options: { items: true, nitro: true } } });
  const inst = sess.arcade.instances.filter((i) => i.id === 'gameplay')[0];
  assert.ok(inst && inst.gameplay);
  const gp = inst.gameplay, srcs = {}, seen = [];
  const add = gp.addNitro; gp.addNitro = function (id, a, src) { srcs[src] = (srcs[src] || 0) + 1; return add.apply(gp, arguments); };
  const evs = inst.hud.events; inst.hud.events = function (list, me) { (list || []).forEach((e) => { if (e.type === 'stuntFx') seen.push(e.kind); }); return evs.apply(inst.hud, arguments); };
  assert.equal(inst.hud._state.starsTotal, 1, 'star counter total (1 star x 1 lap)');
  sess.setPlayerAutopilot(true);
  const ctx = stubCtx();
  let t = 0;
  while (t < 150 && sess.getPhase() !== 'finished') {
    sess.update(1 / 60, {}); t += 1 / 60;
    const snap = sess.snapshot();
    sess.arcade.drawHud(ctx, snap, { width: 1280, height: 720 });
    sess.arcade.drawHud(ctx, snap, { width: 1280, height: 720 });   // same snapshot twice: no double callouts
  }
  assert.equal(sess.getPhase(), 'finished', 'lap completed');
  ['barrelRoll', 'zeroG', 'warp', 'tunnel', 'fireRing'].forEach((k) => assert.ok(seen.indexOf(k) >= 0, 'saw ' + k + ' in ' + JSON.stringify(seen)));
  assert.equal(seen.filter((k) => k === 'warp').length, 1, 'each event processed once');
  assert.ok(srcs.fireRing >= 1, 'fire ring nitro through the bound gameplay instance ' + JSON.stringify(srcs));
  sess.destroy && sess.destroy();
});

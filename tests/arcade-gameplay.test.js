/* Node tests for the Arcade gameplay layer: js/arcade/items.js, nitro.js, gameplay.js (+ CB.race.engine integration). */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');
function tryLoad(rel) {
  var p = path.join(root, rel);
  if (!fs.existsSync(p)) return false;
  try { require(p); return true; } catch (e) { return false; }
}
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js'].forEach(tryLoad);
var REAL = tryLoad('js/race/tracks.js') && tryLoad('js/race/vehicle.js') && tryLoad('js/race/ai.js');
require(path.join(root, 'js/race/engine.js'));
require(path.join(root, 'js/arcade/items.js'));
require(path.join(root, 'js/arcade/nitro.js'));
require(path.join(root, 'js/arcade/gameplay.js'));
var CB = globalThis.CB;
var IT = CB.arcade.items, NZ = CB.arcade.nitro, GP = CB.arcade.gameplay;

var T = typeof globalThis.test === 'function' ? function (n, f) { globalThis.test('arcade: ' + n, f); } : function (n, f) { try { f(); console.log('ok', n); } catch (e) { console.log('FAIL', n, e); process.exitCode = 1; } };

/* ---------------- kinematic harness: cars running along a 2 km loop in track space ---------------- */
function harness(opts, cars) {
  var L = 2000;
  var gp = GP.create(Object.assign({ seed: 11, layout: [], track: { length: L } }, opts || {}));
  var t = 0;
  cars = cars.map(function (c, i) { return Object.assign({ id: 'c' + i, isPlayer: i === 0, s: 0, lat: 0, speed: 30, vTop: 60, throttle: 1, steer: 0, base: 30 }, c); });
  function order() {
    var o = cars.slice().sort(function (a, b) { return b.s - a.s; });
    o.forEach(function (c, i) { c.position = i + 1; });
  }
  var H = {
    gp: gp, cars: cars, L: L,
    step: function (n, phase) {
      for (var k = 0; k < (n || 1); k++) {
        t += 1 / 120; order();
        gp.step(1 / 120, { t: t, phase: phase || 'racing', trackLength: L, cars: cars.map(function (c) {
          return { id: c.id, isPlayer: c.isPlayer, s: ((c.s % L) + L) % L, dist: c.s, lap: Math.floor(c.s / L), lat: c.lat, speed: c.speed, position: c.position, vTop: c.vTop, throttle: c.throttle, steer: c.steer, airborne: !!c.airborne };
        }) });
        cars.forEach(function (c) {
          var f = gp.effects(c.id), dt = 1 / 120;
          // the car's own "engine": relax toward its base cruise speed scaled by throttle
          var target = c.base * f.throttleMult;
          c.speed += (target - c.speed) * Math.min(1, 0.6 * dt);
          if (f.push > 0 && c.speed < f.vTarget) c.speed = Math.min(f.vTarget, c.speed + f.push * dt);
          if (f.brakeTo != null && c.speed > f.brakeTo) c.speed = Math.max(f.brakeTo, c.speed - f.brakeDecel * dt);
          if (phase === 'grid' || phase === 'countdown') c.speed = 0;
          c.s += c.speed * dt;
        });
      }
    },
    seconds: function (s, phase) { H.step(Math.round(s * 120), phase); },
    kart: function (i) { return gp.kart('c' + i); }
  };
  return H;
}

/* ---------------- nitro meter ---------------- */
T('nitro meter fills from sources, clamps, and burns at BURN_RATE', function () {
  var m = NZ.createMeter();
  assert.ok(NZ.gain(m, 'canister') > 0.3);
  NZ.gain(m, 'nearMiss'); NZ.gain(m, 'overtake');
  assert.ok(Math.abs(m.level - (NZ.GAIN.canister + NZ.GAIN.nearMiss + NZ.GAIN.overtake)) < 1e-9);
  NZ.gain(m, 'x', 5);
  assert.strictEqual(m.level, 1);
  for (var i = 0; i < 120; i++) NZ.burn(m, 1 / 120, true);
  assert.ok(Math.abs(m.level - (1 - NZ.BURN_RATE)) < 1e-6);
  assert.ok(m.burning);
  NZ.burn(m, 1 / 120, false);
  assert.ok(!m.burning);
  var e = NZ.createMeter(0.03);
  assert.ok(!NZ.burn(e, 1 / 120, true), 'needs MIN_START to ignite');
});
T('rev gauge: sweet zone gives a rocket start, pinning it floods', function () {
  var r = NZ.createRev();
  var tUp = (NZ.REV.perfectLo + NZ.REV.perfectHi) / 2 / NZ.REV.up;
  for (var t = 0; t < tUp; t += 1 / 120) NZ.revStep(r, 1 / 120, 1);
  assert.strictEqual(NZ.revResult(r).grade, 'perfect');
  for (t = 0; t < 1.5; t += 1 / 120) NZ.revStep(r, 1 / 120, 1);
  assert.strictEqual(NZ.revResult(r).grade, 'over');
  var r2 = NZ.createRev();
  assert.strictEqual(NZ.revResult(r2).grade, 'none');
  NZ.revStep(r2, NZ.REV.sweetLo / NZ.REV.up + 0.01, 1);
  assert.strictEqual(NZ.revResult(r2).grade, 'good');
});
T('powerslide tiers blue -> orange -> purple', function () {
  assert.strictEqual(NZ.driftTier(0.5), 0);
  assert.strictEqual(NZ.driftTier(1.0), 1);
  assert.strictEqual(NZ.driftTier(2.5), 2);
  assert.strictEqual(NZ.driftTier(4), 3);
});

/* ---------------- items ---------------- */
T('item weights depend on position (catch-up for the back of the pack)', function () {
  var lead = IT.weightsFor(0, { nCars: 8 }), last = IT.weightsFor(1, { nCars: 8 });
  assert.ok(!lead.lightning && !lead.mega && !lead.magnet, 'leader never gets catch-up items');
  assert.ok(last.lightning > 0 && last.mega > lead.oil * 0.3);
  assert.ok(lead.oil > last.oil && lead.shield > last.shield);
  assert.ok(!IT.weightsFor(1, { nCars: 3 }).lightning, 'lightning needs >= 4 cars');
  var rng = GP.makeRng(5), cnt = { lead: {}, last: {} };
  for (var i = 0; i < 4000; i++) {
    var a = IT.roll(rng, 0, { nCars: 8 }), b = IT.roll(rng, 1, { nCars: 8 });
    cnt.lead[a] = (cnt.lead[a] || 0) + 1; cnt.last[b] = (cnt.last[b] || 0) + 1;
  }
  assert.ok(!cnt.lead.lightning && !cnt.lead.mega);
  assert.ok((cnt.last.turbo + cnt.last.mega) > (cnt.lead.turbo || 0) * 1.6);
  assert.ok(cnt.lead.oil > 1000);
});
T('roll is deterministic for a seeded rng', function () {
  var a = GP.makeRng(99), b = GP.makeRng(99);
  for (var i = 0; i < 50; i++) assert.strictEqual(IT.roll(a, i / 49, {}), IT.roll(b, i / 49, {}));
});

/* ---------------- gameplay (generic track-space interface) ---------------- */
T('item box row starts a roulette and awards an item; respawns', function () {
  var H = harness({ layout: [{ type: 'box', s: 100, lat: 0 }] }, [{ s: 80 }]);
  H.seconds(1.2);
  var K = H.kart(0);
  assert.ok(K.roulette || K.item, 'roulette started');
  H.seconds(2);
  assert.ok(K.item && IT.get(K.item.id));
  var box = H.gp.entities()[0];
  assert.ok(box.respawn >= 0);
  H.seconds(3);
  assert.strictEqual(box.respawn, 0);
});
T('nitro burn boosts speed above cruise and drains the meter', function () {
  var H = harness({}, [{ s: 0 }]);
  H.seconds(1);
  var v0 = H.cars[0].speed;
  H.gp.addNitro('c0', 1);
  H.gp.setInput({ nitro: true });
  H.seconds(1.5);
  assert.ok(H.cars[0].speed > v0 + 8, 'boosted ' + H.cars[0].speed);
  assert.ok(H.kart(0).nitro.level < 0.7);
  H.gp.setInput({ nitro: false });
  H.seconds(0.1);
  assert.ok(!H.kart(0).nitro.burning);
});
T('nitro off option disables burning', function () {
  var H = harness({ nitro: false }, [{ s: 0 }]);
  H.gp.addNitro('c0', 1); H.gp.setInput({ nitro: true });
  H.seconds(0.5);
  assert.ok(!H.kart(0).nitro.burning);
});
T('turbo: three uses, each a boost', function () {
  var H = harness({}, [{ s: 0 }]);
  H.seconds(0.2);
  H.gp.giveItem('c0', 'turbo');
  for (var i = 0; i < 3; i++) {
    H.gp.setInput({ item: true }); H.step(1); H.gp.setInput({ item: false }); H.step(1);
    assert.ok(H.kart(0).boost && H.kart(0).boost.kind === 'turbo');
    H.seconds(1.2);
  }
  assert.strictEqual(H.kart(0).item, null);
});
T('oil slick dropped behind spins the follower (harmless 360) and slows it', function () {
  var H = harness({}, [{ s: 60 }, { s: 30 }]);
  H.seconds(0.1);
  H.gp.giveItem('c0', 'oil');
  H.gp.useItem('c0');
  var oil = H.gp.entities().filter(function (e) { return e.type === 'oil'; })[0];
  assert.ok(oil && oil.s < 60 + 1);
  var v0 = H.cars[1].speed, sawSpin = false, maxYaw = 0;
  for (var i = 0; i < 240; i++) { H.step(1); var f = H.gp.effects('c1'); if (H.kart(1).spinT > 0) sawSpin = true; maxYaw = Math.max(maxYaw, Math.abs(f.yaw)); }
  assert.ok(sawSpin, 'follower spun');
  assert.ok(maxYaw > 5, 'visual spin approaches a full turn');
  assert.ok(H.kart(1).st.hitsTaken === 1);
  assert.ok(!H.gp.entities().some(function (e) { return e.type === 'oil'; }), 'slick consumed');
  assert.strictEqual(H.gp.effects('c1').yaw, 0, 'heading offset returns to zero after the spin');
  assert.ok(v0 > 0);
});
T('shield blocks one hit then is gone', function () {
  var H = harness({}, [{ s: 0 }]);
  H.seconds(0.1);
  H.gp.giveItem('c0', 'shield'); H.gp.useItem('c0');
  assert.ok(H.gp.effects('c0').shielded || H.kart(0).shieldT > 0);
  assert.strictEqual(H.gp.hitCar('c0', 'rocket'), false);
  var ev = H.gp.takeEvents().filter(function (e) { return e.type === 'blocked'; });
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(H.kart(0).shieldT, 0);
  H.seconds(1.5);
  assert.strictEqual(H.gp.hitCar('c0', 'rocket'), true);
});
T('homing rocket bonks the car ahead (hop + slowdown)', function () {
  var H = harness({}, [{ s: 0, lat: 2 }, { s: 70, lat: -3, base: 30 }]);
  H.seconds(0.1);
  H.gp.giveItem('c0', 'rocket'); H.gp.useItem('c0');
  var r = H.gp.entities().filter(function (e) { return e.type === 'rocket'; })[0];
  assert.ok(r && r.target === 'c1');
  var hop = 0;
  for (var i = 0; i < 600 && H.kart(1).st.hitsTaken === 0; i++) H.step(1);
  assert.strictEqual(H.kart(1).st.hitsTaken, 1);
  for (i = 0; i < 60; i++) { H.step(1); hop = Math.max(hop, H.gp.effects('c1').hop); }
  assert.ok(hop > 0.5, 'flip-hop');
  assert.strictEqual(H.kart(0).st.hitsLanded, 1);
  assert.ok(H.cars[1].speed < 25);
});
T('rocket fired backwards targets the car behind', function () {
  var H = harness({}, [{ s: 100 }, { s: 60 }]);
  H.seconds(0.1);
  H.gp.giveItem('c0', 'rocket'); H.gp.useItem('c0', true);
  var r = H.gp.entities().filter(function (e) { return e.type === 'rocket'; })[0];
  assert.strictEqual(r.dir, -1); assert.strictEqual(r.target, 'c1');
  H.seconds(3);
  assert.strictEqual(H.kart(1).st.hitsTaken, 1);
});
T('EMP slows nearby cars only', function () {
  var H = harness({}, [{ s: 100 }, { s: 110 }, { s: 400 }]);
  H.seconds(0.1);
  H.gp.giveItem('c0', 'emp'); H.gp.useItem('c0');
  assert.ok(H.kart(1).slowT > 0);
  assert.strictEqual(H.kart(2).slowT, 0);
  assert.strictEqual(H.kart(0).slowT, 0);
});
T('lightning slows everyone ahead, nobody behind', function () {
  var H = harness({}, [{ s: 10 }, { s: 300 }, { s: 500 }, { s: 0 }]);
  H.seconds(0.1);
  H.gp.giveItem('c0', 'lightning'); H.gp.useItem('c0');
  assert.ok(H.kart(1).slowT > 0 && H.kart(2).slowT > 0);
  assert.strictEqual(H.kart(3).slowT, 0);
});
T('ghost: no collisions and immune to hazards', function () {
  var H = harness({}, [{ s: 0 }]);
  H.seconds(0.1);
  H.gp.giveItem('c0', 'ghost'); H.gp.useItem('c0'); H.step(1);
  assert.ok(H.gp.effects('c0').noCollide);
  assert.strictEqual(H.gp.hitCar('c0', 'oil'), false);
  H.seconds(5);
  assert.ok(!H.gp.effects('c0').noCollide);
});
T('magnet pulls toward the car ahead', function () {
  var a = harness({}, [{ s: 0 }, { s: 60 }]), b = harness({}, [{ s: 0 }, { s: 60 }]);
  a.seconds(0.1); b.seconds(0.1);
  a.gp.giveItem('c0', 'magnet'); a.gp.useItem('c0');
  a.seconds(3); b.seconds(3);
  assert.ok(a.cars[0].s > b.cars[0].s + 10);
});
T('mega nitro refills the meter and super-boosts', function () {
  var H = harness({}, [{ s: 0 }]);
  H.seconds(0.1);
  H.gp.giveItem('c0', 'mega'); H.gp.useItem('c0');
  assert.strictEqual(H.kart(0).nitro.level, 1);
  assert.strictEqual(H.kart(0).boost.kind, 'mega');
});
T('rocket start: rev in the sweet spot during the countdown -> start boost', function () {
  var H = harness({}, [{ s: 0 }]);
  var target = (NZ.REV.perfectLo + NZ.REV.perfectHi) / 2 / NZ.REV.up;
  H.gp.setInput({ nitro: false });
  H.cars[0].throttle = 1; H.seconds(target, 'countdown');
  H.cars[0].throttle = 0; H.step(1, 'countdown'); H.cars[0].throttle = 1;
  H.step(1, 'racing');
  assert.strictEqual(H.kart(0).startGrade, 'perfect');
  assert.ok(H.kart(0).boost && H.kart(0).boost.kind === 'start');
  var F = harness({}, [{ s: 0 }]);
  F.seconds(2.5, 'countdown'); F.step(1, 'racing');
  assert.strictEqual(F.kart(0).startGrade, 'over');
  assert.ok(F.kart(0).bogT > 0);
});
T('powerslide charges tiers and releases a mini-turbo', function () {
  var H = harness({}, [{ s: 0, steer: 0.6 }]);
  H.seconds(0.2);
  H.gp.setInput({ drift: true });
  H.seconds(2.4);
  var K = H.kart(0);
  assert.ok(K.drift.on && K.drift.tier >= 2, 'tier ' + K.drift.tier);
  var f = H.gp.effects('c0');
  assert.ok(f.stripHandbrake && f.steer > 0 && Math.abs(f.slide) > 0.2, 'stylised slide, no handbrake');
  H.gp.setInput({ drift: false }); H.step(1);
  assert.ok(K.boost && /^drift/.test(K.boost.kind));
});
T('slipstream behind a car charges then boosts', function () {
  var H = harness({}, [{ s: 0, base: 30 }, { s: 12, base: 30 }]);
  H.cars[1].isPlayer = false;
  H.seconds(2.2);
  var ev = H.gp.takeEvents().filter(function (e) { return e.type === 'slipstream' && e.carId === 'c0'; });
  assert.ok(ev.length >= 1);
});
T('air time and clean landings fill nitro', function () {
  var H = harness({}, [{ s: 0 }]);
  H.seconds(0.1);
  H.cars[0].airborne = true; H.seconds(1);
  H.cars[0].airborne = false; H.step(2);
  var K = H.kart(0);
  assert.ok(K.nitro.level >= NZ.GAIN.air * 0.9 + NZ.GAIN.landing - 1e-6);
  assert.ok(K.boost && K.boost.kind === 'trick');
});
T('coins cap at 10 and raise the speed target', function () {
  var lay = []; for (var i = 0; i < 14; i++) lay.push({ type: 'coin', s: 20 + i * 4, lat: 0 });
  var H = harness({ layout: lay }, [{ s: 0 }]);
  var vt0 = H.gp.effects('c0').vTarget;
  H.seconds(4);
  assert.strictEqual(H.kart(0).coins, 10);
  H.step(1);
  assert.ok(H.gp.effects('c0').vTarget > vt0 * 1.09);
});
T('boost pads give a boost', function () {
  var H = harness({ layout: [{ type: 'pad', s: 30, lat: 0 }] }, [{ s: 0 }]);
  H.seconds(1.5);
  assert.ok(H.kart(0).st.boosts >= 1);
});
T('AI fires a rocket at the car ahead and uses nitro', function () {
  var H = harness({ difficulty: 'expert' }, [{ s: 200 }, { s: 120 }]);   // c0 (player) ahead of AI c1
  H.cars[1].steer = 0;
  H.seconds(0.1);
  H.gp.giveItem('c1', 'rocket');
  H.gp.addNitro('c1', 1);
  H.seconds(3);
  assert.strictEqual(H.kart(1).st.itemsUsed, 1);
  assert.ok(H.kart(1).st.nitroUsed_s > 0.5);
});
T('AI with easy difficulty holds items longer than expert', function () {
  function firstUse(diff) {
    var H = harness({ difficulty: diff, seed: 3 }, [{ s: 200 }, { s: 120 }]);
    H.seconds(0.1); H.gp.giveItem('c1', 'turbo');
    var k = H.kart(1); k.ai.holdT = 0;
    // emulate a freshly rolled item (finishRoulette path sets holdT from the difficulty react window)
    H.gp.kart('c1').roulette = { t: 0, dur: 0.01, final: 'turbo' }; H.gp.kart('c1').item = null;
    for (var i = 0; i < 2400; i++) { H.step(1); if (k.st.itemsUsed) return i; }
    return 9999;
  }
  assert.ok(firstUse('easy') > firstUse('expert'));
});
T('rubber band: trailing AI gets pushed, leading AI eased off', function () {
  var H = harness({}, [{ s: 500 }, { s: 200 }, { s: 900 }]);
  H.seconds(0.2);
  var behind = H.gp.effects('c1'), ahead = H.gp.effects('c2');
  assert.ok(behind.push > 0.5);
  assert.ok(ahead.throttleMult < 1);
  var N = harness({ rubberBand: false }, [{ s: 500 }, { s: 200 }]);
  N.seconds(0.2);
  assert.strictEqual(N.gp.effects('c1').push, 0);
});
T('speed classes scale the speed target', function () {
  var a = harness({ speedClass: 'street' }, [{ s: 0 }]), b = harness({ speedClass: 'mayhem' }, [{ s: 0 }]);
  a.seconds(0.2); b.seconds(0.2);
  assert.ok(b.gp.effects('c0').vTarget > a.gp.effects('c0').vTarget * 1.2);
  assert.ok(b.gp.effects('c0').push > 0);
});
T('time trial: no item boxes, starts with a triple turbo', function () {
  var H = harness({ timeTrial: true, layout: [{ type: 'box', s: 50, lat: 0 }, { type: 'pad', s: 80, lat: 0 }] }, [{ s: 0 }]);
  H.step(1);
  assert.ok(!H.gp.entities().some(function (e) { return e.type === 'box'; }));
  assert.ok(H.gp.entities().some(function (e) { return e.type === 'pad'; }));
  assert.deepStrictEqual(H.kart(0).item, { id: 'turbo', uses: 3 });
});
T('items off: boxes are not placed', function () {
  var H = harness({ items: false, layout: [{ type: 'box', s: 50, lat: 0 }] }, [{ s: 0 }]);
  assert.strictEqual(H.gp.entities().length, 0);
});
T('determinism: same seed -> identical world; serialize/load round-trips', function () {
  function run(seed) {
    var H = harness({ seed: seed, layout: [{ type: 'box', s: 50, lat: -2 }, { type: 'box', s: 50, lat: 2 }, { type: 'box', s: 450, lat: 0 }] },
      [{ s: 40, lat: -2 }, { s: 30, lat: 2, base: 31 }, { s: 20, base: 32 }, { s: 0, base: 33 }]);
    H.seconds(20);
    return H;
  }
  var a = run(42), b = run(42);
  assert.deepStrictEqual(a.gp.serialize(), b.gp.serialize());
  var s = a.gp.serialize();
  var c = GP.create({ seed: 1, layout: [], track: { length: 2000 } });
  assert.ok(c.load(s));
  assert.deepStrictEqual(c.serialize(), s);
});
T('events carry increasing ids', function () {
  var H = harness({ layout: [{ type: 'box', s: 20, lat: 0 }] }, [{ s: 0 }]);
  H.seconds(3);
  var ev = H.gp.takeEvents();
  assert.ok(ev.length >= 2);
  for (var i = 1; i < ev.length; i++) assert.ok(ev[i].id > ev[i - 1].id);
});
T('autoLayout places rows of boxes, pads and coins on a circuit', function () {
  var lay = GP.autoLayout({ length: 4000, halfWidth: function () { return 6; }, curvature: function (s) { return s % 1000 < 600 ? 0 : 1 / 80; } }, { itemFrequency: 'normal' });
  var boxes = lay.filter(function (e) { return e.type === 'box'; });
  assert.ok(boxes.length >= 8 && boxes.length % 4 === 0);
  assert.ok(lay.some(function (e) { return e.type === 'pad'; }));
  assert.ok(lay.some(function (e) { return e.type === 'coin'; }));
  var frantic = GP.autoLayout({ length: 4000 }, { itemFrequency: 'frantic' }).filter(function (e) { return e.type === 'box'; });
  assert.ok(frantic.length > boxes.length);
});

/* ---------------- CB.race.engine integration ---------------- */
if (REAL) {
  var TRACK = CB.race.tracks.list[0].id;
  function engineRun(gpOpts, cfg, secs, input) {
    var gp = GP.create(Object.assign({ seed: 5 }, gpOpts));
    var s = CB.race.engine.createSession(Object.assign({ trackId: TRACK, laps: 3, opponentCount: 3, mode: 'race', seed: 9, hooks: [gp.hooks], lightsOutDelay_s: 0.5 }, cfg));
    gp.attachEngine(s);
    if (input) gp.setInput(input);
    s.simulate(secs, { throttle: 1, steer: 0 });
    return { gp: gp, s: s };
  }
  T('engine: hook attaches, auto layout from the circuit, snapshot decorated', function () {
    var r = engineRun({}, { playerAutopilot: true }, 20);
    var snap = r.s.snapshot();
    assert.ok(snap.arcade && snap.arcade.player && snap.arcade.entities.length > 8);
    assert.ok(snap.cars.every(function (c) { return c.arcade; }));
    assert.ok(!r.s._debug().hookErrors, 'no hook errors');
  });
  T('engine: nitro makes the player faster than without it', function () {
    var cfg = { opponentCount: 0, mode: 'practice' };
    var a = engineRun({ items: false, coins: false }, cfg, 0.1), b = engineRun({ items: false, coins: false }, cfg, 0.1);
    a.gp.addNitro('player', 1); a.gp.setInput({ nitro: true });
    a.s.simulate(3, { throttle: 1, steer: 0 }); b.s.simulate(3, { throttle: 1, steer: 0 });
    var va = a.s.snapshot().cars[0].speed, vb = b.s.snapshot().cars[0].speed;
    assert.ok(va > vb + 4, 'nitro ' + va + ' vs ' + vb);
  });
  T('engine: deterministic with the same seeds (replay)', function () {
    var a = engineRun({ difficulty: 'hard' }, { playerAutopilot: true, opponentCount: 5 }, 40);
    var b = engineRun({ difficulty: 'hard' }, { playerAutopilot: true, opponentCount: 5 }, 40);
    assert.deepStrictEqual(a.gp.serialize(), b.gp.serialize());
    var ca = a.s.snapshot().cars, cb = b.s.snapshot().cars;
    assert.deepStrictEqual(ca.map(function (c) { return [c.x, c.y]; }), cb.map(function (c) { return [c.x, c.y]; }));
  });
  T('engine: countdown holds the car while the rev gauge reads the pedal (no jump start)', function () {
    var gp = GP.create({ seed: 5 });
    var s = CB.race.engine.createSession({ trackId: TRACK, laps: 2, opponentCount: 2, mode: 'race', seed: 9, hooks: [gp.hooks], lightsOutDelay_s: 0.5 });
    gp.attachEngine(s);
    s.simulate(5.4, { throttle: 1 });
    var snap = s.snapshot();
    var me = snap.cars.filter(function (c) { return c.isPlayer; })[0];
    assert.ok(!me.jumpStart);
    ['sim', 'arcade'].forEach(function (hd) {
      var g2 = GP.create({ seed: 5 });
      var s2 = CB.race.engine.createSession({ trackId: TRACK, laps: 2, opponentCount: 4, mode: 'race', seed: 9, hooks: [g2.hooks], handling: hd, lightsOutDelay_s: 0.5 });
      g2.attachEngine(s2);
      s2.simulate(7, { throttle: 0 });
      s2.snapshot().cars.forEach(function (c) { assert.ok(!c.jumpStart && !c.penalties_s, hd + ': no jump start for ' + c.id); });
    });
    assert.ok(snap.arcade.player.rev > 0.5 || snap.arcade.player.startGrade);
  });
  T('engine: ghost item sets noCollide on the car', function () {
    var r = engineRun({}, { opponentCount: 1 }, 6);
    r.gp.giveItem('player', 'ghost'); r.gp.useItem('player');
    r.s.simulate(0.1, { throttle: 1 });
    assert.ok(r.s._debug().player.noCollide);
  });
}

/* ---------------- arcade handling (ARCADE-SPEC §1) + CB.arcade.mode extension (§3) ---------------- */
if (REAL && CB.race.vehicle.spinOut) {
  require(path.join(root, 'js/arcade/mode.js'));
  require(path.join(root, 'js/arcade/arcade-hud.js'));
  require(path.join(root, 'js/race/gl/arcade-fx.js'));
  require(path.join(root, 'js/arcade/arcade-sfx.js'));
  require(path.join(root, 'js/arcade/arcade-layer.js'));
  var TRK = CB.race.tracks.list[0].id;
  function arcRun(gpOpts, cfg) {
    var gp = GP.create(Object.assign({ seed: 5 }, gpOpts));
    var s = CB.race.engine.createSession(Object.assign({ trackId: TRK, laps: 3, opponentCount: 0, mode: 'practice', seed: 9, hooks: [gp.hooks], handling: 'arcade' }, cfg));
    gp.attachEngine(s);
    return { gp: gp, s: s };
  }
  T('arcade handling: nitro boosts through env.arcade push', function () {
    var a = arcRun({ items: false, coins: false }), b = arcRun({ items: false, coins: false });
    a.s.simulate(2, { throttle: 1 }); b.s.simulate(2, { throttle: 1 });
    a.gp.addNitro('player', 1); a.gp.setInput({ nitro: true });
    a.s.simulate(2.5, { throttle: 1 }); b.s.simulate(2.5, { throttle: 1 });
    var va = a.s.snapshot().cars[0].speed, vb = b.s.snapshot().cars[0].speed;
    assert.ok(va > vb + 4, va + ' vs ' + vb);
  });
  T('arcade handling: oil hit uses the vehicle spinOut (physical cartoon 360, no visual double-spin)', function () {
    var r = arcRun({ items: false });
    r.s.simulate(3, { throttle: 1 });
    r.gp.hitCar('player', 'oil');
    r.s.simulate(1 / 120 * 2, { throttle: 1 });
    var car = r.s._debug().player;
    assert.ok(car.state.spin, 'spinOut running');
    assert.strictEqual(r.gp.effects('player').yaw, 0);
    r.s.simulate(1.5, { throttle: 1 });
    assert.ok(!car.state.spin);
  });
  T('arcade handling: native powerslide charges the mini-turbo, release boosts', function () {
    var r = arcRun({ items: false });
    r.s.simulate(4, { throttle: 1 });
    var t = 0;
    while (t < 2.4) { r.s.simulate(0.1, { throttle: 1, steer: 0.4, handbrake: true }); t += 0.1; }   // a gentle slide (arcade turns tight: 0.7 would loop off the road)
    var K = r.gp.kart('player');
    assert.ok(K.drift.on && K.drift.tier >= 1, 'tier ' + K.drift.tier + ' slide ' + r.s._debug().player.state.powerslide);
    r.s.simulate(0.05, { throttle: 1, steer: 0.2 });
    assert.ok(K.boost && /^drift/.test(K.boost.kind));
  });
  T('CB.arcade.mode: gameplay extension registers options and runs in an arcade session', function () {
    var M = CB.arcade.mode;
    CB.arcade.layer.register();
    var ids = M.optionDefs().map(function (d) { return d.id; });
    ['items', 'itemFrequency', 'nitro', 'speedClass', 'coins'].forEach(function (k) { assert.ok(ids.indexOf(k) >= 0, k); });
    var s = M.createSession({ trackId: TRK, laps: 2, opponentCount: 3, mode: 'race', seed: 4, playerAutopilot: true, lightsOutDelay_s: 0.4,
      arcade: { difficulty: 'pro', options: { speedClass: 'pro', itemFrequency: 'high' } } });
    s.simulate ? s.simulate(25) : null;
    for (var i = 0; i < 25 * 120 && !s.simulate; i++) s.update(1 / 120, {});
    var snap = s.snapshot();
    var g = snap.arcade && snap.arcade.ext && snap.arcade.ext.gameplay;
    assert.ok(g && g.player && g.entities.length > 8, 'gameplay state in snap.arcade.ext');
    assert.strictEqual(g.options.speedClass, 'pro');
    var inst = s.arcade.instances.filter(function (x) { return x.id === 'gameplay'; })[0];
    assert.ok(inst.gameplay.serialize().karts.length === 4);
    var res = s.results();
    assert.ok(res.arcade.gameplay && res.arcade.gameplay.player);
    var sv = s.arcade.serialize();
    assert.ok(sv.gameplay && sv.gameplay.v === 1);
  });
  T('CB.arcade.mode: time-trial disables item boxes and gives a triple turbo', function () {
    var s = CB.arcade.mode.createSession({ trackId: TRK, laps: 1, mode: 'time-trial', seed: 4, arcade: { mode: 'time-trial' } });
    s.update(1 / 60, {});
    var g = s.snapshot().arcade.ext.gameplay;
    assert.ok(!g.entities.some(function (e) { return e.type === 'box'; }));
    assert.deepStrictEqual(g.player.item, { id: 'turbo', uses: 3 });
  });
  T('hud: announcer callouts for player events', function () {
    var C = CB.arcade.hud.calloutFor;
    assert.strictEqual(C({ type: 'nitroStart', carId: 'player' }, 'player')[0], 'NITRO!');
    assert.strictEqual(C({ type: 'hit', carId: 'ai-1', by: 'player', kind: 'rocket' }, 'player')[0], 'BONK!');
    assert.strictEqual(C({ type: 'blocked', carId: 'player' }, 'player')[0], 'SHIELDED');
    assert.strictEqual(C({ type: 'nitroStart', carId: 'ai-1' }, 'player'), null);
  });
}
if (REAL) {
  T('attach finds the engine inside assist / drift wrappers (.engine, _debug().inner)', function () {
    var gp = GP.create({ seed: 2 });
    var s = CB.race.engine.createSession({ trackId: CB.race.tracks.list[0].id, laps: 1, opponentCount: 0, mode: 'practice', seed: 1, hooks: [gp.hooks] });
    var wrapA = { engine: s, _debug: function () { return { inner: s }; } };
    var outer = Object.create(wrapA);
    gp.attachEngine(outer, { wrapSnapshot: false });
    assert.ok(typeof gp.track().pose === 'function');
    assert.ok(gp.entities().some(function (e) { return e.type === 'box'; }));
  });
}

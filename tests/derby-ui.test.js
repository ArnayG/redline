/* Demolition Derby UI glue (docs/DERBY-SPEC.md §10): settings sanitising, input sign conventions + key rates,
   HUD / touch layouts (no overlaps, >= 44 px, inside the safe area on phones), loadout validation glue, route / menu /
   index.html / achievements integration. Pure Node (the browser half of derby-ui.js returns early without a DOM). */
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/vehicle.js', 'js/derby/derby-arenas.js', 'js/derby/derby-physics.js',
 'js/derby/derby-damage.js', 'js/derby/derby-accessories.js', 'js/derby/derby-ai.js', 'js/derby/derby-session.js', 'js/derby/derby-hud.js',
 'js/derby/derby-sfx.js', 'js/derby/derby-ui.js', 'js/router.js', 'js/game/achievements.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, UI = CB.derby.ui, X = UI._, HUD = CB.derby.hud, A = CB.derby.accessories;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('derby-ui: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

test('settings: defaults, clamps and invalid values', function () {
  var d = X.sanitizeSettings(null);
  assert.strictEqual(d.arenaId, 'mud-bowl');
  assert.ok(A.validate(d.accessories).ok, 'default loadout valid');
  var s = X.sanitizeSettings({ opponents: 99, difficulty: 'godlike', arenaId: 'nowhere', lives: 9, timeLimit_s: 77, quality: 'ultra-max', touch: 'yes', presetId: 'jesko-attack' });
  assert.strictEqual(s.opponents, 11);
  assert.strictEqual(s.difficulty, d.difficulty);
  assert.strictEqual(s.arenaId, 'mud-bowl');
  assert.strictEqual(s.lives, 3);
  assert.strictEqual(s.timeLimit_s, 0);
  assert.strictEqual(s.quality, 'auto');
  assert.strictEqual(s.touch, 'auto');
  assert.strictEqual(s.presetId, 'jesko-attack');
  assert.strictEqual(X.sanitizeSettings({ opponents: 1 }).opponents, 3);
  assert.strictEqual(X.sanitizeSettings({ arenaId: 'rooftop' }).arenaId, 'rooftop');
});

test('settings: loadouts are cut back to something that validates (slots, budget, 2 actions)', function () {
  var s = X.sanitizeSettings({ accessories: ['ram', 'bullbar', 'flamethrower', 'magnet', 'nitro', 'shield', 'repair', 'nope'] });
  var v = A.validate(s.accessories);
  assert.ok(v.ok, v.errors.join(';'));
  assert.ok(s.accessories.indexOf('bullbar') < 0, 'second front item dropped');
  assert.ok(v.actives.length <= A.MAX_ACTIVE);
  assert.ok(v.points <= A.BUDGET);
  A.PRESETS.forEach(function (p) { assert.ok(A.validate(p.items).ok, p.id + ' preset loadout valid'); });
});

test('input: A / ← steer LEFT (+1), D / → RIGHT (−1), rate-limited like the arcade keys', function () {
  var I = X.createInput();
  I.handleKey('KeyA', true);
  var o = I.sample(0.05);
  assert.ok(o.steer > 0.4 && o.steer < 0.6, 'ramps to ~0.5 in 50 ms: ' + o.steer);
  o = I.sample(0.1); assert.strictEqual(o.steer, 1);
  I.handleKey('KeyA', false); I.handleKey('ArrowRight', true);
  o = I.sample(0.05); assert.ok(o.steer < 1 && o.steer > -0.2, 'direction flip is fast but not instant');
  o = I.sample(0.2); assert.strictEqual(o.steer, -1);
  I.handleKey('ArrowRight', false);
  o = I.sample(0.2); assert.strictEqual(o.steer, 0);
});

test('input: pedals, handbrake, ACTION 1 (F/J) and ACTION 2 (G/K), reset, actions', function () {
  var acts = [], I = X.createInput({ onAction: function (a) { acts.push(a); } });
  I.handleKey('KeyW', true); I.handleKey('Space', true); I.handleKey('KeyF', true); I.handleKey('KeyK', true); I.handleKey('KeyR', true);
  var o = I.sample(0.5);
  assert.strictEqual(o.throttle, 1); assert.strictEqual(o.handbrake, true); assert.strictEqual(o.action1, true); assert.strictEqual(o.action2, true); assert.strictEqual(o.reset, true);
  I.handleKey('KeyW', false); I.handleKey('KeyS', true);
  o = I.sample(0.5); assert.strictEqual(o.throttle, 0); assert.strictEqual(o.brake, 1);
  I.handleKey('Escape', true); I.handleKey('KeyC', true); I.handleKey('KeyM', true); I.handleKey('KeyC', true, true);
  assert.deepStrictEqual(acts, ['pause', 'camera', 'mute']);
  assert.strictEqual(I.handleKey('KeyQ', true), false, 'unbound keys are not consumed');
});

test('input: phone hub steer +1 = RIGHT maps to derby −1; phone buttons -> actions', function () {
  assert.strictEqual(X.hubSteer(1), -1); assert.strictEqual(X.hubSteer(-0.5), 0.5); assert.strictEqual(X.hubSteer(NaN), 0);
  var saved = CB.input;
  CB.input = { hub: { read: function () { return { active: true, steer: 0.6, throttle: 0.7, brake: 0, handbrake: false, source: 'wheel' }; } } };
  try {
    var I = X.createInput(), o = I.sample(0.016);
    assert.ok(Math.abs(o.steer + 0.6) < 1e-9, 'phone right -> derby right (negative)');
    assert.ok(Math.abs(o.throttle - 0.7) < 1e-9);
    I.handleKey('KeyA', true); o = I.sample(0.2);
    assert.ok(o.steer > 0, 'held keys override the phone');
    I.phoneEvent('item'); o = I.sample(0.016); assert.strictEqual(o.action1, true);
    o = I.sample(0.2); assert.strictEqual(o.action1, false, 'ITEM is a short press');
    I.phoneEvent('nitroOn'); assert.strictEqual(I.sample(0.016).action2, true);
    I.phoneEvent('nitroOff'); assert.strictEqual(I.sample(0.016).action2, false);
  } finally { CB.input = saved; }
});

function inside(r, w, h, s) { return r.x >= (s.l || 0) - 0.5 && r.y >= (s.t || 0) - 0.5 && r.x + r.w <= w - (s.r || 0) + 0.5 && r.y + r.h <= h - (s.b || 0) + 0.5; }
var PHONES = [[667, 375, {}], [740, 360, {}], [844, 390, { l: 47, r: 47, b: 21 }], [932, 430, { l: 59, r: 59, b: 21 }], [1024, 600, {}]];

test('touch layout: controls >= 44 px, inside the safe area, never overlapping (phones landscape)', function () {
  PHONES.forEach(function (ph) {
    var w = ph[0], h = ph[1], s = ph[2], L = HUD.touchLayout(w, h, s), keys = Object.keys(L);
    keys.forEach(function (k) {
      var r = L[k];
      assert.ok(r.w >= 44 && r.h >= 40, k + ' too small at ' + w + 'x' + h);
      assert.ok(inside(r, w, h, s), k + ' outside the safe area at ' + w + 'x' + h + ' ' + JSON.stringify(r));
    });
    keys.forEach(function (a, i) { keys.slice(i + 1).forEach(function (b) { assert.ok(!HUD.overlap(L[a], L[b]), a + ' overlaps ' + b + ' at ' + w + 'x' + h); }); });
    assert.ok(L.action1.w >= 56 && L.action2.w >= 56, 'ACTION buttons are big targets');
  });
});

test('HUD layout: compact phone HUD panels do not overlap each other or the touch controls', function () {
  PHONES.forEach(function (ph) {
    var w = ph[0], h = ph[1], s = ph[2], H = HUD.layout(w, h, { touch: true, safe: s }), T = HUD.touchLayout(w, h, s);
    var panels = { health: H.health, diagram: H.diagram, count: H.count, minimap: H.minimap, feed: H.feed };
    var names = Object.keys(panels);
    names.forEach(function (a, i) { names.slice(i + 1).forEach(function (b) { assert.ok(!HUD.overlap(panels[a], panels[b]), a + ' overlaps ' + b + ' at ' + w + 'x' + h); }); });
    names.forEach(function (a) { Object.keys(T).forEach(function (b) { assert.ok(!HUD.overlap(panels[a], T[b]), 'HUD ' + a + ' overlaps touch ' + b + ' at ' + w + 'x' + h); }); });
    assert.strictEqual(H.acc.length, 0, 'touch: accessory charges live on the ACTION buttons');
  });
});

test('HUD layout: desktop panels do not overlap', function () {
  [[1280, 720], [1440, 900], [1920, 1080]].forEach(function (d) {
    var H = HUD.layout(d[0], d[1], {}), list = [H.health, H.diagram, H.count, H.timer, H.minimap, H.feed].concat(H.acc);
    assert.ok(!H.compact);
    list.forEach(function (a, i) { list.slice(i + 1).forEach(function (b) { assert.ok(!HUD.overlap(a, b), JSON.stringify(a) + ' x ' + JSON.stringify(b) + ' at ' + d); }); });
  });
});

test('HUD: zone colours go green -> red -> wrecked, draw() survives a real snapshot on a stub canvas', function () {
  assert.notStrictEqual(HUD.zoneColor(0), HUD.zoneColor(0.9));
  assert.strictEqual(HUD.zoneColor(1), '#3a0d0d');
  var ses = CB.derby.session.create({ arenaId: 'rooftop', seed: 3, opponents: 3, countdown_s: 0.5, player: { presetId: 'muscle', accessories: ['hammer', 'nitro'] } });
  for (var i = 0; i < 240; i++) ses.step({ throttle: 1, steer: 0.3, action1: i % 60 === 0 });
  var snap = ses.snapshot();
  var calls = 0, ctx = new Proxy({}, { get: function (t, k) { if (k === 'measureText') return function (s) { return { width: String(s).length * 6 }; }; if (k === 'createRadialGradient' || k === 'createLinearGradient') return function () { return { addColorStop: function () {} }; }; return t[k] !== undefined ? t[k] : function () { calls++; }; }, set: function (t, k, v) { t[k] = v; return true; } });
  var hud = HUD.create();
  hud.draw(ctx, snap, { width: 844, height: 390, compact: true, touch: true });
  hud.draw(ctx, snap, { width: 1440, height: 900 });
  assert.ok(calls > 50, 'drew something');
});

test('rating: heavier cars are tougher, more power per tonne punches harder', function () {
  var P = CB.derby.physics;
  var van = X.rating(P.specFromBuild(CB.data.presetBuild('atelier-shuttle'))), mx = X.rating(P.specFromBuild(CB.data.presetBuild('lightweight-roadster')));
  var hy = X.rating(P.specFromBuild(CB.data.presetBuild('electric-hyper')));
  assert.ok(van.tough > mx.tough);
  assert.ok(hy.punch > mx.punch);
});

test('integration: route, nav item, menu tile, index.html scripts + screen, achievements', function () {
  var R = CB.router;
  assert.ok(R.routes.indexOf('derby') >= 0);
  assert.strictEqual(R._.layerOf('derby'), 'derby');
  assert.strictEqual(R._.parse('#/derby?quick=1&arena=junkyard').route, 'derby');
  assert.ok(R._.NAV.some(function (n) { return n.route === 'derby' && n.label === 'Derby'; }));
  var html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(/id="screen-derby"/.test(html));
  var order = ['js/derby/derby-arenas.js', 'js/derby/derby-physics.js', 'js/derby/derby-damage.js', 'js/derby/derby-accessories.js', 'js/derby/derby-ai.js',
    'js/derby/derby-session.js', 'js/race/gl/derby-parts.js', 'js/race/gl/derby-arena-mesh.js', 'js/race/gl/derby-renderer.js', 'js/derby/derby-hud.js', 'js/derby/derby-sfx.js', 'js/derby/derby-ui.js'];
  var last = -1;
  order.forEach(function (f) { var i = html.indexOf('src="' + f + '"'); assert.ok(i > last, f + ' missing / out of order'); last = i; assert.ok(fs.existsSync(path.join(root, f)), f + ' exists'); });
  assert.ok(html.indexOf('src="js/router.js"') > last, 'router loads after derby');
  var hub = fs.readFileSync(path.join(root, 'js/game/hub.js'), 'utf8');
  assert.ok(/id: 'derby', label: 'Demolition Derby'/.test(hub) && /router\.go\('derby'\)/.test(hub));
  var Ach = CB.game.achievements, P = { stats: {}, achievements: {} };
  var got = Ach.check(P, { type: 'derby', results: { won: true, arenaId: 'junkyard', player: { health: 0.9, stats: { kills: 1, tbones: 5, flameDmg: 0.7 } } }, launches: 2 }, { toast: false, persist: false }).map(function (a) { return a.id; });
  ['derby-first-blood', 'derby-last-standing', 'derby-tbone', 'derby-pyro', 'derby-untouchable', 'derby-flying'].forEach(function (id) { assert.ok(got.indexOf(id) >= 0, id); });
  assert.ok(Ach.categories.some(function (c) { return c.id === 'derby'; }));
  var none = Ach.check({ stats: {}, achievements: {} }, { type: 'derby', results: { won: false, player: { health: 0, stats: {} } } }, { toast: false, persist: false });
  assert.strictEqual(none.length, 0, 'a lost derby with nothing done unlocks nothing');
});

test('input: RAM BOOST on Shift / L / pad RB / touch; phone NITRO = boost when the sim has it, else ACTION 2', function () {
  var I = X.createInput();
  I.handleKey('ShiftLeft', true); assert.strictEqual(I.sample(0.016).boost, true);
  I.handleKey('ShiftLeft', false); I.handleKey('KeyL', true); assert.strictEqual(I.sample(0.016).boost, true);
  I.handleKey('KeyL', false); assert.strictEqual(I.sample(0.016).boost, false);
  I.touch.active = true; I.touch.boost = true; assert.strictEqual(I.sample(0.016).boost, true); I.touch.boost = false;
  I.phoneEvent('nitroOn'); var o = I.sample(0.016); assert.strictEqual(o.action2, true); assert.strictEqual(o.boost, false, 'no ram in the sim: NITRO stays ACTION 2');
  I.boostAvail = true; o = I.sample(0.016); assert.strictEqual(o.boost, true); assert.strictEqual(o.action2, false);
  I.phoneEvent('nitroOff'); I.phoneEvent('itemBack'); o = I.sample(0.016); assert.strictEqual(o.action2, true, 'swipe-back ITEM = ACTION 2 when NITRO is the boost');
});

test('juice: impacts -> hit-stop 60-90 ms, shake, kick, flash, rumble; score events -> popups, combo, announcer, replay on takedowns', function () {
  var J = HUD.createJuice();
  function snap(t, evs, cars) { return { t: t, phase: 'fight', events: evs, cars: cars || [{ id: 'player', isPlayer: true, x: 0, y: 0, z: 0 }, { id: 'ai1', x: 3, y: 0, z: 0 }] }; }
  var fx = J.ingest(snap(5, [{ type: 'impact', carId: 'player', otherId: 'ai1', big: true, energy: 120000, vn: 18, x: 2, y: 0, kind: 'tbone' }]), { followId: 'player' });
  assert.ok(fx.hitstop >= 0.06 && fx.hitstop <= 0.09, 'hitstop ' + fx.hitstop);
  assert.ok(fx.shake > 0.5 && fx.kick && fx.flash && fx.rumble > 0);
  assert.strictEqual(J.state.popups.length, 1, 'fallback scoring without session score events');
  assert.ok(/T-BONE/.test(J.state.popups[0].text));
  // a session with score events takes over the scoring
  J.ingest(snap(6, [{ type: 'score', carId: 'player', otherId: 'ai1', label: 'SANDWICH', points: 300, combo: 3, x: 3, y: 0, z: 1.6 }]), {});
  assert.strictEqual(J.state.breakdown.SANDWICH, 300);
  assert.strictEqual(J.state.announce.text, 'x3 COMBO!');
  fx = J.ingest(snap(7, [{ type: 'eliminated', carId: 'ai1', otherId: 'player', x: 3, y: 0 }]), {});
  assert.ok(fx.replay && fx.replay.targetId === 'ai1');
  assert.strictEqual(J.state.announce.text, 'FIRST BLOOD');
  fx = J.ingest(snap(9, [{ type: 'eliminated', carId: 'ai2', otherId: 'player', x: 3, y: 0 }]), {});
  assert.strictEqual(J.state.announce.text, 'DOUBLE TAKEDOWN');
  assert.ok(fx.stings.indexOf('takedown') >= 0);
  // small taps and other cars' hits do not freeze the game
  fx = J.ingest(snap(10, [{ type: 'impact', carId: 'ai3', otherId: 'ai4', big: true, energy: 200000, vn: 20, x: 30, y: 0 }]), { followId: 'player' });
  assert.strictEqual(fx.hitstop, 0);
  assert.ok(J.state.longestGap >= 0 && J.state.firstHitT === 5);
});

test('touch layout: RAM BOOST button is a big round target', function () {
  PHONES.forEach(function (ph) { var L = HUD.touchLayout(ph[0], ph[1], ph[2]); assert.ok(L.boost && L.boost.w >= 64 && L.boost.w === L.boost.h, 'boost at ' + ph[0]); });
});

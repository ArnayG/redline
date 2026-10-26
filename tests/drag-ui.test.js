/* Drag Racing UI / HUD / integration (docs/DRAG-SPEC.md): settings sanitising, input (digital keys, shift edges, gamepad,
   hub line-lock assist), session config glue (assists, bracket dials, ghost / AI entries), payout + achievement events,
   ghost trace resampling, HUD + touch layouts (inside the screen, >= 44 px, no overlaps on a phone), prompts, the sfx
   adapter, a headless UI-config run through CB.drag.session.simulate, and the route / nav / menu / index.html / CSS /
   achievements hooks. Pure Node (the browser half of drag-ui.js returns early without a DOM). */
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach(function (f) { require(path.join(root, f)); });
// index.html order (the first model registered per body style is its default: tests/shapes-* check it)
['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van', 'pack-jdm', 'pack-usa', 'pack-exotic', 'pack-sport'].forEach(function (f) { require(path.join(root, 'js/shapes/models', f + '.js')); });
['js/shapes/stock-specs.js', 'js/state.js', 'js/physics.js', 'js/rules.js', 'js/race/vehicle.js', 'js/drag/drag-strip.js', 'js/drag/drag-tree.js', 'js/drag/drag-timing.js',
 'js/drag/drag-launch.js', 'js/drag/drag-ai.js', 'js/drag/drag-session.js', 'js/drag/drag-hud.js', 'js/drag/drag-sfx.js', 'js/drag/drag-ui.js', 'js/router.js', 'js/game/achievements.js']
  .forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, X = CB.drag.ui._, HUD = CB.drag.hud, SFX = CB.drag.sfx;
var src = function (rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); };

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('drag-ui: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
function inside(r, w, h) { return r.x >= 0 && r.y >= 0 && r.x + r.w <= w + 0.5 && r.y + r.h <= h + 0.5; }
function overlap(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

test('settings: defaults and invalid values', function () {
  var d = X.sanitizeSettings(null);
  assert.strictEqual(d.distanceId, 'quarter'); assert.strictEqual(d.treeType, 'pro'); assert.strictEqual(d.opponent, 'ladder');
  var s = X.sanitizeSettings({ distanceId: 'mile', treeType: 'flag', opponent: 'boss', difficulty: 'god', tSize: 6, nitrous_hp: 999, tc: 7, tuneFD: 12, tuneSpread: 3, dial: 1, units: 'parsecs', cls: 'pro-mod', autoShift: 1 });
  assert.strictEqual(s.distanceId, 'quarter'); assert.strictEqual(s.treeType, 'pro'); assert.strictEqual(s.opponent, 'ladder');
  assert.strictEqual(s.difficulty, 'amateur'); assert.strictEqual(s.tSize, 4); assert.strictEqual(s.nitrous_hp, 100); assert.strictEqual(s.tc, 'car');
  assert.strictEqual(s.tuneFD, 5.5); assert.strictEqual(s.tuneSpread, 1.15); assert.strictEqual(s.dial, null); assert.strictEqual(s.units, 'imperial');
  assert.strictEqual(s.cls, 'pro-mod'); assert.strictEqual(s.autoShift, true);
  var t = X.sanitizeSettings({ tc: 0, tSize: 8, dial: 11.234, distanceId: 'roll', venue: 'street' });
  assert.strictEqual(t.tc, 0); assert.strictEqual(t.tSize, 8); assert.strictEqual(t.dial, 11.23); assert.strictEqual(t.distanceId, 'roll'); assert.strictEqual(t.venue, 'street');
});

test('input: digital keys, latched shift edges, actions', function () {
  var acts = [], I = X.createInput({ onAction: function (a) { acts.push(a); } });
  assert.ok(I.handleKey('KeyW', true)); assert.ok(I.handleKey('KeyS', true));
  var a = I.sample(1 / 60); assert.strictEqual(a.throttle, 1); assert.strictEqual(a.brake, 1); assert.strictEqual(a.shiftUp, false); assert.strictEqual(a.analog, false);
  I.handleKey('KeyE', true, false); I.handleKey('KeyE', true, true);   // repeat ignored
  var b = I.sample(1 / 60); assert.strictEqual(b.shiftUp, true);
  assert.strictEqual(I.sample(1 / 60).shiftUp, false, 'edge cleared after one sample');
  I.handleKey('KeyQ', true, false); assert.strictEqual(I.sample(1 / 60).shiftDown, true);
  I.handleKey('KeyN', true); assert.strictEqual(I.sample(1 / 60).nitrous, true);
  ['KeyC', 'Escape', 'KeyM', 'KeyR', 'Enter'].forEach(function (k) { I.handleKey(k, true, false); });
  assert.deepStrictEqual(acts, ['camera', 'pause', 'mute', 'restart', 'confirm']);
  I.clear(); var c = I.sample(1 / 60); assert.strictEqual(c.throttle, 0); assert.strictEqual(c.nitrous, false);
  assert.strictEqual(I.handleKey('KeyZ', true), false);
});

test('input: touch pedals are analog; forced input for tests', function () {
  var I = X.createInput({});
  I.touch.active = true; I.touch.throttle = 0.6; I.touch.brake = 1;
  var s = I.sample(1 / 60); assert.strictEqual(s.throttle, 0.6); assert.strictEqual(s.analog, true);
  I.forced = { throttle: 1, shiftUp: true };
  assert.strictEqual(I.sample(1 / 60).shiftUp, true); assert.strictEqual(I.sample(1 / 60).shiftUp, false, 'forced shift edge fires once');
});

test('input: hub sources get a line-lock (brake held, revs in the band) and release on a fist edge', function () {
  var hubState = { active: true, throttle: 0.2, brake: 0 };
  CB.input = CB.input || {}; var prev = CB.input.hub;
  CB.input.hub = { read: function () { return hubState; }, takeEvents: function () { return []; } };
  try {
    var I = X.createInput({}), lane = { staged: true, left: false, idle: 800, redline: 7000, launch: { lo: 3000, hi: 4000, best: 3500 } };
    var a = I.sample(1 / 60, lane, 'tree');
    assert.strictEqual(a.brake, 1, 'held'); assert.ok(a.throttle > 0.3 && a.throttle < 0.5, 'revs aimed at the band best: ' + a.throttle);
    hubState.throttle = 1; var b = I.sample(1 / 60, lane, 'tree');
    assert.strictEqual(b.brake, 0); assert.strictEqual(b.throttle, 1, 'released on the fist edge');
    // not staged: the hub drives directly
    var J = X.createInput({}); hubState.throttle = 0.7; hubState.brake = 0.2;
    var c = J.sample(1 / 60, { staged: false }, 'staging'); assert.strictEqual(c.throttle, 0.7); assert.strictEqual(c.brake, 0.2);
  } finally { CB.input.hub = prev; }
});

test('config: player + AI / ghost entries, assists, bracket dials', function () {
  var S = X.sanitizeSettings({ source: 'stock', stockId: 'bmw-m4-g82', bracket: true, cls: 'pro-mod', nitrous_hp: 150, tc: 1, autoStage: true });
  var me = X.playerCar(S);
  assert.ok(me.build && me.build.engine, 'stock build'); assert.strictEqual(me.modelId, 'bmw-m4-g82');
  var opp = X.entryFor({ name: 'Rae "VTEC" Okafor', model: 'honda-civic-type-r-fl5', difficulty: 'pro' }, S);
  assert.strictEqual(opp.kind, 'ai'); assert.strictEqual(opp.nitrous_hp, 150); assert.ok(opp.build); assert.ok(/Civic/.test(opp.carName));
  var cfg = X.sessionConfig(S, me, opp, { seed: 7, dial: 11.9, oppDial: 13.6 });
  assert.strictEqual(cfg.bracket, true); assert.strictEqual(cfg.lanes[0].kind, 'player'); assert.strictEqual(cfg.lanes[0].dial, 11.9); assert.strictEqual(cfg.lanes[1].dial, 13.6);
  assert.strictEqual(cfg.lanes[0].assists.tc, 1); assert.strictEqual(cfg.lanes[0].assists.autoStage, true); assert.strictEqual(cfg.lanes[0].nitrous_hp, 150);
  var solo = X.sessionConfig(S, me, null, {}); assert.strictEqual(solo.lanes[1].kind, 'none'); assert.strictEqual(solo.bracket, false);
  var st = X.sessionConfig(X.sanitizeSettings({ venue: 'street' }), me, opp, {}); assert.strictEqual(st.treeType, 'flag'); assert.strictEqual(st.skipBurnout, true);
  // launch control only when the build has it
  var b2 = JSON.parse(JSON.stringify(me.build)); b2.transmission.launchControl = false;
  assert.strictEqual(X.assistsOf(S, b2).launchControl, false);
  // dial-in: explicit wins, else best/predicted + cushion rounded up to 0.05
  assert.strictEqual(X.dialFor(12.345, null, null), 12.35); assert.strictEqual(X.dialFor(null, 11.62, 11.4), 11.7); assert.strictEqual(X.dialFor(null, null, 9.91), 10); assert.strictEqual(X.dialFor(null, null, null), null);
});

test('config: quick tune changes the same build fields and never the base build', function () {
  var S = X.sanitizeSettings({ source: 'stock', stockId: 'chevrolet-camaro-zl1-2019' });
  var base = X.playerCar(S), fd0 = base.build.transmission.finalDrive;
  S.tuneFD = fd0 + 0.4;
  var t = X.playerCar(S);
  assert.ok(t.tuned); assert.ok(Math.abs(t.build.transmission.finalDrive - (fd0 + 0.4)) < 0.011); assert.strictEqual(t.base.transmission.finalDrive, fd0);
});

test('ghost trace: 10 Hz resampling from the green', function () {
  var smp = []; for (var t = 0; t <= 3.01; t += 1 / 60) smp.push({ t: 5 + t, x: 0.5 * 9 * t * t });
  var tr = X.ghostTrace(smp, 5);
  assert.strictEqual(tr.length, 31); assert.ok(Math.abs(tr[10] - 4.5) < 0.05); assert.ok(Math.abs(tr[30] - 40.5) < 0.2);
  assert.deepStrictEqual(X.ghostTrace([], 1), []); assert.deepStrictEqual(X.ghostTrace(smp, null), []);
  var code = CB.drag.timing.encodeGhost({ name: 'Ana', carName: 'Car', distanceId: 'quarter', rt: 0.1, et: 11.5, trap: 55, trace: tr });
  var back = CB.drag.timing.decodeGhost(code); assert.ok(back); assert.ok(Math.abs(back.trace[30] - tr[30]) < 0.06);
  var e = X.entryFor({ ghost: back }); assert.strictEqual(e.kind, 'ghost'); assert.ok(/Ana/.test(e.name));
});

test('payout + achievement event', function () {
  var res = { distance: 'quarter', holeshot: true, bracket: false, lanes: [{ won: true, rt: 0.006, et: 9.8, trap: 64, red: false, shifts: { perfect: 4, good: 0, early: 0, late: 0 },
    splits: [{ id: 'ft60', t: 1.4 }, { id: 'quarter', t: 9.8, v: 64 }], burnout: { temp: 85, bonus: 0.08 } }, { won: false }] };
  var p = X.payout(res, { lane: 0, opponent: 'ai', difficulty: 'pro', pb: true });
  var labels = p.items.map(function (i) { return i.label; });
  ['Pass', 'Win light', 'Holeshot', 'Perfect light', 'Money shifts', 'Personal best'].forEach(function (l) { assert.ok(labels.indexOf(l) >= 0, l); });
  assert.strictEqual(p.total, p.items.reduce(function (s, i) { return s + i.n; }, 0));
  var red = X.payout({ distance: 'quarter', lanes: [{ red: true }] }, { opponent: 'ai' }); assert.strictEqual(red.total, 10);
  var ev = X.achievementEvent(res, { lane: 0, opponent: 'ai', tournamentWon: true });
  assert.strictEqual(ev.type, 'drag'); assert.strictEqual(ev.et, 9.8); assert.ok(ev.trap_mph > 143 && ev.trap_mph < 144); assert.strictEqual(ev.shifts.total, 4);
  assert.strictEqual(ev.holeshot, true); assert.strictEqual(ev.distanceId, 'quarter'); assert.strictEqual(ev.tournamentWon, true);
  // achievements react to the event
  var A = CB.game.achievements, P = { achievements: {}, stats: {} };
  var got = (A.check(P, ev) || []).map(function (x) { return x.id || x; });
  ['drag-first-win', 'drag-sub-12', 'drag-sub-10', 'drag-perfect-light', 'drag-holeshot', 'drag-perfect-shifts', 'drag-burnout-master', 'drag-tournament'].forEach(function (id) { assert.ok(got.indexOf(id) >= 0, id + ' in ' + got.join(',')); });
  assert.ok(got.indexOf('drag-200-mph') < 0);
});

test('HUD layout: desktop and phone landscape rects on screen, touch targets >= 44 px without overlaps', function () {
  [[1440, 900, false], [1280, 720, false], [844, 390, true], [667, 375, true], [932, 430, true]].forEach(function (c) {
    var w = c[0], h = c[1], safe = c[2] ? { l: 44, r: 34, t: 0, b: 21 } : {};
    var L = HUD.layout(w, h, { touch: c[2], safe: safe });
    ['tach', 'lights', 'launch', 'heat', 'tree', 'progress', 'banner'].forEach(function (k) { assert.ok(inside(L[k], w, h), k + ' inside ' + w + 'x' + h); });
    if (c[2]) {
      var T = HUD.touchLayout(w, h, safe), keys = Object.keys(T);
      keys.forEach(function (k) { assert.ok(T[k].w >= 44 && T[k].h >= 44, k + ' >= 44 px'); assert.ok(inside(T[k], w, h), k + ' inside'); assert.ok(T[k].x >= safe.l - 0.5 && T[k].x + T[k].w <= w - safe.r + 0.5, k + ' in safe area'); });
      for (var i = 0; i < keys.length; i++) for (var j = i + 1; j < keys.length; j++) assert.ok(!overlap(T[keys[i]], T[keys[j]]), keys[i] + ' vs ' + keys[j]);
      ['throttle', 'brake', 'up', 'down'].forEach(function (k) { assert.ok(!overlap(L.tach, T[k]), 'tach vs ' + k); assert.ok(!overlap(L.launch, T[k]), 'launch vs ' + k); });
      assert.ok(L.compact);
    }
  });
});

test('HUD prompts follow the phases', function () {
  var snap = { phase: 'burnout', venue: 'strip', treeType: 'pro', lanes: [] };
  assert.ok(/burnout/i.test(HUD.prompt(snap, { x: -22 }).text));
  assert.strictEqual(HUD.prompt(snap, { x: -22, burnout: true, tyreTemp: 80 }).kind, 'good');
  assert.strictEqual(HUD.prompt(snap, { x: -22, burnout: true, tyreTemp: 120 }).kind, 'bad');
  snap.phase = 'staging';
  assert.ok(/Creep/.test(HUD.prompt(snap, { x: -5 }).text)); assert.ok(/PRE-STAGED/.test(HUD.prompt(snap, { preStaged: true }).text));
  assert.ok(/STAGED/.test(HUD.prompt(snap, { staged: true }).text)); assert.ok(/DEEP/.test(HUD.prompt(snap, { staged: true, deep: true }).text));
  snap.phase = 'tree';
  assert.strictEqual(HUD.prompt(snap, { staged: true, launch: { held: true, rpm: 2000, lo: 3000, hi: 4000 } }).kind, 'warn');
  assert.strictEqual(HUD.prompt(snap, { staged: true, launch: { held: true, rpm: 3500, lo: 3000, hi: 4000 } }).kind, 'good');
  assert.ok(/RED/.test(HUD.prompt(snap, { red: true }).text));
  snap.phase = 'run';
  assert.ok(/SHIFT/.test(HUD.prompt(snap, { gear: 2, maxGear: 6, shiftLight: { flash: true } }).text));
  assert.strictEqual(HUD.prompt(snap, { gear: 2, maxGear: 6, autoShift: true, shiftLight: { flash: true } }), null);
  assert.strictEqual(HUD.shortName('Dex "Diesel" Moreno'), 'DIESEL'); assert.strictEqual(HUD.fmtSpeed(44.704, 'imperial'), '100.0 mph');
});

function fakeCtx() {
  var n = 0, ctx = new Proxy({}, { get: function (t, k) { if (k in t) return t[k]; return function () { n++; return { width: 10 }; }; }, set: function (t, k, v) { t[k] = v; return true; } });
  return { ctx: ctx, calls: function () { return n; } };
}
test('HUD draws every phase of a real session without throwing; shift pop-ups from events', function () {
  var b = X.playerCar(X.sanitizeSettings({ source: 'stock', stockId: 'bmw-m4-g82' })).build;
  var s = CB.drag.session.create({ seed: 4, skipBurnout: true, lanes: [{ kind: 'ai', name: 'A', build: b, difficulty: 'pro', assists: { autoStage: true } }, { kind: 'ai', name: 'B "Bee" C', build: b, difficulty: 'rookie', assists: { autoStage: true } }] });
  var hud = HUD.create(), F = fakeCtx(), phases = {}, pops = 0;
  for (var i = 0; i < 120 * 40 && s.phase() !== 'done'; i++) {
    s.step();
    if (i % 12 === 0) { var sn = s.snapshot(); phases[sn.phase] = 1; hud.draw(F.ctx, sn, { width: 1280, height: 720, units: i % 24 ? 'imperial' : 'metric', fps: 60 }); pops = Math.max(pops, hud.popups().length); }
  }
  assert.ok(phases.tree && phases.run && (phases.shutdown || phases.done), JSON.stringify(phases));
  assert.ok(F.calls() > 1000);
  var sn2 = s.snapshot(); sn2.events = [{ type: 'shift', lane: 0, grade: 'perfect', rpm: 6900 }];
  hud.draw(F.ctx, sn2, { width: 844, height: 390, touch: true }); assert.ok(hud.popups().some(function (p) { return p.text === 'PERFECT SHIFT'; }));
  hud.draw(F.ctx, { phase: 'burnout', lanes: [] }, {});   // no player lane: no-op
});

test('sfx adapter maps a drag snapshot onto the race-audio view', function () {
  var snap = { t: 3, phase: 'tree', treeType: 'pro', playerLane: 0, surface: 'wet', tree: { lanes: [{ amber: [true, true, true], green: false }] },
    lanes: [{ kind: 'player', x: -1, y: 3.1, rpm: 5000, redline: 7000, throttle: 1, gear: 1, burnout: true, build: {} }, { kind: 'none' }], events: [{ type: 'red', lane: 0 }, { type: 'finish', lane: 0 }] };
  var a = SFX.adapt(snap);
  assert.strictEqual(a.cars.length, 1); assert.strictEqual(a.playerId, 'lane0'); assert.strictEqual(a.countdown.lightsOn, 3); assert.strictEqual(a.countdown.lightsOut, false);
  assert.strictEqual(a.phase, 'countdown'); assert.strictEqual(a.cars[0].wheelspin, 1); assert.strictEqual(a.weather, 'wet');
  assert.deepStrictEqual(a.events.map(function (e) { return e.type; }), ['jumpstart', 'finish']);
  snap.tree.lanes[0].green = true; assert.strictEqual(SFX.adapt(snap).countdown.lightsOut, true);
  var x = SFX.create({ muted: true }); x.start(); x.frame(snap); x.setMuted(false); x.destroy();   // no WebAudio in Node: no-ops
});

test('headless: a UI-built config runs to a decision (AI vs AI through simulate)', function () {
  var S = X.sanitizeSettings({ source: 'stock', stockId: 'chevrolet-corvette-c8', distanceId: 'eighth' });
  var me = X.playerCar(S), opp = X.entryFor({ name: 'R', model: 'ford-mustang-gt-s650', difficulty: 'pro' }, S);
  var cfg = X.sessionConfig(S, me, opp, { seed: 3 });
  cfg.lanes[0] = Object.assign({}, cfg.lanes[0], { kind: 'ai', difficulty: 'alien', assists: { autoStage: true, autoShift: true } });
  var r = CB.drag.session.simulate(cfg);
  assert.ok(r.winner === 0 || r.winner === 1); assert.ok(r.lanes[0].et > 5 && r.lanes[0].et < 10, 'eighth ET ' + r.lanes[0].et);
  assert.strictEqual(X.distId(r), 'eighth');
});

test('integration: route, nav, menu tile, index.html, CSS tokens, achievements category', function () {
  var R = CB.router._;
  assert.ok(CB.router.routes.indexOf('drag') >= 0, 'route');
  var nav = R.NAV.filter(function (n) { return n.route === 'drag'; })[0];
  assert.ok(nav && nav.label === 'Drag' && nav.label.length <= 7, 'nav item');
  assert.strictEqual(R.layerOf('drag'), 'drag');
  var hub = src('js/game/hub.js'); assert.ok(/id: 'drag', label: 'Drag Racing'/.test(hub) && /mc: 'drag'/.test(hub) && /router\.go\('drag'\)/.test(hub), 'menu tile');
  var html = src('index.html'); assert.ok(html.indexOf('id="screen-drag"') >= 0, 'screen');
  var order = ['js/drag/drag-strip.js', 'js/drag/drag-tree.js', 'js/drag/drag-timing.js', 'js/drag/drag-launch.js', 'js/drag/drag-ai.js', 'js/drag/drag-session.js',
    'js/race/gl/drag-strip-mesh.js', 'js/race/gl/drag-renderer.js', 'js/drag/drag-hud.js', 'js/drag/drag-sfx.js', 'js/drag/drag-ui.js'];
  var idx = order.map(function (f) { var i = html.indexOf('src="' + f + '"'); assert.ok(i > 0, f + ' tag'); assert.ok(fs.existsSync(path.join(root, f)), f + ' exists'); return i; });
  for (var i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], 'load order ' + order[i]);
  assert.ok(idx[idx.length - 1] < html.indexOf('src="js/race/race-ui.js"'), 'before race-ui');
  var css = src('css/styles.css'), light = css.slice(css.indexOf('[data-theme="light"] {'));
  assert.ok(css.indexOf('--mode-drag:') >= 0 && light.slice(0, 4000).indexOf('--mode-drag:') >= 0, '--mode-drag both themes');
  assert.ok(/#screen-drag\.cb-screen/.test(css), 'scroll rule'); assert.ok(/\.mx-foot \{[^}]*position: sticky/.test(css) && /class: 'mx-foot dg-foot'/.test(src('js/drag/drag-ui.js')), 'sticky footer (shared .mx-foot)');
  var A = CB.game.achievements;
  assert.ok(A.list.filter(function (a) { return a.category === 'drag'; }).length >= 10, 'drag achievements');
  assert.strictEqual(typeof CB.drag.ui.openNet === 'undefined' ? 'browser-only' : 'fn', 'browser-only', 'openNet is part of the browser half');
});

test('coach: the tutorial steps advance on the player\'s actions; tips explain mistakes', function () {
  var ids = X.COACH.map(function (c) { return c.id; });
  assert.deepStrictEqual(ids, ['intro', 'burnout', 'roll', 'stage', 'revs', 'green', 'shift', 'finish', 'done']);
  var snap = { phase: 'burnout', playerLane: 0, tree: { lanes: [{ amber: [false, false, false] }] } }, ctx = {};
  var i = 0;
  assert.strictEqual(X.coachNext(i, { x: -22 }, snap, { brake: 0 }, ctx), 0, 'intro waits for the brake');
  i = X.coachNext(i, { x: -22 }, snap, { brake: 1 }, ctx); assert.strictEqual(X.coachStep(i).id, 'burnout');
  assert.strictEqual(X.coachNext(i, { x: -22, tyreTemp: 50, burnout: true }, snap, {}, ctx), i);
  i = X.coachNext(i, { x: -22, tyreTemp: 75 }, snap, {}, ctx); assert.strictEqual(X.coachStep(i).id, 'roll');
  i = X.coachNext(i, { preStaged: true }, snap, {}, ctx); assert.strictEqual(X.coachStep(i).id, 'stage');
  i = X.coachNext(i, { staged: true }, snap, {}, ctx); assert.strictEqual(X.coachStep(i).id, 'revs');
  var lane = { staged: true, launch: { held: true, rpm: 3500, lo: 3000, hi: 4000 } };
  for (var k = 0; k < 30; k++) i = X.coachNext(i, lane, snap, {}, Object.assign(ctx, { dt: 1 / 60 }));
  assert.strictEqual(X.coachStep(i).id, 'revs', 'needs 0.8 s in the band');
  for (k = 0; k < 30; k++) i = X.coachNext(i, lane, snap, {}, Object.assign(ctx, { dt: 1 / 60 }));
  assert.strictEqual(X.coachStep(i).id, 'green');
  assert.strictEqual(X.coachStep(X.coachNext(i, { left: true, autoShift: true }, snap, {}, ctx)).id, 'finish', 'auto-shift skips the shift step');
  i = X.coachNext(i, { left: true }, snap, {}, ctx); assert.strictEqual(X.coachStep(i).id, 'shift');
  i = X.coachNext(i, { gear: 3, maxGear: 6 }, snap, {}, { shifts: 2 }); assert.strictEqual(X.coachStep(i).id, 'finish');
  i = X.coachNext(i, { finished: true }, snap, {}, ctx); assert.strictEqual(X.coachStep(i).id, 'done');
  // the stage step is skipped when the car rolls straight into stage
  assert.strictEqual(X.coachStep(X.coachNext(2, { staged: true, preStaged: true }, snap, {}, {})).id, 'revs');
  // tips
  var t = X.tipsFor({ red: true, rt: -0.123 }); assert.ok(/0\.123 s before the green/.test(t[0].text));
  var t2 = X.tipsFor({ rt: 0.2, launch: { bog: true, spin: true }, burnout: { temp: 40 }, shifts: { early: 2, late: 3 } }).map(function (x) { return x.text; }).join(' | ');
  ['rev higher', 'fewer revs', 'Cold tyres', 'early shifts', 'late shifts'].forEach(function (w) { assert.ok(t2.indexOf(w) >= 0, w); });
  assert.ok(/Great light/.test(X.tipsFor({ rt: 0.008 })[0].text));
  assert.strictEqual(X.isVs('practice'), false); assert.strictEqual(X.isVs('tutorial'), false); assert.strictEqual(X.isVs('ladder'), true);
  // 'auto' (chase while staging, cockpit from the green) is the default; older saves migrate once
  assert.strictEqual(X.sanitizeSettings(null).camera, 'auto');
  assert.strictEqual(X.sanitizeSettings({ camera: 'chase' }).camera, 'auto');
  assert.strictEqual(X.sanitizeSettings({ camera: 'cockpit', camV: 2 }).camera, 'auto', 'the old cockpit default moves to auto');
  assert.strictEqual(X.sanitizeSettings({ camera: 'side', camV: 2 }).camera, 'side');
  assert.strictEqual(X.sanitizeSettings({ camera: 'cockpit', camV: 3 }).camera, 'cockpit', 'an explicit cockpit pick is kept');
  assert.strictEqual(X.sanitizeSettings({ camera: 'bogus', camV: 3 }).camera, 'auto');
  assert.strictEqual(X.sanitizeSettings({ opponent: 'practice' }).opponent, 'practice');
});

test('HUD: reaction-time verdicts, split ticker, first-person minimal overlay', function () {
  assert.strictEqual(HUD.rtGrade(0.006).text, 'PERFECT!'); assert.strictEqual(HUD.rtGrade(0.03).text, 'GREAT'); assert.strictEqual(HUD.rtGrade(0.5).text, 'SLOW'); assert.strictEqual(HUD.rtGrade(-0.1).text, 'RED LIGHT');
  var hud = HUD.create(), F = fakeCtx();
  var lane = { kind: 'player', isPlayer: true, x: 10, xFront: 11, speed: 20, rpm: 5000, redline: 7000, gear: 2, maxGear: 6, rt: 0.012, left: true, splits: [], shiftLight: { level: 0.5 } };
  var snap = { t: 3, phase: 'run', playerLane: 0, distance: CB.drag.strip.get('quarter'), tree: { greenT: [1, 1], lanes: [{}, {}] }, lanes: [lane, { kind: 'none' }],
    events: [{ type: 'split', lane: 0, id: 'ft60', t: 1.812, v: 15 }] };
  hud.draw(F.ctx, snap, { width: 1440, height: 900, cockpit: true, highlight: 'lights' });
  assert.strictEqual(hud.ticker().length, 1); assert.strictEqual(hud.ticker()[0].label, '60 ft');
  snap.t = 3.2; snap.events = []; hud.draw(F.ctx, snap, { width: 844, height: 390, touch: true, cockpit: true });
  assert.strictEqual(hud.ticker().length, 1, 'ticker kept (not drawn on compact)');
});

/* ---- camera phase: chase while lining up, cockpit from the green, a manual pick sticks for the run only ---- */
function camSnap(phase, o) {
  o = o || {};
  return { phase: phase, t: o.t != null ? o.t : 1, playerLane: 0, tree: { greenT: o.greenT || [null, null] }, lanes: [{ left: !!o.left, finished: !!o.finished }, {}] };
}
test('camera phase: staging gives the chase cam, the green gives the cockpit', function () {
  ['burnout', 'staging', 'tree'].forEach(function (ph) { assert.strictEqual(X.stageCamera(camSnap(ph), 0, 'auto', null), 'chase', ph); });
  assert.strictEqual(X.stageCamera(null, 0, 'auto', null), 'chase', 'before the first snapshot');
  assert.strictEqual(X.stageCamera(camSnap('tree', { t: 5, greenT: [6, 6] }), 0, 'auto', null), 'chase', 'ambers: still chase');
  assert.strictEqual(X.stageCamera(camSnap('tree', { t: 6.01, greenT: [6, 7] }), 0, 'auto', null), 'cockpit', 'my green (bracket: the other lane still waits)');
  assert.strictEqual(X.stageCamera(camSnap('tree', { t: 6.01, greenT: [7, 6] }), 0, 'auto', null), 'chase', 'the other lane green is not mine');
  assert.strictEqual(X.stageCamera(camSnap('tree', { t: 5, greenT: [6, 6], left: true }), 0, 'auto', null), 'cockpit', 'left early (red light): the run started');
  ['run', 'shutdown', 'done'].forEach(function (ph) { assert.strictEqual(X.stageCamera(camSnap(ph), 0, 'auto', null), 'cockpit', ph + ': cockpit through the finish'); });
  // a fixed setting is used as is
  assert.strictEqual(X.stageCamera(camSnap('staging'), 0, 'side', null), 'side');
  assert.strictEqual(X.stageCamera(camSnap('run'), 0, 'chase', null), 'chase');
  assert.ok(X.CAM_BLEND >= 0.3 && X.CAM_BLEND <= 0.5, 'a short blend, not a cut');
});
test('camera phase: per-run state blends on the launch, a manual pick sticks for the run, the next run resets', function () {
  var c = X.createCamState('auto');
  assert.strictEqual(c.initial(), 'chase');
  var s1 = c.step(camSnap('staging'), 0); assert.strictEqual(s1.mode, 'chase'); assert.strictEqual(s1.changed, false);
  var s2 = c.step(camSnap('tree', { t: 6.2, greenT: [6, 6] }), 0);
  assert.strictEqual(s2.mode, 'cockpit'); assert.strictEqual(s2.changed, true); assert.strictEqual(s2.blend, X.CAM_BLEND);
  assert.strictEqual(c.step(camSnap('run'), 0).changed, false, 'one switch only');
  // manual: picked during staging, kept through the green and the finish
  var m = X.createCamState('auto'); m.initial(); m.step(camSnap('staging'), 0);
  m.manual('side');
  ['tree', 'run', 'shutdown', 'done'].forEach(function (ph) { var r = m.step(camSnap(ph, { t: 9, greenT: [6, 6] }), 0); assert.strictEqual(r.mode, 'side', ph); assert.strictEqual(r.changed, false, ph); });
  // manual cockpit during staging (no blend later, no change)
  var k = X.createCamState('auto'); k.initial(); k.manual('cockpit');
  assert.strictEqual(k.step(camSnap('staging'), 0).mode, 'cockpit');
  // manual back to chase after the launch sticks too
  var b = X.createCamState('auto'); b.initial(); b.step(camSnap('run'), 0); b.manual('chase');
  assert.strictEqual(b.step(camSnap('shutdown'), 0).mode, 'chase');
  // the next run / heat: a new state stages in the chase cam again
  var n = X.createCamState('auto'); assert.strictEqual(n.initial(), 'chase'); assert.strictEqual(n.step(camSnap('staging'), 0).mode, 'chase');
  // fixed setting: never switches by itself
  var f = X.createCamState('bumper'); assert.strictEqual(f.initial(), 'bumper');
  assert.strictEqual(f.step(camSnap('run'), 0).changed, false);
  // runPlay makes the state per run; the manual pick in auto is not persisted
  var ui = src('js/drag/drag-ui.js');
  assert.ok(/R\.cam = X\.createCamState\(S\.camera\)/.test(ui), 'per-run camera state');
  assert.ok(/R\.cam\.manual\(m\)/.test(ui), 'the camera toggle records the override');
});

/* Redline — CB.router tests (UNIFY-SPEC § Router). Pure route parsing / formatting / hub mapping in Node,
   plus a static check that index.html is the single entry point (every module, router last) and that the
   old pages are redirect stubs. */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

const ROOT = path.join(__dirname, '..');
const R = require('../js/router.js');
const _ = R._;

test('router: loads in Node and exposes the UNIFY-SPEC API', () => {
  ['go', 'current', 'on', 'back', 'boot', 'layer', 'setDriving'].forEach((k) => assert.equal(typeof R[k], 'function', k));
  ['menu', 'atelier', 'race', 'drift', 'career', 'challenges', 'garage', 'achievements', 'replays', 'profile', 'settings']
    .forEach((r) => assert.ok(R.routes.includes(r), r));
  assert.equal(globalThis.CB.router, R);
});

test('router: parse() — router hashes, default route and query params', () => {
  assert.deepEqual(_.parse('', ''), { route: 'menu', sub: null, params: {}, legacy: false });
  assert.deepEqual(_.parse('#/', ''), { route: 'menu', sub: null, params: {}, legacy: false });
  assert.deepEqual(_.parse('#/garage/engine').route, 'atelier', '#/garage is the builder (route id atelier)');
  assert.equal(_.parse('#/garage/engine').sub, 'engine');
  const p = _.parse('#/race?quick=1&track=forge-ring');
  assert.equal(p.route, 'race'); assert.equal(p.sub, null);
  assert.deepEqual(p.params, { quick: '1', track: 'forge-ring' });
  assert.deepEqual(_.parse('#/career/championship?id=rookie%20cup').params, { id: 'rookie cup' });
  assert.equal(_.parse('#/career/championship').sub, 'championship');
  // unknown routes fall back to the menu; hub screen names map to their family
  assert.equal(_.parse('#/nope').route, 'menu');
  assert.deepEqual([_.parse('#/showroom').route, _.parse('#/showroom').sub], ['garage', 'showroom']);
  assert.deepEqual([_.parse('#/timetrial').route, _.parse('#/timetrial').sub], ['menu', 'timetrial']);
});

test('router: parse() — legacy links of the old pages still land on the right screen', () => {
  const share = _.parse('#b=v1.abc');
  assert.equal(share.route, 'atelier'); assert.equal(share.params.b, 'v1.abc'); assert.equal(share.legacy, true);
  const panel = _.parse('#p=engine&b=v1.xyz');
  assert.equal(panel.route, 'atelier'); assert.equal(panel.sub, 'engine'); assert.equal(panel.params.b, 'v1.xyz');
  assert.equal(_.parse('#p=chassis').sub, 'chassis');
  assert.equal(_.parse('#atelier').route, 'atelier');
  assert.equal(_.parse('', '?atelier').route, 'atelier');
  assert.equal(_.parse('#hub').route, 'menu');
  assert.deepEqual([_.parse('#hub=showroom').route, _.parse('#hub=showroom').sub], ['garage', 'showroom']);
  assert.deepEqual([_.parse('#hub=career').route, _.parse('#hub=career').sub], ['career', null]);
  assert.equal(_.parse('#garage').route, 'garage');
  assert.equal(_.parse('#/garage/engine&b=v1.q').params.b, 'v1.q');
  assert.equal(_.parse('#/atelier/engine&b=v1.q').params.b, 'v1.q', 'pre-rebrand share link form');
});

test('router: format() round-trips and keeps the share code readable by CB.state ([#&]b=)', () => {
  assert.equal(_.format('menu'), '#/menu');
  assert.equal(_.format('atelier', 'engine'), '#/garage/engine');
  assert.equal(_.format('garage'), '#/cars');
  assert.equal(_.format('garage', 'showroom'), '#/cars/showroom');
  assert.equal(_.format('race', null, { quick: 1, track: 'forge ring' }), '#/race?quick=1&track=forge%20ring');
  assert.equal(_.format('bogus'), '#/menu');
  const withB = _.format('atelier', 'engine', { b: 'v1.abc' });
  assert.match(withB, /[#&]b=v1\.abc/);
  assert.equal(_.parse(withB).params.b, 'v1.abc');
  // in-memory payloads (builds, callbacks) never reach the URL
  const fmt = _.format('race', null, { build: { a: 1 }, onFinish() {}, _layer: 'x', kind: 'career' });
  assert.equal(fmt, '#/race?kind=career');
  ['#/career/briefing?id=x', '#/garage', '#/cars', '#/cars/workshop', '#/garage/paint', '#/drift?mode=tandem'].forEach((h) => {
    const p = _.parse(h);
    assert.equal(_.format(p.route, p.sub, p.params), h);
  });
});

test('router: normalizeTarget() accepts strings, hashes and route objects (race-ui / career launcher calls)', () => {
  assert.deepEqual(_.normalizeTarget('career'), { route: 'career', sub: null, params: {} });
  assert.deepEqual(_.normalizeTarget('#/race?quick=1'), { route: 'race', sub: null, params: { quick: '1' } });
  assert.deepEqual(_.normalizeTarget('/drift'), { route: 'drift', sub: null, params: {} });
  const t = _.normalizeTarget('career/briefing', { champId: 'gt' });
  assert.equal(t.route, 'career'); assert.equal(t.sub, 'briefing'); assert.equal(t.params.champId, 'gt');
  const o = _.normalizeTarget({ route: 'garage', sub: 'workshop', params: { id: 'c1' } });
  assert.deepEqual(o, { route: 'garage', sub: 'workshop', params: { id: 'c1' } });
  const fn = function () {};
  assert.equal(_.normalizeTarget('race', { onFinish: fn }).params.onFinish, fn, 'functions stay in memory');
  assert.equal(_.normalizeTarget('nowhere').route, 'menu');
});

test('router: hub screens are router screens (family mapping both ways)', () => {
  assert.deepEqual(_.fromHubScreen('title'), { route: 'menu', sub: null });
  assert.deepEqual(_.fromHubScreen('menu'), { route: 'menu', sub: null });
  assert.deepEqual(_.fromHubScreen('briefing'), { route: 'career', sub: 'briefing' });
  assert.deepEqual(_.fromHubScreen('workshop'), { route: 'garage', sub: 'workshop' });
  assert.deepEqual(_.fromHubScreen('quickrace'), { route: 'menu', sub: 'quickrace' });
  assert.equal(_.hubScreenFor('career'), 'career');
  assert.equal(_.hubScreenFor('career', 'rewards'), 'rewards');
  assert.equal(_.hubScreenFor('career', 'workshop'), 'career', 'a sub of another family is ignored');
  assert.equal(_.hubScreenFor('menu', 'timetrial'), 'timetrial');
  assert.equal(_.layerOf('atelier'), 'atelier');
  assert.equal(_.layerOf('drift'), 'drift');
  ['menu', 'career', 'garage', 'settings', 'profile'].forEach((r) => assert.equal(_.layerOf(r), 'hub', r));
  // every screen the hub defines maps to a route
  const HUB = require('../js/game/hub.js');
  HUB.screens.forEach((s) => assert.ok(R.routes.includes(_.fromHubScreen(s).route), s));
});

test('router: the global nav bar offers Garage, Race, Drift, Multiplayer, Career, My Cars', () => {
  const nav = _.NAV.filter((n) => n.route !== 'arcade' && n.route !== 'derby' && n.route !== 'drag' && n.route !== 'f1');   // Arcade + Demolition Derby slot in next to Race / Drift
  assert.deepEqual(nav.map((n) => n.route), ['atelier', 'race', 'drift', 'multiplayer', 'career', 'garage']);
  assert.deepEqual(nav.map((n) => n.label), ['Garage', 'Race', 'Drift', 'Multiplayer', 'Career', 'My Cars']);
  assert.equal(R.labels.atelier, 'Garage');
  assert.equal(R.labels.garage, 'My Cars');
});

test('router: Redline URLs — #/garage is the builder, #/cars is My Cars, #/atelier redirects', () => {
  // new URLs
  assert.deepEqual(_.parse('#/garage'), { route: 'atelier', sub: null, params: {}, legacy: false });
  assert.deepEqual(_.parse('#/cars'), { route: 'garage', sub: null, params: {}, legacy: false });
  assert.deepEqual([_.parse('#/cars/showroom').route, _.parse('#/cars/showroom').sub], ['garage', 'showroom']);
  // #/atelier and #/atelier/<panel> still resolve, flagged legacy so the router rewrites the URL to #/garage...
  const old = _.parse('#/atelier/engine?x=1');
  assert.deepEqual([old.route, old.sub, old.params.x, old.legacy], ['atelier', 'engine', '1', true]);
  assert.equal(_.format(old.route, old.sub, old.params), '#/garage/engine?x=1');
  assert.equal(_.parse('#/atelier').legacy, true);
  assert.equal(_.format(_.parse('#/atelier').route), '#/garage');
  // old share links keep opening the builder with the shared build
  const sh = _.parse('#b=v1.abc');
  assert.equal(_.format(sh.route, sh.sub), '#/garage');
  const shp = _.parse('#p=paint&b=v1.abc');
  assert.equal(_.format(shp.route, shp.sub, shp.params), '#/garage/paint?&b=v1.abc');
  assert.equal(_.parse('', '?atelier').route, 'atelier');
  // the old hub's screen links (#garage, #hub=garage) still mean the saved-cars screen
  assert.equal(_.format(_.parse('#garage').route), '#/cars');
  assert.equal(_.format(_.parse('#hub=garage').route), '#/cars');
  // bare ids given to go() are route ids; hash strings are URLs
  assert.equal(_.normalizeTarget('garage').route, 'garage');
  assert.equal(_.normalizeTarget('atelier/engine').route, 'atelier');
  assert.equal(_.normalizeTarget('cars').route, 'garage');
  assert.equal(_.normalizeTarget({ route: 'cars' }).route, 'garage');
  assert.equal(_.normalizeTarget('#/garage').route, 'atelier');
  assert.equal(_.normalizeTarget('#/cars/showroom').sub, 'showroom');
  assert.equal(_.normalizeTarget('#/atelier/paint').route, 'atelier');
  // nav hrefs use the new URLs
  assert.equal(_.format(_.NAV[0].route), '#/garage');
  assert.equal(_.format(_.NAV.find((n) => n.label === 'My Cars').route), '#/cars');
});

test('router: #/multiplayer and #/multiplayer/<CODE> deep links route to the lobby layer', () => {
  assert.ok(R.routes.includes('multiplayer'));
  assert.deepEqual(_.parse('#/multiplayer'), { route: 'multiplayer', sub: null, params: {}, legacy: false });
  const p = _.parse('#/multiplayer/ABCDE');
  assert.equal(p.route, 'multiplayer');
  assert.equal(p.sub, 'ABCDE');
  assert.equal(_.layerOf('multiplayer'), 'multiplayer');
  assert.equal(_.format('multiplayer', 'ABCDE'), '#/multiplayer/ABCDE');
  const t = _.normalizeTarget('multiplayer/XY2Z9');
  assert.equal(t.route, 'multiplayer'); assert.equal(t.sub, 'XY2Z9');
});

test('router: current() / on() work before boot (no DOM)', () => {
  const c = R.current();
  assert.equal(typeof c.route, 'string');
  const off = R.on('race', () => {}, () => {});
  assert.equal(typeof off, 'function');
  off();
});

test('router: index.html is the single entry point (every module, router last, layers present)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  scripts.forEach((s) => assert.ok(fs.existsSync(path.join(ROOT, s)), 'missing ' + s));
  assert.equal(scripts[scripts.length - 1], 'js/router.js');
  const idx = (s) => scripts.indexOf(s);
  ['js/util.js', 'js/data.js', 'js/shapes/core.js', 'js/state.js', 'js/physics.js', 'js/render.js', 'js/app.js',
    'js/race/engine.js', 'js/race/gl/renderer3d.js', 'js/race/drift/session.js', 'js/race/race-ui.js', 'js/game/hub.js']
    .forEach((s) => assert.ok(idx(s) >= 0, 'index.html loads ' + s));
  assert.ok(idx('js/shapes/core.js') < idx('js/render.js'), 'shapes before render');
  assert.ok(idx('js/race/drift/session.js') < idx('js/race/race-ui.js'), 'drift before race-ui');
  assert.ok(idx('js/race/race-ui.js') < idx('js/game/hub.js'), 'race before game');
  // every script the other pages load is also loaded by index.html
  ['race.html', 'race3d.html', 'hub.html', 'drift.html', 'shapes-preview.html'].forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    [...src.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]).forEach((s) => assert.ok(idx(s) >= 0, f + ' script ' + s + ' missing from index.html'));
  });
  ['gnav', 'app-root', 'screen-atelier', 'screen-race', 'screen-drift', 'screen-hub', 'topbar', 'layout'].forEach((id) =>
    assert.ok(html.indexOf('id="' + id + '"') > 0, '#' + id));
  assert.ok(html.indexOf('id="screen-atelier"') < html.indexOf('id="topbar"'), 'the configurator lives in the #/garage (atelier) layer');
  assert.match(html, /<title>Redline — /);
});

test('router: hub.html / race.html / race3d.html are redirect stubs into index.html', () => {
  [['hub.html', '#/menu'], ['race.html', '#/race'], ['race3d.html', '#/race?quick=1'], ['drift.html', '#/drift']].forEach(([f, route]) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(src.indexOf("index.html" + route) > 0, f + ' -> ' + route);
    assert.equal([...src.matchAll(/<script\s+src=/g)].length, 0, f + ' loads no game scripts');
  });
});

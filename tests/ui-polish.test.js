/* Redline — UI polish pass: shared design tokens, nav short labels, the 3D menu hero still, the Race · Drift · Arcade switch. */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });
const ROOT = path.join(__dirname, '..');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('ui: shared tokens (type / spacing / control / mode accents) are defined for both themes', () => {
  const css = src('css/styles.css');
  ['--fs-2xs', '--fs-md', '--fs-3xl', '--sp-1', '--sp-10', '--control-h-lg', '--touch-min', '--elev-3'].forEach((t) => assert.ok(css.includes(t + ':'), t));
  const light = css.slice(css.indexOf('[data-theme="light"] {'));
  ['race', 'drift', 'arcade', 'derby', 'f1', 'online'].forEach((m) => {
    assert.ok(css.includes('--mode-' + m + ':'), 'dark --mode-' + m);
    assert.ok(/--mode-[a-z0-9]+-soft:/.test(css), 'soft variant');
    assert.ok(light.slice(0, 4000).includes('--mode-' + m + ':'), 'light --mode-' + m);
  });
});

test('ui: nav links carry a short phone label; long labels get one', () => {
  const R = require(path.join(ROOT, 'js/router.js'));
  const nav = R._.NAV;
  // every label too long for the phone row has a short one (Formula 1 -> F1, Multiplayer -> Online, My Cars -> Cars)
  nav.filter((n) => n.label.length > 7).forEach((n) => assert.ok(n.short && n.short.length <= 6, n.route + ' short label'));
  assert.ok(nav.find((n) => n.route === 'multiplayer').short, 'multiplayer');
  assert.ok(src('js/router.js').includes('data-nav-route="menu"'), 'brand lit on the menu');
});

test('ui: CB.studio3d.still is exported and is a no-op without a DOM', () => {
  const S = require(path.join(ROOT, 'js/studio3d.js'));
  assert.equal(typeof S.still, 'function');
  assert.equal(S.still({ body: {} }, { width: 400, height: 160 }), null);
});

test('ui: menu has mode tiles + Quick race; setups share a Race · Drift · Arcade switch', () => {
  const hub = src('js/game/hub.js');
  assert.ok(hub.includes('class="gh-mode"') && hub.includes('data-act="quick"'), 'tiles + quick race');
  assert.ok(hub.includes("JSON.stringify(t)); } catch (e)"), 'theme fallback stores JSON like app.js');
  const ui = src('js/race/race-ui.js');
  assert.ok(/discs\.push\(\{ id: 'arcade'/.test(ui), 'arcade tab');
  assert.ok(ui.includes("disciplineTabs('arcade')"), 'arcade setup shows the switch');
});

/* Redline — rebrand guard (was "FORGE", builder was "Atelier", saved cars were "Garage").
   - storage compatibility: every localStorage key keeps its pre-rebrand 'forge.*' name, so saved builds, career,
     settings, achievements and replays of existing players stay readable without a migration. A new key prefix
     must come with a migration (and this test updated to cover it).
   - user-visible strings: page titles / nav / hub menu use Redline · Garage · My Cars.
   Route redirects (#/atelier -> #/garage, #/cars) are covered in router.test.js. */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

const ROOT = path.join(__dirname, '..');
function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out); else if (d.name.endsWith('.js')) out.push(p);
  });
  return out;
}

test('rebrand: storage keys keep their forge.* names (old saves stay readable, no migration needed)', () => {
  require('../js/util.js');
  require('../js/data.js');
  const S = require('../js/state.js');
  assert.equal(S.keys.garage, 'forge.garage.v1', 'saved builds');
  assert.equal(S.keys.current, 'forge.current.v1', 'autosaved current build');
  const src = walk(path.join(ROOT, 'js'), []).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  ['forge.profile.v1', 'forge.achievements.v1', 'forge.replays.v1', 'forge.race.settings.v1', 'forge.theme.v1', 'forge.hub.challenges.v1']
    .forEach((k) => assert.ok(src.indexOf("'" + k + "'") >= 0, k + ' still read'));
  const newPrefix = src.match(/['"]redline\.[a-z0-9.-]+['"]/gi);
  assert.equal(newPrefix, null, 'a redline.* storage key needs a migration from its forge.* key: ' + newPrefix);
});

test('rebrand: a saved build stored under the old key loads through CB.state', () => {
  require('../js/util.js');
  const D = require('../js/data.js');
  const S = require('../js/state.js');
  const st = S._storage;
  const before = st.getItem('forge.garage.v1');
  try {
    const b = D.defaultBuild();
    st.setItem('forge.garage.v1', JSON.stringify([{ id: 'old1', name: 'Pre-rebrand build', saved: 1, build: b }]));
    const list = S.listLocal();
    assert.ok(list.some((e) => e.id === 'old1'), 'old saved build listed');
    assert.ok(S.loadLocal('old1'), 'old saved build loads');
  } finally {
    if (before == null) st.removeItem('forge.garage.v1'); else st.setItem('forge.garage.v1', before);
  }
});

test('rebrand: index.html, nav and hub menu speak Redline / Garage / My Cars', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  assert.match(html, /<title>Redline — /);
  assert.match(html, /property="og:title" content="Redline/);
  assert.ok(!/\bFORGE\b|\bForge\b|Atelier/.test(visible), 'no FORGE / Atelier left in index.html markup');
  const R = require('../js/router.js');
  const labels = R._.NAV.map((n) => n.label);
  assert.ok(labels.includes('Garage') && labels.includes('My Cars') && !labels.includes('Atelier'));
  const hub = fs.readFileSync(path.join(ROOT, 'js/game/hub.js'), 'utf8');
  assert.match(hub, /\{ id: 'garage', label: 'My Cars'/);
  assert.match(hub, /var letters = 'REDLINE'/);
  ['hub.html', 'race.html', 'race3d.html', 'drift.html'].forEach((f) => {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(s, /<title>Redline — /, f);
  });
});

/* FORGE Atelier — configurator integration tests.
   Cross-module contract checks that no single module's own tests cover:
     1. every script index.html loads exists, in the SPEC load order;
     2. every direct `CB.<module>.<member>` call site in the top-level configurator files resolves to a real
        export of a module that loads in Node (state, physics, rules, pricing, ui, render, garage, ...);
     3. every CB.charts.<kind> used by a panel / garage / app is defined by charts.js;
     4. each preset survives the whole pipeline (normalize -> physics -> rules -> pricing -> render) with
        no physics fallback, no validation error, consistent price totals and NaN-free SVG in every view;
     5. URL share encoding round-trips every preset. */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');

require('../js/util.js');
const D = require('../js/data.js');
const S = require('../js/state.js');
const P = require('../js/physics.js');
const RU = require('../js/rules.js');
const PR = require('../js/pricing.js');
require('../js/ui-kit.js');
const R = require('../js/render.js');
require('../js/panels-chassis.js');
require('../js/panels-style.js');
require('../js/garage.js');
const CB = globalThis.CB;

const CONFIG_FILES = ['util', 'data', 'state', 'physics', 'rules', 'pricing', 'ui-kit', 'render', 'charts',
  'panels-powertrain', 'panels-chassis', 'panels-style', 'tune', 'panels-simple', 'garage', 'app'];
const src = {};
CONFIG_FILES.forEach((f) => { src[f] = fs.readFileSync(path.join(JS, f + '.js'), 'utf8'); });

/* strip comments so documentation examples do not count as call sites */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

test('integration: index.html loads every configurator script, in SPEC order, and each file exists', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  scripts.forEach((s) => assert.ok(fs.existsSync(path.join(ROOT, s)), 'missing script ' + s));
  // js/router.js (UNIFY-SPEC: the single entry point's router) is not a configurator module; it must load last
  // js/studio3d.js (the Atelier's optional WebGL turntable) is not a configurator module either; it loads right after render.js
  const top = scripts.filter((s) => /^js\/[^/]+\.js$/.test(s) && s !== 'js/router.js' && s !== 'js/studio3d.js').map((s) => s.slice(3, -3));
  if (scripts.includes('js/studio3d.js')) assert.equal(scripts.indexOf('js/studio3d.js'), scripts.indexOf('js/render.js') + 1, 'studio3d right after render');
  assert.deepEqual(top, CONFIG_FILES, 'top-level load order');
  if (scripts.includes('js/router.js')) assert.equal(scripts[scripts.length - 1], 'js/router.js', 'router loads after every module');
  assert.ok(scripts.indexOf('js/app.js') < scripts.indexOf('js/race/race-ui.js'), 'race after app');
  assert.ok(html.indexOf('css/styles.css') > 0, 'stylesheet linked');
  ['topbar', 'build-name', 'btn-undo', 'btn-redo', 'btn-garage', 'btn-compare', 'btn-share', 'btn-spec', 'btn-theme', 'btn-presets',
    'sidenav', 'stage', 'viewer', 'car-mount', 'view-side', 'view-front', 'view-rear', 'view-top', 'btn-xray', 'btn-spin',
    'perf-strip', 'qs-hp', 'qs-torque', 'qs-060', 'qs-top', 'qs-weight', 'qs-price', 'panel-host', 'summary', 'radar',
    'issue-list', 'modal-root', 'toast-root'].forEach((id) => assert.ok(html.indexOf('id="' + id + '"') > 0, 'contract id #' + id));
});

test('integration: every direct CB.<module>.<member> call site resolves to a real export', () => {
  // modules that load in Node and are therefore checkable; optional neighbours (app, charts, race, game) are
  // feature-detected by their callers and checked separately below.
  const checkable = { util: CB.util, data: CB.data, state: CB.state, physics: CB.physics, rules: CB.rules, pricing: CB.pricing,
    ui: CB.ui, render: CB.render, garage: CB.garage, chassisCalc: CB.chassisCalc, panelsStyle: CB.panelsStyle };
  const optionalMembers = { 'ui.lockReason': true }; // career hook installed by the game layer
  const missing = [];
  CONFIG_FILES.forEach((f) => {
    const re = /\bCB\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;
    let m;
    const c = code(src[f]);
    while ((m = re.exec(c))) {
      const mod = m[1], member = m[2];
      if (!checkable[mod] || optionalMembers[mod + '.' + member]) continue;
      // assignments that define the member (CB.ui.lockReason = ...) are not call sites
      if (/^\s*=[^=]/.test(c.slice(re.lastIndex, re.lastIndex + 3))) continue;
      if (!(member in checkable[mod])) missing.push(f + '.js: CB.' + mod + '.' + member);
    }
  });
  assert.deepEqual([...new Set(missing)], [], 'unresolved call sites');
});

test('integration: every CB.charts.<kind> used by the configurator is defined in charts.js', () => {
  const charts = code(src.charts);
  const used = new Set();
  ['panels-powertrain', 'panels-chassis', 'panels-style', 'garage', 'app'].forEach((f) => {
    for (const m of code(src[f]).matchAll(/\bCB\.charts\.([A-Za-z_]\w*)/g)) used.add(m[1]);
    // app.js draws through drawChart(key, canvas, 'kind', args)
    for (const m of code(src[f]).matchAll(/drawChart\([^,]+,[^,]+,\s*'([A-Za-z]+)'/g)) used.add(m[1]);
  });
  const missing = [...used].filter((k) => !new RegExp('\\b' + k + '\\s*[:=(]').test(charts));
  assert.deepEqual(missing, [], 'chart kinds referenced but not defined');
  ['dyno', 'accel', 'gears', 'radar', 'downforce', 'weight', 'priceDonut', 'amortization'].forEach((k) =>
    assert.ok(new RegExp('\\b' + k + '\\s*[:=(]').test(charts), 'SPEC chart ' + k));
});

test('integration: all panels register with the SPEC ids and groups', () => {
  // powertrain panels need a DOM to register; check their ids statically
  ['body', 'engine', 'transmission', 'drivetrain'].forEach((id) =>
    assert.ok(new RegExp("id:\\s*'" + id + "'").test(src['panels-powertrain']), 'powertrain panel ' + id));
  ['suspension', 'brakes', 'wheels', 'aero', 'weight'].forEach((id) =>
    assert.ok(new RegExp("id:\\s*'" + id + "'").test(src['panels-chassis']), 'chassis panel ' + id));
  ['exterior', 'interior', 'tech'].forEach((id) =>
    assert.ok(new RegExp("id:\\s*'" + id + "'").test(src['panels-style']), 'style panel ' + id));
  assert.deepEqual(CB.ui.panelGroups.slice(0, 3), ['Engineering', 'Chassis', 'Design']);
});

test('integration: every preset runs the full pipeline cleanly (physics, rules, pricing, render)', () => {
  assert.ok(D.presets.length >= 8);
  D.presets.forEach((p) => {
    const b = S.normalize(D.presetBuild(p.id));
    const m = P.compute(b);
    assert.ok(!m._error, p.id + ': physics fallback');
    ['power_hp', 'torque_nm', 'weight_kg', 'zeroTo60_s', 'topSpeed_kph', 'lapTime_s'].forEach((k) =>
      assert.ok(Number.isFinite(m[k]) && m[k] > 0, p.id + ': ' + k + ' = ' + m[k]));
    const errors = RU.validate(b, m).filter((i) => i.severity === 'error');
    assert.deepEqual(errors.map((i) => i.id), [], p.id + ': validation errors');
    const pr = PR.compute(b, m);
    const sum = pr.lines.reduce((a, l) => a + l.amount, 0);
    assert.ok(Math.abs(sum - pr.subtotal) < 1, p.id + ': lines sum to subtotal');
    assert.ok(Number.isFinite(pr.total) && pr.total > 0, p.id + ': total');
    ['side', 'front', 'rear', 'top'].forEach((view) => {
      [false, true].forEach((xray) => {
        const svg = R.markup(b, m, { view, xray });
        const bad = svg.match(/.{0,30}(NaN|undefined|Infinity|\[object)/);
        assert.ok(!bad, p.id + ' ' + view + (xray ? ' x-ray' : '') + ': ' + (bad && bad[0]));
      });
    });
    const thumb = R.thumbnail(b);
    assert.ok(typeof thumb === 'string' && thumb.indexOf('<svg') === 0, p.id + ': thumbnail');
  });
});

test('integration: share codes round-trip every preset and garage helpers agree with physics', () => {
  D.presets.forEach((p) => {
    const b = S.normalize(D.presetBuild(p.id));
    const back = S.decode(S.encode(b));
    assert.ok(back, p.id + ': decodes');
    assert.deepEqual(S.normalize(back).engine, b.engine, p.id + ': engine survives');
    assert.deepEqual(S.normalize(back).exterior, b.exterior, p.id + ': exterior survives');
    if (typeof CB.garage.compute === 'function') {
      const bd = CB.garage.compute(b);
      assert.equal(Math.round(bd.metrics.power_hp), Math.round(P.compute(b).power_hp), p.id + ': garage metrics');
    }
  });
});

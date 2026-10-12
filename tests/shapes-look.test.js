/* Node tests for the per-model renderer signature `look: { head, tail, grille }` and the text-only front/rear
   badges — run: node tests/run.js shapes-look
   Every registered model must carry a look whose values come from the fixed vocabulary the 3D renderer
   implements, fit() must pass it through, and every model must name its front and rear badge text (text only, no
   logo artwork). Models from pack files still being authored elsewhere (OPTIONAL_FILES) are validated when they
   carry a look and are otherwise skipped; every other model file is strict. */
'use strict';
var fs = require('fs');
var path = require('path');
var assert = require('node:assert/strict');
var test = globalThis.test || function (name, fn) { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } };

var ROOT = path.join(__dirname, '..');
var DIR = path.join(ROOT, 'js', 'shapes', 'models');
var S = require(path.join(ROOT, 'js', 'shapes', 'core.js'));
var FILES = fs.readdirSync(DIR).filter(function (f) { return /\.js$/.test(f); }).sort();
FILES.forEach(function (f) { require(path.join(DIR, f)); });

var LOOK = {
  head: ['oval-4pt', 'c-clamp', 'y-blade', 'round-halo', 'slim-led', 'projector-twin', 'quad-round', 'blade'],
  tail: ['light-bar', 'c-ring', 'round-ring', 'slim', 'full-width', 'y-shape', 'vertical', 'quad-round'],
  grille: ['kidney', 'slats', 'honeycomb', 'mesh', 'blanked', 'seven-slot', 'hex', 'horseshoe', 'split-v', 'bar']
};
var OPTIONAL_FILES = [];
/* Real cars that carry no front lettering at all (badgeArea null + badgeText ''). */
var NO_FRONT_BADGE = ['tesla-cybertruck'];

/* model id → file, from the authored source (ids are string literals in every model file). */
var FILE_OF = {};
FILES.forEach(function (f) {
  var src = fs.readFileSync(path.join(DIR, f), 'utf8'), re = /^\s*id: '([^']+)'/gm, m;
  while ((m = re.exec(src))) FILE_OF[m[1]] = f;
});
/* only the shipped catalogue (other suites register throw-away fixture models into the same registry) */
function models() { return S.list().filter(function (m) { return FILE_OF[m.id]; }); }
function strict(m) { return OPTIONAL_FILES.indexOf(FILE_OF[m.id]) < 0; }

function checkLook(m) {
  var lk = m.look;
  assert.ok(lk && typeof lk === 'object', m.id + ' has a look');
  Object.keys(LOOK).forEach(function (k) {
    assert.ok(LOOK[k].indexOf(lk[k]) >= 0, m.id + ' look.' + k + ' = ' + JSON.stringify(lk[k]) + ' is one of ' + LOOK[k].join('|'));
  });
  assert.deepEqual(Object.keys(lk).sort(), ['grille', 'head', 'tail'], m.id + ' look has exactly head/tail/grille');
}

test('shapes-look: every registered model has a valid look { head, tail, grille }', function () {
  var all = models(), checked = 0;
  assert.ok(all.length >= 30, 'catalogue loaded');
  all.forEach(function (m) {
    if (!strict(m) && !m.look) return;
    checkLook(m); checked++;
  });
  assert.ok(checked >= all.filter(strict).length, 'every strict model checked');
});

test('shapes-look: fit() preserves look (identity and remapped builds)', function () {
  models().filter(function (m) { return m.look; }).forEach(function (m) {
    var a = S.fit(m, S.refBuild(m));
    assert.deepEqual(a.look, m.look, m.id + ' look at refBuild');
    var b = S.refBuild(m);
    b.body.wheelbase_mm += 120; b.suspension.rideHeight_mm += 30; b.wheels.diameter_in += 1;
    var f = S.fit(m, b);
    assert.deepEqual(f.look, m.look, m.id + ' look after a remap');
    assert.notEqual(f.look, m.look, m.id + ' look is a copy, not shared');
  });
});

test('shapes-look: reference signatures match the real cars', function () {
  var want = {
    'porsche-911-992': ['oval-4pt', 'light-bar', 'slats'],
    'bmw-m4-g82': ['slim-led', 'slim', 'kidney'],
    'ford-f150-raptor-gen3': ['c-clamp', 'vertical', 'bar'],
    'bugatti-chiron': ['slim-led', 'full-width', 'horseshoe'],
    'jeep-wrangler-rubicon-jl': ['round-halo', 'vertical', 'seven-slot'],
    'vw-id-buzz': ['slim-led', 'light-bar', 'blanked'],
    'dodge-challenger-srt-hellcat': ['quad-round', 'full-width', 'mesh'],
    'ford-mustang-gt-s650': [null, 'vertical', null],
    'lamborghini-urus': ['y-blade', 'y-shape', 'hex']
  };
  Object.keys(want).forEach(function (id) {
    var m = S.models[id]; assert.ok(m, id + ' registered');
    ['head', 'tail', 'grille'].forEach(function (k, i) { if (want[id][i]) assert.equal(m.look[k], want[id][i], id + ' look.' + k); });
  });
});

test('shapes-look: every model names its front and rear badge (text only) inside a badgeArea', function () {
  models().filter(strict).forEach(function (m) {
    ['front', 'rear'].forEach(function (v) {
      var bt = m[v].badgeText;
      if (v === 'front' && NO_FRONT_BADGE.indexOf(m.id) >= 0) {
        assert.equal(bt, '', m.id + ' front: explicitly no lettering');
        return;
      }
      assert.equal(typeof bt, 'string', m.id + ' ' + v + '.badgeText');
      assert.ok(bt.length > 0 && bt.length <= 16 && /^[A-Z0-9 .\-]+$/.test(bt), m.id + ' ' + v + '.badgeText is plain upper-case text: ' + bt);
      var items = S.items(m[v].badgeArea);
      assert.ok(items.length >= 1, m.id + ' ' + v + '.badgeArea');
      var b = S.bounds(items.map(function (i) { return i.path; }));
      assert.ok(!b.empty && b.w > 0 && b.h > 0, m.id + ' ' + v + ' badgeArea has an extent');
    });
  });
});

test('shapes-look: every model has a side-view mirror outline and one plan-view mirror per side', function () {
  models().forEach(function (m) {
    var sm = (m.details || []).filter(function (d) { return d.view === 'side' && d.role === 'mirror'; });
    assert.ok(sm.length >= 1, m.id + ' side mirror outline');
    var sb = S.bounds(sm.map(function (d) { return d.path; }));
    assert.ok(sb.h > 0.06 && sb.h < 0.5 && sb.w > 0.08 && sb.w < 0.35, m.id + ' side mirror size ' + sb.w.toFixed(2) + ' x ' + sb.h.toFixed(2));
    var tm = S.items(m.top.mirrors);
    assert.ok(tm.length >= 1, m.id + ' top.mirrors');
    if (strict(m)) {
      assert.equal(tm.length, 2, m.id + ' one plan mirror path per side');
      var zs = tm.map(function (i) { var b = S.bounds(i.path); return (b.minY + b.maxY) / 2; }).sort(function (a, b) { return a - b; });
      assert.ok(zs[0] < -m.ref.width * 0.4 && zs[1] > m.ref.width * 0.4, m.id + ' plan mirrors outboard on both sides');
    }
  });
});

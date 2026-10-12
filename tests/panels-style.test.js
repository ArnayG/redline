/* FORGE Atelier — pure-core tests for js/panels-style.js (colour science, livery, SVG builders, estimators). */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

require('../js/util.js');
const D = require('../js/data.js');
const S = require('../js/state.js');
require('../js/ui-kit.js');
const PS = require('../js/panels-style.js');
const U = globalThis.CB.util;

const isHex = (h) => /^#[0-9a-f]{6}$/i.test(h);
const wellFormed = (svg) => {
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), 'svg wrapper');
  assert.ok(!/NaN|undefined|Infinity/.test(svg), 'no NaN/undefined in svg: ' + (svg.match(/.{30}(NaN|undefined|Infinity).{30}/) || [''])[0]);
  const open = (svg.match(/<(g|defs|pattern|clipPath|linearGradient|radialGradient|filter)\b/g) || []).length;
  const close = (svg.match(/<\/(g|defs|pattern|clipPath|linearGradient|radialGradient|filter)>/g) || []).length;
  assert.equal(open, close, 'balanced container tags');
};
const presetBuilds = () => D.presets.map((p) => S.normalize(D.presetBuild(p.id)));

test('panels-style: exports pure API and does not register DOM panels in Node', () => {
  ['harmony', 'randomLivery', 'exteriorSvg', 'interiorSvg', 'techSvg', 'climateSvg', 'audioSvg', 'paintCss', 'sectionCost'].forEach((k) => assert.equal(typeof PS[k], 'function', k));
  assert.equal(globalThis.CB.panelsStyle, PS);
});

test('panels-style: swatch grouping covers every heritage swatch exactly once', () => {
  const groups = PS.groupSwatches();
  const n = groups.reduce((s, g) => s + g.swatches.length, 0);
  assert.equal(n, D.paintSwatches.length);
  assert.ok(groups.length >= 8);
  assert.equal(groups[0].family, 'red');
});

test('panels-style: nearestSwatch / isHeritage / familyOf', () => {
  assert.equal(PS.nearestSwatch('#d40000').name, 'Rosso Corsa');
  assert.equal(PS.nearestSwatch('#d50101').name, 'Rosso Corsa');
  assert.ok(PS.isHeritage('#D40000'));
  assert.ok(!PS.isHeritage('#123456'));
  assert.equal(PS.familyOf('#050505'), 'black');
  assert.equal(PS.familyOf('#1f3e8c'), 'blue');
  assert.equal(PS.familyOf('#7d7f7d'), 'grey');
});

test('panels-style: paint stops/css are valid for every finish', () => {
  D.paintFinishes.forEach((f) => {
    const st = PS.paintStops('#b3121f', f.id);
    assert.ok(st.length >= 3, f.id);
    st.forEach((s) => { assert.ok(s[0] >= 0 && s[0] <= 1); assert.ok(isHex(s[1]), f.id + ' ' + s[1]); });
    const css = PS.paintCss('#b3121f', f.id);
    assert.ok(/linear-gradient/.test(css) && !/NaN|undefined/.test(css), f.id);
  });
  assert.ok(/radial-gradient\(circle/.test(PS.paintCss('#004225', 'metallic')), 'flake layer for metallic');
});

test('panels-style: harmony yields six valid schemes for chromatic and neutral paints', () => {
  ['#b3121f', '#004225', '#f4f3ef', '#0d0d0f', '#7d7f7d', '#00a3d9'].forEach((p) => {
    const hs = PS.harmony(p);
    assert.equal(hs.length, 6);
    hs.forEach((h) => ['stripe', 'caliper', 'roof', 'accent', 'stitch'].forEach((k) => assert.ok(isHex(h[k]), p + ' ' + h.id + '.' + k + '=' + h[k])));
  });
  const comp = PS.harmony('#d40000')[0];
  const hue = U.rgbToHsl(comp.caliper).h;
  assert.ok(hue > 140 && hue < 220, 'complement of red is cyan-ish, got ' + hue);
});

test('panels-style: harmonyPatch scopes', () => {
  const b = S.normalize(D.defaultBuild());
  const sc = PS.harmony('#b3121f')[3];
  assert.deepEqual(Object.keys(PS.harmonyPatch(sc, 'stripe', b).exterior), ['stripeColor']);
  const all = PS.harmonyPatch(sc, 'all', b);
  assert.equal(all.exterior.roof, 'contrast');
  assert.ok(all.interior.accentColor);
  assert.equal(PS.harmonyPatch(sc, 'interior', b).exterior, undefined);
});

test('panels-style: randomLivery is deterministic and survives normalize() unchanged', () => {
  PS.LIVERY_MODES.forEach((m) => {
    for (let seed = 1; seed < 40; seed++) {
      const a = PS.randomLivery(m.id, PS.rng(seed));
      const b = PS.randomLivery(m.id, PS.rng(seed));
      assert.deepEqual(a, b);
      const built = S.normalize(U.deepMerge(D.defaultBuild(), a));
      Object.keys(a.exterior).forEach((k) => assert.equal(built.exterior[k], a.exterior[k], m.id + ' seed ' + seed + ' ' + k));
    }
  });
  const r = PS.randomLivery('racer', PS.rng(7));
  assert.ok(r.exterior.livery_number.length >= 1);
});

test('panels-style: SVG builders are well-formed for presets and every option', () => {
  presetBuilds().forEach((b) => { wellFormed(PS.exteriorSvg(b)); wellFormed(PS.interiorSvg(b)); wellFormed(PS.techSvg(b)); wellFormed(PS.climateSvg(b)); wellFormed(PS.audioSvg(b)); });
  const base = S.normalize(D.defaultBuild());
  const variants = [];
  D.stripes.forEach((s) => variants.push({ exterior: { stripe: s.id, livery_number: '27' } }));
  D.roofTypes.forEach((r) => variants.push({ exterior: { roof: r.id } }));
  D.paintFinishes.forEach((f) => variants.push({ exterior: { finish: f.id } }));
  D.lightTypes.forEach((l) => variants.push({ exterior: { lights: l.id, badge: 'delete' } }));
  D.seatTypes.forEach((s) => variants.push({ interior: { seatType: s.id, harness: true }, weight: { rollCage: 'full' } }));
  D.upholsteries.forEach((u) => variants.push({ interior: { upholstery: u.id } }));
  D.trims.forEach((t) => variants.push({ interior: { trim: t.id } }));
  D.steeringTypes.forEach((s) => variants.push({ interior: { steering: s.id } }));
  D.screenSizes.forEach((s) => variants.push({ tech: { screen_in: s.id, digitalCluster: false, hud: true, telemetry: true, nightVision: true } }));
  D.adasLevels.forEach((a) => variants.push({ tech: { adas: a.id } }));
  [1, 2, 3, 4].forEach((z) => variants.push({ tech: { climateZones: z } }));
  variants.forEach((v) => {
    const b = S.normalize(U.deepMerge(U.deepClone(base), v));
    wellFormed(PS.exteriorSvg(b)); wellFormed(PS.interiorSvg(b)); wellFormed(PS.techSvg(b)); wellFormed(PS.climateSvg(b));
  });
  const nb = S.normalize(U.deepMerge(D.defaultBuild(), { exterior: { livery_number: '<b>' } }));
  assert.ok(!/<b>/.test(PS.exteriorSvg(nb)), 'number is sanitised/escaped');
});

test('panels-style: interior SVG reacts to cage, harness, ambient and HUD', () => {
  const b0 = S.normalize(D.defaultBuild());
  const b1 = S.normalize(U.deepMerge(D.defaultBuild(), { weight: { rollCage: 'full', rearSeats: false }, interior: { harness: true, ambientLighting: false }, tech: { hud: true } }));
  const s0 = PS.interiorSvg(b0), s1 = PS.interiorSvg(b1);
  assert.notEqual(s0, s1);
  assert.ok(s1.includes('KM/H'), 'HUD drawn');
  assert.ok(s0.includes(b0.interior.ambientColor), 'ambient colour drawn when on');
  assert.ok(s1.includes('-cg)'), 'cage tubes drawn');
});

test('panels-style: section costs, weights and loads are finite and sensible', () => {
  presetBuilds().forEach((b) => {
    ['exterior', 'interior', 'tech'].forEach((sec) => {
      const c = PS.sectionCost(b, sec);
      assert.ok(Number.isFinite(c.total), sec);
      assert.ok(c.lines.length >= 1);
      assert.ok(Number.isFinite(PS.sectionWeight(b, sec)));
    });
    const L = PS.electricalLoad(b);
    assert.ok(L.total > 50 && L.total < 3000, 'load ' + L.total);
    const sc = PS.interiorScores(b);
    ['luxury', 'sport', 'support'].forEach((k) => assert.ok(sc[k] >= 0 && sc[k] <= 100));
  });
  const ev = S.normalize(U.deepMerge(D.defaultBuild(), { engine: { type: 'ev' } }));
  const ri = PS.rangeImpact(ev, null);
  assert.ok(ri && ri.km > 0 && ri.pct > 0 && ri.pct < 20);
  assert.equal(PS.rangeImpact(S.normalize(D.defaultBuild()), null), null);
  assert.equal(PS.vlt(0), 88);
  assert.ok(Math.abs(PS.vlt(PS.tintForVlt(70)) - 70) <= 1);
});

test('panels-style: ADAS features accumulate by level', () => {
  let prev = -1;
  D.adasLevels.forEach((a) => { const n = PS.adasFeatures(a.id).length; assert.ok(n > prev, a.id); prev = n; });
  assert.equal(PS.adasFeatures(D.adasLevels[D.adasLevels.length - 1].id).length, PS.tables.ADAS_FEATURES.length);
});

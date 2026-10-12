/* FORGE Atelier — PBR material contract of CB.gl (gl-core standard shader): material types, PBR map slots,
   anisotropy, SH projection, shader sources. Pure (no GL). */
'use strict';
const G = require('../js/race/gl/gl-core.js');

test('pbr: material types from explicit keys and names', () => {
  assert.equal(G.resolveMaterial({}).materialType, 0);
  assert.equal(G.resolveMaterial({ name: 'glass' }).materialType, 1);
  assert.equal(G.resolveMaterial({ name: 'tyre' }).materialType, 2);
  assert.equal(G.resolveMaterial({ name: 'tire-front' }).materialType, 2);
  assert.equal(G.resolveMaterial({ materialType: 'rubber' }).materialType, 2);
  assert.equal(G.resolveMaterial({ glass: true }).materialType, 1);
  assert.equal(G.resolveMaterial({ name: 'glass', materialType: 'standard' }).materialType, 0);
  assert.equal(G.resolveMaterial({ name: 'fibreglass' }).materialType, 0);
});

test('pbr: map slots, anisotropy and AO defaults', () => {
  const m = G.resolveMaterial({});
  assert.equal(m.roughnessMap, null); assert.equal(m.aoMap, null); assert.equal(m.emissiveMap, null);
  assert.equal(m.anisotropy, 0); assert.equal(m.ax3, 0); assert.equal(m.aoStrength, 1);
  const tex = { texture: {} };
  const a = G.resolveMaterial({ roughnessMap: tex, occlusionMap: tex, emissiveMap: tex, anisotropy: 2, anisotropyAxis: [1, 0, 0], aoStrength: 0.5 });
  assert.ok(a.roughnessMap && a.aoMap && a.emissiveMap);
  assert.equal(a.anisotropy, 1);
  assert.deepEqual([a.ax0, a.ax1, a.ax2, a.ax3], [1, 0, 0, 1]);
  assert.equal(a.aoStrength, 0.5);
});

test('pbr: computeSH reproduces constant radiance and a vertical gradient', () => {
  const sh = G.computeSH(() => [0.5, 0.25, 1], 1024);
  assert.equal(sh.length, 27);
  const ev = (n) => [0, 1, 2].map((c) => sh[c] + sh[3 + c] * n[1] + sh[6 + c] * n[2] + sh[9 + c] * n[0] + sh[12 + c] * n[0] * n[1] +
    sh[15 + c] * n[1] * n[2] + sh[18 + c] * (3 * n[2] * n[2] - 1) + sh[21 + c] * n[0] * n[2] + sh[24 + c] * (n[0] * n[0] - n[1] * n[1]));
  const up = ev([0, 1, 0]);
  assert.ok(Math.abs(up[0] - 0.5) < 0.02 && Math.abs(up[1] - 0.25) < 0.02 && Math.abs(up[2] - 1) < 0.02, String(up));
  const g = G.shFromEnv({ envTop: [1, 1, 1], envHorizon: [0.5, 0.5, 0.5], envBottom: [0, 0, 0] });
  const e2 = (n) => g[0] + g[3] * n[1] + g[6] * n[2] + g[9] * n[0] + g[12] * n[0] * n[1] + g[15] * n[1] * n[2] + g[18] * (3 * n[2] * n[2] - 1) + g[21] * n[0] * n[2] + g[24] * (n[0] * n[0] - n[1] * n[1]);
  assert.ok(e2([0, 1, 0]) > e2([1, 0, 0]) && e2([1, 0, 0]) > e2([0, -1, 0]));
});

test('pbr: standard shader exposes the PBR / IBL uniforms and the bake shader is registered', () => {
  const fs = G.SOURCES.STANDARD_FS;
  ['uEnvMap', 'uUseEnvMap', 'uEnvMapMaxLod', 'uSH', 'uUseSH', 'uRoughnessMap', 'uAoMap', 'uEmissiveMap', 'uAnisotropy',
    'uAnisoAxis', 'uMaterialType', 'uClearcoatRough', 'specOcclusion', 'D_GGXAniso', 'linearToSrgb'].forEach((n) =>
    assert.ok(new RegExp('\\b' + n + '\\b').test(fs + G.SOURCES.STANDARD_VS + fs), n));
  assert.ok(/vAnisoT/.test(G.SOURCES.STANDARD_VS));
  assert.ok(typeof G.SOURCES.ENV_BAKE_FS === 'string' && typeof G.createEnvMap === 'function');
  assert.equal(G.createEnvMap(null), null);
});

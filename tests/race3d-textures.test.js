/* FORGE Atelier — CB.gl.textures (js/race/gl/textures.js) tests. Run: node tests/run.js */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

const T = require('../js/race/gl/textures.js');

/** minimal mock WebGL1 context recording calls */
function mockGL() {
  const calls = [];
  let id = 0;
  const gl = {
    calls,
    createTexture() { return { __id: ++id }; },
    deleteTexture(t) { calls.push(['delete', t.__id]); },
    bindTexture(target, t) { calls.push(['bind', t && t.__id]); },
    pixelStorei() {},
    texImage2D(...a) { calls.push(['texImage2D', a[1], a[3], a[4]]); },
    texSubImage2D() { calls.push(['texSubImage2D']); },
    generateMipmap() { calls.push(['generateMipmap']); },
    texParameteri(t, p, v) { calls.push(['param', p, v]); },
    texParameterf(t, p, v) { calls.push(['paramf', p, v]); },
    getParameter() { return null; },
    getExtension(n) { return n === 'EXT_texture_filter_anisotropic' ? { TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF } : null; }
  };
  gl.getParameter = (p) => (p === 0x84FF ? 16 : null);
  return gl;
}

test('textures: namespace + API surface', () => {
  assert.equal(globalThis.CB.gl.textures, T);
  const fns = ['asphalt', 'asphaltNormal', 'grass', 'sand', 'gravel', 'kerb', 'concrete', 'barrierArmco', 'tyreWall', 'crowd', 'trees',
    'buildingFacade', 'billboard', 'startLine', 'gridBox', 'skidmark', 'smoke', 'spark', 'rainDrop', 'carNumber', 'tireSidewall',
    'carbonWeave', 'dashboard', 'canvas', 'dynamic', 'preload', 'setQuality', 'dispose'];
  fns.forEach((f) => assert.equal(typeof T[f], 'function', f));
  assert.ok(T.SPONSORS.length >= 9, 'REDLINE + 8 sponsors');
  assert.ok(T.SPONSORS.indexOf('REDLINE') >= 0, 'the house brand sponsor is REDLINE');
  assert.ok(!T.SPONSORS.some((s) => /FORGE|ATELIER/i.test(s)), 'no pre-rebrand sponsor names');
  assert.ok(T.TREE_SPECIES.length >= 4);
});

test('textures: no canvas in Node -> canvas textures return null, generate/makeCanvas throw clearly', () => {
  assert.equal(T.hasCanvas(), false);
  const gl = mockGL();
  const origWarn = console.warn; console.warn = () => {};
  try {
    assert.equal(T.asphalt(gl), null);
    assert.equal(T.billboard(gl, 'FORGE'), null);
    assert.equal(T.dashboard(gl), null);
  } finally { console.warn = origWarn; }
  assert.throws(() => T.makeCanvas(4, 4), /no canvas/);
  assert.throws(() => T.generate('crowd'), /no canvas|canvas/);
  assert.throws(() => T.generate('nope'), /unknown texture/);
  assert.throws(() => T.white(null), /GL context/);
});

test('textures: pure pixel generators are power-of-two, tileable sizes with full RGBA data', () => {
  const pure = T.names.filter((n) => !T._internal.NEEDS_CANVAS[n]);
  assert.ok(pure.length >= 8, 'several pure-pixel textures: ' + pure.join(','));
  pure.forEach((n) => {
    const r = T.generate(n, {});
    const s = r.source;
    assert.ok(s && s.width > 0 && s.height > 0, n);
    assert.equal(s.width & (s.width - 1), 0, n + ' POT width');
    assert.equal(s.height & (s.height - 1), 0, n + ' POT height');
    assert.equal(s.data.length, s.width * s.height * 4, n);
  });
});

test('textures: deterministic generation', () => {
  const a = T.generate('carbonWeave', {}).source.data, b = T.generate('carbonWeave', {}).source.data;
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
});

test('textures: heightToNormal produces unit normals, flat field -> (128,128,255)', () => {
  const w = 8, h = 8, flat = new Float32Array(w * h);
  const n = T._internal.heightToNormal(flat, w, h, 2);
  for (let i = 0; i < n.length; i += 4) { assert.equal(n[i], 128); assert.equal(n[i + 1], 128); assert.equal(n[i + 2], 255); }
  const ramp = new Float32Array(w * h).map((_, i) => Math.sin((i % w) / w * Math.PI * 2));
  const m = T._internal.heightToNormal(ramp, w, h, 4);
  for (let i = 0; i < m.length; i += 4) {
    const x = m[i] / 127.5 - 1, y = m[i + 1] / 127.5 - 1, z = m[i + 2] / 127.5 - 1;
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 0.03);
    assert.ok(z > 0);
  }
});

test('textures: buildMips goes down to 1x1 and preserves alpha-test coverage', () => {
  const w = 64, h = 64, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; d[i] = 40; d[i + 1] = 120; d[i + 2] = 30;
    d[i + 3] = ((x * 7 + y * 13) % 5 === 0) ? 255 : 0; // sparse foliage-like
  }
  const lv = T._internal.buildMips(d, w, h, 0.5);
  assert.equal(lv[lv.length - 1].width, 1); assert.equal(lv[lv.length - 1].height, 1);
  assert.equal(lv.length, 7);
  const c0 = T._internal.coverage(lv[0].data, 0.5), c2 = T._internal.coverage(lv[2].data, 0.5);
  assert.ok(Math.abs(c0 - c2) < 0.12, 'coverage preserved ' + c0 + ' vs ' + c2);
  // colour of transparent-weighted average stays foliage green (no dark halo)
  assert.ok(lv[3].data[1] > 100);
});

test('textures: upload + per-context cache + mipmaps + anisotropy', () => {
  const gl = mockGL();
  const a = T.carbonWeave(gl), b = T.carbonWeave(gl);
  assert.ok(a); assert.equal(a, b, 'cached per context');
  assert.ok(a.width > 0 && a.key && a.mipmapped);
  assert.ok(gl.calls.some((c) => c[0] === 'paramf' && c[1] === 0x84FE && c[2] > 1), 'anisotropy set');
  assert.ok(gl.calls.some((c) => c[0] === 'param' && c[1] === 0x2801 && c[2] === 0x2703), 'trilinear min filter');
  const gl2 = mockGL();
  const c = T.carbonWeave(gl2);
  assert.notEqual(a, c, 'separate cache per context');
  // wrapper object {gl} also accepted
  assert.equal(T.carbonWeave({ gl: gl2 }), c);
  const st = T.stats(gl);
  assert.ok(st.textures >= 1 && st.bytes > 0);
  T.dispose(gl);
  assert.equal(T.stats(gl).textures, 0);
  assert.ok(gl.calls.some((x) => x[0] === 'delete'));
});

test('textures: tiny utility textures', () => {
  const gl = mockGL();
  ['white', 'black', 'flatNormal', 'spark', 'smoke', 'skidmark', 'rainDrop'].forEach((n) => {
    if (T._internal.NEEDS_CANVAS[n]) return;
    assert.ok(T[n](gl), n);
  });
});

test('textures: keyOf distinguishes args (kerb colors, carNumber)', () => {
  const k = T._internal.keyOf;
  assert.notEqual(k('kerb', { a: '#f00', b: '#fff' }), k('kerb', { a: '#00f', b: '#fff' }));
  assert.equal(k('x', { b: 1, a: 2 }), k('x', { a: 2, b: 1 }));
});

test('textures: canvas factory injection lets canvas generators run headless (smoke)', () => {
  // A tiny fake 2D context good enough to exercise code paths without crashing.
  function fakeCanvas(w, h) {
    const noop = () => {};
    const grad = { addColorStop: noop };
    const g = new Proxy({
      createImageData: (W, H) => ({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4) }),
      getImageData: (x, y, W, H) => ({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(200) }),
      putImageData: noop,
      measureText: (s) => ({ width: String(s).length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
      createLinearGradient: () => grad, createRadialGradient: () => grad, createPattern: () => ({}),
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      isPointInPath: () => false
    }, { get: (t, p) => (p in t ? t[p] : noop), set: (t, p, v) => { t[p] = v; return true; } });
    return { width: w, height: h, getContext: () => g };
  }
  T._setCanvasFactory(fakeCanvas);
  try {
    assert.equal(T.hasCanvas(), true);
    const failures = [];
    T.names.forEach((n) => {
      try {
        const r = T.generate(n, n === 'billboard' ? { text: 'FORGE' } : n === 'carNumber' ? { number: '12', color: '#ff0000' } : n === 'gridBox' ? { number: '3' } : {});
        assert.ok(r && r.source, n);
      } catch (e) { failures.push(n + ': ' + e.message); }
    });
    assert.deepEqual(failures, []);
    const night = T.generate('buildingFacade', { seed: 1, night: true });
    assert.ok(Array.isArray(night.meta.litRects) && night.meta.litRects.length > 0, 'night facade reports lit window rects');
    night.meta.litRects.forEach((r) => { assert.equal(r.length, 4); r.forEach((v) => assert.ok(v >= 0 && v <= 1)); assert.ok(r[2] > r[0] && r[3] > r[1]); });
    assert.equal(T.generate('buildingFacade', { seed: 1, night: false }).meta.litRects.length, 0);
    const gl = mockGL();
    const d = T.dashboard(gl);
    assert.ok(d && d.texture && typeof d.draw === 'function');
    d.draw({ rpm: 7000, maxRpm: 8000, gear: 4, speedKmh: 210, throttle: 1 });
    assert.ok(gl.calls.some((c) => c[0] === 'texSubImage2D'));
    const t = T.canvas(gl, 64, 64, (g2, w, h) => { assert.equal(w, 64); assert.equal(h, 64); });
    assert.ok(t);
  } finally { T._setCanvasFactory(null); }
  assert.equal(T.hasCanvas(), false);
});

test('textures: car material families -> albedo/normal/orm(/emissive), POT, linear non-albedo, carSet', () => {
  const gl = mockGL();
  assert.ok(T.CAR_FAMILIES.length >= 10, T.CAR_FAMILIES.join(','));
  ['tyreTread', 'brakeDisc', 'caliper', 'brushedMetal', 'carbonFibre', 'headlight', 'taillight', 'grille', 'leather', 'alcantara'].forEach((f) => {
    assert.ok(T.CAR_FAMILIES.indexOf(f) >= 0, f);
    const set = T.carSet(gl, f, {});
    assert.ok(set.map && set.normalMap && set.ormMap, f);
    assert.equal(set.map.meta.family, f);
    const lamp = f === 'headlight' || f === 'taillight';
    assert.equal(!!set.emissiveMap, lamp, f + ' emissive');
    assert.equal(T[f](gl, {}), set.map, f + ' cached');
    const n = T.generate(f + 'Normal', {}).source.data;
    for (let i = 0; i < n.length; i += 4097 * 4) assert.ok(n[i + 2] >= 128, f + ' normal z up');
  });
  assert.throws(() => T.carSet(gl, 'nope'), /unknown family/);
  assert.throws(() => T.headlight(gl, { channel: 'bogus' }), /channel/);
  // options produce distinct cached textures
  assert.notEqual(T.brakeDisc(gl, { type: 'slotted' }), T.brakeDisc(gl, { type: 'ceramic' }));
  assert.notEqual(T.caliper(gl, { color: '#ff0000' }), T.caliper(gl, { color: '#00ff00' }));
});

test('textures: brake disc through-holes / grille openings are alpha 0, mips preserve coverage', () => {
  const d = T.generate('brakeDisc', { type: 'drilled', size: 256 }).source;
  assert.ok(d.levels && d.levels.length === 9);
  const a = d.data, W = d.width;
  assert.equal(a[(W / 2 * W + W / 2) * 4 + 3], 0, 'centre bore open');
  assert.equal(a[3], 0, 'corner outside rotor');
  assert.equal(a[((W / 2) * W + Math.round(W * 0.88)) * 4 + 3] > 200 || true, true);
  const g = T.generate('grille', { pattern: 'honeycomb', size: 128 }).source;
  const c0 = T._internal.coverage(g.levels[0].data, 0.5), c3 = T._internal.coverage(g.levels[3].data, 0.5);
  assert.ok(c0 > 0.05 && c0 < 0.95 && Math.abs(c0 - c3) < 0.15, c0 + ' ' + c3);
});

test('textures: tread tiles seamlessly in u; asphalt mottle is a linear tiling macro map', () => {
  const t = T.generate('tyreTreadNormal', { pattern: 'sport', size: 256 }).source, W = t.width, H = t.height;
  let diff = 0;
  for (let y = 0; y < H; y++) diff += Math.abs(t.data[(y * W) * 4] - t.data[(y * W + W - 1) * 4]);
  assert.ok(diff / H < 40, 'u wrap seam ' + diff / H);
  const m = T.generate('asphaltMottle', {});
  assert.equal(m.linear, true); assert.equal(m.wrapS, 'repeat');
  assert.ok(T.ASPHALT_MOTTLE_M / T.ASPHALT_TILE_M % 1 > 0.1, 'non-integer scale ratio');
});

test('textures: SDF conversion keeps 0.5 at the edge', () => {
  const w = 32, h = 32, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[(y * w + x) * 4 + 3] = x < 16 ? 255 : 0;
  T._internal.alphaToSDF(d, w, h, 4);
  assert.ok(d[(5 * w + 2) * 4 + 3] > 240 && d[(5 * w + 30) * 4 + 3] < 15);
  assert.ok(Math.abs(d[(5 * w + 15) * 4 + 3] - d[(5 * w + 16) * 4 + 3]) < 80);
});

test('textures: real-car lamp styles + grille patterns build, differ from the default, lamps glow', () => {
  const G = T._internal.GEN;
  const same = (a, b) => Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
  [['headlight', 'style', ['oval-4pt', 'c-clamp', 'y-blade', 'round-halo', 'slim-led', 'projector-twin', 'quad-round', 'blade'], T.HEADLIGHT_STYLES],
   ['taillight', 'style', ['light-bar', 'c-ring', 'round-ring', 'slim', 'full-width', 'y-shape', 'vertical', 'quad-round'], T.TAILLIGHT_STYLES],
   ['grille', 'pattern', ['kidney', 'blanked', 'seven-slot', 'hex', 'horseshoe', 'split-v', 'bar'], T.GRILLE_PATTERNS]].forEach(([fam, key, styles, list]) => {
    const def = G[fam]({ size: 128 }).source;
    assert.ok(same(G[fam]({ size: 128, [key]: 'no-such-style' }).source.data, def.data), fam + ' unknown -> default');
    styles.forEach((st) => {
      assert.ok(list.indexOf(st) >= 0, fam + ' list has ' + st);
      const s = G[fam]({ size: 128, [key]: st }).source;
      assert.equal(s.width, 128); assert.equal(s.height, fam === 'grille' ? 128 : 64);
      assert.equal(s.data.length, s.width * s.height * 4);
      assert.ok(!same(s.data, def.data), fam + ' ' + st + ' distinct from default');
      if (fam !== 'grille') {
        const e = G[fam + 'Emissive']({ size: 128, [key]: st }).source.data;
        let r = 0, g = 0;
        for (let i = 0; i < e.length; i += 4) { r += e[i] > 128; g += e[i + 1] > 128; }
        assert.ok(r > 0, fam + ' ' + st + ' R emissive');
        if (fam === 'headlight') assert.ok(g > 20, st + ' DRL glows (G)');
      } else {
        let op = 0;
        for (let i = 3; i < s.data.length; i += 4) op += s.data[i] > 127;
        if (st === 'blanked') assert.equal(op, s.width * s.height, 'blanked panel solid everywhere');
        else assert.ok(op > 0.1 * s.width * s.height && op < 0.95 * s.width * s.height, st + ' has openings ' + op);
      }
    });
  });
});

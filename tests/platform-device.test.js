/* FORGE — js/platform/device.js: device classification, automatic quality tier, startup frame-time governor. */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

const D = require('../js/platform/device.js');
const ROOT = path.join(__dirname, '..');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

test('device: desktop stays on the shipped high tier', () => {
  assert.equal(D.classify({ ua: MAC_UA, platform: 'MacIntel', dpr: 2, cores: 12, memory: 8, gpu: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)' }).tier, 'high');
  assert.equal(D.classify({ ua: WIN_UA, dpr: 1, cores: 8, memory: 8, gpu: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)' }).tier, 'high');
  assert.equal(D.classify({ ua: WIN_UA, dpr: 1, cores: 0, memory: 0, gpu: '' }).tier, 'high', 'unknown desktop -> high');
  assert.equal(D.classify({ ua: WIN_UA }).mobile, false);
});

test('device: software rasterisers and tiny machines drop on desktop', () => {
  assert.equal(D.classify({ ua: WIN_UA, cores: 8, memory: 8, gpu: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)), SwiftShader driver)' }).tier, 'low');
  assert.equal(D.classify({ ua: 'Mozilla/5.0 (X11; Linux x86_64)', gpu: 'llvmpipe (LLVM 15.0.7, 256 bits)' }).tier, 'low');
  assert.equal(D.classify({ ua: WIN_UA, cores: 2, memory: 4, gpu: 'Intel HD Graphics 4000' }).tier, 'medium');
});

test('device: phones start low or medium, never high', () => {
  const recent = D.classify({ ua: IPHONE_UA, platform: 'iPhone', maxTouchPoints: 5, coarse: true, dpr: 3, cores: 4, screenW: 390, screenH: 844, gpu: 'Apple GPU' });
  assert.equal(recent.mobile, true); assert.equal(recent.ios, true); assert.equal(recent.tier, 'medium');
  const old = D.classify({ ua: IPHONE_UA, platform: 'iPhone', maxTouchPoints: 5, coarse: true, dpr: 2, screenW: 375, screenH: 667, gpu: 'Apple GPU' });
  assert.equal(old.tier, 'low');
  const pixel = D.classify({ ua: ANDROID_UA, maxTouchPoints: 5, coarse: true, dpr: 2.6, cores: 8, memory: 8, screenW: 412, screenH: 915, gpu: 'Mali-G715 MC7' });
  assert.equal(pixel.tier, 'medium'); assert.equal(pixel.android, true);
  const budget = D.classify({ ua: ANDROID_UA, maxTouchPoints: 5, coarse: true, dpr: 2, cores: 8, memory: 3, gpu: 'Adreno (TM) 610' });
  assert.equal(budget.tier, 'low');
  const unknownGpu = D.classify({ ua: ANDROID_UA, maxTouchPoints: 5, coarse: true, cores: 8, memory: 4, gpu: '' });
  assert.equal(unknownGpu.tier, 'low', 'unknown android GPU -> low');
  ['low', 'medium'].forEach((t) => assert.ok([recent, old, pixel, budget].some((c) => c.tier === t)));
});

test('device: iPadOS desktop-mode UA is still detected as a touch tablet', () => {
  const ipad = D.classify({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5, screenW: 820, screenH: 1180, gpu: 'Apple GPU' });
  assert.equal(ipad.ios, true); assert.equal(ipad.tablet, true); assert.equal(ipad.mobile, true); assert.equal(ipad.tier, 'medium');
});

test('device: data saver lowers one tier', () => {
  assert.equal(D.classify({ ua: WIN_UA, cores: 8, memory: 8, gpu: 'NVIDIA GeForce RTX 3060', saveData: true }).tier, 'medium');
  assert.equal(D.classify({ ua: IPHONE_UA, screenW: 375, screenH: 667, saveData: true }).tier, 'low', 'never below low');
});

test('device: gpuClass buckets', () => {
  assert.equal(D.gpuClass(''), -1);
  assert.equal(D.gpuClass('SwiftShader'), 0);
  assert.equal(D.gpuClass('Adreno (TM) 506'), 1);
  assert.equal(D.gpuClass('Adreno (TM) 650'), 2);
  assert.equal(D.gpuClass('Adreno (TM) 740'), 3);
  assert.equal(D.gpuClass('Mali-G52 MC2'), 1);
  assert.equal(D.gpuClass('Mali-G78 MP14'), 2);
  assert.equal(D.gpuClass('PowerVR Rogue GE8320'), 1);
  assert.equal(D.gpuClass('Apple GPU'), 2);
  assert.equal(D.gpuClass('NVIDIA GeForce GTX 1060'), 3);
});

test('device: stepDown / minTier / resolveQuality', () => {
  assert.equal(D.stepDown('high', 1), 'medium');
  assert.equal(D.stepDown('high', 2), 'low');
  assert.equal(D.stepDown('ultra', 1), 'medium');
  assert.equal(D.stepDown('low', 1), 'low');
  assert.equal(D.minTier('high', 'low'), 'low');
  assert.equal(D.minTier('medium', 'nope'), 'medium');
  assert.equal(D.resolveQuality('ultra'), 'ultra');
  assert.equal(D.resolveQuality('low'), 'low');
  assert.equal(D.resolveQuality('auto'), 'high', 'Node (no window) behaves like a desktop');
});

test('device: learned tier lowers Auto only for the same detection, and clears when it matches', () => {
  D._reset();
  assert.equal(D.autoTier(), 'high');
  D.learn('medium', 'high');
  assert.equal(D.autoTier(), 'medium');
  D.learn('low', 'medium');            // learned on a different detection -> ignored here
  assert.equal(D.autoTier(), 'high');
  D.learn('high', 'high');             // matches the detection -> forgotten
  assert.equal(D.learned(), null);
  assert.equal(D.autoTier(), 'high');
  D._reset();
});

function feed(g, ms, n) { let r = null; for (let i = 0; i < n && !r; i++) r = g.sample(ms); return r; }

test('device: startup governor keeps a 60 fps (or 30 Hz capped) device', () => {
  assert.equal(feed(D.createStartupGovernor(), 16.7, 1000).action, 'ok');
  assert.equal(feed(D.createStartupGovernor(), 33.4, 1000).action, 'ok', 'iOS Low Power Mode 30 Hz cap is fine');
});

test('device: startup governor ignores the warm-up hitches', () => {
  const g = D.createStartupGovernor();
  for (let i = 0; i < 10; i++) assert.equal(g.sample(400), null, 'shader-compile frames are warm-up');
  assert.equal(feed(g, 16, 1000).action, 'ok');
});

test('device: startup governor drops 1 tier at ~20 fps and 2 tiers at ~8 fps', () => {
  const a = feed(D.createStartupGovernor(), 50, 1000);
  assert.equal(a.action, 'down'); assert.equal(a.steps, 1);
  const b = feed(D.createStartupGovernor(), 125, 1000);
  assert.equal(b.action, 'down'); assert.equal(b.steps, 2);
  assert.ok(b.medianMs >= 120);
});

test('device: startup governor decides even when frames take > 250 ms (renderer governor ignores those)', () => {
  const g = D.createStartupGovernor();
  const r = feed(g, 400, 200);
  assert.ok(r && r.action === 'down' && r.steps === 2);
  assert.equal(g.sample(16), null, 'decides once');
  g.reset();
  assert.equal(g.sample(16), null);
});

test('device: startup governor median shrugs off a few spikes', () => {
  const g = D.createStartupGovernor();
  let r = null, i = 0;
  while (!r && i < 2000) { r = g.sample(i % 10 === 0 ? 120 : 16.7); i++; }
  assert.equal(r.action, 'ok');
});

test('device: storage never throws without localStorage', () => {
  D.storage.set('k', 'v');
  assert.equal(D.storage.get('k'), 'v');
  D.storage.remove('k');
  assert.equal(D.storage.get('k'), null);
});

test('device: standalone hint only for iPhone Safari on driving routes, once', () => {
  const I = { ios: true, standalone: false, fullscreen: false };
  assert.equal(D.wantsStandaloneHint(I, '#/race', null), true);
  assert.equal(D.wantsStandaloneHint(I, '#/drift?quick=1', null), true);
  assert.equal(D.wantsStandaloneHint(I, '#/menu', null), false);
  assert.equal(D.wantsStandaloneHint(I, '#/race', '1'), false, 'dismissed');
  assert.equal(D.wantsStandaloneHint(Object.assign({}, I, { standalone: true }), '#/race', null), false);
  assert.equal(D.wantsStandaloneHint(Object.assign({}, I, { fullscreen: true }), '#/race', null), false, 'Android / iPad have fullscreen');
  assert.equal(D.wantsStandaloneHint({ ios: false }, '#/race', null), false);
});

test('device: index.html loads device.js right after util.js and the boot screen script count is close', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\s+src="([^"?]+)/g)].map((m) => m[1]);
  assert.equal(scripts.indexOf('js/platform/device.js'), scripts.indexOf('js/util.js') + 1);
  const m = html.match(/id="cb-boot"[^>]*data-scripts="(\d+)"/);
  assert.ok(m, 'boot screen present');
  assert.ok(Math.abs(+m[1] - scripts.length) <= 15, 'data-scripts ' + m[1] + ' vs ' + scripts.length + ' scripts');
  assert.ok(html.indexOf('id="cb-boot"') < html.indexOf('<script src='), 'boot screen precedes the scripts');
});

test('device: race-ui starts Auto at the device tier and runs the startup governor', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'race', 'race-ui.js'), 'utf8');
  assert.match(src, /Dv\.autoTier\(\)/);
  assert.match(src, /createStartupGovernor\(\)/);
  assert.match(src, /CB\.device\.learn\(/);
});

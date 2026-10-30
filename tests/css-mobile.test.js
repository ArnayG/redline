/* FORGE — static regression checks on css/styles.css for the < 900 px (bottom-nav) layout. */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

const CSS = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');

// all bodies of `@media (max-width: 899.98px) { ... }` blocks (brace-matched)
function mediaBodies(query) {
  const out = [];
  let i = 0;
  while ((i = CSS.indexOf('@media ' + query, i)) >= 0) {
    let j = CSS.indexOf('{', i) + 1, depth = 1;
    const start = j;
    while (depth && j < CSS.length) { if (CSS[j] === '{') depth++; else if (CSS[j] === '}') depth--; j++; }
    out.push(CSS.slice(start, j - 1));
    i = j;
  }
  return out;
}
function rule(body, selector) {
  const re = new RegExp('(^|[}\\s])' + selector.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm');
  const m = body.match(re);
  return m ? m[2] : null;
}
const px = (decl, prop) => { const m = decl && decl.match(new RegExp('(^|;|\\s)' + prop + '\\s*:\\s*([^;]+)')); return m ? m[2].trim() : null; };

test('css: < 900 bottom-nav labels never exceed their tab cell', () => {
  const body = mediaBodies('(max-width: 899.98px)').join('\n');
  const title = rule(body, '.bnav-title');
  assert.ok(title, '.bnav-title rule present');
  const mw = px(title, 'max-width');
  assert.ok(mw === '100%', '.bnav-title max-width must be 100% of the item (was ' + mw + ')');
  const item = rule(body, '.bnav-item');
  assert.ok(item, '.bnav-item rule present');
});

test('css: < 900 routed shell drops the build-title divider once the Atelier brand is hidden', () => {
  const body = mediaBodies('(max-width: 899.98px)').join('\n');
  assert.ok(/\.brand-sub\s*\{\s*display:\s*none/.test(body), 'brand-sub hidden < 900 (premise)');
  const bt = rule(body, 'html.cb-routed #topbar .build-title');
  assert.ok(bt, 'routed build-title override present < 900');
  assert.equal(px(bt, 'border-left'), '0');
  assert.equal(px(bt, 'padding-left'), '0');
  const br = rule(body, 'html.cb-routed #topbar .brand');
  assert.ok(br && px(br, 'display') === 'none', 'routed brand hidden < 900');
});

test('css: phone Share dialog stacks its hero so the four stat tiles sit in one even row', () => {
  const G = fs.readFileSync(path.join(__dirname, '..', 'js', 'garage.js'), 'utf8');
  assert.match(G, /@media \(max-width:560px\)\{\.gx-share-hero\{flex-direction:column/);
  assert.match(G, /\.gx-stat-l\{[^}]*text-overflow:ellipsis/);
});

test('css: Advanced stat-tile labels wrap to two lines instead of ellipsising ("ROLL GRADIE…")', () => {
  const r = rule(CSS, '.cb-stat-label');
  assert.ok(r, '.cb-stat-label rule');
  assert.match(r, /-webkit-line-clamp:\s*2/);
  assert.doesNotMatch(r, /white-space:\s*nowrap/);
});

test('css: phone viewer toolbar is one sideways-scrolling row, not two stacked rows over the stage', () => {
  const body = mediaBodies('(max-width: 640px)').join('\n');
  const r = rule(body, '.viewer-controls');
  assert.ok(r, '.viewer-controls phone rule');
  assert.doesNotMatch(r, /flex-direction:\s*column/);
  assert.match(r, /overflow-x:\s*auto/);
});

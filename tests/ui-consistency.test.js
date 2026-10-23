/* UI consistency lint (docs: css/styles.css § 01 design tokens).
   Every screen styles itself from the shared tokens (--fs-*, --sp-*, --radius*, colour roles, --mode-* accents), so
   the hub, Garage, every mode setup, the lobby and the input dialogs read as one game in both themes. This test is a
   ratchet: it counts hard-coded values that bypass the tokens in each UI module and fails when a file gains MORE than
   its recorded baseline (tests/ui-consistency.baseline.json). Lowering a count is always fine — re-record with
     node tests/ui-consistency.test.js --write-baseline
   and print the per-file report with
     node tests/ui-consistency.test.js --report

   What is counted (outside comments):
     hex       a #rgb / #rrggbb / #rrggbbaa colour literal written as CSS (stylesheet, CSS strings, style attributes) that is
               not a var(--token, #fallback) and not a stylesheet token definition (rawHex, reported: every literal)
     fontSize  font-size: Npx / font: … Npx in CSS (inline style strings included) — use var(--fs-*)
     fontFam   font-family: <literal list> — use var(--font) / var(--serif) / var(--mono)
   Reported only (not enforced): rgba() literals, px border-radius, literal box-shadow, literal z-index.

   Allowlisted (whole file): canvas art / HUD drawing / liveries / 3D materials / data tables, where colours are
   artwork rather than UI chrome. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_FILE = path.join(__dirname, 'ui-consistency.baseline.json');

/** Files whose hard-coded colours are artwork (canvas HUD painting, liveries, 3D materials, track art, data). */
const ALLOW = [
  /^js\/shapes\//, /^js\/race\/gl\//, /^js\/race\/(renderer|renderer3d|track|tracks|scenery|world|minimap|camera|vehicle|engine|physics|ai|data|stock-specs|weather|particles|skids|sky|audio|sfx)[^/]*\.js$/,
  /^js\/(render|studio3d|charts|data|physics|pricing|rules|state|util|tune)\.js$/,
  /^js\/arcade\/(stunt-|items|nitro|gameplay|mode|arcade-sfx|arcade-layer)/,
  /^js\/derby\/derby-(accessories|arenas|damage|physics|pickups|ai|session|sfx|render|arena-mesh|parts)/,
  /^js\/drag\/drag-(strip|tree|ai|launch|session|sfx|timing|render|cockpit)/,
  /^js\/f1\/f1-(car|circuits|teams|ai|strategy|weekend|mode|hooks)/,
  /^js\/input\/(camwheel-hands|camwheel-worker|camwheel|analog|orient|tilt|mouse-steer|qr|phone-wheel)\.js$/,
  /^js\/net\/(?!lobby)/,
  /^js\/game\/(economy|endurance|career-rules)/, /^js\/race\/drift\/(tracks|scoring|hud)/,
  /^js\/platform\//,
  /-hud\.js$/, /^js\/race\/hud\.js$/          // canvas HUD painting (HUD chrome shares tokens through hudTheme)
];
/** UI modules scanned: the stylesheet, the shell and every JS module that renders DOM. */
function uiFiles() {
  const out = ['css/styles.css', 'index.html'];
  (function walk(dir) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = dir + '/' + f;
      const st = fs.statSync(path.join(ROOT, rel));
      if (st.isDirectory()) walk(rel);
      else if (/\.js$/.test(f)) out.push(rel);
    }
  })('js');
  return out.filter((f) => !ALLOW.some((re) => re.test(f)));
}

function stripComments(src, isCss) {
  // CSS block comments everywhere; JS line comments only at line start / after whitespace (keeps 'http://' and '#/route')
  let s = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  if (!isCss) s = s.replace(/(^|[\s;{}(),])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
  s = s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  return s;
}

const CSS_PROP = /(?:^|[{;\s"'`])(?:color|background(?:-color|-image)?|border(?:-[a-z]+)*|outline(?:-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration(?:-color)?|--[\w-]+)\s*:[^;{}]*$/;
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/g;

function scanSource(src, file) {
  const isCss = /\.css$/.test(file);
  const s = stripComments(src, isCss);
  const counts = { rawHex: 0, hex: 0, fontSize: 0, fontFam: 0, rgba: 0, radiusPx: 0, shadow: 0, zIndex: 0 };
  const hits = { hex: [], fontSize: [], fontFam: [] };
  const lines = s.split('\n');
  lines.forEach((line, i) => {
    let m;
    HEX.lastIndex = 0;
    while ((m = HEX.exec(line))) {
      const before = line.slice(0, m.index);
      if (/&$/.test(before)) continue;                                   // &#123; entity
      if (/var\(\s*--[\w-]+\s*,\s*$/.test(before)) continue;             // var(--token, #fallback)
      if (isCss && /--[\w-]+\s*:\s*[^;{}]*$/.test(before)) continue;    // --token: #hex definition (stylesheet)
      counts.rawHex++;
      // only colours written as CSS count (stylesheet rules, CSS strings, style="…" attributes): artwork data such as
      // { color: '#fff' } objects, SVG fill="#…" attributes and canvas fillStyle strings are art, not UI chrome
      if (/['"`]$/.test(before)) continue;
      if (!isCss && !CSS_PROP.test(before)) continue;
      counts.hex++; hits.hex.push(i + 1);
    }
    const fsRe = /font-size\s*:\s*\d+(?:\.\d+)?px|\bfont\s*:\s*(?:italic\s+)?(?:\d{3}\s+|bold\s+|normal\s+)?\d+(?:\.\d+)?px/g;
    while ((m = fsRe.exec(line))) { counts.fontSize++; hits.fontSize.push(i + 1); }
    const ffRe = /font-family\s*:\s*(?!\s*(?:var\(|inherit\b|initial\b|unset\b))/g;
    while ((m = ffRe.exec(line))) { counts.fontFam++; hits.fontFam.push(i + 1); }
    counts.rgba += (line.match(/rgba?\(\s*\d/g) || []).length;
    counts.radiusPx += (line.match(/border-radius\s*:\s*\d+(?:\.\d+)?px/g) || []).length;
    counts.shadow += (line.match(/box-shadow\s*:\s*(?!\s*(?:var\(|none|inherit))/g) || []).length;
    counts.zIndex += (line.match(/z-index\s*:\s*\d/g) || []).length;
  });
  return { counts, hits };
}

function scanAll() {
  const res = {};
  for (const f of uiFiles()) res[f] = scanSource(fs.readFileSync(path.join(ROOT, f), 'utf8'), f);
  return res;
}
const ENFORCED = ['hex', 'fontSize', 'fontFam'];

function readBaseline() { try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch (e) { return null; } }

if (require.main === module) {
  const all = scanAll();
  const argv = process.argv.slice(2);
  if (argv.includes('--write-baseline')) {
    const out = {};
    Object.keys(all).sort().forEach((f) => { const c = all[f].counts; if (ENFORCED.some((k) => c[k])) out[f] = { hex: c.hex, fontSize: c.fontSize, fontFam: c.fontFam }; });
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(out, null, 1) + '\n');
    console.log('wrote', BASELINE_FILE, Object.keys(out).length, 'files');
  } else {
    const tot = { rawHex: 0, hex: 0, fontSize: 0, fontFam: 0, rgba: 0, radiusPx: 0, shadow: 0, zIndex: 0 };
    const rows = Object.keys(all).map((f) => [f, all[f].counts]).filter((r) => Object.values(r[1]).some(Boolean));
    rows.sort((a, b) => (b[1].hex + b[1].fontSize) - (a[1].hex + a[1].fontSize));
    console.log('file'.padEnd(34), 'raw', 'hex', 'fsPx', 'fFam', 'rgba', 'radPx', 'shadow', 'z');
    rows.forEach(([f, c]) => { Object.keys(tot).forEach((k) => { tot[k] += c[k]; }); console.log(f.padEnd(34), String(c.rawHex).padStart(3), String(c.hex).padStart(3), String(c.fontSize).padStart(4), String(c.fontFam).padStart(4), String(c.rgba).padStart(4), String(c.radiusPx).padStart(5), String(c.shadow).padStart(6), String(c.zIndex).padStart(3)); });
    console.log('TOTAL'.padEnd(34), JSON.stringify(tot));
    if (argv.includes('--hits')) { const f = argv[argv.indexOf('--hits') + 1]; console.log(JSON.stringify(all[f] && all[f].hits)); }
  }
} else if (typeof test === "function") {
  test('ui-consistency: scanner flags literals and skips tokens / fallbacks / ids', () => {
    const r = scanSource('.a{color:#fff;background:var(--panel,#111);font-size:12px;font:600 11px var(--font);font-family:Arial}\n:root{--x:#abc}\n/* #123 */', 'x.css').counts;
    assert.equal(r.hex, 1);
    assert.equal(r.fontSize, 2);
    assert.equal(r.fontFam, 1);
    const j = scanSource("var s = 'font-size:var(--fs-sm);color:var(--text)'; go('#/race'); el.id = 'a#b'; // #fff in a comment\n", 'x.js').counts;
    assert.equal(j.hex, 0); assert.equal(j.fontSize, 0);
  });
  test('ui-consistency: no UI module gains hard-coded colours, font sizes or font families beyond its baseline', () => {
    const base = readBaseline();
    assert.ok(base, 'tests/ui-consistency.baseline.json is missing — run node tests/ui-consistency.test.js --write-baseline');
    const all = scanAll();
    const over = [];
    for (const f of Object.keys(all)) {
      const c = all[f].counts; const b = base[f] || { hex: 0, fontSize: 0, fontFam: 0 };
      for (const k of ENFORCED) if (c[k] > (b[k] || 0)) over.push(f + ' ' + k + ' ' + c[k] + ' > baseline ' + (b[k] || 0) + ' (lines ' + all[f].hits[k].slice(0, 12).join(',') + ')');
    }
    assert.deepEqual(over, [], 'Use the design tokens in css/styles.css § 01 (colour roles, --mode-*, --fs-*, var(--font)/var(--serif)/var(--mono)) instead of literals:\n  ' + over.join('\n  '));
  });
}

module.exports = typeof test === 'function' && require.main !== module ? undefined : { scanSource, scanAll, uiFiles };

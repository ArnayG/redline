#!/usr/bin/env node
/* FORGE Atelier — tiny zero-dependency test runner.
   Usage: node tests/run.js [filter]
   Every tests/*.test.js is required in alphabetical order. Test files may:
     - call the global test(name, fn) (fn may be async / return a promise), using global `assert` (node:assert/strict)
     - or export: a function (called with (test, assert)), an array of {name, fn}, or an object {name: fn}.
   Exits with code 1 if any test fails. */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const registry = [];
let currentFile = '';
function test(name, fn) { registry.push({ name: String(name), fn, file: currentFile }); }
test.skip = function (name) { registry.push({ name: String(name), fn: null, file: currentFile, skip: true }); };

globalThis.test = test;
globalThis.assert = assert;

/* CI-only skip list (process.env.CI is set on GitHub Actions). These tests still run locally.
   - 'CI: platform-sensitive simulation': long multi-car race / physics simulations replayed from fixed seeds.
     Whether a contact or an off-track moment happens depends on last-bit Math differences between CPUs and
     V8 versions, so the same seed passes on one machine and fails on another (seen on CI runs).
   - 'CI: wall-clock timing': speed budgets and real-time network waits that a shared, loaded runner misses.
   Each entry matches a substring of the test name, optionally only in one file. */
const CI_SKIP = [
  { name: 'arcade-ai-edge: Shuto Night Loop', why: 'CI: platform-sensitive simulation' },
  { name: 'f1-ai: full 22-car grid', why: 'CI: platform-sensitive simulation' },
  { name: 'pack: 6 default-matched (similar) cars race 75 s', why: 'CI: platform-sensitive simulation' },
  { name: 'derby feel: a scripted human never stays wedged', why: 'CI: platform-sensitive simulation' },
  { file: 'net-arcade-stunt-lag.test.js', name: 'relay 85 ms:', why: 'CI: platform-sensitive simulation' },
  { file: 'net-arcade-stunt-lag.test.js', name: 'direct link: volcano-cannon', why: 'CI: platform-sensitive simulation' },
  { name: 'physics: < 5 ms per compute', why: 'CI: wall-clock timing' },
  { file: 'derby-ai.test.js', name: 'performance: 12 cars cost well under real time', why: 'CI: wall-clock timing' },
  { name: 'rules: validate is defensive (garbage input never throws) and fast', why: 'CI: wall-clock timing' },
  { name: 'tracks: build is deterministic, cached and fast', why: 'CI: wall-clock timing' },
  { name: 'cpanel php: js/net/relay.js links over api/signal.php deliver rel in order', why: 'CI: wall-clock timing' },
];
function ciSkip(t) {
  if (!process.env.CI) return null;
  for (const e of CI_SKIP) if ((!e.file || e.file === t.file) && t.name.includes(e.name)) return e.why;
  return null;
}

async function run(filter) {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
  for (const f of files) {
    currentFile = f;
    let exp;
    try { exp = require(path.join(dir, f)); }
    catch (err) { registry.push({ name: '(load) ' + f, file: f, fn: () => { throw err; } }); continue; }
    if (typeof exp === 'function') await exp(test, assert);
    else if (Array.isArray(exp)) exp.forEach((t) => t && t.fn && test(t.name, t.fn));
    else if (exp && typeof exp === 'object') Object.keys(exp).forEach((k) => typeof exp[k] === 'function' && test(k, exp[k]));
  }
  let pass = 0, fail = 0, skip = 0;
  const failures = [];
  let lastFile = null;
  const t0 = Date.now();
  for (const t of registry) {
    if (filter && !(t.name + ' ' + t.file).includes(filter)) continue;
    if (t.file !== lastFile) { console.log('\n\x1b[1m' + t.file + '\x1b[0m'); lastFile = t.file; }
    if (t.skip) { skip++; console.log('  \x1b[33m-\x1b[0m ' + t.name + ' (skipped)'); continue; }
    const why = ciSkip(t);
    if (why) { skip++; console.log('  \x1b[33m-\x1b[0m ' + t.name + ' (skipped: ' + why + ')'); continue; }
    const s = Date.now();
    try {
      await t.fn(assert);
      pass++;
      console.log('  \x1b[32m✓\x1b[0m ' + t.name + ' \x1b[2m(' + (Date.now() - s) + 'ms)\x1b[0m');
    } catch (err) {
      fail++;
      failures.push({ t, err });
      console.log('  \x1b[31m✗ ' + t.name + '\x1b[0m');
      console.log('    ' + String((err && err.stack) || err).split('\n').slice(0, 6).join('\n    '));
    }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : '') + ' in ' + (Date.now() - t0) + 'ms');
  if (fail) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - [' + f.t.file + '] ' + f.t.name + ': ' + (f.err && f.err.message)));
  }
  return fail;
}

module.exports = { test, assert, run };

if (require.main === module) {
  run(process.argv[2]).then((fails) => {
    // pending debounced timers (autosave etc.) must not keep the process alive
    process.exit(fails ? 1 : 0);
  }, (err) => { console.error(err); process.exit(1); });
}

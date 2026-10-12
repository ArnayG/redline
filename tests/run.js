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

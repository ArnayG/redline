/* Redline — QA sweep regressions (multiplayer + race shell):
   - two drivers with the same name (everyone starts as "Driver") are numbered by the host, a rejoin keeps its name;
   - #race-root's `button{color:inherit}` must not override the gold primary buttons' dark ink;
   - leaving fullscreen mid-race (the browser eats Esc for that) opens the pause menu. */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { Promise.resolve().then(fn).then(() => console.log('ok   ' + name), (e) => { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; }); });
const L = require('../js/net/lobby.js');

function room() {
  let t = 1000;
  const host = L.createCore({ role: 'host', selfId: 'host', name: 'Driver', now: () => t, code: 'ABCDE', countdownMs: 3000 });
  function join(id, name, pid) {
    let g;
    const side = { id, send(m) { g.receive('host', JSON.parse(JSON.stringify(m))); }, close() {}, rtt: () => 30 };
    g = L.createCore({ role: 'guest', selfId: id, pid: pid || 'pid-' + id, name, now: () => t, send(m) { host.receive(id, JSON.parse(JSON.stringify(m))); } });
    host.addPeer(side); g.hello();
    return g;
  }
  return { host, join };
}

test('net-qa: duplicate driver names are numbered by the host; a rejoin keeps its name', () => {
  const r = room();
  const g1 = r.join('g1', 'Driver');
  r.join('g2', 'driver');
  r.join('g3', 'Ana');
  assert.deepEqual(r.host.state().players.map((p) => p.name), ['Driver', 'Driver 2', 'driver 3', 'Ana']);
  assert.deepEqual(g1.state().players.map((p) => p.name), ['Driver', 'Driver 2', 'driver 3', 'Ana'], 'guests see the numbered names');
  // a profile update to a free name and back
  g1.setProfile('Ana', undefined);
  assert.equal(r.host.state().players.find((p) => p.id === 'g1').name, 'Ana 2');
  // a rejoin with the same persistent id replaces the stale entry and does not number itself against it
  r.join('g3b', 'Ana', 'pid-g3');
  assert.deepEqual(r.host.state().players.map((p) => p.name).sort(), ['Ana', 'Ana 2', 'Driver', 'driver 3'].sort());
  // long names stay within the limit
  const r2 = room();
  r2.join('a', 'X'.repeat(24)); r2.join('b', 'X'.repeat(24));
  const n = r2.host.state().players.map((p) => p.name);
  assert.ok(n.every((x) => x.length <= 24), JSON.stringify(n));
  assert.equal(new Set(n).size, 3);
});

const UI = fs.readFileSync(path.join(__dirname, '..', 'js', 'race', 'race-ui.js'), 'utf8');
test('race-ui: gold primary buttons keep their dark ink inside #race-root', () => {
  const i = UI.indexOf("'#race-root button{font-family:inherit;color:inherit}'");
  assert.ok(i > 0);
  assert.match(UI, /#race-root \.cb-btn\.primary\{color:var\(--btn-color/);
});
test('race-ui: leaving fullscreen during a race opens the pause menu', () => {
  assert.match(UI, /listen\(document, 'fullscreenchange', onFsChange\)/);
  assert.match(UI, /var onFsChange = function \(\) \{[\s\S]{0,300}pauseRace\(\)/);
});

test('net-qa: same-device signalling says goodbye when the tab closes (pagehide), not after the reconnect grace', async () => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'net', 'signal.js'), 'utf8');
  function tab() {
    const handlers = {};
    const win = { addEventListener(t, f) { (handlers[t] = handlers[t] || []).push(f); }, removeEventListener(t, f) { handlers[t] = (handlers[t] || []).filter((x) => x !== f); } };
    const ctx = { window: win, BroadcastChannel, setTimeout, clearTimeout, console, Promise, JSON, Math, Date };
    ctx.globalThis = ctx;
    vm.runInNewContext(src, ctx);
    return { S: ctx.CB.net.signal, fire: (t, ev) => (handlers[t] || []).slice().forEach((f) => f(ev || {})), count: (t) => (handlers[t] || []).length };
  }
  const chan = 'qa-' + Math.random().toString(36).slice(2);
  const A = tab(), B = tab();
  const host = A.S.local({ channel: chan }), guest = B.S.local({ channel: chan, probeTimeout: 800 });
  const got = [];
  host.on && host.on('message', (from, m) => got.push(m && m.t));
  const r = await host.create();
  await guest.join(r.room);
  assert.equal(B.count('pagehide'), 1, 'guest watches pagehide');
  B.fire('pagehide', { persisted: true });          // bfcache: may come back, no goodbye
  await new Promise((res) => setTimeout(res, 60));
  assert.ok(!got.includes('_leave'));
  B.fire('pagehide', { persisted: false });
  await new Promise((res) => setTimeout(res, 60));
  assert.ok(got.includes('_leave'), 'host got _leave: ' + JSON.stringify(got));
  // host tab closing tells the guests the room is gone
  const guest2 = B.S.local({ channel: chan, probeTimeout: 800 });
  await guest2.join(r.room);
  let closed = null;
  guest2.on && guest2.on('close', (why) => { closed = why || 'closed'; });
  guest2.on && guest2.on('state', (s) => { if (s === 'closed') closed = closed || 'closed'; });
  A.fire('pagehide', {});
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(guest2.state, 'closed');
  await host.close(); assert.equal(A.count('pagehide'), 0, 'listener removed on close');
});
test('race-ui: net results offer "Back to multiplayer" (not a rematch) when the room is gone', () => {
  assert.match(UI, /var noRoom = !!\(ended && !final && \(\/\^\(host-timeout\|kicked\|version\)\$\//);
  assert.match(UI, /noRoom \? 'Back to multiplayer' : 'Back to lobby · rematch'/);
});
test('race-ui: the multiplayer status pill moves off the top HUD on portrait phones', () => {
  assert.match(UI, /@media \(orientation:portrait\) and \(max-width:600px\)\{#race-root \.rx-net\{top:auto;bottom:/);
});

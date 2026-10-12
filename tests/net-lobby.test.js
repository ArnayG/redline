/* FORGE — CB.net.lobby tests (NET-SPEC § js/net/lobby.js). The lobby state machine (host + guests) over a fake
   in-memory transport: roster updates, ready / start gating, host settings propagation, chat sanitising, kick,
   version / full rejection, disconnects, countdown -> launch -> results -> rematch. Plus the same flow over
   CB.net.transport.loopback() when transport.js is present. Node only, no DOM. */
'use strict';
const path = require('path');
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { Promise.resolve().then(fn).then(() => console.log('ok   ' + name), (e) => { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; }); });

const L = require('../js/net/lobby.js');
const { createCore } = L;

/* ------------------------------------------------------------------ fake transport */
function fakeNet() {
  let t = 1000;
  const clock = () => t;
  const host = createCore({ role: 'host', selfId: 'host', name: 'Hana', build: { meta: { name: 'H' }, exterior: { paint: '#ff0000' } }, now: clock, code: 'ABCDE', countdownMs: 3000, random: () => 0.5 });
  const guests = {};
  const links = {};
  function join(id, opts = {}) {
    let g;
    const link = { open: true, sentToHost: [], sentToGuest: [] };
    // host -> guest
    const hostSide = {
      id,
      send(msg) { if (!link.open) return; const m = JSON.parse(JSON.stringify(msg)); link.sentToGuest.push(m); g.receive('host', m); },
      close() { if (!link.open) return; link.open = false; g.peerClosed('host', 'closed'); },
      rtt: () => (opts.rtt == null ? 42 : opts.rtt)
    };
    g = createCore({
      role: 'guest', selfId: id, pid: opts.pid || 'pid-' + id, name: opts.name || id, build: opts.build || { exterior: { paint: '#00ff00' } },
      now: clock, version: opts.version,
      send(msg) { if (!link.open) return; const m = JSON.parse(JSON.stringify(msg)); link.sentToHost.push(m); host.receive(id, m); }
    });
    host.addPeer(hostSide);
    links[id] = link;
    guests[id] = g;
    g.hello();
    return g;
  }
  function drop(id) { const link = links[id]; link.open = false; host.peerClosed(id, 'timeout'); guests[id].peerClosed('host', 'timeout'); }
  return { host, guests, links, join, drop, advance: (ms) => { t += ms; }, now: clock };
}
const names = (core) => core.state().players.map((p) => p.name);

/* ------------------------------------------------------------------ pure helpers */
test('net-lobby: loads in Node and exposes the API', () => {
  assert.equal(typeof L.createCore, 'function');
  assert.equal(typeof L.open, 'function');
  assert.equal(globalThis.CB.net.lobby, L);
  assert.equal(L._.MAX_PLAYERS, 8);
});

test('net-lobby: deep-link parsing, codes and share links', () => {
  assert.deepEqual(L._.parseHash('#/multiplayer'), { code: '' });
  assert.deepEqual(L._.parseHash('#/multiplayer/abcde'), { code: 'ABCDE' });
  assert.deepEqual(L._.parseHash('#/multiplayer/AB-CD3?x=1'), { code: 'ABCD3' });
  assert.equal(L._.parseHash('#/race'), null);
  assert.equal(L._.normCode(' ab cde '), 'ABCDE');
  assert.equal(L._.shareLink('abcde', { origin: 'https://forge.example', pathname: '/index.html', protocol: 'https:' }), 'https://forge.example/index.html#/multiplayer/ABCDE');
});

test('net-lobby: chat text is emoji-safe, stripped of control / bidi chars and escaped on render', () => {
  const C = L._.cleanText;
  assert.equal(C('  hi\u0000 there‮  ', 280), 'hi there');
  assert.equal(C('🏁🏎️👨‍👩‍👧', 280), '🏁🏎️👨‍👩‍👧');
  const capped = C('😀'.repeat(300), 280);
  assert.equal(Array.from(capped).length, 280);
  assert.ok(!/[\uD800-\uDBFF]$/.test(capped), 'no dangling surrogate');
  assert.equal(C('a\uD800b', 10), 'a�b');
  assert.equal(L._.esc('<img src=x onerror=alert(1)>&"\''), '&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;');
  assert.equal(L._.cleanName(''), 'Driver');
  assert.equal(Array.from(L._.cleanName('x'.repeat(50))).length, 24);
});

test('net-lobby: remote builds are sanitised (markup chars, prototype keys, size cap)', () => {
  const b = L._.sanitizeBuild({ exterior: { paint: '#fff"><script>' }, meta: { name: '<b>evil</b>' }, ['__proto__']: { x: 1 }, n: Infinity, list: [1, 'a<'] });
  assert.equal(b.exterior.paint, '#fffscript');
  assert.equal(b.meta.name, 'bevil/b');
  assert.equal(b.n, null, 'non-finite numbers do not survive JSON');
  assert.deepEqual(b.list, [1, 'a']);
  assert.equal(Object.getPrototypeOf(b), Object.prototype);
  assert.equal(b.x, undefined);
  assert.equal(L._.sanitizeBuild({ big: 'x'.repeat(90).repeat(1) , arr: new Array(64).fill({ a: 'y'.repeat(90), b: 'z'.repeat(90), c: 'w'.repeat(90), d: 'v'.repeat(90), e: 'u'.repeat(90), f: 't'.repeat(90), g: 's'.repeat(90), h: 'r'.repeat(90), i: 'q'.repeat(90), j: 'p'.repeat(90), k: 'o'.repeat(90) }) }), null, 'over the size cap');
  assert.equal(L._.sanitizeBuild('nope'), null);
});

test('net-lobby: settings normalisation clamps and falls back', () => {
  const s = L._.normalizeSettings({ mode: 'drift', laps: 99, ai: -3, weather: 'snow', timeOfDay: 'night', assists: { abs: false }, maxSteerAssist: 'bogus' });
  assert.equal(s.mode, 'drift');
  assert.equal(s.laps, 20);
  assert.equal(s.ai, 0);
  assert.equal(s.weather, 'dry');
  assert.equal(s.timeOfDay, 'night');
  assert.equal(s.assists.abs, false);
  assert.equal(s.assists.tc, true);
  assert.equal(s.maxSteerAssist, 'auto');
  assert.equal(L._.normalizeSettings({ ai: 12 }).ai, 7);
});

/* ------------------------------------------------------------------ state machine */
test('net-lobby: roster updates as guests join, change car and leave', () => {
  const n = fakeNet();
  assert.deepEqual(names(n.host), ['Hana']);
  const a = n.join('pa', { name: 'Aki' });
  assert.deepEqual(names(n.host), ['Hana', 'Aki']);
  assert.deepEqual(names(a), ['Hana', 'Aki'], 'guest mirrors the roster');
  assert.equal(a.state().connected, true);
  assert.equal(a.state().code, 'ABCDE');
  const b = n.join('pb', { name: 'Bo' });
  assert.deepEqual(names(a), ['Hana', 'Aki', 'Bo']);
  assert.equal(a.state().players[0].host, true);
  n.host.refreshPings();
  assert.equal(a.state().players[1].ping, 42, 'host-measured ping travels in the roster after refreshPings');
  // car change: re-sent hello updates the entry in place
  b.setProfile('Bo-2', { exterior: { paint: '#0000ff' } });
  assert.deepEqual(names(a), ['Hana', 'Aki', 'Bo-2']);
  assert.equal(a.state().players[2].build.exterior.paint, '#0000ff');
  // leave
  b.leave();
  assert.deepEqual(names(n.host), ['Hana', 'Aki']);
  assert.deepEqual(names(a), ['Hana', 'Aki']);
  assert.equal(b.state().phase, 'closed');
  assert.ok(n.host.state().chat.some((m) => m.sys && /Bo-2 left/.test(m.text)));
});

test('net-lobby: pings refresh into the roster', () => {
  const n = fakeNet();
  const opts = { rtt: 0 };
  const a = n.join('pa', opts);
  n.host.refreshPings();
  assert.equal(a.state().players[1].ping, 0);
  opts.rtt = 120;
  n.host.refreshPings();
  assert.equal(a.state().players.find((p) => p.id === 'pa').ping, 120);
  opts.rtt = 121;
  let changes = 0; a.on('change', () => changes++);
  n.host.refreshPings();
  assert.equal(changes, 0, 'sub-3 ms jitter is not re-broadcast');
});

test('net-lobby: disabled Start shows the reason as tooltip + inline hint', () => {
  const n = fakeNet();
  const A = L._.app, prev = A.core;
  try {
    A.core = n.host;
    let html = L._.goHtml();
    assert.ok(!/data-act="start"[^>]*disabled/.test(html), 'enabled with AI fill');
    assert.ok(!/nl-gate is-blocked/.test(html));
    const a = n.join('pa', { name: 'GuestA' });
    const b = n.join('pb', { name: 'GuestB' });
    a.setReady(true);
    html = L._.goHtml();
    assert.match(n.host.canStart().reason, /^Waiting for GuestB to ready up$/);
    assert.match(html, /<button[^>]*data-act="start"[^>]*disabled[^>]*title="Waiting for GuestB to ready up"/, 'tooltip on the disabled button');
    assert.match(html, /class="nl-start-wrap" title="Waiting for GuestB to ready up"/, 'tooltip on the hover wrapper');
    assert.match(html, /aria-describedby="nl-start-gate"/);
    assert.match(html, /<p class="nl-gate is-blocked" id="nl-start-gate" role="status">.*Waiting for GuestB to ready up<\/p>/, 'inline hint');
    a.setReady(false);
    assert.equal(n.host.canStart().reason, 'Waiting for 2 players to ready up: GuestA, GuestB');
    b.setReady(true); a.setReady(true);
    html = L._.goHtml();
    assert.ok(!/nl-start-wrap/.test(html) && /Everyone is ready/.test(html), 'tooltip removed once startable');
  } finally { A.core = prev; }
});

test('net-lobby: ready / start gating', () => {
  const n = fakeNet();
  let g = n.host.canStart();
  assert.equal(g.ok, true); assert.equal(g.solo, undefined, 'AI fill 3 -> not "solo"');
  n.host.updateSettings({ ai: 0 });
  assert.equal(n.host.canStart().solo, true, 'alone, no AI: allowed but flagged solo');
  const a = n.join('pa', { name: 'Aki' });
  const b = n.join('pb', { name: 'Bo' });
  g = n.host.canStart();
  assert.equal(g.ok, false);
  assert.match(g.reason, /2 players/);
  a.setReady(true);
  assert.equal(n.host.player('pa').ready, true);
  g = n.host.canStart();
  assert.equal(g.ok, false);
  assert.match(g.reason, /Bo/);
  assert.deepEqual(g.waiting, ['pb']);
  assert.equal(n.host.startCountdown().ok, false, 'start refused while someone is not ready');
  assert.equal(n.host.state().phase, 'lobby');
  b.setReady(true);
  assert.equal(n.host.canStart().ok, true);
  assert.equal(a.canStart().ok, false, 'guests cannot start');
  assert.equal(a.setReady(true), true);
  assert.equal(n.host.setReady(true), false, 'host has no ready toggle');
});

test('net-lobby: host settings propagate; guests cannot change them; locked outside the lobby', () => {
  const n = fakeNet();
  const a = n.join('pa');
  assert.deepEqual(a.state().settings, n.host.state().settings, 'new guest receives the current settings');
  assert.equal(n.host.updateSettings({ laps: 7, weather: 'wet', timeOfDay: 'dusk', ai: 5, assists: { tc: false } }), true);
  const s = a.state().settings;
  assert.equal(s.laps, 7); assert.equal(s.weather, 'wet'); assert.equal(s.timeOfDay, 'dusk'); assert.equal(s.ai, 5);
  assert.equal(s.assists.tc, false); assert.equal(s.assists.abs, true, 'partial assists merge');
  assert.equal(n.host.updateSettings({ laps: 7 }), false, 'no-op change is not re-broadcast');
  n.host.updateSettings({ mode: 'free' });
  assert.equal(a.state().settings.mode, 'free');
  assert.equal(a.updateSettings({ laps: 2 }), false, 'guest cannot edit');
  assert.equal(n.host.state().settings.laps, 7);
  // a forged settings message from a guest is ignored by the host
  n.host.receive('pa', { t: 'settings', settings: { laps: 1 } });
  assert.equal(n.host.state().settings.laps, 7);
  a.setReady(true);
  n.host.startCountdown();
  assert.equal(n.host.updateSettings({ laps: 2 }), false, 'locked during the countdown');
});

test('net-lobby: chat relays sanitised text with sender names and rate limit', () => {
  const n = fakeNet();
  const a = n.join('pa', { name: 'Aki' });
  const b = n.join('pb', { name: 'Bo' });
  a.chat('  hello <b>world</b> 🏁  ');
  const last = (c) => c.state().chat.filter((m) => !m.sys).slice(-1)[0];
  assert.equal(last(b).text, 'hello <b>world</b> 🏁', 'raw text kept (escaped at render), trimmed');
  assert.equal(last(b).name, 'Aki');
  assert.equal(last(n.host).id, 'pa');
  n.host.chat('from host');
  assert.equal(last(a).name, 'Hana');
  assert.equal(a.chat('   '), false);
  for (let i = 0; i < 10; i++) a.chat('spam ' + i);
  assert.equal(b.state().chat.filter((m) => /^spam/.test(m.text)).length, 5, '6 messages / 8 s per player (1 already used)');
  n.advance(9000);
  a.chat('later');
  assert.equal(last(b).text, 'later');
  // a forged sender name is ignored: the host stamps the roster name
  n.host.receive('pb', { t: 'chat', text: 'hi', name: 'Hana' });
  assert.equal(last(a).name, 'Bo');
});

test('net-lobby: kick removes the player, tells them, and blocks a rejoin with the same id', () => {
  const n = fakeNet();
  const a = n.join('pa', { name: 'Aki' });
  const b = n.join('pb', { name: 'Bo' });
  let closed = null;
  b.on('closed', (c) => { closed = c; });
  assert.equal(a.kick('pb'), false, 'guests cannot kick');
  assert.equal(n.host.kick('host'), false, 'host cannot kick itself');
  assert.equal(n.host.kick('pb'), true);
  assert.deepEqual(names(n.host), ['Hana', 'Aki']);
  assert.deepEqual(names(a), ['Hana', 'Aki']);
  assert.equal(b.state().phase, 'closed');
  assert.equal(closed.reason, 'kicked');
  assert.match(closed.message, /removed/);
  assert.ok(a.state().chat.some((m) => m.sys && /Bo was removed/.test(m.text)));
  // same persistent id comes back on a new connection -> rejected
  const b2 = n.join('pb2', { name: 'Bo', pid: 'pid-pb' });
  assert.equal(b2.state().phase, 'closed');
  assert.equal(b2.state().closed.reason, 'kicked');
  assert.deepEqual(names(n.host), ['Hana', 'Aki']);
});

test('net-lobby: kick survives a transport that re-enters peerClosed synchronously from close()', () => {
  const host = createCore({ role: 'host', selfId: 'host', name: 'Hana' });
  let g;
  const peer = { id: 'pa', send: (m) => g && g.receive('host', JSON.parse(JSON.stringify(m))), close() { host.peerClosed('pa', 'kicked'); } };
  g = createCore({ role: 'guest', selfId: 'pa', name: 'Aki', send: (m) => host.receive('pa', JSON.parse(JSON.stringify(m))) });
  host.addPeer(peer); g.hello();
  assert.deepEqual(names(host), ['Hana', 'Aki']);
  host.kick('pa');
  assert.deepEqual(names(host), ['Hana'], 'host stays in its own roster');
  assert.equal(host.state().chat.filter((m) => /left/.test(m.text)).length, 0, 'no duplicate "left" message');
});

test('net-lobby: version mismatch and full rooms are rejected with friendly messages', () => {
  const n = fakeNet();
  const v = n.join('pv', { version: 'forge-net/0' });
  assert.equal(v.state().phase, 'closed');
  assert.equal(v.state().closed.reason, 'version');
  assert.match(v.state().closed.message, /version/);
  assert.deepEqual(names(n.host), ['Hana']);
  for (let i = 0; i < 7; i++) n.join('p' + i, { name: 'G' + i });
  assert.equal(n.host.state().players.length, 8);
  const x = n.join('px', { name: 'Late' });
  assert.equal(x.state().closed.reason, 'full');
  assert.equal(n.host.state().players.length, 8);
});

test('net-lobby: countdown -> launch -> results -> lobby rematch', () => {
  const n = fakeNet();
  const a = n.join('pa', { name: 'Aki' });
  const launches = [];
  n.host.on('launch', (l) => launches.push(['host', l]));
  a.on('launch', (l) => launches.push(['pa', l]));
  n.host.updateSettings({ ai: 7, laps: 4, trackId: 'forge-ring' });
  a.setReady(true);
  assert.equal(n.host.startCountdown().ok, true);
  assert.equal(n.host.state().phase, 'countdown');
  assert.equal(a.state().phase, 'countdown');
  assert.equal(a.state().start.t0, n.host.state().start.t0, 'start{t0} in host clock');
  assert.equal(a.state().start.seed, n.host.state().start.seed);
  const cfg = a.state().start.cfg;
  assert.equal(cfg.laps, 4);
  assert.equal(cfg.ai, 6, 'AI fill capped so the grid stays at 8 cars');
  assert.deepEqual(cfg.players.map((p) => p.id), ['host', 'pa']);
  assert.equal(cfg.hostId, 'host');
  assert.ok(n.host.countdownLeft() > 2900);
  n.advance(1500);
  assert.equal(n.host.tick(), false);
  assert.equal(a.tick(), false);
  n.advance(1600);
  assert.equal(a.tick(), true, 'guest launches on its own clock');
  assert.equal(n.host.tick(), true);
  assert.equal(a.tick(), false, 'launch fires once');
  assert.equal(n.host.tick(), false, 'launch fires once');
  assert.equal(launches.length, 2);
  assert.equal(launches.find((l) => l[0] === 'pa')[1].selfId, 'pa');
  assert.equal(n.host.state().phase, 'racing');
  assert.equal(a.state().phase, 'racing');
  // a late joiner during the race is flagged and not in the grid
  const late = n.join('pl', { name: 'Late' });
  assert.equal(n.host.player('pl').late, true);
  assert.equal(late.state().phase, 'racing');
  late.setReady(true);
  assert.equal(n.host.player('pl').ready, false, 'ready ignored while racing');
  // guest finishes first: waits for the host
  a.raceEnded([{ id: 'pa', name: 'Aki', pos: 1, time: 95.2 }]);
  assert.equal(a.state().phase, 'waiting');
  const results = [{ id: 'pa', name: 'Aki', pos: 1, totalTime: 95.2 }, { id: 'host', name: 'Hana', pos: 2, totalTime: 96.75 }];
  n.host.raceEnded(results);
  assert.equal(n.host.state().phase, 'lobby');
  assert.equal(a.state().phase, 'lobby');
  assert.deepEqual(a.state().results, results);
  assert.equal(n.host.player('pa').ready, false, 'ready flags reset for the rematch');
  assert.equal(n.host.player('pl').late, false);
  assert.equal(n.host.canStart().ok, false);
  const rows = L._.resultRows(a.state().results);
  assert.deepEqual(rows.map((r) => [r.pos, r.name, r.value]), [[1, 'Aki', '1:35.200'], [2, 'Hana', '1:36.750']]);
  assert.equal(L._.resultRows({ standings: [{ name: 'X', score: 12345.4 }] })[0].value, '12,345 pts');
});

test('net-lobby: a guest whose clock lags launches when the host roster says racing', () => {
  const n = fakeNet();
  const a = n.join('pa');
  let launched = 0; a.on('launch', () => launched++);
  a.setReady(true);
  n.host.startCountdown();
  n.advance(3100);
  n.host.tick();
  assert.equal(launched, 1);
  assert.equal(a.state().phase, 'racing');
  assert.equal(a.tick(), false);
  assert.equal(launched, 1);
});

test('net-lobby: netrace traffic (start / results) does not disturb the lobby phase', () => {
  const n = fakeNet();
  const a = n.join('pa');
  a.setReady(true);
  n.host.startCountdown();
  assert.equal(a.state().netStart, null, 'countdown clears a stale netrace start');
  const ns = { t: 'start', v: 'forge-net-race/1', seed: 9, t0: 5000, grid: [], you: 'pa' };
  a.receive('host', ns);
  assert.equal(a.state().phase, 'countdown');
  assert.deepEqual(a.state().netStart, ns, 'kept for createClientSession({start})');
  a.receive('host', { t: 'results', classification: [{ id: 'pa', name: 'Aki', pos: 1, totalTime: 61 }], complete: true });
  assert.equal(a.state().results.classification.length, 1);
  assert.equal(L._.resultRows(a.state().results)[0].value, '1:01.000');
});

test('net-lobby: un-ready or host cancel aborts the countdown', () => {
  const n = fakeNet();
  const a = n.join('pa', { name: 'Aki' });
  a.setReady(true);
  n.host.startCountdown();
  a.setReady(false);
  assert.equal(n.host.state().phase, 'lobby');
  assert.equal(a.state().phase, 'lobby');
  assert.ok(a.state().chat.some((m) => m.sys && /cancelled/.test(m.text)));
  a.setReady(true);
  n.host.startCountdown();
  assert.equal(n.host.cancelCountdown(), true);
  assert.equal(a.state().phase, 'lobby');
  n.advance(5000);
  assert.equal(a.tick(), false, 'no launch after abort');
});

test('net-lobby: disconnects — host sees the player drop, guest sees a clear reason', () => {
  const n = fakeNet();
  const a = n.join('pa', { name: 'Aki' });
  const b = n.join('pb', { name: 'Bo' });
  n.drop('pb');
  assert.deepEqual(names(n.host), ['Hana', 'Aki']);
  assert.deepEqual(names(a), ['Hana', 'Aki']);
  assert.ok(a.state().chat.some((m) => /Bo lost connection/.test(m.text)));
  assert.equal(b.state().phase, 'closed');
  assert.equal(b.state().closed.reason, 'host-lost');
  // rejoin with the same persistent id after a drop is allowed (not banned)
  const b2 = n.join('pb2', { name: 'Bo', pid: 'pid-pb' });
  assert.equal(b2.state().phase, 'lobby');
  assert.deepEqual(names(n.host), ['Hana', 'Aki', 'Bo']);
  // link state: reconnecting shows on the card
  n.host.setLink('pa', 'reconnecting');
  assert.equal(b2.state().players.find((p) => p.id === 'pa').link, 'reconnecting');
  n.host.setLink('pa', 'open');
  assert.equal(b2.state().players.find((p) => p.id === 'pa').link, 'open');
  // the host leaves: everyone gets host-left
  n.host.leave();
  assert.equal(a.state().phase, 'closed');
  assert.equal(a.state().closed.reason, 'host-left');
});

test('net-lobby: guest ignores malformed / foreign traffic', () => {
  const n = fakeNet();
  const a = n.join('pa');
  const before = JSON.stringify(a.state().players);
  a.receive('host', 'not json');
  a.receive('host', { nope: 1 });
  a.receive('host', { t: 'lap', id: 'x', lap: 2 });
  a.receive('host', { t: 'roster', players: 'bad' });
  assert.deepEqual(a.state().players, []);
  a.receive('host', JSON.parse(JSON.stringify({ t: 'roster', phase: 'lobby', players: JSON.parse(before) })));
  assert.equal(JSON.stringify(a.state().players.map((p) => p.name)), JSON.stringify(JSON.parse(before).map((p) => p.name)));
  n.host.receive('ghost', { t: 'hello', name: 'nobody', version: L.PROTOCOL });
  assert.equal(n.host.state().players.length, 2, 'messages from unknown peers are dropped');
});

/* ------------------------------------------------------------------ over the real loopback transport */
test('net-lobby: works over CB.net.transport.loopback()', async () => {
  let T;
  try { T = require(path.join(__dirname, '..', 'js', 'net', 'transport.js')); } catch (e) { T = null; }
  T = (globalThis.CB.net && globalThis.CB.net.transport) || T;
  if (!T || typeof T.loopback !== 'function') return;   // transport not shipped yet
  const net = T.loopback({ latency: 20 });
  const h = net.host();
  const wrap = L._.wrapPeer;
  const host = createCore({ role: 'host', selfId: h.id || 'host', name: 'Hana', clock: () => h.now(), version: T.PROTO || L.PROTOCOL, countdownMs: 1000 });
  h.on('peer', (raw) => {
    const id = String(raw.id);
    host.addPeer(wrap(raw, (m) => host.receive(id, m), (why) => host.peerClosed(id, why)));
  });
  const c = net.connect({ id: 'pa', skew: 5000 });
  let g = null;
  const w = wrap(c, (m) => g.receive('host', m), (why) => g.peerClosed('host', why), (st) => g.setLink('host', st));
  g = createCore({ role: 'guest', selfId: c.selfId || 'pa', name: 'Aki', version: T.PROTO || L.PROTOCOL, send: (m) => w.send(m), clock: () => c.now(), hostToLocal: (t) => t - (Number(c.clockOffset) || 0) });
  net.advance(300);
  g.hello();
  net.advance(300);
  assert.deepEqual(names(host), ['Hana', 'Aki']);
  assert.deepEqual(names(g), ['Hana', 'Aki']);
  g.setReady(true);
  net.advance(200);
  assert.equal(host.canStart().ok, true);
  host.startCountdown();
  net.advance(200);
  assert.equal(g.state().phase, 'countdown');
  net.run(3000);  // pings settle the clock offset
  host.tick(); g.tick();
  assert.equal(host.state().phase, 'racing');
  assert.equal(g.state().phase, 'racing');
  host.kick(c.selfId || 'pa');
  net.advance(300);
  assert.equal(g.state().phase, 'closed');
  assert.equal(g.state().closed.reason, 'kicked');
});

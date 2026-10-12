/* GoDaddy / cPanel package: tools/build-zip.js (real .zip, right contents, cache-busted HTML), .htaccess sanity,
   and api/signal.php end to end — the zip is extracted into <tmp>/public_html/redline/ and served by `php -S`
   (skipped when php is not installed). The client (js/net/signal.js) auto-detects api/signal.php through it.
   Run: node tests/run.js cpanel */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var net = require('net');
var cp = require('child_process');
var root = path.join(__dirname, '..');
var Z = require(path.join(root, 'tools', 'build-zip.js'));
var S = require(path.join(root, 'js', 'net', 'signal.js'));
var RL = require(path.join(root, 'js', 'net', 'relay.js'));

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cpanel-'));
var zipPath = path.join(tmp, 'redline-cpanel.zip');
var built = null, entries = null;
var php = null, phpOk = false, base = null, dataDir = path.join(tmp, 'signal-data');
try { phpOk = cp.spawnSync('php', ['-v'], { encoding: 'utf8' }).status === 0; } catch (e) { phpOk = false; }

function cleanup() {
  // php -S with PHP_CLI_SERVER_WORKERS forks workers: kill the whole process group, not just the parent
  if (php) { try { process.kill(-php.pid, 'SIGKILL'); } catch (e) { try { php.kill('SIGKILL'); } catch (e2) { /* ignore */ } } php = null; }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
process.on('exit', cleanup);

function byName(n) { return entries.filter(function (e) { return e.name === n; })[0]; }

test('cpanel zip: builds a valid archive with everything inside redline/', function () {
  built = Z.build({ out: zipPath, date: new Date(2026, 0, 2, 3, 4, 6) });
  assert.ok(fs.existsSync(zipPath));
  entries = Z.readZip(fs.readFileSync(zipPath)); // CRC + size checked for every file
  assert.ok(entries.length > 90, entries.length + ' entries');
  entries.forEach(function (e) { assert.ok(e.name.indexOf('redline/') === 0, e.name); assert.ok(!/\\|\.\.|^\//.test(e.name), e.name); });
  ['redline/index.html', 'redline/.htaccess', 'redline/api/signal.php', 'redline/DEPLOY-CPANEL.txt', 'redline/css/styles.css', 'redline/js/net/signal.js',
    'redline/hub.html', 'redline/race.html', 'redline/race3d.html', 'redline/drift.html'].forEach(function (n) { assert.ok(byName(n), 'has ' + n); });
  var unzip = cp.spawnSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
  if (!unzip.error) { assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr); assert.match(unzip.stdout, /No errors detected/); }
});

test('cpanel zip: leaves out tests, tools, specs, Node-only and scratch files', function () {
  entries.forEach(function (e) {
    assert.ok(!/^redline\/(tests|tools|dist|node_modules|_audit_tmp|\.claude)\//.test(e.name), e.name);
    assert.ok(!/\.(md|log)$|\.DS_Store$|^redline\/api\/signal\.js$|^redline\/vercel\.json$|^redline\/\.vercelignore$|^redline\/_?aud\d*-preview\.html$/.test(e.name), e.name);
    assert.ok(!/^redline\/api\/_data/.test(e.name), e.name);
  });
});

test('cpanel zip: every local script/stylesheet is stamped ?v=<hash> and exists in the package', function () {
  Z.PAGES.forEach(function (p) {
    var e = byName('redline/' + p);
    if (!e) return;
    var html = e.data.toString('utf8'), n = 0, re = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*"([^"]+)"/gi, m;
    while ((m = re.exec(html))) {
      var u = m[1];
      if (/^data:|^https?:|^#/.test(u)) continue;
      if (!/\.(js|css)(\?|$)/.test(u)) continue;
      n++;
      assert.match(u, /\?v=[0-9a-f]{10}$/, p + ': ' + u);
      assert.ok(byName('redline/' + u.split('?')[0]), p + ' references missing ' + u);
    }
    if (p === 'index.html') assert.ok(n > 60, 'index.html stamped ' + n);
    assert.match(html, /<link\b[^>]*rel="icon"/, p + ' has an icon (no /favicon.ico request at the domain root)');
  });
  // the stamp follows the content
  var a = Z.stampHtml('<script src="js/a.js"></script><link rel="stylesheet" href="https://x/y.css"><script src="js/b.js?v=1"></script>', function () { return 'abc'; });
  assert.equal(a, '<script src="js/a.js?v=abc"></script><link rel="stylesheet" href="https://x/y.css"><script src="js/b.js?v=1"></script>');
});

test('cpanel .htaccess: guarded modules, loop-safe HTTPS, sensors allowed, no listing', function () {
  var h = byName('redline/.htaccess').data.toString('utf8');
  var lines = h.split('\n').map(function (l) { return l.replace(/#.*$/, '').trim(); }).filter(Boolean);
  // balanced containers
  var stack = [];
  lines.forEach(function (l) {
    var open = /^<(IfModule|FilesMatch|Files|IfVersion|If)\b/.exec(l), close = /^<\/(IfModule|FilesMatch|Files|IfVersion|If)>/.exec(l);
    if (open) stack.push(open[1]); else if (close) assert.equal(stack.pop(), close[1], 'mismatched </' + close[1] + '>');
  });
  assert.deepEqual(stack, []);
  // module-specific directives only inside <IfModule>
  var depth = 0;
  lines.forEach(function (l) {
    if (/^<IfModule/.test(l)) depth++; else if (/^<\/IfModule>/.test(l)) depth--;
    else if (/^(Rewrite|Header|Expires|AddOutputFilterByType|AddType|AddCharset|Require|Order|Deny)\b/.test(l)) assert.ok(depth > 0, 'unguarded: ' + l);
  });
  assert.ok(!/RewriteBase\s+\//.test(h), 'no absolute RewriteBase (sub-folder safe)');
  assert.match(h, /DirectoryIndex index\.html/);
  assert.match(h, /Options -Indexes/);
  assert.match(h, /RewriteCond %\{HTTPS\} !=on/);
  assert.match(h, /X-Forwarded-Proto\} !https/);
  assert.match(h, /RewriteRule \^ https:\/\/%\{HTTP_HOST\}%\{REQUEST_URI\}/);
  assert.match(h, /Permissions-Policy "[^"]*accelerometer=\(self\)[^"]*gyroscope=\(self\)/);
  assert.match(h, /AddType text\/javascript\s+\.js/);
  assert.match(h, /DEFLATE/);
  assert.ok(!/php_value|php_flag/.test(h), 'php_value breaks PHP-FPM hosts');
});

/* ------------------------------------------------------------------ PHP end to end (extracted zip) */
function freePort() {
  return new Promise(function (resolve, reject) {
    var s = net.createServer(); s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function () { var p = s.address().port; s.close(function () { resolve(p); }); });
  });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function api(body, o) {
  o = o || {};
  var r = await fetch(base + 'api/signal.php', { method: o.method || 'POST', headers: Object.assign({ 'content-type': 'application/json' }, o.headers || {}), body: o.method === 'GET' ? undefined : (o.raw != null ? o.raw : JSON.stringify(body)) });
  var text = await r.text(), j = null;
  try { j = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.status, body: j, text: text, headers: r.headers };
}
var phpTest = phpOk ? test : test.skip;

phpTest('cpanel php: extract the zip into public_html and serve it with php -S', async function () {
  var pub = path.join(tmp, 'public_html');
  entries.forEach(function (e) {
    var dest = path.join(pub, e.name);
    if (e.data == null) fs.mkdirSync(dest, { recursive: true });
    else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, e.data); }
  });
  var port = await freePort();
  php = cp.spawn('php', ['-S', '127.0.0.1:' + port, '-t', pub], {
    env: Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '6', FORGE_SIGNAL_DATA: dataDir }), stdio: 'ignore', detached: true
  });
  php.unref();
  base = 'http://127.0.0.1:' + port + '/redline/';
  var ok = false;
  for (var i = 0; i < 60 && !ok; i++) { try { ok = (await fetch(base + 'index.html')).status === 200; } catch (e) { await sleep(100); } }
  assert.ok(ok, 'php -S came up');
  var page = await fetch(base + 'index.html');
  assert.match(await page.text(), /js\/net\/signal\.js\?v=/);
  assert.equal((await fetch(base + 'css/styles.css')).status, 200);
});

phpTest('cpanel php: status (GET and POST) says backend php', async function () {
  var g = await api(null, { method: 'GET' });
  assert.equal(g.status, 200);
  assert.equal(g.body.ok, true); assert.equal(g.body.backend, 'php'); assert.equal(g.body.version, 'forge-signal/1');
  assert.equal(g.body.limits.maxPlayers, 8); assert.ok(g.body.limits.pollMaxWait <= 8000);
  assert.match(g.headers.get('content-type'), /application\/json/);
  assert.equal(g.headers.get('cache-control'), 'no-store');
  assert.equal(g.headers.get('access-control-allow-origin'), null);
  var p = await api({ action: 'status' });
  assert.equal(p.body.backend, 'php');
  assert.ok(fs.existsSync(path.join(dataDir, '.htaccess')) && fs.existsSync(path.join(dataDir, 'index.html')), 'data dir protected');
});

phpTest('cpanel php: create / join / post / poll / close, same protocol as api/signal.js', async function () {
  var h = (await api({ action: 'create' })).body;
  assert.equal(h.ok, true); assert.match(h.room, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/); assert.equal(h.peer, 'host'); assert.equal(h.ttl, 7200);
  var g = (await api({ action: 'join', room: h.room.toLowerCase().slice(0, 2) + '-' + h.room.toLowerCase().slice(2) })).body;
  assert.equal(g.ok, true); assert.match(g.peer, /^p[a-z0-9]{6}$/); assert.equal(g.host, 'host');
  var msgs = [{ t: 'join', sid: 'a', o: {} }, { t: 'ice', c: { candidate: 'candidate:1 1 udp 2 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 } }, [], null, 1.5, 'é✓'];
  var p = await api({ action: 'post', room: h.room, token: g.token, to: 'host', msgs: msgs });
  assert.deepEqual(p.body, { ok: true, n: 6 });
  var r = (await api({ action: 'poll', room: h.room, token: h.token, wait: 0 })).body;
  assert.equal(r.ok, true);
  assert.deepEqual(r.msgs.map(function (m) { return m.msg; }), msgs, 'messages round-trip exactly ({} stays {}, [] stays [])');
  assert.ok(r.msgs.every(function (m) { return m.from === g.peer && typeof m.ts === 'number'; }));
  // drained
  var t0 = Date.now(); r = (await api({ action: 'poll', room: h.room, token: h.token, wait: 700 })).body;
  assert.deepEqual(r.msgs, []); assert.ok(Date.now() - t0 >= 500, 'poll waited');
  // a long poll wakes up on a post
  var pending = api({ action: 'poll', room: h.room, token: g.token, wait: 4000, busy: true });
  await sleep(250);
  await api({ action: 'post', room: h.room, token: h.token, to: g.peer, msg: { t: 'sdp', type: 'offer' } });
  t0 = Date.now(); r = (await pending).body;
  assert.deepEqual(r.msgs.map(function (m) { return m.msg.t; }), ['sdp']); assert.equal(r.msgs[0].from, 'host');
  // errors
  assert.equal((await api({ action: 'post', room: h.room, token: g.token, to: 'pzzzzzz', msg: 1 })).body.code, 'forbidden');
  assert.equal((await api({ action: 'post', room: h.room, token: h.token, to: 'pzzzzzz', msg: 1 })).body.code, 'not-found');
  assert.equal((await api({ action: 'post', room: h.room, token: h.token, to: 'host', msg: 1 })).status, 400);
  assert.equal((await api({ action: 'post', room: h.room, token: 'nope', to: 'host', msg: 1 })).status, 403);
  assert.equal((await api({ action: 'poll', room: 'ZZZZZ', token: 'x' })).status, 410);
  assert.equal((await api({ action: 'join', room: 'ZZZZZ' })).status, 404);
  assert.equal((await api({ action: 'join', room: 'abc' })).body.code, 'bad-request');
  assert.equal((await api({ action: 'post', room: h.room, token: h.token, to: g.peer, msgs: new Array(33).fill(1) })).body.code, 'too-large');
  // peer leaves -> host gets _leave; host closes -> peers get _closed and the room is gone
  var g2 = (await api({ action: 'join', room: h.room })).body;
  assert.deepEqual((await api({ action: 'close', room: h.room, token: g.token })).body, { ok: true });
  r = (await api({ action: 'poll', room: h.room, token: h.token, wait: 0 })).body;
  assert.deepEqual(r.msgs.map(function (m) { return [m.from, m.msg.t]; }), [[g.peer, '_leave']]);
  assert.deepEqual((await api({ action: 'close', room: h.room, token: h.token })).body, { ok: true });
  assert.equal((await api({ action: 'poll', room: h.room, token: g2.token })).body.code, 'room-closed');
  assert.equal((await api({ action: 'close', room: h.room, token: h.token })).body.already, true);
});

phpTest('cpanel php: limits — 64 KB cap, bad JSON, cross-origin, room full, files never served', async function () {
  assert.equal((await api(null, { raw: '{"action":"post","x":"' + 'a'.repeat(70000) + '"}' })).status, 413);
  assert.equal((await api(null, { raw: '{nope' })).body.code, 'bad-request');
  assert.equal((await api(null, { raw: '[1,2]' })).body.code, 'bad-request');
  assert.equal((await api({ action: 'explode' })).body.code, 'bad-action');
  var x = await api({ action: 'status' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(x.status, 403); assert.equal(x.body.code, 'forbidden');
  assert.equal((await api({ action: 'status' }, { headers: { origin: 'null' } })).status, 403);
  assert.equal((await api({ action: 'status' }, { headers: { origin: base.replace(/\/redline\/$/, '') } })).body.ok, true);
  var h = (await api({ action: 'create' })).body;
  for (var i = 0; i < 7; i++) assert.equal((await api({ action: 'join', room: h.room })).body.ok, true, 'join ' + i);
  var full = await api({ action: 'join', room: h.room });
  assert.equal(full.status, 409); assert.equal(full.body.code, 'full');
  await api({ action: 'close', room: h.room, token: h.token });
  // storage files start with a PHP exit guard, so even a direct hit would print nothing
  var files = fs.readdirSync(dataDir).filter(function (f) { return /\.php$/.test(f); });
  assert.ok(files.length > 0);
  files.forEach(function (f) { assert.equal(fs.readFileSync(path.join(dataDir, f), 'utf8').indexOf('<?php exit; ?>'), 0, f); });
});

phpTest('cpanel php: js/net/signal.js auto-detects api/signal.php from a sub-folder page and relays both ways', async function () {
  var page = base + 'index.html#/multiplayer';
  var seen = [];
  var f = function (u, init) { var abs = new URL(u, page).href; seen.push(abs); return fetch(abs, init); };
  assert.equal(await S.endpoint({ fetch: f }), 'api/signal.php');
  assert.deepEqual(seen, [base + 'api/signal.php'], 'one relative probe, resolved against the sub-folder page (no 404 noise)');
  assert.equal(await S.detect({ fetch: f }), 'vercel');
  var host = S.vercel({ fetch: f, probe: true, wait: 600 }), guest = S.vercel({ fetch: f, probe: true, wait: 600 });
  var hr = await host.create();
  assert.equal(host.url(), 'api/signal.php');
  var got = [], back = [], closed = null;
  host.onMessage(function (from, m) { got.push([from, m]); });
  var gr = await guest.join(hr.room);
  guest.onMessage(function (from, m) { back.push([from, m]); });
  guest.on('closed', function (e) { closed = e.reason; });
  await Promise.all([guest.send('host', { t: 'join', sid: 's' }), guest.send('host', { t: 'ice', c: null })]);
  for (var i = 0; i < 100 && got.length < 2; i++) await sleep(50);
  assert.deepEqual(got.map(function (x) { return x[1].t; }), ['join', 'ice']);
  assert.equal(got[0][0], gr.peer);
  await host.send(gr.peer, { t: 'sdp', type: 'offer', sdp: 'v=0' });
  for (i = 0; i < 100 && !back.length; i++) await sleep(50);
  assert.deepEqual(back[0], ['host', { t: 'sdp', type: 'offer', sdp: 'v=0' }]);
  await host.close();
  for (i = 0; i < 120 && !closed; i++) await sleep(50);
  assert.ok(closed === 'host-closed' || closed === 'room-closed', 'guest saw the close: ' + closed);
  await guest.close();
});

phpTest('cpanel php: relay action = post + poll in one request (WebRTC fallback), own rate bucket', async function () {
  var st = await api({ action: 'status' });
  assert.equal(st.body.relay, true, 'status advertises the relay');
  var c = (await api({ action: 'create' })).body, g = (await api({ action: 'join', room: c.room })).body;
  var r = await api({ action: 'relay', room: c.room, token: g.token, posts: [{ to: 'host', msgs: [{ t: '_r', n: 1, r: ['{"t":"hello"}'], f: [{ b: '9QE=' }] }] }, { to: 'pzzzzzz', msgs: [{ t: 'x' }] }], wait: 0 });
  assert.equal(r.status, 200, r.text); assert.deepEqual(r.body.dropped, ['pzzzzzz']); assert.deepEqual(r.body.msgs, []);
  var t0 = Date.now();
  r = await api({ action: 'relay', room: c.room, token: c.token, posts: [{ to: g.peer, msgs: [{ t: 'back' }] }], wait: 2000 });
  assert.ok(Date.now() - t0 < 1000, 'mail waiting -> answers at once');
  assert.deepEqual(r.body.msgs.map(function (m) { return m.msg; }), [{ t: '_r', n: 1, r: ['{"t":"hello"}'], f: [{ b: '9QE=' }] }], 'frame round-trips exactly');
  assert.equal((await api({ action: 'relay', room: c.room, token: g.token, nopoll: true })).body.msgs.length, 0, 'nopoll leaves the mailbox');
  // long-poll: answers as soon as the other side posts (50 ms steps), not at the end of the wait
  t0 = Date.now();
  var held = api({ action: 'relay', room: c.room, token: c.token, wait: 4000 });
  await sleep(300);
  await api({ action: 'relay', room: c.room, token: g.token, posts: [{ to: 'host', msgs: [{ t: 'late' }] }], nopoll: true });
  r = await held;
  assert.deepEqual(r.body.msgs.map(function (m) { return m.msg.t; }), ['late']);
  assert.ok(Date.now() - t0 < 1500, 'woke early: ' + (Date.now() - t0) + ' ms');
  assert.deepEqual((await api({ action: 'relay', room: c.room, token: g.token })).body.msgs.map(function (m) { return m.msg.t; }), ['back']);
  assert.equal((await api({ action: 'relay', room: c.room, token: 'x' })).body.code, 'auth');
  assert.equal((await api({ action: 'relay', room: c.room, token: g.token, posts: 'nope' })).status, 400);
  // a phone at ~6 requests/s for a minute (>300 requests) never hits the signalling budget
  for (var i = 0; i < 320; i++) { var x = await api({ action: 'relay', room: c.room, token: g.token, nopoll: true }); if (x.status !== 200) throw new Error('relay #' + i + ' -> ' + x.status + ' ' + x.text); }
  assert.equal((await api({ action: 'poll', room: c.room, token: g.token, wait: 0 })).status, 200);
  await api({ action: 'close', room: c.room, token: c.token });
  // drained / closed mailboxes leave no files behind
  var left = fs.readdirSync(dataDir).filter(function (f) { return f.indexOf('mb-' + c.room + '-host') === 0 || f.indexOf('room-' + c.room) === 0; });
  assert.deepEqual(left, []);
});

phpTest('cpanel php: js/net/relay.js links over api/signal.php deliver rel in order + newest fast input', async function () {
  var page = base + 'index.html';
  var f = function (u, init) { return fetch(new URL(u, page).href, init); };
  var host = S.vercel({ fetch: f, probe: true, wait: 3000 }), guest = S.vercel({ fetch: f, probe: true, wait: 3000 });
  var hr = await host.create(); await guest.join(hr.room);
  var atHost = [], atGuest = [];
  var lh = RL.link(host, guest.peer, function (ch, x) { atHost.push([ch, x]); });
  var lg = RL.link(guest, 'host', function (ch, x) { atGuest.push([ch, x]); });
  for (var i = 0; i < 25; i++) { lg.send('rel', '{"t":"btn","i":' + i + '}'); lg.send('fast', '{"t":"in","q":' + i + '}'); }
  lh.send('rel', '{"t":"welcome"}');
  for (var k = 0; k < 120 && (atHost.filter(function (m) { return m[0] === 'rel'; }).length < 25 || !atGuest.length); k++) await sleep(50);
  assert.deepEqual(atHost.filter(function (m) { return m[0] === 'rel'; }).map(function (m) { return JSON.parse(m[1]).i; }), Array.from({ length: 25 }, function (_, n) { return n; }));
  var fast = atHost.filter(function (m) { return m[0] === 'fast'; });
  assert.equal(JSON.parse(fast[fast.length - 1][1]).q, 24, 'newest input wins');
  assert.deepEqual(atGuest[0], ['rel', '{"t":"welcome"}']);
  lh.close(); lg.close();
  await host.close(); await guest.close();
});

phpTest('cpanel php: create rate limit (12 / min / IP) answers 429 rate-limited', async function () {
  var codes = [];
  for (var i = 0; i < 16; i++) codes.push((await api({ action: 'create' })).status);
  assert.ok(codes.indexOf(429) >= 0, codes.join(','));
  var last = await api({ action: 'create' });
  assert.equal(last.body.code, 'rate-limited');
});

test('cpanel: endpoint detection falls back to api/signal when api/signal.php is not there', async function () {
  var seen = [];
  var f = async function (u) {
    seen.push(u);
    if (u === 'api/signal.php') return { status: 404, json: async function () { throw new Error('not json'); } };
    return { status: 200, json: async function () { return { ok: true, backend: 'upstash' }; } };
  };
  assert.equal(await S.endpoint({ fetch: f }), 'api/signal');
  assert.deepEqual(seen, ['api/signal.php', 'api/signal']);
  var none = async function () { return { status: 200, json: async function () { return { ok: false, code: 'no-backend' }; } }; };
  assert.equal(await S.endpoint({ fetch: none }), null);
  var vj = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.ok((vj.rewrites || []).some(function (r) { return r.source === '/api/signal.php' && r.destination === '/api/signal'; }), 'Vercel maps api/signal.php to the function');
  assert.equal(await S.detect({ fetch: none }), 'manual');
  var sig = S.vercel({ fetch: none, probe: true });
  await assert.rejects(sig.create(), function (e) { return e.code === 'no-backend'; });
});

test('cpanel: tools/dev-server.js answers api/signal.php with the Node handler and never serves PHP source', async function () {
  var DS = require(path.join(root, 'tools', 'dev-server.js'));
  var srv = DS.createServer();
  await new Promise(function (r) { srv.listen(0, '127.0.0.1', r); });
  try {
    var page = 'http://127.0.0.1:' + srv.address().port + '/index.html';
    var f = function (u, init) { return fetch(new URL(u, page).href, init); };
    assert.equal(await S.endpoint({ fetch: f }), 'api/signal.php');
    var src = await fetch(new URL('api/signal.php', page).href);
    var txt = await src.text();
    assert.ok(txt.indexOf('<?php') < 0); assert.equal(JSON.parse(txt).backend, 'memory');
    assert.equal((await fetch(new URL('api/other.php', page).href)).status, 404);
    var sig = S.vercel({ fetch: f, probe: true, wait: 200 });
    var r = await sig.create();
    assert.match(r.room, /^[A-Z2-9]{5}$/); assert.equal(sig.url(), 'api/signal.php');
    await sig.close();
  } finally { await new Promise(function (r) { srv.close(r); if (srv.closeAllConnections) srv.closeAllConnections(); }); }
});

test('cpanel: closing right after a send still delivers it with the old token (no token:null post)', async function () {
  var bodies = [];
  var f = async function (u, init) {
    var b = JSON.parse(init.body); bodies.push(b);
    var out = b.action === 'join' ? { ok: true, room: 'ABCDE', peer: 'pabcdef', host: 'host', token: 'tk', ttl: 7200 }
      : b.action === 'poll' ? (await sleep(30), { ok: true, msgs: [] }) : { ok: true, n: 1 };
    return { status: 200, json: async function () { return out; } };
  };
  var sig = S.vercel({ fetch: f, wait: 50 });
  await sig.join('ABCDE');
  var sent = sig.send('host', { t: 'bye' });
  await sig.close();
  await sent;
  var posts = bodies.filter(function (b) { return b.action === 'post'; });
  assert.equal(posts.length, 1); assert.equal(posts[0].token, 'tk'); assert.deepEqual(posts[0].msgs, [{ t: 'bye' }]);
  var closeIdx = bodies.map(function (b) { return b.action; }).lastIndexOf('close');
  assert.ok(closeIdx > bodies.indexOf(posts[0]), 'bye goes out before close');
  assert.ok(bodies.every(function (b) { return b.token !== null; }));
});

test('cpanel: cleanup', function () { cleanup(); assert.ok(!fs.existsSync(tmp)); });

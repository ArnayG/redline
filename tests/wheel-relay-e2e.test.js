/* Browser end-to-end test of the phone wheel on the cPanel package: the zip is extracted into <tmp>/public_html/redline/
   and served by `php -S`; a "desktop" headless Chrome pairs, an emulated phone (second Chrome) opens #/wheel/<CODE>.
     1. P2P blocked on both browsers (--force-webrtc-ip-handling-policy=disable_non_proxied_udp, no TURN): the pair must
        connect "via server" (js/net/relay.js) and the phone's steering + throttle must reach the desktop.
     2. Normal browsers: still "direct" (WebRTC).
     The relay run also reports the TRUE one-way input delay (phone input timestamp -> desktop apply time; both Chromes
     share the machine clock, so the two performance.timeOrigin values line up) next to the desktop's own estimate.
   Opt-in (spawns Chrome): REDLINE_E2E=1 node tests/run.js wheel-relay-e2e     Ports: Chrome 9724/9725, PHP 9726
   (REDLINE_E2E_PORT=<n> uses n, n+1, n+2; REDLINE_E2E_TMP=<dir> puts the profiles there).
   Chrome always runs --headless=new --mute-audio with a throw-away profile. */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var root = path.join(__dirname, '..');
var CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
var enabled = process.env.REDLINE_E2E === '1' && fs.existsSync(CHROME) && (function () { try { return cp.spawnSync('php', ['-v']).status === 0; } catch (e) { return false; } })();
var t = enabled ? test : test.skip;
var P0 = Number(process.env.REDLINE_E2E_PORT) || 9724, PD = P0, PP = P0 + 1, PHP_PORT = P0 + 2;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var tmp = null, php = null, procs = [];
function cleanup() {
  procs.forEach(function (p) { try { p.kill('SIGKILL'); } catch (e) { /* ignore */ } }); procs = [];
  if (php) { try { process.kill(-php.pid, 'SIGKILL'); } catch (e) { try { php.kill('SIGKILL'); } catch (e2) { /* ignore */ } } php = null; }
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } tmp = null; }
}
process.on('exit', cleanup);

async function chrome(port, extra) {
  var prof = path.join(tmp, 'chrome-' + port);
  fs.mkdirSync(prof, { recursive: true });
  var p = cp.spawn(CHROME, ['--headless=new', '--mute-audio', '--user-data-dir=' + prof, '--remote-debugging-port=' + port, '--no-first-run',
    '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1280,800'].concat(extra || [], ['about:blank']), { stdio: 'ignore' });
  procs.push(p);
  for (var i = 0; i < 100; i++) { try { await (await fetch('http://127.0.0.1:' + port + '/json/version')).json(); break; } catch (e) { await sleep(150); } }
  var tgt = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  var ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise(function (r, j) { ws.onopen = r; ws.onerror = j; });
  var id = 0, pend = {};
  ws.onmessage = function (ev) { var m = JSON.parse(ev.data); if (m.id && pend[m.id]) { var q = pend[m.id]; delete pend[m.id]; if (m.error) q.j(new Error(JSON.stringify(m.error))); else q.r(m.result); } };
  function send(method, params) { return new Promise(function (r, j) { var i = ++id; pend[i] = { r: r, j: j }; ws.send(JSON.stringify({ id: i, method: method, params: params || {} })); }); }
  await send('Page.enable'); await send('Runtime.enable');
  return {
    proc: p, send: send,
    eval: async function (expr) { var r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; },
    goto: async function (u, w) { await send('Page.navigate', { url: u }); await sleep(w || 2500); },
    close: function () { try { ws.close(); } catch (e) { /* ignore */ } try { p.kill('SIGTERM'); } catch (e) { /* ignore */ } }
  };
}

async function pairRun(base, block) {
  var flags = block ? ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'] : [];
  var desk = await chrome(PD, flags), phone = await chrome(PP, flags);
  try {
    await desk.goto(base + 'index.html', 3500);
    var code = await desk.eval("CB.input.wheel.pair({via:'online'}).then(function(S){ window.__S = S; return S.code; })");
    assert.match(code, /^[A-Z2-9]{5}$/);
    await phone.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
    await phone.goto(base + 'index.html#/wheel/' + code, 3000);
    await phone.eval("document.querySelector('#pw-wheel .pwp-go').click(), 1");
    var texts = [], txt = '';
    for (var i = 0; i < 150; i++) {
      txt = await phone.eval("document.querySelector('[data-k=conn]').textContent");
      if (texts[texts.length - 1] !== txt) texts.push(txt);
      if (/^Connected/.test(txt)) break;
      await sleep(100);
    }
    assert.match(txt, block ? /^Connected \(via server\)/ : /^Connected \(direct\)/, texts.join(' | '));
    assert.ok(!texts.some(function (x) { return /retrying|not found|Blocked|unreachable/i.test(x); }), texts.join(' | '));
    assert.equal(await desk.eval('window.__S.mode()'), block ? 'relay' : 'direct');
    // steer right with full-ish throttle on the phone (drag mode: no tilt sensor in headless Chrome)
    await phone.eval('(function(){ var s = CB.input.wheelPage.state(); s.drag = 20; s.throttle = 0.8; return 1; })()');
    var t0 = Date.now(), ok = false;
    while (Date.now() - t0 < 4000 && !ok) { ok = await desk.eval('(function(){ var r = window.__S.rx.read(); return !!(r && !r.stale && r.steer > 0.2 && r.throttle > 0.7); })()'); if (!ok) await sleep(25); }
    assert.ok(ok, 'phone input reached the desktop');
    var latency = Date.now() - t0;
    // stays fresh (the failsafe does not flicker) for 2 s of continuous driving
    var fresh = 0, n = 0;
    for (var k = 0; k < 20; k++) { n++; if (await desk.eval('window.__S.rx.isFresh(performance.now())')) fresh++; await sleep(100); }
    assert.ok(fresh >= n - 1, 'fresh ' + fresh + '/' + n);
    // true one-way delay over 3 s of driving: (desk timeOrigin + apply time) - (phone timeOrigin + input timestamp)
    await phone.eval('(function(){ var s = CB.input.wheelPage.state(), k = 0; window.__iv = setInterval(function(){ s.drag = 20 + 10 * Math.sin(k++ / 15); }, 16); return 1; })()');
    await desk.eval('window.__S.rx.latSamples.length = 0, 1');
    await sleep(3000);
    var dO = await desk.eval('performance.timeOrigin'), pO = await phone.eval('performance.timeOrigin');
    var samp = await desk.eval('window.__S.rx.latSamples.slice()');
    var oneWay = samp.map(function (x) { return (dO + x.at) - (pO + x.ts); }).sort(function (a, b) { return a - b; });
    var oneWayMed = oneWay.length ? Math.round(oneWay[oneWay.length >> 1]) : null;
    assert.ok(oneWay.length >= 10, 'input samples ' + oneWay.length);
    assert.ok(oneWayMed < (block ? 150 : 60), 'one-way delay ' + oneWayMed + ' ms');
    var estimate = await desk.eval('window.__S.rx.latency()');
    var deskStatus = await desk.eval("(function(){ CB.input.ui && CB.input.ui.openPairing && CB.input.ui.openPairing(); return new Promise(function(r){ setTimeout(function(){ var e = document.querySelector('.pw-status'); r(e ? e.textContent : ''); }, 400); }); })()");
    if (deskStatus) assert.match(deskStatus, block ? /via server/ : /direct/);
    return { stages: texts, latency: latency, rate: await desk.eval('window.__S.rx.rate'), deskStatus: deskStatus, oneWay: oneWayMed, estimate: estimate };
  } finally { desk.close(); phone.close(); await sleep(400); }
}

t('wheel e2e: build + extract the cPanel zip, serve with php -S', async function () {
  var tbase = process.env.REDLINE_E2E_TMP || os.tmpdir();
  fs.mkdirSync(tbase, { recursive: true });
  tmp = fs.mkdtempSync(path.join(tbase, 'redline-wheel-e2e-'));
  var Z = require(path.join(root, 'tools', 'build-zip.js'));
  var zip = path.join(tmp, 'r.zip');
  Z.build({ out: zip });
  Z.readZip(fs.readFileSync(zip)).forEach(function (e) {
    var dest = path.join(tmp, 'public_html', e.name);
    if (e.data == null) fs.mkdirSync(dest, { recursive: true }); else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, e.data); }
  });
  php = cp.spawn('php', ['-S', '127.0.0.1:' + PHP_PORT, '-t', path.join(tmp, 'public_html')], { env: Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '6', FORGE_SIGNAL_DATA: path.join(tmp, 'data') }), stdio: 'ignore', detached: true });
  php.unref();
  for (var i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:' + PHP_PORT + '/redline/api/signal.php')).status === 200) break; } catch (e) { await sleep(100); } }
  var st = await (await fetch('http://127.0.0.1:' + PHP_PORT + '/redline/api/signal.php')).json();
  assert.equal(st.backend, 'php'); assert.equal(st.relay, true);
});

t('wheel e2e: P2P blocked on both sides -> "Connected (via server)" and steering arrives on the desktop', async function () {
  var r = await pairRun('http://127.0.0.1:' + PHP_PORT + '/redline/', true);
  console.log('    relay: stages ' + JSON.stringify(r.stages) + ' · first input after ' + r.latency + ' ms · one-way ' + r.oneWay + ' ms (estimate ' + r.estimate + ') · ' + r.rate + ' Hz · desktop "' + r.deskStatus + '"');
  assert.ok(r.stages.some(function (x) { return /via server|Connecting/.test(x); }));
});

t('wheel e2e: normal network -> still "Connected (direct)" over WebRTC', async function () {
  var r = await pairRun('http://127.0.0.1:' + PHP_PORT + '/redline/', false);
  console.log('    direct: stages ' + JSON.stringify(r.stages) + ' · first input after ' + r.latency + ' ms · one-way ' + r.oneWay + ' ms (estimate ' + r.estimate + ') · ' + r.rate + ' Hz · desktop "' + r.deskStatus + '"');
});

t('wheel e2e: the phone names the problem for a wrong / expired code (no silent hang)', async function () {
  var phone = await chrome(PP, []);
  try {
    await phone.goto('http://127.0.0.1:' + PHP_PORT + '/redline/index.html#/wheel/ZZZZZ', 3000);
    await phone.eval("document.querySelector('#pw-wheel .pwp-go').click(), 1");
    var txt = '';
    for (var i = 0; i < 60 && !/not found/i.test(txt); i++) { await sleep(100); txt = await phone.eval("CB.input.wheelPage.state().connText || ''"); }
    assert.match(txt, /Computer not found: code ZZZZZ has expired or is mistyped/);
  } finally { phone.close(); await sleep(300); }
});

t('wheel e2e: cleanup', function () { cleanup(); });

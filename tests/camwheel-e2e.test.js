/* Browser end-to-end test of the webcam air wheel with Chrome's FAKE camera (no real webcam is ever used):
   a synthetic video of two real hands (tests/camwheel-hands-synth.js; frame numbers stamped as a barcode) is written as
   .y4m and played through --use-file-for-fake-video-capture; the page (tools/dev-server.js on localhost) runs the real
   pipeline: getUserMedia -> MediaPipe Hand Landmarker in its worker (vendor/) -> solver -> steer -> CB.input.hub.
   Reports and checks: angle error vs the truth per frame, jitter while held level, inference ms, fps, and the delay
   from the camera frame to the steering read by the game loop; the main thread's frame pacing stays smooth.
   Then the colour-marker fallback on a marker video.
   Opt-in (spawns Chrome, wants a GPU): REDLINE_E2E=1 node tests/run.js camwheel-e2e
   Ports: dev server 9867, Chrome 9868 (REDLINE_E2E_CAM_PORT=<n> uses n, n+1); REDLINE_E2E_TMP=<dir> for the profile + video.
   Chrome always runs --headless=new --mute-audio with a throw-away profile. */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var root = path.join(__dirname, '..');
var CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
var enabled = process.env.REDLINE_E2E === '1' && fs.existsSync(CHROME);
var t = enabled ? test : test.skip;
var P0 = Number(process.env.REDLINE_E2E_CAM_PORT) || 9867, PS = P0, PC = P0 + 1;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function q(a, p) { a = a.slice().sort(function (x, y) { return x - y; }); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; }

var tmp = null, procs = [];
function cleanup() {
  procs.forEach(function (p) { try { p.kill('SIGKILL'); } catch (e) { /* ignore */ } }); procs = [];
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } tmp = null; }
}
process.on('exit', cleanup);

async function chrome(video) {
  var prof = path.join(tmp, 'chrome-' + PC + '-' + Date.now());
  fs.mkdirSync(prof, { recursive: true });
  var p = cp.spawn(CHROME, ['--headless=new', '--mute-audio', '--user-data-dir=' + prof, '--remote-debugging-port=' + PC, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1280,800',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + video, 'about:blank'], { stdio: 'ignore' });
  procs.push(p);
  for (var i = 0; i < 100; i++) { try { await (await fetch('http://127.0.0.1:' + PC + '/json/version')).json(); break; } catch (e) { await sleep(150); } }
  var tgt = await (await fetch('http://127.0.0.1:' + PC + '/json/new?about:blank', { method: 'PUT' })).json();
  var ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise(function (r, j) { ws.onopen = r; ws.onerror = j; });
  var id = 0, pend = {};
  ws.onmessage = function (ev) { var m = JSON.parse(ev.data); if (m.id && pend[m.id]) { var x = pend[m.id]; delete pend[m.id]; if (m.error) x.j(new Error(JSON.stringify(m.error))); else x.r(m.result); } };
  function send(method, params) { return new Promise(function (r, j) { var i2 = ++id; pend[i2] = { r: r, j: j }; ws.send(JSON.stringify({ id: i2, method: method, params: params || {} })); }); }
  await send('Page.enable'); await send('Runtime.enable');
  return {
    eval: async function (expr) { var r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; },
    goto: async function (u, w) { await send('Page.navigate', { url: u }); await sleep(w || 2500); },
    close: function () { try { ws.close(); } catch (e) { /* ignore */ } try { p.kill('SIGKILL'); } catch (e) { /* ignore */ } }
  };
}
// barcode (12 cells along the top-left edge of the camera frame) -> frame number
var DECODE = "function(cw){ var vid=cw.video; if(!window.__bc){ var c=document.createElement('canvas'); c.width=160; c.height=120; window.__bc=c.getContext('2d',{willReadFrequently:true}); }" +
  " var g=window.__bc; g.drawImage(vid,0,0,160,120); var d=g.getImageData(0,0,60,6).data, idx=0; for(var k=0;k<12;k++){ var x=Math.round((k+0.5)*4), i=(2*60+x)*4; if(d[i]+d[i+1]+d[i+2]>384) idx|=1<<k; } return idx; }";

async function session(video, method, truth) {
  var b = await chrome(video);
  try {
    await b.goto('http://localhost:' + PS + '/index.html', 3000);
    await b.eval("(function(){ var cw=CB.input.camwheel, dec=" + DECODE + "; cw.setPrefs({method:'" + method + "', smoothing:0.3}); window.__rec=[]; window.__at={};" +
      " cw.on('frame', function(f){ var idx=dec(cw); window.__idx=idx; window.__at[Math.round(f.t)]=idx;" +
      "   if(!f.hands && f.meas) window.__rec.push({idx:idx, ok:!!f.meas.ok, a:cw._b.steer.angle}); });" +
      " cw.on('hands', function(e){ window.__rec.push({idx:window.__at[Math.round(e.t)], ok:!!e.meas.ok, mode:e.meas.mode, a:cw._b.steer.angle, ms:e.ms}); });" +
      " return cw.start().then(function(r){ return r.ok; }); })()");
    for (var i = 0; i < 300; i++) { var ms = await b.eval('CB.input.camwheel.model().state'); if (method !== 'hands' || ms === 'ready' || ms === 'error') break; await sleep(100); }
    // hold level, calibrate (the video loops; its level hold is at the start of each loop)
    for (i = 0; i < 1500; i++) { var ix = await b.eval('window.__idx'); if (ix >= 12 && ix <= 30) break; await sleep(20); }
    var cal = JSON.parse(await b.eval("JSON.stringify(CB.input.camwheel.calibrateNow())"));
    await b.eval("CB.input.camwheel.enable(); window.__rec.length=0; window.__app=[]; window.__raf=[]; (function f(t){ window.__raf.push(t); CB.input.hub.read(); var la=CB.input.camwheel._b.lastApplied; if(la&&la!==window.__la){ window.__la=la; window.__app.push(la); } requestAnimationFrame(f); })(0); 1");
    await sleep(12500);
    var rec = JSON.parse(await b.eval('JSON.stringify(window.__rec)')), app = JSON.parse(await b.eval('JSON.stringify(window.__app)'));
    var raf = JSON.parse(await b.eval('JSON.stringify(window.__raf.slice(2))')), st = JSON.parse(await b.eval('JSON.stringify(CB.input.camwheel.stats())'));
    var errs = [], still = [], lost = 0, n = 0;
    rec.forEach(function (r) {
      if (r.idx == null || r.idx >= truth.length) return;
      n++;
      if (!r.ok) { lost++; return; }
      errs.push(Math.abs(r.a - truth[r.idx]));
      if (truth[r.idx] === 0 && r.idx > 5) still.push(r.a);
    });
    var mean = still.reduce(function (a, c) { return a + c; }, 0) / Math.max(1, still.length);
    var sd = Math.sqrt(still.reduce(function (a, c) { return a + (c - mean) * (c - mean); }, 0) / Math.max(1, still.length));
    var lat = app.filter(function (a) { return a.cap != null; }).map(function (a) { return a.at - a.cap; });
    var dts = raf.slice(1).map(function (x, k) { return x - raf[k]; });
    return { cal: cal, frames: n, lost: lost, med: q(errs, 0.5), p95: q(errs, 0.95), jitter: sd, stats: st, latency: lat.length ? q(lat, 0.5) : null, rafP95: q(dts, 0.95), infer: q(rec.filter(function (r) { return r.ms != null; }).map(function (r) { return r.ms; }), 0.5) };
  } finally { b.close(); }
}

t('camwheel e2e: bare hands through MediaPipe (fake camera) track the wheel angle with low delay', async function () {
  tmp = fs.mkdtempSync(path.join(process.env.REDLINE_E2E_TMP || os.tmpdir(), 'redline-cam-'));
  var srv = cp.spawn(process.execPath, [path.join(root, 'tools/dev-server.js'), '--port', String(PS)], { stdio: 'ignore', cwd: root });
  procs.push(srv);
  try {
    await sleep(800);
    var HS = require('./camwheel-hands-synth.js');
    var hv = path.join(tmp, 'hands.y4m');
    var truth = HS.writeY4m(hv, { w: 640, h: 360, fps: 30, seconds: 12 }).truth;
    var r = await session(hv, 'hands', truth);
    console.log('    hands: ' + JSON.stringify({ frames: r.frames, lost: r.lost, med: +r.med.toFixed(2), p95: +r.p95.toFixed(2), jitter: +r.jitter.toFixed(2), inferMs: r.infer && +r.infer.toFixed(1), fps: r.stats.fps, delegate: r.stats.delegate, worker: r.stats.worker, delayMs: r.latency && +r.latency.toFixed(1), rafP95: +r.rafP95.toFixed(1) }));
    assert.ok(r.cal.ok, 'calibrated: ' + JSON.stringify(r.cal));
    assert.ok(r.frames > 200, 'frames ' + r.frames);
    assert.ok(r.lost < r.frames * 0.05, 'lost ' + r.lost);
    assert.ok(r.med < 5, 'median error ' + r.med);
    assert.ok(r.p95 < 15, 'p95 error ' + r.p95);
    assert.ok(r.jitter < 1.5, 'jitter ' + r.jitter);
    assert.ok(r.latency != null && r.latency < 120, 'delay ' + r.latency);
    if (r.stats.worker) assert.ok(r.rafP95 < 25, 'inference off the main thread keeps frames smooth: rAF p95 ' + r.rafP95);
    // colour-marker fallback
    var SY = require('./camwheel-synth.js');
    var mv = path.join(tmp, 'markers.y4m');
    var mt = SY.writeY4m(mv, { w: 640, h: 480, fps: 30, seconds: 12, style: 'pair', scene: { color: [40, 200, 70] } }).truth;
    var m = await session(mv, 'marker', mt);
    console.log('    markers: ' + JSON.stringify({ frames: m.frames, lost: m.lost, med: +m.med.toFixed(2), p95: +m.p95.toFixed(2), procMs: m.stats.procMs, delayMs: m.latency && +m.latency.toFixed(1) }));
    assert.ok(m.cal.ok && m.med < 3 && m.lost < m.frames * 0.05, JSON.stringify({ cal: m.cal.reason, med: m.med, lost: m.lost }));
  } finally { cleanup(); }
});

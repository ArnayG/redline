/* Browser end-to-end test of the webcam air wheel with Chrome's FAKE camera (no real webcam is ever used):
   a synthetic video of two real hands (tests/camwheel-hands-synth.js; frame numbers stamped as a barcode) is written as
   .y4m and played through --use-file-for-fake-video-capture; the page (tools/dev-server.js on localhost) runs the real
   pipeline: getUserMedia -> MediaPipe Hand Landmarker in its worker (vendor/) -> solver -> steer -> CB.input.hub.
   Reports and checks: angle error vs the truth per frame, jitter while held level, inference ms, fps, and the delay
   from the camera frame to the steering read by the game loop; the main thread's frame pacing stays smooth.
   Then the colour-marker fallback on a marker video, and the hands-only pedals (Grip to drive: fists = gas, the hands
   pulled back = brake) on a third video, and the hands leaving the frame and coming back (re-acquired consistently,
   never upside down at -180, and the steering eases back in without a jump) on a fourth, and the one-hand top grip
   (one hand steering along the rim of the wheel) on a fifth, and the default "Fist = go, open hand = brake" pedals on
   two more: closed fists turned / rolled / tilted / moved nearer, farther and to the frame edges (zero brakes allowed),
   and open / half-closed / mixed hands (brake exactly on open hands), from real open and half-closed hand photos.
   Opt-in (spawns Chrome, wants a GPU): REDLINE_E2E=1 node tests/run.js camwheel-e2e
   Ports: dev server 9867, Chrome 9868 (REDLINE_E2E_CAM_PORT=<n> uses n, n+1); REDLINE_E2E_TMP=<dir> for the profile + video.
   Chrome always runs --headless=new --mute-audio with a throw-away profile. Each session cancels the automatic
   3-2-1 centring before it calibrates (else that countdown could capture the neutral mid-script, e.g. while braking). */
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
    var cal = JSON.parse(await b.eval("(CB.input.camwheel.cancelCentre(), JSON.stringify(CB.input.camwheel.calibrateNow()))"));
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

// hands-only pedals (Grip to drive): fists = gas; the same hands 25 % smaller (pulled back) = brake. Checks the gas /
// brake state of every landmark result against the video's script, and how many camera frames a switch takes.
async function pedalSession(video, labels, fps, edges) {
  var b = await chrome(video);
  try {
    await b.goto('http://localhost:' + PS + '/index.html', 3000);
    await b.eval("(function(){ var cw=CB.input.camwheel, dec=" + DECODE + "; cw.setPrefs({method:'hands', pedals:'grip'}); window.__at={}; window.__s=[];" +
      " cw.on('frame', function(f){ window.__idx=dec(cw); window.__at[Math.round(f.t)]=window.__idx; });" +
      " cw.on('hands', function(e){ var i=window.__at[Math.round(e.t)]; if(i==null) return; var p=cw._b.pedals.read(performance.now(), 'grip'); window.__s.push({i:i, st:p.state}); });" +
      " return cw.start().then(function(r){ return r.ok; }); })()");
    for (var i = 0; i < 300; i++) { var ms = await b.eval('CB.input.camwheel.model().state'); if (ms === 'ready' || ms === 'error') break; await sleep(100); }
    for (i = 0; i < 1500; i++) { var ix = await b.eval('window.__idx'); if (ix >= 12 && ix <= 30) break; await sleep(20); }
    var cal = JSON.parse(await b.eval("(CB.input.camwheel.cancelCentre(), JSON.stringify(CB.input.camwheel.calibrateNow()))"));
    await b.eval("CB.input.camwheel.enable(); window.__s.length=0; 1");
    await sleep(labels.length / fps * 1000 + 1500);
    var S = JSON.parse(await b.eval('JSON.stringify(window.__s)'));
    var ok = 0, n = 0;
    S.forEach(function (r) {
      if (r.i >= labels.length) return;
      var tr = r.i / fps; if (edges.some(function (e) { return tr >= e && tr < e + 0.15; })) return;
      n++; if (r.st === labels[r.i]) ok++;
    });
    var resp = edges.map(function (e) { var f = Math.round(e * fps), want = labels[f]; var hit = S.filter(function (r) { return r.i >= f && r.i < f + 30 && r.st === want; })[0]; return hit ? hit.i - f : null; });
    return { cal: cal, n: n, acc: ok / Math.max(1, n), resp: resp };
  } finally { b.close(); }
}

t('camwheel e2e: grip to drive (fists = gas, pull back = brake) through MediaPipe', async function () {
  tmp = fs.mkdtempSync(path.join(process.env.REDLINE_E2E_TMP || os.tmpdir(), 'redline-camped-'));
  var srv = cp.spawn(process.execPath, [path.join(root, 'tools/dev-server.js'), '--port', String(PS)], { stdio: 'ignore', cwd: root });
  procs.push(srv);
  try {
    await sleep(800);
    var HS = require('./camwheel-hands-synth.js'), fps = 30, sec = 12, edges = [4, 6.5, 9, 10.5];
    function brake(tt) { return (tt >= 4 && tt < 6.5) || (tt >= 9 && tt < 10.5); }
    var v = path.join(tmp, 'pedals.y4m');
        // (turns kept within 25 deg: the pull-back size is ignored while the wheel is turned > 30 deg, see createPedals)
    HS.writeY4m(v, { w: 640, h: 360, fps: fps, seconds: sec, truth: function (tt) { return tt < 1.5 ? 0 : 25 * Math.sin((tt - 1.5) * 1.6); },
      per: function (i, tt) { var k = brake(tt) ? 0.75 : 1; return { scale: 0.42 * k, radius: 0.24 * k }; } });
    var labels = []; for (var i = 0; i < fps * sec; i++) labels.push(brake(i / fps) ? 'brake' : 'gas');
    var r = await pedalSession(v, labels, fps, edges);
    console.log('    pedals: ' + JSON.stringify({ samples: r.n, accuracy: +(r.acc * 100).toFixed(1), switchFrames: r.resp }));
    assert.ok(r.cal.ok, 'calibrated');
    assert.ok(r.n > 200, 'samples ' + r.n);
    assert.ok(r.acc >= 0.95, 'accuracy ' + r.acc);
    r.resp.forEach(function (f) { assert.ok(f != null && f <= 3, 'switch within 3 frames: ' + r.resp); });
  } finally { cleanup(); }
});

// hands leave the frame and come back (user report: "the steering wheel starts at -180"): both hands gone, one hand
// gone, back at other angles. After each return the angle must be right within ~0.5 s, never near +-180, and the
// steering the game reads (every rAF) must never jump.
// [from s, to s, angle | [ramp from, ramp to], hidden]  (the angle only jumps while hands are out of view)
var REACQ = [[0, 1.5, 0, null], [1.5, 3, [0, 40], null], [3, 4.5, 40, 'both'], [4.5, 6, -30, null], [6, 7, -30, 'right'],
  [7, 8.5, [-30, 60], null], [8.5, 10, 60, 'both'], [10, 12, 15, null]];
function reacqAt(tt) {
  for (var k = 0; k < REACQ.length; k++) { var s = REACQ[k]; if (tt < s[1]) return { a: Array.isArray(s[2]) ? s[2][0] + (s[2][1] - s[2][0]) * (tt - s[0]) / (s[1] - s[0]) : s[2], hide: s[3], k: k }; }
  return { a: 15, hide: null, k: REACQ.length - 1 };
}
t('camwheel e2e: hands leave the frame and come back without a -180 start or a jump', async function () {
  tmp = fs.mkdtempSync(path.join(process.env.REDLINE_E2E_TMP || os.tmpdir(), 'redline-camreacq-'));
  var srv = cp.spawn(process.execPath, [path.join(root, 'tools/dev-server.js'), '--port', String(PS)], { stdio: 'ignore', cwd: root });
  procs.push(srv);
  try {
    await sleep(800);
    var HS = require('./camwheel-hands-synth.js'), fps = 30, sec = 12;
    var v = path.join(tmp, 'reacq.y4m');
    HS.writeY4m(v, { w: 640, h: 360, fps: fps, seconds: sec, truth: function (tt) { return reacqAt(tt).a; }, per: function (i, tt) { return { hide: reacqAt(tt).hide }; } });
    var b = await chrome(v), rec, reads;
    try {
      await b.goto('http://localhost:' + PS + '/index.html', 3000);
      await b.eval("(function(){ var cw=CB.input.camwheel, dec=" + DECODE + "; cw.setPrefs({method:'hands', smoothing:0.3, pedals:'off'}); window.__at={}; window.__r=[];" +
        " cw.on('frame', function(f){ window.__idx=dec(cw); window.__at[Math.round(f.t)]=window.__idx; });" +
        " cw.on('hands', function(e){ var i=window.__at[Math.round(e.t)]; if(i==null) return; window.__r.push({i:i, ok:!!e.meas.ok, mode:e.meas.mode, a:cw._b.steer.angle, raw:e.meas.ok?e.meas.angle:null}); });" +
        " return cw.start().then(function(r){ return r.ok; }); })()");
      for (var i = 0; i < 300; i++) { var ms = await b.eval('CB.input.camwheel.model().state'); if (ms === 'ready' || ms === 'error') break; await sleep(100); }
      for (i = 0; i < 1500; i++) { var ix = await b.eval('window.__idx'); if (ix >= 12 && ix <= 30) break; await sleep(20); }
      var cal = JSON.parse(await b.eval("(CB.input.camwheel.cancelCentre(), JSON.stringify(CB.input.camwheel.calibrateNow()))"));
      assert.ok(cal.ok, 'calibrated ' + JSON.stringify(cal));
      await b.eval("CB.input.camwheel.enable(); window.__r.length=0; window.__rd=[]; (function f(){ var s=CB.input.hub.read(); var c=CB.input.camwheel._b.steer.read(performance.now()); window.__rd.push({i:window.__idx, s:c.steer}); requestAnimationFrame(f); })(); 1");
      await sleep(sec * 1000 + 1500);
      rec = JSON.parse(await b.eval('JSON.stringify(window.__r)'));
      reads = JSON.parse(await b.eval('JSON.stringify(window.__rd)'));
    } finally { b.close(); }
    var bad = [], late = [], near180 = 0, maxStep = 0, ok = 0;
    rec.forEach(function (r) {
      if (r.i == null || r.i >= fps * sec || !r.ok) return;
      var tt = r.i / fps, z = reacqAt(tt), seg = REACQ[z.k];
      if (Math.abs(Math.abs(r.raw) - 180) < 40) near180++;
      if (seg[3] === 'both') return;
      var since = tt - seg[0];
      if (since < 0.5) { late.push(Math.abs(r.a - z.a)); return; }        // easing back in
      if (Array.isArray(seg[2])) return;
      ok++;
      if (Math.abs(r.a - z.a) > 8) bad.push(r.i + ':' + r.a.toFixed(1) + '/' + z.a);
    });
    var worst = null;
    reads.forEach(function (x, k) { if (k > 2) { var d = Math.abs(x.s - reads[k - 1].s); if (d > maxStep) { maxStep = d; worst = x.i; } } });
    console.log('    reacquire: ' + JSON.stringify({ results: rec.length, checked: ok, wrong: bad.length, near180: near180, maxSteerStep: +maxStep.toFixed(3), atFrame: worst, reads: reads.length }));
    assert.ok(ok > 60, 'checked ' + ok);
    assert.equal(near180, 0, 'never upside down');
    assert.ok(bad.length <= ok * 0.03, 'settled after every return: ' + bad.slice(0, 12).join(' '));
    assert.ok(maxStep <= 0.3, 'steering never jumps: ' + maxStep);
  } finally { cleanup(); }
});

// one-hand top grip: only the right hand, gripping the top of the wheel (the synthetic hub's 12 o'clock) and moving
// along the rim; calibrated with the 3-2-1-free calibrateNow at the level hold, wheel size matched to the video's rim.
function topTruth(tt) { var T = tt % 10; if (T < 1.5) return 0; if (T < 7.5) return 100 * Math.sin((T - 1.5) / 6 * Math.PI * 2); return 0; }
t('camwheel e2e: one hand at the top of the wheel steers along the rim (MediaPipe, right hand detected)', async function () {
  tmp = fs.mkdtempSync(path.join(process.env.REDLINE_E2E_TMP || os.tmpdir(), 'redline-camtop-'));
  var srv = cp.spawn(process.execPath, [path.join(root, 'tools/dev-server.js'), '--port', String(PS)], { stdio: 'ignore', cwd: root });
  procs.push(srv);
  try {
    await sleep(800);
    var HS = require('./camwheel-hands-synth.js'), fps = 30, sec = 10, rad = 0.24;
    var v = path.join(tmp, 'top.y4m');
    var truth = HS.writeY4m(v, { w: 640, h: 360, fps: fps, seconds: sec, truth: function (tt) { return topTruth(tt) - 90; }, scene: { hide: 'left', radius: rad, cy: 0.75 } }).truth.map(function (a) { return a + 90; });
    var b = await chrome(v), rec, cal, side;
    try {
      await b.goto('http://localhost:' + PS + '/index.html', 3000);
      await b.eval("(function(){ var cw=CB.input.camwheel, dec=" + DECODE + "; cw.setPrefs({method:'hands', handStyle:'top', handCal:null, smoothing:0.3, pedals:'off'}); window.__at={}; window.__r=[];" +
        " cw.on('frame', function(f){ window.__idx=dec(cw); window.__at[Math.round(f.t)]=window.__idx; });" +
        " cw.on('hands', function(e){ var i=window.__at[Math.round(e.t)]; if(i==null) return; window.__r.push({i:i, ok:!!e.meas.ok, mode:e.meas.mode, a:cw._b.steer.angle, side:e.meas.side}); });" +
        " return cw.start().then(function(r){ return r.ok; }); })()");
      for (var i = 0; i < 300; i++) { var ms = await b.eval('CB.input.camwheel.model().state'); if (ms === 'ready' || ms === 'error') break; await sleep(100); }
      for (i = 0; i < 1500; i++) { var ix = await b.eval('window.__idx'); if (ix >= 12 && ix <= 30) break; await sleep(20); }
      for (i = 0; i < 50; i++) { cal = JSON.parse(await b.eval("(CB.input.camwheel.cancelCentre(), JSON.stringify(CB.input.camwheel.calibrateNow()))")); if (cal.ok) break; await sleep(100); }
      if (!cal.ok || !(await b.eval('!!CB.input.camwheel._b.solver.topCal'))) throw new Error('not calibrated: ' + JSON.stringify(cal) + ' ' + await b.eval('JSON.stringify(CB.input.camwheel.stats())'));
      // the video's rim radius is rad x width: match the wheel size to it
      await b.eval("(function(){ var cw=CB.input.camwheel, tc=cw._b.solver.topCal; cw.setPrefs({ wheelSize: Math.max(0.5, Math.min(2, " + rad + " / (CB.input.camhands.TOP_K * tc.L))) }); cw.enable(); window.__r.length=0; return 1; })()");
      await sleep(sec * 1000 + 1500);
      rec = JSON.parse(await b.eval('JSON.stringify(window.__r)'));
    } finally { b.close(); }
    var errs = [], lost = 0, sides = {};
    rec.forEach(function (r) { if (r.i == null || r.i >= truth.length) return; if (!r.ok) { lost++; return; } sides[r.side] = (sides[r.side] || 0) + 1; errs.push(Math.abs(r.a - truth[r.i])); });
    console.log('    top grip: ' + JSON.stringify({ cal: cal.mode + '/' + cal.side, results: rec.length, lost: lost, med: errs.length && +q(errs, 0.5).toFixed(2), p95: errs.length && +q(errs, 0.95).toFixed(2), sides: sides }));
    assert.ok(cal.ok && cal.mode === 'top', 'calibrated: ' + JSON.stringify(cal));
    assert.equal(cal.side, 'R', 'right hand detected');
    assert.ok(errs.length > 150, 'results ' + errs.length);
    assert.ok(lost < errs.length * 0.05, 'lost ' + lost);
    assert.ok(q(errs, 0.5) < 6, 'median error ' + q(errs, 0.5));
    assert.ok(q(errs, 0.95) < 18, 'p95 error ' + q(errs, 0.95));
  } finally { cleanup(); }
});

// "Fist = go, open hand = brake" with REAL MediaPipe landmarks of real hand photos (tests/fixtures/hands/README.md):
// video 1: closed fists only, while the wheel turns +-90 deg with the hands rolled (foreshortened), tilted, moved towards /
// away from the camera and to the frame edges -> ZERO frames may brake. Video 2: fists, open hands (two different
// photos), half-closed hands, one hand open with the other a fist -> brake exactly on the open hands. Every landmark
// result is recorded (REDLINE_E2E_DUMP=<dir> writes them, for comparing classifiers offline on the same videos).
function seg(list, tt) { for (var k = 0; k < list.length; k++) if (tt < list[k][1]) return list[k]; return list[list.length - 1]; }
var CLOSED_SCRIPT = [
  [0, 1.5, function () { return {}; }],
  [1.5, 5, function (u) { var a = 90 * Math.sin((u - 1.5) / 3.5 * Math.PI * 2); return { angle: a, squash: 1 - 0.45 * Math.abs(Math.sin(a * Math.PI / 180)) }; }],
  [5, 7, function (u) { var k = Math.sin((u - 5) / 2 * Math.PI * 2); return { squash: [1 - 0.5 * Math.abs(k), 1 - 0.3 * Math.abs(k)], pitch: 1 - 0.3 * Math.max(0, -k) }; }],
  [7, 9, function (u) { var k = 1 + 0.28 * Math.sin((u - 7) / 2 * Math.PI * 2); return { scale: 0.42 * k, radius: 0.24 * k }; }],
  [9, 11, function (u) { var p = (u - 9) / 2 * Math.PI * 2; return { cx: 0.5 + 0.2 * Math.sin(p), cy: 0.58 - 0.12 * Math.sin(p * 2), angle: 45 * Math.sin(p) }; }],
  [11, 12, function () { return {}; }]
];
var OPEN_SCRIPT = [
  [0, 1.5, 'gas', {}], [1.5, 3.5, 'brake', { sprite: 'open-hand' }], [3.5, 5, 'gas', {}], [5, 6.5, 'nobrake', { sprite: 'half-hand' }],
  [6.5, 8.5, 'brake', { sprite: 'open-hand-2', angle: 25 }], [8.5, 10, 'gas', { angle: -20 }], [10, 12, 'gas', { spriteL: 'open-hand' }]
];
async function recordSession(video, fps, seconds) {
  var b = await chrome(video);
  try {
    await b.goto('http://localhost:' + PS + '/index.html', 3000);
    await b.eval("(function(){ var cw=CB.input.camwheel, dec=" + DECODE + "; cw.setPrefs({method:'hands', handStyle:'two', pedals:'fist', pullBrake:false}); window.__at={}; window.__s=[];" +
      " function r4(v){ return Math.round(v*1e5)/1e5; } function flat(a){ var o=[]; (a||[]).forEach(function(p){ o.push(r4(p.x), r4(p.y), r4(p.z||0)); }); return o; }" +
      " cw.on('frame', function(f){ window.__idx=dec(cw); window.__at[Math.round(f.t)]=window.__idx; });" +
      " cw.on('hands', function(e){ var i=window.__at[Math.round(e.t)]; if(i==null) return; var p=cw._b.pedals.read(performance.now(), 'fist');" +
      "   window.__s.push({i:i, t:Math.round(e.t), st:p.state, open:(e.meas.pts||[]).map(function(q){ return q.open==null?null:Math.round(q.open*1000)/1000; }), mode:e.meas.mode, a:e.meas.ok?Math.round(e.meas.angle*10)/10:null," +
      "     hd:(e.meas.hands||[]).map(function(c){ return { lm:flat(c.h.lm), wl:c.h.wl?flat(c.h.wl):null, s:c.h.score, l:c.h.label }; }) }); });" +
      " return cw.start().then(function(r){ return r.ok; }); })()");
    for (var i = 0; i < 300; i++) { var ms = await b.eval('CB.input.camwheel.model().state'); if (ms === 'ready' || ms === 'error') break; await sleep(100); }
    for (i = 0; i < 1500; i++) { var ix = await b.eval('window.__idx'); if (ix >= 12 && ix <= 30) break; await sleep(20); }
    var cal;
    for (i = 0; i < 50; i++) { cal = JSON.parse(await b.eval("(CB.input.camwheel.cancelCentre(), JSON.stringify(CB.input.camwheel.calibrateNow()))")); if (cal.ok) break; await sleep(100); }
    await b.eval("CB.input.camwheel.enable(); window.__s.length=0; 1");
    // wait for the video to come round to its start, then record one full loop
    for (i = 0; i < 1500; i++) { var j = await b.eval('window.__idx'); if (j >= seconds * fps - 20) break; await sleep(20); }
    await b.eval("window.__s.length=0; 1");
    await sleep(seconds * 1000 + 800);
    var S = JSON.parse(await b.eval('JSON.stringify(window.__s)'));
    return { cal: cal, S: S.filter(function (r) { return r.i < seconds * fps; }) };
  } finally { b.close(); }
}
t('camwheel e2e: fist = go, open hand = brake on real hand photos (zero false brakes with closed hands)', async function () {
  tmp = fs.mkdtempSync(path.join(process.env.REDLINE_E2E_TMP || os.tmpdir(), 'redline-camfist-'));
  var srv = cp.spawn(process.execPath, [path.join(root, 'tools/dev-server.js'), '--port', String(PS)], { stdio: 'ignore', cwd: root });
  procs.push(srv);
  try {
    await sleep(800);
    var HS = require('./camwheel-hands-synth.js'), fps = 30, sec = 12, dump = process.env.REDLINE_E2E_DUMP;
    var v1 = path.join(tmp, 'closed.y4m');
    HS.writeY4m(v1, { w: 640, h: 360, fps: fps, seconds: sec, truth: function (tt) { var o = seg(CLOSED_SCRIPT, tt)[2](tt); return o.angle || 0; },
      per: function (i, tt) { var o = seg(CLOSED_SCRIPT, tt)[2](tt); delete o.angle; return o; } });
    var r1 = await recordSession(v1, fps, sec);
    var seen = r1.S.filter(function (r) { return r.hd.length; }), brakes = r1.S.filter(function (r) { return r.st === 'brake'; });
    var gas = r1.S.filter(function (r) { return r.st === 'gas'; });
    console.log('    closed fists: ' + JSON.stringify({ results: r1.S.length, withHands: seen.length, brake: brakes.length, gas: gas.length, maxOpen: Math.max.apply(null, [0].concat(...seen.map(function (r) { return r.open.filter(function (v) { return v != null; }); }))) }));
    assert.ok(r1.cal.ok, 'calibrated ' + JSON.stringify(r1.cal));
    assert.ok(seen.length > 250, 'hands seen in ' + seen.length + ' results');
    assert.equal(brakes.length, 0, 'false brakes with closed hands at frames ' + brakes.map(function (r) { return r.i; }).slice(0, 20));
    assert.ok(gas.length >= seen.length * 0.9, 'gas while gripping: ' + gas.length + ' / ' + seen.length);
    var v2 = path.join(tmp, 'open.y4m');
    HS.writeY4m(v2, { w: 640, h: 360, fps: fps, seconds: sec, truth: function (tt) { return seg(OPEN_SCRIPT, tt)[3].angle || 0; },
      per: function (i, tt) { var o = Object.assign({}, seg(OPEN_SCRIPT, tt)[3]); delete o.angle; return o; } });
    var r2 = await recordSession(v2, fps, sec);
    var per = {};
    r2.S.forEach(function (r) {
      var tt = r.i / fps, sg = seg(OPEN_SCRIPT, tt);
      if (tt - sg[0] < 0.35) return;                                // switching (persistence + the camera's own delay)
      var k = sg[0] + '-' + sg[1] + ':' + sg[2], P0 = per[k] = per[k] || { n: 0, ok: 0, states: {} };
      P0.n++; P0.states[r.st] = (P0.states[r.st] || 0) + 1;
      if (sg[2] === 'nobrake' ? r.st !== 'brake' : r.st === sg[2]) P0.ok++;
    });
    console.log('    open / half / fists: ' + JSON.stringify(per));
    if (dump) { fs.mkdirSync(dump, { recursive: true }); fs.writeFileSync(path.join(dump, 'closed.json'), JSON.stringify(r1.S)); fs.writeFileSync(path.join(dump, 'open.json'), JSON.stringify(r2.S)); }
    Object.keys(per).forEach(function (k) {
      var P0 = per[k];
      if (/:(gas|nobrake)$/.test(k)) assert.equal(P0.states.brake || 0, 0, 'no brake in ' + k + ': ' + JSON.stringify(P0.states));
      assert.ok(P0.n > 10 && P0.ok >= P0.n * (/:brake$/.test(k) ? 0.9 : 0.85), k + ' ' + JSON.stringify(P0));
    });
  } finally { cleanup(); }
});

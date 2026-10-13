/* ==========================================================================
   FORGE — js/input/camwheel-worker.js
   Web Worker for the webcam air wheel (js/input/camwheel-hands.js): runs MediaPipe Hand Landmarker off the main thread,
   so the ~5-20 ms of inference per camera frame never stalls the game's frames. Classic worker (importScripts works for
   the wasm loader); the vendored bundle is pulled in with import().
     in : {t:'init', base, gpu}   {t:'frame', id, ts, bmp: ImageBitmap (transferred)}
     out: {t:'ready', delegate}   {t:'error', error}   {t:'res', id, ts, ms, hands: [{lm: [{x, y, z}] x 21, score, label}]}
   Frames never leave the device: this worker only talks to the page that started it.
   ========================================================================== */
'use strict';
var hl = null, lastTs = -1, DET = 0.5, PRES = 0.5;
function make(lib, base, dg) {
  return lib.HandLandmarker.createFromOptions({ wasmLoaderPath: base + 'wasm/vision_wasm_internal.js', wasmBinaryPath: base + 'wasm/vision_wasm_internal.wasm' }, {
    baseOptions: { modelAssetPath: base + 'hand_landmarker.task', delegate: dg },
    runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: DET, minHandPresenceConfidence: PRES, minTrackingConfidence: 0.5
  }).then(function (h) { hl = h; return dg; });
}
self.onmessage = function (e) {
  var m = e.data || {};
  if (m.t === 'init') {
    if (m.det) DET = m.det; if (m.pres) PRES = m.pres;
    import(m.base + 'vision_bundle.mjs').then(function (lib) {
      return (m.gpu === false ? Promise.reject(new Error('cpu')) : make(lib, m.base, 'GPU')).catch(function () { return make(lib, m.base, 'CPU'); });
    }).then(function (dg) {
      // warm-up: the first inference compiles the GPU programs
      try { var c = new OffscreenCanvas(256, 192), g = c.getContext('2d'); g.fillStyle = '#777'; g.fillRect(0, 0, 256, 192); hl.detectForVideo(c, ++lastTs); } catch (x) { /* ignore */ }
      self.postMessage({ t: 'ready', delegate: dg });
    }, function (err) { self.postMessage({ t: 'error', error: String(err && err.message || err) }); });
  } else if (m.t === 'frame') {
    var out = [], t0 = performance.now();
    try {
      var ts = Math.max(lastTs + 1, Math.round(m.ts)); lastTs = ts;
      var r = hl ? hl.detectForVideo(m.bmp, ts) : null;
      for (var i = 0; r && r.landmarks && i < r.landmarks.length; i++) {
        var hd = r.handedness && r.handedness[i] && r.handedness[i][0];
        out.push({ lm: r.landmarks[i].map(function (p) { return { x: p.x, y: p.y, z: p.z }; }), score: hd ? hd.score : 1, label: hd ? hd.categoryName : '' });
      }
    } catch (x) { out = []; }
    try { m.bmp.close(); } catch (x) { /* ignore */ }
    self.postMessage({ t: 'res', id: m.id, ts: m.ts, ms: performance.now() - t0, hands: out });
  }
};
